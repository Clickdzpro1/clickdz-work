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
const MAX_STUDIO_CHARS = 40;
const MAX_NICHE_CHARS = 200;
const MAX_TITLE_CHARS = 120;
const MAX_TITLES = 6;
const COUNT = 3;
const MAX_LABEL_CHARS = 72;
const MAX_PROMPT_CHARS = 320;
const MAX_TOKENS = 380;
const TEMPERATURE = 0.7;
const TIMEOUT_MS = 8_000;

export type FollowUp = { label: string; prompt: string };

/** Context the client may supply to ground follow-ups. All optional. */
interface FollowUpContext {
  studio?: string;
  niche?: string;
  lang?: string;
  recentTitles?: string[];
}

/**
 * Per-studio curated French fallbacks — returned verbatim whenever the fast
 * model is unconfigured, slow, errors, or returns nothing usable. Each set is
 * tailored to the active studio so a fallback is never obviously generic.
 */
const FALLBACKS: Record<string, FollowUp[]> = {
  apps: [
    {
      label: 'Améliorer la mise en page ?',
      prompt:
        'Améliore la mise en page de cette application : espacement, alignement et lisibilité sur mobile.',
    },
    {
      label: 'Ajouter un formulaire COD ?',
      prompt:
        'Ajoute un formulaire de commande à la livraison (nom, téléphone, wilaya) à cette page, avec validation simple.',
    },
    {
      label: 'Rendre ça plus convaincant ?',
      prompt:
        'Rends cette page plus convaincante : titre accrocheur, liste d’avantages et appel à l’action clair.',
    },
  ],
  vdz: [
    {
      label: 'Créer une variante de ce clip ?',
      prompt:
        'Crée une variante de ce résultat avec un angle différent ou un ton plus dynamique.',
    },
    {
      label: 'Ajouter une voix off ?',
      prompt:
        'Génère une courte voix off en français qui accompagne ce contenu vidéo.',
    },
    {
      label: 'Résumer en une accroche ?',
      prompt:
        'Résume l’essentiel de cette réponse en une accroche percutante de moins de 10 mots.',
    },
  ],
  voice: [
    {
      label: 'Réécrire avec un ton plus chaleureux ?',
      prompt:
        'Réécris ce texte avec un ton plus chaleureux et rassurante, adapté à un message client.',
    },
    {
      label: 'Transformer en spot 20s ?',
      prompt:
        'Transforme ce contenu en un spot audio de 20 secondes, dynamique et accrocheur.',
    },
    {
      label: 'Proposer une version plus courte ?',
      prompt:
        'Propose une version condensée de ce texte, en gardant l’essentiel, pour une lecture rapide.',
    },
  ],
  default: [
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
  ],
};

/** Human-readable description of a studio, for grounding the model. */
const STUDIO_BLURB: Record<string, string> = {
  apps: 'the ClickDz App Builder, where the merchant builds small web apps, sales pages and mini-shops (COD-friendly, French-first)',
  vdz: 'Vdz Studio, an AI video editor for short product ads, reels and promos (timeline, captions, voiceover)',
  voice: 'Voice Studio, a text-to-speech studio for narration, ads and voiceovers in French/Arabic',
  chat: 'the main AI chat, a general assistant for an Algerian merchant',
};

/** Pick the fallback set for a studio, falling back to default. */
function fallbackFor(studio: string): FollowUp[] {
  return FALLBACKS[studio] ?? FALLBACKS.default;
}

/** Normalise the incoming context envelope defensively. */
function readContext(body: Record<string, unknown>): FollowUpContext {
  const rawCtx =
    body.context && typeof body.context === 'object'
      ? (body.context as Record<string, unknown>)
      : body;
  const studio =
    typeof rawCtx.studio === 'string'
      ? rawCtx.studio.trim().toLowerCase().slice(0, MAX_STUDIO_CHARS)
      : '';
  const niche =
    typeof rawCtx.niche === 'string'
      ? rawCtx.niche.replace(/\s+/g, ' ').trim().slice(0, MAX_NICHE_CHARS)
      : '';
  const lang =
    typeof rawCtx.lang === 'string’ ? rawCtx.lang.trim().slice(0, 8) : '';
  const recentTitles = Array.isArray(rawCtx.recentTitles)
    ? rawCtx.recentTitles
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS))
        .filter(Boolean)
        .slice(0, MAX_TITLES)
    : [];
  return { studio, niche, lang, recentTitles };
}

/** Build the system prompt for the fast suggestion model. */
function buildSystemPrompt(ctx: FollowUpContext): string {
  const studio = ctx.studio || 'chat';
  const blurb = STUDIO_BLURB[studio] ?? STUDIO_BLURB.chat;
  const lines = [
    'You generate follow-up suggestions for an AI workspace chat used by Algerian merchants (French-first).',
    `The merchant is currently in ${blurb}.`,
    ctx.niche
      ? `Their business / niche is: "${ctx.niche}". Tailor every suggestion to this niche.`
      : 'Their niche is unknown — keep suggestions broadly useful for a small merchant.',
    ctx.recentTitles?.length
      ? `They recently worked on: ${ctx.recentTitles.map(t => '"’ + t + '"').join(', ')}. You may reference these.`
      : '',
    `Given the user’s question and the assistant’s answer, produce exactly ${COUNT} follow-up suggestions as a JSON array of objects with "label" and "prompt" string fields.`,
    '"label": a SHORT French question (9 words max) shown on a chip — scannable, natural, interrogative.',
    '"prompt": a RICH, self-contained French instruction (1-2 sentences) that is what actually gets sent when the chip is clicked. It must fully stand alone and pick up where the answer left off.',
    'Make the three suggestions DISTINCT and genuinely useful: one that deepens, one that turns it into something actionable, one that reframes or simplifies.',
    'Ground every suggestion in what the answer actually contains — never invent features, numbers, or entities not present.',
    'Write EVERYTHING in French (labels and prompts).',
    'Output ONLY the JSON array, nothing else — no markdown fences, no commentary.',
  ];
  return lines.filter(Boolean).join('\n');
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
   * Body: { question: string, answer: string, context?: { studio?, niche?, lang?, recentTitles? } }
   * Returns: { suggestions: { label, prompt }[] } — ALWAYS 200, >= 1 item.
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

    // Read context envelope (studio / niche / recentTitles / lang). Mirrors the
    // prompt-suggestions sibling so follow-ups are grounded in the same surface
    // metadata, not just raw Q/A.
    const ctx = readContext(payload);
    const studioKey = ctx.studio || 'default';
    const fallback = fallbackFor(studioKey);

    if (!CDZ_AI_KEY || !answer) {
      return { suggestions: fallback };
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
            { role: 'system', content: buildSystemPrompt(ctx) },
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
          // Pad from the studio fallback so the row always has COUNT items.
          const merged = [...parsed];
          for (const extra of fallback) {
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
      this.logger.debug?.(`[suggestions] fast model unavailable; serving ${studioKey} fallback`);
    }
    return { suggestions: fallback };
  }
}
