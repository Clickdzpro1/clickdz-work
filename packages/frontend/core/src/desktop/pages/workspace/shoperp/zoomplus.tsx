// ZOOM+ — Video conferencing tab for ClickDz Work
// Powered by La Suite Meet (LiveKit, MIT license) + CDZ AI for transcription.
import { useCallback, useEffect, useState } from 'react';
import { C, ensureShoperpResponsiveCss, Spinner, Banner, linkBtnStyle, miniBtnStyle } from './shoperp-shared';
import { provisionApp, withBridgeCode } from './app-provision';

const ZOOMPLUS_URL_KEY = 'cdz.zoomplus.url';

/**
 * Base URL used ONLY for the bridge-code fallback (and as a last resort). Meet
 * is not cookie-shimmed the same way — provisionApp returns the IdP /prime
 * loginUrl which is what actually auto-logs the user in — but we keep the real
 * Meet frontend host as the fallback base. A self-hoster can repoint this via
 * localStorage without a rebuild; there is no fake per-shop host.
 */
const ZOOMPLUS_INSTANCE_URL = 'https://meet-frontend-production.up.railway.app';

function zoomPlusInstanceUrl(): string {
  try {
    const override = localStorage.getItem(ZOOMPLUS_URL_KEY);
    if (override) return override.replace(/\/+$/, '');
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return ZOOMPLUS_INSTANCE_URL;
}

export const ZoomPlusPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: {
  slug: string; readOnly: boolean; onWritesBlocked: () => void; onMutated: () => void;
}) => {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [iframeSrc, setIframeSrc] = useState('');

  // Robust flow: provision the app, then iframe the IdP /prime loginUrl
  // (preferred — stashes the bridge_code as a first-party cookie then redirects
  // into Meet so OIDC auto-approves) or the bridge-code URL. The iframe load IS
  // the health check — no CORS probe.
  const load = useCallback(async () => {
    setStatus('loading');
    const p = await provisionApp('zoomplus');
    if (!p) {
      setStatus('error');
      return;
    }
    setIframeSrc(p.loginUrl || withBridgeCode(zoomPlusInstanceUrl(), p.code));
    setStatus('ready');
  }, []);

  useEffect(() => {
    ensureShoperpResponsiveCss();
    void load();
  }, [slug, load]);

  return (
    <div data-cdz-surface="" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel2, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20 }}>🎥</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>ZOOM+</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>Visioconférence · Powered by La Suite Meet + LiveKit</div>
        </div>
        <button style={miniBtnStyle('secondary')} onClick={() => void load()}>↻ Vérifier</button>
      </div>
      <div style={status === 'ready'
        ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', padding: '16px 20px', background: C.bg }
        : { flex: 1, overflow: 'auto', padding: '24px 20px', background: C.bg }}>
        {status === 'loading' ? <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0' }}><Spinner /> Connexion à ZOOM+…</div>
        : status === 'error' ? (
          <Banner tone="error">Impossible de se connecter à ZOOM+ pour le moment. <button style={linkBtnStyle} onClick={() => void load()}>Réessayer</button></Banner>
        ) : (
          /* The iframe fills the pane (flex:1, height:100%); the explainer is a
             slim footer strip so it never eats the iframe's space. */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
            <div style={{ borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.border}`, background: '#fff', flex: 1, minHeight: 0 }}>
              <iframe src={iframeSrc} style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} title="ZOOM+" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-camera allow-microphone" />
            </div>
            <div style={{ borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: C.muted, flex: 1 }}>🎥 Visioconférence HD dans votre navigateur · Transcription IA par CDZ · 100% open-source</span>
              {['100+ participants','Partage écran','Transcription IA'].map(t=><span key={t} style={{ fontSize: 10.5, fontWeight: 600, color: C.accent, padding: '3px 8px', borderRadius: 999, background: `${C.accentSoft}`, border: `1px solid ${C.accent}30` }}>{t}</span>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
