import { Body, Controller, Logger, Post } from '@nestjs/common';

import { Throttle } from '../../base';

/**
 * ClickDz Prompt Suggestions — context-aware PRE-answer starter chips.
 *
 * The sibling of clickdz-suggestions.controller.ts (post-answer follow-ups):
 * where that route grounds chips in the question + answer of a settled turn,
 * this route grounds STARTER chips in the surface the merchant is currently
 * standing in (which studio, what they recently built, their niche, their
 * language) — BEFORE they have typed anything. It powers the empty-state chip
 * rows on the chat composer, the Vdz quick-actions popover and the Voice
 * Studio, replacing (as an upgrade over, never a hard dependency on) the static
 * FR starter arrays those surfaces ship with.
 *
 * AUTH STANCE: same first-party, session-gated stance as the suggestions /
 * pulse routes — NOT @Public(), so the global AuthGuard requires an
 * authenticated session cookie.
 *
 * FAILURE STANCE (mirrors the suggestions route ON PURPOSE): ALWAYS 200 with a
 * non-empty fallback array. Starter chips are a cosmetic convenience — a failed
 * call must never surface as a failed request in a studio UI. Every failure
 * mode (bad input, model down, slow model, unparseable output) collapses to
 * per-studio generic French fallbacks, so the caller can safely treat this as
 * "upgrade my static array if you can, otherwise I already have one".
 *
 * ENGINE: same `CDZ_AI_KEY` + `cdz-flash` fast OpenAI-compatible model the
 * suggestions / pulse routes use, with the same trailing-/v1 base-URL
 * normalisation.
 */

// ---------------------------------------------------------------------------
// Engine config — read the SAME env consts the suggestions / pulse controllers
// read (kept literally identical so all three fast-model routes stay in step).
// ---------------------------------------------------------------------------
// WS14: the Vercel AI Gateway — the same env pair the bridge reads (the
// legacy CDZ_AI_BASE_URL/CDZ_AI_KEY api.clickdz.ai pair is deliberately
// not read; a legacy key fails Gateway auth looking like a model error).
const CDZ_AI_BASE_URL = (
  process.env.CDZ_AI_GATEWAY_BASE || 'https://ai-gateway.vercel.sh'
)
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '');
const CDZ_AI_KEY =
  process.env.CDZ_AI_GATEWAY_KEY || process.env.CUSTOM_LLM_API_KEY || '';
// WS14 default: the Gateway single chat model. NOTE: this is a bare literal
// (no env-override on this route) — unset any legacy value elsewhere.
const CDZ_FAST_MODEL = 'alibaba/qwen3.7-flash';

// ---------------------------------------------------------------------------
// Bounds. Context fields are trimmed (never rejected — this route never
// errors). We ask for up to 4 pairs and clamp hard so a misbehaving model can't
// return a wall of text to a chip row.
// ---------------------------------------------------------------------------
const MAX_STUDIO_CHARS = 40;
const MAX_NICHE_CHARS = 200;
const MAX_TITLE_CHARS = 120;
const MAX_TITLES = 6;
const COUNT = 4;
const MAX_LABEL_CHARS = 72;
const MAX_PROMPT_CHARS = 320;
const MAX_TOKENS = 380;
const TEMPERATURE = 0.8;
const TIMEOUT_MS = 8_000;

export type PromptSuggestion = { label: string; prompt: string };

/** Incoming context the caller may supply — every field optional. */
interface SuggestionContext {
  studio?: string;
  recentTitles?: string[];
  niche?: string;
  lang?: string;
}

/**
 * Per-studio generic French fallbacks — returned verbatim whenever the fast
 * model is unconfigured, slow, errors, or returns nothing usable. Labels are
 * short French starter chips; prompts are self-contained French instructions
 * that stand alone. `default` covers any studio the map doesn't name (and the
 * generic chat composer). These deliberately echo the good static arrays the
 * client surfaces already ship, so a fallback is never a downgrade.
 */
const FALLBACKS: Record<string, PromptSuggestion[]> = {
  apps: [
    {
      label: 'Une page de vente COD',
      prompt:
        'Crée une page de vente en français avec un formulaire de commande à la livraison (COD) : nom, téléphone, wilaya et bouton de commande.',
    },
    {
      label: 'Une boutique simple',
      prompt:
        'Crée une petite boutique en ligne avec une grille de produits, un panier et un bouton WhatsApp pour commander.',
    },
    {
      label: 'Un formulaire de contact',
      prompt:
        'Crée un formulaire de contact clair et moderne, adapté au mobile, avec validation des champs.',
    },
    {
      label: 'Une landing page produit',
      prompt:
        'Crée une landing page pour présenter un produit : titre accrocheur, avantages, avis clients et appel à l’action.',
    },
  ],
  vdz: [
    {
      label: 'Une pub produit courte',
      prompt:
        'Aide-moi à monter une courte vidéo publicitaire pour mon produit : accroche, présentation et appel à l’action.',
    },
    {
      label: 'Ajouter des sous-titres',
      prompt:
        'Ajoute des sous-titres lisibles et bien synchronisés à ma vidéo, avec un style adapté au mobile.',
    },
    {
      label: 'Un fond animé propre',
      prompt:
        'Ajoute un arrière-plan animé sobre derrière mes clips pour un rendu plus professionnel.',
    },
    {
      label: 'Une intro de marque',
      prompt:
        'Crée une intro de marque de quelques secondes avec mon logo, un titre et une transition soignée.',
    },
  ],
  voice: [
    {
      label: 'Un spot radio 20s',
      prompt:
        'Écris et lis un spot audio de 20 secondes pour promouvoir mon produit, avec un ton dynamique et chaleureux.',
    },
    {
      label: 'Une voix off produit',
      prompt:
        'Génère une voix off en français qui présente mon produit de façon claire et convaincante.',
    },
    {
      label: 'Un message d’accueil',
      prompt:
        'Crée un message d’accueil professionnel pour ma boutique, à jouer quand un client appelle.',
    },
    {
      label: 'Un ton plus chaleureux',
      prompt:
        'Relis ce texte avec une voix plus chaleureuse et rassurante, adaptée à un message client.',
    },
  ],
  default: [
    {
      label: 'Créer une page de vente',
      prompt:
        'Aide-moi à créer une page de vente en français adaptée à mon activité, avec un appel à l’action clair.',
    },
    {
      label: 'Rédiger un message client',
      prompt:
        'Rédige un message clair et professionnel à envoyer à mes clients pour présenter une nouvelle offre.',
    },
    {
      label: 'Faire un plan d’action',
      prompt:
        'Propose-moi un plan d’action simple, étape par étape, pour développer mon activité cette semaine.',
    },
    {
      label: 'Trouver des idées',
      prompt:
        'Donne-moi trois idées concrètes et adaptées à mon activité que je peux mettre en place aujourd’hui.',
    },
  ],
};

/** Pick the fallback set for a studio, falling back to `default`. */
function fallbackFor(studio: string): PromptSuggestion[] {
  return FALLBACKS[studio] ?? FALLBACKS.default;
}

/** Human-readable description of a studio, for grounding the model. */
const STUDIO_BLURB: Record<string, string> = {
  apps: 'the ClickDz App Builder, where the merchant builds small web apps, sales pages and mini-shops (COD-friendly, French-first)',
  vdz: 'Vdz Studio, an AI video editor for short product ads, reels and promos (timeline, captions, voiceover)',
  voice: 'Voice Studio, a text-to-speech studio for narration, ads and voiceovers in French/Arabic',
  chat: 'the main AI chat, a general assistant for an Algerian merchant',
};

/** Build the system prompt for the fast suggestion model. */
function buildSystemPrompt(ctx: {
  studio: string;
  niche: string;
  recentTitles: string[];
}): string {
  const blurb = STUDIO_BLURB[ctx.studio] ?? STUDIO_BLURB.chat;
  const lines = [
    'You generate STARTER suggestion chips for an AI workspace used by Algerian merchants (French-first).',
    `The merchant is currently in ${blurb}.`,
    ctx.niche
      ? `Their business / niche is: "${ctx.niche}". Tailor every suggestion to this niche.`
      : 'Their niche is unknown — keep suggestions broadly useful for a small merchant.',
    ctx.recentTitles.length
      ? `They recently worked on: ${ctx.recentTitles
          .map(t => `"${t}"`)
          .join(', ')}. You may build on these.`
      : '',
    `Produce exactly ${COUNT} starter suggestions as a JSON array of objects with "label" and "prompt" string fields.`,
    '"label": a SHORT French chip (≤ 6 words) — a scannable starting point (e.g. "Une page de vente COD").',
    '"prompt": a RICH, self-contained French instruction (1-2 sentences) that is what actually gets sent when the chip is clicked. It must fully stand alone and be immediately actionable in this studio.',
    'Make the suggestions DISTINCT and genuinely useful for THIS studio and niche — never generic filler.',
    'Never invent that the merchant already has data/products; phrase as things to create or do.',
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
 * Defensive parse of the model output into clean PromptSuggestion[]. Tries
 * clean JSON, fence-stripped JSON, and a sliced outermost [...]. Each item must
 * yield BOTH a non-empty label and prompt. Returns [] when nothing usable is
 * present. (Kept structurally identical to the suggestions route's parser.)
 */
function parseSuggestions(raw: string): PromptSuggestion[] {
  const text = (raw ?? '').trim();
  if (!text) return [];

  const coerce = (value: unknown): PromptSuggestion[] | null => {
    if (!Array.isArray(value)) return null;
    const out: PromptSuggestion[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const label = cleanField((item as any).label, MAX_LABEL_CHARS);
      const prompt = cleanField((item as any).prompt, MAX_PROMPT_CHARS);
      if (label && prompt) out.push({ label, prompt });
      if (out.length >= COUNT) break;
    }
    return out.length ? out : null;
  };

  let arr: PromptSuggestion[] | null = null;
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

/** Normalise the incoming context envelope defensively. */
function readContext(body: unknown): SuggestionContext {
  const payload = (body ?? {}) as Record<string, unknown>;
  const rawCtx =
    payload.context && typeof payload.context === 'object'
      ? (payload.context as Record<string, unknown>)
      : payload;
  const studio =
    typeof rawCtx.studio === 'string'
      ? rawCtx.studio.trim().toLowerCase().slice(0, MAX_STUDIO_CHARS)
      : '';
  const niche =
    typeof rawCtx.niche === 'string'
      ? rawCtx.niche.replace(/\s+/g, ' ').trim().slice(0, MAX_NICHE_CHARS)
      : '';
  const lang =
    typeof rawCtx.lang === 'string' ? rawCtx.lang.trim().slice(0, 8) : '';
  const recentTitles = Array.isArray(rawCtx.recentTitles)
    ? rawCtx.recentTitles
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS))
        .filter(Boolean)
        .slice(0, MAX_TITLES)
    : [];
  return { studio, niche, lang, recentTitles };
}

@Controller()
export class ClickDzPromptSuggestionsController {
  private readonly logger = new Logger(ClickDzPromptSuggestionsController.name);

  /**
   * POST /api/v1/ai/prompt-suggestions
   * Body: { context: { studio?, recentTitles?, niche?, lang? } }
   * Returns: { suggestions: { label, prompt }[] } — ALWAYS 200, ≥1 item.
   */
  @Throttle('strict')
  @Post('/api/v1/ai/prompt-suggestions')
  async promptSuggestions(
    @Body() body: unknown
  ): Promise<{ suggestions: PromptSuggestion[] }> {
    const ctx = readContext(body);
    const studioKey = ctx.studio || 'default';
    const fallback = fallbackFor(studioKey);

    if (!CDZ_AI_KEY) {
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
          reasoning: { enabled: false }, // qwen3.7-flash: thinking OFF (12x faster, ~100x cheaper)
          messages: [
            {
              role: 'system',
              content: buildSystemPrompt({
                studio: studioKey,
                niche: ctx.niche ?? '',
                recentTitles: ctx.recentTitles ?? [],
              }),
            },
            {
              role: 'user',
              content: `Studio: ${studioKey}\nLangue: ${ctx.lang || 'fr'}\nNiche: ${
                ctx.niche || '(inconnue)'
              }`,
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
        const parsed = parseSuggestions(content);
        if (parsed.length) {
          // Pad from the studio fallback so the row always has COUNT items.
          const merged = [...parsed];
          for (const extra of fallback) {
            if (merged.length >= COUNT) break;
            if (
              !merged.some(
                f => f.label.toLowerCase() === extra.label.toLowerCase()
              )
            ) {
              merged.push(extra);
            }
          }
          return { suggestions: merged.slice(0, COUNT) };
        }
      }
    } catch {
      // network error, timeout, or JSON error → static fallback. Swallow it:
      // a failed suggestion call must never surface as a request failure.
      this.logger.debug?.(
        `[prompt-suggestions] fast model unavailable; serving ${studioKey} fallback`
      );
    }
    return { suggestions: fallback };
  }
}
