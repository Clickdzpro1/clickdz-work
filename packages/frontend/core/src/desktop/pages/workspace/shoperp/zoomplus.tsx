// ZOOM+ — Video conferencing tab for ClickDz Work
// Powered by La Suite Meet (LiveKit, MIT license) + CDZ AI for transcription.
import { useCallback, useEffect, useRef, useState } from 'react';
import { C, ensureShoperpResponsiveCss, Spinner, Banner, linkBtnStyle, miniBtnStyle } from './shoperp-shared';
import { provisionApp } from './app-provision';

const ZOOMPLUS_URL_KEY = 'cdz.zoomplus.url';

/**
 * Base URL for the Meet frontend host. Kept for a self-hoster override via
 * localStorage (no rebuild needed); there is no fake per-shop host. WS17: the
 * bridge-code fallback that used this is removed (Meet's OIDC drops the
 * bridge_code, so the fallback showed a permanent login screen).
 */
const ZOOMPLUS_INSTANCE_URL = 'https://meet-frontend-production.up.railway.app';

// Kept for the localStorage override contract (a self-hoster may still repoint
// the host). Unused by the load() flow now but referenced by the override path.
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
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'no-login' | 'slow'>('loading');
  const [iframeSrc, setIframeSrc] = useState('');

  // C4: Track the current load attempt so stale provision results (from a
  // previous load() that resolved after the user cancelled or retried) don't
  // clobber the current status. Each load() increments this counter; at the
  // end we only apply the result if the counter hasn't changed.
  const loadEpochRef = useRef(0);

  // C4: Elapsed timer — starts when status === 'loading'. After 15s with no
  // resolution, transitions to 'slow' so the user sees a message + retry/cancel
  // instead of an indefinite spinner (the Meet backend cold start can take 50s).
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SLOW_THRESHOLD_MS = 15_000;

  const clearSlowTimer = useCallback(() => {
    if (slowTimerRef.current) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
  }, []);

  const startSlowTimer = useCallback(() => {
    clearSlowTimer();
    const epoch = loadEpochRef.current;
    slowTimerRef.current = setTimeout(() => {
      // Only transition to 'slow' if we're still on the same load attempt
      // and haven't already resolved to another status.
      if (loadEpochRef.current === epoch) {
        setStatus(prev => prev === 'loading' ? 'slow' : prev);
      }
    }, SLOW_THRESHOLD_MS);
  }, [clearSlowTimer]);

  // Robust flow: provision the app, then iframe the IdP /prime loginUrl
  // (preferred — stashes the bridge_code as a first-party cookie then redirects
  // into Meet so OIDC auto-approves). WS17: when loginUrl is missing (IdP/Meet
  // backend cold-start timeout, or CDZ_ZOOM_IDP_URL misconfigured), the old
  // fallback appended ?bridge_code=... to the Meet frontend URL — but the
  // backend documents that Meet's OIDC client drops our bridge_code, so the SPA
  // showed a permanent "Login" screen with no error. Now we surface a retry
  // banner instead of iframing the broken fallback.
  const load = useCallback(async () => {
    const epoch = ++loadEpochRef.current;
    setStatus('loading');
    startSlowTimer();
    const p = await provisionApp('zoomplus');
    clearSlowTimer();
    // Ignore stale results from a previous load attempt (user clicked
    // Réessayer or Annuler which started a new epoch).
    if (loadEpochRef.current !== epoch) return;
    if (!p) {
      setStatus('error');
      return;
    }
    if (!p.loginUrl) {
      // No IdP login URL — the Meet backend/IdP bridge isn't ready. Don't iframe
      // the dead bridge_code fallback; show a retry banner.
      setStatus('no-login');
      return;
    }
    setIframeSrc(p.loginUrl);
    setStatus('ready');
  }, [startSlowTimer, clearSlowTimer]);

  // C4: Cancel the current load attempt — stops the timer and shows the error
  // banner (which has its own Réessayer button). The in-flight provisionApp
  // promise will resolve later but its result is ignored via the epoch guard.
  const cancelLoad = useCallback(() => {
    ++loadEpochRef.current; // invalidate the in-flight load()
    clearSlowTimer();
    setStatus('error');
  }, [clearSlowTimer]);

  // Cleanup timer on unmount.
  useEffect(() => {
    return () => clearSlowTimer();
  }, [clearSlowTimer]);

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
      <div aria-live="polite" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: status === 'ready' ? 'hidden' : 'auto', background: C.bg }}>
        {status === 'loading' ? <div aria-busy="true" style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0 40px 20px' }}><Spinner /> Connexion à ZOOM+…</div>
        : status === 'slow' ? (
          // C4: The connection has been loading for >15s. The Meet backend cold
          // start can take up to 50s — instead of leaving the user staring at a
          // spinner, surface a message with retry/cancel actions.
          <div style={{ padding: '24px 20px' }}>
            <Banner tone="warn">La connexion prend plus de temps que prévu.
              <br /><br />
              <button style={linkBtnStyle} onClick={() => void load()}>Réessayer</button>
              {' · '}
              <button style={linkBtnStyle} onClick={cancelLoad}>Annuler</button>
            </Banner>
          </div>
        ) : status === 'error' ? (
          <div style={{ padding: '24px 20px' }}>
            <Banner tone="error">Impossible de se connecter à ZOOM+ pour le moment. <button style={linkBtnStyle} onClick={() => void load()}>Réessayer</button></Banner>
          </div>
        ) : status === 'no-login' ? (
          // WS17: provisioning succeeded but no IdP loginUrl — the Meet backend /
          // IdP bridge isn't ready (cold start or CDZ_ZOOM_IDP_URL misconfigured).
          // Show a retry banner instead of the dead bridge_code iframe fallback.
          <div style={{ padding: '24px 20px' }}>
            <Banner tone="warn">Le service de connexion ZOOM+ n'est pas encore prêt. <button style={linkBtnStyle} onClick={() => void load()}>Réessayer</button></Banner>
          </div>
        ) : (
          /* Full-bleed layout: the iframe flex-fills the entire remaining
             viewport (no fixed heights, no max-width, no rounded/bordered
             "browser window" chrome) so the embedded app fits the studio's
             resolution exactly. */
          <iframe
            src={iframeSrc}
            style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', display: 'block' }}
            title="ZOOM+"
            /* Permissions Policy delegation — REQUIRED for a cross-origin
               iframe: without `allow`, getUserMedia / getDisplayMedia /
               navigator.clipboard are blocked silently (no permission
               prompt ever shows). NOTE: allow-camera/allow-microphone are
               NOT sandbox tokens — the old sandbox attr silently blocked
               mic, camera, screen share AND the copy-link clipboard. */
            allow="camera *; microphone *; display-capture *; clipboard-read *; clipboard-write *; fullscreen *; autoplay *; speaker-selection *; screen-wake-lock *"
            allowFullScreen
          />
        )}
      </div>
    </div>
  );
};
