import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { AppAccessGate } from '@affine/core/modules/studio/app-access-gate';
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

// ── Responsive helper ───────────────────────────────────────────────────────
// Local, SSR-safe hook to detect narrow viewports at an exact breakpoint.
// Not reusing the existing clickdz/mobile/useMobileDetect hook because it
// hard-codes different breakpoints (600/900) than what this page needs
// (480 / 768 / 1024).
function useIsNarrow(maxWidth: number): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [isNarrow, setIsNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const update = () => setIsNarrow(mql.matches);
    update();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update);
    } else {
      // Safari <14 fallback
      mql.addListener(update);
    }
    window.addEventListener('resize', update);
    return () => {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', update);
      } else {
        mql.removeListener(update);
      }
      window.removeEventListener('resize', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return isNarrow;
}

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

// ── Media-type display labels (i18n) ───────────────────────────────────────
const MEDIA_LABELS: Record<string, string> = {
  image: 'Image',
  video: 'Vidéo',
  audio: 'Audio',
  document: 'Document',
};

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
  connId?: string;
}

interface AccountMeta {
  connId: string;
  phoneNumber: string;
  status: string;
  connectedAt: number;
  active: boolean;
}

interface AccountsResp {
  accounts: AccountMeta[];
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
  connId: string | null;
  mode: 'first' | 'add' | 'connected';
  onAdded: (connId: string, phoneNumber?: string) => void;
}

const QrPairing = ({
  status,
  onStatus,
  onDark,
  onConnected,
  connId,
  mode,
  onAdded,
}: QrPairingProps) => {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [qrTs, setQrTs] = useState<number | null>(null);
  // WS17: QR image readiness — a 202 (not-ready) response makes the <img>
  // fire onError and show a broken-image icon before the next 2s refresh.
  // Track load state so we can show a placeholder spinner while waiting.
  const [qrLoaded, setQrLoaded] = useState(false);
  // Ref mirror of qrLoaded so the setInterval callback can read the current
  // value (setInterval captures the closure at creation time, not live state).
  const qrLoadedRef = useRef(false);
  const setQrLoadedBoth = useCallback((v: boolean) => {
    qrLoadedRef.current = v;
    setQrLoaded(v);
  }, []);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // In add-mode, /connect mints a new connId — we store it locally so the
  // status poll and QR refresh target the new connection (not the prop connId).
  const [pairConnId, setPairConnId] = useState<string | null>(null);

  const connected = status?.connected === true;
  const currentStatus = status?.status ?? '';
  const showQr =
    connecting || currentStatus === 'qr' || currentStatus === 'connecting' || currentStatus === 'created';

  // Use the locally-minted connId (add-mode) if available, else the prop connId
  const activeConnId = pairConnId ?? connId;

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
    // QR refresh: 3s while the QR hasn't loaded yet (to pick up the 202→200
    // transition quickly), then 15s once loaded (to catch WhatsApp's ~20s QR
    // regeneration without flicker). The old fixed 2s interval caused rapid
    // flicker — 10x faster than the QR TTL — making the QR hard to scan.
    setQrLoadedBoth(false);
    setQrTs(Date.now());
    let slowTick = 0;
    qrRefreshRef.current = setInterval(() => {
      if (!qrLoadedRef.current) {
        // QR not loaded yet — refresh every tick (3s) to pick it up.
        setQrTs(Date.now());
      } else {
        // QR is loaded — only refresh every 5th tick (~15s) to catch
        // WhatsApp's QR regeneration without flicker.
        slowTick++;
        if (slowTick >= 5) {
          slowTick = 0;
          setQrLoadedBoth(false);
          setQrTs(Date.now());
        }
      }
    }, 3000);

    // Status poll every 2.5s
    statusPollRef.current = setInterval(() => {
      void (async () => {
        const s = await apiGet<StatusResp>(
          `/api/v1/whatsappmax/status${activeConnId ? `?connId=${encodeURIComponent(activeConnId)}` : ''}`
        );
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
            if (mode === 'add' && pairConnId) {
              onAdded(pairConnId);
            } else {
              onConnected();
            }
          }
        }
      })();
    }, 2500);
  }, [stopPolls, onDark, onStatus, onConnected, activeConnId, mode, pairConnId, onAdded]);

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
    if (out.connId) {
      // Capture the minted connId in ALL modes (not just 'add') so the status
      // poll and QR refresh target the correct connection. In 'first' mode the
      // prop connId is null — without this, the QR image and status poll would
      // have no connId, potentially hitting the wrong backend record.
      setPairConnId(out.connId);
    }
    setConnecting(true);
    startPolls();
  }, [phone, onDark, startPolls, mode]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    const out = await apiPost<{ ok: boolean }>(
      '/api/v1/whatsappmax/disconnect',
      activeConnId ? { connId: activeConnId } : {}
    );
    setBusy(false);
    if (isDark(out)) return onDark();
    stopPolls();
    setConnecting(false);
    setQrTs(null);
    onStatus({ connected: false, status: 'disconnected' });
  }, [onDark, onStatus, stopPolls, activeConnId]);

  if (connected && mode !== 'add') {
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
              src={cdzApiUrl(`/api/v1/whatsappmax/qr.png?ts=${qrTs}${activeConnId ? `&connId=${encodeURIComponent(activeConnId)}` : ''}`)}
              alt="QR WhatsApp"
              width={256}
              height={256}
              style={{
                display: qrLoaded ? 'block' : 'none',
                borderRadius: 4,
              }}
              onLoad={() => setQrLoadedBoth(true)}
              onError={() => {
                /* 202 = not ready yet; keep refreshing. Stay on placeholder. */
                setQrLoadedBoth(false);
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
            {busy ? 'Connexion…' : mode === 'add' ? 'Lier un autre numéro' : 'Lier via QR'}
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
  connId: string | null;
}

const AiToggle = ({ chatJid, onDark, connId }: AiToggleProps) => {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!chatJid) return;
    void (async () => {
      const out = await apiGet<{ enabled: boolean }>(
        `/api/v1/whatsappmax/ai?chatJid=${encodeURIComponent(chatJid)}${connId ? `&connId=${encodeURIComponent(connId)}` : ''}`
      );
      if (isDark(out)) { onDark(); return; }
      if (out) setEnabled(out.enabled);
    })();
  }, [chatJid, onDark, connId]);

  const toggle = useCallback(async () => {
    if (enabled === null) return;
    setBusy(true);
    const next = !enabled;
    const out = await apiPost<{ ok: boolean; enabled: boolean }>(
      '/api/v1/whatsappmax/ai',
      { chatJid, enabled: next, ...(connId ? { connId } : {}) }
    );
    setBusy(false);
    if (isDark(out)) { onDark(); return; }
    if (out) setEnabled(out.enabled);
  }, [enabled, chatJid, onDark, connId]);

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
  connId: string | null;
}

// Fetches media bytes lazily (on first play/open) and hands back a blob URL.
// Shared by the audio/video lazy-load paths and the image lightbox below.
function useLazyMediaBlob(messageId: string, connId: string | null) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  const load = useCallback(async () => {
    if (blobUrlRef.current || loading) return blobUrlRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(
        cdzApiUrl(
          `/api/v1/whatsappmax/media?messageId=${encodeURIComponent(messageId)}${connId ? `&connId=${encodeURIComponent(connId)}` : ''}`
        ),
        { credentials: 'include' }
      );
      if (!res.ok) {
        setFailed(true);
        setLoading(false);
        return null;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      setBlobUrl(url);
      setLoading(false);
      return url;
    } catch {
      setFailed(true);
      setLoading(false);
      return null;
    }
  }, [messageId, connId, loading]);

  return { blobUrl, loading, failed, load };
}

// Full-size image lightbox — dark backdrop, click-outside/Échap to close.
function ImageLightbox({
  src,
  onClose,
}: {
  src: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 12,
        zIndex: 10000,
        padding: 16,
        boxSizing: 'border-box',
      }}
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <img
        src={src}
        alt="image"
        style={{
          maxWidth: '92vw',
          maxHeight: '80vh',
          borderRadius: 8,
          objectFit: 'contain',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        }}
      />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <a
          href={src}
          download
          style={{
            color: '#fff',
            fontSize: 12.5,
            fontWeight: 600,
            background: 'rgba(255,255,255,0.12)',
            padding: '6px 14px',
            borderRadius: 8,
            textDecoration: 'none',
          }}
        >
          Télécharger
        </a>
        <button
          type="button"
          onClick={onClose}
          style={{
            color: '#fff',
            fontSize: 12.5,
            fontWeight: 600,
            background: 'rgba(255,255,255,0.12)',
            border: 'none',
            padding: '6px 14px',
            borderRadius: 8,
            cursor: 'pointer',
          }}
        >
          Fermer
        </button>
      </div>
    </div>
  );
}

const MediaBubble = ({ messageId, type, fromMe, connId }: MediaBubbleProps) => {
  const mediaUrl = cdzApiUrl(
    `/api/v1/whatsappmax/media?messageId=${encodeURIComponent(messageId)}${connId ? `&connId=${encodeURIComponent(connId)}` : ''}`
  );
  const textColor = fromMe ? '#0b1f14' : C.text;
  const mutedColor = fromMe ? '#1a4a2e' : C.muted;

  const [lightboxOpen, setLightboxOpen] = useState(false);
  const audioLazy = useLazyMediaBlob(messageId, connId);
  const videoLazy = useLazyMediaBlob(messageId, connId);

  if (type === 'imageMessage' || type === 'stickerMessage') {
    return (
      <>
        <img
          src={mediaUrl}
          alt="image"
          onClick={() => setLightboxOpen(true)}
          style={{
            maxWidth: 240,
            maxHeight: 240,
            borderRadius: 8,
            display: 'block',
            objectFit: 'cover',
            cursor: 'pointer',
          }}
          onError={e => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
        {lightboxOpen && (
          <ImageLightbox src={mediaUrl} onClose={() => setLightboxOpen(false)} />
        )}
      </>
    );
  }
  if (type === 'videoMessage') {
    if (videoLazy.failed) {
      return <span style={{ fontSize: 12, color: mutedColor }}>Média indisponible</span>;
    }
    if (!videoLazy.blobUrl) {
      return (
        <button
          type="button"
          onClick={() => void videoLazy.load()}
          disabled={videoLazy.loading}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: fromMe ? 'rgba(0,0,0,0.08)' : C.bg,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: '10px 14px',
            cursor: videoLazy.loading ? 'wait' : 'pointer',
            color: textColor,
            fontSize: 12.5,
            fontWeight: 600,
          }}
        >
          {videoLazy.loading ? '⏳ Chargement…' : '▶ Lire la vidéo'}
        </button>
      );
    }
    return (
      <video
        src={videoLazy.blobUrl}
        controls
        preload="none"
        autoPlay
        style={{ maxWidth: 280, borderRadius: 8, display: 'block' }}
      />
    );
  }
  if (type === 'audioMessage') {
    if (audioLazy.failed) {
      return <span style={{ fontSize: 12, color: mutedColor }}>Média indisponible</span>;
    }
    if (!audioLazy.blobUrl) {
      return (
        <button
          type="button"
          onClick={() => void audioLazy.load()}
          disabled={audioLazy.loading}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: fromMe ? 'rgba(0,0,0,0.08)' : C.bg,
            border: `1px solid ${C.border}`,
            borderRadius: 999,
            padding: '7px 14px',
            cursor: audioLazy.loading ? 'wait' : 'pointer',
            color: textColor,
            fontSize: 12.5,
            fontWeight: 600,
          }}
        >
          {audioLazy.loading ? '⏳ Chargement…' : '▶ Écouter la note vocale'}
        </button>
      );
    }
    return (
      <audio
        src={audioLazy.blobUrl}
        controls
        preload="none"
        autoPlay
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

// ── Voice recorder helper ───────────────────────────────────────────────────
// Wraps navigator.mediaDevices.getUserMedia + MediaRecorder. Prefers
// 'audio/webm;codecs=opus'; falls back to the browser default mimeType when
// unsupported (e.g. Safari). Callers get a base64 payload ready for the
// existing sendMedia (base64) path.
function useVoiceRecorder() {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [permError, setPermError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mimeTypeRef = useRef('audio/webm');

  const stopTracks = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  useEffect(() => stopTracks, [stopTracks]);

  const start = useCallback(async () => {
    setPermError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const preferred = 'audio/webm;codecs=opus';
      const mimeType =
        typeof MediaRecorder !== 'undefined' &&
        MediaRecorder.isTypeSupported &&
        MediaRecorder.isTypeSupported(preferred)
          ? preferred
          : '';
      mimeTypeRef.current = mimeType || 'audio/webm';
      const rec = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = e => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorderRef.current = rec;
      rec.start();
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setRecording(true);
      tickRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current);
      }, 250);
    } catch {
      setPermError(
        "Micro inaccessible — vérifiez l'autorisation d'enregistrement audio."
      );
      stopTracks();
    }
  }, [stopTracks]);

  const cancel = useCallback(() => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null;
      rec.stop();
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    stopTracks();
    setRecording(false);
    setElapsedMs(0);
  }, [stopTracks]);

  // Resolves with the recorded blob (or null if nothing was captured).
  const stopAndGetBlob = useCallback((): Promise<Blob | null> => {
    return new Promise(resolve => {
      const rec = mediaRecorderRef.current;
      if (!rec || rec.state === 'inactive') {
        resolve(null);
        return;
      }
      rec.onstop = () => {
        const blob =
          chunksRef.current.length > 0
            ? new Blob(chunksRef.current, { type: mimeTypeRef.current })
            : null;
        chunksRef.current = [];
        stopTracks();
        setRecording(false);
        setElapsedMs(0);
        resolve(blob);
      };
      rec.stop();
    });
  }, [stopTracks]);

  return { recording, elapsedMs, permError, start, cancel, stopAndGetBlob };
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('read_failed'));
        return;
      }
      // Strip the data: URL prefix — backend expects raw base64.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsDataURL(blob);
  });
}

// ── AI Assist popover ───────────────────────────────────────────────────────

interface AiAssistProps {
  chatJid: string;
  connId: string | null;
  onDark: () => void;
  onDraft: (text: string) => void;
  onOverlay: (title: string, body: string) => void;
  isNarrow: boolean;
  disabled?: boolean;
}

type AiAction = 'draft' | 'summary' | 'translate' | null;

const AiAssist = ({ chatJid, connId, onDark, onDraft, onOverlay, isNarrow, disabled = false }: AiAssistProps) => {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [acting, setActing] = useState<AiAction>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(
    async (action: Exclude<AiAction, null>) => {
      setActing(action);
      setErr(null);
      const path = `/api/v1/whatsappmax/ai/${action}`;
      const body: Record<string, unknown> = { chatJid, ...(connId ? { connId } : {}) };
      if (action === 'draft' && instruction.trim()) body.instruction = instruction.trim();
      const out = await apiPost<
        | { ok: true; draft?: string; summary?: string; translation?: string; original?: string }
        | { ok: false; error?: string }
      >(path, body);
      setActing(null);
      if (isDark(out)) { onDark(); return; }
      if (!out || !(out as { ok?: boolean }).ok) {
        setErr('Service IA indisponible — réessayez.');
        return;
      }
      if (action === 'draft') {
        const draft = (out as { draft?: string }).draft ?? '';
        if (draft) {
          onDraft(draft);
          setOpen(false);
        } else {
          setErr('Service IA indisponible — réessayez.');
        }
      } else if (action === 'summary') {
        const summary = (out as { summary?: string }).summary ?? '';
        onOverlay('Résumé de la conversation', summary || 'Aucun résumé disponible.');
        setOpen(false);
      } else if (action === 'translate') {
        const translation = (out as { translation?: string }).translation ?? '';
        onOverlay('Traduction du dernier message', translation || 'Aucune traduction disponible.');
        setOpen(false);
      }
    },
    [chatJid, connId, instruction, onDark, onDraft, onOverlay]
  );

  return (
    <div style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <button
        type="button"
        style={{
          ...btn('ghost', disabled),
          padding: '8px 10px',
          minWidth: 40,
          minHeight: 40,
          fontSize: 12.5,
          fontWeight: 700,
          border: `1px solid ${open ? C.accent : C.border}`,
          color: open ? C.accent : C.text,
          borderRadius: 8,
          flexShrink: 0,
        }}
        title="Assistant IA"
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
      >
        ✨ IA
      </button>
      {open && !disabled && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setOpen(false)}
          />
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              right: 0,
              marginBottom: 6,
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              padding: 10,
              width: isNarrow ? 'min(88vw, 300px)' : 280,
              maxWidth: '100%',
              zIndex: 9999,
              boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              boxSizing: 'border-box',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>
              Assistant IA
            </div>
            <input
              style={{ ...inputStyle, fontSize: 12 }}
              value={instruction}
              placeholder="Consigne… (optionnel)"
              onChange={(e: ChangeEvent<HTMLInputElement>) => setInstruction(e.target.value)}
            />
            <button
              type="button"
              style={{ ...btn('secondary', acting !== null), width: '100%', fontSize: 12, textAlign: 'left' }}
              disabled={acting !== null}
              onClick={() => void run('draft')}
            >
              {acting === 'draft' ? '⏳ Rédaction…' : '✍️ Rédiger une réponse'}
            </button>
            <button
              type="button"
              style={{ ...btn('secondary', acting !== null), width: '100%', fontSize: 12, textAlign: 'left' }}
              disabled={acting !== null}
              onClick={() => void run('summary')}
            >
              {acting === 'summary' ? '⏳ Résumé…' : '🧾 Résumer la conversation'}
            </button>
            <button
              type="button"
              style={{ ...btn('secondary', acting !== null), width: '100%', fontSize: 12, textAlign: 'left' }}
              disabled={acting !== null}
              onClick={() => void run('translate')}
            >
              {acting === 'translate' ? '⏳ Traduction…' : '🌐 Traduire le dernier message'}
            </button>
            {err ? <div style={{ fontSize: 11.5, color: C.danger }}>{err}</div> : null}
          </div>
        </>
      )}
    </div>
  );
};

// ── Composer ──────────────────────────────────────────────────────────────

interface ComposerProps {
  chatJid: string;
  connected: boolean;
  onDark: () => void;
  onSent: (msg: MessageRow) => void;
  connId: string | null;
}

const Composer = ({ chatJid, connected, onDark, onSent, connId }: ComposerProps) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showMedia, setShowMedia] = useState(false);
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaKind, setMediaKind] = useState<'image' | 'video' | 'audio' | 'document'>('image');
  const [mediaCaption, setMediaCaption] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [aiOverlay, setAiOverlay] = useState<{ title: string; body: string } | null>(null);
  const [aiCopied, setAiCopied] = useState(false);
  const voice = useVoiceRecorder();
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const isNarrowComposer = useIsNarrow(768);

  const sendText = useCallback(async () => {
    const body = text.trim();
    if (!body || busy || !connected) return;
    setBusy(true);
    setErr(null);
    const out = await apiPost<{ ok: boolean; sent: boolean; note?: string }>(
      '/api/v1/whatsappmax/send',
      { to: chatJid, text: body, ...(connId ? { connId } : {}) }
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
  }, [text, busy, connected, chatJid, onDark, onSent, connId]);

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
        ...(connId ? { connId } : {}),
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
  }, [mediaUrl, mediaKind, mediaCaption, busy, connected, chatJid, onDark, connId]);

  // Sends a locally-recorded voice note through the SAME sendMedia endpoint
  // used above, but via the base64 field (there's no URL for a local
  // recording) — matches the backend's { to, kind, base64, fileName,
  // mimetype, connId } contract exactly.
  const sendVoiceNote = useCallback(
    async (blob: Blob) => {
      setVoiceBusy(true);
      setVoiceErr(null);
      try {
        const base64 = await blobToBase64(blob);
        const fileName = `note-vocale-${Date.now()}.webm`;
        const out = await apiPost<{ ok: boolean; messageId?: string; note?: string }>(
          '/api/v1/whatsappmax/sendMedia',
          {
            to: chatJid,
            kind: 'audio',
            base64,
            fileName,
            mimetype: blob.type || 'audio/webm',
            ...(connId ? { connId } : {}),
          }
        );
        setVoiceBusy(false);
        if (isDark(out)) { onDark(); return; }
        if (!out || !out.ok || (out as { note?: string }).note) {
          setVoiceErr(
            (out as { note?: string })?.note === 'not_connected'
              ? 'Liez un numéro WhatsApp d\'abord.'
              : "Envoi de la note vocale échoué."
          );
        }
      } catch {
        setVoiceBusy(false);
        setVoiceErr("Envoi de la note vocale échoué.");
      }
    },
    [chatJid, connId, onDark]
  );

  const handleVoiceSend = useCallback(async () => {
    const blob = await voice.stopAndGetBlob();
    if (blob) void sendVoiceNote(blob);
  }, [voice, sendVoiceNote]);

  const handleAiDraft = useCallback((draft: string) => {
    setText(draft);
  }, []);

  const handleAiOverlay = useCallback((title: string, body: string) => {
    setAiCopied(false);
    setAiOverlay({ title, body });
  }, []);

  const copyOverlay = useCallback(() => {
    if (!aiOverlay) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(aiOverlay.body)
        .then(() => setAiCopied(true))
        .catch(() => setAiCopied(false));
    }
  }, [aiOverlay]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendText();
    }
  };

  const disabled = !connected || busy;
  const aiDisabled = !connected || !chatJid;

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
      {/* AI overlay — summary/translation results, dismissible */}
      {aiOverlay && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '10px 12px',
            background: C.surface,
            borderRadius: 8,
            border: `1px solid ${C.accent}55`,
            maxWidth: '100%',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>{aiOverlay.title}</span>
            <button
              type="button"
              style={{ background: 'none', border: 'none', color: C.muted, fontSize: 14, cursor: 'pointer', padding: 2 }}
              onClick={() => setAiOverlay(null)}
              aria-label="Fermer"
            >
              ✕
            </button>
          </div>
          <div style={{ fontSize: 12.5, color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {aiOverlay.body}
          </div>
          <div>
            <button
              type="button"
              style={{ ...btn('secondary', false), fontSize: 11.5, padding: '4px 10px' }}
              onClick={copyOverlay}
            >
              {aiCopied ? 'Copié ✓' : 'Copier'}
            </button>
          </div>
        </div>
      )}
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
                {MEDIA_LABELS[k] ?? k}
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
      {/* Voice recorder bar — replaces the text row while recording */}
      {voice.recording ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            background: C.surface,
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            flexWrap: 'wrap' as const,
            maxWidth: '100%',
            boxSizing: 'border-box',
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: C.danger,
              flexShrink: 0,
              animation: 'cdz-rec-pulse 1s ease-in-out infinite',
            }}
          />
          <span style={{ fontSize: 12.5, color: C.text, fontWeight: 600, flexShrink: 0 }}>
            {formatElapsed(voice.elapsedMs)}
          </span>
          <span style={{ fontSize: 11.5, color: C.muted, flex: 1, minWidth: 60 }}>
            Enregistrement de la note vocale…
          </span>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              style={{ ...btn('ghost', voiceBusy), fontSize: 11.5, padding: '5px 10px' }}
              disabled={voiceBusy}
              onClick={() => voice.cancel()}
            >
              Annuler
            </button>
            <button
              type="button"
              style={{ ...btn('primary', voiceBusy), fontSize: 11.5, padding: '5px 10px' }}
              disabled={voiceBusy}
              onClick={() => void handleVoiceSend()}
            >
              {voiceBusy ? 'Envoi…' : 'Envoyer'}
            </button>
          </div>
        </div>
      ) : null}
      {err ? <div style={{ fontSize: 12, color: C.danger }}>{err}</div> : null}
      {voice.permError ? <div style={{ fontSize: 12, color: C.danger }}>{voice.permError}</div> : null}
      {voiceErr ? <div style={{ fontSize: 12, color: C.danger }}>{voiceErr}</div> : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' as const, maxWidth: '100%' }}>
        <button
          style={{
            ...btn('ghost', disabled),
            padding: '8px',
            minWidth: 40,
            minHeight: 40,
            fontSize: 18,
            lineHeight: 1,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            flexShrink: 0,
          }}
          title="Joindre un média"
          disabled={disabled || voice.recording}
          onClick={() => setShowMedia(v => !v)}
        >
          📎
        </button>
        <button
          style={{
            ...btn('ghost', disabled),
            padding: '8px',
            minWidth: 40,
            minHeight: 40,
            fontSize: 18,
            lineHeight: 1,
            border: `1px solid ${voice.recording ? C.danger : C.border}`,
            color: voice.recording ? C.danger : C.text,
            borderRadius: 8,
            flexShrink: 0,
          }}
          title={voice.recording ? 'Enregistrement en cours' : 'Enregistrer une note vocale'}
          disabled={disabled && !voice.recording}
          onClick={() => {
            if (!voice.recording) void voice.start();
          }}
        >
          🎙️
        </button>
        {chatJid ? (
          <AiAssist
            chatJid={chatJid}
            connId={connId}
            onDark={onDark}
            onDraft={handleAiDraft}
            onOverlay={handleAiOverlay}
            isNarrow={isNarrowComposer}
            disabled={aiDisabled || voice.recording}
          />
        ) : null}
        <textarea
          ref={textareaRef}
          style={{
            ...inputStyle,
            flex: 1,
            minWidth: isNarrowComposer ? '100%' : 120,
            minHeight: 38,
            maxHeight: 120,
            resize: 'none',
            lineHeight: 1.5,
          }}
          value={text}
          disabled={disabled || voice.recording}
          placeholder={connected ? 'Votre message… (Entrée pour envoyer)' : 'Liez un numéro pour écrire…'}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          style={{
            ...btn('primary', !text.trim() || disabled || voice.recording),
            padding: '9px 16px',
            minWidth: 40,
            minHeight: 40,
            fontSize: 14,
            flexShrink: 0,
          }}
          disabled={!text.trim() || disabled || voice.recording}
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
  connId: string | null;
  showBack?: boolean;
}

const Conversation = ({
  chatJid,
  chatName,
  isGroup,
  connected,
  onDark,
  onClose,
  connId,
  showBack = false,
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
    void apiPost('/api/v1/whatsappmax/read', { chatJid, ...(connId ? { connId } : {}) });
  }, [chatJid, connId]);

  const fetchMessages = useCallback(
    async (opts?: { before?: number; prepend?: boolean }) => {
      if (opts?.prepend) setLoadingOlder(true);
      else setLoading(true);

      const params = new URLSearchParams({ chatJid, limit: '50' });
      if (opts?.before) params.set('before', String(opts.before));
      if (connId) params.set('connId', connId);

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
    [chatJid, onDark, connId]
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
  }, [chatJid, connId]);

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
            fontSize: 20,
            cursor: 'pointer',
            padding: '8px',
            minWidth: 40,
            minHeight: 40,
            borderRadius: 6,
            display: showBack ? 'flex' : 'none',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          type="button"
          aria-label="Retour à la liste des conversations"
          title="Retour"
          onClick={onClose}
        >
          ← <span style={{ marginLeft: 4, fontSize: 13 }}>Retour</span>
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
        <AiToggle chatJid={chatJid} onDark={onDark} connId={connId} />
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
                        <MediaBubble messageId={m.id} type={m.type ?? ''} fromMe={m.fromMe} connId={connId} />
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
                      <MediaBubble messageId={m.id} type={m.type ?? ''} fromMe={m.fromMe} connId={connId} />
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
        connId={connId}
      />
    </div>
  );
};

// ── Chat list (left pane) ──────────────────────────────────────────────────

interface ChatListProps {
  active: string | null;
  onSelect: (jid: string, name: string, isGroup: boolean) => void;
  onDark: () => void;
  connId: string | null;
}

const ChatList = ({ active, onSelect, onDark, connId }: ChatListProps) => {
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
    const out = await apiGet<{ chats: ChatRow[] }>(
      `/api/v1/whatsappmax/chats${connId ? `?connId=${encodeURIComponent(connId)}` : ''}`
    );
    if (!mountedRef.current) return;
    setLoading(false);
    if (isDark(out)) { onDark(); return; }
    if (out === null) { setChatError(true); return; }
    if (out && Array.isArray(out.chats)) setChats(out.chats);
  }, [onDark, connId]);

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
  }, [connId]);

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
  connId: string | null;
}

const BroadcastModal = ({ onDark, onClose, connId }: BroadcastModalProps) => {
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
      { to: recipients, text: body, ...(connId ? { connId } : {}) }
    );
    setBusy(false);
    if (isDark(out)) { onDark(); return; }
    if (out) {
      setNote(`Diffusion : ${out.sent}/${out.total} envoyés${out.failed ? `, ${out.failed} échoués` : ''}.`);
    } else {
      setNote('Diffusion échouée.');
    }
  }, [to, text, onDark, connId]);

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

// ── Account switcher ───────────────────────────────────────────────────────

interface AccountSwitcherProps {
  accounts: AccountMeta[];
  selectedConnId: string | null;
  onSelect: (connId: string) => void;
  onAdd: () => void;
}

const AccountSwitcher = ({
  accounts,
  selectedConnId,
  onSelect,
  onAdd,
}: AccountSwitcherProps) => {
  const [open, setOpen] = useState(false);
  const selected = accounts.find(a => a.connId === selectedConnId);
  const label = selected
    ? `+${selected.phoneNumber}`
    : accounts.length > 0
      ? 'Aucun compte'
      : 'Aucun compte';
  const dotColor = (status: string) =>
    status === 'connected' ? C.accent : status === 'qr' || status === 'connecting' ? C.orange : C.muted;

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        style={{
          ...btn('secondary', false),
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
        }}
        onClick={() => setOpen(v => !v)}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: selected ? dotColor(selected.status) : C.muted,
            flexShrink: 0,
          }}
        />
        {label}
        <span style={{ fontSize: 10, color: C.muted }}>▾</span>
      </button>
      {open && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setOpen(false)}
          />
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 4,
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              padding: 6,
              minWidth: 220,
              zIndex: 9999,
              boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {accounts.map(a => (
              <button
                key={a.connId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: 'none',
                  background: a.connId === selectedConnId ? `${C.accent}18` : 'transparent',
                  color: C.text,
                  fontSize: 12.5,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onClick={() => { onSelect(a.connId); setOpen(false); }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: dotColor(a.status),
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1 }}>+{a.phoneNumber}</span>
                {a.status === 'connected' ? (
                  <span style={{ fontSize: 10, color: C.accent, fontWeight: 600 }}>Connecté</span>
                ) : (
                  <span style={{ fontSize: 10, color: C.muted }}>Inconnu</span>
                )}
              </button>
            ))}
            <div style={{ borderTop: `1px solid ${C.border}`, margin: '4px 0' }} />
            <button
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: C.accent,
                fontSize: 12.5,
                cursor: 'pointer',
                textAlign: 'left',
                fontWeight: 600,
              }}
              onClick={() => { onAdd(); setOpen(false); }}
            >
              + Lier un autre numéro
            </button>
          </div>
        </>
      )}
    </div>
  );
};

// ── Chat app (two-pane) ────────────────────────────────────────────────────

interface ChatAppProps {
  status: StatusResp | null;
  onDark: () => void;
  connId: string | null;
}

const ChatApp = ({ status, onDark, connId }: ChatAppProps) => {
  const [activeJid, setActiveJid] = useState<string | null>(null);
  const [activeName, setActiveName] = useState('');
  const [activeIsGroup, setActiveIsGroup] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const connected = status?.connected === true;

  // Below 768px: never show list + conversation side by side — show one or
  // the other, with a back control to return to the list. Between 768 and
  // 1024px (tablet), keep both panes but shrink the list pane so nothing
  // overflows horizontally.
  const isPhone = useIsNarrow(768);
  const isTablet = useIsNarrow(1024);

  const selectChat = useCallback((jid: string, name: string, isGroup: boolean) => {
    setActiveJid(jid);
    setActiveName(name);
    setActiveIsGroup(isGroup);
  }, []);

  const closeChat = useCallback(() => setActiveJid(null), []);

  // On phones, show only one pane at a time.
  const showListPane = !isPhone || !activeJid;
  const showConversationPane = !isPhone || !!activeJid;

  const listPaneStyle: CSSProperties = isPhone
    ? {
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }
    : {
        width: isTablet ? '38%' : 300,
        minWidth: isTablet ? 180 : 220,
        maxWidth: isTablet ? 260 : 320,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden',
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        background: C.bg,
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      {/* Left pane — chat list */}
      {showListPane && (
        <div style={listPaneStyle}>
          <ChatList active={activeJid} onSelect={selectChat} onDark={onDark} connId={connId} />
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
              style={{ ...btn('secondary', false), width: '100%', fontSize: 11.5, minHeight: 40 }}
              onClick={() => setShowBroadcast(true)}
            >
              📢 Diffusion
            </button>
          </div>
        </div>
      )}

      {/* Right pane — conversation */}
      {showConversationPane && (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            minWidth: 0,
            maxWidth: '100%',
          }}
        >
          {activeJid ? (
            <Conversation
              chatJid={activeJid}
              chatName={activeName}
              isGroup={activeIsGroup}
              connected={connected}
              onDark={onDark}
              onClose={closeChat}
              connId={connId}
              showBack={isPhone}
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
                padding: 16,
                boxSizing: 'border-box',
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
      )}

      {showBroadcast && (
        <BroadcastModal onDark={onDark} onClose={() => setShowBroadcast(false)} connId={connId} />
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
  const [accounts, setAccounts] = useState<AccountMeta[]>([]);
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [showAddMode, setShowAddMode] = useState(false);

  useEffect(() => {
    void (async () => {
      const out = await apiGet<AccountsResp>('/api/v1/whatsappmax/accounts');
      if (isDark(out)) {
        setDark(true);
      } else if (out && Array.isArray(out.accounts)) {
        setAccounts(out.accounts);
        // Auto-select first connected account, or first account
        const firstConnected = out.accounts.find(a => a.status === 'connected');
        const first = firstConnected ?? out.accounts[0];
        if (first) {
          setSelectedConnId(first.connId);
          setStatus({
            connected: first.status === 'connected',
            phoneNumber: first.phoneNumber,
            status: first.status,
            connectedAt: first.connectedAt,
          });
          if (first.status === 'connected') setShowChat(true);
        }
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
    setShowAddMode(false);
  }, []);

  const handleSelectAccount = useCallback(
    (connId: string) => {
      setSelectedConnId(connId);
      const acct = accounts.find(a => a.connId === connId);
      if (acct) {
        setStatus({
          connected: acct.status === 'connected',
          phoneNumber: acct.phoneNumber,
          status: acct.status,
          connectedAt: acct.connectedAt,
        });
        if (acct.status === 'connected') {
          setShowChat(true);
          setShowAddMode(false);
        } else {
          setShowChat(false);
        }
      }
    },
    [accounts]
  );

  const handleAdded = useCallback(
    (newConnId: string) => {
      // Refresh accounts list, select the new one, hide QR
      void (async () => {
        const out = await apiGet<AccountsResp>('/api/v1/whatsappmax/accounts');
        if (isDark(out)) {
          setDark(true);
          return;
        }
        if (out && Array.isArray(out.accounts)) {
          setAccounts(out.accounts);
          const added = out.accounts.find(a => a.connId === newConnId);
          if (added) {
            setSelectedConnId(added.connId);
            setStatus({
              connected: added.status === 'connected',
              phoneNumber: added.phoneNumber,
              status: added.status,
              connectedAt: added.connectedAt,
            });
            if (added.status === 'connected') setShowChat(true);
          } else {
            // Fallback: select it by ID even if not in the list yet
            setSelectedConnId(newConnId);
          }
        }
        setShowAddMode(false);
      })();
    },
    []
  );

  const handleAdd = useCallback(() => {
    setShowAddMode(true);
  }, []);

  // Determine QrPairing mode
  const qrMode: 'first' | 'add' | 'connected' =
    showAddMode
      ? 'add'
      : status?.connected
        ? 'connected'
        : 'first';

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
            maxWidth: '100%',
            height: '100%',
            padding: '0 14px',
            boxSizing: 'border-box',
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollbarWidth: 'none' as CSSProperties['scrollbarWidth'],
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0, flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.text, whiteSpace: 'nowrap' }}>WhatsappMax</span>
            <span
              style={{
                fontSize: 11,
                color: C.muted,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 220,
              }}
            >
              WhatsApp pour vos ventes — QR, messages, médias, IA
            </span>
          </div>
          <span style={{ flex: 1, minWidth: 8 }} />
          {/* Account switcher — visible when accounts are loaded */}
          {accounts.length > 0 && !showAddMode && (
            <AccountSwitcher
              accounts={accounts}
              selectedConnId={selectedConnId}
              onSelect={handleSelectAccount}
              onAdd={handleAdd}
            />
          )}
          {status?.connected && !showAddMode && (
            <div
              style={{
                fontSize: 11.5,
                background: `${C.accent}22`,
                color: C.accent,
                border: `1px solid ${C.accent}55`,
                borderRadius: 999,
                padding: '2px 10px',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              ● Connecté{status.phoneNumber ? ` · +${status.phoneNumber}` : ''}
            </div>
          )}
        </div>
      </ViewHeader>
      <ViewBody>
        <AppAccessGate app="WHATSAPPMAX">
        {/* WS17: keyframes for the QR placeholder spinner (inline styles can't
            define @keyframes, so inject once at the page root).
            cdz-rec-pulse: red dot pulse for the voice-note recorder bar. */}
        <style>{`@keyframes cdz-qr-spin{to{transform:rotate(360deg)}}@keyframes cdz-rec-pulse{0%,100%{opacity:1}50%{opacity:0.25}}`}</style>
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
              {/* QR pairing / connected badge / add-mode */}
              <QrPairing
                status={status}
                onStatus={handleStatus}
                onDark={() => setDark(true)}
                onConnected={handleConnected}
                connId={selectedConnId}
                mode={qrMode}
                onAdded={handleAdded}
              />
              {/* Chat app — shown only when connected (not in add-mode) */}
              {showChat && !showAddMode && (
                <ChatApp
                  status={status}
                  onDark={() => setDark(true)}
                  connId={selectedConnId}
                />
              )}
              {!showChat && !status?.connected && loaded && !showAddMode && (
                <div style={{ ...panelStyle, background: C.surface, border: `1px dashed ${C.border}` }}>
                  <div style={{ fontSize: 12.5, color: C.muted, textAlign: 'center' }}>
                    Liez un numéro WhatsApp via QR pour accéder à la messagerie.
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        </AppAccessGate>
      </ViewBody>
    </>
  );
};

/** Router entry point — the workbench router renders this named export. */
export const Component = () => {
  return <WhatsappMaxPage />;
};
