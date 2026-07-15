import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * ClickDz Pulse — the "reasoning animation" hook.
 *
 * While the real (slow) generation model handles a request, this hook fetches a
 * handful of FAST, request-tailored "reasoning-like" status lines from the
 * backend and reveals them one-by-one on a timer, so the user watches an expert
 * "think aloud" about THEIR request instead of staring at a bare spinner. It
 * powers ALL AI generations (image / text / apps / videos) — the caller just
 * picks a `surface`.
 *
 *   const pulse = useAiPulse();
 *   pulse.start('20s dark promo for a running shoe called AERO', 'video');
 *   // …render <AiPulseTicker line={pulse.currentLine} active={!pulse.done} />…
 *   pulse.stop(); // when the real response arrives (or on unmount)
 *
 * Wiring rules (identical to useVdzCompose): the route goes through
 * cdzApiUrl(...) so desktop/native builds resolve it against the connected
 * server; on web it's a no-op (same origin). The backend ALWAYS returns 200 with
 * at least a generic fallback array, and this hook degrades further to its own
 * built-in generic lines if even that request fails — so the animation can never
 * break the caller's busy UI.
 */

const PULSE_URL = '/api/v1/ai/pulse';

/** The four generation surfaces the ticker can decorate. */
export type PulseSurface = 'video' | 'app' | 'image' | 'chat';

// Reveal cadence: each line holds for a base duration plus a little jitter, so
// the animation feels organic rather than metronomic. Tuned to 1.8–3.0s.
const LINE_BASE_MS = 1_800;
const LINE_JITTER_MS = 1_200;
// Once the real request outlives the script, we loop the LAST N lines so the
// tail reads as "still working" rather than repeating the whole preamble.
const TAIL_LOOP_COUNT = 3;
// Client-side safety timeout on the fetch itself (the server caps at 8s; give a
// little headroom for transport, then fall back to generic lines).
const FETCH_TIMEOUT_MS = 9_000;
// Cap task length client-side too, matching the server's ≤2k contract.
const MAX_TASK_CHARS = 2_000;

/**
 * Local generic fallback, used only if the /api/v1/ai/pulse request itself
 * fails (network/parse) — normally the server supplies tailored or fallback
 * lines. Kept short and surface-neutral.
 */
const LOCAL_FALLBACK: Record<PulseSurface, string[]> = {
  video: [
    'Reading your brief…',
    'Blocking out the scenes…',
    'Choosing a palette and mood…',
    'Timing the transitions…',
    'Polishing the final frames…',
  ],
  app: [
    'Understanding what you need…',
    'Sketching the layout…',
    'Wiring up the interactions…',
    'Styling for a clean finish…',
    'Assembling the final build…',
  ],
  image: [
    'Reading your description…',
    'Framing the composition…',
    'Choosing lighting and palette…',
    'Refining subject and detail…',
    'Rendering the final image…',
  ],
  chat: [
    'Thinking about your request…',
    'Gathering the key points…',
    'Structuring a clear answer…',
    'Drafting the response…',
    'Refining the wording…',
  ],
};

/** A small jittered per-line hold, in ms. */
function lineDelay(): number {
  return LINE_BASE_MS + Math.floor(Math.random() * LINE_JITTER_MS);
}

export interface UseAiPulse {
  /** The line currently on screen ('' before start / after stop). */
  currentLine: string;
  /**
   * true once the reveal has walked past the last scripted line (the hook then
   * loops the tail). Callers can use it to soften the ticker, but the ticker
   * keeps animating until `stop()`.
   */
  done: boolean;
  /** true between start() and stop() — the animation is live. */
  active: boolean;
  /**
   * Begin a reasoning animation for `task` on `surface`. Safe to call again to
   * restart with a new task; any prior run is cancelled first.
   */
  start: (task: string, surface: PulseSurface) => void;
  /** Stop and reset the animation (call when the real response arrives). */
  stop: () => void;
}

export function useAiPulse(): UseAiPulse {
  const [currentLine, setCurrentLine] = useState('');
  const [done, setDone] = useState(false);
  const [active, setActive] = useState(false);

  // The full script once fetched, and where in it we are.
  const linesRef = useRef<string[]>([]);
  const indexRef = useRef(0);
  // Timers / lifecycle guards. `runIdRef` invalidates in-flight fetches and
  // timers from a superseded start() call (last-call-wins).
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runIdRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    runIdRef.current += 1; // invalidate any pending fetch/timer callbacks
    clearTimer();
    linesRef.current = [];
    indexRef.current = 0;
    setCurrentLine('');
    setDone(false);
    setActive(false);
  }, [clearTimer]);

  // Advance to the next line; once past the end, loop the tail so the animation
  // keeps "thinking" for as long as the real request runs.
  const scheduleNext = useCallback(
    (runId: number) => {
      const step = () => {
        if (runId !== runIdRef.current) return;
        const lines = linesRef.current;
        if (!lines.length) return;
        const next = indexRef.current + 1;
        if (next < lines.length) {
          indexRef.current = next;
          setCurrentLine(lines[next]);
        } else {
          // Past the end — mark done and loop within the last TAIL_LOOP_COUNT.
          setDone(true);
          const tailStart = Math.max(0, lines.length - TAIL_LOOP_COUNT);
          const span = lines.length - tailStart;
          const looped = tailStart + ((next - tailStart) % span);
          indexRef.current = next; // keep counting so the modulo keeps moving
          setCurrentLine(lines[looped]);
        }
        timerRef.current = setTimeout(step, lineDelay());
      };
      timerRef.current = setTimeout(step, lineDelay());
    },
    []
  );

  // Kick off the reveal from a resolved script (tailored, server-fallback, or
  // local-fallback). Shows the first line immediately, then times the rest.
  const beginReveal = useCallback(
    (runId: number, lines: string[]) => {
      if (runId !== runIdRef.current) return;
      if (!lines.length) return;
      linesRef.current = lines;
      indexRef.current = 0;
      setCurrentLine(lines[0]);
      setDone(lines.length === 1);
      scheduleNext(runId);
    },
    [scheduleNext]
  );

  const start = useCallback(
    (task: string, surface: PulseSurface) => {
      // Cancel any prior run and take a fresh run id (last-call-wins).
      clearTimer();
      const runId = ++runIdRef.current;
      linesRef.current = [];
      indexRef.current = 0;
      setDone(false);
      setActive(true);
      setCurrentLine('');

      const trimmed = (task || '').replace(/\s+/g, ' ').trim().slice(
        0,
        MAX_TASK_CHARS
      );
      const localFallback = LOCAL_FALLBACK[surface] ?? LOCAL_FALLBACK.chat;

      // Fetch the tailored lines, but DON'T make the animation wait on the
      // network to appear: show a local fallback immediately, then swap in the
      // real script when it lands (if this run is still current and we haven't
      // moved far). If the fetch fails, we simply keep the local fallback.
      beginReveal(runId, localFallback);

      void (async () => {
        let lines: string[] | null = null;
        // Manual AbortController + timeout (established pattern in this repo;
        // avoids depending on AbortSignal.timeout in older embedded runtimes).
        const ac = new AbortController();
        const abortTimer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(cdzApiUrl(PULSE_URL), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task: trimmed, surface }),
            signal: ac.signal,
          });
          if (res.ok) {
            const data = (await res.json()) as { lines?: unknown };
            if (Array.isArray(data?.lines)) {
              const clean = data.lines
                .filter((l): l is string => typeof l === 'string')
                .map(l => l.trim())
                .filter(Boolean);
              if (clean.length) lines = clean;
            }
          }
        } catch {
          // keep the local fallback already playing
        } finally {
          clearTimeout(abortTimer);
        }
        if (runId !== runIdRef.current || !lines) return;
        // Only swap in the richer script if we're still early in the fallback
        // (first couple of lines) — otherwise a late swap would visibly jump.
        if (indexRef.current <= 1) {
          clearTimer();
          beginReveal(runId, lines);
        } else {
          // We're deep in the fallback; just replace the remaining tail source
          // so the loop-at-end uses the tailored lines.
          linesRef.current = lines;
        }
      })();
    },
    [beginReveal, clearTimer]
  );

  // Clean up on unmount.
  useEffect(() => stop, [stop]);

  return { currentLine, done, active, start, stop };
}
