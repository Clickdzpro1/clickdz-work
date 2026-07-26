import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip as RTooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from 'recharts';

import { ClientsAdmin } from './admin-clients';
import { OrdersAdmin } from './admin-orders';
import { SettingsAdmin } from './admin-settings';
import { StockAdmin } from './admin-stock';
import { Inventory } from './inventory';
import { ShopAppearance } from './shop-appearance';
import { ShopFeatures } from './shop-features';
import { ShopTour, DEFAULT_SHOP_TOUR_STEPS, isShopTourDone } from './shop-tour';
import { ShopAiEdit } from './shop-ai-edit';
import { InvoicingPanel } from './invoicing';
import { ProcurementPanel } from './procurement';
import { ShippingPanel } from './shipping';
import { CaissePanel } from './caisse';
import { ReportsPanel } from './reports';
import { TeamPanel } from './team';
import {
  Banner,
  C,
  codeStyle,
  EmptyNote,
  type ErpSummary,
  fetchErpSummary,
  fmtDZD,
  linkBtnStyle,
  miniBtnStyle,
  num,
  ORDER_STATUSES,
  orderDate,
  orderTotal,
  Panel,
  productTitle,
  Spinner,
  STATUS_COLORS,
  StatusBadge,
  tdStyle,
  thStyle,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// In-app ERP dashboard for one store — the managed STUDIO HOME for the owner's
// shop. Reads the LIVE data the deployed shop writes, via the authed owner-only
// summary route (C6):
//   GET /api/v1/apps/:slug/erp/summary
// Overview = KPI cards + recharts (14-day delivered revenue, orders by status)
// + recent orders + low stock. The Orders / Stock / Clients / Settings /
// Appearance sections are the real management surface (see admin-*.tsx +
// shop-appearance.tsx) — every mutation goes through the /erp/* bridge routes.
// Clients reads the customers collection (deriving from orders as a fallback);
// Appearance edits theme/template/font/accent/sections on the settings
// singleton (C7). If the server reports admin_writes_unavailable the whole
// surface stays usable read-only, with a clear notice. Inline styles only,
// matching the rest of the shoperp page.
// ---------------------------------------------------------------------------

export type DashboardSection =
  | 'overview'
  | 'orders'
  | 'stock'
  | 'inventory'
  | 'clients'
  | 'settings'
  | 'appearance'
  | 'features'
  | 'ai-edit'
  | 'invoicing'
  | 'procurement'
  | 'shipping'
  | 'caisse'
  | 'reports'
  | 'team';

// The tab bar is the merchant's map of their own shop, and this surface is
// French — 7 of these labels were still the upstream English, which is why the
// guided tour (shop-tour.tsx) appeared to name tabs that "did not exist": the
// tour said « Aperçu » while the tab read "Overview". Translating the labels
// fixes the tour AND the interface, rather than making a French tour speak
// English. Ids are untouched, so routing, the tour's data-cdz-tour anchors and
// every deep link keep working.
const SECTIONS: Array<{ id: DashboardSection; label: string; icon: string }> = [
  { id: 'overview', label: 'Aperçu', icon: '📊' },
  { id: 'orders', label: 'Commandes', icon: '📦' },
  { id: 'stock', label: 'Stock', icon: '🏷️' },
  { id: 'inventory', label: 'Inventaire', icon: '🏬' },
  { id: 'clients', label: 'Clients', icon: '👥' },
  { id: 'appearance', label: 'Apparence', icon: '🎨' },
  { id: 'features', label: 'Fonctionnalités', icon: '🧩' },
  { id: 'ai-edit', label: "Modifier avec l'IA", icon: '✨' },
  { id: 'invoicing', label: 'Facturation', icon: '🧾' },
  { id: 'procurement', label: 'Fournisseurs', icon: '📦' },
  { id: 'shipping', label: 'Livraison', icon: '🚚' },
  { id: 'caisse', label: 'Caisse', icon: '💰' },
  { id: 'reports', label: 'Rapports', icon: '📈' },
  { id: 'team', label: 'Équipe', icon: '👥' },
  { id: 'settings', label: 'Réglages', icon: '⚙️' },
];

const tabStyle = (active: boolean): CSSProperties => ({
  appearance: 'none',
  background: 'none',
  border: 'none',
  borderBottom: active ? `2px solid ${C.accent}` : '2px solid transparent',
  padding: '8px 12px',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  color: active ? C.text : C.muted,
  transition: 'color 160ms ease, border-color 160ms ease',
});

export const ErpDashboard = ({
  slug,
  url,
  initialSection = 'overview',
  onBack,
}: {
  /** The store's slug — also its data-API namespace. */
  slug: string;
  /** Live storefront URL, when known (for the "Open live" link). */
  url?: string;
  initialSection?: DashboardSection;
  onBack: () => void;
}) => {
  const [section, setSection] = useState<DashboardSection>(initialSection);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [summary, setSummary] = useState<ErpSummary | null>(null);
  const [errMsg, setErrMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  // Set once a mutation comes back {error:'admin_writes_unavailable'} — the
  // dashboard stays fully readable, admin controls switch to read-only.
  const [writesBlocked, setWritesBlocked] = useState(false);

  const load = useCallback(
    async (soft = false) => {
      if (soft) {
        setRefreshing(true);
      } else {
        setPhase('loading');
      }
      setRefreshFailed(false);
      const out = await fetchErpSummary(slug);
      if (out.status === 'ok') {
        setSummary(out.summary);
        setPhase('ready');
      } else if (soft) {
        // Keep showing the last good data; just flag the failed refresh.
        setRefreshFailed(true);
      } else {
        setErrMsg(out.message);
        setPhase('error');
      }
      setRefreshing(false);
    },
    [slug]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Admin sections call this after a successful mutation so KPIs stay live.
  const refetch = useCallback(() => {
    void load(true);
  }, [load]);

  const handleWritesBlocked = useCallback(() => setWritesBlocked(true), []);

  const shopName = summary?.settings?.shopName || slug;
  const tagline = summary?.settings?.tagline || '';
  const currency = summary?.currency || 'DZD';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header ------------------------------------------------------------ */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <button
          style={{
            ...linkBtnStyle,
            textDecoration: 'none',
            fontWeight: 700,
            color: C.muted,
            whiteSpace: 'nowrap',
          }}
          onClick={onBack}
        >
          ← Shops
        </button>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 18,
              fontWeight: 800,
              color: C.text,
              minWidth: 0,
            }}
          >
            <span aria-hidden>📊</span>
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {shopName}
            </span>
            <span style={codeStyle}>{slug}</span>
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
            {tagline ? `${tagline} · ` : ''}
            {summary
              ? `${summary.kpis.ordersTotal} ${summary.kpis.ordersTotal === 1 ? 'order' : 'orders'} total`
              : 'Live shop data'}
          </div>
        </div>
        <button
          style={miniBtnStyle('secondary', refreshing)}
          disabled={refreshing}
          onClick={() => void load(phase === 'ready')}
        >
          {refreshing ? <Spinner /> : <span aria-hidden>↻</span>} Refresh
        </button>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...miniBtnStyle('secondary'), textDecoration: 'none' }}
          >
            Open live ↗
          </a>
        ) : null}
      </div>

      {/* Section tabs ------------------------------------------------------ */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          flexWrap: 'wrap',
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        {SECTIONS.map(s => (
          <button
            key={s.id}
            data-cdz-tour={s.id}
            style={tabStyle(section === s.id)}
            onClick={() => setSection(s.id)}
          >
            <span aria-hidden>{s.icon}</span>
            {s.label}
          </button>
        ))}
      </div>

      {/* Global notices ---------------------------------------------------- */}
      {writesBlocked ? (
        <Banner tone="warn">
          Admin changes are unavailable on this server right now — the
          dashboard is <strong>read-only</strong>. KPIs, orders and stock still
          reflect live data; you can keep managing from the deployed ERP app.
        </Banner>
      ) : null}
      {refreshFailed ? (
        <Banner tone="warn">
          Couldn’t refresh — showing the last loaded data.{' '}
          <button style={linkBtnStyle} onClick={refetch}>
            Retry
          </button>
        </Banner>
      ) : null}

      {/* Body -------------------------------------------------------------- */}
      {phase === 'loading' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '28px 4px',
            color: C.muted,
          }}
        >
          <Spinner /> Loading live shop data…
        </div>
      ) : phase === 'error' ? (
        <Banner tone="error">
          {errMsg}{' '}
          <button style={linkBtnStyle} onClick={() => void load()}>
            Retry
          </button>
        </Banner>
      ) : summary ? (
        section === 'overview' ? (
          <Overview summary={summary} currency={currency} onGoTo={setSection} />
        ) : section === 'orders' ? (
          <OrdersAdmin
            slug={slug}
            currency={currency}
            readOnly={writesBlocked}
            onWritesBlocked={handleWritesBlocked}
            onMutated={refetch}
          />
        ) : section === 'stock' ? (
          <StockAdmin
            slug={slug}
            currency={currency}
            readOnly={writesBlocked}
            onWritesBlocked={handleWritesBlocked}
            onMutated={refetch}
          />
        ) : section === 'inventory' ? (
          <Inventory
            slug={slug}
            currency={currency}
            readOnly={writesBlocked}
            onWritesBlocked={handleWritesBlocked}
            onMutated={refetch}
          />
        ) : section === 'clients' ? (
          <ClientsAdmin slug={slug} currency={currency} />
        ) : section === 'appearance' ? (
          <ShopAppearance
            slug={slug}
            settings={summary.settings}
            url={url}
            // The managed shop's slug IS its store/pairing key + publish slug.
            storeSlug={slug}
            readOnly={writesBlocked}
            onWritesBlocked={handleWritesBlocked}
            onMutated={refetch}
          />
        ) : section === 'ai-edit' ? (
          <ShopAiEdit slug={slug} url={url} onWritesBlocked={handleWritesBlocked} />
        ) : section === 'invoicing' ? (
          <InvoicingPanel slug={slug} settings={summary.settings} readOnly={writesBlocked} onWritesBlocked={handleWritesBlocked} onMutated={refetch} />
        ) : section === 'procurement' ? (
          <ProcurementPanel slug={slug} currency={currency} readOnly={writesBlocked} onWritesBlocked={handleWritesBlocked} onMutated={refetch} />
        ) : section === 'shipping' ? (
          <ShippingPanel slug={slug} settings={summary.settings} readOnly={writesBlocked} onWritesBlocked={handleWritesBlocked} onMutated={refetch} />
        ) : section === 'caisse' ? (
          <CaissePanel slug={slug} settings={summary.settings} readOnly={writesBlocked} onWritesBlocked={handleWritesBlocked} onMutated={refetch} />
        ) : section === 'reports' ? (
          <ReportsPanel slug={slug} currency={currency} onWritesBlocked={handleWritesBlocked} />
        ) : section === 'team' ? (
          <TeamPanel slug={slug} settings={summary.settings} readOnly={writesBlocked} onWritesBlocked={handleWritesBlocked} onMutated={refetch} />
        ) : section === 'features' ? (
          <ShopFeatures
            slug={slug}
            settings={summary.settings}
            url={url}
            // The managed shop's slug IS its store/pairing key + publish slug.
            storeSlug={slug}
            scope="shop"
            readOnly={writesBlocked}
            onWritesBlocked={handleWritesBlocked}
            onMutated={refetch}
          />
        ) : (
          <SettingsAdmin
            slug={slug}
            settings={summary.settings}
            readOnly={writesBlocked}
            onWritesBlocked={handleWritesBlocked}
            onMutated={refetch}
          />
        )
      ) : null}
      {phase === 'ready' && !isShopTourDone(slug) ? (
        <ShopTour
          slug={slug}
          steps={DEFAULT_SHOP_TOUR_STEPS}
          sections={SECTIONS.map(s => s.id)}
          onGoTo={s => setSection(s as DashboardSection)}
          onDone={() => {}}
        />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Overview section — KPI cards, charts, recent orders, low stock, top products.
// ---------------------------------------------------------------------------

const Overview = ({
  summary,
  currency,
  onGoTo,
}: {
  summary: ErpSummary;
  currency: string;
  onGoTo: (s: DashboardSection) => void;
}) => {
  const k = summary.kpis;

  const revenueData = useMemo(
    () =>
      (summary.revenueByDay ?? []).map(d => ({
        date: String(d?.date || ''),
        revenue: num(d?.revenue),
      })),
    [summary]
  );
  const statusData = useMemo(
    () =>
      ORDER_STATUSES.map(s => ({
        status: s,
        count: num(summary.ordersByStatus?.[s]),
      })),
    [summary]
  );
  const hasAnyOrder = k.ordersTotal > 0;
  const hasRevenuePoints = revenueData.some(d => d.revenue > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* KPI cards — responsive grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(158px, 1fr))',
          gap: 12,
        }}
      >
        <KpiCard
          icon="💰"
          label="Revenue (CA)"
          value={fmtDZD(k.revenueMonth, currency)}
          hint="Delivered this month"
          color={C.okText}
        />
        <KpiCard
          icon="⏳"
          label="Pending orders"
          value={String(k.pendingCount)}
          hint="Nouvelle + Confirmée"
        />
        <KpiCard
          icon="🧺"
          label="Avg basket"
          value={fmtDZD(k.avgBasket, currency)}
          hint="Per delivered order"
        />
        <KpiCard
          icon="💸"
          label="Expenses"
          value={fmtDZD(k.expensesMonth, currency)}
          hint="This month"
          color="#e8a33d"
        />
        <KpiCard
          icon="📈"
          label="Margin"
          value={fmtDZD(k.margin, currency)}
          hint="Revenue − expenses"
          color={
            k.margin >= 0 ? C.okText : 'var(--affine-error-color, #eb4b4b)'
          }
        />
        <KpiCard
          icon="📦"
          label="Low stock"
          value={String(k.lowStockCount)}
          hint="At or below reorder point"
          color={k.lowStockCount > 0 ? '#e8a33d' : undefined}
        />
      </div>

      {/* Charts */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 12,
        }}
      >
        <Panel title="Delivered revenue — last 14 days">
          {revenueData.length === 0 ? (
            <EmptyNote>
              No data yet — the curve appears with your first delivered
              (« Livrée ») order.
            </EmptyNote>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart
                  data={revenueData}
                  margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient
                      id="cdzErpRevFill"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor="#1e96eb"
                        stopOpacity={0.35}
                      />
                      <stop offset="100%" stopColor="#1e96eb" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    stroke="rgba(154,160,166,0.16)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortDay}
                    tick={{ fill: '#9aa0a6', fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: 'rgba(154,160,166,0.25)' }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: '#9aa0a6', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    allowDecimals={false}
                    tickFormatter={compactNum}
                  />
                  <RTooltip
                    content={<RevenueTip currency={currency} />}
                    cursor={{ stroke: 'rgba(154,160,166,0.35)' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    stroke="#1e96eb"
                    strokeWidth={2}
                    fill="url(#cdzErpRevFill)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
              {!hasRevenuePoints ? (
                <div
                  style={{
                    fontSize: 11.5,
                    color: C.muted,
                    textAlign: 'center',
                    marginTop: 4,
                  }}
                >
                  Nothing delivered in the last 14 days yet.
                </div>
              ) : null}
            </>
          )}
        </Panel>
        <Panel title="Orders by status">
          {!hasAnyOrder ? (
            <EmptyNote>
              No orders yet — share your shop link to start selling.
            </EmptyNote>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={statusData}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  stroke="rgba(154,160,166,0.16)"
                  vertical={false}
                />
                <XAxis
                  dataKey="status"
                  tick={{ fill: '#9aa0a6', fontSize: 10 }}
                  tickLine={false}
                  axisLine={{ stroke: 'rgba(154,160,166,0.25)' }}
                  interval={0}
                />
                <YAxis
                  tick={{ fill: '#9aa0a6', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={34}
                  allowDecimals={false}
                />
                <RTooltip
                  content={<StatusTip />}
                  cursor={{ fill: 'rgba(154,160,166,0.08)' }}
                />
                <Bar dataKey="count" radius={[5, 5, 0, 0]} isAnimationActive={false}>
                  {statusData.map(d => (
                    <Cell key={d.status} fill={STATUS_COLORS[d.status]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </div>

      {/* Recent orders + stock side column */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'flex-start',
        }}
      >
        <div style={{ flex: '1 1 400px', minWidth: 0 }}>
          <Panel
            title={`Recent orders${summary.recentOrders.length ? ` · ${summary.recentOrders.length}` : ''}`}
            action={
              <button
                style={miniBtnStyle('secondary')}
                onClick={() => onGoTo('orders')}
              >
                Manage →
              </button>
            }
          >
            {summary.recentOrders.length === 0 ? (
              <EmptyNote>
                No orders yet — share your shop link to start selling.
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
                      {['Ref', 'Date', 'Customer', 'Wilaya', 'Total', 'Status'].map(
                        h => (
                          <th key={h} style={thStyle}>
                            {h}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {summary.recentOrders.map(o => (
                      <tr key={String(o.ref || o.id)}>
                        <td
                          style={{
                            ...tdStyle,
                            fontFamily:
                              'var(--affine-font-code-family, monospace)',
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {o.ref || '—'}
                        </td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                          {orderDate(o) || '—'}
                        </td>
                        <td style={tdStyle}>{o.customer || '—'}</td>
                        <td style={tdStyle}>{o.wilaya || '—'}</td>
                        <td
                          style={{
                            ...tdStyle,
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                          }}
                        >
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
          </Panel>
        </div>

        <div
          style={{
            flex: '1 1 270px',
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <Panel
            title={`Low stock${k.lowStockCount ? ` · ${k.lowStockCount}` : ''}`}
            action={
              <button
                style={miniBtnStyle('secondary')}
                onClick={() => onGoTo('stock')}
              >
                Manage →
              </button>
            }
          >
            {summary.lowStock.length === 0 ? (
              <EmptyNote>
                All products are above their reorder threshold.
              </EmptyNote>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {summary.lowStock.map((p, i) => (
                  <div
                    key={String(p.sku || p.id || productTitle(p))}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '7px 0',
                      ...(i > 0 ? { borderTop: `1px solid ${C.border}` } : {}),
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: 600,
                        fontSize: 12.5,
                      }}
                    >
                      {productTitle(p)}
                    </span>
                    <span
                      style={{
                        fontSize: 11.5,
                        fontWeight: 700,
                        color: '#e8a33d',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {num(p.stock)} left · reorder at {num(p.reorderAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Top products">
            {summary.topProducts.length === 0 ? (
              <EmptyNote>No delivered sales yet.</EmptyNote>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {summary.topProducts.map((t, i) => (
                  <div
                    key={`${t.title}-${i}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '7px 0',
                      ...(i > 0 ? { borderTop: `1px solid ${C.border}` } : {}),
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        color: C.muted,
                        width: 16,
                        flexShrink: 0,
                      }}
                    >
                      {i + 1}.
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: 600,
                        fontSize: 12.5,
                      }}
                    >
                      {t.title}
                    </span>
                    <span
                      style={{
                        fontSize: 11.5,
                        color: C.muted,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      ×{num(t.qty)}
                    </span>
                    <span
                      style={{
                        fontSize: 11.5,
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                        color: C.text,
                      }}
                    >
                      {fmtDZD(num(t.revenue), currency)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Small presentational bits (inline styles, dark tooltips for recharts).
// ---------------------------------------------------------------------------

const KpiCard = ({
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
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
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
    {hint ? (
      <div style={{ fontSize: 11.5, color: C.muted }}>{hint}</div>
    ) : null}
  </div>
);

const tipBoxStyle: CSSProperties = {
  background: C.panel2,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: '7px 10px',
  fontSize: 12,
  color: C.text,
  boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
};

const RevenueTip = ({
  active,
  payload,
  label,
  currency,
}: TooltipProps<number, string> & { currency?: string }) => {
  if (!active || !payload?.length) return null;
  const v = num(payload[0]?.value);
  return (
    <div style={tipBoxStyle}>
      <div style={{ color: C.muted, marginBottom: 2 }}>
        {String(label ?? '')}
      </div>
      <div style={{ fontWeight: 700 }}>{fmtDZD(v, currency || 'DZD')}</div>
    </div>
  );
};

const StatusTip = ({ active, payload, label }: TooltipProps<number, string>) => {
  if (!active || !payload?.length) return null;
  const status = String(label ?? '');
  const count = num(payload[0]?.value);
  const color =
    (STATUS_COLORS as Record<string, string>)[status] ?? '#9aa0a6';
  return (
    <div style={tipBoxStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 2,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: color,
            display: 'inline-block',
          }}
        />
        <span style={{ color: C.muted }}>{status}</span>
      </div>
      <div style={{ fontWeight: 700 }}>
        {count} {count === 1 ? 'order' : 'orders'}
      </div>
    </div>
  );
};

/** 'YYYY-MM-DD' → 'DD/MM' for chart ticks. */
function shortDay(d: string): string {
  return typeof d === 'string' && d.length >= 10
    ? `${d.slice(8, 10)}/${d.slice(5, 7)}`
    : String(d);
}

/** Compact axis numbers: 12500 → '12.5k'. */
function compactNum(v: number): string {
  const n = num(v);
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}
