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
        <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
          Ma bibliothèque
        </span>
        {!loading ? (
          <span style={{ fontSize: 11.5, color: C.muted }}>
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
        <div
          style={{
            padding: '36px 12px',
            textAlign: 'center',
            color: C.muted,
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          <Spinner /> Chargement de la bibliothèque…
        </div>
      ) : clips.length === 0 ? (
        <div
          style={{
            padding: '36px 12px',
            textAlign: 'center',
            color: C.muted,
            fontSize: 13,
          }}
        >
          Aucun élément dans la bibliothèque. Générez un clip ou sauvegardez
          une transcription pour la retrouver ici.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {clips.map(item => (
            <div
              key={item.id}
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
                <KindBadge kind={item.kind} />
                <span
                  style={{
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
                <span style={{ flex: 1 }} />
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
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    style={{
      appearance: 'none',
      padding: '5px 11px',
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
      animation: 'cdz-voice-lib-spin 0.7s linear infinite',
    }}
  >
    <style>{'@keyframes cdz-voice-lib-spin{to{transform:rotate(360deg)}}'}</style>
  </span>
);