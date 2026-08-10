// social/composer.tsx — Rich composer.
// Base caption + multi-network selector, per-network text overrides,
// AI content generation, media attach (upload or CDZIM AI), scheduling,
// save draft, publish-now. Renders previews inline.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, C, miniBtnStyle, Spinner } from '../shoperp-shared';
import { CDZIM_DEFAULT, CDZIM_MODELS } from '../../../../../clickdz/cdzim';
import {
  composeContent,
  createOrUpdatePost,
  generateImage,
  getNetworkMeta,
  uploadMedia,
  type SocialMedia,
  type SocialPost,
} from './api';
import { MultiNetworkPreview } from './previews';

interface Props {
  lang: 'fr' | 'ar' | 'en';
  dict: Record<string, string>;
  connectedNetworks: string[];
  editPost?: SocialPost;
  initialScheduledAt?: number;
  onSaved: (post: SocialPost) => void;
  onCancel?: () => void;
}

const EMOJI_QUICK = ['😊', '🔥', '🎉', '💪', '🚀', '✨', '❤', '👍', '💡', '🌟'];

const TONES = ['professional', 'casual', 'playful', 'urgent', 'informative'];

const TONE_LABELS_FR: Record<string, string> = {
  professional: 'Professionnel',
  casual: 'Décontracté',
  playful: 'Ludique',
  urgent: 'Urgent',
  informative: 'Informatif',
};

export const ComposerView = ({
  lang,
  dict,
  connectedNetworks,
  editPost,
  initialScheduledAt,
  onSaved,
  onCancel,
}: Props) => {
  const rtl = lang === 'ar';

  // --- Post state ---
  const [baseText, setBaseText] = useState(editPost?.text ?? '');
  const [networkTexts, setNetworkTexts] = useState<Record<string, string>>({});
  const [selectedNetworks, setSelectedNetworks] = useState<string[]>(
    editPost?.targets.map(t => t.network) ?? []
  );
  const [media, setMedia] = useState<SocialMedia[]>(editPost?.media ?? []);
  const [scheduledAt, setScheduledAt] = useState<string>(
    editPost?.scheduledAt
      ? new Date(editPost.scheduledAt).toISOString().slice(0, 16)
      : initialScheduledAt
      ? new Date(initialScheduledAt).toISOString().slice(0, 16)
      : ''
  );

  // --- AI compose ---
  const [brief, setBrief] = useState('');
  const [tone, setTone] = useState('professional');
  const [hashtags, setHashtags] = useState(false);
  const [emojiToggle, setEmojiToggle] = useState(false);
  const [perNetwork, setPerNetwork] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genNote, setGenNote] = useState<string | null>(null);

  // --- CDZIM image ---
  const [imgPrompt, setImgPrompt] = useState('');
  const [imgModel, setImgModel] = useState(CDZIM_DEFAULT.modelId);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgNote, setImgNote] = useState<string | null>(null);
  // WS17: file-upload busy state (the upload route stores the file server-side
  // and returns a public URL — no more browser blob: URLs that Composio can't fetch).
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // --- Submit ---
  const [submitting, setSubmitting] = useState(false);
  const [submitNote, setSubmitNote] = useState<string | null>(null);
  const [submitTone, setSubmitTone] = useState<'ok' | 'err'>('ok');

  // --- Tab ---
  const [activeTab, setActiveTab] = useState<'compose' | 'preview' | 'media' | 'ai'>('compose');

  useEffect(() => {
    if (editPost) {
      const overrides: Record<string, string> = {};
      for (const t of editPost.targets) if (t.text) overrides[t.network] = t.text;
      setNetworkTexts(overrides);
    }
  }, [editPost]);

  const toggleNetwork = (slug: string) => {
    setSelectedNetworks(prev =>
      prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug]
    );
  };

  const setNetworkText = (slug: string, val: string) => {
    setNetworkTexts(prev => ({ ...prev, [slug]: val }));
  };

  // Validation: networks that require media but have none
  const mediaRequiredViolations = selectedNetworks.filter(s => {
    const m = getNetworkMeta(s);
    return m?.mediaRequired && media.length === 0;
  });

  // AI content generation
  const generate = useCallback(async () => {
    const b = brief.trim();
    if (!b || generating) return;
    setGenerating(true);
    setGenNote(null);
    try {
      const res = await composeContent({
        brief: b,
        networks: selectedNetworks,
        tone,
        perNetwork: perNetwork && selectedNetworks.length > 0,
        hashtags,
        emoji: emojiToggle,
      });
      if (res.ok && res.data) {
        setBaseText(res.data.content.trim());
        if (res.data.variants) {
          setNetworkTexts(
            Object.fromEntries(
              Object.entries(res.data.variants).map(([k, v]) => [k, (v as string).trim()])
            )
          );
        }
        setGenNote(dict.genOk ?? 'Brouillon généré — relisez avant de publier.');
      } else if (res.error === 'not_configured') {
        setGenNote(dict.aiNotConfigured ?? 'La génération IA n’est pas configurée sur ce serveur.');
      } else {
        setGenNote(dict.genFail ?? 'La génération a échoué. Réessayez.');
      }
    } catch {
      setGenNote(dict.genFail ?? 'La génération a échoué. Réessayez.');
    } finally {
      setGenerating(false);
    }
  }, [brief, generating, selectedNetworks, tone, perNetwork, hashtags, emojiToggle, dict]);

  // CDZIM AI image generation
  const genImage = useCallback(async () => {
    const p = imgPrompt.trim();
    if (!p || imgBusy) return;
    setImgBusy(true);
    setImgNote(null);
    try {
      const res = await generateImage(p, imgModel);
      if (res.ok && res.url) {
        setMedia(prev => [...prev, { kind: 'image', url: res.url!, alt: p }].slice(0, 4));
        setImgNote(dict.imgGenOk ?? 'Image générée et ajoutée.');
        setImgPrompt('');
      } else {
        setImgNote(dict.imgGenFail ?? 'La génération de l’image a échoué. Réessayez.');
      }
    } catch {
      setImgNote(dict.imgGenFail ?? 'La génération de l’image a échoué.');
    } finally {
      setImgBusy(false);
    }
  }, [imgPrompt, imgBusy, imgModel, dict]);

  // File upload — WS17: upload to the backend, which stores it via
  // CopilotStorage and returns a PUBLIC URL Composio can fetch. The old
  // URL.createObjectURL(blob:) approach silently failed at publish time because
  // Composio's servers can't reach browser-only URLs.
  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || media.length >= 4 || uploading) return;
    setUploading(true);
    setImgNote(null);
    try {
      const res = await uploadMedia(f);
      if (res.ok && res.url) {
        const kind: 'image' | 'video' = res.kind === 'video' ? 'video' : 'image';
        setMedia(prev => [...prev, { kind, url: res.url!, mime: res.mime, alt: f.name }].slice(0, 4));
      } else {
        setImgNote(dict.imgGenFail ?? 'Le téléversement a échoué. Réessayez.');
      }
    } catch {
      setImgNote(dict.imgGenFail ?? 'Le téléversement a échoué.');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }, [media, uploading, dict]);

  const removeMedia = (idx: number) => setMedia(prev => prev.filter((_, i) => i !== idx));

  const insertEmoji = (emoji: string) => setBaseText(prev => prev + emoji);

  const buildTargets = () =>
    selectedNetworks.map(network => ({
      network,
      text: networkTexts[network] ?? undefined,
    }));

  const handleSaveDraft = useCallback(async () => {
    const text = baseText.trim();
    if (!text || selectedNetworks.length === 0 || submitting) return;
    setSubmitting(true);
    setSubmitNote(null);
    try {
      const res = await createOrUpdatePost({
        id: editPost?.id,
        text,
        media,
        targets: buildTargets(),
      });
      if (res.ok && res.post) {
        setSubmitTone('ok');
        setSubmitNote(dict.draftSaved ?? 'Brouillon enregistré.');
        onSaved(res.post);
      } else {
        setSubmitTone('err');
        setSubmitNote(res.message ?? res.error ?? dict.submitFail ?? 'L’enregistrement a échoué. Réessayez.');
      }
    } catch {
      setSubmitTone('err');
      setSubmitNote(dict.submitFail ?? 'L’enregistrement a échoué.');
    } finally {
      setSubmitting(false);
    }
  }, [baseText, media, selectedNetworks, editPost, submitting, dict, onSaved, networkTexts]);

  const handleSchedule = useCallback(async () => {
    const text = baseText.trim();
    if (!text || selectedNetworks.length === 0 || !scheduledAt || submitting) return;
    const epoch = new Date(scheduledAt).getTime();
    if (isNaN(epoch) || epoch <= Date.now()) {
      setSubmitTone('err');
      setSubmitNote(dict.scheduleFuture ?? 'La date planifiée doit être dans le futur.');
      return;
    }
    setSubmitting(true);
    setSubmitNote(null);
    try {
      const res = await createOrUpdatePost({
        id: editPost?.id,
        text,
        media,
        targets: buildTargets(),
        scheduledAt: epoch,
      });
      if (res.ok && res.post) {
        setSubmitTone('ok');
        setSubmitNote(dict.scheduled ?? 'Publication planifiée.');
        onSaved(res.post);
      } else {
        setSubmitTone('err');
        setSubmitNote(res.message ?? res.error ?? dict.submitFail ?? 'La planification a échoué.');
      }
    } catch {
      setSubmitTone('err');
      setSubmitNote(dict.submitFail ?? 'La planification a échoué.');
    } finally {
      setSubmitting(false);
    }
  }, [baseText, media, selectedNetworks, scheduledAt, editPost, submitting, dict, onSaved, networkTexts]);

  const handlePublishNow = useCallback(async () => {
    const text = baseText.trim();
    if (!text || selectedNetworks.length === 0 || submitting) return;
    if (mediaRequiredViolations.length > 0) {
      setSubmitTone('err');
      setSubmitNote(`${dict.mediaRequiredFor ?? 'Média requis pour'} : ${mediaRequiredViolations.join(', ')}`);
      return;
    }
    setSubmitting(true);
    setSubmitNote(null);
    try {
      const res = await createOrUpdatePost({
        id: editPost?.id,
        text,
        media,
        targets: buildTargets(),
        publishNow: true,
      });
      if (res.ok && res.post) {
        setSubmitTone('ok');
        setSubmitNote(dict.published ?? 'Publié !');
        onSaved(res.post);
      } else {
        setSubmitTone('err');
        setSubmitNote(res.message ?? res.error ?? dict.submitFail ?? 'La publication a échoué.');
      }
    } catch {
      setSubmitTone('err');
      setSubmitNote(dict.submitFail ?? 'La publication a échoué.');
    } finally {
      setSubmitting(false);
    }
  }, [baseText, media, selectedNetworks, mediaRequiredViolations, editPost, submitting, dict, onSaved, networkTexts]);

  const tabStyle = (t: string) => ({
    fontSize: 12,
    fontWeight: activeTab === t ? 700 : 500,
    padding: '5px 12px',
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    background: activeTab === t ? C.accent : 'transparent',
    color: activeTab === t ? '#fff' : C.muted,
  });

  if (connectedNetworks.length === 0) {
    return (
      <Banner tone="warn">
        {dict.noNetworks ?? 'Connectez au moins un réseau dans l’onglet Connexions pour rédiger et publier.'}
      </Banner>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: `1px solid ${C.border}`, paddingBottom: 8 }}>
        {(['compose', 'ai', 'media', 'preview'] as const).map(t => (
          <button key={t} style={tabStyle(t)} onClick={() => setActiveTab(t)}>
            {dict[`tab_${t}`] ?? t}
          </button>
        ))}
      </div>

      {/* Network selector */}
      <div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: C.muted, marginBottom: 6, direction: rtl ? 'rtl' : undefined }}>
          {dict.publishTo ?? 'Publier sur :'}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {connectedNetworks.map(slug => {
            const meta = getNetworkMeta(slug);
            const on = selectedNetworks.includes(slug);
            return (
              <button
                key={slug}
                onClick={() => toggleNetwork(slug)}
                style={{
                  fontSize: 11.5,
                  fontWeight: 700,
                  padding: '5px 10px',
                  borderRadius: 999,
                  cursor: 'pointer',
                  border: `1px solid ${on ? C.accent : C.border}`,
                  background: on ? C.accentSoft : C.panel2,
                  color: C.text,
                }}
              >
                {meta?.icon ?? slug[0].toUpperCase()} {meta?.label ?? slug}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main tab content */}
      {activeTab === 'compose' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: C.muted, marginBottom: 4, direction: rtl ? 'rtl' : undefined }}>
              {dict.baseCaption ?? 'Légende de base'}
            </div>
            <textarea
              value={baseText}
              onChange={e => setBaseText(e.target.value)}
              placeholder={dict.captionPlaceholder ?? 'Écrivez votre légende ici…'}
              rows={5}
              dir={rtl ? 'rtl' : undefined}
              style={{
                width: '100%',
                resize: 'vertical',
                borderRadius: 10,
                border: `1px solid ${C.border}`,
                background: C.panel2,
                color: C.text,
                padding: '10px 12px',
                fontSize: 13,
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2, textAlign: 'right' }}>{baseText.length} caractères</div>
          </div>

          {/* Emoji quick-insert */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: C.muted }}>{dict.emoji ?? 'Emoji :'}</span>
            {EMOJI_QUICK.map(e => (
              <button
                key={e}
                onClick={() => insertEmoji(e)}
                style={{ fontSize: 16, background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px' }}
              >
                {e}
              </button>
            ))}
          </div>

          {/* Per-network overrides */}
          {selectedNetworks.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 12, color: C.muted, cursor: 'pointer' }}>
                {dict.perNetworkOverrides ?? 'Textes personnalisés par réseau (facultatif)'}
              </summary>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {selectedNetworks.map(slug => {
                  const meta = getNetworkMeta(slug);
                  const val = networkTexts[slug] ?? '';
                  return (
                    <div key={slug}>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: C.muted, marginBottom: 2 }}>
                        {meta?.label ?? slug} ({meta?.charLimit ?? '?'} caractères max)
                      </div>
                      <textarea
                        value={val}
                        onChange={e => setNetworkText(slug, e.target.value)}
                        placeholder={dict.overridePlaceholder ?? `Texte personnalisé pour ${meta?.label ?? slug} (laisser vide pour utiliser la légende de base)`}
                        rows={2}
                        dir={rtl ? 'rtl' : undefined}
                        style={{
                          width: '100%',
                          resize: 'vertical',
                          borderRadius: 8,
                          border: `1px solid ${C.border}`,
                          background: C.panel2,
                          color: C.text,
                          padding: '8px 10px',
                          fontSize: 12,
                          fontFamily: 'inherit',
                          boxSizing: 'border-box',
                        }}
                      />
                      <div style={{ fontSize: 10, color: (val || baseText).length > (meta?.charLimit ?? Infinity) ? '#c8283a' : C.muted, textAlign: 'right' }}>
                        {(val || baseText).length}/{meta?.charLimit ?? '?'}
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          {/* Scheduling */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: C.muted, direction: rtl ? 'rtl' : undefined }}>
              {dict.scheduleAt ?? 'Planifier pour :'}
            </span>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={e => setScheduledAt(e.target.value)}
              style={{
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.panel2,
                color: C.text,
                padding: '6px 10px',
                fontSize: 12,
                fontFamily: 'inherit',
              }}
            />
          </div>

          {mediaRequiredViolations.length > 0 && (
            <div style={{ fontSize: 12, color: '#c8283a' }}>
              {dict.mediaRequiredWarning ?? 'Média requis pour :'} {mediaRequiredViolations.map(s => getNetworkMeta(s)?.label ?? s).join(', ')}
            </div>
          )}

          {submitNote && (
            <div style={{ fontSize: 12, color: submitTone === 'ok' ? C.okText : '#c8283a' }}>
              {submitNote}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <button
              onClick={() => void handleSaveDraft()}
              disabled={submitting || !baseText.trim() || selectedNetworks.length === 0}
              style={{ ...miniBtnStyle('secondary'), opacity: (submitting || !baseText.trim() || selectedNetworks.length === 0) ? 0.5 : 1 }}
            >
              {submitting ? '…' : dict.saveDraft ?? 'Enregistrer le brouillon'}
            </button>
            <button
              onClick={() => void handleSchedule()}
              disabled={submitting || !baseText.trim() || selectedNetworks.length === 0 || !scheduledAt}
              style={{ ...miniBtnStyle('secondary'), opacity: (submitting || !baseText.trim() || selectedNetworks.length === 0 || !scheduledAt) ? 0.5 : 1 }}
            >
              {submitting ? '…' : dict.schedule ?? 'Planifier'}
            </button>
            <button
              onClick={() => void handlePublishNow()}
              disabled={submitting || !baseText.trim() || selectedNetworks.length === 0}
              style={{ ...miniBtnStyle('primary'), opacity: (submitting || !baseText.trim() || selectedNetworks.length === 0) ? 0.5 : 1 }}
            >
              {submitting ? <Spinner /> : dict.publishNow ?? 'Publier maintenant'}
            </button>
            {onCancel && (
              <button style={miniBtnStyle('secondary')} onClick={onCancel}>
                {dict.cancel ?? 'Annuler'}
              </button>
            )}
          </div>
        </div>
      )}

      {activeTab === 'ai' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, direction: rtl ? 'rtl' : undefined }}>
            {dict.aiCompose ?? 'Génération de contenu par IA'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              value={brief}
              onChange={e => setBrief(e.target.value)}
              placeholder={dict.briefPlaceholder ?? 'Décrivez la publication (ex. « Promo de 20 % sur les sneakers ce week-end »)…'}
              dir={rtl ? 'rtl' : undefined}
              style={{
                flex: 1,
                minWidth: 200,
                borderRadius: 10,
                border: `1px solid ${C.border}`,
                background: C.panel2,
                color: C.text,
                padding: '9px 12px',
                fontSize: 12.5,
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: C.muted }}>{dict.tone ?? 'Ton :'}</span>
            <select
              value={tone}
              onChange={e => setTone(e.target.value)}
              style={{ fontSize: 12, borderRadius: 8, border: `1px solid ${C.border}`, background: C.panel2, color: C.text, padding: '5px 8px' }}
            >
              {TONES.map(t => <option key={t} value={t}>{TONE_LABELS_FR[t] ?? t}</option>)}
            </select>
            <label style={{ fontSize: 11.5, color: C.muted, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={hashtags} onChange={e => setHashtags(e.target.checked)} />
              {dict.hashtags ?? 'Hashtags'}
            </label>
            <label style={{ fontSize: 11.5, color: C.muted, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={emojiToggle} onChange={e => setEmojiToggle(e.target.checked)} />
              {dict.emojiToggle ?? 'Emoji'}
            </label>
            <label style={{ fontSize: 11.5, color: C.muted, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={perNetwork} onChange={e => setPerNetwork(e.target.checked)} />
              {dict.perNetwork ?? 'Variantes par réseau'}
            </label>
          </div>
          <button
            onClick={() => void generate()}
            disabled={generating || !brief.trim()}
            style={{ ...miniBtnStyle('primary'), opacity: (generating || !brief.trim()) ? 0.5 : 1, alignSelf: 'flex-start' }}
          >
            {generating ? <><Spinner /> {dict.generating ?? 'Génération…'}</> : (dict.generateContent ?? 'Générer le contenu')}
          </button>
          {genNote && <div style={{ fontSize: 12, color: C.muted }}>{genNote}</div>}
        </div>
      )}

      {activeTab === 'media' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{dict.media ?? 'Média'}</div>

          {/* Current media */}
          {media.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {media.map((m, i) => (
                <div key={i} style={{ position: 'relative', width: 80, height: 80, borderRadius: 8, overflow: 'hidden', border: `1px solid ${C.border}` }}>
                  {m.kind === 'image' ? (
                    <img src={m.url} alt={m.alt ?? ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.panel2, fontSize: 24 }}>
                      {'▶'}
                    </div>
                  )}
                  <button
                    onClick={() => removeMedia(i)}
                    style={{ position: 'absolute', top: 2, right: 2, background: '#c8283acc', border: 'none', borderRadius: 999, color: '#fff', width: 18, height: 18, cursor: 'pointer', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              disabled={media.length >= 4}
              onClick={() => fileRef.current?.click()}
              style={{ ...miniBtnStyle('secondary'), opacity: media.length >= 4 ? 0.5 : 1 }}
            >
              {dict.uploadFile ?? 'Téléverser un fichier'}
            </button>
            <span style={{ fontSize: 11.5, color: C.muted }}>{dict.or ?? 'ou'}</span>
            <span style={{ fontSize: 11.5, color: C.muted }}>{dict.aiImageBelow ?? 'générer avec l’IA ci-dessous'} ({media.length}/4)</span>
          </div>
          <input ref={fileRef} type="file" accept="image/*,video/*" style={{ display: 'none' }} onChange={handleFileUpload} />

          {/* CDZIM AI image generation */}
          <div style={{ borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>{dict.aiImage ?? 'Générer une image avec CDZIM AI'}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                value={imgPrompt}
                onChange={e => setImgPrompt(e.target.value)}
                placeholder={dict.imgPromptPlaceholder ?? 'Décrivez l’image à générer…'}
                style={{
                  flex: 1,
                  minWidth: 180,
                  borderRadius: 8,
                  border: `1px solid ${C.border}`,
                  background: C.panel2,
                  color: C.text,
                  padding: '8px 10px',
                  fontSize: 12,
                  fontFamily: 'inherit',
                }}
              />
              <select
                value={imgModel}
                onChange={e => setImgModel(e.target.value)}
                style={{ fontSize: 11.5, borderRadius: 8, border: `1px solid ${C.border}`, background: C.panel2, color: C.text, padding: '5px 8px' }}
              >
                {CDZIM_MODELS.map(m => (
                  <option key={m.modelId} value={m.modelId}>{m.brandName}</option>
                ))}
              </select>
              <button
                onClick={() => void genImage()}
                disabled={imgBusy || !imgPrompt.trim() || media.length >= 4}
                style={{ ...miniBtnStyle('primary'), opacity: (imgBusy || !imgPrompt.trim() || media.length >= 4) ? 0.5 : 1 }}
              >
                {imgBusy ? <><Spinner /> {dict.generating ?? 'Génération…'}</> : (dict.generate ?? 'Générer')}
              </button>
            </div>
            {imgNote && <div style={{ fontSize: 11.5, color: C.muted }}>{imgNote}</div>}
          </div>
        </div>
      )}

      {activeTab === 'preview' && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>
            {dict.preview ?? 'Aperçu'}
          </div>
          {selectedNetworks.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 12 }}>{dict.selectNetworksFirst ?? 'Sélectionnez des réseaux ci-dessus pour voir les aperçus.'}</div>
          ) : (
            <MultiNetworkPreview
              networks={selectedNetworks}
              texts={networkTexts}
              baseText={baseText}
              media={media}
            />
          )}
        </div>
      )}
    </div>
  );
};
