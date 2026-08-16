// social/connections.tsx — Connections dashboard.
// Renders the 10 social networks with per-card connect/disconnect/status.
// Uses GET /api/v1/social/accounts (single call) and DELETE /:network + POST /:network/connect.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, C, miniBtnStyle, Spinner } from '../shoperp-shared';
import {
  connectAccount,
  disconnectAccount,
  fetchAccounts,
  fetchAccountStatus,
  getNetworkMeta,
  SOCIAL_NETWORKS,
} from './api';

interface Props {
  lang: 'fr' | 'ar' | 'en';
  dict: Record<string, string>;
}

export const ConnectionsView = ({ lang, dict }: Props) => {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<Record<string, boolean>>({});
  // UP1 — live Composio status per network (ACTIVE | INITIATED | EXPIRED | …).
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, 'connecting' | 'disconnecting'>>({});
  const [note, setNote] = useState<{ slug: string; text: string; tone: 'ok' | 'err' } | null>(null);
  // Track in-flight status pollers so we can clear them on unmount.
  const pollers = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const refresh = useCallback(async () => {
    setEnabled(null);
    try {
      const resp = await fetchAccounts();
      setEnabled(resp.enabled);
      if (resp.enabled) {
        const map: Record<string, boolean> = {};
        const stMap: Record<string, string> = {};
        for (const a of resp.accounts) {
          map[a.network] = a.connected;
          if (a.status) stMap[a.network] = a.status;
        }
        setAccounts(map);
        setStatuses(stMap);
      }
    } catch {
      setEnabled(false);
    }
  }, []);

  // Clear any pollers on unmount.
  useEffect(() => {
    const active = pollers.current;
    return () => {
      for (const id of Object.values(active)) clearInterval(id);
    };
  }, []);

  /**
   * UP1 — after opening the OAuth tab, poll this network's status every ~4s for
   * up to ~2min. When it flips to connected we update the card + stop; otherwise
   * we give up quietly (the user can click Refresh). Idempotent per network.
   */
  const startPolling = useCallback((slug: string) => {
    if (pollers.current[slug]) clearInterval(pollers.current[slug]);
    let ticks = 0;
    const id = setInterval(() => {
      ticks++;
      void fetchAccountStatus(slug).then(st => {
        if (st.status) setStatuses(prev => ({ ...prev, [slug]: st.status }));
        if (st.connected) {
          setAccounts(prev => ({ ...prev, [slug]: true }));
          clearInterval(pollers.current[slug]);
          delete pollers.current[slug];
        }
      });
      if (ticks >= 30) {
        clearInterval(pollers.current[slug]);
        delete pollers.current[slug];
      }
    }, 4000);
    pollers.current[slug] = id;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(async (slug: string) => {
    setBusy(b => ({ ...b, [slug]: 'connecting' }));
    setNote(null);
    try {
      const res = await connectAccount(slug);
      if (res.ok && res.redirectUrl) {
        window.open(res.redirectUrl, '_blank', 'noopener,noreferrer');
        setNote({ slug, text: dict.connectOpened ?? 'Autorisation ouverte dans un nouvel onglet. Finalisez-la, puis actualisez.', tone: 'ok' });
        // UP1 — start polling so the card flips to Connecté automatically once
        // the user finishes the hosted OAuth flow (no manual refresh needed).
        startPolling(slug);
      } else if (res.error === 'not_configured') {
        setNote({ slug, text: dict.notConfigured ?? 'CDZ Connect n’est pas configuré sur ce serveur.', tone: 'err' });
      } else if (res.error === 'toolkit_auth_unconfigured') {
        const meta = getNetworkMeta(slug);
        setNote({ slug, text: `"${meta?.label ?? slug}" ${dict.authUnconfigured ?? 'n’est pas encore disponible via CDZ Connect.'}`, tone: 'err' });
      } else {
        setNote({ slug, text: res.detail ?? dict.connectFail ?? 'La connexion a échoué. Réessayez.', tone: 'err' });
      }
    } catch {
      setNote({ slug, text: dict.connectFail ?? 'La connexion a échoué. Réessayez.', tone: 'err' });
    } finally {
      setBusy(b => { const n = { ...b }; delete n[slug]; return n; });
      setTimeout(() => void refresh(), 1500);
    }
  }, [dict, refresh, startPolling]);

  const disconnect = useCallback(async (slug: string) => {
    setBusy(b => ({ ...b, [slug]: 'disconnecting' }));
    setNote(null);
    try {
      const res = await disconnectAccount(slug);
      if (res.ok) {
        setNote({ slug, text: dict.disconnected ?? 'Déconnecté.', tone: 'ok' });
        setAccounts(prev => ({ ...prev, [slug]: false }));
        setStatuses(prev => { const n = { ...prev }; delete n[slug]; return n; });
      } else if (res.error === 'not_configured') {
        setNote({ slug, text: dict.notConfigured ?? 'CDZ Connect n’est pas configuré.', tone: 'err' });
      } else {
        setNote({ slug, text: dict.disconnectFail ?? 'La déconnexion a échoué. Réessayez.', tone: 'err' });
      }
    } catch {
      setNote({ slug, text: dict.disconnectFail ?? 'La déconnexion a échoué. Réessayez.', tone: 'err' });
    } finally {
      setBusy(b => { const n = { ...b }; delete n[slug]; return n; });
    }
  }, [dict]);

  const rtl = lang === 'ar';

  if (enabled === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0' }}>
        <Spinner />
        <span dir={rtl ? 'rtl' : undefined}>{dict.loading ?? 'Chargement…'}</span>
      </div>
    );
  }

  if (enabled === false) {
    return <Banner tone="error">{dict.notConfiguredBanner ?? 'CDZ Connect n’est pas configuré (COMPOSIO_API_KEY manquant).'}</Banner>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text, direction: rtl ? 'rtl' : undefined }}>
          {dict.connectNetworks ?? 'Connectez vos réseaux'}
        </div>
        <button style={miniBtnStyle('secondary')} onClick={() => void refresh()}>
          {dict.refresh ?? 'Actualiser'}
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
        {SOCIAL_NETWORKS.map(net => {
          const isConn = !!accounts[net.slug];
          const busyState = busy[net.slug];
          const isBusy = !!busyState;
          const myNote = note?.slug === net.slug ? note : null;
          // UP1 — derive the badge from the live Composio status when present.
          const rawStatus = statuses[net.slug];
          const badge = statusBadge(isConn, rawStatus, dict);
          return (
            <div
              key={net.slug}
              style={{
                borderRadius: 12,
                border: `1px solid ${isConn ? C.accent + '55' : C.border}`,
                background: isConn ? C.accentSoft : C.panel,
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 18, width: 24, textAlign: 'center', fontWeight: 800 }}>{net.icon}</span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: C.text }}>{net.label}</span>
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: '2px 7px',
                    borderRadius: 999,
                    background: badge.bg,
                    color: badge.color,
                  }}
                >
                  {badge.label}
                </span>
              </div>
              {net.mediaRequired && (
                <div style={{ fontSize: 10.5, color: C.muted, direction: rtl ? 'rtl' : undefined }}>
                  {dict.mediaRequired ?? 'Média requis'}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                {!isConn ? (
                  <button
                    disabled={isBusy}
                    onClick={() => void connect(net.slug)}
                    style={{ ...miniBtnStyle('primary'), flex: 1, opacity: isBusy ? 0.6 : 1 }}
                  >
                    {busyState === 'connecting' ? (dict.connecting ?? 'Connexion…') : (dict.connect ?? 'Connecter')}
                  </button>
                ) : (
                  <button
                    disabled={isBusy}
                    onClick={() => void disconnect(net.slug)}
                    style={{ ...miniBtnStyle('secondary'), flex: 1, opacity: isBusy ? 0.6 : 1 }}
                  >
                    {busyState === 'disconnecting' ? (dict.disconnecting ?? 'Déconnexion…') : (dict.disconnect ?? 'Déconnecter')}
                  </button>
                )}
              </div>
              {myNote && (
                <div style={{ fontSize: 11, color: myNote.tone === 'ok' ? C.okText : '#c8283a', direction: rtl ? 'rtl' : undefined }}>
                  {myNote.text}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * UP1 — map (connected boolean + live Composio status) to a badge {label,bg,color}.
 * ACTIVE / connected → accent. INITIATED/INITIALIZING → amber "En attente…".
 * EXPIRED/FAILED → red. Fallback to the connected/not-connected boolean.
 */
function statusBadge(
  isConn: boolean,
  status: string | undefined,
  dict: Record<string, string>
): { label: string; bg: string; color: string } {
  const s = (status ?? '').toUpperCase();
  if (isConn || s === 'ACTIVE') {
    return { label: dict.connStatusActive ?? dict.connected ?? 'Actif', bg: C.accent, color: '#fff' };
  }
  if (s === 'INITIATED' || s === 'INITIALIZING') {
    return { label: dict.connStatusPending ?? 'En attente…', bg: '#e8a33d33', color: '#e8a33d' };
  }
  if (s === 'EXPIRED') {
    return { label: dict.connStatusExpired ?? 'Expiré', bg: '#c8283a22', color: '#c8283a' };
  }
  if (s === 'FAILED') {
    return { label: dict.connStatusFailed ?? 'Échec', bg: '#c8283a22', color: '#c8283a' };
  }
  return { label: dict.disconnectedBadge ?? 'Non connecté', bg: C.border, color: C.muted };
}
