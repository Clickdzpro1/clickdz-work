/**
 * ClickDz Mobile — Barrel Export
 *
 * Hermes Wiring Pattern:
 *   All mobile components and hooks are re-exported from this module so the
 *   workspace router can import from a single entry point:
 *
 *     import { MobileLayout, MobileTabBar, AdminDrawer, useMobileDetect, ... }
 *       from '@/clickdz/mobile';
 *
 * Files are organized under packages/frontend/core/src/clickdz/mobile/.
 *
 * Phases:
 *   Phase A — Layout shell, tab bar, admin drawer, responsive detect, hardware back
 *   Phase B — BottomSheet, OrderCard
 *   Phase C — CaissePad, SwipeReview, AgentChatMobile (per-surface mobile UX)
 */

// ── Phase A: Shell & Navigation ────────────────────────────────────────────────

export { MobileLayout } from './MobileLayout';
export { MobileTabBar } from './MobileTabBar';
export { AdminDrawer } from './AdminDrawer';

export { useMobileDetect } from './useMobileDetect';
export { useHardwareBack } from './useHardwareBack';

// ── Phase B: Surface Components ────────────────────────────────────────────────

export { BottomSheet } from './BottomSheet';
export { OrderCard } from './OrderCard';

// ── Phase C: Per‑Surface Mobile UX ─────────────────────────────────────────────
//   In the real codebase these live side‑by‑side with the Phase B files.
//   During staging they reside in ../clickdz-mobile-phasec/.

export { CaissePad } from '../clickdz-mobile-phasec/CaissePad';
export { SwipeReview } from '../clickdz-mobile-phasec/SwipeReview';
export { AgentChatMobile } from '../clickdz-mobile-phasec/AgentChatMobile';

// ── Colors ─────────────────────────────────────────────────────────────────────

export { MOBILE_COLORS } from './colors';

// ── Types ──────────────────────────────────────────────────────────────────────

// Phase A + B types
export type {
  MobileTab,
  MobileTabDef,
  ShopCategoryId,
  ShopTabItem,
  ShopCategory,
  OrderStatus,
  OrderAction,
  MobileOrder,
  SnapPoint,
  BottomSheetProps,
} from './types';

// Phase C types
export type { CaissePadProps } from '../clickdz-mobile-phasec/CaissePad';
export type {
  SwipeReviewProps,
  SwipeReviewItem,
} from '../clickdz-mobile-phasec/SwipeReview';
export type {
  AgentChatMobileProps,
  AgentInfo,
  ChatMessage,
  ChatFile,
} from '../clickdz-mobile-phasec/AgentChatMobile';

export type { MobileDetectResult } from './useMobileDetect';
export type { BackHandlerFn, BackHandlerId } from './useHardwareBack';
