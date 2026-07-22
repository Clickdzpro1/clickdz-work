import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from './api';
import { AgentApiError } from './api';
import type { AgentCaps, AgentSummary } from './types';

/**
 * React hook that owns the AGENTS ROSTER + capability flags for the unified
 * `/agents` studio (R7). It calls `GET /api/v1/agents` once on mount (via
 * {@link api.listAgents}) and exposes the roster, the top-level {@link AgentCaps}
 * capability object, and the request lifecycle (loading / error). This is the
 * FE data seam every other R7 agents page keys off (home grid, nav gate, spend
 * meter, run views, connections) — they all read `{ agents, caps }` from here.
 *
 * R12 (custom agents): the same roster now ALSO carries the caller's user-created
 * custom agents (rows with `archetype`/`name`/`emoji` and a `cz_`-prefixed `id`),
 * appended by the backend when `CDZ_AGENT_CUSTOM_ENABLED` is on, plus a
 * `caps.customEnabled` flag the home gates its "Créer un agent" affordance on. No
 * new fetch is needed — those rows/flag arrive on the SAME `GET /api/v1/agents`
 * response, so this hook just surfaces them (typing widened in {@link
 * AgentSummary}/{@link AgentCaps}); a `reload()` lets the home refresh the grid
 * after a create/delete. When the custom feature is off the extra rows/flag are
 * simply absent ⇒ byte-identical to the pre-R12 roster.
 *
 * The whole feature is flag-gated on the backend (`CDZ_AGENTS_ENABLED`): when it
 * is off the controller is absent and the endpoint 404s. This hook treats that
 * 404 as "feature disabled" — it flips {@link UseAgents.disabled} true, keeps a
 * safe {@link DEFAULT_AGENT_CAPS} default (so `caps.multi` reads false and the
 * unified UI stays hidden, byte-identical to the legacy build), and surfaces NO
 * error (a dark feature is not a failure). Any other error (401 signed-out,
 * network, 5xx) is surfaced via `error` with `disabled` left false so the caller
 * can show a retry.
 *
 * Cleanup mirrors the AbortController/cleanup idiom of use-agent-stream: an
 * AbortController aborts the in-flight fetch on unmount / reload, and a
 * request-generation guard (plus a mounted guard) drops any stale or
 * post-unmount response so a fast reload never lands an older roster or writes
 * state after teardown. Follows the plain-React hook shape of the neighboring
 * use-agent-threads hook (useState/useCallback/useRef, no DI framework).
 */

/**
 * Safe capability defaults used before the first load resolves and whenever the
 * feature is dark (404). Every flag is the conservative OFF value so any caller
 * reading `caps` pre-load renders the legacy/hidden path: `multi:false` keeps
 * the unified UI gated off, `dzdPer1k:0` makes the spend meter show no estimate,
 * the channel flags stay false, and `customEnabled:false` (R12) hides the "Créer
 * un agent" affordance so custom agents dark ⇒ built-ins only, byte-identical.
 * Exported so callers can seed local state / fall back to it without re-deriving
 * the shape.
 */
export const DEFAULT_AGENT_CAPS: AgentCaps = {
  multi: false,
  dzdPer1k: 0,
  telegramEnabled: false,
  webEnabled: false,
  customEnabled: false,
};

/** What {@link useAgents} exposes to the R7 agents pages. */
export interface UseAgents {
  /** The signed-in user's agent roster, in backend (display) order. */
  agents: AgentSummary[];
  /** Top-level capability flags; {@link DEFAULT_AGENT_CAPS} until loaded / when dark. */
  caps: AgentCaps;
  /** True while the roster is being (re)loaded. */
  loading: boolean;
  /** Last error message, or null. Cleared at the start of each load. */
  error: string | null;
  /**
   * True when the feature is disabled server-side (the endpoint 404'd). Callers
   * hide the unified UI on this (a quiet, non-error fallback). Distinct from
   * `error`, which is reserved for real failures (auth/network/5xx).
   */
  disabled: boolean;
  /** Re-fetch the roster (aborts any in-flight load first). */
  reload: () => void;
}

export function useAgents(): UseAgents {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [caps, setCaps] = useState<AgentCaps>(DEFAULT_AGENT_CAPS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);

  // Aborts the in-flight fetch on unmount / reload (mirrors use-agent-stream).
  const abortRef = useRef<AbortController | null>(null);
  // Guard against setting state after unmount (the load is async).
  const mountedRef = useRef(true);
  // Monotonic request id: only the newest load may write state, so a fast
  // reload can never land a stale roster after a newer one resolved. This is
  // the non-SSE analogue of use-agent-stream's abort-supersede check (the JSON
  // fetch isn't cancellable mid-parse, so we drop the stale result instead).
  const reqIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    // Abort any prior in-flight fetch so we never keep two readers alive.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const reqId = ++reqIdRef.current;
    // Only the current request may commit its result.
    const fresh = () =>
      mountedRef.current &&
      reqId === reqIdRef.current &&
      !controller.signal.aborted;

    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const res = await api.listAgents();
        if (!fresh()) return;
        setAgents(Array.isArray(res?.agents) ? res.agents : []);
        // Tolerate a partial payload: fall back to safe defaults if `caps` is
        // missing/malformed so a caller never reads an undefined flag.
        setCaps(
          res && res.caps && typeof res.caps === 'object'
            ? res.caps
            : DEFAULT_AGENT_CAPS
        );
        setDisabled(false);
      } catch (err) {
        if (!fresh()) return;
        // A 404 means the feature is gated OFF (CDZ_AGENTS_ENABLED absent): treat
        // it as "disabled", NOT an error — reset to a safe hidden state so the
        // unified UI stays byte-identical to the legacy build.
        if (err instanceof AgentApiError && err.status === 404) {
          setDisabled(true);
          setAgents([]);
          setCaps(DEFAULT_AGENT_CAPS);
          setError(null);
        } else {
          setDisabled(false);
          setError(
            err instanceof Error ? err.message : 'Failed to load agents.'
          );
        }
      } finally {
        // Only the current request clears the spinner (a superseded load must
        // not flip loading off under a newer one).
        if (mountedRef.current && reqId === reqIdRef.current) {
          setLoading(false);
        }
      }
    })();
  }, []);

  const reload = useCallback(() => {
    load();
  }, [load]);

  // Load once on mount; abort the in-flight fetch on cleanup. `load` is stable
  // (empty deps), so this runs exactly once.
  useEffect(() => {
    load();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [load]);

  return {
    agents,
    caps,
    loading,
    error,
    disabled,
    reload,
  };
}
