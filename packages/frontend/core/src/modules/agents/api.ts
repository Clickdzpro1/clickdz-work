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

// ── OpenClaw per-user config (tool permissions live here) ─────────────────────

/**
 * The per-user OpenClaw config as returned by GET/PUT /api/v1/openclaw/config.
 * `enabledTools` (R11) is the caller's tool allowlist — omitted when the user has
 * not customized it (⇒ the console runs the full catalog; the /capabilities
 * `tools[].enabled` flags default true). The backend validates every slug ⊆ its
 * real catalog and echoes the normalized config on save. Loosely typed beyond the
 * known fields so callers read forward-compatible extras defensively.
 */
export interface OpenclawConfig {
  provisioned: boolean;
  defaultRuntime?: string;
  previewAutoOpen?: boolean;
  enabledTools?: string[];
  updatedAt?: number;
  [k: string]: unknown;
}

/**
 * GET the signed-in user's OpenClaw config (`GET /api/v1/openclaw/config`).
 * Returns the server's normalized shape; a missing config resolves to the
 * unprovisioned default `{provisioned:false}` on the backend. Mirrors the Hermes
 * config wrapper style (config lives on the per-agent `/config` route).
 */
export function getOpenclawConfig(): Promise<OpenclawConfig> {
  return requestJson<OpenclawConfig>(`${base('openclaw')}/config`);
}

/**
 * Upsert the signed-in user's OpenClaw config (`PUT /api/v1/openclaw/config`).
 * Partial upsert — only the provided fields change; the server merges over the
 * stored config, sets `provisioned:true`, validates (`enabledTools ⊆` the real
 * catalog, runtime enum, boolean flag) and echoes the normalized config. Pass
 * `{enabledTools}` to persist the tool-permission grid selection.
 */
export function saveOpenclawConfig(
  cfg: Partial<Omit<OpenclawConfig, 'provisioned' | 'updatedAt'>>
): Promise<OpenclawConfig> {
  return requestJson<OpenclawConfig>(`${base('openclaw')}/config`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(cfg),
  });
}

// ── OpenClaw sandbox health probe (R16 — real create→exec→teardown) ───────────
//
// The HONEST replacement for the `provisioned` Redis flag: instead of a passive
// capability READ, this hits the R9 SONDE LIVE diagnostic, which actually
// provisions a microVM, runs `echo('ok')`, and tears it down under a 60s budget —
// proving live execution end-to-end. Backend route (asserted against
// ClickDzOpenclawController.sandboxHealth): `GET /api/v1/openclaw/sandbox/health`
// (@Throttle('strict'), @CurrentUser, typed 404 when CDZ_AGENTS_ENABLED is off).
// It NEVER throws server-side — a broken sandbox still 200s the diagnostic as
// `{ ok:false, stage, ms, error, detail }` so the real prod failure is readable.
// The verbatim `error` / `detail.bodyPreview` is dev-only; the UI classifies the
// failure to a merchant message from `detail.code` + `detail.status` + `stage`
// (see reasonMessage in openclaw-shared) and NEVER prints the raw string.

/** The lifecycle stage the probe reached (mirrors backend `SandboxHealthStage`). */
export type SandboxHealthStage = 'create' | 'exec' | 'teardown' | 'done';

/**
 * The failure-classification codes the backend attaches on `detail.code`
 * (mirrors `SandboxErrorCode`). The UI maps these (plus `detail.status`) to the
 * design's three sandbox rows — a closed set, never printed raw.
 */
export type SandboxHealthCode =
  | 'not_configured'
  | 'not_enabled'
  | 'api_error'
  | 'timeout';

/**
 * Result of the sandbox health probe (`GET /api/v1/openclaw/sandbox/health`),
 * mirroring the backend `SandboxHealthResult` EXACTLY. `ok:true` (with
 * `stage:'done'`) means the microVM was created, ran `echo`, and torn down
 * cleanly. `ok:false` carries the leg that broke (`stage`) + the VERBATIM
 * upstream `error` (dev-only, NEVER shown to merchants) + a structured `detail`
 * the UI classifies into copy. All fields optional beyond `ok`/`stage` so a
 * partial/evolving payload never crashes the button.
 */
export interface SandboxHealth {
  /** Whether the full create→exec→teardown cycle succeeded. */
  ok: boolean;
  /** How far the probe got: which leg was reached / broke. */
  stage?: SandboxHealthStage;
  /** Round-trip duration in milliseconds (rendered as "opérationnel (Xms)"). */
  ms?: number;
  /** VERBATIM upstream error string — dev logging ONLY; never surfaced to merchants. */
  error?: string;
  /** Structured failure breakdown when the cause was a typed sandbox error. */
  detail?: {
    code?: SandboxHealthCode;
    stage?: string;
    /** The upstream HTTP status (e.g. 429 capacity, 402 billing, 401/403 auth). */
    status?: number;
    bodyPreview?: string;
  };
  /** Runtime the create leg provisioned (diagnostic only). */
  runtime?: string;
}

/**
 * Run the real sandbox health probe for the signed-in user
 * (`GET /api/v1/openclaw/sandbox/health`). Actually creates a microVM, runs
 * `echo`, and tears it down — the honest live-execution test. Throws {@link
 * AgentApiError} only on a transport failure OR a typed 404 when the feature is
 * dark (the caller treats 404 as generate-only, not a red error). A sandbox
 * FAILURE is NOT a throw — it comes back HTTP 200 as `{ ok:false, stage, error,
 * detail }` so the UI can classify `detail` to merchant copy.
 */
export function sandboxHealth(): Promise<SandboxHealth> {
  return requestJson<SandboxHealth>('/api/v1/openclaw/sandbox/health');
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
    `/api/v1/agents/${agent}/channels/telegram/connect`,
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
      `/api/v1/agents/${agent}/channels/telegram`
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
    `/api/v1/agents/${agent}/channels/telegram/disconnect`,
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
    `/api/v1/agents/${agent}/channels/telegram/test`,
    {
      method: 'POST',
      headers: jsonHeaders,
    }
  );
}

// ── WhatsApp channel (R16 BYON: per-(user,agent) pair-by-code) ────────────────
//
// The WhatsApp analogue of the R10 Telegram channel above — a per-(user,agent)
// binding, but WhatsApp pairs by an 8-char CODE (not a bot token, and NOT a QR:
// WhatsApp's link-QR rotates ~30s and can't be surfaced statically). The user
// gives their store's phone number; the gateway mints a code with a short TTL;
// the user types it into WhatsApp → Linked Devices → "Link with phone number".
// These wrap the R16 WA channel routes, mirroring the Telegram block EXACTLY
// (note: the plural `agents` segment, per-(user,agent), NOT the fixed console):
//   POST   /api/v1/agents/<agent>/channels/whatsapp/connect      {phoneNumber}
//   GET    /api/v1/agents/<agent>/channels/whatsapp
//   POST   /api/v1/agents/<agent>/channels/whatsapp/pair          (re-issue code)
//   POST   /api/v1/agents/<agent>/channels/whatsapp/disconnect
//   POST   /api/v1/agents/<agent>/channels/whatsapp/test
// gated server-side (feature flag + gateway) — dark ⇒ the routes 404, which
// {@link getWhatsappChannel} maps to a disconnected status so the card shows a
// quiet "bientôt" state rather than an error. A status read NEVER carries a code.

/**
 * The WhatsApp channel status for one agent (`GET .../channels/whatsapp`). Never
 * carries a pairing code — only whether the store's number is linked and, when
 * linked, the connected `phoneNumber`. `status` is the gateway's coarse pairing
 * phase (e.g. `linked` / `pending` / `retry`); all fields optional so a partial
 * / evolving payload never crashes the card.
 */
export interface WhatsAppChannelStatus {
  /** Whether the user's WhatsApp number is linked to this agent. */
  connected: boolean;
  /** The connected WhatsApp number (E.164-ish), when connected. */
  phoneNumber?: string;
  /** Coarse pairing phase reported by the gateway (never a raw error). */
  status?: string;
  /**
   * When the number was connected — the backend sends ms-since-epoch (a
   * `number`); typed as `number | string` so a string timestamp from an older /
   * evolving record still renders. The card's formatter tolerates both.
   */
  connectedAt?: number | string;
}

/**
 * Envelope returned by {@link connectWhatsapp} / {@link pairWhatsapp}. `code` is
 * the raw 8-char pairing code; `formatted` is the gateway's display form (e.g.
 * `ABCD-EFGH`) the UI shows in a mono block. `status === 'retry'` means the
 * pairing session wasn't ready yet — the caller should re-call {@link
 * pairWhatsapp} to obtain the live code (mirrors the design's retry loop). A
 * `code`-less `{ status:'retry' }` is the "not ready, try pair again" signal.
 */
export interface WhatsAppPairResult {
  /** Whether the mint/connect call itself succeeded. */
  ok: boolean;
  /** The raw 8-char pairing code (TTL-limited server-side), when issued. */
  code?: string;
  /** The display-formatted code (e.g. `ABCD-EFGH`) to render, when issued. */
  formatted?: string;
  /** Coarse pairing phase; `'retry'` ⇒ session not ready, re-call `pair()`. */
  status?: string;
}

/**
 * Connect the signed-in user's WhatsApp number to `agent`
 * (`POST /api/v1/agents/<agent>/channels/whatsapp/connect`). `phoneNumber` is the
 * store's number with an international indicatif (`+213…`); the gateway mints a
 * pairing {@link WhatsAppPairResult.code} the user types into WhatsApp. Throws
 * {@link AgentApiError} — notably `.status === 404` (feature dark ⇒ the caller
 * falls back to a "bientôt" state), `.status === 400` (gateway couldn't mint the
 * code), `.status === 422` (bad phone number), `.status === 429` (rate-limited).
 */
export function connectWhatsapp(
  agent: AgentName,
  phoneNumber: string
): Promise<WhatsAppPairResult> {
  return requestJson<WhatsAppPairResult>(
    `/api/v1/agents/${agent}/channels/whatsapp/connect`,
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ phoneNumber }),
    }
  );
}

/**
 * Read the WhatsApp channel status for `agent`
 * (`GET /api/v1/agents/<agent>/channels/whatsapp`). Fail-soft: a `.status === 404`
 * (feature dark OR no connection) is mapped to a disconnected status
 * (`{ connected: false }`) rather than thrown — so the card renders a quiet
 * not-connected / "bientôt" state instead of an error. Any OTHER failure (401
 * signed-out, network, 5xx) still throws {@link AgentApiError}. Never returns a
 * pairing code. Mirrors {@link getTelegramChannel} exactly.
 */
export async function getWhatsappChannel(
  agent: AgentName
): Promise<WhatsAppChannelStatus> {
  try {
    const res = await requestJson<WhatsAppChannelStatus>(
      `/api/v1/agents/${agent}/channels/whatsapp`
    );
    return res && typeof res === 'object' ? res : { connected: false };
  } catch (err) {
    if (err instanceof AgentApiError && err.status === 404) {
      return { connected: false };
    }
    throw err;
  }
}

/**
 * Re-issue (or obtain) a WhatsApp pairing code for `agent`
 * (`POST /api/v1/agents/<agent>/channels/whatsapp/pair`). Used both to RE-ISSUE a
 * fresh code (the "Renvoyer un code" button, resetting the TTL) and to resolve a
 * `status:'retry'` from {@link connectWhatsapp} (pairing session not ready yet).
 * Returns the same {@link WhatsAppPairResult} envelope. Throws {@link
 * AgentApiError} — `.status === 404` (dark), `.status === 400` (mint failed),
 * `.status === 429` (rate-limited).
 */
export function pairWhatsapp(agent: AgentName): Promise<WhatsAppPairResult> {
  return requestJson<WhatsAppPairResult>(
    `/api/v1/agents/${agent}/channels/whatsapp/pair`,
    {
      method: 'POST',
      headers: jsonHeaders,
    }
  );
}

/**
 * Disconnect the user's WhatsApp number from `agent`
 * (`POST /api/v1/agents/<agent>/channels/whatsapp/disconnect`). The gateway drops
 * the linked device + stored binding. Idempotent server-side. Throws {@link
 * AgentApiError} only on a transport/HTTP failure. Mirrors {@link
 * disconnectTelegram}.
 */
export async function disconnectWhatsapp(agent: AgentName): Promise<void> {
  await requestJson<{ ok?: boolean }>(
    `/api/v1/agents/${agent}/channels/whatsapp/disconnect`,
    {
      method: 'POST',
      headers: jsonHeaders,
    }
  );
}

/**
 * Send a test message to the user's linked WhatsApp number for `agent`
 * (`POST /api/v1/agents/<agent>/channels/whatsapp/test`). `sent` is `false` when
 * the channel is linked but the gateway couldn't send yet (the UI tells the user
 * to retry in a moment); `note` is an optional gateway hint (never a raw error).
 * Throws {@link AgentApiError} on a transport/HTTP failure. Mirrors {@link
 * testTelegram}.
 */
export function testWhatsapp(
  agent: AgentName
): Promise<{ ok: boolean; sent: boolean; note?: string }> {
  return requestJson<{ ok: boolean; sent: boolean; note?: string }>(
    `/api/v1/agents/${agent}/channels/whatsapp/test`,
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

// ── R12 custom agents (user-created agents cloning a built-in archetype) ───────
//
// A CUSTOM agent is a light def the user creates from the /agents home ("Créer un
// agent"): pick an archetype (which built-in loop/tools it reuses — Opérateur =
// hermes, Ingénieur = openclaw), a name, an emoji, and an optional persona. It
// gets an opaque runtime id `cz_` + 8 hex; every unified surface (run view,
// channels, triggers) already keys by that id, so a custom agent reuses them all.
// These wrap the Fonderie CRUD routes on the agents controller (the SAME plural
// `agents` segment + `CDZ_AGENTS_ENABLED` master gate as {@link listAgents}), and
// are ADDITIONALLY gated by `CDZ_AGENT_CUSTOM_ENABLED` on the backend — dark ⇒ the
// routes 404, so (like the other helpers here) each doubles as a capability probe
// the caller flag-detects via `.status === 404`. Backend routes (asserted against
// ClickDzAgentsController's @Post/@Get/@Patch/@Delete — FE-called path == route):
//   GET    /api/v1/agents/custom        → { agents: AgentDef[] }
//   POST   /api/v1/agents/custom        {archetype,name,emoji?,persona?} → AgentDef
//   PATCH  /api/v1/agents/custom/:id    {name?,emoji?,persona?} → AgentDef
//   DELETE /api/v1/agents/custom/:id    → { deleted: boolean }
// Ownership is intrinsic on the backend (every route is @CurrentUser, keyed by the
// caller's user id), so these carry NO user id — a caller only ever sees/edits
// THEIR OWN agents; an unknown/not-owned id 404s.

/**
 * A user-created custom agent (the backend registry def). `id` is the opaque
 * `cz_`-prefixed runtime id used everywhere the unified surfaces key by agent;
 * `archetype` is the built-in whose loop/tools it clones. `emoji`/`persona` are
 * optional. Mirrors the backend `AgentDef` shape returned by the CRUD routes.
 */
export interface AgentDef {
  /** Opaque runtime id: `cz_` + 8 hex (the `?agent=` value for the run view). */
  id: string;
  /** Which built-in loop/tools this agent reuses. */
  archetype: AgentName;
  /** Display name (1..40 chars). */
  name: string;
  /** Optional emoji (≤8 chars), when set. */
  emoji?: string;
  /** Optional persona prepended to the archetype's system prompt (≤2000 chars). */
  persona?: string;
  /** ms since epoch the agent was created. */
  createdAt: number;
}

/** Fields accepted when creating a custom agent (POST body). */
export interface CreateCustomAgentInput {
  /** The built-in to clone: `hermes` (Opérateur) or `openclaw` (Ingénieur). */
  archetype: AgentName;
  /** Display name (1..40 chars, validated server-side). */
  name: string;
  /** Optional emoji (≤8 chars). */
  emoji?: string;
  /** Optional persona (≤2000 chars). */
  persona?: string;
}

/** Fields accepted when editing a custom agent (PATCH body — all optional). */
export interface UpdateCustomAgentInput {
  /** New display name (1..40 chars). */
  name?: string;
  /** New emoji (≤8 chars); pass `''` to clear it. */
  emoji?: string;
  /** New persona (≤2000 chars); pass `''` to clear it. */
  persona?: string;
}

/**
 * List the signed-in user's custom agents (newest first). Throws {@link
 * AgentApiError} — a `.status === 404` means custom agents are off (feature
 * dark), so the caller flag-detects and hides the create UI. Returns `[]` on a
 * non-array `agents` body. Backend: `GET /api/v1/agents/custom`.
 */
export async function listCustomAgents(): Promise<AgentDef[]> {
  const res = await requestJson<{ agents: AgentDef[] }>(
    `/api/v1/agents/custom`
  );
  return res && Array.isArray(res.agents) ? res.agents : [];
}

/**
 * Create a custom agent for the signed-in user. Returns the created {@link
 * AgentDef}. Throws {@link AgentApiError} — notably `.status === 404` when the
 * feature is dark and `.status === 400` on an invalid body (bad archetype, name
 * out of range, over-long persona/emoji) or the per-user cap
 * (`custom_agent_limit_reached`). Backend: `POST /api/v1/agents/custom`.
 */
export function createCustomAgent(
  body: CreateCustomAgentInput
): Promise<AgentDef> {
  return requestJson<AgentDef>(`/api/v1/agents/custom`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

/**
 * Edit a custom agent's name / emoji / persona. Only the provided fields change;
 * pass `emoji: ''` or `persona: ''` to clear those. Returns the updated {@link
 * AgentDef}. Throws {@link AgentApiError} — `.status === 404` when the agent is
 * unknown / not owned by the caller (or the feature is dark), `.status === 400`
 * on an invalid field. Backend: `PATCH /api/v1/agents/custom/:id`.
 */
export function updateCustomAgent(
  id: string,
  body: UpdateCustomAgentInput
): Promise<AgentDef> {
  return requestJson<AgentDef>(
    `/api/v1/agents/custom/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    }
  );
}

/**
 * Delete a custom agent by id. Idempotent server-side (deleting a missing / not-
 * owned id resolves `{ deleted: false }` rather than throwing). Returns whether a
 * def was removed. Throws {@link AgentApiError} only on a transport/HTTP failure
 * (e.g. `.status === 404` when the feature is dark). Backend:
 * `DELETE /api/v1/agents/custom/:id`.
 */
export async function deleteCustomAgent(
  id: string
): Promise<{ deleted: boolean }> {
  const res = await requestJson<{ deleted?: boolean }>(
    `/api/v1/agents/custom/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
  return { deleted: !!(res && res.deleted) };
}

// ── R11 shop pulse + DZD budget (WS11-9, Pouls) ───────────────────────────────
//
// Two owner-scoped, read-only reads the Hermes "Bureau" hero + the agents-home
// BudgetBar consume. Both live under the plural `agents` segment (the SAME
// controller as {@link listAgents} — gated by `CDZ_AGENTS_ENABLED`), so, like
// the other helpers here, each doubles as a capability probe: a `.status === 404`
// means the feature is dark and the caller shows a quiet fallback. Backend routes
// (asserted against the controller's @Get):
//   GET /api/v1/agents/pulse    → {@link AgentPulse}
//   GET /api/v1/agents/budget   → {@link AgentBudget}

/**
 * The connected shop's live counters (`GET /api/v1/agents/pulse`). Mirrors the
 * `<PulseCard>` `pulse` shape plus `connected` (false ⇒ no shop published yet;
 * the counters are all zero in that case). All numbers are non-negative; DZD is
 * an integer.
 */
export interface AgentPulse {
  /** Whether the caller has a shop/erp app published (false ⇒ zeros). */
  connected: boolean;
  /** Orders whose business date is today (UTC). */
  ordersToday: number;
  /** Orders awaiting confirmation (status `Nouvelle`). */
  toConfirm: number;
  /** Σ delivered-order totals for today, in DZD. */
  revenueTodayDzd: number;
  /** Orders in the `Retournée` state (all-time). */
  returns: number;
  /** Products at/below their reorder threshold. */
  lowStock: number;
}

/**
 * The month's agent spend + today's run count vs the daily cap
 * (`GET /api/v1/agents/budget`). Mirrors the `<BudgetBar>` `budget` shape.
 * `monthDzd === 0` ⇒ usage-only (no hard limit); the bar warns at ≥80% but never
 * blocks.
 */
export interface AgentBudget {
  /** Soft monthly budget in DZD (0 ⇒ usage-only, no limit). */
  monthDzd: number;
  /** DZD spent this calendar month. */
  spentDzd: number;
  /** Runs started today (UTC). */
  runsToday: number;
  /** The per-user daily run cap the backend enforces. */
  runsCap: number;
  /** Tokens consumed this calendar month. */
  tokens: number;
}

/**
 * Fetch the caller's connected-shop pulse (`GET /api/v1/agents/pulse`). The
 * pulse is per-USER (the caller's first published shop/erp app), so the optional
 * `agent` argument is accepted only for call-site symmetry with the other
 * per-agent helpers (the Bureau passes the agent it renders) — the backend route
 * is agent-agnostic and ignores it. Throws {@link AgentApiError} — a
 * `.status === 404` means `CDZ_AGENTS_ENABLED` is off (feature dark), so the
 * caller hides the hero; the backend is otherwise fail-soft (a data-API problem
 * returns `connected:false` + zeros, never an error).
 */
export function getAgentPulse(agent?: AgentName): Promise<AgentPulse> {
  void agent; // route is per-user, agent kept for call-site symmetry only
  return requestJson<AgentPulse>(`/api/v1/agents/pulse`);
}

/**
 * Fetch the caller's month spend + run-count budget
 * (`GET /api/v1/agents/budget`). Throws {@link AgentApiError} — a
 * `.status === 404` means the feature is dark (hide the bar); the backend is
 * otherwise fail-soft (missing accumulators read as zeros).
 */
export function getAgentBudget(): Promise<AgentBudget> {
  return requestJson<AgentBudget>(`/api/v1/agents/budget`);
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
  /**
   * Which agent this trigger drives. R15: the RUNTIME id — a built-in NAME
   * ('hermes'/'openclaw') OR an owned custom `cz_` id — so the type widens to
   * `AgentName | string` (mirrors AgentSummary.id + the backend AgentId widen).
   * A pre-R15 built-in payload is byte-identical (still a literal).
   */
  agent: AgentName | string;
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
// R15: `agent` is the RUNTIME id — a built-in NAME ('hermes'/'openclaw') OR an
// owned custom `cz_` id — interpolated straight into the URL. Widened from
// AgentName to `AgentName | string` (matching AgentSummary.id + the R12 backend
// AgentId widen) so a custom agent's triggers page reaches its OWN triggers; a
// built-in name is byte-identical. The backend resolveAgentOr404 authorizes the
// id under the caller, so an unknown/not-owned id still 404s.
export async function listTriggers(
  agent: AgentName | string
): Promise<AgentTrigger[]> {
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
  agent: AgentName | string,
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
  agent: AgentName | string,
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
  agent: AgentName | string,
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
