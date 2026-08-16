// ZOOM+ — per-workspace default meeting settings.
//
// The defaults seed every new meeting in the scheduler (so a host doesn't
// re-toggle the same options each time). Persisted per-workspace in
// localStorage via zoomplus-meetings (readDefaults/writeDefaults) — the house
// persistence pattern (see shipping.tsx pickupStorageKey). Also surfaces which
// provider capabilities are wired (host controls / AI summary) so the owner
// knows what is live vs limited — nothing is faked.

import { useCallback, useEffect, useState } from 'react';
import {
  C,
  Panel,
  Field,
  inputStyle,
  btnStyle,
  Banner,
} from './shoperp-shared';
import {
  type MeetingSettings,
  type ProviderCapabilities,
  DEFAULT_MEETING_SETTINGS,
  readDefaults,
  writeDefaults,
} from './zoomplus-meetings';

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
  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '7px 0' }}>
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

const CapRow = ({ label, on, detail }: { label: string; on: boolean; detail: string }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 12.5 }}>
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: on ? 'var(--affine-success-color, #4cae4c)' : C.muted,
        flexShrink: 0,
      }}
    />
    <span style={{ color: C.text, fontWeight: 600 }}>{label}</span>
    <span style={{ color: C.muted }}>— {detail}</span>
  </div>
);

export const ZoomPlusDefaultsPanel = ({
  slug,
  caps,
}: {
  slug: string;
  caps: ProviderCapabilities | null;
}) => {
  const [settings, setSettings] = useState<MeetingSettings>(() => readDefaults(slug));
  const [savedNote, setSavedNote] = useState(false);

  // Re-read when the workspace changes.
  useEffect(() => {
    setSettings(readDefaults(slug));
  }, [slug]);

  const patch = useCallback((p: Partial<MeetingSettings>) => {
    setSettings(s => ({ ...s, ...p }));
    setSavedNote(false);
  }, []);

  const save = useCallback(() => {
    writeDefaults(slug, settings);
    setSavedNote(true);
    setTimeout(() => setSavedNote(false), 2500);
  }, [slug, settings]);

  const resetDefaults = useCallback(() => {
    setSettings({ ...DEFAULT_MEETING_SETTINGS });
    setSavedNote(false);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="Paramètres par défaut des réunions">
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 10 }}>
          Ces valeurs sont pré-remplies à chaque nouvelle réunion de cet espace de travail.
          Vous pouvez toujours les ajuster réunion par réunion.
        </div>

        <Toggle
          label="Salle d’attente"
          hint="Les participants patientent jusqu’à admission par l’hôte."
          checked={settings.waitingRoom}
          onChange={v => patch({ waitingRoom: v })}
        />
        <Toggle
          label="Couper les micros à l’entrée"
          hint="Chaque participant rejoint en sourdine."
          checked={settings.muteOnEntry}
          onChange={v => patch({ muteOnEntry: v })}
        />
        <Toggle
          label="Verrouiller la réunion au démarrage"
          hint="Aucun nouveau participant une fois la réunion démarrée."
          checked={settings.lockOnStart}
          onChange={v => patch({ lockOnStart: v })}
        />
        <Toggle
          label="Enregistrement automatique"
          hint="Démarre l’enregistrement dès le début de la réunion."
          checked={settings.autoRecord}
          onChange={v => patch({ autoRecord: v })}
        />

        <div style={{ marginTop: 8 }}>
          <Field label="Code d’accès par défaut (optionnel)" hint="Laissez vide pour ne pas exiger de code par défaut.">
            <input
              style={{ ...inputStyle, maxWidth: 220 }}
              value={settings.passcode}
              onChange={e => patch({ passcode: e.target.value.slice(0, 20) })}
              placeholder="Ex : 4821"
            />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <button style={btnStyle('primary')} onClick={save}>💾 Enregistrer les valeurs par défaut</button>
          <button style={btnStyle('secondary')} onClick={resetDefaults}>Réinitialiser</button>
          {savedNote && <span style={{ fontSize: 12.5, color: C.okText }}>Enregistré.</span>}
        </div>
      </Panel>

      {/* Provider capability status — honest disclosure of what's wired. */}
      <Panel title="État du service">
        {caps === null ? (
          <div style={{ fontSize: 12.5, color: C.muted }}>Vérification des capacités…</div>
        ) : (
          <>
            <CapRow
              label="Contrôles hôte en direct"
              on={caps.hostControls}
              detail={
                caps.hostControls
                  ? 'couper/retirer, verrouiller, enregistrer — actifs'
                  : 'non activés par l’administrateur'
              }
            />
            <CapRow
              label="Résumé IA de réunion"
              on={caps.summary}
              detail={caps.summary ? 'génération de résumé disponible' : 'non activé par l’administrateur'}
            />
            {(!caps.hostControls || !caps.summary) && (
              <div style={{ marginTop: 10 }}>
                <Banner tone="info">
                  Les fonctions non activées sont masquées dans l’interface. Un administrateur peut les
                  activer côté serveur (contrôles hôte LiveKit et résumé IA).
                </Banner>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
};
