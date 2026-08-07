/**
 * Social+ — social-post composition prompt for cdz-ai.
 *
 * NET-NEW, ADDITIVE, EXPORT-ONLY. This module is SELF-CONTAINED (no runtime
 * dependencies, imports nothing from the bridge or the frontend) exactly like
 * the peer `clickdz-app-prompt.ts` / `clickdz-vdz-prompt.ts` modules. It defines
 * the branded, Algeria-aware system prompt + a per-request turn builder for the
 * Social+ studio's "génère des posts" flow.
 *
 * WIRE-UP IS OPTIONAL: nothing imports these exports yet. A Social+ controller
 * (gated by a `CDZ_SOCIALPLUS_ENABLED` flag, default OFF) would import
 * {@link SOCIALPLUS_SYSTEM_PROMPT} + {@link buildSocialPlusTurn} and forward
 * them to `${CDZ_AI_BASE_URL}/v1/chat/completions` (model `cdz-flash`, or a
 * polyglot model for AR/Darija-heavy briefs). Until then this file changes NO
 * behavior.
 *
 * THE CONTRACT (why this file is the product): the model returns ONE strict,
 * machine-parsed JSON ARRAY of post objects. Prose or markdown fences break the
 * parse, so the prompt forbids them. The shape is:
 *
 *   [
 *     {
 *       "platform": string,          // echoes the requested platform
 *       "caption": string,           // the post body, in the target language
 *       "hashtags": string[],        // 3-8 relevant tags (no leading spaces)
 *       "suggestedTime": string      // a human hint, e.g. "Jeu 19h"
 *     }
 *   ]
 *
 * A downstream controller would `JSON.parse` the raw text and validate the shape
 * before rendering the variants, exactly the fail-closed idiom the Vdz prompt's
 * JSON contract uses.
 */

// ---------------------------------------------------------------------------
// Bounds — advisory mirrors of the caps a Social+ controller would enforce.
// ---------------------------------------------------------------------------

/** Max chars of the brief a caller forwards into the turn. */
export const MAX_SOCIALPLUS_BRIEF_CHARS = 2_000;

/** Max chars of the free-text tone hint. */
export const MAX_SOCIALPLUS_TONE_CHARS = 120;

/** Hard ceiling on the number of post variants requested. */
export const MAX_SOCIALPLUS_VARIANTS = 10;

// ---------------------------------------------------------------------------
// Types — the shape of the per-request input a caller passes in. Kept local so
// this module stays dependency-free and unit-testable.
// ---------------------------------------------------------------------------

/** The target language for the generated posts. `auto` = mirror the brief. */
export type SocialPlusLang = 'fr' | 'ar' | 'darija' | 'auto';

/** A supported social platform (drives length/style conventions). */
export type SocialPlusPlatform =
  | 'facebook'
  | 'instagram'
  | 'tiktok'
  | 'x'
  | 'linkedin';

/** The per-request input the controller assembles from the validated body. */
export interface SocialPlusInput {
  /** The campaign brief or the product/offer to promote. */
  brief: string;
  /** The target platform; drives caption length + hashtag conventions. */
  platform: SocialPlusPlatform;
  /** How many post variants to produce. */
  count: number;
  /** Target language for the post copy. */
  lang: SocialPlusLang;
  /** Optional free-text tone hint (e.g. "casual, promo flash"). */
  tone: string;
}

// ---------------------------------------------------------------------------
// System prompt — the branded, Algeria-aware social marketer persona.
// ---------------------------------------------------------------------------

export const SOCIALPLUS_SYSTEM_PROMPT = [
  'You are ClickDz Social+, a social-media copywriter for Algerian merchants and',
  'creators. You write scroll-stopping posts that drive sales and engagement.',
  '',
  'LANGUAGE (Algeria — critical):',
  '- Write the post copy in the target language the caller specifies. If the',
  '  target is "auto", mirror the language of the brief. Support French, Modern',
  '  Standard Arabic, and Algerian Darija (natural spoken dialect — the register',
  '  Algerian buyers actually read on Facebook/Instagram/TikTok; convert Latin',
  '  "arabizi" to clean Arabic script for the caption body). Never default to',
  '  English unless the brief itself is English. Code-switching FR/Darija is',
  '  natural and welcome when it matches the audience.',
  '- Algeria context: DZD prices, local delivery (COD, wilaya), local couriers.',
  '  Keep brand names and proper nouns verbatim.',
  '',
  'PLATFORM CRAFT:',
  '- facebook: 1-3 short paragraphs, a clear CTA, an offer/price if given.',
  '- instagram: punchy hook first line, tight body, strong CTA.',
  '- tiktok: very short, hook-driven, casual spoken register.',
  '- x: one crisp line under ~240 chars.',
  '- linkedin: professional, value-led, minimal hashtags.',
  '- Every post has a clear call to action. Never invent prices, stock, or',
  '  guarantees not in the brief.',
  '',
  'HASHTAGS:',
  '- 3-8 relevant hashtags per post. No spaces inside a tag. Mix a couple of',
  '  Algeria/market tags with product/topic tags. Do NOT put the "#" prefix in',
  '  the array items — return the bare word (the client renders the "#").',
  '',
  'OUTPUT CONTRACT (STRICT — machine-parsed):',
  '- Return ONE JSON ARRAY and NOTHING else. No prose, no markdown, no code',
  '  fences, no comments.',
  '- Exactly one array element per requested variant.',
  '- Each element shape:',
  '  { "platform": string, "caption": string,',
  '    "hashtags": string[], "suggestedTime": string }',
  '- "caption" is non-empty and in the target language. "suggestedTime" is a',
  '  short human hint (e.g. "Jeu 19h", "السبت 20:00").',
].join('\n');

// ---------------------------------------------------------------------------
// Per-request builder — renders the validated input into the single user turn.
// ---------------------------------------------------------------------------

/**
 * Build the user turn for a Social+ generation request. Pure +
 * dependency-free so it is trivially unit-testable and cannot drift from a
 * future controller.
 */
export function buildSocialPlusTurn(input: SocialPlusInput): string {
  const target =
    input.lang === 'auto'
      ? 'Match the language of the brief.'
      : input.lang === 'darija'
        ? 'Write the posts in Algerian Darija (Arabic script).'
        : input.lang === 'ar'
          ? 'Write the posts in Modern Standard Arabic.'
          : 'Write the posts in French.';

  const tone = input.tone ? `Tone / register: ${input.tone}.` : '';

  return [
    `PLATFORM: ${input.platform}`,
    `VARIANTS: ${input.count}`,
    `TARGET LANGUAGE: ${target}`,
    tone,
    '',
    'BRIEF:',
    input.brief,
    '',
    'Return ONLY the JSON array of posts described in the contract.',
  ]
    .filter(Boolean)
    .join('\n');
}
