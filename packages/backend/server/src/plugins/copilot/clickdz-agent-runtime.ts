import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

// Cache is the @Global JSON-wrapped Redis provider (get/set/setnx/getAndDelete/
// expire, all fail-closed: undefined/false on any error, never throws). Same
// injection style byok/service.ts + context/service.ts use. We stay on the JSON
// wrapper (not raw CacheRedis) so (de)serialization + fail-soft come for free.
import { Cache } from '../../base';

// ---------------------------------------------------------------------------
// ClickDzAgentRuntime — the shared agent runtime powering both real agent
// consoles (HERMES + OPENCLAW). It is deliberately transport/tool agnostic:
//
//   1. SSE emission  — openStream(req,res) → a guarded writer that sets the
//      streaming headers, flushes, keeps the connection alive with a 15s
//      {type:'ping'} heartbeat, and tears everything down on client disconnect.
//   2. Redis threads — server-persisted, multi-turn conversation storage keyed
//      per user (createThread/getThread/saveThread/listThreads/deleteThread/
//      renameThread), plus a per-user+agent index for listing.
//   3. Stop registry — a cooperative cross-request stop flag the run loop polls
//      each iteration (requestStop/isStopRequested/clearStop).
//   4. Approval registry — human-in-the-loop pause/resume: the run emits an
//      approval_request frame then awaitApproval() polls a getAndDelete flag
//      the FE writes via resolveApproval().
//
// This module ALSO owns the wire protocol (C1) + thread model (C2) types so the
// controllers (HERMESB2/CLAWB2) and — mirrored — the FE import a single source
// of truth. It is a library: it NEVER throws out of any public method and never
// throws out of an already-open SSE stream (callers emit {type:'error'} + done
// instead). Nothing here logs secrets.
// ---------------------------------------------------------------------------

// ===========================================================================
// C1 — THE SSE EVENT PROTOCOL (RUNTIME emits, STREAMCLIENT parses; identical)
// Wire format: each event is one SSE frame `data: ${JSON.stringify(ev)}\n\n`.
// No `event:` field — the `type` field discriminates. Stream ends with
// `data: {"type":"done"}\n\n` then close. Heartbeat `{type:"ping"}` every 15s.
// ===========================================================================

export type AgentName = 'hermes' | 'openclaw';

export interface AgentStep {
  i: number;
  kind: 'thought' | 'tool' | 'write' | 'run' | 'final';
  title: string;
  detail?: string;
  tool?: string;
  args?: unknown;
  ok?: boolean;
  resultPreview?: string;
  error?: string;
  exitCode?: number;
  ts: number;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps?: AgentStep[];
  createdAt: number;
  agent: AgentName;
}

export type AgentEvent =
  | { type: 'thread'; threadId: string; agent: AgentName; title: string }
  | {
      type: 'status';
      phase:
        | 'planning'
        | 'executing'
        | 'writing'
        | 'running'
        | 'installing'
        | 'previewing'
        | 'waiting_approval'
        | 'finalizing'
        | 'done'
        | 'error'
        | 'stopped';
      label: string;
    }
  | { type: 'token'; text: string } // incremental final-answer text
  | { type: 'step'; step: AgentStep } // append to the in-progress assistant message
  | { type: 'tool_call'; id: string; tool: string; title: string; args?: unknown }
  | {
      type: 'tool_result';
      id: string;
      ok: boolean;
      resultPreview?: string;
      error?: string;
      durationMs?: number;
    }
  | {
      type: 'approval_request';
      id: string;
      tool: string;
      title: string;
      summary: string;
      args?: unknown;
    } // pauses; FE POSTs /approve
  | {
      type: 'artifact';
      artifact:
        | { kind: 'file'; path: string; language?: string; bytes?: number }
        | { kind: 'output'; label: string; text: string }
        | { kind: 'link'; label: string; url: string };
    }
  | { type: 'preview'; url: string; port: number; status: 'starting' | 'ready' } // OPENCLAW live preview
  | {
      type: 'terminal';
      stream: 'stdout' | 'stderr';
      data: string;
      cmdId?: string;
    } // OPENCLAW live terminal
  | {
      type: 'file';
      op: 'write' | 'update' | 'delete';
      path: string;
      language?: string;
    } // OPENCLAW file-tree delta
  | { type: 'final'; message: AgentMessage } // completed, persisted assistant turn
  | { type: 'error'; code: string; message: string }
  | { type: 'ping' };

// ===========================================================================
// C2 — Thread model (RUNTIME persists in Redis; both agents + STREAMCLIENT use)
// ===========================================================================

export interface AgentThreadSummary {
  id: string;
  agent: AgentName;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface AgentThread extends AgentThreadSummary {
  messages: AgentMessage[];
  sandbox?: {
    sessionId: string;
    runtime: string;
    routes?: { url: string; port: number }[];
    updatedAt: number;
  }; // OPENCLAW only
}

// ===========================================================================
// SSE writer surface (C3) — what openStream() returns.
// ===========================================================================

export interface AgentSseWriter {
  /** Write one SSE frame. No-op once the stream is closed. Never throws. */
  emit(ev: AgentEvent): void;
  /** (Re)configure the heartbeat interval in ms. */
  heartbeatEvery(ms: number): void;
  /** Register a callback fired once when the client disconnects / stream ends. */
  onClose(cb: () => void): void;
  /** True once the client disconnected or end() was called. */
  readonly closed: boolean;
  /** Emit {type:'done'}, end the response, clear timers. Idempotent. */
  end(): void;
}

// ---------------------------------------------------------------------------
// Redis key helpers (C2). Mirror the existing clickdz:apps:published:<uid>
// namespace so ops/observability stay consistent.
// ---------------------------------------------------------------------------

const threadKey = (userId: string, threadId: string) =>
  `clickdz:agent:${userId}:${threadId}`;
const indexKey = (userId: string, agent: AgentName) =>
  `clickdz:agent:index:${userId}:${agent}`;
const stopKey = (threadId: string) => `clickdz:agent:stop:${threadId}`;
const approvalKey = (threadId: string, approvalId: string) =>
  `clickdz:agent:approval:${threadId}:${approvalId}`;

// TTLs (milliseconds — Cache.set/expire take PX ms). Refreshed on every write.
const THREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days
const STOP_TTL_MS = 10 * 60 * 1000; // ~10 minutes
const APPROVAL_TTL_MS = 10 * 60 * 1000; // ~10 minutes
const HEARTBEAT_MS = 15_000; // 15s ping keeps the SSE connection alive through proxies
const APPROVAL_POLL_MS = 500; // getAndDelete poll cadence

// The per-user+agent index is stored as a JSON array of thread ids under a
// single key (Cache has list ops, but a plain array is the simplest portable
// shape and survives corruption gracefully — see readIndex()).
type ThreadIndex = string[];

@Injectable()
export class ClickDzAgentRuntime {
  private readonly logger = new Logger(ClickDzAgentRuntime.name);

  constructor(private readonly cache: Cache) {}

  // =========================================================================
  // 1. SSE EMISSION
  // =========================================================================

  /**
   * Open an SSE stream on the given Express response. Sets the streaming
   * headers, flushes them, starts a 15s {type:'ping'} heartbeat, and wires the
   * request 'close' event to mark the writer closed + fire onClose callbacks +
   * clear the heartbeat. Every write is guarded — a broken pipe can never throw
   * out of the writer. Returns the writer the controller drives.
   */
  openStream(req: Request, res: Response): AgentSseWriter {
    let closed = false;
    let heartbeatMs = HEARTBEAT_MS;
    let timer: ReturnType<typeof setInterval> | undefined;
    const closeCbs: Array<() => void> = [];

    const clearTimer = () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };

    // Low-level guarded write. Returns false (and marks closed) if the socket
    // is gone — the caller (emit/end) treats every write as best-effort.
    const rawWrite = (payload: string): boolean => {
      if (closed) return false;
      try {
        res.write(payload);
        return true;
      } catch {
        // Broken pipe / already-ended socket: stop trying, tear down.
        closed = true;
        clearTimer();
        return false;
      }
    };

    const fireClose = () => {
      if (closed) {
        // still run callbacks exactly once even if closed was set by a write
      }
      closed = true;
      clearTimer();
      for (const cb of closeCbs.splice(0)) {
        try {
          cb();
        } catch {
          /* a bad callback must not break teardown */
        }
      }
    };

    const startHeartbeat = () => {
      clearTimer();
      if (closed) return;
      timer = setInterval(() => {
        // A ping is just another frame; if it fails the socket is dead.
        if (!rawWrite(`data: ${JSON.stringify({ type: 'ping' })}\n\n`)) {
          fireClose();
        }
      }, heartbeatMs);
      // Don't let the heartbeat keep the process alive on shutdown.
      timer.unref?.();
    };

    // --- Set SSE headers + flush. All guarded: header failures never throw. ---
    try {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Defensive against nginx buffering (harmless if no proxy) — recon §6.
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
    } catch (err) {
      // Header write failed (client already gone) — degrade to a closed writer.
      this.logger.warn(
        `openStream: failed to write SSE headers: ${errMessage(err)}`
      );
      closed = true;
    }

    // Client disconnect → mark closed, fire callbacks, clear heartbeat. Bind to
    // both req 'close' and res 'close' so either socket end tears the run down.
    try {
      req.on('close', fireClose);
      res.on('close', fireClose);
      res.on('error', fireClose);
    } catch {
      /* if listeners can't attach the writer just won't auto-close */
    }

    startHeartbeat();

    const writer: AgentSseWriter = {
      emit: (ev: AgentEvent) => {
        if (closed) return;
        let payload: string;
        try {
          payload = `data: ${JSON.stringify(ev)}\n\n`;
        } catch {
          // Non-serializable event — skip it rather than crash the stream.
          return;
        }
        rawWrite(payload);
      },
      heartbeatEvery: (ms: number) => {
        if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
          heartbeatMs = ms;
          startHeartbeat();
        }
      },
      onClose: (cb: () => void) => {
        if (typeof cb !== 'function') return;
        if (closed) {
          // Already closed: run immediately so callers don't leak resources.
          try {
            cb();
          } catch {
            /* ignore */
          }
          return;
        }
        closeCbs.push(cb);
      },
      get closed() {
        return closed;
      },
      end: () => {
        if (closed) {
          // Ensure timers/listeners are cleared even on a double end().
          clearTimer();
          return;
        }
        // Best-effort terminal frame, then close the socket.
        rawWrite(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        clearTimer();
        closed = true;
        try {
          res.end();
        } catch {
          /* socket already ended */
        }
        // Run onClose callbacks so the run loop can release resources.
        for (const cb of closeCbs.splice(0)) {
          try {
            cb();
          } catch {
            /* ignore */
          }
        }
      },
    };

    return writer;
  }

  // =========================================================================
  // 2. THREADS (Redis via Cache) — all defensive: missing/corrupt → null/[].
  // =========================================================================

  /** Create + persist a new empty thread, register it in the user+agent index. */
  async createThread(
    userId: string,
    agent: AgentName,
    title: string
  ): Promise<AgentThread> {
    const now = Date.now();
    const thread: AgentThread = {
      id: randomUUID(),
      agent,
      title: cleanTitle(title) || defaultTitle(agent),
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
    };
    await this.writeThread(userId, thread);
    await this.addToIndex(userId, agent, thread.id);
    return thread;
  }

  /** Load a thread by id. Returns null when missing or corrupt. */
  async getThread(userId: string, id: string): Promise<AgentThread | null> {
    if (!userId || !id) return null;
    try {
      const raw = await this.cache.get<AgentThread>(threadKey(userId, id));
      if (!raw || typeof raw !== 'object' || !raw.id) return null;
      // Normalize possibly-partial persisted shapes.
      return normalizeThread(raw);
    } catch {
      return null;
    }
  }

  /**
   * Persist a thread (refreshing TTL). Recomputes messageCount + updatedAt and
   * keeps the index membership current. Returns the saved thread (or the input
   * on a Redis failure — never throws).
   */
  async saveThread(userId: string, t: AgentThread): Promise<AgentThread> {
    if (!userId || !t || !t.id) return t;
    const thread = normalizeThread(t);
    thread.messageCount = thread.messages.length;
    thread.updatedAt = Date.now();
    await this.writeThread(userId, thread);
    // Defensive: make sure it's indexed even if createThread was skipped.
    await this.addToIndex(userId, thread.agent, thread.id);
    return thread;
  }

  /**
   * List thread summaries for a user+agent, newest-activity first. Prunes index
   * entries whose thread has expired/been deleted. Returns [] on any failure.
   */
  async listThreads(
    userId: string,
    agent: AgentName
  ): Promise<AgentThreadSummary[]> {
    if (!userId) return [];
    let ids: ThreadIndex;
    try {
      ids = await this.readIndex(userId, agent);
    } catch {
      return [];
    }
    if (!ids.length) return [];

    const summaries: AgentThreadSummary[] = [];
    const alive: string[] = [];
    for (const id of ids) {
      const t = await this.getThread(userId, id);
      if (!t) continue; // expired/deleted → drop from index below
      alive.push(id);
      summaries.push({
        id: t.id,
        agent: t.agent,
        title: t.title,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        messageCount: t.messageCount,
      });
    }
    // Prune dead ids from the index (best-effort; ignore result).
    if (alive.length !== ids.length) {
      await this.writeIndex(userId, agent, alive);
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  /**
   * Delete a thread + remove it from the index + clear any stop/approval flags
   * associated with it. Returns true if the thread key was removed.
   */
  async deleteThread(userId: string, id: string): Promise<boolean> {
    if (!userId || !id) return false;
    // Resolve agent (for index removal) before deleting the record.
    const existing = await this.getThread(userId, id);
    let removed = false;
    try {
      removed = await this.cache.delete(threadKey(userId, id));
    } catch {
      removed = false;
    }
    if (existing) {
      await this.removeFromIndex(userId, existing.agent, id);
    } else {
      // Unknown agent — best-effort remove from both index sets.
      await this.removeFromIndex(userId, 'hermes', id);
      await this.removeFromIndex(userId, 'openclaw', id);
    }
    // Clear the cooperative stop flag; approval flags are per-approvalId and
    // TTL-bounded, so they self-expire — nothing to enumerate here.
    await this.clearStop(id);
    return removed;
  }

  /** Rename a thread (refreshing TTL). Returns the updated thread or null. */
  async renameThread(
    userId: string,
    id: string,
    title: string
  ): Promise<AgentThread | null> {
    const thread = await this.getThread(userId, id);
    if (!thread) return null;
    thread.title = cleanTitle(title) || thread.title;
    thread.updatedAt = Date.now();
    await this.writeThread(userId, thread);
    return thread;
  }

  // --- internal thread + index helpers -------------------------------------

  private async writeThread(userId: string, thread: AgentThread): Promise<void> {
    try {
      await this.cache.set(threadKey(userId, thread.id), thread, {
        ttl: THREAD_TTL_MS,
      });
    } catch {
      /* fail-soft: Redis is a cache, not the source of truth */
    }
  }

  private async readIndex(
    userId: string,
    agent: AgentName
  ): Promise<ThreadIndex> {
    try {
      const raw = await this.cache.get<unknown>(indexKey(userId, agent));
      if (Array.isArray(raw)) {
        return raw.filter((x): x is string => typeof x === 'string');
      }
      return [];
    } catch {
      return [];
    }
  }

  private async writeIndex(
    userId: string,
    agent: AgentName,
    ids: ThreadIndex
  ): Promise<void> {
    try {
      // De-dupe defensively; refresh TTL so the index outlives its threads.
      const unique = Array.from(new Set(ids));
      await this.cache.set(indexKey(userId, agent), unique, {
        ttl: THREAD_TTL_MS,
      });
    } catch {
      /* fail-soft */
    }
  }

  private async addToIndex(
    userId: string,
    agent: AgentName,
    id: string
  ): Promise<void> {
    const ids = await this.readIndex(userId, agent);
    if (!ids.includes(id)) {
      ids.push(id);
      await this.writeIndex(userId, agent, ids);
    } else {
      // Still refresh the index TTL on activity.
      await this.writeIndex(userId, agent, ids);
    }
  }

  private async removeFromIndex(
    userId: string,
    agent: AgentName,
    id: string
  ): Promise<void> {
    const ids = await this.readIndex(userId, agent);
    const next = ids.filter(x => x !== id);
    if (next.length !== ids.length) {
      await this.writeIndex(userId, agent, next);
    }
  }

  // =========================================================================
  // 3. STOP registry — cooperative cancellation the run loop polls.
  // =========================================================================

  /** Request a running thread to stop. TTL-bounded so flags can't orphan. */
  async requestStop(threadId: string): Promise<void> {
    if (!threadId) return;
    try {
      await this.cache.set(stopKey(threadId), 1, { ttl: STOP_TTL_MS });
    } catch {
      /* fail-soft */
    }
  }

  /** True if a stop was requested for this thread. */
  async isStopRequested(threadId: string): Promise<boolean> {
    if (!threadId) return false;
    try {
      return await this.cache.has(stopKey(threadId));
    } catch {
      return false;
    }
  }

  /** Clear a thread's stop flag (call when a run starts/ends). */
  async clearStop(threadId: string): Promise<void> {
    if (!threadId) return;
    try {
      await this.cache.delete(stopKey(threadId));
    } catch {
      /* fail-soft */
    }
  }

  // =========================================================================
  // 4. APPROVAL registry — human-in-the-loop pause/resume.
  // =========================================================================

  /** Resolve a pending approval (written by the FE's POST /approve). */
  async resolveApproval(
    threadId: string,
    approvalId: string,
    decision: 'approve' | 'deny'
  ): Promise<void> {
    if (!threadId || !approvalId) return;
    const value = decision === 'approve' ? 'approve' : 'deny';
    try {
      await this.cache.set(approvalKey(threadId, approvalId), value, {
        ttl: APPROVAL_TTL_MS,
      });
    } catch {
      /* fail-soft */
    }
  }

  /**
   * Wait for an approval decision, polling getAndDelete (atomic consume-once)
   * every ~500ms until a value lands, the stop flag is set, or the timeout
   * elapses. Resolves to 'approve' | 'deny' | 'timeout' — never throws.
   */
  async awaitApproval(
    threadId: string,
    approvalId: string,
    timeoutMs: number
  ): Promise<'approve' | 'deny' | 'timeout'> {
    if (!threadId || !approvalId) return 'timeout';
    const budget =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : 120_000;
    const deadline = Date.now() + budget;
    const key = approvalKey(threadId, approvalId);

    // Poll until we consume a decision or run out of time.
    for (;;) {
      let decision: unknown;
      try {
        decision = await this.cache.getAndDelete<string>(key);
      } catch {
        decision = undefined;
      }
      if (decision === 'approve' || decision === 'deny') {
        return decision;
      }
      // A stop request short-circuits an open approval as a deny.
      if (await this.isStopRequested(threadId)) {
        return 'deny';
      }
      if (Date.now() >= deadline) {
        return 'timeout';
      }
      await sleep(APPROVAL_POLL_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// small pure helpers (module-private)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

function cleanTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  return title.trim().slice(0, 200);
}

function defaultTitle(agent: AgentName): string {
  return agent === 'openclaw' ? 'New coding session' : 'New conversation';
}

/**
 * Coerce a possibly-partial/corrupt persisted record into a well-formed
 * AgentThread so callers never see undefined fields. Defensive against schema
 * drift and truncated JSON.
 */
function normalizeThread(raw: AgentThread): AgentThread {
  const messages = Array.isArray(raw.messages)
    ? raw.messages.filter(
        (m): m is AgentMessage =>
          !!m && typeof m === 'object' && typeof (m as AgentMessage).id === 'string'
      )
    : [];
  const agent: AgentName = raw.agent === 'openclaw' ? 'openclaw' : 'hermes';
  const createdAt =
    typeof raw.createdAt === 'number' ? raw.createdAt : Date.now();
  const updatedAt =
    typeof raw.updatedAt === 'number' ? raw.updatedAt : createdAt;
  const thread: AgentThread = {
    id: String(raw.id),
    agent,
    title: cleanTitle(raw.title) || defaultTitle(agent),
    createdAt,
    updatedAt,
    messageCount:
      typeof raw.messageCount === 'number' ? raw.messageCount : messages.length,
    messages,
  };
  if (raw.sandbox && typeof raw.sandbox === 'object') {
    const s = raw.sandbox;
    if (typeof s.sessionId === 'string') {
      thread.sandbox = {
        sessionId: s.sessionId,
        runtime: typeof s.runtime === 'string' ? s.runtime : 'node24',
        routes: Array.isArray(s.routes) ? s.routes : undefined,
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
      };
    }
  }
  return thread;
}
