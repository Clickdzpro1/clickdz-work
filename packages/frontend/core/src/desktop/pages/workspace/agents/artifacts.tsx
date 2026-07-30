import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { ensureClickDzResponsiveCss } from '@affine/core/clickdz/responsive';

// Inject the CDZ responsive stylesheet once per document (idempotent + SSR-safe).
const CdzResponsive = () => { ensureClickDzResponsiveCss(); return null; };
// Shared paginated-list kit (R9, Feuillet). Dependency-light, boot-safe; the
// library is paged (grid) instead of rendering every artifact at once.
import { PagedList } from '@affine/core/clickdz/paged-list';
import { AgentPalette } from '@affine/core/modules/agents/components';
// AgentApiError (Passe's typed REST error): reused ONLY for its `.status`
// discriminator so a 404 (CDZ_AGENTS_ENABLED off) becomes the quiet fallback,
// byte-identically to runs.tsx. The artifacts list itself is a tiny inline
// fetch below (this page owns no api.ts surface), so it never collides with the
// channels round's edits to modules/agents/api.ts.
import { AgentApiError } from '@affine/core/modules/agents/api';
import { type TFunc, useAgentLang } from '@affine/core/modules/agents/i18n';
import type { AgentName } from '@affine/core/modules/agents/types';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchService,
} from '@affine/core/modules/workbench';
import { useService } from '@toeverything/infra';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

// ---------------------------------------------------------------------------
// ClickDz Agents — Livrables (artifacts library), full-page (R10, WS11-6).
//
// Every deliverable an agent produced across ALL its background runs — files
// written, generated outputs/docs, and published pages / links — collected
// into one browseable, paged grid. The backend persists an `artifact` event
// per run into a per-user Redis list (clickdz:agentart:{userId}) via the run
// engine's appendRunEvent (clickdz-agent-runs.ts); this page reads that library
// via `GET /api/v1/agents/artifacts?agent=&limit=` (ClickDzAgentsController).
//
// It mirrors runs.tsx: ViewHeader/ViewBody chrome, an agent filter (here with
// an extra "Tous / All" tab because artifacts span agents), a PagedList body,
// and loading / error / empty / quiet(404) states — all copy from the shared
// agents i18n catalogue via `useAgentLang()` (FR default + Algerian darja, RTL
// for 'ar'). The card visuals reuse the ArtifactsPanel kind palette (icon +
// accent by kind); an OUTPUT/FILE card opens its originating run (where the
// live sandbox + in-run Livrables panel can preview/download it), a LINK opens
// externally (target=_blank rel=noopener) or in-app via the workbench.
//
// The list endpoint is gated by CDZ_AGENTS_ENABLED on the backend (a typed 404
// when off) — so like listAgentRuns this fetch doubles as a capability probe:
// a 404 shows the quiet "Agents non activés" fallback instead of an error.
//
// House rules: inline styles only (no .css.ts), no new deps, shared
// AgentPalette tokens, boot-safe. Exports BOTH `Component` (the react-router
// lazy convention every sibling page uses) and a default export.
// ---------------------------------------------------------------------------

const C = AgentPalette.color;
const R = AgentPalette.radius;

// The agents that own runs (→ artifacts). Kept local (not imported as a runtime
// const) so this file never hard-depends on a registry export. Labels are
// proper nouns (Hermes / OpenClaw) — not localized. `all` is the default view.
const AGENTS: { id: AgentName; label: string; emoji: string }[] = [
  { id: 'hermes', label: 'Hermes', emoji: '🤝' },
  { id: 'openclaw', label: 'OpenClaw', emoji: '🛠️' },
];

// The filter value: a known agent, or 'all' (no filter — the default).
type ArtifactFilter = AgentName | 'all';

type LoadState = 'loading' | 'ready' | 'error';

// ---------------------------------------------------------------------------
// Wire type — mirrors the backend AgentArtifactRecord (clickdz-agent-runs.ts).
// A discriminated-ish record on `kind`; all non-key fields optional so an older
// / partial row never crashes the card. This is intentionally a local mirror
// (the backend type isn't exported to the FE), the same cross-boundary pattern
// runs.tsx uses for AgentRunSummary.
// ---------------------------------------------------------------------------
interface ArtifactRow {
  runId: string;
  agent: AgentName;
  kind: 'file' | 'output' | 'link';
  title: string;
  path?: string;
  url?: string;
  language?: string;
  bytes?: number;
  text?: string;
  at: number;
}

// Per-kind card presentation, mirroring ArtifactsPanel's KIND_UI (icon + accent
// + i18n group-label key reused for the fallback title). Keeps the two surfaces
// visually consistent.
const KIND_UI: Record<
  ArtifactRow['kind'],
  { icon: string; color: string; fallbackKey: string }
> = {
  file: { icon: '🗎', color: C.kindWrite, fallbackKey: 'artifacts.file.fallback' },
  output: { icon: '❖', color: C.kindFinal, fallbackKey: 'artifacts.output.fallback' },
  link: { icon: '🔗', color: C.kindTool, fallbackKey: 'artifacts.link.fallback' },
};

// ---------------------------------------------------------------------------
// Small pure helpers (defensive against partial/odd payloads) — the same logic
// ArtifactsPanel uses, kept local so this page carries no cross-module import
// beyond the shared kit.
// ---------------------------------------------------------------------------

/** Human-readable byte size (1 KB = 1024 B), matching ArtifactsPanel. */
function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Directory portion of a file path (everything before the basename). */
function dirname(path: string): string {
  const clean = (path || '').replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx > 0 ? clean.slice(0, idx) : '';
}

/**
 * A link is "external" when it has an absolute http(s) origin different from the
 * current page (or when we can't tell). Relative + same-origin URLs are
 * "internal" (routable in-app via the workbench). Mirrors ArtifactsPanel.
 */
function isExternalUrl(url: string): boolean {
  const u = (url || '').trim();
  if (!u) return false;
  if (/^(mailto:|tel:)/i.test(u)) return true;
  if (!/^https?:\/\//i.test(u)) return false; // relative → internal
  if (typeof window === 'undefined' || !window.location) return true;
  try {
    return new URL(u, window.location.href).origin !== window.location.origin;
  } catch {
    return true;
  }
}

/** Compact "host/first-path-bit" subtitle for a link. Mirrors ArtifactsPanel. */
function linkSubtitle(url: string): string {
  const u = (url || '').trim();
  if (!u) return '';
  try {
    const parsed = new URL(
      u,
      typeof window !== 'undefined' && window.location
        ? window.location.href
        : 'https://x'
    );
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}`.slice(0, 48);
  } catch {
    return u.slice(0, 48);
  }
}

/** Short run id for the card footer (first 8 chars of the UUID). */
function shortRun(runId: string): string {
  const s = (runId || '').trim();
  return s ? s.slice(0, 8) : s;
}

// Coerce a search-param string into a known ArtifactFilter ('all' default).
function coerceFilter(v: string | null): ArtifactFilter {
  return v === 'hermes' || v === 'openclaw' ? v : 'all';
}

/** Narrow a loose value to a known AgentName (else null). */
function coerceAgent(v: unknown): AgentName | null {
  return v === 'hermes' || v === 'openclaw' ? v : null;
}

// ---------------------------------------------------------------------------
// Data — a tiny inline fetch (this page owns no api.ts surface). Cookie auth
// via credentials:'include' (the backend authenticates via @CurrentUser), same
// idiom as modules/agents/api.ts. Throws AgentApiError on a non-2xx so the
// caller can flag-detect `.status === 404`.
// ---------------------------------------------------------------------------
async function fetchArtifacts(
  filter: ArtifactFilter,
  limit = 200
): Promise<ArtifactRow[]> {
  const params = new URLSearchParams();
  if (filter !== 'all') params.set('agent', filter);
  params.set('limit', String(limit));
  const path = `/api/v1/agents/artifacts?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(cdzApiUrl(path), { credentials: 'include' });
  } catch (cause) {
    throw new AgentApiError(
      cause instanceof Error && cause.message
        ? `Network error: ${cause.message}`
        : 'Network error while contacting the agent service.',
      0
    );
  }
  if (!res.ok) {
    let msg = res.statusText || `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as any;
      const m =
        data?.message ??
        data?.error?.message ??
        (typeof data?.error === 'string' ? data.error : undefined);
      if (typeof m === 'string' && m.trim()) msg = m.trim();
    } catch {
      /* fall through to status text */
    }
    throw new AgentApiError(msg, res.status);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  const rows = Array.isArray(body?.artifacts) ? body.artifacts : [];
  // Normalize defensively: drop rows with an unknown kind; coerce the agent.
  const out: ArtifactRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const kind = r.kind;
    if (kind !== 'file' && kind !== 'output' && kind !== 'link') continue;
    out.push({
      runId: typeof r.runId === 'string' ? r.runId : '',
      agent: coerceAgent(r.agent) ?? 'hermes',
      kind,
      title: typeof r.title === 'string' ? r.title : '',
      path: typeof r.path === 'string' ? r.path : undefined,
      url: typeof r.url === 'string' ? r.url : undefined,
      language: typeof r.language === 'string' ? r.language : undefined,
      bytes: typeof r.bytes === 'number' ? r.bytes : undefined,
      text: typeof r.text === 'string' ? r.text : undefined,
      at: typeof r.at === 'number' ? r.at : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------
const AgentsArtifactsPage = () => {
  const [params, setParams] = useSearchParams();
  const filter = coerceFilter(params.get('agent'));

  const { t, dir } = useAgentLang();
  const workbench = useService(WorkbenchService).workbench;

  const [state, setState] = useState<LoadState>('loading');
  const [rows, setRows] = useState<ArtifactRow[]>([]);
  // One-shot capability probe: null = probing, true = API answered, false =
  // 404 (CDZ_AGENTS_ENABLED off) → the quiet "Agents non activés" fallback.
  const [enabled, setEnabled] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const list = await fetchArtifacts(filter);
      // Newest first (the backend already returns newest-first, but sort by the
      // persisted timestamp defensively in case of a partial/older row).
      const sorted = [...list].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      setRows(sorted);
      setEnabled(true);
      setState('ready');
    } catch (err) {
      // 404 ⇒ feature flag off: quiet fallback, no error surfaced.
      if (err instanceof AgentApiError && err.status === 404) {
        setEnabled(false);
        setRows([]);
        setState('ready');
        return;
      }
      setEnabled(prev => (prev === true ? true : prev));
      setState('error');
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const openRun = useCallback(
    (row: ArtifactRow) => {
      if (!row.runId) return;
      workbench.open(
        `/agents/run/${encodeURIComponent(row.runId)}?agent=${row.agent}`
      );
    },
    [workbench]
  );

  const openInternalLink = useCallback(
    (url: string) => {
      // Same-origin / relative link → route it in-app via the workbench.
      workbench.open(url);
    },
    [workbench]
  );

  const selectFilter = useCallback(
    (next: ArtifactFilter) => {
      const p = new URLSearchParams(params);
      if (next === 'all') p.delete('agent');
      else p.set('agent', next);
      setParams(p, { replace: true });
    },
    [params, setParams]
  );

  const showQuietFallback = enabled === false;

  return (
    <>
      <ViewTitle title={t('artifactslib.tabTitle')} />
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
          <span aria-hidden style={{ fontSize: 16 }}>
            📦
          </span>
          {t('artifactslib.tabTitle')}
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
            {t('common.beta')}
          </span>
        </div>
      </ViewHeader>
      <ViewBody>
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
          <CdzResponsive />
          <style>{ARTIFACTS_CSS}</style>
          <div
            dir={dir}
            className="cdz-agents-artifacts-canvas"
            style={{
              maxWidth: 920,
              margin: '0 auto',
              padding: '28px 24px 48px',
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
            }}
          >
            {/* Header + refresh */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 14,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 220 }}>
                <h1
                  style={{
                    margin: 0,
                    fontSize: 22,
                    fontWeight: 800,
                    color: C.text,
                    lineHeight: 1.2,
                  }}
                >
                  {t('artifactslib.title')}
                </h1>
                <p style={{ margin: '4px 0 0', fontSize: 12.5, color: C.muted }}>
                  {t('artifactslib.subtitle')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void load()}
                title={t('common.refresh')}
                style={{
                  appearance: 'none',
                  flexShrink: 0,
                  width: 32,
                  height: 32,
                  borderRadius: R.md,
                  border: `1px solid ${C.border}`,
                  background: C.panel,
                  color: C.muted,
                  cursor: 'pointer',
                  fontSize: 15,
                  lineHeight: 1,
                }}
              >
                ↻
              </button>
            </div>

            {/* Agent filter (Tous / Hermes / OpenClaw) */}
            <div
              role="tablist"
              aria-label={t('artifactslib.filter.label')}
              style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
            >
              <FilterTab
                label={t('artifactslib.filter.all')}
                emoji="✷"
                active={filter === 'all'}
                onClick={() => selectFilter('all')}
              />
              {AGENTS.map(a => (
                <FilterTab
                  key={a.id}
                  label={a.label}
                  emoji={a.emoji}
                  active={filter === a.id}
                  onClick={() => selectFilter(a.id)}
                />
              ))}
            </div>

            {/* Body: quiet fallback | loading | error | empty | grid */}
            {showQuietFallback ? (
              <QuietFallback t={t} />
            ) : state === 'loading' ? (
              <LoadingRow t={t} />
            ) : state === 'error' ? (
              <ErrorRow t={t} onRetry={() => void load()} />
            ) : rows.length === 0 ? (
              <EmptyRow t={t} />
            ) : (
              // Paged grid (pageSize 12). `key={filter}` resets to page 1 when
              // the filter changes. Labels come from `pagerLabels(dir)` — the
              // agents i18n catalogue has NO common.prev/common.next keys, so we
              // pass FR/AR literals chosen by text direction (same rationale as
              // runs.tsx) rather than invent catalogue keys.
              <PagedList<ArtifactRow>
                key={filter}
                items={rows}
                pageSize={12}
                grid
                minItemWidth={240}
                gap={10}
                labels={pagerLabels(dir)}
                renderItem={(row, i) => (
                  <ArtifactCard
                    key={`${row.runId}:${i}`}
                    row={row}
                    t={t}
                    dir={dir}
                    showAgent={filter === 'all'}
                    onOpenRun={() => openRun(row)}
                    onOpenInternalLink={openInternalLink}
                  />
                )}
              />
            )}
          </div>
        </div>
      </ViewBody>
    </>
  );
};

// ---- filter tab ------------------------------------------------------------

const FilterTab = ({
  label,
  emoji,
  active,
  onClick,
}: {
  label: string;
  emoji: string;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={onClick}
    style={{
      appearance: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      padding: '7px 14px',
      borderRadius: R.pill,
      cursor: 'pointer',
      fontSize: 13,
      fontWeight: 700,
      color: active ? C.accent : C.muted,
      background: active ? C.accentSoft : 'transparent',
      border: `1px solid ${active ? C.accentBorder : C.border}`,
      transition: 'background 150ms ease, color 150ms ease',
    }}
  >
    <span aria-hidden style={{ fontSize: 15 }}>
      {emoji}
    </span>
    {label}
  </button>
);

// ---- one artifact card -----------------------------------------------------
//
// A file/output card is a static tile whose primary action opens its
// originating run (where the live sandbox + in-run Livrables panel can
// preview/download it). A link card is an anchor: external → target=_blank
// rel=noopener; internal (same-origin/relative) → in-app via the workbench.
const ArtifactCard = ({
  row,
  t,
  dir,
  showAgent,
  onOpenRun,
  onOpenInternalLink,
}: {
  row: ArtifactRow;
  t: TFunc;
  dir: 'rtl' | 'ltr';
  showAgent: boolean;
  onOpenRun: () => void;
  onOpenInternalLink: (url: string) => void;
}) => {
  const ui = KIND_UI[row.kind] ?? KIND_UI.output;
  const title = row.title || t(ui.fallbackKey);
  const agentLabel = AGENTS.find(a => a.id === row.agent)?.label ?? row.agent;

  // Subtitle by kind: file → "dir · size"; link → host/path; output → text.
  let subtitle = '';
  let subtitleLtr = false;
  if (row.kind === 'file') {
    const parts = [dirname(row.path ?? ''), formatBytes(row.bytes)].filter(Boolean);
    subtitle = parts.join(' · ');
    subtitleLtr = true;
  } else if (row.kind === 'link') {
    subtitle = linkSubtitle(row.url ?? '');
    subtitleLtr = true;
  } else {
    subtitle = row.text ?? '';
  }

  const isLink = row.kind === 'link';
  const external = isLink && isExternalUrl(row.url ?? '');
  const affordanceGlyph = isLink ? (external ? '↗' : '⤓') : '→';
  const affordanceLabel = isLink
    ? external
      ? t('artifacts.open.newTab')
      : t('artifacts.open')
    : t('artifactslib.card.openRun');

  const cardStyle = {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    padding: '12px 13px',
    borderRadius: R.lg,
    background: C.panel,
    border: `1px solid ${C.border}`,
    color: C.text,
    textDecoration: 'none',
    cursor: 'pointer',
    height: '100%',
    boxSizing: 'border-box' as const,
    transition: 'background 150ms ease, border-color 150ms ease',
  };

  const onEnter = (el: HTMLElement) => {
    el.style.background = C.accentSoft;
    el.style.borderColor = C.accentBorder;
  };
  const onLeave = (el: HTMLElement) => {
    el.style.background = C.panel;
    el.style.borderColor = C.border;
  };

  const inner = (
    <>
      {/* top row: icon + title + kind meta chip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 32,
            height: 32,
            flex: '0 0 auto',
            borderRadius: R.md,
            display: 'grid',
            placeItems: 'center',
            fontSize: 15,
            lineHeight: 1,
            color: ui.color,
            background: `color-mix(in srgb, ${ui.color} 14%, transparent)`,
            border: `1px solid color-mix(in srgb, ${ui.color} 34%, transparent)`,
          }}
        >
          {ui.icon}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13.5,
            fontWeight: 600,
            color: C.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={title}
        >
          {title}
        </span>
        {row.kind === 'file' && row.language ? (
          <span
            dir="ltr"
            style={{
              flex: '0 0 auto',
              fontSize: 10,
              fontWeight: 700,
              padding: '1px 7px',
              borderRadius: R.pill,
              color: ui.color,
              border: `1px solid color-mix(in srgb, ${ui.color} 34%, transparent)`,
            }}
          >
            {row.language}
          </span>
        ) : null}
      </div>

      {/* subtitle (path / host / output preview) */}
      {subtitle ? (
        <span
          dir={subtitleLtr ? 'ltr' : dir}
          style={{
            fontSize: 11.5,
            color: C.muted,
            fontFamily: row.kind === 'file' ? AgentPalette.font.mono : AgentPalette.font.body,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={subtitle}
        >
          {subtitle}
        </span>
      ) : null}

      {/* footer: source run + affordance */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 'auto',
          fontSize: 11,
          color: C.muted,
        }}
      >
        <span style={{ flex: 1, minWidth: 0, display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          {showAgent ? (
            <span style={{ fontWeight: 700, color: C.muted }}>{agentLabel}</span>
          ) : null}
          {row.runId ? (
            <span dir="ltr" style={{ fontFamily: AgentPalette.font.mono }}>
              {t('artifactslib.card.fromRun', { run: shortRun(row.runId) })}
            </span>
          ) : null}
        </span>
        <span
          aria-label={affordanceLabel}
          title={affordanceLabel}
          style={{
            flex: '0 0 auto',
            width: 24,
            height: 24,
            display: 'grid',
            placeItems: 'center',
            borderRadius: R.sm,
            color: C.accent,
            fontSize: 13,
          }}
        >
          {affordanceGlyph}
        </span>
      </div>
    </>
  );

  // External / internal-deferred link → render the whole card as an anchor for
  // correct middle-click / context-menu behaviour.
  if (isLink && row.url) {
    return (
      <a
        href={row.url}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        onClick={e => {
          // In-app routing preference for internal links.
          if (!external) {
            e.preventDefault();
            onOpenInternalLink(row.url as string);
          }
        }}
        style={cardStyle}
        onMouseEnter={e => onEnter(e.currentTarget)}
        onMouseLeave={e => onLeave(e.currentTarget)}
      >
        {inner}
      </a>
    );
  }

  // File / output (or a link with no url) → a button that opens the source run.
  return (
    <button
      type="button"
      onClick={onOpenRun}
      style={{ ...cardStyle, textAlign: 'start' }}
      onMouseEnter={e => onEnter(e.currentTarget)}
      onMouseLeave={e => onLeave(e.currentTarget)}
    >
      {inner}
    </button>
  );
};

// ---- pager labels (dir-aware; catalogue has no common.prev/next) -----------
function pagerLabels(dir: 'rtl' | 'ltr'): {
  prev: string;
  next: string;
  page: (n: number, total: number) => string;
} {
  return dir === 'rtl'
    ? {
        prev: '‹ السابق',
        next: 'التالي ›',
        page: (n, total) => `صفحة ${n}/${total}`,
      }
    : {
        prev: '‹ Précédent',
        next: 'Suivant ›',
        page: (n, total) => `Page ${n}/${total}`,
      };
}

// Mobile polish: tighten the canvas padding on phones (the grid already
// reflows via auto-fill; this just reclaims horizontal space).
const ARTIFACTS_CSS = `
@media (max-width: 560px){
  .cdz-agents-artifacts-canvas{padding:18px 14px 40px !important;}
}
`;

// ---- states ----------------------------------------------------------------

const LoadingRow = ({ t }: { t: TFunc }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '18px 4px',
      color: C.muted,
    }}
  >
    <Spinner /> {t('artifactslib.loading')}
  </div>
);

const ErrorRow = ({ t, onRetry }: { t: TFunc; onRetry: () => void }) => (
  <div
    style={{
      borderRadius: R.lg,
      border: `1px solid ${C.errBorder}`,
      background: C.errBg,
      padding: '14px 16px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
    }}
  >
    <span style={{ flex: 1, minWidth: 180, fontSize: 13, color: C.text }}>
      {t('artifactslib.error.load')}
    </span>
    <button
      type="button"
      onClick={onRetry}
      style={{
        appearance: 'none',
        padding: '6px 14px',
        borderRadius: R.md,
        border: `1px solid ${C.border}`,
        background: C.panel,
        color: C.text,
        cursor: 'pointer',
        fontSize: 12.5,
        fontWeight: 600,
      }}
    >
      {t('common.retry')}
    </button>
  </div>
);

const EmptyRow = ({ t }: { t: TFunc }) => (
  <div
    style={{
      borderRadius: R.lg,
      border: `1px dashed ${C.border}`,
      background: C.panel,
      padding: '26px 20px',
      textAlign: 'center',
      color: C.muted,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}
  >
    <span aria-hidden style={{ fontSize: 28, opacity: 0.7 }}>
      🗂
    </span>
    <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
      {t('artifactslib.empty.title')}
    </span>
    <span style={{ fontSize: 12.5, maxWidth: 420, margin: '0 auto' }}>
      {t('artifactslib.empty.body')}
    </span>
  </div>
);

// Flag-off / 404 quiet fallback — the whole feature is dark server-side.
const QuietFallback = ({ t }: { t: TFunc }) => (
  <div
    style={{
      borderRadius: R.lg,
      border: `1px solid ${C.border}`,
      background: C.panel,
      padding: '26px 20px',
      textAlign: 'center',
      color: C.muted,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}
  >
    <span aria-hidden style={{ fontSize: 26, opacity: 0.7 }}>
      🔒
    </span>
    <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
      {t('artifactslib.quiet.title')}
    </span>
    <span style={{ fontSize: 12.5, maxWidth: 400, margin: '0 auto' }}>
      {t('artifactslib.quiet.body')}
    </span>
  </div>
);

// Minimal local spinner (reuses the shared keyframe injected by the kit; falls
// back to a static ring if the keyframe isn't present).
const Spinner = () => (
  <span
    aria-hidden
    style={{
      display: 'inline-block',
      width: 14,
      height: 14,
      borderRadius: '50%',
      border: `2px solid color-mix(in srgb, ${C.accent} 30%, transparent)`,
      borderTopColor: C.accent,
      animation: 'cdz-agent-spin 0.7s linear infinite',
      flex: '0 0 auto',
    }}
  />
);

export const Component = () => {
  return <AgentsArtifactsPage />;
};

export default AgentsArtifactsPage;
