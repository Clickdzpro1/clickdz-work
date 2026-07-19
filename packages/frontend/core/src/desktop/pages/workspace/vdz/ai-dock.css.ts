import { keyframes, style } from '@vanilla-extract/css';

import { accentAlpha, accent2Alpha, v, vdzTheme } from './theme.css';

// Theme-aware palette — matches the Vdz Studio shell (index.css.ts). Tokens are
// `--affine-*` theme vars with the original hexes as fallbacks (see
// theme.css.ts) so the dock follows cdz themes + light mode. The dock's root
// carries the vdzTheme marker (composed into `dock` below) so the vars resolve
// on its portaled island.
const bg = v.bg;
const panel = v.panel;
const raised = v.raised;
const border = v.border;
const text = v.text;
const textDim = v.muted;
const accent = v.accent;
const accent2 = v.accent2;

// A slightly-brighter "raised" used only on chip hover; derived from the themed
// accent so it tracks the palette instead of being a fixed slate.
const raisedHover = `color-mix(in srgb, ${accent} 14%, ${raised})`;

// Recording-mic pulse (defined up here so styles below can reference it).
const pulseGlow = keyframes({
  '0%, 100%': { boxShadow: '0 0 0 0 rgba(238,90,111,0.5)' },
  '50%': { boxShadow: '0 0 0 4px rgba(238,90,111,0)' },
});

export const dock = style([
  vdzTheme,
  {
    // Width is owned by the layout slot wrapper; the dock fills it. A strict
    // flex column — [header] / [thread scroller] / [error] / [composer] — where
    // `minHeight:0` + the thread's own `overflow:auto` keep the message list AND
    // the composer inside the panel; they never overlap the studio footer.
    width: '100%',
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    borderLeft: `1px solid ${border}`,
    background: panel,
    color: text,
    fontSize: 13,
    overflow: 'hidden',
  },
]);

export const header = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px',
  borderBottom: `1px solid ${border}`,
  flexShrink: 0,
});

export const headerTitle = style({
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: textDim,
});

export const headerDot = style({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: `linear-gradient(90deg, ${accent}, ${accent2})`,
});

export const headerSpacer = style({
  flex: 1,
});

export const resetButton = style({
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: textDim,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  padding: '2px 4px',
  borderRadius: 4,
  transition: 'color 120ms ease',
  ':hover': {
    color: text,
  },
  ':disabled': {
    opacity: 0.4,
    cursor: 'default',
  },
});

// ---- Header: Edit | Plan mode toggle -----------------------------------
export const modeTabs = style({
  display: 'inline-flex',
  padding: 2,
  borderRadius: 8,
  background: bg,
  border: `1px solid ${border}`,
  gap: 2,
});

export const modeTab = style({
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: textDim,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  padding: '3px 10px',
  borderRadius: 6,
  transition: 'background 120ms ease, color 120ms ease',
  ':hover': {
    color: text,
  },
  selectors: {
    '&[data-active="true"]': {
      background: raised,
      color: text,
    },
  },
});

// ---- Header: mic (dictation) button — right-aligned next to Clear ------
export const micButton = style({
  appearance: 'none',
  flexShrink: 0,
  border: `1px solid ${border}`,
  background: bg,
  color: textDim,
  width: 26,
  height: 26,
  borderRadius: 8,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 120ms ease, color 120ms ease, border-color 120ms',
  ':hover': {
    color: text,
    borderColor: accent,
  },
  ':disabled': {
    opacity: 0.4,
    cursor: 'default',
  },
});

// Recording state — the mic glows and pulses so it's unmistakable.
export const micButtonActive = style([
  micButton,
  {
    color: '#fff',
    background: 'linear-gradient(135deg, #ff6b6b, #ee5a6f)',
    borderColor: 'transparent',
    animation: `${pulseGlow} 1.4s ease-in-out infinite`,
    ':hover': {
      color: '#fff',
    },
  },
]);

// Header collapse (×) — hides the dock to a reopen tab.
export const collapseButton = style({
  appearance: 'none',
  flexShrink: 0,
  border: `1px solid transparent`,
  background: 'transparent',
  color: textDim,
  fontSize: 15,
  lineHeight: 1,
  width: 22,
  height: 22,
  borderRadius: 6,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 120ms ease, color 120ms ease, border-color 120ms',
  ':hover': {
    color: text,
    background: raised,
    borderColor: border,
  },
});

export const thread = style({
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
});

export const emptyState = style({
  margin: 'auto',
  textAlign: 'center',
  color: textDim,
  fontSize: 12,
  lineHeight: 1.6,
  padding: '0 8px',
});

export const emptyTitle = style({
  color: text,
  fontWeight: 600,
  marginBottom: 6,
});

const bubbleBase = style({
  maxWidth: '88%',
  padding: '8px 11px',
  borderRadius: 12,
  fontSize: 13,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
});

export const userBubble = style([
  bubbleBase,
  {
    alignSelf: 'flex-end',
    background: `linear-gradient(135deg, ${accent}, ${accent2})`,
    color: '#fff',
    borderBottomRightRadius: 4,
  },
]);

export const aiBubble = style([
  bubbleBase,
  {
    alignSelf: 'flex-start',
    background: raised,
    color: text,
    border: `1px solid ${border}`,
    borderBottomLeftRadius: 4,
  },
]);

export const aiBubbleError = style([
  bubbleBase,
  {
    alignSelf: 'flex-start',
    background: 'rgba(255,107,107,0.08)',
    color: '#ff8f8f',
    border: '1px solid rgba(255,107,107,0.3)',
    borderBottomLeftRadius: 4,
  },
]);

export const opCount = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  marginTop: 6,
  fontSize: 11,
  fontWeight: 600,
  color: textDim,
});

export const opCountDot = style({
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: accent,
});

export const rawDetails = style({
  marginTop: 8,
  fontSize: 11,
});

export const rawSummary = style({
  color: textDim,
  cursor: 'pointer',
  userSelect: 'none',
});

export const rawPre = style({
  margin: '6px 0 0',
  padding: 8,
  background: bg,
  borderRadius: 6,
  border: `1px solid ${border}`,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 11,
  lineHeight: 1.45,
  color: textDim,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 160,
  overflow: 'auto',
});

const pulse = keyframes({
  '0%, 100%': { opacity: 0.35 },
  '50%': { opacity: 1 },
});

export const typing = style([
  bubbleBase,
  {
    alignSelf: 'flex-start',
    background: raised,
    color: textDim,
    border: `1px solid ${border}`,
    borderBottomLeftRadius: 4,
    display: 'inline-flex',
    gap: 5,
    alignItems: 'center',
    animation: `${pulse} 1.4s ease-in-out infinite`,
  },
]);

export const errorBar = style({
  margin: '0 14px 8px',
  padding: '7px 10px',
  borderRadius: 8,
  background: 'rgba(255,107,107,0.1)',
  border: '1px solid rgba(255,107,107,0.3)',
  color: '#ff8f8f',
  fontSize: 12,
  lineHeight: 1.4,
  flexShrink: 0,
});

export const composer = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderTop: `1px solid ${border}`,
  flexShrink: 0,
});

export const selectionHint = style({
  fontSize: 11,
  color: textDim,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
});

export const selectionPill = style({
  padding: '1px 7px',
  borderRadius: 999,
  background: raised,
  border: `1px solid ${border}`,
  color: text,
  fontWeight: 600,
});

export const inputRow = style({
  display: 'flex',
  alignItems: 'flex-end',
  gap: 8,
});

export const textarea = style({
  flex: 1,
  resize: 'none',
  minHeight: 38,
  maxHeight: 140,
  padding: '9px 11px',
  borderRadius: 8,
  border: `1px solid ${border}`,
  background: bg,
  color: text,
  fontSize: 13,
  lineHeight: 1.4,
  fontFamily: 'inherit',
  outline: 'none',
  transition: 'border-color 120ms ease',
  '::placeholder': {
    color: textDim,
  },
  ':focus': {
    borderColor: accent,
  },
});

export const sendButton = style({
  appearance: 'none',
  border: 'none',
  borderRadius: 8,
  padding: '0 14px',
  height: 38,
  flexShrink: 0,
  fontSize: 13,
  fontWeight: 600,
  color: '#fff',
  cursor: 'pointer',
  background: `linear-gradient(135deg, ${accent}, ${accent2})`,
  transition: 'filter 120ms ease, opacity 120ms ease',
  ':hover': {
    filter: 'brightness(1.1)',
  },
  ':disabled': {
    opacity: 0.5,
    cursor: 'default',
    filter: 'none',
  },
});

// ---- Proactive suggestion chips ----------------------------------------
// Rendered in the idle/empty thread; clicking a chip sends it as a message.
export const suggestions = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 12,
  justifyContent: 'center',
});

export const suggestionsLabel = style({
  width: '100%',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: textDim,
  marginBottom: 2,
  textAlign: 'center',
});

export const suggestionChip = style({
  appearance: 'none',
  border: `1px solid ${border}`,
  background: raised,
  color: text,
  fontSize: 11.5,
  lineHeight: 1.3,
  textAlign: 'left',
  padding: '6px 10px',
  borderRadius: 999,
  cursor: 'pointer',
  transition: 'border-color 120ms ease, background 120ms ease',
  ':hover': {
    borderColor: accent,
    background: raisedHover,
  },
  ':disabled': {
    opacity: 0.5,
    cursor: 'default',
  },
});

// ---- In-thread proposal card (Accept / Revert) -------------------------
// The pending AI proposal renders as a bubble at the END of the thread so the
// user reviews + applies it right where they're already looking.
export const proposalCard = style({
  alignSelf: 'stretch',
  maxWidth: '100%',
  borderRadius: 12,
  border: `1px solid ${accent}`,
  background: `linear-gradient(180deg, ${accentAlpha(10)}, ${accent2Alpha(6)})`,
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
});

export const proposalHead = style({
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: accent,
});

export const proposalCount = style({
  marginLeft: 'auto',
  padding: '1px 8px',
  borderRadius: 999,
  background: raised,
  border: `1px solid ${border}`,
  color: text,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0,
  textTransform: 'none',
});

export const proposalSummary = style({
  fontSize: 13,
  lineHeight: 1.5,
  color: text,
});

export const proposalOps = style({
  fontSize: 11,
});

export const proposalOpsSummary = style({
  color: textDim,
  cursor: 'pointer',
  userSelect: 'none',
  fontWeight: 600,
  ':hover': {
    color: text,
  },
});

export const proposalOpList = style({
  listStyle: 'none',
  margin: '8px 0 0',
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  maxHeight: 180,
  overflow: 'auto',
});

export const proposalOpItem = style({
  display: 'flex',
  gap: 7,
  alignItems: 'baseline',
  padding: '5px 8px',
  borderRadius: 6,
  background: bg,
  border: `1px solid ${border}`,
  fontSize: 11,
  color: text,
});

export const proposalOpKind = style({
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontWeight: 700,
  color: accent,
  flexShrink: 0,
});

export const proposalOpDetail = style({
  color: textDim,
  wordBreak: 'break-word',
});

export const proposalActions = style({
  display: 'flex',
  gap: 8,
});

export const proposalAccept = style({
  appearance: 'none',
  flex: 1,
  border: 'none',
  borderRadius: 8,
  padding: '9px 12px',
  fontSize: 13,
  fontWeight: 700,
  color: '#fff',
  cursor: 'pointer',
  background: `linear-gradient(135deg, ${accent}, ${accent2})`,
  transition: 'filter 120ms ease',
  ':hover': {
    filter: 'brightness(1.1)',
  },
  ':disabled': {
    opacity: 0.5,
    cursor: 'default',
    filter: 'none',
  },
});

export const proposalRevert = style({
  appearance: 'none',
  flex: 1,
  borderRadius: 8,
  padding: '9px 12px',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  color: text,
  background: 'transparent',
  border: `1px solid ${border}`,
  transition: 'background 120ms ease, border-color 120ms ease',
  ':hover': {
    background: raised,
    borderColor: textDim,
  },
});

export const proposalError = style({
  fontSize: 11,
  color: '#ff8f8f',
  lineHeight: 1.4,
});

// ---- In-thread plan checklist card (Plan mode) -------------------------
export const planCard = style([
  proposalCard,
  {
    borderColor: accent2,
    background: `linear-gradient(180deg, ${accent2Alpha(12)}, ${accentAlpha(5)})`,
  },
]);

export const planHead = style([
  proposalHead,
  {
    color: accent2,
  },
]);

export const planList = style({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  counterReset: 'vdz-plan',
});

export const planItem = style({
  display: 'flex',
  gap: 10,
  alignItems: 'flex-start',
});

export const planStepNum = style({
  flexShrink: 0,
  width: 20,
  height: 20,
  borderRadius: '50%',
  background: raised,
  border: `1px solid ${border}`,
  color: text,
  fontSize: 11,
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

export const planStepBody = style({
  flex: 1,
  minWidth: 0,
});

export const planStepTitle = style({
  fontSize: 12.5,
  lineHeight: 1.4,
  color: text,
  fontWeight: 600,
});

export const planStepAction = style({
  fontSize: 11,
  lineHeight: 1.4,
  color: textDim,
  marginTop: 2,
});

export const planDoButton = style({
  appearance: 'none',
  marginTop: 6,
  border: `1px solid ${border}`,
  background: raised,
  color: text,
  fontSize: 11,
  fontWeight: 700,
  padding: '4px 12px',
  borderRadius: 7,
  cursor: 'pointer',
  transition: 'border-color 120ms ease, background 120ms ease',
  ':hover': {
    borderColor: accent,
    background: raisedHover,
  },
  ':disabled': {
    opacity: 0.5,
    cursor: 'default',
  },
});

// The composer's placeholder differs by mode; a small hint above the input.
export const modeHint = style({
  fontSize: 11,
  color: textDim,
  lineHeight: 1.4,
});

// ---- Context strip: live playhead readout + selected-clip chip ----------
// Additive, subtle extensions of the (inline-styled) context strip so the user
// sees exactly what the AI sees. Theme-aware via the same tokens as the dock.

// Playhead timecode + frame. tabular-nums keeps the readout from jittering as
// the value ticks.
export const ctxPlayhead = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
});

// The frame count, dimmed a touch relative to the timecode.
export const ctxPlayheadFrame = style({
  opacity: 0.7,
});

// A small pill naming the sole-selected clip (kind icon + truncated label), so
// the user can confirm the AI's "this"/"selected clip" target at a glance.
export const ctxSelectedChip = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  maxWidth: '100%',
  padding: '1px 8px',
  borderRadius: 999,
  border: `1px solid ${border}`,
  background: `color-mix(in srgb, ${accent} 12%, ${raised})`,
  color: text,
});

// The chip's label truncates rather than wrapping the strip.
export const ctxSelectedLabel = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
