// clickdz/skeleton.tsx
//
// ClickDz shared skeletons. Zero-config: they rely on the `[data-cdz-skeleton]`
// rule shipped by `clickdz/motion.ts` (shimmer + reduced-motion already
// handled), so they must render inside an element that carries
// `data-cdz-motion` and has `ensureCdzMotionCss()` injected. `currentColor`
// drives the tint, so they theme automatically (dark/light + cdz-theme presets)
// and mirror correctly in RTL.
//
// ADDITIVE: a NEW component. It replaces nothing; a studio opts in by rendering
// it in a loading branch instead of a blank pane.
import type { CSSProperties } from 'react';

export interface CdzSkeletonProps {
  /** Width — a number (px) or any CSS length. Defaults to full width. */
  w?: number | string;
  /** Height — a number (px) or any CSS length. Defaults to 14px. */
  h?: number | string;
  /** Extra inline style merged last (e.g. margin, borderRadius). */
  style?: CSSProperties;
}

/** A single shimmering placeholder bar. */
export function CdzSkeleton({ w = '100%', h = 14, style }: CdzSkeletonProps) {
  return (
    <div
      data-cdz-skeleton=""
      aria-hidden="true"
      style={{ width: w, height: h, ...style }}
    />
  );
}

export interface CdzSkeletonListProps {
  /** How many placeholder lines to render. */
  rows?: number;
  /** Gap between lines (px). */
  gap?: number;
}

/** A stack of skeleton lines for list / card placeholders. */
export function CdzSkeletonList({ rows = 4, gap = 10 }: CdzSkeletonListProps) {
  return (
    <div
      data-cdz-panel=""
      style={{ display: 'flex', flexDirection: 'column', gap }}
    >
      {Array.from({ length: rows }).map((_, i) => (
        <CdzSkeleton key={i} w={i % 3 === 2 ? '60%' : '100%'} h={16} />
      ))}
    </div>
  );
}
