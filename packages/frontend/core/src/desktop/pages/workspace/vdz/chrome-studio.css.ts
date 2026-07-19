import { style } from '@vanilla-extract/css';

import { accentAlpha, v } from './theme.css';

/**
 * Vdz Studio — chrome polish styles (LACQUER / V7).
 *
 * NEW static classes for the studio shell's chrome pass: logical toolbar
 * grouping, the ratio picker's "Custom…" popover, and the consistent panel-
 * header icon. Every value references the shared `--vdz-*` tokens (theme.css.ts)
 * so cdz palettes + light mode flow in and the "Midnight" dark fallbacks match
 * the rest of the shell.
 *
 * vanilla-extract landmine: this file exports ONLY plain `style()` results —
 * never a function (dynamic CSS lives in plain `.ts`, see anim.ts).
 */

const bg = v.bg;
const panel = v.panel;
const border = v.border;
const text = v.text;
const textDim = v.muted;
const accent = v.accent;

// ---- Toolbar grouping ----------------------------------------------------
// The toolbar wraps controls into labelled logical groups (playback |
// edit/insert | canvas/ratio | view/export). Each group is an inline cluster
// so a control never separates from its siblings across a wrap, and the
// `toolDivider` seams (from index.css.ts) sit BETWEEN groups, not inside them.
export const toolGroup = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
});

// A right-aligned group (view/export) that hugs the far edge after the spacer.
export const toolGroupEnd = style([
  toolGroup,
  {
    marginLeft: 'auto',
  },
]);

// ---- Ratio picker: current-ratio row + "Custom…" popover -----------------
// A checkmark column so the currently-applied preset is unambiguous (mirrors
// the View menu's check idiom). Fixed width keeps every row's label aligned.
export const ratioCheck = style({
  flex: '0 0 auto',
  width: 14,
  textAlign: 'center',
  color: accent,
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1,
});

// The "Custom…" entry sits under a hairline separator from the presets.
export const ratioSep = style({
  height: 1,
  background: border,
  margin: '4px 2px',
});

// The inline Custom-size editor revealed under the "Custom…" row: two numeric
// inputs (W × H) + an Apply button, committing through the SAME setCanvas op
// the presets use.
export const customForm = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '8px 8px 6px',
});

export const customRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
});

export const customField = style({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: 1,
  minWidth: 0,
});

export const customLabel = style({
  fontSize: 11,
  fontWeight: 600,
  color: textDim,
  width: 12,
  flexShrink: 0,
});

export const customInput = style({
  appearance: 'none',
  boxSizing: 'border-box',
  width: '100%',
  minWidth: 0,
  height: 26,
  padding: '0 8px',
  borderRadius: 6,
  border: `1px solid ${border}`,
  background: bg,
  color: text,
  fontSize: 12,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontVariantNumeric: 'tabular-nums',
  transition: 'border-color 120ms ease',
  ':focus': {
    outline: 'none',
    borderColor: accent,
  },
  // Kill the native number spinners for a cleaner field.
  selectors: {
    '&::-webkit-outer-spin-button, &::-webkit-inner-spin-button': {
      appearance: 'none',
      margin: 0,
    },
  },
});

export const customTimes = style({
  flexShrink: 0,
  color: textDim,
  fontSize: 12,
  fontWeight: 600,
});

export const customApply = style({
  appearance: 'none',
  height: 26,
  padding: '0 12px',
  borderRadius: 6,
  border: `1px solid ${accent}`,
  background: accentAlpha(16),
  color: text,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'background 120ms ease, border-color 120ms ease, opacity 120ms',
  ':hover': {
    background: accentAlpha(26),
  },
  selectors: {
    '&:disabled': {
      opacity: 0.4,
      cursor: 'default',
    },
  },
});

// A small validation/hint line under the custom inputs (out-of-range etc.).
export const customHint = style({
  fontSize: 10.5,
  lineHeight: 1.4,
  color: textDim,
});

// ---- Panel header icon ---------------------------------------------------
// A consistent leading glyph before every panel title (title + icon + close in
// the same order/spacing across ALL panels). Sits in the shared VdzPanel
// header, tinted to the muted text token so it reads as chrome, not content.
export const panelHeaderIcon = style({
  flex: '0 0 auto',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
  marginRight: 2,
  fontSize: 13,
  lineHeight: 1,
  color: textDim,
});

// ---- View menu polish ----------------------------------------------------
// A leading icon in each View-menu row, mirroring the panel-header glyph so the
// menu and the panel it toggles share one visual identity.
export const viewMenuIcon = style({
  flex: '0 0 auto',
  width: 16,
  textAlign: 'center',
  fontSize: 12,
  lineHeight: 1,
  color: textDim,
});

// ---- Project-bar overflow-menu icon --------------------------------------
// A fixed-width leading glyph column for the ⋯ menu rows (Save As / Templates /
// Share) so their labels align — matches the View menu's icon column metric.
export const overflowIcon = style({
  flex: '0 0 auto',
  width: 16,
  textAlign: 'center',
  fontSize: 13,
  lineHeight: 1,
});

// A menu container for the ⋯ overflow (moved off inline styles for a cleaner,
// theme-tracked surface identical to the View menu popover).
export const overflowMenu = style({
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  zIndex: 60,
  minWidth: 184,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: 6,
  borderRadius: 10,
  border: `1px solid ${border}`,
  background: panel,
  boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
});
