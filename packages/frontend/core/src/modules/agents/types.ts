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
export type AgentRunChannel = 'web' | 'telegram' | 'schedule' | 'webhook';

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
  /**
   * Tool-call/wall-clock budget accounting (loosely read). The backend's
   * `GET /runs` list route returns FULL records (the normalizer always fills
   * `budget`), so it rides summary rows too — which is what lets the compact
   * `<SpendMeter run={summary} />` in runs.tsx read `budget.toolCalls`.
   */
  budget?: {
    maxToolCalls?: number;
    maxWallMs?: number;
    toolCalls?: number;
  };
}

/**
 * Full background-run record (`GET /runs/:id`). Extends the summary with the
 * step timeline, the final answer and the continued thread — used to seed a
 * live view (an already-finished run renders instantly before the stream
 * re-attaches).
 */
export interface AgentRunRecord extends AgentRunSummary {
  /** The thread this run continued/created, when known. */
  threadId?: string;
  /** The recorded step timeline (same shape the `step` SSE frame carries). */
  steps?: AgentStep[];
  /** The final synthesized answer text, when the run has produced one. */
  finalText?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// R7 — AGENTS ROSTER + CAPABILITIES (unified /agents studio)
//
// The shape returned by GET /api/v1/agents (ClickDzAgentsController). R6 shipped
// the per-agent roster rows ({@link AgentSummary}); R7 extends the response with
// a top-level {@link AgentCaps} object so the whole endpoint doubles as the
// capability probe the unified UI keys off (caps.multi gates the new UI). The FE
// reads it via modules/agents/use-agents.ts (`useAgents()`), which treats a 404
// (feature dark, CDZ_AGENTS_ENABLED off) as "disabled". Keep in step with the
// backend AgentStatus row + the caps object it now serializes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One agent roster row (GET /api/v1/agents → `agents[]`). Mirrors the backend
 * `AgentStatus`: identity + a `beta` flag, the caller's newest run projection,
 * and per-channel binding flags. `lastRun.state` is an {@link AgentRunState}
 * (the run engine persists that union); `at` is ms since epoch (endedAt, else
 * startedAt).
 */
export interface AgentSummary {
  /**
   * Stable agent id (also the run/console API path segment). For the two
   * built-ins this is an {@link AgentName} literal (`'hermes'`/`'openclaw'`);
   * R12 custom agents carry an opaque backend id (a `cz_`-prefixed string), so
   * the type widens to `AgentName | string`. The union stays assignable from
   * the existing literals ⇒ every pre-R12 consumer stays type-valid; the
   * literal arm is kept for readable narrowing / discrimination at call sites.
   */
  id: AgentName | string;
  /**
   * R12: the built-in archetype a custom agent CLONES (`'hermes'`/`'openclaw'`).
   * Absent on the two built-in roster rows and on any pre-R12 payload — so a
   * row with no `archetype` is a built-in, one with it set is user-created.
   */
  archetype?: 'hermes' | 'openclaw';
  /**
   * R12: the user-chosen display name for a custom agent. When present it is
   * what the UI shows; built-ins fall back to {@link AgentSummary.label}.
   */
  name?: string;
  /** R12: optional user-chosen emoji glyph for a custom agent's avatar. */
  emoji?: string;
  /** Product-facing display name (e.g. "Hermes"). */
  label: string;
  /** True while the agent is flagged beta in the roster. */
  beta?: boolean;
  /** The caller's most recent run for this agent, when one exists. */
  lastRun?: {
    runId: string;
    state: AgentRunState;
    /** ms since epoch — the run's endedAt, else startedAt. */
    at: number;
  };
  /** Per-channel binding flags for this caller (e.g. a bound Telegram chat). */
  channels: {
    telegram: boolean;
  };
}

/**
 * Top-level capability flags on the roster response (R7). Derived on the backend
 * from env: `multi` = CDZ_AGENTS_MULTI (the master switch for the unified UI),
 * `dzdPer1k` = CDZ_DZD_PER_1K (spend-estimate rate, 0 = no estimate),
 * `telegramEnabled` = CDZ_AGENT_TELEGRAM_ENABLED, `webEnabled` =
 * CDZ_AGENT_WEB_ENABLED. Everything in the unified UI gates on `caps.multi`.
 */
export interface AgentCaps {
  /** Master switch for the unified /agents UI; false ⇒ legacy behavior only. */
  multi: boolean;
  /** DZD per 1k tokens for the "estimé" spend display (0 ⇒ no estimate). */
  dzdPer1k: number;
  /** Whether the Telegram channel is enabled server-side. */
  telegramEnabled: boolean;
  /** Whether agent web access is enabled server-side. */
  webEnabled: boolean;
  /**
   * R16 master switch for the WhatsApp channel (backend WA feature flag +
   * gateway). Gates the per-(user,agent) `<WhatsAppChannelCard>` on the
   * connections page: false/absent ⇒ the card shows its quiet "bientôt" (dark)
   * face rather than the phone-input pairing flow. Optional so a pre-R16 payload
   * (no flag) reads `undefined` ⇒ falsy ⇒ feature dark, byte-identical to the
   * pre-WhatsApp build. `DEFAULT_AGENT_CAPS` seeds it explicit `false`. Mirrors
   * how `telegramEnabled` gates the Telegram card.
   */
  whatsappEnabled?: boolean;
  /**
   * R12 master switch for the custom-agent creator (backend
   * `CDZ_AGENT_CUSTOM_ENABLED`). When false/absent the "Créer un agent"
   * affordance stays hidden and `/agents/new` shows a quiet "bientôt" panel
   * rather than a dead form. Optional so a pre-R12 payload (no flag) reads
   * `undefined` ⇒ falsy ⇒ feature dark, byte-identical to the built-ins-only
   * build. `DEFAULT_AGENT_CAPS` seeds it explicit `false`.
   */
  customEnabled?: boolean;
}

/** Envelope returned by GET /api/v1/agents: the roster plus capability flags. */
export interface AgentsListResponse {
  agents: AgentSummary[];
  caps: AgentCaps;
}
