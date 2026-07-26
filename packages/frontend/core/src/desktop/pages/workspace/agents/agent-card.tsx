// AgentCard — one roster tile on the unified /agents home (R7, WSU-3 / FOYER;
// R8 i18n + mobile).
//
// Presentational only: it receives ONE {@link AgentSummary} (the wire row from
// GET /api/v1/agents, surfaced by Annuaire's `useAgents()`) plus click handlers,
// and never fetches. It renders the agent's identity (icon glyph + name + beta
// chip), a live on/off status dot, its bound channels (Telegram / web), a
// compact last-run summary (state chip + relative time), and the primary
// "Ouvrir" action with secondary "Exécutions" / "Configurer".
//
// R8 (WSU-7 / RETOUCHE): all user-facing copy comes from the shared agents i18n
// catalogue via `useAgentLang()` (FR default + Algerian darja). The card lives
// under the home root's `dir`, so it flips RTL automatically in Arabic; the
// darja hint line keeps its own dir="rtl". Layout unchanged (fluid; the parent
// grid collapses to one column on mobile). All props / exports preserved.
//
// House rules: inline styles only (no .css.ts), reuse the shared AgentPalette +
// Chip primitives from the agent-console kit, boot-safe rc icons only
// (ChatWithAiIcon for Hermes = chat glyph, KeyboardIcon for OpenClaw).
// Every navigation goes through the handlers the parent wires to
// WorkbenchLink so clicks stay inside the workbench.

import { Chip } from '@affine/core/modules/agents/components';
import { AgentPalette } from '@affine/core/modules/agents/components';
import { type TFunc, useAgentLang } from '@affine/core/modules/agents/i18n';
import type { AgentSummary } from '@affine/core/modules/agents/types';
import { ChatWithAiIcon, KeyboardIcon } from '@blocksuite/icons/rc';
import type { CSSProperties, ReactNode } from 'react';

const C = AgentPalette.color;

// ---------------------------------------------------------------------------
// Per-agent presentation metadata. Icons are the SAME boot-safe rc glyphs the
// studio registry + the legacy pages use (Hermes → chat, OpenClaw → keyboard),
// so the home reads consistently with the sidebar and the /hermes /openclaw
// surfaces. `blurbKey` / `darjaKey` are i18n catalogue keys (FR + darja).
// ---------------------------------------------------------------------------
interface AgentMeta {
  icon: ReactNode;
  blurbKey: string;
  darjaKey: string | null;
}

// Keyed by string (not AgentName): `AgentSummary.id` is `AgentName | string`
// (R12 custom agents carry opaque `cz_` ids), so lookups use the same
// string-indexed + fallback idiom as RUN_STATE_TINT below.
const AGENT_META: Record<string, AgentMeta> = {
  hermes: {
    icon: <ChatWithAiIcon style={{ fontSize: 22 }} />,
    blurbKey: 'card.hermes.blurb',
    darjaKey: 'card.hermes.darja',
  },
  openclaw: {
    icon: <KeyboardIcon style={{ fontSize: 22 }} />,
    blurbKey: 'card.openclaw.blurb',
    darjaKey: 'card.openclaw.darja',
  },
};

// Fallback meta for any future/unknown agent id so the card never crashes on an
// evolving roster (defensive — the union is closed today).
const FALLBACK_META: AgentMeta = {
  icon: <ChatWithAiIcon style={{ fontSize: 22 }} />,
  blurbKey: 'card.fallback.blurb',
  darjaKey: null,
};

// ---------------------------------------------------------------------------
// Run-state → chip tint. Mirrors AgentRunState (queued | running |
// waiting_approval | done | failed | stopped); `at` is a ms epoch. Labels come
// from the i18n catalogue (`states.<state>`); an unknown state degrades to a
// neutral grey chip echoing the raw string.
// ---------------------------------------------------------------------------
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

// A run in one of these coarse states counts as "active" for the status dot.
const ACTIVE_STATES = new Set(['queued', 'running', 'waiting_approval']);

// Relative-time formatter using the shared `time.*` catalogue keys ({n} slot).
// Best-effort: a missing/absurd timestamp yields '' so the row omits the time.
function relativeTime(t: TFunc, ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return t('time.now');
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t('time.now');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('time.minAgo', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('time.hrAgo', { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return t('time.dayAgo', { n: day });
  const wk = Math.floor(day / 7);
  if (wk < 5) return t('time.weekAgo', { n: wk });
  const mo = Math.floor(day / 30);
  if (mo < 12) return t('time.monthAgo', { n: mo });
  return t('time.yearAgo', { n: Math.floor(day / 365) });
}

// ---------------------------------------------------------------------------
// Status dot — green when the agent has run recently or has a bound channel
// (i.e. it is "on"/reachable), muted grey otherwise. Purely derived from the
// summary; no polling.
// ---------------------------------------------------------------------------
function StatusDot({ on, t }: { on: boolean; t: TFunc }) {
  return (
    <span
      aria-hidden
      title={on ? t('card.status.active') : t('card.status.inactive')}
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
  const { t } = useAgentLang();
  const meta = AGENT_META[agent.id] ?? FALLBACK_META;
  const telegramOn = !!agent.channels?.telegram;
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
      {/* Identity row: icon + name + beta chip, status dot pinned to the end. */}
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
                {t('common.beta')}
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
            {t(meta.blurbKey)}
          </p>
          {meta.darjaKey ? (
            <div
              dir="rtl"
              style={{ marginTop: 2, fontSize: 12, color: C.muted, opacity: 0.9 }}
            >
              {t(meta.darjaKey)}
            </div>
          ) : null}
        </div>
        <StatusDot on={isOn} t={t} />
      </div>

      {/* Channels + last-run summary. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <ChannelBadge
            label={t('card.channel.web')}
            active
            title={t('card.channel.web.title')}
          />
          <ChannelBadge
            label={t('card.channel.telegram')}
            active={telegramOn}
            title={
              telegramOn
                ? t('card.channel.telegram.on')
                : t('card.channel.telegram.off')
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
      </div>

      {/* Actions: primary Ouvrir + secondary Exécutions / Configurer. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
        <button type="button" onClick={onOpen} style={primaryBtn}>
          {t('card.action.open')}
        </button>
        <button type="button" onClick={onOpenRuns} style={ghostBtn}>
          {t('card.action.runs')}
        </button>
        <button type="button" onClick={onConfigure} style={ghostBtn}>
          {t('card.action.configure')}
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
