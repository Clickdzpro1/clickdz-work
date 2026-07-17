import { style } from '@vanilla-extract/css';

import { accentAlpha, v } from './theme.css';

/**
 * Template gallery / first-run welcome overlay. Lives INSIDE the studio root
 * (already themed), so plain `--vdz-*` references are enough — no vdzTheme
 * composition, and (lesson learned) never a runtime import of theme.css.
 */

export const backdrop = style({
  position: 'fixed',
  inset: 0,
  zIndex: 80,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0, 0, 0, 0.55)',
  backdropFilter: 'blur(2px)',
});

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

export const tipsRow = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
});

export const tip = style({
  fontSize: 11.5,
  color: v.muted,
  border: `1px solid ${v.border}`,
  borderRadius: 999,
  padding: '4px 10px',
  whiteSpace: 'nowrap',
});

export const grid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
  gap: 10,
});

export const tplCard = style({
  appearance: 'none',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 8,
  padding: 10,
  borderRadius: 10,
  border: `1px solid ${v.border}`,
  background: v.raised,
  color: v.text,
  textAlign: 'left',
  cursor: 'pointer',
  ':hover': {
    borderColor: v.accent,
    background: accentAlpha(10),
  },
});

export const thumb = style({
  height: 76,
  borderRadius: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 28,
});

export const tplName = style({
  fontSize: 13,
  fontWeight: 600,
});

export const tplDesc = style({
  fontSize: 11.5,
  color: v.muted,
  lineHeight: 1.5,
});
