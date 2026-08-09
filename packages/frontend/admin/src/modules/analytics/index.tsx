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
import { ActivityIcon, AppWindowIcon, UserPlusIcon, UsersIcon } from 'lucide-react';
import { Suspense, useMemo } from 'react';
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
  userAppEntitlementsQuery,
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
  op: 'adminDashboard',
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

  const chartPoints =
    points.length === 1
      ? [points[0], { ...points[0], label: points[0].label }]
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

function AnalyticsPageContent() {
  // Nombre total d'utilisateurs (usersCount via listUsers).
  const { data: usersData } = useQuery({
    query: listUsersQuery,
    variables: { filter: { first: 1, skip: 0 } },
  });
  const totalUsers = usersData.usersCount ?? 0;

  // Utilisateurs actifs récents (fenêtre de synchronisation du dashboard).
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

  // Accès aux applications sur l'ensemble des utilisateurs.
  const { data: entitlementsData } = useQuery({
    query: adminAppEntitlementsQuery as GraphQLQuery,
  });
  const perUserEntitlements =
    (entitlementsData as unknown as AdminAppEntitlementsResponse | undefined)
      ?.adminUserAppEntitlements ?? [];

  // Inscriptions au fil du temps (récupérées via le champ signupsTimeline
  // du backend, exposé par adminDashboard).
  const { data: signupsData } = useQuery({
    query: adminSignupsTimelineQuery as GraphQLQuery,
  });
  const signupsTimeline =
    (signupsData as unknown as AdminSignupsTimelineResponse | undefined)
      ?.adminDashboard?.signupsTimeline ?? null;

  const appCounts = useMemo<AppCountPoint[]>(() => {
    const counts = new Map<string, number>();
    for (const app of USER_APPS) {
      counts.set(app.key, 0);
    }
    for (const user of perUserEntitlements) {
      for (const entitlement of user.entitlements) {
        if (entitlement.active && counts.has(entitlement.app)) {
          counts.set(
            entitlement.app,
            (counts.get(entitlement.app) ?? 0) + 1
          );
        }
      }
    }
    return USER_APPS.map(app => ({
      app: app.label,
      utilisateurs: counts.get(app.key) ?? 0,
    }));
  }, [perUserEntitlements]);

  // Inscriptions au fil du temps (histogramme fourni par le backend).
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
    <div className="h-dvh flex-1 flex-col flex overflow-hidden">
      <Header title="Analytique" />
      <div className="flex-1 overflow-auto p-6 space-y-6">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          <MetricCard
            title="Utilisateurs totaux"
            value={intFormatter.format(totalUsers)}
            description="Comptes enregistrés"
            icon={<UsersIcon className="h-4 w-4" />}
          />
          <MetricCard
            title="Utilisateurs actifs (récents)"
            value={intFormatter.format(activeUsers)}
            description={`Fenêtre de ${syncWindow.effectiveSize}h`}
            icon={<ActivityIcon className="h-4 w-4" />}
          />
          <MetricCard
            title="Accès accordés"
            value={intFormatter.format(
              appCounts.reduce((sum, point) => sum + point.utilisateurs, 0)
            )}
            description="Droits applicatifs actifs"
            icon={<AppWindowIcon className="h-4 w-4" />}
          />
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card className="border-border/60 bg-card shadow-1">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AppWindowIcon className="h-4 w-4" aria-hidden="true" />
                Accès aux applications
              </CardTitle>
              <CardDescription>
                Nombre d{"'"}utilisateurs avec chaque application active
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AppEntitlementsChart points={appCounts} />
            </CardContent>
          </Card>

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
        </div>
      </div>
    </div>
  );
}

function AnalyticsPageSkeleton() {
  return (
    <div className="h-dvh flex-1 flex-col flex overflow-hidden">
      <Header title="Analytique" />
      <div className="flex-1 overflow-auto p-6 space-y-6">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    </div>
  );
}

export function AnalyticsPage() {
  return (
    <Suspense fallback={<AnalyticsPageSkeleton />}>
      <AnalyticsPageContent />
    </Suspense>
  );
}

export { AnalyticsPage as Component };
