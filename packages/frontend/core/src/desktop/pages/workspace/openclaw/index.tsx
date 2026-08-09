// STREAMCLIENT (C7): the FE SSE + thread client. The page owns no fetching of
// its own beyond capabilities + config + workspace hydration — the hooks drive
// the run. The stream hook ALREADY collects terminal/files/preview/
// pendingApproval for us (see the exact return shape below); the console reads
// those directly and only uses the `onEvent` PARAM to adopt a freshly-minted
// thread id.
import * as agentApi from '@affine/core/modules/agents/api';
import type { AgentEvent } from '@affine/core/modules/agents/types';
import { useAgentStream } from '@affine/core/modules/agents/use-agent-stream';
import { useAgentThreads } from '@affine/core/modules/agents/use-agent-threads';
// SHELL (C8): shared, polished console primitives. Pages pass STREAMCLIENT
// state down as props; SHELL never fetches. `AgentPalette` is the one shared
// token object both consoles reuse.
import {
  accentFor,
  AgentPalette,
  AgentPresence,
  ApprovalPrompt,
  ArtifactsPanel,
  Composer,
  ConversationThread,
  EmptyState,
  StatusBar,
  type StatusPhase,
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

import { ensureClickDzResponsiveCss } from '@affine/core/clickdz/responsive';
// CLAWX (C9): OpenClaw-specific workspace components. They resolve against
// their C9 prop signatures (documented at the bottom of this file); in an
// isolated single-file esbuild check they won't resolve — expected.
import { CodeViewer } from './code-viewer';
import { OpenClawDashboard } from './dashboard';
// R11 (INVERSION): the code-review diff moment — mounted in the workspace hero
// when the agent rewrites an EXISTING file (red/green unified diff + Appliquer/
// Rejeter). Pure presentational; see ./diff-view.
import { DiffView } from './diff-view';
import { FileTree } from './file-tree';
import {
  Banner as StudioBanner,
  type ClawCapabilities,
  getCapabilities,
  getConfig,
  type OpenClawConfig,
  Spinner as StudioSpinner,
} from './openclaw-shared';
import { PreviewPanel } from './preview-panel';
import { Terminal } from './terminal';
import { OpenClawWizard } from './wizard';

// ---------------------------------------------------------------------------
// OpenClaw — a per-user coding studio built on a real streaming coding console.
//
// The page is a STATE MACHINE mirroring the ShopERP onboarding pattern
// (shoperp/index.tsx): on mount it GETs the per-user config + capabilities.
//   • !provisioned            → the ONBOARDING WIZARD (set up your agent)
//   • provisioned + dashboard → the DASHBOARD (recent tasks, sandbox status,
//                               runtime pref, last project files/preview) with
//                               the streaming console reachable via "New task"
//                               / opening a thread
//   • provisioned + console   → the live coding console (below), the exact
//                               surface that shipped, wired to the two agent
//                               hooks + the SSE protocol (contract C1):
//       useAgentThreads → the left ThreadSidebar (list/load/new/rename/delete)
//       useAgentStream  → the run: streamingMessage, status, phase,
//                         terminal/files/preview (already collected),
//                         pendingApproval, stop, approve.
//
// Capabilities gate the surface honestly: sandbox enabled → live exec; disabled
// → a clear notice (with the backend's real reason, C6) that code is generated
// but NOT executed. No new .css.ts — inline styles only; motion is subtle and
// prefers-reduced-motion safe.
// ---------------------------------------------------------------------------

const C = AgentPalette.color;
const monoFamily = AgentPalette.font.mono;
// OpenClaw identity accent (R10 / WS11-3): phosphor-green #6bd968 + cyan
// #56b6ff for filenames/links. Layered on the shared AgentPalette — `C` keeps
// the shared surface/status tints (ok/warn/err verbatim); only the accent
// family reads as OpenClaw's terminal green, giving the mono-forward chrome its
// live/run signal. Nothing here changes behavior, routes, exports or testIds.
const OC = accentFor('openclaw');

const DEFAULT_RUNTIMES = ['node24', 'python3.13'];
const RUNTIME_LABELS: Record<string, string> = {
  node24: 'Node.js 24',
  'python3.13': 'Python 3.13',
};

// EmptyState example chips — real, runnable coding tasks that exercise write +
// run (+ preview). Passed to the SHELL EmptyState (string[] + onPickExample).
const EXAMPLES: string[] = [
  'Construire une petite API Express avec une route /health et la voir s'exécuter',
  'Écrire un script Python qui calcule et affiche les 20 premiers nombres premiers',
  'Écrire un script Node qui récupère https://jsonplaceholder.typicode.com/todos/1 et résume les champs',
  'Écrire une fonction Python fizzbuzz et un petit test qui vérifie les 15 premières sorties, puis exécuter le test',
];

// Inject the shared CDZ responsive stylesheet once (idempotent). Rendered as a
// null component so it sits inside the React tree without disturbing hook order.
const CdzResponsive = () => {
  ensureClickDzResponsiveCss();
  return null;
};

type LoadState = 'loading' | 'ready' | 'error';
type WorkspaceTab = 'files' | 'terminal' | 'preview';
// The three top-level page views.
type View = 'wizard' | 'dashboard' | 'console';

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

// ===========================================================================
// PAGE — the state machine (config gate → wizard / dashboard / console).
// ===========================================================================

const OpenClawPage = () => {
  // ---- config + capabilities (fetched once on mount) ----------------------
  const [bootState, setBootState] = useState<LoadState>('loading');
  const [config, setConfig] = useState<OpenClawConfig | null>(null);
  const [caps, setCaps] = useState<ClawCapabilities | null>(null);
  const [capsState, setCapsState] = useState<LoadState>('loading');

  // View orchestration. `forceWizard` re-runs onboarding over an existing
  // config; `consoleSeed` carries a prompt from the dashboard into the console;
  // `consoleThreadId` opens a specific thread.
  const [view, setView] = useState<View>('dashboard');
  const [forceWizard, setForceWizard] = useState(false);
  const [consoleSeed, setConsoleSeed] = useState<string | undefined>(undefined);
  const [consoleThreadId, setConsoleThreadId] = useState<string | null>(null);

  // Re-probe capabilities (wizard/dashboard recheck buttons).
  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      const data = await getCapabilities();
      setCaps(data);
      setCapsState('ready');
    } catch {
      setCapsState('error');
    }
  }, []);

  const loadBoot = useCallback(async () => {
    setBootState('loading');
    setCapsState('loading');
    // Config + capabilities in parallel; the config drives the gate, caps drive
    // the honest sandbox status. Capability failure is non-fatal (the page still
    // opens; the sandbox card shows the error + a recheck).
    const [cfgRes, capRes] = await Promise.allSettled([
      getConfig(),
      getCapabilities(),
    ]);
    if (cfgRes.status === 'fulfilled') {
      setConfig(cfgRes.value);
      setBootState('ready');
    } else {
      setBootState('error');
    }
    if (capRes.status === 'fulfilled') {
      setCaps(capRes.value);
      setCapsState('ready');
    } else {
      setCapsState('error');
    }
  }, []);

  useEffect(() => {
    void loadBoot();
  }, [loadBoot]);

  const provisioned = config?.provisioned === true;
  const showWizard = bootState === 'ready' && (!provisioned || forceWizard);

  // Keep `view` coherent with provisioning: an unprovisioned user is always in
  // the wizard; a provisioned user defaults to the dashboard.
  useEffect(() => {
    if (bootState !== 'ready') return;
    if (!provisioned) {
      setView('wizard');
    } else if (view === 'wizard' && !forceWizard) {
      setView('dashboard');
    }
  }, [bootState, provisioned, forceWizard, view]);

  // ---- view transitions ---------------------------------------------------
  const handleWizardDone = useCallback((saved: OpenClawConfig) => {
    setConfig(saved);
    setForceWizard(false);
    setView('dashboard');
  }, []);

  const openConsoleNew = useCallback((seed?: string) => {
    setConsoleThreadId(null);
    setConsoleSeed(seed);
    setView('console');
  }, []);

  const openConsoleThread = useCallback((id: string) => {
    setConsoleThreadId(id);
    setConsoleSeed(undefined);
    setView('console');
  }, []);

  const backToDashboard = useCallback(() => {
    setConsoleSeed(undefined);
    setView('dashboard');
  }, []);

  // ------------------------------------------------------------------ header
  // Sandbox status lamp — an honest instrument, not a flat chip. Maps the
  // capabilities the page already tracks onto the shared <AgentPresence> lamp
  // via StatusPhase: sandbox live → green (done), generate-only → amber
  // (waiting_approval), still loading → grey (stopped), caps load failed →
  // red (error). The terse mono label rides alongside the dot.
  const headerLampPhase: StatusPhase =
    capsState === 'loading'
      ? 'stopped'
      : capsState === 'error'
        ? 'error'
        : caps?.sandbox
          ? 'done'
          : 'waiting_approval';
  const headerLampLabel =
    capsState === 'loading'
      ? 'boot…'
      : capsState === 'error'
        ? 'sandbox down'
        : caps?.sandbox
          ? 'live'
          : 'generate-only';
  const headerLampTitle =
    capsState === 'loading'
      ? 'Sonde du sandbox…'
      : capsState === 'error'
        ? 'Échec du chargement des capacités du sandbox.'
        : caps?.sandbox
          ? 'Le sandbox Vercel est activé — les tâches s'exécutent en direct.'
          : caps?.reason ?? 'Sandbox désactivé — le code est généré, pas exécuté.';
  const headerChip = (
    <span style={capChipStyle} title={headerLampTitle}>
      <AgentPresence
        agent="openclaw"
        phase={headerLampPhase}
        size={7}
        title={headerLampTitle}
      />
      {headerLampLabel}
    </span>
  );

  return (
    <>
      <ViewTitle title="OpenClaw" />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div data-cdz-actions="" style={headerStyle}>
          <span style={headerGlyphStyle}>{'>_'}</span>
          OpenClaw
          <span style={betaBadgeStyle}>béta</span>
          {headerChip}
          {view === 'console' && provisioned ? (
            <button
              style={headerBackBtnStyle}
              onClick={backToDashboard}
              title="Retour au tableau de bord"
            >
              ← Tableau de bord
            </button>
          ) : null}
        </div>
      </ViewHeader>
      <ViewBody>
        <CdzResponsive />
        {view === 'console' && provisioned ? (
          // The live coding console fills the whole body (its own 3-pane layout).
          <OpenClawConsole
            caps={caps}
            capsState={capsState}
            onReloadCaps={loadCaps}
            initialThreadId={consoleThreadId}
            seedInput={consoleSeed}
            defaultRuntime={config?.defaultRuntime}
            previewAutoOpen={config?.previewAutoOpen !== false}
          />
        ) : (
          // Wizard + dashboard share a centered, scrollable canvas (matches the
          // ShopERP onboarding surface).
          <div data-cdz-surface="" style={studioScrollStyle}>
            <div style={studioInnerStyle}>
              {bootState === 'loading' ? (
                <div style={studioLoadingStyle}>
                  <span style={{ fontFamily: monoFamily, color: OC.accent }}>
                    {'>_'}
                  </span>
                  <StudioSpinner /> Démarrage d'OpenClaw…
                </div>
              ) : bootState === 'error' ? (
                <StudioBanner tone="error">
                  Impossible de charger votre configuration OpenClaw.{' '}
                  <button style={linkBtnStyle} onClick={() => void loadBoot()}>
                    Réessayer
                  </button>
                </StudioBanner>
              ) : showWizard ? (
                <OpenClawWizard
                  caps={caps}
                  capsState={capsState}
                  onReloadCaps={loadCaps}
                  onDone={handleWizardDone}
                  onCancel={
                    provisioned ? () => setForceWizard(false) : undefined
                  }
                  hasExisting={provisioned}
                  initial={config}
                />
              ) : config ? (
                <OpenClawDashboard
                  config={config}
                  caps={caps}
                  capsState={capsState}
                  onReloadCaps={loadCaps}
                  onNewTask={openConsoleNew}
                  onOpenThread={openConsoleThread}
                  onReconfigure={() => setForceWizard(true)}
                />
              ) : null}
            </div>
          </div>
        )}
      </ViewBody>
    </>
  );
};

// ===========================================================================
// CONSOLE — the streaming coding console (the surface that shipped), extracted
// into a component so the dashboard can hand it a seed prompt / thread id and
// so the page can toggle between studio views. Behavior is unchanged.
// ===========================================================================

const OpenClawConsole = ({
  caps,
  capsState,
  onReloadCaps,
  initialThreadId,
  seedInput,
  defaultRuntime,
  previewAutoOpen,
}: {
  caps: ClawCapabilities | null;
  capsState: LoadState;
  onReloadCaps: () => void;
  initialThreadId: string | null;
  seedInput?: string;
  defaultRuntime?: string;
  previewAutoOpen: boolean;
}) => {
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

  // Open the requested thread once on mount (from the dashboard). A null id
  // means "new task" — leave the composer empty/seeded.
  const appliedInitialRef = useRef(false);
  useEffect(() => {
    if (appliedInitialRef.current) return;
    appliedInitialRef.current = true;
    if (initialThreadId) {
      setActiveId(initialThreadId);
    } else {
      newThread();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The stream hook needs to adopt a minted thread id + refresh the sidebar on
  // completion. `onEvent` is a PARAM (not a return) — it fires for every raw
  // SSE frame. We only tap `thread` (mint) and `final` (reload). Kept in a
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
        // NOTE: the `done` sentinel never reaches onEvent — use-agent-stream
        // consumes it internally and closes the stream without dispatching.
        case 'final': {
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
    artifacts,
    pendingApproval,
    send,
    stop,
    approve,
  } = useAgentStream({ agent: 'openclaw', onEvent: handleStreamEvent });

  // ---- composer ------------------------------------------------------------
  const [input, setInput] = useState(seedInput ?? '');
  const [runtime, setRuntime] = useState(
    defaultRuntime ?? DEFAULT_RUNTIMES[0]
  );

  // ---- workspace panel state ----------------------------------------------
  const [tab, setTab] = useState<WorkspaceTab>('files');
  const [hydratedFiles, setHydratedFiles] = useState<WorkspaceFile[]>([]);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [restoredPreview, setRestoredPreview] = useState<{
    url: string;
    status: 'starting' | 'ready';
  } | null>(null);
  const hydratedThreadRef = useRef<string | null>(null);

  // ---- R11 (INVERSION) presentational state -------------------------------
  // The layout is inverted: the workspace is the CENTER hero; the chat is a
  // COLLAPSIBLE right copilot rail; the sidebar can collapse too. These flags
  // are pure UI — they change nothing about the run, the hooks, or the data.
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Code-review diff moment. `fileSnapshots` caches the last-seen CONTENT of
  // files we've already read from the sandbox (populated on open + on a diff
  // review). When a run writes to a path we already have a snapshot for (i.e.
  // an EXISTING file), we fetch the new content and stage a <DiffView> in the
  // hero before adopting it. This taps the SAME api the viewer uses — no hook
  // or stream logic changes; it only surfaces the write the tree already shows.
  const fileSnapshots = useRef<Map<string, string>>(new Map());
  const [diff, setDiff] = useState<{
    path: string;
    old: string;
    next: string;
  } | null>(null);
  // Guard so a diff is staged at most once per distinct write signature (a
  // review the user dismissed doesn't immediately re-open on the next render).
  const diffSeenRef = useRef<Set<string>>(new Set());

  // Ship card — a "Livré ✓" summary shown in the rail when a run finishes with
  // artifacts. `shipped` latches the artifacts captured at the done frame; it's
  // reset when a new run starts or the thread changes. Reuses <ArtifactsPanel>.
  const [shipped, setShipped] = useState<typeof artifacts | null>(null);

  // Keep the selected runtime valid once real capabilities arrive.
  useEffect(() => {
    if (!caps) return;
    if (!caps.runtimes.includes(runtime)) {
      setRuntime(caps.runtimes[0] ?? DEFAULT_RUNTIMES[0]);
    }
  }, [caps, runtime]);

  // ----------------------------------------------- merged file list
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
          error: 'Aucun fil de discussion actif.',
        });
        return;
      }
      try {
        const file = await agentApi.readFile(threadId, path);
        const content = typeof file.content === 'string' ? file.content : '';
        // Cache the content so a later write to this path can be diff-reviewed.
        fileSnapshots.current.set(file.path ?? path, content);
        setOpenFile({
          path: file.path ?? path,
          content,
          language: file.language ?? known?.language,
          loading: false,
        });
      } catch {
        setOpenFile({
          path,
          content: '',
          language: known?.language,
          loading: false,
          error: 'Impossible de lire ce fichier depuis le sandbox.',
        });
      }
    },
    [activeId, files]
  );

  // ----------------------------------------------- hydrate on thread switch
  useEffect(() => {
    if (hydratedThreadRef.current === activeId) return;
    hydratedThreadRef.current = activeId ?? null;
    setHydratedFiles([]);
    setOpenFile(null);
    setRestoredPreview(null);
    setTab('files');
    // R11: switching threads clears the diff-review + ship card + snapshots.
    setDiff(null);
    setShipped(null);
    fileSnapshots.current.clear();
    diffSeenRef.current.clear();
    if (!activeId) return;

    let alive = true;
    void loadThread(activeId);
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

  // Restore the last preview URL once the full thread doc lands.
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

  const effectivePreview = preview ?? restoredPreview;

  // Auto-switch to the Preview tab the moment a live preview is ready — honors
  // the user's config.previewAutoOpen preference.
  const prevPreviewReadyRef = useRef(false);
  useEffect(() => {
    const ready = preview?.status === 'ready';
    if (ready && !prevPreviewReadyRef.current && previewAutoOpen) {
      setTab('preview');
    }
    prevPreviewReadyRef.current = ready;
  }, [preview, previewAutoOpen]);

  // ---- R11 (INVERSION): live-build affordance ------------------------------
  // "building…" reads as active whenever a run is streaming file writes — the
  // hero's subtle signal that the tree below is filling in real time. Derived
  // only; it drives a chip, nothing else.
  const building = running && (streamFiles?.length ?? 0) > 0;

  // ---- R11: code-review diff moment ---------------------------------------
  // Watch the stream's file deltas. When a write/update targets a path we have
  // a cached snapshot for (an EXISTING file) and we haven't already staged that
  // exact write, fetch the fresh content and open a <DiffView> in the hero. The
  // read uses the SAME api the viewer uses; we never mutate the run.
  useEffect(() => {
    const deltas = streamFiles ?? [];
    if (deltas.length === 0) return;
    const threadId = activeId;
    if (!threadId) return;
    // Only the most recent delta can be "new"; scan from the end for the first
    // write/update whose path we can diff and haven't shown yet.
    for (let i = deltas.length - 1; i >= 0; i--) {
      const d = deltas[i] as {
        op?: 'write' | 'update' | 'delete';
        path?: string;
      };
      if (!d || typeof d.path !== 'string') continue;
      if (d.op === 'delete') continue;
      const sig = `${i}:${d.path}`;
      if (diffSeenRef.current.has(sig)) continue;
      const old = fileSnapshots.current.get(d.path);
      if (typeof old !== 'string') continue; // not an existing (known) file
      diffSeenRef.current.add(sig);
      const path = d.path;
      void (async () => {
        try {
          const file = await agentApi.readFile(threadId, path);
          const next = typeof file.content === 'string' ? file.content : '';
          if (next === old) return; // no textual change → skip the review
          setDiff({ path, old, next });
        } catch {
          // Read failed (no sandbox / gone) — silently skip; the write still
          // shows in the tree exactly as before.
        }
      })();
      break;
    }
  }, [streamFiles, activeId]);

  // ---- R11: adopt / discard a staged diff --------------------------------
  const applyDiff = useCallback(() => {
    setDiff(cur => {
      if (cur) {
        // Adopt: the new content becomes the snapshot + the open file.
        fileSnapshots.current.set(cur.path, cur.next);
        setOpenFile({ path: cur.path, content: cur.next, loading: false });
        setTab('files');
      }
      return null;
    });
  }, []);
  const rejectDiff = useCallback(() => {
    // Discard the review; keep the previously-known version as the snapshot.
    setDiff(null);
  }, []);

  // ---- R11: ship card ----------------------------------------------------
  // Latch the artifacts a run produced when it stops (running → false). Reset
  // the card the moment a new run starts so each run gets its own "Livré ✓".
  const prevRunningRef = useRef(running);
  useEffect(() => {
    const was = prevRunningRef.current;
    prevRunningRef.current = running;
    if (running && !was) {
      setShipped(null); // new run started
      return;
    }
    if (!running && was && (artifacts?.length ?? 0) > 0) {
      setShipped(artifacts);
    }
  }, [running, artifacts]);

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
      runtime: runtime as 'node24' | 'python3.13',
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
      aria-label="Environnement d'exécution"
      style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}
      title={
        sandboxOn
          ? "L'environnement d'exécution du sandbox"
          : "L'environnement guide le langage généré (l'exécution est désactivée)"
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
              color: on ? C.consoleBg : C.text,
              background: on ? OC.accent : 'transparent',
              border: `1px solid ${on ? OC.accent : C.border}`,
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
    <div data-cdz-surface="" data-cdz-shell="" style={rootStyle}>
      {/* =====================================================================
          R11 INVERSION — the WORKSPACE is the hero. Column order:
            LEFT  : project/thread sidebar (collapsible)
            CENTER: workspace hero (Files / Terminal / Preview) — WIDEST
            RIGHT : copilot rail (chat + composer + ship card) — collapsible
          Same components, same props, same data flows as before; only the
          arrangement + widths change. The chat rail carries the composer.
         ===================================================================== */}

      {/* ---- LEFT: thread sidebar (SHELL) — collapsible ---- */}
      {sidebarCollapsed ? (
        <div style={sidebarStripStyle}>
          <button
            type="button"
            style={stripBtnStyle}
            onClick={() => setSidebarCollapsed(false)}
            title="Afficher les projets"
            aria-label="Afficher les projets"
          >
            <span style={{ fontFamily: monoFamily }}>☰</span>
          </button>
        </div>
      ) : (
        <div data-cdz-rail="" style={sidebarWrapStyle}>
          <div style={railHeadStyle}>
            <span style={railHeadLabelStyle}>Projets</span>
            <button
              type="button"
              style={railToggleBtnStyle}
              onClick={() => setSidebarCollapsed(true)}
              title="Réduire les projets"
              aria-label="Réduire les projets"
            >
              ⟨
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
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
        </div>
      )}

      {/* ---- CENTER (HERO): workspace — Files / Terminal / Preview ---- */}
      <div data-cdz-main="" style={heroColStyle}>
        {/* hero header — mono chrome: tabs live below; this strip carries the
            live-build affordance + the rail toggle when the rail is hidden. */}
        <div data-cdz-actions="" style={heroHeadStyle}>
          <span style={heroTitleStyle}>{'>_'} Espace de travail</span>
          {building ? (
            <span style={buildingChipStyle} title="Les fichiers arrivent en flux">
              <AgentPresence
                agent="openclaw"
                phase="writing"
                running
                size={7}
              />
              construction…
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          {railCollapsed ? (
            <button
              type="button"
              style={heroRailBtnStyle}
              onClick={() => setRailCollapsed(false)}
              title="Afficher le copilote"
              aria-label="Afficher le copilote"
            >
              Copilote ⟩
            </button>
          ) : null}
        </div>

        <WorkspaceTabs
          tab={tab}
          onTab={setTab}
          fileCount={files.length}
          terminalCount={terminal.length}
          previewReady={effectivePreview?.status === 'ready'}
          running={running}
        />
        <div style={workspaceBodyStyle}>
          {diff ? (
            // Code-review diff moment — a rewrite of an existing file waits for
            // review here, in the hero, before it's adopted.
            <div style={diffLayoutStyle}>
              <DiffView
                old={diff.old}
                new={diff.next}
                path={diff.path}
                onApply={applyDiff}
                onReject={rejectDiff}
              />
            </div>
          ) : tab === 'files' ? (
            <div data-cdz-shell="" style={filesLayoutStyle}>
              <div data-cdz-panel="" style={fileTreeWrapStyle}>
                <FileTree
                  files={files}
                  activePath={openFile?.path}
                  onOpen={path => void openPath(path)}
                />
              </div>
              <div data-cdz-main="" style={codeViewerWrapStyle}>
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
                      ? 'Sélectionnez un fichier pour le consulter.'
                      : 'Les fichiers écrits par l'agent apparaîtront ici.'}
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
                setRestoredPreview(p => (p ? { ...p } : p));
              }}
            />
          )}
        </div>
      </div>

      {/* ---- RIGHT: copilot rail (conversation + composer) — collapsible ---- */}
      {railCollapsed ? (
        <div style={railStripStyle}>
          <button
            type="button"
            style={stripBtnStyle}
            onClick={() => setRailCollapsed(false)}
            title="Afficher le copilote"
            aria-label="Afficher le copilote"
          >
            <span style={{ fontFamily: monoFamily }}>💬</span>
          </button>
        </div>
      ) : (
        <div data-cdz-panel="" style={copilotColStyle}>
          <div style={railHeadStyle}>
            <button
              type="button"
              style={railToggleBtnStyle}
              onClick={() => setRailCollapsed(true)}
              title="Réduire le copilote"
              aria-label="Réduire le copilote"
            >
              ⟩
            </button>
            <span style={railHeadLabelStyle}>Copilote</span>
          </div>

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
            <Banner tone="info">Vérification de la disponibilité du sandbox…</Banner>
          ) : capsState === 'error' ? (
            <Banner tone="error">
              Impossible de charger les capacités d'OpenClaw.{' '}
              <button style={linkBtnStyle} onClick={onReloadCaps}>
                Réessayer
              </button>
            </Banner>
          ) : !sandboxOn ? (
            <Banner tone="warn">
              <strong>Génération uniquement — sandbox désactivé.</strong> Le code est écrit
              et expliqué, mais rien n'est exécuté. Pas d'exécution, pas de ports, pas d'aperçu.
              {caps?.reason ? (
                <div style={{ marginTop: 4, color: C.muted, fontSize: 12 }}>
                  Raison : {caps.reason}
                </div>
              ) : null}
            </Banner>
          ) : null}
          {plannerDown ? (
            <Banner tone="warn">
              Le planificateur IA n'est pas configuré — demandez au propriétaire de définir{' '}
              <code style={codeChipStyle}>CDZ_AI_KEY</code>. L'exécution est désactivée
              en attendant.
            </Banner>
          ) : null}

          {/* conversation OR empty state */}
          <div style={conversationScrollStyle}>
            {shipped && shipped.length > 0 ? (
              // Ship card — "Livré ✓" summary of what the run produced. Reuses
              // the shared ArtifactsPanel to render the artifacts.
              <div style={shipCardStyle}>
                <div style={shipHeadStyle}>
                  <span style={{ color: OC.accent, fontWeight: 800 }}>✓</span>
                  <span>Livré</span>
                  <span style={{ color: C.muted, fontWeight: 600 }}>
                    · {shipped.length}{' '}
                    {shipped.length === 1 ? 'artefact' : 'artefacts'}
                  </span>
                </div>
                <ArtifactsPanel artifacts={shipped} />
              </div>
            ) : null}
            {hasThread || messages.length > 0 || streamingMessage ? (
              <ConversationThread
                messages={messages}
                streamingMessage={streamingMessage}
                style={conversationInnerStyle}
                renderExtras={(_message, isStreaming) =>
                  // renderExtras is a RENDER CALLBACK (ConversationThread calls
                  // it per bubble) — passing a bare element here used to make
                  // `renderExtras?.(m, false)` throw. Mirror hermes: render the
                  // approval prompt beneath the streaming assistant message.
                  isStreaming && pendingApproval ? (
                    <div style={{ marginTop: 12 }}>
                      <ApprovalPrompt
                        request={pendingApproval}
                        onDecide={(id, decision) => void approve(id, decision)}
                        disabled={!running}
                      />
                    </div>
                  ) : null
                }
              />
            ) : (
              <EmptyState
                icon="🐾"
                title="Construisez quelque chose et regardez-le s'exécuter"
                subtitle={
                  sandboxOn
                    ? "Décrivez une tâche de codage. OpenClaw écrit les fichiers, les exécute dans un sandbox isolé, diffuse la sortie, et (pour les applications web) affiche un aperçu en direct."
                    : "Décrivez une tâche de codage. OpenClaw écrit et explique le code. L'exécution en direct est désactivée sur ce serveur, rien n'est exécuté."
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
              autoFocus
              placeholder={
                sandboxOn
                  ? "Décrivez une tâche de codage — ex : construire une API Express avec une route /health et la voir s'exécuter"
                  : 'Décrivez une tâche de codage — le code sera généré mais pas exécuté'
              }
              leftSlot={runtimePicker}
            />
          </div>
        </div>
      )}

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
    </div>
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
      label: 'Fichiers',
      badge: fileCount > 0 ? String(fileCount) : undefined,
    },
    {
      id: 'terminal',
      label: 'Terminal',
      dot: running && terminalCount > 0,
    },
    {
      id: 'preview',
      label: 'Aperçu',
      dot: previewReady,
    },
  ];
  return (
    <div data-cdz-actions="" style={tabsBarStyle} role="tablist" aria-label="Espace de travail">
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
              borderBottom: `2px solid ${on ? OC.accent : 'transparent'}`,
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
                  background: OC.accentSoft,
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
                  background: OC.accent,
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
    info: { bg: OC.accentSoft, border: C.border, color: C.text },
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
  color: OC.accentText,
  textDecoration: 'underline',
};

const codeChipStyle: CSSProperties = {
  fontFamily: monoFamily,
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 4,
  background: OC.accentSoft,
  color: OC.accentText,
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
  color: OC.accent,
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
const headerBackBtnStyle: CSSProperties = {
  appearance: 'none',
  marginInlineStart: 'auto',
  cursor: 'pointer',
  padding: '4px 12px',
  borderRadius: AgentPalette.radius.md,
  fontSize: 12,
  fontWeight: 600,
  color: C.text,
  background: 'transparent',
  border: `1px solid ${C.border}`,
};
const capChipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  padding: '2px 9px 2px 8px',
  borderRadius: 999,
  fontFamily: monoFamily,
  color: C.muted,
  border: `1px solid ${C.border}`,
};

// ---- studio (wizard/dashboard) canvas ----
const studioScrollStyle: CSSProperties = {
  height: '100%',
  width: '100%',
  overflow: 'auto',
  background: C.bg,
  color: C.text,
  fontSize: 13,
  lineHeight: 1.5,
};
const studioInnerStyle: CSSProperties = {
  maxWidth: 1120,
  margin: '0 auto',
  padding: '28px 24px 48px',
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
};
const studioLoadingStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '28px 4px',
  color: C.muted,
};

// ---- console layout ----
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
  flexWrap: 'wrap',
};

// LEFT sidebar — the project/thread column. Kept narrow (it is not the star);
// it can collapse to a thin strip. A header strip hosts the collapse toggle.
const sidebarWrapStyle: CSSProperties = {
  flex: '0 0 230px',
  width: 230,
  minWidth: 190,
  maxWidth: 280,
  borderRight: `1px solid ${C.border}`,
  background: C.panel,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

// Collapsed-sidebar strip — a thin rail with the expand button.
const sidebarStripStyle: CSSProperties = {
  flex: '0 0 40px',
  width: 40,
  borderRight: `1px solid ${C.border}`,
  background: C.panel,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  paddingTop: 8,
  minHeight: 0,
};

// CENTER (HERO) — the workspace. This is the dominant column: it grows to eat
// the frame (`flex: 1 1 auto`, the biggest basis) so Files/Terminal/Preview is
// where the eye lands. No side borders — it is flanked by bordered rails.
// minWidth 0 allows the phone shell stacking to shrink this below 420px; the
// Desktop keeps its 420px floor so the hero never squashes below a usable
// width; the shared responsive sheet overrides this to min-width:0 !important
// via [data-cdz-main] inside its max-width:600px query, which is what lets the
// pane shrink on phones. Changing the base value instead would have altered
// desktop behaviour for narrow windows (<~1030px), where the floor still binds.
const heroColStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 420,
  display: 'flex',
  flexDirection: 'column',
  background: C.bg,
  minHeight: 0,
  overflow: 'hidden',
};

// Hero header strip — mono title + the live-build affordance + (when the rail
// is collapsed) a button to bring the copilot back.
const heroHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexShrink: 0,
  height: 34,
  padding: '0 12px',
  borderBottom: `1px solid ${C.border}`,
  background: C.panel,
};
const heroTitleStyle: CSSProperties = {
  fontFamily: monoFamily,
  fontSize: 12,
  fontWeight: 700,
  color: OC.accent,
  letterSpacing: '0.02em',
};
const buildingChipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  padding: '2px 9px 2px 8px',
  borderRadius: 999,
  fontFamily: monoFamily,
  color: OC.accentText,
  background: OC.accentSoft,
  border: `1px solid ${C.border}`,
};
const heroRailBtnStyle: CSSProperties = {
  appearance: 'none',
  cursor: 'pointer',
  padding: '3px 12px',
  borderRadius: AgentPalette.radius.md,
  fontSize: 11.5,
  fontWeight: 600,
  fontFamily: monoFamily,
  color: C.text,
  background: 'transparent',
  border: `1px solid ${C.border}`,
  flexShrink: 0,
};

// RIGHT copilot rail — the chat + composer, demoted to a NARROW collapsible
// column with a left border. It is peripheral by design; the workspace leads.
const copilotColStyle: CSSProperties = {
  flex: '0 0 380px',
  width: 380,
  minWidth: 320,
  maxWidth: 460,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 12px',
  borderLeft: `1px solid ${C.border}`,
  background: C.panel,
  minHeight: 0,
  overflow: 'hidden',
};

// Collapsed-rail strip — a thin rail with the expand button.
const railStripStyle: CSSProperties = {
  flex: '0 0 40px',
  width: 40,
  borderLeft: `1px solid ${C.border}`,
  background: C.panel,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  paddingTop: 8,
  minHeight: 0,
};

// A small header row shared by the two side rails (label + collapse toggle).
const railHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
  height: 30,
  padding: '0 6px 0 10px',
};
const railHeadLabelStyle: CSSProperties = {
  flex: 1,
  fontFamily: monoFamily,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: C.muted,
};
const railToggleBtnStyle: CSSProperties = {
  appearance: 'none',
  cursor: 'pointer',
  width: 22,
  height: 22,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: AgentPalette.radius.sm,
  fontSize: 12,
  color: C.muted,
  background: 'transparent',
  border: `1px solid ${C.border}`,
  flexShrink: 0,
};

// The thin-strip expand button (used by both collapsed rails).
const stripBtnStyle: CSSProperties = {
  appearance: 'none',
  cursor: 'pointer',
  width: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: AgentPalette.radius.sm,
  fontSize: 13,
  color: C.text,
  background: 'transparent',
  border: `1px solid ${C.border}`,
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

// Ship card — a compact "Livré ✓" wrapper around the shared ArtifactsPanel.
const shipCardStyle: CSSProperties = {
  marginBottom: 12,
  padding: 10,
  borderRadius: AgentPalette.radius.md,
  border: `1px solid ${OC.accentSoft}`,
  background: OC.accentSoft,
};
const shipHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  marginBottom: 8,
  fontFamily: monoFamily,
  fontSize: 12.5,
  fontWeight: 700,
  color: C.text,
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

// Diff-review wrapper — pads the DiffView within the hero body.
const diffLayoutStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  padding: 10,
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
  return <OpenClawPage />;
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
