import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useEffect, useRef, useState } from 'react';

import { applyOp, type VdzOp } from './ops';
import type { VdzClip, VdzTimeline } from './schema';
import { useBlobUrl } from './use-vdz-media';

/**
 * Vdz Studio — clip-transcript hook (transcript-as-timeline editing).
 *
 * Descript-style editing for a VIDEO or AUDIO clip: transcribe the clip's media
 * once, cache the words in the project-scoped side-store (keyed by the clip's
 * durable `src`, so both halves of a split share it), then let the user delete a
 * sentence — which CUTS the underlying clip using EXISTING timeline ops only.
 *
 * Nothing here touches the frozen schema/ops. The transcript lives OUTSIDE the
 * timeline (the C1 side-store); the cut is a `splitClip → splitClip → rippleDelete`
 * batch run through the host's ONE history path (`runBatch`) so it is a single
 * undo. This is deliberately separate from the caption flow (`use-vdz-captions`,
 * which lands transcript text as overlay *text clips*) — that keeps working
 * untouched; this hook operates on the SOURCE media clip.
 *
 * Every network call goes through `cdzApiUrl(...)` + `credentials: 'include'`,
 * the same rule every vdz fetch follows (desktop resolves against the connected
 * server; web is same-origin).
 */

const TRANSCRIBE_URL = '/api/v1/vdz/transcribe';
const TRANSCRIPT_URL = '/api/v1/vdz/transcript';

/** Hard cap on cached words (mirrors the side-store's defensive cap). */
const MAX_WORDS = 5000;

/**
 * One transcript word in MEDIA-TIME seconds (relative to the source media head),
 * exactly as the transcribe route + the C1 side-store speak. `w` is the word
 * text; `t0`/`t1` are its start/end in the source media.
 */
export interface VdzClipWord {
  w: string;
  t0: number;
  t1: number;
}

/** A media-time span to cut out of a clip (from a sentence/word selection). */
export interface VdzMediaRange {
  t0: number;
  t1: number;
}

/** Clip types that carry a transcribable media `src`. Text/shape are excluded. */
export type VdzTranscribableClip = Extract<
  VdzClip,
  { type: 'video' } | { type: 'audio' }
>;

/** True iff this clip is a video/audio clip we can transcribe + cut. */
export function isTranscribableClip(
  clip: VdzClip | null | undefined
): clip is VdzTranscribableClip {
  return !!clip && (clip.type === 'video' || clip.type === 'audio');
}

/** Round to ms so the ops we emit stay compact + stable (matches captions.ts). */
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The clip's media in-point (video carries `trimStart`; audio has none → 0). */
function clipTrimStart(clip: VdzTranscribableClip): number {
  return clip.type === 'video' ? (clip.trimStart ?? 0) : 0;
}

/** Pull a message out of an AFFiNE typed-error body (captions-hook pattern). */
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

/**
 * Flatten the transcribe route's `segments[{start,end,text,words?}]` into one
 * ordered `words[{w,t0,t1}]` array in MEDIA-TIME seconds. The route already
 * distributes each aligned word onto exactly one segment (by midpoint), so a
 * simple in-order concat is correct; words are cleaned, finite-checked, sorted
 * by start and capped defensively. Returns `[]` when nothing usable is present.
 */
export function wordsFromSegments(
  segments:
    | Array<{ start?: number; end?: number; text?: string; words?: unknown }>
    | undefined
): VdzClipWord[] {
  if (!Array.isArray(segments)) return [];
  const out: VdzClipWord[] = [];
  for (const seg of segments) {
    const segWords = Array.isArray((seg as { words?: unknown })?.words)
      ? ((seg as { words?: unknown }).words as unknown[])
      : [];
    for (const raw of segWords) {
      if (out.length >= MAX_WORDS) break;
      const r = (raw ?? {}) as Record<string, unknown>;
      const w = typeof r.w === 'string' ? r.w.trim() : '';
      if (!w) continue;
      const t0 = Number(r.t0);
      const t1 = Number(r.t1);
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
      out.push({ w, t0: round3(Math.max(0, t0)), t1: round3(Math.max(0, t1)) });
    }
    if (out.length >= MAX_WORDS) break;
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

/**
 * Build the EXISTING-ops recipe that deletes media-time `[t0,t1]` out of a
 * VIDEO/AUDIO clip, cutting the clip and closing the gap. Pure: derives ops from
 * the timeline but never mutates it, so it is unit-testable and the caller runs
 * the result through the ONE history path (`runBatch`) as a single undo.
 *
 * Mapping + clamping:
 *  - The clip shows media `[trimStart, trimStart + duration)` over timeline
 *    window `[start, start + duration)`. A media time `t` maps to timeline
 *    `start + (t - trimStart)`.
 *  - The requested span is clamped to the clip's media window, then to a hair
 *    inside the timeline window (a split must land STRICTLY inside the clip).
 *
 * Recipe (all in ONE runBatch — single undo, all-or-nothing):
 *  1. `splitClip` at `a`            → head `[start,a)`, TAIL `[a,end)`
 *  2. `splitClip` the TAIL at `b`   → MIDDLE `[a,b)`, rest `[b,end)`
 *  3. `rippleDelete` the MIDDLE     → remove `[a,b)` + pull the rest left by (b-a)
 *
 * The TAIL and MIDDLE clips are identified from the INTERMEDIATE timelines by
 * their window START (which equals the split's `atSeconds` exactly — `splitClip`
 * sets `second.start = atSeconds`), never by guessing the `-b` string id: split's
 * id derivation has a nanoid fallback on clash, so window identification is the
 * only robust way. Edge cases collapse the recipe: a span anchored at the clip
 * head or tail needs a single split (the head/tail piece IS the middle), and a
 * whole-clip span is a bare `rippleDelete`. Returns a human `error` (and no ops)
 * when the span is empty, degenerate, or maps outside the clip.
 */
export function buildCutSentenceOps(
  timeline: VdzTimeline,
  trackId: string,
  clip: VdzTranscribableClip,
  range: VdzMediaRange
): { ops: VdzOp[]; error?: string } {
  const track = timeline.tracks.find(t => t.id === trackId);
  if (!track || !track.clips.some(c => c.id === clip.id)) {
    return { ops: [], error: 'This clip is no longer on the timeline.' };
  }

  const trimStart = clipTrimStart(clip);
  const winStartMedia = trimStart;
  const winEndMedia = trimStart + clip.duration;

  // Clamp the requested media span into the clip's media window.
  const mt0 = Math.max(winStartMedia, Math.min(range.t0, range.t1));
  const mt1 = Math.min(winEndMedia, Math.max(range.t0, range.t1));
  if (!(mt1 > mt0)) {
    return { ops: [], error: 'That selection is empty within this clip.' };
  }

  // Media → timeline. `a`/`b` are absolute timeline seconds inside the clip.
  const clipStart = clip.start;
  const clipEnd = clip.start + clip.duration;
  const a = round3(clipStart + (mt0 - trimStart));
  const b = round3(clipStart + (mt1 - trimStart));
  if (!(b > a)) {
    return { ops: [], error: 'That selection is too short to cut.' };
  }

  // A split must land STRICTLY inside the clip (touching an edge errors), so an
  // edge-anchored delete drops the corresponding split. EPS absorbs ms rounding.
  const EPS = 0.0015;
  const atStart = a <= clipStart + EPS;
  const atEnd = b >= clipEnd - EPS;

  // Whole clip → nothing to split; ripple the clip out (closes the gap).
  if (atStart && atEnd) {
    return { ops: [{ op: 'rippleDelete', trackId, clipId: clip.id }] };
  }

  const ops: VdzOp[] = [];
  let cur = timeline;

  // The clip whose FRONT we will ripple away. As splits run, its id is re-read
  // from the intermediate timeline by window-start (never string-guessed).
  let middleClipId = clip.id;

  // --- Step 1: split at `a` — unless the delete is anchored at the clip head. ---
  if (!atStart) {
    const splitA: VdzOp = { op: 'splitClip', trackId, clipId: clip.id, atSeconds: a };
    const res = applyOp(cur, splitA);
    if (res.error) return { ops: [], error: res.error };
    cur = res.timeline;
    ops.push(splitA);
    // The TAIL piece starts exactly at the split point `a`.
    const tail = firstClipStartingAt(cur, trackId, a, EPS);
    if (!tail) return { ops: [], error: 'Could not locate the clip section to cut.' };
    middleClipId = tail.id;
  }

  // --- Step 2: split the tail at `b` — unless the delete runs to the clip end. ---
  if (!atEnd) {
    const splitB: VdzOp = {
      op: 'splitClip',
      trackId,
      clipId: middleClipId,
      atSeconds: b,
    };
    const res = applyOp(cur, splitB);
    if (res.error) return { ops: [], error: res.error };
    cur = res.timeline;
    ops.push(splitB);
    // `splitClip` keeps the FIRST portion's id/start and inserts the new tail at
    // `b`; the MIDDLE `[a,b)` is therefore the piece that still starts at the
    // head of the section we split — `a` in the interior case, or the clip head
    // when the delete was head-anchored (no first split ran).
    const middleStart = atStart ? clipStart : a;
    const middle = firstClipStartingAt(cur, trackId, middleStart, EPS);
    if (!middle) return { ops: [], error: 'Could not locate the clip section to cut.' };
    middleClipId = middle.id;
  }

  // --- Step 3: ripple-delete the middle (removes it + closes the gap). ---
  ops.push({ op: 'rippleDelete', trackId, clipId: middleClipId });

  return { ops };
}

/** The first clip on `trackId` whose start ≈ `at` (window-based id lookup). */
function firstClipStartingAt(
  timeline: VdzTimeline,
  trackId: string,
  at: number,
  eps: number
): { id: string } | undefined {
  const track = timeline.tracks.find(t => t.id === trackId);
  if (!track) return undefined;
  return track.clips.find(c => Math.abs(c.start - at) < eps);
}

/** Locate the track holding a clip id (the panel resolves this for cutSentence). */
function findTrackIdForClip(
  timeline: VdzTimeline,
  clipId: string
): string | null {
  for (const track of timeline.tracks) {
    if (track.clips.some(c => c.id === clipId)) return track.id;
  }
  return null;
}

export interface UseVdzTranscript {
  /** true while a transcribe request is in flight. */
  busy: boolean;
  /** true while the initial cached-transcript load is in flight. */
  loading: boolean;
  /** Last error message, or null (cleared when a new action starts). */
  error: string | null;
  /** false while the clip's blob src is still resolving (transcribe blocked). */
  ready: boolean;
  /** The current transcript words (media-time seconds), or null if none yet. */
  words: VdzClipWord[] | null;
  /** Detected language (from the cache), when known. */
  language: string | null;
  /**
   * Transcribe the clip's media and cache the words. Fetches the clip bytes from
   * its resolved src, POSTs them RAW to the transcribe route, flattens the
   * segments to media-time words, caches them via the side-store, and updates
   * `words`. Throws on failure with `error` also set.
   */
  transcribe: () => Promise<VdzClipWord[]>;
  /** Re-read the cached transcript for the current clip from the side-store. */
  reload: () => Promise<void>;
  /**
   * Cut a media-time span out of the clip: maps [t0,t1] → the clip window,
   * clamps, and commits the `splitClip → splitClip → rippleDelete` recipe as a
   * SINGLE undo through the host's history path. Also reflows local `words` to
   * the survivors so the panel updates immediately (the timeline is the truth
   * for the cut itself; the side-store transcript is not rewritten server-side).
   * Returns true when the cut committed. VIDEO/AUDIO only.
   */
  cutSentence: (clip: VdzTranscribableClip, range: VdzMediaRange) => boolean;
  clearError: () => void;
}

/**
 * Load a transcript for an arbitrary src from the C1 side-store. Standalone
 * (not a hook) so callers outside a component (e.g. the repurpose flow) can read
 * the same cache. Returns `{ words: [] }` when none is stored or on any failure
 * (degrade gracefully — a missing transcript just means "Transcribe").
 */
export async function loadTranscript(
  src: string
): Promise<{ words: VdzClipWord[]; language?: string }> {
  const key = (src ?? '').trim();
  if (!key) return { words: [] };
  try {
    const res = await fetch(
      cdzApiUrl(`${TRANSCRIPT_URL}?src=${encodeURIComponent(key)}`),
      { credentials: 'include' }
    );
    if (!res.ok) return { words: [] };
    const data = (await res.json()) as {
      words?: unknown;
      language?: unknown;
    };
    const words = Array.isArray(data?.words)
      ? (data.words as unknown[]).flatMap(raw => {
          const r = (raw ?? {}) as Record<string, unknown>;
          const w = typeof r.w === 'string' ? r.w : '';
          const t0 = Number(r.t0);
          const t1 = Number(r.t1);
          if (!w || !Number.isFinite(t0) || !Number.isFinite(t1)) return [];
          return [{ w, t0, t1 }];
        })
      : [];
    const language =
      typeof data?.language === 'string' ? data.language : undefined;
    return language ? { words, language } : { words };
  } catch {
    return { words: [] };
  }
}

/**
 * Clip-transcript hook. `clip` is the currently-selected clip (or null); the
 * hook is inert for non-video/audio clips (so the panel can render its
 * text/caption mode untouched). `onOps` is the host's batch history commit
 * (`runBatch`) — the ONE path timeline mutations flow through; the cut is a
 * single undo. `timeline` is the live document (used to re-derive sub-clip ids
 * from windows and to locate the clip's track).
 */
export function useVdzTranscript(
  clip: VdzClip | null,
  timeline: VdzTimeline,
  onOps: (ops: VdzOp[]) => boolean
): UseVdzTranscript {
  const transcribable = isTranscribableClip(clip) ? clip : null;
  const src = transcribable?.src ?? '';
  // Resolve the durable `vdz-blob:` src to a live object URL exactly like
  // playback/waveforms/captions do — this is how we get the media BYTES.
  const resolvedSrc = useBlobUrl(src);

  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [words, setWords] = useState<VdzClipWord[] | null>(null);
  const [language, setLanguage] = useState<string | null>(null);

  // Guard async setState against unmount / a clip (src) change mid-flight.
  const srcRef = useRef(src);
  srcRef.current = src;

  const clearError = useCallback(() => setError(null), []);

  // Load the cached transcript whenever the selected clip's src changes. A
  // non-transcribable selection clears everything so the panel shows its
  // caption/text mode with no stale clip-transcript state.
  const reload = useCallback(async () => {
    const current = srcRef.current;
    if (!current) {
      setWords(null);
      setLanguage(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await loadTranscript(current);
      if (srcRef.current !== current) return; // selection moved on
      setWords(data.words.length > 0 ? data.words : null);
      setLanguage(data.language ?? null);
    } finally {
      if (srcRef.current === current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!src) {
      setWords(null);
      setLanguage(null);
      setError(null);
      return;
    }
    void reload();
  }, [src, reload]);

  const transcribe = useCallback(async (): Promise<VdzClipWord[]> => {
    setBusy(true);
    setError(null);
    const current = srcRef.current;
    try {
      if (!transcribable || !current) {
        throw new Error('Select a video or audio clip to transcribe.');
      }
      if (!resolvedSrc) {
        throw new Error('Media is still loading — try again in a moment.');
      }
      // Read the media bytes from the resolved (object/https) URL.
      let mediaRes: Response;
      try {
        mediaRes = await fetch(resolvedSrc);
      } catch {
        throw new Error('Could not read the media data for this clip.');
      }
      if (!mediaRes.ok) {
        throw new Error('Could not read the media data for this clip.');
      }
      const bytes = await mediaRes.arrayBuffer();
      if (bytes.byteLength === 0) {
        throw new Error('This clip has no media data.');
      }
      const mimeType =
        mediaRes.headers.get('content-type')?.split(';')[0].trim() ||
        (transcribable.type === 'video' ? 'video/mp4' : 'audio/mpeg');

      const query = new URLSearchParams({
        mime: mimeType,
        name: transcribable.name ?? transcribable.type,
      });
      // Whisper accepts mp4/mov (audio is auto-extracted) — video clips work by
      // posting their media bytes verbatim, same route the caption flow uses.
      let res: Response;
      try {
        res = await fetch(cdzApiUrl(`${TRANSCRIBE_URL}?${query}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          credentials: 'include',
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
        segments?: Array<{
          start?: number;
          end?: number;
          text?: string;
          words?: unknown;
        }>;
      };
      const flat = wordsFromSegments(data?.segments);
      if (flat.length === 0) {
        throw new Error('No speech was found in this clip.');
      }

      // Cache the media-time words in the side-store (best-effort — a cache
      // failure must not lose the just-computed transcript). Keyed by the
      // durable src so both halves of a future split share it.
      try {
        await fetch(cdzApiUrl(TRANSCRIPT_URL), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ src: current, words: flat }),
        });
      } catch {
        // ignore — the transcript is still usable this session.
      }

      if (srcRef.current === current) {
        setWords(flat);
      }
      return flat;
    } catch (e) {
      if (srcRef.current === current) {
        setError(e instanceof Error ? e.message : 'Transcription failed.');
      }
      throw e;
    } finally {
      if (srcRef.current === current) setBusy(false);
    }
  }, [transcribable, resolvedSrc]);

  const cutSentence = useCallback(
    (target: VdzTranscribableClip, range: VdzMediaRange): boolean => {
      setError(null);
      const trackId = findTrackIdForClip(timeline, target.id);
      if (!trackId) {
        setError('This clip is no longer on the timeline.');
        return false;
      }
      const { ops, error: buildError } = buildCutSentenceOps(
        timeline,
        trackId,
        target,
        range
      );
      if (buildError || ops.length === 0) {
        setError(buildError ?? 'Nothing to cut.');
        return false;
      }
      // Route through the host's ONE history path → single undo, all-or-nothing.
      const ok = onOps(ops);
      if (!ok) {
        setError('The cut could not be applied.');
        return false;
      }
      // Reflow local words to the survivors: drop words inside the removed
      // media span and pull later words left by its length (the timeline is the
      // source of truth for the cut; this keeps the panel in sync instantly).
      const trimStart = clipTrimStart(target);
      const winStart = trimStart;
      const winEnd = trimStart + target.duration;
      const cutT0 = Math.max(winStart, Math.min(range.t0, range.t1));
      const cutT1 = Math.min(winEnd, Math.max(range.t0, range.t1));
      const cutLen = cutT1 - cutT0;
      setWords(prev => {
        if (!prev) return prev;
        const next: VdzClipWord[] = [];
        for (const word of prev) {
          const mid = (word.t0 + word.t1) / 2;
          if (mid >= cutT0 && mid < cutT1) continue; // inside the cut → gone
          if (word.t0 >= cutT1) {
            next.push({
              w: word.w,
              t0: round3(word.t0 - cutLen),
              t1: round3(word.t1 - cutLen),
            });
          } else {
            next.push(word);
          }
        }
        return next;
      });
      return true;
    },
    [timeline, onOps]
  );

  return {
    busy,
    loading,
    error,
    ready: Boolean(resolvedSrc),
    words,
    language,
    transcribe,
    reload,
    cutSentence,
    clearError,
  };
}
