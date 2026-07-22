import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from './api';
import { AgentApiError } from './api';
import type { TelegramChannelStatus } from './api';
import type { AgentName } from './types';

/**
 * React hook that owns the per-user, per-agent TELEGRAM CHANNEL (R10 BYOT). It
 * wraps the R10 connect/status/disconnect/test endpoints in {@link api} for one
 * agent and exposes the channel status plus the request lifecycle (loading /
 * connecting / error) so a channel card (Réglage's `<TelegramChannelCard />`)
 * can render the not-connected → connecting → connected states without owning
 * any fetch logic itself.
 *
 * Channels are BYOT: the user pastes the token of a bot THEY created in
 * BotFather; the backend validates it, sets the webhook, seals the token at
 * rest, and binds inbound messages from that bot to this user + agent. The
 * status read here NEVER carries the token (the backend strips it) — only
 * `{ connected, botUsername?, connectedAt? }`.
 *
 * The whole feature is flag-gated on the backend (`CDZ_AGENT_TELEGRAM_ENABLED`
 * + a configured `CDZ_DATA_SECRET`): when it is dark the routes 404. Like
 * {@link api.getTelegramChannel} (which maps 404 → a disconnected status), this
 * hook treats a dark feature as simply "not connected" rather than an error —
 * so the card shows a quiet "bientôt" / not-connected state instead of a red
 * failure. Real failures (401 signed-out, network, 5xx) surface via `error`.
 *
 * Cleanup mirrors the AbortController/mounted-guard idiom of use-agents /
 * use-agent-stream: an AbortController aborts the in-flight status fetch on
 * unmount / reload, a monotonic request-generation guard drops any stale or
 * post-unmount response (the JSON fetch isn't cancellable mid-parse, so we drop
 * the superseded result instead), and a mounted guard blocks writes after
 * teardown. Plain-React shape (useState/useCallback/useRef, no DI framework),
 * exactly like the neighboring use-agents / use-agent-threads hooks.
 */

/** A disconnected status — the safe default before the first load and on a dark (404) feature. */
const DISCONNECTED: TelegramChannelStatus = { connected: false };

/** What {@link useTelegramChannel} exposes to a channel card. */
export interface UseTelegramChannel {
  /** The current channel status ({@link DISCONNECTED} until loaded / when dark). */
  status: TelegramChannelStatus;
  /** True while the status is being (re)loaded. */
  loading: boolean;
  /** Last error message, or null. Cleared at the start of each load / action. */
  error: string | null;
  /** True while a {@link connect} call is in flight (drives the connecting spinner). */
  connecting: boolean;
  /**
   * Connect the user's bot to this agent: validates + stores the BotFather
   * `token` server-side, then reloads the status. Rejects with the typed
   * {@link AgentApiError} message on failure (e.g. `invalid_token` on a 400) so
   * the card can surface it inline; `error` is also set. Sets {@link connecting}
   * for the duration.
   */
  connect: (token: string) => Promise<void>;
  /** Disconnect the bot (delete the webhook + stored token), then reload the status. */
  disconnect: () => Promise<void>;
  /**
   * Send a test message to the bound chat (if the user has messaged the bot).
   * Returns the `{ ok, sent }` envelope so the card can tell the user whether a
   * message actually went out (`sent:false` ⇒ "message the bot first"). Throws
   * on a transport/HTTP failure (also recorded in `error`).
   */
  test: () => Promise<{ ok: boolean; sent: boolean }>;
  /** Re-fetch the status (aborts any in-flight load first). */
  reload: () => void;
}

export function useTelegramChannel(agent: AgentName): UseTelegramChannel {
  const [status, setStatus] = useState<TelegramChannelStatus>(DISCONNECTED);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Aborts the in-flight status fetch on unmount / reload (mirrors use-agents).
  const abortRef = useRef<AbortController | null>(null);
  // Guard against setting state after unmount (the load is async).
  const mountedRef = useRef(true);
  // Monotonic request id: only the newest load may write state, so a fast
  // reload (or an agent-prop change) can never land a stale status after a
  // newer one resolved — the non-cancellable-fetch analogue of use-agents.
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
        // getTelegramChannel already maps a 404 (feature dark / no connection)
        // to a disconnected status, so a dark feature is NOT an error here.
        const res = await api.getTelegramChannel(agent);
        if (!fresh()) return;
        setStatus(res && typeof res === 'object' ? res : DISCONNECTED);
      } catch (err) {
        if (!fresh()) return;
        // Any non-404 failure (401 signed-out, network, 5xx) is a real error;
        // keep the last known status intact and surface the message.
        setError(
          err instanceof Error ? err.message : 'Failed to load the channel.'
        );
      } finally {
        // Only the current request clears the spinner (a superseded load must
        // not flip loading off under a newer one).
        if (mountedRef.current && reqId === reqIdRef.current) {
          setLoading(false);
        }
      }
    })();
  }, [agent]);

  const reload = useCallback(() => {
    load();
  }, [load]);

  const connect = useCallback(
    async (token: string) => {
      setConnecting(true);
      setError(null);
      try {
        await api.connectTelegram(agent, token);
        // Re-read the authoritative status (botUsername + connectedAt) rather
        // than trusting the connect envelope alone, so the card renders the
        // same shape as a fresh load.
        if (mountedRef.current) reload();
      } catch (err) {
        if (mountedRef.current) {
          setError(
            err instanceof Error ? err.message : 'Could not connect the bot.'
          );
        }
        // Re-throw so the caller (the card) can branch on the failure too.
        throw err;
      } finally {
        if (mountedRef.current) setConnecting(false);
      }
    },
    [agent, reload]
  );

  const disconnect = useCallback(async () => {
    setError(null);
    try {
      await api.disconnectTelegram(agent);
      if (mountedRef.current) reload();
    } catch (err) {
      if (mountedRef.current) {
        setError(
          err instanceof Error ? err.message : 'Could not disconnect the bot.'
        );
      }
      throw err;
    }
  }, [agent, reload]);

  const test = useCallback(async () => {
    setError(null);
    try {
      return await api.testTelegram(agent);
    } catch (err) {
      if (mountedRef.current) {
        setError(
          err instanceof Error ? err.message : 'Could not send a test message.'
        );
      }
      throw err;
    }
  }, [agent]);

  // Load on mount and whenever the agent prop changes; abort the in-flight
  // fetch on cleanup. `load` is stable per-agent, so this refetches on switch.
  useEffect(() => {
    load();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [load]);

  return {
    status,
    loading,
    error,
    connecting,
    connect,
    disconnect,
    test,
    reload,
  };
}
