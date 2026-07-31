/**
 * SwipeReview — Swipe-to-Approve/Reject for Vdz/VPic Mobile Review
 *
 * Hermes Wiring Pattern:
 *   data-cdz-surface="swipe-review" on the card root.
 *   Uses CdzResponsive null-component for CSS injection.
 *
 * Features:
 *   - Swipe left  = reject  (red tint > 80px → fires onReject)
 *   - Swipe right = approve (green tint > 80px → fires onApprove)
 *   - Pinch-to-zoom on image content via CSS touch-action + scale transform
 *   - Visual feedback during swipe: green/red tint proportional to offset
 *   - Auto-advances after action (card slides off, next card enters)
 *   - "Ouvrir sur PC pour modifier" hint when editing controls are hidden
 *   - French UI labels
 *
 * Props:
 *   items: SwipeReviewItem[]         – list of items to review
 *   onApprove(item): void            – called when user swipes right past threshold
 *   onReject(item): void             – called when user swipes left past threshold
 *   onComplete?(): void              – called when all items are reviewed
 *   showEditorHint?: boolean         – shows "Open on desktop" hint
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
} from 'react';
import { MOBILE_COLORS } from '../clickdz-mobile/colors';

// ─── Hermes CSS Injection ──────────────────────────────────────────────────────

function ensureClickDzResponsiveCss(): void {
  if (typeof document === 'undefined') return;
  const id = 'cdz-responsive-css';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    [data-cdz-surface="swipe-review"] {
      overflow: hidden;
      touch-action: pan-y;
    }
    @media (min-width: 600px) {
      [data-cdz-surface="swipe-review"] {
        max-width: 420px;
        margin: 0 auto;
      }
    }
  `;
  document.head.appendChild(style);
}

function CdzResponsive(): null {
  useEffect(() => { ensureClickDzResponsiveCss(); }, []);
  return null;
}

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface SwipeReviewItem {
  id: string;
  /** Main image URL to display for review */
  imageUrl?: string;
  /** Document type label, e.g. "VDZ", "VPIC", "Facture" */
  docType: string;
  /** Title / summary of the item */
  title: string;
  /** Subtitle / metadata line */
  subtitle?: string;
  /** Amount in DZD if applicable */
  amountDzd?: number;
  /** Timestamp or date string */
  dateLabel?: string;
}

export interface SwipeReviewProps {
  items: SwipeReviewItem[];
  onApprove: (item: SwipeReviewItem) => void;
  onReject: (item: SwipeReviewItem) => void;
  onComplete?: () => void;
  /** Show "Ouvrir sur PC pour modifier" hint below the card */
  showEditorHint?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const SWIPE_THRESHOLD = 80; // px — must swipe past this to trigger action
const SWIPE_MAX_OPACITY = 0.6; // max tint opacity at threshold
const CARD_EXIT_DURATION = 300; // ms for exit animation

// ─── Styles ─────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100dvh',
    backgroundColor: MOBILE_COLORS.appBg,
    color: MOBILE_COLORS.textPrimary,
    overflow: 'hidden',
    position: 'relative',
  },

  stack: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },

  cardWrapper: {
    position: 'absolute',
    inset: 16,
    display: 'flex',
    flexDirection: 'column',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: MOBILE_COLORS.surface,
    border: `1px solid ${MOBILE_COLORS.border}`,
    boxShadow: `0 4px 24px ${MOBILE_COLORS.shadow}`,
    transition: `transform ${CARD_EXIT_DURATION}ms ease, opacity ${CARD_EXIT_DURATION}ms ease`,
    willChange: 'transform',
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },

  imageContainer: {
    position: 'relative',
    flex: 1,
    minHeight: 200,
    backgroundColor: MOBILE_COLORS.surfaceAlt,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    touchAction: 'manipulation', // allows pinch-to-zoom on the image itself
  },

  image: (scale: number): React.CSSProperties => ({
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    transform: `scale(${scale})`,
    transition: scale === 1 ? 'transform 0.2s ease' : 'none',
    touchAction: 'manipulation',
  }),

  imagePlaceholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    color: MOBILE_COLORS.textMuted,
    fontSize: 48,
    opacity: 0.4,
  },

  imagePlaceholderLabel: {
    fontSize: 14,
    fontWeight: 500,
  },

  infoCard: {
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    borderTop: `1px solid ${MOBILE_COLORS.divider}`,
  },

  docTypeChip: {
    display: 'inline-flex',
    alignSelf: 'flex-start',
    padding: '3px 10px',
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.5px',
    backgroundColor: MOBILE_COLORS.accentMuted,
    color: MOBILE_COLORS.accent,
  },

  title: {
    fontSize: 18,
    fontWeight: 700,
    lineHeight: 1.3,
  },

  subtitle: {
    fontSize: 14,
    color: MOBILE_COLORS.textSecondary,
    lineHeight: 1.4,
  },

  amount: {
    fontSize: 20,
    fontWeight: 700,
    color: MOBILE_COLORS.accent,
  },

  dateLabel: {
    fontSize: 12,
    color: MOBILE_COLORS.textMuted,
  },

  // ── Action hints that appear during swipe ──────────────────────────────────
  actionOverlay: (side: 'left' | 'right', intensity: number): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    padding: '0 24px',
    pointerEvents: 'none',
    opacity: intensity,
    transition: 'opacity 0.05s linear',
    ...(side === 'left'
      ? { left: 0, justifyContent: 'flex-start', backgroundColor: 'transparent' }
      : { right: 0, justifyContent: 'flex-end', backgroundColor: 'transparent' }),
  }),

  actionLabel: (side: 'left' | 'right'): React.CSSProperties => ({
    fontSize: 28,
    fontWeight: 800,
    letterSpacing: '1px',
    textTransform: 'uppercase',
    color: side === 'left' ? '#EF4444' : '#10B981',
    border: `3px solid ${side === 'left' ? '#EF4444' : '#10B981'}`,
    borderRadius: 12,
    padding: '8px 20px',
    transform: side === 'left' ? 'rotate(-8deg)' : 'rotate(8deg)',
  }),

  // ── Tint overlay (red/green) ──────────────────────────────────────────────
  tintOverlay: (
    side: 'left' | 'right',
    intensity: number,
  ): React.CSSProperties => ({
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    borderRadius: 16,
    backgroundColor:
      side === 'left'
        ? `rgba(239, 68, 68, ${intensity * SWIPE_MAX_OPACITY})`
        : `rgba(16, 185, 129, ${intensity * SWIPE_MAX_OPACITY})`,
    transition: 'background-color 0.05s linear',
  }),

  // ── Counter / progress ────────────────────────────────────────────────────
  counter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '12px 16px',
    paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
  },

  counterDot: (active: boolean): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: active ? MOBILE_COLORS.accent : MOBILE_COLORS.borderStrong,
    transition: 'background-color 0.2s ease',
  }),

  counterText: {
    fontSize: 14,
    color: MOBILE_COLORS.textSecondary,
    fontWeight: 500,
  },

  // ── Empty state ───────────────────────────────────────────────────────────
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 32,
  },

  emptyIcon: {
    fontSize: 56,
    opacity: 0.5,
  },

  emptyText: {
    fontSize: 18,
    fontWeight: 600,
    textAlign: 'center',
  },

  emptySub: {
    fontSize: 14,
    color: MOBILE_COLORS.textMuted,
    textAlign: 'center',
  },

  // ── Desktop hint ──────────────────────────────────────────────────────────
  desktopHint: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '10px 16px',
    backgroundColor: MOBILE_COLORS.surfaceAlt,
    borderRadius: 10,
    margin: '0 16px 8px',
    fontSize: 13,
    color: MOBILE_COLORS.textMuted,
    fontStyle: 'italic',
  },

  // ── Quick action buttons (fallback for non-swipe) ─────────────────────────
  actionBar: {
    display: 'flex',
    gap: 12,
    padding: '0 16px 16px',
  },

  actionBtn: (variant: 'approve' | 'reject'): React.CSSProperties => ({
    flex: 1,
    minHeight: 52,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    border: 'none',
    borderRadius: 14,
    fontSize: 16,
    fontWeight: 700,
    cursor: 'pointer',
    backgroundColor:
      variant === 'approve'
        ? '#10B981'
        : 'rgba(239, 68, 68, 0.9)',
    color: '#FFFFFF',
    transition: 'opacity 0.12s ease',
    WebkitTapHighlightColor: 'transparent',
  }),
};

// ─── Component ──────────────────────────────────────────────────────────────────

export function SwipeReview({
  items,
  onApprove,
  onReject,
  onComplete,
  showEditorHint = true,
}: SwipeReviewProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [swipeOffset, setSwipeOffset] = useState(0); // px
  const [isAnimating, setIsAnimating] = useState(false);
  const [imageScale, setImageScale] = useState(1);

  // Touch tracking refs
  const touchStartX = useRef(0);
  const touchCurrentX = useRef(0);
  const isSwiping = useRef(false);

  // Pinch tracking refs
  const pinchStartDist = useRef(0);
  const pinchStartScale = useRef(1);
  const isPinching = useRef(false);

  // Container ref for relative coordinates
  const containerRef = useRef<HTMLDivElement>(null);

  const currentItem = items[currentIndex] ?? null;
  const hasItems = items.length > 0;
  const isDone = currentIndex >= items.length;

  // ── Swipe intensity (0..1) ──────────────────────────────────────────────────
  const swipeIntensity = Math.min(Math.abs(swipeOffset) / SWIPE_THRESHOLD, 1);
  const swipeDirection: 'left' | 'right' | null =
    swipeOffset < -5 ? 'left' : swipeOffset > 5 ? 'right' : null;

  // ── Touch handlers ───────────────────────────────────────────────────────────

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (isAnimating || !currentItem) return;
      // If two fingers → pinch
      if (e.touches.length === 2) {
        isPinching.current = true;
        isSwiping.current = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDist.current = Math.hypot(dx, dy);
        pinchStartScale.current = imageScale;
        return;
      }
      // Single finger → swipe
      isPinching.current = false;
      isSwiping.current = true;
      touchStartX.current = e.touches[0].clientX;
      touchCurrentX.current = e.touches[0].clientX;
    },
    [isAnimating, currentItem, imageScale],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (isPinching.current && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        if (pinchStartDist.current > 0) {
          const newScale = Math.min(
            Math.max(pinchStartScale.current * (dist / pinchStartDist.current), 1),
            3,
          );
          setImageScale(newScale);
        }
        return;
      }
      if (!isSwiping.current) return;
      touchCurrentX.current = e.touches[0].clientX;
      const delta = touchCurrentX.current - touchStartX.current;
      setSwipeOffset(delta);
    },
    [],
  );

  const handleTouchEnd = useCallback(() => {
    if (isPinching.current) {
      isPinching.current = false;
      // Reset pinch after a short delay for smooth transition
      setTimeout(() => setImageScale(1), 150);
      return;
    }
    if (!isSwiping.current || !currentItem) {
      isSwiping.current = false;
      return;
    }
    isSwiping.current = false;

    const delta = touchCurrentX.current - touchStartX.current;

    if (delta > SWIPE_THRESHOLD) {
      // Approve — swipe right
      setIsAnimating(true);
      setSwipeOffset(delta > 300 ? 300 : delta);
      setTimeout(() => {
        onApprove(currentItem);
        advance();
      }, CARD_EXIT_DURATION);
    } else if (delta < -SWIPE_THRESHOLD) {
      // Reject — swipe left
      setIsAnimating(true);
      setSwipeOffset(delta < -300 ? -300 : delta);
      setTimeout(() => {
        onReject(currentItem);
        advance();
      }, CARD_EXIT_DURATION);
    } else {
      // Snap back
      setSwipeOffset(0);
      setImageScale(1);
    }
  }, [currentItem, onApprove, onReject]);

  const advance = useCallback(() => {
    setSwipeOffset(0);
    setImageScale(1);
    setIsAnimating(false);
    const next = currentIndex + 1;
    setCurrentIndex(next);
    if (next >= items.length) {
      onComplete?.();
    }
  }, [currentIndex, items.length, onComplete]);

  // ── Quick button handlers (accessibility fallback) ───────────────────────────

  const handleApproveBtn = useCallback(() => {
    if (!currentItem || isAnimating) return;
    setIsAnimating(true);
    setSwipeOffset(300);
    setTimeout(() => {
      onApprove(currentItem);
      advance();
    }, CARD_EXIT_DURATION);
  }, [currentItem, isAnimating, onApprove, advance]);

  const handleRejectBtn = useCallback(() => {
    if (!currentItem || isAnimating) return;
    setIsAnimating(true);
    setSwipeOffset(-300);
    setTimeout(() => {
      onReject(currentItem);
      advance();
    }, CARD_EXIT_DURATION);
  }, [currentItem, isAnimating, onReject, advance]);

  // ── Card transform style ─────────────────────────────────────────────────────

  const cardTransform = useMemo<React.CSSProperties>(() => {
    const translateX = swipeOffset;
    const rotate = swipeOffset * 0.05; // slight rotation for realism
    return {
      transform: `translateX(${translateX}px) rotate(${rotate}deg)`,
      opacity: isAnimating ? 0 : 1,
    };
  }, [swipeOffset, isAnimating]);

  // ── Format amount ────────────────────────────────────────────────────────────

  const formatDzd = useCallback((amount: number): string => {
    return amount.toLocaleString('fr-DZ', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' DZD';
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      style={styles.container}
      data-cdz-surface="swipe-review"
    >
      <CdzResponsive />

      {isDone ? (
        /* ── All Reviewed Empty State ───────────────────────────────────── */
        <div style={styles.empty}>
          <div style={styles.emptyIcon}>✅</div>
          <div style={styles.emptyText}>Tout est examiné</div>
          <div style={styles.emptySub}>
            {items.length} document{items.length > 1 ? 's' : ''} traité{items.length > 1 ? 's' : ''}
          </div>
        </div>
      ) : !hasItems ? (
        /* ── No Items Empty State ───────────────────────────────────────── */
        <div style={styles.empty}>
          <div style={styles.emptyIcon}>📭</div>
          <div style={styles.emptyText}>Aucun document</div>
          <div style={styles.emptySub}>
            Les VDZ et VPIC à vérifier apparaîtront ici
          </div>
        </div>
      ) : (
        <>
          {/* ── Card Stack ──────────────────────────────────────────────── */}
          <div style={styles.stack}>
            <div
              style={{
                ...styles.cardWrapper,
                ...cardTransform,
              }}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              {/* Tint overlay */}
              {swipeDirection && (
                <div
                  style={styles.tintOverlay(swipeDirection, swipeIntensity)}
                />
              )}

              {/* Action label overlay */}
              {swipeDirection === 'right' && swipeIntensity > 0.3 && (
                <div style={styles.actionOverlay('right', swipeIntensity)}>
                  <span style={styles.actionLabel('right')}>Valider</span>
                </div>
              )}
              {swipeDirection === 'left' && swipeIntensity > 0.3 && (
                <div style={styles.actionOverlay('left', swipeIntensity)}>
                  <span style={styles.actionLabel('left')}>Refuser</span>
                </div>
              )}

              {/* Image area with pinch-to-zoom */}
              <div style={styles.imageContainer}>
                {currentItem.imageUrl ? (
                  <img
                    src={currentItem.imageUrl}
                    alt={currentItem.title}
                    style={styles.image(imageScale)}
                    draggable={false}
                    onLoad={() => setImageScale(1)}
                  />
                ) : (
                  <div style={styles.imagePlaceholder}>
                    <span>📄</span>
                    <span style={styles.imagePlaceholderLabel}>
                      {currentItem.docType}
                    </span>
                  </div>
                )}
              </div>

              {/* Info card */}
              <div style={styles.infoCard}>
                <span style={styles.docTypeChip}>{currentItem.docType}</span>
                <div style={styles.title}>{currentItem.title}</div>
                {currentItem.subtitle && (
                  <div style={styles.subtitle}>{currentItem.subtitle}</div>
                )}
                {currentItem.amountDzd !== undefined && (
                  <div style={styles.amount}>
                    {formatDzd(currentItem.amountDzd)}
                  </div>
                )}
                {currentItem.dateLabel && (
                  <div style={styles.dateLabel}>{currentItem.dateLabel}</div>
                )}
              </div>
            </div>
          </div>

          {/* ── Progress Dots ───────────────────────────────────────────── */}
          <div style={styles.counter}>
            {items.map((_, i) => (
              <div
                key={i}
                style={styles.counterDot(i === currentIndex)}
              />
            ))}
            <span style={styles.counterText}>
              {currentIndex + 1} / {items.length}
            </span>
          </div>

          {/* ── Desktop editing hint ────────────────────────────────────── */}
          {showEditorHint && (
            <div style={styles.desktopHint}>
              <span>💻</span>
              <span>Ouvrir sur PC pour modifier</span>
            </div>
          )}

          {/* ── Quick action buttons ────────────────────────────────────── */}
          <div style={styles.actionBar}>
            <button
              type="button"
              style={styles.actionBtn('reject')}
              onClick={handleRejectBtn}
              disabled={isAnimating}
            >
              ✕ Refuser
            </button>
            <button
              type="button"
              style={styles.actionBtn('approve')}
              onClick={handleApproveBtn}
              disabled={isAnimating}
            >
              ✓ Valider
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default SwipeReview;
