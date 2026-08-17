// SlidePro — the deck editor. Three columns:
//   · left  : slide thumbnails (select, add, duplicate, delete, reorder ↑/↓)
//   · centre: live preview of the selected slide (the real SlideView renderer)
//   · right : inspector — title, layout, bullets (+ right column), notes, image
// Every edit flows up through onChange so the parent can autosave. All copy is
// French. Inline styles + the shoperp palette, matching the sibling studios.

import { nanoid } from 'nanoid';
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from 'react';

import {
  Banner,
  btnStyle,
  C,
  inputStyle,
  labelStyle,
  miniBtnStyle,
  Spinner,
} from '../shoperp/shoperp-shared';
import { generateSlideImage } from './api';
import { ResponsiveSlide, SlideView } from './SlideView';
import { emptySlide } from './storage';
import { THEMES } from './themes';
import {
  LAYOUT_LABELS,
  SLIDE_LAYOUTS,
  type Deck,
  type Slide,
  type SlideLayout,
} from './types';

export interface DeckEditorProps {
  deck: Deck;
  onChange: (deck: Deck) => void;
}

export function DeckEditor({ deck, onChange }: DeckEditorProps) {
  const [selectedId, setSelectedId] = useState<string>(
    deck.slides[0]?.id ?? ''
  );
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  const selectedIndex = Math.max(
    0,
    deck.slides.findIndex(s => s.id === selectedId)
  );
  const selected: Slide | undefined =
    deck.slides.find(s => s.id === selectedId) ?? deck.slides[0];

  // ---- deck-level mutations -------------------------------------------------
  const patchDeck = useCallback(
    (patch: Partial<Deck>) => onChange({ ...deck, ...patch }),
    [deck, onChange]
  );

  const patchSlides = useCallback(
    (slides: Slide[]) => onChange({ ...deck, slides }),
    [deck, onChange]
  );

  const patchSlide = useCallback(
    (id: string, patch: Partial<Slide>) => {
      patchSlides(deck.slides.map(s => (s.id === id ? { ...s, ...patch } : s)));
    },
    [deck.slides, patchSlides]
  );

  const addSlide = useCallback(() => {
    const s = emptySlide({ title: 'Nouvelle diapositive', layout: 'title-bullets' });
    const at = selectedIndex + 1;
    const slides = [...deck.slides];
    slides.splice(at, 0, s);
    patchSlides(slides);
    setSelectedId(s.id);
  }, [deck.slides, selectedIndex, patchSlides]);

  const duplicateSlide = useCallback(
    (id: string) => {
      const idx = deck.slides.findIndex(s => s.id === id);
      if (idx < 0) return;
      const copy = { ...deck.slides[idx], id: nanoid(10) };
      const slides = [...deck.slides];
      slides.splice(idx + 1, 0, copy);
      patchSlides(slides);
      setSelectedId(copy.id);
    },
    [deck.slides, patchSlides]
  );

  const deleteSlide = useCallback(
    (id: string) => {
      if (deck.slides.length <= 1) return; // never leave a deck with zero slides
      const idx = deck.slides.findIndex(s => s.id === id);
      const slides = deck.slides.filter(s => s.id !== id);
      patchSlides(slides);
      const nextSel = slides[Math.min(idx, slides.length - 1)];
      if (nextSel) setSelectedId(nextSel.id);
    },
    [deck.slides, patchSlides]
  );

  const moveSlide = useCallback(
    (id: string, dir: -1 | 1) => {
      const idx = deck.slides.findIndex(s => s.id === id);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= deck.slides.length) return;
      const slides = [...deck.slides];
      const [item] = slides.splice(idx, 1);
      slides.splice(to, 0, item);
      patchSlides(slides);
    },
    [deck.slides, patchSlides]
  );

  // ---- bullet editing helpers ----------------------------------------------
  const setBullet = (field: 'bullets' | 'bulletsRight') => (i: number, v: string) => {
    if (!selected) return;
    const arr = [...selected[field]];
    arr[i] = v;
    patchSlide(selected.id, { [field]: arr } as Partial<Slide>);
  };
  const addBullet = (field: 'bullets' | 'bulletsRight') => () => {
    if (!selected) return;
    patchSlide(selected.id, {
      [field]: [...selected[field], ''],
    } as Partial<Slide>);
  };
  const removeBullet = (field: 'bullets' | 'bulletsRight') => (i: number) => {
    if (!selected) return;
    patchSlide(selected.id, {
      [field]: selected[field].filter((_, idx) => idx !== i),
    } as Partial<Slide>);
  };

  const regenImage = useCallback(async () => {
    if (!selected) return;
    const p = selected.imagePrompt.trim() || selected.title.trim();
    if (!p) {
      setImageError('Ajoutez une description d’image d’abord.');
      return;
    }
    setImageBusy(true);
    setImageError(null);
    const r = await generateSlideImage(p);
    setImageBusy(false);
    if (r.ok && r.url) {
      patchSlide(selected.id, { imageUrl: r.url, imagePrompt: p });
    } else {
      setImageError(r.error || 'Génération d’image indisponible.');
    }
  }, [selected, patchSlide]);

  const themeMemo = useMemo(() => THEMES, []);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '208px 1fr 320px',
        height: '100%',
        minHeight: 0,
        background: C.bg,
      }}
    >
      {/* ---- left: slide list ---- */}
      <aside
        style={{
          borderRight: `1px solid ${C.border}`,
          background: C.panel,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div
          style={{
            padding: '10px 12px',
            borderBottom: `1px solid ${C.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: C.muted }}>
            {deck.slides.length} diapo{deck.slides.length > 1 ? 's' : ''}
          </span>
          <button style={miniBtnStyle('primary')} onClick={addSlide}>
            + Ajouter
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {deck.slides.map((s, i) => {
            const active = s.id === selected?.id;
            return (
              <div
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                style={{
                  border: `2px solid ${active ? C.accent : 'transparent'}`,
                  borderRadius: 10,
                  padding: 4,
                  cursor: 'pointer',
                  background: active ? C.accentSoft : 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: C.muted, width: 16 }}>{i + 1}</span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                    <IconBtn title="Monter" disabled={i === 0} onClick={e => { e.stopPropagation(); moveSlide(s.id, -1); }}>↑</IconBtn>
                    <IconBtn title="Descendre" disabled={i === deck.slides.length - 1} onClick={e => { e.stopPropagation(); moveSlide(s.id, 1); }}>↓</IconBtn>
                    <IconBtn title="Dupliquer" onClick={e => { e.stopPropagation(); duplicateSlide(s.id); }}>⧉</IconBtn>
                    <IconBtn title="Supprimer" disabled={deck.slides.length <= 1} onClick={e => { e.stopPropagation(); deleteSlide(s.id); }}>✕</IconBtn>
                  </div>
                </div>
                {/* Thumbnail is the real renderer at a small fixed width. */}
                <SlideView slide={s} themeId={deck.themeId} width={168} />
              </div>
            );
          })}
        </div>
      </aside>

      {/* ---- centre: live preview ---- */}
      <main
        style={{
          minWidth: 0,
          minHeight: 0,
          overflow: 'auto',
          padding: '24px 28px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* Deck title + theme switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <input
            value={deck.title}
            onChange={e => patchDeck({ title: e.target.value })}
            placeholder="Titre du deck"
            style={{
              ...inputStyle,
              flex: 1,
              minWidth: 200,
              fontSize: 15,
              fontWeight: 700,
              background: 'transparent',
              border: 'none',
              padding: '4px 0',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>Thème</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {themeMemo.map(t => (
                <button
                  key={t.id}
                  title={t.label}
                  onClick={() => patchDeck({ themeId: t.id })}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 7,
                    cursor: 'pointer',
                    padding: 0,
                    background: t.swatch[0],
                    border: `2px solid ${deck.themeId === t.id ? C.accent : C.border}`,
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      right: 3,
                      bottom: 3,
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: t.swatch[1],
                    }}
                  />
                </button>
              ))}
            </div>
          </div>
        </div>

        {selected ? (
          <ResponsiveSlide
            slide={selected}
            themeId={deck.themeId}
            pageNumber={selectedIndex + 1}
            totalPages={deck.slides.length}
            footerLabel={deck.title}
            maxWidth={900}
          />
        ) : null}
      </main>

      {/* ---- right: inspector ---- */}
      <aside
        style={{
          borderLeft: `1px solid ${C.border}`,
          background: C.panel,
          overflowY: 'auto',
          minHeight: 0,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {!selected ? (
          <div style={{ color: C.muted, fontSize: 13 }}>
            Aucune diapositive sélectionnée.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={labelStyle}>Titre</label>
              <input
                value={selected.title}
                onChange={e => patchSlide(selected.id, { title: e.target.value })}
                style={inputStyle}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={labelStyle}>Disposition</label>
              <select
                value={selected.layout}
                onChange={e =>
                  patchSlide(selected.id, {
                    layout: e.target.value as SlideLayout,
                  })
                }
                style={{ ...inputStyle, cursor: 'pointer' }}
              >
                {SLIDE_LAYOUTS.map(l => (
                  <option key={l} value={l}>
                    {LAYOUT_LABELS[l]}
                  </option>
                ))}
              </select>
            </div>

            {/* Bullets — for every layout except pure title we show the primary
                list; the label adapts for the quote layout. */}
            {selected.layout !== 'title' ? (
              <BulletEditor
                label={
                  selected.layout === 'quote'
                    ? 'Citation'
                    : selected.layout === 'two-column'
                      ? 'Colonne gauche'
                      : 'Points'
                }
                bullets={selected.bullets}
                onChange={setBullet('bullets')}
                onAdd={addBullet('bullets')}
                onRemove={removeBullet('bullets')}
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={labelStyle}>Sous-titre</label>
                <input
                  value={selected.bullets[0] ?? ''}
                  onChange={e =>
                    patchSlide(selected.id, { bullets: [e.target.value] })
                  }
                  style={inputStyle}
                />
              </div>
            )}

            {selected.layout === 'two-column' ? (
              <BulletEditor
                label="Colonne droite"
                bullets={selected.bulletsRight}
                onChange={setBullet('bulletsRight')}
                onAdd={addBullet('bulletsRight')}
                onRemove={removeBullet('bulletsRight')}
              />
            ) : null}

            {selected.layout === 'image-text' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={labelStyle}>Image</label>
                <textarea
                  value={selected.imagePrompt}
                  onChange={e =>
                    patchSlide(selected.id, { imagePrompt: e.target.value })
                  }
                  placeholder="Décrivez l’image à générer…"
                  rows={2}
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    style={miniBtnStyle('primary', imageBusy)}
                    disabled={imageBusy}
                    onClick={() => void regenImage()}
                  >
                    {imageBusy ? <Spinner dark /> : '✨'}{' '}
                    {selected.imageUrl ? 'Regénérer' : 'Générer'} l’image
                  </button>
                  {selected.imageUrl ? (
                    <button
                      style={miniBtnStyle('secondary')}
                      onClick={() => patchSlide(selected.id, { imageUrl: '' })}
                    >
                      Retirer
                    </button>
                  ) : null}
                </div>
                {imageError ? <Banner tone="warn">{imageError}</Banner> : null}
              </div>
            ) : null}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={labelStyle}>Notes de présentateur</label>
              <textarea
                value={selected.notes}
                onChange={e => patchSlide(selected.id, { notes: e.target.value })}
                placeholder="Ce que vous direz sur cette diapo…"
                rows={4}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                style={{ ...btnStyle('secondary'), flex: 1 }}
                onClick={() => duplicateSlide(selected.id)}
              >
                ⧉ Dupliquer
              </button>
              <button
                style={{ ...btnStyle('danger'), flex: 1 }}
                disabled={deck.slides.length <= 1}
                onClick={() => deleteSlide(selected.id)}
              >
                ✕ Supprimer
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function IconBtn({
  children,
  title,
  disabled,
  onClick,
}: {
  children: ReactNode;
  title: string;
  disabled?: boolean;
  onClick: (e: ReactMouseEvent) => void;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        appearance: 'none',
        width: 20,
        height: 20,
        borderRadius: 5,
        border: `1px solid ${C.border}`,
        background: C.panel2,
        color: C.muted,
        fontSize: 11,
        lineHeight: '1',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function BulletEditor({
  label,
  bullets,
  onChange,
  onAdd,
  onRemove,
}: {
  label: string;
  bullets: string[];
  onChange: (i: number, v: string) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label style={labelStyle}>{label}</label>
        <button style={{ ...miniBtnStyle('secondary'), padding: '3px 9px' }} onClick={onAdd}>
          +
        </button>
      </div>
      {bullets.length === 0 ? (
        <div style={{ fontSize: 12, color: C.muted }}>Aucun point.</div>
      ) : (
        bullets.map((b, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <textarea
              value={b}
              onChange={e => onChange(i, e.target.value)}
              rows={1}
              style={{
                ...inputStyle,
                padding: '6px 9px',
                fontSize: 13,
                resize: 'vertical',
                minHeight: 32,
              }}
            />
            <button
              aria-label="Supprimer le point"
              onClick={() => onRemove(i)}
              style={{
                ...miniBtnStyle('secondary'),
                padding: '5px 9px',
                flexShrink: 0,
              }}
            >
              ✕
            </button>
          </div>
        ))
      )}
    </div>
  );
}
