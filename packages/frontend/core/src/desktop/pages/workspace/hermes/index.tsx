import { AgentPalette } from '@affine/core/modules/agents/components';
import { ensureClickDzResponsiveCss } from '@affine/core/clickdz/responsive';
import {
  ApprovalPrompt,
  Composer,
  ConversationThread,
  EmptyState,
  StatusBar,
  ThreadSidebar,
} from '@affine/core/modules/agents/components';
import { getCapabilities } from '@affine/core/modules/agents/api';
import type { AgentEvent, AgentMessage } from '@affine/core/modules/agents/types';
import { useAgentStream } from '@affine/core/modules/agents/use-agent-stream';
import { useAgentThreads } from '@affine/core/modules/agents/use-agent-threads';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { AppAccessGate } from '@affine/core/modules/studio/app-access-gate';
import { ChatWithAiIcon } from '@blocksuite/icons/rc';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { HermesConfigPanel } from './config-panel';
import { HermesDashboard } from './dashboard';
import { HermesConnectionsPanel } from './hermes-connections';
import {
  Banner,
  btnStyle,
  C as SC,
  fetchConfig,
  type HermesConfig,
  Spinner as SharedSpinner,
} from './hermes-shared';
import { HermesWorkflowsPanel } from './hermes-workflows';
import { HermesWizard } from './wizard';

// ---------------------------------------------------------------------------
// ClickDz Hermes — per-user studio. Mirrors the ShopERP state machine
// (shoperp/index.tsx): on mount GET /api/v1/hermes/config, then:
//   • !provisioned            → the ONBOARDING WIZARD (set up your own Hermes)
//   • provisioned (default)   → the DASHBOARD (runs, tools, saved workflows,
//                               stats) with the streaming console one click away
//   • console                 → the live streaming ops-agent console (below)
//   • settings                → an inline config editor (PUT the config)
//
// The streaming CONSOLE is the original shipping surface, preserved intact and
// only lightly parametrized: it accepts an optional `initialInput` (a workflow
// goal to seed the composer), an optional `initialThreadId` (open a specific
// run from the dashboard), and an `onBack` affordance to return to the
// dashboard. Everything else — SSE streaming via useAgentStream, threads via
// useAgentThreads, inline approvals, the mode toggle, planner-offline notices —
// is unchanged from the shipped console.
//
// House rules: inline styles only, no new deps, SHELL palette, boot-safe icons
// (ChatWithAiIcon), and every surface degrades gracefully with loading / empty
// / error states. If the config endpoint is unavailable the page degrades to
// the console directly so the user is never locked out.
// ---------------------------------------------------------------------------

const AGENT = 'hermes' as const;

// HERMES run policy. The mode union is inlined on the stream's send() input
// (STREAMCLIENT does not export a named type), so we mirror it locally.
type AgentMode = 'auto' | 'ask' | 'dry';

// Shape the two HERMESX panels + the notices read from capabilities. The REST
// client returns the raw JSON loosely typed (Record<string, unknown>), so we
// normalise it defensively into this shape once.
interface HermesTool {
  slug: string;
  label: string;
  available: boolean;
}
interface HermesCaps {
  tools: HermesTool[];
  plannerReady: boolean;
  streaming?: boolean;
}

// SHELL's shared palette (single source of truth so the page reads cohesively
// with the console primitives). Colour tokens live under `AgentPalette.color`;
// we pull the handful this page needs and add a couple of local warn/error
// tokens so the planner-offline notice matches the app.
const C = AgentPalette.color;
const P = {
  bg: C.bg,
  panel: C.panel,
  border: C.border,
  text: C.text,
  muted: C.muted,
  accent: C.accent,
  accentSoft: C.accentSoft,
  warnBg: C.warnBg,
  warnBorder: C.warnBorder,
  errText: C.errText,
} as const;

// Page-unique keyframes for this shell's own fades (SHELL owns its component
// motion). Reduced-motion users get no animation.
const CdzResponsive = () => {
  ensureClickDzResponsiveCss();
  return null;
};

const GLOBAL_CSS = `
@keyframes cdz-hermes-fade-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.cdz-hermes-fade{animation:cdz-hermes-fade-in 200ms ease both}
@media (prefers-reduced-motion: reduce){
  .cdz-hermes-fade{animation:none !important}
}
`;

// Curated fallbacks for the empty-state chips (SHELL's EmptyState renders
// `examples` as clickable chips that seed the composer).
const EXAMPLE_GOALS = [
  "Résumer les commandes d’aujourd’hui et préparer un broadcast WhatsApp",
  'Trouver des prospects la semaine dernière et préparer un suivi',
  'Rapprocher les dépenses de cette semaine avec les commandes',
];

type CapsState = 'loading' | 'ready' | 'error';

// Normalise the loosely-typed capabilities JSON into HermesCaps. Anything
// missing or malformed degrades to empty/false so the UI never crashes.
function normalizeCaps(raw: Record<string, unknown>): HermesCaps {
  const rawTools = Array.isArray((raw as { tools?: unknown }).tools)
    ? ((raw as { tools: unknown[] }).tools)
    : [];
  const tools: HermesTool[] = rawTools
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map(t => ({
      slug: typeof t.slug === 'string' ? t.slug : '',
      label: typeof t.label === 'string' ? t.label : String(t.slug ?? ''),
      available: !!t.available,
    }))
    .filter(t => t.slug);
  return {
    tools,
    plannerReady: !!(raw as { plannerReady?: unknown }).plannerReady,
    streaming: !!(raw as { streaming?: unknown }).streaming,
  };
}

// ===========================================================================
// The streaming console (the original shipping surface, parametrized).
// ===========================================================================
const HermesConsole = ({
  defaultMode,
  initialInput,
  initialThreadId,
  onBack,
}: {
  // Seed the composer's mode toggle from the user's saved config.
  defaultMode?: AgentMode;
  // Seed the composer with a workflow goal (from the dashboard).
  initialInput?: string;
  // Open a specific existing run when entering from the dashboard.
  initialThreadId?: string;
  // Return to the dashboard (only shown when the console is reached from it).
  onBack?: () => void;
}) => {
  // ---- threads (list / load / rename / delete / new) ----------------------
  const {
    threads,
    activeId,
    setActiveId,
    reload: reloadThreads,
    newThread,
    rename,
    remove,
    activeThread,
    loadThread,
    loadingThreads,
  } = useAgentThreads({ agent: AGENT });

  // ---- capabilities (tool availability + planner readiness) ---------------
  const [capsState, setCapsState] = useState<CapsState>('loading');
  const [capabilities, setCapabilities] = useState<HermesCaps | null>(null);

  // ---- composer state -----------------------------------------------------
  const [input, setInput] = useState(initialInput ?? '');
  const [mode, setMode] = useState<AgentMode>(defaultMode ?? 'ask');

  // Guards a one-shot reload after a run finishes (fires when finalMessage
  // lands / running flips false), so thread history + the sidebar refresh.
  const reloadedForFinalRef = useRef<string | null>(null);
  // Guards a one-shot open of the initial thread when entering from dashboard.
  const openedInitialRef = useRef(false);

  // ---- live stream (send / stop / approve + in-progress assistant turn) ---
  // `onEvent` is a PARAM here (not a return value): we watch minted-thread and
  // completion frames to keep the sidebar + active thread in sync mid-run.
  const handleEvent = useCallback(
    (ev: AgentEvent) => {
      if (ev.type === 'thread') {
        // Adopt the server-minted thread id as the active selection.
        setActiveId(ev.threadId);
      } else if (ev.type === 'final') {
        // NOTE: the `done` sentinel never reaches onEvent — use-agent-stream
        // consumes it internally and closes the stream without dispatching.
        void reloadThreads();
      }
    },
    [reloadThreads, setActiveId]
  );

  const {
    running,
    status,
    phase,
    streamingMessage,
    threadId,
    pendingApproval,
    finalMessage,
    error,
    send,
    stop,
    approve,
  } = useAgentStream({ agent: AGENT, onEvent: handleEvent });

  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      const raw = await getCapabilities(AGENT);
      setCapabilities(normalizeCaps(raw));
      setCapsState('ready');
    } catch {
      setCapabilities(null);
      setCapsState('error');
    }
  }, []);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  // Open the initial thread once (dashboard → "open this run").
  useEffect(() => {
    if (openedInitialRef.current) return;
    if (!initialThreadId) return;
    openedInitialRef.current = true;
    void loadThread(initialThreadId);
  }, [initialThreadId, loadThread]);

  const plannerReady = !!capabilities?.plannerReady;

  // The single send path — used by the Composer's onSend (no args: reads the
  // controlled `input`) and by workflow/example picks after seeding the input.
  const doSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || running || !plannerReady) return;
    setInput('');
    void send({ message: trimmed, threadId: activeId ?? undefined, mode });
  }, [activeId, input, mode, plannerReady, running, send]);

  // When a run finishes (not running any more, a final message arrived), reload
  // the active thread so the canonical persisted history replaces the transient
  // streaming turn. Keyed by message id so it fires once per completed turn.
  useEffect(() => {
    if (running) return;
    if (!finalMessage) return;
    if (reloadedForFinalRef.current === finalMessage.id) return;
    reloadedForFinalRef.current = finalMessage.id;
    void reloadThreads();
    const tid = threadId ?? activeId;
    if (tid) void loadThread(tid);
  }, [running, finalMessage, threadId, activeId, reloadThreads, loadThread]);

  // HERMESX workflow / example pick → seed the composer. We never auto-send:
  // the user reviews the goal and presses send (Enter) themselves.
  const handlePick = useCallback((goal: string) => {
    const g = (goal ?? '').trim();
    if (!g) return;
    setInput(g);
  }, []);

  const handleSelectThread = useCallback(
    (id: string) => {
      if (running) return; // don't switch context mid-stream
      void loadThread(id);
    },
    [loadThread, running]
  );

  const handleNewThread = useCallback(() => {
    if (running) return;
    setInput('');
    newThread();
  }, [newThread, running]);

  const handleRename = useCallback(
    (id: string, title: string) => {
      void rename(id, title);
    },
    [rename]
  );

  const handleDelete = useCallback(
    (id: string) => {
      void remove(id);
    },
    [remove]
  );

  // Display messages = the loaded thread's history; the in-progress turn is
  // passed to ConversationThread SEPARATELY via `streamingMessage`.
  const messages: AgentMessage[] = activeThread?.messages ?? [];
  const hasConversation = messages.length > 0 || !!streamingMessage;

  const composerDisabled = capsState === 'ready' && !plannerReady;

  // Inline approval: render SHELL's ApprovalPrompt as an extra beneath the
  // streaming assistant message when the hook exposes a pending request.
  const renderExtras = useCallback(
    (_message: AgentMessage, isStreaming: boolean) => {
      if (!isStreaming || !pendingApproval) return null;
      return (
        <div style={{ marginTop: 10 }}>
          <ApprovalPrompt
            request={pendingApproval}
            disabled={!running}
            onDecide={(id, decision) => void approve(id, decision)}
          />
        </div>
      );
    },
    [approve, pendingApproval, running]
  );

  return (
    <div
      data-cdz-surface=""
      data-cdz-shell=""
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        overflow: 'hidden',
        background: P.bg,
        color: P.text,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <style>{GLOBAL_CSS}</style>
      {/* Phone layout for the rail/main split — see clickdz/responsive.ts */}
      <CdzResponsive />

      {/* ---- Left: thread rail -------------------------------------- */}
      <ThreadSidebar
        threads={threads}
        activeId={activeId}
        onSelect={handleSelectThread}
        onNew={handleNewThread}
        onRename={handleRename}
        onDelete={handleDelete}
        loading={loadingThreads}
        title="Conversations"
        width={264}
      />

      {/* ---- Right: conversation + composer ------------------------- */}
      <main
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        {/* Back-to-dashboard strip (only when reached from the dashboard). */}
        {onBack ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 14px',
              borderBottom: `1px solid ${P.border}`,
              background: P.bg,
            }}
          >
            <button
              type="button"
              onClick={onBack}
              style={{
                appearance: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 11px',
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: 'pointer',
                color: P.text,
                background: 'transparent',
                border: `1px solid ${P.border}`,
              }}
            >
              ← Tableau de bord
            </button>
            <span style={{ fontSize: 12, color: P.muted }}>Console de streaming</span>
          </div>
        ) : null}

        {/* Planner-offline notice pins to the top of the column so it is
            visible from the empty state through an active thread. */}
        {capsState === 'ready' && !plannerReady ? (
          <div className="cdz-hermes-fade" role="alert" style={noticeStyle}>
            <strong>Planificateur hors ligne.</strong>&nbsp;Hermes ne peut pas planifier
            d’exécutions tant que le propriétaire n’a pas configuré{' '}
            <code style={codeStyle}>CDZ_AI_KEY</code> sur le serveur. Les fils de
            discussion et les outils restent disponibles ; l’envoi est désactivé.
          </div>
        ) : null}
        {capsState === 'error' ? (
          <div className="cdz-hermes-fade" role="alert" style={noticeStyle}>
            <strong>Impossible de charger les capacités de l’agent.</strong>&nbsp;La
            disponibilité des outils est inconnue.{' '}
            <button style={linkBtnStyle} onClick={() => void loadCaps()}>
              Réessayer
            </button>
          </div>
        ) : null}
        {error ? (
          <div className="cdz-hermes-fade" role="alert" style={noticeStyle}>
            <strong>Erreur d’exécution.</strong>&nbsp;{error}
          </div>
        ) : null}

        {/* Conversation region (SHELL owns scroll + empty-state slot) */}
        {hasConversation ? (
          <ConversationThread
            messages={messages}
            streamingMessage={streamingMessage}
            renderExtras={renderExtras}
            style={{ flex: 1, minHeight: 0 }}
          />
        ) : (
          // ---- Empty state: hero + HERMESX panels --------------------
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              className="cdz-hermes-fade"
              style={{
                maxWidth: 900,
                width: '100%',
                margin: '0 auto',
                padding: '32px 24px 40px',
                display: 'flex',
                flexDirection: 'column',
                gap: 24,
              }}
            >
              <EmptyState
                icon={<ChatWithAiIcon style={{ fontSize: 26 }} />}
                title="Hermes — votre agent opérationnel"
                subtitle="Donnez un objectif à Hermes. Il planifie les étapes, appelle les bons outils across vos boutiques et applications connectées, et vous fait un retour — en diffusant chaque étape en direct. Choisissez un flux de travail pour commencer, ou tapez le vôtre ci-dessous."
                examples={EXAMPLE_GOALS}
                onPickExample={handlePick}
              >
                {/* Curated operations workflows (HERMESX). Picking a card
                    seeds the composer. */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 24,
                    textAlign: 'left',
                  }}
                >
                  <HermesWorkflowsPanel onPick={handlePick} />
                  {/* Tools / connections status derived from capabilities
                      (HERMESX). Renders its own skeleton when null. */}
                  <HermesConnectionsPanel capabilities={capabilities} />
                </div>
              </EmptyState>
            </div>
          </div>
        )}

        {/* Live status strip (phase chip + label + elapsed) while running */}
        {running ? (
          <StatusBar
            phase={phase ?? 'planning'}
            label={status ?? ''}
            running={running}
          />
        ) : null}

        {/* Composer: textarea + send + Stop-while-running, with the mode
            toggle in the left slot. Send is gated on planner readiness. */}
        <Composer
          value={input}
          onChange={setInput}
          onSend={doSend}
          onStop={stop}
          running={running}
          disabled={composerDisabled}
          placeholder={
            composerDisabled
              ? 'Planificateur hors ligne — l’envoi est désactivé'
              : 'Écrire à Hermes — décrivez le résultat que vous attendez…'
          }
          leftSlot={
            <ModeToggle mode={mode} disabled={running} onChange={setMode} />
          }
        />
      </main>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Local helpers (page-scoped; SHELL owns the reusable primitives).
// ---------------------------------------------------------------------------

// Composer leftSlot: a compact segmented control for the run policy.
//   auto — execute tools freely
//   ask  — pause for approval before any consequential tool (writes / sends)
//   dry  — plan only, execute nothing
const MODE_META: Record<AgentMode, { label: string; hint: string }> = {
  auto: { label: 'Auto', hint: 'Exécuter les outils sans demander' },
  ask: { label: 'Demander', hint: 'Pause pour approbation avant écritures / envois' },
  dry: { label: 'Simulation', hint: 'Planifier uniquement — rien exécuter' },
};

const MODE_ORDER: AgentMode[] = ['auto', 'ask', 'dry'];

const ModeToggle = ({
  mode,
  disabled,
  onChange,
}: {
  mode: AgentMode;
  disabled?: boolean;
  onChange: (next: AgentMode) => void;
}) => (
  <div
    role="group"
    aria-label="Mode d’exécution"
    title={MODE_META[mode].hint}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: 2,
      borderRadius: 8,
      gap: 2,
      background: P.bg,
      border: `1px solid ${P.border}`,
      opacity: disabled ? 0.55 : 1,
    }}
  >
    {MODE_ORDER.map(m => {
      const active = m === mode;
      return (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={active}
          disabled={disabled}
          title={MODE_META[m].hint}
          onClick={() => !disabled && onChange(m)}
          style={{
            appearance: 'none',
            border: 'none',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: disabled ? 'default' : 'pointer',
            color: active ? '#fff' : P.muted,
            background: active ? P.accent : 'transparent',
            transition: 'background 150ms ease, color 150ms ease',
          }}
        >
          {MODE_META[m].label}
        </button>
      );
    })}
  </div>
);

const noticeStyle: CSSProperties = {
  display: 'block',
  padding: '10px 16px',
  fontSize: 12.5,
  color: P.text,
  background: P.warnBg,
  borderBottom: `1px solid ${P.warnBorder}`,
};

const codeStyle: CSSProperties = {
  fontFamily: 'var(--affine-font-code-family, monospace)',
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 4,
  background:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  color: 'var(--affine-text-primary-color, #ececec)',
};

const linkBtnStyle: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer',
  color: 'var(--affine-primary-color, #1e96eb)',
  textDecoration: 'underline',
};

// ===========================================================================
// The page state machine — GET config on mount → wizard | dashboard | console
// | settings. Mirrors shoperp/index.tsx (loading → error → wizard → dashboard).
// ===========================================================================

type PageState = 'loading' | 'error' | 'ready';
// Which surface is showing once the config has loaded.
type View =
  | { kind: 'wizard' }
  | { kind: 'dashboard' }
  | { kind: 'console'; prefill?: string; threadId?: string }
  | { kind: 'settings' };

const HermesPage = () => {
  const [state, setState] = useState<PageState>('loading');
  const [config, setConfig] = useState<HermesConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'dashboard' });

  const load = useCallback(async () => {
    setState('loading');
    setLoadError(null);
    const outcome = await fetchConfig();
    if (outcome.status === 'ok') {
      setConfig(outcome.config);
      // Provisioned users land on the dashboard; new users get the wizard.
      setView(outcome.config.provisioned ? { kind: 'dashboard' } : { kind: 'wizard' });
      setState('ready');
    } else {
      setLoadError(outcome.message);
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // After the wizard finishes: reload config, land on the dashboard.
  const handleWizardDone = useCallback(async () => {
    await load();
    setView({ kind: 'dashboard' });
  }, [load]);

  // After the settings panel saves: adopt the returned config, back to dash.
  const handleSettingsSaved = useCallback((next: HermesConfig) => {
    setConfig(next);
    setView({ kind: 'dashboard' });
  }, []);

  const provisioned = !!config?.provisioned;

  // Header badge label depends on the surface.
  return (
    <>
      <ViewTitle title="Hermes" />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: '100%',
            padding: '0 16px',
            fontSize: 14,
            fontWeight: 600,
            color: P.text,
          }}
        >
          <ChatWithAiIcon style={{ fontSize: 16 }} />
          {config?.agentName || 'Hermes'}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '15px',
              padding: '0 6px',
              borderRadius: 5,
              letterSpacing: '0.05em',
              color: P.muted,
              backgroundColor:
                'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)',
            }}
          >
            béta
          </span>
        </div>
      </ViewHeader>
      <ViewBody>
        <AppAccessGate app="HERMES">
        {/* The console needs the full-bleed flex layout; the wizard / dashboard
            / settings live inside a scrolling, centered canvas (shoperp idiom). */}
        {state === 'ready' && view.kind === 'console' ? (
          <HermesConsole
            defaultMode={config?.defaultMode}
            initialInput={view.prefill}
            initialThreadId={view.threadId}
            // Only offer "back to dashboard" when the user is provisioned.
            onBack={provisioned ? () => setView({ kind: 'dashboard' }) : undefined}
          />
        ) : (
          <div
            style={{
              height: '100%',
              width: '100%',
              overflow: 'auto',
              background: P.bg,
              color: P.text,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <div
              style={{
                maxWidth:
                  state === 'ready' &&
                  (view.kind === 'dashboard' || view.kind === 'settings')
                    ? 1120
                    : 960,
                margin: '0 auto',
                padding: '28px 24px 48px',
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
              }}
            >
              {state === 'loading' ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '28px 4px',
                    color: P.muted,
                  }}
                >
                  <SharedSpinner /> Chargement de votre Hermes…
                </div>
              ) : state === 'error' ? (
                <ErrorState message={loadError} onRetry={() => void load()} />
              ) : view.kind === 'wizard' ? (
                <HermesWizard
                  hasConfig={provisioned}
                  initialConfig={config}
                  onDone={() => void handleWizardDone()}
                  onCancel={
                    provisioned ? () => setView({ kind: 'dashboard' }) : undefined
                  }
                />
              ) : view.kind === 'settings' && config ? (
                <HermesConfigPanel
                  config={config}
                  onSaved={handleSettingsSaved}
                  onClose={() => setView({ kind: 'dashboard' })}
                />
              ) : config ? (
                <HermesDashboard
                  config={config}
                  onOpenConsole={prefill =>
                    setView({ kind: 'console', prefill })
                  }
                  onOpenThread={threadId =>
                    setView({ kind: 'console', threadId })
                  }
                  onReconfigure={() => setView({ kind: 'settings' })}
                />
              ) : null}
            </div>
          </div>
        )}
        </AppAccessGate>
      </ViewBody>
    </>
  );
};

// A load-failure state that still lets the user reach the console directly, so
// a flaky config endpoint never locks anyone out of a working agent.
const ErrorState = ({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
    <Banner tone="error">
      {message || 'Impossible de charger votre configuration Hermes.'}
    </Banner>
    <div style={{ display: 'flex', gap: 10 }}>
      <button style={btnStyle('primary')} onClick={onRetry}>
        Réessayer
      </button>
    </div>
    <p style={{ margin: 0, fontSize: 12.5, color: SC.muted, lineHeight: 1.5 }}>
      Votre configuration est stockée par compte. Si le problème persiste, la console
      de streaming reste disponible — rechargez la page pour réessayer.
    </p>
  </div>
);

export const Component = () => {
  return <HermesPage />;
};
