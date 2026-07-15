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
  /** Hide the timeline panel (collapse × at the end of the toolbar). */
  onCollapse?: () => void;
  // ---- MP4 export (compile timeline → cdz-render kind:'html') -------------
  /** Kick off an MP4 export of the current timeline. */
  onExport?: () => void;
  /** True while compiling/inlining or while the render is in flight. */
  exportBusy?: boolean;
  /** 0..1 render progress (meaningful while rendering). */
  exportProgress?: number;
  /** A ready-to-download MP4 URL once the render is done, else null. */
  exportFileUrl?: string | null;
  /** True when the render service is not configured on this deployment. */
  exportUnavailable?: boolean;
  /** A short human status/error line for the export, or null. */
  exportNote?: string | null;
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
  onCollapse,
  onExport,
  exportBusy,
  exportProgress,
  exportFileUrl,
  exportUnavailable,
  exportNote,
}: ToolbarProps) {
  const exportPct = Math.round((exportProgress ?? 0) * 100);
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

      {onExport ? (
        <>
          <span className={styles.toolDivider} />
          {exportFileUrl ? (
            <a
              className={styles.toolButton}
              href={exportFileUrl}
              download
              title="Download the rendered MP4"
            >
              ⬇ MP4
            </a>
          ) : (
            <button
              type="button"
              className={styles.toolButton}
              onClick={onExport}
              disabled={exportBusy || exportUnavailable}
              title={
                exportUnavailable
                  ? 'Render service coming online soon'
                  : 'Compile this timeline and render it to an MP4'
              }
            >
              {exportBusy ? `⤓ Exporting ${exportPct}%` : '⬇ Export MP4'}
            </button>
          )}
          {exportNote ? (
            <span
              className={styles.toolZoomLabel}
              title={exportNote}
              style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {exportNote}
            </span>
          ) : null}
        </>
      ) : null}

      {onCollapse ? (
        <>
          <span className={styles.toolDivider} />
          <button
            type="button"
            className={styles.toolButton}
            onClick={onCollapse}
            title="Hide the timeline (Cmd/Ctrl+4)"
            aria-label="Hide timeline"
          >
            ×
          </button>
        </>
      ) : null}
    </div>
  );
}
