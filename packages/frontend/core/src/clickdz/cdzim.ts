// CDZIM — ClickDz Image Model registry (rebranded Nano Banana / Gemini Image)
//
// All Gemini image models rebranded under the CDZIM name.
// Wherever OpenAI image models appear in the app, CDZIM models appear alongside
// — see the 'openai-economy' tier below, which is the literal "alongside"
// entry this comment always promised but never shipped.
//
// ENV VARS (Railway):
//   CDZIM_API_KEY       — Google API key (same as GOOGLE_API_KEY)
//   CDZIM_DEFAULT_MODEL — Default model id (gemini-3.1-flash-image)
//   CDZIM_MODEL_FLASH   — gemini-3.1-flash-image
//   CDZIM_MODEL_LITE    — gemini-3.1-flash-lite-image
//   CDZIM_MODEL_PRO     — gemini-3-pro-image
//   CDZIM_MODEL_CLASSIC — gemini-2.5-flash-image
//
// 2026-07-31 update — new-models audit:
//   This registry was added (commit 359e09a) but never imported anywhere:
//   CDZIM_MODELS / cdzimByTier / cdzimByModelId had zero consumers. That is
//   the "new image models were never added" bug — the models existed as
//   data but were never wired to a picker. Fixed by importing this file from
//   packages/frontend/core/src/blocksuite/ai/utils/image-model-preference.ts,
//   which feeds the real "Image model" picker in
//   ai-chat-input/preference-popup.ts.
//
//   Only ONE new tier was added here ('openai-economy'), and only after
//   verifying the exact id against the backend:
//     packages/backend/server/src/plugins/copilot/clickdz-bridge.controller.ts
//     — CDZIMAGE_TIERS (~line 683-690) is the backend's own allowlist for
//     POST /api/v1/images/generations. It defines exactly THREE accepted
//     engines: gpt-image-2, gpt-image-1.5, gpt-image-1-mini. The first two
//     were already reachable via CDZ_IMAGE_MODEL_OPTIONS; gpt-image-1-mini
//     (tier "cdzimage-1.0") was configured server-side and already used by
//     the Vdz media bin (packages/frontend/core/src/modules/vdz/use-vdz-media.ts)
//     but was never selectable from the main AI chat / Whiteboard image
//     picker. That is the one verified, backend-accepted gap this change
//     closes.
//
//   2026-08 update — the Gemini image path is now LIVE end-to-end. The bridge
//   controller (clickdz-bridge.controller.ts) resolves every Gemini image id
//   below through CDZIMAGE_TIERS (gemini-3.1-flash-image / -flash-lite-image /
//   gemini-3-pro-image / gemini-2.5-flash-image — tier id == engine id) and
//   routes them to Google's generateContent API, guarded by GEMINI_API_KEY ||
//   CDZIM_API_KEY. /v1/models advertises all four and brands them owned_by
//   'clickdz-images'. So the four Gemini tiers below ARE backend-accepted and
//   are now surfaced in every image picker (image-model-preference.ts,
//   use-vpic-generate.ts, use-vdz-media.ts) alongside the OpenAI tiers.

export type CDZIMTier = 'lite' | 'flash' | 'pro' | 'classic' | 'openai-economy';

export interface CDZIMModel {
  /** CDZ brand name shown in the UI. */
  brandName: string;
  /**
   * Model id for the API call. Google model id for Gemini tiers; for the
   * 'openai-economy' tier this is the OpenAI engine id the backend's
   * CDZIMAGE_TIERS allowlist maps to 'cdzimage-1.0' (see
   * clickdz-bridge.controller.ts) — the backend accepts both the tier id and
   * this raw engine id (the 'raw-engine' resolution branch), so sending
   * either works.
   */
  modelId: string;
  /** Tier for quick selection. */
  tier: CDZIMTier;
  /** Speed label for the UI. */
  speed: 'fastest' | 'fast' | 'moderate' | 'fast';
  /** Quality label. */
  quality: 'good' | 'excellent' | 'best' | 'good';
  /** Max output resolution. */
  maxResolution: '1K' | '4K' | '4K' | '2K';
  /** Short FR description. */
  descFr: string;
  /** Short EN description. */
  descEn: string;
  /** Short AR description. */
  descAr: string;
  /** Emoji icon. */
  icon: string;
}

export const CDZIM_MODELS: CDZIMModel[] = [
  {
    brandName: 'CDZIM Lite',
    modelId: 'gemini-3.1-flash-lite-image',
    tier: 'lite',
    speed: 'fastest',
    quality: 'good',
    maxResolution: '1K',
    descFr: 'Le plus rapide et économique. Idéal pour la génération à grande échelle.',
    descEn: 'Fastest and cheapest. Ideal for high-volume generation.',
    descAr: 'الأسرع والأرخص. مثالي للتوليد بكميات كبيرة.',
    icon: '⚡',
  },
  {
    brandName: 'CDZIM Flash',
    modelId: 'gemini-3.1-flash-image',
    tier: 'flash',
    speed: 'fast',
    quality: 'excellent',
    maxResolution: '4K',
    descFr: 'Le plus polyvalent. 4K, texte fiable, multi-références.',
    descEn: 'Most versatile. 4K, reliable text, multi-reference.',
    descAr: 'الأكثر تنوعاً. 4K، نص موثوق، مراجع متعددة.',
    icon: '📸',
  },
  {
    brandName: 'CDZIM Pro',
    modelId: 'gemini-3-pro-image',
    tier: 'pro',
    speed: 'moderate',
    quality: 'best',
    maxResolution: '4K',
    descFr: 'Premium. Connaissance du monde, localisation, cohérence de marque.',
    descEn: 'Premium. World knowledge, localization, brand consistency.',
    descAr: 'بريميوم. معرفة بالعالم، توطين، اتساق العلامة التجارية.',
    icon: '🎨',
  },
  {
    brandName: 'CDZIM Classic',
    modelId: 'gemini-2.5-flash-image',
    tier: 'classic',
    speed: 'fast',
    quality: 'good',
    maxResolution: '2K',
    descFr: 'Le pionnier. Fiable, mais CDZIM Lite est recommandé pour les nouveaux projets.',
    descEn: 'The pioneer. Reliable, but CDZIM Lite is recommended for new projects.',
    descAr: 'الرائد. موثوق، لكن يُنصح بـ CDZIM Lite للمشاريع الجديدة.',
    icon: '🍌',
  },
  {
    // Verified backend-accepted id (not a Gemini model): see the
    // "2026-07-31 update" note above the CDZIMTier type for the full
    // grounding. modelId is the raw OpenAI engine string the backend's
    // CDZIMAGE_TIERS['cdzimage-1.0'] entry resolves to.
    brandName: 'CDZIM Economy (OpenAI)',
    modelId: 'gpt-image-1-mini',
    tier: 'openai-economy',
    speed: 'fastest',
    quality: 'good',
    maxResolution: '1K',
    descFr: "Économique, propulsé par OpenAI. Alternative à faible coût pour la génération en volume.",
    descEn: 'Economy tier, OpenAI-powered. Low-cost alternative for high-volume generation.',
    descAr: 'فئة اقتصادية مدعومة من OpenAI. بديل منخفض التكلفة للتوليد بكميات كبيرة.',
    icon: '💸',
  },
];

/** Default model — CDZIM Flash (most versatile). */
export const CDZIM_DEFAULT = CDZIM_MODELS.find(m => m.tier === 'flash') ?? CDZIM_MODELS[1];

/** Get a model by tier. */
export function cdzimByTier(tier: CDZIMTier): CDZIMModel | undefined {
  return CDZIM_MODELS.find(m => m.tier === tier);
}

/** Get a model by its API model id (Google id for Gemini tiers, OpenAI engine id for the 'openai-economy' tier). */
export function cdzimByModelId(modelId: string): CDZIMModel | undefined {
  return CDZIM_MODELS.find(m => m.modelId === modelId);
}

/** The env var name for the API key. */
export const CDZIM_API_KEY_ENV = 'CDZIM_API_KEY';

/** The env var name for the default model. */
export const CDZIM_DEFAULT_MODEL_ENV = 'CDZIM_DEFAULT_MODEL';

/** Resolve the active model from env vars (server-side). */
export function resolveCDZIMModel(envModelId?: string): CDZIMModel {
  if (envModelId) {
    const found = cdzimByModelId(envModelId);
    if (found) return found;
  }
  return CDZIM_DEFAULT;
}
