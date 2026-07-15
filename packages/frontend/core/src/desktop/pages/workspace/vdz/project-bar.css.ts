import { style } from '@vanilla-extract/css';

import { accentAlpha, v, vdzTheme } from './theme.css';

/**
 * Vdz Studio — ProjectBar + ProjectBrowser styling.
 *
 * Theme-aware: every color is a `--vdz-*` token (see theme.css.ts), so cdz
 * palettes + light mode flow in and the default "Midnight" dark look is the
 * fallback. The bar lives in the header's RIGHT zone and MUST stay inside the
 * fixed 40px row — every control is 28px tall (HEADER_CONTROL_H) so it sits on
 * the same baseline as the mode tabs and the View menu, and nothing wraps.
 *
 * The browser is a self-portaled dropdown popover anchored under the Open
 * button (not a panel in the layout system), carrying `vdzTheme` so the tokens
 * resolve on it independently — the same pattern the View menu uses.
 */

const bg = v.bg;
const panel = v.panel;
const raised = v.raised;
const border = v.border;
const text = v.text;
const textDim = v.muted;
const accent = v.accent;

const HEADER_CONTROL_H = 28;

// ---- The bar: a compact inline group in the header-right zone ------------
export const bar = style({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  height: HEADER_CONTROL_H,
});

// Inline-editable project name. Reads as a field: subtle hover affordance,
// truncates rather than pushing the row wider. Becomes a real <input> on edit
// (same box metrics so there's no layout jump).
export const nameField = style({
  color: textDim,
  fontSize: 12,
  fontWeight: 500,
  minWidth: 0,
  maxWidth: 220,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  padding: '0 8px',
  height: HEADER_CONTROL_H,
  lineHeight: `${HEADER_CONTROL_H}px`,
  borderRadius: 6,
  border: '1px solid transparent',
  background: 'transparent',
  cursor: 'text',
  transition: 'background 120ms ease, color 120ms ease, border-color 120ms',
  ':hover': {
    color: text,
    background: bg,
    borderColor: border,
  },
});

// The <input> shown while editing the name — matches nameField's metrics.
export const nameInput = style({
  appearance: 'none',
  boxSizing: 'border-box',
  color: text,
  fontSize: 12,
  fontWeight: 500,
  fontFamily: 'inherit',
  width: 200,
  height: HEADER_CONTROL_H,
  padding: '0 8px',
  borderRadius: 6,
  border: `1px solid ${accent}`,
  background: bg,
  ':focus': {
    outline: 'none',
    borderColor: accent,
  },
});

// A slim "unsaved changes" dot before the name (only shown when dirty).
export const dirtyDot = style({
  width: 6,
  height: 6,
  flexShrink: 0,
  borderRadius: '50%',
  background: accent,
  marginRight: 2,
});

// Base header button (Save / Save As / Open). 28px tall to align on the row.
export const barButton = style({
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: HEADER_CONTROL_H,
  boxSizing: 'border-box',
  border: `1px solid ${border}`,
  background: bg,
  color: textDim,
  fontSize: 12,
  fontWeight: 600,
  padding: '0 10px',
  borderRadius: 8,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  flexShrink: 0,
  transition: 'background 120ms ease, color 120ms ease, border-color 120ms',
  ':hover': {
    color: text,
    borderColor: accent,
  },
  selectors: {
    '&:disabled': {
      opacity: 0.4,
      cursor: 'default',
      borderColor: border,
      color: textDim,
    },
    // The primary (Save) button gets a filled accent look when actionable.
    '&[data-primary="true"]:not(:disabled)': {
      background: accentAlpha(16),
      borderColor: accent,
      color: text,
    },
    '&[data-open="true"]': {
      color: text,
      background: raised,
      borderColor: accent,
    },
  },
});

// A keyboard-hint chip inside a button (e.g. ⌘S), dimmed and monospaced.
export const shortcutHint = style({
  fontSize: 10,
  fontWeight: 600,
  color: textDim,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
});

// ---- The browser: a dropdown popover anchored under the Open button ------
export const browserRoot = style({
  position: 'relative',
  display: 'inline-flex',
  flexShrink: 0,
});

export const browserMenu = style([
  vdzTheme,
  {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    width: 320,
    maxHeight: 420,
    display: 'flex',
    flexDirection: 'column',
    background: panel,
    color: text,
    border: `1px solid ${border}`,
    borderRadius: 10,
    boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
    zIndex: 40,
    overflow: 'hidden',
  },
]);

// Popover header strip: title + a "New" action.
export const browserHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  borderBottom: `1px solid ${border}`,
  flexShrink: 0,
});

export const browserTitle = style({
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: textDim,
  flex: 1,
});

// Small ghost action in the popover header ("New", and a "Refresh" retry).
export const browserAction = style({
  appearance: 'none',
  border: `1px solid ${border}`,
  background: bg,
  color: text,
  fontSize: 11,
  fontWeight: 600,
  padding: '3px 8px',
  borderRadius: 6,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'background 120ms ease, border-color 120ms ease',
  ':hover': {
    background: raised,
    borderColor: accent,
  },
  selectors: {
    '&:disabled': {
      opacity: 0.4,
      cursor: 'default',
      borderColor: border,
      background: bg,
    },
  },
});

// Scrolling list body.
export const browserList = style({
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
});

// One project row: a clickable name/meta stack + a delete button.
export const projectRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid transparent',
  transition: 'background 120ms ease, border-color 120ms ease',
  ':hover': {
    background: raised,
  },
  selectors: {
    // The currently-open project is marked.
    '&[data-current="true"]': {
      borderColor: accent,
      background: accentAlpha(10),
    },
  },
});

// The name+meta portion — a button filling the row so the whole row opens it.
export const projectOpen = style({
  appearance: 'none',
  flex: 1,
  minWidth: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
});

export const projectName = style({
  fontSize: 13,
  fontWeight: 500,
  color: text,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
});

export const projectMeta = style({
  fontSize: 10,
  color: textDim,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  fontVariantNumeric: 'tabular-nums',
});

// Per-row delete (trash) button — appears on row hover, reddens on its own hover.
export const projectDelete = style({
  appearance: 'none',
  flexShrink: 0,
  border: `1px solid transparent`,
  background: 'transparent',
  color: textDim,
  fontSize: 13,
  lineHeight: 1,
  width: 24,
  height: 24,
  borderRadius: 6,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  opacity: 0,
  transition: 'opacity 120ms ease, color 120ms ease, border-color 120ms',
  selectors: {
    [`${projectRow}:hover &`]: {
      opacity: 1,
    },
    '&:hover': {
      color: '#ff6b6b',
      borderColor: '#ff6b6b',
      opacity: 1,
    },
    '&:disabled': {
      opacity: 0.3,
      cursor: 'default',
    },
  },
});

// Empty / loading / error state block inside the list.
export const browserEmpty = style({
  padding: '18px 12px',
  textAlign: 'center',
  color: textDim,
  fontSize: 12,
  lineHeight: 1.5,
});

export const browserError = style({
  padding: '10px 12px',
  color: '#ff6b6b',
  fontSize: 12,
  lineHeight: 1.4,
  borderTop: `1px solid ${border}`,
});
