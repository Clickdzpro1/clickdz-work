import { useCallback, useEffect, useState } from 'react';
import { Banner, btnStyle, C, ensureShoperpResponsiveCss, linkBtnStyle, miniBtnStyle, Spinner } from './shoperp-shared';
import { provisionApp, withBridgeCode } from './app-provision';
/* SlidePro - AI Presentation Generator powered by Presenton (Apache 2.0) + CDZ AI */

const SLIDEPRO_URL_KEY = 'cdz.slidepro.url';

/**
 * Base URL used ONLY for the bridge-code fallback (and as a last resort). We use
 * the SHIM host as the base so proxying + auth keep working; the shim redeems
 * the bridge_code and lands the user logged in. A self-hoster can repoint this
 * via localStorage without a rebuild — but there is no fake per-shop host.
 */
const SLIDEPRO_INSTANCE_URL = 'https://slidepro-shim-production.up.railway.app';

function slideProInstanceUrl(): string {
  try {
    const override = localStorage.getItem(SLIDEPRO_URL_KEY);
    if (override) return override.replace(/\/+$/, '');
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return SLIDEPRO_INSTANCE_URL;
}

export const SlideProPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: { slug: string; readOnly: boolean; onWritesBlocked: () => void; onMutated: () => void }) => {
  const [status, setStatus] = useState<'loading' | 'ready' | 'degraded' | 'error'>('loading');
  const [iframeSrc, setIframeSrc] = useState('');
  // "↻ Vérifier" feedback: a manual re-check should never look like a no-op.
  // checking=true drives the button's spinner/disabled state; checkNote is a
  // short-lived French message reporting the outcome, shown even when the
  // status doesn't change (e.g. still ready, still preparing).
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState('');

  // Robust flow: provision the app, then iframe the shim loginUrl (preferred) or
  // the bridge-code URL. The iframe load IS the health check — no CORS probe.
  // E1.1: on provision failure, fall back to the bare shim URL (degraded mode)
  // so the user sees the app (with its own login flow) instead of a hard red
  // banner. Only show the error state if there is no URL at all to iframe.
  // Returns the resolved status so callers (like the manual "Vérifier" check
  // below) can report an accurate result without racing React's state batching.
  const load = useCallback(async (): Promise<'ready' | 'degraded' | 'error'> => {
    setStatus('loading');
    const p = await provisionApp('slidepro');
    if (!p) {
      // E1.1 fallback: iframe the bare shim URL so the panel is still usable.
      const fallback = slideProInstanceUrl();
      if (fallback) {
        setIframeSrc(fallback);
        setStatus('degraded');
        return 'degraded';
      }
      setStatus('error');
      return 'error';
    }
    setIframeSrc(p.loginUrl || withBridgeCode(slideProInstanceUrl(), p.code, p.username));
    setStatus('ready');
    return 'ready';
  }, []);

  useEffect(() => {
    ensureShoperpResponsiveCss();
    void load();
  }, [slug, load]);

  // Manual "↻ Vérifier" click: re-run the same health check as load(), but
  // report a clear result afterwards instead of silently swapping the iframe.
  const handleVerify = useCallback(async () => {
    setChecking(true);
    setCheckNote('');
    try {
      const result = await load();
      setCheckNote(
        result === 'error'
          ? 'Toujours en préparation…'
          : 'Toujours opérationnel ✓'
      );
    } finally {
      setChecking(false);
    }
  }, [load]);

  return (
    <div data-cdz-surface="" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel2, flexWrap: 'wrap' }}>
        <span
          aria-hidden
          style={{
            width: 36,
            height: 36,
            borderRadius: 11,
            background: 'linear-gradient(135deg, #7c3aed, #5b21b6)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 18,
            flexShrink: 0,
            boxShadow: '0 2px 8px rgba(124, 58, 237, 0.3)',
          }}
        >
          📽️
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>SlidePro</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>Présentations IA · Powered by Presenton + CDZ AI</div>
        </div>
        {/* No external "open in new tab" link: SlidePro is iframe-only inside
            ClickDz Work (users must use it in-app, never via an external URL). */}
        {checkNote && !checking && (
          <span style={{ fontSize: 11.5, color: C.muted }}>{checkNote}</span>
        )}
        <button
          style={miniBtnStyle('secondary', checking)}
          disabled={checking}
          onClick={() => void handleVerify()}
        >
          {checking ? <Spinner /> : '↻'} Vérifier
        </button>
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
                background: 'linear-gradient(135deg, #7c3aed, #5b21b6)',
                display: 'grid',
                placeItems: 'center',
                fontSize: 26,
                boxShadow: '0 4px 16px rgba(124, 58, 237, 0.3)',
              }}
            >
              📽️
            </span>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Connexion à SlidePro…</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.muted, fontSize: 12.5 }}>
              <Spinner /> Préparation de votre studio de présentations
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
              SlidePro n'est pas disponible pour le moment. Vérifiez votre connexion puis réessayez.
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
                  La connexion automatique est temporairement indisponible — SlidePro s&apos;ouvre en mode basique.{' '}
                  <button style={linkBtnStyle} onClick={() => void load()}>Réessayer</button>
                </Banner>
              </div>
            )}
            <iframe
              src={iframeSrc}
              style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', display: 'block' }}
              title="SlidePro"
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
