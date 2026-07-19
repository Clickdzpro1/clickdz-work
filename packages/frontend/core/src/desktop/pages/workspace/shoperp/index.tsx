import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import { useCallback, useEffect, useState } from 'react';

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
// new .css.ts. Two states, driven by GET /api/v1/apps/mine:
//   • no apps yet → onboarding wizard (per-user customized shop creation)
//   • apps exist  → management list (open / delete / new shop)
// Every button hits the real /api/v1/apps/* backend — nothing is stubbed.
// ---------------------------------------------------------------------------

type LoadState = 'loading' | 'ready' | 'error';

const ShopErpPage = () => {
  const [state, setState] = useState<LoadState>('loading');
  const [apps, setApps] = useState<MineApp[]>([]);
  // When true, force the wizard even though apps already exist ("New shop").
  const [forceWizard, setForceWizard] = useState(false);

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

  const hasApps = apps.length > 0;
  const showWizard = state === 'ready' && (!hasApps || forceWizard);

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
              maxWidth: 960,
              margin: '0 auto',
              padding: '28px 24px 48px',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                Launch an online store — cash-on-delivery, WhatsApp checkout —
                and manage it alongside a paired ERP dashboard.
              </p>
            </header>

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
            ) : (
              <ManageView
                apps={apps}
                onNewShop={() => setForceWizard(true)}
                onChanged={() => void load()}
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
