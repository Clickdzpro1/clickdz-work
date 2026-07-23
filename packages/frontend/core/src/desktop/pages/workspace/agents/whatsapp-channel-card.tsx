import {
  AgentPalette,
  Chip,
  ensureAgentKeyframes,
  Spinner,
} from '@affine/core/modules/agents/components';
import { AgentApiError } from '@affine/core/modules/agents/api';
import { useAgentLang } from '@affine/core/modules/agents/i18n';
import type { AgentName } from '@affine/core/modules/agents/types';
import { CommentIcon } from '@blocksuite/icons/rc';
import { type CSSProperties, useCallback, useState } from 'react';

import { useWhatsappChannel } from '../../../../modules/agents/use-whatsapp-channel';

// ---------------------------------------------------------------------------
// ClickDz Agents — <WhatsAppChannelCard agent /> (R16). The per-(user,agent)
// WhatsApp connect experience, a NEAR-CLONE of the R10 Telegram BYOT card
// (channel-card.tsx): same CardShell / Notice / button styles / formatConnectedAt,
// same fail-soft posture (a dark feature or a hook that throws collapses to a
// quiet "bientôt" note — never a toast, never a raw HTTP/stack). The ONLY
// structural difference is the middle face: WhatsApp pairs by an 8-char CODE
// (typed into WhatsApp > Linked Devices > "Link with phone number"), NOT a bot
// token and NOT a QR (WhatsApp's link-QR rotates ~30s), so the middle face is a
// code-shown / pairing UI (mono code + copy + a live "en attente…" poll spinner
// + a re-issue button) instead of the Telegram token input.
//
// STATES (single card, faces):
//   · dark          — the WhatsApp cap is off (caps.whatsappEnabled false). A
//                     quiet "bientôt" note, never an error. Gated by the `dark`
//                     prop the connections page derives from the cap.
//   · not-connected — a heading, a tel input for the store's number, a 3-step
//                     FR/darja how-to, and a "Connecter" button.
//   · connecting    — a spinner + "Génération du code…" while the code mints.
//   · pairing       — the big mono 8-char code + copy, the WhatsApp link steps,
//                     a live "en attente…" spinner (the hook polls status every
//                     3s, ≤90s), and a "Renvoyer un code" button. On the 90s
//                     hard-stop the face swaps to a "code expiré" + re-issue.
//   · connected     — a green ✓, the linked WhatsApp number, the connectedAt
//                     time, a "Tester" button, and a "Déconnecter" button.
//
// House rules: inline styles only (no .css.ts), no new deps, the SHARED agent
// palette + primitives (Chip / Spinner), a boot-safe rc icon (CommentIcon — the
// same icon connections.tsx already uses for WhatsApp). All copy comes from the
// shared agents i18n catalogue via useAgentLang() (FR default + Algerian darja)
// under the new `channels.wa.*` key group. The pairing code is display-only and
// the phone number is handed straight to the hook. Every error is mapped to a FR
// /darja message (branching on AgentApiError.status) and rendered INLINE via
// <Notice tone="err"> — the merchant never sees an HTTP code or a stack.
//
// CONSUMED CONTRACT — `modules/agents/use-whatsapp-channel.ts`:
//   useWhatsappChannel(agent) => {
//     status: { connected; phoneNumber?; status?; connectedAt? };
//     pair(phoneNumber): Promise<WhatsAppPairResult>;   // mint code + start poll
//     reissue(): Promise<WhatsAppPairResult>;           // re-mint, reset TTL
//     stopPairing(): void; disconnect(): Promise<void>;
//     test(): Promise<{ ok; sent; note? }>;
//     connecting; pairing; expired; code; formatted; loading; error;
//   }
// Everything is read defensively so a shape drift degrades to a quiet state.
// ---------------------------------------------------------------------------

const P = AgentPalette.color;

// A pill "button" style shared by the card actions (matches channel-card.tsx so
// the WhatsApp card reads identically to the Telegram card + channel grid).
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

// The phone input. `dir="ltr"` so the (latin/plus) number never mirrors under
// RTL; type=tel for the numeric keypad on mobile.
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

// A small notice block (dark / test-result / error), reused across faces.
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
// mirroring channel-card.tsx CardShell so the WhatsApp card sits flush in the
// connections grid. Pure presentational.
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
          <CommentIcon />
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
// value yields '' so the caller omits the "connecté le…" line. Accepts the
// backend's string timestamp (or a ms number) defensively.
function formatConnectedAt(v?: string | number): string {
  if (v === undefined || v === null || v === '') return '';
  const ms = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

export interface WhatsAppChannelCardProps {
  /** Which agent this number connects to (hermes | openclaw). Per-(user,agent). */
  agent: AgentName;
  /**
   * The dark-gate: true when the WhatsApp cap is off (caps.whatsappEnabled
   * false). Renders the quiet "bientôt" face instead of the pairing flow —
   * mirrors how the Telegram card treats a dark feature. Optional (defaults to
   * live) so a caller that doesn't gate still gets a working card.
   */
  dark?: boolean;
}

/**
 * <WhatsAppChannelCard agent /> — the per-(user,agent) WhatsApp pair-by-code
 * card. Drives `useWhatsappChannel(agent)` through connect → code-shown/pairing
 * (poll) → connected → test / disconnect. Fail-soft: a dark feature or a hook
 * that throws on mount collapses to a quiet "bientôt" note. Exported cleanly for
 * reuse (mounted twice on /agents/connections, one per agent — like Telegram).
 */
export function WhatsAppChannelCard({ agent, dark }: WhatsAppChannelCardProps) {
  ensureAgentKeyframes();
  const { t } = useAgentLang();

  // The hook. Guarded read so a partial return can't crash the card.
  const channel = useWhatsappChannel(agent) as
    | {
        status?: {
          connected?: boolean;
          phoneNumber?: string;
          status?: string;
          connectedAt?: number | string;
        };
        pair?: (
          phoneNumber: string
        ) => Promise<{ ok?: boolean; code?: string; formatted?: string; status?: string }>;
        reissue?: () => Promise<{ ok?: boolean; code?: string; formatted?: string; status?: string }>;
        stopPairing?: () => void;
        disconnect?: () => Promise<void>;
        test?: () => Promise<{ ok?: boolean; sent?: boolean; note?: string }>;
        connecting?: boolean;
        pairing?: boolean;
        expired?: boolean;
        code?: string | null;
        formatted?: string | null;
        loading?: boolean;
      }
    | undefined;

  const status = channel?.status ?? {};
  const hookLoading = !!channel?.loading;
  const connected = !!status.connected;
  const connecting = !!channel?.connecting;
  const pairing = !!channel?.pairing;
  const expired = !!channel?.expired;
  const formatted = channel?.formatted ?? channel?.code ?? null;
  const phoneNumber = status.phoneNumber ?? undefined;
  const connectedAt = formatConnectedAt(status.connectedAt);
  const isDark = !!dark && !connected;

  // Local UI state — the card's own lifecycle on top of the hook's data.
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ sent: boolean } | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Map a thrown/returned failure to a merchant-facing message by
  // AgentApiError.status (never surface a raw HTTP/stack). Mirrors the Telegram
  // card's 400 branch, extended to the WA error table. The backend throws
  // BadRequest('invalid_phone') AND BadRequest('channel_unavailable') both as
  // HTTP 400, so a 400 is disambiguated on the readable message: an
  // `invalid_phone` (or a 422, defensively) → the "bad number" copy; any other
  // 400 → the "couldn't mint the code" copy.
  const messageForError = useCallback(
    (err: unknown): string => {
      if (err instanceof AgentApiError) {
        const msg = (err.message || '').toLowerCase();
        const looksLikePhone = msg.includes('phone') || msg.includes('invalid_phone');
        switch (err.status) {
          case 400:
            return looksLikePhone
              ? t('channels.wa.err.badPhone')
              : t('channels.wa.err.mintFailed');
          case 401:
            return t('channels.wa.err.signedOut');
          case 422:
            return t('channels.wa.err.badPhone');
          case 429:
            return t('channels.wa.err.rateLimit');
          case 404:
            // Shouldn't reach here (dark pre-empts), but treat as the dark note.
            return t('channels.wa.dark');
          default:
            return t('channels.wa.err.generic');
        }
      }
      return t('channels.wa.err.generic');
    },
    [t]
  );

  const onConnect = useCallback(() => {
    const trimmed = phone.trim();
    if (!trimmed || connecting || !channel?.pair) return;
    setError(null);
    setTestResult(null);
    void (async () => {
      try {
        await channel.pair!(trimmed);
      } catch (err) {
        setError(messageForError(err));
      }
    })();
  }, [phone, connecting, channel, messageForError]);

  const onReissue = useCallback(() => {
    if (connecting || !channel?.reissue) return;
    setError(null);
    setCopied(false);
    void (async () => {
      try {
        await channel.reissue!();
      } catch (err) {
        setError(messageForError(err));
      }
    })();
  }, [connecting, channel, messageForError]);

  const onCopy = useCallback(() => {
    if (!formatted) return;
    void (async () => {
      try {
        await globalThis.navigator?.clipboard?.writeText(formatted);
        setCopied(true);
        globalThis.setTimeout?.(() => setCopied(false), 1600);
      } catch {
        // Clipboard denied (permissions / insecure origin) — non-fatal; the
        // code is visible on screen for the user to type manually.
      }
    })();
  }, [formatted]);

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
        setError(messageForError(err));
      } finally {
        setTesting(false);
      }
    })();
  }, [testing, channel, messageForError]);

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

  // ── Status chip — connected / connecting / pairing / bientôt / à connecter. ─
  const chip: { label: string; tone: 'ok' | 'warn' | 'muted' } = connected
    ? { label: t('channels.wa.connected'), tone: 'ok' }
    : connecting || pairing
      ? { label: t('connections.status.connected'), tone: 'warn' }
      : isDark
        ? { label: t('connections.status.soon'), tone: 'muted' }
        : { label: t('connections.status.unlinked'), tone: 'muted' };

  const subtitle = t('channels.wa.subtitle');

  // ── DARK — WhatsApp cap off: a quiet "bientôt" note. ───────────────────────
  if (isDark) {
    return (
      <CardShell title={t('channels.wa.title')} subtitle={subtitle} status={chip}>
        <Notice>{t('channels.wa.dark')}</Notice>
      </CardShell>
    );
  }

  // ── CONNECTED — green ✓ + WhatsApp number + connectedAt + Tester + Déconnecter
  if (connected) {
    return (
      <CardShell title={t('channels.wa.title')} subtitle={subtitle} status={chip}>
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
            <span aria-hidden style={{ color: P.okText, fontSize: 15, lineHeight: 1 }}>
              ✓
            </span>
            <span style={{ color: P.okText, fontWeight: 700 }}>
              {t('channels.wa.connected')}
            </span>
            {phoneNumber ? (
              <span
                dir="ltr"
                style={{
                  fontFamily: AgentPalette.font.mono,
                  fontSize: AgentPalette.font.size.md,
                  color: P.text,
                }}
              >
                {phoneNumber}
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
              {t('channels.wa.since', { when: connectedAt })}
            </p>
          ) : null}

          {testResult ? (
            <Notice tone={testResult.sent ? 'ok' : 'muted'}>
              {testResult.sent
                ? t('channels.wa.tested')
                : t('channels.wa.testEmpty')}
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
                <CommentIcon style={{ fontSize: 16 }} />
              )}
              {testing ? t('channels.wa.testing') : t('channels.wa.test')}
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
              {disconnecting ? <Spinner size={14} color={P.errText} /> : null}
              {t('channels.wa.disconnect')}
            </button>
          </div>
        </div>
      </CardShell>
    );
  }

  // ── CONNECTING — minting the code (before it's shown). ─────────────────────
  if (connecting && !formatted) {
    return (
      <CardShell title={t('channels.wa.title')} subtitle={subtitle} status={chip}>
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
          <Spinner size={16} /> {t('channels.wa.pairing')}
        </div>
      </CardShell>
    );
  }

  // ── PAIRING — the 8-char code is shown; poll runs (or it expired). ─────────
  if (pairing || (formatted && !expired)) {
    return (
      <CardShell title={t('channels.wa.title')} subtitle={subtitle} status={chip}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p
            style={{
              margin: 0,
              fontSize: AgentPalette.font.size.md,
              color: P.muted,
              lineHeight: 1.5,
            }}
          >
            {t('channels.wa.codeIntro')}
          </p>

          {/* Big mono code + copy. dir=ltr so the latin code never mirrors. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              padding: '12px 14px',
              borderRadius: AgentPalette.radius.sm,
              background: P.consoleBg,
              border: `1px solid ${P.border}`,
            }}
          >
            <span
              dir="ltr"
              style={{
                fontFamily: AgentPalette.font.mono,
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: '0.14em',
                color: P.consoleText,
                flex: 1,
                minWidth: 0,
                wordBreak: 'break-all',
              }}
            >
              {formatted ?? '········'}
            </span>
            <button
              type="button"
              onClick={onCopy}
              className="cdz-agent-motion"
              style={{ ...ghostBtnStyle, padding: '6px 12px' }}
            >
              {copied ? t('channels.wa.copied') : t('channels.wa.copy')}
            </button>
          </div>

          <p
            style={{
              margin: 0,
              fontSize: AgentPalette.font.size.md,
              color: P.muted,
              lineHeight: 1.55,
            }}
          >
            {t('channels.wa.codeSteps')}
          </p>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: P.muted,
              fontSize: AgentPalette.font.size.md,
              padding: '2px 2px',
            }}
          >
            <Spinner size={14} /> {t('channels.wa.waiting')}
          </div>

          {error ? <Notice tone="err">{error}</Notice> : null}

          <button
            type="button"
            onClick={onReissue}
            disabled={connecting}
            className="cdz-agent-motion"
            style={{
              ...ghostBtnStyle,
              alignSelf: 'flex-start',
              opacity: connecting ? 0.7 : 1,
              cursor: connecting ? 'default' : 'pointer',
            }}
          >
            {connecting ? <Spinner size={14} color={P.text} /> : null}
            {t('channels.wa.reissue')}
          </button>
        </div>
      </CardShell>
    );
  }

  // ── EXPIRED — the 90s poll elapsed without linking: "code expiré" + re-issue.
  if (expired) {
    return (
      <CardShell title={t('channels.wa.title')} subtitle={subtitle} status={chip}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Notice tone="err">{t('channels.wa.err.expired')}</Notice>
          {error ? <Notice tone="err">{error}</Notice> : null}
          <button
            type="button"
            onClick={onReissue}
            disabled={connecting}
            className="cdz-agent-motion"
            style={{
              ...actionBtnStyle,
              alignSelf: 'flex-start',
              opacity: connecting ? 0.7 : 1,
              cursor: connecting ? 'default' : 'pointer',
            }}
          >
            {connecting ? (
              <Spinner size={14} color={P.onAccent} />
            ) : (
              <CommentIcon style={{ fontSize: 16 }} />
            )}
            {t('channels.wa.reissue')}
          </button>
        </div>
      </CardShell>
    );
  }

  // ── NOT-CONNECTED (idle) — phone input + 3-step how-to + Connecter. ────────
  // (Also the face shown while the hook's initial probe is loading — the input
  // is harmless and the button is disabled until a number is typed.)
  return (
    <CardShell title={t('channels.wa.title')} subtitle={subtitle} status={chip}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 3-step how-to (FR + darja). */}
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
          <li>{t('channels.wa.step1')}</li>
          <li>{t('channels.wa.step2')}</li>
          <li>{t('channels.wa.step3')}</li>
        </ol>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            type="tel"
            dir="ltr"
            autoComplete="tel"
            spellCheck={false}
            value={phone}
            placeholder={t('channels.wa.phonePlaceholder')}
            aria-label={t('channels.wa.phonePlaceholder')}
            onChange={e => {
              setPhone(e.target.value);
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
            {t('channels.wa.hint')}
          </p>
        </div>

        {error ? <Notice tone="err">{error}</Notice> : null}

        <button
          type="button"
          onClick={onConnect}
          disabled={!phone.trim() || hookLoading}
          className="cdz-agent-motion"
          style={{
            ...actionBtnStyle,
            alignSelf: 'flex-start',
            opacity: !phone.trim() || hookLoading ? 0.6 : 1,
            cursor: !phone.trim() || hookLoading ? 'default' : 'pointer',
          }}
        >
          <CommentIcon style={{ fontSize: 16 }} /> {t('channels.wa.connect')}
        </button>
      </div>
    </CardShell>
  );
}

export default WhatsAppChannelCard;
