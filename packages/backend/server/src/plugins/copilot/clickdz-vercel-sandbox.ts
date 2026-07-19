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
 *      POST /v2/sandboxes                          create { projectId, runtime, timeout }
 *      GET  /v2/sandboxes?project=…&limit=1        cheap list (capability probe)
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
 */

// --- env (read once at module load, same idiom as the bridge's VERCEL_TOKEN) ---
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';

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
const CAPABILITY_OK_TTL_MS = 300_000;
const CAPABILITY_FAIL_TTL_MS = 60_000;

const logger = new Logger('ClickDzVercelSandbox');

// ---------------------------------------------------------------------------
// Typed error — callers (OPENCLAW) branch on `code`:
//   not_configured | not_enabled  → "sandbox unavailable" (degrade gracefully)
//   api_error | timeout           → runtime failure (feed back to the planner)
// ---------------------------------------------------------------------------
export type SandboxErrorCode =
  | 'not_configured'
  | 'not_enabled'
  | 'api_error'
  | 'timeout';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly status?: number;

  constructor(code: SandboxErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.status = status;
  }
}

export interface SandboxSession {
  sessionId: string;
  runtime: string;
}

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
 * 401/402/403 all normalize to `not_enabled` (auth/plan/feature gate) so the
 * capability probe surfaces one actionable "not enabled" state to the UI.
 */
function statusToError(
  status: number,
  data: any,
  context: string
): SandboxError {
  const detail = upstreamMessage(data);
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401) {
    return new SandboxError(
      'not_enabled',
      `Vercel rejected the configured token (HTTP 401) — check VERCEL_TOKEN${suffix}`,
      status
    );
  }
  if (status === 402 || status === 403) {
    return new SandboxError(
      'not_enabled',
      `Vercel Sandbox is not enabled for this account (HTTP ${status}) — enable it in the Vercel dashboard${suffix}`,
      status
    );
  }
  return new SandboxError(
    'api_error',
    `Vercel ${context} failed (HTTP ${status})${suffix}`,
    status
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

// ---------------------------------------------------------------------------
// Project ensure (create-or-get "clickdz-openclaw") — cached module-level
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
      'Vercel project lookup succeeded but returned no project id'
    );
  }
  if (getRes.status !== 404) {
    throw statusToError(getRes.status, await readJson(getRes), 'project lookup');
  }
  // 2) 404 → POST /v10/projects to create it.
  const createRes = await vFetch(`${PROJECTS_API_BASE}/v10/projects`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ name: SANDBOX_PROJECT_NAME }),
  }, CONTROL_TIMEOUT_MS);
  const created = await readJson(createRes);
  if (createRes.ok) {
    const id = typeof created?.id === 'string' ? created.id : '';
    if (id) return id;
    throw new SandboxError(
      'api_error',
      'Vercel project create succeeded but returned no project id'
    );
  }
  if (createRes.status === 409) {
    // Lost a create race (another replica made it) — re-GET once.
    const retryRes = await vFetch(
      `${PROJECTS_API_BASE}/v9/projects/${encodeURIComponent(SANDBOX_PROJECT_NAME)}`,
      { headers: authHeaders() },
      CONTROL_TIMEOUT_MS
    );
    const retried = await readJson(retryRes);
    const id = typeof retried?.id === 'string' ? retried.id : '';
    if (retryRes.ok && id) return id;
    throw statusToError(retryRes.status, retried, 'project lookup (after 409)');
  }
  throw statusToError(createRes.status, created, 'project create');
}

// ---------------------------------------------------------------------------
// Capability probe — NEVER throws
// ---------------------------------------------------------------------------

let capabilityCache: {
  at: number;
  result: { sandbox: boolean; reason?: string };
} | null = null;

/**
 * Ensure the dedicated project exists, then hit the Sandbox API surface with
 * the cheapest possible call (list sandboxes, limit=1). A 402/403 anywhere
 * means the feature/plan gate is closed → `{ sandbox:false, reason }` with an
 * actionable message. Never throws; results are briefly cached.
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
    if (now - capabilityCache.at < ttl) return capabilityCache.result;
  }
  const result = await probeCapability();
  capabilityCache = { at: now, result };
  return result;
}

async function probeCapability(): Promise<{
  sandbox: boolean;
  reason?: string;
}> {
  try {
    if (!VERCEL_TOKEN) {
      return {
        sandbox: false,
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
    throw statusToError(res.status, await readJson(res), 'sandbox probe');
  } catch (err) {
    const reason =
      err instanceof SandboxError
        ? err.message
        : `Vercel Sandbox check failed: ${(err as Error)?.message ?? String(err)}`;
    logger.warn(`[sandbox] capability probe negative: ${reason}`);
    return { sandbox: false, reason };
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
  const data = await readJson(res);
  if (!res.ok) {
    throw statusToError(res.status, data, 'sandbox create');
  }
  const sessionId = typeof data?.session?.id === 'string' ? data.session.id : '';
  if (!sessionId) {
    throw new SandboxError(
      'api_error',
      'Vercel sandbox create succeeded but returned no session id'
    );
  }
  const actualRuntime =
    typeof data?.session?.runtime === 'string' ? data.session.runtime : runtime;
  logger.log(`[sandbox] session created: runtime=${actualRuntime}`);
  return { sessionId, runtime: actualRuntime };
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
  const started = await readJson(startRes);
  if (!startRes.ok) {
    throw statusToError(startRes.status, started, `command start (${command})`);
  }
  const cmdId =
    typeof started?.command?.id === 'string' ? started.command.id : '';
  if (!cmdId) {
    throw new SandboxError(
      'api_error',
      'Sandbox command start succeeded but returned no command id'
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
        `Sandbox command "${command}" did not finish within ${timeoutMs}ms`
      );
    }
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await vFetch(
      `${cmdBase}/${encodeURIComponent(cmdId)}`,
      { headers: authHeaders() },
      CONTROL_TIMEOUT_MS
    );
    const polled = await readJson(pollRes);
    if (!pollRes.ok) {
      throw statusToError(pollRes.status, polled, 'command poll');
    }
    if (typeof polled?.command?.exitCode === 'number') {
      exitCode = polled.command.exitCode;
    }
  }

  // 3) logs (ndjson) — tolerant: a log-fetch hiccup must not lose the exit code.
  const { stdout, stderr } = await fetchCommandLogs(sessionId, cmdId);
  return { exitCode, stdout, stderr };
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
        `Sandbox writeFile failed for ${path} (exit ${result.exitCode}): ${result.stderr.slice(0, UPSTREAM_MSG_CAP)}`
      );
    }
  }
}
