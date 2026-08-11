// ---------------------------------------------------------------------------
// Voice Studio — "Generate" tab.
//
// Text -> speech across two providers (Deepgram Aura-2 + OpenAI). Provider
// cards reflect live availability (a card whose key is missing is disabled
// with a tooltip). Voice select + speed (where supported) drive the request;
// the result plays inline and can be downloaded. A localStorage history of the
// last 10 generations offers one-click "Regenerate".
// ---------------------------------------------------------------------------
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useIsNarrow } from './use-voice-responsive';
import {
  C,
  type GenerationHistoryItem,
  HISTORY_LIMIT,
  readHistory,
  synthesizeSpeech,
  TTS_MAX_CHARS,
  ttsBulk,
  type TtsProviderCap,
  type TtsProviderId,
  downloadBlob,
  writeHistory,
} from './voice-shared';

interface GenerateTabProps {
  providers: TtsProviderCap[];
  defaultProvider: TtsProviderId;
}

export const GenerateTab = ({ providers, defaultProvider }: GenerateTabProps) => {
  const isPhone = useIsNarrow(480);
  const [text, setText] = useState('');
  const [provider, setProvider] = useState<TtsProviderId>(defaultProvider);
  const [voice, setVoice] = useState<string>('');
  const [speed, setSpeed] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [history, setHistory] = useState<GenerationHistoryItem[]>([]);
  // Bulk (long-script) TTS state — a separate button for texts too long for a
  // single-shot call; the result is persisted to the Library automatically.
  const [bulking, setBulking] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  // Track the current object URL so we can revoke the previous one on replace.
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    setHistory(readHistory());
  }, []);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const activeProvider = useMemo(
    () => providers.find(p => p.id === provider),
    [providers, provider]
  );

  // Keep the voice valid for the selected provider (default it when the
  // provider changes or the current voice isn't in the new provider's list).
  useEffect(() => {
    if (!activeProvider) return;
    if (!activeProvider.voices.includes(voice)) {
      setVoice(activeProvider.defaultVoice || activeProvider.voices[0] || '');
    }
  }, [activeProvider, voice]);

  const selectProvider = useCallback((cap: TtsProviderCap) => {
    if (!cap.available) return;
    setProvider(cap.id);
    setError(null);
  }, []);

  const setAudio = useCallback((url: string | null, blob: Blob | null) => {
    if (urlRef.current && urlRef.current !== url) {
      URL.revokeObjectURL(urlRef.current);
    }
    urlRef.current = url;
    setAudioUrl(url);
    setAudioBlob(blob);
  }, []);

  const runGeneration = useCallback(
    async (req: {
      text: string;
      provider: TtsProviderId;
      voice: string;
      speed?: number;
    }) => {
      const trimmed = req.text.trim();
      if (!trimmed || generating) return;
      setGenerating(true);
      setError(null);
      const cap = providers.find(p => p.id === req.provider);
      const outcome = await synthesizeSpeech({
        text: trimmed.slice(0, TTS_MAX_CHARS),
        provider: req.provider,
        voice: req.voice,
        speed: cap?.supportsSpeed ? req.speed : undefined,
      });
      setGenerating(false);
      if (!outcome.ok) {
        setError(
          outcome.reason === 'unavailable'
            ? `The ${cap?.label || req.provider} provider is not configured.`
            : `Generation failed with ${cap?.label || req.provider}. Please try again.`
        );
        return;
      }
      setAudio(outcome.url, outcome.blob);
      // Prepend to history (dedupe-free: each generation is a distinct entry).
      const item: GenerationHistoryItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: trimmed.slice(0, 400),
        provider: req.provider,
        voice: req.voice,
        speed: cap?.supportsSpeed ? req.speed : undefined,
        createdAt: Date.now(),
      };
      setHistory(prev => {
        const next = [item, ...prev].slice(0, HISTORY_LIMIT);
        writeHistory(next);
        return next;
      });
    },
    [generating, providers, setAudio]
  );

  const onGenerate = useCallback(() => {
    void runGeneration({ text, provider, voice, speed });
  }, [runGeneration, text, provider, voice, speed]);

  // Bulk / long-script synthesis: the server splits the text, synthesizes each
  // chunk serially, byte-concats and persists the clip to the Library.
  const onBulk = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || bulking) return;
    const cap = providers.find(p => p.id === provider);
    if (!cap?.available) {
      setBulkError("Le fournisseur sélectionné n'est pas disponible.");
      return;
    }
    setBulking(true);
    setBulkError(null);
    setBulkResult(null);
    const out = await ttsBulk({
      text: trimmed,
      provider,
      voice: activeProvider?.voices.includes(voice) ? voice : activeProvider?.defaultVoice || voice,
      model: activeProvider?.models?.includes(activeProvider?.defaultModel as string)
        ? activeProvider?.defaultModel
        : undefined,
      speed: cap?.supportsSpeed ? speed : undefined,
      format: 'mp3',
    });
    setBulking(false);
    if (out.ok) {
      setBulkResult(
        `${out.result.chunks} segment(s) — clip enregistré dans la bibliothèque : « ${out.result.clip.name} ».`
      );
    } else {
      setBulkError(
        out.reason === 'bad'
          ? 'Texte invalide ou trop long pour la synthèse longue.'
          : 'Échec de la synthèse longue. Réessayez dans un instant.'
      );
    }
  }, [text, bulking, providers, provider, activeProvider, voice, speed]);

  // Replay a history row: restore its params and re-run the request.
  const regenerate = useCallback(
    (item: GenerationHistoryItem) => {
      const cap = providers.find(p => p.id === item.provider);
      if (!cap || !cap.available) {
        setError(
          `Can't regenerate — the ${cap?.label || item.provider} provider is not available.`
        );
        return;
      }
      setText(item.text);
      setProvider(item.provider);
      setVoice(item.voice);
      if (typeof item.speed === 'number') setSpeed(item.speed);
      void runGeneration({
        text: item.text,
        provider: item.provider,
        voice: item.voice,
        speed: item.speed,
      });
    },
    [providers, runGeneration]
  );

  const clearHistory = useCallback(() => {
    setHistory([]);
    writeHistory([]);
  }, []);

  const overLimit = text.length > TTS_MAX_CHARS;
  const anyProviderAvailable = providers.some(p => p.available);
  const canGenerate =
    !!activeProvider?.available &&
    text.trim().length > 0 &&
    !overLimit &&
    !generating;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <style>
        {`@keyframes cdz-voice-genspin{to{transform:rotate(360deg)}}`}
      </style>

      {!anyProviderAvailable ? (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 10,
            fontSize: 13,
            background: C.warnBg,
            border: `1px solid ${C.warnBorder}`,
            color: C.text,
          }}
        >
          <strong>No speech provider is configured.</strong>
          <br />
          Ask the owner to set <code style={codeStyle}>DEEPGRAM_API_KEY</code>{' '}
          and/or an OpenAI key on the server, then reload.
        </div>
      ) : null}

      {/* Textarea + counter ------------------------------------------------ */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Type or paste the text you want spoken aloud…"
          rows={5}
          style={{
            width: '100%',
            resize: 'vertical',
            boxSizing: 'border-box',
            padding: '13px 14px',
            borderRadius: 10,
            border: `1px solid ${overLimit ? C.errBorder : C.border}`,
            background: C.panel,
            color: C.text,
            fontSize: 14,
            lineHeight: 1.6,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            fontSize: 11.5,
            color: overLimit ? C.errText : C.muted,
          }}
        >
          {text.length} / {TTS_MAX_CHARS}
        </div>
      </div>

      {/* Provider cards ---------------------------------------------------- */}
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
                background: selected ? C.accentSoft : C.panel,
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
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      padding: '1px 7px',
                      borderRadius: 999,
                      color: C.muted,
                      background:
                        'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)',
                    }}
                  >
                    unavailable
                  </span>
                ) : selected ? (
                  <span style={{ fontSize: 12, color: C.accent }}>✓</span>
                ) : null}
              </div>
              <div style={{ fontSize: 11.5, color: C.muted }}>
                {cap.voices.length} voice{cap.voices.length === 1 ? '' : 's'}
                {cap.supportsSpeed ? ' · speed control' : ''}
              </div>
            </button>
          );
        })}
      </div>

      {/* Voice + speed controls ------------------------------------------- */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          alignItems: 'flex-end',
        }}
      >
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            flex: '1 1 220px',
          }}
        >
          <span style={{ fontSize: 11.5, color: C.muted, fontWeight: 600 }}>
            Voice
          </span>
          <select
            value={voice}
            disabled={!activeProvider?.available}
            onChange={e => setVoice(e.target.value)}
            style={{
              appearance: 'none',
              padding: '9px 12px',
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: C.panel,
              color: C.text,
              fontSize: 13,
              fontFamily: 'inherit',
              cursor: activeProvider?.available ? 'pointer' : 'not-allowed',
              opacity: activeProvider?.available ? 1 : 0.6,
            }}
          >
            {(activeProvider?.voices ?? []).map(v => (
              <option key={v} value={v}>
                {formatVoiceLabel(v)}
              </option>
            ))}
          </select>
        </label>

        {activeProvider?.supportsSpeed ? (
          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              flex: '1 1 220px',
            }}
          >
            <span style={{ fontSize: 11.5, color: C.muted, fontWeight: 600 }}>
              Speed · {speed.toFixed(2)}×
            </span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={speed}
              onChange={e => setSpeed(Number(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--affine-primary-color, #1e96eb)' }}
            />
          </label>
        ) : null}

        <button
          type="button"
          disabled={!canGenerate}
          onClick={onGenerate}
          style={{
            appearance: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '10px 20px',
            minHeight: 40,
            borderRadius: 9,
            border: 'none',
            fontSize: 13.5,
            fontWeight: 700,
            color: '#fff',
            cursor: canGenerate ? 'pointer' : 'not-allowed',
            width: isPhone ? '100%' : undefined,
            background: canGenerate
              ? C.accent
              : 'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 45%, #555)',
            opacity: canGenerate ? 1 : 0.75,
            transition: 'background 150ms ease, opacity 150ms ease',
          }}
        >
          {generating ? <GenSpinner /> : null}
          {generating ? 'Generating…' : 'Generate speech'}
        </button>
      </div>

      {error ? (
        <div
          style={{
            padding: '10px 13px',
            borderRadius: 9,
            fontSize: 12.5,
            background: C.errBg,
            border: `1px solid ${C.errBorder}`,
            color: C.text,
          }}
        >
          {error}
        </div>
      ) : null}

      {/* Player ------------------------------------------------------------ */}
      {audioUrl ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '14px 16px',
            borderRadius: 11,
            border: `1px solid ${C.border}`,
            background: C.panel,
            flexWrap: 'wrap',
          }}
        >
          {/* Reset the <audio> element per new URL so it reloads the source. */}
          <audio
            key={audioUrl}
            src={audioUrl}
            controls
            autoPlay
            style={{ flex: '1 1 260px', maxWidth: '100%', height: 40 }}
          />
          <button
            type="button"
            onClick={() =>
              audioBlob && downloadBlob('clickdz-speech.mp3', audioBlob)
            }
            style={{
              appearance: 'none',
              padding: '8px 15px',
              minHeight: 40,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: C.panel2,
              color: C.text,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: 'pointer',
              width: isPhone ? '100%' : undefined,
            }}
          >
            Download .mp3
          </button>
        </div>
      ) : null}

      {/* Bulk / long-script TTS ------------------------------------------ */}
      <div
        style={{
          borderRadius: 12,
          border: `1px dashed ${C.border}`,
          background: C.panel,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
            🔊 Synthèse longue (script long)
          </span>
          <span style={{ fontSize: 11, color: C.muted }}>
            {text.length} caractères
          </span>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
          Pour un script dépassant la saisie simple, le serveur découpe le texte
          par phrases, synthétise chaque segment puis rassemble le tout en un
          seul fichier, enregistré automatiquement dans la bibliothèque.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            disabled={!anyProviderAvailable || !text.trim() || bulking}
            onClick={() => void onBulk()}
            style={{
              appearance: 'none',
              padding: '9px 16px',
              minHeight: 40,
              borderRadius: 8,
              border: 'none',
              fontSize: 13,
              fontWeight: 600,
              color: '#fff',
              cursor:
                !anyProviderAvailable || !text.trim() || bulking
                  ? 'not-allowed'
                  : 'pointer',
              background:
                !anyProviderAvailable || !text.trim()
                  ? 'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 45%, #555)'
                  : C.accent,
              opacity: bulking ? 0.7 : 1,
              width: isPhone ? '100%' : undefined,
            }}
          >
            {bulking ? <GenSpinner /> : null}
            {bulking ? 'Génération longue…' : 'Générer le script complet'}
          </button>
          {bulkResult ? (
            <span style={{ fontSize: 12, color: C.okText }}>{bulkResult}</span>
          ) : null}
        </div>
        {bulkError ? (
          <p style={{ margin: 0, fontSize: 12, color: C.errText }}>{bulkError}</p>
        ) : null}
      </div>

      {/* History ----------------------------------------------------------- */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              color: C.muted,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18,
                height: 18,
                borderRadius: 5,
                background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                fontSize: 10,
              }}
            >
              🕓
            </span>
            Historique
          </div>
          <div style={{ flex: 1 }} />
          {history.length ? (
            <button
              type="button"
              onClick={clearHistory}
              style={{
                appearance: 'none',
                background: 'none',
                border: 'none',
                padding: 0,
                font: 'inherit',
                fontSize: 12,
                color: C.muted,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Clear
            </button>
          ) : null}
        </div>

        {!history.length ? (
          <div
            style={{
              padding: '32px 16px',
              textAlign: 'center',
              fontSize: 13,
              color: C.muted,
              border: `1px dashed ${C.border}`,
              borderRadius: 12,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ fontSize: 24, opacity: 0.45 }}>🕓</span>
            <span>Vos {HISTORY_LIMIT} dernières générations apparaîtront ici.</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.map(item => {
              const cap = providers.find(p => p.id === item.provider);
              return (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 13px',
                    borderRadius: 9,
                    border: `1px solid ${C.border}`,
                    background: C.panel,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        color: C.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.text}
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                      {cap?.label || item.provider} · {formatVoiceLabel(item.voice)}
                      {typeof item.speed === 'number'
                        ? ` · ${item.speed.toFixed(2)}×`
                        : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => regenerate(item)}
                    disabled={generating}
                    title={
                      cap?.available
                        ? 'Regenerate with these settings'
                        : `${cap?.label || item.provider} is unavailable`
                    }
                    style={{
                      appearance: 'none',
                      padding: '6px 12px',
                      minHeight: 40,
                      borderRadius: 7,
                      border: `1px solid ${C.border}`,
                      background: 'transparent',
                      color: generating ? C.muted : C.accent,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: generating ? 'not-allowed' : 'pointer',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    Regenerate
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

// ---- helpers --------------------------------------------------------------

const codeStyle: CSSProperties = {
  fontFamily: 'var(--affine-font-code-family, monospace)',
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 4,
  background:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  color: 'var(--affine-text-primary-color, #ececec)',
};

/**
 * Prettify a raw voice id for display. Deepgram ids look like
 * `aura-2-thalia-en` -> "Thalia (en)"; OpenAI ids are single words -> "Alloy".
 */
function formatVoiceLabel(id: string): string {
  if (!id) return '';
  const auraMatch = /^aura-\d+-([a-z]+)-([a-z]{2})$/.exec(id);
  if (auraMatch) {
    const name = auraMatch[1];
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} (${auraMatch[2]})`;
  }
  return id.charAt(0).toUpperCase() + id.slice(1);
}

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
