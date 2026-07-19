import type { CSSProperties } from 'react';
import { memo, useCallback, useMemo, useState } from 'react';

import type { VdzOp, VdzTimeline } from '../../../../modules/vdz';
import type { VdzTranscribableClip } from '../../../../modules/vdz/use-vdz-transcript';
import { isTranscribableClip } from '../../../../modules/vdz/use-vdz-transcript';
import {
  collectTranscriptLines,
  type VdzTranscriptLine,
} from './captions';
import { findClip, formatTimecode } from './constants';
import * as styles from './index.css';
import { TranscriptEdit } from './transcript-edit';
import * as tcs from './transcript.css';
import { VdzPanel } from './vdz-panel';

/**
 * Transcript panel — the Descript-style view of the timeline's spoken layer.
 *
 * TWO modes, side by side:
 *
 *  1. Clip transcript (new) — when a single VIDEO/AUDIO clip is selected, a
 *     "Transcribe" action turns its speech into editable sentences; deleting a
 *     sentence (or a picked word-span) CUTS the underlying clip on the timeline
 *     (splitClip → splitClip → rippleDelete, one undo). Lives in
 *     {@link TranscriptEdit}; the transcript itself is a project-scoped
 *     side-store (never a schema change).
 *
 *  2. Captions / overlay text (unchanged) — every text clip on the overlay
 *     lanes appears as one line, in time order (captions from Whisper and
 *     hand-made titles alike). The panel is a THIN projection over the same
 *     document everything else edits:
 *       · click a line        → seek the playhead there + select the clip
 *       · edit a line's text  → ONE `setText` op on blur/Enter (undoable)
 *       · delete a line (✕)   → ONE `removeClip` op
 *     No state of its own beyond input drafts — the timeline is the truth, so
 *     lane edits, AI ops and undo all reflect here instantly. The "Caption
 *     style" bar (WS7 Apply-to-all) restyles every caption at once.
 *
 * The two modes are additive: selecting a video/audio clip shows the clip
 * transcript ABOVE the (still fully-functional) caption list.
 */

/**
 * Caption presets/positions, mirroring the shared schema enums
 * (`vdzTextClipSchema.capPreset` / `capPosition`). Kept as local label maps so
 * the picker reads friendly ("Boxed", "Lower") while emitting the exact literal
 * values the `setClipStyle` op validates against.
 */
const CAP_PRESETS = [
  { value: 'plain', label: 'Plain' },
  { value: 'boxed', label: 'Boxed' },
  { value: 'outline', label: 'Outline' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'pill', label: 'Pill' },
  // Applying karaoke to all captions is harmless: clips that already carry
  // per-word `words` highlight word-by-word; clips without them (hand titles,
  // or captions generated before word timestamps) render as the boxed look.
  { value: 'karaoke', label: 'Karaoke' },
] as const;
type CapPreset = (typeof CAP_PRESETS)[number]['value'];

const CAP_POSITIONS = [
  { value: 'top', label: 'Top' },
  { value: 'middle', label: 'Middle' },
  { value: 'lower', label: 'Lower' },
] as const;
type CapPosition = (typeof CAP_POSITIONS)[number]['value'];

interface TranscriptRowProps {
  line: VdzTranscriptLine;
  active: boolean;
  selected: boolean;
  onJump: (line: VdzTranscriptLine) => void;
  onCommitText: (line: VdzTranscriptLine, text: string) => void;
  onDelete: (line: VdzTranscriptLine) => void;
}

/** One transcript line; local text draft commits on blur/Enter if changed. */
const TranscriptRow = memo(function TranscriptRow({
  line,
  active,
  selected,
  onJump,
  onCommitText,
  onDelete,
}: TranscriptRowProps) {
  const [draft, setDraft] = useState(line.text);

  const commit = useCallback(() => {
    const next = draft.trim();
    if (next.length === 0) {
      // An emptied line reverts (delete is the explicit ✕ action).
      setDraft(line.text);
      return;
    }
    if (next !== line.text) onCommitText(line, next);
  }, [draft, line, onCommitText]);

  return (
    <div
      className={tcs.row}
      data-active={active}
      data-selected={selected}
      onClick={() => onJump(line)}
    >
      <span className={tcs.timeChip}>{formatTimecode(line.start)}</span>
      <input
        className={tcs.textInput}
        value={draft}
        aria-label="Caption text"
        onChange={e => setDraft(e.target.value)}
        onClick={e => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <button
        type="button"
        className={tcs.delBtn}
        title="Delete this caption"
        aria-label="Delete this caption"
        onClick={e => {
          e.stopPropagation();
          onDelete(line);
        }}
      >
        ✕
      </button>
    </div>
  );
});

/**
 * Compact "Caption style" bar: pick a preset + position and restyle EVERY
 * caption/overlay-text line at once. Emits one
 * `{ op:'setClipStyle', trackId, clipId, capPreset, capPosition }` per line
 * (the exact caption clips {@link collectTranscriptLines} surfaces), preferring
 * the batch `onOps` path so the whole restyle is a single undo entry — falling
 * back to sequential `onOp` when the host doesn't expose a batch commit.
 */
const CaptionStyleBar = memo(function CaptionStyleBar({
  lines,
  onOp,
  onOps,
}: {
  lines: readonly VdzTranscriptLine[];
  onOp: (op: VdzOp) => void;
  onOps?: (ops: VdzOp[]) => void;
}) {
  const [preset, setPreset] = useState<CapPreset>('boxed');
  const [position, setPosition] = useState<CapPosition>('lower');

  const disabled = lines.length === 0;

  const applyToAll = useCallback(() => {
    if (lines.length === 0) return;
    const ops: VdzOp[] = lines.map(line => ({
      op: 'setClipStyle',
      trackId: line.trackId,
      clipId: line.clipId,
      capPreset: preset,
      capPosition: position,
    }));
    // One history entry when the host offers a batch path; else sequential
    // single-op commits (mirrors the Inspector's `onOps` convention).
    if (onOps) onOps(ops);
    else for (const op of ops) onOp(op);
  }, [lines, preset, position, onOp, onOps]);

  const selectStyle: CSSProperties = {
    flex: '1 1 0',
    minWidth: 0,
    appearance: 'none',
    borderRadius: 6,
    border: '1px solid var(--vdz-border)',
    background: 'var(--vdz-bg)',
    color: 'var(--vdz-text)',
    fontSize: 11,
    padding: '3px 6px',
    cursor: disabled ? 'default' : 'pointer',
  };

  return (
    <div
      className={tcs.styleBar}
      data-testid="vdz-caption-style"
      aria-label="Caption style"
    >
      <label className={tcs.styleBarLabel}>
        <span className={tcs.styleBarLabelText}>Preset</span>
        <select
          style={selectStyle}
          value={preset}
          disabled={disabled}
          aria-label="Caption preset"
          onChange={e => setPreset(e.target.value as CapPreset)}
        >
          {CAP_PRESETS.map(p => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className={tcs.styleBarLabel}>
        <span className={tcs.styleBarLabelText}>Position</span>
        <select
          style={selectStyle}
          value={position}
          disabled={disabled}
          aria-label="Caption position"
          onChange={e => setPosition(e.target.value as CapPosition)}
        >
          {CAP_POSITIONS.map(p => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className={tcs.styleBarApply}
        onClick={applyToAll}
        disabled={disabled}
        title={
          disabled
            ? 'No captions to style yet'
            : 'Apply this preset + position to every caption'
        }
      >
        Apply to all captions
      </button>
    </div>
  );
});

export interface TranscriptPanelProps {
  timeline: VdzTimeline;
  playheadSeconds: number;
  selectedIds: ReadonlySet<string>;
  /** Seek the playhead (line click). */
  onSeek: (seconds: number) => void;
  /** Select the clicked line's clip. */
  onSelectClip: (clipId: string) => void;
  /** Emit one op through the host history path (setText / removeClip). */
  onOp: (op: VdzOp) => void;
  /**
   * Emit a batch of ops as ONE history entry (same path the Inspector uses).
   * Optional: when absent, "Apply to all captions" falls back to sequential
   * `onOp` calls (still correct, just one undo entry per caption), and the
   * clip-transcript cut falls back the same way (a cut is normally ONE undo via
   * this path — the real editor always provides it).
   */
  onOps?: (ops: VdzOp[]) => void;
  onCollapse: () => void;
}

export function TranscriptPanel({
  timeline,
  playheadSeconds,
  selectedIds,
  onSeek,
  onSelectClip,
  onOp,
  onOps,
  onCollapse,
}: TranscriptPanelProps) {
  const lines = useMemo(() => collectTranscriptLines(timeline), [timeline]);

  // The clip-transcript mode targets exactly ONE selected video/audio clip.
  // Resolve it (and its track) from the live timeline; anything else (0 or >1
  // selected, or a text/image/shape clip) leaves the panel in caption-only mode.
  const clipTarget = useMemo((): {
    clip: VdzTranscribableClip;
    trackId: string;
  } | null => {
    if (selectedIds.size !== 1) return null;
    const [id] = [...selectedIds];
    const found = findClip(timeline, id);
    if (!found || !isTranscribableClip(found.clip)) return null;
    return { clip: found.clip, trackId: found.trackId };
  }, [selectedIds, timeline]);

  // Batch commit for the clip-transcript cut: prefer the host's single-undo
  // `onOps` (runBatch). Fall back to sequential `onOp` only when a host didn't
  // wire runBatch — `applyOps` stops at the first failure, so the end state
  // stays consistent; it just records one undo per op. The real editor always
  // passes onOps, so this branch is purely defensive.
  const commitCutOps = useCallback(
    (ops: VdzOp[]): boolean => {
      if (ops.length === 0) return false;
      if (onOps) {
        onOps(ops);
        return true;
      }
      for (const op of ops) onOp(op);
      return true;
    },
    [onOps, onOp]
  );

  const onJump = useCallback(
    (line: VdzTranscriptLine) => {
      onSeek(line.start);
      onSelectClip(line.clipId);
    },
    [onSeek, onSelectClip]
  );

  const onCommitText = useCallback(
    (line: VdzTranscriptLine, text: string) => {
      onOp({ op: 'setText', trackId: line.trackId, clipId: line.clipId, text });
    },
    [onOp]
  );

  const onDelete = useCallback(
    (line: VdzTranscriptLine) => {
      onOp({ op: 'removeClip', trackId: line.trackId, clipId: line.clipId });
    },
    [onOp]
  );

  const hasClipMode = clipTarget !== null;
  const hasCaptions = lines.length > 0;

  return (
    <VdzPanel
      title="Transcript"
      data-testid="vdz-transcript"
      onCollapse={onCollapse}
      accessory={
        hasCaptions ? (
          <span className={tcs.countBadge}>{lines.length}</span>
        ) : undefined
      }
      bodyClassName={styles.inspectorBody}
    >
      {/* Mode 1 — clip transcript (a video/audio clip is selected). */}
      {clipTarget ? (
        <TranscriptEdit
          // Re-mount the editor when the selected clip changes so its local
          // selection/state resets cleanly to the new clip.
          key={clipTarget.clip.id}
          clip={clipTarget.clip}
          trackId={clipTarget.trackId}
          timeline={timeline}
          playheadSeconds={playheadSeconds}
          onSeek={onSeek}
          onOps={commitCutOps}
        />
      ) : null}

      {/* A divider only when BOTH modes are on screen at once. */}
      {hasClipMode && hasCaptions ? (
        <div className={tcs.modeDivider}>Captions &amp; overlay text</div>
      ) : null}

      {/* Mode 2 — captions / overlay text (unchanged WS7 behavior). */}
      {hasCaptions ? (
        <>
          <CaptionStyleBar lines={lines} onOp={onOp} onOps={onOps} />
          <div className={tcs.list}>
            {lines.map(line => (
              <TranscriptRow
                // Keyed by clip id + committed text so an external edit (undo,
                // AI op, lane change) refreshes the row's local draft.
                key={`${line.clipId}:${line.text}`}
                line={line}
                active={
                  playheadSeconds >= line.start &&
                  playheadSeconds < line.start + line.duration
                }
                selected={selectedIds.has(line.clipId)}
                onJump={onJump}
                onCommitText={onCommitText}
                onDelete={onDelete}
              />
            ))}
          </div>
        </>
      ) : hasClipMode ? null : (
        // Neither mode: the original empty hint (also nudges the clip mode).
        <div className={tcs.emptyHint}>
          Select a <b>video or audio clip</b> to transcribe it and edit by
          sentence — deleting a sentence cuts the clip. Captions and overlay
          text appear here too: generate them from an audio clip via{' '}
          <b>Captions → Generate captions</b> in the Inspector.
        </div>
      )}
    </VdzPanel>
  );
}
