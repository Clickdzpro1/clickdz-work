// ClickDz Work — Voice Guide (realtime)
//
// Floating mic button that lets the user talk to ClickDz AI with LIVE
// transcription: mic audio streams to Deepgram over a WebSocket (short-lived
// token minted by the ClickDz AI bridge), interim words appear as you speak,
// and when you pause (or tap the mic again) the final transcript is sent to
// the ClickDz AI bridge; the spoken answer is played back with Deepgram TTS.
//
// Intentionally has NO imports from other project files (besides `react`)
// so it can be dropped in anywhere without pulling in extra dependencies.

import React, { useCallback, useEffect, useRef, useState } from 'react';

const BRIDGE = 'https://clickdz-ai-bridge-techportal.vercel.app';

const SYSTEM_PROMPT =
  'You are ClickDz AI, the friendly in-app voice guide for ClickDz Work — the AI workspace by clickdz.ai. Answer briefly (2-4 sentences, spoken style) and help the user use the app: docs, edgeless whiteboards, AI chat, templates, journals, folders, sharing. Reply in the language the user spoke (Arabic/Darija, French, or English).';

const DG_SOCKET =
  'wss://api.deepgram.com/v1/listen' +
  '?model=nova-3&language=multi&smart_format=true' +
  '&interim_results=true&vad_events=true&utterance_end_ms=1800';

type VoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export const VoiceGuide = () => {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [liveText, setLiveText] = useState('');
  const [answer, setAnswer] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const finalsRef = useRef<string[]>([]);
  const interimRef = useRef('');
  const historyRef = useRef<ChatTurn[]>([]);
  const submittingRef = useRef(false);
  const statusRef = useRef<VoiceStatus>('idle');
  statusRef.current = status;

  const isListening = status === 'listening' || status === 'connecting';
  const isBusy = status === 'thinking' || status === 'speaking';

  const cleanupCapture = useCallback(() => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        /* ignore */
      }
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }, []);

  // full teardown on unmount
  useEffect(() => {
    return () => {
      cleanupCapture();
      const el = audioElRef.current;
      if (el) {
        el.pause();
      }
    };
  }, [cleanupCapture]);

  const speak = useCallback(async (text: string) => {
    try {
      const res = await fetch(`${BRIDGE}/api/voice/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`tts ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const el = new Audio(url);
      audioElRef.current = el;
      await new Promise<void>(resolve => {
        el.onended = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        el.onerror = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        el.play().catch(() => resolve());
      });
    } catch {
      // written answer is already on screen — audio failure is non-fatal
    }
  }, []);

  const submitTranscript = useCallback(async () => {
    if (submittingRef.current) return;
    const text = [...finalsRef.current, interimRef.current]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    submittingRef.current = true;
    cleanupCapture();

    if (!text) {
      submittingRef.current = false;
      setStatus('idle');
      return;
    }

    setLiveText(text);
    setStatus('thinking');
    try {
      const history = historyRef.current.slice(-6);
      const res = await fetch(`${BRIDGE}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5-mini',
          stream: false,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...history,
            { role: 'user', content: text },
          ],
        }),
      });
      if (!res.ok) throw new Error(`ClickDz AI request failed (${res.status})`);
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const reply = (data.choices?.[0]?.message?.content ?? '').trim();
      if (!reply) throw new Error('ClickDz AI returned an empty answer.');

      historyRef.current = [
        ...history,
        { role: 'user', content: text },
        { role: 'assistant', content: reply },
      ];
      setAnswer(reply);
      setStatus('speaking');
      await speak(reply);
      setStatus('idle');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Something went wrong.'
      );
      setStatus('error');
    } finally {
      submittingRef.current = false;
    }
  }, [cleanupCapture, speak]);

  const startListening = useCallback(async () => {
    setErrorMessage('');
    setLiveText('');
    setAnswer('');
    setPanelOpen(true);
    finalsRef.current = [];
    interimRef.current = '';
    submittingRef.current = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('Microphone access is not supported in this browser.');
      setStatus('error');
      return;
    }

    setStatus('connecting');
    try {
      // 1. short-lived Deepgram token from the ClickDz bridge
      const tokenRes = await fetch(`${BRIDGE}/api/voice/token`, {
        method: 'POST',
      });
      if (tokenRes.status === 503) {
        throw new Error(
          'Voice is not configured yet — the administrator needs to add the Deepgram key.'
        );
      }
      if (!tokenRes.ok) {
        throw new Error(`Voice service unavailable (${tokenRes.status}).`);
      }
      const { access_token: accessToken } = (await tokenRes.json()) as {
        access_token?: string;
      };
      if (!accessToken) throw new Error('Voice token missing.');

      // 2. microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      streamRef.current = stream;

      // 3. realtime socket
      const ws = new WebSocket(DG_SOCKET, ['bearer', accessToken]);
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        const mimeType = MediaRecorder.isTypeSupported?.(
          'audio/webm;codecs=opus'
        )
          ? 'audio/webm;codecs=opus'
          : '';
        const rec = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        recorderRef.current = rec;
        rec.ondataavailable = e => {
          if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
            ws.send(e.data);
          }
        };
        rec.start(250); // stream every 250ms for live captions
        setStatus('listening');
      };

      ws.onmessage = event => {
        if (wsRef.current !== ws) return;
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string;
            is_final?: boolean;
            channel?: { alternatives?: { transcript?: string }[] };
          };
          if (msg.type === 'Results') {
            const chunk = msg.channel?.alternatives?.[0]?.transcript ?? '';
            if (msg.is_final) {
              if (chunk.trim()) finalsRef.current.push(chunk.trim());
              interimRef.current = '';
            } else {
              interimRef.current = chunk;
            }
            setLiveText(
              [...finalsRef.current, interimRef.current]
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
            );
          } else if (msg.type === 'UtteranceEnd') {
            // the user stopped talking — auto-submit what we heard
            if (finalsRef.current.length && statusRef.current === 'listening') {
              void submitTranscript();
            }
          }
        } catch {
          /* non-JSON frames ignored */
        }
      };

      ws.onerror = () => {
        if (wsRef.current !== ws) return;
        if (statusRef.current === 'connecting') {
          setErrorMessage('Could not reach the live transcription service.');
          setStatus('error');
          cleanupCapture();
        }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (statusRef.current === 'listening' && !submittingRef.current) {
          void submitTranscript();
        }
      };
    } catch (err) {
      cleanupCapture();
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Microphone permission was denied.'
      );
      setStatus('error');
    }
  }, [cleanupCapture, submitTranscript]);

  const handleMicClick = useCallback(() => {
    if (statusRef.current === 'listening') {
      void submitTranscript(); // tap again = send now
      return;
    }
    if (statusRef.current === 'connecting' || isBusy) return;
    void startListening();
  }, [isBusy, startListening, submitTranscript]);

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

  const buttonStyle: React.CSSProperties = {
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
    background:
      status === 'listening' || status === 'connecting'
        ? 'linear-gradient(135deg, #EF4444, #B91C1C)'
        : 'linear-gradient(135deg, #2B7FFF, #1D4ED8)',
    transition: 'transform 0.15s ease, box-shadow 0.15s ease',
    animation:
      status === 'listening'
        ? 'clickdz-voice-guide-pulse 1.2s ease-in-out infinite'
        : 'none',
  };

  const panelStyle: React.CSSProperties = {
    marginBottom: '12px',
    maxWidth: '300px',
    minWidth: '230px',
    background: '#FFFFFF',
    borderRadius: '14px',
    boxShadow: '0 10px 30px rgba(15, 23, 42, 0.18)',
    padding: '14px 16px',
    fontSize: '13px',
    lineHeight: 1.45,
    color: '#0F172A',
    border: '1px solid rgba(15, 23, 42, 0.06)',
    position: 'relative',
  };

  const labelStyle: React.CSSProperties = {
    fontWeight: 700,
    color: '#1D4ED8',
    marginBottom: '2px',
    display: 'block',
  };

  const mutedStyle: React.CSSProperties = {
    color: '#64748B',
    fontStyle: 'italic',
  };

  const hasContent =
    Boolean(liveText) ||
    Boolean(answer) ||
    Boolean(errorMessage) ||
    status !== 'idle';
  const showPanel = panelOpen && hasContent;

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
        <div style={panelStyle}>
          <button
            type="button"
            onClick={() => {
              setPanelOpen(false);
              if (statusRef.current === 'listening') void submitTranscript();
            }}
            style={{
              position: 'absolute',
              top: '6px',
              right: '10px',
              border: 'none',
              background: 'transparent',
              color: '#94A3B8',
              fontSize: '14px',
              cursor: 'pointer',
              lineHeight: 1,
            }}
            aria-label="Close voice guide panel"
          >
            ✕
          </button>

          {status === 'connecting' ? (
            <div style={mutedStyle}>Connecting…</div>
          ) : null}

          {status === 'listening' && !liveText ? (
            <div style={mutedStyle}>Listening — start talking…</div>
          ) : null}

          {liveText ? (
            <div style={{ marginBottom: '10px' }}>
              <span style={labelStyle}>You:</span>
              <span>
                {liveText}
                {status === 'listening' ? (
                  <span style={{ color: '#94A3B8' }}> ▍</span>
                ) : null}
              </span>
            </div>
          ) : null}

          {status === 'thinking' ? (
            <div style={mutedStyle}>ClickDz AI is thinking…</div>
          ) : null}

          {answer ? (
            <div style={{ marginBottom: '6px' }}>
              <span style={labelStyle}>ClickDz AI:</span>
              <span>{answer}</span>
            </div>
          ) : null}

          {status === 'speaking' ? <div style={mutedStyle}>Speaking…</div> : null}

          {errorMessage ? (
            <div style={{ color: '#DC2626' }}>{errorMessage}</div>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={handleMicClick}
        style={buttonStyle}
        aria-label={
          isListening ? 'Send what I said' : 'Ask ClickDz AI with your voice'
        }
        title={
          isListening
            ? 'Tap to send — or just pause talking'
            : 'Ask ClickDz AI with your voice'
        }
        disabled={isBusy}
      >
        {isBusy ? '…' : isListening ? '⏺' : '🎙️'}
      </button>
    </div>
  );
};

export default VoiceGuide;
