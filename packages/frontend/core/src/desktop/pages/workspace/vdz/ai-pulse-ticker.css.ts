import { keyframes, style } from '@vanilla-extract/css';

/**
 * ClickDz Pulse — reasoning-animation ticker styles.
 *
 * A slim, tasteful status row: a soft pulsing dot + a single reasoning line that
 * crossfades as it changes. Self-contained dark palette (literal hex, no theme
 * tokens) matching the vdz generate panel so it drops into any busy surface
 * without theme wiring:
 *   raised   #12151d   row background
 *   border   #232838   hairline
 *   accent   #5b8cff → #a06bff  (brand gradient / dot)
 *   text     #e7eaf3   line
 */
const RAISED = '#12151d';
const BORDER = '#232838';
const ACCENT_FROM = '#5b8cff';
const ACCENT_TO = '#a06bff';
const TEXT = '#e7eaf3';

// The dot's soft breathing pulse — scale + glow, no harsh blink.
const pulse = keyframes({
  '0%, 100%': {
    transform: 'scale(0.82)',
    boxShadow: `0 0 0 0 rgba(91,140,255,0.55)`,
    opacity: 0.85,
  },
  '50%': {
    transform: 'scale(1.12)',
    boxShadow: `0 0 10px 3px rgba(160,107,255,0.45)`,
    opacity: 1,
  },
});

// Line crossfade: a new line rises + fades in (keyed remount drives it).
const lineIn = keyframes({
  from: { opacity: 0, transform: 'translateY(4px)' },
  to: { opacity: 1, transform: 'translateY(0)' },
});

export const root = style({
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
});

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
