import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';
export const linkItemRoot = style({
  color: 'inherit',
});
export const root = style({
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: '8px',
  textAlign: 'left',
  color: cssVarV2('text/secondary'),
  width: '100%',
  minHeight: '32px',
  userSelect: 'none',
  cursor: 'pointer',
  padding: '0 2px 0 0',
  fontSize: cssVar('fontSm'),
  fontWeight: 500,
  marginTop: '2px',
  position: 'relative',
  transition:
    'background-color 0.15s ease, color 0.15s ease, transform 0.12s ease',
  // accent left-rail indicator for the active item
  '::before': {
    content: '""',
    position: 'absolute',
    left: '2px',
    top: '50%',
    transform: 'translateY(-50%) scaleY(0.4)',
    width: '3px',
    height: '18px',
    borderRadius: '3px',
    background: cssVar('primaryColor'),
    opacity: 0,
    transition: 'opacity 0.15s ease, transform 0.15s ease',
  },
  selectors: {
    '&:hover': {
      background: cssVarV2.layer.background.hoverOverlay,
      color: cssVarV2('text/primary'),
    },
    '&[data-active="true"]': {
      background: cssVarV2.layer.background.hoverOverlay,
      color: cssVarV2('text/primary'),
      fontWeight: 600,
    },
    '&[data-active="true"]::before': {
      opacity: 1,
      transform: 'translateY(-50%) scaleY(1)',
    },
    '&[data-disabled="true"]': {
      cursor: 'default',
      color: cssVarV2.text.disable,
      pointerEvents: 'none',
    },
    '&[data-collapsible="true"]': {
      paddingLeft: '4px',
      paddingRight: '4px',
    },
    '&[data-collapsible="false"]:is([data-active="true"], :hover)': {
      width: 'calc(100% + 8px + 8px)',
      transform: 'translateX(-8px)',
      paddingLeft: '8px',
      paddingRight: '10px',
    },
    // keep the active rail pinned to the edge even when the row shifts on hover
    '&[data-collapsible="false"]:is([data-active="true"], :hover)::before': {
      left: '8px',
    },
    [`${linkItemRoot}:first-of-type &`]: {
      marginTop: '0px',
    },
  },
});
export const content = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
});
export const postfix = style({
  right: '4px',
  position: 'absolute',
  opacity: 0,
  pointerEvents: 'none',
  selectors: {
    [`${root}:hover &, &[data-postfix-display="always"]`]: {
      justifySelf: 'flex-end',
      position: 'initial',
      opacity: 1,
      pointerEvents: 'all',
    },
  },
});
export const icon = style({
  color: cssVarV2('icon/secondary'),
  fontSize: '20px',
  flexShrink: 0,
  transition: 'color 0.15s ease',
  selectors: {
    [`${root}:hover &`]: {
      color: cssVarV2('icon/primary'),
    },
    [`${root}[data-active="true"] &`]: {
      color: cssVar('primaryColor'),
    },
  },
});
export const collapsedIconContainer = style({
  width: '16px',
  height: '16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '2px',
  transition: 'transform 0.2s',
  color: 'inherit',
  selectors: {
    '&[data-collapsed="true"]': {
      transform: 'rotate(-90deg)',
    },
    '&[data-disabled="true"]': {
      opacity: 0.3,
      pointerEvents: 'none',
    },
    '&:hover': {
      background: cssVarV2.layer.background.hoverOverlay,
    },
  },
});
export const iconsContainer = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  width: '32px',
  flexShrink: 0,
  selectors: {
    '&[data-collapsible="true"]': {
      width: '44px',
    },
  },
});
export const collapsedIcon = style({
  transition: 'transform 0.2s ease-in-out',
  selectors: {
    '&[data-collapsed="true"]': {
      transform: 'rotate(-90deg)',
    },
  },
});
export const spacer = style({
  flex: 1,
});
