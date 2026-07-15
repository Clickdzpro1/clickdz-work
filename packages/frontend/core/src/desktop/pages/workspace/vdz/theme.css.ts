import { globalStyle, style } from '@vanilla-extract/css';

/**
 * Vdz Studio — theme bridge.
 *
 * The studio was built with a self-contained dark palette (literal hexes) so it
 * read identically regardless of the app theme. That made it ignore cdz themes
 * and light mode entirely. This module re-expresses that palette as a small set
 * of vdz-scoped CSS custom properties whose VALUES are the app's `--affine-*`
 * theme tokens, with the original hexes kept as FALLBACKS.
 *
 * Result:
 *  - When the affine tokens are present (always, in-app) the studio inherits the
 *    active theme — cdz palettes + light mode flow straight in.
 *  - When they're absent (isolated render / SSR before the token sheet loads)
 *    the fallbacks reproduce the original "Midnight" dark look byte-for-byte.
 *
 * Every other vdz `*.css.ts` file references ONLY these `--vdz-*` vars (never a
 * raw hex for chrome), so this file is the single source of truth for the
 * studio's surface colors. rgba() glows that referenced the old accent hexes are
 * rebuilt with `color-mix(in srgb, var(--vdz-accent) X%, transparent)` so they
 * track the themed accent too.
 *
 * `vdzTheme` is a marker class applied to every vdz surface root (the studio
 * shell, the AI dock, the media bin, the generate panel, the pulse ticker) so
 * the variables resolve on each independently-portaled island.
 */

// The variable *names*. Referenced by name (string) from the sibling css.ts
// files via `varName` so there's exactly one spelling of each token.
export const vars = {
  bg: '--vdz-bg',
  panel: '--vdz-panel',
  raised: '--vdz-raised',
  border: '--vdz-border',
  text: '--vdz-text',
  muted: '--vdz-muted',
  accent: '--vdz-accent',
  accent2: '--vdz-accent-2',
} as const;

// Convenience `var(--vdz-*)` references for use as CSS values in the other
// files. `v.accent` → 'var(--vdz-accent)'.
export const v = {
  bg: `var(${vars.bg})`,
  panel: `var(${vars.panel})`,
  raised: `var(${vars.raised})`,
  border: `var(${vars.border})`,
  text: `var(${vars.text})`,
  muted: `var(${vars.muted})`,
  accent: `var(${vars.accent})`,
  accent2: `var(${vars.accent2})`,
} as const;

/**
 * An `rgba`-style accent glow that tracks the (themed) accent color:
 * `color-mix(in srgb, var(--vdz-accent) <pct>%, transparent)`. Use anywhere the
 * old code hard-coded `rgba(91,140,255, a)`.
 */
export function accentAlpha(pct: number): string {
  return `color-mix(in srgb, ${v.accent} ${pct}%, transparent)`;
}

/** Same, for the secondary accent (old `rgba(160,107,255, a)`). */
export function accent2Alpha(pct: number): string {
  return `color-mix(in srgb, ${v.accent2} ${pct}%, transparent)`;
}

// The token bindings. Values are the app theme tokens; the trailing hex is the
// fallback that reproduces the original "Midnight" palette when a token is
// absent. These are the ONLY hexes in the studio's chrome now.
const BINDINGS: Record<string, string> = {
  [vars.bg]: 'var(--affine-v2-layer-background-primary, #0b0d12)',
  [vars.panel]: 'var(--affine-v2-layer-background-secondary, #12151d)',
  [vars.raised]: 'var(--affine-v2-layer-background-tertiary, #232838)',
  [vars.border]: 'var(--affine-border-color, #232838)',
  [vars.text]: 'var(--affine-v2-text-primary, #e6e9f2)',
  [vars.muted]: 'var(--affine-v2-text-secondary, #8b93a7)',
  [vars.accent]: 'var(--affine-primary-color, #5b8cff)',
  [vars.accent2]: 'var(--affine-brand-color, #a06bff)',
};

/**
 * Marker class for every vdz surface root. Carrying the class (rather than
 * relying on inheritance from one ancestor) means each portaled island — the
 * shell, the dock, the bin, the generate panel — defines the vars locally, so
 * they resolve even though the islands mount in separate DOM subtrees.
 */
export const vdzTheme = style({});

globalStyle(`.${vdzTheme}`, {
  vars: BINDINGS,
});
