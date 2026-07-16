import { memo, useEffect, useRef, useState } from 'react';

import type { VdzAudioClip } from '../../../../modules/vdz';
import { useBlobUrl } from '../../../../modules/vdz/use-vdz-media';
import {
  loadWaveform,
  peekWaveform,
  type VdzWaveform,
  windowPeakCount,
  windowWidthFraction,
} from './waveform';

/**
 * Waveform rendering for audio clip blocks in the timeline lanes.
 *
 * The lanes render clips as plain divs inside one memoized pass, so this is
 * the per-clip component boundary where hooks may live: it resolves the clip's
 * durable src (same `useBlobUrl` the preview and audio playback use), loads
 * cached peaks (decode happens once per src — see waveform.ts) and paints them
 * onto an absolutely-positioned canvas behind the clip label.
 */

/** Canvas backing-store bounds (CSS stretches; drawing stays cheap). */
const MAX_CANVAS_WIDTH = 2048;
const CANVAS_HEIGHT = 36;
/** Bar color — white-on-accent reads on every theme's lane colors. */
const BAR_COLOR = 'rgba(255, 255, 255, 0.55)';

/** Load (or instantly reuse) the peaks for a clip src. */
function useVdzWaveform(src: string): VdzWaveform | null {
  const resolvedSrc = useBlobUrl(src);
  const [waveform, setWaveform] = useState<VdzWaveform | null>(
    () => (src ? peekWaveform(src) : undefined) ?? null
  );

  useEffect(() => {
    if (!src || !resolvedSrc) return;
    const hit = peekWaveform(src);
    if (hit) {
      setWaveform(hit);
      return;
    }
    let alive = true;
    void loadWaveform(src, resolvedSrc).then(loaded => {
      if (alive && loaded) setWaveform(loaded);
    });
    return () => {
      alive = false;
    };
  }, [src, resolvedSrc]);

  return waveform;
}

export interface AudioClipWaveformProps {
  clip: VdzAudioClip;
  /** Current on-screen block width in px (ghost width while trimming). */
  widthPx: number;
}

/**
 * The canvas layer inside an audio clip block. Mount it as the FIRST child of
 * the block: it pins itself to the block's box (`inset: 0`, `zIndex: 0`) and
 * ignores pointer events, so drag/trim/select behave exactly as before.
 */
export const AudioClipWaveform = memo(function AudioClipWaveform({
  clip,
  widthPx,
}: AudioClipWaveformProps) {
  const waveform = useVdzWaveform(clip.src);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const width = Math.min(
    MAX_CANVAS_WIDTH,
    Math.max(16, Math.round(widthPx))
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveform || waveform.peaks.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const H = CANVAS_HEIGHT;
    ctx.clearRect(0, 0, width, H);
    ctx.fillStyle = BAR_COLOR;

    // The peaks window this clip shows (audio plays from the source head) and
    // how much of the block it spans (tail beyond the source is silence).
    const shownPeaks = windowPeakCount(waveform, clip.duration);
    const shownWidth = Math.round(
      width * windowWidthFraction(waveform, clip.duration)
    );
    if (shownPeaks === 0 || shownWidth <= 0) return;

    // One 1px bar per canvas column, vertically centered. ≤2048 rects.
    for (let x = 0; x < shownWidth; x++) {
      const peakIndex = Math.min(
        shownPeaks - 1,
        Math.floor((x / shownWidth) * shownPeaks)
      );
      const amp = waveform.peaks[peakIndex];
      const barHeight = Math.max(1, amp * (H - 4));
      ctx.fillRect(x, (H - barHeight) / 2, 1, barHeight);
    }
  }, [waveform, width, clip.duration]);

  if (!waveform || waveform.peaks.length === 0) return null;
  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={CANVAS_HEIGHT}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
});
