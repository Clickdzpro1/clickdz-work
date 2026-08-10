import { Button } from '@affine/admin/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@affine/admin/components/ui/dropdown-menu';
import {
  AccountBanIcon,
  LockIcon,
  MoreHorizontalIcon,
} from '@blocksuite/icons/rc';
import { useCallback, useState } from 'react';

import {
  USER_APPS,
  useBulkEnableUsers,
  useBulkGrantUserApp,
  useBulkRevokeUserApp,
  useBulkSuspendUsers,
  type UserAppKey,
} from '../admin-operations';
import type { UserType } from '../schema';

interface BulkActionBarProps {
  selectedUsers: UserType[];
  onClearSelection: () => void;
}

export function BulkActionBar({
  selectedUsers,
  onClearSelection,
}: BulkActionBarProps) {
  const { bulkSuspend, suspending: suspendingAll } = useBulkSuspendUsers();
  const { bulkEnable, enabling: enablingAll } = useBulkEnableUsers();
  const { bulkGrant, granting: grantingAll } = useBulkGrantUserApp();
  const { bulkRevoke, revoking: revokingAll } = useBulkRevokeUserApp();

  const [appMenuOpen, setAppMenuOpen] = useState(false);

  const selectedIds = selectedUsers.map(u => u.id);
  const count = selectedUsers.length;

  const handleBulkSuspend = useCallback(() => {
    bulkSuspend(selectedIds, onClearSelection);
  }, [bulkSuspend, selectedIds, onClearSelection]);

  const handleBulkEnable = useCallback(() => {
    bulkEnable(selectedIds, onClearSelection);
  }, [bulkEnable, selectedIds, onClearSelection]);

  const handleBulkGrantApp = useCallback(
    (app: UserAppKey) => {
      bulkGrant(selectedIds, app, 'standard', onClearSelection);
      setAppMenuOpen(false);
    },
    [bulkGrant, selectedIds, onClearSelection]
  );

  const handleBulkRevokeApp = useCallback(
    (app: UserAppKey) => {
      bulkRevoke(selectedIds, app, onClearSelection);
      setAppMenuOpen(false);
    },
    [bulkRevoke, selectedIds, onClearSelection]
  );

  if (count === 0) return null;

  const busy =
    suspendingAll || enablingAll || grantingAll || revokingAll;

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 shadow-sm">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{count}</span>
        <span className="text-muted-foreground">
          {count > 1 ? `utilisateurs sélectionnés` : `utilisateur sélectionné`}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {/* App access dropdown */}
        <DropdownMenu open={appMenuOpen} onOpenChange={setAppMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2"
              disabled={busy}
            >
              <LockIcon fontSize={18} />
              <span className="hidden sm:inline">Accès aux applications</span>
              <MoreHorizontalIcon fontSize={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[220px]">
            <DropdownMenuLabel>{`Accorder l\u{2019}accès`}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {USER_APPS.map(({ key, label }) => (
              <DropdownMenuItem
                key={`grant-${key}`}
                className="cursor-pointer gap-2 text-sm"
                onSelect={() => handleBulkGrantApp(key)}
              >
                <LockIcon fontSize={16} className="text-muted-foreground" />
                {label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{`Révoquer l\u{2019}accès`}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {USER_APPS.map(({ key, label }) => (
              <DropdownMenuItem
                key={`revoke-${key}`}
                className="cursor-pointer gap-2 text-sm text-destructive focus:text-destructive"
                onSelect={() => handleBulkRevokeApp(key)}
              >
                <LockIcon fontSize={16} />
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Suspend */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2"
          onClick={handleBulkSuspend}
          disabled={busy}
        >
          <AccountBanIcon fontSize={18} />
          <span className="hidden sm:inline">Suspendre</span>
        </Button>

        {/* Activate */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2"
          onClick={handleBulkEnable}
          disabled={busy}
        >
          <LockIcon fontSize={18} />
          <span className="hidden sm:inline">Activer</span>
        </Button>

        {/* Clear selection */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          onClick={onClearSelection}
          disabled={busy}
        >
          <MoreHorizontalIcon fontSize={16} />
          <span className="sr-only">Effacer la sélection</span>
        </Button>
      </div>
    </div>
  );
}
