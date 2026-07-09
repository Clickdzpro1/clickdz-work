"use client";

/**
 * CDZ Workers picker — searchable overlay of the 502 specialist skills.
 *
 * Rendered as a modal-style overlay (fixed, centered) with:
 *  - a live search input that flattens matches across all categories
 *  - category filter chips (the 20 categories from the catalog)
 *  - a "Best of" featured set per category, then the full list
 *  - virtualization via windowed rendering (only visible rows mount) so 502
 *    items stay smooth
 *
 * On select: calls `onSelect(worker)` with the chosen worker; the host fetches
 * the worker's system prompt and injects it as the chat directive.
 *
 * Style: uses the scoped Tailwind layer + --cdz-* tokens (injected via
 * ensureCdzChatStyles). Wrapped in .cdz-chat-scope for isolation.
 */
import { cn } from './cn';
import { ensureCdzChatStyles } from './cdz-styles';
import {
  flattenWorkers,
  useCdzWorkersCatalog,
  type CdzWorkerCategory,
} from './cdz-workers-catalog';
import { Icons } from './icons';
import { useCdzI18n } from './use-cdz-i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface CdzSelectedWorker {
  id: string;
  name: string;
  category: string;
  recommendedModel: string;
}

export interface CdzWorkersPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (worker: CdzSelectedWorker) => void;
  /** Active worker id (to show the chip/highlight). */
  activeWorkerId?: string | null;
}

const ROW_HEIGHT = 64;
const VISIBLE_ROWS = 8;

export function CdzWorkersPicker({
  open,
  onClose,
  onSelect,
  activeWorkerId,
}: CdzWorkersPickerProps) {
  const { catalog, loading, error, totalCount } = useCdzWorkersCatalog();
  const t = useCdzI18n();
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [activeRowIndex, setActiveRowIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) ensureCdzChatStyles();
  }, [open]);

  // Reset filters when reopening.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveCategory(null);
      setScrollOffset(0);
    }
  }, [open]);

  // Escape to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const flat = useMemo(() => flattenWorkers(catalog), [catalog]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return flat.filter(w => {
      if (activeCategory && w.category !== activeCategory) return false;
      if (!q) return true;
      return (
        w.name.toLowerCase().includes(q) ||
        w.description.toLowerCase().includes(q) ||
        w.category.toLowerCase().includes(q)
      );
    });
  }, [flat, query, activeCategory]);

  const categories: CdzWorkerCategory[] = catalog?.categories ?? [];

  // Keep the keyboard-active row in bounds when the filter result changes.
  useEffect(() => {
    setActiveRowIndex(0);
  }, [query, activeCategory]);

  // Keyboard navigation for the workers listbox: ArrowUp/Down to move, Enter
  // to select, Escape to close (handled globally above). The search input
  // delegates these keys to the list so users can navigate without tabbing.
  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (filtered.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveRowIndex(i => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveRowIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const w = filtered[activeRowIndex];
        if (w) {
          onSelect({
            id: w.id,
            name: w.name,
            category: w.category,
            recommendedModel: w.recommendedModel,
          });
        }
      }
    },
    [activeRowIndex, filtered, onSelect]
  );

  // Windowed rows: only render the slice visible in the viewport.
  const startIdx = Math.floor(scrollOffset / ROW_HEIGHT);
  const visibleSlice = filtered.slice(
    startIdx,
    startIdx + VISIBLE_ROWS + 2 // +2 for partial rows
  );

  if (!open) return null;

  return (
    <div
      className={cn('cdz-chat-scope fixed inset-0 z-[200] flex items-center justify-center p-4')}
      role="dialog"
      aria-modal="true"
      aria-label={t.workers.title()}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-bg-0/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className={cn(
          'relative w-full max-w-2xl max-h-[80vh] flex flex-col bg-bg-100 border border-bg-300 rounded-2xl shadow-2xl overflow-hidden animate-fade-in'
        )}
      >
        {/* Header + search */}
        <div className="flex flex-col gap-3 p-4 border-b border-bg-300">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-text-100 font-serif">
                {t.workers.title()}
              </span>
              <span className="text-xs text-text-400">
                {t.workers.count(totalCount)}
              </span>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-text-400 hover:text-text-200 hover:bg-bg-200 transition-colors"
              aria-label={t.workers.close()}
            >
              <Icons.X className="w-4 h-4" />
            </button>
          </div>
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleListKeyDown}
              placeholder={t.workers.search()}
              className="w-full bg-bg-200 border border-bg-300 rounded-xl px-3 py-2 text-sm text-text-100 placeholder:text-text-400 outline-none focus:border-accent focus:ring-1 focus:ring-ring"
              autoFocus
              aria-label={t.workers.search()}
              aria-controls="cdz-workers-list"
              aria-activedescendant={
                filtered[activeRowIndex]
                  ? `cdz-worker-${filtered[activeRowIndex].id}`
                  : undefined
              }
            />
          </div>
          {/* Category chips */}
          {!loading && !error && categories.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setActiveCategory(null)}
                className={cn(
                  'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                  activeCategory === null
                    ? 'bg-accent text-bg-0'
                    : 'bg-bg-200 text-text-300 hover:text-text-200 hover:bg-bg-300'
                )}
              >
                {t.workers.all()}
              </button>
              {categories.map(cat => (
                <button
                  key={cat.name}
                  onClick={() =>
                    setActiveCategory(activeCategory === cat.name ? null : cat.name)
                  }
                  className={cn(
                    'px-2.5 py-1 rounded-full text-xs font-medium transition-colors inline-flex items-center gap-1',
                    activeCategory === cat.name
                      ? 'bg-accent text-bg-0'
                      : 'bg-bg-200 text-text-300 hover:text-text-200 hover:bg-bg-300'
                  )}
                >
                  <span aria-hidden="true">{cat.icon}</span>
                  {cat.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-hidden relative">
          {loading && (
            <div className="flex items-center justify-center h-32 text-text-400 text-sm gap-2">
              <Icons.Loader2 className="w-4 h-4 animate-spin" />
              {t.workers.loading()}
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-32 text-text-400 text-sm px-6 text-center">
              {t.workers.error()}
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="flex items-center justify-center h-32 text-text-400 text-sm">
              {t.workers.noResults(query)}
            </div>
          )}
          {!loading && !error && filtered.length > 0 && (
            <div
              ref={listRef}
              className="h-full overflow-y-auto prompt-scrollbar"
              onScroll={e => setScrollOffset((e.target as HTMLDivElement).scrollTop)}
              role="listbox"
              aria-label={t.workers.title()}
              id="cdz-workers-list"
            >
              {/* Spacer to keep scroll height correct for windowing */}
              <div style={{ height: filtered.length * ROW_HEIGHT }} className="relative">
                {visibleSlice.map((w, i) => {
                  const idx = startIdx + i;
                  const isActive = w.id === activeWorkerId;
                  const isKeyboardActive = idx === activeRowIndex;
                  return (
                    <button
                      key={`${w.id}-${idx}`}
                      id={`cdz-worker-${w.id}`}
                      role="option"
                      aria-selected={isActive}
                      onMouseEnter={() => setActiveRowIndex(idx)}
                      onClick={() =>
                        onSelect({
                          id: w.id,
                          name: w.name,
                          category: w.category,
                          recommendedModel: w.recommendedModel,
                        })
                      }
                      style={{
                        position: 'absolute',
                        top: idx * ROW_HEIGHT,
                        left: 0,
                        right: 0,
                        height: ROW_HEIGHT,
                      }}
                      className={cn(
                        'w-full text-left px-4 flex flex-col justify-center gap-0.5 transition-colors',
                        isActive
                          ? 'bg-accent/10 border-l-2 border-accent'
                          : isKeyboardActive
                            ? 'bg-bg-200 border-l-2 border-accent/50'
                            : 'hover:bg-bg-200 border-l-2 border-transparent'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-100 truncate">
                          {w.name}
                        </span>
                        <span className="text-[10px] text-text-400 uppercase tracking-wider shrink-0">
                          {w.category}
                        </span>
                        {isActive && (
                          <Icons.Check
                            className="w-3.5 h-3.5 ml-auto"
                            style={{ color: 'var(--cdz-accent)' }}
                          />
                        )}
                      </div>
                      <p className="text-xs text-text-300 line-clamp-1">
                        {w.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CdzWorkersPicker;
