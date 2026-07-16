/**
 * Waveform peaks for Vdz audio clips.
 *
 * Pure decode/downsample logic plus a module-level cache, kept free of React
 * (the hook/canvas live in audio-waveform.tsx). Peaks are computed ONCE per
 * durable clip src (`vdz-blob:<id>` or a remote URL) and reused across every
 * clip block, zoom level and re-render; the decode cost is one-time.
 *
 * Node-testable: nothing here touches `window`/`fetch` at module scope — the
 * browser bits are reached only inside `loadWaveform`.
 */

/** Peak buckets per second of audio (bounded below by MAX_PEAKS). */
export const PEAKS_PER_SECOND = 50;
/** Hard cap on bucket count so hour-long audio stays tiny in memory. */
export const MAX_PEAKS = 12000;

export interface VdzWaveform {
  /** Normalized 0..1 max-amplitude per bucket, over the WHOLE source. */
  peaks: Float32Array;
  /** Source duration in seconds. */
  duration: number;
}

/**
 * Downsample decoded PCM channels to per-bucket max-amplitude peaks.
 * Buckets span the whole buffer; amplitude is the max |sample| across all
 * channels in the bucket, clamped to 1 (hot masters can exceed unity).
 */
export function computePeaks(
  channels: Float32Array[],
  sampleRate: number
): VdzWaveform {
  const length = channels[0]?.length ?? 0;
  if (length === 0 || sampleRate <= 0 || channels.length === 0) {
    return { peaks: new Float32Array(0), duration: 0 };
  }
  const duration = length / sampleRate;
  const bucketCount = Math.min(
    MAX_PEAKS,
    Math.max(1, Math.round(duration * PEAKS_PER_SECOND))
  );
  const peaks = new Float32Array(bucketCount);
  const samplesPerBucket = length / bucketCount;
  for (let i = 0; i < bucketCount; i++) {
    const from = Math.floor(i * samplesPerBucket);
    const to = Math.min(length, Math.ceil((i + 1) * samplesPerBucket));
    let max = 0;
    for (const channel of channels) {
      for (let s = from; s < to; s++) {
        const v = Math.abs(channel[s]);
        if (v > max) max = v;
      }
    }
    peaks[i] = Math.min(1, max);
  }
  return { peaks, duration };
}

/**
 * The slice of a source waveform a CLIP displays. Audio clips always play the
 * source from its head (no audio trimStart in the schema today), so the window
 * is `[0, clipDuration]`: when the clip is shorter than the source only the
 * head fraction of the peaks is shown; when it is longer, the peaks stretch
 * over `sourceDuration/clipDuration` of the block and the tail is silence.
 */
export function windowPeakCount(
  waveform: VdzWaveform,
  clipDuration: number
): number {
  if (waveform.peaks.length === 0 || waveform.duration <= 0) return 0;
  const fraction = Math.min(1, clipDuration / waveform.duration);
  return Math.max(1, Math.round(waveform.peaks.length * fraction));
}

/** Fraction of the clip block the shown peaks occupy (1 unless clip > source). */
export function windowWidthFraction(
  waveform: VdzWaveform,
  clipDuration: number
): number {
  if (waveform.duration <= 0 || clipDuration <= 0) return 1;
  return Math.min(1, waveform.duration / clipDuration);
}

// ---- Cache + browser loader ------------------------------------------------

const cache = new Map<string, VdzWaveform>();
const inflight = new Map<string, Promise<VdzWaveform | null>>();

/** Synchronous cache peek (module-level, shared across all clip blocks). */
export function peekWaveform(cacheKey: string): VdzWaveform | undefined {
  return cache.get(cacheKey);
}

let sharedCtx: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  if (sharedCtx) return sharedCtx;
  try {
    type AudioContextCtor = typeof AudioContext;
    const Ctor =
      (globalThis as { AudioContext?: AudioContextCtor }).AudioContext ??
      (globalThis as { webkitAudioContext?: AudioContextCtor })
        .webkitAudioContext;
    if (!Ctor) return null;
    // A context created without a gesture starts suspended; decodeAudioData
    // still works on a suspended context (we never .play() through it).
    sharedCtx = new Ctor();
  } catch {
    return null;
  }
  return sharedCtx;
}

/**
 * Fetch + decode + downsample a clip's audio into cached peaks.
 *
 * `cacheKey` is the clip's DURABLE src (stable across sessions); `resolvedUrl`
 * is the live object/https URL it currently resolves to. Every failure mode
 * (CORS on remote audio, unsupported codec, no WebAudio) resolves to `null` —
 * the lane simply renders no waveform, never an error.
 */
export function loadWaveform(
  cacheKey: string,
  resolvedUrl: string
): Promise<VdzWaveform | null> {
  const hit = cache.get(cacheKey);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const task = (async (): Promise<VdzWaveform | null> => {
    try {
      const ctx = audioCtx();
      if (!ctx) return null;
      const res = await fetch(resolvedUrl);
      if (!res.ok) return null;
      const bytes = await res.arrayBuffer();
      const buffer = await ctx.decodeAudioData(bytes);
      const channels: Float32Array[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        channels.push(buffer.getChannelData(c));
      }
      const waveform = computePeaks(channels, buffer.sampleRate);
      if (waveform.peaks.length > 0) cache.set(cacheKey, waveform);
      return waveform.peaks.length > 0 ? waveform : null;
    } catch {
      return null;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, task);
  return task;
}
