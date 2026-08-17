// SlidePro — AI generation flow. Two steps on one screen:
//   1) Prompt + options → generate an EDITABLE outline (fast, cheap).
//   2) Review/edit the outline → generate the full deck (title/bullets/notes).
// The user can skip the outline and go straight to a deck, or edit the outline
// freely before committing. All copy is French to match the surrounding UI.

import { useCallback, useState } from 'react';

import {
  Banner,
  btnStyle,
  C,
  inputStyle,
  labelStyle,
  miniBtnStyle,
  Spinner,
} from '../shoperp/shoperp-shared';
import { generateDeck, generateOutline, type GenOptions } from './api';
import type { Slide } from './types';

const TONES = ['Professionnel', 'Inspirant', 'Pédagogique', 'Commercial', 'Direct'];

export interface GeneratePanelProps {
  /** Called with the finished deck data when the user commits a generation. */
  onDeck: (title: string, slides: Slide[]) => void;
  /** Cancel back to the deck list / editor. */
  onCancel: () => void;
}

export function GeneratePanel({ onDeck, onCancel }: GeneratePanelProps) {
  const [prompt, setPrompt] = useState('');
  const [slideCount, setSlideCount] = useState(8);
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState(TONES[0]);
  const [language] = useState('French');

  const [outline, setOutline] = useState<string[] | null>(null);
  const [title, setTitle] = useState('');

  const [busy, setBusy] = useState<'outline' | 'deck' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const opts: GenOptions = { slideCount, audience, tone, language };

  const doOutline = useCallback(async () => {
    if (!prompt.trim()) return;
    setBusy('outline');
    setError(null);
    const r = await generateOutline(prompt.trim(), opts);
    setBusy(null);
    if (r.ok && r.outline) {
      setOutline(r.outline);
      if (r.title) setTitle(r.title);
    } else {
      setError(r.error || 'Échec de la génération du plan.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, slideCount, audience, tone, language]);

  const doDeck = useCallback(
    async (useOutline: boolean) => {
      if (!prompt.trim()) return;
      setBusy('deck');
      setError(null);
      const cleanedOutline = useOutline
        ? (outline ?? []).map(o => o.trim()).filter(Boolean)
        : undefined;
      const r = await generateDeck(prompt.trim(), cleanedOutline, opts);
      setBusy(null);
      if (r.ok && r.slides) {
        onDeck(r.title || title || prompt.trim().slice(0, 60), r.slides);
      } else {
        setError(r.error || 'Échec de la génération du deck.');
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [prompt, outline, title, slideCount, audience, tone, language, onDeck]
  );

  const updateOutlineItem = (i: number, value: string) => {
    setOutline(prev => {
      if (!prev) return prev;
      const next = [...prev];
      next[i] = value;
      return next;
    });
  };
  const removeOutlineItem = (i: number) => {
    setOutline(prev => (prev ? prev.filter((_, idx) => idx !== i) : prev));
  };
  const addOutlineItem = () => {
    setOutline(prev => [...(prev ?? []), '']);
  };

  return (
    <div
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: '28px 24px 60px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <div>
        <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>
          Nouvelle présentation IA
        </div>
        <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>
          Décrivez votre sujet — l&apos;IA rédige un plan puis un deck complet que
          vous pourrez éditer.
        </div>
      </div>

      {error ? <Banner tone="error">{error}</Banner> : null}

      {/* Prompt */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={labelStyle}>Sujet de la présentation</label>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="Ex : « Lancement de notre nouvelle gamme de baskets éco-responsables pour le marché algérien »"
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', minHeight: 84 }}
        />
      </div>

      {/* Options row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 14,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>Nombre de diapositives</label>
          <input
            type="number"
            min={1}
            max={30}
            value={slideCount}
            onChange={e =>
              setSlideCount(
                Math.max(1, Math.min(30, Number(e.target.value) || 8))
              )
            }
            style={inputStyle}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>Ton</label>
          <select
            value={tone}
            onChange={e => setTone(e.target.value)}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {TONES.map(t => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>Audience (optionnel)</label>
          <input
            value={audience}
            onChange={e => setAudience(e.target.value)}
            placeholder="Ex : investisseurs"
            style={inputStyle}
          />
        </div>
      </div>

      {/* Actions: outline first (recommended) or straight to deck. */}
      {!outline ? (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            style={btnStyle('primary', busy !== null || !prompt.trim())}
            disabled={busy !== null || !prompt.trim()}
            onClick={() => void doOutline()}
          >
            {busy === 'outline' ? <Spinner dark /> : '✨'} Générer le plan
          </button>
          <button
            style={btnStyle('secondary', busy !== null || !prompt.trim())}
            disabled={busy !== null || !prompt.trim()}
            onClick={() => void doDeck(false)}
          >
            {busy === 'deck' ? <Spinner /> : '⚡'} Deck complet direct
          </button>
          <button style={btnStyle('secondary')} onClick={onCancel}>
            Annuler
          </button>
        </div>
      ) : (
        <>
          {/* Editable outline */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <label style={labelStyle}>Plan — modifiable ({outline.length})</label>
              <button style={miniBtnStyle('secondary')} onClick={addOutlineItem}>
                + Section
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {outline.map((item, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span
                    style={{
                      width: 24,
                      textAlign: 'right',
                      color: C.muted,
                      fontSize: 12,
                      flexShrink: 0,
                    }}
                  >
                    {i + 1}.
                  </span>
                  <input
                    value={item}
                    onChange={e => updateOutlineItem(i, e.target.value)}
                    style={inputStyle}
                  />
                  <button
                    aria-label="Supprimer la section"
                    style={{
                      ...miniBtnStyle('secondary'),
                      padding: '5px 10px',
                      flexShrink: 0,
                    }}
                    onClick={() => removeOutlineItem(i)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              style={btnStyle('primary', busy !== null)}
              disabled={busy !== null}
              onClick={() => void doDeck(true)}
            >
              {busy === 'deck' ? <Spinner dark /> : '✨'} Générer le deck
            </button>
            <button
              style={btnStyle('secondary', busy !== null)}
              disabled={busy !== null}
              onClick={() => void doOutline()}
            >
              {busy === 'outline' ? <Spinner /> : '↻'} Régénérer le plan
            </button>
            <button
              style={btnStyle('secondary')}
              onClick={() => {
                setOutline(null);
              }}
            >
              ← Retour
            </button>
          </div>
        </>
      )}
    </div>
  );
}
