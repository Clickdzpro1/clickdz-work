import { nanoid } from 'nanoid';

import type { VdzClip, VdzTimeline } from '../../../../modules/vdz';
import type {
  VdzMediaItem,
  VdzMediaKind,
} from '../../../../modules/vdz/use-vdz-media';

/** Lane accent colors keyed by track kind. */
export const TRACK_COLORS: Record<
  VdzTimeline['tracks'][number]['kind'],
  string
> = {
  video: '#5b8cff',
  overlay: '#a06bff',
  audio: '#3fb7a6',
};

/** Zoom bounds, in pixels per second of timeline. */
export const MIN_PX_PER_SEC = 20;
export const MAX_PX_PER_SEC = 300;
export const DEFAULT_PX_PER_SEC = 80;

/** Left gutter reserved for the fixed-width lane labels, in px. */
export const LANE_LABEL_WIDTH = 64;

/** Snap threshold in screen pixels (converted to seconds at current zoom). */
export const SNAP_PX = 8;

/** Clips may never be shorter than this, in seconds. */
export const MIN_CLIP_DURATION = 0.2;

/** Width of the edge hot-zone for trim handles, in px. */
export const TRIM_HANDLE_PX = 6;

/** History ring capacity — how many timeline snapshots we retain. */
export const HISTORY_CAP = 50;

/** Clamp a zoom value into the allowed pixels-per-second range. */
export function clampZoom(pxPerSec: number): number {
  return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, pxPerSec));
}

/** `mm:ss.d` timecode for a seconds value (negative clamps to zero). */
export function formatTimecode(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const mins = Math.floor(clamped / 60);
  const secs = Math.floor(clamped % 60);
  const frac = Math.floor((clamped - Math.floor(clamped)) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${frac}`;
}

/** Is a clip active (visible) at the given playhead time, in seconds? */
export function isClipActive(clip: VdzClip, seconds: number): boolean {
  return seconds >= clip.start && seconds < clip.start + clip.duration;
}

/** Locate a clip anywhere in the timeline by id. */
export function findClip(
  timeline: VdzTimeline,
  clipId: string | null
): { clip: VdzClip; trackId: string } | null {
  if (!clipId) return null;
  for (const track of timeline.tracks) {
    const clip = track.clips.find(c => c.id === clipId);
    if (clip) return { clip, trackId: track.id };
  }
  return null;
}

// ---- Media bin drag-and-drop --------------------------------------------

/**
 * Custom drag MIME the media bin writes and the timeline reads. A bin item is
 * serialized to JSON on `dragstart`; a lane deserializes it on `drop` and turns
 * it into an `addClip` op. Using a namespaced type keeps our payload from
 * clashing with generic text/file drops.
 */
export const VDZ_MEDIA_DND_MIME = 'application/x-vdz-media';

/** The subset of a media item carried across a drag (must be JSON-serializable). */
export interface VdzMediaDragPayload {
  kind: VdzMediaKind;
  name: string;
  url: string;
  duration: number;
  blobId?: string;
  mime?: string;
}

/** Default on-timeline length (seconds) for media with no intrinsic duration. */
export const DEFAULT_IMAGE_CLIP_DURATION = 4;
/** Fallback length (seconds) when a video/audio probe returned 0. */
export const DEFAULT_AV_CLIP_DURATION = 5;

/** The track kind a media kind lands on when added to the timeline. */
export function trackKindForMedia(
  kind: VdzMediaKind
): VdzTimeline['tracks'][number]['kind'] {
  if (kind === 'audio') return 'audio';
  // Video AND image both live on the video track by default; images may also
  // be dropped onto an overlay lane explicitly (the drop target decides).
  return 'video';
}

/**
 * Build a validated-shape {@link VdzClip} from a media payload at a given start.
 * The caller still routes it through the single `applyOp` path (which
 * re-validates), so this only needs to produce the right discriminated shape.
 */
export function clipFromMedia(
  media: VdzMediaDragPayload | VdzMediaItem,
  startSeconds: number
): VdzClip {
  const id = `clip-${nanoid(6)}`;
  const start = Math.max(0, Math.round(startSeconds * 1000) / 1000);
  const name = media.name || media.kind;
  if (media.kind === 'audio') {
    return {
      id,
      type: 'audio',
      name,
      start,
      duration: media.duration > 0 ? media.duration : DEFAULT_AV_CLIP_DURATION,
      src: media.url,
      volume: 1,
    };
  }
  if (media.kind === 'video') {
    return {
      id,
      type: 'video',
      name,
      start,
      duration: media.duration > 0 ? media.duration : DEFAULT_AV_CLIP_DURATION,
      src: media.url,
      trimStart: 0,
      volume: 1,
    };
  }
  // image
  return {
    id,
    type: 'image',
    name,
    start,
    duration: DEFAULT_IMAGE_CLIP_DURATION,
    src: media.url,
    fit: 'cover',
  };
}
