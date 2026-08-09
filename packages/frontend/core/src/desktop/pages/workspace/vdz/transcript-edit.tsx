import { memo, useCallback, useMemo, useState } from 'react';

import type { VdzOp, VdzTimeline } from '../../../../modules/vdz';
import {
  type VdzClipWord,
  type VdzTranscribableClip,
  useVdzTranscript,
} from '../../../../modules/vdz/use-vdz-transcript';
import { formatTimecode } from './constants';
import * as tcs from './transcript.css';

/**
 * Transcript-edit — the Descript-style editor for a selected VIDEO/AUDIO clip.
 *
 * Transcribe the clip once (the words are cached in the project side-store),
 * then the transcript renders as sentences you can read, hover, select and
 * delete. Deleting a sentence — or a picked word-span — CUTS the underlying clip
 * on the timeline (splitClip → splitClip → rippleDelete, one undo) and reflows
 * the transcript to the survivors. All timeline mutation routes through the
 * host's `onOps` (= the editor's `runBatch` history path); this component never
 * mutates the timeline directly.
 *
 * This is a SEPARATE mode from the caption/overlay-text list (that stays exactly
 * as it was) — it operates on the source media clip, not on overlay text clips.
 */

/** Times shown/stored here are MEDIA seconds (relative to the source media head). */

/** A run of words the UI treats as one deletable unit. */
interface Sentence {
  /** Index of the first word (into the flat `words` array). */
  from: number;
  /** Index AFTER the last word. */
  to: number;
  /** Media-time start of the first word. */
  t0: number;
  /** Media-time end of the last word. */
  t1: number;
  text: string;
}

/**
 * Group flat words into sentences: break after terminal punctuation (`.?!…`) or
 * a conversational gap (a silence longer than {@link SENTENCE_GAP}); also cap a
 * runaway sentence at {@link MAX_SENTENCE_WORDS} so a punctuation-free monologue
 * still reads as tidy blocks. Pure — derived from the words alone.
 */
const SENTENCE_GAP = 0.7;
const MAX_SENTENCE_WORDS = 24;

function groupSentences(words: VdzClipWord[]): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  const flush = (end: number) => {
    if (end <= start) return;
    const slice = words.slice(start, end);
    out.push({
      from: start,
      to: end,
      t0: slice[0].t0,
      t1: slice[slice.length - 1].t1,
      text: slice.map(w => w.w).join(' ').replace(/\s+([,.;:!?…])/g, '$1'),
    });
    start = end;
  };
  for (let i = 0; i < words.length; i++) {
    const cur = words[i];
    const next = words[i + 1];
    const terminal = /[.!?…]["')\]]?$/.test(cur.w.trim());
    const gap = next ? next.t0 - cur.t1 : 0;
    const tooLong = i - start + 1 >= MAX_SENTENCE_WORDS;
    if (terminal || (next && gap >= SENTENCE_GAP) || tooLong) {
      flush(i + 1);
    }
  }
  flush(words.length);
  return out;
}

/** The clip's media in-point (video carries `trimStart`; audio has none → 0). */
function clipTrimStart(clip: VdzTranscribableClip): number {
  return clip.type === 'video' ? (clip.trimStart ?? 0) : 0;
}

interface SentenceBlockProps {
  sentence: Sentence;
  words: VdzClipWord[];
  /** Media time of the playhead within this clip, or null when outside it. */
  mediaPlayhead: number | null;
  /** [from,to) of the current word-span pick, or null. */
  pick: { from: number; to: number } | null;
  onWordDown: (index: number, shiftKey: boolean) => void;
  onWordEnter: (index: number, buttonsDown: boolean) => void;
  onSeekWord: (word: VdzClipWord) => void;
  onCut: (sentence: Sentence) => void;
}

const SentenceBlock = memo(function SentenceBlock({
  sentence,
  words,
  mediaPlayhead,
  pick,
  onWordDown,
  onWordEnter,
  onSeekWord,
  onCut,
}: SentenceBlockProps) {
  const active =
    mediaPlayhead !== null &&
    mediaPlayhead >= sentence.t0 &&
    mediaPlayhead < sentence.t1;

  return (
    <div className={tcs.sentence} data-active={active}>
      <span
        className={tcs.timeChip}
        title="Sauter la tête de lecture à cette phrase"
        onClick={() => onSeekWord(words[sentence.from])}
        role="button"
      >
        {formatTimecode(sentence.t0)}
      </span>
      <span className={tcs.sentenceWords}>
        {words.slice(sentence.from, sentence.to).map((w, i) => {
          const index = sentence.from + i;
          const playing =
            mediaPlayhead !== null &&
            mediaPlayhead >= w.t0 &&
            mediaPlayhead < w.t1;
          const picked = pick !== null && index >= pick.from && index < pick.to;
          return (
            <span key={index}>
              <span
                className={tcs.word}
                data-playing={playing}
                data-picked={picked}
                title={`${formatTimecode(w.t0)} · cliquer pour sélectionner, Maj+clic pour étendre`}
                onMouseDown={e => {
                  // Left button only; keep text selection working otherwise.
                  if (e.button !== 0) return;
                  onWordDown(index, e.shiftKey);
                }}
                onMouseEnter={e => onWordEnter(index, e.buttons === 1)}
                onDoubleClick={() => onSeekWord(w)}
              >
                {w.w}
              </span>
              {i < sentence.to - sentence.from - 1 ? ' ' : ''}
            </span>
          );
        })}
      </span>
      <button
        type="button"
        className={tcs.cutBtn}
        title="Delete this sentence and cut the clip"
        aria-label="Delete this sentence and cut the clip"
        onClick={() => onCut(sentence)}
      >
        ✕
      </button>
    </div>
  );
});

export interface TranscriptEditProps {
  /** The selected video/audio clip (the source media to transcribe + cut). */
  clip: VdzTranscribableClip;
  /** The track that holds the clip (for the cut ops). */
  trackId: string;
  /** The live timeline — used to map the playhead + re-derive sub-clip ids. */
  timeline: VdzTimeline;
  /** Playhead in timeline seconds (drives the karaoke-style word highlight). */
  playheadSeconds: number;
  /** Seek the playhead (word/sentence click) — takes TIMELINE seconds. */
  onSeek: (seconds: number) => void;
  /** Commit a batch of ops as ONE undo (the editor's `runBatch`). */
  onOps: (ops: VdzOp[]) => boolean;
}

/**
 * The clip-transcript editor body. Owns the transcript hook (transcribe / load
 * / cut) and the local word-span selection; renders the Transcribe CTA and,
 * once words exist, the sentence flow with hover + delete + selection cut.
 */
export function TranscriptEdit({
  clip,
  timeline,
  playheadSeconds,
  onSeek,
  onOps,
}: TranscriptEditProps) {
  const { busy, loading, error, ready, words, transcribe, cutSentence } =
    useVdzTranscript(clip, timeline, onOps);

  // Local word-span selection [from,to), independent of the clip transcript.
  const [pick, setPick] = useState<{ from: number; to: number } | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);

  const sentences = useMemo(() => groupSentences(words ?? []), [words]);

  // Map the playhead (timeline seconds) into this clip's MEDIA time, or null
  // when the playhead is outside the clip window (so nothing highlights).
  const mediaPlayhead = useMemo(() => {
    const start = clip.start;
    const end = clip.start + clip.duration;
    if (playheadSeconds < start || playheadSeconds >= end) return null;
    return playheadSeconds - start + clipTrimStart(clip);
  }, [playheadSeconds, clip]);

  // Media time → timeline seconds (for seeking to a word).
  const seekToMedia = useCallback(
    (mediaTime: number) => {
      const t = clip.start + (mediaTime - clipTrimStart(clip));
      onSeek(Math.max(0, t));
    },
    [clip, onSeek]
  );

  const onTranscribe = useCallback(() => {
    void transcribe().catch(() => {
      // error is surfaced by the hook's `error`; nothing else to do here.
    });
  }, [transcribe]);

  // --- Word-span selection (click, shift-click, click-drag) ---------------
  const onWordDown = useCallback((index: number, shiftKey: boolean) => {
    setAnchor(prev => {
      if (shiftKey && prev !== null) {
        setPick({ from: Math.min(prev, index), to: Math.max(prev, index) + 1 });
        return prev;
      }
      setPick({ from: index, to: index + 1 });
      return index;
    });
  }, []);

  const onWordEnter = useCallback(
    (index: number, buttonsDown: boolean) => {
      if (!buttonsDown || anchor === null) return;
      setPick({
        from: Math.min(anchor, index),
        to: Math.max(anchor, index) + 1,
      });
    },
    [anchor]
  );

  const clearPick = useCallback(() => {
    setPick(null);
    setAnchor(null);
  }, []);

  // --- Cut actions --------------------------------------------------------
  const cutRange = useCallback(
    (t0: number, t1: number) => {
      const ok = cutSentence(clip, { t0, t1 });
      if (ok) clearPick();
    },
    [cutSentence, clip, clearPick]
  );

  const onCutSentence = useCallback(
    (sentence: Sentence) => cutRange(sentence.t0, sentence.t1),
    [cutRange]
  );

  const onCutPick = useCallback(() => {
    if (!words || !pick) return;
    const first = words[pick.from];
    const last = words[pick.to - 1];
    if (!first || !last) return;
    cutRange(first.t0, last.t1);
  }, [words, pick, cutRange]);

  const pickInfo = useMemo(() => {
    if (!words || !pick) return null;
    const first = words[pick.from];
    const last = words[pick.to - 1];
    if (!first || !last) return null;
    const count = pick.to - pick.from;
    const dur = Math.max(0, last.t1 - first.t0);
    return `${count} word${count === 1 ? '' : 's'} · ${dur.toFixed(1)}s`;
  }, [words, pick]);

  const clipMeta = `${clip.type === 'video' ? 'Video' : 'Audio'} · ${formatTimecode(
    clip.duration
  )}`;

  return (
    <div>
      <div className={tcs.clipHeader}>
        <div className={tcs.clipTitle}>
          <span className={tcs.clipTitleName}>{clip.name ?? clip.type}</span>
          <span className={tcs.clipTitleMeta}>{clipMeta}</span>
        </div>
        <button
          type="button"
          className={tcs.transcribeBtn}
          onClick={onTranscribe}
          disabled={busy || !ready}
          title={
            !ready
              ? 'Le média est encore en cours de chargement…'
              : words && words.length > 0
                ? 'Retranscrire ce clip'
                : 'Transcrire ce clip avec la reconnaissance vocale'
          }
        >
          {busy ? (
            <>
              <span className={tcs.spinner} aria-hidden="true" />
              Transcription…
            </>
          ) : words && words.length > 0 ? (
            'Retranscrire'
          ) : (
            'Transcrire'
          )}
        </button>
      </div>

      {error ? (
        <div className={tcs.errorBar} role="alert">
          {error}
        </div>
      ) : null}

      {clip.type === 'audio' ? (
        <div className={tcs.clipTitleMeta} style={{ padding: '0 4px 8px' }}>
          Note: audio clips have no source in-point, so a mid-clip cut may shift
          the remaining audio. Cuts on video clips stay perfectly in sync.
        </div>
      ) : null}

      {loading ? (
        <div className={tcs.centerState}>
          <span className={tcs.spinner} aria-hidden="true" />
          Loading transcript…
        </div>
      ) : words && words.length > 0 ? (
        <>
          <div className={tcs.sentenceFlow} onMouseLeave={() => setAnchor(null)}>
            {sentences.map(s => (
              <SentenceBlock
                key={`${s.from}:${s.t0}`}
                sentence={s}
                words={words}
                mediaPlayhead={mediaPlayhead}
                pick={pick}
                onWordDown={onWordDown}
                onWordEnter={onWordEnter}
                onSeekWord={w => seekToMedia(w.t0)}
                onCut={onCutSentence}
              />
            ))}
          </div>
          {pick ? (
            <div className={tcs.selectionBar}>
              <span className={tcs.selectionInfo}>Sélection : {pickInfo}</span>
              <button
                type="button"
                className={tcs.selectionClear}
                onClick={clearPick}
              >
                Effacer
              </button>
              <button
                type="button"
                className={tcs.selectionCut}
                onClick={onCutPick}
                title="Supprimer les mots sélectionnés et couper le clip"
              >
                Couper la sélection
              </button>
            </div>
          ) : null}
        </>
      ) : busy ? (
        <div className={tcs.centerState}>
          <span className={tcs.spinner} aria-hidden="true" />
          Transcription de ce clip…
        </div>
      ) : (
        <div className={tcs.centerState}>
          <div>Aucune transcription pour ce clip pour le moment.</div>
          <div>
            Cliquez sur <b>Transcrire</b> pour transformer la parole en phrases modifiables —
            puis supprimez une phrase pour la couper du clip.
          </div>
        </div>
      )}
    </div>
  );
}
