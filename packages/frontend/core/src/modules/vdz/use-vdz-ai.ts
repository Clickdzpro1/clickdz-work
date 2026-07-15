import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useRef, useState } from 'react';

import type { VdzTimeline } from './schema';

/**
 * React hook powering the Vdz Studio "AI Dock".
 *
 * Owns the transport + conversation state for the dock; it deliberately does
 * NOT validate or apply ops — that stays with the dock component (which runs
 * `vdzOpSchema.safeParse` per op) and the host (which applies them through the
 * timeline's single `applyOps` path). This keeps the hook a thin, testable
 * fetch wrapper.
 *
 * Desktop parity: the request URL is wrapped with {@link cdzApiUrl} so it
 * resolves against the connected server on desktop/native (where a bare
 * `/api/...` would hit the app bundle) and stays relative on web. (PR #28.)
 */

/** A chat turn we keep in the dock thread and forward as history. */
export interface VdzChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** The server's chat response envelope (ops stay opaque until validated). */
export interface VdzChatResponse {
  summary: string;
  ops: unknown[];
  /** Present only when the model returned something unparseable. */
  raw?: string;
}

/** What {@link useVdzAi} exposes to the dock. */
export interface UseVdzAi {
  /** Prior turns, oldest→newest, forwarded as history on the next send. */
  history: VdzChatTurn[];
  /** True while a request is in flight. */
  busy: boolean;
  /** Last error message, or null. */
  error: string | null;
  /**
   * Send a user message with the current timeline + selection. Resolves with
   * the parsed `{summary, ops}` envelope, or null if the request failed or was
   * aborted. Appends the user turn (and, on success, an assistant summary turn)
   * to {@link history}.
   */
  send: (
    message: string,
    timeline: VdzTimeline,
    selectedClipIds?: string[]
  ) => Promise<VdzChatResponse | null>;
  /** Abort an in-flight request, if any. */
  cancel: () => void;
  /** Clear the conversation thread and any error. */
  reset: () => void;
}

/** Max turns of history we forward (mirrors the server cap). */
const MAX_HISTORY_TURNS = 20;

export function useVdzAi(): UseVdzAi {
  const [history, setHistory] = useState<VdzChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Keep a ref mirror of history so `send` can read the latest turns without
  // being re-created on every message (stable identity for callers).
  const historyRef = useRef<VdzChatTurn[]>([]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  }, []);

  const reset = useCallback(() => {
    cancel();
    historyRef.current = [];
    setHistory([]);
    setError(null);
  }, [cancel]);

  const send = useCallback(
    async (
      message: string,
      timeline: VdzTimeline,
      selectedClipIds?: string[]
    ): Promise<VdzChatResponse | null> => {
      const trimmed = message.trim();
      if (!trimmed || busy) return null;

      // Cancel any prior in-flight request before starting a new one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Snapshot history to forward, then optimistically append the user turn.
      const priorHistory = historyRef.current.slice(-MAX_HISTORY_TURNS);
      const userTurn: VdzChatTurn = { role: 'user', content: trimmed };
      historyRef.current = [...historyRef.current, userTurn];
      setHistory(historyRef.current);
      setBusy(true);
      setError(null);

      try {
        const response = await fetch(cdzApiUrl('/api/v1/vdz/chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: trimmed,
            timeline,
            selectedClipIds: selectedClipIds ?? [],
            history: priorHistory,
          }),
          signal: controller.signal,
        });

        const data = (await response.json().catch(() => null)) as
          | (Partial<VdzChatResponse> & {
              error?: { message?: string };
            })
          | null;

        if (!response.ok) {
          throw new Error(
            data?.error?.message || `Vdz AI request failed (${response.status})`
          );
        }

        const summary =
          typeof data?.summary === 'string' && data.summary.trim()
            ? data.summary.trim()
            : 'Proposed timeline edit';
        const ops = Array.isArray(data?.ops) ? data.ops : [];
        const raw = typeof data?.raw === 'string' ? data.raw : undefined;

        // Record the assistant summary as a history turn for context on the
        // next send (the op JSON itself is not fed back — the timeline is).
        const assistantTurn: VdzChatTurn = {
          role: 'assistant',
          content: summary,
        };
        historyRef.current = [...historyRef.current, assistantTurn];
        setHistory(historyRef.current);

        return { summary, ops, raw };
      } catch (err) {
        // A user-initiated abort is not an error to surface.
        if (controller.signal.aborted) {
          return null;
        }
        const messageText =
          err instanceof Error ? err.message : 'Vdz AI request failed';
        setError(messageText);
        return null;
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setBusy(false);
      }
    },
    [busy]
  );

  return { history, busy, error, send, cancel, reset };
}
