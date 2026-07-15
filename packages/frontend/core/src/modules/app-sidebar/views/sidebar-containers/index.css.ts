import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { globalStyle, style } from '@vanilla-extract/css';
export const baseContainer = style({
  padding: '4px 14px',
  display: 'flex',
  flexFlow: 'column nowrap',
  ':empty': {
    display: 'none',
  },
});
export const scrollableContainerRoot = style({
  flex: '1 1 auto',
  overflowY: 'hidden',
  vars: {
    '--scrollbar-width': '10px',
  },
});
export const scrollTopBorder = style({
  position: 'absolute',
  top: 0,
  left: '12px',
  right: '12px',
  height: '1px',
  zIndex: 1,
  transition: 'opacity .3s .1s',
  opacity: 0,
  // hairline that fades out toward both horizontal edges — a soft scroll-edge
  // divider rather than a hard rule.
  background: `linear-gradient(90deg, transparent, ${cssVarV2('layer/insideBorder/border')} 12%, ${cssVarV2('layer/insideBorder/border')} 88%, transparent)`,
  selectors: {
    '&[data-has-scroll-top="true"]': {
      opacity: 1,
    },
  },
});
export const scrollableViewport = style({
  height: '100%',
  marginTop: '4px',
  // safe area to avoid bottom clipping
  paddingBottom: 8,
});
globalStyle(`${scrollableViewport} > div`, {
  maxWidth: '100%',
  display: 'block !important',
});
export const scrollableContainer = style([
  baseContainer,
  {
    height: '100%',
    padding: '0px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
]);
export const scrollbar = style({
  display: 'flex',
  flexDirection: 'column',
  userSelect: 'none',
  touchAction: 'none',
  padding: '0 2px',
  width: 'var(--scrollbar-width)',
  height: '100%',
  opacity: 1,
  transition: 'opacity .15s',
  selectors: {
    '&[data-state="hidden"]': {
      opacity: 0,
    },
  },
});
export const scrollbarThumb = style({
  position: 'relative',
  background: cssVar('black30'),
  borderRadius: '4px',
  overflow: 'hidden',
  selectors: {
    '&::before': {
      content: '""',
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: '100%',
      height: '100%',
      minWidth: '44px',
      minHeight: '44px',
    },
  },
});
