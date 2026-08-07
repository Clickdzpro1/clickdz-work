import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// WS14 — WhatsappMax Studio (page shell).
//
// A thin studio surface over the EXISTING whatsapp-gateway (the backend
// clickdz-whatsappmax.controller.ts reuses CDZ_WA_URL/CDZ_WA_TOKEN). Structure
// mirrors the VPIC page (ViewTitle/ViewIcon + ViewHeader/ViewBody), with three
// panels:
//   · Pairing  — phone input → POST /connect → poll GET /status → show the QR /
//                pairing code until 'connected'.
//   · Send / Broadcast — recipient(s) + text → POST /send | /broadcast.
//   · Inbox    — chat list (GET /chats) + a chat's messages (GET /messages).
//
// Every route is behind CDZ_WHATSAPPMAX_ENABLED (default OFF ⇒ a 404 the FE
// treats as "feature dark", showing a quiet "bientôt" note, never an error).
// The router loads this file's `Component` export (same contract as VPIC).
// Inline styles + no i18n (matches the Integrations/ERP scaffold); French copy.
// ---------------------------------------------------------------------------

const C = {
  bg: 'var(--affine-background-primary-color, #0f1115)',
  panel: 'var(--affine-background-secondary-color, #171a21)',
  border: 'var(--affine-border-color, #262a35)',
  text: 'var(--affine-text-primary-color, #e6e9f0)',
  muted: 'var(--affine-text-secondary-color, #8a90a0)',
  accent: '#25D366', // WhatsApp green
  danger: '#ef4444',
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
};

function btn(kind: 'primary' | 'secondary' | 'danger', disabled: boolean): CSSProperties {
  const bg =
    kind === 'primary' ? C.accent : kind === 'danger' ? C.danger : 'transparent';
  const color = kind === 'secondary' ? C.text : '#0b1f14';
  return {
    padding: '8px 14px',
    borderRadius: 8,
    border: kind === 'secondary' ? `1px solid ${C.border}` : 'none',
    background: disabled ? 'var(--affine-hover-color, #2a2f3a)' : bg,
    color: kind === 'secondary' ? C.text : color,
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}

// ---- Fail-soft API helpers (dark-aware: a 404 = feature flag OFF) ----------

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

// ---- Types mirroring the backend route bodies ------------------------------

interface StatusResp {
  connected: boolean;
  phoneNumber?: string;
  status?: string;
  connectedAt?: number;
}
interface ConnectResp {
  ok: boolean;
  code?: string;
  formatted?: string;
  qr?: string;
  status: string;
}
interface ChatRow {
  id?: string;
  jid?: string;
  chatJid?: string;
  name?: string;
  pushName?: string;
}
interface MessageRow {
  id?: string;
  text?: string;
  fromMe?: boolean;
  timestamp?: string | number;
}

// ---- Pairing panel ---------------------------------------------------------

const PairingPanel = ({
  status,
  onStatus,
  onDark,
}: {
  status: StatusResp | null;
  onStatus: (s: StatusResp) => void;
  onDark: () => void;
}) => {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connected = status?.connected === true;

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Poll status while pairing (until connected) so the UI reflects the live
  // created→connecting→qr→connected transitions.
  const startPoll = useCallback(() => {
    stopPoll();
    pollRef.current = setInterval(() => {
      void (async () => {
        const s = await apiGet<StatusResp>('/api/v1/whatsappmax/status');
        if (isDark(s)) {
          stopPoll();
          onDark();
          return;
        }
        if (s) {
          onStatus(s);
          if (s.connected) {
            stopPoll();
            setCode(null);
            setQr(null);
          }
        }
      })();
    }, 2500);
  }, [onDark, onStatus, stopPoll]);

  useEffect(() => stopPoll, [stopPoll]);

  const connect = useCallback(async () => {
    const p = phone.replace(/[^\d]/g, '');
    if (p.length < 8) {
      setErr('Entrez un numéro international valide (avec l’indicatif pays).');
      return;
    }
    setErr(null);
    setBusy(true);
    const out = await apiPost<ConnectResp>('/api/v1/whatsappmax/connect', {
      phoneNumber: p,
    });
    setBusy(false);
    if (isDark(out)) return onDark();
    if (!out || !out.ok) {
      setErr('Connexion impossible pour le moment. Réessayez.');
      return;
    }
    if (out.code) setCode(out.formatted || out.code);
    if (out.qr) setQr(out.qr);
    startPoll();
  }, [phone, onDark, startPoll]);

  const rePair = useCallback(async () => {
    setErr(null);
    setBusy(true);
    const out = await apiPost<ConnectResp>('/api/v1/whatsappmax/pair', {});
    setBusy(false);
    if (isDark(out)) return onDark();
    if (out && out.ok && out.code) {
      setCode(out.formatted || out.code);
      if (out.qr) setQr(out.qr);
      startPoll();
    } else {
      setErr('Code non disponible — patientez puis réessayez.');
    }
  }, [onDark, startPoll]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    const out = await apiPost<{ ok: boolean }>(
      '/api/v1/whatsappmax/disconnect',
      {}
    );
    setBusy(false);
    if (isDark(out)) return onDark();
    stopPoll();
    setCode(null);
    setQr(null);
    onStatus({ connected: false });
  }, [onDark, onStatus, stopPoll]);

  if (connected) {
    return (
      <div style={panelStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span
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
          </span>
          <span style={{ fontSize: 13, color: C.muted }}>
            {status?.phoneNumber
              ? `Numéro ${status.phoneNumber} lié à WhatsappMax.`
              : 'Votre numéro WhatsApp est lié.'}
          </span>
          <span style={{ flex: 1 }} />
          <button style={btn('danger', busy)} disabled={busy} onClick={() => void disconnect()}>
            Déconnecter
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={panelStyle}>
      <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
        Lier un numéro WhatsApp
      </div>
      <div style={{ fontSize: 12.5, color: C.muted }}>
        Entrez votre numéro (format international, ex. 213…). Vous recevrez un code
        de liaison à saisir dans WhatsApp → Appareils liés. Vos identifiants sont
        gérés côté serveur — rien n’est stocké en clair.
      </div>
      <input
        style={inputStyle}
        value={phone}
        disabled={busy}
        inputMode="numeric"
        autoComplete="off"
        placeholder="213xxxxxxxxx"
        onChange={e => setPhone(e.target.value)}
      />
      {code ? (
        <div
          style={{
            background: C.bg,
            border: `1px dashed ${C.accent}`,
            borderRadius: 8,
            padding: 12,
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: 2,
            color: C.text,
            textAlign: 'center',
          }}
        >
          {code}
        </div>
      ) : null}
      {qr ? (
        <div style={{ fontSize: 12, color: C.muted, wordBreak: 'break-all' }}>
          QR: {qr}
        </div>
      ) : null}
      {err ? (
        <div style={{ fontSize: 12.5, color: C.danger }}>{err}</div>
      ) : null}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button style={btn('primary', busy)} disabled={busy} onClick={() => void connect()}>
          {busy ? 'Connexion…' : 'Générer le code de liaison'}
        </button>
        {code ? (
          <button style={btn('secondary', busy)} disabled={busy} onClick={() => void rePair()}>
            Régénérer
          </button>
        ) : null}
      </div>
    </div>
  );
};

// ---- Send / Broadcast panel ------------------------------------------------

const SendPanel = ({ onDark }: { onDark: () => void }) => {
  const [mode, setMode] = useState<'single' | 'broadcast'>('single');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const body = text.trim();
    if (!body) {
      setNote('Écrivez un message.');
      return;
    }
    setBusy(true);
    setNote(null);
    if (mode === 'single') {
      const p = to.replace(/[^\d]/g, '');
      if (p.length < 8) {
        setBusy(false);
        setNote('Numéro invalide.');
        return;
      }
      const out = await apiPost<{ ok: boolean; sent: boolean; note?: string }>(
        '/api/v1/whatsappmax/send',
        { to: p, text: body }
      );
      setBusy(false);
      if (isDark(out)) return onDark();
      if (out && out.sent) setNote('Message envoyé ✓');
      else setNote(out?.note === 'not_connected' ? 'Liez d’abord un numéro.' : 'Envoi échoué.');
    } else {
      const recipients = to
        .split(/[\s,;]+/)
        .map(x => x.replace(/[^\d]/g, ''))
        .filter(x => x.length >= 8);
      if (!recipients.length) {
        setBusy(false);
        setNote('Ajoutez au moins un numéro valide (séparés par des virgules).');
        return;
      }
      const out = await apiPost<{ ok: boolean; sent: number; failed: number; total: number }>(
        '/api/v1/whatsappmax/broadcast',
        { to: recipients, text: body }
      );
      setBusy(false);
      if (isDark(out)) return onDark();
      if (out) setNote(`Diffusion : ${out.sent}/${out.total} envoyés${out.failed ? `, ${out.failed} échoués` : ''}.`);
      else setNote('Diffusion échouée.');
    }
  }, [mode, to, text, onDark]);

  return (
    <div style={panelStyle}>
      <div style={{ display: 'inline-flex', borderRadius: 8, overflow: 'hidden', border: `1px solid ${C.border}`, alignSelf: 'flex-start' }}>
        {(['single', 'broadcast'] as const).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            style={{
              padding: '5px 12px',
              fontSize: 12,
              fontWeight: mode === m ? 600 : 400,
              border: 'none',
              cursor: 'pointer',
              background: mode === m ? 'var(--affine-hover-color, #2a2f3a)' : 'transparent',
              color: mode === m ? C.text : C.muted,
            }}
          >
            {m === 'single' ? 'Message' : 'Diffusion'}
          </button>
        ))}
      </div>
      <input
        style={inputStyle}
        value={to}
        disabled={busy}
        autoComplete="off"
        placeholder={mode === 'single' ? '213xxxxxxxxx' : '213xxx, 213yyy, …'}
        onChange={e => setTo(e.target.value)}
      />
      <textarea
        style={{ ...inputStyle, minHeight: 90, resize: 'vertical', fontFamily: 'inherit' }}
        value={text}
        disabled={busy}
        placeholder="Votre message…"
        onChange={e => setText(e.target.value)}
      />
      {note ? <div style={{ fontSize: 12.5, color: C.muted }}>{note}</div> : null}
      <button style={btn('primary', busy)} disabled={busy} onClick={() => void submit()}>
        {busy ? 'Envoi…' : mode === 'single' ? 'Envoyer' : 'Diffuser'}
      </button>
      {mode === 'broadcast' ? (
        <div style={{ fontSize: 11.5, color: C.muted }}>
          La cadence d’envoi est régulée par la passerelle (anti-spam / warm-up).
          Jusqu’à 50 destinataires par diffusion.
        </div>
      ) : null}
    </div>
  );
};

// ---- Inbox panel -----------------------------------------------------------

const InboxPanel = ({ onDark }: { onDark: () => void }) => {
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [loading, setLoading] = useState(false);

  const loadChats = useCallback(async () => {
    setLoading(true);
    const out = await apiGet<{ chats: ChatRow[] }>('/api/v1/whatsappmax/chats');
    setLoading(false);
    if (isDark(out)) return onDark();
    if (out && Array.isArray(out.chats)) setChats(out.chats);
  }, [onDark]);

  const loadMessages = useCallback(
    async (jid: string) => {
      setActive(jid);
      setMessages([]);
      const out = await apiGet<{ messages: MessageRow[] }>(
        `/api/v1/whatsappmax/messages?chatJid=${encodeURIComponent(jid)}&limit=50`
      );
      if (isDark(out)) return onDark();
      if (out && Array.isArray(out.messages)) setMessages(out.messages);
    },
    [onDark]
  );

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  const jidOf = (c: ChatRow) => c.chatJid || c.jid || c.id || '';

  return (
    <div style={{ ...panelStyle, minHeight: 320 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Boîte de réception</div>
        <span style={{ flex: 1 }} />
        <button style={btn('secondary', loading)} disabled={loading} onClick={() => void loadChats()}>
          {loading ? 'Chargement…' : 'Actualiser'}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 12, minHeight: 240 }}>
        <div style={{ flex: '0 0 40%', maxWidth: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {chats.length === 0 ? (
            <div style={{ fontSize: 12.5, color: C.muted }}>
              Aucune conversation. Actualisez après avoir reçu un message.
            </div>
          ) : (
            chats.map(c => {
              const jid = jidOf(c);
              return (
                <button
                  key={jid}
                  type="button"
                  onClick={() => void loadMessages(jid)}
                  style={{
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: `1px solid ${active === jid ? C.accent : C.border}`,
                    background: active === jid ? 'var(--affine-hover-color, #2a2f3a)' : C.bg,
                    color: C.text,
                    fontSize: 12.5,
                    cursor: 'pointer',
                  }}
                >
                  {c.name || c.pushName || jid || 'Contact'}
                </button>
              );
            })
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {active === null ? (
            <div style={{ fontSize: 12.5, color: C.muted }}>
              Sélectionnez une conversation pour voir les messages.
            </div>
          ) : messages.length === 0 ? (
            <div style={{ fontSize: 12.5, color: C.muted }}>Aucun message.</div>
          ) : (
            messages.map((m, i) => (
              <div
                key={m.id || i}
                style={{
                  alignSelf: m.fromMe ? 'flex-end' : 'flex-start',
                  maxWidth: '80%',
                  background: m.fromMe ? C.accent : C.bg,
                  color: m.fromMe ? '#0b1f14' : C.text,
                  border: `1px solid ${C.border}`,
                  borderRadius: 10,
                  padding: '6px 10px',
                  fontSize: 12.5,
                  wordBreak: 'break-word',
                }}
              >
                {m.text || '—'}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

// ---- Page shell ------------------------------------------------------------

const WhatsappMaxPage = () => {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [dark, setDark] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const s = await apiGet<StatusResp>('/api/v1/whatsappmax/status');
      if (isDark(s)) setDark(true);
      else if (s) setStatus(s);
      setLoaded(true);
    })();
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
            padding: '0 12px',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>WhatsappMax</span>
            <span style={{ fontSize: 11, color: C.muted }}>
              WhatsApp pour vos ventes — liaison, envoi, diffusion, boîte de réception
            </span>
          </div>
        </div>
      </ViewHeader>
      <ViewBody>
        <div
          style={{
            width: '100%',
            height: '100%',
            overflowY: 'auto',
            padding: 16,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            maxWidth: 900,
            margin: '0 auto',
          }}
        >
          {dark ? (
            <div style={panelStyle}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
                WhatsappMax — bientôt
              </div>
              <div style={{ fontSize: 12.5, color: C.muted }}>
                Cette fonctionnalité n’est pas encore activée sur ce serveur.
              </div>
            </div>
          ) : !loaded ? (
            <div style={{ fontSize: 13, color: C.muted }}>Chargement…</div>
          ) : (
            <>
              <PairingPanel status={status} onStatus={setStatus} onDark={() => setDark(true)} />
              <SendPanel onDark={() => setDark(true)} />
              <InboxPanel onDark={() => setDark(true)} />
            </>
          )}
        </div>
      </ViewBody>
    </>
  );
};

/** Router entry point — the workbench router renders this named export (same
 *  contract as the VPIC route). */
export const Component = () => {
  return <WhatsappMaxPage />;
};
