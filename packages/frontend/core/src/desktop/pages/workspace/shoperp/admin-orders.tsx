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
  Skeleton,
  Spinner,
  STATUS_COLORS,
  StatusBadge,
  statusTargets,
} from './shoperp-shared';

// DzOS Phase 1: offline-first local store. admin-orders is the second panel
// migrated (after caisse). Reads hydrate the local store (instant on tab
// switch + offline); status advances mirror into the local store so the row
// updates instantly and survives offline. The SyncStatusPill shows the sync
// state. Hybrid: the fetch + postOrderStatus bridge calls stay (server
// authoritative during transition).
import { getErpRepo, SyncStatusPill } from '@affine/core/modules/dzos-store';

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
      // DzOS Phase 1 END-STATE: read from the LOCAL store first (instant,
      // works offline). The /erp/changes pull keeps it fresh. Only on a cold
      // start (local store empty) do we fetch + hydrate.
      const sortByDate = (a: ErpOrder, b: ErpOrder) =>
        orderDate(b).localeCompare(orderDate(a)) ||
        String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      const dedupe = (rows: ErpOrder[]): ErpOrder[] => {
        // Replace = delete+recreate, so dedupe on the business key (ref) and
        // keep the newest copy.
        const byRef = new Map<string, ErpOrder>();
        for (const o of rows) {
          const key = String(o?.ref || o?.id || '');
          if (!key) continue;
          const prev = byRef.get(key);
          if (!prev || String(o.createdAt || '') > String(prev.createdAt || '')) {
            byRef.set(key, o);
          }
        }
        return [...byRef.values()].sort(sortByDate);
      };
      try {
        const repo = await getErpRepo(slug);
        const local = await repo.list<ErpOrder>('orders');
        if (local.length > 0) {
          setOrders(dedupe(local.map((w) => w.data)));
          setPhase('ready');
          return;
        }
      } catch {
        /* fall through to cold-start fetch */
      }
      // Cold start: fetch + hydrate, then serve from the deduped fetch.
      try {
        const rows = await fetchErpCollection<ErpOrder>(slug, 'orders');
        const list = dedupe(rows);
        setOrders(list);
        setPhase('ready');
        void getErpRepo(slug).then((repo) =>
          Promise.all(
            list.map((o) => repo.upsert('orders', String(o.id || o.ref), o).catch(() => {}))
          ).catch(() => {})
        );
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
        setNotice({ tone: 'ok', text: `Commande ${ref} → ${to}` });
        // DzOS Phase 1: mirror the status change into the local store so the
        // row survives offline + updates instantly. Best-effort (the server
        // write already succeeded).
        void getErpRepo(slug).then((repo) =>
          repo
            .upsert('orders', String(order.id || order.ref), { ...order, status: to })
            .catch(() => {})
        );
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' }}>
        {/* Status filter chips skeleton */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[80, 90, 100, 90, 96, 104].map((w, i) => (
            <div
              key={i}
              style={{
                width: w,
                height: 30,
                borderRadius: 999,
                background: C.panel2,
                border: `1px solid ${C.border}`,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <Skeleton rows={1} height={30} />
            </div>
          ))}
        </div>
        <Skeleton rows={7} height={52} gap={8} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: C.muted,
            fontSize: 12.5,
          }}
          role="status"
        >
          <Spinner /> Chargement des commandes…
        </div>
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <Banner tone="error">
        Impossible de charger les commandes.{' '}
        <button style={linkBtnStyle} onClick={() => void load()}>
          Réessayer
        </button>
      </Banner>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Section header with gradient icon chip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          aria-hidden
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            background: 'linear-gradient(135deg, #1e96eb, #0e6bbf)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 15,
            flexShrink: 0,
          }}
        >
          📦
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text, letterSpacing: '-0.01em' }}>
            Gestion des commandes
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 1 }}>
            {orders.length} {orders.length === 1 ? 'commande au total' : 'commandes au total'}
          </div>
        </div>
      </div>

      {/* Status filter chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button style={chipStyle(filter === 'all')} onClick={() => setFilter('all')}>
          Tous
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

      <Panel
        title={`Commandes · ${visible.length}`}
        action={<SyncStatusPill slug={slug} />}
      >
        {/* Paginated order list (pageSize 10, column mode). The `key={filter}`
            remounts PagedList whenever the active status filter changes, which
            resets it to page 1 (a filtered view always starts at the top).
            Column headers ride above the list on a shared grid template so the
            row cards stay aligned; on narrow screens the row grid reflows and
            the header hides (see ORDERS_LIST_CSS). No internal scroll — the
            list is as tall as one page of rows, then the pager takes over. */}
        {visible.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              padding: '32px 16px',
              textAlign: 'center',
            }}
          >
            <span
              aria-hidden
              style={{
                fontSize: 36,
                lineHeight: 1,
                opacity: 0.5,
              }}
            >
              {orders.length === 0 ? '📦' : '🔍'}
            </span>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>
              {orders.length === 0 ? 'Aucune commande pour le moment' : 'Aucune commande ne correspond à ce filtre'}
            </div>
            <div style={{ fontSize: 12.5, color: C.muted, maxWidth: 340, lineHeight: 1.5 }}>
              {orders.length === 0
                ? 'Partagez le lien de votre boutique pour commencer à recevoir des commandes.'
                : "Modifiez ou supprimez le filtre de statut pour voir d'autres commandes."}
            </div>
          </div>
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
                'Réf',
                'Date',
                'Client',
                'Wilaya',
                'Articles',
                'Total',
                'Statut',
                'Action',
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
    <div
      className="cdz-order-row"
      style={{ ...orderRowGrid, ...orderRowStyle }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = C.panel2;
        el.style.borderColor = 'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 30%, transparent)';
        el.style.boxShadow = '0 2px 8px rgba(0,0,0,0.18)';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = C.panel;
        el.style.borderColor = C.border;
        el.style.boxShadow = 'none';
      }}
    >
      <div
        data-col="Réf"
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
      <div data-col="Client" style={orderCellStyle}>
        <div style={{ fontWeight: 600 }}>{o.customer || '—'}</div>
        {o.phone ? (
          <div style={{ fontSize: 11, color: C.muted }}>{o.phone}</div>
        ) : null}
      </div>
      <div data-col="Wilaya" style={orderCellStyle}>
        {o.wilaya || '—'}
      </div>
      <div data-col="Articles" style={{ ...orderCellStyle, whiteSpace: 'nowrap' }}>
        {itemCount || '—'}
      </div>
      <div
        data-col="Total"
        style={{ ...orderCellStyle, fontWeight: 700, whiteSpace: 'nowrap' }}
      >
        {fmtDZD(orderTotal(o), currency)}
      </div>
      <div data-col="Statut" style={orderCellStyle}>
        <StatusBadge status={o.status} />
      </div>
      <div
        data-col="Action"
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
            <Spinner /> Enregistrement…
          </span>
        ) : readOnly ? (
          <span style={{ fontSize: 11.5, color: C.muted }}>lecture seule</span>
        ) : targets.length === 0 ? (
          <span style={{ fontSize: 11.5, color: C.muted }}>final</span>
        ) : (
          <div style={{ display: 'inline-flex', gap: 6 }}>
            {next ? (
              <button
                style={miniBtnStyle('primary', anyBusy)}
                disabled={anyBusy}
                onClick={() => void onAdvance(o, next)}
                title={`Passer à ${next}`}
              >
                → {next}
              </button>
            ) : null}
            {targets.includes('Retournée') ? (
              <button
                style={miniBtnStyle('secondary', anyBusy)}
                disabled={anyBusy}
                onClick={() => void onAdvance(o, 'Retournée')}
                title="Marquer comme retournée"
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
  padding: '11px 12px',
  borderRadius: 10,
  border: `1px solid ${C.border}`,
  background: C.panel,
  fontSize: 12.5,
  transition: 'background 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
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
  .cdz-order-row > [data-col="Action"]::before{content:none;}
}
`;
