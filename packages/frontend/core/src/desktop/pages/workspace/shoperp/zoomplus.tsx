// ZOOM+ — Video conferencing tab for ClickDz Work
// Powered by La Suite Meet (LiveKit, MIT license) + CDZ AI for transcription.
import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { C, ensureShoperpResponsiveCss, Spinner, Banner, linkBtnStyle, miniBtnStyle } from './shoperp-shared';

const ZOOMPLUS_URL_KEY = 'cdz.zoomplus.url';

export const ZoomPlusPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: {
  slug: string; readOnly: boolean; onWritesBlocked: () => void; onMutated: () => void;
}) => {
  const [status, setStatus] = useState<'loading'|'ready'|'error'|'unavailable'>('loading');
  const [meetUrl, setMeetUrl] = useState('');
  const [deploymentState, setDeploymentState] = useState<'not_deployed'|'deploying'|'deployed'|'failed'>('not_deployed');
  const [healthMsg, setHealthMsg] = useState('');

  useEffect(() => { ensureShoperpResponsiveCss(); checkHealth(); }, [slug]);

  const checkHealth = async () => {
    setStatus('loading');
    try {
      const stored = localStorage.getItem(`${ZOOMPLUS_URL_KEY}_${slug}`);
      const url = stored || `https://zoomplus-${slug}.up.railway.app`;
      const resp = await fetch(`${url}/api/health`, { mode: 'cors', signal: AbortSignal.timeout(5000) });
      if (resp.ok) { setMeetUrl(url); setStatus('ready'); setDeploymentState('deployed'); return; }
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
        {status === 'ready' ? <a href={meetUrl} target="_blank" rel="noopener noreferrer" style={{ ...miniBtnStyle('secondary'), textDecoration: 'none' }}>Ouvrir ZOOM+ ↗</a> : null}
        <button style={miniBtnStyle('secondary')} onClick={checkHealth}>↻ Vérifier</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 20px', background: C.bg }}>
        {status === 'loading' ? <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0' }}><Spinner /> Connexion à ZOOM+…</div>
        : status === 'ready' && meetUrl ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.border}`, background: '#fff', minHeight: 520 }}>
              <iframe src={meetUrl} style={{ width: '100%', height: 520, border: 'none' }} title="ZOOM+" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-camera allow-microphone" />
            </div>
            <div style={{ borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel, padding: '18px 20px' }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 8 }}>🎥 Réunions haute qualité</div>
              <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6 }}>ZOOM+ offre une visioconférence niveau Zoom, directement dans votre navigateur. 100+ participants, partage d'écran, transcription IA avec CDZ.</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {['100+ participants','Partage écran','Enregistrement','Transcription IA','E2E encryption','SVC codecs (VP9, AV1)'].map(t=><span key={t} style={{ fontSize: 11, fontWeight: 600, color: C.accent, padding: '4px 10px', borderRadius: 999, background: `${C.accentSoft}`, border: `1px solid ${C.accent}30` }}>{t}</span>)}
              </div>
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
