// modules/vpic/use-vpic-generate.ts
//
// VPIC — text-to-image GENERATE hook.
//
// Encapsulates the ONE network call the new generate panel makes: a POST to the
// ALREADY-EXISTING backend route `POST /api/v1/images/generations`
// (clickdz-bridge.controller.ts imageGenerations()). It is the SAME route the
// generative-fill mask panel uses (see vpic/mask-panel.tsx) — the difference is
// this call OMITS `image`/`mask`, which selects the backend's text-to-image
// GENERATION branch instead of the edit (image-to-image) branch.
//
// === Request format (verified against mask-panel.tsx, DO NOT drift) =========
//   Route:  POST /api/v1/images/generations   (JSON, NOT multipart)
//   Auth:   the global session cookie — the route is NOT @Public — so we send
//           `credentials: 'include'` and let cdzApiUrl() resolve the connected
//           server origin (no-op on web/same-origin).
//   Body (generation):
//     - prompt : the non-empty text prompt.
//     - model  : an explicit CDZIMAGE tier id (e.g. 'cdzimage-2.0'). Sending one
//                is future-proof if CDZIMAGE_REQUIRE_MODEL flips on; the mask
//                panel already does this.
//     - size   : one of the fixed gpt-image sizes ('1024x1024', '1024x1536',
//                '1536x1024').
//     - enhance: prompt-pro toggle (backend enhances tier-id prompts unless
//                enhance:false).
//     * NO `image` and NO `mode:'edit'` → the text-to-image generation branch.
//   Response: the backend normalizes b64_json → a `data:` URL, so
//   `data.data[0].url` is always present on success.
//
// Fail-soft: every failure path resolves to a typed result (never throws past
// this hook), so the panel can map it to a pinned, translated message.

import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useState } from 'react';

/** The three CDZIMAGE tiers (labels are proper nouns, not translated). */
export const CDZIMAGE_TIERS = [
  { id: 'cdzimage-2.0', label: 'CDZIMAGE 2.0' },
  { id: 'cdzimage-1.5', label: 'CDZIMAGE 1.5' },
  { id: 'cdzimage-1.0', label: 'CDZIMAGE 1.0' },
] as const;

export type CdzImageTier = (typeof CDZIMAGE_TIERS)[number]['id'];

/** The fixed gpt-image size set the generation branch accepts. */
export const CDZIMAGE_SIZES = [
  { id: '1024x1024', label: '1:1' },
  { id: '1024x1536', label: '2:3' },
  { id: '1536x1024', label: '3:2' },
] as const;

export type CdzImageSize = (typeof CDZIMAGE_SIZES)[number]['id'];

/** Which typed, translated message to surface (all keys are pinned in i18n). */
export type VpicGenerateFail = null | 'error' | 'aiUnavailable';

export interface VpicGenerateParams {
  prompt: string;
  model?: CdzImageTier;
  size?: CdzImageSize;
  enhance?: boolean;
}

/** Minimal shape of the /images/generations JSON response we consume. */
interface ImageGenResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string };
  message?: string;
}

export interface UseVpicGenerate {
  /** True while a generation request is in flight. */
  working: boolean;
  /** The last typed failure (null when none). */
  fail: VpicGenerateFail;
  /** Clear the current failure (e.g. when the user edits the prompt). */
  clearFail: () => void;
  /**
   * Run a text-to-image generation. Resolves to the resulting image `Blob` on
   * success, or `null` on failure (with {@link fail} set to a typed reason).
   * Never throws.
   */
  generate: (params: VpicGenerateParams) => Promise<Blob | null>;
}

const DEFAULT_TIER: CdzImageTier = 'cdzimage-2.0';
const DEFAULT_SIZE: CdzImageSize = '1024x1024';

/**
 * React hook wrapping the text-to-image generation call. Provider-free and
 * dependency-free (only `react` + the shared `cdzApiUrl`). Mirrors the mask
 * panel's transport 1:1 so behaviour stays uniform across VPIC.
 */
export function useVpicGenerate(): UseVpicGenerate {
  const [working, setWorking] = useState(false);
  const [fail, setFail] = useState<VpicGenerateFail>(null);

  const clearFail = useCallback(() => setFail(null), []);

  const generate = useCallback(
    async (params: VpicGenerateParams): Promise<Blob | null> => {
      // Guard: don't double-fire while a request is in flight.
      if (working) return null;

      const prompt = params.prompt.trim();
      if (!prompt) {
        setFail('error');
        return null;
      }

      setFail(null);
      setWorking(true);
      try {
        // JSON body — matches clickdz-bridge.controller.ts imageGenerations().
        // NO `image` field → the text-to-image generation branch. `model` is an
        // explicit CDZIMAGE tier; `enhance` toggles prompt-pro server-side.
        const payload: Record<string, unknown> = {
          prompt,
          model: params.model ?? DEFAULT_TIER,
          size: params.size ?? DEFAULT_SIZE,
          enhance: params.enhance ?? true,
        };

        const response = await fetch(cdzApiUrl('/api/v1/images/generations'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Route is NOT @Public — it authenticates via the session cookie.
          credentials: 'include',
          body: JSON.stringify(payload),
        });

        const data = (await response
          .json()
          .catch(() => null)) as ImageGenResponse | null;

        if (!response.ok) {
          // 503 = the image key is not configured → "AI unavailable".
          setFail(response.status === 503 ? 'aiUnavailable' : 'error');
          return null;
        }

        // Backend normalizes b64_json → a data: URL, so `url` is always present
        // on success. Fetch it back into a Blob for the caller (the panel folds
        // it into the engine via the same path the mask panel uses).
        const url = data?.data?.[0]?.url;
        if (typeof url !== 'string' || !url) {
          setFail('error');
          return null;
        }

        try {
          const imgResp = await fetch(url);
          if (!imgResp.ok) {
            setFail('error');
            return null;
          }
          return await imgResp.blob();
        } catch {
          setFail('error');
          return null;
        }
      } catch {
        // Network/abort/anything unexpected: treat AI as unavailable, never throw.
        setFail('aiUnavailable');
        return null;
      } finally {
        setWorking(false);
      }
    },
    [working]
  );

  return { working, fail, clearFail, generate };
}
