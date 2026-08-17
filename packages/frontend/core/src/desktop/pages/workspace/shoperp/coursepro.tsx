// CoursePro — AI-powered LMS tab for ClickDz Work
// Powered by ClassroomIO (open-source LMS) + CDZ AI models.
// Same integration pattern as SlidePro: embed via iframe.

import { useCallback, useEffect, useState } from 'react';
import { Banner, btnStyle, C, ensureShoperpResponsiveCss, linkBtnStyle, miniBtnStyle, Spinner } from './shoperp-shared';
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

export const CourseProPanel = ({
  slug,
  // Part of the uniform shoperp app-panel contract (the parent passes these to
  // every studio); this panel manages its own state and mutation signals.
  readOnly: _readOnly,
  onWritesBlocked: _onWritesBlocked,
  onMutated: _onMutated,
}: {
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
        <span
          aria-hidden
          style={{
            width: 36,
            height: 36,
            borderRadius: 11,
            background: 'linear-gradient(135deg, #0d9488, #0f766e)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 18,
            flexShrink: 0,
            boxShadow: '0 2px 8px rgba(13, 148, 136, 0.3)',
          }}
        >
          🎓
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>CoursePro</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>LMS IA · Propulsé par ClassroomIO + CDZ AI</div>
        </div>
        <button style={miniBtnStyle('secondary')} onClick={() => void load()}>↻ Vérifier</button>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: (status === 'ready' || status === 'degraded') ? 'hidden' : 'auto', background: C.bg }}>
        {status === 'loading' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '48px 20px', flex: 1 }}>
            <span
              aria-hidden
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #0d9488, #0f766e)',
                display: 'grid',
                placeItems: 'center',
                fontSize: 26,
                boxShadow: '0 4px 16px rgba(13, 148, 136, 0.3)',
              }}
            >
              🎓
            </span>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Connexion à CoursePro…</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.muted, fontSize: 12.5 }}>
              <Spinner /> Préparation de votre plateforme de formation
            </div>
          </div>
        ) : status === 'error' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '48px 20px', flex: 1, textAlign: 'center' }}>
            <span
              aria-hidden
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: 'color-mix(in srgb, #ef4444 15%, transparent)',
                display: 'grid',
                placeItems: 'center',
                fontSize: 26,
              }}
            >
              ⚠️
            </span>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Impossible de se connecter</div>
            <div style={{ fontSize: 12.5, color: C.muted, maxWidth: 320, lineHeight: 1.5 }}>
              CoursePro n'est pas disponible pour le moment. Vérifiez votre connexion puis réessayez.
            </div>
            <button
              style={{ ...btnStyle('primary'), marginTop: 4 }}
              onClick={() => void load()}
            >
              ↻ Réessayer
            </button>
          </div>
        ) : (
          /* Full-bleed layout: the iframe flex-fills the entire remaining
             viewport (no fixed heights, no max-width, no rounded/bordered
             "browser window" chrome) so the embedded app fits the studio's
             resolution exactly. Only the degraded-mode notice, when present,
             takes a slim auto-height strip above it. */
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            {/* E1.1: soft notice when running in degraded (no auto-login) mode */}
            {status === 'degraded' && (
              <div style={{ padding: '10px 16px 0' }}>
                <Banner tone="warn">
                  La connexion automatique est temporairement indisponible — CoursePro s&apos;ouvre en mode basique.{' '}
                  <button style={linkBtnStyle} onClick={() => void load()}>Réessayer</button>
                </Banner>
              </div>
            )}
            <iframe
              src={iframeSrc}
              style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', display: 'block' }}
              title="CoursePro"
              /* Cross-origin iframes need explicit Permissions Policy
                 delegation or clipboard/fullscreen/media silently fail with
                 no prompt (the sandbox attr provided no such grants). */
              allow="clipboard-read *; clipboard-write *; fullscreen *; autoplay *; camera *; microphone *; display-capture *"
              allowFullScreen
            />
          </div>
        )}
      </div>
    </div>
  );
};
