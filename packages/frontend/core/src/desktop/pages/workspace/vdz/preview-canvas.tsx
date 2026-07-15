import { memo, useEffect, useMemo, useRef } from 'react';

import type { VdzClip, VdzTimeline } from '../../../../modules/vdz';
import { useBlobUrl } from '../../../../modules/vdz/use-vdz-media';
import {
  computePreviewFrame,
  type VdzPreviewItem,
  resolveItemRender,
  visualTransformCss,
} from './anim';
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
    case 'text':
      return (
        <div
          style={{
            fontSize: `${(clip.fontSize ?? 0.08) * 100}cqh`,
            color: clip.color ?? '#fff',
            textAlign: clip.align ?? 'center',
            fontWeight: 700,
            lineHeight: 1.1,
          }}
        >
          {clip.text}
        </div>
      );
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
    return (
      <div
        className={styles.previewText}
        style={{
          left: `${(clip.x ?? 0.5) * 100}%`,
          top: `${(clip.y ?? 0.5) * 100}%`,
          transform,
          opacity,
          filter: item.filter,
          clipPath,
        }}
      >
        <PreviewClipContent clip={clip} playheadSeconds={playheadSeconds} />
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
    </div>
  );
});

interface PreviewCanvasProps {
  timeline: VdzTimeline;
  playheadSeconds: number;
}

/**
 * The 16:9 preview stage: composited layers at the current playhead, with
 * per-clip entrance/exit animation, effect filters, and boundary transitions —
 * all computed by the pure {@link computePreviewFrame}. Video clips with real
 * media additionally render a frame-accurate seeked <video> inside the animated
 * wrapper (see {@link PreviewVideo}).
 */
export function PreviewCanvas({ timeline, playheadSeconds }: PreviewCanvasProps) {
  const items = useMemo(
    () => computePreviewFrame(timeline, playheadSeconds),
    [timeline, playheadSeconds]
  );

  return (
    <div className={styles.previewWrapper}>
      <div className={styles.preview}>
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
