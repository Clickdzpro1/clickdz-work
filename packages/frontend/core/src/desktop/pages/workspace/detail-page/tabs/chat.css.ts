import { cssVarV2 } from '@toeverything/theme/v2';
import { globalKeyframes, globalStyle, style } from '@vanilla-extract/css';

export const root = style({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  width: '100%',
  userSelect: 'text',
});

export const container = style({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
});

export const header = style({
  background: 'var(--affine-background-primary-color)',
  position: 'relative',
  padding: '8px var(--h-padding, 16px)',
  width: '100%',
  minHeight: '36px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  zIndex: 1,
  borderBottom: `0.5px solid ${cssVarV2('layer/insideBorder/border')}`,
});

export const title = style({
  fontSize: '14px',
  fontWeight: 500,
  color: 'var(--affine-text-secondary-color)',
  display: 'flex',
  alignItems: 'center',
});

export const playground = style({
  cursor: 'pointer',
  padding: '2px',
  marginLeft: '8px',
  marginRight: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

export const content = style({
  flexGrow: 1,
  height: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
});

export const loadingContainer = style({
  position: 'relative',
  padding: '44px 0 166px 0',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
});

export const loading = style({
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '12px',
});

export const loadingTitle = style({
  fontWeight: 600,
  fontSize: 'var(--affine-font-sm)',
  color: 'var(--affine-text-secondary-color)',
});

export const loadingIcon = style({
  width: '44px',
  height: '44px',
  color: 'var(--affine-icon-secondary)',
  animation: 'clickdz-spin 1.2s linear infinite',
});

export const tabsContainer = style({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  overflow: 'hidden',
});

globalStyle(`${playground} svg`, {
  width: '18px',
  height: '18px',
  color: 'var(--affine-text-secondary-color)',
});

globalStyle(`${playground}:hover svg`, {
  color: cssVarV2('icon/activated'),
});

globalStyle(`${content} > ai-chat-content`, {
  flexGrow: 1,
  height: 0,
  minHeight: 0,
  width: '100%',
});

/* ClickDz spinning logo animation for loading state. `globalKeyframes` is the
 * vanilla-extract API for @keyframes — `globalStyle` treats its first argument
 * as a SELECTOR, so the previous `globalStyle('@keyframes …')` form never
 * produced a valid keyframes rule and the spinner (see `animation:` above)
 * did not spin. */
globalKeyframes('clickdz-spin', {
  from: { transform: 'rotate(0deg)' },
  to: { transform: 'rotate(360deg)' },
});
