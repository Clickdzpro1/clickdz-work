import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';
export const navWrapperStyle = style({
  '@media': {
    print: {
      display: 'none',
      zIndex: -1,
    },
  },
  paddingBottom: 8,
  position: 'relative',
  // Distinct, slightly-elevated rail surface: the secondary layer reads as a
  // panel sitting just above the canvas, with a soft top-to-bottom lift so the
  // top (workspace card) feels raised. Token-driven so it tracks every theme.
  backgroundColor: cssVarV2('layer/background/secondary'),
  backgroundImage: `linear-gradient(180deg, color-mix(in srgb, ${cssVarV2('layer/background/primary')} 22%, transparent) 0%, transparent 160px)`,
  selectors: {
    // Refined 1px inner-right hairline that sits inside the panel edge, above
    // the surface — crisper than a plain border and visible in light + dark.
    '&[data-has-border=true]': {
      borderRight: `1px solid ${cssVarV2('layer/insideBorder/border')}`,
    },
    '&[data-has-border=true]::after': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      right: 0,
      width: '1px',
      pointerEvents: 'none',
      background: `color-mix(in srgb, ${cssVarV2('layer/background/primary')} 60%, transparent)`,
    },
    // The floating (hover-to-reveal) overlay needs a solid opaque tone so
    // content behind it never bleeds through.
    '&[data-is-floating="true"]': {
      backgroundColor: cssVarV2('layer/background/primary'),
    },
  },
});
export const hoverNavWrapperStyle = style({
  selectors: {
    '&[data-is-floating="true"]': {
      backgroundColor: cssVarV2('layer/background/primary'),
      height: 'calc(100% - 60px)',
      marginTop: '52px',
      marginLeft: '4px',
      boxShadow: cssVar('--affine-popover-shadow'),
      borderRadius: '6px',
    },
    '&[data-is-floating="true"][data-is-electron="true"]': {
      height: '100%',
      marginTop: '-4px',
    },
    '&[data-is-floating="true"][data-client-border="true"]': {
      backgroundColor: cssVarV2('layer/background/overlayPanel'),
    },
    '&[data-is-floating="true"][data-client-border="true"]::before': {
      content: '""',
      position: 'absolute',
      inset: 0,
      opacity: `var(--affine-noise-opacity, 0)`,
      backgroundRepeat: 'repeat',
      backgroundSize: '50px',
      // TODO(@Peng): figure out how to use vanilla-extract webpack plugin to inject img url
      backgroundImage: `var(--noise-background)`,
    },
  },
});
export const navHeaderButton = style({
  width: '32px',
  height: '32px',
  flexShrink: 0,
});
export const navHeaderNavigationButtons = style({
  display: 'flex',
  alignItems: 'center',
  columnGap: '32px',
});
export const navStyle = style({
  position: 'relative',
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
});
export const navHeaderStyle = style({
  flex: '0 0 auto',
  height: '52px',
  padding: '0px 8px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
});

export const navBodyStyle = style({
  flex: '1 1 auto',
  height: 'calc(100% - 52px)',
  display: 'flex',
  flexDirection: 'column',
  rowGap: '4px',
});
export const sidebarFloatMaskStyle = style({
  transition: 'opacity .15s',
  opacity: 0,
  pointerEvents: 'none',
  position: 'fixed',
  top: 0,
  left: 0,
  right: '100%',
  bottom: 0,
  background: cssVarV2('layer/background/modal'),
  selectors: {
    '&[data-open="true"][data-is-floating="true"]': {
      opacity: 1,
      pointerEvents: 'auto',
      right: '0',
      zIndex: 3,
    },
  },
  '@media': {
    print: {
      display: 'none',
    },
  },
});

export const resizeHandleShortcutStyle = style({
  alignItems: 'flex-end',
  marginBottom: '2px',
});
