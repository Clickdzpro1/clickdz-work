import { nanoid } from 'nanoid';
import { z } from 'zod';

import {
  vdzAnimationSchema,
  vdzClipSchema,
  vdzEffectSchema,
  type VdzTimeline,
  vdzTimelineSchema,
  vdzTrackSchema,
  vdzTransitionSchema,
} from './schema';

/**
 * Style fields an `updateClip` patch may set. This is a plain string→Zod map
 * so both the op schema (as an all-optional object) and the per-clip-type
 * validation (below) derive from the SAME source of truth. Positional/size and
 * time-independent presentational fields only — structural fields (id, type,
 * start, duration, animation, effects, transitions) have dedicated ops.
 */
const clipStylePatchShape = {
  // every clip type (display label in the lanes/inspector)
  name: z.string().min(1).max(200),
  // text
  text: z.string(),
  fontSize: z.number().positive(),
  align: z.enum(['left', 'center', 'right']),
  // text + shape
  color: z.string(),
  x: z.number(),
  y: z.number(),
  // shape
  w: z.number(),
  h: z.number(),
  // video + audio
  volume: z.number().min(0).max(1),
  // image
  fit: z.enum(['cover', 'contain']),
} as const;

/**
 * Which patch keys are legal per clip `type`. Guards `updateClip` so, e.g.,
 * `fontSize` can't be written onto a shape clip (which would then fail the
 * whole-timeline re-validation anyway, but this yields a precise error).
 */
const patchKeysByType: Record<string, ReadonlySet<string>> = {
  text: new Set(['name', 'text', 'fontSize', 'align', 'color', 'x', 'y']),
  shape: new Set(['name', 'color', 'x', 'y', 'w', 'h']),
  video: new Set(['name', 'volume']),
  audio: new Set(['name', 'volume']),
  image: new Set(['name', 'fit']),
};

/**
 * The Vdz edit contract.
 *
 * Every mutation to a {@link VdzTimeline} — whether it originates from the UI
 * or from the AI — is expressed as one or more `VdzOp`s and applied through
 * {@link applyOp} / {@link applyOps}. This keeps a single, validated path for
 * all edits: the AI's future output is just `VdzOp[]`.
 */
export const vdzOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('addTrack'),
    /**
     * A whole new track to append (its `clips` array is usually empty — clips
     * are added via `addClip`). Appended at the END of `tracks`; back-to-front
     * z-order still holds (video tracks draw under overlay tracks, audio is
     * never visual — see {@link ../../desktop/pages/workspace/vdz/anim.ts}).
     */
    track: vdzTrackSchema,
  }),
  z.object({
    op: z.literal('addClip'),
    trackId: z.string(),
    clip: vdzClipSchema,
  }),
  z.object({
    op: z.literal('removeClip'),
    trackId: z.string(),
    clipId: z.string(),
  }),
  z.object({
    op: z.literal('moveClip'),
    trackId: z.string(),
    clipId: z.string(),
    /** New start offset, in seconds. */
    start: z.number().min(0),
    /** Optional destination track to move the clip to. */
    toTrackId: z.string().optional(),
  }),
  z.object({
    op: z.literal('trimClip'),
    trackId: z.string(),
    clipId: z.string(),
    start: z.number().min(0).optional(),
    duration: z.number().positive().optional(),
    trimStart: z.number().min(0).optional(),
  }),
  z.object({
    op: z.literal('splitClip'),
    trackId: z.string(),
    clipId: z.string(),
    /** Cut point in seconds; must fall strictly inside the clip. */
    atSeconds: z.number(),
  }),
  z.object({
    op: z.literal('rippleDelete'),
    trackId: z.string(),
    clipId: z.string(),
  }),
  z.object({
    op: z.literal('nudgeClip'),
    trackId: z.string(),
    clipId: z.string(),
    /** Signed shift applied to `start`; clamped so start never goes below 0. */
    deltaSeconds: z.number(),
  }),
  z.object({
    op: z.literal('setText'),
    trackId: z.string(),
    clipId: z.string(),
    text: z.string(),
  }),
  z.object({
    op: z.literal('applyTransition'),
    trackId: z.string(),
    transition: vdzTransitionSchema,
  }),
  z.object({
    op: z.literal('removeTransition'),
    trackId: z.string(),
    transitionId: z.string(),
  }),
  z.object({
    op: z.literal('setAnimation'),
    trackId: z.string(),
    clipId: z.string(),
    /** New entrance/exit animation, or null to clear it entirely. */
    animation: vdzAnimationSchema.nullable(),
  }),
  z.object({
    op: z.literal('setEffects'),
    trackId: z.string(),
    clipId: z.string(),
    /** The full replacement effect stack (empty array clears effects). */
    effects: z.array(vdzEffectSchema),
  }),
  z.object({
    op: z.literal('updateClip'),
    trackId: z.string(),
    clipId: z.string(),
    /** Partial patch of style fields; keys are validated against clip type. */
    patch: z.object(clipStylePatchShape).partial(),
  }),
  z.object({
    op: z.literal('setAudioMix'),
    trackId: z.string(),
    clipId: z.string(),
    /**
     * Audio-mix fields (AUDIO clips only). Per field: omit = leave unchanged,
     * null = clear, value = set. Fades are seconds ramping from/to silence at
     * the clip edges; `duck: true` dips every OTHER audio clip while this one
     * plays (the voiceover-over-music pattern).
     */
    fadeIn: z.number().min(0).nullable().optional(),
    fadeOut: z.number().min(0).nullable().optional(),
    duck: z.boolean().nullable().optional(),
  }),
  z.object({
    op: z.literal('renameTimeline'),
    name: z.string(),
  }),
]);
export type VdzOp = z.infer<typeof vdzOpSchema>;

/** Result of applying an op: the (possibly unchanged) timeline plus an error. */
export interface VdzApplyResult {
  timeline: VdzTimeline;
  error?: string;
}

/** Deep clone via structured JSON. Timelines are plain JSON, so this is safe. */
function clone(timeline: VdzTimeline): VdzTimeline {
  return JSON.parse(JSON.stringify(timeline)) as VdzTimeline;
}

/**
 * Apply a single op to a timeline. Pure: never mutates `timeline`.
 *
 * On any validation failure — a malformed op, a missing track/clip, a wrong
 * clip type, or a resulting document that no longer satisfies
 * {@link vdzTimelineSchema} — the ORIGINAL timeline is returned untouched
 * alongside a human-readable `error` string.
 */
export function applyOp(timeline: VdzTimeline, op: VdzOp): VdzApplyResult {
  const parsedOp = vdzOpSchema.safeParse(op);
  if (!parsedOp.success) {
    return { timeline, error: `invalid op: ${parsedOp.error.message}` };
  }
  const validOp = parsedOp.data;

  // Work on a copy so the input is never mutated.
  const next = clone(timeline);

  const findTrack = (trackId: string) => {
    return next.tracks.find(track => track.id === trackId);
  };

  switch (validOp.op) {
    case 'addTrack': {
      // Reject a duplicate track id so the append is always unambiguous.
      if (next.tracks.some(track => track.id === validOp.track.id)) {
        return {
          timeline,
          error: `track id already exists: ${validOp.track.id}`,
        };
      }
      next.tracks.push(validOp.track);
      break;
    }
    case 'addClip': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      if (track.clips.some(clip => clip.id === validOp.clip.id)) {
        return {
          timeline,
          error: `clip id already exists in track: ${validOp.clip.id}`,
        };
      }
      track.clips.push(validOp.clip);
      break;
    }
    case 'removeClip': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      const index = track.clips.findIndex(clip => clip.id === validOp.clipId);
      if (index === -1) {
        return { timeline, error: `clip not found: ${validOp.clipId}` };
      }
      track.clips.splice(index, 1);
      break;
    }
    case 'moveClip': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      const index = track.clips.findIndex(clip => clip.id === validOp.clipId);
      if (index === -1) {
        return { timeline, error: `clip not found: ${validOp.clipId}` };
      }
      const clip = track.clips[index];
      clip.start = validOp.start;
      if (validOp.toTrackId && validOp.toTrackId !== validOp.trackId) {
        const dest = findTrack(validOp.toTrackId);
        if (!dest) {
          return {
            timeline,
            error: `destination track not found: ${validOp.toTrackId}`,
          };
        }
        if (dest.clips.some(existing => existing.id === clip.id)) {
          return {
            timeline,
            error: `clip id already exists in destination track: ${clip.id}`,
          };
        }
        track.clips.splice(index, 1);
        dest.clips.push(clip);
      }
      break;
    }
    case 'trimClip': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      const clip = track.clips.find(c => c.id === validOp.clipId);
      if (!clip) {
        return { timeline, error: `clip not found: ${validOp.clipId}` };
      }
      if (validOp.start !== undefined) {
        clip.start = validOp.start;
      }
      if (validOp.duration !== undefined) {
        clip.duration = validOp.duration;
      }
      if (validOp.trimStart !== undefined) {
        if (clip.type !== 'video') {
          return {
            timeline,
            error: `trimStart only applies to video clips: ${validOp.clipId}`,
          };
        }
        clip.trimStart = validOp.trimStart;
      }
      break;
    }
    case 'splitClip': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      const index = track.clips.findIndex(c => c.id === validOp.clipId);
      if (index === -1) {
        return { timeline, error: `clip not found: ${validOp.clipId}` };
      }
      const clip = track.clips[index];
      const end = clip.start + clip.duration;
      // Cut must land strictly inside the clip; touching an edge is a no-op cut.
      if (validOp.atSeconds <= clip.start || validOp.atSeconds >= end) {
        return {
          timeline,
          error: `split point ${validOp.atSeconds} not inside clip ${validOp.clipId} (${clip.start}..${end})`,
        };
      }
      const offset = validOp.atSeconds - clip.start;
      // Second part: deep copy preserves the discriminated-union shape.
      const second = JSON.parse(JSON.stringify(clip)) as typeof clip;
      second.id = `${clip.id}-b`;
      // Avoid an id clash if `<id>-b` already exists on this track.
      if (track.clips.some(c => c.id === second.id)) {
        second.id = `clip-${nanoid(6)}`;
      }
      second.start = validOp.atSeconds;
      second.duration = end - validOp.atSeconds;
      // Video sources must advance their read head by the elapsed offset.
      if (second.type === 'video') {
        second.trimStart = (second.trimStart ?? 0) + offset;
      }
      // First part keeps its start/trimStart; only its duration shrinks.
      clip.duration = offset;
      track.clips.splice(index + 1, 0, second);
      break;
    }
    case 'rippleDelete': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      const index = track.clips.findIndex(c => c.id === validOp.clipId);
      if (index === -1) {
        return { timeline, error: `clip not found: ${validOp.clipId}` };
      }
      const removed = track.clips[index];
      const removedEnd = removed.start + removed.duration;
      track.clips.splice(index, 1);
      // Pull every clip that began after the removed one left by its length,
      // closing the gap. Clamp at 0 so nothing crosses the timeline origin.
      for (const other of track.clips) {
        if (other.start >= removedEnd) {
          other.start = Math.max(0, other.start - removed.duration);
        }
      }
      break;
    }
    case 'nudgeClip': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      const clip = track.clips.find(c => c.id === validOp.clipId);
      if (!clip) {
        return { timeline, error: `clip not found: ${validOp.clipId}` };
      }
      clip.start = Math.max(0, clip.start + validOp.deltaSeconds);
      break;
    }
    case 'setText': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      const clip = track.clips.find(c => c.id === validOp.clipId);
      if (!clip) {
        return { timeline, error: `clip not found: ${validOp.clipId}` };
      }
      if (clip.type !== 'text') {
        return {
          timeline,
          error: `setText only applies to text clips: ${validOp.clipId}`,
        };
      }
      clip.text = validOp.text;
      break;
    }
    case 'applyTransition': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      if (
        !track.clips.some(clip => clip.id === validOp.transition.afterClipId)
      ) {
        return {
          timeline,
          error: `afterClipId not found in track: ${validOp.transition.afterClipId}`,
        };
      }
      const transitions = track.transitions ?? [];
      if (transitions.some(tr => tr.id === validOp.transition.id)) {
        return {
          timeline,
          error: `transition id already exists: ${validOp.transition.id}`,
        };
      }
      transitions.push(validOp.transition);
      track.transitions = transitions;
      break;
    }
    case 'removeTransition': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      const transitions = track.transitions ?? [];
      const index = transitions.findIndex(tr => tr.id === validOp.transitionId);
      if (index === -1) {
        return {
          timeline,
          error: `transition not found: ${validOp.transitionId}`,
        };
      }
      transitions.splice(index, 1);
      track.transitions = transitions;
      break;
    }
    case 'setAnimation': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      const clip = track.clips.find(c => c.id === validOp.clipId);
      if (!clip) {
        return { timeline, error: `clip not found: ${validOp.clipId}` };
      }
      if (validOp.animation === null) {
        delete clip.animation;
      } else {
        clip.animation = validOp.animation;
      }
      break;
    }
    case 'setEffects': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      const clip = track.clips.find(c => c.id === validOp.clipId);
      if (!clip) {
        return { timeline, error: `clip not found: ${validOp.clipId}` };
      }
      // An empty stack clears the field rather than persisting `[]`.
      if (validOp.effects.length === 0) {
        delete clip.effects;
      } else {
        clip.effects = validOp.effects;
      }
      break;
    }
    case 'updateClip': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      const clip = track.clips.find(c => c.id === validOp.clipId);
      if (!clip) {
        return { timeline, error: `clip not found: ${validOp.clipId}` };
      }
      const allowed = patchKeysByType[clip.type];
      const patchKeys = Object.keys(validOp.patch);
      for (const key of patchKeys) {
        if (!allowed || !allowed.has(key)) {
          return {
            timeline,
            error: `field "${key}" is not valid on a ${clip.type} clip`,
          };
        }
      }
      // Assign only the provided keys; the discriminated-union clip keeps its
      // type. Cast through a record since keys are already type-validated.
      Object.assign(clip as Record<string, unknown>, validOp.patch);
      break;
    }
    case 'setAudioMix': {
      const track = findTrack(validOp.trackId);
      if (!track) {
        return { timeline, error: `track not found: ${validOp.trackId}` };
      }
      const clip = track.clips.find(c => c.id === validOp.clipId);
      if (!clip) {
        return { timeline, error: `clip not found: ${validOp.clipId}` };
      }
      if (clip.type !== 'audio') {
        return {
          timeline,
          error: `setAudioMix only applies to audio clips: ${validOp.clipId}`,
        };
      }
      // Tri-state per field: undefined = untouched, null = clear, value = set.
      if (validOp.fadeIn !== undefined) {
        if (validOp.fadeIn === null) delete clip.fadeIn;
        else clip.fadeIn = validOp.fadeIn;
      }
      if (validOp.fadeOut !== undefined) {
        if (validOp.fadeOut === null) delete clip.fadeOut;
        else clip.fadeOut = validOp.fadeOut;
      }
      if (validOp.duck !== undefined) {
        // `duck: false` and `duck: null` both mean "not a ducker" — store
        // neither (keeps documents clean and the field truly tri-state).
        if (validOp.duck === null || validOp.duck === false) delete clip.duck;
        else clip.duck = true;
      }
      break;
    }
    case 'renameTimeline': {
      next.name = validOp.name;
      break;
    }
    default: {
      // Exhaustiveness guard: if a new op is added to the schema without a
      // handler here, this line becomes a compile error.
      const _never: never = validOp;
      return { timeline, error: `unhandled op: ${JSON.stringify(_never)}` };
    }
  }

  // Never emit an invalid document: re-validate the whole timeline.
  const revalidated = vdzTimelineSchema.safeParse(next);
  if (!revalidated.success) {
    return {
      timeline,
      error: `resulting timeline invalid: ${revalidated.error.message}`,
    };
  }
  return { timeline: revalidated.data };
}

/** Result of applying a sequence of ops. */
export interface VdzApplyOpsResult {
  timeline: VdzTimeline;
  /** Index of the op that failed, if any. */
  errorIndex?: number;
  error?: string;
}

/**
 * Apply a sequence of ops left to right. Stops at the first failure and
 * reports the failing op's index; the returned timeline reflects all ops
 * applied before the failure. Pure: never mutates `timeline`.
 */
export function applyOps(
  timeline: VdzTimeline,
  ops: VdzOp[]
): VdzApplyOpsResult {
  let current = timeline;
  for (let i = 0; i < ops.length; i++) {
    const result = applyOp(current, ops[i]);
    if (result.error) {
      return { timeline: current, errorIndex: i, error: result.error };
    }
    current = result.timeline;
  }
  return { timeline: current };
}
