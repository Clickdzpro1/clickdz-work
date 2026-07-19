import { Body, Controller, Get, Logger, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { CurrentUser } from '../../core/auth';
// Typed errors from ../../base (raw HttpException is coerced to a generic 500
// by AFFiNE's GlobalExceptionFilter — see base/nestjs/exception.ts mapAnyError).
// For the contract's non-standard status + typed-body responses (502) we write
// them directly via the injected Express Response (@Res()), exactly like
// ClickDzIntegrationsController's /run route. BadRequest stays available for
// genuinely malformed input (typed 400).
import { BadRequest, Throttle } from '../../base';
// CacheRedis is a @Global provider (same injection style as
// ClickDzDataController / ClickDzVdzController) — the internal read tools below
// read the SAME Redis records the bridge + data API expose.
import { CacheRedis } from '../../base/redis';

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
// Tool catalog (REAL surfaces, never fabricated results):
//   shops_list        — the caller's published apps (Redis set the bridge owns)
//   shop_erp_summary  — compact KPIs from the shop/ERP shared datastore
//                       (clickdz:appdata:<slug>:<collection> hashes)
//   composio_discover — GET api/v3/tools?toolkit_slug= (x-api-key)
//   composio_execute  — POST api/v3/tools/execute/<slug> {user_id, arguments}
//   make_agent_run    — POST Make.com ai-agents run (Token auth, MAKE_* envs)
// A tool whose env key is missing is advertised available:false in
// /capabilities, excluded from the planner prompt, and guarded in the loop —
// the agent degrades gracefully, it never crashes and never pretends.
// ---------------------------------------------------------------------------

// SECURITY / CONFIG: per-surface gates, read once at module load (same idiom
// as the sibling controllers' module-level env reads). Missing key => the
// matching tools are marked unavailable; nothing reaches that upstream.
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || '';

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
// cap 6 tool iterations / 90s wall. ---
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

// One executed loop step surfaced back to the client (C2 HermesStep).
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
// + argument hint + availability (env-gated).
interface HermesTool {
  slug: string;
  label: string;
  description: string;
  argsHint: string;
  available: boolean;
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
    },
    {
      slug: 'shop_erp_summary',
      label: 'Read shop ERP summary',
      description:
        "Read a compact business summary for ONE of the user's shops: revenue this month, pending orders, orders by status, low-stock products, recent orders. Use shops_list first to get valid slugs.",
      argsHint: '{"slug":"<one of the user\'s app slugs>"}',
      available: true,
    },
    {
      slug: 'composio_discover',
      label: 'Composio: discover tools',
      description:
        'Discover executable Composio tools for one toolkit (e.g. gmail, googlesheets, github, slack, notion). Returns tool slugs + required params to use with composio_execute.',
      argsHint: '{"toolkit":"<toolkit slug, e.g. gmail>"}',
      available: !!COMPOSIO_API_KEY,
    },
    {
      slug: 'composio_execute',
      label: 'Composio: execute tool',
      description:
        'Execute one Composio tool by its EXACT tool slug (e.g. GMAIL_SEND_EMAIL) on behalf of the user. Discover slugs with composio_discover first when unsure. Fails with an auth message if the user has not connected that toolkit on the Integrations page.',
      argsHint: '{"tool":"<TOOL_SLUG>","arguments":{...tool inputs...}}',
      available: !!COMPOSIO_API_KEY,
    },
    {
      slug: 'make_agent_run',
      label: 'Make.com agent',
      description:
        'Delegate a sub-task to a Make.com AI agent (long-form reasoning, drafting, automation know-how). Buffered text reply. Optional "agent" picks a specialist: default | code | builder | arabic.',
      argsHint: '{"prompt":"<sub-task>","agent":"default"}',
      available: makeAvailable,
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

/**
 * ClickDz HERMES — autonomous operations agent. All routes are auth'd (global
 * AuthGuard requires a signed-in cookie session — no @Public()); the run route
 * is rate-capped with @Throttle('strict'), mirroring the sibling controllers.
 */
@Controller()
export class ClickDzHermesController {
  private readonly logger = new Logger(ClickDzHermesController.name);

  // One-shot flag so the resolved planner base+path is logged the FIRST time a
  // planner call is actually attempted (lazy — never at import), never repeated.
  // Path only, no key material.
  private plannerUrlLogged = false;

  constructor(private readonly redis: CacheRedis) {}

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
   * {tools:[{slug,label,available}], plannerReady}. Never throws; env-derived.
   */
  @Throttle('default')
  @Get('/api/v1/hermes/capabilities')
  capabilities(@CurrentUser() _user: CurrentUser, @Res() res: Response) {
    const tools = buildToolCatalog().map(t => ({
      slug: t.slug,
      label: t.label,
      available: t.available,
    }));
    res.status(200).json({ tools, plannerReady: !!CDZ_AI_KEY });
  }

  // -------------------------------------------------------------------------
  // POST run — the HERMES orchestrator.
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

    const systemPrompt = this.buildPlannerSystemPrompt(
      buildToolBlock(catalog),
      dryRun
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

      const outcome = await this.executeTool(toolSlug, args, user.id, timeLeft());
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

  // ---- /run internals -----------------------------------------------------

  /** Compose the planner system prompt from the tool block (+ dry-run note). */
  private buildPlannerSystemPrompt(toolBlock: string, dryRun: boolean): string {
    const tools =
      toolBlock || '(no tools are currently available — answer from reasoning alone)';
    return [
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
  }

  /**
   * One planner turn against cdz-flash (direct CDZ_AI, OpenAI-compatible). The
   * timeout is min(10s, remaining wall-clock). Returns {raw} on a clean 2xx with
   * string content, or null on ANY failure (no key, non-2xx, timeout, empty) so
   * the caller can decide 502-vs-synthesize. Never throws; never logs key material.
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
