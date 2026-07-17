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
  onCollapse: () => void;
}

export function TranscriptPanel({
  timeline,
  playheadSeconds,
  selectedIds,
  onSeek,
  onSelectClip,
  onOp,
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
      )}
    </VdzPanel>
  );
}
