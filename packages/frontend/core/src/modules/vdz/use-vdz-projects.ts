import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useRef, useState } from 'react';

import type { VdzTimeline } from './schema';

/**
 * Vdz Studio — projects CRUD hook.
 *
 * Wraps the four per-user project routes on ClickDzVdzController (Redis-backed,
 * keyed by the authenticated `CurrentUser`, 50/owner cap, 90-day TTL):
 *   · GET    /api/v1/vdz/projects        -> VdzProjectSummary[]  (list)
 *   · GET    /api/v1/vdz/projects/:id     -> VdzProjectDoc        (load one)
 *   · POST   /api/v1/vdz/projects  {id?, name, timeline} -> VdzProjectDoc (upsert)
 *   · DELETE /api/v1/vdz/projects/:id     -> { deleted }          (remove)
 *
 * All URLs go through cdzApiUrl(...) so desktop/native builds (renderer origin
 * assets:// / file://) resolve them against the connected server — the same rule
 * FetchService / GraphQL / SSE / the compose + export hooks follow. On web this
 * is a no-op (same origin, so the session cookie rides along and auth works).
 *
 * The hook owns ONLY the request lifecycle (loading + error) plus an in-flight
 * guard so a burst of Save/Open clicks (or an autosave firing mid-click) never
 * issues overlapping mutations. The current project id / dirty state lives in
 * the ProjectBar component, which is the single caller.
 */

const PROJECTS_URL = '/api/v1/vdz/projects';

/** Compact list-view row returned by GET /projects (never the full timeline). */
export interface VdzProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}

/** A full stored project document returned by GET /:id and POST upsert. */
export interface VdzProjectDoc {
  id: string;
  name: string;
  timeline: VdzTimeline;
  createdAt: string;
  updatedAt: string;
}

/**
 * Pull a human-readable message out of an AFFiNE typed-error JSON body, falling
 * back to status text. Mirrors the readError helper in use-vdz-compose.ts so the
 * 401 (signed-out) / 400 (cap reached, oversized timeline) messages surface
 * verbatim to the user.
 */
async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as any;
    const msg =
      data?.message ??
      data?.error?.message ??
      (typeof data?.error === 'string' ? data.error : undefined);
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch {
    // ignore — fall through to status text
  }
  return res.statusText || `Request failed (${res.status})`;
}

async function requestJson<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(path), {
      // Same-origin on web; on desktop cdzApiUrl points at the connected server
      // and `credentials: include` keeps the session cookie on the request.
      credentials: 'include',
      ...init,
    });
  } catch (cause) {
    throw new Error(
      cause instanceof Error && cause.message
        ? `Network error: ${cause.message}`
        : 'Network error while contacting the project store.'
    );
  }
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  // DELETE returns a small envelope; callers that don't need it ignore the value.
  return (await res.json()) as T;
}

export interface UseVdzProjects {
  /** true while any of the four requests is in flight. */
  loading: boolean;
  /** last error message, or null. Cleared at the start of each request. */
  error: string | null;
  /** List the signed-in user's saved projects (compact rows, newest first). */
  list: () => Promise<VdzProjectSummary[]>;
  /** Load one full project document (timeline included) by id. */
  load: (id: string) => Promise<VdzProjectDoc>;
  /**
   * Upsert a project. Omit `id` to create (server mints a `vdz-…` id, subject to
   * the per-owner cap); pass an `id` to replace that project. Returns the
   * stored id so the caller can adopt a freshly-created project.
   */
  save: (input: {
    id?: string;
    name: string;
    timeline: VdzTimeline;
  }) => Promise<string>;
  /** Delete a project by id. Resolves true when a doc was actually removed. */
  remove: (id: string) => Promise<boolean>;
  /** Manually clear the current error (e.g. when the user retries). */
  clearError: () => void;
}

export function useVdzProjects(): UseVdzProjects {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // In-flight guard: one mutation/read at a time. A ref (not state) so the
  // guard is synchronous — a double-click can't slip a second request through
  // between the setState and the next render.
  const inFlight = useRef(false);

  const run = useCallback(
    async <T>(op: () => Promise<T>, fallbackMsg: string): Promise<T> => {
      if (inFlight.current) {
        // Reject re-entrant calls rather than queue them; the caller (a click
        // handler / debounced autosave) treats this as a no-op.
        throw new Error('A project request is already in progress.');
      }
      inFlight.current = true;
      setLoading(true);
      setError(null);
      try {
        return await op();
      } catch (e) {
        const message = e instanceof Error ? e.message : fallbackMsg;
        setError(message);
        throw e;
      } finally {
        inFlight.current = false;
        setLoading(false);
      }
    },
    []
  );

  const list = useCallback(
    () =>
      run(
        () => requestJson<VdzProjectSummary[]>(PROJECTS_URL),
        'Failed to load projects.'
      ),
    [run]
  );

  const load = useCallback(
    (id: string) =>
      run(
        () =>
          requestJson<VdzProjectDoc>(
            `${PROJECTS_URL}/${encodeURIComponent(id)}`
          ),
        'Failed to open project.'
      ),
    [run]
  );

  const save = useCallback(
    (input: { id?: string; name: string; timeline: VdzTimeline }) =>
      run(async () => {
        const doc = await requestJson<VdzProjectDoc>(PROJECTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        return doc.id;
      }, 'Failed to save project.'),
    [run]
  );

  const remove = useCallback(
    (id: string) =>
      run(async () => {
        const res = await requestJson<{ deleted?: boolean }>(
          `${PROJECTS_URL}/${encodeURIComponent(id)}`,
          { method: 'DELETE' }
        );
        return res?.deleted === true;
      }, 'Failed to delete project.'),
    [run]
  );

  const clearError = useCallback(() => setError(null), []);

  return { loading, error, list, load, save, remove, clearError };
}
