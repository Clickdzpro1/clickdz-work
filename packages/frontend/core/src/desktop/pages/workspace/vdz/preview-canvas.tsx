import { memo, useEffect, useMemo, useRef } from 'react';

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

/**
 * The preview stage: composited layers at the current playhead, with per-clip
 * entrance/exit animation, effect filters, and boundary transitions — all
 * computed by the pure {@link computePreviewFrame}. Video clips with real media
 * additionally render a frame-accurate seeked <video> inside the animated
 * wrapper (see {@link PreviewVideo}).
 *
 * The stage's aspect ratio is derived from the timeline's `width`/`height`
 * (letterboxed inside the flex-centered wrapper), so changing the project's
 * canvas ratio reshapes the preview. The inline `aspectRatio` overrides the
 * `styles.preview` fallback; every clip value is aspect-relative (`cqh` text,
 * fraction/inset boxes) so it follows the box automatically.
 */
export function PreviewCanvas({ timeline, playheadSeconds }: PreviewCanvasProps) {
  const items = useMemo(
    () => computePreviewFrame(timeline, playheadSeconds),
    [timeline, playheadSeconds]
  );

  // Derive the stage aspect from the timeline canvas size. Fall back to 16:9
  // (the schema default 1280×720) if a legacy timeline is missing dimensions.
  const aspectRatio = useMemo(() => {
    const w = timeline.width;
    const h = timeline.height;
    return w && h && w > 0 && h > 0 ? `${w} / ${h}` : '16 / 9';
  }, [timeline.width, timeline.height]);

  return (
    <div className={styles.previewWrapper}>
      <div className={styles.preview} style={{ aspectRatio, maxWidth: '100%' }}>
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
  );
}
