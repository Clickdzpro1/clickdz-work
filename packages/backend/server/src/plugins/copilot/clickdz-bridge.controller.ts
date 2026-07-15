import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
// SECURITY: cryptographically strong randomness for unguessable auto-slugs.
import { randomBytes } from 'node:crypto';

import { Public } from '../../core/auth';
// SECURITY: hard per-IP rate cap for cost/side-effecting routes (strict = 20/min).
// AuthenticationRequired -> typed 401 (raw HttpException becomes a generic 500 here).
import { AuthenticationRequired, Throttle } from '../../base';
import {
  buildEditContent,
  buildNewAppContent,
  type AppHistoryTurn,
  type AppSelectionContext,
} from './clickdz-app-prompt';
// SECURITY: constant-time token compare + per-slug Data API write tokens.
import { dataWriteToken, safeEqual } from './cdz-data-token';

// SECURITY: input caps for cost/side-effecting routes (images, apps, plan).
// Non-breaking for normal use; reject oversized/abusive payloads early.
const MAX_PROMPT_CHARS = 8_000;
const MAX_HTML_CHARS = 512_000;
// SECURITY: edit-in-context conversation caps for /apps/generate. Match the
// canonical CdzGenerateRequest bounds; reject (not clamp) oversized inputs so
// abuse is refused, then the prompt builder's internal clamps are belt-and-braces.
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_TURN_CHARS = 2_000;
const MAX_HISTORY_TOTAL_CHARS = 8_000;
const MAX_SELECTION_TEXT_CHARS = 200;
const MAX_SELECTION_DESCRIPTOR_CHARS = 500;
// SECURITY: hard ceiling on max_tokens forwarded to upstream model APIs, to
// cap per-request cost. Floor of 1 keeps requests valid.
const MAX_TOKENS_CEILING = 4096;
const DEFAULT_MAX_TOKENS = 700;

/**
 * SECURITY: clamp a caller/requested max_tokens value to a sane range before
 * it reaches an upstream (paid) model API. Falls back to `fallback` when the
 * requested value is missing or not a finite number, then clamps to
 * [1, MAX_TOKENS_CEILING].
 */
function clampMaxTokens(
  requested: unknown,
  fallback: number = DEFAULT_MAX_TOKENS
): number {
  const n = Number(requested);
  const base = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(1, Math.min(Math.floor(base), MAX_TOKENS_CEILING));
}

/**
 * SECURITY (SSRF mitigation): decide whether a user-supplied URL is safe to
 * fetch server-side. Requires http/https and rejects loopback, private,
 * link-local and cloud-metadata targets. This is the pragmatic P1 mitigation:
 * it blocks literal-IP and known-bad hostnames WITHOUT resolving DNS, so a
 * hostname that resolves to a private IP is not caught here (documented
 * residual risk). Prefer https.
 */
function isSafePublicUrl(u: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  // only http/https (prefer https); block file:, gopher:, data:, etc.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // known-bad / metadata hostnames
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    host.endsWith('.local')
  ) {
    return false;
  }
  // shared IPv4 range check: true = private/loopback/link-local/reserved.
  const isPrivateV4 = (a: number, b: number): boolean =>
    a === 127 || // 127.0.0.0/8 loopback
    a === 10 || // 10.0.0.0/8 private
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (incl. 169.254.169.254)
    a === 0; // 0.0.0.0/8 "this host"
  // IPv6 literals: loopback (::1), unique-local (fc00::/7 => fc/fd prefix),
  // link-local (fe80::/10 => fe8/fe9/fea/feb prefix).
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return false;
    if (/^f[cd]/i.test(host)) return false; // fc00::/7
    if (/^fe[89ab]/i.test(host)) return false; // fe80::/10
    // IPv4-mapped IPv6. Node's URL normalizes ::ffff:169.254.169.254 to the
    // compressed hex form ::ffff:a9fe:a9fe, so match BOTH the dotted-quad and
    // the trailing two hex groups and range-check the embedded IPv4. This
    // closes the metadata-endpoint bypass via mapped addresses.
    const dotted = host.match(/::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
    if (dotted && isPrivateV4(Number(dotted[1]), Number(dotted[2]))) return false;
    const hex = host.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >> 8) & 0xff;
      const d = lo & 0xff;
      // reconstruct a.b.c.d; reject if it decodes to a private/reserved range
      if (isPrivateV4(a, b) || (a === 169 && b === 254 && c === 169 && d === 254)) {
        return false;
      }
    }
    return true;
  }
  // IPv4 literal? if it looks like a dotted quad, range-check it.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    if (isPrivateV4(Number(m[1]), Number(m[2]))) return false;
    return true;
  }
  // a regular DNS hostname we can't classify without resolution — allow it
  // (documented residual SSRF risk: no DNS resolution is performed).
  return true;
}

const MAKE_API_BASE = process.env.MAKE_API_BASE || 'https://eu1.make.com/api/v2';
const MAKE_API_KEY = process.env.MAKE_API_KEY || '';
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID || '';
const MAKE_AGENT_ID = process.env.MAKE_SUPERAGENT_ID || process.env.MAKE_AGENT_ID || '';
const MAKE_ARABIC_AGENT_ID = process.env.MAKE_ARABIC_AGENT_ID || MAKE_AGENT_ID;
const OPENAI_IMAGE_API_KEY = process.env.OPENAI_IMAGE_API_KEY || process.env.OPENAI_API_KEY || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const MAKE_OCR_WEBHOOK_URL = process.env.MAKE_OCR_WEBHOOK_URL || '';
const MAKE_CODE_AGENT_ID = process.env.MAKE_CODE_AGENT_ID || '';
const MAKE_BUILDER_AGENT_ID = process.env.MAKE_BUILDER_AGENT_ID || '';
// machine access token for external OpenAI-compatible clients
// (ClickDz Builder / bolt.diy). Unset = machine access disabled.
const CLICKDZ_BRIDGE_TOKEN = process.env.CLICKDZ_BRIDGE_TOKEN || '';
const CDZ_AI_BASE_URL = (
  process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai'
).replace(/\/+$/, '');
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';

// ClickDz Apps — the app-builder system prompt + message-content builders now
// live in ./clickdz-app-prompt (imported above). buildAppHtml delegates to them.

const CLICKDZ_APP_WATERMARK =
  '<div style="position:fixed;bottom:10px;right:12px;font:600 11px system-ui;opacity:.55;z-index:99999"><a href="https://work.clickdz.ai" style="color:inherit;text-decoration:none" target="_blank" rel="noopener">⚡ Built with ClickDz</a></div>';

function slugifyAppName(input: string): string {
  // keep slugs short: long project names make Vercel truncate the
  // auto-assigned <project>.vercel.app domain unpredictably
  const base = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join('-')
    .replace(/-+/g, '-')
    .slice(0, 18)
    .replace(/^-|-$/g, '');
  // SECURITY: auto-generated slugs gate access to the PUBLIC per-slug
  // datastore, so they must not be guessable. Use crypto-strong randomness
  // (randomBytes) instead of Math.random(). 4 bytes -> 8 lowercase hex chars,
  // which stay inside the SLUG_RE /^[a-z0-9-]{3,50}$/ used for lookups.
  // base (<=18) + '-' (1) + 8 hex = <=27 chars, well within the 50-char slug
  // cap and the 52-char Vercel project cap (see deployAppToVercel).
  const rand = randomBytes(4).toString('hex');
  return base ? `${base}-${rand}` : `app-${rand}`;
}

function extractHtmlApp(reply: string): string {
  const block = reply.match(/```html\s*([\s\S]*?)```/i)?.[1];
  const candidate = (block ?? reply).trim();
  if (/^<!doctype html/i.test(candidate) || /^<html[\s>]/i.test(candidate)) {
    return candidate;
  }
  return '';
}

// ClickDz 1.0 — the smart image model: Make-enhanced prompt -> gpt-image-1
const CLICKDZ_IMAGE_MODEL_IDS = new Set(['clickdz-image-1.0', 'clickdz-image']);
const CLICKDZ_IMAGE_ENGINE = 'gpt-image-1';
const IMAGE_ENHANCER_GUIDELINES = [
  'You are ClickDz 1.0, an elite image prompt engineer. Rewrite the request',
  'below into ONE masterful English image-generation prompt.',
  'Rules:',
  '- preserve the user intent and every explicit detail they gave',
  '- specify: subject, setting, composition (framing, perspective), lighting',
  '  (quality, direction, mood), color palette, style or medium, fine textures',
  '- add tasteful photographic/artistic vocabulary (lens, film stock, render',
  '  style) only when it fits the request',
  '- if the request is Arabic or French, translate the intent faithfully into',
  '  English, but keep any text that must appear INSIDE the image in its',
  '  original language, wrapped in double quotes',
  '- never invent brands, logos, real people or watermarks not requested',
  '- output ONLY the final prompt text, no commentary, at most 180 words',
].join('\n');

const MODELS = [
  'clickdz-ultra',
  'clickdz-builder',
  'clickdz-fast',
  'clickdz-smart',
  'clickdz-arabic',
  'gpt-5.5',
  'gpt-5-mini',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'gemini-3.5-flash',
  'gemini-2.5-pro',
  'dall-e-3',
];

function now() {
  return Math.floor(Date.now() / 1000);
}

function hasArabic(text: string) {
  return /[\u0600-\u06FF]/.test(text);
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

function normalizeMessages(messages: Array<{ role: string; content: unknown }>) {
  return (messages || []).map(message => ({
    role: message.role,
    content: flattenContent(message.content),
  }));
}

function openAIChatResponse(id: string, model: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: now(),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function parseMakeAgentResponse(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.reply === 'string') return parsed.reply;
      if (typeof parsed.answer === 'string') return parsed.answer;
      if (typeof parsed.content === 'string') return parsed.content;
      if (typeof parsed.response === 'string') return parsed.response;
      return raw;
    } catch {
      return raw;
    }
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.reply === 'string') return obj.reply;
    if (typeof obj.answer === 'string') return obj.answer;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.response === 'string') return parseMakeAgentResponse(obj.response);
  }
  return '';
}

/**
 * A single proposed plan step. `recommended` steps are checked by default in
 * the UI (the core plan); non-recommended steps render as unchecked optional
 * "suggestions" the user can opt into. This powers the v3 checklist UX.
 */
type PlanStep = {
  text: string;
  recommended: boolean;
};

type PlanClarification = {
  /** One-line statement of what the plan will accomplish. */
  goal: string;
  question: string;
  options: string[];
  /** Ordered checklist of proposed steps. Always non-empty. */
  steps: PlanStep[];
  /** Flat prose form of the plan, kept for backwards compatibility. */
  draftPlan: string;
};

/**
 * Derive an ordered step list from free-form plan prose. Handles numbered
 * ("1) …", "2. …"), bulleted ("- …", "• …"), and line-per-step formats, and
 * falls back to sentence splitting for a single dense paragraph.
 */
function derivePlanSteps(plan: string): string[] {
  const text = plan.trim();
  if (!text) return [];
  const numbered = text
    .split(/(?:^|\s)(?:\d{1,2}[).:]|[-•*])\s+/)
    .map(part => part.trim().replace(/[\s,;]+$/, ''))
    .filter(part => part.length > 2);
  if (numbered.length >= 2) return numbered.slice(0, 8);
  const lines = text
    .split(/\n+/)
    .map(line => line.trim().replace(/^(?:\d{1,2}[).:]|[-•*])\s*/, ''))
    .filter(Boolean);
  if (lines.length >= 2) return lines.slice(0, 8);
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 2);
  if (sentences.length >= 2) return sentences.slice(0, 8);
  return [text];
}

/** Coerce whatever the model returned in `steps` into PlanStep objects. */
function normalizePlanSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanStep[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      const text = String(obj.text ?? obj.step ?? obj.title ?? '').trim();
      if (!text) continue;
      // Default to recommended unless the model explicitly opts it out.
      const recommended =
        obj.recommended === false || obj.optional === true ? false : true;
      out.push({ text, recommended });
    } else {
      const text = String(entry).trim();
      if (text) out.push({ text, recommended: true });
    }
  }
  return out.slice(0, 10);
}

const FALLBACK_PLAN_STEPS: PlanStep[] = [
  { text: 'Confirm the target outcome and constraints.', recommended: true },
  { text: 'Execute the request end to end.', recommended: true },
  { text: 'Verify the result and report what was done.', recommended: true },
];

function parsePlanClarification(raw: string): PlanClarification {
  const unfenced = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(unfenced.slice(start, end + 1)) as Record<
        string,
        unknown
      >;
      const goal = String(parsed.goal || parsed.summary || '').trim();
      const question = String(parsed.question || '').trim();
      const options = Array.isArray(parsed.options)
        ? parsed.options
            .map(option => String(option).trim())
            .filter(Boolean)
            .slice(0, 4)
        : [];
      let steps = normalizePlanSteps(parsed.steps);
      // Merge any explicit optional "suggestions" the model returned as
      // unchecked steps the user can opt into.
      const suggestions = normalizePlanSteps(parsed.suggestions).map(step => ({
        ...step,
        recommended: false,
      }));
      steps = [...steps, ...suggestions];
      const draftPlan = String(parsed.draftPlan || '').trim();
      if (!steps.length && draftPlan) {
        steps = derivePlanSteps(draftPlan).map(text => ({
          text,
          recommended: true,
        }));
      }
      if (steps.length) {
        return {
          goal: goal || draftPlan || 'Execute the request.',
          question: question || 'What outcome matters most before I run this?',
          options,
          steps: steps.slice(0, 10),
          draftPlan:
            draftPlan || steps.map(step => step.text).join('\n'),
        };
      }
    } catch {
      // fall through to a useful deterministic clarification
    }
  }
  const derived = derivePlanSteps(raw).map(text => ({ text, recommended: true }));
  const steps = derived.length ? derived : FALLBACK_PLAN_STEPS;
  return {
    goal: raw.trim().slice(0, 160) || 'Execute the request.',
    question: 'What outcome matters most before I execute this plan?',
    options: ['Fast first version', 'Highest quality', 'Lowest risk'],
    steps,
    draftPlan: raw.trim() || steps.map(step => step.text).join('\n'),
  };
}

@Controller()
export class ClickDzBridgeController {
  private readonly logger = new Logger(ClickDzBridgeController.name);

  /** bearer-token gate for external OpenAI-compatible clients */
  private assertBridgeToken(req: Request) {
    if (!CLICKDZ_BRIDGE_TOKEN) {
      throw new HttpException(
        { error: { message: 'Machine access to the ClickDz bridge is not configured', type: 'configuration_error', code: 'bridge_token_missing' } },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
    const auth = String(req.headers.authorization || '');
    // Constant-time compare so the bridge token can't be recovered by timing.
    if (!safeEqual(auth, `Bearer ${CLICKDZ_BRIDGE_TOKEN}`)) {
      throw new AuthenticationRequired('Invalid bridge token');
    }
  }

  /**
   * ClickDz smart router: picks the best Make agent for the request.
   * - clickdz-builder -> the high-token Builder runtime (IDE traffic)
   * - clickdz-ultra   -> intent-based routing across all agents
   * - everything else -> default agent selection (incl. Arabic detection)
   */
  private resolveAgentForRequest(
    model: string,
    messages: Array<{ role: string; content: string }>
  ): string | undefined {
    if (model === 'clickdz-builder' && MAKE_BUILDER_AGENT_ID) {
      return MAKE_BUILDER_AGENT_ID;
    }
    if (model !== 'clickdz-ultra') return undefined;
    const joined = messages.map(m => m.content).join('\n');
    const codeSignals =
      /```|<\/?[a-z]+>|\bfunction\b|\bconst\b|\bimport\b|\bcode\b|\bdebug\b|\bapp\b|\bcomponent\b|\bAPI\b/i;
    if (codeSignals.test(joined)) {
      return MAKE_BUILDER_AGENT_ID || MAKE_CODE_AGENT_ID || undefined;
    }
    if (hasArabic(joined)) return MAKE_ARABIC_AGENT_ID || undefined;
    // heavy/analytical and default traffic both fall through: the default
    // agent selection already prefers the Make super-agent when configured
    return undefined;
  }

  private assertMakeReady() {
    if (!MAKE_API_KEY || !MAKE_TEAM_ID || !MAKE_AGENT_ID) {
      throw new HttpException(
        {
          error: {
            message: 'Make.com AI agent is not configured',
            type: 'configuration_error',
            code: 'make_not_configured',
          },
        },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
  }

  private async runMakeAgent(
    messages: Array<{ role: string; content: string }>,
    model: string,
    agentIdOverride?: string,
    timeoutMs = 240000
  ) {
    this.assertMakeReady();
    const joined = messages
      .map(message => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n');
    const agentId =
      agentIdOverride ||
      (hasArabic(joined) || model.includes('arabic')
        ? MAKE_ARABIC_AGENT_ID
        : MAKE_AGENT_ID);
    const response = await fetch(
      `${MAKE_API_BASE}/ai-agents/v1/agents/${agentId}/run?teamId=${MAKE_TEAM_ID}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${MAKE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: `You are ClickDz Work AI. Answer directly and helpfully. Requested model: ${model}.\n\n${joined}`,
            },
          ],
          config: {},
        }),
        // large code generations can take a couple of minutes — fail
        // controlled instead of hanging forever
        signal: AbortSignal.timeout(timeoutMs),
      }
    );

    if (!response.ok) {
      throw new HttpException(
        {
          error: {
            message: `Make.com agent failed: ${response.status} ${response.statusText}`,
            type: 'provider_error',
            code: 'make_agent_failed',
          },
        },
        HttpStatus.BAD_GATEWAY
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    return parseMakeAgentResponse(data.response ?? data);
  }

  private async runFastPlanner(request: string) {
    const prompt = [
      'Act as the fast planning preflight for ClickDz Work.',
      'Read the request and return ONLY valid JSON with this exact shape:',
      '{"goal":"one short sentence stating what the plan achieves, in the user language","question":"one decisive clarification in the user language","options":["2 to 4 short answer choices"],"steps":[{"text":"a single concrete ordered action","recommended":true}],"suggestions":[{"text":"an optional nice-to-have step the user may want","recommended":false}]}',
      'Rules: "steps" = 3 to 6 core actions the plan needs, each recommended:true. "suggestions" = 0 to 3 OPTIONAL extra steps (recommended:false) the user can opt into — do not duplicate core steps. Ask exactly one high-value question. Keep every step short and imperative. Do NOT execute the request.',
      '',
      `REQUEST:\n${request.slice(0, 12000)}`,
    ].join('\n');

    if (CDZ_AI_KEY) {
      try {
        const response = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CDZ_AI_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'cdz-flash',
            messages: [{ role: 'user', content: prompt }],
            // SECURITY: clamp to a sane ceiling (<=4096, floor 1) to cap
            // upstream cost. Keeps the existing 700 default.
            max_tokens: clampMaxTokens(700, DEFAULT_MAX_TOKENS),
          }),
          signal: AbortSignal.timeout(30000),
        });
        const data = (await response.json()) as any;
        const content = data?.choices?.[0]?.message?.content;
        if (response.ok && typeof content === 'string' && content.trim()) {
          return content;
        }
      } catch {
        // Fall through to the Make agent so Plan mode stays available.
      }
    }

    return this.runMakeAgent(
      [{ role: 'user', content: prompt }],
      'clickdz-fast',
      undefined,
      30000
    );
  }

  /**
   * Best-effort one-line "what changed" summary for an app EDIT, produced by a
   * fast CDZ_AI (`cdz-flash`) call. The frontend (clickdz-builder-studio) already
   * reads `data.summary` and renders it in the version list; when this returns
   * nothing useful the client falls back to its own default label.
   *
   * Kept deliberately cheap and non-blocking: 5s timeout, tiny token budget, and
   * a deterministic fallback on ANY failure so a summary problem never breaks or
   * slows the edit itself. We pass only a size/shape diff-hint (not full HTML) to
   * keep the prompt small and the call fast.
   */
  private async summarizeEdit(
    prompt: string,
    oldHtml: string,
    newHtml: string
  ): Promise<string> {
    const fallback = 'Updated the app.';
    if (!CDZ_AI_KEY) {
      return fallback;
    }
    // Cheap structural diff-hint: byte delta + a coarse count of section-ish
    // landmarks so the model can describe the change without seeing the doc.
    const sectionCount = (html: string) =>
      (html.match(/<(section|header|footer|nav|main|article|form)\b/gi) || [])
        .length;
    const diffHint = [
      `bytes: ${oldHtml.length} -> ${newHtml.length} (delta ${newHtml.length - oldHtml.length})`,
      `sections: ${sectionCount(oldHtml)} -> ${sectionCount(newHtml)}`,
    ].join(', ');
    const summaryPrompt = [
      'You summarize a single edit made to a web app for a version history label.',
      'Return ONE short past-tense sentence (max ~12 words) describing what changed.',
      'No preamble, no quotes, no markdown. Example: "Added a pricing section with 3 tiers."',
      '',
      `USER REQUEST:\n${prompt.slice(0, 2000)}`,
      '',
      `CHANGE HINT: ${diffHint}`,
    ].join('\n');

    try {
      const response = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CDZ_AI_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'cdz-flash',
          messages: [{ role: 'user', content: summaryPrompt }],
          max_tokens: clampMaxTokens(60, 60),
        }),
        // fast-tier: never let the summary delay the edit response
        signal: AbortSignal.timeout(5000),
      });
      const data = (await response.json()) as any;
      const content = data?.choices?.[0]?.message?.content;
      if (response.ok && typeof content === 'string' && content.trim()) {
        // one line only; strip wrapping quotes/backticks the model may add
        return content
          .trim()
          .split('\n')[0]
          .replace(/^["'`]+|["'`]+$/g, '')
          .slice(0, 140);
      }
    } catch {
      // fall through to deterministic fallback
    }
    return fallback;
  }

  @Public()
  @Get(['/api/v1/models', '/v1/models'])
  models(@Req() req: Request) {
    this.assertBridgeToken(req);
    return {
      object: 'list',
      data: MODELS.map(id => ({
        id,
        object: 'model',
        created: now(),
        owned_by: id === 'dall-e-3' ? 'openai-images' : 'make.com',
      })),
    };
  }

  @Public()
  @Throttle('strict')
  @Post(['/api/v1/chat/completions', '/v1/chat/completions'])
  async chatCompletions(
    @Req() req: Request,
    @Body() body: any,
    @Res() res: Response
  ) {
    this.assertBridgeToken(req);
    const id = `chatcmpl_${Date.now()}`;
    const model = body?.model || 'clickdz-smart';
    const messages = normalizeMessages(body?.messages || []);
    const agentOverride = this.resolveAgentForRequest(model, messages);
    const content = await this.runMakeAgent(messages, model, agentOverride);

    if (body?.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`
      );
      const chunks = content.match(/.{1,48}(\s|$)/g) || [content];
      for (const chunk of chunks) {
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`
        );
      }
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.json(openAIChatResponse(id, model, content));
  }

  /** Fast Plan-mode preflight: one decisive question before the full model runs. */
  @Throttle('strict')
  @Post('/api/v1/plan/clarify')
  async clarifyPlan(@Body() body: any) {
    const request = String(body?.request || '').trim();
    if (!request) {
      throw new HttpException(
        {
          error: {
            message: 'A request is required',
            type: 'invalid_request_error',
            code: 'request_missing',
          },
        },
        HttpStatus.BAD_REQUEST
      );
    }
    // SECURITY: cap request size on this cost-triggering route (413).
    if (request.length > MAX_PROMPT_CHARS) {
      throw new PayloadTooLargeException(
        `Request is too long (max ${MAX_PROMPT_CHARS} characters)`
      );
    }

    const raw = await this.runFastPlanner(request);

    return parsePlanClarification(raw);
  }

  /** extract text from an attached image via the Make OCR scenario */
  private async ocrImageContext(fileUrl: string): Promise<string> {
    if (!MAKE_OCR_WEBHOOK_URL || !fileUrl) return '';
    // SECURITY (SSRF): fileUrl is user-supplied and gets fetched (server-side,
    // via the OCR scenario). Reject loopback/private/link-local/metadata
    // targets before use. On rejection, return empty OCR context so image
    // generation still proceeds (non-breaking) and log a warning.
    if (!isSafePublicUrl(fileUrl)) {
      this.logger.warn(
        `[ocr] rejected unsafe image URL (SSRF guard): ${String(fileUrl).slice(0, 120)}`
      );
      return '';
    }
    try {
      const response = await fetch(MAKE_OCR_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_url: fileUrl }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) return '';
      const data = (await response.json()) as { text?: string };
      return typeof data?.text === 'string' ? data.text.slice(0, 4000) : '';
    } catch {
      // OCR is best-effort context — never block generation on it
      return '';
    }
  }

  /** enhance a raw image prompt through the Make agent (best-effort) */
  private async enhanceImagePrompt(
    rawPrompt: string,
    ocrContext: string
  ): Promise<string> {
    try {
      const parts = [IMAGE_ENHANCER_GUIDELINES];
      if (ocrContext) {
        parts.push(
          `Content extracted from the user's attached reference image:\n"""${ocrContext}"""\nBlend this reference faithfully into the scene.`
        );
      }
      parts.push(`Request: ${rawPrompt}`);
      const enhanced = await this.runMakeAgent(
        [{ role: 'user', content: parts.join('\n\n') }],
        'clickdz-image-enhancer'
      );
      const cleaned = (enhanced || '').trim().replace(/^["'`]+|["'`]+$/g, '');
      // sanity: reject junk enhancements, keep the user's own words instead
      if (cleaned.length < 10 || cleaned.length > 4000) return rawPrompt;
      return cleaned;
    } catch {
      return rawPrompt;
    }
  }

  @Throttle('strict')
  @Post(['/api/v1/images/generations', '/v1/images/generations'])
  async imageGenerations(@Body() body: any) {
    if (!OPENAI_IMAGE_API_KEY) {
      throw new HttpException(
        { error: { message: 'OpenAI image generation key is not configured', type: 'configuration_error', code: 'openai_image_key_missing' } },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
    // SECURITY: this route hits the paid OpenAI images API. Validate input
    // defensively before doing any upstream work.
    if (typeof body?.prompt !== 'string' || !body.prompt.trim()) {
      throw new BadRequestException(
        'A non-empty "prompt" string is required'
      );
    }
    if (body.prompt.length > MAX_PROMPT_CHARS) {
      throw new PayloadTooLargeException(
        `Prompt is too long (max ${MAX_PROMPT_CHARS} characters)`
      );
    }

    const requestedModel = String(body?.model || '');
    const isClickDzImage = CLICKDZ_IMAGE_MODEL_IDS.has(requestedModel);

    let prompt = String(body?.prompt || '');
    let enhancedPrompt: string | undefined;
    let ocrUsed = false;
    if (isClickDzImage && prompt) {
      // ClickDz 1.0 pipeline: OCR reference (optional) -> Make enhancement
      const imageUrl =
        typeof body?.image_url === 'string' ? body.image_url : '';
      const ocrContext = imageUrl ? await this.ocrImageContext(imageUrl) : '';
      ocrUsed = !!ocrContext;
      enhancedPrompt = await this.enhanceImagePrompt(prompt, ocrContext);
      prompt = enhancedPrompt;
    }

    const model = isClickDzImage
      ? CLICKDZ_IMAGE_ENGINE
      : body?.model && body.model !== 'clickdz-image'
        ? body.model
        : 'dall-e-3';
    // gpt-image-1 rejects response_format/style and always returns b64_json;
    // dall-e-* accept response_format url. Build a valid payload for both.
    const isGptImage = String(model).startsWith('gpt-image');
    const payload: Record<string, unknown> = {
      model,
      prompt: prompt || body?.prompt || '',
      n: Math.min(Number(body?.n || 1), 1),
      size: body?.size || '1024x1024',
    };
    if (!isGptImage) {
      payload.response_format = body?.response_format || 'url';
      payload.style = body?.style || 'vivid';
    }
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_IMAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = (await response.json()) as any;
    if (!response.ok) {
      throw new HttpException(data, response.status);
    }
    // normalize: expose a data URL for b64 responses so url-consumers work
    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        if (item && !item.url && typeof item.b64_json === 'string') {
          item.url = `data:image/png;base64,${item.b64_json}`;
        }
      }
    }
    if (isClickDzImage) {
      data.clickdz = {
        model: 'clickdz-image-1.0',
        engine: CLICKDZ_IMAGE_ENGINE,
        enhanced_prompt: enhancedPrompt,
        reference_ocr_used: ocrUsed,
      };
    }
    return data;
  }

  /** deploy a single-file app to Vercel and wait briefly for it to go live */
  private async deployAppToVercel(slug: string, html: string) {
    const projectName = `clickdz-app-${slug}`.slice(0, 52);
    const teamQuery = VERCEL_TEAM_ID
      ? `?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`
      : '';
    const createRes = await fetch(
      `https://api.vercel.com/v13/deployments${teamQuery}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VERCEL_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: projectName,
          files: [{ file: 'index.html', data: html }],
          projectSettings: { framework: null },
          target: 'production',
        }),
        signal: AbortSignal.timeout(30000),
      }
    );
    const created = (await createRes.json()) as any;
    if (!createRes.ok) {
      throw new HttpException(
        { error: { message: created?.error?.message || 'Vercel deployment failed', type: 'provider_error', code: 'vercel_deploy_failed' } },
        HttpStatus.BAD_GATEWAY
      );
    }
    // poll briefly until the deployment is READY (static deploys are fast)
    let state = created.readyState as string;
    for (let i = 0; i < 10 && state !== 'READY' && state !== 'ERROR'; i++) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const pollRes = await fetch(
        `https://api.vercel.com/v13/deployments/${created.id}${teamQuery}`,
        {
          headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
          signal: AbortSignal.timeout(15000),
        }
      );
      const polled = (await pollRes.json()) as any;
      state = polled.readyState || state;
    }
    // never GUESS the live URL — Vercel may truncate long project names when
    // assigning the <project>.vercel.app domain, so read the real one
    let liveUrl = created.url ? `https://${created.url}` : undefined;
    try {
      const domainsRes = await fetch(
        `https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}/domains${teamQuery}`,
        {
          headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
          signal: AbortSignal.timeout(15000),
        }
      );
      const domains = (await domainsRes.json()) as any;
      const assigned =
        (domains?.domains || []).find(
          (d: any) => d.verified && String(d.name).endsWith('.vercel.app')
        ) ?? (domains?.domains || [])[0];
      if (assigned?.name) {
        liveUrl = `https://${assigned.name}`;
      }
    } catch {
      // keep the deployment-specific URL as a safe fallback
    }
    return {
      slug,
      state,
      url: liveUrl ?? `https://${projectName}.vercel.app`,
      deploymentUrl: created.url ? `https://${created.url}` : undefined,
    };
  }

  /**
   * SECURITY / validation: parse + bound the optional `history` and `selection`
   * fields from an /apps/generate body. Rejects malformed shapes with 400 and
   * oversized inputs with 413 (consistent with this route's existing caps),
   * then returns normalized values the prompt builder can consume directly.
   * Absent fields are fine: returns { history: undefined, selection: undefined }.
   */
  private parseAppEditContext(body: any): {
    history: AppHistoryTurn[] | undefined;
    selection: AppSelectionContext | null | undefined;
  } {
    // ----- history -----
    let history: AppHistoryTurn[] | undefined;
    if (body?.history != null) {
      if (!Array.isArray(body.history)) {
        throw new BadRequestException('"history" must be an array of turns');
      }
      if (body.history.length > MAX_HISTORY_TURNS) {
        throw new PayloadTooLargeException(
          `Too many history turns (max ${MAX_HISTORY_TURNS})`
        );
      }
      let total = 0;
      const turns: AppHistoryTurn[] = [];
      for (const turn of body.history) {
        if (!turn || typeof turn !== 'object') {
          throw new BadRequestException('Each history turn must be an object');
        }
        const role = (turn as any).role;
        const text = (turn as any).text;
        if (role !== 'user' && role !== 'assistant') {
          throw new BadRequestException(
            'Each history turn role must be "user" or "assistant"'
          );
        }
        if (typeof text !== 'string') {
          throw new BadRequestException('Each history turn text must be a string');
        }
        if (text.length > MAX_HISTORY_TURN_CHARS) {
          throw new PayloadTooLargeException(
            `A history turn is too long (max ${MAX_HISTORY_TURN_CHARS} characters)`
          );
        }
        total += text.length;
        turns.push({ role, text });
      }
      if (total > MAX_HISTORY_TOTAL_CHARS) {
        throw new PayloadTooLargeException(
          `History is too long (max ${MAX_HISTORY_TOTAL_CHARS} characters total)`
        );
      }
      history = turns.length ? turns : undefined;
    }

    // ----- selection -----
    let selection: AppSelectionContext | null | undefined;
    if (body?.selection != null) {
      const sel = body.selection;
      if (typeof sel !== 'object' || Array.isArray(sel)) {
        throw new BadRequestException('"selection" must be an object or null');
      }
      const tag = (sel as any).tag;
      const text = (sel as any).text;
      const descriptor = (sel as any).descriptor;
      if (typeof tag !== 'string') {
        throw new BadRequestException('"selection.tag" must be a string');
      }
      if (typeof text !== 'string') {
        throw new BadRequestException('"selection.text" must be a string');
      }
      if (text.length > MAX_SELECTION_TEXT_CHARS) {
        throw new PayloadTooLargeException(
          `selection.text is too long (max ${MAX_SELECTION_TEXT_CHARS} characters)`
        );
      }
      if (descriptor != null && typeof descriptor !== 'string') {
        throw new BadRequestException('"selection.descriptor" must be a string');
      }
      if (
        typeof descriptor === 'string' &&
        descriptor.length > MAX_SELECTION_DESCRIPTOR_CHARS
      ) {
        throw new PayloadTooLargeException(
          `selection.descriptor is too long (max ${MAX_SELECTION_DESCRIPTOR_CHARS} characters)`
        );
      }
      selection = {
        tag,
        text,
        ...(typeof descriptor === 'string' ? { descriptor } : {}),
      };
    }

    return { history, selection };
  }

  /** run the code agent to produce a complete single-file app (new or edited) */
  private async buildAppHtml(
    prompt: string,
    currentHtml?: string,
    history?: AppHistoryTurn[],
    selection?: AppSelectionContext | null
  ): Promise<string> {
    // Content construction (system prompt + edit-in-context transcript) now
    // lives in ./clickdz-app-prompt. The edit branch fires only when there is a
    // real working document; the builder slices currentHtml internally
    // (MAX_EDIT_HTML_CHARS), so we do NOT slice it again here.
    const isEdit = !!currentHtml && currentHtml.length > 20;
    const content = isEdit
      ? buildEditContent({
          prompt,
          currentHtml: currentHtml as string,
          history,
          selection,
        })
      : buildNewAppContent(prompt);
    const reply = await this.runMakeAgent(
      [{ role: 'user', content }],
      'clickdz-apps',
      MAKE_CODE_AGENT_ID || undefined
    );
    let html = extractHtmlApp(reply || '');
    if (!html) {
      throw new HttpException(
        { error: { message: 'The model did not return a valid app. Try rephrasing.', type: 'provider_error', code: 'app_generation_failed' } },
        HttpStatus.BAD_GATEWAY
      );
    }
    if (html.length > 400_000) html = html.slice(0, 400_000);
    return html;
  }

  /** GENERATE ONLY — returns full HTML for instant preview; does NOT deploy */
  @Throttle('strict')
  @Post('/api/v1/apps/generate')
  async generateApp(@Body() body: any) {
    const startedAt = Date.now();
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      throw new HttpException(
        { error: { message: 'A description of the app is required', type: 'invalid_request_error', code: 'prompt_missing' } },
        HttpStatus.BAD_REQUEST
      );
    }
    // SECURITY: this route runs the (paid) code agent. Cap input sizes.
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new PayloadTooLargeException(
        `Prompt is too long (max ${MAX_PROMPT_CHARS} characters)`
      );
    }
    if (
      typeof body?.currentHtml === 'string' &&
      body.currentHtml.length > MAX_HTML_CHARS
    ) {
      throw new PayloadTooLargeException(
        `currentHtml is too large (max ${MAX_HTML_CHARS} characters)`
      );
    }
    const currentHtml =
      typeof body?.currentHtml === 'string' ? body.currentHtml : undefined;
    // Validate + bound the optional edit-in-context fields (rejects malformed
    // shapes 400 / oversized inputs 413 per the canonical request bounds).
    const { history, selection } = this.parseAppEditContext(body);
    const slug =
      typeof body?.slug === 'string' && /^[a-z0-9-]{3,50}$/.test(body.slug)
        ? body.slug
        : slugifyAppName(prompt);
    this.logger.log(
      `[apps] generate (${currentHtml ? 'edit' : 'new'}) slug=${slug} prompt=${prompt.slice(0, 80)}`
    );
    let html = await this.buildAppHtml(prompt, currentHtml, history, selection);
    // wire the app to its own Data API namespace so preview + live share state
    const externalBase = (
      process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
    ).replace(/\/+$/, '');
    // Point new apps at the token-gated /v2 Data API and inject the per-slug
    // write token (P0 safety). Existing deployed apps keep using /v1.
    html = html
      .replaceAll(
        '__CLICKDZ_DATA_URL__',
        `${externalBase}/api/v2/apps-data/${slug}`
      )
      .replaceAll('__CLICKDZ_DATA_TOKEN__', dataWriteToken(slug));
    this.logger.log(
      `[apps] generated ${html.length} chars in ${Math.round((Date.now() - startedAt) / 1000)}s`
    );
    // "What changed" label for the version list. Only meaningful for edits (an
    // existing working doc); best-effort and never blocks/breaks the response.
    // Additive field — existing consumers ignore it, the app-builder reads it.
    const isEdit = !!currentHtml && currentHtml.length > 20;
    const summary = isEdit
      ? await this.summarizeEdit(prompt, currentHtml as string, html)
      : undefined;
    return {
      slug,
      prompt,
      html,
      bytes: html.length,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      ...(summary ? { summary } : {}),
    };
  }

  /** DEPLOY — takes reviewed HTML + slug, publishes to Vercel, returns URL */
  @Throttle('strict')
  @Post('/api/v1/apps/deploy')
  async deployApp(@Body() body: any) {
    if (!VERCEL_TOKEN) {
      throw new HttpException(
        { error: { message: 'Vercel deployment is not configured', type: 'configuration_error', code: 'vercel_token_missing' } },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
    // SECURITY: reject wrong-typed html before coercion (a non-string that
    // stringifies to garbage should not reach the deploy pipeline).
    if (body?.html != null && typeof body.html !== 'string') {
      throw new BadRequestException('"html" must be a string');
    }
    let html = String(body?.html || '');
    if (html.length < 20) {
      throw new HttpException(
        { error: { message: 'No app HTML to deploy', type: 'invalid_request_error', code: 'html_missing' } },
        HttpStatus.BAD_REQUEST
      );
    }
    // SECURITY: reject clearly-abusive oversize payloads (413) on this
    // Vercel-deploying route. The existing 400_000 truncation below still
    // trims normal-but-large apps (non-breaking).
    if (html.length > MAX_HTML_CHARS) {
      throw new PayloadTooLargeException(
        `App HTML is too large (max ${MAX_HTML_CHARS} characters)`
      );
    }
    if (html.length > 400_000) html = html.slice(0, 400_000);
    const slug =
      typeof body?.slug === 'string' && /^[a-z0-9-]{3,50}$/.test(body.slug)
        ? body.slug
        : slugifyAppName('app');
    if (!html.includes('Built with ClickDz') && html.includes('</body>')) {
      html = html.replace('</body>', `${CLICKDZ_APP_WATERMARK}</body>`);
    }
    this.logger.log(`[apps] deploying ${html.length} chars as slug=${slug}`);
    const deployed = await this.deployAppToVercel(slug, html);
    this.logger.log(`[apps] deployed: ${deployed.url} (${deployed.state})`);
    return { ...deployed, bytes: html.length };
  }

  @Throttle('strict')
  @Post('/api/voice/token')
  async deepgramToken() {
    if (!DEEPGRAM_API_KEY) {
      throw new HttpException({ error: 'Deepgram is not configured' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: 60 }),
    });
    const data = (await response.json()) as any;
    if (!response.ok) {
      throw new HttpException(data, response.status);
    }
    return data;
  }

  @Throttle('strict')
  @Post(['/api/voice/tts', '/api/copilot/voice/tts'])
  async tts(@Body() body: any, @Res() res: Response) {
    if (!DEEPGRAM_API_KEY) {
      throw new HttpException({ ok: false, error: 'Deepgram is not configured' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const model = body?.voice || 'aura-2-thalia-en';
    const response = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text: body?.text || '' }),
    });
    if (!response.ok) {
      throw new HttpException({ ok: false, error: `Deepgram TTS failed: ${response.status}` }, HttpStatus.BAD_GATEWAY);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
  }

  @Throttle('strict')
  @Post(['/api/voice/transcribe', '/api/copilot/voice/transcribe'])
  async transcribe() {
    if (!DEEPGRAM_API_KEY) {
      throw new HttpException({ ok: false, error: 'Deepgram is not configured' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {
      ok: false,
      error: 'Multipart transcription endpoint requires upload middleware; use Make.com STT webhook for browser audio uploads.',
    };
  }
}
