import { nanoid } from 'nanoid';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  computeTimelineDuration,
  type VdzClip,
  type VdzOp,
  type VdzTimeline,
} from '../../../../modules/vdz';
import * as styles from './index.css';

/**
 * Vdz Studio — quick-actions popover (QUILL / WS11).
 *
 * A small toolbar popover with two op-composed conveniences, both built ONLY
 * from existing frozen ops (ops.ts untouched):
 *
 *  · CANVAS BACKGROUND — the schema has no background-color field (setCanvas is
 *    width/height only), but the app's own convention IS a full-bleed rect
 *    shape on the bottom lane (see sample.ts "Intro backdrop": x0 y0 w1 h1).
 *    Setting a color therefore (a) recolors every existing full-bleed rect on
 *    the bottom visual track via `updateClip {color}` and (b) fills that
 *    track's uncovered time gaps with new full-bleed rects via `addClip` (plus
 *    `addTrack` when the timeline has no visual track at all). Paint order is
 *    track order then clip order and `addClip` APPENDS, so gap-filling —
 *    never overlapping an existing clip on that lane — can never occlude
 *    anything. One `runBatch` = one history entry = one-step undo.
 *
 *  · ALIGN SELECTED CLIP — 3×3 position grid + Center H / Center V chips for
 *    the selected text/shape clip via `updateClip {x,y}`. Text clips anchor at
 *    their CENTER (the preview translates -50%,-50%), so text targets are
 *    anchor fractions (verticals match anim.ts captionAnchorY: 0.08/0.5/0.82);
 *    shape clips anchor TOP-LEFT, so targets account for w/h ((1-w)/2 etc.).
 *    Degrades when nothing eligible is selected: disabled with a tooltip.
 *
 * Popover mechanics (outside click + Escape close, inline-styled dark menu)
 * mirror the toolbar's RatioPicker so the two feel identical. No entrance
 * animation — trivially prefers-reduced-motion safe.
 */

interface VdzQuickActionsProps {
  /** The working timeline (bottom-lane detection + duration + canvas aspect). */
  timeline?: VdzTimeline;
  /** The single selected clip, if exactly one is selected. */
  selected?: { clip: VdzClip; trackId: string } | null;
  /** Batch commit path (ONE history entry — the page's runBatch). */
  onOps: (ops: VdzOp[]) => void;
}

/** Round to 3 decimals so committed fractions stay clean in the document. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Gaps narrower than this (seconds) are not worth a background slab. */
const GAP_EPSILON = 0.05;

/** Background length for an empty timeline (nothing to span yet). */
const DEFAULT_BG_SPAN_SECONDS = 8;

/** Curated swatches; first two match the sample timeline's own backdrops. */
const BG_SWATCHES: { color: string; label: string }[] = [
  { color: '#1b2a4a', label: 'Deep navy' },
  { color: '#241b3f', label: 'Plum' },
  { color: '#0b0d12', label: 'Midnight' },
  { color: '#000000', label: 'Black' },
  { color: '#14532d', label: 'Forest' },
  { color: '#7f1d1d', label: 'Crimson' },
  { color: '#b45309', label: 'Amber' },
  { color: '#ffffff', label: 'White' },
];

/** Is this clip the app's full-bleed backdrop idiom (recolorable background)? */
function isFullBleedBackdrop(clip: VdzClip): boolean {
  return (
    clip.type === 'shape' &&
    clip.shape === 'rect' &&
    (clip.x ?? 0) === 0 &&
    (clip.y ?? 0) === 0 &&
    (clip.w ?? 1) === 1 &&
    (clip.h ?? 1) === 1
  );
}

/** A ready-to-add full-bleed background rect clip. */
function backgroundClip(
  start: number,
  duration: number,
  color: string
): VdzClip {
  return {
    id: `clip-${nanoid(6)}`,
    type: 'shape',
    name: 'Background',
    start: round3(start),
    duration: round3(duration),
    shape: 'rect',
    color,
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  };
}

/**
 * The uncovered time ranges of a track within [0, span] — the moments where a
 * background slab is needed AND safe (no same-lane overlap → no occlusion).
 */
function uncoveredRanges(
  clips: readonly VdzClip[],
  span: number
): [number, number][] {
  const covered = clips
    .map(c => [c.start, c.start + c.duration] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const gaps: [number, number][] = [];
  let cursor = 0;
  for (const [s, e] of covered) {
    if (s - cursor > GAP_EPSILON) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (span - cursor > GAP_EPSILON) gaps.push([cursor, span]);
  return gaps;
}

/**
 * Compose the op batch that paints the canvas background `color`:
 * recolors + gap-fills the bottom visual lane (creating it only when the
 * timeline has NO visual lane — appended tracks paint on top, so appending a
 * background track is only safe when no earlier visual track exists).
 * Pure; returns [] when there is nothing useful to do.
 */
function canvasBackgroundOps(timeline: VdzTimeline, color: string): VdzOp[] {
  const ops: VdzOp[] = [];
  const span = Math.max(
    computeTimelineDuration(timeline),
    DEFAULT_BG_SPAN_SECONDS
  );
  const bottom = timeline.tracks.find(track => track.kind !== 'audio');
  if (!bottom) {
    const trackId = `track-video-${nanoid(4)}`;
    ops.push({
      op: 'addTrack',
      track: { id: trackId, kind: 'video', name: 'Background', clips: [] },
    });
    ops.push({ op: 'addClip', trackId, clip: backgroundClip(0, span, color) });
    return ops;
  }
  for (const clip of bottom.clips) {
    if (isFullBleedBackdrop(clip)) {
      ops.push({
        op: 'updateClip',
        trackId: bottom.id,
        clipId: clip.id,
        patch: { color },
      });
    }
  }
  for (const [start, end] of uncoveredRanges(bottom.clips, span)) {
    ops.push({
      op: 'addClip',
      trackId: bottom.id,
      clip: backgroundClip(start, end - start, color),
    });
  }
  return ops;
}

// ---- Alignment targets -----------------------------------------------------

/** Grid slot along one axis. */
type Slot = 'start' | 'center' | 'end';

/** Text anchor targets (clip x/y is the CENTER of the text block). */
const TEXT_X: Record<Slot, number> = { start: 0.12, center: 0.5, end: 0.88 };
// Verticals match anim.ts captionAnchorY presets (top/middle/lower).
const TEXT_Y: Record<Slot, number> = { start: 0.08, center: 0.5, end: 0.82 };

/**
 * Resolve the per-axis x/y targets for a clip, or null when the clip type has
 * no x/y in its updateClip patch set (video/audio/image).
 */
function alignTargets(
  clip: VdzClip
): { x: Record<Slot, number>; y: Record<Slot, number> } | null {
  if (clip.type === 'text') {
    return { x: TEXT_X, y: TEXT_Y };
  }
  if (clip.type === 'shape') {
    const w = clip.w ?? 1;
    const h = clip.h ?? 1;
    return {
      x: { start: 0, center: round3((1 - w) / 2), end: round3(1 - w) },
      y: { start: 0, center: round3((1 - h) / 2), end: round3(1 - h) },
    };
  }
  return null;
}

const SLOTS: Slot[] = ['start', 'center', 'end'];

const SLOT_NAME: Record<Slot, { x: string; y: string }> = {
  start: { x: 'left', y: 'top' },
  center: { x: 'center', y: 'middle' },
  end: { x: 'right', y: 'bottom' },
};

// ---- Shared inline styles (match the RatioPicker's dark menu, same file
// idiom: the toolbar popovers use literal hexes inline) ----------------------

const menuStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  zIndex: 40,
  width: 248,
  padding: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  background: '#1b1d22',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#9aa0ab',
};

const hintStyle: React.CSSProperties = {
  fontSize: 10.5,
  lineHeight: 1.5,
  color: '#9aa0ab',
};

const sepStyle: React.CSSProperties = {
  height: 1,
  background: 'rgba(255,255,255,0.12)',
  margin: '0 2px',
};

export function VdzQuickActions({
  timeline,
  selected,
  onOps,
}: VdzQuickActionsProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Custom background color draft (native picker commits on Apply, never
  // per-drag — each Apply is exactly one undoable batch).
  const [draftColor, setDraftColor] = useState('#1b2a4a');

  // Close on outside click or Escape — the RatioPicker mechanics, verbatim.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
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

  // Would setting a background do anything right now? (False only when the
  // bottom lane is fully covered and carries no recolorable backdrop — then
  // a background could never show, so the swatches disable honestly.)
  const bgActionable = useMemo(() => {
    if (!timeline) return false;
    const bottom = timeline.tracks.find(track => track.kind !== 'audio');
    if (!bottom) return true;
    if (bottom.clips.some(isFullBleedBackdrop)) return true;
    const span = Math.max(
      computeTimelineDuration(timeline),
      DEFAULT_BG_SPAN_SECONDS
    );
    return uncoveredRanges(bottom.clips, span).length > 0;
  }, [timeline]);

  const applyBackground = (color: string) => {
    if (!timeline) return;
    const ops = canvasBackgroundOps(timeline, color);
    if (ops.length === 0) return;
    onOps(ops);
  };

  const targets = selected ? alignTargets(selected.clip) : null;
  const alignHint = !selected
    ? 'Select a clip on the timeline first'
    : !targets
      ? 'Alignment applies to text and shape clips'
      : null;

  const alignPatch = (patch: { x?: number; y?: number }) => {
    if (!selected) return;
    onOps([
      {
        op: 'updateClip',
        trackId: selected.trackId,
        clipId: selected.clip.id,
        patch,
      },
    ]);
  };

  const chipStyle = (disabled: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '5px 6px',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6,
    background: 'transparent',
    color: disabled ? '#9aa0ab' : '#e7e9ee',
    font: 'inherit',
    fontSize: 11,
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    whiteSpace: 'nowrap',
  });

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className={styles.toolButton}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Quick actions — canvas background & align selected clip"
      >
        ✦ Quick
      </button>
      {open ? (
        <div role="menu" aria-label="Quick actions" style={menuStyle}>
          {/* ---- Canvas background ---------------------------------------- */}
          <div style={sectionLabelStyle}>Canvas background</div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            {BG_SWATCHES.map(swatch => (
              <button
                key={swatch.color}
                type="button"
                onClick={() => applyBackground(swatch.color)}
                disabled={!bgActionable}
                title={
                  bgActionable
                    ? `Set background — ${swatch.label}`
                    : 'Media already covers the whole canvas'
                }
                aria-label={`Set background — ${swatch.label}`}
                style={{
                  width: 22,
                  height: 22,
                  padding: 0,
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.25)',
                  background: swatch.color,
                  cursor: bgActionable ? 'pointer' : 'default',
                  opacity: bgActionable ? 1 : 0.4,
                }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="color"
              value={draftColor}
              onChange={e => setDraftColor(e.target.value)}
              disabled={!bgActionable}
              aria-label="Custom background color"
              style={{
                width: 34,
                height: 24,
                padding: 0,
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 6,
                background: 'transparent',
                cursor: bgActionable ? 'pointer' : 'default',
                opacity: bgActionable ? 1 : 0.4,
              }}
            />
            <button
              type="button"
              onClick={() => applyBackground(draftColor)}
              disabled={!bgActionable}
              title={
                bgActionable
                  ? 'Apply the custom background color'
                  : 'Media already covers the whole canvas'
              }
              style={chipStyle(!bgActionable)}
            >
              Apply custom
            </button>
          </div>
          <div style={hintStyle}>
            Paints the bottom lane behind everything — recolors existing
            backdrops and fills empty moments. Undo reverts in one step.
          </div>

          <div style={sepStyle} />

          {/* ---- Align selected clip -------------------------------------- */}
          <div style={sectionLabelStyle}>
            Align selected clip
            {selected && targets ? (
              <span
                style={{
                  textTransform: 'none',
                  letterSpacing: 0,
                  fontWeight: 500,
                  color: '#e7e9ee',
                }}
              >
                {' '}
                · {selected.clip.name ?? selected.clip.id}
              </span>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              role="group"
              aria-label="Position presets"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 26px)',
                gridTemplateRows: 'repeat(3, 26px)',
                gap: 4,
              }}
            >
              {SLOTS.map(ySlot =>
                SLOTS.map(xSlot => {
                  const disabled = !targets;
                  const name = `${SLOT_NAME[ySlot].y} ${SLOT_NAME[xSlot].x}`;
                  return (
                    <button
                      key={`${ySlot}-${xSlot}`}
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        targets
                          ? alignPatch({
                              x: targets.x[xSlot],
                              y: targets.y[ySlot],
                            })
                          : undefined
                      }
                      title={
                        disabled
                          ? (alignHint ?? '')
                          : `Snap to ${name.replace('middle center', 'center')}`
                      }
                      aria-label={`Snap to ${name}`}
                      style={{
                        width: 26,
                        height: 26,
                        padding: 4,
                        display: 'inline-flex',
                        alignItems:
                          ySlot === 'start'
                            ? 'flex-start'
                            : ySlot === 'end'
                              ? 'flex-end'
                              : 'center',
                        justifyContent:
                          xSlot === 'start'
                            ? 'flex-start'
                            : xSlot === 'end'
                              ? 'flex-end'
                              : 'center',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 6,
                        background: 'transparent',
                        cursor: disabled ? 'default' : 'pointer',
                        opacity: disabled ? 0.4 : 1,
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: 999,
                          background: disabled ? '#9aa0ab' : '#e7e9ee',
                        }}
                      />
                    </button>
                  );
                })
              )}
            </div>
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <button
                type="button"
                disabled={!targets}
                onClick={() =>
                  targets ? alignPatch({ x: targets.x.center }) : undefined
                }
                title={targets ? 'Center horizontally' : (alignHint ?? '')}
                style={chipStyle(!targets)}
              >
                ↔ Center H
              </button>
              <button
                type="button"
                disabled={!targets}
                onClick={() =>
                  targets ? alignPatch({ y: targets.y.center }) : undefined
                }
                title={targets ? 'Center vertically' : (alignHint ?? '')}
                style={chipStyle(!targets)}
              >
                ↕ Center V
              </button>
            </div>
          </div>
          {alignHint ? <div style={hintStyle}>{alignHint}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
