import { keyframes, style } from '@vanilla-extract/css';

import { accentAlpha, accent2Alpha, v, vdzTheme } from './theme.css';

/**
 * ClickDz Pulse — reasoning-animation ticker styles.
 *
 * A slim, tasteful status row: a soft pulsing dot + a single reasoning line that
 * crossfades as it changes. Theme-aware palette (see theme.css.ts): each token
 * is an `--affine-*` var with the original hex as a fallback, so the ticker
 * follows cdz themes + light mode. It carries the vdzTheme marker on its root so
 * the vars resolve even when it drops into a surface that hasn't defined them.
 *   raised   --vdz-panel   row background
 *   border   --vdz-border  hairline
 *   accent   --vdz-accent → --vdz-accent-2  (brand gradient / dot)
 *   text     --vdz-text    line
 */
const RAISED = v.panel;
const BORDER = v.border;
const ACCENT_FROM = v.accent;
const ACCENT_TO = v.accent2;
const TEXT = v.text;

// The dot's soft breathing pulse — scale + glow, no harsh blink. Glow tracks
// the themed accent via color-mix.
const pulse = keyframes({
  '0%, 100%': {
    transform: 'scale(0.82)',
    boxShadow: `0 0 0 0 ${accentAlpha(55)}`,
    opacity: 0.85,
  },
  '50%': {
    transform: 'scale(1.12)',
    boxShadow: `0 0 10px 3px ${accent2Alpha(45)}`,
    opacity: 1,
  },
});

// Line crossfade: a new line rises + fades in (keyed remount drives it).
const lineIn = keyframes({
  from: { opacity: 0, transform: 'translateY(4px)' },
  to: { opacity: 1, transform: 'translateY(0)' },
});

export const root = style([
  vdzTheme,
  {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    minHeight: 44,
    padding: '10px 14px',
    boxSizing: 'border-box',
    borderRadius: 12,
    border: `1px solid ${BORDER}`,
    background: RAISED,
    color: TEXT,
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    // Contain the crossfade so a rising line never spills outside the pill.
    overflow: 'hidden',
  },
]);

export const dot = style({
  flexShrink: 0,
  width: 9,
  height: 9,
  borderRadius: '50%',
  backgroundImage: `linear-gradient(135deg, ${ACCENT_FROM}, ${ACCENT_TO})`,
  animation: `${pulse} 1.4s ease-in-out infinite`,
  // Respect reduced-motion: hold a steady glow instead of pulsing.
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animation: 'none',
      opacity: 0.9,
    },
  },
});

export const lineWrap = style({
  position: 'relative',
  flex: 1,
  minWidth: 0,
  // Fixed line-height box so a taller/shorter line never nudges layout.
  height: 20,
  lineHeight: '20px',
});

export const line = style({
  display: 'block',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  fontSize: 13,
  fontWeight: 500,
  letterSpacing: '-0.005em',
  color: TEXT,
  animation: `${lineIn} 320ms ease`,
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animation: 'none',
    },
  },
});

// A dimmer variant once the script has looped into its tail — subtle signal
// that we're in the "still working" phase without changing the copy.
export const lineDone = style({
  opacity: 0.72,
});
