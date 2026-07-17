/**
 * clickdz-remotion-worker — the Remotion composition mapping a RenderManifest
 * 1:1 onto React/Remotion primitives.
 *
 * Layout mirrors the app's preview + HTML compiler:
 *   · a fixed width×height <AbsoluteFill> stage (the manifest carries the box);
 *   · one <Sequence from={fromFrame} durationInFrames> per clip;
 *   · z-index by track order (overlay above video), audio last;
 *   · each clip's opacity/transform/clip-path/filter recomputed PER FRAME via
 *     the pure `./anim` port of the app's anim.ts, then any active transition
 *     folded in the SAME way `resolveItemRender` does;
 *   · text captions get their chrome from a local `captionPresetCss` mirror and
 *     per-word karaoke spans lit by clip-relative frame;
 *   · video clips are REAL <OffthreadVideo> with `trimStartInFrames` and a
 *     volume ramp — the per-frame fidelity the HTML tier could not reach;
 *   · audio clips are <Audio> with a per-frame gain that applies fade in/out AND
 *     any ducking windows from a voiceover.
 *
 * Everything is a pure function of `frame` + the manifest, so a render is
 * deterministic and matches the preview at the same playhead.
 */

import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
} from 'remotion';

import {
  clipVisualState,
  effectsFilter,
  KARAOKE_ACCENT,
  KARAOKE_UPCOMING_OPACITY,
  karaokeState,
  mergeFilters,
  resolveTransition,
  transformCss,
  transitionState,
  vignetteOverlay,
} from './anim';
import type {
  ManifestAudioClip,
  ManifestClip,
  ManifestImageClip,
  ManifestShapeClip,
  ManifestTextClip,
  ManifestTrack,
  ManifestVideoClip,
  RenderManifest,
} from './manifest';

/** The single default caption text-shadow (mirrors app CAPTION_DEFAULT_TEXT_SHADOW). */
const CAPTION_DEFAULT_TEXT_SHADOW = '0 2px 12px rgba(0,0,0,0.6)';

/**
 * The wrapper + inner-text CSS a caption preset contributes, mirroring the app's
 * `captionPresetCss` exactly (so exported captions match the preview chrome).
 */
function captionPresetCss(preset: ManifestTextClip['capPreset']): {
  wrap: React.CSSProperties;
  text: React.CSSProperties;
} {
  switch (preset) {
    case 'boxed':
      return {
        wrap: {
          background: 'rgba(0,0,0,0.55)',
          padding: '0.28em 0.6em',
          borderRadius: 10,
        },
        text: {},
      };
    case 'pill':
      return {
        wrap: {
          background: 'rgba(0,0,0,0.6)',
          padding: '0.16em 0.7em',
          borderRadius: 999,
        },
        text: {},
      };
    case 'outline':
      return {
        wrap: { textShadow: 'none' },
        text: {
          WebkitTextStroke: '0.06em rgba(0,0,0,0.85)',
          paintOrder: 'stroke fill',
        } as React.CSSProperties,
      };
    case 'shadow':
      return {
        wrap: { textShadow: '0 4px 18px rgba(0,0,0,0.85)' },
        text: {},
      };
    case 'karaoke':
      return {
        wrap: {
          background: 'rgba(0,0,0,0.6)',
          padding: '0.24em 0.62em',
          borderRadius: 12,
        },
        text: {},
      };
    case 'plain':
    default:
      return { wrap: {}, text: {} };
  }
}

/** The per-word karaoke span style for a state (mirrors app karaokeWordCss). */
function karaokeWordStyle(state: 'spoken' | 'active' | 'upcoming'): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    borderRadius: 6,
    transformOrigin: 'center bottom',
  };
  switch (state) {
    case 'active':
      return {
        ...base,
        background: KARAOKE_ACCENT,
        color: '#1a1200',
        padding: '0 0.12em',
        transform: 'scale(1.08)',
        boxShadow: '0 0 0.5em rgba(255,213,74,0.5)',
        textDecoration: 'underline',
        textDecorationThickness: '0.06em',
      };
    case 'spoken':
      return { ...base, opacity: 1 };
    case 'upcoming':
    default:
      return { ...base, opacity: KARAOKE_UPCOMING_OPACITY };
  }
}

/** Find, for a clip, the active transition (if any) and this clip's role in it. */
function transitionForClip(
  track: ManifestTrack,
  clipIndex: number,
  frame: number
): { state: ReturnType<typeof transitionState>; role: 'out' | 'in' } | null {
  const clip = track.clips[clipIndex];
  const next = track.clips[clipIndex + 1];
  // Outgoing side: a transition AFTER this clip, abutting the next clip.
  const outgoing = track.transitions.find(t => t.afterClipId === clip.id);
  if (outgoing && next) {
    const st = transitionState({
      kind: outgoing.kind,
      boundaryInFrames: outgoing.boundaryInFrames,
      durationInFrames: outgoing.durationInFrames,
      frame,
    });
    if (st) return { state: st, role: 'out' };
  }
  // Incoming side: a transition after the PREVIOUS clip.
  if (clipIndex > 0) {
    const prev = track.clips[clipIndex - 1];
    const incoming = track.transitions.find(t => t.afterClipId === prev.id);
    if (incoming) {
      const st = transitionState({
        kind: incoming.kind,
        boundaryInFrames: incoming.boundaryInFrames,
        durationInFrames: incoming.durationInFrames,
        frame,
      });
      if (st) return { state: st, role: 'in' };
    }
  }
  return null;
}

/** Render the inner content of a visual clip (text / shape / image / video). */
function ClipInner(props: {
  clip: ManifestClip;
  manifest: RenderManifest;
  localFrame: number;
}): React.ReactElement | null {
  const { clip, manifest } = props;
  switch (clip.type) {
    case 'text':
      return <TextClipInner clip={clip} manifest={manifest} localFrame={props.localFrame} />;
    case 'shape':
      return <ShapeClipInner clip={clip} />;
    case 'image':
      return <ImageClipInner clip={clip} />;
    case 'video':
      return <VideoClipInner clip={clip} manifest={manifest} />;
    default:
      return null;
  }
}

function ShapeClipInner({ clip }: { clip: ManifestShapeClip }): React.ReactElement {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: clip.color,
        borderRadius: clip.shape === 'circle' ? '50%' : 4,
      }}
    />
  );
}

function ImageClipInner({ clip }: { clip: ManifestImageClip }): React.ReactElement | null {
  if (!clip.src) return null;
  return (
    <Img
      src={clip.src}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: clip.fit,
      }}
    />
  );
}

function VideoClipInner({
  clip,
  manifest,
}: {
  clip: ManifestVideoClip;
  manifest: RenderManifest;
}): React.ReactElement | null {
  if (!clip.src) return null;
  // trimStartInFrames maps to Remotion's `startFrom` on the media element. The
  // clip volume rides through (the compositing wrapper does NOT affect audio).
  return (
    <OffthreadVideo
      src={clip.src}
      startFrom={clip.trimStartInFrames}
      volume={clip.volume}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
      }}
    />
  );
}

function TextClipInner({
  clip,
  manifest,
  localFrame,
}: {
  clip: ManifestTextClip;
  manifest: RenderManifest;
  localFrame: number;
}): React.ReactElement {
  const px = (clip.fontSize || 0.08) * manifest.height;
  const preset = captionPresetCss(clip.capPreset);
  const textStyle: React.CSSProperties = {
    fontSize: px,
    color: clip.color,
    textAlign: clip.align,
    fontWeight: 700,
    lineHeight: 1.1,
    ...preset.text,
  };

  // Karaoke: per-word spans lit by clip-relative frame. Falls back to a single
  // node (degrading to the boxed look) when there are no words.
  const hasWords = clip.capPreset === 'karaoke' && clip.words.length > 0;
  let body: React.ReactNode;
  if (hasWords) {
    const { state } = karaokeState(clip.words, localFrame);
    body = clip.words.map((word, i) => (
      <React.Fragment key={i}>
        <span style={{ ...karaokeWordStyle(state(i)), padding: '0 0.12em' }}>
          {word.w.trim()}
        </span>
        {i < clip.words.length - 1 ? ' ' : ''}
      </React.Fragment>
    ));
  } else {
    body = clip.text;
  }

  return <div style={textStyle}>{body}</div>;
}

/** The absolute box (position/size) for a visual clip, mirroring clipBoxCss. */
function clipBox(clip: ManifestClip, manifest: RenderManifest): React.CSSProperties {
  if (clip.type === 'text') {
    return {
      position: 'absolute',
      left: `${(clip.x ?? 0.5) * 100}%`,
      top: `${clip.y * 100}%`,
      whiteSpace: 'pre-wrap',
      textShadow: CAPTION_DEFAULT_TEXT_SHADOW,
      ...captionPresetCss(clip.capPreset).wrap,
    };
  }
  if (clip.type === 'shape') {
    return {
      position: 'absolute',
      left: `${clip.x * 100}%`,
      top: `${clip.y * 100}%`,
      width: `${clip.w * 100}%`,
      height: `${clip.h * 100}%`,
    };
  }
  // image / video fill the stage.
  return { position: 'absolute', inset: 0 };
}

/** One visual clip: a Sequence carrying the folded per-frame render. */
function VisualClip({
  track,
  clipIndex,
  manifest,
}: {
  track: ManifestTrack;
  clipIndex: number;
  manifest: RenderManifest;
}): React.ReactElement {
  const clip = track.clips[clipIndex];
  const frame = useCurrentFrame(); // ABSOLUTE frame (Sequence offsets children,
  // but we read absolute so our anim math — which uses absolute windows — lines
  // up; the Sequence still bounds visibility to [fromFrame, +duration)).

  const isText = clip.type === 'text';

  // Base visual from the clip's own static opacity/rotation + entrance/exit.
  const base = clipVisualState({
    frame,
    fromFrame: clip.fromFrame,
    durationInFrames: clip.durationInFrames,
    staticOpacity: typeof clip.opacity === 'number' ? clip.opacity : 1,
    staticRotate: typeof clip.rotation === 'number' ? clip.rotation : 0,
    animIn: clip.animation?.in,
    animOut: clip.animation?.out,
  });

  // Fold in a transition (if this clip is a side of one right now).
  const tr = transitionForClip(track, clipIndex, frame);
  let opacity = base.opacity;
  let extraTranslateX = 0;
  let clipPath: string | undefined;
  let extraFilter: string | undefined;
  if (tr && tr.state) {
    const r = resolveTransition(tr.state, tr.role, base.opacity);
    opacity = r.opacity;
    extraTranslateX = r.extraTranslateX;
    clipPath = r.clipPath;
    extraFilter = r.extraFilter;
  }

  const transform = transformCss(
    { ...base, translateX: base.translateX + extraTranslateX },
    isText ? 'text' : 'clip'
  );
  const filter = mergeFilters(effectsFilter(clip.effects), extraFilter);
  const vignette = vignetteOverlay(clip.effects);

  return (
    <Sequence
      from={clip.fromFrame}
      durationInFrames={Math.max(1, clip.durationInFrames)}
      layout="none"
      name={clip.name || clip.id}
    >
      <div
        style={{
          ...clipBox(clip, manifest),
          opacity,
          transform,
          transformOrigin: 'center',
          clipPath,
          filter,
          zIndex: track.zIndex,
        }}
      >
        <ClipInner clip={clip} manifest={manifest} localFrame={frame - clip.fromFrame} />
        {vignette ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              borderRadius: 'inherit',
              boxShadow: vignette,
            }}
          />
        ) : null}
      </div>
    </Sequence>
  );
}

/** One audio clip: a Sequence-bounded <Audio> with a per-frame gain envelope. */
function AudioClip({ clip }: { clip: ManifestAudioClip }): React.ReactElement | null {
  const frame = useCurrentFrame();
  if (!clip.src) return null;

  const local = frame - clip.fromFrame;
  let gain = clip.volume;

  // Fade in: ramp 0 → volume over fadeInFrames from the clip start.
  if (clip.fadeInFrames > 0) {
    gain *= interpolate(local, [0, clip.fadeInFrames], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  }
  // Fade out: ramp volume → 0 over fadeOutFrames ending at the clip end.
  if (clip.fadeOutFrames > 0) {
    const outStart = clip.durationInFrames - clip.fadeOutFrames;
    gain *= interpolate(local, [outStart, clip.durationInFrames], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  }
  // Ducking: while inside any duck window, attenuate to a low floor (−12 dB ≈
  // 0.25 linear) so a voiceover sits clearly above the music.
  const DUCK_FLOOR = 0.25;
  for (const w of clip.duckedByFrames) {
    if (frame >= w.fromFrame && frame < w.toFrame) {
      gain *= DUCK_FLOOR;
      break;
    }
  }

  return (
    <Sequence
      from={clip.fromFrame}
      durationInFrames={Math.max(1, clip.durationInFrames)}
      name={clip.name || clip.id}
    >
      <Audio src={clip.src} volume={Math.max(0, Math.min(1, gain))} />
    </Sequence>
  );
}

/** The whole composition: every track's clips, in z-order, then audio. */
export const VideoComposition: React.FC<{ manifest: RenderManifest }> = ({
  manifest,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#05060a' }}>
      {manifest.tracks.map(track =>
        track.kind === 'audio'
          ? track.clips.map(clip =>
              clip.type === 'audio' ? (
                <AudioClip key={`${track.id}:${clip.id}`} clip={clip} />
              ) : null
            )
          : track.clips.map((clip, i) =>
              clip.type === 'audio' ? null : (
                <VisualClip
                  key={`${track.id}:${clip.id}`}
                  track={track}
                  clipIndex={i}
                  manifest={manifest}
                />
              )
            )
      )}
    </AbsoluteFill>
  );
};
