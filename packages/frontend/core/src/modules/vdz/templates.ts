import { nanoid } from 'nanoid';

import type { VdzTimeline } from './schema';

/**
 * Vdz Studio — prebuilt timeline templates.
 *
 * Pure data builders: each template constructs a complete, schema-valid
 * `VdzTimeline` with FRESH ids on every call (safe to instantiate repeatedly;
 * splits/dedups never collide). Media slots use EMPTY srcs — the shell renders
 * placeholders and the user drops their own footage/music in. No backend, no
 * network: templates are part of the app.
 *
 * Conventions the editor relies on:
 *  - tracks ordered video → overlay → audio (overlay paints above video),
 *  - within a track, clips are listed in start order,
 *  - transitions only between ABUTTING clips,
 *  - text y/fontSize are canvas fractions (lower third ≈ y 0.8).
 */

export interface VdzTemplate {
  id: string;
  name: string;
  description: string;
  /** Two colors for the gallery thumbnail gradient. */
  accent: [string, string];
  /** Emoji badge for the gallery card. */
  emoji: string;
  build: () => VdzTimeline;
}

const cid = (slug: string) => `clip-${slug}-${nanoid(4)}`;
const tid = (slug: string) => `track-${slug}-${nanoid(4)}`;

const base = (name: string): Omit<VdzTimeline, 'tracks'> => ({
  version: 1,
  id: `vdz-tpl-${nanoid(6)}`,
  name,
  fps: 30,
  width: 1920,
  height: 1080,
});

/** 1 — Bold intro: your clip under a title that slides in and hands off. */
function buildBoldIntro(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  return {
    ...base('Bold intro'),
    tracks: [
      {
        id: video,
        kind: 'video',
        name: 'Video',
        clips: [
          {
            id: cid('bg'),
            type: 'video',
            name: 'Your clip',
            start: 0,
            duration: 6,
            src: '',
            trimStart: 0,
            volume: 1,
          },
        ],
      },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Overlay',
        clips: [
          {
            id: cid('title'),
            type: 'text',
            name: 'Title',
            start: 0.2,
            duration: 3.2,
            text: 'MAKE IT MOVE',
            fontSize: 0.12,
            color: '#ffffff',
            x: 0.5,
            y: 0.44,
            align: 'center',
            animation: {
              in: { kind: 'slide-up', duration: 0.5 },
              out: { kind: 'fade', duration: 0.5 },
            },
          },
          {
            id: cid('subtitle'),
            type: 'text',
            name: 'Subtitle',
            start: 0.7,
            duration: 2.9,
            text: 'A film by you',
            fontSize: 0.045,
            color: '#9aa3b5',
            x: 0.5,
            y: 0.58,
            align: 'center',
            animation: {
              in: { kind: 'fade', duration: 0.6 },
              out: { kind: 'fade', duration: 0.5 },
            },
          },
        ],
      },
      { id: audio, kind: 'audio', name: 'Audio', clips: [] },
    ],
  };
}

/** 2 — Lower third: interview-style name bar over your footage. */
function buildLowerThird(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  return {
    ...base('Lower third'),
    tracks: [
      {
        id: video,
        kind: 'video',
        name: 'Video',
        clips: [
          {
            id: cid('interview'),
            type: 'video',
            name: 'Interview footage',
            start: 0,
            duration: 8,
            src: '',
            trimStart: 0,
            volume: 1,
          },
        ],
      },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Overlay',
        clips: [
          {
            id: cid('bar'),
            type: 'shape',
            name: 'Name bar',
            start: 0.6,
            duration: 5.4,
            shape: 'rect',
            color: '#5b8cff',
            x: 0.04,
            y: 0.78,
            w: 0.4,
            h: 0.015,
            animation: {
              in: { kind: 'slide-right', duration: 0.4 },
              out: { kind: 'fade', duration: 0.4 },
            },
          },
          {
            id: cid('name'),
            type: 'text',
            name: 'Name',
            start: 0.8,
            duration: 5.2,
            text: 'Alex Rivera',
            fontSize: 0.055,
            color: '#ffffff',
            x: 0.24,
            y: 0.84,
            align: 'center',
            animation: {
              in: { kind: 'slide-right', duration: 0.4 },
              out: { kind: 'fade', duration: 0.4 },
            },
          },
          {
            id: cid('role'),
            type: 'text',
            name: 'Role',
            start: 1.0,
            duration: 5.0,
            text: 'Product Designer',
            fontSize: 0.032,
            color: '#c8cede',
            x: 0.24,
            y: 0.9,
            align: 'center',
            animation: {
              in: { kind: 'fade', duration: 0.5 },
              out: { kind: 'fade', duration: 0.4 },
            },
          },
        ],
      },
      { id: audio, kind: 'audio', name: 'Audio', clips: [] },
    ],
  };
}

/** 3 — Photo slideshow: three stills, crossfades, one caption each. */
function buildSlideshow(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  const img1 = cid('img1');
  const img2 = cid('img2');
  const captions = [
    { text: 'Chapter one', start: 0.4 },
    { text: 'Chapter two', start: 4.4 },
    { text: 'Chapter three', start: 8.4 },
  ];
  return {
    ...base('Photo slideshow'),
    tracks: [
      {
        id: video,
        kind: 'video',
        name: 'Photos',
        clips: [
          {
            id: img1,
            type: 'image',
            name: 'Photo 1',
            start: 0,
            duration: 4,
            src: '',
            fit: 'cover',
          },
          {
            id: img2,
            type: 'image',
            name: 'Photo 2',
            start: 4,
            duration: 4,
            src: '',
            fit: 'cover',
          },
          {
            id: cid('img3'),
            type: 'image',
            name: 'Photo 3',
            start: 8,
            duration: 4,
            src: '',
            fit: 'cover',
          },
        ],
        transitions: [
          {
            id: `xfade-${nanoid(4)}`,
            kind: 'fade',
            afterClipId: img1,
            duration: 0.5,
          },
          {
            id: `xfade-${nanoid(4)}`,
            kind: 'fade',
            afterClipId: img2,
            duration: 0.5,
          },
        ],
      },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Captions',
        clips: captions.map((cap, i) => ({
          id: cid(`cap${i + 1}`),
          type: 'text' as const,
          name: `Caption ${i + 1}`,
          start: cap.start,
          duration: 3.2,
          text: cap.text,
          fontSize: 0.05,
          color: '#ffffff',
          x: 0.5,
          y: 0.85,
          align: 'center' as const,
          animation: {
            in: { kind: 'fade' as const, duration: 0.5 },
            out: { kind: 'fade' as const, duration: 0.5 },
          },
        })),
      },
      { id: audio, kind: 'audio', name: 'Music', clips: [] },
    ],
  };
}

/** 4 — Social hook: four punchy cards that pop in sequence. */
function buildSocialHook(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  const cards = [
    { text: 'STOP SCROLLING', color: '#ffd700', at: 0 },
    { text: 'This takes 30 seconds', color: '#ffffff', at: 1.6 },
    { text: 'And changes your edits', color: '#3fb7a6', at: 3.2 },
    { text: 'Watch till the end →', color: '#ff6b6b', at: 4.8 },
  ];
  return {
    ...base('Social hook'),
    tracks: [
      {
        id: video,
        kind: 'video',
        name: 'Background',
        clips: [
          {
            id: cid('bgclip'),
            type: 'video',
            name: 'Background loop',
            start: 0,
            duration: 6.4,
            src: '',
            trimStart: 0,
            volume: 0.2,
          },
        ],
      },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Cards',
        clips: cards.map((card, i) => ({
          id: cid(`card${i + 1}`),
          type: 'text' as const,
          name: `Card ${i + 1}`,
          start: card.at,
          duration: 1.6,
          text: card.text,
          fontSize: i === 0 ? 0.13 : 0.09,
          color: card.color,
          x: 0.5,
          y: 0.5,
          align: 'center' as const,
          animation: {
            in: { kind: 'pop' as const, duration: 0.35 },
            out: { kind: 'zoom-out' as const, duration: 0.3 },
          },
        })),
      },
      { id: audio, kind: 'audio', name: 'Audio', clips: [] },
    ],
  };
}

/** 5 — Podcast audiogram: drop an episode in, caption it, ship a teaser. */
function buildAudiogram(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  return {
    ...base('Podcast audiogram'),
    tracks: [
      { id: video, kind: 'video', name: 'Video', clips: [] },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Overlay',
        clips: [
          {
            id: cid('disc'),
            type: 'shape',
            name: 'Disc',
            start: 0,
            duration: 20,
            shape: 'circle',
            color: '#191c25',
            x: 0.38,
            y: 0.18,
            w: 0.24,
            h: 0.42,
            animation: { in: { kind: 'zoom-in', duration: 0.8 } },
          },
          {
            id: cid('show'),
            type: 'text',
            name: 'Show name',
            start: 0.4,
            duration: 19.6,
            text: 'THE SHOW',
            fontSize: 0.06,
            color: '#ffffff',
            x: 0.5,
            y: 0.68,
            align: 'center',
            animation: { in: { kind: 'fade', duration: 0.6 } },
          },
          {
            id: cid('hint'),
            type: 'text',
            name: 'How-to hint',
            start: 0.8,
            duration: 6,
            text: 'Drop your episode on the audio lane, then generate captions from the Inspector',
            fontSize: 0.028,
            color: '#8a90a0',
            x: 0.5,
            y: 0.9,
            align: 'center',
            animation: {
              in: { kind: 'fade', duration: 0.6 },
              out: { kind: 'fade', duration: 0.8 },
            },
          },
        ],
      },
      {
        id: audio,
        kind: 'audio',
        name: 'Episode',
        clips: [
          {
            id: cid('episode'),
            type: 'audio',
            name: 'Your episode',
            start: 0,
            duration: 20,
            src: '',
            volume: 1,
            fadeIn: 0.5,
            fadeOut: 1.5,
          },
        ],
      },
    ],
  };
}

export const VDZ_TEMPLATES: VdzTemplate[] = [
  {
    id: 'bold-intro',
    name: 'Bold intro',
    description: 'Title + subtitle over your opening shot.',
    accent: ['#5b8cff', '#a06bff'],
    emoji: '🎬',
    build: buildBoldIntro,
  },
  {
    id: 'lower-third',
    name: 'Lower third',
    description: 'Interview name bar, ready to retype.',
    accent: ['#3fb7a6', '#5b8cff'],
    emoji: '🎤',
    build: buildLowerThird,
  },
  {
    id: 'slideshow',
    name: 'Photo slideshow',
    description: 'Three stills, crossfades, captions.',
    accent: ['#ffd700', '#ff6b6b'],
    emoji: '🖼️',
    build: buildSlideshow,
  },
  {
    id: 'social-hook',
    name: 'Social hook',
    description: 'Four punchy cards that pop in sequence.',
    accent: ['#ff6b6b', '#a06bff'],
    emoji: '⚡',
    build: buildSocialHook,
  },
  {
    id: 'audiogram',
    name: 'Podcast audiogram',
    description: 'Episode + captions teaser, fades preset.',
    accent: ['#191c25', '#3fb7a6'],
    emoji: '🎙️',
    build: buildAudiogram,
  },
];
