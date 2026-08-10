// ---------------------------------------------------------------------------
// Voice Studio — tiny responsive helper shared by the page + all tabs.
//
// Inline-styles-only surface (house convention — see voice-shared.ts), so
// layout branching happens in JS rather than CSS media queries. This hook
// tracks a single `(max-width: Npx)` breakpoint via matchMedia and re-renders
// on change/resize. SSR-safe: matchMedia is guarded so a server render (no
// `window`) simply reports `false` (desktop layout) until hydration.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';

/**
 * `true` once the viewport is at or narrower than `maxWidth` (e.g. 480 for
 * phones, 1024 for tablets/narrow desktop). Updates live on resize/rotation.
 */
export function useIsNarrow(maxWidth: number): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Safari < 14 fallback.
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return narrow;
}
