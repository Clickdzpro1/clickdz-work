import { WorkspaceService } from '@affine/core/modules/workspace';
import { useService } from '@toeverything/infra';
import { useCallback, useMemo, useState } from 'react';

import {
  compileTimelineToHtml,
  type CompileTimelineResult,
} from './compile-timeline';
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
 */

/**
 * Total inlined-media budget in bytes. The render proxy + service both cap the
 * whole HTML document at 2 MB; base64 inflates bytes ~1.37×, and the document
 * scaffold/keyframes cost a little too, so we budget ~1.4 MB of RAW media which
 * leaves headroom under the 2 MB ceiling after encoding + markup.
 */
const MAX_INLINE_BYTES = 1_400_000;

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
  /**
   * Compile the timeline, inline its media, and start the MP4 render. Rejects
   * (via the export hook's error state) when there is nothing to render.
   */
  start: (timeline: VdzTimeline) => Promise<void>;
}

/**
 * The editor's Export-MP4 hook: compile the current timeline, inline media, and
 * drive the shared render transport. Consumed by the toolbar's Export button.
 */
export function useVdzTimelineExport(): UseVdzTimelineExport {
  const workspaceService = useService(WorkspaceService);
  const exporter = useVdzExport();
  const [preparing, setPreparing] = useState(false);
  const [lastCompile, setLastCompile] = useState<CompileTimelineResult | null>(
    null
  );
  const [skippedMedia, setSkippedMedia] = useState<string[]>([]);

  const { start: startRender } = exporter;

  const start = useCallback(
    async (timeline: VdzTimeline): Promise<void> => {
      setPreparing(true);
      setSkippedMedia([]);
      try {
        const blobSync = workspaceService.workspace.docCollection.blobSync;
        const { resolveSrc, skipped } = await resolveTimelineMedia(
          timeline,
          blobSync
        );
        setSkippedMedia(skipped);
        const compiled = compileTimelineToHtml(timeline, { resolveSrc });
        setLastCompile(compiled);
        // Hand the compiled HTML to the shared render path (enqueue → poll →
        // file url). The service rejects an empty composition with a typed 400
        // that the export hook surfaces as an error.
        await startRender(compiled.html);
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
      start,
    }),
    [exporter, preparing, lastCompile, skippedMedia, start]
  );
}
