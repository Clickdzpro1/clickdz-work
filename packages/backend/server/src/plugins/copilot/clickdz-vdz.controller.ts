import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
// SECURITY: crypto-strong randomness for unguessable auto project ids.
import { randomBytes } from 'node:crypto';

// Typed AFFiNE errors so the global exception filter emits proper 4xx/5xx
// (a raw @nestjs/common HttpException is turned into a generic 500 here).
import { BadRequest, InternalServerError, NotFound, Throttle } from '../../base';
import { CacheRedis } from '../../base/redis';
import { CurrentUser } from '../../core/auth';
import {
  buildVdzContextTurn,
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

/**
 * Best-effort extraction of the strict `{summary, ops}` JSON object from a raw
 * model reply. Prefers a clean `JSON.parse`; if the model wrapped it in prose
 * or fences, strips fences and slices the outermost `{...}`. Returns the parsed
 * object on success, or null when nothing parseable is present.
 */
function extractVdzResponse(
  raw: string
): { summary: unknown; ops: unknown } | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const tryParse = (s: string): { summary: unknown; ops: unknown } | null => {
    try {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { summary: parsed.summary, ops: parsed.ops };
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
  ): Promise<{ summary: string; ops: unknown[]; raw?: string }> {
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

    // Build the conversation: system prompt, a compact context turn (timeline
    // JSON + selection), the prior chat history, then the new user message.
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: VDZ_SYSTEM_PROMPT },
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
      `[vdz] chat user=${user.id} selected=${selectedClipIds.length} history=${history?.length ?? 0} msg=${message.slice(0, 80)}`
    );

    const rawReply = await this.runVdzModel(messages);

    // Server-side sanity parse. The client re-validates each op with the Zod
    // schema before applying, so we only need to guarantee a well-formed
    // {summary, ops[]} envelope here and degrade gracefully otherwise (200).
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
}

/**
 * Crypto-strong short id for new projects (unguessable, url-safe). 8 bytes →
 * 16 lowercase hex chars, well within PROJECT_ID_RE.
 */
function randomProjectId(): string {
  return randomBytes(8).toString('hex');
}
