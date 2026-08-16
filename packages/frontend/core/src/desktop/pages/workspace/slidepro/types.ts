// SlidePro — core data model. A deck is a list of slides plus a theme id; the
// whole thing is a plain JSON-serialisable object so it persists to localStorage
// and round-trips through the JSON export/import buttons unchanged.

/** The slide layouts the editor + renderer understand. Kept in sync with the
 *  backend SlideSpec union (clickdz-slidepro.controller.ts). */
export type SlideLayout =
  | 'title'
  | 'title-bullets'
  | 'two-column'
  | 'quote'
  | 'image-text';

export const SLIDE_LAYOUTS: SlideLayout[] = [
  'title',
  'title-bullets',
  'two-column',
  'quote',
  'image-text',
];

/** French labels for the layout picker (matches the surrounding UI language). */
export const LAYOUT_LABELS: Record<SlideLayout, string> = {
  title: 'Titre',
  'title-bullets': 'Titre + points',
  'two-column': 'Deux colonnes',
  quote: 'Citation',
  'image-text': 'Image + texte',
};

export interface Slide {
  /** Stable local id (nanoid) — the React key + reorder handle. */
  id: string;
  title: string;
  layout: SlideLayout;
  bullets: string[];
  /** Right column for the 'two-column' layout (ignored otherwise). */
  bulletsRight: string[];
  /** Speaker notes shown under the editor + in present mode's notes strip. */
  notes: string;
  /** A prompt used to (re)generate the slide image; kept so the user can edit
   *  + regenerate. Only meaningful for 'image-text'. */
  imagePrompt: string;
  /** The resolved image URL (remote https from the image API), if generated. */
  imageUrl: string;
}

export interface Deck {
  id: string;
  title: string;
  themeId: string;
  slides: Slide[];
  /** epoch ms — used to sort the deck list (most recent first). */
  createdAt: number;
  updatedAt: number;
}

/** A short, human summary row for the deck-list home screen. */
export interface DeckSummary {
  id: string;
  title: string;
  slideCount: number;
  themeId: string;
  updatedAt: number;
}

export function deckSummary(deck: Deck): DeckSummary {
  return {
    id: deck.id,
    title: deck.title,
    slideCount: deck.slides.length,
    themeId: deck.themeId,
    updatedAt: deck.updatedAt,
  };
}
