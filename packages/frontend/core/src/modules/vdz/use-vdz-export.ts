import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Vdz Studio — MP4 export hook for the AI Video Generator.
 *
 * Drives the render proxy exposed by ClickDzVdzRenderController:
 *   · POST /api/v1/vdz/render          {html}   -> {jobId}
 *   · GET  /api/v1/vdz/render/:jobId            -> {status, progress, ...}
 *   · GET  /api/v1/vdz/render/:jobId/file       -> the MP4 (streamed)
 *
 * The heavy render happens on the standalone cdz-render service; this hook only
 * enqueues, polls status, and — when done — hands back the file URL so the panel
 * can offer a download link. All URLs go through cdzApiUrl(...) so desktop/native
 * builds resolve them against the connected server (same rule as compose).
 *
 * GRACEFUL DEGRADE: when the render service is unconfigured the proxy answers a
 * typed 400 ("not configured"); we surface that as `unavailable` so the UI can
 * show a "coming online soon" affordance instead of a hard error.
 */

const RENDER_URL = '/api/v1/vdz/render';
const CAPABILITIES_URL = '/api/v1/vdz/render/capabilities';
const POLL_INTERVAL_MS = 1500;
// Safety ceiling on polling — the service caps a render well under this.
const MAX_POLLS = 400; // ~10 min at 1.5s
// A mid-poll 404 ("Unknown render job") can be a transient blip between the
// worker minting the job and its status store catching up, so we tolerate a
// SMALL bounded run of them before declaring the job truly lost. Beyond this we
// surface a distinct, retry-able "the render job was lost" error.
const MAX_LOST_JOB_RETRIES = 4;

/**
 * What render engines this deployment actually offers right now (mirror of the
 * backend `GET /api/v1/vdz/render/capabilities`). `classicMaxSec` is the Classic
 * HTML tier's duration cap so the dialog can show it pre-flight.
 */
export interface VdzRenderCapabilities {
  classic: boolean;
  remotion: boolean;
  classicMaxSec: number;
}

/**
 * Conservative defaults used when the capabilities probe cannot be reached (a
 * transient network error or an older server without the route). Classic is
 * assumed available (it is the working baseline path), Remotion assumed OFF (so
 * we never present it as a working choice when we don't actually know), and the
 * cap falls back to the well-known classic ceiling (600s — mirrors the backend's
 * env-overridable CLASSIC_MAX_SEC default).
 */
export const DEFAULT_RENDER_CAPABILITIES: VdzRenderCapabilities = {
  classic: true,
  remotion: false,
  classicMaxSec: 600,
};

/**
 * Probe the render capabilities route. NEVER throws — on any transport/HTTP/
 * shape failure it resolves to {@link DEFAULT_RENDER_CAPABILITIES} so the export
 * UI degrades gracefully (classic-only) instead of erroring. Session cookie
 * rides along (`credentials: 'include'`) exactly like the other Vdz FE calls.
 */
export async function fetchRenderCapabilities(): Promise<VdzRenderCapabilities> {
  try {
    const res = await fetch(cdzApiUrl(CAPABILITIES_URL), {
      method: 'GET',
      credentials: 'include',
    });
    if (!res.ok) return DEFAULT_RENDER_CAPABILITIES;
    const data = (await res.json()) as Partial<VdzRenderCapabilities> | null;
    if (!data || typeof data !== 'object') return DEFAULT_RENDER_CAPABILITIES;
    const maxSec = Number(data.classicMaxSec);
    return {
      classic: data.classic === true,
      remotion: data.remotion === true,
      classicMaxSec:
        Number.isFinite(maxSec) && maxSec > 0
          ? maxSec
          : DEFAULT_RENDER_CAPABILITIES.classicMaxSec,
    };
  } catch {
    return DEFAULT_RENDER_CAPABILITIES;
  }
}

export type VdzExportStatus =
  | 'idle'
  | 'starting'
  | 'rendering'
  | 'done'
  | 'error'
  | 'unavailable';

/**
 * The coarse render phase, mirrored from the Remotion worker's GET /jobs/:id
 * `stage` field (additive). The Classic (HTML) tier does not report a stage, so
 * the hook leaves it `null` there and the UI falls back to a generic label.
 */
export type VdzExportStage = 'bundling' | 'rendering' | null;

interface RenderStatusBody {
  status?: string;
  progress?: unknown;
  error?: string;
  size?: unknown;
  // ADDITIVE (Remotion worker only): the coarse phase + the wall-clock render
  // start (ms epoch), so the FE can label the stage and compute an ETA.
  stage?: string;
  startedAt?: unknown;
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as any;
    // The classic tier rejects an over-length composition with a typed
    // passthrough body `{ error: 'duration_cap', maxSec, engine }` (C2). Turn
    // that machine code into an actionable sentence recommending Remotion,
    // rather than leaking the literal token to the user.
    if (data?.error === 'duration_cap') {
      const maxSec = Number(data?.maxSec);
      const cap = Number.isFinite(maxSec) && maxSec > 0 ? maxSec : 600;
      return `This timeline is longer than the ${cap}s limit for the Classic engine. Switch to Remotion (beta) to export the full length.`;
    }
    const msg =
      data?.message ??
      data?.error?.message ??
      (typeof data?.error === 'string' ? data.error : undefined);
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch {
    // fall through
  }
  return res.statusText || `Request failed (${res.status})`;
}

/**
 * Heuristic: does this 400 mean "render service not wired up on this
 * deployment"? The proxy returns exactly that phrase for the not-configured
 * precondition, so we can flip the UI into its graceful-degrade state.
 */
function looksUnconfigured(message: string): boolean {
  return /not configured/i.test(message);
}

/**
 * Heuristic: does this status response mean "the render job vanished"? The
 * status route answers an unknown job with a typed 400/404 carrying "Unknown
 * render job" (see ClickDzVdzRenderController.status). We match either the HTTP
 * 404 or that phrase so a lost job is handled distinctly from a generic error.
 */
function looksLostJob(status: number, message: string): boolean {
  return status === 404 || /unknown render job/i.test(message);
}

export interface UseVdzExport {
  status: VdzExportStatus;
  /** 0..1 render progress (meaningful while status === 'rendering'). */
  progress: number;
  /** Human-readable error, or null. */
  error: string | null;
  /** URL of the finished MP4 (download it), or null. */
  fileUrl: string | null;
  /** true when the service reported itself unconfigured (degrade the UI). */
  unavailable: boolean;
  /**
   * The coarse render phase (Remotion worker only; `null` for the Classic tier
   * or before a stage is reported). Lets the UI label what is happening instead
   * of a bare progress bar.
   */
  stage: VdzExportStage;
  /**
   * Estimated seconds remaining, or `null` when there is not enough progress to
   * compute a stable ETA (progress < 2% or no render start time). Updated each
   * poll from `elapsed / progress - elapsed`.
   */
  etaSeconds: number | null;
  /**
   * Kick off a render for the given composition HTML. `extra` is an OPTIONAL,
   * additive set of fields merged into the POST body. The timeline export hook
   * uses it to send the C2 render-request fields — `engine`, `width`, `height`,
   * `fps`, `durationSec` (and, for the Remotion engine, `manifest`) — alongside
   * the html. When omitted the body is exactly `{ html }` (unchanged behavior),
   * and the server applies its own defaults.
   */
  start: (html: string, extra?: Record<string, unknown>) => Promise<void>;
  /**
   * True when the current error is a "render job was lost" (mid-poll 404 past
   * the bounded retry). The UI can offer a one-click re-enqueue for this case
   * rather than a dead-end error.
   */
  lostJob: boolean;
  /**
   * Cancel an in-flight export (stops polling; returns to idle). Safe to call at
   * any time — a no-op when nothing is running. Distinct from {@link reset},
   * which also clears a finished/errored result.
   */
  cancel: () => void;
  /** Reset back to idle (e.g. when the composition changes). */
  reset: () => void;
}

export function useVdzExport(): UseVdzExport {
  const [status, setStatus] = useState<VdzExportStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  // Set when the failure was a lost job (mid-poll 404 past the retry budget) so
  // the UI can offer a one-click re-enqueue rather than a dead-end error.
  const [lostJob, setLostJob] = useState(false);
  // The coarse render phase (Remotion worker's `stage` field) + the ETA computed
  // from the worker's `startedAt` + progress. Both reset on start/reset/cancel.
  const [stage, setStage] = useState<VdzExportStage>(null);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);

  // Guards against setting state after unmount / across a reset.
  const activeRef = useRef(0);

  const reset = useCallback(() => {
    activeRef.current++; // invalidate any in-flight poll loop
    setStatus('idle');
    setProgress(0);
    setError(null);
    setFileUrl(null);
    setLostJob(false);
    setStage(null);
    setEtaSeconds(null);
  }, []);

  // Cancel an in-flight export: invalidate the poll loop and return to idle,
  // without carrying an error. A no-op (idempotent) when nothing is running.
  const cancel = useCallback(() => {
    activeRef.current++; // supersede any in-flight poll loop
    setStatus('idle');
    setProgress(0);
    setError(null);
    setFileUrl(null);
    setLostJob(false);
    setStage(null);
    setEtaSeconds(null);
  }, []);

  // Cancel polling on unmount.
  useEffect(() => {
    return () => {
      activeRef.current++;
    };
  }, []);

  const start = useCallback(
    async (html: string, extra?: Record<string, unknown>): Promise<void> => {
    if (!html) return;
    const token = ++activeRef.current;
    setStatus('starting');
    setProgress(0);
    setError(null);
    setFileUrl(null);
    setLostJob(false);
    setStage(null);
    setEtaSeconds(null);

    // 1) enqueue
    let jobId: string;
    try {
      const res = await fetch(cdzApiUrl(RENDER_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `{ html }` is the default body; `extra` (when present) additively adds
        // the C2 render-request fields (`engine`, `width`, `height`, `fps`,
        // `durationSec`, and — for Remotion — `manifest`). Spread AFTER html so
        // it never accidentally overwrites it.
        body: JSON.stringify({ html, ...(extra ?? {}) }),
      });
      if (!res.ok) {
        const msg = await readError(res);
        if (res.status === 400 && looksUnconfigured(msg)) {
          if (activeRef.current === token) setStatus('unavailable');
          return;
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as { jobId?: unknown };
      if (typeof data?.jobId !== 'string' || !data.jobId) {
        throw new Error('The render service did not start a job.');
      }
      jobId = data.jobId;
    } catch (e) {
      if (activeRef.current === token) {
        setStatus('error');
        setError(
          e instanceof Error && e.message
            ? e.message
            : 'Could not start the export.'
        );
      }
      return;
    }

    if (activeRef.current !== token) return;
    setStatus('rendering');

    // 2) poll status until done / error
    const statusUrl = `${RENDER_URL}/${encodeURIComponent(jobId)}`;
    // Count consecutive mid-poll "job vanished" responses; a small transient run
    // is tolerated (the worker's status store may lag the enqueue), but past the
    // budget we surface a distinct, retry-able lost-job error.
    let lostStreak = 0;
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      if (activeRef.current !== token) return; // superseded / unmounted

      let body: RenderStatusBody;
      try {
        const res = await fetch(cdzApiUrl(statusUrl), { method: 'GET' });
        if (!res.ok) {
          const msg = await readError(res);
          // A mid-poll 404 / "Unknown render job" is a distinct, actionable
          // case: the job was lost. Retry a bounded number of times (it may be
          // a transient lag) before failing with a retry-able lost-job error.
          if (looksLostJob(res.status, msg)) {
            lostStreak += 1;
            if (lostStreak <= MAX_LOST_JOB_RETRIES) {
              continue; // tolerate the blip; poll again next tick
            }
            if (activeRef.current === token) {
              setStatus('error');
              setLostJob(true);
              setError('The render job was lost. Please try exporting again.');
            }
            return;
          }
          throw new Error(msg);
        }
        lostStreak = 0; // a good status resets the tolerance window
        body = (await res.json()) as RenderStatusBody;
      } catch (e) {
        if (activeRef.current === token) {
          setStatus('error');
          setError(
            e instanceof Error && e.message ? e.message : 'Lost the render job.'
          );
        }
        return;
      }

      const p = Number(body?.progress);
      if (Number.isFinite(p)) setProgress(Math.max(0, Math.min(1, p)));

      // ADDITIVE (Remotion worker): thread the coarse stage + compute an ETA
      // from the worker's startedAt + progress. The Classic tier sends neither,
      // so stage stays null and no ETA is shown (the UI falls back to a generic
      // "rendering" label + bare percentage).
      const rawStage = typeof body?.stage === 'string' ? body.stage : null;
      if (rawStage === 'bundling' || rawStage === 'rendering') {
        if (activeRef.current === token) setStage(rawStage);
      }
      const startedAtMs = Number(body?.startedAt);
      if (
        activeRef.current === token &&
        Number.isFinite(startedAtMs) &&
        startedAtMs > 0 &&
        p > 0.02
      ) {
        const elapsedSec = (Date.now() - startedAtMs) / 1000;
        if (elapsedSec > 0) {
          const total = elapsedSec / p;
          setEtaSeconds(Math.max(0, total - elapsedSec));
        }
      } else if (activeRef.current === token && p <= 0.02) {
        setEtaSeconds(null);
      }

      if (body?.status === 'done') {
        if (activeRef.current === token) {
          setProgress(1);
          setEtaSeconds(0);
          setFileUrl(cdzApiUrl(`${statusUrl}/file`));
          setStatus('done');
        }
        return;
      }
      if (body?.status === 'error') {
        if (activeRef.current === token) {
          setStatus('error');
          setError(body?.error || 'The render failed.');
        }
        return;
      }
    }

    if (activeRef.current === token) {
      setStatus('error');
      setError('The export took too long. Please try again.');
    }
  }, []);

  return {
    status,
    progress,
    error,
    fileUrl,
    unavailable: status === 'unavailable',
    lostJob,
    stage,
    etaSeconds,
    start,
    cancel,
    reset,
  };
}
