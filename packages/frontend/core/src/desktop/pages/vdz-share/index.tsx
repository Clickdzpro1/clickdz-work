import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useParams } from 'react-router-dom';

import {
  computeTimelineDuration,
  type VdzAudioClip,
  type VdzClip,
  vdzTimelineSchema,
  type VdzTimeline,
} from '../../../modules/vdz';
import {
  computePreviewFrame,
  resolveItemRender,
  type VdzPreviewItem,
  visualTransformCss,
} from '../workspace/vdz/anim';
import {
  computeAudioClipGain,
  type DuckWindow,
  duckWindows,
} from '../workspace/vdz/audio-gain';
import { formatTimecode } from '../workspace/vdz/constants';
import * as styles from '../workspace/vdz/index.css';
import * as shareStyles from './share.css';

/**
 * PUBLIC share viewer — `/vdz-share/:shareId`.
 *
 * A standalone, signed-out page: it fetches the share snapshot from the
 * `@Public()` route and plays it read-only. DELIBERATELY ZERO workspace
 * dependencies — snapshots carry self-contained `data:`/https media srcs, so
 * this page renders them directly instead of going through `useBlobUrl`
 * (which requires a WorkspaceService this route doesn't have). The visual
 * math is the editor's own pure `anim.ts` + `audio-gain.ts`, so what viewers
 * see/hear is exactly what the owner previewed.
 */

const DRIFT_TOLERANCE = 0.25;

// ---- Media without workspace resolution -----------------------------------

/** Frame-accurate muted video, seeked to the playhead (mirrors the editor). */
const SharedVideo = memo(function SharedVideo({
  clip,
  playheadSeconds,
}: {
  clip: Extract<VdzClip, { type: 'video' }>;
  playheadSeconds: number;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const sourceTime = Math.max(
    0,
    playheadSeconds - clip.start + (clip.trimStart ?? 0)
  );
  useEffect(() => {
    const el = ref.current;
    if (el && Math.abs(el.currentTime - sourceTime) > 0.02) {
      try {
        el.currentTime = sourceTime;
      } catch {
        // metadata not ready yet — the next tick reseeks.
      }
    }
  }, [sourceTime]);
  return (
    <video
      ref={ref}
      src={clip.src}
      muted
      playsInline
      preload="auto"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
      }}
    />
  );
});

/** One audible voice per audio clip — the editor's playback logic, src-direct. */
const SharedAudioVoice = memo(function SharedAudioVoice({
  clip,
  playheadSeconds,
  isPlaying,
  windows,
}: {
  clip: VdzAudioClip;
  playheadSeconds: number;
  isPlaying: boolean;
  windows: DuckWindow[];
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const active =
    playheadSeconds >= clip.start &&
    playheadSeconds < clip.start + clip.duration;
  const sourceTime = Math.max(0, playheadSeconds - clip.start);
  const gain = computeAudioClipGain({ clip, t: playheadSeconds, windows });

  useEffect(() => {
    const el = ref.current;
    if (el) el.volume = gain;
  }, [gain]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !clip.src) return;
    if (isPlaying && active) {
      if (Math.abs(el.currentTime - sourceTime) > DRIFT_TOLERANCE) {
        try {
          el.currentTime = sourceTime;
        } catch {
          // retried next tick
        }
      }
      if (el.paused) void el.play().catch(() => undefined);
    } else if (!el.paused) {
      el.pause();
    }
  }, [isPlaying, active, sourceTime, clip.src]);

  useEffect(() => {
    return () => {
      const el = ref.current;
      if (el && !el.paused) el.pause();
    };
  }, []);

  if (!clip.src) return null;
  return <audio ref={ref} src={clip.src} preload="auto" />;
});

// ---- Frame rendering (mirrors preview-canvas, src-direct) -------------------

const SharedClipContent = memo(function SharedClipContent({
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
        <img
          src={clip.src}
          alt={clip.name ?? 'image clip'}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: clip.fit ?? 'cover',
          }}
        />
      ) : (
        <div className={styles.previewImagePlaceholder}>image · unavailable</div>
      );
    case 'video':
      return clip.src ? (
        <SharedVideo clip={clip} playheadSeconds={playheadSeconds} />
      ) : (
        <div className={styles.previewVideoBlock}>
          {`video · ${clip.name ?? 'unavailable'}`}
        </div>
      );
    default:
      return null;
  }
});

const SharedItem = memo(function SharedItem({
  item,
  playheadSeconds,
}: {
  item: VdzPreviewItem;
  playheadSeconds: number;
}) {
  const { clip, visual } = item;
  const { opacity, extraTranslateX, clipPath } = resolveItemRender(item);
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
        <SharedClipContent clip={clip} playheadSeconds={playheadSeconds} />
      </div>
    );
  }
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
      <SharedClipContent clip={clip} playheadSeconds={playheadSeconds} />
    </div>
  );
});

// ---- The page ----------------------------------------------------------------

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; name: string; timeline: VdzTimeline };

const SharedVdzPage = () => {
  const { shareId } = useParams<{ shareId: string }>();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(
          `/api/v1/vdz/shared/${encodeURIComponent(shareId ?? '')}`
        );
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? 'This share link does not exist or was revoked.'
              : `Could not load this share (${res.status}).`
          );
        }
        const data = (await res.json()) as {
          name?: unknown;
          timeline?: unknown;
        };
        // Validate against the REAL schema — a corrupt/foreign snapshot shows
        // a friendly error instead of a broken player.
        const parsed = vdzTimelineSchema.safeParse(data?.timeline);
        if (!parsed.success) {
          throw new Error('This share contains an unreadable timeline.');
        }
        if (alive) {
          setState({
            status: 'ready',
            name:
              typeof data?.name === 'string' && data.name
                ? data.name
                : 'Shared video',
            timeline: parsed.data,
          });
        }
      } catch (e) {
        if (alive) {
          setState({
            status: 'error',
            message:
              e instanceof Error ? e.message : 'Could not load this share.',
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [shareId]);

  const timeline = state.status === 'ready' ? state.timeline : null;
  const duration = useMemo(
    () => (timeline ? computeTimelineDuration(timeline) : 0),
    [timeline]
  );
  const windows = useMemo(
    () => (timeline ? duckWindows(timeline) : []),
    [timeline]
  );
  const items = useMemo(
    () => (timeline ? computePreviewFrame(timeline, playheadSeconds) : []),
    [timeline, playheadSeconds]
  );
  const audioClips = useMemo(() => {
    if (!timeline) return [] as VdzAudioClip[];
    const out: VdzAudioClip[] = [];
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.type === 'audio' && clip.src) out.push(clip);
      }
    }
    return out;
  }, [timeline]);

  // rAF master clock (the editor's loop, read-only page edition).
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setPlayheadSeconds(prev => {
        const next = prev + dt;
        if (next >= durationRef.current) {
          setIsPlaying(false);
          return durationRef.current;
        }
        return next;
      });
      if (isPlayingRef.current) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  const togglePlay = useCallback(() => {
    setIsPlaying(prev => {
      if (!prev && playheadSeconds >= durationRef.current) {
        setPlayheadSeconds(0);
      }
      return !prev;
    });
  }, [playheadSeconds]);

  return (
    <div className={shareStyles.page}>
      <div
        style={{
          width: 'min(960px, 100%)',
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
        }}
      >
        <span style={{ fontSize: 18, fontWeight: 700 }}>
          {state.status === 'ready' ? state.name : 'Vdz Studio'}
        </span>
        <span style={{ fontSize: 12, color: 'var(--vdz-muted, #8a90a0)' }}>
          shared video
        </span>
      </div>

      <div style={{ width: 'min(960px, 100%)' }}>
        {state.status === 'loading' ? (
          <div style={{ color: 'var(--vdz-muted, #8a90a0)', fontSize: 13 }}>
            Loading…
          </div>
        ) : state.status === 'error' ? (
          <div style={{ color: '#ff6b6b', fontSize: 13 }}>{state.message}</div>
        ) : (
          <>
            <div className={styles.previewWrapper}>
              <div className={styles.preview}>
                {items.length === 0 ? (
                  <div className={styles.previewEmpty}>
                    no clips at {formatTimecode(playheadSeconds)}
                  </div>
                ) : (
                  items.map(item => (
                    <SharedItem
                      key={item.key}
                      item={item}
                      playheadSeconds={playheadSeconds}
                    />
                  ))
                )}
              </div>
            </div>

            {/* Hidden audio pool (same gain engine as the editor). */}
            <div aria-hidden="true" style={{ display: 'none' }}>
              {audioClips.map(clip => (
                <SharedAudioVoice
                  key={clip.id}
                  clip={clip}
                  playheadSeconds={playheadSeconds}
                  isPlaying={isPlaying}
                  windows={windows}
                />
              ))}
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginTop: 12,
              }}
            >
              <button
                type="button"
                onClick={togglePlay}
                style={{
                  appearance: 'none',
                  border: '1px solid var(--vdz-border, #262a35)',
                  background: 'var(--vdz-raised, #191c25)',
                  color: 'var(--vdz-text, #e6e9f0)',
                  fontSize: 13,
                  fontWeight: 600,
                  padding: '7px 14px',
                  borderRadius: 8,
                  cursor: 'pointer',
                }}
              >
                {isPlaying ? '⏸ Pause' : '▶ Play'}
              </button>
              <input
                type="range"
                min={0}
                max={Math.max(duration, 0.1)}
                step={0.1}
                value={Math.min(playheadSeconds, Math.max(duration, 0.1))}
                onChange={e => {
                  setIsPlaying(false);
                  setPlayheadSeconds(Number(e.target.value));
                }}
                aria-label="Playhead"
                style={{ flex: 1 }}
              />
              <span
                style={{
                  fontSize: 12,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--vdz-muted, #8a90a0)',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatTimecode(playheadSeconds)} / {formatTimecode(duration)}
              </span>
            </div>
          </>
        )}
      </div>

      <div
        style={{
          marginTop: 'auto',
          fontSize: 12,
          color: 'var(--vdz-muted, #8a90a0)',
        }}
      >
        Made with{' '}
        <a
          href="/"
          style={{ color: 'var(--vdz-accent, #5b8cff)', fontWeight: 600 }}
        >
          Vdz Studio — ClickDz Work
        </a>
      </div>
    </div>
  );
};

export const Component = () => {
  return <SharedVdzPage />;
};
