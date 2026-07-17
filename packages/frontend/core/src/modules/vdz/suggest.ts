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
 *    voiceover"; adjacent clips with no transition → "add a fade"; a landscape
 *    canvas on a clearly social project → "make it 9:16"), so the chips read as
 *    real observations, not generic advice.
 *  • Rules are ordered by usefulness (see PRIORITY) and the list is capped, so
 *    the dock always shows the few highest-signal ideas rather than an
 *    overwhelming wall.
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

/**
 * A timeline longer than this with NO text anywhere reads as "needs a title
 * card / lower-thirds" — long-form footage that has never been titled.
 */
const LONG_UNTITLED_SECONDS = 25;

/**
 * Aspect-ratio tolerance. width/height within this fraction of 16:9 (1.777…)
 * counts as "landscape 16:9" for the social-reformat suggestion.
 */
const RATIO_16_9 = 16 / 9;
const RATIO_TOLERANCE = 0.06;

/**
 * Words in a track/clip/text name that hint the project is meant for a
 * vertical social platform (Reels / TikTok / Shorts / Stories). Matched
 * case-insensitively as substrings, so "reel", "reels", "tiktok-cut", etc. all
 * hit. Deliberately narrow to avoid false positives on ordinary footage.
 */
const SOCIAL_HINT_WORDS = [
  'reel',
  'reels',
  'tiktok',
  'tik tok',
  'short',
  'shorts',
  'story',
  'stories',
  'vertical',
  '9:16',
];

/** Words that mark an audio clip as spoken narration (voiceover / dialogue). */
const VOICE_HINT_WORDS = [
  'voice',
  'voiceover',
  'voice-over',
  'vo',
  'narrat',
  'dialog',
  'speech',
];

/** Words that mark an audio clip as a music bed / soundtrack. */
const MUSIC_HINT_WORDS = ['music', 'song', 'track', 'soundtrack', 'score', 'bgm', 'beat'];

/** Narrow helper: does a track have at least one clip? */
function hasClips(track: { clips?: unknown[] } | undefined): boolean {
  return Array.isArray(track?.clips) && track.clips.length > 0;
}

/** Lower-cased text of a clip's name plus (for text clips) its rendered text. */
function clipText(clip: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof clip.name === 'string') parts.push(clip.name);
  if (typeof clip.text === 'string') parts.push(clip.text);
  return parts.join(' ').toLowerCase();
}

/** Does any of `words` appear as a substring of the lower-cased `haystack`? */
function matchesAny(haystack: string, words: readonly string[]): boolean {
  return words.some(w => haystack.includes(w));
}

/**
 * Derive up to {@link MAX_SUGGESTIONS} concrete suggestions from a timeline.
 *
 * Returns [] when nothing notable stands out (a well-formed project), so the
 * caller can simply hide the chip row. Pure and synchronous.
 *
 * Rules are evaluated into a candidate pool, then emitted in PRIORITY order and
 * capped — so the dock always shows the highest-signal ideas first. Existing
 * rules are preserved; context-aware rules (social reformat, transition on the
 * busiest boundary, ducking, caption styling, cinematic effects, title card for
 * long untitled footage) are added.
 */
export function suggestEdits(timeline: VdzTimeline): VdzSuggestion[] {
  // Collect candidates keyed by id (dedupe), then rank + cap at the end so the
  // ORDER we push in below does not decide the final selection — PRIORITY does.
  const candidates = new Map<string, VdzSuggestion>();
  const add = (s: VdzSuggestion) => {
    if (!candidates.has(s.id)) candidates.set(s.id, s);
  };

  const tracks = Array.isArray(timeline?.tracks) ? timeline.tracks : [];
  const videoTracks = tracks.filter(t => t?.kind === 'video');
  const overlayTracks = tracks.filter(t => t?.kind === 'overlay');
  const audioTracks = tracks.filter(t => t?.kind === 'audio');

  const duration = computeTimelineDuration(timeline);
  const isEmpty = tracks.every(t => !hasClips(t));

  // Flatten clips once with their owning track, for cross-track scans.
  const allClips: { trackKind: string; clip: Record<string, unknown> }[] = [];
  for (const t of tracks) {
    for (const c of (t.clips ?? []) as Record<string, unknown>[]) {
      allClips.push({ trackKind: t.kind, clip: c });
    }
  }
  const textClips = allClips.filter(c => c.clip.type === 'text');
  const visualClips = allClips.filter(
    c => c.clip.type === 'video' || c.clip.type === 'image'
  );

  // 1) Completely empty project → offer a full build (highest signal).
  if (isEmpty) {
    add({
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
    add({
      id: 'add-title',
      label: 'Add a title — your overlay is empty',
      message: 'Add a bold title card at the start over the first clip.',
    });
  }

  // 3) An audio track exists but is silent → suggest a voiceover/music.
  const audioSilent =
    audioTracks.length > 0 && audioTracks.every(t => !hasClips(t));
  if (!isEmpty && audioSilent) {
    add({
      id: 'add-audio',
      label: 'Your audio track is silent — add a voiceover',
      message:
        'Add a placeholder voiceover clip spanning the whole timeline so I ' +
        'can drop narration in.',
    });
  }

  // (a) Landscape 16:9 canvas + a social/reel/tiktok/short hint anywhere in the
  //     track/clip/text names → suggest reformatting to vertical 9:16. The AI
  //     fulfils this with a setCanvas op (width 1080, height 1920).
  const width = typeof timeline?.width === 'number' ? timeline.width : 1920;
  const height = typeof timeline?.height === 'number' ? timeline.height : 1080;
  const ratio = height > 0 ? width / height : RATIO_16_9;
  const isLandscape16x9 =
    Math.abs(ratio - RATIO_16_9) <= RATIO_TOLERANCE && width >= height;
  const socialHinted =
    tracks.some(t => matchesAny((t.name ?? '').toLowerCase(), SOCIAL_HINT_WORDS)) ||
    allClips.some(c => matchesAny(clipText(c.clip), SOCIAL_HINT_WORDS));
  if (!isEmpty && isLandscape16x9 && socialHinted) {
    add({
      id: 'reformat-vertical',
      label: 'Make it 9:16 for Reels',
      message:
        'This looks like a vertical social video but the canvas is landscape ' +
        '16:9 — switch the canvas to 9:16 (1080×1920) for Reels / TikTok / ' +
        'Shorts.',
    });
  }

  // (b) Adjacent (abutting) clips on a visual track with no transition between
  //     them → suggest a dissolve/fade at the BUSIEST boundary (the track with
  //     the most clips, so the added transition lands where the most is going
  //     on). Supersedes the old first-boundary "add-fade" scan.
  let busiest: {
    trackId: string;
    afterId: string;
    beforeId: string;
    count: number;
  } | null = null;
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
        // "Busiest" = the boundary on the track carrying the most clips.
        if (!busiest || clips.length > busiest.count) {
          busiest = {
            trackId: track.id,
            afterId: a.id,
            beforeId: b.id,
            count: clips.length,
          };
        }
        break; // one candidate boundary per track is enough
      }
    }
  }
  if (busiest) {
    add({
      id: 'add-transition',
      label: 'Add a dissolve between two clips',
      message:
        `Add a half-second dissolve transition between the clip ` +
        `"${busiest.afterId}" and the one after it ("${busiest.beforeId}") ` +
        `for a smooth scene change.`,
    });
  }

  // (c) A music track AND a voiceover/narration audio clip both present → the
  //     music should sit UNDER the voice: suggest ducking. Detected by naming
  //     hints across all audio clips (voice + music both present).
  const audioClips = allClips.filter(c => c.trackKind === 'audio');
  const hasVoice = audioClips.some(c => matchesAny(clipText(c.clip), VOICE_HINT_WORDS));
  const hasMusic = audioClips.some(c => matchesAny(clipText(c.clip), MUSIC_HINT_WORDS));
  const alreadyDucks = audioClips.some(c => c.clip.duck === true);
  if (!isEmpty && hasVoice && hasMusic && !alreadyDucks) {
    add({
      id: 'duck-music',
      label: 'Duck music under the voiceover',
      message:
        'Duck the music track under the voiceover so the narration stays ' +
        'clear — set ducking on the voiceover clip so the music dips while ' +
        'it plays.',
    });
  }

  // (d) Text clips exist but none has a caption preset → suggest styling them
  //     (boxed, lower-third). The AI fulfils this with a setClipStyle op
  //     (capPreset "boxed", capPosition "lower"). capPreset is an additive
  //     schema field; read it defensively so this compiles before/after
  //     Keystone lands the schema.
  const anyCaptionStyled = textClips.some(
    c => typeof c.clip.capPreset === 'string' && c.clip.capPreset !== 'plain'
  );
  if (!isEmpty && textClips.length > 0 && !anyCaptionStyled) {
    add({
      id: 'style-captions',
      label: 'Style captions (boxed, lower)',
      message:
        'Give the caption text clips a boxed lower-third style so they read ' +
        'clearly over the footage.',
    });
  }

  // (e) Video/image clips exist but none has any effects → suggest a cinematic
  //     look (color + a soft vignette). Only when nothing already has effects.
  const anyEffected = visualClips.some(
    c => Array.isArray(c.clip.effects) && c.clip.effects.length > 0
  );
  if (!isEmpty && visualClips.length > 0 && !anyEffected) {
    add({
      id: 'cinematic-look',
      label: 'Give it a cinematic look',
      message:
        'Give the video and image clips a cinematic color grade with a subtle ' +
        'vignette and a touch more contrast.',
    });
  }

  // 4/5) A visible gap (dead air) between two clips on a visual track → offer to
  //      close it (ripple). Distinct from the transition rule (which needs
  //      abutting clips).
  for (const track of videoTracks) {
    const clips = [...(track.clips ?? [])].sort((a, b) => a.start - b.start);
    for (let i = 0; i < clips.length - 1; i++) {
      const a = clips[i];
      const b = clips[i + 1];
      const gap = b.start - (a.start + a.duration);
      if (gap > DEAD_GAP_SECONDS) {
        add({
          id: 'close-gap',
          label: 'Close a gap in the timeline',
          message:
            `There's a ${gap.toFixed(1)}s gap before clip "${b.id}" — pull ` +
            `it and everything after it up to remove the dead air.`,
        });
        break;
      }
    }
    if (candidates.has('close-gap')) break;
  }

  // (f) A long project (> LONG_UNTITLED_SECONDS) with NO text anywhere → it has
  //     never been titled: suggest a title card / lower-thirds.
  if (!isEmpty && duration > LONG_UNTITLED_SECONDS && textClips.length === 0) {
    add({
      id: 'long-needs-title',
      label: 'Long clip, no text — add a title card',
      message:
        'This is a long video with no on-screen text — add an opening title ' +
        'card so viewers know what it is.',
    });
  }

  // 6) Very short (but non-empty) project → suggest an outro to round it off.
  if (!isEmpty && duration > 0 && duration < SHORT_TIMELINE_SECONDS) {
    add({
      id: 'add-outro',
      label: 'Timeline ends abruptly — add an outro',
      message:
        'The video ends abruptly. Add a short outro card at the end with a ' +
        'call to action.',
    });
  }

  // 7) Non-empty but nothing more specific fired → a safe polish default so the
  //    row is never awkwardly empty on a valid project.
  if (!isEmpty && candidates.size === 0) {
    add({
      id: 'add-motion',
      label: 'Add entrance animations to your clips',
      message: 'Give the overlay clips a subtle fade or slide-in on entrance.',
    });
  }

  // Rank by PRIORITY (lower = shown first) and cap. Unlisted ids sort last but
  // keep insertion order among themselves, so a future rule still appears.
  const PRIORITY: Record<string, number> = {
    'build-intro': 0,
    'reformat-vertical': 1,
    'add-title': 2,
    'long-needs-title': 2,
    'add-audio': 3,
    'duck-music': 4,
    'add-transition': 5,
    'close-gap': 6,
    'style-captions': 7,
    'cinematic-look': 8,
    'add-outro': 9,
    'add-motion': 10,
  };
  const ranked = [...candidates.values()].sort((a, b) => {
    const pa = PRIORITY[a.id] ?? 100;
    const pb = PRIORITY[b.id] ?? 100;
    return pa - pb;
  });
  return ranked.slice(0, MAX_SUGGESTIONS);
}
