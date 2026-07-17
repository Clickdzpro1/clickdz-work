import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
// SECURITY: crypto-strong randomness for unguessable auto project ids.
import { randomBytes } from 'node:crypto';

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
 * Best-effort extraction of the strict response JSON object from a raw model
 * reply. Prefers a clean `JSON.parse`; if the model wrapped it in prose or
 * fences, strips fences and slices the outermost `{...}`. Returns the parsed
 * object on success (carrying `summary`, `ops`, and — when present — `plan` /
 * `suggestions` for the non-default modes), or null when nothing parseable is
 * present. Extra fields are harmless: a mode that doesn't use them ignores them.
 */
function extractVdzResponse(raw: string): ExtractedVdzResponse | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const tryParse = (s: string): ExtractedVdzResponse | null => {
    try {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          summary: parsed.summary,
          ops: parsed.ops,
          plan: parsed.plan,
          suggestions: parsed.suggestions,
        };
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
    @Body() body: unknown
  ): Promise<{
    summary: string;
    ops: unknown[];
    plan?: VdzPlanStep[];
    suggestions?: string[];
    raw?: string;
  }> {
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

    const rawReply = await this.runVdzModel(messages);

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
    segments: Array<{ start: number; end: number; text: string }>;
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
    } | null;
    if (!data) {
      throw new InternalServerError('Transcription returned malformed JSON');
    }
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    const segments = (Array.isArray(data.segments) ? data.segments : [])
      .map(raw => {
        const s = (raw ?? {}) as Record<string, unknown>;
        return {
          start: Number(s.start) || 0,
          end: Number(s.end) || 0,
          text: typeof s.text === 'string' ? s.text.trim() : '',
        };
      })
      .filter(s => s.text.length > 0 && s.end > s.start);

    this.logger.log(
      `[vdz] transcribe user=${user.id} bytes=${body.length} segments=${segments.length}`
    );
    return { text, segments };
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
