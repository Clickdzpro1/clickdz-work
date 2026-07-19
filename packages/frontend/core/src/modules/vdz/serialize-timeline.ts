import type { VdzTimeline } from './schema';

/**
 * Vdz Studio — compact timeline serializer for the AI editor.
 *
 * The chat model already receives the FULL `VdzTimeline` JSON (every clip field:
 * colors, fontSize, src, effects, animation) for op detail. What it lacks is a
 * sense of WHERE the user is and WHAT things mean in time: the playhead, the
 * current frame/timecode, the overall duration, and a clip-by-clip map it can
 * target by id. This module builds that map — a small, deterministic JSON
 * addendum — so a request like "cut the intro at the playhead" or "make the
 * second clip 2s shorter" resolves to correct op arguments.
 *
 * Design:
 *  • PURE + synchronous + defensive: reads through optional fields, never
 *    assumes a track/clip exists, and never throws on a malformed input.
 *  • Deterministic KEY ORDER (canvas → fps → durationSec → tracks → playhead →
 *    selectedClipId) and stable clip-field order, so the same timeline always
 *    serializes to the same string (good for caching + reproducible prompts).
 *  • Numbers rounded to 2 decimal places (time is seconds; the model does not
 *    need sub-centisecond precision to compute op args).
 *  • Bounded: the result is kept at/under {@link MAX_AI_CONTEXT_CHARS} by
 *    progressively shortening labels then capping the clip count with an honest
 *    `omittedClips` marker — it NEVER emits invalid JSON.
 *
 * Intentionally NOT a substitute for the full timeline — it is a navigation aid
 * that the prompt teaches the model to read alongside the full document.
 */

/** Soft ceiling on the serialized context string (~2.5 KB). */
export const MAX_AI_CONTEXT_CHARS = 2500;

/** Longest a clip label is allowed to be, before truncation with an ellipsis. */
const LABEL_MAX = 40;

/** Shorter label budget used only when the full context overruns the cap. */
const LABEL_MAX_TIGHT = 20;

/** Options that describe the live editing session at send time. */
export interface SerializeTimelineOpts {
  /** Current playhead position in seconds (the scrub head). Omit if unknown. */
  playheadSec?: number;
  /** The sole-selected clip id, if the user has exactly one clip selected. */
  selectedClipId?: string;
}

/** One clip in the compact map: enough to target + reason about it, no more. */
interface CompactClip {
  id: string;
  kind: string;
  start: number;
  dur: number;
  label: string;
  /** Present + true only for a caption clip carrying karaoke word timings. */
  hasWords?: boolean;
}

/** One track in the compact map. */
interface CompactTrack {
  kind: string;
  clips: CompactClip[];
}

/** The compact context object (serialized to the string this module returns). */
interface CompactContext {
  canvas: { w: number; h: number };
  fps: number;
  durationSec: number;
  tracks: CompactTrack[];
  playhead?: { sec: number; frame: number; timecode: string };
  selectedClipId?: string;
  /** Set only when clips were dropped to fit the size cap (honest signal). */
  omittedClips?: number;
}

/** Round to 2 decimal places, coercing a non-finite value to 0. */
function round2(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.round(v * 100) / 100;
}

/** Truncate a label to `max` chars, appending "…" when it was cut. */
function truncateLabel(value: string, max: number): string {
  const s = value.trim();
  if (s.length <= max) return s;
  // Reserve one char for the ellipsis so the visible budget is respected.
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * A human label for a clip, by type: video/image/audio → `name`; text →
 * `name` or its rendered `text`; shape → `name` or the shape kind. Falls back
 * to the clip `type` so a label is never empty. Truncated to `max` chars.
 */
function clipLabel(clip: Record<string, unknown>, max: number): string {
  const type = typeof clip.type === 'string' ? clip.type : 'clip';
  const name = typeof clip.name === 'string' ? clip.name.trim() : '';
  if (name) return truncateLabel(name, max);
  if (type === 'text' && typeof clip.text === 'string' && clip.text.trim()) {
    return truncateLabel(clip.text, max);
  }
  if (type === 'shape' && typeof clip.shape === 'string') {
    return truncateLabel(clip.shape, max);
  }
  return truncateLabel(type, max);
}

/**
 * The C1 duration rule (implemented locally, per contract — NOT imported):
 * `max over ALL clips on ALL tracks of (start + duration)`, floored at 1, with
 * NO transition extension. Deterministic and defensive on a malformed timeline.
 */
function durationSecC1(timeline: VdzTimeline): number {
  let max = 0;
  const tracks = Array.isArray(timeline?.tracks) ? timeline.tracks : [];
  for (const track of tracks) {
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    for (const clip of clips) {
      const start = typeof clip?.start === 'number' ? clip.start : 0;
      const dur = typeof clip?.duration === 'number' ? clip.duration : 0;
      const end = start + dur;
      if (Number.isFinite(end) && end > max) max = end;
    }
  }
  return Math.max(1, max);
}

/**
 * Absolute frame index for a seconds value at a given fps: `round(sec × fps)`.
 * Exported so the dock's context strip shows the SAME frame the AI is told.
 */
export function playheadFrame(seconds: number, fps: number): number {
  const clampedFps = fps > 0 ? fps : 30;
  const clamped = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  return Math.round(clamped * clampedFps);
}

/**
 * Format `mm:ss.ff` where `ff` is the FRAME within the current second (0-padded
 * to 2 digits). `ff = round(fractionalSeconds × fps)`, clamped so a value that
 * rounds up to a full second carries into the seconds field cleanly. Negative
 * input clamps to zero. Exported so the dock's context strip renders the SAME
 * timecode the AI receives (one source of truth for the format).
 */
export function formatTimecodeFrames(seconds: number, fps: number): string {
  const clampedFps = fps > 0 ? fps : 30;
  const clamped = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalFrames = Math.round(clamped * clampedFps);
  const wholeFps = Math.max(1, Math.round(clampedFps));
  const frame = totalFrames % wholeFps;
  const totalSecs = Math.floor(totalFrames / wholeFps);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return (
    `${String(mins).padStart(2, '0')}:` +
    `${String(secs).padStart(2, '0')}.` +
    `${String(frame).padStart(2, '0')}`
  );
}

/** Build the {@link CompactTrack[]} for a timeline using a given label budget. */
function buildTracks(
  timeline: VdzTimeline,
  labelMax: number,
  clipCap: number
): { tracks: CompactTrack[]; omitted: number } {
  const rawTracks = Array.isArray(timeline?.tracks) ? timeline.tracks : [];
  const tracks: CompactTrack[] = [];
  let emitted = 0;
  let omitted = 0;
  for (const track of rawTracks) {
    const kind = typeof track?.kind === 'string' ? track.kind : 'video';
    const rawClips = Array.isArray(track?.clips) ? track.clips : [];
    const clips: CompactClip[] = [];
    for (const c of rawClips as Record<string, unknown>[]) {
      if (emitted >= clipCap) {
        omitted += 1;
        continue;
      }
      const clip: CompactClip = {
        id: typeof c.id === 'string' ? c.id : '',
        kind: typeof c.type === 'string' ? c.type : 'clip',
        start: round2(c.start),
        dur: round2(c.duration),
        label: clipLabel(c, labelMax),
      };
      if (
        c.type === 'text' &&
        Array.isArray((c as { words?: unknown[] }).words) &&
        (c as { words: unknown[] }).words.length > 0
      ) {
        clip.hasWords = true;
      }
      clips.push(clip);
      emitted += 1;
    }
    tracks.push({ kind, clips });
  }
  return { tracks, omitted };
}

/**
 * Assemble the compact context object with the ordered keys the prompt expects.
 * `omittedClips` is appended last only when clips were dropped.
 */
function assemble(
  timeline: VdzTimeline,
  opts: SerializeTimelineOpts,
  labelMax: number,
  clipCap: number
): CompactContext {
  const w =
    typeof timeline?.width === 'number' && timeline.width > 0
      ? Math.round(timeline.width)
      : 1920;
  const h =
    typeof timeline?.height === 'number' && timeline.height > 0
      ? Math.round(timeline.height)
      : 1080;
  const fps =
    typeof timeline?.fps === 'number' && timeline.fps > 0 ? timeline.fps : 30;

  const { tracks, omitted } = buildTracks(timeline, labelMax, clipCap);

  // Ordered explicitly (not via object-literal insertion alone) so the emitted
  // JSON key order is deterministic and matches what the prompt documents.
  const ctx: CompactContext = {
    canvas: { w, h },
    fps: round2(fps),
    durationSec: round2(durationSecC1(timeline)),
    tracks,
  };

  if (typeof opts?.playheadSec === 'number' && Number.isFinite(opts.playheadSec)) {
    const sec = Math.max(0, opts.playheadSec);
    ctx.playhead = {
      sec: round2(sec),
      frame: playheadFrame(sec, fps),
      timecode: formatTimecodeFrames(sec, fps),
    };
  }

  if (typeof opts?.selectedClipId === 'string' && opts.selectedClipId) {
    ctx.selectedClipId = opts.selectedClipId;
  }

  if (omitted > 0) ctx.omittedClips = omitted;

  return ctx;
}

/**
 * Serialize the timeline into the compact, playhead-aware context STRING the AI
 * dock sends alongside the full timeline. Deterministic, ≤ ~2500 chars, and
 * graceful on an empty or malformed timeline.
 *
 * The output is a single-line JSON string shaped like:
 * ```
 * {"canvas":{"w":1920,"h":1080},"fps":30,"durationSec":12.5,
 *  "tracks":[{"kind":"video","clips":[{"id":"clip-bg-1","kind":"video",
 *  "start":0,"dur":6,"label":"Intro"}]}],
 *  "playhead":{"sec":2.5,"frame":75,"timecode":"00:02.15"},
 *  "selectedClipId":"clip-bg-1"}
 * ```
 * `playhead` is present only when {@link SerializeTimelineOpts.playheadSec} is
 * given; `selectedClipId` only when one clip is selected.
 */
export function serializeTimelineForAI(
  timeline: VdzTimeline,
  opts: SerializeTimelineOpts = {}
): string {
  // First pass at full fidelity.
  let ctx = assemble(timeline, opts, LABEL_MAX, Number.POSITIVE_INFINITY);
  let json = JSON.stringify(ctx);
  if (json.length <= MAX_AI_CONTEXT_CHARS) return json;

  // Over cap: shorten every label first (cheap, preserves all clips).
  ctx = assemble(timeline, opts, LABEL_MAX_TIGHT, Number.POSITIVE_INFINITY);
  json = JSON.stringify(ctx);
  if (json.length <= MAX_AI_CONTEXT_CHARS) return json;

  // Still over: cap the clip count, shedding the tail deterministically and
  // recording how many were dropped. Binary-ish search for the largest cap that
  // fits, so we keep as many clips as the budget allows.
  let lo = 0;
  let hi = countClips(timeline);
  let best = JSON.stringify(assemble(timeline, opts, LABEL_MAX_TIGHT, 0));
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = JSON.stringify(
      assemble(timeline, opts, LABEL_MAX_TIGHT, mid)
    );
    if (candidate.length <= MAX_AI_CONTEXT_CHARS) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Total clip count across every track (defensive). */
function countClips(timeline: VdzTimeline): number {
  const tracks = Array.isArray(timeline?.tracks) ? timeline.tracks : [];
  let n = 0;
  for (const t of tracks) {
    if (Array.isArray(t?.clips)) n += t.clips.length;
  }
  return n;
}
