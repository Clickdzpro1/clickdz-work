// modules/stickers/lottie-presets.ts
//
// WS6 — CLIENT-SIDE preset Lottie motion for stickers/images.
//
// The sticker block renderer (blocksuite/affine/blocks/sticker/src/sticker-block.ts)
// mounts a `@lottiefiles/dotlottie-web` canvas when `stickerType === 'animated'`
// and plays the blob referenced by the block's `sourceId`. So to "animate" a
// static sticker/image we just need to produce a valid Lottie JSON document
// whose single image layer IS the source PNG, with a parameterized transform
// keyframe track (position / scale / rotation / opacity) for the chosen motion.
//
// This is 100% client-side — no external service, no extra dependency. Lottie
// JSON is plain data, and dotlottie-web supports embedded image assets via a
// data-URI `assets[].p` ("u":"","e":1). We build the document here.
//
// A richer sketch→Lottie converter (marciogranzotto/lottie-tools, MIT —
// https://github.com/marciogranzotto/lottie-tools) can later be deployed as a
// Railway shim to generate NON-preset motion from an SVG; its output is also
// standard Lottie JSON and plugs into the exact same `animSrc`/sourceId path
// with zero renderer change. See fixes/pr-ws-f.md for the follow-up plan.

/** The built-in preset motions. Stable ids — persisted choices reference them. */
export const STICKER_ANIM_PRESETS = [
  'bob',
  'spin',
  'pulse',
  'bounce',
] as const;

export type StickerAnimPreset = (typeof STICKER_ANIM_PRESETS)[number];

export const DEFAULT_STICKER_ANIM_PRESET: StickerAnimPreset = 'bob';

/** Human labels (proper-cased, not translated — motion names are UI-neutral). */
export const STICKER_ANIM_PRESET_LABELS: Record<StickerAnimPreset, string> = {
  bob: 'Bob',
  spin: 'Spin',
  pulse: 'Pulse',
  bounce: 'Bounce',
};

/** Minimal Lottie transform shape we author (bodymovin schema subset). */
interface LottieTransform {
  // anchor point
  a: { a: 0; k: [number, number, number] };
  // position (may be keyframed → a:1 with an array of keyframes)
  p:
    | { a: 0; k: [number, number, number] }
    | { a: 1; k: Array<Record<string, unknown>> };
  // scale
  s:
    | { a: 0; k: [number, number, number] }
    | { a: 1; k: Array<Record<string, unknown>> };
  // rotation
  r:
    | { a: 0; k: number }
    | { a: 1; k: Array<Record<string, unknown>> };
  // opacity
  o:
    | { a: 0; k: number }
    | { a: 1; k: Array<Record<string, unknown>> };
}

/** Standard ease in/out bezier used by every keyframe segment. */
const EASE = {
  i: { x: [0.42], y: [1] },
  o: { x: [0.58], y: [0] },
};

/** A single scalar (or vector) keyframe at frame `t` with value `s`. */
function kf(t: number, s: number[] | number, hold = false) {
  const base: Record<string, unknown> = { t, s: Array.isArray(s) ? s : [s] };
  if (!hold) {
    base.i = EASE.i;
    base.o = EASE.o;
  }
  return base;
}

/**
 * Build the keyframed transform for a preset. `cx`/`cy` are the layer center
 * (anchor + rest position, in the composition's px coordinate space) and `op`
 * is the out-point (total frame count) of the loop.
 */
function presetTransform(
  preset: StickerAnimPreset,
  cx: number,
  cy: number,
  op: number
): LottieTransform {
  const a: LottieTransform['a'] = { a: 0, k: [cx, cy, 0] };
  const restPos: LottieTransform['p'] = { a: 0, k: [cx, cy, 0] };
  const restScale: LottieTransform['s'] = { a: 0, k: [100, 100, 100] };
  const restRot: LottieTransform['r'] = { a: 0, k: 0 };
  const fullOpacity: LottieTransform['o'] = { a: 0, k: 100 };
  const half = Math.round(op / 2);

  switch (preset) {
    case 'bob': {
      // Gentle vertical float up-and-down.
      const dy = Math.max(8, cy * 0.06);
      return {
        a,
        p: {
          a: 1,
          k: [
            kf(0, [cx, cy, 0]),
            kf(half, [cx, cy - dy, 0]),
            kf(op, [cx, cy, 0]),
          ],
        },
        s: restScale,
        r: restRot,
        o: fullOpacity,
      };
    }
    case 'spin': {
      // Continuous 360° rotation about the center. Linear (no ease) so the
      // loop is seamless.
      return {
        a,
        p: restPos,
        s: restScale,
        r: {
          a: 1,
          k: [kf(0, 0, true), { t: op, s: [360] }],
        },
        o: fullOpacity,
      };
    }
    case 'pulse': {
      // Scale breathing 100% → 115% → 100%.
      return {
        a,
        p: restPos,
        s: {
          a: 1,
          k: [
            kf(0, [100, 100, 100]),
            kf(half, [115, 115, 100]),
            kf(op, [100, 100, 100]),
          ],
        },
        r: restRot,
        o: fullOpacity,
      };
    }
    case 'bounce': {
      // Squash-and-stretch drop: down + flatten at the bottom, back to rest.
      const dy = Math.max(10, cy * 0.08);
      const q1 = Math.round(op * 0.35);
      const q2 = Math.round(op * 0.6);
      return {
        a,
        p: {
          a: 1,
          k: [
            kf(0, [cx, cy - dy, 0]),
            kf(q1, [cx, cy, 0]),
            kf(q2, [cx, cy - dy * 0.5, 0]),
            kf(op, [cx, cy - dy, 0]),
          ],
        },
        s: {
          a: 1,
          k: [
            kf(0, [100, 100, 100]),
            kf(q1, [112, 88, 100]),
            kf(q2, [100, 100, 100]),
            kf(op, [100, 100, 100]),
          ],
        },
        r: restRot,
        o: fullOpacity,
      };
    }
    default: {
      return { a, p: restPos, s: restScale, r: restRot, o: fullOpacity };
    }
  }
}

export interface BuildPresetLottieOptions {
  /** Data-URI (or http) of the source image to animate (the PNG sticker). */
  imageDataUri: string;
  /** Intrinsic pixel size of the image; drives the composition dimensions. */
  width: number;
  height: number;
  preset: StickerAnimPreset;
  /** Loop length in frames (default 90 @ 30fps = 3s). */
  frames?: number;
  /** Frame rate (default 30). */
  fps?: number;
}

/**
 * Produce a self-contained Lottie JSON document (as a JS object) that animates
 * `imageDataUri` with the chosen preset. The image is embedded as a data-URI
 * asset so the resulting blob is fully portable (no external asset fetch).
 */
export function buildPresetLottie(
  options: BuildPresetLottieOptions
): Record<string, unknown> {
  const {
    imageDataUri,
    width,
    height,
    preset,
    frames = 90,
    fps = 30,
  } = options;

  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const op = Math.max(1, Math.round(frames));
  const cx = w / 2;
  const cy = h / 2;

  const ks = presetTransform(preset, cx, cy, op);

  return {
    v: '5.7.4',
    fr: fps,
    ip: 0,
    op,
    w,
    h,
    nm: `cdz-sticker-${preset}`,
    ddd: 0,
    assets: [
      {
        id: 'image_0',
        w,
        h,
        u: '',
        p: imageDataUri,
        e: 1,
      },
    ],
    layers: [
      {
        ddd: 0,
        ind: 1,
        ty: 2, // image layer
        nm: 'sticker',
        refId: 'image_0',
        sr: 1,
        ks,
        ao: 0,
        ip: 0,
        op,
        st: 0,
        bm: 0,
      },
    ],
  };
}

/** Build a preset Lottie and wrap it as an `application/json` Blob. */
export function buildPresetLottieBlob(
  options: BuildPresetLottieOptions
): Blob {
  const doc = buildPresetLottie(options);
  return new Blob([JSON.stringify(doc)], { type: 'application/json' });
}
