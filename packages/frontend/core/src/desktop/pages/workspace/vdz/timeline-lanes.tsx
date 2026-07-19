import { nanoid } from 'nanoid';
import { useCallback, useMemo, useRef, useState } from 'react';

import type {
  VdzClip,
  VdzOp,
  VdzTimeline,
  VdzTransition,
} from '../../../../modules/vdz';
import { AudioClipWaveform } from './audio-waveform';
import {
  LANE_LABEL_WIDTH,
  MIN_CLIP_DURATION,
  SNAP_PX,
  TRACK_COLORS,
  TRIM_HANDLE_PX,
  VDZ_MEDIA_DND_MIME,
  type VdzMediaDragPayload,
} from './constants';
import * as styles from './index.css';
import { TimeRuler } from './time-ruler';
import * as ex from './timeline-extras.css';

type TrackKind = VdzTimeline['tracks'][number]['kind'];

/** Transition kinds offered by the between-clip picker. */
const TRANSITION_KINDS: VdzTransition['kind'][] = ['fade', 'slide', 'wipe'];
/** Duration presets (seconds) offered by the picker. */
const TRANSITION_DURATIONS = [0.3, 0.5, 1] as const;

/** Which between-clip boundary's add-picker is open. */
interface OpenPicker {
  trackId: string;
  /** id of the clip the transition would sit AFTER. */
  afterClipId: string;
}

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
  /**
   * A media-bin item was dropped on a lane. `trackId` is the drop target and
   * `atSeconds` is the pointer position mapped to timeline seconds. The host
   * turns this into a single `addClip` op (routed through the history path).
   */
  onDropMedia?: (
    payload: VdzMediaDragPayload,
    trackId: string,
    atSeconds: number
  ) => void;
  /**
   * Raw files were dropped on a lane. Imported through the same pipeline as the
   * Upload tab; `trackId`/`atSeconds` give the drop location for placement.
   */
  onDropFiles?: (files: FileList, trackId: string, atSeconds: number) => void;
}

/** Round a seconds value to a sane timeline precision (avoids float noise). */
function roundSec(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * `mm:ss.ff` clock for the playhead readout, where `ff` is the FRAME within the
 * current second (0..fps-1), derived from fps. Frame-accurate: snaps the whole
 * time to the nearest frame first so the seconds/frame split never disagrees at
 * a boundary (e.g. 1.999s @30 → 02.00, not 01.30).
 */
function formatClockFrames(seconds: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  const totalFrames = Math.max(0, Math.round(seconds * safeFps));
  const totalWholeSec = Math.floor(totalFrames / safeFps);
  const frame = totalFrames - totalWholeSec * safeFps;
  const mins = Math.floor(totalWholeSec / 60);
  const secs = totalWholeSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(
    frame
  ).padStart(2, '0')}`;
}

/** Absolute frame number at a time (round(sec * fps)). */
function frameAt(seconds: number, fps: number): number {
  const safeFps = fps > 0 ? fps : 30;
  return Math.max(0, Math.round(seconds * safeFps));
}

/** A friendly, kind-specific empty-lane hint. */
function emptyHintText(kind: TrackKind): string {
  switch (kind) {
    case 'video':
      return 'Drop video or images here';
    case 'audio':
      return 'Drop music or voiceover here';
    default:
      return 'Drop text or shapes here';
  }
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
  onDropMedia,
  onDropFiles,
}: TimelineLanesProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  // Track id currently under a drag-drop hover (for the drop highlight).
  const [dropTrackId, setDropTrackId] = useState<string | null>(null);
  // Which between-clip boundary is showing its "add transition" picker.
  const [openPicker, setOpenPicker] = useState<OpenPicker | null>(null);
  // The "add lane" menu (video / overlay-text / audio-music).
  const [addLaneOpen, setAddLaneOpen] = useState(false);
  // Live rects of each lane track element, for cross-lane hit testing.
  const laneRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const contentWidth = spanSeconds * pxPerSec;

  // Mirror the playhead into a ref so drag-time helpers (snap / pointer-move)
  // can read it WITHOUT taking it as a dep. During playback the playhead churns
  // every rAF frame; keeping those callbacks referentially stable means the
  // memoized lane content (clips + boundaries) does NOT re-render each tick —
  // only the playhead line moves. Snapping still uses the live value (there is
  // never a drag in flight during playback, so the ref is always current then).
  const playheadRef = useRef(playheadSeconds);
  playheadRef.current = playheadSeconds;

  // ---- Hover time indicator (ghost line + tooltip) ----------------------
  // Purely visual, driven imperatively so it never triggers React re-renders
  // or re-layout on pointer move: the handler writes a `transform` + tooltip
  // text directly to two refs. It reads zoom / drag through refs so the
  // callbacks stay referentially stable and never see a stale closure.
  const laneStackRef = useRef<HTMLDivElement | null>(null);
  const hoverLineRef = useRef<HTMLDivElement | null>(null);
  const hoverTipRef = useRef<HTMLDivElement | null>(null);
  const pxPerSecRef = useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;
  const fpsRef = useRef(timeline.fps);
  fpsRef.current = timeline.fps;
  const draggingRef = useRef(false);
  draggingRef.current = drag !== null;

  const setHoverVisible = useCallback((visible: boolean) => {
    const line = hoverLineRef.current;
    const tip = hoverTipRef.current;
    if (line) line.classList.toggle(ex.hoverLineVisible, visible);
    if (tip) tip.classList.toggle(ex.hoverTipVisible, visible);
  }, []);

  const onHoverMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // While a clip is being dragged/trimmed the snap guide + ghost own the
      // space; keep the hover indicator out of the way (and never interfere
      // with the drag — this handler only ever reads, never preventDefault's).
      if (draggingRef.current) {
        setHoverVisible(false);
        return;
      }
      const stack = laneStackRef.current;
      if (!stack) return;
      const rect = stack.getBoundingClientRect();
      const x = Math.round(event.clientX - rect.left);
      if (x < 0 || x > rect.width) {
        setHoverVisible(false);
        return;
      }
      const line = hoverLineRef.current;
      const tip = hoverTipRef.current;
      const seconds = Math.max(0, x / (pxPerSecRef.current || 1));
      if (line) line.style.transform = `translateX(${x}px)`;
      if (tip) {
        tip.style.transform = `translateX(${x}px) translateX(-50%)`;
        tip.textContent = formatClockFrames(seconds, fpsRef.current);
      }
      setHoverVisible(true);
    },
    [setHoverVisible]
  );

  const onHoverLeave = useCallback(() => {
    setHoverVisible(false);
  }, [setHoverVisible]);

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
      const candidates: number[] = [playheadRef.current, Math.round(seconds)];
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
    [pxPerSec, timeline]
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

  // ---- Drag & drop of media (bin items or raw files) onto a lane --------
  // A drop is only meaningful if the host wired a handler; the payload is read
  // on drop (dragover can only see MIME *types*, not values).
  const canAcceptDrop = Boolean(onDropMedia || onDropFiles);

  const onLaneDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>, trackId: string) => {
      if (!canAcceptDrop) return;
      const types = Array.from(event.dataTransfer.types);
      const isMedia = types.includes(VDZ_MEDIA_DND_MIME);
      const isFiles = types.includes('Files');
      if (!isMedia && !isFiles) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      if (dropTrackId !== trackId) setDropTrackId(trackId);
    },
    [canAcceptDrop, dropTrackId]
  );

  const onLaneDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>, trackId: string) => {
      if (!canAcceptDrop) return;
      setDropTrackId(null);
      const rect = event.currentTarget.getBoundingClientRect();
      // Same coordinate model as the ruler/clip layout: x → seconds at zoom.
      const atSeconds = Math.max(
        0,
        roundSec((event.clientX - rect.left) / pxPerSec)
      );

      const raw = event.dataTransfer.getData(VDZ_MEDIA_DND_MIME);
      if (raw) {
        event.preventDefault();
        try {
          const payload = JSON.parse(raw) as VdzMediaDragPayload;
          onDropMedia?.(payload, trackId, atSeconds);
        } catch {
          // Malformed payload — ignore silently (never mutate on bad input).
        }
        return;
      }

      const files = event.dataTransfer.files;
      if (files && files.length > 0) {
        event.preventDefault();
        onDropFiles?.(files, trackId, atSeconds);
      }
    },
    [canAcceptDrop, pxPerSec, onDropMedia, onDropFiles]
  );

  const snapGuideLeft = useMemo(
    () => (drag?.snapSeconds != null ? drag.snapSeconds * pxPerSec : null),
    [drag, pxPerSec]
  );

  // Add a transition on a boundary (after `afterClipId`) via one applyTransition
  // op, then close the picker.
  const addTransition = useCallback(
    (
      trackId: string,
      afterClipId: string,
      kind: VdzTransition['kind'],
      duration: number
    ) => {
      onCommitOp({
        op: 'applyTransition',
        trackId,
        transition: { id: `xfade-${nanoid(6)}`, kind, afterClipId, duration },
      });
      setOpenPicker(null);
    },
    [onCommitOp]
  );

  const removeTransition = useCallback(
    (trackId: string, transitionId: string) => {
      onCommitOp({ op: 'removeTransition', trackId, transitionId });
    },
    [onCommitOp]
  );

  // Add a new empty lane. Overlay lanes host text + shapes, so "more text"
  // and "more overlays" are the same op; audio lanes host music/voiceover.
  const addLane = useCallback(
    (kind: TrackKind, name: string) => {
      onCommitOp({
        op: 'addTrack',
        track: { id: `track-${kind}-${nanoid(4)}`, kind, name, clips: [] },
      });
      setAddLaneOpen(false);
    },
    [onCommitOp]
  );

  // Adjacent-clip boundaries per track: pairs where clip[i] ends exactly where
  // clip[i+1] starts. Each carries any existing transition after clip[i], the
  // boundary seconds, and the ids. Clips are read in array order (the editor
  // keeps them sorted after every structural op).
  const boundariesByTrack = useMemo(() => {
    const map = new Map<
      string,
      Array<{
        afterClipId: string;
        boundary: number;
        transition: VdzTransition | undefined;
      }>
    >();
    for (const track of timeline.tracks) {
      const out: Array<{
        afterClipId: string;
        boundary: number;
        transition: VdzTransition | undefined;
      }> = [];
      const transitions = track.transitions ?? [];
      for (let i = 0; i < track.clips.length - 1; i++) {
        const a = track.clips[i];
        const b = track.clips[i + 1];
        const aEnd = a.start + a.duration;
        // Only abutting clips form a real crossfade boundary.
        if (Math.abs(aEnd - b.start) > 1e-6) continue;
        out.push({
          afterClipId: a.id,
          boundary: aEnd,
          transition: transitions.find(tr => tr.afterClipId === a.id),
        });
      }
      map.set(track.id, out);
    }
    return map;
  }, [timeline]);

  // The whole lane stack (clip blocks + transition affordances) — memoized so
  // it is NOT rebuilt on a playhead tick. It depends only on the timeline, the
  // interaction state (drag / drop hover / open picker / selection) and zoom;
  // the playhead is threaded separately (the moving line below). Under playback
  // this array keeps a stable reference, so React reconciles the lanes to a
  // no-op each frame and only the playhead line updates. All handlers used here
  // are referentially stable across ticks (none depend on `playheadSeconds`).
  const laneRows = useMemo(
    () =>
      timeline.tracks.map(track => (
        <div
          key={track.id}
          className={styles.laneRow}
          data-drop-target={dropTrackId === track.id}
          ref={el => registerLaneRect(track.id, el)}
          onPointerDown={onTrackBackgroundPointerDown}
          onDragOver={e => onLaneDragOver(e, track.id)}
          onDragLeave={() => setDropTrackId(null)}
          onDrop={e => onLaneDrop(e, track.id)}
        >
          {/* Empty-lane hint: shows only when the lane has no clips and isn't
              hosting the drag ghost. Non-interactive (pointerEvents:none) so it
              never intercepts a background scrub/drop. */}
          {track.clips.length === 0 &&
          !(drag && drag.ghostTrackId === track.id) ? (
            <div className={ex.emptyHint}>
              <span className={ex.emptyHintIcon} aria-hidden="true">
                ＋
              </span>
              {emptyHintText(track.kind)}
            </div>
          ) : null}
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
                      {/* Waveform underlay for audio clips (non-interactive;
                          first child so handles/label paint above it). */}
                      {clip.type === 'audio' ? (
                        <AudioClipWaveform
                          clip={clip}
                          widthPx={Math.max(2, dur * pxPerSec)}
                        />
                      ) : null}
                      <span className={styles.clipTrimHandleLeft} />
                      <span
                        className={styles.clipLabel}
                        style={{ position: 'relative', zIndex: 1 }}
                      >
                        {clip.name ?? clip.type}
                      </span>
                      <span className={styles.clipTrimHandleRight} />
                    </div>
                  );
                })}

                {/* Transition badges / add affordances at clip boundaries.
                    Hidden while dragging so they never fight the ghost. */}
                {!drag &&
                  (boundariesByTrack.get(track.id) ?? []).map(b => {
                    const left = b.boundary * pxPerSec;
                    const pickerOpen =
                      openPicker?.trackId === track.id &&
                      openPicker.afterClipId === b.afterClipId;
                    return (
                      <div
                        key={`bnd-${b.afterClipId}`}
                        className={styles.boundaryAnchor}
                        style={{ left }}
                      >
                        {b.transition ? (
                          <button
                            type="button"
                            className={styles.transitionBadge}
                            title={`${b.transition.kind} transition · ${b.transition.duration}s — click to remove`}
                            onPointerDown={e => e.stopPropagation()}
                            onClick={e => {
                              e.stopPropagation();
                              removeTransition(track.id, b.transition!.id);
                            }}
                          >
                            ⧉
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={styles.transitionAdd}
                            title="Add a transition here"
                            onPointerDown={e => e.stopPropagation()}
                            onClick={e => {
                              e.stopPropagation();
                              setOpenPicker(
                                pickerOpen
                                  ? null
                                  : {
                                      trackId: track.id,
                                      afterClipId: b.afterClipId,
                                    }
                              );
                            }}
                          >
                            +
                          </button>
                        )}

                        {pickerOpen ? (
                          <div
                            className={styles.transitionPicker}
                            onPointerDown={e => e.stopPropagation()}
                          >
                            {TRANSITION_KINDS.map(kind => (
                              <div
                                key={kind}
                                className={styles.transitionPickerGroup}
                              >
                                <span className={styles.transitionPickerKind}>
                                  {kind}
                                </span>
                                {TRANSITION_DURATIONS.map(d => (
                                  <button
                                    key={d}
                                    type="button"
                                    className={styles.transitionPickerButton}
                                    onClick={e => {
                                      e.stopPropagation();
                                      addTransition(
                                        track.id,
                                        b.afterClipId,
                                        kind,
                                        d
                                      );
                                    }}
                                  >
                                    {d}s
                                  </button>
                                ))}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
        </div>
      )),
    [
      timeline,
      dropTrackId,
      drag,
      selectedIds,
      pxPerSec,
      boundariesByTrack,
      openPicker,
      registerLaneRect,
      onTrackBackgroundPointerDown,
      onLaneDragOver,
      onLaneDrop,
      onClipPointerDown,
      onPointerMove,
      finishDrag,
      onSelectClip,
      addTransition,
      removeTransition,
    ]
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
          <div key={track.id} className={ex.laneHeaderCell}>
            <span
              className={ex.laneHeaderPip}
              style={{ background: TRACK_COLORS[track.kind] }}
              aria-hidden="true"
            />
            <span>{track.name ?? track.kind}</span>
          </div>
        ))}
        {/* Add-lane control: more video / text-overlay / music lanes. */}
        <div style={{ position: 'relative', padding: '4px 2px' }}>
          <button
            type="button"
            onClick={() => setAddLaneOpen(open => !open)}
            title="Add a track"
            aria-label="Add a track"
            aria-haspopup="menu"
            aria-expanded={addLaneOpen}
            style={{
              width: '100%',
              height: 24,
              borderRadius: 6,
              border: '1px dashed var(--vdz-border, #2a2f3a)',
              background: 'transparent',
              color: 'var(--vdz-muted, #8a90a0)',
              fontSize: 14,
              lineHeight: 1,
              cursor: 'pointer',
            }}
          >
            ＋
          </button>
          {addLaneOpen ? (
            <div
              role="menu"
              style={{
                position: 'absolute',
                bottom: 'calc(100% + 4px)',
                left: 0,
                zIndex: 40,
                minWidth: 150,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                padding: 6,
                borderRadius: 10,
                border: '1px solid var(--vdz-border, #262a35)',
                background: 'var(--vdz-panel, #12141a)',
                boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
              }}
            >
              {[
                { label: '🎬 Video track', kind: 'video' as const, name: 'Video' },
                { label: '🅣 Text / overlay', kind: 'overlay' as const, name: 'Overlay' },
                { label: '🎵 Music track', kind: 'audio' as const, name: 'Audio' },
              ].map(opt => (
                <button
                  key={opt.kind + opt.name}
                  type="button"
                  role="menuitem"
                  onClick={() => addLane(opt.kind, opt.name)}
                  style={{
                    appearance: 'none',
                    textAlign: 'left',
                    padding: '6px 8px',
                    borderRadius: 7,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--vdz-text, #e6e9f0)',
                    fontSize: 12,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* Scroll container: ruler + lanes + playhead share one width & scroll. */}
      <div className={styles.lanesScroll} onWheel={onWheel}>
        <div className={styles.lanesContent} style={{ width: contentWidth }}>
          <TimeRuler
            spanSeconds={spanSeconds}
            pxPerSec={pxPerSec}
            fps={timeline.fps}
          />

          <div
            className={styles.laneStack}
            ref={laneStackRef}
            onPointerMove={onHoverMove}
            onPointerLeave={onHoverLeave}
          >
            {laneRows}

            {/* Hover time indicator: a thin ghost line + tooltip that follow the
                pointer. Positioned via transform (updated imperatively in
                onHoverMove) so they never trigger re-layout; hidden until the
                pointer enters and while a drag is in flight. */}
            <div className={ex.hoverLine} ref={hoverLineRef} aria-hidden="true" />
            <div className={ex.hoverTip} ref={hoverTipRef} aria-hidden="true" />

            {/* Snap guide, drawn only while a snap is active. */}
            {snapGuideLeft !== null ? (
              <div
                className={styles.snapGuide}
                style={{ left: Math.round(snapGuideLeft) }}
              />
            ) : null}

            {/* Playhead spans the lane stack (not the ruler above it). Refined:
                full-height with a soft glow + a cap so its exact column reads
                over bright clips. left rounded for a crisp hairline. */}
            <div
              className={ex.playhead}
              style={{ left: Math.round(playheadSeconds * pxPerSec) }}
            >
              <span className={ex.playheadCap} aria-hidden="true" />
            </div>
          </div>
        </div>

        {/* Playhead readout HUD, pinned to the visible scroll viewport (not the
            scrolling content) so it stays put as the lanes scroll under it.
            Non-interactive; reflects the playhead prop (updates with it, no new
            per-frame state). */}
        <div className={ex.readoutChip} aria-hidden="true">
          <span className={ex.readoutTime}>
            {formatClockFrames(playheadSeconds, timeline.fps)}
          </span>
          <span className={ex.readoutDot} />
          <span className={ex.readoutFrame}>
            {frameAt(playheadSeconds, timeline.fps)}f
          </span>
        </div>
      </div>
    </div>
  );
}
