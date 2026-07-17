import type { CSSProperties } from 'react';
import { memo, useCallback, useMemo, useState } from 'react';

import type { VdzOp, VdzTimeline } from '../../../../modules/vdz';
import {
  collectTranscriptLines,
  type VdzTranscriptLine,
} from './captions';
import { formatTimecode } from './constants';
import * as styles from './index.css';
import * as tcs from './transcript.css';
import { VdzPanel } from './vdz-panel';

/**
 * Transcript panel — the Descript-style view of the timeline's spoken layer.
 *
 * Every text clip on the overlay lanes appears as one line, in time order
 * (captions from Whisper and hand-made titles alike). The panel is a THIN
 * projection over the same document everything else edits:
 *   · click a line        → seek the playhead there + select the clip
 *   · edit a line's text  → ONE `setText` op on blur/Enter (undoable)
 *   · delete a line (✕)   → ONE `removeClip` op
 * No state of its own beyond input drafts — the timeline is the truth, so
 * lane edits, AI ops and undo all reflect here instantly.
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
   * `onOp` calls (still correct, just one undo entry per caption).
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

  return (
    <VdzPanel
      title="Transcript"
      data-testid="vdz-transcript"
      onCollapse={onCollapse}
      accessory={
        lines.length > 0 ? (
          <span className={tcs.countBadge}>{lines.length}</span>
        ) : undefined
      }
      bodyClassName={styles.inspectorBody}
    >
      {lines.length === 0 ? (
        <div className={tcs.emptyHint}>
          No captions or overlay text yet. Select an audio clip and use{' '}
          <b>Captions → Generate captions</b> in the Inspector — every phrase
          lands here, editable and clickable.
        </div>
      ) : (
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
      )}
    </VdzPanel>
  );
}
