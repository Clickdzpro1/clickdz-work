import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from './api';
import type {
  AgentName,
  AgentThread,
  AgentThreadSummary,
} from './types';

/**
 * React hook that owns the THREAD LIST + active-thread state for an agent
 * console (the sidebar). It wraps the thread REST endpoints in {@link api} and
 * keeps the sidebar in sync with runs driven by use-agent-stream: after a send
 * completes the page calls {@link UseAgentThreads.reload} (and, for a
 * just-created thread, {@link UseAgentThreads.setActiveId}) so a new/renamed/
 * bumped thread surfaces without a manual refresh.
 *
 * A "new thread" is purely a client action — it just clears the active
 * selection; the backend mints the thread id on the first `send` (returned via
 * the stream's `thread` event), so there is no create endpoint to call here.
 *
 * All operations are defensive: a failed request sets {@link UseAgentThreads.error}
 * and leaves the list intact rather than throwing, so the sidebar never crashes
 * on a transient network error. Follows the plain-React hook idiom of the
 * neighboring vdz hooks (useState/useCallback/useRef, no DI framework).
 */

/** What {@link useAgentThreads} exposes to a console page. */
export interface UseAgentThreads {
  /** The signed-in user's threads for this agent, newest first. */
  threads: AgentThreadSummary[];
  /** The selected thread id, or null when composing a new thread. */
  activeId: string | null;
  /** Select a thread (or null for a new thread). Does not load it. */
  setActiveId: (id: string | null) => void;
  /** Re-fetch the thread list. Call after a send completes. */
  reload: () => Promise<void>;
  /** Start a new thread: clears the active selection + loaded thread. */
  newThread: () => void;
  /** Rename a thread (optimistic; reverts + surfaces error on failure). */
  rename: (id: string, title: string) => Promise<void>;
  /** Delete a thread (optimistic; reverts + surfaces error on failure). */
  remove: (id: string) => Promise<void>;
  /** The fully-loaded active thread (messages included), or null. */
  activeThread: AgentThread | null;
  /** Load a thread's full document and make it active. */
  loadThread: (id: string) => Promise<void>;
  /** True while the thread list is being (re)loaded. */
  loadingThreads: boolean;
  /** True while a single thread document is being loaded. */
  loadingThread: boolean;
  /** Last error message, or null. */
  error: string | null;
}

/** Options for {@link useAgentThreads}. */
export interface UseAgentThreadsOptions {
  agent: AgentName;
  /** Load the thread list on mount / agent change. Defaults to true. */
  autoLoad?: boolean;
}

export function useAgentThreads(
  options: UseAgentThreadsOptions
): UseAgentThreads {
  const { agent, autoLoad = true } = options;

  const [threads, setThreads] = useState<AgentThreadSummary[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<AgentThread | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard against setting state after unmount (list/detail loads are async).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoadingThreads(true);
    setError(null);
    try {
      const rows = await api.listThreads(agent);
      if (!mountedRef.current) return;
      // Newest first — sort defensively in case the server order changes.
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      setThreads(rows);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load threads.');
    } finally {
      if (mountedRef.current) setLoadingThreads(false);
    }
  }, [agent]);

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    // Selecting away from the loaded thread drops the stale detail; loadThread
    // repopulates it. Keeps activeThread consistent with activeId.
    setActiveThread(prev => (prev && prev.id === id ? prev : null));
  }, []);

  const loadThread = useCallback(
    async (id: string) => {
      setActiveIdState(id);
      setLoadingThread(true);
      setError(null);
      try {
        const thread = await api.getThread(agent, id);
        if (!mountedRef.current) return;
        setActiveThread(thread);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to open thread.');
        setActiveThread(null);
      } finally {
        if (mountedRef.current) setLoadingThread(false);
      }
    },
    [agent]
  );

  const newThread = useCallback(() => {
    // A new thread exists only client-side until the first send; just clear
    // the selection + any loaded detail so the composer starts fresh.
    setActiveIdState(null);
    setActiveThread(null);
    setError(null);
  }, []);

  const rename = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      // Optimistic update; snapshot for rollback.
      const prevThreads = threads;
      const prevActive = activeThread;
      setThreads(prev =>
        prev.map(t => (t.id === id ? { ...t, title: trimmed } : t))
      );
      setActiveThread(prev =>
        prev && prev.id === id ? { ...prev, title: trimmed } : prev
      );
      setError(null);
      try {
        await api.renameThread(agent, id, trimmed);
      } catch (err) {
        if (!mountedRef.current) return;
        // Roll back on failure.
        setThreads(prevThreads);
        setActiveThread(prevActive);
        setError(
          err instanceof Error ? err.message : 'Failed to rename thread.'
        );
      }
    },
    [agent, threads, activeThread]
  );

  const remove = useCallback(
    async (id: string) => {
      // Optimistic removal; snapshot for rollback.
      const prevThreads = threads;
      setThreads(prev => prev.filter(t => t.id !== id));
      if (activeId === id) {
        setActiveIdState(null);
        setActiveThread(null);
      }
      setError(null);
      try {
        await api.deleteThread(agent, id);
      } catch (err) {
        if (!mountedRef.current) return;
        setThreads(prevThreads);
        setError(
          err instanceof Error ? err.message : 'Failed to delete thread.'
        );
      }
    },
    [agent, threads, activeId]
  );

  // Initial + on-agent-change load. Resets selection when the agent switches.
  useEffect(() => {
    if (!autoLoad) return;
    setActiveIdState(null);
    setActiveThread(null);
    void reload();
  }, [autoLoad, reload]);

  return {
    threads,
    activeId,
    setActiveId,
    reload,
    newThread,
    rename,
    remove,
    activeThread,
    loadThread,
    loadingThreads,
    loadingThread,
    error,
  };
}
