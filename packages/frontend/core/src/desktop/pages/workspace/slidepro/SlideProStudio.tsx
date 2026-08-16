// SlidePro — the studio orchestrator. Owns the per-workspace deck library, the
// current view (deck list · AI generate · editor), autosave, present mode, and
// the JSON export/import. This is the single stateful component the page mounts;
// every visual piece (list, generator, editor, present, slide renderer) is a
// child. All persistence is localStorage keyed by the workspace id.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  btnStyle,
  C,
  ensureShoperpResponsiveCss,
  miniBtnStyle,
} from '../shoperp/shoperp-shared';
import { DeckEditor } from './DeckEditor';
import { DeckList } from './DeckList';
import { GeneratePanel } from './GeneratePanel';
import { PresentMode } from './PresentMode';
import { printDeck } from './print';
import {
  cloneDeck,
  deckFromJson,
  deckToJson,
  deleteDeck as deleteDeckStore,
  downloadJson,
  loadDecks,
  newDeck,
  safeFilename,
  upsertDeck,
} from './storage';
import type { Deck, Slide } from './types';

type View = 'list' | 'generate' | 'editor';

const AUTOSAVE_DELAY_MS = 600;

export interface SlideProStudioProps {
  /** The current workspace id — the localStorage namespace + library scope. */
  workspaceId: string;
  /** When true, editing is blocked (the page passes the app's write state). */
  readOnly?: boolean;
}

export function SlideProStudio({ workspaceId, readOnly = false }: SlideProStudioProps) {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [view, setView] = useState<View>('list');
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [saveNote, setSaveNote] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load the workspace library on mount / workspace change.
  useEffect(() => {
    ensureShoperpResponsiveCss();
    const loaded = loadDecks(workspaceId);
    setDecks(loaded);
    setView('list');
    setCurrentId(null);
  }, [workspaceId]);

  const current = useMemo(
    () => decks.find(d => d.id === currentId) ?? null,
    [decks, currentId]
  );

  // ---- autosave: debounce writes of the CURRENT deck to storage ------------
  const scheduleSave = useCallback(
    (deck: Deck) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const next = upsertDeck(workspaceId, deck);
        setDecks(next);
        setSaveNote('Enregistré ✓');
        setTimeout(() => setSaveNote(''), 1500);
      }, AUTOSAVE_DELAY_MS);
    },
    [workspaceId]
  );

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // Update the working deck in memory immediately + schedule a persisted save.
  const updateDeck = useCallback(
    (deck: Deck) => {
      if (readOnly) return;
      setDecks(prev => prev.map(d => (d.id === deck.id ? deck : d)));
      scheduleSave(deck);
    },
    [readOnly, scheduleSave]
  );

  // ---- library actions -----------------------------------------------------
  const openDeck = useCallback((id: string) => {
    setCurrentId(id);
    setView('editor');
  }, []);

  const createBlank = useCallback(() => {
    const deck = newDeck();
    const next = upsertDeck(workspaceId, deck);
    setDecks(next);
    setCurrentId(deck.id);
    setView('editor');
  }, [workspaceId]);

  const duplicate = useCallback(
    (id: string) => {
      const src = decks.find(d => d.id === id);
      if (!src) return;
      const copy = cloneDeck(src);
      const next = upsertDeck(workspaceId, copy);
      setDecks(next);
    },
    [decks, workspaceId]
  );

  const remove = useCallback(
    (id: string) => {
      const next = deleteDeckStore(workspaceId, id);
      setDecks(next);
      if (currentId === id) {
        setCurrentId(null);
        setView('list');
      }
    },
    [workspaceId, currentId]
  );

  const rename = useCallback(
    (id: string, title: string) => {
      const src = decks.find(d => d.id === id);
      if (!src) return;
      const next = upsertDeck(workspaceId, { ...src, title });
      setDecks(next);
    },
    [decks, workspaceId]
  );

  // ---- AI generation → new deck --------------------------------------------
  const onGenerated = useCallback(
    (title: string, slides: Slide[]) => {
      const deck: Deck = { ...newDeck(title), title, slides };
      const next = upsertDeck(workspaceId, deck);
      setDecks(next);
      setCurrentId(deck.id);
      setView('editor');
    },
    [workspaceId]
  );

  // ---- import / export ------------------------------------------------------
  const exportCurrent = useCallback(() => {
    if (!current) return;
    downloadJson(deckToJson(current), safeFilename(current.title));
  }, [current]);

  const triggerImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onImportFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        const text = await file.text();
        const deck = deckFromJson(text);
        if (!deck) {
          window.alert('Fichier invalide — ce n’est pas un deck SlidePro.');
          return;
        }
        const next = upsertDeck(workspaceId, deck);
        setDecks(next);
        setCurrentId(deck.id);
        setView('editor');
      } catch {
        window.alert('Impossible de lire le fichier.');
      }
    },
    [workspaceId]
  );

  return (
    <div
      data-cdz-surface=""
      style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      {/* Hidden file input for JSON import */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={e => {
          void onImportFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 16px',
          borderBottom: `1px solid ${C.border}`,
          background: C.panel2,
          flexWrap: 'wrap',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            background: 'linear-gradient(135deg, #4f9cf9, #2f6bff)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 16,
            flexShrink: 0,
            boxShadow: '0 2px 8px rgba(47,107,255,0.3)',
          }}
        >
          📽️
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>SlidePro</div>
          <div style={{ fontSize: 11, color: C.muted }}>
            Générateur de présentations IA · natif
          </div>
        </div>

        {/* Breadcrumb / view-specific actions */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {saveNote ? (
            <span style={{ fontSize: 11.5, color: C.muted }}>{saveNote}</span>
          ) : null}

          {view === 'editor' && current ? (
            <>
              <button style={miniBtnStyle('secondary')} onClick={() => setView('list')}>
                ← Bibliothèque
              </button>
              <button style={miniBtnStyle('secondary')} onClick={exportCurrent}>
                ↧ Exporter JSON
              </button>
              <button
                style={miniBtnStyle('secondary')}
                onClick={() => {
                  const ok = printDeck(current);
                  if (!ok) {
                    window.alert(
                      'Le navigateur a bloqué la fenêtre d’impression. Autorisez les pop-ups puis réessayez.'
                    );
                  }
                }}
              >
                ⤓ PDF
              </button>
              <button
                style={miniBtnStyle('primary')}
                onClick={() => setPresenting(true)}
                disabled={current.slides.length === 0}
              >
                ▶ Présenter
              </button>
            </>
          ) : null}

          {view === 'generate' ? (
            <button style={miniBtnStyle('secondary')} onClick={() => setView('list')}>
              ← Bibliothèque
            </button>
          ) : null}

          {view === 'list' ? (
            <button style={miniBtnStyle('primary')} onClick={() => setView('generate')}>
              ✨ Nouvelle IA
            </button>
          ) : null}
        </div>
      </div>

      {/* Read-only strip */}
      {readOnly ? (
        <div style={{ padding: '8px 16px', background: C.warnBg, borderBottom: `1px solid ${C.border}`, fontSize: 12.5, color: C.text }}>
          Mode lecture seule — les modifications ne sont pas enregistrées.
        </div>
      ) : null}

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: view === 'editor' ? 'hidden' : 'auto', background: C.bg }}>
        {view === 'list' ? (
          <DeckList
            decks={decks}
            onOpen={openDeck}
            onCreateBlank={createBlank}
            onCreateAI={() => setView('generate')}
            onDuplicate={duplicate}
            onDelete={remove}
            onRename={rename}
            onImport={triggerImport}
          />
        ) : null}

        {view === 'generate' ? (
          <GeneratePanel onDeck={onGenerated} onCancel={() => setView('list')} />
        ) : null}

        {view === 'editor' && current ? (
          <DeckEditor deck={current} onChange={updateDeck} />
        ) : null}

        {view === 'editor' && !current ? (
          <div style={{ padding: 40, textAlign: 'center', color: C.muted }}>
            <div style={{ marginBottom: 12 }}>Ce deck est introuvable.</div>
            <button style={btnStyle('secondary')} onClick={() => setView('list')}>
              ← Retour à la bibliothèque
            </button>
          </div>
        ) : null}
      </div>

      {/* Present mode overlay */}
      {presenting && current ? (
        <PresentMode deck={current} onExit={() => setPresenting(false)} />
      ) : null}
    </div>
  );
}
