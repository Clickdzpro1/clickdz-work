import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useRef, useState } from 'react';

import * as api from './api';
import type {
  AgentArtifact,
  AgentEvent,
  AgentMessage,
  AgentName,
  AgentPhase,
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
