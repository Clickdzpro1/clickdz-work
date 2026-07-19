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
const POLL_INTERVAL_MS = 1500;
// Safety ceiling on polling — the service caps a render well under this.
const MAX_POLLS = 400; // ~10 min at 1.5s

export type VdzExportStatus =
  | 'idle'
  | 'starting'
  | 'rendering'
  | 'done'
  | 'error'
  | 'unavailable';

interface RenderStatusBody {
  status?: string;
  progress?: unknown;
  error?: string;
  size?: unknown;
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
      const cap = Number.isFinite(maxSec) && maxSec > 0 ? maxSec : 300;
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
   * Kick off a render for the given composition HTML. `extra` is an OPTIONAL,
   * additive set of fields merged into the POST body. The timeline export hook
   * uses it to send the C2 render-request fields — `engine`, `width`, `height`,
   * `fps`, `durationSec` (and, for the Remotion engine, `manifest`) — alongside
   * the html. When omitted the body is exactly `{ html }` (unchanged behavior),
   * and the server applies its own defaults.
   */
  start: (html: string, extra?: Record<string, unknown>) => Promise<void>;
  /** Reset back to idle (e.g. when the composition changes). */
  reset: () => void;
}

export function useVdzExport(): UseVdzExport {
  const [status, setStatus] = useState<VdzExportStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);

  // Guards against setting state after unmount / across a reset.
  const activeRef = useRef(0);

  const reset = useCallback(() => {
    activeRef.current++; // invalidate any in-flight poll loop
    setStatus('idle');
    setProgress(0);
    setError(null);
    setFileUrl(null);
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
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      if (activeRef.current !== token) return; // superseded / unmounted

      let body: RenderStatusBody;
      try {
        const res = await fetch(cdzApiUrl(statusUrl), { method: 'GET' });
        if (!res.ok) throw new Error(await readError(res));
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

      if (body?.status === 'done') {
        if (activeRef.current === token) {
          setProgress(1);
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
    start,
    reset,
  };
}
