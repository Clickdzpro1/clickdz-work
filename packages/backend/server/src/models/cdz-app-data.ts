import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { BaseModel } from './base';

export type CdzAppDataRow = {
  slug: string;
  collection: string;
  recordId: string;
  data: Record<string, unknown>;
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
    await this.db.$executeRaw`
      INSERT INTO cdz_app_data (
        slug, collection, record_id, data, created_at, updated_at
      )
      VALUES (
        ${slug}, ${collection}, ${recordId},
        ${JSON.stringify(data)}::jsonb, now(), now()
      )
      ON CONFLICT (slug, collection, record_id)
      DO UPDATE SET
        data = EXCLUDED.data,
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
}
