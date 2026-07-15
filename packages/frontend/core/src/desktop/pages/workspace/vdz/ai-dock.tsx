import { suggestEdits, type VdzSuggestion } from '@affine/core/modules/vdz';
import {
  useVdzAi,
  type VdzChatMode,
  type VdzChatTurn,
  type VdzPlanStep,
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
 * natural-language request into validated {@link VdzOp}s (Edit mode) or a
 * step-by-step how-to plan (Plan mode).
 *
 * This component is intentionally decoupled from how edits are applied: it
 * parses the model's `{summary, ops}` reply, validates EACH op client-side with
 * `vdzOpSchema.safeParse`, and hands the valid ops to `onApplyOps`. The HOST
 * decides what to do with them — it STAGES them as a `pendingProposal` and
 * passes it back down so the dock renders an in-thread PROPOSAL CARD (with big
 * Accept / Revert buttons) right where the user is looking. The dock never
 * mutates the timeline itself; the host still owns the single apply path.
 *
 * Beyond the chat loop the dock is proactive: when idle it derives concrete,
 * clickable suggestion chips from the ACTUAL timeline (see
 * {@link suggestEdits}); and a Plan mode lets the user describe a goal and get
 * a numbered checklist, each step runnable as an edit with one click.
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
   * The host's staged, not-yet-applied proposal (the result of the most recent
   * {@link onApplyOps}), or null. When set, the dock renders the in-thread
   * proposal card with Accept / Revert. The host keeps owning this state.
   */
  pendingProposal?: { ops: VdzOp[]; summary: string } | null;
  /** Accept the staged proposal (host applies it through the history path). */
  onAcceptProposal?: () => void;
  /** Discard the staged proposal untouched. */
  onRevertProposal?: () => void;
  /** An apply error from the host (shown inside the proposal card). */
  proposalError?: string | null;
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

/**
 * Per-assistant-reply metadata in send order: the Nth entry annotates the Nth
 * assistant turn in `history`. Each successful send appends exactly one. Carries
 * whatever that turn produced — op counts (edit), a plan (plan mode), or nothing
 * (a plain conversational reply).
 */
interface AiReplyMeta {
  validCount: number;
  invalidCount: number;
  /** The client-validated ops for this turn (drives the op-preview list). */
  ops?: VdzOp[];
  /** A plan checklist when this turn was a plan-mode reply. */
  plan?: VdzPlanStep[];
  /** First-2k raw text when the model returned an unparseable response. */
  raw?: string;
}

// The Web Speech API is not in the ambient DOM lib types here; declare the
// minimal surface we use so dictation compiles without a global type dependency.
interface MinimalSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
type SpeechRecognitionCtor = new () => MinimalSpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function VdzAiDock({
  timeline,
  selectedClipIds,
  onApplyOps,
  pendingProposal,
  onAcceptProposal,
  onRevertProposal,
  proposalError,
  initialPrompt,
  onInitialPromptConsumed,
  onCollapse,
}: VdzAiDockProps) {
  const { history, busy, error, send, reset } = useVdzAi();
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<VdzChatMode>('edit');
  const [replyMeta, setReplyMeta] = useState<AiReplyMeta[]>([]);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const selectedCount = selectedClipIds?.length ?? 0;
  const planMode = mode === 'plan';

  // Auto-scroll the thread to the newest message (and when a proposal lands).
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, busy, pendingProposal]);

  // Send one message through the full pipeline for a given mode. Edit-mode
  // replies validate ops per-schema and stage the valid ones via onApplyOps;
  // plan-mode replies capture the returned checklist for in-thread rendering.
  // Shared by the composer, suggestion chips, plan "Do it" and the auto-send.
  const submitMessage = useCallback(
    async (text: string, turnMode: VdzChatMode) => {
      const message = text.trim();
      if (!message || busy) return;
      const result = await send(message, timeline, selectedClipIds, turnMode);
      if (!result) return;

      if (turnMode === 'plan') {
        // Plan mode: no ops to apply; keep the checklist for this reply turn.
        setReplyMeta(prev => [
          ...prev,
          {
            validCount: 0,
            invalidCount: 0,
            plan: result.plan,
            raw: result.plan ? undefined : result.raw,
          },
        ]);
        return;
      }

      // Edit mode: validate each op client-side with the same schema the host
      // applies with, then stage the valid ones.
      const valid: VdzOp[] = [];
      let invalid = 0;
      for (const candidate of result.ops) {
        const parsed = vdzOpSchema.safeParse(candidate);
        if (parsed.success) valid.push(parsed.data);
        else invalid += 1;
      }

      setReplyMeta(prev => [
        ...prev,
        {
          validCount: valid.length,
          invalidCount: invalid,
          ops: valid.length > 0 ? valid : undefined,
          raw: result.raw,
        },
      ]);

      if (valid.length > 0) onApplyOps(valid, result.summary);
    },
    [busy, send, timeline, selectedClipIds, onApplyOps]
  );

  const onSubmit = useCallback(async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft('');
    await submitMessage(message, mode);
  }, [draft, busy, submitMessage, mode]);

  // A suggestion chip / plan "Do it" sends its message in EDIT mode (both want
  // real ops), switching the dock to Edit so the resulting proposal is visible.
  const runAsEdit = useCallback(
    (message: string) => {
      if (busy) return;
      setMode('edit');
      void submitMessage(message, 'edit');
    },
    [busy, submitMessage]
  );

  // Auto-send a handed-in prompt exactly once, always as an edit (the Generate
  // panel hands over a build brief). The host clears initialPrompt via
  // onInitialPromptConsumed right after, so a re-render never re-sends it. We
  // consume synchronously (before awaiting) so a slow request can't double-fire.
  const consumedPromptRef = useRef<string | null>(null);
  useEffect(() => {
    const p = initialPrompt?.trim();
    if (!p || busy) return;
    if (consumedPromptRef.current === p) return;
    consumedPromptRef.current = p;
    onInitialPromptConsumed?.();
    setMode('edit');
    void submitMessage(p, 'edit');
  }, [initialPrompt, busy, submitMessage, onInitialPromptConsumed]);

  const onReset = useCallback(() => {
    reset();
    setReplyMeta([]);
  }, [reset]);

  // ---- Dictation (mic) — Web Speech API into the composer draft ----------
  const [recording, setRecording] = useState(false);
  const recognitionRef = useRef<MinimalSpeechRecognition | null>(null);
  const speechSupported = useMemo(() => getSpeechRecognitionCtor() != null, []);

  const stopDictation = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const startDictation = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang =
      typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    // Append the best transcript to whatever is already typed.
    recognition.onresult = event => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0]?.transcript ?? '';
      }
      const text = transcript.trim();
      if (text) setDraft(text);
    };
    recognition.onend = () => {
      setRecording(false);
      recognitionRef.current = null;
    };
    recognition.onerror = () => {
      setRecording(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    setRecording(true);
    try {
      recognition.start();
    } catch {
      // start() throws if already started — treat as a no-op.
      setRecording(false);
      recognitionRef.current = null;
    }
  }, []);

  const toggleDictation = useCallback(() => {
    if (recording) stopDictation();
    else startDictation();
  }, [recording, startDictation, stopDictation]);

  // Stop any live recognition on unmount.
  useEffect(() => () => recognitionRef.current?.stop(), []);

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

  // Proactive suggestions from the live timeline (pure, client-side). Hidden
  // while a proposal is pending (the user has a decision to make first).
  const suggestions = useMemo(
    () => (pendingProposal ? [] : suggestEdits(timeline)),
    [timeline, pendingProposal]
  );

  const bubbles = useMemo(() => {
    let assistantOrdinal = -1;
    return history.map((turn, index) => {
      // Assistant turns consume reply-meta entries in order; user turns don't.
      const meta =
        turn.role === 'assistant' ? replyMeta[++assistantOrdinal] : undefined;
      return (
        <ChatBubble
          key={index}
          turn={turn}
          meta={meta}
          onRunStep={runAsEdit}
          busy={busy}
        />
      );
    });
  }, [history, replyMeta, runAsEdit, busy]);

  const composerPlaceholder = planMode
    ? 'Describe a goal — “a 30s product promo with captions and music”…'
    : 'Describe an edit…';

  return (
    <div className={styles.dock} data-testid="vdz-ai-dock">
      <div className={styles.header}>
        <span className={styles.headerDot} />
        <span className={styles.headerTitle}>AI Dock</span>

        {/* Edit | Plan mode toggle. */}
        <div
          className={styles.modeTabs}
          role="tablist"
          aria-label="AI dock mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'edit'}
            data-active={mode === 'edit'}
            className={styles.modeTab}
            onClick={() => setMode('edit')}
          >
            Edit
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'plan'}
            data-active={mode === 'plan'}
            className={styles.modeTab}
            onClick={() => setMode('plan')}
          >
            Plan
          </button>
        </div>

        <span className={styles.headerSpacer} />

        {/* Mic (dictation) — right-aligned next to Clear. */}
        {speechSupported ? (
          <button
            type="button"
            className={recording ? styles.micButtonActive : styles.micButton}
            onClick={toggleDictation}
            title={recording ? 'Stop dictation' : 'Dictate a message'}
            aria-label={recording ? 'Stop dictation' : 'Dictate a message'}
            aria-pressed={recording}
          >
            <MicIcon />
          </button>
        ) : null}

        <button
          type="button"
          className={styles.resetButton}
          onClick={onReset}
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
            <div className={styles.emptyTitle}>
              {planMode ? 'Plan your video' : 'Edit with words'}
            </div>
            {planMode
              ? 'Tell me your goal and I’ll lay out a numbered plan using ' +
                'Vdz Studio’s features — you can run each step with one click.'
              : 'Ask for a change — “cut the first 3 seconds”, “add a gold ' +
                'title LAUNCH at 2s”, or “make a 12s intro”. I’ll propose ' +
                'timeline edits you can review before they’re applied.'}
            {!planMode && suggestions.length > 0 ? (
              <SuggestionChips
                suggestions={suggestions}
                onPick={runAsEdit}
                busy={busy}
              />
            ) : null}
          </div>
        ) : (
          bubbles
        )}

        {/* In-thread proposal card (edit mode): the staged, reviewable diff. */}
        {pendingProposal ? (
          <ProposalCard
            proposal={pendingProposal}
            error={proposalError ?? null}
            onAccept={onAcceptProposal}
            onRevert={onRevertProposal}
          />
        ) : null}

        {/* Idle suggestions AFTER a conversation (edit mode, no pending card). */}
        {!planMode &&
        history.length > 0 &&
        !pendingProposal &&
        !busy &&
        suggestions.length > 0 ? (
          <SuggestionChips
            suggestions={suggestions}
            onPick={runAsEdit}
            busy={busy}
          />
        ) : null}

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
            placeholder={composerPlaceholder}
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
            {planMode ? 'Plan' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Clickable proactive-suggestion chip row. */
function SuggestionChips({
  suggestions,
  onPick,
  busy,
}: {
  suggestions: VdzSuggestion[];
  onPick: (message: string) => void;
  busy: boolean;
}) {
  return (
    <div className={styles.suggestions}>
      <div className={styles.suggestionsLabel}>Suggestions</div>
      {suggestions.map(s => (
        <button
          key={s.id}
          type="button"
          className={styles.suggestionChip}
          onClick={() => onPick(s.message)}
          disabled={busy}
          title={s.message}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

/** The staged AI proposal, rendered in-thread with Accept / Revert. */
function ProposalCard({
  proposal,
  error,
  onAccept,
  onRevert,
}: {
  proposal: { ops: VdzOp[]; summary: string };
  error: string | null;
  onAccept?: () => void;
  onRevert?: () => void;
}) {
  const count = proposal.ops.length;
  return (
    <div className={styles.proposalCard} data-testid="vdz-proposal-card">
      <div className={styles.proposalHead}>
        <span className={styles.opCountDot} />
        AI proposal
        <span className={styles.proposalCount}>
          {count} edit{count === 1 ? '' : 's'}
        </span>
      </div>
      <div className={styles.proposalSummary}>{proposal.summary}</div>
      {count > 0 ? (
        <details className={styles.proposalOps}>
          <summary className={styles.proposalOpsSummary}>
            Preview {count} op{count === 1 ? '' : 's'}
          </summary>
          <ul className={styles.proposalOpList}>
            {proposal.ops.map((op, i) => (
              <li key={i} className={styles.proposalOpItem}>
                <span className={styles.proposalOpKind}>{op.op}</span>
                <span className={styles.proposalOpDetail}>
                  {describeOp(op)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {error ? <div className={styles.proposalError}>{error}</div> : null}
      <div className={styles.proposalActions}>
        <button
          type="button"
          className={styles.proposalRevert}
          onClick={onRevert}
        >
          Revert
        </button>
        <button
          type="button"
          className={styles.proposalAccept}
          onClick={onAccept}
        >
          Accept {count} edit{count === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}

/** A single chat bubble (user or assistant), incl. plan cards + op counts. */
function ChatBubble({
  turn,
  meta,
  onRunStep,
  busy,
}: {
  turn: VdzChatTurn;
  meta: AiReplyMeta | undefined;
  onRunStep: (message: string) => void;
  busy: boolean;
}) {
  if (turn.role === 'user') {
    return <div className={styles.userBubble}>{turn.content}</div>;
  }

  // A plan-mode reply renders as a checklist card instead of a plain bubble.
  if (meta?.plan && meta.plan.length > 0) {
    return (
      <PlanCard summary={turn.content} plan={meta.plan} onRunStep={onRunStep} busy={busy} />
    );
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

/** A Plan-mode checklist: numbered steps, each runnable as an edit. */
function PlanCard({
  summary,
  plan,
  onRunStep,
  busy,
}: {
  summary: string;
  plan: VdzPlanStep[];
  onRunStep: (message: string) => void;
  busy: boolean;
}) {
  return (
    <div className={styles.planCard} data-testid="vdz-plan-card">
      <div className={styles.planHead}>
        <span className={styles.opCountDot} />
        Plan · {plan.length} step{plan.length === 1 ? '' : 's'}
      </div>
      <div className={styles.proposalSummary}>{summary}</div>
      <ol className={styles.planList}>
        {plan.map((step, i) => (
          <li key={i} className={styles.planItem}>
            <span className={styles.planStepNum}>{i + 1}</span>
            <div className={styles.planStepBody}>
              <div className={styles.planStepTitle}>{step.step}</div>
              {step.action && step.action !== step.step ? (
                <div className={styles.planStepAction}>{step.action}</div>
              ) : null}
              <button
                type="button"
                className={styles.planDoButton}
                onClick={() => onRunStep(step.action || step.step)}
                disabled={busy}
              >
                Do it
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * A compact, human-readable one-liner describing an op for the proposal
 * preview list. Best-effort — falls back to the op name for exotic shapes.
 */
function describeOp(op: VdzOp): string {
  switch (op.op) {
    case 'addClip': {
      const c = op.clip;
      const label = c.name ? `“${c.name}”` : c.type;
      return `${label} → ${op.trackId}`;
    }
    case 'removeClip':
      return `${op.clipId} from ${op.trackId}`;
    case 'rippleDelete':
      return `${op.clipId} (close gap)`;
    case 'moveClip':
      return `${op.clipId} → start ${op.start}s${op.toTrackId ? ` on ${op.toTrackId}` : ''}`;
    case 'trimClip':
      return `${op.clipId}${op.duration != null ? ` · dur ${op.duration}s` : ''}${op.trimStart != null ? ` · trim ${op.trimStart}s` : ''}`;
    case 'splitClip':
      return `${op.clipId} at ${op.atSeconds}s`;
    case 'nudgeClip':
      return `${op.clipId} by ${op.deltaSeconds}s`;
    case 'setText':
      return `${op.clipId}: “${op.text}”`;
    case 'applyTransition':
      return `${op.transition.kind} after ${op.transition.afterClipId}`;
    case 'removeTransition':
      return `${op.transitionId}`;
    case 'setAnimation':
      return op.animation ? `${op.clipId} motion` : `${op.clipId} (clear motion)`;
    case 'setEffects':
      return `${op.clipId}: ${op.effects.length} effect${op.effects.length === 1 ? '' : 's'}`;
    case 'updateClip':
      return `${op.clipId}: ${Object.keys(op.patch).join(', ')}`;
    case 'renameTimeline':
      return `“${op.name}”`;
    case 'addTrack':
      return `${op.track.kind} track ${op.track.id}`;
    default:
      return '';
  }
}

/** Crisp SVG mic glyph for the dictation button (matches the voice guide). */
function MicIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3.5" />
    </svg>
  );
}
