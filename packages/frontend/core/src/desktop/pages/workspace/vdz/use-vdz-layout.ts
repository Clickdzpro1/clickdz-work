import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Vdz Studio — workspace layout state.
 *
 * Every editor surface (media bin, inspector, AI dock, timeline) is a flexible
 * panel the user can resize, hide, and re-show — a real workspace, not a fixed
 * shell. This hook owns that state: per-panel {visible, size}, persisted to
 * localStorage so a reload restores the exact workspace, with min/max clamps and
 * a reset. The preview/center is the flex remainder and has no stored size.
 *
 * `size` semantics: mediaBin / inspector / aiDock are widths in px; timeline is a
 * height in px. Sizes are clamped to each panel's [min, max] on read AND write so
 * a stale/tampered localStorage value can never wedge the layout.
 */

/** The resizable / hideable panels (preview is the flex remainder, not listed). */
export type VdzPanelId =
  | 'mediaBin'
  | 'inspector'
  | 'aiDock'
  | 'timeline'
  | 'transcript'
  | 'effects'
  | 'shorts';

export interface VdzPanelState {
  visible: boolean;
  /** Width (mediaBin/inspector/aiDock) or height (timeline), in px. */
  size: number;
}

export type VdzLayout = Record<VdzPanelId, VdzPanelState>;

/** Per-panel default size + clamp bounds (px). Single source of truth. */
interface PanelSpec {
  size: number;
  min: number;
  max: number;
  visible: boolean;
}

export const VDZ_PANEL_SPECS: Record<VdzPanelId, PanelSpec> = {
  mediaBin: { size: 300, min: 220, max: 520, visible: true },
  inspector: { size: 300, min: 240, max: 520, visible: true },
  aiDock: { size: 340, min: 280, max: 560, visible: true },
  timeline: { size: 300, min: 132, max: 640, visible: true },
  // Hidden by default — opt-in via View menu / Cmd+5 (no layout shift for
  // existing workspaces; readLayout() merges the default for old storage).
  transcript: { size: 300, min: 240, max: 520, visible: false },
  // Effects & Transitions — same opt-in story as transcript: hidden by default
  // so existing workspaces don't shift, and readLayout() merges the default in
  // for storage saved before it existed.
  effects: { size: 320, min: 260, max: 560, visible: false },
  // AI Shorts — long→short repurposing panel. Same opt-in story: hidden by
  // default (no layout shift for existing workspaces; readLayout() merges the
  // default in for storage saved before it existed).
  shorts: { size: 340, min: 260, max: 560, visible: false },
};

export const VDZ_PANEL_IDS = Object.keys(VDZ_PANEL_SPECS) as VdzPanelId[];

/**
 * Presentational registry for each panel: the short menu label, a header/menu
 * glyph, and the digit of its Cmd/Ctrl+N shortcut.
 *
 * This is the SINGLE source of truth the chrome reads from so the panel anchors
 * never drift: the View menu (label + icon + shortcut hint + checkmark) and the
 * shared panel-header chrome (icon + title) both derive their icon and label
 * from here, and the `Cmd/Ctrl+N` hint is generated from `shortcutDigit` (the
 * key handler in index.tsx maps the same digits). The layout specs above remain
 * the source of truth for sizing/visibility; this only adds display metadata
 * (kept beside the ids so adding a panel updates one place).
 */
export interface VdzPanelMeta {
  /** Short label shown in the View menu (and matched to the panel title). */
  label: string;
  /** A leading glyph shown in the panel header and its View-menu row. */
  icon: string;
  /** The digit of the panel's Cmd/Ctrl+<n> shortcut. */
  shortcutDigit: string;
}

export const VDZ_PANEL_META: Record<VdzPanelId, VdzPanelMeta> = {
  mediaBin: { label: 'Media', icon: '▤', shortcutDigit: '1' },
  inspector: { label: 'Inspector', icon: '⚙', shortcutDigit: '2' },
  aiDock: { label: 'AI', icon: '✦', shortcutDigit: '3' },
  timeline: { label: 'Timeline', icon: '▦', shortcutDigit: '4' },
  transcript: { label: 'Transcript', icon: '💬', shortcutDigit: '5' },
  effects: { label: 'Effects', icon: '✨', shortcutDigit: '6' },
  shorts: { label: 'AI Shorts', icon: '✂', shortcutDigit: '7' },
};

/** The consistent shortcut label for a panel (e.g. `Cmd/Ctrl+2`). */
export function vdzPanelShortcut(id: VdzPanelId): string {
  return `Cmd/Ctrl+${VDZ_PANEL_META[id].shortcutDigit}`;
}

/**
 * A panel-title → header glyph lookup, derived from {@link VDZ_PANEL_META} so
 * the shared `VdzPanel` (which only receives a title string, from callers in
 * files this pass does not own) can render the SAME icon as the View menu
 * without those callers changing. Keyed by the exact title the panels pass
 * ("Inspector" / "Effects" / "Transcript" match their metadata labels).
 */
export const VDZ_PANEL_ICON_BY_TITLE: Record<string, string> = Object.values(
  VDZ_PANEL_META
).reduce<Record<string, string>>((acc, meta) => {
  acc[meta.label] = meta.icon;
  return acc;
}, {});

/** Timeline collapses to just its toolbar + scrubber row (~min height). */
export const VDZ_TIMELINE_MIN = VDZ_PANEL_SPECS.timeline.min;

const STORAGE_KEY = 'vdz:layout:v1';

function clampSize(id: VdzPanelId, size: number): number {
  const spec = VDZ_PANEL_SPECS[id];
  if (!Number.isFinite(size)) return spec.size;
  return Math.min(spec.max, Math.max(spec.min, size));
}

function defaultLayout(): VdzLayout {
  return {
    mediaBin: { visible: true, size: VDZ_PANEL_SPECS.mediaBin.size },
    inspector: { visible: true, size: VDZ_PANEL_SPECS.inspector.size },
    aiDock: { visible: true, size: VDZ_PANEL_SPECS.aiDock.size },
    timeline: { visible: true, size: VDZ_PANEL_SPECS.timeline.size },
    transcript: {
      visible: VDZ_PANEL_SPECS.transcript.visible,
      size: VDZ_PANEL_SPECS.transcript.size,
    },
    effects: {
      visible: VDZ_PANEL_SPECS.effects.visible,
      size: VDZ_PANEL_SPECS.effects.size,
    },
    shorts: {
      visible: VDZ_PANEL_SPECS.shorts.visible,
      size: VDZ_PANEL_SPECS.shorts.size,
    },
  };
}

/** Read + sanitize the persisted layout; falls back to defaults on any problem. */
function readLayout(): VdzLayout {
  const base = defaultLayout();
  if (typeof window === 'undefined') return base;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<
      Record<VdzPanelId, Partial<VdzPanelState>>
    >;
    for (const id of VDZ_PANEL_IDS) {
      const stored = parsed?.[id];
      if (!stored) continue;
      base[id] = {
        visible:
          typeof stored.visible === 'boolean'
            ? stored.visible
            : base[id].visible,
        size: clampSize(id, Number(stored.size ?? base[id].size)),
      };
    }
  } catch {
    return defaultLayout();
  }
  return base;
}

export interface UseVdzLayout {
  layout: VdzLayout;
  /** Toggle a panel's visibility (× button, View menu, keyboard). */
  toggle: (id: VdzPanelId) => void;
  /** Explicitly set a panel's visibility. */
  setVisible: (id: VdzPanelId, visible: boolean) => void;
  /** Set a panel's size (px); clamped to its bounds. Used live while dragging. */
  setSize: (id: VdzPanelId, size: number) => void;
  /** Reset a single panel to its default size (double-click a handle). */
  resetPanelSize: (id: VdzPanelId) => void;
  /** Reset the whole workspace to defaults. */
  resetLayout: () => void;
}

export function useVdzLayout(): UseVdzLayout {
  const [layout, setLayout] = useState<VdzLayout>(readLayout);

  // Persist on every change (guarded — SSR / private-mode quota errors are
  // non-fatal; the workspace simply won't survive a reload in that session).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // ignore (quota / disabled storage)
    }
  }, [layout]);

  const setVisible = useCallback((id: VdzPanelId, visible: boolean) => {
    setLayout(prev =>
      prev[id].visible === visible
        ? prev
        : { ...prev, [id]: { ...prev[id], visible } }
    );
  }, []);

  const toggle = useCallback((id: VdzPanelId) => {
    setLayout(prev => ({
      ...prev,
      [id]: { ...prev[id], visible: !prev[id].visible },
    }));
  }, []);

  const setSize = useCallback((id: VdzPanelId, size: number) => {
    const clamped = clampSize(id, size);
    setLayout(prev =>
      prev[id].size === clamped
        ? prev
        : { ...prev, [id]: { ...prev[id], size: clamped } }
    );
  }, []);

  const resetPanelSize = useCallback((id: VdzPanelId) => {
    setLayout(prev => ({
      ...prev,
      [id]: { ...prev[id], size: VDZ_PANEL_SPECS[id].size },
    }));
  }, []);

  const resetLayout = useCallback(() => setLayout(defaultLayout()), []);

  return useMemo(
    () => ({
      layout,
      toggle,
      setVisible,
      setSize,
      resetPanelSize,
      resetLayout,
    }),
    [layout, toggle, setVisible, setSize, resetPanelSize, resetLayout]
  );
}

/**
 * Live, rAF-batched resize driver for a single panel edge.
 *
 * Returns a `pointerdown` handler for a resize handle. While dragging it reads
 * the panel's start size, tracks pointer delta along one axis, and pushes the
 * new size through `setSize` on the next animation frame (never more than once
 * per frame) so a fast drag can't thrash React. `axis` + `dir` map screen
 * movement to size growth: a right-edge panel on the LEFT of the pointer grows
 * as the pointer moves right (dir +1); a right-side panel grows as the pointer
 * moves left (dir -1); the timeline (docked bottom) grows as the pointer moves
 * up (dir -1 on the y axis).
 */
export function useVdzResizeDrag(
  id: VdzPanelId,
  currentSize: number,
  setSize: (id: VdzPanelId, size: number) => void,
  axis: 'x' | 'y',
  dir: 1 | -1
) {
  const sizeRef = useRef(currentSize);
  sizeRef.current = currentSize;
  const rafRef = useRef(0);
  const pendingRef = useRef<number | null>(null);

  // Cancel any queued frame if the component using this drag unmounts mid-drag.
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Left button only; ignore secondary/context pointers.
      if (event.button !== 0) return;
      event.preventDefault();

      const startPos = axis === 'x' ? event.clientX : event.clientY;
      const startSize = sizeRef.current;
      const handle = event.currentTarget;
      handle.setPointerCapture?.(event.pointerId);
      handle.dataset.dragging = 'true';
      // Lock the whole page's cursor + kill text selection during the drag.
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      const flush = () => {
        rafRef.current = 0;
        if (pendingRef.current != null) {
          setSize(id, pendingRef.current);
          pendingRef.current = null;
        }
      };

      const onMove = (e: PointerEvent) => {
        const pos = axis === 'x' ? e.clientX : e.clientY;
        const delta = (pos - startPos) * dir;
        pendingRef.current = startSize + delta;
        if (!rafRef.current) rafRef.current = requestAnimationFrame(flush);
      };

      const onUp = () => {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        // Apply the final position synchronously so we never drop the last move.
        if (pendingRef.current != null) {
          setSize(id, pendingRef.current);
          pendingRef.current = null;
        }
        handle.dataset.dragging = 'false';
        handle.releasePointerCapture?.(event.pointerId);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [axis, dir, id, setSize]
  );
}
