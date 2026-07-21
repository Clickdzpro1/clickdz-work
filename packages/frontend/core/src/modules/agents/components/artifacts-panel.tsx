// ArtifactsPanel — the "Livrables" side panel for a run view. It collects the
// AgentArtifact events a run produced (files written, generated outputs/docs,
// published pages / links) into tidy cards grouped by kind, each with an
// icon, a title, a small subtitle, and an open/download affordance.
//
// AgentArtifact (types.ts, C1) is a discriminated union on `kind`:
//   · { kind: 'file';   path: string; language?: string; bytes?: number }
//   · { kind: 'output'; label: string; text: string }
//   · { kind: 'link';   label: string; url: string }
// There is NO top-level title/name/url/timestamp — we derive the card title
// from `path` (basename) or `label`, and order chronologically within a group
// by the array order Scene passed us (the order the events arrived).
//
// Pure presentational: it receives `artifacts` via props (Scene extracts them
// from the durable run's `useAgentRunStream().artifacts` — same AgentArtifact[]
// shape — or from a finished run record's step/event timeline) and an optional
// `onOpen` handler. External links open target=_blank rel=noopener; INTERNAL
// artifact URLs (relative / same-origin) prefer `onOpen` so the app can route
// them in-app, falling back to a normal anchor when no handler is given.
// Inline styles only (house rule); reuses the shared palette + primitives kit.
//
// R8 (POLI, additive): user-facing copy — panel title, group headers, empty
// state, card fallbacks + open/download affordances — flows through the agents
// i18n table via `useAgentLang()` (FR default + Algerian darja). The `title`
// prop stays `title?: string`; when omitted it now resolves from i18n
// (`artifacts.title`, which is "Livrables" in FR → byte-identical default). The
// export + props are backward-compatible. RTL-safe: the panel flips for 'ar'
// while technical spans (file paths, link host/path, language chip) stay LTR.

import type { CSSProperties, ReactNode } from 'react';

import type { AgentArtifact } from '../types';
import { type TFunc, useAgentLang } from '../i18n';
import { AgentPalette as P, ensureAgentKeyframes } from './palette';
import { Chip, IconButton, truncate } from './primitives';

// ---------------------------------------------------------------------------
// Per-kind presentation metadata (glyph + accent + group-label key), mirroring
// the KIND_META idiom in primitives.tsx so the panel reads like the rest of the
// kit. The group label is a language-aware i18n key resolved at render time.
// ---------------------------------------------------------------------------
type ArtifactKind = AgentArtifact['kind'];

const KIND_UI: Record<
  ArtifactKind,
  { icon: string; groupLabelKey: string; color: string }
> = {
  file: { icon: '🗎', groupLabelKey: 'artifacts.group.file', color: P.color.kindWrite },
  output: { icon: '❖', groupLabelKey: 'artifacts.group.output', color: P.color.kindFinal },
  link: { icon: '🔗', groupLabelKey: 'artifacts.group.link', color: P.color.kindTool },
};

// Group order in the panel (files, then generated outputs, then links).
const GROUP_ORDER: ArtifactKind[] = ['file', 'output', 'link'];

// ---------------------------------------------------------------------------
// Small helpers — all pure, defensive against partial/odd payloads.
// ---------------------------------------------------------------------------

/** Last path segment (basename) of a file artifact's path. `fallback` is the
 *  (already-localised) label used when the path yields no name. */
function basename(path: string, fallback: string): string {
  const clean = (path || '').replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  const name = idx >= 0 ? clean.slice(idx + 1) : clean;
  return name || path || fallback;
}

/** Directory portion of a file path (everything before the basename). */
function dirname(path: string): string {
  const clean = (path || '').replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx > 0 ? clean.slice(0, idx) : '';
}

/** Human-readable byte size (1 KB = 1024 B). */
function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) {
    return '';
  }
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

/**
 * A link is "external" when it has an absolute http(s) origin different from
 * the current page (or when we can't tell — treat http(s) as external so it
 * opens in a new tab rather than trying to route it in-app). Relative URLs and
 * same-origin absolute URLs are "internal" (routable via `onOpen`).
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

/** Compact "host/first-path-bit" label for a link's subtitle. */
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
    return truncate(`${parsed.host}${path}`, 48);
  } catch {
    return truncate(u, 48);
  }
}

// ---------------------------------------------------------------------------
// Derive per-card view data from the union — the single place kind-specific
// fields are read, so the card renderer stays kind-agnostic.
// ---------------------------------------------------------------------------
interface CardView {
  title: string;
  subtitle: string;
  /** Present only for link artifacts. */
  url?: string;
  /** True when `url` should open in a new tab (external). */
  external: boolean;
  /** Chip text on the right (bytes / language / OUVRIR), optional. */
  meta?: string;
}

// `t` resolves the language-aware title fallbacks (file / output / link / generic).
function toCardView(a: AgentArtifact, t: TFunc): CardView {
  switch (a.kind) {
    case 'file': {
      const dir = dirname(a.path);
      const size = formatBytes(a.bytes);
      const parts = [dir, size].filter(Boolean);
      return {
        title: basename(a.path, t('artifacts.file.fallback')),
        subtitle: parts.length ? truncate(parts.join(' · '), 56) : '',
        external: false,
        meta: a.language || undefined,
      };
    }
    case 'output': {
      return {
        title: a.label || t('artifacts.output.fallback'),
        subtitle: a.text ? truncate(a.text, 72) : '',
        external: false,
      };
    }
    case 'link': {
      return {
        title: a.label || linkSubtitle(a.url) || t('artifacts.link.fallback'),
        subtitle: linkSubtitle(a.url),
        url: a.url,
        external: isExternalUrl(a.url),
      };
    }
    default: {
      // Exhaustive over the union; a future kind renders as a bare row.
      const anyA = a as { label?: string; kind?: string };
      return {
        title: anyA.label || anyA.kind || t('artifacts.fallback'),
        subtitle: '',
        external: false,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// One artifact card.
// ---------------------------------------------------------------------------
function ArtifactCard({
  artifact,
  index,
  onOpen,
  t,
  dir,
}: {
  artifact: AgentArtifact;
  index: number;
  onOpen?: (artifact: AgentArtifact, index: number) => void;
  t: TFunc;
  dir: 'rtl' | 'ltr';
}) {
  const view = toCardView(artifact, t);
  const ui = KIND_UI[artifact.kind] ?? KIND_UI.output;

  // The open affordance differs by kind:
  //  · external link → real <a target=_blank rel=noopener> (also honours onOpen)
  //  · internal link → onOpen when provided, else <a href>
  //  · file / output → onOpen (download/preview) when provided, else disabled
  const isLink = view.url !== undefined;
  const canHandle = typeof onOpen === 'function';
  const affordanceLabel = isLink
    ? view.external
      ? t('artifacts.open.newTab')
      : t('artifacts.open')
    : artifact.kind === 'file'
      ? t('artifacts.download')
      : t('artifacts.open');
  const affordanceGlyph = isLink && view.external ? '↗' : '⤓';

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: P.space.sm + 2,
    padding: '9px 10px',
    borderRadius: P.radius.md,
    border: `1px solid ${P.color.border}`,
    background: P.color.panelRaised,
    minWidth: 0,
  };

  const iconBox: CSSProperties = {
    width: 30,
    height: 30,
    flex: '0 0 auto',
    borderRadius: P.radius.sm,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 15,
    lineHeight: 1,
    color: ui.color,
    background: `color-mix(in srgb, ${ui.color} 14%, transparent)`,
    border: `1px solid color-mix(in srgb, ${ui.color} 34%, transparent)`,
  };

  const body: ReactNode = (
    <>
      <span aria-hidden="true" style={iconBox}>
        {ui.icon}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        <span
          style={{
            fontSize: P.font.size.md,
            fontWeight: 600,
            color: P.color.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={view.title}
        >
          {view.title}
        </span>
        {view.subtitle ? (
          <span
            // File paths + link host/path are technical → keep LTR even in RTL.
            dir={artifact.kind === 'file' || isLink ? 'ltr' : dir}
            style={{
              fontSize: P.font.size.sm,
              color: P.color.muted,
              fontFamily: artifact.kind === 'file' ? P.font.mono : P.font.body,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={view.subtitle}
          >
            {view.subtitle}
          </span>
        ) : null}
      </span>
      {view.meta ? (
        <Chip
          color={ui.color}
          border={`color-mix(in srgb, ${ui.color} 34%, transparent)`}
          style={{ flex: '0 0 auto' }}
        >
          <span dir="ltr">{view.meta}</span>
        </Chip>
      ) : null}
    </>
  );

  // External / internal link where we defer to the browser: render the whole
  // card as an anchor for correct middle-click / context-menu behaviour.
  if (isLink && !(view.external === false && canHandle)) {
    return (
      <a
        className="cdz-agent-motion cdz-agent-step"
        href={view.url}
        target={view.external ? '_blank' : undefined}
        rel={view.external ? 'noopener noreferrer' : undefined}
        onClick={e => {
          // In-app routing preference: if a handler exists AND the link is
          // internal, let the app handle it (prevent full navigation).
          if (canHandle && !view.external) {
            e.preventDefault();
            onOpen?.(artifact, index);
          }
        }}
        style={{
          ...rowStyle,
          textDecoration: 'none',
          cursor: 'pointer',
          transition: `background ${P.motion.fast} ${P.motion.ease}, border-color ${P.motion.fast} ${P.motion.ease}`,
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = P.color.accentBorder;
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = P.color.border;
        }}
      >
        {body}
        <span
          aria-hidden="true"
          style={{
            flex: '0 0 auto',
            width: 26,
            height: 26,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: P.color.muted,
            fontSize: 13,
          }}
        >
          {affordanceGlyph}
        </span>
      </a>
    );
  }

  // File / output (or internal link with a handler): a static row + an
  // IconButton affordance that calls onOpen. When no handler is given the
  // affordance is disabled (nothing to route to yet).
  return (
    <div className="cdz-agent-step" style={rowStyle}>
      {body}
      <IconButton
        label={affordanceLabel}
        disabled={!canHandle}
        onClick={() => onOpen?.(artifact, index)}
        style={{ flex: '0 0 auto' }}
      >
        {affordanceGlyph}
      </IconButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel.
// ---------------------------------------------------------------------------
export function ArtifactsPanel({
  artifacts,
  onOpen,
  title,
  style,
}: {
  /** Artifacts collected during the run (order = chronological). */
  artifacts: AgentArtifact[];
  /**
   * Open/download an artifact. Called for files, outputs, and INTERNAL links.
   * External links open via a real anchor (target=_blank) regardless. When
   * omitted, file/output affordances are shown disabled and internal links
   * fall back to plain-anchor navigation.
   */
  onOpen?: (artifact: AgentArtifact, index: number) => void;
  /**
   * Header title override. When omitted it resolves from i18n
   * (`artifacts.title` — "Livrables" in FR, so the default is unchanged).
   */
  title?: string;
  style?: CSSProperties;
}) {
  ensureAgentKeyframes();
  // Language-aware copy (FR default). Subscribes the panel to the module-level
  // language so a toggle anywhere re-renders it.
  const { t, dir } = useAgentLang();
  const resolvedTitle = title ?? t('artifacts.title');

  const list = Array.isArray(artifacts) ? artifacts : [];
  const count = list.length;

  // Group by kind while preserving each item's original index (so onOpen gets
  // the true position in the run's artifact stream) and its chronological
  // order within the group.
  const groups = GROUP_ORDER.map(kind => ({
    kind,
    items: list
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a && a.kind === kind),
  })).filter(g => g.items.length > 0);

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: P.space.sm,
        padding: '8px 12px',
        borderBottom: `1px solid ${P.color.border}`,
        minHeight: 34,
        boxSizing: 'border-box',
      }}
    >
      <span
        style={{
          fontSize: P.font.size.sm,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: P.color.text,
        }}
      >
        {resolvedTitle}
      </span>
      {count > 0 ? (
        <Chip
          color={P.color.accent}
          bg={P.color.accentSoft}
          border={P.color.accentBorder}
        >
          {count}
        </Chip>
      ) : null}
    </div>
  );

  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    minWidth: 0,
    background: P.color.panel,
    border: `1px solid ${P.color.border}`,
    borderRadius: P.radius.lg,
    overflow: 'hidden',
    fontFamily: P.font.body,
    ...style,
  };

  if (count === 0) {
    return (
      <section aria-label={resolvedTitle} dir={dir} style={containerStyle}>
        {header}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            gap: 6,
            padding: '28px 18px',
            color: P.color.muted,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 22, opacity: 0.7 }}>
            🗂
          </span>
          <span style={{ fontSize: P.font.size.md, color: P.color.muted }}>
            {t('artifacts.empty.title')}
          </span>
          <span style={{ fontSize: P.font.size.sm, color: P.color.muted }}>
            {t('artifacts.empty.body')}
          </span>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={resolvedTitle} dir={dir} style={containerStyle}>
      {header}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: P.space.md,
          padding: P.space.md,
          overflowY: 'auto',
          minHeight: 0,
        }}
      >
        {groups.map(group => {
          const ui = KIND_UI[group.kind];
          return (
            <div
              key={group.kind}
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: P.font.size.xs,
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  color: P.color.muted,
                }}
              >
                <span aria-hidden="true" style={{ color: ui.color }}>
                  {ui.icon}
                </span>
                <span>{t(ui.groupLabelKey)}</span>
                <span style={{ opacity: 0.7 }}>({group.items.length})</span>
              </div>
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                {group.items.map(({ a, i }) => (
                  <ArtifactCard
                    key={i}
                    artifact={a}
                    index={i}
                    onOpen={onOpen}
                    t={t}
                    dir={dir}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
