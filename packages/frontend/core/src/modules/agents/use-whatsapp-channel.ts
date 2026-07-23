import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from './api';
import { AgentApiError } from './api';
import type { WhatsAppChannelStatus, WhatsAppPairResult } from './api';
import type { AgentName } from './types';

/**
 * React hook that owns the per-user, per-agent WHATSAPP CHANNEL (R16 pair-by-
 * code). It is the WhatsApp analogue of {@link useTelegramChannel} in
 * use-channels.ts — same lifecycle (status probe → connect → connected →
 * test / disconnect), same abort/reqId/mounted guards — but WhatsApp pairs by an
 * 8-char CODE rather than a bot token: the user gives their store's phone number,
 * the gateway mints a short-TTL code, and the user types it into WhatsApp >
 * Linked Devices > "Link with phone number". A QR is deliberately NOT used
 * (WhatsApp's link-QR rotates ~30s and can't be surfaced statically).
 *
 * The pairing FACE therefore adds a poll loop the Telegram card doesn't need:
 * once a code is issued the hook polls `GET .../channels/whatsapp` every 3s and
 * flips to connected when the gateway reports the device linked, hard-stopping at
 * 90s (⇒ `expired`, the "code expiré, renvoie un code" state). The poll is
 * R13-safe: ONE in-flight request (an AbortController aborts the prior), a
 * monotonic reqId drops any superseded response, a mounted guard blocks writes
 * after teardown, and the `setInterval` is cleared on connected / unmount /
 * timeout / re-issue. There is NO background poll when dark / idle / connected.
 *
 * Like {@link api.getWhatsappChannel} (which maps a 404 → a disconnected status),
 * this hook treats a dark feature as simply "not connected" rather than an error
 * — so the card shows a quiet "bientôt" / not-connected state instead of a red
 * failure. Real failures (401 signed-out, network, 5xx) surface via `error`.
 * Plain-React shape (useState/useCallback/useRef, no DI framework), exactly like
 * the neighboring use-channels / use-agents hooks.
 */

/** A disconnected status — the safe default before the first load and on a dark (404) feature. */
const DISCONNECTED: WhatsAppChannelStatus = { connected: false };

/** Poll cadence (ms) while a pairing code is live. */
const POLL_INTERVAL_MS = 3000;
/** Hard stop for the pairing poll (ms) — after this the code is treated as expired. */
const POLL_TIMEOUT_MS = 90000;

/** What {@link useWhatsappChannel} exposes to the WhatsApp channel card. */
export interface UseWhatsappChannel {
  /** The current channel status ({@link DISCONNECTED} until loaded / when dark). */
  status: WhatsAppChannelStatus;
  /** True while the status is being (re)loaded (the initial probe). */
  loading: boolean;
  /** Last error message, or null. Cleared at the start of each load / action. */
  error: string | null;
  /** True while a {@link pair} / {@link reissue} mint call is in flight (the connecting spinner). */
  connecting: boolean;
  /** True while a pairing code is live and the status poll is running. */
  pairing: boolean;
  /** True when the pairing poll hit its 90s hard-stop without linking (⇒ "code expiré"). */
  expired: boolean;
  /** The raw 8-char pairing code currently shown, or null. */
  code: string | null;
  /** The display-formatted code (e.g. `ABCD-EFGH`) currently shown, or null. */
  formatted: string | null;
  /**
   * Connect the store's WhatsApp number to this agent: mints a pairing code and
   * starts the 3s/90s poll. Resolves with the {@link WhatsAppPairResult} (so the
   * card can branch); rejects with the typed {@link AgentApiError} on failure
   * (also recorded in `error`). A `status:'retry'` envelope is resolved by auto
   * re-calling `pair()` (the gateway session wasn't ready yet).
   */
  pair: (phoneNumber: string) => Promise<WhatsAppPairResult>;
  /**
   * Re-issue a fresh code for the SAME already-entered number (the "Renvoyer un
   * code" button): re-calls the pair route, resets the TTL + restarts the poll.
   * Rejects with the typed error on failure.
   */
  reissue: () => Promise<WhatsAppPairResult>;
  /** Cancel the current pairing (stop the poll, clear the code) — back to idle. */
  stopPairing: () => void;
  /** Disconnect the number (drop the linked device + binding), then reload the status. */
  disconnect: () => Promise<void>;
  /**
   * Send a test message to the linked number. Returns the `{ ok, sent }` envelope
   * so the card can tell the user whether a message actually went out
   * (`sent:false` ⇒ "retry in a moment"). Throws on a transport/HTTP failure
   * (also recorded in `error`).
   */
  test: () => Promise<{ ok: boolean; sent: boolean; note?: string }>;
  /** Re-fetch the status (aborts any in-flight load first). */
  reload: () => void;
}

export function useWhatsappChannel(agent: AgentName): UseWhatsappChannel {
  const [status, setStatus] = useState<WhatsAppChannelStatus>(DISCONNECTED);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [expired, setExpired] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [formatted, setFormatted] = useState<string | null>(null);

  // Aborts the in-flight status fetch on unmount / reload (mirrors use-channels).
  const abortRef = useRef<AbortController | null>(null);
  // Guard against setting state after unmount (the load is async).
  const mountedRef = useRef(true);
  // Monotonic request id: only the newest load may write state, so a fast reload
  // (or an agent-prop change) can never land a stale status after a newer one
  // resolved — the non-cancellable-fetch analogue of use-channels.
  const reqIdRef = useRef(0);
  // The pairing poll interval + its wall-clock deadline. One interval at a time;
  // cleared on connected / unmount / timeout / re-issue (R13-safe, no leak).
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadlineRef = useRef(0);
  // The number the user entered, kept so `reissue()` can re-mint for it.
  const phoneRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Stop + clear the pairing poll interval (idempotent). Does NOT clear the shown
  // code — callers decide whether to also reset the code (stopPairing does).
  const clearPoll = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Fully cancel pairing: stop the poll and drop the code back to idle.
  const stopPairing = useCallback(() => {
    clearPoll();
    if (mountedRef.current) {
      setPairing(false);
      setExpired(false);
      setCode(null);
      setFormatted(null);
    }
  }, [clearPoll]);

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
        // getWhatsappChannel already maps a 404 (feature dark / no connection) to
        // a disconnected status, so a dark feature is NOT an error here.
        const res = await api.getWhatsappChannel(agent);
        if (!fresh()) return;
        setStatus(res && typeof res === 'object' ? res : DISCONNECTED);
        // If the authoritative status now says connected, tear down any pairing
        // UI (the poll below also does this, but a manual reload should too).
        if (res && res.connected) {
          clearPoll();
          setPairing(false);
          setExpired(false);
          setCode(null);
          setFormatted(null);
        }
      } catch (err) {
        if (!fresh()) return;
        // Any non-404 failure (401 signed-out, network, 5xx) is a real error;
        // keep the last known status intact and surface the message.
        setError(
          err instanceof Error ? err.message : 'Failed to load the channel.'
        );
      } finally {
        if (mountedRef.current && reqId === reqIdRef.current) {
          setLoading(false);
        }
      }
    })();
  }, [agent, clearPoll]);

  const reload = useCallback(() => {
    load();
  }, [load]);

  // One poll tick: re-read the status; on `connected` stop the poll + flip the
  // card to the connected face; on deadline stop + mark expired. A wrong-state /
  // not-linked-yet read just continues (stay in pairing, keep "en attente…").
  const pollOnce = useCallback(() => {
    if (!mountedRef.current) {
      clearPoll();
      return;
    }
    // Deadline check first — a 90s hard stop → "code expiré".
    if (Date.now() >= pollDeadlineRef.current) {
      clearPoll();
      if (mountedRef.current) {
        setPairing(false);
        setExpired(true);
      }
      return;
    }
    // Abort any prior in-flight status read so only one poll request is live.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const reqId = ++reqIdRef.current;
    const fresh = () =>
      mountedRef.current &&
      reqId === reqIdRef.current &&
      !controller.signal.aborted;
    void (async () => {
      try {
        const res = await api.getWhatsappChannel(agent);
        if (!fresh()) return;
        if (res && typeof res === 'object') setStatus(res);
        if (res && res.connected) {
          // Linked — stop polling and collapse the pairing UI to connected.
          clearPoll();
          setPairing(false);
          setExpired(false);
          setCode(null);
          setFormatted(null);
        }
      } catch {
        // A transient poll failure is non-fatal: keep waiting (the next tick
        // retries). We never surface a red error mid-pairing — the design keeps
        // the "en attente…" face until the deadline.
      }
    })();
  }, [agent, clearPoll]);

  // Start (or restart) the pairing poll: sets a fresh 90s deadline and a 3s
  // interval. Clears any prior interval first (re-issue restarts cleanly).
  const startPoll = useCallback(() => {
    clearPoll();
    pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
    if (mountedRef.current) {
      setPairing(true);
      setExpired(false);
    }
    pollRef.current = setInterval(pollOnce, POLL_INTERVAL_MS);
  }, [clearPoll, pollOnce]);

  // Shared mint routine used by both pair(phone) and reissue(). `phoneNumber`
  // null ⇒ re-issue for the already-stored number (pairWhatsapp); a value ⇒
  // connect a freshly-entered number (connectWhatsapp). Handles the gateway's
  // `status:'retry'` by re-calling pairWhatsapp once (session not ready yet).
  const mint = useCallback(
    async (phoneNumber: string | null): Promise<WhatsAppPairResult> => {
      setConnecting(true);
      setError(null);
      setExpired(false);
      try {
        let res: WhatsAppPairResult =
          phoneNumber !== null
            ? await api.connectWhatsapp(agent, phoneNumber)
            : await api.pairWhatsapp(agent);
        // `status:'retry'` (or a code-less ok) ⇒ the pairing session wasn't
        // ready; re-call pair() ONCE to get the live code (mirrors the design).
        if (res && res.status === 'retry') {
          res = await api.pairWhatsapp(agent);
        }
        if (mountedRef.current && res && typeof res === 'object') {
          setCode(res.code ?? null);
          setFormatted(res.formatted ?? res.code ?? null);
          // A code in hand ⇒ start the poll; a still-retry envelope keeps the
          // pairing spinner up and lets the user re-issue.
          startPoll();
        }
        return res;
      } catch (err) {
        if (mountedRef.current) {
          setError(
            err instanceof Error ? err.message : 'Could not start pairing.'
          );
        }
        // Re-throw so the card can branch on AgentApiError.status for the copy.
        throw err;
      } finally {
        if (mountedRef.current) setConnecting(false);
      }
    },
    [agent, startPoll]
  );

  const pair = useCallback(
    (phoneNumber: string) => {
      phoneRef.current = phoneNumber;
      return mint(phoneNumber);
    },
    [mint]
  );

  const reissue = useCallback(() => {
    // Re-issue for the same number: the backend pair route re-mints from the
    // stored binding, so we pass null (no re-connect) and let it reset the TTL.
    return mint(null);
  }, [mint]);

  const disconnect = useCallback(async () => {
    setError(null);
    stopPairing();
    try {
      await api.disconnectWhatsapp(agent);
      if (mountedRef.current) reload();
    } catch (err) {
      if (mountedRef.current) {
        setError(
          err instanceof Error ? err.message : 'Could not disconnect.'
        );
      }
      throw err;
    }
  }, [agent, reload, stopPairing]);

  const test = useCallback(async () => {
    setError(null);
    try {
      return await api.testWhatsapp(agent);
    } catch (err) {
      if (mountedRef.current) {
        setError(
          err instanceof Error ? err.message : 'Could not send a test message.'
        );
      }
      throw err;
    }
  }, [agent]);

  // Load on mount and whenever the agent prop changes; abort the in-flight fetch
  // AND clear any pairing poll on cleanup. `load` is stable per-agent, so this
  // refetches on switch and never leaks an interval across an agent change.
  useEffect(() => {
    load();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [load]);

  return {
    status,
    loading,
    error,
    connecting,
    pairing,
    expired,
    code,
    formatted,
    pair,
    reissue,
    stopPairing,
    disconnect,
    test,
    reload,
  };
}
