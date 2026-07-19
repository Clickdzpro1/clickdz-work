import { keyframes, style } from '@vanilla-extract/css';

import { accentAlpha, v } from './theme.css';

/**
 * Vdz timeline — professional-editor polish styles.
 *
 * Owned by METRON (the timeline ruler + lanes). Kept OUT of the big shared
 * `index.css.ts` (which another agent owns) so ruler/playhead/hover chrome can
 * evolve independently. Every export here is a plain `style()` value — no
 * runtime CSS functions live in a `.css.ts` (vanilla-extract landmine); all
 * colors flow through the themed `--vdz-*` tokens via `v.*` / `accentAlpha()`
 * exactly like the sibling stylesheets, so light mode + cdz palettes track.
 *
 * These classes are ADDITIVE — the components still use the existing
 * `index.css.ts` ruler/lane/playhead classes and layer these on top, so
 * removing this file degrades to today's look rather than breaking layout.
 */

const border = v.border;
const text = v.text;
const textDim = v.muted;
const accent = v.accent;
const panel = v.panel;

// ---- Adaptive ruler -----------------------------------------------------

// The ruler surface. Mirrors index.css `ruler` (height/border) but is the
// dedicated adaptive-ruler root so tick math + labels are self-contained.
// `overflow: hidden` clips the last label if it would spill past the span.
export const ruler = style({
  position: 'relative',
  // Kept at 22px to match the label column's `laneLabelRulerSpacer` so the
  // fixed lane labels stay vertically aligned with their lane rows.
  height: 22,
  borderBottom: `1px solid ${border}`,
  userSelect: 'none',
  // Faint baseline sheen so the ruler reads as its own strip over the lanes.
  background: `linear-gradient(to bottom, ${accentAlpha(4)}, transparent 60%)`,
});

// A tick: a hairline positioned by inline `left`. Height comes from the
// major/minor modifiers below. `width: 1px` + integer `left` (rounded in the
// component) keeps lines crisp — no blurry half-pixel anti-aliasing.
export const tick = style({
  position: 'absolute',
  bottom: 0,
  width: 1,
  // Nudge onto the device pixel grid; the component rounds `left` too.
  transform: 'translateX(-0.5px)',
});

export const tickMinor = style({
  height: 5,
  background: border,
  opacity: 0.9,
});

// A mid-level tick (the subdivision that sits between minors and majors when
// the ladder subdivides by more than 2) — slightly taller than a minor.
export const tickMid = style({
  height: 8,
  background: textDim,
  opacity: 0.7,
});

export const tickMajor = style({
  height: 12,
  background: textDim,
});

// Major-tick label. Anchored just right of its tick, baseline near the top so
// it clears the tick marks. Monospace + tabular figures so digits never jitter
// as the playhead-adjacent numbers change width.
export const label = style({
  position: 'absolute',
  top: 2,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 10,
  lineHeight: '12px',
  color: textDim,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  fontVariantNumeric: 'tabular-nums',
  // Small left offset off the tick; component sets `left` inline.
  paddingLeft: 4,
});

// ---- Playhead readout chip ---------------------------------------------

// Floating time/frame readout that stays pinned to the top-left of the visible
// lanes area while the content scrolls horizontally (`position: sticky` on the
// x axis via a wrapper; the chip itself is the visible pill). Sits above the
// ruler line so it reads as an editor HUD.
export const readoutChip = style({
  position: 'absolute',
  top: 3,
  right: 8,
  zIndex: 12,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  height: 18,
  padding: '0 8px',
  borderRadius: 999,
  border: `1px solid ${accentAlpha(45)}`,
  background: `color-mix(in srgb, ${panel} 82%, transparent)`,
  backdropFilter: 'blur(4px)',
  boxShadow: `0 1px 6px ${accentAlpha(22)}`,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
  color: text,
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
});

// The mm:ss.ff portion — primary emphasis.
export const readoutTime = style({
  fontWeight: 600,
  letterSpacing: 0.2,
});

// The "· 123f" frame portion — dimmed, separated by the accent dot.
export const readoutFrame = style({
  color: textDim,
  fontWeight: 500,
});

export const readoutDot = style({
  width: 4,
  height: 4,
  borderRadius: '50%',
  background: accent,
  flexShrink: 0,
});

// ---- Refined playhead ---------------------------------------------------

// Full-height playhead line spanning the lane stack. Replaces the flat 2px bar
// with a crisper 2px line plus a soft glow so it reads over bright clips. The
// component sets `left` inline (integer-rounded for crispness) and drives the
// vertical position via the containing lane stack (top:0/bottom:0).
export const playhead = style({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 2,
  background: accent,
  pointerEvents: 'none',
  zIndex: 8,
  transform: 'translateX(-1px)',
  boxShadow: `0 0 6px ${accentAlpha(65)}, 0 0 1px ${accentAlpha(90)}`,
});

// A small diamond/triangle cap at the very top of the playhead so its exact
// column is obvious where it meets the ruler. Purely decorative.
export const playheadCap = style({
  position: 'absolute',
  top: -3,
  left: '50%',
  width: 8,
  height: 8,
  transform: 'translateX(-50%) rotate(45deg)',
  background: accent,
  borderRadius: 1,
  boxShadow: `0 0 5px ${accentAlpha(70)}`,
});

// ---- Hover time indicator (ghost line + tooltip) ------------------------

// A thin ghost line following the pointer across the lanes. Positioned with a
// `transform: translateX()` the component updates directly (no React state, no
// re-layout) so it stays smooth. Hidden (opacity 0) until the pointer enters.
export const hoverLine = style({
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: 0,
  width: 1,
  background: `color-mix(in srgb, ${text} 55%, transparent)`,
  pointerEvents: 'none',
  zIndex: 7,
  opacity: 0,
  transition: 'opacity 120ms ease',
  willChange: 'transform',
});

// Shown-state modifier toggled by the component (adds the class on enter).
export const hoverLineVisible = style({
  opacity: 0.7,
});

// The time tooltip riding at the top of the ghost line. Also transform-driven.
export const hoverTip = style({
  position: 'absolute',
  top: 2,
  left: 0,
  zIndex: 9,
  maxWidth: 'none',
  padding: '1px 6px',
  borderRadius: 5,
  border: `1px solid ${border}`,
  background: `color-mix(in srgb, ${panel} 90%, transparent)`,
  color: text,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 10,
  lineHeight: '14px',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  opacity: 0,
  transition: 'opacity 120ms ease',
  transform: 'translateX(-50%)',
  willChange: 'transform',
});

export const hoverTipVisible = style({
  opacity: 1,
});

// ---- Empty-lane hint ----------------------------------------------------

// Centered, unobtrusive hint shown on a lane that has no clips. A dashed inner
// frame echoes the "droppable" affordance without any heavy chrome.
export const emptyHint = style({
  position: 'absolute',
  inset: 4,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 5,
  border: `1px dashed ${accentAlpha(28)}`,
  color: textDim,
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0.2,
  pointerEvents: 'none',
  userSelect: 'none',
  opacity: 0.7,
  gap: 6,
});

// A subtle pulse for the drop icon inside the empty hint so an empty timeline
// gently invites a drop. Respects reduced motion.
const hintPulse = keyframes({
  '0%, 100%': { opacity: 0.55 },
  '50%': { opacity: 0.95 },
});

export const emptyHintIcon = style({
  fontSize: 12,
  animation: `${hintPulse} 2.4s ease-in-out infinite`,
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animation: 'none',
    },
  },
});

// ---- Lane header spacing (label column consistency) ---------------------

// A refined label cell used alongside the existing `laneLabelCell`. It pins the
// vertical rhythm to the lane rows (40px lane + 6px gap = 46px pitch) and adds
// a track-kind color pip so the header reads as "which lane is this". The
// component sets the pip color inline (from TRACK_COLORS) to avoid encoding
// kind→color twice.
export const laneHeaderCell = style({
  height: 40,
  marginTop: 6,
  paddingRight: 6,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 6,
  fontSize: 11,
  fontWeight: 600,
  color: textDim,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  boxSizing: 'border-box',
  selectors: {
    '&:first-of-type': {
      marginTop: 0,
    },
  },
});

export const laneHeaderPip = style({
  width: 7,
  height: 7,
  borderRadius: 2,
  flexShrink: 0,
});
