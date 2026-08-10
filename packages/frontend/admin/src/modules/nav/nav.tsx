import { cn } from '@affine/admin/utils';
import { ROUTES } from '@affine/routes';
import { AccountIcon, SelfhostIcon } from '@blocksuite/icons/rc';
import {
  BarChart3Icon,
  ChartPieIcon,
  FlagIcon,
  HeartPulseIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  AppWindowIcon,
  ServerIcon,
  BellIcon,
  LayoutGridIcon,
} from 'lucide-react';

import { NavItem } from './nav-item';
import { ServerVersion } from './server-version';
import { SettingsItem } from './settings-item';
import { UserDropdown } from './user-dropdown';

interface NavProps {
  isCollapsed?: boolean;
}

export function Nav({ isCollapsed = false }: NavProps) {
  return (
    <div
      className={cn(
        'flex h-full flex-grow flex-col justify-between gap-4 py-2',
        isCollapsed && 'overflow-visible'
      )}
    >
      <nav
        className={cn(
          'flex flex-1 flex-col gap-1 overflow-x-hidden overflow-y-auto px-2',
          isCollapsed && 'items-center px-0 gap-1 overflow-visible'
        )}
      >
        {environment.isSelfHosted ? null : (
          <NavItem
            to={ROUTES.admin.dashboard}
            icon={<BarChart3Icon size={18} />}
            label="Dashboard"
            isCollapsed={isCollapsed}
          />
        )}
        <NavItem
          to={ROUTES.admin.accounts}
          icon={<AccountIcon fontSize={20} />}
          label="Accounts"
          isCollapsed={isCollapsed}
        />
        <NavItem
          to={ROUTES.admin.analytics}
          icon={<ChartPieIcon size={18} />}
          label="Analytique"
          isCollapsed={isCollapsed}
        />
        <NavItem
          to={ROUTES.admin.monitoring}
          icon={<HeartPulseIcon size={18} />}
          label="Surveillance"
          isCollapsed={isCollapsed}
        />
        {environment.isSelfHosted ? null : (
          <NavItem
            to={ROUTES.admin.workspaces}
            icon={<LayoutDashboardIcon size={18} />}
            label="Workspaces"
            isCollapsed={isCollapsed}
          />
        )}
        <NavItem
          to={ROUTES.admin.queue}
          icon={<ListChecksIcon size={18} />}
          label="Queue"
          isCollapsed={isCollapsed}
        />
        {/* ClickDz admin configuration pages */}
        <NavItem
          to={ROUTES.admin.featureFlags}
          icon={<FlagIcon size={18} />}
          label="Feature Flags"
          isCollapsed={isCollapsed}
        />
        <NavItem
          to={ROUTES.admin.appManagement}
          icon={<AppWindowIcon size={18} />}
          label="Applications"
          isCollapsed={isCollapsed}
        />
        <NavItem
          to={ROUTES.admin.studioConfig}
          icon={<LayoutGridIcon size={18} />}
          label="Studios"
          isCollapsed={isCollapsed}
        />
        <NavItem
          to={ROUTES.admin.systemInfo}
          icon={<ServerIcon size={18} />}
          label="Système"
          isCollapsed={isCollapsed}
        />
        <NavItem
          to={ROUTES.admin.notificationSettings}
          icon={<BellIcon size={18} />}
          label="Notifications"
          isCollapsed={isCollapsed}
        />
        {/* <NavItem
          to="/admin/ai"
          icon={<AiOutlineIcon fontSize={20} />}
          label="AI"
          isCollapsed={isCollapsed}
        /> */}
        <SettingsItem isCollapsed={isCollapsed} />
        <NavItem
          to={ROUTES.admin.about}
          icon={<SelfhostIcon fontSize={20} />}
          label="About"
          isCollapsed={isCollapsed}
        />
      </nav>
      <div
        className={cn(
          'flex flex-col gap-2 overflow-hidden px-2',
          isCollapsed && 'items-center px-0 gap-1'
        )}
      >
        <UserDropdown isCollapsed={isCollapsed} />
        {isCollapsed ? null : <ServerVersion />}
      </div>
    </div>
  );
}

