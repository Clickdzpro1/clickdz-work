import { useCallback, useState } from 'react';

import {
  Banner,
  btnStyle,
  C,
  deleteApp,
  KindBadge,
  type MineApp,
  Spinner,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// ShopERP management view — the state shown when the user already has published
// apps. Lists them (from GET /api/v1/apps/mine) with Shop/ERP/App badges, the
// paired storeSlug, an open-in-browser link, and a confirm-gated delete
// (DELETE /api/v1/apps/:slug). "New shop" re-enters the onboarding wizard.
// ---------------------------------------------------------------------------

export const ManageView = ({
  apps,
  onNewShop,
  onChanged,
}: {
  apps: MineApp[];
  onNewShop: () => void;
  // Called after a delete so the parent can refetch /apps/mine.
  onChanged: () => void;
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
            Your shops &amp; apps
          </div>
          <div style={{ fontSize: 12.5, color: C.muted }}>
            {apps.length} published {apps.length === 1 ? 'app' : 'apps'}
          </div>
        </div>
        <button style={btnStyle('primary')} onClick={onNewShop}>
          + New shop
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
              <AppRow key={app.slug} app={app} onChanged={onChanged} />
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
}: {
  app: MineApp;
  onChanged: () => void;
  grouped?: boolean;
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
        setError('Could not delete this app. Please try again.');
        setDeleting(false);
      }
    } catch {
      setError('Network error while deleting.');
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
            {app.url || '(no URL)'}
          </a>
        </div>
        {app.url ? (
          <a
            href={app.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...btnStyle('secondary'), textDecoration: 'none' }}
          >
            Open ↗
          </a>
        ) : null}
        {!confirming ? (
          <button
            style={btnStyle('secondary')}
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${app.slug}`}
            title="Delete"
          >
            🗑
          </button>
        ) : null}
      </div>

      {confirming ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Banner tone="error">
            Permanently unpublish <strong>{app.slug}</strong>? The live URL will
            stop working. This can’t be undone.
          </Banner>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              style={btnStyle('danger', deleting)}
              disabled={deleting}
              onClick={() => void doDelete()}
            >
              {deleting ? (
                <>
                  <Spinner /> Deleting…
                </>
              ) : (
                'Yes, delete'
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
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? <Banner tone="error">{error}</Banner> : null}
    </div>
  );
};
