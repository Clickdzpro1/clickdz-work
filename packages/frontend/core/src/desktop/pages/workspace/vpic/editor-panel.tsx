import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { nanoid } from 'nanoid';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { dirFor, useVpicLang } from '../../../../modules/vpic/i18n';
import {
  type VpicAdjust,
  VpicEngine,
  type VpicFilterId,
  type VpicTextOverlay,
} from '../../../../modules/vpic/editor-engine';
import {
  useVpicMedia,
  type VpicImageHandle,
} from '../../../../modules/vpic/use-vpic-media';

/**
 * VPIC Studio — the working editor panel (Easel).
 *
 * This is the studio's whole heavy surface, lazily loaded by index.tsx so it
 * rides in its own route chunk (it pulls in the Canvas2D {@link VpicEngine},
 * the media hook, and a further-lazy mask panel — none of which belong in the
 * page's first paint).
 *
 * LAYOUT: a clean two-column workspace — the canvas preview on the left (grows
 * to fill), a scrollable tool rail on the right. The whole panel is RTL-aware:
 * it reads the current writing direction from {@link dirFor} and stamps `dir`
 * on the root, so in darja (Arabic script) the rail flips to the other side and
 * text/inputs mirror with zero per-control work.
 *
 * ENGINE MODEL: the {@link VpicEngine} is framework-free and non-destructive —
 * every mutator (crop/rotate/flip/resize/adjust/filter/text) pushes an undo
 * snapshot of the OPS (not pixels). React never owns the engine's pixels; we
 * hold the instance in a ref and force a canvas re-render + a control re-read by
 * bumping a `rev` counter after every engine change (see {@link bump}). That is
 * the single source of truth for "the engine changed, repaint".
 *
 * NETWORK: caps + projects go through `cdzApiUrl(...)` with `credentials:
 * 'include'`, exactly like the Vdz projects hook — same-origin on web (the
 * session cookie rides along) and server-absolute on desktop. Every fetch is
 * fail-soft: a caps failure lands on the friendly gated-off card, a projects
 * failure surfaces an inline error and keeps the last good list.
 */

// ---- Chunk-within-a-chunk: the mask painter loads only when opened --------
// Generative fill is an occasional action behind a button, and the mask panel
// carries its own brush-canvas + generation transport. It has no place in the
// editor's first paint, so it loads on demand the first time the user opens it.
const MaskPanel = lazy(() => import('./mask-panel'));

// ---- Chunk-within-a-chunk: the text-to-image GENERATE panel ---------------
// Generation is an occasional action behind a button, and the panel carries its
// own generation transport (use-vpic-generate). It has no place in the editor's
// first paint, so it loads on demand the first time the user opens it. It ADOPTS
// the SAME result sink the mask panel uses (`onMaskApplied`, i.e. saveBlob →
// loadFromUrl), so a generated image lands in the engine and every edit tool
// applies to it immediately.
const GeneratePanel = lazy(() => import('./generate-panel'));

// ---- Backend routes (must match ClickDzVpicController EXACTLY) ------------
const CAPS_URL = '/api/v1/vpic/caps';
const PROJECTS_URL = '/api/v1/vpic/projects';
// R15 — the two cdz-pix AI proxy routes. Same session-authed, credentials-
// included fetch idiom as caps/projects + the mask panel's generations call.
const BG_REMOVE_URL = '/api/v1/vpic/bg-remove';
const UPSCALE_URL = '/api/v1/vpic/upscale';

/** The caps envelope — the ONE ungated route; drives FE visibility. */
interface VpicCaps {
  enabled: boolean;
  // R15 — the two AI capabilities (bg-remove + upscale). TRUE only when the
  // feature flag is on AND cdz-pix is wired server-side; each gates its button.
  // Optional on the wire so a pre-R15 backend (no flags) reads as `undefined` →
  // treated as `false` (buttons stay disabled), never a crash.
  bgRemoveEnabled?: boolean;
  upscaleEnabled?: boolean;
}

/** Compact project row from GET /projects (newest-first, no state blob). */
interface VpicProjectSummary {
  id: string;
  name: string;
  // Sentinel F-2: the backend writes Date.now() — epoch MILLISECONDS, not an
  // ISO string (vdz's store uses strings; this one deliberately doesn't).
  updatedAt: number;
}

/** Full stored project from GET /projects/:id. */
interface VpicProjectDoc {
  id: string;
  name: string;
  state: string;
  updatedAt: number;
}

/**
 * The persisted project state: the engine's ops JSON plus the durable source
 * handle so a reload can re-fetch the original bytes and replay the ops. Kept
 * small on purpose (the backend caps `state` at 256KB — ops only, no pixels).
 */
interface VpicProjectState {
  engineState: string;
  source: VpicImageHandle;
}

/** Export formats the engine can emit, paired with their MIME + darja-safe label. */
const EXPORT_FORMATS: Array<{
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  label: string;
  ext: string;
}> = [
  { mime: 'image/png', label: 'PNG', ext: 'png' },
  { mime: 'image/jpeg', label: 'JPEG', ext: 'jpg' },
  { mime: 'image/webp', label: 'WebP', ext: 'webp' },
];

/** The seven filters, in the order they render as chips. Names come from i18n. */
const FILTERS: Array<{ id: VpicFilterId; key: string }> = [
  { id: 'none', key: 'vpic.filterNone' },
  { id: 'bw', key: 'vpic.filterBw' },
  { id: 'vivid', key: 'vpic.filterVivid' },
  { id: 'soft', key: 'vpic.filterSoft' },
  { id: 'warm', key: 'vpic.filterWarm' },
  { id: 'cool', key: 'vpic.filterCool' },
  { id: 'product', key: 'vpic.filterProduct' },
];

/** Crop presets. `ar` is the target aspect ratio (w/h); null = free (no-op v0). */
const CROP_PRESETS: Array<{ key: string; ar: number | null }> = [
  { key: 'vpic.cropFree', ar: null },
  { key: 'vpic.cropSquare', ar: 1 / 1 },
  { key: 'vpic.crop45', ar: 4 / 5 },
  { key: 'vpic.cropStory', ar: 9 / 16 },
  { key: 'vpic.cropWide', ar: 16 / 9 },
  { key: 'vpic.cropListing', ar: 4 / 3 },
];

/** Resize width presets (social-friendly). Height derives from current aspect. */
const RESIZE_PRESETS = [1080, 1350, 1920];

/** Neutral adjustment baseline (100 = neutral for the first three; 0 warmth). */
const NEUTRAL_ADJUST: VpicAdjust = {
  brightness: 100,
  contrast: 100,
  saturate: 100,
  warmth: 0,
};

/** True for text targets whose focus should swallow the Ctrl+Z/Y keybinds. */
function isEditableTarget(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    node.isContentEditable
  );
}

/**
 * Compute the largest centered crop (in 0..1 relative coords) that fits a target
 * aspect ratio inside the current output dims. `engine.crop` takes relative
 * coords against the CURRENT output, so we only need the current aspect.
 */
function centeredCropForAspect(
  targetAspect: number,
  currentWidth: number,
  currentHeight: number
): { x: number; y: number; w: number; h: number } {
  const currentAspect =
    currentWidth > 0 && currentHeight > 0 ? currentWidth / currentHeight : 1;
  if (targetAspect >= currentAspect) {
    // Target is wider (or equal): keep full width, shrink height, center it.
    const h = currentAspect / targetAspect;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  // Target is taller: keep full height, shrink width, center it.
  const w = targetAspect / currentAspect;
  return { x: (1 - w) / 2, y: 0, w, h: 1 };
}

/**
 * Normalize a cdz-pix `imageBase64` reply into a `data:` URL. The service may
 * return either a bare base64 payload or an already-prefixed data URL; we accept
 * both and default to PNG (bg-remove yields a transparent PNG, upscale a PNG).
 */
function toDataUrl(imageBase64: string): string {
  return imageBase64.startsWith('data:')
    ? imageBase64
    : `data:image/png;base64,${imageBase64}`;
}

/**
 * Decode a cdz-pix `imageBase64` reply into a Blob so it can flow back into the
 * engine through the SAME result path the mask panel uses (`onApplied`, which
 * saveBlob → loadFromUrl). `fetch()` on a data URL is the same decode step the
 * mask panel already relies on for its own result image — no extra transport.
 */
async function dataUrlToBlob(imageBase64: string): Promise<Blob> {
  const resp = await fetch(toDataUrl(imageBase64));
  return resp.blob();
}

export function VpicEditorPanel() {
  const { lang, t } = useVpicLang();
  const dir = dirFor(lang);

  // ---- Caps gate ---------------------------------------------------------
  // The one ungated route. `null` = still checking; drives the loading vs
  // gated-off vs editor branch below. Fail-soft: any error reads as "off".
  const [caps, setCaps] = useState<VpicCaps | null>(null);
  const [capsChecked, setCapsChecked] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(cdzApiUrl(CAPS_URL), {
          credentials: 'include',
        });
        const data = (await res.json().catch(() => null)) as VpicCaps | null;
        if (alive) setCaps(data && res.ok ? data : { enabled: false });
      } catch {
        // Network / offline — treat as gated off (same spirit as the ERP
        // activation-pending cards: a friendly wall, never a crash).
        if (alive) setCaps({ enabled: false });
      } finally {
        if (alive) setCapsChecked(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ---- Engine + repaint tick ---------------------------------------------
  // The engine lives in a ref (React never owns its pixels). `rev` is bumped
  // after every engine change to (a) repaint the canvas and (b) re-read control
  // values (adjust/filter/texts/dims) that live inside the engine. `hasImage`
  // gates the whole editing UI until an image is opened.
  const engineRef = useRef<VpicEngine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // `rev` is the repaint tick: every engine mutation calls bump() to increment
  // it, which both re-runs the render effect (keyed on rev) and re-reads the
  // engine-owned control values (dims / canUndo / canRedo) on the next render.
  const [rev, setRev] = useState(0);
  const bump = useCallback(() => setRev(r => r + 1), []);
  const [hasImage, setHasImage] = useState(false);

  // The durable handle for the CURRENTLY-loaded source image (for project
  // persistence: we save the handle, not the bytes, and re-resolve on open).
  const [sourceHandle, setSourceHandle] = useState<VpicImageHandle | null>(null);

  // Local UI state mirrored from the engine so sliders/chips are controlled.
  // Seeded from the engine on load/undo/redo via `syncFromEngine`.
  const [adjust, setAdjust] = useState<VpicAdjust>(NEUTRAL_ADJUST);
  const [filter, setFilter] = useState<VpicFilterId>('none');
  const [texts, setTexts] = useState<VpicTextOverlay[]>([]);
  // A ref mirror of `adjust` so the slider handler can build the next value
  // from the current one WITHOUT reading it inside a setState updater (updaters
  // must be side-effect-free — StrictMode invokes them twice, which would push a
  // duplicate engine snapshot onto the undo stack).
  const adjustRef = useRef<VpicAdjust>(adjust);
  adjustRef.current = adjust;

  const media = useVpicMedia();

  // ---- Canvas render: repaint on EVERY engine change ---------------------
  // Keyed on `rev` (bumped by every mutator) and `hasImage` (the canvas mounts
  // when an image is present), so it repaints exactly when the engine changed or
  // the canvas (re)mounts — not on unrelated typing. The engine fits itself to
  // its default maxDim; we let it own sizing.
  useEffect(() => {
    const eng = engineRef.current;
    const canvas = canvasRef.current;
    if (!eng || !canvas || !hasImage) return;
    try {
      eng.renderTo(canvas);
    } catch {
      // A transient draw failure must not white-screen the studio.
    }
  }, [rev, hasImage]);

  // Pull the engine's current op values into local control state. Called after
  // any load/undo/redo/applyState so the sliders/chips/text-list reflect truth.
  const syncFromEngine = useCallback(() => {
    // The engine is the source of truth for its state, but its ops are private;
    // we keep the last values we SET as the mirror (the engine replays them).
    // On undo/redo we cannot read them back through the pinned interface, so we
    // conservatively leave the mirror as-is for adjust/filter/texts — the canvas
    // still repaints correctly from the engine. (A future engine getter would
    // let us reflect undone slider positions; out of scope for v0.)
    bump();
  }, [bump]);

  // ---- Open image: shared loader ----------------------------------------
  // Build a fresh engine from a resolved object/remote URL, adopt the handle,
  // reset the control mirror to neutral, and repaint. Any failure is fail-soft.
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const loadFromUrl = useCallback(
    async (url: string, handle: VpicImageHandle | null) => {
      setOpening(true);
      setOpenError(null);
      try {
        const eng = await VpicEngine.fromUrl(url);
        engineRef.current = eng;
        setSourceHandle(handle);
        setAdjust(NEUTRAL_ADJUST);
        setFilter('none');
        setTexts([]);
        setHasImage(true);
        bump();
      } catch {
        setOpenError(t('vpic.error'));
      } finally {
        setOpening(false);
      }
    },
    [bump, t]
  );

  const onPickLocal = useCallback(async () => {
    const picked = await media.pickLocal();
    if (!picked) return;
    await loadFromUrl(picked.url, picked.handle);
  }, [media, loadFromUrl]);

  // Import-from-URL (paste a link). Kept behind a tiny inline input row.
  const [urlDraft, setUrlDraft] = useState('');
  const onImportUrl = useCallback(async () => {
    const url = urlDraft.trim();
    if (!url) return;
    const imported = await media.importFromUrl(url, 'vpic-url');
    if (!imported) {
      setOpenError(t('vpic.error'));
      return;
    }
    setUrlDraft('');
    await loadFromUrl(imported.url, imported.handle);
  }, [urlDraft, media, loadFromUrl, t]);

  // ---- Stock search mini-panel ------------------------------------------
  const [stockOpen, setStockOpen] = useState(false);
  const [stockQuery, setStockQuery] = useState('');
  const [stockBusy, setStockBusy] = useState(false);
  const [stockResults, setStockResults] = useState<
    Array<{ url: string; thumb: string; author: string; source: string }>
  >([]);

  const onStockSearch = useCallback(async () => {
    setStockBusy(true);
    try {
      const results = await media.searchStock(stockQuery.trim());
      setStockResults(results);
    } catch {
      setStockResults([]);
    } finally {
      setStockBusy(false);
    }
  }, [media, stockQuery]);

  const onPickStock = useCallback(
    async (result: { url: string }) => {
      const imported = await media.importFromUrl(result.url, 'vpic-stock');
      if (!imported) {
        setOpenError(t('vpic.error'));
        return;
      }
      setStockOpen(false);
      await loadFromUrl(imported.url, imported.handle);
    },
    [media, loadFromUrl, t]
  );

  // ---- Toolbar ops (each mutates the engine, then bumps) ----------------
  const engine = engineRef.current;

  const applyCropPreset = useCallback(
    (targetAspect: number | null) => {
      const eng = engineRef.current;
      if (!eng) return;
      if (targetAspect === null) return; // Free = leave the frame untouched (v0).
      const rect = centeredCropForAspect(targetAspect, eng.width, eng.height);
      eng.crop(rect.x, rect.y, rect.w, rect.h);
      bump();
    },
    [bump]
  );

  const onRotate = useCallback(
    (dirSign: 1 | -1) => {
      const eng = engineRef.current;
      if (!eng) return;
      eng.rotate90(dirSign);
      bump();
    },
    [bump]
  );

  const onFlip = useCallback(
    (horizontal: boolean) => {
      const eng = engineRef.current;
      if (!eng) return;
      eng.flip(horizontal);
      bump();
    },
    [bump]
  );

  // Resize: width/height inputs (draft state) + presets. Height for a preset
  // derives from the current aspect so the image never distorts on a quick pick.
  const [resizeW, setResizeW] = useState('');
  const [resizeH, setResizeH] = useState('');

  // Seed the resize inputs from the engine's current dims whenever an image is
  // present and the inputs are empty (first open) — a helpful starting value.
  useEffect(() => {
    if (engine && hasImage && resizeW === '' && resizeH === '') {
      setResizeW(String(engine.width));
      setResizeH(String(engine.height));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasImage]);

  const onApplyResize = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    const w = Math.round(Number(resizeW));
    const h = Math.round(Number(resizeH));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return;
    eng.resize(w, h);
    bump();
  }, [resizeW, resizeH, bump]);

  const onResizePreset = useCallback(
    (targetW: number) => {
      const eng = engineRef.current;
      if (!eng) return;
      const aspect = eng.height > 0 ? eng.width / eng.height : 1;
      const targetH = Math.max(1, Math.round(targetW / aspect));
      eng.resize(targetW, targetH);
      setResizeW(String(targetW));
      setResizeH(String(targetH));
      bump();
    },
    [bump]
  );

  // Adjustments: one debounce-free path — set the local mirror AND the engine.
  // Each slider change pushes an engine snapshot; that is fine for v0 (undo
  // steps per drag-release are acceptable and match the "state, not pixels"
  // snapshot model). We commit on change for a live preview. `next` is built
  // from the ref (not inside the setState updater) so the engine mutation runs
  // exactly once even under StrictMode double-invocation.
  const onAdjustChange = useCallback(
    (patch: Partial<VpicAdjust>) => {
      const eng = engineRef.current;
      if (!eng) return;
      const next = { ...adjustRef.current, ...patch };
      eng.setAdjust(next);
      setAdjust(next);
      bump();
    },
    [bump]
  );

  const onFilterPick = useCallback(
    (id: VpicFilterId) => {
      const eng = engineRef.current;
      if (!eng) return;
      eng.setFilter(id);
      setFilter(id);
      bump();
    },
    [bump]
  );

  const onResetAdjust = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.setAdjust(NEUTRAL_ADJUST);
    eng.setFilter('none');
    setAdjust(NEUTRAL_ADJUST);
    setFilter('none');
    bump();
  }, [bump]);

  // ---- Text overlays -----------------------------------------------------
  // The local `texts` array is the editor for the engine's text layer; every
  // edit re-pushes the whole list to the engine (its setter is list-shaped).
  // RTL defaults ON for new overlays in darja so Arabic-script text lays out
  // correctly out of the box.
  const commitTexts = useCallback(
    (next: VpicTextOverlay[]) => {
      const eng = engineRef.current;
      if (!eng) return;
      setTexts(next);
      eng.setTexts(next);
      bump();
    },
    [bump]
  );

  const onAddText = useCallback(() => {
    const overlay: VpicTextOverlay = {
      id: `txt-${nanoid(6)}`,
      text: t('vpic.textPlaceholder'),
      x: 0.5,
      y: 0.5,
      // Sentinel F-1: engine contract — size is a FRACTION of output height
      // (0.005..0.5), not pixels. 0.06 ≈ a comfortable caption size.
      size: 0.06,
      color: '#ffffff',
      bold: false,
      align: 'center',
      rtl: lang === 'ar',
    };
    commitTexts([...texts, overlay]);
  }, [texts, commitTexts, t, lang]);

  const onUpdateText = useCallback(
    (id: string, patch: Partial<VpicTextOverlay>) => {
      commitTexts(texts.map(o => (o.id === id ? { ...o, ...patch } : o)));
    },
    [texts, commitTexts]
  );

  const onDeleteText = useCallback(
    (id: string) => {
      commitTexts(texts.filter(o => o.id !== id));
    },
    [texts, commitTexts]
  );

  // ---- IA: generative fill (lazy mask panel) -----------------------------
  const [maskOpen, setMaskOpen] = useState(false);
  // The source URL the mask panel paints over: the engine's CURRENT full-res
  // render as a PNG blob URL, so the mask lines up with what the user sees.
  const [maskSource, setMaskSource] = useState<{
    url: string;
    width: number;
    height: number;
  } | null>(null);
  // Ref mirror of the mask backdrop's object URL so the unmount cleanup can
  // revoke it exactly once without reading state inside an updater.
  const maskUrlRef = useRef<string | null>(null);

  const onOpenGenFill = useCallback(async () => {
    const eng = engineRef.current;
    if (!eng) return;
    try {
      const blob = await eng.exportBlob('image/png');
      const url = URL.createObjectURL(blob);
      // Revoke any previous backdrop before minting a new one.
      if (maskUrlRef.current) URL.revokeObjectURL(maskUrlRef.current);
      maskUrlRef.current = url;
      setMaskSource({ url, width: eng.width, height: eng.height });
      setMaskOpen(true);
    } catch {
      setOpenError(t('vpic.error'));
    }
  }, [t]);

  // ---- IA: text-to-image generate (lazy generate panel) ------------------
  // Additive, low-risk affordance: open/close a modal that POSTs the existing
  // /api/v1/images/generations route (generation branch) and folds the result
  // into the engine via onMaskApplied. Gated behind the same caps.enabled the
  // whole editor is gated behind (if the image key is off server-side, the
  // route 503s and the panel shows the pinned "AI unavailable" message).
  const [generateOpen, setGenerateOpen] = useState(false);
  const openGenerate = useCallback(() => setGenerateOpen(true), []);
  const closeGenerate = useCallback(() => setGenerateOpen(false), []);

  const closeMask = useCallback(() => {
    setMaskOpen(false);
    // Release the object URL we minted for the painter's backdrop.
    if (maskUrlRef.current) {
      URL.revokeObjectURL(maskUrlRef.current);
      maskUrlRef.current = null;
    }
    setMaskSource(null);
  }, []);

  // The mask panel returns an edited image blob; reload the engine from it (a
  // fresh source) and persist the bytes as the new durable source handle so a
  // save captures the filled result, not the pre-fill original.
  const onMaskApplied = useCallback(
    (blob: Blob) => {
      void (async () => {
        try {
          const saved = await media.saveBlob(blob, 'vpic-genfill');
          await loadFromUrl(saved.url, saved.handle);
        } catch {
          // Fallback: still show the result even if persistence failed, using a
          // transient blob URL (a later save won't capture it — acceptable).
          const url = URL.createObjectURL(blob);
          await loadFromUrl(url, null);
        } finally {
          closeMask();
        }
      })();
    },
    [media, loadFromUrl, closeMask]
  );

  // ---- IA: cdz-pix ops (bg-remove + upscale) -----------------------------
  // The two AI buttons (shipped DISABLED in R14) proxy the CURRENT canvas image
  // to cdz-pix via the VPIC controller and fold the result back into the engine.
  // Enabled only when the matching cap is true; a single in-flight `pixBusy`
  // flag disables both while one runs. Fail-soft: any error surfaces a pinned,
  // translated message and NEVER throws (same stance as the mask panel).
  const [pixBusy, setPixBusy] = useState(false);
  // Which pinned message to show under the AI section: 'aiUnavailable' when the
  // service is off/unconfigured (the caps should already gate this, but the
  // route can still 400), 'error' for anything else. null = no error shown.
  const [pixError, setPixError] = useState<null | 'aiUnavailable' | 'error'>(
    null
  );

  // Shared runner for both ops. Grabs the engine's current full-res render as a
  // base64 data URL (the SAME `exportBlob('image/png')` accessor gen-fill uses),
  // POSTs `{ imageBase64, ...extra }` to the given route (cdzApiUrl + credentials
  // 'include', exactly like the mask panel), then routes the returned
  // `imageBase64` back through `onMaskApplied` (saveBlob → loadFromUrl) — the
  // SAME result path the mask panel's onApplied takes.
  const runPixOp = useCallback(
    async (url: string, extra?: Record<string, unknown>) => {
      if (pixBusy) return;
      const eng = engineRef.current;
      if (!eng) return;
      setPixError(null);

      // Current canvas → base64 data URL. A tainted (cross-origin) canvas can
      // throw on export; treat that as a generic, fail-soft error.
      let imageBase64: string;
      try {
        const blob = await eng.exportBlob('image/png');
        imageBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('read failed'));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(blob);
        });
      } catch {
        setPixError('error');
        return;
      }

      setPixBusy(true);
      try {
        const res = await fetch(cdzApiUrl(url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Route is NOT @Public — it authenticates via the session cookie.
          credentials: 'include',
          body: JSON.stringify({ imageBase64, ...(extra ?? {}) }),
        });
        const data = (await res.json().catch(() => null)) as {
          imageBase64?: unknown;
          error?: { message?: string };
        } | null;
        if (!res.ok) {
          // The controller returns a typed 400 ("not enabled" / "not
          // configured") when the feature/service is off — show the pinned
          // "AI unavailable" wall for that; anything else is a generic error.
          if (res.status === 400) setPixError('aiUnavailable');
          else setPixError('error');
          return;
        }
        if (typeof data?.imageBase64 !== 'string' || !data.imageBase64) {
          setPixError('error');
          return;
        }
        // Decode → Blob and fold back into the engine via the shared result
        // path (saveBlob → loadFromUrl), reusing the mask panel's onApplied.
        const blob = await dataUrlToBlob(data.imageBase64);
        onMaskApplied(blob);
      } catch {
        // Network / abort / unexpected: treat AI as unavailable, never throw.
        setPixError('aiUnavailable');
      } finally {
        setPixBusy(false);
      }
    },
    [pixBusy, onMaskApplied]
  );

  const onBgRemove = useCallback(() => {
    void runPixOp(BG_REMOVE_URL);
  }, [runPixOp]);

  // Upscale 2× — the conservative default (cdz-pix accepts 2 | 4); 2× is the
  // safe CPU-bound choice and keeps the result within the engine's size budget.
  const onUpscale = useCallback(() => {
    void runPixOp(UPSCALE_URL, { scale: 2 });
  }, [runPixOp]);

  // ---- Export ------------------------------------------------------------
  const [exportFmt, setExportFmt] = useState<
    'image/png' | 'image/jpeg' | 'image/webp'
  >('image/png');
  const [quality, setQuality] = useState(0.92);
  const [savedOk, setSavedOk] = useState(false);
  const [exporting, setExporting] = useState(false);

  const currentExt = useMemo(
    () => EXPORT_FORMATS.find(f => f.mime === exportFmt)?.ext ?? 'png',
    [exportFmt]
  );

  const onDownload = useCallback(async () => {
    const eng = engineRef.current;
    if (!eng) return;
    setExporting(true);
    try {
      const blob = await eng.exportBlob(exportFmt, quality);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vpic-${Date.now()}.${currentExt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick so the download has grabbed the bytes.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setOpenError(t('vpic.error'));
    } finally {
      setExporting(false);
    }
  }, [exportFmt, quality, currentExt, t]);

  const onSaveToWorkspace = useCallback(async () => {
    const eng = engineRef.current;
    if (!eng) return;
    setExporting(true);
    setSavedOk(false);
    try {
      const blob = await eng.exportBlob(exportFmt, quality);
      await media.saveBlob(blob, `vpic-export.${currentExt}`);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2500);
    } catch {
      setOpenError(t('vpic.error'));
    } finally {
      setExporting(false);
    }
  }, [exportFmt, quality, currentExt, media, t]);

  // ---- Projects (CRUD against the pinned routes) -------------------------
  const [projects, setProjects] = useState<VpicProjectSummary[] | null>(null);
  const [projectsBusy, setProjectsBusy] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const projectsInFlight = useRef(false);

  const refreshProjects = useCallback(async () => {
    if (projectsInFlight.current) return;
    projectsInFlight.current = true;
    setProjectsBusy(true);
    setProjectsError(null);
    try {
      const res = await fetch(cdzApiUrl(PROJECTS_URL), {
        credentials: 'include',
      });
      const data = (await res.json().catch(() => null)) as
        | VpicProjectSummary[]
        | null;
      if (res.ok && Array.isArray(data)) setProjects(data);
      else setProjectsError(t('vpic.error'));
    } catch {
      setProjectsError(t('vpic.error'));
    } finally {
      projectsInFlight.current = false;
      setProjectsBusy(false);
    }
  }, [t]);

  // Load the list once, as soon as caps report enabled.
  useEffect(() => {
    if (caps?.enabled) void refreshProjects();
  }, [caps?.enabled, refreshProjects]);

  const onSaveProject = useCallback(async () => {
    const eng = engineRef.current;
    if (!eng || !sourceHandle) return;
    const name = window.prompt(t('vpic.projectName'));
    if (name === null) return; // cancelled
    const state: VpicProjectState = {
      engineState: eng.toStateJSON(),
      source: sourceHandle,
    };
    setProjectsBusy(true);
    setProjectsError(null);
    try {
      const res = await fetch(cdzApiUrl(PROJECTS_URL), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || 'VPIC',
          state: JSON.stringify(state),
        }),
      });
      if (!res.ok) {
        setProjectsError(t('vpic.error'));
        return;
      }
      await refreshProjects();
    } catch {
      setProjectsError(t('vpic.error'));
    } finally {
      setProjectsBusy(false);
    }
  }, [sourceHandle, t, refreshProjects]);

  const onOpenProject = useCallback(
    async (id: string) => {
      setProjectsBusy(true);
      setProjectsError(null);
      try {
        const res = await fetch(
          cdzApiUrl(`${PROJECTS_URL}/${encodeURIComponent(id)}`),
          { credentials: 'include' }
        );
        const doc = (await res.json().catch(() => null)) as VpicProjectDoc | null;
        if (!res.ok || !doc) {
          setProjectsError(t('vpic.error'));
          return;
        }
        const parsed = JSON.parse(doc.state) as VpicProjectState;
        // Re-resolve the durable handle to live bytes, rebuild the engine from
        // the source, then replay the saved ops on top.
        const url = await media.resolveUrl(parsed.source);
        if (!url) {
          setProjectsError(t('vpic.error'));
          return;
        }
        const eng = await VpicEngine.fromUrl(url);
        eng.applyStateJSON(parsed.engineState);
        engineRef.current = eng;
        setSourceHandle(parsed.source);
        setHasImage(true);
        // Reset the control mirror to neutral (the pinned engine interface
        // exposes no getters to read applied ops back; the canvas still renders
        // the restored state correctly — the sliders re-baseline on next edit).
        setAdjust(NEUTRAL_ADJUST);
        setFilter('none');
        setTexts([]);
        bump();
      } catch {
        setProjectsError(t('vpic.error'));
      } finally {
        setProjectsBusy(false);
      }
    },
    [media, bump, t]
  );

  const onDeleteProject = useCallback(
    async (id: string) => {
      setProjectsBusy(true);
      setProjectsError(null);
      try {
        const res = await fetch(
          cdzApiUrl(`${PROJECTS_URL}/${encodeURIComponent(id)}`),
          { method: 'DELETE', credentials: 'include' }
        );
        if (!res.ok) {
          setProjectsError(t('vpic.error'));
          return;
        }
        setProjects(prev => (prev ? prev.filter(p => p.id !== id) : prev));
      } catch {
        setProjectsError(t('vpic.error'));
      } finally {
        setProjectsBusy(false);
      }
    },
    [t]
  );

  // ---- Undo / redo (buttons + Ctrl+Z / Ctrl+Shift+Z) --------------------
  const onUndo = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    if (eng.undo()) syncFromEngine();
  }, [syncFromEngine]);

  const onRedo = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    if (eng.redo()) syncFromEngine();
  }, [syncFromEngine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) onRedo();
        else onUndo();
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        onRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onUndo, onRedo]);

  // Cleanup: release the mask backdrop URL if the panel unmounts mid-edit.
  useEffect(() => {
    return () => {
      if (maskUrlRef.current) {
        URL.revokeObjectURL(maskUrlRef.current);
        maskUrlRef.current = null;
      }
    };
  }, []);

  const canUndo = engine?.canUndo() ?? false;
  const canRedo = engine?.canRedo() ?? false;

  // R15 AI caps (read from the same caps object the panel already gates on).
  // Undefined (pre-R15 backend) coerces to false, so the buttons stay disabled.
  const bgRemoveEnabled = caps?.bgRemoveEnabled ?? false;
  const upscaleEnabled = caps?.upscaleEnabled ?? false;

  // ---- Render branches ---------------------------------------------------
  // 1) Still checking caps → the shared loading line.
  if (!capsChecked) {
    return (
      <div style={styles.centerFill}>
        <span style={styles.muted}>{t('vpic.loading')}</span>
      </div>
    );
  }

  // 2) Gated off → a friendly wall (same spirit as ERP activation-pending).
  if (!caps?.enabled) {
    return (
      <div style={styles.centerFill}>
        <div style={styles.gatedCard}>
          {/* Lock icon with gradient treatment matching the editor accent */}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 52,
              height: 52,
              borderRadius: 14,
              background: 'linear-gradient(135deg, var(--affine-primary-color, #5b8cff) 0%, #06b6d4 100%)',
              fontSize: 26,
              boxShadow: '0 6px 20px rgba(91,140,255,0.35)',
            }}
          >
            🔒
          </span>
          <div style={styles.gatedTitle}>{t('vpic.gatedOffTitle')}</div>
          <div style={styles.gatedBody}>{t('vpic.gatedOffBody')}</div>
        </div>
      </div>
    );
  }

  // 3) The editor.
  return (
    /* data-cdz-shell: on phones the shared sheet stacks the two columns
       vertically (rail above canvas) instead of side by side. */
    <div data-cdz-shell="" dir={dir} style={styles.root}>
      {/* ---- LEFT: canvas preview (grows to fill) ---- */}
      <div data-cdz-main="" style={styles.canvasCol}>
        {hasImage ? (
          <div style={styles.canvasStage}>
            <canvas ref={canvasRef} style={styles.canvas} />
          </div>
        ) : (
          <div style={styles.emptyState}>
            {/* Hero icon for the empty state */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 56,
                height: 56,
                borderRadius: 16,
                background: 'linear-gradient(135deg, var(--affine-primary-color, #5b8cff) 0%, #06b6d4 100%)',
                fontSize: 28,
                boxShadow: '0 6px 20px rgba(91,140,255,0.35)',
              }}
            >
              🖼
            </span>
            <div style={styles.emptyTitle}>{t('vpic.open')}</div>
            <div style={styles.emptyHint}>{t('vpic.dropHere')}</div>
            <div style={styles.openRow}>
              <button
                type="button"
                style={styles.primaryBtn}
                disabled={opening}
                onClick={() => void onPickLocal()}
              >
                {opening ? t('vpic.loading') : t('vpic.upload')}
              </button>
              <button
                type="button"
                style={styles.btn}
                onClick={() => setStockOpen(o => !o)}
              >
                {t('vpic.stock')}
              </button>
              {/* Text-to-image GENERATE — reachable with no image open yet.
                  The result is folded into the engine via onMaskApplied. */}
              <button
                type="button"
                style={styles.btn}
                onClick={openGenerate}
              >
                {t('vpic.generate')}
              </button>
            </div>
            {/* Import-from-URL row. */}
            <div style={styles.openRow}>
              <input
                style={styles.input}
                placeholder={t('vpic.paste')}
                value={urlDraft}
                onChange={e => setUrlDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void onImportUrl();
                }}
              />
              <button
                type="button"
                style={styles.btn}
                disabled={!urlDraft.trim() || opening}
                onClick={() => void onImportUrl()}
              >
                {t('vpic.apply')}
              </button>
            </div>
            {openError ? <div style={styles.error}>{openError}</div> : null}

            {/* Stock search mini-panel (inline, opens under the buttons). */}
            {stockOpen ? (
              <div style={styles.stockPanel}>
                <div style={styles.openRow}>
                  <input
                    style={styles.input}
                    placeholder={t('vpic.stockSearch')}
                    value={stockQuery}
                    onChange={e => setStockQuery(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void onStockSearch();
                    }}
                  />
                  <button
                    type="button"
                    style={styles.btn}
                    disabled={stockBusy}
                    onClick={() => void onStockSearch()}
                  >
                    {stockBusy ? t('vpic.loading') : t('vpic.stockSearch')}
                  </button>
                </div>
                <div style={styles.stockGrid}>
                  {stockResults.map(r => (
                    <button
                      key={r.url}
                      type="button"
                      style={styles.stockCell}
                      title={`${t('vpic.stockBy')} ${r.author} · ${r.source}`}
                      onClick={() => void onPickStock(r)}
                    >
                      <img
                        src={r.thumb}
                        alt={r.author}
                        style={styles.stockImg}
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* ---- RIGHT: the tool rail (scrollable) ---- */}
      {/* data-cdz-rail: on phones the shared sheet makes this full-width,
          capped at 38 vh, instead of the 320 px fixed column. */}
      <div data-cdz-rail="" style={styles.rail}>
        {/* New image + Undo/Redo header row (always available). */}
        <div style={styles.railHeader}>
          <button
            type="button"
            style={styles.btn}
            onClick={() => void onPickLocal()}
          >
            {t('vpic.newImage')}
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            style={styles.iconBtn}
            disabled={!canUndo}
            title={t('vpic.undo')}
            onClick={onUndo}
          >
            ↶
          </button>
          <button
            type="button"
            style={styles.iconBtn}
            disabled={!canRedo}
            title={t('vpic.redo')}
            onClick={onRedo}
          >
            ↷
          </button>
        </div>

        {hasImage ? (
          <>
            {/* ---- Recadrer (crop presets) ---- */}
            <section style={styles.section}>
              <div style={styles.sectionTitle}>{t('vpic.crop')}</div>
              <div style={styles.chipRow}>
                {CROP_PRESETS.map(p => (
                  <button
                    key={p.key}
                    type="button"
                    style={styles.chip}
                    onClick={() => applyCropPreset(p.ar)}
                  >
                    {t(p.key)}
                  </button>
                ))}
              </div>
            </section>

            {/* ---- Rotation / Miroir ---- */}
            <section style={styles.section}>
              <div style={styles.chipRow}>
                <button
                  type="button"
                  style={styles.chip}
                  onClick={() => onRotate(-1)}
                >
                  {t('vpic.rotateL')}
                </button>
                <button
                  type="button"
                  style={styles.chip}
                  onClick={() => onRotate(1)}
                >
                  {t('vpic.rotateR')}
                </button>
                <button
                  type="button"
                  style={styles.chip}
                  onClick={() => onFlip(true)}
                >
                  {t('vpic.flipH')}
                </button>
                <button
                  type="button"
                  style={styles.chip}
                  onClick={() => onFlip(false)}
                >
                  {t('vpic.flipV')}
                </button>
              </div>
            </section>

            {/* ---- Redimensionner ---- */}
            <section style={styles.section}>
              <div style={styles.sectionTitle}>{t('vpic.resize')}</div>
              <div style={styles.openRow}>
                <label style={styles.fieldLabel}>
                  {t('vpic.width')}
                  <input
                    style={styles.numInput}
                    type="number"
                    min={1}
                    value={resizeW}
                    onChange={e => setResizeW(e.target.value)}
                  />
                </label>
                <label style={styles.fieldLabel}>
                  {t('vpic.height')}
                  <input
                    style={styles.numInput}
                    type="number"
                    min={1}
                    value={resizeH}
                    onChange={e => setResizeH(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  style={styles.btn}
                  onClick={onApplyResize}
                >
                  {t('vpic.apply')}
                </button>
              </div>
              <div style={styles.chipRow}>
                {RESIZE_PRESETS.map(w => (
                  <button
                    key={w}
                    type="button"
                    style={styles.chip}
                    onClick={() => onResizePreset(w)}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </section>

            {/* ---- Ajustements (4 sliders) ---- */}
            <section style={styles.section}>
              <div style={styles.sectionHead}>
                <span style={styles.sectionTitle}>{t('vpic.adjust')}</span>
                <button
                  type="button"
                  style={styles.linkBtn}
                  onClick={onResetAdjust}
                >
                  {t('vpic.reset')}
                </button>
              </div>
              <Slider
                label={t('vpic.brightness')}
                min={0}
                max={200}
                value={adjust.brightness}
                onChange={v => onAdjustChange({ brightness: v })}
              />
              <Slider
                label={t('vpic.contrast')}
                min={0}
                max={200}
                value={adjust.contrast}
                onChange={v => onAdjustChange({ contrast: v })}
              />
              <Slider
                label={t('vpic.saturation')}
                min={0}
                max={200}
                value={adjust.saturate}
                onChange={v => onAdjustChange({ saturate: v })}
              />
              <Slider
                label={t('vpic.warmth')}
                min={-100}
                max={100}
                value={adjust.warmth}
                onChange={v => onAdjustChange({ warmth: v })}
              />
            </section>

            {/* ---- Filtres (7 chips) ---- */}
            <section style={styles.section}>
              <div style={styles.sectionTitle}>{t('vpic.filters')}</div>
              <div style={styles.chipRow}>
                {FILTERS.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    style={{
                      ...styles.chip,
                      ...(filter === f.id ? styles.chipActive : null),
                    }}
                    aria-pressed={filter === f.id}
                    onClick={() => onFilterPick(f.id)}
                  >
                    {t(f.key)}
                  </button>
                ))}
              </div>
            </section>

            {/* ---- Texte (overlay list editor) ---- */}
            <section style={styles.section}>
              <div style={styles.sectionHead}>
                <span style={styles.sectionTitle}>{t('vpic.text')}</span>
                <button type="button" style={styles.linkBtn} onClick={onAddText}>
                  {t('vpic.addText')}
                </button>
              </div>
              {texts.map(o => (
                <div key={o.id} style={styles.textCard}>
                  <div style={styles.openRow}>
                    <input
                      style={styles.input}
                      placeholder={t('vpic.textPlaceholder')}
                      value={o.text}
                      onChange={e => onUpdateText(o.id, { text: e.target.value })}
                    />
                    <button
                      type="button"
                      style={styles.iconBtn}
                      title={t('vpic.deleteText')}
                      onClick={() => onDeleteText(o.id)}
                    >
                      ✕
                    </button>
                  </div>
                  <div style={styles.openRow}>
                    <label style={styles.fieldLabel}>
                      {t('vpic.fontSize')}
                      {/* Sentinel F-1: the UI edits size as a PERCENT of the
                          image height (1..50); the engine stores the 0..1
                          fraction. Divide/multiply by 100 at the boundary. */}
                      <input
                        style={styles.numInput}
                        type="number"
                        min={1}
                        max={50}
                        value={Math.round(o.size * 100)}
                        onChange={e =>
                          onUpdateText(o.id, {
                            size: Number(e.target.value) / 100,
                          })
                        }
                      />
                    </label>
                    <label style={styles.fieldLabel}>
                      {t('vpic.color')}
                      <input
                        style={styles.colorInput}
                        type="color"
                        value={o.color}
                        onChange={e =>
                          onUpdateText(o.id, { color: e.target.value })
                        }
                      />
                    </label>
                    <label style={styles.checkLabel}>
                      <input
                        type="checkbox"
                        checked={o.bold}
                        onChange={e =>
                          onUpdateText(o.id, { bold: e.target.checked })
                        }
                      />
                      {t('vpic.bold')}
                    </label>
                  </div>
                  {/* Alignment picker. */}
                  <div style={styles.chipRow}>
                    {(['left', 'center', 'right'] as const).map(a => (
                      <button
                        key={a}
                        type="button"
                        style={{
                          ...styles.chipSm,
                          ...(o.align === a ? styles.chipActive : null),
                        }}
                        aria-pressed={o.align === a}
                        title={t('vpic.align')}
                        onClick={() => onUpdateText(o.id, { align: a })}
                      >
                        {a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}
                      </button>
                    ))}
                    <label style={styles.checkLabel}>
                      <input
                        type="checkbox"
                        checked={o.rtl}
                        onChange={e =>
                          onUpdateText(o.id, { rtl: e.target.checked })
                        }
                      />
                      RTL
                    </label>
                  </div>
                  {/* Position via x/y sliders (0..1 relative). */}
                  <Slider
                    label={t('vpic.posX')}
                    min={0}
                    max={100}
                    value={Math.round(o.x * 100)}
                    onChange={v => onUpdateText(o.id, { x: v / 100 })}
                  />
                  <Slider
                    label={t('vpic.posY')}
                    min={0}
                    max={100}
                    value={Math.round(o.y * 100)}
                    onChange={v => onUpdateText(o.id, { y: v / 100 })}
                  />
                </div>
              ))}
            </section>

            {/* ---- IA ---- */}
            <section style={styles.section}>
              <div style={styles.sectionTitle}>{t('vpic.ai')}</div>
              {/* Text-to-image GENERATE (reachable with an image already open —
                  generation replaces the canvas via onMaskApplied). */}
              <button
                type="button"
                style={styles.primaryBtn}
                onClick={openGenerate}
              >
                {t('vpic.generate')}
              </button>
              <div style={styles.hint}>{t('vpic.generateHint')}</div>
              <button
                type="button"
                style={styles.primaryBtn}
                onClick={() => void onOpenGenFill()}
              >
                {t('vpic.genFill')}
              </button>
              <div style={styles.hint}>{t('vpic.genFillHint')}</div>
              <div style={styles.chipRow}>
                {/* R15 — wired to cdz-pix. Enabled only when the matching cap is
                    true (and no op is in flight); otherwise disabled with the
                    "AI unavailable" tooltip. Label flips to vpic.working while
                    the shared pixBusy op runs. */}
                <button
                  type="button"
                  style={
                    bgRemoveEnabled ? styles.chip : styles.chipDisabled
                  }
                  disabled={!bgRemoveEnabled || pixBusy}
                  title={
                    bgRemoveEnabled ? undefined : t('vpic.aiUnavailable')
                  }
                  onClick={onBgRemove}
                >
                  {pixBusy ? t('vpic.working') : t('vpic.bgRemove')}
                </button>
                <button
                  type="button"
                  style={upscaleEnabled ? styles.chip : styles.chipDisabled}
                  disabled={!upscaleEnabled || pixBusy}
                  title={
                    upscaleEnabled ? undefined : t('vpic.aiUnavailable')
                  }
                  onClick={onUpscale}
                >
                  {pixBusy ? t('vpic.working') : t('vpic.upscale')}
                </button>
              </div>
              {pixError ? (
                <div style={styles.error}>
                  {pixError === 'aiUnavailable'
                    ? t('vpic.aiUnavailable')
                    : t('vpic.error')}
                </div>
              ) : null}
            </section>

            {/* ---- Export ---- */}
            <section style={styles.section}>
              <div style={styles.sectionTitle}>{t('vpic.export')}</div>
              <div style={styles.openRow}>
                <label style={styles.fieldLabel}>
                  {t('vpic.format')}
                  <select
                    style={styles.select}
                    value={exportFmt}
                    onChange={e =>
                      setExportFmt(
                        e.target.value as
                          | 'image/png'
                          | 'image/jpeg'
                          | 'image/webp'
                      )
                    }
                  >
                    {EXPORT_FORMATS.map(f => (
                      <option key={f.mime} value={f.mime}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {/* Quality only matters for lossy formats. */}
              {exportFmt !== 'image/png' ? (
                <Slider
                  label={t('vpic.quality')}
                  min={10}
                  max={100}
                  value={Math.round(quality * 100)}
                  onChange={v => setQuality(v / 100)}
                />
              ) : null}
              <div style={styles.openRow}>
                <button
                  type="button"
                  style={styles.primaryBtn}
                  disabled={exporting}
                  onClick={() => void onDownload()}
                >
                  {t('vpic.download')}
                </button>
                <button
                  type="button"
                  style={styles.btn}
                  disabled={exporting}
                  onClick={() => void onSaveToWorkspace()}
                >
                  {t('vpic.saveToWorkspace')}
                </button>
              </div>
              {savedOk ? <div style={styles.okText}>{t('vpic.savedOk')}</div> : null}
            </section>

            {/* ---- Projets ---- */}
            <section style={styles.section}>
              <div style={styles.sectionHead}>
                <span style={styles.sectionTitle}>{t('vpic.projects')}</span>
                <button
                  type="button"
                  style={styles.linkBtn}
                  disabled={projectsBusy || !sourceHandle}
                  onClick={() => void onSaveProject()}
                >
                  {t('vpic.saveProject')}
                </button>
              </div>
              <div style={styles.sectionSub}>{t('vpic.myProjects')}</div>
              {projectsError ? (
                <div style={styles.error}>
                  {projectsError}
                  <button
                    type="button"
                    style={styles.linkBtn}
                    onClick={() => void refreshProjects()}
                  >
                    {t('vpic.retry')}
                  </button>
                </div>
              ) : null}
              {projects && projects.length === 0 && !projectsBusy ? (
                <div style={styles.muted}>{t('vpic.emptyProjects')}</div>
              ) : null}
              <div style={styles.projectList}>
                {(projects ?? []).map(p => (
                  <div key={p.id} style={styles.projectRow}>
                    <button
                      type="button"
                      style={styles.projectName}
                      title={t('vpic.openProject')}
                      disabled={projectsBusy}
                      onClick={() => void onOpenProject(p.id)}
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      style={styles.iconBtn}
                      title={t('vpic.deleteProject')}
                      disabled={projectsBusy}
                      onClick={() => void onDeleteProject(p.id)}
                    >
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : (
          <div style={styles.railEmpty}>
            <span style={{ fontSize: 28, opacity: 0.3 }}>🎨</span>
            {t('vpic.open')}
          </div>
        )}
      </div>

      {/* ---- IA: the lazy mask panel (generative fill) ---- */}
      {maskOpen && maskSource ? (
        <div style={styles.modalScrim} role="dialog" aria-modal="true">
          <div style={styles.modalCard}>
            <Suspense
              fallback={<div style={styles.centerFill}>{t('vpic.loading')}</div>}
            >
              <MaskPanel
                sourceUrl={maskSource.url}
                sourceWidth={maskSource.width}
                sourceHeight={maskSource.height}
                onApplied={onMaskApplied}
                onClose={closeMask}
              />
            </Suspense>
          </div>
        </div>
      ) : null}

      {/* ---- IA: the lazy text-to-image generate panel ---- */}
      {generateOpen ? (
        <Suspense
          fallback={
            <div style={styles.modalScrim} role="dialog" aria-modal="true">
              <div style={styles.centerFill}>{t('vpic.loading')}</div>
            </div>
          }
        >
          {/* GeneratePanel renders its own overlay/modal; the result folds into
              the engine via the SAME sink the mask panel uses. */}
          <GeneratePanel onApplied={onMaskApplied} onClose={closeGenerate} />
        </Suspense>
      ) : null}
    </div>
  );
}

/**
 * A compact labeled range slider used across the tool rail (adjustments,
 * text position, export quality). Shows the live numeric value at the end.
 */
function Slider({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label style={styles.sliderRow}>
      <span style={styles.sliderLabel}>{label}</span>
      <input
        style={styles.range}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
      />
      <span style={styles.sliderValue}>{value}</span>
    </label>
  );
}

// ---- Inline styles -------------------------------------------------------
// Matches the Vdz idiom of plain inline `style={{}}` objects with CSS variable
// fallbacks (so the studio inherits the AFFiNE theme but never hard-depends on
// a missing token). RTL is handled by the root `dir` + logical properties
// (borderInlineStart, etc.) rather than left/right, so darja mirrors for free.
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'row',
    width: '100%',
    height: '100%',
    minHeight: 0,
    color: 'var(--affine-text-primary-color, #e6e9f0)',
    background: 'var(--affine-background-primary-color, #0b0d12)',
  },
  canvasCol: {
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    overflow: 'hidden',
    background: 'var(--affine-background-secondary-color, #0e1016)',
  },
  canvasStage: {
    maxWidth: '100%',
    maxHeight: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  canvas: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    borderRadius: 10,
    boxShadow: '0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)',
    background:
      'repeating-conic-gradient(#2a2f3a 0% 25%, #1c2029 0% 50%) 50% / 20px 20px',
  },
  rail: {
    flex: '0 0 324px',
    width: 324,
    height: '100%',
    overflowY: 'auto',
    borderInlineStart: '1px solid var(--affine-border-color, #1c2029)',
    background: 'var(--affine-background-primary-color, #0b0d12)',
    display: 'flex',
    flexDirection: 'column',
  },
  railHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 12px',
    borderBottom: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-primary-color, #0b0d12)',
  },
  railEmpty: {
    padding: '48px 24px',
    textAlign: 'center',
    color: 'var(--affine-text-secondary-color, #8a90a0)',
    fontSize: 13,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
  },
  section: {
    padding: '14px 14px',
    borderBottom: '1px solid var(--affine-border-color, #1c2029)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    color: 'var(--affine-text-secondary-color, #8a90a0)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
  },
  sectionSub: {
    fontSize: 11,
    color: 'var(--affine-text-secondary-color, #8a90a0)',
  },
  chipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    padding: '5px 10px',
    fontSize: 12,
    borderRadius: 7,
    cursor: 'pointer',
    border: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-secondary-color, #12141a)',
    color: 'var(--affine-text-primary-color, #e6e9f0)',
  },
  chipSm: {
    padding: '4px 8px',
    fontSize: 12,
    borderRadius: 6,
    cursor: 'pointer',
    border: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-secondary-color, #12141a)',
    color: 'var(--affine-text-primary-color, #e6e9f0)',
    minWidth: 30,
  },
  chipActive: {
    borderColor: 'var(--affine-primary-color, #5b8cff)',
    background: 'var(--affine-hover-color, #2a2f3a)',
    color: 'var(--affine-text-primary-color, #ffffff)',
  },
  chipDisabled: {
    padding: '5px 10px',
    fontSize: 12,
    borderRadius: 7,
    cursor: 'not-allowed',
    border: '1px dashed var(--affine-border-color, #262a35)',
    background: 'transparent',
    color: 'var(--affine-text-disable-color, #565b68)',
  },
  btn: {
    padding: '6px 12px',
    fontSize: 12,
    borderRadius: 7,
    cursor: 'pointer',
    border: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-secondary-color, #12141a)',
    color: 'var(--affine-text-primary-color, #e6e9f0)',
    whiteSpace: 'nowrap',
  },
  primaryBtn: {
    padding: '7px 16px',
    fontSize: 12,
    fontWeight: 700,
    borderRadius: 8,
    cursor: 'pointer',
    border: '1px solid var(--affine-primary-color, #5b8cff)',
    background: 'var(--affine-primary-color, #5b8cff)',
    color: '#ffffff',
    whiteSpace: 'nowrap',
    boxShadow: '0 2px 8px rgba(91,140,255,0.35)',
    transition: 'opacity 150ms ease, box-shadow 150ms ease',
  },
  iconBtn: {
    width: 30,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    borderRadius: 6,
    cursor: 'pointer',
    border: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-secondary-color, #12141a)',
    color: 'var(--affine-text-primary-color, #e6e9f0)',
  },
  linkBtn: {
    padding: '2px 4px',
    fontSize: 12,
    borderRadius: 5,
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    color: 'var(--affine-primary-color, #5b8cff)',
  },
  input: {
    flex: '1 1 auto',
    minWidth: 0,
    padding: '6px 8px',
    fontSize: 12,
    borderRadius: 7,
    border: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-primary-color, #0b0d12)',
    color: 'var(--affine-text-primary-color, #e6e9f0)',
  },
  numInput: {
    width: 72,
    padding: '5px 6px',
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-primary-color, #0b0d12)',
    color: 'var(--affine-text-primary-color, #e6e9f0)',
  },
  colorInput: {
    width: 40,
    height: 28,
    padding: 0,
    border: '1px solid var(--affine-border-color, #262a35)',
    borderRadius: 6,
    background: 'transparent',
    cursor: 'pointer',
  },
  select: {
    padding: '5px 8px',
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-primary-color, #0b0d12)',
    color: 'var(--affine-text-primary-color, #e6e9f0)',
  },
  fieldLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: 'var(--affine-text-secondary-color, #8a90a0)',
  },
  checkLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: 'var(--affine-text-secondary-color, #8a90a0)',
    cursor: 'pointer',
  },
  openRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  sliderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  sliderLabel: {
    flex: '0 0 84px',
    fontSize: 12,
    color: 'var(--affine-text-secondary-color, #8a90a0)',
  },
  range: {
    flex: '1 1 auto',
    minWidth: 0,
  },
  sliderValue: {
    flex: '0 0 40px',
    textAlign: 'end',
    fontSize: 11,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--affine-text-primary-color, #e6e9f0)',
  },
  textCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: 8,
    borderRadius: 8,
    border: '1px solid var(--affine-border-color, #1c2029)',
    background: 'var(--affine-background-secondary-color, #0e1016)',
  },
  hint: {
    fontSize: 11,
    lineHeight: 1.5,
    color: 'var(--affine-text-secondary-color, #8a90a0)',
  },
  projectList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  projectRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  projectName: {
    flex: '1 1 auto',
    minWidth: 0,
    textAlign: 'start',
    padding: '6px 8px',
    fontSize: 12,
    borderRadius: 6,
    cursor: 'pointer',
    border: '1px solid var(--affine-border-color, #1c2029)',
    background: 'var(--affine-background-secondary-color, #12141a)',
    color: 'var(--affine-text-primary-color, #e6e9f0)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  centerFill: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    minHeight: 240,
  },
  muted: {
    fontSize: 13,
    color: 'var(--affine-text-secondary-color, #8a90a0)',
  },
  gatedCard: {
    maxWidth: 440,
    padding: 36,
    textAlign: 'center',
    borderRadius: 16,
    border: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-secondary-color, #12141a)',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    alignItems: 'center',
    boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
  },
  gatedTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--affine-text-primary-color, #e6e9f0)',
    letterSpacing: '-0.01em',
  },
  gatedBody: {
    fontSize: 13,
    lineHeight: 1.65,
    color: 'var(--affine-text-secondary-color, #8a90a0)',
    maxWidth: 320,
  },
  emptyState: {
    maxWidth: 480,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: 36,
    textAlign: 'center',
    borderRadius: 16,
    border: '1.5px dashed var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-primary-color, #0b0d12)',
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: 'var(--affine-text-primary-color, #e6e9f0)',
    letterSpacing: '-0.01em',
  },
  emptyHint: {
    fontSize: 12.5,
    color: 'var(--affine-text-secondary-color, #8a90a0)',
    lineHeight: 1.6,
    maxWidth: 320,
  },
  stockPanel: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginTop: 4,
  },
  stockGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 6,
  },
  stockCell: {
    padding: 0,
    border: '1px solid var(--affine-border-color, #262a35)',
    borderRadius: 10,
    overflow: 'hidden',
    cursor: 'pointer',
    background: 'transparent',
    aspectRatio: '1 / 1',
    transition: 'border-color 140ms ease, box-shadow 140ms ease',
  },
  stockImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  error: {
    fontSize: 12,
    color: '#ff6b6b',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  okText: {
    fontSize: 12,
    color: '#4caf87',
  },
  modalScrim: {
    position: 'fixed',
    inset: 0,
    zIndex: 100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.6)',
    padding: 24,
  },
  modalCard: {
    maxWidth: '92vw',
    maxHeight: '92vh',
    overflow: 'auto',
    borderRadius: 14,
    border: '1px solid var(--affine-border-color, #262a35)',
    background: 'var(--affine-background-primary-color, #0b0d12)',
    boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  },
};
