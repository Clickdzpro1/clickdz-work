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

// The studio header is a strict 3-zone bar: LEFT (title + preview pill),
// CENTER (Edit/Generate segmented control, kept visually centred by giving the
// side zones equal flex weight), RIGHT (project name + divider + panel View
// menu). Zones share a 12px inner gap and a fixed 28px control height so
// everything sits on one aligned baseline and never wraps at ≥1100px.
const HEADER_CONTROL_H = 28;

export const header = style({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '8px 16px',
  borderBottom: `1px solid ${border}`,
  background: panel,
  flexShrink: 0,
  flexWrap: 'nowrap',
  minHeight: 48,
  boxSizing: 'border-box',
});

// LEFT zone: title + preview pill. Takes an equal share of the free space so
// the centre zone lands in the true middle; content is left-aligned.
export const headerLeft = style({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flex: 1,
  minWidth: 0,
  justifyContent: 'flex-start',
});

// CENTRE zone: the segmented mode control, never shrinks, stays centred.
export const headerCenter = style({
  display: 'flex',
  alignItems: 'center',
  flexShrink: 0,
  justifyContent: 'center',
});

// RIGHT zone: mirror of the left share, content pushed to the far edge.
export const headerRight = style({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flex: 1,
  minWidth: 0,
  justifyContent: 'flex-end',
});

export const headerTitle = style({
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: 0.2,
  whiteSpace: 'nowrap',
  flexShrink: 0,
});

export const pill = style({
  fontSize: 10,
  fontWeight: 700,
  lineHeight: 1,
  padding: '4px 8px',
  borderRadius: 999,
  color: '#fff',
  background: `linear-gradient(90deg, ${accent}, ${accent2})`,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  whiteSpace: 'nowrap',
  flexShrink: 0,
});

// The project name on the right: reads as an editable field (subtle hover
// affordance) and truncates with an ellipsis rather than pushing the row wider.
export const timelineName = style({
  color: textDim,
  fontSize: 12,
  fontWeight: 500,
  minWidth: 0,
  maxWidth: 240,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  padding: '0 8px',
  height: HEADER_CONTROL_H,
  lineHeight: `${HEADER_CONTROL_H}px`,
  borderRadius: 6,
  border: '1px solid transparent',
  transition: 'background 120ms ease, color 120ms ease, border-color 120ms',
  ':hover': {
    color: text,
    background: bg,
    borderColor: border,
  },
});

// Slim vertical divider separating the project name from the panel View menu.
export const headerDivider = style({
  width: 1,
  height: 18,
  flexShrink: 0,
  background: border,
});

// ---- Mode tabs (Edit / Generate) in the header --------------------------
// One segmented group: a bordered track holding two equal segments.
export const modeTabs = style({
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: 2,
  height: HEADER_CONTROL_H,
  boxSizing: 'border-box',
  borderRadius: 8,
  background: bg,
  border: `1px solid ${border}`,
});

export const modeTab = style({
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: textDim,
  fontSize: 12,
  fontWeight: 600,
  height: '100%',
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 14px',
  borderRadius: 6,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
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

export const main = style({
  position: 'relative',
  display: 'flex',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
});

// Host for the Generate panel: fills the body with a definite height so the
// self-contained panel (height: 100%) can lay out its live-preview stage.
export const generateHost = style({
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  width: '100%',
  height: '100%',
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
  padding: 16,
  boxSizing: 'border-box',
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
  // The transform (including the centering translate(-50%,-50%)) is supplied
  // inline so the clip's animation/transition offsets compose with it.
  whiteSpace: 'pre-wrap',
  fontWeight: 700,
  lineHeight: 1.1,
  textShadow: '0 2px 12px rgba(0,0,0,0.6)',
  willChange: 'transform, opacity',
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

// Right inspector panel. Width owned by its layout slot; fills it.
export const inspector = style({
  width: '100%',
  flex: 1,
  minWidth: 0,
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

// Timeline area — flexible bottom panel; height set inline by the layout hook.
// flexShrink:0 keeps it at exactly that height in the center column; minHeight:0
// + the scrolling lanes wrap below let it collapse to just toolbar + scrubber.
export const timeline = style({
  flexShrink: 0,
  minHeight: 0,
  borderTop: `1px solid ${border}`,
  background: panel,
  padding: '10px 16px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  overflow: 'hidden',
  boxSizing: 'border-box',
});

// The lanes area inside the timeline panel: takes the remaining height and
// scrolls, so shrinking the panel never clips the toolbar/scrubber above it.
export const timelineLanesWrap = style({
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
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

// ---- Toolbar (sits above the lanes) -------------------------------------
export const toolbar = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
});

export const toolButton = style({
  appearance: 'none',
  border: `1px solid ${border}`,
  background: bg,
  color: text,
  fontSize: 12,
  fontWeight: 600,
  padding: '5px 10px',
  borderRadius: 6,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'background 120ms ease, border-color 120ms ease, opacity 120ms',
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

export const toolTimecode = style({
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 12,
  color: textDim,
  minWidth: 120,
});

export const toolDivider = style({
  width: 1,
  alignSelf: 'stretch',
  background: border,
  margin: '2px 2px',
});

export const toolSpacer = style({
  flex: 1,
});

export const toolBadge = style({
  fontSize: 11,
  fontWeight: 600,
  color: '#fff',
  background: accent2,
  borderRadius: 999,
  padding: '2px 8px',
});

export const toolZoomLabel = style({
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 11,
  color: textDim,
  minWidth: 56,
  textAlign: 'center',
});

// ---- Lanes: fixed label column + shared horizontal scroll container -----
export const lanesViewport = style({
  display: 'flex',
  alignItems: 'stretch',
  gap: 10,
  minHeight: 0,
});

export const laneLabelColumn = style({
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
});

// Spacer that vertically aligns the label cells with the lane rows, leaving
// room for the ruler that sits atop the scroll container.
export const laneLabelRulerSpacer = style({
  height: 22,
  flexShrink: 0,
});

export const laneLabelCell = style({
  height: 40,
  marginTop: 6,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  fontSize: 11,
  color: textDim,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  selectors: {
    '&:first-of-type': {
      marginTop: 0,
    },
  },
});

export const lanesScroll = style({
  position: 'relative',
  flex: 1,
  minWidth: 0,
  overflowX: 'auto',
  overflowY: 'hidden',
  overscrollBehaviorX: 'contain',
});

// The scrolling content; width set inline to spanSeconds * pxPerSec.
export const lanesContent = style({
  position: 'relative',
});

// ---- Time ruler ---------------------------------------------------------
export const ruler = style({
  position: 'relative',
  height: 22,
  borderBottom: `1px solid ${border}`,
});

export const rulerTick = style({
  position: 'absolute',
  bottom: 0,
  width: 1,
  height: 5,
  background: border,
});

export const rulerTickMajor = style({
  position: 'absolute',
  bottom: 0,
  width: 1,
  height: 10,
  background: textDim,
});

export const rulerLabel = style({
  position: 'absolute',
  bottom: 11,
  left: 3,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 10,
  color: textDim,
  whiteSpace: 'nowrap',
});

export const laneStack = style({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  paddingTop: 6,
});

// One lane row: full-width strip a clip is positioned within (px-based).
export const laneRow = style({
  position: 'relative',
  height: 40,
  background: bg,
  borderRadius: 6,
  border: `1px solid ${border}`,
  transition: 'border-color 120ms ease, background 120ms ease',
  selectors: {
    // Highlighted while a media/file drag hovers this lane (see TimelineLanes).
    '&[data-drop-target="true"]': {
      borderColor: accent,
      background: 'rgba(91,140,255,0.1)',
    },
  },
});

// A clip block on a lane. left/width set inline (dynamic).
export const clipBlock = style({
  position: 'absolute',
  top: 3,
  bottom: 3,
  borderRadius: 4,
  display: 'flex',
  alignItems: 'center',
  fontSize: 11,
  fontWeight: 600,
  color: '#fff',
  cursor: 'grab',
  overflow: 'hidden',
  border: '1px solid transparent',
  boxSizing: 'border-box',
  touchAction: 'none',
  transition: 'filter 120ms ease, border-color 120ms ease',
  ':hover': {
    filter: 'brightness(1.12)',
  },
});

export const clipBlockSelected = style({
  borderColor: '#fff',
  boxShadow: `0 0 0 1px ${accent}`,
});

export const clipBlockDragging = style({
  opacity: 0.85,
  cursor: 'grabbing',
  filter: 'brightness(1.15)',
  zIndex: 6,
});

export const clipLabel = style({
  flex: 1,
  padding: '0 8px',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  pointerEvents: 'none',
});

// 6px edge hot-zones for trimming. Width kept in sync with TRIM_HANDLE_PX.
export const clipTrimHandleLeft = style({
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: 6,
  cursor: 'ew-resize',
  background: 'rgba(0,0,0,0.25)',
});

export const clipTrimHandleRight = style({
  position: 'absolute',
  right: 0,
  top: 0,
  bottom: 0,
  width: 6,
  cursor: 'ew-resize',
  background: 'rgba(0,0,0,0.25)',
});

// Snap guide line, shown while a drag/trim is snapping. left set inline.
export const snapGuide = style({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 1,
  background: accent2,
  pointerEvents: 'none',
  zIndex: 7,
  boxShadow: `0 0 4px ${accent2}`,
});

// Playhead vertical line spanning the lane stack. left set inline (dynamic).
export const lanePlayhead = style({
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

// ---- Inspector: real per-clip controls ----------------------------------
export const inspStack = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
});

export const inspClipName = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: 13,
  fontWeight: 600,
  color: text,
});

export const inspClipType = style({
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#fff',
  background: raised,
  borderRadius: 999,
  padding: '2px 8px',
});

export const inspSection = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  paddingTop: 12,
  borderTop: `1px solid ${border}`,
});

export const inspSectionTitle = style({
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: textDim,
});

export const inspField = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  flex: 1,
  minWidth: 0,
});

export const inspFieldLabel = style({
  fontSize: 11,
  color: textDim,
  fontVariantNumeric: 'tabular-nums',
});

export const inspRow = style({
  display: 'flex',
  gap: 10,
});

export const inspRange = style({
  width: '100%',
  accentColor: accent,
  cursor: 'pointer',
});

export const inspTextarea = style({
  width: '100%',
  boxSizing: 'border-box',
  resize: 'vertical',
  background: bg,
  color: text,
  border: `1px solid ${border}`,
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 12,
  fontFamily: 'inherit',
  ':focus': {
    outline: 'none',
    borderColor: accent,
  },
});

export const inspSelect = style({
  width: '100%',
  boxSizing: 'border-box',
  appearance: 'none',
  background: bg,
  color: text,
  border: `1px solid ${border}`,
  borderRadius: 6,
  padding: '5px 8px',
  fontSize: 12,
  cursor: 'pointer',
  ':focus': {
    outline: 'none',
    borderColor: accent,
  },
});

export const inspColor = style({
  width: 40,
  height: 26,
  padding: 0,
  background: bg,
  border: `1px solid ${border}`,
  borderRadius: 6,
  cursor: 'pointer',
});

export const inspEmptyHint = style({
  color: textDim,
  fontSize: 12,
});

export const inspEffectRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
});

export const inspEffectName = style({
  fontSize: 11,
  color: text,
  width: 72,
  flexShrink: 0,
  textTransform: 'capitalize',
});

export const inspIconButton = style({
  appearance: 'none',
  flexShrink: 0,
  border: `1px solid ${border}`,
  background: bg,
  color: textDim,
  fontSize: 11,
  lineHeight: 1,
  width: 22,
  height: 22,
  borderRadius: 6,
  cursor: 'pointer',
  ':hover': {
    color: '#ff6b6b',
    borderColor: '#ff6b6b',
  },
});

export const inspRawToggle = style({
  appearance: 'none',
  alignSelf: 'flex-start',
  border: 'none',
  background: 'transparent',
  color: textDim,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  padding: 0,
  ':hover': {
    color: text,
  },
});

// ---- Timeline: transition badges + add-picker ---------------------------
// A zero-width anchor centered on a clip boundary; children are absolutely
// centered on it. Sits above the lane row's clips.
export const boundaryAnchor = style({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 0,
  zIndex: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

// The ⧉ diamond shown when a transition exists on the boundary.
export const transitionBadge = style({
  position: 'absolute',
  appearance: 'none',
  left: 0,
  marginLeft: -9,
  width: 18,
  height: 18,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: `1px solid ${accent2}`,
  background: panel,
  color: accent2,
  borderRadius: 5,
  fontSize: 11,
  lineHeight: 1,
  cursor: 'pointer',
  boxShadow: `0 0 6px ${accent2}`,
  transition: 'background 120ms ease, color 120ms ease',
  ':hover': {
    background: accent2,
    color: '#fff',
  },
});

// The "+" affordance shown on an empty boundary (revealed on lane hover).
export const transitionAdd = style({
  position: 'absolute',
  appearance: 'none',
  left: 0,
  marginLeft: -8,
  width: 16,
  height: 16,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: `1px dashed ${textDim}`,
  background: bg,
  color: textDim,
  borderRadius: '50%',
  fontSize: 12,
  lineHeight: 1,
  cursor: 'pointer',
  opacity: 0,
  transition: 'opacity 120ms ease, color 120ms ease, border-color 120ms ease',
  selectors: {
    [`${laneRow}:hover &`]: {
      opacity: 1,
    },
    '&:hover': {
      color: text,
      borderColor: accent,
      opacity: 1,
    },
  },
});

// The tiny kind/duration popover opened from the "+" affordance.
export const transitionPicker = style({
  position: 'absolute',
  top: '100%',
  left: 0,
  marginTop: 6,
  transform: 'translateX(-50%)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 6,
  background: panel,
  border: `1px solid ${border}`,
  borderRadius: 8,
  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  zIndex: 9,
});

export const transitionPickerGroup = style({
  display: 'flex',
  alignItems: 'center',
  gap: 4,
});

export const transitionPickerKind = style({
  fontSize: 11,
  fontWeight: 600,
  color: textDim,
  textTransform: 'capitalize',
  width: 40,
  flexShrink: 0,
});

export const transitionPickerButton = style({
  appearance: 'none',
  border: `1px solid ${border}`,
  background: bg,
  color: text,
  fontSize: 11,
  fontWeight: 600,
  padding: '3px 7px',
  borderRadius: 5,
  cursor: 'pointer',
  transition: 'background 120ms ease, border-color 120ms ease',
  ':hover': {
    background: raised,
    borderColor: accent,
  },
});

// =========================================================================
// Workspace layout: flexible/hideable panels, resize seams, reopen tabs, View
// menu. Panels are sized by inline width/height on their slot wrappers; the
// child components fill the slot (their own root is width/height: 100%).
// =========================================================================

// A sizing slot for a side panel: owns the width, never shrinks.
export const sidePanelSlot = style({
  position: 'relative',
  flexShrink: 0,
  display: 'flex',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
});

// The center column (preview + timeline): the flex remainder.
export const center = style({
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
});

// The right-hand stack that holds inspector + AI dock, each its own slot.
export const rightStack = style({
  display: 'flex',
  flexShrink: 0,
  minHeight: 0,
  height: '100%',
});

// ---- Slim reusable panel chrome (<VdzPanel>) ----------------------------
export const vdzPanel = style({
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  minHeight: 0,
  background: panel,
  color: text,
  overflow: 'hidden',
});

export const panelHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px 8px 14px',
  borderBottom: `1px solid ${border}`,
  flexShrink: 0,
  minHeight: 36,
  boxSizing: 'border-box',
});

export const panelTitle = style({
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: textDim,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

export const panelHeaderSpacer = style({
  flex: 1,
});

export const panelCollapse = style({
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

export const panelBody = style({
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
});

// ---- Resize seams -------------------------------------------------------
const HANDLE = 6;

// Shared base: a thin hit-target with a hairline that lights up on hover/drag.
const resizeHandleBase = style({
  position: 'relative',
  flexShrink: 0,
  zIndex: 10,
  background: 'transparent',
  selectors: {
    '&::after': {
      content: '""',
      position: 'absolute',
      background: border,
      transition: 'background 120ms ease',
    },
    '&:hover::after, &[data-dragging="true"]::after': {
      background: accent,
    },
    '&[data-dragging="true"]': {
      background: 'rgba(91,140,255,0.12)',
    },
  },
});

// Vertical seam between two side-by-side panels (drag horizontally).
export const resizeHandleX = style([
  resizeHandleBase,
  {
    width: HANDLE,
    height: '100%',
    cursor: 'col-resize',
    touchAction: 'none',
    selectors: {
      '&::after': {
        top: 0,
        bottom: 0,
        left: '50%',
        width: 1,
        transform: 'translateX(-0.5px)',
      },
      '&:hover::after, &[data-dragging="true"]::after': {
        width: 2,
      },
    },
  },
]);

// Horizontal seam between stacked panels — preview above / timeline below
// (drag vertically).
export const resizeHandleY = style([
  resizeHandleBase,
  {
    height: HANDLE,
    width: '100%',
    cursor: 'row-resize',
    touchAction: 'none',
    selectors: {
      '&::after': {
        left: 0,
        right: 0,
        top: '50%',
        height: 1,
        transform: 'translateY(-0.5px)',
      },
      '&:hover::after, &[data-dragging="true"]::after': {
        height: 2,
      },
    },
  },
]);

// ---- Reopen tab (hidden panel leaves a slim tab at its edge) -------------
export const reopenTab = style({
  appearance: 'none',
  position: 'absolute',
  zIndex: 11,
  border: `1px solid ${border}`,
  color: textDim,
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  cursor: 'pointer',
  padding: '8px 3px',
  background: panel,
  transition: 'background 120ms ease, color 120ms ease, border-color 120ms',
  ':hover': {
    color: text,
    background: raised,
    borderColor: accent,
  },
  selectors: {
    // Left/right edge tabs read vertically.
    '&[data-edge="left"], &[data-edge="right"]': {
      top: 12,
      writingMode: 'vertical-rl',
    },
    '&[data-edge="left"]': {
      left: 0,
      borderLeft: 'none',
      borderTopRightRadius: 6,
      borderBottomRightRadius: 6,
    },
    '&[data-edge="right"]': {
      right: 0,
      borderRight: 'none',
      borderTopLeftRadius: 6,
      borderBottomLeftRadius: 6,
      transform: 'rotate(180deg)',
    },
    '&[data-edge="bottom"]': {
      right: 16,
      bottom: 8,
      padding: '4px 10px',
      borderRadius: 6,
      writingMode: 'horizontal-tb',
    },
  },
});

// ---- View menu (header dropdown) ----------------------------------------
export const viewMenuRoot = style({
  position: 'relative',
  display: 'inline-flex',
});

export const viewMenuTrigger = style({
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 28,
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
    '&[data-open="true"]': {
      color: text,
      background: raised,
      borderColor: accent,
    },
  },
});

export const viewMenuGlyph = style({
  fontSize: 12,
  lineHeight: 1,
});

export const viewMenuBadge = style({
  fontSize: 10,
  fontWeight: 700,
  color: textDim,
  background: bg,
  border: `1px solid ${border}`,
  borderRadius: 999,
  padding: '1px 6px',
  fontVariantNumeric: 'tabular-nums',
});

export const viewMenu = style({
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: 0,
  minWidth: 220,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: 6,
  background: panel,
  border: `1px solid ${border}`,
  borderRadius: 10,
  boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
  zIndex: 40,
});

export const viewMenuItem = style({
  appearance: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  border: 'none',
  background: 'transparent',
  color: text,
  fontSize: 13,
  fontWeight: 500,
  padding: '6px 8px',
  borderRadius: 6,
  cursor: 'pointer',
  textAlign: 'left',
  transition: 'background 120ms ease',
  ':hover': {
    background: raised,
  },
  selectors: {
    '&:disabled': {
      opacity: 0.4,
      cursor: 'default',
      background: 'transparent',
    },
  },
});

export const viewMenuCheck = style({
  width: 14,
  flexShrink: 0,
  color: accent,
  fontSize: 12,
  fontWeight: 700,
  textAlign: 'center',
});

export const viewMenuLabel = style({
  flex: 1,
});

export const viewMenuHint = style({
  fontSize: 10,
  color: textDim,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
});

export const viewMenuSep = style({
  height: 1,
  background: border,
  margin: '4px 2px',
});
