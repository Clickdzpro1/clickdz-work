// ClickDz Work — PagedList<T> (R9, owner: Feuillet)
//
// A tiny, dependency-light, boot-safe paginated list. It renders one page of
// `items` at a time (grid OR single column) followed by a compact pager footer:
//
//     ‹ Précédent · 1 2 … 5 6 7 · Suivant ›
//
// Design constraints (per R9-CONTRACT §PagedList):
//   · Zero deps — React only, inline styles only (no .css.ts, no libraries).
//   · NO internal scrolling — the component's height fits the current page's
//     content; paging (not a scrollbar) is how the user moves through the list.
//   · Keyboard accessible — the pager is a real <nav> of <button>s; ← / →
//     arrow keys within the pager move page; disabled edges are aria-disabled.
//   · Mobile-friendly — every pager control is ≥40px tall (touch target).
//   · Page dots collapse to ≤7 slots with a leading/trailing ellipsis so the
//     footer never wraps unboundedly on long lists.
//   · Consumable by BOTH the shoperp surface and the agents surface, so colours
//     are neutral --affine-* theme vars with hard dark fallbacks (mirrors the
//     dependency-light discipline of src/clickdz/features.ts — this file has NO
//     import from either surface's palette; it carries its own). An optional
//     `palette` prop lets a caller override the three colours it actually uses.
//
// This module intentionally imports nothing but React types/hooks so it can be
// dropped into any React tree in the app (studio pages, agents pages) without a
// cross-module dependency. Consumers import it as:
//     import { PagedList } from '@affine/core/clickdz/paged-list';
//   (or by relative path, e.g. from shoperp/agents pages that live 4 dirs deep:
//     import { PagedList } from '../../../../clickdz/paged-list';)

import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// Neutral palette — the ONLY three colours this component paints with. Each is
// an --affine-* theme var with a hard dark fallback so the pager reads
// correctly before theme vars resolve, on either product surface. A caller can
// override any of them via the optional `palette` prop.
// ---------------------------------------------------------------------------
export interface PagedListPalette {
  /** Primary text / active-dot foreground. */
  text?: string;
  /** Muted text / inactive controls / ellipsis. */
  muted?: string;
  /** Hairline borders + control outlines. */
  border?: string;
  /** Accent (active page dot fill + focus ring). */
  accent?: string;
  /** Control background (buttons/dots idle fill). */
  panel?: string;
}

const DEFAULT_PALETTE: Required<PagedListPalette> = {
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  border: 'var(--affine-border-color, #2a2a2c)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  panel: 'var(--affine-background-secondary-color, #1c1c1e)',
};

// ---------------------------------------------------------------------------
// Props (EXACT contract shape).
// ---------------------------------------------------------------------------
export interface PagedListProps<T> {
  /** The full item list. The component paginates it; it never mutates it. */
  items: T[];
  /** Items per page. Default 12. Values < 1 are coerced to 1. */
  pageSize?: number;
  /** Renders one item. `i` is the item's ABSOLUTE index within `items`. */
  renderItem: (item: T, i: number) => ReactNode;
  /** Grid layout (auto-fill columns) vs a single stacked column. Default column. */
  grid?: boolean;
  /** Grid column min width (px) for the `minmax(minItemWidth, 1fr)` track. Default 220. */
  minItemWidth?: number;
  /** Localised pager labels. `page(n,total)` builds each dot's aria-label. */
  labels?: {
    prev?: string;
    next?: string;
    page?: (n: number, total: number) => string;
  };
  /** Shown (instead of the grid/column + pager) when `items` is empty. */
  emptyState?: ReactNode;
  /** 1-based initial page. Clamped into range. Default 1. */
  initialPage?: number;
  /** Fired whenever the current page changes (1-based). */
  onPageChange?: (n: number) => void;
  /** Colour overrides (else neutral --affine-* vars). */
  palette?: PagedListPalette;
  /** Gap (px) between items. Default 8. */
  gap?: number;
  /** Optional extra style merged onto the outer wrapper. */
  style?: CSSProperties;
  /** Optional className on the outer wrapper (for a caller's media queries). */
  className?: string;
}

// ---------------------------------------------------------------------------
// Pager slot maths — collapse an arbitrary page count into ≤7 visible slots.
//
// Returns an ordered list of "slots": each is either a page number or the
// sentinel 'gap' (rendered as a non-interactive ellipsis). Rules:
//   · total ≤ 7                → show every page (1..total), no gaps.
//   · current near the start   → 1 2 3 4 5 … total
//   · current near the end     → 1 … total-4 total-3 total-2 total-1 total
//   · current in the middle    → 1 … c-1 c c+1 … total
// Always exactly 7 slots when total > 7 (stable footer width, no reflow jitter).
// ---------------------------------------------------------------------------
type Slot = number | 'gap';

export function pagerSlots(current: number, total: number): Slot[] {
  if (total <= 0) return [];
  if (total <= 7) {
    const out: Slot[] = [];
    for (let p = 1; p <= total; p++) out.push(p);
    return out;
  }
  const c = Math.min(Math.max(current, 1), total);
  // Near the start: first five, gap, last.
  if (c <= 4) return [1, 2, 3, 4, 5, 'gap', total];
  // Near the end: first, gap, last five.
  if (c >= total - 3) {
    return [1, 'gap', total - 4, total - 3, total - 2, total - 1, total];
  }
  // Middle: first, gap, c-1, c, c+1, gap, last.
  return [1, 'gap', c - 1, c, c + 1, 'gap', total];
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------
export function PagedList<T>(props: PagedListProps<T>): ReactElement {
  const {
    items,
    pageSize = 12,
    renderItem,
    grid = false,
    minItemWidth = 220,
    labels,
    emptyState,
    initialPage = 1,
    onPageChange,
    palette,
    gap = 8,
    style,
    className,
  } = props;

  const pal: Required<PagedListPalette> = { ...DEFAULT_PALETTE, ...palette };
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const count = items.length;
  const totalPages = Math.max(1, Math.ceil(count / size));

  // 1-based current page. Seeded from initialPage (clamped) and re-clamped
  // whenever the item count shrinks below the current page's range.
  const clamp = (n: number) => Math.min(Math.max(Math.floor(n) || 1, 1), totalPages);
  const [page, setPage] = useState<number>(() => clamp(initialPage));

  // If the list shrinks (filtering) so the current page is now out of range,
  // pull back into range. Guarded so it only fires on an actual overflow.
  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
      onPageChange?.(totalPages);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPages]);

  const go = (next: number) => {
    const target = clamp(next);
    if (target === page) return;
    setPage(target);
    onPageChange?.(target);
  };

  // The slice of items for the current page (absolute indices preserved so
  // renderItem's `i` is the item's true position in the full list).
  const pageItems = useMemo(() => {
    const start = (page - 1) * size;
    return items.slice(start, start + size).map((item, k) => ({
      item,
      index: start + k,
    }));
  }, [items, page, size]);

  // Empty → the caller's emptyState (or nothing). No pager for an empty list.
  if (count === 0) {
    return <>{emptyState ?? null}</>;
  }

  const prevLabel = labels?.prev ?? '‹ Précédent';
  const nextLabel = labels?.next ?? 'Suivant ›';
  const pageAria = (n: number) =>
    labels?.page ? labels.page(n, totalPages) : `Page ${n} / ${totalPages}`;

  const listStyle: CSSProperties = grid
    ? {
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${minItemWidth}px, 1fr))`,
        gap,
        alignItems: 'stretch',
      }
    : {
        display: 'flex',
        flexDirection: 'column',
        gap,
      };

  const slots = pagerSlots(page, totalPages);
  const atStart = page <= 1;
  const atEnd = page >= totalPages;

  // Arrow-key paging when focus is inside the pager nav.
  const onNavKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(page - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(page + 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(1);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(totalPages);
    }
  };

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        // NO overflow/scroll here by design — height fits the page content.
        ...style,
      }}
    >
      <div style={listStyle}>
        {pageItems.map(({ item, index }) => (
          <PagedListRow key={index} render={() => renderItem(item, index)} />
        ))}
      </div>

      {/* Pager footer — only when there's more than one page. */}
      {totalPages > 1 ? (
        <nav
          aria-label={`${prevLabel} / ${nextLabel}`}
          onKeyDown={onNavKeyDown}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            paddingTop: 2,
          }}
        >
          <EdgeBtn
            pal={pal}
            label={prevLabel}
            disabled={atStart}
            onClick={() => go(page - 1)}
          />

          <ol
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              listStyle: 'none',
              margin: 0,
              padding: 0,
            }}
          >
            {slots.map((slot, idx) =>
              slot === 'gap' ? (
                <li
                  key={`gap-${idx}`}
                  aria-hidden="true"
                  style={{
                    minWidth: 24,
                    height: 40,
                    display: 'grid',
                    placeItems: 'center',
                    color: pal.muted,
                    fontSize: 13,
                    userSelect: 'none',
                  }}
                >
                  …
                </li>
              ) : (
                <li key={slot} style={{ display: 'flex' }}>
                  <PageDot
                    pal={pal}
                    n={slot}
                    active={slot === page}
                    ariaLabel={pageAria(slot)}
                    onClick={() => go(slot)}
                  />
                </li>
              )
            )}
          </ol>

          <EdgeBtn
            pal={pal}
            label={nextLabel}
            disabled={atEnd}
            onClick={() => go(page + 1)}
          />
        </nav>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item wrapper — a thin cell so each row/card carries a stable key without
// forcing the caller's renderItem output to be a single element.
// ---------------------------------------------------------------------------
const PagedListRow = ({ render }: { render: () => ReactNode }): ReactElement => {
  return <>{render()}</>;
};

// ---------------------------------------------------------------------------
// Prev / Next edge button — ≥40px touch target, disabled at the range edge
// (aria-disabled so screen readers announce it; pointer events off).
// ---------------------------------------------------------------------------
const EdgeBtn = ({
  pal,
  label,
  disabled,
  onClick,
}: {
  pal: Required<PagedListPalette>;
  label: string;
  disabled: boolean;
  onClick: () => void;
}): ReactElement => (
  <button
    type="button"
    aria-disabled={disabled || undefined}
    disabled={disabled}
    onClick={disabled ? undefined : onClick}
    style={{
      appearance: 'none',
      minHeight: 40,
      padding: '0 14px',
      borderRadius: 10,
      border: `1px solid ${pal.border}`,
      background: pal.panel,
      color: disabled ? pal.muted : pal.text,
      fontSize: 13,
      fontWeight: 600,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      whiteSpace: 'nowrap',
      transition: 'background 150ms ease, border-color 150ms ease, opacity 150ms ease',
    }}
  >
    {label}
  </button>
);

// ---------------------------------------------------------------------------
// A single page dot — a real button, 40x40 min (touch), accent-filled when the
// active page. aria-current="page" marks the active dot for assistive tech.
// ---------------------------------------------------------------------------
const PageDot = ({
  pal,
  n,
  active,
  ariaLabel,
  onClick,
}: {
  pal: Required<PagedListPalette>;
  n: number;
  active: boolean;
  ariaLabel: string;
  onClick: () => void;
}): ReactElement => (
  <button
    type="button"
    aria-label={ariaLabel}
    aria-current={active ? 'page' : undefined}
    onClick={onClick}
    style={{
      appearance: 'none',
      minWidth: 40,
      height: 40,
      padding: '0 6px',
      borderRadius: 10,
      display: 'grid',
      placeItems: 'center',
      border: `1px solid ${active ? pal.accent : pal.border}`,
      background: active
        ? `color-mix(in srgb, ${pal.accent} 16%, transparent)`
        : pal.panel,
      color: active ? pal.accent : pal.muted,
      fontSize: 13,
      fontWeight: 700,
      lineHeight: 1,
      cursor: 'pointer',
      transition: 'background 150ms ease, border-color 150ms ease, color 150ms ease',
    }}
  >
    {n}
  </button>
);

export default PagedList;
