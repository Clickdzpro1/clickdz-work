import { nanoid } from 'nanoid';
import { useCallback, useMemo, useRef, useState } from 'react';

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
import { VDZ_EFFECT_PRESETS, VDZ_RATIO_PRESETS } from '../../../../modules/vdz/presets';
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
  'vignette',
];

const DEFAULT_ANIM_DURATION = 0.5;
const DEFAULT_FONT_SIZE = 0.08;
const DEFAULT_EFFECT_AMOUNT = 0.5;

/** Canvas custom-dimension bounds (match the setCanvas op's 320..4096 range). */
const CANVAS_MIN = 320;
const CANVAS_MAX = 4096;

/** ~2% aspect tolerance for lighting up the matching ratio preset. */
const RATIO_MATCH_TOLERANCE = 0.02;

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
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

type CapPreset = 'plain' | 'boxed' | 'outline' | 'shadow' | 'pill' | 'karaoke';
type CapPosition = 'top' | 'middle' | 'lower';

/** Caption presets for text clips (commit as capPreset via setClipStyle). */
const CAPTION_PRESETS: { value: CapPreset; label: string }[] = [
  { value: 'plain', label: 'Plain' },
  { value: 'boxed', label: 'Boxed' },
  { value: 'outline', label: 'Outline' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'pill', label: 'Pill' },
  // Karaoke only highlights word-by-word when the caption carries `words`
  // (generated captions do); otherwise it renders as the boxed look.
  { value: 'karaoke', label: 'Karaoke' },
];

/** Caption vertical placement (commit as capPosition via setClipStyle). */
const CAPTION_POSITIONS: { value: CapPosition; label: string }[] = [
  { value: 'top', label: 'Top' },
  { value: 'middle', label: 'Middle' },
  { value: 'lower', label: 'Lower' },
];

/** Quick rotation chips for the Transform rotation control. */
const ROTATION_CHIPS = [
  { value: 0, label: '0°' },
  { value: -90, label: '-90°' },
  { value: 90, label: '+90°' },
];

/** Inline style for an "active" pill (accent border + tinted fill). */
const activePillStyle: React.CSSProperties = {
  flex: 'none',
  borderColor: 'var(--vdz-accent)',
  background: 'color-mix(in srgb, var(--vdz-accent) 16%, transparent)',
};
const inactivePillStyle: React.CSSProperties = { flex: 'none' };

/**
 * Order-sensitive deep compare of two effect stacks — used to highlight the
 * "active" effect preset when a clip's effects exactly match one.
 */
function effectsMatch(a: VdzEffect[], b: VdzEffect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].kind !== b[i].kind) return false;
    if (round3(a[i].amount) !== round3(b[i].amount)) return false;
  }
  return true;
}

/**
 * The single-duration rule (contract C1): max over ALL clips on ALL tracks of
 * (start + duration), never less than 1. Read-only display in the Project
 * section; the export/AI paths compute the same thing independently.
 */
function computeTotalDuration(timeline: VdzTimeline): number {
  let max = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const end = clip.start + clip.duration;
      if (end > max) max = end;
    }
  }
  return Math.max(1, max);
}

/** `mm:ss.d` for the total-duration readout (self-contained, no import). */
function fmtDuration(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const mins = Math.floor(clamped / 60);
  const secs = Math.floor(clamped % 60);
  const frac = Math.floor((clamped - Math.floor(clamped)) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${frac}`;
}

interface InspectorProps {
  /**
   * The single selected clip + its track, or null when nothing / more than one
   * clip is selected. When null the inspector shows the Project panel (0
   * selected) or the multi-select hint (see {@link selectedCount}).
   */
  clip: VdzClip | null;
  trackId: string | null;
  /** How many clips are currently selected (drives the empty vs multi state). */
  selectedCount?: number;
  /** Emit exactly one op through the host history path. */
  onOp: (op: VdzOp) => void;
  /** The whole timeline (captions + Project panel + apply-to-lane need it). */
  timeline: VdzTimeline;
  /**
   * Commit a BATCH of ops as one history entry (host `runBatch`). Optional so
   * the inspector renders without it; captions + apply-to-lane need it.
   */
  onOps?: (ops: VdzOp[]) => void;
}

/** A labeled row wrapper (label stacked above the control). */
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
 * A collapsible section: the familiar uppercase header, clickable with a
 * chevron and an optional right-aligned count badge. Open/closed state lives in
 * the Inspector (in-memory) and PERSISTS across selection changes.
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

/** A tiny reset-to-default button; disabled when already at the default. */
function ResetButton({
  atDefault,
  onReset,
  title,
}: {
  atDefault: boolean;
  onReset: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      className={ics.resetBtn}
      disabled={atDefault}
      title={atDefault ? 'Already at default' : title}
      aria-label={title}
      onClick={() => {
        if (!atDefault) onReset();
      }}
    >
      ↺
    </button>
  );
}

/**
 * A numeric input supporting BOTH typing and horizontal drag-to-scrub. A drag
 * past a small threshold enters scrub mode (pointer capture + ew-resize); a
 * plain click still focuses for typing. Commits the clamped/stepped value via
 * `onCommit` (debounced to blur/Enter for typing; live while scrubbing). Arrow
 * Up/Down nudge by `step`.
 */
function ScrubField({
  value,
  min,
  max,
  step = 1,
  precision = 3,
  unit,
  ariaLabel,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  ariaLabel: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [scrubbing, setScrubbing] = useState(false);
  const focused = useRef(false);
  const drag = useRef<{
    startX: number;
    startVal: number;
    active: boolean;
    pointerId: number;
  } | null>(null);

  // Reflect external value changes (undo/redo, drag-on-lanes, AI edits) into
  // the draft — but only when the user isn't mid-edit here (typing or
  // scrubbing), so we never yank the field out from under them.
  const lastValue = useRef(value);
  if (lastValue.current !== value) {
    lastValue.current = value;
    if (!scrubbing && !focused.current) setDraft(String(value));
  }

  const normalize = useCallback(
    (raw: number) => {
      let next = raw;
      if (typeof min === 'number') next = Math.max(min, next);
      if (typeof max === 'number') next = Math.min(max, next);
      const factor = Math.pow(10, precision);
      return Math.round(next * factor) / factor;
    },
    [min, max, precision]
  );

  const commitDraft = useCallback(() => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = normalize(parsed);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  }, [draft, value, normalize, onCommit]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLInputElement>) => {
      // Only left button; let text selection with the caret still work — scrub
      // is armed but only engages after a horizontal move threshold.
      if (e.button !== 0) return;
      drag.current = {
        startX: e.clientX,
        startVal: value,
        active: false,
        pointerId: e.pointerId,
      };
    },
    [value]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLInputElement>) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      if (!d.active) {
        if (Math.abs(dx) < 4) return;
        d.active = true;
        setScrubbing(true);
        try {
          (e.target as HTMLInputElement).setPointerCapture(d.pointerId);
        } catch {
          // pointer capture is best-effort
        }
      }
      // 1 step per ~4px of horizontal travel — fine control, still fast.
      const deltaSteps = Math.round(dx / 4);
      const next = normalize(d.startVal + deltaSteps * step);
      setDraft(String(next));
      if (next !== value) onCommit(next);
    },
    [normalize, step, value, onCommit]
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    const d = drag.current;
    if (d?.active) {
      try {
        (e.target as HTMLInputElement).releasePointerCapture(d.pointerId);
      } catch {
        // ignore
      }
    }
    drag.current = null;
    setScrubbing(false);
  }, []);

  return (
    <div className={ics.inlineField}>
      <input
        className={ics.scrubInput}
        type="number"
        inputMode="decimal"
        data-scrub={scrubbing ? 'true' : 'false'}
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commitDraft();
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const next = normalize(Number(draft || value) + step);
            setDraft(String(next));
            if (next !== value) onCommit(next);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const next = normalize(Number(draft || value) - step);
            setDraft(String(next));
            if (next !== value) onCommit(next);
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      {unit ? <span className={ics.unitTag}>{unit}</span> : null}
    </div>
  );
}

/**
 * A slider (range) with a value bubble that floats over the thumb while
 * interacting, plus an optional reset-to-default button. `format` renders the
 * bubble text; the bubble is positioned from the value's position within
 * [min,max]. When `defaultValue` is given a reset "↺" appears (disabled at the
 * default).
 */
function RangeField({
  label,
  value,
  min,
  max,
  step,
  format,
  ariaLabel,
  defaultValue,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  ariaLabel: string;
  defaultValue?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const [show, setShow] = useState(false);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const hasDefault = typeof defaultValue === 'number';
  const atDefault = hasDefault && round3(value) === round3(defaultValue);
  return (
    <Field label={label}>
      <div className={ics.volumeRow}>
        <div className={ics.rangeWrap}>
          <span
            className={ics.rangeBubble}
            data-show={show && !disabled ? 'true' : 'false'}
            style={{ left: `${pct}%` }}
            aria-hidden="true"
          >
            {format(value)}
          </span>
          <input
            type="range"
            className={styles.inspRange}
            aria-label={ariaLabel}
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            onChange={e => onChange(Number(e.target.value))}
            onPointerDown={() => setShow(true)}
            onPointerUp={() => setShow(false)}
            onPointerCancel={() => setShow(false)}
            onFocus={() => setShow(true)}
            onBlur={() => setShow(false)}
          />
        </div>
        {hasDefault ? (
          <ResetButton
            atDefault={atDefault}
            title={`Reset to ${format(defaultValue)}`}
            onReset={() => onChange(defaultValue)}
          />
        ) : null}
      </div>
    </Field>
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
 * Timing controls: start / duration (all clips) + trim head (video). Scrub or
 * type; commits ONE trimClip op with only the changed fields. Keyed by clip id
 * so drafts reset on selection change.
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
  const commitStart = useCallback(
    (start: number) => {
      const next = round3(Math.max(0, start));
      if (next !== clip.start) {
        onOp({ op: 'trimClip', trackId, clipId: clip.id, start: next });
      }
    },
    [clip.start, clip.id, trackId, onOp]
  );
  const commitDuration = useCallback(
    (duration: number) => {
      const next = round3(Math.max(0.1, duration));
      if (next !== clip.duration) {
        onOp({ op: 'trimClip', trackId, clipId: clip.id, duration: next });
      }
    },
    [clip.duration, clip.id, trackId, onOp]
  );
  const commitTrim = useCallback(
    (trimStart: number) => {
      if (clip.type !== 'video') return;
      const next = round3(Math.max(0, trimStart));
      if (next !== (clip.trimStart ?? 0)) {
        onOp({ op: 'trimClip', trackId, clipId: clip.id, trimStart: next });
      }
    },
    [clip, trackId, onOp]
  );

  return (
    <div className={ics.numRow}>
      <Field label="Start">
        <ScrubField
          value={clip.start}
          min={0}
          step={0.1}
          unit="s"
          ariaLabel="Start (seconds)"
          onCommit={commitStart}
        />
      </Field>
      <Field label="Duration">
        <ScrubField
          value={clip.duration}
          min={0.1}
          step={0.1}
          unit="s"
          ariaLabel="Duration (seconds)"
          onCommit={commitDuration}
        />
      </Field>
      {clip.type === 'video' ? (
        <Field label="Trim head">
          <ScrubField
            value={clip.trimStart ?? 0}
            min={0}
            step={0.1}
            unit="s"
            ariaLabel="Trim head (seconds)"
            onCommit={commitTrim}
          />
        </Field>
      ) : null}
    </div>
  );
}

/** Volume slider + live % readout + one-tap mute/unmute + reset (video & audio). */
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
        <div className={ics.rangeWrap}>
          <input
            type="range"
            className={styles.inspRange}
            aria-label="Clip volume"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={e => onVolume(Number(e.target.value))}
          />
        </div>
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
        <ResetButton
          atDefault={round3(volume) === 1}
          title="Reset to 100%"
          onReset={() => onVolume(1)}
        />
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
          aria-label="Custom color"
          value={current}
          onChange={e => onColor(e.target.value)}
        />
        <span className={ics.hexReadout}>{current}</span>
      </div>
    </Field>
  );
}

/**
 * A small segmented control: a row of pill buttons where exactly one is active.
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
            style={active ? activePillStyle : inactivePillStyle}
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
 * Transform controls for visual clips (video / image / text / shape): an
 * opacity slider (0..100% → 0..1) and a rotation control (numeric −180..180
 * with quick chips), each with a reset. Commits through {@link setClipStyle}
 * sending ONLY the changed field. NEVER rendered for audio clips.
 */
function TransformRows({
  clip,
  onStyle,
}: {
  clip: VdzClip;
  onStyle: (changes: { opacity?: number; rotation?: number }) => void;
}) {
  const opacity = (clip as { opacity?: number }).opacity ?? 1;
  const rotation = (clip as { rotation?: number }).rotation ?? 0;

  const commitRotation = useCallback(
    (raw: number) => {
      const next = clamp(Math.round(raw), -180, 180);
      if (next !== rotation) onStyle({ rotation: next });
    },
    [rotation, onStyle]
  );

  return (
    <>
      <RangeField
        label={`Opacity ${Math.round(opacity * 100)}%`}
        value={opacity}
        min={0}
        max={1}
        step={0.01}
        defaultValue={1}
        format={v => `${Math.round(v * 100)}%`}
        ariaLabel="Opacity"
        onChange={v => onStyle({ opacity: v })}
      />
      <Field label="Rotation">
        <div className={ics.volumeRow}>
          <ScrubField
            value={rotation}
            min={-180}
            max={180}
            step={1}
            precision={0}
            unit="°"
            ariaLabel="Rotation (degrees)"
            onCommit={commitRotation}
          />
          {ROTATION_CHIPS.map(chip => (
            <button
              key={chip.value}
              type="button"
              className={ics.quickBtn}
              data-active={rotation === chip.value}
              aria-pressed={rotation === chip.value}
              style={rotation === chip.value ? activePillStyle : inactivePillStyle}
              onClick={() => {
                if (chip.value !== rotation) onStyle({ rotation: chip.value });
              }}
            >
              {chip.label}
            </button>
          ))}
          <ResetButton
            atDefault={rotation === 0}
            title="Reset to 0°"
            onReset={() => {
              if (rotation !== 0) onStyle({ rotation: 0 });
            }}
          />
        </div>
      </Field>
    </>
  );
}

/**
 * Caption styling for TEXT clips: a preset picker + a vertical position picker,
 * a karaoke-state indicator, and "apply to all clips in this lane" affordances
 * (batched into a single undo entry via `onApplyLane`). Both single-clip picks
 * commit capPreset / capPosition through {@link setClipStyle}.
 */
function CaptionStyleRows({
  clip,
  onStyle,
  laneTextCount,
  onApplyLane,
}: {
  clip: VdzClip & { type: 'text' };
  onStyle: (changes: {
    capPreset?: CapPreset;
    capPosition?: CapPosition;
  }) => void;
  /** How many text clips share this lane (incl. the selected one). */
  laneTextCount: number;
  /** Apply one field to every text clip in this lane (single undo). */
  onApplyLane?: (field: 'capPreset' | 'capPosition') => void;
}) {
  const capPreset = clip.capPreset ?? 'plain';
  const capPosition = clip.capPosition ?? 'lower';
  const hasWords = Array.isArray(clip.words) && clip.words.length > 0;
  const karaokeActive = capPreset === 'karaoke';
  const canApplyLane = laneTextCount > 1 && Boolean(onApplyLane);

  return (
    <>
      <Field label="Caption style">
        <SegRow
          options={CAPTION_PRESETS}
          value={capPreset}
          onPick={value => onStyle({ capPreset: value })}
        />
      </Field>
      {canApplyLane ? (
        <button
          type="button"
          className={ics.applyAllBtn}
          title="Set every text clip in this lane to this caption style (one undo)"
          onClick={() => onApplyLane?.('capPreset')}
        >
          Apply style to all {laneTextCount} clips in lane
        </button>
      ) : null}
      <Field label="Caption position">
        <SegRow
          options={CAPTION_POSITIONS}
          value={capPosition}
          onPick={value => onStyle({ capPosition: value })}
        />
      </Field>
      {canApplyLane ? (
        <button
          type="button"
          className={ics.applyAllBtn}
          title="Set every text clip in this lane to this position (one undo)"
          onClick={() => onApplyLane?.('capPosition')}
        >
          Apply position to all {laneTextCount} clips in lane
        </button>
      ) : null}
      {/* Karaoke state indicator: karaoke only animates word-by-word when the
          clip carries `words` (generated captions do). */}
      {karaokeActive ? (
        <div className={ics.stateChip}>
          <span
            className={ics.stateDot}
            style={{
              background: hasWords
                ? 'var(--vdz-accent, #5b8cff)'
                : 'var(--vdz-muted, #8b93a7)',
            }}
            aria-hidden="true"
          />
          {hasWords
            ? `Karaoke ready — ${clip.words?.length ?? 0} word timings`
            : 'Karaoke set, but no word timings — renders as Boxed. Generate captions to add timings.'}
        </div>
      ) : null}
    </>
  );
}

/**
 * One-click effect presets for video / image clips. Each chip replaces the
 * clip's whole effect stack via `setEffects`; the `none` preset clears them.
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
            style={active ? activePillStyle : inactivePillStyle}
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
 * committed as a single undoable batch.
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
 * The no-selection PROJECT panel: canvas ratio presets + custom W×H inputs
 * (both committing via the EXISTING setCanvas op), plus read-only fps and the
 * computed total duration (contract C1). Replaces the old empty hint.
 */
function ProjectSection({
  timeline,
  onOp,
  closed,
  onToggle,
}: {
  timeline: VdzTimeline;
  onOp: (op: VdzOp) => void;
  closed: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const width = timeline.width;
  const height = timeline.height;
  const aspect = width > 0 && height > 0 ? width / height : 0;

  // Nearest preset within tolerance, else "Custom" (mirrors the toolbar picker).
  const matchId = useMemo(() => {
    if (aspect <= 0) return null;
    let best = Infinity;
    let hit: string | null = null;
    for (const preset of VDZ_RATIO_PRESETS) {
      const presetAspect = preset.width / preset.height;
      const delta = Math.abs(presetAspect - aspect) / presetAspect;
      if (delta < best) {
        best = delta;
        hit = preset.id;
      }
    }
    return best > RATIO_MATCH_TOLERANCE ? null : hit;
  }, [aspect]);

  const totalDuration = useMemo(
    () => computeTotalDuration(timeline),
    [timeline]
  );
  const clipCount = useMemo(
    () => timeline.tracks.reduce((n, t) => n + t.clips.length, 0),
    [timeline]
  );

  // Commit custom dimensions: clamp to [320,4096] and round to an EVEN integer
  // (encoders want even dimensions). Only fire setCanvas when something changed.
  const commitDim = useCallback(
    (nextW: number, nextH: number) => {
      const evenClamp = (n: number) => {
        const c = clamp(Math.round(n), CANVAS_MIN, CANVAS_MAX);
        return c % 2 === 0 ? c : Math.min(CANVAS_MAX, c + 1);
      };
      const w = evenClamp(nextW);
      const h = evenClamp(nextH);
      if (w === width && h === height) return;
      onOp({ op: 'setCanvas', width: w, height: h });
    },
    [width, height, onOp]
  );

  return (
    <div className={styles.inspStack}>
      <div className={ics.projectHeader}>
        {timeline.name || 'Untitled project'}
        <span className={styles.inspClipType}>project</span>
      </div>
      <div className={styles.inspEmptyHint}>
        No clip selected. Set the canvas here, or click a clip in the timeline to
        edit it.
      </div>

      {/* ---- Canvas ratio presets ---- */}
      <Section
        id="proj-canvas"
        title="Canvas"
        closed={closed}
        onToggle={onToggle}
      >
        <Field label="Aspect ratio">
          <div className={ics.ratioGrid}>
            {VDZ_RATIO_PRESETS.map(preset => {
              const active = matchId === preset.id;
              // Proportional glyph, longest side fixed at 20px.
              const long = 20;
              const wide = preset.width >= preset.height;
              const gw = wide
                ? long
                : Math.max(5, Math.round((preset.width / preset.height) * long));
              const gh = wide
                ? Math.max(5, Math.round((preset.height / preset.width) * long))
                : long;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={ics.ratioBtn}
                  data-active={active}
                  aria-pressed={active}
                  title={`${preset.label} · ${preset.width}×${preset.height}`}
                  onClick={() =>
                    onOp({
                      op: 'setCanvas',
                      width: preset.width,
                      height: preset.height,
                    })
                  }
                >
                  <span
                    className={ics.ratioGlyph}
                    style={{ width: gw, height: gh }}
                    aria-hidden="true"
                  />
                  <span className={ics.ratioLabel}>{preset.id}</span>
                  <span className={ics.ratioSub}>{preset.label}</span>
                </button>
              );
            })}
          </div>
        </Field>

        {/* ---- Custom W×H ---- */}
        <Field label="Custom size (px, even 320–4096)">
          <div className={ics.dimRow}>
            <ScrubField
              value={width}
              min={CANVAS_MIN}
              max={CANVAS_MAX}
              step={2}
              precision={0}
              unit="w"
              ariaLabel="Canvas width (pixels)"
              onCommit={w => commitDim(w, height)}
            />
            <span className={ics.dimTimes} aria-hidden="true">
              ×
            </span>
            <ScrubField
              value={height}
              min={CANVAS_MIN}
              max={CANVAS_MAX}
              step={2}
              precision={0}
              unit="h"
              ariaLabel="Canvas height (pixels)"
              onCommit={h => commitDim(width, h)}
            />
          </div>
        </Field>
      </Section>

      {/* ---- Read-only project facts ---- */}
      <Section
        id="proj-info"
        title="Project"
        closed={closed}
        onToggle={onToggle}
      >
        <div className={ics.readonlyLine}>
          <span>Frame rate</span>
          <span className={ics.readonlyValue}>{timeline.fps} fps</span>
        </div>
        <div className={ics.readonlyLine}>
          <span>Total duration</span>
          <span className={ics.readonlyValue}>
            {fmtDuration(totalDuration)} ({totalDuration.toFixed(2)}s)
          </span>
        </div>
        <div className={ics.readonlyLine}>
          <span>Clips</span>
          <span className={ics.readonlyValue}>{clipCount}</span>
        </div>
      </Section>
    </div>
  );
}

/**
 * The clip inspector — a professional, scannable properties panel.
 *
 * With a single clip selected it shows only the sections relevant to that
 * clip's kind: Transform, Timing, Appearance, Audio, Text & Captions, Animation
 * & Effects, plus a raw-JSON escape hatch — every section collapsible and its
 * open/closed state persisted in-memory across selections. With nothing
 * selected it shows the Project panel (canvas + fps + total duration); with a
 * multi-selection it shows a batch-action hint.
 *
 * Every mutation emits ops through `onOp`/`onOps` — the same validated history
 * path the toolbar and lanes use. The component holds no timeline state of its
 * own (only ephemeral input drafts + section open/closed state).
 */
export function Inspector({
  clip,
  trackId,
  selectedCount = 0,
  onOp,
  timeline,
  onOps,
}: InspectorProps) {
  const [rawOpen, setRawOpen] = useState(false);
  // Section open/closed set: persists across selection changes (in-memory).
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
      if (!clip || !trackId) return;
      onOp({ op: 'updateClip', trackId, clipId: clip.id, patch: p });
    },
    [onOp, trackId, clip]
  );

  // ---- Visual style (setClipStyle) --------------------------------------
  // Opacity / rotation / caption preset+position. Sends ONLY changed fields.
  const setClipStyle = useCallback(
    (changes: {
      opacity?: number;
      rotation?: number;
      capPreset?: CapPreset;
      capPosition?: CapPosition;
    }) => {
      if (!clip || !trackId) return;
      onOp({ op: 'setClipStyle', trackId, clipId: clip.id, ...changes });
    },
    [onOp, trackId, clip]
  );

  // ---- Apply a caption field to EVERY text clip in this lane (one undo) ----
  const applyCaptionToLane = useCallback(
    (field: 'capPreset' | 'capPosition') => {
      if (!clip || !trackId || clip.type !== 'text' || !onOps) return;
      const track = timeline.tracks.find(t => t.id === trackId);
      if (!track) return;
      const value =
        field === 'capPreset'
          ? (clip.capPreset ?? 'plain')
          : (clip.capPosition ?? 'lower');
      const ops: VdzOp[] = [];
      for (const c of track.clips) {
        if (c.type !== 'text') continue;
        ops.push({
          op: 'setClipStyle',
          trackId,
          clipId: c.id,
          [field]: value,
        } as VdzOp);
      }
      if (ops.length > 0) onOps(ops);
    },
    [clip, trackId, timeline, onOps]
  );

  // ---- Quick actions ------------------------------------------------------
  const duplicateClip = useCallback(() => {
    if (!clip || !trackId) return;
    const copy = JSON.parse(JSON.stringify(clip)) as VdzClip;
    copy.id = `clip-${nanoid(6)}`;
    copy.start = round3(clip.start + clip.duration);
    onOp({ op: 'addClip', trackId, clip: copy });
  }, [clip, trackId, onOp]);

  const deleteClip = useCallback(() => {
    if (!clip || !trackId) return;
    onOp({ op: 'removeClip', trackId, clipId: clip.id });
  }, [onOp, trackId, clip]);

  const rippleDeleteClip = useCallback(() => {
    if (!clip || !trackId) return;
    onOp({ op: 'rippleDelete', trackId, clipId: clip.id });
  }, [onOp, trackId, clip]);

  // ---- Animation (setAnimation) -----------------------------------------
  const anim: VdzAnimation = clip?.animation ?? {};

  const setAnimSide = useCallback(
    (side: 'in' | 'out', kind: VdzAnimationKind | '') => {
      if (!clip || !trackId) return;
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
    [anim, onOp, trackId, clip]
  );

  const setAnimDuration = useCallback(
    (side: 'in' | 'out', duration: number) => {
      if (!clip || !trackId) return;
      const current = anim[side];
      if (!current) return;
      const nextAnim: VdzAnimation = {
        ...anim,
        [side]: { kind: current.kind, duration },
      };
      onOp({ op: 'setAnimation', trackId, clipId: clip.id, animation: nextAnim });
    },
    [anim, onOp, trackId, clip]
  );

  // ---- Effects (setEffects) ---------------------------------------------
  const effects: VdzEffect[] = clip?.effects ?? [];

  const addEffect = useCallback(
    (kind: VdzEffectKind) => {
      if (!clip || !trackId) return;
      onOp({
        op: 'setEffects',
        trackId,
        clipId: clip.id,
        effects: [...effects, { kind, amount: DEFAULT_EFFECT_AMOUNT }],
      });
    },
    [effects, onOp, trackId, clip]
  );

  const setEffectAmount = useCallback(
    (index: number, amount: number) => {
      if (!clip || !trackId) return;
      const nextEffects = effects.map((e, i) =>
        i === index ? { ...e, amount } : e
      );
      onOp({ op: 'setEffects', trackId, clipId: clip.id, effects: nextEffects });
    },
    [effects, onOp, trackId, clip]
  );

  const removeEffect = useCallback(
    (index: number) => {
      if (!clip || !trackId) return;
      const nextEffects = effects.filter((_, i) => i !== index);
      onOp({ op: 'setEffects', trackId, clipId: clip.id, effects: nextEffects });
    },
    [effects, onOp, trackId, clip]
  );

  const clearEffects = useCallback(() => {
    if (!clip || !trackId) return;
    onOp({ op: 'setEffects', trackId, clipId: clip.id, effects: [] });
  }, [onOp, trackId, clip]);

  // Count of text clips sharing the selected clip's lane (for apply-to-lane).
  const laneTextCount = useMemo(() => {
    if (!clip || !trackId || clip.type !== 'text') return 0;
    const track = timeline.tracks.find(t => t.id === trackId);
    if (!track) return 0;
    return track.clips.reduce((n, c) => (c.type === 'text' ? n + 1 : n), 0);
  }, [clip, trackId, timeline]);

  // ---- No selection → Project panel; multi-select → hint ----------------
  if (!clip || !trackId) {
    if (selectedCount > 1) {
      return (
        <div className={styles.inspectorHint}>
          {selectedCount} clips selected. Delete / ripple-delete act on the whole
          selection; click a single clip to inspect and edit its properties.
        </div>
      );
    }
    return (
      <ProjectSection
        timeline={timeline}
        onOp={onOp}
        closed={closedSections}
        onToggle={toggleSection}
      />
    );
  }

  const isVisual = clip.type !== 'audio';
  const hasAudio = clip.type === 'video' || clip.type === 'audio';
  const animCount = (anim.in ? 1 : 0) + (anim.out ? 1 : 0);

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

      {/* ---- Transform (visual clips only: opacity + rotation) ---- */}
      {isVisual ? (
        <Section
          id="transform"
          title="Transform"
          closed={closedSections}
          onToggle={toggleSection}
        >
          <TransformRows
            key={`transform-${clip.id}`}
            clip={clip}
            onStyle={setClipStyle}
          />
        </Section>
      ) : null}

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

      {/* ---- Appearance (kind-specific color / geometry / fit) ---- */}
      {clip.type === 'text' || clip.type === 'shape' || clip.type === 'image' ? (
        <Section
          id="appearance"
          title="Appearance"
          closed={closedSections}
          onToggle={toggleSection}
        >
          {clip.type === 'text' ? (
            <>
              <Field label="Text">
                <textarea
                  className={styles.inspTextarea}
                  aria-label="Text content"
                  value={clip.text}
                  rows={2}
                  onChange={e => patch({ text: e.target.value })}
                />
              </Field>
              <RangeField
                label={`Size ${((clip.fontSize ?? DEFAULT_FONT_SIZE) * 100).toFixed(0)}%`}
                value={clip.fontSize ?? DEFAULT_FONT_SIZE}
                min={0.02}
                max={0.3}
                step={0.005}
                defaultValue={DEFAULT_FONT_SIZE}
                format={v => `${(v * 100).toFixed(0)}%`}
                ariaLabel="Font size"
                onChange={v => patch({ fontSize: v })}
              />
              <ColorRow
                value={clip.color}
                fallback="#ffffff"
                onColor={color => patch({ color })}
              />
              <div className={styles.inspRow}>
                <RangeField
                  label={`X ${((clip.x ?? 0.5) * 100).toFixed(0)}%`}
                  value={clip.x ?? 0.5}
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={0.5}
                  format={v => `${(v * 100).toFixed(0)}%`}
                  ariaLabel="Horizontal position"
                  onChange={v => patch({ x: v })}
                />
                <RangeField
                  label={`Y ${((clip.y ?? 0.5) * 100).toFixed(0)}%`}
                  value={clip.y ?? 0.5}
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={0.5}
                  format={v => `${(v * 100).toFixed(0)}%`}
                  ariaLabel="Vertical position"
                  onChange={v => patch({ y: v })}
                />
              </div>
              <Field label="Align">
                <SegRow
                  options={[
                    { value: 'left', label: 'Left' },
                    { value: 'center', label: 'Center' },
                    { value: 'right', label: 'Right' },
                  ]}
                  value={clip.align ?? 'center'}
                  onPick={value => patch({ align: value })}
                />
              </Field>
            </>
          ) : null}

          {clip.type === 'shape' ? (
            <>
              <div className={ics.readonlyLine}>
                <span>Shape</span>
                <span className={ics.readonlyValue}>{clip.shape}</span>
              </div>
              <ColorRow
                value={clip.color}
                fallback="#5b8cff"
                onColor={color => patch({ color })}
              />
              <div className={styles.inspRow}>
                <RangeField
                  label={`X ${((clip.x ?? 0) * 100).toFixed(0)}%`}
                  value={clip.x ?? 0}
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={0}
                  format={v => `${(v * 100).toFixed(0)}%`}
                  ariaLabel="Horizontal position"
                  onChange={v => patch({ x: v })}
                />
                <RangeField
                  label={`Y ${((clip.y ?? 0) * 100).toFixed(0)}%`}
                  value={clip.y ?? 0}
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={0}
                  format={v => `${(v * 100).toFixed(0)}%`}
                  ariaLabel="Vertical position"
                  onChange={v => patch({ y: v })}
                />
              </div>
              <div className={styles.inspRow}>
                <RangeField
                  label={`W ${((clip.w ?? 1) * 100).toFixed(0)}%`}
                  value={clip.w ?? 1}
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={1}
                  format={v => `${(v * 100).toFixed(0)}%`}
                  ariaLabel="Width"
                  onChange={v => patch({ w: v })}
                />
                <RangeField
                  label={`H ${((clip.h ?? 1) * 100).toFixed(0)}%`}
                  value={clip.h ?? 1}
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={1}
                  format={v => `${(v * 100).toFixed(0)}%`}
                  ariaLabel="Height"
                  onChange={v => patch({ h: v })}
                />
              </div>
            </>
          ) : null}

          {clip.type === 'image' ? (
            <Field label="Fit">
              <SegRow
                options={[
                  { value: 'cover', label: 'Cover' },
                  { value: 'contain', label: 'Contain' },
                ]}
                value={clip.fit ?? 'cover'}
                onPick={value => patch({ fit: value })}
              />
            </Field>
          ) : null}
        </Section>
      ) : null}

      {/* ---- Audio (volume for video/audio; fades + duck for audio) ---- */}
      {hasAudio ? (
        <Section
          id="audio"
          title="Audio"
          closed={closedSections}
          onToggle={toggleSection}
        >
          <VolumeRow
            volume={clip.volume ?? 1}
            onVolume={volume => patch({ volume })}
          />
          {clip.type === 'audio' ? (
            <>
              <div className={styles.inspRow}>
                <RangeField
                  label={`Fade in ${(clip.fadeIn ?? 0).toFixed(1)}s`}
                  value={clip.fadeIn ?? 0}
                  min={0}
                  max={3}
                  step={0.1}
                  defaultValue={0}
                  format={v => `${v.toFixed(1)}s`}
                  ariaLabel="Fade in (seconds)"
                  onChange={v =>
                    onOp({
                      op: 'setAudioMix',
                      trackId,
                      clipId: clip.id,
                      // 0 clears the fade rather than storing a dead field.
                      fadeIn: v === 0 ? null : v,
                    })
                  }
                />
                <RangeField
                  label={`Fade out ${(clip.fadeOut ?? 0).toFixed(1)}s`}
                  value={clip.fadeOut ?? 0}
                  min={0}
                  max={3}
                  step={0.1}
                  defaultValue={0}
                  format={v => `${v.toFixed(1)}s`}
                  ariaLabel="Fade out (seconds)"
                  onChange={v =>
                    onOp({
                      op: 'setAudioMix',
                      trackId,
                      clipId: clip.id,
                      fadeOut: v === 0 ? null : v,
                    })
                  }
                />
              </div>
              <Field label="Duck other audio while this plays">
                <input
                  type="checkbox"
                  aria-label="Duck other audio"
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
            </>
          ) : null}
        </Section>
      ) : null}

      {/* ---- Text & Captions (text clips only) ---- */}
      {clip.type === 'text' ? (
        <Section
          id="captions"
          title="Text & Captions"
          closed={closedSections}
          onToggle={toggleSection}
        >
          <CaptionStyleRows
            key={`capstyle-${clip.id}`}
            clip={clip}
            onStyle={setClipStyle}
            laneTextCount={laneTextCount}
            onApplyLane={onOps ? applyCaptionToLane : undefined}
          />
        </Section>
      ) : null}

      {/* ---- Captions generator (audio clips only): transcribe → text ---- */}
      {clip.type === 'audio' ? (
        <Section
          id="gencaptions"
          title="Captions"
          closed={closedSections}
          onToggle={toggleSection}
        >
          <CaptionTools clip={clip} timeline={timeline} onOps={onOps} />
        </Section>
      ) : null}

      {/* ---- Animation & Effects ---- */}
      <Section
        id="animation"
        title="Animation"
        count={animCount}
        closed={closedSections}
        onToggle={toggleSection}
      >
        <div className={styles.inspRow}>
          <Field label="In">
            <select
              className={styles.inspSelect}
              aria-label="Entrance animation"
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
          <RangeField
            label={`In ${(anim.in?.duration ?? DEFAULT_ANIM_DURATION).toFixed(1)}s`}
            value={anim.in?.duration ?? DEFAULT_ANIM_DURATION}
            min={0.1}
            max={2}
            step={0.1}
            format={v => `${v.toFixed(1)}s`}
            ariaLabel="Entrance duration (seconds)"
            disabled={!anim.in}
            onChange={v => setAnimDuration('in', v)}
          />
        </div>
        <div className={styles.inspRow}>
          <Field label="Out">
            <select
              className={styles.inspSelect}
              aria-label="Exit animation"
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
          <RangeField
            label={`Out ${(anim.out?.duration ?? DEFAULT_ANIM_DURATION).toFixed(1)}s`}
            value={anim.out?.duration ?? DEFAULT_ANIM_DURATION}
            min={0.1}
            max={2}
            step={0.1}
            format={v => `${v.toFixed(1)}s`}
            ariaLabel="Exit duration (seconds)"
            disabled={!anim.out}
            onChange={v => setAnimDuration('out', v)}
          />
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

      {/* ---- Effects (manual stack) ---- */}
      {isVisual ? (
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
                <div className={ics.rangeWrap}>
                  <input
                    type="range"
                    className={styles.inspRange}
                    aria-label={`${effect.kind} amount`}
                    min={0}
                    max={1}
                    step={0.01}
                    value={effect.amount}
                    onChange={e => setEffectAmount(i, Number(e.target.value))}
                  />
                </div>
                <span className={ics.pctBadge}>
                  {Math.round(effect.amount * 100)}%
                </span>
                <button
                  type="button"
                  className={styles.inspIconButton}
                  title="Remove effect"
                  aria-label={`Remove ${effect.kind}`}
                  onClick={() => removeEffect(i)}
                >
                  ✕
                </button>
              </div>
            ))
          )}
          <select
            className={styles.inspSelect}
            aria-label="Add effect"
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
      ) : null}

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
