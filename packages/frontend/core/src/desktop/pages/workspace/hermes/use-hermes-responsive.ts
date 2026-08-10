import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// ClickDz Hermes — tiny responsive-breakpoint hook shared by the Hermes page
// files (inline-styles idiom, no CSS modules). `useIsNarrow(480)` tracks the
// mobile breakpoint, `useIsNarrow(1024)` the tablet breakpoint. SSR-safe
// (guards `typeof window === 'undefined'`) and listens for viewport changes
// via matchMedia so layout values (column counts, flex-direction, widths)
// can branch live as the window is resized.
// ---------------------------------------------------------------------------
export function useIsNarrow(maxWidth: number): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    if (mql.addEventListener) {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Safari <14 fallback.
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return narrow;
}
