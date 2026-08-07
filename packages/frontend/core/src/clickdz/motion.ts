// clickdz/motion.ts
//
// cdz-motion — the ONE motion vocabulary for every ClickDz Work Hub surface.
// Generalised from the shipping `shoperp/motion.ts` (identical durations and
// easing curves, so nothing drifts) and moved beside `clickdz/responsive.ts`,
// which every studio already imports via `ensureClickDzResponsiveCss()`. Same
// pattern, same folder, so adoption is a one-line import each studio already
// knows.
//
// Stack-agnostic by design: it exports (a) plain string/number tokens usable
// from the inline-style studios (Hermes / OpenClaw / Agents / Voice / vpic /
// apps / shoperp), (b) reduced-motion-aware transition builders, and (c) ONE
// injectable global stylesheet scoped under `[data-cdz-motion]` so it can never
// leak into the AFFiNE editor chrome (mirrors `responsive.ts` and the shoperp
// motion sheet).
//
// House rules honoured: ZERO new dependency; motion is `transform` / `opacity`
// / `background-position` only (compositor-friendly on the mid-range Android
// phones the market actually uses); every animation has a
// `prefers-reduced-motion` fallback that preserves the END state; RTL is safe
// because horizontal keyframes are authored translateY/scale-only (never a
// signed translateX), matching the repo's `dir="rtl"` Arabic path.
//
// ADDITIVE: this is a NEW file. It does NOT replace `shoperp/motion.ts` or the
// per-studio spinners — those stay untouched in this change. It is adopted in a
// small number of low-risk spots (a skeleton loader) as a demonstration.

/** Durations (ms). Three tiers is the whole vocabulary — resist adding more. */
export const CDZ_DUR = {
  /** Press / hover / focus — acknowledgement, not animation. */
  instant: 90,
  /** The default for anything that moves or fades. */
  base: 170,
  /** Larger surfaces (a panel, a sheet, a tab crossfade) that need a beat. */
  slow: 240,
} as const;

/**
 * Easings. `enter` decelerates so an arriving element settles; `exit`
 * accelerates for leaving elements; `standard` is the symmetric default;
 * `spring` overshoots slightly and is reserved for a genuine positive
 * confirmation (used sparingly). Values are byte-identical to
 * `shoperp/motion.ts` EASE so the two vocabularies stay in sync.
 */
export const CDZ_EASE = {
  enter: 'cubic-bezier(0.16, 1, 0.3, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const;

/**
 * True when the user has asked their OS for reduced motion. Read at call time
 * (the setting can change mid-session) and SSR-safe.
 */
export function cdzReducedMotion(): boolean {
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
 * Build a `transition` value, honouring reduced motion. Returns `'none'` when
 * reduced motion is requested (the end state still applies — it just arrives
 * immediately). Defaults to `transform, opacity` when no properties are given.
 *
 * @example style={{ transition: cdzTransition('transform', 'opacity') }}
 */
export function cdzTransition(...props: string[]): string {
  if (cdzReducedMotion()) return 'none';
  const p = props.length ? props : ['transform', 'opacity'];
  return p.map(x => `${x} ${CDZ_DUR.base}ms ${CDZ_EASE.standard}`).join(', ');
}

/** A fast feedback transition for press/hover states. */
export function cdzFeedback(...props: string[]): string {
  if (cdzReducedMotion()) return 'none';
  const p = props.length ? props : ['transform', 'background-color'];
  return p.map(x => `${x} ${CDZ_DUR.instant}ms ${CDZ_EASE.standard}`).join(', ');
}

/**
 * Per-item stagger delay for lists. Caps at `max` items so a long list never
 * waits more than ~`max * step`ms for its last row (delay past that reads as
 * lag). Returns `'0ms'` under reduced motion.
 */
export function cdzStagger(index: number, step = 35, max = 8): string {
  if (cdzReducedMotion()) return '0ms';
  return `${Math.min(index, max) * step}ms`;
}

const STYLE_ID = 'cdz-motion';

/**
 * The one global sheet. Scoped under `[data-cdz-motion]` so it can only ever
 * affect a CDZ surface, never the surrounding AFFiNE chrome. Every keyframe is
 * `transform` / `opacity` / `background-position` only, and the trailing
 * reduced-motion block neutralises all of it while keeping end states.
 */
export const CDZ_MOTION_CSS = `
/* ---- Press / hover feedback on every control -------------------------- */
[data-cdz-motion] button:not(:disabled),
[data-cdz-motion] [role='button']:not([aria-disabled='true']) {
  transition: transform ${CDZ_DUR.instant}ms ${CDZ_EASE.standard},
              background-color ${CDZ_DUR.instant}ms ${CDZ_EASE.standard},
              border-color ${CDZ_DUR.instant}ms ${CDZ_EASE.standard},
              box-shadow ${CDZ_DUR.instant}ms ${CDZ_EASE.standard},
              opacity ${CDZ_DUR.instant}ms ${CDZ_EASE.standard};
}
[data-cdz-motion] button:not(:disabled):active,
[data-cdz-motion] [role='button']:not([aria-disabled='true']):active {
  transform: scale(0.97);
}

/* ---- Panel / page enter ---------------------------------------------- */
@keyframes cdz-panel-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
[data-cdz-motion] [data-cdz-panel] {
  animation: cdz-panel-in ${CDZ_DUR.base}ms ${CDZ_EASE.enter} both;
}

/* ---- List / staggered rows (delay set inline via --cdz-delay) -------- */
@keyframes cdz-row-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
[data-cdz-motion] [data-cdz-row] {
  animation: cdz-row-in ${CDZ_DUR.base}ms ${CDZ_EASE.enter} both;
  animation-delay: var(--cdz-delay, 0ms);
}

/* ---- Tab crossfade (mount the new panel with this) ------------------- */
@keyframes cdz-tab-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
[data-cdz-motion] [data-cdz-tabpanel] {
  animation: cdz-tab-in ${CDZ_DUR.slow}ms ${CDZ_EASE.enter} both;
}

/* ---- Skeleton shimmer (currentColor-based; themes for free) ---------- */
@keyframes cdz-shimmer { from { background-position: -320px 0; } to { background-position: 320px 0; } }
[data-cdz-motion] [data-cdz-skeleton] {
  border-radius: 6px;
  background-color: color-mix(in srgb, currentColor 7%, transparent);
  background-image: linear-gradient(90deg, transparent 0%,
    color-mix(in srgb, currentColor 9%, transparent) 50%, transparent 100%);
  background-size: 320px 100%;
  background-repeat: no-repeat;
  animation: cdz-shimmer 1.1s linear infinite;
}
/* RTL: mirror the sweep so it travels the reading direction. */
[dir='rtl'] [data-cdz-motion] [data-cdz-skeleton],
[data-cdz-motion][dir='rtl'] [data-cdz-skeleton] {
  animation-direction: reverse;
}

/* ---- AI "thinking" dots (streaming not yet started) ------------------ */
@keyframes cdz-think { 0%,80%,100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
[data-cdz-motion] [data-cdz-thinking] { display: inline-flex; gap: 4px; }
[data-cdz-motion] [data-cdz-thinking] i {
  width: 5px; height: 5px; border-radius: 50%; background: currentColor;
  animation: cdz-think 1.2s ease-in-out infinite;
}
[data-cdz-motion] [data-cdz-thinking] i:nth-child(2) { animation-delay: .15s; }
[data-cdz-motion] [data-cdz-thinking] i:nth-child(3) { animation-delay: .30s; }

/* ---- Streaming caret (token stream in progress) ---------------------- */
@keyframes cdz-caret { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
[data-cdz-motion] [data-cdz-caret]::after {
  content: ''; display: inline-block; width: 2px; height: 1em;
  margin-inline-start: 1px; vertical-align: -2px; background: currentColor;
  animation: cdz-caret 1s steps(1) infinite;
}

/* ---- ONE spinner (transform-only, compositor-friendly) --------------- */
@keyframes cdz-spin { to { transform: rotate(360deg); } }
[data-cdz-motion] [data-cdz-spin] { animation: cdz-spin .7s linear infinite; }

/* ---- Success pop (spring — reserved for real confirmations) ---------- */
@keyframes cdz-pop { 0% { transform: scale(.6); opacity: 0; } 60% { transform: scale(1.08); } 100% { transform: scale(1); opacity: 1; } }
[data-cdz-motion] [data-cdz-success] { animation: cdz-pop ${CDZ_DUR.slow}ms ${CDZ_EASE.spring} both; }

/* ---- Toast in (translateY only → identical in LTR and RTL) ----------- */
@keyframes cdz-toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
[data-cdz-motion] [data-cdz-toast] { animation: cdz-toast-in ${CDZ_DUR.base}ms ${CDZ_EASE.enter} both; }

/* ---- Honour the OS setting: keep END states, drop movement ----------- */
@media (prefers-reduced-motion: reduce) {
  [data-cdz-motion] * {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
  [data-cdz-motion] button:not(:disabled):active,
  [data-cdz-motion] [role='button']:not([aria-disabled='true']):active { transform: none; }
  [data-cdz-motion] [data-cdz-skeleton] { animation: none !important; }
}
`;

/**
 * Inject {@link CDZ_MOTION_CSS} once per document. Idempotent and SSR-safe,
 * mirroring `ensureClickDzResponsiveCss()` / `ensureShoperpMotionCss()`. Call
 * it in a studio's mount effect right beside the responsive helper.
 */
export function ensureCdzMotionCss(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CDZ_MOTION_CSS;
  document.head.appendChild(el);
}
