import { Body, Controller, Logger, Post } from '@nestjs/common';

import { Throttle } from '../../base';

/**
 * ClickDz Follow-up Suggestions — context-aware next-step chips.
 *
 * After the assistant answers, the client POSTs the user's question and the
 * answer here; a FAST model returns 3 follow-ups as { label, prompt } pairs.
 * The LABEL is the short French question shown on the chip (≤ ~9 words); the
 * PROMPT is a rich, self-contained French instruction that is what actually
 * gets sent when the chip is clicked — so the two are deliberately decoupled:
 * a terse scannable label, a fully-formed prompt that picks up where the last
 * turn left off. This mirrors the established pattern (Perplexity "Related",
 * Theo's follow_ups: [{label, prompt}]) the user asked us to research.
 *
 * AUTH STANCE: same first-party, session-gated stance as the pulse route — NOT
 * @Public(), so the global AuthGuard requires an authenticated session cookie.
 *
 * FAILURE STANCE (mirrors the pulse route ON PURPOSE): ALWAYS 200 with a
 * non-empty fallback array. Suggestions are a cosmetic convenience — a failed
 * suggestion call must never surface as a failed request in the chat UI. Every
 * failure mode (bad input, model down, slow model, unparseable output)
 * collapses to generic French fallbacks.
 *
 * ENGINE: same `CDZ_AI_KEY` + `cdz-flash` fast OpenAI-compatible model the
 * pulse route uses, with the same trailing-/v1 base-URL normalisation.
 */

// ---------------------------------------------------------------------------
// Engine config — read the SAME env consts the pulse / bridge controllers read.
// ---------------------------------------------------------------------------
const CDZ_AI_BASE_URL = (
  process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai'
)
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '');
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';
const CDZ_FAST_MODEL = 'cdz-flash';

// ---------------------------------------------------------------------------
// Bounds. question/answer are trimmed (not rejected — this route never errors).
// We ask for exactly 3 pairs and clamp hard so a misbehaving model can't
// return a wall of text to the chip row.
// ---------------------------------------------------------------------------
const MAX_FIELD_CHARS = 2_000;
const COUNT = 3;
const MAX_LABEL_CHARS = 72;
const MAX_PROMPT_CHARS = 320;
const MAX_TOKENS = 320;
const TEMPERATURE = 0.7;
const TIMEOUT_MS = 8_000;

export type FollowUp = { label: string; prompt: string };

/**
 * Generic French fallbacks — returned verbatim whenever the fast model is
 * unconfigured, slow, errors, or returns nothing usable. Labels are short
 * French questions; prompts are self-contained French instructions (they say
 * "this answer / this result" so they work even without the model's context).
 */
const FALLBACK: FollowUp[] = [
  {
    label: 'Approfondir avec des exemples ?',
    prompt:
      'Peux-tu approfondir cette réponse avec des exemples concrets et adaptés à mon activité ?',
  },
  {
    label: 'Transformer en plan d’action ?',
    prompt:
      'Transforme cette réponse en plan d’action clair, étape par étape, que je peux suivre.',
  },
  {
    label: 'Résumer en trois points ?',
    prompt: 'Résume cette réponse en trois points clés, simples et directs.',
  },
];

/** Build the system prompt for the fast suggestion model. */
function buildSystemPrompt(): string {
  return [
    'You generate follow-up suggestions for an AI workspace chat used by Algerian merchants (French-first).',
    `Given the user's question and the assistant's answer, produce exactly ${COUNT} follow-up suggestions as a JSON array of objects with "label" and "prompt" string fields.`,
    '"label": a SHORT French question (≤ 9 words) shown on a chip — scannable, natural, interrogative (e.g. "Approfondir avec un exemple ?").',
    '"prompt": a RICH, self-contained French instruction (1-2 sentences) that is what actually gets sent when the chip is clicked. It must fully stand alone and pick up where the answer left off (say "cette réponse" / "ce résultat" so it works without extra context).',
    'Make the three suggestions DISTINCT and genuinely useful: one that deepens, one that turns it into something actionable, one that reframes or simplifies.',
    'Ground every suggestion in what the answer actually contains — never invent features, numbers, or entities not present in the answer.',
    'Write EVERYTHING in French (labels and prompts).',
    'Output ONLY the JSON array, nothing else — no markdown fences, no commentary.',
  ].join('\n');
}

/** Clean a single string field: strip quotes/backticks, collapse space, cap. */
function cleanField(input: unknown, max: number): string {
  let s = typeof input === 'string' ? input : String(input ?? '');
  s = s.trim().replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length > max) s = s.slice(0, max).trim();
  return s;
}

/**
 * Defensive parse of the model output into clean FollowUp[]. Tries clean JSON,
 * fence-stripped JSON, and a sliced outermost [...]. Each item must yield BOTH
 * a non-empty label and prompt. Returns [] when nothing usable is present.
 */
function parseFollowUps(raw: string): FollowUp[] {
  const text = (raw ?? '').trim();
  if (!text) return [];

  const coerce = (value: unknown): FollowUp[] | null => {
    if (!Array.isArray(value)) return null;
    const out: FollowUp[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const label = cleanField((item as any).label, MAX_LABEL_CHARS);
      const prompt = cleanField((item as any).prompt, MAX_PROMPT_CHARS);
      if (label && prompt) out.push({ label, prompt });
      if (out.length >= COUNT) break;
    }
    return out.length ? out : null;
  };

  let arr: FollowUp[] | null = null;
  try {
    arr = coerce(JSON.parse(text));
  } catch {
    arr = null;
  }
  if (!arr) {
    const unfenced = text
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .trim();
    try {
      arr = coerce(JSON.parse(unfenced));
    } catch {
      arr = null;
    }
    if (!arr) {
      const start = unfenced.indexOf('[');
      const end = unfenced.lastIndexOf(']');
      if (start !== -1 && end > start) {
        try {
          arr = coerce(JSON.parse(unfenced.slice(start, end + 1)));
        } catch {
          arr = null;
        }
      }
    }
  }
  return arr ?? [];
}

@Controller()
export class ClickDzSuggestionsController {
  private readonly logger = new Logger(ClickDzSuggestionsController.name);

  /**
   * POST /api/v1/ai/suggestions
   * Body: { question: string, answer: string }
   * Returns: { suggestions: { label, prompt }[] } — ALWAYS 200, ≥1 item.
   */
  @Throttle('strict')
  @Post('/api/v1/ai/suggestions')
  async suggestions(@Body() body: unknown): Promise<{ suggestions: FollowUp[] }> {
    const payload = (body ?? {}) as Record<string, unknown>;
    const question =
      typeof payload.question === 'string'
        ? payload.question.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_CHARS)
        : '';
    const answer =
      typeof payload.answer === 'string'
        ? payload.answer.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_CHARS)
        : '';

    if (!CDZ_AI_KEY || !answer) {
      return { suggestions: FALLBACK };
    }

    try {
      const response = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CDZ_AI_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CDZ_FAST_MODEL,
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            {
              role: 'user',
              content: `Question: ${question || '(non fournie)'}\n\nAnswer: ${answer}`,
            },
          ],
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = data?.choices?.[0]?.message?.content;
      if (response.ok && typeof content === 'string' && content.trim()) {
        const parsed = parseFollowUps(content);
        if (parsed.length) {
          // Pad from the fallback so the row always has COUNT items.
          const merged = [...parsed];
          for (const extra of FALLBACK) {
            if (merged.length >= COUNT) break;
            if (!merged.some(f => f.label.toLowerCase() === extra.label.toLowerCase())) {
              merged.push(extra);
            }
          }
          return { suggestions: merged.slice(0, COUNT) };
        }
      }
    } catch {
      // network error, timeout, or JSON error → static fallback. Swallow it:
      // a failed suggestion call must never surface as a request failure.
      this.logger.debug?.(`[suggestions] fast model unavailable; serving fallback`);
    }
    return { suggestions: FALLBACK };
  }
}
