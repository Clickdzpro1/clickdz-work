import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Options,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

// Typed AFFiNE errors so the global exception filter emits proper 4xx
// (a raw @nestjs/common HttpException is turned into a generic 500 here).
import { AuthenticationRequired, BadRequest } from '../../base';
import { CacheRedis } from '../../base/redis';
import { Public } from '../../core/auth';
import { verifyDataToken } from './cdz-data-token';

/**
 * ClickDz Data API — a tiny shared collections store that gives every
 * generated ClickDz App persistent, multi-user data without a per-app
 * backend. Apps call it cross-origin from *.vercel.app with plain fetch.
 *
 * Storage model: one Redis hash per (app slug, collection); record ids are
 * hash fields, values are JSON documents with auto id + createdAt.
 * Creative-tool grade: public per-slug namespaces, hard size caps, 90-day
 * rolling expiry.
 */
const SLUG_RE = /^[a-z0-9-]{3,50}$/;
const COLLECTION_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_RECORDS_PER_COLLECTION = 500;
const MAX_LIST_LIMIT = 500;
const DATA_TTL_SECONDS = 90 * 24 * 60 * 60;

// Per-slug write rate limit: a coarse fixed-window counter over the current
// epoch-minute. Cheap (one INCR + one EXPIRE), self-cleaning (short TTL), and
// only touches WRITE paths (POST/DELETE) — reads (list) are never limited.
const RL_MAX_WRITES_PER_MIN = 60;
const RL_TTL_SECONDS = 120;

const dataKey = (slug: string, collection: string) =>
  `clickdz:appdata:${slug}:${collection}`;

const rateLimitKey = (slug: string, epochMinute: number) =>
  `clickdz:rl:${slug}:${epochMinute}`;

function setCors(res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function badRequest(message: string): never {
  throw new BadRequest(message);
}

@Public()
@Controller()
export class ClickDzDataController {
  constructor(private readonly redis: CacheRedis) {}

  private assertNames(slug: string, collection: string) {
    if (!SLUG_RE.test(slug)) badRequest('Invalid app slug');
    if (!COLLECTION_RE.test(collection)) badRequest('Invalid collection name');
  }

  // v2 requests are token-gated for writes/deletes; v1 stays open for
  // back-compat with already-deployed apps (EXCEPT the destructive clear,
  // which is gated on both versions — see clear()).
  private isV2(req: Request): boolean {
    return (req.path || '').startsWith('/api/v2/');
  }

  private requireWriteToken(req: Request, slug: string) {
    const auth = String(req.headers['authorization'] || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const token = bearer || String((req.query?.t as string) || '');
    if (!verifyDataToken(slug, token)) {
      throw new AuthenticationRequired('A valid write token is required');
    }
  }

  // Sliding-window TTL refresh: keep the same DATA_TTL_SECONDS create() uses,
  // but re-arm it on EVERY access (read + write) so a live-but-static shop's
  // collection never silently expires at 90d after its last write. One EXPIRE
  // per request, scoped to the single collection key the route touched.
  private async touchTtl(key: string) {
    await this.redis.expire(key, DATA_TTL_SECONDS);
  }

  // Per-slug write rate limit. Returns true when the request is OVER the cap
  // (caller emits a typed 429 via passthrough res). Increments a per-minute
  // counter; the first hit of a window arms a short TTL so buckets self-expire.
  // Reads never call this. Fail-open on Redis hiccups (a limiter must not take
  // down legitimate writes).
  private async isRateLimited(slug: string): Promise<boolean> {
    try {
      const epochMinute = Math.floor(Date.now() / 60000);
      const key = rateLimitKey(slug, epochMinute);
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, RL_TTL_SECONDS);
      }
      return count > RL_MAX_WRITES_PER_MIN;
    } catch {
      return false;
    }
  }

  @Options([
    '/api/apps-data/:slug/:collection',
    '/api/apps-data/:slug/:collection/:id',
    '/api/v2/apps-data/:slug/:collection',
    '/api/v2/apps-data/:slug/:collection/:id',
  ])
  preflight(@Res() res: Response) {
    setCors(res);
    res.status(204).end();
  }

  @Get([
    '/api/apps-data/:slug/:collection',
    '/api/v2/apps-data/:slug/:collection',
  ])
  async list(
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Query('limit') limit: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    setCors(res);
    this.assertNames(slug, collection);
    const key = dataKey(slug, collection);
    const raw = await this.redis.hgetall(key);
    // Reads slide the expiry window forward: a shop that only serves reads
    // (no new orders/products) keeps its data alive. Cheap, per-collection.
    await this.touchTtl(key);
    const records = Object.values(raw)
      .map(value => {
        try {
          return JSON.parse(value) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((record): record is Record<string, unknown> => !!record)
      .sort((a, b) =>
        String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
      );
    const max = Math.min(
      Math.max(Number(limit) || MAX_LIST_LIMIT, 1),
      MAX_LIST_LIMIT
    );
    return records.slice(0, max);
  }

  @Post([
    '/api/apps-data/:slug/:collection',
    '/api/v2/apps-data/:slug/:collection',
  ])
  async create(
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    setCors(res);
    this.assertNames(slug, collection);
    if (this.isV2(req)) this.requireWriteToken(req, slug);
    // Per-slug write throttle (typed 429, never a raw HttpException). Applied
    // after name/token checks so bad input still gets its precise 4xx.
    if (await this.isRateLimited(slug)) {
      res.status(HttpStatus.TOO_MANY_REQUESTS).json({ error: 'rate_limited' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      badRequest('Record must be a JSON object');
    }
    const key = dataKey(slug, collection);
    const count = await this.redis.hlen(key);
    if (count >= MAX_RECORDS_PER_COLLECTION) {
      throw new BadRequest(
        `Collection is full (${MAX_RECORDS_PER_COLLECTION} records max)`
      );
    }
    const id = randomUUID().slice(0, 8);
    const record = {
      ...(body as Record<string, unknown>),
      id,
      createdAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
      badRequest(`Record too large (${MAX_RECORD_BYTES / 1024}KB max)`);
    }
    await this.redis.hset(key, id, serialized);
    await this.redis.expire(key, DATA_TTL_SECONDS);
    return record;
  }

  // Native atomic upsert (v2-only). Writes a single record IN PLACE at a
  // caller-chosen id via one HSET, so there is no delete-then-recreate window:
  // a concurrent reader always sees either the old or the new document, never a
  // gap. Money documents (invoices/caisse) must never vanish mid-edit under
  // concurrency — this is the primitive the delete+recreate path cannot give.
  //
  // Always token-gated (there is no v1 back-compat surface for a brand-new
  // route, so we require the write token unconditionally rather than via
  // isV2()). Preserves the original createdAt on update and stamps updatedAt;
  // on first write it mints createdAt like create() does. The record's id is
  // always the path id, ignoring any id in the body (the URL is authoritative).
  @Put(['/api/v2/apps-data/:slug/:collection/:id'])
  async upsert(
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    setCors(res);
    this.assertNames(slug, collection);
    this.requireWriteToken(req, slug);
    // Per-slug write throttle (typed 429 via passthrough — never raw). Applied
    // after name/token checks so bad input still gets its precise 4xx.
    if (await this.isRateLimited(slug)) {
      res.status(HttpStatus.TOO_MANY_REQUESTS).json({ error: 'rate_limited' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      badRequest('Record must be a JSON object');
    }
    if (!id) badRequest('Record id is required');

    const key = dataKey(slug, collection);
    // Read the existing field (if any) so we can (a) preserve its createdAt and
    // (b) only enforce the 500-record cap when this PUT would CREATE a new
    // record. An in-place edit of an existing money document must never be
    // rejected because the collection is already full — that would reintroduce
    // exactly the "record disappears while you save it" failure this route
    // exists to remove.
    const existingRaw = await this.redis.hget(key, id);
    let createdAt = new Date().toISOString();
    if (existingRaw) {
      try {
        const prev = JSON.parse(existingRaw) as Record<string, unknown>;
        if (typeof prev.createdAt === 'string' && prev.createdAt) {
          createdAt = prev.createdAt;
        }
      } catch {
        // Corrupt prior value: treat createdAt as new, still overwrite in place.
      }
    } else {
      const count = await this.redis.hlen(key);
      if (count >= MAX_RECORDS_PER_COLLECTION) {
        throw new BadRequest(
          `Collection is full (${MAX_RECORDS_PER_COLLECTION} records max)`
        );
      }
    }

    const record = {
      ...(body as Record<string, unknown>),
      id,
      createdAt,
      updatedAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
      badRequest(`Record too large (${MAX_RECORD_BYTES / 1024}KB max)`);
    }
    // Single atomic HSET overwrite of one hash field — the whole point of this
    // route (vs DELETE+POST). Then re-arm the collection TTL like create().
    await this.redis.hset(key, id, serialized);
    await this.redis.expire(key, DATA_TTL_SECONDS);
    return record;
  }

  @Delete([
    '/api/apps-data/:slug/:collection/:id',
    '/api/v2/apps-data/:slug/:collection/:id',
  ])
  async remove(
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    setCors(res);
    this.assertNames(slug, collection);
    if (this.isV2(req)) this.requireWriteToken(req, slug);
    // Per-slug write throttle (typed 429 via passthrough — never raw).
    if (await this.isRateLimited(slug)) {
      res.status(HttpStatus.TOO_MANY_REQUESTS).json({ error: 'rate_limited' });
      return;
    }
    const key = dataKey(slug, collection);
    const removed = await this.redis.hdel(key, id);
    // Deletes also slide the window: touching a collection (even to remove a
    // record) counts as activity, so the rest of the collection stays alive.
    await this.touchTtl(key);
    return { deleted: removed > 0 };
  }

  @Delete([
    '/api/apps-data/:slug/:collection',
    '/api/v2/apps-data/:slug/:collection',
  ])
  async clear(
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    setCors(res);
    this.assertNames(slug, collection);
    // Destructive collection-wide wipe is gated on BOTH v1 and v2 — generated
    // apps never call it, so this closes the "wipe any app by slug" vector at
    // no back-compat cost.
    this.requireWriteToken(req, slug);
    await this.redis.del(dataKey(slug, collection));
    return { cleared: true };
  }
}
