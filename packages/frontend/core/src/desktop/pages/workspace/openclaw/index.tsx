// STREAMCLIENT (C7): the FE SSE + thread client. The page owns no fetching of
// its own beyond capabilities + workspace hydration — the hooks drive the run.
// The stream hook ALREADY collects terminal/files/preview/pendingApproval for
// us (see the exact return shape below); the page reads those directly and only
// uses the `onEvent` PARAM to adopt a freshly-minted thread id.
import { api as agentApi } from '@affine/core/modules/agents/api';
import type { AgentEvent } from '@affine/core/modules/agents/types';
import { useAgentStream } from '@affine/core/modules/agents/use-agent-stream';
import { useAgentThreads } from '@affine/core/modules/agents/use-agent-threads';
// SHELL (C8): shared, polished console primitives. Pages pass STREAMCLIENT
// state down as props; SHELL never fetches. `AgentPalette` is the one shared
// token object both consoles reuse.
import {
  AgentPalette,
  ApprovalPrompt,
  Composer,
  ConversationThread,
  EmptyState,
  StatusBar,
  ThreadSidebar,
} from '@affine/core/modules/agents/components';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// CLAWX (C9): OpenClaw-specific workspace components. They resolve against
// their C9 prop signatures (documented at the bottom of this file); in an
// isolated single-file esbuild check they won't resolve — expected.
import { CodeViewer } from './code-viewer';
import { FileTree } from './file-tree';
import { PreviewPanel } from './preview-panel';
import { Terminal } from './terminal';

// ---------------------------------------------------------------------------
// OpenClaw — a real streaming coding-agent console.
//
// Type a coding task; the server-side agent (cdz-flash planner) writes files,
// runs commands in a PERSISTENT Vercel Sandbox microVM, streams stdout/stderr
// live, and — for web tasks — boots a dev server and exposes a live preview.
// Everything is driven by the two agent hooks + the SSE protocol (contract C1):
//   • useAgentThreads → the left ThreadSidebar (list/load/new/rename/delete)
//   • useAgentStream  → the run: streamingMessage (in-progress turn), status,
//     phase, terminal/files/preview (already collected), pendingApproval,
//     stop, approve. The `onEvent` PARAM taps `thread` to adopt a minted id.
//
// The right WORKSPACE panel has three tabs wired to live hook state:
//   • Files    ← hook.files deltas ∪ api.listFiles → FileTree; open →
//                api.readFile → CodeViewer
//   • Terminal ← hook.terminal (stdout/stderr) → Terminal
//   • Preview  ← hook.preview (url,status) → PreviewPanel (iframe of vercel.run)
//
// Capabilities gate the surface: sandbox enabled → runtime picker + live exec;
// disabled → a clear, honest notice that code is generated but NOT executed
// (the backend degrade path). No new .css.ts — inline styles only (house rule);
// animations are subtle and prefers-reduced-motion safe.
// ---------------------------------------------------------------------------

const C = AgentPalette.color;
const monoFamily = AgentPalette.font.mono;

interface ClawCapabilities {
  sandbox: boolean;
  reason?: string;
  plannerReady: boolean;
  runtimes: string[];
  streaming?: boolean;
}

const DEFAULT_RUNTIMES = ['node24', 'python3.13'];
const RUNTIME_LABELS: Record<string, string> = {
  node24: 'Node.js 24',
  'python3.13': 'Python 3.13',
};

// EmptyState example chips — real, runnable coding tasks that exercise write +
// run (+ preview). Passed to the SHELL EmptyState (string[] + onPickExample).
const EXAMPLES: string[] = [
  'Build a small Express API with a /health route and show it running',
  'Write a Python script that computes and prints the first 20 prime numbers',
  'Write a Node script that fetches https://jsonplaceholder.typicode.com/todos/1 and summarizes the fields',
  'Write a Python fizzbuzz function and a small test that asserts the first 15 outputs, then run the test',
];

type LoadState = 'loading' | 'ready' | 'error';
type WorkspaceTab = 'files' | 'terminal' | 'preview';

// A tracked file in the workspace panel (built from the hook's `files` deltas +
// hydrated from api.listFiles on thread load).
interface WorkspaceFile {
  path: string;
  language?: string;
  bytes?: number;
}

// The currently-open file in the CodeViewer (fetched lazily on open).
interface OpenFile {
  path: string;
  content: string;
  language?: string;
  loading: boolean;
  error?: string;
}

const OpenClawConsole = () => {
  // ---- capabilities (sandbox on/off, planner readiness, runtimes) ----------
  const [capsState, setCapsState] = useState<LoadState>('loading');
  const [caps, setCaps] = useState<ClawCapabilities | null>(null);

  // ---- threads (left sidebar) ---------------------------------------------
  const {
    threads,
    activeId,
    setActiveId,
    reload: reloadThreads,
    newThread,
    rename: renameThread,
    remove: removeThread,
    activeThread,
    loadThread,
    loadingThreads,
  } = useAgentThreads({ agent: 'openclaw' });

  // The stream hook needs to adopt a minted thread id + refresh the sidebar on
  // completion. `onEvent` is a PARAM (not a return) — it fires for every raw
  // SSE frame. We only tap `thread` (mint) and final/done (reload). Kept in a
  // ref so the callback identity is stable while still seeing fresh state.
  const activeIdRef = useRef<string | null>(activeId ?? null);
  useEffect(() => {
    activeIdRef.current = activeId ?? null;
  }, [activeId]);

  const handleStreamEvent = useCallback(
    (ev: AgentEvent) => {
      switch (ev.type) {
        case 'thread': {
          if (ev.threadId && ev.threadId !== activeIdRef.current) {
            activeIdRef.current = ev.threadId;
            setActiveId(ev.threadId);
            void reloadThreads();
          }
          break;
        }
        case 'final':
        case 'done': {
          void reloadThreads();
          break;
        }
        default:
          break;
      }
    },
    [setActiveId, reloadThreads]
  );

  // ---- run stream (conversation + status + controls + live workspace) ------
  // The hook ALREADY collects terminal/files/preview/pendingApproval — the page
  // reads them directly (no manual onEvent tapping needed for those).
  const {
    running,
    status,
    phase,
    streamingMessage,
    terminal,
    files: streamFiles,
    preview,
    pendingApproval,
    send,
    stop,
    approve,
  } = useAgentStream({ agent: 'openclaw', onEvent: handleStreamEvent });

  // ---- composer ------------------------------------------------------------
  const [input, setInput] = useState('');
  const [runtime, setRuntime] = useState(DEFAULT_RUNTIMES[0]);

  // ---- workspace panel state ----------------------------------------------
  const [tab, setTab] = useState<WorkspaceTab>('files');
  // Files hydrated from api.listFiles on thread load; the hook's live `files`
  // deltas are merged on top (see the merge memo below).
  const [hydratedFiles, setHydratedFiles] = useState<WorkspaceFile[]>([]);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  // A restored preview URL from the thread's persistent sandbox routes, used
  // only until the hook surfaces a live preview.
  const [restoredPreview, setRestoredPreview] = useState<{
    url: string;
    status: 'starting' | 'ready';
  } | null>(null);
  // Track the thread whose workspace we've hydrated, so switching threads
  // resets the panels exactly once.
  const hydratedThreadRef = useRef<string | null>(null);

  // ------------------------------------------------------------------- caps
  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      const data = await agentApi.getCapabilities('openclaw');
      const runtimes =
        Array.isArray(data?.runtimes) && data.runtimes.length > 0
          ? data.runtimes.filter((r): r is string => typeof r === 'string')
          : DEFAULT_RUNTIMES;
      setCaps({
        sandbox: !!data?.sandbox,
        reason: typeof data?.reason === 'string' ? data.reason : undefined,
        plannerReady: data?.plannerReady !== false,
        runtimes,
        streaming: data?.streaming !== false,
      });
      setCapsState('ready');
    } catch {
      setCapsState('error');
    }
  }, []);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  // Keep the selected runtime valid once real capabilities arrive.
  useEffect(() => {
    if (!caps) return;
    if (!caps.runtimes.includes(runtime)) {
      setRuntime(caps.runtimes[0] ?? DEFAULT_RUNTIMES[0]);
    }
  }, [caps, runtime]);

  // ----------------------------------------------- merged file list
  // api.listFiles snapshot ∪ the hook's live `files` deltas (deltas win, since
  // they reflect the newest write/update; `delete` deltas drop a path).
  const files = useMemo<WorkspaceFile[]>(() => {
    const byPath = new Map<string, WorkspaceFile>();
    for (const f of hydratedFiles) {
      if (f && typeof f.path === 'string') byPath.set(f.path, { ...f });
    }
    for (const d of streamFiles ?? []) {
      const delta = d as {
        op?: 'write' | 'update' | 'delete';
        path?: string;
        language?: string;
        bytes?: number;
      };
      if (!delta || typeof delta.path !== 'string') continue;
      if (delta.op === 'delete') {
        byPath.delete(delta.path);
        continue;
      }
      const prev = byPath.get(delta.path);
      byPath.set(delta.path, {
        path: delta.path,
        language: delta.language ?? prev?.language,
        bytes: typeof delta.bytes === 'number' ? delta.bytes : prev?.bytes,
      });
    }
    return Array.from(byPath.values()).sort((a, b) =>
      a.path.localeCompare(b.path)
    );
  }, [hydratedFiles, streamFiles]);

  // If the file that's open gets deleted out from under us, close the viewer.
  useEffect(() => {
    setOpenFile(prev =>
      prev && !files.some(f => f.path === prev.path) ? null : prev
    );
  }, [files]);

  // Open a file into the CodeViewer — content fetched via STREAMCLIENT api.
  const openPath = useCallback(
    async (path: string) => {
      const threadId = activeId;
      const known = files.find(f => f.path === path);
      setTab('files');
      setOpenFile({
        path,
        content: '',
        language: known?.language,
        loading: true,
      });
      if (!threadId) {
        setOpenFile({
          path,
          content: '',
          language: known?.language,
          loading: false,
          error: 'No active thread.',
        });
        return;
      }
      try {
        const file = await agentApi.readFile(threadId, path);
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
    [activeId, files]
  );

  // ----------------------------------------------- hydrate on thread switch
  // When the active thread changes, reset the panels and hydrate the file list
  // for the newly-selected thread (contract C6/C9). Terminal/preview are driven
  // live by the hook; the restored preview is recomputed below.
  useEffect(() => {
    if (hydratedThreadRef.current === activeId) return;
    hydratedThreadRef.current = activeId ?? null;
    // Reset panel state for the new (or empty) thread.
    setHydratedFiles([]);
    setOpenFile(null);
    setRestoredPreview(null);
    setTab('files');
    if (!activeId) return;

    let alive = true;
    // Full thread doc (messages + sandbox routes) into the conversation + preview.
    void loadThread(activeId);
    // File list from the persistent sandbox.
    void (async () => {
      try {
        const list = await agentApi.listFiles(activeId);
        if (!alive || !Array.isArray(list)) return;
        setHydratedFiles(
          list
            .filter(f => f && typeof f.path === 'string')
            .map(f => ({
              path: f.path,
              bytes: typeof f.bytes === 'number' ? f.bytes : undefined,
              language:
                typeof f.language === 'string' ? f.language : undefined,
            }))
        );
      } catch {
        // No sandbox / not enabled — the panel just shows its empty state.
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeId, loadThread]);

  // Restore the last preview URL once the full thread doc lands (it carries the
  // persistent sandbox's exposed routes, port 3000). Only until a live preview
  // arrives from the hook.
  useEffect(() => {
    const routes = activeThread?.sandbox?.routes;
    if (!routes || routes.length === 0) {
      setRestoredPreview(null);
      return;
    }
    const primary =
      routes.find(r => r.port === 3000)?.url ?? routes[0]?.url ?? '';
    setRestoredPreview(primary ? { url: primary, status: 'ready' } : null);
  }, [activeThread]);

  // The live preview from the hook wins; otherwise fall back to the restored
  // route URL from the thread's persistent sandbox.
  const effectivePreview = preview ?? restoredPreview;

  // Auto-switch to the Preview tab the moment a live preview is ready.
  const prevPreviewReadyRef = useRef(false);
  useEffect(() => {
    const ready = preview?.status === 'ready';
    if (ready && !prevPreviewReadyRef.current) setTab('preview');
    prevPreviewReadyRef.current = ready;
  }, [preview]);

  // --------------------------------------------------------------- derived
  const sandboxOn = capsState === 'ready' && !!caps?.sandbox;
  const plannerDown = capsState === 'ready' && caps?.plannerReady === false;
  const runtimes = caps?.runtimes ?? DEFAULT_RUNTIMES;

  const messages = useMemo(
    () => activeThread?.messages ?? [],
    [activeThread]
  );

  // ------------------------------------------------------------------- send
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || running || plannerDown) return;
    void send({
      message: text,
      threadId: activeId ?? undefined,
      runtime,
    });
    setInput('');
  }, [input, running, plannerDown, send, activeId, runtime]);

  const pickExample = useCallback((text: string) => {
    setInput(text);
  }, []);

  // ---- runtime picker (Composer leftSlot) ---------------------------------
  const runtimePicker = (
    <div
      role="radiogroup"
      aria-label="Runtime"
      style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}
      title={
        sandboxOn
          ? 'Runtime the sandbox executes in'
          : 'Runtime steers the generated language (execution is off)'
      }
    >
      {runtimes.map(rt => {
        const on = rt === runtime;
        return (
          <button
            key={rt}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={running}
            onClick={() => setRuntime(rt)}
            title={RUNTIME_LABELS[rt] ?? rt}
            style={{
              appearance: 'none',
              cursor: running ? 'default' : 'pointer',
              padding: '4px 10px',
              borderRadius: AgentPalette.radius.pill,
              fontSize: 11.5,
              fontWeight: 600,
              fontFamily: monoFamily,
              color: on ? C.onAccent : C.text,
              background: on ? C.accent : 'transparent',
              border: `1px solid ${on ? C.accent : C.border}`,
              opacity: running ? 0.6 : 1,
              transition: `background ${AgentPalette.motion.fast} ease`,
            }}
          >
            {rt}
          </button>
        );
      })}
    </div>
  );

  const hasThread = !!activeId;

  return (
    <>
      <ViewTitle title="OpenClaw" />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div style={headerStyle}>
          <span style={headerGlyphStyle}>{'>_'}</span>
          OpenClaw
          <span style={betaBadgeStyle}>béta</span>
          {capsState === 'ready' ? (
            <span
              style={{
                ...capChipStyle,
                color: sandboxOn ? C.okText : C.amber,
                background: sandboxOn ? C.okBg : C.warnBg,
                border: `1px solid ${sandboxOn ? C.okBorder : C.warnBorder}`,
              }}
              title={
                sandboxOn
                  ? 'Vercel Sandbox is enabled — tasks run live.'
                  : caps?.reason ?? 'Sandbox off — code is generated, not run.'
              }
            >
              {sandboxOn ? 'live' : 'generate-only'}
            </span>
          ) : null}
        </div>
      </ViewHeader>
      <ViewBody>
        <div style={rootStyle}>
          {/* ---- LEFT: thread sidebar (SHELL) ---- */}
          <div style={sidebarWrapStyle}>
            <ThreadSidebar
              threads={threads}
              activeId={activeId}
              onSelect={setActiveId}
              onNew={() => {
                void newThread();
              }}
              onRename={(id, title) => {
                void renameThread(id, title);
              }}
              onDelete={id => {
                void removeThread(id);
              }}
              loading={loadingThreads}
              title="Sessions"
            />
          </div>

          {/* ---- MIDDLE: conversation + composer ---- */}
          <div style={centerColStyle}>
            {/* status bar (phase chip + label + running) */}
            <div style={{ flexShrink: 0 }}>
              <StatusBar
                phase={phase ?? 'planning'}
                label={status ?? ''}
                running={running}
              />
            </div>

            {/* capabilities / planner banners */}
            {capsState === 'loading' ? (
              <Banner tone="info">Checking sandbox availability…</Banner>
            ) : capsState === 'error' ? (
              <Banner tone="error">
                Couldn&apos;t load OpenClaw capabilities.{' '}
                <button style={linkBtnStyle} onClick={() => void loadCaps()}>
                  Retry
                </button>
              </Banner>
            ) : !sandboxOn ? (
              <Banner tone="warn">
                <strong>Generated (not executed).</strong> Live execution is off,
                so OpenClaw will write &amp; explain code but won&apos;t run it.
                {caps?.reason ? (
                  <div style={{ marginTop: 4, color: C.muted, fontSize: 12 }}>
                    Reason: {caps.reason}
                  </div>
                ) : null}
              </Banner>
            ) : null}
            {plannerDown ? (
              <Banner tone="warn">
                The AI planner isn&apos;t configured — ask the owner to set{' '}
                <code style={codeChipStyle}>CDZ_AI_KEY</code>. Running is disabled
                until then.
              </Banner>
            ) : null}

            {/* conversation OR empty state */}
            <div style={conversationScrollStyle}>
              {hasThread || messages.length > 0 || streamingMessage ? (
                <ConversationThread
                  messages={messages}
                  streamingMessage={streamingMessage}
                  style={conversationInnerStyle}
                  renderExtras={
                    pendingApproval ? (
                      <div style={{ marginTop: 12 }}>
                        <ApprovalPrompt
                          request={pendingApproval}
                          onDecide={(id, decision) =>
                            void approve(id, decision)
                          }
                          disabled={!running}
                        />
                      </div>
                    ) : undefined
                  }
                />
              ) : (
                <EmptyState
                  icon="🐾"
                  title="Build something and watch it run"
                  subtitle={
                    sandboxOn
                      ? 'Describe a coding task. OpenClaw writes the files, runs them in an isolated sandbox, streams the output, and (for web apps) shows a live preview.'
                      : 'Describe a coding task. OpenClaw writes and explains the code. Live execution is off on this server, so nothing is run.'
                  }
                  examples={EXAMPLES}
                  onPickExample={pickExample}
                />
              )}
            </div>

            {/* composer — runtime picker in the leftSlot */}
            <div style={{ flexShrink: 0 }}>
              <Composer
                value={input}
                onChange={setInput}
                onSend={handleSend}
                onStop={() => void stop()}
                running={running}
                disabled={plannerDown}
                placeholder={
                  sandboxOn
                    ? 'Describe a coding task — e.g. build an Express API with a /health route and show it running'
                    : 'Describe a coding task — code will be generated but not executed'
                }
                leftSlot={runtimePicker}
              />
            </div>
          </div>

          {/* ---- RIGHT: workspace panel (Files / Terminal / Preview) ---- */}
          <div style={workspaceColStyle}>
            <WorkspaceTabs
              tab={tab}
              onTab={setTab}
              fileCount={files.length}
              terminalCount={terminal.length}
              previewReady={effectivePreview?.status === 'ready'}
              running={running}
            />
            <div style={workspaceBodyStyle}>
              {tab === 'files' ? (
                <div style={filesLayoutStyle}>
                  <div style={fileTreeWrapStyle}>
                    <FileTree
                      files={files}
                      activePath={openFile?.path}
                      onOpen={path => void openPath(path)}
                    />
                  </div>
                  <div style={codeViewerWrapStyle}>
                    {openFile ? (
                      openFile.loading ? (
                        <CodeViewer path={openFile.path} loading />
                      ) : openFile.error ? (
                        <PanelHint tone="error">{openFile.error}</PanelHint>
                      ) : (
                        <CodeViewer
                          path={openFile.path}
                          content={openFile.content}
                          language={openFile.language}
                        />
                      )
                    ) : (
                      <PanelHint>
                        {files.length > 0
                          ? 'Select a file to view it.'
                          : 'Files the agent writes will appear here.'}
                      </PanelHint>
                    )}
                  </div>
                </div>
              ) : tab === 'terminal' ? (
                <Terminal lines={terminal} />
              ) : (
                <PreviewPanel
                  url={effectivePreview?.url}
                  status={
                    effectivePreview?.status ?? (running ? 'starting' : 'ready')
                  }
                  onRefresh={() => {
                    // Bounce the restored URL to force the iframe to reload.
                    setRestoredPreview(p => (p ? { ...p } : p));
                  }}
                />
              )}
            </div>
          </div>
        </div>

        {/* Page-scoped keyframes + prefers-reduced-motion guards. */}
        <style>
          {`
@keyframes cdz-openclaw-spin{to{transform:rotate(360deg)}}
.cdz-openclaw-spinner{animation:cdz-openclaw-spin .7s linear infinite}
@media (prefers-reduced-motion: reduce){
  .cdz-openclaw-spinner{animation:none !important}
}
`}
        </style>
      </ViewBody>
    </>
  );
};

// ---- workspace tabs strip -------------------------------------------------
const WorkspaceTabs = ({
  tab,
  onTab,
  fileCount,
  terminalCount,
  previewReady,
  running,
}: {
  tab: WorkspaceTab;
  onTab: (t: WorkspaceTab) => void;
  fileCount: number;
  terminalCount: number;
  previewReady: boolean;
  running: boolean;
}) => {
  const tabs: {
    id: WorkspaceTab;
    label: string;
    badge?: string;
    dot?: boolean;
  }[] = [
    {
      id: 'files',
      label: 'Files',
      badge: fileCount > 0 ? String(fileCount) : undefined,
    },
    {
      id: 'terminal',
      label: 'Terminal',
      dot: running && terminalCount > 0,
    },
    {
      id: 'preview',
      label: 'Preview',
      dot: previewReady,
    },
  ];
  return (
    <div style={tabsBarStyle} role="tablist" aria-label="Workspace">
      {tabs.map(t => {
        const on = t.id === tab;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onTab(t.id)}
            style={{
              appearance: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 14px',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: monoFamily,
              cursor: 'pointer',
              color: on ? C.text : C.muted,
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${on ? C.accent : 'transparent'}`,
              transition: `color ${AgentPalette.motion.fast} ease`,
            }}
          >
            {t.label}
            {t.badge ? (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '0 6px',
                  borderRadius: 999,
                  color: C.muted,
                  background: C.accentSoft,
                }}
              >
                {t.badge}
              </span>
            ) : null}
            {t.dot ? (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: C.accent,
                  flexShrink: 0,
                }}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
};

// ---- small inline-styled helpers -----------------------------------------
const PanelHint = ({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: 'error';
}) => (
  <div
    style={{
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      textAlign: 'center',
      fontSize: 13,
      color: tone === 'error' ? C.errText : C.muted,
    }}
  >
    {children}
  </div>
);

const Banner = ({
  tone,
  children,
}: {
  tone: 'info' | 'warn' | 'error' | 'ok';
  children: ReactNode;
}) => {
  const map = {
    info: { bg: C.accentSoft, border: C.border, color: C.text },
    ok: { bg: C.okBg, border: C.okBorder, color: C.text },
    warn: { bg: C.warnBg, border: C.warnBorder, color: C.text },
    error: { bg: C.errBg, border: C.errBorder, color: C.text },
  }[tone];
  return (
    <div
      style={{
        flexShrink: 0,
        margin: '0 0 4px',
        padding: '10px 14px',
        borderRadius: AgentPalette.radius.md,
        fontSize: 13,
        background: map.bg,
        border: `1px solid ${map.border}`,
        color: map.color,
      }}
    >
      {children}
    </div>
  );
};

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

const codeChipStyle: CSSProperties = {
  fontFamily: monoFamily,
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 4,
  background: C.accentSoft,
  color: C.text,
};

// ---- layout style objects -------------------------------------------------
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: '100%',
  padding: '0 16px',
  fontSize: 14,
  fontWeight: 600,
  color: C.text,
};
const headerGlyphStyle: CSSProperties = {
  fontFamily: monoFamily,
  fontWeight: 700,
  fontSize: 13,
  color: C.accent,
};
const betaBadgeStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  lineHeight: '15px',
  padding: '0 6px',
  borderRadius: 5,
  letterSpacing: '0.05em',
  color: C.muted,
  backgroundColor:
    'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)',
};
const capChipStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  padding: '1px 8px',
  borderRadius: 999,
  fontFamily: monoFamily,
};

const rootStyle: CSSProperties = {
  height: '100%',
  width: '100%',
  display: 'flex',
  alignItems: 'stretch',
  background: C.bg,
  color: C.text,
  fontSize: 13,
  lineHeight: 1.5,
  minHeight: 0,
  overflow: 'hidden',
  // Responsive: the workspace panel drops below a comfortable width; the
  // conversation column always stays. flexWrap lets the three panes reflow.
  flexWrap: 'wrap',
};

const sidebarWrapStyle: CSSProperties = {
  flex: '0 0 250px',
  width: 250,
  minWidth: 200,
  maxWidth: 300,
  borderRight: `1px solid ${C.border}`,
  background: C.panel,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

const centerColStyle: CSSProperties = {
  flex: '1 1 460px',
  minWidth: 360,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 14px',
  minHeight: 0,
  overflow: 'hidden',
};

const conversationScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: '4px 2px',
};

const conversationInnerStyle: CSSProperties = {
  minHeight: '100%',
};

const workspaceColStyle: CSSProperties = {
  flex: '1 1 420px',
  minWidth: 340,
  display: 'flex',
  flexDirection: 'column',
  borderLeft: `1px solid ${C.border}`,
  background: C.panel,
  minHeight: 0,
  overflow: 'hidden',
};

const tabsBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  flexShrink: 0,
  padding: '0 8px',
  borderBottom: `1px solid ${C.border}`,
  background: C.panel,
};

const workspaceBodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

const filesLayoutStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  alignItems: 'stretch',
};

const fileTreeWrapStyle: CSSProperties = {
  flex: '0 0 200px',
  width: 200,
  minWidth: 160,
  borderRight: `1px solid ${C.border}`,
  overflow: 'auto',
  minHeight: 0,
};

const codeViewerWrapStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

export const Component = () => {
  return <OpenClawConsole />;
};

// ---------------------------------------------------------------------------
// CLAWX prop contract (what this page passes — CLAWX must match these shapes):
//
//   FileTree({
//     files: { path: string; language?: string; bytes?: number }[];
//     activePath?: string;
//     onOpen: (path: string) => void;
//   })
//
//   CodeViewer({
//     path?: string;
//     content?: string;
//     language?: string;   // may be absent — derive from `path` extension
//     loading?: boolean;
//   })                     // reuses ./code-block CodeBlock for highlighting
//
//   Terminal({
//     lines: { stream: 'stdout' | 'stderr'; data: string }[];
//   })                     // live append + autoscroll, monospace
//
//   PreviewPanel({
//     url?: string;                         // undefined while no preview yet
//     status?: 'starting' | 'ready';
//     onRefresh?: () => void;
//   })                     // iframe of the vercel.run URL + refresh/open-in-new
// ---------------------------------------------------------------------------
