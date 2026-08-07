// modules/stickers/animate.ts
//
// WS6 — sticker/image ANIMATOR (client-side preset motion).
//
// Turns a static raster image (an AI-generated sticker, an existing sticker, or
// an edgeless image block's blob) into an ANIMATED sticker by:
//   1. reading the source blob back into a data-URI,
//   2. building a self-contained preset Lottie doc (lottie-presets.ts),
//   3. storing that Lottie JSON via blobSync → a `sourceId`,
//   4. `addSticker(std, lottieSourceId, 'animated', { animSrc, animAutoplay })`.
//
// The sticker block renderer plays the block's `sourceId` blob through
// `@lottiefiles/dotlottie-web`, so the Lottie JSON becomes the animated
// sticker's source; `animSrc` mirrors the same id for semantic clarity and
// future non-preset (service-generated) motion. No external dependency — the
// Lottie is authored in-process.

import type { BlockStdScope } from '@blocksuite/std';

import {
  buildPresetLottieBlob,
  DEFAULT_STICKER_ANIM_PRESET,
  type StickerAnimPreset,
} from './lottie-presets';
import { addSticker, ingestStickerAsset } from './provider';

/** Read a Blob into a base64 data-URI (for embedding into the Lottie asset). */
async function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** Best-effort intrinsic dimensions of a raster blob (falls back to 96×96). */
async function imageSize(
  blob: Blob
): Promise<{ width: number; height: number }> {
  // `createImageBitmap` is the cheapest path and is available in the renderer.
  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob);
      const size = { width: bmp.width, height: bmp.height };
      bmp.close?.();
      if (size.width > 0 && size.height > 0) return size;
    }
  } catch {
    // fall through to the <img> decode path
  }
  try {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('decode failed'));
        img.src = url;
      });
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        return { width: img.naturalWidth, height: img.naturalHeight };
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    // ignore — use the default below
  }
  return { width: 96, height: 96 };
}

export interface AnimateStickerOptions {
  preset?: StickerAnimPreset;
  /** Placement point in viewport coords; defaults to viewport center. */
  point?: [number, number];
  /** Display size of the placed sticker (defaults to source-derived, capped). */
  width?: number;
  height?: number;
}

/**
 * Build a preset-animated sticker from an image Blob and place it on the
 * canvas. Returns the new block id, or null on failure (never throws).
 */
export async function animateImageBlobToSticker(
  std: BlockStdScope,
  imageBlob: Blob,
  options: AnimateStickerOptions = {}
): Promise<string | null> {
  try {
    const preset = options.preset ?? DEFAULT_STICKER_ANIM_PRESET;
    const [dataUri, size] = await Promise.all([
      blobToDataUri(imageBlob),
      imageSize(imageBlob),
    ]);

    const lottieBlob = buildPresetLottieBlob({
      imageDataUri: dataUri,
      width: size.width,
      height: size.height,
      preset,
    });

    // Store the Lottie JSON as the sticker's source (dotlottie plays it).
    const lottieSourceId = await ingestStickerAsset(std, lottieBlob);

    // Keep display size sensible: preserve aspect, cap the long edge at 200px.
    const cap = 200;
    const scale = Math.min(1, cap / Math.max(size.width, size.height));
    const w = options.width ?? Math.max(48, Math.round(size.width * scale));
    const h = options.height ?? Math.max(48, Math.round(size.height * scale));

    return addSticker(std, lottieSourceId, 'animated', {
      point: options.point,
      width: w,
      height: h,
      animSrc: lottieSourceId,
      animAutoplay: true,
    });
  } catch {
    return null;
  }
}

/**
 * Animate an existing block (sticker or image) identified by its `sourceId`:
 * fetch the stored blob, then delegate to {@link animateImageBlobToSticker}.
 * Skips gracefully (returns null) when the source is not a raster image (e.g. a
 * sticker that is ALREADY animated Lottie JSON).
 */
export async function animateBlockSourceToSticker(
  std: BlockStdScope,
  sourceId: string,
  options: AnimateStickerOptions = {}
): Promise<string | null> {
  try {
    const blob = await std.store.blobSync.get(sourceId);
    if (!blob) return null;
    // Guard against re-animating an already-animated Lottie source. Empty MIME
    // is ambiguous (raster blobs often report ''), so only bail on an explicit
    // json/lottie type.
    if (blob.type.includes('json') || blob.type.includes('lottie')) {
      return null;
    }
    return animateImageBlobToSticker(std, blob, options);
  } catch {
    return null;
  }
}
