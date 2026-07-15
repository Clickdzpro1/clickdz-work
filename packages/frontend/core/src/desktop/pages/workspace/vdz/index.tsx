import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { nanoid } from 'nanoid';
import { useCallback, useMemo, useState } from 'react';

import {
  applyOp,
  computeTimelineDuration,
  createSampleTimeline,
  type VdzClip,
  type VdzTimeline,
} from '../../../../modules/vdz';
import * as styles from './index.css';

/** Lane accent colors keyed by track kind. */
const TRACK_COLORS: Record<VdzTimeline['tracks'][number]['kind'], string> = {
  video: '#5b8cff',
  overlay: '#a06bff',
  audio: '#3fb7a6',
};

function formatTimecode(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const mins = Math.floor(clamped / 60);
  const secs = Math.floor(clamped % 60);
  const frac = Math.floor((clamped - Math.floor(clamped)) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${frac}`;
}

/** Is a clip active (visible) at the given playhead time, in seconds? */
function isClipActive(clip: VdzClip, seconds: number): boolean {
  return seconds >= clip.start && seconds < clip.start + clip.duration;
}

/** Find a clip anywhere in the timeline by id. */
function findClip(
  timeline: VdzTimeline,
  clipId: string | null
): { clip: VdzClip; trackId: string } | null {
  if (!clipId) return null;
  for (const track of timeline.tracks) {
    const clip = track.clips.find(c => c.id === clipId);
    if (clip) return { clip, trackId: track.id };
  }
  return null;
}

/** Render a single clip inside the 16:9 preview at the current playhead. */
function PreviewClip({ clip }: { clip: VdzClip }) {
  switch (clip.type) {
    case 'text':
      return (
        <div
          className={styles.previewText}
          style={{
            left: `${(clip.x ?? 0.5) * 100}%`,
            top: `${(clip.y ?? 0.5) * 100}%`,
            fontSize: `${(clip.fontSize ?? 0.08) * 100}cqh`,
            color: clip.color ?? '#fff',
            textAlign: clip.align ?? 'center',
          }}
        >
          {clip.text}
        </div>
      );
    case 'shape':
      return (
        <div
          className={styles.previewLayer}
          style={{
            left: `${(clip.x ?? 0) * 100}%`,
            top: `${(clip.y ?? 0) * 100}%`,
            width: `${(clip.w ?? 1) * 100}%`,
            height: `${(clip.h ?? 1) * 100}%`,
            background: clip.color ?? '#5b8cff',
            borderRadius: clip.shape === 'circle' ? '50%' : 4,
          }}
        />
      );
    case 'image':
      return clip.src ? (
        <img
          className={styles.previewImage}
          src={clip.src}
          alt={clip.name ?? 'image clip'}
          style={{ objectFit: clip.fit ?? 'cover' }}
        />
      ) : (
        <div className={styles.previewImagePlaceholder}>
          image · empty src
        </div>
      );
    case 'video': {
      const label = clip.name ?? 'video';
      return (
        <div className={styles.previewVideoBlock}>
          {clip.src ? `▶ ${label}` : `video · ${label}`}
        </div>
      );
    }
    case 'audio':
      // Audio is not visible in the preview.
      return null;
    default:
      return null;
  }
}

const VdzStudioPage = () => {
  const [timeline, setTimeline] = useState<VdzTimeline>(() =>
    createSampleTimeline()
  );
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [opError, setOpError] = useState<string | null>(null);

  const duration = useMemo(() => computeTimelineDuration(timeline), [timeline]);

  const selected = useMemo(
    () => findClip(timeline, selectedClipId),
    [timeline, selectedClipId]
  );

  // Layers visible at the current playhead, back-to-front (video → overlay).
  // Audio tracks contribute nothing to the preview.
  const visibleLayers = useMemo(() => {
    const layers: VdzClip[] = [];
    for (const track of timeline.tracks) {
      if (track.kind === 'audio') continue;
      for (const clip of track.clips) {
        if (isClipActive(clip, playheadSeconds)) {
          layers.push(clip);
        }
      }
    }
    return layers;
  }, [timeline, playheadSeconds]);

  const runOp = useCallback(
    (op: Parameters<typeof applyOp>[1]) => {
      setTimeline(prev => {
        const result = applyOp(prev, op);
        setOpError(result.error ?? null);
        return result.timeline;
      });
    },
    []
  );

  const onScrub = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setPlayheadSeconds(Number(event.target.value));
  }, []);

  const onAddTextClip = useCallback(() => {
    const overlay = timeline.tracks.find(track => track.kind === 'overlay');
    if (!overlay) {
      setOpError('no overlay track to add a text clip to');
      return;
    }
    const start = Math.min(playheadSeconds, Math.max(0, duration - 2));
    runOp({
      op: 'addClip',
      trackId: overlay.id,
      clip: {
        id: `clip-${nanoid(6)}`,
        type: 'text',
        name: 'New text',
        start,
        duration: 3,
        text: 'New text',
        fontSize: 0.06,
        color: '#ffffff',
        x: 0.5,
        y: 0.5,
        align: 'center',
      },
    });
  }, [timeline, playheadSeconds, duration, runOp]);

  const onMoveSelected = useCallback(() => {
    if (!selected) {
      setOpError('select a clip first');
      return;
    }
    runOp({
      op: 'moveClip',
      trackId: selected.trackId,
      clipId: selected.clip.id,
      start: selected.clip.start + 1,
    });
  }, [selected, runOp]);

  const playheadPercent = duration > 0 ? (playheadSeconds / duration) * 100 : 0;

  return (
    <>
      <ViewTitle title="Vdz Studio" />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div className={styles.header}>
          <span className={styles.headerTitle}>Vdz Studio</span>
          <span className={styles.pill}>preview build</span>
          <span className={styles.timelineName}>{timeline.name}</span>
        </div>
      </ViewHeader>
      <ViewBody>
        <div className={styles.root}>
          <div className={styles.main}>
            {/* Preview + timeline stage */}
            <div className={styles.stage}>
              <div className={styles.previewWrapper}>
                <div className={styles.preview}>
                  {visibleLayers.length === 0 ? (
                    <div className={styles.previewEmpty}>
                      no clips at {formatTimecode(playheadSeconds)}
                    </div>
                  ) : (
                    visibleLayers.map(clip => (
                      <PreviewClip key={clip.id} clip={clip} />
                    ))
                  )}
                </div>
              </div>

              {/* Timeline */}
              <div className={styles.timeline}>
                <div className={styles.scrubberRow}>
                  <input
                    className={styles.scrubber}
                    type="range"
                    min={0}
                    max={Math.max(duration, 0.1)}
                    step={0.1}
                    value={playheadSeconds}
                    onChange={onScrub}
                    aria-label="Playhead"
                  />
                  <span className={styles.timecode}>
                    {formatTimecode(playheadSeconds)} /{' '}
                    {formatTimecode(duration)}
                  </span>
                </div>

                <div className={styles.lanes}>
                  {timeline.tracks.map(track => (
                    <div key={track.id} className={styles.lane}>
                      <span className={styles.laneLabel}>
                        {track.name ?? track.kind}
                      </span>
                      <div className={styles.laneTrack}>
                        {track.clips.map(clip => {
                          const left =
                            duration > 0 ? (clip.start / duration) * 100 : 0;
                          const width =
                            duration > 0
                              ? (clip.duration / duration) * 100
                              : 0;
                          const isSelected = clip.id === selectedClipId;
                          return (
                            <div
                              key={clip.id}
                              className={
                                isSelected
                                  ? `${styles.clipBlock} ${styles.clipBlockSelected}`
                                  : styles.clipBlock
                              }
                              style={{
                                left: `${left}%`,
                                width: `${width}%`,
                                background: TRACK_COLORS[track.kind],
                              }}
                              onClick={() => setSelectedClipId(clip.id)}
                              title={clip.name ?? clip.id}
                            >
                              {clip.name ?? clip.type}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {/* Playhead spans the lane stack. Offset accounts for the
                      fixed-width lane labels + gap (64px + 10px). */}
                  <div
                    className={styles.playhead}
                    style={{
                      left: `calc(74px + (100% - 74px) * ${playheadPercent / 100})`,
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Inspector */}
            <div className={styles.inspector}>
              <div className={styles.inspectorTitle}>Inspector</div>
              <div className={styles.inspectorBody}>
                {selected ? (
                  <>
                    <pre className={styles.jsonBlock}>
                      {JSON.stringify(selected.clip, null, 2)}
                    </pre>
                    <div className={styles.inspectorMeta}>
                      track: {selected.trackId}
                    </div>
                  </>
                ) : (
                  <div className={styles.inspectorHint}>
                    Select a clip in the timeline below to inspect its JSON.
                    Everything here is a validated <code>VdzTimeline</code> —
                    the same document the AI will edit via <code>VdzOp</code>s.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer / AI dock */}
          <div className={styles.footer}>
            <span className={styles.footerLabel}>
              <span className={styles.footerDot} />
              AI dock — arrives in P1
            </span>
            {opError ? (
              <span className={styles.errorText}>{opError}</span>
            ) : null}
            <span className={styles.footerSpacer} />
            <button
              type="button"
              className={styles.button}
              onClick={onAddTextClip}
            >
              Add text clip
            </button>
            <button
              type="button"
              className={styles.button}
              onClick={onMoveSelected}
            >
              Move selected +1s
            </button>
          </div>
        </div>
      </ViewBody>
    </>
  );
};

export const Component = () => {
  return <VdzStudioPage />;
};
