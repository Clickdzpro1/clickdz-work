import { useCallback, useState } from 'react';

import type { VdzTimeline } from '../../../../modules/vdz';
import {
  useVdzRepurpose,
  type VdzShort,
} from '../../../../modules/vdz/use-vdz-repurpose';
import { formatTimecode } from './constants';
import * as styles from './index.css';
import { VdzPanel } from './vdz-panel';

/**
 * AI Shorts panel — long→short repurposing surface (C6, consumes VDZ-BE C2).
 *
 * A THIN driver over {@link useVdzRepurpose} (mirrors the Inspector / Transcript
 * / Effects panels: it holds no timeline state, only the current suggestion
 * list + which card is mid-create):
 *
 *   · Analyze → gather the project's transcript + duration and ask the planner
 *     for ranked short windows. A spinner runs while it's in flight; empty /
 *     error states read friendly.
 *   · Each result is a card — title, hook, a 0..1 score bar, the in→out window
 *     and its duration — with two actions:
 *       – Preview → seek the main preview to the short's start (scrub in place).
 *       – Create short → clone the timeline windowed to the range, switch it to
 *         9:16 and save it as a NEW project, then open it in the editor.
 *
 * DEGRADE WITHOUT A TRANSCRIPT: analyze still runs on timing alone; when no clip
 * had a cached transcript the panel shows a "transcribe first for sharper picks"
 * note above the results (the picks are looser, so we tell the user why).
 *
 * All network + windowing lives in the hook; this file is presentation only, so
 * it never touches the frozen schema/ops.
 */

interface ShortCardProps {
  short: VdzShort;
  index: number;
  /** The playhead currently sits inside this short's window. */
  active: boolean;
  /** true while THIS card's short is being created. */
  creating: boolean;
  /** Any card is mid-create (disables the others so we never double-post). */
  busy: boolean;
  onPreview: (short: VdzShort) => void;
  onCreate: (short: VdzShort) => void;
}

/** Clamp a score into 0..1 for the bar width (planner scores are 0..1). */
function scorePct(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score)) * 100;
}

const ShortCard = function ShortCard({
  short,
  index,
  active,
  creating,
  busy,
  onPreview,
  onCreate,
}: ShortCardProps) {
  const duration = Math.max(0, short.endSec - short.startSec);
  return (
    <div style={cardStyle(active)} data-active={active}>
      <div style={cardHeadStyle}>
        <span style={rankStyle} aria-hidden="true">
          {index + 1}
        </span>
        <span style={cardTitleStyle} title={short.title}>
          {short.title || `Short ${index + 1}`}
        </span>
        <span style={cardDurStyle}>{duration.toFixed(1)}s</span>
      </div>

      {short.hook ? <div style={hookStyle}>“{short.hook}”</div> : null}

      {/* Score bar — the planner's 0..1 confidence, as a filled track. */}
      <div style={scoreRowStyle}>
        <span style={scoreLabelStyle}>Score</span>
        <span style={scoreTrackStyle} aria-hidden="true">
          <span style={scoreFillStyle(scorePct(short.score))} />
        </span>
        <span style={scoreNumStyle}>{Math.round(scorePct(short.score))}</span>
      </div>

      <div style={rangeStyle}>
        <span style={rangeChipStyle}>{formatTimecode(short.startSec)}</span>
        <span style={rangeArrowStyle} aria-hidden="true">
          →
        </span>
        <span style={rangeChipStyle}>{formatTimecode(short.endSec)}</span>
      </div>

      <div style={cardActionsStyle}>
        <button
          type="button"
          style={previewBtnStyle}
          onClick={() => onPreview(short)}
          disabled={busy}
          title="Seek the preview to this short's start"
        >
          ▶ Preview
        </button>
        <button
          type="button"
          style={createBtnStyle(creating)}
          onClick={() => onCreate(short)}
          disabled={busy}
          aria-busy={creating}
          title="Create a new 9:16 short project from this range"
        >
          {creating ? (
            <>
              <span style={spinnerStyle} aria-hidden="true" />
              Creating…
            </>
          ) : (
            '✦ Create short'
          )}
        </button>
      </div>
    </div>
  );
};

export interface ShortsPanelProps {
  /** The whole working timeline (analyzed + windowed into shorts). */
  timeline: VdzTimeline;
  /** Playhead position (seconds) — lights up the card whose range holds it. */
  playheadSeconds: number;
  /**
   * The current project's name — the created short is named
   * `${projectName} — ${short.title}`. Defaults from `timeline.name`.
   */
  projectName: string;
  /** Seek the main preview (Preview action). */
  onSeek: (seconds: number) => void;
  /**
   * Open a timeline as a fresh working project (the SAME baseline path the
   * ProjectBar's Open uses) — called with the freshly-created short so it opens
   * in the editor right after it's saved.
   */
  onOpenTimeline: (timeline: VdzTimeline) => void;
  onCollapse: () => void;
}

export function ShortsPanel({
  timeline,
  playheadSeconds,
  projectName,
  onSeek,
  onOpenTimeline,
  onCollapse,
}: ShortsPanelProps) {
  const { analyzing, creating, error, analyze, createShort, clearError } =
    useVdzRepurpose();
  const [shorts, setShorts] = useState<VdzShort[] | null>(null);
  const [sparse, setSparse] = useState(false);
  // Which short is mid-create (by index) so only that card spins.
  const [creatingIndex, setCreatingIndex] = useState<number | null>(null);

  const onAnalyze = useCallback(async () => {
    clearError();
    try {
      const result = await analyze(timeline);
      setShorts(result.shorts);
      setSparse(!result.hadTranscript);
    } catch {
      // `error` is already set by the hook; keep any prior results visible.
    }
  }, [analyze, timeline, clearError]);

  const onPreview = useCallback(
    (short: VdzShort) => onSeek(short.startSec),
    [onSeek]
  );

  const onCreate = useCallback(
    async (short: VdzShort) => {
      if (!shorts) return;
      const index = shorts.indexOf(short);
      setCreatingIndex(index);
      try {
        const created = await createShort(
          timeline,
          short,
          projectName || timeline.name
        );
        // Open the new short as a fresh working project (same path as Open).
        onOpenTimeline(created.timeline);
      } catch {
        // `error` is already set by the hook.
      } finally {
        setCreatingIndex(null);
      }
    },
    [shorts, createShort, timeline, projectName, onOpenTimeline]
  );

  const hasResults = shorts !== null && shorts.length > 0;

  return (
    <VdzPanel
      title="AI Shorts"
      icon="✂"
      data-testid="vdz-shorts"
      onCollapse={onCollapse}
      accessory={
        hasResults ? (
          <span style={countBadgeStyle}>{shorts.length}</span>
        ) : undefined
      }
      bodyClassName={styles.inspectorBody}
    >
      {/* Keyframes for the inline spinners (scoped, boot-safe, no new deps;
          honors reduced-motion). */}
      <style>{SPINNER_KEYFRAMES}</style>

      <div style={introStyle}>
        Turn this project into vertical shorts. Analyze finds the strongest
        moments; “Create short” builds a 9:16 project from any pick.
      </div>

      <button
        type="button"
        style={analyzeBtnStyle(analyzing)}
        onClick={onAnalyze}
        disabled={analyzing}
        aria-busy={analyzing}
        data-testid="vdz-shorts-analyze"
      >
        {analyzing ? (
          <>
            <span style={spinnerStyle} aria-hidden="true" />
            Analyzing…
          </>
        ) : shorts ? (
          '↻ Re-analyze'
        ) : (
          '✦ Analyze project'
        )}
      </button>

      {error ? (
        <div style={errorStyle} role="alert">
          {error}
        </div>
      ) : null}

      {sparse && hasResults ? (
        <div style={noteStyle}>
          No transcript found, so these picks use timing only.{' '}
          <b>Transcribe your clips</b> (Transcript panel) for sharper,
          hook-aware suggestions.
        </div>
      ) : null}

      {analyzing && !hasResults ? (
        <div style={loadingStyle}>
          <span style={spinnerLgStyle} aria-hidden="true" />
          <span>Scoring the timeline for short-worthy moments…</span>
        </div>
      ) : hasResults ? (
        <div style={listStyle}>
          {shorts.map((short, i) => (
            <ShortCard
              key={`${i}:${short.startSec}:${short.endSec}`}
              short={short}
              index={i}
              active={
                playheadSeconds >= short.startSec &&
                playheadSeconds < short.endSec
              }
              creating={creatingIndex === i}
              busy={creating}
              onPreview={onPreview}
              onCreate={onCreate}
            />
          ))}
        </div>
      ) : shorts && shorts.length === 0 ? (
        <div style={emptyStyle}>
          No short-worthy segments were found. Try adding more footage or
          transcribing your clips first.
        </div>
      ) : !error ? (
        <div style={emptyStyle}>
          Click <b>Analyze project</b> to get ranked short suggestions from your
          timeline.
        </div>
      ) : null}
    </VdzPanel>
  );
}

// ---- Inline styles -------------------------------------------------------
// Small, new UI → inline styles (per house rules), painted with the studio's
// themed `--vdz-*` custom properties so cdz themes + light mode flow in and the
// default dark "Midnight" fallbacks match every other panel.

const introStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--vdz-muted, #8b93a7)',
  paddingBottom: 8,
};

const countBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 18,
  height: 18,
  padding: '0 5px',
  borderRadius: 999,
  background: 'color-mix(in srgb, var(--vdz-accent, #5b8cff) 20%, transparent)',
  color: 'var(--vdz-accent, #5b8cff)',
  fontSize: 11,
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
};

function analyzeBtnStyle(busy: boolean): React.CSSProperties {
  return {
    appearance: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '9px 12px',
    borderRadius: 8,
    border: '1px solid var(--vdz-accent, #5b8cff)',
    background: busy
      ? 'color-mix(in srgb, var(--vdz-accent, #5b8cff) 22%, var(--vdz-panel, #12151d))'
      : 'var(--vdz-accent, #5b8cff)',
    color: busy ? 'var(--vdz-text, #e6e9f2)' : '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: busy ? 'default' : 'pointer',
    transition: 'background 150ms ease, opacity 150ms ease',
  };
}

const errorStyle: React.CSSProperties = {
  marginTop: 10,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid color-mix(in srgb, #ff6b6b 45%, var(--vdz-border, #232838))',
  background: 'color-mix(in srgb, #ff6b6b 12%, var(--vdz-bg, #0b0d12))',
  color: 'var(--vdz-text, #e6e9f2)',
  fontSize: 12,
  lineHeight: 1.45,
};

const noteStyle: React.CSSProperties = {
  marginTop: 10,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--vdz-border, #232838)',
  background: 'color-mix(in srgb, var(--vdz-accent, #5b8cff) 8%, var(--vdz-bg, #0b0d12))',
  color: 'var(--vdz-muted, #8b93a7)',
  fontSize: 11.5,
  lineHeight: 1.45,
};

const loadingStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginTop: 16,
  padding: '4px 2px',
  color: 'var(--vdz-muted, #8b93a7)',
  fontSize: 12.5,
  lineHeight: 1.45,
};

const emptyStyle: React.CSSProperties = {
  marginTop: 14,
  color: 'var(--vdz-muted, #8b93a7)',
  fontSize: 12.5,
  lineHeight: 1.5,
};

const listStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  marginTop: 12,
};

function cardStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '10px 11px',
    borderRadius: 10,
    border: active
      ? '1px solid var(--vdz-accent, #5b8cff)'
      : '1px solid var(--vdz-border, #232838)',
    background: active
      ? 'color-mix(in srgb, var(--vdz-accent, #5b8cff) 12%, var(--vdz-panel, #12151d))'
      : 'var(--vdz-panel, #12151d)',
    transition: 'background 150ms ease, border-color 150ms ease',
  };
}

const cardHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const rankStyle: React.CSSProperties = {
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  borderRadius: 6,
  background: 'color-mix(in srgb, var(--vdz-accent, #5b8cff) 20%, transparent)',
  color: 'var(--vdz-accent, #5b8cff)',
  fontSize: 11,
  fontWeight: 700,
};

const cardTitleStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--vdz-text, #e6e9f2)',
};

const cardDurStyle: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--vdz-muted, #8b93a7)',
  fontVariantNumeric: 'tabular-nums',
};

const hookStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  fontStyle: 'italic',
  color: 'var(--vdz-muted, #8b93a7)',
};

const scoreRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const scoreLabelStyle: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--vdz-muted, #8b93a7)',
  flexShrink: 0,
};

const scoreTrackStyle: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  height: 6,
  borderRadius: 999,
  background: 'color-mix(in srgb, var(--vdz-border, #232838) 70%, transparent)',
  overflow: 'hidden',
};

function scoreFillStyle(pct: number): React.CSSProperties {
  return {
    position: 'absolute',
    inset: 0,
    width: `${pct}%`,
    borderRadius: 999,
    background: 'var(--vdz-accent, #5b8cff)',
    transition: 'width 200ms ease',
  };
}

const scoreNumStyle: React.CSSProperties = {
  flexShrink: 0,
  width: 22,
  textAlign: 'right',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--vdz-text, #e6e9f2)',
  fontVariantNumeric: 'tabular-nums',
};

const rangeStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const rangeChipStyle: React.CSSProperties = {
  padding: '2px 7px',
  borderRadius: 6,
  background: 'var(--vdz-bg, #0b0d12)',
  border: '1px solid var(--vdz-border, #232838)',
  fontSize: 11,
  color: 'var(--vdz-text, #e6e9f2)',
  fontVariantNumeric: 'tabular-nums',
};

const rangeArrowStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--vdz-muted, #8b93a7)',
};

const cardActionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 2,
};

const previewBtnStyle: React.CSSProperties = {
  appearance: 'none',
  flex: '0 0 auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '6px 10px',
  borderRadius: 7,
  border: '1px solid var(--vdz-border, #232838)',
  background: 'var(--vdz-bg, #0b0d12)',
  color: 'var(--vdz-text, #e6e9f2)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'background 120ms ease, border-color 120ms ease',
};

function createBtnStyle(creating: boolean): React.CSSProperties {
  return {
    appearance: 'none',
    flex: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '6px 10px',
    borderRadius: 7,
    border: '1px solid var(--vdz-accent, #5b8cff)',
    background: creating
      ? 'color-mix(in srgb, var(--vdz-accent, #5b8cff) 22%, var(--vdz-panel, #12151d))'
      : 'color-mix(in srgb, var(--vdz-accent, #5b8cff) 16%, var(--vdz-panel, #12151d))',
    color: 'var(--vdz-text, #e6e9f2)',
    fontSize: 12,
    fontWeight: 600,
    cursor: creating ? 'default' : 'pointer',
    transition: 'background 120ms ease',
  };
}

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 12,
  height: 12,
  borderRadius: '50%',
  border: '2px solid color-mix(in srgb, currentColor 30%, transparent)',
  borderTopColor: 'currentColor',
  animation: 'vdz-shorts-spin 0.7s linear infinite',
};

const spinnerLgStyle: React.CSSProperties = {
  ...spinnerStyle,
  width: 18,
  height: 18,
  flexShrink: 0,
  color: 'var(--vdz-accent, #5b8cff)',
};

// Injected once per mount; scoped by a unique animation name. `prefers-reduced-
// motion` freezes the ring (opacity fallback) so we honor the house rule.
const SPINNER_KEYFRAMES = `
@keyframes vdz-shorts-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  [style*="vdz-shorts-spin"] { animation: none !important; opacity: 0.6; }
}
`;
