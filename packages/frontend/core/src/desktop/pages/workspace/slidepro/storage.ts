// SlidePro — per-workspace persistence in localStorage. Decks are stored under
// a key namespaced by the current workspace id, so switching workspaces shows a
// different deck library (mirrors how the old iframe panel keyed its state by
// the workspace id it was handed). Everything is plain JSON, so the same shape
// backs the file export/import buttons.

import { nanoid } from 'nanoid';

import { DEFAULT_THEME_ID } from './themes';
import type { Deck, Slide } from './types';

const STORAGE_PREFIX = 'cdz.slidepro.decks.';
const SCHEMA_VERSION = 1;

interface StoredEnvelope {
  version: number;
  decks: Deck[];
}

function storageKey(workspaceId: string): string {
  return `${STORAGE_PREFIX}${workspaceId}`;
}

/** Read every deck for a workspace (most-recent first). Never throws. */
export function loadDecks(workspaceId: string): Deck[] {
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredEnvelope | Deck[];
    // Tolerate both the versioned envelope and a bare array (older writes).
    const decks = Array.isArray(parsed) ? parsed : parsed?.decks;
    if (!Array.isArray(decks)) return [];
    return decks
      .filter(isDeckish)
      .map(normalizeDeck)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** Persist the full deck list for a workspace. Best-effort (quota/denied OK). */
export function saveDecks(workspaceId: string, decks: Deck[]): void {
  try {
    const envelope: StoredEnvelope = { version: SCHEMA_VERSION, decks };
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(envelope));
  } catch {
    /* storage full / unavailable — non-fatal, in-memory state still stands */
  }
}

/** Upsert one deck into the workspace library and persist. Returns the list. */
export function upsertDeck(workspaceId: string, deck: Deck): Deck[] {
  const decks = loadDecks(workspaceId);
  const idx = decks.findIndex(d => d.id === deck.id);
  const next = { ...deck, updatedAt: Date.now() };
  if (idx >= 0) decks[idx] = next;
  else decks.unshift(next);
  saveDecks(workspaceId, decks);
  return decks.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Remove a deck by id and persist. Returns the remaining list. */
export function deleteDeck(workspaceId: string, deckId: string): Deck[] {
  const decks = loadDecks(workspaceId).filter(d => d.id !== deckId);
  saveDecks(workspaceId, decks);
  return decks;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function emptySlide(partial: Partial<Slide> = {}): Slide {
  return {
    id: nanoid(10),
    title: '',
    layout: 'title-bullets',
    bullets: [],
    bulletsRight: [],
    notes: '',
    imagePrompt: '',
    imageUrl: '',
    ...partial,
  };
}

export function newDeck(title = 'Présentation sans titre'): Deck {
  const now = Date.now();
  return {
    id: nanoid(12),
    title,
    themeId: DEFAULT_THEME_ID,
    slides: [
      emptySlide({
        layout: 'title',
        title,
        bullets: ['Sous-titre'],
      }),
    ],
    createdAt: now,
    updatedAt: now,
  };
}

/** Deep-clone a deck with a fresh id + slide ids (for duplicate). */
export function cloneDeck(deck: Deck, title?: string): Deck {
  const now = Date.now();
  return {
    ...deck,
    id: nanoid(12),
    title: title ?? `${deck.title} (copie)`,
    slides: deck.slides.map(s => ({ ...s, id: nanoid(10) })),
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Import / export (the JSON buttons)
// ---------------------------------------------------------------------------

/** Serialise a deck to a pretty JSON string for download. */
export function deckToJson(deck: Deck): string {
  return JSON.stringify({ version: SCHEMA_VERSION, deck }, null, 2);
}

/**
 * Parse an imported JSON string into a Deck with FRESH ids (so importing never
 * collides with an existing deck). Accepts either a {version, deck} envelope or
 * a bare deck object. Returns null when the payload isn't a usable deck.
 */
export function deckFromJson(text: string): Deck | null {
  try {
    const parsed = JSON.parse(text) as { deck?: unknown } | unknown;
    const candidate =
      parsed && typeof parsed === 'object' && 'deck' in (parsed as any)
        ? (parsed as any).deck
        : parsed;
    if (!isDeckish(candidate)) return null;
    const now = Date.now();
    const deck = normalizeDeck(candidate as Deck);
    return {
      ...deck,
      id: nanoid(12),
      slides: deck.slides.map(s => ({ ...s, id: nanoid(10) })),
      createdAt: now,
      updatedAt: now,
    };
  } catch {
    return null;
  }
}

/** Trigger a browser download of `text` as `filename`. */
export function downloadJson(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has definitely started the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filesystem-safe filename stem from a deck title. */
export function safeFilename(title: string): string {
  const stem =
    title
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'presentation';
  return `${stem}.slidepro.json`;
}

// ---------------------------------------------------------------------------
// Validation / normalisation
// ---------------------------------------------------------------------------

function isDeckish(v: unknown): v is Deck {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as any).slides) &&
    typeof (v as any).title === 'string'
  );
}

/** Fill in any missing fields on a loaded/imported deck so the UI never NPEs. */
function normalizeDeck(deck: Deck): Deck {
  const now = Date.now();
  return {
    id: typeof deck.id === 'string' && deck.id ? deck.id : nanoid(12),
    title: typeof deck.title === 'string' ? deck.title : 'Sans titre',
    themeId:
      typeof deck.themeId === 'string' && deck.themeId
        ? deck.themeId
        : DEFAULT_THEME_ID,
    slides: (Array.isArray(deck.slides) ? deck.slides : []).map(s =>
      emptySlide({
        id: typeof s?.id === 'string' ? s.id : nanoid(10),
        title: typeof s?.title === 'string' ? s.title : '',
        layout: (s?.layout as Slide['layout']) ?? 'title-bullets',
        bullets: Array.isArray(s?.bullets)
          ? s.bullets.filter(b => typeof b === 'string')
          : [],
        bulletsRight: Array.isArray(s?.bulletsRight)
          ? s.bulletsRight.filter(b => typeof b === 'string')
          : [],
        notes: typeof s?.notes === 'string' ? s.notes : '',
        imagePrompt: typeof s?.imagePrompt === 'string' ? s.imagePrompt : '',
        imageUrl: typeof s?.imageUrl === 'string' ? s.imageUrl : '',
      })
    ),
    createdAt: typeof deck.createdAt === 'number' ? deck.createdAt : now,
    updatedAt: typeof deck.updatedAt === 'number' ? deck.updatedAt : now,
  };
}
