// ---------------------------------------------------------------------------
// Voice Studio — "Library" tab.
//
// Lists the caller's saved Voice Studio outputs (synthesized clips + saved
// transcripts) from GET /api/v1/voice/library/clips. Clips play inline and can
// be downloaded; transcripts can be re-saved as .txt / .srt. Any row can be
// deleted from the library. All inline-styled, dark palette, fail-soft.
// ---------------------------------------------------------------------------
import {
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';

import { useIsNarrow } from './use-voice-responsive';
import {
  C,
  cuesToSrt,
  deleteLibraryClip,
  downloadTextFile,
  listLibraryClips,
  type LibraryClipItem,
  textToCues,
} from './voice-shared';

interface LibraryTabProps {
  /** Version bump to refetch when a new clip is saved elsewhere on the page. */
  reloadKey?: number;
}

export const LibraryTab = ({ reloadKey = 0 }: LibraryTabProps) => {
  const isPhone = useIsNarrow(480);
  const [clips, setClips] = useState<LibraryClipItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const out = await listLibraryClips();
    setLoading(false);
    if (out.ok) {
      setClips(out.clips);
      setNotice(null);
    } else {
      setNotice(
        'Impossible de charger la bibliothèque — réessayez dans un instant.'
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const downloadClip = useCallback((item: LibraryClipItem) => {
    const a = document.createElement('a');
    a.href = item.url;
    a.download = `${item.name || 'clip'}.mp3`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const downloadTranscriptAs = useCallback(
    (item: LibraryClipItem, ext: 'txt' | 'srt') => {
      void (async () => {
        try {
          const res = await fetch(item.url, { credentials: 'include' });
          if (!res.ok) {
            setNotice('Impossible de récupérer la transcription.');
            return;
          }
          const text = await res.text();
          if (ext === 'txt') {
            downloadTextFile(`${item.name || 'transcript'}.txt`, text);
          } else {
            // Best-effort SRT from the plain text (no word timings are stored
            // for a saved transcript, so we distribute evenly over a nominal
            // read).
            const cues = textToCues(text, Math.max(0, text.length / 15));
            downloadTextFile(
              `${item.name || 'transcript'}.srt`,
              cues.length ? cuesToSrt(cues) : text,
              'text/plain'
            );
          }
        } catch {
          setNotice('Impossible de récupérer la transcription.');
        }
      })();
    },
    []
  );

  const remove = useCallback(
    async (id: string) => {
      const out = await deleteLibraryClip(id);
      if (out.ok) {
        setClips(prev => prev.filter(c => c.id !== id));
        setNotice(null);
      } else {
        setNotice('Suppression impossible — réessayez.');
      }
    },
    []
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header + refresh */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.07em',
            textTransform: 'uppercase',
            color: C.muted,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 20,
              height: 20,
              borderRadius: 6,
              background: `linear-gradient(135deg, ${C.accent} 0%, color-mix(in srgb, ${C.accent} 55%, #06b6d4) 100%)`,
              fontSize: 11,
            }}
          >
            🗂
          </span>
          Ma bibliothèque
        </div>
        {!loading ? (
          <span
            style={{
              fontSize: 11,
              color: C.muted,
              padding: '2px 8px',
              borderRadius: 999,
              background: `color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 12%, transparent)`,
            }}
          >
            {clips.length} élément{clips.length === 1 ? '' : 's'}
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        <ActionButton onClick={() => void load()} disabled={loading}>
          Actualiser
        </ActionButton>
      </div>

      {notice ? (
        <div
          style={{
            padding: '10px 13px',
            borderRadius: 9,
            fontSize: 12.5,
            background: C.warnBg,
            border: `1px solid ${C.warnBorder}`,
            color: C.text,
          }}
        >
          {notice}
        </div>
      ) : null}

      {loading ? (
        <LibrarySkeleton />
      ) : clips.length === 0 ? (
        <div
          style={{
            padding: '48px 24px',
            textAlign: 'center',
            color: C.muted,
            fontSize: 13,
            border: `1px dashed ${C.border}`,
            borderRadius: 14,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span style={{ fontSize: 32, opacity: 0.4 }}>🗂</span>
          <span style={{ fontWeight: 600, color: C.text, fontSize: 14 }}>
            Bibliothèque vide
          </span>
          <span style={{ maxWidth: 320 }}>
            Générez un clip ou sauvegardez une transcription pour le retrouver ici.
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {clips.map(item => (
            <div
              key={item.id}
              style={{
                borderRadius: 14,
                border: `1px solid ${C.border}`,
                background: C.panel,
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
                transition: 'border-color 140ms ease, box-shadow 140ms ease',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: isPhone ? 'wrap' : 'nowrap',
                }}
              >
                <KindBadge kind={item.kind} />
                <span
                  style={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    fontSize: 13,
                    fontWeight: 600,
                    color: C.text,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.name}
                </span>
                {!isPhone ? <span style={{ flex: 1 }} /> : null}
                <span
                  style={{ fontSize: 11, color: C.muted, whiteSpace: 'nowrap' }}
                >
                  {new Date(item.createdAt).toLocaleDateString()}
                </span>
              </div>

              {item.kind === 'tts' ? (
                <>
                  <audio
                    src={item.url}
                    controls
                    preload="none"
                    style={{ width: '100%', height: 34 }}
                  >
                    Your browser does not support audio playback.
                  </audio>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <ActionButton onClick={() => downloadClip(item)}>
                      Télécharger
                    </ActionButton>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ActionButton onClick={() => void downloadTranscriptAs(item, 'txt')}>
                    .txt
                  </ActionButton>
                  <ActionButton onClick={() => void downloadTranscriptAs(item, 'srt')}>
                    .srt
                  </ActionButton>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ActionButton onClick={() => void remove(item.id)}>
                  Supprimer
                </ActionButton>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ---- small inline helpers -------------------------------------------------

const KindBadge = ({ kind }: { kind: 'tts' | 'transcript' }) => (
  <span
    style={{
      fontSize: 10,
      fontWeight: 700,
      padding: '2px 8px',
      borderRadius: 999,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      color: kind === 'tts' ? C.accent : C.okText,
      background: kind === 'tts' ? C.accentSoft : 'color-mix(in srgb, #4cae4c 12%, transparent)',
    }}
  >
    {kind === 'tts' ? 'Clip audio' : 'Transcription'}
  </span>
);

const ActionButton = ({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) => {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        appearance: 'none',
        padding: '6px 13px',
        minHeight: 40,
        borderRadius: 8,
        border: `1px solid ${hovered && !disabled ? C.accent + '70' : C.border}`,
        background: hovered && !disabled
          ? `color-mix(in srgb, ${C.accent} 8%, transparent)`
          : 'transparent',
        color: disabled ? C.muted : hovered ? C.accent : C.text,
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 140ms ease, border-color 140ms ease, color 140ms ease',
      }}
    >
      {children}
    </button>
  );
};

const LibrarySkeleton = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <style>{'@keyframes cdz-lib-skel{0%{opacity:.35}50%{opacity:.75}100%{opacity:.35}}'}</style>
    {[1, 2, 3].map(i => (
      <div
        key={i}
        style={{
          borderRadius: 12,
          border: `1px solid ${C.border}`,
          background: C.panel,
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 70,
              height: 20,
              borderRadius: 999,
              background: `color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 14%, transparent)`,
              animation: 'cdz-lib-skel 1.4s ease-in-out infinite',
              animationDelay: `${i * 0.15}s`,
            }}
          />
          <div
            style={{
              flex: 1,
              height: 14,
              borderRadius: 6,
              background: `color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 10%, transparent)`,
              animation: 'cdz-lib-skel 1.4s ease-in-out infinite',
              animationDelay: `${i * 0.15 + 0.1}s`,
            }}
          />
        </div>
        <div
          style={{
            height: 34,
            borderRadius: 6,
            background: `color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 8%, transparent)`,
            animation: 'cdz-lib-skel 1.4s ease-in-out infinite',
            animationDelay: `${i * 0.15 + 0.2}s`,
          }}
        />
      </div>
    ))}
  </div>
);