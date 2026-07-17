import { useEffect, useRef, useState } from 'react';

import type { VdzOp, VdzTimeline } from '../../../../modules/vdz';
import { VDZ_RATIO_PRESETS } from '../../../../modules/vdz/presets';
import { formatTimecode } from './constants';
import * as styles from './index.css';

interface ToolbarProps {
  /** Whether the media bin panel is open (drives the toggle button state). */
  showMedia: boolean;
  /** Toggle the left-side media bin panel. */
  onToggleMedia: () => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  /** Master mute for preview audio (drives the speaker toggle state). */
  audioMuted?: boolean;
  /** Toggle master preview-audio mute. */
  onToggleAudioMute?: () => void;
  playheadSeconds: number;
  duration: number;
  pxPerSec: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  canSplit: boolean;
  onSplit: () => void;
  canDelete: boolean;
  onDelete: () => void;
  onRippleDelete: () => void;
  /** Add a text clip at the playhead (relocated here from the footer). */
  onAddText?: () => void;
  canUndo: boolean;
  onUndo: () => void;
  canRedo: boolean;
  onRedo: () => void;
  selectionCount: number;
  /** The working timeline — the Ratio picker derives the current canvas
   * aspect from `timeline.width` / `timeline.height`. */
  timeline?: VdzTimeline;
  /** Single-op commit path (the SAME one the lanes/inspector use via `run`).
   * The Ratio picker emits `{ op:'setCanvas', width, height }` through it. */
  onCommitOp?: (op: VdzOp) => void;
  /** Hide the timeline panel (collapse × at the end of the toolbar). */
  onCollapse?: () => void;
  // ---- MP4 export (compile timeline → cdz-render kind:'html') -------------
  /** Kick off an MP4 export of the current timeline. */
  onExport?: () => void;
  /** True while compiling/inlining or while the render is in flight. */
  exportBusy?: boolean;
  /** 0..1 render progress (meaningful while rendering). */
  exportProgress?: number;
  /** A ready-to-download MP4 URL once the render is done, else null. */
  exportFileUrl?: string | null;
  /** True when the render service is not configured on this deployment. */
  exportUnavailable?: boolean;
  /** A short human status/error line for the export, or null. */
  exportNote?: string | null;
}

/** How close (fractional aspect delta) a preset must be to be the "current"
 * match; wider than this and the button reads "Custom". ~2% tolerance. */
const RATIO_MATCH_TOLERANCE = 0.02;

/**
 * The compact aspect-ratio picker: a toolbar button showing the current ratio
 * (the closest {@link VDZ_RATIO_PRESETS} match to the timeline's width/height,
 * or "Custom" when nothing is within ~2%) that opens a small popover of the
 * presets. Selecting one commits `{ op:'setCanvas', width, height }` through the
 * toolbar's shared op-commit path — the exact mechanism Split/Delete/etc. use.
 */
function RatioPicker({
  timeline,
  onCommitOp,
}: {
  timeline?: VdzTimeline;
  onCommitOp: (op: VdzOp) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const width = timeline?.width ?? 0;
  const height = timeline?.height ?? 0;
  const aspect = width > 0 && height > 0 ? width / height : 0;

  // Closest preset by fractional aspect delta; "Custom" when the nearest is
  // still outside the tolerance band (or the timeline has no usable size yet).
  let match: (typeof VDZ_RATIO_PRESETS)[number] | null = null;
  if (aspect > 0) {
    let best = Infinity;
    for (const preset of VDZ_RATIO_PRESETS) {
      const presetAspect = preset.width / preset.height;
      const delta = Math.abs(presetAspect - aspect) / presetAspect;
      if (delta < best) {
        best = delta;
        match = preset;
      }
    }
    if (best > RATIO_MATCH_TOLERANCE) match = null;
  }
  const currentLabel = match ? match.label : 'Custom';

  // Close on an outside click or Escape while the popover is open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const select = (preset: (typeof VDZ_RATIO_PRESETS)[number]) => {
    onCommitOp({ op: 'setCanvas', width: preset.width, height: preset.height });
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className={styles.toolButton}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Canvas aspect ratio"
      >
        ▭ {currentLabel}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Canvas aspect ratio"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 40,
            minWidth: 176,
            padding: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            background: '#1b1d22',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
          }}
        >
          {VDZ_RATIO_PRESETS.map(preset => {
            const active = match?.id === preset.id;
            // A tiny visual aspect box, longest side fixed at 22px.
            const boxLong = 22;
            const wide = preset.width >= preset.height;
            const boxW = wide
              ? boxLong
              : Math.max(4, Math.round((preset.width / preset.height) * boxLong));
            const boxH = wide
              ? Math.max(4, Math.round((preset.height / preset.width) * boxLong))
              : boxLong;
            return (
              <button
                key={preset.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => select(preset)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '6px 8px',
                  border: '1px solid transparent',
                  borderRadius: 6,
                  background: active ? 'rgba(91,140,255,0.18)' : 'transparent',
                  color: active ? '#dfe7ff' : '#e7e9ee',
                  font: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onMouseEnter={e => {
                  if (!active) {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                  }
                }}
                onMouseLeave={e => {
                  if (!active) e.currentTarget.style.background = 'transparent';
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    flex: '0 0 auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: boxLong,
                    height: boxLong,
                  }}
                >
                  <span
                    style={{
                      width: boxW,
                      height: boxH,
                      borderRadius: 2,
                      border: '1px solid rgba(255,255,255,0.55)',
                      background: 'rgba(255,255,255,0.10)',
                    }}
                  />
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    lineHeight: 1.25,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>
                    {preset.id} · {preset.label}
                  </span>
                  <span style={{ color: '#9aa0ab', fontSize: 11 }}>
                    {preset.width}×{preset.height}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Editor action bar. Sits ABOVE the lanes (never in the AI-dock footer). */
export function Toolbar({
  showMedia,
  onToggleMedia,
  isPlaying,
  onTogglePlay,
  audioMuted,
  onToggleAudioMute,
  playheadSeconds,
  duration,
  pxPerSec,
  onZoomOut,
  onZoomIn,
  canSplit,
  onSplit,
  canDelete,
  onDelete,
  onRippleDelete,
  onAddText,
  canUndo,
  onUndo,
  canRedo,
  onRedo,
  selectionCount,
  timeline,
  onCommitOp,
  onCollapse,
  onExport,
  exportBusy,
  exportProgress,
  exportFileUrl,
  exportUnavailable,
  exportNote,
}: ToolbarProps) {
  const exportPct = Math.round((exportProgress ?? 0) * 100);
  return (
    <div className={styles.toolbar}>
      <button
        type="button"
        className={styles.toolButton}
        onClick={onToggleMedia}
        aria-pressed={showMedia}
        title="Toggle the media bin (upload / AI images / stock)"
      >
        {showMedia ? '◧ Media' : '▤ Media'}
      </button>

      <span className={styles.toolDivider} />

      <button
        type="button"
        className={styles.toolButton}
        onClick={onTogglePlay}
        title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
      >
        {isPlaying ? '⏸ Pause' : '▶ Play'}
      </button>

      {onToggleAudioMute ? (
        <button
          type="button"
          className={styles.toolButton}
          onClick={onToggleAudioMute}
          aria-pressed={audioMuted}
          title={audioMuted ? 'Unmute preview audio' : 'Mute preview audio'}
        >
          {audioMuted ? '🔇 Muted' : '🔊 Audio'}
        </button>
      ) : null}

      <span className={styles.toolTimecode}>
        {formatTimecode(playheadSeconds)} / {formatTimecode(duration)}
      </span>

      <span className={styles.toolDivider} />

      <button
        type="button"
        className={styles.toolButton}
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo (Ctrl/Cmd+Z)"
      >
        ↺ Undo
      </button>
      <button
        type="button"
        className={styles.toolButton}
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo (Ctrl/Cmd+Shift+Z)"
      >
        ↻ Redo
      </button>

      <span className={styles.toolDivider} />

      {onAddText ? (
        <button
          type="button"
          className={styles.toolButton}
          onClick={onAddText}
          title="Add a text clip at the playhead"
        >
          ＋ Text
        </button>
      ) : null}
      <button
        type="button"
        className={styles.toolButton}
        onClick={onSplit}
        disabled={!canSplit}
        title="Split selected clip at playhead (S)"
      >
        ⋔ Split
      </button>
      <button
        type="button"
        className={styles.toolButton}
        onClick={onDelete}
        disabled={!canDelete}
        title="Delete selected (Delete)"
      >
        🗑 Delete
      </button>
      <button
        type="button"
        className={styles.toolButton}
        onClick={onRippleDelete}
        disabled={!canDelete}
        title="Ripple delete — close the gap (Shift+Delete)"
      >
        ⇤ Ripple
      </button>

      <span className={styles.toolSpacer} />

      {selectionCount > 1 ? (
        <span className={styles.toolBadge}>{selectionCount} selected</span>
      ) : null}

      <span className={styles.toolDivider} />

      <button
        type="button"
        className={styles.toolButton}
        onClick={onZoomOut}
        title="Zoom out"
      >
        −
      </button>
      <span className={styles.toolZoomLabel}>{Math.round(pxPerSec)} px/s</span>
      <button
        type="button"
        className={styles.toolButton}
        onClick={onZoomIn}
        title="Zoom in"
      >
        +
      </button>

      {onCommitOp ? (
        <>
          <span className={styles.toolDivider} />
          <RatioPicker timeline={timeline} onCommitOp={onCommitOp} />
        </>
      ) : null}

      {onExport ? (
        <>
          <span className={styles.toolDivider} />
          {exportFileUrl ? (
            <a
              className={styles.toolButton}
              href={exportFileUrl}
              download
              title="Download the rendered MP4"
            >
              ⬇ MP4
            </a>
          ) : (
            <button
              type="button"
              className={styles.toolButton}
              onClick={onExport}
              disabled={exportBusy || exportUnavailable}
              title={
                exportUnavailable
                  ? 'Render service coming online soon'
                  : 'Compile this timeline and render it to an MP4'
              }
            >
              {exportBusy ? `⤓ Exporting ${exportPct}%` : '⬇ Export MP4'}
            </button>
          )}
          {exportNote ? (
            <span
              className={styles.toolZoomLabel}
              title={exportNote}
              style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {exportNote}
            </span>
          ) : null}
        </>
      ) : null}

      {onCollapse ? (
        <>
          <span className={styles.toolDivider} />
          <button
            type="button"
            className={styles.toolButton}
            onClick={onCollapse}
            title="Hide the timeline (Cmd/Ctrl+4)"
            aria-label="Hide timeline"
          >
            ×
          </button>
        </>
      ) : null}
    </div>
  );
}
