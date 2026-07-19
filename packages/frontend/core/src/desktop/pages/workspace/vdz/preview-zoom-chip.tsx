import { memo } from 'react';

import * as styles from './index.css';

interface PreviewZoomChipProps {
  /**
   * The current effective canvas-pixel scale as a percentage (100 = 1 native
   * canvas pixel per screen pixel). Already rounded by the caller.
   */
  percent: number;
  /** True when the preview is exactly at fit (zoom multiplier === 1). */
  atFit: boolean;
  /** Steppers are disabled at the clamp edges. */
  canZoomOut: boolean;
  canZoomIn: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
}

/**
 * The small overlay zoom control shown at the bottom-right of the preview
 * viewport: a − / + stepper pair around a live percentage readout, plus a
 * "Fit" button. Purely presentational — all zoom math lives in PreviewCanvas.
 *
 * The percentage is canvas-pixel scale (see PreviewCanvas' zoom model note), so
 * "100%" always means 1:1 native pixels regardless of the current fit scale.
 */
export const PreviewZoomChip = memo(function PreviewZoomChip({
  percent,
  atFit,
  canZoomOut,
  canZoomIn,
  onZoomOut,
  onZoomIn,
  onFit,
}: PreviewZoomChipProps) {
  return (
    <div
      className={styles.previewZoomChip}
      // Keep clicks on the chip from bubbling to the viewport (selection /
      // scrub handlers) or being read as a canvas interaction.
      onPointerDown={e => e.stopPropagation()}
      role="group"
      aria-label="Preview zoom"
    >
      <button
        type="button"
        className={styles.previewZoomButton}
        onClick={onZoomOut}
        disabled={!canZoomOut}
        aria-label="Zoom out"
        title="Zoom out"
      >
        −
      </button>
      <span
        className={styles.previewZoomReadout}
        aria-live="polite"
        aria-label={`Preview zoom ${percent}%`}
      >
        {percent}%
      </span>
      <button
        type="button"
        className={styles.previewZoomButton}
        onClick={onZoomIn}
        disabled={!canZoomIn}
        aria-label="Zoom in"
        title="Zoom in"
      >
        +
      </button>
      <button
        type="button"
        className={`${styles.previewZoomButton} ${styles.previewZoomFit}`}
        data-active={atFit}
        aria-pressed={atFit}
        onClick={onFit}
        title="Fit to view"
      >
        Fit
      </button>
    </div>
  );
});
