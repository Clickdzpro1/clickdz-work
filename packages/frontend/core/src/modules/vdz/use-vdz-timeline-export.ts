import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { useService } from '@toeverything/infra';
import { useCallback, useEffect, useMemo, useState } from 'react';

// Type-only: the compiler implementation is LAZY-imported inside `start()` so
// the (sizeable) compile+inline pipeline stays out of the editor's initial
// chunk — it loads on the first Export click (C3 chunk diet).
import type { CompileTimelineResult } from './compile-timeline';
import type { VdzTimeline } from './schema';
import {
  DEFAULT_RENDER_CAPABILITIES,
  fetchRenderCapabilities,
  useVdzExport,
  type UseVdzExport,
  type VdzRenderCapabilities,
} from './use-vdz-export';
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

// ---------------------------------------------------------------------------
// REMOTION media path (C4). Unlike the classic tier the Remotion worker fetches
// media over the network, so instead of inlining `data:` URIs (capped at
// MAX_INLINE_BYTES) we hand the worker BACKEND-SIGNED absolute https URLs it can
// GET directly — no size cap, full-quality footage. The FE collects the
// workspace blob handles on the timeline, asks the backend (C3
// `POST /api/v1/vdz/blob-urls`) to mint short-lived signed URLs for them, and
// builds a `resolveSrc(src) => url` resolver the manifest applies to every clip
// src. The CLASSIC tier below is untouched — it still inlines via
// `resolveTimelineMedia`.
// ---------------------------------------------------------------------------

/** The C3 mint route: session-authed, returns signed absolute blob URLs. */
const BLOB_URLS_URL = '/api/v1/vdz/blob-urls';

/**
 * A typed error surfaced to the export UI when the signed-URL mint fails (C4).
 * The Remotion path REFUSES to ship a manifest whose media the worker cannot
 * fetch — silently dropping footage would produce a blank/broken render — so a
 * mint failure fails the export loudly instead. The Classic engine remains
 * available (it inlines media a different way), so the dialog can offer it as a
 * fallback.
 */
export class VdzBlobUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VdzBlobUrlError';
  }
}

/**
 * Collect the distinct workspace blob ids referenced by the timeline's clip
 * srcs — the `vdz-blob:<id>` handles the worker cannot resolve on its own and
 * that therefore need signing. `blob:`/`data:`/`https:` srcs carry no workspace
 * blob id (data:/https: are already worker-loadable; ephemeral `blob:` object
 * URLs are session-local and never persist on a saved timeline), so they are
 * skipped here and simply pass through the resolver unchanged.
 */
export function collectTimelineBlobIds(timeline: VdzTimeline): string[] {
  const ids = new Set<string>();
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const src = (clip as { src?: unknown }).src;
      if (typeof src !== 'string' || !src) continue;
      if (isVdzBlobSrc(src)) {
        const id = blobIdFromSrc(src);
        if (id) ids.add(id);
      }
    }
  }
  return [...ids];
}

/** Pull a typed-error message out of an AFFiNE error body (mirrors siblings). */
async function readBlobUrlError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as any;
    const msg =
      data?.message ??
      data?.error?.message ??
      (typeof data?.error === 'string' ? data.error : undefined);
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch {
    // fall through to status text
  }
  return res.statusText || `Request failed (${res.status})`;
}

/**
 * Ask the backend (C3) to mint signed absolute URLs for a workspace's blob ids.
 * Returns the `{ [blobId]: signedUrl }` map. Throws {@link VdzBlobUrlError} on
 * any transport/HTTP/shape failure so the Remotion path can fail loudly rather
 * than ship a manifest the worker can't fetch. Same request idiom as the other
 * Vdz FE hooks: `cdzApiUrl` (desktop/native resolve against the connected
 * server) + `credentials: 'include'` (session cookie rides along).
 */
async function fetchSignedBlobUrls(
  workspaceId: string,
  blobIds: string[]
): Promise<Record<string, string>> {
  if (blobIds.length === 0) return {};
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(BLOB_URLS_URL), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, blobIds }),
    });
  } catch (cause) {
    throw new VdzBlobUrlError(
      cause instanceof Error && cause.message
        ? `Could not reach the media service: ${cause.message}`
        : 'Could not reach the media service to prepare your video.'
    );
  }
  if (!res.ok) {
    throw new VdzBlobUrlError(await readBlobUrlError(res));
  }
  let data: { urls?: unknown };
  try {
    data = (await res.json()) as { urls?: unknown };
  } catch {
    throw new VdzBlobUrlError('The media service returned an invalid response.');
  }
  const urls = data?.urls;
  if (!urls || typeof urls !== 'object') {
    throw new VdzBlobUrlError('The media service returned no signed URLs.');
  }
  // Keep only string values (defensive against a partial/typo'd payload).
  const out: Record<string, string> = {};
  for (const [id, url] of Object.entries(urls as Record<string, unknown>)) {
    if (typeof url === 'string' && url) out[id] = url;
  }
  return out;
}

/**
 * Build the manifest `resolveSrc(src) => url` resolver from a signed-URL map
 * (keyed by blobId). A `vdz-blob:<id>` src whose id was signed resolves to its
 * absolute https URL; EVERY other src (a `vdz-blob:` id that wasn't signed,
 * `data:`, `https:`, `blob:`, anything unknown) is returned UNCHANGED — the
 * manifest builder then passes worker-loadable srcs through and flags the truly
 * unresolvable ones in `manifest.unresolved`.
 */
export function makeSignedSrcResolver(
  signed: Record<string, string>
): (src: string) => string {
  return (src: string): string => {
    if (isVdzBlobSrc(src)) {
      const id = blobIdFromSrc(src);
      if (id) {
        const url = signed[id];
        if (url) return url;
      }
    }
    return src;
  };
}

export interface UseVdzTimelineExport {
  /** The underlying export transport (status/progress/error/fileUrl/reset). */
  export: UseVdzExport;
  /**
   * The render engines this deployment can offer right now (probed once on
   * mount). The export dialog gates the Remotion option and shows the Classic
   * duration cap from this; {@link start} uses it to auto-fall back to Classic
   * when Remotion was chosen but is unavailable. Starts as the conservative
   * default (classic-only) until the probe resolves.
   */
  capabilities: VdzRenderCapabilities;
  /**
   * True when the chosen engine had to be transparently downgraded to Classic
   * because Remotion is unavailable on this deployment (so the UI can show a
   * brief "exported with Classic instead" note). Cleared on each {@link start}.
   */
  fellBackToClassic: boolean;
  /** True while compiling + inlining media (before the render enqueue). */
  preparing: boolean;
  /**
   * Last compile diagnostics (clip count, duration, unresolved srcs, poster-only
   * video clips) — surfaced so the editor can warn about video/CORS limits.
   */
  lastCompile: CompileTimelineResult | null;
  /** Srcs that could not be inlined (dead blob / CORS / over budget). */
  skippedMedia: string[];
  /**
   * Error from the PREPARE step that runs BEFORE the render enqueue — currently
   * the Remotion signed-URL mint (C4) failing. `null` when there is none. The
   * export UI should show this (or `export.error`) as the export's failure and
   * offer the Classic engine as a fallback; a failed mint never ships a broken
   * manifest.
   */
  prepareError: string | null;
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
  // Error raised during the PREPARE step (before the render enqueue) — today
  // only the Remotion signed-URL mint (C4). The shared transport's `export.error`
  // only covers the enqueue/poll phase, so this is a separate surface for the
  // export UI to render a pre-render failure.
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Render engines this deployment can offer. Probed once on mount (fail-soft:
  // resolves to the classic-only default on any failure) so the dialog can gate
  // the Remotion option and `start` can auto-fall back to Classic.
  const [capabilities, setCapabilities] = useState<VdzRenderCapabilities>(
    DEFAULT_RENDER_CAPABILITIES
  );
  const [fellBackToClassic, setFellBackToClassic] = useState(false);

  const { start: startRender } = exporter;

  // Probe capabilities once on mount. `fetchRenderCapabilities` never throws, so
  // no try/catch is needed; the guard just avoids a setState after unmount.
  useEffect(() => {
    let alive = true;
    void fetchRenderCapabilities().then(caps => {
      if (alive) setCapabilities(caps);
    });
    return () => {
      alive = false;
    };
  }, []);

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
      setPrepareError(null);
      setFellBackToClassic(false);

      // AUTO-FALLBACK. When Remotion is requested but this deployment cannot
      // offer it, transparently downgrade to the working Classic engine rather
      // than dead-ending the user on an "unavailable / coming online" state. We
      // re-probe capabilities FRESH here (fail-soft) so a stale mount-time value
      // can't strand the user, and merge it with the mount-time value. Persist
      // Classic as the new default so the next open reflects reality, and flag
      // the downgrade so the UI can note it.
      let effectiveEngine = engine;
      if (engine === 'remotion') {
        const freshCaps = await fetchRenderCapabilities();
        setCapabilities(freshCaps);
        if (!freshCaps.remotion) {
          effectiveEngine = 'classic';
          persistExportEngine('classic');
          setFellBackToClassic(true);
        }
      }

      try {
        // Code-split: the compiler only exists in memory once an export is
        // actually requested. Parallel to the media resolution below in
        // effect, but sequenced for simplicity — the fetch is cached by the
        // bundler after the first click.
        const { compileTimelineToHtml } = await import('./compile-timeline');
        const blobSync = workspaceService.workspace.docCollection.blobSync;

        // C1/C2: resolve the canonical duration + canvas + fps ONCE and send
        // them on EVERY render request so the server never has to re-probe a
        // possibly-short length or fall back to its own default dimensions/fps.
        const durationSec = computeExportDurationSec(timeline);
        const fps = resolveExportFps(timeline);
        const width = timeline.width || 1920;
        const height = timeline.height || 1080;

        // Base body fields (C2), sent for BOTH engines. The Remotion branch adds
        // the render manifest (C3/C4) on top. Uses `effectiveEngine` so an
        // auto-fallback (remotion → classic) actually routes to Classic.
        const extra: Record<string, unknown> = {
          engine: effectiveEngine,
          width,
          height,
          fps,
          durationSec,
        };

        let compiled: CompileTimelineResult;

        if (effectiveEngine === 'remotion') {
          // REMOTION (C4). The worker fetches media over the network, so we do
          // NOT inline `data:` URIs here (no MAX_INLINE_BYTES cap): instead we
          // mint backend-SIGNED absolute https URLs for the workspace blobs on
          // the timeline and build a `resolveSrc(src) => url` resolver the
          // manifest applies to every clip src. A mint failure throws
          // VdzBlobUrlError → surfaced to the export UI (never a silently broken
          // manifest); the Classic engine stays available as a fallback.
          const workspaceId = workspaceService.workspace.id;
          const blobIds = collectTimelineBlobIds(timeline);
          const signed = await fetchSignedBlobUrls(workspaceId, blobIds);
          const resolveSrc = makeSignedSrcResolver(signed);

          // The transport still POSTs `{ html, ...extra }`, but the worker
          // renders from the MANIFEST and ignores this html — so we compile with
          // an EMPTY resolve map (no inlining, no network, no size cap) purely to
          // satisfy the body shape and populate `lastCompile` diagnostics.
          compiled = compileTimelineToHtml(timeline, { resolveSrc: {} });
          setLastCompile(compiled);
          // Nothing was inlined on this path; any truly unfetchable src is
          // reported via the manifest's `unresolved` list instead.
          setSkippedMedia([]);

          // Build the render manifest with the signed-URL resolver and send it
          // with the html so the backend routes to the Remotion worker
          // (effective when CDZ_REMOTION_URL is set). Code-split alongside the
          // compiler so a classic export never loads it.
          const { buildRenderManifest } = await import(
            './remotion/render-manifest'
          );
          extra.manifest = buildRenderManifest(timeline, { resolveSrc });
        } else {
          // CLASSIC (unchanged). The offline headless-Chrome tier cannot fetch
          // `vdz-blob:`/remote srcs, so it inlines every distinct src to a
          // `data:` URI under the MAX_INLINE_BYTES budget exactly as before.
          const { resolveSrc, skipped } = await resolveTimelineMedia(
            timeline,
            blobSync
          );
          setSkippedMedia(skipped);
          compiled = compileTimelineToHtml(timeline, { resolveSrc });
          setLastCompile(compiled);
        }

        // Hand the compiled HTML + the C2 fields to the shared render path
        // (enqueue → poll → file url). The service rejects an empty composition
        // with a typed 400 that the export hook surfaces as an error; the
        // classic tier also rejects durationSec > 300s with a duration_cap 400.
        await startRender(compiled.html, extra);
      } catch (e) {
        // A signed-URL mint failure (Remotion path) is the one error raised
        // BEFORE the render enqueue, so the shared transport (`export.error`)
        // never sees it. Surface it through this hook's own `prepareError` so
        // the export UI can render it, then swallow — the dialog can fall back
        // to the Classic engine (its own inlining path is unaffected). Any other
        // (unexpected) error is left to propagate.
        if (e instanceof VdzBlobUrlError) {
          setPrepareError(e.message);
          return;
        }
        throw e;
      } finally {
        setPreparing(false);
      }
    },
    [workspaceService, startRender]
  );

  return useMemo(
    () => ({
      export: exporter,
      capabilities,
      fellBackToClassic,
      preparing,
      lastCompile,
      skippedMedia,
      prepareError,
      dialogOpen,
      openDialog,
      closeDialog,
      start,
    }),
    [
      exporter,
      capabilities,
      fellBackToClassic,
      preparing,
      lastCompile,
      skippedMedia,
      prepareError,
      dialogOpen,
      openDialog,
      closeDialog,
      start,
    ]
  );
}
