// social/log.tsx — Published log + best-effort analytics.
// GET /api/v1/social/log always available.
// GET /api/v1/social/analytics/:network — behind a soft "unavailable" state.

import { useCallback, useEffect, useState } from 'react';
import { C, miniBtnStyle, Spinner } from '../shoperp-shared';
import {
  fetchAnalytics,
  fetchLog,
  getNetworkMeta,
  type AnalyticsResponse,
  type PublishedLogEntry,
} from './api';
import { SOCIAL_NETWORKS } from './api';

interface Props {
  lang: 'fr' | 'ar' | 'en';
  dict: Record<string, string>;
  refresh?: number;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export const LogView = ({ lang, dict, refresh }: Props) => {
  const rtl = lang === 'ar';
  const [tab, setTab] = useState<'log' | 'analytics'>('log');
  const [log, setLog] = useState<PublishedLogEntry[]>([]);
  const [loadingLog, setLoadingLog] = useState(true);
  const [analyticsNet, setAnalyticsNet] = useState(SOCIAL_NETWORKS[0].slug);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);

  const loadLog = useCallback(async () => {
    setLoadingLog(true);
    try {
      setLog(await fetchLog());
    } catch {
      setLog([]);
    } finally {
      setLoadingLog(false);
    }
  }, []);

  const loadAnalytics = useCallback(async (network: string) => {
    setLoadingAnalytics(true);
    setAnalytics(null);
    try {
      setAnalytics(await fetchAnalytics(network));
    } catch {
      setAnalytics({ available: false, network });
    } finally {
      setLoadingAnalytics(false);
    }
  }, []);

  useEffect(() => {
    void loadLog();
  }, [loadLog, refresh]);

  useEffect(() => {
    if (tab === 'analytics') {
      void loadAnalytics(analyticsNet);
    }
  }, [tab, analyticsNet, loadAnalytics]);

  const tabStyle = (t: string) => ({
    fontSize: 12,
    fontWeight: tab === t ? 700 : 500,
    padding: '5px 12px',
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    background: tab === t ? C.accent : 'transparent',
    color: tab === t ? '#fff' : C.muted,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, paddingBottom: 8 }}>
        <button style={tabStyle('log')} onClick={() => setTab('log')}>
          {dict.publishedLog ?? 'Journal des publications'}
        </button>
        <button style={tabStyle('analytics')} onClick={() => setTab('analytics')}>
          {dict.analytics ?? 'Statistiques'}
        </button>
        <button style={{ ...miniBtnStyle('secondary'), marginLeft: 'auto' }} onClick={() => tab === 'log' ? void loadLog() : void loadAnalytics(analyticsNet)}>
          {dict.refresh ?? 'Actualiser'}
        </button>
      </div>

      {tab === 'log' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loadingLog ? (
            <div style={{ display: 'flex', gap: 8, color: C.muted }}><Spinner /> {dict.loading ?? 'Chargement…'}</div>
          ) : log.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 13 }}>{dict.noLog ?? 'Aucune publication pour le moment.'}</div>
          ) : (
            log.map(entry => (
              <div
                key={entry.postId}
                style={{
                  borderRadius: 10,
                  border: `1px solid ${C.border}`,
                  background: C.panel,
                  padding: '12px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11.5, color: C.accent, fontWeight: 700 }}>{fmtTime(entry.publishedAt)}</span>
                  <span style={{ fontSize: 11, color: C.muted }}>{dict.postId ?? 'ID de publication :'} {entry.postId.slice(0, 8)}…</span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {entry.results.map(r => {
                    const meta = getNetworkMeta(r.network);
                    return (
                      <div
                        key={r.network}
                        style={{
                          fontSize: 11,
                          padding: '2px 8px',
                          borderRadius: 6,
                          background: r.ok ? '#4cae4c22' : '#c8283a22',
                          color: r.ok ? C.okText : '#c8283a',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <span>{meta?.icon ?? r.network[0]}</span>
                        <span>{meta?.label ?? r.network}</span>
                        <span>{r.ok ? '✓' : '✕'}</span>
                        {r.ok && r.externalUrl && (
                          <a
                            href={r.externalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: C.accent, textDecoration: 'none', fontSize: 10 }}
                          >
                            ↗
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'analytics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: C.muted, direction: rtl ? 'rtl' : undefined }}>
              {dict.selectNetwork ?? 'Réseau :'}
            </span>
            <select
              value={analyticsNet}
              onChange={e => { setAnalyticsNet(e.target.value); void loadAnalytics(e.target.value); }}
              style={{ fontSize: 12, borderRadius: 8, border: `1px solid ${C.border}`, background: C.panel2, color: C.text, padding: '5px 8px' }}
            >
              {SOCIAL_NETWORKS.map(n => (
                <option key={n.slug} value={n.slug}>{n.label}</option>
              ))}
            </select>
          </div>

          {loadingAnalytics ? (
            <div style={{ display: 'flex', gap: 8, color: C.muted }}><Spinner /> {dict.loading ?? 'Chargement…'}</div>
          ) : analytics && analytics.available ? (
            <div style={{ borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel, padding: '14px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>
                {getNetworkMeta(analytics.network)?.label ?? analytics.network} {dict.analyticsData ?? 'Statistiques'}
              </div>
              <pre style={{ fontSize: 11, color: C.text, background: C.panel2, borderRadius: 8, padding: 10, overflow: 'auto', maxHeight: 300 }}>
                {JSON.stringify(analytics.data, null, 2)}
              </pre>
            </div>
          ) : (
            <div style={{
              borderRadius: 10,
              border: `1px solid ${C.border}`,
              background: C.panel,
              padding: '24px',
              textAlign: 'center',
              color: C.muted,
              fontSize: 13,
            }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {dict.analyticsUnavailable ?? 'Statistiques non disponibles pour ce réseau'}
              </div>
              <div style={{ fontSize: 11.5 }}>
                {dict.analyticsUnavailableHint ?? 'Composio ne propose pas encore d’action de statistiques pour ce réseau.'}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
