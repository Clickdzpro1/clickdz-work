import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { PlatformNotifyService } from '@affine/core/modules/platform-notify';
import { useServiceOptional } from '@toeverything/infra';
import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from './api';
import type {
  AgentArtifact,
  AgentEvent,
  AgentMessage,
  AgentName,
  AgentPhase,
  AgentRunState,
  AgentStep,
} from './types';

/**
 * React hook that drives ONE live agent run over SSE for a console.
 *
 * It POSTs to `/api/v1/<agent>/stream` with `fetch` + `credentials:'include'`
 * (cookie auth — the backend reads `@CurrentUser()`), reads the response body
 * with a `ReadableStream` reader, and parses the `data: ${JSON.stringify(ev)}\n\n`
 * SSE frames the RUNTIME emits (single `data:` line per frame; the `type` field
 * discriminates — there is NO `event:` field). This mirrors the server's own
 * consumer loop and the chat page's `getReader()` idiom (recon RECON-STREAMING
 * §2 + §4); EventSource can't POST a body or send cookies cross-origin, so the
 * fetch-reader path is used instead.
 *
 * As frames arrive it maintains the IN-PROGRESS assistant message — appending
 * `step`s, accumulating `token`s into its content, attaching `tool_call` /
 * `tool_result` pairs to steps — and collects `file` / `terminal` / `preview` /
 * `artifact` events into exposed arrays for the workspace panels. It surfaces a
 * pending `approval_request` (resolved via {@link UseAgentStream.approve}), and
 * tracks `status` phase/label. On `final` it captures the persisted turn; the
 * stream ends on `done` or reader close.
 *
 * Everything is defensive: a partial frame spanning chunks is buffered until
 * complete, `ping` heartbeats are ignored, and any network/parse error is
 * surfaced via `error` rather than thrown (the console never crashes on a bad
 * stream). The raw event stream is also exposed via an optional `onEvent`
 * callback for callers that want to react to individual frames.
 */

/** A tool call surfaced live, with its result attached once it lands. */
export interface StreamToolCall {
  id: string;
  tool: string;
  title: string;
  args?: unknown;
  ok?: boolean;
  resultPreview?: string;
  error?: string;
  durationMs?: number;
  /** false until the matching `tool_result` (or turn end) resolves it. */
  done: boolean;
}

/** A live terminal line (OPENCLAW). */
export interface StreamTerminalLine {
  stream: 'stdout' | 'stderr';
  data: string;
  cmdId?: string;
}

/** A file-tree delta observed during the run (OPENCLAW). */
export interface StreamFileDelta {
  op: 'write' | 'update' | 'delete';
  path: string;
  language?: string;
}

/** Live preview descriptor (OPENCLAW dev server). */
export interface StreamPreview {
  url: string;
  port: number;
  status: 'starting' | 'ready';
}

/** A pending approval the user must resolve before the run continues. */
export interface PendingApproval {
  id: string;
  tool: string;
  title: string;
  summary: string;
  args?: unknown;
}

/** The assistant message being assembled, before it is persisted as `final`. */
export interface StreamingMessage {
  id: string;
  role: 'assistant';
  content: string;
  steps: AgentStep[];
  createdAt: number;
  agent: AgentName;
}

/** Input for a single send. */
export interface AgentStreamInput {
  message: string;
  /** Existing thread to continue; omit to start a new one (server mints the id). */
  threadId?: string;
  /** HERMES run mode. */
  mode?: 'auto' | 'ask' | 'dry';
  /** OPENCLAW sandbox runtime. */
  runtime?: 'node24' | 'python3.13';
}

/** Options for {@link useAgentStream}. */
export interface UseAgentStreamOptions {
  agent: AgentName;
  /** Optional raw-frame observer, invoked for every parsed (non-ping) event. */
  onEvent?: (event: AgentEvent) => void;
}

/** What {@link useAgentStream} exposes to a console page. */
export interface UseAgentStream {
  /** True from send() until the stream ends (done / final / close / error). */
  running: boolean;
  /** Last `status` label, or null. */
  status: string | null;
  /** Last `status` phase, or null. */
  phase: AgentPhase | null;
  /** The assistant turn being assembled live, or null when idle. */
  streamingMessage: StreamingMessage | null;
  /** The threadId for the active run (from the `thread` event), or null. */
  threadId: string | null;
  /** Live tool-call cards (id-keyed order preserved). */
  toolCalls: StreamToolCall[];
  /** Live terminal output (OPENCLAW). */
  terminal: StreamTerminalLine[];
  /** File-tree deltas seen this run (OPENCLAW). */
  files: StreamFileDelta[];
  /** Live preview descriptor (OPENCLAW), or null. */
  preview: StreamPreview | null;
  /** Artifacts collected during the run. */
  artifacts: AgentArtifact[];
  /** A pending approval to resolve, or null. */
  pendingApproval: PendingApproval | null;
  /** The completed, persisted assistant message from `final`, or null. */
  finalMessage: AgentMessage | null;
  /** Last error message, or null. Cleared at the start of each send. */
  error: string | null;
  /** Start a run. Resolves when the stream ends. Ignored if already running. */
  send: (input: AgentStreamInput) => Promise<void>;
  /** Abort the live stream and ask the backend to stop the run. */
  stop: () => void;
  /** Resolve the pending approval (or an explicit approvalId). */
  approve: (
    approvalId: string,
    decision: 'approve' | 'deny'
  ) => Promise<void>;
}

/** A fresh, empty streaming assistant message. */
function newStreamingMessage(agent: AgentName): StreamingMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    content: '',
    steps: [],
    createdAt: Date.now(),
    agent,
  };
}

export function useAgentStream(
  options: UseAgentStreamOptions
): UseAgentStream {
  const { agent, onEvent } = options;

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [phase, setPhase] = useState<AgentPhase | null>(null);
  const [streamingMessage, setStreamingMessage] =
    useState<StreamingMessage | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [toolCalls, setToolCalls] = useState<StreamToolCall[]>([]);
  const [terminal, setTerminal] = useState<StreamTerminalLine[]>([]);
  const [files, setFiles] = useState<StreamFileDelta[]>([]);
  const [preview, setPreview] = useState<StreamPreview | null>(null);
  const [artifacts, setArtifacts] = useState<AgentArtifact[]>([]);
  const [pendingApproval, setPendingApproval] =
    useState<PendingApproval | null>(null);
  const [finalMessage, setFinalMessage] = useState<AgentMessage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // Latest onEvent without re-creating send on every render.
  const onEventRef = useRef<typeof onEvent>(onEvent);
  onEventRef.current = onEvent;
  // The active run's threadId, readable synchronously inside stop().
  const threadIdRef = useRef<string | null>(null);
  // Optional platform-notifications hub: undefined when not mounted, so the
  // emit below stays additive + never throws.
  const platformNotify = useServiceOptional(PlatformNotifyService);
  const platformNotifyRef = useRef(platformNotify);
  platformNotifyRef.current = platformNotify;

  /**
   * Apply one parsed event to state. Kept as a plain function (not memoized)
   * because it is only ever called from inside the send() reader loop.
   */
  const dispatch = useCallback(
    (ev: AgentEvent) => {
      switch (ev.type) {
        case 'ping':
          return; // heartbeat — ignore, do not forward to onEvent
        case 'thread': {
          threadIdRef.current = ev.threadId;
          setThreadId(ev.threadId);
          break;
        }
        case 'status': {
          setPhase(ev.phase);
          setStatus(ev.label);
          break;
        }
        case 'token': {
          setStreamingMessage(prev => {
            const cur = prev ?? newStreamingMessage(agent);
            return { ...cur, content: cur.content + ev.text };
          });
          break;
        }
        case 'step': {
          setStreamingMessage(prev => {
            const cur = prev ?? newStreamingMessage(agent);
            return { ...cur, steps: [...cur.steps, ev.step] };
          });
          break;
        }
        case 'tool_call': {
          setToolCalls(prev => [
            ...prev,
            {
              id: ev.id,
              tool: ev.tool,
              title: ev.title,
              args: ev.args,
              done: false,
            },
          ]);
          break;
        }
        case 'tool_result': {
          setToolCalls(prev =>
            prev.map(tc =>
              tc.id === ev.id
                ? {
                    ...tc,
                    ok: ev.ok,
                    resultPreview: ev.resultPreview,
                    error: ev.error,
                    durationMs: ev.durationMs,
                    done: true,
                  }
                : tc
            )
          );
          break;
        }
        case 'approval_request': {
          setPendingApproval({
            id: ev.id,
            tool: ev.tool,
            title: ev.title,
            summary: ev.summary,
            args: ev.args,
          });
          break;
        }
        case 'artifact': {
          setArtifacts(prev => [...prev, ev.artifact]);
          break;
        }
        case 'preview': {
          setPreview({ url: ev.url, port: ev.port, status: ev.status });
          break;
        }
        case 'terminal': {
          setTerminal(prev => [
            ...prev,
            { stream: ev.stream, data: ev.data, cmdId: ev.cmdId },
          ]);
          break;
        }
        case 'file': {
          setFiles(prev => [
            ...prev,
            { op: ev.op, path: ev.path, language: ev.language },
          ]);
          break;
        }
        case 'final': {
          setFinalMessage(ev.message);
          // Adopt the persisted message as the rendered streaming message so the
          // console shows the canonical content/steps once the turn completes.
          setStreamingMessage({
            id: ev.message.id,
            role: 'assistant',
            content: ev.message.content,
            steps: ev.message.steps ?? [],
            createdAt: ev.message.createdAt,
            agent: ev.message.agent,
          });
          // A completed turn clears any lingering approval prompt.
          setPendingApproval(null);
          try {
            platformNotifyRef.current?.notify({
              studio: agent,
              title: 'Run complete',
              action: { label: 'View', route: '/' + agent },
            });
          } catch {
            // a notify failure must never break the agent stream
          }
          break;
        }
        case 'error': {
          setError(ev.message || ev.code || 'Agent run failed.');
          setPhase('error');
          break;
        }
        default:
          // Exhaustiveness: unknown future event types are ignored safely.
          break;
      }
      // Forward every non-ping frame to the optional observer.
      try {
        onEventRef.current?.(ev);
      } catch {
        // a throwing observer must never break the stream
      }
    },
    [agent]
  );

  const send = useCallback(
    async (input: AgentStreamInput): Promise<void> => {
      const message = input.message.trim();
      // Re-entrancy guard: one live stream at a time.
      if (!message || abortRef.current) return;

      // Reset per-run state.
      const controller = new AbortController();
      abortRef.current = controller;
      threadIdRef.current = input.threadId ?? null;
      setThreadId(input.threadId ?? null);
      setRunning(true);
      setError(null);
      setStatus(null);
      setPhase(null);
      setStreamingMessage(newStreamingMessage(agent));
      setToolCalls([]);
      setTerminal([]);
      setFiles([]);
      setPreview(null);
      setArtifacts([]);
      setPendingApproval(null);
      setFinalMessage(null);

      try {
        const res = await fetch(cdzApiUrl(`/api/v1/${agent}/stream`), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          credentials: 'include',
          body: JSON.stringify({
            message,
            threadId: input.threadId,
            mode: input.mode,
            runtime: input.runtime,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          // Surface a typed message from the error body when possible.
          let msg = `Agent stream failed (${res.status})`;
          try {
            const data = (await res.json()) as any;
            const m =
              data?.message ??
              data?.error?.message ??
              (typeof data?.error === 'string' ? data.error : undefined);
            if (typeof m === 'string' && m.trim()) msg = m.trim();
          } catch {
            // keep the status-based fallback
          }
          throw new Error(msg);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        // Read chunks, accumulate a text buffer, and split complete SSE frames
        // on the blank-line separator. A partial frame stays in `buffer` until
        // the next chunk completes it (frames can span reads).
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            // A frame is one or more lines; collect the `data:` payload(s).
            // (The RUNTIME emits a single data line, but we tolerate multi-line
            // data and SSE comment/`event:` lines defensively.)
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
              // Drain remaining bytes then fall through to close.
              try {
                await reader.cancel();
              } catch {
                /* already closing */
              }
              return;
            }
            dispatch(ev);
          }
        }
      } catch (err) {
        // A user-initiated abort (stop / unmount) is not an error to surface.
        if (!controller.signal.aborted) {
          setError(
            err instanceof Error ? err.message : 'Agent run failed.'
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setRunning(false);
      }
    },
    [agent, dispatch]
  );

  const stop = useCallback(() => {
    const tid = threadIdRef.current;
    // Abort the live fetch immediately so the reader loop exits.
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setPhase('stopped');
    // Best-effort cooperative stop on the backend (fire-and-forget; a failure
    // here must not surface as a run error — the client is already stopped).
    if (tid) {
      api.stopRun(agent, tid).catch(() => {
        /* best-effort */
      });
    }
  }, [agent]);

  const approve = useCallback(
    async (
      approvalId: string,
      decision: 'approve' | 'deny'
    ): Promise<void> => {
      const tid = threadIdRef.current;
      // Optimistically clear the prompt so the UI unblocks immediately.
      setPendingApproval(prev =>
        prev && prev.id === approvalId ? null : prev
      );
      if (!tid) return;
      try {
        await api.approve(agent, tid, approvalId, decision);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to submit approval.'
        );
      }
    },
    [agent]
  );

  return {
    running,
    status,
    phase,
    streamingMessage,
    threadId,
    toolCalls,
    terminal,
    files,
    preview,
    artifacts,
    pendingApproval,
    finalMessage,
    error,
    send,
    stop,
    approve,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// useAgentRunStream — DURABLE background-run attach (R6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Terminal run states — once reached, the run is finished and there is nothing
 * left to attach to (so we don't re-attach on tab-return).
 */
const TERMINAL_RUN_STATES: ReadonlySet<AgentRunState> = new Set<AgentRunState>([
  'done',
  'failed',
  'stopped',
]);

/**
 * Map a live `status` phase onto the coarse background-run lifecycle state the
 * Exécutions UI renders (queued/running/waiting_approval/done/failed/stopped).
 * A terminal phase wins; every intermediate working phase reads as `running`.
 */
function phaseToRunState(
  phase: AgentPhase,
  current: AgentRunState
): AgentRunState {
  switch (phase) {
    case 'waiting_approval':
      return 'waiting_approval';
    case 'done':
      return 'done';
    case 'error':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      // planning | executing | writing | running | installing | previewing |
      // finalizing → the run is actively working. Never downgrade a terminal
      // state we've already latched (a late status frame after `final`).
      return TERMINAL_RUN_STATES.has(current) ? current : 'running';
  }
}

/** Options for {@link useAgentRunStream}. */
export interface UseAgentRunStreamOptions {
  agent: AgentName;
  /** The background run to attach to. `null`/empty = idle (nothing attaches). */
  runId: string | null;
  /** Optional raw-frame observer, invoked for every parsed (non-ping) event. */
  onEvent?: (event: AgentEvent) => void;
}

/** What {@link useAgentRunStream} exposes to a run live-view. */
export interface UseAgentRunStream {
  /** The run's accumulated step timeline (replayed history + live), in order. */
  steps: AgentStep[];
  /** Coarse lifecycle state, derived from `status`/terminal frames. */
  state: AgentRunState;
  /** The final answer text (streamed tokens, replaced by the persisted `final`). */
  finalText: string;
  /** Last `status` phase seen, or null (finer-grained than `state`). */
  phase: AgentPhase | null;
  /** True while a stream reader is live-attached. */
  attached: boolean;
  /** A pending approval to resolve, or null (surfaced from `approval_request`). */
  pendingApproval: PendingApproval | null;
  /** Last error message, or null. */
  error: string | null;
  /** Re-attach to the run's stream (replay restores full history). */
  reattach: () => void;
  /** Ask the backend to stop the run and detach the live stream. */
  stop: () => void;
  /** Resolve the pending approval (or an explicit stepId). */
  approve: (stepId: string, approved: boolean) => Promise<void>;
}

/**
 * React hook that ATTACHES to a durable background run's SSE stream and rebuilds
 * its live view. Unlike {@link useAgentStream} (which OWNS one request-scoped run
 * it starts via POST), this hook is read-mostly: the run executes detached on a
 * backend worker, and the hook connects to `/api/v1/agents/<agent>/runs/:id/stream`
 * (via {@link api.openAgentRunStream}) to replay the recorded event history and
 * then follow live frames.
 *
 * It reuses the EXACT reducer semantics of the console stream — a `step` frame
 * appends to the timeline, `token` frames accumulate the answer, `final` adopts
 * the persisted message (canonical steps + content), `approval_request` surfaces
 * a prompt, and `status` drives the coarse `state` — but exposes the compact
 * `{steps, state, finalText, reattach, stop}` surface the Exécutions live view
 * needs (the durable analogue of the console's rich per-turn surface).
 *
 * Re-attach is safe and idempotent: because the backend replays the full event
 * list on connect, {@link reattach} (and the automatic re-attach on mount /
 * agent+run change / tab-return) resets the accumulators and rebuilds from
 * scratch — no duplicated steps. The stream is abortable via an AbortController;
 * unmounting or switching runs aborts cleanly (no error surfaced). All state
 * updates are guarded against a post-unmount write.
 */
export function useAgentRunStream(
  options: UseAgentRunStreamOptions
): UseAgentRunStream {
  const { agent, runId, onEvent } = options;

  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [state, setState] = useState<AgentRunState>('queued');
  const [finalText, setFinalText] = useState('');
  const [phase, setPhase] = useState<AgentPhase | null>(null);
  const [attached, setAttached] = useState(false);
  const [pendingApproval, setPendingApproval] =
    useState<PendingApproval | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // Guard against setting state after unmount (the reader loop is async).
  const mountedRef = useRef(true);
  // Latest onEvent without re-creating the attach loop each render.
  const onEventRef = useRef<typeof onEvent>(onEvent);
  onEventRef.current = onEvent;
  // Latest lifecycle state, readable synchronously inside the visibility
  // handler (so we don't re-attach to an already-terminal run).
  const stateRef = useRef<AgentRunState>(state);
  stateRef.current = state;
  // Tokens streamed so far this attach; `final` overrides with the persisted
  // content. Kept in a ref so we only surface a coherent string via setFinalText.
  const tokenBufRef = useRef('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Apply one parsed event to state. Same discrimination as the console
   * dispatch, projected onto the compact run-view surface.
   */
  const dispatch = useCallback((ev: AgentEvent) => {
    switch (ev.type) {
      case 'status': {
        setPhase(ev.phase);
        setState(prev => phaseToRunState(ev.phase, prev));
        break;
      }
      case 'token': {
        tokenBufRef.current += ev.text;
        setFinalText(tokenBufRef.current);
        break;
      }
      case 'step': {
        // Same append reducer as the console (stable order, dedupe by index so a
        // replayed-then-live overlap never doubles a row).
        setSteps(prev => {
          if (prev.some(s => s.i === ev.step.i)) {
            return prev.map(s => (s.i === ev.step.i ? ev.step : s));
          }
          return [...prev, ev.step];
        });
        break;
      }
      case 'approval_request': {
        setState(prev =>
          TERMINAL_RUN_STATES.has(prev) ? prev : 'waiting_approval'
        );
        setPendingApproval({
          id: ev.id,
          tool: ev.tool,
          title: ev.title,
          summary: ev.summary,
          args: ev.args,
        });
        break;
      }
      case 'final': {
        // Adopt the persisted turn as canonical: content + full step timeline.
        if (typeof ev.message.content === 'string') {
          tokenBufRef.current = ev.message.content;
          setFinalText(ev.message.content);
        }
        if (Array.isArray(ev.message.steps) && ev.message.steps.length > 0) {
          setSteps(ev.message.steps);
        }
        setState(prev => (TERMINAL_RUN_STATES.has(prev) ? prev : 'done'));
        setPendingApproval(null);
        break;
      }
      case 'error': {
        setError(ev.message || ev.code || 'Agent run failed.');
        setState('failed');
        setPhase('error');
        break;
      }
      default:
        // thread / tool_call / tool_result / artifact / preview / terminal /
        // file are covered by the persisted `step` timeline for the run view —
        // ignored here safely (exhaustive over the union).
        break;
    }
    // Forward every dispatched (non-ping) frame to the optional observer.
    try {
      onEventRef.current?.(ev);
    } catch {
      // a throwing observer must never break the stream
    }
  }, []);

  /**
   * Open (or re-open) the run stream. Aborts any prior reader first, resets the
   * accumulators (the backend replays history, so we rebuild from scratch), and
   * pumps frames through {@link dispatch}. No-op when there is no runId.
   */
  const attach = useCallback(() => {
    // Nothing to attach to.
    if (!runId) return;
    // Abort a prior attach so we never run two readers at once.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Reset per-attach accumulators. Replay rebuilds the timeline; a fresh
    // attach must not stack onto a stale one.
    tokenBufRef.current = '';
    if (mountedRef.current) {
      setSteps([]);
      setFinalText('');
      setError(null);
      setPendingApproval(null);
      setPhase(null);
      // Keep a latched terminal state (re-attaching a finished run should still
      // read terminal); otherwise reset to 'queued' until the first frame.
      setState(prev => (TERMINAL_RUN_STATES.has(prev) ? prev : 'queued'));
      setAttached(true);
    }

    void api
      .openAgentRunStream(agent, runId, {
        signal: controller.signal,
        onEvent: ev => {
          if (mountedRef.current) dispatch(ev);
        },
        onError: msg => {
          if (mountedRef.current && !controller.signal.aborted) {
            setError(msg);
          }
        },
        onClose: () => {
          // Only the CURRENT attach may flip the flag off (a superseded reader
          // closing must not clear a fresh attach's `attached`).
          if (abortRef.current === controller) {
            abortRef.current = null;
            if (mountedRef.current) setAttached(false);
          }
        },
      })
      .catch(() => {
        // openAgentRunStream never rejects, but stay defensive.
        if (mountedRef.current) setAttached(false);
      });
  }, [agent, runId, dispatch]);

  const reattach = useCallback(() => {
    attach();
  }, [attach]);

  // Attach on mount and whenever the target run (or agent) changes; detach on
  // cleanup. Because attach() aborts any prior reader, this is safe on rapid
  // runId changes.
  useEffect(() => {
    attach();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [attach]);

  // Re-attach when the tab becomes visible again (the browser may have dropped
  // an idle SSE connection while backgrounded). Skip terminal runs — there is
  // nothing more to stream, and replay already gave us the full history.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (!runId) return;
      if (TERMINAL_RUN_STATES.has(stateRef.current)) return;
      // No live reader → re-attach (replay restores anything missed).
      if (!abortRef.current) attach();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () =>
      document.removeEventListener('visibilitychange', onVisibility);
  }, [attach, runId]);

  const stop = useCallback(() => {
    // Abort the live reader immediately so the loop exits.
    abortRef.current?.abort();
    abortRef.current = null;
    if (mountedRef.current) {
      setAttached(false);
      setState(prev => (TERMINAL_RUN_STATES.has(prev) ? prev : 'stopped'));
    }
    // Best-effort cooperative stop on the backend (fire-and-forget; a failure
    // here must not surface as a run error — the client is already detached).
    if (runId) {
      api.stopAgentRun(agent, runId).catch(() => {
        /* best-effort */
      });
    }
  }, [agent, runId]);

  const approve = useCallback(
    async (stepId: string, approved: boolean): Promise<void> => {
      // Optimistically clear the prompt so the UI unblocks immediately.
      setPendingApproval(prev =>
        prev && prev.id === stepId ? null : prev
      );
      if (!runId) return;
      try {
        await api.approveAgentRun(agent, runId, stepId, approved);
      } catch (err) {
        if (mountedRef.current) {
          setError(
            err instanceof Error ? err.message : 'Failed to submit approval.'
          );
        }
      }
    },
    [agent, runId]
  );

  return {
    steps,
    state,
    finalText,
    phase,
    attached,
    pendingApproval,
    error,
    reattach,
    stop,
    approve,
  };
}
