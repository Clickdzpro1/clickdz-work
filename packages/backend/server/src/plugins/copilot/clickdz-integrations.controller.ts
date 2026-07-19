import { Body, Controller, Get, Logger, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { CurrentUser } from '../../core/auth';
// Typed errors from ../../base (raw HttpException is coerced to a generic 500
// by AFFiNE's GlobalExceptionFilter — see base/nestjs/exception.ts mapAnyError).
// For the contract's non-standard status + typed-body responses (409 / 502)
// we therefore write them directly via the injected Express Response
// (@Res()), exactly like ClickDzBridgeController's chatCompletions/tts routes.
// BadRequest stays available for genuinely malformed input (typed 400).
import { BadRequest, Throttle } from '../../base';

// SECURITY / CONFIG: the ONE switch. Without COMPOSIO_API_KEY every enabled
// code path below is unreachable — the controller reports {enabled:false} and
// never calls Composio. Read once at module load (same idiom as the bridge's
// VERCEL_TOKEN / DEEPGRAM_API_KEY module-level env reads).
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || '';

// Composio public REST surface (plain fetch — NO SDK dependency).
const COMPOSIO_TOOLKITS_URL =
  'https://backend.composio.dev/api/v3/toolkits?limit=24';
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

interface CdzToolkit {
  slug: string;
  name: string;
  logo?: string;
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
   * GET toolkits.
   *  - disabled  -> {enabled:false, toolkits:[]}
   *  - enabled   -> fetch Composio v3, map to {slug,name,logo?}
   *  - on any fetch/parse/timeout failure -> {enabled:true, toolkits:[],
   *    error:'composio_unreachable'} (never throws — the grid degrades softly).
   */
  @Throttle('strict')
  @Get('/api/v1/integrations/toolkits')
  async toolkits(@CurrentUser() _user: CurrentUser, @Res() res: Response) {
    if (!COMPOSIO_API_KEY) {
      res.status(200).json({ enabled: false, toolkits: [] });
      return;
    }
    try {
      const response = await this.fetchWithTimeout(COMPOSIO_TOOLKITS_URL, {
        method: 'GET',
        headers: {
          'x-api-key': COMPOSIO_API_KEY,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        this.logger.warn(`[integrations] toolkits HTTP ${response.status}`);
        res
          .status(200)
          .json({ enabled: true, toolkits: [], error: 'composio_unreachable' });
        return;
      }
      const data: any = await response.json();
      // Defensive extraction: the v3 payload is {items:[{slug,name,meta:{logo}}]}
      // but tolerate items/toolkits/data and logo/meta.logo shape drift.
      const rawList: any[] = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.toolkits)
          ? data.toolkits
          : Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data)
              ? data
              : [];
      const toolkits: CdzToolkit[] = rawList
        .map((t: any): CdzToolkit | null => {
          const slug =
            typeof t?.slug === 'string'
              ? t.slug
              : typeof t?.key === 'string'
                ? t.key
                : typeof t?.name === 'string'
                  ? t.name
                  : null;
          if (!slug) return null;
          const name =
            typeof t?.name === 'string' && t.name.length ? t.name : slug;
          const logo =
            typeof t?.meta?.logo === 'string'
              ? t.meta.logo
              : typeof t?.logo === 'string'
                ? t.logo
                : undefined;
          return logo ? { slug, name, logo } : { slug, name };
        })
        .filter((t): t is CdzToolkit => t !== null)
        .slice(0, 24);
      res.status(200).json({ enabled: true, toolkits });
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
}
