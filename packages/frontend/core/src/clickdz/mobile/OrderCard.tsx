/**
 * OrderCard — Phase C One-Thumb Triage List Card for Commandes
 *
 * Hermes Wiring Pattern:
 *   data-cdz-surface="order-card" marker on the card root.
 *
 * Layout (single column, no horizontal scroll):
 *   ┌─────────────────────────────────────────┐
 *   │ [StatusChip]                    #N° 481 │
 *   │                                         │
 *   │ 👤 Client Name                          │
 *   │ 💰 2 450,00 DZD                         │
 *   │ 🚚 Livré par Yalidine                   │
 *   │                                         │
 *   │        [ ── Expédier ── ]   ← 44px min  │
 *   └─────────────────────────────────────────┘
 *
 * Action mapping (context-sensitive):
 *   pending | confirmed | processing  →  Expédier  (green)
 *   shipped                           →  Bordereau (blue)
 *   returned                          →  Rembourser (red)
 *   delivered | cancelled | refunded  →  no action
 */

import React, { useCallback } from 'react';
import { MOBILE_COLORS } from './colors';
import type { MobileOrder, OrderAction, OrderStatus } from './types';

// ─── Status → Action Mapping ──────────────────────────────────────────────────

const STATUS_TO_ACTION: Record<OrderStatus, OrderAction | null> = {
  pending: 'ship',
  confirmed: 'ship',
  processing: 'ship',
  shipped: 'waybill',
  delivered: null,
  cancelled: null,
  refunded: null,
  returned: 'refund',
};

const ACTION_LABELS: Record<OrderAction, string> = {
  ship: 'Expédier',
  waybill: 'Bordereau',
  refund: 'Rembourser',
};

const ACTION_COLORS: Record<OrderAction, string> = {
  ship: MOBILE_COLORS.actionShip,
  waybill: MOBILE_COLORS.actionWaybill,
  refund: MOBILE_COLORS.actionRefund,
};

// ─── Status Chip Helpers ──────────────────────────────────────────────────────

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'En attente',
  confirmed: 'Confirmée',
  processing: 'En cours',
  shipped: 'Expédiée',
  delivered: 'Livrée',
  cancelled: 'Annulée',
  refunded: 'Remboursée',
  returned: 'Retournée',
};

const STATUS_COLORS: Record<OrderStatus, string> = {
  pending: MOBILE_COLORS.statusPending,
  confirmed: MOBILE_COLORS.statusConfirmed,
  processing: MOBILE_COLORS.statusProcessing,
  shipped: MOBILE_COLORS.statusShipped,
  delivered: MOBILE_COLORS.statusDelivered,
  cancelled: MOBILE_COLORS.statusCancelled,
  refunded: MOBILE_COLORS.statusRefunded,
  returned: MOBILE_COLORS.statusReturned,
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  card: {
    backgroundColor: MOBILE_COLORS.surface,
    borderRadius: 12,
    padding: '14px 16px',
    marginBottom: 10,
    border: `1px solid ${MOBILE_COLORS.border}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    // No horizontal scroll — single column
    overflow: 'hidden',
  },

  topRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  chip: (color: string): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px 10px',
    borderRadius: 100,
    backgroundColor: `${color}18`, // 10% opacity
    color,
    fontSize: 12,
    fontWeight: 600,
    lineHeight: '18px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.3px',
  }),

  orderNumber: {
    fontSize: 12,
    fontWeight: 500,
    color: MOBILE_COLORS.textMuted,
    lineHeight: '18px',
  },

  detailRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 14,
    lineHeight: '20px',
  },

  customerName: {
    fontSize: 15,
    fontWeight: 600,
    color: MOBILE_COLORS.textPrimary,
    lineHeight: '22px',
  },

  amount: {
    fontSize: 15,
    fontWeight: 700,
    color: MOBILE_COLORS.accent,
    lineHeight: '22px',
  },

  courierName: {
    fontSize: 13,
    color: MOBILE_COLORS.textSecondary,
    lineHeight: '18px',
  },

  mutedLabel: {
    fontSize: 13,
    color: MOBILE_COLORS.textMuted,
    lineHeight: '18px',
  },

  actionBtn: (color: string): React.CSSProperties => ({
    width: '100%',
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    border: `1px solid ${color}40`,
    backgroundColor: `${color}14`,
    color,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 4,
    lineHeight: '22px',
    // Touch optimizations
    touchAction: 'manipulation',
    userSelect: 'none' as const,
    WebkitTapHighlightColor: 'transparent',
  }),

  noActionPlaceholder: {
    width: '100%',
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    color: MOBILE_COLORS.textMuted,
    marginTop: 4,
    lineHeight: '20px',
  },

  divider: {
    height: 1,
    backgroundColor: MOBILE_COLORS.divider,
    margin: '2px 0',
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

interface OrderCardProps {
  order: MobileOrder;
  /** Called with the order id and deduced action when the primary button is tapped. */
  onAction: (orderId: string, action: OrderAction) => void;
}

export function OrderCard({ order, onAction }: OrderCardProps) {
  const action = STATUS_TO_ACTION[order.status];

  const handleAction = useCallback(() => {
    if (action) {
      onAction(order.id, action);
    }
  }, [order.id, action, onAction]);

  const formattedAmount = new Intl.NumberFormat('fr-DZ', {
    style: 'decimal',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(order.amountDzd);

  return (
    <div style={styles.card} data-cdz-surface="order-card">
      {/* ── Top Row: Status Chip + Order Number ───────────────────── */}
      <div style={styles.topRow}>
        <span style={styles.chip(STATUS_COLORS[order.status])}>
          {STATUS_LABELS[order.status]}
        </span>
        <span style={styles.orderNumber}>N° {order.orderNumber}</span>
      </div>

      {/* ── Client Name ────────────────────────────────────────────── */}
      <div style={styles.detailRow}>
        <span>👤</span>
        <span style={styles.customerName}>{order.customerName}</span>
      </div>

      {/* ── Amount ─────────────────────────────────────────────────── */}
      <div style={styles.detailRow}>
        <span>💰</span>
        <span style={styles.amount}>{formattedAmount} DZD</span>
      </div>

      {/* ── Courier ────────────────────────────────────────────────── */}
      <div style={styles.detailRow}>
        <span>🚚</span>
        {order.courierName ? (
          <span style={styles.courierName}>{order.courierName}</span>
        ) : (
          <span style={styles.mutedLabel}>En attente d'affectation</span>
        )}
      </div>

      <div style={styles.divider} />

      {/* ── Primary Action Button ──────────────────────────────────── */}
      {action ? (
        <button
          style={styles.actionBtn(ACTION_COLORS[action])}
          onClick={handleAction}
          type="button"
        >
          {ACTION_LABELS[action]}
        </button>
      ) : (
        <div style={styles.noActionPlaceholder}>
          {order.status === 'delivered'
            ? 'Commande finalisée'
            : order.status === 'cancelled'
              ? 'Commande annulée'
              : 'Commande remboursée'}
        </div>
      )}
    </div>
  );
}

export default OrderCard;
