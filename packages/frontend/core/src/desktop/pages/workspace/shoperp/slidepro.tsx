import { ViewBody, ViewHeader, ViewIcon, ViewTitle } from '@affine/core/modules/workbench';
import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { C, ensureShoperpResponsiveCss, Spinner, Banner, linkBtnStyle, miniBtnStyle } from './shoperp-shared';
/* SlidePro - AI Presentation Generator powered by Presenton (Apache 2.0) + CDZ AI */

const SLIDEPRO_URL_KEY = 'cdz.slidepro.url';

/**
 * Presenton's readiness endpoint.
 *
 * This probed `/api/health`, which DOES NOT EXIST in Presenton — so the check
 * could only ever fail and the tab was permanently stuck on "not deployed",
 * even once a real instance was running. `/api/v1/auth/status` is the actual
 * unauthenticated status route (FastAPI, behind the container's nginx).
 */
const SLIDEPRO_HEALTH_PATH = '/api/v1/auth/status';

/**
 * Shared-instance base URL.
 *
 * The old fallback was `https://slidepro-${slug}.up.railway.app`, which assumed
 * ONE PRESENTON DEPLOYMENT PER SHOP — a host that has never existed and that
 * would not scale past the first merchant anyway. SlidePro is one shared service
 * with per-user workspaces inside it, so the base URL is deployment config, not
 * something to derive from a slug.
 *
 * Resolution order: an explicit per-install override in localStorage, then the
 * build-time env value, then empty (which renders the deploy CTA rather than
 * probing a host we know is fake).
 */
function slideProBaseUrl(slug: string): string {
  try {
    const override =
      localStorage.getItem(`${SLIDEPRO_URL_KEY}_${slug}`) ||
      localStorage.getItem(SLIDEPRO_URL_KEY);
    if (override) return override.replace(/\/+$/, '');
  } catch {
    /* storage unavailable — fall through to env */
  }
  const fromEnv =
    typeof process !== 'undefined'
      ? (process.env?.CDZ_SLIDEPRO_URL ?? '')
      : '';
  return fromEnv.replace(/\/+$/, '');
}

export const SlideProPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: { slug: string; readOnly: boolean; onWritesBlocked: () => void; onMutated: () => void }) => {
  const [status, setStatus] = useState<'loading'|'ready'|'error'|'unavailable'>('loading');
  const [presentonUrl, setPresentonUrl] = useState('');
  const [deploymentState, setDeploymentState] = useState<'not_deployed'|'deploying'|'deployed'|'failed'>('not_deployed');
  const [healthMsg, setHealthMsg] = useState('');

  useEffect(() => { ensureShoperpResponsiveCss(); checkPresentonHealth(); }, [slug]);

  const checkPresentonHealth = async () => {
    setStatus('loading');
    try {
      const url = slideProBaseUrl(slug);
      // No configured instance: show the deploy CTA instead of probing a host we
      // already know does not exist.
      if (url) {
        const resp = await fetch(`${url}${SLIDEPRO_HEALTH_PATH}`, { mode: 'cors', signal: AbortSignal.timeout(5000) });
        if (resp.ok) { setPresentonUrl(url); setStatus('ready'); setDeploymentState('deployed'); return; }
      }
    } catch {}
    setStatus('unavailable');
    setDeploymentState('not_deployed');
    setHealthMsg('SlidePro n’est pas encore connecté à cet espace de travail.');
  };

  const deployPresenton = async () => {
    setDeploymentState('deploying');
    try {
      const resp = await fetch(`/api/v1/apps/${slug}/slidepro/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: 'ghcr.io/presenton/presenton:latest', llm: 'custom' }) });
      if (!resp.ok) throw new Error((await resp.json().catch(()=>({message:'Deploy failed'}))).message || 'Deploy failed');
      const { url } = await resp.json();
      localStorage.setItem(`${SLIDEPRO_URL_KEY}_${slug}`, url);
      setPresentonUrl(url); setDeploymentState('deployed'); setStatus('ready'); onMutated();
    } catch (err: any) { setDeploymentState('failed'); setHealthMsg(err.message || 'Le deploiement a echoue'); onWritesBlocked(); }
  };

  return (
    <div data-cdz-surface="" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel2, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20 }}>📽️</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>SlidePro</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>Presentations AI · Powered by Presenton + CDZ AI</div>
        </div>
        {status === 'ready' ? <a href={presentonUrl} target="_blank" rel="noopener noreferrer" style={{ ...miniBtnStyle('secondary'), textDecoration: 'none' }}>Ouvrir SlidePro ↗</a> : null}
        <button style={miniBtnStyle('secondary')} onClick={checkPresentonHealth}>↻ Verifier</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 20px', background: C.bg }}>
        {status === 'loading' ? <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0' }}><Spinner /> Connexion a SlidePro…</div>
        : status === 'ready' && presentonUrl ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.border}`, background: '#fff', minHeight: 520 }}>
              <iframe src={presentonUrl} style={{ width: '100%', height: 520, border: 'none' }} title="SlidePro" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
            </div>
            <div style={{ borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel, padding: '18px 20px' }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 8 }}>🚀 Generation rapide</div>
              <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6 }}>SlidePro utilise vos modeles CDZ AI pour generer des presentations professionnelles. Creez des slides a partir d'un prompt, d'un document, ou d'un template personnalise. Export en PPTX ou PDF.</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {['PPTX Export','Templates AI','CDZ Models','Apache 2.0'].map(t=><span key={t} style={{ fontSize: 11, fontWeight: 600, color: C.accent, padding: '4px 10px', borderRadius: 999, background: `${C.accentSoft}`, border: `1px solid ${C.accent}30` }}>{t}</span>)}
              </div>
            </div>
          </div>
        ) : deploymentState === 'not_deployed' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 640 }}>
            <div style={{ borderRadius: 16, border: `1px solid ${C.border}`, background: `linear-gradient(135deg, ${C.accentSoft}, transparent)`, padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>📽️ SlidePro — AI Presentation Studio</div>
                <p style={{ margin: '8px 0 0', fontSize: 13.5, color: C.muted, lineHeight: 1.6 }}>Generez des presentations professionnelles avec vos propres modeles CDZ AI. SlidePro est propulse par <strong>Presenton</strong> (Apache 2.0) — vos donnees restent sur votre infrastructure Railway.</p>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                {[{icon:'🤖',title:'CDZ AI Models',desc:'Utilisez vos modeles configures'},{icon:'🎨',title:'Templates Pro',desc:'6 modeles integres + custom'},{icon:'📄',title:'Export PPTX/PDF',desc:'Fichiers editable'},{icon:'🔒',title:'Self-Hosted',desc:'Vos donnees, votre infra'}].map(f=><div key={f.title} style={{ background: C.panel, borderRadius: 10, padding: '12px 14px', border: `1px solid ${C.border}` }}><div style={{ fontSize: 18, marginBottom: 4 }}>{f.icon}</div><div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{f.title}</div><div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{f.desc}</div></div>)}
              </div>
              <button onClick={deployPresenton} style={{ padding: '14px 28px', borderRadius: 12, border: 'none', background: C.accent, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', alignSelf: 'flex-start' }}>🚀 Deployer SlidePro sur Railway</button>
              <div style={{ fontSize: 11.5, color: C.muted }}>Deploie Presenton comme service Docker sur Railway · Configure automatiquement avec vos cles CDZ AI · Temps estime : 2-3 minutes</div>
            </div>
            <div style={{ borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel, padding: '14px 18px', fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
              <strong style={{ color: C.text }}>Details techniques :</strong><br />
              • Image : <code style={{ background: C.panel2, padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>ghcr.io/presenton/presenton:latest</code><br />
              • LLM : custom → CDZ AI (votre endpoint OpenAI-compatible)<br />
              • Port : 5001 (interne Railway)<br />
              • Licence : Apache 2.0 · 100% open-source
            </div>
          </div>
        ) : deploymentState === 'deploying' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '60px 20px' }}>
            <Spinner />
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Deploiement de SlidePro en cours…</div>
            <div style={{ fontSize: 12.5, color: C.muted, textAlign: 'center', maxWidth: 400 }}>Railway provisionne le conteneur Presenton avec vos modeles CDZ AI. Cela prend environ 2-3 minutes.</div>
          </div>
        ) : (
          <Banner tone="error">{healthMsg || 'Impossible de se connecter a SlidePro.'} <button style={linkBtnStyle} onClick={checkPresentonHealth}>Reessayer</button></Banner>
        )}
      </div>
    </div>
  );
};