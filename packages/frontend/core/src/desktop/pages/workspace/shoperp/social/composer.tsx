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
        setGenNote(dict.genOk ?? 'Draft generated — review before publishing.');
      } else if (res.error === 'not_configured') {
        setGenNote(dict.aiNotConfigured ?? 'AI generation is not configured on this server.');
      } else {
        setGenNote(dict.genFail ?? 'Generation failed. Try again.');
      }
    } catch {
      setGenNote(dict.genFail ?? 'Generation failed. Try again.');
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
        setImgNote(dict.imgGenOk ?? 'Image generated and added.');
        setImgPrompt('');
      } else {
        setImgNote(dict.imgGenFail ?? 'Image generation failed. Try again.');
      }
    } catch {
      setImgNote(dict.imgGenFail ?? 'Image generation failed.');
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
        setImgNote(dict.imgGenFail ?? 'Upload failed. Try again.');
      }
    } catch {
      setImgNote(dict.imgGenFail ?? 'Upload failed.');
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
        setSubmitNote(dict.draftSaved ?? 'Draft saved.');
        onSaved(res.post);
      } else {
        setSubmitTone('err');
        setSubmitNote(res.message ?? res.error ?? dict.submitFail ?? 'Save failed. Try again.');
      }
    } catch {
      setSubmitTone('err');
      setSubmitNote(dict.submitFail ?? 'Save failed.');
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
      setSubmitNote(dict.scheduleFuture ?? 'Scheduled time must be in the future.');
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
        setSubmitNote(dict.scheduled ?? 'Post scheduled.');
        onSaved(res.post);
      } else {
        setSubmitTone('err');
        setSubmitNote(res.message ?? res.error ?? dict.submitFail ?? 'Scheduling failed.');
      }
    } catch {
      setSubmitTone('err');
      setSubmitNote(dict.submitFail ?? 'Scheduling failed.');
    } finally {
      setSubmitting(false);
    }
  }, [baseText, media, selectedNetworks, scheduledAt, editPost, submitting, dict, onSaved, networkTexts]);

  const handlePublishNow = useCallback(async () => {
    const text = baseText.trim();
    if (!text || selectedNetworks.length === 0 || submitting) return;
    if (mediaRequiredViolations.length > 0) {
      setSubmitTone('err');
      setSubmitNote(`${dict.mediaRequiredFor ?? 'Media required for'}: ${mediaRequiredViolations.join(', ')}`);
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
        setSubmitNote(dict.published ?? 'Published!');
        onSaved(res.post);
      } else {
        setSubmitTone('err');
        setSubmitNote(res.message ?? res.error ?? dict.submitFail ?? 'Publish failed.');
      }
    } catch {
      setSubmitTone('err');
      setSubmitNote(dict.submitFail ?? 'Publish failed.');
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
        {dict.noNetworks ?? 'Connect at least one network in the Connections tab to compose and publish.'}
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
          {dict.publishTo ?? 'Publish to:'}
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
              {dict.baseCaption ?? 'Base caption'}
            </div>
            <textarea
              value={baseText}
              onChange={e => setBaseText(e.target.value)}
              placeholder={dict.captionPlaceholder ?? 'Write your caption here...'}
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
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2, textAlign: 'right' }}>{baseText.length} chars</div>
          </div>

          {/* Emoji quick-insert */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: C.muted }}>{dict.emoji ?? 'Emoji:'}</span>
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
                {dict.perNetworkOverrides ?? 'Per-network text overrides (optional)'}
              </summary>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {selectedNetworks.map(slug => {
                  const meta = getNetworkMeta(slug);
                  const val = networkTexts[slug] ?? '';
                  return (
                    <div key={slug}>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: C.muted, marginBottom: 2 }}>
                        {meta?.label ?? slug} ({meta?.charLimit ?? '?'} chars max)
                      </div>
                      <textarea
                        value={val}
                        onChange={e => setNetworkText(slug, e.target.value)}
                        placeholder={dict.overridePlaceholder ?? `Override for ${meta?.label ?? slug} (leave blank to use base caption)`}
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
              {dict.scheduleAt ?? 'Schedule at:'}
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
              {dict.mediaRequiredWarning ?? 'Media required for:'} {mediaRequiredViolations.map(s => getNetworkMeta(s)?.label ?? s).join(', ')}
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
              {submitting ? '...' : dict.saveDraft ?? 'Save draft'}
            </button>
            <button
              onClick={() => void handleSchedule()}
              disabled={submitting || !baseText.trim() || selectedNetworks.length === 0 || !scheduledAt}
              style={{ ...miniBtnStyle('secondary'), opacity: (submitting || !baseText.trim() || selectedNetworks.length === 0 || !scheduledAt) ? 0.5 : 1 }}
            >
              {submitting ? '...' : dict.schedule ?? 'Schedule'}
            </button>
            <button
              onClick={() => void handlePublishNow()}
              disabled={submitting || !baseText.trim() || selectedNetworks.length === 0}
              style={{ ...miniBtnStyle('primary'), opacity: (submitting || !baseText.trim() || selectedNetworks.length === 0) ? 0.5 : 1 }}
            >
              {submitting ? <Spinner /> : dict.publishNow ?? 'Publish now'}
            </button>
            {onCancel && (
              <button style={miniBtnStyle('secondary')} onClick={onCancel}>
                {dict.cancel ?? 'Cancel'}
              </button>
            )}
          </div>
        </div>
      )}

      {activeTab === 'ai' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, direction: rtl ? 'rtl' : undefined }}>
            {dict.aiCompose ?? 'AI content generation'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              value={brief}
              onChange={e => setBrief(e.target.value)}
              placeholder={dict.briefPlaceholder ?? 'Describe the post (e.g. "20% promo on sneakers this weekend")...'}
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
            <span style={{ fontSize: 11.5, color: C.muted }}>{dict.tone ?? 'Tone:'}</span>
            <select
              value={tone}
              onChange={e => setTone(e.target.value)}
              style={{ fontSize: 12, borderRadius: 8, border: `1px solid ${C.border}`, background: C.panel2, color: C.text, padding: '5px 8px' }}
            >
              {TONES.map(t => <option key={t} value={t}>{t}</option>)}
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
              {dict.perNetwork ?? 'Per-network variants'}
            </label>
          </div>
          <button
            onClick={() => void generate()}
            disabled={generating || !brief.trim()}
            style={{ ...miniBtnStyle('primary'), opacity: (generating || !brief.trim()) ? 0.5 : 1, alignSelf: 'flex-start' }}
          >
            {generating ? <><Spinner /> {dict.generating ?? 'Generating...'}</> : (dict.generateContent ?? 'Generate content')}
          </button>
          {genNote && <div style={{ fontSize: 12, color: C.muted }}>{genNote}</div>}
        </div>
      )}

      {activeTab === 'media' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{dict.media ?? 'Media'}</div>

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
              {dict.uploadFile ?? 'Upload file'}
            </button>
            <span style={{ fontSize: 11.5, color: C.muted }}>{dict.or ?? 'or'}</span>
            <span style={{ fontSize: 11.5, color: C.muted }}>{dict.aiImageBelow ?? 'generate with AI below'} ({media.length}/4)</span>
          </div>
          <input ref={fileRef} type="file" accept="image/*,video/*" style={{ display: 'none' }} onChange={handleFileUpload} />

          {/* CDZIM AI image generation */}
          <div style={{ borderRadius: 10, border: `1px solid ${C.border}`, background: C.panel, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>{dict.aiImage ?? 'Generate image with CDZIM AI'}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                value={imgPrompt}
                onChange={e => setImgPrompt(e.target.value)}
                placeholder={dict.imgPromptPlaceholder ?? 'Describe the image to generate...'}
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
                {imgBusy ? <><Spinner /> {dict.generating ?? 'Generating...'}</> : (dict.generate ?? 'Generate')}
              </button>
            </div>
            {imgNote && <div style={{ fontSize: 11.5, color: C.muted }}>{imgNote}</div>}
          </div>
        </div>
      )}

      {activeTab === 'preview' && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>
            {dict.preview ?? 'Preview'}
          </div>
          {selectedNetworks.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 12 }}>{dict.selectNetworksFirst ?? 'Select networks above to see previews.'}</div>
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
