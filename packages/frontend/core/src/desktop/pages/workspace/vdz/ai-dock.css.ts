import { keyframes, style } from '@vanilla-extract/css';

// Self-contained dark palette — matches the Vdz Studio shell (index.css.ts).
// Intentionally not theme-var driven: the editor surface stays dark regardless
// of app theme, mirroring pro video tools.
const bg = '#0b0d12';
const panel = '#12151d';
const raised = '#232838';
const border = '#232838';
const text = '#e6e9f2';
const textDim = '#8b93a7';
const accent = '#5b8cff';
const accent2 = '#a06bff';

export const dock = style({
  width: 340,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  borderLeft: `1px solid ${border}`,
  background: panel,
  color: text,
  fontSize: 13,
  overflow: 'hidden',
});

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
