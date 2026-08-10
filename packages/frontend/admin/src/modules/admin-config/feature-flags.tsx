// ClickDz Work — Admin Feature Flag Management page (read-only).
//
// Displays the platform-wide feature flags (env-var controlled) with ON/OFF
// indicators and French descriptions. These flags are process.env reads —
// toggling them requires a Railway redeploy, so the UI is intentionally
// read-only. The admin can see at-a-glance which features are enabled.

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@affine/admin/components/ui/card';
import { Badge } from '@affine/admin/components/ui/badge';
import { Skeleton } from '@affine/admin/components/ui/skeleton';
import { useQuery } from '@affine/admin/use-query';
import { FlagIcon, InfoIcon } from 'lucide-react';
import { Suspense } from 'react';

import { Header } from '../header';
import {
  adminFeatureFlagsQuery,
  type FeatureFlagInfo,
  type FeatureFlagsResponse,
} from './queries';

function FeatureFlagsContent() {
  const { data } = useQuery({
    query: adminFeatureFlagsQuery,
  } as Parameters<typeof useQuery>[0]);

  const flags =
    (data as unknown as FeatureFlagsResponse | undefined)?.adminFeatureFlags ??
    [];

  const enabledCount = flags.filter(f => f.enabled).length;
  const disabledCount = flags.length - enabledCount;

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
      {/* Summary card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <FlagIcon size={20} />
            Feature Flags
          </CardTitle>
          <CardDescription>
            {`Configuration des fonctionnalités platform-wide. ${enabledCount} activé(s), ${disabledCount} désactivé(s) sur ${flags.length} au total.`}
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Info banner */}
      <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
        <InfoIcon size={18} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">{`Lecture seule`}</p>
          <p className="mt-1 text-blue-700 dark:text-blue-300">
            {`Ces indicateurs sont contrôlés par des variables d’environnement. Modifier leur état nécessite un redéploiement Railway.`}
          </p>
        </div>
      </div>

      {/* Flags list */}
      <div className="flex flex-col gap-3">
        {flags.map((flag: FeatureFlagInfo) => (
          <Card key={flag.envVar}>
            <CardContent className="flex items-center justify-between gap-4 p-4">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-2 py-0.5 text-sm font-mono">
                    {flag.envVar}
                  </code>
                  {flag.enabled ? (
                    <Badge variant="default" className="bg-green-600 hover:bg-green-600">
                      ON
                    </Badge>
                  ) : (
                    <Badge variant="secondary">OFF</Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {flag.descriptionFr}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function FeatureFlagsSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-16 w-full" />
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

export function FeatureFlagsPage() {
  return (
    <div className="flex h-dvh flex-1 flex-col bg-background">
      <Header title="Feature Flags" />
      <Suspense fallback={<FeatureFlagsSkeleton />}>
        <FeatureFlagsContent />
      </Suspense>
    </div>
  );
}

export default FeatureFlagsPage;
