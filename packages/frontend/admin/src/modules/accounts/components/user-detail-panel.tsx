import { Button } from '@affine/admin/components/ui/button';
import { Separator } from '@affine/admin/components/ui/separator';
import { FeatureType } from '@affine/graphql';
import {
  AccountBanIcon,
  ArrowRightSmallIcon,
  DeleteIcon,
  LockIcon,
} from '@blocksuite/icons/rc';
import { useCallback } from 'react';

import { RightPanelHeader } from '../../header';
import {
  useGrantAdmin,
  useRevokeAdmin,
  useSuspendUser,
} from '../admin-operations';
import { AppAccessSection } from './app-access-section';
import { useEnableUser } from './use-user-management';
import type { UserType } from '../schema';

const dateFormatter = new Intl.DateTimeFormat('fr-FR', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function ProfileRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 p-3">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={`text-sm font-normal ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Rich user detail panel for the admin right panel.
 *
 * Shows: profile info (UUID, created date, email status), feature flags
 * with toggles, app entitlements, and admin actions (suspend, reset
 * password, grant/revoke admin, delete).
 */
export function UserDetailPanel({
  user,
  onComplete,
  onResetPassword,
  onDeleteAccount,
}: {
  user: UserType;
  onComplete: () => void;
  onResetPassword: () => void;
  onDeleteAccount: () => void;
}) {
  const { suspend, suspending } = useSuspendUser();
  const { grantAdmin, granting: grantingAdmin } = useGrantAdmin();
  const { revokeAdmin, revoking: revokingAdmin } = useRevokeAdmin();
  const enableUser = useEnableUser();

  const isAdmin = user.features.includes(FeatureType.Admin);
  const isSuspended = user.disabled;

  const handleSuspend = useCallback(() => {
    suspend(user.id, onComplete);
  }, [suspend, user.id, onComplete]);

  const handleActivate = useCallback(() => {
    enableUser(user.id, onComplete);
  }, [enableUser, user.id, onComplete]);

  const handleGrantAdmin = useCallback(() => {
    grantAdmin(user.id, onComplete);
  }, [grantAdmin, user.id, onComplete]);

  const handleRevokeAdmin = useCallback(() => {
    revokeAdmin(user.id, onComplete);
  }, [revokeAdmin, user.id, onComplete]);

  return (
    <div className="flex h-full flex-col bg-background">
      <RightPanelHeader
        title={`Détails de l\u{2019}utilisateur`}
        handleClose={onComplete}
        handleConfirm={onComplete}
        canSave={false}
      />
      <div className="flex-grow space-y-3 overflow-y-auto p-4">
        {/* Profile info card */}
        <div className="flex flex-col rounded-xl border border-border bg-card shadow-sm">
          <div className="p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Profil
            </div>
          </div>
          <Separator />
          <ProfileRow label="Nom" value={user.name} />
          <Separator />
          <ProfileRow label="Email" value={user.email} />
          <Separator />
          <ProfileRow label="UUID" value={user.id} mono />
          {user.createdAt && (
            <>
              <Separator />
              <ProfileRow
                label="Inscrit le"
                value={dateFormatter.format(new Date(user.createdAt))}
              />
            </>
          )}
          <Separator />
          <div className="flex flex-col gap-2 p-3">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Statut
            </span>
            <div className="flex flex-wrap gap-2">
              {isAdmin && (
                <span className="inline-flex h-5 items-center rounded-md border border-border/60 bg-chip-blue px-2 py-0.5 text-xxs font-medium text-chip-text">
                  Admin
                </span>
              )}
              {isSuspended ? (
                <span className="inline-flex h-5 items-center rounded-md border border-border/60 bg-destructive/10 px-2 py-0.5 text-xxs font-medium text-destructive">
                  Suspendu
                </span>
              ) : (
                <span className="inline-flex h-5 items-center rounded-md border border-border/60 bg-chip-white px-2 py-0.5 text-xxs font-medium">
                  Actif
                </span>
              )}
              {user.emailVerified && (
                <span className="inline-flex h-5 items-center rounded-md border border-border/60 bg-chip-white px-2 py-0.5 text-xxs font-medium">
                  Email vérifié
                </span>
              )}
              {user.hasPassword ? (
                <span className="inline-flex h-5 items-center rounded-md border border-border/60 bg-chip-white px-2 py-0.5 text-xxs font-medium">
                  Mot de passe défini
                </span>
              ) : (
                <span className="inline-flex h-5 items-center rounded-md border border-border/60 bg-chip-white px-2 py-0.5 text-xxs font-medium">
                  Sans mot de passe
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Feature flags */}
        <div className="rounded-xl border border-border bg-card shadow-sm">
          <div className="p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Fonctionnalités
            </div>
          </div>
          <Separator />
          <div className="p-3">
            {user.features.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {user.features.map(feature => (
                  <span
                    key={feature}
                    className="inline-flex h-6 items-center rounded-md border border-border/60 bg-chip-white px-2.5 py-0.5 text-xs font-medium"
                  >
                    {feature}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">
                Aucune fonctionnalité
              </span>
            )}
          </div>
        </div>

        {/* App entitlements */}
        <AppAccessSection userId={user.id} />

        {/* Admin actions */}
        <div className="space-y-2">
          {/* Suspend / Activate */}
          {isSuspended ? (
            <Button
              className="h-10 w-full justify-between rounded-xl border-border/60 px-4 text-sm font-medium hover:bg-muted/50"
              variant="outline"
              onClick={handleActivate}
              disabled={suspending}
            >
              <span>{`Activer l\u{2019}utilisateur`}</span>
              <ArrowRightSmallIcon size={16} className="text-muted-foreground" />
            </Button>
          ) : (
            <Button
              className="h-10 w-full justify-between rounded-xl border-border/60 px-4 text-sm font-medium hover:bg-muted/50"
              variant="outline"
              onClick={handleSuspend}
              disabled={suspending}
            >
              <span>{`Suspendre l\u{2019}utilisateur`}</span>
              <AccountBanIcon fontSize={20} className="text-muted-foreground" />
            </Button>
          )}

          {/* Grant / Revoke Admin */}
          {isAdmin ? (
            <Button
              className="h-10 w-full justify-between rounded-xl border-destructive/30 px-4 text-sm font-medium text-destructive hover:bg-destructive/5 hover:text-destructive"
              variant="outline"
              onClick={handleRevokeAdmin}
              disabled={revokingAdmin}
            >
              <span>{`Révoquer l\u{2019}administrateur`}</span>
              <ArrowRightSmallIcon size={16} />
            </Button>
          ) : (
            <Button
              className="h-10 w-full justify-between rounded-xl border-border/60 px-4 text-sm font-medium hover:bg-muted/50"
              variant="outline"
              onClick={handleGrantAdmin}
              disabled={grantingAdmin}
            >
              <span>{`Accorder l\u{2019}administrateur`}</span>
              <ArrowRightSmallIcon size={16} className="text-muted-foreground" />
            </Button>
          )}

          {/* Reset Password */}
          <Button
            className="h-10 w-full justify-between rounded-xl border-border/60 px-4 text-sm font-medium hover:bg-muted/50"
            variant="outline"
            onClick={onResetPassword}
          >
            <span>
              {user.hasPassword ? `Réinitialiser le mot de passe` : `Configurer le compte`}
            </span>
            <LockIcon fontSize={20} className="text-muted-foreground" />
          </Button>

          {/* Delete Account */}
          <Button
            className="h-10 w-full justify-between rounded-xl border-destructive/30 px-4 text-sm font-medium text-destructive hover:bg-destructive/5 hover:text-destructive"
            variant="outline"
            onClick={onDeleteAccount}
          >
            <span>Supprimer le compte</span>
            <DeleteIcon fontSize={20} />
          </Button>
        </div>
      </div>
    </div>
  );
}

