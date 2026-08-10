// ---------------------------------------------------------------------------
// Voice Studio — "Transcribe" tab.
//
// Two capture paths onto the SAME OpenAI-Whisper transcribe route:
//  1. Live mic (pseudo-realtime): sequential ~4s self-contained recordings are
//     POSTed as they complete; finalized chunks render solid, the in-flight
//     chunk renders as a shimmering italic placeholder.
//  2. File upload: a single audio file -> one transcription (with word timings
//     when Whisper aligns them).
//
// Actions: Copy, Download .txt, Download .srt (built from word cues when
// present, else a sentence-split fallback). All inline-styled, dark palette.
// ---------------------------------------------------------------------------
import {
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useIsNarrow } from './use-voice-responsive';
import {
  analyzeVoice,
  C,
  countWords,
  cuesToSrt,
  downloadTextFile,
  extForMime,
  formatClock,
  pickRecorderMime,
  REALTIME_CHUNK_SECONDS,
  saveLibraryTranscript,
  textToCues,
  transcribeAudio,
  type VoiceAnalysis,
  type VoiceWord,
  wordsToCues,
} from './voice-shared';

type MicState =
  | 'idle'
  | 'unsupported'
  | 'denied'
  | 'recording'
  | 'finishing'
  | 'error';

interface FinalizedChunk {
  text: string;
  words: VoiceWord[];
  language?: string;
  // Absolute offset (seconds) of this chunk's head within the whole session,
  // so word timings can be rebased onto a single continuous timeline.
  offset: number;
}

export const TranscribeTab = ({ available }: { available: boolean }) => {
  const isPhone = useIsNarrow(480);
  // ---- shared transcript state (fed by BOTH mic + upload) ----
  const [chunks, setChunks] = useState<FinalizedChunk[]>([]);
  const [pending, setPending] = useState(false); // a chunk is transcribing
  const [language, setLanguage] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ---- playback + saved-transcript + analysis state ----
  // A local <audio> player lets a click on a word seek straight to that word's
  // timestamp. Fed by the file-upload path (object URL); mp3/wav/etc play
  // natively. Mic transcripts have no standalone audio file, so the player is
  // only shown when a playable source exists.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [analysis, setAnalysis] = useState<VoiceAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // ---- mic state ----
  const [micState, setMicState] = useState<MicState>('idle');
  const [elapsed, setElapsed] = useState(0);

  // ---- file-upload state ----
  const [uploading, setUploading] = useState(false);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Refs that drive the live-capture loop without re-rendering on each tick.
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const stoppingRef = useRef(false); // user asked to stop; don't relaunch
  const sessionOffsetRef = useRef(0); // running seconds across chunks
  const chunkMimeRef = useRef('audio/webm');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Detect a hard-unsupported environment once on mount.
  useEffect(() => {
    const hasMedia =
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof MediaRecorder !== 'undefined' &&
      !!pickRecorderMime();
    if (!hasMedia) setMicState('unsupported');
  }, []);

  // Cleanup on unmount: stop timers, recorder and the mic stream.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (chunkTimeoutRef.current) clearTimeout(chunkTimeoutRef.current);
      try {
        recorderRef.current?.stop();
      } catch {
        /* already stopped */
      }
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  // Revoke a replaced/cleared audio object URL when it changes or on unmount.
  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const setPlayableUrl = useCallback((url: string | null) => {
    if (audioUrlRef.current && audioUrlRef.current !== url) {
      URL.revokeObjectURL(audioUrlRef.current);
    }
    audioUrlRef.current = url;
    setAudioUrl(url);
  }, []);

  const fullText = useMemo(
    () => chunks.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim(),
    [chunks]
  );
  const allWords = useMemo(() => {
    const out: VoiceWord[] = [];
    for (const chunk of chunks) {
      for (const w of chunk.words) {
        out.push({ w: w.w, t0: w.t0 + chunk.offset, t1: w.t1 + chunk.offset });
      }
    }
    return out;
  }, [chunks]);
  const wordCount = useMemo(() => countWords(fullText), [fullText]);
  const durationSec = useMemo(() => {
    if (allWords.length) return allWords[allWords.length - 1].t1;
    return sessionOffsetRef.current || elapsed;
  }, [allWords, elapsed]);

  // POST one finished chunk blob; append its result on success. Runs in
  // parallel with the next chunk's recording so the transcript stays live.
  const sendChunk = useCallback(async (blob: Blob, offset: number) => {
    if (!blob || blob.size === 0) return;
    setPending(true);
    const mime = chunkMimeRef.current.split(';')[0] || 'audio/webm';
    const outcome = await transcribeAudio(
      blob,
      mime,
      `chunk.${extForMime(mime)}`
    );
    setPending(false);
    if (!outcome.ok) {
      if (outcome.reason === 'unavailable') {
        setNotice(
          'Transcription is unavailable — the OpenAI provider is not configured.'
        );
      } else if (outcome.reason === 'bad_audio') {
        // A silent/too-short chunk is normal in live mode; ignore quietly.
      } else {
        setNotice('A chunk failed to transcribe — recording continues.');
      }
      return;
    }
    const { result } = outcome;
    if (result.language) setLanguage(result.language);
    if (result.text.trim()) {
      setChunks(prev => [
        ...prev,
        {
          text: result.text.trim(),
          words: result.words ?? [],
          language: result.language,
          offset,
        },
      ]);
    }
  }, []);

  // Launch a single self-contained recording window. On stop it hands the blob
  // to sendChunk and — unless the user stopped — immediately relaunches.
  const launchWindow = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: chunkMimeRef.current });
    } catch {
      setMicState('error');
      return;
    }
    recorderRef.current = recorder;
    const parts: Blob[] = [];
    const windowOffset = sessionOffsetRef.current;
    recorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) parts.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(parts, { type: chunkMimeRef.current });
      // Advance the running clock by this window's nominal length.
      sessionOffsetRef.current = windowOffset + REALTIME_CHUNK_SECONDS;
      void sendChunk(blob, windowOffset);
      if (!stoppingRef.current) {
        launchWindow();
      } else {
        // Final window done -> release the mic + reset transient state.
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setMicState('idle');
      }
    };
    recorder.start();
    // Stop this window after the chunk length; onstop relaunches the next one.
    chunkTimeoutRef.current = setTimeout(() => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* ignore */
      }
    }, REALTIME_CHUNK_SECONDS * 1000);
  }, [sendChunk]);

  const startRecording = useCallback(async () => {
    if (micState === 'recording' || micState === 'unsupported') return;
    const mime = pickRecorderMime();
    if (!mime) {
      setMicState('unsupported');
      return;
    }
    setNotice(null);
    // Fresh session: clear the prior transcript so live + upload don't blend.
    setChunks([]);
    setLanguage(undefined);
    setElapsed(0);
    sessionOffsetRef.current = 0;
    stoppingRef.current = false;
    chunkMimeRef.current = mime;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = (e as { name?: string })?.name || '';
      setMicState(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'denied'
          : 'error'
      );
      return;
    }
    streamRef.current = stream;
    setMicState('recording');
    // Elapsed-time ticker (display only).
    timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
    launchWindow();
  }, [micState, launchWindow]);

  const stopRecording = useCallback(() => {
    if (micState !== 'recording') return;
    stoppingRef.current = true;
    setMicState('finishing');
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (chunkTimeoutRef.current) {
      clearTimeout(chunkTimeoutRef.current);
      chunkTimeoutRef.current = null;
    }
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      } else {
        setMicState('idle');
      }
    } catch {
      setMicState('idle');
    }
  }, [micState]);

  const onPickFile = useCallback(
    async (file: File) => {
      setNotice(null);
      setUploadName(file.name);
      setUploading(true);
      // A file upload is a fresh single-shot transcript.
      setChunks([]);
      setLanguage(undefined);
      setElapsed(0);
      sessionOffsetRef.current = 0;
      setSaved(false);
      setAnalysis(null);
      setAnalysisError(null);
      // Make the uploaded file playable so a click on a word can seek to it.
      setPlayableUrl(URL.createObjectURL(file));
      const mime = file.type || 'audio/mpeg';
      const outcome = await transcribeAudio(file, mime, file.name || 'audio');
      setUploading(false);
      if (!outcome.ok) {
        setNotice(
          outcome.reason === 'unavailable'
            ? 'Transcription is unavailable — the OpenAI provider is not configured.'
            : outcome.reason === 'bad_audio'
              ? 'That file could not be transcribed (unsupported or corrupt audio).'
              : 'Transcription failed. Please try again.'
        );
        return;
      }
      const { result } = outcome;
      if (result.language) setLanguage(result.language);
      const words = result.words ?? [];
      if (words.length) {
        sessionOffsetRef.current = words[words.length - 1].t1;
      }
      if (result.text.trim()) {
        setChunks([
          {
            text: result.text.trim(),
            words,
            language: result.language,
            offset: 0,
          },
        ]);
      } else {
        setNotice('No speech was detected in that file.');
      }
    },
    []
  );

  const onFileInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void onPickFile(file);
      // Reset so re-selecting the same file re-fires change.
      e.target.value = '';
    },
    [onPickFile]
  );

  const copyTranscript = useCallback(() => {
    if (!fullText) return;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    try {
      void navigator.clipboard.writeText(fullText).then(done, () => {
        setNotice('Could not copy to the clipboard.');
      });
    } catch {
      setNotice('Could not copy to the clipboard.');
    }
  }, [fullText]);

  const downloadTxt = useCallback(() => {
    if (!fullText) return;
    downloadTextFile('transcript.txt', fullText);
  }, [fullText]);

  const downloadSrt = useCallback(() => {
    if (!fullText) return;
    const cues = allWords.length
      ? wordsToCues(allWords)
      : textToCues(fullText, durationSec);
    if (!cues.length) return;
    downloadTextFile('transcript.srt', cuesToSrt(cues), 'text/plain');
  }, [fullText, allWords, durationSec]);

  // Click-to-seek: seek the local <audio> player to a word's on-set time.
  const seekTo = useCallback((seconds: number) => {
    const el = audioRef.current;
    if (!el) return;
    try {
      el.currentTime = Math.max(0, seconds);
      void el.play().catch(() => {
        /* ignore autoplay-denied */
      });
    } catch {
      /* ignore */
    }
  }, []);

  // Save the current transcript (plain text) into the Audio Library.
  const saveTranscript = useCallback(async () => {
    if (!fullText) return;
    setSaving(true);
    setNotice(null);
    const out = await saveLibraryTranscript(
      fullText,
      uploadName ? uploadName.replace(/\.\w+$/, '') : 'Transcription'
    );
    setSaving(false);
    if (out.ok) {
      setSaved(true);
    } else {
      setNotice(
        out.reason === 'bad'
          ? 'La transcription est vide — rien à sauvegarder.'
          : 'Impossible de sauvegarder la transcription.'
      );
    }
  }, [fullText, uploadName]);

  // Analyze the transcript with cdz-flash (summary + speakers).
  const runAnalyze = useCallback(async () => {
    if (!fullText) return;
    setAnalyzing(true);
    setAnalysisError(null);
    const out = await analyzeVoice(fullText, language);
    setAnalyzing(false);
    if (out.ok) {
      setAnalysis(out.analysis);
    } else if (out.reason === 'unavailable') {
      setAnalysisError(
        'Analyse non disponible — Activez CDZ_VOICE_AI_ENABLED sur le serveur.'
      );
    } else {
      setAnalysisError(
        "L'analyse a échoué. Réessayez dans un instant."
      );
    }
  }, [fullText, language]);

  const busy = micState === 'recording' || micState === 'finishing';
  const hasTranscript = fullText.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <style>
        {`@keyframes cdz-voice-shimmer{0%{opacity:.35}50%{opacity:.85}100%{opacity:.35}}
          @keyframes cdz-voice-pulse{0%{transform:scale(1);opacity:.9}70%{transform:scale(1.9);opacity:0}100%{opacity:0}}
          @media (prefers-reduced-motion: reduce){
            .cdz-voice-shimmer,.cdz-voice-pulse-ring{animation:none!important}
          }`}
      </style>

      {!available ? (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 10,
            fontSize: 13,
            background: C.warnBg,
            border: `1px solid ${C.warnBorder}`,
            color: C.text,
          }}
        >
          <strong>Transcription isn&apos;t configured.</strong>
          <br />
          Ask the owner to set an OpenAI key on the server (
          <code style={codeStyle}>OPENAI_VOICE_API_KEY</code> or the app&apos;s
          existing <code style={codeStyle}>OPEN_AI</code>), then reload. Mic
          capture and file upload stay disabled until then.
        </div>
      ) : null}

      {/* Capture controls -------------------------------------------------- */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          alignItems: 'stretch',
        }}
      >
        {/* Live mic card */}
        <div
          style={{
            flex: '1 1 320px',
            borderRadius: 12,
            border: `1px solid ${C.border}`,
            background: C.panel,
            padding: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
              Live transcription
            </span>
            <span style={{ fontSize: 11, color: C.muted }}>
              ~{REALTIME_CHUNK_SECONDS}s chunks
            </span>
          </div>

          {micState === 'unsupported' ? (
            <p style={{ margin: 0, fontSize: 12.5, color: C.muted }}>
              Your browser doesn&apos;t support in-page recording. Use the file
              upload on the right instead.
            </p>
          ) : micState === 'denied' ? (
            <p style={{ margin: 0, fontSize: 12.5, color: C.errText }}>
              Microphone permission was denied. Allow mic access in your browser
              settings, then try again.
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: 12.5, color: C.muted }}>
              Speak and watch the transcript build in near real time. Chunks are
              sent as you talk.
            </p>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              type="button"
              disabled={
                !available ||
                micState === 'unsupported' ||
                micState === 'finishing'
              }
              onClick={() =>
                micState === 'recording' ? stopRecording() : startRecording()
              }
              style={{
                appearance: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 9,
                padding: '9px 16px',
                minHeight: 40,
                borderRadius: 999,
                border: 'none',
                cursor:
                  !available || micState === 'unsupported'
                    ? 'not-allowed'
                    : 'pointer',
                fontSize: 13,
                fontWeight: 600,
                color: '#fff',
                background:
                  micState === 'recording'
                    ? C.recording
                    : !available || micState === 'unsupported'
                      ? 'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 45%, #555)'
                      : C.accent,
                opacity: micState === 'finishing' ? 0.7 : 1,
                transition: 'background 160ms ease, opacity 160ms ease',
              }}
            >
              {micState === 'recording' ? (
                <RecDot />
              ) : (
                <MicGlyph />
              )}
              {micState === 'recording'
                ? 'Stop'
                : micState === 'finishing'
                  ? 'Finishing…'
                  : 'Record'}
            </button>

            {busy ? (
              <span
                style={{
                  fontFamily: 'var(--affine-font-code-family, monospace)',
                  fontSize: 13,
                  color: micState === 'recording' ? C.recording : C.muted,
                }}
              >
                {formatClock(elapsed)}
              </span>
            ) : null}
            {pending ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11.5,
                  color: C.muted,
                }}
              >
                <Spinner /> transcribing…
              </span>
            ) : null}
          </div>
        </div>

        {/* File upload card */}
        <div
          style={{
            flex: '1 1 320px',
            borderRadius: 12,
            border: `1px dashed ${C.border}`,
            background: C.panel,
            padding: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
            Transcribe a file
          </span>
          <p style={{ margin: 0, fontSize: 12.5, color: C.muted }}>
            Upload an audio file (mp3, wav, m4a, webm, ogg…) for a single,
            high-accuracy transcription with timestamps.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            onChange={onFileInputChange}
            style={{ display: 'none' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              type="button"
              disabled={!available || uploading || busy}
              onClick={() => fileInputRef.current?.click()}
              style={{
                appearance: 'none',
                padding: '9px 16px',
                minHeight: 40,
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.panel2,
                color: C.text,
                fontSize: 13,
                fontWeight: 600,
                cursor: !available || uploading || busy ? 'not-allowed' : 'pointer',
                opacity: !available || uploading || busy ? 0.6 : 1,
                flexShrink: 0,
              }}
            >
              Choose file
            </button>
            {uploading ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11.5,
                  color: C.muted,
                }}
              >
                <Spinner /> transcribing {uploadName}…
              </span>
            ) : uploadName ? (
              <span
                style={{
                  fontSize: 11.5,
                  color: C.muted,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: isPhone ? 120 : 180,
                  minWidth: 0,
                }}
              >
                {uploadName}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {notice ? (
        <div
          style={{
            padding: '10px 13px',
            borderRadius: 9,
            fontSize: 12.5,
            background: C.errBg,
            border: `1px solid ${C.errBorder}`,
            color: C.text,
          }}
        >
          {notice}
        </div>
      ) : null}

      {/* Transcript panel -------------------------------------------------- */}
      <div
        style={{
          borderRadius: 12,
          border: `1px solid ${C.border}`,
          background: C.bg,
          overflow: 'hidden',
        }}
      >
        {/* meta + actions bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            borderBottom: `1px solid ${C.border}`,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 12, color: C.muted }}>
            {wordCount} word{wordCount === 1 ? '' : 's'}
          </span>
          <span style={{ fontSize: 12, color: C.muted }}>·</span>
          <span style={{ fontSize: 12, color: C.muted }}>
            {formatClock(durationSec)}
          </span>
          {language ? (
            <>
              <span style={{ fontSize: 12, color: C.muted }}>·</span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '1px 8px',
                  borderRadius: 999,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: C.accent,
                  background: C.accentSoft,
                }}
              >
                {language}
              </span>
            </>
          ) : null}
          <div style={{ flex: 1 }} />
          <ActionButton disabled={!hasTranscript} onClick={copyTranscript}>
            {copied ? 'Copied' : 'Copy'}
          </ActionButton>
          <ActionButton disabled={!hasTranscript} onClick={downloadTxt}>
            .txt
          </ActionButton>
          <ActionButton disabled={!hasTranscript} onClick={downloadSrt}>
            .srt
          </ActionButton>
          <ActionButton disabled={!hasTranscript} onClick={() => void saveTranscript()}>
            {saved ? 'Sauvegardée ✓' : saving ? '…' : 'Sauvegarder'}
          </ActionButton>
          <ActionButton disabled={!hasTranscript} onClick={() => void runAnalyze()}>
            {analyzing ? '…' : 'Analyser'}
          </ActionButton>
        </div>

        {/* playable source (file-upload transcripts) — supports click-to-seek */}
        {audioUrl ? (
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            preload="metadata"
            style={{
              width: '100%',
              height: 38,
              borderTop: `1px solid ${C.border}`,
              display: 'block',
              background: C.panel,
            }}
          >
            Your browser does not support audio playback.
          </audio>
        ) : null}

        {/* rolling transcript body */}
        <div
          style={{
            padding: '16px 16px 20px',
            minHeight: 160,
            maxHeight: 360,
            overflow: 'auto',
            fontSize: 15,
            lineHeight: 1.7,
            color: C.text,
          }}
        >
          {!hasTranscript && !pending && !uploading ? (
            <div
              style={{
                color: C.muted,
                fontSize: 13,
                textAlign: 'center',
                padding: '36px 12px',
              }}
            >
              {micState === 'recording'
                ? 'Listening… your words will appear here.'
                : 'Record from your mic or upload a file to see the transcript.'}
            </div>
          ) : (
            <>
              {allWords.length ? (
                // Word-level interactive transcript — each aligned word is
                // clickable and seeks the local player to that word's on-set
                // time (click-to-seek). Falls back to the grouped chunk text
                // when Whisper returned no word timings.
                <span style={{ color: C.text }}>
                  {allWords.map((w, i) => (
                    <span
                      key={i}
                      onClick={() => seekTo(w.t0)}
                      title={`${formatClock(w.t0)}`}
                      style={{
                        cursor: audioUrl ? 'pointer' : 'default',
                        borderRadius: 4,
                        transition: 'background 120ms ease',
                      }}
                      onMouseEnter={e => {
                        if (!audioUrl) return;
                        e.currentTarget.style.background =
                          'var(--affine-hover-color, rgba(255,255,255,0.08))';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      {w.w}{' '}
                    </span>
                  ))}
                </span>
              ) : (
                <>
                  {chunks.map((chunk, i) => (
                    <span key={i} style={{ color: C.text }}>
                      {chunk.text}{' '}
                    </span>
                  ))}
                </>
              )}
              {(pending || uploading) && (micState === 'recording' || uploading) ? (
                <span
                  className="cdz-voice-shimmer"
                  style={{
                    fontStyle: 'italic',
                    color: C.muted,
                    animation: 'cdz-voice-shimmer 1.2s ease-in-out infinite',
                  }}
                >
                  {uploading ? 'transcribing…' : '…'}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* AI analysis result */}
      {(analysis || analysisError) ? (
        <div
          style={{
            borderRadius: 12,
            border: `1px solid ${C.border}`,
            background: C.panel,
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
              Analyse
            </span>
            {analysis?.language ? (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '1px 8px',
                  borderRadius: 999,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: C.accent,
                  background: C.accentSoft,
                }}
              >
                {analysis.language}
              </span>
            ) : null}
            {analysis?.sentiment ? (
              <span
                style={{
                  fontSize: 11,
                  color: C.muted,
                  padding: '1px 8px',
                  borderRadius: 999,
                  border: `1px solid ${C.border}`,
                }}
              >
                {analysis.sentiment}
              </span>
            ) : null}
          </div>

          {analysisError ? (
            <p style={{ margin: 0, fontSize: 12.5, color: C.errText }}>
              {analysisError}
            </p>
          ) : null}

          {analysis ? (
            <>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: C.text }}>
                {analysis.summary}
              </p>
              {analysis.speakers.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {analysis.speakers.map((sp, i) => (
                    <div key={i} style={{ fontSize: 12.5, color: C.text }}>
                      <strong>{sp.name}</strong>
                      {sp.lines.length ? (
                        <ul
                          style={{
                            margin: '4px 0 0',
                            paddingLeft: 18,
                            color: C.muted,
                          }}
                        >
                          {sp.lines.map((line, j) => (
                            <li key={j} style={{ margin: '2px 0' }}>
                              {line}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

// ---- small inline helpers -------------------------------------------------

const codeStyle: CSSProperties = {
  fontFamily: 'var(--affine-font-code-family, monospace)',
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 4,
  background:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  color: 'var(--affine-text-primary-color, #ececec)',
};

const ActionButton = ({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    style={{
      appearance: 'none',
      padding: '5px 11px',
      minHeight: 40,
      borderRadius: 7,
      border: `1px solid ${C.border}`,
      background: 'transparent',
      color: disabled ? C.muted : C.text,
      fontSize: 12,
      fontWeight: 600,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      transition: 'background 140ms ease',
    }}
  >
    {children}
  </button>
);

const Spinner = () => (
  <span
    style={{
      display: 'inline-block',
      width: 11,
      height: 11,
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.35)',
      borderTopColor: '#fff',
      animation: 'cdz-voice-spin 0.7s linear infinite',
    }}
  >
    <style>{'@keyframes cdz-voice-spin{to{transform:rotate(360deg)}}'}</style>
  </span>
);

// A recording indicator dot with a soft pulse ring.
const RecDot = () => (
  <span
    style={{
      position: 'relative',
      display: 'inline-block',
      width: 9,
      height: 9,
    }}
  >
    <span
      className="cdz-voice-pulse-ring"
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: '50%',
        background: '#fff',
        animation: 'cdz-voice-pulse 1.4s ease-out infinite',
      }}
    />
    <span
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: '50%',
        background: '#fff',
      }}
    />
  </span>
);

const MicGlyph = ({ size = 15 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3.5" />
  </svg>
);
