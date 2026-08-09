import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Switch } from '../../../components/ui/switch';
import { FeatureType } from '@affine/graphql';
import { Suspense } from 'react';

import {
  USER_APPS,
  useUserAppEntitlements,
  useUserAppMutations,
  type UserAppKey,
} from '../app-entitlements';
import type { UserType } from '../schema';

/**
 * Inner content that calls the suspense-mode `useUserAppEntitlements` hook.
 * Rendered inside a <Suspense> boundary by the parent dialog so the SWR
 * suspense doesn't crash the dialog.
 */
const AppAccessContent = ({ user }: { user: UserType }) => {
  const { entitlements } = useUserAppEntitlements(user.id);
  const { grant, revoke, mutating } = useUserAppMutations(user.id);
  const isAdmin = user.features.includes(FeatureType.Admin);

  // Build a lookup of active entitlements by app key.
  const activeMap = new Map<string, boolean>();
  for (const e of entitlements) {
    activeMap.set(e.app, e.active);
  }

  return (
    <div className="flex flex-col gap-3 mt-2">
      {USER_APPS.map(({ key, label }) => {
        const active = isAdmin || activeMap.get(key) === true;
        return (
          <div
            key={key}
            className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5"
          >
            <div className="flex flex-col">
              <span className="text-sm font-medium">{label}</span>
              {isAdmin ? (
                <span className="text-xs text-muted-foreground">
                  Admin — toujours actif
                </span>
              ) : active ? (
                <span className="text-xs text-muted-foreground">Actif</span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Inactif
                </span>
              )}
            </div>
            <Switch
              checked={active}
              disabled={isAdmin || mutating}
              onCheckedChange={checked => {
                if (checked) {
                  void grant(key as UserAppKey, 'standard');
                } else {
                  void revoke(key as UserAppKey);
                }
              }}
              aria-label={label}
            />
          </div>
        );
      })}
    </div>
  );
};

export function AppAccessDialog({
  user,
  open,
  onOpenChange,
}: {
  user: UserType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Accès aux applications</DialogTitle>
          <DialogDescription>
            {`${user.name ?? user.email} — activez ou désactivez l\u{2019}accès aux applications.`}
          </DialogDescription>
        </DialogHeader>
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              Chargement...
            </div>
          }
        >
          <AppAccessContent user={user} />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}
