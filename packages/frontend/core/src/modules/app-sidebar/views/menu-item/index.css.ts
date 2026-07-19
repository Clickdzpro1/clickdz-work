import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';
export const linkItemRoot = style({
  color: 'inherit',
  // The wrapping <a> must NOT generate its own box: `display: contents` makes it
  // layout-transparent so it can never paint a border / outline / focus ring
  // around the row. That stray wrapper box (a focusable <a> nested around the
  // focusable row) was the source of the "double ring" — one rounded tint on the
  // row plus a second rectangle on the <a> in themes / forced-colors mode where a
  // plain `outline: none` on a real box gets overridden by the OS. With
  // `display: contents` the <a> stays keyboard focusable as the link, and its
  // focus is surfaced on the single inner row (`root`) via the
  // `${linkItemRoot}:focus-visible &` selector below — so exactly one rounded
  // container is ever visible.
  display: 'contents',
  // Belt-and-suspenders: also suppress any UA outline in engines that still hang
  // a focus box off a `display: contents` element.
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
    // Keyboard focus: a SINGLE crisp accent ring on this one row, drawn as an
    // inset box-shadow (not `outline`, not a nested element) so it hugs the 4px
    // radius and can never become a second box. The wrapping <a> is
    // `display: contents`, so the same ring is surfaced whether the row itself
    // (standalone MenuItem) or the link (MenuLinkItem's <a>) receives keyboard
    // focus — see the `${linkItemRoot}:focus-visible &` selector below. Mouse
    // clicks use `:focus-visible`, so this only appears for keyboard users.
    '&:focus-visible': {
      color: cssVarV2('text/primary'),
      boxShadow: `inset 0 0 0 2px color-mix(in srgb, ${cssVar('primaryColor')} 45%, transparent)`,
    },
    [`${linkItemRoot}:focus-visible &`]: {
      color: cssVarV2('text/primary'),
      boxShadow: `inset 0 0 0 2px color-mix(in srgb, ${cssVar('primaryColor')} 45%, transparent)`,
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
