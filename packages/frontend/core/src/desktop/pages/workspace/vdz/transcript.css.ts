import { style } from '@vanilla-extract/css';

import { accentAlpha, v } from './theme.css';

/**
 * Transcript panel styles. Same contract as every vdz surface: colors come
 * from the `--vdz-*` theme bridge only.
 */

export const list = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
});

export const row = style({
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  alignItems: 'center',
  gap: 8,
  padding: '4px 6px',
  borderRadius: 7,
  borderLeft: '2px solid transparent',
  cursor: 'pointer',
  selectors: {
    '&:hover': {
      background: accentAlpha(8),
    },
    '&[data-active="true"]': {
      borderLeftColor: v.accent,
      background: accentAlpha(12),
    },
    '&[data-selected="true"]': {
      background: accentAlpha(16),
    },
  },
});

export const timeChip = style({
  flexShrink: 0,
  fontSize: 10,
  fontVariantNumeric: 'tabular-nums',
  color: v.muted,
  border: `1px solid ${v.border}`,
  borderRadius: 999,
  padding: '1px 6px',
  whiteSpace: 'nowrap',
});

export const textInput = style({
  appearance: 'none',
  width: '100%',
  minWidth: 0,
  border: '1px solid transparent',
  background: 'transparent',
  color: v.text,
  fontSize: 12,
  lineHeight: 1.5,
  padding: '3px 6px',
  borderRadius: 6,
  outline: 'none',
  ':focus': {
    borderColor: v.accent,
    background: v.bg,
    boxShadow: `0 0 0 2px ${accentAlpha(25)}`,
  },
});

export const delBtn = style({
  appearance: 'none',
  flexShrink: 0,
  border: 'none',
  background: 'transparent',
  color: v.muted,
  fontSize: 11,
  lineHeight: 1,
  width: 20,
  height: 20,
  borderRadius: 6,
  cursor: 'pointer',
  ':hover': {
    color: '#ff6b6b',
    background: 'color-mix(in srgb, #ff6b6b 12%, transparent)',
  },
});

export const emptyHint = style({
  color: v.muted,
  fontSize: 12,
  lineHeight: 1.6,
  padding: '8px 6px',
});

export const countBadge = style({
  fontSize: 10,
  fontWeight: 600,
  color: v.muted,
  border: `1px solid ${v.border}`,
  borderRadius: 999,
  padding: '1px 7px',
});

/**
 * Compact "Caption style" bar above the transcript list: two selects
 * (preset / position) + an apply button, on one wrapping row. Colors come from
 * the same `--vdz-*` theme bridge every vdz surface uses (no `accentAlpha`
 * here — plain tokens keep this export a pure `style()` result).
 */
export const styleBar = style({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  gap: 6,
  padding: '6px',
  marginBottom: 6,
  borderRadius: 8,
  border: `1px solid ${v.border}`,
  background: v.bg,
});

export const styleBarLabel = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  flex: '1 1 96px',
  minWidth: 0,
});

export const styleBarLabelText = style({
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: v.muted,
});

export const styleBarApply = style({
  appearance: 'none',
  flex: '1 1 100%',
  border: `1px solid ${v.border}`,
  background: v.bg,
  color: v.text,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1.4,
  padding: '5px 8px',
  borderRadius: 6,
  cursor: 'pointer',
  selectors: {
    '&:hover:not(:disabled)': {
      borderColor: v.accent,
      color: v.accent,
    },
    '&:disabled': {
      opacity: 0.5,
      cursor: 'default',
    },
  },
});
