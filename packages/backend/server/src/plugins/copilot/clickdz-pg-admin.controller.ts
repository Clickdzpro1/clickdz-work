import { Controller, Get, Logger, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

import { Throttle } from '../../base';
import { CacheRedis } from '../../base/redis';
import { Public } from '../../core/auth';
import { Models } from '../../models';

/**
 * ClickDz Postgres admin — R18 durability endgame tooling.
 *
 * The ops container's egress firewall is HTTP/HTTPS-only and cannot reach the
 * Railway Postgres (:5432). This controller is the ONLY window into that
 * database and the ONLY driver for the Phase B backfill — both must therefore
 * run inside the app, on the private network, via Prisma.
 *
 * Ships completely inert (dark), gated twice:
 *   1. CDZ_PG_ADMIN_ENABLED must be '1' — otherwise every route answers 404, so
 *      a normal deploy behaves as if this controller does not exist.
 *   2. Authorization: Bearer <CDZ_PG_ADMIN_TOKEN>, compared in constant time.
 *      When the token env is unset the gate fails CLOSED (no request matches).
 *
 * It touches NO merchant-facing path: `/status` is read-only aggregate counts;
 * `/backfill` SCANs exactly the `clickdz:appdata:*` keyspace the data API reads
 * already use and idempotently upserts each record into `cdz_app_data` through
 * the SAME model method the live dual-write uses.
 */
const CDZ_PG_ADMIN_ENABLED = process.env.CDZ_PG_ADMIN_ENABLED === '1';

const APPDATA_PREFIX = 'clickdz:appdata:';
const SCAN_MATCH = `${APPDATA_PREFIX}*`;
const DEFAULT_SCAN_COUNT = 25;
const MAX_SCAN_COUNT = 200;
// Per-call record budget bounds each backfill call's wall time (each record is
// an awaited round-trip) so an edge proxy never cuts a long-held request. The
// budget is checked only AFTER a full SCAN batch completes, so no key is ever
// half-scanned (which would skip keys) and the cursor always advances by ≥1
// batch per call — progress is guaranteed, never a stall.
const DEFAULT_RECORD_BUDGET = 2000;
const MAX_RECORD_BUDGET = 20000;

const clampInt = (v: string | undefined, def: number, lo: number, hi: number) =>
  Math.min(Math.max(Number(v) || def, lo), hi);

@Public()
@Controller()
export class ClickDzPgAdminController {
  private readonly logger = new Logger(ClickDzPgAdminController.name);

  // Same injections as ClickDzDataController: CacheRedis for SCAN/HGETALL and
  // Models (@Global) for the cdz_app_data mirror. No extra module wiring.
  constructor(
    private readonly redis: CacheRedis,
    private readonly models: Models
  ) {}

  // Writes a 404 and returns true when the feature flag is off, so a disabled
  // deploy answers these paths as not-found (the JSON body differs from the
  // framework default, but the route exposes nothing and does no work). The
  // caller MUST `return` when this returns true.
  private denyIfDisabled(res: Response): boolean {
    if (!CDZ_PG_ADMIN_ENABLED) {
      res.status(404).json({ error: 'not_found' });
      return true;
    }
    return false;
  }

  // Constant-time bearer check against CDZ_PG_ADMIN_TOKEN. Fails CLOSED when the
  // env token is empty (unset ⇒ no request can ever authenticate). Both sides
  // are hashed to a fixed 32 bytes first, which avoids leaking length AND
  // sidesteps timingSafeEqual's throw on unequal-length inputs. Writes a 401
  // and returns false on failure; the caller MUST `return`.
  private authOk(req: Request, res: Response): boolean {
    const expected = String(process.env.CDZ_PG_ADMIN_TOKEN || '');
    const auth = String(req.headers['authorization'] || '');
    const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const ok =
      expected.length > 0 &&
      timingSafeEqual(
        createHash('sha256').update(provided).digest(),
        createHash('sha256').update(expected).digest()
      );
    if (!ok) {
      res.status(401).json({ error: 'unauthorized' });
      return false;
    }
    return true;
  }

  // key = `clickdz:appdata:{slug}:{collection}`. Neither slug ([a-z0-9-]) nor
  // collection ([a-z0-9_-], plus an optional -YYYYMM partition suffix) can hold
  // a ':', so split ONCE on the first ':' after the prefix. Returns null for a
  // malformed key (defensive — such a key is skipped, never fatal).
  private parseKey(key: string): { slug: string; collection: string } | null {
    if (!key.startsWith(APPDATA_PREFIX)) return null;
    const rest = key.slice(APPDATA_PREFIX.length);
    const i = rest.indexOf(':');
    if (i <= 0 || i >= rest.length - 1) return null;
    return { slug: rest.slice(0, i), collection: rest.slice(i + 1) };
  }

  // Read-only durability probe: does the table exist, how many rows / distinct
  // shops does it hold, and which durability flags are live. This is the only
  // way to observe Postgres from outside the private network.
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get(['/api/v1/cdz-admin/pg/status'])
  async status(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (this.denyIfDisabled(res)) return;
    if (!this.authOk(req, res)) return;
    const flags = {
      dualWrite: process.env.CDZ_PG_DUAL_WRITE === '1',
      readGate: process.env.CDZ_DATA_READ_GATE === '1',
    };
    try {
      const s = await this.models.cdzAppData.stats();
      return {
        tableExists: true,
        totalRows: s.totalRows,
        distinctSlugs: s.distinctSlugs,
        flags,
      };
    } catch (err) {
      // A missing table (migration not applied) throws here — report it rather
      // than 500, so the operator learns the migration state from one call.
      return {
        tableExists: false,
        error: String((err as Error)?.message ?? err).slice(0, 300),
        flags,
      };
    }
  }

  // Phase B backfill: mirror historical Redis app-data into Postgres. Performs
  // exactly ONE Redis SCAN step per HTTP call and fully processes the keys that
  // step returns, then hands the next cursor back. Because it never truncates a
  // SCAN batch mid-way, a client that loops from cursor '0' until `done` visits
  // every collection at least once; idempotent upserts make SCAN's
  // "may return duplicates" guarantee harmless. Bounded per call ⇒ no long-held
  // request that an edge proxy could cut.
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Post(['/api/v1/cdz-admin/pg/backfill'])
  async backfill(
    @Query('cursor') cursor: string | undefined,
    @Query('count') count: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    if (this.denyIfDisabled(res)) return;
    if (!this.authOk(req, res)) return;

    const scanCount = clampInt(count, DEFAULT_SCAN_COUNT, 1, MAX_SCAN_COUNT);
    const budget = clampInt(
      req.query?.budget as string | undefined,
      DEFAULT_RECORD_BUDGET,
      100,
      MAX_RECORD_BUDGET
    );

    let cur = String(cursor ?? '0');
    let done = false;
    let rawKeys = 0;
    let scannedKeys = 0;
    let records = 0;
    let upserted = 0;
    let parseErrors = 0;
    let redisErrors = 0;
    let pgErrors = 0;

    // Process WHOLE SCAN batches; only re-check the budget after a batch is
    // fully drained. That guarantees (a) no key is left half-processed → no
    // skipped keys, and (b) the cursor advances by ≥1 batch each call → the
    // loop always makes progress and a client looping cursor '0'→done finishes.
    do {
      const [next, keys] = (await this.redis.scan(
        cur,
        'MATCH',
        SCAN_MATCH,
        'COUNT',
        scanCount
      )) as [string, string[]];
      cur = next;
      for (const key of keys) {
        rawKeys++;
        const parsed = this.parseKey(key);
        if (!parsed) continue;
        scannedKeys++;
        let hash: Record<string, string>;
        try {
          hash = await this.redis.hgetall(key);
        } catch {
          redisErrors++;
          continue;
        }
        for (const [recordId, value] of Object.entries(hash)) {
          records++;
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(value) as Record<string, unknown>;
          } catch {
            parseErrors++;
            continue;
          }
          // Only pass a createdAt PG can actually cast; anything unparseable
          // falls back to null → now() rather than throwing away the record.
          const rawCa = data.createdAt;
          const createdAt =
            typeof rawCa === 'string' && rawCa && !Number.isNaN(Date.parse(rawCa))
              ? rawCa
              : null;
          try {
            await this.models.cdzAppData.backfillUpsert(
              parsed.slug,
              parsed.collection,
              recordId,
              data,
              createdAt
            );
            upserted++;
          } catch (err) {
            pgErrors++;
            if (pgErrors <= 3) {
              this.logger.warn(
                `[cdz-pg-backfill] upsert failed ${parsed.slug}/${parsed.collection}/${recordId}: ${String(
                  (err as Error)?.message ?? err
                ).slice(0, 200)}`
              );
            }
          }
        }
      }
      done = cur === '0';
    } while (!done && records < budget);

    return {
      cursor: cur,
      done,
      rawKeys,
      scannedKeys,
      records,
      upserted,
      parseErrors,
      redisErrors,
      pgErrors,
    };
  }
}
