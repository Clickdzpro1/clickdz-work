// ClickDz Agents — the unified /agents HOME (R7, WSU-3 / FOYER).
//
// This is the router lazy target for the /agents route (Nav registers it),
// reached ONLY when `caps.multi` is on (the sidebar entry is gated) — but it
// degrades gracefully if reached otherwise. It follows the studio-page scaffold
// of hermes/shoperp exactly: ViewTitle / ViewIcon / ViewHeader / ViewBody, a
// centered scrolling canvas, inline styles (no .css.ts), FR-primary copy with a
// darja hint, and full loading / disabled / error states.
//
// Data comes from Annuaire's `useAgents()` (GET /api/v1/agents → { agents, caps,
// loading, error, disabled, reload }). The page shows a header, a "Créer un
// agent" CTA that opens the goal-first wizard (Atelier owns it at /agents/new),
// the agent cards grid (Hermes + OpenClaw), and a compact recent-runs strip.
// Navigation stays inside the workbench via WorkbenchService.open().
//
// House rules honored: no new deps, boot-safe, reuse AgentPalette + the shared
// Spinner/Chip primitives, mobile single-column (auto-fill grid collapses).

import { AgentPalette, Chip, Spinner } from '@affine/core/modules/agents/components';
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
import { type CSSProperties, useCallback, useMemo } from 'react';

import { AgentCard } from './agent-card';

const C = AgentPalette.color;

// Route the goal-first wizard lives at (Atelier owns wizard.tsx; Nav registers
// this route). Kept as a single const so the CTA and any future entry agree.
const WIZARD_ROUTE = '/agents/new';

// Legacy per-agent studio routes — the "Ouvrir" / "Configurer" targets. These
// ALWAYS exist (they stay forever as aliases per the R7 contract), so opening
// an agent never dead-ends even before the new run surfaces are wired.
const STUDIO_ROUTE: Record<AgentName, string> = {
  hermes: '/hermes',
  openclaw: '/openclaw',
};

// The unified run-history route (Scene owns runs.tsx under this dir; Nav
// registers `/agents/runs?agent=`).
function runsRoute(agent: AgentName): string {
  return `/agents/runs?agent=${agent}`;
}

// Run-state → chip tint + FR label for the recent-runs strip (mirrors the
// card's map; kept local so the two surfaces stay independent files).
const RUN_STATE_META: Record<
  string,
  { label: string; color: string; bg: string; border: string }
> = {
  queued: { label: 'En file', color: C.muted, bg: 'transparent', border: C.border },
  running: { label: 'En cours', color: C.accent, bg: C.accentSoft, border: C.accentBorder },
  waiting_approval: { label: 'En attente', color: C.warn, bg: C.warnBg, border: C.warnBorder },
  done: { label: 'Terminé', color: C.okText, bg: C.okBg, border: C.okBorder },
  failed: { label: 'Échoué', color: C.errText, bg: C.errBg, border: C.errBorder },
  stopped: { label: 'Arrêté', color: C.muted, bg: 'transparent', border: C.border },
};

function relativeTime(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return "à l'instant";
  const min = Math.floor(diff / 60000);
  if (min < 60) return `il y a ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `il y a ${hr} h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `il y a ${day} j`;
  return `il y a ${Math.floor(day / 7)} sem`;
}

const AGENT_LABEL: Record<AgentName, string> = {
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
};

// ---------------------------------------------------------------------------
// The page body (inside the ViewBody canvas). Owns the state machine on the
// useAgents() lifecycle.
// ---------------------------------------------------------------------------
const AgentsHome = () => {
  const workbench = useService(WorkbenchService).workbench;
  const { agents, caps, loading, error, disabled, reload } = useAgents();

  const go = useCallback(
    (path: string) => {
      workbench.open(path, { at: 'active' });
    },
    [workbench]
  );

  const openWizard = useCallback(() => go(WIZARD_ROUTE), [go]);

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
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '28px 4px',
          color: C.muted,
        }}
      >
        <Spinner /> Chargement de vos agents…
      </div>
    );
  }

  // ---- disabled / feature-off (should not happen: caps gate the nav) -----
  if (disabled) {
    return (
      <div
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
          Les agents ne sont pas activés
        </div>
        <p style={{ margin: 0, fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
          Cette fonctionnalité est désactivée sur ce serveur. Revenez plus tard
          — vos employés IA vous attendront ici.
        </p>
      </div>
    );
  }

  // ---- error -------------------------------------------------------------
  if (error && agents.length === 0) {
    return (
      <div
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
          Impossible de charger vos agents
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
          {error}
        </p>
        <div>
          <button type="button" onClick={() => reload()} style={primaryBtn}>
            Réessayer
          </button>
        </div>
      </div>
    );
  }

  // ---- ready -------------------------------------------------------------
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* Header + darja subtitle. */}
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
          <AiIcon style={{ fontSize: 22 }} /> Vos agents
        </h1>
        <p style={{ margin: 0, fontSize: 13.5, color: C.muted, lineHeight: 1.5 }}>
          Vos employés IA — ils travaillent pour vous, jour et nuit.
        </p>
        <div dir="rtl" style={{ fontSize: 12.5, color: C.muted }}>
          الموظفين تاعك بالذكاء الاصطناعي — يخدمو عليك ليل و نهار.
        </div>
      </header>

      {/* "Créer un agent" CTA — opens the goal-first wizard. */}
      <div
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
            Recrutez un nouvel employé IA
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
            Choisissez une mission — confirmer vos commandes, répondre sur
            WhatsApp, surveiller vos concurrents — donnez-lui un nom, ses outils,
            et lancez un test.
          </p>
          <div dir="rtl" style={{ marginTop: 6, fontSize: 12.5, color: C.muted }}>
            اختار الخدمة، سمّيه، و جرّبه فدقيقة.
          </div>
        </div>
        <button
          type="button"
          onClick={openWizard}
          style={{ ...primaryBtn, fontSize: 14.5, padding: '11px 20px' }}
        >
          + Créer un agent
        </button>
      </div>

      {/* Agent cards grid — auto-fill collapses to a single column on mobile. */}
      {agents.length > 0 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 16,
          }}
        >
          {agents.map(agent => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onOpen={() => go(STUDIO_ROUTE[agent.id] ?? `/agents/${agent.id}`)}
              onOpenRuns={() => go(runsRoute(agent.id))}
              onConfigure={() => go(STUDIO_ROUTE[agent.id] ?? `/agents/${agent.id}`)}
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
          Aucun agent pour l’instant. Créez votre premier employé IA ci-dessus.
        </div>
      )}

      {/* Compact recent-runs strip. */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={sectionTitleStyle}>Exécutions récentes</div>
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
              const rm =
                RUN_STATE_META[a.lastRun.state] ?? {
                  label: a.lastRun.state || 'Inconnu',
                  color: C.muted,
                  bg: 'transparent',
                  border: C.border,
                };
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => go(runsRoute(a.id))}
                  style={{
                    appearance: 'none',
                    textAlign: 'left',
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
                    {AGENT_LABEL[a.id] ?? a.label}
                  </span>
                  <Chip color={rm.color} bg={rm.bg} border={rm.border}>
                    {rm.label}
                  </Chip>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>
                    {relativeTime(a.lastRun.at)}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: C.accent,
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Voir →
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
            Aucune exécution récente. Ouvrez un agent et donnez-lui une mission.
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
  return (
    <>
      <ViewTitle title="Agents" />
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
          Agents
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
            béta
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
          <div
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

// Router lazy target: the route loader renders `Component` (same convention as
// every sibling workspace page — hermes/shoperp export `Component`). Also
// provide a default export for the WSU-3 "default-export the page" requirement.
export const Component = () => {
  return <AgentsPage />;
};

export default AgentsPage;
