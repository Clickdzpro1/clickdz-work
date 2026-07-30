import { style } from '@vanilla-extract/css';

import { accentAlpha, v, vdzTheme } from './theme.css';

/**
 * Vdz Studio — ProjectBar + ProjectBrowser styling.
 *
 * Theme-aware: every color is a `--vdz-*` token (see theme.css.ts), so cdz
 * palettes + light mode flow in and the default "Midnight" dark look is the
 * fallback. The bar IS the header's RIGHT zone now (name · Save · Open · ⋯ ·
 * divider · View slot) and MUST stay inside the fixed 40px row — every control
 * is 28px tall (HEADER_CONTROL_H) so it sits on the same baseline as the mode
 * tabs, and nothing wraps.
 *
 * SINGLE SOURCE OF TRUTH for the header-cluster chrome: `barButton` is THE
 * header button recipe (the View trigger in vdz-panel.tsx wears it too — the
 * old `viewMenuTrigger` copy in index.css.ts is retired), `barDivider` is THE
 * one divider spec (both seams), and `barChip` is THE one in-button chip (the
 * ⌘S hint + the View trigger's N/6 count), so the row reads as one family on
 * one 8px gap rhythm.
 *
 * DENSITY: the bar root carries `data-density="full|tight|min"`, set by a
 * ResizeObserver in project-bar.tsx from the width the header actually grants
 * the right zone. Child styles key off that attribute so the cluster condenses
 * in steps — the ⌘S hint first, then the View label, then Open (folded into
 * the ⋯ overflow by JSX) — instead of crushing the project name to one
 * character or spilling rigid buttons toward the mode tabs.
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

// ---- The bar: the whole header-right cluster ------------------------------
// ONE gap rhythm (8px) across the entire cluster — name · divider · Save ·
// Open · ⋯ · divider · View all sit on the same beat (the old bar ran 4px
// between buttons but ~12px around the View menu: two rhythms in one row).
// `minWidth: 0` lets the cluster shrink inside the header's right zone; the
// project name is the flexible child and the density tiers (see header note)
// shed chrome before the name ever hits its floor.
export const bar = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  height: HEADER_CONTROL_H,
});

// THE hairline divider spec — used at both seams (name | actions and
// actions | View). No extra margin: the bar's single gap rhythm spaces it.
// (Replaces the second 1×18 `headerDivider` spec that lived in index.css.ts.)
export const barDivider = style({
  width: 1,
  height: 16,
  flexShrink: 0,
  background: border,
});

// Inline-editable project name — the bar's title and its ONLY flexible child.
// It ellipsizes under pressure, but with a sane floor: the old 40px minimum
// collapsed real names to a single character ("C…") because every sibling is
// flexShrink:0. Density tiers narrow the CAP first (so the buttons keep their
// labels) and only lower the floor at the smallest tier — the name always
// stays a readable word, never one letter. Becomes a real <input> on edit
// (same box metrics so there's no layout jump).
export const nameField = style({
  color: text,
  fontSize: 12.5,
  fontWeight: 600,
  letterSpacing: 0.1,
  minWidth: 96,
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
  selectors: {
    [`${bar}[data-density='tight'] &`]: {
      minWidth: 80,
      maxWidth: 132,
    },
    [`${bar}[data-density='min'] &`]: {
      minWidth: 48,
      maxWidth: 112,
    },
  },
  // ---- Mobile: shrink further so buttons don't get clipped ----------------
  '@media': {
    '(max-width: 600px)': {
      minWidth: 48,
      maxWidth: 100,
    },
  },
});

// The <input> shown while editing the name — matches nameField's metrics
// (and its density caps, so entering edit mode never widens the row).
export const nameInput = style({
  appearance: 'none',
  boxSizing: 'border-box',
  color: text,
  fontSize: 12.5,
  fontWeight: 600,
  letterSpacing: 0.1,
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
  selectors: {
    [`${bar}[data-density='tight'] &`]: {
      width: 140,
    },
    [`${bar}[data-density='min'] &`]: {
      width: 112,
    },
  },
});

// The "unsaved changes" indicator dot rendered INSIDE the Save button (before
// its label) whenever the working timeline is dirty. CurrentColor-tinted so it
// tracks the button's own text color (bright on the actionable accent Save).
export const saveDot = style({
  width: 6,
  height: 6,
  flexShrink: 0,
  borderRadius: '50%',
  background: 'currentColor',
});

// THE header button recipe (Save / Open / ⋯ / the View trigger in
// vdz-panel.tsx / menu rows). 28px tall to align on the row. Keep this the
// single source of truth — do not re-copy it (index.css.ts's old
// `viewMenuTrigger` duplicate is no longer referenced).
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

// Save-specific layer worn TOGETHER with barButton (the element carries both
// classes): a stable min-width so the Save / Saved / Saving… label swap never
// jitters the row, plus calm resting states — the base :disabled grey (opacity
// .4) read as broken chrome on the bar's primary action, so the clean state
// renders as a quiet "✓ Saved" status (full opacity, chromeless) and the
// in-flight state only dims slightly.
export const saveButton = style({
  minWidth: 88,
  justifyContent: 'center',
  selectors: {
    [`${bar}[data-density='tight'] &`]: {
      minWidth: 56,
    },
    [`${bar}[data-density='min'] &`]: {
      minWidth: 56,
    },
    '&[data-state="saved"]:disabled': {
      opacity: 1,
      background: 'transparent',
      borderColor: 'transparent',
      color: textDim,
      cursor: 'default',
    },
    '&[data-state="saving"]:disabled': {
      opacity: 0.7,
    },
  },
});

// The small check inside the resting Save button ("✓ Saved") — a status glyph,
// not an action affordance, tinted with the accent so "your work is safe"
// still reads positively.
export const saveCheck = style({
  fontSize: 11,
  lineHeight: 1,
  color: accent,
  flexShrink: 0,
});

// THE in-button chip recipe — one motif shared by the ⌘S hint and the View
// trigger's N/6 count (previously three different pill treatments in ~360px).
// Dimmed, monospaced, faint inset so it reads as an annotation, not a label.
export const barChip = style({
  fontSize: 10,
  fontWeight: 600,
  lineHeight: 1,
  color: textDim,
  padding: '2px 5px',
  borderRadius: 4,
  background: accentAlpha(10),
  flexShrink: 0,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
});

// The keyboard-hint chip (⌘S). First chrome to go when the cluster tightens —
// the shortcut still works, the button's title still documents it.
export const shortcutHint = style([
  barChip,
  {
    selectors: {
      [`${bar}[data-density='tight'] &`]: {
        display: 'none',
      },
      [`${bar}[data-density='min'] &`]: {
        display: 'none',
      },
    },
  },
]);

// The View trigger's visible-panels count (e.g. 4/6) — same chip recipe,
// tabular digits so 4/6 → 5/6 never shifts width. Kept at every density (it
// is the trigger's information payload once the label hides).
export const countBadge = style([
  barChip,
  {
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
  },
]);

// The View trigger's text label — hidden when the cluster tightens (the ▦
// glyph + count chip + tooltip carry the meaning at small widths).
export const viewLabel = style({
  selectors: {
    [`${bar}[data-density='tight'] &`]: {
      display: 'none',
    },
    [`${bar}[data-density='min'] &`]: {
      display: 'none',
    },
  },
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
    // ---- Mobile: don't let the popover overflow the viewport ---------------
    '@media': {
      '(max-width: 600px)': {
        width: 'min(320px, calc(100vw - 24px))',
        right: 0,
        left: 'auto',
      },
    },
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
