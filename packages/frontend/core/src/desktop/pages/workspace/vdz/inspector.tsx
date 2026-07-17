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
import { VDZ_EFFECT_PRESETS } from '../../../../modules/vdz/presets';
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

/** Caption presets for text clips (commit as capPreset via setClipStyle). */
const CAPTION_PRESETS: {
  value: 'plain' | 'boxed' | 'outline' | 'shadow' | 'pill';
  label: string;
}[] = [
  { value: 'plain', label: 'Plain' },
  { value: 'boxed', label: 'Boxed' },
  { value: 'outline', label: 'Outline' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'pill', label: 'Pill' },
];

/** Caption vertical placement (commit as capPosition via setClipStyle). */
const CAPTION_POSITIONS: {
  value: 'top' | 'middle' | 'lower';
  label: string;
}[] = [
  { value: 'top', label: 'Top' },
  { value: 'middle', label: 'Middle' },
  { value: 'lower', label: 'Lower' },
];

/** Quick rotation chips for the Style rotation control. */
const ROTATION_CHIPS = [
  { value: 0, label: '0°' },
  { value: -90, label: '-90°' },
  { value: 90, label: '+90°' },
];

/**
 * Order-sensitive deep compare of two effect stacks — used to highlight the
 * "active" effect preset when a clip's effects exactly match one. Kept simple
 * (kind + rounded amount) since presets and stored effects share the shape.
 */
function effectsMatch(a: VdzEffect[], b: VdzEffect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].kind !== b[i].kind) return false;
    if (round3(a[i].amount) !== round3(b[i].amount)) return false;
  }
  return true;
}

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
 * A small segmented control: a row of pill buttons where exactly one is
 * active. Built from the existing quick-button look (border + hover) plus an
 * inline active style — the same className+inline+data-active pattern the
 * color swatches use, so it reads as native inspector chrome.
 */
function SegRow<T extends string | number>({
  options,
  value,
  onPick,
}: {
  options: { value: T; label: string }[];
  value: T | undefined;
  onPick: (value: T) => void;
}) {
  return (
    <div className={ics.colorRow}>
      {options.map(opt => {
        const active = value === opt.value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            className={ics.quickBtn}
            data-active={active}
            aria-pressed={active}
            style={
              active
                ? {
                    flex: 'none',
                    borderColor: 'var(--vdz-accent)',
                    background: 'color-mix(in srgb, var(--vdz-accent) 16%, transparent)',
                  }
                : { flex: 'none' }
            }
            onClick={() => onPick(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Style controls for visual clips (video / image / text / shape): an opacity
 * slider (0..100% → 0..1) and a rotation control (numeric −180..180 with quick
 * chips). Both commit through {@link setClipStyle} sending ONLY the changed
 * field. NEVER rendered for audio clips (guarded by the caller).
 */
function StyleRow({
  clip,
  onStyle,
}: {
  clip: VdzClip;
  onStyle: (changes: { opacity?: number; rotation?: number }) => void;
}) {
  const opacity = (clip as { opacity?: number }).opacity ?? 1;
  const rotation = (clip as { rotation?: number }).rotation ?? 0;
  const [rotDraft, setRotDraft] = useState(String(rotation));

  const commitRotation = useCallback(() => {
    let next = Math.round(Number(rotDraft));
    if (!Number.isFinite(next)) return;
    next = Math.max(-180, Math.min(180, next));
    if (next === rotation) {
      // Keep the draft normalized to the clamped value.
      setRotDraft(String(next));
      return;
    }
    onStyle({ rotation: next });
    setRotDraft(String(next));
  }, [rotDraft, rotation, onStyle]);

  return (
    <>
      <Field label={`Opacity ${Math.round(opacity * 100)}%`}>
        <div className={ics.volumeRow}>
          <input
            type="range"
            className={styles.inspRange}
            min={0}
            max={1}
            step={0.01}
            value={opacity}
            onChange={e => onStyle({ opacity: Number(e.target.value) })}
          />
          <span className={ics.pctBadge}>{Math.round(opacity * 100)}%</span>
        </div>
      </Field>
      <Field label={`Rotation ${rotation}°`}>
        <div className={ics.volumeRow}>
          <input
            className={ics.numInput}
            type="number"
            min={-180}
            max={180}
            step={1}
            value={rotDraft}
            onChange={e => setRotDraft(e.target.value)}
            onBlur={commitRotation}
            onKeyDown={e => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          {ROTATION_CHIPS.map(chip => (
            <button
              key={chip.value}
              type="button"
              className={ics.quickBtn}
              data-active={rotation === chip.value}
              aria-pressed={rotation === chip.value}
              style={
                rotation === chip.value
                  ? {
                      flex: 'none',
                      borderColor: 'var(--vdz-accent)',
                      background:
                        'color-mix(in srgb, var(--vdz-accent) 16%, transparent)',
                    }
                  : { flex: 'none' }
              }
              onClick={() => {
                setRotDraft(String(chip.value));
                if (chip.value !== rotation) onStyle({ rotation: chip.value });
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </Field>
    </>
  );
}

/**
 * Caption styling for TEXT clips: a preset picker (plain/boxed/outline/shadow/
 * pill) and a vertical position picker (top/middle/lower). Both commit
 * capPreset / capPosition through {@link setClipStyle} (one changed field per
 * click). Friendly segmented controls, consistent with the rest of the panel.
 */
function CaptionStyleRow({
  clip,
  onStyle,
}: {
  clip: VdzClip;
  onStyle: (changes: {
    capPreset?: 'plain' | 'boxed' | 'outline' | 'shadow' | 'pill';
    capPosition?: 'top' | 'middle' | 'lower';
  }) => void;
}) {
  const capPreset =
    (clip as { capPreset?: 'plain' | 'boxed' | 'outline' | 'shadow' | 'pill' })
      .capPreset ?? 'plain';
  const capPosition =
    (clip as { capPosition?: 'top' | 'middle' | 'lower' }).capPosition ??
    'lower';
  return (
    <>
      <Field label="Caption style">
        <SegRow
          options={CAPTION_PRESETS}
          value={capPreset}
          onPick={value => onStyle({ capPreset: value })}
        />
      </Field>
      <Field label="Caption position">
        <SegRow
          options={CAPTION_POSITIONS}
          value={capPosition}
          onPick={value => onStyle({ capPosition: value })}
        />
      </Field>
    </>
  );
}

/**
 * One-click effect presets for video / image clips. Each chip replaces the
 * clip's whole effect stack via `setEffects` (the same op the manual editor
 * below uses); the `none` preset ships an empty stack so it clears effects.
 * The chip whose effects exactly match the clip's current stack shows active.
 */
function EffectPresetsRow({
  effects,
  onSetEffects,
}: {
  effects: VdzEffect[];
  onSetEffects: (effects: VdzEffect[]) => void;
}) {
  return (
    <div className={ics.colorRow}>
      {VDZ_EFFECT_PRESETS.map(preset => {
        const active = effectsMatch(effects, preset.effects);
        return (
          <button
            key={preset.id}
            type="button"
            className={ics.quickBtn}
            data-active={active}
            aria-pressed={active}
            title={preset.description}
            style={
              active
                ? {
                    flex: 'none',
                    borderColor: 'var(--vdz-accent)',
                    background:
                      'color-mix(in srgb, var(--vdz-accent) 16%, transparent)',
                  }
                : { flex: 'none' }
            }
            onClick={() => onSetEffects(preset.effects)}
          >
            {preset.emoji} {preset.name}
          </button>
        );
      })}
    </div>
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

  // ---- Visual style (setClipStyle) --------------------------------------
  // Opacity / rotation / caption preset+position. Sends ONLY changed fields;
  // fields are merged host-side. Never invoked for audio clips (guarded).
  const setClipStyle = useCallback(
    (changes: {
      opacity?: number;
      rotation?: number;
      capPreset?: 'plain' | 'boxed' | 'outline' | 'shadow' | 'pill';
      capPosition?: 'top' | 'middle' | 'lower';
    }) => {
      onOp({ op: 'setClipStyle', trackId, clipId: clip.id, ...changes });
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
        {/* Opacity + rotation — visual clips only, never audio. */}
        {clip.type !== 'audio' ? (
          <StyleRow
            key={`clipstyle-${clip.id}`}
            clip={clip}
            onStyle={setClipStyle}
          />
        ) : null}

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
            {/* Caption preset + position (text clips only). */}
            <CaptionStyleRow
              key={`capstyle-${clip.id}`}
              clip={clip}
              onStyle={setClipStyle}
            />
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

      {/* ---- Effect presets (video / image): one-click filter looks ---- */}
      {clip.type === 'video' || clip.type === 'image' ? (
        <Section
          id="effectpresets"
          title="Effect presets"
          closed={closedSections}
          onToggle={toggleSection}
        >
          <EffectPresetsRow
            effects={effects}
            onSetEffects={next =>
              onOp({ op: 'setEffects', trackId, clipId: clip.id, effects: next })
            }
          />
        </Section>
      ) : null}

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
