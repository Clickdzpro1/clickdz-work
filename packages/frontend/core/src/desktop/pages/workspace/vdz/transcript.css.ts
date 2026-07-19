import { globalStyle, keyframes, style } from '@vanilla-extract/css';

import { accentAlpha, v } from './theme.css';

/**
 * Transcript panel styles. Same contract as every vdz surface: colors come
 * from the `--vdz-*` theme bridge only.
 */

export const list = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
});

export const row = style({
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  alignItems: 'center',
  gap: 8,
  padding: '4px 6px',
  borderRadius: 7,
  borderLeft: '2px solid transparent',
  cursor: 'pointer',
  selectors: {
    '&:hover': {
      background: accentAlpha(8),
    },
    '&[data-active="true"]': {
      borderLeftColor: v.accent,
      background: accentAlpha(12),
    },
    '&[data-selected="true"]': {
      background: accentAlpha(16),
    },
  },
});

export const timeChip = style({
  flexShrink: 0,
  fontSize: 10,
  fontVariantNumeric: 'tabular-nums',
  color: v.muted,
  border: `1px solid ${v.border}`,
  borderRadius: 999,
  padding: '1px 6px',
  whiteSpace: 'nowrap',
});

export const textInput = style({
  appearance: 'none',
  width: '100%',
  minWidth: 0,
  border: '1px solid transparent',
  background: 'transparent',
  color: v.text,
  fontSize: 12,
  lineHeight: 1.5,
  padding: '3px 6px',
  borderRadius: 6,
  outline: 'none',
  ':focus': {
    borderColor: v.accent,
    background: v.bg,
    boxShadow: `0 0 0 2px ${accentAlpha(25)}`,
  },
});

export const delBtn = style({
  appearance: 'none',
  flexShrink: 0,
  border: 'none',
  background: 'transparent',
  color: v.muted,
  fontSize: 11,
  lineHeight: 1,
  width: 20,
  height: 20,
  borderRadius: 6,
  cursor: 'pointer',
  ':hover': {
    color: '#ff6b6b',
    background: 'color-mix(in srgb, #ff6b6b 12%, transparent)',
  },
});

export const emptyHint = style({
  color: v.muted,
  fontSize: 12,
  lineHeight: 1.6,
  padding: '8px 6px',
});

export const countBadge = style({
  fontSize: 10,
  fontWeight: 600,
  color: v.muted,
  border: `1px solid ${v.border}`,
  borderRadius: 999,
  padding: '1px 7px',
});

/**
 * Compact "Caption style" bar above the transcript list: two selects
 * (preset / position) + an apply button, on one wrapping row. Colors come from
 * the same `--vdz-*` theme bridge every vdz surface uses (no `accentAlpha`
 * here — plain tokens keep this export a pure `style()` result).
 */
export const styleBar = style({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  gap: 6,
  padding: '6px',
  marginBottom: 6,
  borderRadius: 8,
  border: `1px solid ${v.border}`,
  background: v.bg,
});

export const styleBarLabel = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  flex: '1 1 96px',
  minWidth: 0,
});

export const styleBarLabelText = style({
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: v.muted,
});

export const styleBarApply = style({
  appearance: 'none',
  flex: '1 1 100%',
  border: `1px solid ${v.border}`,
  background: v.bg,
  color: v.text,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1.4,
  padding: '5px 8px',
  borderRadius: 6,
  cursor: 'pointer',
  selectors: {
    '&:hover:not(:disabled)': {
      borderColor: v.accent,
      color: v.accent,
    },
    '&:disabled': {
      opacity: 0.5,
      cursor: 'default',
    },
  },
});

/* -------------------------------------------------------------------------
 * Clip-transcript mode (transcript-edit.tsx) — the Descript-style editor for a
 * selected VIDEO/AUDIO clip: a Transcribe action, then the words grouped into
 * sentences you can hover, select and delete (which CUTS the clip). A separate
 * visual block from the caption/overlay-text list above, but the same palette.
 * ---------------------------------------------------------------------------*/

/** Header row for the clip-transcript mode: title + the Transcribe/Re-run CTA. */
export const clipHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '2px 4px 8px',
});

export const clipTitle = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
  flex: 1,
});

export const clipTitleName = style({
  fontSize: 12,
  fontWeight: 600,
  color: v.text,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

export const clipTitleMeta = style({
  fontSize: 10,
  color: v.muted,
  fontVariantNumeric: 'tabular-nums',
});

/** The primary Transcribe / Re-transcribe button (accent-filled). */
export const transcribeBtn = style({
  appearance: 'none',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: `1px solid ${v.accent}`,
  background: accentAlpha(16),
  color: v.accent,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1.3,
  padding: '5px 10px',
  borderRadius: 7,
  cursor: 'pointer',
  transition: 'background 160ms ease, opacity 160ms ease',
  selectors: {
    '&:hover:not(:disabled)': {
      background: accentAlpha(24),
    },
    '&:disabled': {
      opacity: 0.55,
      cursor: 'default',
    },
  },
});

/** A small spinning ring used inside the Transcribe button + loading states. */
const spin = keyframes({
  to: { transform: 'rotate(360deg)' },
});

export const spinner = style({
  display: 'inline-block',
  width: 12,
  height: 12,
  borderRadius: '50%',
  border: `2px solid ${accentAlpha(30)}`,
  borderTopColor: v.accent,
  animation: `${spin} 0.7s linear infinite`,
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animation: 'none',
      // Fall back to a static half-ring so it still reads as "busy".
      borderTopColor: v.accent,
    },
  },
});

/** The scrolling flow of sentence blocks. */
export const sentenceFlow = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
});

/** One sentence: a time chip, the word flow, and a delete (✕) action. */
export const sentence = style({
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  alignItems: 'start',
  gap: 8,
  padding: '6px 6px',
  borderRadius: 8,
  border: '1px solid transparent',
  borderLeft: '2px solid transparent',
  transition: 'background 150ms ease, border-color 150ms ease',
  selectors: {
    '&:hover': {
      background: accentAlpha(8),
      borderColor: v.border,
    },
    '&[data-active="true"]': {
      borderLeftColor: v.accent,
      background: accentAlpha(12),
    },
    // While the row is armed for deletion, tint it red so the effect is clear.
    '&[data-arm="true"]': {
      background: 'color-mix(in srgb, #ff6b6b 10%, transparent)',
      borderColor: 'color-mix(in srgb, #ff6b6b 45%, transparent)',
    },
  },
});

export const sentenceWords = style({
  display: 'block',
  fontSize: 12.5,
  lineHeight: 1.6,
  color: v.text,
  cursor: 'text',
  userSelect: 'text',
  minWidth: 0,
});

/** One selectable word chip inside a sentence. */
export const word = style({
  borderRadius: 4,
  padding: '0 1px',
  cursor: 'pointer',
  transition: 'background 120ms ease, color 120ms ease',
  selectors: {
    '&:hover': {
      background: accentAlpha(20),
    },
    // The word under the playhead (karaoke-style highlight).
    '&[data-playing="true"]': {
      color: v.accent,
      fontWeight: 600,
    },
    // Part of the current word-span selection.
    '&[data-picked="true"]': {
      background: accentAlpha(32),
      color: v.text,
    },
  },
});

/** Trailing space between word chips (kept selectable-looking, not clickable). */
globalStyle(`${sentenceWords} > .${word} + .${word}`, {
  marginLeft: 0,
});

/** The per-sentence delete (✕) — cuts the underlying clip. */
export const cutBtn = style({
  appearance: 'none',
  flexShrink: 0,
  border: `1px solid transparent`,
  background: 'transparent',
  color: v.muted,
  fontSize: 11,
  lineHeight: 1,
  width: 22,
  height: 22,
  borderRadius: 6,
  cursor: 'pointer',
  transition: 'color 140ms ease, background 140ms ease',
  selectors: {
    '&:hover:not(:disabled)': {
      color: '#ff6b6b',
      background: 'color-mix(in srgb, #ff6b6b 14%, transparent)',
    },
    '&:disabled': {
      opacity: 0.4,
      cursor: 'default',
    },
  },
});

/** Floating action bar shown when a word-span is selected: "Cut selection". */
export const selectionBar = style({
  position: 'sticky',
  bottom: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 6,
  padding: '7px 8px',
  borderRadius: 8,
  border: `1px solid ${v.border}`,
  background: v.panel,
  boxShadow: '0 -4px 12px rgba(0,0,0,0.18)',
});

export const selectionInfo = style({
  flex: 1,
  minWidth: 0,
  fontSize: 11,
  color: v.muted,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

export const selectionCut = style({
  appearance: 'none',
  flexShrink: 0,
  border: `1px solid color-mix(in srgb, #ff6b6b 55%, transparent)`,
  background: 'color-mix(in srgb, #ff6b6b 16%, transparent)',
  color: '#ff8a8a',
  fontSize: 11,
  fontWeight: 600,
  padding: '5px 10px',
  borderRadius: 7,
  cursor: 'pointer',
  transition: 'background 140ms ease',
  ':hover': {
    background: 'color-mix(in srgb, #ff6b6b 26%, transparent)',
  },
});

export const selectionClear = style({
  appearance: 'none',
  flexShrink: 0,
  border: `1px solid ${v.border}`,
  background: 'transparent',
  color: v.muted,
  fontSize: 11,
  padding: '5px 8px',
  borderRadius: 7,
  cursor: 'pointer',
  ':hover': {
    color: v.text,
    borderColor: v.accent,
  },
});

/** Inline error strip (typed-error message from a failed transcribe/cut). */
export const errorBar = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  margin: '4px 4px 8px',
  padding: '6px 8px',
  borderRadius: 7,
  border: `1px solid color-mix(in srgb, #ff6b6b 40%, transparent)`,
  background: 'color-mix(in srgb, #ff6b6b 8%, transparent)',
  color: '#ff9a9a',
  fontSize: 11,
  lineHeight: 1.5,
});

/** Centered loading/empty block for the clip-transcript mode. */
export const centerState = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '22px 12px',
  color: v.muted,
  fontSize: 12,
  lineHeight: 1.6,
  textAlign: 'center',
});

/** A subtle divider label separating the two transcript modes when both show. */
export const modeDivider = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  margin: '10px 2px 6px',
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: v.muted,
  selectors: {
    '&::before, &::after': {
      content: '""',
      flex: 1,
      height: 1,
      background: v.border,
    },
  },
});
