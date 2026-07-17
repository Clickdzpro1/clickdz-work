import type { VdzEffect, VdzTransition } from './schema';

/**
 * Vdz Studio — curated presets.
 *
 * Small, dependency-free catalogs the workbench UI and the AI both read from so
 * "apply a look", "add a transition" and "set an aspect ratio" mean the SAME
 * thing everywhere. Everything here is plain data (no React, no DOM); each entry
 * maps onto the primitives the schema already validates:
 *   · {@link VDZ_EFFECT_PRESETS}    → a `VdzEffect[]` for `setEffects`;
 *   · {@link VDZ_TRANSITION_KINDS}  → a `VdzTransition['kind']` for `applyTransition`;
 *   · {@link VDZ_RATIO_PRESETS}     → a `width`/`height` for `setCanvas`.
 *
 * Effect `amount`s are the schema's normalized 0..1 knobs (see `vdzEffectSchema`
 * and the preview's `effectToFilter` mapping): 0.5 is neutral for brightness /
 * contrast / saturate; blur/glow/vignette scale up from 0. Combos are kept
 * deliberately restrained so a look reads as a grade, not a gimmick.
 */

/** A named, ready-to-apply stack of visual effects (a "look"). */
export interface VdzEffectPreset {
  /** Stable id (used by the UI/AI to pick a preset). */
  id: string;
  /** Human label for the picker. */
  name: string;
  /** A single glyph for the picker chip. */
  emoji: string;
  /** One-line description of the look. */
  description: string;
  /** The effect stack to write via `setEffects` (empty clears effects). */
  effects: VdzEffect[];
}

/**
 * The built-in looks. `none` is the CLEAR preset — an empty `effects` array,
 * which `setEffects` treats as "remove all effects" — so the UI can offer a
 * one-click reset alongside the graded looks. The rest layer the schema's
 * effect kinds (including the edge-darkening `vignette`) into tasteful combos.
 */
export const VDZ_EFFECT_PRESETS: VdzEffectPreset[] = [
  {
    id: 'none',
    name: 'None',
    emoji: '🚫',
    description: 'Clear all effects — the untouched, ungraded frame.',
    effects: [],
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    emoji: '🎬',
    description: 'Punchy contrast, richer color and a soft vignette.',
    effects: [
      { kind: 'contrast', amount: 0.62 },
      { kind: 'saturate', amount: 0.6 },
      { kind: 'vignette', amount: 0.45 },
    ],
  },
  {
    id: 'vintage',
    name: 'Vintage',
    emoji: '📻',
    description: 'Warm sepia wash, a touch brighter, edges gently darkened.',
    effects: [
      { kind: 'sepia', amount: 0.55 },
      { kind: 'brightness', amount: 0.55 },
      { kind: 'vignette', amount: 0.4 },
    ],
  },
  {
    id: 'noir',
    name: 'Noir',
    emoji: '🖤',
    description: 'High-contrast black & white.',
    effects: [
      { kind: 'grayscale', amount: 1 },
      { kind: 'contrast', amount: 0.7 },
    ],
  },
  {
    id: 'vibrant',
    name: 'Vibrant',
    emoji: '🌈',
    description: 'Bold, saturated color with a brightness lift.',
    effects: [
      { kind: 'saturate', amount: 0.8 },
      { kind: 'brightness', amount: 0.6 },
    ],
  },
  {
    id: 'dreamy',
    name: 'Dreamy',
    emoji: '💭',
    description: 'A soft-focus haze, gentle bloom and a brightness lift.',
    effects: [
      { kind: 'blur', amount: 0.18 },
      { kind: 'brightness', amount: 0.6 },
      { kind: 'glow', amount: 0.45 },
    ],
  },
  {
    id: 'crisp',
    name: 'Crisp',
    emoji: '✨',
    description: 'Clean, crisp contrast with a hint of extra color.',
    effects: [
      { kind: 'contrast', amount: 0.6 },
      { kind: 'saturate', amount: 0.58 },
    ],
  },
];

/** Picker metadata for a single transition kind. */
export interface VdzTransitionInfo {
  /** The schema transition `kind` this describes. */
  kind: VdzTransition['kind'];
  /** Human label for the picker. */
  name: string;
  /** A single glyph for the picker chip. */
  emoji: string;
  /** One-line description of the motion. */
  description: string;
}

/**
 * Every transition kind the schema accepts, in picker order. `dissolve`, `push`
 * and `iris` are the newer additions alongside the original `fade`, `slide` and
 * `wipe`; the preview (`anim.ts`) and the export compiler both render all six.
 */
export const VDZ_TRANSITION_KINDS: VdzTransitionInfo[] = [
  {
    kind: 'fade',
    name: 'Fade',
    emoji: '🌫️',
    description: 'Cross-fade one clip into the next.',
  },
  {
    kind: 'dissolve',
    name: 'Dissolve',
    emoji: '💧',
    description: 'A cross-fade with a slight defocus so the clips melt together.',
  },
  {
    kind: 'slide',
    name: 'Slide',
    emoji: '➡️',
    description: 'The incoming clip slides in from the right.',
  },
  {
    kind: 'wipe',
    name: 'Wipe',
    emoji: '🧹',
    description: 'The incoming clip is revealed by a wipe from the left.',
  },
  {
    kind: 'push',
    name: 'Push',
    emoji: '👉',
    description: 'The incoming clip pushes the outgoing one off-screen.',
  },
  {
    kind: 'iris',
    name: 'Iris',
    emoji: '⭕',
    description: 'The incoming clip opens through a growing circle.',
  },
];

/**
 * A canvas aspect-ratio preset — a label plus the pixel `width`/`height` to
 * write via `setCanvas` (both integers inside the op's 320..4096 range).
 */
export interface VdzRatioPreset {
  /** Stable id / ratio token (e.g. `16:9`). */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Canvas width in pixels. */
  width: number;
  /** Canvas height in pixels. */
  height: number;
}

/** The built-in aspect ratios offered by the canvas-size picker. */
export const VDZ_RATIO_PRESETS: VdzRatioPreset[] = [
  { id: '16:9', label: 'Widescreen', width: 1920, height: 1080 },
  { id: '9:16', label: 'Reels / TikTok', width: 1080, height: 1920 },
  { id: '1:1', label: 'Square', width: 1080, height: 1080 },
  { id: '4:5', label: 'Portrait', width: 1080, height: 1350 },
  { id: '21:9', label: 'Cinema', width: 2560, height: 1080 },
];
