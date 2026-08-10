// #region Path Parameter Types
export interface RouteParamsTypes {
  admin: {
    settings: { module: { module: string } };
    featureFlags: Record<string, never>;
    appManagement: Record<string, never>;
    systemInfo: Record<string, never>;
    notificationSettings: Record<string, never>;
    studioConfig: Record<string, never>;
  };
}
// #endregion

// #region Absolute Paths
export const ROUTES = {
  index: '/',
  admin: {
    index: '/admin',
    auth: '/admin/auth',
    setup: '/admin/setup',
    dashboard: '/admin/dashboard',
    accounts: '/admin/accounts',
    analytics: '/admin/analytics',
    workspaces: '/admin/workspaces',
    queue: '/admin/queue',
    ai: '/admin/ai',
    settings: { index: '/admin/settings', module: '/admin/settings/:module' },
    featureFlags: '/admin/feature-flags',
    appManagement: '/admin/app-management',
    systemInfo: '/admin/system-info',
    notificationSettings: '/admin/notification-settings',
    studioConfig: '/admin/studio-config',
    about: '/admin/about',
    notFound: '/admin/404',
  },
};
// #endregion

// #region Relative Paths
export const RELATIVE_ROUTES = {
  index: '/',
  admin: {
    index: 'admin',
    auth: 'auth',
    setup: 'setup',
    dashboard: 'dashboard',
    accounts: 'accounts',
    analytics: 'analytics',
    workspaces: 'workspaces',
    queue: 'queue',
    ai: 'ai',
    settings: { index: 'settings', module: ':module' },
    featureFlags: 'feature-flags',
    appManagement: 'app-management',
    systemInfo: 'system-info',
    notificationSettings: 'notification-settings',
    studioConfig: 'studio-config',
    about: 'about',
    notFound: '404',
  },
};
// #endregion

// #region Path Factories
const home = () => '/';
const admin = () => '/admin';
admin.auth = () => '/admin/auth';
admin.setup = () => '/admin/setup';
admin.dashboard = () => '/admin/dashboard';
admin.accounts = () => '/admin/accounts';
admin.analytics = () => '/admin/analytics';
admin.workspaces = () => '/admin/workspaces';
admin.queue = () => '/admin/queue';
admin.ai = () => '/admin/ai';
const admin_settings = () => '/admin/settings';
admin_settings.module = (params: { module: string }) =>
  `/admin/settings/${params.module}`;
admin.settings = admin_settings;
admin.featureFlags = () => '/admin/feature-flags';
admin.appManagement = () => '/admin/app-management';
admin.systemInfo = () => '/admin/system-info';
admin.notificationSettings = () => '/admin/notification-settings';
admin.studioConfig = () => '/admin/studio-config';
admin.about = () => '/admin/about';
admin.notFound = () => '/admin/404';
export const FACTORIES = { admin, home };
// #endregion

