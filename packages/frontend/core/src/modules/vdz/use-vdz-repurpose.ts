import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { useCallback, useState } from 'react';

import type { VdzClip, VdzTimeline, VdzTrack } from './schema';
import { computeTimelineDuration } from './schema';

/**
 * Vdz Studio — AI long→short repurposing hook (C6, consumes VDZ-BE C2 + C1).
 *
 * Two pure-ish network operations, both routed through `cdzApiUrl(...)` +
 * `credentials: 'include'` (the exact idiom useVdzProjects / useVdzCaptions
 * follow, so desktop/native builds resolve against the connected server and the
 * session cookie rides along on web):
 *
 *   · analyze(timeline)  — gather the project's transcript from the transcript
 *     side-store (GET /api/v1/vdz/transcript?src=… for each distinct video/audio
 *     clip src), rebase every word from MEDIA-time onto TIMELINE seconds (apply
 *     each clip's window + head trim), plus the total duration, then POST it to
 *     /api/v1/vdz/repurpose → a ranked list of short-clip suggestions.
 *   · createShort(timeline, short) — clone the timeline windowed to
 *     [startSec, endSec] (shift clips to a 0 origin, trim boundary clips into the
 *     window, drop out-of-window clips + orphaned transitions), switch the canvas
 *     to a 9:16 1080×1920 short, and POST it as a brand-new saved project
 *     (POST /api/v1/vdz/projects {name, timeline}). Returns the created id + the
 *     cloned timeline so the caller can open it.
 *
 * DEGRADE WITHOUT A TRANSCRIPT: analyze still works on timing alone — it POSTs
 * an empty transcript and the planner falls back to duration-only pacing (fewer,
 * looser windows). `hadTranscript` on the result lets the UI surface a
 * "transcribe first for sharper picks" hint.
 *
 * FROZEN surfaces (schema.ts / ops.ts) are untouched: the windowing + 9:16 swap
 * operate on a deep CLONE of the timeline object (we set width/height directly on
 * the clone), never through an op, so nothing here depends on a specific op set.
 */

const REPURPOSE_URL = '/api/v1/vdz/repurpose';
const TRANSCRIPT_URL = '/api/v1/vdz/transcript';
const PROJECTS_URL = '/api/v1/vdz/projects';

/** Portrait short canvas — 9:16 at 1080×1920 (within the schema's 320..4096). */
export const SHORT_WIDTH = 1080;
export const SHORT_HEIGHT = 1920;

/** Default number of suggestions to request (server clamps to 3..12). */
const DEFAULT_SHORT_COUNT = 6;

/** Defensive cap on words shipped to the planner (mirrors the C1 word cap). */
const MAX_WORDS = 5000;

/**
 * One ranked short suggestion, exactly as VDZ-BE's /repurpose returns it
 * (C2 pinned shape): a [startSec, endSec] window in TIMELINE seconds plus the
 * planner's title / hook / 0..1 score.
 */
export interface VdzShort {
  startSec: number;
  endSec: number;
  title: string;
  hook: string;
  score: number;
}

/** One transcript word in MEDIA-time seconds (the C1 side-store value shape). */
interface TranscriptWord {
  w: string;
  t0: number;
  t1: number;
}

/** One transcript word in TIMELINE seconds (what the planner scores against). */
interface TimelineWord {
  w: string;
  t0: number;
  t1: number;
}

export interface VdzAnalyzeResult {
  shorts: VdzShort[];
  /** Total project duration (seconds) that was analyzed. */
  durationSec: number;
  /** false when NO clip had a cached transcript — picks are timing-only. */
  hadTranscript: boolean;
}

/** Pull a message out of an AFFiNE typed-error body (compose/projects pattern). */
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
 * Every distinct src that carries speech — video + audio clips (image/text/shape
 * have no media to transcribe). Returned WITH the per-clip window so the caller
 * can rebase that source's words onto the timeline for each placement (the same
 * source can appear in several clips after splits/trims — C1 keys by src so both
 * halves share one cached transcript, sliced by their window).
 */
interface MediaPlacement {
  src: string;
  /** Timeline start of this clip (seconds). */
  start: number;
  /** Timeline duration of this clip (seconds). */
  duration: number;
  /** Seconds trimmed from the media head (video only; 0 otherwise). */
  trimStart: number;
}

function collectMediaPlacements(timeline: VdzTimeline): MediaPlacement[] {
  const out: MediaPlacement[] = [];
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (
        (clip.type === 'video' || clip.type === 'audio') &&
        typeof clip.src === 'string' &&
        clip.src.length > 0
      ) {
        out.push({
          src: clip.src,
          start: clip.start,
          duration: clip.duration,
          // Only video carries a source in-point in the schema; audio replays
          // from its head (documented caveat — its words map from media 0).
          trimStart: clip.type === 'video' ? clip.trimStart ?? 0 : 0,
        });
      }
    }
  }
  return out;
}

/**
 * Rebase one clip's cached (media-time) words onto TIMELINE seconds for a single
 * placement. A word at media time `t` sits at `clip.start + (t - trimStart)`; we
 * keep only words whose media time falls inside the clip's visible window
 * `[trimStart, trimStart + duration]` (the split-safe slice C1 describes).
 */
function rebaseWords(
  words: readonly TranscriptWord[],
  placement: MediaPlacement
): TimelineWord[] {
  const winStart = placement.trimStart;
  const winEnd = placement.trimStart + placement.duration;
  const out: TimelineWord[] = [];
  for (const word of words) {
    // Clamp the word span to the visible media window, then shift onto the
    // timeline. A word entirely outside the window is dropped.
    const t0 = Math.max(word.t0, winStart);
    const t1 = Math.min(word.t1, winEnd);
    if (t1 <= winStart || t0 >= winEnd) continue;
    const base = placement.start - placement.trimStart;
    out.push({
      w: word.w,
      t0: Math.max(0, base + t0),
      t1: Math.max(0, base + t1),
    });
  }
  return out;
}

export interface UseVdzRepurpose {
  /** true while analyze() is in flight. */
  analyzing: boolean;
  /** true while createShort() is in flight. */
  creating: boolean;
  /** Last error message, or null (cleared when a new run starts). */
  error: string | null;
  /**
   * Gather the project's transcript (across clips, rebased to timeline seconds)
   * + duration and ask the planner for ranked short windows. Works even with no
   * transcript (timing-only — see `hadTranscript`). Throws on failure with
   * `error` also set.
   */
  analyze: (
    timeline: VdzTimeline,
    count?: number
  ) => Promise<VdzAnalyzeResult>;
  /**
   * Clone the timeline windowed to the short, switch it to 9:16, and save it as
   * a NEW project. Returns `{ id, timeline }` (the caller opens the returned
   * timeline). Throws on failure with `error` also set.
   */
  createShort: (
    timeline: VdzTimeline,
    short: VdzShort,
    projectName: string
  ) => Promise<{ id: string; timeline: VdzTimeline }>;
  /** Manually clear the current error. */
  clearError: () => void;
}

/**
 * Deep-clone one clip, trim it into the window `[startSec, endSec]` (timeline
 * seconds) and shift it so the window's start becomes t=0. Returns null when the
 * clip does not overlap the window at all (dropped). Boundary clips are trimmed:
 *   · a clip that starts before the window loses its head (and, for video, its
 *     media in-point advances so the picture stays in sync — mirrors splitClip);
 *   · a clip that ends after the window loses its tail;
 *   · a text clip's clip-relative karaoke `words` are rebased by the head cut and
 *     re-clamped to the trimmed window (words fully outside are dropped).
 */
function windowClip(
  clip: VdzClip,
  startSec: number,
  endSec: number
): VdzClip | null {
  const clipStart = clip.start;
  const clipEnd = clip.start + clip.duration;
  // Overlap of the clip with the requested window.
  const a = Math.max(clipStart, startSec);
  const b = Math.min(clipEnd, endSec);
  if (b <= a) return null; // no overlap → drop this clip entirely

  const headCut = a - clipStart; // seconds trimmed off the clip's head
  const next = JSON.parse(JSON.stringify(clip)) as VdzClip;
  next.start = a - startSec; // shift so the window origin is 0
  next.duration = b - a;

  // Video carries a source in-point: advance it by the head cut so the frame
  // under the playhead is unchanged (the exact rule splitClip uses).
  if (next.type === 'video' && headCut > 0) {
    next.trimStart = (next.trimStart ?? 0) + headCut;
  }

  // Text clips carry clip-relative karaoke words — rebase them by the head cut
  // and re-clamp to the trimmed duration so the highlight stays aligned.
  if (next.type === 'text' && Array.isArray(next.words) && headCut !== 0) {
    const dur = next.duration;
    next.words = next.words
      .map(word => ({
        w: word.w,
        t0: Math.max(0, word.t0 - headCut),
        t1: Math.max(0, word.t1 - headCut),
      }))
      .filter(word => word.t0 < dur && word.t1 > 0);
  }

  return next;
}

/**
 * Clone `timeline` windowed to the short and re-canvased to 9:16. Pure — does
 * not mutate the input. Tracks are preserved (even when a track ends up empty)
 * so the short keeps the same lane structure; each track's clips are windowed and
 * any transition whose `afterClipId` no longer survives is dropped.
 */
export function windowTimelineToShort(
  timeline: VdzTimeline,
  short: VdzShort,
  name: string
): VdzTimeline {
  // Clamp the window to the project bounds so a stale suggestion can never ask
  // for negative time or run past the media.
  const total = computeTimelineDuration(timeline);
  const startSec = Math.max(0, Math.min(short.startSec, total));
  const endSec = Math.max(startSec, Math.min(short.endSec, total));

  const tracks: VdzTrack[] = timeline.tracks.map(track => {
    const clips: VdzClip[] = [];
    for (const clip of track.clips) {
      const windowed = windowClip(clip, startSec, endSec);
      if (windowed) clips.push(windowed);
    }
    const survivingIds = new Set(clips.map(c => c.id));
    const transitions = track.transitions?.filter(tr =>
      survivingIds.has(tr.afterClipId)
    );
    return {
      ...track,
      clips,
      ...(transitions && transitions.length > 0
        ? { transitions }
        : track.transitions
          ? { transitions: [] }
          : {}),
    };
  });

  return {
    ...timeline,
    // Fresh identity for the derived project (the server re-mints the stored id;
    // this keeps the in-memory doc distinct from the source).
    id: `vdz-short-${Math.random().toString(36).slice(2, 10)}`,
    name,
    // 9:16 portrait — set directly on the CLONE (no ops.ts dependency). Within
    // the schema's 320..4096 integer canvas bounds.
    width: SHORT_WIDTH,
    height: SHORT_HEIGHT,
    tracks,
  };
}

export function useVdzRepurpose(): UseVdzRepurpose {
  const [analyzing, setAnalyzing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = useCallback(
    async (
      timeline: VdzTimeline,
      count: number = DEFAULT_SHORT_COUNT
    ): Promise<VdzAnalyzeResult> => {
      setAnalyzing(true);
      setError(null);
      try {
        const durationSec = computeTimelineDuration(timeline);
        if (durationSec <= 0) {
          throw new Error(
            'This project is empty — add some clips to the timeline first.'
          );
        }

        // Gather every distinct media src, then fetch each source's cached
        // transcript ONCE (dedupe by src) and rebase it onto the timeline for
        // every placement of that source.
        const placements = collectMediaPlacements(timeline);
        const distinctSrcs = Array.from(new Set(placements.map(p => p.src)));

        // One GET per distinct src. Failures (or "no transcript") degrade to an
        // empty word list for that source — analyze still runs on timing alone.
        const wordsBySrc = new Map<string, TranscriptWord[]>();
        await Promise.all(
          distinctSrcs.map(async src => {
            try {
              const res = await fetch(
                cdzApiUrl(
                  `${TRANSCRIPT_URL}?src=${encodeURIComponent(src)}`
                ),
                { credentials: 'include' }
              );
              if (!res.ok) {
                wordsBySrc.set(src, []);
                return;
              }
              const data = (await res.json()) as {
                words?: TranscriptWord[];
              };
              wordsBySrc.set(
                src,
                Array.isArray(data?.words) ? data.words : []
              );
            } catch {
              // A single source failing to load must not sink the whole
              // analysis — treat it as "no transcript for this source".
              wordsBySrc.set(src, []);
            }
          })
        );

        // Build the full timeline-time transcript: for each placement, rebase
        // that source's words onto the clip window, then sort by time.
        const timelineWords: TimelineWord[] = [];
        for (const placement of placements) {
          const words = wordsBySrc.get(placement.src);
          if (!words || words.length === 0) continue;
          for (const w of rebaseWords(words, placement)) {
            timelineWords.push(w);
          }
        }
        timelineWords.sort((x, y) => x.t0 - y.t0);
        const hadTranscript = timelineWords.length > 0;
        // Defensive cap before shipping to the planner (token budget guard; the
        // server also truncates, but keep the request small).
        const transcript = timelineWords.slice(0, MAX_WORDS);

        let res: Response;
        try {
          res = await fetch(cdzApiUrl(REPURPOSE_URL), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcript, durationSec, count }),
          });
        } catch (cause) {
          throw new Error(
            cause instanceof Error && cause.message
              ? `Network error: ${cause.message}`
              : 'Network error while contacting the repurpose planner.'
          );
        }
        if (!res.ok) {
          throw new Error(await readError(res));
        }
        const data = (await res.json()) as { shorts?: VdzShort[] };
        const shorts = Array.isArray(data?.shorts)
          ? data.shorts.filter(
              s =>
                s &&
                Number.isFinite(s.startSec) &&
                Number.isFinite(s.endSec) &&
                s.endSec > s.startSec
            )
          : [];
        if (shorts.length === 0) {
          throw new Error(
            'The planner did not return any usable short segments.'
          );
        }
        return { shorts, durationSec, hadTranscript };
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Analysis failed. Try again.'
        );
        throw e;
      } finally {
        setAnalyzing(false);
      }
    },
    []
  );

  const createShort = useCallback(
    async (
      timeline: VdzTimeline,
      short: VdzShort,
      projectName: string
    ): Promise<{ id: string; timeline: VdzTimeline }> => {
      setCreating(true);
      setError(null);
      try {
        const base = (projectName ?? '').trim() || 'Untitled';
        const shortTitle = (short.title ?? '').trim() || 'Short';
        const name = `${base} — ${shortTitle}`;
        const shortTimeline = windowTimelineToShort(timeline, short, name);
        if (shortTimeline.tracks.every(t => t.clips.length === 0)) {
          throw new Error(
            'That range has no clips to turn into a short.'
          );
        }

        let res: Response;
        try {
          res = await fetch(cdzApiUrl(PROJECTS_URL), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            // Omit id → the server mints a fresh vdz-… id for the new short.
            body: JSON.stringify({ name, timeline: shortTimeline }),
          });
        } catch (cause) {
          throw new Error(
            cause instanceof Error && cause.message
              ? `Network error: ${cause.message}`
              : 'Network error while saving the short.'
          );
        }
        if (!res.ok) {
          throw new Error(await readError(res));
        }
        const doc = (await res.json()) as { id?: string };
        if (!doc?.id) {
          throw new Error('The short was saved but no id came back.');
        }
        // Return the saved id + the (client-side) timeline so the caller can
        // open it immediately without a round-trip.
        return { id: doc.id, timeline: shortTimeline };
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Could not create the short.'
        );
        throw e;
      } finally {
        setCreating(false);
      }
    },
    []
  );

  const clearError = useCallback(() => setError(null), []);

  return { analyzing, creating, error, analyze, createShort, clearError };
}
