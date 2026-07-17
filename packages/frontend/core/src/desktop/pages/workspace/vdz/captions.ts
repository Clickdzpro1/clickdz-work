import { nanoid } from 'nanoid';

import type { VdzOp, VdzTimeline } from '../../../../modules/vdz';

/**
 * Captions — pure mapping from transcript segments to timeline ops.
 *
 * Captions are ORDINARY TEXT CLIPS on the overlay track (no schema change):
 * the preview, MP4 export, undo history, drag/trim and the AI dock all handle
 * them with zero new code. This module is React-free and node-tested; the
 * network half lives in use-vdz-captions.ts.
 */

/** One transcript segment, seconds relative to the AUDIO HEAD. */
export interface VdzTranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Lower-third caption look (canvas-fraction units, like every text clip).
 *
 * `capPreset`/`capPosition` are the caption-styling fields from the shared
 * schema ({@link ../../../../modules/vdz}); freshly generated captions default
 * to a boxed, lower-third look. Both are optional/additive on the text clip, so
 * projects authored before they existed still parse — and the Transcript
 * panel's "Caption style" bar restyles them later via `setClipStyle`.
 */
export const CAPTION_STYLE = {
  fontSize: 0.045,
  color: '#ffffff',
  x: 0.5,
  y: 0.88,
  align: 'center',
  capPreset: 'boxed',
  capPosition: 'lower',
} as const;

/** Captions shorter than this read as flicker; stretch them to be readable. */
const MIN_CAPTION_SECONDS = 0.5;
/** Whisper can emit paragraph-length segments; keep captions subtitle-sized. */
const MAX_CAPTION_CHARS = 160;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Build the op batch that lands one text clip per transcript segment on the
 * overlay track, offset by the source clip's timeline position.
 *
 * - Segments are cleaned (trimmed, empty/invalid dropped, sorted by start,
 *   over-long text hard-wrapped at a word boundary) BEFORE mapping.
 * - When the timeline has no overlay track, the batch is prefixed with ONE
 *   `addTrack` op creating a "Captions" overlay lane — appended at the end of
 *   `tracks`, which is TOP of the visual z-order, exactly where captions go.
 * - Callers run the whole array through `runBatch`/`applyOps`: one undo entry,
 *   all-or-nothing (a failing op takes the whole batch down cleanly).
 */
export function captionOpsForSegments(
  timeline: VdzTimeline,
  segments: VdzTranscriptSegment[],
  offsetSeconds: number
): { ops: VdzOp[]; count: number } {
  const cleaned = segments
    .map(seg => ({
      start: Number(seg.start) || 0,
      end: Number(seg.end) || 0,
      text: (seg.text ?? '').trim(),
    }))
    .filter(seg => seg.text.length > 0 && seg.end > seg.start)
    .sort((a, b) => a.start - b.start);
  if (cleaned.length === 0) return { ops: [], count: 0 };

  const ops: VdzOp[] = [];
  let trackId = timeline.tracks.find(t => t.kind === 'overlay')?.id;
  if (!trackId) {
    trackId = `track-overlay-${nanoid(4)}`;
    ops.push({
      op: 'addTrack',
      track: { id: trackId, kind: 'overlay', name: 'Captions', clips: [] },
    });
  }

  for (const seg of cleaned) {
    ops.push({
      op: 'addClip',
      trackId,
      clip: {
        id: `clip-cap-${nanoid(6)}`,
        type: 'text',
        name: 'Caption',
        start: round3(Math.max(0, offsetSeconds + seg.start)),
        duration: round3(
          Math.max(MIN_CAPTION_SECONDS, seg.end - seg.start)
        ),
        text: clampCaptionText(seg.text),
        ...CAPTION_STYLE,
      },
    });
  }
  return { ops, count: cleaned.length };
}

/** Hard-cap caption text at a word boundary (subtitles, not paragraphs). */
export function clampCaptionText(text: string): string {
  if (text.length <= MAX_CAPTION_CHARS) return text;
  const cut = text.slice(0, MAX_CAPTION_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// Transcript view (the Descript-style panel reads the timeline through this).
// ---------------------------------------------------------------------------

/** One transcript row: a text clip on an overlay lane, in timeline order. */
export interface VdzTranscriptLine {
  trackId: string;
  clipId: string;
  start: number;
  duration: number;
  text: string;
}

/**
 * Every text clip on every overlay lane, sorted by start (id as tiebreaker so
 * the order is stable). Captions and hand-made titles both appear — the
 * transcript is simply the timeline's spoken/written layer, and edits flow
 * back through ordinary ops (`setText`, `removeClip`, `moveClip`, …).
 */
export function collectTranscriptLines(
  timeline: VdzTimeline
): VdzTranscriptLine[] {
  const lines: VdzTranscriptLine[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== 'overlay') continue;
    for (const clip of track.clips) {
      if (clip.type !== 'text') continue;
      lines.push({
        trackId: track.id,
        clipId: clip.id,
        start: clip.start,
        duration: clip.duration,
        text: clip.text,
      });
    }
  }
  return lines.sort(
    (a, b) => a.start - b.start || a.clipId.localeCompare(b.clipId)
  );
}
