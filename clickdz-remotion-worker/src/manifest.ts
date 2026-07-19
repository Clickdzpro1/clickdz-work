/**
 * clickdz-remotion-worker — the render-manifest type + a dependency-free
 * validator.
 *
 * This MIRRORS the app's `VdzRenderManifest` (built by
 * `packages/frontend/core/src/modules/vdz/remotion/render-manifest.ts`). The
 * worker is a standalone Railway service that cannot import from the app, so the
 * shape is re-declared here. It MUST stay in sync with the builder — both carry
 * `version: 1`; bump both together on any breaking change.
 *
 * A manifest is pure resolved DATA: frame-domain timings, resolved media urls,
 * resolved caption anchors, per-word karaoke frames, and a full audio mix. The
 * worker maps it 1:1 onto a Remotion composition (see VideoComposition.tsx).
 */

export type ManifestAnimationKind =
  | 'fade'
  | 'slide-up'
  | 'slide-down'
  | 'slide-left'
  | 'slide-right'
  | 'zoom-in'
  | 'zoom-out'
  | 'pop';

export type ManifestEffectKind =
  | 'blur'
  | 'brightness'
  | 'contrast'
  | 'saturate'
  | 'grayscale'
  | 'sepia'
  | 'glow'
  | 'vignette';

export type ManifestTransitionKind =
  | 'fade'
  | 'slide'
  | 'wipe'
  | 'dissolve'
  | 'push'
  | 'iris';

export type ManifestCaptionPreset =
  | 'plain'
  | 'boxed'
  | 'outline'
  | 'shadow'
  | 'pill'
  | 'karaoke';

export interface ManifestEffect {
  kind: ManifestEffectKind;
  amount: number;
}

export interface ManifestAnimation {
  kind: ManifestAnimationKind;
  durationInFrames: number;
}

export interface ManifestWord {
  w: string;
  fromFrame: number;
  toFrame: number;
}

export interface ManifestClipBase {
  id: string;
  name?: string;
  /** Clip start on the track, in FRAMES (the clip's TRUE window start). */
  fromFrame: number;
  /** Clip length, in FRAMES (the clip's TRUE window length; >= 1). */
  durationInFrames: number;
  /**
   * C3 — OPTIONAL transition-extended RENDER window, in SECONDS (matching the
   * preview's `anim.ts` `clipWindow`: a clip's tail extends by half an abutting
   * transition's duration). When present, the worker uses these for the
   * <Sequence> mount bounds (converted to frames via `manifest.fps`) so an
   * OUTGOING clip stays mounted through the after-boundary half of its crossfade
   * — the per-frame anim/transition math still uses the TRUE `fromFrame` /
   * `durationInFrames` window, so curves stay centered. Absent → the <Sequence>
   * falls back to `fromFrame` / `durationInFrames` (old behavior). Both optional
   * so the CURRENT prod app (which never sends them) renders unchanged.
   */
  renderStartSec?: number;
  renderDurationSec?: number;
  animation?: { in?: ManifestAnimation; out?: ManifestAnimation };
  effects?: ManifestEffect[];
  opacity?: number;
  rotation?: number;
}

export interface ManifestVideoClip extends ManifestClipBase {
  type: 'video';
  src: string;
  trimStartInFrames: number;
  volume: number;
}

export interface ManifestAudioClip extends ManifestClipBase {
  type: 'audio';
  src: string;
  volume: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  duck: boolean;
  duckedByFrames: Array<{ fromFrame: number; toFrame: number }>;
}

export interface ManifestImageClip extends ManifestClipBase {
  type: 'image';
  src: string;
  fit: 'cover' | 'contain';
}

export interface ManifestTextClip extends ManifestClipBase {
  type: 'text';
  text: string;
  fontSize: number;
  color: string;
  x: number;
  y: number;
  align: 'left' | 'center' | 'right';
  capPreset: ManifestCaptionPreset;
  capPosition?: 'top' | 'middle' | 'lower';
  words: ManifestWord[];
}

export interface ManifestShapeClip extends ManifestClipBase {
  type: 'shape';
  shape: 'rect' | 'circle';
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ManifestClip =
  | ManifestVideoClip
  | ManifestAudioClip
  | ManifestImageClip
  | ManifestTextClip
  | ManifestShapeClip;

export interface ManifestTransition {
  id: string;
  kind: ManifestTransitionKind;
  afterClipId: string;
  durationInFrames: number;
  boundaryInFrames: number;
}

export interface ManifestTrack {
  id: string;
  kind: 'video' | 'audio' | 'overlay';
  name?: string;
  zIndex: number;
  clips: ManifestClip[];
  transitions: ManifestTransition[];
}

export interface RenderManifest {
  version: 1;
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  durationInSeconds: number;
  tracks: ManifestTrack[];
  unresolved: string[];
}

/**
 * Validate an untrusted body into a RenderManifest, throwing a descriptive
 * Error on the first problem. Dependency-free (no zod) so the worker needs no
 * extra package. Only the load-bearing fields are hard-checked; optional fields
 * are defaulted defensively by the composition, not here.
 */
export function parseManifest(input: unknown): RenderManifest {
  if (!input || typeof input !== 'object') {
    throw new Error('manifest must be an object');
  }
  const m = input as Record<string, unknown>;
  if (m.version !== 1) {
    throw new Error(`unsupported manifest version: ${String(m.version)}`);
  }
  const fps = Number(m.fps);
  const width = Number(m.width);
  const height = Number(m.height);
  const durationInFrames = Number(m.durationInFrames);
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps must be positive');
  if (!Number.isFinite(width) || width <= 0) throw new Error('width must be positive');
  if (!Number.isFinite(height) || height <= 0) throw new Error('height must be positive');
  if (!Number.isFinite(durationInFrames) || durationInFrames < 1) {
    throw new Error('durationInFrames must be >= 1');
  }
  if (!Array.isArray(m.tracks)) throw new Error('tracks must be an array');
  if (m.tracks.length === 0) throw new Error('manifest has no tracks');

  // Shallow structural check on each track/clip so a malformed payload fails
  // fast with a clear message instead of deep inside the renderer.
  for (const t of m.tracks as unknown[]) {
    if (!t || typeof t !== 'object') throw new Error('each track must be an object');
    const track = t as Record<string, unknown>;
    if (!Array.isArray(track.clips)) throw new Error('track.clips must be an array');
    for (const c of track.clips as unknown[]) {
      if (!c || typeof c !== 'object') throw new Error('each clip must be an object');
      const clip = c as Record<string, unknown>;
      if (typeof clip.type !== 'string') throw new Error('clip.type is required');
      if (!Number.isFinite(Number(clip.fromFrame))) {
        throw new Error('clip.fromFrame must be a number');
      }
      if (!Number.isFinite(Number(clip.durationInFrames))) {
        throw new Error('clip.durationInFrames must be a number');
      }
      // C3: the render-window fields are OPTIONAL — but if present they must be
      // finite (a NaN would poison the <Sequence> bounds). Absent → ignored.
      if (
        clip.renderStartSec !== undefined &&
        !Number.isFinite(Number(clip.renderStartSec))
      ) {
        throw new Error('clip.renderStartSec must be a number when present');
      }
      if (
        clip.renderDurationSec !== undefined &&
        !Number.isFinite(Number(clip.renderDurationSec))
      ) {
        throw new Error('clip.renderDurationSec must be a number when present');
      }
    }
    if (track.transitions !== undefined && !Array.isArray(track.transitions)) {
      throw new Error('track.transitions must be an array when present');
    }
  }

  // The shape is validated; trust the builder for the rest of the typed fields.
  return input as RenderManifest;
}
