import {
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import * as styles from './index.css';
import {
  type UseVdzLayout,
  type VdzPanelId,
  useVdzResizeDrag,
} from './use-vdz-layout';

// ---- Reusable slim panel chrome -----------------------------------------

interface VdzPanelProps extends PropsWithChildren {
  /** Panel title shown in the slim header strip. */
  title: string;
  /** Optional dot / count / control rendered before the collapse button. */
  accessory?: ReactNode;
  /** Called when the header collapse (×) button is pressed. */
  onCollapse: () => void;
  /** Extra className for the panel body (defaults to a scrolling column). */
  bodyClassName?: string;
  /** Test id passthrough. */
  'data-testid'?: string;
}

/**
 * A consistent slim panel: a header strip (title + accessory + collapse ×) over
 * a body. Every workspace panel wears this so hide/resize/reopen behave the
 * same everywhere. Styling lives in index.css.ts (the Vdz dark palette).
 */
export function VdzPanel({
  title,
  accessory,
  onCollapse,
  bodyClassName,
  children,
  ...rest
}: VdzPanelProps) {
  return (
    <div className={styles.vdzPanel} data-testid={rest['data-testid']}>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>{title}</span>
        <span className={styles.panelHeaderSpacer} />
        {accessory}
        <button
          type="button"
          className={styles.panelCollapse}
          onClick={onCollapse}
          title={`Hide ${title}`}
          aria-label={`Hide ${title}`}
        >
          ×
        </button>
      </div>
      <div className={bodyClassName ?? styles.panelBody}>{children}</div>
    </div>
  );
}

// ---- Resize handle -------------------------------------------------------

interface VdzResizeHandleProps {
  id: VdzPanelId;
  size: number;
  setSize: (id: VdzPanelId, size: number) => void;
  /** Reset this panel to its default size (double-click). */
  onReset: () => void;
  /** Drag axis: 'x' for a vertical seam, 'y' for a horizontal seam. */
  axis: 'x' | 'y';
  /** Which way the panel grows relative to pointer movement. */
  dir: 1 | -1;
  'aria-label'?: string;
}

/**
 * A thin (6px) drag seam between two panels. Pointer-based + rAF-batched via
 * {@link useVdzResizeDrag}; double-click resets the panel to its default size.
 */
export function VdzResizeHandle({
  id,
  size,
  setSize,
  onReset,
  axis,
  dir,
  ...rest
}: VdzResizeHandleProps) {
  const onPointerDown = useVdzResizeDrag(id, size, setSize, axis, dir);
  return (
    <div
      className={axis === 'x' ? styles.resizeHandleX : styles.resizeHandleY}
      data-axis={axis}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={rest['aria-label']}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    />
  );
}

// ---- Reopen tab (shown at an edge when a panel is hidden) ----------------

interface VdzReopenTabProps {
  label: string;
  edge: 'left' | 'right' | 'bottom';
  onClick: () => void;
  /**
   * Stacking slot (0-based) when multiple tabs share an edge. Shifts the tab
   * along the edge so they never overlap (down the side for left/right, left
   * along the bottom for bottom).
   */
  index?: number;
}

// One reopen-tab "cell" + gap along its edge (matches the tab's own footprint).
const REOPEN_STEP = 96;

/** A slim always-visible tab that brings a hidden panel back. */
export function VdzReopenTab({
  label,
  edge,
  onClick,
  index = 0,
}: VdzReopenTabProps) {
  // Offset along the edge: top for vertical (left/right) tabs, right for bottom.
  const offset = index * REOPEN_STEP;
  const style =
    edge === 'bottom'
      ? { right: 16 + offset }
      : { top: 12 + offset };
  return (
    <button
      type="button"
      className={styles.reopenTab}
      data-edge={edge}
      style={style}
      onClick={onClick}
      title={`Show ${label}`}
      aria-label={`Show ${label}`}
    >
      {label}
    </button>
  );
}

// ---- View menu (header dropdown that checkmarks visible panels) ----------

const VIEW_MENU_ITEMS: { id: VdzPanelId; label: string; hint: string }[] = [
  { id: 'mediaBin', label: 'Media', hint: 'Cmd/Ctrl+1' },
  { id: 'inspector', label: 'Inspector', hint: 'Cmd/Ctrl+2' },
  { id: 'aiDock', label: 'AI', hint: 'Cmd/Ctrl+3' },
  { id: 'timeline', label: 'Timeline', hint: 'Cmd/Ctrl+4' },
];

interface VdzViewMenuProps {
  layout: UseVdzLayout['layout'];
  onToggle: (id: VdzPanelId) => void;
  onReset: () => void;
  /** Disabled item ids (e.g. hidden-by-mode in Generate). */
  disabledIds?: ReadonlySet<VdzPanelId>;
}

/**
 * The page-header "View" control: a dropdown of the four panels with a checkmark
 * on each visible one, plus a "Reset layout" action. Self-contained (no Radix /
 * theme deps) to match the shell's dark, palette-locked surface.
 */
export function VdzViewMenu({
  layout,
  onToggle,
  onReset,
  disabledIds,
}: VdzViewMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const visibleCount = VIEW_MENU_ITEMS.filter(
    item => layout[item.id].visible
  ).length;

  const onItemClick = useCallback(
    (id: VdzPanelId) => () => onToggle(id),
    [onToggle]
  );

  return (
    <div className={styles.viewMenuRoot} ref={rootRef}>
      <button
        type="button"
        className={styles.viewMenuTrigger}
        data-open={open}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        title="Show or hide workspace panels"
      >
        <span className={styles.viewMenuGlyph} aria-hidden="true">
          ▦
        </span>
        View
        <span className={styles.viewMenuBadge}>{visibleCount}/4</span>
      </button>

      {open ? (
        <div className={styles.viewMenu} role="menu">
          {VIEW_MENU_ITEMS.map(item => {
            const checked = layout[item.id].visible;
            const disabled = disabledIds?.has(item.id) ?? false;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                className={styles.viewMenuItem}
                data-checked={checked}
                disabled={disabled}
                onClick={onItemClick(item.id)}
              >
                <span className={styles.viewMenuCheck} aria-hidden="true">
                  {checked ? '✓' : ''}
                </span>
                <span className={styles.viewMenuLabel}>{item.label}</span>
                <span className={styles.viewMenuHint}>{item.hint}</span>
              </button>
            );
          })}
          <div className={styles.viewMenuSep} />
          <button
            type="button"
            role="menuitem"
            className={styles.viewMenuItem}
            onClick={onReset}
          >
            <span className={styles.viewMenuCheck} aria-hidden="true" />
            <span className={styles.viewMenuLabel}>Reset layout</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
