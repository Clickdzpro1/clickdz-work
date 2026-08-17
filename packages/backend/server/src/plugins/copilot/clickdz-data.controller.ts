import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Logger,
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
import { AuthenticationRequired, BadRequest, Throttle } from '../../base';
import { CacheRedis } from '../../base/redis';
import { Public } from '../../core/auth';
import { Models } from '../../models';
import { type DataAction, verifyDataToken } from './cdz-data-token';
import {
  isDurableCollection,
  PARTITION_SUFFIX_RE,
} from './clickdz-erp-collections';

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
// DzOS Phase 0 (WS-A): raise the per-collection record cap now that Postgres
// is the source of truth for durable collections. 500 silently truncated
// reports/KPIs (revenue understated after the 500th order). 5,000 is well
// within the JSONB-row budget and the (slug, collection) index. The cap is
// still enforced on Redis-only/ephemeral collections (see isDurableCollection).
const MAX_RECORDS_PER_COLLECTION = 5_000;
const MAX_RECORDS_PER_COLLECTION_REDIS = 500; // legacy cap for non-durable
const MAX_LIST_LIMIT = 5_000;
// Redis TTL for EPHEMERAL collections only (render data: products/settings/
// categories/reviews/…). DURABLE collections (ERP money + legal docs + PII)
// NO LONGER expire on Redis — their source of truth is Postgres, and a 90-day
// silent expiry of legal invoices was a live data-loss risk (a merchant who
// didn't open the app for 90 days lost everything). See isDurableCollection.
const DATA_TTL_SECONDS = 90 * 24 * 60 * 60;

// DzOS Phase 0 (WS-A): durable collections are the ERP/money/legal/PII set.
// They are dual-written to Postgres, read from Postgres (source of truth),
// and NEVER TTL-expire on Redis. Ephemeral collections (products/settings/
// categories/reviews for storefront render) keep the legacy 90d Redis TTL —
// they are cache-grade and a storefront can always re-seed them. The
// classification + prefix set live in clickdz-erp-collections.ts (pure,
// unit-tested, reused by the sync engine) and are imported above.

// Per-slug write rate limit: a coarse fixed-window counter over the current
// epoch-minute. Cheap (one INCR + one EXPIRE), self-cleaning (short TTL), and
// only touches WRITE paths (POST/DELETE) — reads (list) are never limited.
const RL_MAX_WRITES_PER_MIN = 60;
const RL_TTL_SECONDS = 120;

// DzOS Phase 0 (WS-A): Postgres is now the SOURCE OF TRUTH for durable
// collections. Dual-write is ON by default (opt-out with CDZ_PG_DUAL_WRITE=0
// for emergency rollback). The pre-Phase-0 default was OFF; flipping it ON
// is the single change that stops the 90-day silent data-loss risk.
//
// House convention note: every other CDZ_* flag in this codebase is '1' = on.
// We keep that for explicit opt-in flags, but for THIS default-on flag we
// accept '0' as the explicit opt-OUT (anything else, including unset, = on).
const CDZ_PG_DUAL_WRITE = process.env.CDZ_PG_DUAL_WRITE !== '0';

// DzOS Phase 0 (WS-A): read cutover for durable collections. When ON (default),
// list() reads from Postgres (source of truth) and falls back to Redis only if
// PG returns nothing for that (slug, collection) — the safe migration path
// while the Redis→PG backfill is still settling. Ephemeral collections always
// read from Redis (cache-grade, no PG mirror). CDZ_PG_READ=0 forces Redis-only
// reads (emergency rollback, mirrors the dual-write opt-out).
const CDZ_PG_READ = process.env.CDZ_PG_READ !== '0';

// R18: the Phase A mirror is awaited on the merchant WRITE path, so a slow or
// unreachable Postgres would otherwise add its full pool/query wait to every
// order/caisse/invoice write. Bound it: on timeout the write still succeeds on
// Redis (the cache; PG is source of truth for durable collections) and the
// mirror is logged + dropped, exactly like any other mirror failure. Only
// reached when CDZ_PG_DUAL_WRITE is on (default since DzOS Phase 0); floor
// 250ms, default 2.5s.
const CDZ_PG_MIRROR_TIMEOUT_MS = Math.max(
  250,
  Number(process.env.CDZ_PG_MIRROR_TIMEOUT_MS) || 2500
);

// R15 PR-6: gate READS of PII-bearing collections behind the SAME per-slug
// data token that already gates writes. The public GET is @Public() and today
// returns ANY collection unauthenticated, so anyone with a shop slug can dump
// `orders`/`customers` → DZ phone numbers + addresses. Reads for storefront
// RENDER collections (products/settings/categories/reviews/…) must stay open.
//
// Denylist (not allowlist) so it FAILS SAFE for render: an unknown collection a
// generated app invented stays public rather than 401-ing the buyer-facing
// storefront; the PII set is small + well-known (audited from both templates).
// Exact literals harvested from the shop/ERP clients: orders, customers,
// clients, expenses, depenses, caisse, creances.
//
// SEC-2 added `creances` — the client debt ledger. Each row carries a customer's
// phone number alongside how much they owe, which is at least as sensitive as the
// rest of this set. It was omitted originally because the studio read it
// anonymously and gating it would have blanked the panel; now that studio reads go
// through the owner-authenticated bridge route, it can be protected.
const SENSITIVE_COLLECTIONS = new Set([
  'orders',
  'customers',
  'clients',
  'expenses',
  'depenses',
  'caisse',
  'creances',
]);

// Money documents are stored month-partitioned as `<prefix>-YYYYMM` (a ':' is
// illegal in a collection name — see the ERP client's partitionName()), e.g.
// `invoices-202607`, `caisse-202607`. So an exact-set lookup is not enough:
// strip a trailing `-YYYYMM` (6 digits) partition suffix and test the PREFIX,
// and also treat any `invoice*` name as sensitive (covers `invoices`,
// `invoices-202607`, and any future invoice-ish partition). Everything else
// (products/settings/categories/reviews/…) stays public.
const isSensitive = (c: string): boolean => {
  const base = c.replace(PARTITION_SUFFIX_RE, '');
  return (
    SENSITIVE_COLLECTIONS.has(base) ||
    SENSITIVE_COLLECTIONS.has(c) ||
    base.startsWith('invoice') ||
    c.startsWith('invoice')
  );
};

// R15 PR-6 staged rollout (zero-break). This flag decouples the SERVER-SIDE
// enforcement from the CLIENT-SIDE token-sending template edit so deployed
// storefronts never 401 mid-rollout:
//   1. flag OFF (default) — deploy this PR. Reads behave BYTE-IDENTICALLY to
//      today (no @Req extraction, no token check); templates now ALSO send the
//      bearer on reads but the @Public GET simply ignores it. Nothing breaks.
//   2. re-serve storefronts — apps re-mint/reload with the patched template JS
//      that attaches `Authorization: Bearer <DATA_TOKEN>` on GET (the token is
//      the stable `dataWriteToken(slug)` already embedded, so no data re-mint).
//   3. flip flag ON — sensitive reads now REQUIRE the token; anonymous slug
//      scraping of orders/customers/… is refused, while re-served admin/ERP
//      PII views keep working because their reads now carry the bearer.
// '1' = on — matches EVERY other CDZ_* flag (house convention; ops sets '1').
const CDZ_DATA_READ_GATE = process.env.CDZ_DATA_READ_GATE === '1';

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
  private readonly logger = new Logger(ClickDzDataController.name);

  // Models is @Global (ModelsModule) — adds no module wiring, same as
  // clickdz-bridge.controller.ts. Used only by the R15 Phase A PG mirror.
  constructor(
    private readonly redis: CacheRedis,
    private readonly models: Models
  ) {}

  private assertNames(slug: string, collection: string) {
    if (!SLUG_RE.test(slug)) badRequest('Invalid app slug');
    if (!COLLECTION_RE.test(collection)) badRequest('Invalid collection name');
  }

  // SEC-1: ALL writes/deletes are token-gated on BOTH the v1 and v2 paths.
  //
  // Previously create()/remove() gated only when the request path started with
  // '/api/v2/' (a since-deleted isV2() helper), for "back-compat with
  // already-deployed apps". That back-compat need does not exist: both
  // generated clients mint their data base as `<externalBase>/api/v2/apps-data/
  // <slug>` (see __CLICKDZ_DATA_URL__ in clickdz-shop-template.ts and
  // clickdz-erp-template.ts) and neither contains a single '/api/apps-data/'
  // reference. The v1 alias therefore served no legitimate client — only an
  // unauthenticated bypass: POST /api/apps-data/<slug>/<collection> created
  // records and DELETE .../<id> removed them with no credentials at all
  // (verified against production before this change: v1 → 201/200, v2 → 401).
  //
  // put() and clear() were already gated unconditionally; create()/remove()
  // were the outliers. All four now share one rule, so there is no version-
  // dependent auth path left to reason about. The v1 route aliases are kept
  // (removing them would 404 rather than 401, which is a worse error for any
  // stale client) but they now require the same per-slug token as v2.
  // SEC-3: the collection + action of the attempted write are passed through
  // to verifyDataToken so a SCOPED (d1.) token is checked against its embedded
  // scope. Legacy slug-only tokens keep authorizing everything while
  // CDZ_DATA_TOKEN_LEGACY is on — see cdz-data-token.ts.
  private requireWriteToken(
    req: Request,
    slug: string,
    collection: string,
    action: DataAction
  ) {
    const auth = String(req.headers['authorization'] || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const token = bearer || String((req.query?.t as string) || '');
    if (!verifyDataToken(slug, token, collection, action)) {
      throw new AuthenticationRequired('A valid write token is required');
    }
  }

  // R15 PR-6: read-side gate for PII-bearing collections. Identical extraction
  // + verification to requireWriteToken (SAME secret, SAME verifyDataToken — no
  // new auth mechanism), just a read-flavoured message. Same typed
  // AuthenticationRequired the write path throws, so the global exception
  // filter emits the same 401 (not a raw 500) on a missing/bad token. When the
  // secret is unset, verifyDataToken returns false → sensitive reads fail
  // CLOSED, exactly as writes already do.
  private requireReadToken(req: Request, slug: string, collection: string) {
    const auth = String(req.headers['authorization'] || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const token = bearer || String((req.query?.t as string) || '');
    if (!verifyDataToken(slug, token, collection, 'read')) {
      throw new AuthenticationRequired(
        'A valid token is required for this collection'
      );
    }
  }

  // Sliding-window TTL refresh for EPHEMERAL collections only. Durable
  // collections (ERP money + legal docs + PII) NO LONGER expire on Redis —
  // their source of truth is Postgres, and a 90-day silent expiry of legal
  // invoices was a live data-loss risk. touchTtl on a durable collection is a
  // no-op so the Redis key is left to natural cache eviction (LRU) rather than
  // a hard TTL. One EXPIRE per request on ephemeral keys only.
  private async touchTtl(key: string, collection: string) {
    if (isDurableCollection(collection)) return; // durable: no TTL
    await this.redis.expire(key, DATA_TTL_SECONDS);
  }

  // R15 Phase A / DzOS Phase 0: Postgres mirror of every Redis write. NEVER
  // throws — a PG failure must not change the HTTP outcome. ON by default
  // since DzOS Phase 0 (CDZ_PG_DUAL_WRITE !== '0'); rollback = set the flag to
  // '0'. R18: time-bounded (CDZ_PG_MIRROR_TIMEOUT_MS) so a slow PG can never
  // stall a merchant write past that budget — on timeout the mirror is
  // abandoned (logged) while the underlying op keeps running harmlessly to
  // completion in the background (its late settlement is swallowed so it can
  // never surface as an unhandled rejection).
  private async mirrorToPg(op: () => Promise<void>): Promise<void> {
    if (!CDZ_PG_DUAL_WRITE) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const running = op();
      running.catch(() => {});
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('pg mirror timeout')),
          CDZ_PG_MIRROR_TIMEOUT_MS
        );
      });
      await Promise.race([running, timeout]);
    } catch (err) {
      this.logger.warn(
        `[cdz-pg-dual-write] mirror failed (ignored): ${String(
          (err as Error)?.message ?? err
        )}`
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
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

  // R13 (429 fix): a deployed storefront polls its collections (products +
  // orders) from the shopper's browser UNAUTHENTICATED, so these reads land in
  // the per-IP default bucket (120/60s) shared with every other default-tier
  // route from that IP — prod http logs showed ~30 apps-data 429s alongside
  // the Hermes storm. The custom override (';custom' key, see base/throttler
  // generateKey) isolates list-reads into their OWN generous per-IP bucket.
  // NOTE (deliberate behavior change): adding a decorator also throttles
  // AUTHENTICATED callers, which previously bypassed unprotected routes
  // entirely — 600/60s is far above any legitimate studio/storefront rate
  // while still capping abuse at ~10 req/s per IP per route.
  @Throttle('default', { limit: 600, ttl: 60_000 })
  @Get([
    '/api/apps-data/:slug/:collection',
    '/api/v2/apps-data/:slug/:collection',
  ])
  async list(
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    setCors(res);
    this.assertNames(slug, collection);
    // R15 PR-6: gate PII-bearing collection reads behind the per-slug data
    // token, but ONLY once CDZ_DATA_READ_GATE is flipped on (staged rollout —
    // see the flag's comment). Flag OFF (default) ⇒ this branch is inert and
    // list() is byte-identical to its pre-PR-6 behaviour. Public render
    // collections (products/settings/…) are never sensitive, so they stay
    // open regardless of the flag. Checked right after assertNames so a bad
    // slug/collection still gets its precise 400 first (mirrors the write path,
    // which validates names before requiring the token).
    if (CDZ_DATA_READ_GATE && isSensitive(collection)) {
      this.requireReadToken(req, slug, collection);
    }
    const key = dataKey(slug, collection);
    const durable = isDurableCollection(collection);

    // DzOS Phase 0 (WS-A): read cutover. Durable collections read from
    // Postgres (source of truth), falling back to Redis only if PG returns
    // nothing for this (slug, collection) — the safe migration path while the
    // Redis→PG backfill is still settling. Ephemeral collections always read
    // from Redis (cache-grade, no PG mirror). CDZ_PG_READ=0 forces Redis-only.
    let records: Record<string, unknown>[] = [];
    if (durable && CDZ_PG_READ) {
      try {
        const rows = await this.models.cdzAppData.listByCollection(slug, collection);
        if (rows.length > 0) {
          records = rows.map((r) => ({ ...r.data, id: r.recordId }));
        } else {
          // PG empty for this collection — fall back to Redis (may still hold
          // data the backfill hasn't copied yet, or a pre-backfill collection).
          const raw = await this.redis.hgetall(key);
          records = Object.values(raw)
            .map((value) => {
              try {
                return JSON.parse(value) as Record<string, unknown>;
              } catch {
                return null;
              }
            })
            .filter((r): r is Record<string, unknown> => !!r);
        }
      } catch (err) {
        // PG table absent / unreachable — fail OPEN to Redis (a read must never
        // 500 because the durable mirror isn't provisioned yet). Logged once.
        this.logger.debug(
          `[cdz-pg-read] list fell back to Redis for ${slug}:${collection}: ${String(
            (err as Error)?.message ?? err
          ).slice(0, 120)}`
        );
        const raw = await this.redis.hgetall(key);
        records = Object.values(raw)
          .map((value) => {
            try {
              return JSON.parse(value) as Record<string, unknown>;
            } catch {
              return null;
            }
          })
          .filter((r): r is Record<string, unknown> => !!r);
      }
    } else {
      const raw = await this.redis.hgetall(key);
      records = Object.values(raw)
        .map((value) => {
          try {
            return JSON.parse(value) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((r): r is Record<string, unknown> => !!r);
    }
    // Reads slide the expiry window forward (ephemeral collections only;
    // durable collections have no Redis TTL — Postgres is source of truth).
    await this.touchTtl(key, collection);
    records.sort((a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
    );
    const max = Math.min(
      Math.max(Number(limit) || MAX_LIST_LIMIT, 1),
      MAX_LIST_LIMIT
    );
    // WS17: optional offset so internal callers (erpList) can paginate past the
    // cap instead of silently truncating collections with more records. The cap
    // is 5,000 for durable (PG-backed) collections, 500 for ephemeral.
    // Negative/non-numeric offset is treated as 0 (fail-safe). The slice is
    // bounded by the records length so an over-large offset simply returns [].
    const start = Math.max(Number(offset) || 0, 0);
    return records.slice(start, start + max);
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
    // SEC-1: gated on BOTH v1 and v2 (was: v2 only — see requireWriteToken).
    this.requireWriteToken(req, slug, collection, 'create');
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
    const durable = isDurableCollection(collection);
    const cap = durable ? MAX_RECORDS_PER_COLLECTION : MAX_RECORDS_PER_COLLECTION_REDIS;
    const count = await this.redis.hlen(key);
    // Durable collections are PG-backed (5,000 cap); ephemeral stay at 500.
    // For durable collections the Redis count is a lower bound (PG may have
    // more after backfill) — the authoritative cap check is the PG upsert's
    // own constraint, but we keep the Redis-side guard as a cheap first line.
    if (count >= cap) {
      throw new BadRequest(`Collection is full (${cap} records max)`);
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
    // Durable collections: no Redis TTL (PG is source of truth). Ephemeral:
    // re-arm the 90d TTL like the legacy create() did.
    await this.touchTtl(key, collection);
    // R15 Phase A: durable PG copy (best-effort, never throws).
    await this.mirrorToPg(() =>
      this.models.cdzAppData.upsert(slug, collection, id, record)
    );
    return record;
  }

  // Native atomic upsert (v2-only). Writes a single record IN PLACE at a
  // caller-chosen id via one HSET, so there is no delete-then-recreate window:
  // a concurrent reader always sees either the old or the new document, never a
  // gap. Money documents (invoices/caisse) must never vanish mid-edit under
  // concurrency — this is the primitive the delete+recreate path cannot give.
  //
  // Always token-gated — as every write/delete route now is (SEC-1); this route
  // never had a v1 alias to begin with, being v2-only from birth.
  // Preserves the original createdAt on update and stamps updatedAt;
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
    this.requireWriteToken(req, slug, collection, 'upsert');
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
      const durable = isDurableCollection(collection);
      const cap = durable ? MAX_RECORDS_PER_COLLECTION : MAX_RECORDS_PER_COLLECTION_REDIS;
      const count = await this.redis.hlen(key);
      if (count >= cap) {
        throw new BadRequest(`Collection is full (${cap} records max)`);
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
    // route (vs DELETE+POST). Durable collections skip the TTL (PG is source of
    // truth); ephemeral re-arm the 90d TTL like create().
    await this.redis.hset(key, id, serialized);
    await this.touchTtl(key, collection);
    // R15 Phase A: durable PG copy. upsert() preserves created_at on conflict,
    // so the PG row keeps the same createdAt this record carries.
    await this.mirrorToPg(() =>
      this.models.cdzAppData.upsert(slug, collection, id, record)
    );
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
    // SEC-1: gated on BOTH v1 and v2 (was: v2 only — see requireWriteToken).
    this.requireWriteToken(req, slug, collection, 'delete');
    // Per-slug write throttle (typed 429 via passthrough — never raw).
    if (await this.isRateLimited(slug)) {
      res.status(HttpStatus.TOO_MANY_REQUESTS).json({ error: 'rate_limited' });
      return;
    }
    const key = dataKey(slug, collection);
    const removed = await this.redis.hdel(key, id);
    // Deletes also slide the window on ephemeral collections (durable ones
    // have no TTL; the delete is mirrored to PG below regardless).
    await this.touchTtl(key, collection);
    // R15 Phase A: mirror the delete to PG (best-effort, never throws). DzOS
    // Phase 1: also record a tombstone so the /erp/changes feed can tell
    // clients the record was removed (without it, a hard-delete leaves a ghost
    // in every client's local store).
    await this.mirrorToPg(async () => {
      await this.models.cdzAppData.delete(slug, collection, id);
      if (isDurableCollection(collection)) {
        await this.models.cdzAppDataTombstone.record(slug, collection, id);
      }
    });
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
    // no back-compat cost. SEC-3: `clear` is additionally OUTSIDE the scope of
    // every publicDataToken, so an HTML-embedded token can never wipe.
    this.requireWriteToken(req, slug, collection, 'clear');
    await this.redis.del(dataKey(slug, collection));
    // R15 Phase A: mirror the collection wipe to PG (best-effort, never throws).
    await this.mirrorToPg(() =>
      this.models.cdzAppData.clearCollection(slug, collection)
    );
    return { cleared: true };
  }
}
