import { useCallback, useEffect, useMemo, useState } from 'react';

import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';

import {
  Banner,
  btnStyle,
  C,
  deleteErpRecord,
  EmptyNote,
  type ErpOrder,
  fetchErpCollection,
  fmtDZD,
  inputStyle,
  linkBtnStyle,
  miniBtnStyle,
  num,
  orderDate,
  orderTotal,
  Panel,
  postErpRecord,
  Spinner,
  StatusBadge,
  tdStyle,
  thStyle,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// Clients admin — a CRM view over the store's customers. The shop template does
// not itself keep a `customers` collection (checkout is COD + wa.me), but the
// paired ERP data model does, and the ERP summary already lists it. So we read
// the `customers` collection straight from the public per-slug data API when
// present, and ALWAYS enrich/fallback by DERIVING clients from the `orders`
// collection (group by phone → name, order count, delivered spend, returns,
// wilaya, last order). This keeps the roster fully working whether or not a
// customers collection has been populated.
//
// R3 CRM upgrade (WSE-10, R3-e) layered on top of that read view — additive,
// never breaks the base list, keeps the ClientsAdmin({slug,currency}) export
// signature the dashboard imports:
//   • Client detail drawer: tap a row → phone (wa.me), order history, totals
//     (CA / nb commandes / panier moyen), returns count, invoices count.
//   • Créances (dettes): a manual per-client debt ledger persisted in the
//     `creances` collection (record {clientPhone, amount, note, date, settled}).
//     Add debt / mark settled; per-client balance in the list + a total KPI.
//     The Data API has NO update route, so "mark settled" = delete + recreate
//     the record with settled:true (the house delete+recreate pattern). Writes
//     go through the owner-authenticated bridge route
//     (postErpRecord/deleteErpRecord → /api/v1/apps/:slug/erp/collections/*).
//     SEC-1: these writes previously used the data API's OPEN v1 route, because
//     the studio owner's browser holds no per-slug write token — but that route
//     accepted writes from anyone at all, so it is now token-gated like v2 and
//     the bridge re-derives the token server-side after asserting ownership.
//     Exactly like every other browser-side ERP mutation here, a failure
//     degrades to read-only rather than surfacing a scary error.
//   • Segments: computed client-side tags (fidèle / gros panier / retours /
//     inactif) as filter chips.
//   • Export: "copier la liste" → phone,name CSV to the clipboard for a
//     WhatsApp broadcast.
//   • Invoices: best-effort per-client invoice count from the R2 invoicing
//     module (GET /erp/invoices) when the flag is on; silently absent otherwise.
// Inline styles only, matching the rest of the shoperp page.
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

/** One persisted debt record in the `creances` collection. */
interface CreanceRecord {
  id?: string;
  clientPhone?: string;
  amount?: number;
  note?: string;
  date?: string; // YYYY-MM-DD
  settled?: boolean;
  createdAt?: string;
}

/** Minimal invoice shape we read for the per-client count (best-effort). */
interface InvoiceLite {
  id?: string;
  orderRef?: string;
  customer?: { name?: string } | null;
}

/** The four computed client segments — ids drive the filter chips. */
type SegmentId = 'fidele' | 'gros' | 'retours' | 'inactif';

interface ClientRow {
  key: string;
  name: string;
  phone: string;
  wilaya: string;
  orders: number;
  delivered: number;
  returned: number;
  spent: number; // total of delivered orders (revenue actually earned)
  avg: number; // panier moyen across delivered orders
  lastOrder: string; // YYYY-MM-DD
  history: ErpOrder[]; // every order matched to this client (newest-first)
  source: 'collection' | 'orders';
}

// A client counts as "gros panier" when their delivered average basket meets
// this floor (DZD). A pragmatic default for the DZ market; not owner-tunable in
// this round (kept a plain constant, no new settings key / no server call).
const BIG_BASKET_MIN = 5000;
// A client is "inactif" when their last order is older than this many days.
const INACTIVE_DAYS = 60;

const SEGMENTS: Array<{ id: SegmentId; label: string; hint: string; emoji: string }> = [
  { id: 'fidele', label: 'Fidèle', hint: '≥ 3 commandes', emoji: '💚' },
  {
    id: 'gros',
    label: 'Gros panier',
    hint: `Panier moyen ≥ ${fmtDZD(BIG_BASKET_MIN)}`,
    emoji: '🧺',
  },
  { id: 'retours', label: 'Retours', hint: '≥ 2 retours', emoji: '↩️' },
  { id: 'inactif', label: 'Inactif', hint: `Aucune commande depuis ${INACTIVE_DAYS}j`, emoji: '💤' },
];

function customerName(c: CustomerRecord): string {
  return String(c.name || c.customer || c.fullName || '').trim();
}

/** Digits-only phone (the stable business key + wa.me link target). */
function digits(phone: string): string {
  return String(phone || '').replace(/[^0-9]/g, '');
}

/** YYYY-MM-DD for "today" (local) — used for the debt date + inactivity cut. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Days between a YYYY-MM-DD string and today (0 if unparseable/future). */
function daysSince(ymd: string): number {
  if (!ymd || ymd.length < 10) return Number.POSITIVE_INFINITY;
  const then = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  const diff = Date.now() - then;
  return diff <= 0 ? 0 : Math.floor(diff / 86400000);
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

  const blank = (
    key: string,
    name: string,
    phone: string,
    wilaya: string,
    source: 'collection' | 'orders'
  ): ClientRow => ({
    key,
    name: name || '—',
    phone: phone || '—',
    wilaya,
    orders: 0,
    delivered: 0,
    returned: 0,
    spent: 0,
    avg: 0,
    lastOrder: '',
    history: [],
    source,
  });

  // 1) Seed from the customers collection (authoritative identity, if any).
  for (const c of customers) {
    const phone = digits(String(c.phone || ''));
    const name = customerName(c);
    const key = keyFor(phone, name);
    if (!key) continue;
    const row = blank(key, name, phone, String(c.wilaya || '').trim(), 'collection');
    row.orders = Math.max(0, Math.round(num(c.orders)));
    row.spent = Math.max(0, Math.round(num(c.totalSpent)));
    row.lastOrder = String(c.createdAt || '').slice(0, 10);
    byKey.set(key, row);
  }

  // 2) Fold in orders — count, delivered revenue, returns, wilaya, last date.
  for (const o of orders) {
    const phone = digits(String(o.phone || ''));
    const name = String(o.customer || '').trim();
    const key = keyFor(phone, name);
    if (!key) continue;
    const date = orderDate(o);
    const status = String(o.status || '');
    const isDelivered = status === 'Livrée';
    const isReturned = status === 'Retournée';
    const total = orderTotal(o);
    let row = byKey.get(key);
    if (!row) {
      row = blank(key, name, phone, String(o.wilaya || '').trim(), 'orders');
      byKey.set(key, row);
    }
    row.orders += 1;
    row.history.push(o);
    if (isDelivered) {
      row.delivered += 1;
      row.spent += total;
    }
    if (isReturned) row.returned += 1;
    if (!row.wilaya && o.wilaya) row.wilaya = String(o.wilaya);
    if (row.name === '—' && name) row.name = name;
    if (row.phone === '—' && phone) row.phone = phone;
    if (date > row.lastOrder) row.lastOrder = date;
  }

  // Finalize: panier moyen + newest-first order history per client.
  for (const row of byKey.values()) {
    row.avg = row.delivered > 0 ? Math.round(row.spent / row.delivered) : 0;
    row.history.sort((a, b) => orderDate(b).localeCompare(orderDate(a)));
  }

  // Most valuable first (by delivered spend), then by order count, then recency.
  return [...byKey.values()].sort(
    (a, b) =>
      b.spent - a.spent ||
      b.orders - a.orders ||
      b.lastOrder.localeCompare(a.lastOrder)
  );
}

/** The segments a client belongs to (computed, client-side). */
function segmentsFor(r: ClientRow): Set<SegmentId> {
  const set = new Set<SegmentId>();
  if (r.orders >= 3) set.add('fidele');
  if (r.avg >= BIG_BASKET_MIN) set.add('gros');
  if (r.returned >= 2) set.add('retours');
  // "Inactif" only means something once the client has actually ordered.
  if (r.orders > 0 && daysSince(r.lastOrder) > INACTIVE_DAYS) set.add('inactif');
  return set;
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
  const [creances, setCreances] = useState<CreanceRecord[]>([]);
  const [invoices, setInvoices] = useState<InvoiceLite[]>([]);
  const [query, setQuery] = useState('');
  const [segFilter, setSegFilter] = useState<SegmentId | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState('');
  // Set true once a debt write comes back as unavailable/blocked → the debt
  // controls switch to read-only, but every read keeps working.
  const [writesBlocked, setWritesBlocked] = useState(false);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      // All reads are public GETs (no token). Customers / créances may
      // legitimately be empty/absent — tolerate it and derive from orders.
      const [custRows, orderRows, creanceRows] = await Promise.all([
        fetchErpCollection<CustomerRecord>(slug, 'customers').catch(() => []),
        fetchErpCollection<ErpOrder>(slug, 'orders').catch(() => []),
        fetchErpCollection<CreanceRecord>(slug, 'creances').catch(() => []),
      ]);
      setCustomers(Array.isArray(custRows) ? custRows : []);
      setOrders(Array.isArray(orderRows) ? orderRows : []);
      setCreances(Array.isArray(creanceRows) ? creanceRows : []);
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, [slug]);

  // Best-effort invoice count per client (R2 invoicing module). Isolated from
  // the main load: the route is owner-authed + flag-gated, so a 404/403/network
  // failure just means "no invoice column" — it must never break the roster.
  const loadInvoices = useCallback(async () => {
    try {
      const res = await fetch(
        cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/invoices`),
        { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
      );
      if (!res.ok) {
        setInvoices([]);
        return;
      }
      const data = (await res.json().catch(() => null)) as
        | { invoices?: unknown }
        | null;
      const raw = Array.isArray(data?.invoices) ? (data!.invoices as unknown[]) : [];
      setInvoices(
        raw
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .map(r => ({
            id: typeof r.id === 'string' ? r.id : undefined,
            orderRef: typeof r.orderRef === 'string' ? r.orderRef : undefined,
            customer:
              r.customer && typeof r.customer === 'object'
                ? { name: String((r.customer as { name?: unknown }).name || '') }
                : null,
          }))
      );
    } catch {
      setInvoices([]);
    }
  }, [slug]);

  useEffect(() => {
    void load();
    void loadInvoices();
  }, [load, loadInvoices]);

  const roster = useMemo(
    () => buildRoster(customers, orders),
    [customers, orders]
  );

  // Per-client outstanding debt (sum of UNSETTLED créances), keyed by phone.
  const debtByPhone = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of creances) {
      if (d.settled) continue;
      const p = digits(String(d.clientPhone || ''));
      if (!p) continue;
      m.set(p, (m.get(p) ?? 0) + num(d.amount));
    }
    return m;
  }, [creances]);

  const totalDebt = useMemo(
    () => [...debtByPhone.values()].reduce((s, v) => s + v, 0),
    [debtByPhone]
  );

  // Invoice count per client: match by exact normalized name, plus orderRef →
  // the client's order refs (invoices carry no phone, only name + orderRef).
  const invoiceCountByKey = useMemo(() => {
    const counts = new Map<string, number>();
    if (invoices.length === 0 || roster.length === 0) return counts;
    // Index orderRef → client key (a client owns the refs of all their orders).
    const refToKey = new Map<string, string>();
    const nameToKey = new Map<string, string>();
    for (const r of roster) {
      if (r.name && r.name !== '—') nameToKey.set(r.name.toLowerCase(), r.key);
      for (const o of r.history) {
        const ref = String(o.ref || '').trim();
        if (ref) refToKey.set(ref, r.key);
      }
    }
    for (const inv of invoices) {
      const ref = String(inv.orderRef || '').trim();
      const nm = String(inv.customer?.name || '').trim().toLowerCase();
      const key = (ref && refToKey.get(ref)) || (nm && nameToKey.get(nm)) || '';
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [invoices, roster]);

  const hasInvoiceData = invoices.length > 0;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roster.filter(r => {
      if (segFilter && !segmentsFor(r).has(segFilter)) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.phone.toLowerCase().includes(q) ||
        r.wilaya.toLowerCase().includes(q)
      );
    });
  }, [roster, query, segFilter]);

  const totals = useMemo(() => {
    const clients = roster.length;
    const repeat = roster.filter(r => r.orders > 1).length;
    const revenue = roster.reduce((s, r) => s + r.spent, 0);
    return { clients, repeat, revenue };
  }, [roster]);

  // Segment counts for the chip badges.
  const segCounts = useMemo(() => {
    const c: Record<SegmentId, number> = { fidele: 0, gros: 0, retours: 0, inactif: 0 };
    for (const r of roster) {
      const s = segmentsFor(r);
      (['fidele', 'gros', 'retours', 'inactif'] as SegmentId[]).forEach(id => {
        if (s.has(id)) c[id] += 1;
      });
    }
    return c;
  }, [roster]);

  const openClient = useMemo(
    () => (openKey ? roster.find(r => r.key === openKey) ?? null : null),
    [openKey, roster]
  );

  // --- Créances mutations (owner-authed bridge route; degrade to read-only) --

  const addDebt = useCallback(
    async (clientPhone: string, amount: number, note: string) => {
      const outcome = await postErpRecord<CreanceRecord>(slug, 'creances', {
        clientPhone: digits(clientPhone),
        amount: Math.round(amount),
        note: note.trim().slice(0, 240),
        date: todayISO(),
        settled: false,
      });
      if (outcome.status === 'ok') {
        setCreances(prev => [outcome.data, ...prev]);
        return true;
      }
      if (outcome.status === 'unavailable') setWritesBlocked(true);
      return false;
    },
    [slug]
  );

  // Mark settled = delete the open record + recreate it settled (no update route).
  const settleDebt = useCallback(
    async (rec: CreanceRecord) => {
      if (!rec.id) return false;
      const del = await deleteErpRecord(slug, 'creances', rec.id);
      if (del.status === 'unavailable') {
        setWritesBlocked(true);
        return false;
      }
      if (del.status === 'error') return false;
      const outcome = await postErpRecord<CreanceRecord>(slug, 'creances', {
        clientPhone: digits(String(rec.clientPhone || '')),
        amount: Math.round(num(rec.amount)),
        note: String(rec.note || ''),
        date: String(rec.date || todayISO()),
        settled: true,
      });
      // Drop the old id regardless; add the settled record when recreated.
      setCreances(prev => {
        const without = prev.filter(d => d.id !== rec.id);
        return outcome.status === 'ok' ? [outcome.data, ...without] : without;
      });
      if (outcome.status === 'unavailable') setWritesBlocked(true);
      return outcome.status === 'ok';
    },
    [slug]
  );

  const copyList = useCallback(async () => {
    // phone,name CSV of the CURRENTLY VISIBLE clients (respects search/segment).
    const rows = visible.filter(r => r.phone !== '—');
    const csv = ['phone,name']
      .concat(
        rows.map(r => {
          const name = r.name === '—' ? '' : r.name.replace(/"/g, '""');
          return `${digits(r.phone)},"${name}"`;
        })
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(csv);
      setCopyNote(`${rows.length} contact${rows.length === 1 ? '' : 's'} copié${rows.length === 1 ? '' : 's'}`);
    } catch {
      setCopyNote('Copie impossible — sélectionnez le texte manuellement.');
    }
    window.setTimeout(() => setCopyNote(''), 3200);
  }, [visible]);

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
        <Spinner /> Chargement des clients…
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <Banner tone="error">
        Impossible de charger vos clients.{' '}
        <button style={linkBtnStyle} onClick={() => void load()}>
          Réessayer
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
          label="Clients fidèles"
          value={String(totals.repeat)}
          hint="Plus d'une commande"
        />
        <MiniStat
          icon="💰"
          label="CA livré"
          value={fmtDZD(totals.revenue, currency)}
          hint="Tous clients"
          color={C.okText}
        />
        <MiniStat
          icon="🧾"
          label="Créances"
          value={fmtDZD(totalDebt, currency)}
          hint="Dettes clients non réglées"
          color={totalDebt > 0 ? '#e8a33d' : undefined}
        />
      </div>

      {writesBlocked ? (
        <Banner tone="warn">
          Les créances sont en <strong>lecture seule</strong> sur ce serveur
          pour le moment — l'ajout et le règlement de dettes sont indisponibles.
          Le reste de la vue clients fonctionne normalement.
        </Banner>
      ) : null}

      {customers.length === 0 && roster.length > 0 ? (
        <Banner tone="info">
          Clients dérivés de vos commandes. Dès que votre ERP tient une liste de
          clients, des profils plus riches apparaissent ici automatiquement.
        </Banner>
      ) : null}

      {/* Segment filter chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <SegChip
          label="Tous"
          emoji="•"
          count={roster.length}
          active={segFilter === null}
          onClick={() => setSegFilter(null)}
        />
        {SEGMENTS.map(s => (
          <SegChip
            key={s.id}
            label={s.label}
            emoji={s.emoji}
            hint={s.hint}
            count={segCounts[s.id]}
            active={segFilter === s.id}
            onClick={() => setSegFilter(segFilter === s.id ? null : s.id)}
          />
        ))}
      </div>

      <Panel
        title={`Clients · ${visible.length}`}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {copyNote ? (
              <span style={{ fontSize: 11.5, color: C.muted }}>{copyNote}</span>
            ) : null}
            <button
              style={miniBtnStyle('secondary', visible.length === 0)}
              disabled={visible.length === 0}
              onClick={() => void copyList()}
              title="Copier téléphone + nom (CSV) pour une diffusion WhatsApp"
            >
              📋 Copier la liste
            </button>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Nom / téléphone / wilaya"
              style={{
                width: 200,
                maxWidth: '38vw',
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
          </div>
        }
      >
        {roster.length === 0 ? (
          <EmptyNote>
            Aucun client pour l'instant — la liste se remplit au fil des
            commandes de vos clients.
          </EmptyNote>
        ) : visible.length === 0 ? (
          <EmptyNote>
            Aucun client ne correspond{query ? ` à « ${query} »` : ''}
            {segFilter ? ' dans ce segment' : ''}.
          </EmptyNote>
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
                    'Téléphone',
                    'Wilaya',
                    'Cmd',
                    'Livrées',
                    'Retours',
                    'CA livré',
                    'Créance',
                    ...(hasInvoiceData ? ['Factures'] : []),
                    'Dern. cmd',
                    '',
                  ].map((h, i) => (
                    <th key={h || `sp${i}`} style={thStyle}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(r => {
                  const debt = r.phone !== '—' ? debtByPhone.get(digits(r.phone)) ?? 0 : 0;
                  const invCount = invoiceCountByKey.get(r.key) ?? 0;
                  return (
                    <tr
                      key={r.key}
                      onClick={() => setOpenKey(r.key)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={tdStyle}>
                        <div
                          style={{
                            fontWeight: 700,
                            maxWidth: 190,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={r.name}
                        >
                          {r.name}
                        </div>
                        <SegTags segs={segmentsFor(r)} />
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
                            href={`https://wa.me/${digits(r.phone)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            style={{ color: C.text, textDecoration: 'none' }}
                            title="Ouvrir le chat WhatsApp"
                          >
                            {r.phone}
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td style={tdStyle}>{r.wilaya || '—'}</td>
                      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{r.orders}</td>
                      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{r.delivered}</td>
                      <td
                        style={{
                          ...tdStyle,
                          whiteSpace: 'nowrap',
                          color: r.returned > 0 ? '#ef4444' : C.text,
                          fontWeight: r.returned > 0 ? 700 : 400,
                        }}
                      >
                        {r.returned}
                      </td>
                      <td style={{ ...tdStyle, fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {fmtDZD(r.spent, currency)}
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          whiteSpace: 'nowrap',
                          fontWeight: debt > 0 ? 700 : 400,
                          color: debt > 0 ? '#e8a33d' : C.muted,
                        }}
                      >
                        {debt > 0 ? fmtDZD(debt, currency) : '—'}
                      </td>
                      {hasInvoiceData ? (
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                          {invCount > 0 ? invCount : '—'}
                        </td>
                      ) : null}
                      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                        {r.lastOrder || '—'}
                      </td>
                      <td style={{ ...tdStyle, whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <span style={{ color: C.muted, fontSize: 11 }}>Détails ›</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {openClient ? (
        <ClientDrawer
          client={openClient}
          currency={currency}
          debt={openClient.phone !== '—' ? debtByPhone.get(digits(openClient.phone)) ?? 0 : 0}
          creances={creances.filter(
            d =>
              openClient.phone !== '—' &&
              digits(String(d.clientPhone || '')) === digits(openClient.phone)
          )}
          invoiceCount={invoiceCountByKey.get(openClient.key) ?? 0}
          hasInvoiceData={hasInvoiceData}
          writesBlocked={writesBlocked}
          onClose={() => setOpenKey(null)}
          onAddDebt={addDebt}
          onSettle={settleDebt}
        />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Client detail drawer — a right-side sheet with the client's profile, order
// history, and their créances ledger (add / settle).
// ---------------------------------------------------------------------------

const ClientDrawer = ({
  client,
  currency,
  debt,
  creances,
  invoiceCount,
  hasInvoiceData,
  writesBlocked,
  onClose,
  onAddDebt,
  onSettle,
}: {
  client: ClientRow;
  currency: string;
  debt: number;
  creances: CreanceRecord[];
  invoiceCount: number;
  hasInvoiceData: boolean;
  writesBlocked: boolean;
  onClose: () => void;
  onAddDebt: (phone: string, amount: number, note: string) => Promise<boolean>;
  onSettle: (rec: CreanceRecord) => Promise<boolean>;
}) => {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const canDebt = client.phone !== '—' && !writesBlocked;
  const openDebts = creances.filter(d => !d.settled);
  const settledDebts = creances.filter(d => d.settled);

  const submit = useCallback(async () => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setErr('Entrez un montant valide (> 0).');
      return;
    }
    setErr('');
    setBusy(true);
    const ok = await onAddDebt(client.phone, amt, note);
    setBusy(false);
    if (ok) {
      setAmount('');
      setNote('');
    } else {
      setErr('Enregistrement impossible — réessayez.');
    }
  }, [amount, note, client.phone, onAddDebt]);

  const settle = useCallback(
    async (rec: CreanceRecord) => {
      if (!rec.id) return;
      setBusyId(rec.id);
      await onSettle(rec);
      setBusyId(null);
    },
    [onSettle]
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(460px, 100vw)',
          height: '100%',
          overflowY: 'auto',
          background: C.bg,
          borderLeft: `1px solid ${C.border}`,
          boxShadow: '-8px 0 30px rgba(0,0,0,0.4)',
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 17,
                fontWeight: 800,
                color: C.text,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={client.name}
            >
              {client.name}
            </div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>
              {client.wilaya || 'Wilaya inconnue'}
            </div>
            <SegTags segs={segmentsFor(client)} />
          </div>
          <button
            style={{ ...linkBtnStyle, textDecoration: 'none', fontSize: 20, color: C.muted }}
            onClick={onClose}
            aria-label="Fermer"
            title="Fermer"
          >
            ×
          </button>
        </div>

        {/* Phone / WhatsApp */}
        {client.phone !== '—' ? (
          <a
            href={`https://wa.me/${digits(client.phone)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...btnStyle('secondary'), textDecoration: 'none', justifyContent: 'flex-start' }}
          >
            <span aria-hidden>💬</span>
            <span style={{ fontFamily: 'var(--affine-font-code-family, monospace)' }}>
              {client.phone}
            </span>
            <span style={{ color: C.muted, fontWeight: 400 }}>· WhatsApp ↗</span>
          </a>
        ) : (
          <Banner tone="info">Aucun numéro de téléphone pour ce client.</Banner>
        )}

        {/* Totals */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
            gap: 8,
          }}
        >
          <DrawerStat label="CA livré" value={fmtDZD(client.spent, currency)} color={C.okText} />
          <DrawerStat label="Commandes" value={String(client.orders)} />
          <DrawerStat
            label="Panier moyen"
            value={client.avg > 0 ? fmtDZD(client.avg, currency) : '—'}
          />
          <DrawerStat
            label="Retours"
            value={String(client.returned)}
            color={client.returned > 0 ? '#ef4444' : undefined}
          />
          {hasInvoiceData ? (
            <DrawerStat label="Factures" value={invoiceCount > 0 ? String(invoiceCount) : '—'} />
          ) : null}
          <DrawerStat
            label="Créance"
            value={debt > 0 ? fmtDZD(debt, currency) : '0'}
            color={debt > 0 ? '#e8a33d' : undefined}
          />
        </div>

        {/* Créances ledger */}
        <div
          style={{
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '9px 12px',
              borderBottom: `1px solid ${C.border}`,
              background: C.panel2,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: C.muted,
            }}
          >
            Créances (dettes)
          </div>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {canDebt ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={amount}
                    onChange={e => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
                    inputMode="numeric"
                    placeholder={`Montant (${currency})`}
                    style={{ ...inputStyle, flex: '0 0 40%' }}
                  />
                  <input
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder="Note (facultatif)"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                </div>
                {err ? (
                  <span style={{ fontSize: 12, color: 'var(--affine-error-color, #eb4b4b)' }}>
                    {err}
                  </span>
                ) : null}
                <button
                  style={{ ...btnStyle('primary', busy), alignSelf: 'flex-start' }}
                  disabled={busy}
                  onClick={() => void submit()}
                >
                  {busy ? <Spinner dark /> : <span aria-hidden>＋</span>} Ajouter une dette
                </button>
              </div>
            ) : client.phone === '—' ? (
              <EmptyNote>Un numéro de téléphone est requis pour suivre les dettes.</EmptyNote>
            ) : (
              <EmptyNote>Ajout de dette indisponible (lecture seule).</EmptyNote>
            )}

            {creances.length === 0 ? (
              <EmptyNote>Aucune dette enregistrée.</EmptyNote>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {openDebts.map((d, i) => (
                  <DebtRow
                    key={d.id || `o${i}`}
                    rec={d}
                    currency={currency}
                    settled={false}
                    busy={busyId === d.id}
                    canSettle={!writesBlocked}
                    onSettle={() => void settle(d)}
                    first={i === 0}
                  />
                ))}
                {settledDebts.map((d, i) => (
                  <DebtRow
                    key={d.id || `s${i}`}
                    rec={d}
                    currency={currency}
                    settled
                    busy={false}
                    canSettle={false}
                    onSettle={() => {}}
                    first={openDebts.length === 0 && i === 0}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Order history */}
        <div
          style={{
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '9px 12px',
              borderBottom: `1px solid ${C.border}`,
              background: C.panel2,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: C.muted,
            }}
          >
            Historique des commandes · {client.history.length}
          </div>
          <div style={{ padding: client.history.length ? 0 : 12 }}>
            {client.history.length === 0 ? (
              <EmptyNote>Aucune commande enregistrée pour ce client.</EmptyNote>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      {['Réf', 'Date', 'Total', 'Statut'].map(h => (
                        <th key={h} style={thStyle}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {client.history.map((o, i) => (
                      <tr key={String(o.ref || o.id || i)}>
                        <td
                          style={{
                            ...tdStyle,
                            fontFamily: 'var(--affine-font-code-family, monospace)',
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {o.ref || '—'}
                        </td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                          {orderDate(o) || '—'}
                        </td>
                        <td style={{ ...tdStyle, fontWeight: 700, whiteSpace: 'nowrap' }}>
                          {fmtDZD(orderTotal(o), currency)}
                        </td>
                        <td style={tdStyle}>
                          <StatusBadge status={o.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const DebtRow = ({
  rec,
  currency,
  settled,
  busy,
  canSettle,
  onSettle,
  first,
}: {
  rec: CreanceRecord;
  currency: string;
  settled: boolean;
  busy: boolean;
  canSettle: boolean;
  onSettle: () => void;
  first: boolean;
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 0',
      ...(first ? {} : { borderTop: `1px solid ${C.border}` }),
      opacity: settled ? 0.6 : 1,
    }}
  >
    <div style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          fontWeight: 700,
          fontSize: 13,
          color: settled ? C.muted : '#e8a33d',
          textDecoration: settled ? 'line-through' : 'none',
        }}
      >
        {fmtDZD(num(rec.amount), currency)}
      </div>
      <div style={{ fontSize: 11.5, color: C.muted }}>
        {String(rec.date || '').slice(0, 10) || '—'}
        {rec.note ? ` · ${rec.note}` : ''}
      </div>
    </div>
    {settled ? (
      <span style={{ fontSize: 11, fontWeight: 700, color: C.okText, whiteSpace: 'nowrap' }}>
        ✓ Réglée
      </span>
    ) : canSettle ? (
      <button style={miniBtnStyle('secondary', busy)} disabled={busy} onClick={onSettle}>
        {busy ? <Spinner /> : null} Marquer réglée
      </button>
    ) : null}
  </div>
);

const DrawerStat = ({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) => (
  <div
    style={{
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: '9px 11px',
      minWidth: 0,
    }}
  >
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: C.muted,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {label}
    </div>
    <div
      style={{
        fontSize: 15,
        fontWeight: 800,
        color: color ?? C.text,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        marginTop: 2,
      }}
      title={value}
    >
      {value}
    </div>
  </div>
);

// Small inline segment badges shown under the client name.
const SegTags = ({ segs }: { segs: Set<SegmentId> }) => {
  if (segs.size === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      {SEGMENTS.filter(s => segs.has(s.id)).map(s => (
        <span
          key={s.id}
          title={s.hint}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            fontSize: 10,
            fontWeight: 700,
            padding: '1px 7px',
            borderRadius: 999,
            color: C.muted,
            background: C.panel2,
            border: `1px solid ${C.border}`,
          }}
        >
          <span aria-hidden>{s.emoji}</span>
          {s.label}
        </span>
      ))}
    </div>
  );
};

const SegChip = ({
  label,
  emoji,
  hint,
  count,
  active,
  onClick,
}: {
  label: string;
  emoji: string;
  hint?: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    title={hint}
    style={{
      appearance: 'none',
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 12,
      fontWeight: 700,
      padding: '5px 11px',
      borderRadius: 999,
      color: active ? '#fff' : C.text,
      background: active ? C.accent : 'transparent',
      border: `1px solid ${active ? C.accent : C.border}`,
      transition: 'background 160ms ease, border-color 160ms ease',
    }}
  >
    <span aria-hidden>{emoji}</span>
    {label}
    <span style={{ color: active ? 'rgba(255,255,255,0.85)' : C.muted, fontWeight: 700 }}>
      {count}
    </span>
  </button>
);

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
