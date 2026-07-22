// ---------------------------------------------------------------------------
// ClickDz VPIC — i18n (R14, image-editor studio tab). The SINGLE source of
// truth for every user-facing string in the /vpic studio (page shell + language
// toggle, the editor toolbar — Recadrer / Rotation / Redimensionner /
// Ajustements / Filtres / Texte —, the AI section + generative-fill mask panel,
// Export, and the Projets save/open/delete flow).
//
// WHY this file exists: the VPIC surfaces must NOT hard-code UI copy (house
// rule). The studio is bilingual — French (default) + Algerian darja in Arabic
// script (RTL). Consumers (Easel/Wand/Pixel-adjacent UI) import `useVpicLang()`
// and call `t('vpic.crop')` instead of writing literals, so a single language
// switch flips the whole studio at once and RTL is applied for Arabic.
//
// This module MIRRORS `modules/agents/i18n.ts` mechanics 1:1 — the proven,
// dependency-free, provider-free pattern already shipped in the agents studio:
//
// DESIGN (house rules honored):
//   · ZERO new deps. Only `react` (useState/useEffect) — already everywhere.
//   · Boot-safe: no top-level throws, all storage access guarded (private mode /
//     SSR / disabled storage are non-fatal). Missing key FAILS SOFT — `t()`
//     returns the FR string if present, else the key itself. It NEVER throws.
//   · No React context / provider: the hook reads MODULE-LEVEL state and
//     subscribes to a module-level listener set, so any number of mounted
//     components (toolbar, mask panel, export bar…) re-render together on
//     setLang — no tree wrapping required. A `storage` event bridges other tabs.
//   · Interpolation is `{var}` style: `t('vpic.stockBy', { author: 'Ali' })`.
//
// `fr` = real image-editor French (Recadrer, Ajustements, Luminosité…). `ar` =
// short, commerce-appropriate Algerian darja in Arabic script (the everyday
// merchant register the agents studio + DZ shop pages already use — حل / امسح /
// عاود / كي نحمّلو …), kept concise because it renders inside a toolbar.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/** The two languages the VPIC studio speaks. FR is the default. */
export type VpicLang = 'fr' | 'ar';

/** A dotted string key into {@link VPIC_STRINGS} (all use the `vpic.` prefix). */
export type VpicStringKey = string;

/** Interpolation variables for `{var}` placeholders. Values are coerced to string. */
export type VpicTVars = Record<string, string | number>;

/** The translator function shape returned by {@link tFor} and exposed by the hook. */
export type VpicTFunc = (key: VpicStringKey, vars?: VpicTVars) => string;

// ---------------------------------------------------------------------------
// Storage + module-level reactive state (no provider).
// ---------------------------------------------------------------------------

/** localStorage key persisting the chosen language across reloads / tabs. */
export const VPIC_LANG_STORAGE_KEY = 'cdz:vpic-lang';

/** The default language when nothing is stored (or storage is unavailable). */
export const DEFAULT_VPIC_LANG: VpicLang = 'fr';

/** Human labels for a language toggle (FR button says "العربية", AR says "Français"). */
export const VPIC_LANG_LABELS: Record<VpicLang, string> = {
  fr: 'Français',
  ar: 'العربية',
};

/** Coerce any loose value to a known {@link VpicLang} (defaults to FR). */
export function coerceLang(v: unknown): VpicLang {
  return v === 'ar' ? 'ar' : 'fr';
}

/** Text direction for a language — 'rtl' for Arabic, 'ltr' otherwise. */
export function dirFor(lang: VpicLang): 'ltr' | 'rtl' {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

// Guarded storage helpers — private mode / SSR / disabled storage are non-fatal.
function readStoredLang(): VpicLang {
  try {
    const raw = globalThis.localStorage?.getItem(VPIC_LANG_STORAGE_KEY);
    return coerceLang(raw);
  } catch {
    return DEFAULT_VPIC_LANG;
  }
}

function writeStoredLang(lang: VpicLang): void {
  try {
    globalThis.localStorage?.setItem(VPIC_LANG_STORAGE_KEY, lang);
  } catch {
    // Non-fatal: the in-memory module state still drives this session.
  }
}

// Module-level current language. Seeded from storage at import time (guarded).
let currentLang: VpicLang = readStoredLang();

// Module-level subscriber set: every mounted component's hook registers a
// listener so a single setLang() re-renders them all — the provider-free
// broadcast. A plain Set keeps it dependency-free.
const listeners = new Set<(lang: VpicLang) => void>();

function emit(lang: VpicLang): void {
  for (const fn of Array.from(listeners)) {
    try {
      fn(lang);
    } catch {
      // A misbehaving subscriber must never break the broadcast to the rest.
    }
  }
}

// Bridge other tabs / windows: a `storage` event for our key updates the
// module state + notifies local subscribers. Registered once, guarded.
let storageBridgeArmed = false;
function armStorageBridge(): void {
  if (storageBridgeArmed) return;
  storageBridgeArmed = true;
  try {
    globalThis.addEventListener?.('storage', (e: StorageEvent) => {
      if (e.key !== VPIC_LANG_STORAGE_KEY) return;
      const next = coerceLang(e.newValue);
      if (next === currentLang) return;
      currentLang = next;
      emit(next);
    });
  } catch {
    // No window / addEventListener (SSR) — single-tab reactivity still works.
  }
}
armStorageBridge();

/** Read the current VPIC-studio language (module state; SSR-safe). */
export function getVpicLang(): VpicLang {
  return currentLang;
}

/**
 * Set the VPIC-studio language: persist to localStorage, update module state,
 * and notify every mounted hook so the whole studio re-renders. Pure side-effect
 * (no return); a no-op broadcast is skipped when the value is unchanged.
 */
export function setVpicLang(lang: VpicLang): void {
  const next = coerceLang(lang);
  writeStoredLang(next);
  if (next === currentLang) return;
  currentLang = next;
  emit(next);
}

// ---------------------------------------------------------------------------
// Interpolation — pure `{var}` replacement.
// ---------------------------------------------------------------------------

/** Replace `{name}` placeholders in `template` from `vars` (missing → left as-is). */
export function interpolate(template: string, vars?: VpicTVars): string {
  if (!vars || typeof template !== 'string' || template.indexOf('{') === -1) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

// ---------------------------------------------------------------------------
// The pure translator.
// ---------------------------------------------------------------------------

/**
 * Build a pure translator for `lang`. Fail-soft: an unknown key returns the FR
 * string when the entry exists but lacks the language, else the key itself —
 * it NEVER throws, so a missing key can only ever degrade to readable text.
 */
export function tFor(lang: VpicLang): VpicTFunc {
  const safeLang = coerceLang(lang);
  return (key: VpicStringKey, vars?: VpicTVars): string => {
    const entry = VPIC_STRINGS[key];
    if (!entry) {
      // Unknown key: return the key so a typo is visible but never fatal.
      return key;
    }
    // Prefer the requested language; fall back to FR; finally the key.
    const raw = (safeLang === 'ar' ? entry.ar : entry.fr) || entry.fr || key;
    return interpolate(raw, vars);
  };
}

// ---------------------------------------------------------------------------
// The hook. Reads module state, subscribes for cross-component re-render.
// ---------------------------------------------------------------------------

export interface UseVpicLang {
  /** The active language. */
  lang: VpicLang;
  /** Switch language (persists + broadcasts to every mounted hook). */
  setLang: (lang: VpicLang) => void;
  /** Translator bound to `lang` (interpolates `{var}`; fail-soft). */
  t: VpicTFunc;
  /** Text direction — 'rtl' for Arabic, 'ltr' otherwise. */
  dir: 'ltr' | 'rtl';
}

/**
 * React hook exposing `{ lang, setLang, t, dir }`. Provider-free: it seeds from
 * the module-level current language and registers a listener so `setLang` from
 * ANY component (or another tab, via the storage bridge) re-renders every mount.
 * The listener is torn down on unmount. `t` is rebuilt per-render bound to the
 * current language (cheap — it closes over the static table).
 *
 * NOTE: the R14 contract pins `{ lang, setLang, t }`; we return a superset that
 * also includes `dir` (matching the agents hook) — consumers may ignore it and
 * call the standalone {@link dirFor} instead. Superset is contract-safe.
 */
export function useVpicLang(): UseVpicLang {
  const [lang, setLangState] = useState<VpicLang>(currentLang);

  useEffect(() => {
    // Subscribe. If the module language changed between initial render and this
    // effect (a fast race), sync immediately so we never show a stale language.
    const listener = (next: VpicLang) => setLangState(next);
    listeners.add(listener);
    if (currentLang !== lang) setLangState(currentLang);
    return () => {
      listeners.delete(listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    lang,
    setLang: setVpicLang,
    t: tFor(lang),
    dir: dirFor(lang),
  };
}

// ---------------------------------------------------------------------------
// THE STRING CATALOGUE.
//
// fr = real image-editor French (Recadrer, Ajustements, Luminosité, Contraste,
// Saturation, Chaleur, Filtres, Remplissage génératif, Détourage du fond,
// Agrandir, Exporter…). ar = short, commerce-appropriate Algerian darja in
// Arabic script — the same everyday merchant register the agents studio uses
// (حل / امسح / عاود / كي نحمّلو …). Kept concise: these render in a toolbar.
//
// Keys are the EXACT set pinned in R14-CONTRACT §"Pinned i18n keys" — consumers
// use ONLY these. Interpolation uses `{var}`.
// ---------------------------------------------------------------------------

export interface VpicStringPair {
  fr: string;
  ar: string;
}

export const VPIC_STRINGS: Record<string, VpicStringPair> = {
  // ── page shell / header ───────────────────────────────────────────────────
  'vpic.title': { fr: 'Éditeur photo', ar: 'محرّر الصور' },
  'vpic.subtitle': {
    fr: 'Retouchez vos photos produits — recadrez, ajustez, exportez.',
    ar: 'صلّح تصاور المنتوجات تاعك — قصّ، عدّل، و صدّر.',
  },
  'vpic.language': { fr: 'Langue', ar: 'اللغة' },

  // ── open / import an image ────────────────────────────────────────────────
  'vpic.open': { fr: 'Ouvrir une image', ar: 'حل صورة' },
  'vpic.newImage': { fr: 'Nouvelle image', ar: 'صورة جديدة' },
  'vpic.upload': { fr: 'Importer', ar: 'حمّل' },
  'vpic.dropHere': { fr: 'Déposez une image ici', ar: 'أرمي الصورة هنا' },
  'vpic.paste': { fr: 'Coller', ar: 'الصق' },
  'vpic.stock': { fr: 'Banque d’images', ar: 'مكتبة الصور' },
  'vpic.stockSearch': { fr: 'Rechercher une image…', ar: 'قلّب على صورة…' },
  'vpic.stockBy': { fr: 'par {author}', ar: 'تاع {author}' },
  'vpic.generate': { fr: 'Générer', ar: 'ولّد' },

  // ── crop (Recadrer) + presets ─────────────────────────────────────────────
  'vpic.crop': { fr: 'Recadrer', ar: 'قصّ' },
  'vpic.cropFree': { fr: 'Libre', ar: 'حر' },
  'vpic.cropSquare': { fr: 'Carré 1:1', ar: 'مربّع 1:1' },
  'vpic.crop45': { fr: 'Portrait 4:5', ar: 'طولي 4:5' },
  'vpic.cropStory': { fr: 'Story 9:16', ar: 'ستوري 9:16' },
  'vpic.cropWide': { fr: 'Large 16:9', ar: 'عريض 16:9' },
  'vpic.cropListing': { fr: 'Annonce 4:3', ar: 'إعلان 4:3' },

  // ── rotation / mirror ─────────────────────────────────────────────────────
  'vpic.rotateL': { fr: 'Pivoter à gauche', ar: 'دوّر لليسار' },
  'vpic.rotateR': { fr: 'Pivoter à droite', ar: 'دوّر لليمين' },
  'vpic.flipH': { fr: 'Miroir horizontal', ar: 'قلب أفقي' },
  'vpic.flipV': { fr: 'Miroir vertical', ar: 'قلب عمودي' },

  // ── resize (Redimensionner) ───────────────────────────────────────────────
  'vpic.resize': { fr: 'Redimensionner', ar: 'بدّل القياس' },
  'vpic.width': { fr: 'Largeur', ar: 'العرض' },
  'vpic.height': { fr: 'Hauteur', ar: 'الطول' },

  // ── generic actions (shared across toolbar sections) ──────────────────────
  'vpic.apply': { fr: 'Appliquer', ar: 'طبّق' },
  'vpic.cancel': { fr: 'Annuler', ar: 'ألغِ' },
  'vpic.close': { fr: 'Fermer', ar: 'سكّر' },
  'vpic.undo': { fr: 'Annuler', ar: 'ارجع' },
  'vpic.redo': { fr: 'Rétablir', ar: 'عاود' },
  'vpic.reset': { fr: 'Réinitialiser', ar: 'رجّع كيما كان' },

  // ── adjustments (Ajustements) ─────────────────────────────────────────────
  'vpic.adjust': { fr: 'Ajustements', ar: 'التعديلات' },
  'vpic.brightness': { fr: 'Luminosité', ar: 'الضوء' },
  'vpic.contrast': { fr: 'Contraste', ar: 'التباين' },
  'vpic.saturation': { fr: 'Saturation', ar: 'وضوح اللون' },
  'vpic.warmth': { fr: 'Chaleur', ar: 'الحرارة' },

  // ── filters (Filtres) — 7 chips ───────────────────────────────────────────
  'vpic.filters': { fr: 'Filtres', ar: 'الفلاتر' },
  'vpic.filterNone': { fr: 'Aucun', ar: 'بلا' },
  'vpic.filterBw': { fr: 'Noir & blanc', ar: 'بيان و كحل' },
  'vpic.filterVivid': { fr: 'Éclatant', ar: 'زاهي' },
  'vpic.filterSoft': { fr: 'Doux', ar: 'ناعم' },
  'vpic.filterWarm': { fr: 'Chaud', ar: 'دافي' },
  'vpic.filterCool': { fr: 'Froid', ar: 'بارد' },
  'vpic.filterProduct': { fr: 'Produit', ar: 'منتوج' },

  // ── text overlays (Texte) ─────────────────────────────────────────────────
  'vpic.text': { fr: 'Texte', ar: 'الكتابة' },
  'vpic.addText': { fr: 'Ajouter du texte', ar: 'زيد كتابة' },
  'vpic.textPlaceholder': { fr: 'Votre texte…', ar: 'الكتابة تاعك…' },
  'vpic.fontSize': { fr: 'Taille', ar: 'الحجم' },
  'vpic.color': { fr: 'Couleur', ar: 'اللون' },
  'vpic.bold': { fr: 'Gras', ar: 'غليظ' },
  'vpic.align': { fr: 'Alignement', ar: 'المحاذاة' },
  'vpic.posX': { fr: 'Position X', ar: 'الموضع أفقي' },
  'vpic.posY': { fr: 'Position Y', ar: 'الموضع عمودي' },
  'vpic.deleteText': { fr: 'Supprimer', ar: 'امسح' },

  // ── AI section ────────────────────────────────────────────────────────────
  'vpic.ai': { fr: 'IA', ar: 'الذكاء الاصطناعي' },
  'vpic.genFill': { fr: 'Remplissage génératif', ar: 'تعمير ذكي' },
  'vpic.genFillHint': {
    fr: 'Peignez une zone puis décrivez ce qui doit la remplacer.',
    ar: 'لوّن بلاصة و وصّف واش تبدّلها بيه.',
  },
  'vpic.maskPaint': { fr: 'Peindre la zone', ar: 'لوّن البلاصة' },
  'vpic.maskClear': { fr: 'Effacer le masque', ar: 'مسح القناع' },
  'vpic.brushSize': { fr: 'Taille du pinceau', ar: 'حجم الفرشة' },
  'vpic.fillPrompt': { fr: 'Décrivez le résultat…', ar: 'وصّف واش تحب يطلع…' },
  'vpic.fillGo': { fr: 'Remplir', ar: 'عمّر' },
  'vpic.working': { fr: 'Traitement…', ar: 'كي نخدمو…' },
  'vpic.bgRemove': { fr: 'Détourage du fond', ar: 'حيّد الخلفية' },
  'vpic.upscale': { fr: 'Agrandir', ar: 'كبّر' },
  'vpic.comingSoon': { fr: 'Bientôt disponible', ar: 'جاي قريب' },

  // ── export ────────────────────────────────────────────────────────────────
  'vpic.export': { fr: 'Exporter', ar: 'صدّر' },
  'vpic.format': { fr: 'Format', ar: 'الصيغة' },
  'vpic.quality': { fr: 'Qualité', ar: 'الجودة' },
  'vpic.download': { fr: 'Télécharger', ar: 'تحميل' },
  'vpic.saveToWorkspace': { fr: 'Enregistrer dans l’espace', ar: 'احفظ ف الفضاء' },
  'vpic.savedOk': { fr: 'Enregistré ✓', ar: 'تحفظ ✓' },

  // ── projects (Projets) ────────────────────────────────────────────────────
  'vpic.projects': { fr: 'Projets', ar: 'المشاريع' },
  'vpic.saveProject': { fr: 'Enregistrer le projet', ar: 'احفظ المشروع' },
  'vpic.projectName': { fr: 'Nom du projet', ar: 'اسم المشروع' },
  'vpic.myProjects': { fr: 'Mes projets', ar: 'المشاريع تاعي' },
  'vpic.openProject': { fr: 'Ouvrir', ar: 'حل' },
  'vpic.deleteProject': { fr: 'Supprimer', ar: 'امسح' },
  'vpic.emptyProjects': {
    fr: 'Aucun projet enregistré. Enregistrez votre montage pour le retrouver ici.',
    ar: 'ما كاش مشاريع محفوظة. احفظ خدمتك باش تلقاها هنا.',
  },

  // ── generic states / errors ───────────────────────────────────────────────
  'vpic.loading': { fr: 'Chargement…', ar: 'كي نحمّلو…' },
  'vpic.error': { fr: 'Une erreur est survenue.', ar: 'صرا مشكل.' },
  'vpic.retry': { fr: 'Réessayer', ar: 'عاود' },
  'vpic.aiUnavailable': {
    fr: 'Les outils IA ne sont pas activés sur ce serveur.',
    ar: 'أدوات الذكاء الاصطناعي ماشي مفعّلة على هاد السيرفور.',
  },
  'vpic.imageTooLarge': {
    fr: 'Image trop lourde. Choisissez-en une plus petite.',
    ar: 'الصورة كبيرة بزّاف. اختار وحدة أصغر.',
  },

  // ── gated-off (flag OFF) friendly state ───────────────────────────────────
  'vpic.gatedOffTitle': { fr: 'L’éditeur photo n’est pas activé', ar: 'محرّر الصور ماشي مفعّل' },
  'vpic.gatedOffBody': {
    fr: 'Cette fonctionnalité est désactivée sur ce serveur. Revenez plus tard — vos photos vous attendront ici.',
    ar: 'هاد الخاصية مطفية على هاد السيرفور. ارجع من بعد — تصاورك يستناوك هنا.',
  },

  // ── discard-changes confirm ───────────────────────────────────────────────
  'vpic.confirmDiscard': {
    fr: 'Abandonner les modifications non enregistrées ?',
    ar: 'تحيّد التعديلات اللي ما تحفظاتش ؟',
  },
};

// Default export: the pure translator factory (most common consumer import
// besides the hook), plus everything else via named exports above.
export default tFor;
