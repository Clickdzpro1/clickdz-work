import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { BaseModel } from './base';

// R18-A2: this deployment's container boots straight into NestJS and NEVER
// runs `prisma migrate deploy` (verified from boot logs — zero migration
// lines), so migrations that ship in the image are never applied to the live
// database. 20260723000000_cdz_app_data is one of them: the live status probe
// returned 42P01 (relation does not exist). The constants below replay that
// migration EXACTLY (same DDL as migrations/20260723000000_cdz_app_data/
// migration.sql, IF NOT EXISTS added for idempotency) via the pg-admin route —
// the only path into PG past the ops firewall. Static strings only:
// $executeRawUnsafe is fed these hardcoded consts, never interpolated input.
const CDZ_APP_DATA_MIGRATION_NAME = '20260723000000_cdz_app_data';
// sha256 of the repo migration.sql, so the _prisma_migrations row we record is
// byte-exact with what `prisma migrate deploy` would have written — a future
// real migrate run must see this migration as cleanly applied (no drift).
const CDZ_APP_DATA_MIGRATION_CHECKSUM =
  '20461a9b4e781d4663e35a42101a5077e9ddcba3c833c515fc5ee4336cef7afb';
const CDZ_APP_DATA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "cdz_app_data" (
    "slug" VARCHAR NOT NULL,
    "collection" VARCHAR NOT NULL,
    "record_id" VARCHAR NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "rev" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cdz_app_data_pkey" PRIMARY KEY ("slug", "collection", "record_id")
  )`,
  `CREATE INDEX IF NOT EXISTS "cdz_app_data_slug_collection_idx" ON "cdz_app_data" ("slug", "collection")`,
  `CREATE INDEX IF NOT EXISTS "cdz_app_data_slug_updated_at_idx" ON "cdz_app_data" ("slug", "updated_at")`,
  // DzOS Phase 1: add the rev column to a pre-Phase-1 table (idempotent ALTER).
  `ALTER TABLE "cdz_app_data" ADD COLUMN IF NOT EXISTS "rev" INTEGER NOT NULL DEFAULT 0`,
];

export type CdzAppDataRow = {
  slug: string;
  collection: string;
  recordId: string;
  data: Record<string, unknown>;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class CdzAppDataModel extends BaseModel {
  // Idempotent write-in-place. Mirrors WorkspaceRuntimeStateModel.upsertCurrent:
  // raw INSERT ... ON CONFLICT so a re-save of the same (slug,collection,id)
  // overwrites data + bumps updated_at and never errors on the composite PK.
  // created_at is preserved on conflict (only set on first insert).
  @Transactional()
  async upsert(
    slug: string,
    collection: string,
    recordId: string,
    data: Record<string, unknown>
  ) {
    // DzOS Phase 1: bump rev on every write (1 on insert, +1 on conflict) so
    // the /erp/changes feed carries a monotonic per-record revision clients
    // merge with (LWW on rev + updatedAt). created_at preserved on conflict.
    await this.db.$executeRaw`
      INSERT INTO cdz_app_data (
        slug, collection, record_id, data, rev, created_at, updated_at
      )
      VALUES (
        ${slug}, ${collection}, ${recordId},
        ${JSON.stringify(data)}::jsonb, 1, now(), now()
      )
      ON CONFLICT (slug, collection, record_id)
      DO UPDATE SET
        data = EXCLUDED.data,
        rev = cdz_app_data.rev + 1,
        updated_at = now()
    `;
  }

  // Single-record delete (mirrors controller.remove → HDEL of one field).
  @Transactional()
  async delete(slug: string, collection: string, recordId: string) {
    await this.db.$executeRaw`
      DELETE FROM cdz_app_data
      WHERE slug = ${slug}
        AND collection = ${collection}
        AND record_id = ${recordId}
    `;
  }

  // Collection-wide wipe (mirrors controller.clear → DEL of the whole hash).
  @Transactional()
  async clearCollection(slug: string, collection: string) {
    await this.db.$executeRaw`
      DELETE FROM cdz_app_data
      WHERE slug = ${slug} AND collection = ${collection}
    `;
  }

  // R18-A2: idempotently apply the cdz_app_data migration in-app (see the
  // header comment — boot never runs `prisma migrate deploy` here). Narrowly
  // scoped by design: this method can ONLY replay the hardcoded
  // 20260723000000_cdz_app_data DDL, never arbitrary SQL. @Transactional +
  // pg_advisory_xact_lock serialize concurrent callers (Sentinel MINOR-1), so
  // the WHERE NOT EXISTS mark below can never double-insert. Sequence:
  //   1. advisory xact lock — one migrator at a time (auto-released on commit).
  //   2. to_regclass probe — was the table already there?
  //   3. If not, run the exact DDL (IF NOT EXISTS ⇒ re-entrant either way).
  //   4. Best-effort: record the migration as applied in _prisma_migrations
  //      (checksum byte-exact with the repo file) so a future real
  //      `prisma migrate deploy` sees it as done instead of re-applying. A
  //      failure here never fails the call — the table is what matters.
  // `ranDdl` reports "this call executed the DDL branch" (under the lock that
  // means it really did create the table), not merely "table exists now".
  @Transactional()
  async ensureSchema(): Promise<{
    alreadyExisted: boolean;
    ranDdl: boolean;
    migrationMarked: boolean;
    markError?: string;
  }> {
    // $executeRaw, NOT $queryRaw: pg_advisory_xact_lock() returns SQL `void`,
    // which Prisma's $queryRaw cannot deserialize ("Failed to deserialize
    // column of type 'void'" — hit live on first prod call, R18-A3 hotfix).
    // $executeRaw skips row deserialization; this is the canonical Prisma
    // advisory-lock idiom.
    await this.db.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('cdz_app_data_migration'))
    `;
    const probe = await this.db.$queryRaw<{ reg: string | null }[]>`
      SELECT to_regclass('public.cdz_app_data')::text AS reg
    `;
    const alreadyExisted = !!probe[0]?.reg;
    let ranDdl = false;
    if (!alreadyExisted) {
      for (const stmt of CDZ_APP_DATA_DDL) {
        await this.db.$executeRawUnsafe(stmt);
      }
      ranDdl = true;
    }
    let migrationMarked = false;
    let markError: string | undefined;
    try {
      // _prisma_migrations has no unique index on migration_name, so guard the
      // insert with WHERE NOT EXISTS instead of ON CONFLICT. gen_random_uuid()
      // is native on PG13+ (this DB is pgvector/pg16).
      await this.db.$executeRaw`
        INSERT INTO _prisma_migrations (
          id, checksum, finished_at, migration_name, logs,
          rolled_back_at, started_at, applied_steps_count
        )
        SELECT
          gen_random_uuid()::text,
          ${CDZ_APP_DATA_MIGRATION_CHECKSUM},
          now(),
          ${CDZ_APP_DATA_MIGRATION_NAME},
          NULL, NULL, now(), 1
        WHERE NOT EXISTS (
          SELECT 1 FROM _prisma_migrations
          WHERE migration_name = ${CDZ_APP_DATA_MIGRATION_NAME}
        )
      `;
      migrationMarked = true;
    } catch (err) {
      markError = String((err as Error)?.message ?? err).slice(0, 200);
    }
    return { alreadyExisted, ranDdl, migrationMarked, markError };
  }

  // R18-A2 diagnostic: the most recent _prisma_migrations rows (name, applied
  // time, checksum prefix, rollback marker). Read-only; lets the operator see
  // exactly which migrations the live DB believes are applied.
  async migrationsStatus(): Promise<
    {
      name: string;
      finishedAt: Date | null;
      checksumPrefix: string;
      rolledBackAt: Date | null;
    }[]
  > {
    return await this.db.$queryRaw<
      {
        name: string;
        finishedAt: Date | null;
        checksumPrefix: string;
        rolledBackAt: Date | null;
      }[]
    >`
      SELECT
        migration_name AS "name",
        finished_at AS "finishedAt",
        left(checksum, 8) AS "checksumPrefix",
        rolled_back_at AS "rolledBackAt"
      FROM _prisma_migrations
      ORDER BY migration_name DESC
      LIMIT 30
    `;
  }

  // R18 status probe: cheap aggregate counts for the pg-admin /status route.
  // Read-only. Throws if the table is absent (the caller treats a throw as
  // tableExists:false), so one call reports the migration state too.
  async stats(): Promise<{ totalRows: number; distinctSlugs: number }> {
    const rows = await this.db.$queryRaw<
      { total: number; slugs: number }[]
    >`
      SELECT count(*)::int AS total, count(DISTINCT slug)::int AS slugs
      FROM cdz_app_data
    `;
    const r = rows[0] ?? { total: 0, slugs: 0 };
    return { totalRows: Number(r.total), distinctSlugs: Number(r.slugs) };
  }

  // R18 Phase B backfill: like upsert() but seeds created_at from the record's
  // own ISO timestamp (falling back to now() when absent/null) so historical
  // rows keep their true creation time — the Phase C read-cutover orders by it.
  // On conflict it refreshes only data + updated_at and NEVER rewrites
  // created_at, so re-running the backfill — or racing a concurrent live
  // dual-write of the same record — is safe and idempotent.
  @Transactional()
  async backfillUpsert(
    slug: string,
    collection: string,
    recordId: string,
    data: Record<string, unknown>,
    createdAtIso: string | null
  ) {
    await this.db.$executeRaw`
      INSERT INTO cdz_app_data (
        slug, collection, record_id, data, created_at, updated_at
      )
      VALUES (
        ${slug}, ${collection}, ${recordId},
        ${JSON.stringify(data)}::jsonb,
        COALESCE(${createdAtIso}::timestamptz, now()), now()
      )
      ON CONFLICT (slug, collection, record_id)
      DO UPDATE SET
        data = EXCLUDED.data,
        updated_at = now()
    `;
  }

  // Bulk read for later phases (Redis→PG read cutover). Newest first, mirroring
  // the controller's list() createdAt-desc ordering. Unused in Phase A.
  async listByCollection(
    slug: string,
    collection: string
  ): Promise<CdzAppDataRow[]> {
    return await this.db.$queryRaw<CdzAppDataRow[]>`
      SELECT
        slug,
        collection,
        record_id AS "recordId",
        data,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM cdz_app_data
      WHERE slug = ${slug} AND collection = ${collection}
      ORDER BY created_at DESC
    `;
  }

  // DzOS Phase 1: the /erp/changes cursor feed. Returns live rows + tombstones
  // for a slug whose updatedAt/deletedAt is STRICTLY AFTER the since cursor
  // (ISO 8601). Unioned + ordered by the change timestamp ascending, capped at
  // `limit` (default 500). The caller treats each row as an upsert change and
  // each tombstone as a delete change; nextCursor = the last row's timestamp.
  // `since` null/empty = return everything (initial hydration).
  async listChanges(
    slug: string,
    since: string | null,
    limit = 500
  ): Promise<{ changes: CdzAppDataChangeRow[]; nextCursor: string | null }> {
    const cap = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    // Live rows updated after the cursor.
    const liveRows = since
      ? await this.db.$queryRaw<CdzAppDataChangeRow[]>`
          SELECT
            slug, collection, record_id AS "recordId", data,
            created_at AS "createdAt", updated_at AS "updatedAt",
            rev, 'upsert' AS "kind"
          FROM cdz_app_data
          WHERE slug = ${slug} AND updated_at > ${since}::timestamptz
          ORDER BY updated_at ASC
          LIMIT ${cap}::int
        `
      : await this.db.$queryRaw<CdzAppDataChangeRow[]>`
          SELECT
            slug, collection, record_id AS "recordId", data,
            created_at AS "createdAt", updated_at AS "updatedAt",
            0 AS rev, 'upsert' AS "kind"
          FROM cdz_app_data
          WHERE slug = ${slug}
          ORDER BY updated_at ASC
          LIMIT ${cap}::int
        `;
    // Tombstones deleted after the cursor.
    const tombRows = since
      ? await this.db.$queryRaw<CdzAppDataChangeRow[]>`
          SELECT
            slug, collection, record_id AS "recordId",
            '{}'::jsonb AS data,
            deleted_at AS "createdAt", deleted_at AS "updatedAt",
            rev, 'tombstone' AS "kind"
          FROM cdz_app_data_tombstone
          WHERE slug = ${slug} AND deleted_at > ${since}::timestamptz
          ORDER BY deleted_at ASC
          LIMIT ${cap}::int
        `
      : await this.db.$queryRaw<CdzAppDataChangeRow[]>`
          SELECT
            slug, collection, record_id AS "recordId",
            '{}'::jsonb AS data,
            deleted_at AS "createdAt", deleted_at AS "updatedAt",
            rev, 'tombstone' AS "kind"
          FROM cdz_app_data_tombstone
          WHERE slug = ${slug}
          ORDER BY deleted_at ASC
          LIMIT ${cap}::int
        `;
    // Merge + sort by the change timestamp; cap.
    const merged = [...liveRows, ...tombRows].sort((a, b) =>
      String(a.updatedAt).localeCompare(String(b.updatedAt))
    );
    const page = merged.slice(0, cap);
    const last = page[page.length - 1];
    const nextCursor = last ? String(last.updatedAt) : null;
    return { changes: page, nextCursor };
  }
}

// DzOS Phase 1: the tombstone track for the /erp/changes feed. The data API's
// mirrorToPg delete path records a tombstone here so a later pull can tell
// clients the record was removed (without it, a hard-deleted row would leave a
// ghost in every client's local store).
export type CdzAppDataChangeRow = {
  slug: string;
  collection: string;
  recordId: string;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  rev: number;
  kind: 'upsert' | 'tombstone';
};

@Injectable()
export class CdzAppDataTombstoneModel extends BaseModel {
  // Record a tombstone (idempotent — re-inserting the same PK updates rev/deletedAt).
  @Transactional()
  async record(
    slug: string,
    collection: string,
    recordId: string,
    rev = 0
  ) {
    await this.db.$executeRaw`
      INSERT INTO cdz_app_data_tombstone (
        slug, collection, record_id, rev, deleted_at
      )
      VALUES (
        ${slug}, ${collection}, ${recordId}, ${rev}, now()
      )
      ON CONFLICT (slug, collection, record_id)
      DO UPDATE SET rev = EXCLUDED.rev, deleted_at = now()
    `;
  }

  // Idempotent DDL for the tombstone table (mirrors ensureSchema's pattern —
  // boot never runs prisma migrate deploy, so replay the migration in-app).
  @Transactional()
  async ensureSchema(): Promise<{ alreadyExisted: boolean; ranDdl: boolean }> {
    await this.db.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('cdz_app_data_tombstone_migration'))
    `;
    const probe = await this.db.$queryRaw<{ reg: string | null }[]>`
      SELECT to_regclass('public.cdz_app_data_tombstone')::text AS reg
    `;
    const alreadyExisted = !!probe[0]?.reg;
    let ranDdl = false;
    if (!alreadyExisted) {
      await this.db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "cdz_app_data_tombstone" (
          "slug" VARCHAR NOT NULL,
          "collection" VARCHAR NOT NULL,
          "record_id" VARCHAR NOT NULL,
          "rev" INTEGER NOT NULL DEFAULT 0,
          "deleted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "cdz_app_data_tombstone_pkey" PRIMARY KEY ("slug", "collection", "record_id")
        )
      `);
      await this.db.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "cdz_app_data_tombstone_slug_deleted_at_idx" ON "cdz_app_data_tombstone" ("slug", "deleted_at")`
      );
      ranDdl = true;
    }
    return { alreadyExisted, ranDdl };
  }
}
