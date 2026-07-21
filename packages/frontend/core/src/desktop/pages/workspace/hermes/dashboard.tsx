import { AgentApiError, getCapabilities, listThreads } from '@affine/core/modules/agents/api';
import {
  getAgentRun,
  listAgentRuns,
  startBackgroundRun,
} from '@affine/core/modules/agents/api';
import { StepList } from '@affine/core/modules/agents/components';
import { MarkdownLite } from '@affine/core/modules/agents/components';
import type { AgentStep, AgentThreadSummary } from '@affine/core/modules/agents/types';
import { useAgentRunStream } from '@affine/core/modules/agents/use-agent-stream';
import { ChatWithAiIcon } from '@blocksuite/icons/rc';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { HermesConnectionsPanel } from './hermes-connections';
import {
  Banner,
  btnStyle,
  C,
  EmptyNote,
  type HermesCaps,
  type HermesConfig,
  MODE_LABEL,
  miniBtnStyle,
  normalizeCaps,
  Panel,
  RUN_STATE_META,
  type RunState,
  type SavedWorkflow,
  Spinner,
  textareaStyle,
  timeAgo,
} from './hermes-shared';

// ---------------------------------------------------------------------------
// Hermes dashboard — the per-user home once the agent is provisioned. Mirrors
// the ShopERP ErpDashboard role: a wide, panelled overview built from REAL
// endpoints (GET /api/v1/hermes/threads + /capabilities) plus the saved config.
// Sections:
//   • Quick stats — run count, last run, tools ready, saved workflows.
//   • A prominent "New run" entry into the streaming console.
//   • Exécutions — background agent runs (R6): a start-in-background composer +
//     a live list of durable runs with state chips; clicking a run opens an
//     inline live view that re-attaches to its stream and renders the SAME step
//     timeline the console uses + a final answer card. Gated: if the runs API
//     404s (CDZ_AGENTS_ENABLED off) this whole section stays hidden and the
//     dashboard behaves byte-identically to before.
//   • Recent runs — from the threads list; click → open that thread in console.
//   • Saved workflows — from config; click → open console prefilled with goal.
//   • Tools & connections — reuses the shipping HermesConnectionsPanel
//     (available vs needs-setup), driven by the live capabilities.
// The console itself lives in index.tsx; the dashboard reaches it via the
// onOpenConsole / onNewRun callbacks (prefill = a goal string, threadId = open
// an existing run). Everything degrades: threads/caps failures show a retry,
// not a blank page.
// ---------------------------------------------------------------------------

type LoadState = 'loading' | 'ready' | 'error';

const AGENT = 'hermes' as const;

// ---------------------------------------------------------------------------
// R6 background-run row shape. Mirrors Moteur's Redis run record (the fields
// the list + live view read); typed locally so the dashboard never hard-depends
// on Flux exporting a run type. `listAgentRuns` is expected to return summary
// rows (state, prompt, timestamps) and `getAgentRun` a fuller record (steps,
// finalText). All fields optional/defensive so a partial payload never crashes.
// ---------------------------------------------------------------------------
interface AgentRunRow {
  runId: string;
  agent?: string;
  state?: string;
  prompt?: string;
  channel?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  finalText?: string;
  steps?: AgentStep[];
}

// Coerce an unknown run-state string into a known RunState ('queued' default).
function coerceRunState(v: unknown): RunState {
  const s = typeof v === 'string' ? v : '';
  return s in RUN_STATE_META ? (s as RunState) : 'queued';
}

// Normalise a loosely-typed run payload from the API into AgentRunRow.
function normalizeRun(raw: unknown): AgentRunRow | null {
  const r = (raw && typeof raw === 'object' ? raw : null) as Record<
    string,
    unknown
  > | null;
  if (!r) return null;
  const runId = typeof r.runId === 'string' ? r.runId : '';
  if (!runId) return null;
  const rawSteps = Array.isArray(r.steps) ? (r.steps as AgentStep[]) : undefined;
  return {
    runId,
    agent: typeof r.agent === 'string' ? r.agent : undefined,
    state: typeof r.state === 'string' ? r.state : undefined,
    prompt: typeof r.prompt === 'string' ? r.prompt : undefined,
    channel: typeof r.channel === 'string' ? r.channel : undefined,
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : undefined,
    endedAt: typeof r.endedAt === 'number' ? r.endedAt : undefined,
    error: typeof r.error === 'string' ? r.error : undefined,
    finalText: typeof r.finalText === 'string' ? r.finalText : undefined,
    steps: rawSteps,
  };
}

export const HermesDashboard = ({
  config,
  onOpenConsole,
  onOpenThread,
  onReconfigure,
}: {
  // The provisioned per-user config (name, persona, saved workflows, mode).
  config: HermesConfig;
  // Enter the streaming console; optional goal string seeds the composer.
  onOpenConsole: (prefill?: string) => void;
  // Open a specific existing run (thread id) in the console.
  onOpenThread: (threadId: string) => void;
  // Re-open the wizard / settings to edit the config.
  onReconfigure: () => void;
}) => {
  const [threadsState, setThreadsState] = useState<LoadState>('loading');
  const [threads, setThreads] = useState<AgentThreadSummary[]>([]);
  const [caps, setCaps] = useState<HermesCaps | null>(null);
  const [capsState, setCapsState] = useState<LoadState>('loading');

  // ---- R6 background runs (Exécutions) ------------------------------------
  // `runsEnabled` is a one-shot capability probe: null = unknown (probing),
  // true = the runs API answered, false = it 404'd (CDZ_AGENTS_ENABLED off) so
  // the whole section stays dark and the dashboard behaves exactly as before.
  const [runsEnabled, setRunsEnabled] = useState<boolean | null>(null);
  const [runsState, setRunsState] = useState<LoadState>('loading');
  const [runs, setRuns] = useState<AgentRunRow[]>([]);
  // The run currently open in the inline live view, or null.
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const loadThreads = useCallback(async () => {
    setThreadsState('loading');
    try {
      const rows = await listThreads('hermes');
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      setThreads(rows);
      setThreadsState('ready');
    } catch {
      setThreads([]);
      setThreadsState('error');
    }
  }, []);

  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      const raw = await getCapabilities('hermes');
      setCaps(normalizeCaps(raw));
      setCapsState('ready');
    } catch {
      setCaps(null);
      setCapsState('error');
    }
  }, []);

  // Load the background runs list AND double as the capability probe: a 404
  // means the agent-runs feature is off, so we disable the section silently.
  // Any other failure keeps the section visible but shows a retryable error.
  const loadRuns = useCallback(async () => {
    setRunsState('loading');
    try {
      const raw = await listAgentRuns(AGENT);
      const rows = (Array.isArray(raw) ? raw : [])
        .map(normalizeRun)
        .filter((r): r is AgentRunRow => !!r)
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      setRuns(rows);
      setRunsEnabled(true);
      setRunsState('ready');
    } catch (err) {
      // 404 ⇒ feature flag off: hide the whole section, no error surfaced.
      if (err instanceof AgentApiError && err.status === 404) {
        setRunsEnabled(false);
        setRuns([]);
        setRunsState('ready');
        return;
      }
      // The probe hasn't confirmed the feature is on yet — treat an early
      // failure as "unknown" so we don't flash an error panel for a disabled
      // build. Once we've seen a success (runsEnabled === true) later failures
      // surface as a retryable error instead.
      setRunsEnabled(prev => (prev === true ? true : prev));
      setRunsState('error');
    }
  }, []);

  useEffect(() => {
    void loadThreads();
    void loadCaps();
    void loadRuns();
  }, [loadThreads, loadCaps, loadRuns]);

  // ---- derived stats ------------------------------------------------------
  const stats = useMemo(() => {
    const runCount = threads.length;
    const lastRun = threads.length > 0 ? threads[0].updatedAt : undefined;
    const totalTurns = threads.reduce(
      (s, t) => s + (Number.isFinite(t.messageCount) ? t.messageCount : 0),
      0
    );
    const toolsReady = caps?.tools.filter(t => t.available).length ?? 0;
    const toolsTotal = caps?.tools.length ?? 0;
    return { runCount, lastRun, totalTurns, toolsReady, toolsTotal };
  }, [threads, caps]);

  const savedWorkflows: SavedWorkflow[] = config.savedWorkflows ?? [];
  const plannerReady = !!caps?.plannerReady;
  const agentName = config.agentName || 'Hermes';
  // The section is only rendered once the probe confirms the feature is on.
  const showExecutions = runsEnabled === true;

  // Start a background run and immediately open its live view. Returns the new
  // runId (or null on failure). Re-loads the list so the row appears at once.
  const startBackground = useCallback(
    async (prompt: string): Promise<string | null> => {
      const trimmed = prompt.trim();
      if (!trimmed) return null;
      try {
        const res = await startBackgroundRun(AGENT, trimmed);
        const runId =
          res && typeof res === 'object' && typeof res.runId === 'string'
            ? res.runId
            : null;
        void loadRuns();
        if (runId) setOpenRunId(runId);
        return runId;
      } catch (err) {
        // A 404 here means the feature just went dark — hide the section.
        if (err instanceof AgentApiError && err.status === 404) {
          setRunsEnabled(false);
        }
        throw err;
      }
    },
    [loadRuns]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* ---- Header row: identity + reconfigure + New run ------------------ */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              aria-hidden
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                flexShrink: 0,
                display: 'grid',
                placeItems: 'center',
                background: C.accentSoft,
                border: `1px solid ${C.accentBorder}`,
                color: C.accent,
              }}
            >
              <ChatWithAiIcon style={{ fontSize: 22 }} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: 22,
                  fontWeight: 800,
                  color: C.text,
                  lineHeight: 1.2,
                }}
              >
                {agentName}
              </h1>
              <p
                style={{
                  margin: '2px 0 0',
                  fontSize: 12.5,
                  color: C.muted,
                }}
              >
                Your operations agent · dashboard
              </p>
            </div>
          </div>
          {config.personaGoal ? (
            <p
              style={{
                margin: '12px 0 0',
                fontSize: 13,
                color: C.muted,
                lineHeight: 1.55,
                maxWidth: 620,
              }}
            >
              {config.personaGoal}
            </p>
          ) : null}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button style={btnStyle('secondary')} onClick={onReconfigure}>
            ⚙ Settings
          </button>
          <button style={btnStyle('primary')} onClick={() => onOpenConsole()}>
            <ChatWithAiIcon style={{ fontSize: 15 }} /> New run
          </button>
        </div>
      </div>

      {/* ---- Planner-offline notice (mirrors the console's blocking notice) */}
      {capsState === 'ready' && !plannerReady ? (
        <Banner tone="warn">
          <strong>Planner offline.</strong>&nbsp;Hermes can’t run until the owner
          configures the reasoning key on the server. Your setup, tools and
          workflows still load.
        </Banner>
      ) : null}

      {/* ---- Quick stats -------------------------------------------------- */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 12,
        }}
      >
        <StatCard label="Runs" value={String(stats.runCount)} emoji="🗂️" />
        <StatCard
          label="Last run"
          value={stats.lastRun ? timeAgo(stats.lastRun) : '—'}
          emoji="🕑"
        />
        <StatCard
          label="Tools ready"
          value={
            capsState === 'loading'
              ? '…'
              : `${stats.toolsReady}/${stats.toolsTotal}`
          }
          emoji="🔌"
        />
        <StatCard
          label="Saved workflows"
          value={String(savedWorkflows.length)}
          emoji="⚡"
        />
      </div>

      {/* ---- Exécutions (R6 background runs) — hidden unless the feature is on */}
      {showExecutions ? (
        <Panel
          title="Exécutions"
          action={
            <button
              style={miniBtnStyle('secondary')}
              onClick={() => void loadRuns()}
              title="Refresh runs"
            >
              ↻
            </button>
          }
        >
          {/* Start-in-background composer. Closing the tab won't kill the run;
              it keeps going server-side and streams live here on return. */}
          <BackgroundComposer
            disabled={capsState === 'ready' && !plannerReady}
            onStart={startBackground}
          />

          <div style={{ height: 12 }} />

          {runsState === 'loading' ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '14px 4px',
                color: C.muted,
              }}
            >
              <Spinner /> Loading background runs…
            </div>
          ) : runsState === 'error' ? (
            <Banner tone="error">
              Couldn’t load background runs.{' '}
              <button
                style={{ ...miniBtnStyle('secondary'), display: 'inline-flex' }}
                onClick={() => void loadRuns()}
              >
                Retry
              </button>
            </Banner>
          ) : runs.length === 0 ? (
            <EmptyNote>
              No background runs yet. Type a goal above and hit{' '}
              <strong>Run in background</strong> — it keeps going even if you
              close this tab.
            </EmptyNote>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {runs.slice(0, 8).map(r => (
                <ExecutionRow
                  key={r.runId}
                  run={r}
                  onOpen={() => setOpenRunId(r.runId)}
                />
              ))}
            </div>
          )}
        </Panel>
      ) : null}

      {/* ---- Two-column body: runs + workflows | connections -------------- */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 16,
          alignItems: 'start',
        }}
      >
        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {/* Recent runs */}
          <Panel
            title="Recent runs"
            action={
              <button
                style={miniBtnStyle('secondary')}
                onClick={() => void loadThreads()}
                title="Refresh runs"
              >
                ↻
              </button>
            }
          >
            {threadsState === 'loading' ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '14px 4px',
                  color: C.muted,
                }}
              >
                <Spinner /> Loading your runs…
              </div>
            ) : threadsState === 'error' ? (
              <Banner tone="error">
                Couldn’t load your runs.{' '}
                <button
                  style={{ ...miniBtnStyle('secondary'), display: 'inline-flex' }}
                  onClick={() => void loadThreads()}
                >
                  Retry
                </button>
              </Banner>
            ) : threads.length === 0 ? (
              <EmptyNote>
                No runs yet. Start one from a workflow below or hit{' '}
                <strong>New run</strong>.
              </EmptyNote>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {threads.slice(0, 6).map(t => (
                  <RunRow key={t.id} thread={t} onOpen={() => onOpenThread(t.id)} />
                ))}
              </div>
            )}
          </Panel>

          {/* Saved workflows */}
          <Panel
            title="Saved workflows"
            action={
              <button
                style={miniBtnStyle('secondary')}
                onClick={onReconfigure}
                title="Edit saved workflows"
              >
                Edit
              </button>
            }
          >
            {savedWorkflows.length === 0 ? (
              <EmptyNote>
                No saved workflows yet.{' '}
                <button
                  style={{ ...miniBtnStyle('primary'), display: 'inline-flex' }}
                  onClick={onReconfigure}
                >
                  Add one
                </button>
              </EmptyNote>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {savedWorkflows.map((wf, i) => (
                  <WorkflowRow
                    key={`${wf.title}-${i}`}
                    workflow={wf}
                    onRun={() => onOpenConsole(wf.goal)}
                  />
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* Right column: tools & connections (reuse the shipping panel) */}
        <div style={{ minWidth: 0 }}>
          <Panel title="Tools & connections">
            {capsState === 'error' ? (
              <Banner tone="error">
                Couldn’t load tool availability.{' '}
                <button
                  style={{ ...miniBtnStyle('secondary'), display: 'inline-flex' }}
                  onClick={() => void loadCaps()}
                >
                  Retry
                </button>
              </Banner>
            ) : (
              // HermesConnectionsPanel renders its own skeleton when caps is null,
              // and groups tools available vs needs-setup with a Manage link.
              <HermesConnectionsPanel
                capabilities={
                  caps ? { tools: caps.tools, plannerReady: caps.plannerReady } : null
                }
              />
            )}
          </Panel>
        </div>
      </div>

      {/* ---- Footer: default mode reminder + console entry ---------------- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          padding: '14px 16px',
          borderRadius: 12,
          background: C.panel,
          border: `1px solid ${C.border}`,
        }}
      >
        <span style={{ fontSize: 20 }} aria-hidden>
          🎚️
        </span>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
            Default run mode
          </div>
          <div style={{ fontSize: 12, color: C.muted }}>
            {MODE_LABEL[config.defaultMode ?? 'ask']} · change it per run in the
            console.
          </div>
        </div>
        <button style={btnStyle('primary')} onClick={() => onOpenConsole()}>
          Open console →
        </button>
      </div>

      {/* ---- Live run view overlay (opened from an Exécutions row) --------- */}
      {showExecutions && openRunId ? (
        <RunLiveView
          runId={openRunId}
          onClose={() => {
            setOpenRunId(null);
            // Refresh the list so the closed run's final state is reflected.
            void loadRuns();
          }}
        />
      ) : null}
    </div>
  );
};

// ---- sub-components --------------------------------------------------------

const StatCard = ({
  label,
  value,
  emoji,
}: {
  label: string;
  value: string;
  emoji: string;
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: 14,
      borderRadius: 12,
      background: C.panel,
      border: `1px solid ${C.border}`,
      minWidth: 0,
    }}
  >
    <span
      aria-hidden
      style={{
        width: 36,
        height: 36,
        flexShrink: 0,
        borderRadius: 9,
        display: 'grid',
        placeItems: 'center',
        fontSize: 18,
        background: C.bg,
        border: `1px solid ${C.border}`,
      }}
    >
      {emoji}
    </span>
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 19,
          fontWeight: 800,
          color: C.text,
          lineHeight: 1.1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: C.muted,
        }}
      >
        {label}
      </div>
    </div>
  </div>
);

const RunRow = ({
  thread,
  onOpen,
}: {
  thread: AgentThreadSummary;
  onOpen: () => void;
}) => (
  <button
    type="button"
    onClick={onOpen}
    style={{
      appearance: 'none',
      textAlign: 'left',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '9px 11px',
      borderRadius: 9,
      background: C.bg,
      border: `1px solid ${C.border}`,
      color: C.text,
      transition: 'background 150ms ease, border-color 150ms ease',
    }}
    onMouseEnter={e => {
      e.currentTarget.style.background = C.accentSoft;
      e.currentTarget.style.borderColor = C.accentBorder;
    }}
    onMouseLeave={e => {
      e.currentTarget.style.background = C.bg;
      e.currentTarget.style.borderColor = C.border;
    }}
  >
    <span
      aria-hidden
      style={{
        width: 26,
        height: 26,
        flexShrink: 0,
        borderRadius: 7,
        display: 'grid',
        placeItems: 'center',
        fontSize: 13,
        background: C.panel2,
        color: C.muted,
      }}
    >
      💬
    </span>
    <span style={{ flex: 1, minWidth: 0 }}>
      <span
        style={{
          display: 'block',
          fontSize: 13,
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {thread.title || 'Untitled run'}
      </span>
      <span style={{ display: 'block', fontSize: 11, color: C.muted }}>
        {thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}
        {thread.updatedAt ? ` · ${timeAgo(thread.updatedAt)}` : ''}
      </span>
    </span>
    <span aria-hidden style={{ color: C.muted, fontSize: 14, flexShrink: 0 }}>
      →
    </span>
  </button>
);

const WorkflowRow = ({
  workflow,
  onRun,
}: {
  workflow: SavedWorkflow;
  onRun: () => void;
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 12px',
      borderRadius: 10,
      background: C.bg,
      border: `1px solid ${C.border}`,
    }}
  >
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
        {workflow.title || 'Saved workflow'}
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: C.muted,
          lineHeight: 1.45,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}
        title={workflow.goal}
      >
        {workflow.goal}
      </div>
    </div>
    <button
      style={{ ...miniBtnStyle('primary'), flexShrink: 0 }}
      onClick={onRun}
      title="Load this into the console"
    >
      Run →
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// R6 Exécutions sub-components (background runs).
// ---------------------------------------------------------------------------

// A small chip rendering a run's lifecycle state with its per-state colour.
const RunStateChip = ({ state }: { state: RunState }) => {
  const meta = RUN_STATE_META[state] ?? RUN_STATE_META.queued;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        padding: '1px 8px',
        borderRadius: 999,
        color: meta.color,
        background: meta.bg,
        border: `1px solid ${meta.border}`,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: meta.color,
          flexShrink: 0,
        }}
      />
      {meta.label}
    </span>
  );
};

// Compose a background run: a textarea + "Run in background" button. Disabled
// when the planner is offline. Local state only; delegates the start to onStart.
const BackgroundComposer = ({
  disabled,
  onStart,
}: {
  disabled?: boolean;
  onStart: (prompt: string) => Promise<string | null>;
}) => {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || busy || disabled) return;
    setBusy(true);
    setErr(null);
    try {
      const runId = await onStart(trimmed);
      if (runId) setValue('');
      else setErr('Couldn’t start the run — please retry.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Couldn’t start the run.');
    } finally {
      setBusy(false);
    }
  }, [busy, disabled, onStart, value]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <textarea
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder={
          disabled
            ? 'Planner offline — background runs are disabled'
            : 'Describe a goal to run in the background (continue-in-background)…'
        }
        disabled={disabled || busy}
        rows={2}
        onKeyDown={e => {
          // Cmd/Ctrl+Enter starts the run without leaving the textarea.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
        style={{
          ...textareaStyle,
          minHeight: 56,
          opacity: disabled ? 0.6 : 1,
        }}
      />
      {err ? (
        <span
          style={{ fontSize: 12, color: 'var(--affine-error-color, #eb4b4b)' }}
        >
          {err}
        </span>
      ) : null}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          justifyContent: 'flex-end',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: C.muted }}>
          Runs keep going if you close the tab · appears below, streams live.
        </span>
        <button
          style={{
            ...miniBtnStyle('primary', disabled || busy || !value.trim()),
            flexShrink: 0,
          }}
          disabled={disabled || busy || !value.trim()}
          onClick={() => void submit()}
          title="Start this run in the background"
        >
          {busy ? (
            <>
              <Spinner dark /> Starting…
            </>
          ) : (
            <>🌙 Run in background</>
          )}
        </button>
      </div>
    </div>
  );
};

// One row in the Exécutions list: state chip, prompt preview, relative time.
const ExecutionRow = ({
  run,
  onOpen,
}: {
  run: AgentRunRow;
  onOpen: () => void;
}) => {
  const state = coerceRunState(run.state);
  const when = run.startedAt ?? run.endedAt;
  const preview = (run.prompt ?? '').trim() || 'Untitled run';
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        appearance: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 11px',
        borderRadius: 9,
        background: C.bg,
        border: `1px solid ${C.border}`,
        color: C.text,
        transition: 'background 150ms ease, border-color 150ms ease',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = C.accentSoft;
        e.currentTarget.style.borderColor = C.accentBorder;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = C.bg;
        e.currentTarget.style.borderColor = C.border;
      }}
    >
      <span
        aria-hidden
        style={{
          width: 26,
          height: 26,
          flexShrink: 0,
          borderRadius: 7,
          display: 'grid',
          placeItems: 'center',
          fontSize: 13,
          background: C.panel2,
          color: C.muted,
        }}
      >
        {run.channel === 'telegram' ? '✈️' : '🌙'}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {preview}
        </span>
        <span style={{ display: 'block', fontSize: 11, color: C.muted }}>
          {when ? timeAgo(when) : 'just now'}
        </span>
      </span>
      <RunStateChip state={state} />
      <span aria-hidden style={{ color: C.muted, fontSize: 14, flexShrink: 0 }}>
        →
      </span>
    </button>
  );
};

// ---------------------------------------------------------------------------
// RunLiveView — an inline overlay that re-attaches to a background run's stream
// (durable hook) and renders the SAME step timeline the console uses (StepList)
// plus a final answer card (MarkdownLite). On first mount it seeds from the
// persisted record (getAgentRun) so an already-finished run shows instantly,
// then the durable hook replays events + live-attaches. Fail-soft: a load error
// shows a retry; a missing hook payload just renders what the record gave us.
// ---------------------------------------------------------------------------
const RunLiveView = ({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) => {
  const [record, setRecord] = useState<AgentRunRow | null>(null);
  const [recordState, setRecordState] = useState<LoadState>('loading');

  const loadRecord = useCallback(async () => {
    setRecordState('loading');
    try {
      const raw = await getAgentRun(AGENT, runId);
      setRecord(normalizeRun(raw));
      setRecordState('ready');
    } catch {
      setRecord(null);
      setRecordState('error');
    }
  }, [runId]);

  useEffect(() => {
    void loadRecord();
  }, [loadRecord]);

  // Durable stream hook (Flux): re-attaches to runId, replays history, then
  // live-attaches. Exposes {steps, state, finalText, phase?, error?, reattach}.
  const stream = useAgentRunStream({ agent: AGENT, runId });

  // Prefer live stream data once it has arrived; fall back to the persisted
  // record so a finished run (or a slow hook) still renders fully.
  const steps: AgentStep[] =
    stream.steps && stream.steps.length > 0
      ? stream.steps
      : record?.steps ?? [];
  const state = coerceRunState(stream.state ?? record?.state);
  const finalText =
    (typeof stream.finalText === 'string' && stream.finalText) ||
    record?.finalText ||
    '';
  const errorText = stream.error || record?.error || '';
  const isLive = state === 'running' || state === 'queued' || state === 'waiting_approval';

  // Escape closes the overlay.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Background run"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '5vh 16px',
        overflowY: 'auto',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 760,
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '90vh',
        }}
      >
        {/* Header: state chip + live indicator + close */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            borderBottom: `1px solid ${C.border}`,
            background: C.panel2,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: C.muted,
              flex: 1,
              minWidth: 0,
            }}
          >
            Background run
          </span>
          <RunStateChip state={state} />
          {isLive ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11.5,
                color: C.muted,
              }}
            >
              <Spinner /> live
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            style={{
              appearance: 'none',
              width: 26,
              height: 26,
              borderRadius: 7,
              border: `1px solid ${C.border}`,
              background: 'transparent',
              color: C.muted,
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body: prompt · step timeline · final answer / error */}
        <div
          style={{
            padding: 16,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {record?.prompt ? (
            <div
              style={{
                fontSize: 13,
                color: C.text,
                lineHeight: 1.55,
                padding: '10px 12px',
                borderRadius: 10,
                background: C.accentSoft,
                border: `1px solid ${C.accentBorder}`,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {record.prompt}
            </div>
          ) : null}

          {recordState === 'loading' && steps.length === 0 && !finalText ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '18px 4px',
                color: C.muted,
              }}
            >
              <Spinner /> Attaching to run…
            </div>
          ) : recordState === 'error' && steps.length === 0 && !finalText ? (
            <Banner tone="error">
              Couldn’t load this run.{' '}
              <button
                style={{ ...miniBtnStyle('secondary'), display: 'inline-flex' }}
                onClick={() => {
                  void loadRecord();
                  stream.reattach?.();
                }}
              >
                Retry
              </button>
            </Banner>
          ) : (
            <>
              {steps.length > 0 ? (
                // Reuse the console's exact step timeline. The last step pulses
                // while the run is still live.
                <StepList
                  steps={steps}
                  activeIndex={isLive ? steps.length - 1 : undefined}
                />
              ) : isLive ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '14px 4px',
                    color: C.muted,
                  }}
                >
                  <Spinner /> Working…
                </div>
              ) : (
                <EmptyNote>No steps were recorded for this run.</EmptyNote>
              )}

              {errorText ? (
                <Banner tone="error">
                  <strong>Run error.</strong>&nbsp;{errorText}
                </Banner>
              ) : null}

              {finalText ? (
                <div
                  style={{
                    borderRadius: 12,
                    border: `1px solid ${C.okBorder}`,
                    background: C.okSoft,
                    padding: '12px 14px',
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      color: C.muted,
                      marginBottom: 8,
                    }}
                  >
                    Final answer
                  </div>
                  <MarkdownLite text={finalText} />
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default HermesDashboard;
