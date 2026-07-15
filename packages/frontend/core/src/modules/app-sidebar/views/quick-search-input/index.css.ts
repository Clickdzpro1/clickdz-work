import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';
export const root = style({
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: '8px',
  fontSize: cssVar('fontSm'),
  color: cssVarV2('text/secondary'),
  width: '100%',
  height: '32px',
  userSelect: 'none',
  cursor: 'pointer',
  padding: '0 12px 0 8px',
  position: 'relative',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  border: `1px solid ${cssVarV2('layer/insideBorder/border')}`,
  background: cssVarV2('layer/background/secondary'),
  transition:
    'background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
  selectors: {
    '&:hover': {
      borderColor: cssVarV2('layer/insideBorder/primaryBorder'),
      color: cssVarV2('text/primary'),
    },
    '&:focus-visible': {
      outline: 'none',
      borderColor: cssVar('primaryColor'),
      boxShadow: `0 0 0 2px color-mix(in srgb, ${cssVar('primaryColor')} 24%, transparent)`,
    },
  },
});
export const icon = style({
  marginRight: '10px',
  color: cssVarV2('icon/secondary'),
  fontSize: '18px',
  flexShrink: 0,
  transition: 'color 0.15s ease',
  selectors: {
    [`${root}:hover &`]: {
      color: cssVarV2('icon/primary'),
    },
  },
});
export const spacer = style({
  flex: 1,
});
export const shortcutHint = style({
  color: cssVarV2('text/tertiary'),
  fontSize: cssVar('fontBase'),
});
export const quickSearchBarEllipsisStyle = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
