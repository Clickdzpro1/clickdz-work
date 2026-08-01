// ZOOM+ — Video conferencing tab for ClickDz Work
// Powered by La Suite Meet (LiveKit, MIT license) + CDZ AI for transcription.
import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { C, ensureShoperpResponsiveCss, Spinner, Banner, linkBtnStyle, miniBtnStyle } from './shoperp-shared';
import { provisionApp, withBridgeCode } from './app-provision';

const ZOOMPLUS_URL_KEY = 'cdz.zoomplus.url';

/** La Suite Meet readiness endpoint (probed with a 5s timeout). */
const ZOOMPLUS_HEALTH_PATH = '/api/health';

/** The deployed shared La Suite Meet instance (Railway service cdz-zoomplus). */
const ZOOMPLUS_DEFAULT_URL = 'https://meet-frontend-production.up.railway.app';

/**
 * Shared-instance base URL.
 *
 * The old fallback was `https://zoomplus-${slug}.up.railway.app`, which assumed
 * ONE MEET DEPLOYMENT PER SHOP — a host that has never existed and that
 * would not scale past the first merchant anyway. ZOOM+ is one shared service
 * with per-user workspaces inside it, so the base URL is deployment config, not
 * something to derive from a slug.
 *
 * Resolution order: an explicit per-install override in localStorage, then the
 * build-time env value, then the checked-in default (same pattern as SlidePro).
 */
function zoomPlusBaseUrl(slug: string): string {
  try {
    const override =
      localStorage.getItem(`${ZOOMPLUS_URL_KEY}_${slug}`) ||
      localStorage.getItem(ZOOMPLUS_URL_KEY);
    if (override) return override.replace(/\/+$/, '');
  } catch {
    /* storage unavailable — fall through to env */
  }
  const fromEnv =
    typeof process !== 'undefined'
      ? (process.env?.CDZ_ZOOMPLUS_URL ?? '')
      : '';
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  // process.env is baked at BUILD time, so an env var set on the server would
  // never reach this bundle — a checked-in default makes the tab work out of
  // the box. The localStorage override above still wins for self-hosters.
  return ZOOMPLUS_DEFAULT_URL;
}

export const ZoomPlusPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: {
  slug: string; readOnly: boolean; onWritesBlocked: () => void; onMutated: () => void;
}) => {
  const [status, setStatus] = useState<'loading'|'ready'|'error'|'unavailable'>('loading');
  const [meetUrl, setMeetUrl] = useState('');
  const [iframeSrc, setIframeSrc] = useState('');
  const [deploymentState, setDeploymentState] = useState<'not_deployed'|'deploying'|'deployed'|'failed'>('not_deployed');
  const [healthMsg, setHealthMsg] = useState('');

  useEffect(() => { ensureShoperpResponsiveCss(); checkHealth(); }, [slug]);

  // Render the iframe with the bare URL immediately, then upgrade to a
  // code-bearing URL once the provision call resolves — awaiting the code
  // before first render would just delay the embed on the failure path
  // (provisioning is best-effort; the app loads either way).
  useEffect(() => {
    if (status !== 'ready' || !meetUrl) return;
    setIframeSrc(meetUrl);
    let cancelled = false;
    provisionApp('zoomplus').then(p => {
      if (!cancelled && p) setIframeSrc(withBridgeCode(meetUrl, p.code));
    });
    return () => { cancelled = true; };
  }, [status, meetUrl]);

  const checkHealth = async () => {
    setStatus('loading');
    try {
      const url = zoomPlusBaseUrl(slug);
      // No configured instance: show the deploy CTA instead of probing a host we
      // already know does not exist.
      if (url) {
        const resp = await fetch(`${url}${ZOOMPLUS_HEALTH_PATH}`, { mode: 'cors', signal: AbortSignal.timeout(5000) });
        if (resp.ok) { setMeetUrl(url); setStatus('ready'); setDeploymentState('deployed'); return; }
      }
    } catch {}
    setStatus('unavailable'); setDeploymentState('not_deployed');
    setHealthMsg('ZOOM+ n\'est pas encore déployé.');
  };

  const deploy = async () => {
    setDeploymentState('deploying');
    try {
      const resp = await fetch(`/api/v1/apps/${slug}/zoomplus/deploy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: 'ghcr.io/suitenumerique/meet:latest', ai_provider: 'cdz' }),
      });
      if (!resp.ok) throw new Error('Deploy failed');
      const { url } = await resp.json();
      localStorage.setItem(`${ZOOMPLUS_URL_KEY}_${slug}`, url);
      setMeetUrl(url); setDeploymentState('deployed'); setStatus('ready'); onMutated();
    } catch (err: any) { setDeploymentState('failed'); setHealthMsg(err.message || 'Échec'); onWritesBlocked(); }
  };

  return (
    <div data-cdz-surface="" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel2, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20 }}>🎥</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>ZOOM+</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>Visioconférence · Powered by La Suite Meet + LiveKit</div>
        </div>
        <button style={miniBtnStyle('secondary')} onClick={checkHealth}>↻ Vérifier</button>
      </div>
      <div style={status === 'ready'
        ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', padding: '16px 20px', background: C.bg }
        : { flex: 1, overflow: 'auto', padding: '24px 20px', background: C.bg }}>
        {status === 'loading' ? <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0' }}><Spinner /> Connexion à ZOOM+…</div>
        : status === 'ready' && meetUrl ? (
          /* The iframe must fill the pane, not sit in a fixed 520px box with a
             dead region below it. The wrapper is flex:1 so it takes whatever
             height the pane offers, and the iframe is height:100% of that. The
             "Réunions haute qualité" explainer used to sit under the iframe —
             it is collapsed into a slim footer strip so it no longer eats the
             iframe's space. */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
            <div style={{ borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.border}`, background: '#fff', flex: 1, minHeight: 0 }}>
              <iframe src={iframeSrc || meetUrl} style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} title="ZOOM+" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-camera allow-microphone" />
            </div>
            <div style={{ borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: C.muted, flex: 1 }}>🎥 Visioconférence HD dans votre navigateur · Transcription IA par CDZ · 100% open-source</span>
              {['100+ participants','Partage écran','Transcription IA'].map(t=><span key={t} style={{ fontSize: 10.5, fontWeight: 600, color: C.accent, padding: '3px 8px', borderRadius: 999, background: `${C.accentSoft}`, border: `1px solid ${C.accent}30` }}>{t}</span>)}
            </div>
          </div>
        ) : deploymentState === 'not_deployed' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 640 }}>
            <div style={{ borderRadius: 16, border: `1px solid ${C.border}`, background: `linear-gradient(135deg, ${C.accentSoft}, transparent)`, padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>🎥 ZOOM+ — Visioconférence open-source</div>
                <p style={{ margin: '8px 0 0', fontSize: 13.5, color: C.muted, lineHeight: 1.6 }}>Réunions vidéo haute qualité dans votre navigateur. ZOOM+ est propulsé par <strong>La Suite Meet</strong> (LiveKit, MIT) — 100+ participants, aucune installation.</p>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                {[{icon:'🎥',title:'Vidéo HD',desc:'Qualité Zoom, 100+ participants'},{icon:'🖥️',title:'Partage écran',desc:'Multi-flux de partage'},{icon:'🎙️',title:'Transcription IA',desc:'CDZ AI pour les résumés'},{icon:'🔒',title:'Sécurisé',desc:'E2E encryption, auth robuste'}].map(f=><div key={f.title} style={{ background: C.panel, borderRadius: 10, padding: '12px 14px', border: `1px solid ${C.border}` }}><div style={{ fontSize: 18, marginBottom: 4 }}>{f.icon}</div><div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{f.title}</div><div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{f.desc}</div></div>)}
              </div>
              <button onClick={deploy} style={{ padding: '14px 28px', borderRadius: 12, border: 'none', background: C.accent, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', alignSelf: 'flex-start' }}>🚀 Déployer ZOOM+ sur Railway</button>
              <div style={{ fontSize: 11.5, color: C.muted }}>Déploie La Suite Meet + LiveKit sur Railway · Transcription IA par CDZ · Temps estimé : 3-5 minutes</div>
            </div>
            <div style={{ borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel, padding: '14px 18px', fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
              <strong style={{ color: C.text }}>Détails techniques :</strong><br />
              • Repo : <code style={{ background: C.panel2, padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>github.com/suitenumerique/meet</code><br />
              • Stack : Django + Vite.js + LiveKit + React Aria<br />
              • IA : CDZ AI pour transcription et résumés<br />
              • Licence : MIT (open-source)<br />
              • Déployé par le gouvernement français 🇫🇷 pour 100k+ agents publics
            </div>
          </div>
        ) : deploymentState === 'deploying' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '60px 20px' }}>
            <Spinner />
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Déploiement de ZOOM+…</div>
            <div style={{ fontSize: 12.5, color: C.muted, textAlign: 'center', maxWidth: 400 }}>Railway provisionne La Suite Meet + LiveKit. Cela prend 3-5 minutes.</div>
          </div>
        ) : (
          <Banner tone="error">{healthMsg || 'Connexion impossible.'} <button style={linkBtnStyle} onClick={checkHealth}>Réessayer</button></Banner>
        )}
      </div>
    </div>
  );
};
