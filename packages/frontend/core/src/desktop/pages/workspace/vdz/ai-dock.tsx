import {
  useVdzAi,
  type VdzChatTurn,
} from '@affine/core/modules/vdz/use-vdz-ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type VdzOp,
  vdzOpSchema,
  type VdzTimeline,
} from '../../../../modules/vdz';
import * as styles from './ai-dock.css';

/**
 * Vdz Studio "AI Dock" — a self-contained right-side chat panel that turns a
 * natural-language request into validated {@link VdzOp}s.
 *
 * This component is intentionally decoupled from how edits are applied: it
 * parses the model's `{summary, ops}` reply, validates EACH op client-side with
 * `vdzOpSchema.safeParse`, and hands the valid ops to `onApplyOps`. The HOST
 * decides what to do with them (the merge-time wiring proposes them as a
 * pending diff the user can Accept/Revert — see WIRING.md). The dock never
 * mutates the timeline itself.
 */
export interface VdzAiDockProps {
  /** The current timeline; sent as context on every turn. */
  timeline: VdzTimeline;
  /** Ids of currently-selected clips; disambiguate "this"/"these" for the AI. */
  selectedClipIds?: string[];
  /**
   * Called with the client-validated ops (and the model's summary) when the
   * user's request produced at least one valid op. The host applies them.
   */
  onApplyOps: (ops: VdzOp[], summary: string) => void;
  /**
   * Optional: a prompt to auto-send ONCE when it becomes non-empty. Lets the
   * Generate panel's "In editor" mode hand a brief straight to the dock pipeline
   * (text-to-timeline) so the user lands in the editor with a pending proposal.
   * The dock sends it exactly like a typed message and then calls
   * {@link onInitialPromptConsumed} so the host can clear it (preventing re-send).
   */
  initialPrompt?: string;
  /** Paired with {@link initialPrompt}: called right after it is auto-sent. */
  onInitialPromptConsumed?: () => void;
  /** Hide this panel (× in the header strip). */
  onCollapse?: () => void;
}

/** One rendered assistant reply: how many ops we accepted/rejected. */
interface AiReplyMeta {
  validCount: number;
  invalidCount: number;
  /** First-2k raw text when the model returned an unparseable response. */
  raw?: string;
}

export function VdzAiDock({
  timeline,
  selectedClipIds,
  onApplyOps,
  initialPrompt,
  onInitialPromptConsumed,
  onCollapse,
}: VdzAiDockProps) {
  const { history, busy, error, send, reset } = useVdzAi();
  const [draft, setDraft] = useState('');
  // Assistant-reply metadata in send order: the Nth entry annotates the Nth
  // assistant turn in `history`. Each successful send appends exactly one.
  const [replyMeta, setReplyMeta] = useState<AiReplyMeta[]>([]);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const selectedCount = selectedClipIds?.length ?? 0;

  // Auto-scroll the thread to the newest message.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, busy]);

  // Send one message through the full pipeline: transport → per-op client
  // validation → stage the valid ops via onApplyOps. Shared by the composer's
  // submit and the initialPrompt auto-send so both behave identically.
  const submitMessage = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;
      const result = await send(message, timeline, selectedClipIds);
      if (!result) return;

      // Validate each op client-side with the same schema the host applies with.
      const valid: VdzOp[] = [];
      let invalid = 0;
      for (const candidate of result.ops) {
        const parsed = vdzOpSchema.safeParse(candidate);
        if (parsed.success) {
          valid.push(parsed.data);
        } else {
          invalid += 1;
        }
      }

      // The hook appended exactly one assistant turn on success; record this
      // reply's metadata in send order to match it (see the render mapping).
      setReplyMeta(prev => [
        ...prev,
        { validCount: valid.length, invalidCount: invalid, raw: result.raw },
      ]);

      if (valid.length > 0) {
        onApplyOps(valid, result.summary);
      }
    },
    [busy, send, timeline, selectedClipIds, onApplyOps]
  );

  const onSubmit = useCallback(async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft('');
    await submitMessage(message);
  }, [draft, busy, submitMessage]);

  // Auto-send a handed-in prompt exactly once. The host clears initialPrompt via
  // onInitialPromptConsumed right after, so a re-render never re-sends it; a NEW
  // non-empty value (a fresh "Generate in editor") sends again. We consume
  // synchronously (before awaiting) so a slow request can't double-fire.
  const consumedPromptRef = useRef<string | null>(null);
  useEffect(() => {
    const p = initialPrompt?.trim();
    if (!p || busy) return;
    if (consumedPromptRef.current === p) return;
    consumedPromptRef.current = p;
    onInitialPromptConsumed?.();
    void submitMessage(p);
  }, [initialPrompt, busy, submitMessage, onInitialPromptConsumed]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void onSubmit();
      }
    },
    [onSubmit]
  );

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(event.target.value);
    },
    []
  );

  const canSend = draft.trim().length > 0 && !busy;

  const bubbles = useMemo(() => {
    let assistantOrdinal = -1;
    return history.map((turn, index) => {
      // Assistant turns consume reply-meta entries in order; user turns don't.
      const meta =
        turn.role === 'assistant' ? replyMeta[++assistantOrdinal] : undefined;
      return <ChatBubble key={index} turn={turn} meta={meta} />;
    });
  }, [history, replyMeta]);

  return (
    <div className={styles.dock} data-testid="vdz-ai-dock">
      <div className={styles.header}>
        <span className={styles.headerDot} />
        <span className={styles.headerTitle}>AI Dock</span>
        <span className={styles.headerSpacer} />
        <button
          type="button"
          className={styles.resetButton}
          onClick={reset}
          disabled={busy || history.length === 0}
        >
          Clear
        </button>
        {onCollapse ? (
          <button
            type="button"
            className={styles.collapseButton}
            onClick={onCollapse}
            title="Hide AI"
            aria-label="Hide AI"
          >
            ×
          </button>
        ) : null}
      </div>

      <div className={styles.thread} ref={threadRef}>
        {history.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyTitle}>Edit with words</div>
            Ask for a change — “cut the first 3 seconds”, “add a gold title
            LAUNCH at 2s”, or “make a 12s intro”. I’ll propose timeline edits
            you can review before they’re applied.
          </div>
        ) : (
          bubbles
        )}
        {busy ? <div className={styles.typing}>Thinking…</div> : null}
      </div>

      {error ? <div className={styles.errorBar}>{error}</div> : null}

      <div className={styles.composer}>
        {selectedCount > 0 ? (
          <div className={styles.selectionHint}>
            <span className={styles.selectionPill}>{selectedCount}</span>
            selected clip{selectedCount === 1 ? '' : 's'} in context
          </div>
        ) : null}
        <div className={styles.inputRow}>
          <textarea
            className={styles.textarea}
            placeholder="Describe an edit…"
            value={draft}
            onChange={onChange}
            onKeyDown={onKeyDown}
            rows={1}
            aria-label="Message the Vdz AI"
          />
          <button
            type="button"
            className={styles.sendButton}
            onClick={() => void onSubmit()}
            disabled={!canSend}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/** A single chat bubble (user or assistant). */
function ChatBubble({
  turn,
  meta,
}: {
  turn: VdzChatTurn;
  meta: AiReplyMeta | undefined;
}) {
  if (turn.role === 'user') {
    return <div className={styles.userBubble}>{turn.content}</div>;
  }

  // Assistant bubble: summary + op-count annotation (from meta, if present).
  const hadOps = meta && (meta.validCount > 0 || meta.invalidCount > 0);
  const unparseable = meta?.raw != null && !hadOps;

  return (
    <div className={unparseable ? styles.aiBubbleError : styles.aiBubble}>
      {turn.content}
      {meta && hadOps ? (
        <div className={styles.opCount}>
          <span className={styles.opCountDot} />
          {meta.validCount} op{meta.validCount === 1 ? '' : 's'} proposed
          {meta.invalidCount > 0
            ? ` · ${meta.invalidCount} skipped (invalid)`
            : ''}
        </div>
      ) : null}
      {unparseable && meta?.raw ? (
        <details className={styles.rawDetails}>
          <summary className={styles.rawSummary}>Show raw response</summary>
          <pre className={styles.rawPre}>{meta.raw}</pre>
        </details>
      ) : null}
    </div>
  );
}
