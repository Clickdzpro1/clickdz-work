// ZOOM+ — Host control panel (mute/kick/camera/screen-share/rename/promote/end).
//
// Mounts inside the ZOOM+ shell. On mount it probes GET /api/v1/zoomplus/
// host-controls/enabled — if the flag is OFF (or the fetch fails), the panel
// renders null and is completely invisible. The parent can always safely mount
// it; the probe is the gate.
//
// When enabled, it renders a collapsible panel with:
//   · a live participant list (polled every ~5s while expanded)
//   · per-participant controls: mute/unmute, kick, camera, screen-share,
//     promote/demote co-host, rename (inline input)
//   · footer: mute-all + end-meeting (with confirm)
//
// All inline-styled (C palette, miniBtnStyle, Spinner). French with curved
// ' apostrophes. dir="auto" on participant names. Fail-open: any fetch
// error shows a small inline status line, never crashes.

import { useCallback, useEffect, useRef, useState } from 'react';
import { C, Spinner, miniBtnStyle } from './shoperp-shared';

// ---------------------------------------------------------------------------
// Types — mirror the backend's ZoomPlusParticipant (subset we render).
// ---------------------------------------------------------------------------

interface ParticipantTrack {
  sid: string;
  type: string;
  source: string;
  muted: boolean;
}

interface Participant {
  sid: string;
  identity: string;
  name?: string;
  joinedAt?: number;
  tracks?: ParticipantTrack[];
}

// ---------------------------------------------------------------------------
// API helpers — plain fetch, AbortSignal.timeout, fail-open (null on error).
// ---------------------------------------------------------------------------

async function fetchEnabled(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/zoomplus/host-controls/enabled', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { enabled?: boolean } | null;
    return !!data?.enabled;
  } catch {
    return false;
  }
}

async function fetchParticipants(
  room: string,
  signal?: AbortSignal
): Promise<Participant[] | null> {
  try {
    const res = await fetch(
      `/api/v1/zoomplus/host/participants?room=${encodeURIComponent(room)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: signal ?? AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | { participants?: Participant[]; ok?: boolean }
      | null;
    if (data?.ok === false) return null;
    return Array.isArray(data?.participants) ? data!.participants : null;
  } catch {
    return null;
  }
}

async function postAction(
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, message: text || `Erreur ${res.status}` };
    }
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; message?: string }
      | null;
    return {
      ok: data?.ok !== false,
      message: typeof data?.message === 'string' ? data.message : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Erreur réseau",
    };
  }
}

// Room state — exists / participant count / policy flags (locked, muteOnEntry,
// recording). Backed by LiveKit ListRooms metadata. Fail-open (null on error).
interface RoomState {
  exists: boolean;
  numParticipants: number;
  locked: boolean;
  muteOnEntry: boolean;
  recording: boolean;
}

async function fetchRoomState(
  room: string,
  signal?: AbortSignal
): Promise<RoomState | null> {
  try {
    const res = await fetch(
      `/api/v1/zoomplus/host/room-state?room=${encodeURIComponent(room)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: signal ?? AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | (RoomState & { ok?: boolean })
      | null;
    if (!data || data.ok === false) return null;
    return {
      exists: !!data.exists,
      numParticipants: Number(data.numParticipants ?? 0),
      locked: !!data.locked,
      muteOnEntry: !!data.muteOnEntry,
      recording: !!data.recording,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small inline helpers
// ---------------------------------------------------------------------------

/** A brief inline status toast (auto-clears after ~4s). */
function useStatusToast(): {
  status: { kind: 'ok' | 'error'; text: string } | null;
  show: (kind: 'ok' | 'error', text: string) => void;
} {
  const [status, setStatus] = useState<{
    kind: 'ok' | 'error';
    text: string;
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((kind: 'ok' | 'error', text: string) => {
    setStatus({ kind, text });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setStatus(null), 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { status, show };
}

// Check if a participant has a mic track and whether it's muted.
function micMuted(p: Participant): boolean | null {
  const mic = p.tracks?.find(t => t.type === 'audio' && t.source === 'mic');
  if (!mic) return null;
  return mic.muted;
}

// Check if a participant has camera/screen-share in their publish sources.
// We can't see permissions directly in the participant list, so we infer from
// track presence.
function hasCamera(p: Participant): boolean {
  return !!p.tracks?.find(t => t.type === 'video' && t.source === 'camera');
}

function hasScreenShare(p: Participant): boolean {
  return !!p.tracks?.find(t => t.source === 'screen_share');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ZoomPlusHostPanel = ({ room }: { room: string }) => {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  // Room policy state (locked / mute-on-entry / recording) + recording support.
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  // Whether the recording (Egress) control is usable. null = untested; false =
  // the deployment reported egress unavailable (so we HIDE the button, never
  // fake it); true = a start/stop succeeded.
  const [recordingSupported, setRecordingSupported] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // in-flight action id
  const { status, show } = useStatusToast();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Guards the "mute on entry" auto-enforcement so we don't re-mute a
  // participant the host deliberately un-muted within the same session.
  const enforcedMutedRef = useRef<Set<string>>(new Set());

  // --- Probe on mount ---
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ok = await fetchEnabled();
      if (!cancelled) setEnabled(ok);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Poll participants + room state while expanded ---
  const refresh = useCallback(async () => {
    if (!room) return;
    setLoading(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    const [list, state] = await Promise.all([
      fetchParticipants(room, signal),
      fetchRoomState(room, signal),
    ]);
    setLoading(false);
    if (list !== null) {
      setParticipants(list);
    }
    if (state !== null) {
      setRoomState(state);
      // Enforce "mute on entry": if the policy is on, mute any participant whose
      // mic is live and whom we haven't already enforced this session. The host
      // can still un-mute someone (we remember and won't re-mute them).
      if (state.muteOnEntry && list) {
        for (const p of list) {
          const mic = p.tracks?.find(t => t.type === 'audio' && t.source === 'mic');
          if (mic && !mic.muted && !enforcedMutedRef.current.has(p.identity)) {
            enforcedMutedRef.current.add(p.identity);
            void postAction('/api/v1/zoomplus/host/mute', {
              room,
              identity: p.identity,
              trackSid: mic.sid,
              muted: true,
            });
          }
        }
      }
    }
  }, [room]);

  useEffect(() => {
    if (!enabled || !expanded || !room) return;
    void refresh();
    pollRef.current = setInterval(() => void refresh(), 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [enabled, expanded, room, refresh]);

  // --- Actions ---
  const doAction = useCallback(
    async (
      path: string,
      body: Record<string, unknown>,
      okMsg: string
    ): Promise<void> => {
      const result = await postAction(path, body);
      if (result.ok) {
        show('ok', okMsg);
        void refresh();
      } else {
        show('error', result.message || "Échec de l’action");
      }
    },
    [refresh, show]
  );

  const handleMute = useCallback(
    (p: Participant, muted: boolean) => {
      void doAction('/api/v1/zoomplus/host/mute', {
        room,
        identity: p.identity,
        muted,
      }, muted ? "Micro coupé" : "Micro réactivé");
    },
    [doAction, room]
  );

  const handleKick = useCallback(
    (p: Participant) => {
      void doAction('/api/v1/zoomplus/host/remove', {
        room,
        identity: p.identity,
      }, "Participant retiré");
    },
    [doAction, room]
  );

  const handleToggleCamera = useCallback(
    (p: Participant, allowed: boolean) => {
      void doAction('/api/v1/zoomplus/host/toggle-camera', {
        room,
        identity: p.identity,
        allowed,
      }, allowed ? "Caméra autorisée" : "Caméra désactivée");
    },
    [doAction, room]
  );

  const handleToggleScreenShare = useCallback(
    (p: Participant, allowed: boolean) => {
      void doAction('/api/v1/zoomplus/host/toggle-screen-share', {
        room,
        identity: p.identity,
        allowed,
      }, allowed ? "Partage d’écran autorisé" : "Partage d’écran désactivé");
    },
    [doAction, room]
  );

  const handlePromote = useCallback(
    (p: Participant) => {
      void doAction('/api/v1/zoomplus/host/promote', {
        room,
        identity: p.identity,
      }, "Promu co-hôte");
    },
    [doAction, room]
  );

  const handleDemote = useCallback(
    (p: Participant) => {
      void doAction('/api/v1/zoomplus/host/demote', {
        room,
        identity: p.identity,
      }, "Rétrogradé membre");
    },
    [doAction, room]
  );

  const handleRenameSubmit = useCallback(
    async (p: Participant) => {
      const name = renameValue.trim();
      if (!name) {
        setRenaming(null);
        return;
      }
      await doAction('/api/v1/zoomplus/host/rename', {
        room,
        identity: p.identity,
        name,
      }, "Nom mis à jour");
      setRenaming(null);
      setRenameValue('');
    },
    [doAction, renameValue, room]
  );

  const handleMuteAll = useCallback(async () => {
    const result = await postAction('/api/v1/zoomplus/host/mute-all', { room });
    if (result.ok) {
      const count = participants.length;
      show('ok', `${count} participant(s) rendu(s) muet(s)`);
      void refresh();
    } else {
      show('error', result.message || "Échec du muting global");
    }
  }, [participants.length, refresh, room, show]);

  const handleEndMeeting = useCallback(async () => {
    setConfirmingEnd(false);
    const result = await postAction('/api/v1/zoomplus/host/end', { room });
    if (result.ok) {
      show('ok', "Réunion terminée");
      setParticipants([]);
    } else {
      show('error', result.message || "Échec de la fin de réunion");
    }
  }, [room, show]);

  // --- Lock / unlock the meeting (room metadata; real LiveKit op) ---
  const handleToggleLock = useCallback(async () => {
    const next = !(roomState?.locked ?? false);
    setBusy('lock');
    const result = await postAction('/api/v1/zoomplus/host/lock', { room, locked: next });
    setBusy(null);
    if (result.ok) {
      setRoomState(s => (s ? { ...s, locked: next } : s));
      show('ok', next ? "Réunion verrouillée" : "Réunion déverrouillée");
      void refresh();
    } else {
      show('error', result.message || "Échec du verrouillage");
    }
  }, [room, roomState, refresh, show]);

  // --- Toggle "mute on entry" policy ---
  const handleToggleMuteOnEntry = useCallback(async () => {
    const next = !(roomState?.muteOnEntry ?? false);
    setBusy('moe');
    const result = await postAction('/api/v1/zoomplus/host/mute-on-entry', { room, enabled: next });
    setBusy(null);
    if (result.ok) {
      setRoomState(s => (s ? { ...s, muteOnEntry: next } : s));
      // Reset the enforcement memory so the policy re-applies cleanly.
      enforcedMutedRef.current.clear();
      show('ok', next ? "Micros coupés à l’entrée activé" : "Désactivé");
      void refresh();
    } else {
      show('error', result.message || "Échec du changement de politique");
    }
  }, [room, roomState, refresh, show]);

  // --- Recording start/stop (LiveKit Egress) ---
  // A failed start with a "no egress"/unavailable message flips recordingSupported
  // to false so the control HIDES (we never fake recording).
  const handleToggleRecording = useCallback(async () => {
    const isRec = roomState?.recording ?? false;
    setBusy('rec');
    const path = isRec
      ? '/api/v1/zoomplus/host/recording/stop'
      : '/api/v1/zoomplus/host/recording/start';
    const result = await postAction(path, { room });
    setBusy(null);
    if (result.ok) {
      setRecordingSupported(true);
      setRoomState(s => (s ? { ...s, recording: !isRec } : s));
      show('ok', isRec ? "Enregistrement arrêté" : "Enregistrement démarré");
      void refresh();
    } else {
      // Distinguish "egress not configured" (hide the control) from a transient
      // failure (keep it, show the error).
      const msg = (result.message || '').toLowerCase();
      if (
        !isRec &&
        (msg.includes('egress') || msg.includes('not configured') || msg.includes('unavailable') || msg.includes('501') || msg.includes('unimplemented'))
      ) {
        setRecordingSupported(false);
      }
      show('error', result.message || "Échec de l’enregistrement");
    }
  }, [room, roomState, refresh, show]);

  // --- Render ---
  // Probe not yet resolved — render nothing (fail-open, invisible).
  if (enabled === null) return null;
  // Flag is off — render nothing (invisible until the owner flips it).
  if (!enabled) return null;

  const panelStyle = {
    background: C.panel,
    borderBottom: `1px solid ${C.border}`,
    fontSize: 13,
  } as const;

  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 16px',
    cursor: 'pointer',
    userSelect: 'none' as const,
  };

  const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 16px',
    borderTop: `1px solid ${C.border}`,
    flexWrap: 'wrap' as const,
  };

  const nameStyle = {
    flex: 1,
    minWidth: 120,
    fontSize: 13,
    color: C.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  };

  const footerStyle = {
    display: 'flex',
    gap: 8,
    padding: '8px 16px',
    borderTop: `1px solid ${C.border}`,
    flexWrap: 'wrap' as const,
  };

  const statusStyle = {
    padding: '4px 16px',
    fontSize: 11.5,
    ...(status?.kind === 'ok'
      ? { color: C.okText }
      : { color: 'var(--affine-error-color, #eb4b4b)' }),
  };

  const inputRenameStyle = {
    flex: 1,
    minWidth: 100,
    padding: '4px 8px',
    borderRadius: 6,
    fontSize: 12,
    color: C.text,
    background: C.bg,
    border: `1px solid ${C.border}`,
    outline: 'none',
  };

  return (
    <div data-cdz-zoomplus-host="" style={panelStyle}>
      {/* Header / collapse toggle */}
      <div
        style={headerStyle}
        onClick={() => setExpanded(prev => !prev)}
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(prev => !prev);
          }
        }}
      >
        <span style={{ fontSize: 15 }}>🎛️</span>
        <span style={{ fontWeight: 800, color: C.text, flex: 1 }}>
          Contrôle hôte
        </span>
        {roomState?.recording && (
          <span
            aria-label="Enregistrement en cours"
            title="Enregistrement en cours"
            style={{ fontSize: 11, color: 'var(--affine-error-color, #eb4b4b)', fontWeight: 700 }}
          >
            ⏺ REC
          </span>
        )}
        {roomState?.locked && (
          <span title="Réunion verrouillée" style={{ fontSize: 12 }}>🔒</span>
        )}
        <span style={{ fontSize: 11, color: C.muted }}>
          {participants.length} participant(s)
        </span>
        <span style={{ fontSize: 13, color: C.muted }}>
          {expanded ? '▾' : '▸'}
        </span>
      </div>

      {/* Inline status toast */}
      {status && (
        <div style={statusStyle} role="status" aria-live="polite">
          {status.text}
        </div>
      )}

      {/* Expanded body */}
      {expanded && (
        <>
          {/* No room — show a message */}
          {!room && (
            <div style={{ padding: '8px 16px', fontSize: 12, color: C.muted }}>
              Sélectionnez la réunion pour voir les participants.
            </div>
          )}

          {/* Room set but no participants */}
          {room && participants.length === 0 && !loading && (
            <div style={{ padding: '8px 16px', fontSize: 12, color: C.muted }}>
              Aucun participant pour le moment.
            </div>
          )}

          {/* Loading indicator */}
          {room && loading && participants.length === 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 16px',
                color: C.muted,
                fontSize: 12,
              }}
            >
              <Spinner /> Chargement…
            </div>
          )}

          {/* Participant list */}
          {room &&
            participants.map(p => {
              const muted = micMuted(p);
              const cam = hasCamera(p);
              const ss = hasScreenShare(p);
              const isRenaming = renaming === p.identity;

              return (
                <div key={p.identity} style={rowStyle}>
                  {/* Name / identity */}
                  {isRenaming ? (
                    <>
                      <input
                        style={inputRenameStyle}
                        value={renameValue}
                        dir="auto"
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void handleRenameSubmit(p);
                          if (e.key === 'Escape') {
                            setRenaming(null);
                            setRenameValue('');
                          }
                        }}
                        autoFocus
                        placeholder="Nouveau nom"
                      />
                      <button
                        style={miniBtnStyle('primary')}
                        onClick={() => void handleRenameSubmit(p)}
                      >
                        ✓
                      </button>
                      <button
                        style={miniBtnStyle('secondary')}
                        onClick={() => {
                          setRenaming(null);
                          setRenameValue('');
                        }}
                      >
                        ✕
                      </button>
                    </>
                  ) : (
                    <>
                      <span style={nameStyle} dir="auto" title={p.identity}>
                        {p.name || p.identity}
                      </span>

                      {/* Mute / unmute */}
                      <button
                        style={miniBtnStyle(
                          muted === false ? 'danger' : 'secondary'
                        )}
                        onClick={() => handleMute(p, !(muted ?? true))}
                        title={muted ? "Réactiver le micro" : "Couper le micro"}
                      >
                        {muted ? '🔇' : '🎤'}
                      </button>

                      {/* Camera toggle */}
                      <button
                        style={miniBtnStyle(cam ? 'danger' : 'secondary')}
                        onClick={() => handleToggleCamera(p, !cam)}
                        title={cam ? "Désactiver la caméra" : "Autoriser la caméra"}
                      >
                        {cam ? '📷' : '🚫📷'}
                      </button>

                      {/* Screen share toggle */}
                      <button
                        style={miniBtnStyle(ss ? 'danger' : 'secondary')}
                        onClick={() => handleToggleScreenShare(p, !ss)}
                        title={
                          ss
                            ? "Désactiver le partage d’écran"
                            : "Autoriser le partage d’écran"
                        }
                      >
                        {ss ? '🖥️' : '🚫🖥️'}
                      </button>

                      {/* Rename */}
                      <button
                        style={miniBtnStyle('secondary')}
                        onClick={() => {
                          setRenaming(p.identity);
                          setRenameValue(p.name || '');
                        }}
                        title="Renommer"
                      >
                        ✏️
                      </button>

                      {/* Promote / demote */}
                      <button
                        style={miniBtnStyle('primary')}
                        onClick={() => handlePromote(p)}
                        title="Promouvoir co-hôte"
                      >
                        ⬆️
                      </button>
                      <button
                        style={miniBtnStyle('secondary')}
                        onClick={() => handleDemote(p)}
                        title="Rétrograder"
                      >
                        ⬇️
                      </button>

                      {/* Kick */}
                      <button
                        style={miniBtnStyle('danger')}
                        onClick={() => handleKick(p)}
                        title="Retirer"
                      >
                        🚪
                      </button>
                    </>
                  )}
                </div>
              );
            })}

          {/* Meeting-wide policy controls — lock / mute-on-entry / recording.
              All wired to REAL LiveKit ops via the backend. The recording
              button is HIDDEN (not faked) when egress is unavailable. */}
          {room && (
            <div
              style={{
                ...footerStyle,
                borderTop: `1px solid ${C.border}`,
                background: C.panel2,
              }}
            >
              <button
                style={miniBtnStyle(roomState?.locked ? 'danger' : 'secondary', busy === 'lock')}
                disabled={busy === 'lock'}
                onClick={() => void handleToggleLock()}
                title={roomState?.locked ? "Déverrouiller la réunion" : "Verrouiller la réunion"}
              >
                {busy === 'lock' ? <Spinner /> : roomState?.locked ? '🔒 Verrouillée' : '🔓 Verrouiller'}
              </button>

              <button
                style={miniBtnStyle(roomState?.muteOnEntry ? 'danger' : 'secondary', busy === 'moe')}
                disabled={busy === 'moe'}
                onClick={() => void handleToggleMuteOnEntry()}
                title="Couper les micros à l’entrée"
              >
                {busy === 'moe' ? <Spinner /> : roomState?.muteOnEntry ? '🔕 Sourdine entrée' : '🔔 Sourdine entrée'}
              </button>

              {/* Recording — only shown while egress hasn't reported unavailable. */}
              {recordingSupported !== false && (
                <button
                  style={miniBtnStyle(roomState?.recording ? 'danger' : 'secondary', busy === 'rec')}
                  disabled={busy === 'rec'}
                  onClick={() => void handleToggleRecording()}
                  title={roomState?.recording ? "Arrêter l’enregistrement serveur" : "Démarrer l’enregistrement serveur"}
                >
                  {busy === 'rec' ? <Spinner /> : roomState?.recording ? '⏹ Enregistrement' : '⏺ Enregistrer (serveur)'}
                </button>
              )}
            </div>
          )}

          {/* Footer actions */}
          {room && (
            <div style={footerStyle}>
              <button
                style={miniBtnStyle('secondary')}
                onClick={() => void handleMuteAll()}
                disabled={participants.length === 0}
              >
                🔇 Rendre muet tout le monde
              </button>

              {confirmingEnd ? (
                <>
                  <span style={{ fontSize: 12, color: C.text }}>
                    Terminer la réunion ?
                  </span>
                  <button
                    style={miniBtnStyle('danger')}
                    onClick={() => void handleEndMeeting()}
                  >
                    ✓ Confirmer
                  </button>
                  <button
                    style={miniBtnStyle('secondary')}
                    onClick={() => setConfirmingEnd(false)}
                  >
                    Annuler
                  </button>
                </>
              ) : (
                <button
                  style={miniBtnStyle('danger')}
                  onClick={() => setConfirmingEnd(true)}
                  disabled={participants.length === 0}
                >
                  ⏹ Terminer la réunion
                </button>
              )}

              <button
                style={miniBtnStyle('secondary')}
                onClick={() => void refresh()}
                title="Rafraîchir"
              >
                ↻
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
