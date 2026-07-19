import { memo, useEffect, useMemo, useRef } from 'react';

import type { VdzAudioClip, VdzTimeline } from '../../../../modules/vdz';
import { useBlobUrl } from '../../../../modules/vdz/use-vdz-media';
import {
  computeAudioClipGain,
  type DuckWindow,
  duckWindows,
} from './audio-gain';
import { isClipActive } from './constants';

/**
 * Audible playback for the Vdz preview — the AUDIO-TRACK engine.
 *
 * This component owns sound for `type === 'audio'` clips ONLY: it mounts a
 * hidden `<audio>` per audio clip and slaves it to the SAME master clock the
 * rest of the editor uses (`playheadSeconds` + `isPlaying`, owned by the page
 * and advanced by its rAF loop).
 *
 * VIDEO-CLIP AUDIO IS DELIBERATELY NOT HANDLED HERE. A video clip's sound comes
 * from its OWN preview `<video>` element (see preview-canvas.tsx `PreviewVideo`,
 * A1b) — one element for both pixels and sound keeps A/V inherently in sync. If
 * this engine also mounted a voice for `type === 'video'` clips the audio would
 * play TWICE (decoded once by the `<video>`, once by a parallel `<audio>`), so
 * the `type === 'audio'` filter below is load-bearing: do not widen it.
 *
 * Design notes:
 * - One `<audio>` per audio clip (keyed by clip id; React mounts/unmounts as
 *   clips come and go). Each resolves its durable `vdz-blob:` src through the
 *   same `useBlobUrl` the preview uses, so a saved/reloaded project plays.
 * - While playing and the clip sits under the playhead the element plays
 *   NATIVELY; we only re-seek when it drifts past `DRIFT_TOLERANCE` from the
 *   expected source time, so audio is never stuttered by a per-frame seek.
 * - Paused / scrubbing is silent (mirrors the visual scrub) but we keep the
 *   element's `currentTime` aligned so the next Play resumes in sync.
 * - Master mute (`muted`, the preview/toolbar speaker toggle) silences these
 *   voices AND the preview `<video>` elements together — one shared state.
 *
 * Gain: each element's volume is the clip's base volume × its fade envelope
 * (fadeIn/fadeOut ramps) × the duck multiplier (other audio dips under `duck`
 * clips) — pure math in audio-gain.ts, applied per playhead tick (rAF cadence,
 * perceptually smooth; a WebAudio MediaElementSource graph would silence
 * cross-origin sources, so element.volume automation is the deliberate call).
 *
 * Out of scope here: MP4-export audio is a Remotion-tier concern — the HTML
 * export path is muted by design (see compile-timeline.ts).
 */

/** Only re-seek an element when it drifts this far (seconds) from the playhead. */
const DRIFT_TOLERANCE = 0.25;

interface AudioClipVoiceProps {
  clip: VdzAudioClip;
  playheadSeconds: number;
  isPlaying: boolean;
  muted: boolean;
  /** Merged duck windows for the whole timeline (see audio-gain.ts). */
  windows: DuckWindow[];
}

/** A single hidden `<audio>` slaved to the master playhead. */
const AudioClipVoice = memo(function AudioClipVoice({
  clip,
  playheadSeconds,
  isPlaying,
  muted,
  windows,
}: AudioClipVoiceProps) {
  const resolvedSrc = useBlobUrl(clip.src);
  const ref = useRef<HTMLAudioElement | null>(null);

  const active = isClipActive(clip, playheadSeconds);
  // Audio clips play from the head of their source (there is no per-clip audio
  // trim in the schema today), offset by where the playhead sits in the clip.
  const sourceTime = Math.max(0, playheadSeconds - clip.start);

  // Effective gain this tick: base volume × fade envelope × duck multiplier.
  // playheadSeconds advances every rAF frame during playback, so ramps land
  // as ~60Hz volume automation — smooth for fades and duck attack/release.
  const gain = computeAudioClipGain({ clip, t: playheadSeconds, windows });

  // Keep gain / mute in sync without touching transport.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = gain;
    el.muted = muted;
  }, [gain, muted]);

  // Transport: play under the playhead, pause otherwise, correct drift lazily.
  useEffect(() => {
    const el = ref.current;
    if (!el || !resolvedSrc) return;
    if (isPlaying && active) {
      if (Math.abs(el.currentTime - sourceTime) > DRIFT_TOLERANCE) {
        try {
          el.currentTime = sourceTime;
        } catch {
          // Seeking before metadata loads can throw; the next tick retries.
        }
      }
      if (el.paused) {
        // play() can reject if the browser wants a gesture; pressing Play IS a
        // gesture, and a rejection is harmless (the next tick retries).
        void el.play().catch(() => undefined);
      }
    } else {
      if (!el.paused) el.pause();
      // Stay aligned so resuming from a scrub starts in the right place.
      if (
        !isPlaying &&
        Math.abs(el.currentTime - sourceTime) > DRIFT_TOLERANCE
      ) {
        try {
          el.currentTime = sourceTime;
        } catch {
          // ignore — will align on the next play
        }
      }
    }
  }, [isPlaying, active, sourceTime, resolvedSrc]);

  // Never leave a dangling element playing after unmount (clip deleted, editor
  // closed, project switched).
  useEffect(() => {
    return () => {
      const el = ref.current;
      if (el && !el.paused) el.pause();
    };
  }, []);

  if (!resolvedSrc) return null;
  return <audio ref={ref} src={resolvedSrc} preload="auto" />;
});

export interface VdzAudioPlaybackProps {
  timeline: VdzTimeline;
  playheadSeconds: number;
  isPlaying: boolean;
  /** Master mute for the whole preview (the toolbar speaker toggle). */
  muted?: boolean;
}

/**
 * Mount once inside the editor. Renders a hidden pool of `<audio>` elements —
 * one per audio-track clip — kept in sync with the master playhead. Non-visual.
 */
export const VdzAudioPlayback = memo(function VdzAudioPlayback({
  timeline,
  playheadSeconds,
  isPlaying,
  muted = false,
}: VdzAudioPlaybackProps) {
  const voices: VdzAudioClip[] = [];
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      // AUDIO clips only. Video-clip audio is played by that clip's own preview
      // <video> (preview-canvas.tsx, A1b); mounting a voice here too would
      // double-play it. This filter is load-bearing — do NOT include 'video'.
      if (clip.type === 'audio' && clip.src) voices.push(clip);
    }
  }

  // Duck windows change only on a timeline edit — never on a playhead tick.
  const windows = useMemo(() => duckWindows(timeline), [timeline]);

  return (
    <div aria-hidden="true" style={{ display: 'none' }}>
      {voices.map(clip => (
        <AudioClipVoice
          key={clip.id}
          clip={clip}
          playheadSeconds={playheadSeconds}
          isPlaying={isPlaying}
          muted={muted}
          windows={windows}
        />
      ))}
    </div>
  );
});
