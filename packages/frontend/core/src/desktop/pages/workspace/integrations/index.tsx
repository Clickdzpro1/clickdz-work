import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import {
  type Flow,
  type FlowRun,
  useFlows,
} from '@affine/core/modules/integrations/use-flows';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { AppAccessGate } from '@affine/core/modules/studio/app-access-gate';
import {
  type CSSProperties,
  type PropsWithChildren,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { ensureClickDzResponsiveCss } from '@affine/core/clickdz/responsive';

const CdzResponsive = () => {
  ensureClickDzResponsiveCss();
  return null;
};

// The zero-dep flow canvas (CANVAS-FE) — pure/presentational: it takes a Flow +
// the toolkits `catalog` + an onChange(flow) and renders the draggable node
// graph / palette / inspector. FLOW-FE owns the fetching (use-flows) and mounts
// it here.
import { FlowCanvas } from './flow-canvas';
// The Runs tab view (this package) — runs list + detail timeline + DLQ replay.
import { FlowRunsView } from './flow-runs';

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

// A `type` alias (not an interface) on purpose: type aliases get an implicit
// index signature, which lets CdzToolkit[] flow into FlowCanvas's permissive
// `Toolkit[]` catalog prop (`[key: string]: unknown` — see flow-nodes.tsx).
type CdzToolkit = {
  slug: string;
  name: string;
  logo?: string;
  categories?: string[];
  connected?: boolean;
};

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

// In-page tabs. Catalog is the original WS14 surface (unchanged); Flows is the
// zero-dep builder; Runs is the observability view.
type TabKey = 'catalog' | 'flows' | 'runs';

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

  // ---- in-page tabs (Catalog | Flows | Runs) ----
  const [tab, setTab] = useState<TabKey>('catalog');

  // ---- Flows tab state (all fetching lives in the useFlows hook) ----
  const flowsApi = useFlows();
  const [flowsLoadedOnce, setFlowsLoadedOnce] = useState(false);
  // The flow currently open in the canvas (a local, editable draft). null = the
  // flow list is shown instead.
  const [editingFlow, setEditingFlow] = useState<Flow | null>(null);
  // True while the open draft has unsaved edits (drives the Save button state).
  const [flowDirty, setFlowDirty] = useState(false);
  const [savingFlow, setSavingFlow] = useState(false);
  const [runningFlow, setRunningFlow] = useState(false);
  const [flowNotice, setFlowNotice] = useState<string | null>(null);
  // After a successful Run we switch to the Runs tab and focus this run id.
  const [focusRunId, setFocusRunId] = useState<string | null>(null);

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
          setNotice("Impossible de contacter Composio pour le moment — réessayez dans un instant.");
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
        setPageError('Impossible de charger plus de kits d’outils.');
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
        setPageError('Erreur réseau lors du chargement de plus de kits.');
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

  // Infinite scroll: observe a sentinel at the end of the grid. `tab` is a dep
  // so the observer re-attaches to the freshly-mounted sentinel when the user
  // returns to the Catalog tab (the node is recreated on tab switch).
  useEffect(() => {
    if (tab !== 'catalog') return;
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
  }, [nextCursor, state, enabled, loadMore, tab]);

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
          setNotice('Les intégrations ne sont pas encore configurées — demandez au propriétaire de définir COMPOSIO_API_KEY.');
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
        setRunError('Les intégrations ne sont pas encore configurées — demandez au propriétaire de définir COMPOSIO_API_KEY.');
        return;
      }
      if (res.status === 502 || data.error === 'planner_unavailable') {
        setRunErrorKind('planner');
        setRunError('Planificateur IA inaccessible — réessayez sous peu.');
        return;
      }
      if (!res.ok || !data.ok) {
        setRunError('L’exécution n’a pas pu aboutir. Veuillez réessayer.');
        return;
      }
      setResult({
        ok: true,
        answer: typeof data.answer === 'string' ? data.answer : '',
        steps: Array.isArray(data.steps) ? data.steps : [],
        iterations: typeof data.iterations === 'number' ? data.iterations : 0,
      });
    } catch {
      setRunError('Erreur réseau lors de l’exécution. Vérifiez votre connexion et réessayez.');
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

  // ---- Flows tab: load / create / open / rename / delete / save / run ------

  // Pull the stable handles out of the hook so the callbacks below have precise
  // deps (the hook memoizes each fn).
  const {
    flows,
    load: loadFlows,
    save: saveFlowFn,
    remove: removeFlowFn,
    run: runFlowFn,
    runs,
    loadRuns,
    getRun,
    dlq,
    loadDlq,
    replay,
    loading: flowsLoading,
    error: flowsError,
  } = flowsApi;

  // Load the flows list the first time the Flows tab is opened.
  useEffect(() => {
    if (tab !== 'flows' || flowsLoadedOnce) return;
    setFlowsLoadedOnce(true);
    void loadFlows().catch(() => {});
  }, [tab, flowsLoadedOnce, loadFlows]);

  // Resolve a flowId → display name for the Runs view (falls back to the id).
  const flowNameById = useCallback(
    (flowId: string) => {
      const f = flows.find(x => x.id === flowId);
      return f ? f.name : `flow ${flowId.slice(0, 8)}`;
    },
    [flows]
  );

  // Create a fresh, unsaved draft (id 'new' → the backend mints on first PUT).
  const newFlow = useCallback(() => {
    const now = Date.now();
    setEditingFlow({
      id: 'new',
      name: 'Flow sans titre',
      nodes: [],
      edges: [],
      createdAt: now,
      updatedAt: now,
    });
    setFlowDirty(true); // a brand-new flow is unsaved by definition
    setFlowNotice(null);
  }, []);

  const openFlow = useCallback((flow: Flow) => {
    // Clone so canvas edits don't mutate the list entry until we persist.
    setEditingFlow({
      ...flow,
      nodes: flow.nodes.map(n => ({ ...n })),
      edges: flow.edges.map(e => ({ ...e })),
    });
    setFlowDirty(false);
    setFlowNotice(null);
  }, []);

  const closeFlow = useCallback(() => {
    setEditingFlow(null);
    setFlowDirty(false);
    setFlowNotice(null);
  }, []);

  // CANVAS-FE hands back the full updated Flow on every change (C2 shape).
  const onCanvasChange = useCallback((next: Flow) => {
    setEditingFlow(next);
    setFlowDirty(true);
  }, []);

  const renameEditingFlow = useCallback((name: string) => {
    setEditingFlow(prev => (prev ? { ...prev, name } : prev));
    setFlowDirty(true);
  }, []);

  const deleteFlow = useCallback(
    async (flow: Flow) => {
      // A never-saved draft ('new') isn't on the server — just drop it locally.
      if (!flow.id || flow.id === 'new') {
        if (editingFlow && editingFlow.id === flow.id) closeFlow();
        return;
      }
      try {
        await removeFlowFn(flow.id);
        if (editingFlow && editingFlow.id === flow.id) closeFlow();
      } catch {
        /* error surfaced via flowsError */
      }
    },
    [removeFlowFn, editingFlow, closeFlow]
  );

  const saveEditingFlow = useCallback(async () => {
    if (!editingFlow || savingFlow) return;
    setSavingFlow(true);
    setFlowNotice(null);
    try {
      const saved = await saveFlowFn(editingFlow);
      setEditingFlow(saved); // adopt the canonical id/timestamps from the server
      setFlowDirty(false);
      setFlowNotice('Flow enregistré.');
    } catch {
      /* error surfaced via flowsError */
    } finally {
      setSavingFlow(false);
    }
  }, [editingFlow, savingFlow, saveFlowFn]);

  // Run the open flow: persist first if there are unsaved edits (or it's new),
  // then POST /flows/:id/run, then switch to the Runs tab focused on the run.
  const runEditingFlow = useCallback(async () => {
    if (!editingFlow || runningFlow) return;
    setRunningFlow(true);
    setFlowNotice(null);
    try {
      let target = editingFlow;
      if (flowDirty || !target.id || target.id === 'new') {
        target = await saveFlowFn(editingFlow);
        setEditingFlow(target);
        setFlowDirty(false);
      }
      const record: FlowRun = await runFlowFn(target.id);
      setFocusRunId(record.id);
      setTab('runs');
    } catch {
      /* error surfaced via flowsError */
    } finally {
      setRunningFlow(false);
    }
  }, [editingFlow, runningFlow, flowDirty, saveFlowFn, runFlowFn]);

  return (
    <>
      <ViewTitle title="Intégrations" />
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
          Intégrations
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
        <AppAccessGate app="INTEGRATIONS">
        <CdzResponsive />
        <div
          data-cdz-surface=""
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
                <span>🔌</span> Intégrations
              </h1>
              <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
                Connectez ClickDz Work aux outils que vous utilisez déjà. Parcourez le
                catalogue Composio complet ci-dessous.
              </p>
            </header>

            {/* In-page tabs: Catalog | Flows | Runs ------------------------- */}
            <TabBar tab={tab} onChange={setTab} />

            {/* ============================= CATALOG ======================= */}
            {/* The original WS14 catalog surface, untouched — search, category */}
            {/* filter, cursor pagination, Connect, and the ▶ Run orchestrator. */}
            {tab === 'catalog' ? (
              <>
            {/* Status banner ------------------------------------------------ */}
            {state === 'loading' ? (
              <Banner tone="info">Chargement des intégrations…</Banner>
            ) : state === 'error' ? (
              <Banner tone="error">
                Impossible de charger les intégrations.{' '}
                <button style={linkBtnStyle} onClick={() => void loadFirst(false)}>
                  Réessayer
                </button>
              </Banner>
            ) : !enabled ? (
              <Banner tone="warn">
                <strong>Les intégrations ne sont pas encore configurées.</strong>
                <br />
                Demandez au propriétaire de définir <code style={codeStyle}>
                  COMPOSIO_API_KEY
                </code>{' '}
                sur le serveur, puis rechargez cette page. D’ici là, cet onglet reste
                en lecture seule et rien n’est connecté.
              </Banner>
            ) : (
              <Banner tone="ok">
                Les intégrations sont actives. Recherchez dans le catalogue, choisissez un outil, et appuyez sur{' '}
                <strong>Connecter</strong> pour lier votre compte.
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
                      <strong>{name}</strong> nécessite une configuration d’authentification dans le tableau de bord
                      Composio avant de pouvoir être connecté. Demandez au propriétaire d’ajouter
                      une configuration d’authentification pour ce kit, puis réessayez.
                    </>
                  ) : (
                    <>
                      Impossible de démarrer la connexion pour <strong>{name}</strong>
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
                    {connecting === connectError.toolkit ? 'Nouvelle tentative…' : 'Réessayer'}
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
                    placeholder="Rechercher des intégrations (ex. Slack, GitHub, Notion)…"
                    aria-label="Rechercher des intégrations"
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
                      aria-label="Effacer la recherche"
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
                    aria-label="Filtrer par catégorie"
                  >
                    {categoryChips.map(cat => {
                      const on = category === cat;
                      const label = cat === ALL_CATEGORIES ? 'Tous' : cat;
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
                                <Spinner /> Connexion…
                              </>
                            ) : isConnected ? (
                              <>✓ Connecté</>
                            ) : (
                              <>Connecter</>
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
                          Réessayer
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
                        <Spinner dark /> Chargement de plus…
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
                        Charger plus
                      </button>
                    ) : (
                      <span style={{ fontSize: 11, color: C.muted }}>
                        {toolkits.length} intégration
                        {toolkits.length === 1 ? '' : 's'} affichée{toolkits.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <Banner tone="info">
                  {search || category !== ALL_CATEGORIES
                    ? 'Aucune intégration ne correspond à votre recherche ou filtre. Essayez un autre terme ou catégorie.'
                    : "Aucun kit d’outils n’est disponible pour le moment. Une fois que le propriétaire aura terminé la configuration Composio, ils apparaîtront ici."}
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
                  <span>▶</span> Exécuter
                </h2>
                <p style={{ margin: 0, color: C.muted, fontSize: 12 }}>
                  Décrivez ce que vous voulez faire ; l’agent sélectionne et exécute les
                  bons outils parmi les kits que vous choisissez ci-dessous.
                </p>
              </div>

              {!enabled ? (
                <Banner tone="warn">
                  L’exécution est désactivée tant qu’un propriétaire n’a pas défini{' '}
                  <code style={codeStyle}>COMPOSIO_API_KEY</code> sur le serveur.
                </Banner>
              ) : null}

              {/* Prompt */}
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value.slice(0, RUN_PROMPT_MAX))}
                disabled={!enabled || running}
                placeholder="Ex : Mettre une étoile au repo composiohq/composio sur GitHub"
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
                  aria-label="Kits d’outils à autoriser"
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
                          title={capped ? `Jusqu’à ${RUN_MAX_TOOLKITS} kits d’outils` : name}
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
                      <Spinner /> Exécution…
                    </>
                  ) : (
                    <>▶ Exécuter</>
                  )}
                </button>
                <span style={{ fontSize: 12, color: C.muted }}>
                  {selected.length > 0
                    ? `${selected.length}/${RUN_MAX_TOOLKITS} kit${selected.length > 1 ? 's' : ''} d’outils sélectionné${selected.length > 1 ? 's' : ''}`
                    : 'Aucun filtre de kit d’outils — l’agent n’aura peut-être rien à exécuter.'}
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
                        {running ? 'Nouvelle tentative…' : 'Réessayer'}
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
                      Réponse
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        color: C.text,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {result.answer || '(aucune réponse renvoyée)'}
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
                        Étapes ({result.steps.length}) · {result.iterations}{' '}
                        itération{result.iterations === 1 ? '' : 's'}
                      </div>
                      {result.steps.map((step, i) => (
                        <StepRow key={`${step.tool}-${i}`} step={step} index={i} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
              </>
            ) : null}

            {/* ============================== FLOWS ======================== */}
            {tab === 'flows' ? (
              editingFlow ? (
                <FlowEditor
                  flow={editingFlow}
                  catalog={toolkits}
                  enabled={enabled}
                  dirty={flowDirty}
                  saving={savingFlow}
                  running={runningFlow}
                  notice={flowNotice}
                  error={flowsError}
                  onChange={onCanvasChange}
                  onRename={renameEditingFlow}
                  onBack={closeFlow}
                  onSave={() => void saveEditingFlow()}
                  onRun={() => void runEditingFlow()}
                  onDelete={() => void deleteFlow(editingFlow)}
                />
              ) : (
                <FlowList
                  flows={flows}
                  enabled={enabled}
                  loading={flowsLoading}
                  loadedOnce={flowsLoadedOnce}
                  error={flowsError}
                  onNew={newFlow}
                  onOpen={openFlow}
                  onRename={(flow, name) => void saveFlowFn({ ...flow, name })}
                  onDelete={flow => void deleteFlow(flow)}
                  onRefresh={() => void loadFlows()}
                />
              )
            ) : null}

            {/* =============================== RUNS ======================== */}
            {tab === 'runs' ? (
              <FlowRunsView
                runs={runs}
                dlq={dlq}
                loading={flowsLoading}
                error={flowsError}
                enabled={enabled}
                loadRuns={loadRuns}
                loadDlq={loadDlq}
                getRun={getRun}
                replay={replay}
                flowName={flowNameById}
                focusRunId={focusRunId}
              />
            ) : null}
          </div>
        </div>
        </AppAccessGate>
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
          {step.ok ? 'ok' : 'échec'}
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
          {step.resultPreview || '(résultat vide)'}
        </pre>
      ) : null}
    </div>
  );
};

// ---- Flows / tabs UI (FLOW-FE) --------------------------------------------

// The in-page tab bar. Pure inline-styled buttons matching the category chips.
const TAB_LABELS: Record<TabKey, string> = {
  catalog: 'Catalogue',
  flows: 'Flux',
  runs: 'Exécutions',
};

const TabBar = ({
  tab,
  onChange,
}: {
  tab: TabKey;
  onChange: (t: TabKey) => void;
}) => (
  /* On phones the strip is horizontally scrollable so all three tabs stay
     reachable without wrapping or clipping. scroll-snap keeps the selected
     tab from sitting half off-screen. Desktop is unaffected — the container
     never overflows on viewports wider than 600 px. */
  <div
    role="tablist"
    aria-label="Sections des intégrations"
    style={{
      display: 'flex',
      gap: 4,
      padding: 4,
      borderRadius: 12,
      background: C.panel,
      border: `1px solid ${C.border}`,
      alignSelf: 'flex-start',
      overflowX: 'auto',
      maxWidth: '100%',
      scrollSnapType: 'x mandatory',
      WebkitOverflowScrolling: 'touch',
    }}
  >
    {(['catalog', 'flows', 'runs'] as TabKey[]).map(key => {
      const on = tab === key;
      return (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={on}
          onClick={() => onChange(key)}
          style={{
            appearance: 'none',
            cursor: 'pointer',
            /* 44 px min-height for comfortable touch target (WCAG 2.5.5). */
            minHeight: 44,
            padding: '7px 16px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            flexShrink: 0,
            scrollSnapAlign: 'start',
            whiteSpace: 'nowrap',
            color: on ? '#fff' : C.text,
            background: on ? C.accent : 'transparent',
            border: 'none',
            transition: 'background 150ms ease, color 150ms ease',
          }}
        >
          {TAB_LABELS[key]}
        </button>
      );
    })}
  </div>
);

// The Flows list (name · node count · updated) + New / open / rename / delete.
const FlowList = ({
  flows,
  enabled,
  loading,
  loadedOnce,
  error,
  onNew,
  onOpen,
  onRename,
  onDelete,
  onRefresh,
}: {
  flows: Flow[];
  enabled: boolean;
  loading: boolean;
  loadedOnce: boolean;
  error: string | null;
  onNew: () => void;
  onOpen: (flow: Flow) => void;
  onRename: (flow: Flow, name: string) => void;
  onDelete: (flow: Flow) => void;
  onRefresh: () => void;
}) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const startRename = (flow: Flow) => {
    setRenamingId(flow.id);
    setDraftName(flow.name);
  };
  const commitRename = (flow: Flow) => {
    const name = draftName.trim();
    setRenamingId(null);
    if (name && name !== flow.name) onRename(flow, name);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
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
            <span>🧭</span> Flux
          </h2>
          <p style={{ margin: 0, color: C.muted, fontSize: 12 }}>
            Enchaînez vos outils connectés dans une automatisation. Ouvrez-en une pour la modifier sur
            le canvas, puis Enregistrer ou Exécuter.
          </p>
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onNew}
          style={{
            appearance: 'none',
            border: 'none',
            borderRadius: 8,
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
            color: '#fff',
            background: C.accent,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          + Nouveau flux
        </button>
      </div>

      {!enabled ? (
        <Banner tone="warn">
          L’exécution de flux est désactivée tant qu’un propriétaire n’a pas défini{' '}
          <code style={codeStyle}>COMPOSIO_API_KEY</code>. Vous pouvez toujours concevoir
          et enregistrer des flux.
        </Banner>
      ) : null}

      {!loadedOnce && loading ? (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            color: C.muted,
            padding: '20px 0',
          }}
        >
          <Spinner dark /> Chargement des flux…
        </div>
      ) : error && flows.length === 0 ? (
        <Banner tone="error">
          {error}{' '}
          <button style={linkBtnStyle} onClick={onRefresh}>
            Réessayer
          </button>
        </Banner>
      ) : flows.length === 0 ? (
        <div
          style={{
            padding: '24px 16px',
            borderRadius: 10,
            fontSize: 13,
            textAlign: 'center',
            background: C.panel,
            border: `1px dashed ${C.border}`,
            color: C.muted,
          }}
        >
          Aucun flux pour le moment. Appuyez sur <strong>+ Nouveau flux</strong> pour créer votre première
          automatisation.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {flows.map(flow => (
            <div
              key={flow.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 10,
                background: C.panel,
                border: `1px solid ${C.border}`,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                {renamingId === flow.id ? (
                  <input
                    autoFocus
                    value={draftName}
                    onChange={e => setDraftName(e.target.value)}
                    onBlur={() => commitRename(flow)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename(flow);
                      else if (e.key === 'Escape') setRenamingId(null);
                    }}
                    aria-label="Nom du flux"
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '4px 8px',
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 600,
                      fontFamily: 'inherit',
                      color: C.text,
                      background: C.bg,
                      border: `1px solid ${C.accent}`,
                      outline: 'none',
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpen(flow)}
                    style={{
                      appearance: 'none',
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      textAlign: 'left',
                      cursor: 'pointer',
                      font: 'inherit',
                      fontWeight: 600,
                      fontSize: 13,
                      color: C.text,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={flow.name}
                  >
                    {flow.name}
                  </button>
                )}
                <span style={{ fontSize: 11.5, color: C.muted }}>
                  {flow.nodes.length} nœud{flow.nodes.length === 1 ? '' : 's'} ·{' '}
                  {flow.edges.length} liaison{flow.edges.length === 1 ? '' : 's'} ·
                  mis à jour{' '}
                  {(() => {
                    try {
                      return new Date(flow.updatedAt).toLocaleString();
                    } catch {
                      return '—';
                    }
                  })()}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onOpen(flow)}
                style={miniBtnStyle(false)}
              >
                Ouvrir
              </button>
              <button
                type="button"
                onClick={() => startRename(flow)}
                style={miniBtnStyle(false)}
              >
                Renommer
              </button>
              <button
                type="button"
                onClick={() => onDelete(flow)}
                style={miniBtnStyle(true)}
              >
                Supprimer
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// A small pill button used in the flow list rows. `danger` tints it red.
const miniBtnStyle = (danger: boolean): CSSProperties => ({
  appearance: 'none',
  flexShrink: 0,
  borderRadius: 8,
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  color: danger ? 'var(--affine-error-color, #eb4b4b)' : C.text,
  background: 'transparent',
  border: `1px solid ${danger ? C.errBorder : C.border}`,
});

// The flow editor: a rename field + Save/Run/Delete/Back controls above the
// zero-dep FlowCanvas (mounted with the toolkits catalog + the editable Flow).
const FlowEditor = ({
  flow,
  catalog,
  enabled,
  dirty,
  saving,
  running,
  notice,
  error,
  onChange,
  onRename,
  onBack,
  onSave,
  onRun,
  onDelete,
}: {
  flow: Flow;
  catalog: CdzToolkit[];
  enabled: boolean;
  dirty: boolean;
  saving: boolean;
  running: boolean;
  notice: string | null;
  error: string | null;
  onChange: (flow: Flow) => void;
  onRename: (name: string) => void;
  onBack: () => void;
  onSave: () => void;
  onRun: () => void;
  onDelete: () => void;
}) => {
  const isNew = !flow.id || flow.id === 'new';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onBack}
          style={{
            appearance: 'none',
            borderRadius: 8,
            padding: '7px 12px',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            color: C.text,
            background: 'transparent',
            border: `1px solid ${C.border}`,
          }}
        >
          ← Flux
        </button>
        <input
          value={flow.name}
          onChange={e => onRename(e.target.value)}
          placeholder="Nom du flux"
          aria-label="Nom du flux"
          style={{
            flex: 1,
            minWidth: 160,
            boxSizing: 'border-box',
            padding: '8px 12px',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            fontFamily: 'inherit',
            color: C.text,
            background: C.panel,
            border: `1px solid ${C.border}`,
            outline: 'none',
          }}
        />
        <button
          type="button"
          disabled={saving || (!dirty && !isNew)}
          onClick={onSave}
          style={{
            appearance: 'none',
            borderRadius: 8,
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: 700,
            cursor: saving || (!dirty && !isNew) ? 'default' : 'pointer',
            color: C.text,
            background: 'transparent',
            border: `1px solid ${C.border}`,
            opacity: saving || (!dirty && !isNew) ? 0.5 : 1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {saving ? (
            <>
              <Spinner dark /> Enregistrement…
            </>
          ) : dirty || isNew ? (
            'Enregistrer'
          ) : (
            'Enregistré'
          )}
        </button>
        <button
          type="button"
          disabled={!enabled || running}
          onClick={onRun}
          title={!enabled ? 'Définir COMPOSIO_API_KEY pour exécuter des flux' : 'Exécuter ce flux'}
          style={{
            appearance: 'none',
            border: 'none',
            borderRadius: 8,
            padding: '8px 18px',
            fontSize: 13,
            fontWeight: 700,
            cursor: !enabled || running ? 'default' : 'pointer',
            color: '#fff',
            background: C.accent,
            opacity: !enabled || running ? 0.5 : 1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {running ? (
            <>
              <Spinner /> Exécution…
            </>
          ) : (
            <>▶ Exécuter</>
          )}
        </button>
        <button type="button" onClick={onDelete} style={miniBtnStyle(true)}>
          Supprimer
        </button>
      </div>

      {notice ? <Banner tone="ok">{notice}</Banner> : null}
      {error ? <Banner tone="error">{error}</Banner> : null}

      {/* The zero-dep canvas (CANVAS-FE). It owns node drag / edge draw / */}
      {/* palette / inspector and hands the full updated Flow back via onChange. */}
      <div
        style={{
          position: 'relative',
          height: 560,
          borderRadius: 12,
          overflow: 'hidden',
          background: C.bg,
          border: `1px solid ${C.border}`,
        }}
      >
        <FlowCanvas flow={flow} catalog={catalog} onChange={onChange} />
      </div>
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
