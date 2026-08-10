import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { AppAccessGate } from '@affine/core/modules/studio/app-access-gate';
import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useTheme } from 'next-themes';
import {
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
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
// WS14 — WhatsApp Max Studio (MAXP — the premium design pass).
//
// Two-pane WhatsApp-style chat app wired to the P4 E1 backend routes:
//   · QR Pairing screen: scannable QR image via GET /qr.png, polls status.
//   · Chat list: GET /chats (now enriched: last_text/last_type/unread), search,
//     filter chips (all/unread/groups), real profile photos via GET /avatar.
//   · Conversation: GET /messages, WhatsApp-grade bubbles (grouping, tails,
//     RTL via dir=auto, theme-aware palettes), in-chat search, load-older.
//   · Composer: text, media (URL or LOCAL FILE via base64), voice notes,
//     quick-reply templates, AI assist (draft/summary/translate).
//   · AI settings (per shop): persona, tone, language, auto-reply default,
//     quick replies — GET/POST /settings.
//   · New chat: GET /contacts + POST /check. Broadcast. Multi-account.
//
// Route contract: /agent/workspace/fixes/p4e1.md (+ WS-MAXP additions)
// Inline styles + no new npm deps + French copy (matches existing conventions).
// ---------------------------------------------------------------------------

// ── Media-type display labels (i18n) ───────────────────────────────────────
const MEDIA_LABELS: Record<string, string> = {
  image: 'Image',
  video: 'Vidéo',
  audio: 'Audio',
  document: 'Document',
};

// Chat-list preview label for a media message type.
const PREVIEW_LABELS: Record<string, string> = {
  imageMessage: '📷 Photo',
  videoMessage: '🎥 Vidéo',
  audioMessage: '🎤 Note vocale',
  documentMessage: '📎 Document',
  stickerMessage: '🎟️ Sticker',
};

// ── Design tokens ──────────────────────────────────────────────────────────

const C = {
  bg: 'var(--affine-background-primary-color, #0f1115)',
  panel: 'var(--affine-background-secondary-color, #171a21)',
  surface: 'var(--affine-background-tertiary-color, #1e2330)',
  border: 'var(--affine-border-color, #262a35)',
  text: 'var(--affine-text-primary-color, #e6e9f0)',
  muted: 'var(--affine-text-secondary-color, #8a90a0)',
  hover: 'var(--affine-hover-color, rgba(134,150,160,0.12))',
  accent: '#25D366', // WhatsApp green
  accentDark: '#128C7E',
  danger: '#ef4444',
  blue: '#3b82f6',
  orange: '#f59e0b',
};

// Theme-aware WhatsApp chat palette (bubbles, wallpaper, ticks). The rest of
// the chrome keeps the app's CSS variables; ONLY the conversation surface
// switches to the signature WhatsApp look.
interface WaPalette {
  chatBg: string;
  chatPattern: string;
  out: string;
  outText: string;
  outMuted: string;
  inn: string;
  innText: string;
  innMuted: string;
  dayPillBg: string;
  dayPillText: string;
  tick: string;
  groupName: string;
  bubbleShadow: string;
}

function waColors(dark: boolean): WaPalette {
  return dark
    ? {
        chatBg: '#0b141a',
        chatPattern:
          'radial-gradient(rgba(255,255,255,0.045) 1px, transparent 1.2px)',
        out: '#005c4b',
        outText: '#e9edef',
        outMuted: 'rgba(233,237,239,0.62)',
        inn: '#202c33',
        innText: '#e9edef',
        innMuted: 'rgba(233,237,239,0.58)',
        dayPillBg: 'rgba(24,34,40,0.95)',
        dayPillText: '#8696a0',
        tick: '#8696a0',
        groupName: '#25d366',
        bubbleShadow: '0 1px 1px rgba(0,0,0,0.25)',
      }
    : {
        chatBg: '#efeae2',
        chatPattern:
          'radial-gradient(rgba(0,0,0,0.05) 1px, transparent 1.2px)',
        out: '#d9fdd3',
        outText: '#111b21',
        outMuted: 'rgba(17,27,33,0.55)',
        inn: '#ffffff',
        innText: '#111b21',
        innMuted: 'rgba(17,27,33,0.5)',
        dayPillBg: 'rgba(255,255,255,0.96)',
        dayPillText: '#54656f',
        tick: '#667781',
        groupName: '#128c7e',
        bubbleShadow: '0 1px 1px rgba(11,20,26,0.13)',
      };
}

/** Resolved app theme → dark flag (defaults dark while unresolved). */
function useWaDark(): boolean {
  const { resolvedTheme } = useTheme();
  return resolvedTheme !== 'light';
}

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

/** Circular 40px icon button used across the composer + headers. */
function circleBtn(disabled: boolean, size = 40): CSSProperties {
  return {
    width: size,
    height: size,
    minWidth: size,
    minHeight: size,
    borderRadius: '50%',
    border: 'none',
    background: 'transparent',
    color: C.muted,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: Math.round(size * 0.48),
    lineHeight: 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    flexShrink: 0,
    padding: 0,
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
  push_name?: string;
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
  // WS-MAXP enrichment (backend /chats):
  last_text?: string | null;
  last_type?: string | null;
  last_from_me?: boolean;
}

interface ContactRow {
  jid?: string;
  name?: string;
  phone?: string;
  pushName?: string;
  notify?: string;
  is_group?: boolean;
}

// WS-MAXP — per-connection AI settings (mirror of the backend record).
interface WamaxAiSettings {
  businessName: string;
  persona: string;
  tone: string;
  language: string;
  autoReplyDefault: boolean;
  quickReplies: string[];
}

const DEFAULT_AI_SETTINGS: WamaxAiSettings = {
  businessName: '',
  persona: '',
  tone: 'pro',
  language: 'auto',
  autoReplyDefault: false,
  quickReplies: [],
};

// ── Field normalization (E1 snake_case + camelCase aliases) ────────────────

function normalizeMessage(raw: MessageRow): Required<Pick<MessageRow, 'id' | 'text' | 'fromMe' | 'timestamp' | 'type' | 'pushName' | 'is_group' | 'chatJid'>> & MessageRow {
  return {
    ...raw,
    id: raw.id ?? raw.message_id ?? String(Math.random()),
    text: raw.text ?? raw.text_body ?? '',
    fromMe: raw.fromMe ?? raw.from_me ?? false,
    timestamp: raw.timestamp ?? raw.ts ?? 0,
    type: raw.type ?? 'conversation',
    pushName: raw.pushName ?? raw.push_name ?? '',
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

/** Pretty-print a bare MSISDN: 213553303158 → +213 553 30 31 58. */
function formatPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = String(raw).replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('213') && digits.length >= 11) {
    const rest = digits.slice(3);
    const parts: string[] = [rest.slice(0, 3)];
    for (let i = 3; i < rest.length; i += 2) parts.push(rest.slice(i, i + 2));
    return `+213 ${parts.filter(Boolean).join(' ')}`;
  }
  // Generic international grouping.
  const groups = digits.match(/^(\d{1,3})(\d{2,3})?(\d{2,3})?(\d{2,3})?(\d+)?$/);
  if (!groups) return `+${digits}`;
  return `+${groups.slice(1).filter(Boolean).join(' ')}`;
}

/** True when the string looks like a bare number / JID rather than a name. */
function looksLikePhone(name: string): boolean {
  return /^[+\d][\d\s@.\-]*$/.test(name.trim());
}

/** Chat-list preview line for a chat row (enriched or not). */
function chatPreview(c: ChatRow): string {
  const t = typeof c.last_type === 'string' ? c.last_type : '';
  if (t && PREVIEW_LABELS[t]) return PREVIEW_LABELS[t];
  const text = typeof c.last_text === 'string' ? c.last_text.trim() : '';
  if (text) return text;
  if (t && t !== 'conversation' && t !== 'extendedTextMessage') return 'Message';
  return '';
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

function tsMs(ts: number | string | undefined): number {
  if (ts === undefined || ts === null) return 0;
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
  const n = d.getTime();
  return Number.isFinite(n) ? n : 0;
}

// ── Avatars — initials fallback + REAL profile photos ──────────────────────

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
        background: `linear-gradient(135deg, hsl(${hue},48%,46%), hsl(${(hue + 42) % 360},52%,32%))`,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.36,
        fontWeight: 700,
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {letters || '?'}
    </div>
  );
}

// Module-level avatar cache + tiny fetch queue (max 3 in flight) so a 30-chat
// list doesn't stampede the backend/gateway. Backend adds a 12h Redis cache on
// top, so after first load this is effectively free.
const avatarCache = new Map<string, string | null>();
let avatarInflight = 0;
const avatarQueue: Array<() => void> = [];

function pumpAvatarQueue(): void {
  while (avatarInflight < 3 && avatarQueue.length > 0) {
    const job = avatarQueue.shift();
    if (job) job();
  }
}

function useAvatarUrl(jid: string | null, connId: string | null): string | null {
  const key = jid ? `${connId ?? ''}:${jid}` : '';
  const [url, setUrl] = useState<string | null>(() =>
    key && avatarCache.has(key) ? (avatarCache.get(key) ?? null) : null
  );

  useEffect(() => {
    if (!jid || !key) return;
    if (avatarCache.has(key)) {
      setUrl(avatarCache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    const job = () => {
      avatarInflight++;
      void (async () => {
        const out = await apiGet<{ url?: string | null }>(
          `/api/v1/whatsappmax/avatar?jid=${encodeURIComponent(jid)}${connId ? `&connId=${encodeURIComponent(connId)}` : ''}`
        );
        avatarInflight--;
        const u =
          !out || isDark(out)
            ? null
            : typeof out.url === 'string' && out.url
              ? out.url
              : null;
        avatarCache.set(key, u);
        if (!cancelled) setUrl(u);
        pumpAvatarQueue();
      })();
    };
    avatarQueue.push(job);
    pumpAvatarQueue();
    return () => {
      cancelled = true;
    };
  }, [key, jid, connId]);

  return url;
}

/** Real profile photo when available; gradient initials otherwise. */
function Avatar({
  name,
  jid,
  connId,
  size = 44,
}: {
  name: string;
  jid?: string | null;
  connId?: string | null;
  size?: number;
}): ReactElement {
  const url = useAvatarUrl(jid ?? null, connId ?? null);
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          flexShrink: 0,
          display: 'block',
          background: C.surface,
        }}
      />
    );
  }
  return <Initials name={name} size={size} />;
}

// ── Anchored popover (position: FIXED — immune to overflow clipping) ───────
// The old absolute-positioned popovers got clipped by the overflow:hidden
// panes (the "narrow sliver" AI popover bug). This renders at the viewport
// level: backdrop + panel + caret, anchored to a button rect, clamped to the
// viewport, ESC to close, repositioned on resize/scroll.

interface AnchoredPopoverProps {
  anchorRef: RefObject<HTMLElement | null> | MutableRefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  width: number;
  children: ReactNode;
  direction?: 'up' | 'down';
  sheetOnNarrow?: boolean;
  maxHeight?: number | string;
}

const AnchoredPopover = ({
  anchorRef,
  open,
  onClose,
  width,
  children,
  direction = 'up',
  sheetOnNarrow = true,
  maxHeight,
}: AnchoredPopoverProps) => {
  const isNarrow = useIsNarrow(520);
  const [pos, setPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
    arrowX: number;
  } | null>(null);

  const compute = useCallback(() => {
    const el = anchorRef.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const sheet = isNarrow && sheetOnNarrow;
    const w = sheet ? vw - 24 : Math.min(width, vw - 24);
    let left = sheet ? 12 : r.right - w;
    left = Math.min(Math.max(12, left), Math.max(12, vw - w - 12));
    const arrowX = Math.min(
      Math.max(r.left + r.width / 2 - left - 6, 16),
      w - 28
    );
    if (direction === 'up') {
      setPos({
        left,
        bottom: Math.max(8, window.innerHeight - r.top + 10),
        width: w,
        arrowX,
      });
    } else {
      setPos({ left, top: r.bottom + 10, width: w, arrowX });
    }
  }, [anchorRef, width, isNarrow, sheetOnNarrow, direction]);

  useEffect(() => {
    if (!open) return;
    compute();
    const on = () => compute();
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('scroll', on, true);
    };
  }, [open, compute]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !pos) return null;

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
        onClick={onClose}
      />
      <div
        style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          bottom: pos.bottom,
          width: pos.width,
          zIndex: 9999,
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          boxShadow: '0 16px 48px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)',
          animation: 'cdz-pop-in 0.16s ease',
          maxHeight: maxHeight ?? '72vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        {children}
      </div>
      {/* Caret — a sibling (not a child) so the panel's overflow:hidden cannot clip it. */}
      <div
        style={{
          position: 'fixed',
          left: pos.left + pos.arrowX,
          ...(direction === 'up'
            ? { bottom: (pos.bottom ?? 0) - 6 }
            : { top: (pos.top ?? 0) - 6 }),
          width: 12,
          height: 12,
          background: C.panel,
          borderRight: direction === 'up' ? `1px solid ${C.border}` : 'none',
          borderBottom: direction === 'up' ? `1px solid ${C.border}` : 'none',
          borderLeft: direction === 'down' ? `1px solid ${C.border}` : 'none',
          borderTop: direction === 'down' ? `1px solid ${C.border}` : 'none',
          transform: 'rotate(45deg)',
          zIndex: 9999,
        }}
      />
    </>
  );
};

// ── QR Pairing screen ──────────────────────────────────────────────────────

interface QrPairingProps {
  status: StatusResp | null;
  onStatus: (s: StatusResp) => void;
  onDark: () => void;
  onConnected: () => void;
  connId: string | null;
  mode: 'first' | 'add' | 'connected';
  onAdded: (connId: string, phoneNumber?: string) => void;
  onCancelAdd?: () => void;
}

const QrPairing = ({
  status,
  onStatus,
  onDark,
  onConnected,
  connId,
  mode,
  onAdded,
  onCancelAdd,
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

  // MAXP: the "Connecté + Déconnecter" banner moved into the header's account
  // switcher — a connected state renders NOTHING here so the chat gets the
  // full height of the page.
  if (connected && mode !== 'add') {
    return null;
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
    <div
      style={{
        ...panelStyle,
        alignItems: 'center',
        padding: '28px 24px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Subtle brand glow */}
      <div
        style={{
          position: 'absolute',
          top: -120,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 420,
          height: 220,
          background: `radial-gradient(ellipse at center, ${C.accent}1f, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />
      {mode === 'add' && onCancelAdd ? (
        <button
          type="button"
          onClick={onCancelAdd}
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            background: 'transparent',
            border: 'none',
            color: C.muted,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            padding: '6px 10px',
            borderRadius: 8,
          }}
        >
          ← Retour
        </button>
      ) : null}
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 16,
          background: `linear-gradient(135deg, ${C.accent}, ${C.accentDark})`,
          display: 'grid',
          placeItems: 'center',
          marginBottom: 10,
          boxShadow: `0 8px 24px ${C.accent}44`,
        }}
      >
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
          <path
            fill="#fff"
            d="M12 3.2c-4.9 0-8.8 3.7-8.8 8.3 0 1.6.5 3.1 1.3 4.4L3.3 20l4.3-1.1c1.3.7 2.8 1.1 4.4 1.1 4.9 0 8.8-3.7 8.8-8.4S16.9 3.2 12 3.2zm4.4 11.6c-.2.6-1.1 1.1-1.6 1.1-.4.1-.9.1-1.5-.1-.3-.1-.8-.3-1.4-.5-2.4-1-3.9-3.4-4-3.6-.1-.2-1-1.3-1-2.5s.6-1.8.9-2c.2-.3.5-.3.7-.3h.5c.2 0 .4-.1.6.4l.8 2c.1.1.1.3 0 .5l-.3.5-.4.5c-.1.1-.3.3-.1.5.1.3.6 1 1.3 1.6.9.8 1.6 1.1 1.9 1.2.2.1.4.1.5-.1l.7-.9c.2-.2.3-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.2z"
          />
        </svg>
      </div>
      <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginBottom: 4, letterSpacing: 0.2 }}>
        {mode === 'add' ? 'Lier un autre numéro' : 'Lier WhatsApp via QR'}
      </div>
      <div style={{ fontSize: 12.5, color: C.muted, textAlign: 'center', maxWidth: 400, marginBottom: 14, lineHeight: 1.6 }}>
        Ouvrez WhatsApp sur votre téléphone → <strong style={{ color: C.text }}>Appareils liés</strong> →{' '}
        <strong style={{ color: C.text }}>Lier un appareil</strong> → scannez le code QR.
      </div>

      {showQr && qrTs ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              background: '#fff',
              borderRadius: 16,
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
                    borderTopColor: '#25D366',
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
            style={{ ...inputStyle, textAlign: 'center', borderRadius: 10, padding: '10px 12px' }}
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
            style={{
              ...btn('primary', busy),
              padding: '11px 30px',
              fontSize: 14,
              borderRadius: 999,
              boxShadow: `0 6px 18px ${C.accent}55`,
            }}
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
  const [source, setSource] = useState<'chat' | 'default'>('chat');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!chatJid) return;
    void (async () => {
      const out = await apiGet<{ enabled: boolean; source?: 'chat' | 'default' }>(
        `/api/v1/whatsappmax/ai?chatJid=${encodeURIComponent(chatJid)}${connId ? `&connId=${encodeURIComponent(connId)}` : ''}`
      );
      if (isDark(out)) { onDark(); return; }
      if (out) {
        setEnabled(out.enabled);
        setSource(out.source === 'default' ? 'default' : 'chat');
      }
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
    if (out) {
      setEnabled(out.enabled);
      setSource('chat');
    }
  }, [enabled, chatJid, onDark, connId]);

  if (enabled === null) return null;

  return (
    <button
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 10px 5px 12px',
        borderRadius: 999,
        border: `1px solid ${enabled ? `${C.accent}88` : C.border}`,
        background: enabled ? `${C.accent}1c` : 'transparent',
        color: enabled ? C.accent : C.muted,
        fontSize: 11.5,
        fontWeight: 700,
        cursor: busy ? 'wait' : 'pointer',
        opacity: busy ? 0.7 : 1,
        whiteSpace: 'nowrap',
      }}
      disabled={busy}
      title={
        enabled
          ? source === 'default'
            ? "Réponses IA automatiques actives (réglage par défaut de la boutique) — cliquez pour désactiver sur cette conversation"
            : "Réponses IA automatiques actives — cliquez pour désactiver sur cette conversation"
          : "Réponses IA automatiques désactivées — cliquez pour activer sur cette conversation"
      }
      onClick={() => void toggle()}
    >
      <span style={{ fontSize: 13, lineHeight: 1 }}>🤖</span>
      IA auto
      {/* Mini switch */}
      <span
        style={{
          width: 26,
          height: 15,
          borderRadius: 999,
          background: enabled ? C.accent : C.border,
          position: 'relative',
          display: 'inline-block',
          transition: 'background 0.15s ease',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: enabled ? 13 : 2,
            width: 11,
            height: 11,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 0.15s ease',
            boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
          }}
        />
      </span>
    </button>
  );
};

// ── Media bubble ───────────────────────────────────────────────────────────

interface MediaBubbleProps {
  messageId: string;
  type: string;
  fromMe: boolean;
  connId: string | null;
  wa: WaPalette;
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
        background: 'rgba(0,0,0,0.88)',
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
            padding: '7px 16px',
            borderRadius: 999,
            textDecoration: 'none',
          }}
        >
          ⬇ Télécharger
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
            padding: '7px 16px',
            borderRadius: 999,
            cursor: 'pointer',
          }}
        >
          Fermer
        </button>
      </div>
    </div>
  );
}

const MediaBubble = ({ messageId, type, fromMe, connId, wa }: MediaBubbleProps) => {
  const mediaUrl = cdzApiUrl(
    `/api/v1/whatsappmax/media?messageId=${encodeURIComponent(messageId)}${connId ? `&connId=${encodeURIComponent(connId)}` : ''}`
  );
  const textColor = fromMe ? wa.outText : wa.innText;
  const mutedColor = fromMe ? wa.outMuted : wa.innMuted;

  const [lightboxOpen, setLightboxOpen] = useState(false);
  const audioLazy = useLazyMediaBlob(messageId, connId);
  const videoLazy = useLazyMediaBlob(messageId, connId);

  const playChip: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: 'rgba(0,0,0,0.14)',
    border: 'none',
    borderRadius: 999,
    padding: '8px 16px 8px 8px',
    color: textColor,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  };
  const playDot: CSSProperties = {
    width: 30,
    height: 30,
    borderRadius: '50%',
    background: C.accent,
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    fontSize: 13,
    flexShrink: 0,
  };

  if (type === 'imageMessage' || type === 'stickerMessage') {
    return (
      <>
        <img
          src={mediaUrl}
          alt="image"
          onClick={() => setLightboxOpen(true)}
          style={{
            maxWidth: 260,
            maxHeight: 280,
            borderRadius: 10,
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
          style={{ ...playChip, cursor: videoLazy.loading ? 'wait' : 'pointer' }}
        >
          <span style={playDot}>{videoLazy.loading ? '…' : '▶'}</span>
          {videoLazy.loading ? 'Chargement…' : 'Lire la vidéo'}
        </button>
      );
    }
    return (
      <video
        src={videoLazy.blobUrl}
        controls
        preload="none"
        autoPlay
        style={{ maxWidth: 280, borderRadius: 10, display: 'block' }}
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
          style={{ ...playChip, cursor: audioLazy.loading ? 'wait' : 'pointer' }}
        >
          <span style={playDot}>{audioLazy.loading ? '…' : '▶'}</span>
          {audioLazy.loading ? 'Chargement…' : 'Note vocale'}
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
        style={{ color: textColor, fontSize: 12.5, fontWeight: 600, textDecoration: 'underline' }}
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

/** Light cleanup of LLM markdown for plain-text surfaces (the AI overlay):
 * strips bold markers and turns leading "*"/"-" bullets into "•". */
function stripMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\s*[*-]\s+/gm, '• ');
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

// ── AI Assist popover (MAXP redesign) ───────────────────────────────────────
// The old absolute-positioned popover was clipped into a narrow sliver by the
// overflow:hidden panes. This version renders through AnchoredPopover
// (position:fixed, viewport-clamped, caret-anchored to the ✨ button) with a
// proper header, a full-width instruction field and spacious action rows.

interface AiAssistProps {
  chatJid: string;
  connId: string | null;
  onDark: () => void;
  onDraft: (text: string) => void;
  onOverlay: (title: string, body: string) => void;
  onOpenSettings?: () => void;
  disabled?: boolean;
}

type AiAction = 'draft' | 'summary' | 'translate' | null;

const AI_ACTIONS: Array<{
  key: Exclude<AiAction, null>;
  icon: string;
  iconBg: string;
  title: string;
  desc: string;
  loading: string;
}> = [
  {
    key: 'draft',
    icon: '✍️',
    iconBg: 'linear-gradient(135deg, #25D366, #128C7E)',
    title: 'Rédiger une réponse',
    desc: 'Propose un message prêt à envoyer',
    loading: 'Rédaction en cours…',
  },
  {
    key: 'summary',
    icon: '🧾',
    iconBg: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
    title: 'Résumer la conversation',
    desc: 'Points clés + actions à faire',
    loading: 'Résumé en cours…',
  },
  {
    key: 'translate',
    icon: '🌐',
    iconBg: 'linear-gradient(135deg, #f59e0b, #d97706)',
    title: 'Traduire le dernier message',
    desc: 'Darija / arabe / français / anglais',
    loading: 'Traduction en cours…',
  },
];

const AiAssist = ({
  chatJid,
  connId,
  onDark,
  onDraft,
  onOverlay,
  onOpenSettings,
  disabled = false,
}: AiAssistProps) => {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [acting, setActing] = useState<AiAction>(null);
  const [err, setErr] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

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
    <>
      <button
        ref={btnRef}
        type="button"
        style={{
          ...circleBtn(disabled),
          fontSize: 17,
          background: open
            ? `linear-gradient(135deg, ${C.accent}33, ${C.accentDark}33)`
            : 'transparent',
          color: open ? C.accent : C.muted,
          border: open ? `1px solid ${C.accent}66` : '1px solid transparent',
        }}
        title="Assistant IA — rédiger, résumer, traduire"
        aria-label="Assistant IA"
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
      >
        ✨
      </button>
      <AnchoredPopover
        anchorRef={btnRef}
        open={open && !disabled}
        onClose={close}
        width={372}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 14px 10px',
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 11,
              background: `linear-gradient(135deg, ${C.accent}, ${C.accentDark})`,
              display: 'grid',
              placeItems: 'center',
              fontSize: 17,
              flexShrink: 0,
              boxShadow: `0 4px 12px ${C.accent}44`,
            }}
          >
            ✨
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: C.text, letterSpacing: 0.1 }}>
              Assistant IA
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>
              Utilise le contexte de la conversation
            </div>
          </div>
          {onOpenSettings ? (
            <button
              type="button"
              style={{ ...circleBtn(false, 30), fontSize: 14 }}
              title="Réglages IA de la boutique"
              aria-label="Réglages IA"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              ⚙️
            </button>
          ) : null}
          <button
            type="button"
            style={{ ...circleBtn(false, 30), fontSize: 14 }}
            aria-label="Fermer"
            onClick={close}
          >
            ✕
          </button>
        </div>

        {/* Instruction field */}
        <div style={{ padding: '0 14px 10px' }}>
          <textarea
            value={instruction}
            rows={2}
            dir="auto"
            maxLength={2000}
            placeholder="Consigne pour l’IA (optionnel) — ex. « propose une livraison demain et demande l’adresse »"
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setInstruction(e.target.value)}
            style={{
              ...inputStyle,
              fontSize: 12.5,
              lineHeight: 1.5,
              resize: 'none',
              borderRadius: 10,
              padding: '9px 11px',
              background: C.surface,
            }}
          />
        </div>

        {/* Action rows */}
        <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {AI_ACTIONS.map(a => {
            const isActing = acting === a.key;
            const rowDisabled = acting !== null;
            return (
              <button
                key={a.key}
                type="button"
                disabled={rowDisabled}
                onClick={() => void run(a.key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 10px',
                  borderRadius: 10,
                  border: 'none',
                  background: isActing ? `${C.accent}14` : 'transparent',
                  cursor: rowDisabled ? 'wait' : 'pointer',
                  textAlign: 'left',
                  width: '100%',
                  opacity: rowDisabled && !isActing ? 0.5 : 1,
                }}
                onMouseEnter={e => {
                  if (!rowDisabled) (e.currentTarget as HTMLButtonElement).style.background = C.hover;
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = isActing ? `${C.accent}14` : 'transparent';
                }}
              >
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    background: a.iconBg,
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 15,
                    flexShrink: 0,
                  }}
                >
                  {isActing ? (
                    <span
                      style={{
                        width: 15,
                        height: 15,
                        borderRadius: '50%',
                        border: '2px solid rgba(255,255,255,0.4)',
                        borderTopColor: '#fff',
                        animation: 'cdz-qr-spin 0.7s linear infinite',
                        display: 'inline-block',
                      }}
                    />
                  ) : (
                    a.icon
                  )}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: C.text }}>
                    {isActing ? a.loading : a.title}
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: C.muted, marginTop: 1 }}>
                    {a.desc}
                  </span>
                </span>
                <span style={{ color: C.muted, fontSize: 13, flexShrink: 0 }}>›</span>
              </button>
            );
          })}
        </div>

        {err ? (
          <div style={{ padding: '0 14px 10px', fontSize: 11.5, color: C.danger }}>{err}</div>
        ) : null}

        {/* Footer hint */}
        <div
          style={{
            padding: '9px 14px',
            borderTop: `1px solid ${C.border}`,
            fontSize: 10.5,
            color: C.muted,
            lineHeight: 1.5,
            background: C.surface,
          }}
        >
          « Rédiger » remplit votre champ de saisie — rien n’est envoyé sans votre accord.
        </div>
      </AnchoredPopover>
    </>
  );
};

// ── Quick replies popover (⚡ templates from the AI settings) ───────────────

interface QuickRepliesProps {
  replies: string[];
  onPick: (text: string) => void;
  onOpenSettings?: () => void;
  disabled?: boolean;
}

const QuickReplies = ({ replies, onPick, onOpenSettings, disabled = false }: QuickRepliesProps) => {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        style={{
          ...circleBtn(disabled),
          fontSize: 17,
          color: open ? C.orange : C.muted,
          background: open ? `${C.orange}1a` : 'transparent',
          border: '1px solid transparent',
        }}
        title="Réponses rapides"
        aria-label="Réponses rapides"
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
      >
        ⚡
      </button>
      <AnchoredPopover
        anchorRef={btnRef}
        open={open && !disabled}
        onClose={() => setOpen(false)}
        width={330}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 14px 8px',
          }}
        >
          <span style={{ fontSize: 13.5, fontWeight: 800, color: C.text, flex: 1 }}>
            ⚡ Réponses rapides
          </span>
          {onOpenSettings ? (
            <button
              type="button"
              style={{ ...circleBtn(false, 28), fontSize: 13 }}
              title="Gérer les réponses rapides"
              aria-label="Gérer"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              ⚙️
            </button>
          ) : null}
        </div>
        {replies.length === 0 ? (
          <div style={{ padding: '4px 14px 14px', fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
            Aucune réponse rapide pour le moment.
            {onOpenSettings ? (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpenSettings();
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: C.accent,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  Ajoutez vos modèles dans les Réglages IA →
                </button>
              </>
            ) : null}
          </div>
        ) : (
          <div style={{ padding: '0 8px 10px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {replies.map((r, i) => (
              <button
                key={`${i}_${r.slice(0, 12)}`}
                type="button"
                onClick={() => {
                  onPick(r);
                  setOpen(false);
                }}
                dir="auto"
                style={{
                  textAlign: 'start',
                  padding: '9px 11px',
                  borderRadius: 9,
                  border: 'none',
                  background: 'transparent',
                  color: C.text,
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  cursor: 'pointer',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical' as const,
                  overflow: 'hidden',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = C.hover;
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                }}
              >
                {r}
              </button>
            ))}
          </div>
        )}
      </AnchoredPopover>
    </>
  );
};

// ── Composer ──────────────────────────────────────────────────────────────

interface ComposerProps {
  chatJid: string;
  connected: boolean;
  onDark: () => void;
  onSent: (msg: MessageRow) => void;
  connId: string | null;
  quickReplies: string[];
  onOpenSettings?: () => void;
}

const MAX_UPLOAD_BYTES = 9 * 1024 * 1024; // backend caps ~10MB decoded

const Composer = ({
  chatJid,
  connected,
  onDark,
  onSent,
  connId,
  quickReplies,
  onOpenSettings,
}: ComposerProps) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showMedia, setShowMedia] = useState(false);
  const [mediaTab, setMediaTab] = useState<'file' | 'url'>('file');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaKind, setMediaKind] = useState<'image' | 'video' | 'audio' | 'document'>('image');
  const [mediaCaption, setMediaCaption] = useState('');
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [aiOverlay, setAiOverlay] = useState<{ title: string; body: string } | null>(null);
  const [aiCopied, setAiCopied] = useState(false);
  const voice = useVoiceRecorder();
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);

  // Auto-grow the textarea (pill) up to ~5 lines.
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 130)}px`;
  }, []);
  useEffect(() => {
    autoGrow();
  }, [text, autoGrow]);

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
      textareaRef.current?.focus();
    } else {
      setErr(out?.note === 'not_connected' ? 'Liez un numéro WhatsApp d’abord.' : 'Envoi échoué.');
    }
  }, [text, busy, connected, chatJid, onDark, onSent, connId]);

  const sendMediaUrl = useCallback(async () => {
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
          ? 'Liez un numéro WhatsApp d’abord.'
          : 'Envoi du média échoué.'
      );
    }
  }, [mediaUrl, mediaKind, mediaCaption, busy, connected, chatJid, onDark, connId]);

  // MAXP — send a LOCAL file through the same sendMedia endpoint via base64
  // (kind auto-detected from the mimetype). Surfaces the previously URL-only
  // attachment path as a real "pick a file" affordance.
  const sendPickedFile = useCallback(async () => {
    const file = pickedFile;
    if (!file || busy || !connected) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setErr('Fichier trop volumineux (max 9 Mo).');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const base64 = await blobToBase64(file);
      const mime = file.type || '';
      const kind = mime.startsWith('image/')
        ? 'image'
        : mime.startsWith('video/')
          ? 'video'
          : mime.startsWith('audio/')
            ? 'audio'
            : 'document';
      const out = await apiPost<{ ok: boolean; messageId?: string; note?: string }>(
        '/api/v1/whatsappmax/sendMedia',
        {
          to: chatJid,
          kind,
          base64,
          fileName: file.name,
          mimetype: mime || undefined,
          caption: mediaCaption.trim() || undefined,
          ...(connId ? { connId } : {}),
        }
      );
      setBusy(false);
      if (isDark(out)) { onDark(); return; }
      if (out && out.ok && !(out as { note?: string }).note) {
        setPickedFile(null);
        setMediaCaption('');
        setShowMedia(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else {
        setErr(
          (out as { note?: string })?.note === 'not_connected'
            ? 'Liez un numéro WhatsApp d’abord.'
            : 'Envoi du fichier échoué.'
        );
      }
    } catch {
      setBusy(false);
      setErr('Lecture du fichier impossible.');
    }
  }, [pickedFile, busy, connected, chatJid, mediaCaption, connId, onDark]);

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
              ? 'Liez un numéro WhatsApp d’abord.'
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
    textareaRef.current?.focus();
  }, []);

  const handleAiOverlay = useCallback((title: string, body: string) => {
    setAiCopied(false);
    // Sanitize once here — Copier / Insérer then reuse the cleaned text.
    setAiOverlay({ title, body: stripMd(body) });
  }, []);

  const handleQuickReply = useCallback((t: string) => {
    setText(prev => (prev.trim() ? `${prev} ${t}` : t));
    textareaRef.current?.focus();
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

  const insertOverlay = useCallback(() => {
    if (!aiOverlay) return;
    setText(aiOverlay.body);
    setAiOverlay(null);
    textareaRef.current?.focus();
  }, [aiOverlay]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendText();
    }
  };

  const disabled = !connected || busy;
  const aiDisabled = !connected || !chatJid;
  const hasText = text.trim().length > 0;
  const overlayInsertable = !!aiOverlay && aiOverlay.title.startsWith('Traduction');

  return (
    <div
      style={{
        borderTop: `1px solid ${C.border}`,
        padding: '8px 12px 10px',
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
            padding: '11px 13px',
            background: C.surface,
            borderRadius: 12,
            border: `1px solid ${C.accent}55`,
            maxWidth: '100%',
            boxSizing: 'border-box',
            boxShadow: `0 4px 16px rgba(0,0,0,0.18)`,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: C.accent }}>✨ {aiOverlay.title}</span>
            <button
              type="button"
              style={{ background: 'none', border: 'none', color: C.muted, fontSize: 14, cursor: 'pointer', padding: 2 }}
              onClick={() => setAiOverlay(null)}
              aria-label="Fermer"
            >
              ✕
            </button>
          </div>
          <div
            dir="auto"
            style={{
              fontSize: 12.5,
              color: C.text,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.6,
              maxHeight: 180,
              overflowY: 'auto',
            }}
          >
            {aiOverlay.body}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={{ ...btn('secondary', false), fontSize: 11.5, padding: '4px 12px', borderRadius: 999 }}
              onClick={copyOverlay}
            >
              {aiCopied ? 'Copié ✓' : 'Copier'}
            </button>
            {overlayInsertable ? (
              <button
                type="button"
                style={{ ...btn('primary', false), fontSize: 11.5, padding: '4px 12px', borderRadius: 999 }}
                onClick={insertOverlay}
              >
                Insérer dans le message
              </button>
            ) : null}
          </div>
        </div>
      )}

      {/* Attachment panel — local file (default) or URL */}
      {showMedia && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '12px 13px',
            background: C.surface,
            borderRadius: 12,
            border: `1px solid ${C.border}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: C.text, flex: 1 }}>
              Joindre un média
            </span>
            {(['file', 'url'] as const).map(t => (
              <button
                key={t}
                type="button"
                style={{
                  ...btn('ghost', false),
                  padding: '3px 12px',
                  fontSize: 11.5,
                  borderRadius: 999,
                  border: `1px solid ${mediaTab === t ? C.accent : C.border}`,
                  color: mediaTab === t ? C.accent : C.muted,
                  background: mediaTab === t ? `${C.accent}14` : 'transparent',
                }}
                onClick={() => setMediaTab(t)}
              >
                {t === 'file' ? 'Fichier' : 'Lien URL'}
              </button>
            ))}
          </div>

          {mediaTab === 'file' ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                style={{ display: 'none' }}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const f = e.target.files?.[0] ?? null;
                  setErr(null);
                  if (f && f.size > MAX_UPLOAD_BYTES) {
                    setErr('Fichier trop volumineux (max 9 Mo).');
                    setPickedFile(null);
                    e.target.value = '';
                    return;
                  }
                  setPickedFile(f);
                }}
              />
              {pickedFile ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 10,
                    background: C.bg,
                    border: `1px solid ${C.border}`,
                  }}
                >
                  <span style={{ fontSize: 18 }}>
                    {pickedFile.type.startsWith('image/')
                      ? '🖼️'
                      : pickedFile.type.startsWith('video/')
                        ? '🎥'
                        : pickedFile.type.startsWith('audio/')
                          ? '🎵'
                          : '📄'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {pickedFile.name}
                    </div>
                    <div style={{ fontSize: 10.5, color: C.muted }}>
                      {(pickedFile.size / (1024 * 1024)).toFixed(2)} Mo
                    </div>
                  </div>
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: C.muted, fontSize: 13, cursor: 'pointer' }}
                    aria-label="Retirer le fichier"
                    onClick={() => {
                      setPickedFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  style={{
                    border: `1.5px dashed ${C.border}`,
                    borderRadius: 10,
                    padding: '16px 12px',
                    background: 'transparent',
                    color: C.muted,
                    fontSize: 12.5,
                    cursor: 'pointer',
                    textAlign: 'center',
                  }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  📁 Choisir un fichier (photo, vidéo, audio, document — max 9 Mo)
                </button>
              )}
              <input
                style={{ ...inputStyle, borderRadius: 10 }}
                value={mediaCaption}
                placeholder="Légende (optionnel)"
                dir="auto"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setMediaCaption(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  style={{ ...btn('primary', disabled || !pickedFile), borderRadius: 999 }}
                  disabled={disabled || !pickedFile}
                  onClick={() => void sendPickedFile()}
                >
                  {busy ? 'Envoi…' : 'Envoyer le fichier'}
                </button>
                <button style={{ ...btn('ghost', false), borderRadius: 999 }} onClick={() => setShowMedia(false)}>
                  Annuler
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
                {(['image', 'video', 'audio', 'document'] as const).map(k => (
                  <button
                    key={k}
                    style={{
                      ...btn('ghost', false),
                      background: mediaKind === k ? `${C.accent}14` : 'transparent',
                      border: `1px solid ${mediaKind === k ? C.accent : C.border}`,
                      color: mediaKind === k ? C.accent : C.muted,
                      padding: '3px 10px',
                      fontSize: 11.5,
                      borderRadius: 999,
                    }}
                    onClick={() => setMediaKind(k)}
                  >
                    {MEDIA_LABELS[k] ?? k}
                  </button>
                ))}
              </div>
              <input
                style={{ ...inputStyle, borderRadius: 10 }}
                value={mediaUrl}
                placeholder="URL du média (https://…)"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setMediaUrl(e.target.value)}
              />
              <input
                style={{ ...inputStyle, borderRadius: 10 }}
                value={mediaCaption}
                placeholder="Légende (optionnel)"
                dir="auto"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setMediaCaption(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  style={{ ...btn('primary', disabled || !mediaUrl.trim()), borderRadius: 999 }}
                  disabled={disabled || !mediaUrl.trim()}
                  onClick={() => void sendMediaUrl()}
                >
                  {busy ? 'Envoi…' : 'Envoyer le média'}
                </button>
                <button style={{ ...btn('ghost', false), borderRadius: 999 }} onClick={() => setShowMedia(false)}>
                  Annuler
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {err ? <div style={{ fontSize: 12, color: C.danger }}>{err}</div> : null}
      {voice.permError ? <div style={{ fontSize: 12, color: C.danger }}>{voice.permError}</div> : null}
      {voiceErr ? <div style={{ fontSize: 12, color: C.danger }}>{voiceErr}</div> : null}

      {/* Voice recorder bar — replaces the input row while recording */}
      {voice.recording ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 10px 8px 16px',
            background: C.surface,
            borderRadius: 999,
            border: `1px solid ${C.danger}55`,
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
          <span style={{ fontSize: 13, color: C.text, fontWeight: 700, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
            {formatElapsed(voice.elapsedMs)}
          </span>
          <span style={{ fontSize: 11.5, color: C.muted, flex: 1, minWidth: 40, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Enregistrement…
          </span>
          <button
            type="button"
            style={{ ...btn('ghost', voiceBusy), fontSize: 11.5, padding: '6px 14px', borderRadius: 999 }}
            disabled={voiceBusy}
            onClick={() => voice.cancel()}
          >
            Annuler
          </button>
          <button
            type="button"
            style={{
              width: 42,
              height: 42,
              borderRadius: '50%',
              border: 'none',
              background: C.accent,
              color: '#fff',
              fontSize: 17,
              cursor: voiceBusy ? 'wait' : 'pointer',
              opacity: voiceBusy ? 0.7 : 1,
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
              boxShadow: `0 4px 12px ${C.accent}55`,
            }}
            aria-label="Envoyer la note vocale"
            disabled={voiceBusy}
            onClick={() => void handleVoiceSend()}
          >
            {voiceBusy ? '…' : '➤'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', maxWidth: '100%' }}>
          <button
            style={{
              ...circleBtn(disabled),
              fontSize: 22,
              color: showMedia ? C.accent : C.muted,
              transform: showMedia ? 'rotate(45deg)' : 'none',
              transition: 'transform 0.15s ease, color 0.15s ease',
            }}
            title="Joindre un média"
            aria-label="Joindre un média"
            disabled={disabled}
            onClick={() => setShowMedia(v => !v)}
          >
            ＋
          </button>
          <QuickReplies
            replies={quickReplies}
            onPick={handleQuickReply}
            onOpenSettings={onOpenSettings}
            disabled={aiDisabled}
          />
          {chatJid ? (
            <AiAssist
              chatJid={chatJid}
              connId={connId}
              onDark={onDark}
              onDraft={handleAiDraft}
              onOverlay={handleAiOverlay}
              onOpenSettings={onOpenSettings}
              disabled={aiDisabled}
            />
          ) : null}
          <div
            style={{
              flex: 1,
              minWidth: 60,
              background: C.surface,
              borderRadius: 22,
              border: `1px solid ${C.border}`,
              padding: '7px 16px',
              display: 'flex',
              alignItems: 'center',
              boxSizing: 'border-box',
            }}
          >
            <textarea
              ref={textareaRef}
              dir="auto"
              rows={1}
              style={{
                flex: 1,
                width: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: C.text,
                fontSize: 13.5,
                lineHeight: 1.5,
                resize: 'none',
                fontFamily: 'inherit',
                maxHeight: 130,
                padding: 0,
              }}
              value={text}
              disabled={disabled}
              placeholder={connected ? 'Votre message…' : 'Liez un numéro pour écrire…'}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          {hasText ? (
            <button
              style={{
                width: 44,
                height: 44,
                minWidth: 44,
                borderRadius: '50%',
                border: 'none',
                background: C.accent,
                color: '#fff',
                fontSize: 17,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.6 : 1,
                display: 'grid',
                placeItems: 'center',
                flexShrink: 0,
                boxShadow: `0 4px 12px ${C.accent}55`,
                transition: 'transform 0.1s ease',
              }}
              aria-label="Envoyer"
              title="Envoyer (Entrée)"
              disabled={disabled}
              onClick={() => void sendText()}
            >
              ➤
            </button>
          ) : (
            <button
              style={{
                width: 44,
                height: 44,
                minWidth: 44,
                borderRadius: '50%',
                border: `1px solid ${C.border}`,
                background: 'transparent',
                color: C.muted,
                fontSize: 18,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.5 : 1,
                display: 'grid',
                placeItems: 'center',
                flexShrink: 0,
              }}
              title="Enregistrer une note vocale"
              aria-label="Enregistrer une note vocale"
              disabled={disabled}
              onClick={() => {
                if (!voice.recording) void voice.start();
              }}
            >
              🎙️
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// ── Bubble tails (WhatsApp-style SVG carets) ────────────────────────────────

const TailOut = ({ color }: { color: string }) => (
  <svg
    viewBox="0 0 8 13"
    width="8"
    height="13"
    aria-hidden="true"
    style={{ position: 'absolute', top: 0, right: -8, display: 'block' }}
  >
    <path fill={color} d="M5.188,0H0v11.193l6.467-8.625C7.526,1.156,6.958,0,5.188,0z" />
  </svg>
);

const TailIn = ({ color }: { color: string }) => (
  <svg
    viewBox="0 0 8 13"
    width="8"
    height="13"
    aria-hidden="true"
    style={{ position: 'absolute', top: 0, left: -8, display: 'block' }}
  >
    <path fill={color} d="M1.533,2.568L8,11.193V0L2.812,0C1.042,0,0.474,1.156,1.533,2.568z" />
  </svg>
);

// ── Conversation view (right pane) ─────────────────────────────────────────

interface ConversationProps {
  chatJid: string;
  chatName: string;
  chatPhone?: string;
  isGroup: boolean;
  connected: boolean;
  onDark: () => void;
  onClose: () => void;
  connId: string | null;
  showBack?: boolean;
  quickReplies: string[];
  onOpenSettings?: () => void;
}

const Conversation = ({
  chatJid,
  chatName,
  chatPhone,
  isGroup,
  connected,
  onDark,
  onClose,
  connId,
  showBack = false,
  quickReplies,
  onOpenSettings,
}: ConversationProps) => {
  const [messages, setMessages] = useState<ReturnType<typeof normalizeMessage>[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const dark = useWaDark();
  const wa = waColors(dark);
  const isPhoneView = useIsNarrow(768);

  // In-chat search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const bubbleRefs = useRef(new Map<string, HTMLDivElement>());
  const matches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as string[];
    return messages.filter(m => (m.text || '').toLowerCase().includes(q)).map(m => m.id);
  }, [messages, searchQuery]);
  const [matchIdx, setMatchIdx] = useState(0);
  useEffect(() => {
    setMatchIdx(matches.length > 0 ? matches.length - 1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);
  useEffect(() => {
    if (!searchOpen || matches.length === 0) return;
    const id = matches[Math.min(matchIdx, matches.length - 1)];
    const el = id ? bubbleRefs.current.get(id) : undefined;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [matchIdx, matches, searchOpen]);
  const currentMatchId = searchOpen && matches.length > 0 ? matches[Math.min(matchIdx, matches.length - 1)] : null;

  // Mark as read when opened
  useEffect(() => {
    void apiPost('/api/v1/whatsappmax/read', { chatJid, ...(connId ? { connId } : {}) });
  }, [chatJid, connId]);

  const fetchMessages = useCallback(
    async (opts?: { before?: string; prepend?: boolean }) => {
      if (opts?.prepend) setLoadingOlder(true);
      else setLoading(true);

      const params = new URLSearchParams({ chatJid, limit: '50' });
      if (opts?.before) params.set('before', opts.before);
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
          if (newOnes.length === 0) return prev;
          // Reconcile optimistic sends: when the REAL copy of a just-sent
          // message lands from the gateway (different id), drop the matching
          // optimistic bubble instead of rendering the same text twice.
          let base = prev;
          for (const real of newOnes) {
            if (!real.fromMe) continue;
            const realText = (real.text || '').trim();
            if (!realText) continue;
            const optIdx = base.findIndex(
              p =>
                typeof p.id === 'string' &&
                p.id.startsWith('opt_') &&
                p.fromMe &&
                (p.text || '').trim() === realText &&
                Math.abs(tsMs(real.timestamp) - tsMs(p.timestamp)) < 3 * 60_000
            );
            if (optIdx >= 0) {
              base = [...base.slice(0, optIdx), ...base.slice(optIdx + 1)];
            }
          }
          return [...base, ...newOnes.reverse()];
        });
        setHasOlder(prev => prev && normalized.length >= 50);
      }
    },
    [chatJid, onDark, connId]
  );

  // Scroll to bottom on new messages — but ONLY when the user is already at
  // (or near) the bottom, so reading history / search jumps are never yanked
  // back down by the 3s poll.
  useEffect(() => {
    if (messages.length > 0 && !loadingOlder && atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, loadingOlder]);

  // Start polling
  useEffect(() => {
    mountedRef.current = true;
    atBottomRef.current = true;
    setMessages([]);
    setHasOlder(true);
    setSearchOpen(false);
    setSearchQuery('');
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
    // MAXP fix: the gateway's `before` cursor needs an ISO date — a raw ms
    // string parses to Invalid Date server-side (the old broken path).
    const ms = tsMs(oldest.timestamp);
    if (!ms) return;
    void fetchMessages({ before: new Date(ms).toISOString(), prepend: true });
  }, [messages, hasOlder, loadingOlder, fetchMessages]);

  const onSent = useCallback((msg: MessageRow) => {
    atBottomRef.current = true;
    setMessages(prev => [...prev, normalizeMessage(msg)]);
  }, []);

  const onScrollerScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = dist < 90;
    setShowJump(dist > 480);
  }, []);

  const jumpToBottom = useCallback(() => {
    atBottomRef.current = true;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const mediaTypes = new Set([
    'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage',
  ]);

  const bubbleMax = isPhoneView ? '82%' : '65%';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: wa.chatBg,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Conversation header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderBottom: `1px solid ${C.border}`,
          background: C.panel,
          flexShrink: 0,
          minHeight: 56,
          boxSizing: 'border-box',
        }}
      >
        {showBack ? (
          <button
            style={{
              background: 'transparent',
              border: 'none',
              color: C.muted,
              fontSize: 20,
              cursor: 'pointer',
              padding: 6,
              minWidth: 36,
              minHeight: 36,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
            type="button"
            aria-label="Retour à la liste des conversations"
            title="Retour"
            onClick={onClose}
          >
            ←
          </button>
        ) : null}
        <Avatar name={chatName} jid={chatJid} connId={connId} size={38} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            dir="auto"
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: C.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: 'start',
            }}
          >
            {looksLikePhone(chatName) ? formatPhone(chatName) || chatName : chatName}
          </div>
          <div style={{ fontSize: 11, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isGroup
              ? 'Groupe'
              : chatPhone && !looksLikePhone(chatName)
                ? formatPhone(chatPhone)
                : 'Conversation WhatsApp'}
          </div>
        </div>
        <button
          type="button"
          style={{
            ...circleBtn(false, 34),
            fontSize: 15,
            color: searchOpen ? C.accent : C.muted,
            background: searchOpen ? `${C.accent}14` : 'transparent',
          }}
          title="Rechercher dans la conversation"
          aria-label="Rechercher dans la conversation"
          onClick={() => {
            setSearchOpen(v => !v);
            setSearchQuery('');
          }}
        >
          🔍
        </button>
        <AiToggle chatJid={chatJid} onDark={onDark} connId={connId} />
      </div>

      {/* In-chat search bar */}
      {searchOpen && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 12px',
            borderBottom: `1px solid ${C.border}`,
            background: C.panel,
            flexShrink: 0,
          }}
        >
          <input
            autoFocus
            dir="auto"
            style={{ ...inputStyle, borderRadius: 999, fontSize: 12.5, padding: '7px 14px', flex: 1 }}
            value={searchQuery}
            placeholder="Rechercher dans les messages chargés…"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
          />
          <span style={{ fontSize: 11.5, color: C.muted, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {matches.length > 0 ? `${Math.min(matchIdx + 1, matches.length)}/${matches.length}` : searchQuery.trim() ? '0/0' : ''}
          </span>
          <button
            type="button"
            style={{ ...circleBtn(matches.length === 0, 30), fontSize: 13 }}
            disabled={matches.length === 0}
            aria-label="Résultat précédent"
            title="Plus ancien"
            onClick={() => setMatchIdx(i => (i - 1 + matches.length) % matches.length)}
          >
            ↑
          </button>
          <button
            type="button"
            style={{ ...circleBtn(matches.length === 0, 30), fontSize: 13 }}
            disabled={matches.length === 0}
            aria-label="Résultat suivant"
            title="Plus récent"
            onClick={() => setMatchIdx(i => (i + 1) % matches.length)}
          >
            ↓
          </button>
          <button
            type="button"
            style={{ ...circleBtn(false, 30), fontSize: 13 }}
            aria-label="Fermer la recherche"
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery('');
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Messages area — WhatsApp wallpaper */}
      <div
        ref={scrollerRef}
        onScroll={onScrollerScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 8%',
          display: 'flex',
          flexDirection: 'column',
          backgroundImage: wa.chatPattern,
          backgroundSize: '24px 24px',
        }}
      >
        {loading && messages.length === 0 && (
          <div style={{ textAlign: 'center', color: wa.dayPillText, fontSize: 12.5, padding: 20 }}>
            Chargement…
          </div>
        )}
        {hasOlder && messages.length > 0 && (
          <div style={{ textAlign: 'center', marginBottom: 10 }}>
            <button
              style={{
                border: 'none',
                background: wa.dayPillBg,
                color: wa.dayPillText,
                fontSize: 11.5,
                fontWeight: 600,
                padding: '5px 14px',
                borderRadius: 999,
                cursor: loadingOlder ? 'wait' : 'pointer',
                boxShadow: wa.bubbleShadow,
              }}
              disabled={loadingOlder}
              onClick={loadOlder}
            >
              {loadingOlder ? 'Chargement…' : '↑ Messages plus anciens'}
            </button>
          </div>
        )}
        {messages.length === 0 && !loading ? (
          <div style={{ textAlign: 'center', color: wa.dayPillText, fontSize: 12.5, padding: 24 }}>
            Aucun message dans cette conversation.
          </div>
        ) : null}
        {messages.map((m, idx) => {
          const prev = idx > 0 ? messages[idx - 1] : null;
          const day = tsDay(m.timestamp);
          const showDay = !prev || tsDay(prev.timestamp) !== day;
          const senderKey = m.fromMe ? 'me' : isGroup ? m.pushName || 'other' : 'them';
          const prevSenderKey = prev ? (prev.fromMe ? 'me' : isGroup ? prev.pushName || 'other' : 'them') : '';
          const sameGroupAsPrev =
            !!prev &&
            !showDay &&
            prevSenderKey === senderKey &&
            Math.abs(tsMs(m.timestamp) - tsMs(prev.timestamp)) < 5 * 60_000;
          const firstOfGroup = !sameGroupAsPrev;
          const isMedia = mediaTypes.has(m.type ?? '');
          const bubbleBg = m.fromMe ? wa.out : wa.inn;
          const bubbleColor = m.fromMe ? wa.outText : wa.innText;
          const timeColor = m.fromMe ? wa.outMuted : wa.innMuted;
          const isCurrentMatch = currentMatchId !== null && m.id === currentMatchId;

          const radius = m.fromMe
            ? firstOfGroup
              ? '10px 2px 10px 10px'
              : '10px 10px 10px 10px'
            : firstOfGroup
              ? '2px 10px 10px 10px'
              : '10px 10px 10px 10px';

          return (
            <div key={`${m.id}_${idx}`} style={{ display: 'contents' }}>
              {showDay && day && (
                <div style={{ textAlign: 'center', margin: '12px 0 8px' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      background: wa.dayPillBg,
                      color: wa.dayPillText,
                      padding: '4px 12px',
                      borderRadius: 8,
                      fontSize: 11,
                      fontWeight: 600,
                      boxShadow: wa.bubbleShadow,
                    }}
                  >
                    {dayLabel(m.timestamp)}
                  </span>
                </div>
              )}
              <div
                ref={el => {
                  if (el) bubbleRefs.current.set(m.id, el);
                  else bubbleRefs.current.delete(m.id);
                }}
                style={{
                  display: 'flex',
                  justifyContent: m.fromMe ? 'flex-end' : 'flex-start',
                  marginTop: firstOfGroup ? 8 : 2,
                  paddingLeft: m.fromMe ? 0 : 8,
                  paddingRight: m.fromMe ? 8 : 0,
                }}
              >
                <div
                  style={{
                    background: bubbleBg,
                    color: bubbleColor,
                    borderRadius: radius,
                    padding: isMedia ? '5px 5px 7px' : '6px 9px 7px 10px',
                    fontSize: 13.5,
                    wordBreak: 'break-word',
                    lineHeight: 1.45,
                    maxWidth: bubbleMax,
                    position: 'relative',
                    boxShadow: isCurrentMatch
                      ? `0 0 0 2.5px ${C.accent}, ${wa.bubbleShadow}`
                      : wa.bubbleShadow,
                    transition: 'box-shadow 0.15s ease',
                  }}
                >
                  {firstOfGroup && (m.fromMe ? <TailOut color={bubbleBg} /> : <TailIn color={bubbleBg} />)}
                  {isGroup && !m.fromMe && m.pushName && firstOfGroup ? (
                    <div
                      dir="auto"
                      style={{
                        fontSize: 11.5,
                        color: wa.groupName,
                        fontWeight: 700,
                        marginBottom: 2,
                        textAlign: 'start',
                        padding: isMedia ? '2px 4px 0' : 0,
                      }}
                    >
                      {m.pushName}
                    </div>
                  ) : null}
                  {isMedia && m.id ? (
                    <MediaBubble messageId={m.id} type={m.type ?? ''} fromMe={m.fromMe} connId={connId} wa={wa} />
                  ) : (
                    <div dir="auto" style={{ textAlign: 'start', unicodeBidi: 'plaintext' as CSSProperties['unicodeBidi'], whiteSpace: 'pre-wrap' }}>
                      {m.text || '—'}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 10,
                      marginTop: 3,
                      textAlign: 'right',
                      color: timeColor,
                      display: 'flex',
                      justifyContent: 'flex-end',
                      alignItems: 'center',
                      gap: 3,
                      padding: isMedia ? '0 4px' : 0,
                    }}
                  >
                    {msgTime(m.timestamp)}
                    {m.fromMe && (
                      <svg viewBox="0 0 16 11" width="14" height="10" aria-hidden="true">
                        <path
                          fill={wa.tick}
                          d="M11.07.65 4.62 7.1 1.93 4.42l-1.06 1.06 3.75 3.75L12.13 1.7 11.07.65zm3.86 0-6.45 6.45-.7-.7-1.07 1.06 1.77 1.77 7.51-7.52L14.93.65z"
                        />
                      </svg>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Jump to latest */}
      {showJump && (
        <button
          type="button"
          onClick={jumpToBottom}
          aria-label="Aller aux derniers messages"
          style={{
            position: 'absolute',
            right: 18,
            bottom: 86,
            width: 40,
            height: 40,
            borderRadius: '50%',
            border: `1px solid ${C.border}`,
            background: C.panel,
            color: C.text,
            fontSize: 16,
            cursor: 'pointer',
            boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
            zIndex: 5,
          }}
        >
          ↓
        </button>
      )}

      {/* Composer */}
      <Composer
        chatJid={chatJid}
        connected={connected}
        onDark={onDark}
        onSent={onSent}
        connId={connId}
        quickReplies={quickReplies}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
};

// ── Chat list (left pane) ──────────────────────────────────────────────────

type ChatFilter = 'all' | 'unread' | 'groups';

interface ChatListProps {
  active: string | null;
  onSelect: (jid: string, name: string, isGroup: boolean, phone?: string) => void;
  onDark: () => void;
  connId: string | null;
  onNewChat: () => void;
  onBroadcast: () => void;
}

const ChatList = ({ active, onSelect, onDark, connId, onNewChat, onBroadcast }: ChatListProps) => {
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');
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

  const filtered = useMemo(() => {
    return chats.filter(c => {
      if (filter === 'unread' && !(c.unread && c.unread > 0)) return false;
      if (filter === 'groups' && !c.is_group) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        displayName(c).toLowerCase().includes(q) ||
        (c.phone ?? '').includes(q) ||
        (typeof c.last_text === 'string' && c.last_text.toLowerCase().includes(q))
      );
    });
  }, [chats, filter, search]);

  const handleSelect = useCallback(
    (c: ChatRow) => {
      const jid = jidOf(c);
      const name = displayName(c);
      // Optimistic unread clear — the /read watermark lands on open and the
      // next poll confirms, but the badge should react instantly.
      setChats(prev => prev.map(x => (jidOf(x) === jid ? { ...x, unread: 0 } : x)));
      onSelect(jid, name, c.is_group ?? false, c.phone ?? c.chat_phone ?? undefined);
    },
    [onSelect]
  );

  const iconBtn = (title: string, onClick: () => void, label: string, disabled = false): ReactElement => (
    <button
      type="button"
      style={{ ...circleBtn(disabled, 32), fontSize: 15 }}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );

  const filterChip = (v: ChatFilter, label: string): ReactElement => (
    <button
      key={v}
      type="button"
      onClick={() => setFilter(v)}
      style={{
        border: `1px solid ${filter === v ? `${C.accent}88` : C.border}`,
        background: filter === v ? `${C.accent}1c` : 'transparent',
        color: filter === v ? C.accent : C.muted,
        fontSize: 11.5,
        fontWeight: 700,
        padding: '4px 12px',
        borderRadius: 999,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );

  const unreadTotal = chats.reduce((acc, c) => acc + (c.unread ?? 0), 0);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        borderRight: `1px solid ${C.border}`,
        background: C.panel,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 12px 10px',
          borderBottom: `1px solid ${C.border}`,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: C.text, flex: 1, letterSpacing: 0.2 }}>
            Discussions
          </span>
          {iconBtn('Nouvelle discussion', onNewChat, '✏️')}
          {iconBtn('Diffusion — envoyer à plusieurs numéros', onBroadcast, '📢')}
          {iconBtn('Actualiser', () => void fetchChats(), loading ? '…' : '↻', loading)}
        </div>
        <div style={{ position: 'relative' }}>
          <span
            style={{
              position: 'absolute',
              left: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 12,
              color: C.muted,
              pointerEvents: 'none',
            }}
          >
            🔍
          </span>
          <input
            style={{
              ...inputStyle,
              fontSize: 12.5,
              borderRadius: 999,
              padding: '8px 14px 8px 34px',
              background: C.bg,
            }}
            value={search}
            dir="auto"
            placeholder="Rechercher une discussion…"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', scrollbarWidth: 'none' as CSSProperties['scrollbarWidth'] }}>
          {filterChip('all', 'Toutes')}
          {filterChip('unread', unreadTotal > 0 ? `Non lues · ${unreadTotal}` : 'Non lues')}
          {filterChip('groups', 'Groupes')}
        </div>
      </div>

      {/* Chat rows */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && chats.length === 0 ? (
          <div style={{ padding: '6px 12px' }}>
            {[0, 1, 2, 3, 4, 5].map(i => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0' }}>
                <div
                  style={{
                    width: 46,
                    height: 46,
                    borderRadius: '50%',
                    background: `linear-gradient(90deg, ${C.surface} 25%, ${C.hover} 50%, ${C.surface} 75%)`,
                    backgroundSize: '400px 100%',
                    animation: 'cdz-skel 1.2s linear infinite',
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <div
                    style={{
                      height: 11,
                      width: `${58 - i * 4}%`,
                      borderRadius: 6,
                      background: `linear-gradient(90deg, ${C.surface} 25%, ${C.hover} 50%, ${C.surface} 75%)`,
                      backgroundSize: '400px 100%',
                      animation: 'cdz-skel 1.2s linear infinite',
                    }}
                  />
                  <div
                    style={{
                      height: 9,
                      width: `${76 - i * 5}%`,
                      borderRadius: 6,
                      background: `linear-gradient(90deg, ${C.surface} 25%, ${C.hover} 50%, ${C.surface} 75%)`,
                      backgroundSize: '400px 100%',
                      animation: 'cdz-skel 1.2s linear infinite',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 18, fontSize: 12.5, color: C.muted, textAlign: 'center', lineHeight: 1.7 }}>
            {chatError
              ? 'Erreur de récupération. Réessayez.'
              : search
                ? 'Aucun résultat.'
                : filter === 'unread'
                  ? 'Aucune discussion non lue. 🎉'
                  : filter === 'groups'
                    ? 'Aucun groupe.'
                    : 'Aucune conversation. Revenez après avoir reçu un message.'}
          </div>
        ) : (
          filtered.map(c => {
            const jid = jidOf(c);
            const name = displayName(c);
            const isActive = active === jid;
            const unread = c.unread ?? 0;
            const preview = chatPreview(c);
            const nameIsPhone = looksLikePhone(name);
            const title = nameIsPhone ? formatPhone(name) || name : name;
            const sub = preview || (nameIsPhone ? 'Conversation WhatsApp' : formatPhone(c.phone ?? '') || 'Conversation WhatsApp');

            return (
              <button
                key={jid}
                type="button"
                onClick={() => handleSelect(c)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '9px 12px',
                  border: 'none',
                  background: isActive ? `${C.accent}14` : 'transparent',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  borderLeft: isActive ? `3px solid ${C.accent}` : '3px solid transparent',
                  boxSizing: 'border-box',
                }}
                onMouseEnter={e => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = C.hover;
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = isActive ? `${C.accent}14` : 'transparent';
                }}
              >
                <Avatar name={name} jid={jid} connId={connId} size={46} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      gap: 6,
                    }}
                  >
                    <span
                      dir="auto"
                      style={{
                        fontSize: 13.5,
                        fontWeight: unread > 0 ? 800 : 600,
                        color: C.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                        minWidth: 0,
                        textAlign: 'start',
                      }}
                    >
                      {c.is_group && (
                        <span style={{ marginRight: 4, fontSize: 12 }}>👥</span>
                      )}
                      {title}
                    </span>
                    {c.last_message_at ? (
                      <span
                        style={{
                          fontSize: 10.5,
                          color: unread > 0 ? C.accent : C.muted,
                          fontWeight: unread > 0 ? 700 : 500,
                          flexShrink: 0,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {relativeTime(c.last_message_at)}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <span
                      dir="auto"
                      style={{
                        fontSize: 12,
                        color: unread > 0 ? C.text : C.muted,
                        fontWeight: unread > 0 ? 600 : 400,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                        minWidth: 0,
                        textAlign: 'start',
                      }}
                    >
                      {c.last_from_me && preview ? `Vous : ${preview}` : sub}
                    </span>
                    {unread > 0 && (
                      <span
                        style={{
                          background: C.accent,
                          color: '#0b1f14',
                          borderRadius: 999,
                          fontSize: 10.5,
                          fontWeight: 800,
                          minWidth: 18,
                          height: 18,
                          padding: '0 5px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          boxSizing: 'border-box',
                        }}
                      >
                        {unread > 99 ? '99+' : unread}
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

// ── New chat modal (contacts + number check) ───────────────────────────────

interface NewChatModalProps {
  connId: string | null;
  onDark: () => void;
  onClose: () => void;
  onOpen: (jid: string, name: string, phone?: string) => void;
}

const NewChatModal = ({ connId, onDark, onClose, onOpen }: NewChatModalProps) => {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [manual, setManual] = useState('');
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const out = await apiGet<{ contacts: ContactRow[] }>(
        `/api/v1/whatsappmax/contacts?limit=500${connId ? `&connId=${encodeURIComponent(connId)}` : ''}`
      );
      if (cancelled) return;
      setLoading(false);
      if (isDark(out)) { onDark(); return; }
      if (out && Array.isArray(out.contacts)) {
        setContacts(out.contacts.filter(ct => !ct.is_group));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connId, onDark]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const named = contacts.filter(ct => {
      if (!q) return true;
      return (
        (ct.name ?? '').toLowerCase().includes(q) ||
        (ct.pushName ?? '').toLowerCase().includes(q) ||
        (ct.notify ?? '').toLowerCase().includes(q) ||
        (ct.phone ?? '').includes(q) ||
        (ct.jid ?? '').includes(q)
      );
    });
    return named
      .slice()
      .sort((a, b) => {
        const an = a.name ?? a.pushName ?? a.notify ?? '';
        const bn = b.name ?? b.pushName ?? b.notify ?? '';
        const aPhone = !an || looksLikePhone(an);
        const bPhone = !bn || looksLikePhone(bn);
        if (aPhone !== bPhone) return aPhone ? 1 : -1;
        return an.localeCompare(bn, 'fr');
      })
      .slice(0, 200);
  }, [contacts, search]);

  const checkManual = useCallback(async () => {
    const digits = manual.replace(/[^\d]/g, '');
    if (digits.length < 8) {
      setErr('Entrez un numéro valide (ex. 213xxxxxxxxx).');
      return;
    }
    setChecking(true);
    setErr(null);
    const out = await apiPost<{ results: Array<{ input?: string; jid?: string; exists?: boolean }> }>(
      '/api/v1/whatsappmax/check',
      { numbers: [digits], ...(connId ? { connId } : {}) }
    );
    setChecking(false);
    if (isDark(out)) { onDark(); return; }
    const r = out && Array.isArray(out.results) ? out.results[0] : null;
    if (r && r.exists) {
      onOpen(r.jid || `${digits}@s.whatsapp.net`, formatPhone(digits) || `+${digits}`, digits);
      onClose();
    } else if (r) {
      setErr('Ce numéro n’est pas sur WhatsApp.');
    } else {
      setErr('Vérification impossible — réessayez.');
    }
  }, [manual, connId, onDark, onOpen, onClose]);

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
        padding: 14,
        boxSizing: 'border-box',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 16,
          width: 420,
          maxWidth: '94vw',
          maxHeight: '84vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          animation: 'cdz-pop-in 0.16s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 10px' }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: C.text, flex: 1 }}>✏️ Nouvelle discussion</span>
          <button
            style={{ background: 'none', border: 'none', color: C.muted, fontSize: 17, cursor: 'pointer' }}
            aria-label="Fermer"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Manual number */}
        <div style={{ padding: '0 16px 12px', display: 'flex', gap: 8 }}>
          <input
            style={{ ...inputStyle, borderRadius: 999, padding: '9px 14px' }}
            value={manual}
            inputMode="numeric"
            placeholder="Numéro direct : 213xxxxxxxxx"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setManual(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') void checkManual();
            }}
          />
          <button
            style={{ ...btn('primary', checking || manual.replace(/[^\d]/g, '').length < 8), borderRadius: 999, flexShrink: 0 }}
            disabled={checking || manual.replace(/[^\d]/g, '').length < 8}
            onClick={() => void checkManual()}
          >
            {checking ? 'Vérification…' : 'Ouvrir'}
          </button>
        </div>
        {err ? <div style={{ padding: '0 16px 8px', fontSize: 12, color: C.danger }}>{err}</div> : null}

        <div style={{ borderTop: `1px solid ${C.border}`, padding: '10px 16px 8px' }}>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: C.muted, pointerEvents: 'none' }}>
              🔍
            </span>
            <input
              style={{ ...inputStyle, borderRadius: 999, fontSize: 12.5, padding: '8px 14px 8px 34px' }}
              value={search}
              dir="auto"
              placeholder="Rechercher dans vos contacts…"
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Contact list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 10px' }}>
          {loading ? (
            <div style={{ padding: 16, fontSize: 12.5, color: C.muted, textAlign: 'center' }}>Chargement des contacts…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12.5, color: C.muted, textAlign: 'center' }}>
              {search ? 'Aucun contact trouvé.' : 'Aucun contact synchronisé pour le moment.'}
            </div>
          ) : (
            filtered.map(ct => {
              const jid = ct.jid ?? '';
              const rawName = ct.name || ct.pushName || ct.notify || '';
              const name = rawName || formatPhone(ct.phone ?? '') || jid.split('@')[0];
              return (
                <button
                  key={jid || name}
                  type="button"
                  onClick={() => {
                    if (!jid) return;
                    onOpen(jid, name, ct.phone ?? undefined);
                    onClose();
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    border: 'none',
                    background: 'transparent',
                    borderRadius: 10,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLButtonElement).style.background = C.hover;
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  }}
                >
                  <Avatar name={name} jid={jid} connId={connId} size={38} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span dir="auto" style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'start' }}>
                      {name}
                    </span>
                    {ct.phone && !looksLikePhone(name) ? (
                      <span style={{ display: 'block', fontSize: 11, color: C.muted, marginTop: 1 }}>
                        {formatPhone(ct.phone)}
                      </span>
                    ) : null}
                  </span>
                  <span style={{ color: C.muted, fontSize: 13 }}>›</span>
                </button>
              );
            })
          )}
        </div>
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

  const recipientCount = useMemo(
    () =>
      to
        .split(/[\s,;]+/)
        .map(x => x.replace(/[^\d]/g, ''))
        .filter(x => x.length >= 8).length,
    [to]
  );

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
        padding: 14,
        boxSizing: 'border-box',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 16,
          padding: 20,
          width: 420,
          maxWidth: '94vw',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          animation: 'cdz-pop-in 0.16s ease',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: C.text }}>📢 Diffusion</span>
          <button style={{ background: 'none', border: 'none', color: C.muted, fontSize: 17, cursor: 'pointer' }} aria-label="Fermer" onClick={onClose}>✕</button>
        </div>
        <div>
          <textarea
            style={{ ...inputStyle, minHeight: 54, resize: 'vertical' as const, borderRadius: 10 }}
            value={to}
            disabled={busy}
            placeholder={'Numéros destinataires : 213xxx, 213yyy…\n(séparés par virgules ou retours à la ligne)'}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTo(e.target.value)}
          />
          <div style={{ fontSize: 11, color: recipientCount > 0 ? C.accent : C.muted, marginTop: 4, fontWeight: 600 }}>
            {recipientCount > 0 ? `${recipientCount} destinataire${recipientCount > 1 ? 's' : ''} détecté${recipientCount > 1 ? 's' : ''}` : 'Aucun numéro détecté'}
          </div>
        </div>
        <textarea
          style={{ ...inputStyle, minHeight: 96, resize: 'vertical' as const, borderRadius: 10 }}
          value={text}
          disabled={busy}
          dir="auto"
          placeholder="Votre message…"
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
        />
        {note && <div style={{ fontSize: 12.5, color: C.text, background: C.surface, borderRadius: 8, padding: '8px 10px' }}>{note}</div>}
        <button style={{ ...btn('primary', busy || recipientCount === 0 || !text.trim()), borderRadius: 999, padding: '10px 16px' }} disabled={busy || recipientCount === 0 || !text.trim()} onClick={() => void submit()}>
          {busy ? 'Diffusion en cours…' : `Diffuser${recipientCount > 0 ? ` à ${recipientCount}` : ''}`}
        </button>
        <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
          La cadence d’envoi est régulée par la passerelle (anti-spam / warm-up). Max 50 destinataires par diffusion.
        </div>
      </div>
    </div>
  );
};

// ── AI settings modal (per-shop persona / tone / language / auto-reply) ────

const TONE_OPTIONS: Array<{ v: string; l: string }> = [
  { v: 'pro', l: 'Professionnel' },
  { v: 'amical', l: 'Amical' },
  { v: 'vendeur', l: 'Commercial' },
  { v: 'neutre', l: 'Neutre' },
];
const LANG_OPTIONS: Array<{ v: string; l: string }> = [
  { v: 'auto', l: 'Auto' },
  { v: 'fr', l: 'Français' },
  { v: 'darija', l: 'Darija' },
  { v: 'ar', l: 'العربية' },
  { v: 'en', l: 'English' },
];

const Switch = ({ checked, onChange, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    style={{
      width: 40,
      height: 22,
      borderRadius: 999,
      border: 'none',
      background: checked ? C.accent : C.border,
      position: 'relative',
      cursor: disabled ? 'not-allowed' : 'pointer',
      transition: 'background 0.15s ease',
      flexShrink: 0,
      padding: 0,
      opacity: disabled ? 0.6 : 1,
    }}
  >
    <span
      style={{
        position: 'absolute',
        top: 3,
        left: checked ? 21 : 3,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 0.15s ease',
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
      }}
    />
  </button>
);

interface AiSettingsModalProps {
  connId: string | null;
  onDark: () => void;
  onClose: () => void;
  onSaved: (s: WamaxAiSettings) => void;
}

const AiSettingsModal = ({ connId, onDark, onClose, onSaved }: AiSettingsModalProps) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [s, setS] = useState<WamaxAiSettings>({ ...DEFAULT_AI_SETTINGS });
  const [qrInput, setQrInput] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const out = await apiGet<{ ok: boolean; settings: WamaxAiSettings }>(
        `/api/v1/whatsappmax/settings${connId ? `?connId=${encodeURIComponent(connId)}` : ''}`
      );
      if (cancelled) return;
      setLoading(false);
      if (isDark(out)) { onDark(); return; }
      if (out && out.ok && out.settings) {
        setS({ ...DEFAULT_AI_SETTINGS, ...out.settings });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connId, onDark]);

  const addQuickReply = useCallback(() => {
    const t = qrInput.trim().slice(0, 300);
    if (!t) return;
    setS(prev =>
      prev.quickReplies.length >= 10
        ? prev
        : { ...prev, quickReplies: [...prev.quickReplies, t] }
    );
    setQrInput('');
  }, [qrInput]);

  const save = useCallback(async () => {
    setSaving(true);
    setErr(null);
    const out = await apiPost<{ ok: boolean; settings: WamaxAiSettings }>(
      '/api/v1/whatsappmax/settings',
      { ...s, ...(connId ? { connId } : {}) }
    );
    setSaving(false);
    if (isDark(out)) { onDark(); return; }
    if (out && out.ok && out.settings) {
      setS({ ...DEFAULT_AI_SETTINGS, ...out.settings });
      onSaved(out.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setErr('Enregistrement impossible — réessayez.');
    }
  }, [s, connId, onDark, onSaved]);

  const sectionTitle = (label: string): ReactElement => (
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 800,
        color: C.muted,
        textTransform: 'uppercase' as const,
        letterSpacing: 1,
        margin: '4px 0 2px',
      }}
    >
      {label}
    </div>
  );

  const chipRow = (
    options: Array<{ v: string; l: string }>,
    value: string,
    set: (v: string) => void
  ): ReactElement => (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
      {options.map(o => (
        <button
          key={o.v}
          type="button"
          onClick={() => set(o.v)}
          style={{
            border: `1px solid ${value === o.v ? `${C.accent}88` : C.border}`,
            background: value === o.v ? `${C.accent}1c` : 'transparent',
            color: value === o.v ? C.accent : C.muted,
            fontSize: 12,
            fontWeight: 700,
            padding: '5px 14px',
            borderRadius: 999,
            cursor: 'pointer',
          }}
        >
          {o.l}
        </button>
      ))}
    </div>
  );

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
        padding: 14,
        boxSizing: 'border-box',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 16,
          width: 500,
          maxWidth: '94vw',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          animation: 'cdz-pop-in 0.16s ease',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '15px 18px 12px', borderBottom: `1px solid ${C.border}` }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 11,
              background: `linear-gradient(135deg, ${C.accent}, ${C.accentDark})`,
              display: 'grid',
              placeItems: 'center',
              fontSize: 17,
              flexShrink: 0,
            }}
          >
            🤖
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>Réglages IA</div>
            <div style={{ fontSize: 11, color: C.muted }}>Personnalisez l’assistant de votre boutique</div>
          </div>
          <button
            style={{ background: 'none', border: 'none', color: C.muted, fontSize: 17, cursor: 'pointer' }}
            aria-label="Fermer"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {loading ? (
            <div style={{ fontSize: 12.5, color: C.muted, textAlign: 'center', padding: 20 }}>Chargement…</div>
          ) : (
            <>
              {sectionTitle('Profil de l’entreprise')}
              <input
                style={{ ...inputStyle, borderRadius: 10 }}
                value={s.businessName}
                maxLength={120}
                dir="auto"
                placeholder="Nom de l’entreprise — ex. « Boutique Amina »"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setS(prev => ({ ...prev, businessName: e.target.value }))}
              />
              <div>
                <textarea
                  style={{ ...inputStyle, minHeight: 96, resize: 'vertical' as const, borderRadius: 10, lineHeight: 1.55 }}
                  value={s.persona}
                  maxLength={1500}
                  dir="auto"
                  placeholder={'Décrivez votre activité pour guider l’IA :\nproduits et prix, horaires, zones et délais de livraison, politique de retour, ton de la marque…'}
                  onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setS(prev => ({ ...prev, persona: e.target.value }))}
                />
                <div style={{ fontSize: 10.5, color: C.muted, textAlign: 'right', marginTop: 3 }}>
                  {s.persona.length}/1500
                </div>
              </div>

              {sectionTitle('Style des réponses')}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>Ton</div>
                {chipRow(TONE_OPTIONS, s.tone, v => setS(prev => ({ ...prev, tone: v })))}
                <div style={{ fontSize: 12, color: C.text, fontWeight: 600, marginTop: 4 }}>Langue des réponses</div>
                {chipRow(LANG_OPTIONS, s.language, v => setS(prev => ({ ...prev, language: v })))}
                <div style={{ fontSize: 10.5, color: C.muted }}>
                  « Auto » répond dans la langue du client (français, darija ou arabe).
                </div>
              </div>

              {sectionTitle('Réponses automatiques')}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '11px 13px',
                  background: C.surface,
                  borderRadius: 12,
                  border: `1px solid ${C.border}`,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>
                    IA active par défaut sur les nouvelles conversations
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2, lineHeight: 1.5 }}>
                    L’IA répond automatiquement aux clients. Le bouton « IA auto » de chaque conversation reste prioritaire.
                  </div>
                </div>
                <Switch
                  checked={s.autoReplyDefault}
                  onChange={v => setS(prev => ({ ...prev, autoReplyDefault: v }))}
                />
              </div>

              {sectionTitle('Réponses rapides')}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {s.quickReplies.map((r, i) => (
                  <div
                    key={`${i}_${r.slice(0, 10)}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 11px',
                      background: C.surface,
                      borderRadius: 10,
                      border: `1px solid ${C.border}`,
                    }}
                  >
                    <span style={{ fontSize: 12, color: C.orange, flexShrink: 0 }}>⚡</span>
                    <span dir="auto" style={{ flex: 1, fontSize: 12.5, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'start' }}>
                      {r}
                    </span>
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: C.muted, fontSize: 13, cursor: 'pointer', flexShrink: 0, padding: 2 }}
                      aria-label="Supprimer cette réponse rapide"
                      onClick={() =>
                        setS(prev => ({
                          ...prev,
                          quickReplies: prev.quickReplies.filter((_, j) => j !== i),
                        }))
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {s.quickReplies.length < 10 ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      style={{ ...inputStyle, borderRadius: 10 }}
                      value={qrInput}
                      maxLength={300}
                      dir="auto"
                      placeholder="Nouveau modèle — ex. « Merci pour votre commande ! Livraison sous 48h. »"
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setQrInput(e.target.value)}
                      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addQuickReply();
                        }
                      }}
                    />
                    <button
                      style={{ ...btn('secondary', !qrInput.trim()), borderRadius: 10, flexShrink: 0 }}
                      disabled={!qrInput.trim()}
                      onClick={addQuickReply}
                    >
                      Ajouter
                    </button>
                  </div>
                ) : (
                  <div style={{ fontSize: 10.5, color: C.muted }}>Maximum 10 réponses rapides.</div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 18px',
            borderTop: `1px solid ${C.border}`,
            background: C.surface,
          }}
        >
          {err ? <span style={{ fontSize: 12, color: C.danger, flex: 1 }}>{err}</span> : <span style={{ flex: 1 }} />}
          {saved ? <span style={{ fontSize: 12.5, color: C.accent, fontWeight: 700 }}>Enregistré ✓</span> : null}
          <button style={{ ...btn('ghost', saving), borderRadius: 999 }} disabled={saving} onClick={onClose}>
            Fermer
          </button>
          <button
            style={{ ...btn('primary', saving || loading), borderRadius: 999, padding: '8px 22px' }}
            disabled={saving || loading}
            onClick={() => void save()}
          >
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
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
  onDisconnect: (connId: string) => void;
}

const AccountSwitcher = ({
  accounts,
  selectedConnId,
  onSelect,
  onAdd,
  onDisconnect,
}: AccountSwitcherProps) => {
  const [open, setOpen] = useState(false);
  const [pendingDisconnect, setPendingDisconnect] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const selected = accounts.find(a => a.connId === selectedConnId);
  const label = selected ? formatPhone(selected.phoneNumber) || `+${selected.phoneNumber}` : 'Aucun compte';
  const dotColor = (status: string) =>
    status === 'connected' ? C.accent : status === 'qr' || status === 'connecting' ? C.orange : C.muted;

  useEffect(() => {
    if (!open) setPendingDisconnect(null);
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        style={{
          ...btn('secondary', false),
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontSize: 12,
          borderRadius: 999,
          padding: '6px 12px',
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
        <span style={{ fontSize: 9, color: C.muted }}>▾</span>
      </button>
      <AnchoredPopover
        anchorRef={btnRef}
        open={open}
        onClose={() => setOpen(false)}
        width={300}
        direction="down"
        sheetOnNarrow={false}
      >
        <div style={{ padding: '10px 14px 6px', fontSize: 11, fontWeight: 800, color: C.muted, textTransform: 'uppercase' as const, letterSpacing: 0.8 }}>
          Comptes WhatsApp
        </div>
        <div style={{ padding: '0 6px 6px', display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' }}>
          {accounts.map(a => {
            const isPending = pendingDisconnect === a.connId;
            if (isPending) {
              return (
                <div
                  key={a.connId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    borderRadius: 9,
                    background: `${C.danger}14`,
                    border: `1px solid ${C.danger}44`,
                  }}
                >
                  <span style={{ flex: 1, fontSize: 12, color: C.text, fontWeight: 600 }}>
                    Déconnecter {formatPhone(a.phoneNumber) || `+${a.phoneNumber}`} ?
                  </span>
                  <button
                    type="button"
                    style={{ ...btn('danger', false), fontSize: 11, padding: '4px 10px', borderRadius: 999 }}
                    onClick={() => {
                      setPendingDisconnect(null);
                      setOpen(false);
                      onDisconnect(a.connId);
                    }}
                  >
                    Oui
                  </button>
                  <button
                    type="button"
                    style={{ ...btn('ghost', false), fontSize: 11, padding: '4px 10px', borderRadius: 999 }}
                    onClick={() => setPendingDisconnect(null)}
                  >
                    Non
                  </button>
                </div>
              );
            }
            return (
              <div
                key={a.connId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  borderRadius: 9,
                  background: a.connId === selectedConnId ? `${C.accent}14` : 'transparent',
                }}
              >
                <button
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '8px 10px',
                    border: 'none',
                    background: 'transparent',
                    color: C.text,
                    fontSize: 12.5,
                    cursor: 'pointer',
                    textAlign: 'left',
                    flex: 1,
                    minWidth: 0,
                    borderRadius: 9,
                  }}
                  onClick={() => { onSelect(a.connId); setOpen(false); }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: '50%',
                      background: dotColor(a.status),
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                    {formatPhone(a.phoneNumber) || `+${a.phoneNumber}`}
                  </span>
                  <span style={{ fontSize: 10, color: a.status === 'connected' ? C.accent : C.muted, fontWeight: 700, flexShrink: 0 }}>
                    {a.status === 'connected' ? 'Connecté' : a.status === 'qr' || a.status === 'connecting' ? 'Liaison…' : 'Hors ligne'}
                  </span>
                </button>
                <button
                  type="button"
                  style={{ ...circleBtn(false, 28), fontSize: 12, color: C.muted, marginRight: 4 }}
                  title="Déconnecter ce numéro"
                  aria-label="Déconnecter ce numéro"
                  onClick={() => setPendingDisconnect(a.connId)}
                >
                  ⏻
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ borderTop: `1px solid ${C.border}` }} />
        <button
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 16px',
            border: 'none',
            background: 'transparent',
            color: C.accent,
            fontSize: 12.5,
            cursor: 'pointer',
            textAlign: 'left',
            fontWeight: 700,
          }}
          onClick={() => { onAdd(); setOpen(false); }}
        >
          ＋ Lier un autre numéro
        </button>
      </AnchoredPopover>
    </>
  );
};

// ── Chat app (two-pane) ────────────────────────────────────────────────────

interface ChatAppProps {
  status: StatusResp | null;
  onDark: () => void;
  connId: string | null;
  quickReplies: string[];
  onOpenSettings: () => void;
}

const ChatApp = ({ status, onDark, connId, quickReplies, onOpenSettings }: ChatAppProps) => {
  const [activeJid, setActiveJid] = useState<string | null>(null);
  const [activeName, setActiveName] = useState('');
  const [activePhone, setActivePhone] = useState<string | undefined>(undefined);
  const [activeIsGroup, setActiveIsGroup] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const connected = status?.connected === true;

  // Below 768px: never show list + conversation side by side — show one or
  // the other, with a back control to return to the list. Between 768 and
  // 1024px (tablet), keep both panes but shrink the list pane so nothing
  // overflows horizontally.
  const isPhone = useIsNarrow(768);
  const isTablet = useIsNarrow(1024);

  const selectChat = useCallback((jid: string, name: string, isGroup: boolean, phone?: string) => {
    setActiveJid(jid);
    setActiveName(name);
    setActiveIsGroup(isGroup);
    setActivePhone(phone);
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
        width: isTablet ? '38%' : 330,
        minWidth: isTablet ? 200 : 250,
        maxWidth: isTablet ? 280 : 350,
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
        borderRadius: 14,
        background: C.bg,
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      {/* Left pane — chat list */}
      {showListPane && (
        <div style={listPaneStyle}>
          <ChatList
            active={activeJid}
            onSelect={selectChat}
            onDark={onDark}
            connId={connId}
            onNewChat={() => setShowNewChat(true)}
            onBroadcast={() => setShowBroadcast(true)}
          />
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
              key={activeJid}
              chatJid={activeJid}
              chatName={activeName}
              chatPhone={activePhone}
              isGroup={activeIsGroup}
              connected={connected}
              onDark={onDark}
              onClose={closeChat}
              connId={connId}
              showBack={isPhone}
              quickReplies={quickReplies}
              onOpenSettings={onOpenSettings}
            />
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 14,
                color: C.muted,
                padding: 20,
                boxSizing: 'border-box',
                background: C.bg,
              }}
            >
              <div
                style={{
                  width: 84,
                  height: 84,
                  borderRadius: '50%',
                  background: `linear-gradient(135deg, ${C.accent}26, ${C.accentDark}26)`,
                  border: `1px solid ${C.accent}33`,
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 38,
                }}
              >
                💬
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: C.text, letterSpacing: 0.2 }}>
                  WhatsApp <span style={{ color: C.accent }}>Max</span>
                </div>
                <div style={{ fontSize: 12.5, color: C.muted, maxWidth: 300, marginTop: 6, lineHeight: 1.6 }}>
                  Sélectionnez une conversation, ou démarrez une nouvelle discussion avec un contact.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const, justifyContent: 'center' }}>
                {['✨ Assistant IA', '🎙️ Notes vocales', '📢 Diffusion', '🤖 Réponses auto'].map(f => (
                  <span
                    key={f}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: C.muted,
                      border: `1px solid ${C.border}`,
                      borderRadius: 999,
                      padding: '4px 12px',
                    }}
                  >
                    {f}
                  </span>
                ))}
              </div>
              <button
                style={{ ...btn('primary', false), borderRadius: 999, padding: '9px 22px', marginTop: 4 }}
                onClick={() => setShowNewChat(true)}
              >
                ✏️ Nouvelle discussion
              </button>
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
      {showNewChat && (
        <NewChatModal
          connId={connId}
          onDark={onDark}
          onClose={() => setShowNewChat(false)}
          onOpen={(jid, name, phone) => selectChat(jid, name, false, phone)}
        />
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
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [aiSettings, setAiSettings] = useState<WamaxAiSettings | null>(null);

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

  // Load the per-connection AI settings (quick replies feed the composer).
  useEffect(() => {
    if (!selectedConnId) {
      setAiSettings(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const out = await apiGet<{ ok: boolean; settings: WamaxAiSettings }>(
        `/api/v1/whatsappmax/settings?connId=${encodeURIComponent(selectedConnId)}`
      );
      if (cancelled) return;
      if (out && !isDark(out) && out.ok && out.settings) {
        setAiSettings({ ...DEFAULT_AI_SETTINGS, ...out.settings });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedConnId]);

  const refreshAccounts = useCallback(async (): Promise<AccountMeta[]> => {
    const out = await apiGet<AccountsResp>('/api/v1/whatsappmax/accounts');
    if (isDark(out)) {
      setDark(true);
      return [];
    }
    if (out && Array.isArray(out.accounts)) {
      setAccounts(out.accounts);
      return out.accounts;
    }
    return [];
  }, []);

  const handleStatus = useCallback((s: StatusResp) => {
    setStatus(s);
    if (s.connected) setShowChat(true);
    if (!s.connected && s.status === 'logged_out') setShowChat(false);
  }, []);

  const handleConnected = useCallback(() => {
    setShowChat(true);
    setShowAddMode(false);
    void refreshAccounts();
  }, [refreshAccounts]);

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
        const list = await refreshAccounts();
        const added = list.find(a => a.connId === newConnId);
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
        setShowAddMode(false);
      })();
    },
    [refreshAccounts]
  );

  const handleAdd = useCallback(() => {
    setShowAddMode(true);
  }, []);

  const handleDisconnect = useCallback(
    (connId: string) => {
      void (async () => {
        await apiPost<{ ok: boolean }>('/api/v1/whatsappmax/disconnect', { connId });
        const list = await refreshAccounts();
        if (selectedConnId === connId) {
          const next = list.find(a => a.status === 'connected') ?? list[0];
          if (next) {
            setSelectedConnId(next.connId);
            setStatus({
              connected: next.status === 'connected',
              phoneNumber: next.phoneNumber,
              status: next.status,
              connectedAt: next.connectedAt,
            });
            setShowChat(next.status === 'connected');
          } else {
            setSelectedConnId(null);
            setStatus({ connected: false, status: 'disconnected' });
            setShowChat(false);
          }
        }
      })();
    },
    [refreshAccounts, selectedConnId]
  );

  // Determine QrPairing mode
  const qrMode: 'first' | 'add' | 'connected' =
    showAddMode
      ? 'add'
      : status?.connected
        ? 'connected'
        : 'first';

  return (
    <>
      <ViewTitle title="WhatsApp Max" />
      <ViewIcon icon="chat" />
      <ViewHeader>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
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
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              background: `linear-gradient(135deg, ${C.accent}, ${C.accentDark})`,
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
              boxShadow: `0 3px 10px ${C.accent}44`,
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                fill="#fff"
                d="M12 3.2c-4.9 0-8.8 3.7-8.8 8.3 0 1.6.5 3.1 1.3 4.4L3.3 20l4.3-1.1c1.3.7 2.8 1.1 4.4 1.1 4.9 0 8.8-3.7 8.8-8.4S16.9 3.2 12 3.2zm4.4 11.6c-.2.6-1.1 1.1-1.6 1.1-.4.1-.9.1-1.5-.1-.3-.1-.8-.3-1.4-.5-2.4-1-3.9-3.4-4-3.6-.1-.2-1-1.3-1-2.5s.6-1.8.9-2c.2-.3.5-.3.7-.3h.5c.2 0 .4-.1.6.4l.8 2c.1.1.1.3 0 .5l-.3.5-.4.5c-.1.1-.3.3-.1.5.1.3.6 1 1.3 1.6.9.8 1.6 1.1 1.9 1.2.2.1.4.1.5-.1l.7-.9c.2-.2.3-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.2z"
              />
            </svg>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0, flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: C.text, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
              WhatsApp
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 800,
                  letterSpacing: 1,
                  color: '#0b1f14',
                  background: `linear-gradient(135deg, ${C.accent}, ${C.accentDark})`,
                  borderRadius: 5,
                  padding: '2px 6px',
                }}
              >
                MAX
              </span>
            </span>
            <span
              style={{
                fontSize: 11,
                color: C.muted,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 230,
              }}
            >
              Messagerie business — IA, diffusion, multi-comptes
            </span>
          </div>
          <span style={{ flex: 1, minWidth: 8 }} />
          {/* AI settings gear — visible when an account is selected */}
          {selectedConnId && !dark ? (
            <button
              type="button"
              style={{
                ...btn('secondary', false),
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                borderRadius: 999,
                padding: '6px 12px',
                flexShrink: 0,
              }}
              title="Réglages IA de la boutique"
              onClick={() => setShowAiSettings(true)}
            >
              🤖 Réglages IA
            </button>
          ) : null}
          {/* Account switcher — visible when accounts are loaded */}
          {accounts.length > 0 && !showAddMode && (
            <AccountSwitcher
              accounts={accounts}
              selectedConnId={selectedConnId}
              onSelect={handleSelectAccount}
              onAdd={handleAdd}
              onDisconnect={handleDisconnect}
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
                padding: '3px 11px',
                fontWeight: 700,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              ● Connecté
            </div>
          )}
        </div>
      </ViewHeader>
      <ViewBody>
        <AppAccessGate app="WHATSAPPMAX">
        {/* Keyframes + scoped scrollbar styling (inline styles can't define
            @keyframes / pseudo-elements, so inject once at the page root).
            cdz-qr-spin: spinners · cdz-rec-pulse: recorder dot ·
            cdz-pop-in: popover/modal entry · cdz-skel: skeleton shimmer. */}
        <style>{`
@keyframes cdz-qr-spin{to{transform:rotate(360deg)}}
@keyframes cdz-rec-pulse{0%,100%{opacity:1}50%{opacity:0.25}}
@keyframes cdz-pop-in{from{opacity:0;transform:translateY(6px) scale(0.98)}to{opacity:1;transform:none}}
@keyframes cdz-skel{0%{background-position:-200px 0}100%{background-position:200px 0}}
.cdz-wamax ::-webkit-scrollbar{width:7px;height:7px}
.cdz-wamax ::-webkit-scrollbar-thumb{background:rgba(134,150,160,0.28);border-radius:8px}
.cdz-wamax ::-webkit-scrollbar-thumb:hover{background:rgba(134,150,160,0.45)}
.cdz-wamax ::-webkit-scrollbar-track{background:transparent}
        `}</style>
        <div
          className="cdz-wamax"
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
                WhatsApp Max — bientôt disponible
              </div>
              <div style={{ fontSize: 12.5, color: C.muted }}>
                Cette fonctionnalité n'est pas encore activée sur ce serveur. Elle sera disponible prochainement.
              </div>
            </div>
          ) : !loaded ? (
            <div style={{ fontSize: 13, color: C.muted, padding: 16 }}>Chargement…</div>
          ) : (
            <>
              {/* QR pairing / add-mode (renders NOTHING when connected) */}
              <QrPairing
                status={status}
                onStatus={handleStatus}
                onDark={() => setDark(true)}
                onConnected={handleConnected}
                connId={selectedConnId}
                mode={qrMode}
                onAdded={handleAdded}
                onCancelAdd={() => setShowAddMode(false)}
              />
              {/* Chat app — shown only when connected (not in add-mode) */}
              {showChat && !showAddMode && (
                <ChatApp
                  status={status}
                  onDark={() => setDark(true)}
                  connId={selectedConnId}
                  quickReplies={aiSettings?.quickReplies ?? []}
                  onOpenSettings={() => setShowAiSettings(true)}
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
        {showAiSettings && (
          <AiSettingsModal
            connId={selectedConnId}
            onDark={() => setDark(true)}
            onClose={() => setShowAiSettings(false)}
            onSaved={s => setAiSettings({ ...DEFAULT_AI_SETTINGS, ...s })}
          />
        )}
        </AppAccessGate>
      </ViewBody>
    </>
  );
};

/** Router entry point — the workbench router renders this named export. */
export const Component = () => {
  return <WhatsappMaxPage />;
};
