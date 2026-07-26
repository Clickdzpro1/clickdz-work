// ClickDz ShopERP — shared motion vocabulary.
//
// Why a module rather than ad-hoc transitions: this surface had no consistent
// motion at all. Buttons gave no press feedback, panels appeared instantly with
// no sense of where they came from, and the few animated things each invented
// their own duration and easing. The result feels less responsive than it
// actually is — perceived speed is mostly about whether the interface
// acknowledges you, not about milliseconds.
//
// Three rules the values below encode:
//
//  1. Feedback must be FASTER than you can notice (<=120ms). A press, a hover,
//     a toggle. Anything slower reads as lag rather than as a response.
//  2. Transitions that move content take 160-220ms with a decelerating curve,
//     so the eye can follow where a thing came from.
//  3. Nothing animates a layout-affecting property. Only `transform` and
//     `opacity`, which the compositor handles without re-running layout — this
//     matters enormously on the mid-range Android phones merchants actually
//     use, where animating `left` or `height` visibly stutters.
//
// Everything here is a plain string/object usable in the inline-style idiom the
// rest of shoperp uses. No dependency, nothing to import at runtime.

/** Durations in ms. Keep the vocabulary small — three tiers is enough. */
export const MOTION = {
  /** Press, hover, focus: acknowledgement, not animation. */
  instant: 90,
  /** The default for anything that moves or fades. */
  base: 170,
  /** Larger surfaces (a panel, a sheet) that need a beat to be readable. */
  slow: 240,
} as const;

/**
 * Easing curves.
 *
 * `exit` is symmetric; `enter` decelerates so an arriving element settles
 * rather than slamming to a stop; `spring` overshoots slightly and is reserved
 * for a genuinely positive confirmation (an order marked delivered, a shop
 * published) — used sparingly, because everything-bounces reads as a toy.
 */
export const EASE = {
  enter: 'cubic-bezier(0.16, 1, 0.3, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const;

/**
 * True when the user has asked their OS for reduced motion.
 *
 * Read at call time rather than cached: the setting can change mid-session,
 * and this is cheap. SSR-safe.
 */
export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

/**
 * Build a `transition` value, honouring reduced motion.
 *
 * Returns `'none'` when the user has asked for reduced motion, so callers can
 * pass the result straight to a style object without branching. Note this
 * disables the transition, NOT the end state — the UI still updates, it just
 * arrives immediately, which is exactly what the setting asks for.
 *
 * @example style={{ transition: transition('transform', 'opacity') }}
 */
export function transition(
  ...properties: string[]
): string {
  if (prefersReducedMotion()) return 'none';
  const props = properties.length ? properties : ['transform', 'opacity'];
  return props
    .map(p => `${p} ${MOTION.base}ms ${EASE.standard}`)
    .join(', ');
}

/** A fast feedback transition for press/hover states. */
export function feedbackTransition(...properties: string[]): string {
  if (prefersReducedMotion()) return 'none';
  const props = properties.length ? properties : ['transform', 'background'];
  return props
    .map(p => `${p} ${MOTION.instant}ms ${EASE.standard}`)
    .join(', ');
}

/**
 * The press-feedback style fragment for a button.
 *
 * Inline styles cannot express `:active`, and this surface deliberately avoids
 * .css.ts files, so the pressed state is driven by a boolean the component
 * already tracks (or by the CSS class injected below for the common case).
 */
export function pressedStyle(pressed: boolean) {
  if (prefersReducedMotion()) return {};
  return pressed ? { transform: 'scale(0.97)' } : { transform: 'scale(1)' };
}

/**
 * A single stylesheet injected once, giving every shoperp control real press
 * feedback and panels a subtle enter animation — the things inline styles
 * cannot express (`:active`, `@keyframes`, `@media`).
 *
 * Scoped under `[data-cdz-motion]` so it can only ever affect this surface,
 * never the surrounding AFFiNE chrome.
 */
export const SHOPERP_MOTION_CSS = `
[data-cdz-motion] button:not(:disabled),
[data-cdz-motion] a[role='button'] {
  transition: transform ${MOTION.instant}ms ${EASE.standard},
              background-color ${MOTION.instant}ms ${EASE.standard},
              border-color ${MOTION.instant}ms ${EASE.standard},
              opacity ${MOTION.instant}ms ${EASE.standard};
}
/* The press itself. Scale only — no layout, no repaint of neighbours. */
[data-cdz-motion] button:not(:disabled):active,
[data-cdz-motion] a[role='button']:active {
  transform: scale(0.97);
}
/* Panels fade up as they arrive, so switching tabs reads as a transition
   rather than a flash of different content. */
@keyframes cdz-panel-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}
[data-cdz-motion] [data-cdz-panel] {
  animation: cdz-panel-in ${MOTION.base}ms ${EASE.enter} both;
}
/* Skeleton shimmer for loading rows. */
@keyframes cdz-shimmer {
  from { background-position: -320px 0; }
  to   { background-position: 320px 0; }
}
[data-cdz-motion] [data-cdz-skeleton] {
  border-radius: 6px;
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, currentColor 9%, transparent) 50%,
    transparent 100%
  );
  background-size: 320px 100%;
  background-repeat: no-repeat;
  background-color: color-mix(in srgb, currentColor 7%, transparent);
  animation: cdz-shimmer 1.1s linear infinite;
}
/* Honour the OS setting: keep every END state, drop the movement. */
@media (prefers-reduced-motion: reduce) {
  [data-cdz-motion] button:not(:disabled),
  [data-cdz-motion] a[role='button'],
  [data-cdz-motion] [data-cdz-panel],
  [data-cdz-motion] [data-cdz-skeleton] {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
  [data-cdz-motion] button:not(:disabled):active,
  [data-cdz-motion] a[role='button']:active {
    transform: none;
  }
}
`;

const MOTION_STYLE_ID = 'cdz-shoperp-motion';

/**
 * Inject {@link SHOPERP_MOTION_CSS} once per document. Idempotent and safe to
 * call from any component's mount effect.
 */
export function ensureShoperpMotionCss(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(MOTION_STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = MOTION_STYLE_ID;
  el.textContent = SHOPERP_MOTION_CSS;
  document.head.appendChild(el);
}
