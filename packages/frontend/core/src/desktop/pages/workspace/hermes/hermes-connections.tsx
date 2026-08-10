// ClickDz HERMES — tools & connections status panel.
//
// Renders the agent's live tool catalog grouped by kind (internal reads /
// Composio app actions / the built-in assistant), each marked available (green)
// or needs-setup (muted, with a hint), plus the planner readiness state. All
// data arrives via the `capabilities` prop (fetched by the page from
// GET /api/v1/hermes/capabilities) — this panel never fetches. When
// `capabilities` is null it shows a loading skeleton. Includes a "Manage
// integrations" affordance linking to /integrations, which is where Composio
// toolkits are connected. Self-contained, inline-styled, reduced-motion safe.
import type { CSSProperties } from 'react';

// ---------------------------------------------------------------------------
// Palette — local copy of the Hermes page `C` object (each an --affine-* var
// with a hard dark fallback) so this panel is boot-safe standalone.
// ---------------------------------------------------------------------------
const C = {
  bg: 'var(--affine-background-primary-color, #141414)',
  panel: 'var(--affine-background-secondary-color, #1c1c1e)',
  border: 'var(--affine-border-color, #2a2a2c)',
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  accentSoft:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  okText: 'var(--affine-success-color, #4cae4c)',
  okSoft: 'color-mix(in srgb, var(--affine-success-color, #4cae4c) 14%, transparent)',
} as const;

// Skeleton shimmer + reduced-motion opt-out (page-unique names).
const CONN_CSS = `
@keyframes cdz-hermesx-conn-shimmer{0%{opacity:0.4}50%{opacity:0.75}100%{opacity:0.4}}
.cdz-hermesx-skel{animation:cdz-hermesx-conn-shimmer 1.2s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){
  .cdz-hermesx-skel{animation:none !important;opacity:0.55}
}
`;

// Public prop shape — matches C5/C7 capabilities exactly.
interface Capability {
  slug: string;
  label: string;
  available: boolean;
}

export interface HermesCapabilities {
  tools: Capability[];
  plannerReady: boolean;
}

type Kind = 'internal' | 'composio' | 'make';

interface KindMeta {
  key: Kind;
  icon: string;
  title: string;
  blurb: string;
  // Hint shown on a tool in this group when it is unavailable.
  hint: string;
}

const KIND_META: Record<Kind, KindMeta> = {
  internal: {
    key: 'internal',
    icon: '🧾',
    title: 'Internal — your shops & data',
    blurb: 'Reads your ClickDz shops and ERP data. No setup required.',
    hint: 'unavailable right now',
  },
  composio: {
    key: 'composio',
    icon: '🔗',
    title: 'Composio — connected apps',
    blurb: 'Gmail, Sheets, Slack, Notion and more via Composio.',
    hint: 'connect in Integrations',
  },
  make: {
    key: 'make',
    icon: '🤖',
    title: 'Assistant — drafting & reasoning',
    blurb: 'Built-in helper for longer drafting and reasoning. Runs inside ClickDz — nothing to connect.',
    // NOT a merchant prerequisite: availability is server-side env config
    // (clickdz-hermes.controller.ts makeAvailable), so the merchant cannot act on
    // it and there is no Make surface on /integrations to act on it WITH. The old
    // hint ('needs Make API key & agent setup') sent them to a dead end.
    hint: 'temporarily unavailable',
  },
};

const KIND_ORDER: Kind[] = ['internal', 'composio', 'make'];

// Classify a tool by its slug, matching the real Hermes catalog:
//   shops_list / shop_erp_summary            → internal
//   composio_discover / composio_execute      → composio
//   make_agent_run                            → make
// Unknown future slugs fall back to internal so nothing is dropped.
function classify(slug: string): Kind {
  const s = slug.toLowerCase();
  if (s.startsWith('composio')) return 'composio';
  if (s.startsWith('make')) return 'make';
  return 'internal';
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
};

const headerTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 700,
  color: C.text,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const headerSubStyle: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 12.5,
  color: C.muted,
  lineHeight: 1.5,
  maxWidth: 460,
};

const manageLinkStyle: CSSProperties = {
  flexShrink: 0,
  appearance: 'none',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 36,
  padding: '6px 12px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 600,
  color: C.accent,
  background: C.accentSoft,
  border: `1px solid color-mix(in srgb, ${C.accent} 45%, transparent)`,
  whiteSpace: 'nowrap',
};

const groupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 14,
  borderRadius: 12,
  background: C.panel,
  border: `1px solid ${C.border}`,
};

const groupTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 700,
  color: C.text,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const groupBlurbStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: C.muted,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '8px 10px',
  borderRadius: 8,
  background: C.bg,
  border: `1px solid ${C.border}`,
};

const rowLeftStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};

const rowLabelStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: C.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const rowSlugStyle: CSSProperties = {
  fontSize: 10.5,
  color: C.muted,
  fontFamily: 'var(--affine-font-code-family, monospace)',
};

// A status pill: green dot + "Ready" when available, muted + hint otherwise.
const StatusPill = ({ available, hint }: { available: boolean; hint: string }) => (
  <span
    style={{
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 9px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 600,
      color: available ? C.okText : C.muted,
      background: available ? C.okSoft : 'transparent',
      border: `1px solid ${available ? 'color-mix(in srgb, ' + C.okText + ' 40%, transparent)' : C.border}`,
      whiteSpace: 'nowrap',
    }}
  >
    <span
      aria-hidden
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: available ? C.okText : C.muted,
      }}
    />
    {available ? 'Ready' : hint}
  </span>
);

// Loading skeleton shown while `capabilities` is null.
const Skeleton = () => (
  <div style={rootStyle}>
    <style>{CONN_CSS}</style>
    <div style={{ height: 20, width: 200, borderRadius: 6, background: C.panel }} className="cdz-hermesx-skel" />
    {[0, 1, 2].map(g => (
      <div key={g} style={groupStyle}>
        <div style={{ height: 14, width: 160, borderRadius: 5, background: C.bg }} className="cdz-hermesx-skel" />
        {[0, 1].map(r => (
          <div key={r} style={{ height: 40, borderRadius: 8, background: C.bg }} className="cdz-hermesx-skel" />
        ))}
      </div>
    ))}
  </div>
);

/**
 * HermesConnectionsPanel — tools & connections status. Pass the capabilities
 * object from GET /api/v1/hermes/capabilities; pass null to show a skeleton.
 */
export function HermesConnectionsPanel({
  capabilities,
}: {
  capabilities: HermesCapabilities | null;
}) {
  if (!capabilities) return <Skeleton />;

  const tools = Array.isArray(capabilities.tools) ? capabilities.tools : [];

  // Bucket tools by kind, preserving catalog order within each group.
  const groups: Record<Kind, Capability[]> = {
    internal: [],
    composio: [],
    make: [],
  };
  for (const t of tools) {
    if (!t || typeof t.slug !== 'string') continue;
    groups[classify(t.slug)].push(t);
  }

  const readyCount = tools.filter(t => t?.available).length;
  const plannerReady = !!capabilities.plannerReady;

  return (
    <div style={rootStyle}>
      <style>{CONN_CSS}</style>

      <div style={headerRowStyle}>
        <div style={{ minWidth: 0 }}>
          <h2 style={headerTitleStyle}>
            <span aria-hidden>🔌</span> Tools &amp; connections
          </h2>
          <p style={headerSubStyle}>
            {readyCount} of {tools.length} tool{tools.length === 1 ? '' : 's'} ready.
            Connect more apps to unlock the muted actions below.
          </p>
        </div>
        <a
          href="/integrations"
          style={manageLinkStyle}
          title="Open the Integrations page to connect apps"
        >
          Manage integrations →
        </a>
      </div>

      {/* Planner readiness — the agent brain must be configured to run at all. */}
      <div
        style={{
          ...rowStyle,
          background: plannerReady ? C.okSoft : C.panel,
          borderColor: plannerReady
            ? 'color-mix(in srgb, ' + C.okText + ' 40%, transparent)'
            : C.border,
        }}
      >
        <div style={rowLeftStyle}>
          <span style={rowLabelStyle}>
            <span aria-hidden style={{ marginRight: 6 }}>🧠</span>
            Planner
          </span>
          <span style={rowSlugStyle}>
            {plannerReady
              ? 'cdz-flash reasoning engine online'
              : 'planner key not configured — runs are unavailable'}
          </span>
        </div>
        <StatusPill available={plannerReady} hint="not configured" />
      </div>

      {KIND_ORDER.map(kind => {
        const meta = KIND_META[kind];
        const list = groups[kind];
        if (list.length === 0) return null;
        return (
          <section key={kind} style={groupStyle}>
            <h3 style={groupTitleStyle}>
              <span aria-hidden>{meta.icon}</span> {meta.title}
            </h3>
            <p style={groupBlurbStyle}>{meta.blurb}</p>
            {list.map(tool => (
              <div key={tool.slug} style={rowStyle}>
                <div style={rowLeftStyle}>
                  <span style={rowLabelStyle}>{tool.label || tool.slug}</span>
                  <span style={rowSlugStyle}>{tool.slug}</span>
                </div>
                <StatusPill available={!!tool.available} hint={meta.hint} />
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

export default HermesConnectionsPanel;
