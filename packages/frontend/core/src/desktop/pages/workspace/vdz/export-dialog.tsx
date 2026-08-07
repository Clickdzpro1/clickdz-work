import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { VdzTimeline } from '../../../../modules/vdz';
import {
  DEFAULT_RENDER_CAPABILITIES,
  type VdzRenderCapabilities,
} from '../../../../modules/vdz/use-vdz-export';
import {
  computeExportDurationSec,
  persistExportEngine,
  resolveDefaultExportEngine,
  resolveExportFps,
  type VdzExportEngine,
} from '../../../../modules/vdz/use-vdz-timeline-export';
import * as styles from './export-dialog.css';

/**
 * Vdz Studio — export dialog (C7).
 *
 * Opens when the user triggers Export (the toolbar button now opens this instead
 * of starting a render immediately). It lets the user pick the render ENGINE and
 * shows a read-only summary of what will be produced, then Confirm starts the
 * render through the SAME hook path as before (progress/polling UX unchanged).
 *
 * ENGINE CHOICE:
 *   · Classic  — the fast offline HTML tier. HONEST caveat: video clips render as
 *     a still poster (first frame), and there's no audio.
 *   · Remotion (beta) — the true per-frame video + audio render worker.
 * The default follows the C7 rule (persisted `cdz:vdz-export-engine`, else the
 * legacy `cdz:remotion-opt-in` flag, else Classic); Confirm PERSISTS the choice.
 *
 * SUMMARY (read-only): resolution = the timeline canvas W×H; duration = the
 * canonical C1 length as mm:ss; fps = the timeline fps. When Classic is selected
 * and the timeline exceeds the classic cap (300s), an inline warning recommends
 * switching to Remotion (the classic render tier rejects longer compositions).
 *
 * Portaled to document.body so its fixed backdrop escapes the studio header's
 * containing block (mirrors template-gallery.tsx); the backdrop carries the
 * `vdzTheme` marker via its stylesheet so the `--vdz-*` tokens resolve.
 */

/**
 * Fallback classic cap (seconds) used only when the probed capabilities have not
 * arrived yet. The live value comes from `capabilities.classicMaxSec` (the
 * backend's CLASSIC_MAX_SEC), so this default just seeds the very first render
 * before the probe resolves.
 */
const CLASSIC_MAX_SECONDS = DEFAULT_RENDER_CAPABILITIES.classicMaxSec;

interface ExportDialogProps {
  open: boolean;
  /** The working timeline — the dialog derives duration / resolution / fps. */
  timeline: VdzTimeline;
  /**
   * What render engines this deployment can offer right now (probed by the
   * export hook). The dialog gates the Remotion option on `remotion` and shows
   * `classicMaxSec` as the Classic tier's duration cap. Optional so an older
   * caller that doesn't pass it degrades to the conservative default.
   */
  capabilities?: VdzRenderCapabilities;
  /** Close without exporting (Cancel / Escape / backdrop click). */
  onCancel: () => void;
  /** Confirm with the chosen engine — starts the render. */
  onConfirm: (engine: VdzExportEngine) => void;
}

/** Format a seconds value as `mm:ss` (rounded up so a tail second isn't hidden). */
function formatMmSs(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** Engine option metadata, rendered as the two choice cards. */
const ENGINE_OPTIONS: {
  id: VdzExportEngine;
  name: string;
  beta?: boolean;
  desc: string;
}[] = [
  {
    id: 'classic',
    name: 'Classic',
    desc: 'Fast. Video clips render as a still poster (first frame) and there is no audio — best for text, images, shapes and motion graphics.',
  },
  {
    id: 'remotion',
    name: 'Remotion',
    beta: true,
    desc: 'True video + audio render — plays your video clips frame-by-frame and mixes audio. Slower, and needs the render worker to be online.',
  },
];

export function VdzExportDialog({
  open,
  timeline,
  capabilities = DEFAULT_RENDER_CAPABILITIES,
  onCancel,
  onConfirm,
}: ExportDialogProps) {
  const remotionAvailable = capabilities.remotion;
  const classicMaxSeconds =
    capabilities.classicMaxSec > 0
      ? capabilities.classicMaxSec
      : CLASSIC_MAX_SECONDS;

  // Selected engine — seeded from the C7 default each time the dialog opens.
  const [engine, setEngine] = useState<VdzExportEngine>(
    resolveDefaultExportEngine
  );

  // Re-seed the choice from the persisted/default rule whenever the dialog
  // (re)opens, so a fresh open always reflects the saved preference. When
  // Remotion is unavailable on this deployment, never LAND on it — fall back to
  // Classic so the user can't confirm a dead choice.
  useEffect(() => {
    if (!open) return;
    const preferred = resolveDefaultExportEngine();
    setEngine(preferred === 'remotion' && !remotionAvailable ? 'classic' : preferred);
  }, [open, remotionAvailable]);

  // Escape closes (the backdrop click does too).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  const durationSec = useMemo(
    () => computeExportDurationSec(timeline),
    [timeline]
  );
  const fps = useMemo(() => resolveExportFps(timeline), [timeline]);
  const width = timeline.width || 1920;
  const height = timeline.height || 1080;

  // The classic tier will reject a composition longer than its cap; warn (and
  // recommend Remotion when it's available) BEFORE the user spends time
  // compiling + uploading. Uses the LIVE probed cap.
  const classicTooLong =
    engine === 'classic' && durationSec > classicMaxSeconds;

  const confirm = useCallback(() => {
    persistExportEngine(engine);
    onConfirm(engine);
  }, [engine, onConfirm]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label="Export video"
      >
        <div className={styles.headRow}>
          <div>
            <div className={styles.title}>Export video</div>
            <div className={styles.subtitle}>
              Choose a render engine, then confirm. Your export covers the whole
              timeline.
            </div>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onCancel}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Engine choice */}
        <div>
          <div className={styles.sectionLabel} style={{ marginBottom: 8 }}>
            Engine
          </div>
          <div
            className={styles.engineRow}
            role="radiogroup"
            aria-label="Render engine"
          >
            {ENGINE_OPTIONS.map(opt => {
              // Gate Remotion on the probed capability: when the render worker
              // isn't wired up on this deployment the option is disabled (and
              // can't be selected) with an inline explanation, so the user is
              // never offered a dead choice.
              const disabled = opt.id === 'remotion' && !remotionAvailable;
              const selected = engine === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={disabled}
                  data-selected={selected}
                  data-disabled={disabled}
                  disabled={disabled}
                  className={styles.engineCard}
                  onClick={() => {
                    if (!disabled) setEngine(opt.id);
                  }}
                >
                  <div className={styles.engineHead}>
                    <span className={styles.engineName}>{opt.name}</span>
                    {opt.beta ? (
                      <span className={styles.betaBadge}>beta</span>
                    ) : null}
                    <span className={styles.radioDot} aria-hidden="true">
                      {selected ? (
                        <span className={styles.radioDotInner} />
                      ) : null}
                    </span>
                  </div>
                  <span className={styles.engineDesc}>
                    {disabled
                      ? 'True video + audio render — not available on this workspace yet. Use Classic for now.'
                      : opt.desc}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Read-only summary: resolution / duration / fps */}
        <div>
          <div className={styles.sectionLabel} style={{ marginBottom: 8 }}>
            Output
          </div>
          <div className={styles.summary}>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Resolution</span>
              <span className={styles.summaryValue}>
                {width}×{height}
              </span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Duration</span>
              <span className={styles.summaryValue}>
                {formatMmSs(durationSec)}
              </span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>FPS</span>
              <span className={styles.summaryValue}>{fps}</span>
            </div>
          </div>
        </div>

        {/* Classic engine duration cap, shown pre-flight so the limit isn't a
            surprise 400 after enqueue. */}
        {engine === 'classic' && !classicTooLong ? (
          <div className={styles.summaryHint}>
            Classic exports up to {formatMmSs(classicMaxSeconds)}.
          </div>
        ) : null}

        {/* Inline warning: classic engine + over the classic length cap */}
        {classicTooLong ? (
          <div className={styles.warning} role="alert">
            <span className={styles.warningIcon} aria-hidden="true">
              ⚠
            </span>
            <span>
              This timeline is {formatMmSs(durationSec)} — longer than the{' '}
              {formatMmSs(classicMaxSeconds)} limit for the Classic engine.
              {remotionAvailable ? (
                <>
                  {' '}
                  Switch to <strong>Remotion (beta)</strong> to export the full
                  length.
                </>
              ) : (
                <>
                  {' '}
                  Trim the timeline to under {formatMmSs(classicMaxSeconds)} to
                  export.
                </>
              )}
            </span>
          </div>
        ) : null}

        <div className={styles.actions}>
          <button type="button" className={styles.btn} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={confirm}
          >
            Export
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
