import { nanoid } from 'nanoid';
import { useCallback, useMemo } from 'react';

import type {
  VdzClip,
  VdzEffect,
  VdzOp,
  VdzTimeline,
  VdzTransition,
} from '../../../../modules/vdz';
import {
  VDZ_EFFECT_PRESETS,
  VDZ_TRANSITION_KINDS,
} from '../../../../modules/vdz/presets';
import * as styles from './index.css';
import { VdzPanel } from './vdz-panel';

/**
 * Effects & Transitions panel — the one-click "make it look good" surface.
 *
 * A THIN projection over the same document everything else edits (mirrors the
 * Inspector/Transcript panels): it never holds timeline state, it just emits a
 * single op through the host history path so undo/redo, lane edits and AI ops
 * all reflect here instantly.
 *
 *   · Effect presets → one {@link VdzOp} `setEffects` that REPLACES the clip's
 *     filter stack with the preset's `effects` (the `none` preset ships an empty
 *     stack, which the op treats as "clear").
 *   · Transitions    → one `applyTransition` op on the SELECTED clip's leading
 *     boundary, i.e. the boundary that plays AFTER its left neighbour in the
 *     same track (`afterClipId` = the neighbour's id) — the exact shape the
 *     timeline's between-clip picker uses.
 *
 * Both sections gray out with a friendly hint when they can't act (no clip
 * selected, an audio clip that can't take visual filters, or a clip with no
 * left neighbour to bridge from).
 */

// Middle of the timeline picker's [0.3, 0.5, 1] duration presets — the same
// sensible default a between-clip crossfade gets there.
const DEFAULT_TRANSITION_DURATION = 0.5;

/** Stable equality for two effect stacks (order-sensitive, matches setEffects). */
function sameEffects(a: readonly VdzEffect[], b: readonly VdzEffect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].kind !== b[i].kind || a[i].amount !== b[i].amount) return false;
  }
  return true;
}

/** The clip that sits immediately before `clip` on its track, if any (its left
 * neighbour). A transition on this boundary crossfades neighbour → clip. */
function leftNeighbour(
  timeline: VdzTimeline,
  trackId: string,
  clipId: string
): VdzClip | null {
  const track = timeline.tracks.find(t => t.id === trackId);
  if (!track) return null;
  // Clips in start order so "the one before" is well-defined regardless of the
  // stored array order.
  const ordered = [...track.clips].sort((a, b) => a.start - b.start);
  const index = ordered.findIndex(c => c.id === clipId);
  return index > 0 ? ordered[index - 1] : null;
}

export interface EffectsPanelProps {
  /** The whole timeline (transitions need the clip's track + left neighbour). */
  timeline: VdzTimeline;
  /** The single selected clip + its track, or null when 0 / >1 are selected. */
  selected: { clip: VdzClip; trackId: string } | null;
  /** Emit exactly one op through the host history path (setEffects / applyTransition). */
  onOp: (op: VdzOp) => void;
  onCollapse: () => void;
}

export function EffectsPanel({
  timeline,
  selected,
  onOp,
  onCollapse,
}: EffectsPanelProps) {
  const clip = selected?.clip ?? null;
  // Visual filters + transitions only make sense on a visible clip; audio has
  // no picture to grade or crossfade.
  const isAudio = clip?.type === 'audio';
  const canStyle = Boolean(clip) && !isAudio;

  const currentEffects = clip?.effects ?? [];

  // Which preset (if any) the clip currently matches, so we can light it up.
  const activePresetId = useMemo(() => {
    if (!canStyle) return null;
    const hit = VDZ_EFFECT_PRESETS.find(p => sameEffects(p.effects, currentEffects));
    return hit?.id ?? null;
  }, [canStyle, currentEffects]);

  const applyPreset = useCallback(
    (effects: VdzEffect[]) => {
      if (!selected || isAudio) return;
      // Presets REPLACE the stack; the `none` preset's empty array clears it.
      onOp({
        op: 'setEffects',
        trackId: selected.trackId,
        clipId: selected.clip.id,
        effects,
      });
    },
    [selected, isAudio, onOp]
  );

  // The clip's left neighbour → the transition's `afterClipId`. A transition
  // plays AFTER that clip, i.e. on the selected clip's LEADING edge.
  const neighbour = useMemo(
    () =>
      selected
        ? leftNeighbour(timeline, selected.trackId, selected.clip.id)
        : null,
    [timeline, selected]
  );

  // A transition already sitting on that leading boundary, if any (the op layer
  // keys transitions by `afterClipId`). We surface it as the active kind rather
  // than stacking a second one — matching the timeline's between-clip picker,
  // which shows a badge instead of the "+" once a boundary is bridged.
  const existingTransition = useMemo(() => {
    if (!selected || !neighbour) return null;
    const track = timeline.tracks.find(t => t.id === selected.trackId);
    return (
      track?.transitions?.find(tr => tr.afterClipId === neighbour.id) ?? null
    );
  }, [timeline, selected, neighbour]);

  const canTransition = canStyle && Boolean(neighbour);

  const applyTransition = useCallback(
    (kind: VdzTransition['kind']) => {
      if (!selected || isAudio || !neighbour) return;
      // Don't stack: the boundary already carries a transition (change it from
      // the timeline's boundary control, which owns replace/remove).
      if (existingTransition) return;
      onOp({
        op: 'applyTransition',
        trackId: selected.trackId,
        transition: {
          id: `xfade-${nanoid(6)}`,
          kind,
          afterClipId: neighbour.id,
          duration: DEFAULT_TRANSITION_DURATION,
        },
      });
    },
    [selected, isAudio, neighbour, existingTransition, onOp]
  );

  // Friendly, specific hint for whichever "can't act" state we're in.
  const disabledHint = !clip
    ? 'Select a clip on the timeline to grade it and add transitions.'
    : isAudio
      ? 'This is an audio clip — effects and transitions apply to video, image and text clips.'
      : null;

  return (
    <VdzPanel
      title="Effects"
      icon="✨"
      data-testid="vdz-effects"
      onCollapse={onCollapse}
      bodyClassName={styles.inspectorBody}
    >
      <div style={panelIntroStyle}>
        One-click looks and clip-to-clip transitions for the selected clip.
      </div>

      {/* ---- Effect presets ------------------------------------------------ */}
      <section className={styles.inspSection}>
        <span className={styles.inspSectionTitle}>Effect presets</span>
        {disabledHint ? (
          <div className={styles.inspectorHint}>{disabledHint}</div>
        ) : (
          <div style={presetGridStyle}>
            {VDZ_EFFECT_PRESETS.map(preset => {
              const active = preset.id === activePresetId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  style={presetCardStyle(active)}
                  aria-pressed={active}
                  title={preset.description}
                  onClick={() => applyPreset(preset.effects)}
                >
                  <span style={presetEmojiStyle} aria-hidden="true">
                    {preset.emoji}
                  </span>
                  <span style={presetNameStyle}>{preset.name}</span>
                  <span style={presetDescStyle}>{preset.description}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* ---- Transitions --------------------------------------------------- */}
      <section className={styles.inspSection}>
        <span className={styles.inspSectionTitle}>Transitions</span>
        {!clip || isAudio ? (
          <div className={styles.inspectorHint}>
            {disabledHint}
          </div>
        ) : !neighbour ? (
          <div className={styles.inspectorHint}>
            This clip has no clip to its left, so there's no boundary to bridge.
            Add or move a clip before it, then pick a transition here.
          </div>
        ) : (
          <>
            {existingTransition ? (
              <div className={styles.inspectorHint}>
                A <b>{existingTransition.kind}</b> transition is on this clip's
                leading edge. Adjust or remove it from the boundary marker on the
                timeline.
              </div>
            ) : null}
            <div style={transitionListStyle}>
              {VDZ_TRANSITION_KINDS.map(info => {
                const active = existingTransition?.kind === info.kind;
                return (
                  <button
                    key={info.kind}
                    type="button"
                    style={transitionRowStyle(active)}
                    aria-pressed={active}
                    // Once a boundary is bridged its transition is owned by the
                    // timeline marker; the rows just reflect the current kind.
                    disabled={!canTransition || Boolean(existingTransition)}
                    title={info.description}
                    onClick={() => applyTransition(info.kind)}
                  >
                    <span style={transitionEmojiStyle} aria-hidden="true">
                      {info.emoji}
                    </span>
                    <span style={transitionTextStyle}>
                      <span style={transitionNameStyle}>{info.name}</span>
                      <span style={transitionDescStyle}>
                        {info.description}
                      </span>
                    </span>
                    <span style={transitionAddGlyphStyle} aria-hidden="true">
                      {active ? '✓' : '+'}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </section>
    </VdzPanel>
  );
}

// ---- Inline styles -------------------------------------------------------
// Small, new UI → inline styles (per house rules), painted with the studio's
// themed `--vdz-*` custom properties so cdz themes + light mode flow in and the
// default dark "Midnight" fallbacks match every other panel.

const panelIntroStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--vdz-muted, #8b93a7)',
  paddingBottom: 4,
};

const presetGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
};

function presetCardStyle(active: boolean): React.CSSProperties {
  return {
    appearance: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    textAlign: 'left',
    padding: '10px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    border: active
      ? '1px solid var(--vdz-accent, #5b8cff)'
      : '1px solid var(--vdz-border, #232838)',
    background: active
      ? 'color-mix(in srgb, var(--vdz-accent, #5b8cff) 16%, var(--vdz-panel, #12151d))'
      : 'var(--vdz-bg, #0b0d12)',
    color: 'var(--vdz-text, #e6e9f2)',
    transition: 'background 120ms ease, border-color 120ms ease',
  };
}

const presetEmojiStyle: React.CSSProperties = {
  fontSize: 18,
  lineHeight: 1,
};

const presetNameStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--vdz-text, #e6e9f2)',
};

const presetDescStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.35,
  color: 'var(--vdz-muted, #8b93a7)',
};

const transitionListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

function transitionRowStyle(active: boolean): React.CSSProperties {
  return {
    appearance: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    textAlign: 'left',
    padding: '8px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    border: active
      ? '1px solid var(--vdz-accent, #5b8cff)'
      : '1px solid var(--vdz-border, #232838)',
    background: active
      ? 'color-mix(in srgb, var(--vdz-accent, #5b8cff) 16%, var(--vdz-panel, #12151d))'
      : 'var(--vdz-bg, #0b0d12)',
    color: 'var(--vdz-text, #e6e9f2)',
    transition: 'background 120ms ease, border-color 120ms ease',
  };
}

const transitionEmojiStyle: React.CSSProperties = {
  fontSize: 18,
  lineHeight: 1,
  flexShrink: 0,
};

const transitionTextStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  flex: 1,
  minWidth: 0,
};

const transitionNameStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--vdz-text, #e6e9f2)',
};

const transitionDescStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.35,
  color: 'var(--vdz-muted, #8b93a7)',
};

const transitionAddGlyphStyle: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1,
  color: 'var(--vdz-muted, #8b93a7)',
};
