import { formatTimecode } from './constants';
import * as styles from './index.css';

interface ToolbarProps {
  /** Whether the media bin panel is open (drives the toggle button state). */
  showMedia: boolean;
  /** Toggle the left-side media bin panel. */
  onToggleMedia: () => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  playheadSeconds: number;
  duration: number;
  pxPerSec: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  canSplit: boolean;
  onSplit: () => void;
  canDelete: boolean;
  onDelete: () => void;
  onRippleDelete: () => void;
  canUndo: boolean;
  onUndo: () => void;
  canRedo: boolean;
  onRedo: () => void;
  selectionCount: number;
}

/** Editor action bar. Sits ABOVE the lanes (never in the AI-dock footer). */
export function Toolbar({
  showMedia,
  onToggleMedia,
  isPlaying,
  onTogglePlay,
  playheadSeconds,
  duration,
  pxPerSec,
  onZoomOut,
  onZoomIn,
  canSplit,
  onSplit,
  canDelete,
  onDelete,
  onRippleDelete,
  canUndo,
  onUndo,
  canRedo,
  onRedo,
  selectionCount,
}: ToolbarProps) {
  return (
    <div className={styles.toolbar}>
      <button
        type="button"
        className={styles.toolButton}
        onClick={onToggleMedia}
        aria-pressed={showMedia}
        title="Toggle the media bin (upload / AI images / stock)"
      >
        {showMedia ? '◧ Media' : '▤ Media'}
      </button>

      <span className={styles.toolDivider} />

      <button
        type="button"
        className={styles.toolButton}
        onClick={onTogglePlay}
        title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
      >
        {isPlaying ? '⏸ Pause' : '▶ Play'}
      </button>

      <span className={styles.toolTimecode}>
        {formatTimecode(playheadSeconds)} / {formatTimecode(duration)}
      </span>

      <span className={styles.toolDivider} />

      <button
        type="button"
        className={styles.toolButton}
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo (Ctrl/Cmd+Z)"
      >
        ↺ Undo
      </button>
      <button
        type="button"
        className={styles.toolButton}
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo (Ctrl/Cmd+Shift+Z)"
      >
        ↻ Redo
      </button>

      <span className={styles.toolDivider} />

      <button
        type="button"
        className={styles.toolButton}
        onClick={onSplit}
        disabled={!canSplit}
        title="Split selected clip at playhead (S)"
      >
        ⋔ Split
      </button>
      <button
        type="button"
        className={styles.toolButton}
        onClick={onDelete}
        disabled={!canDelete}
        title="Delete selected (Delete)"
      >
        🗑 Delete
      </button>
      <button
        type="button"
        className={styles.toolButton}
        onClick={onRippleDelete}
        disabled={!canDelete}
        title="Ripple delete — close the gap (Shift+Delete)"
      >
        ⇤ Ripple
      </button>

      <span className={styles.toolSpacer} />

      {selectionCount > 1 ? (
        <span className={styles.toolBadge}>{selectionCount} selected</span>
      ) : null}

      <span className={styles.toolDivider} />

      <button
        type="button"
        className={styles.toolButton}
        onClick={onZoomOut}
        title="Zoom out"
      >
        −
      </button>
      <span className={styles.toolZoomLabel}>{Math.round(pxPerSec)} px/s</span>
      <button
        type="button"
        className={styles.toolButton}
        onClick={onZoomIn}
        title="Zoom in"
      >
        +
      </button>
    </div>
  );
}
