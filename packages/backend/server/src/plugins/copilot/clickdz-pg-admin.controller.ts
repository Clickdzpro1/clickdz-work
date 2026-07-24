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
// R18 PR-B: the ERP's gap-less legal counters live OUTSIDE the appdata
// keyspace — `clickdz:erpseq:{slug}:{docType}:{year}`, value = integer string
// written by INCR. They get their own backfill (seedMax → PG monotonic floor).
const ERPSEQ_PREFIX = 'clickdz:erpseq:';
const ERPSEQ_SCAN_MATCH = `${ERPSEQ_PREFIX}*`;
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

  // key = `clickdz:erpseq:{slug}:{docType}:{year}` — none of the segments can
  // hold a ':' (slug [a-z0-9-]; docType is a small literal set: devis/bl/
  // facture/po; year is digits), so an exact 3-way split is authoritative.
  // Returns null on anything malformed (skipped, never fatal).
  private parseErpSeqKey(
    key: string
  ): { slug: string; docType: string; year: number } | null {
    if (!key.startsWith(ERPSEQ_PREFIX)) return null;
    const parts = key.slice(ERPSEQ_PREFIX.length).split(':');
    if (parts.length !== 3) return null;
    const [slug, docType, yearStr] = parts;
    if (!slug || !docType || !/^\d{4}$/.test(yearStr)) return null;
    return { slug, docType, year: Number(yearStr) };
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
    // R18 PR-B: per-table probes (a missing table throws 42P01 — reported as
    // tableExists:false rather than a 500, so one call maps the whole state).
    // Top-level shape stays backward compatible; `erpSeq` is additive.
    let appData;
    try {
      const s = await this.models.cdzAppData.stats();
      appData = {
        tableExists: true,
        totalRows: s.totalRows,
        distinctSlugs: s.distinctSlugs,
      };
    } catch (err) {
      appData = {
        tableExists: false,
        error: String((err as Error)?.message ?? err).slice(0, 300),
      };
    }
    let erpSeq;
    try {
      const s = await this.models.cdzErpSeq.stats();
      erpSeq = {
        tableExists: true,
        totalRows: s.totalRows,
        distinctSlugs: s.distinctSlugs,
      };
    } catch (err) {
      erpSeq = {
        tableExists: false,
        error: String((err as Error)?.message ?? err).slice(0, 300),
      };
    }
    return { ...appData, erpSeq, flags };
  }

  // R18-A2: apply the cdz_app_data migration in-app. This deployment's boot
  // never runs `prisma migrate deploy` (verified: zero migration lines in the
  // boot logs), so image-shipped migrations never reach the live DB — the
  // status probe surfaced 42P01. Narrow by construction: the model can only
  // replay the ONE hardcoded migration (exact repo DDL + checksum), never
  // arbitrary SQL. Idempotent — safe to call repeatedly; reports what it did.
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Post(['/api/v1/cdz-admin/pg/migrate'])
  async migrate(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    if (this.denyIfDisabled(res)) return;
    if (!this.authOk(req, res)) return;
    // R18 PR-B: ensure BOTH cdz tables (each model owns exactly its own
    // hardcoded migration; failures are independent and reported per table).
    const out: Record<string, unknown> = { ok: true };
    try {
      const appData = await this.models.cdzAppData.ensureSchema();
      this.logger.log(
        `[cdz-pg-migrate] cdz_app_data alreadyExisted=${appData.alreadyExisted} ranDdl=${appData.ranDdl} migrationMarked=${appData.migrationMarked}`
      );
      out.appData = appData;
    } catch (err) {
      out.ok = false;
      out.appDataError = String((err as Error)?.message ?? err).slice(0, 300);
    }
    try {
      const erpSeq = await this.models.cdzErpSeq.ensureSchema();
      this.logger.log(
        `[cdz-pg-migrate] cdz_erp_seq alreadyExisted=${erpSeq.alreadyExisted} ranDdl=${erpSeq.ranDdl} migrationMarked=${erpSeq.migrationMarked}`
      );
      out.erpSeq = erpSeq;
    } catch (err) {
      out.ok = false;
      out.erpSeqError = String((err as Error)?.message ?? err).slice(0, 300);
    }
    return out;
  }

  // R18-A2 diagnostic: which migrations the live DB believes are applied
  // (latest 30 rows of _prisma_migrations). Read-only.
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get(['/api/v1/cdz-admin/pg/migrations'])
  async migrations(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    if (this.denyIfDisabled(res)) return;
    if (!this.authOk(req, res)) return;
    try {
      const rows = await this.models.cdzAppData.migrationsStatus();
      return { ok: true, count: rows.length, migrations: rows };
    } catch (err) {
      return {
        ok: false,
        error: String((err as Error)?.message ?? err).slice(0, 300),
      };
    }
  }

  // Phase B backfill: mirror historical Redis app-data into Postgres. Each HTTP
  // call drains WHOLE SCAN batches until the per-call record budget is spent,
  // then hands the next cursor back. Because a batch is never truncated mid-way,
  // a client that loops from cursor '0' until `done` visits every collection at
  // least once; idempotent upserts make SCAN's "may return duplicates"
  // guarantee harmless. Budget-bounded per call ⇒ no long-held request that an
  // edge proxy could cut.
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

  // R18 PR-B: mirror the ERP's legal counters into cdz_erp_seq (seedMax — only
  // ever raises the PG value, so re-runs and races with a live reserve are
  // harmless). MUST run to completion BEFORE CDZ_ERPSEQ_PG flips on, so PG
  // starts life as the monotonic floor of every counter Redis has ever issued.
  // Same whole-batch SCAN + budget shape as the appdata backfill; the erpseq
  // keyspace is tiny (one key per slug×docType×year) so one call normally
  // finishes it (done:true).
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Post(['/api/v1/cdz-admin/pg/backfill-erpseq'])
  async backfillErpSeq(
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
    let counters = 0;
    let seeded = 0;
    let parseErrors = 0;
    let redisErrors = 0;
    let pgErrors = 0;

    do {
      const [next, keys] = (await this.redis.scan(
        cur,
        'MATCH',
        ERPSEQ_SCAN_MATCH,
        'COUNT',
        scanCount
      )) as [string, string[]];
      cur = next;
      for (const key of keys) {
        rawKeys++;
        const parsed = this.parseErpSeqKey(key);
        if (!parsed) {
          parseErrors++;
          continue;
        }
        counters++;
        let raw: string | null;
        try {
          raw = await this.redis.get(key);
        } catch {
          redisErrors++;
          continue;
        }
        const value = Math.floor(Number(raw));
        if (!Number.isFinite(value) || value < 1) {
          parseErrors++;
          continue;
        }
        try {
          await this.models.cdzErpSeq.seedMax(
            parsed.slug,
            parsed.docType,
            parsed.year,
            value
          );
          seeded++;
        } catch (err) {
          pgErrors++;
          if (pgErrors <= 3) {
            this.logger.warn(
              `[cdz-pg-backfill-erpseq] seed failed ${parsed.slug}/${parsed.docType}/${parsed.year}: ${String(
                (err as Error)?.message ?? err
              ).slice(0, 200)}`
            );
          }
        }
      }
      done = cur === '0';
    } while (!done && counters < budget);

    return {
      cursor: cur,
      done,
      rawKeys,
      counters,
      seeded,
      parseErrors,
      redisErrors,
      pgErrors,
    };
  }
}
