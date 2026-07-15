import { useCallback, useState } from 'react';

import type {
  VdzAnimation,
  VdzAnimationKind,
  VdzClip,
  VdzEffect,
  VdzEffectKind,
  VdzOp,
} from '../../../../modules/vdz';
import * as styles from './index.css';

/** All animation kinds, for the in/out pickers. */
const ANIMATION_KINDS: VdzAnimationKind[] = [
  'fade',
  'slide-up',
  'slide-down',
  'slide-left',
  'slide-right',
  'zoom-in',
  'zoom-out',
  'pop',
];

/** All effect kinds, for the "add effect" picker. */
const EFFECT_KINDS: VdzEffectKind[] = [
  'blur',
  'brightness',
  'contrast',
  'saturate',
  'grayscale',
  'sepia',
  'glow',
];

const DEFAULT_ANIM_DURATION = 0.5;

interface InspectorProps {
  clip: VdzClip;
  trackId: string;
  /** Emit exactly one op through the host history path. */
  onOp: (op: VdzOp) => void;
}

/** A labeled row wrapper. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className={styles.inspField}>
      <span className={styles.inspFieldLabel}>{label}</span>
      {children}
    </label>
  );
}

/**
 * The clip inspector: type-appropriate style controls, entrance/exit animation
 * pickers, an effects stack editor, and a collapsible raw-JSON view.
 *
 * Every control change emits ONE {@link VdzOp} via `onOp` — the same validated
 * history path the toolbar and lanes use (updateClip / setAnimation /
 * setEffects). The component holds no timeline state of its own.
 */
export function Inspector({ clip, trackId, onOp }: InspectorProps) {
  const [rawOpen, setRawOpen] = useState(false);

  // ---- Style patch (updateClip) -----------------------------------------
  const patch = useCallback(
    (p: Record<string, unknown>) => {
      onOp({ op: 'updateClip', trackId, clipId: clip.id, patch: p });
    },
    [onOp, trackId, clip.id]
  );

  // ---- Animation (setAnimation) -----------------------------------------
  const anim: VdzAnimation = clip.animation ?? {};

  const setAnimSide = useCallback(
    (side: 'in' | 'out', kind: VdzAnimationKind | '') => {
      const nextAnim: VdzAnimation = { ...anim };
      if (kind === '') {
        delete nextAnim[side];
      } else {
        nextAnim[side] = {
          kind,
          duration: anim[side]?.duration ?? DEFAULT_ANIM_DURATION,
        };
      }
      const cleared = !nextAnim.in && !nextAnim.out;
      onOp({
        op: 'setAnimation',
        trackId,
        clipId: clip.id,
        animation: cleared ? null : nextAnim,
      });
    },
    [anim, onOp, trackId, clip.id]
  );

  const setAnimDuration = useCallback(
    (side: 'in' | 'out', duration: number) => {
      const current = anim[side];
      if (!current) return;
      const nextAnim: VdzAnimation = {
        ...anim,
        [side]: { kind: current.kind, duration },
      };
      onOp({ op: 'setAnimation', trackId, clipId: clip.id, animation: nextAnim });
    },
    [anim, onOp, trackId, clip.id]
  );

  // ---- Effects (setEffects) ---------------------------------------------
  const effects: VdzEffect[] = clip.effects ?? [];

  const addEffect = useCallback(
    (kind: VdzEffectKind) => {
      // brightness/contrast read "neutral" at 0.5; others at their low end.
      const amount = kind === 'brightness' || kind === 'contrast' ? 0.5 : 0.5;
      onOp({
        op: 'setEffects',
        trackId,
        clipId: clip.id,
        effects: [...effects, { kind, amount }],
      });
    },
    [effects, onOp, trackId, clip.id]
  );

  const setEffectAmount = useCallback(
    (index: number, amount: number) => {
      const nextEffects = effects.map((e, i) =>
        i === index ? { ...e, amount } : e
      );
      onOp({ op: 'setEffects', trackId, clipId: clip.id, effects: nextEffects });
    },
    [effects, onOp, trackId, clip.id]
  );

  const removeEffect = useCallback(
    (index: number) => {
      const nextEffects = effects.filter((_, i) => i !== index);
      onOp({ op: 'setEffects', trackId, clipId: clip.id, effects: nextEffects });
    },
    [effects, onOp, trackId, clip.id]
  );

  return (
    <div className={styles.inspStack}>
      <div className={styles.inspClipName}>
        {clip.name ?? clip.type}
        <span className={styles.inspClipType}>{clip.type}</span>
      </div>

      {/* ---- Type-appropriate style controls ---- */}
      <div className={styles.inspSection}>
        <div className={styles.inspSectionTitle}>Style</div>

        {clip.type === 'text' ? (
          <>
            <Field label="Text">
              <textarea
                className={styles.inspTextarea}
                value={clip.text}
                rows={2}
                onChange={e => patch({ text: e.target.value })}
              />
            </Field>
            <Field label={`Size ${((clip.fontSize ?? 0.08) * 100).toFixed(0)}%`}>
              <input
                type="range"
                className={styles.inspRange}
                min={0.02}
                max={0.3}
                step={0.005}
                value={clip.fontSize ?? 0.08}
                onChange={e => patch({ fontSize: Number(e.target.value) })}
              />
            </Field>
            <Field label="Color">
              <input
                type="color"
                className={styles.inspColor}
                value={clip.color ?? '#ffffff'}
                onChange={e => patch({ color: e.target.value })}
              />
            </Field>
            <div className={styles.inspRow}>
              <Field label={`X ${((clip.x ?? 0.5) * 100).toFixed(0)}%`}>
                <input
                  type="range"
                  className={styles.inspRange}
                  min={0}
                  max={1}
                  step={0.01}
                  value={clip.x ?? 0.5}
                  onChange={e => patch({ x: Number(e.target.value) })}
                />
              </Field>
              <Field label={`Y ${((clip.y ?? 0.5) * 100).toFixed(0)}%`}>
                <input
                  type="range"
                  className={styles.inspRange}
                  min={0}
                  max={1}
                  step={0.01}
                  value={clip.y ?? 0.5}
                  onChange={e => patch({ y: Number(e.target.value) })}
                />
              </Field>
            </div>
            <Field label="Align">
              <select
                className={styles.inspSelect}
                value={clip.align ?? 'center'}
                onChange={e => patch({ align: e.target.value })}
              >
                <option value="left">left</option>
                <option value="center">center</option>
                <option value="right">right</option>
              </select>
            </Field>
          </>
        ) : null}

        {clip.type === 'shape' ? (
          <>
            <Field label="Color">
              <input
                type="color"
                className={styles.inspColor}
                value={clip.color ?? '#5b8cff'}
                onChange={e => patch({ color: e.target.value })}
              />
            </Field>
            <div className={styles.inspRow}>
              <Field label={`X ${((clip.x ?? 0) * 100).toFixed(0)}%`}>
                <input
                  type="range"
                  className={styles.inspRange}
                  min={0}
                  max={1}
                  step={0.01}
                  value={clip.x ?? 0}
                  onChange={e => patch({ x: Number(e.target.value) })}
                />
              </Field>
              <Field label={`Y ${((clip.y ?? 0) * 100).toFixed(0)}%`}>
                <input
                  type="range"
                  className={styles.inspRange}
                  min={0}
                  max={1}
                  step={0.01}
                  value={clip.y ?? 0}
                  onChange={e => patch({ y: Number(e.target.value) })}
                />
              </Field>
            </div>
            <div className={styles.inspRow}>
              <Field label={`W ${((clip.w ?? 1) * 100).toFixed(0)}%`}>
                <input
                  type="range"
                  className={styles.inspRange}
                  min={0}
                  max={1}
                  step={0.01}
                  value={clip.w ?? 1}
                  onChange={e => patch({ w: Number(e.target.value) })}
                />
              </Field>
              <Field label={`H ${((clip.h ?? 1) * 100).toFixed(0)}%`}>
                <input
                  type="range"
                  className={styles.inspRange}
                  min={0}
                  max={1}
                  step={0.01}
                  value={clip.h ?? 1}
                  onChange={e => patch({ h: Number(e.target.value) })}
                />
              </Field>
            </div>
          </>
        ) : null}

        {clip.type === 'video' || clip.type === 'audio' ? (
          <Field label={`Volume ${((clip.volume ?? 1) * 100).toFixed(0)}%`}>
            <input
              type="range"
              className={styles.inspRange}
              min={0}
              max={1}
              step={0.01}
              value={clip.volume ?? 1}
              onChange={e => patch({ volume: Number(e.target.value) })}
            />
          </Field>
        ) : null}

        {clip.type === 'image' ? (
          <Field label="Fit">
            <select
              className={styles.inspSelect}
              value={clip.fit ?? 'cover'}
              onChange={e => patch({ fit: e.target.value })}
            >
              <option value="cover">cover</option>
              <option value="contain">contain</option>
            </select>
          </Field>
        ) : null}
      </div>

      {/* ---- Animation ---- */}
      <div className={styles.inspSection}>
        <div className={styles.inspSectionTitle}>Animation</div>
        <div className={styles.inspRow}>
          <Field label="In">
            <select
              className={styles.inspSelect}
              value={anim.in?.kind ?? ''}
              onChange={e =>
                setAnimSide('in', e.target.value as VdzAnimationKind | '')
              }
            >
              <option value="">none</option>
              {ANIMATION_KINDS.map(k => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`In ${(anim.in?.duration ?? DEFAULT_ANIM_DURATION)}s`}>
            <input
              type="range"
              className={styles.inspRange}
              min={0.1}
              max={2}
              step={0.1}
              disabled={!anim.in}
              value={anim.in?.duration ?? DEFAULT_ANIM_DURATION}
              onChange={e => setAnimDuration('in', Number(e.target.value))}
            />
          </Field>
        </div>
        <div className={styles.inspRow}>
          <Field label="Out">
            <select
              className={styles.inspSelect}
              value={anim.out?.kind ?? ''}
              onChange={e =>
                setAnimSide('out', e.target.value as VdzAnimationKind | '')
              }
            >
              <option value="">none</option>
              {ANIMATION_KINDS.map(k => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Out ${(anim.out?.duration ?? DEFAULT_ANIM_DURATION)}s`}>
            <input
              type="range"
              className={styles.inspRange}
              min={0.1}
              max={2}
              step={0.1}
              disabled={!anim.out}
              value={anim.out?.duration ?? DEFAULT_ANIM_DURATION}
              onChange={e => setAnimDuration('out', Number(e.target.value))}
            />
          </Field>
        </div>
      </div>

      {/* ---- Effects ---- */}
      <div className={styles.inspSection}>
        <div className={styles.inspSectionTitle}>Effects</div>
        {effects.length === 0 ? (
          <div className={styles.inspEmptyHint}>No effects.</div>
        ) : (
          effects.map((effect, i) => (
            <div key={`${effect.kind}-${i}`} className={styles.inspEffectRow}>
              <span className={styles.inspEffectName}>{effect.kind}</span>
              <input
                type="range"
                className={styles.inspRange}
                min={0}
                max={1}
                step={0.01}
                value={effect.amount}
                onChange={e => setEffectAmount(i, Number(e.target.value))}
              />
              <button
                type="button"
                className={styles.inspIconButton}
                title="Remove effect"
                onClick={() => removeEffect(i)}
              >
                ✕
              </button>
            </div>
          ))
        )}
        <select
          className={styles.inspSelect}
          value=""
          onChange={e => {
            if (e.target.value) addEffect(e.target.value as VdzEffectKind);
          }}
        >
          <option value="">+ add effect…</option>
          {EFFECT_KINDS.map(k => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>

      {/* ---- Raw JSON (collapsible) ---- */}
      <div className={styles.inspSection}>
        <button
          type="button"
          className={styles.inspRawToggle}
          aria-expanded={rawOpen}
          onClick={() => setRawOpen(o => !o)}
        >
          {rawOpen ? '▾' : '▸'} Raw JSON
        </button>
        {rawOpen ? (
          <>
            <pre className={styles.jsonBlock}>
              {JSON.stringify(clip, null, 2)}
            </pre>
            <div className={styles.inspectorMeta}>track: {trackId}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}
