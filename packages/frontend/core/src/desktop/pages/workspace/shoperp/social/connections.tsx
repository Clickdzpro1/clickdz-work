// social/connections.tsx — Connections dashboard.
// Renders the 10 social networks with per-card connect/disconnect/status.
// Uses GET /api/v1/social/accounts (single call) and DELETE /:network + POST /:network/connect.

import { useCallback, useEffect, useState } from 'react';
import { Banner, C, miniBtnStyle, Spinner } from '../shoperp-shared';
import {
  connectAccount,
  disconnectAccount,
  fetchAccounts,
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
  const [busy, setBusy] = useState<Record<string, 'connecting' | 'disconnecting'>>({});
  const [note, setNote] = useState<{ slug: string; text: string; tone: 'ok' | 'err' } | null>(null);

  const refresh = useCallback(async () => {
    setEnabled(null);
    try {
      const resp = await fetchAccounts();
      setEnabled(resp.enabled);
      if (resp.enabled) {
        const map: Record<string, boolean> = {};
        for (const a of resp.accounts) map[a.network] = a.connected;
        setAccounts(map);
      }
    } catch {
      setEnabled(false);
    }
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
  }, [dict, refresh]);

  const disconnect = useCallback(async (slug: string) => {
    setBusy(b => ({ ...b, [slug]: 'disconnecting' }));
    setNote(null);
    try {
      const res = await disconnectAccount(slug);
      if (res.ok) {
        setNote({ slug, text: dict.disconnected ?? 'Déconnecté.', tone: 'ok' });
        setAccounts(prev => ({ ...prev, [slug]: false }));
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
                    background: isConn ? C.accent : C.border,
                    color: isConn ? '#fff' : C.muted,
                  }}
                >
                  {isConn ? (dict.connected ?? 'Connecté') : (dict.disconnectedBadge ?? 'Non connecté')}
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
