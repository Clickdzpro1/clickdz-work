import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useState } from 'react';

import type {
  VdzAudioClip,
  VdzOp,
  VdzTimeline,
} from '../../../../modules/vdz';
import { useBlobUrl } from '../../../../modules/vdz/use-vdz-media';
import {
  captionOpsForSegments,
  type VdzTranscriptSegment,
} from './captions';

/**
 * Captions hook: transcribe ONE audio clip and build the caption-clip ops.
 *
 * Flow: resolve the clip's durable src to a live URL (same `useBlobUrl` as
 * playback/waveforms) → fetch the bytes → POST them RAW
 * (application/octet-stream — the server routes this through its 100MB raw
 * parser; JSON+base64 would bloat 33% and hit the json body cap) to
 * `/api/v1/vdz/transcribe` → map the Whisper segments onto text clips via
 * {@link captionOpsForSegments}. The caller commits the returned ops through
 * `runBatch` (single undo entry).
 *
 * URLs go through `cdzApiUrl(...)` so desktop builds resolve against the
 * connected server — the same rule every vdz fetch follows.
 */

const TRANSCRIBE_URL = '/api/v1/vdz/transcribe';

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

export interface UseVdzCaptions {
  /** true while transcription is in flight. */
  busy: boolean;
  /** Last error message, or null (cleared when a new run starts). */
  error: string | null;
  /** false while the clip's blob src is still resolving. */
  ready: boolean;
  /**
   * Transcribe the clip and return the caption ops (throws on failure with
   * `error` also set). `count` is the number of caption clips produced.
   */
  generate: () => Promise<{ ops: VdzOp[]; count: number }>;
}

export function useVdzCaptions(
  clip: VdzAudioClip,
  timeline: VdzTimeline
): UseVdzCaptions {
  const resolvedSrc = useBlobUrl(clip.src);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async (): Promise<{
    ops: VdzOp[];
    count: number;
  }> => {
    setBusy(true);
    setError(null);
    try {
      if (!resolvedSrc) {
        throw new Error('Audio is still loading — try again in a moment.');
      }
      // Read the audio bytes from the resolved (object/https) URL.
      let audioRes: Response;
      try {
        audioRes = await fetch(resolvedSrc);
      } catch {
        throw new Error('Could not read the audio data for this clip.');
      }
      if (!audioRes.ok) {
        throw new Error('Could not read the audio data for this clip.');
      }
      const bytes = await audioRes.arrayBuffer();
      if (bytes.byteLength === 0) {
        throw new Error('This clip has no audio data.');
      }
      const mimeType =
        audioRes.headers.get('content-type')?.split(';')[0].trim() ||
        'audio/mpeg';

      const query = new URLSearchParams({
        mime: mimeType,
        name: clip.name ?? 'audio',
      });
      let res: Response;
      try {
        res = await fetch(cdzApiUrl(`${TRANSCRIBE_URL}?${query}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
      } catch (cause) {
        throw new Error(
          cause instanceof Error && cause.message
            ? `Network error: ${cause.message}`
            : 'Network error while contacting transcription.'
        );
      }
      if (!res.ok) {
        throw new Error(await readError(res));
      }
      const data = (await res.json()) as {
        segments?: VdzTranscriptSegment[];
      };
      const segments = Array.isArray(data?.segments) ? data.segments : [];
      if (segments.length === 0) {
        throw new Error('No speech was found in this audio.');
      }
      const built = captionOpsForSegments(timeline, segments, clip.start);
      if (built.ops.length === 0) {
        throw new Error('No usable caption segments were produced.');
      }
      return built;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Caption generation failed.');
      throw e;
    } finally {
      setBusy(false);
    }
  }, [resolvedSrc, clip.start, clip.name, timeline]);

  return { busy, error, ready: Boolean(resolvedSrc), generate };
}
