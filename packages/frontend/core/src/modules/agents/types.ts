/**
 * Shared frontend types for the ClickDz agent consoles (HERMES + OPENCLAW).
 *
 * This file is the FRONTEND SOURCE OF TRUTH for the agent SSE protocol and
 * thread model: the console shell (MOD/agents/components/*), the hooks in this
 * module (use-agent-stream / use-agent-threads / api), and the Hermes/OpenClaw
 * pages all import these types from here.
 *
 * They MUST stay byte-for-byte in step with the backend contract:
 *   · C1 — the SSE event protocol (RUNTIME emits `data: ${JSON.stringify(ev)}\n\n`
 *     frames; the `type` field discriminates; there is NO `event:` field).
 *   · C2 — the Redis-persisted thread model.
 * The backend re-declares the identical shapes in
 * `clickdz-agent-runtime.ts`; if you change one side, change the other.
 *
 * Pure types only — no runtime code — so importing this never pulls in a
 * transport or a React dependency.
 */

/** The two agents that share the console + this protocol. */
export type AgentName = 'hermes' | 'openclaw';

/**
 * One recorded step of an agent turn (a thought, a tool call, a file write, a
 * command run, or the final synthesis). Persisted on the assistant
 * {@link AgentMessage} and also streamed live via `step` events so the console
 * can render a growing timeline before the turn is saved.
 */
export interface AgentStep {
  /** Monotonic index within the turn (0-based), for stable ordering + keys. */
  i: number;
  kind: 'thought' | 'tool' | 'write' | 'run' | 'final';
  /** Short human-readable headline for the step row. */
  title: string;
  /** Optional longer explanation (e.g. the planner's reasoning). */
  detail?: string;
  /** Tool slug, when `kind === 'tool'`. */
  tool?: string;
  /** Arguments passed to the tool (opaque; rendered as JSON). */
  args?: unknown;
  /** Success flag for tool/run steps (undefined while pending). */
  ok?: boolean;
  /** Truncated preview of a tool/command result. */
  resultPreview?: string;
  /** Error message when the step failed. */
  error?: string;
  /** Process exit code for `run` steps. */
  exitCode?: number;
  /** Wall-clock timestamp (ms since epoch) the step was recorded. */
  ts: number;
}

/**
 * A single conversation turn. User turns carry only `content`; assistant turns
 * additionally carry the `steps` timeline that produced the answer.
 */
export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps?: AgentStep[];
  createdAt: number;
  agent: AgentName;
}

/**
 * The SSE event union. Each backend frame is exactly one of these, JSON-encoded
 * on a single `data:` line. The `type` field is the discriminator — the client
 * switches on it (see use-agent-stream). `ping` frames are heartbeats and are
 * ignored; the stream ends with `{ type: 'done' }` (sent as `data: {"type":"done"}`)
 * followed by connection close.
 */
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
  // incremental final-answer text (append to the in-progress assistant message)
  | { type: 'token'; text: string }
  // append a completed step to the in-progress assistant message
  | { type: 'step'; step: AgentStep }
  | { type: 'tool_call'; id: string; tool: string; title: string; args?: unknown }
  | {
      type: 'tool_result';
      id: string;
      ok: boolean;
      resultPreview?: string;
      error?: string;
      durationMs?: number;
    }
  // pauses the run; the FE surfaces this and POSTs a decision to /approve
  | {
      type: 'approval_request';
      id: string;
      tool: string;
      title: string;
      summary: string;
      args?: unknown;
    }
  | {
      type: 'artifact';
      artifact:
        | { kind: 'file'; path: string; language?: string; bytes?: number }
        | { kind: 'output'; label: string; text: string }
        | { kind: 'link'; label: string; url: string };
    }
  // OPENCLAW live preview (dev server)
  | { type: 'preview'; url: string; port: number; status: 'starting' | 'ready' }
  // OPENCLAW live terminal output
  | {
      type: 'terminal';
      stream: 'stdout' | 'stderr';
      data: string;
      cmdId?: string;
    }
  // OPENCLAW file-tree delta
  | {
      type: 'file';
      op: 'write' | 'update' | 'delete';
      path: string;
      language?: string;
    }
  // completed, persisted assistant turn
  | { type: 'final'; message: AgentMessage }
  | { type: 'error'; code: string; message: string }
  | { type: 'ping' };

/** The `phase` value carried by a `status` event (extracted for reuse in the UI). */
export type AgentPhase = Extract<AgentEvent, { type: 'status' }>['phase'];

/** The `artifact` payload carried by an `artifact` event. */
export type AgentArtifact = Extract<
  AgentEvent,
  { type: 'artifact' }
>['artifact'];

/**
 * Compact thread row for the sidebar list. Mirrors the backend
 * `AgentThreadSummary` (C2) returned by `GET /threads`.
 */
export interface AgentThreadSummary {
  id: string;
  agent: AgentName;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * A full thread document (C2), returned by `GET /threads/:id`. Extends the
 * summary with the message history and, for OPENCLAW, the persistent sandbox
 * descriptor.
 */
export interface AgentThread extends AgentThreadSummary {
  messages: AgentMessage[];
  /** OPENCLAW only — the thread's persistent sandbox + exposed routes. */
  sandbox?: {
    sessionId: string;
    runtime: string;
    routes?: { url: string; port: number }[];
    updatedAt: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// R6 — DURABLE BACKGROUND RUNS (Phase 2)
//
// A background run is a detached agent turn executed on a BullMQ worker so it
// survives the browser disconnecting. These shapes mirror the backend run
// record (Moteur, clickdz-agent-runs.ts `AgentRunRecord` / `RunState`): the FE
// reads them via modules/agents/api.ts (`listAgentRuns` / `getAgentRun`) and the
// durable `useAgentRunStream` hook. All optional fields tolerate a partial
// payload so a run view never crashes on an evolving record.
// ─────────────────────────────────────────────────────────────────────────────

/** Coarse lifecycle state of a background run (mirrors the backend union). */
export type AgentRunState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'done'
  | 'failed'
  | 'stopped';

/** How the run was started (web console vs an inbound Telegram message). */
export type AgentRunChannel = 'web' | 'telegram';

/**
 * Compact background-run row for the Exécutions list (`GET /runs`), newest
 * first. Enough to render a state chip, a prompt preview, and a relative time.
 */
export interface AgentRunSummary {
  runId: string;
  agent: AgentName;
  state: AgentRunState;
  channel?: AgentRunChannel;
  /** The user's prompt that started the run. */
  prompt?: string;
  /** ms since epoch the run was created/enqueued. */
  startedAt?: number;
  /** ms since epoch the run reached a terminal state, when finished. */
  endedAt?: number;
  /** Failure message when `state === 'failed'`. */
  error?: string;
}

/**
 * Full background-run record (`GET /runs/:id`). Extends the summary with the
 * step timeline, the final answer, the continued thread, and the run budget —
 * used to seed a live view (an already-finished run renders instantly before
 * the stream re-attaches).
 */
export interface AgentRunRecord extends AgentRunSummary {
  /** The thread this run continued/created, when known. */
  threadId?: string;
  /** The recorded step timeline (same shape the `step` SSE frame carries). */
  steps?: AgentStep[];
  /** The final synthesized answer text, when the run has produced one. */
  finalText?: string;
  /** Tool-call/wall-clock budget accounting (loosely read). */
  budget?: {
    maxToolCalls?: number;
    maxWallMs?: number;
    toolCalls?: number;
  };
}
