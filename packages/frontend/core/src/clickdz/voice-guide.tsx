// ClickDz Work — Voice Guide
//
// A self-contained floating mic button that lets the user talk to the
// ClickDz AI assistant: record voice -> Deepgram STT -> ClickDz AI bridge
// chat completion -> Deepgram TTS -> play spoken answer (+ show text).
//
// Intentionally has NO imports from other project files (besides `react`)
// so it can be dropped in anywhere without pulling in extra dependencies
// or risking merge conflicts with the rest of the app.

import React, { useCallback, useRef, useState } from 'react';

const BRIDGE = 'https://clickdz-ai-bridge-techportal.vercel.app';

const SYSTEM_PROMPT =
  'You are ClickDz AI, a friendly in-app guide for ClickDz Work. Answer briefly and help the user use the app (docs, whiteboards, AI, templates). Reply in the user language (Arabic/Darija, French, or English).';

type VoiceGuideStatus =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'error';

interface ChatCompletionChoice {
  message?: {
    content?: string;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

interface SttResponse {
  transcript?: string;
  error?: string;
}

/**
 * Convert a Blob to a base64 string (no data-URL prefix).
 */
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to read audio blob.'));
        return;
      }
      // result looks like "data:audio/webm;base64,AAAA..."
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('FileReader error.'));
    };
    reader.readAsDataURL(blob);
  });
};

export const VoiceGuide = () => {
  const [status, setStatus] = useState<VoiceGuideStatus>('idle');
  const [transcript, setTranscript] = useState<string>('');
  const [answer, setAnswer] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [panelOpen, setPanelOpen] = useState<boolean>(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  const isRecording = status === 'recording';
  const isBusy =
    status === 'transcribing' || status === 'thinking' || status === 'speaking';

  const stopStreamTracks = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach(track => {
        track.stop();
      });
      streamRef.current = null;
    }
  }, []);

  const runAssistantPipeline = useCallback(async (audioBlob: Blob, mimeType: string) => {
    try {
      setStatus('transcribing');
      setErrorMessage('');

      const base64Audio = await blobToBase64(audioBlob);

      const sttRes = await fetch(`${BRIDGE}/api/voice/stt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64Audio, mimetype: mimeType }),
      });

      if (!sttRes.ok) {
        throw new Error(`Speech recognition failed (${sttRes.status}).`);
      }

      const sttData: SttResponse = await sttRes.json();
      const recognizedText = (sttData.transcript ?? '').trim();
      setTranscript(recognizedText);

      if (!recognizedText) {
        setErrorMessage("Sorry, I didn't catch that. Please try again.");
        setStatus('idle');
        return;
      }

      setStatus('thinking');

      const chatRes = await fetch(`${BRIDGE}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: recognizedText },
          ],
        }),
      });

      if (!chatRes.ok) {
        throw new Error(`ClickDz AI request failed (${chatRes.status}).`);
      }

      const chatData: ChatCompletionResponse = await chatRes.json();
      const answerText = (chatData.choices?.[0]?.message?.content ?? '').trim();

      if (!answerText) {
        throw new Error('ClickDz AI returned an empty answer.');
      }

      setAnswer(answerText);
      setStatus('speaking');

      try {
        const ttsRes = await fetch(`${BRIDGE}/api/voice/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: answerText }),
        });

        if (!ttsRes.ok) {
          throw new Error(`Text-to-speech failed (${ttsRes.status}).`);
        }

        const audioBlobResponse = await ttsRes.blob();
        const audioUrl = URL.createObjectURL(audioBlobResponse);

        const audioEl = new Audio(audioUrl);
        audioElementRef.current = audioEl;
        audioEl.onended = () => {
          setStatus('idle');
          URL.revokeObjectURL(audioUrl);
        };
        audioEl.onerror = () => {
          // Text answer is already shown, so audio failure is non-fatal.
          setStatus('idle');
          URL.revokeObjectURL(audioUrl);
        };

        await audioEl.play();
      } catch {
        // Audio playback/generation failed — the written answer is still visible.
        setStatus('idle');
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      setErrorMessage(message);
      setStatus('error');
    }
  }, []);

  const startRecording = useCallback(async () => {
    setErrorMessage('');
    setTranscript('');
    setAnswer('');
    setPanelOpen(true);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setErrorMessage('Microphone access is not supported in this browser.');
      setStatus('error');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType =
        typeof MediaRecorder !== 'undefined' &&
        MediaRecorder.isTypeSupported &&
        MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      audioChunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const finalMimeType = recorder.mimeType || 'audio/webm';
        const audioBlob = new Blob(audioChunksRef.current, { type: finalMimeType });
        audioChunksRef.current = [];
        stopStreamTracks();
        void runAssistantPipeline(audioBlob, finalMimeType);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setStatus('recording');
    } catch {
      setErrorMessage(
        'Microphone permission was denied. Please allow microphone access to use the voice guide.'
      );
      setStatus('error');
      stopStreamTracks();
    }
  }, [runAssistantPipeline, stopStreamTracks]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      stopStreamTracks();
      setStatus('idle');
    }
  }, [stopStreamTracks]);

  const handleMicClick = useCallback(() => {
    if (isRecording) {
      stopRecording();
      return;
    }
    if (isBusy) {
      return;
    }
    void startRecording();
  }, [isRecording, isBusy, startRecording, stopRecording]);

  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    right: '24px',
    bottom: '96px',
    zIndex: 40,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  };

  const buttonBaseStyle: React.CSSProperties = {
    width: '52px',
    height: '52px',
    borderRadius: '50%',
    border: 'none',
    cursor: isBusy ? 'wait' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '22px',
    lineHeight: 1,
    color: '#FFFFFF',
    boxShadow: '0 8px 24px rgba(29, 78, 216, 0.45)',
    background: isRecording
      ? 'linear-gradient(135deg, #EF4444, #B91C1C)'
      : 'linear-gradient(135deg, #2B7FFF, #1D4ED8)',
    transition: 'transform 0.15s ease, box-shadow 0.15s ease',
    animation: isRecording ? 'clickdz-voice-guide-pulse 1.2s ease-in-out infinite' : 'none',
  };

  const panelStyle: React.CSSProperties = {
    marginBottom: '12px',
    maxWidth: '280px',
    minWidth: '220px',
    background: '#FFFFFF',
    borderRadius: '14px',
    boxShadow: '0 10px 30px rgba(15, 23, 42, 0.18)',
    padding: '14px 16px',
    fontSize: '13px',
    lineHeight: 1.45,
    color: '#0F172A',
    border: '1px solid rgba(15, 23, 42, 0.06)',
  };

  const labelStyle: React.CSSProperties = {
    fontWeight: 700,
    color: '#1D4ED8',
    marginBottom: '2px',
    display: 'block',
  };

  const blockStyle: React.CSSProperties = {
    marginBottom: '10px',
  };

  const statusTextStyle: React.CSSProperties = {
    color: '#64748B',
    fontStyle: 'italic',
  };

  const errorTextStyle: React.CSSProperties = {
    color: '#DC2626',
  };

  const closeButtonStyle: React.CSSProperties = {
    position: 'absolute',
    top: '6px',
    right: '10px',
    border: 'none',
    background: 'transparent',
    color: '#94A3B8',
    fontSize: '14px',
    cursor: 'pointer',
    lineHeight: 1,
  };

  const hasPanelContent =
    Boolean(transcript) ||
    Boolean(answer) ||
    Boolean(errorMessage) ||
    status === 'transcribing' ||
    status === 'thinking' ||
    status === 'speaking';
  const showPanel = panelOpen && hasPanelContent;

  return (
    <div style={containerStyle}>
      <style>
        {`@keyframes clickdz-voice-guide-pulse {
            0% { transform: scale(1); box-shadow: 0 8px 24px rgba(239, 68, 68, 0.45); }
            50% { transform: scale(1.08); box-shadow: 0 8px 30px rgba(239, 68, 68, 0.65); }
            100% { transform: scale(1); box-shadow: 0 8px 24px rgba(239, 68, 68, 0.45); }
          }`}
      </style>

      {showPanel ? (
        <div style={{ ...panelStyle, position: 'relative' }}>
          <button
            type="button"
            onClick={() => setPanelOpen(false)}
            style={closeButtonStyle}
            aria-label="Close voice guide panel"
          >
            ✕
          </button>

          {transcript ? (
            <div style={blockStyle}>
              <span style={labelStyle}>You:</span>
              <span>{transcript}</span>
            </div>
          ) : null}

          {status === 'transcribing' ? (
            <div style={{ ...blockStyle, ...statusTextStyle }}>Listening…</div>
          ) : null}

          {status === 'thinking' ? (
            <div style={{ ...blockStyle, ...statusTextStyle }}>ClickDz AI is thinking…</div>
          ) : null}

          {answer ? (
            <div style={blockStyle}>
              <span style={labelStyle}>ClickDz AI:</span>
              <span>{answer}</span>
            </div>
          ) : null}

          {status === 'speaking' && answer ? (
            <div style={statusTextStyle}>Speaking…</div>
          ) : null}

          {errorMessage ? <div style={errorTextStyle}>{errorMessage}</div> : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={handleMicClick}
        style={buttonBaseStyle}
        aria-label={isRecording ? 'Stop recording' : 'Ask ClickDz AI with your voice'}
        title={isRecording ? 'Stop recording' : 'Ask ClickDz AI with your voice'}
        disabled={isBusy}
      >
        {isBusy ? '…' : '🎙️'}
      </button>
    </div>
  );
};

export default VoiceGuide;
