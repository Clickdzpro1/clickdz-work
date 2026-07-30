import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { PENDING_SHOP_KEY } from '../../clickdz-welcome';
import { type DashboardSection, ErpDashboard } from './dashboard';
import { ManageView } from './manage';
import {
  Banner,
  btnStyle,
  C,
  ensureShoperpResponsiveCss,
  fetchAppFeatures,
  fetchErpSummary,
  fetchMyApps,
  type ErpSettings,
  linkBtnStyle,
  type MineApp,
  resolveFont,
  resolveTemplate,
  resolveTheme,
  Spinner,
} from './shoperp-shared';
import { ShopWizard } from './wizard';

// ---------------------------------------------------------------------------
// ClickDz ShopERP — the create-and-manage surface for online shops (+ their
// paired ERP). Follows the Integrations scaffold (ViewTitle/…/ViewBody + inline
// styles, no i18n, no .css.ts). States, driven by GET /api/v1/apps/mine:
//   • no apps yet → the Ready-Shop v2 HOME: one primary CTA "Créer ma boutique"
//     that opens the (existing, gallery-enabled) wizard, framed with what the
//     owner gets — instead of dropping cold into the wizard.
//   • exactly one shop (provisioned) → jump STRAIGHT into that store's managed
//     dashboard (the studio home) on first arrival — no hub detour.
//   • user left the dashboard (← Shops) → the HOME hub: primary CTA + a compact
//     "checklist de démarrage" for the primary shop + the existing manage list
//     of every app (secondary cards). We don't fight their navigation.
// After a successful creation we open the new shop's dashboard, where the
// first-visit GUIDED TOUR auto-starts (localStorage-gated per slug — the tour
// component + its dashboard hookup own that; see shop-tour.tsx / NOTES). Every
// button hits the real /api/v1/apps/* backend — nothing is stubbed.
// ---------------------------------------------------------------------------

type LoadState = 'loading' | 'ready' | 'error';

// The store to auto-open for a provisioned user: prefer a single `kind:'shop'`.
// The dashboard's namespace is the store's slug, which is the `storeSlug`
// pairing key when present (a shop + its ERP share it), else the shop's own
// slug. Returns null when there isn't exactly one shop to open unambiguously.
function singleShopTarget(
  apps: MineApp[]
): { slug: string; url?: string } | null {
  const shops = apps.filter(a => a.kind === 'shop');
  // Exactly one shop → open it. (A shop + its paired ERP is still ONE shop.)
  if (shops.length === 1) {
    const shop = shops[0];
    const slug = shop.storeSlug || shop.slug;
    return { slug, ...(shop.url ? { url: shop.url } : {}) };
  }
  // No labeled shop but a single app total (legacy unlabeled) → open that.
  if (shops.length === 0 && apps.length === 1 && apps[0].kind !== 'erp') {
    const only = apps[0];
    return {
      slug: only.storeSlug || only.slug,
      ...(only.url ? { url: only.url } : {}),
    };
  }
  return null;
}

// The "primary shop" for the hub checklist: the newest shop-kind app (falls
// back to the newest app of any kind). Used only to seed the checklist + its
// deep-links — never to auto-open (that stays the single-shop rule above).
function primaryShop(apps: MineApp[]): MineApp | null {
  const byNewest = [...apps].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  );
  return (
    byNewest.find(a => a.kind === 'shop') ??
    byNewest.find(a => a.kind !== 'erp') ??
    byNewest[0] ??
    null
  );
}

const ShopErpPage = () => {
  const [state, setState] = useState<LoadState>('loading');
  const [apps, setApps] = useState<MineApp[]>([]);
  // When true, force the wizard even though apps already exist ("New shop").
  const [forceWizard, setForceWizard] = useState(false);
  // Set right after a creation so the reload handler opens the new shop's
  // dashboard (where the first-visit tour auto-starts) instead of the hub.
  const justCreatedRef = useRef(false);
  // Non-null → the in-app ERP dashboard for that store is open.
  const [dashboard, setDashboard] = useState<{
    slug: string;
    section: DashboardSection;
    url?: string;
  } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const list = await fetchMyApps();
      setApps(list);
      setState('ready');
      return list;
    } catch {
      setState('error');
      return [] as MineApp[];
    }
  }, []);

  // Inject the mobile-responsive stylesheet once per document mount. Idempotent.
  useEffect(() => {
    ensureShoperpResponsiveCss();
  }, []);

  useEffect(() => {
    void (async () => {
      const list = await load();
      // Straight from /welcome: the merchant already gave us their shop name
      // and WhatsApp number, so skip the hub's "Créer ma boutique" detour and
      // open the wizard prefilled. The handoff key is consumed by the wizard
      // itself (readPendingShop), so this only ever fires on the real first run.
      try {
        if (
          list.length === 0 &&
          globalThis.localStorage?.getItem(PENDING_SHOP_KEY)
        ) {
          setForceWizard(true);
        }
      } catch {
        /* storage unavailable — the hub CTA is a perfectly good fallback */
      }
    })();
  }, [load]);

  // Enter/leave the in-app dashboard (mutually exclusive with the wizard).
  const openDashboard = useCallback(
    (slug: string, section: DashboardSection = 'overview', url?: string) => {
      setForceWizard(false);
      setDashboard({ slug, section, ...(url ? { url } : {}) });
    },
    []
  );

  // After a successful creation: leave the wizard, refetch, then open the new
  // shop's dashboard so the first-visit guided tour kicks in there.
  const handleWizardDone = useCallback(() => {
    setForceWizard(false);
    justCreatedRef.current = true;
    void (async () => {
      const list = await load();
      const target = singleShopTarget(list) ?? (() => {
        const p = primaryShop(list);
        return p ? { slug: p.storeSlug || p.slug, url: p.url } : null;
      })();
      if (target) {
        autoOpenedRef.current = true;
        openDashboard(target.slug, 'overview', target.url);
      }
      justCreatedRef.current = false;
    })();
  }, [load, openDashboard]);

  // Once the user leaves the dashboard we go to the hub and STAY there (guard
  // flips so the one-shot auto-open below won't yank them back in).
  const autoOpenedRef = useRef(false);
  const closeDashboard = useCallback(() => {
    autoOpenedRef.current = true;
    setDashboard(null);
  }, []);

  // Provisioned single-shop user → auto-open their store as the studio home.
  const autoTarget = useMemo(() => singleShopTarget(apps), [apps]);
  useEffect(() => {
    if (
      state === 'ready' &&
      !forceWizard &&
      dashboard === null &&
      !autoOpenedRef.current &&
      !justCreatedRef.current &&
      autoTarget
    ) {
      autoOpenedRef.current = true;
      openDashboard(autoTarget.slug, 'overview', autoTarget.url);
    }
  }, [state, forceWizard, dashboard, autoTarget, openDashboard]);

  const hasApps = apps.length > 0;
  // The wizard shows only when the user explicitly asks to create (empty-state
  // CTA or "New shop") — the empty state is now the Ready-Shop HOME, not the
  // bare wizard, so first-time users get the framed CTA + preview first.
  const showWizard = state === 'ready' && forceWizard;
  const showDashboard = state === 'ready' && !showWizard && dashboard !== null;
  // (No `showHome` constant: the render below is an if/else chain, so "home"
  // is simply its final branch. A derived flag for it was dead code and
  // tripped noUnusedLocals.)

  const primary = useMemo(() => primaryShop(apps), [apps]);

  return (
    <>
      <ViewTitle title="DzOS" />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: '100%',
            padding: '0 16px',
            fontSize: 14,
            fontWeight: 600,
            color: C.text,
          }}
        >
          <span style={{ fontSize: 16 }}>⚡</span>
          DzOS
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '15px',
              padding: '0 6px',
              borderRadius: 5,
              letterSpacing: '0.05em',
              color: C.muted,
              backgroundColor:
                'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)',
            }}
          >
            béta
          </span>
        </div>
      </ViewHeader>
      <ViewBody>
        <div
          style={{
            height: '100%',
            width: '100%',
            overflow: 'auto',
            background: C.bg,
            color: C.text,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {/* cdz-page-wrap: targeted by the responsive stylesheet (12 px side
               padding at ≤600 px, 24 px above — see ensureShoperpResponsiveCss). */}
          <div
            className="cdz-page-wrap"
            style={{
              // The dashboard benefits from a wider canvas; the wizard and hub
              // keep their original measure.
              maxWidth: showDashboard ? 1120 : 960,
              margin: '0 auto',
              padding: '28px 24px 48px',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            {showDashboard ? null : (
              <header
                style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                <h1
                  style={{
                    margin: 0,
                    fontSize: 24,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: C.text,
                  }}
                >
                  <span aria-hidden>⚡</span> DzOS
                </h1>
                <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
                  Lancez votre business en ligne — encaissement à la livraison,
                  commandes WhatsApp — le tout géré par DzOS.
                </p>
              </header>
            )}

            {/* State machine ------------------------------------------------ */}
            {state === 'loading' ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '28px 4px',
                  color: C.muted,
                }}
              >
                <Spinner /> Chargement de vos boutiques…
              </div>
            ) : state === 'error' ? (
              <Banner tone="error">
                Impossible de charger vos boutiques.{' '}
                <button style={linkBtnStyle} onClick={() => void load()}>
                  Réessayer
                </button>
              </Banner>
            ) : showWizard ? (
              <ShopWizard
                hasExistingApps={hasApps}
                onDone={handleWizardDone}
                onCancel={hasApps ? () => setForceWizard(false) : undefined}
              />
            ) : showDashboard && dashboard ? (
              <ErpDashboard
                // Remount per store so no state leaks between shops.
                key={dashboard.slug}
                slug={dashboard.slug}
                url={dashboard.url}
                initialSection={dashboard.section}
                onBack={closeDashboard}
              />
            ) : (
              <ReadyShopHome
                apps={apps}
                primary={primary}
                onCreate={() => setForceWizard(true)}
                onOpenDashboard={openDashboard}
                onChanged={() => void load()}
              />
            )}
          </div>
        </div>
      </ViewBody>
    </>
  );
};

// ---------------------------------------------------------------------------
// Ready-Shop v2 HOME — the entry hub. A single, unmistakable primary CTA that
// opens the existing wizard (which already carries the template gallery step),
// a compact "checklist de démarrage" for the primary shop (best-effort, each
// item deep-links to its dashboard tab), and — when apps exist — the existing
// management list below as the secondary app cards (unchanged behavior).
// ---------------------------------------------------------------------------

const ReadyShopHome = ({
  apps,
  primary,
  onCreate,
  onOpenDashboard,
  onChanged,
}: {
  apps: MineApp[];
  primary: MineApp | null;
  onCreate: () => void;
  onOpenDashboard: (slug: string, section?: DashboardSection, url?: string) => void;
  onChanged: () => void;
}) => {
  const hasApps = apps.length > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Primary CTA card */}
      <div
        style={{
          borderRadius: 16,
          border: `1px solid ${C.border}`,
          background: `linear-gradient(135deg, ${C.accentSoft}, transparent)`,
          padding: '22px 22px',
          display: 'flex',
          gap: 18,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 800, color: C.text }}>
            {hasApps ? 'Créer une autre boutique' : 'Créez votre boutique en ligne'}
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 13.5, color: C.muted, lineHeight: 1.55 }}>
            Choisissez un modèle adapté à votre activité, personnalisez couleurs
            et WhatsApp, et publiez en quelques secondes — avec un ERP assorti.
          </p>
          <div dir="rtl" style={{ marginTop: 6, fontSize: 12.5, color: C.muted }}>
            دير حانوتك على الأنترنت فدقايق — بالدفع عند الاستلام و الطلب عبر واتساب.
          </div>
        </div>
        <button
          style={{ ...btnStyle('primary'), fontSize: 15, padding: '12px 22px' }}
          onClick={onCreate}
        >
          🛍️ Créer ma boutique
        </button>
      </div>

      {/* Checklist de démarrage (only meaningful once a shop exists) */}
      {hasApps && primary ? (
        <StartChecklist
          apps={apps}
          primary={primary}
          onOpenDashboard={onOpenDashboard}
        />
      ) : (
        <ChecklistPreview />
      )}

      {/* Secondary cards: the existing management list (unchanged behavior). */}
      {hasApps ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={sectionTitleStyle}>Vos applications</div>
          <ManageView
            apps={apps}
            onNewShop={onCreate}
            onChanged={onChanged}
            onOpenDashboard={onOpenDashboard}
          />
        </div>
      ) : null}
    </div>
  );
};

// One checklist row spec: an id, label, the tab it deep-links to, and a hint.
interface ChecklistItem {
  id: string;
  label: string;
  section: DashboardSection;
  done: boolean | null; // null = unknown (best-effort couldn't determine)
  hint: string;
}

const StartChecklist = ({
  apps,
  primary,
  onOpenDashboard,
}: {
  apps: MineApp[];
  primary: MineApp;
  onOpenDashboard: (slug: string, section?: DashboardSection, url?: string) => void;
}) => {
  const slug = primary.storeSlug || primary.slug;
  const [settings, setSettings] = useState<ErpSettings | null>(null);
  const [signals, setSignals] = useState<{
    hasProducts: boolean | null;
    hasFeatures: boolean | null;
  }>({ hasProducts: null, hasFeatures: null });
  const [loading, setLoading] = useState(true);

  // Best-effort, non-blocking: pull the summary (settings + product activity)
  // and the feature state in parallel. Any failure leaves that item "unknown"
  // (unchecked, still clickable) — the checklist never blocks the hub.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const [sum, feat] = await Promise.all([
        fetchErpSummary(slug),
        fetchAppFeatures(slug),
      ]);
      if (!alive) return;
      if (sum.status === 'ok') {
        setSettings(sum.summary.settings);
        const k = sum.summary.kpis;
        const hasProducts =
          k.lowStockCount > 0 ||
          k.ordersTotal > 0 ||
          sum.summary.topProducts.length > 0 ||
          sum.summary.lowStock.length > 0 ||
          sum.summary.recentOrders.length > 0;
        setSignals(s => ({ ...s, hasProducts }));
      } else {
        setSignals(s => ({ ...s, hasProducts: null }));
      }
      if (feat.status === 'ok') {
        setSignals(s => ({ ...s, hasFeatures: feat.state.features.length > 0 }));
      } else {
        setSignals(s => ({ ...s, hasFeatures: null }));
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  // "app équipe" = the paired ERP back-office exists in the account.
  const hasErp = useMemo(
    () =>
      apps.some(
        a =>
          a.kind === 'erp' &&
          (a.storeSlug === (primary.storeSlug || primary.slug) ||
            a.storeSlug === primary.slug)
      ),
    [apps, primary]
  );

  // Appearance is "chosen" once any preset diverges from the byte-default look.
  const appearanceChosen = useMemo(() => {
    if (!settings) return null;
    const themed = resolveTheme(settings.theme).id !== 'classic';
    const templated = resolveTemplate(settings.template).id !== 'standard';
    const fonted = resolveFont(settings.font).id !== 'system';
    const accented =
      typeof settings.accent === 'string' &&
      settings.accent.toLowerCase() !== '#0f766e';
    return themed || templated || fonted || accented;
  }, [settings]);

  const deliveryConfigured = useMemo(() => {
    if (!settings) return null;
    return typeof settings.deliveryFee === 'number' && settings.deliveryFee > 0;
  }, [settings]);

  const items: ChecklistItem[] = [
    {
      id: 'products',
      label: 'Produits ajoutés',
      section: 'stock',
      done: signals.hasProducts,
      hint: 'Ajoutez vos articles, prix et photos.',
    },
    {
      id: 'appearance',
      label: 'Apparence choisie',
      section: 'appearance',
      done: appearanceChosen,
      hint: 'Thème, couleurs, police et sections.',
    },
    {
      id: 'features',
      label: 'Fonctionnalités',
      section: 'features',
      done: signals.hasFeatures,
      hint: 'Activez les modules dont vous avez besoin.',
    },
    {
      id: 'shipping',
      label: 'Livraison configurée',
      // R3 adds the 'livraison' (shipping) tab; falls back gracefully if absent.
      section: 'shipping' as DashboardSection,
      done: deliveryConfigured,
      hint: 'Transporteurs et tarifs des 58 wilayas.',
    },
    {
      id: 'team',
      label: 'App équipe',
      // R3 adds the 'équipe' (team) tab; the paired ERP app is the signal here.
      section: 'team' as DashboardSection,
      done: hasErp,
      hint: 'Votre ERP + les accès de vos employés.',
    },
  ];

  const doneCount = items.filter(i => i.done === true).length;

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
          padding: '11px 16px',
          background: C.panel2,
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        <span style={{ fontSize: 15 }} aria-hidden>
          ✅
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>
            Checklist de démarrage
          </div>
          <div style={{ fontSize: 11.5, color: C.muted }}>
            {loading
              ? 'Vérification…'
              : `${doneCount}/${items.length} · finalisez votre boutique`}
          </div>
        </div>
        {primary.url ? (
          <a
            href={primary.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...linkBtnStyle, fontWeight: 700 }}
          >
            Voir la boutique ↗
          </a>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {items.map((it, i) => (
          <button
            key={it.id}
            type="button"
            onClick={() => onOpenDashboard(slug, it.section, primary.url)}
            style={{
              appearance: 'none',
              textAlign: 'left',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '11px 16px',
              background: 'transparent',
              border: 'none',
              color: C.text,
              ...(i > 0 ? { borderTop: `1px solid ${C.border}` } : {}),
            }}
          >
            <CheckDot done={it.done} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
                {it.label}
              </span>
              <span style={{ display: 'block', fontSize: 11.5, color: C.muted }}>
                {it.hint}
              </span>
            </span>
            <span style={{ fontSize: 12, color: C.accent, fontWeight: 700, whiteSpace: 'nowrap' }}>
              {it.done === true ? 'Modifier' : 'Configurer'} →
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

// A tri-state check indicator: done (✓), not done (empty ring), unknown (dash).
const CheckDot = ({ done }: { done: boolean | null }) => {
  if (done === true) {
    return (
      <span
        aria-label="fait"
        style={{
          width: 20,
          height: 20,
          flexShrink: 0,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          color: '#fff',
          fontSize: 12,
          fontWeight: 900,
          background: C.okText,
        }}
      >
        ✓
      </span>
    );
  }
  return (
    <span
      aria-label={done === false ? 'à faire' : 'inconnu'}
      style={{
        width: 20,
        height: 20,
        flexShrink: 0,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        fontSize: 11,
        color: C.muted,
        border: `2px solid ${C.border}`,
        background: 'transparent',
      }}
    >
      {done === false ? '' : '·'}
    </span>
  );
};

// The empty-state preview of the checklist (shown before any shop exists) —
// purely illustrative so the first-time user sees what's coming, non-clickable.
const ChecklistPreview = () => {
  const rows = [
    'Produits ajoutés',
    'Apparence choisie',
    'Fonctionnalités',
    'Livraison configurée',
    'App équipe',
  ];
  return (
    <div
      style={{
        borderRadius: 14,
        border: `1px dashed ${C.border}`,
        background: 'transparent',
        padding: '14px 16px',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 800, color: C.muted, marginBottom: 8 }}>
        VOTRE CHECKLIST DE DÉMARRAGE
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {rows.map(r => (
          <span
            key={r}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 12,
              fontWeight: 600,
              color: C.muted,
              padding: '6px 11px',
              borderRadius: 999,
              border: `1px solid ${C.border}`,
              background: C.panel,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                border: `2px solid ${C.border}`,
              }}
            />
            {r}
          </span>
        ))}
      </div>
    </div>
  );
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: C.muted,
};

export const Component = () => {
  return <ShopErpPage />;
};
