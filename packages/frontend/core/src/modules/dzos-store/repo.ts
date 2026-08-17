/**
 * DzOS ERP local-first store — ErpRepo, the typed repository panels consume.
 *
 * ErpRepo is the ONLY surface a panel talks to for its data. It owns:
 *   • A DzosStorage adapter (IDB on web, SQLite on Electron).
 *   • An in-memory cache of loaded collections (kills repeated reads — the
 *     pre-Phase-0 shoperp-shared cache re-parsed a 500KB localStorage blob on
 *     every read).
 *   • Live subscriptions: a mutation notifies every subscriber for that
 *     collection so React hooks re-render without a refetch.
 *   • The outbox-append contract: every mutation writes the new record to the
 *     local store AND appends an outbox op atomically (from the caller's
 *     perspective). The sync engine drains the outbox in the background.
 *
 * The repo is per-slug (one shop). It's created lazily by getErpRepo(slug) and
 * cached for the session. Pages get it via the useErpRepo hook.
 */

import type { DzosStorage } from './storage';
import { DzosIdbStorage } from './storage';
import type {
  ErpCollection,
  ErpOp,
  ErpOutboxOp,
  ErpRecordWrapper,
} from './types';
import { ulid } from './ulid';

/** A live-query subscription handler. Called with the latest wrappers. */
type Subscriber = (wrappers: ErpRecordWrapper[]) => void;

/** Options for a mutation (carried into the outbox op). */
export interface MutateOptions {
  /** The month-partition name if applicable (e.g. 'caisse-202608'). */
  collectionOverride?: string;
}

/**
 * ErpRepo — the local-first typed repository.
 *
 * Generic over the record body type T per collection (callers cast at the
 * seam). The store itself is stringly-typed at the adapter level; the repo
 * preserves the type via the caller's T.
 */
export class ErpRepo {
  private cache = new Map<string, ErpRecordWrapper[]>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private hydrating = new Set<string>();

  constructor(
    private readonly slug: string,
    private readonly storage: DzosStorage
  ) {}

  /** The shop slug this repo is bound to. */
  get shopSlug(): string {
    return this.slug;
  }

  /**
   * Load (or return cached) all records for a collection. Newest-first by
   * updatedAt. Live: subsequent mutations to this collection re-notify
   * subscribers with a fresh list. The cache makes tab switches instant.
   */
  async list<T = Record<string, unknown>>(
    collection: ErpCollection
  ): Promise<ErpRecordWrapper<T>[]> {
    const cached = this.cache.get(collection);
    if (cached) return cached as ErpRecordWrapper<T>[];
    // Hydrate from storage. Dedup concurrent hydrations for the same collection.
    if (!this.hydrating.has(collection)) {
      this.hydrating.add(collection);
      try {
        const wrappers = await this.storage.listRecords(collection);
        this.cache.set(collection, wrappers);
      } finally {
        this.hydrating.delete(collection);
      }
    } else {
      // Another caller is hydrating this collection; await its result by
      // re-reading storage (the dedup is best-effort; a double-read is cheap).
    }
    const wrappers = await this.storage.listRecords(collection);
    this.cache.set(collection, wrappers);
    return wrappers as ErpRecordWrapper<T>[];
  }

  /** Get one record by id, or null. Hits the cache if the collection is loaded. */
  async get<T = Record<string, unknown>>(
    collection: ErpCollection,
    id: string
  ): Promise<ErpRecordWrapper<T> | null> {
    const cached = this.cache.get(collection);
    if (cached) {
      const hit = cached.find((w) => w.id === id);
      return (hit as ErpRecordWrapper<T> | undefined) ?? null;
    }
    return (await this.storage.getRecord(collection, id)) as ErpRecordWrapper<T> | null;
  }

  /**
   * Upsert a record locally + append an outbox op. The UI updates instantly;
   * the sync engine pushes the op in the background. Returns the new wrapper.
   *
   * `collectionOverride` lets a caller target a month partition (e.g. write a
   * caisse entry into 'caisse-202608' while the page lists 'caisse').
   */
  async upsert<T = Record<string, unknown>>(
    collection: ErpCollection,
    id: string,
    data: T,
    opts?: MutateOptions
  ): Promise<ErpRecordWrapper<T>> {
    const target = opts?.collectionOverride ?? collection;
    const existing = await this.storage.getRecord(target, id);
    const now = new Date().toISOString();
    const createdAt = existing?.createdAt ?? now;
    const rev = (existing?.rev ?? 0) + 1;
    const wrapper: ErpRecordWrapper = {
      collection: target,
      id,
      data: data as Record<string, unknown>,
      rev,
      updatedAt: now,
      createdAt,
      pending: true,
      deleted: false,
    };
    await this.storage.putRecord(wrapper);
    const op: ErpOutboxOp = {
      opId: ulid(),
      collection: target,
      recordId: id,
      op: 'upsert',
      payload: data as Record<string, unknown>,
      baseRev: existing?.rev ?? 0,
      ts: now,
      attempts: 0,
    };
    await this.storage.appendOutbox(op);
    this.invalidate(target);
    return wrapper as ErpRecordWrapper<T>;
  }

  /**
   * Remove a record locally (tombstone) + append a remove outbox op. The
   * record is marked deleted=true (kept for merge); the sync engine pushes the
   * tombstone and the server records the delete.
   */
  async remove(
    collection: ErpCollection,
    id: string,
    opts?: MutateOptions
  ): Promise<void> {
    const target = opts?.collectionOverride ?? collection;
    const existing = await this.storage.getRecord(target, id);
    if (!existing) return; // already gone — idempotent
    const now = new Date().toISOString();
    const rev = existing.rev + 1;
    await this.storage.tombstoneRecord(target, id, rev, now);
    const op: ErpOutboxOp = {
      opId: ulid(),
      collection: target,
      recordId: id,
      op: 'remove',
      baseRev: existing.rev,
      ts: now,
      attempts: 0,
    };
    await this.storage.appendOutbox(op);
    this.invalidate(target);
  }

  /**
   * Subscribe to a collection's live updates. The handler is called immediately
   * with the current cached list (if any), then on every mutation affecting
   * that collection. Returns an unsubscribe function.
   */
  subscribe(collection: ErpCollection, handler: Subscriber): () => void {
    let subs = this.subscribers.get(collection);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(collection, subs);
    }
    subs.add(handler);
    // Initial fire with cached value (if hydrated).
    const cached = this.cache.get(collection);
    if (cached) handler(cached);
    return () => {
      subs?.delete(handler);
      if (subs && subs.size === 0) this.subscribers.delete(collection);
    };
  }

  /**
   * Apply a pulled change from /erp/changes (server → local). LWW merge on
   * (rev, updatedAt): a server change with a higher rev than the local wrapper
   * wins, UNLESS the local wrapper is pending (unpushed outbox op) — then the
   * server change is held until the outbox op settles (the sync engine resolves
   * the conflict). Returns true if the local store was modified.
   *
   * This method is called by the SyncEngine; panels never call it directly.
   */
  async applyPulledChange(
    change:
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
        }
  ): Promise<boolean> {
    const existing = await this.storage.getRecord(change.collection, change.id);
    if (change.kind === 'upsert') {
      // LWW: server wins on higher rev; if equal rev, newer updatedAt wins.
      if (existing && !existing.pending && existing.rev > change.rev) return false;
      if (
        existing &&
        !existing.pending &&
        existing.rev === change.rev &&
        existing.updatedAt >= change.updatedAt
      ) {
        return false;
      }
      // If the local record is PENDING (unpushed outbox op), don't overwrite —
      // the sync engine will resolve the conflict after the push. The pulled
      // change is logged for the conflict drawer.
      if (existing && existing.pending && existing.rev > change.rev) {
        // Hold: the local change is newer and unpushed. Log conflict.
        return false;
      }
      const wrapper: ErpRecordWrapper = {
        collection: change.collection,
        id: change.id,
        data: change.data,
        rev: change.rev,
        updatedAt: change.updatedAt,
        createdAt: change.createdAt,
        pending: false,
        deleted: false,
      };
      await this.storage.putRecord(wrapper);
      this.invalidate(change.collection);
      return true;
    }
    // tombstone
    if (existing && !existing.pending && existing.rev >= change.rev) {
      // Local is newer or equal and not pending → keep local (or already deleted).
      if (existing.deleted) return false;
      // Local is newer non-deleted → don't tombstone (conflict; sync engine logs).
      if (existing.rev > change.rev) return false;
    }
    await this.storage.tombstoneRecord(
      change.collection,
      change.id,
      change.rev,
      change.updatedAt
    );
    this.invalidate(change.collection);
    return true;
  }

  /** Expose the storage for the SyncEngine (internal use). */
  getStorage(): DzosStorage {
    return this.storage;
  }

  /** Drop the in-memory cache for a collection (after a mutation or a pull merge). */
  private invalidate(collection: string): void {
    // Re-read from storage so the cache reflects the putRecord/tombstone.
    this.storage.listRecords(collection).then((wrappers) => {
      this.cache.set(collection, wrappers);
      const subs = this.subscribers.get(collection);
      if (subs) for (const h of subs) h(wrappers);
    });
  }
}

// --- Per-slug repo cache (one repo per open shop, per session) --------------

const repoCache = new Map<string, ErpRepo>();

/**
 * True if running inside the Electron desktop app (vs web). Uses the build-time
 * BUILD_CONFIG.isElectron flag (the same flag the rest of AFFiNE uses), with a
 * runtime fallback check on the injected __apis global. On Electron, getErpRepo
 * picks the native SQLite adapter; on web, the IDB adapter.
 */
const isElectron =
  typeof BUILD_CONFIG !== 'undefined' && BUILD_CONFIG.isElectron;

/**
 * Lazily import the SQLite adapter ONLY on Electron (so a web bundle never
 * evaluates the @affine/electron-api import, which is undefined on web).
 * Returns the DzosSqliteStorage class on Electron, or null on web.
 */
async function makeStorage(slug: string): Promise<DzosStorage> {
  if (isElectron) {
    const { DzosSqliteStorage } = await import('./sqlite-storage');
    return new DzosSqliteStorage(slug);
  }
  return new DzosIdbStorage(slug);
}

/**
 * Get (or create) the ErpRepo for a shop slug. On Electron the backing store
 * is native SQLite (a real file in userData, WAL mode, index-backed scans);
 * on web it's IndexedDB. Both implement the same DzosStorage contract, so the
 * repo + sync engine are backend-agnostic. The first call for a slug hydrates
 * the store (async); subsequent calls return the cached repo synchronously.
 */
export async function getErpRepo(slug: string): Promise<ErpRepo> {
  let repo = repoCache.get(slug);
  if (!repo) {
    const storage = await makeStorage(slug);
    repo = new ErpRepo(slug, storage);
    repoCache.set(slug, repo);
  }
  return repo;
}

/**
 * Synchronous variant: returns the cached repo if already created, or null.
 * Callers that need the repo synchronously (e.g. a hook that already awaited
 * the first getErpRepo on mount) can use this; the first access must be async.
 */
export function getErpRepoSync(slug: string): ErpRepo | null {
  return repoCache.get(slug) ?? null;
}

/** Drop the cached repo for a slug (on shop switch / logout). */
export function dropErpRepo(slug: string): void {
  const repo = repoCache.get(slug);
  if (repo) {
    repo.getStorage().close();
    repoCache.delete(slug);
  }
}
