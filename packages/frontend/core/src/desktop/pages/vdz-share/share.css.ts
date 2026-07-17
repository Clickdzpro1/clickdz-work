import { style } from '@vanilla-extract/css';

import { vdzTheme } from '../workspace/vdz/theme.css';

/**
 * Share-viewer page shell + controls. IMPORTANT: `vdzTheme` (which defines
 * the --vdz-* variables) must reach the page via CSS COMPOSITION here —
 * theme.css.ts exports a helper FUNCTION (`accentAlpha`), so importing it
 * from RUNTIME code trips vanilla-extract's "Invalid exports" rule. Every
 * vdz surface root follows this compose-in-css pattern.
 *
 * C6: mobile-first — ≥44px touch targets, a fat scrubber, wrapping control
 * row, tighter paddings under 640px. Share links get opened on phones.
 */

export const page = style([
  vdzTheme,
  {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
    padding: '32px 5vw 40px',
    background: 'var(--vdz-bg, #0b0d12)',
    color: 'var(--vdz-text, #e6e9f0)',
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    '@media': {
      '(max-width: 640px)': {
        gap: 12,
        padding: '16px 4vw 28px',
      },
    },
  },
]);

export const stage = style({
  width: 'min(960px, 100%)',
});

export const headRow = style({
  width: 'min(960px, 100%)',
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  minWidth: 0,
});

export const titleText = style({
  fontSize: 18,
  fontWeight: 700,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  '@media': {
    '(max-width: 640px)': {
      fontSize: 16,
    },
  },
});

export const badge = style({
  flexShrink: 0,
  fontSize: 12,
  color: 'var(--vdz-muted, #8a90a0)',
});

export const hint = style({
  color: 'var(--vdz-muted, #8a90a0)',
  fontSize: 13,
});

export const errorText = style({
  color: '#ff6b6b',
  fontSize: 13,
  lineHeight: 1.6,
});

export const controlsRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginTop: 12,
  flexWrap: 'wrap',
  '@media': {
    '(max-width: 640px)': {
      gap: 8,
    },
  },
});

export const playBtn = style({
  appearance: 'none',
  border: '1px solid var(--vdz-border, #262a35)',
  background: 'var(--vdz-raised, #191c25)',
  color: 'var(--vdz-text, #e6e9f0)',
  fontSize: 14,
  fontWeight: 600,
  minHeight: 44,
  minWidth: 96,
  padding: '0 16px',
  borderRadius: 10,
  cursor: 'pointer',
  // Kill double-tap zoom / 300ms delay on touch.
  touchAction: 'manipulation',
  WebkitTapHighlightColor: 'transparent',
  ':active': {
    background: 'var(--vdz-panel, #12141a)',
  },
});

export const scrubber = style({
  flex: 1,
  minWidth: 160,
  height: 44,
  margin: 0,
  accentColor: 'var(--vdz-accent, #5b8cff)',
  touchAction: 'pan-x',
  cursor: 'pointer',
  // A fat native thumb for fingers, WebKit + Gecko.
  selectors: {
    '&::-webkit-slider-thumb': {
      width: 22,
      height: 22,
    },
    '&::-moz-range-thumb': {
      width: 22,
      height: 22,
    },
  },
});

export const timeText = style({
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--vdz-muted, #8a90a0)',
  whiteSpace: 'nowrap',
});

export const footer = style({
  marginTop: 'auto',
  fontSize: 12,
  color: 'var(--vdz-muted, #8a90a0)',
  textAlign: 'center',
  padding: '12px 0 4px',
});

export const footerLink = style({
  color: 'var(--vdz-accent, #5b8cff)',
  fontWeight: 600,
  textDecoration: 'none',
});
