/**
 * DzOS ERP local-first store — storage adapter interface + IDB implementation.
 *
 * The adapter abstracts the persistence backend so ErpRepo + SyncEngine are
 * backend-agnostic. Two backends share one interface:
 *   • IDB on web (this file) — IndexedDB via the `idb` library.
 *   • SQLite on Electron (later, via IPC handlers mirroring nbstore's pattern).
 *
 * Object stores (IDB) / tables (SQLite):
 *   • records   — by [collection, id], indexed on collection + updatedAt +
 *                 pending. The ErpRecordWrapper rows.
 *   • outbox    — by opId, indexed on collection + ts. The ErpOutboxOp rows.
 *   • meta      — by slug. The ErpSyncMeta cursors.
 *
 * The interface is intentionally minimal: the repo layers querying/indexing on
 * top (it loads a collection into memory and filters). IDB indexes give O(log
 * n) collection scans; the in-memory LRU (in the repo) kills repeated reads.
 */

import { openDB, type IDBPDatabase } from 'idb';

import type { ErpOutboxOp, ErpRecordWrapper, ErpSyncMeta } from './types';

/** The storage adapter contract — implemented by IDB (web) + SQLite (Electron). */
export interface DzosStorage {
  /** Get one record wrapper by (collection, id), or null if absent. */
  getRecord(collection: string, id: string): Promise<ErpRecordWrapper | null>;
  /** Get all non-deleted records for a collection (newest-first by updatedAt). */
  listRecords(collection: string): Promise<ErpRecordWrapper[]>;
  /** Upsert a record wrapper (full row, incl. rev/pending/deleted). */
  putRecord(wrapper: ErpRecordWrapper): Promise<void>;
  /** Mark a record as a tombstone (deleted=true, rev bumped) — for pull merges. */
  tombstoneRecord(collection: string, id: string, rev: number, updatedAt: string): Promise<void>;
  /** Permanently remove a record wrapper (used only by outbox cleanup of stale tombstones). */
  purgeRecord(collection: string, id: string): Promise<void>;

  /** Append an outbox op (idempotent on opId — re-inserting the same opId is a no-op). */
  appendOutbox(op: ErpOutboxOp): Promise<void>;
  /** List all pending outbox ops, oldest-first (by ts). */
  listOutbox(): Promise<ErpOutboxOp[]>;
  /** Remove an outbox op after a successful push (by opId). */
  removeOutbox(opId: string): Promise<void>;
  /** Update an outbox op's attempts + lastError (backoff / conflict log). */
  updateOutbox(opId: string, attempts: number, lastError?: string): Promise<void>;

  /** Read the sync metadata (cursors) for a slug, or null. */
  getMeta(slug: string): Promise<ErpSyncMeta | null>;
  /** Upsert the sync metadata for a slug. */
  putMeta(meta: ErpSyncMeta): Promise<void>;

  /** Close the underlying DB connection (idempotent). */
  close(): void;
}

const DB_NAME_PREFIX = 'dzos';
const STORE_RECORDS = 'records';
const STORE_OUTBOX = 'outbox';
const STORE_META = 'meta';
const DB_VERSION = 1;

/**
 * The IDB key for a record. IDB can only use one keyPath; we use a composite
 * string `${collection}\u0000${id}` (\u0000 = NUL, illegal in collection/id
 * names so it's an unambiguous separator) as the primary key, and create
 * indexes on `collection` and `updatedAt` for scans.
 */
const recordKey = (collection: string, id: string): string =>
  `${collection}\u0000${id}`;

/** The on-disk record row shape (the key + the wrapper fields). */
interface RecordRow extends ErpRecordWrapper {
  /** The composite primary key (collection\0id). Auto from keyPath. */
  key: string;
}

/**
 * Open (and upgrade) the DzOS IDB database for one shop slug.
 *
 * `dzos:<slug>` — one DB per shop so a merchant with multiple shops has clean
 * isolation and a single-shop export/restore is one DB file.
 */
export async function openDzosIdb(slug: string): Promise<IDBPDatabase> {
  const dbName = `${DB_NAME_PREFIX}:${slug}`;
  return openDB(dbName, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const records = db.createObjectStore(STORE_RECORDS, { keyPath: 'key' });
        records.createIndex('collection', 'collection', { unique: false });
        records.createIndex('updatedAt', 'updatedAt', { unique: false });
        records.createIndex('pending', 'pending', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const outbox = db.createObjectStore(STORE_OUTBOX, { keyPath: 'opId' });
        outbox.createIndex('collection', 'collection', { unique: false });
        outbox.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'slug' });
      }
    },
  });
}

/**
 * The IDB storage adapter. One instance per open shop (per slug). Not a
 * singleton — the repo creates one and owns its lifecycle.
 */
export class DzosIdbStorage implements DzosStorage {
  private dbPromise: Promise<IDBPDatabase> | null = null;

  constructor(
    private readonly slug: string,
    db?: IDBPDatabase
  ) {
    if (db) this.dbPromise = Promise.resolve(db);
  }

  private async db(): Promise<IDBPDatabase> {
    if (!this.dbPromise) this.dbPromise = openDzosIdb(this.slug);
    // Phase 5 error-shield: if openDzosIdb rejected, clear the cached promise
    // so the next call retries instead of failing forever with the same
    // rejected promise.
    try {
      return await this.dbPromise;
    } catch (err) {
      this.dbPromise = null;
      throw err;
    }
  }

  async getRecord(collection: string, id: string): Promise<ErpRecordWrapper | null> {
    const db = await this.db();
    const row = (await db.get(STORE_RECORDS, recordKey(collection, id))) as
      | RecordRow
      | undefined;
    if (!row) return null;
    const { key: _key, ...wrapper } = row;
    return wrapper;
  }

  async listRecords(collection: string): Promise<ErpRecordWrapper[]> {
    const db = await this.db();
    // Phase 5 error-shield: the 'collection' index might be missing if the DB
    // was partially migrated or opened from an older schema. Fall back to a
    // full table scan + filter so the read never crashes.
    let rows: RecordRow[];
    try {
      const idx = db.transaction(STORE_RECORDS).store.index('collection');
      rows = (await idx.getAll(IDBKeyRange.only(collection))) as RecordRow[];
    } catch {
      // Index missing or corrupt — full scan + in-memory filter.
      rows = (await db.getAll(STORE_RECORDS)) as RecordRow[];
      rows = rows.filter((r) => r.collection === collection);
    }
    return rows
      .filter((r) => !r.deleted)
      .map(({ key: _key, ...wrapper }) => wrapper)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async putRecord(wrapper: ErpRecordWrapper): Promise<void> {
    const db = await this.db();
    const row: RecordRow = { ...wrapper, key: recordKey(wrapper.collection, wrapper.id) };
    await db.put(STORE_RECORDS, row);
  }

  async tombstoneRecord(
    collection: string,
    id: string,
    rev: number,
    updatedAt: string
  ): Promise<void> {
    const db = await this.db();
    const existing = (await db.get(STORE_RECORDS, recordKey(collection, id))) as
      | RecordRow
      | undefined;
    // Preserve createdAt from the existing row (a tombstone still remembers
    // when the record first existed). If absent, use now.
    const createdAt = existing?.createdAt ?? updatedAt;
    const row: RecordRow = {
      key: recordKey(collection, id),
      collection,
      id,
      data: existing?.data ?? {},
      rev,
      updatedAt,
      createdAt,
      pending: false,
      deleted: true,
    };
    await db.put(STORE_RECORDS, row);
  }

  async purgeRecord(collection: string, id: string): Promise<void> {
    const db = await this.db();
    await db.delete(STORE_RECORDS, recordKey(collection, id));
  }

  async appendOutbox(op: ErpOutboxOp): Promise<void> {
    const db = await this.db();
    // Idempotent on opId: a re-insert of the same opId (e.g. a retry that
    // already enqueued) is a no-op — put() overwrites, but the opId is unique
    // so the caller must check listOutbox before appending if it cares. The
    // sync engine never re-appends; it only retries existing ops.
    await db.put(STORE_OUTBOX, op);
  }

  async listOutbox(): Promise<ErpOutboxOp[]> {
    const db = await this.db();
    const rows = (await db.getAll(STORE_OUTBOX)) as ErpOutboxOp[];
    return rows.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async removeOutbox(opId: string): Promise<void> {
    const db = await this.db();
    await db.delete(STORE_OUTBOX, opId);
  }

  async updateOutbox(opId: string, attempts: number, lastError?: string): Promise<void> {
    const db = await this.db();
    const existing = (await db.get(STORE_OUTBOX, opId)) as ErpOutboxOp | undefined;
    if (!existing) return;
    await db.put(STORE_OUTBOX, { ...existing, attempts, lastError });
  }

  async getMeta(slug: string): Promise<ErpSyncMeta | null> {
    const db = await this.db();
    const meta = (await db.get(STORE_META, slug)) as ErpSyncMeta | undefined;
    return meta ?? null;
  }

  async putMeta(meta: ErpSyncMeta): Promise<void> {
    const db = await this.db();
    await db.put(STORE_META, meta);
  }

  close(): void {
    if (this.dbPromise) {
      // Phase 5 error-shield: catch the rejection so close() never throws
      // (the caller in dropErpRepo already guards, but this is defense-in-depth
      // for any direct caller). Also clear the promise so a post-close db()
      // call re-opens instead of returning a closed DB handle.
      this.dbPromise
        .then((db) => {
          try {
            db.close();
          } catch (err) {
            console.error('[dzos-idb] close: db.close() failed', err);
          }
        })
        .catch((err) => {
          console.error('[dzos-idb] close: dbPromise rejected', err);
        });
      this.dbPromise = null;
    }
  }
}
