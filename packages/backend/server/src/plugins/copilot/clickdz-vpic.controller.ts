import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';

// Typed AFFiNE errors so the global exception filter emits proper 4xx (a raw
// @nestjs/common HttpException is coerced to a generic 500 by base/nestjs/
// exception.ts): NotFound = the gated-OFF "feature disabled" 404 — the SAME
// stance the sibling clickdz-agents/vdz controllers take; BadRequest = a bad
// body (oversized state / invalid id / cap reached, or an unconfigured pix
// backend — a client-observable precondition, EXACTLY the render controller's
// 400 stance). CopilotProviderSideError = an upstream (cdz-pix) failure, typed
// as a provider error so it maps to a 5xx instead of a bare 500 — the SAME
// class + shape the peer clickdz-vdz-render controller uses for its render
// service. Throttle = the house rate-limit decorator ('default' | 'strict',
// with a per-route override) — the SAME one the vdz controller annotates its
// routes with.
import { BadRequest, CopilotProviderSideError, NotFound, Throttle } from '../../base';
// CacheRedis = the @Global raw ioredis provider — the SAME handle Hermes/bridge/
// vdz inject. We need the RAW client here for the per-user index zset (zadd /
// zrevrange / zrem / zcard) + the record's string GET/SET with a rolling EX
// TTL, exactly the idiom the vdz projects store uses (only with a zset index so
// the newest-first ordering is carried by the score, not re-sorted per read).
import { CacheRedis } from '../../base/redis';
// CurrentUser decorates (param) + types the cookie-session user, from core/auth
// like every peer. Ownership is intrinsic: every key is per-user, keyed ONLY by
// @CurrentUser().id (NEVER a request-supplied id), and the global AuthGuard
// gates the routes to a signed-in session.
import { CurrentUser } from '../../core/auth';

// ---------------------------------------------------------------------------
// CDZ VPIC — IMAGE EDITOR STUDIO, PROJECT STORE (R14, "image editor studio
// tab"). A tiny owner-scoped surface the VPIC studio page keys off:
//   · GET    /api/v1/vpic/caps            — { enabled }; UNGATED (the FE studio
//                                            registry reads it to decide whether
//                                            to show the tab). Returns
//                                            enabled:false when the flag is off.
//   · GET    /api/v1/vpic/projects        — the caller's projects, newest-first
//                                            (id, name, updatedAt only).
//   · GET    /api/v1/vpic/projects/:id    — one full project { id, name, state,
//                                            updatedAt }.
//   · POST   /api/v1/vpic/projects        — upsert { id?, name, state } → { id }.
//   · DELETE /api/v1/vpic/projects/:id    — remove a project (idempotent).
// Every route EXCEPT caps is gated by CDZ_VPIC_ENABLED (the R14 master gate):
// OFF ⇒ a typed 404, byte-identical to the feature not existing. Fail-soft
// everywhere (Redis is a cache): a failed read degrades to "no data" ([] / null),
// never a 500. Typed errors only; imports nothing from the frontend. Persistence
// mirrors the vdz projects store (clickdz-vdz.controller.ts) — a per-user record
// key + a per-user index — the only deviation being a zset index (score =
// updatedAt) so newest-first ordering rides the score instead of a per-read sort.
// ---------------------------------------------------------------------------

// Config (read once at module load, same idiom as the sibling controllers — env
// is fixed for the process, so a per-request read is unnecessary).
const CDZ_VPIC_ENABLED = process.env.CDZ_VPIC_ENABLED || '';

// ---------------------------------------------------------------------------
// cdz-pix service wiring (R15 — the AI bg-remove + upscale buttons). cdz-pix
// (a standalone CPU-first FastAPI microservice) owns the actual model inference;
// this controller is the session-authed proxy in front of it, so the FRONTEND
// never sees the pix token. Same self-contained stance as the peer
// clickdz-vdz-render controller: env-driven, Bearer-authed, typed errors,
// imports nothing from the frontend. Trailing slash trimmed off the URL so
// `${CDZ_PIX_URL}${path}` never double-slashes (identical to RENDER_URL).
const CDZ_PIX_URL = (process.env.CDZ_PIX_URL || '').replace(/\/+$/, '');
const CDZ_PIX_TOKEN = process.env.CDZ_PIX_TOKEN || '';
// True only when the feature flag is ON *and* the pix backend is fully wired
// (both URL + token present). This is the SINGLE predicate behind both the
// route gate (assertPixReady) and the caps flags, so caps can never advertise a
// capability the routes would reject — they move together by construction.
const PIX_READY = CDZ_VPIC_ENABLED === '1' && !!CDZ_PIX_URL && !!CDZ_PIX_TOKEN;
// Base64 char-length cap on the forwarded image (~9MB decoded at 4/3 overhead).
// cdz-pix enforces its own decoded-byte cap (CDZ_PIX_MAX_BYTES), but we reject
// an oversized payload at the edge BEFORE round-tripping it, same as the render
// controller byte-caps its HTML/manifest inputs.
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
// CPU inference is seconds, not ms (bg-remove ~2-12s, upscale ~5-20s+); the
// cdz-pix README pins the proxy timeout at >= 30s. Bounded against a hung upstream.
const PIX_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Project store caps (mirror the vdz projects conventions).
// ---------------------------------------------------------------------------
// Per-user project cap — reject a create beyond this (the contract's 100).
const MAX_PROJECTS_PER_OWNER = 100;
// A friendly bound on the project name (kept small; it is a label only).
const MAX_PROJECT_NAME_CHARS = 200;
// The `state` blob is the engine's ops JSON + source handle. Reject (not clamp)
// anything past 256KB serialized — the contract's hard size cap. State carries
// NO pixels (the engine's toStateJSON is ops-only), so 256KB is generous.
const MAX_STATE_BYTES = 256 * 1024;
// 90-day TTL, re-armed on every write (rolling expiry, like the vdz store). The
// raw client's EX option takes SECONDS.
const PROJECT_TTL_SECONDS = 90 * 24 * 60 * 60;

// Redis key namespaces (EXACTLY the contract's pins). Owner-scoped: the {userId}
// segment is ALWAYS @CurrentUser().id.
//   record: JSON doc, 90d rolling TTL.
const projectKey = (userId: string, projectId: string) =>
  `clickdz:vpic:project:${userId}:${projectId}`;
//   index: a zset of the caller's project ids, score = updatedAt (ms epoch), so
//   ZREVRANGE yields newest-first directly.
const projectIndexKey = (userId: string) => `clickdz:vpic:projects:${userId}`;

// Same id shape the vdz store enforces (safe as a Redis key segment; bounded).
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** A stored project document. `state` is opaque JSON (validated by size). */
interface VpicProjectDoc {
  id: string;
  name: string;
  state: unknown;
  updatedAt: number;
}

/** The compact list-view row (never returns the full state). */
interface VpicProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
}

/** A crypto-light random id for auto-created projects (no secrets — a key seg). */
function randomProjectId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  ).slice(0, 24);
}

@Controller()
export class ClickDzVpicController {
  // Raw ioredis (the record string ops + the index zset ops) — the SAME handle
  // the vdz projects store injects.
  constructor(private readonly redis: CacheRedis) {}

  /** Typed 404 when the master gate is off — never leaks that the route exists. */
  private assertEnabled() {
    if (CDZ_VPIC_ENABLED !== '1') {
      throw new NotFound('VPIC is not enabled');
    }
  }

  /**
   * The caller's project ids newest-first from the index zset (fail-soft → []).
   * A read failure (Redis down) is treated as "no projects", NEVER a 500 — the
   * store is a cache decorating the studio, not a source of truth.
   */
  private async readOwnedIdsNewestFirst(userId: string): Promise<string[]> {
    try {
      const ids = await this.redis.zrevrange(projectIndexKey(userId), 0, -1);
      return Array.isArray(ids) ? ids : [];
    } catch {
      return [];
    }
  }

  /**
   * One project doc by id (fail-soft → null). A missing key, a read failure, or
   * a corrupt JSON entry all degrade to null (the caller renders "not found" /
   * prunes the stale index entry) rather than surfacing a 500.
   */
  private async readProject(
    userId: string,
    projectId: string
  ): Promise<VpicProjectDoc | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(projectKey(userId, projectId));
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as VpicProjectDoc;
    } catch {
      return null;
    }
  }

  /**
   * Validate the `state` blob: must be a serializable JSON object within the
   * 256KB size cap. Rejects with a typed 400 (BadRequest) so the client gets a
   * clear error rather than a silent truncation.
   */
  private validateStateSize(state: unknown): void {
    if (state == null || typeof state !== 'object') {
      throw new BadRequest('"state" must be a JSON object');
    }
    let json: string;
    try {
      json = JSON.stringify(state);
    } catch {
      throw new BadRequest('"state" must be serializable JSON');
    }
    if (Buffer.byteLength(json, 'utf8') > MAX_STATE_BYTES) {
      throw new BadRequest(
        `"state" is too large (max ${MAX_STATE_BYTES / 1024}KB serialized)`
      );
    }
  }

  // -------------------------------------------------------------------------
  // cdz-pix proxy helpers (R15). Mirror the peer clickdz-vdz-render controller's
  // assertRenderReady / headers / upstream / proxy shape, pointed at cdz-pix.
  // -------------------------------------------------------------------------

  /**
   * Gate the AI routes: the CDZ_VPIC_ENABLED master flag first, then the pix
   * service config. A typed 400 (NOT a 500) — an unconfigured/disabled backend
   * is a client-observable precondition, so the FE degrades to the disabled /
   * "coming soon" state instead of surfacing a server error (the SAME stance
   * clickdz-vdz-render's assertRenderReady takes; CopilotProviderSideError would
   * map to 500). PIX_READY folds both checks, but we split the messages so a
   * misconfig is diagnosable from the response.
   */
  private assertPixReady(): void {
    if (CDZ_VPIC_ENABLED !== '1') {
      throw new BadRequest('VPIC AI is not enabled');
    }
    if (!CDZ_PIX_URL || !CDZ_PIX_TOKEN) {
      throw new BadRequest('Image service is not configured');
    }
  }

  /** Common headers for every cdz-pix call — Bearer token, NEVER sent to the FE. */
  private pixHeaders(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${CDZ_PIX_TOKEN}`, ...extra };
  }

  /** Wrap a fetch to cdz-pix, mapping network/timeout to a typed provider error. */
  private async pixUpstream(
    path: string,
    init: RequestInit
  ): Promise<Response> {
    try {
      return (await fetch(`${CDZ_PIX_URL}${path}`, {
        ...init,
        signal: AbortSignal.timeout(PIX_TIMEOUT_MS),
      })) as unknown as Response;
    } catch (cause) {
      throw new CopilotProviderSideError({
        provider: 'pix',
        kind: 'network_error',
        message:
          cause instanceof Error
            ? `Image service request failed: ${cause.message}`
            : 'Image service request failed',
      });
    }
  }

  /**
   * Proxy an image op to cdz-pix. SSRF-safe by construction: we ONLY forward a
   * caller-supplied base64 STRING (`imageBase64`) plus a whitelisted scalar
   * `extra` (model / scale) — NO url is ever accepted or fetched, so there is no
   * attacker-controlled fetch target. Validates + byte-caps the input at the
   * edge (typed 400), relays it with the Bearer header, and reads `imageBase64`
   * back on success. cdz-pix's error shape is `{ error: { message } }`; a
   * non-2xx bubbles that message as a 400 (a client-fixable rejection — e.g.
   * "image too large"), while a 2xx with no image is a provider-side 5xx.
   */
  private async pixProxy(
    path: string,
    body: Record<string, unknown>,
    extra?: Record<string, unknown>
  ): Promise<{ imageBase64: string }> {
    this.assertPixReady();

    const imageBase64 = body?.imageBase64;
    if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
      throw new BadRequest('"imageBase64" must be a base64 image string');
    }
    if (imageBase64.length > MAX_IMAGE_BYTES) {
      throw new BadRequest('Image is too large (max ~9MB)');
    }

    const res = await this.pixUpstream(path, {
      method: 'POST',
      headers: this.pixHeaders({ 'Content-Type': 'application/json' }),
      // Forward ONLY the base64 string + any whitelisted scalar extras (never a
      // url, never the raw caller body) so no attacker-controlled field reaches
      // the upstream.
      body: JSON.stringify({ imageBase64, ...(extra ?? {}) }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      imageBase64?: unknown;
      error?: { message?: string };
    };
    if (!res.ok) {
      // Bubble cdz-pix's own message (e.g. "image too large", "bad scale").
      throw new BadRequest(
        data?.error?.message ||
          `Image service rejected the request (${res.status})`
      );
    }
    if (typeof data?.imageBase64 !== 'string' || !data.imageBase64) {
      throw new CopilotProviderSideError({
        provider: 'pix',
        kind: 'invalid_output',
        message: 'Image service returned no image',
      });
    }
    return { imageBase64: data.imageBase64 };
  }

  // GET /api/v1/vpic/caps — { enabled, bgRemoveEnabled, upscaleEnabled }.
  // @CurrentUser (a signed-in feature), but deliberately NOT gated: the FE studio
  // registry reads this to decide whether to show the VPIC tab, so it must answer
  // honestly even when the flag is off (enabled:false ⇒ tab hidden). The two AI
  // flags (R15) gate the bg-remove/upscale buttons — TRUE only when the feature
  // flag is on AND cdz-pix is wired (PIX_READY), the SAME predicate the routes
  // assert, so a button is never enabled for a call the backend would reject.
  // Throttle override 300/60s (a cheap, hot poll).
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/vpic/caps')
  async getCaps(
    @CurrentUser() _user: CurrentUser
  ): Promise<{
    enabled: boolean;
    bgRemoveEnabled: boolean;
    upscaleEnabled: boolean;
  }> {
    return {
      enabled: CDZ_VPIC_ENABLED === '1',
      bgRemoveEnabled: PIX_READY,
      upscaleEnabled: PIX_READY,
    };
  }

  // POST /api/v1/vpic/bg-remove — proxy a background-removal to cdz-pix. Body
  // { imageBase64, model? }; forwards { imageBase64, model? } to cdz-pix's
  // /bg-remove and returns { imageBase64 } (a transparent PNG). Session-authed
  // (global guard, no @Public — like the render proxy), @Throttle('strict') (a
  // paid model call), gated by assertPixReady (typed 400 when off). `model` is
  // an OPTIONAL whitelisted scalar (cdz-pix validates it: 'birefnet' | 'u2net');
  // ONLY the base64 string + model are forwarded, never a url (SSRF-safe).
  @Throttle('strict')
  @Post('/api/v1/vpic/bg-remove')
  async bgRemove(@Body() body: unknown): Promise<{ imageBase64: string }> {
    const payload = (body ?? {}) as Record<string, unknown>;
    const extra =
      typeof payload.model === 'string' ? { model: payload.model } : undefined;
    return this.pixProxy('/bg-remove', payload, extra);
  }

  // POST /api/v1/vpic/upscale — proxy an upscale to cdz-pix. Body
  // { imageBase64, scale? }; forwards { imageBase64, scale? } to cdz-pix's
  // /upscale and returns { imageBase64 } (a PNG). Session-authed,
  // @Throttle('strict'), gated by assertPixReady. `scale` is an OPTIONAL
  // whitelisted numeric (cdz-pix accepts 2 | 4); ONLY the base64 string + scale
  // are forwarded, never a url (SSRF-safe).
  @Throttle('strict')
  @Post('/api/v1/vpic/upscale')
  async upscale(@Body() body: unknown): Promise<{ imageBase64: string }> {
    const payload = (body ?? {}) as Record<string, unknown>;
    const extra =
      typeof payload.scale === 'number' ? { scale: payload.scale } : undefined;
    return this.pixProxy('/upscale', payload, extra);
  }

  // GET /api/v1/vpic/projects — the caller's projects, newest-first (id, name,
  // updatedAt only; never the full state). @CurrentUser, owner-scoped (keyed by
  // user.id). Gated (typed 404 when off). Read-only, fail-soft (a read failure
  // degrades to an empty list). Throttle override 300/60s.
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/vpic/projects')
  async listProjects(
    @CurrentUser() user: CurrentUser
  ): Promise<VpicProjectSummary[]> {
    this.assertEnabled();
    const ids = await this.readOwnedIdsNewestFirst(user.id);
    const summaries: VpicProjectSummary[] = [];
    const staleIds: string[] = [];
    for (const id of ids) {
      const doc = await this.readProject(user.id, id);
      if (!doc) {
        // Index entry whose record expired (TTL) — prune lazily.
        staleIds.push(id);
        continue;
      }
      summaries.push({ id: doc.id, name: doc.name, updatedAt: doc.updatedAt });
    }
    if (staleIds.length) {
      // Best-effort prune; a failure here must not fail the read.
      try {
        await this.redis.zrem(projectIndexKey(user.id), ...staleIds);
      } catch {
        /* fail-soft: pruning is opportunistic */
      }
    }
    // The zset already returns newest-first, but re-assert on updatedAt so a
    // legacy/equal score never surfaces out of order.
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  // GET /api/v1/vpic/projects/:id — one full project document { id, name, state,
  // updatedAt }. @CurrentUser, owner-scoped (the record key embeds user.id, so a
  // caller can only ever read THEIR OWN project; another user's id is invisible
  // ⇒ 404). Gated (typed 404 when off). Throttle override 300/60s.
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/vpic/projects/:id')
  async getProject(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string
  ): Promise<VpicProjectDoc> {
    this.assertEnabled();
    if (!PROJECT_ID_RE.test(id)) {
      throw new BadRequest('Invalid project id');
    }
    const doc = await this.readProject(user.id, id);
    if (!doc) {
      throw new NotFound('Project not found');
    }
    return doc;
  }

  // POST /api/v1/vpic/projects — upsert a project. Body { id?, name, state }.
  // Without an id, a new project is created (subject to the per-user cap of 100);
  // with an id, that project is replaced. @CurrentUser, owner-scoped. Gated
  // (typed 404 when off), @Throttle('strict') (a write). state = the engine's
  // ops JSON + source handle, size-capped at 256KB (→ 400 beyond). Returns the
  // new/updated id.
  @Throttle('strict')
  @Post('/api/v1/vpic/projects')
  async upsertProject(
    @CurrentUser() user: CurrentUser,
    @Body() body: unknown
  ): Promise<{ id: string }> {
    this.assertEnabled();
    const payload = (body ?? {}) as Record<string, unknown>;

    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) {
      throw new BadRequest('A non-empty "name" string is required');
    }
    if (name.length > MAX_PROJECT_NAME_CHARS) {
      throw new BadRequest(
        `"name" is too long (max ${MAX_PROJECT_NAME_CHARS} characters)`
      );
    }
    // Size-cap the state blob BEFORE any Redis work (reject early, like vdz).
    this.validateStateSize(payload.state);

    let id: string;
    if (payload.id != null) {
      if (typeof payload.id !== 'string' || !PROJECT_ID_RE.test(payload.id)) {
        throw new BadRequest('Invalid project id');
      }
      id = payload.id;
    } else {
      id = `vpic-${randomProjectId()}`;
    }

    // Enforce the per-user cap only when CREATING (a brand-new id, or an id whose
    // record expired). An update of an already-indexed id never trips the cap.
    const existing = await this.readProject(user.id, id);
    if (!existing) {
      const ownedIds = await this.readOwnedIdsNewestFirst(user.id);
      const liveCount = ownedIds.filter(existingId => existingId !== id).length;
      if (liveCount >= MAX_PROJECTS_PER_OWNER) {
        throw new BadRequest(
          `Project limit reached (${MAX_PROJECTS_PER_OWNER} projects max)`
        );
      }
    }

    const updatedAt = Date.now();
    const doc: VpicProjectDoc = {
      id,
      name,
      state: payload.state,
      updatedAt,
    };

    const serialized = JSON.stringify(doc);
    // Write the record with a fresh 90-day rolling TTL, then upsert the index
    // zset entry with score = updatedAt (newest-first via ZREVRANGE). Keep the
    // index alive at least as long as any record it points to. These are the
    // authoritative writes — a failure here DOES propagate (the write did not
    // land), unlike the fail-soft reads above.
    await this.redis.set(
      projectKey(user.id, id),
      serialized,
      'EX',
      PROJECT_TTL_SECONDS
    );
    await this.redis.zadd(projectIndexKey(user.id), updatedAt, id);
    await this.redis.expire(projectIndexKey(user.id), PROJECT_TTL_SECONDS);

    return { id };
  }

  // DELETE /api/v1/vpic/projects/:id — remove a project. @CurrentUser, owner-
  // scoped (the record + index entry both embed user.id, so a caller can only
  // delete THEIR OWN). Idempotent — deleting a missing/unknown id still returns
  // { ok: true } (a delete need not distinguish "was not there"). Gated (typed
  // 404 when off), @Throttle('strict') (a write).
  @Throttle('strict')
  @Delete('/api/v1/vpic/projects/:id')
  async deleteProject(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string
  ): Promise<{ ok: true }> {
    this.assertEnabled();
    if (!PROJECT_ID_RE.test(id)) {
      throw new BadRequest('Invalid project id');
    }
    await this.redis.del(projectKey(user.id, id));
    await this.redis.zrem(projectIndexKey(user.id), id);
    return { ok: true };
  }
}
