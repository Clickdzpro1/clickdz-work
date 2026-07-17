import { PreviewCanvas } from '@affine/core/desktop/pages/workspace/vdz/preview-canvas';
import { VdzAudioPlayback } from '@affine/core/desktop/pages/workspace/vdz/audio-playback';
import { formatTimecode } from '@affine/core/desktop/pages/workspace/vdz/constants';
import {
  computeTimelineDuration,
  type VdzTimeline,
} from '@affine/core/modules/vdz';
import {
  useVdzProjects,
  type VdzProjectSummary,
} from '@affine/core/modules/vdz/use-vdz-projects';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Mobile Vdz — READ-ONLY. Browse your saved projects and PLAY them (visuals
 * via the editor's own PreviewCanvas, audio via the same gain engine —
 * workspace context exists here, so `vdz-blob:` media resolves normally).
 * Editing is deliberately desktop-only: the timeline/inspector surface needs
 * pointer precision this screen doesn't have. Registered at /vdz in the
 * mobile workbench (before the '/:pageId' catch route).
 */

const S = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: '16px 16px 32px',
    minHeight: '100%',
  },
  h1: { fontSize: 18, fontWeight: 700 },
  sub: { fontSize: 12.5, opacity: 0.6, lineHeight: 1.5 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    minHeight: 52,
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--affine-border-color, #333)',
    background: 'transparent',
    color: 'inherit',
    textAlign: 'left' as const,
    cursor: 'pointer',
    touchAction: 'manipulation' as const,
  },
  rowName: {
    fontSize: 14,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
    minWidth: 0,
  },
  rowDate: { fontSize: 11, opacity: 0.55, flexShrink: 0 },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap' as const,
    marginTop: 10,
  },
  playBtn: {
    appearance: 'none' as const,
    minHeight: 44,
    minWidth: 92,
    padding: '0 14px',
    borderRadius: 10,
    border: '1px solid var(--affine-border-color, #333)',
    background: 'var(--affine-background-secondary-color, rgba(0,0,0,0.06))',
    color: 'inherit',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    touchAction: 'manipulation' as const,
  },
  scrub: {
    flex: 1,
    minWidth: 140,
    height: 44,
    margin: 0,
    accentColor: 'var(--affine-primary-color, #5b8cff)',
    touchAction: 'pan-x' as const,
  },
  time: {
    fontSize: 12,
    opacity: 0.6,
    fontVariantNumeric: 'tabular-nums' as const,
    whiteSpace: 'nowrap' as const,
  },
  note: { fontSize: 12, opacity: 0.55, lineHeight: 1.6 },
} as const;

const MobileVdzPage = () => {
  const projects = useVdzProjects();
  const [list, setList] = useState<VdzProjectSummary[] | null>(null);
  const [openName, setOpenName] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<VdzTimeline | null>(null);
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // Load the project list once on mount.
  useEffect(() => {
    void projects
      .list()
      .then(setList)
      .catch(() => setList([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openProject = useCallback(
    (row: VdzProjectSummary) => {
      void projects
        .load(row.id)
        .then(doc => {
          setTimeline(doc.timeline as VdzTimeline);
          setOpenName(doc.name);
          setPlayheadSeconds(0);
          setIsPlaying(false);
        })
        .catch(() => {
          // projects.error carries the message; stay on the list.
        });
    },
    [projects]
  );

  const backToList = useCallback(() => {
    setIsPlaying(false);
    setTimeline(null);
    setOpenName(null);
  }, []);

  const duration = useMemo(
    () => (timeline ? computeTimelineDuration(timeline) : 0),
    [timeline]
  );

  // rAF master clock (read-only edition of the editor's loop).
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setPlayheadSeconds(prev => {
        const next = prev + dt;
        if (next >= durationRef.current) {
          setIsPlaying(false);
          return durationRef.current;
        }
        return next;
      });
      if (isPlayingRef.current) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  const togglePlay = useCallback(() => {
    setIsPlaying(prev => {
      if (!prev && playheadSeconds >= durationRef.current) {
        setPlayheadSeconds(0);
      }
      return !prev;
    });
  }, [playheadSeconds]);

  // ---- Player view ---------------------------------------------------------
  if (timeline) {
    return (
      <div style={S.page}>
        <button type="button" style={S.playBtn} onClick={backToList}>
          ← Projects
        </button>
        <div style={S.h1}>{openName ?? timeline.name}</div>

        <PreviewCanvas timeline={timeline} playheadSeconds={playheadSeconds} />
        <VdzAudioPlayback
          timeline={timeline}
          playheadSeconds={playheadSeconds}
          isPlaying={isPlaying}
        />

        <div style={S.controls}>
          <button type="button" style={S.playBtn} onClick={togglePlay}>
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>
          <input
            type="range"
            style={S.scrub}
            min={0}
            max={Math.max(duration, 0.1)}
            step={0.1}
            value={Math.min(playheadSeconds, Math.max(duration, 0.1))}
            onChange={e => {
              setIsPlaying(false);
              setPlayheadSeconds(Number(e.target.value));
            }}
            aria-label="Playhead"
          />
          <span style={S.time}>
            {formatTimecode(playheadSeconds)} / {formatTimecode(duration)}
          </span>
        </div>

        <div style={S.note}>
          View-only on mobile — open Vdz Studio on desktop to edit.
        </div>
      </div>
    );
  }

  // ---- List view -----------------------------------------------------------
  return (
    <div style={S.page}>
      <div style={S.h1}>Vdz Studio</div>
      <div style={S.sub}>
        Your saved video projects, view-only. Edit on desktop; share links play
        anywhere.
      </div>

      {list === null ? (
        <div style={S.note}>Loading…</div>
      ) : list.length === 0 ? (
        <div style={S.note}>
          No saved projects yet. Create one in Vdz Studio on desktop — it shows
          up here.
        </div>
      ) : (
        list.map(row => (
          <button
            key={row.id}
            type="button"
            style={S.row}
            onClick={() => openProject(row)}
          >
            <span style={S.rowName}>{row.name}</span>
            <span style={S.rowDate}>
              {new Date(row.updatedAt).toLocaleDateString()}
            </span>
          </button>
        ))
      )}
      {projects.error ? (
        <div style={{ ...S.note, color: '#ff6b6b' }}>{projects.error}</div>
      ) : null}
    </div>
  );
};

export const Component = () => {
  return <MobileVdzPage />;
};
