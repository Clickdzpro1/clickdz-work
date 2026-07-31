/**
 * MobileTabBar — Fixed Bottom Tab Bar for ClickDz Mobile
 *
 * Hermes Wiring Pattern:
 *   data-cdz-rail="mobile-tab-bar" on the outermost <nav> element.
 *   Hidden on viewports >= 600px via inline media query in JS (useMobileDetect).
 *
 * Tabs (5 primary + 1 overflow):
 *   🏪 Boutique  → /workspace/boutique
 *   📋 Commandes → /workspace/commandes
 *   💰 Caisse    → /workspace/caisse
 *   🤖 Agents    → /workspace/agents
 *   📄 Docs      → /workspace/docs
 *   ➕ Plus      → opens AdminDrawer (bottom sheet)
 *
 * Design:
 *   - Fixed bottom, h-16 (64px), safe-area-aware padding-bottom
 *   - Active tab: gold accent (#E2B859) icon + label
 *   - Inactive tab: muted gray (#6B7280)
 *   - "Plus" uses @radix-ui/react-dialog Trigger (opens AdminDrawer)
 */

import React, { useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { MOBILE_COLORS } from './colors';
import { useMobileDetect } from './useMobileDetect';
import type { MobileTab, MobileTabDef } from './types';

// ─── Tab Definitions ──────────────────────────────────────────────────────────

const TABS: MobileTabDef[] = [
  { id: 'boutique',   label: 'Boutique',   icon: '🏪', route: '/workspace/boutique' },
  { id: 'commandes',  label: 'Commandes',  icon: '📋', route: '/workspace/commandes' },
  { id: 'caisse',     label: 'Caisse',     icon: '💰', route: '/workspace/caisse' },
  { id: 'agents',     label: 'Agents',     icon: '🤖', route: '/workspace/agents' },
  { id: 'docs',       label: 'Docs',       icon: '📄', route: '/workspace/docs' },
];

// ─── Styles ───────────────────────────────────────────────────────────────────

const NAV_HEIGHT = 64;

const styles = {
  nav: {
    position: 'fixed' as const,
    bottom: 0,
    left: 0,
    right: 0,
    height: NAV_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    backgroundColor: MOBILE_COLORS.tabBarBg,
    borderTop: `1px solid ${MOBILE_COLORS.tabBarBorder}`,
    zIndex: 1000,
    // Safe-area padding for notched devices
    paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    // Ensure bar is at least 64px even with no safe-area
    minHeight: NAV_HEIGHT,
  } as React.CSSProperties,

  tab: (isActive: boolean): React.CSSProperties => ({
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minWidth: 52,
    height: NAV_HEIGHT,
    padding: '6px 4px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    color: isActive ? MOBILE_COLORS.tabActive : MOBILE_COLORS.tabInactive,
    // Touch optimizations
    touchAction: 'manipulation',
    userSelect: 'none' as const,
    WebkitTapHighlightColor: 'transparent',
    // Active indicator dot
    position: 'relative' as const,
  }),

  activeDot: {
    position: 'absolute' as const,
    top: 0,
    left: '50%',
    transform: 'translateX(-50%)',
    width: 18,
    height: 3,
    borderRadius: '0 0 2px 2px',
    backgroundColor: MOBILE_COLORS.accent,
  } as React.CSSProperties,

  icon: {
    fontSize: 22,
    lineHeight: '26px',
  } as React.CSSProperties,

  label: {
    fontSize: 11,
    fontWeight: 500,
    lineHeight: '14px',
  } as React.CSSProperties,

  plusTab: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minWidth: 52,
    height: NAV_HEIGHT,
    padding: '6px 4px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    color: MOBILE_COLORS.tabInactive,
    touchAction: 'manipulation',
    userSelect: 'none' as const,
    WebkitTapHighlightColor: 'transparent',
    position: 'relative' as const,
  } as React.CSSProperties,

  plusIcon: {
    fontSize: 24,
    fontWeight: 700,
    lineHeight: '28px',
    color: MOBILE_COLORS.accent,
  } as React.CSSProperties,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determine the currently active tab from the current route.
 * Matches the tab whose route is a prefix of the current pathname.
 */
function useActiveTab(): MobileTab | null {
  const location = useLocation();

  return useMemo(() => {
    const path = location.pathname;
    for (const tab of TABS) {
      if (path.startsWith(tab.route)) return tab.id;
    }
    return null;
  }, [location.pathname]);
}

// ─── Component ────────────────────────────────────────────────────────────────

interface MobileTabBarProps {
  /** Callback when the "Plus" button is tapped to open the AdminDrawer. */
  onPlusTap: () => void;
}

export function MobileTabBar({ onPlusTap }: MobileTabBarProps) {
  const { isMobile } = useMobileDetect();
  const navigate = useNavigate();
  const activeTab = useActiveTab();

  const handleTabTap = useCallback(
    (route: string) => {
      navigate(route);
    },
    [navigate]
  );

  // Hide completely on non-mobile viewports
  if (!isMobile) return null;

  return (
    <nav
      style={styles.nav}
      data-cdz-rail="mobile-tab-bar"
      role="navigation"
      aria-label="Navigation principale"
    >
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            style={styles.tab(isActive)}
            onClick={() => handleTabTap(tab.route)}
            aria-label={tab.label}
            aria-current={isActive ? 'page' : undefined}
            type="button"
          >
            {isActive ? <span style={styles.activeDot} /> : null}
            <span style={styles.icon}>{tab.icon}</span>
            <span style={styles.label}>{tab.label}</span>
          </button>
        );
      })}

      {/* ── Plus / Overflow Button ───────────────────────────────────── */}
      <Dialog.Trigger asChild>
        <button
          style={styles.plusTab}
          onClick={onPlusTap}
          aria-label="Plus d'options"
          type="button"
        >
          <span style={styles.plusIcon}>＋</span>
          <span style={styles.label}>Plus</span>
        </button>
      </Dialog.Trigger>
    </nav>
  );
}

export default MobileTabBar;
