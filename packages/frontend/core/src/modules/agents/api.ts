import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';

import type {
  AgentName,
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
