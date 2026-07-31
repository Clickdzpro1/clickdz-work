/**
 * MobileLayout — Mobile Shell Wrapper for ClickDz Workspace
 *
 * Hermes Wiring Pattern:
 *   - Imports ensureClickDzResponsiveCss from the workspace utilities and calls
 *     it on mount via the <CdzResponsive> null-component.
 *   - Conditionally renders MobileTabBar + AdminDrawer only when isMobile is true.
 *   - On desktop (>= 600px), renders children directly with no mobile chrome.
 *
 * Usage (in a workspace page router):
 *   <MobileLayout>
 *     <Outlet />  {/* or workspace page content * /}
 *   </MobileLayout>
 *
 * Data markers (applied by child components):
 *   data-cdz-shell    → outermost layout wrapper
 *   data-cdz-rail     → MobileTabBar <nav>
 *   data-cdz-surface  → individual panels (BottomSheet, AdminDrawer, OrderCard)
 */

import React, { useCallback, useEffect, useState } from 'react';
import { MobileTabBar } from './MobileTabBar';
import { AdminDrawer } from './AdminDrawer';
import { useMobileDetect } from './useMobileDetect';
import { useHardwareBack } from './useHardwareBack';
import { MOBILE_COLORS } from './colors';

// ─── Hermes Responsive CSS Injection ──────────────────────────────────────────

/**
 * Minimal stub: in the real codebase this is
 *   import { ensureClickDzResponsiveCss } from '../utils/responsive';
 *
 * The function injects a <style> tag with media-query-driven CSS that handles
 * data-cdz-surface, data-cdz-shell, and data-cdz-rail markers at each breakpoint.
 */
function ensureClickDzResponsiveCss(): void {
  // Guard: only inject once per document
  if (typeof document === 'undefined') return;
  const id = 'cdz-responsive-css';
  if (document.getElementById(id)) return;

  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    /* ── CDZ Responsive Base ─────────────────────────────── */
    [data-cdz-shell] {
      min-height: 100dvh;
      background: ${MOBILE_COLORS.appBg};
    }

    /* Mobile: show mobile chrome */
    @media (max-width: 599px) {
      [data-cdz-shell] {
        padding-bottom: calc(64px + env(safe-area-inset-bottom, 0px));
      }
    }

    /* Desktop: hide mobile chrome */
    @media (min-width: 600px) {
      [data-cdz-rail="mobile-tab-bar"] {
        display: none !important;
      }
    }
  `;
  document.head.appendChild(style);
}

/**
 * CdzResponsive — Null Component
 *
 * Renders nothing. Calls ensureClickDzResponsiveCss() on mount as a side effect.
 * Placed once in the component tree so CSS injection happens exactly once.
 */
function CdzResponsive(): null {
  useEffect(() => {
    ensureClickDzResponsiveCss();
  }, []);
  return null;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  shell: {
    minHeight: '100dvh',
    backgroundColor: MOBILE_COLORS.appBg,
    color: MOBILE_COLORS.textPrimary,
    isolation: 'isolate' as const,
  } as React.CSSProperties,

  shellMobile: {
    // Reserve space for the fixed bottom tab bar
    paddingBottom: 'calc(64px + env(safe-area-inset-bottom, 0px))',
  } as React.CSSProperties,

  content: {
    position: 'relative' as const,
    zIndex: 1,
  } as React.CSSProperties,
};

// ─── Component ────────────────────────────────────────────────────────────────

interface MobileLayoutProps {
  children: React.ReactNode;
}

export function MobileLayout({ children }: MobileLayoutProps) {
  const { isMobile } = useMobileDetect();
  const [adminDrawerOpen, setAdminDrawerOpen] = useState(false);

  const { isAtRoot } = useHardwareBack();

  // ── Handlers ────────────────────────────────────────────────────────────

  const handlePlusTap = useCallback(() => {
    setAdminDrawerOpen(true);
  }, []);

  const handleAdminDrawerClose = useCallback(() => {
    setAdminDrawerOpen(false);
  }, []);

  return (
    <div
      style={{
        ...styles.shell,
        ...(isMobile ? styles.shellMobile : {}),
      }}
      data-cdz-shell="mobile-layout"
    >
      {/* ── Hermes CSS Injection (null component) ────────────────────── */}
      <CdzResponsive />

      {/* ── Page Content ─────────────────────────────────────────────── */}
      <div style={styles.content}>{children}</div>

      {/* ── Mobile Chrome (conditional) ───────────────────────────────── */}
      {isMobile && (
        <>
          <MobileTabBar onPlusTap={handlePlusTap} />
          <AdminDrawer open={adminDrawerOpen} onClose={handleAdminDrawerClose} />
        </>
      )}
    </div>
  );
}

export default MobileLayout;
