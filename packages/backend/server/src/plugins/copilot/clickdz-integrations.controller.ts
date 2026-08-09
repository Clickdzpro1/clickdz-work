import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

import { CurrentUser } from '../../core/auth';
// Typed errors from ../../base (raw HttpException is coerced to a generic 500
// by AFFiNE's GlobalExceptionFilter — see base/nestjs/exception.ts mapAnyError).
// For the contract's non-standard status + typed-body responses (409 / 502)
// we therefore write them directly via the injected Express Response
// (@Res()), exactly like ClickDzBridgeController's chatCompletions/tts routes.
// BadRequest stays available for genuinely malformed input (typed 400);
// NotFound for a missing flow/run (typed 404). `Cache` is the @Global
// JSON-wrapped Redis provider (get<T>/set with a PX ttl + map/list ops —
// fail-soft: undefined/false/[] on any error, never throws) — the SAME
// provider ClickDzHermesController persists its per-user config through
// (hermesConfigKey idiom). Flows/runs/DLQ are persisted per-user through it.
import { BadRequest, Cache, NotFound, Throttle } from '../../base';

// P3 — Social studio backend: shared service + job (scheduler).
import {
  ClickDzSocialService,
  SOCIAL_TEXT_MAX,
  SOCIAL_TARGETS_MAX,
  SOCIAL_MEDIA_MAX,
  SOCIAL_SCHEDULE_MAX_AHEAD_MS,
  SOCIAL_NETWORKS,
  SOCIAL_ACTIONS,
} from './clickdz-social.service';
import type { SocialPost, PublishedLogEntry } from './clickdz-social.service';
import { ClickDzSocialJob } from './clickdz-social.job';
import { CopilotStorage } from './storage';

// SECURITY / CONFIG: the ONE switch. Without COMPOSIO_API_KEY every enabled
// code path below is unreachable — the controller reports {enabled:false} and
// never calls Composio. Read once at module load (same idiom as the bridge's
// VERCEL_TOKEN / DEEPGRAM_API_KEY module-level env reads).
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || '';

// Composio public REST surface (plain fetch — NO SDK dependency).
// C4 FIX — the 24-cap is GONE. This is the BARE toolkits endpoint; the paged
// route below appends `?limit=&cursor=&search=&category=` as needed so the UI
// can browse the FULL ~250+ toolkit catalog with search + category filters +
// pagination, instead of the first 24.
const COMPOSIO_TOOLKITS_URL = 'https://backend.composio.dev/api/v3/toolkits';
// Connected accounts (list) — used to cheaply mark toolkits already connected
// for the current user so the grid can badge them (best-effort, soft-fail).
const COMPOSIO_CONNECTED_ACCOUNTS_URL =
  'https://backend.composio.dev/api/v3/connected_accounts';
// Auth-link session (returns a hosted redirect_url the user opens to connect).
const COMPOSIO_LINK_URL =
  'https://backend.composio.dev/api/v3.1/connected_accounts/link';
// Tool discovery (per-toolkit) + execution — the /run orchestrator surface.
const COMPOSIO_TOOLS_URL = 'https://backend.composio.dev/api/v3/tools';
const COMPOSIO_TOOLS_EXECUTE_URL =
  'https://backend.composio.dev/api/v3/tools/execute';
// Auth configs (per-toolkit blueprint the hosted auth-link session requires).
// Composio v3 rejects `connected_accounts/link` with "Auth config not found"
// until a toolkit has at least one auth config; we GET (filter by toolkit_slug)
// then POST a Composio-managed one on demand (see connect()).
const COMPOSIO_AUTH_CONFIGS_URL =
  'https://backend.composio.dev/api/v3/auth_configs';

const COMPOSIO_TIMEOUT_MS = 8_000;
// C4 — toolkit catalog paging budgets. One page per request (the UI drives
// pagination / infinite-scroll via nextCursor), so the request stays cheap and
// well under the timeout even for the full catalog. The catalog fetch gets its
// own slightly larger budget than the default 8s.
const TOOLKITS_CATALOG_TIMEOUT_MS = 12_000;
const TOOLKITS_PAGE_DEFAULT = 50; // sane page size the UI can override (?limit=)
const TOOLKITS_PAGE_MAX = 100; // hard ceiling per page to bound payload size
const TOOLKITS_SEARCH_MAX = 200; // clamp untrusted ?search= length
const TOOLKITS_CATEGORY_MAX = 100; // clamp untrusted ?category= length
const TOOLKITS_CURSOR_MAX = 512; // clamp untrusted ?cursor= length
// Cheap "connected?" enrichment: cap how many connected accounts we scan so a
// user with many connections never blows the request budget.
const CONNECTED_ACCOUNTS_SCAN_LIMIT = 200;

// --- CDZ_AI direct-path envs (mirrors clickdz-bridge.controller.ts:179-193 &
// conversation/compact.ts). The OpenAI-compatible `cdz-flash` catalog served by
// CDZ_AI_BASE_URL is the planner brain for the /run tool loop. ---
//
// ROOT CAUSE of the prod `planner non-ok (404)` (2026-07-18): the ONE CDZ_AI
// env present in prod is CDZ_AI_BASE_URL (CDZ_AI_URL is absent — never existed).
// The copilot provider bootstrap (scripts/cdz-ai-config.mjs) treats
// CDZ_AI_BASE_URL as an OpenAI `baseURL` that ALREADY carries the `/v1` version
// segment (its own default is `https://api.clickdz.ai/v1`), and that is the
// value the operator set in prod. This controller then appended a SECOND
// `/v1/chat/completions`, producing `…/v1/v1/chat/completions` → 404. We
// normalize by stripping a trailing `/v1` (and any trailing slashes) so the
// origin is clean whether the operator set it WITH or WITHOUT `/v1`, then append
// the single canonical path below — the exact effective URL the working
// bridge/compact/pulse/vdz callers hit. Absent env still defaults to the bare
// host, preserving today's behavior; the replace() chain never crashes at
// import.
const CDZ_AI_BASE_URL = (process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '')
  .replace(/\/+$/, '');
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';
const CDZ_PLANNER_MODEL = process.env.CDZ_PLANNER_MODEL || 'cdz-flash';
// The single canonical OpenAI-compatible endpoint path — the SAME segment the
// working cdz-flash callers hit: normalized `${CDZ_AI_BASE_URL}` + this. Kept as
// consts so the resolved base+path is logged once and the URL is built in
// exactly one place.
const CDZ_PLANNER_PATH = '/v1/chat/completions';
const CDZ_PLANNER_URL = `${CDZ_AI_BASE_URL}${CDZ_PLANNER_PATH}`;

// --- /run orchestrator budgets (AbortControllers everywhere) ---
// Per-toolkit tool discovery timeout, per-planner-call timeout, per-execute
// timeout, and a total wall-clock cap for the whole loop.
const RUN_TOOLS_TIMEOUT_MS = 8_000;
const RUN_PLANNER_TIMEOUT_MS = 10_000;
const RUN_EXECUTE_TIMEOUT_MS = 20_000;
const RUN_WALL_CLOCK_MS = 75_000;
// Hard iteration cap on tool CALLS (not counting the terminal final turn).
const RUN_MAX_ITERATIONS = 4;
// Prompt/response budgets.
const RUN_MAX_TOOLKITS = 5;
const RUN_TOOLS_PER_TOOLKIT = 25;
const RUN_PROMPT_MIN = 1;
const RUN_PROMPT_MAX = 4_000;
const CONDENSED_TOOLS_CHAR_CAP = 6_000;
const STEP_PREVIEW_CHAR_CAP = 2_000;
const RESULT_FEEDBACK_CHAR_CAP = 2_000;
const PLANNER_MAX_TOKENS = 700;

// --- /social/compose (cdz-flash content drafting) budgets (WS9) ---
// A single cdz-flash turn that drafts/rewrites social post copy — NO tool loop,
// NO Composio, just the OpenAI-compatible planner. The FE then sends the
// approved text through /api/v1/integrations/run for per-user posting, so the
// per-user Composio isolation model is untouched by this route.
const COMPOSE_BRIEF_MIN = 1;
const COMPOSE_BRIEF_MAX = 2_000;
const COMPOSE_TIMEOUT_MS = 12_000;

// ---------------------------------------------------------------------------
// C2/C3 — Flows (persisted graph) + run observability + retry/backoff/DLQ.
// All persisted per-user through the @Global JSON `Cache` provider. Keys are
// ALWAYS namespaced by the authenticated `user.id` (never a body-supplied id).
// ---------------------------------------------------------------------------

// Per-user persistence keys (mirrors hermesConfigKey(userId) namespacing).
const flowKey = (userId: string, flowId: string) =>
  `clickdz:flow:${userId}:${flowId}`;
const flowIndexKey = (userId: string) => `clickdz:flowindex:${userId}`;
const flowRunKey = (userId: string, runId: string) =>
  `clickdz:flowrun:${userId}:${runId}`;
const flowRunIndexKey = (userId: string) => `clickdz:flowrunindex:${userId}`;
const flowDlqKey = (userId: string) => `clickdz:flowdlq:${userId}`;

// TTLs are in MILLISECONDS (CacheProvider.set uses PX). Sliding — refreshed on
// each PUT (flow) / write (run). Flows live ~90d; runs ~30d.
const FLOW_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const FLOW_RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Caps.
const FLOW_NAME_MAX = 120;
const FLOW_NODES_MAX = 50;
const FLOW_EDGES_MAX = 200;
const FLOW_CONFIG_BYTES_MAX = 8_192; // bound a node's static config payload
const FLOW_RUN_INDEX_CAP = 50; // newest N run summaries retained per user
const FLOW_DLQ_CAP = 50; // newest N failed-run refs retained per user

// SYNC-bounded flow-run budgets: a per-node cap and a whole-run wall clock so a
// flow /run stays within the request lifecycle (like /run's RUN_WALL_CLOCK_MS).
const FLOW_NODE_TIMEOUT_MS = 20_000;
const FLOW_RUN_WALL_CLOCK_MS = 90_000;

// Retry / full-jitter backoff (C3).
const RETRY_MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500; // 500 → 1000 → 2000 → 4000, capped at RETRY_CAP_MS
const RETRY_CAP_MS = 8_000;

interface FlowNode {
  id: string;
  type: 'trigger' | 'action' | 'condition';
  toolkit?: string;
  action?: string;
  config?: Record<string, unknown>;
  x: number;
  y: number;
}

interface FlowEdge {
  id: string;
  from: string;
  to: string;
}

interface Flow {
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  createdAt: number;
  updatedAt: number;
}

// A summary row stored in the per-user flow index hash (id → summary).
interface FlowIndexEntry {
  name: string;
  updatedAt: number;
}

// One executed flow-run step (a superset of RunStep so the FE StepRow renders
// both timelines): adds nodeId/attempts/ms/status/error.
interface FlowRunStep {
  nodeId: string;
  tool: string;
  status: 'ok' | 'error' | 'retrying';
  attempts: number;
  ms: number;
  resultPreview: string;
  error?: string;
}

interface FlowRun {
  id: string;
  flowId: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'ok' | 'error' | 'partial';
  steps: FlowRunStep[];
}

// A compact run summary row stored in the per-user run index hash.
interface FlowRunSummary {
  id: string;
  flowId: string;
  startedAt: number;
  finishedAt?: number;
  status: FlowRun['status'];
  stepCount: number;
}

// A DLQ entry stored in the per-user DLQ hash (runId → ref).
interface FlowDlqEntry {
  runId: string;
  flowId: string;
  failedNodeId?: string;
  startedAt: number;
  enqueuedAt: number;
}

// The numeric-status raw result of one Composio execute — what the retry
// classifier needs (executeTool swallows the HTTP status into a string).
interface RawExecuteResult {
  status: number; // HTTP status, or 0 for a network/abort error
  ok: boolean;
  preview: string; // truncated success payload OR error detail
  detail?: string; // error detail (when !ok)
}

interface CdzToolkit {
  slug: string;
  name: string;
  logo?: string;
  // C4 — richer catalog metadata (both optional; only set when the v3 payload
  // carries them / when we cheaply know the connection state).
  categories?: string[];
  connected?: boolean;
}

// A discovered, normalized Composio tool used by the /run planner.
interface CdzTool {
  slug: string;
  name: string;
  description: string;
  parameters: any;
}

// One executed loop step surfaced back to the client.
interface RunStep {
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  resultPreview: string;
}

// The planner's parsed single-turn decision (normalized, fail-closed).
interface PlannerDecision {
  action: 'call' | 'final';
  tool?: string;
  arguments?: Record<string, unknown>;
  answer?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (module-level, no `this`, no I/O) — unit-tested in isolation.
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
 * never crash on model noise.
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
  if (obj.action === 'call' && typeof obj.tool === 'string' && obj.tool.trim()) {
    const args =
      obj.arguments &&
      typeof obj.arguments === 'object' &&
      !Array.isArray(obj.arguments)
        ? (obj.arguments as Record<string, unknown>)
        : {};
    return { action: 'call', tool: obj.tool.trim(), arguments: args };
  }
  if (obj.action === 'final') {
    const answer =
      typeof obj.answer === 'string' && obj.answer.trim()
        ? obj.answer.trim()
        : text.trim();
    return { action: 'final', answer };
  }
  // Unknown/absent action -> treat the whole thing as a final answer.
  return { action: 'final', answer: text.trim() };
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
 * Defensively pull the array of TOOLKIT objects out of a Composio v3 toolkits
 * payload. v3 list responses vary — tolerate {items|toolkits|data|<array>} the
 * same way the tools/auth-config parsers do. (C4 catalog paging.)
 */
function extractToolkitList(data: any): any[] {
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.toolkits)) return data.toolkits;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data)) return data;
  return [];
}

/**
 * Defensively pull the NEXT-PAGE cursor out of a Composio v3 list payload,
 * tolerant of the several shapes the API has shipped: top-level
 * `next_cursor`/`nextCursor`/`cursor`, or nested under
 * `meta`/`pagination`/`page_info` (incl. camel/snake `next_cursor`). Returns a
 * non-empty string cursor or null (null → the UI stops paging). Never throws.
 */
function extractNextCursor(data: any): string | null {
  const pick = (v: any): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;
  const containers = [
    data,
    data?.meta,
    data?.pagination,
    data?.meta?.pagination,
    data?.page_info,
    data?.pageInfo,
  ];
  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    const cursor =
      pick(c.next_cursor) ??
      pick(c.nextCursor) ??
      pick(c.cursor) ??
      pick(c.next);
    if (cursor) return cursor;
  }
  return null;
}

/**
 * Defensively normalize a toolkit's categories into a string[] (or undefined).
 * v3 has shipped categories as `string[]`, `{name|slug}[]`, or a single string;
 * tolerate all. Deduped, capped, empty → undefined so the field is omitted.
 */
function extractCategories(t: any): string[] | undefined {
  const raw = t?.categories ?? t?.meta?.categories ?? t?.category;
  const out: string[] = [];
  const push = (v: any) => {
    const s =
      typeof v === 'string'
        ? v
        : typeof v?.name === 'string'
          ? v.name
          : typeof v?.slug === 'string'
            ? v.slug
            : '';
    const trimmed = s.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  if (Array.isArray(raw)) {
    for (const v of raw) push(v);
  } else if (raw) {
    push(raw);
  }
  return out.length ? out.slice(0, 12) : undefined;
}

/**
 * Map one raw Composio v3 toolkit object to a normalized CdzToolkit (or null).
 * Tolerant of slug/key/name id fallbacks and logo/meta.logo drift (mirrors the
 * inline mapping the toolkits route used before). `connected` is layered on by
 * the route from the connected-accounts set; categories come from the payload.
 */
function normalizeToolkit(t: any): CdzToolkit | null {
  const slug =
    typeof t?.slug === 'string'
      ? t.slug
      : typeof t?.key === 'string'
        ? t.key
        : typeof t?.name === 'string'
          ? t.name
          : null;
  if (!slug) return null;
  const name = typeof t?.name === 'string' && t.name.length ? t.name : slug;
  const logo =
    typeof t?.meta?.logo === 'string'
      ? t.meta.logo
      : typeof t?.logo === 'string'
        ? t.logo
        : undefined;
  const categories = extractCategories(t);
  const out: CdzToolkit = { slug, name };
  if (logo) out.logo = logo;
  if (categories) out.categories = categories;
  return out;
}

/**
 * Defensively pull the account's OWN user/entity id out of a Composio v3
 * connected-account object, tolerant of the field-name drift across versions
 * (`user_id`, `userId`, `entity_id`, `entityId`, nested `user.id`/`entity.id`).
 * Returns a trimmed string or ''. Used by the C1 defense-in-depth filter below.
 */
function extractAccountUserId(acct: any): string {
  const raw =
    typeof acct?.user_id === 'string'
      ? acct.user_id
      : typeof acct?.userId === 'string'
        ? acct.userId
        : typeof acct?.entity_id === 'string'
          ? acct.entity_id
          : typeof acct?.entityId === 'string'
            ? acct.entityId
            : typeof acct?.user?.id === 'string'
              ? acct.user.id
              : typeof acct?.entity?.id === 'string'
                ? acct.entity.id
                : '';
  return raw.trim();
}

/**
 * Defensively pull the set of connected toolkit slugs out of a Composio v3
 * connected_accounts list payload so the catalog can badge `connected:true`.
 * Each account references its toolkit under one of several keys across API
 * versions (`toolkit_slug`, `toolkit.slug`, `app_name`, `appName`, `toolkit`
 * as a bare string). Lower-cased for case-insensitive matching. Never throws.
 *
 * C1 DEFENSE-IN-DEPTH (WS17): when `callerUserId` is provided, keep ONLY
 * accounts whose OWN user/entity id equals the caller's `user.id`. Even if a
 * future Composio param rename silently reverts the `user_ids` query filter to
 * an unfiltered project-wide list, the badge stays correct — the isolation
 * invariant is enforced client-of-Composio-side, not merely trusted. Accounts
 * whose user id is unreadable (field drift) are excluded when a caller id is
 * given — fail closed to "not mine" rather than risk a cross-user badge. When
 * `callerUserId` is omitted the historical unfiltered behavior is preserved.
 */
function extractConnectedSlugs(
  data: any,
  callerUserId?: string
): Set<string> {
  const slugs = new Set<string>();
  const list = extractToolkitList(data); // same container shapes (items|data|…)
  const caller = typeof callerUserId === 'string' ? callerUserId.trim() : '';
  for (const acct of list) {
    // Defense-in-depth: drop accounts that are not the caller's own.
    if (caller && extractAccountUserId(acct) !== caller) continue;
    const raw =
      typeof acct?.toolkit_slug === 'string'
        ? acct.toolkit_slug
        : typeof acct?.toolkit?.slug === 'string'
          ? acct.toolkit.slug
          : typeof acct?.app_name === 'string'
            ? acct.app_name
            : typeof acct?.appName === 'string'
              ? acct.appName
              : typeof acct?.toolkit === 'string'
                ? acct.toolkit
                : '';
    const s = raw.trim().toLowerCase();
    if (s) slugs.add(s);
  }
  return slugs;
}

/**
 * Defensively pull an auth config id out of BOTH Composio v3 auth_configs
 * shapes: the LIST response ({items|data|auth_configs:[{id}]} or a bare array)
 * and the CREATE response (nested {auth_config:{id}} or flat {id}). Returns the
 * first non-empty string id, or null. Mirrors the tolerant items|data parsing
 * the controller already uses for tools.
 */
function extractAuthConfigId(data: any): string | null {
  const pickId = (obj: any): string | null =>
    obj && typeof obj.id === 'string' && obj.id.length ? obj.id : null;
  // Create response: {auth_config:{id}} or flat {id}.
  const nested = pickId(data?.auth_config);
  if (nested) return nested;
  const flat = pickId(data);
  if (flat) return flat;
  // List response: first item's id across the tolerated container keys.
  const list: any[] = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.auth_configs)
        ? data.auth_configs
        : Array.isArray(data)
          ? data
          : [];
  for (const item of list) {
    const id = pickId(item);
    if (id) return id;
  }
  return null;
}

/** Map one raw Composio tool object to a normalized CdzTool (or null). */
function normalizeTool(t: any): CdzTool | null {
  const slug =
    typeof t?.slug === 'string'
      ? t.slug
      : typeof t?.name === 'string'
        ? t.name
        : typeof t?.key === 'string'
          ? t.key
          : null;
  if (!slug) return null;
  const name = typeof t?.name === 'string' && t.name.length ? t.name : slug;
  const description =
    typeof t?.description === 'string'
      ? t.description
      : typeof t?.meta?.description === 'string'
        ? t.meta.description
        : '';
  const parameters =
    t?.input_parameters ?? t?.parameters ?? t?.inputParameters ?? null;
  return { slug, name, description, parameters };
}

/**
 * Condense tool schemas into a compact, char-capped block for the planner
 * system prompt: slug + short description + the list of REQUIRED param names
 * only. Never exceeds `cap` total chars.
 */
function condenseToolSchemas(
  tools: CdzTool[],
  cap: number = CONDENSED_TOOLS_CHAR_CAP
): string {
  const lines: string[] = [];
  let used = 0;
  for (const tool of tools) {
    const required: string[] = Array.isArray(tool.parameters?.required)
      ? tool.parameters.required.filter((x: any) => typeof x === 'string')
      : [];
    const desc = (tool.description || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    const reqStr = required.length ? ` [required: ${required.join(', ')}]` : '';
    const line = `- ${tool.slug}: ${desc}${reqStr}`;
    if (used + line.length + 1 > cap) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
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

// ---------------------------------------------------------------------------
// C2/C3 pure helpers (module-level, no `this`, no I/O).
// ---------------------------------------------------------------------------

/** Promise-based sleep (used by the full-jitter retry backoff). */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Retry classifier: a Composio execute failure is TRANSIENT (worth retrying)
 * for 408 (timeout), 429 (rate limit), any 5xx, or a network/abort error
 * (status 0). Every other 4xx (400/401/403/404/409/422 …) is PERMANENT →
 * fail fast (mirrors the /run planner rule that tells the user to connect the
 * toolkit rather than hammering a not-connected/auth error).
 */
function isTransientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * Full-jitter exponential backoff delay for a given (1-based) attempt number:
 * base * 2^(attempt-1), capped, then a uniform random in [0, cap]. Bounded by
 * `remainingMs` at the call site so a retry never overruns the wall clock.
 */
function fullJitterBackoffMs(attempt: number): number {
  const exp = RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exp, RETRY_CAP_MS);
  return Math.floor(Math.random() * capped);
}

/**
 * Kahn topological sort of a flow graph. Returns node ids in a dependency-safe
 * order, or null if the graph has a cycle (the caller maps null → typed 400
 * {error:'flow_has_cycle'}). Edges referencing unknown node ids are ignored
 * (defensive — a stale edge never corrupts the ordering). Deterministic:
 * initial roots and each layer preserve the node array order.
 */
function topoSortFlow(nodes: FlowNode[], edges: FlowEdge[]): string[] | null {
  const ids = nodes.map(n => n.id);
  const idSet = new Set(ids);
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    adj.set(id, []);
  }
  for (const e of edges) {
    if (!e || !idSet.has(e.from) || !idSet.has(e.to)) continue;
    // Guard against duplicate edges inflating indegree past its real fan-in.
    const outs = adj.get(e.from)!;
    if (outs.includes(e.to)) continue;
    outs.push(e.to);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }
  // Seed the queue with indegree-0 nodes IN NODE-ARRAY ORDER (stable output).
  const queue: string[] = ids.filter(id => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return order.length === ids.length ? order : null; // shorter ⇒ cycle
}

/** Compute the direct upstream (predecessor) node ids of `nodeId`. */
function upstreamNodeIds(nodeId: string, edges: FlowEdge[]): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if (e && e.to === nodeId && typeof e.from === 'string') out.push(e.from);
  }
  return out;
}

/**
 * Normalize + validate an untrusted Flow body for a PUT upsert. Enforces the
 * caps (name<=120, nodes<=50, edges<=200, per-node config byte budget) and
 * coerces every field to the pinned shape. Returns {flow} on success or
 * {error} with a machine string the route maps to a typed 400. Never throws.
 * `id`/timestamps are assigned by the route, not trusted from the body.
 */
function normalizeFlowInput(
  body: any
): { flow: Omit<Flow, 'id' | 'createdAt' | 'updatedAt'> } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'invalid_flow' };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > FLOW_NAME_MAX) return { error: 'invalid_name' };

  const rawNodes = Array.isArray(body.nodes) ? body.nodes : [];
  if (rawNodes.length > FLOW_NODES_MAX) return { error: 'too_many_nodes' };
  const rawEdges = Array.isArray(body.edges) ? body.edges : [];
  if (rawEdges.length > FLOW_EDGES_MAX) return { error: 'too_many_edges' };

  const nodes: FlowNode[] = [];
  const nodeIds = new Set<string>();
  for (const n of rawNodes) {
    if (!n || typeof n !== 'object') return { error: 'invalid_node' };
    const id = typeof n.id === 'string' ? n.id.trim() : '';
    if (!id || nodeIds.has(id)) return { error: 'invalid_node_id' };
    const type =
      n.type === 'trigger' || n.type === 'action' || n.type === 'condition'
        ? n.type
        : null;
    if (!type) return { error: 'invalid_node_type' };
    const node: FlowNode = {
      id,
      type,
      x: Number.isFinite(n.x) ? Number(n.x) : 0,
      y: Number.isFinite(n.y) ? Number(n.y) : 0,
    };
    if (typeof n.toolkit === 'string' && n.toolkit.trim())
      node.toolkit = n.toolkit.trim();
    if (typeof n.action === 'string' && n.action.trim())
      node.action = n.action.trim();
    if (n.config && typeof n.config === 'object' && !Array.isArray(n.config)) {
      // Bound the config payload so a single node can't blow the record budget.
      let bytes = 0;
      try {
        bytes = JSON.stringify(n.config).length;
      } catch {
        return { error: 'invalid_node_config' };
      }
      if (bytes > FLOW_CONFIG_BYTES_MAX) return { error: 'node_config_too_big' };
      node.config = n.config as Record<string, unknown>;
    }
    nodes.push(node);
    nodeIds.add(id);
  }

  const edges: FlowEdge[] = [];
  const edgePairs = new Set<string>();
  for (const e of rawEdges) {
    if (!e || typeof e !== 'object') return { error: 'invalid_edge' };
    const from = typeof e.from === 'string' ? e.from.trim() : '';
    const to = typeof e.to === 'string' ? e.to.trim() : '';
    if (!from || !to) return { error: 'invalid_edge' };
    // Edges must reference declared nodes (no dangling refs persisted).
    if (!nodeIds.has(from) || !nodeIds.has(to)) return { error: 'edge_dangling' };
    const pair = JSON.stringify([from, to]);
    if (edgePairs.has(pair)) continue; // dedupe
    edgePairs.add(pair);
    const id =
      typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `${from}-${to}`;
    edges.push({ id, from, to });
  }

  return { flow: { name, nodes, edges } };
}

/**
 * Substitute `${nodeId.path}` / `${nodeId}` tokens inside a node's static
 * config against the accumulated upstream outputs, plus a convenience
 * `${previous}` alias for the single direct-predecessor output (the simple
 * {previous} context the contract asks for). Non-matching tokens are left
 * verbatim. Pure — deep-clones so the stored flow config is never mutated.
 */
function resolveNodeArgs(
  config: Record<string, unknown> | undefined,
  outputs: Map<string, unknown>,
  previous: unknown
): Record<string, unknown> {
  if (!config) return {};
  const readPath = (root: unknown, path: string): unknown => {
    if (!path) return root;
    let cur: any = root;
    for (const seg of path.split('.')) {
      if (cur == null) return undefined;
      cur = cur[seg];
    }
    return cur;
  };
  const resolveToken = (expr: string): unknown => {
    const trimmed = expr.trim();
    if (trimmed === 'previous') return previous;
    if (trimmed.startsWith('previous.'))
      return readPath(previous, trimmed.slice('previous.'.length));
    const dot = trimmed.indexOf('.');
    const nodeId = dot === -1 ? trimmed : trimmed.slice(0, dot);
    const path = dot === -1 ? '' : trimmed.slice(dot + 1);
    if (!outputs.has(nodeId)) return undefined;
    return readPath(outputs.get(nodeId), path);
  };
  const walk = (val: unknown): unknown => {
    if (typeof val === 'string') {
      // Whole-string single token → return the raw (possibly non-string) value.
      const whole = /^\$\{([^}]+)\}$/.exec(val);
      if (whole) {
        const resolved = resolveToken(whole[1]);
        return resolved === undefined ? val : resolved;
      }
      // Otherwise interpolate tokens into the string.
      return val.replace(/\$\{([^}]+)\}/g, (m, expr) => {
        const resolved = resolveToken(String(expr));
        if (resolved === undefined) return m;
        return typeof resolved === 'string'
          ? resolved
          : (() => {
              try {
                return JSON.stringify(resolved);
              } catch {
                return String(resolved);
              }
            })();
      });
    }
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) out[k] = walk(v);
      return out;
    }
    return val;
  };
  return walk(config) as Record<string, unknown>;
}

/**
 * Evaluate a condition node against the accumulated outputs (+ the direct
 * predecessor's output as `previous`). Pure, no I/O. Supported (all optional
 * in `config`):
 *   { left:'${node.path}'|literal, op:'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|
 *     'truthy'|'falsy'|'contains'|'exists', right?:... }
 * Defaults to `truthy` on `left`. Unknown ops → false (fail closed: the branch
 * simply does not open). Returns whether downstream nodes should proceed.
 */
function evaluateCondition(
  config: Record<string, unknown> | undefined,
  outputs: Map<string, unknown>,
  previous: unknown
): boolean {
  const cfg = config ?? {};
  const resolveSide = (v: unknown): unknown => {
    const r = resolveNodeArgs({ v }, outputs, previous) as { v: unknown };
    return r.v;
  };
  const left = resolveSide((cfg as any).left);
  const op = typeof (cfg as any).op === 'string' ? (cfg as any).op : 'truthy';
  const right = resolveSide((cfg as any).right);
  const num = (x: unknown): number => Number(x);
  switch (op) {
    case 'truthy':
      return !!left;
    case 'falsy':
      return !left;
    case 'exists':
      return left !== undefined && left !== null;
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    case 'gt':
      return num(left) > num(right);
    case 'gte':
      return num(left) >= num(right);
    case 'lt':
      return num(left) < num(right);
    case 'lte':
      return num(left) <= num(right);
    case 'contains':
      if (typeof left === 'string')
        return left.includes(String(right ?? ''));
      if (Array.isArray(left)) return left.includes(right as never);
      return false;
    default:
      return false; // unknown op → gate stays closed
  }
}

/**
 * ClickDz Integrations (Composio) — DARK by default.
 *
 * Every behaviour is gated behind COMPOSIO_API_KEY. With no key the endpoints
 * answer {enabled:false} (200) and the frontend shows a friendly setup state;
 * NOTHING reaches Composio. All routes are auth'd (global AuthGuard requires a
 * signed-in cookie session — no @Public()), and cost/side-effecting routes are
 * rate-capped with @Throttle('strict'), mirroring the sibling controllers.
 */
@Controller()
export class ClickDzIntegrationsController {
  private readonly logger = new Logger(ClickDzIntegrationsController.name);

  // One-shot flag so the resolved planner base+path is logged the FIRST time a
  // planner call is actually attempted (lazy — never at import), never repeated.
  // Path only, no key material.
  private plannerUrlLogged = false;

  // C2/C3: the @Global JSON-wrapped Redis provider (get<T>/set with a PX ttl +
  // map/list ops) is injected for per-user flow/run/DLQ persistence. Constructor
  // DI works without a CopilotModule change because Cache is a @Global provider
  // (same as ClickDzHermesController). Fail-soft by contract — never throws.
  constructor(
    private readonly cache: Cache,
    // P3 — Social studio: service (shared publish logic) + job (scheduler).
    private readonly socialService: ClickDzSocialService,
    private readonly socialJob: ClickDzSocialJob,
    // WS17: CopilotStorage for the social media upload route — stores the
    // uploaded file and returns a PUBLIC /api/copilot/blob/... URL Composio's
    // servers can fetch (the blob GET route is @Public). Without this, social
    // posts with uploaded media used a browser-only blob: URL that Composio
    // can't reach, silently failing every media publish.
    private readonly copilotStorage: CopilotStorage
  ) {}

  /** Small helper: fetch with a hard AbortController timeout (default 8s). */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number = COMPOSIO_TIMEOUT_MS
  ): Promise<globalThis.Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET status — the single source of truth the UI polls first. */
  @Get('/api/v1/integrations/status')
  status(@CurrentUser() _user: CurrentUser, @Res() res: Response) {
    res.status(200).json({ enabled: !!COMPOSIO_API_KEY });
  }

  /**
   * GET toolkits — the FULL Composio catalog, paged (C4).
   *
   * The old 24-cap is gone (both `?limit=24` and `.slice(0,24)`). This route now
   * pages the live `api/v3/toolkits` endpoint so the UI can browse ALL ~250+
   * toolkits with search + category filters + pagination / infinite-scroll.
   *
   * Query params (all optional, all clamped — untrusted):
   *   - ?search=   free-text filter passed through to Composio (server-side).
   *   - ?category= category slug filter passed through to Composio.
   *   - ?cursor=   opaque next-page cursor returned by a previous call.
   *   - ?limit=    page size (default 50, hard max 100).
   *
   * Response:
   *   - disabled -> {enabled:false, toolkits:[]}
   *   - enabled  -> {enabled:true, toolkits:[{slug,name,logo?,categories?,
   *                  connected?}], nextCursor?}   (nextCursor omitted on last page)
   *   - any fetch/parse/timeout failure -> {enabled:true, toolkits:[],
   *     error:'composio_unreachable'} (never throws — the grid degrades softly).
   *
   * `connected` is a best-effort badge: we cheaply list the user's connected
   * accounts once and mark matching slugs. If that lookup fails we simply omit
   * the flag (the field is optional) — the catalog still renders.
   */
  @Throttle('strict')
  @Get('/api/v1/integrations/toolkits')
  async toolkits(
    @CurrentUser() user: CurrentUser,
    @Query() query: any,
    @Res() res: Response
  ) {
    if (!COMPOSIO_API_KEY) {
      res.status(200).json({ enabled: false, toolkits: [] });
      return;
    }

    // ---- parse + clamp untrusted query params ----
    const clampStr = (v: unknown, max: number): string =>
      typeof v === 'string' ? v.trim().slice(0, max) : '';
    const search = clampStr(query?.search ?? query?.q, TOOLKITS_SEARCH_MAX);
    const category = clampStr(query?.category, TOOLKITS_CATEGORY_MAX);
    const cursor = clampStr(query?.cursor, TOOLKITS_CURSOR_MAX);
    const limitRaw = Number.parseInt(String(query?.limit ?? ''), 10);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, TOOLKITS_PAGE_MAX)
        : TOOLKITS_PAGE_DEFAULT;

    // ---- build the paged v3 URL (params only added when present) ----
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    if (search) params.set('search', search);
    if (category) params.set('category', category);
    const url = `${COMPOSIO_TOOLKITS_URL}?${params.toString()}`;

    try {
      const response = await this.fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: {
            'x-api-key': COMPOSIO_API_KEY,
            Accept: 'application/json',
          },
        },
        TOOLKITS_CATALOG_TIMEOUT_MS
      );
      if (!response.ok) {
        this.logger.warn(`[integrations] toolkits HTTP ${response.status}`);
        res
          .status(200)
          .json({ enabled: true, toolkits: [], error: 'composio_unreachable' });
        return;
      }
      const data: any = await response.json();
      // Defensive extraction: the v3 payload is {items:[{slug,name,meta:{logo},
      // categories}], next_cursor?} but tolerate items/toolkits/data containers
      // and logo/meta.logo + cursor shape drift.
      const rawList = extractToolkitList(data);
      const toolkits: CdzToolkit[] = rawList
        .map(normalizeToolkit)
        .filter((t): t is CdzToolkit => t !== null);

      // Best-effort connected badges — never let this fail the catalog.
      const connectedSlugs = await this.fetchConnectedSlugs(user.id);
      if (connectedSlugs.size) {
        for (const tk of toolkits) {
          if (connectedSlugs.has(tk.slug.toLowerCase())) tk.connected = true;
        }
      }

      const nextCursor = extractNextCursor(data);
      const payload: {
        enabled: true;
        toolkits: CdzToolkit[];
        nextCursor?: string;
      } = { enabled: true, toolkits };
      if (nextCursor) payload.nextCursor = nextCursor;
      res.status(200).json(payload);
    } catch (err) {
      // Timeout (AbortError), DNS, TLS, JSON parse — all soft-fail.
      this.logger.warn(
        `[integrations] toolkits fetch failed: ${(err as Error)?.message ?? err}`
      );
      res
        .status(200)
        .json({ enabled: true, toolkits: [], error: 'composio_unreachable' });
    }
  }

  /**
   * Best-effort: list the current user's connected Composio accounts and return
   * the set of connected toolkit slugs (lower-cased) so the catalog can badge
   * `connected:true`. Soft-fail by contract — ANY error (no route, non-ok,
   * timeout, parse) returns an EMPTY set so the toolkits route still renders the
   * full catalog. Scans at most CONNECTED_ACCOUNTS_SCAN_LIMIT accounts.
   */
  private async fetchConnectedSlugs(userId: string): Promise<Set<string>> {
    try {
      const params = new URLSearchParams();
      // C1 CRITICAL ISOLATION FIX (WS17): Composio v3 `GET connected_accounts`
      // ONLY honors the ARRAY filter `user_ids`; the singular `user_id` is an
      // unrecognized param → SILENTLY IGNORED → the request degrades to "list
      // ALL connected accounts in the project" (cross-user disclosure leak).
      // Filter by the caller's user id via the array form so the badge reflects
      // ONLY this user's connections. (Write paths — initiateConnect /
      // executeTool — correctly send singular `user_id` in the POST body and are
      // left untouched.) `URLSearchParams` renders this as `user_ids=<uuid>`, a
      // valid single-element array filter; a mis-shaped param would soft-fail to
      // an EMPTY set (nothing badged — the safe direction), never re-leak.
      params.set('user_ids', userId);
      params.set('limit', String(CONNECTED_ACCOUNTS_SCAN_LIMIT));
      const response = await this.fetchWithTimeout(
        `${COMPOSIO_CONNECTED_ACCOUNTS_URL}?${params.toString()}`,
        {
          method: 'GET',
          headers: {
            'x-api-key': COMPOSIO_API_KEY,
            Accept: 'application/json',
          },
        }
      );
      if (!response.ok) {
        this.logger.warn(
          `[integrations] connected_accounts HTTP ${response.status}`
        );
        return new Set<string>();
      }
      const data: any = await response.json().catch(() => null);
      // C1 defense-in-depth: pass the caller's id so only their own accounts'
      // slugs survive even if the server-side `user_ids` filter ever regresses.
      return extractConnectedSlugs(data, userId);
    } catch (err) {
      this.logger.warn(
        `[integrations] connected_accounts fetch failed: ${(err as Error)?.message ?? err}`
      );
      return new Set<string>();
    }
  }

  /**
   * POST connect {toolkit, authConfigId?}.
   *  - disabled -> 409 {error:'not_configured'}
   *  - enabled  -> Composio v3.1 auth-link session; success returns {redirectUrl}.
   *
   * Composio v3 requires a per-toolkit AUTH CONFIG to exist before it will
   * initiate a connected account; without one, `connected_accounts/link` fails
   * with "Auth config not found" (the repeated 2026-07-18 prod error). So on
   * that specific failure (or when the caller passed no explicit auth config)
   * we GET the toolkit's auth configs, POST a Composio-managed one if none
   * exists, and retry initiate exactly ONCE. If it STILL fails we return a
   * passthrough {error:'toolkit_auth_unconfigured', toolkit} (502) so the UI can
   * point the owner at the Composio dashboard — never a raw HttpException, and
   * every other failure still collapses to the typed 502 {error:'composio_error'}.
   */
  @Throttle('strict')
  @Post('/api/v1/integrations/connect')
  async connect(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Res() res: Response
  ) {
    const toolkit = typeof body?.toolkit === 'string' ? body.toolkit.trim() : '';
    if (!toolkit) {
      // Genuinely malformed input -> typed 400 via ../../base (safe here).
      throw new BadRequest('"toolkit" is required');
    }

    if (!COMPOSIO_API_KEY) {
      res.status(409).json({ error: 'not_configured' });
      return;
    }

    // An explicit auth_config_id from the caller (rare) wins for the first
    // attempt. Otherwise we resolve/create one against the toolkit slug below.
    const explicitAuthConfigId =
      typeof body?.authConfigId === 'string' && body.authConfigId.length
        ? body.authConfigId
        : null;
    const callbackUrl =
      typeof body?.callbackUrl === 'string' && body.callbackUrl.length
        ? body.callbackUrl
        : undefined;
    // WS17: validate callbackUrl origin to prevent an open-redirect phishing
    // vector. The user-supplied URL is passed to Composio's OAuth redirect; an
    // attacker could set it to a malicious URL. Only allow the app's own origin.
    if (callbackUrl) {
      const allowedOrigin = (
        process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
      ).replace(/\/+$/, '');
      try {
        const u = new URL(callbackUrl);
        if (`${u.protocol}//${u.host}` !== allowedOrigin) {
          throw new BadRequest('"callbackUrl" must match the app origin');
        }
      } catch (e) {
        if (e instanceof BadRequest) throw e;
        throw new BadRequest('"callbackUrl" must be a valid URL');
      }
    }

    try {
      // Resolve the auth config id for the FIRST attempt. When the caller gave
      // us nothing, proactively ensure one exists (GET then POST-managed) so we
      // avoid the guaranteed "Auth config not found" round-trip for a toolkit
      // that has never been configured. ensureAuthConfig returns null on a soft
      // failure (logged) — we still attempt initiate with the slug so behaviour
      // never regresses below today's best-effort.
      let authConfigId =
        explicitAuthConfigId ?? (await this.ensureAuthConfig(toolkit)) ?? toolkit;

      let attempt = await this.initiateConnect(
        authConfigId,
        user.id,
        callbackUrl
      );

      // Recovery: initiate said the auth config is missing. Create/find one and
      // retry EXACTLY once. (Guarded so we don't loop if we just created it.)
      if (!attempt.ok && attempt.authNotFound) {
        this.logger.warn(
          `[integrations] connect ${toolkit}: auth config missing — provisioning managed config`
        );
        const ensuredId = await this.ensureAuthConfig(toolkit);
        if (ensuredId && ensuredId !== authConfigId) {
          authConfigId = ensuredId;
          attempt = await this.initiateConnect(
            authConfigId,
            user.id,
            callbackUrl
          );
        }
      }

      if (attempt.ok && attempt.redirectUrl) {
        res.status(200).json({ redirectUrl: attempt.redirectUrl });
        return;
      }

      // Still no auth config after the retry -> actionable passthrough body the
      // frontend maps to a "configure this toolkit in Composio" surface.
      if (attempt.authNotFound) {
        this.logger.warn(
          `[integrations] connect ${toolkit} failed: toolkit_auth_unconfigured`
        );
        res.status(502).json({ error: 'toolkit_auth_unconfigured', toolkit });
        return;
      }

      const detail = attempt.detail ?? 'composio_request_failed';
      this.logger.warn(`[integrations] connect ${toolkit} failed: ${detail}`);
      res.status(502).json({ error: 'composio_error', detail });
    } catch (err) {
      const detail = (err as Error)?.message ?? 'composio_request_failed';
      this.logger.warn(`[integrations] connect ${toolkit} threw: ${detail}`);
      res.status(502).json({ error: 'composio_error', detail });
    }
  }

  // ---- connect internals --------------------------------------------------

  /**
   * Initiate a hosted auth-link session for {authConfigId, userId}. Returns a
   * normalized result rather than throwing: {ok, redirectUrl?} on success, or
   * {ok:false, detail, authNotFound} where `authNotFound` flags the specific
   * "Auth config not found" case so the caller can provision one and retry.
   * Same header/timeout idioms as the other Composio calls.
   */
  private async initiateConnect(
    authConfigId: string,
    userId: string,
    callbackUrl: string | undefined
  ): Promise<{
    ok: boolean;
    redirectUrl?: string;
    detail?: string;
    authNotFound?: boolean;
  }> {
    const payload: Record<string, unknown> = {
      auth_config_id: authConfigId,
      user_id: userId,
    };
    if (callbackUrl) payload.callback_url = callbackUrl;

    const response = await this.fetchWithTimeout(COMPOSIO_LINK_URL, {
      method: 'POST',
      headers: {
        'x-api-key': COMPOSIO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail =
        typeof data?.error?.message === 'string'
          ? data.error.message
          : typeof data?.message === 'string'
            ? data.message
            : `composio responded ${response.status}`;
      // Composio phrases this as "Auth config not found" (404); match loosely so
      // minor wording/casing drift still triggers the provision-and-retry path.
      const authNotFound = /auth config not found/i.test(String(detail));
      return { ok: false, detail, authNotFound };
    }

    const redirectUrl =
      typeof data?.redirect_url === 'string'
        ? data.redirect_url
        : typeof data?.redirectUrl === 'string'
          ? data.redirectUrl
          : '';
    if (!redirectUrl) {
      return { ok: false, detail: 'no_redirect_url' };
    }
    return { ok: true, redirectUrl };
  }

  /**
   * Ensure a Composio auth config exists for `toolkit`, returning its id (or
   * null on soft failure — logged, never throws). GETs the toolkit's auth
   * configs first (defensive items|data parse, same as tools discovery); if any
   * exists returns the first id, otherwise POSTs a Composio-managed one
   * (managed-auth shape) and returns the created id (defensive parse of the
   * nested {auth_config:{id}} / flat {id} response shapes).
   */
  private async ensureAuthConfig(toolkit: string): Promise<string | null> {
    // 1) List existing configs for this toolkit.
    try {
      const listUrl = `${COMPOSIO_AUTH_CONFIGS_URL}?toolkit_slug=${encodeURIComponent(
        toolkit
      )}`;
      const listRes = await this.fetchWithTimeout(listUrl, {
        method: 'GET',
        headers: {
          'x-api-key': COMPOSIO_API_KEY,
          Accept: 'application/json',
        },
      });
      if (listRes.ok) {
        const listData: any = await listRes.json().catch(() => ({}));
        const existing = extractAuthConfigId(listData);
        if (existing) return existing;
      } else {
        this.logger.warn(
          `[integrations] auth_configs list ${toolkit} HTTP ${listRes.status}`
        );
      }
    } catch (err) {
      this.logger.warn(
        `[integrations] auth_configs list ${toolkit} failed: ${(err as Error)?.message ?? err}`
      );
    }

    // 2) None found — create a Composio-managed one. Body per v3:
    //    {toolkit:{slug}, auth_config:{type:'use_composio_managed_auth'}}.
    try {
      const createRes = await this.fetchWithTimeout(COMPOSIO_AUTH_CONFIGS_URL, {
        method: 'POST',
        headers: {
          'x-api-key': COMPOSIO_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          toolkit: { slug: toolkit },
          auth_config: { type: 'use_composio_managed_auth' },
        }),
      });
      const createData: any = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        const detail =
          typeof createData?.error?.message === 'string'
            ? createData.error.message
            : typeof createData?.message === 'string'
              ? createData.message
              : `composio responded ${createRes.status}`;
        this.logger.warn(
          `[integrations] auth_configs create ${toolkit} failed: ${detail}`
        );
        return null;
      }
      const created = extractAuthConfigId(createData);
      if (created) {
        this.logger.log(
          `[integrations] created managed auth config for ${toolkit}`
        );
        return created;
      }
      this.logger.warn(
        `[integrations] auth_configs create ${toolkit}: no id in response`
      );
      return null;
    } catch (err) {
      this.logger.warn(
        `[integrations] auth_configs create ${toolkit} failed: ${(err as Error)?.message ?? err}`
      );
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // POST run — the integrations orchestrator.
  //
  //   body {prompt: string (1..4000), toolkits?: string[] (<=5 slugs)}
  //
  // Flow:
  //   (a) no COMPOSIO_API_KEY   -> 409 {error:'not_configured'}
  //   (b) discover tools for the given toolkits (Composio v3, 8s each), and
  //       condense their schemas (slug+desc+required, char-capped) into the
  //       planner system prompt.
  //   (c) run a cdz-flash tool loop (direct CDZ_AI call per compact.ts, 10s per
  //       call). The model replies ONLY with JSON:
  //         {"action":"call","tool":"<slug>","arguments":{...}}  or
  //         {"action":"final","answer":"..."}
  //       Parsed fail-closed (strip fences, JSON.parse in try/catch; unparseable
  //       -> treated as a final answer with the raw text).
  //   (d) on "call": POST tools/execute/<tool_slug> {user_id, arguments} (20s);
  //       record a step {tool, arguments, ok, resultPreview(<=2000)}; feed a
  //       truncated result back as the next user turn. Execution errors become
  //       ok:false steps whose error text is fed back (loop continues).
  //   (e) iteration cap (4 calls) + total wall-clock cap (~75s) via
  //       AbortControllers; when a cap hits, ask/synthesize a final answer.
  //
  // Success -> 200 {ok:true, answer, steps, iterations}.
  // cdz-flash unreachable (planner call fails on the FIRST turn) -> @Res 502
  // {error:'planner_unavailable'} — mirrors the file's @Res passthrough; NEVER
  // a raw HttpException.
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/integrations/run')
  async run(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Res() res: Response
  ) {
    // ---- input validation (typed 400 for genuinely malformed input) ----
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (prompt.length < RUN_PROMPT_MIN || prompt.length > RUN_PROMPT_MAX) {
      throw new BadRequest(
        `"prompt" must be a string of ${RUN_PROMPT_MIN}..${RUN_PROMPT_MAX} chars`
      );
    }
    const toolkitSlugs: string[] = Array.isArray(body?.toolkits)
      ? body.toolkits
          .filter((s: any) => typeof s === 'string' && s.trim())
          .map((s: string) => s.trim())
          .slice(0, RUN_MAX_TOOLKITS)
      : [];

    // (a) dark by default.
    if (!COMPOSIO_API_KEY) {
      res.status(409).json({ error: 'not_configured' });
      return;
    }

    // Wall-clock budget for the whole loop (independent of per-call timeouts).
    const deadline = Date.now() + RUN_WALL_CLOCK_MS;
    const timeLeft = () => deadline - Date.now();

    // (b) discover + condense tools. Tool discovery failures are soft: an empty
    // catalog just means the planner will (correctly) tell the user to connect a
    // toolkit or that it has nothing to run.
    const tools = await this.discoverTools(toolkitSlugs);
    const condensed = condenseToolSchemas(tools);
    const knownSlugs = new Set(tools.map(t => t.slug));

    const systemPrompt = this.buildPlannerSystemPrompt(condensed);

    // Conversation seed: system + the user's request.
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ];

    const steps: RunStep[] = [];
    let iterations = 0;
    let answer: string | null = null;

    // ---- the tool loop ----
    while (iterations < RUN_MAX_ITERATIONS && timeLeft() > 0) {
      const planned = await this.callPlanner(messages, timeLeft());

      // planner unreachable BEFORE we produced anything -> 502. Once we have
      // steps we prefer to synthesize a partial answer instead of 502ing.
      if (planned === null) {
        if (steps.length === 0) {
          res.status(502).json({ error: 'planner_unavailable' });
          return;
        }
        answer = this.synthesizeAnswer(steps);
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

      // Guard against invented tools: never execute a slug the model wasn't
      // given. Feed the correction back and let it retry (does NOT burn an
      // execution, but DOES count as an iteration to keep the loop bounded).
      if (!knownSlugs.has(toolSlug)) {
        iterations++;
        const correction = `Tool "${toolSlug}" is not in the available tools. Choose one of the listed tool slugs, or finish with {"action":"final","answer":"..."}.`;
        messages.push({ role: 'user', content: correction });
        continue;
      }

      iterations++;
      const step = await this.executeTool(toolSlug, args, user.id, timeLeft());
      steps.push(step);

      // Feed a truncated result back to the model as the next user turn.
      const feedback = step.ok
        ? `Result of ${toolSlug} (ok): ${truncatePreview(step.resultPreview, RESULT_FEEDBACK_CHAR_CAP)}`
        : `Error from ${toolSlug} (failed): ${truncatePreview(step.resultPreview, RESULT_FEEDBACK_CHAR_CAP)}`;
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
          d.action === 'final' && d.answer ? d.answer : this.synthesizeAnswer(steps);
      } else {
        answer = this.synthesizeAnswer(steps);
      }
    }

    res.status(200).json({ ok: true, answer, steps, iterations });
  }

  // ---- /run internals -----------------------------------------------------

  /** Compose the planner system prompt from the condensed tool block. */
  private buildPlannerSystemPrompt(condensed: string): string {
    const toolBlock = condensed || '(no tools are available for the selected toolkits)';
    return [
      "You are ClickDz's integrations agent. You accomplish the user's request by",
      'calling the available tools below, one at a time.',
      '',
      'AVAILABLE TOOLS (slug: description [required params]):',
      toolBlock,
      '',
      'RESPOND WITH JSON ONLY — no prose, no markdown, no code fences. Exactly one of:',
      '  {"action":"call","tool":"<slug>","arguments":{ ...tool inputs... }}',
      '  {"action":"final","answer":"<plain-language answer for the user>"}',
      '',
      'Rules:',
      '- Use ONLY the exact tool slugs listed above. NEVER invent a tool.',
      '- Put every argument the tool needs inside "arguments".',
      '- If a tool fails because a connected account is missing (auth / not connected),',
      '  STOP and finish with {"action":"final","answer":"..."} telling the user to',
      '  connect that toolkit first on the Integrations page.',
      '- When you have enough to answer, finish with an "final" action.',
    ].join('\n');
  }

  /**
   * Discover tools for each toolkit slug via Composio v3 (8s per toolkit).
   * Defensive parse (items|data|tools|array). Per-toolkit failures are logged
   * and skipped — a partial or empty catalog is fine (the planner adapts).
   */
  private async discoverTools(toolkitSlugs: string[]): Promise<CdzTool[]> {
    const collected: CdzTool[] = [];
    const seen = new Set<string>();
    for (const slug of toolkitSlugs) {
      try {
        const url = `${COMPOSIO_TOOLS_URL}?toolkit_slug=${encodeURIComponent(
          slug
        )}&limit=${RUN_TOOLS_PER_TOOLKIT}`;
        const response = await this.fetchWithTimeout(
          url,
          {
            method: 'GET',
            headers: {
              'x-api-key': COMPOSIO_API_KEY,
              Accept: 'application/json',
            },
          },
          RUN_TOOLS_TIMEOUT_MS
        );
        if (!response.ok) {
          this.logger.warn(
            `[integrations] tools ${slug} HTTP ${response.status}`
          );
          continue;
        }
        const data: any = await response.json();
        for (const raw of extractToolList(data)) {
          const tool = normalizeTool(raw);
          if (tool && !seen.has(tool.slug)) {
            seen.add(tool.slug);
            collected.push(tool);
          }
        }
      } catch (err) {
        this.logger.warn(
          `[integrations] tools ${slug} fetch failed: ${(err as Error)?.message ?? err}`
        );
      }
    }
    return collected;
  }

  /**
   * POST /api/v1/social/compose — draft/rewrite social post copy with cdz-flash.
   *
   * WS9: the native Social studio's "generate content" button. This is a THIN
   * wrapper over the SAME planner path the /run loop uses (`callPlanner` →
   * CDZ_AI_BASE_URL + /v1/chat/completions, model cdz-flash) — a single turn,
   * NO Composio, NO tool loop. The FE takes the returned draft, lets the owner
   * edit it, then publishes via the existing /api/v1/integrations/run path
   * (which injects the per-user `user_id` on every execute). So this route
   * never touches a connected account and does not weaken per-user isolation.
   *
   * Body: { brief: string; channels?: string[]; tone?: string }.
   * Responses (typed, via @Res — mirrors run()):
   *   - COMPOSIO/AI key absent (no CDZ_AI_KEY) -> 409 {error:'not_configured'}
   *   - malformed brief                        -> typed 400 (BadRequest)
   *   - planner unreachable/empty              -> 502 {error:'planner_unavailable'}
   *   - ok                                     -> 200 {content}
   */
  @Throttle('strict')
  @Post('/api/v1/social/compose')
  async compose(
    @CurrentUser() _user: CurrentUser,
    @Body() body: any,
    @Res() res: Response
  ) {
    const brief = typeof body?.brief === 'string' ? body.brief.trim() : '';
    if (brief.length < COMPOSE_BRIEF_MIN || brief.length > COMPOSE_BRIEF_MAX) {
      throw new BadRequest(
        `"brief" must be a string of ${COMPOSE_BRIEF_MIN}..${COMPOSE_BRIEF_MAX} chars`
      );
    }
    // Content generation runs on cdz-flash (CDZ_AI_KEY), not the Composio key —
    // dark by default when the AI key is absent, exactly like /run is dark
    // without COMPOSIO_API_KEY.
    if (!CDZ_AI_KEY) {
      res.status(409).json({ error: 'not_configured' });
      return;
    }

    const channels: string[] = Array.isArray(body?.channels ?? body?.networks)
      ? (body.channels ?? body.networks)
          .filter((s: any) => typeof s === 'string' && s.trim())
          .map((s: string) => s.trim())
          .slice(0, RUN_MAX_TOOLKITS)
      : [];
    const tone =
      typeof body?.tone === 'string' ? body.tone.trim().slice(0, 60) : '';
    // P3 — extended fields: per-network variants, hashtag/emoji hints.
    const perNetwork = body?.perNetwork === true && channels.length > 0;
    const hashtagHint = body?.hashtags === true ? ' Add relevant hashtags.' : '';
    const emojiHint = body?.emoji === true ? ' Use relevant emoji.' : '';

    const channelHint = channels.length
      ? ` The post is for these platforms: ${channels.join(', ')}. Respect each platform's conventions (length, hashtags).`
      : '';
    const toneHint = tone ? ` Tone: ${tone}.` : '';

    // Base content (always generated — back-compat).
    const baseMessages: Array<{ role: string; content: string }> = [
      {
        role: 'system',
        content:
          'You are a social media copywriter for a small business. Write ONE ready-to-post caption from the brief. Output ONLY the caption text — no preamble, no quotes, no markdown, no options list.' +
          channelHint +
          toneHint +
          hashtagHint +
          emojiHint,
      },
      { role: 'user', content: brief },
    ];

    const planned = await this.callPlanner(baseMessages, COMPOSE_TIMEOUT_MS);
    if (planned === null || !planned.raw.trim()) {
      res.status(502).json({ error: 'planner_unavailable' });
      return;
    }
    const content = planned.raw.trim();

    // Per-network variants: one cdz-flash turn per network (bounded).
    if (perNetwork) {
      const variants: Record<string, string> = {};
      const perNetworkBudget = Math.max(
        1000,
        COMPOSE_TIMEOUT_MS - (COMPOSE_TIMEOUT_MS / (channels.length + 1))
      );
      for (const channel of channels) {
        const vMessages: Array<{ role: string; content: string }> = [
          {
            role: 'system',
            content:
              `You are a social media copywriter. Adapt the following caption specifically for ${channel}. ` +
              `Respect ${channel}'s conventions (character limit, hashtag style, tone, media requirements). ` +
              `Output ONLY the adapted caption — no preamble, no quotes, no markdown.` +
              toneHint +
              hashtagHint +
              emojiHint,
          },
          { role: 'user', content: `Base caption:\n${content}` },
        ];
        const vPlanned = await this.callPlanner(vMessages, perNetworkBudget);
        if (vPlanned?.raw.trim()) {
          variants[channel] = vPlanned.raw.trim();
        }
      }
      res.status(200).json({ content, variants });
    } else {
      res.status(200).json({ content });
    }
  }

  /**
   * One planner turn against cdz-flash (direct CDZ_AI, OpenAI-compatible). The
   * timeout is min(10s, remaining wall-clock). Returns {raw} on a clean 2xx with
   * string content, or null on ANY failure (no key, non-2xx, timeout, empty) so
   * the caller can decide 502-vs-synthesize.
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
        `[integrations] planner resolved: base=${CDZ_AI_BASE_URL} path=${CDZ_PLANNER_PATH} model=${CDZ_PLANNER_MODEL}`
      );
    }
    const timeoutMs = Math.max(1, Math.min(RUN_PLANNER_TIMEOUT_MS, remainingMs));
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
        `[integrations] planner non-ok (${response.status}) or empty content [POST ${CDZ_PLANNER_PATH}]`
      );
      return null;
    } catch (err) {
      this.logger.warn(
        `[integrations] planner call failed: ${(err as Error)?.message ?? err}`
      );
      return null;
    }
  }

  /**
   * C3: execute one Composio tool and return the NUMERIC HTTP status alongside
   * the outcome — what the retry classifier needs. `executeTool` (the /run
   * orchestrator's helper, left byte-identical below) swallows the status into a
   * string; this parallel helper exposes it. Same per-user `user_id` body,
   * headers, timeout, and defensive parse as executeTool. Never throws:
   *  - success → { status, ok:true, preview:<truncated payload> }
   *  - non-2xx → { status, ok:false, preview:<detail>, detail }
   *  - network/abort → { status:0, ok:false, preview:<msg>, detail }
   *
   * `idempotencyKey` (when given) is passed BOTH as an `X-Idempotency-Key`
   * header and inside `arguments.idempotency_key` so retried writes de-dupe
   * upstream where the toolkit supports it (non-idempotent toolkits retry
   * at-least-once — documented behavior).
   */
  private async executeToolRaw(
    toolSlug: string,
    args: Record<string, unknown>,
    userId: string,
    remainingMs: number,
    idempotencyKey?: string
  ): Promise<RawExecuteResult> {
    const timeoutMs = Math.max(1, Math.min(FLOW_NODE_TIMEOUT_MS, remainingMs));
    const execArgs =
      idempotencyKey && !('idempotency_key' in args)
        ? { ...args, idempotency_key: idempotencyKey }
        : args;
    const headers: Record<string, string> = {
      'x-api-key': COMPOSIO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
    try {
      const response = await this.fetchWithTimeout(
        `${COMPOSIO_TOOLS_EXECUTE_URL}/${encodeURIComponent(toolSlug)}`,
        {
          method: 'POST',
          headers,
          // Per-user isolation: the caller's user.id on EVERY execute.
          body: JSON.stringify({ user_id: userId, arguments: execArgs }),
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
        return {
          status: response.status,
          ok: false,
          preview: truncatePreview(detail),
          detail: String(detail),
        };
      }
      const payload = data?.data ?? data?.response_data ?? data;
      return {
        status: response.status,
        ok: true,
        preview: truncatePreview(payload),
      };
    } catch (err) {
      const detail = (err as Error)?.message ?? 'tool_execute_failed';
      // status 0 ⇒ classified transient (network/abort) by isTransientStatus.
      return { status: 0, ok: false, preview: truncatePreview(detail), detail };
    }
  }

  /**
   * Execute one Composio tool (20s, capped by remaining wall-clock). Always
   * returns a RunStep — execution errors are captured as ok:false steps whose
   * text is fed back to the model so the loop can recover.
   */
  private async executeTool(
    toolSlug: string,
    args: Record<string, unknown>,
    userId: string,
    remainingMs: number
  ): Promise<RunStep> {
    const timeoutMs = Math.max(1, Math.min(RUN_EXECUTE_TIMEOUT_MS, remainingMs));
    try {
      const response = await this.fetchWithTimeout(
        `${COMPOSIO_TOOLS_EXECUTE_URL}/${encodeURIComponent(toolSlug)}`,
        {
          method: 'POST',
          headers: {
            'x-api-key': COMPOSIO_API_KEY,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ user_id: userId, arguments: args }),
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
        return {
          tool: toolSlug,
          arguments: args,
          ok: false,
          resultPreview: truncatePreview(detail),
        };
      }
      // Composio wraps successful output in {data}/{response_data} on some
      // tools; surface whatever is there, truncated.
      const payload = data?.data ?? data?.response_data ?? data;
      return {
        tool: toolSlug,
        arguments: args,
        ok: true,
        resultPreview: truncatePreview(payload),
      };
    } catch (err) {
      const detail = (err as Error)?.message ?? 'tool_execute_failed';
      this.logger.warn(`[integrations] execute ${toolSlug} threw: ${detail}`);
      return {
        tool: toolSlug,
        arguments: args,
        ok: false,
        resultPreview: truncatePreview(detail),
      };
    }
  }

  /** Deterministic fallback answer when the planner can't produce a final one. */
  private synthesizeAnswer(steps: RunStep[]): string {
    if (steps.length === 0) {
      return "I couldn't complete the request — the planner was unavailable and no tools ran. Please try again in a moment.";
    }
    const okCount = steps.filter(s => s.ok).length;
    const parts = steps.map(
      s => `${s.tool}: ${s.ok ? 'ok' : 'failed'}`
    );
    return `I ran ${steps.length} tool step(s) (${okCount} succeeded): ${parts.join(
      '; '
    )}. Reached the step/time limit before a final summary — review the steps above for details.`;
  }

  // =========================================================================
  // C2 — FLOWS: per-user CRUD + graph run.  C3 — run observability + DLQ.
  //
  // Persistence (all via the @Global JSON `Cache`, fail-soft, per-user keys):
  //   clickdz:flow:<userId>:<flowId>        → Flow           (~90d, refreshed on PUT)
  //   clickdz:flowindex:<userId>            → hash id→{name,updatedAt}
  //   clickdz:flowrun:<userId>:<runId>      → FlowRun        (~30d)
  //   clickdz:flowrunindex:<userId>         → hash runId→summary (cap ~50)
  //   clickdz:flowdlq:<userId>              → hash runId→FlowDlqEntry (cap ~50)
  //
  // Routes (all auth'd via the global guard + @CurrentUser; typed errors — a
  // missing flow/run is `throw new NotFound(...)` (typed 404), a bad body is
  // `throw new BadRequest(...)` (typed 400), non-standard bodies via @Res()):
  //   GET    /api/v1/integrations/flows            → Flow[]  (bare array)
  //   GET    /api/v1/integrations/flows/:id        → Flow
  //   PUT    /api/v1/integrations/flows/:id        → Flow    (upsert; :id 'new' mints)
  //   DELETE /api/v1/integrations/flows/:id        → {ok}
  //   POST   /api/v1/integrations/flows/:id/run    → FlowRun
  //   GET    /api/v1/integrations/runs             → FlowRunSummary[] (bare array)
  //   GET    /api/v1/integrations/runs/:id         → FlowRun
  //   GET    /api/v1/integrations/dlq              → FlowDlqEntry[]   (bare array)
  //   POST   /api/v1/integrations/dlq/:runId/replay→ FlowRun (fresh run)
  //
  // Every Composio execute inside runFlow uses executeNodeWithRetry(node, args,
  // user.id) — the caller's user.id on EVERY execute (isolation preserved). The
  // existing /run orchestrator + executeTool are UNCHANGED (byte-identical).
  // =========================================================================

  // ---- flow persistence (fail-soft) --------------------------------------

  /** Read one persisted Flow (normalized shape) or null. Never throws. */
  private async readFlow(userId: string, flowId: string): Promise<Flow | null> {
    try {
      const raw = await this.cache.get<Flow>(flowKey(userId, flowId));
      if (!raw || typeof raw !== 'object') return null;
      // Trust-but-verify the persisted shape (we wrote it, but be defensive).
      return {
        id: typeof raw.id === 'string' ? raw.id : flowId,
        name: typeof raw.name === 'string' ? raw.name : 'Untitled flow',
        nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
        edges: Array.isArray(raw.edges) ? raw.edges : [],
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** Persist a Flow + refresh its index entry (sliding TTL). Never throws. */
  private async writeFlow(userId: string, flow: Flow): Promise<void> {
    await this.cache.set(flowKey(userId, flow.id), flow, { ttl: FLOW_TTL_MS });
    await this.cache.mapSet<FlowIndexEntry>(flowIndexKey(userId), flow.id, {
      name: flow.name,
      updatedAt: flow.updatedAt,
    });
  }

  /** Persist a FlowRun + upsert its capped index summary. Never throws. */
  private async writeRun(userId: string, run: FlowRun): Promise<void> {
    await this.cache.set(flowRunKey(userId, run.id), run, {
      ttl: FLOW_RUN_TTL_MS,
    });
    const summary: FlowRunSummary = {
      id: run.id,
      flowId: run.flowId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      status: run.status,
      stepCount: run.steps.length,
    };
    await this.cache.mapSet<FlowRunSummary>(
      flowRunIndexKey(userId),
      run.id,
      summary
    );
    // Trim the index to the newest FLOW_RUN_INDEX_CAP by startedAt (best-effort).
    await this.trimIndex<FlowRunSummary>(
      flowRunIndexKey(userId),
      FLOW_RUN_INDEX_CAP,
      s => s.startedAt
    );
  }

  /**
   * Generic newest-N trim of a per-user index hash: if the hash holds more than
   * `cap` entries, delete the oldest (by `orderOf`) down to `cap`. Best-effort,
   * fail-soft — a failed trim never breaks the write.
   */
  private async trimIndex<T>(
    mapKey: string,
    cap: number,
    orderOf: (entry: T) => number
  ): Promise<void> {
    try {
      const ids = await this.cache.mapKeys(mapKey);
      if (ids.length <= cap) return;
      const entries: Array<{ id: string; order: number }> = [];
      for (const id of ids) {
        const v = await this.cache.mapGet<T>(mapKey, id);
        entries.push({ id, order: v ? orderOf(v) : 0 });
      }
      entries.sort((a, b) => b.order - a.order); // newest first
      for (const stale of entries.slice(cap)) {
        await this.cache.mapDelete(mapKey, stale.id);
      }
    } catch {
      /* fail-soft */
    }
  }

  // ---- flow CRUD routes ---------------------------------------------------

  /**
   * GET /flows — the caller's flows as a BARE Flow[] (full objects, newest
   * first). Reads the index hash then hydrates each flow; entries whose flow
   * record has expired are skipped (and pruned from the index). Never throws;
   * degrades to [] on any read failure.
   */
  @Throttle('strict')
  @Get('/api/v1/integrations/flows')
  async listFlows(@CurrentUser() user: CurrentUser): Promise<Flow[]> {
    try {
      const ids = await this.cache.mapKeys(flowIndexKey(user.id));
      const flows: Flow[] = [];
      for (const id of ids) {
        const flow = await this.readFlow(user.id, id);
        if (flow) flows.push(flow);
        else await this.cache.mapDelete(flowIndexKey(user.id), id); // prune stale
      }
      flows.sort((a, b) => b.updatedAt - a.updatedAt);
      return flows;
    } catch {
      return [];
    }
  }

  /** GET /flows/:id — one Flow, or typed 404. */
  @Throttle('strict')
  @Get('/api/v1/integrations/flows/:id')
  async getFlow(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string
  ): Promise<Flow> {
    const flow = await this.readFlow(user.id, id);
    if (!flow) throw new NotFound(`flow "${id}" not found`);
    return flow;
  }

  /**
   * PUT /flows/:id — upsert. `:id === 'new'` (or a body with no persisted match)
   * MINTS a fresh id (randomUUID) + createdAt; an existing id keeps its
   * createdAt and bumps updatedAt. Validates + caps the body (typed 400 on a bad
   * shape). Returns the persisted Flow.
   */
  @Throttle('strict')
  @Put('/api/v1/integrations/flows/:id')
  async upsertFlow(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Body() body: any
  ): Promise<Flow> {
    const parsed = normalizeFlowInput(body);
    if ('error' in parsed) throw new BadRequest(parsed.error);

    const now = Date.now();
    const isNew = !id || id === 'new';
    const existing = isNew ? null : await this.readFlow(user.id, id);
    const flowId = isNew || !existing ? randomUUID() : existing.id;
    const createdAt = existing ? existing.createdAt : now;

    const flow: Flow = {
      id: flowId,
      name: parsed.flow.name,
      nodes: parsed.flow.nodes,
      edges: parsed.flow.edges,
      createdAt,
      updatedAt: now,
    };
    await this.writeFlow(user.id, flow);
    return flow;
  }

  /** DELETE /flows/:id — remove the flow + its index entry. Idempotent {ok}. */
  @Throttle('strict')
  @Delete('/api/v1/integrations/flows/:id')
  async deleteFlow(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string
  ): Promise<{ ok: boolean }> {
    await this.cache.delete(flowKey(user.id, id));
    await this.cache.mapDelete(flowIndexKey(user.id), id);
    return { ok: true };
  }

  // ---- flow run (topo-sort + per-node retry) ------------------------------

  /**
   * POST /flows/:id/run — execute the flow graph and return the persisted
   * FlowRun. Typed 404 if the flow is missing; typed 400 {error:'flow_has_cycle'}
   * (via @Res) if the graph has a cycle. Every Composio execute threads
   * user.id (isolation). SYNC-bounded by FLOW_RUN_WALL_CLOCK_MS.
   */
  @Throttle('strict')
  @Post('/api/v1/integrations/flows/:id/run')
  async runFlowRoute(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    if (!COMPOSIO_API_KEY) {
      res.status(409).json({ error: 'not_configured' });
      return;
    }
    const flow = await this.readFlow(user.id, id);
    if (!flow) {
      // Typed 404 body via @Res (NotFound is fine too; keep it explicit here).
      res.status(404).json({ error: 'flow_not_found' });
      return;
    }
    const order = topoSortFlow(flow.nodes, flow.edges);
    if (!order) {
      res.status(400).json({ error: 'flow_has_cycle' });
      return;
    }
    const run = await this.runFlow(flow, user.id, order);
    res.status(200).json(run);
  }

  /**
   * The graph executor (shared by /flows/:id/run and DLQ replay). Runs nodes in
   * topological order:
   *  - trigger nodes: skipped (manual run = the entry point).
   *  - condition nodes: evaluated in-process (no Composio call) against prior
   *    outputs; when a condition is false, its downstream (transitively) is
   *    gated (skipped) for the rest of the run.
   *  - action nodes: executeNodeWithRetry(node, resolvedArgs, userId) — the
   *    caller's user.id on EVERY execute. Config `${node.path}`/`${previous}`
   *    refs are resolved against accumulated upstream outputs.
   * Persists the FlowRun (running → terminal) and, on failure, enqueues a DLQ
   * entry. Bounded by FLOW_RUN_WALL_CLOCK_MS overall + FLOW_NODE_TIMEOUT_MS per
   * node. Returns the final FlowRun.
   */
  private async runFlow(
    flow: Flow,
    userId: string,
    precomputedOrder?: string[]
  ): Promise<FlowRun> {
    const order = precomputedOrder ?? topoSortFlow(flow.nodes, flow.edges) ?? [];
    const nodeById = new Map(flow.nodes.map(n => [n.id, n]));
    const deadline = Date.now() + FLOW_RUN_WALL_CLOCK_MS;

    const run: FlowRun = {
      id: randomUUID(),
      flowId: flow.id,
      startedAt: Date.now(),
      status: 'running',
      steps: [],
    };
    // Persist the running record up front so a GET /runs/:id works mid-flight.
    await this.writeRun(userId, run);

    // Outputs available to downstream nodes as `${nodeId.path}` / `${previous}`.
    const outputs = new Map<string, unknown>();
    // Nodes whose upstream gate (condition false / failed dependency) closed.
    const gated = new Set<string>();
    let sawError = false;
    let sawSuccess = false;
    let lastOutputNodeId: string | null = null;

    const gateDownstream = (fromId: string) => {
      // Mark every node reachable from `fromId` as gated (BFS over edges).
      const stack = [fromId];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const e of flow.edges) {
          if (e.from === cur && !gated.has(e.to)) {
            gated.add(e.to);
            stack.push(e.to);
          }
        }
      }
    };

    for (const nodeId of order) {
      if (Date.now() >= deadline) {
        sawError = true; // ran out of wall-clock before finishing
        break;
      }
      const node = nodeById.get(nodeId);
      if (!node) continue;
      if (gated.has(nodeId)) continue; // an upstream gate/failure closed this

      // Determine the direct-predecessor output for the {previous} context.
      const preds = upstreamNodeIds(nodeId, flow.edges);
      const previous =
        preds.length && outputs.has(preds[preds.length - 1])
          ? outputs.get(preds[preds.length - 1])
          : lastOutputNodeId
            ? outputs.get(lastOutputNodeId)
            : undefined;

      if (node.type === 'trigger') {
        continue; // manual run: the trigger is just the entry marker
      }

      if (node.type === 'condition') {
        const pass = evaluateCondition(node.config, outputs, previous);
        outputs.set(node.id, { condition: pass });
        if (!pass) gateDownstream(node.id); // gate the branch that shouldn't run
        continue;
      }

      // action node
      if (!node.action) {
        // Misconfigured node (no tool slug) → record an error step, gate below.
        run.steps.push({
          nodeId: node.id,
          tool: '(unconfigured)',
          status: 'error',
          attempts: 0,
          ms: 0,
          resultPreview: '',
          error: 'node_missing_action',
        });
        sawError = true;
        gateDownstream(node.id);
        await this.writeRun(userId, run);
        continue;
      }

      const args = resolveNodeArgs(node.config, outputs, previous);
      const step = await this.executeNodeWithRetry(
        node,
        args,
        userId,
        run.id,
        deadline
      );
      run.steps.push(step);
      await this.writeRun(userId, run); // persist incrementally (live polling)

      if (step.status === 'ok') {
        sawSuccess = true;
        // Downstream nodes read this node's raw payload via `${nodeId.path}`.
        outputs.set(node.id, this.previewToOutput(step.resultPreview));
        lastOutputNodeId = node.id;
      } else {
        sawError = true;
        gateDownstream(node.id); // a failed action gates everything after it
      }
    }

    run.finishedAt = Date.now();
    run.status = sawError
      ? sawSuccess
        ? 'partial'
        : 'error'
      : 'ok';
    await this.writeRun(userId, run);

    // C3: any run that ended not-ok goes to the DLQ for replay.
    if (run.status !== 'ok') {
      await this.enqueueDlq(userId, run);
    }
    return run;
  }

  /**
   * Best-effort: turn a step's (already-truncated) resultPreview back into a
   * value downstream nodes can path into. The preview is JSON when the payload
   * was an object/array; parse it, else fall back to the raw string.
   */
  private previewToOutput(preview: string): unknown {
    const s = String(preview ?? '');
    const t = s.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return JSON.parse(t);
      } catch {
        return s;
      }
    }
    return s;
  }

  /**
   * C3 retry/backoff wrapper around executeToolRaw for a single action node.
   * Full-jitter exponential backoff (500ms→8s, max 4 attempts). Transient
   * failures (408/429/5xx/network) retry; permanent 4xx fail fast. Bounded by
   * the run `deadline`. `idempotency_key = ${runId}:${nodeId}` is threaded so
   * retried writes de-dupe where the toolkit supports it. Returns a FlowRunStep
   * with the total attempt count + elapsed ms. Never throws.
   */
  private async executeNodeWithRetry(
    node: FlowNode,
    args: Record<string, unknown>,
    userId: string,
    runId: string,
    deadline: number
  ): Promise<FlowRunStep> {
    const tool = node.action ?? '';
    const idempotencyKey = `${runId}:${node.id}`;
    const t0 = Date.now();
    let attempt = 0;
    let last: RawExecuteResult | null = null;

    while (attempt < RETRY_MAX_ATTEMPTS) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break; // out of wall-clock
      attempt++;
      last = await this.executeToolRaw(
        tool,
        args,
        userId,
        remaining,
        idempotencyKey
      );
      if (last.ok) {
        return {
          nodeId: node.id,
          tool,
          status: 'ok',
          attempts: attempt,
          ms: Date.now() - t0,
          resultPreview: last.preview,
        };
      }
      // Permanent (non-transient 4xx) OR out of attempts → stop now.
      if (!isTransientStatus(last.status) || attempt >= RETRY_MAX_ATTEMPTS) {
        break;
      }
      // Transient → full-jitter backoff, bounded by the remaining wall-clock.
      const backoff = Math.min(
        fullJitterBackoffMs(attempt),
        Math.max(0, deadline - Date.now())
      );
      if (backoff <= 0 && deadline - Date.now() <= 0) break;
      await sleep(backoff);
    }

    return {
      nodeId: node.id,
      tool,
      status: 'error',
      attempts: attempt,
      ms: Date.now() - t0,
      resultPreview: last?.preview ?? '',
      error: last?.detail ?? 'node_execute_failed',
    };
  }

  // ---- observability routes ----------------------------------------------

  /**
   * GET /runs — the caller's run summaries as a BARE array, newest first.
   * Never throws; degrades to [].
   */
  @Throttle('strict')
  @Get('/api/v1/integrations/runs')
  async listRuns(
    @CurrentUser() user: CurrentUser
  ): Promise<FlowRunSummary[]> {
    try {
      const ids = await this.cache.mapKeys(flowRunIndexKey(user.id));
      const runs: FlowRunSummary[] = [];
      for (const id of ids) {
        const s = await this.cache.mapGet<FlowRunSummary>(
          flowRunIndexKey(user.id),
          id
        );
        if (s) runs.push(s);
      }
      runs.sort((a, b) => b.startedAt - a.startedAt);
      return runs;
    } catch {
      return [];
    }
  }

  /** GET /runs/:id — one full FlowRun, or typed 404. */
  @Throttle('strict')
  @Get('/api/v1/integrations/runs/:id')
  async getRun(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string
  ): Promise<FlowRun> {
    const run = await this.cache.get<FlowRun>(flowRunKey(user.id, id));
    if (!run || typeof run !== 'object') {
      throw new NotFound(`run "${id}" not found`);
    }
    return run;
  }

  // ---- DLQ ----------------------------------------------------------------

  /** Enqueue a failed run into the per-user DLQ hash (capped). Never throws. */
  private async enqueueDlq(userId: string, run: FlowRun): Promise<void> {
    const failedNodeId = run.steps.find(s => s.status === 'error')?.nodeId;
    const entry: FlowDlqEntry = {
      runId: run.id,
      flowId: run.flowId,
      failedNodeId,
      startedAt: run.startedAt,
      enqueuedAt: Date.now(),
    };
    await this.cache.mapSet<FlowDlqEntry>(flowDlqKey(userId), run.id, entry);
    await this.trimIndex<FlowDlqEntry>(
      flowDlqKey(userId),
      FLOW_DLQ_CAP,
      e => e.enqueuedAt
    );
  }

  /**
   * GET /dlq — the caller's dead-lettered failed runs as a BARE array, newest
   * first. Never throws; degrades to [].
   */
  @Throttle('strict')
  @Get('/api/v1/integrations/dlq')
  async listDlq(@CurrentUser() user: CurrentUser): Promise<FlowDlqEntry[]> {
    try {
      const ids = await this.cache.mapKeys(flowDlqKey(user.id));
      const entries: FlowDlqEntry[] = [];
      for (const id of ids) {
        const e = await this.cache.mapGet<FlowDlqEntry>(flowDlqKey(user.id), id);
        if (e) entries.push(e);
      }
      entries.sort((a, b) => b.enqueuedAt - a.enqueuedAt);
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * POST /dlq/:runId/replay — re-run the flow the failed run belonged to (a
   * FRESH runId). On a successful ('ok') replay the DLQ entry is cleared; a
   * still-failing replay stays queued (its own new run also lands in the DLQ).
   * Typed 404 if the DLQ entry or its flow is gone (@Res bodies). Every execute
   * threads user.id (isolation).
   */
  @Throttle('strict')
  @Post('/api/v1/integrations/dlq/:runId/replay')
  async replayDlq(
    @CurrentUser() user: CurrentUser,
    @Param('runId') runId: string,
    @Res() res: Response
  ) {
    if (!COMPOSIO_API_KEY) {
      res.status(409).json({ error: 'not_configured' });
      return;
    }
    const entry = await this.cache.mapGet<FlowDlqEntry>(
      flowDlqKey(user.id),
      runId
    );
    if (!entry) {
      res.status(404).json({ error: 'dlq_entry_not_found' });
      return;
    }
    const flow = await this.readFlow(user.id, entry.flowId);
    if (!flow) {
      // The flow was deleted after failing — drop the orphan DLQ entry.
      await this.cache.mapDelete(flowDlqKey(user.id), runId);
      res.status(404).json({ error: 'flow_not_found' });
      return;
    }
    const replay = await this.runFlow(flow, user.id);
    // Clear the ORIGINAL DLQ entry once the replay succeeds cleanly.
    if (replay.status === 'ok') {
      await this.cache.mapDelete(flowDlqKey(user.id), runId);
    }
    res.status(200).json(replay);
  }

  // =========================================================================
  // P3 — SOCIAL STUDIO BACKEND
  //
  // All routes:
  //  - Auth'd (global AuthGuard + @CurrentUser — same as every route above).
  //  - @Throttle('strict') on mutating + cost paths.
  //  - Dark-by-default via COMPOSIO_API_KEY: 409 {error:'not_configured'}.
  //  - Per-user isolation: every Redis key + Composio execute uses user.id.
  //  - Fail-soft reads: degrade to [] / undefined on cache errors.
  //
  // Endpoint contract (must match E2 frontend api.ts — see /agent/workspace/fixes/p3e1.md):
  //   GET    /api/v1/social/accounts                   → {enabled, accounts:[{network,connected}]}
  //   POST   /api/v1/social/accounts/:network/connect  → {redirectUrl} | 502
  //   DELETE /api/v1/social/accounts/:network          → {ok}
  //   POST   /api/v1/social/compose                    → {content, variants?}  (extended above)
  //   POST   /api/v1/social/posts                      → SocialPost
  //   GET    /api/v1/social/posts                      → SocialPostSummary[]
  //   GET    /api/v1/social/posts/:id                  → SocialPost | 404
  //   DELETE /api/v1/social/posts/:id                  → {ok}
  //   POST   /api/v1/social/posts/:id/reschedule       → SocialPost
  //   POST   /api/v1/social/posts/:id/retry            → SocialPost
  //   GET    /api/v1/social/log                        → PublishedLogEntry[]
  //   GET    /api/v1/social/analytics/:network         → {available:boolean, ...}
  // =========================================================================

  // ---- Accounts (connections) ---------------------------------------------

  /**
   * GET /social/accounts — per-user connections for the 10 social networks.
   * One call replaces the FE's 10x toolkit-search fan-out. Returns
   * [{network, connected}] for exactly the 10 social slugs.
   */
  @Throttle('strict')
  @Get('/api/v1/social/accounts')
  async socialAccounts(
    @CurrentUser() user: CurrentUser,
    @Res() res: Response
  ) {
    if (!COMPOSIO_API_KEY) {
      res.status(200).json({ enabled: false, accounts: [] });
      return;
    }
    const connectedSlugs = await this.socialService.fetchConnectedSlugsForSocial(user.id);
    const accounts = SOCIAL_NETWORKS.map(network => ({
      network,
      connected: connectedSlugs.has(network),
    }));
    res.status(200).json({ enabled: true, accounts });
  }

  /**
   * POST /social/accounts/:network/connect — alias of the existing /integrations/connect
   * path kept for Social API cohesion. Delegates to ensureAuthConfig + initiateConnect.
   */
  @Throttle('strict')
  @Post('/api/v1/social/accounts/:network/connect')
  async socialConnect(
    @CurrentUser() user: CurrentUser,
    @Param('network') network: string,
    @Body() body: any,
    @Res() res: Response
  ) {
    if (!COMPOSIO_API_KEY) {
      res.status(409).json({ error: 'not_configured' });
      return;
    }
    const toolkit = network.trim().toLowerCase();
    if (!toolkit) {
      throw new BadRequest('"network" param is required');
    }
    const callbackUrl =
      typeof body?.callbackUrl === 'string' && body.callbackUrl.length
        ? body.callbackUrl
        : undefined;
    // WS17: validate callbackUrl origin to prevent an open-redirect phishing
    // vector. The user-supplied URL is passed to Composio's OAuth redirect; an
    // attacker could set it to a malicious URL. Only allow the app's own origin.
    if (callbackUrl) {
      const allowedOrigin = (
        process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
      ).replace(/\/+$/, '');
      try {
        const u = new URL(callbackUrl);
        if (`${u.protocol}//${u.host}` !== allowedOrigin) {
          throw new BadRequest('"callbackUrl" must match the app origin');
        }
      } catch (e) {
        if (e instanceof BadRequest) throw e;
        throw new BadRequest('"callbackUrl" must be a valid URL');
      }
    }
    try {
      let authConfigId = await this.ensureAuthConfig(toolkit) ?? toolkit;
      let attempt = await this.initiateConnect(authConfigId, user.id, callbackUrl);
      if (!attempt.ok && attempt.authNotFound) {
        const ensuredId = await this.ensureAuthConfig(toolkit);
        if (ensuredId && ensuredId !== authConfigId) {
          authConfigId = ensuredId;
          attempt = await this.initiateConnect(authConfigId, user.id, callbackUrl);
        }
      }
      if (attempt.ok && attempt.redirectUrl) {
        res.status(200).json({ redirectUrl: attempt.redirectUrl });
        return;
      }
      if (attempt.authNotFound) {
        res.status(502).json({ error: 'toolkit_auth_unconfigured', toolkit });
        return;
      }
      res.status(502).json({ error: 'composio_error', detail: attempt.detail ?? 'composio_request_failed' });
    } catch (err) {
      res.status(502).json({ error: 'composio_error', detail: (err as Error)?.message ?? 'composio_request_failed' });
    }
  }

  /**
   * DELETE /social/accounts/:network — disconnect: list the user's connected
   * accounts for this network, then DELETE each from Composio. 200 {ok} always
   * (idempotent — already-disconnected is fine). Never hard-fails.
   */
  @Throttle('strict')
  @Delete('/api/v1/social/accounts/:network')
  async socialDisconnect(
    @CurrentUser() user: CurrentUser,
    @Param('network') network: string,
    @Res() res: Response
  ) {
    if (!COMPOSIO_API_KEY) {
      res.status(409).json({ error: 'not_configured' });
      return;
    }
    const toolkit = network.trim().toLowerCase();
    const ids = await this.socialService.fetchConnectedAccountIds(user.id, toolkit);
    let allOk = true;
    for (const id of ids) {
      const ok = await this.socialService.deleteConnectedAccount(id);
      if (!ok) allOk = false;
    }
    res.status(200).json({ ok: allOk, disconnected: ids.length });
  }

  // ---- Social media upload (WS17) ----------------------------------------

  /**
   * POST /api/v1/social/media/upload — store an uploaded image/video and return
   * a PUBLIC URL Composio's servers can fetch. The browser can't use a blob:
   * URL (URL.createObjectURL) for social posts because Composio can't reach
   * browser-only URLs — every media publish silently failed. This route takes
   * a base64 payload, stores it via CopilotStorage (under the caller's copilot
   * scope), and returns the public /api/copilot/blob/{u}/{w}/{key} URL (the
   * blob GET route is @Public). The FE then uses this URL as media[].url.
   *
   * Body: { kind: 'image'|'video', mime: string, base64: string, name?: string }
   * Returns: { url: string, kind: string, mime: string }
   */
  @Throttle('strict')
  @Post('/api/v1/social/media/upload')
  async uploadSocialMedia(
    @CurrentUser() user: CurrentUser,
    @Body() body: any
  ): Promise<{ url: string; kind: string; mime: string }> {
    const kind: 'image' | 'video' =
      body?.kind === 'video' ? 'video' : 'image';
    const mime =
      typeof body?.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(body.mime)
        ? body.mime
        : kind === 'video'
          ? 'video/mp4'
          : 'image/png';
    const base64 = typeof body?.base64 === 'string' ? body.base64 : '';
    if (!base64) throw new BadRequest('"base64" is required');
    // 10MB decoded cap (matches the sendMedia base64 guard).
    if (base64.length > 14_000_000) {
      throw new BadRequest('media too large (max ~10MB)');
    }
    let buffer: Buffer;
    try {
      // Strip an optional data: prefix if the FE sent a data URL.
      const cleaned = base64.replace(/^data:[^;]+;base64,/, '');
      buffer = Buffer.from(cleaned, 'base64');
    } catch {
      throw new BadRequest('"base64" is not valid base64');
    }
    if (!buffer.length) throw new BadRequest('"base64" decoded to empty');
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('jpeg') || mime.includes('jpg')
        ? 'jpg'
        : mime.includes('webp')
          ? 'webp'
          : mime.includes('mp4')
            ? 'mp4'
            : mime.includes('webm')
              ? 'webm'
              : mime.includes('quicktime') || mime.includes('mov')
                ? 'mov'
                : 'bin';
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const key = `social-media/${kind}/${id}.${ext}`;
    const rawName = typeof body?.name === 'string' ? body.name.slice(0, 80) : '';
    // CopilotStorage.put expects (userId, workspaceId, key, blob, mime). Social
    // media is user-scoped (no workspace), so use 'social' as the workspace id —
    // the blob GET route is @Public and serves by the full path regardless.
    const url = await this.copilotStorage.put(
      user.id,
      'social',
      key,
      buffer,
      mime
    );
    this.logger.log(
      `[social] media upload user=${user.id} kind=${kind} mime=${mime} bytes=${buffer.length} name=${rawName}`
    );
    return { url, kind, mime };
  }

  // ---- Social posts CRUD --------------------------------------------------

  /**
   * POST /social/posts — create / schedule / publish-now.
   *
   * Body:
   *   { id?, text, media?, targets, scheduledAt?, publishNow? }
   *   - id: supply an existing postId to UPDATE (upsert semantics for draft edits).
   *   - text: string, 1..SOCIAL_TEXT_MAX.
   *   - media: SocialMedia[] (optional, max SOCIAL_MEDIA_MAX).
   *   - targets: [{network, text?}] (1..SOCIAL_TARGETS_MAX, required).
   *   - scheduledAt: epoch ms (future, max SOCIAL_SCHEDULE_MAX_AHEAD_MS ahead).
   *   - publishNow: boolean — publish inline in this request.
   *
   * Returns SocialPost.
   */
  @Throttle('strict')
  @Post('/api/v1/social/posts')
  async createPost(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Res() res: Response
  ) {
    if (!COMPOSIO_API_KEY) {
      res.status(409).json({ error: 'not_configured' });
      return;
    }

    // --- validate body ---
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > SOCIAL_TEXT_MAX) {
      throw new BadRequest(`"text" must be 1..${SOCIAL_TEXT_MAX} chars`);
    }

    const rawTargets = Array.isArray(body?.targets) ? body.targets : [];
    if (!rawTargets.length) {
      throw new BadRequest('"targets" must be a non-empty array of {network}');
    }
    const targets = this.socialService.normalizeTargets(rawTargets);
    if (!targets.length) {
      throw new BadRequest('"targets" contains no valid network slugs');
    }
    if (targets.length > SOCIAL_TARGETS_MAX) {
      throw new BadRequest(`max ${SOCIAL_TARGETS_MAX} targets`);
    }

    const rawMedia = Array.isArray(body?.media) ? body.media : [];
    const media = this.socialService.normalizeMedia(rawMedia);
    // WS17: reject browser blob: URLs — Composio's servers can't fetch them, so
    // a post with uploaded-media would silently fail at publish time. Surface a
    // clear 400 so the user knows to use a public image URL or the AI image gen.
    const invalidUrls = this.socialService.invalidMediaUrls(media);
    if (invalidUrls.length) {
      throw new BadRequest(
        'Media URLs must be publicly fetchable (https://...). Uploaded files are not yet supported — use the AI image generator or a public image URL.'
      );
    }
    // WS17: enforce requiresMedia server-side for IG/YouTube/TikTok/Pinterest.
    // The FE checks this, but the backend never did — a media-less post to a
    // network that requires media was sent to Composio and failed opaquely.
    const mediaRequiredTargets = targets.filter(
      t => SOCIAL_ACTIONS[t.network]?.requiresMedia && media.length === 0
    );
    if (mediaRequiredTargets.length) {
      const nets = mediaRequiredTargets.map(t => t.network).join(', ');
      throw new BadRequest(
        `These networks require media (image/video): ${nets}. Add at least one media item.`
      );
    }

    const now = Date.now();
    let scheduledAt: number | undefined;
    if (body?.scheduledAt != null) {
      const ts = Number(body.scheduledAt);
      if (!Number.isFinite(ts) || ts <= now) {
        throw new BadRequest('"scheduledAt" must be a future epoch ms');
      }
      if (ts - now > SOCIAL_SCHEDULE_MAX_AHEAD_MS) {
        throw new BadRequest(`"scheduledAt" must be within 180 days`);
      }
      scheduledAt = ts;
    }

    const publishNow = body?.publishNow === true;

    // --- resolve existing post (upsert) ---
    const existingId = typeof body?.id === 'string' ? body.id.trim() : null;
    let post: SocialPost;

    if (existingId) {
      const existing = await this.socialService.readPost(user.id, existingId);
      if (existing) {
        // Update existing (cancel old job if rescheduling).
        if (existing.status === 'scheduled' && existing.jobId) {
          await this.socialJob.removeJob(user.id, existing.id);
        }
        existing.text = text;
        existing.media = media;
        existing.targets = targets;
        existing.scheduledAt = scheduledAt;
        existing.jobId = undefined;
        existing.status = scheduledAt ? 'scheduled' : publishNow ? 'publishing' : 'draft';
        post = existing;
      } else {
        // ID supplied but not found — mint fresh.
        post = this.socialService.mintPost(user.id, { text, media, targets, scheduledAt });
      }
    } else {
      post = this.socialService.mintPost(user.id, { text, media, targets, scheduledAt });
    }

    if (publishNow) {
      // Inline publish: persist as publishing → run → update.
      post.status = 'publishing';
      await this.socialService.writePost(user.id, post);
      const updated = await this.socialService.publishPost(post);
      await this.socialService.writePost(user.id, updated);
      // Append to published log.
      const logEntry: PublishedLogEntry = {
        postId: updated.id,
        publishedAt: updated.publishedAt ?? Date.now(),
        results: updated.targets.map(t => ({
          network: t.network,
          ok: t.status === 'ok',
          externalUrl: t.externalUrl,
        })),
      };
      await this.socialService.appendPublishedLog(user.id, logEntry);
      res.status(200).json(updated);
      return;
    }

    if (scheduledAt) {
      // Schedule: persist as scheduled + enqueue delayed job.
      post.status = 'scheduled';
      await this.socialService.writePost(user.id, post);
      const jobId = await this.socialJob.enqueuePublish(user.id, post.id, scheduledAt);
      if (jobId) {
        post.jobId = jobId;
        await this.socialService.writePost(user.id, post);
      }
      res.status(200).json(post);
      return;
    }

    // Draft: persist only.
    post.status = 'draft';
    await this.socialService.writePost(user.id, post);
    res.status(200).json(post);
  }

  /**
   * GET /social/posts?status=&from=&to= — list SocialPostSummary[] (newest first).
   * `from`/`to` filter by scheduledAt epoch ms (for calendar range queries).
   */
  @Throttle('strict')
  @Get('/api/v1/social/posts')
  async listPosts(
    @CurrentUser() user: CurrentUser,
    @Query() query: any
  ): Promise<any[]> {
    const status = typeof query?.status === 'string' ? query.status.trim() : undefined;
    const from = Number.isFinite(Number(query?.from)) ? Number(query.from) : undefined;
    const to = Number.isFinite(Number(query?.to)) ? Number(query.to) : undefined;
    return this.socialService.listPostSummaries(user.id, { status, from, to });
  }

  /** GET /social/posts/:id — full SocialPost, or typed 404. */
  @Throttle('strict')
  @Get('/api/v1/social/posts/:id')
  async getPost(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    const post = await this.socialService.readPost(user.id, id);
    if (!post) {
      res.status(404).json({ error: 'post_not_found' });
      return;
    }
    res.status(200).json(post);
  }

  /**
   * DELETE /social/posts/:id — remove post + cancel its BullMQ job if scheduled.
   * Idempotent {ok}.
   */
  @Throttle('strict')
  @Delete('/api/v1/social/posts/:id')
  async deletePost(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    const post = await this.socialService.readPost(user.id, id);
    if (post?.status === 'scheduled') {
      await this.socialJob.removeJob(user.id, id);
    }
    await this.socialService.deletePost(user.id, id);
    res.status(200).json({ ok: true });
  }

  /**
   * POST /social/posts/:id/reschedule {scheduledAt} — remove old job + re-add
   * with new delay. Updates post row. Returns updated SocialPost.
   */
  @Throttle('strict')
  @Post('/api/v1/social/posts/:id/reschedule')
  async reschedulePost(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Body() body: any,
    @Res() res: Response
  ) {
    if (!COMPOSIO_API_KEY) {
      res.status(409).json({ error: 'not_configured' });
      return;
    }
    const post = await this.socialService.readPost(user.id, id);
    if (!post) {
      res.status(404).json({ error: 'post_not_found' });
      return;
    }
    const ts = Number(body?.scheduledAt);
    const now = Date.now();
    if (!Number.isFinite(ts) || ts <= now) {
      throw new BadRequest('"scheduledAt" must be a future epoch ms');
    }
    if (ts - now > SOCIAL_SCHEDULE_MAX_AHEAD_MS) {
      throw new BadRequest('"scheduledAt" must be within 180 days');
    }

    post.scheduledAt = ts;
    post.status = 'scheduled';
    // Reset any pending/failed targets for a fresh publish attempt.
    for (const t of post.targets) {
      if (t.status === 'failed') {
        t.status = 'pending';
        t.error = undefined;
      }
    }

    const newJobId = await this.socialJob.reschedulePublish(user.id, post.id, ts);
    post.jobId = newJobId;
    await this.socialService.writePost(user.id, post);
    res.status(200).json(post);
  }

  /**
   * POST /social/posts/:id/retry — re-run publishPost() for failed/partial rows,
   * only re-attempting targets whose status is 'failed' (pending targets are
   * left as-is). DLQ-style, mirrors replayDlq.
   */
  @Throttle('strict')
  @Post('/api/v1/social/posts/:id/retry')
  async retryPost(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    if (!COMPOSIO_API_KEY) {
      res.status(409).json({ error: 'not_configured' });
      return;
    }
    const post = await this.socialService.readPost(user.id, id);
    if (!post) {
      res.status(404).json({ error: 'post_not_found' });
      return;
    }
    if (post.status !== 'failed' && post.status !== 'partial') {
      throw new BadRequest(`"retry" only applies to failed/partial posts (current: ${post.status})`);
    }

    // Reset failed targets to pending so publishPost() re-attempts them.
    for (const t of post.targets) {
      if (t.status === 'failed') {
        t.status = 'pending';
        t.error = undefined;
      }
    }
    post.status = 'publishing';
    await this.socialService.writePost(user.id, post);

    const updated = await this.socialService.publishPost(post);
    await this.socialService.writePost(user.id, updated);

    // Update published log.
    const logEntry: PublishedLogEntry = {
      postId: updated.id,
      publishedAt: updated.publishedAt ?? Date.now(),
      results: updated.targets.map(t => ({
        network: t.network,
        ok: t.status === 'ok',
        externalUrl: t.externalUrl,
      })),
    };
    await this.socialService.appendPublishedLog(user.id, logEntry);
    res.status(200).json(updated);
  }

  // ---- Published log + analytics ------------------------------------------

  /**
   * GET /social/log — published log for the user (newest first).
   * Always available — the analytics floor.
   */
  @Throttle('strict')
  @Get('/api/v1/social/log')
  async socialLog(@CurrentUser() user: CurrentUser): Promise<PublishedLogEntry[]> {
    return this.socialService.readPublishedLog(user.id);
  }

  /**
   * GET /social/analytics/:network — best-effort per-network insights.
   * Discovers an analytics/insights action for the toolkit; if found, runs it
   * and returns the result. Never hard-fails — returns {available:false} when
   * no analytics action is discoverable.
   */
  @Throttle('strict')
  @Get('/api/v1/social/analytics/:network')
  async socialAnalytics(
    @CurrentUser() user: CurrentUser,
    @Param('network') network: string,
    @Res() res: Response
  ) {
    if (!COMPOSIO_API_KEY) {
      res.status(200).json({ available: false, reason: 'not_configured' });
      return;
    }
    const toolkit = network.trim().toLowerCase();
    // Discover an insights/analytics action for this toolkit.
    const analyticsAction = await this.discoverAnalyticsAction(toolkit);
    if (!analyticsAction) {
      res.status(200).json({ available: false, network: toolkit });
      return;
    }
    // Execute best-effort (no retry — analytics is read-only, failure is soft).
    const result = await this.socialService.executeToolRaw(
      analyticsAction,
      {},
      user.id
    );
    if (!result.ok) {
      res.status(200).json({ available: false, network: toolkit, error: result.detail });
      return;
    }
    let parsed: unknown = result.preview;
    try { parsed = JSON.parse(result.preview); } catch { /* keep string */ }
    res.status(200).json({ available: true, network: toolkit, data: parsed });
  }

  /**
   * Discover an analytics/insights action for a Composio toolkit.
   * Searches for actions whose slug contains 'analytics', 'insight', 'stats',
   * or 'metric'. Soft-fail → null when nothing found or Composio unreachable.
   */
  private async discoverAnalyticsAction(toolkit: string): Promise<string | null> {
    if (!COMPOSIO_API_KEY) return null;
    try {
      const params = new URLSearchParams({ toolkit_slug: toolkit, limit: '25' });
      const res = await this.fetchWithTimeout(
        `${COMPOSIO_TOOLS_URL}?${params}`,
        {
          method: 'GET',
          headers: { 'x-api-key': COMPOSIO_API_KEY, Accept: 'application/json' },
        },
        8_000
      );
      if (!res.ok) return null;
      const data: any = await res.json().catch(() => null);
      const list: any[] = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.tools)
          ? data.tools
          : Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data)
              ? data
              : [];
      const keywords = /analytics|insight|stat|metric/i;
      const found = list.find(
        (t: any) => typeof t?.slug === 'string' && keywords.test(t.slug)
      );
      return typeof found?.slug === 'string' ? found.slug : null;
    } catch {
      return null;
    }
  }
}
