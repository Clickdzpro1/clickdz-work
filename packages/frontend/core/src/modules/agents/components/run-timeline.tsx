// RunTimeline — the full-height vertical timeline of a durable background run.
// Renders an AgentStep[] as a rail of ToolCallCards (connectors between them),
// pulses the in-flight step while the run is `running`, surfaces a pending
// approval inline (ApprovalPrompt), caps the run with a terminal state banner
// (done / failed / stopped), and renders the final answer via MarkdownLite.
//
// PURE PRESENTATIONAL (R7 contract): all data + handlers arrive via props; this
// component never fetches. Scene mounts it in the single-run live view, feeding
// it straight from the durable `useAgentRunStream` hook
// ({ steps, state, finalText, pendingApproval, approve }).
//
// R8 (POLI): user-facing copy now flows through the agents i18n table via the
// `useAgentLang()` hook (FR default + Algerian darja; module-level listener so a
// language switch re-renders every mounted component at once). The exported
// props are UNCHANGED (RunTimeline / RunTimelineProps), so every Scene caller
// compiles + behaves identically at the default 'fr' language. RTL-safe: the
// rail flips for 'ar' but mixed technical content stays LTR inside the cards.

import type { AgentRunState, AgentStep } from '../types';
import { type TFunc, useAgentLang } from '../i18n';
import {
  ApprovalPrompt,
  type ApprovalRequest,
} from './approval-prompt';
import { MarkdownLite } from './markdown-lite';
import { AgentPalette as P, ensureAgentKeyframes } from './palette';
import { Spinner } from './primitives';
import { ToolCallCard } from './tool-call-card';

// Coarse lifecycle states that mean the run has stopped moving. Used to decide
// whether the last step should pulse and which banner (if any) to show.
const TERMINAL_STATES: ReadonlySet<AgentRunState> = new Set([
  'done',
  'failed',
  'stopped',
]);

interface BannerMeta {
  icon: string;
  label: string;
  color: string;
  bg: string;
  border: string;
}

// Banner label copy is language-aware: `t` resolves the terminal-state label
// (timeline.done / .failed / .stopped) — icons + colours stay in the component.
function bannerFor(state: AgentRunState, t: TFunc): BannerMeta | null {
  switch (state) {
    case 'done':
      return {
        icon: '✓',
        label: t('timeline.done'),
        color: P.color.okText,
        bg: P.color.okBg,
        border: P.color.okBorder,
      };
    case 'failed':
      return {
        icon: '✕',
        label: t('timeline.failed'),
        color: P.color.errText,
        bg: P.color.errBg,
        border: P.color.errBorder,
      };
    case 'stopped':
      return {
        icon: '■',
        label: t('timeline.stopped'),
        color: P.color.muted,
        bg: 'transparent',
        border: P.color.border,
      };
    default:
      return null;
  }
}

// One row of the rail: a left gutter (node dot + connector line) beside the
// step card. `first`/`last` trim the connector so it doesn't overhang the ends;
// `pulsing` animates the node for the in-flight step.
function TimelineRow({
  children,
  color,
  first,
  last,
  pulsing,
}: {
  children: React.ReactNode;
  color: string;
  first?: boolean;
  last?: boolean;
  pulsing?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
      <div
        aria-hidden="true"
        style={{
          position: 'relative',
          width: 14,
          flex: '0 0 auto',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        {/* connector line */}
        <span
          style={{
            position: 'absolute',
            top: first ? 14 : 0,
            bottom: last ? 'auto' : 0,
            height: last ? 14 : undefined,
            left: '50%',
            width: 2,
            transform: 'translateX(-50%)',
            background: P.color.border,
          }}
        />
        {/* node dot */}
        <span
          className={pulsing ? 'cdz-agent-motion' : undefined}
          style={{
            position: 'relative',
            marginTop: 13,
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: color,
            border: `2px solid ${P.color.bg}`,
            boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 20%, transparent)`,
            flex: '0 0 auto',
            animation: pulsing
              ? 'cdz-agent-pulse 1.4s ease-in-out infinite'
              : undefined,
          }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingBottom: 6 }}>{children}</div>
    </div>
  );
}

// Colour the rail node by step outcome (matches the card's border semantics).
function nodeColor(step: AgentStep): string {
  if (step.error || step.ok === false) return P.color.errText;
  if (step.ok === true) return P.color.okText;
  return P.color.accent;
}

export interface RunTimelineProps {
  /** Ordered step timeline (replayed history + live), from the run stream. */
  steps: AgentStep[];
  /** Coarse lifecycle state driving the pulse + terminal banner. */
  state: AgentRunState;
  /** The final synthesized answer, when the run has produced one. */
  finalText?: string;
  /** Resolve a pending approval — wired straight to the stream's `approve`. */
  onApprove?: (id: string, approved: boolean) => void;
  /** A pending approval to surface inline, or null/undefined when none. */
  pendingApproval?: ApprovalRequest | null;
  /** True while the run record is still being fetched (pre-stream). */
  loading?: boolean;
}

export function RunTimeline({
  steps,
  state,
  finalText,
  onApprove,
  pendingApproval,
  loading,
}: RunTimelineProps) {
  ensureAgentKeyframes();
  // Language-aware copy (FR default). The hook subscribes this component to the
  // module-level language so a toggle anywhere re-renders the whole timeline.
  const { t, dir } = useAgentLang();

  const running = state === 'running' || state === 'queued';
  const terminal = TERMINAL_STATES.has(state);
  const banner = bannerFor(state, t);
  const hasSteps = Array.isArray(steps) && steps.length > 0;

  // Index of the step that should pulse: the last step, while the run is live
  // and that step is itself unresolved (still executing).
  const lastIdx = hasSteps ? steps.length - 1 : -1;
  const lastStep = hasSteps ? steps[lastIdx] : undefined;
  const lastUnresolved =
    !!lastStep && lastStep.ok === undefined && !lastStep.error;
  const activeIdx = running && lastUnresolved ? lastIdx : -1;

  // ---- loading: run record not yet fetched ----
  if (loading && !hasSteps) {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          minHeight: 220,
          height: '100%',
          color: P.color.muted,
          padding: 24,
          boxSizing: 'border-box',
        }}
      >
        <Spinner size={18} />
        <span style={{ fontSize: P.font.size.md }}>{t('timeline.loading')}</span>
      </div>
    );
  }

  // ---- empty: no steps yet (queued / just started, nothing to show) ----
  if (!hasSteps && !finalText && !pendingApproval) {
    return (
      <div
        role="status"
        aria-live="polite"
        dir={dir}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          minHeight: 220,
          height: '100%',
          color: P.color.muted,
          padding: 24,
          boxSizing: 'border-box',
          textAlign: 'center',
        }}
      >
        {running ? (
          <>
            <Spinner size={18} />
            <span style={{ fontSize: P.font.size.md }}>
              {state === 'queued'
                ? t('timeline.queued')
                : t('timeline.starting')}
            </span>
          </>
        ) : banner ? (
          <>
            <span
              aria-hidden="true"
              style={{ fontSize: 26, color: banner.color }}
            >
              {banner.icon}
            </span>
            <span style={{ fontSize: P.font.size.md }}>
              {t('timeline.terminalNoSteps', { state: banner.label })}
            </span>
          </>
        ) : (
          <span style={{ fontSize: P.font.size.md }}>{t('timeline.noSteps')}</span>
        )}
      </div>
    );
  }

  return (
    <div
      className="cdz-agent-fade"
      dir={dir}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      {/* --- the step rail --- */}
      {hasSteps ? (
        <div
          role="list"
          aria-label={t('timeline.stepsLabel')}
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          {steps.map((step, idx) => (
            <div role="listitem" key={`${step.i}-${step.ts}-${idx}`}>
              <TimelineRow
                color={nodeColor(step)}
                first={idx === 0}
                last={idx === lastIdx && !running}
                pulsing={idx === activeIdx}
              >
                <ToolCallCard step={step} index={idx} active={idx === activeIdx} />
              </TimelineRow>
            </div>
          ))}

          {/* live "thinking about the next step" pulse: run still going but the
              last recorded step already resolved. */}
          {running && !lastUnresolved ? (
            <TimelineRow color={P.color.accent} last pulsing>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 12px',
                  borderRadius: P.radius.md,
                  border: `1px dashed ${P.color.border}`,
                  background: P.color.bg,
                  color: P.color.muted,
                  fontSize: P.font.size.md,
                }}
              >
                <Spinner size={13} />
                <span>{t('timeline.thinking')}</span>
              </div>
            </TimelineRow>
          ) : null}
        </div>
      ) : null}

      {/* --- pending approval (interrupt) --- */}
      {pendingApproval ? (
        <div style={{ marginTop: hasSteps ? 8 : 0 }}>
          <ApprovalPrompt
            request={pendingApproval}
            disabled={!onApprove}
            onDecide={(id, decision) => onApprove?.(id, decision === 'approve')}
          />
        </div>
      ) : null}

      {/* --- terminal state banner --- */}
      {banner ? (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginTop: 8,
            padding: '9px 14px',
            borderRadius: P.radius.md,
            border: `1px solid ${banner.border}`,
            background: banner.bg,
            color: banner.color,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 15 }}>
            {banner.icon}
          </span>
          <span
            style={{
              fontSize: P.font.size.md,
              fontWeight: 700,
              letterSpacing: '0.02em',
            }}
          >
            {banner.label}
          </span>
        </div>
      ) : null}

      {/* --- final answer --- */}
      {finalText ? (
        <div
          className="cdz-agent-fade"
          style={{
            marginTop: 10,
            padding: '14px 16px',
            borderRadius: P.radius.lg,
            border: `1px solid ${
              state === 'failed' ? P.color.errBorder : P.color.accentBorder
            }`,
            background: P.color.panelRaised,
          }}
        >
          <div
            style={{
              fontSize: P.font.size.xs,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: P.color.muted,
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span aria-hidden="true" style={{ color: P.color.accent }}>
              ✦
            </span>
            {t('timeline.finalAnswer')}
          </div>
          <MarkdownLite text={finalText} />
        </div>
      ) : null}
    </div>
  );
}
