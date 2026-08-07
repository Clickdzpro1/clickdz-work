/**
 * Language detection / routing helpers (additive, export-only).
 *
 * BACKGROUND: the only language detection in this codebase today is a private,
 * NON-exported `hasArabic(text)` inside `clickdz-bridge.controller.ts` (a bare
 * `/[؀-ۿ]/` test), used to route Arabic chat to the Arabic Make agent.
 * There is NO French/France branch — French (a first-class ClickDz language)
 * falls through to the default agent/model. That gap is flagged in
 * `audit/ai.md §7.5` ("only Arabic is detected/routed").
 *
 * This module ADDS a France/French branch WITHOUT touching the bridge or any
 * existing call site. It re-implements the Arabic test with the SAME semantics
 * as the bridge's `hasArabic` (so behavior is identical where a caller opts to
 * use it) and layers a light French heuristic + a small `detectDzLang` router
 * on top. It is safe to import from a NEW controller/route; it does not change
 * anything that already runs.
 *
 * SELF-CONTAINED: no runtime dependencies, imports nothing from the bridge or
 * the frontend, and is trivially unit-testable (pure functions only).
 */

/** The languages this router distinguishes. `und` = undetermined. */
export type DzLang = 'ar' | 'fr' | 'darija' | 'en' | 'und';

/**
 * Arabic-script presence test. IDENTICAL semantics to the bridge's private
 * `hasArabic` (a single-char match on the Arabic Unicode block U+0600–U+06FF),
 * re-exported here so a new caller can share the exact same signal the bridge
 * uses internally — without importing the untouchable bridge module.
 */
export function hasArabicScript(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}

/**
 * Latin "arabizi" (Latin-script Algerian Darija) markers: common spoken-Darija
 * tokens plus the digit substitutions Algerians use for Arabic phonemes
 * (3 → ع, 7 → ح, 9 → ق). Presence of these in otherwise-Latin text is a strong
 * Darija-in-Latin signal, distinct from plain French.
 */
const DARIJA_LATIN_MARKERS =
  /\b(wach|wech|kayen|kayn|makanch|makach|bezef|barcha|chwiya|labas|labes|kifach|kifah|3la|9bel|7na|rani|rak|raki|nta|nti|dyal|hna|khouya|khti|sa7a|saha|wesh)\b/i;

/**
 * French-language heuristic for otherwise-Latin text (no Arabic script). Uses a
 * small stopword/diacritic signal set — deliberately light (a heuristic, not a
 * classifier). It is only consulted AFTER Arabic script and Darija-in-Latin
 * have been ruled out, so it never mislabels Darija/Arabic as French.
 */
const FRENCH_MARKERS =
  /\b(le|la|les|un|une|des|du|de|et|est|vous|nous|je|tu|il|elle|pour|avec|sur|dans|pas|ne|plus|mais|ou|où|que|qui|quoi|comment|pourquoi|bonjour|salut|merci|s'il|svp|prix|livraison|commande|boutique|produit)\b/i;
/** French-specific accented characters — a cheap high-precision French signal. */
const FRENCH_DIACRITICS = /[àâäçéèêëîïôöùûüÿœ]/i;

/**
 * True when the text looks like French. Additive companion to
 * {@link hasArabicScript}: this is the France/French branch the bridge's
 * Arabic-only detection lacks. Arabic script (and Latin-Darija) short-circuit
 * to false so a mixed or Darija string is never misrouted as French.
 */
export function hasFrench(text: string): boolean {
  if (!text) return false;
  // Arabic script present ⇒ not the French branch (mirror the bridge's stance
  // that Arabic script wins routing).
  if (hasArabicScript(text)) return false;
  // Latin-script Darija wins over French so a Darija string routes to Darija.
  if (DARIJA_LATIN_MARKERS.test(text)) return false;
  return FRENCH_DIACRITICS.test(text) || FRENCH_MARKERS.test(text);
}

/**
 * Best-effort router over the three ClickDz-relevant registers plus English.
 * Precedence (first match wins), chosen so no signal misroutes a stronger one:
 *   1. Arabic script  → Darija if a Latin-Darija marker also appears, else 'ar'
 *      (Arabic script alone is Modern Standard Arabic; mixed script + Darija
 *      marker leans Darija).
 *   2. Latin Darija markers (no Arabic script) → 'darija'.
 *   3. French markers/diacritics → 'fr'.
 *   4. Any Latin letters at all → 'en' (a permissive English fallback).
 *   5. Otherwise → 'und'.
 *
 * This is a pure heuristic for OPTIONAL routing/steering by a NEW caller; it is
 * intentionally conservative and never throws. Existing call sites are
 * untouched — nothing in the shipped code path calls this yet.
 */
export function detectDzLang(text: string): DzLang {
  const t = (text || '').trim();
  if (!t) return 'und';
  if (hasArabicScript(t)) {
    return DARIJA_LATIN_MARKERS.test(t) ? 'darija' : 'ar';
  }
  if (DARIJA_LATIN_MARKERS.test(t)) return 'darija';
  if (hasFrench(t)) return 'fr';
  if (/[a-z]/i.test(t)) return 'en';
  return 'und';
}
