import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
// `@Res({ passthrough: true })` lets the repurpose route emit an exact 502 with
// a typed JSON body without a raw HttpException (mirrors telemetry.controller).
import type { Response } from 'express';
// SECURITY: crypto-strong randomness for unguessable auto project ids.
// `createHash` derives a STABLE key from a media src for the transcript
// side-store (never for secrets — just a namespacing digest).
import { createHash, randomBytes } from 'node:crypto';

// Typed AFFiNE errors so the global exception filter emits proper 4xx/5xx
// (a raw @nestjs/common HttpException is turned into a generic 500 here).
import { BadRequest, InternalServerError, NotFound, Throttle } from '../../base';
import { CacheRedis } from '../../base/redis';
import { CurrentUser, Public } from '../../core/auth';
import {
  buildVdzContextTurn,
  buildVdzModeInstruction,
  normalizeVdzHistory,
  VDZ_SYSTEM_PROMPT,
  type VdzHistoryTurn,
} from './clickdz-vdz-prompt';

/**
 * Vdz Studio backend — the "AI Dock" chat endpoint + a small per-user project
 * store for timelines.
 *
 * AUTH STANCE (mirrors the house): these are FIRST-PARTY web-app routes, the
 * same category as the bridge's /api/v1/apps/generate. They are NOT annotated
 * `@Public()`, so the global AuthGuard requires an authenticated user session
 * (the browser sends its cookie same-origin) and we get a real `CurrentUser`.
 * That is the identity we key projects by. This is deliberately NOT the
 * bridge-token stance of /chat/completions, which exists only for external
 * OpenAI-compatible machine clients; the dock is a signed-in user feature.
 *
 * ENGINE (mirrors the bridge chat route): we call the SAME Make AI-agent path
 * `runMakeAgent` uses, with the same MAKE_* env consts and the same
 * `CDZ_AI_KEY` direct-model fast path the bridge's planner uses as a fallback.
 * The bridge does not export these helpers, so the minimal call shape is
 * duplicated here (the backend must compile without importing the frontend and
 * we do not edit the bridge controller).
 */

// ---------------------------------------------------------------------------
// Engine config — read the SAME env consts the bridge reads.
// ---------------------------------------------------------------------------
const MAKE_API_BASE = process.env.MAKE_API_BASE || 'https://eu1.make.com/api/v2';
const MAKE_API_KEY = process.env.MAKE_API_KEY || '';
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID || '';
const MAKE_AGENT_ID =
  process.env.MAKE_SUPERAGENT_ID || process.env.MAKE_AGENT_ID || '';
const CDZ_AI_BASE_URL = (
  process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai'
).replace(/\/+$/, '');
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';

// ---------------------------------------------------------------------------
// Transcription (captions) — OpenAI Whisper. There is NO Gemini API key on
// this deployment (Gemini exists only as a Make chat engine) and Deepgram is
// wired for TTS, so Whisper is the one real STT path. Key cascade mirrors the
// bridge's images pattern, preferring a dedicated audio key when present.
// ---------------------------------------------------------------------------
const OPENAI_AUDIO_API_KEY =
  process.env.OPENAI_AUDIO_API_KEY ||
  process.env.OPEN_AI ||
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_IMAGE_API_KEY ||
  '';
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
// Whisper's own hard cap is 25MB; reject just under it. Audio arrives as RAW
// bytes (application/octet-stream) through the app's 100MB raw body parser —
// JSON would both bloat the payload ~33% and hit the express json limit.
const MAX_TRANSCRIBE_BYTES = 24 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Input caps for this cost/side-effecting route. Reject (not clamp) oversized
// or abusive payloads early, consistent with the bridge/data controllers.
// ---------------------------------------------------------------------------
const MAX_MESSAGE_CHARS = 4_000;
const MAX_TIMELINE_BYTES = 256 * 1024;
const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_TURN_CHARS = 4_000;
// Model call timeout — text-to-timeline generations are short; keep the cap
// well under the bridge's 240s so the dock fails fast.
const VDZ_MODEL_TIMEOUT_MS = 90_000;
const VDZ_MODEL_MAX_TOKENS = 2_000;
// Caps for the non-default modes' response arrays (defensive; the prompt asks
// for far fewer). Bounds a pathological model reply, mirroring MAX_OPS caps.
const MAX_PLAN_STEPS = 12;
const MAX_SUGGESTIONS = 8;

// ---------------------------------------------------------------------------
// Project store caps (mirror the apps-data controller conventions).
// ---------------------------------------------------------------------------
const MAX_PROJECTS_PER_OWNER = 50;
const MAX_PROJECT_NAME_CHARS = 200;
const PROJECT_TTL_SECONDS = 90 * 24 * 60 * 60;
// Redis key namespace requested for Vdz projects.
const projectKey = (ownerId: string, projectId: string) =>
  `clickdz:vdz:project:${ownerId}:${projectId}`;
const projectIndexKey = (ownerId: string) =>
  `clickdz:vdz:project-index:${ownerId}`;

const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Public share links. A share is a SELF-CONTAINED SNAPSHOT (the client inlines
// workspace media as data: URIs before upload — vdz-blob: handles mean nothing
// to a signed-out viewer). Uploaded as RAW bytes through the 100MB raw parser
// (same pattern as /transcribe; a media-inlined timeline routinely exceeds the
// express json limit). One share per project, reused/updated on re-share.
// ---------------------------------------------------------------------------
const MAX_SHARE_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const SHARE_TTL_SECONDS = PROJECT_TTL_SECONDS;
const SHARE_ID_RE = /^[a-zA-Z0-9_-]{10,64}$/;
const shareKey = (shareId: string) => `clickdz:vdz:share:${shareId}`;
const shareOfProjectKey = (ownerId: string, projectId: string) =>
  `clickdz:vdz:share-of:${ownerId}:${projectId}`;

// ---------------------------------------------------------------------------
// Transcript side-store (C1) — Redis, NO schema change. Caches the expensive
// Whisper result keyed by a STABLE hash of the media src so it survives clip
// splits (both halves share the source, sliced by their own window). Value:
// { src, words: [{w,t0,t1}], language?, updatedAt } in media-time seconds.
//
// SCOPING NOTE: `CurrentUser` here carries only user identity (id/email/…),
// NOT a workspaceId — no vdz route in this controller has a clean workspace
// handle (projects/shares are all keyed by user.id). So the transcript key is
// scoped by USER id, mirroring the projects store. The key template keeps a
// `<scope>` segment so a future workspace handle drops in without a reshape.
// ---------------------------------------------------------------------------
const TRANSCRIPT_TTL_SECONDS = 30 * 24 * 60 * 60;
// Defensive cap on stored words (never store raw media, only word timings).
const MAX_TRANSCRIPT_WORDS = 5_000;
const MAX_TRANSCRIPT_SRC_CHARS = 2_048;
const MAX_TRANSCRIPT_LANGUAGE_CHARS = 32;
// A stable, url-safe digest of the media src — the key suffix. sha256 hex,
// sliced to 32 chars (128 bits) is collision-safe for this per-user namespace
// and keeps the Redis key short. NOT a security token.
const srcHash = (src: string): string =>
  createHash('sha256').update(src).digest('hex').slice(0, 32);
const transcriptKey = (scopeId: string, src: string) =>
  `clickdz:vdz:transcript:${scopeId}:${srcHash(src)}`;

/** A stored transcript side-store document (media-time seconds). */
interface VdzTranscriptDoc {
  src: string;
  words: Array<{ w: string; t0: number; t1: number }>;
  language?: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Long→short repurpose (C2) — one-shot cdz-flash scoring of the source into
// ranked short segments. Reuses this controller's runVdzModel engine call +
// extractVdzResponse fail-closed parse (same idiom as /chat).
// ---------------------------------------------------------------------------
const REPURPOSE_DEFAULT_COUNT = 6;
const REPURPOSE_MIN_COUNT = 3;
const REPURPOSE_MAX_COUNT = 12;
const REPURPOSE_MIN_SHORT_SECONDS = 15;
const REPURPOSE_MAX_SHORT_SECONDS = 60;
// Safe token budget for the transcript fed to the planner (~6000 chars).
const REPURPOSE_MAX_TRANSCRIPT_CHARS = 6_000;

/** A single ranked short segment returned by the repurpose planner. */
interface VdzShort {
  startSec: number;
  endSec: number;
  title: string;
  hook: string;
  score: number;
}

/** A stored public share document. `timeline` is the inlined snapshot. */
interface VdzShareDoc {
  shareId: string;
  ownerId: string;
  projectId: string;
  name: string;
  timeline: unknown;
  sharedAt: string;
}

/** A stored project document. `timeline` is opaque JSON (validated by size). */
interface VdzProjectDoc {
  id: string;
  name: string;
  timeline: unknown;
  createdAt: string;
  updatedAt: string;
}

/** The compact list-view row (never returns the full timeline). */
interface VdzProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Engine response parsing — the Make agent returns the model text wrapped in a
// small envelope; unwrap to the raw string (mirrors the bridge's parser).
// ---------------------------------------------------------------------------
function parseMakeAgentResponse(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
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
    if (typeof obj.response === 'string') {
      return parseMakeAgentResponse(obj.response);
    }
  }
  return '';
}

/** The fields we pull out of a raw model reply (all opaque until validated). */
interface ExtractedVdzResponse {
  summary: unknown;
  ops: unknown;
  /** Only present for a plan-mode reply (parsed leniently downstream). */
  plan?: unknown;
  /** Only present for a suggestions-mode reply. */
  suggestions?: unknown;
}

/**
 * Fail-closed lenient parse of a raw model reply into a plain JSON object.
 * Prefers a clean `JSON.parse`; if the model wrapped it in prose or ``` fences,
 * strips fences and slices the outermost `{...}`. Returns the parsed object on
 * success, or null when nothing object-shaped is present. Shared by
 * `extractVdzResponse` (chat) and the repurpose route so both use the SAME
 * fail-closed parse idiom.
 */
function parseLenientJsonObject(raw: string): Record<string, unknown> | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  };
  // 1) clean parse
  const direct = tryParse(text);
  if (direct) return direct;
  // 2) strip ``` / ```json fences and retry
  const unfenced = text
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  const fenced = tryParse(unfenced);
  if (fenced) return fenced;
  // 3) slice the outermost object and retry
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const sliced = tryParse(unfenced.slice(start, end + 1));
    if (sliced) return sliced;
  }
  return null;
}

/**
 * Best-effort extraction of the strict response JSON object from a raw model
 * reply. Returns the parsed object on success (carrying `summary`, `ops`, and —
 * when present — `plan` / `suggestions` for the non-default modes), or null when
 * nothing parseable is present. Extra fields are harmless: a mode that doesn't
 * use them ignores them.
 */
function extractVdzResponse(raw: string): ExtractedVdzResponse | null {
  const parsed = parseLenientJsonObject(raw);
  if (!parsed) return null;
  return {
    summary: parsed.summary,
    ops: parsed.ops,
    plan: parsed.plan,
    suggestions: parsed.suggestions,
  };
}

/** A normalized plan step returned to the client. */
interface VdzPlanStep {
  step: string;
  action: string;
}

/**
 * Coerce an unknown `plan` value into a clean `VdzPlanStep[]`, defensively.
 * Tolerates `{step, action}`, `{title, action}`, and bare strings so a slightly
 * off model reply still yields a usable checklist. Returns [] when nothing
 * plan-shaped is present (the controller then treats the turn as normal).
 */
function coercePlan(value: unknown): VdzPlanStep[] {
  if (!Array.isArray(value)) return [];
  const steps: VdzPlanStep[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const step = entry.trim();
      if (step) steps.push({ step, action: step });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const step =
        typeof obj.step === 'string'
          ? obj.step.trim()
          : typeof obj.title === 'string'
            ? obj.title.trim()
            : '';
      const action =
        typeof obj.action === 'string' && obj.action.trim()
          ? obj.action.trim()
          : step;
      if (step) steps.push({ step, action });
    }
    if (steps.length >= MAX_PLAN_STEPS) break;
  }
  return steps;
}

/** Coerce an unknown `suggestions` value into a clean, capped `string[]`. */
function coerceSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

/** Read a request `mode`, defaulting anything unknown to 'edit'. */
function parseMode(raw: unknown): 'edit' | 'plan' | 'suggestions' {
  return raw === 'plan' || raw === 'suggestions' ? raw : 'edit';
}

/** Clamp `n` into [lo, hi]; non-finite → `lo`. */
function clampNumber(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Coerce an unknown `words` value into a clean `[{w,t0,t1}]` array of media-time
 * seconds, dropping malformed entries and capping length defensively. Mirrors
 * the normalization the /transcribe route already applies to Whisper output.
 */
function coerceTranscriptWords(
  value: unknown
): Array<{ w: string; t0: number; t1: number }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ w: string; t0: number; t1: number }> = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    const w = typeof obj.w === 'string' ? obj.w : '';
    if (!w.trim()) continue;
    const t0 = Number(obj.t0);
    const t1 = Number(obj.t1);
    out.push({
      w,
      t0: Number.isFinite(t0) ? t0 : 0,
      t1: Number.isFinite(t1) ? t1 : 0,
    });
    if (out.length >= MAX_TRANSCRIPT_WORDS) break;
  }
  return out;
}

/**
 * Build the two-message conversation for the repurpose planner. Reuses the same
 * `{role, content}` shape runVdzModel consumes. The transcript (if any) is
 * rendered as compact `t0-t1: word` lines, already truncated to a safe char
 * budget by the caller. Asks for STRICT JSON `{ shorts: [...] }` so the shared
 * extractVdzResponse parser can lift it fail-closed.
 */
function buildRepurposePrompt(
  transcriptText: string,
  durationSec: number,
  count: number
): Array<{ role: string; content: string }> {
  const system =
    'You are a short-form video editor. You are given the transcript (with ' +
    'media-time word timings in seconds) and total duration of a long video. ' +
    'Identify the most engaging, self-contained moments to cut into vertical ' +
    'shorts. Reply with STRICT JSON only — no prose, no code fences.';
  const instruction = [
    `Return exactly ${count} ranked short segments as JSON:`,
    '{"shorts":[{"startSec":number,"endSec":number,"title":string,"hook":string,"score":number}]}',
    `- Each segment MUST be between ${REPURPOSE_MIN_SHORT_SECONDS} and ${REPURPOSE_MAX_SHORT_SECONDS} seconds long.`,
    `- startSec and endSec MUST be within [0, ${Math.floor(durationSec)}] and startSec < endSec.`,
    '- score is 0..1 (higher = more viral / self-contained). Sort by score descending.',
    '- title: <=60 chars punchy title. hook: <=120 chars opening line.',
    '- Segments should not overlap. Prefer complete thoughts.',
    `Total video duration: ${Math.floor(durationSec)}s.`,
    transcriptText
      ? `Transcript (mediaSeconds: text):\n${transcriptText}`
      : 'No transcript is available — infer evenly spaced highlight windows across the duration.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: instruction },
  ];
}

/**
 * Coerce an unknown planner reply's `shorts` value into clean, clamped
 * `VdzShort[]`: each 15–60s within [0, durationSec], sorted by score desc, and
 * capped to `count`. Returns [] when nothing usable is present (fail-closed).
 */
function coerceShorts(
  value: unknown,
  durationSec: number,
  count: number
): VdzShort[] {
  if (!Array.isArray(value)) return [];
  const out: VdzShort[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    let startSec = Number(obj.startSec);
    let endSec = Number(obj.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    // Clamp into the source window, then enforce a valid 15–60s span.
    startSec = clampNumber(startSec, 0, durationSec);
    endSec = clampNumber(endSec, 0, durationSec);
    if (endSec <= startSec) continue;
    let span = endSec - startSec;
    if (span < REPURPOSE_MIN_SHORT_SECONDS) {
      // Grow the window to the minimum, preferring to extend forward, then back.
      endSec = clampNumber(
        startSec + REPURPOSE_MIN_SHORT_SECONDS,
        0,
        durationSec
      );
      startSec = clampNumber(endSec - REPURPOSE_MIN_SHORT_SECONDS, 0, endSec);
      span = endSec - startSec;
      // Source too short to host even a minimum-length short → skip.
      if (span < REPURPOSE_MIN_SHORT_SECONDS) continue;
    } else if (span > REPURPOSE_MAX_SHORT_SECONDS) {
      endSec = startSec + REPURPOSE_MAX_SHORT_SECONDS;
    }
    const title =
      typeof obj.title === 'string' && obj.title.trim()
        ? obj.title.trim().slice(0, 120)
        : 'Untitled short';
    const hook =
      typeof obj.hook === 'string' && obj.hook.trim()
        ? obj.hook.trim().slice(0, 240)
        : '';
    const rawScore = Number(obj.score);
    const score = Number.isFinite(rawScore)
      ? clampNumber(rawScore, 0, 1)
      : 0;
    out.push({
      startSec: Math.round(startSec * 1000) / 1000,
      endSec: Math.round(endSec * 1000) / 1000,
      title,
      hook,
      score,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, count);
}

@Controller()
export class ClickDzVdzController {
  private readonly logger = new Logger(ClickDzVdzController.name);

  constructor(private readonly redis: CacheRedis) {}

  // -------------------------------------------------------------------------
  // Engine call — SAME shape as the bridge's runMakeAgent, with the same
  // CDZ_AI_KEY direct-model fast path the bridge's planner uses as a fallback.
  // -------------------------------------------------------------------------
  private assertEngineReady() {
    // Either a direct chat model (CDZ_AI_KEY) or the Make agent must be
    // configured. Typed 500 rather than a raw HttpException.
    if (!CDZ_AI_KEY && !(MAKE_API_KEY && MAKE_TEAM_ID && MAKE_AGENT_ID)) {
      throw new InternalServerError(
        'The Vdz AI engine is not configured on this server'
      );
    }
  }

  private async runVdzModel(
    messages: Array<{ role: string; content: string }>
  ): Promise<string> {
    this.assertEngineReady();

    // Fast path: a direct OpenAI-compatible chat model, if configured. This is
    // the same endpoint/shape the bridge's runFastPlanner prefers.
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
            messages,
            max_tokens: VDZ_MODEL_MAX_TOKENS,
          }),
          signal: AbortSignal.timeout(VDZ_MODEL_TIMEOUT_MS),
        });
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = data?.choices?.[0]?.message?.content;
        if (response.ok && typeof content === 'string' && content.trim()) {
          return content;
        }
        // fall through to the Make agent if the direct model errored/empty
      } catch {
        // fall through to the Make agent so the dock stays available
      }
    }

    // Make AI-agent path — mirrors the bridge's runMakeAgent call shape.
    if (!(MAKE_API_KEY && MAKE_TEAM_ID && MAKE_AGENT_ID)) {
      throw new InternalServerError('The Vdz AI engine is not configured');
    }
    const joined = messages
      .map(message => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n');
    const response = await fetch(
      `${MAKE_API_BASE}/ai-agents/v1/agents/${MAKE_AGENT_ID}/run?teamId=${MAKE_TEAM_ID}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${MAKE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: joined }],
          config: {},
        }),
        signal: AbortSignal.timeout(VDZ_MODEL_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      throw new InternalServerError(
        `Vdz AI engine request failed: ${response.status} ${response.statusText}`
      );
    }
    const data = (await response.json()) as Record<string, unknown>;
    return parseMakeAgentResponse(data.response ?? data);
  }

  // -------------------------------------------------------------------------
  // Request validation helpers.
  // -------------------------------------------------------------------------
  private validateTimelineSize(timeline: unknown): void {
    if (timeline == null || typeof timeline !== 'object') {
      throw new BadRequest('"timeline" must be a JSON object');
    }
    let json: string;
    try {
      json = JSON.stringify(timeline);
    } catch {
      throw new BadRequest('"timeline" must be serializable JSON');
    }
    if (Buffer.byteLength(json, 'utf8') > MAX_TIMELINE_BYTES) {
      throw new BadRequest(
        `"timeline" is too large (max ${MAX_TIMELINE_BYTES / 1024}KB serialized)`
      );
    }
  }

  private parseHistory(raw: unknown): VdzHistoryTurn[] | undefined {
    if (raw == null) return undefined;
    if (!Array.isArray(raw)) {
      throw new BadRequest('"history" must be an array of turns');
    }
    if (raw.length > MAX_HISTORY_TURNS) {
      throw new BadRequest(`Too many history turns (max ${MAX_HISTORY_TURNS})`);
    }
    const turns: VdzHistoryTurn[] = [];
    for (const turn of raw) {
      if (!turn || typeof turn !== 'object') {
        throw new BadRequest('Each history turn must be an object');
      }
      const role = (turn as { role?: unknown }).role;
      const content = (turn as { content?: unknown }).content;
      if (role !== 'user' && role !== 'assistant') {
        throw new BadRequest(
          'Each history turn role must be "user" or "assistant"'
        );
      }
      if (typeof content !== 'string') {
        throw new BadRequest('Each history turn content must be a string');
      }
      if (content.length > MAX_HISTORY_TURN_CHARS) {
        throw new BadRequest(
          `A history turn is too long (max ${MAX_HISTORY_TURN_CHARS} characters)`
        );
      }
      turns.push({ role, content });
    }
    return turns.length ? turns : undefined;
  }

  private parseSelectedClipIds(raw: unknown): string[] {
    if (raw == null) return [];
    if (!Array.isArray(raw)) {
      throw new BadRequest('"selectedClipIds" must be an array of strings');
    }
    return raw.filter(
      (id): id is string => typeof id === 'string' && id.length > 0
    );
  }

  // =========================================================================
  // POST /api/v1/vdz/chat — the AI Dock turn.
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/vdz/chat')
  async chat(
    @CurrentUser() user: CurrentUser,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response
  ): Promise<
    | {
        summary: string;
        ops: unknown[];
        plan?: VdzPlanStep[];
        suggestions?: string[];
        raw?: string;
      }
    | { error: { message: string; code: string } }
  > {
    const payload = (body ?? {}) as Record<string, unknown>;

    const message =
      typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) {
      throw new BadRequest('A non-empty "message" string is required');
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      throw new BadRequest(
        `"message" is too long (max ${MAX_MESSAGE_CHARS} characters)`
      );
    }

    this.validateTimelineSize(payload.timeline);
    const selectedClipIds = this.parseSelectedClipIds(payload.selectedClipIds);
    const history = this.parseHistory(payload.history);
    // Unknown/absent mode → 'edit' (the default contract). Never rejects, so an
    // old client that omits `mode` keeps working unchanged.
    const mode = parseMode(payload.mode);

    // Build the conversation: system prompt, then (for a non-default mode) the
    // mode instruction, a compact context turn (timeline JSON + selection), the
    // prior chat history, then the new user message.
    const modeInstruction = buildVdzModeInstruction(mode);
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: VDZ_SYSTEM_PROMPT },
      ...(modeInstruction
        ? [{ role: 'system', content: modeInstruction }]
        : []),
      {
        role: 'user',
        content: buildVdzContextTurn({
          timeline: payload.timeline,
          selectedClipIds,
        }),
      },
      ...normalizeVdzHistory(history).map(turn => ({
        role: turn.role,
        content: turn.content,
      })),
      { role: 'user', content: message },
    ];

    this.logger.log(
      `[vdz] chat user=${user.id} mode=${mode} selected=${selectedClipIds.length} history=${history?.length ?? 0} msg=${message.slice(0, 80)}`
    );

    // Engine failures must NOT surface as a 500. This route previously awaited
    // runVdzModel() unguarded, so a server with no CDZ_AI_KEY (and no Make
    // triple) threw InternalServerError straight through the filter and the AI
    // dock rendered the useless « Vdz AI request failed (500) ». The sibling
    // repurpose() route in this same file already does it correctly; /chat just
    // never got the same treatment.
    //
    // Two distinct outcomes, both non-500 and both carrying a message the dock
    // can actually show (the client reads error.message before falling back to
    // the bare status):
    //   • not configured  -> 503, a deployment fact the operator must fix
    //   • upstream failed -> 502, transient, worth retrying
    const engineConfigured =
      !!CDZ_AI_KEY || !!(MAKE_API_KEY && MAKE_TEAM_ID && MAKE_AGENT_ID);
    if (!engineConfigured) {
      this.logger.warn(
        '[vdz] chat unavailable: no CDZ_AI_KEY and no complete Make agent triple configured'
      );
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        error: {
          code: 'vdz_engine_unconfigured',
          message:
            "Vdz AI n'est pas configuré sur ce serveur. Ajoutez CDZ_AI_KEY (ou la configuration Make) pour activer les modifications par IA.",
        },
      };
    }

    let rawReply: string;
    try {
      rawReply = await this.runVdzModel(messages);
    } catch {
      res.status(HttpStatus.BAD_GATEWAY);
      return {
        error: {
          code: 'vdz_engine_unavailable',
          message:
            "Le moteur Vdz AI n'a pas répondu. Réessayez dans un instant.",
        },
      };
    }

    // Server-side sanity parse. The client re-validates each op with the Zod
    // schema before applying, so we only need to guarantee a well-formed
    // envelope here and degrade gracefully otherwise (200).
    const parsed = extractVdzResponse(rawReply);
    if (!parsed) {
      return {
        summary: 'AI returned an unparseable response',
        ops: [],
        raw: (rawReply ?? '').slice(0, 2_000),
      };
    }
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Proposed timeline edit';
    const ops = Array.isArray(parsed.ops) ? parsed.ops : [];

    // Mode-specific fields, parsed leniently. We attach them only when the
    // matching mode asked for them AND the model actually returned them, so an
    // edit-mode turn is byte-identical to before. Falling back is automatic: if
    // plan/suggestions come back empty, the client sees a normal {summary, ops}
    // turn and treats it as such.
    if (mode === 'plan') {
      const plan = coercePlan(parsed.plan);
      if (plan.length) return { summary, ops, plan };
    } else if (mode === 'suggestions') {
      const suggestions = coerceSuggestions(parsed.suggestions);
      if (suggestions.length) return { summary, ops, suggestions };
    }
    return { summary, ops };
  }

  // =========================================================================
  // Projects CRUD — Redis, keyed by the authenticated user's id.
  // =========================================================================

  private async readOwnedIds(ownerId: string): Promise<string[]> {
    const ids = await this.redis.smembers(projectIndexKey(ownerId));
    return Array.isArray(ids) ? ids : [];
  }

  private async readProject(
    ownerId: string,
    projectId: string
  ): Promise<VdzProjectDoc | null> {
    const raw = await this.redis.get(projectKey(ownerId, projectId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as VdzProjectDoc;
    } catch {
      return null;
    }
  }

  /** GET /api/v1/vdz/projects — compact list (id, name, updatedAt only). */
  /**
   * POST /api/v1/vdz/transcribe — speech-to-text for caption generation.
   *
   * BODY: the RAW audio bytes with `Content-Type: application/octet-stream`
   * (routed through the app's 100MB raw parser). QUERY: `?mime=` the real
   * audio mime for the STT engine, `?name=` an optional filename hint.
   *
   * Engine: OpenAI `whisper-1` with `verbose_json` + segment timestamps —
   * the response is a compact `{ text, segments: [{start, end, text}] }`
   * (seconds relative to the audio head) the client maps onto caption clips.
   * Same auth stance as every vdz route: session cookie, real CurrentUser.
   */
  @Throttle('strict')
  @Post('/api/v1/vdz/transcribe')
  async transcribe(
    @CurrentUser() user: CurrentUser,
    @Body() body: unknown,
    @Query('mime') mime?: string,
    @Query('name') name?: string
  ): Promise<{
    text: string;
    segments: Array<{
      start: number;
      end: number;
      text: string;
      // Per-word timings (absolute audio seconds), present when Whisper aligned
      // words for this segment. ADDITIVE — old clients ignore the extra field.
      words?: Array<{ w: string; t0: number; t1: number }>;
    }>;
  }> {
    if (!OPENAI_AUDIO_API_KEY) {
      throw new InternalServerError(
        'Transcription is not configured on this deployment'
      );
    }
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequest(
        'Send the raw audio bytes with Content-Type: application/octet-stream'
      );
    }
    if (body.length > MAX_TRANSCRIBE_BYTES) {
      throw new BadRequest(
        `Audio too large for transcription (max ${Math.floor(
          MAX_TRANSCRIBE_BYTES / (1024 * 1024)
        )}MB)`
      );
    }
    // Sanitize the client-supplied hints (they only shape the upload part).
    const safeMime =
      typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mime)
        ? mime
        : 'audio/mpeg';
    const safeName =
      typeof name === 'string' && name.trim()
        ? name.trim().slice(0, 120).replace(/[^\w.\- ]+/g, '_')
        : 'audio';

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(body)], { type: safeMime }),
      safeName
    );
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    // Request BOTH word- and segment-level timestamps. Whisper's multipart API
    // takes a repeated `timestamp_granularities[]` field (one append per value).
    // `word` populates a top-level `words:[{word,start,end}]` array (absolute
    // audio seconds) that we distribute back onto segments below; `segment`
    // keeps the segment list we already relied on. Word timing adds a little
    // latency but no cost, and old behaviour (segments) is unchanged.
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');

    const res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_AUDIO_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    }).catch(() => null);
    if (!res) {
      throw new InternalServerError('Transcription service unreachable');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(
        `[vdz] transcribe upstream ${res.status} user=${user.id} bytes=${body.length} detail=${detail.slice(0, 300)}`
      );
      // Payload-shaped failures (bad/unsupported audio) are the caller's to
      // fix; everything else is on us/the upstream.
      if (res.status === 400 || res.status === 415 || res.status === 422) {
        throw new BadRequest(
          'The audio could not be transcribed (unsupported or corrupt format)'
        );
      }
      throw new InternalServerError(`Transcription failed (${res.status})`);
    }

    const data = (await res.json().catch(() => null)) as {
      text?: unknown;
      segments?: unknown;
      words?: unknown;
    } | null;
    if (!data) {
      throw new InternalServerError('Transcription returned malformed JSON');
    }
    const text = typeof data.text === 'string' ? data.text.trim() : '';

    // Word timestamps arrive as a TOP-LEVEL `words:[{word,start,end}]` array
    // (verbose_json + timestamp_granularities['word']), NOT nested per segment.
    // Normalize them to `{ w, t0, t1 }` (absolute audio seconds) once, then
    // distribute each onto the segment whose window contains its MIDPOINT (so a
    // word lands in exactly one segment even at a boundary). Absent/empty on an
    // engine that didn't align words → segments simply carry no `words`.
    const allWords = (Array.isArray(data.words) ? data.words : [])
      .map(raw => {
        const w = (raw ?? {}) as Record<string, unknown>;
        return {
          w: typeof w.word === 'string' ? w.word : '',
          t0: Number(w.start) || 0,
          t1: Number(w.end) || 0,
        };
      })
      .filter(w => w.w.trim().length > 0);

    const segments = (Array.isArray(data.segments) ? data.segments : [])
      .map(raw => {
        const s = (raw ?? {}) as Record<string, unknown>;
        const start = Number(s.start) || 0;
        const end = Number(s.end) || 0;
        // Collect the words whose midpoint falls inside this segment window.
        const words = allWords.filter(w => {
          const mid = (w.t0 + w.t1) / 2;
          return mid >= start && mid < end;
        });
        return {
          start,
          end,
          text: typeof s.text === 'string' ? s.text.trim() : '',
          // Only attach when non-empty so a segment stays byte-identical when
          // there are no aligned words (fully additive for old clients).
          ...(words.length > 0 ? { words } : {}),
        };
      })
      .filter(s => s.text.length > 0 && s.end > s.start);

    this.logger.log(
      `[vdz] transcribe user=${user.id} bytes=${body.length} segments=${segments.length} words=${allWords.length}`
    );
    return { text, segments };
  }

  // =========================================================================
  // Transcript side-store (C1) — Redis, no schema change. Caches a media
  // transcript keyed by a stable hash of its src so it survives clip splits.
  // Scoped by user.id (this controller has no clean workspace handle — see the
  // note on transcriptKey). Same auth stance as every vdz route.
  // =========================================================================

  /**
   * POST /api/v1/vdz/transcript — cache a media transcript.
   * Body: `{ src, words: [{w,t0,t1}], language? }` (media-time seconds). Words
   * are capped defensively; raw media is NEVER stored. Rolling 30-day TTL.
   */
  @Throttle('strict')
  @Post('/api/v1/vdz/transcript')
  async saveTranscript(
    @CurrentUser() user: CurrentUser,
    @Body() body: unknown
  ): Promise<{ ok: true }> {
    const payload = (body ?? {}) as Record<string, unknown>;

    const src = typeof payload.src === 'string' ? payload.src.trim() : '';
    if (!src) {
      throw new BadRequest('A non-empty "src" string is required');
    }
    if (src.length > MAX_TRANSCRIPT_SRC_CHARS) {
      throw new BadRequest(
        `"src" is too long (max ${MAX_TRANSCRIPT_SRC_CHARS} characters)`
      );
    }
    const words = coerceTranscriptWords(payload.words);
    const language =
      typeof payload.language === 'string' && payload.language.trim()
        ? payload.language.trim().slice(0, MAX_TRANSCRIPT_LANGUAGE_CHARS)
        : undefined;

    const doc: VdzTranscriptDoc = {
      src,
      words,
      ...(language ? { language } : {}),
      updatedAt: new Date().toISOString(),
    };
    // Scope by user.id (no workspace handle on CurrentUser here).
    await this.redis.set(
      transcriptKey(user.id, src),
      JSON.stringify(doc),
      'EX',
      TRANSCRIPT_TTL_SECONDS
    );
    // NEVER log the src/key contents beyond a length — keys can embed blob ids.
    this.logger.log(
      `[vdz] transcript save user=${user.id} words=${words.length}${language ? ` lang=${language}` : ''}`
    );
    return { ok: true };
  }

  /**
   * GET /api/v1/vdz/transcript?src=<src> — read a cached transcript.
   * Returns `{ words, language? }` or `{ words: [] }` when none is stored.
   */
  @Throttle('strict')
  @Get('/api/v1/vdz/transcript')
  async getTranscript(
    @CurrentUser() user: CurrentUser,
    @Query('src') src?: string
  ): Promise<{
    words: Array<{ w: string; t0: number; t1: number }>;
    language?: string;
  }> {
    const key = typeof src === 'string' ? src.trim() : '';
    if (!key) {
      throw new BadRequest('A non-empty "src" query parameter is required');
    }
    if (key.length > MAX_TRANSCRIPT_SRC_CHARS) {
      throw new BadRequest(
        `"src" is too long (max ${MAX_TRANSCRIPT_SRC_CHARS} characters)`
      );
    }
    const raw = await this.redis.get(transcriptKey(user.id, key));
    if (!raw) return { words: [] };
    let doc: VdzTranscriptDoc;
    try {
      doc = JSON.parse(raw) as VdzTranscriptDoc;
    } catch {
      // Corrupt cache entry degrades to "no transcript" rather than 500.
      return { words: [] };
    }
    const words = Array.isArray(doc.words) ? doc.words : [];
    return doc.language ? { words, language: doc.language } : { words };
  }

  // =========================================================================
  // Long→short repurpose (C2) — one-shot cdz-flash scoring into ranked shorts.
  // Reuses runVdzModel (the cdz-flash engine call) + extractVdzResponse
  // (fail-closed JSON parse). Planner-down/parse-fail → typed 502.
  // =========================================================================

  /**
   * POST /api/v1/vdz/repurpose — rank the source into short segments.
   * Body: `{ transcript?: [{w,t0,t1}], durationSec, count? }`. Returns
   * `{ shorts: [{startSec,endSec,title,hook,score}] }`: count default 6
   * (clamped 3–12), each 15–60s within [0, durationSec], sorted by score desc.
   * Planner unavailable or an unparseable reply → typed 502
   * `{ error: 'repurpose_unavailable' }` (NEVER a raw HttpException).
   */
  @Throttle('strict')
  @Post('/api/v1/vdz/repurpose')
  async repurpose(
    @CurrentUser() user: CurrentUser,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ shorts: VdzShort[] } | { error: 'repurpose_unavailable' }> {
    const payload = (body ?? {}) as Record<string, unknown>;

    const durationSec = Number(payload.durationSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new BadRequest('"durationSec" must be a positive number');
    }
    // The source must be long enough to host at least one minimum-length short.
    if (durationSec < REPURPOSE_MIN_SHORT_SECONDS) {
      throw new BadRequest(
        `"durationSec" must be at least ${REPURPOSE_MIN_SHORT_SECONDS} seconds to repurpose`
      );
    }
    const count =
      payload.count == null
        ? REPURPOSE_DEFAULT_COUNT
        : Math.round(
            clampNumber(
              Number(payload.count),
              REPURPOSE_MIN_COUNT,
              REPURPOSE_MAX_COUNT
            )
          );

    // Render the (optional) transcript as compact `t0-t1: word` lines and
    // truncate to a safe token budget before it reaches the planner.
    const words = coerceTranscriptWords(payload.transcript);
    let transcriptText = words
      .map(w => `${w.t0.toFixed(1)}-${w.t1.toFixed(1)}: ${w.w}`)
      .join('\n');
    if (transcriptText.length > REPURPOSE_MAX_TRANSCRIPT_CHARS) {
      transcriptText = transcriptText.slice(0, REPURPOSE_MAX_TRANSCRIPT_CHARS);
    }

    this.logger.log(
      `[vdz] repurpose user=${user.id} duration=${Math.floor(durationSec)} count=${count} words=${words.length}`
    );

    // Run the SAME cdz-flash engine call the dock uses (runVdzModel + its
    // CDZ_AI_BASE_URL normalization). Any engine failure (unconfigured, network,
    // upstream error) becomes a typed 502 via @Res passthrough — NEVER a raw
    // HttpException, and NEVER InternalServerError (which maps to 500).
    let rawReply: string;
    try {
      rawReply = await this.runVdzModel(
        buildRepurposePrompt(transcriptText, durationSec, count)
      );
    } catch {
      res.status(HttpStatus.BAD_GATEWAY);
      return { error: 'repurpose_unavailable' };
    }

    // Fail-closed parse (SAME lenient parser as /chat), then coerce/clamp/sort.
    const parsed = parseLenientJsonObject(rawReply);
    const shorts = coerceShorts(parsed?.shorts, durationSec, count);
    if (!shorts.length) {
      // Planner replied but produced nothing usable → same typed 502 contract.
      res.status(HttpStatus.BAD_GATEWAY);
      return { error: 'repurpose_unavailable' };
    }
    return { shorts };
  }

  @Throttle('strict')
  @Get('/api/v1/vdz/projects')
  async listProjects(
    @CurrentUser() user: CurrentUser
  ): Promise<VdzProjectSummary[]> {
    const ids = await this.readOwnedIds(user.id);
    const summaries: VdzProjectSummary[] = [];
    const staleIds: string[] = [];
    for (const id of ids) {
      const doc = await this.readProject(user.id, id);
      if (!doc) {
        // Index entry whose doc expired (TTL) — prune lazily.
        staleIds.push(id);
        continue;
      }
      summaries.push({ id: doc.id, name: doc.name, updatedAt: doc.updatedAt });
    }
    if (staleIds.length) {
      await this.redis.srem(projectIndexKey(user.id), ...staleIds);
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  /** GET /api/v1/vdz/projects/:id — one full project document. */
  @Throttle('strict')
  @Get('/api/v1/vdz/projects/:id')
  async getProject(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string
  ): Promise<VdzProjectDoc> {
    if (!PROJECT_ID_RE.test(id)) {
      throw new BadRequest('Invalid project id');
    }
    const doc = await this.readProject(user.id, id);
    if (!doc) {
      throw new NotFound('Project not found');
    }
    return doc;
  }

  /**
   * POST /api/v1/vdz/projects — upsert a project.
   * Body: { id?, name, timeline }. Without an id, a new project is created
   * (subject to the per-owner cap); with an id, that project is replaced.
   */
  @Throttle('strict')
  @Post('/api/v1/vdz/projects')
  async upsertProject(
    @CurrentUser() user: CurrentUser,
    @Body() body: unknown
  ): Promise<VdzProjectDoc> {
    const payload = (body ?? {}) as Record<string, unknown>;

    const name =
      typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) {
      throw new BadRequest('A non-empty "name" string is required');
    }
    if (name.length > MAX_PROJECT_NAME_CHARS) {
      throw new BadRequest(
        `"name" is too long (max ${MAX_PROJECT_NAME_CHARS} characters)`
      );
    }
    this.validateTimelineSize(payload.timeline);

    let id: string;
    if (payload.id != null) {
      if (typeof payload.id !== 'string' || !PROJECT_ID_RE.test(payload.id)) {
        throw new BadRequest('Invalid project id');
      }
      id = payload.id;
    } else {
      id = `vdz-${randomProjectId()}`;
    }

    const existing = await this.readProject(user.id, id);
    if (!existing) {
      // Creating (either a brand-new id, or an id whose doc expired). Enforce
      // the per-owner cap against the live index.
      const ownedIds = await this.readOwnedIds(user.id);
      const liveCount = ownedIds.filter(existingId => existingId !== id).length;
      if (liveCount >= MAX_PROJECTS_PER_OWNER) {
        throw new BadRequest(
          `Project limit reached (${MAX_PROJECTS_PER_OWNER} projects max)`
        );
      }
    }

    const nowIso = new Date().toISOString();
    const doc: VdzProjectDoc = {
      id,
      name,
      timeline: payload.timeline,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    const serialized = JSON.stringify(doc);
    // Refresh the 90-day TTL on every write (rolling expiry, like apps-data).
    await this.redis.set(
      projectKey(user.id, id),
      serialized,
      'EX',
      PROJECT_TTL_SECONDS
    );
    await this.redis.sadd(projectIndexKey(user.id), id);
    // Keep the index alive at least as long as any project it points to.
    await this.redis.expire(projectIndexKey(user.id), PROJECT_TTL_SECONDS);

    this.logger.log(
      `[vdz] project upsert user=${user.id} id=${id} bytes=${serialized.length}`
    );
    return doc;
  }

  /** DELETE /api/v1/vdz/projects/:id — remove a project. */
  @Throttle('strict')
  @Delete('/api/v1/vdz/projects/:id')
  async deleteProject(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string
  ): Promise<{ deleted: boolean }> {
    if (!PROJECT_ID_RE.test(id)) {
      throw new BadRequest('Invalid project id');
    }
    const removed = await this.redis.del(projectKey(user.id, id));
    await this.redis.srem(projectIndexKey(user.id), id);
    return { deleted: removed > 0 };
  }

  /**
   * POST /api/v1/vdz/projects/:id/share — create or update the public share
   * for an owned project. BODY: raw bytes of the snapshot JSON
   * `{ name, timeline }` with media already inlined client-side
   * (`Content-Type: application/octet-stream`). Re-sharing the same project
   * reuses its shareId — the public link stays stable while its content
   * updates.
   */
  @Throttle('strict')
  @Post('/api/v1/vdz/projects/:id/share')
  async shareProject(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<{ shareId: string; path: string }> {
    if (!PROJECT_ID_RE.test(id)) {
      throw new BadRequest('Invalid project id');
    }
    // Only an existing, owned project can be shared.
    const project = await this.readProject(user.id, id);
    if (!project) {
      throw new NotFound('Project not found');
    }
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequest(
        'Send the snapshot JSON as raw bytes with Content-Type: application/octet-stream'
      );
    }
    if (body.length > MAX_SHARE_SNAPSHOT_BYTES) {
      throw new BadRequest(
        `Share snapshot too large (max ${Math.floor(
          MAX_SHARE_SNAPSHOT_BYTES / (1024 * 1024)
        )}MB) — heavy media stays workspace-only`
      );
    }
    let snapshot: { name?: unknown; timeline?: unknown };
    try {
      snapshot = JSON.parse(body.toString('utf8')) as typeof snapshot;
    } catch {
      throw new BadRequest('Snapshot is not valid JSON');
    }
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      typeof snapshot.timeline !== 'object' ||
      snapshot.timeline === null
    ) {
      throw new BadRequest('Snapshot must contain a "timeline" object');
    }
    const name =
      typeof snapshot.name === 'string' && snapshot.name.trim()
        ? snapshot.name.trim().slice(0, MAX_PROJECT_NAME_CHARS)
        : project.name;

    // Reuse the project's existing share id so the public URL is stable.
    const existingShareId = await this.redis.get(
      shareOfProjectKey(user.id, id)
    );
    const shareId =
      existingShareId && SHARE_ID_RE.test(existingShareId)
        ? existingShareId
        : randomShareId();

    const doc: VdzShareDoc = {
      shareId,
      ownerId: user.id,
      projectId: id,
      name,
      timeline: snapshot.timeline,
      sharedAt: new Date().toISOString(),
    };
    await this.redis.set(
      shareKey(shareId),
      JSON.stringify(doc),
      'EX',
      SHARE_TTL_SECONDS
    );
    await this.redis.set(
      shareOfProjectKey(user.id, id),
      shareId,
      'EX',
      SHARE_TTL_SECONDS
    );
    this.logger.log(
      `[vdz] share upsert user=${user.id} project=${id} share=${shareId} bytes=${body.length}`
    );
    return { shareId, path: `/vdz-share/${shareId}` };
  }

  /** DELETE /api/v1/vdz/projects/:id/share — revoke the public link. */
  @Throttle('strict')
  @Delete('/api/v1/vdz/projects/:id/share')
  async revokeShare(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string
  ): Promise<{ revoked: boolean }> {
    if (!PROJECT_ID_RE.test(id)) {
      throw new BadRequest('Invalid project id');
    }
    const mappingKey = shareOfProjectKey(user.id, id);
    const shareId = await this.redis.get(mappingKey);
    if (!shareId) {
      return { revoked: false };
    }
    await this.redis.del(shareKey(shareId));
    await this.redis.del(mappingKey);
    this.logger.log(
      `[vdz] share revoke user=${user.id} project=${id} share=${shareId}`
    );
    return { revoked: true };
  }

  /**
   * GET /api/v1/vdz/shared/:shareId — the PUBLIC read side. Deliberately
   * `@Public()` (the only vdz route that is): the share id is the capability
   * (crypto-strong, unguessable), mirroring doc share links. Returns only the
   * snapshot fields — never the owner id.
   */
  @Public()
  @Throttle('strict')
  @Get('/api/v1/vdz/shared/:shareId')
  async getSharedTimeline(
    @Param('shareId') shareId: string
  ): Promise<{ name: string; timeline: unknown; sharedAt: string }> {
    if (!SHARE_ID_RE.test(shareId)) {
      throw new BadRequest('Invalid share id');
    }
    const raw = await this.redis.get(shareKey(shareId));
    if (!raw) {
      throw new NotFound('This share link does not exist or was revoked');
    }
    let doc: VdzShareDoc;
    try {
      doc = JSON.parse(raw) as VdzShareDoc;
    } catch {
      throw new InternalServerError('Stored share is corrupt');
    }
    return { name: doc.name, timeline: doc.timeline, sharedAt: doc.sharedAt };
  }
}

/**
 * Crypto-strong short id for new projects (unguessable, url-safe). 8 bytes →
 * 16 lowercase hex chars, well within PROJECT_ID_RE.
 */
function randomProjectId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Crypto-strong share id (the capability itself — must be unguessable).
 * 12 bytes → 16 url-safe chars, within SHARE_ID_RE.
 */
function randomShareId(): string {
  return randomBytes(12).toString('base64url');
}
