// ZOOM+ — meeting scheduler (creation form with real settings).
//
// Creates a Meeting record (persisted per-workspace via zoomplus-meetings) with
// a REAL LiveKit room name + join URL into the live Meet instance. The settings
// (waiting room, passcode, mute-on-entry, auto-record, lock, co-hosts) map onto
// real backend room operations that the shell pre-applies when the meeting is
// started. Seeds from the per-workspace defaults so a host doesn't re-toggle.
//
// Inline-styled with the shared shoperp palette/primitives, French labels,
// curved ’ apostrophes — consistent with the sibling shoperp pages.

import { useCallback, useMemo, useState } from 'react';
import {
  C,
  Panel,
  Field,
  inputStyle,
  hintStyle,
  btnStyle,
  miniBtnStyle,
} from './shoperp-shared';
import {
  type Meeting,
  type MeetingSettings,
  type Recurrence,
  RECURRENCE_LABELS,
  TIMEZONE_OPTIONS,
  localTimezone,
  deriveRoomName,
  addMeeting,
  readDefaults,
} from './zoomplus-meetings';

// A labeled checkbox row (the house pattern is inline-styled; there's no shared
// toggle, so we render a compact native checkbox styled to match).
const Toggle = ({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) => (
  <label
    style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      cursor: 'pointer',
      padding: '6px 0',
    }}
  >
    <input
      type="checkbox"
      checked={checked}
      onChange={e => onChange(e.target.checked)}
      style={{ marginTop: 2, width: 16, height: 16, accentColor: C.accent, cursor: 'pointer' }}
    />
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>{label}</span>
      {hint && <span style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.4 }}>{hint}</span>}
    </span>
  </label>
);

/** Default the date/time input to the next round half-hour, local. */
function defaultLocalDateTime(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  // datetime-local wants YYYY-MM-DDTHH:mm in LOCAL time.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseCoHosts(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(s => s.includes('@'));
}

export const ZoomPlusScheduler = ({
  slug,
  onCreated,
}: {
  slug: string;
  /** Called after a meeting is created. `start` = the host clicked "Créer et démarrer". */
  onCreated: (meeting: Meeting, start: boolean) => void;
}) => {
  const [expanded, setExpanded] = useState(false);
  const defaults = useMemo<MeetingSettings>(() => readDefaults(slug), [slug]);

  const [title, setTitle] = useState('');
  const [agenda, setAgenda] = useState('');
  const [startsLocal, setStartsLocal] = useState(defaultLocalDateTime);
  const [durationMin, setDurationMin] = useState(30);
  const [timezone, setTimezone] = useState(localTimezone());
  const [recurrence, setRecurrence] = useState<Recurrence>('none');
  const [coHostsRaw, setCoHostsRaw] = useState('');
  const [settings, setSettings] = useState<MeetingSettings>({ ...defaults });
  const [titleError, setTitleError] = useState<string | null>(null);

  const patchSettings = useCallback((p: Partial<MeetingSettings>) => {
    setSettings(s => ({ ...s, ...p }));
  }, []);

  const reset = useCallback(() => {
    setTitle('');
    setAgenda('');
    setStartsLocal(defaultLocalDateTime());
    setDurationMin(30);
    setTimezone(localTimezone());
    setRecurrence('none');
    setCoHostsRaw('');
    setSettings({ ...readDefaults(slug) });
    setTitleError(null);
  }, [slug]);

  const create = useCallback(
    (start: boolean): void => {
      const t = title.trim();
      if (!t) {
        setTitleError('Le titre est requis.');
        return;
      }
      setTitleError(null);
      // datetime-local is naive local wall-clock; store as an ISO string. The
      // formatter re-renders it in the chosen tz so the wall-clock the host
      // typed is preserved semantically.
      const startsAt = startsLocal ? new Date(startsLocal).toISOString() : '';
      const meeting: Meeting = {
        id: `mtg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        room: deriveRoomName(t),
        title: t,
        agenda: agenda.trim(),
        startsAt,
        durationMin: Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 30,
        timezone,
        recurrence,
        coHosts: parseCoHosts(coHostsRaw),
        settings: { ...settings },
        createdAt: new Date().toISOString(),
      };
      addMeeting(slug, meeting);
      reset();
      setExpanded(false);
      onCreated(meeting, start);
    },
    [title, agenda, startsLocal, durationMin, timezone, recurrence, coHostsRaw, settings, slug, reset, onCreated]
  );

  const action = (
    <button
      style={miniBtnStyle(expanded ? 'secondary' : 'primary')}
      onClick={() => setExpanded(e => !e)}
    >
      {expanded ? '✕ Fermer' : '＋ Planifier une réunion'}
    </button>
  );

  return (
    <Panel title="Planifier une réunion" action={action}>
      {!expanded ? (
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
          Créez une réunion avec un lien dédié, une salle d’attente, un code d’accès et
          l’enregistrement automatique. Vous pourrez la démarrer immédiatement ou la retrouver
          dans la liste ci-dessous.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Title + agenda */}
          <Field label="Titre" error={titleError}>
            <input
              style={inputStyle}
              dir="auto"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Ex : Réunion équipe commerciale"
            />
          </Field>
          <Field label="Ordre du jour (optionnel)">
            <textarea
              style={{ ...inputStyle, minHeight: 70, resize: 'vertical', lineHeight: 1.5 }}
              dir="auto"
              value={agenda}
              onChange={e => setAgenda(e.target.value)}
              placeholder="Points à aborder, un par ligne…"
            />
          </Field>

          {/* Date / time / duration / tz — responsive grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Field label="Date et heure">
              <input
                type="datetime-local"
                style={inputStyle}
                value={startsLocal}
                onChange={e => setStartsLocal(e.target.value)}
              />
            </Field>
            <Field label="Durée (min)">
              <input
                type="number"
                min={5}
                max={600}
                step={5}
                style={inputStyle}
                value={durationMin}
                onChange={e => setDurationMin(parseInt(e.target.value, 10) || 0)}
              />
            </Field>
            <Field label="Fuseau horaire">
              <select
                style={{ ...inputStyle, cursor: 'pointer', appearance: 'auto' }}
                value={timezone}
                onChange={e => setTimezone(e.target.value)}
              >
                {/* Ensure the resolved local tz is always selectable. */}
                {(TIMEZONE_OPTIONS.includes(timezone) ? TIMEZONE_OPTIONS : [timezone, ...TIMEZONE_OPTIONS]).map(tz => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </Field>
            <Field label="Récurrence">
              <select
                style={{ ...inputStyle, cursor: 'pointer', appearance: 'auto' }}
                value={recurrence}
                onChange={e => setRecurrence(e.target.value as Recurrence)}
              >
                {(Object.keys(RECURRENCE_LABELS) as Recurrence[]).map(r => (
                  <option key={r} value={r}>{RECURRENCE_LABELS[r]}</option>
                ))}
              </select>
            </Field>
          </div>

          {/* Co-hosts */}
          <Field label="Co-hôtes (e-mails, séparés par des virgules)" hint="Ces personnes pourront co-animer la réunion.">
            <input
              style={inputStyle}
              value={coHostsRaw}
              onChange={e => setCoHostsRaw(e.target.value)}
              placeholder="amine@exemple.dz, sara@exemple.dz"
            />
          </Field>

          {/* Meeting options */}
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: C.muted, marginBottom: 6 }}>
              Options de la réunion
            </div>
            <Toggle
              label="Salle d’attente"
              hint="Les participants patientent jusqu’à ce que l’hôte les admette."
              checked={settings.waitingRoom}
              onChange={v => patchSettings({ waitingRoom: v })}
            />
            <Toggle
              label="Couper les micros à l’entrée"
              hint="Chaque participant rejoint en sourdine."
              checked={settings.muteOnEntry}
              onChange={v => patchSettings({ muteOnEntry: v })}
            />
            <Toggle
              label="Verrouiller la réunion au démarrage"
              hint="Aucun nouveau participant ne peut rejoindre une fois démarrée."
              checked={settings.lockOnStart}
              onChange={v => patchSettings({ lockOnStart: v })}
            />
            <Toggle
              label="Enregistrement automatique"
              hint="Démarre l’enregistrement dès le début de la réunion."
              checked={settings.autoRecord}
              onChange={v => patchSettings({ autoRecord: v })}
            />
            <div style={{ marginTop: 6 }}>
              <Field label="Code d’accès (optionnel)">
                <input
                  style={{ ...inputStyle, maxWidth: 220 }}
                  value={settings.passcode}
                  onChange={e => patchSettings({ passcode: e.target.value.slice(0, 20) })}
                  placeholder="Ex : 4821"
                />
              </Field>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', paddingTop: 4 }}>
            <button style={btnStyle('primary')} onClick={() => create(true)}>
              🔴 Créer et démarrer
            </button>
            <button style={btnStyle('secondary')} onClick={() => create(false)}>
              📅 Créer seulement
            </button>
            <span style={{ flex: 1 }} />
            <button style={btnStyle('secondary')} onClick={reset}>Réinitialiser</button>
          </div>
          <div style={hintStyle}>
            Un lien de réunion unique est généré automatiquement. La réunion reste privée à cet
            espace de travail.
          </div>
        </div>
      )}
    </Panel>
  );
};
