import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';
export const root = style({
  display: 'inline-flex',
  alignItems: 'center',
  // pill-shaped search field
  borderRadius: '999px',
  fontSize: cssVar('fontSm'),
  color: cssVarV2('text/secondary'),
  width: '100%',
  height: '34px',
  userSelect: 'none',
  cursor: 'pointer',
  padding: '0 8px 0 10px',
  position: 'relative',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  border: `1px solid ${cssVarV2('layer/insideBorder/border')}`,
  background: cssVarV2('layer/background/primary'),
  // subtle inner shadow so the pill reads as a recessed input
  boxShadow: `inset 0 1px 2px color-mix(in srgb, ${cssVar('black')} 6%, transparent)`,
  transition:
    'background-color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease',
  selectors: {
    '&:hover': {
      borderColor: cssVarV2('layer/insideBorder/primaryBorder'),
      background: cssVarV2('layer/background/secondary'),
      color: cssVarV2('text/primary'),
    },
    '&:focus-visible': {
      outline: 'none',
      borderColor: cssVar('primaryColor'),
      boxShadow: `inset 0 1px 2px color-mix(in srgb, ${cssVar('black')} 6%, transparent), 0 0 0 2px color-mix(in srgb, ${cssVar('primaryColor')} 24%, transparent)`,
    },
  },
});
export const icon = style({
  marginRight: '10px',
  color: cssVarV2('icon/secondary'),
  fontSize: '18px',
  flexShrink: 0,
  transition: 'color 0.12s ease',
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
  display: 'inline-flex',
  alignItems: 'center',
  gap: '2px',
  flexShrink: 0,
  fontFamily: 'inherit',
});
export const shortcutKey = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '17px',
  height: '17px',
  padding: '0 4px',
  borderRadius: '5px',
  fontSize: '11px',
  lineHeight: 1,
  fontWeight: 500,
  color: cssVarV2('text/tertiary'),
  background: cssVarV2('layer/background/hoverOverlay'),
  border: `1px solid ${cssVarV2('layer/insideBorder/border')}`,
});
export const quickSearchBarEllipsisStyle = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
