import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { AppAccessGate } from '@affine/core/modules/studio/app-access-gate';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { ensureClickDzResponsiveCss } from '@affine/core/clickdz/responsive';
import { GenerateTab } from './generate-tab';
import { LibraryTab } from './library-tab';
import { StudioTab } from './studio-tab';
import { TranscribeTab } from './transcribe-tab';
import { useIsNarrow } from './use-voice-responsive';
import {
  C,
  fetchVoiceCapabilities,
  type VoiceCapabilities,
} from './voice-shared';

const CdzResponsive = () => {
  ensureClickDzResponsiveCss();
  return null;
};

// ---------------------------------------------------------------------------
// ClickDz Voice Studio — DARK by default.
//
// A real, complete voice workspace on the /voice page. Three surfaces, all
// driven by GET /api/voice/capabilities (BRIDGE-BE C3):
//   • Studio    — ElevenLabs-style multi-segment generation (per-segment voice,
//                 emotion/instructions + presets, model/speed/format, inline
//                 streaming playback, per-segment + download-all, history).
//   • Transcribe— live-feeling + file transcription (OpenAI Whisper).
//   • Generate  — the classic single-shot text->speech (kept, still works).
//
// The page reflects the capabilities payload so each surface degrades
// gracefully when a provider key is missing (never a crash). No new .css.ts —
// inline styles only, mirroring the Integrations page's `C` palette scaffold.
// ---------------------------------------------------------------------------

type Tab = 'studio' | 'transcribe' | 'generate' | 'library';
type LoadState = 'loading' | 'ready' | 'error';

const VoiceStudioPage = () => {
  const [tab, setTab] = useState<Tab>('studio');
  const [state, setState] = useState<LoadState>('loading');
  const [caps, setCaps] = useState<VoiceCapabilities | null>(null);
  const isPhone = useIsNarrow(480);
  const isTablet = useIsNarrow(1024);

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
      <ViewTitle title="Studio Vocal" />
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
          {/* Gradient icon chip */}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 8,
              background: `linear-gradient(135deg, ${C.accent} 0%, color-mix(in srgb, ${C.accent} 60%, #a855f7) 100%)`,
              fontSize: 13,
              flexShrink: 0,
            }}
          >
            🎙️
          </span>
          Studio Vocal
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '15px',
              padding: '1px 7px',
              borderRadius: 6,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: C.accent,
              background: C.accentSoft,
              border: `1px solid ${C.accent}30`,
            }}
          >
            béta
          </span>
        </div>
      </ViewHeader>
      <ViewBody>
        <AppAccessGate app="VOICE">
        <CdzResponsive />
        <div
          data-cdz-surface=""
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
          {/* Subtle page-level gradient wash */}
          <style>{`
            @keyframes cdz-voice-page-spin{to{transform:rotate(360deg)}}
            @keyframes cdz-voice-skel{0%{opacity:.4}50%{opacity:.85}100%{opacity:.4}}
          `}</style>
          <div
            style={{
              maxWidth: 960,
              width: '100%',
              boxSizing: 'border-box',
              margin: '0 auto',
              padding: isPhone
                ? '20px 14px 40px'
                : isTablet
                  ? '24px 20px 48px'
                  : '32px 28px 56px',
              display: 'flex',
              flexDirection: 'column',
              gap: isPhone ? 16 : 24,
            }}
          >
            {/* Page header */}
            <header style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: isPhone ? 20 : 26,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  color: C.text,
                  letterSpacing: '-0.01em',
                }}
              >
                {/* Gradient icon chip — larger hero version */}
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    background: `linear-gradient(135deg, ${C.accent} 0%, color-mix(in srgb, ${C.accent} 55%, #a855f7) 100%)`,
                    fontSize: 20,
                    flexShrink: 0,
                    boxShadow: `0 4px 16px ${C.accent}40`,
                  }}
                >
                  🎙️
                </span>
                Studio Vocal
              </h1>
              <p style={{ margin: 0, color: C.muted, fontSize: 13, lineHeight: 1.6, maxWidth: 560 }}>
                Composez des narrations multi-voix avec émotion, transcrivez la parole en
                texte, et générez des voix-off naturelles — tout au même endroit.
              </p>
            </header>

            {/* Tab switcher — scrollable on phones so all three tabs stay
                reachable without clipping. scroll-snap keeps the active tab
                from sitting half off-screen. Desktop is unaffected. */}
            <div
              data-cdz-actions=""
              role="tablist"
              style={{
                display: 'flex',
                gap: 2,
                padding: 4,
                borderRadius: 12,
                background: C.panel,
                border: `1px solid ${C.border}`,
                alignSelf: 'flex-start',
                overflowX: 'auto',
                maxWidth: '100%',
                scrollSnapType: 'x mandatory',
                WebkitOverflowScrolling: 'touch',
                boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
              }}
            >
              <TabButton
                active={tab === 'studio'}
                onClick={() => setTab('studio')}
                icon="🎛"
              >
                Studio
              </TabButton>
              <TabButton
                active={tab === 'transcribe'}
                onClick={() => setTab('transcribe')}
                icon="📝"
              >
                Transcription
              </TabButton>
              <TabButton
                active={tab === 'generate'}
                onClick={() => setTab('generate')}
                icon="✨"
              >
                Générer
              </TabButton>
              <TabButton
                active={tab === 'library'}
                onClick={() => setTab('library')}
                icon="🗂"
              >
                Bibliothèque
              </TabButton>
            </div>

            {state === 'loading' ? (
              <LoadingSkeleton />
            ) : state === 'error' || !caps ? (
              <div
                style={{
                  padding: '16px 18px',
                  borderRadius: 12,
                  fontSize: 13,
                  background: C.errBg,
                  border: `1px solid ${C.errBorder}`,
                  color: C.text,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
                <span>
                  Impossible de charger le Studio Vocal.{' '}
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
                      fontWeight: 600,
                    }}
                  >
                    Réessayer
                  </button>
                </span>
              </div>
            ) : tab === 'studio' ? (
              <StudioTab caps={caps} />
            ) : tab === 'transcribe' ? (
              <TranscribeTab available={caps.transcription.available} />
            ) : tab === 'library' ? (
              <LibraryTab />
            ) : (
              <GenerateTab
                providers={caps.tts.providers}
                defaultProvider={caps.tts.defaultProvider}
              />
            )}
          </div>
        </div>
        </AppAccessGate>
      </ViewBody>
    </>
  );
};

const TabButton = ({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon?: string;
  children: ReactNode;
}) => {
  const isPhone = useIsNarrow(480);
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        appearance: 'none',
        /* >=44 px min-height for comfortable touch target (WCAG 2.5.5). */
        minHeight: 44,
        padding: isPhone ? '9px 12px' : '8px 16px',
        borderRadius: 9,
        border: 'none',
        fontSize: 13,
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
        flexShrink: 0,
        scrollSnapAlign: 'start',
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: active ? '#fff' : hovered ? C.text : C.muted,
        background: active
          ? `linear-gradient(135deg, ${C.accent} 0%, color-mix(in srgb, ${C.accent} 70%, #7c3aed) 100%)`
          : hovered
            ? `color-mix(in srgb, ${C.accent} 10%, transparent)`
            : 'transparent',
        boxShadow: active ? `0 2px 8px ${C.accent}50` : 'none',
        transition: 'background 160ms ease, color 160ms ease, box-shadow 160ms ease, font-weight 120ms ease',
      }}
    >
      {icon ? (
        <span style={{ fontSize: 12, opacity: active ? 1 : 0.75 }}>{icon}</span>
      ) : null}
      {children}
    </button>
  );
};

/** Skeleton shimmer loader — replaces bare "Chargement…" text. */
const LoadingSkeleton = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
    <style>
      {`@keyframes cdz-voice-page-skel{0%{opacity:.35}50%{opacity:.7}100%{opacity:.35}}`}
    </style>
    {/* Provider cards skeleton */}
    <div
      style={{
        borderRadius: 13,
        border: `1px solid ${C.border}`,
        background: C.panel,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <SkeletonBar width={80} height={11} />
      <div style={{ display: 'flex', gap: 12 }}>
        <SkeletonBar width="48%" height={64} radius={11} />
        <SkeletonBar width="48%" height={64} radius={11} />
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <SkeletonBar width={160} height={36} radius={8} />
        <SkeletonBar width={120} height={36} radius={8} />
      </div>
    </div>
    {/* Starters skeleton */}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {[110, 130, 100, 120].map((w, i) => (
        <SkeletonBar key={i} width={w} height={34} radius={999} />
      ))}
    </div>
    {/* Segment skeleton */}
    <div
      style={{
        borderRadius: 13,
        border: `1px solid ${C.border}`,
        background: C.panel,
        padding: 15,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <SkeletonBar width={60} height={22} radius={999} />
      <SkeletonBar width="100%" height={80} radius={9} />
      <SkeletonBar width={200} height={32} radius={8} />
    </div>
  </div>
);

const SkeletonBar = ({
  width,
  height,
  radius = 6,
}: {
  width: number | string;
  height: number;
  radius?: number;
}) => (
  <div
    style={{
      width,
      height,
      borderRadius: radius,
      background: `color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 14%, transparent)`,
      animation: 'cdz-voice-page-skel 1.5s ease-in-out infinite',
    }}
  />
);

export const Component = () => {
  return <VoiceStudioPage />;
};
