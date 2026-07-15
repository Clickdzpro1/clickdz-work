import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useState } from 'react';

/**
 * Vdz Studio — compose hook for the AI Video Generator.
 *
 * Wraps the two backend routes exposed by ClickDzVdzComposeController:
 *   · POST /api/v1/vdz/compose        {prompt}             -> {html}
 *   · POST /api/v1/vdz/compose/refine {html, instruction}  -> {html}
 *
 * Both URLs go through cdzApiUrl(...) so desktop/native builds (renderer origin
 * assets://. / file://) resolve them against the connected server — same rule
 * FetchService / GraphQL / SSE follow. On web this is a no-op (same origin).
 *
 * The hook owns only the request lifecycle (busy + error); the generated HTML
 * is held by the panel component so it can drive the live preview + download.
 */

const COMPOSE_URL = '/api/v1/vdz/compose';
const REFINE_URL = '/api/v1/vdz/compose/refine';

/** Shape returned by both compose routes. */
interface VdzComposeResponse {
  html?: unknown;
}

/**
 * Pull a human-readable message out of an AFFiNE typed-error JSON body, falling
 * back to a generic message. The backend emits { message, ... } (UserFriendly
 * errors) or an OpenAI-style { error: { message } } on some routes.
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

async function postJson(path: string, body: unknown): Promise<string> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error(
      cause instanceof Error && cause.message
        ? `Network error: ${cause.message}`
        : 'Network error while contacting the video generator.'
    );
  }
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  const data = (await res.json()) as VdzComposeResponse;
  const html = typeof data?.html === 'string' ? data.html : '';
  if (!html) {
    throw new Error('The generator did not return a video. Try rephrasing.');
  }
  return html;
}

export interface UseVdzCompose {
  /** true while either request is in flight. */
  busy: boolean;
  /** last error message, or null. Cleared at the start of each request. */
  error: string | null;
  /** Generate a brand-new composition from a natural-language brief. */
  compose: (prompt: string) => Promise<string>;
  /** Apply a conversational change to the current composition HTML. */
  refine: (html: string, instruction: string) => Promise<string>;
  /** Manually clear the current error (e.g. when the user edits the input). */
  clearError: () => void;
}

export function useVdzCompose(): UseVdzCompose {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compose = useCallback(async (prompt: string): Promise<string> => {
    setBusy(true);
    setError(null);
    try {
      return await postJson(COMPOSE_URL, { prompt });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Generation failed.';
      setError(message);
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const refine = useCallback(
    async (html: string, instruction: string): Promise<string> => {
      setBusy(true);
      setError(null);
      try {
        return await postJson(REFINE_URL, { html, instruction });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Refine failed.';
        setError(message);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const clearError = useCallback(() => setError(null), []);

  return { busy, error, compose, refine, clearError };
}
