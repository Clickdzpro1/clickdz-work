// CoursePro — AI-powered LMS tab for ClickDz Work
// Powered by ClassroomIO (open-source LMS) + CDZ AI models.
// Same integration pattern as SlidePro: embed via iframe or API.

import { ViewBody, ViewHeader, ViewIcon, ViewTitle } from '@affine/core/modules/workbench';
import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { C, ensureShoperpResponsiveCss, Spinner, Banner, linkBtnStyle, miniBtnStyle } from './shoperp-shared';
import { provisionApp, withBridgeCode } from './app-provision';

const COURSEPRO_URL_KEY = 'cdz.coursepro.url';

/** ClassroomIO readiness endpoint (probed with a 5s timeout). */
const COURSEPRO_HEALTH_PATH = '/api/health';

/** The deployed shared ClassroomIO instance (Railway service cdz-coursepro). */
const COURSEPRO_DEFAULT_URL = 'https://cdz-coursepro-production.up.railway.app';

/**
 * Shared-instance base URL.
 *
 * The old fallback was `https://coursepro-${slug}.up.railway.app`, which assumed
 * ONE CLASSROOMIO DEPLOYMENT PER SHOP — a host that has never existed and that
 * would not scale past the first merchant anyway. CoursePro is one shared service
 * with per-user workspaces inside it, so the base URL is deployment config, not
 * something to derive from a slug.
 *
 * Resolution order: an explicit per-install override in localStorage, then the
 * build-time env value, then the checked-in default (same pattern as SlidePro).
 */
function courseProBaseUrl(slug: string): string {
  try {
    const override =
      localStorage.getItem(`${COURSEPRO_URL_KEY}_${slug}`) ||
      localStorage.getItem(COURSEPRO_URL_KEY);
    if (override) return override.replace(/\/+$/, '');
  } catch {
    /* storage unavailable — fall through to env */
  }
  const fromEnv =
    typeof process !== 'undefined'
      ? (process.env?.CDZ_COURSEPRO_URL ?? '')
      : '';
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  // process.env is baked at BUILD time, so an env var set on the server would
  // never reach this bundle — a checked-in default makes the tab work out of
  // the box. The localStorage override above still wins for self-hosters.
  return COURSEPRO_DEFAULT_URL;
}

export const CourseProPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: {
  slug: string; readOnly: boolean; onWritesBlocked: () => void; onMutated: () => void;
}) => {
  const [status, setStatus] = useState<'loading'|'ready'|'error'|'unavailable'>('loading');
  const [classroomUrl, setClassroomUrl] = useState('');
  const [iframeSrc, setIframeSrc] = useState('');
  const [deploymentState, setDeploymentState] = useState<'not_deployed'|'deploying'|'deployed'|'failed'>('not_deployed');
  const [healthMsg, setHealthMsg] = useState('');

  useEffect(() => { ensureShoperpResponsiveCss(); checkHealth(); }, [slug]);

  // Render the iframe with the bare URL immediately, then upgrade to a
  // code-bearing URL once the provision call resolves — awaiting the code
  // before first render would just delay the embed on the failure path
  // (provisioning is best-effort; the app loads either way).
  useEffect(() => {
    if (status !== 'ready' || !classroomUrl) return;
    setIframeSrc(classroomUrl);
    let cancelled = false;
    provisionApp('coursepro').then(p => {
      if (!cancelled && p) setIframeSrc(withBridgeCode(classroomUrl, p.code));
    });
    return () => { cancelled = true; };
  }, [status, classroomUrl]);

  const checkHealth = async () => {
    setStatus('loading');
    try {
      const url = courseProBaseUrl(slug);
      // No configured instance: show the deploy CTA instead of probing a host we
      // already know does not exist.
      if (url) {
        const resp = await fetch(`${url}${COURSEPRO_HEALTH_PATH}`, { mode: 'cors', signal: AbortSignal.timeout(5000) });
        if (resp.ok) { setClassroomUrl(url); setStatus('ready'); setDeploymentState('deployed'); return; }
      }
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
        <button style={miniBtnStyle('secondary')} onClick={checkHealth}>↻ Vérifier</button>
      </div>
      <div style={status === 'ready'
        ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', padding: '16px 20px', background: C.bg }
        : { flex: 1, overflow: 'auto', padding: '24px 20px', background: C.bg }}>
        {status === 'loading' ? <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0' }}><Spinner /> Connexion à CoursePro…</div>
        : status === 'ready' && classroomUrl ? (
          /* The iframe must fill the pane, not sit in a fixed 520px box with a
             dead region below it. The wrapper is flex:1 so it takes whatever
             height the pane offers, and the iframe is height:100% of that. The
             "Création de cours IA" explainer used to sit under the iframe — it
             is collapsed into a slim footer strip so it no longer eats the
             iframe's space. */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
            <div style={{ borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.border}`, background: '#fff', flex: 1, minHeight: 0 }}>
              <iframe src={iframeSrc || classroomUrl} style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} title="CoursePro" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
            </div>
            <div style={{ borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: C.muted, flex: 1 }}>🚀 Cours, leçons et exercices générés par vos modèles CDZ AI · Cohorts · Certificats</span>
              {['AI Course Builder','Cohorts','Certificats'].map(t=><span key={t} style={{ fontSize: 10.5, fontWeight: 600, color: C.accent, padding: '3px 8px', borderRadius: 999, background: `${C.accentSoft}`, border: `1px solid ${C.accent}30` }}>{t}</span>)}
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
