import { suggestEdits, type VdzSuggestion } from '@affine/core/modules/vdz';
import {
  useVdzAi,
  type VdzChatMode,
  type VdzChatResponse,
  type VdzChatTurn,
  type VdzPlanStep,
} from '@affine/core/modules/vdz/use-vdz-ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type VdzOp,
  vdzOpSchema,
  type VdzTimeline,
} from '../../../../modules/vdz';
import {
  formatTimecodeFrames,
  playheadFrame,
} from '../../../../modules/vdz/serialize-timeline';
import { useAiPulse } from '../../../../modules/vdz/use-ai-pulse';
import * as styles from './ai-dock.css';
import { AiPulseTicker } from './ai-pulse-ticker';

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
   * The live playhead position in seconds. Sent to the AI (so it can compute
   * "at the playhead" edits) and shown in the context strip as a timecode +
   * frame so the user sees exactly what the AI sees. Optional — omitted simply
   * hides the playhead readout and drops playhead-relative context.
   */
  playheadSeconds?: number;
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
  /**
   * Human-readable reasons the schema rejected an op this turn (one per invalid
   * op, in order). Surfaced under the op-count so a model mistake is legible
   * rather than a bare "N skipped (invalid)". Capped to keep the bubble compact.
   */
  invalidReasons?: string[];
  /** A plan checklist when this turn was a plan-mode reply. */
  plan?: VdzPlanStep[];
  /** First-2k raw text when the model returned an unparseable response. */
  raw?: string;
}

/** Cap on how many per-op invalid reasons we keep/show for one reply. */
const MAX_INVALID_REASONS = 6;

/**
 * Turn a Zod parse error for a single op into a short, legible reason. Prefers
 * the first issue's path + message (e.g. `atSeconds: Expected number`) and falls
 * back to the raw message. Kept defensive — never throws.
 */
function describeInvalidOp(candidate: unknown, message: string): string {
  const opName =
    candidate && typeof candidate === 'object' && candidate !== null
      ? (candidate as { op?: unknown }).op
      : undefined;
  const label = typeof opName === 'string' && opName ? opName : 'op';
  const reason = message.trim().split('\n')[0] || 'invalid op';
  return `${label}: ${reason}`;
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
  playheadSeconds,
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
  // Reasoning-pulse ticker: while a send is in flight it streams request-tailored
  // "thinking" lines in place of a bare spinner (see WIRING-PULSE.md). Purely
  // cosmetic — started on send, always stopped in a finally.
  const pulse = useAiPulse();
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

      // Kick off the reasoning animation for this turn (Edit and Plan alike):
      // a short task line = the first ~100 chars of the request tagged with the
      // mode, on the 'video' surface (the dock frames edits as video work).
      // Always stopped in the finally so an error/abort still clears it.
      const task = `${message.slice(0, 100)} (${turnMode} mode)`;
      pulse.start(task, 'video');
      let result: VdzChatResponse | null;
      try {
        // Forward the LIVE playhead so the AI can resolve "at the playhead"
        // edits. The sole-selected clip is derived inside send() from
        // selectedClipIds, so we only need to add the playhead here.
        result = await send(message, timeline, selectedClipIds, turnMode, {
          playheadSec: playheadSeconds,
        });
      } finally {
        pulse.stop();
      }
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
      // applies with, then stage the valid ones. Capture a short reason per
      // rejected op so the reply can show WHY the model's op was skipped.
      const valid: VdzOp[] = [];
      let invalid = 0;
      const invalidReasons: string[] = [];
      for (const candidate of result.ops) {
        const parsed = vdzOpSchema.safeParse(candidate);
        if (parsed.success) {
          valid.push(parsed.data);
        } else {
          invalid += 1;
          if (invalidReasons.length < MAX_INVALID_REASONS) {
            invalidReasons.push(
              describeInvalidOp(candidate, parsed.error.message)
            );
          }
        }
      }

      setReplyMeta(prev => [
        ...prev,
        {
          validCount: valid.length,
          invalidCount: invalid,
          ops: valid.length > 0 ? valid : undefined,
          invalidReasons: invalidReasons.length > 0 ? invalidReasons : undefined,
          raw: result.raw,
        },
      ]);

      if (valid.length > 0) onApplyOps(valid, result.summary);
    },
    [busy, send, timeline, selectedClipIds, playheadSeconds, onApplyOps, pulse]
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

  // The sole-selected clip id (only when exactly one clip is selected) — the
  // unambiguous target for "this"/"the selected clip" both in suggestions and
  // in the context strip's selected-clip chip.
  const soleSelectedId = useMemo(
    () => (selectedClipIds?.length === 1 ? selectedClipIds[0] : undefined),
    [selectedClipIds]
  );

  // Proactive suggestions from the live timeline (pure, client-side). Hidden
  // while a proposal is pending (the user has a decision to make first). Passed
  // the live playhead + selection so context-aware rules (split at the
  // playhead, fade the selected clip) can fire.
  const suggestions = useMemo(
    () =>
      pendingProposal
        ? []
        : suggestEdits(timeline, {
            playheadSeconds,
            selectedClipId: soleSelectedId,
          }),
    [timeline, pendingProposal, playheadSeconds, soleSelectedId]
  );

  // Compact, at-a-glance summary of the timeline the AI is looking at — shown as
  // a one-line strip above the suggestion chips so the user can see the context
  // the dock is reasoning over (aspect ratio, track/clip counts, captions, plus
  // the live playhead timecode/frame and the selected clip).
  const contextInfo = useMemo(
    () => summarizeContext(timeline, playheadSeconds, soleSelectedId),
    [timeline, playheadSeconds, soleSelectedId]
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
              <>
                <ContextStrip info={contextInfo} />
                <SuggestionChips
                  suggestions={suggestions}
                  onPick={runAsEdit}
                  busy={busy}
                />
              </>
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
          <>
            <ContextStrip info={contextInfo} />
            <SuggestionChips
              suggestions={suggestions}
              onPick={runAsEdit}
              busy={busy}
            />
          </>
        ) : null}

        {/* Busy indicator: the reasoning-pulse ticker streams request-tailored
            "thinking" lines. If a pulse line isn't ready yet (it starts in the
            same tick, so this is only a defensive edge), fall back to a plain
            typing row so the busy region is never empty. */}
        {busy ? (
          pulse.active && pulse.currentLine ? (
            <AiPulseTicker
              line={pulse.currentLine}
              active={pulse.active}
              done={pulse.done}
            />
          ) : (
            <div className={styles.typing}>Thinking…</div>
          )
        ) : null}
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
          <span aria-hidden="true" style={{ fontSize: 12, lineHeight: 1 }}>
            {suggestionGlyph(s.id)}
          </span>
          {s.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A small leading glyph per suggestion, keyed off its stable id, so the chip
 * row reads as grouped/typed at a glance (canvas, text, audio, transition, …)
 * instead of a flat list of identical pills. Purely decorative — falls back to
 * a neutral spark for any unmapped id, so a new suggestion still renders fine.
 */
function suggestionGlyph(id: string): string {
  switch (id) {
    case 'build-intro':
      return '🎬';
    case 'reformat-vertical':
      return '📱';
    case 'add-title':
    case 'long-needs-title':
      return '🔤';
    case 'style-captions':
      return '💬';
    case 'add-audio':
      return '🎙️';
    case 'duck-music':
      return '🎚️';
    case 'add-transition':
      return '🔀';
    case 'close-gap':
      return '✂️';
    case 'cinematic-look':
      return '🎞️';
    case 'add-outro':
      return '🏁';
    case 'add-motion':
      return '✨';
    default:
      return '✦';
  }
}

/** The at-a-glance timeline summary rendered in {@link ContextStrip}. */
interface VdzContextInfo {
  /** Friendly aspect-ratio label, e.g. "16:9" / "9:16" / "1:1". */
  ratio: string;
  /** Number of tracks in the timeline. */
  trackCount: number;
  /** Total number of clips across all tracks. */
  clipCount: number;
  /** True when at least one text/caption clip exists. */
  hasCaptions: boolean;
  /**
   * The live playhead readout — timecode ("mm:ss.ff") + absolute frame — the
   * SAME values the AI is sent. Present only when a playhead was supplied.
   */
  playhead?: { timecode: string; frame: number };
  /** The sole-selected clip's short label + kind, for the selected-clip chip. */
  selected?: { label: string; kind: string };
}

/**
 * A compact one-line context strip — e.g. "16:9 · 3 tracks · 12 clips ·
 * captions ✓ · ⏱ 00:02.15 f75" — shown just above the suggestion chips so the
 * user can see the timeline the AI is reasoning over, INCLUDING the live
 * playhead (timecode + frame, the same values the AI receives) and a chip for
 * the selected clip. Read-only. The base metrics stay inline-styled (as
 * before); the playhead readout + selected chip use theme-aware classes from
 * ai-dock.css.ts.
 */
function ContextStrip({ info }: { info: VdzContextInfo }) {
  const dim = 'var(--affine-text-secondary-color, #8a8f98)';
  const item: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    whiteSpace: 'nowrap',
  };
  const sep = (
    <span aria-hidden="true" style={{ opacity: 0.5 }}>
      ·
    </span>
  );
  return (
    <div
      data-testid="vdz-context-strip"
      style={{
        width: '100%',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 8,
        marginTop: 10,
        fontSize: 11,
        fontWeight: 600,
        color: dim,
      }}
    >
      <span style={item}>
        <span aria-hidden="true">🖼️</span>
        {info.ratio}
      </span>
      {sep}
      <span style={item}>
        {info.trackCount} track{info.trackCount === 1 ? '' : 's'}
      </span>
      {sep}
      <span style={item}>
        {info.clipCount} clip{info.clipCount === 1 ? '' : 's'}
      </span>
      {sep}
      <span style={item}>
        captions {info.hasCaptions ? '✓' : '—'}
      </span>
      {info.playhead ? (
        <>
          {sep}
          <span
            className={styles.ctxPlayhead}
            data-testid="vdz-context-playhead"
            title={`Playhead — timecode ${info.playhead.timecode}, frame ${info.playhead.frame}`}
          >
            <span aria-hidden="true">⏱</span>
            {info.playhead.timecode}
            <span className={styles.ctxPlayheadFrame}>
              f{info.playhead.frame}
            </span>
          </span>
        </>
      ) : null}
      {info.selected ? (
        <>
          {sep}
          <span
            className={styles.ctxSelectedChip}
            data-testid="vdz-context-selected"
            title={`Selected ${info.selected.kind} clip: ${info.selected.label}`}
          >
            <span aria-hidden="true">{clipKindGlyph(info.selected.kind)}</span>
            <span className={styles.ctxSelectedLabel}>
              {info.selected.label}
            </span>
          </span>
        </>
      ) : null}
    </div>
  );
}

/**
 * Derive the {@link VdzContextInfo} for the strip from a live timeline plus the
 * live playhead / sole-selected clip. Pure and defensive — reads through
 * optional fields and never assumes a track/clip exists, mirroring
 * {@link suggestEdits}. Not exported (dock-local UI helper).
 */
function summarizeContext(
  timeline: VdzTimeline,
  playheadSeconds?: number,
  selectedClipId?: string
): VdzContextInfo {
  const tracks = Array.isArray(timeline?.tracks) ? timeline.tracks : [];
  let clipCount = 0;
  let hasCaptions = false;
  let selected: { label: string; kind: string } | undefined;
  for (const t of tracks) {
    const clips = Array.isArray(t?.clips) ? t.clips : [];
    clipCount += clips.length;
    if (clips.some(c => c?.type === 'text')) hasCaptions = true;
    if (selectedClipId && !selected) {
      const hit = clips.find(c => c?.id === selectedClipId) as
        | Record<string, unknown>
        | undefined;
      if (hit) {
        const kind = typeof hit.type === 'string' ? hit.type : 'clip';
        const rawLabel =
          (typeof hit.name === 'string' && hit.name.trim()) ||
          (kind === 'text' &&
            typeof hit.text === 'string' &&
            hit.text.trim()) ||
          (kind === 'shape' && typeof hit.shape === 'string' && hit.shape) ||
          kind;
        selected = { label: truncate(String(rawLabel), 24), kind };
      }
    }
  }
  const width = typeof timeline?.width === 'number' ? timeline.width : 1920;
  const height = typeof timeline?.height === 'number' ? timeline.height : 1080;
  const fps = typeof timeline?.fps === 'number' && timeline.fps > 0 ? timeline.fps : 30;

  const info: VdzContextInfo = {
    ratio: aspectRatioLabel(width, height),
    trackCount: tracks.length,
    clipCount,
    hasCaptions,
    selected,
  };
  if (typeof playheadSeconds === 'number' && Number.isFinite(playheadSeconds)) {
    // Reuse the serializer's exact timecode/frame math so the strip shows the
    // SAME values that go to the AI.
    info.playhead = {
      timecode: formatTimecodeFrames(playheadSeconds, fps),
      frame: playheadFrame(playheadSeconds, fps),
    };
  }
  return info;
}

/** Truncate a string to `max` chars with a trailing ellipsis when cut. */
function truncate(value: string, max: number): string {
  const s = value.trim();
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * A small kind icon for the selected-clip chip, matching the emoji vocabulary
 * used elsewhere in the dock. Falls back to a neutral clip glyph.
 */
function clipKindGlyph(kind: string): string {
  switch (kind) {
    case 'video':
      return '🎞️';
    case 'audio':
      return '🎵';
    case 'image':
      return '🖼️';
    case 'text':
      return '🔤';
    case 'shape':
      return '⬛';
    default:
      return '▪️';
  }
}

/**
 * A friendly aspect-ratio label for a canvas size. Maps the common social /
 * editorial ratios to their conventional names (16:9, 9:16, 1:1, 4:5, 21:9)
 * within a small tolerance; otherwise reduces w:h by their GCD (e.g. "5:3").
 * Falls back to "16:9" for a degenerate (zero) size.
 */
function aspectRatioLabel(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return '16:9';
  const known: [number, number, string][] = [
    [16, 9, '16:9'],
    [9, 16, '9:16'],
    [1, 1, '1:1'],
    [4, 5, '4:5'],
    [21, 9, '21:9'],
    [4, 3, '4:3'],
    [3, 4, '3:4'],
  ];
  const ratio = width / height;
  for (const [w, h, label] of known) {
    if (Math.abs(ratio - w / h) <= 0.03) return label;
  }
  const gcd = (a: number, b: number): number =>
    b === 0 ? a : gcd(b, a % b);
  const g = gcd(Math.round(width), Math.round(height)) || 1;
  return `${Math.round(width) / g}:${Math.round(height) / g}`;
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
      {/* Per-op reasons for the skipped (schema-invalid) ops, so a model
          mistake is legible instead of an opaque "N skipped". */}
      {meta && meta.invalidReasons && meta.invalidReasons.length > 0 ? (
        <details className={styles.rawDetails}>
          <summary className={styles.rawSummary}>
            Why {meta.invalidCount} op{meta.invalidCount === 1 ? '' : 's'}{' '}
            skipped
          </summary>
          <ul className={styles.invalidReasonList}>
            {meta.invalidReasons.map((reason, i) => (
              <li key={i} className={styles.invalidReasonItem}>
                {reason}
              </li>
            ))}
          </ul>
        </details>
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
