/**
 * AdminDrawer — Bottom Sheet Grid of 15 Shop Tabs in 4 Collapsible Categories
 *
 * Hermes Wiring Pattern:
 *   data-cdz-surface="admin-drawer" on the dialog content.
 *   Opens from MobileTabBar "Plus" button via @radix-ui/react-dialog.
 *
 * Categories (4 groups of shop tabs):
 *   Commerce   → Produits, Catégories, Marques, Promotions, Avis
 *   Boutique   → Thèmes, Pages, Navigation, Domaines, Préférences
 *   Gestion    → Clients, Coupons, Abandonnés, Notifications, Analytique
 *   Admin      → Rôles, Logs, Sauvegardes, API, Facturation
 *
 * Each category is a @radix-ui/react-collapsible (expandable section).
 * Tapping a tab navigates to that admin sub-route and closes the drawer.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import * as Collapsible from '@radix-ui/react-collapsible';
import { MOBILE_COLORS } from './colors';
import { useHardwareBack } from './useHardwareBack';
import type { ShopCategory, ShopCategoryId } from './types';

// ─── Shop Tab Data ────────────────────────────────────────────────────────────

const SHOP_CATEGORIES: ShopCategory[] = [
  {
    id: 'commerce',
    label: 'Commerce',
    items: [
      { id: 'products',     label: 'Produits',     route: '/workspace/products',     icon: '📦' },
      { id: 'categories',   label: 'Catégories',   route: '/workspace/categories',   icon: '📁' },
      { id: 'brands',       label: 'Marques',      route: '/workspace/brands',       icon: '🏷️' },
      { id: 'promotions',   label: 'Promotions',   route: '/workspace/promotions',   icon: '🎯' },
      { id: 'reviews',      label: 'Avis',         route: '/workspace/reviews',      icon: '⭐' },
    ],
  },
  {
    id: 'boutique',
    label: 'Boutique',
    items: [
      { id: 'themes',       label: 'Thèmes',       route: '/workspace/themes',       icon: '🎨' },
      { id: 'pages',        label: 'Pages',        route: '/workspace/pages',        icon: '📝' },
      { id: 'navigation',   label: 'Navigation',   route: '/workspace/navigation',   icon: '🧭' },
      { id: 'domains',      label: 'Domaines',     route: '/workspace/domains',      icon: '🌐' },
      { id: 'preferences',  label: 'Préférences',  route: '/workspace/preferences',  icon: '⚙️' },
    ],
  },
  {
    id: 'gestion',
    label: 'Gestion',
    items: [
      { id: 'clients',      label: 'Clients',      route: '/workspace/clients',      icon: '👥' },
      { id: 'coupons',      label: 'Coupons',      route: '/workspace/coupons',      icon: '🎟️' },
      { id: 'abandoned',    label: 'Abandonnés',   route: '/workspace/abandoned',    icon: '🛒' },
      { id: 'notifications',label: 'Notifications',route: '/workspace/notifications',icon: '🔔' },
      { id: 'analytics',    label: 'Analytique',   route: '/workspace/analytics',    icon: '📊' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    items: [
      { id: 'roles',        label: 'Rôles',        route: '/workspace/roles',        icon: '🔑' },
      { id: 'logs',         label: 'Logs',         route: '/workspace/logs',         icon: '📜' },
      { id: 'backups',      label: 'Sauvegardes',  route: '/workspace/backups',      icon: '💾' },
      { id: 'api',          label: 'API',          route: '/workspace/api',          icon: '🔌' },
      { id: 'billing',      label: 'Facturation',  route: '/workspace/billing',      icon: '💳' },
    ],
  },
];

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    backgroundColor: MOBILE_COLORS.backdrop,
    zIndex: 1200,
  } as React.CSSProperties,

  content: {
    position: 'fixed' as const,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 1201,
    display: 'flex',
    flexDirection: 'column' as const,
    backgroundColor: MOBILE_COLORS.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    boxShadow: `0 -8px 32px ${MOBILE_COLORS.shadow}`,
    maxHeight: '90dvh',
    overflow: 'hidden',
    // Slide-up animation
    animation: 'cdz-admin-drawer-slide-up 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
  } as React.CSSProperties,

  dragHandle: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '12px 0 8px',
    flexShrink: 0,
  } as React.CSSProperties,

  dragHandleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: MOBILE_COLORS.borderStrong,
  } as React.CSSProperties,

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 20px 12px',
    flexShrink: 0,
  } as React.CSSProperties,

  title: {
    fontSize: 18,
    fontWeight: 700,
    color: MOBILE_COLORS.textPrimary,
    lineHeight: '26px',
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

  scrollArea: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '0 16px 24px',
    WebkitOverflowScrolling: 'touch' as const,
  } as React.CSSProperties,

  // ── Category Collapsible ────────────────────────────────────────────────

  categorySection: {
    marginBottom: 12,
    borderRadius: 12,
    backgroundColor: MOBILE_COLORS.surfaceAlt,
    overflow: 'hidden',
    border: `1px solid ${MOBILE_COLORS.border}`,
  } as React.CSSProperties,

  categoryTrigger: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '14px 16px',
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: MOBILE_COLORS.textPrimary,
    fontSize: 15,
    fontWeight: 600,
    lineHeight: '22px',
    touchAction: 'manipulation',
    userSelect: 'none' as const,
    WebkitTapHighlightColor: 'transparent',
  } as React.CSSProperties,

  categoryChevron: (open: boolean): React.CSSProperties => ({
    fontSize: 14,
    color: MOBILE_COLORS.textMuted,
    transition: 'transform 0.2s ease',
    transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
    lineHeight: '20px',
  }),

  categoryContent: {
    padding: '0 16px 14px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  } as React.CSSProperties,

  // ── Shop Tab Item ──────────────────────────────────────────────────────

  shopTabItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    minHeight: 44,
    padding: '10px 12px',
    backgroundColor: MOBILE_COLORS.surfaceHover,
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    color: MOBILE_COLORS.textPrimary,
    fontSize: 14,
    fontWeight: 500,
    lineHeight: '20px',
    textAlign: 'left' as const,
    touchAction: 'manipulation',
    userSelect: 'none' as const,
    WebkitTapHighlightColor: 'transparent',
    transition: 'background-color 0.15s ease',
  } as React.CSSProperties,

  shopTabIcon: {
    fontSize: 18,
    lineHeight: '24px',
    width: 28,
    textAlign: 'center' as const,
    flexShrink: 0,
  } as React.CSSProperties,

  shopTabLabel: {
    flex: 1,
  } as React.CSSProperties,

  shopTabArrow: {
    fontSize: 14,
    color: MOBILE_COLORS.textMuted,
    lineHeight: '20px',
  } as React.CSSProperties,
};

// ─── Keyframe Animation (injected via <style>) ────────────────────────────────

const KEYFRAME_CSS = `
@keyframes cdz-admin-drawer-slide-up {
  from { transform: translateY(100%); }
  to   { transform: translateY(0); }
}
`;

// ─── Category Collapsible Sub-Component ───────────────────────────────────────

interface CategorySectionProps {
  category: ShopCategory;
  defaultOpen: boolean;
  onNavigate: (route: string) => void;
}

function CategorySection({ category, defaultOpen, onNavigate }: CategorySectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      style={styles.categorySection}
    >
      <Collapsible.Trigger style={styles.categoryTrigger} asChild>
        <button type="button" aria-expanded={open}>
          <span>{category.label}</span>
          <span style={styles.categoryChevron(open)}>▾</span>
        </button>
      </Collapsible.Trigger>

      <Collapsible.Content style={styles.categoryContent}>
        {category.items.map((item) => (
          <button
            key={item.id}
            style={styles.shopTabItem}
            onClick={() => onNavigate(item.route)}
            type="button"
          >
            <span style={styles.shopTabIcon}>{item.icon}</span>
            <span style={styles.shopTabLabel}>{item.label}</span>
            <span style={styles.shopTabArrow}>›</span>
          </button>
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface AdminDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function AdminDrawer({ open, onClose }: AdminDrawerProps) {
  const navigate = useNavigate();
  const { registerBackHandler, unregisterBackHandler } = useHardwareBack();

  // ── Hardware Back Integration ──────────────────────────────────────────
  useEffect(() => {
    if (open) {
      registerBackHandler(() => {
        onClose();
        return true;
      }, 'admin-drawer');
    } else {
      unregisterBackHandler('admin-drawer');
    }

    return () => {
      unregisterBackHandler('admin-drawer');
    };
  }, [open, onClose, registerBackHandler, unregisterBackHandler]);

  // ── Navigation Handler ─────────────────────────────────────────────────
  const handleNavigate = useCallback(
    (route: string) => {
      navigate(route);
      onClose();
    },
    [navigate, onClose]
  );

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        {/* Inject keyframe */}
        <style>{KEYFRAME_CSS}</style>

        {/* ── Backdrop ────────────────────────────────────────────────── */}
        <Dialog.Overlay style={styles.overlay} onClick={onClose} />

        {/* ── Content ─────────────────────────────────────────────────── */}
        <Dialog.Content
          data-cdz-surface="admin-drawer"
          style={styles.content}
          aria-describedby={undefined}
          onPointerDownOutside={onClose}
          onEscapeKeyDown={onClose}
        >
          {/* ── Drag Handle ────────────────────────────────────────── */}
          <div style={styles.dragHandle}>
            <div style={styles.dragHandleBar} />
          </div>

          {/* ── Header ─────────────────────────────────────────────── */}
          <div style={styles.header}>
            <span style={styles.title}>Administration</span>
            <button
              style={styles.closeBtn}
              onClick={onClose}
              aria-label="Fermer"
              type="button"
            >
              ✕
            </button>
          </div>

          {/* ── Scrollable Category List ────────────────────────────── */}
          <div style={styles.scrollArea}>
            {SHOP_CATEGORIES.map((cat, idx) => (
              <CategorySection
                key={cat.id}
                category={cat}
                defaultOpen={idx === 0} // First category open by default
                onNavigate={handleNavigate}
              />
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default AdminDrawer;
