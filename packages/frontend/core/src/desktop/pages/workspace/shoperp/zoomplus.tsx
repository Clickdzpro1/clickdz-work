// ZOOM+ — Video conferencing tab for ClickDz Work
// ZOOM+ — Video conferencing for ClickDz Work (self-hosted La Suite Meet
// instance on meet.clickdz.ai, MIT license; LiveKit SFU; CDZ AI for post-call
// transcription/summary).
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
const ZOOMPLUS_INSTANCE_URL = 'https://meet.clickdz.ai';

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

// Recording support is only usable in a secure context with the MediaRecorder
// + getDisplayMedia APIs (e.g. plain http:// dev hosts or very old browsers
// don't have them) — checked once so we can show a French inline message
// instead of letting the button throw.
function isRecordingSupported(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getDisplayMedia === 'function' &&
      typeof window.MediaRecorder !== 'undefined'
    );
  } catch {
    return false;
  }
}

function pickRecorderMimeType(): string | undefined {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const type of candidates) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    } catch {
      /* isTypeSupported can throw in odd embeds — fall through */
    }
  }
  return undefined;
}

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function recordingFilename(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}h${pad(d.getMinutes())}`;
  return `clickdz-reunion-${date}-${time}.webm`;
}

export const ZoomPlusPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: {
  slug: string; readOnly: boolean; onWritesBlocked: () => void; onMutated: () => void;
}) => {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'no-login' | 'slow'>('loading');
  const [iframeSrc, setIframeSrc] = useState('');

  // --- Local meeting recording state -------------------------------------
  // Idle → recording → back to idle. Everything captured stays on-device:
  // we never upload the blob, we only trigger a browser download.
  const [recState, setRecState] = useState<'idle' | 'starting' | 'recording'>('idle');
  const [recElapsed, setRecElapsed] = useState(0);
  const [recNote, setRecNote] = useState<string | null>(null); // "saved" confirmation
  const [micDenied, setMicDenied] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const mixedStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recordingSupported = isRecordingSupported();

  const stopAllRecordingTracks = useCallback(() => {
    try { displayStreamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
    try { micStreamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
    try { mixedStreamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
    displayStreamRef.current = null;
    micStreamRef.current = null;
    mixedStreamRef.current = null;
    try {
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        void audioCtxRef.current.close();
      }
    } catch { /* noop */ }
    audioCtxRef.current = null;
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
  }, []);

  const finalizeAndDownload = useCallback(() => {
    try {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      chunksRef.current = [];
      if (blob.size > 0) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = recordingFilename();
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        setRecNote('Enregistrement sauvegardé sur votre appareil (dossier Téléchargements).');
        if (recNoteTimerRef.current) clearTimeout(recNoteTimerRef.current);
        recNoteTimerRef.current = setTimeout(() => setRecNote(null), 8000);
      }
    } catch {
      /* best-effort — the tracks are stopped regardless below */
    }
  }, []);

  const stopRecording = useCallback(() => {
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        // onstop finalizes + downloads once the last chunk lands.
        recorderRef.current.stop();
      } else {
        finalizeAndDownload();
      }
    } catch {
      finalizeAndDownload();
    } finally {
      stopAllRecordingTracks();
      recorderRef.current = null;
      setRecState('idle');
    }
  }, [finalizeAndDownload, stopAllRecordingTracks]);

  const startRecording = useCallback(async () => {
    if (!recordingSupported || recState !== 'idle') return;
    setMicDenied(false);
    setRecState('starting');
    let display: MediaStream | null = null;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      });
    } catch {
      // User cancelled the picker (or denied it) — return to idle silently.
      setRecState('idle');
      return;
    }

    try {
      displayStreamRef.current = display;

      // Best-effort microphone capture so the user's own voice is recorded
      // too. If denied/unavailable, continue with display audio only.
      let mic: MediaStream | null = null;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = mic;
      } catch {
        setMicDenied(true);
      }

      const displayAudioTracks = display.getAudioTracks();
      let finalAudioTrack: MediaStreamTrack | null = null;

      if (mic || displayAudioTracks.length > 0) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          audioCtxRef.current = ctx;
          const dest = ctx.createMediaStreamDestination();
          if (displayAudioTracks.length > 0) {
            try {
              const displayAudioOnly = new MediaStream(displayAudioTracks);
              ctx.createMediaStreamSource(displayAudioOnly).connect(dest);
            } catch { /* some browsers refuse a source with no live tracks */ }
          }
          if (mic) {
            try {
              ctx.createMediaStreamSource(mic).connect(dest);
            } catch { /* noop */ }
          }
          finalAudioTrack = dest.stream.getAudioTracks()[0] ?? null;
        } else if (displayAudioTracks.length > 0) {
          finalAudioTrack = displayAudioTracks[0];
        } else if (mic) {
          finalAudioTrack = mic.getAudioTracks()[0] ?? null;
        }
      }

      const videoTrack = display.getVideoTracks()[0];
      const combinedTracks: MediaStreamTrack[] = [];
      if (videoTrack) combinedTracks.push(videoTrack);
      if (finalAudioTrack) combinedTracks.push(finalAudioTrack);
      const combined = new MediaStream(combinedTracks);
      mixedStreamRef.current = combined;

      // Native "Stop sharing" from the browser's own UI ends the display
      // track — treat that exactly like clicking "Arrêter".
      if (videoTrack) {
        videoTrack.addEventListener('ended', () => stopRecording());
      }

      const mimeType = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(combined, { mimeType }) : new MediaRecorder(combined);
      chunksRef.current = [];
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        finalizeAndDownload();
      };
      recorderRef.current = recorder;
      recorder.start(1000);

      setRecElapsed(0);
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      recTimerRef.current = setInterval(() => setRecElapsed(e => e + 1), 1000);
      setRecState('recording');
    } catch {
      // Anything unexpected while wiring up the mix/recorder — clean up and
      // go back to idle rather than leaving a half-open stream.
      stopAllRecordingTracks();
      recorderRef.current = null;
      setRecState('idle');
    }
  }, [recordingSupported, recState, finalizeAndDownload, stopAllRecordingTracks, stopRecording]);

  // Clean up any live capture/recording on unmount.
  useEffect(() => {
    return () => {
      try {
        if (recorderRef.current && recorderRef.current.state !== 'inactive') {
          recorderRef.current.stop();
        }
      } catch { /* noop */ }
      stopAllRecordingTracks();
      if (recNoteTimerRef.current) clearTimeout(recNoteTimerRef.current);
    };
  }, [stopAllRecordingTracks]);

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
          <div style={{ fontSize: 11.5, color: C.muted }}>Visioconférence ZOOM+</div>
        </div>
        {status === 'ready' && recordingSupported && recState === 'idle' && (
          <span
            style={{ fontSize: 11, color: C.muted, display: 'none' }}
            className="cdz-zoomplus-rec-hint"
          >
            Enregistrement local — la vidéo reste sur votre appareil.
          </span>
        )}
        {status === 'ready' && recordingSupported && recState !== 'recording' && (
          <button
            style={miniBtnStyle('secondary', recState === 'starting')}
            disabled={recState === 'starting'}
            title="Enregistrement local — la vidéo reste sur votre appareil."
            onClick={() => void startRecording()}
          >
            {recState === 'starting' ? <><Spinner /> Démarrage…</> : '⏺ Enregistrer'}
          </button>
        )}
        {/* WAVE-G P5: capture-picker guidance — the #1 reason recordings come
            out silent is the unchecked "share tab audio" box in Chrome's
            picker. Shown only while the picker is open (recState 'starting'). */}
        {status === 'ready' && recordingSupported && recState === 'starting' && (
          <div
            style={{
              flexBasis: '100%',
              fontSize: 12,
              lineHeight: 1.5,
              color: C.text,
              background: 'rgba(37, 211, 102, 0.10)',
              border: '1px solid rgba(37, 211, 102, 0.35)',
              borderRadius: 8,
              padding: '8px 12px',
            }}
          >
            💡 Dans la fenêtre de partage : choisissez l’onglet de la réunion, cochez
            {' '}<strong>« Partager l’audio de l’onglet »</strong>, puis validez. Votre micro est
            ajouté automatiquement s’il est autorisé.
          </div>
        )}
        {status === 'ready' && recordingSupported && recState === 'recording' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: 'var(--affine-error-color, #eb4b4b)',
                animation: 'cdz-zoomplus-pulse 1.1s ease-in-out infinite',
              }}
            />
            <span style={{ fontSize: 12, color: C.text, fontVariantNumeric: 'tabular-nums' }}>
              {formatElapsed(recElapsed)}
            </span>
            <button style={miniBtnStyle('danger')} onClick={stopRecording}>⏹ Arrêter</button>
          </div>
        )}
        {status === 'ready' && !recordingSupported && (
          <span style={{ fontSize: 11, color: C.muted }}>
            Enregistrement local indisponible sur ce navigateur.
          </span>
        )}
        <button style={miniBtnStyle('secondary')} onClick={() => void load()}>↻ Vérifier</button>
      </div>
      <style>{'@keyframes cdz-zoomplus-pulse{0%,100%{opacity:1}50%{opacity:.25}}@media (min-width: 900px){.cdz-zoomplus-rec-hint{display:inline !important}}'}</style>
      {micDenied && recState === 'recording' && (
        <div style={{ padding: '4px 16px', fontSize: 11.5, color: C.muted, background: C.panel2, borderBottom: `1px solid ${C.border}` }}>
          Microphone indisponible — seul le son de l’onglet partagé est enregistré.
        </div>
      )}
      {recNote && (
        <div style={{ padding: '6px 16px', fontSize: 12, color: C.okText, background: C.panel2, borderBottom: `1px solid ${C.border}` }}>
          {recNote}
        </div>
      )}
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
