import {
  AgentPalette,
  Chip,
  ensureAgentKeyframes,
  Spinner,
} from '@affine/core/modules/agents/components';
import { useAgentLang } from '@affine/core/modules/agents/i18n';
import { useAgents } from '@affine/core/modules/agents/use-agents';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchLink,
} from '@affine/core/modules/workbench';
import { CommentIcon, LinkIcon, SearchIcon } from '@blocksuite/icons/rc';
import { type CSSProperties, type ReactNode } from 'react';

import { TelegramChannelCard } from './channel-card';

// ---------------------------------------------------------------------------
// ClickDz Agents — CONNEXIONS (WSU-5; R8 WhatsApp cap + Planification + i18n +
// mobile; R10 BYOT per-agent Telegram). The channels tab of the unified /agents
// studio: how the user's agents reach the outside world.
//
//   1. Telegram   — R10 BYOT: TWO per-agent cards (hermes + openclaw), each a
//                   <TelegramChannelCard agent> (Réglage, owns channel-card.tsx).
//                   The user pastes THEIR OWN BotFather token; the backend
//                   validates it (getMe), seals it, and arms a per-user webhook so
//                   inbound messages to that bot route to that user's that agent.
//                   NO shared platform bot. Gated CDZ_AGENT_TELEGRAM_ENABLED (+
//                   CDZ_DATA_SECRET) on the backend → a 404 collapses each card to
//                   a quiet "bientôt" state (never an error). Per-agent is the
//                   whole point — a store can wire two independent bots.
//   2. WhatsApp   — R8: reads `caps.whatsappEnabled` (Fanal). When true the card
//                   shows a "configuré" state and a note that the agent WhatsApp
//                   tool is active (send on the store's own number via the ERP
//                   gateway); when false it keeps the existing "bientôt" stub.
//   3. Accès web  — informational. caps.webEnabled reflects the runtime web tool
//                   (CDZ_AGENT_WEB_ENABLED, ON in prod): "vos agents peuvent
//                   chercher sur le web".
//   4. Planification — R8: an entry link to the triggers page (/agents/triggers,
//                   gated CDZ_AGENT_TRIGGERS_ENABLED) for scheduled / webhook
//                   runs. In-workbench <WorkbenchLink>, mirrors the Composio card.
//   5. Intégrations (Composio) — an entry link to the existing /integrations
//                   studio for connecting external apps (Gmail, Sheets, …).
//
// R8 (WSU-7 / RETOUCHE): all user-facing copy comes from the shared agents i18n
// catalogue via `useAgentLang()` (FR default + Algerian darja); the page root
// gets `dir={dir}` (Arabic → RTL); the card grid already collapses to one column
// on phones (a tighter mobile padding is added). Behaviour + exports unchanged.
//
// Data seam: useAgents() (Annuaire, R7) → { caps, loading, error, disabled }.
// `caps` = { multi, dzdPer1k, telegramEnabled, webEnabled, whatsappEnabled }.
// When the whole endpoint 404s (disabled) or a flag is off, the relevant card
// degrades to a quiet informational state — every surface here is fail-soft,
// byte-identical to "the feature doesn't exist" when its gate is dark.
//
// House rules: inline styles only (no .css.ts), no new deps, the SHARED agent
// palette + primitives (Chip/Spinner), boot-safe rc icons. External
// links carry target=_blank rel="noopener noreferrer"; the Composio +
// Planification links are in-workbench <WorkbenchLink>s. Mobile: the card grid
// collapses to a single column (auto-fill minmax + a media query).
// ---------------------------------------------------------------------------

const P = AgentPalette.color;

// Page-scoped keyframes + the single-column mobile collapse. Injected once via a
// <style> tag (same idiom the hermes/openclaw pages use for GLOBAL_CSS). The grid
// auto-fills wide cards, and under 720px hard-collapses to one column so DZ users
// on phones read the channels stacked; a tighter canvas padding kicks in ≤560px.
const GLOBAL_CSS = `
.cdz-conn-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill, minmax(300px, 1fr));
  gap:16px;
}
@media (max-width: 720px){
  .cdz-conn-grid{grid-template-columns:1fr}
}
@media (max-width: 560px){
  .cdz-conn-canvas{padding:20px 14px 40px !important;}
}
`;

// A pill "button" style shared by the card actions (matches the hermes btnStyle).
const actionBtnStyle: CSSProperties = {
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  padding: '8px 14px',
  borderRadius: AgentPalette.radius.md,
  fontSize: AgentPalette.font.size.lg,
  fontWeight: 600,
  fontFamily: 'inherit',
  lineHeight: 1.2,
  cursor: 'pointer',
  color: P.onAccent,
  background: P.accent,
  border: `1px solid ${P.accentBorder}`,
  transition: `filter ${AgentPalette.motion.fast} ${AgentPalette.motion.ease}`,
  textDecoration: 'none',
};

const ghostBtnStyle: CSSProperties = {
  ...actionBtnStyle,
  color: P.text,
  background: 'transparent',
  border: `1px solid ${P.border}`,
};

// ---------------------------------------------------------------------------
// ChannelCard — the shared shell for every channel row: an icon tile, a title +
// subtitle, a status chip, and a `children` slot for the action(s). Pure —
// receives already-translated strings.
// ---------------------------------------------------------------------------
function ChannelCard({
  icon,
  title,
  subtitle,
  status,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  status: { label: string; tone: 'ok' | 'warn' | 'muted' };
  children?: ReactNode;
}) {
  const toneStyle =
    status.tone === 'ok'
      ? { color: P.okText, bg: P.okBg, border: P.okBorder }
      : status.tone === 'warn'
        ? { color: P.warn, bg: P.warnBg, border: P.warnBorder }
        : { color: P.muted, bg: 'transparent', border: P.border };

  return (
    <section
      className="cdz-agent-fade"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        borderRadius: AgentPalette.radius.lg,
        background: P.panelRaised,
        border: `1px solid ${P.border}`,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div
          aria-hidden="true"
          style={{
            flex: '0 0 auto',
            width: 40,
            height: 40,
            borderRadius: AgentPalette.radius.md,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            background: P.accentSoft,
            border: `1px solid ${P.accentBorder}`,
            color: P.accent,
          }}
        >
          {icon}
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
            <h3
              style={{
                margin: 0,
                fontSize: AgentPalette.font.size.xl,
                fontWeight: 700,
                color: P.text,
                letterSpacing: '-0.01em',
              }}
            >
              {title}
            </h3>
            <Chip color={toneStyle.color} bg={toneStyle.bg} border={toneStyle.border}>
              {status.label}
            </Chip>
          </div>
          <p
            style={{
              margin: '4px 0 0',
              fontSize: AgentPalette.font.size.lg,
              color: P.muted,
              lineHeight: 1.5,
            }}
          >
            {subtitle}
          </p>
        </div>
      </div>
      {children ? <div style={{ minWidth: 0 }}>{children}</div> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The page. Header (workbench chrome) + a centered, scrolling canvas of channel
// cards. Top-level loading/error/quiet states come from useAgents(); the cards
// themselves each own their finer states.
// ---------------------------------------------------------------------------
function ConnectionsPage() {
  ensureAgentKeyframes();
  const { t, dir } = useAgentLang();
  const { caps, loading, error, disabled, reload } = useAgents();

  // R8: the master WhatsApp-tool gate, surfaced on caps by Fanal. When true the
  // agent WhatsApp send tool is active (gateway wired); when false/absent the
  // card keeps the "bientôt" stub. Read defensively so the page is byte-safe
  // even before the caps field lands.
  const whatsappOn = !!caps.whatsappEnabled;

  return (
    <>
      <ViewTitle title={t('connections.tabTitle')} />
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
          <LinkIcon style={{ fontSize: 16 }} />
          {t('connections.tabTitle')}
        </div>
      </ViewHeader>
      <ViewBody>
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
          <style>{GLOBAL_CSS}</style>
          <div
            dir={dir}
            className="cdz-conn-canvas"
            style={{
              maxWidth: 900,
              margin: '0 auto',
              padding: '28px 20px 48px',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            {/* Intro */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: 24,
                  fontWeight: 700,
                  color: P.text,
                  letterSpacing: '-0.02em',
                }}
              >
                {t('connections.title')}
              </h1>
              <p
                style={{
                  margin: 0,
                  fontSize: AgentPalette.font.size.lg,
                  color: P.muted,
                  lineHeight: 1.55,
                  maxWidth: 620,
                }}
              >
                {t('connections.subtitle')}
              </p>
            </div>

            {/* Top-level lifecycle from the roster fetch. A 404 (disabled) is NOT
                an error — the individual cards already degrade quietly, so we only
                surface a real error banner (auth/network/5xx) with a retry. */}
            {error && !disabled ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                  fontSize: AgentPalette.font.size.lg,
                  color: P.errText,
                  background: P.errBg,
                  border: `1px solid ${P.errBorder}`,
                  borderRadius: AgentPalette.radius.md,
                  padding: '12px 14px',
                }}
              >
                <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
                  {t('connections.error.load', { error })}
                </span>
                <button
                  type="button"
                  onClick={reload}
                  style={{ ...ghostBtnStyle, padding: '6px 12px' }}
                >
                  {t('common.retry')}
                </button>
              </div>
            ) : null}

            {loading ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: P.muted,
                  fontSize: AgentPalette.font.size.lg,
                  padding: '8px 2px',
                }}
              >
                <Spinner size={16} /> {t('connections.loading')}
              </div>
            ) : null}

            {/* The channel grid. Renders regardless of the roster result — each
                card reads caps defensively and shows its own quiet fallback when
                its gate is dark, so the grid is always useful. */}
            <div className="cdz-conn-grid">
              {/* Telegram — R10 BYOT: one card PER agent. Each connects the
                  user's OWN BotFather bot to that specific agent (hermes /
                  openclaw); the card owns its connect → verify → connected →
                  test / disconnect lifecycle and falls soft to "bientôt" when
                  the channel feature is dark. Per-agent is the point. */}
              <TelegramChannelCard agent="hermes" />
              <TelegramChannelCard agent="openclaw" />

              {/* WhatsApp — R8: reads caps.whatsappEnabled. Configured ⇒ the
                  agent WA send tool is active (store's own number via the ERP
                  gateway); otherwise the existing "bientôt" stub. */}
              <ChannelCard
                icon={<CommentIcon />}
                title={t('connections.whatsapp.title')}
                subtitle={t('connections.whatsapp.subtitle')}
                status={
                  whatsappOn
                    ? { label: t('connections.status.ok'), tone: 'ok' }
                    : { label: t('connections.status.soon'), tone: 'muted' }
                }
              >
                <div
                  style={{
                    fontSize: AgentPalette.font.size.md,
                    color: P.muted,
                    padding: '10px 12px',
                    borderRadius: AgentPalette.radius.sm,
                    background: P.panel,
                    border: whatsappOn
                      ? `1px solid ${P.border}`
                      : `1px dashed ${P.border}`,
                    lineHeight: 1.5,
                  }}
                >
                  {whatsappOn
                    ? t('connections.whatsapp.configured')
                    : t('connections.whatsapp.soon')}
                </div>
              </ChannelCard>

              {/* Accès web — informational, reflects caps.webEnabled (the runtime
                  web tool). Enabled in prod; a green/quiet chip either way. */}
              <ChannelCard
                icon={<SearchIcon />}
                title={t('connections.web.title')}
                subtitle={t('connections.web.subtitle')}
                status={
                  caps.webEnabled
                    ? { label: t('connections.status.ok'), tone: 'ok' }
                    : { label: t('connections.status.off'), tone: 'muted' }
                }
              >
                <div
                  style={{
                    fontSize: AgentPalette.font.size.md,
                    color: P.muted,
                    padding: '10px 12px',
                    borderRadius: AgentPalette.radius.sm,
                    background: P.panel,
                    border: `1px solid ${P.border}`,
                    lineHeight: 1.5,
                  }}
                >
                  {caps.webEnabled
                    ? t('connections.web.on')
                    : t('connections.web.off')}
                </div>
              </ChannelCard>

              {/* Planification — R8: entry link to the triggers page for
                  scheduled / webhook runs. In-workbench nav (WorkbenchLink),
                  mirrors the Composio card below. */}
              <ChannelCard
                icon={<span aria-hidden>⏰</span>}
                title={t('connections.schedule.title')}
                subtitle={t('connections.schedule.subtitle')}
                status={{ label: t('connections.status.studio'), tone: 'muted' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <p
                    style={{
                      margin: 0,
                      fontSize: AgentPalette.font.size.md,
                      color: P.muted,
                      lineHeight: 1.5,
                    }}
                  >
                    {t('connections.schedule.body')}
                  </p>
                  <WorkbenchLink
                    to="/agents/triggers"
                    draggable={false}
                    style={{ ...ghostBtnStyle, alignSelf: 'flex-start' }}
                  >
                    <span aria-hidden style={{ fontSize: 16 }}>
                      ⏰
                    </span>{' '}
                    {t('connections.schedule.open')}
                  </WorkbenchLink>
                </div>
              </ChannelCard>

              {/* Composio / intégrations — an entry link to the existing studio.
                  In-workbench nav, so a <WorkbenchLink> (not target=_blank). */}
              <ChannelCard
                icon={<LinkIcon />}
                title={t('connections.integrations.title')}
                subtitle={t('connections.integrations.subtitle')}
                status={{ label: t('connections.status.studio'), tone: 'muted' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <p
                    style={{
                      margin: 0,
                      fontSize: AgentPalette.font.size.md,
                      color: P.muted,
                      lineHeight: 1.5,
                    }}
                  >
                    {t('connections.integrations.body')}
                  </p>
                  <WorkbenchLink
                    to="/integrations"
                    draggable={false}
                    style={{ ...ghostBtnStyle, alignSelf: 'flex-start' }}
                  >
                    <LinkIcon style={{ fontSize: 16 }} /> {t('connections.integrations.open')}
                  </WorkbenchLink>
                </div>
              </ChannelCard>
            </div>
          </div>
        </div>
      </ViewBody>
    </>
  );
}

// Default export — the router lazy target for /agents/connections (per WSU-5).
export default ConnectionsPage;

// React-Router's `lazy()` resolves a `Component` named export; every sibling
// workspace page (hermes/openclaw/integrations) exports it that way, so we alias
// the default here too. This keeps the file usable whether the /agents/connections
// route is wired via the default import (Foyer) or a `Component` lazy route (Nav),
// with zero behavioural difference.
export const Component = ConnectionsPage;
