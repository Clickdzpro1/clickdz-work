import { useCallback, useState } from 'react';

import {
  Banner,
  btnStyle,
  C,
  deleteApp,
  KindBadge,
  type MineApp,
  miniBtnStyle,
  Spinner,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// ShopERP management view — the state shown when the user already has published
// apps. Lists them (from GET /api/v1/apps/mine) with Shop/ERP/App badges, the
// paired storeSlug, an open-in-browser link, and a confirm-gated delete
// (DELETE /api/v1/apps/:slug). Each store group also gets Dashboard / Manage
// actions that open the IN-APP ERP dashboard for that storeSlug (the slug is
// the store's data namespace). "New shop" re-enters the onboarding wizard.
// ---------------------------------------------------------------------------

// Prefer the storefront URL for the dashboard's "Open live" link.
const pickShopUrl = (group: MineApp[]): string | undefined => {
  const shop = group.find(a => a.kind === 'shop' && !!a.url);
  return (shop ?? group.find(a => !!a.url))?.url || undefined;
};

export const ManageView = ({
  apps,
  onNewShop,
  onChanged,
  onOpenDashboard,
}: {
  apps: MineApp[];
  onNewShop: () => void;
  // Called after a delete so the parent can refetch /apps/mine.
  onChanged: () => void;
  // Opens the in-app ERP dashboard for a store (slug == data namespace).
  onOpenDashboard: (
    slug: string,
    section?: 'overview' | 'orders',
    url?: string
  ) => void;
}) => {
  // Group by storeSlug so a shop + its ERP sit together; unpaired apps last.
  const paired = new Map<string, MineApp[]>();
  const loose: MineApp[] = [];
  for (const app of apps) {
    if (app.storeSlug) {
      const arr = paired.get(app.storeSlug) ?? [];
      arr.push(app);
      paired.set(app.storeSlug, arr);
    } else {
      loose.push(app);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
            Vos boutiques &amp; applications
          </div>
          <div style={{ fontSize: 12.5, color: C.muted }}>
            {apps.length} publié{apps.length === 1 ? '' : 'es'} {apps.length === 1 ? 'application' : 'applications'}
          </div>
        </div>
        <button style={btnStyle('primary')} onClick={onNewShop}>
          + Nouvelle boutique
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {[...paired.entries()].map(([storeSlug, group]) => (
          <div
            key={storeSlug}
            style={{
              borderRadius: 12,
              background: C.panel,
              border: `1px solid ${C.border}`,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 14px',
                borderBottom: `1px solid ${C.border}`,
                background: C.panel2,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: C.muted,
              }}
            >
              <span aria-hidden>🔗</span>
              Store · {storeSlug}
              {/* Reset the header's uppercase/tracking for the action cluster */}
              <div
                style={{
                  marginLeft: 'auto',
                  display: 'flex',
                  gap: 6,
                  textTransform: 'none',
                  letterSpacing: 'normal',
                  fontWeight: 400,
                  flexShrink: 0,
                }}
              >
                <button
                  style={miniBtnStyle('primary')}
                  onClick={() =>
                    onOpenDashboard(storeSlug, 'overview', pickShopUrl(group))
                  }
                  title="Ouvrir le tableau de bord ERP intégré"
                >
                  📊 Tableau de bord
                </button>
                <button
                  style={miniBtnStyle('secondary')}
                  onClick={() =>
                    onOpenDashboard(storeSlug, 'orders', pickShopUrl(group))
                  }
                  title="Gérer commandes, stock et réglages ici"
                >
                  Gérer
                </button>
              </div>
            </div>
            {group.map(app => (
              <AppRow key={app.slug} app={app} onChanged={onChanged} grouped />
            ))}
          </div>
        ))}

        {loose.length > 0 ? (
          <div
            style={{
              borderRadius: 12,
              background: C.panel,
              border: `1px solid ${C.border}`,
              overflow: 'hidden',
            }}
          >
            {loose.map(app => (
              <AppRow
                key={app.slug}
                app={app}
                onChanged={onChanged}
                // An unpaired shop/ERP's own slug IS its data namespace.
                onOpenDashboard={
                  app.kind === 'shop' || app.kind === 'erp'
                    ? () =>
                        onOpenDashboard(
                          app.slug,
                          'overview',
                          app.url || undefined
                        )
                    : undefined
                }
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const AppRow = ({
  app,
  onChanged,
  grouped = false,
  onOpenDashboard,
}: {
  app: MineApp;
  onChanged: () => void;
  grouped?: boolean;
  // Present only for unpaired shop/ERP rows (groups get header-level actions).
  onOpenDashboard?: () => void;
}) => {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      const ok = await deleteApp(app.slug);
      if (ok) {
        onChanged();
      } else {
        setError('Impossible de supprimer cette application. Réessayez.');
        setDeleting(false);
      }
    } catch {
      setError('Erreur réseau pendant la suppression.');
      setDeleting(false);
    }
  }, [app.slug, onChanged]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        ...(grouped ? { borderTop: `1px solid ${C.border}` } : {}),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <KindBadge kind={app.kind} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 700,
              color: C.text,
              fontFamily: 'var(--affine-font-code-family, monospace)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {app.slug}
          </div>
          <a
            href={app.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 12,
              color: C.muted,
              textDecoration: 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'block',
            }}
            title={app.url}
          >
            {app.url || '(pas d’URL)'}
          </a>
        </div>
        {onOpenDashboard ? (
          <button
            style={btnStyle('secondary')}
            onClick={onOpenDashboard}
            title="Ouvrir le tableau de bord ERP intégré"
          >
            📊 Tableau de bord
          </button>
        ) : null}
        {app.url ? (
          <a
            href={app.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...btnStyle('secondary'), textDecoration: 'none' }}
          >
            Ouvrir ↗
          </a>
        ) : null}
        {!confirming ? (
          <button
            style={btnStyle('secondary')}
            onClick={() => setConfirming(true)}
            aria-label={`Supprimer ${app.slug}`}
            title="Supprimer"
          >
            🗑
          </button>
        ) : null}
      </div>

      {confirming ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Banner tone="error">
            Dépublier définitivement <strong>{app.slug}</strong> ? L’URL en ligne ne fonctionnera plus. Cette action est irréversible.
          </Banner>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              style={btnStyle('danger', deleting)}
              disabled={deleting}
              onClick={() => void doDelete()}
            >
              {deleting ? (
                <>
                  <Spinner /> Suppression…
                </>
              ) : (
                'Oui, supprimer'
              )}
            </button>
            <button
              style={btnStyle('secondary', deleting)}
              disabled={deleting}
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              Annuler
            </button>
          </div>
        </div>
      ) : null}

      {error ? <Banner tone="error">{error}</Banner> : null}
    </div>
  );
};
