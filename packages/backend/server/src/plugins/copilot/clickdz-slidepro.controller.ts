import { Body, Controller, Logger, Post } from '@nestjs/common';

// SECURITY: typed AFFiNE errors so the global exception filter emits proper
// status codes (a raw @nestjs/common HttpException would become a generic 500).
//  · BadRequest               -> 400 (missing / malformed / oversized input)
//  · CopilotProviderSideError -> upstream (gateway / model) failure, typed as a
//    copilot provider error rather than a bare 502.
// Throttle('strict') is the same hard per-IP cap the paid /apps + /vdz routes use.
import { BadRequest, CopilotProviderSideError, Throttle } from '../../base';
import { CurrentUser } from '../../core/auth';

// ---------------------------------------------------------------------------
// ClickDz SlidePro — native AI presentation generator.
//
// This is the in-house replacement for the old iframed presenton fork. It has
// NO external service: it reuses the app's OWN Vercel AI Gateway (the exact
// same key + base as chat, images and the VDZ compose controller — see
// clickdz-vdz-compose.controller.ts and the image-generations route in
// clickdz-bridge.controller.ts) to generate slide content, and the frontend
// reuses the existing POST /api/v1/images/generations route for slide imagery.
//
// Two routes, both mirroring the VDZ compose stance (session-authed like its
// ClickDz siblings, Throttle('strict'), typed errors, hard input caps):
//   · POST /api/v1/slidepro/outline  {prompt, slideCount?, language?, audience?}
//        -> { title, outline: string[] }
//   · POST /api/v1/slidepro/deck     {prompt, outline?, slideCount?, language?,
//        audience?, tone?} -> { title, slides: SlideSpec[] }
//
// The model is asked for STRICT JSON; parsing tolerates markdown ```json fences
// and leading/trailing prose, then validates + coerces the shape so a slightly
// off reply still yields a usable deck instead of a 500.
// ---------------------------------------------------------------------------

// Same model family as the VDZ compose + social planner path: qwen3.7-flash
// (128K ctx) with thinking OFF — fast + cheap, ample for JSON deck synthesis.
const SLIDEPRO_MODEL =
  process.env.CDZ_SLIDEPRO_MODEL || 'alibaba/qwen3.7-flash';
// Full-deck synthesis is the heavier call; give it room (a 12-slide deck with
// bullets + speaker notes is well under this, but headroom avoids truncation).
const SLIDEPRO_MAX_TOKENS = 8000;
const SLIDEPRO_TIMEOUT_MS = 120_000;

// Input caps (reject, don't clamp — matches the /apps + /vdz route stance).
const MAX_PROMPT_CHARS = 4_000;
const MAX_OUTLINE_ITEMS = 40;
const MAX_OUTLINE_ITEM_CHARS = 300;

// Slide-count clamp: 1..30 (a deck longer than 30 slides is almost never what a
// prompt-driven generator should emit in one shot, and it protects the budget).
const MIN_SLIDES = 1;
const MAX_SLIDES = 30;
const DEFAULT_SLIDES = 8;

// The layouts the frontend deck editor understands. Kept in sync with the FE
// SlideLayout union (slidepro/types.ts). The model is told to pick from these.
const LAYOUTS = [
  'title',
  'title-bullets',
  'two-column',
  'quote',
  'image-text',
] as const;
type SlideLayout = (typeof LAYOUTS)[number];

interface SlideSpec {
  title: string;
  layout: SlideLayout;
  bullets: string[];
  /** Second column of bullets for the 'two-column' layout (else empty). */
  bulletsRight: string[];
  /** Speaker notes (a short paragraph). */
  notes: string;
  /** A concise image-generation prompt for 'image-text' layouts (else ''). */
  imagePrompt: string;
}

/**
 * Resolve the Vercel AI Gateway key + base. Identical cascade to the image
 * route and the VDZ compose controller so SlidePro lights up wherever chat /
 * images already work — no new env var to configure.
 */
function gatewayConfig(): { key: string; base: string } {
  const key =
    process.env.CDZ_AI_GATEWAY_KEY || process.env.CUSTOM_LLM_API_KEY || '';
  const base = (
    process.env.CDZ_AI_GATEWAY_BASE || 'https://ai-gateway.vercel.sh'
  ).replace(/\/+$/, '');
  return { key, base };
}

/**
 * Pull the first balanced JSON object/array out of a model reply. Tolerates:
 *   · a bare JSON document,
 *   · a document wrapped in a ```json … ``` (or plain ```) fence,
 *   · leading/trailing prose around the JSON.
 * Returns the parsed value, or null when nothing parseable is found.
 */
function extractJson(reply: string): unknown {
  if (!reply) return null;
  const text = reply.trim();

  // 1) Prefer a fenced block if present (```json … ``` or ``` … ```).
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates: string[] = [];
  if (fence) candidates.push(fence.trim());
  candidates.push(text);

  for (const candidate of candidates) {
    // Fast path: the candidate is already valid JSON.
    try {
      return JSON.parse(candidate);
    } catch {
      /* fall through to substring scan */
    }
    // 2) Scan for the first balanced {...} or [...] region and parse that.
    const sliced = sliceBalanced(candidate);
    if (sliced) {
      try {
        return JSON.parse(sliced);
      } catch {
        /* try next candidate */
      }
    }
  }
  return null;
}

/**
 * Return the substring of `s` spanning the first balanced JSON object or array,
 * respecting strings + escapes so braces inside string literals don't confuse
 * the depth counter. Returns null when no balanced region is found.
 */
function sliceBalanced(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = asString(item).trim();
    if (s) out.push(s.slice(0, MAX_OUTLINE_ITEM_CHARS));
    if (out.length >= cap) break;
  }
  return out;
}

function coerceLayout(v: unknown): SlideLayout {
  const s = asString(v).trim().toLowerCase().replace(/[\s_]+/g, '-');
  return (LAYOUTS as readonly string[]).includes(s)
    ? (s as SlideLayout)
    : 'title-bullets';
}

function clampSlideCount(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_SLIDES;
  return Math.max(MIN_SLIDES, Math.min(MAX_SLIDES, n));
}

@Controller()
export class ClickDzSlideProController {
  private readonly logger = new Logger(ClickDzSlideProController.name);

  /** One chat-completion turn against the gateway, returning the raw content. */
  private async runGateway(
    messages: Array<{ role: string; content: string }>
  ): Promise<string> {
    const { key, base } = gatewayConfig();
    if (!key) {
      throw new CopilotProviderSideError({
        provider: 'gateway',
        kind: 'not_configured',
        message:
          'SlidePro AI is not configured. Set CDZ_AI_GATEWAY_KEY or CUSTOM_LLM_API_KEY to a valid Vercel AI Gateway key.',
      });
    }
    try {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: SLIDEPRO_MODEL,
          reasoning: { enabled: false }, // thinking OFF (faster, far cheaper)
          messages,
          max_tokens: SLIDEPRO_MAX_TOKENS,
          temperature: 0.4,
        }),
        signal: AbortSignal.timeout(SLIDEPRO_TIMEOUT_MS),
      });
      const data = (await response.json().catch(() => null)) as any;
      const result = data?.choices?.[0]?.message?.content;
      if (!response.ok || typeof result !== 'string') {
        throw new CopilotProviderSideError({
          provider: 'gateway',
          kind: 'api_error',
          message: `Gateway returned ${response.status}`,
        });
      }
      return result;
    } catch (cause) {
      if (cause instanceof CopilotProviderSideError) throw cause;
      throw new CopilotProviderSideError({
        provider: 'gateway',
        kind: 'network_error',
        message:
          cause instanceof Error
            ? `SlidePro gateway request failed: ${cause.message}`
            : 'SlidePro gateway request failed',
      });
    }
  }

  /**
   * OUTLINE — a prompt in, an editable section list out. Cheap first step the
   * user reviews/edits before committing to a full deck.
   */
  @Throttle('strict')
  @Post('/api/v1/slidepro/outline')
  async outline(@CurrentUser() user: CurrentUser, @Body() body: any) {
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      throw new BadRequest('A presentation topic is required');
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new BadRequest(
        `Prompt is too long (max ${MAX_PROMPT_CHARS} characters)`
      );
    }
    const slideCount = clampSlideCount(body?.slideCount);
    const language = String(body?.language || 'French').slice(0, 40);
    const audience = String(body?.audience || '').slice(0, 200);

    this.logger.log(
      `[slidepro] outline user=${user.id} prompt=${prompt.length}chars slides=${slideCount}`
    );

    const sys =
      'You are an expert presentation strategist. Given a topic, produce a tight, logical slide outline. ' +
      `Write in ${language}. ` +
      (audience ? `Target audience: ${audience}. ` : '') +
      'Return STRICT JSON ONLY (no markdown, no prose) of the exact shape: ' +
      '{"title": string, "outline": string[]}. ' +
      `"outline" must have exactly ${slideCount} short section headers (max ~8 words each), ` +
      'ordered as a real talk would flow (hook/intro first, summary/CTA last). No numbering prefixes.';

    const reply = await this.runGateway([
      { role: 'system', content: sys },
      { role: 'user', content: prompt },
    ]);

    const parsed = extractJson(reply) as
      | { title?: unknown; outline?: unknown }
      | null;
    const outline = asStringArray(parsed?.outline, MAX_OUTLINE_ITEMS);
    if (outline.length === 0) {
      throw new CopilotProviderSideError({
        provider: 'gateway',
        kind: 'invalid_output',
        message:
          'The model did not return a usable outline. Try rephrasing your topic.',
      });
    }
    const title = asString(parsed?.title).trim().slice(0, 200) || prompt.slice(0, 80);
    return { title, outline };
  }

  /**
   * DECK — a prompt (and optional edited outline) in, a full structured deck
   * out (title + per-slide title/layout/bullets/notes/imagePrompt). This is the
   * heavy call; the frontend renders + lets the user edit everything after.
   */
  @Throttle('strict')
  @Post('/api/v1/slidepro/deck')
  async deck(@CurrentUser() user: CurrentUser, @Body() body: any) {
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      throw new BadRequest('A presentation topic is required');
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new BadRequest(
        `Prompt is too long (max ${MAX_PROMPT_CHARS} characters)`
      );
    }
    // Optional user-edited outline steers the deck; validated + capped.
    if (body?.outline != null && !Array.isArray(body.outline)) {
      throw new BadRequest('"outline" must be an array of strings');
    }
    const outline = asStringArray(body?.outline, MAX_OUTLINE_ITEMS);
    const slideCount = outline.length
      ? Math.max(MIN_SLIDES, Math.min(MAX_SLIDES, outline.length))
      : clampSlideCount(body?.slideCount);
    const language = String(body?.language || 'French').slice(0, 40);
    const audience = String(body?.audience || '').slice(0, 200);
    const tone = String(body?.tone || '').slice(0, 60);

    this.logger.log(
      `[slidepro] deck user=${user.id} prompt=${prompt.length}chars outline=${outline.length} slides=${slideCount}`
    );

    const layoutList = LAYOUTS.join(', ');
    const sys =
      'You are an expert presentation designer and copywriter. Produce a complete, ready-to-present slide deck. ' +
      `Write ALL content in ${language}. ` +
      (audience ? `Target audience: ${audience}. ` : '') +
      (tone ? `Tone: ${tone}. ` : '') +
      'Return STRICT JSON ONLY (no markdown fences, no commentary) of the EXACT shape:\n' +
      '{"title": string, "slides": [{"title": string, "layout": string, "bullets": string[], ' +
      '"bulletsRight": string[], "notes": string, "imagePrompt": string}]}\n' +
      `Rules:\n` +
      `- Produce exactly ${slideCount} slides.\n` +
      `- "layout" MUST be one of: ${layoutList}.\n` +
      `- Slide 1 SHOULD use the "title" layout (title + a one-line subtitle as a single bullet).\n` +
      `- "bullets": 3-5 concise points (max ~14 words each). For a "quote" layout, put the quote as ONE bullet and the attribution in "notes".\n` +
      `- "bulletsRight": only for "two-column" layout (else []).\n` +
      `- "imagePrompt": only for "image-text" layout — a vivid, specific image description (else "").\n` +
      `- "notes": 2-4 sentences of speaker notes per slide.\n` +
      `- Vary layouts sensibly; do not use "image-text" on more than ~1/3 of slides.`;

    const userMsg = outline.length
      ? `Topic: ${prompt}\n\nUse this exact outline, one slide per item, in order:\n${outline
          .map((o, i) => `${i + 1}. ${o}`)
          .join('\n')}`
      : `Topic: ${prompt}`;

    const reply = await this.runGateway([
      { role: 'system', content: sys },
      { role: 'user', content: userMsg },
    ]);

    const parsed = extractJson(reply) as
      | { title?: unknown; slides?: unknown }
      | null;
    const rawSlides = Array.isArray(parsed?.slides) ? parsed!.slides : [];
    const slides: SlideSpec[] = [];
    for (const raw of rawSlides as any[]) {
      if (!raw || typeof raw !== 'object') continue;
      const layout = coerceLayout(raw.layout);
      const spec: SlideSpec = {
        title: asString(raw.title).trim().slice(0, 200),
        layout,
        bullets: asStringArray(raw.bullets, 8),
        bulletsRight:
          layout === 'two-column' ? asStringArray(raw.bulletsRight, 8) : [],
        notes: asString(raw.notes).trim().slice(0, 1500),
        imagePrompt:
          layout === 'image-text'
            ? asString(raw.imagePrompt).trim().slice(0, 400)
            : '',
      };
      // A slide with neither a title nor any bullets is noise — drop it.
      if (spec.title || spec.bullets.length) slides.push(spec);
      if (slides.length >= MAX_SLIDES) break;
    }

    if (slides.length === 0) {
      throw new CopilotProviderSideError({
        provider: 'gateway',
        kind: 'invalid_output',
        message:
          'The model did not return a usable deck. Try rephrasing your topic.',
      });
    }
    const title =
      asString(parsed?.title).trim().slice(0, 200) ||
      slides[0]?.title ||
      prompt.slice(0, 80);
    return { title, slides };
  }
}
