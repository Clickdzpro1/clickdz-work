/**
 * Voice Studio — narration/script prompt for cdz-flash.
 *
 * This module is SELF-CONTAINED: it has no runtime dependencies and imports
 * nothing from the bridge controller or the frontend, exactly like the peer
 * `clickdz-vdz-prompt.ts` / `clickdz-app-prompt.ts` modules. The Voice AI
 * controller imports {@link VOICE_SCRIPT_SYSTEM_PROMPT} +
 * {@link buildVoiceScriptTurn} (and the analysis pair below) and forwards them
 * to the same cdz-ai `/v1/chat/completions` engine the Vdz dock uses.
 *
 * WHAT IT DOES: turns a rough brief into a spoken-ready narration script,
 * cleans a raw transcript, or condenses one — always in the operator's
 * language (French / Modern Standard Arabic / Algerian Darija), Algeria-aware,
 * and shaped for a text-to-speech read (short lines, natural breath points, a
 * words-per-second budget so the read fits a target runtime). The output is
 * PLAIN spoken text (no markdown, no JSON contract) — the controller returns it
 * verbatim as `{ script }`.
 */

// ---------------------------------------------------------------------------
// Bounds — advisory mirrors of the caps the Voice AI controller enforces on
// the /api/v1/voice/script route so the content we build never blows past what
// the upstream expects. The controller still validates the raw request itself.
// ---------------------------------------------------------------------------

/** Max chars of the input `text`/brief the controller forwards. */
export const MAX_VOICE_SCRIPT_INPUT_CHARS = 8_000;

/** Max chars of the free-text `tone` hint the controller forwards. */
export const MAX_VOICE_TONE_CHARS = 120;

/**
 * Max chars of an AI-analysis input transcript the controller forwards to
 * /api/v1/voice/analyze. A transcript is longer than a script brief (a full
 * meeting read), so this is more generous than the script-writer cap while
 * still bounding the model call.
 */
export const MAX_VOICE_ANALYSIS_INPUT_CHARS = 40_000;

/**
 * Approximate spoken words-per-second budgets by language, used only to render
 * an explicit length target into the turn when the caller passes `seconds`.
 * These are conservative broadcast-narration rates (a calm read), NOT a hard
 * contract — the model is told to treat the resulting word count as a target,
 * not a ceiling. French is slightly faster per second than Arabic script here.
 */
export const VOICE_WORDS_PER_SECOND: Record<VoiceScriptLang, number> = {
  fr: 2.3,
  ar: 2.0,
  darija: 2.0,
  auto: 2.2,
};

// ---------------------------------------------------------------------------
// Types — the shape of the per-turn input a caller passes in. Kept local (no
// import from the controller) so this module stays dependency-free.
// ---------------------------------------------------------------------------

/** The narration task the model performs on the input. */
export type VoiceScriptMode = 'write' | 'clean' | 'summarize';

/** The target spoken language. `auto` = mirror the input language. */
export type VoiceScriptLang = 'fr' | 'ar' | 'darija' | 'auto';

/** The per-turn input the controller assembles from the validated request. */
export interface VoiceScriptInput {
  /** write = expand a brief; clean = fix a transcript; summarize = condense. */
  mode: VoiceScriptMode;
  /** The brief (write) or the raw text/transcript (clean/summarize). */
  text: string;
  /** Target spoken language, or `auto` to mirror the input. */
  lang: VoiceScriptLang;
  /** Optional free-text tone/register hint (e.g. "energetic ad read"). */
  tone: string;
  /** Optional target duration in seconds → rendered as a word-count target. */
  seconds?: number;
}

// ---------------------------------------------------------------------------
// System prompt — the branded, Algeria-aware voice writer persona. Same
// discipline as the Vdz/App prompts: a single self-contained const the
// controller passes as the `system` message.
// ---------------------------------------------------------------------------

export const VOICE_SCRIPT_SYSTEM_PROMPT = [
  'You are the ClickDz Voice Studio script writer. You produce text meant to be',
  'READ ALOUD by a text-to-speech voice, for an Algerian audience.',
  '',
  'LANGUAGE (Algeria — critical):',
  '- Detect the language of the input: French, Modern Standard Arabic, or',
  '  Algerian Darija (Arabic script OR Latin "arabizi" like "salam, kifach,',
  '  wach, bezef", including the digit substitutions 3/7/9 for ع/ح/ق).',
  '- Write the OUTPUT in the SAME language the operator used, unless they set an',
  '  explicit target. For Darija, prefer natural spoken Darija in Arabic script',
  '  (the authentic Algerian dialect, not Modern Standard Arabic); convert',
  '  arabizi to clean Arabic script. Never answer in English unless the input',
  '  itself is English.',
  '- Numbers, prices and dates follow Algerian conventions: DZD currency,',
  '  dd/mm dates. Keep brand names and proper nouns verbatim.',
  '',
  'STYLE FOR TTS:',
  '- Short sentences. One idea per line. Natural breath points between lines.',
  '- No markdown, no bullet symbols, no emojis, no headings, and no stage',
  '  directions in brackets unless the operator explicitly asked for an emotion',
  '  track. Output ONLY the spoken words.',
  '- Punctuate for prosody: commas for short pauses, periods for full stops.',
  '- Prefer punchy, concrete lines over filler — this is a spoken read, not an',
  '  essay.',
  '',
  'MODES:',
  '- write: expand the brief into a complete narration script in the given tone.',
  '- clean: fix a raw transcript — punctuation, filler removal, paragraphing —',
  '  WITHOUT changing the meaning or inventing content.',
  '- summarize: condense the input into a tight spoken summary (~30% of the',
  '  length), keeping only what matters for a listener.',
  '',
  'Return ONLY the resulting spoken script text — no preamble, no explanation,',
  'no surrounding quotes.',
].join('\n');

// ---------------------------------------------------------------------------
// Per-turn builder — renders the validated input into the single `user` turn.
// ---------------------------------------------------------------------------

/**
 * Build the user turn for a voice-script request. Renders the mode, the target
 * language, an optional tone hint, an optional words-per-second-derived length
 * target, and the input text. Kept pure + dependency-free so it is trivially
 * unit-testable and cannot drift from the controller.
 */
export function buildVoiceScriptTurn(input: VoiceScriptInput): string {
  const target =
    input.lang === 'auto'
      ? 'Match the input language exactly.'
      : input.lang === 'darija'
        ? 'Write in Algerian Darija (natural spoken dialect, Arabic script).'
        : input.lang === 'ar'
          ? 'Write in Modern Standard Arabic.'
          : 'Write in French.';

  const tone = input.tone ? `Tone / register: ${input.tone}.` : '';

  // If a target duration is given, render a soft word-count target from the
  // per-language words-per-second budget so the read fits the runtime.
  let lengthTarget = '';
  if (typeof input.seconds === 'number' && input.seconds > 0) {
    const wps = VOICE_WORDS_PER_SECOND[input.lang] ?? VOICE_WORDS_PER_SECOND.auto;
    const targetWords = Math.max(1, Math.round(input.seconds * wps));
    lengthTarget =
      `Target length: about ${targetWords} spoken words ` +
      `(~${Math.round(input.seconds)}s read). Treat this as a target, not a hard ceiling.`;
  }

  return [
    `MODE: ${input.mode}`,
    `TARGET LANGUAGE: ${target}`,
    tone,
    lengthTarget,
    '',
    'INPUT:',
    input.text,
    '',
    'Return ONLY the resulting spoken script — no preamble, no explanation.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// AI ANALYSIS — turn a transcript into a structured read (summary + speakers).
//
// Consumed by POST /api/v1/voice/analyze (clickdz-voice-ai.controller.ts). The
// model returns { summary, speakers:[{name,lines}], language, sentiment? } as
// JSON — the controller parses it. Same Algeria-awareness discipline as the
// script writer.
// ---------------------------------------------------------------------------

export const ANALYSIS_SYSTEM_PROMPT = [
  'You are the ClickDz Voice Studio analyst. You read a voice transcript and',
  'produce a clear, structured analysis for an Algerian audience.',
  '',
  'LANGUAGE:',
  '- Detect the language of the transcript: French, Modern Standard Arabic, or',
  '  Algerian Darija (Arabic script OR Latin "arabizi" like "salam, kifach, wach,',
  '  bezef", including digit substitutions 3/7/9 for ع/ح/ق).',
  '- Write the summary and speaker names/lines in the SAME language as the',
  '  transcript. Keep Arabic script for Darija; never answer in English unless',
  '  the input itself is English.',
  '',
  'OUTPUT — a JSON object with exactly these fields (no markdown, no fences):',
  '- "summary": a concise paragraph (3-6 sentences) capturing the content, main',
  '  points and any decisions/next steps. Spoken, listener-friendly style.',
  '- "speakers": an array of { "name": string, "lines": string[] } — attribute',
  '  lines to distinct speakers when the transcript allows it (names like',
  '  "Locuteur 1", "Speaker A" are fine). When it is a single narration, return',
  '  one entry named "Narrateur"/"Narrador" with all lines.',
  '- "language": the detected language code: "fr", "ar", "darija" or "auto".',
  '- "sentiment" (optional): a short phrase sizing the overall tone (e.g.',
  '  "positif", "neutre", "préoccupé", "urgent"). Omit when unclear.',
  '',
  'Return ONLY the JSON — no preamble, no surrounding text.',
].join('\n');

/** The per-turn input for {@link buildVoiceAnalysisTurn}. */
export interface VoiceAnalysisInput {
  /** The transcript / text to analyze. */
  text: string;
  /** Optional language hint to steer detection ('fr'|'ar'|'darija'|'auto'). */
  lang?: VoiceScriptLang;
}

/**
 * Build the user turn for a voice-analysis request. The transcript text is
 * forwarded verbatim; an optional language hint steers detection without being
 * authoritative.
 */
export function buildVoiceAnalysisTurn(input: VoiceAnalysisInput): string {
  const langHint =
    input.lang && input.lang !== 'auto'
      ? `The operator believes the language is: ${input.lang}. Confirm from the text and use it if consistent.`
      : 'Detect the language from the text itself.';
  return [
    'ANALYZE THE FOLLOWING VOICE TRANSCRIPT:',
    langHint,
    '',
    input.text,
    '',
    'Return ONLY the JSON analysis object.',
  ]
    .filter(Boolean)
    .join('\n');
}
