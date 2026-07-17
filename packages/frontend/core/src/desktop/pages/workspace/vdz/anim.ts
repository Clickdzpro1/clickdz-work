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
  /**
   * Rotation in DEGREES, applied around the clip's center. Additive across
   * composed states (animation curves never set this — only a clip's static
   * `rotation` field contributes — so it composes cleanly with them).
   */
  rotate: number;
}

/** The neutral state: fully visible, no transform. */
export const IDENTITY_VISUAL: VdzClipVisualState = {
  opacity: 1,
  translateX: 0,
  translateY: 0,
  scale: 1,
  rotate: 0,
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

/**
 * Compose two visual states: multiply opacity/scale, add translates AND
 * rotations. Adding rotations means a clip's static `rotation` folds in without
 * clobbering an animation's transform (animations never set `rotate`).
 */
function composeVisual(
  a: VdzClipVisualState,
  b: VdzClipVisualState
): VdzClipVisualState {
  return {
    opacity: a.opacity * b.opacity,
    translateX: a.translateX + b.translateX,
    translateY: a.translateY + b.translateY,
    scale: a.scale * b.scale,
    rotate: a.rotate + b.rotate,
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
  // A clip's STATIC base: its own `opacity` (multiplies) and `rotation`
  // (composes) fold in even with NO animation. `staticVisualState` returns the
  // identity when both are absent, so a plain clip is unchanged.
  let state = staticVisualState(clip);

  const anim = clip.animation;
  if (!anim) return state;

  const end = clip.start + clip.duration;

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

/**
 * The static (time-independent) visual contribution of a clip: its own
 * `opacity` (0..1, multiplied into everything downstream) and `rotation`
 * (degrees, composed additively into the transform). Audio clips — and any
 * clip without these fields — yield the identity. Kept separate so both the
 * animated path ({@link clipVisualStateAt}) and any caller can reuse it.
 */
export function staticVisualState(clip: VdzClip): VdzClipVisualState {
  const opacity =
    typeof clip.opacity === 'number' ? clamp01(clip.opacity) : 1;
  const rotate = typeof clip.rotation === 'number' ? clip.rotation : 0;
  if (opacity === 1 && rotate === 0) return IDENTITY_VISUAL;
  return { ...IDENTITY_VISUAL, opacity, rotate };
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
  // Rotation last so it spins the already-centered/scaled box around its
  // center (the elements set transform-origin:center). Skipped when 0 so an
  // unrotated clip's transform string is byte-identical to before.
  if (state.rotate !== 0) {
    parts.push(`rotate(${state.rotate.toFixed(3)}deg)`);
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
    case 'vignette':
      // A vignette darkens the FRAME EDGES; there is no CSS `filter` for that,
      // so it contributes nothing to the filter string. It is rendered as an
      // overlay instead — see {@link vignetteOverlayCss} / {@link effectsOverlayCss}.
      return null;
    default: {
      // Exhaustiveness guard (see stateForKind).
      const _never: never = effect.kind;
      return _never;
    }
  }
}

// ---- Vignette (overlay, not a filter) -------------------------------------

/**
 * The CSS `box-shadow` value that paints a vignette for a normalized `amount`
 * (0..1). A vignette is an INSET shadow feathered inward from the clip's edges;
 * `amount` scales both the darkness and the spread. Rendered on an overlay that
 * fills the clip box (`position:absolute;inset:0`) so it darkens the corners
 * without touching the clip's own transform/opacity. Returns `null` at amount 0.
 */
export function vignetteBoxShadow(amount: number): string | null {
  const a = clamp01(amount);
  if (a <= 0) return null;
  // Feather (blur) grows with the clip; spread pulls the darkness inward.
  const blur = (12 + a * 28).toFixed(1);
  const spread = (a * 14).toFixed(1);
  const alpha = (0.15 + a * 0.65).toFixed(3);
  return `inset 0 0 ${blur}vmin ${spread}vmin rgba(0,0,0,${alpha})`;
}

/**
 * The full inline style for a vignette OVERLAY element covering a clip's box,
 * or `undefined` when the stack has no (non-zero) vignette. The strongest
 * vignette in the stack wins. The overlay is non-interactive and sits above the
 * clip content but inside its animated/opacity wrapper, so it fades and moves
 * with the clip. Consumed by the preview (an overlay div) and the compiler.
 */
export function vignetteOverlayCss(
  effects: VdzEffect[] | undefined
): string | undefined {
  if (!effects || effects.length === 0) return undefined;
  let strongest = 0;
  for (const e of effects) {
    if (e.kind === 'vignette' && e.amount > strongest) strongest = e.amount;
  }
  const shadow = vignetteBoxShadow(strongest);
  if (!shadow) return undefined;
  return (
    'position:absolute;inset:0;pointer-events:none;border-radius:inherit;' +
    `box-shadow:${shadow};`
  );
}

/**
 * Does this effect stack contain a (non-zero) vignette? Lets a renderer decide
 * whether to emit the overlay element at all, without re-scanning by hand.
 */
export function hasVignette(effects: VdzEffect[] | undefined): boolean {
  return (
    !!effects && effects.some(e => e.kind === 'vignette' && e.amount > 0)
  );
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
  /**
   * Blur radius in px for a DISSOLVE — a crossfade PLUS a slight defocus that
   * peaks mid-transition (0 at the ends) so the two clips melt together rather
   * than a hard opacity cut. Applied on top of the crossfade opacities.
   */
  dissolveBlurPx: number;
  /**
   * X translate (fraction of box) for a PUSH — the incoming clip shoves the
   * outgoing one off-screen, the pair moving in lockstep with NO opacity change.
   * `pushIn` runs 1 → 0 (enters from the right); `pushOut` runs 0 → -1 (leaves
   * to the left).
   */
  pushIn: number;
  pushOut: number;
  /**
   * `clip-path` circle radius fraction (0..1) revealing the incoming clip for
   * an IRIS. 0 = a closed circle (hidden), 1 = fully open (revealed). The
   * outgoing clip stays fully drawn beneath.
   */
  irisReveal: number;
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
  // Dissolve defocus: a bell that is 0 at both ends and peaks at the midpoint.
  const bell = Math.sin(p * Math.PI);
  return {
    kind: transition.kind,
    progress: p,
    outOpacity: 1 - eased,
    inOpacity: eased,
    // Incoming slides in from the right (1 → 0); outgoing slides out left.
    inTranslateX: 1 - eased,
    outTranslateX: -eased,
    wipeReveal: eased,
    // Dissolve = crossfade + a slight defocus peaking mid-transition (~6px).
    dissolveBlurPx: bell * 6,
    // Push = the pair travels in lockstep, incoming from the right pushing the
    // outgoing one out to the left (same geometry as a slide, no fade).
    pushIn: 1 - eased,
    pushOut: -eased,
    // Iris = a circle that opens from the center to reveal the incoming clip.
    irisReveal: eased,
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
  clip: VdzClip,
  index: number
): { start: number; end: number } {
  let start = clip.start;
  let end = clip.start + clip.duration;
  const transitions = track.transitions ?? [];

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

    // Enumerate by index so clipWindow + the transition-neighbour lookups reuse
    // the same `idx` instead of an O(n) findIndex each (was O(n²) per track).
    for (let idx = 0; idx < track.clips.length; idx++) {
      const clip = track.clips[idx];
      const win = clipWindow(track, clip, idx);
      if (nowSeconds < win.start || nowSeconds >= win.end) continue;

      const item: VdzPreviewItem = {
        clip,
        key: `${track.id}:${clip.id}`,
        visual: clipVisualStateAt(clip, nowSeconds),
        filter: effectsFilterCss(clip.effects),
      };

      // Transition where THIS clip is the outgoing side (transition after it).
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

      // Fold a DISSOLVE's time-varying defocus into `item.filter` now that the
      // transition (if any) is resolved, so the single `filter` prop the
      // preview and the compiler already read carries it — no extra plumbing.
      if (item.transition) {
        const { extraFilter } = resolveItemRender(item);
        if (extraFilter) item.filter = mergeFilters(item.filter, extraFilter);
      }

      items.push(item);
    }
  }

  return items;
}

/**
 * Fold a clip's base visual and any active transition into the FINAL opacity,
 * transform, clip-path and (transition-only) extra filter the preview applies.
 * Pure.
 *
 * `extraFilter` carries the DISSOLVE defocus blur — a time-varying `filter`
 * contribution that is NOT part of the clip's static effect stack. Callers
 * compose it after the effect filter (`computePreviewFrame` merges it into
 * `item.filter` so the preview and the exported keyframes both pick it up).
 */
export function resolveItemRender(item: VdzPreviewItem): {
  opacity: number;
  extraTranslateX: number;
  clipPath?: string;
  extraFilter?: string;
} {
  let opacity = item.visual.opacity;
  let extraTranslateX = 0;
  let clipPath: string | undefined;
  let extraFilter: string | undefined;

  const t = item.transition;
  if (t) {
    const { state, role } = t;
    if (state.kind === 'fade') {
      opacity *= role === 'out' ? state.outOpacity : state.inOpacity;
    } else if (state.kind === 'dissolve') {
      // dissolve: a crossfade (like fade) PLUS a slight defocus that peaks
      // mid-transition, so the two clips melt rather than hard-cut.
      opacity *= role === 'out' ? state.outOpacity : state.inOpacity;
      if (state.dissolveBlurPx > 0.01) {
        extraFilter = `blur(${state.dissolveBlurPx.toFixed(2)}px)`;
      }
    } else if (state.kind === 'slide') {
      extraTranslateX =
        role === 'out' ? state.outTranslateX : state.inTranslateX;
    } else if (state.kind === 'push') {
      // push: incoming and outgoing travel in lockstep (no fade) — the
      // incoming clip shoves the outgoing one off to the left.
      extraTranslateX = role === 'out' ? state.pushOut : state.pushIn;
    } else if (state.kind === 'iris') {
      // iris: a circle opens from the center revealing the incoming clip; the
      // outgoing clip stays fully drawn beneath it. A `circle()` radius of 75%
      // fully covers the box corners (the reference length is ~0.707·diagonal),
      // so scale reveal 0→1 onto 0→75% to end fully open.
      if (role === 'in') {
        const r = (state.irisReveal * 75).toFixed(2);
        clipPath = `circle(${r}% at 50% 50%)`;
      }
    } else {
      // wipe: reveal the incoming clip via an inset clip-path from the left;
      // the outgoing clip stays fully drawn beneath it.
      if (role === 'in') {
        const hiddenRight = (1 - state.wipeReveal) * 100;
        clipPath = `inset(0 ${hiddenRight.toFixed(2)}% 0 0)`;
      }
    }
  }

  return { opacity, extraTranslateX, clipPath, extraFilter };
}

/**
 * Merge a clip's static effect filter with an optional transition `extraFilter`
 * (the dissolve defocus). Either may be undefined; the result is `undefined`
 * when both are, so callers can omit the CSS prop. Kept as one helper so the
 * preview and the compiler combine them identically.
 */
export function mergeFilters(
  base: string | undefined,
  extra: string | undefined
): string | undefined {
  if (base && extra) return `${base} ${extra}`;
  return base ?? extra ?? undefined;
}

// ---- Caption presets (text clips) -----------------------------------------

/** A text clip's caption preset, as carried on the schema. */
export type VdzCaptionPreset =
  | 'plain'
  | 'boxed'
  | 'outline'
  | 'shadow'
  | 'pill'
  | 'karaoke';
/** A text clip's caption vertical-position preset. */
export type VdzCaptionPosition = 'top' | 'middle' | 'lower';

/** One karaoke word (clip-relative seconds), mirroring `vdzWordSchema`. */
export interface VdzCaptionWord {
  w: string;
  t0: number;
  t1: number;
}

/** The subset of a text clip the caption helpers read. */
export interface VdzCaptionInput {
  capPreset?: VdzCaptionPreset;
  capPosition?: VdzCaptionPosition;
  /** Explicit vertical anchor (fraction 0..1); when set it always wins. */
  y?: number;
  /** Per-word karaoke timings (clip-relative seconds); drives `karaoke`. */
  words?: VdzCaptionWord[];
}

/** Per-word highlight state at the current clip-relative playhead. */
export type VdzKaraokeWordState = 'spoken' | 'active' | 'upcoming';

/**
 * The default text drop-shadow the preview/compiler already apply to every
 * caption (mirrors `styles.previewText` / `clipBoxCss`). Exported so a preset
 * that overrides the shadow (e.g. `shadow`, `outline`) can compose from a known
 * baseline instead of a magic string.
 */
export const CAPTION_DEFAULT_TEXT_SHADOW = '0 2px 12px rgba(0,0,0,0.6)';

/**
 * Resolve a text clip's VERTICAL anchor fraction (0..1). An explicit `y` always
 * wins; otherwise a `capPosition` preset maps to a sensible third — top ≈ 0.08,
 * middle ≈ 0.5, lower ≈ 0.82 — and with neither we keep the legacy 0.5 center.
 * Pure; shared by the preview and the compiler so positioning stays identical.
 */
export function captionAnchorY(clip: VdzCaptionInput): number {
  if (typeof clip.y === 'number') return clip.y;
  switch (clip.capPosition) {
    case 'top':
      return 0.08;
    case 'middle':
      return 0.5;
    case 'lower':
      return 0.82;
    default:
      return 0.5;
  }
}

/**
 * The extra CSS a caption preset contributes, split into two buckets because
 * they live on different elements in the renderers:
 *   · `wrap`  — declarations for the positioned TEXT WRAPPER (the element that
 *               already carries left/top/transform): background pill, padding,
 *               border-radius, and any text-shadow override.
 *   · `text`  — declarations for the INNER text node: `-webkit-text-stroke`
 *               for the `outline` ring.
 * Both are plain `k:v;` declaration strings (possibly empty). `plain` yields
 * empty strings so a caption without a preset renders byte-identically to
 * before. Pure and shared, so the preview and export agree.
 */
export function captionPresetCss(clip: VdzCaptionInput): {
  wrap: string;
  text: string;
} {
  switch (clip.capPreset) {
    case 'boxed':
      // A rounded translucent slab behind the text.
      return {
        wrap:
          'background:rgba(0,0,0,0.55);padding:0.28em 0.6em;' +
          'border-radius:10px;',
        text: '',
      };
    case 'pill':
      // A tighter, fully-rounded pill with snug padding.
      return {
        wrap:
          'background:rgba(0,0,0,0.6);padding:0.16em 0.7em;' +
          'border-radius:999px;',
        text: '',
      };
    case 'outline':
      // A stroke ring around the glyphs; drop the soft shadow so the stroke
      // reads cleanly. Both webkit + standard stroke props for broad support.
      return {
        wrap: `text-shadow:none;`,
        text:
          '-webkit-text-stroke:0.06em rgba(0,0,0,0.85);' +
          'paint-order:stroke fill;',
      };
    case 'shadow':
      // A stronger, softer drop shadow than the default.
      return {
        wrap: 'text-shadow:0 4px 18px rgba(0,0,0,0.85);',
        text: '',
      };
    case 'karaoke':
      // A boxed-style pill slab behind the whole line; the per-word spans carry
      // their own spoken/active/upcoming colours on top (see karaokeWordCss).
      // The wrapper chrome is intentionally close to `boxed` so a karaoke
      // caption with NO words degrades to the familiar boxed look.
      return {
        wrap:
          'background:rgba(0,0,0,0.6);padding:0.24em 0.62em;' +
          'border-radius:12px;',
        text: '',
      };
    case 'plain':
    default:
      // No chrome — identical to pre-preset rendering.
      return { wrap: '', text: '' };
  }
}

// ---- Karaoke word highlighting (text clips) -------------------------------

/**
 * Accent colour used for the ACTIVE (currently spoken) karaoke word's highlight
 * pill/underline. A warm gold reads well on the dark caption slab in both the
 * preview and the exported HTML. Exported so the preview and the pure-CSS
 * compiler share ONE constant (no drift between the two renderers).
 */
export const KARAOKE_ACCENT = '#ffd54a';
/** Opacity applied to words not yet spoken (dimmed until their turn). */
export const KARAOKE_UPCOMING_OPACITY = 0.55;

/**
 * The active word index for a karaoke caption at clip-relative time `tRel`
 * (seconds from the clip's start), or -1 when no word is active (before the
 * first word, in a gap between words, or after the last). A word is active over
 * `[t0, t1)`; ties resolve to the FIRST matching word. When several windows
 * overlap we still pick the earliest that contains `tRel`, which keeps the
 * highlight monotonic. Pure — the same clip + `tRel` always yields the same
 * index, so the preview and any sampler agree.
 */
export function karaokeActiveIndex(
  words: readonly VdzCaptionWord[] | undefined,
  tRel: number
): number {
  if (!words || words.length === 0) return -1;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (tRel >= word.t0 && tRel < word.t1) return i;
  }
  return -1;
}

/**
 * Per-word karaoke state at clip-relative time `tRel`: the active word's index
 * plus a `state(i)` classifier every renderer shares. A word is `active` while
 * the playhead is inside its window; `spoken` once its start has passed (full
 * colour); `upcoming` before then (dimmed). When NO word is active yet (before
 * the first / in a gap), words already begun still read as `spoken` so the line
 * fills in naturally rather than snapping.
 *
 * Pure and deterministic; the preview calls it per frame and the exported CSS
 * mirrors the SAME thresholds via per-word animation delays (see
 * `compile-timeline.ts`), so preview and export highlight identically.
 */
export function karaokeProgress(
  clip: VdzCaptionInput,
  tRel: number
): {
  activeIndex: number;
  state: (index: number) => VdzKaraokeWordState;
} {
  const words = clip.words;
  const activeIndex = karaokeActiveIndex(words, tRel);
  const state = (index: number): VdzKaraokeWordState => {
    if (index === activeIndex) return 'active';
    const word = words?.[index];
    // Begun (its t0 has passed) → spoken; otherwise still upcoming. Using t0
    // (not the active window) means a word stays lit after its highlight ends.
    if (word && tRel >= word.t0) return 'spoken';
    return 'upcoming';
  };
  return { activeIndex, state };
}

/**
 * Inline style declarations for ONE karaoke word span in a given `state`,
 * returned as a plain `k:v;` block (so both the preview's `parseCssBlock` and
 * the compiler's verbatim emit consume it identically). `active` gets an accent
 * background pill + slight scale-up + underline; `spoken` is full-colour and
 * upright; `upcoming` is dimmed. A trailing space between words is added by the
 * renderer, not here. Pure and shared so preview/export match frame-for-frame.
 */
export function karaokeWordCss(state: VdzKaraokeWordState): string {
  // Common: each word is an inline-block so scale/padding don't reflow the box.
  const base =
    'display:inline-block;border-radius:6px;' +
    'transition:none;transform-origin:center bottom;';
  switch (state) {
    case 'active':
      return (
        base +
        `background:${KARAOKE_ACCENT};color:#1a1200;` +
        'padding:0 0.12em;transform:scale(1.08);' +
        `box-shadow:0 0 0.5em rgba(255,213,74,0.5);` +
        `text-decoration:underline;text-decoration-thickness:0.06em;`
      );
    case 'spoken':
      // Fully spoken: full colour, no pill, upright.
      return base + 'opacity:1;';
    case 'upcoming':
    default:
      // Not yet spoken: dimmed.
      return base + `opacity:${KARAOKE_UPCOMING_OPACITY};`;
  }
}

/**
 * Split a caption's `text` into display tokens paired with their karaoke word
 * timing, when the two align. Whisper word tokens carry their own spacing; here
 * we simply pair each `words[i]` with its trimmed display text and let the
 * renderer join with spaces. Returns `null` when there is nothing to karaoke
 * (no words) so callers fall back to the plain single-node text render.
 */
export function karaokeTokens(
  clip: VdzCaptionInput
): { w: string; t0: number; t1: number }[] | null {
  const words = clip.words;
  if (!words || words.length === 0) return null;
  return words.map(word => ({
    w: word.w.trim(),
    t0: word.t0,
    t1: word.t1,
  }));
}
