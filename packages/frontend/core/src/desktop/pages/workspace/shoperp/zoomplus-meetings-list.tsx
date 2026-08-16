// ZOOM+ — meetings list (upcoming / past) with start / join / copy-invite /
// delete + a French invite-text generator.
//
// Reads the per-workspace meeting store (zoomplus-meetings). "Start" and "Join"
// both open the live room (the shell pre-applies the meeting's room policy on
// start); "Copy invite" builds a French invite block; "Delete" removes the
// record. Inline-styled with the shared shoperp palette, French labels.

import { useMemo, useState } from 'react';
import {
  C,
  Panel,
  EmptyNote,
  miniBtnStyle,
  Banner,
} from './shoperp-shared';
import {
  type Meeting,
  RECURRENCE_LABELS,
  deleteMeeting,
  buildInviteText,
  roomJoinUrl,
  formatMeetingWhen,
  isPast,
} from './zoomplus-meetings';

const badgeStyle = (bg: string, fg: string): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 10.5,
  fontWeight: 700,
  padding: '2px 8px',
  borderRadius: 999,
  color: fg,
  background: bg,
  whiteSpace: 'nowrap',
});

const MeetingRow = ({
  meeting,
  past,
  onStart,
  onJoin,
  onCopyInvite,
  onDelete,
}: {
  meeting: Meeting;
  past: boolean;
  onStart: () => void;
  onJoin: () => void;
  onCopyInvite: () => void;
  onDelete: () => void;
}) => {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 0',
        borderTop: `1px solid ${C.border}`,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text }} dir="auto">
            {meeting.title}
          </span>
          {meeting.recurrence !== 'none' && (
            <span style={badgeStyle(C.accentSoft, C.text)}>🔁 {RECURRENCE_LABELS[meeting.recurrence]}</span>
          )}
          {meeting.settings.passcode.trim() && (
            <span style={badgeStyle('color-mix(in srgb, #e8a33d 16%, transparent)', C.text)}>🔒 Code</span>
          )}
          {meeting.settings.waitingRoom && (
            <span style={badgeStyle(C.panel2, C.muted)}>⏳ Salle d’attente</span>
          )}
          {meeting.settings.autoRecord && (
            <span style={badgeStyle('color-mix(in srgb, #eb4b4b 14%, transparent)', C.text)}>⏺ Auto</span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3 }}>
          {formatMeetingWhen(meeting)} · {meeting.durationMin} min
          {meeting.coHosts.length > 0 && ` · ${meeting.coHosts.length} co-hôte(s)`}
        </div>
        {meeting.agenda.trim() && (
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3, whiteSpace: 'pre-wrap', maxHeight: 44, overflow: 'hidden' }} dir="auto">
            {meeting.agenda.trim()}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {!past ? (
          <button style={miniBtnStyle('primary')} onClick={onStart} title="Démarrer et appliquer les paramètres">
            🔴 Démarrer
          </button>
        ) : (
          <button style={miniBtnStyle('secondary')} onClick={onJoin} title="Rouvrir cette salle">
            ↩ Rouvrir
          </button>
        )}
        <button style={miniBtnStyle('secondary')} onClick={onJoin} title="Rejoindre sans réappliquer les paramètres">
          ▶ Rejoindre
        </button>
        <button style={miniBtnStyle('secondary')} onClick={onCopyInvite} title="Copier l’invitation (français)">
          ✉ Invitation
        </button>
        {confirmDelete ? (
          <>
            <button style={miniBtnStyle('danger')} onClick={onDelete}>✓ Supprimer</button>
            <button style={miniBtnStyle('secondary')} onClick={() => setConfirmDelete(false)}>Annuler</button>
          </>
        ) : (
          <button style={miniBtnStyle('danger')} onClick={() => setConfirmDelete(true)} title="Supprimer">
            🗑
          </button>
        )}
      </div>
    </div>
  );
};

export const ZoomPlusMeetingsList = ({
  slug,
  meetings,
  onChange,
  onStart,
  onJoin,
}: {
  slug: string;
  meetings: Meeting[];
  onChange: () => void;
  onStart: (m: Meeting) => void;
  onJoin: (m: Meeting) => void;
}) => {
  const [copied, setCopied] = useState<string | null>(null);
  const [inviteModal, setInviteModal] = useState<Meeting | null>(null);

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const up: Meeting[] = [];
    const pa: Meeting[] = [];
    for (const m of meetings) {
      (isPast(m, now) ? pa : up).push(m);
    }
    // Upcoming: soonest first. Past: most recent first.
    up.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    pa.sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime());
    return { upcoming: up, past: pa };
  }, [meetings]);

  const handleCopyInvite = (m: Meeting) => {
    const text = buildInviteText(m);
    let ok = false;
    try {
      void navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
    if (ok) {
      setCopied(m.id);
      setTimeout(() => setCopied(c => (c === m.id ? null : c)), 2500);
    } else {
      // Clipboard blocked (e.g. non-secure context) — show the text to copy.
      setInviteModal(m);
    }
  };

  const handleDelete = (m: Meeting) => {
    deleteMeeting(slug, m.id);
    onChange();
  };

  return (
    <Panel title={`Mes réunions (${meetings.length})`}>
      {copied && (
        <div style={{ marginBottom: 10 }}>
          <Banner tone="ok">Invitation copiée dans le presse-papiers.</Banner>
        </div>
      )}

      {meetings.length === 0 ? (
        <EmptyNote>
          Aucune réunion planifiée. Utilisez « Planifier une réunion » ci-dessus pour en créer une.
        </EmptyNote>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Upcoming */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: C.muted, marginBottom: 2 }}>
              À venir ({upcoming.length})
            </div>
            {upcoming.length === 0 ? (
              <div style={{ fontSize: 12, color: C.muted, padding: '8px 0' }}>Aucune réunion à venir.</div>
            ) : (
              upcoming.map(m => (
                <MeetingRow
                  key={m.id}
                  meeting={m}
                  past={false}
                  onStart={() => onStart(m)}
                  onJoin={() => onJoin(m)}
                  onCopyInvite={() => handleCopyInvite(m)}
                  onDelete={() => handleDelete(m)}
                />
              ))
            )}
          </div>

          {/* Past */}
          {past.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: C.muted, marginBottom: 2 }}>
                Passées ({past.length})
              </div>
              {past.map(m => (
                <MeetingRow
                  key={m.id}
                  meeting={m}
                  past
                  onStart={() => onStart(m)}
                  onJoin={() => onJoin(m)}
                  onCopyInvite={() => handleCopyInvite(m)}
                  onDelete={() => handleDelete(m)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Invite fallback modal — shown when the clipboard is unavailable so the
          host can still copy the text manually. */}
      {inviteModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 20,
          }}
          onClick={() => setInviteModal(null)}
        >
          <div
            style={{
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 14,
              padding: 18,
              maxWidth: 520,
              width: '100%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 4 }}>
              Invitation — {inviteModal.title}
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
              Copiez ce texte pour l’envoyer par e-mail ou WhatsApp.
            </div>
            <textarea
              readOnly
              dir="auto"
              value={buildInviteText(inviteModal)}
              onFocus={e => e.currentTarget.select()}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                minHeight: 220,
                padding: '10px 12px',
                borderRadius: 10,
                fontSize: 12.5,
                fontFamily: 'monospace',
                lineHeight: 1.5,
                color: C.text,
                background: C.bg,
                border: `1px solid ${C.border}`,
                outline: 'none',
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: C.muted, marginRight: 'auto', fontFamily: 'monospace' }}>
                {roomJoinUrl(inviteModal.room)}
              </span>
              <button style={miniBtnStyle('secondary')} onClick={() => setInviteModal(null)}>Fermer</button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
};
