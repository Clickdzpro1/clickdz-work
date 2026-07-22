import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

import { CurrentUser } from '../../core/auth';
// Typed errors from ../../base (raw HttpException is coerced to a generic 500
// by AFFiNE's GlobalExceptionFilter — see base/nestjs/exception.ts mapAnyError).
// For the contract's non-standard status + typed-body responses (502) we write
// them directly via the injected Express Response (@Res()), exactly like
// ClickDzIntegrationsController's /run route. BadRequest/NotFound stay available
// for genuinely malformed input / missing threads (typed 4xx).
// WS14/C5: `Cache` is the @Global JSON-wrapped Redis provider (get<T>/set with a
// PX ttl — fail-soft: undefined/false on any error, never throws) — the SAME
// provider ClickDzAgentRuntime uses for thread persistence. The per-user agent
// config singleton is persisted through it, mirroring that Pattern-B idiom.
// R6/WSA-2: `Config` is the @Global copilot config (has `.copilot.exa.key`),
// injected the same way controller.ts / runtime/tool-runtime.ts do — the shared
// tool registry reads it to gate the first-party web tools (Exa) behind
// CDZ_AGENT_WEB_ENABLED + key presence.
import { BadRequest, Cache, Config, NotFound, Throttle } from '../../base';
// CacheRedis is a @Global provider (same injection style as
// ClickDzDataController / ClickDzVdzController) — the internal read tools below
// read the SAME Redis records the bridge + data API expose.
import { CacheRedis } from '../../base/redis';
// R6/WSA-1 (Regis): the unified agent tool registry both agents dispatch
// through. HERMES routes its catalog + tool dispatch through a registry built by
// buildDefaultRegistry with the hermes-specific tools injected as `extraTools`
// (IDENTICAL behavior — the defs delegate to the private tool methods below).
// buildDefaultRegistry ALSO wires the first-party web tools (web_search/
// web_fetch), gated behind CDZ_AGENT_WEB_ENABLED — flag off ⇒ they never appear
// and the planner prompt / dispatch stay byte-identical to today.
import {
  type AgentToolCtx,
  type AgentToolDef,
  buildDefaultRegistry,
  ClickDzToolRegistry,
} from './clickdz-agent-tools';
// R6/WSA-3 (Moteur): the background run engine. HERMES registers its detached
// plan→act loop body via registerAgentLoop('hermes', …) so `copilot.agent.run`
// jobs execute the SAME logic decoupled from any SSE socket. Everything here is
// inert unless CDZ_AGENTS_ENABLED is set (the loop is only registered then, and
// only Canal/Telegramme create+enqueue runs). Flags off ⇒ byte-identical.
import {
  type AgentLoopContext,
  type AgentLoopDeps,
  type AgentRunRecord,
  registerAgentLoop,
} from './clickdz-agent-runs';
// WS12/C3+C5: the shared agent runtime service (SSE writer + Redis threads +
// stop/approval registries) owned by RUNTIME. HERMESB2 injects it and drives
// the streaming console through it. Types (AgentEvent/AgentStep/AgentMessage/
// AgentThread/AgentThreadSummary/AgentName) are re-exported by the runtime so
// both agent controllers + the FE parse an identical wire protocol (C1/C2).
import {
  type AgentEvent,
  type AgentMessage,
  type AgentStep,
  type AgentThread,
  type AgentThreadSummary,
  ClickDzAgentRuntime,
} from './clickdz-agent-runtime';
// R8/WSA-10 (Souvenir): per-agent long-term memory. VALUE imports (these are
// CALLED at runtime — the R6 lesson: an unimported identifier crashes prod at
// boot since the image build is transpile-only). ALL self-gate on
// memoryEnabled()=CDZ_AGENT_MEMORY_ENABLED==='1': off/absent ⇒ readAgentMemory
// returns an empty blob, buildMemoryPromptBlock returns '' (zero prompt bytes),
// createMemoryTools returns [] (no tools registered), registerMemorySummarizer
// installs a callback that early-returns — so flags-off is byte-identical.
import {
  buildMemoryPromptBlock,
  createMemoryTools,
  memoryEnabled,
  readAgentMemory,
  registerMemorySummarizer,
} from './clickdz-agent-memory';
// R8/WSA-11 (Horloge): a run started by a schedule/webhook trigger is
// UNSUPERVISED. deferConsequential(rec) is true for those channels only (web /
// telegram interactive runs → false), so the detached loop defers a
// consequential tool instead of firing it unattended. VALUE import (called).
import { deferConsequential } from './clickdz-agent-triggers';

// ---------------------------------------------------------------------------
// HERMES — ClickDz autonomous OPERATIONS agent.
//
// Takes a natural-language GOAL and autonomously plans + executes across the
// app's real tool surfaces using the PROVEN cdz-flash plan→act loop copied
// from clickdz-integrations.controller.ts (the WS9/WS10 orchestrator):
//   - same CDZ_AI_BASE_URL normalization (strip trailing /v1, single canonical
//     /v1/chat/completions path — the WS10 double-/v1 404 fix),
//   - same fail-closed JSON decision parsing (fences → JSON.parse → first
//     {...} span → normalize to a final answer on any noise),
//   - same loop shape: plan, guard unknown slugs, execute, feed a truncated
//     result back, cap iterations + wall clock with AbortController timeouts,
//   - same typed 502 {error:'planner_unavailable'} via manual @Res writes —
//     NEVER a raw HttpException.
//
// WS12 upgrade (C5): the loop now ALSO drives a live SSE console via the shared
// ClickDzAgentRuntime — server-persisted multi-turn threads, live step/token
// streaming, human-in-the-loop approvals for consequential tools, and a
// cooperative stop flag. The legacy POST /run stays byte-identical for
// back-compat; /capabilities gains `streaming:true`.
//
// Tool catalog (REAL surfaces, never fabricated results):
//   shops_list        — the caller's published apps (Redis set the bridge owns)
//   shop_erp_summary  — compact KPIs from the shop/ERP shared datastore
//                       (clickdz:appdata:<slug>:<collection> hashes)
//   composio_discover — GET api/v3/tools?toolkit_slug= (x-api-key)
//   composio_execute  — POST api/v3/tools/execute/<slug> {user_id, arguments}   [CONSEQUENTIAL]
//   make_agent_run    — POST Make.com ai-agents run (Token auth, MAKE_* envs)   [CONSEQUENTIAL]
// A tool whose env key is missing is advertised available:false in
// /capabilities, excluded from the planner prompt, and guarded in the loop —
// the agent degrades gracefully, it never crashes and never pretends.
// ---------------------------------------------------------------------------

// SECURITY / CONFIG: per-surface gates, read once at module load (same idiom
// as the sibling controllers' module-level env reads). Missing key => the
// matching tools are marked unavailable; nothing reaches that upstream.
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || '';

// R6/WSA-2 master gate. Controls ONLY the NEW background-run seam: the detached
// plan→act loop is registered with Moteur's job engine (registerAgentLoop) at
// construction time IFF this is '1'. When unset/absent the request-scoped
// /run + /stream routes + /capabilities behave EXACTLY as before (the registry
// is still used for dispatch — with the legacy tool set only, since the web
// flag is independent and also off — so behavior is byte-identical). Read like
// every other CDZ env in this plugin (`process.env.CDZ_...`).
const CDZ_AGENTS_ENABLED = process.env.CDZ_AGENTS_ENABLED === '1';
// The first-party web tools (web_search/web_fetch) are gated INSIDE the shared
// registry by CDZ_AGENT_WEB_ENABLED (+ exa key presence) — this controller only
// reflects that gate when composing the planner prompt / known-slug set below.
const CDZ_AGENT_WEB_ENABLED = process.env.CDZ_AGENT_WEB_ENABLED === '1';

// Composio public REST surface (plain fetch — NO SDK dependency). Same
// endpoints the integrations controller uses for its /run orchestrator.
const COMPOSIO_TOOLS_URL = 'https://backend.composio.dev/api/v3/tools';
const COMPOSIO_TOOLS_EXECUTE_URL =
  'https://backend.composio.dev/api/v3/tools/execute';

// Make.com agent surface (mirrors clickdz-bridge.controller.ts:159-163,226-227
// — the exact envs + run idiom of runMakeAgent, Token auth, buffered JSON).
const MAKE_API_BASE = process.env.MAKE_API_BASE || 'https://eu1.make.com/api/v2';
const MAKE_API_KEY = process.env.MAKE_API_KEY || '';
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID || '';
const MAKE_AGENT_ID =
  process.env.MAKE_SUPERAGENT_ID || process.env.MAKE_AGENT_ID || '';
const MAKE_ARABIC_AGENT_ID = process.env.MAKE_ARABIC_AGENT_ID || MAKE_AGENT_ID;
const MAKE_CODE_AGENT_ID = process.env.MAKE_CODE_AGENT_ID || '';
const MAKE_BUILDER_AGENT_ID = process.env.MAKE_BUILDER_AGENT_ID || '';

// --- CDZ_AI direct-path envs — VERBATIM the integrations controller pattern
// (the WS10 fix). Prod sets CDZ_AI_BASE_URL WITH a trailing `/v1` (the copilot
// provider bootstrap default is `https://api.clickdz.ai/v1`); appending another
// `/v1/chat/completions` produced `…/v1/v1/…` → 404. Normalize by stripping a
// trailing `/v1` (and trailing slashes) so the origin is clean whether the
// operator set it WITH or WITHOUT `/v1`, then append the single canonical path
// below. The replace() chain never crashes at import. ---
const CDZ_AI_BASE_URL = (process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '')
  .replace(/\/+$/, '');
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';
const CDZ_PLANNER_MODEL = process.env.CDZ_PLANNER_MODEL || 'cdz-flash';
// The single canonical OpenAI-compatible endpoint path — kept as consts so the
// resolved base+path is logged once (NO key) and the URL is built in exactly
// one place.
const CDZ_PLANNER_PATH = '/v1/chat/completions';
const CDZ_PLANNER_URL = `${CDZ_AI_BASE_URL}${CDZ_PLANNER_PATH}`;

// --- Loop budgets (AbortController-backed timeouts everywhere; every per-call
// timeout is additionally clamped to the remaining wall clock). C2 contract:
// cap 6 tool iterations / 90s wall for the LEGACY buffered /run. ---
const HERMES_PLANNER_TIMEOUT_MS = 10_000;
const HERMES_COMPOSIO_DISCOVER_TIMEOUT_MS = 8_000;
const HERMES_COMPOSIO_EXECUTE_TIMEOUT_MS = 20_000;
const HERMES_MAKE_TIMEOUT_MS = 30_000;
const HERMES_WALL_CLOCK_MS = 90_000;
// Hard iteration cap on tool CALLS (not counting the terminal final turn).
const HERMES_MAX_ITERATIONS = 6;
// Prompt/response budgets (same values as the proven integrations loop).
const HERMES_GOAL_MIN = 1;
const HERMES_GOAL_MAX = 4_000;
const STEP_PREVIEW_CHAR_CAP = 2_000;
const RESULT_FEEDBACK_CHAR_CAP = 2_000;
const PLANNER_MAX_TOKENS = 700;
const DISCOVER_TOOLS_LIMIT = 25;

// --- Streaming (C5) budgets. The SSE console has NO hard wall clock — the
// runtime's 15s heartbeat keeps the connection alive through proxies, so the
// only bound is a generous per-planner-call timeout + a step-count cap so a
// runaway plan can't loop forever. Approval waits are long (the FE user is in
// the loop) but bounded. ---
const HERMES_STREAM_PLANNER_TIMEOUT_MS = 30_000;
const HERMES_STREAM_MAX_ITERATIONS = 8;
const HERMES_APPROVAL_TIMEOUT_MS = 120_000;
const HERMES_FINAL_STREAM_TIMEOUT_MS = 60_000;
const HERMES_TITLE_MAX = 80;

// --- WS14 / C5: per-user agent CONFIG (onboarding persistence). A per-user
// singleton (the "1 hermes" = one config each) persisted through the JSON Cache
// under `clickdz:agent:config:<userId>:hermes`, ~90d TTL refreshed on write —
// mirroring the runtime's Pattern-B thread persistence. Threads stay the runs
// (no cap here). Field caps keep a single record well under the 8KB record
// budget the data API enforces elsewhere. ---
const HERMES_CONFIG_TTL_MS = 90 * 24 * 60 * 60 * 1000; // ~90 days
const hermesConfigKey = (userId: string) =>
  `clickdz:agent:config:${userId}:hermes`;
const HERMES_AGENT_NAME_MAX = 60;
const HERMES_PERSONA_GOAL_MAX = 2_000;
const HERMES_ENABLED_TOOLS_MAX = 50;
const HERMES_WORKFLOWS_MAX = 20;
const HERMES_WORKFLOW_TITLE_MAX = 120;
const HERMES_WORKFLOW_GOAL_MAX = 2_000;
const HERMES_MODES = ['auto', 'ask', 'dry'] as const;
type HermesMode = (typeof HERMES_MODES)[number];

// One saved workflow (replaces/augments the static CATEGORIES for this user).
interface HermesSavedWorkflow {
  title: string;
  goal: string;
}

// The persisted per-user Hermes config. `provisioned` drives the onboarding
// gate (unprovisioned → wizard; provisioned → dashboard/console). All optional
// fields are omitted when unset so the GET default is a clean {provisioned}.
interface HermesConfig {
  provisioned: boolean;
  agentName?: string;
  personaGoal?: string;
  enabledTools?: string[];
  defaultMode?: HermesMode;
  savedWorkflows?: HermesSavedWorkflow[];
  updatedAt?: number;
}

// --- Internal-data mirrors. These consts intentionally mirror (NOT import —
// both live in controllers we must not touch) the bridge's published-apps set
// and the data API's per-(slug,collection) hash key, so the internal read
// tools surface the SAME data those surfaces expose. ---
// Redis SET of JSON records `{slug,url,createdAt,kind?,storeSlug?}` per owner
// (clickdz-bridge.controller.ts publishedAppsKey).
const publishedAppsKey = (ownerId: string) =>
  `clickdz:apps:published:${ownerId}`;
// One Redis hash per (app slug, collection) (clickdz-data.controller.ts dataKey).
const appDataKey = (slug: string, collection: string) =>
  `clickdz:appdata:${slug}:${collection}`;
// Slug shape shared by the bridge + data API.
const APP_SLUG_RE = /^[a-z0-9-]{3,50}$/;
// Composio tool slugs are UPPER_SNAKE (e.g. GMAIL_SEND_EMAIL). Light sanity
// gate before we put one in a URL path (encodeURIComponent still applies).
const COMPOSIO_TOOL_SLUG_RE = /^[A-Za-z0-9_.-]{2,120}$/;
// The ERP's five canonical order states (French — exact accented strings).
const ORDER_STATUSES = [
  'Nouvelle',
  'Confirmée',
  'Expédiée',
  'Livrée',
  'Retournée',
] as const;

// One executed loop step surfaced back to the client (legacy HermesStep shape).
interface HermesStep {
  i: number;
  thought?: string;
  tool?: string;
  args?: any;
  ok: boolean;
  resultPreview?: string;
  error?: string;
}

// The planner's parsed single-turn decision (normalized, fail-closed).
interface PlannerDecision {
  action: 'call' | 'final';
  thought?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  answer?: string;
}

// One advertised HERMES tool: slug + human label + planner-facing description
// + argument hint + availability (env-gated) + `consequential` (C5): true when
// the tool WRITES/SENDS (Composio execute, Make run) and therefore needs a
// human approval gate in the streaming console's 'ask' mode. Reads are false.
interface HermesTool {
  slug: string;
  label: string;
  description: string;
  argsHint: string;
  available: boolean;
  consequential: boolean;
}

// A published-app record as stored by the bridge (parsed defensively).
interface PublishedAppRecord {
  slug: string;
  url: string;
  createdAt: string;
  kind?: 'shop' | 'erp' | 'app';
  storeSlug?: string;
}

// Internal tool execution result (pre-step): ok + preview or error detail.
interface ToolOutcome {
  ok: boolean;
  resultPreview?: string;
  error?: string;
}

// R6/WSA-2: the per-dispatch tool ctx. Extends Regis's AgentToolCtx with the
// remaining wall-clock budget the hermes tool defs thread into `executeTool`
// (Regis's ctx has no timeout field; carrying it here keeps the legacy per-call
// budget behavior EXACTLY — /run shrinks it, /stream + the detached loop use the
// per-surface timeout). Private to this controller.
interface HermesDispatchCtx extends AgentToolCtx {
  __remainingMs?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (module-level, no `this`, no I/O) — copied in spirit from
// clickdz-integrations.controller.ts so the parsing behavior is byte-for-byte
// the proven one.
// ---------------------------------------------------------------------------

/** Strip ```json ... ``` (or plain ``` / ~~~ ... ) fences the model may wrap JSON in. */
function stripCodeFences(raw: string): string {
  let s = String(raw ?? '').trim();
  const fence = /^[`~]{3,}[^\n]*\n?/;
  if (fence.test(s)) {
    s = s.replace(fence, '');
    s = s.replace(/[`~]{3,}\s*$/, '');
  }
  return s.trim();
}

/**
 * Fail-closed parse of the planner's JSON turn. Strips fences, tries JSON.parse
 * inside a try/catch, and NORMALIZES to a PlannerDecision. Anything unparseable
 * or shape-wrong becomes a {action:'final', answer:<raw text>} so the loop can
 * never crash on model noise. HERMES additionally carries an optional short
 * `thought` string through for the step timeline.
 */
function parsePlannerJson(raw: string): PlannerDecision {
  const text = String(raw ?? '');
  const stripped = stripCodeFences(text);
  let obj: any;
  try {
    obj = JSON.parse(stripped);
  } catch {
    // Model sometimes prepends prose then emits JSON — try the first {...} span.
    const first = stripped.indexOf('{');
    const last = stripped.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        obj = JSON.parse(stripped.slice(first, last + 1));
      } catch {
        return { action: 'final', answer: text.trim() };
      }
    } else {
      return { action: 'final', answer: text.trim() };
    }
  }
  if (!obj || typeof obj !== 'object') {
    return { action: 'final', answer: text.trim() };
  }
  const thought =
    typeof obj.thought === 'string' && obj.thought.trim()
      ? obj.thought.trim().slice(0, 500)
      : undefined;
  if (obj.action === 'call' && typeof obj.tool === 'string' && obj.tool.trim()) {
    const args =
      obj.arguments &&
      typeof obj.arguments === 'object' &&
      !Array.isArray(obj.arguments)
        ? (obj.arguments as Record<string, unknown>)
        : {};
    return { action: 'call', thought, tool: obj.tool.trim(), arguments: args };
  }
  if (obj.action === 'final') {
    const answer =
      typeof obj.answer === 'string' && obj.answer.trim()
        ? obj.answer.trim()
        : text.trim();
    return { action: 'final', thought, answer };
  }
  // Unknown/absent action -> treat the whole thing as a final answer.
  return { action: 'final', thought, answer: text.trim() };
}

/** JSON-stringify a value and hard-truncate to `cap` chars (default 2000). */
function truncatePreview(
  value: unknown,
  cap: number = STEP_PREVIEW_CHAR_CAP
): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s == null) s = '';
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `… [truncated ${s.length - cap} chars]`;
}

/** Defensively pull the array of tool objects out of a Composio v3 tools payload. */
function extractToolList(data: any): any[] {
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.tools)) return data.tools;
  if (Array.isArray(data)) return data;
  return [];
}

/**
 * Tolerant extraction of a Make.com agent's text reply (mirrors the bridge's
 * parseMakeAgentResponse: string | {reply|answer|content|response}).
 */
function extractMakeReply(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.reply === 'string') return parsed.reply;
      if (typeof parsed?.answer === 'string') return parsed.answer;
      if (typeof parsed?.content === 'string') return parsed.content;
      if (typeof parsed?.response === 'string') return parsed.response;
      return raw;
    } catch {
      return raw;
    }
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.reply === 'string') return obj.reply;
    if (typeof obj.answer === 'string') return obj.answer;
    if (typeof obj.content === 'string') return obj.content;
    if (obj.response != null) return extractMakeReply(obj.response);
  }
  return '';
}

/** Finite-number coercion (mirrors the ERP template's num()). */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** An order's business date (prefer orderedAt/date, fall back to createdAt). */
function orderDate(o: Record<string, unknown>): string {
  return String(o.orderedAt || o.date || o.createdAt || '').slice(0, 10);
}

/** An order's total: explicit `total` when finite, else sum(items price*qty). */
function orderTotal(o: Record<string, unknown>): number {
  if (o.total != null && Number.isFinite(Number(o.total))) return num(o.total);
  const items = Array.isArray(o.items) ? o.items : [];
  return items.reduce(
    (s: number, it: any) => s + num(it?.price) * num(it?.qty != null ? it.qty : 1),
    0
  );
}

/**
 * The static HERMES tool catalog. Availability is env-derived: a missing key
 * marks the tool unavailable (skipped by the planner prompt + loop guard) —
 * the agent degrades gracefully instead of faking or crashing. Internal Redis
 * reads have no external dependency and are always available.
 *
 * `consequential` (C5): true for tools that WRITE/SEND to the outside world
 * (Composio execute, Make run). The streaming console gates every consequential
 * call behind a human `approval_request` in 'ask' mode. Reads = false.
 */
function buildToolCatalog(): HermesTool[] {
  const makeAvailable = !!(MAKE_API_KEY && MAKE_TEAM_ID && MAKE_AGENT_ID);
  return [
    {
      slug: 'shops_list',
      label: 'List my shops & apps',
      description:
        "List the signed-in user's published ClickDz apps (slug, url, kind shop/erp/app, storeSlug pairing).",
      argsHint: '{}',
      available: true,
      consequential: false,
    },
    {
      slug: 'shop_erp_summary',
      label: 'Read shop ERP summary',
      description:
        "Read a compact business summary for ONE of the user's shops: revenue this month, pending orders, orders by status, low-stock products, recent orders. Use shops_list first to get valid slugs.",
      argsHint: '{"slug":"<one of the user\'s app slugs>"}',
      available: true,
      consequential: false,
    },
    {
      slug: 'composio_discover',
      label: 'Composio: discover tools',
      description:
        'Discover executable Composio tools for one toolkit (e.g. gmail, googlesheets, github, slack, notion). Returns tool slugs + required params to use with composio_execute.',
      argsHint: '{"toolkit":"<toolkit slug, e.g. gmail>"}',
      available: !!COMPOSIO_API_KEY,
      consequential: false,
    },
    {
      slug: 'composio_execute',
      label: 'Composio: execute tool',
      description:
        'Execute one Composio tool by its EXACT tool slug (e.g. GMAIL_SEND_EMAIL) on behalf of the user. Discover slugs with composio_discover first when unsure. Fails with an auth message if the user has not connected that toolkit on the Integrations page.',
      argsHint: '{"tool":"<TOOL_SLUG>","arguments":{...tool inputs...}}',
      available: !!COMPOSIO_API_KEY,
      // WRITES/SENDS to external accounts (email, sheets, github…). Gated.
      consequential: true,
    },
    {
      slug: 'make_agent_run',
      label: 'Make.com agent',
      description:
        'Delegate a sub-task to a Make.com AI agent (long-form reasoning, drafting, automation know-how). Buffered text reply. Optional "agent" picks a specialist: default | code | builder | arabic.',
      argsHint: '{"prompt":"<sub-task>","agent":"default"}',
      available: makeAvailable,
      // Triggers a Make.com automation run (may fire scenarios/webhooks). Gated.
      consequential: true,
    },
  ];
}

/** Render the available tools as a compact prompt block (slug: desc + args). */
function buildToolBlock(tools: HermesTool[]): string {
  return tools
    .filter(t => t.available)
    .map(t => `- ${t.slug}: ${t.description} arguments: ${t.argsHint}`)
    .join('\n');
}

/** The set of REAL tool slugs (whole catalog, availability-agnostic) — the
 * allowlist a persisted `enabledTools` is intersected against so a stored config
 * can never reference an invented slug. Availability is still applied at read
 * time in /capabilities; enabling an env-gated tool is allowed (it simply stays
 * unavailable until its key is present). */
function allToolSlugs(): Set<string> {
  return new Set(buildToolCatalog().map(t => t.slug));
}

// R6/WSA-2: the set of LEGACY hermes tool slugs (module-cached — the catalog is
// static). Used to tell a hermes tool (whose registry def returns a ToolOutcome
// as `result`) apart from a built-in registry tool (web_*), so dispatchTool can
// map each envelope back to a ToolOutcome correctly.
const HERMES_SLUGS: ReadonlySet<string> = allToolSlugs();
function isHermesSlug(slug: string): boolean {
  return HERMES_SLUGS.has(slug);
}

/**
 * Sanitize a persisted (possibly partial/corrupt) Hermes config read back from
 * the cache into the canonical GET shape. Unknown/invalid fields are dropped;
 * enabledTools is intersected with the real catalog; the default when nothing is
 * stored is {provisioned:false}. Pure, never throws.
 */
function normalizeHermesConfig(raw: unknown): HermesConfig {
  if (!raw || typeof raw !== 'object') return { provisioned: false };
  const o = raw as Record<string, unknown>;
  const out: HermesConfig = { provisioned: o.provisioned === true };
  if (typeof o.agentName === 'string' && o.agentName.trim()) {
    out.agentName = o.agentName.trim().slice(0, HERMES_AGENT_NAME_MAX);
  }
  if (typeof o.personaGoal === 'string' && o.personaGoal.trim()) {
    out.personaGoal = o.personaGoal.trim().slice(0, HERMES_PERSONA_GOAL_MAX);
  }
  if (Array.isArray(o.enabledTools)) {
    const known = allToolSlugs();
    const tools = o.enabledTools
      .filter((s): s is string => typeof s === 'string')
      .map(s => s.trim())
      .filter(s => known.has(s));
    out.enabledTools = Array.from(new Set(tools)).slice(
      0,
      HERMES_ENABLED_TOOLS_MAX
    );
  }
  if (
    typeof o.defaultMode === 'string' &&
    (HERMES_MODES as readonly string[]).includes(o.defaultMode)
  ) {
    out.defaultMode = o.defaultMode as HermesMode;
  }
  if (Array.isArray(o.savedWorkflows)) {
    const flows: HermesSavedWorkflow[] = [];
    for (const w of o.savedWorkflows) {
      if (!w || typeof w !== 'object') continue;
      const wo = w as Record<string, unknown>;
      const title =
        typeof wo.title === 'string' ? wo.title.trim() : '';
      const goal = typeof wo.goal === 'string' ? wo.goal.trim() : '';
      if (!title && !goal) continue;
      flows.push({
        title: title.slice(0, HERMES_WORKFLOW_TITLE_MAX),
        goal: goal.slice(0, HERMES_WORKFLOW_GOAL_MAX),
      });
      if (flows.length >= HERMES_WORKFLOWS_MAX) break;
    }
    out.savedWorkflows = flows;
  }
  if (typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt)) {
    out.updatedAt = o.updatedAt;
  }
  return out;
}

/** A short, safe thread title derived from the user's first message. */
function deriveThreadTitle(message: string): string {
  const one = String(message ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!one) return 'New conversation';
  return one.length <= HERMES_TITLE_MAX
    ? one
    : one.slice(0, HERMES_TITLE_MAX - 1).trimEnd() + '…';
}

/**
 * ClickDz HERMES — autonomous operations agent. All routes are auth'd (global
 * AuthGuard requires a signed-in cookie session — no @Public()); the run +
 * streaming routes are rate-capped with @Throttle('strict'), reads with
 * @Throttle('default'), mirroring the sibling controllers.
 */
@Controller()
export class ClickDzHermesController {
  private readonly logger = new Logger(ClickDzHermesController.name);

  // One-shot flag so the resolved planner base+path is logged the FIRST time a
  // planner call is actually attempted (lazy — never at import), never repeated.
  // Path only, no key material.
  private plannerUrlLogged = false;

  // WS12/C5: inject the shared agent runtime (SSE writer + Redis threads +
  // stop/approval registries) ALONGSIDE the existing CacheRedis the legacy read
  // tools use. CacheRedis stays for the internal shops/ERP reads; the runtime
  // owns thread persistence + streaming coordination.
  // WS14/C5: `Cache` (the @Global JSON provider) is added for the per-user agent
  // config singleton — the SAME provider the runtime persists threads through,
  // so config get/set reuses the proven fail-soft (de)serialization idiom.
  // R6/WSA-2: `Config` is added for the shared tool registry's web-tool gate.
  //
  // The unified tool registry (Regis) is built ONCE at construction (cheap,
  // synchronous, fail-soft) with the hermes-specific tools injected as
  // `extraTools`. It is the SINGLE dispatch path for /run + /stream + the
  // detached background loop. When CDZ_AGENTS_ENABLED is set we ALSO register
  // the detached loop body with Moteur's run engine so `copilot.agent.run` jobs
  // execute — otherwise the engine simply has no hermes loop and background
  // runs no-op (byte-identical when the flag is off).
  private readonly registry: ClickDzToolRegistry;

  constructor(
    private readonly redis: CacheRedis,
    private readonly runtime: ClickDzAgentRuntime,
    private readonly cache: Cache,
    private readonly config: Config
  ) {
    // Build the shared registry. `extraTools` = the hermes-specific defs, which
    // delegate to the private tool methods below so behavior/args/results are
    // IDENTICAL to the legacy switch. The built-in web tools register too but
    // stay unavailable unless CDZ_AGENT_WEB_ENABLED + an exa key are present.
    //
    // R8/WSA-10: also fold in the memory tools (memory_write / memory_read).
    // createMemoryTools() SELF-GATES on memoryEnabled() — it returns [] when
    // memory is OFF, so the spread contributes NOTHING and the registry is
    // byte-identical to today when the flag is unset (verified against
    // clickdz-agent-memory.ts). The tools read Redis from ctx.services.redis
    // (already the raw CacheRedis this controller wires), so no deps are needed.
    this.registry = buildDefaultRegistry({
      redis: this.redis,
      config: this.config,
      extraTools: [...this.buildHermesToolDefs(), ...createMemoryTools()],
    });

    // R6/WSA-2: register the detached loop with Moteur's engine ONLY behind the
    // master flag. registerAgentLoop is idempotent (last wins); the factory
    // closes over `this` so the job handler can drive the SAME plan→act logic.
    if (CDZ_AGENTS_ENABLED) {
      registerAgentLoop('hermes', (rec: AgentRunRecord): AgentLoopDeps => ({
        redis: this.redis as any,
        planner: null,
        registry: this.registry,
        config: this.config,
        runtime: this.runtime,
        loop: (ctx: AgentLoopContext) => this.runHermesLoop(ctx, rec),
      }));
    }

    // R8/WSA-10: register the memory summarizer with Moteur's run engine behind
    // BOTH flags (memory + agents). It hooks onAgentRunDone and, on a DONE run,
    // appends a cdz-flash one-line summary to that user's memory. Idempotent +
    // fail-soft (Souvenir): a missing engine or a summary hiccup is swallowed,
    // never breaking a run. Off/absent flags ⇒ not registered ⇒ byte-identical.
    if (memoryEnabled() && CDZ_AGENTS_ENABLED) {
      registerMemorySummarizer({ redis: this.redis });
    }
  }

  /**
   * Read + normalize the caller's persisted Hermes config (fail-soft). Returns
   * the canonical {provisioned:false} default when nothing is stored or the read
   * fails. Never throws.
   */
  private async readHermesConfig(userId: string): Promise<HermesConfig> {
    try {
      const raw = await this.cache.get<unknown>(hermesConfigKey(userId));
      return normalizeHermesConfig(raw);
    } catch {
      return { provisioned: false };
    }
  }

  /** Small helper: fetch with a hard AbortController timeout. */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<globalThis.Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET capabilities — drives the HERMES UI enable/disable state.
   * {tools:[{slug,label,available,consequential,enabled}], plannerReady,
   * streaming, provisioned}. Never throws; env-derived + per-user.
   *
   * WS12 added `streaming:true` + per-tool `consequential`. WS14/C5 FOLDS the
   * per-user config in (the `_user` this route already receives is the wire-in
   * point): each tool gains `enabled` = is it in the user's enabledTools set
   * (defaults to true when the user hasn't customized the set, so the console
   * works out of the box), and top-level `provisioned` mirrors the config so the
   * FE onboarding gate can key off /capabilities alone if it prefers. The
   * existing {tools, plannerReady, streaming} fields are untouched — additive.
   */
  @Throttle('default')
  @Get('/api/v1/hermes/capabilities')
  async capabilities(@CurrentUser() user: CurrentUser, @Res() res: Response) {
    const config = await this.readHermesConfig(user.id);
    // When the user has an explicit enabledTools set, honor it; otherwise every
    // tool is enabled by default (no customization = full catalog available).
    const enabledSet =
      config.enabledTools && config.enabledTools.length
        ? new Set(config.enabledTools)
        : null;
    const tools = buildToolCatalog().map(t => ({
      slug: t.slug,
      label: t.label,
      available: t.available,
      consequential: t.consequential,
      enabled: enabledSet ? enabledSet.has(t.slug) : true,
    }));
    res.status(200).json({
      tools,
      plannerReady: !!CDZ_AI_KEY,
      streaming: true,
      provisioned: config.provisioned,
    });
  }

  // -------------------------------------------------------------------------
  // WS14 / C5 — per-user agent CONFIG (onboarding persistence).
  //
  //   GET /api/v1/hermes/config → the caller's config (defaults
  //     {provisioned:false} when none). Auth via @CurrentUser.
  //   PUT /api/v1/hermes/config {agentName?, personaGoal?, enabledTools?,
  //     defaultMode?, savedWorkflows?} → upsert (merges over the stored config,
  //     sets provisioned:true), validated (defaultMode enum; enabledTools ⊆ real
  //     tool slugs; length/count caps), typed 400 on malformed input via @Res
  //     passthrough — NEVER a raw HttpException.
  //
  // The config is a per-user SINGLETON (the "1 hermes" = one config each);
  // threads remain the runs, so there is no thread cap and no 409 — PUT just
  // upserts. Persisted through the JSON Cache under
  // `clickdz:agent:config:<userId>:hermes` (~90d TTL, refreshed on write),
  // mirroring the runtime's thread persistence idiom.
  // -------------------------------------------------------------------------
  @Throttle('default')
  @Get('/api/v1/hermes/config')
  async getConfig(@CurrentUser() user: CurrentUser): Promise<HermesConfig> {
    return this.readHermesConfig(user.id);
  }

  @Throttle('default')
  @Put('/api/v1/hermes/config')
  async putConfig(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ): Promise<HermesConfig | { ok: false; error: string }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ ok: false, error: 'body must be an object' });
      return { ok: false, error: 'invalid_body' };
    }

    // Start from the stored config so PUT is a partial upsert (unspecified
    // fields are preserved), then validate + apply each provided field.
    const current = await this.readHermesConfig(user.id);
    const next: HermesConfig = { ...current, provisioned: true };

    if (body.agentName !== undefined) {
      if (typeof body.agentName !== 'string') {
        res
          .status(400)
          .json({ ok: false, error: '"agentName" must be a string' });
        return { ok: false, error: 'invalid_agentName' };
      }
      const name = body.agentName.trim();
      if (name.length > HERMES_AGENT_NAME_MAX) {
        res.status(400).json({
          ok: false,
          error: `"agentName" must be <= ${HERMES_AGENT_NAME_MAX} chars`,
        });
        return { ok: false, error: 'invalid_agentName' };
      }
      if (name) next.agentName = name;
      else delete next.agentName;
    }

    if (body.personaGoal !== undefined) {
      if (typeof body.personaGoal !== 'string') {
        res
          .status(400)
          .json({ ok: false, error: '"personaGoal" must be a string' });
        return { ok: false, error: 'invalid_personaGoal' };
      }
      const goal = body.personaGoal.trim();
      if (goal.length > HERMES_PERSONA_GOAL_MAX) {
        res.status(400).json({
          ok: false,
          error: `"personaGoal" must be <= ${HERMES_PERSONA_GOAL_MAX} chars`,
        });
        return { ok: false, error: 'invalid_personaGoal' };
      }
      if (goal) next.personaGoal = goal;
      else delete next.personaGoal;
    }

    if (body.enabledTools !== undefined) {
      if (!Array.isArray(body.enabledTools)) {
        res
          .status(400)
          .json({ ok: false, error: '"enabledTools" must be an array' });
        return { ok: false, error: 'invalid_enabledTools' };
      }
      if (body.enabledTools.length > HERMES_ENABLED_TOOLS_MAX) {
        res.status(400).json({
          ok: false,
          error: `"enabledTools" must have <= ${HERMES_ENABLED_TOOLS_MAX} entries`,
        });
        return { ok: false, error: 'invalid_enabledTools' };
      }
      const known = allToolSlugs();
      const cleaned: string[] = [];
      for (const raw of body.enabledTools) {
        if (typeof raw !== 'string') {
          res.status(400).json({
            ok: false,
            error: '"enabledTools" entries must be strings',
          });
          return { ok: false, error: 'invalid_enabledTools' };
        }
        const slug = raw.trim();
        if (!known.has(slug)) {
          res.status(400).json({
            ok: false,
            error: `unknown tool slug "${slug}" — must be one of: ${Array.from(
              known
            ).join(', ')}`,
          });
          return { ok: false, error: 'unknown_tool' };
        }
        cleaned.push(slug);
      }
      next.enabledTools = Array.from(new Set(cleaned));
    }

    if (body.defaultMode !== undefined) {
      if (
        typeof body.defaultMode !== 'string' ||
        !(HERMES_MODES as readonly string[]).includes(body.defaultMode)
      ) {
        res.status(400).json({
          ok: false,
          error: `"defaultMode" must be one of: ${HERMES_MODES.join(', ')}`,
        });
        return { ok: false, error: 'invalid_defaultMode' };
      }
      next.defaultMode = body.defaultMode as HermesMode;
    }

    if (body.savedWorkflows !== undefined) {
      if (!Array.isArray(body.savedWorkflows)) {
        res
          .status(400)
          .json({ ok: false, error: '"savedWorkflows" must be an array' });
        return { ok: false, error: 'invalid_savedWorkflows' };
      }
      if (body.savedWorkflows.length > HERMES_WORKFLOWS_MAX) {
        res.status(400).json({
          ok: false,
          error: `"savedWorkflows" must have <= ${HERMES_WORKFLOWS_MAX} entries`,
        });
        return { ok: false, error: 'invalid_savedWorkflows' };
      }
      const flows: HermesSavedWorkflow[] = [];
      for (const w of body.savedWorkflows) {
        if (!w || typeof w !== 'object' || Array.isArray(w)) {
          res.status(400).json({
            ok: false,
            error: '"savedWorkflows" entries must be objects {title, goal}',
          });
          return { ok: false, error: 'invalid_savedWorkflows' };
        }
        const wo = w as Record<string, unknown>;
        const title = typeof wo.title === 'string' ? wo.title.trim() : '';
        const goal = typeof wo.goal === 'string' ? wo.goal.trim() : '';
        if (
          title.length > HERMES_WORKFLOW_TITLE_MAX ||
          goal.length > HERMES_WORKFLOW_GOAL_MAX
        ) {
          res.status(400).json({
            ok: false,
            error: `each workflow "title" (<= ${HERMES_WORKFLOW_TITLE_MAX}) and "goal" (<= ${HERMES_WORKFLOW_GOAL_MAX}) must respect the length caps`,
          });
          return { ok: false, error: 'invalid_savedWorkflows' };
        }
        if (!title && !goal) continue; // skip fully-empty rows
        flows.push({ title, goal });
      }
      next.savedWorkflows = flows;
    }

    next.updatedAt = Date.now();

    // Persist through the JSON Cache (fail-soft). If the write fails we still
    // return the normalized config the caller asked us to set — the FE proceeds
    // and a later read will simply miss (Redis is a cache, not the source of
    // truth); we surface a typed 503 only when we can detect the miss.
    const saved = await this.cache.set(hermesConfigKey(user.id), next, {
      ttl: HERMES_CONFIG_TTL_MS,
    });
    if (!saved) {
      res.status(503).json({
        ok: false,
        error: 'config could not be persisted right now — please retry',
      });
      return { ok: false, error: 'persist_failed' };
    }
    // Return the canonical normalized shape (identical to a subsequent GET).
    return normalizeHermesConfig(next);
  }

  // -------------------------------------------------------------------------
  // POST run — the LEGACY (back-compat) HERMES orchestrator. UNCHANGED.
  //
  //   body {goal: string (1..4000), dryRun?: boolean}
  //
  // Flow (the proven integrations /run loop, wider catalog):
  //   (a) validate goal (typed 400 on malformed input);
  //   (b) build the availability-filtered tool catalog into the system prompt;
  //   (c) cdz-flash plan turns — the model replies ONLY with JSON:
  //         {"action":"call","thought":"...","tool":"<slug>","arguments":{...}}
  //         {"action":"final","answer":"..."}
  //       parsed fail-closed (fences stripped; unparseable -> final answer);
  //   (d) on "call": execute the HERMES tool (Composio / Make / internal reads)
  //       — or, in dryRun, record the INTENDED call without executing — push a
  //       HermesStep and feed a truncated result back as the next user turn.
  //       Execution errors become ok:false steps whose error text is fed back
  //       (the loop recovers);
  //   (e) caps: 6 tool iterations + 90s wall clock (AbortController timeouts,
  //       each per-call timeout clamped to the remaining wall clock); on cap,
  //       ask once for a forced final answer, else synthesize deterministically.
  //
  // Success -> 200 {ok:true, answer, steps, iterations}.
  // cdz-flash unreachable before any step -> 502 {error:'planner_unavailable'}
  // via the injected @Res — NEVER a raw HttpException.
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/hermes/run')
  async run(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Res() res: Response
  ) {
    // ---- input validation (typed 400 for genuinely malformed input) ----
    const goal = typeof body?.goal === 'string' ? body.goal.trim() : '';
    if (goal.length < HERMES_GOAL_MIN || goal.length > HERMES_GOAL_MAX) {
      throw new BadRequest(
        `"goal" must be a string of ${HERMES_GOAL_MIN}..${HERMES_GOAL_MAX} chars`
      );
    }
    const dryRun = body?.dryRun === true;

    // Wall-clock budget for the whole loop (independent of per-call timeouts).
    const deadline = Date.now() + HERMES_WALL_CLOCK_MS;
    const timeLeft = () => deadline - Date.now();

    // (b) availability-filtered catalog -> prompt block + slug guard set.
    const catalog = buildToolCatalog();
    const available = catalog.filter(t => t.available);
    const knownSlugs = new Set(available.map(t => t.slug));

    // R6/WSA-2: fold in the registry's first-party web tools when (and only
    // when) CDZ_AGENT_WEB_ENABLED + an exa key are present. `web` is empty
    // otherwise, so both the prompt block AND the known-slug set are byte-
    // identical to today when the flag is off.
    const web = this.webTools(user.id);
    for (const slug of web.slugs) knownSlugs.add(slug);

    // R8/WSA-10: prime the prompt with the agent's memory ('' when OFF/empty ⇒
    // byte-identical). Single async read, injected at the one shared assembler.
    const memBlock = await this.hermesMemoryBlock(user.id);
    const systemPrompt = this.buildPlannerSystemPrompt(
      buildToolBlock(catalog) + web.block,
      dryRun,
      memBlock
    );

    // Conversation seed: system + the user's goal.
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: goal },
    ];

    const steps: HermesStep[] = [];
    let iterations = 0;
    let answer: string | null = null;

    // ---- the plan→act loop ----
    while (iterations < HERMES_MAX_ITERATIONS && timeLeft() > 0) {
      const planned = await this.callPlanner(messages, timeLeft());

      // planner unreachable BEFORE we produced anything -> 502. Once we have
      // steps we prefer to synthesize a partial answer instead of 502ing.
      if (planned === null) {
        if (steps.length === 0) {
          res.status(502).json({ error: 'planner_unavailable' });
          return;
        }
        answer = this.synthesizeAnswer(steps, dryRun);
        break;
      }

      // Record the assistant's raw turn so the model sees its own history.
      messages.push({ role: 'assistant', content: planned.raw });

      const decision = parsePlannerJson(planned.raw);

      if (decision.action === 'final') {
        answer = decision.answer ?? '';
        break;
      }

      // action === 'call'
      const toolSlug = decision.tool ?? '';
      const args = decision.arguments ?? {};

      // Guard against invented/unavailable tools: never execute a slug the
      // model wasn't given. Surface the miss as an ok:false step (the UI
      // timeline stays honest), feed the correction back and let it retry —
      // counts as an iteration to keep the loop bounded.
      if (!knownSlugs.has(toolSlug)) {
        iterations++;
        steps.push({
          i: steps.length + 1,
          thought: decision.thought,
          tool: toolSlug,
          args,
          ok: false,
          error: 'unknown_or_unavailable_tool',
        });
        const correction = `Tool "${toolSlug}" is not in the available tools. Choose one of the listed tool slugs, or finish with {"action":"final","answer":"..."}.`;
        messages.push({ role: 'user', content: correction });
        continue;
      }

      iterations++;

      if (dryRun) {
        // Plan-only mode: record the INTENDED call, execute nothing.
        steps.push({
          i: steps.length + 1,
          thought: decision.thought,
          tool: toolSlug,
          args,
          ok: true,
          resultPreview: '[dry-run] planned call — not executed',
        });
        messages.push({
          role: 'user',
          content: `Dry-run mode: the call to ${toolSlug} was recorded but NOT executed, so you have no real result. Plan the next intended step, or finish with {"action":"final","answer":"..."} summarizing the full plan.`,
        });
        continue;
      }

      const outcome = await this.dispatchTool(toolSlug, args, user.id, timeLeft());
      steps.push({
        i: steps.length + 1,
        thought: decision.thought,
        tool: toolSlug,
        args,
        ok: outcome.ok,
        ...(outcome.resultPreview !== undefined
          ? { resultPreview: truncatePreview(outcome.resultPreview) }
          : {}),
        ...(outcome.error !== undefined
          ? { error: truncatePreview(outcome.error, 500) }
          : {}),
      });

      // Feed a truncated result back to the model as the next user turn.
      const feedback = outcome.ok
        ? `Result of ${toolSlug} (ok): ${truncatePreview(outcome.resultPreview ?? '', RESULT_FEEDBACK_CHAR_CAP)}`
        : `Error from ${toolSlug} (failed): ${truncatePreview(outcome.error ?? 'tool_failed', RESULT_FEEDBACK_CHAR_CAP)}`;
      messages.push({ role: 'user', content: feedback });
    }

    // (e) cap hit with no final answer yet: ask the model one last time for a
    // final answer (best-effort), else synthesize from the steps.
    if (answer === null) {
      const finalTry =
        timeLeft() > 1_000
          ? await this.callPlanner(
              [
                ...messages,
                {
                  role: 'user',
                  content:
                    'You have reached the step limit. Reply now with {"action":"final","answer":"..."} summarizing what you did or what the user should do next. No more tool calls.',
                },
              ],
              timeLeft()
            )
          : null;
      if (finalTry) {
        const d = parsePlannerJson(finalTry.raw);
        answer =
          d.action === 'final' && d.answer
            ? d.answer
            : this.synthesizeAnswer(steps, dryRun);
      } else {
        answer = this.synthesizeAnswer(steps, dryRun);
      }
    }

    res.status(200).json({ ok: true, answer, steps, iterations });
  }

  // =========================================================================
  // WS12 / C5 — STREAMING MULTI-TURN AGENT (SSE via ClickDzAgentRuntime)
  // =========================================================================

  // -------------------------------------------------------------------------
  // POST /api/v1/hermes/stream — the live console run.
  //
  //   body {threadId?: string; message: string; mode?: 'auto'|'ask'|'dry'}
  //
  // Opens an SSE stream (runtime.openStream sets headers + 15s heartbeat +
  // req 'close' wiring), resolves/creates the thread, appends the user turn,
  // emits `thread`, then runs the SAME plan→act loop as /run but EMITS live:
  //   - `status` planning/executing/finalizing/waiting_approval/stopped/done
  //   - `tool_call` + `tool_result` bracketing each real tool exec
  //   - `step` per completed step (append to the in-progress assistant message)
  //   - `approval_request` (mode 'ask', before a CONSEQUENTIAL tool) → await
  //     the FE decision (runtime.awaitApproval, 120s); deny/timeout → skip the
  //     tool with a noted step
  //   - `token` events streaming the FINAL natural-language answer from a
  //     separate cdz-flash `stream:true` call
  //   - `final` (persisted assistant message w/ steps) then `done`
  // mode 'dry' plans only (executes nothing). `isStopRequested` is checked each
  // iteration → `status stopped` + partial `final` + `done`. EVERYTHING is
  // wrapped so any error emits `{type:'error'}` + `done` — never throws out of
  // an open stream (the global filter can't help once headers are flushed).
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/hermes/stream')
  async stream(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response
  ) {
    // The runtime writer owns headers/heartbeat/close. Once opened, we NEVER
    // throw out — all failures become an `error` event + `done`.
    const writer = this.runtime.openStream(req, res);
    const emit = (ev: AgentEvent) => {
      if (!writer.closed) writer.emit(ev);
    };

    // Validate INSIDE the stream (headers already sent → can't 400). A bad
    // message ends the stream cleanly with an error frame.
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const modeRaw = typeof body?.mode === 'string' ? body.mode : 'auto';
    const mode: 'auto' | 'ask' | 'dry' =
      modeRaw === 'ask' || modeRaw === 'dry' ? modeRaw : 'auto';
    const threadIdIn =
      typeof body?.threadId === 'string' && body.threadId.trim()
        ? body.threadId.trim()
        : undefined;

    if (message.length < HERMES_GOAL_MIN || message.length > HERMES_GOAL_MAX) {
      emit({
        type: 'error',
        code: 'bad_request',
        message: `"message" must be a string of ${HERMES_GOAL_MIN}..${HERMES_GOAL_MAX} chars`,
      });
      writer.end();
      return;
    }

    try {
      // ---- resolve/create the thread (runtime-owned Redis persistence) ----
      let thread: AgentThread | null = null;
      if (threadIdIn) {
        thread = await this.runtime.getThread(user.id, threadIdIn);
      }
      if (!thread) {
        thread = await this.runtime.createThread(
          user.id,
          'hermes',
          deriveThreadTitle(message)
        );
      }
      // A fresh stream must never inherit a stale stop flag from a prior run.
      await this.runtime.clearStop(thread.id);

      // ---- append the user turn + emit `thread` ----
      const userMsg: AgentMessage = {
        id: randomUUID(),
        role: 'user',
        content: message,
        createdAt: Date.now(),
        agent: 'hermes',
      };
      thread.messages.push(userMsg);
      await this.runtime.saveThread(user.id, thread);
      emit({
        type: 'thread',
        threadId: thread.id,
        agent: 'hermes',
        title: thread.title,
      });

      // ---- run the streaming plan→act loop ----
      const { steps, answer, stopped } = await this.runStreamingLoop(
        emit,
        writer,
        user.id,
        thread,
        message,
        mode
      );

      // ---- build + persist the assistant turn ----
      const assistantMsg: AgentMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: answer,
        steps,
        createdAt: Date.now(),
        agent: 'hermes',
      };
      thread.messages.push(assistantMsg);
      await this.runtime.saveThread(user.id, thread);
      // Best-effort: a completed run clears any lingering stop flag.
      await this.runtime.clearStop(thread.id);

      emit({ type: 'final', message: assistantMsg });
      emit({
        type: 'status',
        phase: stopped ? 'stopped' : 'done',
        label: stopped ? 'Stopped' : 'Done',
      });
      writer.end();
    } catch (err) {
      // Never throw out of an open SSE stream — emit a terminal error + done.
      this.logger.warn(
        `[hermes] stream failed: ${(err as Error)?.message ?? err}`
      );
      emit({
        type: 'error',
        code: 'stream_failed',
        message: 'The agent run failed unexpectedly. Please try again.',
      });
      writer.end();
    }
  }

  /**
   * The streaming plan→act loop. Mirrors the legacy /run loop's decision logic
   * (same planner, same fail-closed parsing, same unknown-slug guard, same
   * result-feedback) but emits live SSE events and adds the C5 approval gate +
   * cooperative stop. Returns the accumulated steps + final answer text +
   * whether it stopped early. NEVER throws (every tool exec is already caught).
   */
  private async runStreamingLoop(
    emit: (ev: AgentEvent) => void,
    writer: { closed: boolean },
    userId: string,
    thread: AgentThread,
    message: string,
    mode: 'auto' | 'ask' | 'dry'
  ): Promise<{ steps: AgentStep[]; answer: string; stopped: boolean }> {
    const dryRun = mode === 'dry';
    const catalog = buildToolCatalog();
    const knownSlugs = new Set(
      catalog.filter(t => t.available).map(t => t.slug)
    );
    const consequentialSlugs = new Set(
      catalog.filter(t => t.consequential).map(t => t.slug)
    );

    // R6/WSA-2: fold in the registry's first-party web tools when enabled (web
    // reads are non-consequential, so consequentialSlugs is untouched). Empty
    // when the flag/key are off ⇒ byte-identical prompt + guard set.
    const web = this.webTools(userId);
    for (const slug of web.slugs) knownSlugs.add(slug);

    // R8/WSA-10: prime the prompt with the agent's memory ('' when OFF/empty ⇒
    // byte-identical). Single async read, injected at the one shared assembler.
    const memBlock = await this.hermesMemoryBlock(userId);
    const systemPrompt = this.buildPlannerSystemPrompt(
      buildToolBlock(catalog) + web.block,
      dryRun,
      memBlock
    );

    // Rehydrate prior turns so the stream is genuinely multi-turn. The just-
    // appended user message is already the last element of thread.messages.
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];
    for (const m of thread.messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const steps: AgentStep[] = [];
    let iterations = 0;
    let answer: string | null = null;
    let stopped = false;

    const pushStep = (step: AgentStep) => {
      steps.push(step);
      emit({ type: 'step', step });
    };

    emit({ type: 'status', phase: 'planning', label: 'Planning' });

    while (iterations < HERMES_STREAM_MAX_ITERATIONS) {
      // Cooperative stop + client-disconnect checks each iteration.
      if (writer.closed) {
        stopped = true;
        break;
      }
      if (await this.runtime.isStopRequested(thread.id)) {
        stopped = true;
        break;
      }

      const planned = await this.callPlanner(
        messages,
        HERMES_STREAM_PLANNER_TIMEOUT_MS
      );

      if (planned === null) {
        // Planner unreachable. With no steps yet there is nothing to salvage —
        // surface a clear error status; the caller still streams a final turn.
        if (steps.length === 0) {
          emit({
            type: 'status',
            phase: 'error',
            label: 'Planner unavailable',
          });
          answer =
            "I couldn't reach the planner just now, so I didn't run anything. Please try again in a moment.";
          break;
        }
        answer = this.synthesizeAnswer(steps as HermesStep[], dryRun);
        break;
      }

      messages.push({ role: 'assistant', content: planned.raw });
      const decision = parsePlannerJson(planned.raw);

      if (decision.action === 'final') {
        answer = decision.answer ?? '';
        break;
      }

      // action === 'call'
      const toolSlug = decision.tool ?? '';
      const args = decision.arguments ?? {};

      // Unknown/unavailable tool → honest ok:false step + correction feedback.
      if (!knownSlugs.has(toolSlug)) {
        iterations++;
        pushStep({
          i: steps.length + 1,
          kind: 'tool',
          title: `Unknown tool: ${toolSlug || '(none)'}`,
          detail: decision.thought,
          tool: toolSlug,
          args,
          ok: false,
          error: 'unknown_or_unavailable_tool',
          ts: Date.now(),
        });
        messages.push({
          role: 'user',
          content: `Tool "${toolSlug}" is not in the available tools. Choose one of the listed tool slugs, or finish with {"action":"final","answer":"..."}.`,
        });
        continue;
      }

      iterations++;

      // dry-run: record the intended call, execute nothing.
      if (dryRun) {
        pushStep({
          i: steps.length + 1,
          kind: 'tool',
          title: `Planned: ${toolSlug}`,
          detail: decision.thought,
          tool: toolSlug,
          args,
          ok: true,
          resultPreview: '[dry-run] planned call — not executed',
          ts: Date.now(),
        });
        messages.push({
          role: 'user',
          content: `Dry-run mode: the call to ${toolSlug} was recorded but NOT executed, so you have no real result. Plan the next intended step, or finish with {"action":"final","answer":"..."} summarizing the full plan.`,
        });
        continue;
      }

      // ---- C5 approval gate: pause before a CONSEQUENTIAL tool in 'ask' mode ----
      if (mode === 'ask' && consequentialSlugs.has(toolSlug)) {
        const approvalId = randomUUID();
        emit({
          type: 'approval_request',
          id: approvalId,
          tool: toolSlug,
          title: `Approve ${toolSlug}?`,
          summary: this.approvalSummary(toolSlug, args),
          args,
        });
        emit({
          type: 'status',
          phase: 'waiting_approval',
          label: 'Waiting for approval',
        });

        const decisionResult = await this.runtime.awaitApproval(
          thread.id,
          approvalId,
          HERMES_APPROVAL_TIMEOUT_MS
        );

        if (decisionResult !== 'approve') {
          // deny OR timeout → skip the tool, note it, feed the model a correction.
          const reason =
            decisionResult === 'timeout'
              ? 'approval_timed_out'
              : 'denied_by_user';
          pushStep({
            i: steps.length + 1,
            kind: 'tool',
            title: `Skipped: ${toolSlug}`,
            detail: decision.thought,
            tool: toolSlug,
            args,
            ok: false,
            error: reason,
            ts: Date.now(),
          });
          messages.push({
            role: 'user',
            content: `The user did NOT approve the call to ${toolSlug} (${reason}). Do not attempt it again. Continue with a different approach or finish with {"action":"final","answer":"..."} explaining what still needs the user's approval.`,
          });
          emit({ type: 'status', phase: 'executing', label: 'Executing' });
          continue;
        }
        // approved → fall through to execute.
        emit({ type: 'status', phase: 'executing', label: 'Executing' });
      } else {
        emit({ type: 'status', phase: 'executing', label: 'Executing' });
      }

      // ---- execute the tool, bracketed by tool_call / tool_result ----
      const callId = randomUUID();
      const startedAt = Date.now();
      emit({
        type: 'tool_call',
        id: callId,
        tool: toolSlug,
        title: this.toolTitle(toolSlug),
        args,
      });

      // Streaming has no hard wall clock (the heartbeat keeps SSE alive); give
      // each tool its full per-surface budget rather than a shrinking remainder.
      const outcome = await this.dispatchTool(
        toolSlug,
        args,
        userId,
        this.toolTimeout(toolSlug)
      );
      const durationMs = Date.now() - startedAt;

      const resultPreview =
        outcome.resultPreview !== undefined
          ? truncatePreview(outcome.resultPreview)
          : undefined;
      const errorPreview =
        outcome.error !== undefined
          ? truncatePreview(outcome.error, 500)
          : undefined;

      emit({
        type: 'tool_result',
        id: callId,
        ok: outcome.ok,
        ...(resultPreview !== undefined ? { resultPreview } : {}),
        ...(errorPreview !== undefined ? { error: errorPreview } : {}),
        durationMs,
      });

      pushStep({
        i: steps.length + 1,
        kind: 'tool',
        title: this.toolTitle(toolSlug),
        detail: decision.thought,
        tool: toolSlug,
        args,
        ok: outcome.ok,
        ...(resultPreview !== undefined ? { resultPreview } : {}),
        ...(errorPreview !== undefined ? { error: errorPreview } : {}),
        ts: Date.now(),
      });

      const feedback = outcome.ok
        ? `Result of ${toolSlug} (ok): ${truncatePreview(outcome.resultPreview ?? '', RESULT_FEEDBACK_CHAR_CAP)}`
        : `Error from ${toolSlug} (failed): ${truncatePreview(outcome.error ?? 'tool_failed', RESULT_FEEDBACK_CHAR_CAP)}`;
      messages.push({ role: 'user', content: feedback });
    }

    // Stopped early → return whatever partial answer we have (or a note).
    if (stopped) {
      const partial =
        answer ??
        (steps.length
          ? this.synthesizeAnswer(steps as HermesStep[], dryRun)
          : 'Stopped before completing the task.');
      return { steps, answer: partial, stopped: true };
    }

    // No final answer yet (cap hit / planner gap): stream a forced final turn.
    emit({ type: 'status', phase: 'finalizing', label: 'Finalizing' });

    if (answer === null) {
      const forced = await this.streamFinalAnswer(
        emit,
        writer,
        [
          ...messages,
          {
            role: 'user',
            content:
              'You have reached the step limit. Reply now in plain language, summarizing what you did or what the user should do next. No JSON, no tool calls.',
          },
        ]
      );
      answer =
        forced ?? this.synthesizeAnswer(steps as HermesStep[], dryRun);
      return { steps, answer, stopped: false };
    }

    // We DO have a final answer from a planner `final` action — re-voice it as a
    // clean natural-language turn streamed token-by-token (the planner's `final`
    // JSON answer is already plain text, so stream it directly if the polish
    // call is unavailable). This gives the FE live typing on the answer.
    const polished = await this.streamFinalAnswer(
      emit,
      writer,
      [
        {
          role: 'system',
          content:
            'You are HERMES, an operations assistant. Rewrite the assistant\'s final answer below as a clear, friendly, plain-language reply for the user. Keep all facts; do not invent new ones. No JSON, no markdown fences.',
        },
        { role: 'user', content: answer },
      ],
      answer
    );
    return { steps, answer: polished ?? answer, stopped: false };
  }

  /**
   * Stream a FINAL natural-language answer from cdz-flash with `stream:true`,
   * emitting each delta as a `token` event (the exact SSE-token consumer from
   * RECON-STREAMING §2 / clickdz-bridge streamCdzChat). Returns the full
   * accumulated text, or `fallback` (streamed as one token if provided) when
   * upstream is unavailable — so the FE always sees the answer typed out.
   * NEVER throws; never logs key material.
   */
  private async streamFinalAnswer(
    emit: (ev: AgentEvent) => void,
    writer: { closed: boolean },
    messages: Array<{ role: string; content: string }>,
    fallback?: string
  ): Promise<string | null> {
    // No key → can't stream. Emit the fallback as a single token so the FE still
    // renders an answer (honest degrade, not a stub).
    if (!CDZ_AI_KEY) {
      if (fallback) emit({ type: 'token', text: fallback });
      return fallback ?? null;
    }

    let response: globalThis.Response;
    try {
      response = await this.fetchWithTimeout(
        CDZ_PLANNER_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CDZ_AI_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model: CDZ_PLANNER_MODEL,
            messages,
            stream: true,
            max_tokens: PLANNER_MAX_TOKENS,
            temperature: 0.2,
          }),
        },
        HERMES_FINAL_STREAM_TIMEOUT_MS
      );
    } catch {
      if (fallback) emit({ type: 'token', text: fallback });
      return fallback ?? null;
    }

    if (!response.ok || !response.body) {
      this.logger.warn(
        `[hermes] final stream non-ok (${response.status}) [POST ${CDZ_PLANNER_PATH}]`
      );
      if (fallback) emit({ type: 'token', text: fallback });
      return fallback ?? null;
    }

    // ---- SSE-token consumer (async-iterate the body, split on \n\n, read
    // `data:` payloads, handle [DONE] / finish_reason, forward delta.content).
    const decoder = new TextDecoder();
    let buffer = '';
    let acc = '';
    let finished = false;
    let sawAny = false;
    try {
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (writer.closed) break;
        buffer += decoder.decode(bytes, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of rawEvent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            if (payload === '[DONE]') {
              finished = true;
              break;
            }
            try {
              const parsed = JSON.parse(payload) as {
                choices?: Array<{
                  delta?: { content?: unknown };
                  finish_reason?: string | null;
                }>;
              };
              const choice = parsed.choices?.[0];
              const text = choice?.delta?.content;
              if (typeof text === 'string' && text) {
                sawAny = true;
                acc += text;
                emit({ type: 'token', text });
              }
              if (choice?.finish_reason) finished = true;
            } catch {
              // partial frame; the next chunk completes it
            }
          }
          if (finished) break;
        }
        if (finished) break;
      }
    } catch (err) {
      // Mid-stream failure. If we already emitted tokens, keep them; else fall
      // back so the FE isn't left with a blank answer.
      this.logger.warn(
        `[hermes] final stream read error: ${(err as Error)?.message ?? err}`
      );
    }

    if (!sawAny) {
      if (fallback) emit({ type: 'token', text: fallback });
      return fallback ?? null;
    }
    return acc;
  }

  /** A short, human summary of a consequential call for the approval prompt. */
  private approvalSummary(
    toolSlug: string,
    args: Record<string, unknown>
  ): string {
    if (toolSlug === 'composio_execute') {
      const tool = typeof args.tool === 'string' ? args.tool : '(unknown tool)';
      return `Run the Composio action ${tool} on your connected account. This may send or write real data.`;
    }
    if (toolSlug === 'make_agent_run') {
      const which = typeof args.agent === 'string' ? args.agent : 'default';
      return `Trigger the Make.com "${which}" agent, which may run automation scenarios.`;
    }
    return `Run ${toolSlug}, which performs a write/send action.`;
  }

  /** Human title for a tool (used on tool_call + step cards). */
  private toolTitle(toolSlug: string): string {
    const found = buildToolCatalog().find(t => t.slug === toolSlug);
    return found ? found.label : toolSlug;
  }

  /** Per-surface timeout for the streaming loop (no shrinking wall clock). */
  private toolTimeout(toolSlug: string): number {
    switch (toolSlug) {
      case 'composio_discover':
        return HERMES_COMPOSIO_DISCOVER_TIMEOUT_MS;
      case 'composio_execute':
        return HERMES_COMPOSIO_EXECUTE_TIMEOUT_MS;
      case 'make_agent_run':
        return HERMES_MAKE_TIMEOUT_MS;
      default:
        // internal Redis reads are fast; give them the planner-ish budget.
        return HERMES_PLANNER_TIMEOUT_MS;
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/hermes/stop {threadId} → cooperative stop (checked each loop
  // iteration by an in-flight stream). Idempotent; always 200 {ok:true}.
  // -------------------------------------------------------------------------
  @Throttle('default')
  @Post('/api/v1/hermes/stop')
  async stop(
    @CurrentUser() _user: CurrentUser,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ ok: boolean }> {
    const threadId =
      typeof body?.threadId === 'string' ? body.threadId.trim() : '';
    if (!threadId) {
      res.status(400).json({ ok: false, error: 'threadId is required' });
      return { ok: false };
    }
    await this.runtime.requestStop(threadId);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/hermes/approve {threadId, approvalId, decision} → resolve a
  // pending approval_request. The in-flight stream's awaitApproval consumes it.
  // decision is 'approve' | 'deny'. Always 200 {ok:true} on a valid shape.
  // -------------------------------------------------------------------------
  @Throttle('default')
  @Post('/api/v1/hermes/approve')
  async approve(
    @CurrentUser() _user: CurrentUser,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ ok: boolean }> {
    const threadId =
      typeof body?.threadId === 'string' ? body.threadId.trim() : '';
    const approvalId =
      typeof body?.approvalId === 'string' ? body.approvalId.trim() : '';
    const decision = body?.decision === 'approve' ? 'approve' : 'deny';
    if (!threadId || !approvalId) {
      res
        .status(400)
        .json({ ok: false, error: 'threadId and approvalId are required' });
      return { ok: false };
    }
    await this.runtime.resolveApproval(threadId, approvalId, decision);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Thread CRUD (runtime-owned Redis persistence, per-user scoped).
  //   GET    /api/v1/hermes/threads        → AgentThreadSummary[]
  //   GET    /api/v1/hermes/threads/:id    → AgentThread (full, w/ messages)
  //   PATCH  /api/v1/hermes/threads/:id    {title} → renamed AgentThreadSummary
  //   DELETE /api/v1/hermes/threads/:id    → {ok:true}
  // All auth via @CurrentUser (cookie session). Typed 404/400 for missing
  // threads / bad input via @Res passthrough — NEVER a raw HttpException.
  // -------------------------------------------------------------------------
  @Throttle('default')
  @Get('/api/v1/hermes/threads')
  async listThreads(
    @CurrentUser() user: CurrentUser
  ): Promise<AgentThreadSummary[]> {
    return this.runtime.listThreads(user.id, 'hermes');
  }

  @Throttle('default')
  @Get('/api/v1/hermes/threads/:id')
  async getThread(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string
  ): Promise<AgentThread> {
    const thread = await this.runtime.getThread(user.id, id);
    if (!thread || thread.agent !== 'hermes') {
      throw new NotFound(`thread "${id}" not found`);
    }
    return thread;
  }

  @Throttle('default')
  @Patch('/api/v1/hermes/threads/:id')
  async renameThread(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ): Promise<AgentThreadSummary | { ok: false; error: string }> {
    const title =
      typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > HERMES_TITLE_MAX) {
      res.status(400).json({
        ok: false,
        error: `"title" must be a string of 1..${HERMES_TITLE_MAX} chars`,
      });
      return { ok: false, error: 'invalid_title' };
    }
    const existing = await this.runtime.getThread(user.id, id);
    if (!existing || existing.agent !== 'hermes') {
      throw new NotFound(`thread "${id}" not found`);
    }
    await this.runtime.renameThread(user.id, id, title);
    const summaries = await this.runtime.listThreads(user.id, 'hermes');
    const updated = summaries.find(s => s.id === id);
    return (
      updated ?? {
        id,
        agent: 'hermes',
        title,
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
        messageCount: existing.messages.length,
      }
    );
  }

  @Throttle('default')
  @Delete('/api/v1/hermes/threads/:id')
  async deleteThread(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string
  ): Promise<{ ok: boolean }> {
    // Best-effort stop of any in-flight run on this thread, then delete.
    await this.runtime.requestStop(id);
    await this.runtime.deleteThread(user.id, id);
    return { ok: true };
  }

  // ---- /run internals -----------------------------------------------------

  /**
   * Compose the planner system prompt from the tool block (+ dry-run note).
   *
   * R8/WSA-10: `memoryBlock` is the SINGLE point where the agent's long-term
   * memory is injected into the planner prompt — the one shared assembly
   * function every loop (legacy /run, streaming /stream, detached run) routes
   * its system prompt through. It is appended verbatim AFTER the base prompt
   * when non-empty; buildMemoryPromptBlock returns '' when memory is OFF or
   * empty, so the DEFAULT ('' — nothing passed, or the flag off) yields a
   * BYTE-IDENTICAL prompt to today. Pure + sync (the async read happens once in
   * hermesMemoryBlock and is threaded in as this ready string).
   */
  private buildPlannerSystemPrompt(
    toolBlock: string,
    dryRun: boolean,
    memoryBlock: string = ''
  ): string {
    const tools =
      toolBlock || '(no tools are currently available — answer from reasoning alone)';
    const base = [
      "You are HERMES, ClickDz's autonomous operations agent. You accomplish the",
      "user's GOAL by calling the available tools below, one at a time, observing",
      'each result before deciding the next step.',
      '',
      'AVAILABLE TOOLS (slug: what it does + arguments shape):',
      tools,
      '',
      'RESPOND WITH JSON ONLY — no prose, no markdown, no code fences. Exactly one of:',
      '  {"action":"call","thought":"<why this step, one short sentence>","tool":"<slug>","arguments":{ ...tool inputs... }}',
      '  {"action":"final","answer":"<plain-language answer for the user>"}',
      '',
      'Rules:',
      '- Use ONLY the exact tool slugs listed above. NEVER invent a tool.',
      '- Put every argument the tool needs inside "arguments".',
      '- Prefer internal reads (shops_list, shop_erp_summary) for questions about',
      "  the user's own shops and business data.",
      '- For external services (email, sheets, github, slack…): composio_discover',
      '  the toolkit first when unsure of the exact tool slug, then composio_execute.',
      '- If a tool fails because a connected account is missing (auth / not',
      '  connected), STOP and finish with {"action":"final","answer":"..."} telling',
      '  the user to connect that toolkit first on the Integrations page.',
      `- You have at most ${HERMES_MAX_ITERATIONS} tool calls. Be economical.`,
      '- When you have enough to answer, finish with a "final" action.',
      ...(dryRun
        ? [
            '',
            'DRY-RUN MODE: no tool will actually execute. Emit the calls you WOULD',
            'make (they are recorded as the plan), then finish with a "final" answer',
            'describing the intended plan. Never claim real results.',
          ]
        : []),
    ].join('\n');
    // R8/WSA-10: append the agent's memory block when present. Empty ('' — the
    // default / memory OFF) leaves `base` untouched, so the prompt is
    // byte-identical to today.
    return memoryBlock ? `${base}\n\n${memoryBlock}` : base;
  }

  /**
   * R8/WSA-10: read + render this user's Hermes memory as the FR-framed prompt
   * block that buildPlannerSystemPrompt appends. The ONE place the async memory
   * read happens; every loop threads its return in. Fully fail-soft + gated:
   * returns '' immediately when memory is OFF (no Redis touch), and swallows any
   * store/parse hiccup — a memory problem must NEVER break or slow a run. The
   * agent is always 'hermes' in this controller.
   */
  private async hermesMemoryBlock(userId: string): Promise<string> {
    if (!memoryEnabled()) return '';
    try {
      const mem = await readAgentMemory(this.redis, userId, 'hermes');
      return buildMemoryPromptBlock(mem);
    } catch {
      return '';
    }
  }

  /**
   * One planner turn against cdz-flash (direct CDZ_AI, OpenAI-compatible). The
   * timeout is min(configured, remaining wall-clock). Returns {raw} on a clean
   * 2xx with string content, or null on ANY failure (no key, non-2xx, timeout,
   * empty) so the caller can decide 502-vs-synthesize. Never throws; never logs
   * key material.
   */
  private async callPlanner(
    messages: Array<{ role: string; content: string }>,
    remainingMs: number
  ): Promise<{ raw: string } | null> {
    if (!CDZ_AI_KEY) {
      return null;
    }
    // Lazy, once-only: surface the resolved planner base+path (NO key) so a
    // future 404/misconfig self-diagnoses from a single log line.
    if (!this.plannerUrlLogged) {
      this.plannerUrlLogged = true;
      this.logger.log(
        `[hermes] planner resolved: base=${CDZ_AI_BASE_URL} path=${CDZ_PLANNER_PATH} model=${CDZ_PLANNER_MODEL}`
      );
    }
    const timeoutMs = Math.max(
      1,
      Math.min(HERMES_PLANNER_TIMEOUT_MS, remainingMs)
    );
    try {
      const response = await this.fetchWithTimeout(
        CDZ_PLANNER_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CDZ_AI_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: CDZ_PLANNER_MODEL,
            messages,
            max_tokens: PLANNER_MAX_TOKENS,
            temperature: 0.1,
          }),
        },
        timeoutMs
      );
      const data = (await response.json().catch(() => null)) as any;
      const content = data?.choices?.[0]?.message?.content;
      if (response.ok && typeof content === 'string' && content.trim()) {
        return { raw: content };
      }
      // Include upstream status + the exact path we hit so the next incident is
      // self-diagnosing (e.g. a 404 vs a 401, and against which path segment).
      this.logger.warn(
        `[hermes] planner non-ok (${response.status}) or empty content [POST ${CDZ_PLANNER_PATH}]`
      );
      return null;
    } catch (err) {
      this.logger.warn(
        `[hermes] planner call failed: ${(err as Error)?.message ?? err}`
      );
      return null;
    }
  }

  /**
   * Dispatch one HERMES tool call. ALWAYS returns a ToolOutcome — failures are
   * captured as ok:false outcomes whose error text is fed back to the model so
   * the loop can recover. Never throws.
   */
  private async executeTool(
    toolSlug: string,
    args: Record<string, unknown>,
    userId: string,
    remainingMs: number
  ): Promise<ToolOutcome> {
    try {
      switch (toolSlug) {
        case 'shops_list':
          return await this.toolShopsList(userId);
        case 'shop_erp_summary':
          return await this.toolShopErpSummary(userId, args);
        case 'composio_discover':
          return await this.toolComposioDiscover(args, remainingMs);
        case 'composio_execute':
          return await this.toolComposioExecute(args, userId, remainingMs);
        case 'make_agent_run':
          return await this.toolMakeAgentRun(args, remainingMs);
        default:
          return { ok: false, error: `unknown tool "${toolSlug}"` };
      }
    } catch (err) {
      const detail = (err as Error)?.message ?? 'tool_execute_failed';
      this.logger.warn(`[hermes] execute ${toolSlug} threw: ${detail}`);
      return { ok: false, error: detail };
    }
  }

  // =========================================================================
  // R6/WSA-2 — REGISTRY BRIDGE. The catalog + dispatch route through Regis's
  // ClickDzToolRegistry. The hermes-specific tools are wrapped as AgentToolDefs
  // that DELEGATE to the private tool methods above, so behavior/args/results
  // are IDENTICAL to the legacy switch. The registry also carries the built-in
  // web tools (Regis), which stay unavailable unless CDZ_AGENT_WEB_ENABLED.
  // =========================================================================

  /**
   * The hermes-specific tool defs (`extraTools` for buildDefaultRegistry). Each
   * def mirrors ONE entry of `buildToolCatalog()` (same slug/description/args
   * hint/consequential/availability gate) and its `run()` delegates to the
   * existing `executeTool` switch — so a call through the registry is
   * byte-for-byte the same as the legacy direct call. The per-call remaining
   * wall-clock budget is threaded on the dispatch ctx (`__remainingMs`), set by
   * `dispatchTool` right before dispatch; absent (e.g. a direct registry call)
   * it falls back to the per-surface timeout.
   */
  private buildHermesToolDefs(): AgentToolDef[] {
    const catalog = buildToolCatalog();
    const byslug = (slug: string): HermesTool =>
      catalog.find(t => t.slug === slug) as HermesTool;
    // Availability predicates mirror buildToolCatalog() EXACTLY (env-derived).
    const composioOn = (): boolean => !!COMPOSIO_API_KEY;
    const makeOn = (): boolean => !!(MAKE_API_KEY && MAKE_TEAM_ID && MAKE_AGENT_ID);
    const avail: Record<string, () => boolean> = {
      shops_list: () => true,
      shop_erp_summary: () => true,
      composio_discover: composioOn,
      composio_execute: composioOn,
      make_agent_run: makeOn,
    };
    const mk = (slug: string): AgentToolDef => {
      const t = byslug(slug);
      return {
        name: slug,
        description: t.description,
        scope: 'hermes',
        consequential: t.consequential,
        inputSummary: t.argsHint,
        available: () => avail[slug](),
        run: async (args: Record<string, unknown>, ctx: AgentToolCtx) => {
          const rem =
            typeof (ctx as HermesDispatchCtx).__remainingMs === 'number'
              ? (ctx as HermesDispatchCtx).__remainingMs
              : this.toolTimeout(slug);
          const outcome = await this.executeTool(slug, args, ctx.userId, rem);
          return {
            ok: outcome.ok,
            result: outcome,
            preview:
              outcome.resultPreview !== undefined
                ? outcome.resultPreview
                : outcome.error,
          };
        },
      };
    };
    return [
      mk('shops_list'),
      mk('shop_erp_summary'),
      mk('composio_discover'),
      mk('composio_execute'),
      mk('make_agent_run'),
    ];
  }

  /**
   * Route a single tool call through the shared registry and NORMALIZE the
   * envelope back to the legacy `ToolOutcome` the plan→act loops consume.
   *
   * For the hermes-specific slugs the registry def returns the ORIGINAL
   * ToolOutcome as `result`, so we return it verbatim (byte-identical to the
   * legacy `executeTool` call these two loops used before). For the built-in
   * web tools (only reachable when CDZ_AGENT_WEB_ENABLED) we synthesize a
   * ToolOutcome from the envelope. `dispatch` never throws (Regis contract), so
   * this never throws either.
   */
  private async dispatchTool(
    toolSlug: string,
    args: Record<string, unknown>,
    userId: string,
    remainingMs: number
  ): Promise<ToolOutcome> {
    const ctx: HermesDispatchCtx = {
      userId,
      agent: 'hermes',
      log: (m: string) => this.logger.warn(`[hermes] ${m}`),
      services: { redis: this.redis, config: this.config },
      __remainingMs: remainingMs,
    };
    const res = await this.registry.dispatch(toolSlug, args, ctx);
    // Hermes tools hand back the ToolOutcome as `result` — return it as-is.
    if (isHermesSlug(toolSlug)) {
      const r = res.result as ToolOutcome | undefined;
      if (r && typeof r === 'object' && typeof r.ok === 'boolean') {
        return r;
      }
      // Defensive fallback (a def should always return the outcome).
      return res.ok
        ? { ok: true, resultPreview: res.preview ?? '' }
        : { ok: false, error: res.preview ?? 'tool_failed' };
    }
    // Web / other registry tools: build a ToolOutcome from the envelope.
    if (res.ok) {
      return {
        ok: true,
        resultPreview:
          res.result !== undefined
            ? truncatePreview(res.result)
            : (res.preview ?? ''),
      };
    }
    return {
      ok: false,
      error:
        res.preview ??
        (typeof (res.result as any)?.error === 'string'
          ? (res.result as any).error
          : 'tool_failed'),
    };
  }

  /**
   * The extra planner-prompt lines + known-slug set for any NON-legacy registry
   * tools currently available for this user (the first-party web tools, gated
   * by CDZ_AGENT_WEB_ENABLED + exa key; plus any fail-soft telegram_send behind
   * its own flag). Rendered in the SAME `- slug: desc arguments: hint` shape as
   * `buildToolBlock`. When nothing extra is available (the default — every new
   * gate off) this returns an EMPTY block and empty set, so the composed prompt
   * and guard set are byte-identical to today. Never throws.
   */
  private webTools(userId: string): { block: string; slugs: Set<string> } {
    const slugs = new Set<string>();
    const lines: string[] = [];
    try {
      const ctx: AgentToolCtx = {
        userId,
        agent: 'hermes',
        log: () => {},
        services: { redis: this.redis, config: this.config },
      };
      for (const def of this.registry.listFor(ctx)) {
        if (isHermesSlug(def.name)) continue; // legacy tools already in the block
        slugs.add(def.name);
        lines.push(
          `- ${def.name}: ${def.description} arguments: ${def.inputSummary ?? '{}'}`
        );
      }
    } catch {
      return { block: '', slugs: new Set<string>() };
    }
    return { block: lines.length ? `\n${lines.join('\n')}` : '', slugs };
  }

  // =========================================================================
  // R6/WSA-2 — DETACHED PLAN→ACT CORE (Moteur seam). Registered via
  // registerAgentLoop('hermes', …) in the constructor (behind CDZ_AGENTS_ENABLED)
  // so `copilot.agent.run` jobs drive the SAME cdz-flash plan→act logic as the
  // request-scoped /stream route — but decoupled from any SSE socket. It emits
  // through Moteur's `ctx.emit` (durably buffered + live-forwarded), records the
  // step trail via `ctx.recordStep`, charges the tool-call budget via
  // `ctx.chargeToolCall`, and honors the wall-clock/stop `ctx.signal`. Runs in
  // 'auto' mode (a background run has no live user to approve). Returns the final
  // answer text; the engine persists state/finalText + fires the completion hook.
  // NEVER throws out (a throw would only mark the run failed) — but we keep the
  // same defensive posture as the streaming loop.
  // =========================================================================
  private async runHermesLoop(
    ctx: AgentLoopContext,
    rec: AgentRunRecord
  ): Promise<string> {
    const userId = rec.userId;
    const emit = ctx.emit;

    const catalog = buildToolCatalog();
    const knownSlugs = new Set(catalog.filter(t => t.available).map(t => t.slug));
    // R8/WSA-11: consequential-tool slugs (same derivation as runStreamingLoop),
    // used by the deferral guard below. Empty-effect when deferConsequential is
    // false (web/telegram runs), so a non-scheduled run is unaffected.
    const consequentialSlugs = new Set(
      catalog.filter(t => t.consequential).map(t => t.slug)
    );
    const web = this.webTools(userId);
    for (const slug of web.slugs) knownSlugs.add(slug);
    // R8/WSA-10: prime the prompt with the agent's memory ('' when OFF/empty ⇒
    // byte-identical). Single async read, injected at the one shared assembler.
    const memBlock = await this.hermesMemoryBlock(userId);
    // R12 (custom agents): prepend the custom agent's persona to the planner
    // system prompt when this run carries one (ctx.persona is set only for a
    // custom agent — a built-in run leaves it undefined ⇒ BYTE-IDENTICAL prompt).
    const systemPrompt =
      (ctx.persona ? `Tu es un agent personnalisé. ${ctx.persona}\n\n` : '') +
      this.buildPlannerSystemPrompt(
        buildToolBlock(catalog) + web.block,
        false,
        memBlock
      );

    // Seed context: system + any prior thread turns (multi-turn continuity when
    // the run is bound to a thread) + the run's prompt. Rehydration is best-
    // effort/fail-soft (Redis is a cache).
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];
    let thread: AgentThread | null = null;
    if (rec.threadId) {
      try {
        thread = await this.runtime.getThread(userId, rec.threadId);
      } catch {
        thread = null;
      }
    }
    if (thread) {
      for (const m of thread.messages) {
        if (m.role === 'user' || m.role === 'assistant') {
          messages.push({ role: m.role, content: m.content });
        }
      }
    }
    // Ensure the run's prompt is the last user turn (avoid a duplicate if the
    // thread already ends with it).
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || last.content !== rec.prompt) {
      messages.push({ role: 'user', content: rec.prompt });
    }

    const steps: AgentStep[] = [];
    let iterations = 0;
    let answer: string | null = null;
    let stopped = false;

    // A step recorder that mirrors the streaming loop's `pushStep` but routes
    // through Moteur's recordStep (persists on the run record + emits `step`).
    const pushStep = async (step: {
      kind: AgentStep['kind'];
      tool?: string;
      detail?: string;
      ok?: boolean;
      resultPreview?: string;
      error?: string;
    }) => {
      steps.push({
        i: steps.length + 1,
        kind: step.kind,
        title: step.tool ? this.toolTitle(step.tool) : step.kind,
        detail: step.detail,
        tool: step.tool,
        ok: step.ok,
        ...(step.resultPreview !== undefined
          ? { resultPreview: step.resultPreview }
          : {}),
        ...(step.error !== undefined ? { error: step.error } : {}),
        ts: Date.now(),
      });
      await ctx.recordStep({
        kind: step.kind === 'tool' ? 'tool' : 'plan',
        tool: step.tool,
        argsPreview: step.detail,
        ok: step.ok,
        preview:
          step.resultPreview !== undefined ? step.resultPreview : step.error,
      });
    };

    emit({ type: 'status', phase: 'planning', label: 'Planning' });

    while (iterations < HERMES_STREAM_MAX_ITERATIONS) {
      if (await ctx.isStopped()) {
        stopped = true;
        break;
      }

      const planned = await this.callPlanner(
        messages,
        HERMES_STREAM_PLANNER_TIMEOUT_MS
      );

      if (planned === null) {
        if (steps.length === 0) {
          emit({ type: 'status', phase: 'error', label: 'Planner unavailable' });
          answer =
            "I couldn't reach the planner just now, so I didn't run anything. Please try again in a moment.";
          break;
        }
        answer = this.synthesizeAnswer(steps as HermesStep[], false);
        break;
      }

      messages.push({ role: 'assistant', content: planned.raw });
      const decision = parsePlannerJson(planned.raw);

      if (decision.action === 'final') {
        answer = decision.answer ?? '';
        break;
      }

      const toolSlug = decision.tool ?? '';
      const args = decision.arguments ?? {};

      if (!knownSlugs.has(toolSlug)) {
        iterations++;
        await pushStep({
          kind: 'tool',
          tool: toolSlug,
          detail: decision.thought,
          ok: false,
          error: 'unknown_or_unavailable_tool',
        });
        messages.push({
          role: 'user',
          content: `Tool "${toolSlug}" is not in the available tools. Choose one of the listed tool slugs, or finish with {"action":"final","answer":"..."}.`,
        });
        continue;
      }

      // Charge the tool-call budget BEFORE executing (Moteur enforces the cap).
      const charge = await ctx.chargeToolCall();
      if (!charge.allowed) {
        await pushStep({
          kind: 'tool',
          tool: toolSlug,
          detail: decision.thought,
          ok: false,
          error: 'tool_budget_exhausted',
        });
        break;
      }

      iterations++;

      // R8/WSA-11: DEFER a consequential tool on an UNSUPERVISED run. A run
      // started by a schedule/webhook trigger (deferConsequential(rec) → true;
      // false for web/telegram interactive runs, so this is a no-op today and
      // whenever triggers are off) has no live human to approve a write/send, so
      // we DO NOT execute it. Instead we record a deferred step (the planner sees
      // it as a failed result and can plan around it or finish) and fire a
      // fail-soft Telegram ping to the owner. The run continues.
      if (consequentialSlugs.has(toolSlug) && deferConsequential(rec)) {
        await pushStep({
          kind: 'tool',
          tool: toolSlug,
          detail: decision.thought,
          ok: false,
          resultPreview:
            '⏸ Différé — approbation requise (exécution non surveillée)',
        });
        await this.pingDeferredTool(userId, toolSlug);
        messages.push({
          role: 'user',
          content: `The call to ${toolSlug} was DEFERRED: this is an unattended (scheduled/webhook) run, so no write/send tool can execute without approval. Do NOT retry it. Continue with a different approach, or finish with {"action":"final","answer":"..."} noting what still needs the user's approval.`,
        });
        continue;
      }

      // Background runs execute in 'auto' mode (no live approver) — consequential
      // tools run without a gate, exactly like /run and /stream in 'auto'.
      const callId = randomUUID();
      const startedAt = Date.now();
      emit({
        type: 'tool_call',
        id: callId,
        tool: toolSlug,
        title: this.toolTitle(toolSlug),
        args,
      });

      const outcome = await this.dispatchTool(
        toolSlug,
        args,
        userId,
        this.toolTimeout(toolSlug)
      );
      const durationMs = Date.now() - startedAt;

      const resultPreview =
        outcome.resultPreview !== undefined
          ? truncatePreview(outcome.resultPreview)
          : undefined;
      const errorPreview =
        outcome.error !== undefined
          ? truncatePreview(outcome.error, 500)
          : undefined;

      emit({
        type: 'tool_result',
        id: callId,
        ok: outcome.ok,
        ...(resultPreview !== undefined ? { resultPreview } : {}),
        ...(errorPreview !== undefined ? { error: errorPreview } : {}),
        durationMs,
      });

      await pushStep({
        kind: 'tool',
        tool: toolSlug,
        detail: decision.thought,
        ok: outcome.ok,
        ...(resultPreview !== undefined ? { resultPreview } : {}),
        ...(errorPreview !== undefined ? { error: errorPreview } : {}),
      });

      const feedback = outcome.ok
        ? `Result of ${toolSlug} (ok): ${truncatePreview(outcome.resultPreview ?? '', RESULT_FEEDBACK_CHAR_CAP)}`
        : `Error from ${toolSlug} (failed): ${truncatePreview(outcome.error ?? 'tool_failed', RESULT_FEEDBACK_CHAR_CAP)}`;
      messages.push({ role: 'user', content: feedback });
    }

    if (stopped) {
      const partial =
        answer ??
        (steps.length
          ? this.synthesizeAnswer(steps as HermesStep[], false)
          : 'Stopped before completing the task.');
      await this.persistAssistantTurn(userId, thread, partial, steps);
      return partial;
    }

    emit({ type: 'status', phase: 'finalizing', label: 'Finalizing' });

    // A small writer shim so streamFinalAnswer can reuse its exact token-stream
    // path: `closed` tracks the run's abort signal (wall-clock / stop).
    const shim = {
      get closed() {
        return ctx.signal.aborted;
      },
    };

    if (answer === null) {
      const forced = await this.streamFinalAnswer(
        emit,
        shim,
        [
          ...messages,
          {
            role: 'user',
            content:
              'You have reached the step limit. Reply now in plain language, summarizing what you did or what the user should do next. No JSON, no tool calls.',
          },
        ]
      );
      answer = forced ?? this.synthesizeAnswer(steps as HermesStep[], false);
      await this.persistAssistantTurn(userId, thread, answer, steps);
      return answer;
    }

    const polished = await this.streamFinalAnswer(
      emit,
      shim,
      [
        {
          role: 'system',
          content:
            'You are HERMES, an operations assistant. Rewrite the assistant\'s final answer below as a clear, friendly, plain-language reply for the user. Keep all facts; do not invent new ones. No JSON, no markdown fences.',
        },
        { role: 'user', content: answer },
      ],
      answer
    );
    const finalText = polished ?? answer;
    await this.persistAssistantTurn(userId, thread, finalText, steps);
    return finalText;
  }

  /**
   * Best-effort persistence of the background run's assistant turn onto its
   * thread, so a later /stream on the same thread has multi-turn context and the
   * console shows the run in thread history. Fail-soft: Redis is a cache and the
   * run record (owned by Moteur) is the source of truth for a background run.
   */
  private async persistAssistantTurn(
    userId: string,
    thread: AgentThread | null,
    answer: string,
    steps: AgentStep[]
  ): Promise<void> {
    if (!thread) return;
    try {
      const assistantMsg: AgentMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: answer,
        steps,
        createdAt: Date.now(),
        agent: 'hermes',
      };
      thread.messages.push(assistantMsg);
      await this.runtime.saveThread(userId, thread);
    } catch {
      /* fail-soft — the run record still holds the answer */
    }
  }

  /**
   * R8/WSA-11: notify the run owner over Telegram that a consequential tool was
   * DEFERRED on their unattended run. Fully fail-soft + dark by default: the
   * TelegramClient no-ops (zero network) when CDZ_TG_TOKEN is absent, and an
   * unpaired user simply has no bound chat. Dynamic-imported (like other
   * cross-module hooks) so it adds no static edge; the owner-chat binding is
   * read via the JSON Cache under Telegramme's documented
   * `clickdz:tg:user:{userId}` namespace (mirrored here the same way this file
   * mirrors the bridge/data keys). NEVER throws.
   */
  private async pingDeferredTool(userId: string, toolSlug: string): Promise<void> {
    try {
      const bind = await this.cache.get<{ chatId?: number | string }>(
        `clickdz:tg:user:${userId}`
      );
      const chatId = bind?.chatId;
      if (chatId == null) return;
      const { TelegramClient } = await import('./clickdz-agent-telegram');
      await new TelegramClient().sendMessage(
        chatId,
        `⏸ HERMES a différé une action (${toolSlug}) lors d'une exécution automatique non surveillée. Ouvrez l'agent pour l'approuver.`
      );
    } catch {
      /* fail-soft — a deferral ping must never surface to the run */
    }
  }

  // ---- internal read tools (same Redis data the bridge/data API expose) ----

  /** Read + defensively parse the caller's published-app records. */
  private async readPublishedApps(
    ownerId: string
  ): Promise<PublishedAppRecord[]> {
    const raw = await this.redis.smembers(publishedAppsKey(ownerId));
    if (!Array.isArray(raw)) return [];
    const out: PublishedAppRecord[] = [];
    for (const entry of raw) {
      try {
        const rec = JSON.parse(entry) as PublishedAppRecord;
        if (rec && typeof rec.slug === 'string') {
          const kind =
            rec.kind === 'shop' || rec.kind === 'erp' || rec.kind === 'app'
              ? rec.kind
              : undefined;
          const storeSlug =
            typeof rec.storeSlug === 'string' && rec.storeSlug
              ? rec.storeSlug
              : undefined;
          out.push({
            slug: rec.slug,
            url: typeof rec.url === 'string' ? rec.url : '',
            createdAt:
              typeof rec.createdAt === 'string'
                ? rec.createdAt
                : new Date().toISOString(),
            ...(kind ? { kind } : {}),
            ...(storeSlug ? { storeSlug } : {}),
          });
        }
      } catch {
        // ignore a corrupt member — mirrors the bridge's lazy pruning stance
      }
    }
    return out;
  }

  /** Read one (slug, collection) app-data hash, newest-first (data API model). */
  private async readCollection(
    slug: string,
    collection: string
  ): Promise<Array<Record<string, unknown>>> {
    const raw = await this.redis.hgetall(appDataKey(slug, collection));
    const records: Array<Record<string, unknown>> = [];
    for (const value of Object.values(raw ?? {})) {
      try {
        const rec = JSON.parse(value) as Record<string, unknown>;
        if (rec && typeof rec === 'object') records.push(rec);
      } catch {
        // skip corrupt entries
      }
    }
    records.sort((a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
    );
    return records;
  }

  /** shops_list — the caller's published apps. */
  private async toolShopsList(userId: string): Promise<ToolOutcome> {
    const records = await this.readPublishedApps(userId);
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (records.length === 0) {
      return {
        ok: true,
        resultPreview:
          'The user has no published apps/shops yet. They can create one from the ClickDz Apps builder (shop/ERP templates).',
      };
    }
    return {
      ok: true,
      resultPreview: JSON.stringify({
        count: records.length,
        apps: records.map(r => ({
          slug: r.slug,
          url: r.url,
          kind: r.kind ?? 'app',
          ...(r.storeSlug ? { storeSlug: r.storeSlug } : {}),
          createdAt: r.createdAt,
        })),
      }),
    };
  }

  /**
   * shop_erp_summary — compact KPIs computed from the shop/ERP shared
   * datastore (orders/products/expenses/settings collections — the exact data
   * the @Public data API serves and the ERP dashboard renders). Ownership is
   * enforced: the slug must be one of the CALLER's published apps. A paired
   * ERP reads its shop's datastore via storeSlug (shop + ERP share one store).
   */
  private async toolShopErpSummary(
    userId: string,
    args: Record<string, unknown>
  ): Promise<ToolOutcome> {
    const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
    if (!APP_SLUG_RE.test(slug)) {
      return {
        ok: false,
        error:
          'invalid "slug" — pass one of the slugs returned by shops_list (lowercase letters, digits, dashes)',
      };
    }
    const records = await this.readPublishedApps(userId);
    const record = records.find(r => r.slug === slug);
    if (!record) {
      return {
        ok: false,
        error: `slug "${slug}" is not one of the user's published apps — call shops_list for valid slugs`,
      };
    }
    // Paired ERP records carry the shop's storeSlug — that is where the data lives.
    const dataSlug =
      record.storeSlug && APP_SLUG_RE.test(record.storeSlug)
        ? record.storeSlug
        : record.slug;

    const [orders, products, expenses, settingsRows] = await Promise.all([
      this.readCollection(dataSlug, 'orders'),
      this.readCollection(dataSlug, 'products'),
      this.readCollection(dataSlug, 'expenses'),
      this.readCollection(dataSlug, 'settings'),
    ]);
    const settings = settingsRows[0] ?? null;

    const month = new Date().toISOString().slice(0, 7);
    const ordersByStatus: Record<string, number> = {};
    for (const s of ORDER_STATUSES) ordersByStatus[s] = 0;
    let revenueMonth = 0;
    let pendingCount = 0;
    let deliveredTotal = 0;
    let deliveredCount = 0;
    for (const o of orders) {
      const status = String(o.status ?? '');
      if (ordersByStatus[status] != null) ordersByStatus[status]++;
      const t = orderTotal(o);
      if (status === 'Livrée') {
        deliveredTotal += t;
        deliveredCount++;
        if (orderDate(o).slice(0, 7) === month) revenueMonth += t;
      }
      if (status === 'Nouvelle' || status === 'Confirmée') pendingCount++;
    }
    let expensesMonth = 0;
    for (const x of expenses) {
      if (orderDate(x).slice(0, 7) === month) {
        expensesMonth += num(x.montant != null ? x.montant : x.amount);
      }
    }
    const lowStock = products.filter(
      p => p.reorderAt != null && num(p.stock) <= num(p.reorderAt)
    );

    const summary = {
      slug: record.slug,
      dataSlug,
      kind: record.kind ?? 'app',
      shopName:
        settings && typeof settings.shopName === 'string'
          ? settings.shopName
          : null,
      currency: 'DZD',
      kpis: {
        revenueMonth: Math.round(revenueMonth),
        pendingCount,
        avgBasket: deliveredCount
          ? Math.round(deliveredTotal / deliveredCount)
          : 0,
        expensesMonth: Math.round(expensesMonth),
        margin: Math.round(revenueMonth - expensesMonth),
        lowStockCount: lowStock.length,
        ordersTotal: orders.length,
        productsCount: products.length,
      },
      ordersByStatus,
      lowStock: lowStock.slice(0, 5).map(p => ({
        name: String(p.name ?? p.title ?? ''),
        sku: String(p.sku ?? ''),
        stock: num(p.stock),
        reorderAt: num(p.reorderAt),
      })),
      recentOrders: orders.slice(0, 5).map(o => ({
        id: String(o.id ?? ''),
        customer: String(o.customer ?? ''),
        status: String(o.status ?? ''),
        total: Math.round(orderTotal(o)),
        date: orderDate(o),
      })),
    };
    return { ok: true, resultPreview: JSON.stringify(summary) };
  }

  // ---- Composio tools (same idioms as the integrations controller) ---------

  /** composio_discover — GET api/v3/tools?toolkit_slug=<slug> (x-api-key). */
  private async toolComposioDiscover(
    args: Record<string, unknown>,
    remainingMs: number
  ): Promise<ToolOutcome> {
    if (!COMPOSIO_API_KEY) {
      return { ok: false, error: 'composio_not_configured' };
    }
    const toolkit =
      typeof args.toolkit === 'string' ? args.toolkit.trim().toLowerCase() : '';
    if (!toolkit) {
      return { ok: false, error: 'missing "toolkit" argument' };
    }
    const timeoutMs = Math.max(
      1,
      Math.min(HERMES_COMPOSIO_DISCOVER_TIMEOUT_MS, remainingMs)
    );
    const url = `${COMPOSIO_TOOLS_URL}?toolkit_slug=${encodeURIComponent(
      toolkit
    )}&limit=${DISCOVER_TOOLS_LIMIT}`;
    const response = await this.fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          'x-api-key': COMPOSIO_API_KEY,
          Accept: 'application/json',
        },
      },
      timeoutMs
    );
    if (!response.ok) {
      this.logger.warn(
        `[hermes] composio discover ${toolkit} HTTP ${response.status}`
      );
      return {
        ok: false,
        error: `composio tool discovery for "${toolkit}" responded ${response.status}`,
      };
    }
    const data: any = await response.json().catch(() => ({}));
    const lines: string[] = [];
    for (const raw of extractToolList(data)) {
      const slug =
        typeof raw?.slug === 'string'
          ? raw.slug
          : typeof raw?.name === 'string'
            ? raw.name
            : typeof raw?.key === 'string'
              ? raw.key
              : null;
      if (!slug) continue;
      const desc = String(
        raw?.description ?? raw?.meta?.description ?? ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
      const params = raw?.input_parameters ?? raw?.parameters ?? null;
      const required: string[] = Array.isArray(params?.required)
        ? params.required.filter((x: any) => typeof x === 'string')
        : [];
      const reqStr = required.length
        ? ` [required: ${required.join(', ')}]`
        : '';
      lines.push(`${slug}: ${desc}${reqStr}`);
      if (lines.length >= DISCOVER_TOOLS_LIMIT) break;
    }
    if (lines.length === 0) {
      return {
        ok: false,
        error: `no Composio tools found for toolkit "${toolkit}" — check the toolkit slug`,
      };
    }
    return {
      ok: true,
      resultPreview: `Tools in toolkit "${toolkit}" (execute with composio_execute):\n${lines.join('\n')}`,
    };
  }

  /** composio_execute — POST api/v3/tools/execute/<slug> {user_id, arguments}. */
  private async toolComposioExecute(
    args: Record<string, unknown>,
    userId: string,
    remainingMs: number
  ): Promise<ToolOutcome> {
    if (!COMPOSIO_API_KEY) {
      return { ok: false, error: 'composio_not_configured' };
    }
    const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
    if (!COMPOSIO_TOOL_SLUG_RE.test(tool)) {
      return {
        ok: false,
        error:
          'invalid "tool" — pass the exact Composio tool slug (e.g. GMAIL_SEND_EMAIL); use composio_discover to find it',
      };
    }
    const toolArgs =
      args.arguments &&
      typeof args.arguments === 'object' &&
      !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : {};
    const timeoutMs = Math.max(
      1,
      Math.min(HERMES_COMPOSIO_EXECUTE_TIMEOUT_MS, remainingMs)
    );
    const response = await this.fetchWithTimeout(
      `${COMPOSIO_TOOLS_EXECUTE_URL}/${encodeURIComponent(tool)}`,
      {
        method: 'POST',
        headers: {
          'x-api-key': COMPOSIO_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        // user_id is the ClickDz user id — the SAME per-user scoping the
        // integrations controller's connect + execute paths use.
        body: JSON.stringify({ user_id: userId, arguments: toolArgs }),
      },
      timeoutMs
    );
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail =
        typeof data?.error?.message === 'string'
          ? data.error.message
          : typeof data?.error === 'string'
            ? data.error
            : typeof data?.message === 'string'
              ? data.message
              : `composio responded ${response.status}`;
      return { ok: false, error: detail };
    }
    // Composio wraps successful output in {data}/{response_data} on some
    // tools; surface whatever is there, truncated by the caller.
    const payload = data?.data ?? data?.response_data ?? data;
    return { ok: true, resultPreview: truncatePreview(payload) };
  }

  // ---- Make.com tool --------------------------------------------------------

  /**
   * make_agent_run — trigger a Make.com AI agent (bridge runMakeAgent idiom:
   * POST {base}/ai-agents/v1/agents/{id}/run?teamId=…, Token auth, buffered).
   * Optional args.agent picks a specialist id when that env is configured.
   */
  private async toolMakeAgentRun(
    args: Record<string, unknown>,
    remainingMs: number
  ): Promise<ToolOutcome> {
    if (!MAKE_API_KEY || !MAKE_TEAM_ID || !MAKE_AGENT_ID) {
      return { ok: false, error: 'make_not_configured' };
    }
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) {
      return { ok: false, error: 'missing "prompt" argument' };
    }
    const which = typeof args.agent === 'string' ? args.agent.trim() : 'default';
    const agentId =
      (which === 'code' && MAKE_CODE_AGENT_ID) ||
      (which === 'builder' && MAKE_BUILDER_AGENT_ID) ||
      (which === 'arabic' && MAKE_ARABIC_AGENT_ID) ||
      MAKE_AGENT_ID;
    const timeoutMs = Math.max(1, Math.min(HERMES_MAKE_TIMEOUT_MS, remainingMs));
    const response = await this.fetchWithTimeout(
      `${MAKE_API_BASE}/ai-agents/v1/agents/${agentId}/run?teamId=${MAKE_TEAM_ID}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${MAKE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt.slice(0, 12_000) }],
          config: {},
        }),
      },
      timeoutMs
    );
    if (!response.ok) {
      this.logger.warn(`[hermes] make agent HTTP ${response.status}`);
      return {
        ok: false,
        error: `Make.com agent failed: ${response.status} ${response.statusText}`,
      };
    }
    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const reply = extractMakeReply(data?.response ?? data);
    if (!reply) {
      return { ok: false, error: 'Make.com agent returned an empty reply' };
    }
    return { ok: true, resultPreview: reply };
  }

  /** Deterministic fallback answer when the planner can't produce a final one. */
  private synthesizeAnswer(steps: HermesStep[], dryRun: boolean): string {
    if (steps.length === 0) {
      return "I couldn't complete the goal — the planner became unavailable and no tools ran. Please try again in a moment.";
    }
    const okCount = steps.filter(s => s.ok).length;
    const parts = steps.map(
      s => `${s.tool ?? 'step'}: ${s.ok ? 'ok' : 'failed'}`
    );
    const mode = dryRun ? 'planned (dry-run)' : 'ran';
    return `I ${mode} ${steps.length} step(s) (${okCount} ok): ${parts.join(
      '; '
    )}. Reached the step/time limit before a final summary — review the step timeline for details.`;
  }
}
