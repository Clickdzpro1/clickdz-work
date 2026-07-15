import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';

// Compact palette trigger sitting in the sidebar header row.
export const triggerButton = style({
  flexShrink: 0,
  color: cssVarV2('icon/secondary'),
  transition: 'color 0.12s ease, background 0.12s ease',
  selectors: {
    '&:hover': {
      color: cssVar('primaryColor'),
    },
  },
});

export const menu = style({
  padding: 8,
  minWidth: 200,
});

export const heading = style({
  fontSize: '10.5px',
  fontWeight: 600,
  lineHeight: '20px',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: cssVarV2('text/tertiary'),
  padding: '0 4px 6px',
});

export const list = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
});

export const row = style({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 8px',
  borderRadius: 8,
  cursor: 'pointer',
  color: cssVarV2('text/secondary'),
  fontSize: cssVar('fontSm'),
  fontWeight: 500,
  userSelect: 'none',
  outline: 'none',
  transition: 'background 0.12s ease, color 0.12s ease',
  selectors: {
    '&:hover, &:focus-visible': {
      background: cssVarV2('layer/background/hoverOverlay'),
      color: cssVarV2('text/primary'),
    },
    '&[data-selected="true"]': {
      color: cssVarV2('text/primary'),
      fontWeight: 600,
    },
  },
});

// Two-tone accent chip previewing each preset (accent → accent2).
export const swatch = style({
  width: 18,
  height: 18,
  borderRadius: '50%',
  flexShrink: 0,
  boxShadow: `inset 0 0 0 1px ${cssVarV2('layer/insideBorder/border')}`,
});

export const rowLabel = style({
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const check = style({
  flexShrink: 0,
  color: cssVar('primaryColor'),
  display: 'inline-flex',
});
