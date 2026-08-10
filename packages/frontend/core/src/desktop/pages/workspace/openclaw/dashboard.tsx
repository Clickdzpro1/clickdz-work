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
import {
  accentFor,
  AgentPresence,
  EmptyState,
  type StatusPhase,
  ToolPermissions,
} from '@affine/core/modules/agents/components';
import type {
  AgentThread,
  AgentThreadSummary,
} from '@affine/core/modules/agents/types';
import { useAgentLang } from '@affine/core/modules/agents/i18n';
import { useAgents } from '@affine/core/modules/agents/use-agents';
import { useTelegramChannel } from '@affine/core/modules/agents/use-channels';
import { WorkbenchLink } from '@affine/core/modules/workbench';
// R10 BYOT Telegram card — embedded in CanauxPanel below. (The import was
// dropped during R10 integration though the embed shipped; restored here so the
// file is boot-safe — an unimported identifier crashes the bundle.)
import { TelegramChannelCard } from '../agents/channel-card';
import {
  type CSSProperties,
  type ReactNode,
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
import { useIsNarrow } from './use-openclaw-responsive';
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
  SandboxHealthButton,
  SandboxStatus,
  Spinner,
} from './openclaw-shared';
import { PreviewPanel } from './preview-panel';

// OpenClaw identity accent (R10 / WS11-3): phosphor-green #6bd968 + cyan
// #56b6ff. Layered on the shared palette (`C` from openclaw-shared keeps the
// surface + ok/warn/err tints verbatim); only the accent family reads as
// OpenClaw's terminal green so the dashboard chrome matches the console. No
// behavior/route/export/testId change — repaint + tone only.
const OC = accentFor('openclaw');
// Phosphor border tint — the OpenClaw analogue of C.accentBorder (which is 45%
// of the shared accent). Derived from OC.accent at the same 45% ratio so hover
// rings/active outlines read phosphor and sit coherently with the palette.
const OC_BORDER = `color-mix(in srgb, ${OC.accent} 45%, transparent)`;

// The example prompts double as quick-start tasks (same set the console uses).
const QUICK_TASKS: string[] = [
  'Construire une petite API Express avec une route /health et la voir s’exécuter',
  'Écrire un script Python qui calcule et affiche les 20 premiers nombres premiers',
  'Générer une application Vite + React avec un compteur et ouvrir l’aperçu en direct',
  'Écrire une fonction Python fizzbuzz avec un test, puis exécuter le test',
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
  const { t } = useAgentLang();
  // ≤480px: the last-project files/preview strip below stacks the file tree
  // above the code viewer instead of squeezing both side by side.
  const isPhone = useIsNarrow(480);
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
          error: 'Impossible de lire ce fichier depuis le sandbox.',
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

  // Honest sandbox lamp — maps the capabilities the dashboard already tracks
  // onto the shared <AgentPresence> lamp via StatusPhase: live → green (done),
  // generate-only → amber (waiting_approval), still probing → grey (stopped),
  // caps load failed → red (error). Surfaced next to the Sandbox panel's title
  // as a real instrument (the detail row below stays SandboxStatus).
  const sandboxLampPhase: StatusPhase =
    capsState === 'loading'
      ? 'stopped'
      : capsState === 'error'
        ? 'error'
        : caps?.sandbox
          ? 'done'
          : 'waiting_approval';
  const sandboxLampTitle =
    capsState === 'loading'
      ? t('openclaw.dash.probing')
      : capsState === 'error'
        ? t('openclaw.dash.lampErr')
        : caps?.sandbox
          ? t('openclaw.dash.lampLive')
          : t('openclaw.sandbox.offGeneric');

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
            <span style={{ fontFamily: monoFamily, color: OC.accent }}>
              {'>_'}
            </span>
            {t('openclaw.dash.startTitle')}
          </div>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: C.muted }}>
            {t('openclaw.dash.startHint', {
              runtime: runtimeLabel,
              mode: caps?.sandbox
                ? t('openclaw.sandbox.chipLive')
                : t('openclaw.sandbox.chipOff'),
            })}
          </p>
        </div>
        <button style={btnStyle('primary')} onClick={() => onNewTask()}>
          {t('openclaw.dash.newTask')}
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
        {QUICK_TASKS.map((task, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onNewTask(task)}
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
              e.currentTarget.style.background = OC.accentSoft;
              e.currentTarget.style.borderColor = OC_BORDER;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = C.panel;
              e.currentTarget.style.borderColor = C.border;
            }}
          >
            {task}
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
          title={t('openclaw.sandbox.title')}
          action={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <AgentPresence
                agent="openclaw"
                phase={sandboxLampPhase}
                size={8}
                title={sandboxLampTitle}
              />
              <button
                style={{
                  appearance: 'none',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: OC.accentText,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: 0,
                }}
                onClick={onReloadCaps}
              >
                {'↻ '}
                {t('openclaw.sandbox.recheck')}
              </button>
            </div>
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
              <Spinner /> {t('openclaw.sandbox.checking')}
            </div>
          ) : capsState === 'error' ? (
            <Banner tone="error">{t('openclaw.sandbox.err.capsLoad')}</Banner>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <SandboxStatus caps={caps} />
              {/* The REAL create→exec→teardown probe (next to the cheap ↻
                  Recheck capability re-read in the panel header). */}
              <SandboxHealthButton />
            </div>
          )}
        </Panel>

        <Panel
          title={t('openclaw.dash.yourDefaults')}
          action={
            <button
              style={{
                appearance: 'none',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: OC.accentText,
                fontSize: 12,
                fontWeight: 600,
                padding: 0,
              }}
              onClick={onReconfigure}
            >
              {t('openclaw.dash.edit')}
            </button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <PrefRow
              label={t('openclaw.wizard.rowRuntime')}
              value={runtimeLabel}
              mono
            />
            <PrefRow
              label={t('openclaw.wizard.rowPreview')}
              value={
                config.previewAutoOpen
                  ? t('openclaw.wizard.valOn')
                  : t('openclaw.wizard.valOff')
              }
            />
            {caps?.plannerReady === false ? (
              <Banner tone="warn">
                {(() => {
                  // Render the translated message with the env-var name as a
                  // mono code chip (splitting on the {key} placeholder so the
                  // chip styling survives i18n). Fail-soft: no placeholder ⇒
                  // the chip is appended.
                  const msg = t('openclaw.dash.plannerOff', { key: '__KEY__' });
                  const parts = msg.split('__KEY__');
                  return (
                    <>
                      {parts[0]}
                      <code style={codeChip}>CDZ_AI_KEY</code>
                      {parts.length > 1 ? parts[1] : null}
                    </>
                  );
                })()}
              </Banner>
            ) : null}
          </div>
        </Panel>
      </div>

      {/* Tool permissions (R11) — per-agent toggles via Trame's shared
          <ToolPermissions> grid, fed by Cadenas's OpenClaw tool catalog +
          config.enabledTools. Self-contained (fetches the catalog + saves via
          Cadenas's api wrappers) so the dashboard’s prop signature is unchanged.
          Seeded from the config prop the parent already loaded. */}
      <OpenClawToolsCard config={config} />

      {/* Canaux — how the agent reaches the outside world (Telegram / WhatsApp
          / web). Read-only status from the account-level roster caps; setup
          lives on the global connections studio. Fail-soft on a dark roster. */}
      <CanauxPanel />

      {/* Recent projects/threads */}
      <Panel
        title="Tâches récentes"
        action={
          threads.length > 0 ? (
            <span style={{ fontSize: 11, color: C.muted }}>
              {threads.length} au total
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
            <Spinner /> Chargement de vos tâches…
          </div>
        ) : threadsState === 'error' ? (
          <Banner tone="error">
            Impossible de charger vos tâches.{' '}
            <button
              style={{ ...btnStyle('secondary'), padding: '2px 8px', fontSize: 12 }}
              onClick={() => void loadThreads()}
            >
              Réessayer
            </button>
          </Banner>
        ) : threads.length === 0 ? (
          <EmptyNote>
            Aucune tâche. Appuyez sur <strong>Nouvelle tâche</strong> ci-dessus pour
            créer votre premier projet.
          </EmptyNote>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {threads.slice(0, 8).map(th => (
              <ThreadRow
                key={th.id}
                thread={th}
                isLast={th.id === lastId}
                lastThread={th.id === lastId ? lastThread : null}
                onOpen={() => onOpenThread(th.id)}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* Last thread's workspace (files + preview) — reuses CLAWX components */}
      {lastId ? (
        <Panel
          title={`Dernier projet — ${threads[0]?.title ?? ''}`}
          action={
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', rowGap: 4 }}>
              <MiniTab
                on={wsTab === 'files'}
                onClick={() => setWsTab('files')}
                label={`Fichiers${lastFiles.length ? ` (${lastFiles.length})` : ''}`}
              />
              <MiniTab
                on={wsTab === 'preview'}
                onClick={() => setWsTab('preview')}
                label="Aperçu"
              />
              <button
                style={{ ...btnStyle('secondary'), padding: '4px 10px', fontSize: 12 }}
                onClick={() => onOpenThread(lastId)}
              >
                Ouvrir dans la console →
              </button>
            </div>
          }
        >
          <div
            style={{
              height: isPhone ? 460 : 340,
              display: 'flex',
              minHeight: 0,
            }}
          >
            {wsTab === 'files' ? (
              <div
                style={
                  isPhone
                    ? {
                        display: 'flex',
                        flexDirection: 'column',
                        width: '100%',
                        minHeight: 0,
                      }
                    : { display: 'flex', width: '100%', minHeight: 0 }
                }
              >
                <div style={isPhone ? fileTreeWrapPhone : fileTreeWrap}>
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
                        ? 'Sélectionnez un fichier pour le consulter.'
                        : caps?.sandbox
                          ? 'Aucun fichier pour cette tâche pour le moment.'
                          : "L'exécution en direct est désactivée — les fichiers apparaîtront une fois qu’une tâche s’exécute dans le sandbox."}
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
          title="Construisez quelque chose et regardez-le s'exécuter"
          subtitle={
            caps?.sandbox
              ? "Décrivez une tâche de codage. OpenClaw écrit les fichiers, les exécute dans un sandbox isolé, diffuse la sortie, et (pour les applications web) affiche un aperçu en direct."
              : "Décrivez une tâche de codage. OpenClaw écrit et explique le code. L'exécution en direct est désactivée sur ce serveur, rien n’est exécuté."
          }
          examples={QUICK_TASKS}
          onPickExample={seed => onNewTask(seed)}
        />
      ) : null}
    </div>
  );
};

// ---- sub-components --------------------------------------------------------

// ---------------------------------------------------------------------------
// OpenClawToolsCard (R11) — per-agent Tool permissions via Trame's shared
// <ToolPermissions> grid. Self-contained so the dashboard's prop signature is
// untouched: it loads Cadenas's OpenClaw tool catalog from the openclaw
// capabilities (GET /api/v1/openclaw/capabilities, read loosely as {tools:[…]}
// — mirrors how Hermes reads its catalog), seeds the enabled set from the
// `config` prop the parent already fetched, and PERSISTS changes via Cadenas's
// api wrappers (`saveOpenclawConfig`), merging enabledTools onto the existing
// runtime/preview so nothing else is dropped.
//
// OpenClaw's tools may be INTERNAL sandbox ops (nothing user-toggleable). When
// the catalog is empty we render a read-only note (per Cadenas) instead of an
// empty grid. Fail-soft throughout: a catalog load / save failure surfaces a
// quiet banner, never a crash.
//
// CONSUMED CONTRACTS:
//   • Cadenas — `agentApi.getOpenclawConfig()`, `agentApi.saveOpenclawConfig(body)`
//     (agents api.ts wrappers, R11) + `OpenClawConfig.enabledTools?: string[]`.
//   • Cadenas — OpenClaw tool catalog on the openclaw capabilities payload.
//   • Trame — `<ToolPermissions tools value onChange disabled/>`.
// ---------------------------------------------------------------------------
interface OpenClawToolItem {
  id: string;
  label: string;
  group: string;
  consequential: boolean;
  // R12 (Limier fix #1): the catalog's OWN per-tool enabled flag, as computed by
  // GET /api/v1/openclaw/capabilities (all-on when the user hasn't customized;
  // membership when they have). Default ON when the field is absent so a legacy /
  // partial payload never renders a tool spuriously OFF. This flag — NOT the
  // (absent-for-provisioned-users) config.enabledTools — seeds the grid's Set.
  enabled: boolean;
}

// Normalise a loosely-typed catalog entry (Cadenas's shape may carry id/slug +
// optional group/consequential/enabled) into the ToolPermissions contract shape.
function normalizeOpenClawTool(raw: unknown): OpenClawToolItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id =
    typeof r.id === 'string' && r.id
      ? r.id
      : typeof r.slug === 'string' && r.slug
        ? r.slug
        : '';
  if (!id) return null;
  return {
    id,
    label:
      typeof r.label === 'string' && r.label ? r.label : id,
    group:
      typeof r.group === 'string' && r.group ? r.group : '🛠 Outils',
    consequential: !!r.consequential,
    // Default-ON: only an EXPLICIT `enabled:false` turns a tool off. Absent ⇒ on,
    // matching the backend mental model "absent config = all-on".
    enabled: r.enabled !== false,
  };
}

const OpenClawToolsCard = ({ config }: { config: OpenClawConfig }) => {
  // enabledTools isn't in the base OpenClawConfig type until Cadenas’s SNIPPET
  // lands — read it defensively so this stays byte-safe pre-merge. (We seed the
  // grid from the catalog's per-tool flags, not this field; it’s only a legacy
  // fallback for a payload that omits the flags.)
  const cfgExtra = config as { enabledTools?: string[] };

  const [tools, setTools] = useState<OpenClawToolItem[]>([]);
  // The enabled Set is SEEDED FROM THE CATALOG (loadCatalog below), not from the
  // initial state value: config.enabledTools is absent for every user who simply
  // provisioned (never opened this grid), which previously produced an empty Set
  // → every tool rendered OFF while the backend treats absent as ALL-ON (Limier
  // bug). The catalog's per-tool `enabled` flags are the backend’s authoritative
  // view (all-on when never-customized, membership when customized, all-off for an
  // explicit []), so the grid mirrors exactly what the console will do. This
  // initial value is a harmless placeholder — the grid only renders once
  // state==='ready', which is set AFTER we seed from the catalog.
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // Guard: seed the enabled Set from the catalog exactly ONCE, so a later
  // reload / recheck (or a StrictMode double-invoke) never clobbers a selection
  // the user has since toggled locally in this session.
  const seededFromCatalog = useRef(false);

  const loadCatalog = useCallback(async () => {
    setState('loading');
    try {
      const raw = (await agentApi.getCapabilities('openclaw')) as Record<
        string,
        unknown
      >;
      const rawTools = Array.isArray(raw?.tools) ? raw.tools : [];
      const list = rawTools
        .map(normalizeOpenClawTool)
        .filter((t): t is OpenClawToolItem => t !== null);
      setTools(list);
      // Seed the enabled Set from the CATALOG'S OWN per-tool `enabled` flags
      // (default-ON) — the fix for the "all tools OFF after provisioning" bug.
      // Absent config ⇒ backend flags every tool enabled ⇒ all-on; a customized
      // config ⇒ the flags carry the exact stored subset (incl. an explicit []
      // that shows as all-off, once Cadenas fix #2 makes that stick). We fall
      // back to any explicit config.enabledTools only if the payload somehow
      // omits the flags, so the grid is never spuriously empty.
      if (!seededFromCatalog.current) {
        seededFromCatalog.current = true;
        const fromCatalog = list
          .filter(t => t.enabled !== false)
          .map(t => t.id);
        const hasEnabledField = rawTools.some(
          t =>
            t &&
            typeof t === 'object' &&
            'enabled' in (t as Record<string, unknown>)
        );
        if (hasEnabledField) {
          setEnabled(new Set(fromCatalog));
        } else if (Array.isArray(cfgExtra.enabledTools)) {
          // Legacy payload without per-tool flags — honor an explicit config set.
          setEnabled(new Set(cfgExtra.enabledTools));
        } else {
          // No flags AND no explicit config = never customized ⇒ all-on.
          setEnabled(new Set(list.map(t => t.id)));
        }
      }
      setState('ready');
    } catch {
      setTools([]);
      setState('error');
    }
  }, [cfgExtra.enabledTools]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const persist = useCallback(
    async (next: Set<string>) => {
      setSaving(true);
      setSaveMsg(null);
      try {
        // Merge onto the existing config so runtime/preview aren't dropped. Coded
        // against Cadenas's wrapper (mirrors Hermes’s saveConfig contract).
        await agentApi.saveOpenclawConfig({
          defaultRuntime: config.defaultRuntime,
          previewAutoOpen: config.previewAutoOpen,
          enabledTools: Array.from(next),
        });
        setSaveMsg('✓ Enregistré');
      } catch {
        setSaveMsg('Échec de l’enregistrement — réessayez.');
      } finally {
        setSaving(false);
      }
    },
    [config.defaultRuntime, config.previewAutoOpen]
  );

  const onChange = useCallback(
    (next: Set<string>) => {
      setEnabled(next);
      void persist(next);
    },
    [persist]
  );

  return (
    <Panel
      title={`Outils (${enabled.size} activé${enabled.size === 1 ? '' : 's'})`}
      action={
        saving ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: C.muted,
            }}
          >
            <Spinner /> Enregistrement…
          </span>
        ) : saveMsg ? (
          <span style={{ fontSize: 12, color: C.muted }}>{saveMsg}</span>
        ) : undefined
      }
    >
      {state === 'loading' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: C.muted,
            padding: '8px 2px',
          }}
        >
          <Spinner /> Chargement des outils…
        </div>
      ) : state === 'error' ? (
        <Banner tone="error">
          Impossible de charger le catalogue d’outils.{' '}
          <button
            style={{ ...btnStyle('secondary'), padding: '2px 8px', fontSize: 12 }}
            onClick={() => void loadCatalog()}
          >
            Réessayer
          </button>
        </Banner>
      ) : tools.length === 0 ? (
        // Read-only face (per Cadenas): OpenClaw's tools are internal sandbox ops
        // — nothing user-toggleable, so we explain rather than show an empty grid.
        <EmptyNote>
          Les outils d’OpenClaw sont internes au sandbox (fichiers, exécution,
          aperçu) — il n’y a rien à activer ou désactiver ici.
        </EmptyNote>
      ) : (
        <ToolPermissions
          tools={tools}
          value={enabled}
          onChange={onChange}
          disabled={saving}
        />
      )}
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// Canaux — account-level channel status, read from the R7 roster caps via
// useAgents() (GET /api/v1/agents → telegramEnabled / whatsappEnabled /
// webEnabled). Read-only here; pairing / setup happens on the global
// connections studio (reachable from the button). Fail-soft: a 404 (feature
// dark) flips useAgents `disabled` and returns the safe DEFAULT_AGENT_CAPS, so
// every channel reads "non configuré" with no error surfaced. Matches the
// OpenClaw idiom — Panel shell, mono uppercase status chips (like the ThreadRow
// "sandbox" chip), the shared btnStyle.
// ---------------------------------------------------------------------------
type ChannelTone = 'ok' | 'muted';

const CanauxPanel = () => {
  const { caps, loading } = useAgents();
  // `whatsappEnabled` is surfaced on the caps object by the backend but is not
  // yet in the AgentCaps type — read it defensively (same idiom the /agents
  // connections page uses) so this stays byte-safe if the field is absent.
  const telegramOn = !!caps.telegramEnabled;
  const whatsappOn = !!(caps as { whatsappEnabled?: boolean }).whatsappEnabled;
  const webOn = !!caps.webEnabled;

  return (
    <Panel
      title="Canaux"
      action={
        <WorkbenchLink
          to="/agents/connections"
          draggable={false}
          style={{ ...btnStyle('secondary'), padding: '4px 10px', fontSize: 12, textDecoration: 'none' }}
        >
          Gérer les connexions →
        </WorkbenchLink>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* These chips report whether the PLATFORM offers the channel — not
            whether THIS agent has a bot linked, which is what the
            TelegramBoundLine / TelegramChannelCard below show. Labelling the
            platform state "configuré" read as "you're done", directly above a
            card saying "NON-LIÉ" with a paste-your-token form: the UI appeared
            to contradict itself. "disponible" says what is actually true, and
            the enabled-state hint points at the card that completes the setup. */}
        <ChannelRow
          icon="✈"
          label="Telegram"
          on={telegramOn}
          loading={loading}
          okLabel="disponible"
          explain="Un bot Telegram doit être configuré par l’admin."
          onExplain="Canal disponible — liez votre bot ci-dessous pour l’activer."
        />
        <ChannelRow
          icon="💬"
          label="WhatsApp"
          on={whatsappOn}
          loading={loading}
          okLabel="disponible"
          explain="La passerelle WhatsApp arrive — sera activée automatiquement."
        />
        <ChannelRow
          icon="🌐"
          label="Accès web"
          on={webOn}
          loading={loading}
          okLabel="activé"
          offLabel="désactivé"
          explain="Vos agents peuvent chercher sur le web."
          explainWhenOn
        />
      </div>
      {/* R11 — a clearer "connecté à @bot" summary + a safe (confirm-gated)
          unpair, above the R10 BYOT card. The R10 status shape carries no
          bound-chat / last-inbound, so we surface the bot identity plainly
          rather than inventing fields. */}
      <TelegramBoundLine agent="openclaw" />
      {/* R10 BYOT — connect your OWN Telegram bot to OpenClaw, right here. */}
      <div style={{ marginTop: 12 }}>
        <TelegramChannelCard agent="openclaw" />
      </div>
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// TelegramBoundLine — a compact "connecté à @bot" strip shown ONLY when a bot
// is bound to this agent. Reads Passe's `useTelegramChannel(agent)` (the same
// hook the embedded card uses; safe to consume twice — independent state, same
// GET). Adds a confirm-gated "Dissocier" (unpair) affordance the raw card
// lacks. Fail-soft: not-connected / dark / loading renders nothing so the card
// owns those faces. Styled to the OpenClaw idiom (mono chip, shared C palette).
//   CONSUMED CONTRACT — useTelegramChannel(agent) → { status:{connected,
//   botUsername?,connectedAt?}, disconnect(), loading }. Read defensively.
// ---------------------------------------------------------------------------
const TelegramBoundLine = ({ agent }: { agent: 'openclaw' }) => {
  const channel = useTelegramChannel(agent) as
    | {
        status?: {
          connected?: boolean;
          botUsername?: string | null;
          connectedAt?: number | string;
        };
        disconnect?: () => Promise<void>;
        loading?: boolean;
      }
    | undefined;

  const status = channel?.status ?? {};
  const connected = !!status.connected;
  const botUsername = status.botUsername ?? undefined;

  const [confirming, setConfirming] = useState(false);
  const [unpairing, setUnpairing] = useState(false);

  const doUnpair = useCallback(() => {
    if (unpairing || !channel?.disconnect) return;
    setUnpairing(true);
    void (async () => {
      try {
        await channel.disconnect!();
      } catch {
        // Best-effort — the hook re-probes; a failed unpair leaves the
        // connected face up, which is honest.
      } finally {
        setUnpairing(false);
        setConfirming(false);
      }
    })();
  }, [unpairing, channel]);

  if (!connected) return null;

  return (
    <div
      style={{
        marginTop: 12,
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 10,
        background: C.okBg,
        border: `1px solid ${C.okBorder}`,
      }}
    >
      <span aria-hidden style={{ fontSize: 15, flexShrink: 0 }}>
        ✈
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.text }}>
        Connecté à{' '}
        <span dir="ltr" style={{ fontWeight: 700, fontFamily: monoFamily }}>
          @{botUsername || 'votre bot'}
        </span>
      </span>
      {confirming ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: C.muted }}>Dissocier ?</span>
          <button
            style={{
              ...btnStyle('danger'),
              padding: '4px 10px',
              fontSize: 12,
            }}
            disabled={unpairing}
            onClick={() => void doUnpair()}
          >
            {unpairing ? 'Dissociation…' : 'Confirmer'}
          </button>
          <button
            style={{
              ...btnStyle('secondary'),
              padding: '4px 10px',
              fontSize: 12,
            }}
            disabled={unpairing}
            onClick={() => setConfirming(false)}
          >
            Annuler
          </button>
        </span>
      ) : (
        <button
          style={{ ...btnStyle('secondary'), padding: '4px 10px', fontSize: 12 }}
          onClick={() => setConfirming(true)}
          title="Dissocier ce bot d’OpenClaw"
        >
          Dissocier
        </button>
      )}
    </div>
  );
};

// One channel row (OpenClaw idiom): icon + label, a mono status chip, and a
// one-line explain beneath. `on` drives the green "configuré/activé" chip;
// otherwise a neutral chip with the channel's copy. A loading roster shows a
// neutral "…" chip rather than a misleading state.
const ChannelRow = ({
  icon,
  label,
  on,
  loading,
  okLabel,
  offLabel = 'non configuré — token requis',
  explain,
  onExplain,
  explainWhenOn = false,
}: {
  icon: string;
  label: string;
  on: boolean;
  loading: boolean;
  okLabel: string;
  offLabel?: string;
  explain: string;
  // Copy to show INSTEAD of `explain` when the channel is enabled. Lets a row
  // say "available, here's the remaining step" rather than repeating the
  // how-to-enable hint, which is wrong once the channel is on.
  onExplain?: string;
  // When true the explain line also shows in the enabled state (used for the
  // web row, whose copy is informational rather than a "how to enable" hint).
  explainWhenOn?: boolean;
}) => {
  const tone: ChannelTone = on ? 'ok' : 'muted';
  const chipLabel = loading ? '…' : on ? okLabel : offLabel;
  const shownExplain = on ? (onExplain ?? explain) : explain;
  const showExplain = !loading && (on ? explainWhenOn || !!onExplain : true);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '10px 12px',
        borderRadius: 10,
        background: C.bg,
        border: `1px solid ${C.border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden style={{ fontSize: 15, flexShrink: 0 }}>
          {icon}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: C.text }}>
          {label}
        </span>
        <ChannelChip tone={tone}>{chipLabel}</ChannelChip>
      </div>
      {showExplain ? (
        <span style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.5, paddingLeft: 25 }}>
          {shownExplain}
        </span>
      ) : null}
    </div>
  );
};

// A compact mono status chip: green (configured/enabled) or neutral. Mirrors
// the uppercase mono chip used by ThreadRow's "sandbox" badge.
const ChannelChip = ({
  tone,
  children,
}: {
  tone: ChannelTone;
  children: ReactNode;
}) => (
  <span
    style={{
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '1px 9px',
      borderRadius: 999,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      fontFamily: monoFamily,
      whiteSpace: 'nowrap',
      color: tone === 'ok' ? C.okText : C.muted,
      background: tone === 'ok' ? C.okBg : 'transparent',
      border: `1px solid ${tone === 'ok' ? C.okBorder : C.border}`,
    }}
  >
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: tone === 'ok' ? C.okText : C.muted,
      }}
    />
    {children}
  </span>
);

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
        e.currentTarget.style.borderColor = OC_BORDER;
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
          color: OC.accent,
          background: OC.accentSoft,
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
          {thread.title || 'Tâche sans titre'}
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
      minHeight: 32,
      fontSize: 12,
      fontWeight: 600,
      borderRadius: 7,
      color: on ? C.text : C.muted,
      background: on ? OC.accentSoft : 'transparent',
      border: `1px solid ${on ? OC_BORDER : C.border}`,
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
  background: OC.accentSoft,
  color: OC.accentText,
};

const fileTreeWrap: CSSProperties = {
  flex: '0 0 190px',
  width: 190,
  minWidth: 150,
  borderRight: `1px solid ${C.border}`,
  overflow: 'auto',
  minHeight: 0,
};

// ≤480px: stacked above the code viewer (see `isPhone` in the component)
// instead of a narrow side column that squeezes the viewer to nothing.
const fileTreeWrapPhone: CSSProperties = {
  flex: '0 0 160px',
  width: '100%',
  maxHeight: 160,
  borderRight: 'none',
  borderBottom: `1px solid ${C.border}`,
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
