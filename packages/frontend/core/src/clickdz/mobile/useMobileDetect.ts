/**
 * useMobileDetect — CDZ Responsive Detection Hook
 *
 * Hermes Wiring Pattern:
 *   This hook detects whether the current viewport is below 600px (the CDZ
 *   responsive breakpoint). Components use it to conditionally render mobile
 *   chrome (tab bar, drawer) vs. the full desktop sidebar.
 *
 * Returns:
 *   { isMobile: boolean, isTablet: boolean }
 *
 *   isMobile = viewport width < 600px
 *   isTablet = viewport width >= 600px AND < 900px
 */

import { useEffect, useState, useCallback } from 'react';

const MOBILE_BREAKPOINT = 600;
const TABLET_BREAKPOINT = 900;

export interface MobileDetectResult {
  isMobile: boolean;
  isTablet: boolean;
}

export function useMobileDetect(): MobileDetectResult {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < MOBILE_BREAKPOINT;
  });

  const [isTablet, setIsTablet] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const w = window.innerWidth;
    return w >= MOBILE_BREAKPOINT && w < TABLET_BREAKPOINT;
  });

  const handleChange = useCallback((e: MediaQueryListEvent | MediaQueryList) => {
    setIsMobile(e.matches);
  }, []);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

    // Set initial value in case SSR hydration mismatches
    setIsMobile(mql.matches);
    setIsTablet(
      window.innerWidth >= MOBILE_BREAKPOINT && window.innerWidth < TABLET_BREAKPOINT
    );

    // Modern API: addEventListener
    mql.addEventListener('change', handleChange);

    // Also listen for resize for the tablet range (matchMedia only covers mobile)
    const onResize = () => {
      setIsTablet(
        window.innerWidth >= MOBILE_BREAKPOINT && window.innerWidth < TABLET_BREAKPOINT
      );
    };
    window.addEventListener('resize', onResize);

    return () => {
      mql.removeEventListener('change', handleChange);
      window.removeEventListener('resize', onResize);
    };
  }, [handleChange]);

  return { isMobile, isTablet };
}
