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
    const repo = getErpRepo(slug);
    let alive = true;
    // Initial hydrate + subscribe.
    repo.list<T>(collection).then((rows) => {
      if (!alive) return;
      setWrappers(rows);
      setReady(true);
    });
    const unsubscribe = repo.subscribe(collection, (rows) => {
      if (!alive) return;
      setWrappers(rows as ErpRecordWrapper<T>[]);
      setReady(true);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [slug, collection]);

  return { wrappers, ready };
}

/** The live outbox-pending count for the sync pill (across all collections). */
export function useErpPendingCount(slug: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const repo = getErpRepo(slug);
    let alive = true;
    const refresh = () => {
      repo
        .getStorage()
        .listOutbox()
        .then((ops) => {
          if (alive) setCount(ops.length);
        });
    };
    refresh();
    // Poll every 2s — the outbox is small and the pill must reflect new writes.
    // (A tighter signal could be wired from repo.invalidate, but polling is
    // cheap and avoids coupling the hook to the repo's internals.)
    const interval = setInterval(refresh, 2000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [slug]);
  return count;
}

/**
 * A stable mutation handle. The write is local + immediate (the outbox drains
 * in the background); the sync pill shows the pending count. The caller never
 * needs a loading state for the write itself.
 */
export function useErpMutation(slug: string) {
  return {
    upsert: useCallback(
      <T = Record<string, unknown>>(
        collection: ErpCollection,
        id: string,
        data: T,
        opts?: { collectionOverride?: string }
      ) => getErpRepo(slug).upsert<T>(collection, id, data, opts),
      [slug]
    ),
    remove: useCallback(
      (
        collection: ErpCollection,
        id: string,
        opts?: { collectionOverride?: string }
      ) => getErpRepo(slug).remove(collection, id, opts),
      [slug]
    ),
  };
}
