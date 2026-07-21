// AgentCard — one roster tile on the unified /agents home (R7, WSU-3 / FOYER).
//
// Presentational only: it receives ONE {@link AgentSummary} (the wire row from
// GET /api/v1/agents, surfaced by Annuaire's `useAgents()`) plus click handlers,
// and never fetches. It renders the agent's identity (icon glyph + name + beta
// chip), a live on/off status dot, its bound channels (Telegram / web), a
// compact last-run summary (state chip + relative time), and the primary
// "Ouvrir" action with secondary "Exécutions" / "Configurer".
//
// House rules: inline styles only (no .css.ts), reuse the shared AgentPalette +
// Chip primitives from the agent-console kit, boot-safe rc icons only
// (ChatWithAiIcon for Hermes = chat glyph, KeyboardIcon for OpenClaw), and the
// FR-primary copy the hermes/shoperp pages use today (darja hint where natural).
// Mobile degrades to a single column via the parent grid; the card itself is
// fluid. Every navigation goes through the handlers the parent wires to
// WorkbenchLink so clicks stay inside the workbench.

import { Chip } from '@affine/core/modules/agents/components';
import { AgentPalette } from '@affine/core/modules/agents/components';
import type { AgentName, AgentSummary } from '@affine/core/modules/agents/types';
import { ChatWithAiIcon, KeyboardIcon } from '@blocksuite/icons/rc';
import type { CSSProperties, ReactNode } from 'react';

const C = AgentPalette.color;

// ---------------------------------------------------------------------------
// Per-agent presentation metadata. Icons are the SAME boot-safe rc glyphs the
// studio registry + the legacy pages use (Hermes → chat, OpenClaw → keyboard),
// so the home reads consistently with the sidebar and the /hermes /openclaw
// surfaces. `blurb` is a one-line FR job description; `route` is the legacy
// per-agent studio the "Ouvrir" action targets by default.
// ---------------------------------------------------------------------------
interface AgentMeta {
  icon: ReactNode;
  blurb: string;
  darja: string;
}

const AGENT_META: Record<AgentName, AgentMeta> = {
  hermes: {
    icon: <ChatWithAiIcon style={{ fontSize: 22 }} />,
    blurb: 'Agent des opérations — commandes, clients, messages.',
    darja: 'يدبّرلك الخدمة اليومية.',
  },
  openclaw: {
    icon: <KeyboardIcon style={{ fontSize: 22 }} />,
    blurb: 'Agent développeur — code, outils et automatisations.',
    darja: 'يكوديلك الأدوات و يأتمت.',
  },
};

// Fallback meta for any future/unknown agent id so the card never crashes on an
// evolving roster (defensive — the union is closed today).
const FALLBACK_META: AgentMeta = {
  icon: <ChatWithAiIcon style={{ fontSize: 22 }} />,
  blurb: 'Agent IA.',
  darja: '',
};

// ---------------------------------------------------------------------------
// Run-state → chip tint + FR label. Mirrors AgentRunState (queued | running |
// waiting_approval | done | failed | stopped); `at` is a ms epoch. Unknown
// states degrade to a neutral grey chip echoing the raw string.
// ---------------------------------------------------------------------------
const RUN_STATE_META: Record<
  string,
  { label: string; color: string; bg: string; border: string }
> = {
  queued: { label: 'En file', color: C.muted, bg: 'transparent', border: C.border },
  running: { label: 'En cours', color: C.accent, bg: C.accentSoft, border: C.accentBorder },
  waiting_approval: {
    label: 'En attente',
    color: C.warn,
    bg: C.warnBg,
    border: C.warnBorder,
  },
  done: { label: 'Terminé', color: C.okText, bg: C.okBg, border: C.okBorder },
  failed: { label: 'Échoué', color: C.errText, bg: C.errBg, border: C.errBorder },
  stopped: { label: 'Arrêté', color: C.muted, bg: 'transparent', border: C.border },
};

// A run in one of these coarse states counts as "active" for the status dot.
const ACTIVE_STATES = new Set(['queued', 'running', 'waiting_approval']);

// Relative-time formatter (FR, compact). Best-effort: a missing/absurd
// timestamp yields '' so the row simply omits the time.
function relativeTime(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return "à l'instant";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "à l'instant";
  const min = Math.floor(sec / 60);
  if (min < 60) return `il y a ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `il y a ${hr} h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `il y a ${day} j`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `il y a ${wk} sem`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `il y a ${mo} mois`;
  return `il y a ${Math.floor(day / 365)} an(s)`;
}

// ---------------------------------------------------------------------------
// Status dot — green when the agent has run recently or has a bound channel
// (i.e. it is "on"/reachable), muted grey otherwise. Purely derived from the
// summary; no polling.
// ---------------------------------------------------------------------------
function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      title={on ? 'Actif' : 'Inactif'}
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        flex: '0 0 auto',
        background: on ? C.ok : C.muted,
        boxShadow: on ? `0 0 0 3px ${C.okBg}` : 'none',
      }}
    />
  );
}

// A small outlined channel badge (Telegram bound / web available).
function ChannelBadge({
  label,
  active,
  title,
}: {
  label: string;
  active: boolean;
  title: string;
}) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: AgentPalette.radius.pill,
        whiteSpace: 'nowrap',
        color: active ? C.text : C.muted,
        background: active ? C.accentSoft : 'transparent',
        border: `1px solid ${active ? C.accentBorder : C.border}`,
        opacity: active ? 1 : 0.7,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: active ? C.accent : C.muted,
        }}
      />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AgentCard
// ---------------------------------------------------------------------------
export interface AgentCardProps {
  agent: AgentSummary;
  /** Open the agent (primary action → its studio / run surface). */
  onOpen: () => void;
  /** Open the agent's run history. */
  onOpenRuns: () => void;
  /** Open the agent's configuration. */
  onConfigure: () => void;
}

export function AgentCard({
  agent,
  onOpen,
  onOpenRuns,
  onConfigure,
}: AgentCardProps) {
  const meta = AGENT_META[agent.id] ?? FALLBACK_META;
  const telegramOn = !!agent.channels?.telegram;
  const lastRun = agent.lastRun;
  const runMeta = lastRun
    ? RUN_STATE_META[lastRun.state] ?? {
        label: lastRun.state || 'Inconnu',
        color: C.muted,
        bg: 'transparent',
        border: C.border,
      }
    : null;

  // "On" if it has a recent run OR a bound channel (Telegram) — the presence of
  // either signals the agent is set up and reachable. Web is always available
  // once the feature is on, so a live run is the meaningful web-activity signal.
  const isOn = !!lastRun || telegramOn;
  const activeRun = !!lastRun && ACTIVE_STATES.has(lastRun.state);

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
      {/* Identity row: icon + name + beta chip, status dot pinned right. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div
          aria-hidden
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 42,
            height: 42,
            flex: '0 0 auto',
            borderRadius: AgentPalette.radius.md,
            color: C.accent,
            background: C.accentSoft,
            border: `1px solid ${C.accentBorder}`,
          }}
        >
          {meta.icon}
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
              }}
            >
              {agent.label}
            </span>
            {agent.beta ? (
              <Chip
                color={C.muted}
                bg="color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)"
                border="transparent"
              >
                béta
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
            {meta.blurb}
          </p>
          {meta.darja ? (
            <div
              dir="rtl"
              style={{ marginTop: 2, fontSize: 12, color: C.muted, opacity: 0.9 }}
            >
              {meta.darja}
            </div>
          ) : null}
        </div>
        <StatusDot on={isOn} />
      </div>

      {/* Channels + last-run summary. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <ChannelBadge
            label="Web"
            active
            title="Accessible depuis le web"
          />
          <ChannelBadge
            label="Telegram"
            active={telegramOn}
            title={
              telegramOn
                ? 'Telegram connecté'
                : 'Telegram non connecté — à lier dans les connexions'
            }
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: C.muted,
            minHeight: 20,
          }}
        >
          <span style={{ fontWeight: 600 }}>Dernière exécution</span>
          {runMeta ? (
            <>
              <Chip color={runMeta.color} bg={runMeta.bg} border={runMeta.border}>
                {activeRun ? (
                  <span
                    className="cdz-agent-motion"
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: runMeta.color,
                      animation: 'cdz-agent-pulse 1.4s ease-in-out infinite',
                    }}
                  />
                ) : null}
                {runMeta.label}
              </Chip>
              {relativeTime(lastRun?.at) ? (
                <span style={{ color: C.muted }}>{relativeTime(lastRun?.at)}</span>
              ) : null}
            </>
          ) : (
            <span style={{ color: C.muted, fontStyle: 'italic' }}>
              Aucune pour l’instant
            </span>
          )}
        </div>
      </div>

      {/* Actions: primary Ouvrir + secondary Exécutions / Configurer. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
        <button type="button" onClick={onOpen} style={primaryBtn}>
          Ouvrir
        </button>
        <button type="button" onClick={onOpenRuns} style={ghostBtn}>
          Exécutions
        </button>
        <button type="button" onClick={onConfigure} style={ghostBtn}>
          Configurer
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Button styles (page-scoped; mirrors the hermes/shoperp inline button idiom).
// ---------------------------------------------------------------------------
const baseBtn: CSSProperties = {
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
};

const primaryBtn: CSSProperties = {
  ...baseBtn,
  color: C.onAccent,
  background: C.accent,
  border: `1px solid ${C.accent}`,
};

const ghostBtn: CSSProperties = {
  ...baseBtn,
  color: C.text,
  background: 'transparent',
  border: `1px solid ${C.border}`,
};
