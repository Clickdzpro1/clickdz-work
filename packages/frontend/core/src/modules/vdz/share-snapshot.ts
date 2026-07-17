import type { VdzTimeline } from './schema';

/**
 * Share snapshots — pure helpers.
 *
 * A public share is a SELF-CONTAINED copy of the timeline: every clip src the
 * owner's workspace can resolve is inlined as a `data:` URI (the same
 * resolution the MP4 export uses), because `vdz-blob:` handles only exist
 * inside the owner's workspace and are meaningless to a signed-out viewer.
 * The share is therefore a snapshot AT SHARE TIME — later edits don't leak;
 * re-sharing updates the link in place.
 */

export interface ApplySrcResolutionResult {
  timeline: VdzTimeline;
  /** How many clip srcs were swapped for data: URIs. */
  replaced: number;
  /** Srcs that stayed unresolved (dead blob / CORS / over budget). */
  unresolved: string[];
}

/**
 * Deep-copy `timeline`, replacing every resolvable clip `src` via the
 * `resolveSrc` map (from `resolveTimelineMedia`). Already-inline `data:` srcs
 * pass through; unresolved srcs are left as-is and reported so the UI can
 * warn (those clips render as placeholders/silence for viewers). Pure.
 */
export function applySrcResolution(
  timeline: VdzTimeline,
  resolveSrc: Record<string, string>
): ApplySrcResolutionResult {
  const clone = JSON.parse(JSON.stringify(timeline)) as VdzTimeline;
  let replaced = 0;
  const unresolved: string[] = [];
  for (const track of clone.tracks) {
    for (const clip of track.clips) {
      const c = clip as { src?: unknown };
      if (
        typeof c.src === 'string' &&
        c.src.length > 0 &&
        !c.src.startsWith('data:')
      ) {
        const hit = resolveSrc[c.src];
        if (hit) {
          c.src = hit;
          replaced += 1;
        } else {
          unresolved.push(c.src);
        }
      }
    }
  }
  return { timeline: clone, replaced, unresolved };
}
