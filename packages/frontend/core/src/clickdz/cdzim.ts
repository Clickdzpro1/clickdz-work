// CDZIM — ClickDz Image Model registry (rebranded Nano Banana / Gemini Image)
//
// All Gemini image models rebranded under the CDZIM name.
// Wherever OpenAI image models appear in the app, CDZIM models appear alongside.
//
// ENV VARS (Railway):
//   CDZIM_API_KEY       — Google API key (same as GOOGLE_API_KEY)
//   CDZIM_DEFAULT_MODEL — Default model id (gemini-3.1-flash-image)
//   CDZIM_MODEL_FLASH   — gemini-3.1-flash-image
//   CDZIM_MODEL_LITE    — gemini-3.1-flash-lite-image
//   CDZIM_MODEL_PRO     — gemini-3-pro-image
//   CDZIM_MODEL_CLASSIC — gemini-2.5-flash-image

export type CDZIMTier = 'lite' | 'flash' | 'pro' | 'classic';

export interface CDZIMModel {
  /** CDZ brand name shown in the UI. */
  brandName: string;
  /** Google model id for the API call. */
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
];

/** Default model — CDZIM Flash (most versatile). */
export const CDZIM_DEFAULT = CDZIM_MODELS.find(m => m.tier === 'flash') ?? CDZIM_MODELS[1];

/** Get a model by tier. */
export function cdzimByTier(tier: CDZIMTier): CDZIMModel | undefined {
  return CDZIM_MODELS.find(m => m.tier === tier);
}

/** Get a model by Google model id. */
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
