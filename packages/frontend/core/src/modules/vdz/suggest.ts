import { computeTimelineDuration, type VdzTimeline } from './schema';

/**
 * Vdz Studio — proactive edit suggestions.
 *
 * A PURE, client-side analyzer that reads the current {@link VdzTimeline} and
 * derives a handful of concrete, actionable suggestions the dock renders as
 * clickable chips. Clicking a chip sends its `message` through the same chat
 * pipeline a typed request uses, so the AI turns it into reviewable ops.
 *
 * Design notes:
 *  • This never calls the network and never mutates the timeline — it only
 *    inspects it. That keeps suggestions instant, deterministic and testable.
 *  • Each rule fires only when it is actually RELEVANT to the current project
 *    (an empty overlay track → "add a title"; a silent audio track → "add a
 *    voiceover"; adjacent clips with no transition → "add a fade"), so the
 *    chips read as real observations, not generic advice.
 *  • Rules are ordered by usefulness and the list is capped, so the dock always
 *    shows the few highest-signal ideas rather than an overwhelming wall.
 *
 * The analyzer is intentionally lenient about the timeline shape: it reads
 * through optional fields and never assumes a track/clip exists.
 */

/** One suggestion: a short chip `label` and the `message` sent when clicked. */
export interface VdzSuggestion {
  /** Stable key for React lists + de-duping. */
  id: string;
  /** Short chip text shown to the user (imperative, e.g. "Add a title"). */
  label: string;
  /** The chat message sent verbatim when the chip is clicked. */
  message: string;
}

/** Max chips we surface at once — keep the idle state focused. */
const MAX_SUGGESTIONS = 4;

/** Below this many seconds a project reads as "too short / abrupt". */
const SHORT_TIMELINE_SECONDS = 5;

/** A gap larger than this between two clips reads as dead air worth closing. */
const DEAD_GAP_SECONDS = 0.75;

/** Narrow helper: does a track have at least one clip? */
function hasClips(track: { clips?: unknown[] } | undefined): boolean {
  return Array.isArray(track?.clips) && track.clips.length > 0;
}

/**
 * Derive up to {@link MAX_SUGGESTIONS} concrete suggestions from a timeline.
 *
 * Returns [] when nothing notable stands out (a well-formed project), so the
 * caller can simply hide the chip row. Pure and synchronous.
 */
export function suggestEdits(timeline: VdzTimeline): VdzSuggestion[] {
  const out: VdzSuggestion[] = [];
  const push = (s: VdzSuggestion) => {
    if (out.length < MAX_SUGGESTIONS && !out.some(o => o.id === s.id)) {
      out.push(s);
    }
  };

  const tracks = Array.isArray(timeline?.tracks) ? timeline.tracks : [];
  const videoTracks = tracks.filter(t => t?.kind === 'video');
  const overlayTracks = tracks.filter(t => t?.kind === 'overlay');
  const audioTracks = tracks.filter(t => t?.kind === 'audio');

  const duration = computeTimelineDuration(timeline);
  const isEmpty = tracks.every(t => !hasClips(t));

  // 1) Completely empty project → offer a full build (highest signal).
  if (isEmpty) {
    push({
      id: 'build-intro',
      label: 'Generate a starter scene',
      message:
        'Build a 10-second intro: a colored background scene with a bold ' +
        'centered title and a subtitle underneath.',
    });
  }

  // 2) An overlay track exists but carries no text/graphics → suggest a title.
  //    (Only when there IS something on video to title over.)
  const hasVisual = videoTracks.some(hasClips);
  const overlayEmpty =
    overlayTracks.length > 0 && overlayTracks.every(t => !hasClips(t));
  const overlayHasText = overlayTracks.some(t =>
    (t.clips ?? []).some(c => c.type === 'text')
  );
  if (!isEmpty && hasVisual && (overlayEmpty || !overlayHasText)) {
    push({
      id: 'add-title',
      label: 'Add a title — your overlay is empty',
      message: 'Add a bold title card at the start over the first clip.',
    });
  }

  // 3) An audio track exists but is silent → suggest a voiceover/music.
  const audioSilent =
    audioTracks.length > 0 && audioTracks.every(t => !hasClips(t));
  if (!isEmpty && audioSilent) {
    push({
      id: 'add-audio',
      label: 'Your audio track is silent — add a voiceover',
      message:
        'Add a placeholder voiceover clip spanning the whole timeline so I ' +
        'can drop narration in.',
    });
  }

  // 4) Adjacent clips on a visual track with no transition between them →
  //    suggest a fade on the first such boundary we find.
  for (const track of videoTracks) {
    const clips = [...(track.clips ?? [])].sort((a, b) => a.start - b.start);
    if (clips.length < 2) continue;
    const transitions = track.transitions ?? [];
    for (let i = 0; i < clips.length - 1; i++) {
      const a = clips[i];
      const b = clips[i + 1];
      const gap = b.start - (a.start + a.duration);
      const abut = Math.abs(gap) <= 0.05; // effectively touching
      const hasTransition = transitions.some(tr => tr.afterClipId === a.id);
      if (abut && !hasTransition) {
        push({
          id: 'add-fade',
          label: 'Add a fade between two clips',
          message:
            `Add a half-second fade transition between the clip "${a.id}" ` +
            `and the one after it.`,
        });
        break;
      }
    }
    if (out.some(o => o.id === 'add-fade')) break;
  }

  // 5) A visible gap (dead air) between two clips on a visual track → offer to
  //    close it (ripple). Distinct from #4 (which needs abutting clips).
  for (const track of videoTracks) {
    const clips = [...(track.clips ?? [])].sort((a, b) => a.start - b.start);
    for (let i = 0; i < clips.length - 1; i++) {
      const a = clips[i];
      const b = clips[i + 1];
      const gap = b.start - (a.start + a.duration);
      if (gap > DEAD_GAP_SECONDS) {
        push({
          id: 'close-gap',
          label: 'Close a gap in the timeline',
          message:
            `There's a ${gap.toFixed(1)}s gap before clip "${b.id}" — pull ` +
            `it and everything after it up to remove the dead air.`,
        });
        break;
      }
    }
    if (out.some(o => o.id === 'close-gap')) break;
  }

  // 6) Very short (but non-empty) project → suggest an outro to round it off.
  if (!isEmpty && duration > 0 && duration < SHORT_TIMELINE_SECONDS) {
    push({
      id: 'add-outro',
      label: 'Timeline ends abruptly — add an outro',
      message:
        'The video ends abruptly. Add a short outro card at the end with a ' +
        'call to action.',
    });
  }

  // 7) Non-empty but nothing more specific fired → a safe polish default so the
  //    row is never awkwardly empty on a valid project.
  if (!isEmpty && out.length === 0) {
    push({
      id: 'add-motion',
      label: 'Add entrance animations to your clips',
      message: 'Give the overlay clips a subtle fade or slide-in on entrance.',
    });
  }

  return out;
}
