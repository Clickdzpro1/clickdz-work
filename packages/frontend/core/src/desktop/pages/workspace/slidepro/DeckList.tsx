// SlidePro — deck library home screen. A grid of the workspace's decks with a
// live theme-accurate thumbnail of slide 1, plus open / rename / duplicate /
// delete. Two primary actions up top: an AI-generated deck, or a blank deck.
// French throughout; inline styles + the shoperp palette.

import { useState } from 'react';

import { btnStyle, C, miniBtnStyle } from '../shoperp/shoperp-shared';
import { SlideView } from './SlideView';
import { getTheme } from './themes';
import type { Deck } from './types';

export interface DeckListProps {
  decks: Deck[];
  onOpen: (id: string) => void;
  onCreateBlank: () => void;
  onCreateAI: () => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onImport: () => void;
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.round(diff / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  return `il y a ${d} j`;
}

export function DeckList({
  decks,
  onOpen,
  onCreateBlank,
  onCreateAI,
  onDuplicate,
  onDelete,
  onRename,
  onImport,
}: DeckListProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const startRename = (deck: Deck) => {
    setRenamingId(deck.id);
    setRenameValue(deck.title);
  };
  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  return (
    <div style={{ padding: '28px 28px 60px', maxWidth: 1100, margin: '0 auto' }}>
      {/* Header + primary actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 22,
        }}
      >
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>
            Mes présentations
          </div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>
            {decks.length === 0
              ? 'Créez votre première présentation.'
              : `${decks.length} présentation${decks.length > 1 ? 's' : ''} dans cet espace de travail.`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button style={btnStyle('primary')} onClick={onCreateAI}>
            ✨ Présentation IA
          </button>
          <button style={btnStyle('secondary')} onClick={onCreateBlank}>
            + Deck vierge
          </button>
          <button style={btnStyle('secondary')} onClick={onImport}>
            ↥ Importer JSON
          </button>
        </div>
      </div>

      {decks.length === 0 ? (
        <EmptyState onCreateAI={onCreateAI} />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 18,
          }}
        >
          {decks.map(deck => {
            const theme = getTheme(deck.themeId);
            return (
              <div
                key={deck.id}
                style={{
                  border: `1px solid ${C.border}`,
                  borderRadius: 14,
                  overflow: 'hidden',
                  background: C.panel,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {/* Thumbnail (clickable → open) */}
                <button
                  onClick={() => onOpen(deck.id)}
                  style={{
                    appearance: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    background: theme.bg,
                    display: 'block',
                    lineHeight: 0,
                  }}
                  title="Ouvrir"
                >
                  {deck.slides[0] ? (
                    <SlideView
                      slide={deck.slides[0]}
                      themeId={deck.themeId}
                      width={240}
                    />
                  ) : (
                    <div style={{ width: 240, height: 135 }} />
                  )}
                </button>

                {/* Meta + actions */}
                <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {renamingId === deck.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        padding: '5px 8px',
                        borderRadius: 8,
                        border: `1px solid ${C.accent}`,
                        background: C.bg,
                        color: C.text,
                        fontSize: 13,
                        fontWeight: 700,
                        outline: 'none',
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 700,
                        color: C.text,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={deck.title}
                    >
                      {deck.title || 'Sans titre'}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: C.muted }}>
                    {deck.slides.length} diapo{deck.slides.length > 1 ? 's' : ''} ·{' '}
                    {relTime(deck.updatedAt)}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button style={miniBtnStyle('primary')} onClick={() => onOpen(deck.id)}>
                      Ouvrir
                    </button>
                    <button style={miniBtnStyle('secondary')} onClick={() => startRename(deck)}>
                      Renommer
                    </button>
                    <button style={miniBtnStyle('secondary')} onClick={() => onDuplicate(deck.id)}>
                      Dupliquer
                    </button>
                    <button
                      style={miniBtnStyle('danger')}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Supprimer « ${deck.title || 'Sans titre'} » ? Cette action est irréversible.`
                          )
                        ) {
                          onDelete(deck.id);
                        }
                      }}
                    >
                      Supprimer
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onCreateAI }: { onCreateAI: () => void }) {
  return (
    <div
      style={{
        border: `1px dashed ${C.border}`,
        borderRadius: 16,
        padding: '56px 24px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14,
        background: C.panel,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 56,
          height: 56,
          borderRadius: 14,
          background: 'linear-gradient(135deg, #4f9cf9, #2f6bff)',
          display: 'grid',
          placeItems: 'center',
          fontSize: 26,
          boxShadow: '0 4px 16px rgba(47,107,255,0.3)',
        }}
      >
        📽️
      </span>
      <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>
        Aucune présentation pour le moment
      </div>
      <div style={{ fontSize: 13, color: C.muted, maxWidth: 420, lineHeight: 1.5 }}>
        Décrivez un sujet et laissez l&apos;IA générer un plan puis un deck
        complet, prêt à présenter et à exporter en PDF.
      </div>
      <button style={{ ...btnStyle('primary'), marginTop: 4 }} onClick={onCreateAI}>
        ✨ Créer avec l&apos;IA
      </button>
    </div>
  );
}
