import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { VdzClip, VdzTimeline } from '../../../../modules/vdz';
import { useBlobUrl } from '../../../../modules/vdz/use-vdz-media';
import {
  captionAnchorY,
  captionPresetCss,
  computePreviewFrame,
  karaokeProgress,
  karaokeTokens,
  karaokeWordCss,
  type VdzCaptionInput,
  type VdzPreviewItem,
  resolveItemRender,
  vignetteOverlayCss,
  visualTransformCss,
} from './anim';

/** Parse a `prop:value;` CSS block into a React style object. */
function parseCssBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of block.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const key = decl.slice(0, i).trim();
    const val = decl.slice(i + 1).trim();
    if (!key || !val) continue;
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = val;
  }
  return out;
}
import { formatTimecode } from './constants';
import * as styles from './index.css';
import { PreviewZoomChip } from './preview-zoom-chip';

/**
 * A frame-accurate <video> for the preview: muted, controls-off, and seeked to
 * the source time for the current playhead. This is a VISUAL scrub preview only
 * — we deliberately do not attempt synced audio playback in this PR (the video
 * is muted and never `.play()`ed; each playhead change re-seeks the element).
 */
const PreviewVideo = memo(function PreviewVideo({
  clip,
  playheadSeconds,
}: {
  clip: Extract<VdzClip, { type: 'video' }>;
  playheadSeconds: number;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  // Resolve a durable `vdz-blob:` handle (or pass a remote URL through) to a
  // live media URL; undefined while a workspace blob is still being fetched.
  const resolvedSrc = useBlobUrl(clip.src);
  // Source time = elapsed within the clip, plus whatever head was trimmed.
  const sourceTime = Math.max(
    0,
    playheadSeconds - clip.start + (clip.trimStart ?? 0)
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only seek when meaningfully different to avoid thrashing the decoder.
    if (
      Number.isFinite(sourceTime) &&
      Math.abs(el.currentTime - sourceTime) > 0.02
    ) {
      try {
        el.currentTime = sourceTime;
      } catch {
        // Seeking before metadata is ready throws in some browsers — ignore;
        // the onLoadedMetadata handler re-applies the seek below.
      }
    }
  }, [sourceTime, resolvedSrc]);

  if (!resolvedSrc) {
    return <div className={styles.previewVideoBlock}>video · loading…</div>;
  }

  return (
    <video
      ref={ref}
      className={styles.previewImage}
      src={resolvedSrc}
      muted
      playsInline
      preload="auto"
      // No controls: this is a scrub-only surface driven by the playhead.
      onLoadedMetadata={e => {
        const el = e.currentTarget;
        if (Number.isFinite(sourceTime)) {
          try {
            el.currentTime = sourceTime;
          } catch {
            // ignore
          }
        }
      }}
      style={{ objectFit: 'cover' }}
    />
  );
});

/**
 * An <img> for an image clip whose `src` is resolved through {@link useBlobUrl}
 * (durable `vdz-blob:` → live object URL, remote URLs pass through). Shows the
 * placeholder while a workspace blob is still resolving.
 */
const ResolvedImg = memo(function ResolvedImg({
  clip,
}: {
  clip: Extract<VdzClip, { type: 'image' }>;
}) {
  const resolvedSrc = useBlobUrl(clip.src);
  if (!resolvedSrc) {
    return <div className={styles.previewImagePlaceholder}>image · loading…</div>;
  }
  return (
    <img
      className={styles.previewImage}
      src={resolvedSrc}
      alt={clip.name ?? 'image clip'}
      style={{ objectFit: clip.fit ?? 'cover' }}
    />
  );
});

/**
 * The inner content of a clip (text/shape/image/video/audio). Memoized on the
 * clip REFERENCE (which `computePreviewFrame` preserves across playhead ticks —
 * it recomputes `visual`/`transition` but reuses the clip object) plus the
 * playhead. Text/shape re-render only on a real clip edit; video re-renders per
 * tick to re-seek but its `<video>`/`<img>` `src` stays referentially stable so
 * the element (and its decoder) is never torn down mid-scrub.
 */
const PreviewClipContent = memo(function PreviewClipContent({
  clip,
  playheadSeconds,
}: {
  clip: VdzClip;
  playheadSeconds: number;
}) {
  switch (clip.type) {
    case 'text': {
      const capClip = clip as unknown as VdzCaptionInput;
      // `outline` caption preset draws a stroke ring on the glyphs.
      const stroke =
        capClip.capPreset === 'outline'
          ? {
              WebkitTextStroke: '0.06em rgba(0,0,0,0.85)',
              paintOrder: 'stroke fill' as const,
            }
          : undefined;
      // Karaoke: when the clip is the `karaoke` preset AND carries word
      // timings, render per-word <span>s driven by the clip-relative playhead
      // (spoken = full colour, active = accent pill + slight scale + underline,
      // upcoming = dimmed). tRel is computed from the SAME clip timing the rest
      // of this component uses (playhead − clip.start). Missing words → falls
      // through to the plain single-node render (degrades to the boxed look).
      const tokens =
        capClip.capPreset === 'karaoke' ? karaokeTokens(capClip) : null;
      const inner =
        tokens && tokens.length > 0 ? (
          (() => {
            const tRel = playheadSeconds - clip.start;
            const { state } = karaokeProgress(capClip, tRel);
            return tokens.map((tok, i) => (
              <span
                // Index-keyed: token order is stable for a given clip.
                key={i}
                style={parseCssBlock(karaokeWordCss(state(i)))}
              >
                {tok.w}
                {i < tokens.length - 1 ? ' ' : ''}
              </span>
            ));
          })()
        ) : (
          clip.text
        );
      return (
        <div
          style={{
            fontSize: `${(clip.fontSize ?? 0.08) * 100}cqh`,
            color: clip.color ?? '#fff',
            textAlign: clip.align ?? 'center',
            fontWeight: 700,
            lineHeight: 1.1,
            ...stroke,
          }}
        >
          {inner}
        </div>
      );
    }
    case 'shape':
      return (
        <div
          style={{
            width: '100%',
            height: '100%',
            background: clip.color ?? '#5b8cff',
            borderRadius: clip.shape === 'circle' ? '50%' : 4,
          }}
        />
      );
    case 'image':
      return clip.src ? (
        <ResolvedImg clip={clip} />
      ) : (
        <div className={styles.previewImagePlaceholder}>image · empty src</div>
      );
    case 'video': {
      // Real media → a frame-accurate seeked <video>. Empty src keeps the
      // hatched placeholder block (nothing to show yet).
      if (clip.src) {
        return <PreviewVideo clip={clip} playheadSeconds={playheadSeconds} />;
      }
      const label = clip.name ?? 'video';
      return (
        <div className={styles.previewVideoBlock}>{`video · ${label}`}</div>
      );
    }
    case 'audio':
      return null;
    default:
      return null;
  }
});

/**
 * Position + animate one preview item. Text is positioned by its anchor
 * (translate -50%); shapes/images by an absolute box. Animation transform,
 * transition slide, effect filters and opacity all fold in here — every value
 * comes from the pure {@link resolveItemRender} / {@link visualTransformCss}.
 *
 * `playheadSeconds` is threaded through so a video clip's inner <video> can seek
 * to the right source frame (the pure preview item carries no clock).
 */
const PreviewItem = memo(function PreviewItem({
  item,
  playheadSeconds,
}: {
  item: VdzPreviewItem;
  playheadSeconds: number;
}) {
  const { clip, visual } = item;
  const { opacity, extraTranslateX, clipPath } = resolveItemRender(item);

  // The clip's own animation translate, plus a transition slide, share one
  // transform. Add the transition's X to the animation's before serializing.
  const composedVisual = {
    ...visual,
    translateX: visual.translateX + extraTranslateX,
  };

  const isText = clip.type === 'text';
  const transform = visualTransformCss(composedVisual, isText ? 'text' : 'clip');

  if (isText) {
    // capPosition anchors the caption when there is no explicit `y`; capPreset
    // wrap-chrome (pill/boxed bg+padding+radius, shadow/outline text-shadow
    // override) — both from anim.ts so this matches the exported HTML.
    const capClip = clip as unknown as VdzCaptionInput;
    const capWrap = parseCssBlock(captionPresetCss(capClip).wrap);
    const textVignette = vignetteOverlayCss(clip.effects);
    return (
      <div
        className={styles.previewText}
        style={{
          left: `${(clip.x ?? 0.5) * 100}%`,
          top: `${captionAnchorY(capClip) * 100}%`,
          transform,
          opacity,
          filter: item.filter,
          clipPath,
          ...capWrap,
        }}
      >
        <PreviewClipContent clip={clip} playheadSeconds={playheadSeconds} />
        {textVignette ? <div style={parseCssBlock(textVignette)} /> : null}
      </div>
    );
  }

  // Shapes/images/video fill their box (x/y/w/h fractions; video/image inset 0).
  const box =
    clip.type === 'shape'
      ? {
          left: `${(clip.x ?? 0) * 100}%`,
          top: `${(clip.y ?? 0) * 100}%`,
          width: `${(clip.w ?? 1) * 100}%`,
          height: `${(clip.h ?? 1) * 100}%`,
        }
      : { inset: 0 };

  return (
    <div
      className={styles.previewLayer}
      style={{
        ...box,
        transform: transform === 'none' ? undefined : transform,
        transformOrigin: 'center',
        opacity,
        filter: item.filter,
        clipPath,
      }}
    >
      <PreviewClipContent clip={clip} playheadSeconds={playheadSeconds} />
      {vignetteOverlayCss(clip.effects) ? (
        <div style={parseCssBlock(vignetteOverlayCss(clip.effects) as string)} />
      ) : null}
    </div>
  );
});

interface PreviewCanvasProps {
  timeline: VdzTimeline;
  playheadSeconds: number;
}

/** A measured content-box size in CSS pixels. */
interface Size {
  width: number;
  height: number;
}

/**
 * Fallback canvas size (16:9, the schema default) for a legacy timeline that is
 * missing dimensions. Matches the old inline `'16 / 9'` fallback.
 */
const FALLBACK_CANVAS: Size = { width: 1920, height: 1080 };

// ---- Zoom model ----------------------------------------------------------
// `zoom` is a MULTIPLIER RELATIVE TO FIT: the on-screen canvas scale is
// `effectiveScale = fitScale * zoom`, where `fitScale = min(wrapW/canvasW,
// wrapH/canvasH)` is the contain-fit factor. This is the cleaner of the two
// models the brief offered:
//   • "Fit" is exactly `zoom === 1` — trivially detected/restored, and it
//     re-fits automatically on any resize (fitScale is recomputed each frame).
//   • The chip's PERCENTAGE readout is CANVAS-PIXEL scale = `effectiveScale`
//     (100% ⇒ one native canvas pixel per screen pixel), independent of the
//     current fit. So the named modes read as absolute pixel scales: 50% / 100%
//     / 200% are `effectiveScale` targets; selecting one sets `zoom = target /
//     fitScale`.
// Guards: `zoom` is clamped so the multiplier stays in [MIN_ZOOM, MAX_ZOOM] AND
// the resulting `effectiveScale` stays in [MIN_EFFECTIVE, MAX_EFFECTIVE] — this
// keeps a 320px canvas from vanishing and a 4096px canvas from exploding the DOM
// box. The final pixel size is re-clamped at render too, so a stale zoom (after
// a drastic shrink) can never produce an absurd element.
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 64;
const MIN_EFFECTIVE = 0.02;
const MAX_EFFECTIVE = 8;
// Multiplicative step for the − / + chip buttons and Ctrl/Cmd+wheel notches.
const ZOOM_STEP = 1.2;
// Effective-scale ladder (%) the − / + steppers snap through, so the steppers
// land exactly on the named 50 / 100 / 200 modes rather than drifting.
const ZOOM_LADDER = [10, 25, 50, 75, 100, 150, 200, 400, 800];
// "Fit" and "at fit" are `zoom === 1` within this epsilon (float-safe).
const FIT_EPSILON = 1e-3;

/** Contain-fit factor; 1 when any dimension is not yet measured (mount guard). */
function getFitScale(canvas: Size, wrap: Size): number {
  if (
    canvas.width <= 0 ||
    canvas.height <= 0 ||
    wrap.width <= 0 ||
    wrap.height <= 0
  ) {
    return 1;
  }
  return Math.min(wrap.width / canvas.width, wrap.height / canvas.height);
}

/** Clamp a zoom multiplier against both the raw and effective-scale bounds. */
function clampZoom(zoom: number, fitScale: number): number {
  let lo = MIN_ZOOM;
  let hi = MAX_ZOOM;
  if (fitScale > 0) {
    lo = Math.max(lo, MIN_EFFECTIVE / fitScale);
    hi = Math.min(hi, MAX_EFFECTIVE / fitScale);
  }
  if (hi < lo) hi = lo; // Degenerate (huge canvas, tiny box): pin to the floor.
  return Math.min(hi, Math.max(lo, zoom));
}

/**
 * Measure an element's content-box via ResizeObserver. Returns 0×0 until the
 * first observation (callers guard on that). `useLayoutEffect` so the very
 * first real size is applied before paint, avoiding a one-frame mis-scale.
 */
function useElementSize<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  Size,
] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        // Prefer contentRect; fall back to the box's client size. Round to whole
        // pixels so sub-pixel jitter doesn't thrash re-renders.
        const cr = entry.contentRect;
        const w = Math.round(cr.width);
        const h = Math.round(cr.height);
        setSize(prev =>
          prev.width === w && prev.height === h ? prev : { width: w, height: h }
        );
      }
    });
    ro.observe(el);
    // Seed synchronously so we don't wait a frame for the first callback.
    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    setSize(prev =>
      prev.width === w && prev.height === h ? prev : { width: w, height: h }
    );
    return () => ro.disconnect();
  }, []);

  return [ref, size];
}

/**
 * The preview stage: composited layers at the current playhead, with per-clip
 * entrance/exit animation, effect filters, and boundary transitions — all
 * computed by the pure {@link computePreviewFrame}. Video clips with real media
 * additionally render a frame-accurate seeked <video> inside the animated
 * wrapper (see {@link PreviewVideo}). This component owns SIZING ONLY; every
 * clip's rendering (transforms, filters, captions, video seek) is unchanged.
 *
 * Sizing is measured, not width-driven: a ResizeObserver reads the viewport's
 * real box, `fitScale = min(wrapW/canvasW, wrapH/canvasH)` gives the contain
 * factor, and the canvas element is given EXACT computed pixel width/height
 * (`canvasW/H × fitScale × zoom`), centered with a letterbox surround. Because
 * the box is never sized by CSS `aspect-ratio`, a portrait (9:16) canvas can
 * never overshoot its wrapper and collapse the layout. Every clip value stays
 * aspect-relative (`cqh` text, fraction/inset boxes) so it follows the box.
 */
export function PreviewCanvas({ timeline, playheadSeconds }: PreviewCanvasProps) {
  const items = useMemo(
    () => computePreviewFrame(timeline, playheadSeconds),
    [timeline, playheadSeconds]
  );

  // The canvas' intrinsic pixel size (project ratio). Fall back to 16:9 for a
  // legacy timeline missing dimensions — same fallback as the old aspect box.
  const canvas = useMemo<Size>(() => {
    const w = timeline.width;
    const h = timeline.height;
    return w && h && w > 0 && h > 0
      ? { width: w, height: h }
      : FALLBACK_CANVAS;
  }, [timeline.width, timeline.height]);

  const [viewportRef, viewport] = useElementSize<HTMLDivElement>();

  // Zoom multiplier relative to fit (1 = Fit). Kept as intent; clamped on write.
  const [zoom, setZoom] = useState(1);

  const fitScale = getFitScale(canvas, viewport);

  // The on-screen scale, re-clamped against effective bounds so even a stale
  // `zoom` (after a drastic resize) can't produce an absurd element size.
  const rawEffective = fitScale * zoom;
  const effectiveScale = Math.min(
    MAX_EFFECTIVE,
    Math.max(MIN_EFFECTIVE, rawEffective)
  );

  // Whether we're measured yet — guards the mount frame (0×0 viewport).
  const measured = viewport.width > 0 && viewport.height > 0;

  // Computed canvas pixel box. Before measurement, render nothing sized (0×0
  // stays invisible) so we never paint a wrong-sized frame that then jumps.
  const canvasWidthPx = measured
    ? Math.max(1, Math.round(canvas.width * effectiveScale))
    : 0;
  const canvasHeightPx = measured
    ? Math.max(1, Math.round(canvas.height * effectiveScale))
    : 0;

  // Scroll when the canvas is larger than the viewport in either axis (zoomed
  // beyond fit). A tiny slack avoids a spurious scrollbar at exactly-fit.
  const needsScroll =
    measured &&
    (canvasWidthPx > viewport.width + 1 ||
      canvasHeightPx > viewport.height + 1);

  const atFit = Math.abs(zoom - 1) < FIT_EPSILON;
  const percent = Math.round(effectiveScale * 100);

  // Zoom bounds for enabling/disabling the steppers.
  const zoomBounds = useMemo(() => {
    if (fitScale <= 0) return { lo: MIN_ZOOM, hi: MAX_ZOOM };
    return {
      lo: Math.max(MIN_ZOOM, MIN_EFFECTIVE / fitScale),
      hi: Math.min(MAX_ZOOM, MAX_EFFECTIVE / fitScale),
    };
  }, [fitScale]);
  const canZoomIn = zoom < zoomBounds.hi - FIT_EPSILON;
  const canZoomOut = zoom > zoomBounds.lo + FIT_EPSILON;

  const fitToView = useCallback(() => setZoom(1), []);

  // − / + snap through the effective-scale ladder so the steppers land on the
  // named 50 / 100 / 200 modes; off-ladder (wheel) values step to the next stop.
  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      setZoom(prev => {
        const fit = fitScale > 0 ? fitScale : 1;
        const curPct = fit * prev * 100;
        let targetPct: number | undefined;
        if (dir > 0) {
          targetPct = ZOOM_LADDER.find(p => p > curPct + 0.5);
        } else {
          for (let i = ZOOM_LADDER.length - 1; i >= 0; i--) {
            if (ZOOM_LADDER[i] < curPct - 0.5) {
              targetPct = ZOOM_LADDER[i];
              break;
            }
          }
        }
        // Past the ladder ends, fall back to a multiplicative nudge.
        const nextZoom =
          targetPct != null ? targetPct / 100 / fit : prev * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
        return clampZoom(nextZoom, fitScale);
      });
    },
    [fitScale]
  );

  // Ctrl/Cmd + wheel over the viewport zooms about the cursor's neighbourhood
  // (continuous, multiplicative). Attached as a NON-passive native listener so
  // we can preventDefault the browser's page-zoom; React's onWheel is passive.
  // A plain wheel (no modifier) is left alone so the scroll host can pan when
  // the canvas is zoomed past fit.
  const fitScaleRef = useRef(fitScale);
  fitScaleRef.current = fitScale;
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0015);
      setZoom(prev => clampZoom(prev * factor, fitScaleRef.current));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewportRef]);

  return (
    <div className={styles.previewViewport} ref={viewportRef}>
      <div
        className={styles.previewCanvasScrollHost}
        data-scroll={needsScroll ? 'true' : 'false'}
      >
        <div
          className={styles.previewCanvas}
          style={{ width: canvasWidthPx, height: canvasHeightPx }}
        >
          {items.length === 0 ? (
            <div className={styles.previewEmpty}>
              no clips at {formatTimecode(playheadSeconds)}
            </div>
          ) : (
            items.map(item => (
              <PreviewItem
                key={item.key}
                item={item}
                playheadSeconds={playheadSeconds}
              />
            ))
          )}
        </div>
      </div>
      <PreviewZoomChip
        percent={percent}
        atFit={atFit}
        canZoomOut={canZoomOut}
        canZoomIn={canZoomIn}
        onZoomOut={() => stepZoom(-1)}
        onZoomIn={() => stepZoom(1)}
        onFit={fitToView}
      />
    </div>
  );
}
