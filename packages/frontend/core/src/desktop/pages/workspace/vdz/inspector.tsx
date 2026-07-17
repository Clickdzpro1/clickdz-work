import { nanoid } from 'nanoid';
import { useCallback, useState } from 'react';

import type {
  VdzAnimation,
  VdzAnimationKind,
  VdzAudioClip,
  VdzClip,
  VdzEffect,
  VdzEffectKind,
  VdzOp,
  VdzTimeline,
} from '../../../../modules/vdz';
import * as styles from './index.css';
import * as ics from './inspector.css';
import { useVdzCaptions } from './use-vdz-captions';

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

/** One-click color presets for text/shape clips (native picker stays too). */
const COLOR_SWATCHES = [
  '#ffffff',
  '#0f172a',
  '#ffd700',
  '#ff6b6b',
  '#3fb7a6',
  '#5b8cff',
  '#a06bff',
  '#22c55e',
];

const round3 = (value: number) => Math.round(value * 1000) / 1000;

interface InspectorProps {
  clip: VdzClip;
  trackId: string;
  /** Emit exactly one op through the host history path. */
  onOp: (op: VdzOp) => void;
  /** The whole timeline (captions need the overlay track + clip offsets). */
  timeline: VdzTimeline;
  /**
   * Commit a BATCH of ops as one history entry (host `runBatch`). Optional so
   * the inspector renders without it; the captions button needs it.
   */
  onOps?: (ops: VdzOp[]) => void;
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
 * A collapsible section: the familiar uppercase header, now clickable with a
 * chevron and an optional right-aligned count badge. Sections default OPEN;
 * the open/closed set lives in the Inspector so it survives control edits but
 * intentionally resets with the panel (fresh selection = fresh workspace).
 */
function Section({
  id,
  title,
  count,
  closed,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  closed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  const open = !closed.has(id);
  return (
    <div className={styles.inspSection}>
      <button
        type="button"
        className={ics.sectionToggle}
        aria-expanded={open}
        onClick={() => onToggle(id)}
      >
        <span className={ics.sectionChevron} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {title}
        {typeof count === 'number' && count > 0 ? (
          <span className={ics.sectionCount}>{count}</span>
        ) : null}
      </button>
      {open ? children : null}
    </div>
  );
}

/**
 * Rename control. Local draft (keyed by clip id via the parent's `key`) so
 * typing never spams ops; commits ONE updateClip on blur/Enter when changed.
 */
function RenameRow({
  clip,
  trackId,
  onOp,
}: {
  clip: VdzClip;
  trackId: string;
  onOp: (op: VdzOp) => void;
}) {
  const [draft, setDraft] = useState(clip.name ?? '');
  const commit = useCallback(() => {
    const next = draft.trim();
    if (next === (clip.name ?? '') || next.length === 0) return;
    onOp({ op: 'updateClip', trackId, clipId: clip.id, patch: { name: next } });
  }, [draft, clip.name, clip.id, trackId, onOp]);
  return (
    <input
      className={ics.renameInput}
      value={draft}
      placeholder={clip.type}
      aria-label="Clip name"
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/**
 * Timing controls. Number drafts commit on blur/Enter as ONE trimClip op with
 * only the changed fields — dragging on the lanes stays the fluid path; this
 * is the precise one. Keyed by clip id so drafts reset on selection change.
 */
function TimingSection({
  clip,
  trackId,
  onOp,
}: {
  clip: VdzClip;
  trackId: string;
  onOp: (op: VdzOp) => void;
}) {
  const [startDraft, setStartDraft] = useState(String(clip.start));
  const [durDraft, setDurDraft] = useState(String(clip.duration));
  const [trimDraft, setTrimDraft] = useState(
    clip.type === 'video' ? String(clip.trimStart ?? 0) : '0'
  );

  const commit = useCallback(() => {
    const start = round3(Math.max(0, Number(startDraft)));
    const duration = round3(Math.max(0.1, Number(durDraft)));
    const trimStart =
      clip.type === 'video' ? round3(Math.max(0, Number(trimDraft))) : undefined;

    const changes: {
      start?: number;
      duration?: number;
      trimStart?: number;
    } = {};
    if (Number.isFinite(start) && start !== clip.start) changes.start = start;
    if (Number.isFinite(duration) && duration !== clip.duration) {
      changes.duration = duration;
    }
    if (
      clip.type === 'video' &&
      trimStart !== undefined &&
      Number.isFinite(trimStart) &&
      trimStart !== (clip.trimStart ?? 0)
    ) {
      changes.trimStart = trimStart;
    }
    if (Object.keys(changes).length === 0) return;
    onOp({ op: 'trimClip', trackId, clipId: clip.id, ...changes });
  }, [startDraft, durDraft, trimDraft, clip, trackId, onOp]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
  };

  return (
    <div className={ics.numRow}>
      <Field label="Start (s)">
        <input
          className={ics.numInput}
          type="number"
          min={0}
          step={0.1}
          value={startDraft}
          onChange={e => setStartDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </Field>
      <Field label="Duration (s)">
        <input
          className={ics.numInput}
          type="number"
          min={0.1}
          step={0.1}
          value={durDraft}
          onChange={e => setDurDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </Field>
      {clip.type === 'video' ? (
        <Field label="Trim head (s)">
          <input
            className={ics.numInput}
            type="number"
            min={0}
            step={0.1}
            value={trimDraft}
            onChange={e => setTrimDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={onKeyDown}
          />
        </Field>
      ) : null}
    </div>
  );
}

/** Volume slider + live % readout + one-tap mute/unmute (video & audio). */
function VolumeRow({
  volume,
  onVolume,
}: {
  volume: number;
  onVolume: (v: number) => void;
}) {
  const muted = volume <= 0;
  return (
    <Field label="Volume">
      <div className={ics.volumeRow}>
        <input
          type="range"
          className={styles.inspRange}
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={e => onVolume(Number(e.target.value))}
        />
        <span className={ics.pctBadge}>{Math.round(volume * 100)}%</span>
        <button
          type="button"
          className={ics.muteBtn}
          title={muted ? 'Unmute (restore 100%)' : 'Mute this clip'}
          aria-pressed={muted}
          onClick={() => onVolume(muted ? 1 : 0)}
        >
          {muted ? '🔇' : '🔊'}
        </button>
      </div>
    </Field>
  );
}

/** Swatch presets + native picker + hex readout for text/shape color. */
function ColorRow({
  value,
  fallback,
  onColor,
}: {
  value: string | undefined;
  fallback: string;
  onColor: (color: string) => void;
}) {
  const current = (value ?? fallback).toLowerCase();
  return (
    <Field label="Color">
      <div className={ics.colorRow}>
        {COLOR_SWATCHES.map(swatch => (
          <button
            key={swatch}
            type="button"
            className={ics.swatch}
            style={{ background: swatch }}
            data-active={current === swatch}
            title={swatch}
            aria-label={`Set color ${swatch}`}
            onClick={() => onColor(swatch)}
          />
        ))}
        <input
          type="color"
          className={styles.inspColor}
          value={current}
          onChange={e => onColor(e.target.value)}
        />
        <span className={ics.hexReadout}>{current}</span>
      </div>
    </Field>
  );
}

/**
 * "Generate captions" for an audio clip: transcribe (Whisper via the vdz
 * transcribe route) and land one text clip per segment on the overlay track,
 * committed as a single undoable batch. A separate component so the hook's
 * per-clip state (busy/error) remounts cleanly when the selection changes.
 */
function CaptionTools({
  clip,
  timeline,
  onOps,
}: {
  clip: VdzAudioClip;
  timeline: VdzTimeline;
  onOps?: (ops: VdzOp[]) => void;
}) {
  const captions = useVdzCaptions(clip, timeline);
  const [lastCount, setLastCount] = useState<number | null>(null);

  const onGenerate = useCallback(() => {
    setLastCount(null);
    captions
      .generate()
      .then(({ ops, count }) => {
        onOps?.(ops);
        setLastCount(count);
      })
      .catch(() => {
        // captions.error already carries the message; nothing else to do.
      });
  }, [captions, onOps]);

  return (
    <>
      <button
        type="button"
        className={ics.quickBtn}
        onClick={onGenerate}
        disabled={captions.busy || !captions.ready || !onOps}
        title="Transcribe this clip and add a caption text clip per phrase"
      >
        {captions.busy
          ? '⏳ Transcribing…'
          : !captions.ready
            ? 'Loading audio…'
            : '💬 Generate captions'}
      </button>
      {captions.error ? (
        <div className={styles.inspEmptyHint}>{captions.error}</div>
      ) : null}
      {lastCount !== null ? (
        <div className={styles.inspEmptyHint}>
          Added {lastCount} caption{lastCount === 1 ? '' : 's'} to the overlay
          lane (one undo entry). Open the Transcript panel to edit them.
        </div>
      ) : null}
    </>
  );
}

/**
 * The clip inspector: quick actions (duplicate / delete / ripple), rename,
 * precise timing, type-appropriate style controls (with swatches + volume
 * mute), audio mix + captions for audio clips, animation, effects and a raw
 * JSON view — every section collapsible.
 *
 * Every control change emits ops via `onOp`/`onOps` — the same validated
 * history path the toolbar and lanes use. The component holds no timeline
 * state of its own (only ephemeral input drafts + section open/closed state).
 */
export function Inspector({
  clip,
  trackId,
  onOp,
  timeline,
  onOps,
}: InspectorProps) {
  const [rawOpen, setRawOpen] = useState(false);
  const [closedSections, setClosedSections] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const toggleSection = useCallback((id: string) => {
    setClosedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ---- Style patch (updateClip) -----------------------------------------
  const patch = useCallback(
    (p: Record<string, unknown>) => {
      onOp({ op: 'updateClip', trackId, clipId: clip.id, patch: p });
    },
    [onOp, trackId, clip.id]
  );

  // ---- Quick actions ------------------------------------------------------
  const duplicateClip = useCallback(() => {
    // Deep copy keeps the discriminated shape; fresh id; lands right after.
    const copy = JSON.parse(JSON.stringify(clip)) as VdzClip;
    copy.id = `clip-${nanoid(6)}`;
    copy.start = round3(clip.start + clip.duration);
    onOp({ op: 'addClip', trackId, clip: copy });
  }, [clip, trackId, onOp]);

  const deleteClip = useCallback(
    () => onOp({ op: 'removeClip', trackId, clipId: clip.id }),
    [onOp, trackId, clip.id]
  );

  const rippleDeleteClip = useCallback(
    () => onOp({ op: 'rippleDelete', trackId, clipId: clip.id }),
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
      const amount = 0.5;
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

  const clearEffects = useCallback(
    () => onOp({ op: 'setEffects', trackId, clipId: clip.id, effects: [] }),
    [onOp, trackId, clip.id]
  );

  return (
    <div className={styles.inspStack}>
      <div className={styles.inspClipName}>
        {clip.name ?? clip.type}
        <span className={styles.inspClipType}>{clip.type}</span>
      </div>

      {/* ---- Quick actions ---- */}
      <div className={ics.quickRow}>
        <button
          type="button"
          className={ics.quickBtn}
          onClick={duplicateClip}
          title="Duplicate this clip right after itself"
        >
          ⧉ Duplicate
        </button>
        <button
          type="button"
          className={ics.quickBtnDanger}
          onClick={deleteClip}
          title="Delete this clip (leaves a gap)"
        >
          🗑 Delete
        </button>
        <button
          type="button"
          className={ics.quickBtnDanger}
          onClick={rippleDeleteClip}
          title="Delete and close the gap (ripple)"
        >
          ⇤ Ripple
        </button>
      </div>

      {/* ---- Rename (commits on blur/Enter) ---- */}
      <RenameRow key={`name-${clip.id}`} clip={clip} trackId={trackId} onOp={onOp} />

      {/* ---- Timing ---- */}
      <Section
        id="timing"
        title="Timing"
        closed={closedSections}
        onToggle={toggleSection}
      >
        <TimingSection
          key={`timing-${clip.id}-${clip.start}-${clip.duration}`}
          clip={clip}
          trackId={trackId}
          onOp={onOp}
        />
      </Section>

      {/* ---- Type-appropriate style controls ---- */}
      <Section
        id="style"
        title="Style"
        closed={closedSections}
        onToggle={toggleSection}
      >
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
            <ColorRow
              value={clip.color}
              fallback="#ffffff"
              onColor={color => patch({ color })}
            />
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
            <ColorRow
              value={clip.color}
              fallback="#5b8cff"
              onColor={color => patch({ color })}
            />
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
          <VolumeRow
            volume={clip.volume ?? 1}
            onVolume={volume => patch({ volume })}
          />
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
      </Section>

      {/* ---- Audio mix (audio clips only): fades + ducking ---- */}
      {clip.type === 'audio' ? (
        <Section
          id="audiomix"
          title="Audio mix"
          closed={closedSections}
          onToggle={toggleSection}
        >
          <div className={styles.inspRow}>
            <Field label={`Fade in ${(clip.fadeIn ?? 0).toFixed(1)}s`}>
              <input
                type="range"
                className={styles.inspRange}
                min={0}
                max={3}
                step={0.1}
                value={clip.fadeIn ?? 0}
                onChange={e => {
                  const v = Number(e.target.value);
                  onOp({
                    op: 'setAudioMix',
                    trackId,
                    clipId: clip.id,
                    // 0 clears the fade rather than storing a dead field.
                    fadeIn: v === 0 ? null : v,
                  });
                }}
              />
            </Field>
            <Field label={`Fade out ${(clip.fadeOut ?? 0).toFixed(1)}s`}>
              <input
                type="range"
                className={styles.inspRange}
                min={0}
                max={3}
                step={0.1}
                value={clip.fadeOut ?? 0}
                onChange={e => {
                  const v = Number(e.target.value);
                  onOp({
                    op: 'setAudioMix',
                    trackId,
                    clipId: clip.id,
                    fadeOut: v === 0 ? null : v,
                  });
                }}
              />
            </Field>
          </div>
          <Field label="Duck other audio while this plays">
            <input
              type="checkbox"
              checked={clip.duck ?? false}
              onChange={e =>
                onOp({
                  op: 'setAudioMix',
                  trackId,
                  clipId: clip.id,
                  duck: e.target.checked ? true : null,
                })
              }
            />
          </Field>
        </Section>
      ) : null}

      {/* ---- Captions (audio clips only): transcribe → text clips ---- */}
      {clip.type === 'audio' ? (
        <Section
          id="captions"
          title="Captions"
          closed={closedSections}
          onToggle={toggleSection}
        >
          <CaptionTools clip={clip} timeline={timeline} onOps={onOps} />
        </Section>
      ) : null}

      {/* ---- Animation ---- */}
      <Section
        id="animation"
        title="Animation"
        count={(anim.in ? 1 : 0) + (anim.out ? 1 : 0)}
        closed={closedSections}
        onToggle={toggleSection}
      >
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
      </Section>

      {/* ---- Effects ---- */}
      <Section
        id="effects"
        title="Effects"
        count={effects.length}
        closed={closedSections}
        onToggle={toggleSection}
      >
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
              <span className={ics.pctBadge}>
                {Math.round(effect.amount * 100)}%
              </span>
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
        {effects.length > 1 ? (
          <button
            type="button"
            className={ics.clearAllBtn}
            onClick={clearEffects}
          >
            Clear all effects
          </button>
        ) : null}
      </Section>

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
