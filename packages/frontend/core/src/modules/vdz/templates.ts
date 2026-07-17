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
 *
 * Aspect ratios: each template sets its own `width`/`height` (canvas fractions
 * keep text/shape placement resolution-independent, so a 9:16 template reads
 * the same math as a 16:9 one). Templates lean on the additive schema fields
 * (`capPreset`/`capPosition` on text, `dissolve`/`push`/`iris` transitions, the
 * `vignette` effect) where they sharpen the look; every field stays optional so
 * older saved projects are unaffected.
 */

/** Buckets used by the gallery's category filter (derived from the data). */
export type VdzTemplateCategory =
  | 'Social'
  | 'Promo'
  | 'Explainer'
  | 'Slideshow'
  | 'Intro & Outro'
  | 'Podcast'
  | 'Cinematic';

export interface VdzTemplate {
  id: string;
  name: string;
  description: string;
  /** Gallery bucket for the category filter. */
  category: VdzTemplateCategory;
  /** Two colors for the gallery thumbnail gradient. */
  accent: [string, string];
  /** Emoji badge for the gallery card. */
  emoji: string;
  build: () => VdzTimeline;
}

const cid = (slug: string) => `clip-${slug}-${nanoid(4)}`;
const tid = (slug: string) => `track-${slug}-${nanoid(4)}`;

/**
 * Common timeline header. Width/height default to 16:9 (1920×1080); pass a
 * ratio preset from {@link RATIO} for portrait / square / cinema canvases.
 */
const base = (
  name: string,
  size: { width: number; height: number } = { width: 1920, height: 1080 }
): Omit<VdzTimeline, 'tracks'> => ({
  version: 1,
  id: `vdz-tpl-${nanoid(6)}`,
  name,
  fps: 30,
  width: size.width,
  height: size.height,
});

/** Canvas presets mirroring the studio's ratio picker. */
const RATIO = {
  widescreen: { width: 1920, height: 1080 }, // 16:9
  vertical: { width: 1080, height: 1920 }, // 9:16
  square: { width: 1080, height: 1080 }, // 1:1
  portrait: { width: 1080, height: 1350 }, // 4:5
  cinema: { width: 2560, height: 1080 }, // 21:9
} as const;

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

/**
 * 6 — Reel hook (9:16): three stacked text beats that snap in over your
 * vertical clip, sized big for phones. A boxed caption lands the payoff.
 */
function buildReelHook(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  return {
    ...base('Reel hook', RATIO.vertical),
    tracks: [
      {
        id: video,
        kind: 'video',
        name: 'Vertical clip',
        clips: [
          {
            id: cid('reel'),
            type: 'video',
            name: 'Your reel',
            start: 0,
            duration: 8,
            src: '',
            trimStart: 0,
            volume: 0.4,
          },
        ],
      },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Beats',
        clips: [
          {
            id: cid('beat1'),
            type: 'text',
            name: 'Beat 1',
            start: 0.15,
            duration: 2.1,
            text: 'WAIT FOR IT',
            fontSize: 0.075,
            color: '#ffffff',
            x: 0.5,
            y: 0.22,
            align: 'center',
            capPreset: 'shadow',
            capPosition: 'top',
            animation: {
              in: { kind: 'slide-down', duration: 0.35 },
              out: { kind: 'fade', duration: 0.25 },
            },
          },
          {
            id: cid('beat2'),
            type: 'text',
            name: 'Beat 2',
            start: 2.4,
            duration: 2.4,
            text: 'here comes the good part',
            fontSize: 0.05,
            color: '#ffd700',
            x: 0.5,
            y: 0.5,
            align: 'center',
            capPreset: 'shadow',
            capPosition: 'middle',
            animation: {
              in: { kind: 'pop', duration: 0.3 },
              out: { kind: 'zoom-out', duration: 0.3 },
            },
          },
          {
            id: cid('beat3'),
            type: 'text',
            name: 'Payoff',
            start: 5.0,
            duration: 2.6,
            text: 'FOLLOW FOR MORE',
            fontSize: 0.058,
            color: '#0b0d12',
            x: 0.5,
            y: 0.8,
            align: 'center',
            capPreset: 'pill',
            capPosition: 'lower',
            animation: {
              in: { kind: 'slide-up', duration: 0.35 },
              out: { kind: 'fade', duration: 0.4 },
            },
          },
        ],
      },
      { id: audio, kind: 'audio', name: 'Sound', clips: [] },
    ],
  };
}

/**
 * 7 — TikTok promo (9:16): brand tag, product beat and CTA over a vertical
 * clip with a bottom scrim for legibility. Music lane primed with a fade.
 */
function buildTikTokPromo(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  return {
    ...base('TikTok promo', RATIO.vertical),
    tracks: [
      {
        id: video,
        kind: 'video',
        name: 'Vertical clip',
        clips: [
          {
            id: cid('promo'),
            type: 'video',
            name: 'Product clip',
            start: 0,
            duration: 9,
            src: '',
            trimStart: 0,
            volume: 0.5,
          },
        ],
      },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Promo',
        clips: [
          {
            id: cid('scrim'),
            type: 'shape',
            name: 'Bottom scrim',
            start: 0,
            duration: 9,
            shape: 'rect',
            color: '#0b0d12',
            x: 0,
            y: 0.68,
            w: 1,
            h: 0.32,
            opacity: 0.55,
          },
          {
            id: cid('brand'),
            type: 'text',
            name: 'Brand tag',
            start: 0.3,
            duration: 8.4,
            text: '@yourbrand',
            fontSize: 0.032,
            color: '#9aa3b5',
            x: 0.5,
            y: 0.08,
            align: 'center',
            capPreset: 'plain',
            capPosition: 'top',
            animation: { in: { kind: 'fade', duration: 0.5 } },
          },
          {
            id: cid('headline'),
            type: 'text',
            name: 'Headline',
            start: 0.6,
            duration: 4.4,
            text: 'The upgrade you felt was missing',
            fontSize: 0.052,
            color: '#ffffff',
            x: 0.5,
            y: 0.74,
            align: 'center',
            animation: {
              in: { kind: 'slide-up', duration: 0.4 },
              out: { kind: 'fade', duration: 0.4 },
            },
          },
          {
            id: cid('cta'),
            type: 'text',
            name: 'CTA',
            start: 5.2,
            duration: 3.4,
            text: 'Tap the link → 20% off today',
            fontSize: 0.05,
            color: '#3fb7a6',
            x: 0.5,
            y: 0.78,
            align: 'center',
            capPreset: 'boxed',
            capPosition: 'lower',
            animation: {
              in: { kind: 'pop', duration: 0.35 },
              out: { kind: 'fade', duration: 0.4 },
            },
          },
        ],
      },
      {
        id: audio,
        kind: 'audio',
        name: 'Music',
        clips: [
          {
            id: cid('track'),
            type: 'audio',
            name: 'Trending sound',
            start: 0,
            duration: 9,
            src: '',
            volume: 0.9,
            fadeIn: 0.3,
            fadeOut: 0.8,
          },
        ],
      },
    ],
  };
}

/**
 * 8 — Square product card (1:1): a framed product still with a price chip and
 * name, built for the feed grid. Dissolve hands the still to a close-up.
 */
function buildProductCard(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  const shot1 = cid('shot1');
  return {
    ...base('Square product card', RATIO.square),
    tracks: [
      {
        id: video,
        kind: 'video',
        name: 'Product',
        clips: [
          {
            id: shot1,
            type: 'image',
            name: 'Hero shot',
            start: 0,
            duration: 4,
            src: '',
            fit: 'cover',
          },
          {
            id: cid('shot2'),
            type: 'image',
            name: 'Detail shot',
            start: 4,
            duration: 4,
            src: '',
            fit: 'cover',
          },
        ],
        transitions: [
          {
            id: `xdis-${nanoid(4)}`,
            kind: 'dissolve',
            afterClipId: shot1,
            duration: 0.5,
          },
        ],
      },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Label',
        clips: [
          {
            id: cid('frame'),
            type: 'shape',
            name: 'Inner frame',
            start: 0,
            duration: 8,
            shape: 'rect',
            color: '#ffffff',
            x: 0.06,
            y: 0.06,
            w: 0.88,
            h: 0.88,
            opacity: 0.9,
          },
          {
            id: cid('pname'),
            type: 'text',
            name: 'Product name',
            start: 0.4,
            duration: 7.4,
            text: 'Aero Runner',
            fontSize: 0.07,
            color: '#0b0d12',
            x: 0.5,
            y: 0.8,
            align: 'center',
            animation: { in: { kind: 'slide-up', duration: 0.4 } },
          },
          {
            id: cid('price'),
            type: 'text',
            name: 'Price chip',
            start: 0.8,
            duration: 7.0,
            text: '$129',
            fontSize: 0.055,
            color: '#ffffff',
            x: 0.82,
            y: 0.14,
            align: 'center',
            capPreset: 'pill',
            capPosition: 'top',
            animation: { in: { kind: 'pop', duration: 0.35 } },
          },
        ],
      },
      { id: audio, kind: 'audio', name: 'Audio', clips: [] },
    ],
  };
}

/**
 * 9 — Sale countdown (16:9): a big discount number, urgency line, and a code
 * chip on a punchy gradient-friendly canvas. Iris wipe stings the reveal.
 */
function buildSaleCountdown(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  const plate = cid('plate');
  return {
    ...base('Sale countdown'),
    tracks: [
      {
        id: video,
        kind: 'video',
        name: 'Backdrop',
        clips: [
          {
            id: plate,
            type: 'image',
            name: 'Backdrop',
            start: 0,
            duration: 3.5,
            src: '',
            fit: 'cover',
          },
          {
            id: cid('plate2'),
            type: 'image',
            name: 'Backdrop 2',
            start: 3.5,
            duration: 4.5,
            src: '',
            fit: 'cover',
          },
        ],
        transitions: [
          {
            id: `iris-${nanoid(4)}`,
            kind: 'iris',
            afterClipId: plate,
            duration: 0.6,
          },
        ],
      },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Sale',
        clips: [
          {
            id: cid('flash'),
            type: 'text',
            name: 'Kicker',
            start: 0.2,
            duration: 3.0,
            text: 'FLASH SALE',
            fontSize: 0.05,
            color: '#ffd700',
            x: 0.5,
            y: 0.24,
            align: 'center',
            capPreset: 'outline',
            capPosition: 'top',
            animation: {
              in: { kind: 'slide-down', duration: 0.35 },
              out: { kind: 'fade', duration: 0.3 },
            },
          },
          {
            id: cid('pct'),
            type: 'text',
            name: 'Discount',
            start: 0.5,
            duration: 3.0,
            text: '50% OFF',
            fontSize: 0.2,
            color: '#ffffff',
            x: 0.5,
            y: 0.5,
            align: 'center',
            animation: {
              in: { kind: 'pop', duration: 0.4 },
              out: { kind: 'zoom-out', duration: 0.3 },
            },
          },
          {
            id: cid('urgency'),
            type: 'text',
            name: 'Urgency',
            start: 4.0,
            duration: 3.6,
            text: 'Ends midnight — 24 hours only',
            fontSize: 0.045,
            color: '#ffffff',
            x: 0.5,
            y: 0.42,
            align: 'center',
            animation: {
              in: { kind: 'fade', duration: 0.4 },
              out: { kind: 'fade', duration: 0.4 },
            },
          },
          {
            id: cid('code'),
            type: 'text',
            name: 'Code chip',
            start: 4.4,
            duration: 3.2,
            text: 'CODE: SAVE50',
            fontSize: 0.05,
            color: '#0b0d12',
            x: 0.5,
            y: 0.62,
            align: 'center',
            capPreset: 'pill',
            capPosition: 'lower',
            animation: {
              in: { kind: 'slide-up', duration: 0.35 },
              out: { kind: 'fade', duration: 0.4 },
            },
          },
        ],
      },
      { id: audio, kind: 'audio', name: 'Audio', clips: [] },
    ],
  };
}

/**
 * 10 — Feature trio (16:9): a title, then three benefit rows that stack in
 * one after another — the classic "three reasons" explainer beat.
 */
function buildFeatureTrio(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  const features = [
    { text: '1 · Faster edits', at: 2.4 },
    { text: '2 · Zero learning curve', at: 3.6 },
    { text: '3 · Ships anywhere', at: 4.8 },
  ];
  return {
    ...base('Feature trio'),
    tracks: [
      {
        id: video,
        kind: 'video',
        name: 'Background',
        clips: [
          {
            id: cid('bg'),
            type: 'video',
            name: 'Soft background',
            start: 0,
            duration: 9,
            src: '',
            trimStart: 0,
            volume: 0.15,
            effects: [{ kind: 'vignette', amount: 0.4 }],
          },
        ],
      },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Features',
        clips: [
          {
            id: cid('title'),
            type: 'text',
            name: 'Title',
            start: 0.3,
            duration: 8.4,
            text: 'Why teams switch',
            fontSize: 0.07,
            color: '#ffffff',
            x: 0.5,
            y: 0.2,
            align: 'center',
            animation: {
              in: { kind: 'slide-down', duration: 0.4 },
              out: { kind: 'fade', duration: 0.5 },
            },
          },
          ...features.map((f, i) => ({
            id: cid(`feat${i + 1}`),
            type: 'text' as const,
            name: `Feature ${i + 1}`,
            start: f.at,
            duration: 8.6 - f.at,
            text: f.text,
            fontSize: 0.05,
            color: '#c8cede',
            x: 0.5,
            y: 0.42 + i * 0.14,
            align: 'center' as const,
            animation: {
              in: { kind: 'slide-left' as const, duration: 0.35 },
              out: { kind: 'fade' as const, duration: 0.4 },
            },
          })),
        ],
      },
      { id: audio, kind: 'audio', name: 'Audio', clips: [] },
    ],
  };
}

/**
 * 11 — Quote card (1:1): oversized centered pull-quote with an attribution
 * line, framed by quote marks. A calm, share-ready still with a slow fade.
 */
function buildQuoteCard(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  return {
    ...base('Quote card', RATIO.square),
    tracks: [
      {
        id: video,
        kind: 'video',
        name: 'Background',
        clips: [
          {
            id: cid('bg'),
            type: 'image',
            name: 'Texture',
            start: 0,
            duration: 8,
            src: '',
            fit: 'cover',
          },
        ],
      },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Quote',
        clips: [
          {
            id: cid('mark'),
            type: 'text',
            name: 'Quote mark',
            start: 0.2,
            duration: 7.6,
            text: '“',
            fontSize: 0.24,
            color: '#5b8cff',
            x: 0.2,
            y: 0.22,
            align: 'center',
            animation: { in: { kind: 'zoom-in', duration: 0.6 } },
          },
          {
            id: cid('quote'),
            type: 'text',
            name: 'Quote',
            start: 0.6,
            duration: 6.9,
            text: 'Great work is just small good choices, repeated.',
            fontSize: 0.062,
            color: '#ffffff',
            x: 0.5,
            y: 0.46,
            align: 'center',
            animation: {
              in: { kind: 'fade', duration: 0.8 },
              out: { kind: 'fade', duration: 0.8 },
            },
          },
          {
            id: cid('attr'),
            type: 'text',
            name: 'Attribution',
            start: 1.6,
            duration: 5.9,
            text: '— Your Name',
            fontSize: 0.036,
            color: '#9aa3b5',
            x: 0.5,
            y: 0.74,
            align: 'center',
            animation: {
              in: { kind: 'slide-up', duration: 0.5 },
              out: { kind: 'fade', duration: 0.6 },
            },
          },
        ],
      },
      { id: audio, kind: 'audio', name: 'Audio', clips: [] },
    ],
  };
}

/**
 * 12 — Podcast clip (9:16): a vertical episode share with a title band up top,
 * a centered waveform area (drop a waveform clip or leave the plate), and a
 * live-captions zone at the bottom. Episode audio ducks nothing but is fade-set.
 */
function buildPodcastClip(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  return {
    ...base('Podcast clip', RATIO.vertical),
    tracks: [
      { id: video, kind: 'video', name: 'Video', clips: [] },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Layout',
        clips: [
          {
            id: cid('titleband'),
            type: 'shape',
            name: 'Title band',
            start: 0,
            duration: 15,
            shape: 'rect',
            color: '#191c25',
            x: 0,
            y: 0.06,
            w: 1,
            h: 0.16,
          },
          {
            id: cid('show'),
            type: 'text',
            name: 'Show + episode',
            start: 0.3,
            duration: 14.4,
            text: 'THE SHOW · Ep. 42',
            fontSize: 0.034,
            color: '#ffffff',
            x: 0.5,
            y: 0.12,
            align: 'center',
            capPreset: 'plain',
            capPosition: 'top',
            animation: { in: { kind: 'fade', duration: 0.5 } },
          },
          {
            id: cid('wave'),
            type: 'shape',
            name: 'Waveform plate',
            start: 0,
            duration: 15,
            shape: 'circle',
            color: '#5b8cff',
            x: 0.28,
            y: 0.34,
            w: 0.44,
            h: 0.24,
            opacity: 0.18,
            animation: { in: { kind: 'zoom-in', duration: 0.8 } },
          },
          {
            id: cid('pull'),
            type: 'text',
            name: 'Pull quote',
            start: 0.6,
            duration: 14,
            text: '“the part everyone rewinds”',
            fontSize: 0.044,
            color: '#c8cede',
            x: 0.5,
            y: 0.46,
            align: 'center',
            animation: { in: { kind: 'fade', duration: 0.7 } },
          },
          {
            id: cid('capzone'),
            type: 'text',
            name: 'Captions zone',
            start: 1.0,
            duration: 6,
            text: 'Drop your episode below, then auto-caption from the Inspector — captions land here',
            fontSize: 0.03,
            color: '#8a90a0',
            x: 0.5,
            y: 0.82,
            align: 'center',
            capPreset: 'boxed',
            capPosition: 'lower',
            animation: {
              in: { kind: 'slide-up', duration: 0.5 },
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
            name: 'Episode audio',
            start: 0,
            duration: 15,
            src: '',
            volume: 1,
            fadeIn: 0.4,
            fadeOut: 1.2,
          },
        ],
      },
    ],
  };
}

/**
 * 13 — Intro sting (16:9): a short 5s logo/title stab — bars iris open, the
 * name pops, a tagline fades under it. Built to sit in front of anything.
 */
function buildIntroSting(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  return {
    ...base('Intro sting'),
    tracks: [
      { id: video, kind: 'video', name: 'Video', clips: [] },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Sting',
        clips: [
          {
            id: cid('bar'),
            type: 'shape',
            name: 'Accent bar',
            start: 0.3,
            duration: 4.2,
            shape: 'rect',
            color: '#a06bff',
            x: 0.35,
            y: 0.6,
            w: 0.3,
            h: 0.008,
            animation: {
              in: { kind: 'slide-right', duration: 0.4 },
              out: { kind: 'fade', duration: 0.4 },
            },
          },
          {
            id: cid('logo'),
            type: 'text',
            name: 'Logo / name',
            start: 0.5,
            duration: 4.0,
            text: 'STUDIO NAME',
            fontSize: 0.1,
            color: '#ffffff',
            x: 0.5,
            y: 0.46,
            align: 'center',
            capPreset: 'outline',
            capPosition: 'middle',
            animation: {
              in: { kind: 'pop', duration: 0.4 },
              out: { kind: 'zoom-out', duration: 0.4 },
            },
          },
          {
            id: cid('tag'),
            type: 'text',
            name: 'Tagline',
            start: 1.1,
            duration: 3.2,
            text: 'motion, made simple',
            fontSize: 0.036,
            color: '#9aa3b5',
            x: 0.5,
            y: 0.66,
            align: 'center',
            animation: {
              in: { kind: 'fade', duration: 0.6 },
              out: { kind: 'fade', duration: 0.5 },
            },
          },
        ],
      },
      {
        id: audio,
        kind: 'audio',
        name: 'Sting audio',
        clips: [
          {
            id: cid('whoosh'),
            type: 'audio',
            name: 'Whoosh / sting',
            start: 0,
            duration: 5,
            src: '',
            volume: 0.8,
            fadeOut: 0.6,
          },
        ],
      },
    ],
  };
}

/**
 * 14 — Outro CTA (16:9): the end card — subscribe line, a social handle, and
 * two placeholder "next video" tiles. Push transition wipes in the tiles.
 */
function buildOutroCTA(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  return {
    ...base('Outro CTA'),
    tracks: [
      { id: video, kind: 'video', name: 'Video', clips: [] },
      {
        id: overlay,
        kind: 'overlay',
        name: 'End card',
        clips: [
          {
            id: cid('thanks'),
            type: 'text',
            name: 'Thanks',
            start: 0.3,
            duration: 7.4,
            text: 'Thanks for watching',
            fontSize: 0.075,
            color: '#ffffff',
            x: 0.5,
            y: 0.16,
            align: 'center',
            animation: { in: { kind: 'slide-down', duration: 0.4 } },
          },
          {
            id: cid('tile1'),
            type: 'shape',
            name: 'Next video 1',
            start: 1.0,
            duration: 7.0,
            shape: 'rect',
            color: '#191c25',
            x: 0.14,
            y: 0.34,
            w: 0.3,
            h: 0.32,
            animation: {
              in: { kind: 'slide-up', duration: 0.4 },
              out: { kind: 'fade', duration: 0.4 },
            },
          },
          {
            id: cid('tile2'),
            type: 'shape',
            name: 'Next video 2',
            start: 1.3,
            duration: 6.7,
            shape: 'rect',
            color: '#191c25',
            x: 0.56,
            y: 0.34,
            w: 0.3,
            h: 0.32,
            animation: {
              in: { kind: 'slide-up', duration: 0.4 },
              out: { kind: 'fade', duration: 0.4 },
            },
          },
          {
            id: cid('subscribe'),
            type: 'text',
            name: 'Subscribe',
            start: 2.0,
            duration: 5.8,
            text: 'Subscribe · @yourchannel',
            fontSize: 0.048,
            color: '#0b0d12',
            x: 0.5,
            y: 0.82,
            align: 'center',
            capPreset: 'pill',
            capPosition: 'lower',
            animation: {
              in: { kind: 'pop', duration: 0.35 },
              out: { kind: 'fade', duration: 0.4 },
            },
          },
        ],
      },
      { id: audio, kind: 'audio', name: 'Outro music', clips: [] },
    ],
  };
}

/**
 * 15 — Event invite (4:5): a portrait save-the-date — event name, date/time
 * chip and venue line over a photo, framed for the feed. Slow, elegant fades.
 */
function buildEventInvite(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  return {
    ...base('Event invite', RATIO.portrait),
    tracks: [
      {
        id: video,
        kind: 'video',
        name: 'Background',
        clips: [
          {
            id: cid('photo'),
            type: 'image',
            name: 'Venue photo',
            start: 0,
            duration: 8,
            src: '',
            fit: 'cover',
            effects: [{ kind: 'vignette', amount: 0.5 }],
          },
        ],
      },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Invite',
        clips: [
          {
            id: cid('kicker'),
            type: 'text',
            name: 'Kicker',
            start: 0.3,
            duration: 7.4,
            text: 'YOU’RE INVITED',
            fontSize: 0.03,
            color: '#ffd700',
            x: 0.5,
            y: 0.18,
            align: 'center',
            capPreset: 'plain',
            capPosition: 'top',
            animation: { in: { kind: 'fade', duration: 0.6 } },
          },
          {
            id: cid('event'),
            type: 'text',
            name: 'Event name',
            start: 0.6,
            duration: 7.0,
            text: 'Summer Rooftop Social',
            fontSize: 0.066,
            color: '#ffffff',
            x: 0.5,
            y: 0.42,
            align: 'center',
            animation: {
              in: { kind: 'slide-up', duration: 0.5 },
              out: { kind: 'fade', duration: 0.6 },
            },
          },
          {
            id: cid('date'),
            type: 'text',
            name: 'Date chip',
            start: 1.2,
            duration: 6.4,
            text: 'SAT · AUG 24 · 7 PM',
            fontSize: 0.036,
            color: '#0b0d12',
            x: 0.5,
            y: 0.58,
            align: 'center',
            capPreset: 'pill',
            capPosition: 'middle',
            animation: { in: { kind: 'pop', duration: 0.4 } },
          },
          {
            id: cid('venue'),
            type: 'text',
            name: 'Venue',
            start: 1.6,
            duration: 6.0,
            text: 'The Terrace · 210 Vine St · RSVP in bio',
            fontSize: 0.03,
            color: '#c8cede',
            x: 0.5,
            y: 0.72,
            align: 'center',
            animation: {
              in: { kind: 'fade', duration: 0.6 },
              out: { kind: 'fade', duration: 0.6 },
            },
          },
        ],
      },
      { id: audio, kind: 'audio', name: 'Audio', clips: [] },
    ],
  };
}

/**
 * 16 — Cinematic trailer (21:9): a dramatic three-line title build on a
 * letterboxed ultrawide canvas, dissolves between shots, vignette on the
 * footage. Boom of a score, fades set.
 */
function buildCinematicTrailer(): VdzTimeline {
  const video = tid('video');
  const overlay = tid('overlay');
  const audio = tid('audio');
  const s1 = cid('shot1');
  const s2 = cid('shot2');
  return {
    ...base('Cinematic trailer', RATIO.cinema),
    tracks: [
      {
        id: video,
        kind: 'video',
        name: 'Footage',
        clips: [
          {
            id: s1,
            type: 'video',
            name: 'Shot 1',
            start: 0,
            duration: 4,
            src: '',
            trimStart: 0,
            volume: 0.3,
            effects: [{ kind: 'vignette', amount: 0.6 }],
          },
          {
            id: s2,
            type: 'video',
            name: 'Shot 2',
            start: 4,
            duration: 4,
            src: '',
            trimStart: 0,
            volume: 0.3,
            effects: [{ kind: 'vignette', amount: 0.6 }],
          },
          {
            id: cid('shot3'),
            type: 'video',
            name: 'Shot 3',
            start: 8,
            duration: 4,
            src: '',
            trimStart: 0,
            volume: 0.3,
            effects: [{ kind: 'vignette', amount: 0.6 }],
          },
        ],
        transitions: [
          {
            id: `dis-${nanoid(4)}`,
            kind: 'dissolve',
            afterClipId: s1,
            duration: 0.8,
          },
          {
            id: `dis-${nanoid(4)}`,
            kind: 'dissolve',
            afterClipId: s2,
            duration: 0.8,
          },
        ],
      },
      {
        id: overlay,
        kind: 'overlay',
        name: 'Title build',
        clips: [
          {
            id: cid('line1'),
            type: 'text',
            name: 'Line 1',
            start: 0.6,
            duration: 3.0,
            text: 'IN A WORLD',
            fontSize: 0.09,
            color: '#ffffff',
            x: 0.5,
            y: 0.44,
            align: 'center',
            capPreset: 'shadow',
            capPosition: 'middle',
            animation: {
              in: { kind: 'fade', duration: 0.8 },
              out: { kind: 'fade', duration: 0.6 },
            },
          },
          {
            id: cid('line2'),
            type: 'text',
            name: 'Line 2',
            start: 4.4,
            duration: 3.0,
            text: 'ONE EDITOR',
            fontSize: 0.09,
            color: '#ffffff',
            x: 0.5,
            y: 0.44,
            align: 'center',
            capPreset: 'shadow',
            capPosition: 'middle',
            animation: {
              in: { kind: 'fade', duration: 0.8 },
              out: { kind: 'fade', duration: 0.6 },
            },
          },
          {
            id: cid('title'),
            type: 'text',
            name: 'Title',
            start: 8.4,
            duration: 3.4,
            text: 'THE FINAL CUT',
            fontSize: 0.12,
            color: '#ffd700',
            x: 0.5,
            y: 0.44,
            align: 'center',
            capPreset: 'outline',
            capPosition: 'middle',
            animation: {
              in: { kind: 'zoom-in', duration: 1.0 },
              out: { kind: 'fade', duration: 0.6 },
            },
          },
          {
            id: cid('date'),
            type: 'text',
            name: 'Release',
            start: 9.4,
            duration: 2.4,
            text: 'THIS FALL',
            fontSize: 0.04,
            color: '#c8cede',
            x: 0.5,
            y: 0.6,
            align: 'center',
            animation: {
              in: { kind: 'fade', duration: 0.6 },
              out: { kind: 'fade', duration: 0.6 },
            },
          },
        ],
      },
      {
        id: audio,
        kind: 'audio',
        name: 'Score',
        clips: [
          {
            id: cid('score'),
            type: 'audio',
            name: 'Trailer score',
            start: 0,
            duration: 12,
            src: '',
            volume: 0.9,
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
    category: 'Intro & Outro',
    accent: ['#5b8cff', '#a06bff'],
    emoji: '🎬',
    build: buildBoldIntro,
  },
  {
    id: 'lower-third',
    name: 'Lower third',
    description: 'Interview name bar, ready to retype.',
    category: 'Explainer',
    accent: ['#3fb7a6', '#5b8cff'],
    emoji: '🎤',
    build: buildLowerThird,
  },
  {
    id: 'slideshow',
    name: 'Photo slideshow',
    description: 'Three stills, crossfades, captions.',
    category: 'Slideshow',
    accent: ['#ffd700', '#ff6b6b'],
    emoji: '🖼️',
    build: buildSlideshow,
  },
  {
    id: 'social-hook',
    name: 'Social hook',
    description: 'Four punchy cards that pop in sequence.',
    category: 'Social',
    accent: ['#ff6b6b', '#a06bff'],
    emoji: '⚡',
    build: buildSocialHook,
  },
  {
    id: 'audiogram',
    name: 'Podcast audiogram',
    description: 'Episode + captions teaser, fades preset.',
    category: 'Podcast',
    accent: ['#191c25', '#3fb7a6'],
    emoji: '🎙️',
    build: buildAudiogram,
  },
  {
    id: 'reel-hook',
    name: 'Reel hook',
    description: 'Vertical text beats that snap the scroll.',
    category: 'Social',
    accent: ['#ff6b6b', '#ffd700'],
    emoji: '📱',
    build: buildReelHook,
  },
  {
    id: 'tiktok-promo',
    name: 'TikTok promo',
    description: 'Vertical product push with scrim + CTA.',
    category: 'Promo',
    accent: ['#3fb7a6', '#0b0d12'],
    emoji: '🛍️',
    build: buildTikTokPromo,
  },
  {
    id: 'product-card',
    name: 'Square product card',
    description: 'Framed 1:1 product still, name + price chip.',
    category: 'Promo',
    accent: ['#5b8cff', '#3fb7a6'],
    emoji: '🟦',
    build: buildProductCard,
  },
  {
    id: 'sale-countdown',
    name: 'Sale countdown',
    description: 'Big discount, urgency line, promo code.',
    category: 'Promo',
    accent: ['#ff6b6b', '#ffd700'],
    emoji: '⏰',
    build: buildSaleCountdown,
  },
  {
    id: 'feature-trio',
    name: 'Feature trio',
    description: 'Title + three benefit rows that stack in.',
    category: 'Explainer',
    accent: ['#5b8cff', '#a06bff'],
    emoji: '📊',
    build: buildFeatureTrio,
  },
  {
    id: 'quote-card',
    name: 'Quote card',
    description: 'Centered pull-quote with attribution, 1:1.',
    category: 'Social',
    accent: ['#a06bff', '#5b8cff'],
    emoji: '❝',
    build: buildQuoteCard,
  },
  {
    id: 'podcast-clip',
    name: 'Podcast clip',
    description: 'Vertical episode share, title + caption zone.',
    category: 'Podcast',
    accent: ['#191c25', '#5b8cff'],
    emoji: '🎧',
    build: buildPodcastClip,
  },
  {
    id: 'intro-sting',
    name: 'Intro sting',
    description: 'Short 5s logo stab to front any video.',
    category: 'Intro & Outro',
    accent: ['#a06bff', '#ff6b6b'],
    emoji: '✨',
    build: buildIntroSting,
  },
  {
    id: 'outro-cta',
    name: 'Outro CTA',
    description: 'End card: subscribe + two next-video tiles.',
    category: 'Intro & Outro',
    accent: ['#3fb7a6', '#5b8cff'],
    emoji: '👋',
    build: buildOutroCTA,
  },
  {
    id: 'event-invite',
    name: 'Event invite',
    description: 'Portrait 4:5 save-the-date with date chip.',
    category: 'Social',
    accent: ['#ffd700', '#a06bff'],
    emoji: '🎉',
    build: buildEventInvite,
  },
  {
    id: 'cinematic-trailer',
    name: 'Cinematic trailer',
    description: 'Ultrawide 21:9 title build, dissolves + vignette.',
    category: 'Cinematic',
    accent: ['#0b0d12', '#a06bff'],
    emoji: '🎞️',
    build: buildCinematicTrailer,
  },
];
