import { AgentApiError, getCapabilities, listThreads } from '@affine/core/modules/agents/api';
import {
  approveAgentRun,
  type AgentTrigger,
  getAgentPulse,
  getAgentRun,
  listAgentRuns,
  listTriggers,
  startBackgroundRun,
  toggleTrigger,
} from '@affine/core/modules/agents/api';
import {
  accentFor,
  AgentPresence,
  ApprovalInbox,
  type ApprovalInboxItem,
  CodDesk,
  type CodOrder,
  MissionsCard,
  PulseCard,
  type AgentPulse,
  StepList,
  StreamingAnswer,
} from '@affine/core/modules/agents/components';
import { CdzAILoading } from '@affine/core/clickdz/cdz-animations';
import type { AgentStep, AgentThreadSummary } from '@affine/core/modules/agents/types';
import { useAgentLang } from '@affine/core/modules/agents/i18n';
import { useAgentRunStream } from '@affine/core/modules/agents/use-agent-stream';
import { WorkbenchLink } from '@affine/core/modules/workbench';
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
// Hermes dashboard — "Le Bureau" (R11, WS11-7). Hermès is not a chatbox: it is
// an operations EMPLOYEE that already started working before you opened the tab.
// The dashboard is recomposed as a single ≤720px center desk column (persona
// doc "Le bureau"), scannable in 5s:
//   1. Greeting bar — a darja "Sbah el-khir, {name}" + a reporting-state presence
//      lamp + last-sweep time; the chat is DEMOTED to a compact "Parler à {name}"
//      button, no longer the centerpiece.
//   2. <PulseCard> — the business pulse hero (commandes/à confirmer/CA/retours/
//      stock), fed by GET /api/v1/agents/pulse via Pouls's `getAgentPulse`. Fail-
//      soft: any failure / no shop ⇒ pulse=null ⇒ PulseCard's own warm new-hire
//      empty state (never an error).
//   3. <ApprovalInbox> — actions Hermès wants a go-ahead on, built from the
//      waiting_approval background runs (listAgentRuns filtered + approveAgentRun).
//   4. <CodDesk> — pending cash-on-delivery orders (Algeria's #1 daily job) from
//      the pulse read's optional `orders` sample. Best-effort: no orders ⇒ hidden.
//   5. <MissionsCard> — scheduled jobs from listTriggers('hermes') (R8); "Ouvrir"
//      navigates to the full /agents/triggers page.
// EVERYTHING R6-R10 SURVIVES verbatim below the desks: the Exécutions panel
// (background runs composer + list + live view), Recent runs, Saved workflows,
// Tools & connections, and the default-mode footer. Every export (HermesDashboard
// + default), every prop, and every behavior is preserved. When the new agent
// endpoints 404 (CDZ_AGENTS_ENABLED off) or all data is absent, the new desks
// render their own empty/hidden states and the dashboard behaves as before.
//
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

// ---------------------------------------------------------------------------
// "Le Bureau" data normalisers — pulse / approvals / COD orders. All coerce a
// loosely-typed payload into the EXACT shape the Trame R11 components require
// (PulseCard `AgentPulse`, ApprovalInbox `ApprovalInboxItem`, CodDesk `CodOrder`)
// and fail soft (null / [] / hidden) so a partial or absent payload never
// crashes the desk. The FE codes to Pouls's route contract (GET
// /api/v1/agents/pulse) via the `getAgentPulse` api wrapper.
// ---------------------------------------------------------------------------

/** Coerce a loose numeric field to a clean count ≥ 0 (never NaN/negative). */
function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Normalise the pulse payload into the PulseCard `AgentPulse` shape. Returns
 * null when the payload is absent, malformed, or explicitly `{connected:false}`
 * (no shop connected yet) — PulseCard renders its own warm new-hire empty state
 * for null, so the dashboard never surfaces a raw error for a not-yet-connected
 * merchant.
 */
function normalizePulse(raw: unknown): AgentPulse | null {
  const r = (raw && typeof raw === 'object' ? raw : null) as Record<
    string,
    unknown
  > | null;
  if (!r) return null;
  // The backend returns `{connected:false}` (+ zeros) when the user has no shop.
  if (r.connected === false) return null;
  return {
    ordersToday: toCount(r.ordersToday),
    toConfirm: toCount(r.toConfirm),
    revenueTodayDzd: toCount(r.revenueTodayDzd),
    returns: toCount(r.returns),
    lowStock: toCount(r.lowStock),
  };
}

/**
 * Best-effort extraction of a COD orders sample from the pulse payload. The
 * pulse route MAY expose a small `orders` array (contract: "if pulse exposes a
 * sample"); when it does not, this returns [] and the desk is hidden. Each row
 * is coerced to the CodDesk `CodOrder` shape defensively.
 */
function normalizeOrders(raw: unknown): CodOrder[] {
  const r = (raw && typeof raw === 'object' ? raw : null) as Record<
    string,
    unknown
  > | null;
  if (!r) return [];
  const rows = Array.isArray(r.orders) ? r.orders : [];
  return rows
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
    .map(o => ({
      ref: typeof o.ref === 'string' ? o.ref : '',
      customer: typeof o.customer === 'string' ? o.customer : '',
      phone: typeof o.phone === 'string' ? o.phone : '',
      wilaya: typeof o.wilaya === 'string' ? o.wilaya : '',
      totalDzd: toCount(o.totalDzd),
      status: typeof o.status === 'string' ? o.status : '',
    }))
    .filter(o => o.ref.length > 0);
}

/**
 * Read the pending approval descriptor out of a full run record (getAgentRun).
 * The approval id (= the `approval_request` frame's id, used as the stepId that
 * approveAgentRun echoes back) is NOT a typed field on AgentRunRecord, so we
 * scan the raw payload defensively for the common shapes the backend may use
 * (`pendingApproval` / `approval` object, or a trailing approval-like step).
 * Returns `{ id, title?, detail? }` or null. Fail-soft: a missing descriptor
 * still yields an inbox row (the caller falls back to the run prompt + runId).
 */
function readPendingApproval(
  raw: unknown
): { id: string; title?: string; detail?: string } | null {
  const r = (raw && typeof raw === 'object' ? raw : null) as Record<
    string,
    unknown
  > | null;
  if (!r) return null;
  const cand =
    (r.pendingApproval && typeof r.pendingApproval === 'object'
      ? (r.pendingApproval as Record<string, unknown>)
      : null) ??
    (r.approval && typeof r.approval === 'object'
      ? (r.approval as Record<string, unknown>)
      : null);
  if (cand) {
    const id =
      typeof cand.id === 'string'
        ? cand.id
        : typeof cand.stepId === 'string'
          ? cand.stepId
          : '';
    if (id) {
      return {
        id,
        title: typeof cand.title === 'string' ? cand.title : undefined,
        detail:
          typeof cand.summary === 'string'
            ? cand.summary
            : typeof cand.detail === 'string'
              ? cand.detail
              : undefined,
      };
    }
  }
  return null;
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
  const { t } = useAgentLang();
  const acc = accentFor(AGENT);

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

  // ---- R11 "Le Bureau" desks ----------------------------------------------
  // Business pulse (PulseCard). `pulse === null` ⇒ new-hire empty state; the
  // load is fail-soft (any error also yields null) so a not-yet-connected shop
  // sees the warm empty state, never an error banner.
  const [pulse, setPulse] = useState<AgentPulse | null>(null);
  const [pulseLoading, setPulseLoading] = useState(true);
  // COD orders sample (CodDesk). Best-effort from the pulse read; when empty the
  // desk is hidden entirely.
  const [codOrders, setCodOrders] = useState<CodOrder[]>([]);
  // Approval inbox items, derived from waiting_approval runs (see loadApprovals).
  const [approvals, setApprovals] = useState<ApprovalInboxItem[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(true);
  // Scheduled missions (MissionsCard) from listTriggers('hermes'). `missionsOn`
  // gates the card the same way runsEnabled gates Exécutions: a 404 (triggers
  // feature off) hides it silently.
  const [triggers, setTriggers] = useState<AgentTrigger[]>([]);
  const [missionsOn, setMissionsOn] = useState<boolean | null>(null);
  // Only the setter is bound: MissionsCard has no loading state to feed the
  // value into (it renders list/empty faces only), so nothing reads it yet.
  const [, setMissionsLoading] = useState(true);
  // Timestamp of the last successful pulse sweep (for the greeting bar).
  const [lastSweep, setLastSweep] = useState<number | undefined>(undefined);

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

  // ---- R11: business pulse (PulseCard) + COD orders sample (CodDesk) -------
  // Fail-soft in the extreme: ANY failure (404 flag-off, network, malformed)
  // resolves to a null pulse + empty orders, so the desk shows PulseCard's warm
  // new-hire empty state and hides CodDesk — never an error. The FE calls
  // Pouls's GET /api/v1/agents/pulse via the `getAgentPulse` wrapper.
  const loadPulse = useCallback(async () => {
    setPulseLoading(true);
    try {
      const raw = await getAgentPulse(AGENT);
      setPulse(normalizePulse(raw));
      setCodOrders(normalizeOrders(raw));
      setLastSweep(Date.now());
    } catch {
      setPulse(null);
      setCodOrders([]);
    } finally {
      setPulseLoading(false);
    }
  }, []);

  // ---- R11: approval inbox (ApprovalInbox) --------------------------------
  // Built from the waiting_approval background runs: list runs, filter to
  // state === 'waiting_approval', then best-effort fetch each run's full record
  // to pull the pending approval's id/title/detail. Fail-soft throughout — a
  // 404 (feature off) or any error yields an empty inbox (the card shows its own
  // calm "rien à approuver" state). The inbox `id` is the approval stepId (falls
  // back to the runId) so onApprove → approveAgentRun(agent, runId, id, approved).
  const loadApprovals = useCallback(async () => {
    setApprovalsLoading(true);
    try {
      const raw = await listAgentRuns(AGENT);
      const waiting = (Array.isArray(raw) ? raw : [])
        .map(normalizeRun)
        .filter((r): r is AgentRunRow => !!r && r.state === 'waiting_approval');
      // Best-effort enrich each waiting run with its pending approval descriptor.
      const items = await Promise.all(
        waiting.map(async (run): Promise<ApprovalInboxItem> => {
          let pending: { id: string; title?: string; detail?: string } | null =
            null;
          try {
            const rec = await getAgentRun(AGENT, run.runId);
            pending = readPendingApproval(rec);
          } catch {
            // ignore — fall back to the run prompt + runId below
          }
          const fallbackTitle =
            (run.prompt ?? '').trim() || t('bureau.approvals.fallbackTitle');
          return {
            id: pending?.id || run.runId,
            runId: run.runId,
            title: pending?.title || fallbackTitle,
            detail: pending?.detail,
            at: run.startedAt ?? run.endedAt ?? Date.now(),
          };
        })
      );
      setApprovals(items);
    } catch {
      // 404 (feature off) or any error ⇒ empty inbox (calm empty state).
      setApprovals([]);
    } finally {
      setApprovalsLoading(false);
    }
  }, [t]);

  // Resolve one approval: bridge the inbox `(id, approved)` to the runs API
  // `approveAgentRun(agent, runId, stepId, approved)`. The runId is looked up
  // from the item's id (which the inbox echoes back). Refreshes the inbox + the
  // runs list on success so the resolved row disappears.
  const onApprove = useCallback(
    (id: string, approved: boolean) => {
      const item = approvals.find(a => a.id === id);
      if (!item) return;
      void (async () => {
        try {
          await approveAgentRun(AGENT, item.runId, id, approved);
        } catch {
          // Best-effort: a failed decision leaves the row for a retry.
        } finally {
          void loadApprovals();
          void loadRuns();
        }
      })();
    },
    [approvals, loadApprovals, loadRuns]
  );

  // ---- R11: scheduled missions (MissionsCard) -----------------------------
  // From listTriggers('hermes') (R8). A 404 (triggers feature off) hides the
  // card silently (missionsOn=false); any other failure also degrades to an
  // empty, dark card rather than an error.
  const loadMissions = useCallback(async () => {
    setMissionsLoading(true);
    try {
      const rows = await listTriggers(AGENT);
      setTriggers(Array.isArray(rows) ? rows : []);
      setMissionsOn(true);
    } catch (err) {
      if (err instanceof AgentApiError && err.status === 404) {
        setMissionsOn(false);
        setTriggers([]);
        return;
      }
      setMissionsOn(prev => (prev === true ? true : prev));
      setTriggers([]);
    } finally {
      setMissionsLoading(false);
    }
  }, []);

  // Toggle a mission active/paused (optimistic-free: re-load on completion).
  const onToggleMission = useCallback(
    (id: string) => {
      void (async () => {
        try {
          await toggleTrigger(AGENT, id);
        } catch {
          // Best-effort — re-load reflects the true state either way.
        } finally {
          void loadMissions();
        }
      })();
    },
    [loadMissions]
  );

  useEffect(() => {
    void loadThreads();
    void loadCaps();
    void loadRuns();
    void loadPulse();
    void loadApprovals();
    void loadMissions();
  }, [
    loadThreads,
    loadCaps,
    loadRuns,
    loadPulse,
    loadApprovals,
    loadMissions,
  ]);

  // The Quick-stats grid the base rendered (Runs / Last run / Tools ready /
  // Saved workflows) is intentionally REPLACED by the business-pulse hero
  // (<PulseCard>) per the persona doc ("replaces the stat-grid-first
  // dashboard" — Hermès greets you with your business, not its own plumbing).
  // The threads / caps loads survive (Recent runs + Tools & connections still
  // consume them); only the derived stat tiles are gone.
  const savedWorkflows: SavedWorkflow[] = config.savedWorkflows ?? [];
  const plannerReady = !!caps?.plannerReady;
  const agentName = config.agentName || 'Hermes';
  // The section is only rendered once the probe confirms the feature is on.
  const showExecutions = runsEnabled === true;
  // The missions card renders once triggers are confirmed on (like Exécutions).
  const showMissions = missionsOn === true;
  // The COD desk only shows when the pulse read surfaced an orders sample.
  const showCodDesk = codOrders.length > 0;
  // A calm reporting-state lamp while pulse settles, then idle.
  const presencePhase = pulseLoading ? 'planning' : 'done';

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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        // Le Bureau reads as a single, scannable desk column (persona doc:
        // ≤720px center column). The retained R6-R10 panels sit below it.
        maxWidth: 720,
        marginLeft: 'auto',
        marginRight: 'auto',
        width: '100%',
      }}
    >
      {/* ---- Greeting bar: the employee reports where things stand ---------
          Replaces the stat-grid-first header. A darja greeting + a reporting-
          state presence lamp + last-sweep time; the chat is demoted to a
          compact "Parler à {name}" button (talking is one affordance, not the
          product). Settings stays as a quiet secondary. */}
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
                position: 'relative',
                width: 40,
                height: 40,
                borderRadius: 12,
                flexShrink: 0,
                display: 'grid',
                placeItems: 'center',
                background: acc.accentSoft,
                border: `1px solid ${acc.accentSoft}`,
                color: acc.accent,
              }}
            >
              <ChatWithAiIcon style={{ fontSize: 22 }} />
              {/* The stateful presence lamp — idles / reports (persona doc). */}
              <span
                style={{
                  position: 'absolute',
                  right: -2,
                  bottom: -2,
                  display: 'grid',
                  placeItems: 'center',
                  background: C.bg,
                  borderRadius: '50%',
                  padding: 2,
                }}
              >
                <AgentPresence
                  agent={AGENT}
                  phase={presencePhase}
                  running={pulseLoading}
                  size={8}
                />
              </span>
            </span>
            <div style={{ minWidth: 0 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: 21,
                  fontWeight: 800,
                  color: C.text,
                  lineHeight: 1.25,
                }}
              >
                {t('bureau.greeting', { name: agentName })}
              </h1>
              <p
                style={{
                  margin: '2px 0 0',
                  fontSize: 12.5,
                  color: C.muted,
                }}
              >
                {lastSweep
                  ? t('bureau.lastSweep', { when: timeAgo(lastSweep) })
                  : t('bureau.subtitle')}
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
            ⚙ {t('bureau.settings')}
          </button>
          {/* Demoted chat: "Parler à {name}" → the existing console nav. */}
          <button style={btnStyle('primary')} onClick={() => onOpenConsole()}>
            <ChatWithAiIcon style={{ fontSize: 15 }} />{' '}
            {t('bureau.talkTo', { name: agentName })}
          </button>
        </div>
      </div>

      {/* ---- Planner-offline notice (mirrors the console's blocking notice) */}
      {capsState === 'ready' && !plannerReady ? (
        <Banner tone="warn">
          <strong>Planificateur hors ligne.</strong>&nbsp;Hermes ne peut pas s'exécuter tant que le propriétaire
          n'a pas configuré la clé de raisonnement sur le serveur. Votre configuration, vos outils et
          vos flux de travail restent disponibles.
        </Banner>
      ) : null}

      {/* ---- 1. Business pulse hero (PulseCard) ---------------------------
          Fed by GET /api/v1/agents/pulse via getAgentPulse. Fail-soft: a null
          pulse renders PulseCard's own warm new-hire empty state, so a not-yet-
          connected merchant is greeted, not error'd. */}
      <PulseCard
        agent={AGENT}
        pulse={pulse}
        loading={pulseLoading}
        onRefresh={() => void loadPulse()}
      />

      {/* ---- 2. À valider (ApprovalInbox) --------------------------------
          The employee asks permission for consequential acts. Built from the
          waiting_approval background runs; onApprove bridges to approveAgentRun.
          The card renders its own calm empty state when nothing is pending. */}
      <ApprovalInbox
        items={approvals}
        onApprove={onApprove}
        loading={approvalsLoading}
      />

      {/* ---- 3. La file COD (CodDesk) ------------------------------------
          Algeria's #1 daily job as first-class UI. Best-effort from the pulse
          read's orders sample — hidden entirely when no orders data is present
          (keeps the desk honest rather than showing an empty shell). */}
      {showCodDesk ? (
        <CodDesk
          orders={codOrders}
          onConfirm={() => void loadPulse()}
          onAdvance={() => void loadPulse()}
          loading={pulseLoading}
        />
      ) : null}

      {/* ---- 4. Missions programmées (MissionsCard) ---------------------
          Scheduled jobs from listTriggers('hermes') (R8). "Ouvrir" navigates to
          the full /agents/triggers page. Gated like Exécutions: hidden when the
          triggers feature is off (a 404 on the list). */}
      {showMissions ? (
        <MissionsCardNav triggers={triggers} onToggle={onToggleMission} />
      ) : null}

      {/* ---- Exécutions (R6 background runs) — hidden unless the feature is on */}
      {showExecutions ? (
        <Panel
          title="Exécutions"
          action={
            <button
              style={miniBtnStyle('secondary')}
              onClick={() => void loadRuns()}
              title="Actualiser les exécutions"
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
              <Spinner /> Chargement des exécutions en arrière-plan…
            </div>
          ) : runsState === 'error' ? (
            <Banner tone="error">
              Impossible de charger les exécutions en arrière-plan.{' '}
              <button
                style={{ ...miniBtnStyle('secondary'), display: 'inline-flex' }}
                onClick={() => void loadRuns()}
              >
                Réessayer
              </button>
            </Banner>
          ) : runs.length === 0 ? (
            <EmptyNote>
              Aucune exécution en arrière-plan. Tapez un objectif ci-dessus et appuyez sur{' '}
              <strong>Exécuter en arrière-plan</strong> — l'exécution continue même si vous
              fermez cet onglet.
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
            title="Exécutions récentes"
            action={
              <button
                style={miniBtnStyle('secondary')}
                onClick={() => void loadThreads()}
                title="Actualiser les exécutions"
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
                <Spinner /> Chargement de vos exécutions…
              </div>
            ) : threadsState === 'error' ? (
              <Banner tone="error">
                Impossible de charger vos exécutions.{' '}
                <button
                  style={{ ...miniBtnStyle('secondary'), display: 'inline-flex' }}
                  onClick={() => void loadThreads()}
                >
                  Réessayer
                </button>
              </Banner>
            ) : threads.length === 0 ? (
              <EmptyNote>
                Aucune exécution. Lancez-en une depuis un flux ci-dessous ou appuyez sur{' '}
                <strong>Nouvelle exécution</strong>.
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
            title="Flux enregistrés"
            action={
              <button
                style={miniBtnStyle('secondary')}
                onClick={onReconfigure}
                title="Modifier les flux enregistrés"
              >
                Modifier
              </button>
            }
          >
            {savedWorkflows.length === 0 ? (
              <EmptyNote>
                Aucun flux enregistré.{' '}
                <button
                  style={{ ...miniBtnStyle('primary'), display: 'inline-flex' }}
                  onClick={onReconfigure}
                >
                  Ajouter
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
          <Panel title="Outils & connexions">
            {capsState === 'error' ? (
              <Banner tone="error">
                Impossible de charger la disponibilité des outils.{' '}
                <button
                  style={{ ...miniBtnStyle('secondary'), display: 'inline-flex' }}
                  onClick={() => void loadCaps()}
                >
                  Réessayer
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
            Mode d'exécution par défaut
          </div>
          <div style={{ fontSize: 12, color: C.muted }}>
            {MODE_LABEL[config.defaultMode ?? 'ask']} · modifiable à chaque exécution dans la
            console.
          </div>
        </div>
        <button style={btnStyle('primary')} onClick={() => onOpenConsole()}>
          Ouvrir la console →
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
            // A closed run may have resolved an approval — refresh the inbox.
            void loadApprovals();
          }}
        />
      ) : null}
    </div>
  );
};

// ---- sub-components --------------------------------------------------------

// MissionsCard nav wrapper — the Trame <MissionsCard> is pure/presentational and
// takes an `onOpen` handler; the persona doc + brief route "Ouvrir" to the full
// /agents/triggers page. In-workbench navigation uses <WorkbenchLink> (the
// pattern connections.tsx uses), so we render a hidden link and click it from
// onOpen — keeping MissionsCard decoupled from routing while honouring the
// in-workbench nav rule (no target=_blank).
const MissionsCardNav = ({
  triggers,
  onToggle,
}: {
  triggers: AgentTrigger[];
  onToggle: (id: string) => void;
}) => {
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  // Map the api AgentTrigger[] to the MissionsCard trigger shape (R8 shape:
  // {id, preset, prompt, active, nextFireAt?}). Defensive: only rows with an id.
  const missionTriggers = useMemo(
    () =>
      (Array.isArray(triggers) ? triggers : [])
        .filter(tr => tr && typeof tr.id === 'string' && tr.id.length > 0)
        .map(tr => ({
          id: tr.id,
          preset: tr.preset,
          prompt: tr.prompt,
          active: !!tr.active,
          nextFireAt: tr.nextFireAt,
        })),
    [triggers]
  );
  return (
    <>
      <MissionsCard
        triggers={missionTriggers}
        onToggle={onToggle}
        onOpen={() => linkRef.current?.click()}
      />
      {/* Hidden in-workbench nav target for MissionsCard's onOpen. */}
      <WorkbenchLink
        ref={linkRef}
        to="/agents/triggers"
        draggable={false}
        aria-hidden
        tabIndex={-1}
        style={{ display: 'none' }}
      />
    </>
  );
};

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
        {thread.title || 'Exécution sans titre'}
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
        {workflow.title || 'Flux enregistré'}
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
      title="Charger dans la console"
    >
      Exécuter →
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
      else setErr('Impossible de démarrer l'exécution — veuillez réessayer.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Impossible de démarrer l'exécution.');
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
            ? 'Planificateur hors ligne — les exécutions en arrière-plan sont désactivées'
            : 'Décrivez un objectif à exécuter en arrière-plan (continue-en-arrière-plan)…'
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
          Les exécutions continuent si vous fermez l'onglet · apparaît ci-dessous, diffuse en direct.
        </span>
        <button
          style={{
            ...miniBtnStyle('primary', disabled || busy || !value.trim()),
            flexShrink: 0,
          }}
          disabled={disabled || busy || !value.trim()}
          onClick={() => void submit()}
          title="Démarrer cette exécution en arrière-plan"
        >
          {busy ? (
            <>
              <Spinner dark /> Démarrage…
            </>
          ) : (
            <>🌙 Exécuter en arrière-plan</>
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
  const preview = (run.prompt ?? '').trim() || 'Exécution sans titre';
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
          {when ? timeAgo(when) : 'à l'instant'}
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
// plus a final answer card (StreamingAnswer — animated reveal while `isLive`,
// handing off to MarkdownLite internally once the run settles). On first mount
// it seeds from the persisted record (getAgentRun) so an already-finished run
// shows instantly,
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
      aria-label="Exécution en arrière-plan"
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
            Exécution en arrière-plan
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
              <Spinner /> en direct
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            title="Fermer"
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
              <Spinner /> Connexion à l'exécution…
            </div>
          ) : recordState === 'error' && steps.length === 0 && !finalText ? (
            <Banner tone="error">
              Impossible de charger cette exécution.{' '}
              <button
                style={{ ...miniBtnStyle('secondary'), display: 'inline-flex' }}
                onClick={() => {
                  void loadRecord();
                  stream.reattach?.();
                }}
              >
                Réessayer
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
                  {/* The one spot in this surface where the wait IS the model
                      thinking, so it gets the AI pulse rather than the generic
                      mechanical spinner used for list/attach states. */}
                  <CdzAILoading /> Traitement…
                </div>
              ) : (
                <EmptyNote>Aucune étape enregistrée pour cette exécution.</EmptyNote>
              )}

              {errorText ? (
                <Banner tone="error">
                  <strong>Erreur d'exécution.</strong>&nbsp;{errorText}
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
                    Réponse finale
                  </div>
                  <StreamingAnswer text={finalText} live={isLive} />
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
