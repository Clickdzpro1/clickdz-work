import { Body, Controller, Logger, Post } from '@nestjs/common';

// Throttle('strict') is the same hard per-IP cap the paid /apps + /vdz routes
// use. We deliberately import NO typed error classes here: unlike its siblings,
// this route must NEVER throw a 4xx/5xx — a failed reasoning animation must
// degrade to generic lines so the calling UI's busy state never breaks. See the
// AUTH + FAILURE STANCE note on the controller below.
import { Throttle } from '../../base';

/**
 * ClickDz Pulse — the "reasoning animation" preflight.
 *
 * While the real (slow) generation model handles an AI request, this route asks
 * a FAST model for a handful of short, present-tense, request-tailored
 * "reasoning-like" status lines ("Analyzing your brief…", "Choosing a palette
 * for a coffee promo…", "Laying out scene 2…"). The client reveals them one by
 * one on a timer to keep users engaged. It powers ALL AI generations
 * (image / text / apps / videos) via one tiny endpoint.
 *
 * AUTH STANCE (mirrors the house): a FIRST-PARTY web-app route, the same
 * category as the bridge's /api/v1/apps/generate and the /vdz/* routes. It is
 * NOT annotated `@Public()`, so the global AuthGuard requires an authenticated
 * user session (the browser sends its cookie same-origin). We do not key
 * anything by user, so we don't even inject `@CurrentUser` — the guard alone is
 * the gate. This is deliberately NOT the bridge-token stance of
 * /chat/completions (external OpenAI-compatible machine clients).
 *
 * FAILURE STANCE (differs from the siblings ON PURPOSE): this endpoint ALWAYS
 * returns 200 with at least a generic fallback array. It never throws a typed
 * error, because a broken reasoning animation must not surface as a failed
 * request in the caller's busy state — the real generation is happening
 * regardless. Every failure mode (bad input, model down, slow model, unparseable
 * output) collapses to `surfaceFallback(surface)`.
 *
 * ENGINE (mirrors the bridge's runFastPlanner / the vdz controller's fast path):
 * we call the SAME `CDZ_AI_KEY` direct OpenAI-compatible chat model the bridge's
 * planner prefers (`cdz-flash` at `${CDZ_AI_BASE_URL}/v1/chat/completions`).
 * There is NO Make-agent fallback here: Make is the SLOW path, and this route's
 * whole point is to be fast, so if the fast model is unavailable we return the
 * static fallback lines immediately rather than waiting on the slow engine.
 * The backend does NOT import anything from the frontend.
 */

// ---------------------------------------------------------------------------
// Engine config — read the SAME env consts the bridge / vdz controllers read.
// ---------------------------------------------------------------------------
const CDZ_AI_BASE_URL = (
  process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai'
).replace(/\/+$/, '');
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';
// The fast/flash model the bridge's planner + the vdz dock both prefer.
const CDZ_FAST_MODEL = 'cdz-flash';

// ---------------------------------------------------------------------------
// Request + response bounds. `task` is a ONE-LINE description of what the user
// asked for (≤2k chars); anything longer is trimmed (not rejected — this route
// never errors). We ask for a small number of very short lines and clamp the
// result so a misbehaving model can't return a wall of text to the animation.
// ---------------------------------------------------------------------------
const MAX_TASK_CHARS = 2_000;
const MAX_LINES = 10;
const MIN_LINES = 6;
const MAX_LINE_CHARS = 64;
// Keep the fast call genuinely fast: low token budget + a tight 8s ceiling. If
// the model is slow/unavailable we abandon it and serve the static fallback.
const PULSE_MAX_TOKENS = 200;
const PULSE_TEMPERATURE = 0.8;
const PULSE_TIMEOUT_MS = 8_000;

/** The four generation surfaces the ticker can decorate. */
type PulseSurface = 'video' | 'app' | 'image' | 'chat';
const SURFACES: readonly PulseSurface[] = ['video', 'app', 'image', 'chat'];

/**
 * Static, surface-tailored fallback lines. Returned verbatim whenever the fast
 * model is unconfigured, slow, errors, or returns nothing usable — so the UI
 * ALWAYS has a believable animation to play. Present-tense, ≤8 words, no
 * numbering, generic enough to fit any request within that surface.
 */
const FALLBACK_LINES: Record<PulseSurface, string[]> = {
  video: [
    'Reading your brief…',
    'Blocking out the opening shot…',
    'Choosing a palette and mood…',
    'Timing the scene transitions…',
    'Composing motion for each beat…',
    'Balancing pacing and rhythm…',
    'Polishing the final frames…',
  ],
  app: [
    'Understanding what you need…',
    'Sketching the layout…',
    'Choosing components and flow…',
    'Wiring up the interactions…',
    'Styling for a clean finish…',
    'Checking the edge cases…',
    'Assembling the final build…',
  ],
  image: [
    'Reading your description…',
    'Framing the composition…',
    'Choosing lighting and palette…',
    'Refining subject and detail…',
    'Balancing color and contrast…',
    'Rendering the final image…',
  ],
  chat: [
    'Thinking about your request…',
    'Gathering the key points…',
    'Structuring a clear answer…',
    'Weighing the best approach…',
    'Drafting the response…',
    'Refining the wording…',
  ],
};

/** Normalize any inbound surface value to a known surface (default 'chat'). */
function normalizeSurface(raw: unknown): PulseSurface {
  return SURFACES.includes(raw as PulseSurface)
    ? (raw as PulseSurface)
    : 'chat';
}

/** The static fallback array for a surface (always non-empty). */
function surfaceFallback(surface: PulseSurface): string[] {
  return FALLBACK_LINES[surface];
}

/**
 * Human labels for the surfaces, woven into the system prompt so the fast model
 * frames its "thinking" around the right kind of work.
 */
const SURFACE_LABEL: Record<PulseSurface, string> = {
  video: 'an animated video / motion-graphics composition',
  app: 'a small web app or interactive page',
  image: 'a generated image',
  chat: 'a written answer or document',
};

/** Build the tight system prompt for the fast reasoning-line model. */
function buildSystemPrompt(surface: PulseSurface): string {
  return [
    `You are the "thinking" preflight for an AI that is about to create ${SURFACE_LABEL[surface]}.`,
    `You produce ${MIN_LINES}-${MAX_LINES} short present-tense reasoning-style status lines (≤ 8 words each) tailored to the user's task, as a JSON array of strings.`,
    'Sound like an expert thinking aloud about THIS specific request, in order, as if working through it.',
    'No numbering, no quotes-in-quotes, no trailing punctuation beyond an optional ellipsis.',
    'Output ONLY the JSON array of strings, nothing else.',
  ].join('\n');
}

/**
 * Defensive parse of whatever the fast model returned into a clean, bounded
 * string[]. Tries, in order: a clean JSON.parse; a fence-stripped JSON.parse; a
 * sliced outermost [...] array; and finally splitting the raw text on newlines.
 * Every line is trimmed, de-quoted, de-bulleted, length-capped and de-duped.
 * Returns [] when nothing usable is present (caller then serves the fallback).
 */
function parsePulseLines(raw: string): string[] {
  const text = (raw ?? '').trim();
  if (!text) return [];

  const coerceArray = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) return null;
    const out = value
      .map(item => (typeof item === 'string' ? item : String(item ?? '')))
      .map(cleanLine)
      .filter(Boolean);
    return out.length ? out : null;
  };

  // 1) clean JSON parse
  let arr: string[] | null = null;
  try {
    arr = coerceArray(JSON.parse(text));
  } catch {
    arr = null;
  }
  // 2) strip ``` / ```json fences and retry
  if (!arr) {
    const unfenced = text
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .trim();
    try {
      arr = coerceArray(JSON.parse(unfenced));
    } catch {
      arr = null;
    }
    // 3) slice the outermost [...] and retry
    if (!arr) {
      const start = unfenced.indexOf('[');
      const end = unfenced.lastIndexOf(']');
      if (start !== -1 && end > start) {
        try {
          arr = coerceArray(JSON.parse(unfenced.slice(start, end + 1)));
        } catch {
          arr = null;
        }
      }
    }
  }
  // 4) last resort: split the raw text on newlines
  if (!arr) {
    arr = text
      .split(/\r?\n+/)
      .map(cleanLine)
      .filter(Boolean);
  }

  // De-dupe (case-insensitive) preserving order, then bound to MAX_LINES.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of arr) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
    if (deduped.length >= MAX_LINES) break;
  }
  return deduped;
}

/**
 * Clean a single candidate line: strip surrounding quotes/backticks, leading
 * list markers ("1) ", "- ", "• ") and stray JSON punctuation, collapse
 * whitespace, and cap the length. Returns '' for junk so callers can filter.
 */
function cleanLine(input: unknown): string {
  let s = typeof input === 'string' ? input : String(input ?? '');
  s = s.trim();
  // drop a trailing comma the newline-split path may leave from a JSON array
  s = s.replace(/,\s*$/, '');
  // strip a single layer of wrapping quotes/backticks
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  // strip leading list markers: "1. ", "2) ", "- ", "* ", "• "
  s = s.replace(/^\s*(?:\d{1,2}[.)\]:]|[-*•])\s+/, '');
  // collapse internal whitespace
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length > MAX_LINE_CHARS) s = s.slice(0, MAX_LINE_CHARS).trim();
  return s;
}

@Controller()
export class ClickDzPulseController {
  private readonly logger = new Logger(ClickDzPulseController.name);

  /**
   * POST /api/v1/ai/pulse
   * Body: { task: string (≤2k chars), surface: 'video'|'app'|'image'|'chat' }
   * Returns: { lines: string[] } — ALWAYS 200, always ≥1 line.
   */
  @Throttle('strict')
  @Post('/api/v1/ai/pulse')
  async pulse(@Body() body: unknown): Promise<{ lines: string[] }> {
    const payload = (body ?? {}) as Record<string, unknown>;
    const surface = normalizeSurface(payload.surface);
    const task =
      typeof payload.task === 'string'
        ? payload.task.replace(/\s+/g, ' ').trim().slice(0, MAX_TASK_CHARS)
        : '';

    // No fast model configured, or no task to tailor to → static fallback now.
    // (The animation is cosmetic; we never block on the slow Make engine here.)
    if (!CDZ_AI_KEY || !task) {
      return { lines: surfaceFallback(surface) };
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
            { role: 'system', content: buildSystemPrompt(surface) },
            { role: 'user', content: `Task: ${task}` },
          ],
          max_tokens: PULSE_MAX_TOKENS,
          temperature: PULSE_TEMPERATURE,
        }),
        // Hard 8s ceiling — if the fast model is slow, we abandon and fall back.
        signal: AbortSignal.timeout(PULSE_TIMEOUT_MS),
      });
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = data?.choices?.[0]?.message?.content;
      if (response.ok && typeof content === 'string' && content.trim()) {
        const lines = parsePulseLines(content);
        // Guard against a too-short reply: pad from the surface fallback so the
        // ticker always has enough to feel alive, then bound to MAX_LINES.
        if (lines.length >= MIN_LINES) {
          return { lines: lines.slice(0, MAX_LINES) };
        }
        if (lines.length) {
          const merged = [...lines];
          for (const extra of surfaceFallback(surface)) {
            if (merged.length >= MIN_LINES) break;
            if (!merged.some(l => l.toLowerCase() === extra.toLowerCase())) {
              merged.push(extra);
            }
          }
          return { lines: merged.slice(0, MAX_LINES) };
        }
      }
      // errored / empty / unparseable → static fallback
    } catch {
      // network error, timeout, or JSON error → static fallback. We swallow it:
      // a failed reasoning animation must never surface as a request failure.
      this.logger.debug?.(`[pulse] fast model unavailable; serving fallback`);
    }
    return { lines: surfaceFallback(surface) };
  }
}
