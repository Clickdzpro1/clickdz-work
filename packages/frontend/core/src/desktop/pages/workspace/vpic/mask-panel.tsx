import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { dirFor, useVpicLang } from '../../../../modules/vpic/i18n';

/**
 * VPIC — Generative-fill mask panel ("Remplissage génératif").
 *
 * The user PAINTS a mask over the source image, types an instruction (FR or
 * darja), and we hand the image + mask to the app's EXISTING image route in
 * TRUE-EDIT mode. The engine sees the source pixels; the mask marks the region
 * to REPLACE. On success we return the resulting image as a Blob via
 * `onApplied(blob)` and the parent (Easel's editor-panel) folds it back into
 * the engine as a new source.
 *
 * === Request format (verified against the backend, DO NOT drift) ===========
 * Route:  POST /api/v1/images/generations   (clickdz-bridge.controller.ts)
 *   • JSON body (NOT multipart — the multipart→OpenAI translation happens
 *     server-side). Auth is the global session cookie (route is NOT @Public),
 *     so we send `credentials: 'include'` and let cdzApiUrl() resolve the
 *     connected-server origin on desktop/native (no-op on web/same-origin).
 *   • Required fields for an edit:
 *       - prompt : non-empty string (the edit INSTRUCTION).
 *       - image  : the SOURCE image. Transported as a base64 `data:` URL
 *                  (`data:image/png;base64,…`) — the backend's fetchImageInput()
 *                  accepts inline base64 png/jpeg/webp data URLs OR public https
 *                  URLs. We use a data URL so no bytes ever leave for a 3rd-party
 *                  host and object-URL/blob sources both work.
 *       - mask   : the painted mask, ALSO a base64 png `data:` URL.
 *       - model  : an explicit CDZIMAGE tier. `CDZIMAGE_REQUIRE_MODEL` may be
 *                  flipped on later; sending one now is future-proof. We use the
 *                  flagship 'cdzimage-2.0' — the same default the Vdz media hook
 *                  sends. (engine = gpt-image-2 → b64_json, url-normalized.)
 *       - mode   : 'edit'  → forces the /v1/images/edits (true image-to-image)
 *                  branch; without it an image still defaults to edit, but we
 *                  are explicit because the whole point of this panel is a mask.
 *       - size   : the OpenAI edit endpoint only accepts a fixed set of square
 *                  sizes; we send '1024x1024' (the backend default) and let the
 *                  parent handle any resize back to the working dimensions.
 *
 * === Mask convention (verified) ============================================
 * This is an OpenAI-style /images/edits call. In that API the mask's
 * TRANSPARENT pixels mark the area to REPLACE and OPAQUE pixels are kept. So the
 * mask we POST is: fully-OPAQUE black everywhere the user did NOT paint, and
 * fully-TRANSPARENT everywhere the user DID paint (their red strokes). We paint
 * in red on-screen purely for visibility; the exported mask is B/W-alpha only.
 *
 * The exported mask is produced at the SOURCE image's NATIVE resolution
 * (sourceWidth × sourceHeight) regardless of on-screen display scale, because
 * OpenAI requires image and mask to share dimensions.
 *
 * Fail-soft: every failure path sets a typed, translated error (vpic.error /
 * vpic.aiUnavailable / vpic.imageTooLarge) and returns — nothing throws past
 * this component. Only pinned `vpic.*` i18n strings are shown.
 */

// Pinned prop shape — Easel lazy-loads this and passes these EXACTLY.
export interface MaskPanelProps {
  sourceUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  onApplied: (blob: Blob) => void;
  onClose: () => void;
}

// Explicit CDZIMAGE tier — mirrors the Vdz media hook so behavior is uniform
// and we're safe if the "model required" flag flips on server-side.
const CDZIMAGE_TIER = 'cdzimage-2.0';
// The /images/edits upstream only accepts a fixed square size set; the backend
// defaults to this and the parent re-fits the result to the working canvas.
const EDIT_SIZE = '1024x1024';

// Brush size bounds (in SOURCE pixels). The on-screen circle is scaled to the
// display, but strokes are recorded at native resolution for a crisp mask.
const BRUSH_MIN = 8;
const BRUSH_MAX = 300;
const BRUSH_DEFAULT = 60;

// Max display width for the editing surface; the canvases keep the source
// aspect ratio and never upscale beyond native.
const MAX_DISPLAY_W = 900;

// Minimal shape of the /images/generations JSON response we consume.
interface ImageGenResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string };
  message?: string;
}

/** Which typed, translated message to surface (all keys are pinned). */
type FailKind = null | 'error' | 'aiUnavailable' | 'imageTooLarge';

/**
 * Load an image element from a URL (object URL, https, or data URL). Set
 * crossOrigin so a remote https source can be drawn to a canvas without
 * tainting it (the source may be a stock https URL). Local blob/object URLs
 * ignore the attribute.
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

/** Canvas → base64 data URL, off the main paint path. */
function canvasToDataUrl(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): string {
  return canvas.toDataURL(type, quality);
}

export default function MaskPanel(props: MaskPanelProps): JSX.Element {
  const { sourceUrl, sourceWidth, sourceHeight, onApplied, onClose } = props;
  const { lang, t } = useVpicLang();
  const dir = dirFor(lang);

  // --- refs -----------------------------------------------------------------
  // Two stacked canvases at NATIVE source resolution: the image below and the
  // painted mask above (semi-transparent red for visibility). We keep the mask
  // at native res so export needs no rescale.
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  // Circle cursor preview lives on its own top layer so painting never has to
  // clear/redraw the mask just to move the cursor.
  const cursorCanvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sourceImgRef = useRef<HTMLImageElement | null>(null);

  // Pointer/stroke state kept in refs (mutated inside event handlers without
  // forcing re-renders on every mouse move).
  const paintingRef = useRef(false);
  const lastPtRef = useRef<{ x: number; y: number } | null>(null);
  const displayScaleRef = useRef(1); // native px per CSS px

  // --- react state ----------------------------------------------------------
  const [brush, setBrush] = useState(BRUSH_DEFAULT);
  const [erasing, setErasing] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [working, setWorking] = useState(false);
  const [fail, setFail] = useState<FailKind>(null);
  const [hasMask, setHasMask] = useState(false);
  const [imgReady, setImgReady] = useState(false);

  // Guard against very large inputs before we even paint (OpenAI edits + the
  // backend's 20MB cap; native dims beyond ~4096 also blow past the edit API).
  const tooLarge = useMemo(
    () =>
      !Number.isFinite(sourceWidth) ||
      !Number.isFinite(sourceHeight) ||
      sourceWidth <= 0 ||
      sourceHeight <= 0 ||
      sourceWidth > 4096 ||
      sourceHeight > 4096,
    [sourceWidth, sourceHeight]
  );

  // Display box: keep source AR, cap width, never upscale past native.
  const display = useMemo(() => {
    if (tooLarge) return { w: 0, h: 0 };
    const cap = Math.min(MAX_DISPLAY_W, sourceWidth);
    const w = Math.max(1, Math.round(cap));
    const h = Math.max(1, Math.round((sourceHeight / sourceWidth) * w));
    return { w, h };
  }, [sourceWidth, sourceHeight, tooLarge]);

  // native px per CSS px — the multiplier that turns a pointer position (CSS)
  // into a mask coordinate (native). Kept in a ref for the hot paint path.
  useLayoutEffect(() => {
    displayScaleRef.current = display.w > 0 ? sourceWidth / display.w : 1;
  }, [display.w, sourceWidth]);

  // --- load + paint the source image once ----------------------------------
  useEffect(() => {
    if (tooLarge) {
      setFail('imageTooLarge');
      return;
    }
    let cancelled = false;
    setImgReady(false);
    loadImage(sourceUrl)
      .then(img => {
        if (cancelled) return;
        sourceImgRef.current = img;
        const c = imageCanvasRef.current;
        if (c) {
          c.width = sourceWidth;
          c.height = sourceHeight;
          const ctx = c.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, sourceWidth, sourceHeight);
            ctx.drawImage(img, 0, 0, sourceWidth, sourceHeight);
          }
        }
        // Size the mask + cursor canvases to native res (transparent to start).
        for (const ref of [maskCanvasRef, cursorCanvasRef]) {
          const cv = ref.current;
          if (cv) {
            cv.width = sourceWidth;
            cv.height = sourceHeight;
          }
        }
        setImgReady(true);
      })
      .catch(() => {
        if (!cancelled) setFail('error');
      });
    return () => {
      cancelled = true;
    };
  }, [sourceUrl, sourceWidth, sourceHeight, tooLarge]);

  // --- coordinate mapping ---------------------------------------------------
  // Turn a pointer event into NATIVE mask coordinates. We read the mask
  // canvas's on-screen rect (it always overlays the image 1:1) and scale.
  const toNative = useCallback((clientX: number, clientY: number) => {
    const c = maskCanvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    const sx = rect.width > 0 ? c.width / rect.width : 1;
    const sy = rect.height > 0 ? c.height / rect.height : 1;
    return {
      x: (clientX - rect.left) * sx,
      y: (clientY - rect.top) * sy,
    };
  }, []);

  // Stamp a filled dot in RED (visible) into the mask at a native point. When
  // erasing we clear instead (destination-out).
  const stamp = useCallback(
    (x: number, y: number) => {
      const ctx = maskCanvasRef.current?.getContext('2d');
      if (!ctx) return;
      const r = brush / 2;
      ctx.save();
      if (erasing) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalCompositeOperation = 'source-over';
        // Semi-transparent red so the underlying image stays visible while
        // painting. The EXPORT step re-derives a clean B/W-alpha mask from the
        // painted alpha — this on-screen color never reaches the API.
        ctx.fillStyle = 'rgba(255, 45, 45, 0.55)';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
    [brush, erasing]
  );

  // Connect two stamps with a thick round line so fast drags stay continuous.
  const strokeSegment = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const ctx = maskCanvasRef.current?.getContext('2d');
      if (!ctx) return;
      ctx.save();
      ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
      ctx.strokeStyle = 'rgba(255, 45, 45, 0.55)';
      ctx.lineWidth = brush;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.restore();
    },
    [brush, erasing]
  );

  // Draw/refresh the circle cursor preview (top layer) at a native point.
  const drawCursor = useCallback((x: number, y: number) => {
    const c = cursorCanvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, brushRef.current / 2, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, displayScaleRef.current); // ~1 CSS px
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, brushRef.current / 2, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, displayScaleRef.current) / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.restore();
  }, []);

  // Keep a live brush value for the cursor draw (which is not in its deps to
  // stay cheap on move); a ref avoids stale closures without re-binding events.
  const brushRef = useRef(brush);
  useEffect(() => {
    brushRef.current = brush;
  }, [brush]);

  const clearCursor = useCallback(() => {
    const c = cursorCanvasRef.current;
    const ctx = c?.getContext('2d');
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
  }, []);

  // --- pointer handlers (mouse + touch via Pointer Events) -----------------
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!imgReady || working) return;
      e.preventDefault();
      // Capture so a drag that leaves the canvas keeps painting.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw on some engines — non-fatal.
      }
      paintingRef.current = true;
      const p = toNative(e.clientX, e.clientY);
      lastPtRef.current = p;
      stamp(p.x, p.y);
      drawCursor(p.x, p.y);
      setHasMask(true);
      setFail(null);
    },
    [imgReady, working, toNative, stamp, drawCursor]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!imgReady) return;
      const p = toNative(e.clientX, e.clientY);
      drawCursor(p.x, p.y);
      if (!paintingRef.current) return;
      e.preventDefault();
      const last = lastPtRef.current;
      if (last) strokeSegment(last, p);
      else stamp(p.x, p.y);
      lastPtRef.current = p;
    },
    [imgReady, toNative, drawCursor, strokeSegment, stamp]
  );

  const endStroke = useCallback((e?: React.PointerEvent<HTMLCanvasElement>) => {
    paintingRef.current = false;
    lastPtRef.current = null;
    if (e) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore — capture may not have been set.
      }
    }
  }, []);

  // Clear the whole mask.
  const clearMask = useCallback(() => {
    const c = maskCanvasRef.current;
    const ctx = c?.getContext('2d');
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
    setHasMask(false);
  }, []);

  // --- export helpers -------------------------------------------------------
  // Produce the API mask at NATIVE resolution from the painted alpha:
  //   painted (alpha>0)  → TRANSPARENT  (area to REPLACE, per OpenAI edits)
  //   unpainted          → OPAQUE black (area to KEEP)
  const buildApiMaskDataUrl = useCallback((): string | null => {
    const src = maskCanvasRef.current;
    if (!src) return null;
    const srcCtx = src.getContext('2d');
    if (!srcCtx) return null;
    const { width, height } = src;
    const painted = srcCtx.getImageData(0, 0, width, height);

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const outCtx = out.getContext('2d');
    if (!outCtx) return null;
    const dst = outCtx.createImageData(width, height);
    const sd = painted.data;
    const dd = dst.data;
    for (let i = 0; i < sd.length; i += 4) {
      const paintedHere = sd[i + 3] > 10; // any meaningful alpha counts
      // Black RGB throughout; only alpha carries the keep/replace signal.
      dd[i] = 0;
      dd[i + 1] = 0;
      dd[i + 2] = 0;
      dd[i + 3] = paintedHere ? 0 : 255;
    }
    outCtx.putImageData(dst, 0, 0);
    return canvasToDataUrl(out, 'image/png');
  }, []);

  // Produce the SOURCE image as a data URL at native res (PNG keeps it lossless
  // and matches the mask's alpha-png; the backend accepts png/jpeg/webp).
  const buildSourceDataUrl = useCallback((): string | null => {
    const c = imageCanvasRef.current;
    if (!c) return null;
    try {
      return canvasToDataUrl(c, 'image/png');
    } catch {
      // A tainted canvas (cross-origin source that refused CORS) can't export.
      return null;
    }
  }, []);

  // --- the generative-fill call --------------------------------------------
  const runFill = useCallback(async () => {
    if (working) return;
    setFail(null);

    const instruction = prompt.trim();
    if (!instruction) {
      setFail('error');
      return;
    }
    if (!hasMask) {
      setFail('error');
      return;
    }
    if (tooLarge) {
      setFail('imageTooLarge');
      return;
    }

    const imageDataUrl = buildSourceDataUrl();
    const maskDataUrl = buildApiMaskDataUrl();
    if (!imageDataUrl || !maskDataUrl) {
      // Most likely a tainted (cross-origin) source canvas.
      setFail('error');
      return;
    }

    setWorking(true);
    try {
      // JSON body — matches clickdz-bridge.controller.ts imageGenerations().
      // image + mask ride as base64 data URLs; mode:'edit' forces true i2i;
      // model is explicit; size is the backend's square default.
      const payload: Record<string, unknown> = {
        prompt: instruction,
        model: CDZIMAGE_TIER,
        mode: 'edit',
        image: imageDataUrl,
        mask: maskDataUrl,
        size: EDIT_SIZE,
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
        // 503 = key not configured → "AI unavailable"; 413 = too large.
        if (response.status === 503) setFail('aiUnavailable');
        else if (response.status === 413) setFail('imageTooLarge');
        else setFail('error');
        return;
      }

      // Backend normalizes b64_json → a data: URL, so `url` is always present
      // on success. Fetch it back into a Blob for onApplied().
      const first = data?.data?.[0];
      const url = first?.url;
      if (typeof url !== 'string' || !url) {
        setFail('error');
        return;
      }

      let blob: Blob;
      try {
        const imgResp = await fetch(url);
        if (!imgResp.ok) {
          setFail('error');
          return;
        }
        blob = await imgResp.blob();
      } catch {
        setFail('error');
        return;
      }

      onApplied(blob);
    } catch {
      // Network/abort/anything unexpected: treat AI as unavailable, never throw.
      setFail('aiUnavailable');
    } finally {
      setWorking(false);
    }
  }, [
    working,
    prompt,
    hasMask,
    tooLarge,
    buildSourceDataUrl,
    buildApiMaskDataUrl,
    onApplied,
  ]);

  // --- styles (inline, matching the Vdz page's inline-style idiom) ----------
  const overlay: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 16,
  };
  const modal: React.CSSProperties = {
    background: 'var(--affine-background-primary-color, #fff)',
    color: 'var(--affine-text-primary-color, #111)',
    borderRadius: 12,
    boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
    maxWidth: 'min(96vw, 980px)',
    maxHeight: '92vh',
    overflow: 'auto',
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  };
  const headerRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  };
  const toolRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  };
  const canvasWrap: React.CSSProperties = {
    position: 'relative',
    width: display.w,
    height: display.h,
    maxWidth: '100%',
    margin: '0 auto',
    borderRadius: 8,
    overflow: 'hidden',
    background:
      'repeating-conic-gradient(#e6e6e6 0% 25%, #f6f6f6 0% 50%) 50% / 20px 20px',
    touchAction: 'none', // let us own touch gestures for painting
    cursor: imgReady ? 'none' : 'default', // custom circle cursor stands in
  };
  const layered: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    display: 'block',
  };
  const btn: React.CSSProperties = {
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid var(--affine-border-color, #ddd)',
    background: 'var(--affine-background-secondary-color, #f5f5f5)',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 14,
  };
  const primaryBtn: React.CSSProperties = {
    ...btn,
    border: 'none',
    background: 'var(--affine-primary-color, #1e6fff)',
    color: '#fff',
    fontWeight: 600,
    opacity: working ? 0.7 : 1,
  };
  const toggleBtn = (active: boolean): React.CSSProperties => ({
    ...btn,
    background: active
      ? 'var(--affine-primary-color, #1e6fff)'
      : 'var(--affine-background-secondary-color, #f5f5f5)',
    color: active ? '#fff' : 'inherit',
  });
  const errorBox: React.CSSProperties = {
    background: 'rgba(255, 76, 76, 0.12)',
    color: 'var(--affine-error-color, #d33)',
    border: '1px solid rgba(255,76,76,0.35)',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 14,
  };
  const promptInput: React.CSSProperties = {
    flex: 1,
    minWidth: 200,
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--affine-border-color, #ddd)',
    background: 'var(--affine-background-primary-color, #fff)',
    color: 'inherit',
    fontSize: 14,
  };
  const label: React.CSSProperties = { fontSize: 13, opacity: 0.85 };

  // Map the typed failure to a pinned, translated message.
  const failMessage =
    fail === 'aiUnavailable'
      ? t('vpic.aiUnavailable')
      : fail === 'imageTooLarge'
        ? t('vpic.imageTooLarge')
        : fail === 'error'
          ? t('vpic.error')
          : '';

  return (
    <div
      style={overlay}
      dir={dir}
      role="dialog"
      aria-modal="true"
      onPointerDown={e => {
        // click the dim backdrop (not the modal) to close, unless working.
        if (e.target === e.currentTarget && !working) onClose();
      }}
    >
      <div style={modal}>
        <div style={headerRow}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {t('vpic.genFill')}
            </div>
            <div style={{ fontSize: 13, opacity: 0.75, marginTop: 2 }}>
              {t('vpic.genFillHint')}
            </div>
          </div>
          <button
            type="button"
            style={btn}
            onClick={onClose}
            disabled={working}
          >
            {t('vpic.close')}
          </button>
        </div>

        {/* Painting toolbar: paint/erase, brush size, clear. */}
        <div style={toolRow}>
          <button
            type="button"
            style={toggleBtn(!erasing)}
            onClick={() => setErasing(false)}
            disabled={working}
          >
            {t('vpic.maskPaint')}
          </button>
          <button
            type="button"
            style={toggleBtn(erasing)}
            onClick={() => setErasing(true)}
            disabled={working}
          >
            {/* No dedicated "erase" key is pinned; reuse the reset label to
                mean "erase mode" for the brush. */}
            {t('vpic.reset')}
          </button>
          <button
            type="button"
            style={btn}
            onClick={clearMask}
            disabled={working || !hasMask}
          >
            {t('vpic.maskClear')}
          </button>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginInlineStart: 'auto',
            }}
          >
            <span style={label}>{t('vpic.brushSize')}</span>
            <input
              type="range"
              min={BRUSH_MIN}
              max={BRUSH_MAX}
              value={brush}
              onChange={e => setBrush(Number(e.target.value))}
              disabled={working}
              aria-label={t('vpic.brushSize')}
            />
            <span style={{ ...label, width: 40, textAlign: 'center' }}>
              {brush}
            </span>
          </div>
        </div>

        {/* Stacked canvases: image (bottom), red mask (middle), cursor (top). */}
        <div ref={wrapRef} style={canvasWrap}>
          <canvas ref={imageCanvasRef} style={layered} />
          <canvas ref={maskCanvasRef} style={{ ...layered, opacity: 1 }} />
          <canvas
            ref={cursorCanvasRef}
            style={{ ...layered, pointerEvents: 'auto' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onPointerLeave={() => {
              clearCursor();
              // don't end the stroke on leave — pointer capture keeps it going;
              // but if not painting, just hide the cursor.
            }}
          />
        </div>

        {/* Prompt + go. */}
        <div style={toolRow}>
          <input
            type="text"
            style={promptInput}
            value={prompt}
            placeholder={t('vpic.fillPrompt')}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !working) runFill();
            }}
            disabled={working}
            dir={dir}
          />
          <button
            type="button"
            style={primaryBtn}
            onClick={runFill}
            disabled={working || !imgReady}
          >
            {working ? t('vpic.working') : t('vpic.fillGo')}
          </button>
        </div>

        {failMessage ? <div style={errorBox}>{failMessage}</div> : null}
      </div>
    </div>
  );
}
