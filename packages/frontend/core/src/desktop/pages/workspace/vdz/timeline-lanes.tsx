import { useCallback, useMemo, useRef, useState } from 'react';

import type { VdzClip, VdzOp, VdzTimeline } from '../../../../modules/vdz';
import {
  LANE_LABEL_WIDTH,
  MIN_CLIP_DURATION,
  SNAP_PX,
  TRACK_COLORS,
  TRIM_HANDLE_PX,
} from './constants';
import * as styles from './index.css';
import { TimeRuler } from './time-ruler';

type TrackKind = VdzTimeline['tracks'][number]['kind'];

type DragMode = 'move' | 'trim-l' | 'trim-r';

interface DragState {
  mode: DragMode;
  trackId: string;
  trackKind: TrackKind;
  clipId: string;
  pointerId: number;
  startClientX: number;
  origStart: number;
  origDuration: number;
  origTrimStart: number | undefined;
  isVideo: boolean;
  /** Live values recomputed on every pointermove. */
  ghostStart: number;
  ghostDuration: number;
  ghostTrackId: string;
  /** Seconds at which a snap guide should be drawn, or null. */
  snapSeconds: number | null;
}

interface TimelineLanesProps {
  timeline: VdzTimeline;
  pxPerSec: number;
  playheadSeconds: number;
  selectedIds: ReadonlySet<string>;
  /** Total ruler/lane span in seconds (duration padded a little). */
  spanSeconds: number;
  /** Click a clip: shiftKey toggles multi-select, plain click selects one. */
  onSelectClip: (clipId: string, shiftKey: boolean) => void;
  /** Set playhead by clicking an empty area of a lane / the ruler track. */
  onScrubToSeconds: (seconds: number) => void;
  /** Ctrl/Cmd-wheel over the lanes changes zoom. */
  onZoomWheel: (deltaY: number) => void;
  /** Commit a single move/trim op (already snapped/clamped). */
  onCommitOp: (op: VdzOp) => void;
}

/** Round a seconds value to a sane timeline precision (avoids float noise). */
function roundSec(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Px-based, horizontally-scrollable lane stack with drag-to-move, edge trim
 * handles, snapping, a live ghost, multi-select and an overlaid playhead.
 *
 * All committing interactions emit exactly ONE {@link VdzOp} via `onCommitOp`
 * on pointerup; the live ghost is purely visual until then.
 */
export function TimelineLanes({
  timeline,
  pxPerSec,
  playheadSeconds,
  selectedIds,
  spanSeconds,
  onSelectClip,
  onScrubToSeconds,
  onZoomWheel,
  onCommitOp,
}: TimelineLanesProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  // Live rects of each lane track element, for cross-lane hit testing.
  const laneRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const contentWidth = spanSeconds * pxPerSec;

  const kindOfTrack = useCallback(
    (trackId: string): TrackKind | undefined =>
      timeline.tracks.find(t => t.id === trackId)?.kind,
    [timeline]
  );

  // Snap a candidate second to the nearest of: playhead, whole seconds, and
  // every other clip edge on the destination track. Returns the snapped value
  // plus the guide position, or the original value with a null guide.
  const snap = useCallback(
    (
      seconds: number,
      destTrackId: string,
      excludeClipId: string
    ): { value: number; guide: number | null } => {
      const thresholdSec = SNAP_PX / pxPerSec;
      const candidates: number[] = [playheadSeconds, Math.round(seconds)];
      const destTrack = timeline.tracks.find(t => t.id === destTrackId);
      if (destTrack) {
        for (const clip of destTrack.clips) {
          if (clip.id === excludeClipId) continue;
          candidates.push(clip.start, clip.start + clip.duration);
        }
      }
      let best: number | null = null;
      let bestDist = thresholdSec;
      for (const cand of candidates) {
        const dist = Math.abs(cand - seconds);
        if (dist <= bestDist) {
          bestDist = dist;
          best = cand;
        }
      }
      return best === null
        ? { value: seconds, guide: null }
        : { value: best, guide: best };
    },
    [pxPerSec, playheadSeconds, timeline]
  );

  const onClipPointerDown = useCallback(
    (
      event: React.PointerEvent<HTMLDivElement>,
      trackId: string,
      clip: VdzClip
    ) => {
      // Left button only; ignore modified clicks used for selection.
      if (event.button !== 0) return;
      const kind = kindOfTrack(trackId);
      if (!kind) return;

      const rect = event.currentTarget.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      let mode: DragMode = 'move';
      if (offsetX <= TRIM_HANDLE_PX) mode = 'trim-l';
      else if (offsetX >= rect.width - TRIM_HANDLE_PX) mode = 'trim-r';

      event.currentTarget.setPointerCapture(event.pointerId);
      event.stopPropagation();

      setDrag({
        mode,
        trackId,
        trackKind: kind,
        clipId: clip.id,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        origStart: clip.start,
        origDuration: clip.duration,
        origTrimStart: clip.type === 'video' ? clip.trimStart : undefined,
        isVideo: clip.type === 'video',
        ghostStart: clip.start,
        ghostDuration: clip.duration,
        ghostTrackId: trackId,
        snapSeconds: null,
      });
    },
    [kindOfTrack]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const deltaSec = (event.clientX - drag.startClientX) / pxPerSec;

      if (drag.mode === 'move') {
        // Which lane is the pointer over? Only retarget to a compatible kind.
        let ghostTrackId = drag.trackId;
        for (const [tid, rect] of laneRectsRef.current) {
          if (
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom &&
            kindOfTrack(tid) === drag.trackKind
          ) {
            ghostTrackId = tid;
            break;
          }
        }
        const rawStart = Math.max(0, drag.origStart + deltaSec);
        // Snap the start; also try snapping the end (whichever edge is closer).
        const startSnap = snap(rawStart, ghostTrackId, drag.clipId);
        const endSnap = snap(
          rawStart + drag.origDuration,
          ghostTrackId,
          drag.clipId
        );
        let ghostStart = startSnap.value;
        let guide = startSnap.guide;
        if (
          endSnap.guide !== null &&
          (startSnap.guide === null ||
            Math.abs(endSnap.value - (rawStart + drag.origDuration)) <
              Math.abs(startSnap.value - rawStart))
        ) {
          ghostStart = endSnap.value - drag.origDuration;
          guide = endSnap.guide;
        }
        ghostStart = Math.max(0, ghostStart);
        setDrag({
          ...drag,
          ghostStart: roundSec(ghostStart),
          ghostTrackId,
          snapSeconds: guide,
        });
        return;
      }

      if (drag.mode === 'trim-l') {
        const rawStart = Math.max(0, drag.origStart + deltaSec);
        const { value: snapped, guide } = snap(
          rawStart,
          drag.trackId,
          drag.clipId
        );
        // Left edge cannot cross the (fixed) right edge minus the minimum.
        const origEnd = drag.origStart + drag.origDuration;
        const newStart = Math.min(snapped, origEnd - MIN_CLIP_DURATION);
        setDrag({
          ...drag,
          ghostStart: roundSec(Math.max(0, newStart)),
          ghostDuration: roundSec(origEnd - Math.max(0, newStart)),
          snapSeconds: guide,
        });
        return;
      }

      // trim-r
      const rawEnd = drag.origStart + drag.origDuration + deltaSec;
      const { value: snappedEnd, guide } = snap(
        rawEnd,
        drag.trackId,
        drag.clipId
      );
      const newDuration = Math.max(
        MIN_CLIP_DURATION,
        snappedEnd - drag.origStart
      );
      setDrag({
        ...drag,
        ghostDuration: roundSec(newDuration),
        snapSeconds: guide,
      });
    },
    [drag, pxPerSec, snap, kindOfTrack]
  );

  const finishDrag = useCallback(() => {
    if (!drag) return;
    const current = drag;
    setDrag(null);

    if (current.mode === 'move') {
      const changedTrack = current.ghostTrackId !== current.trackId;
      const changedStart = current.ghostStart !== current.origStart;
      if (!changedTrack && !changedStart) return;
      onCommitOp({
        op: 'moveClip',
        trackId: current.trackId,
        clipId: current.clipId,
        start: current.ghostStart,
        ...(changedTrack ? { toTrackId: current.ghostTrackId } : {}),
      });
      return;
    }

    if (current.mode === 'trim-l') {
      if (
        current.ghostStart === current.origStart &&
        current.ghostDuration === current.origDuration
      ) {
        return;
      }
      const trimDelta = current.ghostStart - current.origStart;
      onCommitOp({
        op: 'trimClip',
        trackId: current.trackId,
        clipId: current.clipId,
        start: current.ghostStart,
        duration: current.ghostDuration,
        // Video read head advances by however far the left edge moved right.
        ...(current.isVideo
          ? {
              trimStart: Math.max(
                0,
                roundSec((current.origTrimStart ?? 0) + trimDelta)
              ),
            }
          : {}),
      });
      return;
    }

    // trim-r
    if (current.ghostDuration === current.origDuration) return;
    onCommitOp({
      op: 'trimClip',
      trackId: current.trackId,
      clipId: current.clipId,
      duration: current.ghostDuration,
    });
  }, [drag, onCommitOp]);

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        onZoomWheel(event.deltaY);
      }
    },
    [onZoomWheel]
  );

  // Click on empty lane space → move the playhead there.
  const onTrackBackgroundPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const seconds = (event.clientX - rect.left) / pxPerSec;
      onScrubToSeconds(Math.max(0, roundSec(seconds)));
    },
    [pxPerSec, onScrubToSeconds]
  );

  const registerLaneRect = useCallback(
    (trackId: string, el: HTMLDivElement | null) => {
      if (el) laneRectsRef.current.set(trackId, el.getBoundingClientRect());
      else laneRectsRef.current.delete(trackId);
    },
    []
  );

  const snapGuideLeft = useMemo(
    () => (drag?.snapSeconds != null ? drag.snapSeconds * pxPerSec : null),
    [drag, pxPerSec]
  );

  return (
    <div className={styles.lanesViewport}>
      {/* Fixed label column (does not scroll horizontally). */}
      <div
        className={styles.laneLabelColumn}
        style={{ width: LANE_LABEL_WIDTH }}
      >
        <div className={styles.laneLabelRulerSpacer} />
        {timeline.tracks.map(track => (
          <div key={track.id} className={styles.laneLabelCell}>
            {track.name ?? track.kind}
          </div>
        ))}
      </div>

      {/* Scroll container: ruler + lanes + playhead share one width & scroll. */}
      <div className={styles.lanesScroll} onWheel={onWheel}>
        <div className={styles.lanesContent} style={{ width: contentWidth }}>
          <TimeRuler spanSeconds={spanSeconds} pxPerSec={pxPerSec} />

          <div className={styles.laneStack}>
            {timeline.tracks.map(track => (
              <div
                key={track.id}
                className={styles.laneRow}
                ref={el => registerLaneRect(track.id, el)}
                onPointerDown={onTrackBackgroundPointerDown}
              >
                {track.clips.map(clip => {
                  // Non-null only while THIS clip is the one being dragged.
                  const dragThis =
                    drag && drag.clipId === clip.id ? drag : null;
                  // A dragged clip renders at its ghost geometry, on the ghost
                  // lane (skip it on every other lane so it doesn't duplicate).
                  if (dragThis && dragThis.ghostTrackId !== track.id) {
                    return null;
                  }
                  const start = dragThis ? dragThis.ghostStart : clip.start;
                  const dur = dragThis ? dragThis.ghostDuration : clip.duration;
                  const isSelected = selectedIds.has(clip.id);
                  const classes = [styles.clipBlock];
                  if (isSelected) classes.push(styles.clipBlockSelected);
                  if (dragThis) classes.push(styles.clipBlockDragging);
                  return (
                    <div
                      key={clip.id}
                      className={classes.join(' ')}
                      style={{
                        left: start * pxPerSec,
                        width: Math.max(2, dur * pxPerSec),
                        background: TRACK_COLORS[track.kind],
                      }}
                      onClick={e => {
                        e.stopPropagation();
                        onSelectClip(clip.id, e.shiftKey);
                      }}
                      onPointerDown={e => onClipPointerDown(e, track.id, clip)}
                      onPointerMove={onPointerMove}
                      onPointerUp={finishDrag}
                      onPointerCancel={finishDrag}
                      title={clip.name ?? clip.id}
                    >
                      <span className={styles.clipTrimHandleLeft} />
                      <span className={styles.clipLabel}>
                        {clip.name ?? clip.type}
                      </span>
                      <span className={styles.clipTrimHandleRight} />
                    </div>
                  );
                })}
              </div>
            ))}

            {/* Snap guide, drawn only while a snap is active. */}
            {snapGuideLeft !== null ? (
              <div
                className={styles.snapGuide}
                style={{ left: snapGuideLeft }}
              />
            ) : null}

            {/* Playhead spans the lane stack (not the ruler above it). */}
            <div
              className={styles.lanePlayhead}
              style={{ left: playheadSeconds * pxPerSec }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
