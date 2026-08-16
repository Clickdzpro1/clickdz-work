// social/settings.tsx — UP1 Advanced Social settings.
// Per-network content defaults (hashtags · first-comment · posting windows),
// workspace-wide UTM link parameters, and queue rules (rate caps · min gap ·
// auto-requeue · approval gate). Persisted per-user via PUT /api/v1/social/settings.
// FR/AR/RTL, C-palette, matches the sibling shoperp studio panels.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banner, C, miniBtnStyle, Spinner } from '../shoperp-shared';
import {
  bestTimes,
  fetchSettings,
  getNetworkMeta,
  saveSettings,
  SOCIAL_NETWORKS,
  type NetworkDefaults,
  type PostingWindow,
  type QueueRules,
  type SocialSettings,
  type UtmSettings,
} from './api';

interface Props {
  lang: 'fr' | 'ar' | 'en';
  dict: Record<string, string>;
  connectedNetworks: string[];
}

const DAY_LABELS: Record<'fr' | 'ar' | 'en', string[]> = {
  fr: ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'],
  ar: ['أحد', 'إثن', 'ثلا', 'أرب', 'خمي', 'جمع', 'سبت'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};

const inputSm = {
  borderRadius: 8,
  border: `1px solid ${C.border}`,
  background: C.panel2,
  color: C.text,
  padding: '7px 10px',
  fontSize: 12.5,
  fontFamily: 'inherit',
  boxSizing: 'border-box' as const,
};

const Section = ({
  title,
  desc,
  children,
  rtl,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
  rtl?: boolean;
}) => (
  <div
    style={{
      borderRadius: 12,
      border: `1px solid ${C.border}`,
      background: C.panel,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}
  >
    <div style={{ direction: rtl ? 'rtl' : undefined }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{title}</div>
      {desc && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{desc}</div>}
    </div>
    {children}
  </div>
);

const Toggle = ({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) => (
  <label style={{ fontSize: 12, color: C.text, display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
    {label}
  </label>
);

export const SettingsView = ({ lang, dict, connectedNetworks }: Props) => {
  const rtl = lang === 'ar';
  const dayLabels = DAY_LABELS[lang];
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);

  // Working copy of settings (the source of truth while editing).
  const [timezone, setTimezone] = useState('');
  const [networks, setNetworks] = useState<Record<string, NetworkDefaults>>({});
  const [utm, setUtm] = useState<UtmSettings>({});
  const [queue, setQueue] = useState<QueueRules>({});
  // Which network's defaults are expanded in the accordion.
  const [openNet, setOpenNet] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await fetchSettings();
      setTimezone(s.timezone ?? guessTimezone());
      setNetworks(s.networks ?? {});
      setUtm(s.utm ?? {});
      setQueue(s.queue ?? {});
    } catch {
      /* keep defaults */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Networks to show in the per-network accordion: connected first, else all 10.
  const netList = useMemo(
    () => (connectedNetworks.length ? connectedNetworks : SOCIAL_NETWORKS.map(n => n.slug)),
    [connectedNetworks]
  );

  const patchNetwork = (slug: string, patch: Partial<NetworkDefaults>) => {
    setNetworks(prev => ({ ...prev, [slug]: { ...(prev[slug] ?? {}), ...patch } }));
  };

  const save = useCallback(async () => {
    setSaving(true);
    setNote(null);
    // Build a normalized patch. Empty network defaults are dropped so a cleared
    // network doesn't linger; the backend merges per-slug.
    const cleanNetworks: Record<string, NetworkDefaults> = {};
    for (const [slug, def] of Object.entries(networks)) {
      const nd: NetworkDefaults = {};
      if (def.hashtags?.length) nd.hashtags = def.hashtags;
      if (def.firstComment?.trim()) nd.firstComment = def.firstComment.trim();
      if (def.windows?.length) nd.windows = def.windows;
      // Always include the key (even empty) so the server can clear it.
      cleanNetworks[slug] = nd;
    }
    const payload: SocialSettings = {
      timezone: timezone.trim() || undefined,
      networks: cleanNetworks,
      utm,
      queue,
    };
    try {
      const res = await saveSettings(payload);
      if (res.ok) {
        setNote({ text: dict.settingsSaved ?? 'Réglages enregistrés.', tone: 'ok' });
        if (res.settings) {
          setNetworks(res.settings.networks ?? {});
          setUtm(res.settings.utm ?? {});
          setQueue(res.settings.queue ?? {});
        }
      } else {
        setNote({ text: dict.settingsFail ?? "L'enregistrement a échoué.", tone: 'err' });
      }
    } catch {
      setNote({ text: dict.settingsFail ?? "L'enregistrement a échoué.", tone: 'err' });
    } finally {
      setSaving(false);
    }
  }, [timezone, networks, utm, queue, dict]);

  if (loading) {
    return (
      <div style={{ display: 'flex', gap: 8, color: C.muted, padding: '30px 0' }}>
        <Spinner /> {dict.loading ?? 'Chargement…'}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Banner tone="info">
        {dict.settingsIntro ??
          'Ces réglages s’appliquent automatiquement lors de la publication : hashtags par défaut, paramètres UTM sur les liens, premier commentaire, et règles de file d’attente.'}
      </Banner>

      {/* Timezone */}
      <Section title={dict.timezone ?? 'Fuseau horaire'} desc={dict.timezoneDesc ?? 'Utilisé pour les fenêtres de publication.'} rtl={rtl}>
        <input
          value={timezone}
          onChange={e => setTimezone(e.target.value)}
          placeholder="Africa/Algiers"
          style={{ ...inputSm, maxWidth: 320 }}
        />
      </Section>

      {/* Per-network defaults */}
      <Section
        title={dict.networkDefaults ?? 'Réglages par réseau'}
        desc={dict.networkDefaultsDesc ?? 'Hashtags, premier commentaire et créneaux préférés par réseau.'}
        rtl={rtl}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {netList.map(slug => {
            const meta = getNetworkMeta(slug);
            const def = networks[slug] ?? {};
            const isOpen = openNet === slug;
            const summary: string[] = [];
            if (def.hashtags?.length) summary.push(`${def.hashtags.length} #`);
            if (def.firstComment?.trim()) summary.push(dict.hasFirstComment ?? '1er comm.');
            if (def.windows?.length) summary.push(`${def.windows.length} ${dict.windowsShort ?? 'créneaux'}`);
            return (
              <div key={slug} style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.panel2 }}>
                <button
                  onClick={() => setOpenNet(isOpen ? null : slug)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 12px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: C.text,
                  }}
                >
                  <span style={{ fontSize: 15, fontWeight: 800, width: 22, textAlign: 'center' }}>{meta?.icon ?? slug[0].toUpperCase()}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, textAlign: rtl ? 'right' : 'left' }}>{meta?.label ?? slug}</span>
                  {summary.length > 0 && (
                    <span style={{ fontSize: 10.5, color: C.muted }}>{summary.join(' · ')}</span>
                  )}
                  <span style={{ fontSize: 11, color: C.muted }}>{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen && (
                  <div style={{ padding: '4px 12px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <NetworkDefaultsEditor
                      lang={lang}
                      dict={dict}
                      slug={slug}
                      def={def}
                      charLimit={meta?.charLimit}
                      dayLabels={dayLabels}
                      onChange={patch => patchNetwork(slug, patch)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {/* UTM */}
      <Section title={dict.utmTitle ?? 'Paramètres UTM (liens)'} desc={dict.utmDesc ?? 'Ajoutés automatiquement au premier lien de chaque publication.'} rtl={rtl}>
        <Toggle
          checked={!!utm.enabled}
          onChange={v => setUtm(u => ({ ...u, enabled: v }))}
          label={dict.utmEnable ?? 'Activer le marquage UTM'}
        />
        {utm.enabled && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
            <Labeled label="utm_source">
              <input value={utm.source ?? ''} onChange={e => setUtm(u => ({ ...u, source: e.target.value }))} placeholder="social" style={inputSm} />
            </Labeled>
            <Labeled label="utm_medium">
              <input value={utm.medium ?? ''} onChange={e => setUtm(u => ({ ...u, medium: e.target.value }))} placeholder={dict.utmMediumHint ?? '(réseau)'} style={inputSm} />
            </Labeled>
            <Labeled label="utm_campaign">
              <input value={utm.campaign ?? ''} onChange={e => setUtm(u => ({ ...u, campaign: e.target.value }))} placeholder="promo_ete" style={inputSm} />
            </Labeled>
          </div>
        )}
      </Section>

      {/* Queue rules */}
      <Section title={dict.queueRules ?? 'Règles de file d’attente'} desc={dict.queueRulesDesc ?? 'Cadence, espacement et validation des publications.'} rtl={rtl}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <Labeled label={dict.maxPerDay ?? 'Max publications / jour / réseau'}>
            <input
              type="number"
              min={0}
              max={100}
              value={queue.maxPerDayPerNetwork ?? ''}
              onChange={e => setQueue(q => ({ ...q, maxPerDayPerNetwork: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) }))}
              placeholder={dict.unlimited ?? 'illimité'}
              style={inputSm}
            />
          </Labeled>
          <Labeled label={dict.minGap ?? 'Écart minimum (minutes)'}>
            <input
              type="number"
              min={0}
              max={720}
              value={queue.minGapMinutes ?? ''}
              onChange={e => setQueue(q => ({ ...q, minGapMinutes: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) }))}
              placeholder="0"
              style={inputSm}
            />
          </Labeled>
        </div>
        <Toggle
          checked={!!queue.autoRequeueOnFailure}
          onChange={v => setQueue(q => ({ ...q, autoRequeueOnFailure: v }))}
          label={dict.autoRequeue ?? 'Re-programmer automatiquement en cas d’échec (backoff exponentiel)'}
        />
        {queue.autoRequeueOnFailure && (
          <Labeled label={dict.autoRequeueMax ?? 'Nombre max de tentatives auto'}>
            <input
              type="number"
              min={1}
              max={6}
              value={queue.autoRequeueMaxAttempts ?? 3}
              onChange={e => setQueue(q => ({ ...q, autoRequeueMaxAttempts: Math.min(6, Math.max(1, Number(e.target.value) || 3)) }))}
              style={{ ...inputSm, maxWidth: 120 }}
            />
          </Labeled>
        )}
        <Toggle
          checked={!!queue.approvalRequired}
          onChange={v => setQueue(q => ({ ...q, approvalRequired: v }))}
          label={dict.approvalRequired ?? 'Validation requise (brouillon → en attente → programmé)'}
        />
      </Section>

      {note && (
        <div style={{ fontSize: 12.5, color: note.tone === 'ok' ? C.okText : '#c8283a' }}>{note.text}</div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => void save()}
          disabled={saving}
          style={{ ...miniBtnStyle('primary'), opacity: saving ? 0.6 : 1 }}
        >
          {saving ? <><Spinner dark /> {dict.saving ?? 'Enregistrement…'}</> : (dict.saveSettings ?? 'Enregistrer les réglages')}
        </button>
        <button onClick={() => void load()} disabled={saving} style={miniBtnStyle('secondary')}>
          {dict.reset ?? 'Réinitialiser'}
        </button>
      </div>
    </div>
  );
};

const Labeled = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: '0.03em' }}>{label}</span>
    {children}
  </div>
);

// --- per-network defaults editor -------------------------------------------

const NetworkDefaultsEditor = ({
  lang,
  dict,
  slug,
  def,
  charLimit,
  dayLabels,
  onChange,
}: {
  lang: 'fr' | 'ar' | 'en';
  dict: Record<string, string>;
  slug: string;
  def: NetworkDefaults;
  charLimit?: number;
  dayLabels: string[];
  onChange: (patch: Partial<NetworkDefaults>) => void;
}) => {
  const rtl = lang === 'ar';
  const [hashtagInput, setHashtagInput] = useState('');
  const hashtags = def.hashtags ?? [];
  const windows = def.windows ?? [];

  const addHashtag = () => {
    const raw = hashtagInput.trim();
    if (!raw) return;
    // Accept space/comma-separated; normalize leading #.
    const tags = raw
      .split(/[\s,]+/)
      .map(t => t.replace(/^#+/, ''))
      .filter(Boolean)
      .map(t => `#${t}`);
    const next = [...hashtags];
    for (const t of tags) if (!next.includes(t) && next.length < 15) next.push(t);
    onChange({ hashtags: next });
    setHashtagInput('');
  };

  const removeHashtag = (t: string) => onChange({ hashtags: hashtags.filter(h => h !== t) });

  const toggleWindow = (day: number, hour: number) => {
    const exists = windows.some(w => w.day === day && w.hour === hour);
    const next: PostingWindow[] = exists
      ? windows.filter(w => !(w.day === day && w.hour === hour))
      : [...windows, { day, hour }].slice(0, 12);
    onChange({ windows: next });
  };

  const suggestions = bestTimes(slug);

  return (
    <>
      {/* Hashtags */}
      <Labeled label={dict.defaultHashtags ?? 'Hashtags par défaut'}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {hashtags.map(t => (
            <span
              key={t}
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: C.accentSoft, color: C.accent, display: 'flex', alignItems: 'center', gap: 5 }}
            >
              {t}
              <button onClick={() => removeHashtag(t)} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>×</button>
            </span>
          ))}
          {hashtags.length === 0 && <span style={{ fontSize: 11, color: C.muted, fontStyle: 'italic' }}>{dict.noHashtags ?? 'Aucun'}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={hashtagInput}
            onChange={e => setHashtagInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addHashtag(); } }}
            placeholder={dict.addHashtag ?? 'Ajouter des hashtags (Entrée)'}
            style={{ ...inputSm, flex: 1 }}
          />
          <button onClick={addHashtag} style={miniBtnStyle('secondary')}>+</button>
        </div>
      </Labeled>

      {/* First comment */}
      <Labeled label={dict.firstComment ?? 'Premier commentaire'}>
        <textarea
          value={def.firstComment ?? ''}
          onChange={e => onChange({ firstComment: e.target.value })}
          placeholder={dict.firstCommentHint ?? 'Publié en commentaire juste après la publication (ex : lien en bio, hashtags additionnels)…'}
          rows={2}
          dir={rtl ? 'rtl' : undefined}
          maxLength={500}
          style={{ ...inputSm, resize: 'vertical', width: '100%' }}
        />
        {charLimit != null && (
          <span style={{ fontSize: 10, color: C.muted, textAlign: 'right' }}>
            {dict.charLimitLabel ?? 'Limite du réseau'} : {charLimit}
          </span>
        )}
      </Labeled>

      {/* Posting windows + best-time suggestions */}
      <Labeled label={dict.postingWindows ?? 'Créneaux de publication préférés'}>
        {suggestions.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontSize: 10.5, color: C.muted }}>{dict.suggestionLabel ?? 'Suggestions :'}</span>
            {suggestions.map(s => {
              const on = windows.some(w => w.day === s.day && w.hour === s.hour);
              return (
                <button
                  key={s.label}
                  onClick={() => toggleWindow(s.day, s.hour)}
                  style={{
                    fontSize: 10.5,
                    padding: '2px 8px',
                    borderRadius: 999,
                    cursor: 'pointer',
                    border: `1px solid ${on ? C.accent : C.border}`,
                    background: on ? C.accentSoft : 'transparent',
                    color: on ? C.accent : C.muted,
                  }}
                  title={dict.suggestionHint ?? 'Suggestion (heuristique, pas des statistiques de votre compte)'}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        )}
        {windows.length > 0 && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {windows
              .slice()
              .sort((a, b) => a.day - b.day || a.hour - b.hour)
              .map(w => (
                <span
                  key={`${w.day}:${w.hour}`}
                  style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 6, background: C.panel, border: `1px solid ${C.border}`, color: C.text, display: 'flex', gap: 5, alignItems: 'center' }}
                >
                  {dayLabels[w.day]} {String(w.hour).padStart(2, '0')}h
                  <button onClick={() => toggleWindow(w.day, w.hour)} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>×</button>
                </span>
              ))}
          </div>
        )}
      </Labeled>
    </>
  );
};

function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Algiers';
  } catch {
    return 'Africa/Algiers';
  }
}
