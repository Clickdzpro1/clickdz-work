import { useEffect, useRef, useState } from 'react';

import type { VdzOp, VdzTimeline } from '../../../../modules/vdz';
import { VDZ_RATIO_PRESETS } from '../../../../modules/vdz/presets';
import * as chrome from './chrome-studio.css';
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

/** setCanvas op range (mirrors ops.ts's integer 320..4096 clamp — we validate
 * the Custom inputs against the same bounds so an out-of-range value is caught
 * before it ever reaches the frozen op layer). */
const CANVAS_MIN = 320;
const CANVAS_MAX = 4096;

/**
 * The compact aspect-ratio picker: a toolbar button showing the current ratio
 * (the closest {@link VDZ_RATIO_PRESETS} match to the timeline's width/height,
 * or "Custom" when nothing is within ~2%) that opens a small popover of the
 * presets. A checkmark marks the applied ratio, and a "Custom…" entry reveals
 * inline W×H inputs. Both presets AND the custom size commit `{ op:'setCanvas',
 * width, height }` through the toolbar's shared op-commit path — the exact
 * mechanism Split/Delete/etc. use.
 */
function RatioPicker({
  timeline,
  onCommitOp,
}: {
  timeline?: VdzTimeline;
  onCommitOp: (op: VdzOp) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
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
  const isCustom = aspect > 0 && !match;
  const currentLabel = match ? match.label : 'Custom';

  // Custom W×H draft (seeded from the live canvas so opening it shows the
  // current size, ready to tweak).
  const [draftW, setDraftW] = useState('');
  const [draftH, setDraftH] = useState('');

  // Reset drafts to the live size whenever the custom editor is opened.
  const openCustom = () => {
    setDraftW(width > 0 ? String(width) : '');
    setDraftH(height > 0 ? String(height) : '');
    setCustomOpen(true);
  };

  // Close (and reset the custom editor) on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setCustomOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setCustomOpen(false);
      }
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
    setCustomOpen(false);
  };

  // Parse + validate the custom drafts to integers inside [320, 4096].
  const parsed = (raw: string): number | null => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < CANVAS_MIN || n > CANVAS_MAX) return null;
    return n;
  };
  const customW = parsed(draftW);
  const customH = parsed(draftH);
  const customValid = customW !== null && customH !== null;

  const commitCustom = () => {
    if (customW === null || customH === null) return;
    // SAME op path the presets use — ops.ts revalidates the 320..4096 range.
    onCommitOp({ op: 'setCanvas', width: customW, height: customH });
    setOpen(false);
    setCustomOpen(false);
  };

  const onCustomKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitCustom();
    }
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
            minWidth: 200,
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
                  gap: 8,
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
                <span className={chrome.ratioCheck} aria-hidden="true">
                  {active ? '✓' : ''}
                </span>
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

          <div className={chrome.ratioSep} />

          {/* ---- Custom… : inline W×H editor committing through setCanvas ---- */}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={isCustom}
            aria-expanded={customOpen}
            onClick={() => (customOpen ? setCustomOpen(false) : openCustom())}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '6px 8px',
              border: '1px solid transparent',
              borderRadius: 6,
              background:
                isCustom && !customOpen
                  ? 'rgba(91,140,255,0.18)'
                  : 'transparent',
              color: isCustom ? '#dfe7ff' : '#e7e9ee',
              font: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onMouseEnter={e => {
              if (!(isCustom && !customOpen)) {
                e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
              }
            }}
            onMouseLeave={e => {
              if (!(isCustom && !customOpen)) {
                e.currentTarget.style.background = 'transparent';
              }
            }}
          >
            <span className={chrome.ratioCheck} aria-hidden="true">
              {isCustom ? '✓' : ''}
            </span>
            <span
              aria-hidden="true"
              style={{
                flex: '0 0 auto',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 22,
                height: 22,
                color: '#9aa0ab',
                fontSize: 14,
              }}
            >
              ⤢
            </span>
            <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>
              Custom…
            </span>
          </button>

          {customOpen ? (
            <div className={chrome.customForm}>
              <div className={chrome.customRow}>
                <label className={chrome.customField}>
                  <span className={chrome.customLabel}>W</span>
                  <input
                    className={chrome.customInput}
                    type="number"
                    inputMode="numeric"
                    min={CANVAS_MIN}
                    max={CANVAS_MAX}
                    step={1}
                    value={draftW}
                    onChange={e => setDraftW(e.target.value)}
                    onKeyDown={onCustomKeyDown}
                    aria-label="Custom canvas width in pixels"
                    autoFocus
                  />
                </label>
                <span className={chrome.customTimes} aria-hidden="true">
                  ×
                </span>
                <label className={chrome.customField}>
                  <span className={chrome.customLabel}>H</span>
                  <input
                    className={chrome.customInput}
                    type="number"
                    inputMode="numeric"
                    min={CANVAS_MIN}
                    max={CANVAS_MAX}
                    step={1}
                    value={draftH}
                    onChange={e => setDraftH(e.target.value)}
                    onKeyDown={onCustomKeyDown}
                    aria-label="Custom canvas height in pixels"
                  />
                </label>
              </div>
              <div className={chrome.customRow}>
                <span className={chrome.customHint}>
                  {CANVAS_MIN}–{CANVAS_MAX} px each side
                </span>
                <button
                  type="button"
                  className={chrome.customApply}
                  style={{ marginLeft: 'auto' }}
                  disabled={!customValid}
                  onClick={commitCustom}
                  title="Apply custom canvas size"
                >
                  Apply
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Editor action bar. Sits ABOVE the lanes (never in the AI-dock footer).
 *
 * Controls are organised into four logically-grouped clusters, separated by
 * subtle hairline dividers: playback (media · play · audio · timecode) |
 * edit & insert (undo · redo · text · split · delete · ripple) | canvas &
 * zoom (zoom out/in · aspect ratio) | view & export (export · collapse). Each
 * button carries a tooltip naming its keyboard shortcut where one exists. */
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
      {/* ---- Group: playback ------------------------------------------- */}
      <span className={chrome.toolGroup}>
        <button
          type="button"
          className={styles.toolButton}
          onClick={onToggleMedia}
          aria-pressed={showMedia}
          title="Toggle the media bin — upload / AI images / stock (Cmd/Ctrl+1)"
        >
          {showMedia ? '◧ Media' : '▤ Media'}
        </button>

        <button
          type="button"
          className={styles.toolButton}
          onClick={onTogglePlay}
          aria-pressed={isPlaying}
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

        <span
          className={styles.toolTimecode}
          title="Playhead / total duration"
        >
          {formatTimecode(playheadSeconds)} / {formatTimecode(duration)}
        </span>
      </span>

      <span className={styles.toolDivider} />

      {/* ---- Group: edit & insert -------------------------------------- */}
      <span className={chrome.toolGroup}>
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
          title="Split the selected clip at the playhead (S)"
        >
          ⋔ Split
        </button>
        <button
          type="button"
          className={styles.toolButton}
          onClick={onDelete}
          disabled={!canDelete}
          title="Delete the selection (Delete)"
        >
          🗑 Delete
        </button>
        <button
          type="button"
          className={styles.toolButton}
          onClick={onRippleDelete}
          disabled={!canDelete}
          title="Ripple delete — remove and close the gap (Shift+Delete)"
        >
          ⇤ Ripple
        </button>
      </span>

      <span className={styles.toolSpacer} />

      {selectionCount > 1 ? (
        <span className={styles.toolBadge} title={`${selectionCount} clips selected`}>
          {selectionCount} selected
        </span>
      ) : null}

      <span className={styles.toolDivider} />

      {/* ---- Group: canvas & zoom -------------------------------------- */}
      <span className={chrome.toolGroup}>
        <button
          type="button"
          className={styles.toolButton}
          onClick={onZoomOut}
          title="Zoom the timeline out"
          aria-label="Zoom out"
        >
          −
        </button>
        <span className={styles.toolZoomLabel} title="Timeline zoom (pixels per second)">
          {Math.round(pxPerSec)} px/s
        </span>
        <button
          type="button"
          className={styles.toolButton}
          onClick={onZoomIn}
          title="Zoom the timeline in"
          aria-label="Zoom in"
        >
          +
        </button>

        {onCommitOp ? (
          <RatioPicker timeline={timeline} onCommitOp={onCommitOp} />
        ) : null}
      </span>

      {onExport || onCollapse ? (
        <>
          <span className={styles.toolDivider} />
          {/* ---- Group: view & export ------------------------------------ */}
          <span className={chrome.toolGroup}>
            {onExport ? (
              exportFileUrl ? (
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
              )
            ) : null}
            {onExport && exportNote ? (
              <span
                className={styles.toolZoomLabel}
                title={exportNote}
                style={{
                  maxWidth: 220,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {exportNote}
              </span>
            ) : null}

            {onCollapse ? (
              <button
                type="button"
                className={styles.toolButton}
                onClick={onCollapse}
                title="Hide the timeline (Cmd/Ctrl+4)"
                aria-label="Hide timeline"
              >
                ×
              </button>
            ) : null}
          </span>
        </>
      ) : null}
    </div>
  );
}
