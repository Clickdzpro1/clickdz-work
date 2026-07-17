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

/**
 * Motion presets for a clip's entrance/exit animation. Each maps to a
 * deterministic opacity + transform curve in the preview (see the page-level
 * `anim.ts`): `fade` is opacity only; `slide-*` translate in from an edge;
 * `zoom-in`/`zoom-out` scale; `pop` overshoots slightly on entry.
 */
export const vdzAnimationKindSchema = z.enum([
  'fade',
  'slide-up',
  'slide-down',
  'slide-left',
  'slide-right',
  'zoom-in',
  'zoom-out',
  'pop',
]);
export type VdzAnimationKind = z.infer<typeof vdzAnimationKindSchema>;

/** One end of a clip animation (its `in` entrance or `out` exit). */
export const vdzAnimationSpecSchema = z.object({
  kind: vdzAnimationKindSchema,
  /** Length in seconds. Defaults to 0.5 when omitted. */
  duration: z.number().positive().default(0.5),
});
export type VdzAnimationSpec = z.infer<typeof vdzAnimationSpecSchema>;

/**
 * A clip's optional entrance/exit animation. `in` plays over its `duration`
 * from the clip's start; `out` plays over its `duration` ending at the clip's
 * end. Either side may be omitted.
 */
export const vdzAnimationSchema = z.object({
  in: vdzAnimationSpecSchema.optional(),
  out: vdzAnimationSpecSchema.optional(),
});
export type VdzAnimation = z.infer<typeof vdzAnimationSchema>;

/**
 * Visual effects applied to a clip. Most render as a CSS `filter` function;
 * `vignette` is the exception — it darkens the frame edges via an overlay
 * (an inset shadow / radial gradient), not a filter (see the page-level
 * `anim.ts` effect helpers). OPTIONAL/additive: `vignette` was added after the
 * others, so a timeline authored before it existed parses unchanged.
 */
export const vdzEffectKindSchema = z.enum([
  'blur',
  'brightness',
  'contrast',
  'saturate',
  'grayscale',
  'sepia',
  'glow',
  'vignette',
]);
export type VdzEffectKind = z.infer<typeof vdzEffectKindSchema>;

/**
 * One effect on a clip. `amount` is a normalized 0..1 knob the preview maps to
 * a sensible per-effect range (e.g. blur → 0..12px, brightness → 0.5..1.5).
 */
export const vdzEffectSchema = z.object({
  kind: vdzEffectKindSchema,
  amount: z.number().min(0).max(1),
});
export type VdzEffect = z.infer<typeof vdzEffectSchema>;

/**
 * Fields shared by every clip regardless of `type`.
 *
 * `animation` and `effects` are OPTIONAL and additive — a timeline authored
 * before they existed parses unchanged.
 */
export const vdzClipBaseSchema = z.object({
  id: z.string(),
  /** Offset from the start of the track, in seconds. */
  start: z.number().min(0),
  /** Length of the clip on the timeline, in seconds. */
  duration: z.number().positive(),
  name: z.string().optional(),
  /** Optional entrance/exit motion (see {@link vdzAnimationSchema}). */
  animation: vdzAnimationSchema.optional(),
  /** Optional visual filter stack (see {@link vdzEffectSchema}). */
  effects: z.array(vdzEffectSchema).optional(),
  /**
   * Static layer opacity, 0..1. MULTIPLIES with any animation/transition
   * opacity in the preview (it never overwrites them). OPTIONAL/additive —
   * omitted means fully opaque (1); a timeline authored before it existed
   * parses unchanged. Not meaningful on audio clips.
   */
  opacity: z.number().min(0).max(1).optional(),
  /**
   * Static rotation in DEGREES, -180..180. Composes into the clip's transform
   * around its center without clobbering animation transforms (see `anim.ts`).
   * OPTIONAL/additive — omitted means no rotation. Not meaningful on audio.
   */
  rotation: z.number().min(-180).max(180).optional(),
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
  /**
   * Seconds to ramp in from silence at the clip's start. OPTIONAL and
   * additive — timelines authored before fades existed parse unchanged.
   * A fade longer than the clip is clamped to its duration at playback.
   */
  fadeIn: z.number().min(0).optional(),
  /** Seconds to ramp out to silence ending at the clip's end (see fadeIn). */
  fadeOut: z.number().min(0).optional(),
  /**
   * When true, every OTHER audio clip dips (ducks) while this clip plays —
   * mark a voiceover with `duck` so music automatically sits under it.
   */
  duck: z.boolean().optional(),
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
  /**
   * Caption STYLE preset (text-clips only). Controls the chrome drawn around
   * the text: `plain` (as before — no chrome), `boxed`/`pill` (a rounded
   * background behind the text), `outline` (a stroke ring) or `shadow` (a soft
   * drop shadow). OPTIONAL/additive — omitted renders exactly as before.
   */
  capPreset: z.enum(['plain', 'boxed', 'outline', 'shadow', 'pill']).optional(),
  /**
   * Caption vertical POSITION preset (text-clips only): `top`, `middle` or
   * `lower`-third. Applies ONLY when `y` is not set explicitly (an explicit `y`
   * always wins). OPTIONAL/additive — omitted keeps the default centering.
   */
  capPosition: z.enum(['top', 'middle', 'lower']).optional(),
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

/**
 * A transition applied on the boundary after a given clip.
 *
 * `kind` was extended with `dissolve` (crossfade with a slight blur), `push`
 * (the incoming clip shoves the outgoing one along x) and `iris` (a circular
 * clip-path reveal). All three are ADDITIVE — a timeline authored with only
 * the original `fade`/`slide`/`wipe` kinds parses unchanged.
 */
export const vdzTransitionSchema = z.object({
  id: z.string(),
  kind: z.enum(['fade', 'slide', 'wipe', 'dissolve', 'push', 'iris']),
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
