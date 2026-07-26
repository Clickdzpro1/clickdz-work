import {
  AgentPalette,
  Chip,
  ensureAgentKeyframes,
  Spinner,
} from '@affine/core/modules/agents/components';
import { AgentApiError } from '@affine/core/modules/agents/api';
import { useAgentLang } from '@affine/core/modules/agents/i18n';
import type { AgentName } from '@affine/core/modules/agents/types';
import { TelegramIcon } from '@blocksuite/icons/rc';
import {
  type CSSProperties,
  useCallback,
  useState,
} from 'react';

import { useTelegramChannel } from '../../../../modules/agents/use-channels';

// ---------------------------------------------------------------------------
// ClickDz Agents — <TelegramChannelCard agent /> (R10 / BYOT). The per-agent
// "Bring Your Own Token" Telegram connect experience: instead of one global
// platform bot, EACH user connects THEIR OWN Telegram bot (created via
// @BotFather) to a SPECIFIC agent (hermes | openclaw). The token is validated
// server-side (getMe), sealed at rest, and the webhook is armed — inbound
// messages to that bot route to that user's that agent.
//
// This is a SHARED component: it renders standalone on /agents/connections (two
// instances, one per agent) AND is snippet-embedded into the hermes/openclaw
// studios (via Poste). It owns nothing but its own local UI state; all the
// network + persistence lives behind Passe's `useTelegramChannel(agent)` hook.
//
// STATES (single card, four faces):
//   · dark          — the hook reports the channel feature is off (GET 404 or
//                     an unset backend secret). A quiet "bientôt" note, never an
//                     error. This is the flags-off / pre-deploy face.
//   · not-connected — a heading, a password-style input for the BotFather token,
//                     a 3-step FR/darja how-to, and a "Connecter" button.
//   · connecting    — a spinner + "Vérification du bot…" while getMe runs.
//   · connected     — a green ✓, the resolved @botUsername, the connectedAt time,
//                     a "Tester" button (calls test() and surfaces the result),
//                     and a "Déconnecter" button.
//
// House rules: inline styles only (no .css.ts), no new deps, the SHARED agent
// palette + primitives (Chip / Spinner), a boot-safe rc icon (TelegramIcon).
// All copy comes from the shared agents i18n catalogue via useAgentLang() (FR
// default + Algerian darja) under the new `channels.byot.*` key group. The token
// is NEVER echoed back, logged, or persisted client-side — it is handed straight
// to the hook and the local input is cleared on success.
//
// CONSUMED CONTRACT — Passe's `modules/agents/use-channels.ts`:
//   useTelegramChannel(agent: AgentName) => {
//     status: {
//       connected: boolean;
//       botUsername?: string | null;
//       connectedAt?: number;      // ms epoch
//       dark?: boolean;            // true when the feature is off (404 / no secret)
//     };
//     connect(token: string): Promise<{
//       ok: boolean; botUsername?: string | null; error?: string;
//     }>;                          // may also THROW AgentApiError (400 invalid_token)
//     disconnect(): Promise<void>;
//     test(): Promise<{ ok: boolean; sent: boolean }>;
//     loading: boolean;            // true while the initial status probe is in flight
//   }
// Everything is read defensively (optional chaining + typeof guards) so a
// reasonable shape drift in the hook degrades to a quiet state, never a crash.
// ---------------------------------------------------------------------------

const P = AgentPalette.color;

// A pill "button" style shared by the card actions (matches connections.tsx
// actionBtnStyle so the BYOT card reads identically to the channel grid).
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

// The password-style token input. `dir="ltr"` so the (latin) BotFather token
// never mirrors under RTL; type=password so the secret is masked on screen.
const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  appearance: 'none',
  padding: '9px 11px',
  borderRadius: AgentPalette.radius.sm,
  border: `1px solid ${P.border}`,
  background: P.consoleBg,
  color: P.consoleText,
  fontFamily: AgentPalette.font.mono,
  fontSize: AgentPalette.font.size.md,
  lineHeight: 1.4,
  outline: 'none',
};

// A small notice block (dark / test-result), reused across faces.
function Notice({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'ok' | 'err';
}) {
  const c =
    tone === 'ok'
      ? { color: P.okText, bg: P.okBg, border: P.okBorder }
      : tone === 'err'
        ? { color: P.errText, bg: P.errBg, border: P.errBorder }
        : { color: P.muted, bg: P.panel, border: P.border };
  return (
    <div
      style={{
        fontSize: AgentPalette.font.size.md,
        color: c.color,
        padding: '9px 11px',
        borderRadius: AgentPalette.radius.sm,
        background: c.bg,
        border:
          tone === 'muted' ? `1px dashed ${c.border}` : `1px solid ${c.border}`,
        lineHeight: 1.5,
        wordBreak: 'break-word',
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card shell — the icon tile + title + status chip + a `children` slot,
// mirroring connections.tsx ChannelCard so the BYOT card sits flush in the grid
// AND reads correctly when embedded standalone in a studio. Pure presentational.
// ---------------------------------------------------------------------------
function CardShell({
  title,
  subtitle,
  status,
  children,
}: {
  title: string;
  subtitle: string;
  status: { label: string; tone: 'ok' | 'warn' | 'muted' };
  children?: React.ReactNode;
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
          <TelegramIcon />
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
            <Chip
              color={toneStyle.color}
              bg={toneStyle.bg}
              border={toneStyle.border}
            >
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

// Relative/absolute connectedAt formatter — best-effort; a missing/absurd
// timestamp yields '' so the caller omits the "connecté le…" line.
function formatConnectedAt(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

export interface TelegramChannelCardProps {
  /** Which agent this bot connects to (hermes | openclaw). Per-agent — BYOT. */
  agent: AgentName;
}

/**
 * <TelegramChannelCard agent /> — the per-agent BYOT Telegram connect card.
 * Drives Passe's `useTelegramChannel(agent)` hook through the connect → verify →
 * connected → test / disconnect lifecycle. Fail-soft: a dark channel (404 / no
 * backend secret) or a hook that throws on mount collapses to a quiet "bientôt"
 * note — never an error banner. Exported cleanly for reuse in the studios.
 */
export function TelegramChannelCard({ agent }: TelegramChannelCardProps) {
  ensureAgentKeyframes();
  const { t } = useAgentLang();

  // Passe's hook. Guarded read so a partial return can't crash the card.
  const channel = useTelegramChannel(agent) as
    | {
        status?: {
          connected?: boolean;
          botUsername?: string | null;
          connectedAt?: number;
          dark?: boolean;
        };
        // Matches the hook contract: `connect` resolves void on success and
        // REJECTS (typed AgentApiError) on failure — it never resolves an
        // `{ ok:false }` envelope (see use-channels.ts `UseTelegramChannel`).
        connect?: (token: string) => Promise<void>;
        disconnect?: () => Promise<void>;
        test?: () => Promise<{ ok?: boolean; sent?: boolean }>;
        loading?: boolean;
      }
    | undefined;

  const status = channel?.status ?? {};
  const hookLoading = !!channel?.loading;
  const connected = !!status.connected;
  const dark = !!status.dark;
  const botUsername = status.botUsername ?? undefined;
  const connectedAt = formatConnectedAt(status.connectedAt);

  // Local UI state — the card's own lifecycle on top of the hook's data.
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { sent: boolean } | null
  >(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const onConnect = useCallback(() => {
    const trimmed = token.trim();
    if (!trimmed || connecting || !channel?.connect) return;
    setConnecting(true);
    setError(null);
    setTestResult(null);
    void (async () => {
      try {
        // Failures REJECT with a typed AgentApiError (handled below); a
        // resolved connect IS success — the hook never resolves `{ ok:false }`.
        await channel.connect!(trimmed);
        // Success: clear the secret from the input; the hook flips status.
        setToken('');
      } catch (err) {
        // 400 invalid_token is the expected "bad token" path; anything else is
        // surfaced verbatim. A 404 shouldn't reach here (dark state pre-empts
        // the connect UI), but treat it as the dark note if it does.
        if (err instanceof AgentApiError && err.status === 400) {
          setError(t('channels.byot.invalidToken'));
        } else {
          setError(
            err instanceof Error ? err.message : t('channels.byot.invalidToken')
          );
        }
      } finally {
        setConnecting(false);
      }
    })();
  }, [token, connecting, channel, t]);

  const onTest = useCallback(() => {
    if (testing || !channel?.test) return;
    setTesting(true);
    setError(null);
    setTestResult(null);
    void (async () => {
      try {
        const res = await channel.test!();
        setTestResult({ sent: !!(res && res.sent) });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('channels.byot.invalidToken')
        );
      } finally {
        setTesting(false);
      }
    })();
  }, [testing, channel, t]);

  const onDisconnect = useCallback(() => {
    if (disconnecting || !channel?.disconnect) return;
    setDisconnecting(true);
    setError(null);
    setTestResult(null);
    void (async () => {
      try {
        await channel.disconnect!();
      } catch {
        // Best-effort: the hook re-probes status; a failed disconnect just
        // leaves the connected face up, which is honest.
      } finally {
        setDisconnecting(false);
      }
    })();
  }, [disconnecting, channel]);

  // ── Status chip — connected / connecting / bientôt / à connecter. ──────────
  const chip: { label: string; tone: 'ok' | 'warn' | 'muted' } = connected
    ? { label: t('channels.byot.connected'), tone: 'ok' }
    : connecting
      ? { label: t('channels.byot.connecting'), tone: 'warn' }
      : dark
        ? { label: t('connections.status.soon'), tone: 'muted' }
        : { label: t('connections.status.unlinked'), tone: 'muted' };

  const subtitle = t('connections.telegram.subtitle');

  // ── DARK — feature off (404 / no backend secret): a quiet "bientôt" note. ──
  if (dark && !connected) {
    return (
      <CardShell
        title={t('channels.byot.title')}
        subtitle={subtitle}
        status={chip}
      >
        <Notice>{t('connections.telegram.dark')}</Notice>
      </CardShell>
    );
  }

  // ── CONNECTING — getMe in flight. ──────────────────────────────────────────
  if (connecting) {
    return (
      <CardShell
        title={t('channels.byot.title')}
        subtitle={subtitle}
        status={chip}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: P.muted,
            fontSize: AgentPalette.font.size.lg,
            padding: '4px 2px',
          }}
        >
          <Spinner size={16} /> {t('channels.byot.connecting')}
        </div>
      </CardShell>
    );
  }

  // ── CONNECTED — green ✓ + @botUsername + connectedAt + Tester + Déconnecter ─
  if (connected) {
    return (
      <CardShell
        title={t('channels.byot.title')}
        subtitle={subtitle}
        status={chip}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              padding: '9px 11px',
              borderRadius: AgentPalette.radius.sm,
              background: P.okBg,
              border: `1px solid ${P.okBorder}`,
            }}
          >
            <span
              aria-hidden
              style={{ color: P.okText, fontSize: 15, lineHeight: 1 }}
            >
              ✓
            </span>
            <span style={{ color: P.okText, fontWeight: 700 }}>
              {t('channels.byot.connected')}
            </span>
            {botUsername ? (
              <span
                dir="ltr"
                style={{
                  fontFamily: AgentPalette.font.mono,
                  fontSize: AgentPalette.font.size.md,
                  color: P.text,
                }}
              >
                @{botUsername}
              </span>
            ) : null}
          </div>

          {connectedAt ? (
            <p
              style={{
                margin: 0,
                fontSize: AgentPalette.font.size.md,
                color: P.muted,
                lineHeight: 1.5,
              }}
            >
              {t('channels.byot.since', { when: connectedAt })}
            </p>
          ) : null}

          {testResult ? (
            <Notice tone={testResult.sent ? 'ok' : 'muted'}>
              {testResult.sent
                ? t('channels.byot.tested')
                : t('channels.byot.testEmpty')}
            </Notice>
          ) : null}

          {error ? <Notice tone="err">{error}</Notice> : null}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={onTest}
              disabled={testing}
              className="cdz-agent-motion"
              style={{
                ...actionBtnStyle,
                opacity: testing ? 0.7 : 1,
                cursor: testing ? 'default' : 'pointer',
              }}
            >
              {testing ? (
                <Spinner size={14} color={P.onAccent} />
              ) : (
                <TelegramIcon style={{ fontSize: 16 }} />
              )}
              {testing ? t('channels.byot.testing') : t('channels.byot.test')}
            </button>
            <button
              type="button"
              onClick={onDisconnect}
              disabled={disconnecting}
              className="cdz-agent-motion"
              style={{
                ...ghostBtnStyle,
                color: P.errText,
                borderColor: P.errBorder,
                opacity: disconnecting ? 0.7 : 1,
                cursor: disconnecting ? 'default' : 'pointer',
              }}
            >
              {disconnecting ? (
                <Spinner size={14} color={P.errText} />
              ) : null}
              {t('channels.byot.disconnect')}
            </button>
          </div>
        </div>
      </CardShell>
    );
  }

  // ── NOT-CONNECTED — token input + 3-step how-to + Connecter. ───────────────
  // (Also the face shown while the hook's initial probe is loading — the input
  // is harmless and the button is disabled until a token is typed.)
  return (
    <CardShell
      title={t('channels.byot.title')}
      subtitle={subtitle}
      status={chip}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 3-step BotFather how-to (FR + darja). */}
        <ol
          style={{
            margin: 0,
            paddingInlineStart: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontSize: AgentPalette.font.size.md,
            color: P.muted,
            lineHeight: 1.5,
          }}
        >
          <li>{t('channels.byot.step1')}</li>
          <li>{t('channels.byot.step2')}</li>
          <li>{t('channels.byot.step3')}</li>
        </ol>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            type="password"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            value={token}
            placeholder={t('channels.byot.tokenPlaceholder')}
            aria-label={t('channels.byot.tokenPlaceholder')}
            onChange={e => {
              setToken(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') onConnect();
            }}
            disabled={hookLoading}
            style={inputStyle}
          />
          <p
            style={{
              margin: 0,
              fontSize: AgentPalette.font.size.sm,
              color: P.muted,
              lineHeight: 1.5,
            }}
          >
            {t('channels.byot.hint')}
          </p>
        </div>

        {error ? <Notice tone="err">{error}</Notice> : null}

        <button
          type="button"
          onClick={onConnect}
          disabled={!token.trim() || hookLoading}
          className="cdz-agent-motion"
          style={{
            ...actionBtnStyle,
            alignSelf: 'flex-start',
            opacity: !token.trim() || hookLoading ? 0.6 : 1,
            cursor: !token.trim() || hookLoading ? 'default' : 'pointer',
          }}
        >
          <TelegramIcon style={{ fontSize: 16 }} />{' '}
          {t('channels.byot.connect')}
        </button>
      </div>
    </CardShell>
  );
}

export default TelegramChannelCard;
