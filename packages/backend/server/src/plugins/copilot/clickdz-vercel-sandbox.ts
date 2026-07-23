import { Logger } from '@nestjs/common';

/**
 * ClickDz Vercel Sandbox client — dep-free (plain fetch, NO @vercel/sandbox
 * SDK; the npm registry is blocked in the build image). Consumed by the
 * OPENCLAW controller (clickdz-openclaw.controller.ts) to write + execute
 * planner-generated code inside an isolated Vercel microVM.
 *
 * REST surface (verified against the public vercel/sandbox SDK source, which
 * is itself a thin wrapper over these endpoints):
 *  - Sandbox API base:  https://vercel.com/api      (NOTE: not api.vercel.com)
 *      POST /v2/sandboxes                          create { projectId, runtime, timeout, ports? }
 *      GET  /v2/sandboxes?project=…&limit=1        cheap list (capability probe)
 *      GET  /v2/sandboxes/sessions/:sid            session status + routes
 *      POST /v2/sandboxes/sessions/:sid/extend-timeout  { duration } (ADDITIVE ms)
 *      POST /v2/sandboxes/sessions/:sid/cmd        start command (omit `wait` → JSON)
 *      GET  /v2/sandboxes/sessions/:sid/cmd/:cid   poll until exitCode !== null
 *      GET  /v2/sandboxes/sessions/:sid/cmd/:cid/logs   ndjson {stream,data} lines
 *      POST /v2/sandboxes/sessions/:sid/stop       release the microVM
 *  - Projects API base: https://api.vercel.com     (same host + Bearer idiom the
 *      bridge's deployAppToVercel already uses): GET /v9/projects/:name,
 *      POST /v10/projects — create-or-get the dedicated "clickdz-openclaw"
 *      project, because POST /v2/sandboxes REQUIRES a projectId.
 *
 * Conventions (mirroring clickdz-bridge.controller.ts / integrations):
 *  - Env read once at module load: VERCEL_TOKEN + VERCEL_TEAM_ID (both already
 *    set in prod for the apps-deploy feature). teamId is appended to EVERY
 *    request; Authorization: Bearer on every request.
 *  - Every fetch carries AbortSignal.timeout with a hard cap — nothing here can
 *    hang a request handler.
 *  - Defensive JSON parsing everywhere (`.json().catch(() => null)`).
 *  - NEVER log token material — logs carry status codes + paths only.
 *  - File writes go through a base64 `printf | base64 -d` bash command (the
 *    SDK's fs/write endpoint streams a tar body — deliberately NOT used here).
 *
 * Failure contract (C5): sandboxCapability() NEVER throws — it returns
 * `{ sandbox:false, reason }` with a human-readable message so OPENCLAW can
 * still plan/generate code and honestly mark it "not executed". The imperative
 * functions (createSession/writeFile/runCommand) throw SandboxError, whose
 * `code` lets callers distinguish "feature not enabled" from runtime errors.
 *
 * C4 additions (OPENCLAW live console — persistent sandbox, preview, file ops,
 * background + streaming commands): createSessionWithPorts, getPreviewUrl,
 * extendSession, sessionStatus, readFile, listFiles, runCommandBackground,
 * runCommandStreaming. All dep-free (plain fetch + the existing helpers), all
 * carry teamId + Bearer + AbortSignal.timeout, all defensive, token never
 * logged. The 8 legacy exports below are unchanged (byte-compatible).
 */

// --- env (read once at module load, same idiom as the bridge's VERCEL_TOKEN) ---
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';
// C6 FIX — the pre-created OpenClaw sandbox project id (e.g. prj_…). When the
// operator sets VERCEL_PROJECT_ID we use it VERBATIM and SKIP the name lookup /
// create dance entirely (see ensureProjectId). Root cause of "sandbox doesn't
// work": ensureProjectId resolved the project by NAME under the token's team
// scope, so a team/name mismatch 404s → CREATE → 409 → fail → degrade to
// plan-only, even though the project physically exists. Reading the id directly
// sidesteps every name/team resolution failure mode. NEVER hardcoded here — the
// operator sets it on the server; absent env falls back to name lookup/create so
// today's behavior is preserved when it is unset.
const SANDBOX_PROJECT_ID = process.env.VERCEL_PROJECT_ID || '';

// --- hosts + the dedicated project every sandbox is billed/scoped to ---
const SANDBOX_API_BASE = 'https://vercel.com/api';
const PROJECTS_API_BASE = 'https://api.vercel.com';
const SANDBOX_PROJECT_NAME = 'clickdz-openclaw';

// --- budgets (every fetch is AbortSignal.timeout-capped) ---
const CONTROL_TIMEOUT_MS = 10_000; // project ensure / cmd start / poll / probe
const CREATE_SANDBOX_TIMEOUT_MS = 30_000; // microVM provisioning is slower
const LOGS_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 500;
const MIN_COMMAND_TIMEOUT_MS = 1_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_TIMEOUT_MS = 180_000;
// Session (microVM) lifetime passed to POST /v2/sandboxes — sandboxes
// auto-expire at this timeout even if stopSession is never reached.
const MIN_SESSION_TIMEOUT_MS = 60_000;
const DEFAULT_SESSION_TIMEOUT_MS = 300_000;
const MAX_SESSION_TIMEOUT_MS = 2_700_000;
const DEFAULT_RUNTIME = 'node24';
// base64 chunk size per write command — multiple of 4 chars so every chunk
// decodes standalone (4 b64 chars == 3 raw bytes); stays far under ARG_MAX.
const WRITE_CHUNK_B64_CHARS = 65_536;
const WRITE_COMMAND_TIMEOUT_MS = 30_000;
const UPSTREAM_MSG_CAP = 300;
// Capability results are cached so the UI polling /capabilities doesn't
// hammer Vercel: positive results are stable, negative ones re-probe sooner
// (the operator may flip the feature on).
// D3 FIX (R16) — the fail-TTL is HALVED (60s → 15s). The audit flags that a
// single transient probe blip used to dark the WHOLE console fleet for up to a
// minute because this cache is module-global (shared by every user). Two changes
// address that with the smaller-risk option (see sandboxCapability):
//   (1) only DURABLE negatives (missing token / 401 auth / 403 feature gate /
//       402 billing) are cached at all — a durable negative won't self-heal, so
//       caching it is safe and spares Vercel the repeat probes.
//   (2) TRANSIENT negatives (network blip, probe timeout, 429 capacity, 5xx) are
//       NOT cached, so one user's momentary failure never gates everyone, and
//       the next request re-probes immediately.
// The shortened TTL is belt-and-braces for anything that still gets cached.
const CAPABILITY_OK_TTL_MS = 300_000;
const CAPABILITY_FAIL_TTL_MS = 15_000;

// --- C4 budgets (persistent-session + streaming ops) ---
const EXTEND_TIMEOUT_MS = 10_000; // extend-timeout control call
const SESSION_STATUS_TIMEOUT_MS = 10_000; // GET session
const READ_FILE_TIMEOUT_MS = 30_000; // cat via runCommand
const LIST_FILES_TIMEOUT_MS = 30_000; // find via runCommand
const LIST_FILES_DEFAULT_MAX = 500; // cap enumerated paths
// Streaming (live terminal) — poll cadence + a generous default wall since a
// build/dev step can legitimately run for minutes; caller passes timeoutMs.
const STREAM_POLL_INTERVAL_MS = 500;
const STREAM_DEFAULT_TIMEOUT_MS = 300_000;
const STREAM_MIN_TIMEOUT_MS = 1_000;
const STREAM_MAX_TIMEOUT_MS = 1_800_000;
const MIN_EXTEND_MS = 1_000;

const logger = new Logger('ClickDzVercelSandbox');

// ---------------------------------------------------------------------------
// Typed error — callers (OPENCLAW) branch on `code`:
//   not_configured | not_enabled  → "sandbox unavailable" (degrade gracefully)
//   at_capacity                   → concurrency/rate cap (429) — retryable soon
//   billing                       → payment/quota gate (402) — operator hard-stop
//   api_error | timeout           → runtime failure (feed back to the planner)
//
// D2 FIX (R16) — `at_capacity` + `billing` SPLIT out of the old catch-alls so a
// quota/concurrency cap no longer collapses into a generic "couldn't create"
// message. Both are additive: every existing throw site that passed one of the
// four original codes still type-checks and behaves identically. See
// statusToError (429→at_capacity, 402→billing) and describeSandboxError (the
// controller-facing discriminated mapper).
// ---------------------------------------------------------------------------
export type SandboxErrorCode =
  | 'not_configured'
  | 'not_enabled'
  | 'at_capacity'
  | 'billing'
  | 'api_error'
  | 'timeout';

// R9 SONDE — the lifecycle STAGE a failure occurred at. Attached to every
// SandboxError so callers (and the /sandbox/health probe) can report WHERE the
// sandbox broke instead of a generic message. Purely additive metadata.
export type SandboxStage =
  | 'project'
  | 'probe'
  | 'create'
  | 'exec'
  | 'poll'
  | 'logs'
  | 'extend'
  | 'status'
  | 'stop'
  | 'write';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly status?: number;
  // R9 SONDE — structured, LOUD failure context (never token material). `stage`
  // says which REST leg failed; `bodyPreview` is a short slice of the VERBATIM
  // upstream body so a prod failure is diagnosable from the surfaced error alone
  // (the whole point of the health probe). Both optional → byte-compatible with
  // existing throw sites that don't pass them.
  readonly stage?: SandboxStage;
  readonly bodyPreview?: string;

  constructor(
    code: SandboxErrorCode,
    message: string,
    status?: number,
    stage?: SandboxStage,
    bodyPreview?: string
  ) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.status = status;
    this.stage = stage;
    this.bodyPreview = bodyPreview;
  }

  /** Structured {code,stage,status,body} view — for LOUD logging / probe payloads. */
  toStructured(): {
    code: SandboxErrorCode;
    stage?: SandboxStage;
    status?: number;
    message: string;
    bodyPreview?: string;
  } {
    return {
      code: this.code,
      ...(this.stage ? { stage: this.stage } : {}),
      ...(typeof this.status === 'number' ? { status: this.status } : {}),
      message: this.message,
      ...(this.bodyPreview ? { bodyPreview: this.bodyPreview } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// D2 FIX (R16) — controller/UX-facing DISCRIMINATED result for a failed create.
//
// The imperative functions (createSession/createSessionWithPorts/…) still THROW
// SandboxError — their contract is unchanged and the happy path is byte-for-byte
// identical. This is an ADDITIVE projection the controller can call on the catch
// side to turn any create failure into a small tagged object it maps 1:1 to a
// friendly message, WITHOUT re-parsing the human string:
//
//   { ok:false, reason, status?, detail? }
//
// `reason` is deliberately COARSER than SandboxErrorCode — it is the set of
// user/operator-visible outcomes the console distinguishes:
//   - 'at_capacity' → 429: retryable soon ("capacity reached, retry shortly").
//   - 'billing'     → 402: operator hard-stop (payment/budget). Fail fast.
//   - 'auth'        → 401/403/not_configured/not_enabled: the operator must fix
//                     the token or enable the feature. (not_configured and
//                     not_enabled both collapse here — from the USER's seat both
//                     read "the operator needs to set the sandbox up"; the exact
//                     knob is still in `detail.code`/`detail.message` for logs.)
//   - 'timeout'     → the create/exec leg exceeded its AbortSignal budget.
//   - 'unknown'     → anything else (api_error, transport errors, non-SandboxError).
// `status` is the upstream HTTP status when known; `detail` is the short verbatim
// upstream body slice (NEVER token material — it is the RESPONSE body, not our
// request headers). Consumers should switch on `reason` only.
// ---------------------------------------------------------------------------
export type SandboxFailureReason =
  | 'at_capacity'
  | 'billing'
  | 'auth'
  | 'timeout'
  | 'unknown';

export interface SandboxFailure {
  ok: false;
  reason: SandboxFailureReason;
  status?: number;
  detail?: string;
}

/**
 * Project ANY thrown error from a create/exec path onto the coarse
 * {ok:false, reason, status?, detail?} shape above. Pure + total (never throws,
 * always returns a value) so a controller catch block can do:
 *
 *   catch (err) { const f = describeSandboxError(err); ... switch (f.reason) }
 *
 * A non-SandboxError (transport blip, TypeError) maps to reason:'unknown' with
 * no status. `detail` prefers the verbatim upstream body slice, else the
 * composed message — bounded and never carrying token material.
 */
export function describeSandboxError(err: unknown): SandboxFailure {
  if (err instanceof SandboxError) {
    const reason: SandboxFailureReason =
      err.code === 'at_capacity'
        ? 'at_capacity'
        : err.code === 'billing'
          ? 'billing'
          : err.code === 'not_configured' || err.code === 'not_enabled'
            ? 'auth'
            : err.code === 'timeout'
              ? 'timeout'
              : 'unknown';
    const detail = (err.bodyPreview || err.message || '').slice(0, UPSTREAM_MSG_CAP);
    return {
      ok: false,
      reason,
      ...(typeof err.status === 'number' ? { status: err.status } : {}),
      ...(detail ? { detail } : {}),
    };
  }
  const detail = ((err as Error)?.message ?? String(err ?? '')).slice(
    0,
    UPSTREAM_MSG_CAP
  );
  return { ok: false, reason: 'unknown', ...(detail ? { detail } : {}) };
}

export interface SandboxSession {
  sessionId: string;
  runtime: string;
}

/** A publicly-routable port exposed by the sandbox (create/get response). */
export interface SandboxRoute {
  url: string;
  subdomain: string;
  port: number;
}

/** Session lifecycle status as reported by GET …/sessions/{id}. Anything the
 * upstream enum doesn't map cleanly to → 'unknown' so callers recreate. */
export type SandboxStatus = 'running' | 'stopped' | 'failed' | 'unknown';

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Append teamId to a URL, merging with any existing querystring. */
function withTeam(url: string): string {
  if (!VERCEL_TEAM_ID) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`;
}

function authHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${VERCEL_TOKEN}`,
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

/** fetch with teamId + a hard AbortSignal.timeout — used by EVERY call here. */
async function vFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<globalThis.Response> {
  return await fetch(withTeam(url), {
    ...init,
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
}

/** Defensive body parse — malformed/empty upstream JSON never throws. */
async function readJson(res: globalThis.Response): Promise<any> {
  return await res.json().catch(() => null);
}

/**
 * R9 SONDE — read an error response body EXACTLY ONCE and return BOTH the parsed
 * JSON (or null) AND a short raw text preview. Root cause of "errors get eaten":
 * the old path did `res.json().catch(()=>null)` and, when Vercel returned a
 * NON-JSON body (an HTML edge error page, a plain-text 4xx/5xx, or an empty
 * body), `data` was null → `upstreamMessage` returned '' → the surfaced error
 * was a bare "HTTP <status>" with nothing diagnostic. Reading the text first and
 * keeping a bounded preview means the VERBATIM upstream bytes always survive to
 * the caller (and the health probe) regardless of content-type. A body can only
 * be consumed once, so callers MUST use this instead of readJson on error paths.
 * NEVER contains token material (it's the response body, not our request).
 */
async function readErrorBody(
  res: globalThis.Response
): Promise<{ data: any; bodyPreview: string }> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null; // non-JSON (HTML/plain) — the raw preview still carries it.
    }
  }
  // Collapse whitespace so an HTML page preview stays compact + readable.
  const bodyPreview = text.replace(/\s+/g, ' ').trim().slice(0, UPSTREAM_MSG_CAP);
  return { data, bodyPreview };
}

/** Extract a short human upstream error message (never token material). */
function upstreamMessage(data: any): string {
  const msg =
    (typeof data?.error?.message === 'string' && data.error.message) ||
    (typeof data?.error === 'string' && data.error) ||
    (typeof data?.message === 'string' && data.message) ||
    '';
  return msg.slice(0, UPSTREAM_MSG_CAP);
}

/**
 * Map a non-2xx Vercel response to a typed SandboxError with a human message.
 * C6 FIX — SPLIT the auth/plan gate so real failures surface their true reason
 * instead of always reading "not enabled":
 *   - 401 → `not_configured` (a CONFIG / auth fault: the token is wrong, expired
 *     or scoped to the wrong team). Distinct message "check VERCEL_TOKEN…" so a
 *     bad token is never masked by the plan-gate banner.
 *   - 403 → `not_enabled` (feature/permission gate — enable Sandbox in the Vercel
 *     dashboard / the token lacks the scope).
 *
 * D2 FIX (R16) — the two OPERATIONAL caps that the audit says were being
 * collapsed into the generic "couldn't create" message now get their OWN codes,
 * so the console can tell the user something honest and actionable:
 *   - 429 → `at_capacity` (concurrency cap / control-plane rate limit / vCPU
 *     allocation-rate limit — all documented to return 429). RETRYABLE: the
 *     right UX is "sandbox capacity reached, retry shortly", NOT an outage
 *     banner. The three distinct 429 sub-causes are indistinguishable by status
 *     alone; the verbatim bodyPreview carries the upstream detail for logs.
 *   - 402 → `billing` (payment method missing / account past its budget). This
 *     is an OPERATOR hard-stop — waiting will not clear it — so it is kept
 *     DISTINCT from 403's feature-gate and from 429's retryable cap. SPLIT out
 *     of the old `402 || 403 → not_enabled` pair.
 *
 * Each branch yields a DISTINCT reason code (not_configured / not_enabled /
 * at_capacity / billing / api_error) so the controller/UX maps 1:1 without
 * re-parsing the message. NEVER logs/echoes token material.
 *
 * R9 SONDE — now takes the lifecycle `stage` + a raw `bodyPreview` and threads
 * BOTH onto the error (see SandboxError.stage/bodyPreview). The message also
 * appends the raw preview when the parsed body had no structured message, so a
 * non-JSON upstream error (the classic silently-eaten case) is LOUD. Accepts a
 * `data`-or-preview pair; pass `readErrorBody(res)`'s result at every call site.
 */
function statusToError(
  status: number,
  bodyOrData: { data: any; bodyPreview: string } | any,
  context: string,
  stage: SandboxStage
): SandboxError {
  // Back-compat: accept either the {data,bodyPreview} pair (preferred) or a bare
  // parsed body (legacy) — the latter simply has no raw preview.
  const pair =
    bodyOrData && typeof bodyOrData === 'object' && 'bodyPreview' in bodyOrData
      ? (bodyOrData as { data: any; bodyPreview: string })
      : { data: bodyOrData, bodyPreview: '' };
  const data = pair.data;
  const bodyPreview = pair.bodyPreview || '';
  const detail = upstreamMessage(data);
  // Prefer the structured message; else fall back to the raw body preview so the
  // caller ALWAYS sees the upstream bytes (never a bare "HTTP <status>").
  const shown = detail || bodyPreview;
  const suffix = shown ? `: ${shown}` : '';
  if (status === 401) {
    return new SandboxError(
      'not_configured',
      `Vercel rejected the configured token (HTTP 401) — check VERCEL_TOKEN (wrong, expired, or scoped to a different team)${suffix}`,
      status,
      stage,
      bodyPreview
    );
  }
  // D2 FIX — 429 concurrency/rate cap: retryable, keep it out of the generic
  // bucket so the UX can say "capacity reached, retry shortly".
  if (status === 429) {
    return new SandboxError(
      'at_capacity',
      `Vercel Sandbox capacity reached (HTTP 429) — the account hit a concurrency or rate limit; retry shortly${suffix}`,
      status,
      stage,
      bodyPreview
    );
  }
  // D2 FIX — 402 billing/quota gate: operator hard-stop (payment/budget), NOT
  // the same thing as a 403 feature gate and NOT retryable by waiting.
  if (status === 402) {
    return new SandboxError(
      'billing',
      `Vercel Sandbox is blocked by a billing/quota issue (HTTP 402) — check the account payment method and usage limits in the Vercel dashboard${suffix}`,
      status,
      stage,
      bodyPreview
    );
  }
  if (status === 403) {
    return new SandboxError(
      'not_enabled',
      `Vercel Sandbox is not enabled for this account (HTTP 403) — enable it in the Vercel dashboard${suffix}`,
      status,
      stage,
      bodyPreview
    );
  }
  return new SandboxError(
    'api_error',
    `Vercel ${context} failed (HTTP ${status})${suffix}`,
    status,
    stage,
    bodyPreview
  );
}

/** POSIX single-quote shell escape for untrusted path strings. */
function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Normalize the create/get response `routes` array into the SandboxRoute
 * shape, dropping any malformed entries. Upstream shape (validators.ts):
 * `{ url:string; subdomain:string; port:number }`.
 */
function parseRoutes(raw: any): SandboxRoute[] {
  if (!Array.isArray(raw)) return [];
  const out: SandboxRoute[] = [];
  for (const r of raw) {
    if (
      r &&
      typeof r.url === 'string' &&
      typeof r.subdomain === 'string' &&
      typeof r.port === 'number'
    ) {
      out.push({ url: r.url, subdomain: r.subdomain, port: r.port });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Project ensure — cached module-level.
// C6 FIX: PREFER the pre-created VERCEL_PROJECT_ID (short-circuit, no HTTP) when
// set; else fall back to the legacy create-or-get "clickdz-openclaw" by name.
// ---------------------------------------------------------------------------

let cachedProjectId: string | null = null;
// Dedupe concurrent ensures (capability poll + a run can race at boot).
let ensureInflight: Promise<string> | null = null;

async function ensureProjectId(): Promise<string> {
  if (!VERCEL_TOKEN) {
    throw new SandboxError(
      'not_configured',
      'VERCEL_TOKEN is not configured on the server — add a Vercel access token to enable sandbox execution'
    );
  }
  if (cachedProjectId) return cachedProjectId;
  // C6 FIX — short-circuit: when the operator supplied the pre-created project
  // id, use it VERBATIM. No GET /v9/projects, no create, no 404→409 team-scope
  // failure path. This is THE fix for "sandbox doesn't work": the id is passed
  // straight to POST /v2/sandboxes regardless of how name/team resolution would
  // have behaved. Cache it so subsequent calls stay allocation-free.
  if (SANDBOX_PROJECT_ID) {
    cachedProjectId = SANDBOX_PROJECT_ID;
    // One-shot, id only — never the token. (env-provided → no name in the log.)
    logger.log(`[sandbox] project id from env: id=${SANDBOX_PROJECT_ID}`);
    return cachedProjectId;
  }
  if (ensureInflight) return ensureInflight;
  ensureInflight = (async () => {
    try {
      const id = await lookupOrCreateProject();
      cachedProjectId = id;
      // One-shot, id only — never the token.
      logger.log(
        `[sandbox] project ensured: name=${SANDBOX_PROJECT_NAME} id=${id}`
      );
      return id;
    } finally {
      ensureInflight = null;
    }
  })();
  return ensureInflight;
}

async function lookupOrCreateProject(): Promise<string> {
  // 1) GET /v9/projects/:name — the common warm path.
  const getRes = await vFetch(
    `${PROJECTS_API_BASE}/v9/projects/${encodeURIComponent(SANDBOX_PROJECT_NAME)}`,
    { headers: authHeaders() },
    CONTROL_TIMEOUT_MS
  );
  if (getRes.ok) {
    const data = await readJson(getRes);
    const id = typeof data?.id === 'string' ? data.id : '';
    if (id) return id;
    throw new SandboxError(
      'api_error',
      'Vercel project lookup succeeded but returned no project id',
      getRes.status,
      'project'
    );
  }
  if (getRes.status !== 404) {
    throw statusToError(
      getRes.status,
      await readErrorBody(getRes),
      'project lookup',
      'project'
    );
  }
  // 2) 404 → POST /v10/projects to create it.
  const createRes = await vFetch(`${PROJECTS_API_BASE}/v10/projects`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ name: SANDBOX_PROJECT_NAME }),
  }, CONTROL_TIMEOUT_MS);
  if (createRes.ok) {
    const created = await readJson(createRes);
    const id = typeof created?.id === 'string' ? created.id : '';
    if (id) return id;
    throw new SandboxError(
      'api_error',
      'Vercel project create succeeded but returned no project id',
      createRes.status,
      'project'
    );
  }
  if (createRes.status === 409) {
    // Lost a create race (another replica made it) — re-GET once.
    const retryRes = await vFetch(
      `${PROJECTS_API_BASE}/v9/projects/${encodeURIComponent(SANDBOX_PROJECT_NAME)}`,
      { headers: authHeaders() },
      CONTROL_TIMEOUT_MS
    );
    if (retryRes.ok) {
      const retried = await readJson(retryRes);
      const id = typeof retried?.id === 'string' ? retried.id : '';
      if (id) return id;
      // 200 but no id — succeeded-yet-empty; the body is already consumed.
      throw new SandboxError(
        'api_error',
        'Vercel project lookup (after 409) returned no project id',
        retryRes.status,
        'project'
      );
    }
    throw statusToError(
      retryRes.status,
      await readErrorBody(retryRes),
      'project lookup (after 409)',
      'project'
    );
  }
  throw statusToError(
    createRes.status,
    await readErrorBody(createRes),
    'project create',
    'project'
  );
}

// ---------------------------------------------------------------------------
// Capability probe — NEVER throws
// ---------------------------------------------------------------------------

// D3 FIX (R16) — the cached probe result now also records whether a NEGATIVE was
// `durable` (a real config/enablement/billing problem that won't self-heal) or
// transient. Only durable results are ever stored (see sandboxCapability), so a
// transient blip can't linger in the fleet-wide cache. `durable` is undefined on
// a positive result (positives are always cached at the OK TTL).
type CapabilityResult = { sandbox: boolean; reason?: string; durable?: boolean };

let capabilityCache: {
  at: number;
  result: CapabilityResult;
} | null = null;

/**
 * Ensure the dedicated project exists, then hit the Sandbox API surface with
 * the cheapest possible call (list sandboxes, limit=1). A 401/402/403 anywhere
 * means an auth / billing / feature gate is closed → `{ sandbox:false, reason }`
 * with an actionable message. Never throws; results are briefly cached.
 *
 * D3 FIX (R16) — negative caching is now CONDITIONAL. A durable negative (no
 * token / auth / billing / feature-gate) is cached at the (shortened) fail TTL
 * because it will not self-heal without operator action. A TRANSIENT negative
 * (network blip, probe timeout, 429 capacity, 5xx, or any non-typed error) is
 * NOT cached — so one user's momentary probe failure never darks the shared
 * console for everyone, and the very next request (or a per-user create attempt)
 * re-probes live. The public return shape is unchanged ({sandbox, reason?}); the
 * `durable` flag is an internal caching hint that is stripped before returning.
 */
export async function sandboxCapability(): Promise<{
  sandbox: boolean;
  reason?: string;
}> {
  const now = Date.now();
  if (capabilityCache) {
    const ttl = capabilityCache.result.sandbox
      ? CAPABILITY_OK_TTL_MS
      : CAPABILITY_FAIL_TTL_MS;
    if (now - capabilityCache.at < ttl) {
      const { sandbox, reason } = capabilityCache.result;
      return { sandbox, ...(reason ? { reason } : {}) };
    }
  }
  const result = await probeCapability();
  // Cache positives always; cache negatives ONLY when durable. A transient
  // negative is intentionally left uncached so it can't gate the fleet.
  if (result.sandbox || result.durable) {
    capabilityCache = { at: now, result };
  } else {
    // Drop any stale (possibly durable) entry so we don't serve it past a
    // transient failure, and force the next call to re-probe fresh.
    capabilityCache = null;
  }
  const { sandbox, reason } = result;
  return { sandbox, ...(reason ? { reason } : {}) };
}

/**
 * Classify a probe failure as DURABLE (won't self-heal — safe to cache) vs
 * transient. Durable = the operator must change something: missing token,
 * 401 auth, 403 feature gate, 402 billing (their typed codes:
 * not_configured / not_enabled / billing). Everything else — 429 capacity, 5xx,
 * transport/timeout, untyped — is transient and must NOT be cached fleet-wide.
 */
function isDurableNegative(err: unknown): boolean {
  if (err instanceof SandboxError) {
    return (
      err.code === 'not_configured' ||
      err.code === 'not_enabled' ||
      err.code === 'billing'
    );
  }
  return false;
}

async function probeCapability(): Promise<CapabilityResult> {
  try {
    if (!VERCEL_TOKEN) {
      // Missing token is the canonical DURABLE negative — cache it.
      return {
        sandbox: false,
        durable: true,
        reason:
          'VERCEL_TOKEN is not configured on the server — add a Vercel access token to enable sandbox execution',
      };
    }
    const projectId = await ensureProjectId();
    const res = await vFetch(
      `${SANDBOX_API_BASE}/v2/sandboxes?project=${encodeURIComponent(projectId)}&limit=1`,
      { headers: authHeaders() },
      CONTROL_TIMEOUT_MS
    );
    if (res.ok) return { sandbox: true };
    throw statusToError(
      res.status,
      await readErrorBody(res),
      'sandbox probe',
      'probe'
    );
  } catch (err) {
    const reason =
      err instanceof SandboxError
        ? err.message
        : `Vercel Sandbox check failed: ${(err as Error)?.message ?? String(err)}`;
    const durable = isDurableNegative(err);
    logger.warn(
      `[sandbox] capability probe negative (${durable ? 'durable' : 'transient'}): ${reason}`
    );
    return { sandbox: false, durable, reason };
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a sandbox microVM. Returns the SESSION id (`session.id` from the
 * create response) — the handle every subsequent cmd/stop call needs.
 * Throws SandboxError (`not_configured` | `not_enabled` | `api_error`).
 */
export async function createSession(opts?: {
  runtime?: string;
  timeoutMs?: number;
}): Promise<SandboxSession> {
  const projectId = await ensureProjectId();
  const runtime = opts?.runtime || DEFAULT_RUNTIME;
  const timeout = clamp(
    opts?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
    MIN_SESSION_TIMEOUT_MS,
    MAX_SESSION_TIMEOUT_MS
  );
  const res = await vFetch(`${SANDBOX_API_BASE}/v2/sandboxes`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ projectId, runtime, timeout }),
  }, CREATE_SANDBOX_TIMEOUT_MS);
  if (!res.ok) {
    // Read the body ONCE on the error branch so a non-JSON upstream error still
    // surfaces its verbatim bytes (see readErrorBody).
    throw statusToError(
      res.status,
      await readErrorBody(res),
      'sandbox create',
      'create'
    );
  }
  const data = await readJson(res);
  // Contract: POST /v2/sandboxes wraps the created sandbox under `session`
  // (v2 endpoints return "session" as the wrapper key), and `session.id` is the
  // handle passed as {sessionId} to every subsequent cmd/stop call.
  const sessionId = typeof data?.session?.id === 'string' ? data.session.id : '';
  if (!sessionId) {
    throw new SandboxError(
      'api_error',
      'Vercel sandbox create succeeded but returned no session id',
      res.status,
      'create'
    );
  }
  const actualRuntime =
    typeof data?.session?.runtime === 'string' ? data.session.runtime : runtime;
  logger.log(`[sandbox] session created: runtime=${actualRuntime}`);
  return { sessionId, runtime: actualRuntime };
}

/**
 * Create a sandbox microVM WITH public ports exposed (C4) — the live-preview
 * variant of createSession. `ports` is a top-level field on POST /v2/sandboxes
 * (sandboxes can expose up to 4 ports). Returns the session handle PLUS the
 * `routes` array from the create response so OPENCLAW can derive an iframe URL
 * (see getPreviewUrl) and persist it on the thread. Defaults to port 3000
 * (the OPENCLAW dev-server convention). Throws SandboxError like createSession.
 */
export async function createSessionWithPorts(opts?: {
  runtime?: string;
  ports?: number[];
  timeoutMs?: number;
}): Promise<{ sessionId: string; runtime: string; routes: SandboxRoute[] }> {
  const projectId = await ensureProjectId();
  const runtime = opts?.runtime || DEFAULT_RUNTIME;
  const timeout = clamp(
    opts?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
    MIN_SESSION_TIMEOUT_MS,
    MAX_SESSION_TIMEOUT_MS
  );
  // De-dupe + keep only sane port numbers; cap at 4 (well under the upstream
  // max of 15). R9 SONDE FIX — Vercel requires exposed ports in [1024, 65535];
  // the old floor of `> 0` let a sub-1024 port (e.g. 80/443) through and the
  // create call 400s. Clamp the floor to 1024. Default to [3000] so OPENCLAW
  // always has a preview route; if the caller's ports all filter out, fall back
  // to [3000] rather than sending an empty list (which would expose no preview).
  const requested =
    Array.isArray(opts?.ports) && opts!.ports!.length ? opts!.ports! : [3000];
  const filtered = Array.from(
    new Set(
      requested.filter(
        p => Number.isInteger(p) && p >= 1024 && p <= 65535
      )
    )
  ).slice(0, 4);
  const ports = filtered.length ? filtered : [3000];
  const res = await vFetch(`${SANDBOX_API_BASE}/v2/sandboxes`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ projectId, runtime, timeout, ports }),
  }, CREATE_SANDBOX_TIMEOUT_MS);
  if (!res.ok) {
    throw statusToError(
      res.status,
      await readErrorBody(res),
      'sandbox create (ports)',
      'create'
    );
  }
  const data = await readJson(res);
  const sessionId = typeof data?.session?.id === 'string' ? data.session.id : '';
  if (!sessionId) {
    throw new SandboxError(
      'api_error',
      'Vercel sandbox create succeeded but returned no session id',
      res.status,
      'create'
    );
  }
  const actualRuntime =
    typeof data?.session?.runtime === 'string' ? data.session.runtime : runtime;
  const routes = parseRoutes(data?.routes);
  logger.log(
    `[sandbox] session created with ports: runtime=${actualRuntime} routes=${routes.length}`
  );
  return { sessionId, runtime: actualRuntime, routes };
}

/**
 * Resolve the public preview URL for a given port from a routes array (C4).
 * Pure helper (mirrors the SDK's `domain(port)`): prefer the ready-to-use
 * `route.url`; fall back to constructing `https://<subdomain>.vercel.run`.
 * Returns null when no route matches (caller degrades — no throw).
 */
export function getPreviewUrl(
  routes: { url: string; subdomain?: string; port: number }[],
  port: number
): string | null {
  if (!Array.isArray(routes)) return null;
  const route = routes.find(r => r && r.port === port);
  if (!route) return null;
  if (typeof route.url === 'string' && route.url) return route.url;
  if (typeof route.subdomain === 'string' && route.subdomain) {
    return `https://${route.subdomain}.vercel.run`;
  }
  return null;
}

/**
 * Push a running session's expiry forward (C4 keep-alive). `addMs` is the
 * number of milliseconds to ADD to the current deadline (additive, NOT the
 * new total — matches the upstream extend-timeout semantics). Called each turn
 * by OPENCLAW so a thread's persistent microVM survives between messages.
 * Throws SandboxError on a non-2xx so the caller can fall back to recreate.
 */
export async function extendSession(
  sessionId: string,
  addMs: number
): Promise<void> {
  if (!VERCEL_TOKEN) {
    throw new SandboxError(
      'not_configured',
      'VERCEL_TOKEN is not configured on the server — add a Vercel access token to enable sandbox execution'
    );
  }
  if (!sessionId) {
    throw new SandboxError('api_error', 'extendSession requires a sessionId');
  }
  const duration = Math.max(MIN_EXTEND_MS, Math.floor(addMs) || 0);
  const res = await vFetch(
    `${SANDBOX_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/extend-timeout`,
    {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ duration }),
    },
    EXTEND_TIMEOUT_MS
  );
  if (!res.ok) {
    throw statusToError(
      res.status,
      await readErrorBody(res),
      'session extend',
      'extend'
    );
  }
}

/**
 * Report a session's lifecycle status (C4 reuse-vs-recreate decision). GET
 * …/sessions/{id} → `session.status`, normalized to the small set OPENCLAW
 * cares about. Only 'running' means "reuse this microVM". A 404 (session gone)
 * or any transport/parse failure → 'unknown' so the caller recreates. This
 * function is DEFENSIVE and never throws.
 */
export async function sessionStatus(
  sessionId: string
): Promise<SandboxStatus> {
  if (!VERCEL_TOKEN || !sessionId) return 'unknown';
  try {
    const res = await vFetch(
      `${SANDBOX_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}`,
      { headers: authHeaders() },
      SESSION_STATUS_TIMEOUT_MS
    );
    if (res.status === 404) return 'stopped';
    if (!res.ok) {
      logger.warn(`[sandbox] session status non-ok (${res.status})`);
      return 'unknown';
    }
    const data = await readJson(res);
    const raw = typeof data?.session?.status === 'string' ? data.session.status : '';
    // Upstream enum: pending|running|stopping|stopped|failed|aborted|snapshotting
    switch (raw) {
      case 'running':
        return 'running';
      case 'stopped':
      case 'stopping':
      case 'aborted':
        return 'stopped';
      case 'failed':
        return 'failed';
      default:
        // pending / snapshotting / unrecognized → not safe to reuse yet
        return 'unknown';
    }
  } catch (err) {
    logger.warn(
      `[sandbox] session status failed: ${(err as Error)?.message ?? String(err)}`
    );
    return 'unknown';
  }
}

/** Best-effort microVM release — swallows every error (sandboxes also
 * auto-expire at their create-time timeout, so leaks are bounded). */
export async function stopSession(sessionId: string): Promise<void> {
  if (!VERCEL_TOKEN || !sessionId) return;
  try {
    await vFetch(
      `${SANDBOX_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: 'POST', headers: authHeaders() },
      STOP_TIMEOUT_MS
    );
  } catch {
    // best-effort by contract — never propagate stop failures
  }
}

// ---------------------------------------------------------------------------
// Command execution (start → poll → logs)
// ---------------------------------------------------------------------------

/**
 * Run a command to completion. Starts it non-blocking (POST …/cmd WITHOUT
 * `wait`, which returns plain JSON instead of a stream), polls
 * GET …/cmd/{id} every ~500ms until `exitCode !== null` (bounded by
 * opts.timeoutMs), then fetches the ndjson logs and splits stdout/stderr.
 * Throws SandboxError (`api_error` | `timeout`) — a NON-ZERO exitCode is NOT
 * an error here; callers feed it back to the planner.
 */
export async function runCommand(
  sessionId: string,
  command: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const timeoutMs = clamp(
    opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    MIN_COMMAND_TIMEOUT_MS,
    MAX_COMMAND_TIMEOUT_MS
  );
  const deadline = Date.now() + timeoutMs;
  const cmdBase = `${SANDBOX_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd`;

  // 1) start (omit `wait` → JSON `{ command: { id, exitCode: null, … } }`).
  // `timeout` also caps the command sandbox-side; undefined cwd is dropped by
  // JSON.stringify.
  const startRes = await vFetch(cmdBase, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ command, args, cwd: opts?.cwd, timeout: timeoutMs }),
  }, CONTROL_TIMEOUT_MS);
  if (!startRes.ok) {
    throw statusToError(
      startRes.status,
      await readErrorBody(startRes),
      `command start (${command})`,
      'exec'
    );
  }
  const started = await readJson(startRes);
  const cmdId =
    typeof started?.command?.id === 'string' ? started.command.id : '';
  if (!cmdId) {
    throw new SandboxError(
      'api_error',
      'Sandbox command start succeeded but returned no command id',
      startRes.status,
      'exec'
    );
  }
  let exitCode: number | null =
    typeof started?.command?.exitCode === 'number'
      ? started.command.exitCode
      : null;

  // 2) poll until finished (exitCode !== null) or our deadline passes.
  while (exitCode === null) {
    if (Date.now() >= deadline) {
      throw new SandboxError(
        'timeout',
        `Sandbox command "${command}" did not finish within ${timeoutMs}ms`,
        undefined,
        'poll'
      );
    }
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await vFetch(
      `${cmdBase}/${encodeURIComponent(cmdId)}`,
      { headers: authHeaders() },
      CONTROL_TIMEOUT_MS
    );
    if (!pollRes.ok) {
      throw statusToError(
        pollRes.status,
        await readErrorBody(pollRes),
        'command poll',
        'poll'
      );
    }
    const polled = await readJson(pollRes);
    if (typeof polled?.command?.exitCode === 'number') {
      exitCode = polled.command.exitCode;
    }
  }

  // 3) logs (ndjson) — tolerant: a log-fetch hiccup must not lose the exit code.
  const { stdout, stderr } = await fetchCommandLogs(sessionId, cmdId);
  return { exitCode, stdout, stderr };
}

/**
 * Start a command NON-BLOCKING and return its id immediately (C4) — the SDK's
 * "detached"/background semantics are just POST …/cmd WITHOUT `wait`, which
 * returns `{ command: { id, exitCode:null } }` and does NOT poll. Use this for
 * long-lived processes (e.g. `npm run dev`) that must keep running while the
 * session is alive; the caller derives the preview URL and later reads live
 * output via runCommandStreaming or the cmd logs endpoint. We deliberately do
 * NOT send a `timeout` (which would cap the dev server sandbox-side) — the
 * process lives until the session expires. Throws SandboxError on a bad start.
 */
export async function runCommandBackground(
  sessionId: string,
  command: string,
  args: string[],
  opts?: { cwd?: string }
): Promise<{ cmdId: string }> {
  if (!VERCEL_TOKEN) {
    throw new SandboxError(
      'not_configured',
      'VERCEL_TOKEN is not configured on the server — add a Vercel access token to enable sandbox execution'
    );
  }
  if (!sessionId) {
    throw new SandboxError('api_error', 'runCommandBackground requires a sessionId');
  }
  const cmdBase = `${SANDBOX_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd`;
  // No `wait`, no `timeout` → fire-and-return; undefined cwd dropped by stringify.
  const startRes = await vFetch(cmdBase, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      command,
      args: Array.isArray(args) ? args : [],
      cwd: opts?.cwd,
    }),
  }, CONTROL_TIMEOUT_MS);
  if (!startRes.ok) {
    throw statusToError(
      startRes.status,
      await readErrorBody(startRes),
      `background command start (${command})`,
      'exec'
    );
  }
  const started = await readJson(startRes);
  const cmdId =
    typeof started?.command?.id === 'string' ? started.command.id : '';
  if (!cmdId) {
    throw new SandboxError(
      'api_error',
      'Sandbox background command start succeeded but returned no command id',
      startRes.status,
      'exec'
    );
  }
  return { cmdId };
}

/**
 * Run a command while streaming its output live (C4 live terminal). Starts the
 * command non-blocking, then loops on ~500ms cadence: polls GET …/cmd/{id} for
 * `exitCode` while re-tailing GET …/cmd/{id}/logs, invoking `opts.onLog` for
 * ONLY newly-appended lines (an offset over the concatenated stdout+stderr
 * stream is tracked so nothing is re-emitted). Resolves `{ exitCode }` when the
 * command finishes; bounded by `opts.timeoutMs`. A non-zero exit is NOT an
 * error (returned to the caller); a hard timeout / transport error throws
 * SandboxError.
 *
 * NOTE: the logs endpoint returns the FULL log so far on each fetch; we diff
 * against the count already delivered. `onLog` failures are swallowed so a
 * flaky consumer can't abort the run.
 */
export async function runCommandStreaming(
  sessionId: string,
  command: string,
  args: string[],
  opts: {
    onLog: (l: { stream: 'stdout' | 'stderr'; data: string }) => void;
    timeoutMs?: number;
    cwd?: string;
  }
): Promise<{ exitCode: number }> {
  if (!VERCEL_TOKEN) {
    throw new SandboxError(
      'not_configured',
      'VERCEL_TOKEN is not configured on the server — add a Vercel access token to enable sandbox execution'
    );
  }
  if (!sessionId) {
    throw new SandboxError('api_error', 'runCommandStreaming requires a sessionId');
  }
  const timeoutMs = clamp(
    opts?.timeoutMs ?? STREAM_DEFAULT_TIMEOUT_MS,
    STREAM_MIN_TIMEOUT_MS,
    STREAM_MAX_TIMEOUT_MS
  );
  const deadline = Date.now() + timeoutMs;
  const cmdBase = `${SANDBOX_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd`;

  // 1) start non-blocking (also cap sandbox-side via `timeout`).
  const startRes = await vFetch(cmdBase, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      command,
      args: Array.isArray(args) ? args : [],
      cwd: opts?.cwd,
      timeout: timeoutMs,
    }),
  }, CONTROL_TIMEOUT_MS);
  if (!startRes.ok) {
    throw statusToError(
      startRes.status,
      await readErrorBody(startRes),
      `streaming command start (${command})`,
      'exec'
    );
  }
  const started = await readJson(startRes);
  const cmdId =
    typeof started?.command?.id === 'string' ? started.command.id : '';
  if (!cmdId) {
    throw new SandboxError(
      'api_error',
      'Sandbox streaming command start succeeded but returned no command id',
      startRes.status,
      'exec'
    );
  }
  let exitCode: number | null =
    typeof started?.command?.exitCode === 'number'
      ? started.command.exitCode
      : null;

  // Offset over the ordered log lines already handed to onLog.
  let emitted = 0;

  const emitNew = async (): Promise<void> => {
    const lines = await fetchCommandLogLines(sessionId, cmdId);
    for (let i = emitted; i < lines.length; i++) {
      const l = lines[i];
      try {
        opts.onLog(l);
      } catch {
        // a flaky consumer must never abort the sandbox run
      }
    }
    if (lines.length > emitted) emitted = lines.length;
  };

  // 2) poll for exit while tailing logs; emit only the new deltas.
  while (exitCode === null) {
    if (Date.now() >= deadline) {
      // surface whatever we have, then fail with a timeout.
      await emitNew().catch(() => {});
      throw new SandboxError(
        'timeout',
        `Sandbox command "${command}" did not finish within ${timeoutMs}ms`,
        undefined,
        'poll'
      );
    }
    await emitNew().catch(() => {});
    await sleep(STREAM_POLL_INTERVAL_MS);
    const pollRes = await vFetch(
      `${cmdBase}/${encodeURIComponent(cmdId)}`,
      { headers: authHeaders() },
      CONTROL_TIMEOUT_MS
    );
    if (!pollRes.ok) {
      throw statusToError(
        pollRes.status,
        await readErrorBody(pollRes),
        'streaming command poll',
        'poll'
      );
    }
    const polled = await readJson(pollRes);
    if (typeof polled?.command?.exitCode === 'number') {
      exitCode = polled.command.exitCode;
    }
  }

  // 3) final flush — the last log lines may land after exit is observed.
  await emitNew().catch(() => {});
  return { exitCode };
}

/**
 * GET …/cmd/{id}/logs → application/x-ndjson. Each line is
 * `{stream:'stdout'|'stderr', data:string}` (data is plain text — the SDK
 * concatenates it as-is) or `{stream:'error', data:{code,message}}`.
 * Unparseable lines are skipped; fetch failures degrade to a stderr marker.
 */
async function fetchCommandLogs(
  sessionId: string,
  cmdId: string
): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  try {
    const res = await vFetch(
      `${SANDBOX_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd/${encodeURIComponent(cmdId)}/logs`,
      { headers: authHeaders() },
      LOGS_TIMEOUT_MS
    );
    if (!res.ok) {
      logger.warn(`[sandbox] logs fetch non-ok (${res.status})`);
      return { stdout, stderr: `(sandbox logs unavailable: HTTP ${res.status})` };
    }
    const text = await res.text().catch(() => '');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // defensive: skip malformed ndjson lines
      }
      if (parsed?.stream === 'stdout' && typeof parsed.data === 'string') {
        stdout += parsed.data;
      } else if (parsed?.stream === 'stderr' && typeof parsed.data === 'string') {
        stderr += parsed.data;
      } else if (parsed?.stream === 'error') {
        const code = parsed?.data?.code ?? 'error';
        const message = parsed?.data?.message ?? '';
        stderr += `\n[sandbox:${code}] ${message}\n`;
      }
    }
    return { stdout, stderr };
  } catch (err) {
    logger.warn(
      `[sandbox] logs fetch failed: ${(err as Error)?.message ?? String(err)}`
    );
    return {
      stdout,
      stderr:
        stderr ||
        `(failed to fetch sandbox logs: ${(err as Error)?.message ?? 'unknown error'})`,
    };
  }
}

/**
 * Like fetchCommandLogs but returns the ORDERED sequence of parsed log lines
 * (preserving stdout/stderr interleaving) instead of two concatenated blobs —
 * used by runCommandStreaming to tail incrementally by index. The logs
 * endpoint returns the full log so far on each call; the streaming loop diffs
 * against the count already emitted. Malformed lines are skipped; a non-ok /
 * failed fetch returns `[]` (the loop simply re-tails next tick).
 */
async function fetchCommandLogLines(
  sessionId: string,
  cmdId: string
): Promise<{ stream: 'stdout' | 'stderr'; data: string }[]> {
  const out: { stream: 'stdout' | 'stderr'; data: string }[] = [];
  try {
    const res = await vFetch(
      `${SANDBOX_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd/${encodeURIComponent(cmdId)}/logs`,
      { headers: authHeaders() },
      LOGS_TIMEOUT_MS
    );
    if (!res.ok) {
      logger.warn(`[sandbox] stream logs fetch non-ok (${res.status})`);
      return out;
    }
    const text = await res.text().catch(() => '');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // defensive: skip malformed ndjson lines
      }
      if (parsed?.stream === 'stdout' && typeof parsed.data === 'string') {
        out.push({ stream: 'stdout', data: parsed.data });
      } else if (parsed?.stream === 'stderr' && typeof parsed.data === 'string') {
        out.push({ stream: 'stderr', data: parsed.data });
      } else if (parsed?.stream === 'error') {
        const code = parsed?.data?.code ?? 'error';
        const message = parsed?.data?.message ?? '';
        out.push({ stream: 'stderr', data: `\n[sandbox:${code}] ${message}\n` });
      }
    }
    return out;
  } catch (err) {
    logger.warn(
      `[sandbox] stream logs fetch failed: ${(err as Error)?.message ?? String(err)}`
    );
    return out;
  }
}

// ---------------------------------------------------------------------------
// File reads / listing (C4) — via runCommand (dep-free; no fs REST needed)
// ---------------------------------------------------------------------------

/**
 * Read a text file back out of the sandbox (C4 editor round-trip). Uses
 * `cat <path>` via the existing runner (the SDK's own filesystem helpers shell
 * out the same way; the fs/read REST endpoint returns octet-stream and is only
 * needed for binary fidelity). Returns the file text, or an EMPTY STRING when
 * the file is missing / unreadable (non-zero cat exit) so the editor degrades
 * gracefully rather than throwing. Real transport/timeout failures from the
 * underlying runCommand still propagate as SandboxError.
 */
export async function readFile(
  sessionId: string,
  path: string
): Promise<string> {
  if (!sessionId || !path) return '';
  const target = shellQuote(path);
  const result = await runCommand(
    sessionId,
    'bash',
    ['-c', `cat ${target}`],
    { timeoutMs: READ_FILE_TIMEOUT_MS }
  );
  // Missing file / permission error → cat exits non-zero; treat as empty.
  if (result.exitCode !== 0) return '';
  return result.stdout;
}

/**
 * Enumerate files in the sandbox for the file-tree (C4). Runs
 * `find <cwd> -type f -not -path './node_modules/*' -not -path './.git/*'`
 * (mirrors the SDK's readdir approach — there is no fs/list REST endpoint),
 * caps the result set (~500 by default), and returns `{ path }[]`. `bytes` is
 * intentionally omitted here to keep this a single cheap `find` (the caller can
 * stat individually if it needs sizes). Defensive: a non-zero find exit or
 * empty output yields `[]`.
 */
export async function listFiles(
  sessionId: string,
  opts?: { cwd?: string; max?: number }
): Promise<{ path: string; bytes?: number }[]> {
  if (!sessionId) return [];
  const cwd = opts?.cwd && opts.cwd.trim() ? opts.cwd.trim() : '.';
  const max =
    Number.isInteger(opts?.max) && (opts!.max as number) > 0
      ? (opts!.max as number)
      : LIST_FILES_DEFAULT_MAX;
  const dir = shellQuote(cwd);
  // Single quotes preserve the literal glob patterns for find (no shell expand).
  const script =
    `find ${dir} -type f ` +
    `-not -path '*/node_modules/*' ` +
    `-not -path '*/.git/*'`;
  const result = await runCommand(
    sessionId,
    'bash',
    ['-c', script],
    { timeoutMs: LIST_FILES_TIMEOUT_MS }
  );
  if (result.exitCode !== 0) return [];
  const out: { path: string; bytes?: number }[] = [];
  for (const raw of result.stdout.split('\n')) {
    const p = raw.trim();
    if (!p) continue;
    out.push({ path: p });
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// File writes — base64 command method (NOT the SDK's tar fs/write endpoint)
// ---------------------------------------------------------------------------

/**
 * Write `content` (utf8) to `path` inside the sandbox by piping base64
 * through `base64 -d` in bash. Chunked at 64KiB of base64 per command (chunk
 * length is a multiple of 4, so each decodes standalone; chunk 1 truncates
 * with `>`, later chunks append with `>>`) to stay far under bash ARG_MAX.
 * Throws SandboxError when any chunk command exits non-zero.
 */
export async function writeFile(
  sessionId: string,
  path: string,
  content: string
): Promise<void> {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const target = shellQuote(path);
  const chunks: string[] = [];
  if (b64.length === 0) {
    chunks.push(''); // still create the (empty) file
  }
  for (let i = 0; i < b64.length; i += WRITE_CHUNK_B64_CHARS) {
    chunks.push(b64.slice(i, i + WRITE_CHUNK_B64_CHARS));
  }
  for (let i = 0; i < chunks.length; i++) {
    // base64 alphabet ([A-Za-z0-9+/=]) is shell-safe inside single quotes.
    const script =
      i === 0
        ? `mkdir -p "$(dirname ${target})" && printf %s '${chunks[i]}' | base64 -d > ${target}`
        : `printf %s '${chunks[i]}' | base64 -d >> ${target}`;
    const result = await runCommand(sessionId, 'bash', ['-c', script], {
      timeoutMs: WRITE_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new SandboxError(
        'api_error',
        `Sandbox writeFile failed for ${path} (exit ${result.exitCode}): ${result.stderr.slice(0, UPSTREAM_MSG_CAP)}`,
        undefined,
        'write',
        result.stderr.slice(0, UPSTREAM_MSG_CAP)
      );
    }
  }
}

/**
 * Convenience multi-file write (C4, dep-free) — loops writeFile per entry
 * (the recon deliberately keeps the base64 approach over the SDK's tar
 * fs/write). Writes sequentially so a failure reports the exact offending
 * path; propagates the first SandboxError.
 */
export async function writeFiles(
  sessionId: string,
  files: { path: string; content: string }[]
): Promise<void> {
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.path !== 'string') continue;
    await writeFile(sessionId, f.path, typeof f.content === 'string' ? f.content : '');
  }
}

// ---------------------------------------------------------------------------
// R9 SONDE — LIVE health probe. This is the diagnostic Fateh needs: it exercises
// the FULL lifecycle (create → echo 'ok' → teardown) against the real Vercel API
// under a hard 60s budget and reports EXACTLY where it broke, with the VERBATIM
// upstream error. Consumed by the thin controller route
// GET /api/v1/openclaw/sandbox/health (see clickdz-openclaw.controller.ts). It
// deliberately bypasses the capability CACHE (every call hits live) and NEVER
// throws — a failure is returned as { ok:false, stage, ms, error, detail } so
// the route can 200 the diagnostic even when the sandbox itself is broken. Token
// material is never included (createSession/runCommand/stopSession never echo it,
// and SandboxError.bodyPreview is the RESPONSE body, not our request headers).
// ---------------------------------------------------------------------------

/** Overall wall-clock budget for the health probe (contract: 60s). */
const HEALTH_PROBE_BUDGET_MS = 60_000;
/** The health sandbox is short-lived; keep it well above the probe budget so it
 * can only ever be freed by our explicit teardown (never linger). */
const HEALTH_SESSION_TIMEOUT_MS = 120_000;
/** The echo command's own budget (bounded by remaining wall clock at call time). */
const HEALTH_EXEC_TIMEOUT_MS = 20_000;
/** Teardown budget (also bounded by remaining wall clock). */
const HEALTH_TEARDOWN_TIMEOUT_MS = 8_000;
/** The sentinel the echo must print for a green result. */
const HEALTH_ECHO_TOKEN = 'ok';

/** The lifecycle stage the health probe reached (contract-mandated set). */
export type SandboxHealthStage = 'create' | 'exec' | 'teardown' | 'done';

export interface SandboxHealthResult {
  ok: boolean;
  stage: SandboxHealthStage;
  ms: number;
  // VERBATIM upstream error string (empty/omitted on success). This is the field
  // that lets us read the REAL prod failure through the health route.
  error?: string;
  // D2 FIX (R16) — coarse, FE-facing failure reason (at_capacity / billing /
  // auth / timeout / unknown), present on failures only. Additive: the
  // create → exec → teardown shape is unchanged; this just lets the FE "test"
  // button show an honest message (e.g. "at capacity, retry shortly" on a 429,
  // "billing" on a 402) by reading ONE field instead of decoding `detail.code`.
  // The full typed breakdown is still in `detail`.
  reason?: SandboxFailureReason;
  // Structured breakdown when the failure was a typed SandboxError.
  detail?: {
    code: SandboxErrorCode;
    stage?: SandboxStage;
    status?: number;
    bodyPreview?: string;
  };
  // Runtime the create leg actually provisioned (diagnostic only).
  runtime?: string;
}

/**
 * Pull the most VERBATIM upstream string available off an error: for a
 * SandboxError prefer the raw upstream body (bodyPreview) — that is the literal
 * text Vercel returned — falling back to the composed message; for anything else
 * the raw message/String(). Never token material.
 */
function verbatimError(err: unknown): string {
  if (err instanceof SandboxError) {
    return err.bodyPreview || err.message || 'sandbox_error';
  }
  const m = (err as Error)?.message;
  return (typeof m === 'string' && m) || String(err) || 'unknown_error';
}

/**
 * Run a minimal create → echo('ok') → teardown against the LIVE Vercel Sandbox
 * API and report the outcome. Optional `opts.runtime` overrides the runtime
 * (defaults to node24). Never throws. On any failure the returned `stage` is the
 * leg that broke ('create' | 'exec' | 'teardown') and `error` is the verbatim
 * upstream string; a fully green run returns { ok:true, stage:'done' }.
 */
export async function sandboxHealthProbe(opts?: {
  runtime?: string;
}): Promise<SandboxHealthResult> {
  const startedAt = Date.now();
  const deadline = startedAt + HEALTH_PROBE_BUDGET_MS;
  const remaining = () => deadline - Date.now();
  const elapsed = () => Date.now() - startedAt;

  // Fail fast (still structured) when the token isn't even configured — no point
  // provisioning. Mirrors the not_configured contract used elsewhere.
  if (!VERCEL_TOKEN) {
    return {
      ok: false,
      stage: 'create',
      ms: elapsed(),
      error:
        'VERCEL_TOKEN is not configured on the server — add a Vercel access token to enable sandbox execution',
      // D2 — not_configured folds into the coarse 'auth' reason for the FE.
      reason: 'auth',
      detail: { code: 'not_configured', stage: 'create' },
    };
  }

  let sessionId = '';
  let runtime: string | undefined;

  // ---- 1) CREATE ----------------------------------------------------------
  try {
    const session = await createSession({
      runtime: opts?.runtime,
      timeoutMs: HEALTH_SESSION_TIMEOUT_MS,
    });
    sessionId = session.sessionId;
    runtime = session.runtime;
  } catch (err) {
    const detail =
      err instanceof SandboxError ? err.toStructured() : undefined;
    // D2 — the CREATE leg is where a 429 (at_capacity) / 402 (billing) surfaces;
    // attach the coarse reason so the health route reports it distinctly.
    const { reason } = describeSandboxError(err);
    return {
      ok: false,
      stage: 'create',
      ms: elapsed(),
      error: verbatimError(err),
      reason,
      ...(detail
        ? {
            detail: {
              code: detail.code,
              ...(detail.stage ? { stage: detail.stage } : {}),
              ...(typeof detail.status === 'number'
                ? { status: detail.status }
                : {}),
              ...(detail.bodyPreview ? { bodyPreview: detail.bodyPreview } : {}),
            },
          }
        : {}),
    };
  }

  // From here on a session EXISTS. We compute the exec outcome into `execFailure`
  // (null = green) WITHOUT early-returning, so the teardown below ALWAYS runs and
  // the health VM can never leak — exactly the teardown-leak failure mode we're
  // hunting. Only after teardown do we shape the final result.
  let execFailure: SandboxHealthResult | null = null;

  // ---- 2) EXEC echo 'ok' --------------------------------------------------
  if (remaining() <= 0) {
    execFailure = {
      ok: false,
      stage: 'exec',
      ms: elapsed(),
      error: `health probe exceeded its ${HEALTH_PROBE_BUDGET_MS}ms budget before exec`,
      runtime,
    };
  } else {
    const execBudget = Math.max(
      MIN_COMMAND_TIMEOUT_MS,
      Math.min(HEALTH_EXEC_TIMEOUT_MS, remaining())
    );
    try {
      const out = await runCommand(sessionId, 'echo', [HEALTH_ECHO_TOKEN], {
        timeoutMs: execBudget,
      });
      // The command ran — did it actually succeed + echo our sentinel?
      if (out.exitCode !== 0 || out.stdout.trim() !== HEALTH_ECHO_TOKEN) {
        execFailure = {
          ok: false,
          stage: 'exec',
          ms: elapsed(),
          error: `echo '${HEALTH_ECHO_TOKEN}' returned exit=${out.exitCode} stdout=${JSON.stringify(
            out.stdout.slice(0, 120)
          )} stderr=${JSON.stringify(out.stderr.slice(0, 120))}`,
          runtime,
        };
      }
    } catch (err) {
      const d = err instanceof SandboxError ? err.toStructured() : undefined;
      // D2 — an exec-time 429 (control-plane rate limit) also maps to a coarse
      // reason for the FE.
      const { reason } = describeSandboxError(err);
      execFailure = {
        ok: false,
        stage: 'exec',
        ms: elapsed(),
        error: verbatimError(err),
        reason,
        runtime,
        ...(d
          ? {
              detail: {
                code: d.code,
                ...(d.stage ? { stage: d.stage } : {}),
                ...(typeof d.status === 'number' ? { status: d.status } : {}),
                ...(d.bodyPreview ? { bodyPreview: d.bodyPreview } : {}),
              },
            }
          : {}),
      };
    }
  }

  // ---- 3) TEARDOWN (ALWAYS runs; its failure is REPORTED) -----------------
  // stopSession swallows errors by contract, so to SURFACE a teardown fault we
  // issue the stop directly with a bounded timeout and inspect the response. A
  // failure here still leaves the VM to auto-expire at its create-time timeout.
  let teardownError = '';
  let teardownDetail: SandboxHealthResult['detail'];
  try {
    const stopBudget = Math.max(
      1,
      Math.min(HEALTH_TEARDOWN_TIMEOUT_MS, remaining())
    );
    const res = await vFetch(
      `${SANDBOX_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: 'POST', headers: authHeaders() },
      stopBudget
    );
    if (!res.ok) {
      const body = await readErrorBody(res);
      const e = statusToError(res.status, body, 'session stop', 'stop');
      teardownError = e.bodyPreview || e.message;
      teardownDetail = {
        code: e.code,
        ...(e.stage ? { stage: e.stage } : {}),
        ...(typeof e.status === 'number' ? { status: e.status } : {}),
        ...(e.bodyPreview ? { bodyPreview: e.bodyPreview } : {}),
      };
    }
  } catch (err) {
    teardownError = verbatimError(err);
  }

  // ---- shape the final result: exec failure takes precedence (it happened
  // first + is the more actionable signal), then teardown failure, else green.
  if (execFailure) return execFailure;
  if (teardownError) {
    return {
      ok: false,
      stage: 'teardown',
      ms: elapsed(),
      error: teardownError,
      runtime,
      ...(teardownDetail ? { detail: teardownDetail } : {}),
    };
  }
  return { ok: true, stage: 'done', ms: elapsed(), runtime };
}
