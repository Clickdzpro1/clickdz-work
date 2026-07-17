/**
 * CDZIMAGE preference for NATIVE image actions (WS1 PR5).
 *
 * Which engine the AI box / Whiteboard image actions use (Generate image,
 * style filters, upscale, remove-background). These surfaces offer 2.0/1.5
 * ONLY by policy — the economy 1.0 tier lives in Vdz alone. Stored in
 * localStorage (blocksuite land has no service DI here; same persistence
 * class as the vdz layout) and read as the fallback `modelId` by the image
 * transport, so the server prompt default (gpt-image-2) is overridden per
 * user choice on every native image request.
 */

const STORAGE_KEY = 'cdz:image-model:v1';

export const CDZ_IMAGE_MODEL_OPTIONS = [
  { id: 'gpt-image-2', label: 'CDZIMAGE 2.0 · best' },
  { id: 'gpt-image-1.5', label: 'CDZIMAGE 1.5 · balanced' },
] as const;

export type CdzPreferredImageModel =
  (typeof CDZ_IMAGE_MODEL_OPTIONS)[number]['id'];

export const DEFAULT_IMAGE_MODEL: CdzPreferredImageModel = 'gpt-image-2';

export function getPreferredImageModel(): CdzPreferredImageModel {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'gpt-image-2' || value === 'gpt-image-1.5') {
      return value;
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
