import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type DashboardSection, ErpDashboard } from './dashboard';
import { ManageView } from './manage';
import {
  Banner,
  C,
  fetchMyApps,
  linkBtnStyle,
  type MineApp,
  Spinner,
} from './shoperp-shared';
import { ShopWizard } from './wizard';

// ---------------------------------------------------------------------------
// ClickDz ShopERP — a real, end-to-end surface for creating and managing online
// shops (+ their paired ERP dashboards). Follows the Integrations page scaffold
// exactly: ViewTitle/ViewIcon/ViewHeader/ViewBody + inline styles, no i18n, no
// new .css.ts. States, driven by GET /api/v1/apps/mine:
//   • no apps yet → onboarding wizard (per-user customized shop creation)
//   • exactly one shop (provisioned) → jump STRAIGHT into that store's managed
//     dashboard (the studio home) — no manage-list detour
//   • multiple apps → management list (dashboard / open / delete / new shop)
//   • store selected → in-app ERP dashboard (live KPIs + orders / stock /
//     clients / appearance / settings over the store's data namespace)
// The auto-open is one-shot: once the user hits "← Shops" they land on the
// manage list and stay there (we don't fight their navigation).
// Every button hits the real /api/v1/apps/* backend — nothing is stubbed.
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

const ShopErpPage = () => {
  const [state, setState] = useState<LoadState>('loading');
  const [apps, setApps] = useState<MineApp[]>([]);
  // When true, force the wizard even though apps already exist ("New shop").
  const [forceWizard, setForceWizard] = useState(false);
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
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // After a successful creation: leave the wizard and refetch the list.
  const handleWizardDone = useCallback(() => {
    setForceWizard(false);
    void load();
  }, [load]);

  // Enter/leave the in-app dashboard (mutually exclusive with the wizard).
  const openDashboard = useCallback(
    (slug: string, section: DashboardSection = 'overview', url?: string) => {
      setForceWizard(false);
      setDashboard({ slug, section, ...(url ? { url } : {}) });
    },
    []
  );
  // Once the user leaves the dashboard we go to the manage list and STAY there
  // (guard flips so the one-shot auto-open below won't yank them back in).
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
      autoTarget
    ) {
      autoOpenedRef.current = true;
      openDashboard(autoTarget.slug, 'overview', autoTarget.url);
    }
  }, [state, forceWizard, dashboard, autoTarget, openDashboard]);

  const hasApps = apps.length > 0;
  const showWizard = state === 'ready' && (!hasApps || forceWizard);
  const showDashboard = state === 'ready' && !showWizard && dashboard !== null;

  return (
    <>
      <ViewTitle title="Shop ERP" />
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
          <span style={{ fontSize: 16 }}>🛍️</span>
          Shop ERP
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
          <div
            style={{
              // The dashboard benefits from a wider canvas; the wizard and
              // management list keep their original measure.
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
                  <span aria-hidden>🛍️</span> Shop ERP
                </h1>
                <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
                  Launch an online store — cash-on-delivery, WhatsApp checkout
                  — and manage it alongside a paired ERP dashboard.
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
                <Spinner /> Loading your shops…
              </div>
            ) : state === 'error' ? (
              <Banner tone="error">
                Couldn&apos;t load your shops.{' '}
                <button style={linkBtnStyle} onClick={() => void load()}>
                  Retry
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
              <ManageView
                apps={apps}
                onNewShop={() => setForceWizard(true)}
                onChanged={() => void load()}
                onOpenDashboard={openDashboard}
              />
            )}
          </div>
        </div>
      </ViewBody>
    </>
  );
};

export const Component = () => {
  return <ShopErpPage />;
};
