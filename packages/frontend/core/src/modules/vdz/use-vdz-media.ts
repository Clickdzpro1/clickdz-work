import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { useService } from '@toeverything/infra';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Vdz Studio — media hook: the single place user media enters the studio.
 *
 * Three sources, one shape ({@link VdzMediaItem}):
 *   · Upload — a local {@link File}. We store the bytes in the workspace's
 *     blob store via `workspace.docCollection.blobSync.set(blob)` (the exact
 *     AFFiNE-native path the database file cell + image blocks use), which
 *     returns a durable, content-addressed `blobId` that also syncs to the
 *     connected server. For DISPLAY we resolve that blob back to a Blob and wrap
 *     it in `URL.createObjectURL(...)` — the same trick the image-preview modal
 *     and the file-cell preview use to turn a stored blob into an <img>/<video>
 *     `src`. The object URL is session-scoped; the blobId is the durable handle.
 *   · AI images — the EXISTING `POST /api/v1/images/generations` route
 *     (`{prompt}` → `{data:[{url}]}`), wrapped in {@link cdzApiUrl}. Remote
 *     https URLs are used directly as the clip `src`, mirroring the ClickDz
 *     builder studio's image insert.
 *   · Stock — the `GET /api/copilot/stock/search?query=…&source=…` route
 *     (multi-provider: keyless Openverse always works; Pexels / Pixabay /
 *     Unsplash when the server has their keys), normalized server-side to
 *     `{results:[{url,thumb,author,link,source,…}]}`, wrapped in
 *     {@link cdzApiUrl}. Again a remote https URL used directly.
 *
 * Every network call goes through `cdzApiUrl(...)` so desktop/native builds
 * resolve against the connected server (web is a no-op — same origin).
 */

/**
 * Durable clip-src scheme. A clip persists `vdz-blob:<blobId>` instead of a
 * session-scoped `blob:` object URL, so a saved/reloaded timeline still points
 * at real bytes (the object URL a reload would have inherited is dead — its
 * backing Blob died with the previous page). The {@link useBlobUrl} hook /
 * {@link resolveBlobSrc} resolver turn `vdz-blob:` back into a live object URL
 * on demand; every other src (http(s)/blob:/data:) passes through untouched.
 */
export const VDZ_BLOB_SCHEME = 'vdz-blob:';

/** Wrap a workspace blobId into a durable, serializable clip src. */
export function vdzBlobSrc(blobId: string): string {
  return `${VDZ_BLOB_SCHEME}${blobId}`;
}

/** True iff `src` is one of our durable `vdz-blob:` handles. */
export function isVdzBlobSrc(src: string): boolean {
  return src.startsWith(VDZ_BLOB_SCHEME);
}

/** Extract the blobId from a `vdz-blob:` src, or null if it isn't one. */
export function blobIdFromSrc(src: string): string | null {
  return isVdzBlobSrc(src) ? src.slice(VDZ_BLOB_SCHEME.length) : null;
}

/** Media kind, aligned with the clip `type`s that carry a `src`. */
export type VdzMediaKind = 'video' | 'audio' | 'image';

/** Where a bin item came from (drives the badge + whether it's revocable). */
export type VdzMediaSource = 'upload' | 'ai' | 'stock';

/** One item in the media bin — a usable, displayable piece of media. */
export interface VdzMediaItem {
  /** Local, stable id for the bin (NOT the clip id). */
  id: string;
  kind: VdzMediaKind;
  source: VdzMediaSource;
  name: string;
  /** A URL usable directly as an <img>/<video>/<audio> `src`. */
  url: string;
  /** Durable workspace blob id for uploads; undefined for remote media. */
  blobId?: string;
  /** Probed media duration in seconds (0 for images / when unknown). */
  duration: number;
  /** A small poster/thumbnail data URL (video frame / image), if captured. */
  thumbnail?: string;
  /** MIME type, when known. */
  mime?: string;
  /** Attribution line for stock media (photographer / creator name). */
  credit?: string;
  /** Landing page for the credited work on its provider, if any. */
  creditUrl?: string;
  /** Which stock provider a `source: 'stock'` item came from. */
  provider?: string;
}

/** Per-kind upload size caps, in bytes. */
export const VDZ_MEDIA_LIMITS: Record<VdzMediaKind, number> = {
  video: 100 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  image: 25 * 1024 * 1024,
};

/** Classify a File into a media kind, or null if unsupported. */
export function mediaKindOfFile(file: File): VdzMediaKind | null {
  const type = file.type || '';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('image/')) return 'image';
  // Fall back to extension sniffing when the browser gives no MIME type.
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv', 'avi', 'mkv'].includes(ext)) {
    return 'video';
  }
  if (
    ['mp3', 'wav', 'ogg', 'oga', 'aac', 'm4a', 'flac', 'opus'].includes(ext)
  ) {
    return 'audio';
  }
  if (
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(ext)
  ) {
    return 'image';
  }
  return null;
}

/** Human-readable file size (used in error messages). */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * Probe a media object URL for its intrinsic duration (video/audio) by loading
 * metadata into a detached element. Resolves 0 on any failure or for images.
 */
function probeDuration(url: string, kind: VdzMediaKind): Promise<number> {
  if (kind === 'image') return Promise.resolve(0);
  return new Promise<number>(resolve => {
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    let settled = false;
    const done = (value: number) => {
      if (settled) return;
      settled = true;
      el.removeAttribute('src');
      resolve(value);
    };
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () =>
      done(Number.isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => done(0);
    // Guard against media that never fires metadata (bad codecs, etc.).
    setTimeout(() => done(0), 8000);
    el.src = url;
  });
}

/**
 * Capture a poster frame for a video as a data URL, seeking a little past the
 * start so we skip a black first frame. Resolves undefined on any failure.
 */
function captureVideoThumbnail(url: string): Promise<string | undefined> {
  return new Promise<string | undefined>(resolve => {
    const video = document.createElement('video');
    let settled = false;
    const done = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      video.removeAttribute('src');
      resolve(value);
    };
    video.preload = 'metadata';
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.onloadeddata = () => {
      // Seek ~0.3s in (clamped) to avoid an all-black opening frame.
      const target = Math.min(0.3, (video.duration || 1) / 2);
      video.currentTime = Number.isFinite(target) ? target : 0;
    };
    video.onseeked = () => {
      try {
        const w = 160;
        const ratio = video.videoHeight / (video.videoWidth || 1) || 0.5625;
        const h = Math.round(w * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return done(undefined);
        ctx.drawImage(video, 0, 0, w, h);
        done(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        // Tainted canvas (cross-origin) or draw failure — no thumbnail.
        done(undefined);
      }
    };
    video.onerror = () => done(undefined);
    setTimeout(() => done(undefined), 8000);
    video.src = url;
  });
}

/** The server envelope for the image-generations route. */
interface ImageGenResponse {
  data?: Array<{ url?: string }>;
  error?: { message?: string };
  message?: string;
}

/**
 * The server envelope for the multi-provider stock search route. Items carry
 * flat normalized fields plus a legacy `urls` alias; error replies carry a
 * user-friendly `message` (e.g. a keyed source that is not configured).
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

// ---- Durable blob-src resolver -------------------------------------------

/**
 * The tiny slice of the workspace blob store we need to resolve a blobId back
 * to bytes. `workspace.docCollection.blobSync` (a blocksuite `BlobEngine`)
 * satisfies this: `get(blobId)` resolves to the stored `Blob` (or null).
 */
interface BlobGetter {
  get: (blobId: string) => Promise<Blob | null>;
}

/**
 * Module-level, session-scoped cache of blobId → object URL. Content-addressed
 * blobIds (sha of the bytes) are globally unique, so caching by blobId alone is
 * safe across timelines/workspaces. We retain object URLs for the whole session
 * (never revoke): a clip can be added/removed/re-added freely and the same URL
 * stays valid, which is far simpler — and cheaper — than refcounting, and the
 * page teardown reclaims everything anyway. `inflight` de-dupes concurrent
 * resolves of the same blob (e.g. a video + its many rAF re-renders).
 */
const blobUrlCache = new Map<string, string>();
const blobUrlInflight = new Map<string, Promise<string | undefined>>();

/**
 * Resolve a clip `src` to a directly-usable media URL.
 *
 * · `vdz-blob:<id>` → fetch the blob via `getter.get(id)`, wrap in an object
 *   URL, and cache it (subsequent calls are synchronous cache hits).
 * · anything else (http(s)/blob:/data:) is returned unchanged.
 *
 * Resolves `undefined` only when a `vdz-blob:` handle can't be fetched (missing
 * blob / not yet synced) so callers can show a placeholder.
 */
export async function resolveBlobSrc(
  src: string,
  getter: BlobGetter
): Promise<string | undefined> {
  const blobId = blobIdFromSrc(src);
  if (blobId === null) return src; // pass-through for remote/data/blob URLs

  const cached = blobUrlCache.get(blobId);
  if (cached) return cached;

  const existing = blobUrlInflight.get(blobId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const blob = await getter.get(blobId);
      if (!blob) return undefined;
      const url = URL.createObjectURL(blob);
      blobUrlCache.set(blobId, url);
      return url;
    } catch {
      return undefined;
    } finally {
      blobUrlInflight.delete(blobId);
    }
  })();
  blobUrlInflight.set(blobId, promise);
  return promise;
}

/** Synchronous cache peek — a resolved object URL for `src`, if we have one. */
function peekResolvedSrc(src: string): string | undefined {
  const blobId = blobIdFromSrc(src);
  if (blobId === null) return src; // non-blob srcs are already usable
  return blobUrlCache.get(blobId);
}

/**
 * Resolve a (possibly `vdz-blob:`) clip `src` to a URL usable directly as an
 * <img>/<video>/<audio> `src`, fetching + caching the workspace blob on first
 * use. Returns `undefined` while a blob is still resolving (show a placeholder)
 * and the URL thereafter. Plain http(s)/blob:/data: srcs resolve synchronously.
 *
 * The empty string yields `undefined` (an empty clip src, i.e. "no media yet").
 */
export function useBlobUrl(src: string): string | undefined {
  const workspaceService = useService(WorkspaceService);
  // Seed synchronously from the cache so already-resolved blobs (and every
  // pass-through src) render on the FIRST paint — no placeholder flash.
  const [resolved, setResolved] = useState<string | undefined>(() =>
    src ? peekResolvedSrc(src) : undefined
  );

  useEffect(() => {
    if (!src) {
      setResolved(undefined);
      return;
    }
    const hit = peekResolvedSrc(src);
    if (hit) {
      setResolved(hit);
      return;
    }
    // Miss: a vdz-blob: src not yet in cache. Resolve async, guard against
    // setting state after unmount / a src change mid-flight.
    setResolved(undefined);
    let alive = true;
    const blobSync = workspaceService.workspace.docCollection.blobSync;
    void resolveBlobSrc(src, blobSync).then(url => {
      if (alive) setResolved(url);
    });
    return () => {
      alive = false;
    };
  }, [src, workspaceService]);

  return resolved;
}

// ---- CDZIMAGE generation options (WS1 PR4) --------------------------------

/** The CDZIMAGE tiers the Vdz bin can request (1.0 is Vdz-only by policy). */
export type CdzImageTier =
  | 'cdzimage-2.0'
  | 'cdzimage-1.5'
  | 'cdzimage-1.0'
  | 'gemini-3-pro-image'
  | 'gemini-3.1-flash-image'
  | 'gemini-2.5-flash-image';
export const CDZIMAGE_TIER_OPTIONS: Array<{ id: CdzImageTier; label: string }> =
  [
    { id: 'cdzimage-2.0', label: 'CDZIMAGE 2.0 · best' },
    { id: 'cdzimage-1.5', label: 'CDZIMAGE 1.5 · balanced' },
    { id: 'cdzimage-1.0', label: 'CDZIMAGE 1.0 · economy' },
    // CDZIM (Gemini) tiers — the backend routes these ids to the Gemini
    // generateContent API; labels follow the French-friendly CDZIM wording.
    { id: 'gemini-3-pro-image', label: 'CDZIM Pro · qualité' },
    { id: 'gemini-3.1-flash-image', label: 'CDZIM Flash · rapide' },
    { id: 'gemini-2.5-flash-image', label: 'CDZIM Classic · économie' },
  ];

/** How a reference image is used: true edit vs inspiration (reinterpret). */
export type CdzImageRefMode = 'edit' | 'reinterpret';

export interface VdzGenerateImageOptions {
  tier?: CdzImageTier;
  reference?: { item: VdzMediaItem; mode: CdzImageRefMode };
  /** Fast mode: skip prompt enhancement + lighter quality for lower latency. */
  fast?: boolean;
}

/** Reference images bigger than this are rejected client-side (JSON weight). */
const MAX_REFERENCE_BYTES = 6 * 1024 * 1024;

/**
 * Resolve a bin item to something the images API accepts as input: data: and
 * http(s) URLs pass through (the server fetches public URLs behind its SSRF
 * guard); session `blob:` object URLs are read into a base64 data URL here —
 * the server can never fetch a browser-local blob.
 */
async function resolveReferenceForApi(item: VdzMediaItem): Promise<string> {
  const url = item.url;
  if (/^data:/i.test(url) || /^https?:/i.test(url)) return url;
  if (!/^blob:/i.test(url)) {
    throw new Error('This item cannot be used as a reference image.');
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Could not read the reference image.');
  }
  const blob = await response.blob();
  if (blob.size > MAX_REFERENCE_BYTES) {
    throw new Error(
      `Reference image is too large (max ${Math.floor(MAX_REFERENCE_BYTES / (1024 * 1024))}MB).`
    );
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the reference image.'));
    reader.readAsDataURL(blob);
  });
  if (!/^data:image\//i.test(dataUrl)) {
    throw new Error('The reference must be an image.');
  }
  return dataUrl;
}

// ---- Stock search sources (WS11 STOCK) -------------------------------------

/**
 * Stock providers the backend can search. Openverse needs no API key, so it
 * works on every deployment; the rest light up when the server has their
 * keys. `auto` lets the server pick (a keyed provider first, keyless
 * Openverse as the fallback).
 */
export type VdzStockSource =
  | 'auto'
  | 'openverse'
  | 'pexels'
  | 'pixabay'
  | 'unsplash';

/** Picker options for the stock tab (Openverse first — always available). */
export const VDZ_STOCK_SOURCE_OPTIONS: Array<{
  id: VdzStockSource;
  label: string;
}> = [
  { id: 'openverse', label: 'Openverse' },
  { id: 'pexels', label: 'Pexels' },
  { id: 'pixabay', label: 'Pixabay' },
  { id: 'unsplash', label: 'Unsplash' },
  { id: 'auto', label: 'Auto' },
];

export interface UseVdzMedia {
  items: VdzMediaItem[];
  /** Non-fatal status message for the current op (upload/search), or null. */
  error: string | null;
  /** True while any generate/search request is in flight. */
  busy: boolean;
  /**
   * Import a list of local files (from the picker or a drop). Each is size-
   * checked, stored as a workspace blob, probed and added to the bin. Returns
   * the items that were added (skipping unsupported / oversized files).
   */
  importFiles: (files: File[] | FileList) => Promise<VdzMediaItem[]>;
  /**
   * Generate AI images from a prompt and add them to the bin.
   * `options.tier` picks the CDZIMAGE model (2.0 default; Vdz is the ONE
   * surface that exposes the 1.0 economy tier). `options.reference` sends a
   * bin image as input — `mode: 'edit'` = true image-to-image (the engine
   * sees the pixels), `mode: 'reinterpret'` = "use as inspiration" (vision
   * description feeds a fresh generation). `options.fast` skips prompt
   * enhancement and drops quality one notch for lower latency.
   */
  generateImages: (
    prompt: string,
    options?: VdzGenerateImageOptions
  ) => Promise<void>;
  /**
   * Search free stock photo providers (see {@link VdzStockSource}; Openverse
   * needs no key) and return picker results with per-item credit/source —
   * the grid adds the chosen photo to the bin on click. Failures set a
   * friendly {@link UseVdzMedia.error} and resolve to `[]`.
   */
  searchStock: (
    query: string,
    source?: VdzStockSource
  ) => Promise<VdzMediaItem[]>;
  /** Add a stock/AI result URL to the bin (used by the grid click). */
  addRemote: (
    url: string,
    kind: VdzMediaKind,
    source: VdzMediaSource,
    name: string
  ) => VdzMediaItem;
  /** Remove an item from the bin (revokes its object URL if we own it). */
  remove: (id: string) => void;
  clearError: () => void;
}

/** Max stock results we keep from a single search. */
const STOCK_LIMIT = 12;

export function useVdzMedia(): UseVdzMedia {
  const workspaceService = useService(WorkspaceService);
  const [items, setItems] = useState<VdzMediaItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Track object URLs we created so we can revoke them on unmount / removal.
  const ownedUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const owned = ownedUrlsRef.current;
    return () => {
      for (const url of owned) URL.revokeObjectURL(url);
      owned.clear();
    };
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const importFiles = useCallback(
    async (input: File[] | FileList): Promise<VdzMediaItem[]> => {
      const files = Array.from(input);
      if (files.length === 0) return [];
      const blobSync = workspaceService.workspace.docCollection.blobSync;
      const added: VdzMediaItem[] = [];
      const errors: string[] = [];

      for (const file of files) {
        const kind = mediaKindOfFile(file);
        if (!kind) {
          errors.push(`${file.name}: unsupported type`);
          continue;
        }
        const cap = VDZ_MEDIA_LIMITS[kind];
        if (file.size > cap) {
          errors.push(
            `${file.name}: ${humanBytes(file.size)} exceeds ${humanBytes(cap)} ${kind} cap`
          );
          continue;
        }
        try {
          // Store durable bytes in the workspace blob store (server-synced).
          // A File IS a Blob, so it can be handed to blobSync.set directly —
          // the same call the database file cell + image blocks use.
          const blobId = await blobSync.set(file);
          // Resolve the stored blob back to a session object URL for display
          // (identical to the image-preview modal / file-cell preview trick).
          const stored = await blobSync.get(blobId);
          const url = URL.createObjectURL(stored ?? file);
          ownedUrlsRef.current.add(url);
          // Seed the durable-src resolver cache with THIS object URL so a clip
          // carrying `vdz-blob:<blobId>` (see clipFromMedia) renders instantly
          // — no re-fetch, no placeholder flash — for the rest of the session.
          if (!blobUrlCache.has(blobId)) blobUrlCache.set(blobId, url);

          const [duration, thumbnail] = await Promise.all([
            probeDuration(url, kind),
            kind === 'video'
              ? captureVideoThumbnail(url)
              : Promise.resolve<string | undefined>(
                  kind === 'image' ? url : undefined
                ),
          ]);

          added.push({
            id: `media-${nanoid(8)}`,
            kind,
            source: 'upload',
            name: file.name,
            url,
            blobId,
            duration,
            thumbnail,
            mime: file.type || undefined,
          });
        } catch (err) {
          errors.push(
            `${file.name}: ${err instanceof Error ? err.message : 'failed to import'}`
          );
        }
      }

      if (added.length > 0) setItems(prev => [...added, ...prev]);
      setError(errors.length > 0 ? errors.join(' · ') : null);
      return added;
    },
    [workspaceService]
  );

  const addRemote = useCallback(
    (
      url: string,
      kind: VdzMediaKind,
      source: VdzMediaSource,
      name: string
    ): VdzMediaItem => {
      const item: VdzMediaItem = {
        id: `media-${nanoid(8)}`,
        kind,
        source,
        name,
        url,
        duration: 0,
        thumbnail: kind === 'image' ? url : undefined,
      };
      setItems(prev => [item, ...prev]);
      return item;
    },
    []
  );

  const generateImages = useCallback(
    async (
      prompt: string,
      options?: VdzGenerateImageOptions
    ): Promise<void> => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      // CDZIMAGE: every Vdz generation carries an explicit tier (2.0 default;
      // Vdz is the one surface where the 1.0 economy tier is offered). An
      // optional bin reference rides along as true-edit or inspiration input.
      const payload: Record<string, unknown> = {
        prompt: trimmed,
        model: options?.tier ?? 'cdzimage-2.0',
      };
      // Fast mode: server skips prompt-pro + drops quality one notch.
      if (options?.fast) payload.fast = true;
      if (options?.reference) {
        payload.image = await resolveReferenceForApi(options.reference.item);
        payload.mode = options.reference.mode;
      }
      const response = await fetch(cdzApiUrl('/api/v1/images/generations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await response
        .json()
        .catch(() => null)) as ImageGenResponse | null;
      if (!response.ok) {
        throw new Error(
          data?.error?.message ||
            data?.message ||
            `Image generation failed (${response.status})`
        );
      }
      const url = data?.data?.[0]?.url;
      if (typeof url !== 'string' || !url) {
        throw new Error('The model did not return an image. Try rephrasing.');
      }
      setItems(prev => [
        {
          id: `media-${nanoid(8)}`,
          kind: 'image',
          source: 'ai',
          name: trimmed.slice(0, 60),
          url,
          duration: 0,
          thumbnail: url,
        },
        ...prev,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Image generation failed');
    } finally {
      setBusy(false);
    }
    },
    []
  );

  const searchStock = useCallback(
    async (
      query: string,
      source: VdzStockSource = 'auto'
    ): Promise<VdzMediaItem[]> => {
      const trimmed = query.trim();
      setBusy(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (trimmed) params.set('query', trimmed);
        params.set('source', source);
        params.set('per_page', String(STOCK_LIMIT));
        const response = await fetch(
          cdzApiUrl(`/api/copilot/stock/search?${params.toString()}`)
        );
        const data = (await response
          .json()
          .catch(() => null)) as StockSearchResponse | null;
        if (!response.ok) {
          // The backend replies with a friendly JSON message (e.g. a keyed
          // source that isn't configured, or an upstream hiccup naming the
          // provider). Fall back to a generic hint — never a bare status.
          throw new Error(
            (typeof data?.message === 'string' && data.message) ||
              'Search unavailable — try another source.'
          );
        }
        const results = Array.isArray(data?.results) ? data.results : [];
        // These are search RESULTS, not bin items yet — the grid adds on click.
        return results.slice(0, STOCK_LIMIT).flatMap(r => {
          // Flat normalized field first; `urls.regular` is the legacy alias.
          const regular = r.url || r.urls?.regular;
          if (typeof regular !== 'string' || !regular) return [];
          const thumb = r.thumb || r.urls?.small || r.urls?.thumb || regular;
          return [
            {
              id: `stock-${nanoid(8)}`,
              kind: 'image' as const,
              source: 'stock' as const,
              name:
                (r.description || '').slice(0, 60) || trimmed || 'Stock photo',
              url: regular,
              duration: 0,
              thumbnail: thumb,
              credit: r.author || undefined,
              creditUrl: r.link || undefined,
              provider: r.source || data?.source || undefined,
            },
          ];
        });
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Search unavailable — try another source.'
        );
        return [];
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const remove = useCallback((id: string) => {
    setItems(prev => {
      const target = prev.find(item => item.id === id);
      if (target && ownedUrlsRef.current.has(target.url)) {
        URL.revokeObjectURL(target.url);
        ownedUrlsRef.current.delete(target.url);
      }
      return prev.filter(item => item.id !== id);
    });
  }, []);

  return useMemo(
    () => ({
      items,
      error,
      busy,
      importFiles,
      generateImages,
      searchStock,
      addRemote,
      remove,
      clearError,
    }),
    [
      items,
      error,
      busy,
      importFiles,
      generateImages,
      searchStock,
      addRemote,
      remove,
      clearError,
    ]
  );
}
