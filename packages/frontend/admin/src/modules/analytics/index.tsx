import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@affine/admin/components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@affine/admin/components/ui/chart';
import { Skeleton } from '@affine/admin/components/ui/skeleton';
import { useQuery } from '@affine/admin/use-query';
import {
  adminDashboardQuery,
  type GraphQLQuery,
  listUsersQuery,
} from '@affine/graphql';
import { ActivityIcon, AppWindowIcon, DatabaseIcon, HardDriveIcon, LayersIcon, ServerIcon, UserPlusIcon, UsersIcon } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode, Suspense, useCallback, useMemo } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';

import { Header } from '../header';
import {
  USER_APPS,
  type UserAppEntitlement,
} from '../accounts/app-entitlements';

const intFormatter = new Intl.NumberFormat('fr-FR');
const dateFormatter = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});

/**
 * Query de synthèse des accès aux applications sur l'ensemble des
 * utilisateurs, construite sur la même opération `userAppEntitlements`
 * que la page de détail (agrégation côté client).
 */
const adminAppEntitlementsQuery = {
  id: 'adminUserAppEntitlementsQuery' as const,
  op: 'adminUserAppEntitlements',
  query: `query adminUserAppEntitlements {
  adminUserAppEntitlements {
    userId
    entitlements {
      app
      active
      plan
      expiresAt
    }
  }
}`,
} satisfies GraphQLQuery;

interface AdminUserAppEntitlement {
  userId: string;
  entitlements: UserAppEntitlement[];
}

interface AdminAppEntitlementsResponse {
  adminUserAppEntitlements: AdminUserAppEntitlement[];
}

interface SignupTimelinePoint {
  date: string;
  count: number;
}

const adminSignupsTimelineQuery = {
  id: 'adminSignupsTimelineQuery' as const,
  op: 'adminSignupsTimeline',
  query: `query adminSignupsTimeline {
  adminDashboard(input: { syncHistoryHours: 24, timezone: "UTC" }) {
    signupsTimeline {
      date
      count
    }
  }
}`,
} satisfies GraphQLQuery;

interface AdminSignupsTimelineResponse {
  adminDashboard: {
    signupsTimeline: SignupTimelinePoint[] | null;
  };
}

/**
 * Query pour les métriques étendues du tableau de bord administrateur
 * (totalWorkspaces, totalDocs, totalStorageUsed, copilotConversations,
 * syncActiveUsersTimeline, platformHealth).
 */
const adminExpandedDashboardQuery = {
  id: 'adminExpandedDashboardQuery' as const,
  op: 'adminExpandedDashboard',
  query: `query adminExpandedDashboard {
  adminDashboard(input: { syncHistoryHours: 24, timezone: "UTC" }) {
    copilotConversations
    workspaceStorageBytes
    blobStorageBytes
    syncActiveUsers
    syncActiveUsersTimeline {
      minute
      activeUsers
    }
    totalWorkspaces
    totalDocs
    totalStorageUsed
    platformHealth {
      databaseConnected
      redisConnected
      posthogEnabled
      serverVersion
      baseImage
    }
  }
}`,
} satisfies GraphQLQuery;

interface PlatformHealth {
  databaseConnected: boolean;
  redisConnected: boolean;
  posthogEnabled: boolean;
  serverVersion?: string | null;
  baseImage?: string | null;
}

interface ExpandedDashboard {
  copilotConversations: number;
  workspaceStorageBytes: number;
  blobStorageBytes: number;
  syncActiveUsers: number;
  syncActiveUsersTimeline: { minute: string; activeUsers: number }[];
  totalWorkspaces: number;
  totalDocs: number;
  totalStorageUsed: number;
  platformHealth: PlatformHealth | null;
}

interface AdminExpandedDashboardResponse {
  adminDashboard: ExpandedDashboard;
}

function MetricCard({
  title,
  value,
  description,
  icon,
}: {
  title: string;
  value: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="h-full border-border/60 bg-card shadow-1">
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2 text-sm">
          <span aria-hidden="true">{icon}</span>
          {title}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

interface SignupPoint {
  label: string;
  inscriptions: number;
}

function SignupsChart({ points }: { points: SignupPoint[] }) {
  if (points.length === 0) {
    return (
      <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
        Aucune donnée
      </div>
    );
  }

  // Recharts needs at least 2 data points to draw a line; when there is only
  // one signup day, duplicate it with a slightly different label so the chart
  // renders a visible dot/segment instead of collapsing to nothing.
  const chartPoints =
    points.length === 1
      ? [
          { ...points[0], label: `${points[0].label} (début)` },
          { ...points[0], label: `${points[0].label} (maintenant)` },
        ]
      : points;

  const config: ChartConfig = {
    inscriptions: {
      label: 'Inscriptions',
      color: 'var(--primary)',
    },
  };

  return (
    <ChartContainer
      config={config}
      className="h-44 w-full"
      aria-label="Inscriptions au fil du temps"
      role="img"
    >
      <LineChart
        data={chartPoints}
        margin={{ top: 8, right: 0, bottom: 0, left: 0 }}
      >
        <CartesianGrid
          vertical={false}
          stroke="var(--border)"
          strokeDasharray="3 4"
        />
        <XAxis dataKey="label" tickLine={false} axisLine={false} hide />
        <YAxis
          hide
          domain={[
            0,
            (max: number) => (max <= 0 ? 1 : Math.ceil(max * 1.1)),
          ]}
        />
        <ChartTooltip
          cursor={{
            stroke: 'var(--border)',
            strokeDasharray: '4 4',
            strokeWidth: 1,
          }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) =>
                payload?.[0]?.payload?.label ?? ''
              }
              valueFormatter={value => intFormatter.format(value as number)}
            />
          }
        />
        <Area
          dataKey="inscriptions"
          type="monotone"
          fill="var(--color-inscriptions)"
          fillOpacity={0.16}
          stroke="none"
          isAnimationActive={false}
        />
        <Line
          dataKey="inscriptions"
          type="monotone"
          stroke="var(--color-inscriptions)"
          strokeWidth={3}
          dot={false}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

interface AppCountPoint {
  app: string;
  utilisateurs: number;
}

const APP_COLORS = [
  'var(--primary)',
  'var(--chart-2, var(--primary))',
  'var(--chart-3, var(--primary))',
  'var(--chart-4, var(--primary))',
];

function AppEntitlementsChart({ points }: { points: AppCountPoint[] }) {
  const config: ChartConfig = Object.fromEntries(
    points.map((point, index) => [
      point.app,
      { label: point.app, color: APP_COLORS[index % APP_COLORS.length] },
    ])
  );

  return (
    <ChartContainer
      config={config}
      className="h-56 w-full"
      aria-label="Utilisateurs par application"
      role="img"
    >
      <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid
          vertical={false}
          stroke="var(--border)"
          strokeDasharray="3 4"
        />
        <XAxis dataKey="app" tickLine={false} axisLine={false} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={36}
          tickFormatter={value => intFormatter.format(value as number)}
        />
        <ChartTooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.3 }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) =>
                payload?.[0]?.payload?.app ?? ''
              }
              valueFormatter={value => intFormatter.format(value as number)}
            />
          }
        />
        <Bar dataKey="utilisateurs" radius={[4, 4, 0, 0]} isAnimationActive={false}>
          {points.map((point, index) => (
            <Cell
              key={point.app}
              fill={APP_COLORS[index % APP_COLORS.length]}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

interface GrowthPoint {
  label: string;
  total: number;
}

function UserGrowthChart({ points }: { points: GrowthPoint[] }) {
  if (points.length === 0) {
    return (
      <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
        Aucune donnée
      </div>
    );
  }

  const chartPoints =
    points.length === 1
      ? [
          { ...points[0], label: `${points[0].label} (début)` },
          { ...points[0], label: `${points[0].label} (maintenant)` },
        ]
      : points;

  const config: ChartConfig = {
    total: {
      label: `Total cumulé`,
      color: 'var(--chart-2, var(--primary))',
    },
  };

  return (
    <ChartContainer
      config={config}
      className="h-44 w-full"
      aria-label="Croissance cumulative des utilisateurs"
      role="img"
    >
      <LineChart
        data={chartPoints}
        margin={{ top: 8, right: 0, bottom: 0, left: 0 }}
      >
        <CartesianGrid
          vertical={false}
          stroke="var(--border)"
          strokeDasharray="3 4"
        />
        <XAxis dataKey="label" tickLine={false} axisLine={false} hide />
        <YAxis
          hide
          domain={[
            0,
            (max: number) => (max <= 0 ? 1 : Math.ceil(max * 1.1)),
          ]}
        />
        <ChartTooltip
          cursor={{
            stroke: 'var(--border)',
            strokeDasharray: '4 4',
            strokeWidth: 1,
          }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) =>
                payload?.[0]?.payload?.label ?? ''
              }
              valueFormatter={value => intFormatter.format(value as number)}
            />
          }
        />
        <Area
          dataKey="total"
          type="monotone"
          fill="var(--color-total)"
          fillOpacity={0.12}
          stroke="none"
          isAnimationActive={false}
        />
        <Line
          dataKey="total"
          type="monotone"
          stroke="var(--color-total)"
          strokeWidth={3}
          dot={false}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

/**
 * Helper to convert bytes to a human-readable string (e.g. "1,2 Go").
 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const formatted = unitIndex === 0
    ? intFormatter.format(Math.round(value))
    : intFormatter.format(Number(value.toFixed(1)));
  return `${formatted} ${units[unitIndex]}`;
}

/**
 * Generate a CSV string from the analytics data arrays and trigger a download.
 */
function downloadAnalyticsCSV(
  totalUsers: number,
  signups: SignupTimelinePoint[],
  appCounts: AppCountPoint[]
): void {
  const rows: string[] = [];

  // Section: total users
  rows.push('Métrique,Valeur');
  rows.push(`Utilisateurs totaux,${totalUsers}`);

  // Section: signups timeline
  rows.push('');
  rows.push('Date inscriptions,Nombre');
  for (const point of signups) {
    rows.push(`${point.date},${point.count}`);
  }

  // Section: app entitlements
  rows.push('');
  rows.push('Application,Utilisateurs avec accès');
  for (const point of appCounts) {
    rows.push(`${point.app},${point.utilisateurs}`);
  }

  const csv = rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `analytique-${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function AnalyticsPageContent() {
  return (
    <div className="h-dvh flex-1 flex-col flex overflow-hidden">
      <Header title="Analytique" />
      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Metric cards row */}
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3 lg:grid-cols-4">
          <AnalyticsErrorBoundary>
            <TotalUsersMetricCard />
          </AnalyticsErrorBoundary>
          <AnalyticsErrorBoundary>
            <ActiveUsersMetricCard />
          </AnalyticsErrorBoundary>
          <AnalyticsErrorBoundary>
            <CopilotMetricCard />
          </AnalyticsErrorBoundary>
          {/* Accès accordés — wrapped so a failure doesn’t kill the page */}
          <AnalyticsErrorBoundary>
            <EntitlementsMetricCard />
          </AnalyticsErrorBoundary>
        </div>

        {/* Storage + workspaces + docs row */}
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          <AnalyticsErrorBoundary>
            <TotalStorageMetricCard />
          </AnalyticsErrorBoundary>
          <AnalyticsErrorBoundary>
            <TotalWorkspacesMetricCard />
          </AnalyticsErrorBoundary>
          <AnalyticsErrorBoundary>
            <TotalDocsMetricCard />
          </AnalyticsErrorBoundary>
        </div>

        {/* Charts row 1 */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <AnalyticsErrorBoundary>
            <AppEntitlementsSection />
          </AnalyticsErrorBoundary>

          <AnalyticsErrorBoundary>
            <SignupsSection />
          </AnalyticsErrorBoundary>
        </div>

        {/* Charts row 2 */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <AnalyticsErrorBoundary>
            <UserGrowthSection />
          </AnalyticsErrorBoundary>

          <AnalyticsErrorBoundary>
            <PlatformHealthSection />
          </AnalyticsErrorBoundary>
        </div>

        {/* Export button */}
        <AnalyticsErrorBoundary>
          <ExportDataSection />
        </AnalyticsErrorBoundary>
      </div>
    </div>
  );
}

/** Section: total users metric (listUsersQuery). */
function TotalUsersMetricCard() {
  const { data: usersData } = useQuery({
    query: listUsersQuery,
    variables: { filter: { first: 1, skip: 0 } },
  });
  const totalUsers = usersData.usersCount ?? 0;
  return (
    <MetricCard
      title="Utilisateurs totaux"
      value={intFormatter.format(totalUsers)}
      description="Comptes enregistrés"
      icon={<UsersIcon className="h-4 w-4" />}
    />
  );
}

/** Section: active users metric (adminDashboardQuery). */
function ActiveUsersMetricCard() {
  const dashboardVariables = useMemo(
    () => ({
      input: { syncHistoryHours: 24, timezone: 'UTC' },
    }),
    []
  );
  const { data: dashboardData } = useQuery({
    query: adminDashboardQuery,
    variables: dashboardVariables,
  });
  const activeUsers = dashboardData.adminDashboard.syncActiveUsers;
  const syncWindow = dashboardData.adminDashboard.syncWindow;
  return (
    <MetricCard
      title="Utilisateurs actifs (récents)"
      value={intFormatter.format(activeUsers)}
      description={`Fenêtre de ${syncWindow.effectiveSize}h`}
      icon={<ActivityIcon className="h-4 w-4" />}
    />
  );
}

/** Section: accès aux applications (adminUserAppEntitlements query). */
function EntitlementsMetricCard() {
  const { data: entitlementsData } = useQuery({
    query: adminAppEntitlementsQuery as GraphQLQuery,
  });
  const perUserEntitlements =
    (entitlementsData as unknown as AdminAppEntitlementsResponse | undefined)
      ?.adminUserAppEntitlements ?? [];
  const appCounts = useMemo<AppCountPoint[]>(() => {
    const counts = new Map<string, number>();
    for (const app of USER_APPS) {
      // Backend returns app names in LOWERCASE; USER_APPS keys are UPPERCASE.
      // Use lowercase for the counts map so entitlement.app matches.
      counts.set(app.key.toLowerCase(), 0);
    }
    for (const user of perUserEntitlements) {
      for (const entitlement of user.entitlements) {
        const appKey = entitlement.app.toLowerCase();
        if (entitlement.active && counts.has(appKey)) {
          counts.set(appKey, (counts.get(appKey) ?? 0) + 1);
        }
      }
    }
    return USER_APPS.map(app => ({
      app: app.label,
      utilisateurs: counts.get(app.key.toLowerCase()) ?? 0,
    }));
  }, [perUserEntitlements]);
  const totalWithAccess = appCounts.reduce(
    (sum, point) => sum + point.utilisateurs,
    0
  );
  return (
    <MetricCard
      title="Accès accordés"
      value={intFormatter.format(totalWithAccess)}
      description="Droits applicatifs actifs"
      icon={<AppWindowIcon className="h-4 w-4" />}
    />
  );
}

/** Section: chart des accès aux applications. */
function AppEntitlementsSection() {
  const { data: entitlementsData } = useQuery({
    query: adminAppEntitlementsQuery as GraphQLQuery,
  });
  const perUserEntitlements =
    (entitlementsData as unknown as AdminAppEntitlementsResponse | undefined)
      ?.adminUserAppEntitlements ?? [];
  const appCounts = useMemo<AppCountPoint[]>(() => {
    const counts = new Map<string, number>();
    for (const app of USER_APPS) {
      // Backend returns app names in LOWERCASE; USER_APPS keys are UPPERCASE.
      counts.set(app.key.toLowerCase(), 0);
    }
    for (const user of perUserEntitlements) {
      for (const entitlement of user.entitlements) {
        const appKey = entitlement.app.toLowerCase();
        if (entitlement.active && counts.has(appKey)) {
          counts.set(appKey, (counts.get(appKey) ?? 0) + 1);
        }
      }
    }
    return USER_APPS.map(app => ({
      app: app.label,
      utilisateurs: counts.get(app.key.toLowerCase()) ?? 0,
    }));
  }, [perUserEntitlements]);
  const totalWithAccess = appCounts.reduce(
    (sum, point) => sum + point.utilisateurs,
    0
  );
  return (
    <Card className="border-border/60 bg-card shadow-1">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AppWindowIcon className="h-4 w-4" aria-hidden="true" />
          Accès aux applications
        </CardTitle>
        <CardDescription>
          {`Nombre d’utilisateurs avec chaque application active — ${intFormatter.format(totalWithAccess)} accès au total`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AppEntitlementsChart points={appCounts} />
      </CardContent>
    </Card>
  );
}

/** Section: chart des inscriptions (signupsTimeline query). */
function SignupsSection() {
  const { data: signupsData } = useQuery({
    query: adminSignupsTimelineQuery as GraphQLQuery,
  });
  const signupsTimeline =
    (signupsData as unknown as AdminSignupsTimelineResponse | undefined)
      ?.adminDashboard?.signupsTimeline ?? null;
  const signupPoints = useMemo<SignupPoint[]>(() => {
    if (Array.isArray(signupsTimeline) && signupsTimeline.length > 0) {
      return signupsTimeline.map(point => ({
        label: dateFormatter.format(new Date(point.date)),
        inscriptions: point.count,
      }));
    }
    return [];
  }, [signupsTimeline]);

  return (
    <Card className="border-border/60 bg-card shadow-1">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserPlusIcon className="h-4 w-4" aria-hidden="true" />
          Inscriptions au fil du temps
        </CardTitle>
        <CardDescription>
          Nouvelles inscriptions par période
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SignupsChart points={signupPoints} />
      </CardContent>
    </Card>
  );
}

/** Section: copilot conversations metric (adminExpandedDashboardQuery). */
function CopilotMetricCard() {
  const { data } = useQuery({
    query: adminExpandedDashboardQuery as GraphQLQuery,
  });
  const dashboard =
    (data as unknown as AdminExpandedDashboardResponse | undefined)
      ?.adminDashboard;
  const copilotConversations = dashboard?.copilotConversations ?? 0;
  return (
    <MetricCard
      title="Conversations Copilot"
      value={intFormatter.format(copilotConversations)}
      description="Interactions IA totales"
      icon={<ActivityIcon className="h-4 w-4" />}
    />
  );
}

/** Section: total storage metric (adminExpandedDashboardQuery). */
function TotalStorageMetricCard() {
  const { data } = useQuery({
    query: adminExpandedDashboardQuery as GraphQLQuery,
  });
  const dashboard =
    (data as unknown as AdminExpandedDashboardResponse | undefined)
      ?.adminDashboard;
  const totalStorage = dashboard?.totalStorageUsed ?? 0;
  return (
    <MetricCard
      title="Stockage total"
      value={formatBytes(totalStorage)}
      description="Espace workspace + blobs"
      icon={<HardDriveIcon className="h-4 w-4" />}
    />
  );
}

/** Section: total workspaces metric (adminExpandedDashboardQuery). */
function TotalWorkspacesMetricCard() {
  const { data } = useQuery({
    query: adminExpandedDashboardQuery as GraphQLQuery,
  });
  const dashboard =
    (data as unknown as AdminExpandedDashboardResponse | undefined)
      ?.adminDashboard;
  const totalWorkspaces = dashboard?.totalWorkspaces ?? 0;
  return (
    <MetricCard
      title="Workspaces totaux"
      value={intFormatter.format(totalWorkspaces)}
      description="Espaces de travail créés"
      icon={<LayersIcon className="h-4 w-4" />}
    />
  );
}

/** Section: total docs metric (adminExpandedDashboardQuery). */
function TotalDocsMetricCard() {
  const { data } = useQuery({
    query: adminExpandedDashboardQuery as GraphQLQuery,
  });
  const dashboard =
    (data as unknown as AdminExpandedDashboardResponse | undefined)
      ?.adminDashboard;
  const totalDocs = dashboard?.totalDocs ?? 0;
  return (
    <MetricCard
      title="Documents totaux"
      value={intFormatter.format(totalDocs)}
      description="Pages de workspace créées"
      icon={<LayersIcon className="h-4 w-4" />}
    />
  );
}

/** Section: cumulative user growth chart (derived from signupsTimeline). */
function UserGrowthSection() {
  const { data: signupsData } = useQuery({
    query: adminSignupsTimelineQuery as GraphQLQuery,
  });
  const signupsTimeline =
    (signupsData as unknown as AdminSignupsTimelineResponse | undefined)
      ?.adminDashboard?.signupsTimeline ?? null;
  const growthPoints = useMemo<GrowthPoint[]>(() => {
    if (Array.isArray(signupsTimeline) && signupsTimeline.length > 0) {
      let cumulative = 0;
      return signupsTimeline.map(point => {
        cumulative += point.count;
        return {
          label: dateFormatter.format(new Date(point.date)),
          total: cumulative,
        };
      });
    }
    return [];
  }, [signupsTimeline]);

  return (
    <Card className="border-border/60 bg-card shadow-1">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UsersIcon className="h-4 w-4" aria-hidden="true" />
          Croissance cumulative des utilisateurs
        </CardTitle>
        <CardDescription>
          Total cumulé d’utilisateurs au fil du temps
        </CardDescription>
      </CardHeader>
      <CardContent>
        <UserGrowthChart points={growthPoints} />
      </CardContent>
    </Card>
  );
}

/** Section: platform health cards (DB, Redis, PostHog, version). */
function PlatformHealthSection() {
  const { data } = useQuery({
    query: adminExpandedDashboardQuery as GraphQLQuery,
  });
  const dashboard =
    (data as unknown as AdminExpandedDashboardResponse | undefined)
      ?.adminDashboard;
  const health = dashboard?.platformHealth ?? null;

  const healthItems = [
    {
      label: `Base de données`,
      ok: health?.databaseConnected ?? false,
      detail: health?.databaseConnected ? `Connectée` : `Hors ligne`,
    },
    {
      label: `Redis`,
      ok: health?.redisConnected ?? false,
      detail: health?.redisConnected ? `Connecté` : `Hors ligne`,
    },
    {
      label: `PostHog`,
      ok: health?.posthogEnabled ?? false,
      detail: health?.posthogEnabled ? `Activé` : `Désactivé`,
    },
  ];

  return (
    <Card className="border-border/60 bg-card shadow-1">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ServerIcon className="h-4 w-4" aria-hidden="true" />
          Santé de la plateforme
        </CardTitle>
        <CardDescription>
          État des services et version déployée
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {healthItems.map(item => (
            <div
              key={item.label}
              className="flex items-center gap-2 rounded-lg border border-border/60 p-3"
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${item.ok ? 'bg-green-500' : 'bg-red-500'}`}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.detail}</p>
              </div>
            </div>
          ))}
        </div>
        {health?.baseImage && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <DatabaseIcon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{`Image déployée : ${health.baseImage}`}</span>
          </div>
        )}
        {health?.serverVersion && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ServerIcon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{`Version serveur : ${health.serverVersion}`}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Section: CSV export button. */
function ExportDataSection() {
  const { data: usersData } = useQuery({
    query: listUsersQuery,
    variables: { filter: { first: 1, skip: 0 } },
  });
  const { data: signupsData } = useQuery({
    query: adminSignupsTimelineQuery as GraphQLQuery,
  });
  const { data: entitlementsData } = useQuery({
    query: adminAppEntitlementsQuery as GraphQLQuery,
  });

  const handleExport = useCallback(() => {
    const totalUsers = usersData.usersCount ?? 0;
    const signupsTimeline =
      (signupsData as unknown as AdminSignupsTimelineResponse | undefined)
        ?.adminDashboard?.signupsTimeline ?? [];
    const perUserEntitlements =
      (entitlementsData as unknown as AdminAppEntitlementsResponse | undefined)
        ?.adminUserAppEntitlements ?? [];

    // Build app counts (same logic as EntitlementsMetricCard)
    const counts = new Map<string, number>();
    for (const app of USER_APPS) {
      counts.set(app.key.toLowerCase(), 0);
    }
    for (const user of perUserEntitlements) {
      for (const entitlement of user.entitlements) {
        const appKey = entitlement.app.toLowerCase();
        if (entitlement.active && counts.has(appKey)) {
          counts.set(appKey, (counts.get(appKey) ?? 0) + 1);
        }
      }
    }
    const appCounts = USER_APPS.map(app => ({
      app: app.label,
      utilisateurs: counts.get(app.key.toLowerCase()) ?? 0,
    }));

    downloadAnalyticsCSV(totalUsers, signupsTimeline ?? [], appCounts);
  }, [usersData, signupsData, entitlementsData]);

  return (
    <div className="flex justify-end">
      <button
        className="inline-flex h-9 items-center justify-center rounded-lg border border-border/60 bg-card px-4 text-sm font-medium text-foreground transition hover:bg-muted"
        onClick={handleExport}
      >
        Exporter en CSV
      </button>
    </div>
  );
}

function AnalyticsPageSkeleton() {
  return (
    <div className="h-dvh flex-1 flex-col flex overflow-hidden">
      <Header title="Analytique" />
      <div className="flex-1 overflow-auto p-6 space-y-6">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3 lg:grid-cols-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    </div>
  );
}

interface AnalyticsErrorBoundaryState {
  error: Error | null;
}

/**
 * Error boundary for the analytics page. Without this, any error thrown
 * during the SWR-suspense queries (e.g. a GraphQL validation error, a 401,
 * or a network error) propagates to the root and renders the whole admin
 * app blank. This boundary catches the error and shows a French error
 * message with a retry button, and logs the error message so the cause is
 * visible in the console.
 */
class AnalyticsErrorBoundary extends Component<
  { children: ReactNode },
  AnalyticsErrorBoundaryState
> {
  state: AnalyticsErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AnalyticsErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[admin/analytics] render error:', error, info);
  }

  handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-dvh flex-1 flex-col items-center justify-center gap-4 p-6">
          <div className="text-center space-y-2">
            <h2 className="text-lg font-semibold">
              Une erreur est survenue lors du chargement de l’analytique.
            </h2>
            <p className="text-sm text-muted-foreground max-w-md">
              {this.state.error.message || 'Erreur inconnue.'}
            </p>
            <button
              className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
              onClick={this.handleRetry}
            >
              Réessayer
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function AnalyticsPage() {
  return (
    <AnalyticsErrorBoundary>
      <Suspense fallback={<AnalyticsPageSkeleton />}>
        <AnalyticsPageContent />
      </Suspense>
    </AnalyticsErrorBoundary>
  );
}

export { AnalyticsPage as Component };
