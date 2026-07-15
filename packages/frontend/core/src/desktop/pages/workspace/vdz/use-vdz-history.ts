import { useCallback, useMemo, useState } from 'react';

import {
  applyOp,
  applyOps,
  type VdzOp,
  type VdzTimeline,
} from '../../../../modules/vdz';
import { HISTORY_CAP } from './constants';

/**
 * Op-sourced editing history for a {@link VdzTimeline}.
 *
 * A ring of timeline snapshots (capped at {@link HISTORY_CAP}) is pushed on
 * every SUCCESSFUL op application. `applyOp`/`applyOps` are pure and fail
 * closed, so a rejected edit leaves both the timeline and the history stack
 * untouched — only the returned `error` changes. A batch (`applyOps`) counts
 * as a single history entry.
 *
 * This is the ONE apply path the editor uses: toolbar buttons, drags, trims,
 * splits, deletes and keyboard nudges all funnel through `run`/`runBatch`, so
 * undo/redo covers everything uniformly.
 */
export interface VdzHistory {
  timeline: VdzTimeline;
  /** Error from the most recent apply attempt, or null on success. */
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Apply one op. Returns true if it committed. */
  run: (op: VdzOp) => boolean;
  /** Apply a sequence of ops as a single history entry. */
  runBatch: (ops: VdzOp[]) => boolean;
  /**
   * Replace the whole timeline with a fresh baseline, discarding all undo/redo
   * history. Used when loading a saved project or a brand-new (sample/blank)
   * timeline: the opened document becomes entry 0 of a clean ring, so an undo
   * right after opening can never walk back into the previous project. This is
   * the ONE non-op mutation of the timeline — every editing change still funnels
   * through run/runBatch.
   */
  reset: (timeline: VdzTimeline) => void;
  undo: () => void;
  redo: () => void;
  /** Clear the transient error (e.g. after showing it). */
  clearError: () => void;
}

interface HistoryState {
  /** Snapshots oldest → newest; `past[cursor]` is the live timeline. */
  past: VdzTimeline[];
  cursor: number;
}

export function useVdzHistory(initial: () => VdzTimeline): VdzHistory {
  const [state, setState] = useState<HistoryState>(() => ({
    past: [initial()],
    cursor: 0,
  }));
  const [error, setError] = useState<string | null>(null);

  const timeline = state.past[state.cursor];

  // Push a successfully-produced timeline as a new entry, dropping any
  // redo tail and trimming the ring from the front once it exceeds the cap.
  const commit = useCallback((next: VdzTimeline) => {
    setState(prev => {
      const kept = prev.past.slice(0, prev.cursor + 1);
      kept.push(next);
      const overflow = kept.length - HISTORY_CAP;
      const trimmed = overflow > 0 ? kept.slice(overflow) : kept;
      return { past: trimmed, cursor: trimmed.length - 1 };
    });
  }, []);

  const run = useCallback(
    (op: VdzOp) => {
      const result = applyOp(timeline, op);
      if (result.error) {
        setError(result.error);
        return false;
      }
      setError(null);
      commit(result.timeline);
      return true;
    },
    [timeline, commit]
  );

  const runBatch = useCallback(
    (ops: VdzOp[]) => {
      if (ops.length === 0) return false;
      const result = applyOps(timeline, ops);
      if (result.error) {
        setError(result.error);
        return false;
      }
      setError(null);
      commit(result.timeline);
      return true;
    },
    [timeline, commit]
  );

  // Load a fresh baseline: seed a brand-new one-entry ring so there is nothing
  // to undo back into. Clears any transient error too (the new document starts
  // clean). Kept out of the run/runBatch path on purpose — this is a document
  // load, not an editing op, so it must not be an undoable history entry.
  const reset = useCallback((next: VdzTimeline) => {
    setState({ past: [next], cursor: 0 });
    setError(null);
  }, []);

  const undo = useCallback(() => {
    setState(prev =>
      prev.cursor > 0 ? { ...prev, cursor: prev.cursor - 1 } : prev
    );
  }, []);

  const redo = useCallback(() => {
    setState(prev =>
      prev.cursor < prev.past.length - 1
        ? { ...prev, cursor: prev.cursor + 1 }
        : prev
    );
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return useMemo(
    () => ({
      timeline,
      error,
      canUndo: state.cursor > 0,
      canRedo: state.cursor < state.past.length - 1,
      run,
      runBatch,
      reset,
      undo,
      redo,
      clearError,
    }),
    [timeline, error, state, run, runBatch, reset, undo, redo, clearError]
  );
}
