// ClickDz Agents — the unified /agents HOME (R7, WSU-3 / FOYER; R8 i18n + mobile).
//
// This is the router lazy target for the /agents route (Nav registers it),
// reached ONLY when `caps.multi` is on (the sidebar entry is gated) — but it
// degrades gracefully if reached otherwise. It follows the studio-page scaffold
// of hermes/shoperp exactly: ViewTitle / ViewIcon / ViewHeader / ViewBody, a
// centered scrolling canvas, inline styles (no .css.ts), and full loading /
// disabled / error states.
//
// R8 (WSU-7 / RETOUCHE): every user-facing string now comes from the shared
// agents i18n catalogue via `useAgentLang()` (FR default + Algerian darja), the
// home header carries a FR/عربية language toggle (AGENT_LANG_LABELS + setLang),
// the page root gets `dir={dir}` so Arabic renders RTL, and the layout is
// mobile-polished (≤560px: single-column grid, tighter paddings, no horizontal
// overflow). All R7 behaviour / props / exports are preserved.
//
// Data comes from Annuaire's `useAgents()` (GET /api/v1/agents → { agents, caps,
// loading, error, disabled, reload }). The page shows a header, a "Créer un
// agent" CTA that opens the R12 custom-agent creator (Atelier owns create-agent
// .tsx at /agents/new), the agent cards grid (Hermes + OpenClaw + the caller's
// custom agents), and a compact recent-runs strip. Navigation stays inside the
// workbench via WorkbenchService.open().
//
// R12 (custom agents): when `caps.customEnabled` is on, the roster ALSO carries
// the caller's user-created agents (rows with an `archetype`/`name`/`emoji` and a
// `cz_`-prefixed `id`). Those render as <CustomAgentCard> tiles (emoji · name ·
// archetype badge · last-run · open · delete) alongside the two built-ins; the
// create CTA is gated on `caps.customEnabled` (off ⇒ hidden, no create flow).
// Opening a custom agent (or its last-run row) goes to the unified run surface
// (/agents/runs?agent=<id>) — the same route the built-ins' "Exécutions" uses,
// which already keys by the opaque agent id. Deleting one calls
// `deleteCustomAgent(id)` then `reload()`.
//
// House rules honored: no new deps, boot-safe, reuse AgentPalette + the shared
// Spinner/Chip primitives, mobile single-column (auto-fill grid collapses).

import {
  accentFor,
  AgentPalette,
  BudgetBar,
  Chip,
  IconButton,
  Spinner,
} from '@affine/core/modules/agents/components';
// R11 (WS11-11, BUDGET): the home embeds the soft month-to-date <BudgetBar>; it
// fetches GET /api/v1/agents/budget via Pouls's api wrapper. On 404 (feature
// dark: CDZ_AGENTS_ENABLED off) the bar hides — byte-identical legacy home.
// R12 (custom agents): `deleteCustomAgent` removes a user-created agent (DELETE
// /api/v1/agents/custom/:id) from its card; the roster is then reloaded.
import {
  AgentApiError,
  deleteCustomAgent,
  getAgentBudget,
} from '@affine/core/modules/agents/api';
import {
  AGENT_LANG_LABELS,
  type AgentLang,
  type TFunc,
  useAgentLang,
} from '@affine/core/modules/agents/i18n';
import { useAgents } from '@affine/core/modules/agents/use-agents';
import type { AgentName, AgentSummary } from '@affine/core/modules/agents/types';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchService,
} from '@affine/core/modules/workbench';
import { AiIcon } from '@blocksuite/icons/rc';
import { useService } from '@toeverything/infra';
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';

import { AgentCard } from './agent-card';

const C = AgentPalette.color;

// Route the "Créer un agent" flow lives at (Atelier owns create-agent.tsx;
// Nav/Aiguille registers this route → the R12 custom-agent creator). Kept as a
// single const so the CTA and any future entry agree.
const WIZARD_ROUTE = '/agents/new';

// Legacy per-agent studio routes — the built-ins' "Ouvrir" / "Configurer"
// targets. These ALWAYS exist (they stay forever as aliases per the R7
// contract), so opening a BUILT-IN agent never dead-ends. Custom agents have no
// studio page (by design) — they use the unified run/connections/triggers
// surfaces, so their card opens {@link runsRoute} instead.
const STUDIO_ROUTE: Record<AgentName, string> = {
  hermes: '/hermes',
  openclaw: '/openclaw',
};

// The two built-in agent ids. A roster row whose id is NOT one of these is a
// user-created custom agent (opaque `cz_`-prefixed id) — it renders as a
// <CustomAgentCard> and opens the unified run surface. Defensive against an
// evolving roster; never trusts a request id (the backend already scoped it).
const BUILTIN_IDS: ReadonlySet<string> = new Set<string>(['hermes', 'openclaw']);
function isBuiltinId(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

// The unified run-history route (Scene owns runs.tsx under this dir; Nav
// registers `/agents/runs?agent=`). Accepts any agent id (a built-in name OR a
// custom `cz_`-prefixed id) — the surface keys by the opaque id.
function runsRoute(agent: string): string {
  return `/agents/runs?agent=${encodeURIComponent(agent)}`;
}

// i18n key for a custom agent's archetype badge (Opérateur / Ingénieur).
const ARCHETYPE_LABEL_KEY: Record<string, string> = {
  hermes: 'create.archetype.operator.title',
  openclaw: 'create.archetype.engineer.title',
};

// Run-state → chip tint (labels come from the i18n catalogue at render, via
// `states.<state>`). Mirrors the card's map; kept local so the two surfaces
// stay independent files.
const RUN_STATE_TINT: Record<
  string,
  { color: string; bg: string; border: string }
> = {
  queued: { color: C.muted, bg: 'transparent', border: C.border },
  running: { color: C.accent, bg: C.accentSoft, border: C.accentBorder },
  waiting_approval: { color: C.warn, bg: C.warnBg, border: C.warnBorder },
  done: { color: C.okText, bg: C.okBg, border: C.okBorder },
  failed: { color: C.errText, bg: C.errBg, border: C.errBorder },
  stopped: { color: C.muted, bg: 'transparent', border: C.border },
};

// Relative-time formatter using the shared `time.*` catalogue keys ({n} slot).
function relativeTime(t: TFunc, ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return t('time.now');
  const min = Math.floor(diff / 60000);
  if (min < 60) return t('time.minAgo', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('time.hrAgo', { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return t('time.dayAgo', { n: day });
  return t('time.weekAgo', { n: Math.floor(day / 7) });
}

const AGENT_LABEL: Record<AgentName, string> = {
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
};

// ---------------------------------------------------------------------------
// Language toggle — a small FR/عربية segmented control (uses AGENT_LANG_LABELS
// + setLang from the i18n hook). Purely presentational; flipping it re-renders
// the whole studio via the module-level broadcast.
// ---------------------------------------------------------------------------
const LANG_ORDER: AgentLang[] = ['fr', 'ar'];

function LangToggle({
  lang,
  setLang,
  t,
}: {
  lang: AgentLang;
  setLang: (l: AgentLang) => void;
  t: TFunc;
}) {
  return (
    <div
      role="group"
      aria-label={t('lang.toggleTitle')}
      title={t('lang.toggleTitle')}
      dir="ltr"
      style={{
        display: 'inline-flex',
        flex: '0 0 auto',
        padding: 2,
        gap: 2,
        borderRadius: AgentPalette.radius.pill,
        border: `1px solid ${C.border}`,
        background: C.panel,
      }}
    >
      {LANG_ORDER.map(l => {
        const active = l === lang;
        return (
          <button
            key={l}
            type="button"
            aria-pressed={active}
            onClick={() => setLang(l)}
            style={{
              appearance: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 700,
              lineHeight: 1.2,
              padding: '4px 12px',
              borderRadius: AgentPalette.radius.pill,
              border: 'none',
              whiteSpace: 'nowrap',
              color: active ? C.onAccent : C.muted,
              background: active ? C.accent : 'transparent',
              transition: 'background 150ms ease, color 150ms ease',
            }}
          >
            {AGENT_LANG_LABELS[l]}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// R11 (WS11-11, BUDGET) — the home's soft month-to-date budget bar. Fetches
// GET /api/v1/agents/budget (Pouls's getAgentBudget wrapper) once on mount and
// renders the shared presentational <BudgetBar budget/> (Trame). The bar is
// SOFT: it warns at ≥80% and NEVER blocks; when the backend reports monthDzd===0
// (env CDZ_AGENT_MONTHLY_DZD unset — the default) it shows usage only (tokens +
// runs today), no limit. Fail-soft: a 404 (feature dark: CDZ_AGENTS_ENABLED off)
// OR any other error hides the bar entirely, so the home is byte-identical to the
// pre-R11 build when the route is absent. No dependency on useAgents() — a single
// self-contained fetch keyed to nothing (runs once), matching the triggers.tsx
// load() idiom (AgentApiError → status 404 ⇒ quiet hide).
// ---------------------------------------------------------------------------
type HomeBudget = Awaited<ReturnType<typeof getAgentBudget>>;

const HomeBudgetBar = () => {
  const [budget, setBudget] = useState<HomeBudget | null>(null);
  const [loading, setLoading] = useState(true);
  // `hidden` latches on when the route is dark (404) or errors — the whole bar
  // then renders nothing (byte-identical legacy home).
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const b = await getAgentBudget();
        if (!alive) return;
        setBudget(b ?? null);
        setLoading(false);
      } catch (err) {
        if (!alive) return;
        // 404 ⇒ feature off; any other failure ⇒ also hide (soft, non-blocking).
        if (err instanceof AgentApiError && err.status === 404) {
          setHidden(true);
        } else {
          setHidden(true);
        }
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (hidden) return null;
  // While the first fetch is in flight, render nothing (no layout jump); the bar
  // appears once data lands. BudgetBar itself renders a `loading` skeleton when
  // asked, but on the home we prefer a silent first paint.
  if (loading || !budget) return null;
  return <BudgetBar budget={budget} />;
};

// ---------------------------------------------------------------------------
// CustomAgentCard (R12) — a roster tile for a user-created agent. Unlike the
// built-in <AgentCard> (fixed icon glyph + fixed studio route), a custom card
// shows the user's EMOJI + name + an archetype badge (which built-in it clones)
// + a compact last-run summary, opens the unified run surface (custom agents
// have no studio page), and carries a delete affordance. Presentational: it
// takes the summary + handlers via props and never fetches. It reuses the
// per-archetype accent (accentFor) so an Opérateur reads teal-ish and an
// Ingénieur phosphor-green, matching the run view's identity.
// ---------------------------------------------------------------------------
const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'waiting_approval']);

function CustomAgentCard({
  agent,
  t,
  onOpen,
  onDelete,
  deleting,
}: {
  agent: AgentSummary;
  t: TFunc;
  onOpen: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const archetype = agent.archetype ?? 'hermes';
  const accent = accentFor(archetype);
  const emoji = (agent.emoji && agent.emoji.trim()) || '🤖';
  const displayName = agent.name || agent.label || t('create.review.unnamed');
  const lastRun = agent.lastRun;
  const runTint = lastRun
    ? RUN_STATE_TINT[lastRun.state] ?? {
        color: C.muted,
        bg: 'transparent',
        border: C.border,
      }
    : null;
  const runLabel = lastRun
    ? RUN_STATE_TINT[lastRun.state]
      ? t(`states.${lastRun.state}`)
      : lastRun.state || t('states.unknown')
    : '';
  const activeRun = !!lastRun && ACTIVE_RUN_STATES.has(lastRun.state);
  const archetypeKey = ARCHETYPE_LABEL_KEY[archetype];

  return (
    <div
      className="cdz-agent-fade"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 18,
        borderRadius: AgentPalette.radius.lg,
        border: `1px solid ${C.border}`,
        background: C.panel,
        minWidth: 0,
      }}
    >
      {/* Identity row: emoji avatar + name + archetype badge, delete pinned end. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div
          aria-hidden
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 42,
            height: 42,
            flex: '0 0 auto',
            fontSize: 24,
            borderRadius: AgentPalette.radius.md,
            color: accent.accent,
            background: accent.accentSoft,
            border: `1px solid ${accent.accent}`,
          }}
        >
          {emoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: C.text,
                lineHeight: 1.2,
                wordBreak: 'break-word',
              }}
            >
              {displayName}
            </span>
            {archetypeKey ? (
              <Chip color={accent.accent} bg={accent.accentSoft} border={accent.accent}>
                {t(archetypeKey)}
              </Chip>
            ) : null}
          </div>
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 12.5,
              color: C.muted,
              lineHeight: 1.45,
            }}
          >
            {t('card.custom.blurb')}
          </p>
        </div>
        <IconButton
          label={t('card.custom.delete')}
          danger
          disabled={deleting}
          onClick={onDelete}
        >
          {deleting ? '…' : '🗑'}
        </IconButton>
      </div>

      {/* Last-run summary. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: C.muted,
          minHeight: 20,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontWeight: 600 }}>{t('card.lastRun')}</span>
        {runTint ? (
          <>
            <Chip color={runTint.color} bg={runTint.bg} border={runTint.border}>
              {activeRun ? (
                <span
                  className="cdz-agent-motion"
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: runTint.color,
                    animation: 'cdz-agent-pulse 1.4s ease-in-out infinite',
                  }}
                />
              ) : null}
              {runLabel}
            </Chip>
            {relativeTime(t, lastRun?.at) ? (
              <span style={{ color: C.muted }}>{relativeTime(t, lastRun?.at)}</span>
            ) : null}
          </>
        ) : (
          <span style={{ color: C.muted, fontStyle: 'italic' }}>
            {t('card.lastRun.none')}
          </span>
        )}
      </div>

      {/* Actions: primary Ouvrir → unified run surface. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
        <button type="button" onClick={onOpen} style={cardOpenBtn}>
          {t('card.action.open')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page body (inside the ViewBody canvas). Owns the state machine on the
// useAgents() lifecycle.
// ---------------------------------------------------------------------------
const AgentsHome = () => {
  const workbench = useService(WorkbenchService).workbench;
  const { lang, setLang, t, dir } = useAgentLang();
  const { agents, caps, loading, error, disabled, reload } = useAgents();

  const go = useCallback(
    (path: string) => {
      workbench.open(path, { at: 'active' });
    },
    [workbench]
  );

  const openWizard = useCallback(() => go(WIZARD_ROUTE), [go]);

  // R12: id of the custom agent whose delete is in flight (disables its trash
  // button + shows a spinner glyph). Null when nothing is being deleted.
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // R12: delete a custom agent then refresh the roster. Idempotent server-side
  // (a missing/not-owned id resolves deleted:false); fail-soft — on error we
  // just clear the in-flight flag (the card stays; the user can retry).
  const handleDeleteCustom = useCallback(
    async (id: string) => {
      if (!id || deletingId) return;
      setDeletingId(id);
      try {
        await deleteCustomAgent(id);
      } catch {
        // Swallow — a failed delete leaves the card in place; reload() below
        // still reconciles with the server's truth.
      } finally {
        setDeletingId(null);
        reload();
      }
    },
    [deletingId, reload]
  );

  // R12: split the roster into the two built-ins (rendered with <AgentCard>) and
  // the caller's custom agents (rendered with <CustomAgentCard>). A row is custom
  // when its id is not a built-in name (an opaque `cz_`-prefixed id). Built-ins
  // keep their backend display order first, then custom agents follow.
  const builtinAgents = useMemo(
    () => agents.filter(a => isBuiltinId(a.id)),
    [agents]
  );
  const customAgents = useMemo(
    () => agents.filter(a => !isBuiltinId(a.id)),
    [agents]
  );

  // Build the recent-runs strip: every agent that has a lastRun, newest first.
  const recentRuns = useMemo(() => {
    return agents
      .filter((a): a is AgentSummary & { lastRun: NonNullable<AgentSummary['lastRun']> } =>
        !!a.lastRun
      )
      .sort((a, b) => (b.lastRun.at || 0) - (a.lastRun.at || 0));
  }, [agents]);

  // ---- loading -----------------------------------------------------------
  if (loading && agents.length === 0) {
    return (
      <div
        dir={dir}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '28px 4px',
          color: C.muted,
        }}
      >
        <Spinner /> {t('home.loading')}
      </div>
    );
  }

  // ---- disabled / feature-off (should not happen: caps gate the nav) -----
  if (disabled) {
    return (
      <div
        dir={dir}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          maxWidth: 520,
          padding: '18px 20px',
          borderRadius: AgentPalette.radius.lg,
          border: `1px dashed ${C.border}`,
          background: C.panel,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
          {t('home.disabled.title')}
        </div>
        <p style={{ margin: 0, fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
          {t('home.disabled.body')}
        </p>
      </div>
    );
  }

  // ---- error -------------------------------------------------------------
  if (error && agents.length === 0) {
    return (
      <div
        dir={dir}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          maxWidth: 520,
          padding: '18px 20px',
          borderRadius: AgentPalette.radius.lg,
          border: `1px solid ${C.errBorder}`,
          background: C.errBg,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
          {t('home.error.title')}
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 12.5,
            color: C.muted,
            lineHeight: 1.5,
            wordBreak: 'break-word',
          }}
        >
          {error}
        </p>
        <div>
          <button type="button" onClick={() => reload()} style={primaryBtn}>
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  // ---- ready -------------------------------------------------------------
  return (
    <div dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* Header + darja subtitle + language toggle. */}
      <header
        className="cdz-agents-home-head"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 260px', minWidth: 0 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 24,
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: C.text,
            }}
          >
            <AiIcon style={{ fontSize: 22 }} /> {t('home.title')}
          </h1>
          <p style={{ margin: 0, fontSize: 13.5, color: C.muted, lineHeight: 1.5 }}>
            {t('home.subtitle')}
          </p>
        </div>
        <LangToggle lang={lang} setLang={setLang} t={t} />
      </header>

      {/* R11 (WS11-11, BUDGET): soft month-to-date spend + runs-today bar. Hides
          itself when the /agents/budget route is dark (404) or errors, so the
          home stays byte-identical when the feature is off. Never blocks. */}
      <HomeBudgetBar />

      {/* "Créer un agent" CTA — opens the R12 custom-agent creator. Gated on
          caps.customEnabled: when custom agents are dark the create affordance
          is hidden entirely (no dead-end flow), and the home shows only the two
          built-ins. */}
      {caps.customEnabled ? (
        <div
          className="cdz-agents-home-cta"
          style={{
            borderRadius: AgentPalette.radius.lg,
            border: `1px solid ${C.border}`,
            background: `linear-gradient(135deg, ${C.accentSoft}, transparent)`,
            padding: '20px 20px',
            display: 'flex',
            gap: 18,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: '1 1 300px', minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>
              {t('home.cta.title')}
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
              {t('home.cta.body')}
            </p>
            <div dir="rtl" style={{ marginTop: 6, fontSize: 12.5, color: C.muted }}>
              {t('home.cta.hint')}
            </div>
          </div>
          <button
            type="button"
            onClick={openWizard}
            style={{ ...primaryBtn, fontSize: 14.5, padding: '11px 20px' }}
          >
            {t('home.cta.button')}
          </button>
        </div>
      ) : null}

      {/* Agent cards grid — auto-fill collapses to a single column on mobile.
          Built-ins render with <AgentCard> (fixed studio routes); the caller's
          custom agents (R12) render with <CustomAgentCard> in the same grid. */}
      {agents.length > 0 ? (
        <div
          className="cdz-agents-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 16,
          }}
        >
          {builtinAgents.map(agent => {
            const studio = STUDIO_ROUTE[agent.id as AgentName] ?? `/agents/${agent.id}`;
            return (
              <AgentCard
                key={agent.id}
                agent={agent}
                onOpen={() => go(studio)}
                onOpenRuns={() => go(runsRoute(agent.id))}
                onConfigure={() => go(studio)}
              />
            );
          })}
          {customAgents.map(agent => (
            <CustomAgentCard
              key={agent.id}
              agent={agent}
              t={t}
              onOpen={() => go(runsRoute(agent.id))}
              onDelete={() => handleDeleteCustom(agent.id)}
              deleting={deletingId === agent.id}
            />
          ))}
        </div>
      ) : (
        // No roster (rare when the feature is on): keep the CTA above meaningful.
        <div
          style={{
            padding: '18px 20px',
            borderRadius: AgentPalette.radius.lg,
            border: `1px dashed ${C.border}`,
            color: C.muted,
            fontSize: 13,
          }}
        >
          {t('home.empty')}
        </div>
      )}

      {/* Compact recent-runs strip. */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={sectionTitleStyle}>{t('home.recent.title')}</div>
        {recentRuns.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              borderRadius: AgentPalette.radius.lg,
              border: `1px solid ${C.border}`,
              background: C.panel,
              overflow: 'hidden',
            }}
          >
            {recentRuns.map((a, i) => {
              const tint = RUN_STATE_TINT[a.lastRun.state] ?? {
                color: C.muted,
                bg: 'transparent',
                border: C.border,
              };
              const stateLabel = RUN_STATE_TINT[a.lastRun.state]
                ? t(`states.${a.lastRun.state}`)
                : a.lastRun.state || t('states.unknown');
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => go(runsRoute(a.id))}
                  style={{
                    appearance: 'none',
                    textAlign: 'start',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '11px 16px',
                    background: 'transparent',
                    border: 'none',
                    color: C.text,
                    ...(i > 0 ? { borderTop: `1px solid ${C.border}` } : {}),
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: C.text,
                      flex: '0 0 auto',
                      minWidth: 84,
                    }}
                  >
                    {a.emoji && !isBuiltinId(a.id) ? `${a.emoji} ` : ''}
                    {AGENT_LABEL[a.id as AgentName] ?? a.name ?? a.label}
                  </span>
                  <Chip color={tint.color} bg={tint.bg} border={tint.border}>
                    {stateLabel}
                  </Chip>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>
                    {relativeTime(t, a.lastRun.at)}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: C.accent,
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('common.view')}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div
            style={{
              padding: '14px 16px',
              borderRadius: AgentPalette.radius.lg,
              border: `1px dashed ${C.border}`,
              color: C.muted,
              fontSize: 12.5,
            }}
          >
            {t('home.recent.empty')}
          </div>
        )}
      </section>
    </div>
  );
};

// ---------------------------------------------------------------------------
// The page shell — the studio scaffold (ViewTitle/…/ViewBody), matching the
// hermes + shoperp idiom so /agents reads as a first-class studio.
// ---------------------------------------------------------------------------
const AgentsPage = () => {
  const { t } = useAgentLang();
  return (
    <>
      <ViewTitle title={t('home.tabTitle')} />
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
          <AiIcon style={{ fontSize: 16 }} />
          {t('home.tabTitle')}
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
          <style>{HOME_CSS}</style>
          <div
            className="cdz-agents-home-canvas"
            style={{
              maxWidth: 1120,
              margin: '0 auto',
              padding: '28px 24px 48px',
            }}
          >
            <AgentsHome />
          </div>
        </div>
      </ViewBody>
    </>
  );
};

// Mobile polish: tighten the canvas padding, collapse the card grid to one
// column, and let the header wrap cleanly (title + toggle stack) on phones.
const HOME_CSS = `
@media (max-width: 560px){
  .cdz-agents-home-canvas{padding:18px 14px 40px !important;}
  .cdz-agents-grid{grid-template-columns:1fr !important;}
  .cdz-agents-home-cta{padding:16px 14px !important;gap:12px !important;}
}
`;

const sectionTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: C.muted,
};

const primaryBtn: CSSProperties = {
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '8px 16px',
  borderRadius: AgentPalette.radius.sm,
  fontSize: 13,
  fontWeight: 700,
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: C.onAccent,
  background: C.accent,
  border: `1px solid ${C.accent}`,
  whiteSpace: 'nowrap',
};

// Custom-agent card's primary "Ouvrir" button (matches the built-in AgentCard's
// primary action sizing so the two card kinds read identically in the grid).
const cardOpenBtn: CSSProperties = {
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '7px 14px',
  borderRadius: AgentPalette.radius.sm,
  fontSize: 12.5,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
  color: C.onAccent,
  background: C.accent,
  border: `1px solid ${C.accent}`,
};

// Router lazy target: the route loader renders `Component` (same convention as
// every sibling workspace page — hermes/shoperp export `Component`). Also
// provide a default export for the WSU-3 "default-export the page" requirement.
export const Component = () => {
  return <AgentsPage />;
};

export default AgentsPage;
