import { getCapabilities, listThreads } from '@affine/core/modules/agents/api';
import type { AgentThreadSummary } from '@affine/core/modules/agents/types';
import { ChatWithAiIcon } from '@blocksuite/icons/rc';
import { useCallback, useEffect, useMemo, useState } from 'react';

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
  type SavedWorkflow,
  Spinner,
  timeAgo,
} from './hermes-shared';

// ---------------------------------------------------------------------------
// Hermes dashboard — the per-user home once the agent is provisioned. Mirrors
// the ShopERP ErpDashboard role: a wide, panelled overview built from REAL
// endpoints (GET /api/v1/hermes/threads + /capabilities) plus the saved config.
// Sections:
//   • Quick stats — run count, last run, tools ready, saved workflows.
//   • A prominent "New run" entry into the streaming console.
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

  useEffect(() => {
    void loadThreads();
    void loadCaps();
  }, [loadThreads, loadCaps]);

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

export default HermesDashboard;
