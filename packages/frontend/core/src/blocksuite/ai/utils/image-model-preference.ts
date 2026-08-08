/**
 * CDZIMAGE preference for NATIVE image actions (WS1 PR5).
 *
 * Which engine the AI box / Whiteboard image actions use (Generate image,
 * style filters, upscale, remove-background). Historically these surfaces
 * offered 2.0/1.5 ONLY by policy — the economy 1.0 tier lived in Vdz alone.
 * Stored in localStorage (blocksuite land has no service DI here; same
 * persistence class as the vdz layout) and read as the fallback `modelId` by
 * the image transport, so the server prompt default (gpt-image-2) is
 * overridden per user choice on every native image request.
 *
 * 2026-07-31: the options list is now generated from the CDZIM registry
 * (packages/frontend/core/src/clickdz/cdzim.ts) instead of being hand-rolled,
 * so newly-added CDZIM tiers surface here automatically. This is also how the
 * previously-orphaned CDZIM_MODELS registry (zero consumers before this
 * change) becomes actually selectable.
 *
 * 2026-08: the four CDZIM Gemini tiers (Pro/Flash/Lite/Classic) are now
 * backend-accepted (clickdz-bridge.controller.ts CDZIMAGE_TIERS routes them to
 * Google's generateContent API, guarded by GEMINI_API_KEY || CDZIM_API_KEY)
 * and are advertised by /v1/models — so they are exposed here alongside the
 * OpenAI (CDZIMAGE) tiers. Ids are the raw Gemini engine ids the backend maps
 * back to their tier via the 'raw-engine' resolution branch.
 */
import { cdzimByTier } from '@affine/core/clickdz/cdzim';

const STORAGE_KEY = 'cdz:image-model:v1';

// The CDZIM 'openai-economy' tier's modelId (gpt-image-1-mini) — looked up by
// tier rather than filtered/mapped from the full CDZIM_MODELS array so this
// stays a single resolved literal (`as const` below preserves it verbatim in
// the union), instead of widening to `string` the way spreading a filtered
// array into a const-asserted literal tuple would. Falls back to the literal
// id itself if the registry entry is ever removed, so this file never throws.
const CDZIM_ECONOMY_MODEL_ID = (cdzimByTier('openai-economy')?.modelId ??
  'gpt-image-1-mini') as 'gpt-image-1-mini';

export const CDZ_IMAGE_MODEL_OPTIONS = [
  // CDZIM (Gemini) tiers — backend routes these to Google's generateContent
  { id: 'gemini-3-pro-image', label: 'CDZIM Pro · best' },
  { id: 'gemini-3.1-flash-image', label: 'CDZIM Flash · balanced' },
  { id: 'gemini-3.1-flash-lite-image', label: 'CDZIM Lite · fastest' },
  { id: 'gemini-2.5-flash-image', label: 'CDZIM Classic' },
  // CDZIMAGE (OpenAI) tiers
  { id: 'gpt-image-2', label: 'CDZIMAGE 2.0 · best' },
  { id: 'gpt-image-1.5', label: 'CDZIMAGE 1.5 · balanced' },
  { id: CDZIM_ECONOMY_MODEL_ID, label: 'CDZIM Economy · cheapest' },
] as const;

export type CdzPreferredImageModel =
  (typeof CDZ_IMAGE_MODEL_OPTIONS)[number]['id'];

export const DEFAULT_IMAGE_MODEL: CdzPreferredImageModel = 'gpt-image-2';

const VALID_IMAGE_MODEL_IDS: readonly string[] = CDZ_IMAGE_MODEL_OPTIONS.map(
  option => option.id
);

export function getPreferredImageModel(): CdzPreferredImageModel {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value && VALID_IMAGE_MODEL_IDS.includes(value)) {
      return value as CdzPreferredImageModel;
    }
  } catch {
    // no storage (SSR / private mode) — fall through to the default
  }
  return DEFAULT_IMAGE_MODEL;
}

export function setPreferredImageModel(id: CdzPreferredImageModel): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // non-fatal: the session just keeps the default
  }
}
