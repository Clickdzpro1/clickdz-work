import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import {
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// WS14 — WhatsappMax Studio (E2 — full chat UI).
//
// Two-pane WhatsApp-style chat app wired to the P4 E1 backend routes:
//   · QR Pairing screen: scannable QR image via GET /qr.png, polls status.
//   · Chat list (left pane): GET /chats, unread badge, last message, search.
//   · Conversation view (right pane): GET /messages, correct field mapping
//     (text_body→text, from_me→fromMe, message_id→id, ts→timestamp), media
//     tiles, day separators, composer (send text + media).
//   · AI auto-reply toggle (per chat): GET/POST /ai.
//   · Broadcast modal (secondary).
//   · Near-realtime updates via polling (pause on document.hidden).
//
// Route contract: /agent/workspace/fixes/p4e1.md
// Design spec:   /agent/workspace/plans/p4.md (E2 section)
//
// Inline styles + no new npm deps + French copy (matches existing conventions).
// ---------------------------------------------------------------------------

// ── Design tokens ──────────────────────────────────────────────────────────

const C = {
  bg: 'var(--affine-background-primary-color, #0f1115)',
  panel: 'var(--affine-background-secondary-color, #171a21)',
  surface: 'var(--affine-background-tertiary-color, #1e2330)',
  border: 'var(--affine-border-color, #262a35)',
  text: 'var(--affine-text-primary-color, #e6e9f0)',
  muted: 'var(--affine-text-secondary-color, #8a90a0)',
  accent: '#25D366', // WhatsApp green
  accentDark: '#128C7E',
  danger: '#ef4444',
  blue: '#3b82f6',
  orange: '#f59e0b',
};

const panelStyle: CSSProperties = {
  background: C.panel,
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: C.bg,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: '8px 10px',
  color: C.text,
  fontSize: 13,
  outline: 'none',
  fontFamily: 'inherit',
};

function btn(
  kind: 'primary' | 'secondary' | 'danger' | 'ghost',
  disabled: boolean
): CSSProperties {
  const bg =
    kind === 'primary'
      ? C.accent
      : kind === 'danger'
        ? C.danger
        : kind === 'ghost'
          ? 'transparent'
          : 'transparent';
  return {
    padding: '7px 13px',
    borderRadius: 8,
    border:
      kind === 'secondary' || kind === 'ghost'
        ? `1px solid ${C.border}`
        : 'none',
    background: disabled ? 'var(--affine-hover-color, #2a2f3a)' : bg,
    color:
      kind === 'primary' || kind === 'danger' ? '#0b1f14' : C.text,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    whiteSpace: 'nowrap' as const,
    lineHeight: 1.4,
  };
}

// ── Fail-soft API helpers ──────────────────────────────────────────────────

type Dark = { dark: true };

async function apiGet<T>(path: string): Promise<T | Dark | null> {
  try {
    const res = await fetch(cdzApiUrl(path), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (res.status === 404) return { dark: true };
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as T | null;
  } catch {
    return null;
  }
}

async function apiPost<T>(path: string, body: unknown): Promise<T | Dark | null> {
  try {
    const res = await fetch(cdzApiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body ?? {}),
    });
    if (res.status === 404) return { dark: true };
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as T | null;
  } catch {
    return null;
  }
}

function isDark(v: unknown): v is Dark {
  return !!v && typeof v === 'object' && (v as Dark).dark === true;
}

// ── Types (matching E1 route contract exactly) ─────────────────────────────

interface StatusResp {
  connected: boolean;
  phoneNumber?: string;
  status?: string;
  connectedAt?: number;
}

interface ConnectResp {
  ok: boolean;
  qr?: string;
  status: string;
}

// Gateway returns snake_case; E1 adds camelCase aliases on the same row.
interface MessageRow {
  // camelCase (E1 mapped)
  id?: string;
  chatJid?: string;
  text?: string;
  fromMe?: boolean;
  timestamp?: number | string;
  type?: string;
  pushName?: string;
  is_group?: boolean;
  // original snake_case (may also be present)
  message_id?: string;
  text_body?: string;
  from_me?: boolean;
  ts?: number | string;
  chat_jid?: string;
}

interface ChatRow {
  jid?: string;
  name?: string;
  displayName?: string;
  last_message_at?: number | string;
  phone?: string;
  chat_phone?: string;
  is_group?: boolean;
  unread?: number;
}

interface ContactRow {
  jid?: string;
  name?: string;
  phone?: string;
  pushName?: string;
}

// ── Field normalization (E1 snake_case + camelCase aliases) ────────────────

function normalizeMessage(raw: MessageRow): Required<Pick<MessageRow, 'id' | 'text' | 'fromMe' | 'timestamp' | 'type' | 'pushName' | 'is_group' | 'chatJid'>> & MessageRow {
  return {
    ...raw,
    id: raw.id ?? raw.message_id ?? String(Math.random()),
    text: raw.text ?? raw.text_body ?? '',
    fromMe: raw.fromMe ?? raw.from_me ?? false,
    timestamp: raw.timestamp ?? raw.ts ?? 0,
    type: raw.type ?? 'conversation',
    pushName: raw.pushName ?? '',
    is_group: raw.is_group ?? false,
    chatJid: raw.chatJid ?? raw.chat_jid ?? '',
  };
}

function jidOf(c: ChatRow): string {
  return c.jid ?? '';
}

function displayName(c: ChatRow): string {
  return c.displayName ?? c.name ?? c.phone ?? c.chat_phone ?? c.jid ?? 'Contact';
}

// ── Time helpers ───────────────────────────────────────────────────────────

function relativeTime(ts: number | string | undefined): string {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
  if (isNaN(d.getTime())) return '';
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'maintenant';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}min`;
  if (diff < 86_400_000) {
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  if (diff < 7 * 86_400_000) {
    return d.toLocaleDateString('fr-FR', { weekday: 'short' });
  }
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

function msgTime(ts: number | string | undefined): string {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(ts: number | string | undefined): string {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === yesterday.toDateString()) return 'Hier';
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function tsDay(ts: number | string | undefined): string {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
  if (isNaN(d.getTime())) return '';
  return d.toDateString();
}

// ── Avatar (initials) ──────────────────────────────────────────────────────

function Initials({ name, size = 36 }: { name: string; size?: number }): ReactElement {
  const letters = name
    .split(/[\s+@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('');
  const hue = [...name].reduce((h, c) => h + c.charCodeAt(0), 0) % 360;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `hsl(${hue},45%,38%)`,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.35,
        fontWeight: 700,
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {letters || '?'}
    </div>
  );
}

// ── QR Pairing screen ──────────────────────────────────────────────────────

interface QrPairingProps {
  status: StatusResp | null;
  onStatus: (s: StatusResp) => void;
  onDark: () => void;
  onConnected: () => void;
}

const QrPairing = ({ status, onStatus, onDark, onConnected }: QrPairingProps) => {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [qrTs, setQrTs] = useState<number | null>(null);
  // WS17: QR image readiness — a 202 (not-ready) response makes the <img>
  // fire onError and show a broken-image icon before the next 2s refresh.
  // Track load state so we can show a placeholder spinner while waiting.
  const [qrLoaded, setQrLoaded] = useState(false);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connected = status?.connected === true;
  const currentStatus = status?.status ?? '';
  const showQr =
    connecting || currentStatus === 'qr' || currentStatus === 'connecting' || currentStatus === 'created';

  const stopPolls = useCallback(() => {
    if (statusPollRef.current) {
      clearInterval(statusPollRef.current);
      statusPollRef.current = null;
    }
    if (qrRefreshRef.current) {
      clearInterval(qrRefreshRef.current);
      qrRefreshRef.current = null;
    }
  }, []);

  const startPolls = useCallback(() => {
    stopPolls();
    // QR image refresh every 2s (cache-buster)
    setQrLoaded(false);
    setQrTs(Date.now());
    qrRefreshRef.current = setInterval(() => {
      setQrLoaded(false);
      setQrTs(Date.now());
    }, 2000);

    // Status poll every 2.5s
    statusPollRef.current = setInterval(() => {
      void (async () => {
        const s = await apiGet<StatusResp>('/api/v1/whatsappmax/status');
        if (isDark(s)) {
          stopPolls();
          onDark();
          return;
        }
        if (s) {
          onStatus(s);
          if (s.connected) {
            stopPolls();
            setConnecting(false);
            setQrTs(null);
            onConnected();
          }
        }
      })();
    }, 2500);
  }, [stopPolls, onDark, onStatus, onConnected]);

  useEffect(() => () => stopPolls(), [stopPolls]);

  // If already in a qr/connecting state on mount, start polling
  useEffect(() => {
    if (
      !connected &&
      (currentStatus === 'qr' ||
        currentStatus === 'connecting' ||
        currentStatus === 'created')
    ) {
      setConnecting(true);
      startPolls();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(async () => {
    setErr(null);
    setBusy(true);
    const body: Record<string, string> = {};
    const p = phone.replace(/[^\d]/g, '');
    if (p.length >= 8) body.phoneNumber = p;
    const out = await apiPost<ConnectResp>('/api/v1/whatsappmax/connect', body);
    setBusy(false);
    if (isDark(out)) return onDark();
    if (!out || !out.ok) {
      setErr('Connexion impossible pour le moment. Réessayez.');
      return;
    }
    setConnecting(true);
    startPolls();
  }, [phone, onDark, startPolls]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    const out = await apiPost<{ ok: boolean }>('/api/v1/whatsappmax/disconnect', {});
    setBusy(false);
    if (isDark(out)) return onDark();
    stopPolls();
    setConnecting(false);
    setQrTs(null);
    onStatus({ connected: false, status: 'disconnected' });
  }, [onDark, onStatus, stopPolls]);

  if (connected) {
    return (
      <div style={{ ...panelStyle, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div
          style={{
            background: C.accent,
            color: '#0b1f14',
            borderRadius: 999,
            padding: '2px 10px',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          Connecté
        </div>
        <span style={{ fontSize: 13, color: C.muted, flex: 1 }}>
          {status?.phoneNumber
            ? `+${status.phoneNumber} lié à WhatsappMax`
            : 'Votre numéro WhatsApp est lié.'}
        </span>
        <button
          style={btn('danger', busy)}
          disabled={busy}
          onClick={() => void disconnect()}
        >
          Déconnecter
        </button>
      </div>
    );
  }

  const statusLabel: Record<string, string> = {
    created: 'Initialisation…',
    connecting: 'Connexion…',
    qr: 'QR prêt — scannez avec WhatsApp',
    disconnected: 'Déconnecté',
    logged_out: 'Déconnecté',
  };
  const statusColor: Record<string, string> = {
    created: C.orange,
    connecting: C.orange,
    qr: C.accent,
    disconnected: C.muted,
    logged_out: C.muted,
  };

  return (
    <div style={{ ...panelStyle, alignItems: 'center', padding: 24 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 4 }}>
        Lier WhatsApp via QR
      </div>
      <div style={{ fontSize: 12.5, color: C.muted, textAlign: 'center', maxWidth: 380, marginBottom: 12 }}>
        Ouvrez WhatsApp sur votre téléphone → <strong style={{ color: C.text }}>Appareils liés</strong> →{' '}
        <strong style={{ color: C.text }}>Lier un appareil</strong> → scannez le code QR.
      </div>

      {showQr && qrTs ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              background: '#fff',
              borderRadius: 12,
              padding: 12,
              boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
              position: 'relative',
              width: 280,
              height: 280,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            {/* WS17: placeholder while the QR image is fetching (a 202
                'not ready' response fires onError; without this the user sees
                a broken-image icon for ~2s until the next refresh). */}
            {!qrLoaded && (
              <div
                style={{
                  position: 'absolute',
                  inset: 12,
                  display: 'grid',
                  placeItems: 'center',
                  color: '#9ca3af',
                  fontSize: 12.5,
                  gap: 10,
                  textAlign: 'center',
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: '50%',
                    border: '3px solid #e5e7eb',
                    borderTopColor: '#2563eb',
                    animation: 'cdz-qr-spin 0.8s linear infinite',
                  }}
                />
                Génération du code QR…
              </div>
            )}
            <img
              src={cdzApiUrl(`/api/v1/whatsappmax/qr.png?ts=${qrTs}`)}
              alt="QR WhatsApp"
              width={256}
              height={256}
              style={{
                display: qrLoaded ? 'block' : 'none',
                borderRadius: 4,
              }}
              onLoad={() => setQrLoaded(true)}
              onError={() => {
                /* 202 = not ready yet; keep refreshing. Stay on placeholder. */
                setQrLoaded(false);
              }}
            />
          </div>
          <div
            style={{
              fontSize: 12,
              color: statusColor[currentStatus] ?? C.muted,
              fontWeight: 600,
            }}
          >
            {statusLabel[currentStatus] ?? 'En attente…'}
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>
            Le code se régénère automatiquement toutes les ~20 secondes.
          </div>
        </div>
      ) : !connecting ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 320, alignItems: 'center' }}>
          <input
            style={{ ...inputStyle, textAlign: 'center' }}
            value={phone}
            disabled={busy}
            inputMode="numeric"
            autoComplete="off"
            placeholder="Numéro optionnel : 213xxxxxxxxx"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPhone(e.target.value)}
          />
          {err ? (
            <div style={{ fontSize: 12, color: C.danger }}>{err}</div>
          ) : null}
          <button
            style={{ ...btn('primary', busy), padding: '10px 28px', fontSize: 14 }}
            disabled={busy}
            onClick={() => void connect()}
          >
            {busy ? 'Connexion…' : 'Lier via QR'}
          </button>
          <div style={{ fontSize: 11.5, color: C.muted, textAlign: 'center' }}>
            Le numéro est optionnel — la liaison QR fonctionne sans le renseigner.
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: C.orange, fontWeight: 600 }}>
          Initialisation du QR…
        </div>
      )}
    </div>
  );
};

// ── AI Toggle (per-chat) ───────────────────────────────────────────────────

interface AiToggleProps {
  chatJid: string;
  onDark: () => void;
}

const AiToggle = ({ chatJid, onDark }: AiToggleProps) => {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!chatJid) return;
    void (async () => {
      const out = await apiGet<{ enabled: boolean }>(
        `/api/v1/whatsappmax/ai?chatJid=${encodeURIComponent(chatJid)}`
      );
      if (isDark(out)) { onDark(); return; }
      if (out) setEnabled(out.enabled);
    })();
  }, [chatJid, onDark]);

  const toggle = useCallback(async () => {
    if (enabled === null) return;
    setBusy(true);
    const next = !enabled;
    const out = await apiPost<{ ok: boolean; enabled: boolean }>(
      '/api/v1/whatsappmax/ai',
      { chatJid, enabled: next }
    );
    setBusy(false);
    if (isDark(out)) { onDark(); return; }
    if (out) setEnabled(out.enabled);
  }, [enabled, chatJid, onDark]);

  if (enabled === null) return null;

  return (
    <button
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        border: `1px solid ${enabled ? C.accent : C.border}`,
        background: enabled ? `${C.accent}22` : 'transparent',
        color: enabled ? C.accent : C.muted,
        fontSize: 11.5,
        fontWeight: 600,
        cursor: busy ? 'wait' : 'pointer',
        opacity: busy ? 0.7 : 1,
        whiteSpace: 'nowrap',
      }}
      disabled={busy}
      title="Réponses IA automatiques — active/désactive l'auto-réponse IA pour cette conversation"
      onClick={() => void toggle()}
    >
      <span style={{ fontSize: 13 }}>{enabled ? '🤖' : '🤖'}</span>
      Réponses IA {enabled ? 'ON' : 'OFF'}
    </button>
  );
};

// ── Media bubble ───────────────────────────────────────────────────────────

interface MediaBubbleProps {
  messageId: string;
  type: string;
  fromMe: boolean;
}

const MediaBubble = ({ messageId, type, fromMe }: MediaBubbleProps) => {
  const mediaUrl = cdzApiUrl(
    `/api/v1/whatsappmax/media?messageId=${encodeURIComponent(messageId)}`
  );
  const textColor = fromMe ? '#0b1f14' : C.text;
  const mutedColor = fromMe ? '#1a4a2e' : C.muted;

  if (type === 'imageMessage' || type === 'stickerMessage') {
    return (
      <img
        src={mediaUrl}
        alt="image"
        style={{
          maxWidth: 200,
          maxHeight: 200,
          borderRadius: 8,
          display: 'block',
          objectFit: 'cover',
        }}
        onError={e => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  if (type === 'videoMessage') {
    return (
      <video
        src={mediaUrl}
        controls
        style={{ maxWidth: 240, borderRadius: 8, display: 'block' }}
      />
    );
  }
  if (type === 'audioMessage') {
    return (
      <audio
        src={mediaUrl}
        controls
        style={{ maxWidth: 240 }}
      />
    );
  }
  if (type === 'documentMessage') {
    return (
      <a
        href={mediaUrl}
        download
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: fromMe ? '#0b5c2e' : C.blue, fontSize: 12.5, fontWeight: 600 }}
      >
        📎 Télécharger le document
      </a>
    );
  }
  // fallback
  return (
    <span style={{ fontSize: 12, color: mutedColor }}>
      [{type}] — <a
        href={mediaUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: textColor }}
      >ouvrir</a>
    </span>
  );
};

// ── Composer ──────────────────────────────────────────────────────────────

interface ComposerProps {
  chatJid: string;
  connected: boolean;
  onDark: () => void;
  onSent: (msg: MessageRow) => void;
}

const Composer = ({ chatJid, connected, onDark, onSent }: ComposerProps) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showMedia, setShowMedia] = useState(false);
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaKind, setMediaKind] = useState<'image' | 'video' | 'audio' | 'document'>('image');
  const [mediaCaption, setMediaCaption] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const sendText = useCallback(async () => {
    const body = text.trim();
    if (!body || busy || !connected) return;
    setBusy(true);
    setErr(null);
    const out = await apiPost<{ ok: boolean; sent: boolean; note?: string }>(
      '/api/v1/whatsappmax/send',
      { to: chatJid, text: body }
    );
    setBusy(false);
    if (isDark(out)) { onDark(); return; }
    if (out && out.sent) {
      setText('');
      // Optimistic message bubble
      const optimistic: MessageRow = {
        id: `opt_${Date.now()}`,
        chatJid,
        text: body,
        fromMe: true,
        timestamp: Date.now(),
        type: 'conversation',
        pushName: '',
        is_group: false,
      };
      onSent(optimistic);
    } else {
      setErr(out?.note === 'not_connected' ? 'Liez un numéro WhatsApp d\'abord.' : 'Envoi échoué.');
    }
  }, [text, busy, connected, chatJid, onDark, onSent]);

  const sendMedia = useCallback(async () => {
    const url = mediaUrl.trim();
    if (!url || busy || !connected) return;
    setBusy(true);
    setErr(null);
    const out = await apiPost<{ ok: boolean; messageId?: string }>(
      '/api/v1/whatsappmax/sendMedia',
      {
        to: chatJid,
        kind: mediaKind,
        url,
        caption: mediaCaption.trim() || undefined,
      }
    );
    setBusy(false);
    if (isDark(out)) { onDark(); return; }
    if (out && out.ok && !(out as { note?: string }).note) {
      setMediaUrl('');
      setMediaCaption('');
      setShowMedia(false);
    } else {
      setErr(
        (out as { note?: string })?.note === 'not_connected'
          ? 'Liez un numéro WhatsApp d\'abord.'
          : 'Envoi du média échoué.'
      );
    }
  }, [mediaUrl, mediaKind, mediaCaption, busy, connected, chatJid, onDark]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendText();
    }
  };

  const disabled = !connected || busy;

  return (
    <div
      style={{
        borderTop: `1px solid ${C.border}`,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: C.panel,
        flexShrink: 0,
      }}
    >
      {showMedia && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '10px 12px',
            background: C.surface,
            borderRadius: 8,
            border: `1px solid ${C.border}`,
          }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
            {(['image', 'video', 'audio', 'document'] as const).map(k => (
              <button
                key={k}
                style={{
                  ...btn('ghost', false),
                  background: mediaKind === k ? C.surface : 'transparent',
                  border: `1px solid ${mediaKind === k ? C.accent : C.border}`,
                  color: mediaKind === k ? C.accent : C.muted,
                  padding: '3px 8px',
                  fontSize: 11.5,
                }}
                onClick={() => setMediaKind(k)}
              >
                {k}
              </button>
            ))}
          </div>
          <input
            style={inputStyle}
            value={mediaUrl}
            placeholder="URL du média (https://…)"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setMediaUrl(e.target.value)}
          />
          <input
            style={inputStyle}
            value={mediaCaption}
            placeholder="Légende (optionnel)"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setMediaCaption(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={btn('primary', disabled)} disabled={disabled} onClick={() => void sendMedia()}>
              {busy ? 'Envoi…' : 'Envoyer le média'}
            </button>
            <button style={btn('ghost', false)} onClick={() => setShowMedia(false)}>
              Annuler
            </button>
          </div>
        </div>
      )}
      {err ? <div style={{ fontSize: 12, color: C.danger }}>{err}</div> : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <button
          style={{
            ...btn('ghost', disabled),
            padding: '8px',
            fontSize: 18,
            lineHeight: 1,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
          }}
          title="Joindre un média"
          disabled={disabled}
          onClick={() => setShowMedia(v => !v)}
        >
          📎
        </button>
        <textarea
          ref={textareaRef}
          style={{
            ...inputStyle,
            flex: 1,
            minHeight: 38,
            maxHeight: 120,
            resize: 'none',
            lineHeight: 1.5,
          }}
          value={text}
          disabled={disabled}
          placeholder={connected ? 'Votre message… (Entrée pour envoyer)' : 'Liez un numéro pour écrire…'}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          style={{
            ...btn('primary', !text.trim() || disabled),
            padding: '9px 16px',
            fontSize: 14,
          }}
          disabled={!text.trim() || disabled}
          onClick={() => void sendText()}
        >
          ➤
        </button>
      </div>
    </div>
  );
};

// ── Conversation view (right pane) ─────────────────────────────────────────

interface ConversationProps {
  chatJid: string;
  chatName: string;
  isGroup: boolean;
  connected: boolean;
  onDark: () => void;
  onClose: () => void;
}

const Conversation = ({
  chatJid,
  chatName,
  isGroup,
  connected,
  onDark,
  onClose,
}: ConversationProps) => {
  const [messages, setMessages] = useState<ReturnType<typeof normalizeMessage>[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  // Mark as read when opened
  useEffect(() => {
    void apiPost('/api/v1/whatsappmax/read', { chatJid });
  }, [chatJid]);

  const fetchMessages = useCallback(
    async (opts?: { before?: number; prepend?: boolean }) => {
      if (opts?.prepend) setLoadingOlder(true);
      else setLoading(true);

      const params = new URLSearchParams({ chatJid, limit: '50' });
      if (opts?.before) params.set('before', String(opts.before));

      const out = await apiGet<{ messages: MessageRow[] }>(
        `/api/v1/whatsappmax/messages?${params.toString()}`
      );
      if (!mountedRef.current) return;
      if (opts?.prepend) setLoadingOlder(false);
      else setLoading(false);

      if (isDark(out)) { onDark(); return; }
      if (!out || !Array.isArray(out.messages)) return;

      const normalized = out.messages.map(normalizeMessage);
      if (opts?.prepend) {
        setMessages(prev => {
          // Deduplicate by id
          const existingIds = new Set(prev.map(m => m.id));
          const newOnes = normalized.filter(m => !existingIds.has(m.id));
          return [...newOnes.reverse(), ...prev];
        });
        setHasOlder(normalized.length >= 50);
      } else {
        setMessages(prev => {
          if (prev.length === 0) {
            // Initial load — show newest-last (backend returns newest-first)
            return [...normalized].reverse();
          }
          // Merge new messages (polling)
          const existingIds = new Set(prev.map(m => m.id));
          const newOnes = normalized.filter(m => !existingIds.has(m.id));
          return newOnes.length > 0 ? [...prev, ...newOnes.reverse()] : prev;
        });
        setHasOlder(prev => prev && normalized.length >= 50);
      }
    },
    [chatJid, onDark]
  );

  // Scroll to bottom on initial load
  useEffect(() => {
    if (messages.length > 0 && !loadingOlder) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, loadingOlder]);

  // Start polling
  useEffect(() => {
    mountedRef.current = true;
    void fetchMessages();

    // Poll every 3s, pause when hidden
    const startPoll = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        if (!document.hidden) void fetchMessages();
      }, 3000);
    };
    startPoll();
    const onVisChange = () => {
      if (document.hidden) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      } else {
        startPoll();
      }
    };
    document.addEventListener('visibilitychange', onVisChange);

    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', onVisChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatJid]);

  const loadOlder = useCallback(() => {
    const oldest = messages[0];
    if (!oldest || !hasOlder || loadingOlder) return;
    const ts = typeof oldest.timestamp === 'number' ? oldest.timestamp : Number(oldest.timestamp ?? 0);
    void fetchMessages({ before: ts, prepend: true });
  }, [messages, hasOlder, loadingOlder, fetchMessages]);

  const onSent = useCallback((msg: MessageRow) => {
    setMessages(prev => [...prev, normalizeMessage(msg)]);
  }, []);

  const mediaTypes = new Set([
    'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage',
  ]);

  // Build day-grouped messages
  let lastDay = '';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: C.bg,
        overflow: 'hidden',
      }}
    >
      {/* Conversation header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          borderBottom: `1px solid ${C.border}`,
          background: C.panel,
          flexShrink: 0,
        }}
      >
        <button
          style={{
            background: 'transparent',
            border: 'none',
            color: C.muted,
            fontSize: 18,
            cursor: 'pointer',
            padding: '2px 6px',
            borderRadius: 6,
            display: 'none',
          }}
          title="Retour"
          onClick={onClose}
        >
          ←
        </button>
        <Initials name={chatName} size={34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: C.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {chatName}
          </div>
          {isGroup && (
            <div style={{ fontSize: 11, color: C.muted }}>Groupe</div>
          )}
        </div>
        <AiToggle chatJid={chatJid} onDark={onDark} />
      </div>

      {/* Messages area */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {loading && messages.length === 0 && (
          <div style={{ textAlign: 'center', color: C.muted, fontSize: 12.5 }}>
            Chargement…
          </div>
        )}
        {hasOlder && messages.length > 0 && (
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <button
              style={{ ...btn('ghost', loadingOlder), fontSize: 11.5 }}
              disabled={loadingOlder}
              onClick={loadOlder}
            >
              {loadingOlder ? 'Chargement…' : '↑ Voir les messages plus anciens'}
            </button>
          </div>
        )}
        {messages.length === 0 && !loading ? (
          <div style={{ textAlign: 'center', color: C.muted, fontSize: 12.5 }}>
            Aucun message dans cette conversation.
          </div>
        ) : null}
        {messages.map((m, idx) => {
          const day = tsDay(m.timestamp);
          const showDay = day !== lastDay;
          lastDay = day;
          const isMedia = mediaTypes.has(m.type ?? '');
          const bubbleBg = m.fromMe ? C.accent : C.surface;
          const bubbleColor = m.fromMe ? '#0b1f14' : C.text;

          return (
            <div key={`${m.id}_${idx}`} style={{ display: 'contents' }}>
              {showDay && day && (
                <div
                  style={{
                    textAlign: 'center',
                    margin: '10px 0 4px',
                    fontSize: 11,
                    color: C.muted,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <hr style={{ flex: 1, border: 'none', borderTop: `1px solid ${C.border}` }} />
                  <span
                    style={{
                      background: C.surface,
                      padding: '2px 10px',
                      borderRadius: 999,
                      border: `1px solid ${C.border}`,
                    }}
                  >
                    {dayLabel(m.timestamp)}
                  </span>
                  <hr style={{ flex: 1, border: 'none', borderTop: `1px solid ${C.border}` }} />
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  justifyContent: m.fromMe ? 'flex-end' : 'flex-start',
                  marginBottom: 3,
                  marginTop: idx === 0 ? 0 : 1,
                }}
              >
                {/* Sender name in groups (incoming only) */}
                {isGroup && !m.fromMe && m.pushName && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 2,
                      maxWidth: '78%',
                    }}
                  >
                    <span style={{ fontSize: 10.5, color: C.accent, fontWeight: 600, paddingLeft: 10 }}>
                      {m.pushName}
                    </span>
                    <div
                      style={{
                        background: bubbleBg,
                        color: bubbleColor,
                        borderRadius: '4px 12px 12px 12px',
                        padding: '7px 11px',
                        fontSize: 13,
                        wordBreak: 'break-word',
                        lineHeight: 1.5,
                        maxWidth: '100%',
                        border: `1px solid ${C.border}`,
                      }}
                    >
                      {isMedia && m.id ? (
                        <MediaBubble messageId={m.id} type={m.type ?? ''} fromMe={m.fromMe} />
                      ) : (
                        m.text || '—'
                      )}
                      <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7, textAlign: 'right', color: bubbleColor }}>
                        {msgTime(m.timestamp)}
                      </div>
                    </div>
                  </div>
                )}
                {(!isGroup || m.fromMe || !m.pushName) && (
                  <div
                    style={{
                      background: bubbleBg,
                      color: bubbleColor,
                      borderRadius: m.fromMe ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
                      padding: '7px 11px',
                      fontSize: 13,
                      wordBreak: 'break-word',
                      lineHeight: 1.5,
                      maxWidth: '78%',
                      border: `1px solid ${m.fromMe ? 'transparent' : C.border}`,
                    }}
                  >
                    {isMedia && m.id ? (
                      <MediaBubble messageId={m.id} type={m.type ?? ''} fromMe={m.fromMe} />
                    ) : (
                      m.text || '—'
                    )}
                    <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7, textAlign: 'right', color: m.fromMe ? '#1a4a2e' : C.muted }}>
                      {msgTime(m.timestamp)}
                      {m.fromMe && <span style={{ marginLeft: 4 }}>✓</span>}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <Composer
        chatJid={chatJid}
        connected={connected}
        onDark={onDark}
        onSent={onSent}
      />
    </div>
  );
};

// ── Chat list (left pane) ──────────────────────────────────────────────────

interface ChatListProps {
  active: string | null;
  onSelect: (jid: string, name: string, isGroup: boolean) => void;
  onDark: () => void;
}

const ChatList = ({ active, onSelect, onDark }: ChatListProps) => {
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  // WS17: track gateway errors separately from genuine empties so the user sees
  // "Erreur de récupération" instead of "Aucune conversation" when the gateway
  // hiccups (the apiGet fail-soft path returns null on any non-ok).
  const [chatError, setChatError] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const fetchChats = useCallback(async () => {
    setLoading(true);
    setChatError(false);
    const out = await apiGet<{ chats: ChatRow[] }>('/api/v1/whatsappmax/chats');
    if (!mountedRef.current) return;
    setLoading(false);
    if (isDark(out)) { onDark(); return; }
    if (out === null) { setChatError(true); return; }
    if (out && Array.isArray(out.chats)) setChats(out.chats);
  }, [onDark]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchChats();

    const startPoll = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        if (!document.hidden) void fetchChats();
      }, 5000);
    };
    startPoll();
    const onVisChange = () => {
      if (document.hidden) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      } else {
        void fetchChats();
        startPoll();
      }
    };
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', onVisChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = chats.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      displayName(c).toLowerCase().includes(q) ||
      (c.phone ?? '').includes(q)
    );
  });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        borderRight: `1px solid ${C.border}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 12px 8px',
          borderBottom: `1px solid ${C.border}`,
          background: C.panel,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.text, flex: 1 }}>
            Conversations
          </span>
          <button
            style={{ ...btn('ghost', loading), fontSize: 11, padding: '3px 8px' }}
            disabled={loading}
            onClick={() => void fetchChats()}
            title="Actualiser"
          >
            {loading ? '…' : '↻'}
          </button>
        </div>
        <input
          style={{ ...inputStyle, fontSize: 12 }}
          value={search}
          placeholder="Rechercher…"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
        />
      </div>

      {/* Chat rows */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12.5, color: C.muted }}>
            {loading ? 'Chargement…' : chatError ? 'Erreur de récupération. Réessayez.' : search ? 'Aucun résultat.' : 'Aucune conversation. Revenez après avoir reçu un message.'}
          </div>
        ) : (
          filtered.map(c => {
            const jid = jidOf(c);
            const name = displayName(c);
            const isActive = active === jid;
            const unread = c.unread ?? 0;

            return (
              <button
                key={jid}
                type="button"
                onClick={() => onSelect(jid, name, c.is_group ?? false)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: 0,
                  border: 'none',
                  borderBottom: `1px solid ${C.border}`,
                  background: isActive ? `${C.accent}18` : 'transparent',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  borderLeft: isActive ? `3px solid ${C.accent}` : '3px solid transparent',
                }}
              >
                <Initials name={name} size={38} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: unread > 0 ? 700 : 500,
                        color: C.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {c.is_group && (
                        <span style={{ marginRight: 4, fontSize: 12 }}>👥</span>
                      )}
                      {name}
                    </span>
                    {c.last_message_at && (
                      <span
                        style={{
                          fontSize: 10.5,
                          color: C.muted,
                          flexShrink: 0,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {relativeTime(c.last_message_at)}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    <span
                      style={{
                        fontSize: 11.5,
                        color: C.muted,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                    >
                      {c.phone ?? jid}
                    </span>
                    {unread > 0 && (
                      <span
                        style={{
                          background: C.accent,
                          color: '#0b1f14',
                          borderRadius: 999,
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '1px 6px',
                          flexShrink: 0,
                        }}
                      >
                        {unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

// ── Broadcast modal ────────────────────────────────────────────────────────

interface BroadcastModalProps {
  onDark: () => void;
  onClose: () => void;
}

const BroadcastModal = ({ onDark, onClose }: BroadcastModalProps) => {
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const body = text.trim();
    if (!body) { setNote('Écrivez un message.'); return; }
    const recipients = to
      .split(/[\s,;]+/)
      .map(x => x.replace(/[^\d]/g, ''))
      .filter(x => x.length >= 8);
    if (!recipients.length) { setNote('Ajoutez au moins un numéro valide.'); return; }
    setBusy(true);
    setNote(null);
    const out = await apiPost<{ ok: boolean; sent: number; failed: number; total: number }>(
      '/api/v1/whatsappmax/broadcast',
      { to: recipients, text: body }
    );
    setBusy(false);
    if (isDark(out)) { onDark(); return; }
    if (out) {
      setNote(`Diffusion : ${out.sent}/${out.total} envoyés${out.failed ? `, ${out.failed} échoués` : ''}.`);
    } else {
      setNote('Diffusion échouée.');
    }
  }, [to, text, onDark]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          padding: 24,
          width: 400,
          maxWidth: '92vw',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Diffusion</span>
          <button style={{ background: 'none', border: 'none', color: C.muted, fontSize: 18, cursor: 'pointer' }} onClick={onClose}>✕</button>
        </div>
        <input
          style={inputStyle}
          value={to}
          disabled={busy}
          placeholder="213xxx, 213yyy, … (séparés par des virgules)"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setTo(e.target.value)}
        />
        <textarea
          style={{ ...inputStyle, minHeight: 90, resize: 'vertical' as const }}
          value={text}
          disabled={busy}
          placeholder="Votre message…"
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
        />
        {note && <div style={{ fontSize: 12.5, color: C.muted }}>{note}</div>}
        <button style={btn('primary', busy)} disabled={busy} onClick={() => void submit()}>
          {busy ? 'Diffusion…' : 'Diffuser'}
        </button>
        <div style={{ fontSize: 11.5, color: C.muted }}>
          La cadence d'envoi est régulée par la passerelle (anti-spam / warm-up). Max 50 destinataires.
        </div>
      </div>
    </div>
  );
};

// ── Chat app (two-pane) ────────────────────────────────────────────────────

interface ChatAppProps {
  status: StatusResp | null;
  onDark: () => void;
}

const ChatApp = ({ status, onDark }: ChatAppProps) => {
  const [activeJid, setActiveJid] = useState<string | null>(null);
  const [activeName, setActiveName] = useState('');
  const [activeIsGroup, setActiveIsGroup] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const connected = status?.connected === true;

  const selectChat = useCallback((jid: string, name: string, isGroup: boolean) => {
    setActiveJid(jid);
    setActiveName(name);
    setActiveIsGroup(isGroup);
  }, []);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden',
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        background: C.bg,
      }}
    >
      {/* Left pane — chat list */}
      <div
        style={{
          width: 300,
          minWidth: 220,
          maxWidth: 320,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <ChatList active={activeJid} onSelect={selectChat} onDark={onDark} />
        {/* Broadcast CTA */}
        <div
          style={{
            padding: '8px 10px',
            borderTop: `1px solid ${C.border}`,
            background: C.panel,
            flexShrink: 0,
          }}
        >
          <button
            style={{ ...btn('secondary', false), width: '100%', fontSize: 11.5 }}
            onClick={() => setShowBroadcast(true)}
          >
            📢 Diffusion
          </button>
        </div>
      </div>

      {/* Right pane — conversation */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {activeJid ? (
          <Conversation
            chatJid={activeJid}
            chatName={activeName}
            isGroup={activeIsGroup}
            connected={connected}
            onDark={onDark}
            onClose={() => setActiveJid(null)}
          />
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              color: C.muted,
            }}
          >
            <div style={{ fontSize: 40 }}>💬</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>WhatsappMax</div>
            <div style={{ fontSize: 12.5, color: C.muted, textAlign: 'center', maxWidth: 260 }}>
              Sélectionnez une conversation dans la liste pour afficher les messages.
            </div>
            {!connected && (
              <div
                style={{
                  fontSize: 12,
                  color: C.danger,
                  background: `${C.danger}18`,
                  border: `1px solid ${C.danger}44`,
                  borderRadius: 8,
                  padding: '6px 12px',
                }}
              >
                Liez un numéro WhatsApp pour envoyer des messages.
              </div>
            )}
          </div>
        )}
      </div>

      {showBroadcast && (
        <BroadcastModal onDark={onDark} onClose={() => setShowBroadcast(false)} />
      )}
    </div>
  );
};

// ── Page shell ─────────────────────────────────────────────────────────────

const WhatsappMaxPage = () => {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [dark, setDark] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showChat, setShowChat] = useState(false);

  useEffect(() => {
    void (async () => {
      const s = await apiGet<StatusResp>('/api/v1/whatsappmax/status');
      if (isDark(s)) {
        setDark(true);
      } else if (s) {
        setStatus(s);
        if (s.connected) setShowChat(true);
      }
      setLoaded(true);
    })();
  }, []);

  const handleStatus = useCallback((s: StatusResp) => {
    setStatus(s);
    if (s.connected) setShowChat(true);
    if (!s.connected && s.status === 'logged_out') setShowChat(false);
  }, []);

  const handleConnected = useCallback(() => {
    setShowChat(true);
  }, []);

  return (
    <>
      <ViewTitle title="WhatsappMax" />
      <ViewIcon icon="chat" />
      <ViewHeader>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: '100%',
            height: '100%',
            padding: '0 14px',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>WhatsappMax</span>
            <span style={{ fontSize: 11, color: C.muted }}>
              WhatsApp pour vos ventes — QR, messages, médias, IA
            </span>
          </div>
          <span style={{ flex: 1 }} />
          {status?.connected && (
            <div
              style={{
                fontSize: 11.5,
                background: `${C.accent}22`,
                color: C.accent,
                border: `1px solid ${C.accent}55`,
                borderRadius: 999,
                padding: '2px 10px',
                fontWeight: 600,
              }}
            >
              ● Connecté{status.phoneNumber ? ` · +${status.phoneNumber}` : ''}
            </div>
          )}
        </div>
      </ViewHeader>
      <ViewBody>
        {/* WS17: keyframes for the QR placeholder spinner (inline styles can't
            define @keyframes, so inject once at the page root). */}
        <style>{`@keyframes cdz-qr-spin{to{transform:rotate(360deg)}}`}</style>
        <div
          style={{
            width: '100%',
            height: '100%',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            padding: 12,
            boxSizing: 'border-box',
            gap: 10,
          }}
        >
          {dark ? (
            // Feature flag OFF (404 → quiet "bientôt")
            <div style={panelStyle}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
                WhatsappMax — bientôt disponible
              </div>
              <div style={{ fontSize: 12.5, color: C.muted }}>
                Cette fonctionnalité n'est pas encore activée sur ce serveur. Elle sera disponible prochainement.
              </div>
            </div>
          ) : !loaded ? (
            <div style={{ fontSize: 13, color: C.muted, padding: 16 }}>Chargement…</div>
          ) : (
            <>
              {/* QR pairing / connected badge */}
              <QrPairing
                status={status}
                onStatus={handleStatus}
                onDark={() => setDark(true)}
                onConnected={handleConnected}
              />
              {/* Chat app — shown only when connected */}
              {showChat && (
                <ChatApp
                  status={status}
                  onDark={() => setDark(true)}
                />
              )}
              {!showChat && !status?.connected && loaded && (
                <div style={{ ...panelStyle, background: C.surface, border: `1px dashed ${C.border}` }}>
                  <div style={{ fontSize: 12.5, color: C.muted, textAlign: 'center' }}>
                    Liez un numéro WhatsApp via QR pour accéder à la messagerie.
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </ViewBody>
    </>
  );
};

/** Router entry point — the workbench router renders this named export. */
export const Component = () => {
  return <WhatsappMaxPage />;
};
