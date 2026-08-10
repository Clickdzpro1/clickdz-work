// ClickDz Work — Admin System Info page.
//
// Displays server version, database type + masked connection string, Redis
// host (masked), BASE_IMAGE tag, PostHog config (key masked, host, zone), AI
// base URL + model list, GitHub repo + branch, Railway project ID. All values
// are read-only (returned by the adminSystemInfo GraphQL query).

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@affine/admin/components/ui/card';
import { Badge } from '@affine/admin/components/ui/badge';
import { Skeleton } from '@affine/admin/components/ui/skeleton';
import { Separator } from '@affine/admin/components/ui/separator';
import { useQuery } from '@affine/admin/use-query';
import {
  DatabaseIcon,
  GitBranchIcon,
  GithubIcon,
  GlobeIcon,
  HardDriveIcon,
  ImageIcon,
  RocketIcon,
  ServerIcon,
  SparklesIcon,
} from 'lucide-react';
import { Suspense } from 'react';

import { Header } from '../header';
import {
  adminSystemInfoQuery,
  type SystemInfo,
  type SystemInfoResponse,
} from './queries';

function InfoRow({
  icon,
  label,
  value,
  mono = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {icon}
      </div>
      <div className="flex flex-1 flex-col">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className={`text-sm ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
      </div>
    </div>
  );
}

function SystemInfoContent() {
  const { data } = useQuery({
    query: adminSystemInfoQuery,
  } as Parameters<typeof useQuery>[0]);

  const info =
    (data as unknown as SystemInfoResponse | undefined)?.adminSystemInfo;

  if (!info) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-muted-foreground">{`Aucune information système disponible.`}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
      {/* Server */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ServerIcon size={20} />
            {`Serveur`}
          </CardTitle>
          <CardDescription>{`Informations sur la version et le déploiement`}</CardDescription>
        </CardHeader>
        <CardContent>
          <InfoRow
            icon={<ServerIcon size={16} />}
            label="Version"
            value={info.version}
            mono
          />
          <Separator />
          <InfoRow
            icon={<GlobeIcon size={16} />}
            label="Type de déploiement"
            value={info.deploymentType}
          />
          <Separator />
          <InfoRow
            icon={<RocketIcon size={16} />}
            label="BASE_IMAGE (tag déployé)"
            value={info.baseImage}
            mono
          />
        </CardContent>
      </Card>

      {/* Database + Redis */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <DatabaseIcon size={20} />
            {`Base de données & Redis`}
          </CardTitle>
          <CardDescription>{`Configuration de stockage (valeurs masquées)`}</CardDescription>
        </CardHeader>
        <CardContent>
          <InfoRow
            icon={<DatabaseIcon size={16} />}
            label="Type de base de données"
            value={info.databaseType}
          />
          <Separator />
          <InfoRow
            icon={<DatabaseIcon size={16} />}
            label="URL de connexion (masquée)"
            value={info.databaseUrlMasked}
            mono
          />
          <Separator />
          <InfoRow
            icon={<HardDriveIcon size={16} />}
            label="Hôte Redis (masqué)"
            value={info.redisHostMasked}
            mono
          />
        </CardContent>
      </Card>

      {/* PostHog */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <SparklesIcon size={20} />
            PostHog
          </CardTitle>
          <CardDescription>{`Configuration analytique`}</CardDescription>
        </CardHeader>
        <CardContent>
          <InfoRow
            icon={<SparklesIcon size={16} />}
            label="Clé PostHog (masquée)"
            value={info.posthogKeyMasked}
            mono
          />
          <Separator />
          <InfoRow
            icon={<GlobeIcon size={16} />}
            label="Hôte PostHog"
            value={info.posthogHost}
            mono
          />
          <Separator />
          <div className="flex items-center gap-3 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <SparklesIcon size={16} />
            </div>
            <div className="flex flex-1 flex-col">
              <span className="text-xs font-medium text-muted-foreground">
                {`Zone PostHog`}
              </span>
              <Badge variant="outline" className="mt-0.5 w-fit">
                {info.posthogZone}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* AI Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ImageIcon size={20} />
            {`Configuration IA`}
          </CardTitle>
          <CardDescription>{`URL de base et modèles disponibles`}</CardDescription>
        </CardHeader>
        <CardContent>
          <InfoRow
            icon={<GlobeIcon size={16} />}
            label="URL de base IA"
            value={info.aiBaseUrl}
            mono
          />
          <Separator />
          <div className="flex items-center gap-3 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <SparklesIcon size={16} />
            </div>
            <div className="flex flex-1 flex-col">
              <span className="text-xs font-medium text-muted-foreground">
                {`Modèles IA`}
              </span>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {info.aiModels.length > 0 ? (
                  info.aiModels.map((model: string) => (
                    <Badge key={model} variant="secondary" className="font-mono text-xs">
                      {model}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* GitHub + Railway */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <GithubIcon size={20} />
            {`GitHub & Railway`}
          </CardTitle>
          <CardDescription>{`Dépôt source et projet d’hébergement`}</CardDescription>
        </CardHeader>
        <CardContent>
          <InfoRow
            icon={<GithubIcon size={16} />}
            label="Dépôt GitHub"
            value={info.githubRepo}
            mono
          />
          <Separator />
          <InfoRow
            icon={<GitBranchIcon size={16} />}
            label="Branche"
            value={info.githubBranch}
          />
          <Separator />
          <InfoRow
            icon={<RocketIcon size={16} />}
            label="ID projet Railway"
            value={info.railwayProjectId}
            mono
          />
        </CardContent>
      </Card>
    </div>
  );
}

function SystemInfoSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-40 w-full" />
      ))}
    </div>
  );
}

export function SystemInfoPage() {
  return (
    <div className="flex h-dvh flex-1 flex-col bg-background">
      <Header title="Informations système" />
      <Suspense fallback={<SystemInfoSkeleton />}>
        <SystemInfoContent />
      </Suspense>
    </div>
  );
}

export default SystemInfoPage;
