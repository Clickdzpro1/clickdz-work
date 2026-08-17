/**
 * DzOS ERP local-first store — Electron SQLite storage adapter (renderer side).
 *
 * Implements the DzosStorage contract by calling the Electron helper's
 * dzosStore IPC handlers (apps/electron/src/helper/dzos-store/handlers.ts) via
 * the @affine/electron-api `apis.dzosStore` proxy. Each method is a thin
 * async wrapper over the IPC call — the helper does the actual SQLite work in
 * the Node helper process (node:sqlite, native file in userData).
 *
 * Selected by getErpRepo when BUILD_CONFIG.isElectron; the IDB adapter is the
 * web fallback. The two adapters are interchangeable (same contract) so the
 * repo + sync engine are backend-agnostic.
 *
 * The `apis` global is injected by the Electron preload
 * (globalThis.__apis = ...). On web it's undefined — this adapter is never
 * instantiated on web (getErpRepo gates on isElectron), but the import is
 * guarded so a web bundle never evaluates the apis access at module-load.
 */

import { apis } from '@affine/electron-api';

import type { DzosStorage } from './storage';
import type {
  ErpOutboxOp,
  ErpRecordWrapper,
  ErpSyncMeta,
} from './types';

/**
 * The Electron SQLite adapter. One instance per open shop (per slug). The
 * helper holds the actual SQLite connection (one per slug, cached for the
 * helper process lifetime); this renderer adapter is stateless beyond the slug.
 */
export class DzosSqliteStorage implements DzosStorage {
  constructor(private readonly slug: string) {}

  private get h() {
    const handler = apis?.dzosStore;
    if (!handler) {
      throw new Error(
        'dzosStore IPC handlers unavailable — not running in Electron, or the helper process is not connected. ' +
          'getErpRepo should gate on BUILD_CONFIG.isElectron and fall back to IDB.'
      );
    }
    return handler;
  }

  async getRecord(collection: string, id: string): Promise<ErpRecordWrapper | null> {
    return (await this.h.getRecord(this.slug, collection, id)) as ErpRecordWrapper | null;
  }

  async listRecords(collection: string): Promise<ErpRecordWrapper[]> {
    return (await this.h.listRecords(this.slug, collection)) as ErpRecordWrapper[];
  }

  async putRecord(wrapper: ErpRecordWrapper): Promise<void> {
    await this.h.putRecord(this.slug, wrapper);
  }

  async tombstoneRecord(
    collection: string,
    id: string,
    rev: number,
    updatedAt: string
  ): Promise<void> {
    await this.h.tombstoneRecord(this.slug, collection, id, rev, updatedAt);
  }

  async purgeRecord(collection: string, id: string): Promise<void> {
    await this.h.purgeRecord(this.slug, collection, id);
  }

  async appendOutbox(op: ErpOutboxOp): Promise<void> {
    await this.h.appendOutbox(this.slug, op);
  }

  async listOutbox(): Promise<ErpOutboxOp[]> {
    return (await this.h.listOutbox(this.slug)) as ErpOutboxOp[];
  }

  async removeOutbox(opId: string): Promise<void> {
    await this.h.removeOutbox(this.slug, opId);
  }

  async updateOutbox(opId: string, attempts: number, lastError?: string): Promise<void> {
    await this.h.updateOutbox(this.slug, opId, attempts, lastError);
  }

  async getMeta(slug: string): Promise<ErpSyncMeta | null> {
    return (await this.h.getMeta(slug)) as ErpSyncMeta | null;
  }

  async putMeta(meta: ErpSyncMeta): Promise<void> {
    await this.h.putMeta(this.slug, meta);
  }

  close(): void {
    // Fire-and-forget the IPC close; the helper drops the SQLite connection.
    void this.h?.close?.(this.slug).catch(() => {});
  }
}
