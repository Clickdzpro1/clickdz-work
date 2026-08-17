/**
 * DzOS ERP local-first store — React hooks.
 *
 * useErpQuery: subscribe to a collection, re-render on every mutation. The
 * initial render returns [] (or the cached value if hydrated) and hydrates in
 * the background; a re-render fires when the data lands. No loading waterfall
 * on tab switch (the cache is hot after first open).
 *
 * useErpMutation: wrap a repo upsert/remove in a stable callback that also
 * surfaces the outbox-pending state. Never throws for a documented local
 * failure — the outbox makes writes always succeed locally.
 */

import { useCallback, useEffect, useState } from 'react';

import { getErpRepo } from './repo';
import type { ErpCollection, ErpRecordWrapper } from './types';

/**
 * Subscribe to a collection. Returns { wrappers, ready }. `wrappers` is the
 * live list (newest-first); `ready` flips true once the first hydration lands
 * (so a panel can distinguish "loading" from "empty collection").
 */
export function useErpQuery<T = Record<string, unknown>>(
  slug: string,
  collection: ErpCollection
): { wrappers: ErpRecordWrapper<T>[]; ready: boolean } {
  const [wrappers, setWrappers] = useState<ErpRecordWrapper<T>[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let alive = true;
    // Phase 5 error-shield: if getErpRepo rejects (storage backend totally
    // broken), the hook must still flip ready=true so the panel renders an
    // empty state instead of an infinite spinner.
    void getErpRepo(slug)
      .then((repo) => {
        if (!alive) return;
        // Initial hydrate + subscribe.
        repo.list<T>(collection)
          .then((rows) => {
            if (!alive) return;
            setWrappers(rows);
            setReady(true);
          })
          .catch((err) => {
            // Phase 5 error-shield: list() already has internal guards, but
            // if it somehow rejects, flip ready with an empty list.
            console.error('[dzos-store] useErpQuery: list failed', collection, err);
            if (alive) setReady(true);
          });
        unsubscribe = repo.subscribe(collection, (rows) => {
          if (!alive) return;
          setWrappers(rows as ErpRecordWrapper<T>[]);
          setReady(true);
        });
      })
      .catch((err) => {
        console.error('[dzos-store] useErpQuery: getErpRepo failed', slug, err);
        if (alive) setReady(true); // render empty state, not infinite spinner
      });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [slug, collection]);

  return { wrappers, ready };
}

/** The live outbox-pending count for the sync pill (across all collections). */
export function useErpPendingCount(slug: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    let interval: ReturnType<typeof setInterval> | undefined;
    const refresh = async () => {
      try {
        const repo = await getErpRepo(slug);
        const ops = await repo.getStorage().listOutbox();
        if (alive) setCount(ops.length);
      } catch {
        /* ignore — the pill degrades to 0 */
      }
    };
    void refresh();
    // Poll every 2s — the outbox is small and the pill must reflect new writes.
    interval = setInterval(() => void refresh(), 2000);
    return () => {
      alive = false;
      if (interval) clearInterval(interval);
    };
  }, [slug]);
  return count;
}

/**
 * A stable mutation handle. The write is local + immediate (the outbox drains
 * in the background); the sync pill shows the pending count. The caller never
 * needs a loading state for the write itself.
 *
 * Phase 5 error-shield: both upsert and remove catch internal storage errors
 * (the repo never throws for a documented local failure), but the getErpRepo
 * call itself can reject if the storage backend is totally broken. The
 * returned promise resolves with undefined on such a failure so callers that
 * await it don't get an unhandled rejection.
 */
export function useErpMutation(slug: string) {
  return {
    upsert: useCallback(
      <T = Record<string, unknown>>(
        collection: ErpCollection,
        id: string,
        data: T,
        opts?: { collectionOverride?: string }
      ) =>
        getErpRepo(slug)
          .then((repo) => repo.upsert<T>(collection, id, data, opts))
          .catch((err) => {
            console.error('[dzos-store] useErpMutation.upsert: failed', collection, id, err);
            return undefined;
          }),
      [slug]
    ),
    remove: useCallback(
      (
        collection: ErpCollection,
        id: string,
        opts?: { collectionOverride?: string }
      ) =>
        getErpRepo(slug)
          .then((repo) => repo.remove(collection, id, opts))
          .catch((err) => {
            console.error('[dzos-store] useErpMutation.remove: failed', collection, id, err);
          }),
      [slug]
    ),
  };
}
