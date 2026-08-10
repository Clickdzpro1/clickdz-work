// #region Path Parameter Types
export interface RouteParamsTypes {
  admin: { settings: { module: { module: string } } };
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
    monitoring: '/admin/monitoring',
    workspaces: '/admin/workspaces',
    queue: '/admin/queue',
    ai: '/admin/ai',
    settings: { index: '/admin/settings', module: '/admin/settings/:module' },
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
    monitoring: 'monitoring',
    workspaces: 'workspaces',
    queue: 'queue',
    ai: 'ai',
    settings: { index: 'settings', module: ':module' },
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
admin.monitoring = () => '/admin/monitoring';
admin.workspaces = () => '/admin/workspaces';
admin.queue = () => '/admin/queue';
admin.ai = () => '/admin/ai';
const admin_settings = () => '/admin/settings';
admin_settings.module = (params: { module: string }) =>
  `/admin/settings/${params.module}`;
admin.settings = admin_settings;
admin.about = () => '/admin/about';
admin.notFound = () => '/admin/404';
export const FACTORIES = { admin, home };
// #endregion
