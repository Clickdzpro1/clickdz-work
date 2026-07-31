// Social+ — AI social media scheduling tab for ClickDz Work
// Powered by Postiz (open-source) + CDZ AI models.
// Same integration pattern as SlidePro/CoursePro: embed via iframe.

import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { C, ensureShoperpResponsiveCss, Spinner, Banner, linkBtnStyle, miniBtnStyle } from './shoperp-shared';
import { provisionApp, withBridgeCode } from './app-provision';

const SOCIALPLUS_URL_KEY = 'cdz.socialplus.url';

/** Postiz readiness endpoint (probed with a 5s timeout). */
const SOCIALPLUS_HEALTH_PATH = '/api/health';

/** The deployed shared Postiz instance (Railway service cdz-socialplus). */
const SOCIALPLUS_DEFAULT_URL = 'https://cdz-socialplus-production.up.railway.app';

/**
 * Shared-instance base URL.
 *
 * The old fallback was `https://socialplus-${slug}.up.railway.app`, which assumed
 * ONE POSTIZ DEPLOYMENT PER SHOP — a host that has never existed and that
 * would not scale past the first merchant anyway. Social+ is one shared service
 * with per-user workspaces inside it, so the base URL is deployment config, not
 * something to derive from a slug.
 *
 * Resolution order: an explicit per-install override in localStorage, then the
 * build-time env value, then the checked-in default (same pattern as SlidePro).
 */
function socialPlusBaseUrl(slug: string): string {
  try {
    const override =
      localStorage.getItem(`${SOCIALPLUS_URL_KEY}_${slug}`) ||
      localStorage.getItem(SOCIALPLUS_URL_KEY);
    if (override) return override.replace(/\/+$/, '');
  } catch {
    /* storage unavailable — fall through to env */
  }
  const fromEnv =
    typeof process !== 'undefined'
      ? (process.env?.CDZ_SOCIALPLUS_URL ?? '')
      : '';
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  // process.env is baked at BUILD time, so an env var set on the server would
  // never reach this bundle — a checked-in default makes the tab work out of
  // the box. The localStorage override above still wins for self-hosters.
  return SOCIALPLUS_DEFAULT_URL;
}

export const SocialPlusPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: {
  slug: string; readOnly: boolean; onWritesBlocked: () => void; onMutated: () => void;
}) => {
  const [status, setStatus] = useState<'loading'|'ready'|'error'|'unavailable'>('loading');
  const [postizUrl, setPostizUrl] = useState('');
  const [iframeSrc, setIframeSrc] = useState('');
  const [deploymentState, setDeploymentState] = useState<'not_deployed'|'deploying'|'deployed'|'failed'>('not_deployed');
  const [healthMsg, setHealthMsg] = useState('');

  useEffect(() => { ensureShoperpResponsiveCss(); checkHealth(); }, [slug]);

  // Render the iframe with the bare URL immediately, then upgrade to a
  // code-bearing URL once the provision call resolves — awaiting the code
  // before first render would just delay the embed on the failure path
  // (provisioning is best-effort; the app loads either way).
  useEffect(() => {
    if (status !== 'ready' || !postizUrl) return;
    setIframeSrc(postizUrl);
    let cancelled = false;
    provisionApp('socialplus').then(p => {
      if (!cancelled && p) setIframeSrc(withBridgeCode(postizUrl, p.code));
    });
    return () => { cancelled = true; };
  }, [status, postizUrl]);

  const checkHealth = async () => {
    setStatus('loading');
    try {
      const url = socialPlusBaseUrl(slug);
      // No configured instance: show the deploy CTA instead of probing a host we
      // already know does not exist.
      if (url) {
        const resp = await fetch(`${url}${SOCIALPLUS_HEALTH_PATH}`, { mode: 'cors', signal: AbortSignal.timeout(5000) });
        if (resp.ok) { setPostizUrl(url); setStatus('ready'); setDeploymentState('deployed'); return; }
      }
    } catch {}
    setStatus('unavailable'); setDeploymentState('not_deployed');
    setHealthMsg('Social+ n\'est pas encore déployé pour cet ERP.');
  };

  const deploy = async () => {
    setDeploymentState('deploying');
    try {
      const resp = await fetch(`/api/v1/apps/${slug}/socialplus/deploy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: 'ghcr.io/gitroomhq/postiz:latest', ai_provider: 'cdz' }),
      });
      if (!resp.ok) throw new Error((await resp.json().catch(()=>({message:'Deploy failed'}))).message || 'Deploy failed');
      const { url } = await resp.json();
      localStorage.setItem(`${SOCIALPLUS_URL_KEY}_${slug}`, url);
      setPostizUrl(url); setDeploymentState('deployed'); setStatus('ready'); onMutated();
    } catch (err: any) { setDeploymentState('failed'); setHealthMsg(err.message || 'Le déploiement a échoué'); onWritesBlocked(); }
  };

  return (
    <div data-cdz-surface="" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel2, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20 }}>📱</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>Social+</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>Réseaux sociaux IA · Powered by Postiz + CDZ AI</div>
        </div>
        <button style={miniBtnStyle('secondary')} onClick={checkHealth}>↻ Vérifier</button>
      </div>
      <div style={status === 'ready'
        ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', padding: '16px 20px', background: C.bg }
        : { flex: 1, overflow: 'auto', padding: '24px 20px', background: C.bg }}>
        {status === 'loading' ? <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0' }}><Spinner /> Connexion à Social+…</div>
        : status === 'ready' && postizUrl ? (
          /* The iframe must fill the pane, not sit in a fixed 520px box with a
             dead region below it. The wrapper is flex:1 so it takes whatever
             height the pane offers, and the iframe is height:100% of that. The
             "Publication IA multi-réseaux" explainer used to sit under the
             iframe — it is collapsed into a slim footer strip so it no longer
             eats the iframe's space. */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
            <div style={{ borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.border}`, background: '#fff', flex: 1, minHeight: 0 }}>
              <iframe src={iframeSrc || postizUrl} style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} title="Social+" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
            </div>
            <div style={{ borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: C.muted, flex: 1 }}>🚀 Programmation et publication IA sur tous vos réseaux · Propulsé par vos modèles CDZ AI</span>
              {['Instagram','TikTok','LinkedIn','YouTube','X','Facebook'].map(t=><span key={t} style={{ fontSize: 10.5, fontWeight: 600, color: C.accent, padding: '3px 8px', borderRadius: 999, background: `${C.accentSoft}`, border: `1px solid ${C.accent}30` }}>{t}</span>)}
            </div>
          </div>
        ) : deploymentState === 'not_deployed' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 640 }}>
            <div style={{ borderRadius: 16, border: `1px solid ${C.border}`, background: `linear-gradient(135deg, ${C.accentSoft}, transparent)`, padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>📱 Social+ — Publication IA multi-réseaux</div>
                <p style={{ margin: '8px 0 0', fontSize: 13.5, color: C.muted, lineHeight: 1.6 }}>Programmez et publiez sur tous vos réseaux sociaux avec l'IA. Social+ est propulsé par <strong>Postiz</strong> (open-source) — 12+ plateformes supportées.</p>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                {[{icon:'🤖',title:'IA Content',desc:'Générez posts avec CDZ AI'},{icon:'📅',title:'Programmation',desc:'Calendar multi-réseaux'},{icon:'📊',title:'Analytics',desc:'Mesurez votre audience'},{icon:'👥',title:'Collaboration',desc:'Travaillez en équipe'}].map(f=><div key={f.title} style={{ background: C.panel, borderRadius: 10, padding: '12px 14px', border: `1px solid ${C.border}` }}><div style={{ fontSize: 18, marginBottom: 4 }}>{f.icon}</div><div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{f.title}</div><div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{f.desc}</div></div>)}
              </div>
              <button onClick={deploy} style={{ padding: '14px 28px', borderRadius: 12, border: 'none', background: C.accent, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', alignSelf: 'flex-start' }}>🚀 Déployer Social+ sur Railway</button>
              <div style={{ fontSize: 11.5, color: C.muted }}>Déploie Postiz comme service Docker sur Railway · Configuré avec vos modèles CDZ AI · Temps estimé : 3-5 minutes</div>
            </div>
            <div style={{ borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel, padding: '14px 18px', fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
              <strong style={{ color: C.text }}>Détails techniques :</strong><br />
              • Repo : <code style={{ background: C.panel2, padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>github.com/gitroomhq/postiz-app</code><br />
              • Stack : NextJS + NestJS + Prisma + PostgreSQL<br />
              • IA : CDZ AI (Gemini + OpenAI compatible)<br />
              • Licence : AGPL-3.0 (open-source)<br />
              • API publique + N8N + Make.com integration
            </div>
          </div>
        ) : deploymentState === 'deploying' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '60px 20px' }}>
            <Spinner />
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Déploiement de Social+ en cours…</div>
            <div style={{ fontSize: 12.5, color: C.muted, textAlign: 'center', maxWidth: 400 }}>Railway provisionne le conteneur Postiz avec vos modèles CDZ AI. Cela prend environ 3-5 minutes.</div>
          </div>
        ) : (
          <Banner tone="error">{healthMsg || 'Impossible de se connecter à Social+.'} <button style={linkBtnStyle} onClick={checkHealth}>Réessayer</button></Banner>
        )}
      </div>
    </div>
  );
};
