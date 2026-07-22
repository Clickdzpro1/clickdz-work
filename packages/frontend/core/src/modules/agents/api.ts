import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';

import type {
  AgentEvent,
  AgentName,
  AgentRunRecord,
  AgentRunSummary,
  AgentsListResponse,
  AgentThread,
  AgentThreadSummary,
} from './types';

/**
 * Typed REST client for the ClickDz agent consoles (HERMES + OPENCLAW).
 *
 * Every request goes through {@link cdzApiUrl} so desktop/native builds (whose
 * renderer origin is `assets://.` / `file://`) resolve `/api/...` against the
 * connected server, while web stays same-origin. `credentials: 'include'` keeps
 * the session cookie on the request — the backend authenticates every route via
 * the global AuthGuard (`@CurrentUser()`), so no custom header is needed (the
 * same rule the streaming endpoints follow). This mirrors the request idiom of
 * the neighboring vdz hooks (use-vdz-projects.ts).
 *
 * The live SSE run stream is NOT here — that is fetched with a ReadableStream
 * reader in use-agent-stream.ts. This module covers only the JSON side:
 * thread CRUD, capabilities, stop, approval, and (OPENCLAW) file listing/read.
 *
 * All functions parse defensively and throw a typed {@link AgentApiError} with a
 * human-readable message on any non-2xx or network failure, so callers can
 * surface `err.message` verbatim.
 */

/** Base path for an agent's v1 API (e.g. `/api/v1/hermes`). */
function base(agent: AgentName): string {
  return `/api/v1/${agent}`;
}

/**
 * Base path for the R6 background-run API (e.g. `/api/v1/agents/hermes/runs`).
 * This is a SEPARATE controller from {@link base} (note the plural `agents`
 * segment): the fixed console lives under `/api/v1/<agent>` while durable runs
 * live under `/api/v1/agents/<agent>/runs`, gated by `CDZ_AGENTS_ENABLED` on the
 * backend (a typed 404 when the flag is off — callers flag-detect on
 * {@link AgentApiError.status} === 404).
 */
function runsBase(agent: AgentName): string {
  return `/api/v1/agents/${agent}/runs`;
}

/**
 * Error thrown by every function in this module on a failed request. Carries the
 * HTTP status (0 for a network/transport failure) alongside the message so a
 * caller can branch (e.g. 401 → signed out) without string-matching.
 */
export class AgentApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AgentApiError';
    this.status = status;
  }
}

/**
 * Pull a human-readable message out of an AFFiNE typed-error JSON body, falling
 * back to status text. Mirrors the `readError` helper in use-vdz-projects.ts so
 * the 400/401/404 messages surface verbatim to the user.
 */
async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as any;
    const msg =
      data?.message ??
      data?.error?.message ??
      (typeof data?.error === 'string' ? data.error : undefined);
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch {
    // ignore — fall through to status text
  }
  return res.statusText || `Request failed (${res.status})`;
}

/**
 * Fetch JSON with cookies, throwing {@link AgentApiError} on transport failure
 * or a non-2xx response. Empty 2xx bodies (e.g. a 204 from DELETE) resolve to
 * `undefined` cast to `T` — callers that ignore the value are unaffected.
 */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(path), {
      credentials: 'include',
      ...init,
    });
  } catch (cause) {
    throw new AgentApiError(
      cause instanceof Error && cause.message
        ? `Network error: ${cause.message}`
        : 'Network error while contacting the agent service.',
      0
    );
  }
  if (!res.ok) {
    throw new AgentApiError(await readError(res), res.status);
  }
  // Some endpoints (DELETE/stop/approve) may return an empty body or a small
  // envelope; tolerate both — a parse failure on a 2xx is treated as "no body".
  const text = await res.text();
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as unknown as T;
  }
}

const jsonHeaders = { 'Content-Type': 'application/json' } as const;

// ── Thread CRUD ──────────────────────────────────────────────────────────────

/** List the signed-in user's threads for an agent (compact rows). */
export async function listThreads(
  agent: AgentName
): Promise<AgentThreadSummary[]> {
  const rows = await requestJson<AgentThreadSummary[]>(
    `${base(agent)}/threads`
  );
  return Array.isArray(rows) ? rows : [];
}

/** Load one full thread (messages included) by id. */
export function getThread(
  agent: AgentName,
  id: string
): Promise<AgentThread> {
  return requestJson<AgentThread>(
    `${base(agent)}/threads/${encodeURIComponent(id)}`
  );
}

/** Rename a thread. Returns the updated summary when the server sends one. */
export function renameThread(
  agent: AgentName,
  id: string,
  title: string
): Promise<AgentThreadSummary> {
  return requestJson<AgentThreadSummary>(
    `${base(agent)}/threads/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ title }),
    }
  );
}

/** Delete a thread (and, for OPENCLAW, best-effort stop its sandbox server-side). */
export async function deleteThread(
  agent: AgentName,
  id: string
): Promise<void> {
  await requestJson<{ deleted?: boolean }>(
    `${base(agent)}/threads/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
}

// ── Capabilities ─────────────────────────────────────────────────────────────

/**
 * Fetch an agent's capabilities (tool/connection catalog, planner + streaming
 * readiness, sandbox availability). The shape is agent-specific and evolves, so
 * it is returned loosely typed for the connections/status panels to read
 * defensively.
 */
export function getCapabilities(
  agent: AgentName
): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>(`${base(agent)}/capabilities`);
}

// ── Telegram channel pairing ──────────────────────────────────────────────────

/** Envelope returned by {@link pairTelegram}. */
export interface TelegramPairResult {
  /** One-shot pairing code (10 min TTL server-side); embedded in `deepLink`. */
  code: string;
  /**
   * `t.me/<bot>?start=<code>` deep link the UI turns into a tappable link / copy.
   * Empty string when the bot username can't be resolved yet (token half-set) —
   * treat an empty `deepLink` the same as the dark state (no live pairing).
   */
  deepLink: string;
  /** The bot's @username, or null when no bot token is configured. */
  botUsername: string | null;
}

/**
 * Mint a one-shot Telegram pairing deep link for the signed-in user
 * (`GET /api/v1/agents/telegram/pair`). The user opens {@link
 * TelegramPairResult.deepLink} and taps Start; the backend webhook binds their
 * chat. Gated by `CDZ_AGENT_TELEGRAM_ENABLED` on the backend — throws {@link
 * AgentApiError} with `.status === 404` when the channel is dark (no bot
 * configured), so the connections UI shows a quiet "bientôt disponible" state
 * rather than an error. `.status === 400` means Redis couldn't store the code
 * (the caller should offer a retry).
 */
export function pairTelegram(): Promise<TelegramPairResult> {
  return requestJson<TelegramPairResult>('/api/v1/agents/telegram/pair');
}

// ── Telegram channel (R10 BYOT: per-user bot ↔ agent) ─────────────────────────
//
// A CHANNEL is different from the R7 pairing above: instead of pairing a chat to
// ONE global platform bot, each user connects their OWN Telegram bot (created in
// BotFather) to a SPECIFIC agent. The token is validated + sealed at rest on the
// backend; inbound messages from that bot route to this user + agent. These wrap
// Trousseau's R10 channel routes under {@link base} (note: `/api/v1/<agent>/…`,
// the FIXED-console controller, NOT the plural `agents` runs/triggers segment):
//   POST   /api/v1/<agent>/channels/telegram/connect      {token}
//   GET    /api/v1/<agent>/channels/telegram
//   POST   /api/v1/<agent>/channels/telegram/disconnect
//   POST   /api/v1/<agent>/channels/telegram/test
// gated by `CDZ_AGENT_TELEGRAM_ENABLED` (+ a configured secret box) — dark ⇒ the
// routes 404. A status read NEVER carries the token (the backend strips it).

/**
 * The Telegram channel status for one agent (`GET .../channels/telegram`). The
 * token is NEVER included — only whether a bot is connected and, if so, its
 * @username and when it was connected. Optional fields tolerate a partial /
 * evolving payload so the UI never crashes on an older record.
 */
export interface TelegramChannelStatus {
  /** Whether the user has a bot connected to this agent. */
  connected: boolean;
  /** The connected bot's @username (without the leading @), when connected. */
  botUsername?: string;
  /** When the bot was connected (backend timestamp), when connected. */
  connectedAt?: string;
}

/**
 * Connect the signed-in user's Telegram bot to `agent`
 * (`POST /api/v1/<agent>/channels/telegram/connect`). `token` is the BotFather
 * token; the backend validates it via getMe, sets the webhook, and seals it at
 * rest. Returns the bot identity so the UI can confirm which bot was linked.
 * Throws {@link AgentApiError} — notably `.status === 400` (message
 * `invalid_token`) on a bad token, and `.status === 404` when the channels
 * feature is dark (so the caller can fall back to a "bientôt" state).
 */
export function connectTelegram(
  agent: AgentName,
  token: string
): Promise<{ ok: boolean; botUsername: string; botId: number }> {
  return requestJson<{ ok: boolean; botUsername: string; botId: number }>(
    `${base(agent)}/channels/telegram/connect`,
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ token }),
    }
  );
}

/**
 * Read the Telegram channel status for `agent`
 * (`GET /api/v1/<agent>/channels/telegram`). Fail-soft: a `.status === 404`
 * (feature dark OR no connection) is mapped to a disconnected status
 * (`{ connected: false }`) rather than thrown — so a channel card renders a
 * quiet not-connected / "bientôt" state instead of an error. Any OTHER failure
 * (401 signed-out, network, 5xx) still throws {@link AgentApiError}. Never
 * returns the token.
 */
export async function getTelegramChannel(
  agent: AgentName
): Promise<TelegramChannelStatus> {
  try {
    const res = await requestJson<TelegramChannelStatus>(
      `${base(agent)}/channels/telegram`
    );
    return res && typeof res === 'object'
      ? res
      : { connected: false };
  } catch (err) {
    if (err instanceof AgentApiError && err.status === 404) {
      return { connected: false };
    }
    throw err;
  }
}

/**
 * Disconnect the user's Telegram bot from `agent`
 * (`POST /api/v1/<agent>/channels/telegram/disconnect`). The backend deletes the
 * webhook and the sealed token. Idempotent server-side. Throws {@link
 * AgentApiError} only on a transport/HTTP failure.
 */
export async function disconnectTelegram(agent: AgentName): Promise<void> {
  await requestJson<{ ok?: boolean }>(
    `${base(agent)}/channels/telegram/disconnect`,
    {
      method: 'POST',
      headers: jsonHeaders,
    }
  );
}

/**
 * Send a test message to the user's bound chat for `agent`
 * (`POST /api/v1/<agent>/channels/telegram/test`). `sent` is `false` when the
 * bot is connected but the user hasn't messaged it yet (no bound chat) — the UI
 * uses that to tell the user to message the bot first. Throws {@link
 * AgentApiError} on a transport/HTTP failure.
 */
export function testTelegram(
  agent: AgentName
): Promise<{ ok: boolean; sent: boolean }> {
  return requestJson<{ ok: boolean; sent: boolean }>(
    `${base(agent)}/channels/telegram/test`,
    {
      method: 'POST',
      headers: jsonHeaders,
    }
  );
}


// ── Run control ──────────────────────────────────────────────────────────────

/**
 * Cooperatively stop the run on a thread. The backend sets a stop flag the run
 * loop checks each iteration; the live stream also aborts client-side (see
 * use-agent-stream). Safe to call when nothing is running.
 */
export async function stopRun(
  agent: AgentName,
  threadId: string
): Promise<void> {
  await requestJson<unknown>(`${base(agent)}/stop`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ threadId }),
  });
}

/**
 * Resolve a pending `approval_request` for a paused run. `decision` is
 * `'approve'` to let the consequential tool proceed or `'deny'` to skip it.
 */
export async function approve(
  agent: AgentName,
  threadId: string,
  approvalId: string,
  decision: 'approve' | 'deny'
): Promise<void> {
  await requestJson<unknown>(`${base(agent)}/approve`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ threadId, approvalId, decision }),
  });
}

// ── OPENCLAW workspace files ─────────────────────────────────────────────────

/** A file entry in an OPENCLAW thread's sandbox (for the file-tree panel). */
export interface AgentFileEntry {
  path: string;
  bytes?: number;
  language?: string;
}

/** Contents of a single file read from an OPENCLAW thread's sandbox. */
export interface AgentFileContent {
  path: string;
  content: string;
  language?: string;
}

/**
 * List files in an OPENCLAW thread's persistent sandbox. OPENCLAW only — throws
 * {@link AgentApiError} for agents/threads without a sandbox. Returns `[]` if
 * the server sends a non-array body.
 */
export async function listFiles(threadId: string): Promise<AgentFileEntry[]> {
  const rows = await requestJson<AgentFileEntry[]>(
    `/api/v1/openclaw/threads/${encodeURIComponent(threadId)}/files`
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Read one file from an OPENCLAW thread's persistent sandbox. OPENCLAW only.
 * `path` is sent as a query parameter (matches the backend `?path=` route).
 */
export function readFile(
  threadId: string,
  path: string
): Promise<AgentFileContent> {
  return requestJson<AgentFileContent>(
    `/api/v1/openclaw/threads/${encodeURIComponent(
      threadId
    )}/file?path=${encodeURIComponent(path)}`
  );
}

// ── R6 background runs ────────────────────────────────────────────────────────
//
// Durable, detached agent runs (Phase 2): a run is started once (POST), then
// executed by a BullMQ worker on the backend so it survives the browser
// disconnecting. The client attaches to `/runs/:id/stream` (fetch-SSE, same
// transport as the console stream — see {@link openAgentRunStream}); on
// re-attach the backend REPLAYS the recorded event list before live-attaching,
// so a page reload / tab-return reconstructs the full timeline. The JSON side
// (start / list / get / stop / approve) lives here; the durable stream is driven
// by the `useAgentRunStream` hook in use-agent-stream.ts via
// {@link openAgentRunStream}.
//
// Every route is gated by `CDZ_AGENTS_ENABLED` on the backend: when the flag is
// off the controller is absent and requests 404. `listAgentRuns` therefore
// doubles as a capability probe — a caller catches {@link AgentApiError} and
// treats `.status === 404` as "feature off" (hide the UI), byte-identically to
// the pre-R6 build.

/** Envelope returned by {@link startBackgroundRun}. */
export interface StartRunResult {
  runId: string;
}

/**
 * Start a background run for an agent. The backend enqueues the run and returns
 * its `runId` immediately (the loop executes detached on a worker); attach to
 * the live stream with {@link openAgentRunStream} / the `useAgentRunStream` hook.
 * Optionally continues an existing `threadId` (otherwise the backend mints one).
 *
 * Throws {@link AgentApiError} on failure — notably `.status === 404` when
 * `CDZ_AGENTS_ENABLED` is off (feature dark) and `.status === 429` when the
 * per-user daily run cap is hit, so callers can branch on the status.
 */
export function startBackgroundRun(
  agent: AgentName,
  prompt: string,
  threadId?: string
): Promise<StartRunResult> {
  return requestJson<StartRunResult>(`${runsBase(agent)}`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ prompt, threadId }),
  });
}

/**
 * List the signed-in user's background runs for an agent, newest first. `limit`
 * caps the number of rows the backend returns (default server-side). Throws
 * {@link AgentApiError} — a `.status === 404` means the runs feature is off, so
 * callers can flag-detect and hide the section. Returns `[]` if the server sends
 * a non-array body.
 */
export async function listAgentRuns(
  agent: AgentName,
  limit?: number
): Promise<AgentRunSummary[]> {
  const qs =
    typeof limit === 'number' && Number.isFinite(limit)
      ? `?limit=${encodeURIComponent(String(Math.floor(limit)))}`
      : '';
  const rows = await requestJson<AgentRunSummary[]>(`${runsBase(agent)}${qs}`);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Fetch the agent roster + capability flags (`GET /api/v1/agents`, R7). Returns
 * the {@link AgentsListResponse} envelope — the roster rows plus the top-level
 * `caps` object the unified `/agents` UI gates on. Like {@link listAgentRuns},
 * this doubles as a capability probe: the route is gated by `CDZ_AGENTS_ENABLED`
 * on the backend, so when the feature is dark the controller is absent and this
 * throws {@link AgentApiError} with `.status === 404`. The caller
 * (`useAgents()`) catches that and treats agents as disabled (hides the unified
 * UI) — this function itself THROWS on 404, exactly like the other helpers here.
 */
export function listAgents(): Promise<AgentsListResponse> {
  return requestJson<AgentsListResponse>(`/api/v1/agents`);
}

// ── Agent triggers (R8: scheduled + webhook) ──────────────────────────────────
//
// A trigger turns an agent into something that runs ITSELF: on a preset schedule
// (a backend cron sweep fires it) or on an inbound webhook POST. These helpers
// wrap the Horloge trigger controller (SEPARATE from the run console — note the
// plural `agents` segment): CRUD under `/api/v1/agents/:agent/triggers`, gated by
// `CDZ_AGENT_TRIGGERS_ENABLED` (+ `CDZ_AGENTS_ENABLED`) on the backend. Like
// {@link listAgentRuns}, each doubles as a capability probe — a caller catches
// {@link AgentApiError} and treats `.status === 404` as "feature off" (hide the
// UI). The wire record mirrors the backend `view(rec)` shape EXACTLY (the record
// plus, for a webhook, the copy-paste `webhookUrl` — the secret is embedded in
// that URL; it is also returned raw as {@link AgentTrigger.hookSecret}). Preset
// ids are the backend contract: `hourly` | `daily@HH:MM` | `weekly@D@HH:MM`
// (D = 1=Mon .. 7=Sun).

/** How a trigger fires: on a preset schedule (`cron`) or an inbound webhook POST. */
export type AgentTriggerKind = 'cron' | 'webhook';

/**
 * A persisted agent trigger (GET/POST `/api/v1/agents/:agent/triggers`). Mirrors
 * the backend record plus the derived `webhookUrl` (present only for webhook
 * triggers). All optional fields tolerate a partial/evolving payload so the UI
 * never crashes on an older record.
 */
export interface AgentTrigger {
  /** Server-allocated id (UUID). */
  id: string;
  /** Owner user id (echoed back by the backend). */
  userId: string;
  /** Which agent this trigger drives. */
  agent: AgentName;
  /** Schedule (`cron`) vs inbound webhook (`webhook`). */
  kind: AgentTriggerKind;
  /** Preset schedule id for a `cron` trigger: `hourly` | `daily@HH:MM` | `weekly@D@HH:MM`. */
  preset?: string;
  /** Webhook secret (webhook kind only); also embedded in {@link webhookUrl}. */
  hookSecret?: string;
  /** The task the agent runs each time the trigger fires. */
  prompt: string;
  /** Whether the trigger is active (a paused trigger never fires). */
  active: boolean;
  /** ms since epoch the trigger last fired, when it has. */
  lastFiredAt?: number;
  /** ms since epoch the trigger will next fire (cron kind). */
  nextFireAt?: number;
  /** ms since epoch the trigger was created. */
  createdAt: number;
  /** Copy-paste inbound webhook URL (webhook kind only): `.../api/v1/agents/hooks/{id}.{secret}`. */
  webhookUrl?: string;
}

/** Fields accepted when creating a trigger (POST body). */
export interface CreateTriggerInput {
  kind: AgentTriggerKind;
  /** Required for `cron`: `hourly` | `daily@HH:MM` | `weekly@D@HH:MM`. Omitted for `webhook`. */
  preset?: string;
  /** The task prompt (2..8000 chars, enforced server-side). */
  prompt: string;
}

/**
 * List the signed-in user's triggers for an agent (newest first). Throws {@link
 * AgentApiError} — a `.status === 404` means the triggers feature is off, so the
 * caller can flag-detect and show a quiet fallback. Returns `[]` on a non-array
 * body.
 */
export async function listTriggers(agent: AgentName): Promise<AgentTrigger[]> {
  const rows = await requestJson<AgentTrigger[]>(
    `/api/v1/agents/${agent}/triggers`
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Create a trigger for an agent. For `kind: 'cron'` pass a valid `preset`; for
 * `kind: 'webhook'` the backend mints a secret and returns the record with a
 * copy-paste {@link AgentTrigger.webhookUrl}. Throws {@link AgentApiError}
 * (notably `.status === 404` when the feature is off, `.status === 400` on an
 * invalid preset/prompt).
 */
export function createTrigger(
  agent: AgentName,
  input: CreateTriggerInput
): Promise<AgentTrigger> {
  return requestJson<AgentTrigger>(`/api/v1/agents/${agent}/triggers`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
}

/** Delete a trigger by id (idempotent server-side). Throws {@link AgentApiError} on a transport/HTTP failure. */
export async function deleteTrigger(
  agent: AgentName,
  id: string
): Promise<void> {
  await requestJson<unknown>(
    `/api/v1/agents/${agent}/triggers/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
}

/**
 * Toggle a trigger active/paused. Returns the updated record (the backend
 * recomputes `nextFireAt` for a re-activated cron trigger). Throws {@link
 * AgentApiError}.
 */
export function toggleTrigger(
  agent: AgentName,
  id: string
): Promise<AgentTrigger> {
  return requestJson<AgentTrigger>(
    `/api/v1/agents/${agent}/triggers/${encodeURIComponent(id)}/toggle`,
    {
      method: 'POST',
      headers: jsonHeaders,
    }
  );
}

/**
 * Load one background run's full record (state, steps timeline, finalText,
 * timings) by id. Used to seed a live view so an already-finished run renders
 * instantly before the stream re-attaches. Throws {@link AgentApiError}.
 */
export function getAgentRun(
  agent: AgentName,
  id: string
): Promise<AgentRunRecord> {
  return requestJson<AgentRunRecord>(
    `${runsBase(agent)}/${encodeURIComponent(id)}`
  );
}

/**
 * Cooperatively stop a background run. The backend sets a stop flag the loop
 * checks each iteration (and aborts the wall-clock); the live stream closes on
 * the resulting terminal `status` frame. Safe to call when the run is already
 * finished. Best-effort — throws {@link AgentApiError} only on a transport/HTTP
 * failure the caller may choose to ignore.
 */
export async function stopAgentRun(
  agent: AgentName,
  id: string
): Promise<void> {
  await requestJson<unknown>(
    `${runsBase(agent)}/${encodeURIComponent(id)}/stop`,
    {
      method: 'POST',
      headers: jsonHeaders,
    }
  );
}

/**
 * Resolve a pending approval for a paused background run. `approved` is `true` to
 * let the consequential tool proceed or `false` to skip it; `stepId` identifies
 * the awaiting step (the `approval_request` frame's id). Bridges to the backend's
 * existing `awaitApproval` machinery. Throws {@link AgentApiError} on failure.
 */
export async function approveAgentRun(
  agent: AgentName,
  id: string,
  stepId: string,
  approved: boolean
): Promise<void> {
  await requestJson<unknown>(
    `${runsBase(agent)}/${encodeURIComponent(id)}/approve`,
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ stepId, approved }),
    }
  );
}

// ── Fetch-SSE run stream ──────────────────────────────────────────────────────

/** Handlers for {@link openAgentRunStream}. All optional except `onEvent`. */
export interface RunStreamHandlers {
  /** Invoked once per parsed, non-`ping` SSE frame (the RUNTIME event union). */
  onEvent: (event: AgentEvent) => void;
  /**
   * Invoked with a human-readable message on a transport/HTTP failure. NOT
   * called for a caller-initiated abort (the returned signal was aborted).
   */
  onError?: (message: string) => void;
  /**
   * Invoked exactly once when the stream ends for ANY reason (server `done`
   * sentinel, reader close, error, or abort). Lets the caller flip a "live" flag
   * off without racing the async loop.
   */
  onClose?: () => void;
  /** Abort signal to stop reading (aborting the underlying fetch). */
  signal?: AbortSignal;
}

/**
 * Attach to a background run's durable Server-Sent-Events stream and pump parsed
 * frames to `handlers.onEvent`. This is the SHARED transport used by the
 * `useAgentRunStream` hook — it mirrors the console stream reader in
 * use-agent-stream.ts exactly: `fetch` with `credentials: 'include'` (cookie
 * auth via `@CurrentUser()`), `Accept: text/event-stream`, a `ReadableStream`
 * reader, and frames split on the blank-line separator with the `data:` payload
 * JSON-parsed into an {@link AgentEvent} (single `data:` line per frame; the
 * `type` field discriminates — there is NO `event:` field). EventSource can't
 * send cookies cross-origin, so the fetch-reader path is used instead.
 *
 * The backend REPLAYS the recorded event list first (history) then live-attaches
 * — so calling this on mount/tab-return reconstructs the full timeline. The
 * stream ends on a `{ type: 'done' }` sentinel or the reader closing; a terminal
 * `status`/`final`/`error` frame is delivered to `onEvent` before that.
 *
 * Everything is defensive: partial frames spanning chunks are buffered, `ping`
 * heartbeats are dropped (never forwarded), malformed JSON is skipped, and a
 * caller-initiated abort resolves quietly (no `onError`). Returns a Promise that
 * resolves when the stream ends (never rejects — failures go to `onError`).
 */
export async function openAgentRunStream(
  agent: AgentName,
  id: string,
  handlers: RunStreamHandlers
): Promise<void> {
  const { onEvent, onError, onClose, signal } = handlers;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      onClose?.();
    } catch {
      // a throwing onClose must never break the stream
    }
  };

  try {
    const res = await fetch(
      cdzApiUrl(`${runsBase(agent)}/${encodeURIComponent(id)}/stream`),
      {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        credentials: 'include',
        signal,
      }
    );

    if (!res.ok || !res.body) {
      // Surface a typed message from the error body when possible.
      const msg = res.body
        ? await readError(res)
        : res.statusText || `Agent stream failed (${res.status})`;
      onError?.(msg);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Read chunks, accumulate a text buffer, and split complete SSE frames on
    // the blank-line separator. A partial frame stays in `buffer` until the next
    // chunk completes it (frames can span reads). Mirrors the console reader.
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        // A frame is one or more lines; collect the `data:` payload(s). (The
        // RUNTIME emits a single data line, but we tolerate multi-line data and
        // SSE comment/`event:` lines defensively.)
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) data += line.slice(5).trimStart();
        }
        if (!data) continue; // comment / heartbeat with no payload
        let ev: AgentEvent | null = null;
        try {
          ev = JSON.parse(data) as AgentEvent;
        } catch {
          // Malformed / partial JSON that slipped a split — skip it.
          continue;
        }
        // A `done` sentinel ends the stream cleanly.
        if ((ev as { type?: string }).type === 'done') {
          buffer = '';
          try {
            await reader.cancel();
          } catch {
            /* already closing */
          }
          return;
        }
        // Drop heartbeats here too so consumers never see them.
        if ((ev as { type?: string }).type === 'ping') continue;
        try {
          onEvent(ev);
        } catch {
          // a throwing consumer must never break the reader loop
        }
      }
    }
  } catch (err) {
    // A caller-initiated abort (unmount / re-attach) is not an error to surface.
    const aborted =
      signal?.aborted ||
      (err instanceof Error && err.name === 'AbortError');
    if (!aborted) {
      onError?.(
        err instanceof Error && err.message
          ? err.message
          : 'Agent run stream failed.'
      );
    }
  } finally {
    close();
  }
}
