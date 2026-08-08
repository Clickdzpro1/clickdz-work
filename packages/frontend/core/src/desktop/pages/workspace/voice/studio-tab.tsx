// ---------------------------------------------------------------------------
// Voice Studio — "Studio" tab (ElevenLabs-style multi-segment generation).
//
// The flagship text->speech surface. Everything is driven by the live
// GET /api/voice/capabilities payload (BRIDGE-BE C3): provider cards, a model
// picker (OpenAI gpt-4o-mini-tts default, tts-1/tts-1-hd fallback; Deepgram
// Aura-2 is single-model), a full voice picker, a format picker, per-segment
// speed (where supported) and an EMOTION / INSTRUCTIONS free-text field with
// one-tap presets (only enabled when the active provider+model supports it).
//
// MULTI-SEGMENT EDITOR: N segment cards, each = text + voice + instructions +
// speed. "Generate" on a card POSTs /api/voice/tts and plays the streamed
// audio inline; each segment can be downloaded on its own, and "Download all"
// concatenates the generated segment blobs into a single file. A localStorage
// history of the last 10 single generations offers one-click Regenerate.
//
// POST body sent per segment (exact BRIDGE-BE shape):
//   { text, provider, voice, model?, speed?, instructions?, format? }
// All inline-styled, dark palette `C`, boot-safe inline-SVG icons only.
// ---------------------------------------------------------------------------
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';

import {
  C,
  concatBlobs,
  contentTypeForFormat,
  downloadBlob,
  EMOTION_PRESETS,
  extForFormat,
  formatModelLabel,
  formatVoiceLabel,
  type GenerationHistoryItem,
  HISTORY_LIMIT,
  readHistory,
  synthesizeSpeech,
  TTS_MAX_CHARS,
  TTS_MAX_INSTRUCTIONS,
  type TtsProviderCap,
  type TtsProviderId,
  type VoiceCapabilities,
  writeHistory,
} from './voice-shared';

interface StudioTabProps {
  caps: VoiceCapabilities;
}

// One editable segment in the multi-segment timeline. Each carries its own
// text/voice/instructions/speed and, once generated, its resulting audio.
interface Segment {
  id: string;
  text: string;
  voice: string;
  instructions: string;
  speed: number;
  // Result state:
  status: 'idle' | 'generating' | 'done' | 'error';
  audioUrl: string | null;
  audioBlob: Blob | null;
  error: string | null;
}

let SEG_SEQ = 0;
const newSegmentId = () =>
  `seg-${Date.now().toString(36)}-${(SEG_SEQ++).toString(36)}`;

const makeSegment = (voice: string): Segment => ({
  id: newSegmentId(),
  text: '',
  voice,
  instructions: '',
  speed: 1,
  status: 'idle',
  audioUrl: null,
  audioBlob: null,
  error: null,
});

/** One context-aware starter chip { label, prompt } (mirrors the backend). */
interface VoiceStarter {
  label: string;
  prompt: string;
}

/**
 * Static Voice Studio starter chips — the fail-soft fallback. The context-aware
 * endpoint (POST /api/v1/ai/prompt-suggestions, studio:'voice') upgrades these
 * when it can; on any failure/slow response these render unchanged. Each chip's
 * `prompt` is a ready-to-speak French line dropped into the first empty
 * segment, so the merchant can generate immediately.
 */
const VOICE_STATIC_STARTERS: VoiceStarter[] = [
  {
    label: 'Spot radio 20s',
    prompt:
      'Profitez de notre offre spéciale cette semaine seulement — des prix imbattables et une livraison rapide partout. Passez commande dès maintenant !',
  },
  {
    label: 'Voix off produit',
    prompt:
      'Découvrez notre nouveau produit, conçu pour vous simplifier la vie. Qualité, confort et style, le tout à un prix accessible.',
  },
  {
    label: 'Message d’accueil',
    prompt:
      'Bonjour et bienvenue ! Merci de nous contacter. Un de nos conseillers vous répondra dans les plus brefs délais.',
  },
  {
    label: 'Annonce livraison',
    prompt:
      'Bonne nouvelle ! Votre commande est en route et sera livrée très bientôt. Merci de votre confiance.',
  },
];

export const StudioTab = ({ caps }: StudioTabProps) => {
  const providers = caps.tts.providers;
  const formats = useMemo(
    () => caps.tts.formats ?? ['mp3'],
    [caps.tts.formats]
  );
  const defaultFormat = caps.tts.defaultFormat ?? 'mp3';

  // ---- global controls ----
  const [provider, setProvider] = useState<TtsProviderId>(
    caps.tts.defaultProvider
  );
  const [format, setFormat] = useState<string>(defaultFormat);

  const activeProvider = useMemo(
    () => providers.find(p => p.id === provider),
    [providers, provider]
  );

  const providerModels = activeProvider?.models ?? [];
  const [model, setModel] = useState<string>(
    activeProvider?.defaultModel ?? ''
  );

  // ---- segments ----
  const [segments, setSegments] = useState<Segment[]>(() => [
    makeSegment(
      providers.find(p => p.id === caps.tts.defaultProvider)?.defaultVoice ||
        ''
    ),
  ]);

  // ---- concat / download-all state ----
  const [concatUrl, setConcatUrl] = useState<string | null>(null);
  const [concatBlob, setConcatBlob] = useState<Blob | null>(null);

  // ---- history ----
  const [history, setHistory] = useState<GenerationHistoryItem[]>([]);

  // ---- context-aware starter chips ----
  // Seeded with the static fallback so the row is never empty; upgraded in
  // place once POST /api/v1/ai/prompt-suggestions answers. Fail-soft: a
  // failed/slow fetch leaves the static chips untouched (cosmetic).
  const [starters, setStarters] = useState<VoiceStarter[]>(
    VOICE_STATIC_STARTERS
  );

  // Track every object URL we mint so we can revoke on unmount.
  const urlsRef = useRef<Set<string>>(new Set());
  const trackUrl = useCallback((url: string | null) => {
    if (url) urlsRef.current.add(url);
  }, []);

  useEffect(() => {
    setHistory(readHistory());
  }, []);

  // Fetch context-aware starter chips once on mount. Fail-soft: any error/slow
  // response keeps the static fallback. Aborts cleanly on unmount.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(cdzApiUrl('/api/v1/ai/prompt-suggestions'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ context: { studio: 'voice' } }),
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { suggestions?: unknown };
        const list = Array.isArray(data?.suggestions) ? data.suggestions : [];
        const cleaned: VoiceStarter[] = [];
        for (const s of list) {
          if (!s || typeof s !== 'object') continue;
          const label = String((s as { label?: unknown }).label ?? '').trim();
          const prompt = String((s as { prompt?: unknown }).prompt ?? '').trim();
          if (label && prompt) cleaned.push({ label, prompt });
          if (cleaned.length >= 4) break;
        }
        if (cleaned.length) setStarters(cleaned);
      } catch {
        // Cosmetic — keep the static fallback on any failure/abort.
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      urls.forEach(u => {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* ignore */
        }
      });
    };
  }, []);

  // Whether the active provider+selected-model can steer on instructions.
  const instructionsEnabled = useMemo(() => {
    if (!activeProvider?.supportsInstructions) return false;
    const instrModels = activeProvider.instructionModels;
    // If the backend lists which models steer, honour it; else any model does.
    if (Array.isArray(instrModels) && instrModels.length) {
      return !!model && instrModels.includes(model);
    }
    return true;
  }, [activeProvider, model]);

  const speedEnabled = !!activeProvider?.supportsSpeed;

  // Keep model valid when the provider changes.
  useEffect(() => {
    if (!activeProvider) return;
    const models = activeProvider.models ?? [];
    if (!models.length) {
      if (model !== '') setModel('');
      return;
    }
    if (!models.includes(model)) {
      setModel(activeProvider.defaultModel || models[0] || '');
    }
  }, [activeProvider, model]);

  // Keep every segment's voice valid for the active provider.
  useEffect(() => {
    if (!activeProvider) return;
    const valid = new Set(activeProvider.voices);
    const fallback =
      activeProvider.defaultVoice || activeProvider.voices[0] || '';
    setSegments(prev =>
      prev.map(s =>
        valid.has(s.voice) ? s : { ...s, voice: fallback }
      )
    );
  }, [activeProvider]);

  // Keep the format valid for the advertised list.
  useEffect(() => {
    if (!formats.includes(format)) setFormat(defaultFormat);
  }, [formats, format, defaultFormat]);

  const selectProvider = useCallback((cap: TtsProviderCap) => {
    if (!cap.available) return;
    setProvider(cap.id);
  }, []);

  // ---- segment mutators ----
  const patchSegment = useCallback(
    (id: string, patch: Partial<Segment>) => {
      setSegments(prev =>
        prev.map(s => (s.id === id ? { ...s, ...patch } : s))
      );
    },
    []
  );

  const addSegment = useCallback(() => {
    const voice =
      activeProvider?.defaultVoice || activeProvider?.voices[0] || '';
    setSegments(prev => [...prev, makeSegment(voice)]);
  }, [activeProvider]);

  // Drop a starter chip's ready-to-speak line into the FIRST empty segment
  // (or append a fresh one if every segment already has text). Never generates
  // on its own — the merchant reviews the text, then hits Generate.
  const useStarter = useCallback(
    (prompt: string) => {
      const voice =
        activeProvider?.defaultVoice || activeProvider?.voices[0] || '';
      setSegments(prev => {
        const emptyIdx = prev.findIndex(s => !s.text.trim());
        if (emptyIdx >= 0) {
          const next = [...prev];
          next[emptyIdx] = { ...next[emptyIdx], text: prompt };
          return next;
        }
        return [...prev, { ...makeSegment(voice), text: prompt }];
      });
    },
    [activeProvider]
  );

  const removeSegment = useCallback((id: string) => {
    setSegments(prev =>
      prev.length <= 1 ? prev : prev.filter(s => s.id !== id)
    );
  }, []);

  const duplicateSegment = useCallback((id: string) => {
    setSegments(prev => {
      const idx = prev.findIndex(s => s.id === id);
      if (idx < 0) return prev;
      const src = prev[idx];
      const copy: Segment = {
        ...src,
        id: newSegmentId(),
        status: 'idle',
        audioUrl: null,
        audioBlob: null,
        error: null,
      };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  }, []);

  const moveSegment = useCallback((id: string, dir: -1 | 1) => {
    setSegments(prev => {
      const idx = prev.findIndex(s => s.id === id);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  // Push a single generation onto history (localStorage-backed).
  const pushHistory = useCallback(
    (seg: Segment) => {
      const item: GenerationHistoryItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: seg.text.trim().slice(0, 400),
        provider,
        voice: seg.voice,
        speed: speedEnabled ? seg.speed : undefined,
        model: providerModels.length ? model : null,
        instructions: instructionsEnabled ? seg.instructions.trim() : '',
        format,
        createdAt: Date.now(),
      };
      setHistory(prev => {
        const next = [item, ...prev].slice(0, HISTORY_LIMIT);
        writeHistory(next);
        return next;
      });
    },
    [
      provider,
      speedEnabled,
      providerModels.length,
      model,
      instructionsEnabled,
      format,
    ]
  );

  // Generate ONE segment. Sends the exact BRIDGE-BE body and plays the streamed
  // audio inline on success.
  const generateSegment = useCallback(
    async (id: string) => {
      const seg = segments.find(s => s.id === id);
      if (!seg) return;
      const trimmed = seg.text.trim();
      if (!trimmed || seg.status === 'generating') return;
      if (!activeProvider?.available) {
        patchSegment(id, {
          status: 'error',
          error: `The ${activeProvider?.label || provider} provider is not configured.`,
        });
        return;
      }
      patchSegment(id, { status: 'generating', error: null });
      const outcome = await synthesizeSpeech({
        text: trimmed.slice(0, TTS_MAX_CHARS),
        provider,
        voice: seg.voice,
        model: providerModels.length ? model : undefined,
        speed: speedEnabled ? seg.speed : undefined,
        instructions: instructionsEnabled ? seg.instructions : undefined,
        format,
      });
      if (!outcome.ok) {
        patchSegment(id, {
          status: 'error',
          error:
            outcome.reason === 'unavailable'
              ? `The ${activeProvider?.label || provider} provider is not configured.`
              : `Generation failed with ${activeProvider?.label || provider}. Please try again.`,
        });
        return;
      }
      trackUrl(outcome.url);
      patchSegment(id, {
        status: 'done',
        audioUrl: outcome.url,
        audioBlob: outcome.blob,
        error: null,
      });
      pushHistory({ ...seg, text: trimmed });
    },
    [
      segments,
      activeProvider,
      provider,
      providerModels.length,
      model,
      speedEnabled,
      instructionsEnabled,
      format,
      patchSegment,
      pushHistory,
      trackUrl,
    ]
  );

  // Generate EVERY non-empty segment sequentially (keeps request order + avoids
  // hammering the paid API in parallel).
  const [generatingAll, setGeneratingAll] = useState(false);
  const generateAll = useCallback(async () => {
    if (generatingAll) return;
    setGeneratingAll(true);
    // Snapshot the ids so newly-added segments mid-run aren't swept in.
    const ids = segments.filter(s => s.text.trim()).map(s => s.id);
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      await generateSegment(id);
    }
    setGeneratingAll(false);
  }, [generatingAll, segments, generateSegment]);

  // Concatenate all generated segment blobs (in card order) into one file.
  const buildConcat = useCallback(() => {
    const done = segments.filter(s => s.status === 'done' && s.audioBlob);
    if (!done.length) return;
    const blob = concatBlobs(
      done.map(s => s.audioBlob as Blob),
      contentTypeForFormat(format)
    );
    setConcatBlob(blob);
    setConcatUrl(prevUrl => {
      if (prevUrl) {
        try {
          URL.revokeObjectURL(prevUrl);
        } catch {
          /* ignore */
        }
      }
      const url = URL.createObjectURL(blob);
      trackUrl(url);
      return url;
    });
  }, [segments, format, trackUrl]);

  const downloadAll = useCallback(() => {
    const done = segments.filter(s => s.status === 'done' && s.audioBlob);
    if (!done.length) return;
    const blob = concatBlobs(
      done.map(s => s.audioBlob as Blob),
      contentTypeForFormat(format)
    );
    downloadBlob(`clickdz-voice-all.${extForFormat(format)}`, blob);
  }, [segments, format]);

  // Regenerate from a history row: restore its params into a NEW segment at the
  // top and immediately generate it.
  const regenerate = useCallback(
    (item: GenerationHistoryItem) => {
      const cap = providers.find(p => p.id === item.provider);
      if (!cap || !cap.available) return;
      // Switch global provider/model/format to match the history entry.
      setProvider(item.provider);
      if (typeof item.model === 'string' && item.model) setModel(item.model);
      if (typeof item.format === 'string' && item.format) setFormat(item.format);
      const seg: Segment = {
        ...makeSegment(item.voice),
        text: item.text,
        voice: item.voice,
        instructions: item.instructions || '',
        speed: typeof item.speed === 'number' ? item.speed : 1,
      };
      setSegments(prev => [seg, ...prev]);
      // Generate after state settles (the effects re-validate voice/model).
      setTimeout(() => void generateSegment(seg.id), 60);
    },
    [providers, generateSegment]
  );

  const clearHistory = useCallback(() => {
    setHistory([]);
    writeHistory([]);
  }, []);

  const anyProviderAvailable = providers.some(p => p.available);
  const doneCount = segments.filter(
    s => s.status === 'done' && s.audioBlob
  ).length;
  const anyText = segments.some(s => s.text.trim());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <style>
        {`@keyframes cdz-voice-genspin{to{transform:rotate(360deg)}}
          @keyframes cdz-voice-segpulse{0%{opacity:.5}50%{opacity:1}100%{opacity:.5}}
          @media (prefers-reduced-motion: reduce){
            .cdz-seg-pulse{animation:none!important}
          }`}
      </style>

      {!anyProviderAvailable ? (
        <div style={bannerWarn}>
          <strong>No speech provider is configured.</strong>
          <br />
          Ask the owner to set <code style={codeStyle}>DEEPGRAM_API_KEY</code>{' '}
          and/or an OpenAI key on the server, then reload.
        </div>
      ) : null}

      {/* ---- Global engine controls ---- */}
      <section style={panelCard}>
        <div style={sectionLabel}>Engine</div>

        {/* Provider cards */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {providers.map(cap => {
            const selected = cap.id === provider && cap.available;
            return (
              <button
                key={cap.id}
                type="button"
                onClick={() => selectProvider(cap)}
                disabled={!cap.available}
                title={
                  cap.available
                    ? `Use ${cap.label}`
                    : `${cap.label} is unavailable — its API key is not configured on the server.`
                }
                style={{
                  appearance: 'none',
                  textAlign: 'left',
                  flex: '1 1 200px',
                  padding: '13px 15px',
                  borderRadius: 11,
                  border: `1.5px solid ${selected ? C.accent : C.border}`,
                  background: selected ? C.accentSoft : C.panel2,
                  color: C.text,
                  cursor: cap.available ? 'pointer' : 'not-allowed',
                  opacity: cap.available ? 1 : 0.55,
                  transition: 'border-color 150ms ease, background 150ms ease',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 4,
                  }}
                >
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>
                    {cap.label}
                  </span>
                  {!cap.available ? (
                    <span style={pill}>unavailable</span>
                  ) : selected ? (
                    <span style={{ fontSize: 12, color: C.accent }}>✓</span>
                  ) : null}
                </div>
                <div style={{ fontSize: 11.5, color: C.muted }}>
                  {cap.voices.length} voice
                  {cap.voices.length === 1 ? '' : 's'}
                  {cap.supportsInstructions ? ' · steerable' : ''}
                  {cap.supportsSpeed ? ' · speed' : ''}
                </div>
              </button>
            );
          })}
        </div>

        {/* Model + format row */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            marginTop: 4,
          }}
        >
          {providerModels.length ? (
            <label style={fieldCol}>
              <span style={fieldLabel}>Model</span>
              <select
                value={model}
                disabled={!activeProvider?.available}
                onChange={e => setModel(e.target.value)}
                style={selectStyle(!!activeProvider?.available)}
              >
                {providerModels.map(m => (
                  <option key={m} value={m}>
                    {formatModelLabel(m)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label style={fieldCol}>
              <span style={fieldLabel}>Model</span>
              <div style={staticField}>
                {activeProvider?.label || '—'} (single model)
              </div>
            </label>
          )}

          <label style={fieldCol}>
            <span style={fieldLabel}>Output format</span>
            <select
              value={format}
              onChange={e => setFormat(e.target.value)}
              style={selectStyle(true)}
            >
              {formats.map(f => (
                <option key={f} value={f}>
                  {f.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        </div>

        {activeProvider && !instructionsEnabled ? (
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
            {activeProvider.supportsInstructions
              ? 'Emotion / instructions steering is available on the steerable model — switch model to enable it.'
              : `${activeProvider.label} uses preset voices only — emotion/instructions steering isn't available for this provider.`}
          </div>
        ) : null}
      </section>

      {/* ---- Smart starters (context-aware) ---- */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={sectionLabel}>✦ Idées pour démarrer</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {starters.map(chip => (
            <button
              key={chip.label}
              type="button"
              onClick={() => useStarter(chip.prompt)}
              title={chip.prompt}
              style={starterChip}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </section>

      {/* ---- Segment timeline ---- */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
            Segments
          </span>
          <span style={{ fontSize: 11.5, color: C.muted }}>
            {segments.length} · each with its own voice, emotion &amp; speed
          </span>
        </div>

        {segments.map((seg, idx) => (
          <SegmentCard
            key={seg.id}
            index={idx}
            total={segments.length}
            seg={seg}
            provider={activeProvider}
            instructionsEnabled={instructionsEnabled}
            speedEnabled={speedEnabled}
            format={format}
            onPatch={patchSegment}
            onGenerate={generateSegment}
            onRemove={removeSegment}
            onDuplicate={duplicateSegment}
            onMove={moveSegment}
          />
        ))}

        <button type="button" onClick={addSegment} style={addSegmentBtn}>
          <PlusGlyph /> Add segment
        </button>
      </section>

      {/* ---- Batch actions ---- */}
      <section style={panelCard}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <button
            type="button"
            onClick={() => void generateAll()}
            disabled={
              !activeProvider?.available || !anyText || generatingAll
            }
            style={primaryBtn(
              !!activeProvider?.available && anyText && !generatingAll
            )}
          >
            {generatingAll ? <GenSpinner /> : <BoltGlyph />}
            {generatingAll ? 'Generating all…' : 'Generate all segments'}
          </button>

          <div style={{ flex: 1 }} />

          <button
            type="button"
            onClick={buildConcat}
            disabled={doneCount < 1}
            title="Stitch the generated segments into one clip you can preview"
            style={secondaryBtn(doneCount >= 1)}
          >
            Preview combined ({doneCount})
          </button>
          <button
            type="button"
            onClick={downloadAll}
            disabled={doneCount < 1}
            title="Download all generated segments as one file"
            style={secondaryBtn(doneCount >= 1)}
          >
            Download all
          </button>
        </div>

        {concatUrl ? (
          <div style={playerRow}>
            <audio
              key={concatUrl}
              src={concatUrl}
              controls
              style={{ flex: '1 1 260px', height: 40 }}
            />
            <button
              type="button"
              onClick={() =>
                concatBlob &&
                downloadBlob(
                  `clickdz-voice-all.${extForFormat(format)}`,
                  concatBlob
                )
              }
              style={ghostBtn}
            >
              Download .{extForFormat(format)}
            </button>
          </div>
        ) : null}
      </section>

      {/* ---- Cloning notice (honest, from capabilities) ---- */}
      <CloningNotice caps={caps} />

      {/* ---- History ---- */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Recent generations
          </span>
          <div style={{ flex: 1 }} />
          {history.length ? (
            <button type="button" onClick={clearHistory} style={linkBtn}>
              Clear
            </button>
          ) : null}
        </div>

        {!history.length ? (
          <div style={emptyBox}>
            Your last {HISTORY_LIMIT} generations will appear here.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.map(item => {
              const cap = providers.find(p => p.id === item.provider);
              return (
                <div key={item.id} style={historyRow}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={historyText}>{item.text}</div>
                    <div
                      style={{
                        fontSize: 11,
                        color: C.muted,
                        marginTop: 2,
                      }}
                    >
                      {cap?.label || item.provider} ·{' '}
                      {formatVoiceLabel(item.voice)}
                      {item.model ? ` · ${formatModelLabel(item.model)}` : ''}
                      {typeof item.speed === 'number'
                        ? ` · ${item.speed.toFixed(2)}×`
                        : ''}
                      {item.instructions
                        ? ` · “${item.instructions.slice(0, 40)}${
                            item.instructions.length > 40 ? '…' : ''
                          }”`
                        : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => regenerate(item)}
                    disabled={!cap?.available}
                    title={
                      cap?.available
                        ? 'Regenerate with these settings'
                        : `${cap?.label || item.provider} is unavailable`
                    }
                    style={{
                      ...ghostBtn,
                      color: cap?.available ? C.accent : C.muted,
                      cursor: cap?.available ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Regenerate
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

// ===========================================================================
// Segment card
// ===========================================================================

interface SegmentCardProps {
  index: number;
  total: number;
  seg: Segment;
  provider: TtsProviderCap | undefined;
  instructionsEnabled: boolean;
  speedEnabled: boolean;
  format: string;
  onPatch: (id: string, patch: Partial<Segment>) => void;
  onGenerate: (id: string) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}

const SegmentCard = ({
  index,
  total,
  seg,
  provider,
  instructionsEnabled,
  speedEnabled,
  format,
  onPatch,
  onGenerate,
  onRemove,
  onDuplicate,
  onMove,
}: SegmentCardProps) => {
  const overLimit = seg.text.length > TTS_MAX_CHARS;
  const canGenerate =
    !!provider?.available &&
    seg.text.trim().length > 0 &&
    !overLimit &&
    seg.status !== 'generating';

  return (
    <div
      style={{
        borderRadius: 13,
        border: `1px solid ${
          seg.status === 'done' ? C.accent : C.border
        }`,
        background: C.panel,
        padding: 15,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        transition: 'border-color 200ms ease',
      }}
    >
      {/* header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={segBadge}>#{index + 1}</span>
        <div style={{ flex: 1 }} />
        <IconBtn
          title="Move up"
          disabled={index === 0}
          onClick={() => onMove(seg.id, -1)}
        >
          <ArrowGlyph dir="up" />
        </IconBtn>
        <IconBtn
          title="Move down"
          disabled={index === total - 1}
          onClick={() => onMove(seg.id, 1)}
        >
          <ArrowGlyph dir="down" />
        </IconBtn>
        <IconBtn title="Duplicate" onClick={() => onDuplicate(seg.id)}>
          <CopyGlyph />
        </IconBtn>
        <IconBtn
          title="Remove segment"
          disabled={total <= 1}
          onClick={() => onRemove(seg.id)}
        >
          <TrashGlyph />
        </IconBtn>
      </div>

      {/* text */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <textarea
          value={seg.text}
          onChange={e => onPatch(seg.id, { text: e.target.value })}
          placeholder="Type the text this segment should speak…"
          rows={3}
          style={{
            width: '100%',
            resize: 'vertical',
            boxSizing: 'border-box',
            padding: '11px 13px',
            borderRadius: 9,
            border: `1px solid ${overLimit ? C.errBorder : C.border}`,
            background: C.panel2,
            color: C.text,
            fontSize: 14,
            lineHeight: 1.55,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            fontSize: 11,
            color: overLimit ? C.errText : C.muted,
          }}
        >
          {seg.text.length} / {TTS_MAX_CHARS}
        </div>
      </div>

      {/* voice + speed */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 14,
          alignItems: 'flex-end',
        }}
      >
        <label style={{ ...fieldCol, flex: '1 1 220px' }}>
          <span style={fieldLabel}>Voice</span>
          <select
            value={seg.voice}
            disabled={!provider?.available}
            onChange={e => onPatch(seg.id, { voice: e.target.value })}
            style={selectStyle(!!provider?.available)}
          >
            {(provider?.voices ?? []).map(v => (
              <option key={v} value={v}>
                {formatVoiceLabel(v)}
              </option>
            ))}
          </select>
        </label>

        {speedEnabled ? (
          <label style={{ ...fieldCol, flex: '1 1 200px' }}>
            <span style={fieldLabel}>Speed · {seg.speed.toFixed(2)}×</span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={seg.speed}
              onChange={e =>
                onPatch(seg.id, { speed: Number(e.target.value) })
              }
              style={{
                width: '100%',
                accentColor: 'var(--affine-primary-color, #1e96eb)',
              }}
            />
          </label>
        ) : null}
      </div>

      {/* instructions / emotion */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={fieldLabel}>
          Emotion / instructions{' '}
          {!instructionsEnabled ? (
            <span style={{ color: C.muted, fontWeight: 400 }}>
              (not available for this engine)
            </span>
          ) : null}
        </span>
        <input
          type="text"
          value={seg.instructions}
          disabled={!instructionsEnabled}
          maxLength={TTS_MAX_INSTRUCTIONS}
          onChange={e => onPatch(seg.id, { instructions: e.target.value })}
          placeholder='e.g. "warm, tired, whispering" or "excited sports announcer"'
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '9px 12px',
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            background: instructionsEnabled ? C.panel2 : C.panel,
            color: C.text,
            fontSize: 13,
            fontFamily: 'inherit',
            outline: 'none',
            opacity: instructionsEnabled ? 1 : 0.5,
            cursor: instructionsEnabled ? 'text' : 'not-allowed',
          }}
        />
        {instructionsEnabled ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {EMOTION_PRESETS.map(p => (
              <button
                key={p.label}
                type="button"
                onClick={() =>
                  onPatch(seg.id, { instructions: p.instructions })
                }
                style={presetChip}
              >
                {p.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* generate + result */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <button
          type="button"
          disabled={!canGenerate}
          onClick={() => onGenerate(seg.id)}
          style={primaryBtn(canGenerate)}
        >
          {seg.status === 'generating' ? <GenSpinner /> : <PlayGlyph />}
          {seg.status === 'generating'
            ? 'Generating…'
            : seg.status === 'done'
              ? 'Regenerate'
              : 'Generate'}
        </button>

        {seg.status === 'done' && seg.audioUrl ? (
          <>
            <audio
              key={seg.audioUrl}
              src={seg.audioUrl}
              controls
              autoPlay
              style={{ flex: '1 1 220px', height: 38 }}
            />
            <button
              type="button"
              onClick={() =>
                seg.audioBlob &&
                downloadBlob(
                  `clickdz-segment-${index + 1}.${extForFormat(format)}`,
                  seg.audioBlob
                )
              }
              style={ghostBtn}
            >
              Download
            </button>
          </>
        ) : null}
      </div>

      {seg.status === 'error' && seg.error ? (
        <div style={bannerErr}>{seg.error}</div>
      ) : null}
    </div>
  );
};

// ===========================================================================
// Cloning notice — tasteful, honest, driven by capabilities.cloning
// ===========================================================================

const CloningNotice = ({ caps }: { caps: VoiceCapabilities }) => {
  const cloning =
    caps.cloning ?? caps.tts.providers.find(p => p.cloning)?.cloning ?? {
      supported: false,
    };
  // If a future provider ever reports supported:true we simply say nothing here
  // (a real cloning UI would live elsewhere) — never fake it.
  if (cloning.supported) return null;
  return (
    <section
      style={{
        borderRadius: 13,
        border: `1px dashed ${C.border}`,
        background: C.panel,
        padding: '16px 18px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
      }}
    >
      <div
        style={{
          flexShrink: 0,
          width: 38,
          height: 38,
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: C.accentSoft,
          color: C.accent,
        }}
      >
        <CloneGlyph />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 14,
            fontWeight: 700,
            color: C.text,
          }}
        >
          Voice cloning
          <span style={pill}>coming soon</span>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
          {cloning.reason ||
            'Voice cloning needs a dedicated cloning provider. The current engines (OpenAI + Deepgram) offer preset voices only.'}
        </p>
      </div>
    </section>
  );
};

// ===========================================================================
// Styles (shared, inline)
// ===========================================================================

const panelCard: CSSProperties = {
  borderRadius: 13,
  border: `1px solid ${C.border}`,
  background: C.panel,
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const sectionLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: C.muted,
};

const fieldCol: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  flex: '1 1 200px',
};

const fieldLabel: CSSProperties = {
  fontSize: 11.5,
  color: C.muted,
  fontWeight: 600,
};

const staticField: CSSProperties = {
  padding: '9px 12px',
  borderRadius: 8,
  border: `1px solid ${C.border}`,
  background: C.panel,
  color: C.muted,
  fontSize: 13,
};

function selectStyle(enabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    padding: '9px 12px',
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.panel2,
    color: C.text,
    fontSize: 13,
    fontFamily: 'inherit',
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.6,
  };
}

const segBadge: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  padding: '2px 9px',
  borderRadius: 999,
  color: C.accent,
  background: C.accentSoft,
};

const pill: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  padding: '1px 7px',
  borderRadius: 999,
  color: C.muted,
  background:
    'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)',
};

const presetChip: CSSProperties = {
  appearance: 'none',
  padding: '5px 11px',
  borderRadius: 999,
  border: `1px solid ${C.border}`,
  background: C.panel2,
  color: C.text,
  fontSize: 11.5,
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'background 140ms ease, border-color 140ms ease',
};

// Context-aware starter chip — accented (vs. the neutral presetChip) so the
// "AI-suggested" affordance reads at a glance; matches the studio's accent.
const starterChip: CSSProperties = {
  appearance: 'none',
  padding: '7px 13px',
  borderRadius: 999,
  border: `1px solid ${C.accent}`,
  background: C.accentSoft,
  color: C.accent,
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  transition: 'background 140ms ease, border-color 140ms ease',
};

const addSegmentBtn: CSSProperties = {
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '11px 16px',
  borderRadius: 10,
  border: `1px dashed ${C.border}`,
  background: 'transparent',
  color: C.accent,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'background 140ms ease',
};

function primaryBtn(enabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 20px',
    borderRadius: 9,
    border: 'none',
    fontSize: 13.5,
    fontWeight: 700,
    color: '#fff',
    cursor: enabled ? 'pointer' : 'not-allowed',
    background: enabled
      ? C.accent
      : 'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 45%, #555)',
    opacity: enabled ? 1 : 0.75,
    transition: 'background 150ms ease, opacity 150ms ease',
  };
}

function secondaryBtn(enabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    padding: '8px 15px',
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.panel2,
    color: enabled ? C.text : C.muted,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.6,
  };
}

const ghostBtn: CSSProperties = {
  appearance: 'none',
  padding: '8px 15px',
  borderRadius: 8,
  border: `1px solid ${C.border}`,
  background: C.panel2,
  color: C.text,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
};

const linkBtn: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontSize: 12,
  color: C.muted,
  cursor: 'pointer',
  textDecoration: 'underline',
};

const playerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '12px 14px',
  borderRadius: 11,
  border: `1px solid ${C.border}`,
  background: C.panel2,
  flexWrap: 'wrap',
  marginTop: 4,
};

const bannerWarn: CSSProperties = {
  padding: '12px 14px',
  borderRadius: 10,
  fontSize: 13,
  background: C.warnBg,
  border: `1px solid ${C.warnBorder}`,
  color: C.text,
};

const bannerErr: CSSProperties = {
  padding: '9px 13px',
  borderRadius: 9,
  fontSize: 12.5,
  background: C.errBg,
  border: `1px solid ${C.errBorder}`,
  color: C.text,
};

const emptyBox: CSSProperties = {
  padding: '22px 12px',
  textAlign: 'center',
  fontSize: 12.5,
  color: C.muted,
  border: `1px dashed ${C.border}`,
  borderRadius: 10,
};

const historyRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 13px',
  borderRadius: 9,
  border: `1px solid ${C.border}`,
  background: C.panel,
};

const historyText: CSSProperties = {
  fontSize: 13,
  color: C.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const codeStyle: CSSProperties = {
  fontFamily: 'var(--affine-font-code-family, monospace)',
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 4,
  background:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  color: 'var(--affine-text-primary-color, #ececec)',
};

// ===========================================================================
// Boot-safe inline SVG icons (no @blocksuite/icons dependency)
// ===========================================================================

const IconBtn = ({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    disabled={disabled}
    onClick={onClick}
    style={{
      appearance: 'none',
      width: 28,
      height: 28,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 7,
      border: `1px solid ${C.border}`,
      background: 'transparent',
      color: disabled ? C.muted : C.text,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      padding: 0,
    }}
  >
    {children}
  </button>
);

const GenSpinner = () => (
  <span
    style={{
      display: 'inline-block',
      width: 12,
      height: 12,
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.4)',
      borderTopColor: '#fff',
      animation: 'cdz-voice-genspin 0.7s linear infinite',
    }}
  />
);

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: '1.9',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const PlayGlyph = () => (
  <svg width={14} height={14} {...svgProps} fill="currentColor" stroke="none">
    <path d="M7 4.5v15l12-7.5z" />
  </svg>
);

const BoltGlyph = () => (
  <svg width={15} height={15} {...svgProps} fill="currentColor" stroke="none">
    <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
  </svg>
);

const PlusGlyph = () => (
  <svg width={14} height={14} {...svgProps}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const TrashGlyph = () => (
  <svg width={14} height={14} {...svgProps}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </svg>
);

const CopyGlyph = () => (
  <svg width={14} height={14} {...svgProps}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </svg>
);

const ArrowGlyph = ({ dir }: { dir: 'up' | 'down' }) => (
  <svg width={14} height={14} {...svgProps}>
    {dir === 'up' ? (
      <path d="M12 19V5M6 11l6-6 6 6" />
    ) : (
      <path d="M12 5v14M6 13l6 6 6-6" />
    )}
  </svg>
);

const CloneGlyph = () => (
  <svg width={20} height={20} {...svgProps}>
    <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3.5" />
    <path d="M3 4l2 2M21 4l-2 2" />
  </svg>
);
