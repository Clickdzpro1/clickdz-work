import { memo, useEffect, useRef } from 'react';

import type { VdzAudioClip, VdzTimeline } from '../../../../modules/vdz';
import { useBlobUrl } from '../../../../modules/vdz/use-vdz-media';
import { isClipActive } from './constants';

/**
 * Audible playback for the Vdz preview.
 *
 * The preview canvas is a VISUAL surface only — its `<video>` elements are
 * muted and re-seeked per playhead tick (see preview-canvas.tsx), so the editor
 * has never produced sound. This component closes that gap for AUDIO-track
 * clips: it mounts a hidden `<audio>` per audio clip and slaves it to the SAME
 * master clock the rest of the editor uses (`playheadSeconds` + `isPlaying`,
 * owned by the page and advanced by its rAF loop).
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
 *
 * Out of scope here (documented follow-ups): video-clip audio, waveforms,
 * ducking and fades. MP4-export audio is a Remotion-tier concern — the HTML
 * export path is muted by design (see compile-timeline.ts).
 */

/** Only re-seek an element when it drifts this far (seconds) from the playhead. */
const DRIFT_TOLERANCE = 0.25;

interface AudioClipVoiceProps {
  clip: VdzAudioClip;
  playheadSeconds: number;
  isPlaying: boolean;
  muted: boolean;
}

/** A single hidden `<audio>` slaved to the master playhead. */
const AudioClipVoice = memo(function AudioClipVoice({
  clip,
  playheadSeconds,
  isPlaying,
  muted,
}: AudioClipVoiceProps) {
  const resolvedSrc = useBlobUrl(clip.src);
  const ref = useRef<HTMLAudioElement | null>(null);

  const active = isClipActive(clip, playheadSeconds);
  // Audio clips play from the head of their source (there is no per-clip audio
  // trim in the schema today), offset by where the playhead sits in the clip.
  const sourceTime = Math.max(0, playheadSeconds - clip.start);

  // Keep gain / mute in sync without touching transport.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = clip.volume ?? 1;
    el.muted = muted;
  }, [clip.volume, muted]);

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
      // Only real audio clips with a source contribute sound.
      if (clip.type === 'audio' && clip.src) voices.push(clip);
    }
  }

  return (
    <div aria-hidden="true" style={{ display: 'none' }}>
      {voices.map(clip => (
        <AudioClipVoice
          key={clip.id}
          clip={clip}
          playheadSeconds={playheadSeconds}
          isPlaying={isPlaying}
          muted={muted}
        />
      ))}
    </div>
  );
});
