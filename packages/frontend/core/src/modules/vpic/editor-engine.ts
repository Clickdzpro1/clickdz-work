/**
 * VPIC Studio — framework-free Canvas2D editor engine.
 *
 * This module is deliberately React-free (NO hooks, NO JSX, zero npm deps). It
 * is the pure image-editing core that the VPIC page shell (Easel's
 * `editor-panel.tsx`) drives imperatively: construct one {@link VpicEngine}
 * per opened image, call mutators (crop/rotate/flip/resize/adjust/filter/text),
 * render a fitted preview into a <canvas>, and finally export a full-res Blob.
 *
 * ── Design in one paragraph ──────────────────────────────────────────────────
 * We keep the ORIGINAL decoded bitmap untouched for the whole lifetime of the
 * engine (see {@link VpicEngine.source}) and describe every edit as a small,
 * serializable "ops state" object (crop rect + rotation quarters + flips +
 * target size + adjust + filter + texts). NOTHING is baked into pixels until we
 * render. Rendering — for the on-screen preview AND for export — runs the SAME
 * single pipeline:
 *
 *     source bitmap
 *       → geometry  (crop → rotate → flip → resize, stepped half-downscale)
 *       → ctx.filter (brightness/contrast/saturate + preset combos + warmth)
 *       → text overlays drawn LAST (never touched by the image filter)
 *
 * Because edits are just data, undo/redo store STATE SNAPSHOTS (cheap, plain
 * objects) rather than pixel buffers, and a project can be persisted as a tiny
 * JSON blob ({@link VpicEngine.toStateJSON}) that replays deterministically onto
 * the same source ({@link VpicEngine.applyStateJSON}).
 *
 * ── Portability notes ────────────────────────────────────────────────────────
 * · `ctx.filter` (the CSS-filter string on a 2D context) is well supported in
 *   the Chromium/Electron and Firefox targets this app ships to, so all colour
 *   grading goes through it. We keep a tiny per-pixel warmth fallback for the
 *   (rare) engine that reports no `filter` support, so warmth never silently
 *   no-ops. Everything degrades soft.
 * · `ctx.direction = 'rtl'` drives Arabic (darja) text overlays; combined with
 *   textAlign we get correct bidi placement without any shaping library.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types (pinned by R14-CONTRACT — do not change these signatures)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Colour adjustments. The first three are multiplicative CSS-filter percentages
 * where 100 = neutral and the legal range is 0..200 (0 = off, 200 = doubled).
 * `warmth` is an artistic push toward orange (+) or blue (-) on a symmetric
 * -100..100 scale, 0 = neutral.
 */
export interface VpicAdjust {
  brightness: number; // 0..200, 100 = neutral
  contrast: number; // 0..200, 100 = neutral
  saturate: number; // 0..200, 100 = neutral
  warmth: number; // -100..100, 0 = neutral (warm > 0, cool < 0)
}

/** The seven pinned filter presets. `none` is the identity grade. */
export type VpicFilterId =
  | 'none'
  | 'bw'
  | 'vivid'
  | 'soft'
  | 'warm'
  | 'cool'
  | 'product';

/**
 * A single text overlay. Position is RELATIVE (0..1) to the current output size
 * so overlays survive crop/resize/rotate and export at full resolution without
 * re-layout. `size` is likewise a RELATIVE fraction of the output HEIGHT (see
 * {@link VpicEngine} rendering notes) so a caption keeps its proportions no
 * matter the export scale. `rtl` flips the drawing direction for Arabic script.
 */
export interface VpicTextOverlay {
  id: string;
  text: string;
  x: number; // 0..1, relative to output width  (anchor point per `align`)
  y: number; // 0..1, relative to output height (text baseline-ish, see draw)
  size: number; // 0..1, fraction of output height => on-screen/px font size
  color: string;
  bold: boolean;
  align: 'left' | 'center' | 'right';
  rtl: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal ops-state model (serializable; the whole point of the engine)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A crop rectangle expressed in the coordinate space of the *upright source*
 * (i.e. before rotation/flip), normalised 0..1. We accumulate crops here rather
 * than keeping a stack of rects: a new relative crop is composed into the
 * existing rect so `width`/`height` and rendering only ever consult ONE rect.
 * Storing it upright-relative keeps rotation math trivial (rotate is applied
 * after cropping in the pipeline).
 */
interface CropRect {
  x: number; // 0..1 left, in source space
  y: number; // 0..1 top, in source space
  w: number; // 0..1 width
  h: number; // 0..1 height
}

/**
 * The complete, serializable description of an edit. This is what undo/redo
 * snapshots and what {@link VpicEngine.toStateJSON} emits. It intentionally
 * contains NO pixels and NO source reference — it is pure "how to transform the
 * source" data, replayable onto any decode of the same image.
 */
interface OpsState {
  /** Accumulated crop, in upright-source-relative coords. */
  crop: CropRect;
  /** Number of clockwise 90° quarter-turns, normalised to 0..3. */
  rotationQuarters: number;
  /** Mirror flags applied AFTER rotation, in output space. */
  flipH: boolean;
  flipV: boolean;
  /**
   * Explicit output size in px, or null to mean "natural size of the cropped +
   * rotated region". `resize()` sets this; crop/rotate clear it back to null so
   * the output tracks the geometry unless the user pinned a size.
   */
  targetW: number | null;
  targetH: number | null;
  /** Colour adjustments (see {@link VpicAdjust}). */
  adjust: VpicAdjust;
  /** Active preset filter id. */
  filter: VpicFilterId;
  /** Overlay list, drawn last, in declared order (later = on top). */
  texts: VpicTextOverlay[];
}

/** The neutral adjust — 100/100/100/0. */
function neutralAdjust(): VpicAdjust {
  return { brightness: 100, contrast: 100, saturate: 100, warmth: 0 };
}

/** The identity ops-state: full-frame crop, no rotation, no grade, no text. */
function freshState(): OpsState {
  return {
    crop: { x: 0, y: 0, w: 1, h: 1 },
    rotationQuarters: 0,
    flipH: false,
    flipV: false,
    targetW: null,
    targetH: null,
    adjust: neutralAdjust(),
    filter: 'none',
    texts: [],
  };
}

/**
 * Deep-ish clone of an ops-state for undo snapshots. The state is plain data
 * (numbers, booleans, strings, a flat crop object, and an array of flat text
 * objects), so a structuredClone-free manual copy is both correct and fast and
 * avoids any environment where structuredClone is unavailable.
 */
function cloneState(s: OpsState): OpsState {
  return {
    crop: { x: s.crop.x, y: s.crop.y, w: s.crop.w, h: s.crop.h },
    rotationQuarters: s.rotationQuarters,
    flipH: s.flipH,
    flipV: s.flipV,
    targetW: s.targetW,
    targetH: s.targetH,
    adjust: { ...s.adjust },
    filter: s.filter,
    texts: s.texts.map(t => ({ ...t })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Small numeric helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Clamp `v` into [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp then round to a whole pixel, never below 1 (canvases hate 0-size). */
function pxDim(v: number): number {
  const n = Math.round(v);
  return n < 1 ? 1 : n;
}

/**
 * A drawable source: either an ImageBitmap (preferred, GPU-friendly) or a
 * canvas (our fallback when ImageBitmap/createImageBitmap is unavailable, or
 * when we had to downscale a huge decode). Both satisfy CanvasImageSource and
 * expose width/height, which is all the pipeline needs.
 */
type DrawableSource =
  | ImageBitmap
  | HTMLCanvasElement
  | (CanvasImageSource & { width: number; height: number });

// Hard ceiling on the decoded source's longest edge. Mobile GPUs and some
// canvas backends refuse or thrash on very large textures, and a 6000px cap
// keeps memory sane while staying well above any social-export resolution. If a
// decode exceeds this we downscale ONCE on load into a canvas and treat that as
// the source (all crops/resizes remain relative, so quality is preserved for
// realistic edits — the user simply can't zoom beyond 6000px of real detail).
const MAX_SOURCE_DIM = 6000;

// ─────────────────────────────────────────────────────────────────────────────
// The engine
// ─────────────────────────────────────────────────────────────────────────────

export class VpicEngine {
  /**
   * The immutable decoded source. NEVER mutated after construction — every edit
   * lives in {@link state} and is re-applied at render time.
   */
  private readonly source: DrawableSource;
  private readonly sourceW: number;
  private readonly sourceH: number;

  /** Current ops-state (the "present"). */
  private state: OpsState;

  /** Undo/redo are stacks of STATE snapshots, not pixel buffers. */
  private undoStack: OpsState[] = [];
  private redoStack: OpsState[] = [];

  /** Cap the history so a marathon session can't grow memory unboundedly. */
  private static readonly MAX_HISTORY = 60;

  /** Construct from an already-decoded, size-capped source. Use {@link fromUrl}. */
  private constructor(source: DrawableSource, w: number, h: number) {
    this.source = source;
    this.sourceW = w;
    this.sourceH = h;
    this.state = freshState();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Construction
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Decode an image URL into an engine. Rejects cleanly (never throws
   * synchronously, never leaves a half-built engine) on any decode failure —
   * the caller shows a friendly `vpic.error` state.
   *
   * URL may be an object URL (`vpic-blob:` resolved by the media hook to a real
   * blob: URL), a data: URL, or a same-origin/https image. We prefer
   * `createImageBitmap` for a fast, worker-friendly decode and fall back to an
   * HTMLImageElement when it is unavailable. Oversized decodes are downscaled to
   * {@link MAX_SOURCE_DIM} once, here, so the rest of the pipeline is bounded.
   */
  static async fromUrl(url: string): Promise<VpicEngine> {
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error('vpic: empty image url');
    }

    // First choice: fetch → blob → createImageBitmap. This decodes off the main
    // thread where supported and avoids the <img> load event dance.
    if (
      typeof createImageBitmap === 'function' &&
      typeof fetch === 'function'
    ) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`vpic: fetch ${res.status}`);
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        return VpicEngine.fromDecoded(bmp, bmp.width, bmp.height);
      } catch {
        // fall through to the <img> path — some object URLs / CSP setups only
        // work through the element loader.
      }
    }

    // Fallback: classic HTMLImageElement decode.
    const img = await VpicEngine.loadImageElement(url);
    return VpicEngine.fromDecoded(img, img.naturalWidth, img.naturalHeight);
  }

  /** Load a URL into an HTMLImageElement, resolving only once fully decoded. */
  private static loadImageElement(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      // Guard: this engine is DOM-oriented; if there's no Image constructor we
      // can't proceed. Reject rather than throw so callers uniformly `.catch`.
      if (typeof Image !== 'function') {
        reject(new Error('vpic: no Image constructor in this environment'));
        return;
      }
      const img = new Image();
      // Best-effort CORS so we can read pixels back out for export. If the host
      // forbids it, drawing still works for the preview; export of a tainted
      // canvas will throw and is surfaced by exportBlob's rejection.
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () =>
        reject(new Error('vpic: image failed to load/decode'));
      img.src = url;
    });
  }

  /**
   * Finalise a freshly decoded source: if it exceeds {@link MAX_SOURCE_DIM} on
   * its longest edge, downscale ONCE into a canvas and use that as the source.
   * Otherwise adopt the decode as-is.
   */
  private static fromDecoded(
    decoded: DrawableSource,
    w: number,
    h: number
  ): VpicEngine {
    if (!(w > 0) || !(h > 0)) {
      throw new Error('vpic: decoded image has zero dimensions');
    }
    const longest = Math.max(w, h);
    if (longest <= MAX_SOURCE_DIM) {
      return new VpicEngine(decoded, w, h);
    }
    // Downscale to the cap, preserving aspect ratio, with smoothing on.
    const scale = MAX_SOURCE_DIM / longest;
    const dw = pxDim(w * scale);
    const dh = pxDim(h * scale);
    const cv = VpicEngine.makeCanvas(dw, dh);
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('vpic: no 2d context for source downscale');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded as CanvasImageSource, 0, 0, dw, dh);
    // If the decode was an ImageBitmap we can release it now; the canvas owns
    // the pixels going forward.
    if (
      typeof ImageBitmap !== 'undefined' &&
      decoded instanceof ImageBitmap
    ) {
      decoded.close();
    }
    return new VpicEngine(cv, dw, dh);
  }

  /**
   * Create a drawing canvas. Uses OffscreenCanvas where available for the
   * INTERMEDIATE geometry buffers (it never needs to be in the DOM), but always
   * returns something with a 2D context and width/height. We type it loosely as
   * HTMLCanvasElement-compatible because both satisfy the CanvasImageSource +
   * getContext('2d') shape we use.
   */
  private static makeCanvas(w: number, h: number): HTMLCanvasElement {
    const width = pxDim(w);
    const height = pxDim(h);
    if (typeof OffscreenCanvas === 'function') {
      // OffscreenCanvas is drawable and readable; cast through unknown because
      // its type differs from HTMLCanvasElement but the members we use overlap.
      const oc = new OffscreenCanvas(width, height);
      return oc as unknown as HTMLCanvasElement;
    }
    if (typeof document !== 'undefined') {
      const cv = document.createElement('canvas');
      cv.width = width;
      cv.height = height;
      return cv;
    }
    throw new Error('vpic: no canvas backend available');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Geometry math (shared by width/height getters and the render pipeline)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The cropped source region in *source pixels* (before rotation). Derived
   * purely from {@link OpsState.crop} and the source dimensions.
   */
  private cropPxRect(): { sx: number; sy: number; sw: number; sh: number } {
    const c = this.state.crop;
    const sx = clamp(c.x, 0, 1) * this.sourceW;
    const sy = clamp(c.y, 0, 1) * this.sourceH;
    // Ensure the crop stays inside the image even if x + w drifted past 1.
    const sw = clamp(c.w, 0, 1 - clamp(c.x, 0, 1)) * this.sourceW;
    const sh = clamp(c.h, 0, 1 - clamp(c.y, 0, 1)) * this.sourceH;
    return {
      sx,
      sy,
      sw: Math.max(1, sw),
      sh: Math.max(1, sh),
    };
  }

  /**
   * The "natural" output size: the cropped region's size, with width/height
   * SWAPPED when the rotation is odd (90°/270°). This is what width/height
   * report when the user hasn't pinned an explicit resize.
   */
  private naturalOutputSize(): { w: number; h: number } {
    const { sw, sh } = this.cropPxRect();
    const odd = this.state.rotationQuarters % 2 === 1;
    return odd ? { w: sh, h: sw } : { w: sw, h: sh };
  }

  /** The effective output size in px: pinned target if set, else natural. */
  private outputSize(): { w: number; h: number } {
    const nat = this.naturalOutputSize();
    const w = this.state.targetW ?? nat.w;
    const h = this.state.targetH ?? nat.h;
    return { w: pxDim(w), h: pxDim(h) };
  }

  /** CURRENT output width in px (after crop/rotate/resize). */
  get width(): number {
    return this.outputSize().w;
  }

  /** CURRENT output height in px (after crop/rotate/resize). */
  get height(): number {
    return this.outputSize().h;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // History plumbing — every mutator calls beginMutation() FIRST
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Snapshot the present onto the undo stack and clear the redo stack. Call this
   * at the top of every public mutator, BEFORE modifying {@link state}, so that
   * `undo()` restores the exact pre-edit state.
   */
  private beginMutation(): void {
    this.undoStack.push(cloneState(this.state));
    if (this.undoStack.length > VpicEngine.MAX_HISTORY) {
      // Drop the oldest snapshot — the deep past is not worth unbounded memory.
      this.undoStack.shift();
    }
    // Any new edit invalidates the redo timeline.
    this.redoStack.length = 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Mutators (each: snapshot → mutate)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Crop by a rectangle given in coordinates RELATIVE to the CURRENT output
   * (0..1). Because our stored crop lives in upright-source space and rotation
   * happens after cropping, we must map the requested output-space rect back
   * through the current flips and rotation before composing it into the stored
   * crop. This keeps a single accumulated rect (no stack) while behaving
   * intuitively for the user ("I dragged a box on what I see").
   *
   * A resize pin is cleared: after a fresh crop the output should track the new
   * region's natural size unless the user resizes again.
   */
  crop(x: number, y: number, w: number, h: number): void {
    // Normalise + clamp the incoming rect defensively.
    let rx = clamp(x, 0, 1);
    let ry = clamp(y, 0, 1);
    let rw = clamp(w, 0, 1 - rx);
    let rh = clamp(h, 0, 1 - ry);
    if (rw <= 0 || rh <= 0) return; // degenerate crop => no-op

    // 1) Undo the current FLIP (flip is its own inverse) in output space.
    if (this.state.flipH) rx = 1 - rx - rw;
    if (this.state.flipV) ry = 1 - ry - rh;

    // 2) Undo the current ROTATION: rotate the output-space rect back by
    //    `-rotationQuarters` so it lands in upright-crop space. We rotate the
    //    unit square's rect; the transforms below are the inverses of a CW
    //    quarter turn applied to normalised coords.
    const q = this.state.rotationQuarters % 4;
    for (let i = 0; i < q; i++) {
      // Inverse of one CW turn (i.e. one CCW turn) on a normalised rect:
      //   (x, y, w, h) -> (y, 1 - x - w, h, w)
      const nx = ry;
      const ny = 1 - rx - rw;
      const nw = rh;
      const nh = rw;
      rx = nx;
      ry = ny;
      rw = nw;
      rh = nh;
    }

    // 3) Compose the (now upright, relative-to-current-crop) rect INTO the
    //    stored crop. The stored crop is relative to the source; the incoming
    //    rect is relative to the stored crop — so multiply through.
    const cur = this.state.crop;
    const composed: CropRect = {
      x: cur.x + rx * cur.w,
      y: cur.y + ry * cur.h,
      w: rw * cur.w,
      h: rh * cur.h,
    };
    // Guard against sub-pixel degeneracy from repeated tiny crops.
    if (composed.w * this.sourceW < 1 || composed.h * this.sourceH < 1) return;

    this.beginMutation();
    this.state.crop = composed;
    // A new crop redefines the frame; drop any explicit resize pin.
    this.state.targetW = null;
    this.state.targetH = null;
  }

  /**
   * Rotate the output by a quarter turn. `dir === 1` is clockwise, `-1` is
   * counter-clockwise. We only track the quarter count (0..3); the actual pixel
   * rotation is applied in the pipeline. A rotation swaps width/height, so any
   * explicit resize pin is cleared to avoid a surprising squash.
   */
  rotate90(dir: 1 | -1): void {
    this.beginMutation();
    const delta = dir === -1 ? 3 : 1; // -1 CW turn === +3 CW turns (mod 4)
    this.state.rotationQuarters = (this.state.rotationQuarters + delta) % 4;
    this.state.targetW = null;
    this.state.targetH = null;
  }

  /**
   * Mirror the image. `horizontal === true` flips left↔right, else top↔bottom.
   * Flips are booleans toggled in OUTPUT space and applied after rotation in the
   * pipeline; two flips of the same axis cancel (hence toggle).
   */
  flip(horizontal: boolean): void {
    this.beginMutation();
    if (horizontal) this.state.flipH = !this.state.flipH;
    else this.state.flipV = !this.state.flipV;
  }

  /**
   * Pin an explicit output size in absolute pixels. The actual downscale in the
   * pipeline is done in STEPS (halving at most each step) for quality — a single
   * huge downscale aliases badly, whereas repeated 2× box-ish reductions with
   * smoothing approximate a good filter cheaply. Enlargements are done in one
   * smoothed step (there's no detail to preserve going up).
   */
  resize(w: number, h: number): void {
    const tw = pxDim(w);
    const th = pxDim(h);
    this.beginMutation();
    this.state.targetW = tw;
    this.state.targetH = th;
  }

  /**
   * Merge a partial adjustment patch into the current adjust, clamping each
   * field to its legal range. Passing `{}` is a harmless no-op-that-still-
   * snapshots (rare, but keeps semantics simple for the caller's slider "commit"
   * events).
   */
  setAdjust(a: Partial<VpicAdjust>): void {
    this.beginMutation();
    const cur = this.state.adjust;
    this.state.adjust = {
      brightness:
        a.brightness === undefined
          ? cur.brightness
          : clamp(a.brightness, 0, 200),
      contrast:
        a.contrast === undefined ? cur.contrast : clamp(a.contrast, 0, 200),
      saturate:
        a.saturate === undefined ? cur.saturate : clamp(a.saturate, 0, 200),
      warmth: a.warmth === undefined ? cur.warmth : clamp(a.warmth, -100, 100),
    };
  }

  /** Select a preset filter. Unknown ids are coerced to `'none'` defensively. */
  setFilter(f: VpicFilterId): void {
    this.beginMutation();
    this.state.filter = VpicEngine.isFilterId(f) ? f : 'none';
  }

  /**
   * Replace the overlay list wholesale. The panel owns add/edit/remove UX and
   * hands us the full array each commit; we sanitise every entry so a malformed
   * overlay can never crash the renderer. Order is preserved (later = on top).
   */
  setTexts(t: VpicTextOverlay[]): void {
    this.beginMutation();
    this.state.texts = Array.isArray(t)
      ? t.map(VpicEngine.sanitizeText).filter((x): x is VpicTextOverlay => !!x)
      : [];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Undo / redo
  // ───────────────────────────────────────────────────────────────────────────

  /** Restore the previous state. Returns false when there's nothing to undo. */
  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    // Push the present onto redo so it can be reached again.
    this.redoStack.push(cloneState(this.state));
    this.state = prev;
    return true;
  }

  /** Re-apply the most recently undone state. False when nothing to redo. */
  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(cloneState(this.state));
    this.state = next;
    return true;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Rendering — the single shared pipeline
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Render the current state into `canvas`, FITTED so the longest edge is at
   * most `maxDim` (default 1600). This is the interactive preview path: it sizes
   * the destination canvas to the fitted dimensions and draws once. The image
   * grade (filter/adjust) is applied to the image draw only; text overlays are
   * drawn afterwards at full clarity.
   */
  renderTo(canvas: HTMLCanvasElement, maxDim: number = 1600): void {
    const out = this.outputSize();
    const cap = maxDim > 0 ? maxDim : 1600;
    // Fit-to-cap scale (never upscale the preview beyond the real output).
    const fit = Math.min(1, cap / Math.max(out.w, out.h));
    const dw = pxDim(out.w * fit);
    const dh = pxDim(out.h * fit);

    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // nothing we can do; leave the canvas blank

    // Produce the fully-graded, correctly-sized image (no text yet)…
    const graded = this.renderImageLayer(dw, dh);
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(graded as CanvasImageSource, 0, 0);
    // …then stamp the overlays at the preview scale.
    this.drawTexts(ctx, dw, dh);
  }

  /**
   * Export the current state as a Blob at FULL output resolution (the fitted
   * preview cap does NOT apply here — this is the "real" image). Returns a
   * Promise so the caller can await the async `toBlob`. `quality` (0..1) applies
   * to lossy `image/jpeg` and `image/webp`; it's ignored for PNG.
   *
   * Rejects on: no canvas backend, a tainted (cross-origin) canvas that can't be
   * read, or a backend that yields a null blob — all surfaced so the panel can
   * show `vpic.error` rather than silently failing.
   */
  async exportBlob(
    type: 'image/png' | 'image/jpeg' | 'image/webp',
    quality?: number
  ): Promise<Blob> {
    const out = this.outputSize();
    // Full-res destination: draw the graded image, then the overlays, at 1:1.
    const canvas = VpicEngine.makeCanvas(out.w, out.h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('vpic: no 2d context for export');

    const graded = this.renderImageLayer(out.w, out.h);
    ctx.clearRect(0, 0, out.w, out.h);
    ctx.drawImage(graded as CanvasImageSource, 0, 0);
    this.drawTexts(ctx, out.w, out.h);

    const q =
      typeof quality === 'number' ? clamp(quality, 0, 1) : undefined;

    // OffscreenCanvas exposes convertToBlob(); HTMLCanvasElement exposes
    // toBlob(cb). Support both so export works regardless of makeCanvas's pick.
    const anyCanvas = canvas as unknown as {
      convertToBlob?: (opts?: {
        type?: string;
        quality?: number;
      }) => Promise<Blob>;
      toBlob?: (
        cb: (b: Blob | null) => void,
        type?: string,
        quality?: number
      ) => void;
    };

    if (typeof anyCanvas.convertToBlob === 'function') {
      try {
        return await anyCanvas.convertToBlob({ type, quality: q });
      } catch (e) {
        // Most commonly a SecurityError from a tainted canvas — normalise it.
        throw new Error(
          'vpic: export failed (the image source may be cross-origin): ' +
            (e instanceof Error ? e.message : String(e))
        );
      }
    }

    return await new Promise<Blob>((resolve, reject) => {
      if (typeof anyCanvas.toBlob !== 'function') {
        reject(new Error('vpic: canvas cannot produce a blob'));
        return;
      }
      try {
        anyCanvas.toBlob(
          b => {
            if (b) resolve(b);
            else reject(new Error('vpic: canvas produced an empty blob'));
          },
          type,
          q
        );
      } catch (e) {
        reject(
          new Error(
            'vpic: export failed (the image source may be cross-origin): ' +
              (e instanceof Error ? e.message : String(e))
          )
        );
      }
    });
  }

  /**
   * Build the graded image layer at the requested destination size and return a
   * canvas holding it. This is the heart of the pipeline and is shared by both
   * preview and export so the two can NEVER diverge:
   *
   *   1. Extract the crop region from the untouched source.
   *   2. Apply rotation (90° steps) + flips into an "upright output" buffer.
   *   3. Stepped half-downscale (or single upscale) to the destination size.
   *   4. Apply the colour grade (ctx.filter string) while blitting to the final
   *      buffer; fall back to a per-pixel warmth pass if ctx.filter is absent.
   *
   * Text is intentionally NOT drawn here (callers add it after) so overlays stay
   * crisp and unaffected by blur/saturation grading.
   */
  private renderImageLayer(
    destW: number,
    destH: number
  ): HTMLCanvasElement {
    const { sx, sy, sw, sh } = this.cropPxRect();
    const q = this.state.rotationQuarters % 4;
    const odd = q === 1 || q === 3;

    // ── Step 1+2: crop + rotate + flip into an upright buffer at NATURAL size.
    // The upright buffer's size is the cropped region, swapped if rotation is
    // odd. Drawing with a transform bakes rotation/flip into pixels once.
    const uprightW = pxDim(odd ? sh : sw);
    const uprightH = pxDim(odd ? sw : sh);
    const upright = VpicEngine.makeCanvas(uprightW, uprightH);
    const uctx = upright.getContext('2d');
    if (!uctx) return upright; // degrade: blank buffer

    uctx.save();
    // Move to the buffer centre so rotation pivots correctly, then apply flips
    // as axis scales, then the quarter-turn, then draw the crop centred.
    uctx.translate(uprightW / 2, uprightH / 2);
    if (this.state.flipH) uctx.scale(-1, 1);
    if (this.state.flipV) uctx.scale(1, -1);
    uctx.rotate((q * Math.PI) / 2);
    uctx.imageSmoothingEnabled = true;
    uctx.imageSmoothingQuality = 'high';
    // After rotation the local axes align with the *pre-rotation* crop, so we
    // draw the crop at its own (sw × sh) size centred on the origin.
    uctx.drawImage(
      this.source as CanvasImageSource,
      sx,
      sy,
      sw,
      sh,
      -sw / 2,
      -sh / 2,
      sw,
      sh
    );
    uctx.restore();

    // ── Step 3: resize the upright buffer to the destination via stepped
    // half-downscaling for quality (see steppedResize). If dest == upright this
    // is a cheap copy.
    const sized = VpicEngine.steppedResize(upright, destW, destH);

    // ── Step 4: apply the colour grade while copying to the final buffer.
    const final = VpicEngine.makeCanvas(destW, destH);
    const fctx = final.getContext('2d');
    if (!fctx) return sized as HTMLCanvasElement;

    const filterStr = this.buildFilterString();
    const filterSupported = 'filter' in fctx;
    if (filterSupported && filterStr) {
      // The happy path: one GPU-side filtered blit.
      fctx.filter = filterStr;
      fctx.drawImage(sized as CanvasImageSource, 0, 0);
      fctx.filter = 'none';
    } else {
      // No ctx.filter support: draw plain, then approximate the grade in JS.
      fctx.drawImage(sized as CanvasImageSource, 0, 0);
      VpicEngine.applyGradeFallback(fctx, destW, destH, this.state);
    }

    return final;
  }

  /**
   * Stepped, quality-preserving resize. Downscaling in a single drawImage when
   * the ratio is large produces aliasing; instead we repeatedly halve (with
   * smoothing) until we're within 2× of the target, then do the final exact
   * step. Upscaling has no aliasing concern, so it's one smoothed step. Returns
   * the SAME canvas untouched when it's already the right size (fast path).
   */
  private static steppedResize(
    src: HTMLCanvasElement,
    destW: number,
    destH: number
  ): HTMLCanvasElement {
    let curW = (src as HTMLCanvasElement).width;
    let curH = (src as HTMLCanvasElement).height;
    if (curW === destW && curH === destH) return src;

    let cur = src;

    // Downscale by halving while each dimension is more than 2× the target.
    // Halving both dims per iteration keeps aspect close; we clamp to the
    // target so we never overshoot below it.
    while (curW > destW * 2 || curH > destH * 2) {
      const nextW = Math.max(destW, Math.floor(curW / 2));
      const nextH = Math.max(destH, Math.floor(curH / 2));
      const step = VpicEngine.makeCanvas(nextW, nextH);
      const sctx = step.getContext('2d');
      if (!sctx) break; // degrade to a single final step below
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(cur as CanvasImageSource, 0, 0, nextW, nextH);
      cur = step;
      curW = nextW;
      curH = nextH;
    }

    // Final exact step (also handles pure upscaling and the sub-2× remainder).
    if (curW !== destW || curH !== destH) {
      const out = VpicEngine.makeCanvas(destW, destH);
      const octx = out.getContext('2d');
      if (octx) {
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.drawImage(cur as CanvasImageSource, 0, 0, destW, destH);
        return out;
      }
    }
    return cur;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Colour grading
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Compose the full `ctx.filter` string from the active preset AND the manual
   * adjustments AND warmth. Order matters a little (filters compose left→right);
   * we put preset colour moves first, then user adjustments, then warmth so the
   * user's sliders act on top of the preset look.
   *
   * Warmth is expressed as a blend of `sepia()` (push to orange, for warm > 0)
   * or `sepia()+hue-rotate()` toward blue (for cool < 0). It's intentionally
   * subtle — full sepia at |100| would be garish — so we scale to a max of ~35%
   * sepia and a modest hue rotation. Returns '' when the grade is a pure
   * identity (lets the pipeline skip the filter entirely).
   */
  private buildFilterString(): string {
    const parts: string[] = [];

    // 1) Preset look. Each preset is a hand-tuned combo; see notes per case.
    parts.push(...VpicEngine.presetFilterParts(this.state.filter));

    // 2) Manual adjustments (brightness/contrast/saturate as percentages).
    const a = this.state.adjust;
    if (a.brightness !== 100) parts.push(`brightness(${a.brightness}%)`);
    if (a.contrast !== 100) parts.push(`contrast(${a.contrast}%)`);
    if (a.saturate !== 100) parts.push(`saturate(${a.saturate}%)`);

    // 3) Warmth blend.
    parts.push(...VpicEngine.warmthParts(a.warmth));

    return parts.join(' ');
  }

  /**
   * The seven pinned presets, each as a list of CSS-filter primitives.
   *
   *  · none    — identity (no primitives).
   *  · bw      — full grayscale, slight contrast for punch.
   *  · vivid   — boosted saturation + contrast (pop for social).
   *  · soft    — gentle desaturation + a hair of brightness (airy, muted).
   *  · warm    — mild sepia + a touch of saturation (cosy golden cast).
   *  · cool    — hue-rotate toward blue + slight desaturation (crisp/clean).
   *  · product — MILD brightness+contrast+saturate tuned for product shots on
   *              white: lift exposure a touch, add micro-contrast, gently
   *              enrich colour WITHOUT the blowout of `vivid`. Keeps whites
   *              clean while making the product read.
   */
  private static presetFilterParts(f: VpicFilterId): string[] {
    switch (f) {
      case 'bw':
        return ['grayscale(100%)', 'contrast(105%)'];
      case 'vivid':
        return ['saturate(145%)', 'contrast(110%)'];
      case 'soft':
        return ['saturate(85%)', 'brightness(104%)', 'contrast(96%)'];
      case 'warm':
        return ['sepia(22%)', 'saturate(110%)'];
      case 'cool':
        return ['hue-rotate(-12deg)', 'saturate(92%)', 'brightness(101%)'];
      case 'product':
        // Deliberately gentle — big enough to make the shot "snap", small
        // enough to stay believable for e-commerce.
        return ['brightness(104%)', 'contrast(108%)', 'saturate(112%)'];
      case 'none':
      default:
        return [];
    }
  }

  /**
   * Turn the -100..100 warmth scalar into filter primitives. Positive =
   * warmer (sepia toward orange); negative = cooler (a light sepia base rotated
   * toward blue, which reads cleaner than hue-rotate alone). Zero => nothing.
   */
  private static warmthParts(warmth: number): string[] {
    const w = clamp(warmth, -100, 100);
    if (w === 0) return [];
    if (w > 0) {
      // Up to ~35% sepia at +100 — a visible but tasteful golden push.
      const sepia = Math.round((w / 100) * 35);
      return [`sepia(${sepia}%)`];
    }
    // Cool: small sepia base + hue rotation toward blue (negative degrees).
    const mag = -w; // 0..100
    const sepia = Math.round((mag / 100) * 18);
    const rotate = Math.round((mag / 100) * 40); // up to -40deg
    return [`sepia(${sepia}%)`, `hue-rotate(-${rotate}deg)`];
  }

  /**
   * Per-pixel grade fallback for the (rare) engine without `ctx.filter`. We only
   * approximate the primitives we actually emit — brightness, contrast, saturate
   * and warmth — because a faithful CSS-filter reimplementation is out of scope
   * for a v0. This runs on the already-drawn destination pixels in place.
   *
   * NOTE: this path is best-effort. If reading pixels throws (tainted canvas) we
   * swallow it and leave the un-graded image rather than crashing — export from
   * a tainted canvas would fail later anyway with a clear message.
   */
  private static applyGradeFallback(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    state: OpsState
  ): void {
    let img: ImageData;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch {
      return; // tainted / unreadable — leave as-is
    }
    const d = img.data;

    const a = state.adjust;
    const bright = a.brightness / 100; // multiplicative
    const contrast = a.contrast / 100;
    const sat = a.saturate / 100;
    // Warmth as a simple channel bias: warm lifts R, drops B; cool the inverse.
    const warmBias = (a.warmth / 100) * 30; // ±30 on 0..255 channels

    // For the `bw` preset the JS fallback should also desaturate fully.
    const forceGray = state.filter === 'bw';
    // A rough saturation floor for presets that desaturate/boost — we fold the
    // preset's saturate into the manual one so the look is at least directional.
    const presetSat = VpicEngine.presetApproxSaturate(state.filter);
    const effSat = forceGray ? 0 : sat * presetSat;

    // Contrast pivots around mid-grey (128). Precompute the intercept.
    const contrastInt = 128 * (1 - contrast);

    for (let i = 0; i < d.length; i += 4) {
      let r = d[i];
      let g = d[i + 1];
      let b = d[i + 2];

      // Brightness (multiplicative) then contrast (around 128).
      r = r * bright * contrast + contrastInt;
      g = g * bright * contrast + contrastInt;
      b = b * bright * contrast + contrastInt;

      // Saturation via luma-preserving lerp toward grey.
      if (effSat !== 1) {
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = luma + (r - luma) * effSat;
        g = luma + (g - luma) * effSat;
        b = luma + (b - luma) * effSat;
      }

      // Warmth channel bias.
      if (warmBias !== 0) {
        r += warmBias;
        b -= warmBias;
      }

      d[i] = clamp(r, 0, 255);
      d[i + 1] = clamp(g, 0, 255);
      d[i + 2] = clamp(b, 0, 255);
      // alpha (d[i+3]) untouched
    }

    ctx.putImageData(img, 0, 0);
  }

  /** A coarse saturation multiplier per preset, for the JS fallback only. */
  private static presetApproxSaturate(f: VpicFilterId): number {
    switch (f) {
      case 'vivid':
        return 1.45;
      case 'product':
        return 1.12;
      case 'warm':
        return 1.1;
      case 'soft':
        return 0.85;
      case 'cool':
        return 0.92;
      default:
        return 1;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Text overlays
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Draw all overlays onto the destination context at the given size. Called
   * AFTER the image layer so text is never blurred/desaturated by the grade.
   *
   * Coordinate contract:
   *  · x,y are 0..1 of the destination width/height. `x` is the ANCHOR whose
   *    meaning depends on `align` (left => left edge, center => centre, right =>
   *    right edge). `y` positions the text's vertical CENTRE (we use
   *    textBaseline='middle') so sliders feel predictable.
   *  · `size` is a fraction of destination HEIGHT, converted to px here — so the
   *    same overlay renders proportionally in the 1600px preview and the
   *    full-res export.
   *  · RTL: when `rtl` is true we set ctx.direction='rtl'. For Arabic (darja)
   *    the natural reading anchor is the right edge, so an author-chosen 'left'
   *    align is mapped to the physical side that matches the writing direction
   *    (see alignToTextAlign). We also draw a subtle shadow for legibility over
   *    busy photos — a common, expected touch for social captions.
   */
  private drawTexts(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number
  ): void {
    const texts = this.state.texts;
    if (!texts.length) return;

    for (const t of texts) {
      const px = clamp(t.size, 0, 1) * h;
      if (px < 1) continue; // invisible
      const weight = t.bold ? '700' : '400';
      // A widely-available system font stack; no web-font dependency. Arabic
      // glyphs fall back through the stack on the target platforms.
      ctx.save();
      ctx.font = `${weight} ${px}px "Helvetica Neue", Arial, "Segoe UI", "Noto Sans Arabic", sans-serif`;
      ctx.direction = t.rtl ? 'rtl' : 'ltr';
      ctx.textAlign = VpicEngine.alignToTextAlign(t.align, t.rtl);
      ctx.textBaseline = 'middle';
      ctx.fillStyle = typeof t.color === 'string' ? t.color : '#ffffff';

      // Legibility shadow — soft dark halo, scaled to the font size.
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = Math.max(1, px * 0.06);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = Math.max(1, px * 0.03);

      const dx = clamp(t.x, 0, 1) * w;
      const dy = clamp(t.y, 0, 1) * h;
      // fillText handles the bidi run internally given ctx.direction; we pass the
      // raw string so mixed Latin/Arabic captions lay out correctly.
      ctx.fillText(t.text, dx, dy);
      ctx.restore();
    }
  }

  /**
   * Map our logical `align` + `rtl` to a Canvas `textAlign`. In RTL we want the
   * *logical* start ('left' in the UI sense of "beginning of text") to sit on
   * the right, matching how darja reads. We use the physical 'left'/'right'
   * values (not 'start'/'end') so behaviour is identical across browsers that
   * disagree on start/end + direction interplay.
   */
  private static alignToTextAlign(
    align: 'left' | 'center' | 'right',
    rtl: boolean
  ): CanvasTextAlign {
    if (align === 'center') return 'center';
    if (!rtl) return align; // ltr: left→left, right→right
    // rtl: swap so "start of reading" (left in UI) anchors on the right.
    return align === 'left' ? 'right' : 'left';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Serialization (ops only — replayable onto the same source)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Serialize the current ops-state to JSON. Contains NO pixels and NO source
   * reference — just the transform description — so it's tiny (well under the
   * backend's 256KB project cap) and replays deterministically via
   * {@link applyStateJSON}. We stamp a `v` version so future schema changes can
   * migrate gracefully.
   */
  toStateJSON(): string {
    const s = this.state;
    return JSON.stringify({
      v: 1,
      crop: s.crop,
      rotationQuarters: s.rotationQuarters,
      flipH: s.flipH,
      flipV: s.flipV,
      targetW: s.targetW,
      targetH: s.targetH,
      adjust: s.adjust,
      filter: s.filter,
      texts: s.texts,
    });
  }

  /**
   * Replace the current state with one parsed from JSON produced by
   * {@link toStateJSON} (or a compatible project payload). This IS a mutation —
   * it snapshots the present for undo so loading a project can be undone.
   *
   * FAIL-SOFT: any malformed input (bad JSON, wrong shape, out-of-range values)
   * results in a NO-OP that keeps the current state intact — we never throw and
   * never partially apply a corrupt state. Each field is validated/coerced
   * defensively against the same ranges the mutators enforce.
   */
  applyStateJSON(json: string): void {
    const parsed = VpicEngine.safeParseState(json);
    if (!parsed) return; // invalid → keep current state, no snapshot

    this.beginMutation();
    this.state = parsed;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Defensive parsers / sanitisers (static, pure)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Parse + fully validate a state JSON string into an OpsState, or return null
   * if anything is off. Kept separate from applyStateJSON so the validation is
   * unit-testable and side-effect-free.
   */
  private static safeParseState(json: string): OpsState | null {
    if (typeof json !== 'string' || !json) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;

    // Crop rect — every field must be a finite number in 0..1 and form a
    // non-degenerate rect. Fall back to full-frame if the crop is missing but
    // the rest is valid? No — a missing crop signals a malformed payload, so we
    // default it to full-frame ONLY when it's absent, and reject when present
    // but broken (stricter = safer against silent corruption).
    let crop: CropRect;
    if (o.crop === undefined) {
      crop = { x: 0, y: 0, w: 1, h: 1 };
    } else {
      const c = VpicEngine.parseCrop(o.crop);
      if (!c) return null;
      crop = c;
    }

    const rotationQuarters = VpicEngine.parseQuarters(o.rotationQuarters);
    if (rotationQuarters === null) return null;

    const flipH = VpicEngine.asBool(o.flipH);
    const flipV = VpicEngine.asBool(o.flipV);

    const targetW = VpicEngine.parseNullableDim(o.targetW);
    const targetH = VpicEngine.parseNullableDim(o.targetH);
    if (targetW === undefined || targetH === undefined) return null;

    const adjust = VpicEngine.parseAdjust(o.adjust);
    if (!adjust) return null;

    const filter = VpicEngine.isFilterId(o.filter)
      ? (o.filter as VpicFilterId)
      : 'none';

    const texts = VpicEngine.parseTexts(o.texts);

    return {
      crop,
      rotationQuarters,
      flipH,
      flipV,
      targetW,
      targetH,
      adjust,
      filter,
      texts,
    };
  }

  /** Validate a crop-rect-shaped value into a CropRect, or null. */
  private static parseCrop(v: unknown): CropRect | null {
    if (!v || typeof v !== 'object') return null;
    const c = v as Record<string, unknown>;
    const x = VpicEngine.asUnit(c.x);
    const y = VpicEngine.asUnit(c.y);
    const w = VpicEngine.asUnit(c.w);
    const h = VpicEngine.asUnit(c.h);
    if (x === null || y === null || w === null || h === null) return null;
    if (w <= 0 || h <= 0) return null;
    if (x + w > 1.0001 || y + h > 1.0001) return null; // tiny epsilon slack
    return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
  }

  /** Finite number in 0..1, or null. */
  private static asUnit(v: unknown): number | null {
    return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1 ? v : null;
  }

  /** Normalise a quarter count to 0..3, or null if not a finite integer-ish. */
  private static parseQuarters(v: unknown): number | null {
    if (typeof v !== 'number' || !isFinite(v)) return null;
    const q = ((Math.round(v) % 4) + 4) % 4;
    return q;
  }

  /** Nullable positive px dimension: number → rounded≥1; null → null; else undefined (=invalid). */
  private static parseNullableDim(v: unknown): number | null | undefined {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && isFinite(v) && v > 0) return pxDim(v);
    return undefined; // signal invalid
  }

  /** Validate a full VpicAdjust, clamping each field. Missing fields → neutral. */
  private static parseAdjust(v: unknown): VpicAdjust | null {
    if (v === undefined) return neutralAdjust();
    if (!v || typeof v !== 'object') return null;
    const a = v as Record<string, unknown>;
    const num = (x: unknown, def: number, lo: number, hi: number): number =>
      typeof x === 'number' && isFinite(x) ? clamp(x, lo, hi) : def;
    return {
      brightness: num(a.brightness, 100, 0, 200),
      contrast: num(a.contrast, 100, 0, 200),
      saturate: num(a.saturate, 100, 0, 200),
      warmth: num(a.warmth, 0, -100, 100),
    };
  }

  /** Parse + sanitise an array of overlays; drops any malformed entry. */
  private static parseTexts(v: unknown): VpicTextOverlay[] {
    if (!Array.isArray(v)) return [];
    const out: VpicTextOverlay[] = [];
    for (const item of v) {
      const t = VpicEngine.sanitizeText(item);
      if (t) out.push(t);
    }
    return out;
  }

  /**
   * Coerce an arbitrary value into a valid VpicTextOverlay, or null if it can't
   * be salvaged (no usable text). Missing optional-ish fields get sane defaults
   * so a partially-specified overlay from the UI still renders.
   */
  private static sanitizeText(v: unknown): VpicTextOverlay | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text : '';
    if (text.length === 0) return null; // nothing to draw
    const id =
      typeof o.id === 'string' && o.id ? o.id : VpicEngine.makeId();
    const clampUnit = (x: unknown, def: number): number =>
      typeof x === 'number' && isFinite(x) ? clamp(x, 0, 1) : def;
    const align: 'left' | 'center' | 'right' =
      o.align === 'left' || o.align === 'center' || o.align === 'right'
        ? o.align
        : 'left';
    return {
      id,
      text,
      x: clampUnit(o.x, 0.5),
      y: clampUnit(o.y, 0.5),
      // Default caption ~6% of height; clamp to a sane 0.5%..50% range.
      size: (() => {
        const s = clampUnit(o.size, 0.06);
        return clamp(s, 0.005, 0.5);
      })(),
      color: typeof o.color === 'string' ? o.color : '#ffffff',
      bold: VpicEngine.asBool(o.bold),
      align,
      rtl: VpicEngine.asBool(o.rtl),
    };
  }

  /** Truthy → true, else false (never throws). */
  private static asBool(v: unknown): boolean {
    return v === true;
  }

  /** True when `v` is one of the seven pinned filter ids. */
  private static isFilterId(v: unknown): v is VpicFilterId {
    return (
      v === 'none' ||
      v === 'bw' ||
      v === 'vivid' ||
      v === 'soft' ||
      v === 'warm' ||
      v === 'cool' ||
      v === 'product'
    );
  }

  /**
   * Dependency-free unique-ish id for overlays that arrive without one. Not a
   * cryptographic id — just needs to be unique within a session. Combines time
   * and randomness; collisions are astronomically unlikely for UI overlays.
   */
  private static makeId(): string {
    return (
      'txt-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 8)
    );
  }
}
