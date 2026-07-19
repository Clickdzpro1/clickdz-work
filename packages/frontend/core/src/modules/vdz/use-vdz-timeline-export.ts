import { WorkspaceService } from '@affine/core/modules/workspace';
import { useService } from '@toeverything/infra';
import { useCallback, useMemo, useState } from 'react';

// Type-only: the compiler implementation is LAZY-imported inside `start()` so
// the (sizeable) compile+inline pipeline stays out of the editor's initial
// chunk — it loads on the first Export click (C3 chunk diet).
import type { CompileTimelineResult } from './compile-timeline';
import type { VdzTimeline } from './schema';
import { useVdzExport, type UseVdzExport } from './use-vdz-export';
import { blobIdFromSrc, isVdzBlobSrc } from './use-vdz-media';

/**
 * Vdz Studio — timeline → MP4 export orchestration (Cluster 2, Option B).
 *
 * Glues the pure {@link compileTimelineToHtml} compiler to the ALREADY-WORKING
 * {@link useVdzExport} render path (`POST /api/v1/vdz/render` {html} → cdz-render
 * kind:'html'). No backend or render-service change: the compiled document is
 * just an HTML composition the existing engine renders.
 *
 * MEDIA INLINING. cdz-render is offline headless Chrome — it cannot fetch
 * `vdz-blob:<id>` (workspace-local) or remote https srcs. So BEFORE compiling we
 * pre-resolve every distinct clip src to a `data:` URI:
 *   · `vdz-blob:<id>` → `blobSync.get(id)` → Blob → base64 data URL (the exact
 *     workspace blob store the preview resolves through).
 *   · remote https/http → `fetch` → Blob → data URL (best-effort; may be blocked
 *     by CORS, in which case it stays unresolved and the compiler emits it raw).
 *   · already-inline `data:` srcs pass through untouched.
 * We enforce a TOTAL inlined-bytes budget (the render service caps the whole
 * document at 2 MB) and stop inlining past it, reporting a warning so the UI can
 * tell the user media was dropped. Text/shape-only timelines inline nothing and
 * always fit.
 *
 * This hook OWNS the compile+inline step and delegates progress/polling/download
 * to {@link useVdzExport} verbatim (so the editor reuses the same ticker/progress
 * UI the Generate panel already renders).
 *
 * ENGINE CHOICE (C7). The toolbar's Export button no longer starts a render
 * immediately — it OPENS the export dialog ({@link dialogOpen}/{@link openDialog}).
 * The dialog lets the user pick the render ENGINE ('classic' HTML poster tier vs
 * 'remotion' true-video-beta), then calls {@link start} with that choice on
 * Confirm. The compile+inline step and the progress/polling UX after Confirm are
 * unchanged.
 *
 * DURATION / DIMENSIONS ON THE WIRE (C1 + C2). Every render request now carries
 * the composition's canonical duration ({@link computeExportDurationSec} — rule
 * C1: max clip end over ALL clips on ALL tracks, floored at 1s), the timeline
 * canvas `width`/`height`, its `fps`, and the chosen `engine`. The classic HTML
 * compiler ALSO stamps these onto the composition root (see compile-timeline.ts)
 * so the offline producer records the FULL timeline length instead of re-probing
 * a possibly-short one.
 */

/**
 * Total inlined-media budget in bytes. The render proxy + service both cap the
 * whole HTML document at 2 MB; base64 inflates bytes ~1.37×, and the document
 * scaffold/keyframes cost a little too, so we budget ~1.4 MB of RAW media which
 * leaves headroom under the 2 MB ceiling after encoding + markup.
 */
const MAX_INLINE_BYTES = 1_400_000;

/**
 * The render ENGINE the export targets:
 *   · `classic`  — the offline headless-Chrome HTML tier (fast; video clips
 *     render as a still poster, no audio).
 *   · `remotion` — the true-video render worker (real per-frame video + audio),
 *     available when the server has `CDZ_REMOTION_URL` set.
 * Sent verbatim as the C2 `engine` field so the backend routes accordingly.
 */
export type VdzExportEngine = 'classic' | 'remotion';

/**
 * The default fps used when a timeline carries no (or an invalid) `fps`. Matches
 * the schema default and both render tiers' server-side default (cdz-render
 * `DEFAULT_FPS = 30`, worker manifest fps). The frozen `VDZ/constants.ts` holds
 * no fps of its own — the per-project value lives on `timeline.fps` — so this is
 * the single fallback the whole export path resolves through.
 */
export const DEFAULT_EXPORT_FPS = 30;

/**
 * localStorage flag that OPTED an export into the Remotion engine before the
 * export dialog existed. It is still the DEFAULT source for the dialog's engine
 * choice (C7): a user who previously set it lands on 'remotion' by default. Read
 * defensively so a non-browser / storage-blocked environment simply reports
 * "off".
 */
const REMOTION_OPT_IN_KEY = 'cdz:remotion-opt-in';

/**
 * localStorage key that PERSISTS the user's explicit engine choice from the
 * export dialog (C7). Takes precedence over {@link REMOTION_OPT_IN_KEY} once the
 * user has picked. Stores the literal engine string ('classic' | 'remotion').
 */
export const EXPORT_ENGINE_KEY = 'cdz:vdz-export-engine';

/** True when the legacy Remotion opt-in flag is set to a truthy value. */
function remotionOptInEnabled(): boolean {
  try {
    const v = globalThis.localStorage?.getItem(REMOTION_OPT_IN_KEY);
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

/**
 * Resolve the DEFAULT export engine for the dialog (C7):
 *   1. the persisted explicit choice (`cdz:vdz-export-engine`), if valid;
 *   2. else the legacy Remotion opt-in flag → 'remotion' when set;
 *   3. else 'classic'.
 * Storage-blocked / non-browser environments fall through to 'classic'.
 */
export function resolveDefaultExportEngine(): VdzExportEngine {
  try {
    const persisted = globalThis.localStorage?.getItem(EXPORT_ENGINE_KEY);
    if (persisted === 'classic' || persisted === 'remotion') return persisted;
  } catch {
    // fall through to the legacy flag
  }
  return remotionOptInEnabled() ? 'remotion' : 'classic';
}

/** Persist the user's explicit engine choice (best-effort; ignores failures). */
export function persistExportEngine(engine: VdzExportEngine): void {
  try {
    globalThis.localStorage?.setItem(EXPORT_ENGINE_KEY, engine);
  } catch {
    // storage blocked — the choice simply isn't remembered next time
  }
}

/**
 * The ONE canonical export-duration rule (C1): `totalDurationSec` is the maximum
 * clip end (`start + duration`) across EVERY clip on EVERY track — video, image,
 * text, audio alike — floored at a minimum of 1 second. NO transition extension
 * (crossfades overlap WITHIN clip spans, so a trailing transition tail never adds
 * to the total). This is the single source of truth every SPLICE file stamps and
 * sends: the compiler stamps it on the composition root, the manifest derives its
 * `durationInFrames` from it, and the dialog displays it.
 *
 * (It reuses the schema's `computeTimelineDuration` semantics — max clip end —
 * and only adds the C1 floor; kept here, in a module already on the editor's
 * initial chunk, so the dialog and the two lazy render chunks all share it.)
 */
export function computeExportDurationSec(timeline: VdzTimeline): number {
  let max = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const end = clip.start + clip.duration;
      if (end > max) max = end;
    }
  }
  // Floor at 1s: an empty (or sub-second) timeline still renders a valid 1s clip
  // rather than a zero-length composition both render tiers reject.
  return Math.max(1, max);
}

/** Resolve a timeline's export fps: its own `fps` when positive, else the default. */
export function resolveExportFps(timeline: VdzTimeline): number {
  const fps = timeline.fps;
  return typeof fps === 'number' && Number.isFinite(fps) && fps > 0
    ? fps
    : DEFAULT_EXPORT_FPS;
}

/** Read a Blob as a base64 `data:` URL. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** Collect the distinct, non-empty clip srcs across every visible clip. */
export function collectTimelineSrcs(timeline: VdzTimeline): string[] {
  const srcs = new Set<string>();
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      // Only clip types that carry a src (video/audio/image); audio is silent
      // in the HTML render but we still skip empty srcs and dedupe.
      const src = (clip as { src?: unknown }).src;
      if (typeof src === 'string' && src && !src.startsWith('data:')) {
        srcs.add(src);
      }
    }
  }
  return [...srcs];
}

/** The minimal blob store slice we need (matches BlobEngine.get). */
interface BlobGetter {
  get: (blobId: string) => Promise<Blob | null>;
}

/**
 * Pre-resolve a timeline's media srcs to `data:` URIs, honoring the total-bytes
 * budget. PURE-ish: reads the workspace blob store + network but mutates nothing.
 * Returns the resolveSrc map for the compiler plus diagnostics.
 */
export async function resolveTimelineMedia(
  timeline: VdzTimeline,
  getter: BlobGetter
): Promise<{
  resolveSrc: Record<string, string>;
  skipped: string[];
  bytes: number;
}> {
  const srcs = collectTimelineSrcs(timeline);
  const resolveSrc: Record<string, string> = {};
  const skipped: string[] = [];
  let bytes = 0;

  for (const src of srcs) {
    try {
      let blob: Blob | null = null;
      if (isVdzBlobSrc(src)) {
        const id = blobIdFromSrc(src);
        blob = id ? await getter.get(id) : null;
      } else if (/^https?:/i.test(src)) {
        // Best-effort remote fetch; CORS may reject (leaves it unresolved).
        const res = await fetch(src);
        if (res.ok) blob = await res.blob();
      }
      if (!blob) {
        skipped.push(src);
        continue;
      }
      if (bytes + blob.size > MAX_INLINE_BYTES) {
        // Over budget — leave this (and anything larger) unresolved.
        skipped.push(src);
        continue;
      }
      resolveSrc[src] = await blobToDataUrl(blob);
      bytes += blob.size;
    } catch {
      skipped.push(src);
    }
  }
  return { resolveSrc, skipped, bytes };
}

export interface UseVdzTimelineExport {
  /** The underlying export transport (status/progress/error/fileUrl/reset). */
  export: UseVdzExport;
  /** True while compiling + inlining media (before the render enqueue). */
  preparing: boolean;
  /**
   * Last compile diagnostics (clip count, duration, unresolved srcs, poster-only
   * video clips) — surfaced so the editor can warn about video/CORS limits.
   */
  lastCompile: CompileTimelineResult | null;
  /** Srcs that could not be inlined (dead blob / CORS / over budget). */
  skippedMedia: string[];
  /** Whether the export dialog is open (engine choice + confirm). */
  dialogOpen: boolean;
  /**
   * Open the export dialog. This is what the toolbar's Export button triggers
   * now (instead of starting a render immediately): the user picks an engine
   * and confirms, which calls {@link start}.
   */
  openDialog: () => void;
  /** Close the export dialog without starting a render (Cancel / Escape). */
  closeDialog: () => void;
  /**
   * Compile the timeline, inline its media, and start the MP4 render with the
   * given ENGINE (C7). Closes the dialog first. Rejects (via the export hook's
   * error state) when there is nothing to render. Defaults `engine` to the
   * dialog's resolved default so a direct call still works.
   */
  start: (timeline: VdzTimeline, engine?: VdzExportEngine) => Promise<void>;
}

/**
 * The editor's Export-MP4 hook: open the engine-choice dialog, then (on Confirm)
 * compile the current timeline, inline media, and drive the shared render
 * transport. Consumed by the toolbar's Export button + the export dialog.
 */
export function useVdzTimelineExport(): UseVdzTimelineExport {
  const workspaceService = useService(WorkspaceService);
  const exporter = useVdzExport();
  const [preparing, setPreparing] = useState(false);
  const [lastCompile, setLastCompile] = useState<CompileTimelineResult | null>(
    null
  );
  const [skippedMedia, setSkippedMedia] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  const { start: startRender } = exporter;

  const openDialog = useCallback(() => setDialogOpen(true), []);
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  const start = useCallback(
    async (
      timeline: VdzTimeline,
      engine: VdzExportEngine = resolveDefaultExportEngine()
    ): Promise<void> => {
      // Confirming the dialog closes it; the progress/polling UX takes over.
      setDialogOpen(false);
      setPreparing(true);
      setSkippedMedia([]);
      try {
        // Code-split: the compiler only exists in memory once an export is
        // actually requested. Parallel to the media resolution below in
        // effect, but sequenced for simplicity — the fetch is cached by the
        // bundler after the first click.
        const { compileTimelineToHtml } = await import('./compile-timeline');
        const blobSync = workspaceService.workspace.docCollection.blobSync;
        const { resolveSrc, skipped } = await resolveTimelineMedia(
          timeline,
          blobSync
        );
        setSkippedMedia(skipped);
        const compiled = compileTimelineToHtml(timeline, { resolveSrc });
        setLastCompile(compiled);

        // C1/C2: resolve the canonical duration + canvas + fps ONCE and send
        // them on EVERY render request so the server never has to re-probe a
        // possibly-short length or fall back to its own default dimensions/fps.
        const durationSec = computeExportDurationSec(timeline);
        const fps = resolveExportFps(timeline);
        const width = timeline.width || 1920;
        const height = timeline.height || 1080;

        // Base body fields (C2), sent for BOTH engines. The Remotion branch adds
        // the render manifest (C3) on top.
        const extra: Record<string, unknown> = {
          engine,
          width,
          height,
          fps,
          durationSec,
        };

        if (engine === 'remotion') {
          // Build the render manifest and send it with the html so the backend
          // routes to the Remotion worker (effective when CDZ_REMOTION_URL is
          // set). The manifest reuses the SAME resolved media map (data: URLs
          // are valid loadable srcs for the worker too). Code-split alongside
          // the compiler so a classic export never loads it.
          const { buildRenderManifest } = await import(
            './remotion/render-manifest'
          );
          extra.manifest = buildRenderManifest(timeline, { resolveSrc });
        }

        // Hand the compiled HTML + the C2 fields to the shared render path
        // (enqueue → poll → file url). The service rejects an empty composition
        // with a typed 400 that the export hook surfaces as an error; the
        // classic tier also rejects durationSec > 300s with a duration_cap 400.
        await startRender(compiled.html, extra);
      } finally {
        setPreparing(false);
      }
    },
    [workspaceService, startRender]
  );

  return useMemo(
    () => ({
      export: exporter,
      preparing,
      lastCompile,
      skippedMedia,
      dialogOpen,
      openDialog,
      closeDialog,
      start,
    }),
    [
      exporter,
      preparing,
      lastCompile,
      skippedMedia,
      dialogOpen,
      openDialog,
      closeDialog,
      start,
    ]
  );
}
