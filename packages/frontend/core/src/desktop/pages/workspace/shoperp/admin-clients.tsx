import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Banner,
  C,
  EmptyNote,
  type ErpOrder,
  fetchErpCollection,
  fmtDZD,
  linkBtnStyle,
  num,
  orderDate,
  orderTotal,
  Panel,
  Spinner,
  tdStyle,
  thStyle,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// Clients admin — a read view of the store's customers. The shop template does
// not itself keep a `customers` collection (checkout is COD + wa.me), but the
// paired ERP data model does, and the ERP summary already lists it. So we read
// the `customers` collection straight from the public per-slug data API when
// present, and ALWAYS enrich/fallback by DERIVING clients from the `orders`
// collection (group by phone → name, order count, total spent, wilaya, last
// order). This keeps "clients view" fully working whether or not a customers
// collection has been populated. Read-only: there is no customers write route
// in C7 (orders/products/settings are the mutable surfaces), so this section
// stays informative and never fakes a save. Inline styles, matching the rest.
// ---------------------------------------------------------------------------

interface CustomerRecord {
  id?: string;
  name?: string;
  customer?: string;
  fullName?: string;
  phone?: string;
  wilaya?: string;
  commune?: string;
  address?: string;
  email?: string;
  createdAt?: string;
  orders?: number;
  totalSpent?: number;
}

interface ClientRow {
  key: string;
  name: string;
  phone: string;
  wilaya: string;
  orders: number;
  delivered: number;
  spent: number; // total of delivered orders (revenue actually earned)
  lastOrder: string; // YYYY-MM-DD
  source: 'collection' | 'orders';
}

function customerName(c: CustomerRecord): string {
  return String(c.name || c.customer || c.fullName || '').trim();
}

/** Build the client roster: seed from `customers`, enrich/extend from orders. */
function buildRoster(
  customers: CustomerRecord[],
  orders: ErpOrder[]
): ClientRow[] {
  // Key clients by phone when present (stable business key), else by name.
  const byKey = new Map<string, ClientRow>();

  const keyFor = (phone: string, name: string): string =>
    (phone && `p:${phone}`) || (name && `n:${name.toLowerCase()}`) || '';

  // 1) Seed from the customers collection (authoritative identity, if any).
  for (const c of customers) {
    const phone = String(c.phone || '').replace(/\s+/g, '');
    const name = customerName(c);
    const key = keyFor(phone, name);
    if (!key) continue;
    byKey.set(key, {
      key,
      name: name || '—',
      phone: phone || '—',
      wilaya: String(c.wilaya || '').trim(),
      orders: Math.max(0, Math.round(num(c.orders))),
      delivered: 0,
      spent: Math.max(0, Math.round(num(c.totalSpent))),
      lastOrder: String(c.createdAt || '').slice(0, 10),
      source: 'collection',
    });
  }

  // 2) Fold in orders — count, delivered revenue, wilaya, last order date.
  for (const o of orders) {
    const phone = String(o.phone || '').replace(/\s+/g, '');
    const name = String(o.customer || '').trim();
    const key = keyFor(phone, name);
    if (!key) continue;
    const existing = byKey.get(key);
    const date = orderDate(o);
    const isDelivered = String(o.status || '') === 'Livrée';
    const total = orderTotal(o);
    if (existing) {
      existing.orders += 1;
      if (isDelivered) {
        existing.delivered += 1;
        existing.spent += total;
      }
      if (!existing.wilaya && o.wilaya) existing.wilaya = String(o.wilaya);
      if (existing.name === '—' && name) existing.name = name;
      if (existing.phone === '—' && phone) existing.phone = phone;
      if (date > existing.lastOrder) existing.lastOrder = date;
    } else {
      byKey.set(key, {
        key,
        name: name || '—',
        phone: phone || '—',
        wilaya: String(o.wilaya || '').trim(),
        orders: 1,
        delivered: isDelivered ? 1 : 0,
        spent: isDelivered ? total : 0,
        lastOrder: date,
        source: 'orders',
      });
    }
  }

  // Most valuable first (by delivered spend), then by order count, then recency.
  return [...byKey.values()].sort(
    (a, b) =>
      b.spent - a.spent ||
      b.orders - a.orders ||
      b.lastOrder.localeCompare(a.lastOrder)
  );
}

export const ClientsAdmin = ({
  slug,
  currency,
}: {
  /** The store's slug == its data-API namespace. */
  slug: string;
  currency: string;
}) => {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [orders, setOrders] = useState<ErpOrder[]>([]);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      // Both reads are public GETs (no token). Customers may legitimately be
      // empty/absent — tolerate it and derive from orders instead.
      const [custRows, orderRows] = await Promise.all([
        fetchErpCollection<CustomerRecord>(slug, 'customers').catch(() => []),
        fetchErpCollection<ErpOrder>(slug, 'orders').catch(() => []),
      ]);
      setCustomers(Array.isArray(custRows) ? custRows : []);
      setOrders(Array.isArray(orderRows) ? orderRows : []);
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const roster = useMemo(
    () => buildRoster(customers, orders),
    [customers, orders]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter(
      r =>
        r.name.toLowerCase().includes(q) ||
        r.phone.toLowerCase().includes(q) ||
        r.wilaya.toLowerCase().includes(q)
    );
  }, [roster, query]);

  const totals = useMemo(() => {
    const clients = roster.length;
    const repeat = roster.filter(r => r.orders > 1).length;
    const revenue = roster.reduce((s, r) => s + r.spent, 0);
    return { clients, repeat, revenue };
  }, [roster]);

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
        <Spinner /> Loading clients…
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <Banner tone="error">
        Couldn&apos;t load your clients.{' '}
        <button style={linkBtnStyle} onClick={() => void load()}>
          Retry
        </button>
      </Banner>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Summary cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 12,
        }}
      >
        <MiniStat icon="👥" label="Clients" value={String(totals.clients)} />
        <MiniStat
          icon="🔁"
          label="Repeat buyers"
          value={String(totals.repeat)}
          hint="More than one order"
        />
        <MiniStat
          icon="💰"
          label="Delivered revenue"
          value={fmtDZD(totals.revenue, currency)}
          hint="Across all clients"
          color={C.okText}
        />
      </div>

      {customers.length === 0 && roster.length > 0 ? (
        <Banner tone="info">
          Showing clients derived from your orders. When your ERP starts keeping
          a customers list, richer profiles appear here automatically.
        </Banner>
      ) : null}

      <Panel
        title={`Clients · ${visible.length}`}
        action={
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search name / phone / wilaya"
            style={{
              width: 220,
              maxWidth: '40vw',
              boxSizing: 'border-box',
              padding: '5px 10px',
              borderRadius: 7,
              fontSize: 12,
              color: C.text,
              background: C.bg,
              border: `1px solid ${C.border}`,
              outline: 'none',
            }}
          />
        }
      >
        {roster.length === 0 ? (
          <EmptyNote>
            No clients yet — orders will populate this list as customers buy.
          </EmptyNote>
        ) : visible.length === 0 ? (
          <EmptyNote>No clients match “{query}”.</EmptyNote>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr>
                  {[
                    'Client',
                    'Phone',
                    'Wilaya',
                    'Orders',
                    'Delivered',
                    'Spent',
                    'Last order',
                  ].map(h => (
                    <th key={h} style={thStyle}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(r => (
                  <tr key={r.key}>
                    <td style={tdStyle}>
                      <div
                        style={{
                          fontWeight: 700,
                          maxWidth: 200,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={r.name}
                      >
                        {r.name}
                      </div>
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        whiteSpace: 'nowrap',
                        fontFamily: 'var(--affine-font-code-family, monospace)',
                      }}
                    >
                      {r.phone !== '—' ? (
                        <a
                          href={`https://wa.me/${r.phone.replace(/[^0-9]/g, '')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: C.text, textDecoration: 'none' }}
                          title="Open WhatsApp chat"
                        >
                          {r.phone}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={tdStyle}>{r.wilaya || '—'}</td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      {r.orders}
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      {r.delivered}
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {fmtDZD(r.spent, currency)}
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      {r.lastOrder || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
};

const MiniStat = ({
  icon,
  label,
  value,
  hint,
  color,
}: {
  icon: string;
  label: string;
  value: string;
  hint?: string;
  color?: string;
}) => (
  <div
    style={{
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      minWidth: 0,
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: C.muted,
      }}
    >
      <span aria-hidden>{icon}</span> {label}
    </div>
    <div
      style={{
        fontSize: 20,
        fontWeight: 800,
        color: color ?? C.text,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
      title={value}
    >
      {value}
    </div>
    {hint ? <div style={{ fontSize: 11.5, color: C.muted }}>{hint}</div> : null}
  </div>
);
