import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useMemo,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// ClickDz Integrations — Flow canvas presentational bits (ZERO-DEP).
//
// This module carries the shared Flow types (mirrored from INTEG-BE / CONTRACT
// C2), the visual palette, and the presentational pieces used by flow-canvas:
//   • NodeCard  — an absolutely-positioned draggable card with in/out ports.
//   • NodePalette — the side strip that ADDS nodes (trigger/action/condition),
//     with the action picker sourced from the toolkits `catalog` prop.
//   • NodeInspector — a side panel to edit a selected node's toolkit / action /
//     config (a simple key→value editor) and delete it.
//
// Pure React + inline styles (no new .css.ts, no new deps). No fetching here —
// everything is driven by props from flow-canvas.tsx / FlowCanvas. Icons are
// inline SVG / emoji so the surface is boot-safe even before assets load.
// ---------------------------------------------------------------------------

// ---- Shared model (mirror INTEG-BE / CONTRACT C2) -------------------------

export type FlowNodeType = 'trigger' | 'action' | 'condition';

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  toolkit?: string;
  action?: string;
  config?: Record<string, unknown>;
  x: number;
  y: number;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
}

export interface Flow {
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  createdAt: number;
  updatedAt: number;
}

// The catalog shape FLOW-FE passes from the toolkits catalog. Permissive on
// purpose — we only rely on {slug,name,logo?,categories?}; anything else is
// carried through untouched.
export interface Toolkit {
  slug: string;
  name: string;
  logo?: string;
  categories?: string[];
  [key: string]: unknown;
}

// ---- Geometry constants (shared with flow-canvas for edge math) -----------

export const NODE_W = 210;
export const NODE_H = 76;
// Port centre offsets relative to the node's top-left corner.
export const PORT_OUT_DX = NODE_W;
export const PORT_OUT_DY = NODE_H / 2;
export const PORT_IN_DX = 0;
export const PORT_IN_DY = NODE_H / 2;

// ---- Palette (dark, app-consistent — same vars as integrations/index) -----

export const C = {
  bg: 'var(--affine-background-primary-color, #141414)',
  canvas: 'var(--affine-background-secondary-color, #17171a)',
  panel: 'var(--affine-background-primary-color, #1c1c1e)',
  border: 'var(--affine-border-color, #2a2a2c)',
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  accentSoft:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 16%, transparent)',
  danger: 'var(--affine-error-color, #eb4b4b)',
  dangerSoft: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 14%, transparent)',
  grid: 'color-mix(in srgb, var(--affine-border-color, #2a2a2c) 55%, transparent)',
} as const;

// Per-type accent + glyph so the three node kinds read at a glance.
export const NODE_KINDS: Record<
  FlowNodeType,
  { label: string; color: string; glyph: string }
> = {
  trigger: { label: 'Trigger', color: '#e8a33d', glyph: '⚡' },
  action: { label: 'Action', color: '#1e96eb', glyph: '▶' },
  condition: { label: 'Condition', color: '#a06de8', glyph: '◆' },
};

// ---- Small inline-SVG glyphs (boot-safe, no asset deps) -------------------

export function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 4h10M6.5 4V2.8h3V4M4.5 4l.6 8.4a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8L11.5 4"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// NodeCard — an absolutely-positioned node with a header (drag handle), a
// summary line, and input/output ports. All interaction is delegated up to
// FlowCanvas via the callbacks; this component holds no drag state itself.
// ---------------------------------------------------------------------------

export interface NodeCardProps {
  node: FlowNode;
  toolkit?: Toolkit;
  selected: boolean;
  readOnly?: boolean;
  reducedMotion?: boolean;
  // Drag: pointer-down on the card body (header) starts a node drag.
  onNodePointerDown?: (e: ReactPointerEvent<HTMLDivElement>, node: FlowNode) => void;
  // Edge draw: pointer-down on the OUTPUT port starts a pending edge.
  onOutPointerDown?: (e: ReactPointerEvent<HTMLDivElement>, node: FlowNode) => void;
  // Edge draw: pointer-up on the INPUT port completes a pending edge.
  onInPointerUp?: (e: ReactPointerEvent<HTMLDivElement>, node: FlowNode) => void;
  onSelect?: (node: FlowNode) => void;
}

export function NodeCard({
  node,
  toolkit,
  selected,
  readOnly,
  reducedMotion,
  onNodePointerDown,
  onOutPointerDown,
  onInPointerUp,
  onSelect,
}: NodeCardProps) {
  const kind = NODE_KINDS[node.type];
  const [outHot, setOutHot] = useState(false);
  const [inHot, setInHot] = useState(false);

  // Secondary line: what this node will actually do.
  const subtitle = useMemo(() => {
    if (node.type === 'trigger') {
      return node.action ? node.action : 'manual';
    }
    if (node.type === 'condition') {
      return node.config && Object.keys(node.config).length
        ? Object.keys(node.config)
            .map(k => `${k}=${String((node.config as any)[k])}`)
            .join(' · ')
        : 'no rule';
    }
    // action
    if (node.action) return node.action;
    if (node.toolkit) return `${node.toolkit} · pick action`;
    return 'pick a toolkit';
  }, [node]);

  const cardStyle: CSSProperties = {
    position: 'absolute',
    left: node.x,
    top: node.y,
    width: NODE_W,
    minHeight: NODE_H,
    boxSizing: 'border-box',
    borderRadius: 12,
    background: C.panel,
    border: `1px solid ${selected ? C.accent : C.border}`,
    boxShadow: selected
      ? `0 0 0 1px ${C.accent}, 0 8px 24px rgba(0,0,0,0.35)`
      : '0 2px 10px rgba(0,0,0,0.25)',
    color: C.text,
    userSelect: 'none',
    touchAction: 'none',
    cursor: readOnly ? 'default' : 'grab',
    transition: reducedMotion
      ? 'none'
      : 'border-color 150ms ease, box-shadow 150ms ease',
  };

  const portBase: CSSProperties = {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 999,
    top: PORT_OUT_DY - 7,
    background: C.panel,
    border: `2px solid ${kind.color}`,
    boxSizing: 'border-box',
    touchAction: 'none',
  };

  return (
    <div
      data-node-id={node.id}
      style={cardStyle}
      onPointerDown={e => {
        if (readOnly) return;
        onNodePointerDown?.(e, node);
      }}
      onClick={e => {
        e.stopPropagation();
        onSelect?.(node);
      }}
    >
      {/* Header / drag handle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px 4px',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            borderRadius: 6,
            fontSize: 12,
            color: '#fff',
            background: kind.color,
          }}
        >
          {toolkit?.logo ? (
            <img
              src={toolkit.logo}
              alt=""
              width={14}
              height={14}
              style={{ borderRadius: 3, objectFit: 'contain' }}
            />
          ) : (
            kind.glyph
          )}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
            color: kind.color,
          }}
        >
          {toolkit?.name ?? kind.label}
        </span>
      </div>

      {/* Body summary */}
      <div
        style={{
          padding: '0 12px 10px',
          fontSize: 12,
          color: C.muted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={subtitle}
      >
        {subtitle}
      </div>

      {/* Input port (left) — triggers have no input */}
      {node.type !== 'trigger' ? (
        <div
          data-port="in"
          title="Input"
          onPointerUp={e => {
            if (readOnly) return;
            onInPointerUp?.(e, node);
          }}
          onPointerEnter={() => !readOnly && setInHot(true)}
          onPointerLeave={() => setInHot(false)}
          style={{
            ...portBase,
            left: PORT_IN_DX - 7,
            background: inHot ? kind.color : C.panel,
            cursor: readOnly ? 'default' : 'crosshair',
          }}
        />
      ) : null}

      {/* Output port (right) — conditions/actions/triggers all emit */}
      <div
        data-port="out"
        title="Drag to connect"
        onPointerDown={e => {
          if (readOnly) return;
          e.stopPropagation();
          onOutPointerDown?.(e, node);
        }}
        onPointerEnter={() => !readOnly && setOutHot(true)}
        onPointerLeave={() => setOutHot(false)}
        style={{
          ...portBase,
          left: PORT_OUT_DX - 7,
          background: outHot ? kind.color : C.panel,
          cursor: readOnly ? 'default' : 'crosshair',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// NodePalette — side strip to ADD nodes. Trigger + Condition are one-click.
// Action opens a toolkit picker sourced from `catalog`; picking a toolkit then
// lets the user name the Composio action slug before the node is created.
// ---------------------------------------------------------------------------

export interface NodePaletteProps {
  catalog: Toolkit[];
  readOnly?: boolean;
  onAdd: (spec: {
    type: FlowNodeType;
    toolkit?: string;
    action?: string;
  }) => void;
}

const paletteBtn: CSSProperties = {
  appearance: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 600,
  textAlign: 'left',
  cursor: 'pointer',
  color: C.text,
  background: 'transparent',
  border: `1px solid ${C.border}`,
};

export function NodePalette({ catalog, readOnly, onAdd }: NodePaletteProps) {
  const [mode, setMode] = useState<'root' | 'toolkit' | 'action'>('root');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Toolkit | null>(null);
  const [actionName, setActionName] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = Array.isArray(catalog) ? catalog : [];
    if (!q) return list.slice(0, 60);
    return list
      .filter(
        t =>
          t.slug?.toLowerCase().includes(q) ||
          t.name?.toLowerCase().includes(q)
      )
      .slice(0, 60);
  }, [catalog, query]);

  const reset = () => {
    setMode('root');
    setQuery('');
    setPicked(null);
    setActionName('');
  };

  if (readOnly) return null;

  return (
    <div
      data-cdz-panel=""
      style={{
        width: 220,
        maxWidth: '100%',
        flex: '0 0 220px',
        boxSizing: 'border-box',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: C.panel,
        borderRight: `1px solid ${C.border}`,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          color: C.muted,
        }}
      >
        Add node
      </div>

      {mode === 'root' ? (
        <>
          <button
            type="button"
            style={{ ...paletteBtn, borderColor: NODE_KINDS.trigger.color }}
            onClick={() => onAdd({ type: 'trigger', action: 'manual' })}
          >
            <span aria-hidden="true">{NODE_KINDS.trigger.glyph}</span> Trigger ·
            manual
          </button>
          <button
            type="button"
            style={{ ...paletteBtn, borderColor: NODE_KINDS.trigger.color }}
            onClick={() => onAdd({ type: 'trigger', action: 'webhook' })}
          >
            <span aria-hidden="true">{NODE_KINDS.trigger.glyph}</span> Trigger ·
            webhook
          </button>
          <button
            type="button"
            style={{ ...paletteBtn, borderColor: NODE_KINDS.action.color }}
            onClick={() => setMode('toolkit')}
          >
            <span aria-hidden="true">{NODE_KINDS.action.glyph}</span> Action…
          </button>
          <button
            type="button"
            style={{ ...paletteBtn, borderColor: NODE_KINDS.condition.color }}
            onClick={() => onAdd({ type: 'condition' })}
          >
            <span aria-hidden="true">{NODE_KINDS.condition.glyph}</span>{' '}
            Condition
          </button>
        </>
      ) : null}

      {mode === 'toolkit' ? (
        <>
          <input
            autoFocus
            value={query}
            placeholder="Search toolkits…"
            onChange={e => setQuery(e.target.value)}
            style={{
              boxSizing: 'border-box',
              width: '100%',
              padding: '7px 10px',
              borderRadius: 8,
              fontSize: 12,
              color: C.text,
              background: C.bg,
              border: `1px solid ${C.border}`,
              outline: 'none',
            }}
          />
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              maxHeight: 320,
              overflowY: 'auto',
            }}
          >
            {filtered.length === 0 ? (
              <div style={{ fontSize: 12, color: C.muted, padding: '6px 2px' }}>
                No toolkits match.
              </div>
            ) : (
              filtered.map(t => (
                <button
                  key={t.slug}
                  type="button"
                  style={{ ...paletteBtn }}
                  onClick={() => {
                    setPicked(t);
                    setMode('action');
                  }}
                >
                  {t.logo ? (
                    <img
                      src={t.logo}
                      alt=""
                      width={16}
                      height={16}
                      style={{ borderRadius: 3, objectFit: 'contain' }}
                    />
                  ) : (
                    <span aria-hidden="true">🧩</span>
                  )}
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t.name ?? t.slug}
                  </span>
                </button>
              ))
            )}
          </div>
          <button
            type="button"
            style={{ ...paletteBtn, borderColor: C.border, color: C.muted }}
            onClick={reset}
          >
            ← Back
          </button>
        </>
      ) : null}

      {mode === 'action' && picked ? (
        <>
          <div style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>
            {picked.name ?? picked.slug}
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>
            Composio action slug (e.g. {picked.slug.toUpperCase()}_SEND):
          </div>
          <input
            autoFocus
            value={actionName}
            placeholder="ACTION_SLUG"
            onChange={e => setActionName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && actionName.trim()) {
                onAdd({
                  type: 'action',
                  toolkit: picked.slug,
                  action: actionName.trim(),
                });
                reset();
              }
            }}
            style={{
              boxSizing: 'border-box',
              width: '100%',
              padding: '7px 10px',
              borderRadius: 8,
              fontSize: 12,
              fontFamily: 'monospace',
              color: C.text,
              background: C.bg,
              border: `1px solid ${C.border}`,
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={{
                ...paletteBtn,
                justifyContent: 'center',
                color: '#fff',
                background: C.accent,
                borderColor: C.accent,
              }}
              onClick={() => {
                onAdd({
                  type: 'action',
                  toolkit: picked.slug,
                  action: actionName.trim() || undefined,
                });
                reset();
              }}
            >
              Add
            </button>
            <button
              type="button"
              style={{
                ...paletteBtn,
                justifyContent: 'center',
                color: C.muted,
              }}
              onClick={() => setMode('toolkit')}
            >
              ←
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NodeInspector — edit a selected node's toolkit / action / config. The config
// editor is a plain add/remove key→value list (string values), plus delete.
// ---------------------------------------------------------------------------

export interface NodeInspectorProps {
  node: FlowNode;
  catalog: Toolkit[];
  readOnly?: boolean;
  onPatch: (patch: Partial<FlowNode>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const fieldLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
  color: C.muted,
};

const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  padding: '7px 10px',
  borderRadius: 8,
  fontSize: 12,
  color: C.text,
  background: C.bg,
  border: `1px solid ${C.border}`,
  outline: 'none',
};

export function NodeInspector({
  node,
  catalog,
  readOnly,
  onPatch,
  onDelete,
  onClose,
}: NodeInspectorProps) {
  const kind = NODE_KINDS[node.type];
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const entries = Object.entries(node.config ?? {});

  const setConfig = (next: Record<string, unknown>) =>
    onPatch({ config: next });

  return (
    <div
      data-cdz-panel=""
      style={{
        width: 260,
        maxWidth: '100%',
        flex: '0 0 260px',
        boxSizing: 'border-box',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        background: C.panel,
        borderLeft: `1px solid ${C.border}`,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            color: kind.color,
          }}
        >
          {kind.glyph} {kind.label}
        </span>
        <button
          type="button"
          aria-label="Close inspector"
          onClick={onClose}
          style={{
            appearance: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 32,
            minHeight: 32,
            padding: 4,
            borderRadius: 6,
            cursor: 'pointer',
            color: C.muted,
            background: 'transparent',
            border: `1px solid ${C.border}`,
          }}
        >
          <CloseIcon />
        </button>
      </div>

      {/* Toolkit + action for action nodes; action slug for trigger/condition */}
      {node.type === 'action' ? (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={fieldLabel}>Toolkit</span>
          <select
            disabled={readOnly}
            value={node.toolkit ?? ''}
            onChange={e => onPatch({ toolkit: e.target.value || undefined })}
            style={inputStyle}
          >
            <option value="">— select —</option>
            {(Array.isArray(catalog) ? catalog : []).map(t => (
              <option key={t.slug} value={t.slug}>
                {t.name ?? t.slug}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {node.type !== 'condition' ? (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={fieldLabel}>
            {node.type === 'trigger' ? 'Trigger' : 'Action slug'}
          </span>
          <input
            disabled={readOnly}
            value={node.action ?? ''}
            placeholder={node.type === 'trigger' ? 'manual / webhook' : 'ACTION_SLUG'}
            onChange={e => onPatch({ action: e.target.value || undefined })}
            style={{ ...inputStyle, fontFamily: 'monospace' }}
          />
        </label>
      ) : null}

      {/* Config key→value editor (also used as the condition rule store) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={fieldLabel}>
          {node.type === 'condition' ? 'Rule' : 'Config'}
        </span>
        {entries.length === 0 ? (
          <div style={{ fontSize: 12, color: C.muted }}>No fields.</div>
        ) : (
          entries.map(([k, v]) => (
            <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                readOnly
                value={k}
                style={{ ...inputStyle, flex: '0 0 40%', color: C.muted }}
              />
              <input
                disabled={readOnly}
                value={String(v ?? '')}
                onChange={e =>
                  setConfig({ ...(node.config ?? {}), [k]: e.target.value })
                }
                style={{ ...inputStyle, flex: 1 }}
              />
              {!readOnly ? (
                <button
                  type="button"
                  aria-label={`Remove ${k}`}
                  onClick={() => {
                    const next = { ...(node.config ?? {}) };
                    delete next[k];
                    setConfig(next);
                  }}
                  style={{
                    appearance: 'none',
                    display: 'inline-flex',
                    padding: 5,
                    borderRadius: 6,
                    cursor: 'pointer',
                    color: C.muted,
                    background: 'transparent',
                    border: `1px solid ${C.border}`,
                  }}
                >
                  <TrashIcon size={12} />
                </button>
              ) : null}
            </div>
          ))
        )}

        {!readOnly ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              value={newKey}
              placeholder="key"
              onChange={e => setNewKey(e.target.value)}
              style={{ ...inputStyle, flex: '0 0 40%' }}
            />
            <input
              value={newVal}
              placeholder="value"
              onChange={e => setNewVal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newKey.trim()) {
                  setConfig({ ...(node.config ?? {}), [newKey.trim()]: newVal });
                  setNewKey('');
                  setNewVal('');
                }
              }}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              type="button"
              aria-label="Add field"
              disabled={!newKey.trim()}
              onClick={() => {
                setConfig({ ...(node.config ?? {}), [newKey.trim()]: newVal });
                setNewKey('');
                setNewVal('');
              }}
              style={{
                appearance: 'none',
                display: 'inline-flex',
                padding: 5,
                borderRadius: 6,
                cursor: newKey.trim() ? 'pointer' : 'not-allowed',
                color: C.text,
                background: 'transparent',
                border: `1px solid ${C.border}`,
                opacity: newKey.trim() ? 1 : 0.5,
              }}
            >
              <PlusIcon size={12} />
            </button>
          </div>
        ) : null}
      </div>

      <div style={{ flex: 1 }} />

      {!readOnly ? (
        <button
          type="button"
          onClick={() => onDelete(node.id)}
          style={{
            appearance: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '8px 10px',
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            color: C.danger,
            background: C.dangerSoft,
            border: `1px solid ${C.danger}`,
          }}
        >
          <TrashIcon /> Delete node
        </button>
      ) : null}
    </div>
  );
}
