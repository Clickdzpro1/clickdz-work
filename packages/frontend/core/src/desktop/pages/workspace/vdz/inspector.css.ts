import { style } from '@vanilla-extract/css';

import { accentAlpha, v } from './theme.css';

/**
 * Inspector-only styles — the friendlier, professional control set (quick
 * actions, rename, timing inputs, swatches, mute, collapsible section headers,
 * drag-to-scrub numeric inputs, slider value bubbles, reset affordances and the
 * no-selection Project panel). Shared panel chrome stays in index.css.ts;
 * everything here references the `--vdz-*` theme bridge only (never raw hex for
 * chrome), per the theming contract.
 *
 * NOTE (vanilla-extract landmine): this file exports ONLY plain `style()`
 * values — never a function. All dynamic/runtime styling (active pills, etc.)
 * is done with inline styles in inspector.tsx, matching the sibling panels.
 */

// ---- Quick actions (Duplicate / Delete / Ripple) --------------------------

export const quickRow = style({
  display: 'flex',
  gap: 6,
});

export const quickBtn = style({
  appearance: 'none',
  flex: 1,
  minWidth: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
  border: `1px solid ${v.border}`,
  background: v.raised,
  color: v.text,
  fontSize: 11,
  fontWeight: 600,
  padding: '5px 6px',
  borderRadius: 7,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  ':hover': {
    borderColor: v.accent,
    background: accentAlpha(12),
  },
});

export const quickBtnDanger = style([
  quickBtn,
  {
    ':hover': {
      color: '#ff6b6b',
      borderColor: '#ff6b6b',
      background: 'color-mix(in srgb, #ff6b6b 12%, transparent)',
    },
  },
]);

// ---- Rename ---------------------------------------------------------------

export const renameInput = style({
  appearance: 'none',
  width: '100%',
  border: `1px solid ${v.border}`,
  background: v.bg,
  color: v.text,
  fontSize: 12,
  fontWeight: 600,
  padding: '5px 8px',
  borderRadius: 7,
  outline: 'none',
  ':focus': {
    borderColor: v.accent,
    boxShadow: `0 0 0 2px ${accentAlpha(25)}`,
  },
});

// ---- Collapsible section headers -------------------------------------------

export const sectionToggle = style({
  appearance: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  border: 'none',
  background: 'transparent',
  color: v.muted,
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  cursor: 'pointer',
  padding: 0,
  ':hover': {
    color: v.text,
  },
});

export const sectionChevron = style({
  display: 'inline-block',
  width: 10,
  fontSize: 10,
  color: v.muted,
});

export const sectionCount = style({
  marginLeft: 'auto',
  fontSize: 10,
  fontWeight: 600,
  color: v.muted,
  border: `1px solid ${v.border}`,
  borderRadius: 999,
  padding: '1px 7px',
});

// ---- Numeric timing / scrub inputs -----------------------------------------

export const numRow = style({
  display: 'flex',
  gap: 8,
});

export const numInput = style({
  appearance: 'none',
  width: '100%',
  border: `1px solid ${v.border}`,
  background: v.bg,
  color: v.text,
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  padding: '5px 8px',
  borderRadius: 7,
  outline: 'none',
  ':focus': {
    borderColor: v.accent,
    boxShadow: `0 0 0 2px ${accentAlpha(25)}`,
  },
});

/**
 * A number input that also supports drag-to-scrub. The `data-scrub` attribute
 * is toggled by the component while a horizontal drag is active; the ew-resize
 * cursor + accent ring signal the gesture. Typing works exactly as a normal
 * number input (drag only starts on a horizontal pointer move past a threshold).
 */
export const scrubInput = style([
  numInput,
  {
    cursor: 'ew-resize',
    // Hide the native spinner so the field reads as a scrubbable value; typing
    // still works and Up/Down arrows are handled explicitly in the component.
    MozAppearance: 'textfield',
    selectors: {
      '&::-webkit-outer-spin-button': {
        WebkitAppearance: 'none',
        margin: 0,
      },
      '&::-webkit-inner-spin-button': {
        WebkitAppearance: 'none',
        margin: 0,
      },
      '&[data-scrub="true"]': {
        borderColor: v.accent,
        boxShadow: `0 0 0 2px ${accentAlpha(25)}`,
      },
    },
  },
]);

// A small unit suffix ("s", "°", "%", "px") sitting inside/after a numeric field.
export const unitTag = style({
  flexShrink: 0,
  fontSize: 10,
  fontWeight: 600,
  color: v.muted,
  fontVariantNumeric: 'tabular-nums',
});

// A field whose input + unit + reset sit on one line.
export const inlineField = style({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
});

// ---- Slider (range) with a value bubble ------------------------------------

// Wraps a native range + an absolutely-positioned value bubble that tracks the
// thumb. The component sets the bubble's `left` inline from the value.
export const rangeWrap = style({
  position: 'relative',
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  // Extra top room so the bubble floats above the track without clipping.
  paddingTop: 2,
});

export const rangeBubble = style({
  position: 'absolute',
  top: -16,
  transform: 'translateX(-50%)',
  pointerEvents: 'none',
  padding: '1px 6px',
  borderRadius: 999,
  border: `1px solid ${v.border}`,
  background: v.raised,
  color: v.text,
  fontSize: 10,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  opacity: 0,
  transition: 'opacity 150ms ease',
  selectors: {
    '&[data-show="true"]': {
      opacity: 1,
    },
  },
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      transition: 'none',
    },
  },
});

// ---- Reset-to-default affordance -------------------------------------------

// A tiny "↺" button shown next to a control that has a known default. Disabled
// (dimmed, non-interactive) when the value already equals the default.
export const resetBtn = style({
  appearance: 'none',
  flexShrink: 0,
  border: `1px solid ${v.border}`,
  background: v.raised,
  color: v.muted,
  fontSize: 11,
  lineHeight: 1,
  width: 22,
  height: 22,
  borderRadius: 6,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'color 150ms ease, border-color 150ms ease, opacity 150ms ease',
  ':hover': {
    color: v.text,
    borderColor: v.accent,
  },
  selectors: {
    '&:disabled': {
      opacity: 0.35,
      cursor: 'default',
    },
  },
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      transition: 'none',
    },
  },
});

// ---- Volume row (slider + % + mute) ----------------------------------------

export const volumeRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
});

export const pctBadge = style({
  flexShrink: 0,
  minWidth: 42,
  textAlign: 'right',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
  color: v.muted,
});

export const muteBtn = style({
  appearance: 'none',
  flexShrink: 0,
  border: `1px solid ${v.border}`,
  background: v.raised,
  color: v.text,
  fontSize: 12,
  lineHeight: 1,
  width: 26,
  height: 24,
  borderRadius: 7,
  cursor: 'pointer',
  ':hover': {
    borderColor: v.accent,
    background: accentAlpha(12),
  },
});

// ---- Color swatches ----------------------------------------------------------

export const colorRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
});

export const swatch = style({
  appearance: 'none',
  width: 20,
  height: 20,
  borderRadius: 6,
  border: `1px solid ${v.border}`,
  cursor: 'pointer',
  padding: 0,
  selectors: {
    '&[data-active="true"]': {
      borderColor: v.accent,
      boxShadow: `0 0 0 2px ${accentAlpha(35)}`,
    },
    '&:hover': {
      borderColor: v.accent,
    },
  },
});

export const hexReadout = style({
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
  color: v.muted,
  textTransform: 'lowercase',
});

// ---- Effects extras -----------------------------------------------------------

export const clearAllBtn = style({
  appearance: 'none',
  alignSelf: 'flex-start',
  border: 'none',
  background: 'transparent',
  color: v.muted,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  padding: 0,
  ':hover': {
    color: '#ff6b6b',
  },
});

// A subtle "apply to every clip in this lane" link, mirroring the captions
// "Apply to all" affordance. Batches into a single undo entry.
export const applyAllBtn = style({
  appearance: 'none',
  alignSelf: 'flex-start',
  border: 'none',
  background: 'transparent',
  color: v.muted,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  padding: 0,
  textAlign: 'left',
  ':hover': {
    color: v.accent,
  },
  ':disabled': {
    opacity: 0.4,
    cursor: 'default',
  },
});

// ---- Karaoke / read-only state indicator -----------------------------------

export const stateChip = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  color: v.muted,
  border: `1px solid ${v.border}`,
  background: v.bg,
  borderRadius: 7,
  padding: '4px 8px',
});

export const stateDot = style({
  width: 7,
  height: 7,
  borderRadius: 999,
  flexShrink: 0,
});

// A read-only value line (e.g. source path, fps) — muted, monospace-ish.
export const readonlyLine = style({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: 11,
  color: v.muted,
});

export const readonlyValue = style({
  color: v.text,
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 600,
  wordBreak: 'break-all',
  textAlign: 'right',
});

// ---- No-selection Project section ------------------------------------------

export const projectHeader = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: 13,
  fontWeight: 600,
  color: v.text,
});

// Grid of aspect-ratio preset buttons for the empty-state Project panel.
export const ratioGrid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 6,
});

export const ratioBtn = style({
  appearance: 'none',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 5,
  padding: '8px 6px',
  borderRadius: 8,
  border: `1px solid ${v.border}`,
  background: v.bg,
  color: v.text,
  cursor: 'pointer',
  transition: 'background 150ms ease, border-color 150ms ease',
  selectors: {
    '&[data-active="true"]': {
      borderColor: v.accent,
      background: accentAlpha(16),
    },
    '&:hover': {
      borderColor: v.accent,
    },
  },
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      transition: 'none',
    },
  },
});

// The little proportional aspect glyph inside a ratio button.
export const ratioGlyph = style({
  border: `1.5px solid ${v.muted}`,
  borderRadius: 2,
  flexShrink: 0,
});

export const ratioLabel = style({
  fontSize: 11,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
});

export const ratioSub = style({
  fontSize: 9,
  color: v.muted,
});

// Custom width/height inputs row for the Project panel.
export const dimRow = style({
  display: 'flex',
  alignItems: 'flex-end',
  gap: 8,
});

export const dimTimes = style({
  paddingBottom: 6,
  color: v.muted,
  fontSize: 12,
  flexShrink: 0,
});
