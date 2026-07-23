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
