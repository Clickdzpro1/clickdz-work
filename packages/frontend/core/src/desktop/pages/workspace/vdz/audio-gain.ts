import type { VdzAudioClip, VdzTimeline } from '../../../../modules/vdz';

/**
 * Pure gain math for Vdz preview audio: per-clip fade in/out ramps and
 * auto-ducking of other audio under `duck` clips (the voiceover-over-music
 * pattern). No WebAudio node graph on purpose: routing the shared `<audio>`
 * element pool through MediaElementSource silences cross-origin sources, so
 * the playback layer applies these gains to `element.volume` every playhead
 * tick (rAF cadence — perceptually smooth for fades/ducks) instead. The math
 * lives here, React-free and node-tested, and can later feed a real WebAudio
 * (or Remotion export) graph unchanged.
 */

/** Gain other audio dips to while a `duck` clip plays. */
export const DUCK_GAIN = 0.3;
/** Attack/release ramp for the duck dip, in seconds. */
export const DUCK_RAMP = 0.15;

/** A merged half-open interval [start, end) where ducking is active. */
export interface DuckWindow {
  start: number;
  end: number;
}

/** Clamp to the unit interval. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Fade envelope of a clip at absolute time `t`: 0 outside the clip, ramping
 * 0→1 over `fadeIn` from its start and 1→0 over `fadeOut` into its end.
 * Fades longer than the clip are clamped to its duration; when in+out overlap
 * (their sum exceeds the duration) the envelope is the MIN of both ramps, so
 * short clips still peak mid-way and never pop.
 */
export function fadeGainAt(
  clip: Pick<VdzAudioClip, 'start' | 'duration' | 'fadeIn' | 'fadeOut'>,
  t: number
): number {
  const end = clip.start + clip.duration;
  if (t < clip.start || t >= end) return 0;
  const fadeIn = Math.min(clip.fadeIn ?? 0, clip.duration);
  const fadeOut = Math.min(clip.fadeOut ?? 0, clip.duration);
  const inGain = fadeIn > 0 ? clamp01((t - clip.start) / fadeIn) : 1;
  const outGain = fadeOut > 0 ? clamp01((end - t) / fadeOut) : 1;
  return Math.min(inGain, outGain);
}

/**
 * The merged time windows during which ducking is active: the union of every
 * `duck` audio clip's [start, end) across all audio tracks, sorted and merged
 * so overlapping voiceovers form one window (ramps only at the true edges).
 */
export function duckWindows(timeline: VdzTimeline): DuckWindow[] {
  const raw: DuckWindow[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== 'audio') continue;
    for (const clip of track.clips) {
      if (clip.type === 'audio' && clip.duck) {
        raw.push({ start: clip.start, end: clip.start + clip.duration });
      }
    }
  }
  if (raw.length <= 1) return raw;
  raw.sort((a, b) => a.start - b.start);
  const merged: DuckWindow[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1];
    if (raw[i].start <= last.end) {
      last.end = Math.max(last.end, raw[i].end);
    } else {
      merged.push(raw[i]);
    }
  }
  return merged;
}

/**
 * Duck multiplier for NON-duck audio at time `t`: 1 outside every window,
 * DUCK_GAIN inside, with linear attack/release ramps of DUCK_RAMP at each
 * window edge (shrunk to half the window for very short windows, so a brief
 * voice line still dips and recovers cleanly).
 */
export function duckGainAt(windows: DuckWindow[], t: number): number {
  let gain = 1;
  for (const w of windows) {
    const ramp = Math.min(DUCK_RAMP, (w.end - w.start) / 2);
    let g = 1;
    if (t >= w.start && t < w.end) {
      // Inside: dip, ramping down after start and back up into the end.
      const down =
        ramp > 0 ? clamp01((t - w.start) / ramp) : 1;
      const up = ramp > 0 ? clamp01((w.end - t) / ramp) : 1;
      const dipDepth = Math.min(down, up);
      g = 1 - dipDepth * (1 - DUCK_GAIN);
    }
    // Multiple windows: the deepest dip wins (windows are merged, but keep
    // this associative for safety).
    gain = Math.min(gain, g);
  }
  return gain;
}

export interface ClipGainInput {
  clip: VdzAudioClip;
  /** Absolute playhead time, seconds. */
  t: number;
  /** Precomputed via {@link duckWindows} (memoize per timeline). */
  windows: DuckWindow[];
}

/**
 * The effective playback volume for an audio clip at time `t`:
 * base volume × fade envelope × duck multiplier (duck clips are never ducked
 * by their own window). Clamped to 0..1 — feed directly to `element.volume`.
 */
export function computeAudioClipGain({ clip, t, windows }: ClipGainInput): number {
  const base = clip.volume ?? 1;
  const fade = fadeGainAt(clip, t);
  const duckFactor = clip.duck ? 1 : duckGainAt(windows, t);
  return clamp01(base * fade * duckFactor);
}
