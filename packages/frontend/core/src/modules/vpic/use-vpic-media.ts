import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { useService } from '@toeverything/infra';
import { useCallback, useMemo } from 'react';

/**
 * VPIC Studio — media hook: the single place user media enters the image
 * editor. It is the direct sibling of the Vdz studio's `use-vdz-media.ts` and
 * deliberately mirrors its mechanics (see that file for the long-form rationale
 * on WHY object URLs are cached-for-session, WHY blobs are stored via
 * `blobSync.set`, etc.). The differences from Vdz are only the ones VPIC needs:
 *
 *   · VPIC is an IMAGE editor, so this hook only ever deals with still images
 *     (no video/audio probing, no poster capture). The mime allowlist is the
 *     narrow set the Canvas2D engine can decode + re-encode losslessly-ish:
 *     jpeg / png / webp, plus gif which we accept but FLATTEN to its first
 *     frame on export (the engine draws a single bitmap — animation is lost;
 *     that's an accepted v0 limitation, surfaced as a note here, not an error).
 *
 *   · VPIC needs actual PIXELS in the workspace, not just a remote <img src>.
 *     Vdz can point a clip straight at a stock/AI https URL because its
 *     renderer streams those URLs; the VPIC engine instead has to READ the
 *     bitmap (crop/filter/export), so {@link importFromUrl} pulls the remote
 *     bytes into a real Blob and stores them as a durable workspace blob — the
 *     same content-addressed path an uploaded file takes. There is no
 *     FE-callable server proxy for arbitrary remote URLs (the backend's
 *     `handleRemoteLink` is internal to the image-generation pipeline), so the
 *     fetch happens client-side and any CORS / network failure fails SOFT to
 *     `null` — the caller shows "couldn't import, try upload" rather than
 *     throwing. Same-origin (our own `/api/copilot/blob/...`) and CORS-enabled
 *     stock hosts (Openverse / Pexels / Pixabay / Unsplash all send
 *     `Access-Control-Allow-Origin: *` on their image CDNs) import fine.
 *
 * The pinned surface (R14-CONTRACT) is intentionally tiny — five callbacks,
 * all stable (useCallback + a useMemo'd bag) so a consumer can depend on the
 * returned object without triggering render churn. NO React-render side
 * effects: this hook holds no state and schedules no effects; it is pure glue
 * over the workspace blob store + the copilot stock route.
 *
 * Every network call is wrapped in {@link cdzApiUrl} so desktop/native builds
 * resolve against the connected server (web is same-origin, a no-op).
 */

/**
 * Durable handle scheme for VPIC. A persisted project references
 * `vpic-blob:<blobId>` (see {@link vpicBlobSrc}) instead of a session-scoped
 * `blob:` object URL, so a saved + reopened project still points at real bytes
 * (the object URL a reload would inherit is dead — its backing Blob died with
 * the previous page). {@link resolveUrl} turns a {@link VpicImageHandle} back
 * into a live object URL on demand. This mirrors Vdz's `vdz-blob:` scheme.
 */
export const VPIC_BLOB_SCHEME = 'vpic-blob:';

/** Wrap a workspace blobId into a durable, serializable VPIC src string. */
export function vpicBlobSrc(blobId: string): string {
  return `${VPIC_BLOB_SCHEME}${blobId}`;
}

/** True iff `src` is one of our durable `vpic-blob:` handles. */
export function isVpicBlobSrc(src: string): boolean {
  return src.startsWith(VPIC_BLOB_SCHEME);
}

/** Extract the blobId from a `vpic-blob:` src, or null if it isn't one. */
export function blobIdFromVpicSrc(src: string): string | null {
  return isVpicBlobSrc(src) ? src.slice(VPIC_BLOB_SCHEME.length) : null;
}

/**
 * A durable reference to an image living in the workspace blob store. This is
 * what a VPIC project persists (alongside the engine op-state JSON): the
 * content-addressed `blobId` plus a human-friendly `name` for the UI. It is
 * NOT a usable <img> src on its own — resolve it via {@link useVpicMedia}'s
 * `resolveUrl` (or serialize it with {@link vpicBlobSrc}).
 */
export interface VpicImageHandle {
  blobId: string;
  name: string;
}

/**
 * Max input image size, in bytes. Matches the Vdz studio's image cap
 * (`VDZ_MEDIA_LIMITS.image` = 25MB) so the two studios feel identical and a
 * user can't sneak a huge bitmap into one that the other would reject. Applied
 * to both local picks and remote imports (after the bytes are in hand).
 */
export const VPIC_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Mime types the VPIC engine can decode AND re-encode. jpeg / png / webp are
 * first-class (round-trip cleanly). gif is ACCEPTED for import but treated as a
 * static image — only its first frame is drawn, and exports are flattened to
 * one of the three encodable types; animation is dropped (v0 limitation). SVG
 * and other vector/exotic formats are rejected: the engine is raster-only and a
 * tainted/oversized decode would break crop/export.
 */
export const VPIC_ACCEPTED_MIME: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

/** File extensions we sniff when the browser hands us an empty MIME type. */
const VPIC_ACCEPTED_EXT: readonly string[] = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
];

/**
 * The `accept` attribute value for the <input type="file"> the picker builds —
 * keep it in sync with {@link VPIC_ACCEPTED_MIME} so the OS dialog pre-filters
 * to formats we can actually open.
 */
export const VPIC_FILE_ACCEPT = VPIC_ACCEPTED_MIME.join(',');

/** Human-readable file size (used in the console note on rejects). */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * Decide whether a Blob/File is an image kind VPIC can open. Prefers the MIME
 * type; falls back to extension sniffing (only meaningful for File, which has a
 * `name`) when the browser gives no type — same defensive shape as Vdz's
 * `mediaKindOfFile`. Returns true for gif too (flattened on use).
 */
function isAcceptedImage(blob: Blob, name?: string): boolean {
  const type = (blob.type || '').toLowerCase();
  if (type) return VPIC_ACCEPTED_MIME.includes(type);
  const ext = (name ?? '').split('.').pop()?.toLowerCase() ?? '';
  return VPIC_ACCEPTED_EXT.includes(ext);
}

/**
 * The normalized stock-search response envelope. The copilot stock route
 * (`GET /api/copilot/stock/search`) returns flat, per-item fields
 * (`url` / `thumb` / `full` / `author` / `source` / `link` / `description`)
 * plus a legacy `urls` alias object — see the backend `stockPhoto()` normalizer.
 * We read the flat fields first and treat `urls.*` as a fallback, exactly as
 * the Vdz hook does, so this keeps working if either provider shape shifts.
 * Failure replies carry a friendly `message` / `error` and an empty `results`.
 */
interface StockSearchResponse {
  source?: string;
  message?: string;
  error?: string;
  results?: Array<{
    id?: string;
    source?: string;
    url?: string;
    thumb?: string;
    full?: string;
    description?: string;
    author?: string;
    link?: string;
    urls?: { thumb?: string; small?: string; regular?: string; full?: string };
  }>;
}

/**
 * Max stock results we surface from a single search. The route caps `per_page`
 * server-side too (`STOCK_MAX_PER_PAGE`); we request this many and slice
 * defensively. Matches Vdz's `STOCK_LIMIT`.
 */
const VPIC_STOCK_LIMIT = 12;

/**
 * Store raw image bytes in the workspace blob store and hand back both the
 * durable handle and a session-scoped object URL for immediate display. This is
 * the shared tail of `pickLocal` / `saveBlob` / `importFromUrl` — one place
 * that talks to `blobSync`, so the storage idiom (content-addressed `set` →
 * `get` → `createObjectURL`) lives exactly once.
 *
 * `blobSync.set` is content-addressed: two identical bitmaps collapse to one
 * blobId, and the returned id also syncs to the connected server, so the handle
 * survives reloads and other devices. We resolve the stored blob straight back
 * to an object URL (falling back to the in-memory blob if the read races) — the
 * same trick the AFFiNE image-preview modal + file-cell preview use.
 */
async function persistBlob(
  blobSync: { set: (b: Blob) => Promise<string>; get: (id: string) => Promise<Blob | null> },
  blob: Blob,
  name: string
): Promise<{ handle: VpicImageHandle; url: string }> {
  const blobId = await blobSync.set(blob);
  const stored = await blobSync.get(blobId);
  const url = URL.createObjectURL(stored ?? blob);
  return { handle: { blobId, name }, url };
}

/**
 * The pinned VPIC media surface. See {@link useVpicMedia} for the runtime.
 * Kept as a named interface so consumers (Easel's editor-panel, Wand's mask
 * panel) can type against it without importing the hook's internals.
 */
export interface UseVpicMedia {
  /**
   * Open the OS file picker, restricted to VPIC-openable image types. On pick:
   * size-check, store to the workspace blob store, and return the durable
   * handle + a session object URL for the <canvas>/<img>. Resolves `null` when
   * the user cancels, or fails soft to `null` (with a console note) on an
   * unsupported / oversized / unreadable file — never throws at the caller.
   */
  pickLocal(): Promise<{ handle: VpicImageHandle; url: string } | null>;
  /**
   * Persist an arbitrary image Blob (e.g. an engine export, or a mask-panel
   * generation result) as a durable workspace blob and return its handle + a
   * fresh object URL. Throws only on a genuine storage failure — callers that
   * want fail-soft should guard it; the export/save flows want the error.
   */
  saveBlob(blob: Blob, name: string): Promise<{ handle: VpicImageHandle; url: string }>;
  /**
   * Resolve a durable {@link VpicImageHandle} back to a live object URL usable
   * as an <img>/<canvas> source. Returns `null` when the blob is missing or not
   * yet synced (caller shows a placeholder), mirroring Vdz's `resolveBlobSrc`.
   */
  resolveUrl(handle: VpicImageHandle): Promise<string | null>;
  /**
   * Search free stock photo providers via `GET /api/copilot/stock/search`
   * (keyless Openverse always works; Pexels / Pixabay / Unsplash light up when
   * the server has keys). Returns picker rows mapped to the pinned
   * `{ url, thumb, author, source }` shape. Any failure fails soft to `[]` (the
   * route itself never 500s — it replies with a friendly message + empty list).
   */
  searchStock(
    q: string,
    page?: number
  ): Promise<Array<{ url: string; thumb: string; author: string; source: string }>>;
  /**
   * Pull a remote image (a stock/AI result URL) into the workspace blob store
   * so the engine can read its pixels, returning the durable handle + object
   * URL. Fails SOFT to `null` on a CORS block, network error, non-image body,
   * or oversize — the caller falls back to "couldn't import, try uploading".
   */
  importFromUrl(
    url: string,
    name: string
  ): Promise<{ handle: VpicImageHandle; url: string } | null>;
}

export function useVpicMedia(): UseVpicMedia {
  const workspaceService = useService(WorkspaceService);

  // ---- pickLocal --------------------------------------------------------
  const pickLocal = useCallback(async (): Promise<{
    handle: VpicImageHandle;
    url: string;
  } | null> => {
    // Build a throwaway <input type="file"> and await a single pick. We resolve
    // `null` on cancel; the browser fires no event for cancel, so we rely on
    // the change event alone and let the promise settle on selection. (A stuck
    // promise on cancel is harmless — it's GC'd with the input — and matches how
    // the AFFiNE file cells drive their pickers.)
    const file = await new Promise<File | null>(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = VPIC_FILE_ACCEPT;
      input.onchange = () => {
        resolve(input.files && input.files.length > 0 ? input.files[0] : null);
      };
      input.click();
    });
    if (!file) return null;

    // Validate BEFORE we touch the blob store, so a bad file never persists.
    if (!isAcceptedImage(file, file.name)) {
      // Fail soft — the UI already pre-filtered via `accept`, so this only
      // trips on a manually-typed path or an odd MIME. Note and bail.
      console.warn(`[vpic] unsupported image type: ${file.type || file.name}`);
      return null;
    }
    if (file.size > VPIC_IMAGE_MAX_BYTES) {
      console.warn(
        `[vpic] image ${humanBytes(file.size)} exceeds ${humanBytes(VPIC_IMAGE_MAX_BYTES)} cap`
      );
      return null;
    }

    try {
      // A File IS a Blob, so it goes straight to the store — the same call the
      // database file cell + image blocks use.
      const blobSync = workspaceService.workspace.docCollection.blobSync;
      return await persistBlob(blobSync, file, file.name);
    } catch (err) {
      console.warn(
        `[vpic] failed to store picked image: ${err instanceof Error ? err.message : 'unknown error'}`
      );
      return null;
    }
  }, [workspaceService]);

  // ---- saveBlob ---------------------------------------------------------
  const saveBlob = useCallback(
    async (
      blob: Blob,
      name: string
    ): Promise<{ handle: VpicImageHandle; url: string }> => {
      // No fail-soft here: the export / save-to-workspace / mask-apply flows
      // genuinely need to know when a save failed (to surface vpic.error), so
      // we let a storage error propagate. Size is NOT re-capped — an engine
      // export of an already-in-bounds source can legitimately exceed the input
      // cap (e.g. a lossless PNG of a large canvas), and rejecting the user's
      // own edit would be worse than storing it.
      const blobSync = workspaceService.workspace.docCollection.blobSync;
      return persistBlob(blobSync, blob, name);
    },
    [workspaceService]
  );

  // ---- resolveUrl -------------------------------------------------------
  const resolveUrl = useCallback(
    async (handle: VpicImageHandle): Promise<string | null> => {
      try {
        const blobSync = workspaceService.workspace.docCollection.blobSync;
        const blob = await blobSync.get(handle.blobId);
        if (!blob) return null; // missing / not-yet-synced → caller placeholders
        return URL.createObjectURL(blob);
      } catch {
        // A blob-store read failure is non-fatal for display — placeholder it.
        return null;
      }
    },
    [workspaceService]
  );

  // ---- searchStock ------------------------------------------------------
  const searchStock = useCallback(
    async (
      q: string,
      page = 1
    ): Promise<
      Array<{ url: string; thumb: string; author: string; source: string }>
    > => {
      const trimmed = q.trim();
      try {
        const params = new URLSearchParams();
        if (trimmed) params.set('query', trimmed);
        // `source` is omitted → the route's `auto` default (a keyed provider if
        // configured, else keyless Openverse). VPIC doesn't expose a source
        // picker in v0, so we let the server choose the best available one.
        params.set('page', String(Math.max(1, Math.floor(page))));
        params.set('per_page', String(VPIC_STOCK_LIMIT));
        const response = await fetch(
          cdzApiUrl(`/api/copilot/stock/search?${params.toString()}`)
        );
        const data = (await response
          .json()
          .catch(() => null)) as StockSearchResponse | null;
        // The route replies 200 with results, or 4xx/5xx with a friendly
        // message + empty results — either way we only care about `results`.
        // On a non-ok status with no parsable body, fall through to [].
        if (!response.ok) {
          console.warn(
            `[vpic] stock search unavailable: ${
              (typeof data?.message === 'string' && data.message) ||
              `status ${response.status}`
            }`
          );
          return [];
        }
        const results = Array.isArray(data?.results) ? data.results : [];
        return results.slice(0, VPIC_STOCK_LIMIT).flatMap(r => {
          // Flat normalized field first; `urls.regular` is the legacy alias.
          const url = r.url || r.urls?.regular || r.full || r.urls?.full;
          if (typeof url !== 'string' || !url) return [];
          const thumb =
            r.thumb || r.urls?.small || r.urls?.thumb || url;
          return [
            {
              url,
              thumb,
              author: r.author || '',
              source: r.source || data?.source || '',
            },
          ];
        });
      } catch (err) {
        // Network/JSON failure — fail soft to an empty grid.
        console.warn(
          `[vpic] stock search failed: ${err instanceof Error ? err.message : 'unknown error'}`
        );
        return [];
      }
    },
    []
  );

  // ---- importFromUrl ----------------------------------------------------
  const importFromUrl = useCallback(
    async (
      url: string,
      name: string
    ): Promise<{ handle: VpicImageHandle; url: string } | null> => {
      try {
        // CORS-mode fetch: our own blob endpoints are same-origin, and the
        // stock CDNs we surface (Openverse / Pexels / Pixabay / Unsplash) all
        // send permissive CORS on their image assets, so this succeeds for the
        // URLs VPIC actually produces. A host without CORS throws a TypeError
        // here — caught below and returned as `null` (fail soft), NOT rethrown.
        // There is no server-side proxy to fall back on (the backend's
        // remote-link helper is internal to the image pipeline, not a route).
        const response = await fetch(url, { mode: 'cors' });
        if (!response.ok) {
          console.warn(
            `[vpic] import failed: ${url} → status ${response.status}`
          );
          return null;
        }
        const blob = await response.blob();
        // Guard the two ways a remote fetch can still be unusable: not an image
        // we can decode, or bigger than the input cap.
        if (!isAcceptedImage(blob, name) && !isAcceptedImage(blob, url)) {
          console.warn(
            `[vpic] import rejected: ${url} is not a supported image (${blob.type || 'unknown type'})`
          );
          return null;
        }
        if (blob.size > VPIC_IMAGE_MAX_BYTES) {
          console.warn(
            `[vpic] imported image ${humanBytes(blob.size)} exceeds ${humanBytes(VPIC_IMAGE_MAX_BYTES)} cap`
          );
          return null;
        }
        const blobSync = workspaceService.workspace.docCollection.blobSync;
        return await persistBlob(blobSync, blob, name);
      } catch (err) {
        // CORS block (opaque/blocked → TypeError), network error, or a storage
        // failure — all fail soft. The caller shows "couldn't import".
        console.warn(
          `[vpic] importFromUrl failed for ${url}: ${err instanceof Error ? err.message : 'blocked (likely CORS)'}`
        );
        return null;
      }
    },
    [workspaceService]
  );

  // Stable bag so consumers can depend on the object identity across renders.
  return useMemo(
    () => ({ pickLocal, saveBlob, resolveUrl, searchStock, importFromUrl }),
    [pickLocal, saveBlob, resolveUrl, searchStock, importFromUrl]
  );
}
