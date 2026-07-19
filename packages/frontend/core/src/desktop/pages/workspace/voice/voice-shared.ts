// ---------------------------------------------------------------------------
// ClickDz Voice Studio — shared types, palette and pure helpers.
//
// Plain `.ts` (NO JSX, NO vanilla-extract) so it may export functions freely
// (a .css.ts must only export style values — house rule). The page and every
// tab component import from here. Everything below is framework-agnostic and
// side-effect free except the `fetch` wrappers, which hit the ClickDz backend
// voice routes via `cdzApiUrl` (same mechanism the Integrations page uses to
// reach /api/v1/*).
//
// C3 (VOICE STUDIO): the type shapes below mirror the BRIDGE-BE voice contract
// EXACTLY — GET /api/voice/capabilities returns per-provider
// `{ voices, defaultVoice, supportsSpeed, supportsInstructions, models,
//    defaultModel, instructionModels?, formats, cloning }` plus a top-level
// `cloning:{ supported:false, reason }` and `tts:{ formats, defaultFormat }`.
// POST /api/voice/tts accepts `{ text, provider?, voice?, model?, speed?,
// instructions?, format? }` and streams the audio body back. The Studio renders
// all controls FROM the capabilities payload — nothing about voices/models is
// hardcoded here.
// ---------------------------------------------------------------------------
import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';

// A single per-word timing as returned by the transcribe route (absolute
// audio seconds). Mirrors the backend contract `{ w, t0, t1 }`.
export interface VoiceWord {
  w: string;
  t0: number;
  t1: number;
}

// The transcribe route's response: `{ text, words?, language? }`.
export interface TranscribeResult {
  text: string;
  words?: VoiceWord[];
  language?: string;
}

export type TtsProviderId = 'deepgram' | 'openai';

// One provider's advertised capability, from GET /api/voice/capabilities.
// Kept a superset of the historical shape (id/label/available/voices/
// defaultVoice/supportsSpeed) so nothing regresses; the C3 additive fields are
// optional so a legacy payload still parses.
export interface TtsProviderCap {
  id: TtsProviderId;
  label: string;
  available: boolean;
  voices: string[];
  defaultVoice: string;
  supportsSpeed: boolean;
  // C3 additive — free-text emotion/prosody steering (OpenAI gpt-4o-mini-tts).
  supportsInstructions?: boolean;
  // C3 additive — selectable TTS models (empty for single-model providers).
  models?: string[];
  defaultModel?: string | null;
  // Subset of `models` that actually honour `instructions`.
  instructionModels?: string[];
  // Output formats this provider advertises (keys of the shared format table).
  formats?: string[];
  cloning?: CloningInfo;
}

// Honest cloning verdict (both providers report supported:false + a reason).
export interface CloningInfo {
  supported: boolean;
  reason?: string;
}

export interface VoiceCapabilities {
  transcription: {
    available: boolean;
    provider: string;
    model: string;
    models?: string[];
  };
  // Top-level cloning block (BRIDGE-BE surfaces it here too).
  cloning?: CloningInfo;
  tts: {
    defaultProvider: TtsProviderId;
    providers: TtsProviderCap[];
    // C3 additive — advertised output formats + default (default first).
    formats?: string[];
    defaultFormat?: string;
  };
}

// One saved generation for the Studio history (localStorage-backed). Extended
// with the C3 fields so a history row can be replayed with the exact request.
export interface GenerationHistoryItem {
  id: string;
  text: string;
  provider: TtsProviderId;
  voice: string;
  speed?: number;
  // C3 additive:
  model?: string | null;
  instructions?: string;
  format?: string;
  createdAt: number;
}

// Max characters accepted by a text field (matches the UI counter).
export const TTS_MAX_CHARS = 2_000;
// Max characters for the free-text instructions/style field (matches the
// backend MAX_TTS_INSTRUCTIONS_CHARS cap of 1000).
export const TTS_MAX_INSTRUCTIONS = 1_000;
// Pseudo-realtime chunk length for the Transcribe tab (seconds of audio per
// sequential POST). 4s balances latency vs. Whisper accuracy on short chunks.
export const REALTIME_CHUNK_SECONDS = 4;
// Cap on stored history rows (localStorage key below).
export const HISTORY_LIMIT = 10;
export const HISTORY_STORAGE_KEY = 'cdz:voice-studio:history';

// Emotion / style quick-presets. Each fills the free-text instructions field
// (only enabled when the active provider/model supportsInstructions). Free-form
// text is always allowed too — these are just one-tap starting points.
export const EMOTION_PRESETS: Array<{ label: string; instructions: string }> = [
  {
    label: 'Calm',
    instructions:
      'Speak in a calm, warm and reassuring tone, unhurried, with gentle pacing.',
  },
  {
    label: 'Excited',
    instructions:
      'Speak with high energy and genuine excitement, upbeat and enthusiastic, slightly faster pacing.',
  },
  {
    label: 'Narrator',
    instructions:
      'Speak like a professional audiobook narrator: clear, expressive and engaging, with natural storytelling rhythm.',
  },
  {
    label: 'Newsreader',
    instructions:
      'Speak like a confident broadcast news anchor: crisp, authoritative and neutral, with measured pacing.',
  },
  {
    label: 'Whisper',
    instructions:
      'Speak in a soft, intimate whisper, breathy and quiet, as if sharing a secret.',
  },
  {
    label: 'Cheerful',
    instructions:
      'Speak in a bright, friendly and cheerful tone, smiling through the words, welcoming and positive.',
  },
];

// Dark, app-consistent palette — each value an --affine-* var with a hard dark
// fallback so the page reads correctly before theme vars load. Identical shape
// to the Integrations page's `C` const (house palette convention).
export const C = {
  bg: 'var(--affine-background-primary-color, #141414)',
  panel: 'var(--affine-background-secondary-color, #1c1c1e)',
  panel2: 'var(--affine-background-tertiary-color, #232325)',
  border: 'var(--affine-border-color, #2a2a2c)',
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  accentSoft:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  warnBg: 'color-mix(in srgb, #e8a33d 12%, transparent)',
  warnBorder: 'color-mix(in srgb, #e8a33d 40%, transparent)',
  errBg:
    'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 12%, transparent)',
  errBorder:
    'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 40%, transparent)',
  errText: 'var(--affine-error-color, #eb4b4b)',
  okText: 'var(--affine-success-color, #4cae4c)',
  recording: '#eb4b4b',
} as const;

// -------------------------------------------------------------------------
// Backend calls
// -------------------------------------------------------------------------

/**
 * Fetch provider availability + capability metadata. Never throws for a "not
 * configured" state — the backend always answers 200 with `available:false`
 * flags; a network failure returns `null` so the caller can show a retry
 * affordance. The returned object drives every control in the Studio.
 */
export async function fetchVoiceCapabilities(): Promise<VoiceCapabilities | null> {
  try {
    const res = await fetch(cdzApiUrl('/api/voice/capabilities'), {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as VoiceCapabilities;
  } catch {
    return null;
  }
}

// Discriminated result for a transcription attempt so the UI can branch on the
// failure reason (unavailable provider vs. bad audio vs. transient error).
export type TranscribeOutcome =
  | { ok: true; result: TranscribeResult }
  | { ok: false; reason: 'unavailable' | 'bad_audio' | 'error' };

/**
 * POST raw audio bytes to the transcribe route (application/octet-stream, per
 * the vdz idiom). `mime` and `name` are passed as query hints. A 501
 * provider_unavailable maps to `reason:'unavailable'`; a 400 to `bad_audio`.
 */
export async function transcribeAudio(
  blob: Blob,
  mime: string,
  name: string
): Promise<TranscribeOutcome> {
  const q = new URLSearchParams();
  if (mime) q.set('mime', mime);
  if (name) q.set('name', name);
  const url = cdzApiUrl(`/api/voice/transcribe?${q.toString()}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    if (res.status === 501) return { ok: false, reason: 'unavailable' };
    if (res.status === 400) return { ok: false, reason: 'bad_audio' };
    if (!res.ok) return { ok: false, reason: 'error' };
    const data = (await res.json()) as TranscribeResult;
    return {
      ok: true,
      result: {
        text: typeof data.text === 'string' ? data.text : '',
        words: Array.isArray(data.words) ? data.words : undefined,
        language:
          typeof data.language === 'string' ? data.language : undefined,
      },
    };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

export type TtsOutcome =
  | { ok: true; url: string; blob: Blob }
  | { ok: false; reason: 'unavailable' | 'error' };

// Request params for a single TTS synthesis. Mirrors the backend body exactly:
// `{ text, provider?, voice?, model?, speed?, instructions?, format? }`.
export interface TtsRequest {
  text: string;
  provider: TtsProviderId;
  voice: string;
  model?: string | null;
  speed?: number;
  instructions?: string;
  format?: string;
}

// Map a format key to the Accept header / expected content-type (matches the
// backend VOICE_TTS_FORMATS table). Unknown -> mp3.
export function contentTypeForFormat(format?: string): string {
  switch (format) {
    case 'opus':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    case 'mp3':
    default:
      return 'audio/mpeg';
  }
}

// File extension for a format key (for download filenames). Unknown -> mp3.
export function extForFormat(format?: string): string {
  switch (format) {
    case 'opus':
      return 'opus';
    case 'aac':
      return 'aac';
    case 'flac':
      return 'flac';
    case 'wav':
      return 'wav';
    case 'mp3':
    default:
      return 'mp3';
  }
}

/**
 * POST a TTS request. On success returns an object URL for the audio plus the
 * raw Blob (caller owns revoking the URL). A 501 maps to `unavailable`.
 *
 * The body is EXACTLY the BRIDGE-BE contract: only fields that are meaningful
 * are sent (e.g. `instructions`/`model` omitted for providers that don't accept
 * them, `speed` omitted when the provider doesn't support it), so a Deepgram
 * request stays byte-identical to the historical `{ text, provider, voice }`.
 */
export async function synthesizeSpeech(params: TtsRequest): Promise<TtsOutcome> {
  try {
    const body: Record<string, unknown> = {
      text: params.text,
      provider: params.provider,
      voice: params.voice,
    };
    if (typeof params.model === 'string' && params.model) {
      body.model = params.model;
    }
    if (typeof params.speed === 'number' && Number.isFinite(params.speed)) {
      body.speed = params.speed;
    }
    if (
      typeof params.instructions === 'string' &&
      params.instructions.trim()
    ) {
      body.instructions = params.instructions.trim().slice(0, TTS_MAX_INSTRUCTIONS);
    }
    if (typeof params.format === 'string' && params.format) {
      body.format = params.format;
    }
    const res = await fetch(cdzApiUrl('/api/voice/tts'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: contentTypeForFormat(params.format),
      },
      body: JSON.stringify(body),
    });
    if (res.status === 501) return { ok: false, reason: 'unavailable' };
    if (!res.ok) return { ok: false, reason: 'error' };
    const blob = await res.blob();
    if (!blob || blob.size === 0) return { ok: false, reason: 'error' };
    return { ok: true, url: URL.createObjectURL(blob), blob };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// -------------------------------------------------------------------------
// Pure formatting / export helpers
// -------------------------------------------------------------------------

/** Words in a string, ignoring extra whitespace. Empty string => 0. */
export function countWords(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/** `M:SS` for a duration in seconds (used for recording + audio length). */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

/** `HH:MM:SS,mmm` SRT timestamp for an absolute number of seconds. */
export function srtTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const ms = Math.round(clamped * 1000);
  const hh = Math.floor(ms / 3_600_000);
  const mm = Math.floor((ms % 3_600_000) / 60_000);
  const ss = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const p2 = (n: number) => n.toString().padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)},${millis.toString().padStart(3, '0')}`;
}

/**
 * Group aligned words into readable caption cues. A new cue starts when the
 * current one reaches ~`maxWords` words OR ~`maxSeconds` of span, or after a
 * sentence-ending token. Returns `{ start, end, text }[]` (absolute seconds).
 */
export function wordsToCues(
  words: VoiceWord[],
  maxWords = 10,
  maxSeconds = 6
): Array<{ start: number; end: number; text: string }> {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  let bucket: VoiceWord[] = [];
  const flush = () => {
    if (!bucket.length) return;
    const start = bucket[0].t0;
    const end = bucket[bucket.length - 1].t1;
    const text = bucket
      .map(w => w.w)
      .join(' ')
      .replace(/\s+([,.!?;:])/g, '$1')
      .trim();
    if (text) cues.push({ start, end: Math.max(end, start + 0.2), text });
    bucket = [];
  };
  for (const word of words) {
    bucket.push(word);
    const span = bucket[bucket.length - 1].t1 - bucket[0].t0;
    const endsSentence = /[.!?]$/.test(word.w.trim());
    if (bucket.length >= maxWords || span >= maxSeconds || endsSentence) {
      flush();
    }
  }
  flush();
  return cues;
}

/**
 * Sentence-split fallback when there are no word timings: distribute the plain
 * text across evenly-spaced cues over `totalSeconds` (a best-effort SRT so the
 * Download .srt action always produces something usable).
 */
export function textToCues(
  text: string,
  totalSeconds: number
): Array<{ start: number; end: number; text: string }> {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!sentences.length) return [];
  // Weight each cue's duration by its share of the total character count so a
  // long sentence gets more screen time than a short one.
  const totalChars = sentences.reduce((n, s) => n + s.length, 0) || 1;
  const span = totalSeconds > 0 ? totalSeconds : sentences.length * 3;
  let cursor = 0;
  return sentences.map(s => {
    const dur = Math.max(1, (s.length / totalChars) * span);
    const start = cursor;
    const end = cursor + dur;
    cursor = end;
    return { start, end, text: s };
  });
}

/** Serialize cues to an SRT document (blank line between cues, trailing NL). */
export function cuesToSrt(
  cues: Array<{ start: number; end: number; text: string }>
): string {
  return (
    cues
      .map(
        (cue, i) =>
          `${i + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(
            cue.end
          )}\n${cue.text}`
      )
      .join('\n\n') + '\n'
  );
}

/** Trigger a client-side download of a text blob (no server round-trip). */
export function downloadTextFile(
  filename: string,
  content: string,
  mime = 'text/plain'
): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has resolved.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Trigger a client-side download of an already-materialized Blob. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Concatenate multiple audio Blobs client-side into ONE downloadable Blob.
 *
 * For container-less / frame-concatenatable codecs (mp3, aac, flac frames, wav
 * PCM data), byte-concatenation yields a file most players play end-to-end.
 * This is intentionally a "good enough" export for the multi-segment studio —
 * we keep the MIME of the first blob and simply append the raw bytes. Callers
 * that need sample-accurate stitching can still download segments individually.
 */
export function concatBlobs(blobs: Blob[], mime: string): Blob {
  return new Blob(blobs, { type: mime || 'audio/mpeg' });
}

/**
 * Pick a MediaRecorder mime the current browser supports, preferring formats
 * Whisper handles well. Returns '' when MediaRecorder can't be used at all.
 */
export function pickRecorderMime(): string {
  if (
    typeof MediaRecorder === 'undefined' ||
    typeof MediaRecorder.isTypeSupported !== 'function'
  ) {
    return '';
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

/** A short filename hint for an upload, derived from a source name + mime. */
export function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a')) return 'mp4';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'audio';
}

/**
 * Prettify a raw voice id for display. Deepgram ids look like
 * `aura-2-thalia-en` -> "Thalia (en)"; OpenAI ids are single words -> "Alloy".
 */
export function formatVoiceLabel(id: string): string {
  if (!id) return '';
  const auraMatch = /^aura-\d+-([a-z]+)-([a-z]{2})$/.exec(id);
  if (auraMatch) {
    const name = auraMatch[1];
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} (${auraMatch[2]})`;
  }
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Prettify a model id for display (e.g. `gpt-4o-mini-tts` -> "GPT-4o mini"). */
export function formatModelLabel(id: string): string {
  if (!id) return '';
  switch (id) {
    case 'gpt-4o-mini-tts':
      return 'GPT-4o mini TTS (steerable)';
    case 'tts-1':
      return 'TTS-1 (fast)';
    case 'tts-1-hd':
      return 'TTS-1 HD';
    default:
      return id;
  }
}

/** Read the history array from localStorage (fail-soft to []). */
export function readHistory(): GenerationHistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is GenerationHistoryItem =>
          !!r &&
          typeof (r as GenerationHistoryItem).text === 'string' &&
          typeof (r as GenerationHistoryItem).id === 'string'
      )
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** Persist history (capped), fail-soft (quota / disabled storage). */
export function writeHistory(items: GenerationHistoryItem[]): void {
  try {
    localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify(items.slice(0, HISTORY_LIMIT))
    );
  } catch {
    // ignore — history is a convenience, never load-bearing
  }
}
