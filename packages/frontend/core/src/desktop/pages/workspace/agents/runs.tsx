import { AgentPalette } from '@affine/core/modules/agents/components';
import { ensureClickDzResponsiveCss } from '@affine/core/clickdz/responsive';

// Inject the CDZ responsive stylesheet once per document (idempotent + SSR-safe).
const CdzResponsive = () => { ensureClickDzResponsiveCss(); return null; };
// Jauge's compact spend estimate (token/tool-call → DZD "estimé"). Imported by
// CONTRACT NAME from the components barrel; when the sibling export isn't on
// disk yet the barrel still resolves because the merged barrel re-exports it.
import { SpendMeter } from '@affine/core/modules/agents/components';
import { AgentApiError, listAgentRuns } from '@affine/core/modules/agents/api';
import { type TFunc, useAgentLang } from '@affine/core/modules/agents/i18n';
import type {
  AgentName,
  AgentRunState,
  AgentRunSummary,
} from '@affine/core/modules/agents/types';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchService,
} from '@affine/core/modules/workbench';
// Shared paginated-list kit (R9, Feuillet). Dependency-light, boot-safe; the
// run history is paged (pageSize 10, column) instead of rendering every run.
import { PagedList } from '@affine/core/clickdz/paged-list';
import { useService } from '@toeverything/infra';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

// ---------------------------------------------------------------------------
// ClickDz Agents — Exécutions (run history), full-page (R8 i18n + mobile).
//
// The dedicated, full-page version of the Hermes dashboard's inline
// "Exécutions" panel (hermes/dashboard.tsx). Lists the signed-in user's durable
// background runs for the selected agent (hermes / openclaw), newest first,
// with a state chip, prompt preview, relative time, and a COMPACT spend
// estimate (Jauge). Clicking a row navigates to the single-run live view
// (run.tsx) at `/agents/run/:id?agent=<agent>`.
//
// R8 (WSU-7 / RETOUCHE): all user-facing copy comes from the shared agents i18n
// catalogue via `useAgentLang()` (FR default + Algerian darja); the page root
// gets `dir={dir}` (Arabic → RTL); the layout is mobile-polished (≤560px:
// tighter paddings, filter chips wrap, no horizontal overflow). Behaviour,
// routing (?agent=), props and exports are unchanged.
//
// Data: `listAgentRuns(agent)` — the same call the dashboard uses, which also
// doubles as a capability probe: a 404 means CDZ_AGENTS_ENABLED is off, so we
// show a quiet "Agents non activés" fallback instead of an error (flag-off /
// 404 quiet fallback, per the R7 rules). Every surface has loading / empty /
// error states.
//
// Agent selection is driven by the `?agent=` search param so the choice is
// shareable/bookmarkable; it defaults to `hermes`.
//
// House rules: inline styles only (no .css.ts), no new deps, shared AgentPalette
// tokens, boot-safe. Exports BOTH `Component` (the react-router lazy convention
// every sibling page uses) and a default export.
// ---------------------------------------------------------------------------

const C = AgentPalette.color;
const R = AgentPalette.radius;

// The agents that own a durable-runs history. Kept local (not imported as a
// runtime const) so this file never hard-depends on a registry export. Labels
// are proper nouns (Hermes / OpenClaw) — not localized.
const AGENTS: { id: AgentName; label: string; emoji: string }[] = [
  { id: 'hermes', label: 'Hermes', emoji: '🤝' },
  { id: 'openclaw', label: 'OpenClaw', emoji: '🛠️' },
];

type LoadState = 'loading' | 'ready' | 'error';

// Per-state chip tint (colour). Labels come from the i18n catalogue at render
// (`states.<state>` with the `.short` variants runs.tsx uses for approval /
// failed). Scoped to the AgentRunState union so it stays exhaustive.
const RUN_STATE_TINT: Record<
  AgentRunState,
  { color: string; bg: string; border: string }
> = {
  queued: { color: C.muted, bg: 'transparent', border: C.border },
  running: { color: C.accent, bg: C.accentSoft, border: C.accentBorder },
  waiting_approval: { color: C.warn, bg: C.warnBg, border: C.warnBorder },
  done: { color: C.okText, bg: C.okBg, border: C.okBorder },
  failed: { color: C.errText, bg: C.errBg, border: C.errBorder },
  stopped: { color: C.muted, bg: 'transparent', border: C.border },
};

// i18n key for a run state's SHORT chip label (runs.tsx uses the compact
// register: "Approbation" / "Échec").
const RUN_STATE_KEY: Record<AgentRunState, string> = {
  queued: 'states.queued',
  running: 'states.running',
  waiting_approval: 'states.waiting_approval.short',
  done: 'states.done',
  failed: 'states.failed.short',
  stopped: 'states.stopped',
};

// Coerce an unknown/loose state string into a known AgentRunState.
function coerceRunState(v: unknown): AgentRunState {
  const s = typeof v === 'string' ? v : '';
  return s in RUN_STATE_TINT ? (s as AgentRunState) : 'queued';
}

// Coerce a search-param string into a known AgentName ('hermes' default).
function coerceAgent(v: string | null): AgentName {
  return v === 'openclaw' ? 'openclaw' : 'hermes';
}

// Relative-time formatter using the shared `time.*` catalogue keys ({n} slot).
function timeAgo(t: TFunc, ts?: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return t('time.now');
  const s = Math.floor(diff / 1000);
  if (s < 45) return t('time.now');
  const m = Math.floor(s / 60);
  if (m < 60) return t('time.minAgo', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('time.hrAgo', { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t('time.dayAgo', { n: d });
  const mo = Math.floor(d / 30);
  if (mo < 12) return t('time.monthAgo', { n: mo });
  return t('time.yearAgo', { n: Math.floor(mo / 12) });
}

const AgentsRunsPage = () => {
  const [params, setParams] = useSearchParams();
  const agent = coerceAgent(params.get('agent'));

  const { t, dir } = useAgentLang();
  const workbench = useService(WorkbenchService).workbench;

  const [state, setState] = useState<LoadState>('loading');
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  // One-shot capability probe: null = probing, true = runs API answered, false
  // = 404 (CDZ_AGENTS_ENABLED off) → the quiet "Agents non activés" fallback.
  const [enabled, setEnabled] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const rows = await listAgentRuns(agent);
      const sorted = [...rows].sort(
        (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)
      );
      setRuns(sorted);
      setEnabled(true);
      setState('ready');
    } catch (err) {
      // 404 ⇒ feature flag off: quiet fallback, no error surfaced.
      if (err instanceof AgentApiError && err.status === 404) {
        setEnabled(false);
        setRuns([]);
        setState('ready');
        return;
      }
      // Any other failure keeps the section visible with a retryable error.
      setEnabled(prev => (prev === true ? true : prev));
      setState('error');
    }
  }, [agent]);

  useEffect(() => {
    void load();
  }, [load]);

  const openRun = useCallback(
    (runId: string) => {
      // Navigate to the single-run live view. The agent rides along as a search
      // param because run ids are per-agent (run.tsx needs to know which agent
      // to attach to).
      workbench.open(
        `/agents/run/${encodeURIComponent(runId)}?agent=${agent}`
      );
    },
    [agent, workbench]
  );

  const selectAgent = useCallback(
    (next: AgentName) => {
      const p = new URLSearchParams(params);
      p.set('agent', next);
      setParams(p, { replace: true });
    },
    [params, setParams]
  );

  const showQuietFallback = enabled === false;

  return (
    <>
      <ViewTitle title={t('runs.tabTitle')} />
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
            color: C.text,
          }}
        >
          <span aria-hidden style={{ fontSize: 16 }}>
            🗂️
          </span>
          {t('runs.tabTitle')}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '15px',
              padding: '0 6px',
              borderRadius: 5,
              letterSpacing: '0.05em',
              color: C.muted,
              backgroundColor:
                'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)',
            }}
          >
            {t('common.beta')}
          </span>
        </div>
      </ViewHeader>
      <ViewBody>
        <div
          data-cdz-surface=""
          style={{
            height: '100%',
            width: '100%',
            overflow: 'auto',
            background: C.bg,
            color: C.text,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <CdzResponsive />
          <style>{RUNS_CSS}</style>
          <div
            dir={dir}
            className="cdz-agents-runs-canvas"
            style={{
              maxWidth: 920,
              margin: '0 auto',
              padding: '28px 24px 48px',
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
            }}
          >
            {/* Header + agent filter chips */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 14,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 220 }}>
                <h1
                  style={{
                    margin: 0,
                    fontSize: 22,
                    fontWeight: 800,
                    color: C.text,
                    lineHeight: 1.2,
                  }}
                >
                  {t('runs.title')}
                </h1>
                <p style={{ margin: '4px 0 0', fontSize: 12.5, color: C.muted }}>
                  {t('runs.subtitle')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void load()}
                title={t('common.refresh')}
                style={{
                  appearance: 'none',
                  flexShrink: 0,
                  width: 32,
                  height: 32,
                  borderRadius: R.md,
                  border: `1px solid ${C.border}`,
                  background: C.panel,
                  color: C.muted,
                  cursor: 'pointer',
                  fontSize: 15,
                  lineHeight: 1,
                }}
              >
                ↻
              </button>
            </div>

            {/* Agent filter */}
            <div
              role="tablist"
              aria-label={t('runs.filter.label')}
              style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
            >
              {AGENTS.map(a => {
                const activeAgent = a.id === agent;
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="tab"
                    aria-selected={activeAgent}
                    onClick={() => selectAgent(a.id)}
                    style={{
                      appearance: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      padding: '7px 14px',
                      borderRadius: R.pill,
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 700,
                      color: activeAgent ? C.accent : C.muted,
                      background: activeAgent ? C.accentSoft : 'transparent',
                      border: `1px solid ${
                        activeAgent ? C.accentBorder : C.border
                      }`,
                      transition: 'background 150ms ease, color 150ms ease',
                    }}
                  >
                    <span aria-hidden style={{ fontSize: 15 }}>
                      {a.emoji}
                    </span>
                    {a.label}
                  </button>
                );
              })}
            </div>

            {/* Body: quiet fallback | loading | error | empty | list */}
            {showQuietFallback ? (
              <QuietFallback t={t} />
            ) : state === 'loading' ? (
              <LoadingRow t={t} />
            ) : state === 'error' ? (
              <ErrorRow t={t} onRetry={() => void load()} />
            ) : runs.length === 0 ? (
              <EmptyRow t={t} agentLabel={agentLabel(agent)} />
            ) : (
              // Paged run history (pageSize 10, column). `key={agent}` resets to
              // page 1 whenever the selected agent tab changes (each tab shows
              // its own runs from page 1). Labels come from `pagerLabels(dir)`:
              // the agents i18n catalogue has NO common.prev/common.next keys,
              // so we pass FR/AR literals chosen by text direction rather than
              // invent catalogue keys owned by the agents module.
              <PagedList<AgentRunSummary>
                key={agent}
                items={runs}
                pageSize={10}
                labels={pagerLabels(dir)}
                renderItem={run => (
                  <ExecutionRow
                    key={run.runId}
                    t={t}
                    run={run}
                    onOpen={() => openRun(run.runId)}
                  />
                )}
              />
            )}
          </div>
        </div>
      </ViewBody>
    </>
  );
};

function agentLabel(agent: AgentName): string {
  return AGENTS.find(a => a.id === agent)?.label ?? agent;
}

// Pager labels for the run-history PagedList. The shared agents i18n catalogue
// (modules/agents/i18n.ts) does NOT define common.prev / common.next keys, and
// `t()` returns the key verbatim for an unknown key (never a translated
// string) — so we can't route the pager through the catalogue without adding
// keys owned by the agents module. Instead we pick FR (ltr) or Algerian darja
// (rtl) literals by text direction; this keeps the pager localized in step with
// the page's language without inventing catalogue keys. (If common.prev /
// common.next are later added to the catalogue, swap these for t(...) calls.)
function pagerLabels(dir: 'rtl' | 'ltr'): {
  prev: string;
  next: string;
  page: (n: number, total: number) => string;
} {
  return dir === 'rtl'
    ? {
        prev: '‹ السابق',
        next: 'التالي ›',
        page: (n, total) => `صفحة ${n}/${total}`,
      }
    : {
        prev: '‹ Précédent',
        next: 'Suivant ›',
        page: (n, total) => `Page ${n}/${total}`,
      };
}

// Mobile polish: tighten the canvas padding on phones.
// Run rows: on very narrow phones the right-hand chip + arrow would squeeze the
// prompt preview. We allow the row to wrap so the chip + arrow drop to a second
// line rather than truncating the preview to a few characters.
const RUNS_CSS = `
@media (max-width: 560px){
  .cdz-agents-runs-canvas{padding:18px 14px 40px !important;}
  .cdz-run-row{flex-wrap:wrap !important;}
  .cdz-run-row-meta{flex:0 0 100%;display:flex;justify-content:flex-end;gap:8px;margin-top:2px;}
}
`;

// ---- rows / states ---------------------------------------------------------

const ExecutionRow = ({
  t,
  run,
  onOpen,
}: {
  t: TFunc;
  run: AgentRunSummary;
  onOpen: () => void;
}) => {
  const runState = coerceRunState(run.state);
  const when = run.startedAt ?? run.endedAt;
  const preview = (run.prompt ?? '').trim() || t('runs.untitled');
  return (
    <button
      type="button"
      onClick={onOpen}
      className="cdz-run-row"
      style={{
        appearance: 'none',
        textAlign: 'start',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '11px 13px',
        borderRadius: R.lg,
        background: C.panel,
        border: `1px solid ${C.border}`,
        color: C.text,
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
      <span
        aria-hidden
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: R.md,
          display: 'grid',
          placeItems: 'center',
          fontSize: 14,
          background: C.bg,
          border: `1px solid ${C.border}`,
          color: C.muted,
        }}
      >
        {run.channel === 'telegram' ? '✈️' : '🌙'}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13.5,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {preview}
        </span>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            color: C.muted,
            flexWrap: 'wrap',
            marginTop: 2,
          }}
        >
          <span>{when ? timeAgo(t, when) : t('time.now')}</span>
          <span aria-hidden>·</span>
          {/* Compact spend estimate (Jauge). Reads whatever the run summary
              exposes; if there's no token field it estimates from step/tool-call
              counts and labels it clearly as an estimate. Never gates a run. */}
          <SpendMeter run={run} compact />
        </span>
      </span>
      <RunStateChip t={t} state={runState} />
      <span aria-hidden style={{ color: C.muted, fontSize: 14, flexShrink: 0 }}>
        →
      </span>
    </button>
  );
};

const RunStateChip = ({ t, state }: { t: TFunc; state: AgentRunState }) => {
  const tint = RUN_STATE_TINT[state];
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
        padding: '2px 9px',
        borderRadius: R.pill,
        color: tint.color,
        background: tint.bg,
        border: `1px solid ${tint.border}`,
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
          background: tint.color,
          flexShrink: 0,
        }}
      />
      {t(RUN_STATE_KEY[state])}
    </span>
  );
};

const LoadingRow = ({ t }: { t: TFunc }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '18px 4px',
      color: C.muted,
    }}
  >
    <Spinner /> {t('runs.loading')}
  </div>
);

const ErrorRow = ({ t, onRetry }: { t: TFunc; onRetry: () => void }) => (
  <div
    style={{
      borderRadius: R.lg,
      border: `1px solid ${C.errBorder}`,
      background: C.errBg,
      padding: '14px 16px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
    }}
  >
    <span style={{ flex: 1, minWidth: 180, fontSize: 13, color: C.text }}>
      {t('runs.error.load')}
    </span>
    <button
      type="button"
      onClick={onRetry}
      style={{
        appearance: 'none',
        padding: '6px 14px',
        borderRadius: R.md,
        border: `1px solid ${C.border}`,
        background: C.panel,
        color: C.text,
        cursor: 'pointer',
        fontSize: 12.5,
        fontWeight: 600,
      }}
    >
      {t('common.retry')}
    </button>
  </div>
);

const EmptyRow = ({ t, agentLabel }: { t: TFunc; agentLabel: string }) => (
  <div
    style={{
      borderRadius: R.lg,
      border: `1px dashed ${C.border}`,
      background: C.panel,
      padding: '26px 20px',
      textAlign: 'center',
      color: C.muted,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}
  >
    <span aria-hidden style={{ fontSize: 28, opacity: 0.7 }}>
      🌙
    </span>
    <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
      {t('runs.empty.title')}
    </span>
    <span style={{ fontSize: 12.5, maxWidth: 420, margin: '0 auto' }}>
      {t('runs.empty.body', { agent: agentLabel })}
    </span>
  </div>
);

// Flag-off / 404 quiet fallback — the whole feature is dark server-side.
const QuietFallback = ({ t }: { t: TFunc }) => (
  <div
    style={{
      borderRadius: R.lg,
      border: `1px solid ${C.border}`,
      background: C.panel,
      padding: '26px 20px',
      textAlign: 'center',
      color: C.muted,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}
  >
    <span aria-hidden style={{ fontSize: 26, opacity: 0.7 }}>
      🔒
    </span>
    <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
      {t('runs.quiet.title')}
    </span>
    <span style={{ fontSize: 12.5, maxWidth: 400, margin: '0 auto' }}>
      {t('runs.quiet.body')}
    </span>
  </div>
);

// Minimal local spinner (reuses the shared keyframe injected by the kit; falls
// back to a static ring if the keyframe isn't present).
const Spinner = () => (
  <span
    aria-hidden
    style={{
      display: 'inline-block',
      width: 14,
      height: 14,
      borderRadius: '50%',
      border: `2px solid color-mix(in srgb, ${C.accent} 30%, transparent)`,
      borderTopColor: C.accent,
      animation: 'cdz-agent-spin 0.7s linear infinite',
      flex: '0 0 auto',
    }}
  />
);

export const Component = () => {
  return <AgentsRunsPage />;
};

export default AgentsRunsPage;
