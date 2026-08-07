/**
 * CoursePro — course/curriculum generation prompt for cdz-ai.
 *
 * NET-NEW, ADDITIVE, EXPORT-ONLY. This module is SELF-CONTAINED (no runtime
 * dependencies, imports nothing from the bridge or the frontend) exactly like
 * the peer `clickdz-app-prompt.ts` / `clickdz-vdz-prompt.ts` modules. It defines
 * the branded, Algeria-aware system prompt + a per-request turn builder for the
 * CoursePro studio's "génère un cours" flow.
 *
 * WIRE-UP IS OPTIONAL: nothing imports these exports yet. A CoursePro controller
 * (gated by a `CDZ_COURSEPRO_ENABLED` flag, default OFF) would import
 * {@link COURSEPRO_SYSTEM_PROMPT} + {@link buildCourseProTurn} and forward them
 * to `${CDZ_AI_BASE_URL}/v1/chat/completions` (model `cdz-architect` for the
 * curriculum structure). Until then this file changes NO behavior.
 *
 * THE CONTRACT (why this file is the product): the model returns ONE strict,
 * machine-parsed JSON object describing a course tree. Prose or markdown fences
 * break the parse, so the prompt forbids them. The shape is:
 *
 *   {
 *     "title": string,
 *     "promise": string,               // the one-line learner outcome
 *     "modules": [
 *       {
 *         "title": string,
 *         "lessons": [
 *           { "title": string, "objective": string, "durationMin": number }
 *         ]
 *       }
 *     ]
 *   }
 *
 * A downstream controller would `JSON.parse` the raw text and validate the shape
 * before seeding it into the CoursePro workspace, exactly the fail-closed idiom
 * the Vdz prompt's JSON contract uses.
 */

// ---------------------------------------------------------------------------
// Bounds — advisory mirrors of the caps a CoursePro controller would enforce.
// ---------------------------------------------------------------------------

/** Max chars of the topic/brief a caller forwards into the turn. */
export const MAX_COURSEPRO_TOPIC_CHARS = 2_000;

/** Max chars of the free-text audience hint. */
export const MAX_COURSEPRO_AUDIENCE_CHARS = 400;

// ---------------------------------------------------------------------------
// Types — the shape of the per-request input a caller passes in. Kept local so
// this module stays dependency-free and unit-testable.
// ---------------------------------------------------------------------------

/** The target language for the generated course copy. `auto` = mirror input. */
export type CourseProLang = 'fr' | 'ar' | 'darija' | 'auto';

/** The pacing/format of the course. */
export type CourseProFormat = 'cohort' | 'self-paced' | 'micro';

/** The per-request input the controller assembles from the validated body. */
export interface CourseProInput {
  /** The course topic or a fuller brief. */
  topic: string;
  /** Who the course is for (e.g. "débutants, vendeurs e-commerce"). */
  audience: string;
  /** The learner transformation / promised outcome (optional). */
  transformation?: string;
  /** Pacing/format; drives module granularity. */
  format: CourseProFormat;
  /** Target language for the human-facing copy. */
  lang: CourseProLang;
}

// ---------------------------------------------------------------------------
// System prompt — the branded, Algeria-aware course designer persona.
// ---------------------------------------------------------------------------

export const COURSEPRO_SYSTEM_PROMPT = [
  'You are ClickDz CoursePro, a curriculum designer building online courses for',
  'an Algerian audience (learners, SMEs, and creators).',
  '',
  'LANGUAGE (Algeria — critical):',
  '- Write ALL human-facing copy (titles, objectives, promise) in the target',
  '  language the caller specifies. If the target is "auto", mirror the language',
  '  of the topic/brief. Support French, Modern Standard Arabic, and Algerian',
  '  Darija (spoken dialect, Arabic script — convert Latin "arabizi" to Arabic',
  '  script). Never default to English unless the brief itself is English.',
  '- Algeria context: DZD currency, local market examples, dd/mm dates. Keep',
  '  brand names and proper nouns verbatim.',
  '',
  'PEDAGOGY:',
  '- Structure the course as modules → lessons. Each lesson has ONE clear,',
  '  action-oriented learning objective and a realistic duration in minutes.',
  '- Order modules so each builds on the previous (scaffolding). Start concrete,',
  '  end with application.',
  '- Match granularity to the format: "micro" = 1-2 tight modules, short',
  '  lessons; "self-paced" = a full structured path; "cohort" = a path paced for',
  '  weekly live sessions.',
  '- Do NOT invent facts, certifications, or guarantees. Keep objectives honest.',
  '',
  'OUTPUT CONTRACT (STRICT — machine-parsed):',
  '- Return ONE JSON object and NOTHING else. No prose, no markdown, no code',
  '  fences, no comments.',
  '- Exact shape:',
  '  {',
  '    "title": string,',
  '    "promise": string,',
  '    "modules": [',
  '      { "title": string,',
  '        "lessons": [',
  '          { "title": string, "objective": string, "durationMin": number }',
  '        ]',
  '      }',
  '    ]',
  '  }',
  '- "durationMin" is a positive integer. All string fields are non-empty.',
].join('\n');

// ---------------------------------------------------------------------------
// Per-request builder — renders the validated input into the single user turn.
// ---------------------------------------------------------------------------

/**
 * Build the user turn for a CoursePro generation request. Pure +
 * dependency-free so it is trivially unit-testable and cannot drift from a
 * future controller.
 */
export function buildCourseProTurn(input: CourseProInput): string {
  const target =
    input.lang === 'auto'
      ? 'Match the language of the topic/brief.'
      : input.lang === 'darija'
        ? 'Write the course copy in Algerian Darija (Arabic script).'
        : input.lang === 'ar'
          ? 'Write the course copy in Modern Standard Arabic.'
          : 'Write the course copy in French.';

  const transformation = input.transformation
    ? `Promised learner outcome: ${input.transformation}.`
    : '';

  return [
    `FORMAT: ${input.format}`,
    `TARGET LANGUAGE: ${target}`,
    `AUDIENCE: ${input.audience || 'general learners'}`,
    transformation,
    '',
    'TOPIC / BRIEF:',
    input.topic,
    '',
    'Return ONLY the course JSON object described in the contract.',
  ]
    .filter(Boolean)
    .join('\n');
}
