import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import {
  type CSSProperties,
  type PropsWithChildren,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// ClickDz Integrations (Composio) — DARK by default.
//
// The whole surface is gated server-side behind COMPOSIO_API_KEY. This page
// reflects what /api/v1/integrations/* reports:
//   • {enabled:false}  -> friendly setup state (ask the owner to set the key)
//   • {enabled:true}   -> the FULL Composio catalog (search + category filter +
//     cursor pagination / infinite scroll) with Connect buttons, per-toolkit
//     connected status, and a ▶ Run section.
//
// The catalog is NOT fetched all at once: we page the backend route
//   GET /api/v1/integrations/toolkits?search=&category=&cursor=
//   -> { enabled, toolkits:[{slug,name,logo?,categories?,connected?}],
//        nextCursor?, error? }
// accumulating pages as the user scrolls (cursor from the previous response).
// Search is debounced and resets the list; the category filter is applied
// server-side (passed through) with the visible chip set derived from results.
//
// Purely additive: with no key the only visible change in the whole app is the
// sidebar item + this informative page. No new .css.ts (inline styles only,
// per house rules — small new UI prefers inline styles), boot-safe emoji icons.
// ---------------------------------------------------------------------------

interface CdzToolkit {
  slug: string;
  name: string;
  logo?: string;
  categories?: string[];
  connected?: boolean;
}

interface ToolkitsResponse {
  enabled: boolean;
  toolkits: CdzToolkit[];
  nextCursor?: string | null;
  error?: string;
}

// One executed orchestrator step, mirrors the backend RunStep shape.
interface RunStep {
  tool: string;
  arguments?: Record<string, unknown>;
  ok: boolean;
  resultPreview: string;
}

interface RunResponse {
  ok: boolean;
  answer: string;
  steps: RunStep[];
  iterations: number;
}

// A structured connect failure. `auth_unconfigured` maps to the backend's
// {error:'toolkit_auth_unconfigured'} (needs Composio dashboard setup);
// `generic` carries the server's own error detail for every other failure.
interface ConnectError {
  toolkit: string;
  kind: 'auth_unconfigured' | 'generic';
  detail?: string;
}

// Run failure kinds that need a bespoke surface: 'planner' = AI planner
// unreachable (retryable). null = no error / generic (handled via runError text).
type RunErrorKind = 'planner' | null;

// Max toolkits the orchestrator accepts (mirrors backend RUN_MAX_TOOLKITS).
const RUN_MAX_TOOLKITS = 5;
const RUN_PROMPT_MAX = 4_000;
// Debounce for the catalog search box (ms). Keeps typing snappy without a
// request per keystroke.
const SEARCH_DEBOUNCE_MS = 350;
// Special sentinel for the "All" category chip.
const ALL_CATEGORIES = '__all__';

// Dark, app-consistent palette. Each value is an --affine-* theme var with a
// hard dark fallback so the page reads correctly even before theme vars load.
const C = {
  bg: 'var(--affine-background-primary-color, #141414)',
  panel: 'var(--affine-background-secondary-color, #1c1c1e)',
  border: 'var(--affine-border-color, #2a2a2c)',
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  accentSoft: 'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  warnBg: 'color-mix(in srgb, #e8a33d 12%, transparent)',
  warnBorder: 'color-mix(in srgb, #e8a33d 40%, transparent)',
  errBg: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 12%, transparent)',
  errBorder: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 40%, transparent)',
  okText: 'var(--affine-success-color, #4cae4c)',
  okBg: 'color-mix(in srgb, var(--affine-success-color, #4cae4c) 14%, transparent)',
  okBorder: 'color-mix(in srgb, var(--affine-success-color, #4cae4c) 40%, transparent)',
} as const;

// Initial page load vs. subsequent (search/filter reload) vs. hard error.
type LoadState = 'loading' | 'ready' | 'error';

const IntegrationsPage = () => {
  // ---- catalog state ----
  const [state, setState] = useState<LoadState>('loading');
  const [enabled, setEnabled] = useState(false);
  const [toolkits, setToolkits] = useState<CdzToolkit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ---- search + category filter ----
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState(''); // debounced, drives fetches
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  // Categories accumulate across the pages we've seen, so the chip row grows as
  // the user scrolls rather than requiring a separate catalog-wide call.
  const [knownCategories, setKnownCategories] = useState<string[]>([]);

  // ---- connect state ----
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<ConnectError | null>(null);

  // ---- ▶ Run orchestrator state ----
  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runErrorKind, setRunErrorKind] = useState<RunErrorKind>(null);
  const [result, setResult] = useState<RunResponse | null>(null);

  // A monotonically-increasing token so a slow in-flight request from a stale
  // query (old search/category) can't clobber the results of a newer one.
  const reqTokenRef = useRef(0);
  // Guards the infinite-scroll observer from firing overlapping fetches.
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Build the paged catalog URL for the current search/category + a cursor.
  const buildUrl = useCallback(
    (cursor: string | null) => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (category && category !== ALL_CATEGORIES) params.set('category', category);
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      return cdzApiUrl(
        `/api/v1/integrations/toolkits${qs ? `?${qs}` : ''}`
      );
    },
    [search, category]
  );

  // Merge freshly-seen categories into the known set (sorted, de-duped).
  const absorbCategories = useCallback((list: CdzToolkit[]) => {
    setKnownCategories(prev => {
      const set = new Set(prev);
      for (const tk of list) {
        for (const cat of tk.categories ?? []) {
          if (typeof cat === 'string' && cat.trim()) set.add(cat.trim());
        }
      }
      return Array.from(set).sort((a, b) => a.localeCompare(b));
    });
  }, []);

  // Fetch the FIRST page for the current search/category (resets the list).
  // `soft` keeps the existing grid visible (used on search/filter changes) so
  // the whole page doesn't flash a full-screen spinner mid-typing.
  const loadFirst = useCallback(
    async (soft: boolean) => {
      const token = ++reqTokenRef.current;
      if (!soft) setState('loading');
      setPageError(null);
      setNotice(null);
      try {
        const res = await fetch(buildUrl(null), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        if (token !== reqTokenRef.current) return; // superseded
        if (!res.ok) {
          setState('error');
          return;
        }
        const data = (await res.json()) as ToolkitsResponse;
        if (token !== reqTokenRef.current) return;
        setEnabled(!!data.enabled);
        const list = Array.isArray(data.toolkits) ? data.toolkits : [];
        setToolkits(list);
        absorbCategories(list);
        setNextCursor(
          typeof data.nextCursor === 'string' && data.nextCursor.length
            ? data.nextCursor
            : null
        );
        if (data.error === 'composio_unreachable') {
          setNotice("Couldn't reach Composio right now — try again in a moment.");
        }
        setState('ready');
      } catch {
        if (token !== reqTokenRef.current) return;
        setState('error');
      }
    },
    [buildUrl, absorbCategories]
  );

  // Fetch the NEXT page (append). No-op without a cursor or while already busy.
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setPageError(null);
    const token = reqTokenRef.current; // must still match when we return
    try {
      const res = await fetch(buildUrl(nextCursor), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      if (token !== reqTokenRef.current) return; // query changed under us
      if (!res.ok) {
        setPageError('Could not load more toolkits.');
        return;
      }
      const data = (await res.json()) as ToolkitsResponse;
      if (token !== reqTokenRef.current) return;
      const more = Array.isArray(data.toolkits) ? data.toolkits : [];
      // De-dupe by slug in case a cursor page overlaps.
      setToolkits(prev => {
        const seen = new Set(prev.map(t => t.slug));
        return [...prev, ...more.filter(t => !seen.has(t.slug))];
      });
      absorbCategories(more);
      setNextCursor(
        typeof data.nextCursor === 'string' && data.nextCursor.length
          ? data.nextCursor
          : null
      );
    } catch {
      if (token === reqTokenRef.current) {
        setPageError('Network error while loading more toolkits.');
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [nextCursor, buildUrl, absorbCategories]);

  // Initial load.
  useEffect(() => {
    void loadFirst(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce the search box into the `search` term that drives fetches.
  useEffect(() => {
    const h = window.setTimeout(() => {
      setSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [searchInput]);

  // Re-fetch the first page whenever the (debounced) search or category change,
  // but not on the very first render (the initial effect above handles that).
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    void loadFirst(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, category]);

  // Infinite scroll: observe a sentinel at the end of the grid.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !nextCursor || state !== 'ready' || !enabled) return;
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) void loadMore();
      },
      { rootMargin: '400px 0px' }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [nextCursor, state, enabled, loadMore]);

  // Re-fetch the current first page (same search/category) to pull fresh
  // `connected` flags after a connect attempt, WITHOUT resetting scroll for the
  // user: we replace only the slugs we already show, keeping later pages.
  const refreshStatus = useCallback(async () => {
    const token = reqTokenRef.current;
    try {
      const res = await fetch(buildUrl(null), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      if (token !== reqTokenRef.current || !res.ok) return;
      const data = (await res.json()) as ToolkitsResponse;
      if (token !== reqTokenRef.current) return;
      const fresh = new Map(
        (Array.isArray(data.toolkits) ? data.toolkits : []).map(t => [t.slug, t])
      );
      setToolkits(prev =>
        prev.map(t => {
          const f = fresh.get(t.slug);
          return f ? { ...t, connected: f.connected } : t;
        })
      );
    } catch {
      /* status refresh is best-effort; ignore */
    }
  }, [buildUrl]);

  const connect = useCallback(
    async (slug: string) => {
      setConnecting(slug);
      setNotice(null);
      setConnectError(null);
      try {
        const res = await fetch(cdzApiUrl('/api/v1/integrations/connect'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ toolkit: slug }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          redirectUrl?: string;
          error?: string;
          detail?: string;
        };
        if (res.ok && data.redirectUrl) {
          window.open(data.redirectUrl, '_blank', 'noopener,noreferrer');
          // The hosted OAuth flow completes in the other tab; refresh the
          // current view so the server's `connected` flag catches up here
          // without resetting the user's scroll position.
          void refreshStatus();
          return;
        }
        if (data.error === 'not_configured') {
          setNotice('Integrations are not configured yet — ask the owner to set COMPOSIO_API_KEY.');
        } else if (data.error === 'toolkit_auth_unconfigured') {
          // Distinct, actionable surface (Composio dashboard) with retry.
          setConnectError({ toolkit: slug, kind: 'auth_unconfigured' });
        } else {
          // Surface the server's own error message rather than swallowing it.
          setConnectError({ toolkit: slug, kind: 'generic', detail: data.detail });
        }
      } catch {
        setConnectError({ toolkit: slug, kind: 'generic' });
      } finally {
        setConnecting(null);
      }
    },
    [refreshStatus]
  );

  // Toggle a toolkit chip on/off, enforcing the max-5 selection cap.
  const toggleToolkit = useCallback((slug: string) => {
    setSelected(prev => {
      if (prev.includes(slug)) return prev.filter(s => s !== slug);
      if (prev.length >= RUN_MAX_TOOLKITS) return prev;
      return [...prev, slug];
    });
  }, []);

  const run = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setRunError(null);
    setRunErrorKind(null);
    setResult(null);
    try {
      const res = await fetch(cdzApiUrl('/api/v1/integrations/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ prompt: trimmed, toolkits: selected }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<RunResponse> & {
        error?: string;
      };
      if (res.status === 409 || data.error === 'not_configured') {
        setRunError('Integrations are not configured yet — ask the owner to set COMPOSIO_API_KEY.');
        return;
      }
      if (res.status === 502 || data.error === 'planner_unavailable') {
        setRunErrorKind('planner');
        setRunError('AI planner unreachable — try again shortly.');
        return;
      }
      if (!res.ok || !data.ok) {
        setRunError('The run could not be completed. Please try again.');
        return;
      }
      setResult({
        ok: true,
        answer: typeof data.answer === 'string' ? data.answer : '',
        steps: Array.isArray(data.steps) ? data.steps : [],
        iterations: typeof data.iterations === 'number' ? data.iterations : 0,
      });
    } catch {
      setRunError('Network error while running. Check your connection and try again.');
    } finally {
      setRunning(false);
    }
  }, [prompt, selected, running]);

  const canRun = enabled && state === 'ready' && prompt.trim().length > 0 && !running;

  // Chips for the ▶ Run picker: prefer the currently-selected slugs even if
  // they've scrolled out of / been filtered from the visible list, so a
  // selection made under one search survives another.
  const selectedNames = useMemo(() => {
    const bySlug = new Map(toolkits.map(t => [t.slug, t.name] as const));
    return (slug: string) => bySlug.get(slug) ?? slug;
  }, [toolkits]);

  const categoryChips = useMemo(
    () => [ALL_CATEGORIES, ...knownCategories],
    [knownCategories]
  );

  return (
    <>
      <ViewTitle title="Integrations" />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: '100%',
            padding: '0 16px',
            fontSize: 14,
            fontWeight: 600,
            color: C.text,
          }}
        >
          <span style={{ fontSize: 16 }}>🔌</span>
          Integrations
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '15px',
              padding: '0 6px',
              borderRadius: 5,
              letterSpacing: '0.05em',
              color: C.muted,
              backgroundColor:
                'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)',
            }}
          >
            béta
          </span>
        </div>
      </ViewHeader>
      <ViewBody>
        <div
          style={{
            height: '100%',
            width: '100%',
            overflow: 'auto',
            background: C.bg,
            color: C.text,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <div
            style={{
              maxWidth: 960,
              margin: '0 auto',
              padding: '28px 24px 48px',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: 24,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: C.text,
                }}
              >
                <span>🔌</span> Integrations
              </h1>
              <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
                Connect ClickDz Work to the tools you already use. Browse the
                full Composio catalog below.
              </p>
            </header>

            {/* Status banner ------------------------------------------------ */}
            {state === 'loading' ? (
              <Banner tone="info">Loading integrations…</Banner>
            ) : state === 'error' ? (
              <Banner tone="error">
                Couldn&apos;t load integrations.{' '}
                <button style={linkBtnStyle} onClick={() => void loadFirst(false)}>
                  Retry
                </button>
              </Banner>
            ) : !enabled ? (
              <Banner tone="warn">
                <strong>Integrations aren&apos;t set up yet.</strong>
                <br />
                Ask the owner to set <code style={codeStyle}>
                  COMPOSIO_API_KEY
                </code>{' '}
                on the server, then reload this page. Until then this tab stays
                read-only and nothing is connected.
              </Banner>
            ) : (
              <Banner tone="ok">
                Integrations are live. Search the catalog, pick a tool, and press{' '}
                <strong>Connect</strong> to link your account.
              </Banner>
            )}

            {notice ? <Banner tone="info">{notice}</Banner> : null}

            {/* Connect error surfaces (distinct + retryable) ---------------- */}
            {connectError ? (
              <Banner tone={connectError.kind === 'auth_unconfigured' ? 'warn' : 'error'}>
                {(() => {
                  const name = selectedNames(connectError.toolkit);
                  return connectError.kind === 'auth_unconfigured' ? (
                    <>
                      <strong>{name}</strong> needs auth setup in the Composio
                      dashboard before it can be connected. Ask the owner to add
                      an auth config for this toolkit, then retry.
                    </>
                  ) : (
                    <>
                      Could not start the connection for <strong>{name}</strong>
                      {connectError.detail ? `: ${connectError.detail}` : '.'}
                    </>
                  );
                })()}
                <div style={{ marginTop: 8 }}>
                  <button
                    style={linkBtnStyle}
                    disabled={connecting === connectError.toolkit}
                    onClick={() => void connect(connectError.toolkit)}
                  >
                    {connecting === connectError.toolkit ? 'Retrying…' : 'Retry'}
                  </button>
                </div>
              </Banner>
            ) : null}

            {/* Catalog controls: search + category filter ------------------- */}
            {state === 'ready' && enabled ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ position: 'relative' }}>
                  <span
                    aria-hidden
                    style={{
                      position: 'absolute',
                      left: 12,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      fontSize: 14,
                      color: C.muted,
                      pointerEvents: 'none',
                    }}
                  >
                    🔍
                  </span>
                  <input
                    type="text"
                    value={searchInput}
                    onChange={e => setSearchInput(e.target.value)}
                    placeholder="Search integrations (e.g. Slack, GitHub, Notion)…"
                    aria-label="Search integrations"
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '10px 34px 10px 34px',
                      borderRadius: 10,
                      fontSize: 13,
                      fontFamily: 'inherit',
                      color: C.text,
                      background: C.panel,
                      border: `1px solid ${C.border}`,
                      outline: 'none',
                    }}
                  />
                  {searchInput ? (
                    <button
                      type="button"
                      aria-label="Clear search"
                      onClick={() => setSearchInput('')}
                      style={{
                        position: 'absolute',
                        right: 8,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        appearance: 'none',
                        border: 'none',
                        background: 'transparent',
                        color: C.muted,
                        cursor: 'pointer',
                        fontSize: 14,
                        lineHeight: 1,
                        padding: 4,
                      }}
                    >
                      ✕
                    </button>
                  ) : null}
                </div>

                {/* Category filter chips (derived from results as we page) */}
                {categoryChips.length > 1 ? (
                  <div
                    style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
                    role="group"
                    aria-label="Filter by category"
                  >
                    {categoryChips.map(cat => {
                      const on = category === cat;
                      const label = cat === ALL_CATEGORIES ? 'All' : cat;
                      return (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => setCategory(cat)}
                          style={{
                            appearance: 'none',
                            cursor: 'pointer',
                            padding: '5px 12px',
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: 600,
                            textTransform: 'capitalize',
                            color: on ? '#fff' : C.text,
                            background: on ? C.accent : 'transparent',
                            border: `1px solid ${on ? C.accent : C.border}`,
                            transition: 'background 150ms ease, border-color 150ms ease',
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Toolkit grid ------------------------------------------------- */}
            {state === 'ready' && enabled ? (
              toolkits.length > 0 ? (
                <>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns:
                        'repeat(auto-fill, minmax(180px, 1fr))',
                      gap: 12,
                    }}
                  >
                    {toolkits.map(tk => {
                      const isConnecting = connecting === tk.slug;
                      const isConnected = !!tk.connected;
                      return (
                        <div
                          key={tk.slug}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                            padding: 16,
                            borderRadius: 12,
                            background: C.panel,
                            border: `1px solid ${
                              isConnected ? C.okBorder : C.border
                            }`,
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                            }}
                          >
                            <div
                              style={{
                                width: 36,
                                height: 36,
                                borderRadius: 8,
                                flexShrink: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: C.accentSoft,
                                overflow: 'hidden',
                                fontSize: 16,
                              }}
                            >
                              {tk.logo ? (
                                <img
                                  src={tk.logo}
                                  alt=""
                                  width={36}
                                  height={36}
                                  loading="lazy"
                                  style={{ objectFit: 'contain' }}
                                />
                              ) : (
                                <span>🧩</span>
                              )}
                            </div>
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 2,
                                minWidth: 0,
                                flex: 1,
                              }}
                            >
                              <span
                                style={{
                                  fontWeight: 600,
                                  fontSize: 13,
                                  color: C.text,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                                title={tk.name}
                              >
                                {tk.name}
                              </span>
                              {tk.categories && tk.categories.length ? (
                                <span
                                  style={{
                                    fontSize: 11,
                                    color: C.muted,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    textTransform: 'capitalize',
                                  }}
                                  title={tk.categories.join(', ')}
                                >
                                  {tk.categories.slice(0, 2).join(' · ')}
                                </span>
                              ) : null}
                            </div>
                          </div>

                          <button
                            disabled={isConnecting || isConnected}
                            onClick={() => void connect(tk.slug)}
                            style={{
                              appearance: 'none',
                              border: isConnected
                                ? `1px solid ${C.okBorder}`
                                : 'none',
                              borderRadius: 8,
                              padding: '8px 12px',
                              fontSize: 13,
                              fontWeight: 600,
                              cursor:
                                isConnecting || isConnected ? 'default' : 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: 6,
                              color: isConnected ? C.okText : '#fff',
                              background: isConnected ? C.okBg : C.accent,
                              opacity: isConnecting ? 0.6 : 1,
                              transition: 'opacity 150ms ease',
                            }}
                          >
                            {isConnecting ? (
                              <>
                                <Spinner /> Connecting…
                              </>
                            ) : isConnected ? (
                              <>✓ Connected</>
                            ) : (
                              <>Connect</>
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  {/* Pagination: sentinel (infinite scroll) + explicit fallback */}
                  <div
                    ref={sentinelRef}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 8,
                      minHeight: 8,
                      paddingTop: 4,
                    }}
                  >
                    {pageError ? (
                      <div style={{ fontSize: 12, color: 'var(--affine-error-color, #eb4b4b)' }}>
                        {pageError}{' '}
                        <button style={linkBtnStyle} onClick={() => void loadMore()}>
                          Retry
                        </button>
                      </div>
                    ) : loadingMore ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12,
                          color: C.muted,
                        }}
                      >
                        <Spinner dark /> Loading more…
                      </span>
                    ) : nextCursor ? (
                      <button
                        type="button"
                        onClick={() => void loadMore()}
                        style={{
                          appearance: 'none',
                          borderRadius: 8,
                          padding: '8px 16px',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          color: C.text,
                          background: 'transparent',
                          border: `1px solid ${C.border}`,
                        }}
                      >
                        Load more
                      </button>
                    ) : (
                      <span style={{ fontSize: 11, color: C.muted }}>
                        {toolkits.length} integration
                        {toolkits.length === 1 ? '' : 's'} shown
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <Banner tone="info">
                  {search || category !== ALL_CATEGORIES
                    ? 'No integrations match your search or filter. Try a different term or category.'
                    : "No toolkits are available right now. Once the owner finishes Composio setup they'll appear here."}
                </Banner>
              )
            ) : null}

            {/* ▶ Run orchestrator ------------------------------------------- */}
            <section
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                padding: 18,
                borderRadius: 12,
                background: C.panel,
                border: `1px solid ${C.border}`,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <h2
                  style={{
                    margin: 0,
                    fontSize: 15,
                    fontWeight: 700,
                    color: C.text,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <span>▶</span> Run
                </h2>
                <p style={{ margin: 0, color: C.muted, fontSize: 12 }}>
                  Describe what you want to do; the agent picks and runs the
                  right tools from the toolkits you select below.
                </p>
              </div>

              {!enabled ? (
                <Banner tone="warn">
                  Running is disabled until an owner sets{' '}
                  <code style={codeStyle}>COMPOSIO_API_KEY</code> on the server.
                </Banner>
              ) : null}

              {/* Prompt */}
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value.slice(0, RUN_PROMPT_MAX))}
                disabled={!enabled || running}
                placeholder="e.g. Star the composiohq/composio repo on GitHub"
                rows={3}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  padding: '10px 12px',
                  borderRadius: 8,
                  fontSize: 13,
                  fontFamily: 'inherit',
                  lineHeight: 1.5,
                  color: C.text,
                  background: C.bg,
                  border: `1px solid ${C.border}`,
                  opacity: !enabled ? 0.55 : 1,
                }}
              />

              {/* Toolkit chips (click to toggle, max 5). Selected chips are
                  always shown first so a pick survives search/filter changes;
                  the rest come from the currently-loaded catalog page(s). */}
              {selected.length > 0 || toolkits.length > 0 ? (
                <div
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
                  role="group"
                  aria-label="Toolkits to allow"
                >
                  {(() => {
                    const seen = new Set<string>();
                    const ordered: string[] = [];
                    for (const s of selected) {
                      if (!seen.has(s)) {
                        seen.add(s);
                        ordered.push(s);
                      }
                    }
                    for (const tk of toolkits) {
                      if (!seen.has(tk.slug)) {
                        seen.add(tk.slug);
                        ordered.push(tk.slug);
                      }
                    }
                    return ordered.map(slug => {
                      const on = selected.includes(slug);
                      const capped = !on && selected.length >= RUN_MAX_TOOLKITS;
                      const name = selectedNames(slug);
                      return (
                        <button
                          key={slug}
                          type="button"
                          disabled={!enabled || running || capped}
                          onClick={() => toggleToolkit(slug)}
                          title={capped ? `Up to ${RUN_MAX_TOOLKITS} toolkits` : name}
                          style={{
                            appearance: 'none',
                            cursor:
                              !enabled || running || capped ? 'default' : 'pointer',
                            padding: '5px 12px',
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: 600,
                            color: on ? '#fff' : C.text,
                            background: on ? C.accent : 'transparent',
                            border: `1px solid ${on ? C.accent : C.border}`,
                            opacity: capped ? 0.4 : 1,
                          }}
                        >
                          {name}
                        </button>
                      );
                    });
                  })()}
                </div>
              ) : null}

              {/* Run button + selection hint */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  type="button"
                  disabled={!canRun}
                  onClick={() => void run()}
                  style={{
                    appearance: 'none',
                    border: 'none',
                    borderRadius: 8,
                    padding: '9px 18px',
                    fontSize: 13,
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: canRun ? 'pointer' : 'default',
                    color: '#fff',
                    background: C.accent,
                    opacity: canRun ? 1 : 0.5,
                  }}
                >
                  {running ? (
                    <>
                      <Spinner /> Running…
                    </>
                  ) : (
                    <>▶ Run</>
                  )}
                </button>
                <span style={{ fontSize: 12, color: C.muted }}>
                  {selected.length > 0
                    ? `${selected.length}/${RUN_MAX_TOOLKITS} toolkit${selected.length > 1 ? 's' : ''} selected`
                    : 'No toolkit filter — the agent may have nothing to run.'}
                </span>
              </div>

              {/* Run error states (409 / 502 / network). The planner-unreachable
                  case gets a distinct, retryable surface. */}
              {runError ? (
                <Banner tone={runErrorKind === 'planner' ? 'warn' : 'error'}>
                  {runError}
                  {runErrorKind === 'planner' ? (
                    <div style={{ marginTop: 8 }}>
                      <button
                        style={linkBtnStyle}
                        disabled={running}
                        onClick={() => void run()}
                      >
                        {running ? 'Retrying…' : 'Retry'}
                      </button>
                    </div>
                  ) : null}
                </Banner>
              ) : null}

              {/* Results panel */}
              {result ? (
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
                >
                  {/* Final answer — prominent */}
                  <div
                    style={{
                      padding: '14px 16px',
                      borderRadius: 10,
                      background: C.accentSoft,
                      border: `1px solid ${C.border}`,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: C.muted,
                        marginBottom: 6,
                      }}
                    >
                      Answer
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        color: C.text,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {result.answer || '(no answer returned)'}
                    </div>
                  </div>

                  {/* Steps */}
                  {result.steps.length > 0 ? (
                    <div
                      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                    >
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          color: C.muted,
                        }}
                      >
                        Steps ({result.steps.length}) · {result.iterations}{' '}
                        iteration{result.iterations === 1 ? '' : 's'}
                      </div>
                      {result.steps.map((step, i) => (
                        <StepRow key={`${step.tool}-${i}`} step={step} index={i} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </ViewBody>
    </>
  );
};

// ---- small inline-styled helpers (no exports from a .css.ts) --------------

const codeStyle: CSSProperties = {
  fontFamily: 'var(--affine-font-code-family, monospace)',
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 4,
  background: 'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  color: 'var(--affine-text-primary-color, #ececec)',
};

const linkBtnStyle: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer',
  color: 'var(--affine-primary-color, #1e96eb)',
  textDecoration: 'underline',
};

// A single collapsible orchestrator step (tool name + ok/fail badge + <pre>).
const StepRow = ({ step, index }: { step: RunStep; index: number }) => {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        borderRadius: 8,
        background: C.bg,
        border: `1px solid ${C.border}`,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          appearance: 'none',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: C.text,
          textAlign: 'left',
          font: 'inherit',
        }}
      >
        <span style={{ fontSize: 11, color: C.muted, width: 18 }}>
          {index + 1}.
        </span>
        <span
          style={{
            fontFamily: 'var(--affine-font-code-family, monospace)',
            fontSize: 12,
            fontWeight: 600,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {step.tool}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            padding: '1px 8px',
            borderRadius: 999,
            color: step.ok ? C.okText : 'var(--affine-error-color, #eb4b4b)',
            background: step.ok ? C.accentSoft : C.errBg,
            border: `1px solid ${step.ok ? C.border : C.errBorder}`,
          }}
        >
          {step.ok ? 'ok' : 'failed'}
        </span>
        <span style={{ fontSize: 11, color: C.muted }}>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <pre
          style={{
            margin: 0,
            padding: '10px 12px',
            borderTop: `1px solid ${C.border}`,
            background: C.panel,
            color: C.muted,
            fontSize: 11.5,
            fontFamily: 'var(--affine-font-code-family, monospace)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 260,
            overflow: 'auto',
          }}
        >
          {step.resultPreview || '(empty result)'}
        </pre>
      ) : null}
    </div>
  );
};

// Tiny CSS spinner (keyframes injected inline once via a <style> tag). `dark`
// renders a muted-on-transparent variant for use on the page background.
const Spinner = ({ dark = false }: { dark?: boolean }) => (
  <span
    style={{
      display: 'inline-block',
      width: 12,
      height: 12,
      borderRadius: '50%',
      border: dark
        ? '2px solid rgba(154,160,166,0.35)'
        : '2px solid rgba(255,255,255,0.4)',
      borderTopColor: dark ? 'var(--affine-text-secondary-color, #9aa0a6)' : '#fff',
      animation: 'cdz-integrations-spin 0.7s linear infinite',
    }}
  >
    <style>
      {'@keyframes cdz-integrations-spin{to{transform:rotate(360deg)}}'}
    </style>
  </span>
);

const Banner = ({
  tone,
  children,
}: PropsWithChildren<{ tone: 'info' | 'warn' | 'error' | 'ok' }>) => {
  const map = {
    info: { bg: C.accentSoft, border: C.border, color: C.text },
    ok: { bg: C.accentSoft, border: C.border, color: C.text },
    warn: { bg: C.warnBg, border: C.warnBorder, color: C.text },
    error: { bg: C.errBg, border: C.errBorder, color: C.text },
  }[tone];
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 10,
        fontSize: 13,
        background: map.bg,
        border: `1px solid ${map.border}`,
        color: map.color,
      }}
    >
      {children}
    </div>
  );
};

export const Component = () => {
  return <IntegrationsPage />;
};
