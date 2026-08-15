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

export type StickerGenerateFail = 'error' | 'aiUnavailable' | 'emptyPrompt';

export interface StickerGenerateResult {
  blob: Blob | null;
  fail: StickerGenerateFail | null;
}

interface ImageGenResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string };
  message?: string;
}

export interface GenerateStickerParams {
  /** The subject prompt (e.g. "a smiling avocado"). */
  prompt: string;
  /** Override the image tier (defaults to the recommended Gemini sticker tier). */
  model?: string;
  size?: string;
}

/**
 * Generate a sticker image via the bridge. Never throws — always resolves to a
 * typed result so callers (toolbar `run`, panels) can toast a friendly message.
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

  try {
    const response = await fetch(cdzApiUrl('/api/v1/images/generations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Route is NOT @Public — authenticates via the session cookie.
      credentials: 'include',
      body: JSON.stringify(payload),
    });

    const data = (await response
      .json()
      .catch(() => null)) as ImageGenResponse | null;

    if (!response.ok) {
      // 503 = image key not configured → treat AI as unavailable.
      return {
        blob: null,
        fail: response.status === 503 ? 'aiUnavailable' : 'error',
      };
    }

    const url = data?.data?.[0]?.url;
    if (typeof url !== 'string' || !url) return { blob: null, fail: 'error' };

    const imgResp = await fetch(url);
    if (!imgResp.ok) return { blob: null, fail: 'error' };
    return { blob: await imgResp.blob(), fail: null };
  } catch {
    // Network / abort / anything unexpected — never throw past this function.
    return { blob: null, fail: 'aiUnavailable' };
  }
}
