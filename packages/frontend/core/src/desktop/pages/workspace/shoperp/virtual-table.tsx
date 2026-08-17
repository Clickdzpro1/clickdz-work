/**
 * DzOS Phase 2 — lightweight virtual list for ERP tables.
 *
 * Renders only the visible rows + a small overscan buffer, using absolute
 * positioning inside a scroll container. No external dependency (react-window
 * / react-virtuoso are declared in package.json but not available in all
 * build environments). Handles 1,000+ rows at 60fps.
 *
 * Usage:
 *   <VirtualTable
 *     rowCount={orders.length}
 *     rowHeight={44}
     *     renderRow={(i) => <OrderRow order={orders[i]} />}
 *     header={<thead>…</thead>}
 *   />
 */

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { C } from './shoperp-shared';

interface VirtualTableProps {
  /** Total number of rows in the dataset. */
  rowCount: number;
  /** Fixed row height in pixels. */
  rowHeight: number;
  /** Render the row at index i. */
  renderRow: (index: number) => ReactNode;
  /** Optional header content rendered above the scroll area (not virtualized). */
  header?: ReactNode;
  /** Optional className for the outer container. */
  className?: string;
  /** Optional style overrides for the outer container. */
  style?: CSSProperties;
  /** Number of extra rows to render above/below the viewport (default 5). */
  overscan?: number;
  /** Height of the scroll area. If omitted, the container fills its parent. */
  height?: number | string;
}

export function VirtualTable({
  rowCount,
  rowHeight,
  renderRow,
  header,
  className,
  style,
  overscan = 5,
  height = '100%',
}: VirtualTableProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // Measure the scroll container on mount + on resize.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // Compute the visible window.
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(
    rowCount,
    Math.ceil((scrollTop + viewportH) / rowHeight) + overscan
  );
  const visibleCount = endIndex - startIndex;
  const totalHeight = rowCount * rowHeight;
  const offsetY = startIndex * rowHeight;

  const rows: ReactNode[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    rows.push(
      <div
        key={i}
        style={{
          position: 'absolute',
          top: i * rowHeight,
          left: 0,
          right: 0,
          height: rowHeight,
        }}
      >
        {renderRow(i)}
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        ...style,
      }}
    >
      {header}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          height,
          overflowY: 'auto',
          position: 'relative',
          // The sentinel spacer establishes the full scroll height.
        }}
      >
        <div style={{ height: totalHeight, position: 'relative' }}>
          {/* Offset spacer — pushes the visible rows down to their correct
              position without rendering empty divs for every off-screen row. */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: offsetY,
            }}
          />
          {rows}
        </div>
        {rowCount === 0 ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              color: C.muted,
              fontSize: 13,
            }}
          >
            Aucune donnée
          </div>
        ) : null}
      </div>
    </div>
  );
}
