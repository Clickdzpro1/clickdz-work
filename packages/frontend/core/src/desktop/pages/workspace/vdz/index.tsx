import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { AppAccessGate } from '@affine/core/modules/studio/app-access-gate';
import { nanoid } from 'nanoid';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { ensureClickDzResponsiveCss } from '@affine/core/clickdz/responsive';

import {
  computeTimelineDuration,
  createSampleTimeline,
  type VdzOp,
} from '../../../../modules/vdz';
import {
  useVdzMedia,
  type VdzMediaItem,
} from '../../../../modules/vdz/use-vdz-media';
import { useVdzTimelineExport } from '../../../../modules/vdz/use-vdz-timeline-export';
import { VdzExportDialog } from './export-dialog';
import { VdzAiDock } from './ai-dock';
import { VdzAudioPlayback } from './audio-playback';
import {
  clampZoom,
  clipFromMedia,
  DEFAULT_PX_PER_SEC,
  findClip,
  isClipActive,
  trackKindForMedia,
  type VdzMediaDragPayload,
} from './constants';
import * as styles from './index.css';
import { NotifyBell } from '@affine/core/modules/platform-notify';
import { Inspector } from './inspector';
import { MediaBin } from './media-bin';
import { PreviewCanvas } from './preview-canvas';
import { ProjectBar } from './project-bar';
import { VdzShortcutCheatsheet } from './shortcut-cheatsheet';
import { TimelineLanes } from './timeline-lanes';
import { Toolbar } from './toolbar';
import { useVdzHistory } from './use-vdz-history';
import {
  type VdzPanelId,
  useVdzLayout,
} from './use-vdz-layout';
import {
  VdzPanel,
  VdzReopenTab,
  VdzResizeHandle,
  VdzViewMenu,
} from './vdz-panel';

// ---- C3 chunk diet: lazy panels ------------------------------------------
// The Generate surface and the Transcript panel are NOT part of the editor's
// first paint (Generate is a mode switch; Transcript is hidden by default), so
// they load on demand instead of riding in the vdz route chunk. Suspense
// fallbacks are null — both mount into an already-styled slot, so a brief
// empty slot beats a mismatched spinner.
const VdzGeneratePanel = lazy(() =>
  import('./generate-panel').then(m => ({ default: m.VdzGeneratePanel }))
);
const TranscriptPanel = lazy(() =>
  import('./transcript-panel').then(m => ({ default: m.TranscriptPanel }))
);
const EffectsPanel = lazy(() =>
  import('./effects-panel').then(m => ({ default: m.EffectsPanel }))
);
const ShortsPanel = lazy(() =>
  import('./shorts-panel').then(m => ({ default: m.ShortsPanel }))
);

/** Inject the CDZ responsive stylesheet (idempotent, SSR-safe). */
const CdzResponsive = () => {
  ensureClickDzResponsiveCss();
  return null;
};

/** Which top-level surface the page is showing. */
type VdzMode = 'edit' | 'generate';

/** Tags whose focus should swallow editor keyboard shortcuts. */
function isEditableTarget(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    node.isContentEditable
  );
}

const VdzStudioPage = () => {
  const history = useVdzHistory(createSampleTimeline);
  const { timeline, run, runBatch, reset, undo, redo } = history;

  // ---- Project persistence (ProjectBar owns save/open; timeline lives here) --
  // Loading a project replaces the working timeline as a fresh history baseline
  // (no undo back into the previous project). Renames go through the undoable op
  // path. New project = a fresh sample timeline.
  const loadProjectTimeline = useCallback(
    (next: typeof timeline) => {
      reset(next);
      // A loaded/new document has no live selection or running playback.
      setSelectedIds(new Set());
      setPlayheadSeconds(0);
      setIsPlaying(false);
    },
    [reset]
  );
  const renameProject = useCallback(
    (name: string) => run({ op: 'renameTimeline', name }),
    [run]
  );

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  // Master mute for preview audio (the toolbar speaker toggle). Per-clip gain
  // still lives on each clip's `volume`; this is a global override.
  const [audioMuted, setAudioMuted] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);

  // Top-level surface: the timeline editor ('edit') or the AI video generator
  // ('generate'). The generator fully replaces the editor body when active.
  const [mode, setMode] = useState<VdzMode>('edit');

  // Media bin: the single place user media enters the studio (upload / AI
  // images / stock). Owned here so the bin's blob object URLs survive tab
  // switches and re-renders; shown as a flexible left-side workspace panel.
  const media = useVdzMedia();

  // ---- MP4 export: compile the timeline → cdz-render kind:'html' ----------
  // Owns the compile+media-inline step and the shared render transport; the
  // toolbar's Export button drives it and shows progress / a download link.
  const timelineExport = useVdzTimelineExport();
  const exportState = timelineExport.export;
  const exportBusy =
    timelineExport.preparing ||
    exportState.status === 'starting' ||
    exportState.status === 'rendering';
  // A single short status line for the toolbar: render errors first, then the
  // honest media/video caveats from the last compile, else nothing.
  const exportNote = useMemo(() => {
    if (exportState.status === 'error') {
      // A lost job (mid-poll 404 past the bounded retry) is retry-able: nudge
      // the user to export again rather than reading it as a hard failure.
      if (exportState.lostJob) {
        return (
          exportState.error ||
          'La tâche de rendu a été perdue — veuillez exporter à nouveau.'
        );
      }
      return exportState.error || 'Échec de l’export';
    }
    if (timelineExport.preparing) return 'Préparation des médias…';
    const notes: string[] = [];
    // When Remotion was requested but isn't available we transparently used
    // Classic; say so once so the poster/no-audio caveats below make sense.
    if (timelineExport.fellBackToClassic) {
      notes.push('Remotion indisponible — exporté avec Classic');
    }
    if (timelineExport.skippedMedia.length > 0) {
      notes.push(
        `${timelineExport.skippedMedia.length} fichier(s) média non intégré(s)`
      );
    }
    const posters = timelineExport.lastCompile?.posterOnlyVideoClips.length ?? 0;
    if (posters > 0) {
      notes.push(`${posters} clip(s) vidéo exporté(s) en image fixe`);
    }
    return notes.length > 0 ? notes.join(' · ') : null;
  }, [
    exportState.status,
    exportState.error,
    exportState.lostJob,
    timelineExport.preparing,
    timelineExport.fellBackToClassic,
    timelineExport.skippedMedia,
    timelineExport.lastCompile,
  ]);

  // ---- Workspace layout: flexible, hideable, resizable panels ------------
  // Every editor surface is a panel the user can resize / hide / re-show; the
  // state (per-panel {visible, size}) is persisted to localStorage.
  const {
    layout,
    toggle: togglePanel,
    setVisible: setPanelVisible,
    setSize: setPanelSize,
    resetPanelSize,
    resetLayout,
  } = useVdzLayout();

  // The media bin still drives the toolbar's "Media" button; route it through
  // the layout so the button, the panel ×, the View menu and Cmd+1 all agree.
  const showMedia = layout.mediaBin.visible;
  const toggleMedia = useCallback(
    () => togglePanel('mediaBin'),
    [togglePanel]
  );

  // A staged, not-yet-applied AI proposal from the dock. null when nothing is
  // pending. The dock never mutates the timeline; the host reviews here and
  // applies through the SAME history path the toolbar uses (runBatch).
  const [pendingProposal, setPendingProposal] = useState<{
    ops: VdzOp[];
    summary: string;
  } | null>(null);

  // A prompt handed from the Generate panel's "In editor" mode to the AI dock:
  // set it, switch to Edit, and the dock auto-sends it once (text-to-timeline)
  // so the user lands on the editable timeline with a pending Accept/Revert
  // proposal. Cleared by the dock via onInitialPromptConsumed after it sends.
  const [pendingEditorPrompt, setPendingEditorPrompt] = useState('');

  // Keyboard-shortcut cheatsheet overlay (QUILL): opened by the `?` key or
  // the toolbar's "⌨ Keys" button; closed by Escape / backdrop / ×.
  // Read-only UI — zero timeline interaction.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // Ids of currently-selected clips, for the AI dock's context. The selection
  // is a Set after the pro refactor; the dock wants a plain array.
  const selectedClipIds = useMemo(() => [...selectedIds], [selectedIds]);

  const duration = useMemo(() => computeTimelineDuration(timeline), [timeline]);
  // Pad the ruler/lane span a little past the end so there's room to drag.
  const spanSeconds = useMemo(() => Math.max(duration + 2, 4), [duration]);

  // The single selected clip, if exactly one is selected (drives inspector +
  // split/nudge which are single-clip operations).
  const soleSelectedId = useMemo(
    () => (selectedIds.size === 1 ? [...selectedIds][0] : null),
    [selectedIds]
  );
  const selected = useMemo(
    () => findClip(timeline, soleSelectedId),
    [timeline, soleSelectedId]
  );

  // ---- Selection ---------------------------------------------------------
  const selectClip = useCallback((clipId: string, shiftKey: boolean) => {
    setSelectedIds(prev => {
      if (!shiftKey) return new Set([clipId]);
      const next = new Set(prev);
      if (next.has(clipId)) next.delete(clipId);
      else next.add(clipId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Drop selection entries whose clips no longer exist (e.g. after delete).
  useEffect(() => {
    setSelectedIds(prev => {
      const live = new Set<string>();
      for (const track of timeline.tracks) {
        for (const clip of track.clips) {
          if (prev.has(clip.id)) live.add(clip.id);
        }
      }
      return live.size === prev.size ? prev : live;
    });
  }, [timeline]);

  // ---- Playback (rAF) ----------------------------------------------------
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
      // Restart from the top if we're parked at the very end.
      if (!prev && playheadSeconds >= durationRef.current) {
        setPlayheadSeconds(0);
      }
      return !prev;
    });
  }, [playheadSeconds]);

  const scrubTo = useCallback((seconds: number) => {
    setIsPlaying(false);
    setPlayheadSeconds(Math.max(0, seconds));
  }, []);

  const onScrub = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setIsPlaying(false);
    setPlayheadSeconds(Number(event.target.value));
  }, []);

  // ---- Zoom --------------------------------------------------------------
  const zoomIn = useCallback(() => setPxPerSec(z => clampZoom(z * 1.25)), []);
  const zoomOut = useCallback(() => setPxPerSec(z => clampZoom(z / 1.25)), []);
  const onZoomWheel = useCallback((deltaY: number) => {
    setPxPerSec(z => clampZoom(z * (deltaY < 0 ? 1.1 : 1 / 1.1)));
  }, []);

  // ---- Editing ops (all through the history apply path) ------------------
  const splitSelectedAtPlayhead = useCallback(() => {
    if (!selected) return;
    const { clip, trackId } = selected;
    if (!isClipActive(clip, playheadSeconds)) return;
    run({
      op: 'splitClip',
      trackId,
      clipId: clip.id,
      atSeconds: playheadSeconds,
    });
  }, [selected, playheadSeconds, run]);

  const deleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    const ops: VdzOp[] = [];
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (selectedIds.has(clip.id)) {
          ops.push({ op: 'removeClip', trackId: track.id, clipId: clip.id });
        }
      }
    }
    runBatch(ops);
  }, [selectedIds, timeline, runBatch]);

  const rippleDeleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    const ops: VdzOp[] = [];
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (selectedIds.has(clip.id)) {
          ops.push({ op: 'rippleDelete', trackId: track.id, clipId: clip.id });
        }
      }
    }
    runBatch(ops);
  }, [selectedIds, timeline, runBatch]);

  const nudgeSelected = useCallback(
    (deltaSeconds: number) => {
      if (!selected) return;
      run({
        op: 'nudgeClip',
        trackId: selected.trackId,
        clipId: selected.clip.id,
        deltaSeconds,
      });
    },
    [selected, run]
  );

  // A single move/trim op emitted by the lanes on pointerup.
  const commitLaneOp = useCallback((op: VdzOp) => run(op), [run]);

  // Export the CURRENT timeline to MP4. The toolbar button now OPENS the export
  // dialog (engine choice + summary); the render starts when the user confirms
  // (see the <VdzExportDialog> mount in the ViewBody). Stop playback first.
  const onExportMp4 = useCallback(() => {
    setIsPlaying(false);
    timelineExport.openDialog();
  }, [timelineExport]);

  // ---- Media → timeline (all through the one history apply path) --------
  // Resolve a concrete track id for a media payload: prefer the caller's
  // explicit target track (a drop lands where you drop it) as long as its kind
  // is compatible, otherwise fall back to the first track of the media's kind.
  const resolveTargetTrackId = useCallback(
    (
      payload: VdzMediaDragPayload | VdzMediaItem,
      preferredTrackId?: string
    ) => {
      const wantKind = trackKindForMedia(payload.kind);
      if (preferredTrackId) {
        const preferred = timeline.tracks.find(t => t.id === preferredTrackId);
        // Images are happy on video OR overlay; a/v must match kind exactly.
        if (preferred) {
          if (payload.kind === 'image') {
            if (preferred.kind === 'video' || preferred.kind === 'overlay') {
              return preferred.id;
            }
          } else if (preferred.kind === wantKind) {
            return preferred.id;
          }
        }
      }
      return timeline.tracks.find(t => t.kind === wantKind)?.id ?? null;
    },
    [timeline]
  );

  // Add a bin item at the playhead (the "+" button / click path).
  const addMediaToTimeline = useCallback(
    (item: VdzMediaItem) => {
      const trackId = resolveTargetTrackId(item);
      if (!trackId) return;
      run({
        op: 'addClip',
        trackId,
        clip: clipFromMedia(item, playheadSeconds),
      });
    },
    [resolveTargetTrackId, run, playheadSeconds]
  );

  // A bin item was dropped on a specific lane at a specific x → one addClip.
  const handleDropMedia = useCallback(
    (payload: VdzMediaDragPayload, trackId: string, atSeconds: number) => {
      const target = resolveTargetTrackId(payload, trackId);
      if (!target) return;
      run({
        op: 'addClip',
        trackId: target,
        clip: clipFromMedia(payload, atSeconds),
      });
    },
    [resolveTargetTrackId, run]
  );

  // Raw files dropped on the timeline: import (same pipeline as Upload), then
  // drop each onto the lane at the drop position. Imports are async, so we
  // place them once resolved. The drop lane is only honored when kind-compatible.
  const handleDropFiles = useCallback(
    (files: FileList, trackId: string, atSeconds: number) => {
      void media.importFiles(files).then(added => {
        let cursor = atSeconds;
        for (const item of added) {
          const target = resolveTargetTrackId(item, trackId);
          if (!target) continue;
          const clip = clipFromMedia(item, cursor);
          run({ op: 'addClip', trackId: target, clip });
          // Lay multiple dropped files back-to-back from the drop point.
          cursor += clip.duration;
        }
      });
    },
    [media, resolveTargetTrackId, run]
  );

  // Page-level file drop: dropping files anywhere in the editor (except a more
  // specific target that already handled the drop — a timeline lane, or the
  // bin's own drop zone) imports them into the media bin. `defaultPrevented`
  // is set by those inner handlers and persists through native bubbling, so
  // this fires ONLY for otherwise-unhandled drops.
  const onRootDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      void media.importFiles(files);
    },
    [media]
  );

  const onRootDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      if (Array.from(event.dataTransfer.types).includes('Files')) {
        // Permit the drop so onRootDrop fires (default is to reject).
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    },
    []
  );

  // ---- Add text clip (lives in the toolbar's editing group) --------------
  // Adds an overlay text clip at the playhead through the one validated
  // history path. If the timeline has no overlay lane, create one first so
  // the add always lands (mirrors the media-drop lane-ensure intent).
  const onAddTextClip = useCallback(() => {
    const overlay = timeline.tracks.find(track => track.kind === 'overlay');
    const start = Math.min(playheadSeconds, Math.max(0, duration - 2));
    const textClip = {
      id: `clip-${nanoid(6)}`,
      type: 'text' as const,
      name: 'Nouveau texte',
      start,
      duration: 3,
      text: 'Nouveau texte',
      fontSize: 0.06,
      color: '#ffffff',
      x: 0.5,
      y: 0.5,
      align: 'center' as const,
    };
    if (!overlay) {
      const trackId = `track-overlay-${nanoid(4)}`;
      runBatch([
        { op: 'addTrack', track: { id: trackId, kind: 'overlay', name: 'Overlay', clips: [] } },
        { op: 'addClip', trackId, clip: textClip },
      ]);
      return;
    }
    run({ op: 'addClip', trackId: overlay.id, clip: textClip });
  }, [timeline, playheadSeconds, duration, run, runBatch]);

  // ---- Add shape clip (QUILL — the insert-group sibling of add-text) -----
  // Clones the add-text path: a shape clip at the playhead on the overlay
  // lane (created first when missing), through the SAME validated history
  // path. Default geometry is centered; the circle compensates the canvas
  // aspect so its default box renders visually round.
  const onAddShapeClip = useCallback(
    (shape: 'rect' | 'circle') => {
      const overlay = timeline.tracks.find(track => track.kind === 'overlay');
      const start = Math.min(playheadSeconds, Math.max(0, duration - 2));
      const aspect =
        timeline.width > 0 && timeline.height > 0
          ? timeline.width / timeline.height
          : 16 / 9;
      const h = 0.3;
      const w =
        shape === 'circle'
          ? Math.min(1, Math.round((h / aspect) * 1000) / 1000)
          : 0.4;
      const shapeClip = {
        id: `clip-${nanoid(6)}`,
        type: 'shape' as const,
        name: shape === 'circle' ? 'Cercle' : 'Rectangle',
        start,
        duration: 3,
        shape,
        color: '#5b8cff',
        x: Math.round(((1 - w) / 2) * 1000) / 1000,
        y: Math.round(((1 - h) / 2) * 1000) / 1000,
        w,
        h,
      };
      if (!overlay) {
        const trackId = `track-overlay-${nanoid(4)}`;
        runBatch([
          { op: 'addTrack', track: { id: trackId, kind: 'overlay', name: 'Overlay', clips: [] } },
          { op: 'addClip', trackId, clip: shapeClip },
        ]);
        return;
      }
      run({ op: 'addClip', trackId: overlay.id, clip: shapeClip });
    },
    [timeline, playheadSeconds, duration, run, runBatch]
  );

  // ---- AI dock: stage → review → apply -----------------------------------
  // The dock hands us client-validated ops; we STAGE them (do not apply) so the
  // user can review a diff bar and Accept / Revert.
  const onApplyOps = useCallback((ops: VdzOp[], summary: string) => {
    setPendingProposal({ ops, summary });
  }, []);

  // Accept: push the whole batch through the one validated apply path
  // (runBatch = a single undo entry). If it fails, runBatch records the error
  // in history.error (shown in the footer) and returns false — keep the
  // proposal staged so the user can revert or retry rather than lose it.
  const acceptPendingOps = useCallback(() => {
    if (!pendingProposal) return;
    const committed = runBatch(pendingProposal.ops);
    if (committed) setPendingProposal(null);
  }, [pendingProposal, runBatch]);

  // Revert: discard the staged proposal untouched.
  const revertPendingOps = useCallback(() => setPendingProposal(null), []);

  // ---- Mode switch -------------------------------------------------------
  // Generate mode fills the center with the generator; the editor-only panels
  // (media / inspector / timeline) are hidden automatically and RESTORED to
  // whatever the user had when they return to Edit. The AI panel stays available
  // as the studio's through-line. We stash the pre-generate visibility once on
  // entry (a ref so it survives re-renders) and replay it on return.
  const preGenerateVisibilityRef = useRef<Record<VdzPanelId, boolean> | null>(
    null
  );
  const GENERATE_HIDDEN: VdzPanelId[] = useMemo(
    () => ['mediaBin', 'inspector', 'timeline', 'transcript', 'effects', 'shorts'],
    []
  );
  // Same set as a lookup for the View menu's disabled state in Generate mode.
  const generateDisabledPanels = useMemo(
    () => new Set<VdzPanelId>(GENERATE_HIDDEN),
    [GENERATE_HIDDEN]
  );

  // Leaving the editor must not leave playback running (the rAF loop keeps
  // ticking even though the timeline is unmounted); stop it on any switch.
  // This runs from an event handler, so the sibling panel-visibility updates are
  // plain sequential setState calls (not nested inside setMode's updater).
  const switchMode = useCallback(
    (next: VdzMode) => {
      if (next === mode) return;
      setIsPlaying(false);
      if (next === 'generate') {
        // Snapshot current visibility, then hide the editor-only panels.
        preGenerateVisibilityRef.current = {
          mediaBin: layout.mediaBin.visible,
          inspector: layout.inspector.visible,
          aiDock: layout.aiDock.visible,
          timeline: layout.timeline.visible,
          transcript: layout.transcript.visible,
          effects: layout.effects.visible,
          // `shorts` is in GENERATE_HIDDEN too — omitting it here made the
          // restore loop read `snap.shorts` as undefined and force-hide the
          // panel on return to Edit instead of restoring the user's choice.
          shorts: layout.shorts.visible,
        };
        for (const id of GENERATE_HIDDEN) setPanelVisible(id, false);
      } else {
        // Returning to Edit: restore the snapshot (fall back to showing them).
        const snap = preGenerateVisibilityRef.current;
        for (const id of GENERATE_HIDDEN) {
          setPanelVisible(id, snap ? snap[id] : true);
        }
        preGenerateVisibilityRef.current = null;
      }
      setMode(next);
    },
    [mode, GENERATE_HIDDEN, layout, setPanelVisible]
  );

  // "Generate → In editor": stash the brief for the dock, jump to the editor,
  // and let the dock auto-send it (the SAME send path a typed dock message
  // uses). The result is a pending proposal the user reviews on the timeline.
  // Route through switchMode so the editor panels are restored on the way in.
  const onGenerateInEditor = useCallback(
    (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      setPendingEditorPrompt(trimmed);
      switchMode('edit');
    },
    [switchMode]
  );

  // The dock calls this the instant it has auto-sent the handed-in brief; clear
  // it so a later re-render never re-sends the same prompt.
  const onEditorPromptConsumed = useCallback(
    () => setPendingEditorPrompt(''),
    []
  );

  // ---- Keyboard (bound to the page container, with cleanup) --------------
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;

      if (meta && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault();
        redo();
        return;
      }

      // Cmd/Ctrl+1..7 toggle the workspace panels.
      if (meta && event.key >= '1' && event.key <= '7') {
        event.preventDefault();
        const panelForDigit: Record<string, VdzPanelId> = {
          '1': 'mediaBin',
          '2': 'inspector',
          '3': 'aiDock',
          '4': 'timeline',
          '5': 'transcript',
          '6': 'effects',
          '7': 'shorts',
        };
        togglePanel(panelForDigit[event.key]);
        return;
      }

      switch (event.key) {
        case ' ':
          event.preventDefault();
          togglePlay();
          break;
        case 's':
        case 'S':
          event.preventDefault();
          splitSelectedAtPlayhead();
          break;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          if (event.shiftKey) rippleDeleteSelected();
          else deleteSelected();
          break;
        case 'Escape':
          // The cheatsheet overlay wins Escape while open (its own window
          // listener also closes it; this guard just spares the selection).
          if (shortcutsOpen) setShortcutsOpen(false);
          else clearSelection();
          break;
        case '?':
          // `?` (Shift+/ on most layouts) toggles the shortcut cheatsheet.
          event.preventDefault();
          setShortcutsOpen(o => !o);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          nudgeSelected(event.shiftKey ? -1 : -0.1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          nudgeSelected(event.shiftKey ? 1 : 0.1);
          break;
        default:
          break;
      }
    },
    [
      redo,
      undo,
      togglePlay,
      splitSelectedAtPlayhead,
      rippleDeleteSelected,
      deleteSelected,
      clearSelection,
      nudgeSelected,
      togglePanel,
      shortcutsOpen,
    ]
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    node.addEventListener('keydown', handleKeyDown);
    return () => node.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const canSplit = Boolean(
    selected && isClipActive(selected.clip, playheadSeconds)
  );

  return (
    <>
      <ViewTitle title="Studio Vdz" />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div className={styles.header}>
          {/* LEFT: product title. */}
          <div className={styles.headerLeft}>
            <span className={styles.headerTitle}>Studio Vdz</span>
          </div>

          {/* CENTER: Edit / Generate as one segmented control, kept centred. */}
          <div className={styles.headerCenter}>
            <div
              className={styles.modeTabs}
              role="tablist"
              aria-label="Mode Vdz"
            >
              <button
                type="button"
                role="tab"
                className={styles.modeTab}
                data-active={mode === 'edit'}
                aria-selected={mode === 'edit'}
                onClick={() => switchMode('edit')}
              >
                Édition
              </button>
              <button
                type="button"
                role="tab"
                className={styles.modeTab}
                data-active={mode === 'generate'}
                aria-selected={mode === 'generate'}
                onClick={() => switchMode('generate')}
              >
                Générer
              </button>
            </div>
          </div>

          {/* RIGHT: one coherent action cluster hosted by the ProjectBar
              (inline-editable name + Save/Open/⋯ overflow, owning all
              persistence). The panel View menu rides along as its trailing
              slot so the whole zone shares one gap rhythm, one divider spec
              and one width budget — the bar condenses itself under width
              pressure (density tiers) instead of squeezing the name to one
              character or spilling buttons toward the mode tabs. In Generate
              mode the editor-only panels are mode-controlled, so disable them
              here. */}
          <div className={styles.headerRight} data-cdz-actions="">
            <NotifyBell />
            <ProjectBar
              timeline={timeline}
              onLoadTimeline={loadProjectTimeline}
              onRename={renameProject}
              newTimeline={createSampleTimeline}
              viewMenu={
                <VdzViewMenu
                  layout={layout}
                  onToggle={togglePanel}
                  onReset={resetLayout}
                  disabledIds={
                    mode === 'generate' ? generateDisabledPanels : undefined
                  }
                />
              }
            />
          </div>
        </div>
      </ViewHeader>
      <ViewBody>
        <AppAccessGate app="VDZ">
        <VdzExportDialog
          open={timelineExport.dialogOpen}
          timeline={timeline}
          capabilities={timelineExport.capabilities}
          onCancel={timelineExport.closeDialog}
          onConfirm={engine => {
            void timelineExport.start(timeline, engine);
          }}
        />
        {/* Keyboard-shortcut cheatsheet (QUILL) — read-only portaled overlay;
            opened via `?` or the toolbar's ⌨ button, closed by Esc/backdrop. */}
        <VdzShortcutCheatsheet
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
        />
        {mode === 'generate' ? (
          <div className={styles.generateHost}>
            <Suspense fallback={null}>
              <VdzGeneratePanel onGenerateInEditor={onGenerateInEditor} />
            </Suspense>
          </div>
        ) : (
          <div
            className={styles.root}
            data-cdz-surface=""
            ref={containerRef}
            tabIndex={-1}
            onDragOver={onRootDragOver}
            onDrop={onRootDrop}
          >
            <CdzResponsive />
            <div className={styles.main} data-cdz-shell="">
              {/* Media bin — flexible left panel. Draggable items add to the
                  timeline via drag or the "+" button (both route through
                  `run`). Resizable seam on its right edge; hides to a slim
                  reopen tab at the left edge. */}
              {showMedia ? (
                <>
                  <div
                    className={styles.sidePanelSlot}
                    style={{ width: layout.mediaBin.size }}
                  >
                    <MediaBin
                      media={media}
                      onAddToTimeline={addMediaToTimeline}
                      onCollapse={() => setPanelVisible('mediaBin', false)}
                    />
                  </div>
                  <VdzResizeHandle
                    id="mediaBin"
                    size={layout.mediaBin.size}
                    setSize={setPanelSize}
                    onReset={() => resetPanelSize('mediaBin')}
                    axis="x"
                    dir={1}
                    aria-label="Redimensionner le panneau média"
                  />
                </>
              ) : (
                <VdzReopenTab
                  label="Médias"
                  edge="left"
                  onClick={() => setPanelVisible('mediaBin', true)}
                />
              )}

              {/* Center column: preview canvas + (resizable) timeline. The
                  flex remainder — grows/shrinks as panels resize. */}
              <div className={styles.center}>
                <div className={styles.previewWrapper}>
                  <PreviewCanvas
                    timeline={timeline}
                    playheadSeconds={playheadSeconds}
                    isPlaying={isPlaying}
                    muted={audioMuted}
                    onToggleMute={() => setAudioMuted(m => !m)}
                  />
                  {/* Non-visual: hidden <audio> pool slaved to the playhead so
                      the preview actually plays sound. Unmounts with the editor
                      body (Generate mode / leaving the route), stopping audio. */}
                  <VdzAudioPlayback
                    timeline={timeline}
                    playheadSeconds={playheadSeconds}
                    isPlaying={isPlaying}
                    muted={audioMuted}
                  />
                </div>

                {/* Timeline — flexible bottom panel (its own header via the
                    toolbar). Height is layout-driven; a vertical seam above
                    resizes it. Collapses to just toolbar + scrubber. */}
                {layout.timeline.visible ? (
                  <>
                    <VdzResizeHandle
                      id="timeline"
                      size={layout.timeline.size}
                      setSize={setPanelSize}
                      onReset={() => resetPanelSize('timeline')}
                      axis="y"
                      dir={-1}
                      aria-label="Redimensionner la chronologie"
                    />
                    <div
                      className={styles.timeline}
                      style={{ height: layout.timeline.size }}
                    >
                      <Toolbar
                        timeline={timeline}
                        onCommitOp={commitLaneOp}
                        showMedia={showMedia}
                        onToggleMedia={toggleMedia}
                        isPlaying={isPlaying}
                        onTogglePlay={togglePlay}
                        audioMuted={audioMuted}
                        onToggleAudioMute={() => setAudioMuted(m => !m)}
                        playheadSeconds={playheadSeconds}
                        duration={duration}
                        pxPerSec={pxPerSec}
                        onZoomOut={zoomOut}
                        onZoomIn={zoomIn}
                        canSplit={canSplit}
                        onSplit={splitSelectedAtPlayhead}
                        canDelete={selectedIds.size > 0}
                        onDelete={deleteSelected}
                        onRippleDelete={rippleDeleteSelected}
                        onAddText={onAddTextClip}
                        onAddShape={onAddShapeClip}
                        selected={selected}
                        onCommitOps={runBatch}
                        onShowShortcuts={() => setShortcutsOpen(true)}
                        canUndo={history.canUndo}
                        onUndo={undo}
                        canRedo={history.canRedo}
                        onRedo={redo}
                        selectionCount={selectedIds.size}
                        onExport={onExportMp4}
                        exportBusy={exportBusy}
                        exportProgress={exportState.progress}
                        exportFileUrl={
                          exportState.status === 'done'
                            ? exportState.fileUrl
                            : null
                        }
                        exportUnavailable={exportState.unavailable}
                        exportNote={exportNote}
                        onCollapse={() => setPanelVisible('timeline', false)}
                      />

                      <div className={styles.scrubberRow}>
                        <input
                          className={styles.scrubber}
                          type="range"
                          min={0}
                          max={Math.max(duration, 0.1)}
                          step={0.1}
                          value={Math.min(
                            playheadSeconds,
                            Math.max(duration, 0.1)
                          )}
                          onChange={onScrub}
                          aria-label="Tête de lecture"
                        />
                      </div>

                      <div className={styles.timelineLanesWrap}>
                        <TimelineLanes
                          timeline={timeline}
                          pxPerSec={pxPerSec}
                          playheadSeconds={playheadSeconds}
                          selectedIds={selectedIds}
                          spanSeconds={spanSeconds}
                          onSelectClip={selectClip}
                          onScrubToSeconds={scrubTo}
                          onZoomWheel={onZoomWheel}
                          onCommitOp={commitLaneOp}
                          onDropMedia={handleDropMedia}
                          onDropFiles={handleDropFiles}
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <VdzReopenTab
                    label="Chronologie"
                    edge="bottom"
                    onClick={() => setPanelVisible('timeline', true)}
                  />
                )}
              </div>

              {/* Right stack: inspector + AI dock, each a flexible panel with a
                  resize seam on its left edge. Hidden panels leave a reopen tab
                  at the right edge. */}
              {layout.inspector.visible ||
              layout.aiDock.visible ||
              layout.transcript.visible ||
              layout.effects.visible ||
              layout.shorts.visible ? (
                <div className={styles.rightStack}>
                  {/* AI Shorts — long→short repurposing. Hidden by default;
                      opt-in via View menu / Cmd+7. */}
                  {layout.shorts.visible ? (
                    <>
                      <VdzResizeHandle
                        id="shorts"
                        size={layout.shorts.size}
                        setSize={setPanelSize}
                        onReset={() => resetPanelSize('shorts')}
                        axis="x"
                        dir={-1}
                        aria-label="Redimensionner les Shorts IA"
                      />
                      <div
                        className={styles.sidePanelSlot}
                        style={{ width: layout.shorts.size }}
                      >
                        <Suspense fallback={null}>
                          <ShortsPanel
                            timeline={timeline}
                            playheadSeconds={playheadSeconds}
                            projectName={timeline.name}
                            onSeek={scrubTo}
                            onOpenTimeline={loadProjectTimeline}
                            onCollapse={() =>
                              setPanelVisible('shorts', false)
                            }
                          />
                        </Suspense>
                      </div>
                    </>
                  ) : null}
                  {/* Effects & Transitions — one-click looks + clip-to-clip
                      transitions for the selected clip. Hidden by default;
                      opt-in via View menu / Cmd+6. One op per action through
                      the SAME single-op history path. */}
                  {layout.effects.visible ? (
                    <>
                      <VdzResizeHandle
                        id="effects"
                        size={layout.effects.size}
                        setSize={setPanelSize}
                        onReset={() => resetPanelSize('effects')}
                        axis="x"
                        dir={-1}
                        aria-label="Redimensionner les effets"
                      />
                      <div
                        className={styles.sidePanelSlot}
                        style={{ width: layout.effects.size }}
                      >
                        <Suspense fallback={null}>
                          <EffectsPanel
                            timeline={timeline}
                            selected={selected}
                            onOp={commitLaneOp}
                            onCollapse={() =>
                              setPanelVisible('effects', false)
                            }
                          />
                        </Suspense>
                      </div>
                    </>
                  ) : null}
                  {/* Transcript — the Descript-style spoken-layer view.
                      Hidden by default; opt-in via View menu / Cmd+5. Edits
                      route through the SAME single-op history path. */}
                  {layout.transcript.visible ? (
                    <>
                      <VdzResizeHandle
                        id="transcript"
                        size={layout.transcript.size}
                        setSize={setPanelSize}
                        onReset={() => resetPanelSize('transcript')}
                        axis="x"
                        dir={-1}
                        aria-label="Redimensionner la transcription"
                      />
                      <div
                        className={styles.sidePanelSlot}
                        style={{ width: layout.transcript.size }}
                      >
                        <Suspense fallback={null}>
                          <TranscriptPanel
                            timeline={timeline}
                            playheadSeconds={playheadSeconds}
                            selectedIds={selectedIds}
                            onSeek={scrubTo}
                            onSelectClip={clipId => selectClip(clipId, false)}
                            onOp={commitLaneOp}
                            onOps={runBatch}
                            onCollapse={() =>
                              setPanelVisible('transcript', false)
                            }
                          />
                        </Suspense>
                      </div>
                    </>
                  ) : null}
                  {layout.inspector.visible ? (
                    <>
                      <VdzResizeHandle
                        id="inspector"
                        size={layout.inspector.size}
                        setSize={setPanelSize}
                        onReset={() => resetPanelSize('inspector')}
                        axis="x"
                        dir={-1}
                        aria-label="Redimensionner l'inspecteur"
                      />
                      <div
                        className={styles.sidePanelSlot}
                        style={{ width: layout.inspector.size }}
                      >
                        <VdzPanel
                          title="Inspecteur"
                          data-testid="vdz-inspector"
                          onCollapse={() =>
                            setPanelVisible('inspector', false)
                          }
                          bodyClassName={styles.inspectorBody}
                        >
                          <Inspector
                            clip={selected?.clip ?? null}
                            trackId={selected?.trackId ?? null}
                            selectedCount={selectedIds.size}
                            onOp={commitLaneOp}
                            timeline={timeline}
                            onOps={runBatch}
                          />
                        </VdzPanel>
                      </div>
                    </>
                  ) : null}

                  {/* AI dock — proposes edits; onApplyOps stages them below. */}
                  {layout.aiDock.visible ? (
                    <>
                      <VdzResizeHandle
                        id="aiDock"
                        size={layout.aiDock.size}
                        setSize={setPanelSize}
                        onReset={() => resetPanelSize('aiDock')}
                        axis="x"
                        dir={-1}
                        aria-label="Redimensionner le panneau IA"
                      />
                      <div
                        className={styles.sidePanelSlot}
                        style={{ width: layout.aiDock.size }}
                      >
                        <VdzAiDock
                          timeline={timeline}
                          selectedClipIds={selectedClipIds}
                          playheadSeconds={playheadSeconds}
                          onApplyOps={onApplyOps}
                          pendingProposal={pendingProposal}
                          onAcceptProposal={acceptPendingOps}
                          onRevertProposal={revertPendingOps}
                          proposalError={history.error}
                          initialPrompt={pendingEditorPrompt}
                          onInitialPromptConsumed={onEditorPromptConsumed}
                          onCollapse={() => setPanelVisible('aiDock', false)}
                        />
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}

              {/* Reopen tabs for a hidden right panel (stacked at the right
                  edge so each can be re-shown independently). */}
              {!layout.inspector.visible ? (
                <VdzReopenTab
                  label="Inspecteur"
                  edge="right"
                  index={0}
                  onClick={() => setPanelVisible('inspector', true)}
                />
              ) : null}
              {!layout.aiDock.visible ? (
                <VdzReopenTab
                  label="IA"
                  edge="right"
                  index={layout.inspector.visible ? 0 : 1}
                  onClick={() => setPanelVisible('aiDock', true)}
                />
              ) : null}
            </div>

            {/* Footer: a SLIM status line only. The AI proposal's Accept /
                Revert live in an in-thread card inside the dock; the footer
                just reflects state. (The old demo buttons that used to float
                here — "Add text clip" / "Move selected +1s" — were relocated:
                Add-text now lives in the toolbar's editing group, and the
                move-demo was dropped in favor of drag / arrow-key nudge.) */}
            <div className={styles.footer}>
              <span className={styles.footerLabel}>
                <span className={styles.footerDot} />
                {pendingProposal
                  ? `L'IA a proposé ${pendingProposal.ops.length} modification${
                      pendingProposal.ops.length === 1 ? '' : 's'
                    } — à réviser dans le panneau IA →`
                  : 'Panneau IA prêt'}
              </span>
              {history.error ? (
                <span className={styles.errorText}>{history.error}</span>
              ) : null}
              <span className={styles.footerSpacer} />
            </div>
          </div>
        )}
        </AppAccessGate>
      </ViewBody>
    </>
  );
};

export const Component = () => {
  return <VdzStudioPage />;
};
