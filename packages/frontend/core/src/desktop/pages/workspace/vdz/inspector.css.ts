import { style } from '@vanilla-extract/css';

import { accentAlpha, v } from './theme.css';

/**
 * Inspector-only styles — the friendlier control set (quick actions, rename,
 * timing inputs, swatches, mute, collapsible section headers). Shared panel
 * chrome stays in index.css.ts; everything here references the `--vdz-*`
 * theme bridge only (never raw hex for chrome), per the theming contract.
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

// ---- Numeric timing inputs --------------------------------------------------

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
