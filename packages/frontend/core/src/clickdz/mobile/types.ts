/**
 * ClickDz Mobile — Shared Types
 *
 * Hermes Wiring Pattern:
 *   import { ensureClickDzResponsiveCss } from '../utils/responsive';
 *   ensureClickDzResponsiveCss(); // injects data-cdz-surface, data-cdz-shell, data-cdz-rail markers
 *
 * All surface components render inside a <CdzResponsive> null-wrapper that calls the
 * CSS injection on mount. Markers are applied as data attributes on the outermost DOM node.
 */

// ─── Navigation ────────────────────────────────────────────────────────────────

export type MobileTab =
  | 'boutique'
  | 'commandes'
  | 'caisse'
  | 'agents'
  | 'docs'
  | 'plus';

export interface MobileTabDef {
  id: MobileTab;
  label: string;     // French UI label
  icon: string;      // emoji or Blocksuite icon name
  route: string;     // react-router route path
}

// ─── Admin Drawer Categories ───────────────────────────────────────────────────

export type ShopCategoryId = 'commerce' | 'boutique' | 'gestion' | 'admin';

export interface ShopTabItem {
  id: string;
  label: string;     // French
  route: string;
  icon?: string;
}

export interface ShopCategory {
  id: ShopCategoryId;
  label: string;     // French
  items: ShopTabItem[];
}

// ─── Order Card ────────────────────────────────────────────────────────────────

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'returned';

export type OrderAction = 'ship' | 'waybill' | 'refund';

export interface MobileOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  amountDzd: number;
  courierName?: string;
  status: OrderStatus;
  placedAt: string; // ISO string
}

// ─── Bottom Sheet ──────────────────────────────────────────────────────────────

export type SnapPoint = 'peek' | 'half' | 'full';

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  snapPoints?: SnapPoint[];
  title?: string;
}
