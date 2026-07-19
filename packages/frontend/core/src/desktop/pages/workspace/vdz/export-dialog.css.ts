import { style } from '@vanilla-extract/css';

import { accentAlpha, v, vdzTheme } from './theme.css';

/**
 * Vdz Studio — export dialog (engine choice + summary before rendering).
 *
 * A modal PORTALED to document.body (see export-dialog.tsx) so its
 * `position: fixed` resolves against the viewport, not the studio header
 * (a transformed/contained ancestor that would otherwise clip it). Because the
 * portal lands OUTSIDE the studio's `vdzTheme` root, the backdrop carries
 * `vdzTheme` itself (css composition — never a runtime theme.css import) so the
 * `--vdz-*` tokens resolve on the portaled node. Mirrors template-gallery.css.ts.
 */

export const backdrop = style([
  vdzTheme,
  {
    position: 'fixed',
    inset: 0,
    zIndex: 2147483000, // above the studio header + any workbench chrome
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.55)',
    backdropFilter: 'blur(2px)',
  },
]);

export const card = style({
  width: 'min(560px, 92vw)',
  maxHeight: '86vh',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: 20,
  borderRadius: 14,
  border: `1px solid ${v.border}`,
  background: v.panel,
  color: v.text,
  boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
});

export const headRow = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
});

export const title = style({
  fontSize: 18,
  fontWeight: 700,
  lineHeight: 1.3,
});

export const subtitle = style({
  fontSize: 12.5,
  color: v.muted,
  lineHeight: 1.6,
});

export const closeBtn = style({
  appearance: 'none',
  marginLeft: 'auto',
  flexShrink: 0,
  border: `1px solid ${v.border}`,
  background: v.raised,
  color: v.muted,
  fontSize: 13,
  lineHeight: 1,
  width: 26,
  height: 26,
  borderRadius: 8,
  cursor: 'pointer',
  ':hover': {
    color: v.text,
    borderColor: v.accent,
  },
});

/** Section label above the engine cards / summary grid. */
export const sectionLabel = style({
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: v.muted,
});

// ---- Engine choice cards ---------------------------------------------------

export const engineRow = style({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
  '@media': {
    '(max-width: 460px)': {
      gridTemplateColumns: '1fr',
    },
  },
});

export const engineCard = style({
  appearance: 'none',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 6,
  padding: '12px 12px 13px',
  borderRadius: 10,
  border: `1px solid ${v.border}`,
  background: v.raised,
  color: v.text,
  textAlign: 'left',
  cursor: 'pointer',
  position: 'relative',
  transition: 'border-color 150ms ease, background 150ms ease',
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      transition: 'none',
    },
  },
  ':hover': {
    borderColor: v.accent,
  },
  selectors: {
    '&[data-selected="true"]': {
      borderColor: v.accent,
      background: accentAlpha(12),
      boxShadow: `0 0 0 1px ${v.accent}`,
    },
  },
});

export const engineHead = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
});

export const engineName = style({
  fontSize: 13.5,
  fontWeight: 700,
});

/** Small "beta" tag on the Remotion card. */
export const betaBadge = style({
  fontSize: 9.5,
  fontWeight: 700,
  lineHeight: 1,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  padding: '3px 6px',
  borderRadius: 6,
  color: v.text,
  border: `1px solid ${v.border}`,
  background: accentAlpha(18),
});

/** The little selected-state radio dot pushed to the right of the head row. */
export const radioDot = style({
  marginLeft: 'auto',
  flexShrink: 0,
  width: 16,
  height: 16,
  borderRadius: 999,
  border: `1px solid ${v.border}`,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  selectors: {
    [`${engineCard}[data-selected="true"] &`]: {
      borderColor: v.accent,
    },
  },
});

export const radioDotInner = style({
  width: 8,
  height: 8,
  borderRadius: 999,
  background: v.accent,
});

export const engineDesc = style({
  fontSize: 11.5,
  color: v.muted,
  lineHeight: 1.5,
});

// ---- Summary grid (resolution / duration / fps) ----------------------------

export const summary = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 10,
});

export const summaryItem = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  padding: '9px 11px',
  borderRadius: 9,
  border: `1px solid ${v.border}`,
  background: v.bg,
});

export const summaryLabel = style({
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: v.muted,
});

export const summaryValue = style({
  fontSize: 14,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  color: v.text,
});

// ---- Inline warning (classic + long timeline) ------------------------------

export const warning = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '10px 12px',
  borderRadius: 9,
  fontSize: 12,
  lineHeight: 1.5,
  color: v.text,
  border: '1px solid color-mix(in srgb, #f5a623 55%, transparent)',
  background: 'color-mix(in srgb, #f5a623 12%, transparent)',
});

export const warningIcon = style({
  flexShrink: 0,
  lineHeight: 1.4,
});

// ---- Footer actions --------------------------------------------------------

export const actions = style({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 2,
});

export const btn = style({
  appearance: 'none',
  border: `1px solid ${v.border}`,
  background: v.raised,
  color: v.text,
  fontSize: 12.5,
  fontWeight: 600,
  padding: '8px 16px',
  borderRadius: 8,
  cursor: 'pointer',
  ':hover': {
    borderColor: v.accent,
    background: accentAlpha(12),
  },
});

export const btnPrimary = style([
  btn,
  {
    border: `1px solid ${v.accent}`,
    background: v.accent,
    color: '#ffffff',
    ':hover': {
      background: `color-mix(in srgb, ${v.accent} 88%, #ffffff)`,
      borderColor: v.accent,
    },
  },
]);
