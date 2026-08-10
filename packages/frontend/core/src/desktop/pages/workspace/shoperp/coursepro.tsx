// CoursePro — AI-powered LMS tab for ClickDz Work
// Powered by ClassroomIO (open-source LMS) + CDZ AI models.
// Same integration pattern as SlidePro: embed via iframe.

import { useCallback, useEffect, useState } from 'react';
import { C, ensureShoperpResponsiveCss, Spinner, Banner, linkBtnStyle, miniBtnStyle } from './shoperp-shared';
import { provisionApp, withBridgeCode } from './app-provision';

const COURSEPRO_URL_KEY = 'cdz.coursepro.url';

/**
 * Base URL used ONLY for the bridge-code fallback (and as a last resort). We use
 * the SHIM host as the base so proxying + auth keep working; the shim redeems
 * the bridge_code and lands the user logged in. A self-hoster can repoint this
 * via localStorage without a rebuild — but there is no fake per-shop host.
 */
const COURSEPRO_INSTANCE_URL = 'https://coursepro-shim-production.up.railway.app';

function courseProInstanceUrl(): string {
  try {
    const override = localStorage.getItem(COURSEPRO_URL_KEY);
    if (override) return override.replace(/\/+$/, '');
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return COURSEPRO_INSTANCE_URL;
}

export const CourseProPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: {
  slug: string; readOnly: boolean; onWritesBlocked: () => void; onMutated: () => void;
}) => {
  const [status, setStatus] = useState<'loading' | 'ready' | 'degraded' | 'error'>('loading');
  const [iframeSrc, setIframeSrc] = useState('');

  // Robust flow: provision the app, then iframe the shim loginUrl (preferred) or
  // the bridge-code URL. The iframe load IS the health check — no CORS probe.
  // E1.1: on provision failure, fall back to the bare shim URL (degraded mode)
  // so the user sees the app (with its own login flow) instead of a hard red
  // banner. Only show the error state if there is no URL at all to iframe.
  const load = useCallback(async () => {
    setStatus('loading');
    const p = await provisionApp('coursepro');
    if (!p) {
      // E1.1 fallback: iframe the bare shim URL so the panel is still usable.
      const fallback = courseProInstanceUrl();
      if (fallback) {
        setIframeSrc(fallback);
        setStatus('degraded');
      } else {
        setStatus('error');
      }
      return;
    }
    setIframeSrc(p.loginUrl || withBridgeCode(courseProInstanceUrl(), p.code));
    setStatus('ready');
  }, []);

  useEffect(() => {
    ensureShoperpResponsiveCss();
    void load();
  }, [slug, load]);

  return (
    <div data-cdz-surface="" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel2, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20 }}>🎓</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>CoursePro</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>LMS IA · Propulsé par ClassroomIO + CDZ AI</div>
        </div>
        <button style={miniBtnStyle('secondary')} onClick={() => void load()}>↻ Vérifier</button>
      </div>
      <div style={(status === 'ready' || status === 'degraded')
        ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', padding: '16px 20px', background: C.bg, alignSelf: 'stretch' }
        : { flex: 1, overflow: 'auto', padding: '24px 20px', background: C.bg }}>
        {status === 'loading' ? <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0' }}><Spinner /> Connexion à CoursePro…</div>
        : status === 'error' ? (
          <Banner tone="error">Impossible de se connecter à CoursePro pour le moment. <button style={linkBtnStyle} onClick={() => void load()}>Réessayer</button></Banner>
        ) : (
          /* The iframe fills the pane (flex:1, height:100%); the explainer is a
             slim footer strip so it never eats the iframe's space. */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
            {/* E1.1: soft notice when running in degraded (no auto-login) mode */}
            {status === 'degraded' && (
              <Banner tone="warn">
                La connexion automatique est temporairement indisponible — CoursePro s&apos;ouvre en mode basique.{' '}
                <button style={linkBtnStyle} onClick={() => void load()}>Réessayer</button>
              </Banner>
            )}
            {/* WS12: give the iframe a guaranteed floor height so it never
                collapses on short viewports / when an ancestor omits a definite
                height — fills and scales instead of clipping. */}
            <div style={{ borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.border}`, background: '#fff', flex: 1, minHeight: 520, height: '100%' }}>
              <iframe
                src={iframeSrc}
                style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                title="CoursePro"
                /* Cross-origin iframes need explicit Permissions Policy
                   delegation or clipboard/fullscreen/media silently fail with
                   no prompt (the sandbox attr provided no such grants). */
                allow="clipboard-read *; clipboard-write *; fullscreen *; autoplay *; camera *; microphone *; display-capture *"
                allowFullScreen
              />
            </div>
            <div style={{ borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: C.muted, flex: 1 }}>🚀 Cours, leçons et exercices générés par vos modèles CDZ AI · Cohorts · Certificats</span>
              {['Générateur de cours IA','Cohortes','Certificats'].map(t=><span key={t} style={{ fontSize: 10.5, fontWeight: 600, color: C.accent, padding: '3px 8px', borderRadius: 999, background: `${C.accentSoft}`, border: `1px solid ${C.accent}30` }}>{t}</span>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
