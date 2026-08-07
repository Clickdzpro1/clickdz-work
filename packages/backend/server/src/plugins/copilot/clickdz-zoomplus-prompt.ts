/**
 * ZOOM+ — meeting-summary prompt for cdz-ai.
 *
 * NET-NEW, ADDITIVE, EXPORT-ONLY. This module is SELF-CONTAINED (no runtime
 * dependencies, imports nothing from the bridge or the frontend) exactly like
 * the peer `clickdz-app-prompt.ts` / `clickdz-vdz-prompt.ts` modules. It defines
 * the branded, Algeria-aware system prompt + a per-request turn builder for the
 * ZOOM+ studio's post-call "résumé de réunion" flow.
 *
 * WIRE-UP IS OPTIONAL: nothing imports these exports yet. A ZOOM+ controller
 * (gated by a `CDZ_ZOOMPLUS_ENABLED` flag, default OFF) would import
 * {@link ZOOMPLUS_SUMMARY_SYSTEM_PROMPT} + {@link buildZoomPlusSummaryTurn} and
 * forward them to `${CDZ_AI_BASE_URL}/v1/chat/completions` (model
 * `cdz-architect` for a structured summary over a transcript). Until then this
 * file changes NO behavior.
 *
 * THE CONTRACT (why this file is the product): the model returns ONE strict,
 * machine-parsed JSON object summarizing a meeting transcript. Prose or markdown
 * fences break the parse, so the prompt forbids them. The shape is:
 *
 *   {
 *     "summary": string,               // a short paragraph in the target lang
 *     "decisions": string[],           // key decisions made
 *     "actionItems": [
 *       { "owner": string, "task": string }
 *     ],
 *     "nextSteps": string[]            // follow-ups / open questions
 *   }
 *
 * A downstream controller would `JSON.parse` the raw text and validate the shape
 * before rendering the structured sections, exactly the fail-closed idiom the
 * Vdz prompt's JSON contract uses.
 */

// ---------------------------------------------------------------------------
// Bounds — advisory mirrors of the caps a ZOOM+ controller would enforce. A
// transcript can be large; the controller is expected to cap/trim it before it
// reaches the model (this const documents the intended ceiling).
// ---------------------------------------------------------------------------

/** Max chars of the transcript a caller inlines into the turn. */
export const MAX_ZOOMPLUS_TRANSCRIPT_CHARS = 60_000;

// ---------------------------------------------------------------------------
// Types — the shape of the per-request input a caller passes in. Kept local so
// this module stays dependency-free and unit-testable.
// ---------------------------------------------------------------------------

/** The target language for the summary. `auto` = mirror the transcript. */
export type ZoomPlusLang = 'fr' | 'ar' | 'darija' | 'auto';

/** The per-request input the controller assembles from the validated body. */
export interface ZoomPlusSummaryInput {
  /** The meeting transcript text (already capped/trimmed by the caller). */
  transcript: string;
  /** Target language for the summary copy. */
  lang: ZoomPlusLang;
  /** Optional meeting title/context to steer the summary. */
  title?: string;
}

// ---------------------------------------------------------------------------
// System prompt — the branded, Algeria-aware meeting analyst persona.
// ---------------------------------------------------------------------------

export const ZOOMPLUS_SUMMARY_SYSTEM_PROMPT = [
  'You are ClickDz ZOOM+, a meeting analyst. Given a meeting transcript, you',
  'produce a tight, faithful summary for an Algerian team.',
  '',
  'LANGUAGE (Algeria — critical):',
  '- Write the summary in the target language the caller specifies. If the',
  '  target is "auto", mirror the dominant language of the transcript. Support',
  '  French, Modern Standard Arabic, and Algerian Darija (spoken dialect, Arabic',
  '  script — convert Latin "arabizi" to Arabic script). Never default to',
  '  English unless the transcript itself is English.',
  '- Algeria context: DZD amounts, dd/mm dates, local names/places kept verbatim.',
  '',
  'FAITHFULNESS:',
  '- Ground EVERYTHING strictly in the transcript. Never invent decisions,',
  '  owners, numbers, or action items that were not actually discussed.',
  '- If an action item has no clear owner in the transcript, use an empty string',
  '  for "owner" rather than guessing a name.',
  '- Keep the summary concise: the key points a participant would want to recall,',
  '  not a line-by-line replay.',
  '',
  'OUTPUT CONTRACT (STRICT — machine-parsed):',
  '- Return ONE JSON object and NOTHING else. No prose, no markdown, no code',
  '  fences, no comments.',
  '- Exact shape:',
  '  {',
  '    "summary": string,',
  '    "decisions": string[],',
  '    "actionItems": [ { "owner": string, "task": string } ],',
  '    "nextSteps": string[]',
  '  }',
  '- Arrays may be empty when the transcript has nothing for them. "summary" is',
  '  a non-empty short paragraph in the target language.',
].join('\n');

// ---------------------------------------------------------------------------
// Per-request builder — renders the validated input into the single user turn.
// ---------------------------------------------------------------------------

/**
 * Build the user turn for a ZOOM+ meeting-summary request. Pure +
 * dependency-free so it is trivially unit-testable and cannot drift from a
 * future controller.
 */
export function buildZoomPlusSummaryTurn(input: ZoomPlusSummaryInput): string {
  const target =
    input.lang === 'auto'
      ? 'Match the dominant language of the transcript.'
      : input.lang === 'darija'
        ? 'Write the summary in Algerian Darija (Arabic script).'
        : input.lang === 'ar'
          ? 'Write the summary in Modern Standard Arabic.'
          : 'Write the summary in French.';

  const title = input.title ? `MEETING: ${input.title}` : '';

  return [
    title,
    `TARGET LANGUAGE: ${target}`,
    '',
    'TRANSCRIPT:',
    input.transcript,
    '',
    'Return ONLY the meeting-summary JSON object described in the contract.',
  ]
    .filter(Boolean)
    .join('\n');
}
