/**
 * DzOS ERP local-first store — core types.
 *
 * The dzos-store module gives every DzOS ERP panel a LOCAL database that is
 * the source of truth for reads, with an outbox + sync engine that reconciles
 * with the server in the background. This is the offline-first primitive that
 * makes the Windows desktop app work a full day with zero network and sync
 * cleanly when reconnected.
 *
 * Design (see the upgrade plan, doc cmswknbes1mk207adibm044k2 §3):
 *   • UI never talks to the network. Pages read/write ErpRepo; the sync engine
 *     pushes the outbox and pulls /erp/changes in the background.
 *   • Storage adapters: IndexedDB on web, SQLite on Electron (via IPC, later).
 *     One adapter interface ⇒ one codebase, BUILD_CONFIG.isElectron picks the
 *     backend.
 *   • Every mutation = an outbox event {opId(ULID), collection, recordId, op,
 *     payload, baseRev, ts}. Idempotency-key header (opId) makes retries safe.
 *   • Pull: GET /erp/changes?since=<cursor> returns changed records +
 *     tombstones; merge = per-record LWW on (rev, updatedAt).
 *   • Legal invoice numbering stays server-authoritative (offline drafts queue
 *     « en attente de numérotation »; numbers assigned on reconnect).
 *
 * Framework-free where it matters: types + the storage adapter interface +
 * the IDB adapter have no React/NestJS deps so they unit-test cleanly. The
 * React hooks + sync engine layer on top.
 */

/** All DzOS ERP collections (mirrors the server durable set). */
export type ErpCollection =
  | 'products'
  | 'orders'
  | 'customers'
  | 'clients'
  | 'expenses'
  | 'depenses'
  | 'creances'
  | 'invoices' // base; month-partitioned as invoices-YYYYMM
  | 'caisse' // base; month-partitioned as caisse-YYYYMM
  | 'movements'
  | 'compta'
  | 'stock'
  | 'inventory'
  | 'suppliers'
  | 'purchase-orders'
  | 'warehouses'
  | 'couriers'
  | 'shipping-rates'
  | 'staff'
  | 'settings'
  | (string & {}); // month-partitioned names + any future collection

/** Operation kind for the outbox. */
export type ErpOp = 'upsert' | 'remove';

/**
 * One stored ERP record in the local store. The wrapper carries the sync
 * metadata (rev, updatedAt, pending flag) alongside the record body.
 *
 * `rev` is a monotonically-increasing per-record revision (server-assigned on
 * push; bumped locally on outbox apply). LWW merge compares (rev, updatedAt).
 * `pending` = this record has an unpushed outbox op (UI shows a badge).
 */
export interface ErpRecordWrapper<T = Record<string, unknown>> {
  /** The collection this record belongs to (e.g. 'caisse-202608'). */
  collection: string;
  /** The record id (stable across sync; the server's path id). */
  id: string;
  /** The record body. */
  data: T;
  /** Per-record revision — server-assigned, bumped locally on outbox apply. */
  rev: number;
  /** ISO timestamp of the last change (local or server). */
  updatedAt: string;
  /** ISO timestamp of first creation (preserved across updates). */
  createdAt: string;
  /** True if an outbox op for this record hasn't been pushed yet. */
  pending: boolean;
  /** True if this record was deleted (tombstone kept for merge). */
  deleted: boolean;
}

/**
 * One outbox event. Written atomically with the local store change; flushed by
 * the sync engine on connectivity/interval/backoff. The opId is the
 * idempotency key — the server dedupes on it so retries are safe.
 */
export interface ErpOutboxOp {
  /** ULID — monotonic, sortable, the idempotency key sent as X-Idempotency-Key. */
  opId: string;
  /** Target collection (e.g. 'caisse-202608'). */
  collection: string;
  /** Target record id. */
  recordId: string;
  /** The operation. */
  op: ErpOp;
  /** The record body for upsert (omitted for remove). */
  payload?: Record<string, unknown>;
  /** The rev the client had when it made the change (for conflict detection). */
  baseRev: number;
  /** ISO timestamp the op was enqueued. */
  ts: string;
  /** Retry counter (exponential backoff). */
  attempts: number;
  /** Last error message (for the conflict/error log). */
  lastError?: string;
}

/**
 * A pulled change from /erp/changes. Either an upsert (record body + rev) or a
 * tombstone (deleted + rev). The cursor is the high-water mark for the next
 * pull.
 */
export type ErpChange =
  | {
      kind: 'upsert';
      collection: string;
      id: string;
      data: Record<string, unknown>;
      rev: number;
      updatedAt: string;
      createdAt: string;
    }
  | {
      kind: 'tombstone';
      collection: string;
      id: string;
      rev: number;
      updatedAt: string;
    };

/** The /erp/changes response. */
export interface ErpChangesResponse {
  changes: ErpChange[];
  /** The cursor to use for the next pull (exclusive high-water mark). */
  nextCursor: string | null;
  /** True if more changes are available (paginated). */
  hasMore: boolean;
}

/** Per-op result from /erp/sync/batch. */
export type ErpSyncResult =
  | { opId: string; ok: true; rev: number; updatedAt: string }
  | { opId: string; ok: false; error: string; conflict?: boolean };

/** The /erp/sync/batch response. */
export interface ErpSyncBatchResponse {
  results: ErpSyncResult[];
}

/** Sync status surfaced to the UI pill. */
export type SyncStatus =
  | { state: 'synced' }
  | { state: 'pending'; count: number }
  | { state: 'pushing' }
  | { state: 'pulling' }
  | { state: 'offline' }
  | { state: 'error'; message: string };

/** Sync metadata stored in the meta object store (per-slug cursors). */
export interface ErpSyncMeta {
  slug: string;
  /** The last successfully-applied pull cursor (ISO or numeric, server-defined). */
  pullCursor: string | null;
  /** ISO timestamp of the last successful pull. */
  lastPullAt: string | null;
  /** ISO timestamp of the last successful push (outbox fully drained). */
  lastPushAt: string | null;
}
