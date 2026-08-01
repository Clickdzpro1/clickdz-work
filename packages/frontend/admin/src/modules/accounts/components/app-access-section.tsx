import { Separator } from '@affine/admin/components/ui/separator';
import { Switch } from '@affine/admin/components/ui/switch';
import { Badge } from '@affine/admin/components/ui/badge';
import { Suspense, useMemo } from 'react';

import {
  type UserAppEntitlement,
  USER_APPS,
  useUserAppEntitlements,
  useUserAppMutations,
} from '../app-entitlements';

const dateFormatter = new Intl.DateTimeFormat('fr-FR', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

function formatExpiry(expiresAt?: string | null) {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return null;
  return dateFormatter.format(date);
}

function AppAccessSectionContent({ userId }: { userId: string }) {
  const { entitlements } = useUserAppEntitlements(userId);
  const { grant, revoke, mutating } = useUserAppMutations(userId);

  const byApp = useMemo(() => {
    const map = new Map<string, UserAppEntitlement>();
    for (const entitlement of entitlements) {
      map.set(entitlement.app, entitlement);
    }
    return map;
  }, [entitlements]);

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="p-3">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Accès aux applications
        </div>
      </div>
      <Separator />
      {USER_APPS.map((app, index) => {
        const entitlement = byApp.get(app.key);
        const active = entitlement?.active ?? false;
        const plan = entitlement?.plan ?? null;
        const expiry = formatExpiry(entitlement?.expiresAt);

        return (
          <div key={app.key}>
            <div className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {app.label}
                  </span>
                  <Badge variant={active ? 'default' : 'secondary'}>
                    {active ? 'Actif' : 'Inactif'}
                  </Badge>
                </div>
                {active && (plan || expiry) ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {plan ? `Plan: ${plan}` : null}
                    {plan && expiry ? ' • ' : null}
                    {expiry ? `Expire le ${expiry}` : null}
                  </div>
                ) : null}
              </div>
              <Switch
                checked={active}
                disabled={mutating}
                aria-label={`${active ? 'Révoquer' : 'Accorder'} ${app.label}`}
                onCheckedChange={checked => {
                  if (checked) {
                    void grant(app.key);
                  } else {
                    void revoke(app.key);
                  }
                }}
              />
            </div>
            {index < USER_APPS.length - 1 ? <Separator /> : null}
          </div>
        );
      })}
    </div>
  );
}

export function AppAccessSection({ userId }: { userId: string }) {
  return (
    <Suspense
      fallback={
        <div className="rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground shadow-sm">
          Chargement des accès aux applications…
        </div>
      }
    >
      <AppAccessSectionContent userId={userId} />
    </Suspense>
  );
}
