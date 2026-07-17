/**
 * clickdz-remotion-worker — pure animation/transition/effect math.
 *
 * This is the FRAME-DOMAIN port of the app's `anim.ts` (the preview + HTML
 * compiler share that module). The manifest already lowered everything into
 * frames and resolved anchors, so here we only re-state the SAME curves the app
 * uses so a rendered MP4 frame matches the preview at the same playhead:
 *   · easeOutCubic for animation + transition progress;
 *   · stateForKind for the entrance/exit motion presets;
 *   · transitionStateAt for the six transition kinds;
 *   · the per-effect CSS-filter ranges and the vignette overlay;
 *   · the karaoke accent + dim constants.
 * No Remotion imports here — pure functions of numbers, unit-testable in Node.
 */

import type {
  ManifestAnimationKind,
  ManifestEffect,
  ManifestEffectKind,
  ManifestTransitionKind,
} from './manifest';

/** Clamp `t` into [0, 1]. */
export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Cubic ease-out (mirrors app anim.ts). Maps [0,1] → [0,1]. */
export function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

/** A clip's visual transform at a playhead (fractions of the clip box). */
export interface VisualState {
  opacity: number;
  translateX: number;
  translateY: number;
  scale: number;
  rotate: number;
}

export const IDENTITY: VisualState = {
  opacity: 1,
  translateX: 0,
  translateY: 0,
  scale: 1,
  rotate: 0,
};

/**
 * The visual state one animation side contributes at eased progress `p`
 * (0 = offset, 1 = neutral). BYTE-FOR-BYTE the app's `stateForKind`.
 */
export function stateForKind(kind: ManifestAnimationKind, p: number): VisualState {
  const d = 1 - p;
  switch (kind) {
    case 'fade':
      return { ...IDENTITY, opacity: p };
    case 'slide-up':
      return { ...IDENTITY, opacity: p, translateY: d };
    case 'slide-down':
      return { ...IDENTITY, opacity: p, translateY: -d };
    case 'slide-left':
      return { ...IDENTITY, opacity: p, translateX: d };
    case 'slide-right':
      return { ...IDENTITY, opacity: p, translateX: -d };
    case 'zoom-in':
      return { ...IDENTITY, opacity: p, scale: 0.6 + 0.4 * p };
    case 'zoom-out':
      return { ...IDENTITY, opacity: p, scale: 1.4 - 0.4 * p };
    case 'pop': {
      const overshoot = Math.sin(clamp01(p) * Math.PI) * 0.12;
      return { ...IDENTITY, opacity: p, scale: 0.7 + 0.3 * p + overshoot };
    }
    default:
      return IDENTITY;
  }
}

/** Compose two states: multiply opacity/scale, add translate/rotate. */
export function compose(a: VisualState, b: VisualState): VisualState {
  return {
    opacity: a.opacity * b.opacity,
    translateX: a.translateX + b.translateX,
    translateY: a.translateY + b.translateY,
    scale: a.scale * b.scale,
    rotate: a.rotate + b.rotate,
  };
}

/**
 * The base (static + entrance/exit) visual state of a clip at ABSOLUTE frame
 * `frame`, given its window and animation, both in frames. Mirrors the app's
 * `clipVisualStateAt`: entrance runs 0→1 over `in` from the clip start, exit
 * runs 1→0 over `out` ending at the clip end.
 */
export function clipVisualState(args: {
  frame: number;
  fromFrame: number;
  durationInFrames: number;
  staticOpacity: number;
  staticRotate: number;
  animIn?: { kind: ManifestAnimationKind; durationInFrames: number };
  animOut?: { kind: ManifestAnimationKind; durationInFrames: number };
}): VisualState {
  let state: VisualState =
    args.staticOpacity === 1 && args.staticRotate === 0
      ? IDENTITY
      : { ...IDENTITY, opacity: clamp01(args.staticOpacity), rotate: args.staticRotate };

  const end = args.fromFrame + args.durationInFrames;

  if (args.animIn) {
    const dur = args.animIn.durationInFrames;
    const raw = dur > 0 ? (args.frame - args.fromFrame) / dur : 1;
    const p = easeOutCubic(clamp01(raw));
    state = compose(state, stateForKind(args.animIn.kind, p));
  }
  if (args.animOut) {
    const dur = args.animOut.durationInFrames;
    const rawExit = dur > 0 ? (args.frame - (end - dur)) / dur : 0;
    const p = easeOutCubic(clamp01(1 - clamp01(rawExit)));
    state = compose(state, stateForKind(args.animOut.kind, p));
  }
  return state;
}

/** The resolved contribution of a transition, mirroring `transitionStateAt`. */
export interface TransitionState {
  kind: ManifestTransitionKind;
  progress: number;
  outOpacity: number;
  inOpacity: number;
  inTranslateX: number;
  outTranslateX: number;
  wipeReveal: number;
  dissolveBlurPx: number;
  pushIn: number;
  pushOut: number;
  irisReveal: number;
}

/**
 * Resolve a transition at ABSOLUTE frame `frame`, centered on `boundaryInFrames`
 * spanning `durationInFrames` (half before/after). Returns null outside the
 * window. FRAME-DOMAIN port of the app's `transitionStateAt` (identical curves).
 */
export function transitionState(args: {
  kind: ManifestTransitionKind;
  boundaryInFrames: number;
  durationInFrames: number;
  frame: number;
}): TransitionState | null {
  const half = args.durationInFrames / 2;
  const winStart = args.boundaryInFrames - half;
  const winEnd = args.boundaryInFrames + half;
  if (args.frame < winStart || args.frame > winEnd) return null;
  const span = winEnd - winStart;
  const raw = span > 0 ? (args.frame - winStart) / span : 1;
  const p = clamp01(raw);
  const eased = easeOutCubic(p);
  const bell = Math.sin(p * Math.PI);
  return {
    kind: args.kind,
    progress: p,
    outOpacity: 1 - eased,
    inOpacity: eased,
    inTranslateX: 1 - eased,
    outTranslateX: -eased,
    wipeReveal: eased,
    dissolveBlurPx: bell * 6,
    pushIn: 1 - eased,
    pushOut: -eased,
    irisReveal: eased,
  };
}

/** The role a clip plays in a transition at the current frame. */
export type TransitionRole = 'out' | 'in';

/**
 * Fold a transition into a clip's final opacity / extra x-translate / clip-path
 * / extra filter, mirroring the app's `resolveItemRender`. `role` is whether the
 * clip is the outgoing or incoming side of the transition.
 */
export function resolveTransition(
  state: TransitionState,
  role: TransitionRole,
  baseOpacity: number
): {
  opacity: number;
  extraTranslateX: number;
  clipPath?: string;
  extraFilter?: string;
} {
  let opacity = baseOpacity;
  let extraTranslateX = 0;
  let clipPath: string | undefined;
  let extraFilter: string | undefined;

  if (state.kind === 'fade') {
    opacity *= role === 'out' ? state.outOpacity : state.inOpacity;
  } else if (state.kind === 'dissolve') {
    opacity *= role === 'out' ? state.outOpacity : state.inOpacity;
    if (state.dissolveBlurPx > 0.01) {
      extraFilter = `blur(${state.dissolveBlurPx.toFixed(2)}px)`;
    }
  } else if (state.kind === 'slide') {
    extraTranslateX = role === 'out' ? state.outTranslateX : state.inTranslateX;
  } else if (state.kind === 'push') {
    extraTranslateX = role === 'out' ? state.pushOut : state.pushIn;
  } else if (state.kind === 'iris') {
    if (role === 'in') {
      const r = (state.irisReveal * 75).toFixed(2);
      clipPath = `circle(${r}% at 50% 50%)`;
    }
  } else {
    // wipe
    if (role === 'in') {
      const hiddenRight = (1 - state.wipeReveal) * 100;
      clipPath = `inset(0 ${hiddenRight.toFixed(2)}% 0 0)`;
    }
  }
  return { opacity, extraTranslateX, clipPath, extraFilter };
}

// ---- Effects → CSS filter (mirrors app anim.ts effectToFilter) -------------

/** Map ONE normalized effect to a CSS filter function, or null (vignette). */
export function effectToFilter(effect: ManifestEffect): string | null {
  const a = clamp01(effect.amount);
  switch (effect.kind) {
    case 'blur':
      return `blur(${(a * 12).toFixed(2)}px)`;
    case 'brightness':
      return `brightness(${(0.5 + a).toFixed(3)})`;
    case 'contrast':
      return `contrast(${(0.5 + a).toFixed(3)})`;
    case 'saturate':
      return `saturate(${(a * 2).toFixed(3)})`;
    case 'grayscale':
      return `grayscale(${a.toFixed(3)})`;
    case 'sepia':
      return `sepia(${a.toFixed(3)})`;
    case 'glow':
      return `drop-shadow(0 0 ${(a * 24).toFixed(2)}px rgba(255,255,255,${(
        0.2 +
        a * 0.6
      ).toFixed(3)}))`;
    case 'vignette':
      return null; // overlay, not a filter
    default:
      return null;
  }
}

/** Composite filter string for an effect stack, or undefined. */
export function effectsFilter(effects: ManifestEffect[] | undefined): string | undefined {
  if (!effects || effects.length === 0) return undefined;
  const parts = effects
    .map(effectToFilter)
    .filter((f): f is string => f !== null);
  return parts.length ? parts.join(' ') : undefined;
}

/** Merge a base filter with a transition's extra (dissolve) filter. */
export function mergeFilters(
  base: string | undefined,
  extra: string | undefined
): string | undefined {
  if (base && extra) return `${base} ${extra}`;
  return base ?? extra ?? undefined;
}

/** The vignette box-shadow for a normalized amount, or null (mirrors app). */
export function vignetteBoxShadow(amount: number): string | null {
  const a = clamp01(amount);
  if (a <= 0) return null;
  const blur = (12 + a * 28).toFixed(1);
  const spread = (a * 14).toFixed(1);
  const alpha = (0.15 + a * 0.65).toFixed(3);
  return `inset 0 0 ${blur}vmin ${spread}vmin rgba(0,0,0,${alpha})`;
}

/** The strongest vignette overlay style for an effect stack, or undefined. */
export function vignetteOverlay(effects: ManifestEffect[] | undefined): string | undefined {
  if (!effects || effects.length === 0) return undefined;
  let strongest = 0;
  for (const e of effects) {
    if (e.kind === 'vignette' && e.amount > strongest) strongest = e.amount;
  }
  const shadow = vignetteBoxShadow(strongest);
  return shadow ?? undefined;
}

// ---- Karaoke constants (mirror app anim.ts) --------------------------------

export const KARAOKE_ACCENT = '#ffd54a';
export const KARAOKE_UPCOMING_OPACITY = 0.55;

/** Per-word highlight state. */
export type KaraokeWordState = 'spoken' | 'active' | 'upcoming';

/**
 * The active word index at CLIP-RELATIVE frame `relFrame`, or -1. A word is
 * active over `[fromFrame, toFrame)` (mirrors app `karaokeActiveIndex`).
 */
export function karaokeActiveIndex(
  words: ReadonlyArray<{ fromFrame: number; toFrame: number }> | undefined,
  relFrame: number
): number {
  if (!words || words.length === 0) return -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (relFrame >= w.fromFrame && relFrame < w.toFrame) return i;
  }
  return -1;
}

/** The state classifier for a word at clip-relative frame `relFrame`. */
export function karaokeState(
  words: ReadonlyArray<{ fromFrame: number; toFrame: number }> | undefined,
  relFrame: number
): { activeIndex: number; state: (i: number) => KaraokeWordState } {
  const activeIndex = karaokeActiveIndex(words, relFrame);
  const state = (i: number): KaraokeWordState => {
    if (i === activeIndex) return 'active';
    const w = words?.[i];
    if (w && relFrame >= w.fromFrame) return 'spoken';
    return 'upcoming';
  };
  return { activeIndex, state };
}

/** Serialize a visual state to a CSS transform string (clip vs. text basis). */
export function transformCss(state: VisualState, basis: 'clip' | 'text'): string {
  const parts: string[] = [];
  if (basis === 'text') parts.push('translate(-50%, -50%)');
  if (state.translateX !== 0 || state.translateY !== 0) {
    parts.push(
      `translate(${(state.translateX * 100).toFixed(3)}%, ${(state.translateY * 100).toFixed(3)}%)`
    );
  }
  if (state.scale !== 1) parts.push(`scale(${state.scale.toFixed(4)})`);
  if (state.rotate !== 0) parts.push(`rotate(${state.rotate.toFixed(3)}deg)`);
  return parts.length ? parts.join(' ') : 'none';
}
