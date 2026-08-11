import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  describeFlowError,
  type FlowDlqEntry,
  type FlowRun,
  type FlowRunStatus,
  type FlowRunStep,
  type FlowRunSummary,
} from '@affine/core/modules/integrations/use-flows';

// ---------------------------------------------------------------------------
// ClickDz flow-runs — the "Runs" tab of the Integrations page.
//
// Renders the per-user run history from GET /runs (summaries) + a detail view
// (GET /runs/:id) whose per-node timeline reuses the StepRow idiom from
// index.tsx (a collapsible row per step: tool name + status chip + a
// attempts/ms line + a <pre> preview). A failed run (status 'error' or
// 'partial', or one present in the DLQ) exposes a "Replay" button that POSTs
// /dlq/:runId/replay via the shared useFlows() hook (owned by index.tsx and
// threaded in as props — this view never fetches its own list, keeping one
// source of truth).
//
// Inline styles only (house rule), a dark palette matching the catalog chips,
// boot-safe emoji icons, and full empty / loading / error states.
// ---------------------------------------------------------------------------

// Dark palette — mirrors index.tsx's `C` so the two tabs read identically.
const C = {
  bg: 'var(--affine-background-primary-color, #141414)',
  panel: 'var(--affine-background-secondary-color, #1c1c1e)',
  border: 'var(--affine-border-color, #2a2a2c)',
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  accentSoft: 'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  warnBg: 'color-mix(in srgb, #e8a33d 12%, transparent)',
  warnBorder: 'color-mix(in srgb, #e8a33d 40%, transparent)',
  warnText: '#e8a33d',
  errBg: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 12%, transparent)',
  errBorder: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 40%, transparent)',
  errText: 'var(--affine-error-color, #eb4b4b)',
  okText: 'var(--affine-success-color, #4cae4c)',
  okBg: 'color-mix(in srgb, var(--affine-success-color, #4cae4c) 14%, transparent)',
  okBorder: 'color-mix(in srgb, var(--affine-success-color, #4cae4c) 40%, transparent)',
} as const;

const linkBtnStyle: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer',
  color: C.accent,
  textDecoration: 'underline',
};

// ---- props ----------------------------------------------------------------

export interface FlowRunsViewProps {
  runs: FlowRunSummary[];
  dlq: FlowDlqEntry[];
  loading: boolean;
  error: string | null;
  enabled: boolean;
  // Loaders / actions from the shared useFlows() instance in index.tsx.
  loadRuns: () => Promise<FlowRunSummary[]>;
  loadDlq: () => Promise<FlowDlqEntry[]>;
  getRun: (id: string) => Promise<FlowRun>;
  replay: (runId: string) => Promise<FlowRun>;
  // Resolve a flowId to a display name (index.tsx owns the flows list).
  flowName: (flowId: string) => string;
  // When set, auto-open this run's detail (used after a Run press hands us the
  // resulting run and switches to this tab).
  focusRunId?: string | null;
}

// ---- small helpers --------------------------------------------------------

function statusTone(status: FlowRunStatus): {
  color: string;
  bg: string;
  border: string;
  label: string;
} {
  switch (status) {
    case 'ok':
      return { color: C.okText, bg: C.okBg, border: C.okBorder, label: 'ok' };
    case 'running':
      return { color: C.accent, bg: C.accentSoft, border: C.border, label: 'running' };
    case 'partial':
      return { color: C.warnText, bg: C.warnBg, border: C.warnBorder, label: 'partial' };
    case 'error':
    default:
      return { color: C.errText, bg: C.errBg, border: C.errBorder, label: 'error' };
  }
}

function stepTone(status: FlowRunStep['status']): {
  color: string;
  bg: string;
  border: string;
  label: string;
} {
  switch (status) {
    case 'ok':
      return { color: C.okText, bg: C.accentSoft, border: C.border, label: 'ok' };
    case 'retrying':
      return { color: C.warnText, bg: C.warnBg, border: C.warnBorder, label: 'retrying' };
    case 'error':
    default:
      return { color: C.errText, bg: C.errBg, border: C.errBorder, label: 'failed' };
  }
}

function fmtTime(ms: number): string {
  if (!ms || Number.isNaN(ms)) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '—';
  }
}

function fmtDuration(startedAt: number, finishedAt?: number): string {
  if (!finishedAt || finishedAt < startedAt) return '—';
  const ms = finishedAt - startedAt;
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function fmtNodeMs(ms: number): string {
  if (!ms || Number.isNaN(ms)) return '0 ms';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// A run is replayable when it failed (error/partial) or is dead-lettered.
function isReplayable(status: FlowRunStatus, inDlq: boolean): boolean {
  return inDlq || status === 'error' || status === 'partial';
}

// ---- tiny spinner (self-contained, keyframes injected once) ---------------

const Spinner = ({ dark = false }: { dark?: boolean }) => (
  <span
    style={{
      display: 'inline-block',
      width: 12,
      height: 12,
      borderRadius: '50%',
      border: dark ? '2px solid rgba(154,160,166,0.35)' : '2px solid rgba(255,255,255,0.4)',
      borderTopColor: dark ? 'var(--affine-text-secondary-color, #9aa0a6)' : '#fff',
      animation: 'cdz-flowruns-spin 0.7s linear infinite',
    }}
  >
    <style>{'@keyframes cdz-flowruns-spin{to{transform:rotate(360deg)}}'}</style>
  </span>
);

// ---- one run-detail step row (StepRow idiom, extended for FlowRunStep) -----

const FlowStepRow = ({ step, index }: { step: FlowRunStep; index: number }) => {
  const [open, setOpen] = useState(step.status === 'error');
  const tone = stepTone(step.status);
  return (
    <div
      style={{
        borderRadius: 12,
        background: C.bg,
        border: `1px solid ${C.border}`,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          appearance: 'none',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: C.text,
          textAlign: 'left',
          font: 'inherit',
        }}
      >
        <span style={{ fontSize: 11, color: C.muted, width: 18 }}>{index + 1}.</span>
        <span
          style={{
            fontFamily: 'var(--affine-font-code-family, monospace)',
            fontSize: 12,
            fontWeight: 600,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={step.tool}
        >
          {step.tool || step.nodeId}
        </span>
        {step.attempts > 1 ? (
          <span style={{ fontSize: 11, color: C.muted }}>×{step.attempts}</span>
        ) : null}
        <span style={{ fontSize: 11, color: C.muted }}>{fmtNodeMs(step.ms)}</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            padding: '1px 8px',
            borderRadius: 999,
            color: tone.color,
            background: tone.bg,
            border: `1px solid ${tone.border}`,
          }}
        >
          {tone.label}
        </span>
        <span style={{ fontSize: 11, color: C.muted }}>{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div style={{ borderTop: `1px solid ${C.border}`, background: C.panel }}>
          {/* attempts / duration line above the preview (recon idiom) */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              padding: '8px 12px',
              fontSize: 11,
              color: C.muted,
            }}
          >
            <span>
              attempts: <strong style={{ color: C.text }}>{step.attempts}</strong>
            </span>
            <span>
              time: <strong style={{ color: C.text }}>{fmtNodeMs(step.ms)}</strong>
            </span>
            <span>
              node: <span style={{ fontFamily: 'var(--affine-font-code-family, monospace)' }}>{step.nodeId}</span>
            </span>
          </div>
          {step.error ? (
            <div
              style={{
                margin: '0 12px 8px',
                padding: '8px 10px',
                borderRadius: 6,
                background: C.errBg,
                border: `1px solid ${C.errBorder}`,
                color: C.errText,
                fontSize: 11.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {step.error}
            </div>
          ) : null}
          <pre
            style={{
              margin: 0,
              padding: '10px 12px',
              borderTop: `1px solid ${C.border}`,
              color: C.muted,
              fontSize: 11.5,
              fontFamily: 'var(--affine-font-code-family, monospace)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 260,
              overflow: 'auto',
            }}
          >
            {step.resultPreview || '(empty result)'}
          </pre>
        </div>
      ) : null}
    </div>
  );
};

// ---- run detail (fetches the full FlowRun on open) ------------------------

const RunDetail = ({
  runId,
  inDlq,
  flowName,
  getRun,
  replay,
  onBack,
  onReplayed,
}: {
  runId: string;
  inDlq: boolean;
  flowName: (flowId: string) => string;
  getRun: (id: string) => Promise<FlowRun>;
  replay: (runId: string) => Promise<FlowRun>;
  onBack: () => void;
  onReplayed: (run: FlowRun) => void;
}) => {
  const [run, setRun] = useState<FlowRun | null>(null);
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [replayNote, setReplayNote] = useState<string | null>(null);
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    const token = ++reqRef.current;
    setDetailState('loading');
    setDetailError(null);
    try {
      const r = await getRun(runId);
      if (token !== reqRef.current) return;
      setRun(r);
      setDetailState('ready');
    } catch (err) {
      if (token !== reqRef.current) return;
      setDetailError(describeFlowError(err) || 'Could not load this run.');
      setDetailState('error');
    }
  }, [getRun, runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onReplay = useCallback(async () => {
    if (replaying) return;
    setReplaying(true);
    setReplayNote(null);
    try {
      const fresh = await replay(runId);
      setReplayNote(
        fresh.status === 'ok'
          ? 'Replay finished successfully.'
          : `Replay finished with status “${fresh.status}”.`
      );
      onReplayed(fresh);
    } catch (err) {
      setReplayNote(describeFlowError(err) || 'Replay failed. Try again.');
    } finally {
      setReplaying(false);
    }
  }, [replay, replaying, runId, onReplayed]);

  const tone = run ? statusTone(run.status) : null;
  const replayable = run ? isReplayable(run.status, inDlq) : inDlq;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onBack}
          style={{
            appearance: 'none',
            borderRadius: 999,
            padding: '6px 14px',
            minHeight: 36,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            color: C.text,
            background: 'transparent',
            border: `1px solid ${C.border}`,
            transition: 'border-color 160ms ease',
          }}
        >
          ← Back to runs
        </button>
        {run && tone ? (
          <>
            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
              {flowName(run.flowId)}
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                padding: '2px 10px',
                borderRadius: 999,
                color: tone.color,
                background: tone.bg,
                border: `1px solid ${tone.border}`,
              }}
            >
              {tone.label}
            </span>
          </>
        ) : null}
        <span style={{ flex: 1 }} />
        {replayable ? (
          <button
            type="button"
            disabled={replaying}
            onClick={() => void onReplay()}
            style={{
              appearance: 'none',
              border: 'none',
              borderRadius: 999,
              padding: '8px 16px',
              minHeight: 40,
              fontSize: 12,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              cursor: replaying ? 'default' : 'pointer',
              color: '#fff',
              background: C.accent,
              opacity: replaying ? 0.6 : 1,
              transition: 'opacity 150ms ease',
            }}
          >
            {replaying ? (
              <>
                <Spinner /> Replaying…
              </>
            ) : (
              <>↻ Replay</>
            )}
          </button>
        ) : null}
      </div>

      {replayNote ? (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 12,
            fontSize: 12.5,
            background: C.accentSoft,
            border: `1px solid ${C.border}`,
            color: C.text,
          }}
        >
          {replayNote}
        </div>
      ) : null}

      {detailState === 'loading' ? (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            color: C.muted,
            padding: '20px 0',
          }}
        >
          <Spinner dark /> Loading run…
        </div>
      ) : detailState === 'error' ? (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 12,
            fontSize: 13,
            background: C.errBg,
            border: `1px solid ${C.errBorder}`,
            color: C.text,
          }}
        >
          {detailError}{' '}
          <button style={linkBtnStyle} onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : run ? (
        <>
          {/* meta strip */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 20,
              padding: '12px 16px',
              borderRadius: 12,
              background: C.panel,
              border: `1px solid ${C.border}`,
              fontSize: 12,
              color: C.muted,
            }}
          >
            <span>
              Started: <strong style={{ color: C.text }}>{fmtTime(run.startedAt)}</strong>
            </span>
            <span>
              Duration:{' '}
              <strong style={{ color: C.text }}>
                {fmtDuration(run.startedAt, run.finishedAt)}
              </strong>
            </span>
            <span>
              Steps: <strong style={{ color: C.text }}>{run.steps.length}</strong>
            </span>
            <span>
              Run id:{' '}
              <span style={{ fontFamily: 'var(--affine-font-code-family, monospace)' }}>
                {run.id}
              </span>
            </span>
          </div>

          {/* per-node timeline */}
          {run.steps.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: C.muted,
                }}
              >
                Timeline ({run.steps.length})
              </div>
              {run.steps.map((step, i) => (
                <FlowStepRow key={`${step.nodeId}-${i}`} step={step} index={i} />
              ))}
            </div>
          ) : (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 12,
                fontSize: 13,
                background: C.accentSoft,
                border: `1px solid ${C.border}`,
                color: C.muted,
              }}
            >
              This run recorded no steps (all nodes may have been triggers or gated).
            </div>
          )}
        </>
      ) : null}
    </div>
  );
};

// ---- runs list row --------------------------------------------------------

const RunRow = ({
  run,
  inDlq,
  flowName,
  onOpen,
}: {
  run: FlowRunSummary;
  inDlq: boolean;
  flowName: (flowId: string) => string;
  onOpen: () => void;
}) => {
  const tone = statusTone(run.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        appearance: 'none',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '12px 14px',
        borderRadius: 12,
        cursor: 'pointer',
        color: C.text,
        background: C.panel,
        border: `1px solid ${inDlq ? C.errBorder : C.border}`,
        font: 'inherit',
        transition: 'border-color 150ms ease, background 150ms ease, box-shadow 160ms ease',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          padding: '2px 10px',
          borderRadius: 999,
          flexShrink: 0,
          color: tone.color,
          background: tone.bg,
          border: `1px solid ${tone.border}`,
        }}
      >
        {tone.label}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span
          style={{
            fontWeight: 600,
            fontSize: 13,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {flowName(run.flowId)}
          {inDlq ? (
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: C.errText,
              }}
            >
              · DLQ
            </span>
          ) : null}
        </span>
        <span style={{ fontSize: 11.5, color: C.muted }}>
          {fmtTime(run.startedAt)} · {fmtDuration(run.startedAt, run.finishedAt)} ·{' '}
          {run.stepCount} step{run.stepCount === 1 ? '' : 's'}
        </span>
      </div>
      <span style={{ fontSize: 12, color: C.muted, flexShrink: 0 }}>›</span>
    </button>
  );
};

// ---- the Runs view --------------------------------------------------------

export const FlowRunsView = ({
  runs,
  dlq,
  loading,
  error,
  enabled,
  loadRuns,
  loadDlq,
  getRun,
  replay,
  flowName,
  focusRunId,
}: FlowRunsViewProps) => {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const didInitRef = useRef(false);

  // Load runs + DLQ when the tab first mounts (index.tsx renders this only for
  // the active Runs tab, so mount == tab-open).
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    void Promise.allSettled([loadRuns(), loadDlq()]).finally(() => setLoadedOnce(true));
  }, [loadRuns, loadDlq]);

  // If the parent hands us a run to focus (after a Run press), open it.
  useEffect(() => {
    if (focusRunId) setSelectedRunId(focusRunId);
  }, [focusRunId]);

  const dlqIds = useMemo(() => new Set(dlq.map(d => d.runId)), [dlq]);

  const refresh = useCallback(() => {
    void Promise.allSettled([loadRuns(), loadDlq()]);
  }, [loadRuns, loadDlq]);

  // ---- detail view ----
  if (selectedRunId) {
    return (
      <RunDetail
        runId={selectedRunId}
        inDlq={dlqIds.has(selectedRunId)}
        flowName={flowName}
        getRun={getRun}
        replay={replay}
        onBack={() => {
          setSelectedRunId(null);
          refresh();
        }}
        onReplayed={() => refresh()}
      />
    );
  }

  // ---- list header ----
  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 700,
            color: C.text,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              background: `linear-gradient(135deg, ${C.accent}, color-mix(in srgb, ${C.accent} 65%, #000))`,
              flexShrink: 0,
            }}
          >
            📜
          </span>{' '}
          Runs
        </h2>
        <p style={{ margin: 0, color: C.muted, fontSize: 12 }}>
          Every flow execution, newest first. Open one to see its per-node timeline;
          replay failed runs from the detail view.
        </p>
      </div>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        disabled={loading}
        onClick={refresh}
        style={{
          appearance: 'none',
          borderRadius: 999,
          padding: '7px 14px',
          minHeight: 36,
          fontSize: 12,
          fontWeight: 600,
          cursor: loading ? 'default' : 'pointer',
          color: C.text,
          background: 'transparent',
          border: `1px solid ${C.border}`,
          opacity: loading ? 0.6 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          transition: 'border-color 160ms ease',
        }}
      >
        {loading ? <Spinner dark /> : '↻'} Refresh
      </button>
    </div>
  );

  // ---- body states ----
  let body: ReactNode;
  if (!loadedOnce && loading) {
    body = (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: C.muted,
          padding: '20px 0',
        }}
      >
        <Spinner dark /> Loading runs…
      </div>
    );
  } else if (error && runs.length === 0) {
    body = (
      <div
        style={{
          padding: '12px 14px',
          borderRadius: 12,
          fontSize: 13,
          background: C.errBg,
          border: `1px solid ${C.errBorder}`,
          color: C.text,
        }}
      >
        {error}{' '}
        <button style={linkBtnStyle} onClick={refresh}>
          Retry
        </button>
      </div>
    );
  } else if (runs.length === 0) {
    body = (
      <div
        style={{
          padding: '28px 16px',
          borderRadius: 12,
          fontSize: 13,
          textAlign: 'center',
          background: C.panel,
          border: `1px dashed ${C.border}`,
          color: C.muted,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            background: `linear-gradient(135deg, ${C.accent}, color-mix(in srgb, ${C.accent} 65%, #000))`,
          }}
        >
          📜
        </div>
        <div>
          {enabled
            ? 'No runs yet. Build a flow in the Flows tab and press Run to see its execution here.'
            : 'Runs appear here once an owner sets COMPOSIO_API_KEY and you run a flow.'}
        </div>
      </div>
    );
  } else {
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {runs.map(run => (
          <RunRow
            key={run.id}
            run={run}
            inDlq={dlqIds.has(run.id)}
            flowName={flowName}
            onOpen={() => setSelectedRunId(run.id)}
          />
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {header}
      {body}
    </div>
  );
};

export default FlowRunsView;
