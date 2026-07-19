import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';

/** Wrapper so the badge can be absolutely positioned over the bell button. */
export const bellRoot = style({
  position: 'relative',
  display: 'inline-flex',
});

/** Unread count pill, pinned to the top-right of the bell. */
export const badge = style({
  position: 'absolute',
  top: -2,
  right: -2,
  pointerEvents: 'none',
  boxSizing: 'border-box',
  minWidth: 16,
  height: 16,
  padding: '0 4px',
  borderRadius: 8,
  backgroundColor: cssVarV2('button/primary'),
  color: cssVarV2('text/pureWhite'),
  fontSize: 10,
  fontWeight: 600,
  lineHeight: '16px',
  textAlign: 'center',
});

/** The popover inbox container. */
export const inbox = style({
  width: 320,
  maxHeight: 420,
  display: 'flex',
  flexDirection: 'column',
});

export const inboxHeader = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '10px 12px',
  borderBottom: `0.5px solid ${cssVarV2('layer/insideBorder/border')}`,
});

export const inboxTitle = style({
  fontSize: 13,
  fontWeight: 600,
  color: cssVarV2('text/primary'),
});

export const clearButton = style({
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  fontSize: 12,
  color: cssVarV2('text/secondary'),
  transition: 'color 150ms ease',
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      transition: 'none',
    },
  },
  ':hover': {
    color: cssVarV2('text/primary'),
  },
});

/** Scroll region holding the notification rows. */
export const list = style({
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: 4,
});

export const item = style({
  display: 'flex',
  gap: 10,
  padding: '8px 8px',
  borderRadius: 6,
  cursor: 'default',
  transition: 'background 150ms ease',
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      transition: 'none',
    },
  },
  ':hover': {
    background: cssVarV2('layer/background/hoverOverlay'),
  },
});

/** Left rail: studio icon + an unread dot. */
export const itemIcon = style({
  flexShrink: 0,
  width: 20,
  height: 20,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 20,
  color: cssVarV2('icon/primary'),
});

export const itemBody = style({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
});

export const itemTitle = style({
  fontSize: 13,
  fontWeight: 500,
  color: cssVarV2('text/primary'),
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const itemText = style({
  fontSize: 12,
  color: cssVarV2('text/secondary'),
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
});

export const itemMeta = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 2,
});

export const itemTime = style({
  fontSize: 11,
  color: cssVarV2('text/tertiary'),
});

export const actionButton = style({
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
  color: cssVarV2('text/emphasis'),
  transition: 'opacity 150ms ease',
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      transition: 'none',
    },
  },
  ':hover': {
    opacity: 0.75,
  },
});

/** Unread marker dot, shown before the title of unread rows. */
export const unreadDot = style({
  flexShrink: 0,
  width: 6,
  height: 6,
  borderRadius: '50%',
  backgroundColor: cssVarV2('button/primary'),
});

export const empty = style({
  padding: '32px 16px',
  textAlign: 'center',
  fontSize: 13,
  color: cssVarV2('text/secondary'),
});
