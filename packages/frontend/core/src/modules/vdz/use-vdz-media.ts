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
 *   · Stock — the EXISTING `GET /api/copilot/unsplash/photos?query=...` route
 *     (`{results:[{urls:{regular}}]}`), wrapped in {@link cdzApiUrl}. Again a
 *     remote https URL used directly.
 *
 * Every network call goes through `cdzApiUrl(...)` so desktop/native builds
 * resolve against the connected server (web is a no-op — same origin).
 */

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

/** The server envelope for the unsplash search route. */
interface UnsplashResponse {
  results?: Array<{ urls?: { regular?: string } }>;
}

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
  /** Generate AI images from a prompt and add them to the bin. */
  generateImages: (prompt: string) => Promise<void>;
  /** Search Unsplash and add the chosen photo to the bin on click. */
  searchStock: (query: string) => Promise<VdzMediaItem[]>;
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

/** Max Unsplash results we keep from a single search. */
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

  const generateImages = useCallback(async (prompt: string): Promise<void> => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(cdzApiUrl('/api/v1/images/generations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed }),
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
  }, []);

  const searchStock = useCallback(
    async (query: string): Promise<VdzMediaItem[]> => {
      const trimmed = query.trim();
      setBusy(true);
      setError(null);
      try {
        let url = '/api/copilot/unsplash/photos';
        if (trimmed) url += `?query=${encodeURIComponent(trimmed)}`;
        const response = await fetch(cdzApiUrl(url));
        const data = (await response
          .json()
          .catch(() => null)) as UnsplashResponse | null;
        if (!response.ok) {
          throw new Error(`Stock search failed (${response.status})`);
        }
        const results = Array.isArray(data?.results) ? data.results : [];
        // These are search RESULTS, not bin items yet — the grid adds on click.
        return results
          .map(r => r.urls?.regular)
          .filter((u): u is string => typeof u === 'string' && !!u)
          .slice(0, STOCK_LIMIT)
          .map(regular => ({
            id: `stock-${nanoid(8)}`,
            kind: 'image' as const,
            source: 'stock' as const,
            name: trimmed || 'Unsplash photo',
            url: regular,
            duration: 0,
            thumbnail: regular,
          }));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Stock search failed');
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
