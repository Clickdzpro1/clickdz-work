/**
 * BottomSheet — Reusable Slide-Up Sheet Wrapping @radix-ui/react-dialog
 *
 * Hermes Wiring Pattern:
 *   data-cdz-surface is applied to the outermost sheet panel so CSS-in-JS
 *   responsive rules can target it. Uses <CdzResponsive> for CSS injection.
 *
 * Features:
 *   - Slides up from bottom with CSS transition (no framer-motion needed)
 *   - Three snap points: peek (148px), half (355px), full (100dvh - 16px)
 *   - Backdrop tap-to-close (pointer-events on overlay)
 *   - Touch swipe-down-to-dismiss (50px threshold)
 *   - Hardware back integration via cdz:back-requested custom event
 *
 * Props (see types.ts):
 *   open, onClose, children, snapPoints?, title?
 */

import * as Dialog from '@radix-ui/react-dialog';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MOBILE_COLORS } from './colors';

// ─── Snap Point Heights ───────────────────────────────────────────────────────

const SNAP_HEIGHTS: Record<string, string> = {
  peek: '148px',
  half: '355px',
  full: 'calc(100dvh - 16px)',
};

const SWIPE_DISMISS_THRESHOLD = 50; // px

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    backgroundColor: MOBILE_COLORS.backdrop,
    zIndex: 1100,
    // Fade transition
    opacity: 0,
    transition: 'opacity 0.25s ease',
  } as React.CSSProperties,

  overlayOpen: {
    opacity: 1,
  } as React.CSSProperties,

  sheet: {
    position: 'fixed' as const,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 1101,
    display: 'flex',
    flexDirection: 'column' as const,
    backgroundColor: MOBILE_COLORS.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    boxShadow: `0 -8px 32px ${MOBILE_COLORS.shadow}`,
    maxHeight: '95dvh',
    overflow: 'hidden',
    // Slide-up transition
    transform: 'translateY(100%)',
    transition: 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
  } as React.CSSProperties,

  sheetOpen: {
    transform: 'translateY(0)',
  } as React.CSSProperties,

  sheetSnap: (snap: string): React.CSSProperties => ({
    maxHeight: SNAP_HEIGHTS[snap] || 'auto',
    transition: 'max-height 0.25s ease, transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
  }),

  dragHandle: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '12px 0 8px',
    flexShrink: 0,
    cursor: 'grab',
    touchAction: 'none' as const,
  } as React.CSSProperties,

  dragHandleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: MOBILE_COLORS.borderStrong,
  } as React.CSSProperties,

  titleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 20px 12px',
    flexShrink: 0,
  } as React.CSSProperties,

  title: {
    fontSize: 17,
    fontWeight: 600,
    color: MOBILE_COLORS.textPrimary,
    lineHeight: '24px',
  } as React.CSSProperties,

  content: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '0 16px 24px',
    WebkitOverflowScrolling: 'touch' as const,
  } as React.CSSProperties,

  closeBtn: {
    width: 32,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    border: 'none',
    color: MOBILE_COLORS.textMuted,
    fontSize: 18,
    cursor: 'pointer',
    borderRadius: 16,
    lineHeight: '32px',
  } as React.CSSProperties,
};

// ─── Component ────────────────────────────────────────────────────────────────

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Snap points in preference order. Default: ['full']. */
  snapPoints?: ('peek' | 'half' | 'full')[];
  /** Optional title row (includes drag handle when absent) */
  title?: string;
  /** If true, sheet is not dismissible via backdrop/swipe */
  modal?: boolean;
}

export function BottomSheet({
  open,
  onClose,
  children,
  snapPoints = ['full'],
  title,
  modal = false,
}: BottomSheetProps) {
  // ── Snap state ──────────────────────────────────────────────────────────
  const [currentSnap, setCurrentSnap] = useState<string>(snapPoints[0] ?? 'full');
  const [isOpen, setIsOpen] = useState(false);

  // Driver refs for touch gesture
  const sheetRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number>(0);
  const touchCurrentY = useRef<number>(0);
  const isDragging = useRef(false);
  const animFrame = useRef<number>(0);

  // Sync Radix open with internal animation state
  useEffect(() => {
    if (open) {
      // Trigger enter animation on next frame so the DOM is painted
      const raf = requestAnimationFrame(() => {
        setIsOpen(true);
        setCurrentSnap(snapPoints[0] ?? 'full');
      });
      return () => cancelAnimationFrame(raf);
    } else {
      setIsOpen(false);
    }
  }, [open, snapPoints]);

  const handleClose = useCallback(() => {
    if (modal) return;
    setIsOpen(false);
    // Delay onClose until transition completes
    setTimeout(() => {
      onClose();
    }, 300);
  }, [onClose, modal]);

  // ── Touch / Swipe Gesture ───────────────────────────────────────────────

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (modal) return;
      const touch = e.touches[0];
      touchStartY.current = touch.clientY;
      touchCurrentY.current = touch.clientY;
      isDragging.current = true;
    },
    [modal]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isDragging.current || modal) return;
      touchCurrentY.current = e.touches[0].clientY;

      // Apply live transform for swipe feedback
      cancelAnimationFrame(animFrame.current);
      animFrame.current = requestAnimationFrame(() => {
        if (!sheetRef.current) return;
        const delta = touchCurrentY.current - touchStartY.current;
        if (delta > 0) {
          // Only allow dragging down
          sheetRef.current.style.transform = `translateY(${delta}px)`;
          sheetRef.current.style.transition = 'none';
        }
      });
    },
    [modal]
  );

  const onTouchEnd = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    cancelAnimationFrame(animFrame.current);

    const delta = touchCurrentY.current - touchStartY.current;

    if (sheetRef.current) {
      sheetRef.current.style.transition =
        'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)';
      sheetRef.current.style.transform = '';
    }

    if (delta > SWIPE_DISMISS_THRESHOLD && !modal) {
      handleClose();
    }
  }, [handleClose, modal]);

  // ── Snap cycling on drag handle tap ─────────────────────────────────────

  const cycleSnap = useCallback(() => {
    const idx = snapPoints.indexOf(currentSnap as any);
    const nextIdx = (idx + 1) % snapPoints.length;
    setCurrentSnap(snapPoints[nextIdx]);
  }, [currentSnap, snapPoints]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
      modal={modal}
    >
      <Dialog.Portal>
        {/* ── Overlay / Backdrop ────────────────────────────────────── */}
        <Dialog.Overlay
          style={{
            ...styles.overlay,
            ...(isOpen ? styles.overlayOpen : {}),
          }}
          onClick={modal ? undefined : handleClose}
        />

        {/* ── Sheet Panel ───────────────────────────────────────────── */}
        <Dialog.Content
          ref={sheetRef}
          data-cdz-surface="bottom-sheet"
          aria-describedby={undefined}
          style={{
            ...styles.sheet,
            ...(isOpen ? styles.sheetOpen : {}),
            ...styles.sheetSnap(currentSnap),
          }}
          onPointerDownOutside={modal ? undefined : handleClose}
          onEscapeKeyDown={modal ? undefined : handleClose}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {/* ── Drag Handle ──────────────────────────────────────── */}
          <div
            style={styles.dragHandle}
            onClick={snapPoints.length > 1 ? cycleSnap : undefined}
            role="button"
            tabIndex={0}
            aria-label={
              snapPoints.length > 1
                ? 'Modifier la hauteur de la feuille'
                : 'Poignée de défilement'
            }
          >
            <div style={styles.dragHandleBar} />
          </div>

          {/* ── Title Row ────────────────────────────────────────── */}
          {title ? (
            <div style={styles.titleRow}>
              <span style={styles.title}>{title}</span>
              <button
                style={styles.closeBtn}
                onClick={handleClose}
                aria-label="Fermer"
                type="button"
              >
                ✕
              </button>
            </div>
          ) : null}

          {/* ── Scrollable Content ────────────────────────────────── */}
          <div style={styles.content}>{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default BottomSheet;
