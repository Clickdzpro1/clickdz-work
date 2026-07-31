// CoursePro — AI-powered LMS tab for ClickDz Work
// Powered by ClassroomIO (open-source LMS) + CDZ AI models.
// Same integration pattern as SlidePro: embed via iframe or API.

import { ViewBody, ViewHeader, ViewIcon, ViewTitle } from '@affine/core/modules/workbench';
import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { C, ensureShoperpResponsiveCss, Spinner, Banner, linkBtnStyle, miniBtnStyle } from './shoperp-shared';

const COURSEPRO_URL_KEY = 'cdz.coursepro.url';

export const CourseProPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: {
  slug: string; readOnly: boolean; onWritesBlocked: () => void; onMutated: () => void;
}) => {
  const [status, setStatus] = useState<'loading'|'ready'|'error'|'unavailable'>('loading');
  const [classroomUrl, setClassroomUrl] = useState('');
  const [deploymentState, setDeploymentState] = useState<'not_deployed'|'deploying'|'deployed'|'failed'>('not_deployed');
  const [healthMsg, setHealthMsg] = useState('');

  useEffect(() => { ensureShoperpResponsiveCss(); checkHealth(); }, [slug]);

  const checkHealth = async () => {
    setStatus('loading');
    try {
      const stored = localStorage.getItem(`${COURSEPRO_URL_KEY}_${slug}`);
      const url = stored || `https://coursepro-${slug}.up.railway.app`;
      const resp = await fetch(`${url}/api/health`, { mode: 'cors', signal: AbortSignal.timeout(5000) });
      if (resp.ok) { setClassroomUrl(url); setStatus('ready'); setDeploymentState('deployed'); return; }
    } catch {}
    setStatus('unavailable'); setDeploymentState('not_deployed');
    setHealthMsg('CoursePro n\'est pas encore déployé pour cet ERP.');
  };

  const deploy = async () => {
    setDeploymentState('deploying');
    try {
      const resp = await fetch(`/api/v1/apps/${slug}/coursepro/deploy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: 'ghcr.io/classroomio/classroomio:latest', ai_provider: 'cdz' }),
      });
      if (!resp.ok) throw new Error((await resp.json().catch(()=>({message:'Deploy failed'}))).message || 'Deploy failed');
      const { url } = await resp.json();
      localStorage.setItem(`${COURSEPRO_URL_KEY}_${slug}`, url);
      setClassroomUrl(url); setDeploymentState('deployed'); setStatus('ready'); onMutated();
    } catch (err: any) { setDeploymentState('failed'); setHealthMsg(err.message || 'Le déploiement a échoué'); onWritesBlocked(); }
  };

  return (
    <div data-cdz-surface="" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel2, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20 }}>🎓</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>CoursePro</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>LMS IA · Powered by ClassroomIO + CDZ AI</div>
        </div>
        {status === 'ready' ? <a href={classroomUrl} target="_blank" rel="noopener noreferrer" style={{ ...miniBtnStyle('secondary'), textDecoration: 'none' }}>Ouvrir CoursePro ↗</a> : null}
        <button style={miniBtnStyle('secondary')} onClick={checkHealth}>↻ Vérifier</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 20px', background: C.bg }}>
        {status === 'loading' ? <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0' }}><Spinner /> Connexion à CoursePro…</div>
        : status === 'ready' && classroomUrl ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.border}`, background: '#fff', minHeight: 520 }}>
              <iframe src={classroomUrl} style={{ width: '100%', height: 520, border: 'none' }} title="CoursePro" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
            </div>
            <div style={{ borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel, padding: '18px 20px' }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 8 }}>🚀 Création de cours IA</div>
              <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6 }}>CoursePro utilise vos modèles CDZ AI pour générer des cours, leçons et exercices. Créez des cohorts, suivez la progression, délivrez des certificats.</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {['AI Course Builder','Cohorts','Certificats','Multilingue','REST API','MCP Server'].map(t=><span key={t} style={{ fontSize: 11, fontWeight: 600, color: C.accent, padding: '4px 10px', borderRadius: 999, background: `${C.accentSoft}`, border: `1px solid ${C.accent}30` }}>{t}</span>)}
              </div>
            </div>
          </div>
        ) : deploymentState === 'not_deployed' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 640 }}>
            <div style={{ borderRadius: 16, border: `1px solid ${C.border}`, background: `linear-gradient(135deg, ${C.accentSoft}, transparent)`, padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>🎓 CoursePro — LMS propulsé par l'IA</div>
                <p style={{ margin: '8px 0 0', fontSize: 13.5, color: C.muted, lineHeight: 1.6 }}>Créez et gérez des cours en ligne avec l'IA. CoursePro est propulsé par <strong>ClassroomIO</strong> (open-source) — vos données restent sur votre infrastructure Railway.</p>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                {[{icon:'🤖',title:'AI Course Builder',desc:'Générez cours et leçons'},{icon:'👥',title:'Cohorts',desc:'Groupes avec objectifs'},{icon:'📜',title:'Certificats',desc:'Certificats personnalisés'},{icon:'🌍',title:'Multilingue',desc:'10+ langues supportées'}].map(f=><div key={f.title} style={{ background: C.panel, borderRadius: 10, padding: '12px 14px', border: `1px solid ${C.border}` }}><div style={{ fontSize: 18, marginBottom: 4 }}>{f.icon}</div><div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{f.title}</div><div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{f.desc}</div></div>)}
              </div>
              <button onClick={deploy} style={{ padding: '14px 28px', borderRadius: 12, border: 'none', background: C.accent, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', alignSelf: 'flex-start' }}>🚀 Déployer CoursePro sur Railway</button>
              <div style={{ fontSize: 11.5, color: C.muted }}>Déploie ClassroomIO comme service Docker sur Railway · Configuré avec vos modèles CDZ AI · Temps estimé : 3-5 minutes</div>
            </div>
            <div style={{ borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel, padding: '14px 18px', fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
              <strong style={{ color: C.text }}>Détails techniques :</strong><br />
              • Repo : <code style={{ background: C.panel2, padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>github.com/classroomio/classroomio</code><br />
              • Stack : SvelteKit + Hono + PostgreSQL<br />
              • IA : CDZ AI (Gemini + OpenAI compatible)<br />
              • Licence : Open-source<br />
              • API REST + Webhooks + MCP server
            </div>
          </div>
        ) : deploymentState === 'deploying' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '60px 20px' }}>
            <Spinner />
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Déploiement de CoursePro en cours…</div>
            <div style={{ fontSize: 12.5, color: C.muted, textAlign: 'center', maxWidth: 400 }}>Railway provisionne le conteneur ClassroomIO avec vos modèles CDZ AI. Cela prend environ 3-5 minutes.</div>
          </div>
        ) : (
          <Banner tone="error">{healthMsg || 'Impossible de se connecter à CoursePro.'} <button style={linkBtnStyle} onClick={checkHealth}>Réessayer</button></Banner>
        )}
      </div>
    </div>
  );
};
