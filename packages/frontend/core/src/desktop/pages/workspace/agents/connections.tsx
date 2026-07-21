import {
  AgentPalette,
  Chip,
  ensureAgentKeyframes,
  IconButton,
  Spinner,
} from '@affine/core/modules/agents/components';
import { AgentApiError, pairTelegram } from '@affine/core/modules/agents/api';
import { useAgents } from '@affine/core/modules/agents/use-agents';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchLink,
} from '@affine/core/modules/workbench';
import {
  CommentIcon,
  LinkIcon,
  SearchIcon,
  TelegramIcon,
} from '@blocksuite/icons/rc';
import { type CSSProperties, type ReactNode, useCallback, useState } from 'react';

// ---------------------------------------------------------------------------
// ClickDz Agents — CONNEXIONS (WSU-5). The channels tab of the unified /agents
// studio: how the user's agents reach the outside world.
//
//   1. Telegram   — pair a Telegram chat to the account. GET /api/v1/agents/
//                   telegram/pair mints a one-shot deep link (t.me/<bot>?start=
//                   <code>); the user opens it, taps Démarrer, and the backend
//                   webhook binds the chat. Gated CDZ_AGENT_TELEGRAM_ENABLED on
//                   the backend → a 404 here means "no bot configured yet", shown
//                   as a quiet "bientôt disponible" state (never an error).
//   2. WhatsApp   — a "bientôt" stub. Wired in R8 via the ERP WhatsApp gateway
//                   (the store's own WA number). Reads caps only, no action yet.
//   3. Accès web  — informational. caps.webEnabled reflects the runtime web tool
//                   (CDZ_AGENT_WEB_ENABLED, ON in prod): "vos agents peuvent
//                   chercher sur le web".
//   4. Intégrations (Composio) — an entry link to the existing /integrations
//                   studio for connecting external apps (Gmail, Sheets, …).
//
// Data seam: useAgents() (Annuaire, R7) → { caps, loading, error, disabled }.
// `caps` = { multi, dzdPer1k, telegramEnabled, webEnabled }. When the whole
// endpoint 404s (disabled) or a flag is off, the relevant card degrades to a
// quiet informational state — every surface here is fail-soft, byte-identical
// to "the feature doesn't exist" when its gate is dark.
//
// House rules: inline styles only (no .css.ts), no new deps, the SHARED agent
// palette + primitives (Chip/Spinner/IconButton), boot-safe rc icons, FR primary
// with darja hints. External links carry target=_blank rel="noopener noreferrer";
// the Composio link is an in-workbench <WorkbenchLink>. Mobile: the card grid
// collapses to a single column (auto-fill minmax + a media query).
// ---------------------------------------------------------------------------

const P = AgentPalette.color;

// Page-scoped keyframes + the single-column mobile collapse. Injected once via a
// <style> tag (same idiom the hermes/openclaw pages use for GLOBAL_CSS). The grid
// auto-fills wide cards, and under 720px hard-collapses to one column so DZ users
// on phones read the channels stacked.
const GLOBAL_CSS = `
.cdz-conn-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill, minmax(300px, 1fr));
  gap:16px;
}
@media (max-width: 720px){
  .cdz-conn-grid{grid-template-columns:1fr}
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
// subtitle, a status chip, and a `children` slot for the action(s). Pure.
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
// TelegramCard — the only interactive channel. Pairing is a two-step UX:
//   · idle  → a "Lier mon Telegram" button that calls GET /pair.
//   · linked (has deepLink) → the tappable t.me link + a copy button + a short
//     darja instruction ("Ouvre le lien, appuie sur Démarrer").
// Fail-soft on 404 (bot dark) → a quiet "bientôt disponible" state, NOT an error.
// The pair code is short-lived (10 min server-side); we surface the link, not the
// raw code, since the code lives inside the deep link.
// ---------------------------------------------------------------------------
function TelegramCard({ telegramEnabled }: { telegramEnabled: boolean }) {
  const [loading, setLoading] = useState(false);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const onPair = useCallback(() => {
    setLoading(true);
    setError(null);
    setCopied(false);
    void (async () => {
      try {
        const res = await pairTelegram();
        // A configured bot returns a non-empty deepLink; an empty one means the
        // route is enabled but no bot username resolved yet (token half-set) —
        // treat that as the dark state too so we never show a dead link.
        if (res && res.deepLink) {
          setDeepLink(res.deepLink);
          setDark(false);
        } else {
          setDark(true);
        }
      } catch (err) {
        // 404 = CDZ_AGENT_TELEGRAM_ENABLED off (no bot configured): quiet state,
        // not a failure. Anything else (401/network/5xx) is a real error.
        if (err instanceof AgentApiError && err.status === 404) {
          setDark(true);
        } else {
          setError(
            err instanceof Error ? err.message : 'Liaison Telegram indisponible.'
          );
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const onCopy = useCallback(() => {
    if (!deepLink || typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }
    navigator.clipboard
      .writeText(deepLink)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        // Clipboard denied — the link stays tappable, that's enough.
      });
  }, [deepLink]);

  // Status chip: connecté once we hold a link, en attente while linking, sinon
  // non-configuré (dark) or non-lié (ready to pair).
  const status: { label: string; tone: 'ok' | 'warn' | 'muted' } = deepLink
    ? { label: 'en attente', tone: 'warn' }
    : dark || !telegramEnabled
      ? { label: 'non-configuré', tone: 'muted' }
      : loading
        ? { label: 'en attente', tone: 'warn' }
        : { label: 'non-lié', tone: 'muted' };

  // If we already know the channel is dark (caps say so) AND the user hasn't
  // forced a probe, show the quiet state up-front. A probe can still confirm it.
  const showDark = dark || (!telegramEnabled && !deepLink && !loading && !error);

  return (
    <ChannelCard
      icon={<TelegramIcon />}
      title="Telegram"
      subtitle="Discutez avec vos agents depuis Telegram — donnez vos tâches men l'application."
      status={status}
    >
      {showDark ? (
        <div
          style={{
            fontSize: AgentPalette.font.size.md,
            color: P.muted,
            padding: '10px 12px',
            borderRadius: AgentPalette.radius.sm,
            background: P.panel,
            border: `1px dashed ${P.border}`,
            lineHeight: 1.5,
          }}
        >
          Telegram bientôt disponible — un bot doit être configuré.{' '}
          <span style={{ opacity: 0.85 }}>Reviens bientôt.</span>
        </div>
      ) : deepLink ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 10px',
              borderRadius: AgentPalette.radius.sm,
              background: P.consoleBg,
              border: `1px solid ${P.consoleBorder}`,
              minWidth: 0,
            }}
          >
            <a
              href={deepLink}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: AgentPalette.font.mono,
                fontSize: AgentPalette.font.size.md,
                color: P.accent,
                textDecoration: 'none',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {deepLink}
            </a>
            <IconButton label={copied ? 'Copié' : 'Copier le lien'} onClick={onCopy}>
              {copied ? '✓' : '⧉'}
            </IconButton>
          </div>
          <a
            href={deepLink}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...actionBtnStyle, alignSelf: 'flex-start' }}
          >
            <TelegramIcon style={{ fontSize: 16 }} /> Ouvrir Telegram
          </a>
          <p
            style={{
              margin: 0,
              fontSize: AgentPalette.font.size.md,
              color: P.muted,
              lineHeight: 1.5,
            }}
          >
            Ouvre le lien, appuie sur <strong style={{ color: P.text }}>Démarrer</strong>{' '}
            (Start) — w rak lié. Le lien expire après 10 minutes.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            onClick={onPair}
            disabled={loading}
            className="cdz-agent-motion"
            style={{
              ...actionBtnStyle,
              alignSelf: 'flex-start',
              opacity: loading ? 0.7 : 1,
              cursor: loading ? 'default' : 'pointer',
            }}
          >
            {loading ? <Spinner size={14} color={P.onAccent} /> : <LinkIcon style={{ fontSize: 16 }} />}
            {loading ? 'Génération du lien…' : 'Lier mon Telegram'}
          </button>
          {error ? (
            <div
              style={{
                fontSize: AgentPalette.font.size.md,
                color: P.errText,
                background: P.errBg,
                border: `1px solid ${P.errBorder}`,
                borderRadius: AgentPalette.radius.sm,
                padding: '8px 10px',
                lineHeight: 1.5,
              }}
            >
              {error} — 3awd mera (réessayez).
            </div>
          ) : null}
        </div>
      )}
    </ChannelCard>
  );
}

// ---------------------------------------------------------------------------
// The page. Header (workbench chrome) + a centered, scrolling canvas of channel
// cards. Top-level loading/error/quiet states come from useAgents(); the cards
// themselves each own their finer states.
// ---------------------------------------------------------------------------
function ConnectionsPage() {
  ensureAgentKeyframes();
  const { caps, loading, error, disabled, reload } = useAgents();

  return (
    <>
      <ViewTitle title="Connexions" />
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
          Connexions
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
                Connexions
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
                Branchez vos agents aux canaux de vos clients. Telegram, WhatsApp,
                accès web et intégrations — koulech f blasa wehda.
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
                <span style={{ flex: 1, minWidth: 0 }}>
                  Impossible de charger vos connexions : {error}
                </span>
                <button
                  type="button"
                  onClick={reload}
                  style={{ ...ghostBtnStyle, padding: '6px 12px' }}
                >
                  Réessayer
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
                <Spinner size={16} /> Chargement des connexions…
              </div>
            ) : null}

            {/* The channel grid. Renders regardless of the roster result — each
                card reads caps defensively and shows its own quiet fallback when
                its gate is dark, so the grid is always useful. */}
            <div className="cdz-conn-grid">
              <TelegramCard telegramEnabled={!!caps.telegramEnabled} />

              {/* WhatsApp — R8 stub. Reads caps only (no WA flag yet); explains
                  it will connect the store's own WA number via the ERP gateway. */}
              <ChannelCard
                icon={<CommentIcon />}
                title="WhatsApp"
                subtitle="Vos agents répondront aux clients sur WhatsApp — 3la numéro du magasin."
                status={{ label: 'bientôt', tone: 'muted' }}
              >
                <div
                  style={{
                    fontSize: AgentPalette.font.size.md,
                    color: P.muted,
                    padding: '10px 12px',
                    borderRadius: AgentPalette.radius.sm,
                    background: P.panel,
                    border: `1px dashed ${P.border}`,
                    lineHeight: 1.5,
                  }}
                >
                  Bientôt : connectez le numéro WhatsApp de votre boutique via la
                  passerelle ERP. Vos agents confirmeront les commandes COD et
                  répondront aux clients directement sur WhatsApp.
                </div>
              </ChannelCard>

              {/* Accès web — informational, reflects caps.webEnabled (the runtime
                  web tool). Enabled in prod; a green/quiet chip either way. */}
              <ChannelCard
                icon={<SearchIcon />}
                title="Accès web"
                subtitle="La recherche web pour vos agents — bech ylo9aw l'info f'internet."
                status={
                  caps.webEnabled
                    ? { label: 'activé', tone: 'ok' }
                    : { label: 'désactivé', tone: 'muted' }
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
                    ? 'Vos agents peuvent chercher sur le web pour répondre avec des infos à jour (prix concurrents, actualités, recherche produit).'
                    : "L'accès web est actuellement désactivé pour vos agents. Contactez l'admin pour l'activer."}
                </div>
              </ChannelCard>

              {/* Composio / intégrations — an entry link to the existing studio.
                  In-workbench nav, so a <WorkbenchLink> (not target=_blank). */}
              <ChannelCard
                icon={<LinkIcon />}
                title="Intégrations"
                subtitle="Connectez Gmail, Sheets, et +100 apps via Composio — zid les outils l'agents."
                status={{ label: 'studio', tone: 'muted' }}
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
                    Ouvrez le studio d'intégrations pour connecter vos applications
                    externes et donner de nouveaux outils à vos agents.
                  </p>
                  <WorkbenchLink
                    to="/integrations"
                    draggable={false}
                    style={{ ...ghostBtnStyle, alignSelf: 'flex-start' }}
                  >
                    <LinkIcon style={{ fontSize: 16 }} /> Ouvrir les intégrations
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
