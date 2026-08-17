/**
 * DzOS ERP local-first store — Electron helper SQLite backend.
 *
 * The Electron desktop app's helper process (Node) runs these handlers; the
 * renderer calls them via the existing AsyncCall IPC (same channel as
 * nbstoreHandlers). The SQLite backend replaces the IDB fallback so the
 * Windows app gets native SQLite: a real file in userData (survives app
 * restarts, backup-friendly), WAL mode for crash safety, and index-backed
 * scans (the IDB adapter's in-memory filter is fine for small shops but
 * SQLite scales to thousands of records per collection).
 *
 * SQLite access: `node:sqlite` (built into Node 22.5+, no native rebuild, no
 * new dependency). Falls back to a no-op throw if unavailable (the renderer's
 * getErpRepo then falls back to IDB — the IDB adapter is available in the
 * Electron renderer too, so the app still works offline, just without the
 * native-SQLite file location). The SQLite interface used here is the minimal
 * subset {exec, prepare→run/all} that both `node:sqlite` and `sql.js` expose,
 * so a future swap to sql.js (pure WASM) for older Electron Node versions is a
 * one-helper change.
 *
 * One DB file per shop: `<userData>/dzos/<slug>.sqlite` (mirrors the
 * per-shop IDB DB name `dzos:<slug>`). Schema: 3 tables (records, outbox, meta)
 * matching the IDB object stores; the DzosStorage contract is identical.
 */

import path from 'node:path';

import fs from 'fs-extra';

import { logger } from '../logger';
import { getDzosDbPath } from '../workspace/meta';

// Lazy-load node:sqlite so the helper module loads even on a Node build where
// the experimental flag is off (the failure surfaces on first use, with a
// clear message, rather than at import time). Typed as any because
// @types/node may not yet ship node:sqlite types.
type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
  };
  close(): void;
};

let sqliteImport: ((file: string) => SqliteDb) | null = null;
async function loadSqlite(): Promise<(file: string) => SqliteDb> {
  if (sqliteImport) return sqliteImport;
  // node:sqlite is behind --experimental-sqlite on some Node 22 builds; on
  // 22.5+ and Node 24 it's unflagged. Electron 39 ships Node 22.x.
  const mod = await import('node:sqlite').catch(() => null);
  if (!mod || typeof (mod as { DatabaseSync?: unknown }).DatabaseSync !== 'function') {
    throw new Error(
      'node:sqlite unavailable on this Node build — DzOS SQLite adapter needs Node 22.5+ (Electron 39). ' +
        'The renderer will fall back to the IDB adapter (offline reads still work).'
    );
  }
  sqliteImport = (file: string) =>
    new (mod as { DatabaseSync: new (file: string, opts?: unknown) => SqliteDb }).DatabaseSync(file, {
      // enable WAL + foreign keys; node:sqlite accepts Pragmas via options or exec.
    }) as SqliteDb;
  return sqliteImport;
}

/** The on-disk record row (the composite PK + the wrapper fields). */
interface RecordRow {
  collection: string;
  id: string;
  data: string; // JSON
  rev: number;
  updated_at: string;
  created_at: string;
  pending: number; // 0/1
  deleted: number; // 0/1
}

interface OutboxRow {
  op_id: string;
  collection: string;
  record_id: string;
  op: string;
  payload: string | null; // JSON
  base_rev: number;
  ts: string;
  attempts: number;
  last_error: string | null;
}

interface MetaRow {
  slug: string;
  pull_cursor: string | null;
  last_pull_at: string | null;
  last_push_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS records_collection_idx ON records (collection);
CREATE INDEX IF NOT EXISTS records_updated_at_idx ON records (updated_at);
CREATE INDEX IF NOT EXISTS records_pending_idx ON records (pending);

CREATE TABLE IF NOT EXISTS outbox (
  op_id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT,
  base_rev INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_collection_idx ON outbox (collection);
CREATE INDEX IF NOT EXISTS outbox_ts_idx ON outbox (ts);

CREATE TABLE IF NOT EXISTS meta (
  slug TEXT PRIMARY KEY,
  pull_cursor TEXT,
  last_pull_at TEXT,
  last_push_at TEXT
);
`;

/**
 * A per-slug SQLite connection, opened lazily on first use. Cached for the
 * helper process lifetime (one connection per open shop). The connection is
 * synchronous (node:sqlite is sync) — the handlers stay async to match the
 * DzosStorage contract + the IPC shape.
 */
class DzosSqliteDb {
  private db: SqliteDb | null = null;
  constructor(private readonly slug: string) {}

  private async open(): Promise<SqliteDb> {
    if (this.db) return this.db;
    const dbPath = await getDzosDbPath(this.slug);
    await fs.ensureDir(path.dirname(dbPath));
    const factory = await loadSqlite();
    this.db = factory(dbPath);
    // Phase 5 error-shield: each pragma/exec can throw on a corrupted DB
    // file or a permissions issue. Guard each so a partial failure still
    // leaves the DB in a usable state (WAL is best-effort; the schema is
    // idempotent). If the schema exec fails entirely, the connection is
    // broken — clear it so the next call retries from scratch.
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch (err) {
      logger.warn(`[dzos-sqlite] open: WAL pragma failed (continuing with default journal) — ${dbPath}`, err);
    }
    try {
      this.db.exec('PRAGMA foreign_keys = ON;');
    } catch (err) {
      logger.warn(`[dzos-sqlite] open: foreign_keys pragma failed — ${dbPath}`, err);
    }
    try {
      this.db.exec(SCHEMA);
    } catch (err) {
      logger.error(`[dzos-sqlite] open: schema exec failed — ${dbPath}`, err);
      // The DB file might be corrupted. Close it and clear so the next
      // call retries; the caller will see the error on the next query.
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
      throw new Error(`DzOS SQLite: impossible d'initialiser le schéma pour "${this.slug}" — ${dbPath}`);
    }
    logger.info(`[dzos-sqlite] opened ${dbPath}`);
    return this.db;
  }

  async getRecord(collection: string, id: string) {
    const db = await this.open();
    const row = db.prepare(
      'SELECT collection, id, data, rev, updated_at, created_at, pending, deleted FROM records WHERE collection = ? AND id = ?'
    ).get(collection, id) as RecordRow | undefined;
    return row ? this.unwrapRecord(row) : null;
  }

  async listRecords(collection: string) {
    const db = await this.open();
    const rows = db.prepare(
      'SELECT collection, id, data, rev, updated_at, created_at, pending, deleted FROM records WHERE collection = ? AND deleted = 0 ORDER BY updated_at DESC'
    ).all(collection) as RecordRow[];
    return rows.map((r) => this.unwrapRecord(r));
  }

  async putRecord(wrapper: {
    collection: string;
    id: string;
    data: Record<string, unknown>;
    rev: number;
    updatedAt: string;
    createdAt: string;
    pending: boolean;
    deleted: boolean;
  }) {
    const db = await this.open();
    db.prepare(
      `INSERT INTO records (collection, id, data, rev, updated_at, created_at, pending, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(collection, id) DO UPDATE SET
         data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at,
         created_at = excluded.created_at, pending = excluded.pending, deleted = excluded.deleted`
    ).run(
      wrapper.collection,
      wrapper.id,
      JSON.stringify(wrapper.data),
      wrapper.rev,
      wrapper.updatedAt,
      wrapper.createdAt,
      wrapper.pending ? 1 : 0,
      wrapper.deleted ? 1 : 0
    );
  }

  async tombstoneRecord(collection: string, id: string, rev: number, updatedAt: string) {
    const db = await this.open();
    // Preserve createdAt from the existing row (a tombstone remembers when the
    // record first existed). If absent, use updatedAt.
    const existing = db.prepare('SELECT created_at FROM records WHERE collection = ? AND id = ?').get(collection, id) as { created_at?: string } | undefined;
    const createdAt = existing?.created_at ?? updatedAt;
    db.prepare(
      `INSERT INTO records (collection, id, data, rev, updated_at, created_at, pending, deleted)
       VALUES (?, ?, '{}', ?, ?, ?, 0, 1)
       ON CONFLICT(collection, id) DO UPDATE SET rev = excluded.rev, updated_at = excluded.updated_at, deleted = 1, pending = 0`
    ).run(collection, id, rev, updatedAt, createdAt);
  }

  async purgeRecord(collection: string, id: string) {
    const db = await this.open();
    db.prepare('DELETE FROM records WHERE collection = ? AND id = ?').run(collection, id);
  }

  async appendOutbox(op: {
    opId: string;
    collection: string;
    recordId: string;
    op: string;
    payload?: Record<string, unknown>;
    baseRev: number;
    ts: string;
    attempts: number;
    lastError?: string;
  }) {
    const db = await this.open();
    db.prepare(
      `INSERT OR REPLACE INTO outbox (op_id, collection, record_id, op, payload, base_rev, ts, attempts, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      op.opId,
      op.collection,
      op.recordId,
      op.op,
      op.payload ? JSON.stringify(op.payload) : null,
      op.baseRev,
      op.ts,
      op.attempts,
      op.lastError ?? null
    );
  }

  async listOutbox() {
    const db = await this.open();
    const rows = db.prepare('SELECT * FROM outbox ORDER BY ts ASC').all() as OutboxRow[];
    return rows.map((r) => {
      // Phase 5 error-shield: JSON.parse on the payload can throw on a
      // corrupted row. Degrade to undefined (the sync engine treats a
      // missing payload as an empty body for upserts).
      let payload: Record<string, unknown> | undefined;
      if (r.payload) {
        try {
          payload = JSON.parse(r.payload) as Record<string, unknown>;
        } catch (err) {
          logger.error(`[dzos-sqlite] listOutbox: corrupted payload for op ${r.op_id}`, err);
        }
      }
      return {
        opId: r.op_id,
        collection: r.collection,
        recordId: r.record_id,
        op: r.op,
        payload,
        baseRev: r.base_rev,
        ts: r.ts,
        attempts: r.attempts,
        lastError: r.last_error ?? undefined,
      };
    });
  }

  async removeOutbox(opId: string) {
    const db = await this.open();
    db.prepare('DELETE FROM outbox WHERE op_id = ?').run(opId);
  }

  async updateOutbox(opId: string, attempts: number, lastError?: string) {
    const db = await this.open();
    db.prepare('UPDATE outbox SET attempts = ?, last_error = ? WHERE op_id = ?').run(
      attempts,
      lastError ?? null,
      opId
    );
  }

  async getMeta(slug: string) {
    const db = await this.open();
    const row = db.prepare('SELECT * FROM meta WHERE slug = ?').get(slug) as MetaRow | undefined;
    return row
      ? {
          slug: row.slug,
          pullCursor: row.pull_cursor,
          lastPullAt: row.last_pull_at,
          lastPushAt: row.last_push_at,
        }
      : null;
  }

  async putMeta(meta: {
    slug: string;
    pullCursor: string | null;
    lastPullAt: string | null;
    lastPushAt: string | null;
  }) {
    const db = await this.open();
    db.prepare(
      `INSERT OR REPLACE INTO meta (slug, pull_cursor, last_pull_at, last_push_at)
       VALUES (?, ?, ?, ?)`
    ).run(meta.slug, meta.pullCursor, meta.lastPullAt, meta.lastPushAt);
  }

  close() {
    // Phase 5 error-shield: db.close() can throw on a corrupted handle.
    // Never block the cache eviction (the db is nulled regardless).
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        logger.error(`[dzos-sqlite] close: db.close() failed for "${this.slug}"`, err);
      }
      this.db = null;
    }
  }

  private unwrapRecord(row: RecordRow) {
    // Phase 5 error-shield: JSON.parse can throw on corrupted data rows
    // (partial writes, disk corruption). Degrade to an empty object so the
    // record is still visible (id/rev/collection) rather than crashing the
    // entire listRecords/getRecord call.
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data) as Record<string, unknown>;
    } catch (err) {
      logger.error(`[dzos-sqlite] unwrapRecord: corrupted data for ${row.collection}/${row.id}`, err);
      data = {};
    }
    return {
      collection: row.collection,
      id: row.id,
      data,
      rev: row.rev,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      pending: row.pending === 1,
      deleted: row.deleted === 1,
    };
  }
}

// --- per-slug connection cache (helper process lifetime) --------------------

const dbCache = new Map<string, DzosSqliteDb>();

function dbFor(slug: string): DzosSqliteDb {
  let db = dbCache.get(slug);
  if (!db) {
    db = new DzosSqliteDb(slug);
    dbCache.set(slug, db);
  }
  return db;
}

/**
 * The dzosStore IPC handlers — the Electron helper-side implementation of the
 * DzosStorage contract. The renderer's DzosSqliteStorage adapter calls these
 * via AsyncCall; each method mirrors the IDB adapter's behavior so the repo +
 * sync engine are backend-agnostic. Registered in exposed.ts alongside
 * nbstoreHandlers.
 */
export const dzosStoreHandlers = {
  // records
  getRecord: (slug: string, collection: string, id: string) =>
    dbFor(slug).getRecord(collection, id),
  listRecords: (slug: string, collection: string) =>
    dbFor(slug).listRecords(collection),
  putRecord: (
    slug: string,
    wrapper: {
      collection: string;
      id: string;
      data: Record<string, unknown>;
      rev: number;
      updatedAt: string;
      createdAt: string;
      pending: boolean;
      deleted: boolean;
    }
  ) => dbFor(slug).putRecord(wrapper),
  tombstoneRecord: (slug: string, collection: string, id: string, rev: number, updatedAt: string) =>
    dbFor(slug).tombstoneRecord(collection, id, rev, updatedAt),
  purgeRecord: (slug: string, collection: string, id: string) =>
    dbFor(slug).purgeRecord(collection, id),

  // outbox
  appendOutbox: (
    slug: string,
    op: {
      opId: string;
      collection: string;
      recordId: string;
      op: string;
      payload?: Record<string, unknown>;
      baseRev: number;
      ts: string;
      attempts: number;
      lastError?: string;
    }
  ) => dbFor(slug).appendOutbox(op),
  listOutbox: (slug: string) => dbFor(slug).listOutbox(),
  removeOutbox: (slug: string, opId: string) => dbFor(slug).removeOutbox(opId),
  updateOutbox: (slug: string, opId: string, attempts: number, lastError?: string) =>
    dbFor(slug).updateOutbox(opId, attempts, lastError),

  // meta
  getMeta: (slug: string) => dbFor(slug).getMeta(slug),
  putMeta: (
    slug: string,
    meta: {
      slug: string;
      pullCursor: string | null;
      lastPullAt: string | null;
      lastPushAt: string | null;
    }
  ) => dbFor(slug).putMeta(meta),

  // lifecycle
  close: (slug: string) => {
    dbFor(slug).close();
    dbCache.delete(slug);
  },
};
