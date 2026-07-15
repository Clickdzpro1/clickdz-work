import { globalStyle, keyframes, style } from '@vanilla-extract/css';

import { accentAlpha, accent2Alpha, v, vdzTheme } from './theme.css';

/**
 * Vdz Studio — AI Video Generator panel styles.
 *
 * Theme-aware palette (see theme.css.ts): each token is an `--affine-*` theme
 * var with the original hex as a fallback, so the panel follows cdz themes +
 * light mode while defaulting to the old dark look. The panel root carries the
 * vdzTheme marker (composed into `root` below).
 *   surface   --vdz-bg      panel bg
 *   raised    --vdz-panel   inputs / control bar / cards
 *   border    --vdz-border  hairline separators
 *   accent    --vdz-accent → --vdz-accent-2  (brand gradient)
 */
const SURFACE = v.bg;
const RAISED = v.panel;
const BORDER = v.border;
const ACCENT_FROM = v.accent;
const ACCENT_TO = v.accent2;
const TEXT = v.text;
const MUTED = v.muted;
const DANGER = '#ff6b81';

const spin = keyframes({
  to: { transform: 'rotate(360deg)' },
});

export const root = style([
  vdzTheme,
  {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    width: '100%',
    height: '100%',
    minHeight: 0,
    padding: 20,
    boxSizing: 'border-box',
    background: SURFACE,
    color: TEXT,
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
]);

export const header = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
});

export const title = style({
  margin: 0,
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: '-0.01em',
});

export const subtitle = style({
  margin: 0,
  fontSize: 13,
  color: MUTED,
});

// ── generation mode switch ("In editor" vs "Motion HTML") ─────────
export const modeSwitch = style({
  display: 'flex',
  gap: 10,
  width: '100%',
});

export const modeOption = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  flex: 1,
  padding: '10px 14px',
  borderRadius: 12,
  border: `1px solid ${BORDER}`,
  background: RAISED,
  color: TEXT,
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'border-color 120ms ease, background 120ms ease',
  selectors: {
    '&:hover': { borderColor: ACCENT_FROM },
    // Active option: accent border + a faint accent wash.
    '&[data-active="true"]': {
      borderColor: ACCENT_FROM,
      background: `linear-gradient(135deg, ${accentAlpha(16)}, ${accent2Alpha(12)})`,
    },
  },
});

export const modeOptionTitle = style({
  fontSize: 14,
  fontWeight: 600,
});

export const modeOptionHint = style({
  fontSize: 12,
  color: MUTED,
});

// ── prompt input row ──────────────────────────────────────────────
export const promptRow = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
});

export const textarea = style({
  width: '100%',
  minHeight: 92,
  resize: 'vertical',
  padding: '12px 14px',
  boxSizing: 'border-box',
  borderRadius: 12,
  border: `1px solid ${BORDER}`,
  background: RAISED,
  color: TEXT,
  fontSize: 14,
  lineHeight: 1.5,
  fontFamily: 'inherit',
  outline: 'none',
  selectors: {
    '&:focus': { borderColor: ACCENT_FROM },
    '&::placeholder': { color: MUTED },
    '&:disabled': { opacity: 0.6, cursor: 'not-allowed' },
  },
});

export const actionsRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
});

export const primaryButton = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  height: 40,
  padding: '0 20px',
  border: 'none',
  borderRadius: 10,
  cursor: 'pointer',
  color: '#ffffff',
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  backgroundImage: `linear-gradient(135deg, ${ACCENT_FROM}, ${ACCENT_TO})`,
  transition: 'opacity 120ms ease, transform 120ms ease',
  selectors: {
    '&:hover:not(:disabled)': { opacity: 0.92 },
    '&:active:not(:disabled)': { transform: 'translateY(1px)' },
    '&:disabled': { opacity: 0.55, cursor: 'not-allowed' },
  },
});

export const ghostButton = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  height: 40,
  padding: '0 14px',
  borderRadius: 10,
  border: `1px solid ${BORDER}`,
  background: 'transparent',
  color: TEXT,
  fontSize: 13,
  fontWeight: 500,
  fontFamily: 'inherit',
  cursor: 'pointer',
  transition: 'border-color 120ms ease, background 120ms ease',
  selectors: {
    '&:hover:not(:disabled)': { borderColor: ACCENT_FROM, background: RAISED },
    '&:disabled': { opacity: 0.5, cursor: 'not-allowed' },
  },
});

export const spinner = style({
  width: 15,
  height: 15,
  borderRadius: '50%',
  border: '2px solid rgba(255,255,255,0.4)',
  borderTopColor: '#ffffff',
  animation: `${spin} 0.7s linear infinite`,
});

export const errorBanner = style({
  padding: '10px 14px',
  borderRadius: 10,
  border: `1px solid ${DANGER}`,
  background: 'rgba(255,107,129,0.08)',
  color: DANGER,
  fontSize: 13,
  lineHeight: 1.4,
});

// ── result / preview ──────────────────────────────────────────────
export const result = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  flex: 1,
  minHeight: 0,
});

export const stageWrap = style({
  position: 'relative',
  flex: 1,
  minHeight: 240,
  borderRadius: 14,
  overflow: 'hidden',
  border: `1px solid ${BORDER}`,
  // checkerboard-free deep black so letterboxing reads as intentional
  background: '#05060a',
});

export const iframe = style({
  display: 'block',
  width: '100%',
  height: '100%',
  border: 'none',
  background: '#05060a',
});

export const empty = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  height: '100%',
  padding: 24,
  textAlign: 'center',
  color: MUTED,
  fontSize: 14,
});

// ── control bar (play/pause + scrubber + timecode) ────────────────
export const controlBar = style({
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '10px 14px',
  borderRadius: 12,
  border: `1px solid ${BORDER}`,
  background: RAISED,
});

export const transportButton = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 40,
  height: 40,
  flexShrink: 0,
  borderRadius: 10,
  border: 'none',
  cursor: 'pointer',
  color: '#ffffff',
  backgroundImage: `linear-gradient(135deg, ${ACCENT_FROM}, ${ACCENT_TO})`,
  selectors: {
    '&:disabled': { opacity: 0.5, cursor: 'not-allowed' },
  },
});

export const scrubber = style({
  flex: 1,
  height: 4,
  cursor: 'pointer',
  accentColor: ACCENT_FROM,
});

export const timecode = style({
  flexShrink: 0,
  minWidth: 96,
  textAlign: 'right',
  fontSize: 12,
  color: MUTED,
  fontVariantNumeric: 'tabular-nums',
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
});

// ── refine row ────────────────────────────────────────────────────
export const refineRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
});

export const refineInput = style({
  flex: 1,
  height: 40,
  padding: '0 14px',
  boxSizing: 'border-box',
  borderRadius: 10,
  border: `1px solid ${BORDER}`,
  background: RAISED,
  color: TEXT,
  fontSize: 13,
  fontFamily: 'inherit',
  outline: 'none',
  selectors: {
    '&:focus': { borderColor: ACCENT_FROM },
    '&::placeholder': { color: MUTED },
    '&:disabled': { opacity: 0.6, cursor: 'not-allowed' },
  },
});

// ── export (MP4) progress + ready link ────────────────────────────
// A thin row that appears under the action buttons while an MP4 render is in
// flight and once it is done (a green download link).
export const exportRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minHeight: 24,
});

export const progressTrack = style({
  position: 'relative',
  flex: 1,
  height: 6,
  borderRadius: 999,
  overflow: 'hidden',
  background: RAISED,
  border: `1px solid ${BORDER}`,
});

export const progressFill = style({
  position: 'absolute',
  insetBlock: 0,
  left: 0,
  borderRadius: 999,
  backgroundImage: `linear-gradient(135deg, ${ACCENT_FROM}, ${ACCENT_TO})`,
  transition: 'width 240ms ease',
});

export const exportHint = style({
  fontSize: 12,
  color: MUTED,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
});

export const downloadLink = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 36,
  padding: '0 14px',
  borderRadius: 10,
  border: '1px solid #2f8f5b',
  background: 'rgba(47,143,91,0.12)',
  color: '#5be0a0',
  fontSize: 13,
  fontWeight: 600,
  textDecoration: 'none',
  cursor: 'pointer',
  selectors: {
    '&:hover': { background: 'rgba(47,143,91,0.2)' },
  },
});

// Keep the sandboxed preview iframe from ever leaking pointer styles etc.
globalStyle(`${iframe}`, {
  colorScheme: 'dark',
});
