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
        return wrappers as ErpRecordWrapper<T>[];
      } catch (err) {
        // Phase 5 error-shield: a storage failure (IDB quota / SQLite IPC
        // disconnect) must never crash the UI. Return the cached value if
        // another caller populated it, otherwise an empty list so the panel
        // renders an empty state instead of throwing.
        const fallback = this.cache.get(collection);
        if (fallback) return fallback as ErpRecordWrapper<T>[];
        console.error('[dzos-store] list: storage read failed', collection, err);
        return [];
      } finally {
        this.hydrating.delete(collection);
      }
    }
    // Another caller is hydrating this collection; await its result by
    // re-reading storage (the dedup is best-effort; a double-read is cheap).
    // Phase 5 error-shield: guard the secondary read too.
    try {
      const wrappers = await this.storage.listRecords(collection);
      this.cache.set(collection, wrappers);
      return wrappers as ErpRecordWrapper<T>[];
    } catch (err) {
      const fallback = this.cache.get(collection);
      if (fallback) return fallback as ErpRecordWrapper<T>[];
      console.error('[dzos-store] list: secondary storage read failed', collection, err);
      return [];
    }
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
    // Phase 5 error-shield: a storage failure must not crash callers that
    // check for null. Degrade to null (record "not found").
    try {
      return (await this.storage.getRecord(collection, id)) as ErpRecordWrapper<T> | null;
    } catch (err) {
      console.error('[dzos-store] get: storage read failed', collection, id, err);
      return null;
    }
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
    // Phase 5 error-shield: guard the existing-record lookup so a storage
    // error doesn't crash the write path — treat it as a fresh insert.
    let existing: ErpRecordWrapper | null;
    try {
      existing = await this.storage.getRecord(target, id);
    } catch (err) {
      console.error('[dzos-store] upsert: getRecord failed, treating as fresh', target, id, err);
      existing = null;
    }
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
    try {
      await this.storage.putRecord(wrapper);
    } catch (err) {
      // Phase 5 error-shield: if the local store is corrupted / full, the
      // write fails — but we still return the wrapper so the caller's UI
      // state is consistent. The outbox op is skipped (no point queueing a
      // push for a record that didn't persist locally). The sync pill stays
      // 'synced' (nothing to push); the error is logged.
      console.error('[dzos-store] upsert: putRecord failed', target, id, err);
      return wrapper as ErpRecordWrapper<T>;
    }
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
    try {
      await this.storage.appendOutbox(op);
    } catch (err) {
      // Phase 5 error-shield: outbox-append failure means the change won't
      // sync, but the local record is already written. Log loudly — the
      // merchant's data is safe locally; sync will catch up on the next
      // manual retry or a store repair.
      console.error('[dzos-store] upsert: appendOutbox failed — change will not sync', target, id, err);
    }
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
    // Phase 5 error-shield: guard the existing-record lookup.
    let existing: ErpRecordWrapper | null;
    try {
      existing = await this.storage.getRecord(target, id);
    } catch (err) {
      console.error('[dzos-store] remove: getRecord failed', target, id, err);
      return; // can't tombstone what we can't read — idempotent no-op
    }
    if (!existing) return; // already gone — idempotent
    const now = new Date().toISOString();
    const rev = existing.rev + 1;
    try {
      await this.storage.tombstoneRecord(target, id, rev, now);
    } catch (err) {
      // Phase 5 error-shield: storage failure on tombstone — log and bail.
      // The record stays in its pre-removal state; the next retry or a
      // store repair will complete the delete.
      console.error('[dzos-store] remove: tombstoneRecord failed', target, id, err);
      return;
    }
    const op: ErpOutboxOp = {
      opId: ulid(),
      collection: target,
      recordId: id,
      op: 'remove',
      baseRev: existing.rev,
      ts: now,
      attempts: 0,
    };
    try {
      await this.storage.appendOutbox(op);
    } catch (err) {
      console.error('[dzos-store] remove: appendOutbox failed — delete will not sync', target, id, err);
    }
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
    // Phase 5 error-shield: guard the existing-record lookup so a storage
    // failure degrades to "no existing record" (server change applied) rather
    // than crashing the pull loop.
    let existing: ErpRecordWrapper | null;
    try {
      existing = await this.storage.getRecord(change.collection, change.id);
    } catch (err) {
      console.error('[dzos-store] applyPulledChange: getRecord failed', change.collection, change.id, err);
      existing = null;
    }
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
      try {
        await this.storage.putRecord(wrapper);
        this.invalidate(change.collection);
      } catch (err) {
        // Phase 5 error-shield: a storage write failure during a pull merge
        // is non-fatal — the next pull will re-apply this change (the
        // cursor hasn't advanced). Log and return false so the sync engine
        // doesn't advance the cursor past an un-applied change.
        console.error('[dzos-store] applyPulledChange: putRecord failed', change.collection, change.id, err);
        return false;
      }
      return true;
    }
    // tombstone
    if (existing && !existing.pending && existing.rev >= change.rev) {
      // Local is newer or equal and not pending → keep local (or already deleted).
      if (existing.deleted) return false;
      // Local is newer non-deleted → don't tombstone (conflict; sync engine logs).
      if (existing.rev > change.rev) return false;
    }
    try {
      await this.storage.tombstoneRecord(
        change.collection,
        change.id,
        change.rev,
        change.updatedAt
      );
      this.invalidate(change.collection);
    } catch (err) {
      // Phase 5 error-shield: tombstone write failure — the next pull
      // retries (cursor hasn't advanced). Log and return false.
      console.error('[dzos-store] applyPulledChange: tombstoneRecord failed', change.collection, change.id, err);
      return false;
    }
    return true;
  }

  /** Expose the storage for the SyncEngine (internal use). */
  getStorage(): DzosStorage {
    return this.storage;
  }

  /** Drop the in-memory cache for a collection (after a mutation or a pull merge). */
  private invalidate(collection: string): void {
    // Re-read from storage so the cache reflects the putRecord/tombstone.
    // Phase 5 error-shield: catch the rejection so a storage failure doesn't
    // surface as an unhandled promise rejection (which would crash the page
    // in strict dev mode). Subscribers get the last-known cached list.
    this.storage.listRecords(collection).then((wrappers) => {
      this.cache.set(collection, wrappers);
      const subs = this.subscribers.get(collection);
      if (subs) for (const h of subs) h(wrappers);
    }).catch((err) => {
      console.error('[dzos-store] invalidate: storage re-read failed', collection, err);
      // Still notify subscribers with whatever's cached (if anything) so
      // React hooks re-render instead of staling.
      const cached = this.cache.get(collection);
      if (cached) {
        const subs = this.subscribers.get(collection);
        if (subs) for (const h of subs) h(cached);
      }
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
    try {
      const { DzosSqliteStorage } = await import('./sqlite-storage');
      return new DzosSqliteStorage(slug);
    } catch (err) {
      // Phase 5 error-shield: if the SQLite adapter import fails (missing
      // @affine/electron-api in a broken build, or a module-load error),
      // fall back to IDB so the app still works offline. The IDB adapter
      // is available in the Electron renderer too.
      console.error('[dzos-store] makeStorage: SQLite adapter unavailable, falling back to IDB', err);
      return new DzosIdbStorage(slug);
    }
  }
  return new DzosIdbStorage(slug);
}

/**
 * Get (or create) the ErpRepo for a shop slug. On Electron the backing store
 * is native SQLite (a real file in userData, WAL mode, index-backed scans);
 * on web it's IndexedDB. Both implement the same DzosStorage contract, so the
 * repo + sync engine are backend-agnostic. The first call for a slug hydrates
 * the store (async); subsequent calls return the cached repo synchronously.
 *
 * DzOS Phase 1 end-state: this ALSO starts the SyncEngine for the slug (so the
 * /erp/changes pull keeps the local store fresh). Every page that touches the
 * repo gets the pull running — no page needs to remember to start the engine.
 * The engine is idempotent (getSyncEngine caches + reuses). Lazy-imported here
 * to avoid a circular import (sync.ts imports getErpRepo).
 */
export async function getErpRepo(slug: string): Promise<ErpRepo> {
  let repo = repoCache.get(slug);
  if (!repo) {
    const storage = await makeStorage(slug);
    repo = new ErpRepo(slug, storage);
    repoCache.set(slug, repo);
    // Start the sync engine so the /erp/changes pull keeps this repo's local
    // store fresh. Fire-and-forget — the engine self-schedules; a failure
    // (e.g. offline) degrades to 'offline' status, never throws.
    // Phase 5 error-shield: the import + getSyncEngine chain already has
    // internal catch(), but we add a top-level guard so a module-load error
    // in sync.ts doesn't propagate as an unhandled rejection.
    void import('./sync')
      .then(({ getSyncEngine }) => getSyncEngine(slug))
      .catch((err) => {
        console.error('[dzos-store] getErpRepo: failed to start sync engine', err);
      });
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
    // Phase 5 error-shield: close() can throw on a broken storage backend;
    // never block the cache eviction (the repo is dropped regardless).
    try {
      repo.getStorage().close();
    } catch (err) {
      console.error('[dzos-store] dropErpRepo: close failed', slug, err);
    }
    repoCache.delete(slug);
  }
}
