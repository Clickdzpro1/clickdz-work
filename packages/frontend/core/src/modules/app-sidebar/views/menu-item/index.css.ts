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
  // Flat rows: a small radius only softens the hover/active tint's corners —
  // it is deliberately NOT a pill/box around the item.
  borderRadius: '4px',
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
  // Flat items only: no border, no box-shadow ring, no accent rail — never any
  // box around the row. State is conveyed purely by a subtle bg tint (hover /
  // active) and the accent icon color on the active item.
  outline: 'none',
  transition: 'background-color 0.12s ease, color 0.12s ease',
  selectors: {
    '&:hover': {
      background: cssVarV2.layer.background.hoverOverlay,
      color: cssVarV2('text/primary'),
    },
    // Keyboard focus only: reuse the flat hover tint (no ring / box-shadow /
    // outline box) so focus stays visible without drawing a box.
    '&:focus-visible': {
      background: cssVarV2.layer.background.hoverOverlay,
      color: cssVarV2('text/primary'),
    },
    '&[data-active="true"]': {
      // subtle accent tint only — no pill border, outline, or shadow
      background: `color-mix(in srgb, ${cssVar('primaryColor')} 12%, transparent)`,
      color: cssVarV2('text/primary'),
      fontWeight: 600,
    },
    '&[data-active="true"]:hover': {
      background: `color-mix(in srgb, ${cssVar('primaryColor')} 16%, transparent)`,
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
