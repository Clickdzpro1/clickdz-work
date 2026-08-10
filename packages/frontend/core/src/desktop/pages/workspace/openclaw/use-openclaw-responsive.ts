import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// OpenClaw — a tiny, local, SSR-safe media-query hook used ONLY by the
// openclaw/ pages to branch layout values at the tablet (1024px) and mobile
// (480px) breakpoints. This is layout-only plumbing: it doesn't touch the
// shared `ensureClickDzResponsiveCss()` stylesheet (which already handles a
// single ≤600px phone breakpoint for every CDZ surface) — it just gives the
// OpenClaw console a couple of EXTRA breakpoints to shrink/collapse its
// multi-pane IDE-style layout before that shared sheet's stacking kicks in.
//
// `useIsNarrow(1024)` → true at tablet-and-below (cap/collapse the sidebar).
// `useIsNarrow(480)`  → true at phone-and-below (stack/tab the panes).
// ---------------------------------------------------------------------------

function getMatches(maxWidth: number): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(`(max-width: ${maxWidth}px)`).matches;
}

export function useIsNarrow(maxWidth: number): boolean {
  const [isNarrow, setIsNarrow] = useState<boolean>(() => getMatches(maxWidth));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = () => setIsNarrow(mql.matches);
    // Sync immediately (maxWidth may have changed between renders).
    onChange();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Safari <14 fallback.
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [maxWidth]);

  return isNarrow;
}
