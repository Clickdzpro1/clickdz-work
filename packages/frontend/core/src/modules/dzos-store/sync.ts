/**
 * DzOS ERP local-first store — SyncEngine (background push/pull).
 *
 * The SyncEngine drains the outbox (push) and pulls /erp/changes (pull) in the
 * background. It never blocks the UI; it surfaces a SyncStatus the pill reads.
 *
 * Push: for each outbox op (oldest-first), PUT/DELETE to the data API with the
 * op's opId as X-Idempotency-Key. On success, drop the op. On 409 (conflict),
 * log to the conflict drawer and drop the op (LWW: server won; the next pull
 * corrects). On network/5xx, exponential backoff (attempts++).
 *
 * Pull: GET /erp/changes?since=<cursor> per slug until nextCursor is null.
 * Apply each change via repo.applyPulledChange (LWW merge). Update the cursor.
 *
 * Connectivity: online/offline events flip the status; a flush is scheduled on
 * online. A flush is also scheduled after every local mutation (the repo's
 * invalidate path can call schedulePush, but the engine polls the outbox on a
 * short interval too so no tight coupling is needed).
 *
 * One engine per repo (per slug). Created lazily by getSyncEngine(slug). The
 * API base URL is injected (not imported from the AI-provider module) so the
 * dzos-store module stays decoupled and unit-testable.
 */

import type { ErpRepo } from './repo';
import type {
  ErpChange,
  ErpChangesResponse,
  ErpSyncMeta,
  SyncStatus,
} from './types';

/** Push + pull cadence (ms). Pull is cheap (cursor-driven); push runs on demand. */
const PULL_INTERVAL_MS = 30_000;
const PUSH_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

/** A logged conflict (rare in single-merchant reality) for the UI drawer. */
export interface ErpConflict {
  opId: string;
  collection: string;
  recordId: string;
  baseRev: number;
  serverRev: number;
  ts: string;
  message: string;
}

/**
 * The SyncEngine. Constructed with an ErpRepo + the slug's API base. The API
 * calls go through the owner-authenticated bridge (credentials: include) so
 * the token is handled server-side, same as every other studio write.
 */
export class SyncEngine {
  private status: SyncStatus = { state: 'synced' };
  private statusListeners = new Set<(s: SyncStatus) => void>();
  private conflicts: ErpConflict[] = [];
  private conflictListeners = new Set<(c: ErpConflict[]) => void>();
  private pushTimer: ReturnType<typeof setInterval> | null = null;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private online = true;
  private pushing = false;
  private pulling = false;
  private started = false;

  constructor(
    private readonly repo: ErpRepo,
    private readonly slug: string,
    private readonly apiBase: string
  ) {}

  /** Start the engine (idempotent). Schedules push/pull + binds online/offline. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
    }
    this.pushTimer = setInterval(() => void this.push(), PUSH_INTERVAL_MS);
    this.pullTimer = setInterval(() => void this.pull(), PULL_INTERVAL_MS);
    // Kick off an immediate pull (hydrates deltas) + push (drain any backlog).
    void this.push();
    void this.pull();
    this.emitStatus();
  }

  /** Stop the engine (on shop switch / logout). Removes listeners + timers. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.pushTimer) clearInterval(this.pushTimer);
    if (this.pullTimer) clearInterval(this.pullTimer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
    }
  }

  /** Subscribe to status changes (the sync pill). Returns unsubscribe. */
  onStatus(listener: (s: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  /** Subscribe to conflict-log changes (the conflict drawer). Returns unsubscribe. */
  onConflicts(listener: (c: ErpConflict[]) => void): () => void {
    this.conflictListeners.add(listener);
    listener(this.conflicts);
    return () => this.conflictListeners.delete(listener);
  }

  /** Current sync status. */
  getStatus(): SyncStatus {
    return this.status;
  }

  // --- push ----------------------------------------------------------------

  /** Drain the outbox (one pass). Idempotent: re-entrant calls are deduped. */
  async push(): Promise<void> {
    if (!this.online || this.pushing) return;
    this.pushing = true;
    try {
      const storage = this.repo.getStorage();
      const ops = await storage.listOutbox();
      if (ops.length === 0) {
        // Outbox empty — if we just drained it, record the push time.
        const meta = await storage.getMeta(this.slug);
        if (meta && meta.lastPushAt) {
          this.setStatus({ state: 'synced' });
        }
        return;
      }
      this.setStatus({ state: 'pending', count: ops.length });
      for (const op of ops) {
        const ok = await this.pushOne(op);
        if (ok) {
          await storage.removeOutbox(op.opId);
        } else {
          // Backoff: stop the pass on the first failure (head-of-line). The
          // next interval (or online event) retries from the oldest.
          await storage.updateOutbox(op.opId, op.attempts + 1, op.lastError);
          break;
        }
      }
      // Re-check: if drained, mark synced + record push time.
      const remaining = await storage.listOutbox();
      if (remaining.length === 0) {
        const meta = (await storage.getMeta(this.slug)) ?? {
          slug: this.slug,
          pullCursor: null,
          lastPullAt: null,
          lastPushAt: null,
        };
        const updated: ErpSyncMeta = {
          ...meta,
          lastPushAt: new Date().toISOString(),
        };
        await storage.putMeta(updated);
        this.setStatus({ state: 'synced' });
      } else {
        this.setStatus({ state: 'pending', count: remaining.length });
      }
    } finally {
      this.pushing = false;
    }
  }

  /** Push one outbox op. Returns true on success (op should be dropped). */
  private async pushOne(op: { opId: string; collection: string; recordId: string; op: string; payload?: Record<string, unknown>; attempts: number }): Promise<boolean> {
    try {
      const url = `${this.apiBase}/api/v1/apps/${encodeURIComponent(this.slug)}/erp/sync/${encodeURIComponent(op.collection)}/${encodeURIComponent(op.recordId)}`;
      const method = op.op === 'remove' ? 'DELETE' : 'PUT';
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Idempotency-Key': op.opId,
        },
        credentials: 'include',
        body: op.op === 'remove' ? undefined : JSON.stringify(op.payload ?? {}),
      });
      if (res.status === 409) {
        // Conflict: server has a newer rev. Log it + drop the op (LWW: server
        // wins; the next pull brings the server's version down).
        const body = (await res.json().catch(() => ({}))) as {
          rev?: number;
          message?: string;
        };
        this.conflicts.push({
          opId: op.opId,
          collection: op.collection,
          recordId: op.recordId,
          baseRev: 0,
          serverRev: body.rev ?? 0,
          ts: new Date().toISOString(),
          message: body.message ?? 'conflict',
        });
        this.emitConflicts();
        return true; // drop the op (resolved in favor of server)
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        // 4xx (non-conflict, non-timeout, non-rate-limit): a hard error
        // (bad payload, auth). Drop the op so it doesn't block the queue, but
        // log it loudly.
        this.conflicts.push({
          opId: op.opId,
          collection: op.collection,
          recordId: op.recordId,
          baseRev: 0,
          serverRev: 0,
          ts: new Date().toISOString(),
          message: `HTTP ${res.status} — op dropped`,
        });
        this.emitConflicts();
        return true;
      }
      if (!res.ok) {
        // 5xx / timeout / rate-limit: keep the op, back off.
        return false;
      }
      // Success: the op is applied server-side (idempotent on opId).
      return true;
    } catch {
      // Network error: keep the op, back off.
      return false;
    }
  }

  // --- pull ----------------------------------------------------------------

  /** Pull /erp/changes since the stored cursor. Applies each change (LWW). */
  async pull(): Promise<void> {
    if (!this.online || this.pulling) return;
    this.pulling = true;
    try {
      const storage = this.repo.getStorage();
      const meta = await storage.getMeta(this.slug);
      let cursor = meta?.pullCursor ?? null;
      let hasMore = true;
      let appliedAny = false;
      while (hasMore) {
        const qs = cursor ? `?since=${encodeURIComponent(cursor)}` : '';
        const url = `${this.apiBase}/api/v1/apps/${encodeURIComponent(this.slug)}/erp/changes${qs}`;
        let res: Response;
        try {
          res = await fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            credentials: 'include',
          });
        } catch {
          // Network error: leave the cursor where it is; next pull retries.
          this.setStatus(this.online ? { state: 'error', message: 'pull réseau' } : { state: 'offline' });
          return;
        }
        if (res.status === 404) {
          // Endpoint not enabled yet (Phase 1 rollout): no-op, stay synced.
          this.setStatus({ state: 'synced' });
          return;
        }
        if (!res.ok) {
          this.setStatus({ state: 'error', message: `HTTP ${res.status}` });
          return;
        }
        const body = (await res.json()) as ErpChangesResponse;
        for (const change of body.changes) {
          const applied = await this.repo.applyPulledChange(change);
          if (applied) appliedAny = true;
        }
        cursor = body.nextCursor;
        hasMore = body.hasMore && cursor !== null;
        if (appliedAny && hasMore) {
          // Continue paging. (Avoid an infinite loop: server drives hasMore.)
        }
      }
      const updated: ErpSyncMeta = {
        slug: this.slug,
        pullCursor: cursor,
        lastPullAt: new Date().toISOString(),
        lastPushAt: meta?.lastPushAt ?? null,
      };
      await storage.putMeta(updated);
      // Re-evaluate status: synced iff outbox is also empty.
      const outbox = await storage.listOutbox();
      this.setStatus(
        outbox.length > 0
          ? { state: 'pending', count: outbox.length }
          : { state: 'synced' }
      );
    } finally {
      this.pulling = false;
    }
  }

  // --- helpers -------------------------------------------------------------

  private backoffMs(attempts: number): number {
    return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts);
  }

  private onOnline = () => {
    this.online = true;
    void this.push();
    void this.pull();
  };

  private onOffline = () => {
    this.online = false;
    this.setStatus({ state: 'offline' });
  };

  private setStatus(s: SyncStatus): void {
    this.status = s;
    this.emitStatus();
  }

  private emitStatus(): void {
    for (const l of this.statusListeners) l(this.status);
  }

  private emitConflicts(): void {
    for (const l of this.conflictListeners) l(this.conflicts);
  }
}

// --- Per-slug engine cache --------------------------------------------------

const engineCache = new Map<string, SyncEngine>();

import { getErpRepo } from './repo';

/** Cached API base (resolved once on first getSyncEngine call). */
let cachedApiBase: string | null = null;

/**
 * Resolve the API base for the sync engine. Uses a dynamic import so the
 * engine module itself stays decoupled from the AI-provider module at
 * module-eval time (the import only runs in the browser, where the module is
 * available). cdzApiUrl('') returns the configured API origin.
 */
async function resolveApiBase(): Promise<string> {
  if (cachedApiBase) return cachedApiBase;
  const mod = await import('@affine/core/blocksuite/ai/provider/ai-provider');
  cachedApiBase = mod.cdzApiUrl('');
  return cachedApiBase;
}

/** Get (or create + start) the SyncEngine for a slug. Returns a Promise. */
export async function getSyncEngine(slug: string): Promise<SyncEngine> {
  let engine = engineCache.get(slug);
  if (!engine) {
    const apiBase = await resolveApiBase();
    const repo = await getErpRepo(slug);
    engine = new SyncEngine(repo, slug, apiBase);
    engineCache.set(slug, engine);
    engine.start();
  }
  return engine;
}

/**
 * Synchronous variant: returns the cached engine if already started, or null.
 * The pill/panel should use the async getSyncEngine on mount; this is for
 * callers that know the engine is already running.
 */
export function getSyncEngineSync(slug: string): SyncEngine | null {
  return engineCache.get(slug) ?? null;
}

/** Stop + drop the engine for a slug (on shop switch / logout). */
export function dropSyncEngine(slug: string): void {
  const engine = engineCache.get(slug);
  if (engine) {
    engine.stop();
    engineCache.delete(slug);
  }
}
