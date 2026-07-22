import { PagedList } from '@affine/core/clickdz/paged-list';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  Banner,
  C,
  EmptyNote,
  type ErpOrder,
  fetchErpCollection,
  fmtDZD,
  linkBtnStyle,
  miniBtnStyle,
  NEXT_STATUS,
  ORDER_STATUSES,
  orderDate,
  type OrderStatus,
  orderTotal,
  Panel,
  postOrderStatus,
  Spinner,
  STATUS_COLORS,
  StatusBadge,
  statusTargets,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// Orders admin — the full pipeline manager. Reads ALL orders straight from the
// public per-slug data API (reads need no token), advances statuses through
// the authed bridge route POST /api/v1/apps/:slug/erp/order-status {ref,status}
// (the backend replaces the record — delete + recreate keyed on `ref`).
// Status stepper follows the templates exactly:
//   Nouvelle → Confirmée → Expédiée → Livrée, with Retournée as the return
//   branch from any non-final state (including Livrée).
// Optimistic UI: the row flips immediately, rolls back on failure, and the
// list + parent KPIs re-fetch after every successful replace.
// ---------------------------------------------------------------------------

const chipStyle = (active: boolean, color?: string): CSSProperties => ({
  appearance: 'none',
  cursor: 'pointer',
  borderRadius: 999,
  padding: '4px 11px',
  fontSize: 12,
  fontWeight: 700,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: `1px solid ${active ? (color ?? C.accent) : C.border}`,
  color: active ? (color ?? C.accent) : C.muted,
  background: active
    ? `color-mix(in srgb, ${color ?? C.accent} 12%, transparent)`
    : 'transparent',
  transition: 'color 160ms ease, border-color 160ms ease, background 160ms ease',
});

export const OrdersAdmin = ({
  slug,
  currency,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  slug: string;
  currency: string;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated: () => void;
}) => {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [orders, setOrders] = useState<ErpOrder[]>([]);
  const [filter, setFilter] = useState<'all' | OrderStatus>('all');
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error';
    text: string;
  } | null>(null);

  const load = useCallback(
    async (soft = false) => {
      if (!soft) setPhase('loading');
      try {
        const rows = await fetchErpCollection<ErpOrder>(slug, 'orders');
        // Replace = delete+recreate, so dedupe on the business key (ref) and
        // keep the newest copy; sort by stable business date, newest first.
        const byRef = new Map<string, ErpOrder>();
        for (const o of rows) {
          const key = String(o?.ref || o?.id || '');
          if (!key) continue;
          const prev = byRef.get(key);
          if (
            !prev ||
            String(o.createdAt || '') > String(prev.createdAt || '')
          ) {
            byRef.set(key, o);
          }
        }
        const list = [...byRef.values()].sort(
          (a, b) =>
            orderDate(b).localeCompare(orderDate(a)) ||
            String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
        );
        setOrders(list);
        setPhase('ready');
      } catch {
        if (!soft) setPhase('error');
      }
    },
    [slug]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const advance = useCallback(
    async (order: ErpOrder, to: OrderStatus) => {
      const ref = String(order.ref || '');
      if (!ref || readOnly || busyRef) return;
      const prev = order.status;
      setBusyRef(ref);
      setNotice(null);
      // Optimistic: flip the row now, roll back if the replace fails.
      setOrders(list =>
        list.map(o => (o.ref === order.ref ? { ...o, status: to } : o))
      );
      const out = await postOrderStatus(slug, ref, to);
      if (out.status === 'ok') {
        setNotice({ tone: 'ok', text: `Order ${ref} → ${to}` });
        await load(true); // the replaced record has a fresh id/createdAt
        onMutated(); // parent refreshes the KPI summary
      } else {
        setOrders(list =>
          list.map(o => (o.ref === order.ref ? { ...o, status: prev } : o))
        );
        if (out.status === 'unavailable') {
          onWritesBlocked();
        } else {
          setNotice({ tone: 'error', text: out.message });
        }
      }
      setBusyRef(null);
    },
    [slug, readOnly, busyRef, load, onMutated, onWritesBlocked]
  );

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of orders) {
      const s = String(o.status || '');
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  }, [orders]);

  const visible =
    filter === 'all' ? orders : orders.filter(o => o.status === filter);
  const anyBusy = busyRef !== null;

  if (phase === 'loading') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '24px 4px',
          color: C.muted,
        }}
      >
        <Spinner /> Loading orders…
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <Banner tone="error">
        Couldn&apos;t load the orders.{' '}
        <button style={linkBtnStyle} onClick={() => void load()}>
          Retry
        </button>
      </Banner>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Status filter chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button style={chipStyle(filter === 'all')} onClick={() => setFilter('all')}>
          All
          <span style={{ opacity: 0.7 }}>{orders.length}</span>
        </button>
        {ORDER_STATUSES.map(s => (
          <button
            key={s}
            style={chipStyle(filter === s, STATUS_COLORS[s])}
            onClick={() => setFilter(s)}
          >
            {s}
            <span style={{ opacity: 0.7 }}>{counts.get(s) ?? 0}</span>
          </button>
        ))}
      </div>

      {notice ? (
        <Banner tone={notice.tone === 'ok' ? 'ok' : 'error'}>
          {notice.text}
        </Banner>
      ) : null}

      <Panel title={`Orders · ${visible.length}`}>
        {/* Paginated order list (pageSize 10, column mode). The `key={filter}`
            remounts PagedList whenever the active status filter changes, which
            resets it to page 1 (a filtered view always starts at the top).
            Column headers ride above the list on a shared grid template so the
            row cards stay aligned; on narrow screens the row grid reflows and
            the header hides (see ORDERS_LIST_CSS). No internal scroll — the
            list is as tall as one page of rows, then the pager takes over. */}
        {visible.length === 0 ? (
          <EmptyNote>
            {orders.length === 0
              ? 'No orders yet — share your shop link to start selling.'
              : 'No orders match this filter.'}
          </EmptyNote>
        ) : (
          <div className="cdz-orders-list">
            <style>{ORDERS_LIST_CSS}</style>
            {/* Column header row (same grid template as each row card). */}
            <div
              className="cdz-orders-head"
              style={{ ...orderRowGrid, ...orderHeadStyle }}
              aria-hidden
            >
              {[
                'Ref',
                'Date',
                'Customer',
                'Wilaya',
                'Items',
                'Total',
                'Status',
                'Advance',
              ].map(h => (
                <div key={h} style={orderHeadCellStyle}>
                  {h}
                </div>
              ))}
            </div>
            <PagedList<ErpOrder>
              key={filter}
              items={visible}
              pageSize={10}
              renderItem={o => (
                <OrderRow
                  key={String(o.ref || o.id)}
                  order={o}
                  currency={currency}
                  readOnly={readOnly}
                  busyRef={busyRef}
                  anyBusy={anyBusy}
                  onAdvance={advance}
                />
              )}
            />
          </div>
        )}
      </Panel>
    </div>
  );
};

// ---------------------------------------------------------------------------
// A single order row card. Same fields, values, actions and behaviour as the
// pre-R9 table row — Ref / Date / Customer(+phone) / Wilaya / Items / Total /
// Status badge / Advance controls — laid out on the shared `orderRowGrid`
// template so the columns line up under the header. Status-advance buttons
// (→ next, ↩ Retournée) call the exact same `advance` handler; busy / readOnly
// / final states are preserved verbatim.
// ---------------------------------------------------------------------------
const OrderRow = ({
  order: o,
  currency,
  readOnly,
  busyRef,
  anyBusy,
  onAdvance,
}: {
  order: ErpOrder;
  currency: string;
  readOnly: boolean;
  busyRef: string | null;
  anyBusy: boolean;
  onAdvance: (order: ErpOrder, to: OrderStatus) => void;
}) => {
  const targets = statusTargets(o.status);
  const next = NEXT_STATUS[o.status as OrderStatus];
  const itemCount = Array.isArray(o.items)
    ? o.items.reduce(
        (s, it) => s + (it.qty != null ? Number(it.qty) || 0 : 1),
        0
      )
    : 0;
  return (
    <div className="cdz-order-row" style={{ ...orderRowGrid, ...orderRowStyle }}>
      <div
        data-col="Ref"
        style={{
          ...orderCellStyle,
          fontFamily: 'var(--affine-font-code-family, monospace)',
          fontWeight: 700,
          whiteSpace: 'nowrap',
        }}
      >
        {o.ref || '—'}
      </div>
      <div data-col="Date" style={{ ...orderCellStyle, whiteSpace: 'nowrap' }}>
        {orderDate(o) || '—'}
      </div>
      <div data-col="Customer" style={orderCellStyle}>
        <div style={{ fontWeight: 600 }}>{o.customer || '—'}</div>
        {o.phone ? (
          <div style={{ fontSize: 11, color: C.muted }}>{o.phone}</div>
        ) : null}
      </div>
      <div data-col="Wilaya" style={orderCellStyle}>
        {o.wilaya || '—'}
      </div>
      <div data-col="Items" style={{ ...orderCellStyle, whiteSpace: 'nowrap' }}>
        {itemCount || '—'}
      </div>
      <div
        data-col="Total"
        style={{ ...orderCellStyle, fontWeight: 700, whiteSpace: 'nowrap' }}
      >
        {fmtDZD(orderTotal(o), currency)}
      </div>
      <div data-col="Status" style={orderCellStyle}>
        <StatusBadge status={o.status} />
      </div>
      <div
        data-col="Advance"
        style={{ ...orderCellStyle, whiteSpace: 'nowrap' }}
      >
        {busyRef === o.ref ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: C.muted,
              fontSize: 11.5,
            }}
          >
            <Spinner /> Saving…
          </span>
        ) : readOnly ? (
          <span style={{ fontSize: 11.5, color: C.muted }}>read-only</span>
        ) : targets.length === 0 ? (
          <span style={{ fontSize: 11.5, color: C.muted }}>final</span>
        ) : (
          <div style={{ display: 'inline-flex', gap: 6 }}>
            {next ? (
              <button
                style={miniBtnStyle('primary', anyBusy)}
                disabled={anyBusy}
                onClick={() => void onAdvance(o, next)}
                title={`Advance to ${next}`}
              >
                → {next}
              </button>
            ) : null}
            {targets.includes('Retournée') ? (
              <button
                style={miniBtnStyle('secondary', anyBusy)}
                disabled={anyBusy}
                onClick={() => void onAdvance(o, 'Retournée')}
                title="Mark as returned"
              >
                ↩ Retournée
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};

// Shared column template for the header row + every order row card (keeps them
// aligned). Mirrors the pre-R9 table's 8 columns; the Customer column flexes.
const orderRowGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns:
    'minmax(64px,auto) minmax(72px,auto) minmax(120px,1.4fr) minmax(72px,auto) 56px minmax(84px,auto) minmax(96px,auto) minmax(120px,auto)',
  gap: 10,
  alignItems: 'center',
};

const orderHeadStyle: CSSProperties = {
  padding: '0 10px 8px',
  borderBottom: `1px solid ${C.border}`,
  marginBottom: 4,
};

const orderHeadCellStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: C.muted,
};

const orderRowStyle: CSSProperties = {
  padding: '10px',
  borderRadius: 10,
  border: `1px solid ${C.border}`,
  background: C.panel,
  fontSize: 12.5,
};

const orderCellStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

// On narrow screens the 8-col grid can't fit; hide the header and let each row
// card reflow to a single column with inline "label: value" cells (the
// data-col attribute feeds the pseudo-label). Keeps the list readable on phones
// without any horizontal scroll.
const ORDERS_LIST_CSS = `
.cdz-orders-list{display:flex;flex-direction:column;gap:8px;}
@media (max-width: 720px){
  .cdz-orders-head{display:none !important;}
  .cdz-order-row{grid-template-columns:1fr !important;gap:4px !important;}
  .cdz-order-row > [data-col]::before{
    content:attr(data-col);
    display:inline-block;
    min-width:74px;
    margin-inline-end:8px;
    font-size:10px;
    font-weight:700;
    letter-spacing:0.04em;
    text-transform:uppercase;
    color:var(--affine-text-secondary-color, #9aa0a6);
  }
  .cdz-order-row > [data-col="Advance"]::before{content:none;}
}
`;
