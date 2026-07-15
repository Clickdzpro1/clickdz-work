import { keyframes, style } from '@vanilla-extract/css';

// Self-contained dark palette for the Vdz Studio preview shell. These values
// intentionally do not use theme vars — the editor surface stays dark
// regardless of the app theme (mirrors pro video tools).
const bg = '#0b0d12';
const panel = '#12151d';
const raised = '#232838';
const border = '#232838';
const text = '#e6e9f2';
const textDim = '#8b93a7';
const accent = '#5b8cff';
const accent2 = '#a06bff';

export const root = style({
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  height: '100%',
  width: '100%',
  minHeight: 0,
  background: bg,
  color: text,
  fontSize: 13,
  overflow: 'hidden',
});

export const header = style({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 16px',
  borderBottom: `1px solid ${border}`,
  background: panel,
  flexShrink: 0,
});

export const headerTitle = style({
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: 0.2,
});

export const pill = style({
  fontSize: 11,
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: 999,
  color: '#fff',
  background: `linear-gradient(90deg, ${accent}, ${accent2})`,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
});

export const timelineName = style({
  marginLeft: 'auto',
  color: textDim,
  fontSize: 12,
});

export const main = style({
  display: 'flex',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
});

export const stage = style({
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minWidth: 0,
  padding: 16,
  gap: 12,
  overflow: 'hidden',
});

export const previewWrapper = style({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

// 16:9 preview canvas. `containerType: size` lets clip text scale to the box
// via `cqh` units (see PreviewClip); kept here rather than inline so the CSS
// prop is typed by vanilla-extract, not React's inline CSSProperties.
export const preview = style({
  position: 'relative',
  aspectRatio: '16 / 9',
  width: '100%',
  maxHeight: '100%',
  background: '#000',
  borderRadius: 8,
  overflow: 'hidden',
  boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
  border: `1px solid ${border}`,
  containerType: 'size',
});

// A clip rendered inside the preview. Positioning is applied inline (dynamic).
export const previewLayer = style({
  position: 'absolute',
});

export const previewText = style({
  position: 'absolute',
  transform: 'translate(-50%, -50%)',
  whiteSpace: 'pre-wrap',
  fontWeight: 700,
  lineHeight: 1.1,
  textShadow: '0 2px 12px rgba(0,0,0,0.6)',
});

export const previewImage = style({
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
});

export const previewImagePlaceholder = style({
  position: 'absolute',
  inset: '10%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: `2px dashed ${raised}`,
  borderRadius: 8,
  color: textDim,
  fontSize: 12,
});

export const previewVideoBlock = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: text,
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: 0.5,
  background:
    'repeating-linear-gradient(45deg, rgba(255,255,255,0.04) 0 12px, rgba(255,255,255,0) 12px 24px)',
});

export const previewEmpty = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: textDim,
  fontSize: 13,
});

// Right inspector panel.
export const inspector = style({
  width: 300,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  borderLeft: `1px solid ${border}`,
  background: panel,
  overflow: 'hidden',
});

export const inspectorTitle = style({
  padding: '10px 14px',
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: textDim,
  borderBottom: `1px solid ${border}`,
});

export const inspectorBody = style({
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: 14,
});

export const inspectorHint = style({
  color: textDim,
  fontSize: 12,
  lineHeight: 1.5,
});

export const jsonBlock = style({
  margin: 0,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 12,
  lineHeight: 1.5,
  color: text,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
});

export const inspectorMeta = style({
  marginTop: 12,
  paddingTop: 12,
  borderTop: `1px solid ${border}`,
  color: textDim,
  fontSize: 12,
  lineHeight: 1.5,
});

// Timeline area.
export const timeline = style({
  flexShrink: 0,
  borderTop: `1px solid ${border}`,
  background: panel,
  padding: '10px 16px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
});

export const scrubberRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
});

export const scrubber = style({
  flex: 1,
  accentColor: accent,
  cursor: 'pointer',
});

export const timecode = style({
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 12,
  color: textDim,
  minWidth: 96,
  textAlign: 'right',
});

export const lanes = style({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  paddingTop: 4,
});

export const lane = style({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  height: 40,
});

export const laneLabel = style({
  width: 64,
  flexShrink: 0,
  fontSize: 11,
  color: textDim,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  textAlign: 'right',
});

export const laneTrack = style({
  position: 'relative',
  flex: 1,
  height: '100%',
  background: bg,
  borderRadius: 6,
  border: `1px solid ${border}`,
  overflow: 'hidden',
});

// A clip block on a lane. left/width set inline (dynamic).
export const clipBlock = style({
  position: 'absolute',
  top: 4,
  bottom: 4,
  borderRadius: 4,
  padding: '0 8px',
  display: 'flex',
  alignItems: 'center',
  fontSize: 11,
  fontWeight: 600,
  color: '#fff',
  cursor: 'pointer',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  border: '1px solid transparent',
  boxSizing: 'border-box',
  transition: 'filter 120ms ease, border-color 120ms ease',
  ':hover': {
    filter: 'brightness(1.12)',
  },
});

export const clipBlockSelected = style({
  borderColor: '#fff',
  boxShadow: `0 0 0 1px ${accent}`,
});

// Playhead vertical line. left set inline (dynamic).
export const playhead = style({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 2,
  background: accent,
  pointerEvents: 'none',
  zIndex: 5,
});

const blink = keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.4 },
});

// Footer / AI dock strip.
export const footer = style({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '8px 16px',
  borderTop: `1px solid ${border}`,
  background: raised,
  flexShrink: 0,
});

export const footerLabel = style({
  fontSize: 12,
  fontWeight: 600,
  color: textDim,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
});

export const footerDot = style({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: accent2,
  animation: `${blink} 1.6s ease-in-out infinite`,
});

export const footerSpacer = style({
  flex: 1,
});

export const button = style({
  appearance: 'none',
  border: `1px solid ${border}`,
  background: panel,
  color: text,
  fontSize: 12,
  fontWeight: 600,
  padding: '6px 12px',
  borderRadius: 6,
  cursor: 'pointer',
  transition: 'background 120ms ease, border-color 120ms ease',
  ':hover': {
    background: raised,
    borderColor: accent,
  },
});

export const errorText = style({
  color: '#ff6b6b',
  fontSize: 12,
});
