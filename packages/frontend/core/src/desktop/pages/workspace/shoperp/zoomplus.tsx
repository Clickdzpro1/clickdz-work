// ZOOM+ — Video conferencing for ClickDz Work.
//
// WHAT POWERS MEETINGS: a self-hosted La Suite Meet instance (meet.clickdz.ai,
// Django + LiveKit SFU) embedded via iframe, auto-logged-in through the
// meet-idp-bridge (OIDC). Our AFFiNE backend has direct LiveKit
// RoomService/Egress admin access (clickdz-zoomplus.service) which powers the
// REAL host controls (mute / kick / lock / recording) + the room policy this
// page pre-applies when a meeting starts. Post-call summaries go through the
// app's existing copilot endpoint (/api/v1/zoomplus/summary → cdz-ai).
//
// THIS SHELL is a real meetings product, not a bare iframe:
//   · Réunions — schedule meetings with real settings (waiting room, passcode,
//     mute-on-entry, auto-record, lock, co-hosts, recurrence, tz), listed as
//     upcoming/past with start / join / copy-invite / delete. The schedule is
//     persisted per-workspace in localStorage (the house pattern — see
//     shipping.tsx pickupStorageKey); each meeting's identity is its LiveKit
//     room name, which is a REAL joinable room in the live Meet instance.
//   · En direct — the embedded Meet room + the live host-controls & résumé
//     panels (real LiveKit ops via the backend).
//   · Paramètres — per-workspace default settings for all the toggles above.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  C,
  ensureShoperpResponsiveCss,
  Spinner,
  Banner,
  linkBtnStyle,
  miniBtnStyle,
} from './shoperp-shared';
import { provisionApp } from './app-provision';
import { ZoomPlusHostPanel } from './zoomplus-host-panel';
import { ZoomPlusSummaryPanel } from './zoomplus-summary-panel';
import { ZoomPlusScheduler } from './zoomplus-scheduler';
import { ZoomPlusMeetingsList } from './zoomplus-meetings-list';
import { ZoomPlusDefaultsPanel } from './zoomplus-defaults-panel';
import {
  type Meeting,
  readMeetings,
  applyRoomPolicy,
  roomJoinUrl,
  probeCapabilities,
  type ProviderCapabilities,
} from './zoomplus-meetings';

const ZOOMPLUS_URL_KEY = 'cdz.zoomplus.url';

/**
 * Base URL for the Meet frontend host. Kept for a self-hoster override via
 * localStorage (no rebuild needed); there is no fake per-shop host.
 */
const ZOOMPLUS_INSTANCE_URL = 'https://meet.clickdz.ai';

// Kept for the localStorage override contract (a self-hoster may still repoint
// the host).
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
// + getDisplayMedia APIs — checked once so we can show a French inline message
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

type MainTab = 'meetings' | 'live' | 'settings';

export const ZoomPlusPanel = ({ slug, readOnly, onWritesBlocked, onMutated }: {
  slug: string; readOnly: boolean; onWritesBlocked: () => void; onMutated: () => void;
}) => {
  // --- Top-level navigation ------------------------------------------------
  const [tab, setTab] = useState<MainTab>('meetings');

  // --- Meetings store (per-workspace localStorage) -------------------------
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  // The meeting currently open in the live room (drives the iframe + host
  // panel room name). null = the workspace "salle personnelle" (slug) is used.
  const [activeMeeting, setActiveMeeting] = useState<Meeting | null>(null);
  const [policyNote, setPolicyNote] = useState<string | null>(null);

  // --- Provider capabilities (probed once) ---------------------------------
  const [caps, setCaps] = useState<ProviderCapabilities | null>(null);

  // --- Live-room connection state (Meet iframe) ----------------------------
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error' | 'no-login' | 'slow'>('idle');
  const [iframeSrc, setIframeSrc] = useState('');

  // The LiveKit room the host panel / iframe target. When a meeting is open we
  // use its room; otherwise the workspace personal room (slug).
  const activeRoom = activeMeeting ? activeMeeting.room : slug;

  // --- Local (on-device) meeting recording state ---------------------------
  const [recState, setRecState] = useState<'idle' | 'starting' | 'recording'>('idle');
  const [recElapsed, setRecElapsed] = useState(0);
  const [recNote, setRecNote] = useState<string | null>(null);
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

  // --- Load the store + probe capabilities on mount ------------------------
  useEffect(() => {
    ensureShoperpResponsiveCss();
    setMeetings(readMeetings(slug));
    void (async () => {
      setCaps(await probeCapabilities());
    })();
  }, [slug]);

  const refreshMeetings = useCallback(() => {
    setMeetings(readMeetings(slug));
  }, [slug]);

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
      setRecState('idle');
      return;
    }

    try {
      displayStreamRef.current = display;

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
      stopAllRecordingTracks();
      recorderRef.current = null;
      setRecState('idle');
    }
  }, [recordingSupported, recState, finalizeAndDownload, stopAllRecordingTracks, stopRecording]);

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

  // --- Live-room load flow (Meet iframe + IdP /prime auto-login) -----------
  const loadEpochRef = useRef(0);
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
      if (loadEpochRef.current === epoch) {
        setStatus(prev => (prev === 'loading' ? 'slow' : prev));
      }
    }, SLOW_THRESHOLD_MS);
  }, [clearSlowTimer]);

  // `room` lands the embedded Meet SPA directly in that LiveKit room after the
  // OIDC auto-login (best-effort — see the backend provision branch). Defaults
  // to the currently active room so a bare "↻ Vérifier" reuses it.
  const load = useCallback(
    async (room?: string) => {
      const target = room ?? (activeMeeting ? activeMeeting.room : slug);
      const epoch = ++loadEpochRef.current;
      setStatus('loading');
      startSlowTimer();
      const p = await provisionApp('zoomplus', { room: target });
      clearSlowTimer();
      if (loadEpochRef.current !== epoch) return;
      if (!p) {
        setStatus('error');
        return;
      }
      if (!p.loginUrl) {
        setStatus('no-login');
        return;
      }
      setIframeSrc(p.loginUrl);
      setStatus('ready');
    },
    [startSlowTimer, clearSlowTimer, activeMeeting, slug]
  );

  const cancelLoad = useCallback(() => {
    ++loadEpochRef.current;
    clearSlowTimer();
    setStatus('error');
  }, [clearSlowTimer]);

  useEffect(() => {
    return () => clearSlowTimer();
  }, [clearSlowTimer]);

  // --- Enter the live room for a meeting (or the personal room) ------------
  const enterLiveRoom = useCallback(
    async (meeting: Meeting | null, applyPolicy: boolean) => {
      setActiveMeeting(meeting);
      setTab('live');
      setPolicyNote(null);
      // Pre-apply the meeting's room policy (lock / mute-on-entry / auto-record)
      // to the REAL LiveKit room before joining — best-effort, host-controls
      // gated. Only when starting (not merely joining).
      if (applyPolicy && meeting && caps?.hostControls) {
        const applied = await applyRoomPolicy(meeting);
        const done: string[] = [];
        if (applied.muteOnEntry) done.push('micros coupés à l’entrée');
        if (applied.locked) done.push('réunion verrouillée');
        if (applied.recording) done.push('enregistrement démarré');
        if (done.length) {
          setPolicyNote(`Paramètres appliqués : ${done.join(', ')}.`);
        }
      }
      // (Re)load the Meet iframe INTO this meeting's room (pass it explicitly —
      // setActiveMeeting above hasn't flushed yet, so load() can't read it).
      // The embedded SPA opens/joins the LiveKit room; the host panel
      // administers the same room name.
      const targetRoom = meeting ? meeting.room : slug;
      void load(targetRoom);
    },
    [caps, load, slug]
  );

  // ---- Styles -------------------------------------------------------------
  const tabBtn = (active: boolean): React.CSSProperties => ({
    appearance: 'none',
    background: active ? C.accentSoft : 'transparent',
    border: 'none',
    borderBottom: active ? `2px solid ${C.accent}` : '2px solid transparent',
    color: active ? C.text : C.muted,
    fontSize: 13,
    fontWeight: 700,
    padding: '10px 14px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });

  const showLocalRecBtn =
    tab === 'live' && status === 'ready' && recordingSupported;

  return (
    <div data-cdz-surface="" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel2, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20 }}>🎥</span>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>ZOOM+</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>Visioconférence ZOOM+</div>
        </div>
        {/* Tab strip */}
        <div style={{ display: 'flex', gap: 2 }}>
          <button style={tabBtn(tab === 'meetings')} onClick={() => setTab('meetings')}>📅 Réunions</button>
          <button style={tabBtn(tab === 'live')} onClick={() => setTab('live')}>🔴 En direct</button>
          <button style={tabBtn(tab === 'settings')} onClick={() => setTab('settings')}>⚙️ Paramètres</button>
        </div>
        {/* Live-room local recording controls (only on the live tab) */}
        {showLocalRecBtn && recState !== 'recording' && (
          <button
            style={miniBtnStyle('secondary', recState === 'starting')}
            disabled={recState === 'starting'}
            title="Enregistrement local — la vidéo reste sur votre appareil."
            onClick={() => void startRecording()}
          >
            {recState === 'starting' ? <><Spinner /> Démarrage…</> : '⏺ Enregistrer'}
          </button>
        )}
        {showLocalRecBtn && recState === 'recording' && (
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
        {tab === 'live' && (
          <button style={miniBtnStyle('secondary')} onClick={() => void load()}>↻ Vérifier</button>
        )}
      </div>
      <style>{'@keyframes cdz-zoomplus-pulse{0%,100%{opacity:1}50%{opacity:.25}}'}</style>

      {/* Capture-picker guidance (only while the picker is open) */}
      {tab === 'live' && status === 'ready' && recordingSupported && recState === 'starting' && (
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            color: C.text,
            background: 'rgba(37, 211, 102, 0.10)',
            borderBottom: '1px solid rgba(37, 211, 102, 0.35)',
            padding: '8px 16px',
          }}
        >
          💡 Dans la fenêtre de partage : choisissez l’onglet de la réunion, cochez
          {' '}<strong>« Partager l’audio de l’onglet »</strong>, puis validez. Votre micro est
          ajouté automatiquement s’il est autorisé.
        </div>
      )}
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

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: tab === 'live' && status === 'ready' ? 'hidden' : 'auto', background: C.bg }}>
        {tab === 'meetings' && (
          <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 960, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
            <ZoomPlusScheduler
              slug={slug}
              onCreated={(m, start) => {
                refreshMeetings();
                if (start) void enterLiveRoom(m, true);
              }}
            />
            <ZoomPlusMeetingsList
              slug={slug}
              meetings={meetings}
              onChange={refreshMeetings}
              onStart={m => void enterLiveRoom(m, true)}
              onJoin={m => void enterLiveRoom(m, false)}
            />
          </div>
        )}

        {tab === 'settings' && (
          <div style={{ padding: '16px', maxWidth: 720, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
            <ZoomPlusDefaultsPanel slug={slug} caps={caps} />
          </div>
        )}

        {tab === 'live' && (
          <LiveRoomView
            status={status}
            iframeSrc={iframeSrc}
            room={activeRoom}
            activeMeeting={activeMeeting}
            policyNote={policyNote}
            recordingSupported={recordingSupported}
            onLoad={() => void load()}
            onCancel={cancelLoad}
          />
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Live-room view — the embedded Meet iframe + host/résumé overlay panels. Split
// out so the shell stays readable. Preserves the exact provisioning states.
// ---------------------------------------------------------------------------

const LiveRoomView = ({
  status,
  iframeSrc,
  room,
  activeMeeting,
  policyNote,
  recordingSupported,
  onLoad,
  onCancel,
}: {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'no-login' | 'slow';
  iframeSrc: string;
  room: string;
  activeMeeting: Meeting | null;
  policyNote: string | null;
  recordingSupported: boolean;
  onLoad: () => void;
  onCancel: () => void;
}) => {
  // The room the host panel administers + the canonical join link for it.
  const joinUrl = roomJoinUrl(room);

  return (
    <div aria-live="polite" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Context bar — which meeting/room is live + a copyable join link. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>
          {activeMeeting ? activeMeeting.title : 'Salle personnelle'}
        </span>
        <span style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace' }}>#{room}</span>
        <span style={{ flex: 1 }} />
        <button
          style={miniBtnStyle('secondary')}
          title="Copier le lien de la salle"
          onClick={() => {
            try { void navigator.clipboard.writeText(joinUrl); } catch { /* clipboard blocked */ }
          }}
        >
          🔗 Copier le lien
        </button>
        {policyNote && (
          <span style={{ flexBasis: '100%', fontSize: 11.5, color: C.okText }}>{policyNote}</span>
        )}
      </div>

      {status === 'idle' ? (
        <div style={{ padding: '24px 20px' }}>
          <Banner tone="info">
            Aucune réunion ouverte. Ouvrez l’onglet <strong>Réunions</strong> pour démarrer ou rejoindre une réunion, ou
            {' '}<button style={linkBtnStyle} onClick={onLoad}>connecter la salle personnelle</button>.
          </Banner>
        </div>
      ) : status === 'loading' ? (
        <div aria-busy="true" style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '40px 0 40px 20px' }}>
          <Spinner /> Connexion à ZOOM+…
        </div>
      ) : status === 'slow' ? (
        <div style={{ padding: '24px 20px' }}>
          <Banner tone="warn">La connexion prend plus de temps que prévu.
            <br /><br />
            <button style={linkBtnStyle} onClick={onLoad}>Réessayer</button>
            {' · '}
            <button style={linkBtnStyle} onClick={onCancel}>Annuler</button>
          </Banner>
        </div>
      ) : status === 'error' ? (
        <div style={{ padding: '24px 20px' }}>
          <Banner tone="error">Impossible de se connecter à ZOOM+ pour le moment. <button style={linkBtnStyle} onClick={onLoad}>Réessayer</button></Banner>
        </div>
      ) : status === 'no-login' ? (
        <div style={{ padding: '24px 20px' }}>
          <Banner tone="warn">Le service de connexion ZOOM+ n'est pas encore prêt. <button style={linkBtnStyle} onClick={onLoad}>Réessayer</button></Banner>
        </div>
      ) : (
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <iframe
            src={iframeSrc}
            style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', display: 'block' }}
            title="ZOOM+"
            allow="camera *; microphone *; display-capture *; clipboard-read *; clipboard-write *; fullscreen *; autoplay *; speaker-selection *; screen-wake-lock *"
            allowFullScreen
          />
          {/* Collapsible overlay drawer — host controls + résumé, both wired to
              the REAL room name (the active meeting's LiveKit room, or the
              workspace personal room). */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              maxWidth: 360,
              minWidth: 280,
              zIndex: 10,
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              borderBottomLeftRadius: 10,
              overflow: 'hidden',
              maxHeight: '100%',
              overflowY: 'auto',
            }}
          >
            <ZoomPlusHostPanel room={room} />
            <ZoomPlusSummaryPanel room={room} />
          </div>
          {!recordingSupported && (
            <div style={{ position: 'absolute', bottom: 8, left: 8, fontSize: 11, color: C.muted, background: C.panel, padding: '4px 8px', borderRadius: 6, border: `1px solid ${C.border}` }}>
              Enregistrement local indisponible sur ce navigateur.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Re-export so a self-hoster override path keeps compiling (unused by load()).
export { zoomPlusInstanceUrl };
