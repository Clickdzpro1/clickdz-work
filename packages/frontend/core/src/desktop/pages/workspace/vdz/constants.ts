import type { VdzClip, VdzTimeline } from '../../../../modules/vdz';

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
