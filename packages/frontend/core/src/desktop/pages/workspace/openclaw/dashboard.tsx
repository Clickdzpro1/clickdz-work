// ---------------------------------------------------------------------------
// OpenClaw dashboard — the studio home once a user is provisioned (mirrors the
// ShopERP in-app dashboard). It composes data that already exists on the C5
// backend, nothing faked:
//   • recent projects/threads   ← GET /api/v1/openclaw/threads (+ per-thread
//                                  sandbox status from the full thread doc)
//   • a prominent "New task"     → hands a prompt up to the console (the page's
//                                  streaming coding console)
//   • sandbox status card        ← GET /api/v1/openclaw/capabilities (honest)
//   • runtime preference         ← the user's saved config
//   • last thread's files/preview← GET /threads/:id (sandbox.routes) + listFiles
//                                  → the OpenClaw workspace components
//
// Reuses the WS12 SHELL EmptyState + the OpenClaw workspace components
// (FileTree / CodeViewer / PreviewPanel) UNCHANGED. Inline styles only.
// ---------------------------------------------------------------------------

import * as agentApi from '@affine/core/modules/agents/api';
import { EmptyState } from '@affine/core/modules/agents/components';
import type {
  AgentThread,
  AgentThreadSummary,
} from '@affine/core/modules/agents/types';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// CLAWX (C9) workspace components — kept UNCHANGED; the dashboard reuses them to
// show the last thread's files + live preview. They resolve against their C9
// prop signatures (won't resolve in an isolated single-file esbuild — expected).
import { CodeViewer } from './code-viewer';
import { FileTree } from './file-tree';
import {
  Banner,
  btnStyle,
  C,
  type ClawCapabilities,
  EmptyNote,
  monoFamily,
  type OpenClawConfig,
  Panel,
  relTime,
  RUNTIME_LABELS,
  SandboxStatus,
  Spinner,
} from './openclaw-shared';
import { PreviewPanel } from './preview-panel';

// The example prompts double as quick-start tasks (same set the console uses).
const QUICK_TASKS: string[] = [
  'Build a small Express API with a /health route and show it running',
  'Write a Python script that computes and prints the first 20 prime numbers',
  'Scaffold a Vite + React counter app and open the live preview',
  'Write a Python fizzbuzz function with a test, then run the test',
];

interface OpenFile {
  path: string;
  content: string;
  language?: string;
  loading: boolean;
  error?: string;
}

export const OpenClawDashboard = ({
  config,
  caps,
  capsState,
  onReloadCaps,
  onNewTask,
  onOpenThread,
  onReconfigure,
}: {
  /** The user's saved config (runtime pref, preview pref). */
  config: OpenClawConfig;
  /** Honest capabilities (sandbox status). */
  caps: ClawCapabilities | null;
  capsState: 'loading' | 'ready' | 'error';
  onReloadCaps: () => void;
  /** Start a new task in the console (optional seed prompt). */
  onNewTask: (seed?: string) => void;
  /** Open an existing thread in the console. */
  onOpenThread: (id: string) => void;
  /** Re-run the onboarding wizard to change defaults. */
  onReconfigure: () => void;
}) => {
  // ---- recent threads ----------------------------------------------------
  const [threadsState, setThreadsState] = useState<
    'loading' | 'ready' | 'error'
  >('loading');
  const [threads, setThreads] = useState<AgentThreadSummary[]>([]);

  const loadThreads = useCallback(async () => {
    setThreadsState('loading');
    try {
      const rows = await agentApi.listThreads('openclaw');
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      setThreads(rows);
      setThreadsState('ready');
    } catch {
      setThreadsState('error');
    }
  }, []);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  // ---- last thread detail (files + preview) ------------------------------
  const lastId = threads[0]?.id ?? null;
  const [lastThread, setLastThread] = useState<AgentThread | null>(null);
  const [lastFiles, setLastFiles] = useState<agentApi.AgentFileEntry[]>([]);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [wsTab, setWsTab] = useState<'files' | 'preview'>('files');
  const loadedDetailFor = useRef<string | null>(null);

  useEffect(() => {
    if (loadedDetailFor.current === lastId) return;
    loadedDetailFor.current = lastId;
    setLastThread(null);
    setLastFiles([]);
    setOpenFile(null);
    setWsTab('files');
    if (!lastId) return;
    let alive = true;
    void (async () => {
      try {
        const thread = await agentApi.getThread('openclaw', lastId);
        if (alive) setLastThread(thread);
      } catch {
        /* leave null — the panel shows its empty note */
      }
      try {
        const list = await agentApi.listFiles(lastId);
        if (alive && Array.isArray(list)) {
          setLastFiles(
            list.filter(f => f && typeof f.path === 'string')
          );
        }
      } catch {
        /* no sandbox / not enabled — empty file list */
      }
    })();
    return () => {
      alive = false;
    };
  }, [lastId]);

  const openPath = useCallback(
    async (path: string) => {
      if (!lastId) return;
      const known = lastFiles.find(f => f.path === path);
      setWsTab('files');
      setOpenFile({ path, content: '', language: known?.language, loading: true });
      try {
        const file = await agentApi.readFile(lastId, path);
        setOpenFile({
          path: file.path ?? path,
          content: typeof file.content === 'string' ? file.content : '',
          language: file.language ?? known?.language,
          loading: false,
        });
      } catch {
        setOpenFile({
          path,
          content: '',
          language: known?.language,
          loading: false,
          error: 'Could not read this file from the sandbox.',
        });
      }
    },
    [lastId, lastFiles]
  );

  const lastPreviewUrl = useMemo(() => {
    const routes = lastThread?.sandbox?.routes;
    if (!routes || routes.length === 0) return '';
    return routes.find(r => r.port === 3000)?.url ?? routes[0]?.url ?? '';
  }, [lastThread]);

  const runtimeLabel =
    RUNTIME_LABELS[config.defaultRuntime ?? 'node24'] ?? 'Node.js 24';

  // ------------------------------------------------------------------ render
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Hero: prominent New task */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 14,
          padding: '18px 20px',
          borderRadius: 14,
          background: C.panel,
          border: `1px solid ${C.border}`,
        }}
      >
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <div
            style={{
              fontSize: 17,
              fontWeight: 800,
              color: C.text,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ fontFamily: monoFamily, color: C.accent }}>
              {'>_'}
            </span>
            Start a coding task
          </div>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: C.muted }}>
            Describe what to build — {runtimeLabel} · sandbox{' '}
            {caps?.sandbox ? 'live' : 'generate-only'}.
          </p>
        </div>
        <button style={btnStyle('primary')} onClick={() => onNewTask()}>
          + New task
        </button>
      </div>

      {/* Quick-start chips (seed the console) */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        {QUICK_TASKS.map((t, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onNewTask(t)}
            style={{
              appearance: 'none',
              textAlign: 'left',
              padding: '8px 13px',
              borderRadius: 999,
              border: `1px solid ${C.border}`,
              background: C.panel,
              color: C.text,
              fontSize: 12.5,
              lineHeight: 1.4,
              cursor: 'pointer',
              maxWidth: 340,
              transition: 'background 150ms ease, border-color 150ms ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = C.accentSoft;
              e.currentTarget.style.borderColor = C.accentBorder;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = C.panel;
              e.currentTarget.style.borderColor = C.border;
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Status row: sandbox + runtime pref */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 16,
        }}
      >
        <Panel
          title="Sandbox"
          action={
            <button
              style={{
                appearance: 'none',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: C.accent,
                fontSize: 12,
                fontWeight: 600,
                padding: 0,
              }}
              onClick={onReloadCaps}
            >
              ↻ Recheck
            </button>
          }
        >
          {capsState === 'loading' ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: C.muted,
              }}
            >
              <Spinner /> Checking…
            </div>
          ) : capsState === 'error' ? (
            <Banner tone="error">Couldn’t load capabilities.</Banner>
          ) : (
            <SandboxStatus caps={caps} />
          )}
        </Panel>

        <Panel
          title="Your defaults"
          action={
            <button
              style={{
                appearance: 'none',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: C.accent,
                fontSize: 12,
                fontWeight: 600,
                padding: 0,
              }}
              onClick={onReconfigure}
            >
              Edit
            </button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <PrefRow label="Default runtime" value={runtimeLabel} mono />
            <PrefRow
              label="Auto-open preview"
              value={config.previewAutoOpen ? 'On' : 'Off'}
            />
            {caps?.plannerReady === false ? (
              <Banner tone="warn">
                The AI planner isn’t configured — running is disabled until the
                owner sets <code style={codeChip}>CDZ_AI_KEY</code>.
              </Banner>
            ) : null}
          </div>
        </Panel>
      </div>

      {/* Recent projects/threads */}
      <Panel
        title="Recent tasks"
        action={
          threads.length > 0 ? (
            <span style={{ fontSize: 11, color: C.muted }}>
              {threads.length} total
            </span>
          ) : undefined
        }
      >
        {threadsState === 'loading' ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: C.muted,
              padding: '8px 2px',
            }}
          >
            <Spinner /> Loading your tasks…
          </div>
        ) : threadsState === 'error' ? (
          <Banner tone="error">
            Couldn’t load your tasks.{' '}
            <button
              style={{ ...btnStyle('secondary'), padding: '2px 8px', fontSize: 12 }}
              onClick={() => void loadThreads()}
            >
              Retry
            </button>
          </Banner>
        ) : threads.length === 0 ? (
          <EmptyNote>
            No tasks yet. Hit <strong>New task</strong> above to build your
            first project.
          </EmptyNote>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {threads.slice(0, 8).map(t => (
              <ThreadRow
                key={t.id}
                thread={t}
                isLast={t.id === lastId}
                lastThread={t.id === lastId ? lastThread : null}
                onOpen={() => onOpenThread(t.id)}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* Last thread's workspace (files + preview) — reuses CLAWX components */}
      {lastId ? (
        <Panel
          title={`Last project — ${threads[0]?.title ?? ''}`}
          action={
            <div style={{ display: 'flex', gap: 4 }}>
              <MiniTab
                on={wsTab === 'files'}
                onClick={() => setWsTab('files')}
                label={`Files${lastFiles.length ? ` (${lastFiles.length})` : ''}`}
              />
              <MiniTab
                on={wsTab === 'preview'}
                onClick={() => setWsTab('preview')}
                label="Preview"
              />
              <button
                style={{ ...btnStyle('secondary'), padding: '4px 10px', fontSize: 12 }}
                onClick={() => onOpenThread(lastId)}
              >
                Open in console →
              </button>
            </div>
          }
        >
          <div style={{ height: 340, display: 'flex', minHeight: 0 }}>
            {wsTab === 'files' ? (
              <div style={{ display: 'flex', width: '100%', minHeight: 0 }}>
                <div style={fileTreeWrap}>
                  <FileTree
                    files={lastFiles}
                    activePath={openFile?.path}
                    onOpen={path => void openPath(path)}
                  />
                </div>
                <div style={codeWrap}>
                  {openFile ? (
                    openFile.loading ? (
                      <CodeViewer path={openFile.path} loading />
                    ) : openFile.error ? (
                      <EmptyNote>{openFile.error}</EmptyNote>
                    ) : (
                      <CodeViewer
                        path={openFile.path}
                        content={openFile.content}
                        language={openFile.language}
                      />
                    )
                  ) : (
                    <EmptyNote>
                      {lastFiles.length > 0
                        ? 'Select a file to view it.'
                        : caps?.sandbox
                          ? 'No files from this task yet.'
                          : 'Live execution is off — files appear once a task runs in the sandbox.'}
                    </EmptyNote>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ width: '100%', minHeight: 0 }}>
                <PreviewPanel
                  url={lastPreviewUrl || undefined}
                  status="ready"
                  onRefresh={() => {
                    // Re-fetch the thread doc to pick up fresh routes.
                    loadedDetailFor.current = null;
                    setLastThread(null);
                  }}
                />
              </div>
            )}
          </div>
        </Panel>
      ) : null}

      {/* Fresh-start hero when there are no threads at all */}
      {threadsState === 'ready' && threads.length === 0 ? (
        <EmptyState
          icon="🐾"
          title="Build something and watch it run"
          subtitle={
            caps?.sandbox
              ? 'Describe a coding task. OpenClaw writes the files, runs them in an isolated sandbox, streams the output, and (for web apps) shows a live preview.'
              : 'Describe a coding task. OpenClaw writes and explains the code. Live execution is off on this server, so nothing is run.'
          }
          examples={QUICK_TASKS}
          onPickExample={seed => onNewTask(seed)}
        />
      ) : null}
    </div>
  );
};

// ---- sub-components --------------------------------------------------------

const ThreadRow = ({
  thread,
  isLast,
  lastThread,
  onOpen,
}: {
  thread: AgentThreadSummary;
  isLast: boolean;
  lastThread: AgentThread | null;
  onOpen: () => void;
}) => {
  // Sandbox status for this row: only the last thread's full doc is loaded, so
  // we surface a "sandbox" chip when we know it carries one; other rows show
  // their message count. Honest — no fabricated live/expired state.
  const hasSandbox = isLast && !!lastThread?.sandbox?.sessionId;
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
        gap: 12,
        padding: '11px 14px',
        borderRadius: 10,
        background: C.bg,
        border: `1px solid ${C.border}`,
        color: C.text,
        transition: 'border-color 150ms ease, background 150ms ease',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = C.accentBorder;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = C.border;
      }}
    >
      <span
        aria-hidden
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: 8,
          display: 'grid',
          placeItems: 'center',
          fontSize: 14,
          fontFamily: monoFamily,
          color: C.accent,
          background: C.accentSoft,
        }}
      >
        {'>_'}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13.5,
            fontWeight: 700,
            color: C.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {thread.title || 'Untitled task'}
        </span>
        <span style={{ fontSize: 12, color: C.muted }}>
          {thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}
          {thread.updatedAt ? ` · ${relTime(thread.updatedAt)}` : ''}
        </span>
      </span>
      {hasSandbox ? (
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            padding: '1px 8px',
            borderRadius: 999,
            fontFamily: monoFamily,
            color: C.okText,
            background: C.okBg,
            border: `1px solid ${C.okBorder}`,
          }}
        >
          sandbox
        </span>
      ) : null}
      <span aria-hidden style={{ color: C.muted, fontSize: 16 }}>
        →
      </span>
    </button>
  );
};

const PrefRow = ({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    <span style={{ fontSize: 12.5, color: C.muted, flex: 1, minWidth: 0 }}>
      {label}
    </span>
    <span
      style={{
        fontSize: 13,
        fontWeight: 700,
        color: C.text,
        fontFamily: mono ? monoFamily : 'inherit',
      }}
    >
      {value}
    </span>
  </div>
);

const MiniTab = ({
  on,
  onClick,
  label,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      appearance: 'none',
      cursor: 'pointer',
      padding: '4px 10px',
      fontSize: 12,
      fontWeight: 600,
      borderRadius: 7,
      color: on ? C.text : C.muted,
      background: on ? C.accentSoft : 'transparent',
      border: `1px solid ${on ? C.accentBorder : C.border}`,
      transition: 'color 150ms ease, background 150ms ease',
    }}
  >
    {label}
  </button>
);

const codeChip: CSSProperties = {
  fontFamily: monoFamily,
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 4,
  background: C.accentSoft,
  color: C.text,
};

const fileTreeWrap: CSSProperties = {
  flex: '0 0 190px',
  width: 190,
  minWidth: 150,
  borderRight: `1px solid ${C.border}`,
  overflow: 'auto',
  minHeight: 0,
};

const codeWrap: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};
