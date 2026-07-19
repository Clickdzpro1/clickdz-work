import {
  captionAnchorY,
  type VdzCaptionPosition,
  type VdzCaptionPreset,
} from '../../../desktop/pages/workspace/vdz/anim';
import type {
  VdzAnimationKind,
  VdzClip,
  VdzEffectKind,
  VdzTimeline,
  VdzTrack,
  VdzTransition,
} from '../schema';
// C1: the ONE canonical export-duration rule (max clip end over ALL clips on ALL
// tracks, floored at 1s), shared with the HTML compiler + the export dialog so
// every tier derives its total from the SAME number. Imported from the
// export-orchestration module (the single home the ownership map allows for the
// shared utility); it reaches back here only via a dynamic `import()`, so the
// static import cannot form an initialization cycle.
import { computeExportDurationSec } from '../use-vdz-timeline-export';

/**
 * Vdz Studio — the Remotion RENDER MANIFEST (true-video-export track, PR1).
 *
 * A PURE function `buildRenderManifest(timeline)` that lowers a validated
 * {@link VdzTimeline} into a deterministic, SELF-CONTAINED JSON spec a Remotion
 * worker can render WITHOUT any access to the app — no blob store, no preview
 * canvas, no `anim.ts`, no React. Everything a `<Composition>` needs to paint a
 * frame is resolved here, once, into plain data.
 *
 * WHY A MANIFEST (vs. the existing HTML compile).
 * `compile-timeline.ts` emits a seekable HTML document for the headless-Chrome
 * `cdz-render` tier. That tier is honest about two hard limits it CANNOT cross
 * (see that file's header): a real `<video>` does not frame-step under the WAAPI
 * scrubber (so video clips render as a still POSTER), and there is NO audio (MP4
 * mixing is a Remotion-tier capability). The manifest exists precisely to carry
 * the fidelity the HTML tier drops — REAL per-frame video (`trimStart`) and a
 * REAL audio mix (per-clip volume, fade in/out, and voiceover DUCKING) — plus
 * everything the HTML tier already does (transitions, effects, caption chrome,
 * per-word karaoke), all as data the worker maps 1:1.
 *
 * PARITY, NOT A FORK. The manifest re-states the SAME semantics the preview and
 * the HTML compiler read from `anim.ts` — it does not invent new ones:
 *   · transition kinds `fade/slide/wipe/dissolve/push/iris`, each with its
 *     boundary + duration, so the worker reproduces `transitionStateAt`
 *     (easeOutCubic crossfade, dissolve defocus bell, slide/push translate,
 *     wipe inset, iris circle) frame-for-frame;
 *   · effect kinds + normalized `amount` (incl. the overlay-only `vignette`),
 *     mapped by the worker with the SAME per-effect ranges `effectToFilter` /
 *     `vignetteBoxShadow` use;
 *   · caption `capPreset` chrome, the resolved vertical anchor (via the shared
 *     `captionAnchorY`, so an explicit `y` or a `capPosition` third both land
 *     exactly where the preview puts them), and per-word karaoke `words`;
 *   · the transition-EXTENDED on-screen WINDOW per clip (`renderStartSec` /
 *     `renderDurationSec`, in seconds), mirroring `anim.ts::clipWindow` — an
 *     outgoing clip lingers half a transition past the boundary and an incoming
 *     clip appears half a transition early, so the worker can bound each
 *     `<Sequence>` to render the clip's fade-out / fade-in TAIL instead of hard-
 *     cutting it at the raw clip edge.
 * It imports the schema types, the ONE `captionAnchorY` helper, and the shared
 * C1 `computeExportDurationSec` utility — no DOM, no clock, no React at runtime
 * — so it stays deterministic, runtime-testable, and adds NO new dependency.
 *
 * FRAME MATH. All timeline values are SECONDS; the manifest is the frame domain
 * the worker renders in. Per-clip frame counts use round-to-nearest
 * (`Math.round(seconds * fps)`), the standard Remotion convention, so a 3.0s
 * clip at 30fps is exactly 90 frames. The COMPOSITION length is different: per
 * C3, `durationInFrames = ceil(durationSec * fps)` from the C1 duration, so a
 * fractional last frame is never dropped (a 2.98s @ 30fps timeline yields 90
 * frames, not 89), then floored to a minimum of 1 (Remotion rejects a zero-frame
 * composition). The transition-extended window fields stay in SECONDS (their
 * `…Sec` names): the worker converts them to frames itself for the `<Sequence>`.
 */

/** The manifest schema version. Bumped only on a breaking shape change. */
export const VDZ_RENDER_MANIFEST_VERSION = 1 as const;

/** A resolved transition on a track boundary, in the FRAME domain. */
export interface VdzManifestTransition {
  id: string;
  /** The transition kind (mirrors `anim.ts` `transitionStateAt`). */
  kind: VdzTransition['kind'];
  /** Clip (by id) after which this transition plays. */
  afterClipId: string;
  /** Transition length in FRAMES (rounded from seconds · fps). */
  durationInFrames: number;
  /**
   * The boundary FRAME the window is centered on — the frame where the outgoing
   * clip ends and the incoming clip begins. The window spans
   * `durationInFrames`, half before and half after (see `transitionStateAt`).
   */
  boundaryInFrames: number;
}

/** A resolved effect: kind + normalized 0..1 amount (unchanged from the clip). */
export interface VdzManifestEffect {
  kind: VdzEffectKind;
  /** 0..1 knob; the worker maps it with the SAME range `effectToFilter` uses. */
  amount: number;
}

/** A resolved entrance/exit animation side, in the FRAME domain. */
export interface VdzManifestAnimation {
  kind: VdzAnimationKind;
  /** Length in FRAMES (rounded from the spec's seconds, default 0.5s). */
  durationInFrames: number;
}

/** One karaoke word, times rebased into CLIP-RELATIVE FRAMES. */
export interface VdzManifestWord {
  w: string;
  /** Highlight-in frame, relative to the clip's own start. */
  fromFrame: number;
  /** Highlight-out frame, relative to the clip's own start. */
  toFrame: number;
}

/** Fields every manifest clip carries (the frame-domain analogue of the schema). */
interface VdzManifestClipBase {
  id: string;
  name?: string;
  /** Clip start on the track, in FRAMES (rounded from seconds · fps). */
  fromFrame: number;
  /** Clip length, in FRAMES (rounded from seconds · fps; >= 1). */
  durationInFrames: number;
  /**
   * The clip's transition-EXTENDED on-screen window START, in SECONDS (C3),
   * mirroring `anim.ts::clipWindow`: pulled EARLIER by half of the transition
   * after the previous clip when they abut (so this clip's fade-IN tail renders),
   * clamped at 0. Absent when it equals the raw `start` (no head extension). The
   * worker PREFERS this for the `<Sequence>` lower bound, falling back to
   * `fromFrame`.
   */
  renderStartSec?: number;
  /**
   * The clip's transition-EXTENDED window LENGTH, in SECONDS (C3): the window
   * end (pushed LATER by half of the transition after THIS clip when the next
   * abuts, so the fade-OUT tail renders) minus `renderStartSec`. Absent when it
   * equals the raw `duration` (no extension). The worker PREFERS this for the
   * `<Sequence>` length, falling back to `durationInFrames`.
   */
  renderDurationSec?: number;
  /** Optional entrance/exit motion, in the frame domain. */
  animation?: { in?: VdzManifestAnimation; out?: VdzManifestAnimation };
  /** Optional visual filter stack (unchanged normalized amounts). */
  effects?: VdzManifestEffect[];
  /** Static layer opacity 0..1 (multiplies animation/transition opacity). */
  opacity?: number;
  /** Static rotation in DEGREES (composes into the transform). */
  rotation?: number;
}

export interface VdzManifestVideoClip extends VdzManifestClipBase {
  type: 'video';
  /** Media source, RESOLVED to a directly-loadable url (see `resolveSrc`). */
  src: string;
  /** Frames trimmed from the head of the source media (video start offset). */
  trimStartInFrames: number;
  /** 0..1 linear gain for this clip's own audio track. */
  volume: number;
}

export interface VdzManifestAudioClip extends VdzManifestClipBase {
  type: 'audio';
  src: string;
  /** 0..1 linear gain. */
  volume: number;
  /** Ramp-in length from silence at the clip's start, in FRAMES. */
  fadeInFrames: number;
  /** Ramp-out length to silence ending at the clip's end, in FRAMES. */
  fadeOutFrames: number;
  /**
   * When true this clip DUCKS every other audio clip while it plays (a
   * voiceover under which music sits). Resolved into `duckedByFrames` on the
   * OTHER audio clips below so the worker never has to cross-reference.
   */
  duck: boolean;
  /**
   * Frame windows `[from,to]` during which THIS clip is ducked by a `duck`
   * voiceover elsewhere on the timeline. The worker attenuates the clip's gain
   * across each window. Empty when nothing ducks it.
   */
  duckedByFrames: Array<{ fromFrame: number; toFrame: number }>;
}

export interface VdzManifestImageClip extends VdzManifestClipBase {
  type: 'image';
  /** RESOLVED, directly-loadable url. */
  src: string;
  fit: 'cover' | 'contain';
}

export interface VdzManifestTextClip extends VdzManifestClipBase {
  type: 'text';
  text: string;
  /** Font size as a fraction of canvas HEIGHT (0..1). */
  fontSize: number;
  color: string;
  /** Horizontal anchor, fraction of canvas width (0..1). */
  x: number;
  /**
   * RESOLVED vertical anchor, fraction of canvas height (0..1). An explicit `y`
   * or a `capPosition` third both collapse here via the shared `captionAnchorY`
   * so the worker positions captions exactly where the preview does.
   */
  y: number;
  align: 'left' | 'center' | 'right';
  /** Caption chrome preset (`plain`..`karaoke`); worker mirrors `captionPresetCss`. */
  capPreset: VdzCaptionPreset;
  /** The originally-authored position preset, for reference (anchor already in `y`). */
  capPosition?: VdzCaptionPosition;
  /** Per-word karaoke timings, CLIP-RELATIVE FRAMES; empty when not a karaoke line. */
  words: VdzManifestWord[];
}

export interface VdzManifestShapeClip extends VdzManifestClipBase {
  type: 'shape';
  shape: 'rect' | 'circle';
  color: string;
  /** Top-left x/y and size, fractions of the canvas (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type VdzManifestClip =
  | VdzManifestVideoClip
  | VdzManifestAudioClip
  | VdzManifestImageClip
  | VdzManifestTextClip
  | VdzManifestShapeClip;

/** One track in the manifest (draw order preserved: video → overlay → audio). */
export interface VdzManifestTrack {
  id: string;
  kind: 'video' | 'audio' | 'overlay';
  name?: string;
  /**
   * Back-to-front z-index for VISUAL tracks — the worker stacks higher indices
   * on top (mirrors the compiler's `z-index: trackIndex + 1`). Audio tracks
   * carry their track index too but contribute no visual layer.
   */
  zIndex: number;
  clips: VdzManifestClip[];
  transitions: VdzManifestTransition[];
}

/**
 * The complete, self-contained render spec. A Remotion worker renders this into
 * an MP4 with NO further access to the app; everything is resolved data.
 */
export interface VdzRenderManifest {
  version: typeof VDZ_RENDER_MANIFEST_VERSION;
  /** A stable id (echoes the timeline id) for logging / cache keys. */
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  /** Total composition length in FRAMES: `ceil(durationInSeconds · fps)`, >= 1 (C3). */
  durationInFrames: number;
  /** The same total in seconds — the canonical C1 duration (max clip end, min 1s). */
  durationInSeconds: number;
  tracks: VdzManifestTrack[];
  /** Srcs that could NOT be resolved to a loadable url (kept raw, reported). */
  unresolved: string[];
}

/** Options for {@link buildRenderManifest}. */
export interface BuildRenderManifestOptions {
  /**
   * Map of a clip `src` (e.g. `vdz-blob:<id>` or a remote https url) to a
   * directly-loadable value the worker can fetch — typically a signed/public
   * https url (the Remotion worker CAN fetch over the network, unlike the
   * offline HTML tier, so a `data:` URI is NOT required). Srcs absent from the
   * map are emitted unchanged and reported in `unresolved`. Omit entirely to
   * pass every src through verbatim (fine for already-public srcs).
   */
  resolveSrc?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Frame conversion. Timeline values are SECONDS; the manifest is FRAMES. We use
// round-to-nearest (Remotion's convention), so `fps * duration` lands on a whole
// frame boundary — e.g. 3.0s @ 30fps → 90, 0.5s @ 30fps → 15. A tiny positive
// epsilon guards a value that is a hair under a .5 boundary from a float wobble.
// ---------------------------------------------------------------------------
function toFrames(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * fps + 1e-6);
}

/**
 * The transition-EXTENDED on-screen window for a clip, in SECONDS — a VERBATIM
 * mirror of `anim.ts::clipWindow` (and the HTML compiler's `clipRenderWindow`),
 * so the manifest's per-clip window matches the preview frame-for-frame:
 *   · a transition AFTER this clip pushes its END later by `duration/2`, but only
 *     when the NEXT clip actually abuts (a real crossfade, not a gap);
 *   · a transition after the PREVIOUS clip (whose boundary is this clip's start)
 *     pulls this clip's START earlier by `duration/2`, again only if they abut.
 * Start clamps at 0. Returns the raw `[start, start+duration]` when no abutting
 * transition touches either boundary.
 */
function extendedWindow(
  track: VdzTrack,
  clip: VdzClip,
  index: number
): { start: number; end: number } {
  let start = clip.start;
  let end = clip.start + clip.duration;
  const transitions = track.transitions ?? [];

  const next = track.clips[index + 1];
  if (next && Math.abs(end - next.start) < 1e-6) {
    for (const tr of transitions) {
      if (tr.afterClipId === clip.id) end += tr.duration / 2;
    }
  }
  if (index > 0) {
    const prev = track.clips[index - 1];
    if (Math.abs(prev.start + prev.duration - clip.start) < 1e-6) {
      for (const tr of transitions) {
        if (tr.afterClipId === prev.id) start -= tr.duration / 2;
      }
    }
  }
  return { start: Math.max(0, start), end };
}

/** The default animation-side duration, mirroring `anim.ts::animDuration` (0.5s). */
const DEFAULT_ANIM_SECONDS = 0.5;

/** Resolve a clip src against the map; report misses. */
function resolveSrc(
  src: string,
  map: Record<string, string> | undefined,
  unresolved: Set<string>
): string {
  if (!src) return '';
  const mapped = map?.[src];
  if (typeof mapped === 'string' && mapped) return mapped;
  // Already a directly-loadable url (public https / data:) — pass through and
  // do NOT flag it. Only workspace-local blob handles are truly unresolved.
  if (/^https?:/i.test(src) || src.startsWith('data:')) return src;
  unresolved.add(src);
  return src;
}

/** Lower a clip's optional animation into the frame domain. */
function lowerAnimation(
  clip: VdzClip,
  fps: number
): VdzManifestClipBase['animation'] {
  const anim = clip.animation;
  if (!anim || (!anim.in && !anim.out)) return undefined;
  const side = (
    spec: { kind: VdzAnimationKind; duration?: number } | undefined
  ): VdzManifestAnimation | undefined => {
    if (!spec) return undefined;
    const secs = spec.duration && spec.duration > 0 ? spec.duration : DEFAULT_ANIM_SECONDS;
    return { kind: spec.kind, durationInFrames: Math.max(1, toFrames(secs, fps)) };
  };
  const out: NonNullable<VdzManifestClipBase['animation']> = {};
  const inSide = side(anim.in);
  const outSide = side(anim.out);
  if (inSide) out.in = inSide;
  if (outSide) out.out = outSide;
  return inSide || outSide ? out : undefined;
}

/** Lower a clip's optional effect stack (normalized amounts pass through). */
function lowerEffects(clip: VdzClip): VdzManifestEffect[] | undefined {
  const effects = clip.effects;
  if (!effects || effects.length === 0) return undefined;
  return effects.map(e => ({ kind: e.kind, amount: clamp01(e.amount) }));
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * The base fields shared by every manifest clip. `win` is the clip's transition-
 * extended on-screen window (seconds); when it exceeds the raw clip span the
 * `renderStartSec`/`renderDurationSec` fields are attached (C3) so the worker can
 * render the clip's crossfade tails. Absent `win` (audio clips, which never
 * transition) → no window fields, byte-identical to before.
 */
function lowerBase(
  clip: VdzClip,
  fps: number,
  win?: { start: number; end: number }
): VdzManifestClipBase {
  const base: VdzManifestClipBase = {
    id: clip.id,
    fromFrame: toFrames(clip.start, fps),
    durationInFrames: Math.max(1, toFrames(clip.duration, fps)),
  };
  if (typeof clip.name === 'string') base.name = clip.name;
  // Transition-extended window (C3). Emit only when it actually differs from the
  // raw span (a >~1ms difference on either edge), so untouched clips add nothing.
  if (win) {
    const rawStart = clip.start;
    const rawEnd = clip.start + clip.duration;
    const headExtended = rawStart - win.start > 1e-3;
    const tailExtended = win.end - rawEnd > 1e-3;
    if (headExtended || tailExtended) {
      base.renderStartSec = win.start;
      base.renderDurationSec = Math.max(0, win.end - win.start);
    }
  }
  const animation = lowerAnimation(clip, fps);
  if (animation) base.animation = animation;
  const effects = lowerEffects(clip);
  if (effects) base.effects = effects;
  if (typeof clip.opacity === 'number') base.opacity = clamp01(clip.opacity);
  if (typeof clip.rotation === 'number') base.rotation = clip.rotation;
  return base;
}

/**
 * Compute, for a `duck` voiceover clip, the absolute frame window it occupies —
 * every OTHER audio clip overlapping this window gets attenuated. Uses the
 * clip's on-timeline span (`start`..`start+duration`), matching how the preview
 * ducks (a clip ducks while it plays).
 */
interface DuckWindow {
  fromFrame: number;
  toFrame: number;
}

/**
 * Lower ONE clip. Non-audio clips ignore the duck windows; audio clips receive
 * the pre-computed windows of every duck voiceover so they can carry their own
 * `duckedByFrames` (intersected with their own span) — the worker then never
 * cross-references clips.
 */
function lowerClip(
  clip: VdzClip,
  fps: number,
  map: Record<string, string> | undefined,
  unresolved: Set<string>,
  duckWindows: DuckWindow[],
  win?: { start: number; end: number }
): VdzManifestClip | null {
  const base = lowerBase(clip, fps, win);
  switch (clip.type) {
    case 'video':
      return {
        ...base,
        type: 'video',
        src: resolveSrc(clip.src, map, unresolved),
        trimStartInFrames: toFrames(clip.trimStart ?? 0, fps),
        volume: typeof clip.volume === 'number' ? clamp01(clip.volume) : 1,
      };
    case 'audio': {
      const from = base.fromFrame;
      const to = base.fromFrame + base.durationInFrames;
      // Intersect this clip's span with every duck voiceover's window (the
      // caller already excludes this clip's own window from `duckWindows`, so a
      // voiceover never ducks itself).
      const duckedByFrames = duckWindows
        .map(w => ({
          fromFrame: Math.max(from, w.fromFrame),
          toFrame: Math.min(to, w.toFrame),
        }))
        .filter(w => w.toFrame > w.fromFrame);
      return {
        ...base,
        type: 'audio',
        src: resolveSrc(clip.src, map, unresolved),
        volume: typeof clip.volume === 'number' ? clamp01(clip.volume) : 1,
        fadeInFrames: toFrames(clip.fadeIn ?? 0, fps),
        fadeOutFrames: toFrames(clip.fadeOut ?? 0, fps),
        duck: clip.duck === true,
        duckedByFrames,
      };
    }
    case 'image':
      return {
        ...base,
        type: 'image',
        src: resolveSrc(clip.src, map, unresolved),
        fit: clip.fit ?? 'cover',
      };
    case 'text':
      return {
        ...base,
        type: 'text',
        text: clip.text,
        fontSize: clip.fontSize ?? 0.08,
        color: clip.color ?? '#ffffff',
        x: clip.x ?? 0.5,
        // Resolve the vertical anchor through the SAME helper the preview and
        // the HTML compiler use, so an explicit `y` or a `capPosition` third
        // both land identically. `capPosition` is echoed for reference only.
        y: captionAnchorY({
          y: clip.y,
          capPosition: clip.capPosition,
        }),
        align: clip.align ?? 'center',
        capPreset: clip.capPreset ?? 'plain',
        ...(clip.capPosition ? { capPosition: clip.capPosition } : {}),
        // Rebase per-word timings from clip-relative SECONDS into clip-relative
        // FRAMES; a word ending before it starts is kept (harmless — it just
        // never becomes active), mirroring the schema/preview tolerance.
        words: (clip.words ?? []).map(word => ({
          w: word.w,
          fromFrame: toFrames(word.t0, fps),
          toFrame: toFrames(word.t1, fps),
        })),
      };
    case 'shape':
      return {
        ...base,
        type: 'shape',
        shape: clip.shape,
        color: clip.color ?? '#5b8cff',
        x: clip.x ?? 0,
        y: clip.y ?? 0,
        w: clip.w ?? 1,
        h: clip.h ?? 1,
      };
    default: {
      // Exhaustiveness guard (mirrors anim.ts): a new clip type without a case
      // here is a compile error rather than a silent drop.
      const _never: never = clip;
      return _never;
    }
  }
}

/**
 * Lower a track's transitions into the frame domain. The boundary frame is the
 * END of the clip named by `afterClipId` (= the start of the next clip when they
 * abut), matching `anim.ts` which centers the window on that boundary. A
 * transition whose `afterClipId` is unknown (or which doesn't abut the next
 * clip) is dropped — it would never fire in the preview either.
 */
function lowerTransitions(
  track: VdzTrack,
  fps: number
): VdzManifestTransition[] {
  const transitions = track.transitions ?? [];
  if (transitions.length === 0) return [];
  const byId = new Map(track.clips.map((c, i) => [c.id, i] as const));
  const out: VdzManifestTransition[] = [];
  for (const tr of transitions) {
    const idx = byId.get(tr.afterClipId);
    if (idx === undefined) continue;
    const clip = track.clips[idx];
    const next = track.clips[idx + 1];
    const boundarySeconds = clip.start + clip.duration;
    // Only a REAL crossfade (the next clip abuts) mirrors the preview; a
    // transition over a gap is inert there, so we drop it here too.
    if (!next || Math.abs(boundarySeconds - next.start) >= 1e-6) continue;
    out.push({
      id: tr.id,
      kind: tr.kind,
      afterClipId: tr.afterClipId,
      durationInFrames: Math.max(1, toFrames(tr.duration, fps)),
      boundaryInFrames: toFrames(boundarySeconds, fps),
    });
  }
  return out;
}

/**
 * Build a deterministic, self-contained {@link VdzRenderManifest} from a
 * {@link VdzTimeline}. PURE — depends only on `timeline` + `options`; no DOM,
 * no clock, no network, no new dependency. See the file header for the contract.
 */
export function buildRenderManifest(
  timeline: VdzTimeline,
  options: BuildRenderManifestOptions = {}
): VdzRenderManifest {
  const fps = timeline.fps || 30;
  const width = timeline.width || 1920;
  const height = timeline.height || 1080;
  const map = options.resolveSrc;
  const unresolved = new Set<string>();

  // First pass: collect the absolute frame window of every DUCK voiceover across
  // the whole timeline (any audio clip flagged `duck`), so a music clip on a
  // different track can carry the windows during which it must dip. We exclude a
  // duck clip's OWN window from the list it later intersects (a voiceover does
  // not duck itself).
  const duckClips: Array<{ id: string; from: number; to: number }> = [];
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.type === 'audio' && clip.duck === true) {
        const from = toFrames(clip.start, fps);
        const to = from + Math.max(1, toFrames(clip.duration, fps));
        duckClips.push({ id: clip.id, from, to });
      }
    }
  }

  const tracks: VdzManifestTrack[] = timeline.tracks.map((track, trackIndex) => {
    const manifestClips: VdzManifestClip[] = [];
    // Transition-extended windows mirror the preview, which composes ONLY visual
    // tracks — so we resolve a window for non-audio tracks and leave audio clips
    // without one (they carry no crossfade tail).
    const isVisualTrack = track.kind !== 'audio';
    track.clips.forEach((clip, clipIndex) => {
      // For an audio clip, the duck windows it can be affected by are every
      // duck voiceover EXCEPT itself.
      const duckWindows: DuckWindow[] =
        clip.type === 'audio'
          ? duckClips
              .filter(d => d.id !== clip.id)
              .map(d => ({ fromFrame: d.from, toFrame: d.to }))
          : [];
      const win =
        isVisualTrack && clip.type !== 'audio'
          ? extendedWindow(track, clip, clipIndex)
          : undefined;
      const lowered = lowerClip(clip, fps, map, unresolved, duckWindows, win);
      if (lowered) manifestClips.push(lowered);
    });
    return {
      id: track.id,
      kind: track.kind,
      ...(typeof track.name === 'string' ? { name: track.name } : {}),
      zIndex: trackIndex + 1,
      clips: manifestClips,
      transitions: lowerTransitions(track, fps),
    };
  });

  // C1 + C3: the canonical whole-timeline duration (max clip end over ALL tracks,
  // floored at 1s), converted to frames with CEIL (never drop a fractional last
  // frame), floored at a minimum of 1 (Remotion rejects a zero-frame comp). A
  // tiny epsilon absorbs float noise so an exact boundary doesn't ceil up a whole
  // spurious frame (e.g. 3.0s @ 30fps → 90, not 91).
  const durationInSeconds = computeExportDurationSec(timeline);
  const durationInFrames = Math.max(
    1,
    Math.ceil(durationInSeconds * fps - 1e-6)
  );

  return {
    version: VDZ_RENDER_MANIFEST_VERSION,
    id: timeline.id,
    name: timeline.name,
    fps,
    width,
    height,
    durationInFrames,
    durationInSeconds,
    tracks,
    unresolved: [...unresolved],
  };
}
