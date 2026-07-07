// ClickDz Work — Voice Guide (realtime, v2 design)
//
// Floating voice assistant: a gradient orb with a crisp SVG mic streams your
// speech to Deepgram over WebSocket (short-lived token minted by the ClickDz
// AI bridge). Live captions appear as you talk; pausing auto-sends to ClickDz
// AI (Make credits) and the answer is spoken back with Deepgram TTS.
//
// Self-contained: imports only React. All styling inline + one <style> block.

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

const MicIcon = ({ size = 22 }: { size?: number }) => (
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

const StopIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="3" fill="currentColor" />
  </svg>
);

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

  const isLive = status === 'listening' || status === 'connecting';
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
          model: 'gpt-5-nano',
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

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      streamRef.current = stream;

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
        rec.start(250);
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

  const handleOrbClick = useCallback(() => {
    if (statusRef.current === 'listening') {
      void submitTranscript();
      return;
    }
    if (statusRef.current === 'connecting' || isBusy) return;
    void startListening();
  }, [isBusy, startListening, submitTranscript]);

  // ---------- styles ----------
  const orbBackground = isLive
    ? 'linear-gradient(140deg, #FB7185 0%, #E11D48 55%, #9F1239 100%)'
    : status === 'speaking'
      ? 'linear-gradient(140deg, #34D399 0%, #0D9488 60%, #115E59 100%)'
      : 'linear-gradient(140deg, #60A5FA 0%, #4F46E5 55%, #7C3AED 100%)';

  const orbShadow = isLive
    ? '0 10px 30px rgba(225, 29, 72, 0.45), 0 0 0 1px rgba(255,255,255,0.08) inset'
    : '0 10px 30px rgba(79, 70, 229, 0.45), 0 0 0 1px rgba(255,255,255,0.10) inset';

  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    right: '22px',
    bottom: '92px',
    zIndex: 40,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '12px',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  };

  const orbStyle: React.CSSProperties = {
    width: '56px',
    height: '56px',
    borderRadius: '50%',
    border: 'none',
    cursor: isBusy ? 'wait' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#FFFFFF',
    background: orbBackground,
    boxShadow: orbShadow,
    transition:
      'transform 0.18s ease, box-shadow 0.25s ease, background 0.3s ease',
    animation:
      status === 'idle'
        ? 'clickdz-voice-breathe 3.6s ease-in-out infinite'
        : 'none',
    position: 'relative',
  };

  const panelStyle: React.CSSProperties = {
    width: '320px',
    maxWidth: 'calc(100vw - 44px)',
    background: 'rgba(13, 17, 28, 0.88)',
    backdropFilter: 'blur(18px) saturate(150%)',
    WebkitBackdropFilter: 'blur(18px) saturate(150%)',
    borderRadius: '18px',
    border: '1px solid rgba(255, 255, 255, 0.09)',
    boxShadow: '0 18px 50px rgba(2, 6, 23, 0.55)',
    padding: '14px 16px 16px',
    color: '#E2E8F0',
    fontSize: '13px',
    lineHeight: 1.5,
    position: 'relative',
    overflow: 'hidden',
    animation: 'clickdz-voice-panel-in 0.22s ease',
  };

  const statusDotColor = isLive
    ? '#FB7185'
    : status === 'thinking'
      ? '#FBBF24'
      : status === 'speaking'
        ? '#34D399'
        : status === 'error'
          ? '#F87171'
          : '#64748B';

  const statusLabel =
    status === 'connecting'
      ? 'Connecting…'
      : status === 'listening'
        ? 'Listening'
        : status === 'thinking'
          ? 'Thinking…'
          : status === 'speaking'
            ? 'Speaking'
            : status === 'error'
              ? 'Error'
              : 'Ready';

  const hasContent =
    Boolean(liveText) ||
    Boolean(answer) ||
    Boolean(errorMessage) ||
    status !== 'idle';
  const showPanel = panelOpen && hasContent;

  const bars = [0, 1, 2, 3, 4];

  return (
    <div style={containerStyle}>
      <style>
        {`@keyframes clickdz-voice-breathe {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.045); }
          }
          @keyframes clickdz-voice-ring {
            0% { transform: scale(1); opacity: 0.55; }
            100% { transform: scale(1.75); opacity: 0; }
          }
          @keyframes clickdz-voice-panel-in {
            from { opacity: 0; transform: translateY(8px) scale(0.98); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
          @keyframes clickdz-voice-bar {
            0%, 100% { transform: scaleY(0.35); }
            50% { transform: scaleY(1); }
          }
          @keyframes clickdz-voice-dot {
            0%, 80%, 100% { transform: translateY(0); opacity: 0.5; }
            40% { transform: translateY(-4px); opacity: 1; }
          }
          @keyframes clickdz-voice-caret {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
          .clickdz-voice-orb:hover { transform: scale(1.06); }
          .clickdz-voice-orb:active { transform: scale(0.97); }`}
      </style>

      {showPanel ? (
        <div style={panelStyle}>
          {/* header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '10px',
            }}
          >
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: statusDotColor,
                boxShadow: `0 0 8px ${statusDotColor}`,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontWeight: 700,
                fontSize: '12px',
                letterSpacing: '0.02em',
                color: '#F8FAFC',
              }}
            >
              ClickDz AI
            </span>
            <span style={{ fontSize: '11px', color: '#94A3B8' }}>
              {statusLabel}
            </span>
            <button
              type="button"
              onClick={() => {
                setPanelOpen(false);
                if (statusRef.current === 'listening') void submitTranscript();
              }}
              aria-label="Close voice panel"
              style={{
                marginLeft: 'auto',
                border: 'none',
                background: 'rgba(148, 163, 184, 0.12)',
                color: '#94A3B8',
                width: '22px',
                height: '22px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '12px',
                lineHeight: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ✕
            </button>
          </div>

          {/* listening equalizer */}
          {status === 'listening' && !liveText ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                height: '26px',
                marginBottom: '4px',
              }}
            >
              {bars.map(b => (
                <span
                  key={b}
                  style={{
                    width: '4px',
                    height: '22px',
                    borderRadius: '2px',
                    background:
                      'linear-gradient(180deg, #FB7185, #E11D48)',
                    transformOrigin: 'center',
                    animation: `clickdz-voice-bar 0.9s ease-in-out ${b * 0.12}s infinite`,
                  }}
                />
              ))}
              <span style={{ marginLeft: '8px', color: '#94A3B8', fontSize: '12px' }}>
                start talking…
              </span>
            </div>
          ) : null}

          {/* user transcript */}
          {liveText ? (
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                marginBottom: '10px',
              }}
            >
              <div
                style={{
                  maxWidth: '85%',
                  background:
                    'linear-gradient(135deg, rgba(79,70,229,0.35), rgba(124,58,237,0.30))',
                  border: '1px solid rgba(129, 140, 248, 0.25)',
                  borderRadius: '14px 14px 4px 14px',
                  padding: '8px 12px',
                  color: '#EEF2FF',
                }}
              >
                {liveText}
                {status === 'listening' ? (
                  <span
                    style={{
                      display: 'inline-block',
                      width: '2px',
                      height: '13px',
                      marginLeft: '3px',
                      verticalAlign: 'text-bottom',
                      background: '#C7D2FE',
                      animation: 'clickdz-voice-caret 0.9s step-end infinite',
                    }}
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {/* thinking dots */}
          {status === 'thinking' ? (
            <div
              style={{
                display: 'flex',
                gap: '5px',
                alignItems: 'center',
                padding: '2px 2px 6px',
              }}
            >
              {[0, 1, 2].map(d => (
                <span
                  key={d}
                  style={{
                    width: '7px',
                    height: '7px',
                    borderRadius: '50%',
                    background: '#818CF8',
                    animation: `clickdz-voice-dot 1.1s ease-in-out ${d * 0.18}s infinite`,
                  }}
                />
              ))}
            </div>
          ) : null}

          {/* answer */}
          {answer ? (
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-start',
                marginBottom: status === 'speaking' ? '8px' : 0,
              }}
            >
              <div
                style={{
                  maxWidth: '90%',
                  background: 'rgba(148, 163, 184, 0.10)',
                  border: '1px solid rgba(148, 163, 184, 0.14)',
                  borderRadius: '14px 14px 14px 4px',
                  padding: '9px 12px',
                  color: '#F1F5F9',
                }}
              >
                {answer}
              </div>
            </div>
          ) : null}

          {/* speaking equalizer */}
          {status === 'speaking' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              {bars.map(b => (
                <span
                  key={b}
                  style={{
                    width: '3px',
                    height: '14px',
                    borderRadius: '2px',
                    background: 'linear-gradient(180deg, #34D399, #0D9488)',
                    transformOrigin: 'center',
                    animation: `clickdz-voice-bar 0.8s ease-in-out ${b * 0.1}s infinite`,
                  }}
                />
              ))}
              <span style={{ marginLeft: '8px', color: '#94A3B8', fontSize: '12px' }}>
                speaking…
              </span>
            </div>
          ) : null}

          {errorMessage ? (
            <div
              style={{
                marginTop: '6px',
                background: 'rgba(248, 113, 113, 0.10)',
                border: '1px solid rgba(248, 113, 113, 0.25)',
                borderRadius: '10px',
                padding: '8px 10px',
                color: '#FCA5A5',
                fontSize: '12px',
              }}
            >
              {errorMessage}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* the orb */}
      <button
        type="button"
        className="clickdz-voice-orb"
        onClick={handleOrbClick}
        style={orbStyle}
        aria-label={
          isLive ? 'Send what I said' : 'Ask ClickDz AI with your voice'
        }
        title={
          isLive
            ? 'Tap to send — or just pause talking'
            : 'Ask ClickDz AI with your voice'
        }
        disabled={isBusy}
      >
        {isLive ? (
          <>
            <span
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                border: '2px solid rgba(251, 113, 133, 0.7)',
                animation: 'clickdz-voice-ring 1.4s ease-out infinite',
              }}
            />
            <StopIcon />
          </>
        ) : isBusy ? (
          <span style={{ display: 'flex', gap: '3px' }}>
            {[0, 1, 2].map(d => (
              <span
                key={d}
                style={{
                  width: '5px',
                  height: '5px',
                  borderRadius: '50%',
                  background: '#FFFFFF',
                  animation: `clickdz-voice-dot 1.1s ease-in-out ${d * 0.18}s infinite`,
                }}
              />
            ))}
          </span>
        ) : (
          <MicIcon />
        )}
      </button>
    </div>
  );
};

export default VoiceGuide;
