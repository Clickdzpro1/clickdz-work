import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';
export const linkItemRoot = style({
  color: 'inherit',
  // The wrapping <a> is focusable; without this it draws the browser default
  // focus box around the whole item. Keyboard focus is surfaced on the inner
  // row (`root`) via :focus-visible instead, so the flat look is preserved.
  outline: 'none',
});
export const root = style({
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: '10px',
  textAlign: 'left',
  color: cssVarV2('text/secondary'),
  width: '100%',
  minHeight: '34px',
  userSelect: 'none',
  cursor: 'pointer',
  padding: '0 6px 0 8px',
  fontSize: cssVar('fontSm'),
  fontWeight: 500,
  marginTop: '2px',
  position: 'relative',
  // Flat items only — never a browser default focus box. Keyboard focus is
  // shown via the :focus-visible ring below; pointer focus shows nothing.
  outline: 'none',
  transition:
    'background-color 0.12s ease, color 0.12s ease, transform 0.12s ease',
  // accent left-rail indicator for the active item
  '::before': {
    content: '""',
    position: 'absolute',
    left: '3px',
    top: '50%',
    transform: 'translateY(-50%) scaleY(0.35)',
    width: '3px',
    height: '18px',
    borderRadius: '3px',
    background: cssVar('primaryColor'),
    opacity: 0,
    transition: 'opacity 0.12s ease, transform 0.12s ease',
  },
  selectors: {
    '&:hover': {
      background: cssVarV2.layer.background.hoverOverlay,
      color: cssVarV2('text/primary'),
    },
    // Keyboard focus only: a subtle accent ring that matches the v2 hover/active
    // treatment instead of the browser's default square outline box.
    '&:focus-visible': {
      background: cssVarV2.layer.background.hoverOverlay,
      color: cssVarV2('text/primary'),
      boxShadow: `0 0 0 2px color-mix(in srgb, ${cssVar('primaryColor')} 45%, transparent)`,
    },
    '&[data-active="true"]': {
      // tinted accent pill for the active item — reads clearly in every theme
      background: `color-mix(in srgb, ${cssVar('primaryColor')} 12%, transparent)`,
      color: cssVarV2('text/primary'),
      fontWeight: 600,
    },
    '&[data-active="true"]:hover': {
      background: `color-mix(in srgb, ${cssVar('primaryColor')} 16%, transparent)`,
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
      left: '9px',
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
  letterSpacing: '-0.003em',
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
  transition: 'color 0.12s ease, filter 0.12s ease',
  selectors: {
    [`${root}:hover &`]: {
      color: cssVarV2('icon/primary'),
      // subtle brighten on hover
      filter: 'brightness(1.08)',
    },
    [`${root}[data-active="true"] &`]: {
      color: cssVar('primaryColor'),
      filter: 'none',
    },
  },
});
export const collapsedIconContainer = style({
  width: '16px',
  height: '16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '4px',
  transition: 'transform 0.2s, background 0.12s ease',
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
  // 20px icon + 10px trailing gap = generous, roomy icon-to-label spacing
  width: '30px',
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
