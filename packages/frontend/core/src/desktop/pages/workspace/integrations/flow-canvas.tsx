import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  C,
  type Flow,
  type FlowEdge,
  type FlowNode,
  type FlowNodeType,
  NodeCard,
  NodeInspector,
  NodePalette,
  NODE_H,
  NODE_W,
  PORT_IN_DX,
  PORT_IN_DY,
  PORT_OUT_DX,
  PORT_OUT_DY,
  type Toolkit,
} from './flow-nodes';

// ---------------------------------------------------------------------------
// ClickDz Integrations — Flow canvas (ZERO-DEP).
//
// A pure React + SVG + native pointer-events visual flow editor. NO react-flow,
// NO dnd — the drag idiom is ported from the repo's own vdz timeline-lanes.tsx
// (setPointerCapture on pointer-down; a DragState in a ref; commit on
// pointer-up). Edges are SVG cubic-bezier <path>s. NOTHING is fetched here —
// FlowCanvas is a controlled component: it takes `flow` + `catalog` and reports
// every change through `onChange(flow)` (the full C2 Flow shape).
//
// EXACT exported signature (FLOW-FE mounts this verbatim):
//   export function FlowCanvas({ flow, catalog, onChange, readOnly }: {
//     flow: Flow; catalog: Toolkit[]; onChange: (flow: Flow) => void;
//     readOnly?: boolean;
//   })
// ---------------------------------------------------------------------------

// Boot-safe id: crypto.randomUUID where available, else a cheap fallback so the
// canvas never throws in an environment without it.
function newId(prefix: string): string {
  try {
    const c = (globalThis as any).crypto;
    if (c && typeof c.randomUUID === 'function') return `${prefix}_${c.randomUUID()}`;
  } catch {
    /* fall through */
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

// Node-drag state (mirrors timeline-lanes' DragState idiom). Held in a ref so
// pointer-move never re-renders the whole canvas — only the moving node's
// live position (`ghost`) is committed to React state per frame.
interface NodeDrag {
  pointerId: number;
  nodeId: string;
  startClientX: number;
  startClientY: number;
  origX: number;
  origY: number;
}

// Pending-edge state while dragging from an output port to an input port.
interface PendingEdge {
  pointerId: number;
  fromId: string;
  // Live cursor position in canvas-content coordinates.
  cursorX: number;
  cursorY: number;
}

// Port centres in canvas-content coordinates (accounts for scroll via the
// content element, not the viewport).
function outPort(n: FlowNode) {
  return { x: n.x + PORT_OUT_DX, y: n.y + PORT_OUT_DY };
}
function inPort(n: FlowNode) {
  return { x: n.x + PORT_IN_DX, y: n.y + PORT_IN_DY };
}

// Horizontal cubic bezier between two points (left→right flow).
function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const k = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + k} ${y1}, ${x2 - k} ${y2}, ${x2} ${y2}`;
}

const usePrefersReducedMotion = () => {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    if (!mq) return;
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    // addEventListener is the modern form; guard for older Safari.
    if (mq.addEventListener) mq.addEventListener('change', on);
    else mq.addListener(on);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', on);
      else mq.removeListener(on);
    };
  }, []);
  return reduced;
};

export function FlowCanvas({
  flow,
  catalog,
  onChange,
  readOnly,
}: {
  flow: Flow;
  catalog: Toolkit[];
  onChange: (flow: Flow) => void;
  readOnly?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();

  // The scrollable content plane; all pointer coords are mapped into its space
  // so scroll offset never skews node/edge geometry.
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Drag state lives in refs (stable handlers, no per-frame churn beyond the
  // one moved node). `liveNodes` mirrors flow.nodes but lets us paint the
  // dragged node's new position without committing to the parent every frame.
  const nodeDragRef = useRef<NodeDrag | null>(null);
  const [liveNodes, setLiveNodes] = useState<FlowNode[]>(flow.nodes);
  const draggingRef = useRef(false);

  const [pending, setPending] = useState<PendingEdge | null>(null);
  const pendingRef = useRef<PendingEdge | null>(null);
  pendingRef.current = pending;

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Keep local node positions in sync when the parent hands us a new flow —
  // but never stomp positions mid-drag (that would fight the pointer).
  useEffect(() => {
    if (!draggingRef.current) setLiveNodes(flow.nodes);
  }, [flow.nodes]);

  const selectedNode = useMemo(
    () => liveNodes.find(n => n.id === selectedId) ?? null,
    [liveNodes, selectedId]
  );
  const toolkitBySlug = useMemo(() => {
    const m = new Map<string, Toolkit>();
    for (const t of Array.isArray(catalog) ? catalog : []) m.set(t.slug, t);
    return m;
  }, [catalog]);

  // Map a pointer event to canvas-content coordinates (includes scroll).
  const toContent = useCallback((clientX: number, clientY: number) => {
    const el = contentRef.current;
    if (!el) return { x: clientX, y: clientY };
    const rect = el.getBoundingClientRect();
    return {
      x: clientX - rect.left + el.scrollLeft,
      y: clientY - rect.top + el.scrollTop,
    };
  }, []);

  // Commit a fresh Flow to the parent (bumps updatedAt).
  const commit = useCallback(
    (nodes: FlowNode[], edges: FlowEdge[]) => {
      onChange({ ...flow, nodes, edges, updatedAt: Date.now() });
    },
    [flow, onChange]
  );

  // ---- Node drag (ported timeline-lanes setPointerCapture idiom) ----------

  const onNodePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, node: FlowNode) => {
      if (readOnly) return;
      if (event.button !== 0) return; // left button only
      event.currentTarget.setPointerCapture(event.pointerId);
      event.stopPropagation();
      nodeDragRef.current = {
        pointerId: event.pointerId,
        nodeId: node.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        origX: node.x,
        origY: node.y,
      };
      draggingRef.current = true;
      setSelectedId(node.id);
    },
    [readOnly]
  );

  // Output-port pointer-down → begin drawing an edge.
  const onOutPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, node: FlowNode) => {
      if (readOnly) return;
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.stopPropagation();
      const p = toContent(event.clientX, event.clientY);
      const pe: PendingEdge = {
        pointerId: event.pointerId,
        fromId: node.id,
        cursorX: p.x,
        cursorY: p.y,
      };
      pendingRef.current = pe;
      draggingRef.current = true;
      setPending(pe);
    },
    [readOnly, toContent]
  );

  // Single move handler on the content plane services BOTH node-drag and
  // edge-draw (only one is ever active). setPointerCapture on the origin
  // element guarantees these fire even when the pointer leaves it.
  const onContentPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const nd = nodeDragRef.current;
      if (nd && event.pointerId === nd.pointerId) {
        const dx = event.clientX - nd.startClientX;
        const dy = event.clientY - nd.startClientY;
        const nx = Math.max(0, nd.origX + dx);
        const ny = Math.max(0, nd.origY + dy);
        setLiveNodes(prev =>
          prev.map(n => (n.id === nd.nodeId ? { ...n, x: nx, y: ny } : n))
        );
        return;
      }
      const pe = pendingRef.current;
      if (pe && event.pointerId === pe.pointerId) {
        const p = toContent(event.clientX, event.clientY);
        const next = { ...pe, cursorX: p.x, cursorY: p.y };
        pendingRef.current = next;
        setPending(next);
      }
    },
    [toContent]
  );

  // Finish either interaction on pointer-up (commit node position; drop a
  // pending edge if it landed on an input port).
  const finishNodeDrag = useCallback(() => {
    const nd = nodeDragRef.current;
    if (!nd) return;
    nodeDragRef.current = null;
    draggingRef.current = false;
    const moved = liveNodes.find(n => n.id === nd.nodeId);
    if (!moved) return;
    if (moved.x === nd.origX && moved.y === nd.origY) return; // no-op
    commit(liveNodes, flow.edges);
  }, [liveNodes, flow.edges, commit]);

  const finishPendingEdge = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pe = pendingRef.current;
      if (!pe) return;
      pendingRef.current = null;
      draggingRef.current = false;
      setPending(null);

      // Hit-test the drop target: find an input port under the pointer.
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const portEl = el?.closest?.('[data-port="in"]') as HTMLElement | null;
      const host = portEl?.closest?.('[data-node-id]') as HTMLElement | null;
      const toId = host?.getAttribute('data-node-id') ?? null;

      if (!toId || toId === pe.fromId) return; // no self-loops / missed drop
      // De-dupe: don't add an identical edge twice.
      if (flow.edges.some(e => e.from === pe.fromId && e.to === toId)) return;
      const edge: FlowEdge = { id: newId('edge'), from: pe.fromId, to: toId };
      commit(liveNodes, [...flow.edges, edge]);
    },
    [flow.edges, liveNodes, commit]
  );

  const onContentPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (nodeDragRef.current) finishNodeDrag();
      if (pendingRef.current) finishPendingEdge(event);
    },
    [finishNodeDrag, finishPendingEdge]
  );

  // ---- Add / patch / delete nodes; delete edges ---------------------------

  const addNode = useCallback(
    (spec: { type: FlowNodeType; toolkit?: string; action?: string }) => {
      if (readOnly) return;
      // Drop at a sensible spot: staggered, biased into the visible scroll area.
      const el = contentRef.current;
      const baseX = (el?.scrollLeft ?? 0) + 60;
      const baseY = (el?.scrollTop ?? 0) + 60;
      const stagger = liveNodes.length % 6;
      const node: FlowNode = {
        id: newId('node'),
        type: spec.type,
        toolkit: spec.toolkit,
        action: spec.action,
        config: {},
        x: baseX + stagger * 28,
        y: baseY + stagger * 24,
      };
      const nodes = [...liveNodes, node];
      setLiveNodes(nodes);
      setSelectedId(node.id);
      commit(nodes, flow.edges);
    },
    [readOnly, liveNodes, flow.edges, commit]
  );

  const patchNode = useCallback(
    (id: string, patch: Partial<FlowNode>) => {
      if (readOnly) return;
      const nodes = liveNodes.map(n => (n.id === id ? { ...n, ...patch } : n));
      setLiveNodes(nodes);
      commit(nodes, flow.edges);
    },
    [readOnly, liveNodes, flow.edges, commit]
  );

  const deleteNode = useCallback(
    (id: string) => {
      if (readOnly) return;
      const nodes = liveNodes.filter(n => n.id !== id);
      const edges = flow.edges.filter(e => e.from !== id && e.to !== id);
      setLiveNodes(nodes);
      if (selectedId === id) setSelectedId(null);
      commit(nodes, edges);
    },
    [readOnly, liveNodes, flow.edges, selectedId, commit]
  );

  const deleteEdge = useCallback(
    (id: string) => {
      if (readOnly) return;
      commit(liveNodes, flow.edges.filter(e => e.id !== id));
    },
    [readOnly, liveNodes, flow.edges, commit]
  );

  // ---- Geometry for the SVG layer -----------------------------------------

  const nodeById = useMemo(() => {
    const m = new Map<string, FlowNode>();
    for (const n of liveNodes) m.set(n.id, n);
    return m;
  }, [liveNodes]);

  // Size the content plane to fit all nodes plus headroom, so it stays
  // scroll/pannable as the graph grows.
  const extent = useMemo(() => {
    let w = 1200;
    let h = 700;
    for (const n of liveNodes) {
      w = Math.max(w, n.x + NODE_W + 240);
      h = Math.max(h, n.y + NODE_H + 240);
    }
    return { w, h };
  }, [liveNodes]);

  const edgePaths = useMemo(() => {
    return flow.edges
      .map(e => {
        const from = nodeById.get(e.from);
        const to = nodeById.get(e.to);
        if (!from || !to) return null;
        const a = outPort(from);
        const b = inPort(to);
        return { id: e.id, d: bezier(a.x, a.y, b.x, b.y) };
      })
      .filter(Boolean) as { id: string; d: string }[];
  }, [flow.edges, nodeById]);

  const pendingPath = useMemo(() => {
    if (!pending) return null;
    const from = nodeById.get(pending.fromId);
    if (!from) return null;
    const a = outPort(from);
    return bezier(a.x, a.y, pending.cursorX, pending.cursorY);
  }, [pending, nodeById]);

  // ---- Render --------------------------------------------------------------

  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        minHeight: 480,
        background: C.bg,
        color: C.text,
        borderRadius: 12,
        border: `1px solid ${C.border}`,
        overflow: 'hidden',
      }}
    >
      {/* Palette (hidden in readOnly) */}
      <NodePalette catalog={catalog} readOnly={readOnly} onAdd={addNode} />

      {/* Scrollable canvas surface */}
      <div
        ref={contentRef}
        onPointerMove={onContentPointerMove}
        onPointerUp={onContentPointerUp}
        onPointerCancel={onContentPointerUp}
        onClick={() => setSelectedId(null)}
        style={{
          position: 'relative',
          flex: 1,
          overflow: 'auto',
          background: C.canvas,
          // Grid background (optional, subtle). CSS gradient — zero-dep.
          backgroundImage: `linear-gradient(${C.grid} 1px, transparent 1px), linear-gradient(90deg, ${C.grid} 1px, transparent 1px)`,
          backgroundSize: '24px 24px',
          cursor: pending ? 'crosshair' : 'default',
          touchAction: 'none',
        }}
      >
        {/* The sized content plane that scrolls as one. */}
        <div
          style={{
            position: 'relative',
            width: extent.w,
            height: extent.h,
          }}
        >
          {/* Edge layer behind nodes. pointerEvents:none on the svg, but each
              path re-enables them so edges are clickable to delete. */}
          <svg
            width={extent.w}
            height={extent.h}
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              overflow: 'visible',
            }}
          >
            <defs>
              <marker
                id="cdz-flow-arrow"
                viewBox="0 0 10 10"
                refX={8}
                refY={5}
                markerWidth={7}
                markerHeight={7}
                orient="auto-start-reverse"
              >
                <path d="M0 0 L10 5 L0 10 z" fill={C.accent} />
              </marker>
            </defs>

            {edgePaths.map(p => (
              <g key={p.id}>
                {/* Wide invisible hit-path for easy clicking. */}
                <path
                  d={p.d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  style={{ pointerEvents: readOnly ? 'none' : 'stroke', cursor: 'pointer' }}
                  onClick={e => {
                    e.stopPropagation();
                    deleteEdge(p.id);
                  }}
                >
                  {!readOnly ? <title>Click to delete</title> : null}
                </path>
                {/* Visible edge. */}
                <path
                  d={p.d}
                  fill="none"
                  stroke={C.accent}
                  strokeWidth={2}
                  markerEnd="url(#cdz-flow-arrow)"
                  style={{ pointerEvents: 'none' }}
                />
              </g>
            ))}

            {/* Live pending edge while dragging from a port. */}
            {pendingPath ? (
              <path
                d={pendingPath}
                fill="none"
                stroke={C.accent}
                strokeWidth={2}
                strokeDasharray="5 5"
                style={{ pointerEvents: 'none' }}
              />
            ) : null}
          </svg>

          {/* Node cards */}
          {liveNodes.map(n => (
            <NodeCard
              key={n.id}
              node={n}
              toolkit={n.toolkit ? toolkitBySlug.get(n.toolkit) : undefined}
              selected={n.id === selectedId}
              readOnly={readOnly}
              reducedMotion={reducedMotion}
              onNodePointerDown={onNodePointerDown}
              onOutPointerDown={onOutPointerDown}
              onInPointerUp={() => {
                /* drop handled centrally via elementFromPoint on pointer-up */
              }}
              onSelect={node => setSelectedId(node.id)}
            />
          ))}

          {/* Empty state */}
          {liveNodes.length === 0 ? (
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 80,
                textAlign: 'center',
                color: C.muted,
                fontSize: 13,
                pointerEvents: 'none',
              }}
            >
              {readOnly
                ? 'This flow has no nodes.'
                : 'Add a node from the palette to start building your flow.'}
            </div>
          ) : null}
        </div>
      </div>

      {/* Inspector for the selected node */}
      {selectedNode ? (
        <NodeInspector
          node={selectedNode}
          catalog={catalog}
          readOnly={readOnly}
          onPatch={patch => patchNode(selectedNode.id, patch)}
          onDelete={deleteNode}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}

// Re-export the shared model so FLOW-FE can import types from a single module.
export type { Flow, FlowEdge, FlowNode, FlowNodeType, Toolkit } from './flow-nodes';
