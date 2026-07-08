// ClickDz Work — Voice Guide (realtime, v2 design)
//
// Floating voice assistant: a gradient orb with a crisp SVG mic streams your
// speech to Deepgram over WebSocket (short-lived token minted by the ClickDz
// AI bridge). Live captions appear as you talk; pausing auto-sends to ClickDz
// AI (Make credits) and the answer is spoken back with Deepgram TTS.
//
// Self-contained: imports only React. All styling inline + one <style> block.

import React, { useCallback, useEffect, useRef, useState } from 'react';

const BRIDGE = '';

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

  // Keyboard shortcut: Space to toggle voice
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
          return;
        }
        e.preventDefault();
        if (statusRef.current === 'listening') {
          void submitTranscript();
        } else if (statusRef.current !== 'connecting' && !isBusy) {
          void startListening();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isBusy, startListening, submitTranscript]);

  const handleOrbClick = useCallback(() => {
    if (statusRef.current === 'listening') {
      void submitTranscript();
      return;
    }
    if (statusRef.current === 'connecting' || isBusy) return;
    void startListening();
  }, [isBusy, startListening, submitTranscript]);

  // Quick commands — double-click orb for common actions
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const quickCommands = [
    { label: 'Summarize this page', icon: '📝' },
    { label: 'Create a mind map', icon: '🧠' },
    { label: 'Write code for me', icon: '💻' },
    { label: 'Explain like I\'m 5', icon: '🎯' },
  ];

  const handleQuickCommand = useCallback((command: string) => {
    setQuickMenuOpen(false);
    setPanelOpen(true);
    setLiveText(command);
    setStatus('thinking');
    // Auto-submit the command as transcript
    finalsRef.current = [command];
    interimRef.current = '';
    void submitTranscript();
  }, [submitTranscript]);

  // ---------- styles (v3 — glassmorphism upgrade) ----------
  const orbBackground = isLive
    ? 'linear-gradient(135deg, #FF6B6B 0%, #EE5A6F 40%, #C44569 100%)'
    : status === 'speaking'
      ? 'linear-gradient(135deg, #26DE81 0%, #20BF6B 50%, #1B9C5C 100%)'
      : status === 'error'
        ? 'linear-gradient(135deg, #FD79A8 0%, #E84393 50%, #C2366B 100%)'
        : 'linear-gradient(135deg, #74B9FF 0%, #5F72BE 50%, #9B59B6 100%)';

  const orbShadow = isLive
    ? '0 8px 32px rgba(238, 90, 111, 0.5), 0 0 0 1px rgba(255,255,255,0.15) inset, 0 0 20px rgba(255,107,107,0.3)'
    : status === 'speaking'
      ? '0 8px 32px rgba(32, 191, 107, 0.5), 0 0 0 1px rgba(255,255,255,0.15) inset'
      : status === 'error'
        ? '0 8px 32px rgba(232, 67, 147, 0.5), 0 0 0 1px rgba(255,255,255,0.15) inset'
        : '0 8px 32px rgba(95, 114, 190, 0.5), 0 0 0 1px rgba(255,255,255,0.15) inset';

  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    right: '24px',
    bottom: '100px',
    zIndex: 40,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '14px',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  };

  const orbStyle: React.CSSProperties = {
    width: '60px',
    height: '60px',
    borderRadius: '50%',
    border: 'none',
    cursor: isBusy ? 'wait' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#FFFFFF',
    background: orbBackground,
    boxShadow: orbShadow,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    transition:
      'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.3s ease, background 0.4s ease',
    animation:
      status === 'idle'
        ? 'clickdz-voice-breathe 3s ease-in-out infinite'
        : 'none',
    position: 'relative',
  };

  const panelStyle: React.CSSProperties = {
    width: '340px',
    maxWidth: 'calc(100vw - 48px)',
    background: 'rgba(17, 21, 36, 0.92)',
    backdropFilter: 'blur(24px) saturate(180%)',
    WebkitBackdropFilter: 'blur(24px) saturate(180%)',
    borderRadius: '20px',
    border: '1px solid rgba(255, 255, 255, 0.10)',
    boxShadow: '0 20px 60px rgba(2, 6, 23, 0.6), 0 0 0 1px rgba(255,255,255,0.05) inset',
    padding: '16px 18px 18px',
    color: '#E2E8F0',
    fontSize: '13px',
    lineHeight: 1.5,
    position: 'relative',
    overflow: 'hidden',
    animation: 'clickdz-voice-panel-in 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
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

      {/* Quick commands menu (appears on long-press / right-click) */}
      {quickMenuOpen && status === 'idle' ? (
        <div style={{
          ...panelStyle,
          width: '220px',
          padding: '10px',
          animation: 'clickdz-voice-panel-in 0.15s ease',
        }}>
          <div style={{ fontWeight: 700, fontSize: '12px', color: '#F8FAFC', marginBottom: '8px' }}>
            Quick Commands
          </div>
          {quickCommands.map((cmd, i) => (
            <button
              key={i}
              onClick={() => handleQuickCommand(cmd.label)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                padding: '8px 10px',
                border: 'none',
                background: 'transparent',
                color: '#E2E8F0',
                fontSize: '12px',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ fontSize: '16px' }}>{cmd.icon}</span>
              {cmd.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* the orb */}
      <button
        type="button"
        className="clickdz-voice-orb"
        onClick={handleOrbClick}
        onContextMenu={e => {
          e.preventDefault();
          if (status === 'idle') setQuickMenuOpen(v => !v);
        }}
        style={orbStyle}
        aria-label={
          isLive ? 'Send what I said' : 'Ask ClickDz AI with your voice'
        }
        title={
          isLive
            ? 'Tap to send — or just pause talking'
            : 'Ask ClickDz AI with your voice (right-click for quick commands)'
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
