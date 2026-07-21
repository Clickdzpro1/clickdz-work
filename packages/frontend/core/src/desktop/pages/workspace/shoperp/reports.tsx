import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  Banner,
  btnStyle,
  C,
  type CaisseMonthTotals,
  type ErpOrder,
  type ErpProduct,
  fetchErpCaisseMonth,
  fetchErpCollection,
  fmtDZD,
  hintStyle,
  isLowStock,
  labelStyle,
  miniBtnStyle,
  num,
  ORDER_STATUSES,
  orderDate,
  orderTotal,
  Panel,
  productTitle,
  Spinner,
  STATUS_COLORS,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// Rapports (WSE-11, R3-f) — the DEEP reporting surface for one store, sitting
// alongside the dashboard's Aperçu KPI panel (which is a light live snapshot).
// This page reads the FULL live collections the deployed shop + ERP write —
// orders / products / couriers via the public per-slug data API
// (fetchErpCollection), the caisse month via the authed bridge route
// (fetchErpCaisseMonth) — and computes, entirely client-side, a période-driven
// analysis: Ventes (revenue + panier moyen + a hand-drawn SVG daily-revenue bar
// chart + a status funnel with conversion %), Produits (top-10 by revenue,
// low-stock, dead-stock), Livraison (per-courier delivered vs retours),
// Caisse (month in/out/net) and a best-effort Marges card (only when products
// actually carry a cost/unitCost field). A "Copier le rapport" button emits a
// WhatsApp-ready FR text summary to the clipboard.
//
// Everything is fail-soft: a missing courier list or a 404/502 on the caisse
// route degrades that card to a quiet "activation en attente" note rather than
// breaking the page. All charts are pure inline SVG (viewBox, mobile-fluid) —
// NO chart libraries. Inline styles only, mirroring shop-appearance.tsx +
// shoperp-shared. FR labels throughout (this surface is where the shop is).
// ---------------------------------------------------------------------------

/** The four selectable reporting windows. */
type PeriodId = '7j' | '30j' | 'mois' | 'moisPrec';

interface PeriodDef {
  id: PeriodId;
  label: string;
  /** Short darja/FR hint shown under the picker. */
  hint: string;
}

const PERIODS: PeriodDef[] = [
  { id: '7j', label: '7 jours', hint: '7 derniers jours' },
  { id: '30j', label: '30 jours', hint: '30 derniers jours' },
  { id: 'mois', label: 'Mois courant', hint: 'Ce mois-ci' },
  { id: 'moisPrec', label: 'Mois précédent', hint: 'Le mois dernier' },
];

/** A resolved window: inclusive [from,to] YYYY-MM-DD + the caisse month key. */
interface ResolvedPeriod {
  from: string;
  to: string;
  /** YYYYMM for the caisse partition (the window's anchor month). */
  monthKey: string;
  /** Number of calendar days spanned (for the daily bar chart axis). */
  days: number;
  label: string;
}

/** Local YYYY-MM-DD (avoids UTC drift on late-evening Algiers time). */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Resolve a period id to a concrete date window (all local time). */
function resolvePeriod(id: PeriodId): ResolvedPeriod {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (id === '7j' || id === '30j') {
    const span = id === '7j' ? 7 : 30;
    const from = new Date(today);
    from.setDate(from.getDate() - (span - 1));
    return {
      from: ymd(from),
      to: ymd(today),
      monthKey: `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}`,
      days: span,
      label: span === 7 ? '7 jours' : '30 jours',
    };
  }
  // Month windows: first → last day of the target month.
  const monthOffset = id === 'moisPrec' ? -1 : 0;
  const first = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const last = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0);
  const end = id === 'mois' && last > today ? today : last; // don't project past today
  const days =
    Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
  return {
    from: ymd(first),
    to: ymd(end),
    monthKey: `${first.getFullYear()}${String(first.getMonth() + 1).padStart(2, '0')}`,
    days,
    label: id === 'mois' ? 'Mois courant' : 'Mois précédent',
  };
}

/** Inclusive YYYY-MM-DD range test. */
function inRange(day: string, from: string, to: string): boolean {
  return !!day && day >= from && day <= to;
}

/** Every YYYY-MM-DD in [from,to] (bounded — the picker never exceeds ~31d). */
function daysInRange(from: string, to: string): string[] {
  const out: string[] = [];
  if (!from || !to) return out;
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  for (let d = new Date(start); d <= end && out.length < 400; d.setDate(d.getDate() + 1)) {
    out.push(ymd(d));
  }
  return out;
}

// Recognized per-product cost field names (data records carry arbitrary keys —
// the typed ErpProduct has none, so we probe the live record at runtime). Any
// present, positive value flips the Marges card on. Fail-soft: absent = hidden.
const COST_KEYS = ['cost', 'unitCost', 'costPrice', 'buyPrice', 'prixAchat', 'pa'] as const;

/** Read a product's unit cost if the live record carries one (else null). */
function productCost(p: ErpProduct): number | null {
  const rec = p as unknown as Record<string, unknown>;
  for (const k of COST_KEYS) {
    if (rec[k] != null) {
      const n = num(rec[k]);
      if (n > 0) return n;
    }
  }
  return null;
}

export const ReportsPanel = ({
  slug,
  currency = 'DZD',
  onWritesBlocked,
}: {
  /** The store's slug — also its data-API namespace. */
  slug: string;
  /** DZD by default; forwarded from the summary when known. */
  currency?: string;
  /** Called if an authed read reports admin writes unavailable (uniformity). */
  onWritesBlocked?: () => void;
}) => {
  const [period, setPeriod] = useState<PeriodId>('7j');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const [orders, setOrders] = useState<ErpOrder[]>([]);
  const [products, setProducts] = useState<ErpProduct[]>([]);
  const [couriers, setCouriers] = useState<Array<Record<string, unknown>>>([]);
  // Caisse is a best-effort side-load: null = not loaded / unavailable.
  const [caisse, setCaisse] = useState<CaisseMonthTotals | null>(null);
  const [caisseState, setCaisseState] = useState<'ok' | 'pending' | 'error'>(
    'pending'
  );

  const [copied, setCopied] = useState(false);

  const resolved = useMemo(() => resolvePeriod(period), [period]);

  const load = useCallback(
    async (soft = false) => {
      if (soft) setRefreshing(true);
      else setPhase('loading');
      setCopied(false);
      // Orders + products drive everything and MUST load; couriers + caisse are
      // additive and fail-soft (empty / quiet-gated) so the page never breaks.
      try {
        const [os, ps] = await Promise.all([
          fetchErpCollection<ErpOrder>(slug, 'orders'),
          fetchErpCollection<ErpProduct>(slug, 'products'),
        ]);
        setOrders(Array.isArray(os) ? os : []);
        setProducts(Array.isArray(ps) ? ps : []);
        setPhase('ready');
      } catch (e) {
        if (!soft) {
          setErrMsg(
            e instanceof Error ? e.message : 'Impossible de charger les données.'
          );
          setPhase('error');
        }
        setRefreshing(false);
        return;
      }
      // Couriers (optional entity — a 404/empty just hides the Livraison card).
      try {
        const cs = await fetchErpCollection<Record<string, unknown>>(
          slug,
          'couriers'
        );
        setCouriers(Array.isArray(cs) ? cs : []);
      } catch {
        setCouriers([]);
      }
      setRefreshing(false);
    },
    [slug]
  );

  // Caisse reloads whenever the window's anchor month changes.
  const loadCaisse = useCallback(async () => {
    setCaisseState('pending');
    const out = await fetchErpCaisseMonth(slug, resolved.monthKey);
    if (out.status === 'ok') {
      setCaisse(out.totals);
      setCaisseState('ok');
    } else if (out.status === 'unavailable') {
      setCaisse(null);
      setCaisseState('pending');
      onWritesBlocked?.();
    } else {
      setCaisse(null);
      setCaisseState('error');
    }
  }, [slug, resolved.monthKey, onWritesBlocked]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadCaisse();
  }, [loadCaisse]);

  // -------------------------------------------------------------------------
  // Derived analytics — all pure, memoized on the loaded data + the window.
  // -------------------------------------------------------------------------

  const inWindow = useMemo(
    () => orders.filter(o => inRange(orderDate(o), resolved.from, resolved.to)),
    [orders, resolved.from, resolved.to]
  );

  const delivered = useMemo(
    () => inWindow.filter(o => String(o.status) === 'Livrée'),
    [inWindow]
  );

  const revenue = useMemo(
    () => delivered.reduce((s, o) => s + orderTotal(o), 0),
    [delivered]
  );
  const ordersCount = inWindow.length;
  const avgBasket = delivered.length ? revenue / delivered.length : 0;

  // Daily delivered-revenue series across the window (for the SVG bar chart).
  const dailyRevenue = useMemo(() => {
    const keys = daysInRange(resolved.from, resolved.to);
    const idx: Record<string, number> = {};
    const vals = keys.map((k, j) => {
      idx[k] = j;
      return 0;
    });
    for (const o of delivered) {
      const k = orderDate(o);
      if (idx[k] != null) vals[idx[k]] += orderTotal(o);
    }
    return keys.map((date, j) => ({ date, revenue: vals[j] }));
  }, [delivered, resolved.from, resolved.to]);

  // Status funnel: counts per status in the window + conversion + return rate.
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of ORDER_STATUSES) c[s] = 0;
    for (const o of inWindow) {
      const s = String(o.status || '');
      if (c[s] != null) c[s] += 1;
    }
    return c;
  }, [inWindow]);

  const returnRate = ordersCount
    ? (statusCounts['Retournée'] / ordersCount) * 100
    : 0;
  // Conversion Nouvelle → Livrée (share of window orders that reached delivery).
  const conversion = ordersCount
    ? (statusCounts['Livrée'] / ordersCount) * 100
    : 0;

  // Top products by delivered revenue (client-side rollup over item lines).
  const topProducts = useMemo(() => {
    const agg: Record<string, { title: string; qty: number; revenue: number }> =
      {};
    for (const o of delivered) {
      const items = Array.isArray(o.items) ? o.items : [];
      for (const it of items) {
        const title = String(it.title || it.name || it.product || 'Article');
        const qty = it.qty != null ? num(it.qty) : 1;
        const line = num(it.price) * qty;
        if (!agg[title]) agg[title] = { title, qty: 0, revenue: 0 };
        agg[title].qty += qty;
        agg[title].revenue += line;
      }
    }
    return Object.values(agg)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);
  }, [delivered]);

  const lowStock = useMemo(
    () => products.filter(p => isLowStock(p)),
    [products]
  );

  // Dead stock: a product with NO sold line across the window's delivered orders.
  const deadStock = useMemo(() => {
    const soldTitles = new Set<string>();
    for (const o of delivered) {
      for (const it of Array.isArray(o.items) ? o.items : []) {
        soldTitles.add(String(it.title || it.name || it.product || '').trim());
      }
    }
    return products.filter(p => {
      const t = productTitle(p).trim();
      return t && !soldTitles.has(t);
    });
  }, [products, delivered]);

  // Per-courier performance — computed from orders' courierId; delivered vs
  // returned counts + a delivery rate. Only orders that carry a courierId count.
  const courierPerf = useMemo(() => {
    const names: Record<string, string> = {};
    for (const c of couriers) {
      const id = String(c.id ?? '').trim();
      if (id) names[id] = String(c.name ?? id);
    }
    const agg: Record<
      string,
      { id: string; name: string; delivered: number; returned: number; total: number }
    > = {};
    for (const o of inWindow) {
      const cid = String((o as Record<string, unknown>).courierId ?? '').trim();
      if (!cid) continue;
      if (!agg[cid]) {
        agg[cid] = {
          id: cid,
          name: names[cid] || cid,
          delivered: 0,
          returned: 0,
          total: 0,
        };
      }
      agg[cid].total += 1;
      const st = String(o.status || '');
      if (st === 'Livrée') agg[cid].delivered += 1;
      else if (st === 'Retournée') agg[cid].returned += 1;
    }
    return Object.values(agg).sort((a, b) => b.total - a.total);
  }, [inWindow, couriers]);
  const hasCourierData = couriers.length > 0 || courierPerf.length > 0;

  // Marges (best-effort): only when at least one product carries a cost field.
  const margin = useMemo(() => {
    const costed = products.filter(p => productCost(p) != null);
    if (costed.length === 0) return null;
    const costByTitle: Record<string, number> = {};
    for (const p of products) {
      const c = productCost(p);
      if (c != null) costByTitle[productTitle(p).trim()] = c;
    }
    let cogs = 0;
    let matchedRevenue = 0;
    let matchedUnits = 0;
    for (const o of delivered) {
      for (const it of Array.isArray(o.items) ? o.items : []) {
        const title = String(it.title || it.name || it.product || '').trim();
        const qty = it.qty != null ? num(it.qty) : 1;
        const c = costByTitle[title];
        if (c != null) {
          cogs += c * qty;
          matchedRevenue += num(it.price) * qty;
          matchedUnits += qty;
        }
      }
    }
    const gross = matchedRevenue - cogs;
    const pct = matchedRevenue > 0 ? (gross / matchedRevenue) * 100 : 0;
    return {
      costedCount: costed.length,
      cogs,
      matchedRevenue,
      matchedUnits,
      gross,
      pct,
    };
  }, [products, delivered]);

  // -------------------------------------------------------------------------
  // "Copier le rapport" — a WhatsApp-ready FR weekly summary → clipboard.
  // -------------------------------------------------------------------------
  const buildReportText = useCallback(() => {
    const lines: string[] = [];
    lines.push(`📊 Rapport ${resolved.label} (${resolved.from} → ${resolved.to})`);
    lines.push('');
    lines.push(`💰 Chiffre d'affaires livré : ${fmtDZD(revenue, currency)}`);
    lines.push(`🧾 Commandes : ${ordersCount}  ·  Livrées : ${delivered.length}`);
    lines.push(`🧺 Panier moyen : ${fmtDZD(avgBasket, currency)}`);
    lines.push(`✅ Conversion (→ livrée) : ${conversion.toFixed(0)}%`);
    lines.push(
      `↩️ Taux de retour : ${returnRate.toFixed(0)}%${returnRate > 15 ? ' ⚠️' : ''}`
    );
    if (topProducts.length) {
      lines.push('');
      lines.push('🏆 Top produits :');
      topProducts.slice(0, 5).forEach((t, i) => {
        lines.push(`  ${i + 1}. ${t.title} — ${fmtDZD(t.revenue, currency)} (×${t.qty})`);
      });
    }
    if (lowStock.length) {
      lines.push('');
      lines.push(`📦 Stock bas : ${lowStock.length} produit(s) à réapprovisionner`);
    }
    if (hasCourierData && courierPerf.length) {
      lines.push('');
      lines.push('🚚 Livreurs :');
      courierPerf.forEach(c => {
        const rate = c.total ? Math.round((c.delivered / c.total) * 100) : 0;
        lines.push(`  • ${c.name} : ${c.delivered} livrées / ${c.returned} retours (${rate}%)`);
      });
    }
    if (caisseState === 'ok' && caisse) {
      lines.push('');
      lines.push(
        `💵 Caisse (mois) : entrées ${fmtDZD(caisse.inTotal, currency)} · sorties ${fmtDZD(caisse.outTotal, currency)} · net ${fmtDZD(caisse.net, currency)}`
      );
    }
    if (margin) {
      lines.push('');
      lines.push(
        `📈 Marge brute estimée : ${fmtDZD(margin.gross, currency)} (${margin.pct.toFixed(0)}%)`
      );
    }
    return lines.join('\n');
  }, [
    resolved,
    revenue,
    currency,
    ordersCount,
    delivered.length,
    avgBasket,
    conversion,
    returnRate,
    topProducts,
    lowStock.length,
    hasCourierData,
    courierPerf,
    caisseState,
    caisse,
    margin,
  ]);

  const copyReport = useCallback(async () => {
    const text = buildReportText();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Legacy fallback (older webviews) — a hidden textarea + execCommand.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  }, [buildReportText]);

  // -------------------------------------------------------------------------
  // Render.
  // -------------------------------------------------------------------------
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Période picker + actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 220 }}>
          <span style={labelStyle}>Période</span>
          <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
            {PERIODS.map(p => (
              <button
                key={p.id}
                style={segStyle(period === p.id)}
                onClick={() => setPeriod(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <span style={{ ...hintStyle, fontSize: 11.5 }}>
            {resolved.from} → {resolved.to}
          </span>
        </div>
        <button
          style={miniBtnStyle('secondary', refreshing)}
          disabled={refreshing || phase === 'loading'}
          onClick={() => {
            void load(true);
            void loadCaisse();
          }}
        >
          {refreshing ? <Spinner /> : <span aria-hidden>↻</span>} Actualiser
        </button>
        <button
          style={btnStyle('primary', phase !== 'ready')}
          disabled={phase !== 'ready'}
          onClick={() => void copyReport()}
        >
          {copied ? '✓ Copié' : '📋 Copier le rapport'}
        </button>
      </div>

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
          <Spinner /> Chargement des données…
        </div>
      ) : phase === 'error' ? (
        <Banner tone="error">
          {errMsg}{' '}
          <button style={linkRetryStyle} onClick={() => void load()}>
            Réessayer
          </button>
        </Banner>
      ) : (
        <>
          {/* ================= VENTES ================= */}
          <SectionTitle icon="💰" title="Ventes" />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(158px, 1fr))',
              gap: 12,
            }}
          >
            <Kpi
              icon="💰"
              label="Chiffre d'affaires"
              value={fmtDZD(revenue, currency)}
              hint="Commandes livrées"
              color={C.okText}
            />
            <Kpi
              icon="🧾"
              label="Commandes"
              value={String(ordersCount)}
              hint={`${delivered.length} livrées`}
            />
            <Kpi
              icon="🧺"
              label="Panier moyen"
              value={fmtDZD(avgBasket, currency)}
              hint="Par commande livrée"
            />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
              gap: 12,
            }}
          >
            <Panel title="Revenu livré par jour">
              <DailyRevenueChart
                data={dailyRevenue}
                currency={currency}
              />
            </Panel>
            <Panel title="Entonnoir des statuts">
              <StatusFunnel
                counts={statusCounts}
                total={ordersCount}
                conversion={conversion}
                returnRate={returnRate}
              />
            </Panel>
          </div>

          {/* ================= PRODUITS ================= */}
          <SectionTitle icon="🏷️" title="Produits" />
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              alignItems: 'flex-start',
            }}
          >
            <div style={{ flex: '1 1 380px', minWidth: 0 }}>
              <Panel title={`Top produits${topProducts.length ? ` · ${topProducts.length}` : ''}`}>
                <TopProducts data={topProducts} currency={currency} />
              </Panel>
            </div>
            <div
              style={{
                flex: '1 1 260px',
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <Panel title={`Stock bas${lowStock.length ? ` · ${lowStock.length}` : ''}`}>
                {lowStock.length === 0 ? (
                  <Empty>Tous les produits sont au-dessus du seuil.</Empty>
                ) : (
                  <ItemList
                    rows={lowStock.map(p => ({
                      key: String(p.sku || p.id || productTitle(p)),
                      title: productTitle(p),
                      right: `${num(p.stock)} · seuil ${num(p.reorderAt)}`,
                      rightColor: '#e8a33d',
                    }))}
                  />
                )}
              </Panel>
              <Panel title={`Stock dormant${deadStock.length ? ` · ${deadStock.length}` : ''}`}>
                {deadStock.length === 0 ? (
                  <Empty>Chaque produit a vendu sur la période.</Empty>
                ) : (
                  <>
                    <div style={{ ...hintStyle, marginBottom: 6 }}>
                      Aucune vente sur la période — à animer / déstocker.
                    </div>
                    <ItemList
                      rows={deadStock.slice(0, 12).map(p => ({
                        key: String(p.sku || p.id || productTitle(p)),
                        title: productTitle(p),
                        right: `${num(p.stock)} en stock`,
                        rightColor: C.muted,
                      }))}
                    />
                    {deadStock.length > 12 ? (
                      <div style={{ ...hintStyle, marginTop: 6 }}>
                        +{deadStock.length - 12} autre(s)
                      </div>
                    ) : null}
                  </>
                )}
              </Panel>
            </div>
          </div>

          {/* ================= LIVRAISON ================= */}
          <SectionTitle icon="🚚" title="Livraison" />
          <Panel title="Performance par livreur">
            {!hasCourierData ? (
              <Empty>
                Aucun livreur configuré — ajoutez vos transporteurs dans
                l’onglet Livraison pour suivre leur performance ici.
              </Empty>
            ) : courierPerf.length === 0 ? (
              <Empty>
                Aucune commande affectée à un livreur sur cette période.
              </Empty>
            ) : (
              <CourierTable rows={courierPerf} />
            )}
          </Panel>

          {/* ================= CAISSE ================= */}
          <SectionTitle icon="💵" title="Caisse" />
          <Panel title={`Caisse — mois ${fmtMonth(resolved.monthKey)}`}>
            {caisseState === 'pending' ? (
              <Empty>
                Caisse en attente d’activation — les mouvements apparaîtront ici
                une fois la caisse en service.
              </Empty>
            ) : caisseState === 'error' ? (
              <Banner tone="warn">
                Impossible de charger la caisse pour l’instant.{' '}
                <button style={linkRetryStyle} onClick={() => void loadCaisse()}>
                  Réessayer
                </button>
              </Banner>
            ) : caisse ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 12,
                }}
              >
                <Kpi
                  icon="⬆️"
                  label="Entrées"
                  value={fmtDZD(caisse.inTotal, currency)}
                  hint={`${caisse.entryCount} mouvement(s)`}
                  color={C.okText}
                />
                <Kpi
                  icon="⬇️"
                  label="Sorties"
                  value={fmtDZD(caisse.outTotal, currency)}
                  color="#e8a33d"
                />
                <Kpi
                  icon="⚖️"
                  label="Net"
                  value={fmtDZD(caisse.net, currency)}
                  color={
                    caisse.net >= 0 ? C.okText : 'var(--affine-error-color, #eb4b4b)'
                  }
                />
                {caisse.pendingCodTotal > 0 ? (
                  <Kpi
                    icon="⏳"
                    label="COD en attente"
                    value={fmtDZD(caisse.pendingCodTotal, currency)}
                    hint="Livraisons à encaisser"
                  />
                ) : null}
              </div>
            ) : (
              <Empty>Aucun mouvement de caisse ce mois-ci.</Empty>
            )}
          </Panel>

          {/* ================= MARGES (best-effort) ================= */}
          {margin ? (
            <>
              <SectionTitle icon="📈" title="Marges" />
              <Panel title="Marge brute estimée">
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                    gap: 12,
                  }}
                >
                  <Kpi
                    icon="📈"
                    label="Marge brute"
                    value={fmtDZD(margin.gross, currency)}
                    hint={`${margin.pct.toFixed(0)}% du CA suivi`}
                    color={
                      margin.gross >= 0
                        ? C.okText
                        : 'var(--affine-error-color, #eb4b4b)'
                    }
                  />
                  <Kpi
                    icon="🧮"
                    label="Coût des ventes"
                    value={fmtDZD(margin.cogs, currency)}
                    hint={`${margin.matchedUnits} unité(s)`}
                  />
                  <Kpi
                    icon="💰"
                    label="CA suivi"
                    value={fmtDZD(margin.matchedRevenue, currency)}
                    hint={`${margin.costedCount} produit(s) avec coût`}
                  />
                </div>
                <div style={{ ...hintStyle, marginTop: 10 }}>
                  Estimation basée sur les produits qui portent un prix d’achat.
                  Les articles sans coût renseigné ne sont pas comptés.
                </div>
              </Panel>
            </>
          ) : null}

          <div style={{ ...hintStyle, fontSize: 11.5, textAlign: 'center', marginTop: 4 }}>
            Rapport calculé à partir des données live · statut « Livrée » = vente
            comptabilisée.
          </div>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// SVG daily-revenue bar chart — hand-drawn, no libs. viewBox makes it fluid;
// mirrors the ERP template's chart style (grid + y labels + rounded bars).
// ---------------------------------------------------------------------------

const DailyRevenueChart = ({
  data,
  currency,
}: {
  data: Array<{ date: string; revenue: number }>;
  currency: string;
}) => {
  const hasData = data.some(d => d.revenue > 0);
  if (!hasData) {
    return (
      <Empty>
        Aucune vente livrée sur la période — le graphe apparaît avec votre
        première commande « Livrée ».
      </Empty>
    );
  }
  const W = 520;
  const H = 200;
  const padL = 42;
  const padR = 12;
  const padT = 14;
  const padB = 28;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const n = data.length;
  const max = Math.max(1, ...data.map(d => d.revenue));
  const gap = n > 20 ? 2 : n > 10 ? 4 : 8;
  const bw = Math.max(2, (iw - gap * (n - 1)) / n);
  const Y = (v: number) => padT + ih - (v / max) * ih;
  // Label cadence keeps the x-axis readable for 7 / 30 / month windows.
  const step = n <= 8 ? 1 : n <= 16 ? 2 : Math.ceil(n / 8);

  return (
    <div style={{ width: '100%', overflow: 'hidden' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Revenu livré par jour"
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        {/* grid + y labels (3 lines) */}
        {[0, 1, 2].map(g => {
          const gv = (max * g) / 2;
          const gy = Y(gv);
          return (
            <g key={g}>
              <line
                x1={padL}
                y1={gy}
                x2={W - padR}
                y2={gy}
                stroke="rgba(154,160,166,0.18)"
                strokeWidth={1}
              />
              <text
                x={padL - 6}
                y={gy + 3}
                textAnchor="end"
                fontSize={9}
                fill={C.muted}
              >
                {gv >= 1000 ? `${Math.round(gv / 100) / 10}k` : Math.round(gv)}
              </text>
            </g>
          );
        })}
        {/* bars + sparse x labels */}
        {data.map((d, j) => {
          const x = padL + j * (bw + gap);
          const h = (d.revenue / max) * ih;
          const y = padT + ih - h;
          return (
            <g key={d.date}>
              <rect
                x={x}
                y={padT}
                width={bw}
                height={ih}
                rx={Math.min(4, bw / 2)}
                fill={C.panel2}
              />
              {d.revenue > 0 ? (
                <rect
                  x={x}
                  y={y}
                  width={bw}
                  height={Math.max(h, 2)}
                  rx={Math.min(4, bw / 2)}
                  fill={C.accent}
                >
                  <title>{`${shortDay(d.date)} · ${fmtDZD(d.revenue, currency)}`}</title>
                </rect>
              ) : null}
              {j % step === 0 || j === n - 1 ? (
                <text
                  x={x + bw / 2}
                  y={H - 10}
                  textAnchor="middle"
                  fontSize={8.5}
                  fill={C.muted}
                >
                  {shortDay(d.date)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Status funnel — the 5 pipeline stages as proportional bars + conversion %
// and a return-rate line flagged red when > 15%.
// ---------------------------------------------------------------------------

const StatusFunnel = ({
  counts,
  total,
  conversion,
  returnRate,
}: {
  counts: Record<string, number>;
  total: number;
  conversion: number;
  returnRate: number;
}) => {
  if (total === 0) {
    return <Empty>Aucune commande sur la période.</Empty>;
  }
  const max = Math.max(1, ...ORDER_STATUSES.map(s => counts[s] || 0));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ORDER_STATUSES.map(s => {
        const v = counts[s] || 0;
        const color = STATUS_COLORS[s];
        const pct = total ? Math.round((v / total) * 100) : 0;
        return (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 78,
                flexShrink: 0,
                fontSize: 11.5,
                fontWeight: 700,
                color: C.text,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {s}
            </span>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                height: 18,
                borderRadius: 6,
                background: C.panel2,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.max(v > 0 ? 4 : 0, (v / max) * 100)}%`,
                  height: '100%',
                  borderRadius: 6,
                  background: color,
                  transition: 'width 200ms ease',
                }}
              />
            </div>
            <span
              style={{
                width: 58,
                flexShrink: 0,
                textAlign: 'right',
                fontSize: 11.5,
                fontWeight: 700,
                color: C.text,
                whiteSpace: 'nowrap',
              }}
            >
              {v} · {pct}%
            </span>
          </div>
        );
      })}
      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          marginTop: 6,
          paddingTop: 10,
          borderTop: `1px solid ${C.border}`,
        }}
      >
        <FunnelStat
          label="Conversion → Livrée"
          value={`${conversion.toFixed(0)}%`}
          color={C.okText}
        />
        <FunnelStat
          label="Taux de retour"
          value={`${returnRate.toFixed(0)}%`}
          color={
            returnRate > 15 ? 'var(--affine-error-color, #eb4b4b)' : C.text
          }
          flag={returnRate > 15}
        />
      </div>
      {returnRate > 15 ? (
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            color: 'var(--affine-error-color, #eb4b4b)',
          }}
        >
          ⚠️ Taux de retour élevé (&gt; 15 %) — vérifiez la qualité / la
          confirmation des commandes.
        </div>
      ) : null}
    </div>
  );
};

const FunnelStat = ({
  label,
  value,
  color,
  flag,
}: {
  label: string;
  value: string;
  color: string;
  flag?: boolean;
}) => (
  <div
    style={{
      flex: '1 1 130px',
      minWidth: 0,
      padding: '8px 10px',
      borderRadius: 8,
      background: flag ? C.errBg : C.panel2,
      border: `1px solid ${flag ? C.errBorder : C.border}`,
    }}
  >
    <div style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
      {label}
    </div>
    <div style={{ fontSize: 17, fontWeight: 800, color, marginTop: 2 }}>
      {value}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Top products — horizontal bars proportional to revenue + fmtDZD.
// ---------------------------------------------------------------------------

const TopProducts = ({
  data,
  currency,
}: {
  data: Array<{ title: string; qty: number; revenue: number }>;
  currency: string;
}) => {
  if (data.length === 0) {
    return <Empty>Aucune vente livrée sur la période.</Empty>;
  }
  const max = Math.max(1, ...data.map(d => d.revenue));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {data.map((t, i) => (
        <div key={`${t.title}-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: C.muted,
                width: 18,
                flexShrink: 0,
              }}
            >
              {i + 1}.
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12.5,
                fontWeight: 600,
                color: C.text,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {t.title}
            </span>
            <span style={{ fontSize: 11, color: C.muted, whiteSpace: 'nowrap' }}>
              ×{t.qty}
            </span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: C.text,
                whiteSpace: 'nowrap',
              }}
            >
              {fmtDZD(t.revenue, currency)}
            </span>
          </div>
          <div
            style={{
              height: 8,
              borderRadius: 5,
              background: C.panel2,
              overflow: 'hidden',
              marginLeft: 26,
            }}
          >
            <div
              style={{
                width: `${Math.max(3, (t.revenue / max) * 100)}%`,
                height: '100%',
                borderRadius: 5,
                background: C.accent,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Per-courier performance table — delivered vs retours + delivery rate.
// ---------------------------------------------------------------------------

const CourierTable = ({
  rows,
}: {
  rows: Array<{
    id: string;
    name: string;
    delivered: number;
    returned: number;
    total: number;
  }>;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column' }}>
    {rows.map((c, i) => {
      const rate = c.total ? Math.round((c.delivered / c.total) * 100) : 0;
      const retPct = c.total ? (c.returned / c.total) * 100 : 0;
      return (
        <div
          key={c.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 0',
            ...(i > 0 ? { borderTop: `1px solid ${C.border}` } : {}),
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              fontWeight: 700,
              color: C.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {c.name}
          </span>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: C.okText, whiteSpace: 'nowrap' }}>
            {c.delivered} livrées
          </span>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              color: retPct > 15 ? 'var(--affine-error-color, #eb4b4b)' : C.muted,
              whiteSpace: 'nowrap',
            }}
          >
            {c.returned} retours
          </span>
          <span
            style={{
              width: 46,
              textAlign: 'right',
              fontSize: 12.5,
              fontWeight: 800,
              color: rate >= 80 ? C.okText : rate >= 50 ? '#e8a33d' : 'var(--affine-error-color, #eb4b4b)',
              whiteSpace: 'nowrap',
            }}
          >
            {rate}%
          </span>
        </div>
      );
    })}
  </div>
);

// ---------------------------------------------------------------------------
// Small shared presentational bits (inline styles only).
// ---------------------------------------------------------------------------

const SectionTitle = ({ icon, title }: { icon: string; title: string }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 14,
      fontWeight: 800,
      color: C.text,
      marginTop: 4,
    }}
  >
    <span aria-hidden>{icon}</span>
    {title}
  </div>
);

const Kpi = ({
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
    {hint ? <div style={{ fontSize: 11.5, color: C.muted }}>{hint}</div> : null}
  </div>
);

const Empty = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      padding: '18px 8px',
      textAlign: 'center',
      fontSize: 12.5,
      color: C.muted,
      lineHeight: 1.6,
    }}
  >
    {children}
  </div>
);

const ItemList = ({
  rows,
}: {
  rows: Array<{ key: string; title: string; right: string; rightColor: string }>;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column' }}>
    {rows.map((r, i) => (
      <div
        key={r.key}
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
            color: C.text,
          }}
        >
          {r.title}
        </span>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            color: r.rightColor,
            whiteSpace: 'nowrap',
          }}
        >
          {r.right}
        </span>
      </div>
    ))}
  </div>
);

const linkRetryStyle: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontWeight: 700,
  cursor: 'pointer',
  color: C.accent,
  textDecoration: 'underline',
};

function segStyle(active: boolean): CSSProperties {
  return {
    appearance: 'none',
    cursor: 'pointer',
    borderRadius: 7,
    padding: '6px 12px',
    fontSize: 12.5,
    fontWeight: 700,
    color: active ? C.text : C.muted,
    background: active ? C.accentSoft : 'transparent',
    border: `1px solid ${active ? C.accent : C.border}`,
    transition: 'color 160ms ease, border-color 160ms ease, background 160ms ease',
  };
}

/** 'YYYY-MM-DD' → 'DD/MM' for chart ticks. */
function shortDay(d: string): string {
  return typeof d === 'string' && d.length >= 10
    ? `${d.slice(8, 10)}/${d.slice(5, 7)}`
    : String(d);
}

/** 'YYYYMM' → 'MM/YYYY' for the caisse panel title. */
function fmtMonth(key: string): string {
  return /^\d{6}$/.test(key) ? `${key.slice(4, 6)}/${key.slice(0, 4)}` : key;
}
