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
// body (oversized state / invalid id / cap reached). Throttle = the house
// rate-limit decorator ('default' | 'strict', with a per-route override) — the
// SAME one the vdz controller annotates its routes with.
import { BadRequest, NotFound, Throttle } from '../../base';
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

  // GET /api/v1/vpic/caps — { enabled }. @CurrentUser (a signed-in feature), but
  // deliberately NOT gated: the FE studio registry reads this to decide whether
  // to show the VPIC tab, so it must answer honestly even when the flag is off
  // (enabled:false ⇒ tab hidden). Throttle override 300/60s (a cheap, hot poll).
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/vpic/caps')
  async getCaps(
    @CurrentUser() _user: CurrentUser
  ): Promise<{ enabled: boolean }> {
    return { enabled: CDZ_VPIC_ENABLED === '1' };
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
