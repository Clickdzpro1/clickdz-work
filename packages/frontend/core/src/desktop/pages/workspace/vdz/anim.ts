import type {
  VdzAnimationKind,
  VdzAnimationSpec,
  VdzClip,
  VdzEffect,
  VdzTimeline,
  VdzTrack,
  VdzTransition,
} from '../../../../modules/vdz';

/**
 * Pure, deterministic preview math for animations, effects and transitions.
 *
 * Everything here is a plain function of the clip/transition data and the
 * current playhead time — the SAME playhead always yields the SAME frame, so
 * the preview (and a future Remotion render) can share this module. No React,
 * no DOM, no clock. All times are in seconds.
 */

/** Clamp `t` into [0, 1]. */
function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Cubic ease-out: fast start, gentle settle. Maps [0,1] → [0,1]. */
export function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

/** The CSS transform a clip applies at the current playhead. */
export interface VdzClipVisualState {
  /** 0..1 layer opacity. */
  opacity: number;
  /** X translate as a fraction of the clip box (1 = one full box width). */
  translateX: number;
  /** Y translate as a fraction of the clip box. */
  translateY: number;
  /** Uniform scale factor (1 = natural size). */
  scale: number;
}

/** The neutral state: fully visible, no transform. */
export const IDENTITY_VISUAL: VdzClipVisualState = {
  opacity: 1,
  translateX: 0,
  translateY: 0,
  scale: 1,
};

/**
 * The visual state contributed by ONE animation side at eased progress `p`
 * (0 → animation just starting, 1 → finished/neutral). For an entrance the
 * clip travels FROM the offset TO neutral; for an exit we pass a reversed
 * progress so it travels neutral → offset.
 */
function stateForKind(
  kind: VdzAnimationKind,
  p: number
): VdzClipVisualState {
  // `d` is the distance-from-neutral (1 at p=0, 0 at p=1).
  const d = 1 - p;
  switch (kind) {
    case 'fade':
      return { ...IDENTITY_VISUAL, opacity: p };
    case 'slide-up':
      return { ...IDENTITY_VISUAL, opacity: p, translateY: d };
    case 'slide-down':
      return { ...IDENTITY_VISUAL, opacity: p, translateY: -d };
    case 'slide-left':
      return { ...IDENTITY_VISUAL, opacity: p, translateX: d };
    case 'slide-right':
      return { ...IDENTITY_VISUAL, opacity: p, translateX: -d };
    case 'zoom-in':
      // grows from 0.6 → 1
      return { ...IDENTITY_VISUAL, opacity: p, scale: 0.6 + 0.4 * p };
    case 'zoom-out':
      // shrinks from 1.4 → 1
      return { ...IDENTITY_VISUAL, opacity: p, scale: 1.4 - 0.4 * p };
    case 'pop': {
      // slight overshoot past 1 near the end, settling to 1.
      const overshoot = Math.sin(clamp01(p) * Math.PI) * 0.12;
      return { ...IDENTITY_VISUAL, opacity: p, scale: 0.7 + 0.3 * p + overshoot };
    }
    default: {
      // Exhaustiveness guard: unreachable, and a compile error if a kind is
      // added without a case here. Returning `never` keeps the local `used`.
      const _never: never = kind;
      return _never;
    }
  }
}

/** Compose two visual states (multiply opacity/scale, add translates). */
function composeVisual(
  a: VdzClipVisualState,
  b: VdzClipVisualState
): VdzClipVisualState {
  return {
    opacity: a.opacity * b.opacity,
    translateX: a.translateX + b.translateX,
    translateY: a.translateY + b.translateY,
    scale: a.scale * b.scale,
  };
}

/**
 * The full visual state of a clip at absolute playhead `nowSeconds`, folding
 * in its entrance (`animation.in`) and exit (`animation.out`).
 *
 * Entrance progress runs 0→1 over `in.duration` seconds from `clip.start`;
 * exit progress runs 1→0 over `out.duration` seconds ending at the clip's end.
 * Outside those windows the corresponding side contributes the identity.
 * Deterministic: depends only on the clip and `nowSeconds`.
 */
export function clipVisualStateAt(
  clip: VdzClip,
  nowSeconds: number
): VdzClipVisualState {
  const anim = clip.animation;
  if (!anim) return IDENTITY_VISUAL;

  const end = clip.start + clip.duration;
  let state = IDENTITY_VISUAL;

  if (anim.in) {
    const dur = animDuration(anim.in);
    const raw = dur > 0 ? (nowSeconds - clip.start) / dur : 1;
    // Before the window: p=0 (offset); after: p=1 (neutral).
    const p = easeOutCubic(clamp01(raw));
    state = composeVisual(state, stateForKind(anim.in.kind, p));
  }

  if (anim.out) {
    const dur = animDuration(anim.out);
    // progress of the EXIT itself, 0 at window start → 1 at clip end.
    const rawExit = dur > 0 ? (nowSeconds - (end - dur)) / dur : 0;
    // Feed the reversed, eased progress so the clip animates neutral → offset.
    const p = easeOutCubic(clamp01(1 - clamp01(rawExit)));
    state = composeVisual(state, stateForKind(anim.out.kind, p));
  }

  return state;
}

/** Resolve an animation side's duration, defaulting to 0.5s. */
export function animDuration(spec: VdzAnimationSpec): number {
  return spec.duration && spec.duration > 0 ? spec.duration : 0.5;
}

/** Serialize a visual state's transform into a CSS `transform` string. */
export function visualTransformCss(
  state: VdzClipVisualState,
  translateBasis: 'clip' | 'text'
): string {
  const parts: string[] = [];
  // For text we already center with translate(-50%,-50%); compose additively.
  if (translateBasis === 'text') {
    parts.push('translate(-50%, -50%)');
  }
  if (state.translateX !== 0 || state.translateY !== 0) {
    parts.push(
      `translate(${(state.translateX * 100).toFixed(3)}%, ${(
        state.translateY * 100
      ).toFixed(3)}%)`
    );
  }
  if (state.scale !== 1) {
    parts.push(`scale(${state.scale.toFixed(4)})`);
  }
  return parts.length ? parts.join(' ') : 'none';
}

// ---- Effects → CSS filter -------------------------------------------------

/**
 * Map a single normalized effect to a CSS `filter` function. `amount` is
 * always 0..1; each effect maps it to a tasteful native range.
 */
function effectToFilter(effect: VdzEffect): string | null {
  const a = clamp01(effect.amount);
  switch (effect.kind) {
    case 'blur':
      return `blur(${(a * 12).toFixed(2)}px)`;
    case 'brightness':
      // 0 → 0.5×, 0.5 → 1× (neutral), 1 → 1.5×
      return `brightness(${(0.5 + a).toFixed(3)})`;
    case 'contrast':
      return `contrast(${(0.5 + a).toFixed(3)})`;
    case 'saturate':
      // 0 → 0× (grayscale), 0.5 → 1×, 1 → 2×
      return `saturate(${(a * 2).toFixed(3)})`;
    case 'grayscale':
      return `grayscale(${a.toFixed(3)})`;
    case 'sepia':
      return `sepia(${a.toFixed(3)})`;
    case 'glow':
      // A soft white bloom; scales with amount.
      return `drop-shadow(0 0 ${(a * 24).toFixed(2)}px rgba(255,255,255,${(
        0.2 +
        a * 0.6
      ).toFixed(3)}))`;
    default: {
      // Exhaustiveness guard (see stateForKind).
      const _never: never = effect.kind;
      return _never;
    }
  }
}

/**
 * Build the composite CSS `filter` string for a clip's effect stack. Returns
 * `undefined` when there are no effects, so callers can omit the CSS prop.
 */
export function effectsFilterCss(
  effects: VdzEffect[] | undefined
): string | undefined {
  if (!effects || effects.length === 0) return undefined;
  const parts = effects
    .map(effectToFilter)
    .filter((f): f is string => f !== null);
  return parts.length ? parts.join(' ') : undefined;
}

// ---- Transitions ----------------------------------------------------------

/** One clip's contribution to a transition's crossfade window. */
export interface VdzTransitionState {
  /** The transition kind driving the render. */
  kind: VdzTransition['kind'];
  /** 0..1 progress through the transition window (0 = start, 1 = done). */
  progress: number;
  /** Eased progress for the OUTGOING clip (1 → 0 opacity for fade). */
  outOpacity: number;
  /** Eased opacity for the INCOMING clip (0 → 1 for fade). */
  inOpacity: number;
  /** X translate (fraction of box) for the incoming clip during a slide. */
  inTranslateX: number;
  /** X translate for the outgoing clip during a slide. */
  outTranslateX: number;
  /**
   * `clip-path` inset fraction (0..1) revealing the incoming clip for a wipe.
   * 0 = fully hidden, 1 = fully revealed.
   */
  wipeReveal: number;
}

/**
 * The transition window is centered on the boundary between clip A (ending at
 * `boundarySeconds`) and clip B (starting at `boundarySeconds`), spanning
 * `duration` seconds — half before, half after. Returns the transition state
 * if `nowSeconds` falls inside the window, else null.
 *
 * Pure: depends only on the transition, the boundary, and `nowSeconds`.
 */
export function transitionStateAt(
  transition: VdzTransition,
  boundarySeconds: number,
  nowSeconds: number
): VdzTransitionState | null {
  const half = transition.duration / 2;
  const winStart = boundarySeconds - half;
  const winEnd = boundarySeconds + half;
  if (nowSeconds < winStart || nowSeconds > winEnd) return null;
  const span = winEnd - winStart;
  const raw = span > 0 ? (nowSeconds - winStart) / span : 1;
  const p = clamp01(raw);
  const eased = easeOutCubic(p);
  return {
    kind: transition.kind,
    progress: p,
    outOpacity: 1 - eased,
    inOpacity: eased,
    // Incoming slides in from the right (1 → 0); outgoing slides out left.
    inTranslateX: 1 - eased,
    outTranslateX: -eased,
    wipeReveal: eased,
  };
}

// ---- Whole-frame composition ----------------------------------------------

/** The role a clip plays in a transition at the current frame. */
export type VdzTransitionRole = 'out' | 'in';

/** One layer to draw in the preview, fully resolved for the current frame. */
export interface VdzPreviewItem {
  clip: VdzClip;
  /** Stable per-frame key (a clip can appear once). */
  key: string;
  /** Base visual from the clip's own in/out animation. */
  visual: VdzClipVisualState;
  /** Composite CSS filter for the clip's effects, or undefined. */
  filter?: string;
  /**
   * When this clip is participating in a transition at the boundary with a
   * neighbour, the transition state plus this clip's role in it. The preview
   * multiplies the transition's opacity/translate/wipe onto the base visual.
   */
  transition?: { state: VdzTransitionState; role: VdzTransitionRole };
}

/**
 * Is a clip on screen at `nowSeconds`, INCLUDING the half-windows of any
 * transition on either of its boundaries (so an outgoing clip lingers and an
 * incoming clip appears a touch early during a crossfade)?
 */
function clipWindow(
  track: VdzTrack,
  clip: VdzClip
): { start: number; end: number } {
  let start = clip.start;
  let end = clip.start + clip.duration;
  const transitions = track.transitions ?? [];
  const index = track.clips.findIndex(c => c.id === clip.id);

  // A transition AFTER this clip extends its tail by half the duration — but
  // only when the NEXT clip actually abuts (a real crossfade, not a gap).
  const next = index >= 0 ? track.clips[index + 1] : undefined;
  if (next && Math.abs(end - next.start) < 1e-6) {
    for (const tr of transitions) {
      if (tr.afterClipId === clip.id) {
        end += tr.duration / 2;
      }
    }
  }

  // A transition after the PREVIOUS clip (whose boundary is this clip's start)
  // extends this clip's head earlier by half the duration, again only if the
  // clips abut.
  if (index > 0) {
    const prev = track.clips[index - 1];
    if (Math.abs(prev.start + prev.duration - clip.start) < 1e-6) {
      for (const tr of transitions) {
        if (tr.afterClipId === prev.id) {
          start -= tr.duration / 2;
        }
      }
    }
  }

  return { start, end };
}

/**
 * Compose the full ordered (back-to-front: video tracks first, then overlay)
 * list of preview items at `nowSeconds`. Audio tracks contribute nothing
 * visible. Pure and deterministic — the same timeline + playhead always yields
 * the identical frame, so this is the single source the preview renders from.
 */
export function computePreviewFrame(
  timeline: VdzTimeline,
  nowSeconds: number
): VdzPreviewItem[] {
  const items: VdzPreviewItem[] = [];

  for (const track of timeline.tracks) {
    if (track.kind === 'audio') continue;
    const transitions = track.transitions ?? [];

    for (const clip of track.clips) {
      const win = clipWindow(track, clip);
      if (nowSeconds < win.start || nowSeconds >= win.end) continue;

      const item: VdzPreviewItem = {
        clip,
        key: `${track.id}:${clip.id}`,
        visual: clipVisualStateAt(clip, nowSeconds),
        filter: effectsFilterCss(clip.effects),
      };

      // Transition where THIS clip is the outgoing side (transition after it).
      const idx = track.clips.findIndex(c => c.id === clip.id);
      const next = idx >= 0 ? track.clips[idx + 1] : undefined;
      const outgoing = transitions.find(
        tr =>
          tr.afterClipId === clip.id &&
          next &&
          Math.abs(clip.start + clip.duration - next.start) < 1e-6
      );
      if (outgoing) {
        const st = transitionStateAt(
          outgoing,
          clip.start + clip.duration,
          nowSeconds
        );
        if (st) item.transition = { state: st, role: 'out' };
      }

      // Transition where THIS clip is the incoming side (after the prev clip).
      if (!item.transition && idx > 0) {
        const prev = track.clips[idx - 1];
        const incoming = transitions.find(
          tr =>
            tr.afterClipId === prev.id &&
            Math.abs(prev.start + prev.duration - clip.start) < 1e-6
        );
        if (incoming) {
          const st = transitionStateAt(incoming, clip.start, nowSeconds);
          if (st) item.transition = { state: st, role: 'in' };
        }
      }

      items.push(item);
    }
  }

  return items;
}

/**
 * Fold a clip's base visual and any active transition into the FINAL opacity,
 * transform and clip-path the preview applies. Pure.
 */
export function resolveItemRender(item: VdzPreviewItem): {
  opacity: number;
  extraTranslateX: number;
  clipPath?: string;
} {
  let opacity = item.visual.opacity;
  let extraTranslateX = 0;
  let clipPath: string | undefined;

  const t = item.transition;
  if (t) {
    const { state, role } = t;
    if (state.kind === 'fade') {
      opacity *= role === 'out' ? state.outOpacity : state.inOpacity;
    } else if (state.kind === 'slide') {
      extraTranslateX =
        role === 'out' ? state.outTranslateX : state.inTranslateX;
    } else {
      // wipe: reveal the incoming clip via an inset clip-path from the left;
      // the outgoing clip stays fully drawn beneath it.
      if (role === 'in') {
        const hiddenRight = (1 - state.wipeReveal) * 100;
        clipPath = `inset(0 ${hiddenRight.toFixed(2)}% 0 0)`;
      }
    }
  }

  return { opacity, extraTranslateX, clipPath };
}
