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
  // Guided tour visibility. Stateful (rather than reading isShopTourDone inline
  // at render) so the merchant can replay it from the header afterwards —
  // previously, once finished or skipped, there was no way back to it at all.
  const [tourOpen, setTourOpen] = useState(() => !isShopTourDone(slug));
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

  // Tick the checklist's Livraison step once the merchant actually opens that
  // tab. Done here rather than on the tab's onClick so every route in counts —
  // the checklist's own "Faire →", a deep link, or the guided tour.
  useEffect(() => {
    if (section === 'shipping') markShippingSeen(slug);
  }, [section, slug]);

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
          ← Boutiques
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
              : 'Données de la boutique en direct'}
          </div>
        </div>
        <button
          style={miniBtnStyle('secondary', refreshing)}
          disabled={refreshing}
          onClick={() => void load(phase === 'ready')}
        >
          {refreshing ? <Spinner /> : <span aria-hidden>↻</span>} Actualiser
        </button>
        {/* Replay the guided tour. Without this the tour was strictly one-shot:
            skip it once (or finish it before you understood a tab) and it was
            gone for good. */}
        {!tourOpen ? (
          <button
            style={miniBtnStyle('secondary')}
            onClick={() => setTourOpen(true)}
          >
            <span aria-hidden>❓</span> Visite guidée
          </button>
        ) : null}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...miniBtnStyle('secondary'), textDecoration: 'none' }}
          >
            Voir la boutique ↗
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
          Les modifications sont indisponibles sur ce serveur pour le moment —
          le tableau de bord est en <strong>lecture seule</strong>. Les indicateurs,
          les commandes et le stock restent à jour ; vous pouvez continuer à gérer
          depuis l’application ERP publiée.
        </Banner>
      ) : null}
      {refreshFailed ? (
        <Banner tone="warn">
          Actualisation impossible — affichage des dernières données chargées.{' '}
          <button style={linkBtnStyle} onClick={refetch}>
            Réessayer
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
          <Spinner /> Chargement des données de la boutique…
        </div>
      ) : phase === 'error' ? (
        <Banner tone="error">
          {errMsg}{' '}
          <button style={linkBtnStyle} onClick={() => void load()}>
            Réessayer
          </button>
        </Banner>
      ) : summary ? (
        section === 'overview' ? (
          <Overview
            slug={slug}
            summary={summary}
            currency={currency}
            onGoTo={setSection}
          />
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
      {phase === 'ready' && tourOpen ? (
        <ShopTour
          slug={slug}
          steps={DEFAULT_SHOP_TOUR_STEPS}
          sections={SECTIONS.map(s => s.id)}
          onGoTo={s => setSection(s as DashboardSection)}
          onDone={() => setTourOpen(false)}
        />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// "Votre boutique en 5 étapes" — the first-run checklist, shown at the top of
// Aperçu until it is complete (or dismissed).
//
// The hub already had a good checklist (StartChecklist in index.tsx), but a
// single-shop merchant auto-opens straight into this dashboard and never sees
// the hub again after day one — so in practice it was invisible to exactly the
// people it was written for.
//
// Every "done" signal is DERIVED from the live summary rather than stored.
// That means it survives a reload, a different browser and a different device
// by construction, and it can never drift out of sync with the real shop. Only
// the dismissal is local, because that is a per-person preference.
// ---------------------------------------------------------------------------

const checklistHideKey = (slug: string) => `cdz.shoperp.checklist.hide.${slug}`;
/** Marks that the merchant has opened the Livraison tab at least once. */
const checklistShippingKey = (slug: string) =>
  `cdz.shoperp.checklist.shipping.${slug}`;

/** Record the Livraison visit (fail-soft — private mode etc.). */
export function markShippingSeen(slug: string): void {
  try {
    globalThis.localStorage?.setItem(checklistShippingKey(slug), '1');
  } catch {
    /* storage unavailable — the step just stays unticked; harmless */
  }
}

const FiveSteps = ({
  slug,
  summary,
  onGoTo,
}: {
  slug: string;
  summary: ErpSummary;
  onGoTo: (s: DashboardSection) => void;
}) => {
  const [hidden, setHidden] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(checklistHideKey(slug)) === '1';
    } catch {
      return false;
    }
  });
  const shippingSeen = (() => {
    try {
      return (
        globalThis.localStorage?.getItem(checklistShippingKey(slug)) === '1'
      );
    } catch {
      return false;
    }
  })();

  const s = summary.settings;
  // Any evidence of a catalogue at all. Deliberately generous: a merchant who
  // has products but no low-stock rows and no orders yet has still done step 1.
  const hasProducts =
    summary.kpis.lowStockCount > 0 ||
    summary.kpis.ordersTotal > 0 ||
    (summary.topProducts?.length ?? 0) > 0 ||
    (summary.lowStock?.length ?? 0) > 0;

  const steps: Array<{
    id: string;
    label: string;
    hint: string;
    section: DashboardSection;
    done: boolean;
  }> = [
    {
      id: 'product',
      label: 'Ajoutez votre premier produit',
      hint: 'Nom, prix, photo — 30 secondes.',
      section: 'stock',
      done: hasProducts,
    },
    {
      id: 'style',
      label: 'Choisissez votre style',
      hint: 'Thème, couleurs et mise en page de la boutique.',
      section: 'appearance',
      done:
        (!!s.theme && s.theme !== 'classic') ||
        (!!s.template && s.template !== 'standard') ||
        (typeof s.accent === 'string' && s.accent.toLowerCase() !== '#0f766e'),
    },
    {
      id: 'shipping',
      label: 'Configurez la livraison',
      hint: 'Tarifs des 58 wilayas et transporteurs.',
      section: 'shipping',
      // This one cannot be derived from the summary: the server normalizes
      // `deliveryFee` to a default of 500 whenever it is unset, so the field
      // is ALWAYS a number and can't distinguish "configured" from "never
      // touched" — and a shop that deliberately delivers free (0) would look
      // permanently unconfigured under a `> 0` test. Per-wilaya rates and
      // courier connections live behind their own endpoints and aren't in the
      // summary at all.
      //
      // So this step is marked done once the merchant has actually opened the
      // Livraison tab. Local-only, unlike the other four — a nudge to visit
      // the screen, honestly labelled rather than a fake derivation.
      done: shippingSeen,
    },
    {
      id: 'whatsapp',
      label: 'Vérifiez votre WhatsApp',
      hint: 'C’est là que les commandes arrivent.',
      section: 'settings',
      // The old wizard default: a shop still carrying it is not configured.
      done: !!s.whatsapp && s.whatsapp !== '213600000000',
    },
    {
      id: 'test-order',
      label: 'Passez une commande test',
      hint: 'Ouvrez votre boutique et commandez comme un client.',
      section: 'orders',
      done: summary.kpis.ordersTotal > 0,
    },
  ];

  const doneCount = steps.filter(x => x.done).length;
  if (hidden || doneCount === steps.length) return null;

  const hide = () => {
    setHidden(true);
    try {
      globalThis.localStorage?.setItem(checklistHideKey(slug), '1');
    } catch {
      /* private mode — hidden for this session only, which is fine */
    }
  };

  return (
    <div
      style={{
        borderRadius: 14,
        border: `1px solid ${C.border}`,
        background: C.panel,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '11px 14px',
          background: C.panel2,
          borderBottom: `1px solid ${C.border}`,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 120 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>
            Votre boutique en 5 étapes
          </div>
          <div style={{ fontSize: 11.5, color: C.muted }}>
            {doneCount}/5 — plus que {5 - doneCount} !
          </div>
        </div>
        <div
          aria-hidden
          style={{
            width: 90,
            height: 6,
            borderRadius: 3,
            background: C.border,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${(doneCount / 5) * 100}%`,
              height: '100%',
              background: C.accent,
              transition: 'width 300ms ease',
            }}
          />
        </div>
        <button
          onClick={hide}
          title="Masquer"
          style={{
            appearance: 'none',
            background: 'none',
            border: 'none',
            color: C.muted,
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 700,
            textDecoration: 'underline',
          }}
        >
          Masquer
        </button>
      </div>
      {steps.map((it, i) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onGoTo(it.section)}
          style={{
            appearance: 'none',
            textAlign: 'start',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: '100%',
            padding: '11px 14px',
            background: 'transparent',
            border: 'none',
            color: C.text,
            ...(i > 0 ? { borderTop: `1px solid ${C.border}` } : {}),
            ...(it.done ? { opacity: 0.6 } : {}),
          }}
        >
          <span
            aria-hidden
            style={{
              width: 20,
              height: 20,
              flexShrink: 0,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              fontSize: 12,
              fontWeight: 900,
              ...(it.done
                ? { color: '#fff', background: C.okText }
                : { color: C.muted, border: `2px solid ${C.border}` }),
            }}
          >
            {it.done ? '✓' : i + 1}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                display: 'block',
                textDecoration: it.done ? 'line-through' : 'none',
              }}
            >
              {it.label}
            </span>
            <span style={{ display: 'block', fontSize: 11.5, color: C.muted }}>
              {it.hint}
            </span>
          </span>
          {!it.done ? (
            <span
              style={{
                fontSize: 12,
                color: C.accent,
                fontWeight: 700,
                whiteSpace: 'nowrap',
              }}
            >
              Faire →
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Overview section — KPI cards, charts, recent orders, low stock, top products.
// ---------------------------------------------------------------------------

const Overview = ({
  slug,
  summary,
  currency,
  onGoTo,
}: {
  slug: string;
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
      {/* First-run checklist — self-hides once complete or dismissed. */}
      <FiveSteps slug={slug} summary={summary} onGoTo={onGoTo} />

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
          label="CA du mois"
          value={fmtDZD(k.revenueMonth, currency)}
          hint="Commandes livrées uniquement"
          color={C.okText}
        />
        <KpiCard
          icon="⏳"
          label="Commandes en attente"
          value={String(k.pendingCount)}
          hint="Nouvelle + Confirmée"
        />
        <KpiCard
          icon="🧺"
          label="Panier moyen"
          value={fmtDZD(k.avgBasket, currency)}
          hint="Sur commandes livrées"
        />
        <KpiCard
          icon="💸"
          label="Dépenses"
          value={fmtDZD(k.expensesMonth, currency)}
          hint="Ce mois-ci"
          color="#e8a33d"
        />
        <KpiCard
          icon="📈"
          label="Marge"
          value={fmtDZD(k.margin, currency)}
          hint="Revenue − expenses"
          color={
            k.margin >= 0 ? C.okText : 'var(--affine-error-color, #eb4b4b)'
          }
        />
        <KpiCard
          icon="📦"
          label="Stock bas"
          value={String(k.lowStockCount)}
          hint="Au seuil de réappro ou en dessous"
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
        <Panel title="CA livré — 14 derniers jours">
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
                  Rien de livré sur les 14 derniers jours pour le moment.
                </div>
              ) : null}
            </>
          )}
        </Panel>
        <Panel title="Commandes par statut">
          {!hasAnyOrder ? (
            <EmptyNote>
              Aucune commande pour le moment — partagez le lien de votre boutique pour commencer à vendre.
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
                Gérer →
              </button>
            }
          >
            {summary.recentOrders.length === 0 ? (
              <EmptyNote>
                Aucune commande pour le moment — partagez le lien de votre boutique pour commencer à vendre.
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
                      {['Réf', 'Date', 'Client', 'Wilaya', 'Total', 'Statut'].map(
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
                Gérer →
              </button>
            }
          >
            {summary.lowStock.length === 0 ? (
              <EmptyNote>
                Tous les produits sont au-dessus de leur seuil de réappro.
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

          <Panel title="Top produits">
            {summary.topProducts.length === 0 ? (
              <EmptyNote>Aucune vente livrée pour le moment.</EmptyNote>
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
