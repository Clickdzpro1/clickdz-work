import { keyframes, style } from '@vanilla-extract/css';

// Self-contained dark palette — matches the Vdz Studio shell (index.css.ts,
// ai-dock.css.ts). Intentionally not theme-var driven: the editor surface
// stays dark regardless of app theme, mirroring pro video tools.
const bg = '#0b0d12';
const panel = '#12151d';
const raised = '#232838';
const border = '#232838';
const text = '#e6e9f2';
const textDim = '#8b93a7';
const accent = '#5b8cff';
const accent2 = '#a06bff';

export const bin = style({
  width: 300,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  borderRight: `1px solid ${border}`,
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

export const headerDot = style({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: `linear-gradient(90deg, ${accent}, ${accent2})`,
});

export const headerTitle = style({
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: textDim,
});

export const headerSpacer = style({
  flex: 1,
});

export const headerCount = style({
  fontSize: 11,
  fontWeight: 600,
  color: textDim,
});

// ---- Tabs ---------------------------------------------------------------
export const tabs = style({
  display: 'flex',
  gap: 2,
  padding: 8,
  borderBottom: `1px solid ${border}`,
  flexShrink: 0,
});

export const tab = style({
  appearance: 'none',
  flex: 1,
  border: 'none',
  background: 'transparent',
  color: textDim,
  fontSize: 12,
  fontWeight: 600,
  padding: '6px 8px',
  borderRadius: 6,
  cursor: 'pointer',
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

// The scrollable body area under the tabs.
export const body = style({
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 12,
});

// ---- Upload tab ---------------------------------------------------------
export const dropZone = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '22px 14px',
  border: `2px dashed ${raised}`,
  borderRadius: 10,
  background: bg,
  color: textDim,
  fontSize: 12,
  lineHeight: 1.5,
  textAlign: 'center',
  cursor: 'pointer',
  transition: 'border-color 120ms ease, background 120ms ease',
  ':hover': {
    borderColor: accent,
    color: text,
  },
  selectors: {
    '&[data-dragover="true"]': {
      borderColor: accent,
      background: 'rgba(91,140,255,0.08)',
      color: text,
    },
  },
});

export const dropZoneTitle = style({
  color: text,
  fontWeight: 600,
  fontSize: 13,
});

export const dropZoneHint = style({
  fontSize: 11,
  color: textDim,
});

export const hiddenInput = style({
  display: 'none',
});

// ---- Prompt / search rows (AI + Stock tabs) -----------------------------
export const searchRow = style({
  display: 'flex',
  gap: 8,
  alignItems: 'center',
});

export const searchInput = style({
  flex: 1,
  minWidth: 0,
  height: 34,
  padding: '0 11px',
  borderRadius: 8,
  border: `1px solid ${border}`,
  background: bg,
  color: text,
  fontSize: 13,
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

export const primaryButton = style({
  appearance: 'none',
  border: 'none',
  borderRadius: 8,
  padding: '0 14px',
  height: 34,
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

export const errorBar = style({
  padding: '7px 10px',
  borderRadius: 8,
  background: 'rgba(255,107,107,0.1)',
  border: '1px solid rgba(255,107,107,0.3)',
  color: '#ff8f8f',
  fontSize: 12,
  lineHeight: 1.4,
  flexShrink: 0,
  wordBreak: 'break-word',
});

const pulse = keyframes({
  '0%, 100%': { opacity: 0.4 },
  '50%': { opacity: 1 },
});

export const status = style({
  fontSize: 12,
  color: textDim,
  animation: `${pulse} 1.4s ease-in-out infinite`,
});

export const emptyHint = style({
  color: textDim,
  fontSize: 12,
  lineHeight: 1.6,
  textAlign: 'center',
  padding: '8px 4px',
});

// ---- Results grid (AI + Stock) ------------------------------------------
export const grid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: 8,
});

export const gridCell = style({
  position: 'relative',
  aspectRatio: '1 / 1',
  border: `1px solid ${border}`,
  borderRadius: 8,
  overflow: 'hidden',
  cursor: 'pointer',
  background: bg,
  padding: 0,
  transition: 'border-color 120ms ease, filter 120ms ease',
  ':hover': {
    borderColor: accent,
    filter: 'brightness(1.08)',
  },
});

export const gridImage = style({
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
  pointerEvents: 'none',
});

export const gridCellOverlay = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  padding: 6,
  opacity: 0,
  background: 'linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0) 55%)',
  color: '#fff',
  fontSize: 11,
  fontWeight: 600,
  transition: 'opacity 120ms ease',
  selectors: {
    [`${gridCell}:hover &`]: {
      opacity: 1,
    },
  },
});

// ---- Bin item list (uploaded / added media) ----------------------------
export const sectionLabel = style({
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: textDim,
  marginTop: 2,
});

export const list = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
});

export const item = style({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: 8,
  borderRadius: 8,
  border: `1px solid ${border}`,
  background: bg,
  cursor: 'grab',
  transition: 'border-color 120ms ease, background 120ms ease',
  ':hover': {
    borderColor: accent,
    background: raised,
  },
  selectors: {
    '&:active': {
      cursor: 'grabbing',
    },
  },
});

export const thumb = style({
  position: 'relative',
  width: 56,
  height: 40,
  flexShrink: 0,
  borderRadius: 5,
  overflow: 'hidden',
  background: '#000',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: `1px solid ${border}`,
});

export const thumbImage = style({
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
});

// Placeholder glyph for audio (or any media with no visual thumbnail).
export const thumbGlyph = style({
  fontSize: 18,
  color: textDim,
});

export const audioWave = style({
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  height: 18,
});

export const audioBar = style({
  width: 3,
  borderRadius: 2,
  background: accent,
});

export const itemMeta = style({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
});

export const itemName = style({
  fontSize: 12,
  fontWeight: 600,
  color: text,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
});

export const itemSub = style({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  color: textDim,
});

export const badge = style({
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  padding: '1px 6px',
  borderRadius: 999,
  color: '#fff',
});

export const badgeVideo = style([badge, { background: accent }]);
export const badgeAudio = style([badge, { background: '#3fb7a6' }]);
export const badgeImage = style([badge, { background: accent2 }]);

export const itemActions = style({
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flexShrink: 0,
});

export const iconButton = style({
  appearance: 'none',
  border: `1px solid ${border}`,
  background: panel,
  color: text,
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1,
  width: 24,
  height: 24,
  borderRadius: 6,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 120ms ease, border-color 120ms ease',
  ':hover': {
    background: raised,
    borderColor: accent,
  },
});

export const removeButton = style([
  iconButton,
  {
    ':hover': {
      borderColor: '#ff6b6b',
      color: '#ff8f8f',
    },
  },
]);
