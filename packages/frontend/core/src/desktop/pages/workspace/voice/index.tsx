import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { GenerateTab } from './generate-tab';
import { TranscribeTab } from './transcribe-tab';
import {
  C,
  fetchVoiceCapabilities,
  type VoiceCapabilities,
} from './voice-shared';

// ---------------------------------------------------------------------------
// ClickDz Voice Studio — DARK by default.
//
// A real, complete voice workspace on the /voice page: live-feeling
// transcription (OpenAI Whisper) + speech generation (Deepgram AND OpenAI).
// The page reflects GET /api/voice/capabilities so each surface degrades
// gracefully when a provider key is missing (never a crash). No new .css.ts —
// inline styles only, mirroring the Integrations page's `C` palette scaffold.
// ---------------------------------------------------------------------------

type Tab = 'transcribe' | 'generate';
type LoadState = 'loading' | 'ready' | 'error';

const VoiceStudioPage = () => {
  const [tab, setTab] = useState<Tab>('transcribe');
  const [state, setState] = useState<LoadState>('loading');
  const [caps, setCaps] = useState<VoiceCapabilities | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    const data = await fetchVoiceCapabilities();
    if (!data) {
      setState('error');
      return;
    }
    setCaps(data);
    setState('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <ViewTitle title="Voice Studio" />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: '100%',
            padding: '0 16px',
            fontSize: 14,
            fontWeight: 600,
            color: C.text,
          }}
        >
          <span style={{ fontSize: 16 }}>🎙️</span>
          Voice Studio
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '15px',
              padding: '0 6px',
              borderRadius: 5,
              letterSpacing: '0.05em',
              color: C.muted,
              backgroundColor:
                'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)',
            }}
          >
            béta
          </span>
        </div>
      </ViewHeader>
      <ViewBody>
        <div
          style={{
            height: '100%',
            width: '100%',
            overflow: 'auto',
            background: C.bg,
            color: C.text,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <div
            style={{
              maxWidth: 960,
              margin: '0 auto',
              padding: '28px 24px 48px',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            <header
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <h1
                style={{
                  margin: 0,
                  fontSize: 24,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: C.text,
                }}
              >
                <span>🎙️</span> Voice Studio
              </h1>
              <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
                Transcribe speech to text and generate natural voice-overs — all
                in one place.
              </p>
            </header>

            {/* Tab switcher */}
            <div
              style={{
                display: 'inline-flex',
                gap: 4,
                padding: 4,
                borderRadius: 10,
                background: C.panel,
                border: `1px solid ${C.border}`,
                alignSelf: 'flex-start',
              }}
            >
              <TabButton
                active={tab === 'transcribe'}
                onClick={() => setTab('transcribe')}
              >
                Transcribe
              </TabButton>
              <TabButton
                active={tab === 'generate'}
                onClick={() => setTab('generate')}
              >
                Generate
              </TabButton>
            </div>

            {state === 'loading' ? (
              <div
                style={{
                  padding: '40px 12px',
                  textAlign: 'center',
                  color: C.muted,
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                }}
              >
                <PageSpinner /> Loading Voice Studio…
              </div>
            ) : state === 'error' || !caps ? (
              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 10,
                  fontSize: 13,
                  background: C.errBg,
                  border: `1px solid ${C.errBorder}`,
                  color: C.text,
                }}
              >
                Couldn&apos;t load Voice Studio.{' '}
                <button
                  type="button"
                  onClick={() => void load()}
                  style={{
                    appearance: 'none',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    font: 'inherit',
                    cursor: 'pointer',
                    color: C.accent,
                    textDecoration: 'underline',
                  }}
                >
                  Retry
                </button>
              </div>
            ) : tab === 'transcribe' ? (
              <TranscribeTab available={caps.transcription.available} />
            ) : (
              <GenerateTab
                providers={caps.tts.providers}
                defaultProvider={caps.tts.defaultProvider}
              />
            )}
          </div>
        </div>
      </ViewBody>
    </>
  );
};

const TabButton = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      appearance: 'none',
      padding: '7px 18px',
      borderRadius: 7,
      border: 'none',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      color: active ? '#fff' : C.muted,
      background: active ? C.accent : 'transparent',
      transition: 'background 150ms ease, color 150ms ease',
    }}
  >
    {children}
  </button>
);

const PageSpinner = () => (
  <span
    style={{
      display: 'inline-block',
      width: 14,
      height: 14,
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.3)',
      borderTopColor: 'var(--affine-primary-color, #1e96eb)',
      animation: 'cdz-voice-page-spin 0.7s linear infinite',
    }}
  >
    <style>{'@keyframes cdz-voice-page-spin{to{transform:rotate(360deg)}}'}</style>
  </span>
);

export const Component = () => {
  return <VoiceStudioPage />;
};
