import { keyframes, style } from '@vanilla-extract/css';

import { accentAlpha, v, vdzTheme } from './theme.css';

/**
 * Vdz Studio — keyboard-shortcut cheatsheet overlay (QUILL / WS11).
 *
 * A modal PORTALED to document.body (see shortcut-cheatsheet.tsx) so its
 * `position: fixed` resolves against the viewport, not the studio header — the
 * exact export-dialog.css.ts recipe. Because the portal lands OUTSIDE the
 * studio's `vdzTheme` root, the backdrop carries `vdzTheme` itself (css
 * composition — never a runtime theme.css import) so the `--vdz-*` tokens
 * resolve on the portaled node.
 *
 * vanilla-extract landmine: this file exports ONLY plain `style()`/`keyframes`
 * results — never a function (dynamic CSS lives in plain `.ts`, see anim.ts).
 */

// Subtle entrance: the backdrop fades, the card fades + settles 6px. Both are
// transform/opacity only and are disabled under prefers-reduced-motion.
const backdropIn = keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const cardIn = keyframes({
  from: { opacity: 0, transform: 'translateY(6px) scale(0.985)' },
  to: { opacity: 1, transform: 'translateY(0) scale(1)' },
});

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
    animation: `${backdropIn} 160ms ease-out`,
    '@media': {
      '(prefers-reduced-motion: reduce)': {
        animation: 'none',
      },
    },
  },
]);

export const card = style({
  width: 'min(680px, 92vw)',
  maxHeight: '86vh',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 20,
  borderRadius: 14,
  border: `1px solid ${v.border}`,
  background: v.panel,
  color: v.text,
  boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
  animation: `${cardIn} 200ms ease-out`,
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animation: 'none',
    },
  },
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

// Two columns of shortcut sections; collapses to one on narrow viewports.
export const sectionsGrid = style({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '4px 24px',
  alignItems: 'start',
  '@media': {
    '(max-width: 560px)': {
      gridTemplateColumns: '1fr',
    },
  },
});

export const section = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  paddingTop: 8,
});

export const sectionTitle = style({
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: v.muted,
  padding: '0 0 4px',
});

// One shortcut row: description on the left, key chips right-aligned.
export const row = style({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '4px 6px',
  borderRadius: 6,
  ':hover': {
    background: accentAlpha(8),
  },
});

export const rowLabel = style({
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  lineHeight: 1.5,
  color: v.text,
});

export const keys = style({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
});

// One <kbd> chip. Monospace, slightly raised so it reads as a physical key.
export const kbd = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 20,
  height: 20,
  padding: '0 6px',
  borderRadius: 5,
  border: `1px solid ${v.border}`,
  borderBottomWidth: 2,
  background: v.raised,
  color: v.text,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 10.5,
  fontWeight: 600,
  lineHeight: 1,
  whiteSpace: 'nowrap',
});

// The "+" / "/" joiner between chips in a combo.
export const keyJoin = style({
  color: v.muted,
  fontSize: 10,
  lineHeight: 1,
});

// Footer hint line ("Press ? anytime · Esc closes").
export const footHint = style({
  fontSize: 11.5,
  color: v.muted,
  lineHeight: 1.5,
  paddingTop: 4,
  borderTop: `1px solid ${v.border}`,
});
