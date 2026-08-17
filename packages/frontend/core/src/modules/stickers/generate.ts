// modules/stickers/generate.ts
//
// WS14 — AI sticker GENERATOR (Prodia Flux Schnell via Vercel AI Gateway).
//
// Calls the bridge image route (POST /api/v1/images/generations,
// clickdz-bridge.controller.ts imageGenerations()) with a transparent / die-cut
// sticker prompt, and returns the resulting image as a Blob ready to hand to
// `ingestStickerAsset` + `addSticker(std, sourceId, 'static', …)`.
//
// Transport is a 1:1 mirror of modules/vpic/use-vpic-generate.ts (the verified
// generation path): JSON body, session-cookie auth, response normalized to
// `data[0].url` (a data: URL). We add ONLY the sticker-specific prompt suffix.
// WS14: tier switched to Prodia Flux Schnell (cdzimage-flux) — ~$0.001-0.0025/img
// (33-67x cheaper than Gemini), good die-cut quality for vector-style stickers.

import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';

/**
 * Recommended default image tier for stickers.
 *
 * WS14: switched from cdzimage-1.0 (gpt-image-1-mini) to cdzimage-flux
 * (Prodia Flux Schnell via Vercel AI Gateway). ~$0.001-0.0025/img.
 */
export const STICKER_IMAGE_MODEL = 'cdzimage-flux';

/** Square sticker canvas — matches the sticker block's default 96×96 aspect. */
export const STICKER_IMAGE_SIZE = '1024x1024';

/**
 * Appended to the user's subject so the model returns a clean, isolated
 * sticker. Transparent background + thick contour is what makes it read as a
 * sticker (and lets the sticker block's drop-shadow sit on the die-cut edge).
 */
const STICKER_PROMPT_SUFFIX =
  ', as a die-cut sticker, bold clean vector illustration, thick white contour border, centered subject, transparent background, no drop shadow, high contrast, crisp edges';

export type StickerGenerateFail =
  | 'error'
  | 'aiUnavailable'
  | 'emptyPrompt'
  | 'timeout'
  | 'rateLimited';

export interface StickerGenerateResult {
  blob: Blob | null;
  fail: StickerGenerateFail | null;
}

/**
 * Bounded client budget for a sticker generation. Flux Schnell is fast
 * (typically < 15s), but a hung provider / gateway must not spin forever — an
 * unbounded wait reads to the user as "not working at all". We abort at this
 * ceiling and surface a clear `timeout` so the caller can toast + let the user
 * retry, instead of an indefinite spinner.
 */
const STICKER_GENERATE_TIMEOUT_MS = 60_000;

interface ImageGenResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string };
  message?: string;
}

export interface GenerateStickerParams {
  /** The subject prompt (e.g. "a smiling avocado"). */
  prompt: string;
  /** Override the image tier (defaults to STICKER_IMAGE_MODEL = cdzimage-flux). */
  model?: string;
  size?: string;
}

/** A transient failure is worth one automatic retry; a definite one is not. */
function isTransient(fail: StickerGenerateFail | null): boolean {
  return fail === 'timeout' || fail === 'aiUnavailable';
}

/**
 * ONE generation attempt. Bounded by an AbortController so a hung provider
 * resolves to a typed `timeout` instead of hanging forever. Never throws.
 */
async function generateStickerImageOnce(
  payload: Record<string, unknown>
): Promise<StickerGenerateResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    STICKER_GENERATE_TIMEOUT_MS
  );
  try {
    const response = await fetch(cdzApiUrl('/api/v1/images/generations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Route is NOT @Public — authenticates via the session cookie.
      credentials: 'include',
      signal: controller.signal,
      body: JSON.stringify(payload),
    });

    const data = (await response
      .json()
      .catch(() => null)) as ImageGenResponse | null;

    if (!response.ok) {
      // 503 = image key not configured → treat AI as unavailable.
      // 429 = per-user daily cap hit → distinct, non-retryable message.
      if (response.status === 429) return { blob: null, fail: 'rateLimited' };
      return {
        blob: null,
        fail: response.status === 503 ? 'aiUnavailable' : 'error',
      };
    }

    const url = data?.data?.[0]?.url;
    if (typeof url !== 'string' || !url) return { blob: null, fail: 'error' };

    // Fetch the (data: or https) URL back into a Blob. Same-origin data URLs
    // don't need credentials; keep it simple and abortable via the same signal.
    const imgResp = await fetch(url, { signal: controller.signal });
    if (!imgResp.ok) return { blob: null, fail: 'error' };
    const blob = await imgResp.blob();

    // Validate: a real image with non-zero bytes. A 0-byte or non-image blob
    // (e.g. an error page fetched as text) would silently place an invisible
    // sticker — surface it as an error so the user can retry instead.
    if (blob.size === 0) return { blob: null, fail: 'error' };
    if (blob.type && !blob.type.startsWith('image/')) {
      return { blob: null, fail: 'error' };
    }
    return { blob, fail: null };
  } catch (err) {
    // A deliberate abort from the bounded timeout → `timeout` (retryable);
    // any other network/unexpected throw → `aiUnavailable` (also retryable).
    if ((err as Error)?.name === 'AbortError') {
      return { blob: null, fail: 'timeout' };
    }
    return { blob: null, fail: 'aiUnavailable' };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Generate a sticker image via the bridge. Never throws — always resolves to a
 * typed result so callers (toolbar `run`, panels) can toast a friendly message.
 *
 * Robustness: bounded per-attempt timeout + ONE automatic retry on a transient
 * failure (timeout / network / gateway hiccup). Definite failures (empty
 * prompt, bad model, 503 misconfig, rate limit, non-image result) are returned
 * immediately without a wasteful second call.
 */
export async function generateStickerImage(
  params: GenerateStickerParams
): Promise<StickerGenerateResult> {
  const prompt = params.prompt.trim();
  if (!prompt) return { blob: null, fail: 'emptyPrompt' };

  const payload: Record<string, unknown> = {
    prompt: prompt + STICKER_PROMPT_SUFFIX,
    model: params.model ?? STICKER_IMAGE_MODEL,
    size: params.size ?? STICKER_IMAGE_SIZE,
    enhance: false,
  };

  let result = await generateStickerImageOnce(payload);
  if (!result.blob && isTransient(result.fail)) {
    // One retry — most Gateway/provider hiccups clear on a second attempt.
    result = await generateStickerImageOnce(payload);
  }
  return result;
}
