import type { VdzTimeline } from './schema';

/**
 * A tasteful ~12s demo timeline for the Vdz Studio shell.
 *
 * The "video" track uses `shape` clips as honest color-placeholder blocks
 * (a fake media `src` would be misleading). The overlay track carries two
 * text clips, and the audio track a single muted placeholder. All positions
 * (`x`/`y`/`w`/`h`) are canvas fractions in 0..1.
 */
export function createSampleTimeline(): VdzTimeline {
  return {
    version: 1,
    id: 'vdz-sample',
    name: 'Untitled Vdz project',
    fps: 30,
    width: 1920,
    height: 1080,
    tracks: [
      {
        id: 'track-video',
        kind: 'video',
        name: 'Video',
        clips: [
          {
            id: 'clip-bg-1',
            type: 'shape',
            name: 'Intro backdrop',
            start: 0,
            duration: 6,
            shape: 'rect',
            color: '#1b2a4a',
            x: 0,
            y: 0,
            w: 1,
            h: 1,
          },
          {
            id: 'clip-bg-2',
            type: 'shape',
            name: 'Outro backdrop',
            start: 6,
            duration: 6,
            shape: 'rect',
            color: '#241b3f',
            x: 0,
            y: 0,
            w: 1,
            h: 1,
          },
        ],
        transitions: [
          {
            id: 'xfade-1',
            kind: 'fade',
            afterClipId: 'clip-bg-1',
            duration: 0.5,
          },
        ],
      },
      {
        id: 'track-overlay',
        kind: 'overlay',
        name: 'Overlay',
        clips: [
          {
            id: 'clip-title',
            type: 'text',
            name: 'Title',
            start: 0.5,
            duration: 5,
            text: 'Vdz Studio',
            fontSize: 0.12,
            color: '#ffffff',
            x: 0.5,
            y: 0.42,
            align: 'center',
          },
          {
            id: 'clip-subtitle',
            type: 'text',
            name: 'Subtitle',
            start: 6.5,
            duration: 5,
            text: 'Edit video with AI',
            fontSize: 0.07,
            color: '#a06bff',
            x: 0.5,
            y: 0.55,
            align: 'center',
          },
        ],
      },
      {
        id: 'track-audio',
        kind: 'audio',
        name: 'Audio',
        clips: [
          {
            id: 'clip-music',
            type: 'audio',
            name: 'Background music (muted placeholder)',
            start: 0,
            duration: 12,
            src: '',
            volume: 0,
          },
        ],
      },
    ],
  };
}
