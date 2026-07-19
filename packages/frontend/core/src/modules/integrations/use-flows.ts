import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// ClickDz flow builder — typed client for the INTEG-BE flow/run/DLQ routes.
//
// Every call goes through `cdzApiUrl` + `credentials:'include'` (per-user via
// the auth cookie — NO user id ever travels in the client). The shapes below
// mirror the backend controller EXACTLY (bare arrays for the list routes; the
// run record's identifier is `id`, not `runId`):
//   GET    /api/v1/integrations/flows            -> Flow[]        (bare)
//   GET    /api/v1/integrations/flows/:id        -> Flow | 404
//   PUT    /api/v1/integrations/flows/:id        -> Flow          (upsert; 'new' mints)
//   DELETE /api/v1/integrations/flows/:id        -> { ok }
//   POST   /api/v1/integrations/flows/:id/run    -> FlowRun       (409/404/400 typed)
//   GET    /api/v1/integrations/runs             -> FlowRunSummary[] (bare)
//   GET    /api/v1/integrations/runs/:id         -> FlowRun | 404
//   GET    /api/v1/integrations/dlq              -> FlowDlqEntry[]   (bare)
//   POST   /api/v1/integrations/dlq/:runId/replay -> FlowRun (fresh run)
//
// Pure fetch layer (no JSX). FLOW-FE's index.tsx / flow-runs.tsx consume the
// `useFlows()` hook; CANVAS-FE stays presentational (it never fetches).
// ---------------------------------------------------------------------------

// ---- domain types (match INTEG-BE C2/C3 verbatim) -------------------------

export type FlowNodeType = 'trigger' | 'action' | 'condition';

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  toolkit?: string;
  action?: string;
  config?: Record<string, unknown>;
  x: number;
  y: number;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
}

export interface Flow {
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  createdAt: number;
  updatedAt: number;
}

// Status a flow run can settle into. `running` is the transient mid-flight
// state; `partial` = some nodes ok, some gated/failed.
export type FlowRunStatus = 'running' | 'ok' | 'error' | 'partial';

// One executed node in a run — a strict superset of the orchestrator RunStep
// (adds nodeId/attempts/ms/status/error) so index.tsx's StepRow idiom renders
// both timelines.
export interface FlowRunStep {
  nodeId: string;
  tool: string;
  status: 'ok' | 'error' | 'retrying';
  attempts: number;
  ms: number;
  resultPreview: string;
  error?: string;
}

export interface FlowRun {
  id: string;
  flowId: string;
  startedAt: number;
  finishedAt?: number;
  status: FlowRunStatus;
  steps: FlowRunStep[];
}

// The compact row returned by GET /runs (the list view).
export interface FlowRunSummary {
  id: string;
  flowId: string;
  startedAt: number;
  finishedAt?: number;
  status: FlowRunStatus;
  stepCount: number;
}

// A dead-letter entry (a failed run awaiting replay). `runId` === the failed
// run's `id`, so the replay route takes it directly.
export interface FlowDlqEntry {
  runId: string;
  flowId: string;
  failedNodeId?: string;
  startedAt: number;
  enqueuedAt: number;
}

// ---- low-level fetch helpers (exported for direct use/testing) ------------

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };
const GET_HEADERS = { Accept: 'application/json' };

// A typed error carrying the HTTP status + the backend's `{error}` code (when
// present) so callers can branch on e.g. 'not_configured' / 'flow_has_cycle'.
export class FlowApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, code?: string, message?: string) {
    super(message ?? code ?? `request failed (${status})`);
    this.name = 'FlowApiError';
    this.status = status;
    this.code = code;
  }
}

async function parseError(res: Response): Promise<FlowApiError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return new FlowApiError(res.status, data.error, data.message ?? data.error);
}

export async function fetchFlows(signal?: AbortSignal): Promise<Flow[]> {
  const res = await fetch(cdzApiUrl('/api/v1/integrations/flows'), {
    method: 'GET',
    headers: GET_HEADERS,
    credentials: 'include',
    signal,
  });
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  return Array.isArray(data) ? (data as Flow[]) : [];
}

export async function fetchFlow(id: string, signal?: AbortSignal): Promise<Flow> {
  const res = await fetch(cdzApiUrl(`/api/v1/integrations/flows/${encodeURIComponent(id)}`), {
    method: 'GET',
    headers: GET_HEADERS,
    credentials: 'include',
    signal,
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as Flow;
}

// PUT upserts. Pass a flow whose `id` is `'new'` (or any unpersisted id) to
// mint a fresh record server-side; the response carries the canonical Flow
// (real id + createdAt/updatedAt). We only send the writable shape.
export async function saveFlow(flow: Flow, signal?: AbortSignal): Promise<Flow> {
  const id = flow.id || 'new';
  const body = {
    name: flow.name,
    nodes: flow.nodes,
    edges: flow.edges,
  };
  const res = await fetch(cdzApiUrl(`/api/v1/integrations/flows/${encodeURIComponent(id)}`), {
    method: 'PUT',
    headers: JSON_HEADERS,
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as Flow;
}

export async function deleteFlow(id: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(cdzApiUrl(`/api/v1/integrations/flows/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers: GET_HEADERS,
    credentials: 'include',
    signal,
  });
  if (!res.ok) throw await parseError(res);
}

export async function runFlow(id: string, signal?: AbortSignal): Promise<FlowRun> {
  const res = await fetch(cdzApiUrl(`/api/v1/integrations/flows/${encodeURIComponent(id)}/run`), {
    method: 'POST',
    headers: JSON_HEADERS,
    credentials: 'include',
    body: '{}',
    signal,
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FlowRun;
}

export async function fetchRuns(signal?: AbortSignal): Promise<FlowRunSummary[]> {
  const res = await fetch(cdzApiUrl('/api/v1/integrations/runs'), {
    method: 'GET',
    headers: GET_HEADERS,
    credentials: 'include',
    signal,
  });
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  return Array.isArray(data) ? (data as FlowRunSummary[]) : [];
}

export async function fetchRun(id: string, signal?: AbortSignal): Promise<FlowRun> {
  const res = await fetch(cdzApiUrl(`/api/v1/integrations/runs/${encodeURIComponent(id)}`), {
    method: 'GET',
    headers: GET_HEADERS,
    credentials: 'include',
    signal,
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FlowRun;
}

export async function fetchDlq(signal?: AbortSignal): Promise<FlowDlqEntry[]> {
  const res = await fetch(cdzApiUrl('/api/v1/integrations/dlq'), {
    method: 'GET',
    headers: GET_HEADERS,
    credentials: 'include',
    signal,
  });
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  return Array.isArray(data) ? (data as FlowDlqEntry[]) : [];
}

// Replay a failed/DLQ run. `runId` is the failed run's `id`; the server
// re-runs the underlying flow and returns a FRESH FlowRun.
export async function replayRun(runId: string, signal?: AbortSignal): Promise<FlowRun> {
  const res = await fetch(
    cdzApiUrl(`/api/v1/integrations/dlq/${encodeURIComponent(runId)}/replay`),
    {
      method: 'POST',
      headers: JSON_HEADERS,
      credentials: 'include',
      body: '{}',
      signal,
    }
  );
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FlowRun;
}

// A friendly, human-readable message for a FlowApiError (or any error). Keeps
// the well-known backend `{error}` codes actionable in the UI.
export function describeFlowError(err: unknown): string {
  if (err instanceof FlowApiError) {
    switch (err.code) {
      case 'not_configured':
        return 'Integrations aren’t set up yet — ask the owner to set COMPOSIO_API_KEY.';
      case 'flow_has_cycle':
        return 'This flow has a cycle — remove the loop before running.';
      case 'flow_not_found':
        return 'That flow no longer exists.';
      case 'dlq_entry_not_found':
        return 'This failed run is no longer queued for replay.';
      default:
        if (err.status === 404) return 'Not found.';
        if (err.status === 400) return err.message || 'Invalid request.';
        return err.message || `Request failed (${err.status}).`;
    }
  }
  if (err instanceof DOMException && err.name === 'AbortError') return '';
  return 'Network error. Check your connection and try again.';
}

// ---- the hook -------------------------------------------------------------

export interface UseFlows {
  // flows
  flows: Flow[];
  load: () => Promise<Flow[]>;
  save: (flow: Flow) => Promise<Flow>;
  remove: (id: string) => Promise<void>;
  run: (id: string) => Promise<FlowRun>;
  // runs
  runs: FlowRunSummary[];
  loadRuns: () => Promise<FlowRunSummary[]>;
  getRun: (id: string) => Promise<FlowRun>;
  // dlq
  dlq: FlowDlqEntry[];
  loadDlq: () => Promise<FlowDlqEntry[]>;
  replay: (runId: string) => Promise<FlowRun>;
  // status
  loading: boolean;
  error: string | null;
}

/**
 * `useFlows` — all flow + run + DLQ state for the Integrations page. The
 * mutating helpers keep the local `flows`/`runs` caches in sync optimistically
 * where cheap, and every helper surfaces failures via the shared `error`
 * string (plus throwing, so callers can also react locally). `loading` is a
 * simple in-flight counter shared across calls.
 */
export function useFlows(): UseFlows {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [runs, setRuns] = useState<FlowRunSummary[]>([]);
  const [dlq, setDlq] = useState<FlowDlqEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);

  // Guard against setState-after-unmount for long fetches.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const track = useCallback(<T>(p: Promise<T>): Promise<T> => {
    setPending(n => n + 1);
    return p.finally(() => {
      if (mountedRef.current) setPending(n => Math.max(0, n - 1));
    });
  }, []);

  const wrap = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T> => {
      setError(null);
      try {
        return await track(fn());
      } catch (err) {
        const msg = describeFlowError(err);
        if (msg && mountedRef.current) setError(msg);
        throw err;
      }
    },
    [track]
  );

  const load = useCallback(
    () =>
      wrap(async () => {
        const list = await fetchFlows();
        if (mountedRef.current) setFlows(list);
        return list;
      }),
    [wrap]
  );

  const save = useCallback(
    (flow: Flow) =>
      wrap(async () => {
        const saved = await saveFlow(flow);
        if (mountedRef.current) {
          setFlows(prev => {
            const idx = prev.findIndex(f => f.id === saved.id);
            const next = idx >= 0 ? prev.slice() : [saved, ...prev];
            if (idx >= 0) next[idx] = saved;
            next.sort((a, b) => b.updatedAt - a.updatedAt);
            return next;
          });
        }
        return saved;
      }),
    [wrap]
  );

  const remove = useCallback(
    (id: string) =>
      wrap(async () => {
        await deleteFlow(id);
        if (mountedRef.current) setFlows(prev => prev.filter(f => f.id !== id));
      }),
    [wrap]
  );

  const run = useCallback(
    (id: string) =>
      wrap(async () => {
        const record = await runFlow(id);
        // A run mutates the run index — refresh the runs list best-effort.
        void fetchRuns()
          .then(list => {
            if (mountedRef.current) setRuns(list);
          })
          .catch(() => {});
        return record;
      }),
    [wrap]
  );

  const loadRuns = useCallback(
    () =>
      wrap(async () => {
        const list = await fetchRuns();
        if (mountedRef.current) setRuns(list);
        return list;
      }),
    [wrap]
  );

  const getRun = useCallback((id: string) => wrap(() => fetchRun(id)), [wrap]);

  const loadDlq = useCallback(
    () =>
      wrap(async () => {
        const list = await fetchDlq();
        if (mountedRef.current) setDlq(list);
        return list;
      }),
    [wrap]
  );

  const replay = useCallback(
    (runId: string) =>
      wrap(async () => {
        const record = await replayRun(runId);
        // A clean replay clears the DLQ entry server-side; refresh both lists.
        void Promise.all([fetchRuns(), fetchDlq()])
          .then(([r, d]) => {
            if (!mountedRef.current) return;
            setRuns(r);
            setDlq(d);
          })
          .catch(() => {});
        return record;
      }),
    [wrap]
  );

  return useMemo(
    () => ({
      flows,
      load,
      save,
      remove,
      run,
      runs,
      loadRuns,
      getRun,
      dlq,
      loadDlq,
      replay,
      loading: pending > 0,
      error,
    }),
    [
      flows,
      load,
      save,
      remove,
      run,
      runs,
      loadRuns,
      getRun,
      dlq,
      loadDlq,
      replay,
      pending,
      error,
    ]
  );
}
