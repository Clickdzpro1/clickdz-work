import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { useService } from '@toeverything/infra';
import { useCallback, useState } from 'react';

import type { VdzTimeline } from './schema';
import { applySrcResolution } from './share-snapshot';
import { resolveTimelineMedia } from './use-vdz-timeline-export';

/**
 * Public share links for Vdz projects.
 *
 * `share(projectId, timeline)` builds a SELF-CONTAINED snapshot — media
 * resolved to `data:` URIs via the same `resolveTimelineMedia` the MP4 export
 * uses (workspace `vdz-blob:` handles are meaningless to a signed-out
 * viewer) — and uploads it as RAW bytes (`application/octet-stream`, the
 * transcribe-route pattern: an inlined timeline routinely exceeds the express
 * json limit). The server keeps ONE share per project: re-sharing updates the
 * snapshot behind the same stable link.
 *
 * Sharing is a snapshot AT SHARE TIME. Later edits are NOT visible publicly
 * until the owner re-shares — that's a feature (nothing leaks), and the UI
 * says so.
 */

/** Pull a message out of an AFFiNE typed-error body (compose-hook pattern). */
async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as {
      message?: unknown;
      error?: { message?: unknown } | string;
    };
    const msg =
      (typeof data?.message === 'string' ? data.message : undefined) ??
      (typeof data?.error === 'object' && data.error !== null
        ? (data.error as { message?: unknown }).message
        : undefined) ??
      (typeof data?.error === 'string' ? data.error : undefined);
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch {
    // ignore — fall through to status text
  }
  return res.statusText || `Request failed (${res.status})`;
}

/** Make a share path absolute for display/copy (server origin on desktop). */
function absoluteShareUrl(path: string): string {
  const resolved = cdzApiUrl(path);
  if (/^https?:\/\//i.test(resolved)) return resolved;
  try {
    return new URL(resolved, window.location.origin).toString();
  } catch {
    return resolved;
  }
}

export interface VdzShareResult {
  shareId: string;
  /** Absolute, copyable public URL. */
  url: string;
  /** Srcs that could not be inlined (viewers see placeholders/silence). */
  skipped: string[];
}

export interface UseVdzShare {
  busy: boolean;
  error: string | null;
  /** Create/update the public share for a SAVED project. */
  share: (projectId: string, timeline: VdzTimeline) => Promise<VdzShareResult>;
  /** Revoke the project's public link (true when one existed). */
  revoke: (projectId: string) => Promise<boolean>;
  clearError: () => void;
}

export function useVdzShare(): UseVdzShare {
  const workspaceService = useService(WorkspaceService);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const share = useCallback(
    async (
      projectId: string,
      timeline: VdzTimeline
    ): Promise<VdzShareResult> => {
      setBusy(true);
      setError(null);
      try {
        // 1) Inline media (same resolver + budget as MP4 export).
        const blobSync = workspaceService.workspace.docCollection.blobSync;
        const { resolveSrc, skipped } = await resolveTimelineMedia(
          timeline,
          blobSync
        );
        const inlined = applySrcResolution(timeline, resolveSrc);

        // 2) Upload the snapshot as raw bytes.
        const snapshot = {
          name: timeline.name,
          timeline: inlined.timeline,
        };
        const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
        let res: Response;
        try {
          res = await fetch(
            cdzApiUrl(
              `/api/v1/vdz/projects/${encodeURIComponent(projectId)}/share`
            ),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: bytes,
            }
          );
        } catch (cause) {
          throw new Error(
            cause instanceof Error && cause.message
              ? `Network error: ${cause.message}`
              : 'Network error while creating the share link.'
          );
        }
        if (!res.ok) {
          throw new Error(await readError(res));
        }
        const data = (await res.json()) as {
          shareId?: unknown;
          path?: unknown;
        };
        const shareId = typeof data?.shareId === 'string' ? data.shareId : '';
        const path = typeof data?.path === 'string' ? data.path : '';
        if (!shareId || !path) {
          throw new Error('The server did not return a share link.');
        }
        return {
          shareId,
          url: absoluteShareUrl(path),
          skipped: [...inlined.unresolved, ...skipped],
        };
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Sharing failed.');
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [workspaceService]
  );

  const revoke = useCallback(async (projectId: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      let res: Response;
      try {
        res = await fetch(
          cdzApiUrl(
            `/api/v1/vdz/projects/${encodeURIComponent(projectId)}/share`
          ),
          { method: 'DELETE' }
        );
      } catch (cause) {
        throw new Error(
          cause instanceof Error && cause.message
            ? `Network error: ${cause.message}`
            : 'Network error while revoking the share link.'
        );
      }
      if (!res.ok) {
        throw new Error(await readError(res));
      }
      const data = (await res.json()) as { revoked?: unknown };
      return data?.revoked === true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revoking failed.');
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { busy, error, share, revoke, clearError };
}
