import { z } from 'zod';

/**
 * Vdz timeline schema — the single source of truth for a Vdz Studio project.
 *
 * Both humans (via the workbench UI) and the AI (via {@link ../ops}) edit this
 * document. Everything downstream (preview rendering, and later Remotion
 * export) reads from a validated `VdzTimeline`.
 *
 * Units: all time values (`start`, `duration`, transition `duration`,
 * `trimStart`) are in **seconds**. Positions/sizes on text/shape clips
 * (`x`, `y`, `w`, `h`) are fractions of the canvas (0..1) so they are
 * resolution-independent.
 */

/** Fields shared by every clip regardless of `type`. */
export const vdzClipBaseSchema = z.object({
  id: z.string(),
  /** Offset from the start of the track, in seconds. */
  start: z.number().min(0),
  /** Length of the clip on the timeline, in seconds. */
  duration: z.number().positive(),
  name: z.string().optional(),
});
export type VdzClipBase = z.infer<typeof vdzClipBaseSchema>;

export const vdzVideoClipSchema = vdzClipBaseSchema.extend({
  type: z.literal('video'),
  /** Media source. Empty string renders a placeholder in the shell. */
  src: z.string(),
  /** Seconds trimmed from the head of the source media. */
  trimStart: z.number().min(0).optional(),
  /** 0..1 linear gain. */
  volume: z.number().min(0).max(1).optional(),
});
export type VdzVideoClip = z.infer<typeof vdzVideoClipSchema>;

export const vdzAudioClipSchema = vdzClipBaseSchema.extend({
  type: z.literal('audio'),
  src: z.string(),
  /** 0..1 linear gain. */
  volume: z.number().min(0).max(1).optional(),
});
export type VdzAudioClip = z.infer<typeof vdzAudioClipSchema>;

export const vdzImageClipSchema = vdzClipBaseSchema.extend({
  type: z.literal('image'),
  src: z.string(),
  fit: z.enum(['cover', 'contain']).optional(),
});
export type VdzImageClip = z.infer<typeof vdzImageClipSchema>;

export const vdzTextClipSchema = vdzClipBaseSchema.extend({
  type: z.literal('text'),
  text: z.string(),
  /** Font size as a fraction of canvas height (0..1). */
  fontSize: z.number().positive().optional(),
  color: z.string().optional(),
  /** Horizontal anchor, fraction of canvas width (0..1). */
  x: z.number().optional(),
  /** Vertical anchor, fraction of canvas height (0..1). */
  y: z.number().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
});
export type VdzTextClip = z.infer<typeof vdzTextClipSchema>;

export const vdzShapeClipSchema = vdzClipBaseSchema.extend({
  type: z.literal('shape'),
  shape: z.enum(['rect', 'circle']),
  color: z.string().optional(),
  /** Top-left x, fraction of canvas width (0..1). */
  x: z.number().optional(),
  /** Top-left y, fraction of canvas height (0..1). */
  y: z.number().optional(),
  /** Width, fraction of canvas width (0..1). */
  w: z.number().optional(),
  /** Height, fraction of canvas height (0..1). */
  h: z.number().optional(),
});
export type VdzShapeClip = z.infer<typeof vdzShapeClipSchema>;

/** A clip is a discriminated union on `type`. */
export const vdzClipSchema = z.discriminatedUnion('type', [
  vdzVideoClipSchema,
  vdzAudioClipSchema,
  vdzImageClipSchema,
  vdzTextClipSchema,
  vdzShapeClipSchema,
]);
export type VdzClip = z.infer<typeof vdzClipSchema>;

/** A transition applied on the boundary after a given clip. */
export const vdzTransitionSchema = z.object({
  id: z.string(),
  kind: z.enum(['fade', 'slide', 'wipe']),
  /** Clip after which this transition plays. */
  afterClipId: z.string(),
  /** Transition length in seconds. */
  duration: z.number().positive(),
});
export type VdzTransition = z.infer<typeof vdzTransitionSchema>;

export const vdzTrackSchema = z.object({
  id: z.string(),
  kind: z.enum(['video', 'audio', 'overlay']),
  name: z.string().optional(),
  clips: z.array(vdzClipSchema),
  transitions: z.array(vdzTransitionSchema).optional(),
});
export type VdzTrack = z.infer<typeof vdzTrackSchema>;

export const vdzTimelineSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  fps: z.number().positive().default(30),
  width: z.number().positive().default(1920),
  height: z.number().positive().default(1080),
  tracks: z.array(vdzTrackSchema),
});
export type VdzTimeline = z.infer<typeof vdzTimelineSchema>;

/**
 * Total duration of a timeline, in seconds: the maximum clip end
 * (`start + duration`) across every track. Returns 0 for an empty timeline.
 */
export function computeTimelineDuration(timeline: VdzTimeline): number {
  let max = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const end = clip.start + clip.duration;
      if (end > max) {
        max = end;
      }
    }
  }
  return max;
}
