import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { BaseModel } from './base';

/**
 * CdzErpSeqModel — R18 PR-B: the durable home of the ERP's gap-less legal
 * document counters (devis / bl / facture / po, one yearly series per slug —
 * the DZ fiscal convention).
 *
 * Today the counter is a bare Redis INCR on `clickdz:erpseq:{slug}:{type}:{year}`.
 * Redis restore from the 6h RDB would regress it and REISSUE legal facture
 * numbers — a fiscal violation. This table makes Postgres the monotonic floor:
 *
 *   reserve():  INSERT ... ON CONFLICT DO UPDATE
 *                 SET value = GREATEST(pg.value, redisHint - 1) + 1
 *               RETURNING value
 *
 * Properties (the whole point — reason here before touching the SQL):
 *   - Atomic: the upsert takes a row lock; two concurrent validations get two
 *     distinct numbers.
 *   - PG behind / missing row (seed miss): GREATEST(..., hint-1)+1 >= hint —
 *     the returned number never goes below what Redis just issued.
 *   - Redis behind (crash-restore): PG's value wins — the returned number
 *     continues after the highest EVER issued; duplicates become impossible.
 *   - No burned numbers: PG jumping up to Redis's value only mirrors numbers
 *     that were genuinely issued.
 *
 * Like cdz-app-data.ts, the migration is also applied IN-APP (boot never runs
 * `prisma migrate deploy` on this deployment) via ensureSchema(), called from
 * the pg-admin migrate route.
 */
const CDZ_ERP_SEQ_MIGRATION_NAME = '20260724000000_cdz_erp_seq';
// sha256 of migrations/20260724000000_cdz_erp_seq/migration.sql — byte-exact,
// so a future real `prisma migrate deploy` sees this as cleanly applied.
const CDZ_ERP_SEQ_MIGRATION_CHECKSUM =
  '71dbdc8d844aeeaa960522b84b2902683828c225ad79b171a878b75e7c06fb04';
const CDZ_ERP_SEQ_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "cdz_erp_seq" (
    "slug" VARCHAR NOT NULL,
    "doc_type" VARCHAR NOT NULL,
    "year" INTEGER NOT NULL,
    "value" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cdz_erp_seq_pkey" PRIMARY KEY ("slug", "doc_type", "year")
  )`,
];

@Injectable()
export class CdzErpSeqModel extends BaseModel {
  // Reserve the next number with PG as the monotonic floor. `redisHint` is the
  // value the legacy Redis INCR just returned (>=1); the returned value is
  // always >= redisHint and strictly increases per (slug,type,year) row.
  // value::int cast keeps Prisma from returning a JS BigInt (seq values are
  // tiny; int is safe and JSON-serializable).
  @Transactional()
  async reserve(
    slug: string,
    docType: string,
    year: number,
    redisHint: number
  ): Promise<number> {
    const hint = Math.max(1, Math.floor(Number(redisHint) || 1));
    const rows = await this.db.$queryRaw<{ value: number }[]>`
      INSERT INTO cdz_erp_seq (slug, doc_type, year, value, updated_at)
      VALUES (${slug}, ${docType}, ${Math.floor(year)}, GREATEST(1, ${hint}), now())
      ON CONFLICT (slug, doc_type, year)
      DO UPDATE SET
        value = GREATEST(cdz_erp_seq.value, ${hint} - 1) + 1,
        updated_at = now()
      RETURNING value::int AS "value"
    `;
    const v = Number(rows[0]?.value);
    // A missing row from RETURNING would be a driver anomaly — treat as an
    // error so the caller's fail-soft wrapper falls back to the Redis number
    // rather than silently trusting a bogus 0/NaN.
    if (!Number.isFinite(v) || v < 1) {
      throw new Error('cdz_erp_seq reserve returned no value');
    }
    return v;
  }

  // Backfill/seed: raise the stored value to at least `value` (never lowers —
  // GREATEST on conflict), used by the pg-admin erpseq backfill that mirrors
  // the current Redis counters before the flag flips. Idempotent; safe to race
  // a live reserve() (both only move the value up).
  @Transactional()
  async seedMax(
    slug: string,
    docType: string,
    year: number,
    value: number
  ): Promise<void> {
    const v = Math.max(1, Math.floor(Number(value) || 1));
    await this.db.$executeRaw`
      INSERT INTO cdz_erp_seq (slug, doc_type, year, value, updated_at)
      VALUES (${slug}, ${docType}, ${Math.floor(year)}, ${v}, now())
      ON CONFLICT (slug, doc_type, year)
      DO UPDATE SET
        value = GREATEST(cdz_erp_seq.value, EXCLUDED.value),
        updated_at = now()
    `;
  }

  // Read-only floor probe: the highest number PG has granted/seeded for one
  // series, or null when no row exists. Used by the bridge's fallback guard —
  // when the main reserve times out, a fast floor read decides whether the raw
  // Redis number is safe to issue (floor < rNum) or would REISSUE a legal
  // number (floor >= rNum ⇒ Redis has regressed; self-heal instead).
  async floor(
    slug: string,
    docType: string,
    year: number
  ): Promise<number | null> {
    const rows = await this.db.$queryRaw<{ value: number }[]>`
      SELECT value::int AS "value"
      FROM cdz_erp_seq
      WHERE slug = ${slug} AND doc_type = ${docType} AND year = ${Math.floor(year)}
    `;
    const v = rows[0]?.value;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  // Read-only aggregate for the pg-admin status probe.
  async stats(): Promise<{ totalRows: number; distinctSlugs: number }> {
    const rows = await this.db.$queryRaw<{ total: number; slugs: number }[]>`
      SELECT count(*)::int AS total, count(DISTINCT slug)::int AS slugs
      FROM cdz_erp_seq
    `;
    const r = rows[0] ?? { total: 0, slugs: 0 };
    return { totalRows: Number(r.total), distinctSlugs: Number(r.slugs) };
  }

  // In-app migration (same pattern + rationale as CdzAppDataModel.ensureSchema:
  // boot never runs `prisma migrate deploy` here). Advisory xact lock
  // serializes concurrent callers; DDL consts only (never request-derived
  // SQL); best-effort _prisma_migrations mark with the byte-exact checksum.
  @Transactional()
  async ensureSchema(): Promise<{
    alreadyExisted: boolean;
    ranDdl: boolean;
    migrationMarked: boolean;
    markError?: string;
  }> {
    // $executeRaw, NOT $queryRaw: pg_advisory_xact_lock() returns SQL `void`,
    // which Prisma's $queryRaw cannot deserialize (hit live in the twin
    // cdz-app-data ensureSchema — R18-A3 hotfix). $executeRaw skips row
    // deserialization; canonical Prisma advisory-lock idiom.
    await this.db.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('cdz_erp_seq_migration'))
    `;
    const probe = await this.db.$queryRaw<{ reg: string | null }[]>`
      SELECT to_regclass('public.cdz_erp_seq')::text AS reg
    `;
    const alreadyExisted = !!probe[0]?.reg;
    let ranDdl = false;
    if (!alreadyExisted) {
      for (const stmt of CDZ_ERP_SEQ_DDL) {
        await this.db.$executeRawUnsafe(stmt);
      }
      ranDdl = true;
    }
    let migrationMarked = false;
    let markError: string | undefined;
    try {
      await this.db.$executeRaw`
        INSERT INTO _prisma_migrations (
          id, checksum, finished_at, migration_name, logs,
          rolled_back_at, started_at, applied_steps_count
        )
        SELECT
          gen_random_uuid()::text,
          ${CDZ_ERP_SEQ_MIGRATION_CHECKSUM},
          now(),
          ${CDZ_ERP_SEQ_MIGRATION_NAME},
          NULL, NULL, now(), 1
        WHERE NOT EXISTS (
          SELECT 1 FROM _prisma_migrations
          WHERE migration_name = ${CDZ_ERP_SEQ_MIGRATION_NAME}
        )
      `;
      migrationMarked = true;
    } catch (err) {
      markError = String((err as Error)?.message ?? err).slice(0, 200);
    }
    return { alreadyExisted, ranDdl, migrationMarked, markError };
  }
}
