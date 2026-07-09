/**
 * CDZ Workers catalog — types + fetch hook.
 *
 * The CDZ AI platform exposes a public picker catalog at GET /v1/workers
 * (no auth) returning 502 specialist skills across 20 categories. This module
 * fetches it, types it, and exposes a React hook with loading/error state.
 *
 * Live shape (verified against api.clickdz.ai/v1/workers):
 *   { categories: [{ name, icon, color, tagline, recommendedModel, count,
 *      featured: [{id,name,best}], workers: [{id,name,description}] }] }
 *
 * Selecting a worker should:
 *   1. fetch its system prompt from GET /v1/workers/:id (auth-gated)
 *   2. route the chat to the category's recommendedModel (e.g. cdz-architect)
 *   3. inject the worker's system prompt as the chat's directive on send
 *
 * The hook does step 1 lazily (only when a worker is selected) to avoid
 * pre-fetching 502 prompts.
 */
import { useCallback, useEffect, useState } from 'react';

/** Base URL for the CDZ AI API. Falls back to the production host. */
const CDZ_AI_BASE_URL =
  (typeof process !== 'undefined' && process.env?.CDZ_AI_BASE_URL) ||
  'https://cdz-ai-production.up.railway.app/v1';

export interface CdzWorker {
  id: string;
  name: string;
  description: string;
}

export interface CdzWorkerFeatured {
  id: string;
  name: string;
  best: string;
}

export interface CdzWorkerCategory {
  name: string;
  icon: string;
  color: string;
  tagline: string;
  recommendedModel: string;
  count: number;
  featured: CdzWorkerFeatured[];
  workers: CdzWorker[];
}

export interface CdzWorkersCatalog {
  categories: CdzWorkerCategory[];
}

export interface UseCdzWorkersResult {
  catalog: CdzWorkersCatalog | null;
  loading: boolean;
  error: Error | null;
  /** Total worker count across all categories (for the picker header). */
  totalCount: number;
  /** Fetch a single worker's system prompt (lazy, auth-gated). */
  fetchWorkerPrompt: (workerId: string) => Promise<string | null>;
}

/**
 * Fetch the workers catalog once on mount. The endpoint is public (no auth),
 * so this works without a CDZ key.
 */
export function useCdzWorkersCatalog(): UseCdzWorkersResult {
  const [catalog, setCatalog] = useState<CdzWorkersCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${CDZ_AI_BASE_URL}/workers`)
      .then(res => {
        if (!res.ok) throw new Error(`CDZ workers catalog fetch failed: ${res.status}`);
        return res.json() as Promise<CdzWorkersCatalog>;
      })
      .then(data => {
        if (!cancelled) {
          setCatalog(data);
          setError(null);
        }
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const totalCount =
    catalog?.categories.reduce((sum, c) => sum + c.count, 0) ?? 0;

  const fetchWorkerPrompt = useCallback(
    async (workerId: string): Promise<string | null> => {
      return fetchCdzWorkerPrompt(workerId);
    },
    []
  );

  return { catalog, loading, error, totalCount, fetchWorkerPrompt };
}

/**
 * Fetch a single worker's system prompt (lazy, auth-gated). Exported standalone
 * so the dispatch hook can call it without mounting the picker.
 */
export async function fetchCdzWorkerPrompt(
  workerId: string
): Promise<string | null> {
  try {
    const key =
      (typeof process !== 'undefined' && process.env?.CDZ_AI_KEY) || '';
    const res = await fetch(
      `${CDZ_AI_BASE_URL}/workers/${encodeURIComponent(workerId)}`,
      {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { systemPrompt?: string };
    return data.systemPrompt ?? null;
  } catch {
    return null;
  }
}

/** Flatten the catalog into a single searchable worker list (id, name, category). */
export function flattenWorkers(
  catalog: CdzWorkersCatalog | null
): Array<{ id: string; name: string; description: string; category: string; recommendedModel: string }> {
  if (!catalog) return [];
  const out: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    recommendedModel: string;
  }> = [];
  for (const cat of catalog.categories) {
    for (const w of cat.workers) {
      out.push({
        id: w.id,
        name: w.name,
        description: w.description,
        category: cat.name,
        recommendedModel: cat.recommendedModel,
      });
    }
  }
  return out;
}
