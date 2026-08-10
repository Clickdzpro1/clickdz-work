import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@affine/admin/components/ui/card';
import { Checkbox } from '@affine/admin/components/ui/checkbox';
import { Input } from '@affine/admin/components/ui/input';
import { Label } from '@affine/admin/components/ui/label';
import { Skeleton } from '@affine/admin/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@affine/admin/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@affine/admin/components/ui/tabs';
import { affineFetch } from '@affine/admin/fetch-utils';
import { ActivityIcon, AlertTriangleIcon, BellIcon, HeartPulseIcon, HistoryIcon, ListIcon } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Header } from '../header';

// =========================================================================
// API types — match the backend controller response shapes.
// =========================================================================

type HealthStatus = 'up' | 'down' | 'degraded';

interface HealthCheck {
  name: string;
  key: string;
  status: HealthStatus;
  latencyMs: number;
  detail: string;
}

interface HealthResponse {
  overall: HealthStatus;
  checks: HealthCheck[];
  timestamp: string;
}

interface PostHogDeployEvent {
  event: string;
  timestamp: string;
  distinctId: string;
  properties: Record<string, unknown>;
}

interface DeployEventsResponse {
  events: PostHogDeployEvent[];
  configured: boolean;
  message?: string;
  posthogUrl: string;
}

interface BaseImageResponse {
  baseImage: string;
  dataVersion: string;
  deploymentType: string;
  namespace: string;
}

interface EventLogEntry {
  timestamp: string;
  eventType: 'signup' | 'entitlement_granted' | 'entitlement_revoked';
  userId: string;
  detail: string;
}

interface EventLogResponse {
  events: EventLogEntry[];
  total: number;
}

interface PostHogConfigResponse {
  host: string;
  hasProjectKey: boolean;
  hasPersonalKey: boolean;
  projectId: string | null;
  embedUrl: string | null;
  dashboardUrl: string;
}

// =========================================================================
// API fetch helpers — use affineFetch (adds x-affine-version header + CSRF).
// =========================================================================

async function fetchHealth(): Promise<HealthResponse> {
  const resp = await affineFetch('/api/v1/admin/health');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function fetchDeployEvents(): Promise<DeployEventsResponse> {
  const resp = await affineFetch('/api/v1/admin/deploy-events');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function fetchBaseImage(): Promise<BaseImageResponse> {
  const resp = await affineFetch('/api/v1/admin/base-image');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function fetchEventLog(): Promise<EventLogResponse> {
  const resp = await affineFetch('/api/v1/admin/event-log?limit=50');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function fetchPostHogConfig(): Promise<PostHogConfigResponse> {
  const resp = await affineFetch('/api/v1/admin/posthog-config');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// =========================================================================
// Shared utilities
// =========================================================================

const dateTimeFormatter = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'short',
  timeStyle: 'medium',
});

function statusColor(status: HealthStatus): string {
  if (status === 'up') return 'bg-green-500';
  if (status === 'down') return 'bg-red-500';
  return 'bg-yellow-500';
}

function statusLabel(status: HealthStatus): string {
  if (status === 'up') return 'Op\u00e9rationnel';
  if (status === 'down') return 'Hors service';
  return 'D\u00e9grad\u00e9';
}

function deployEventLabel(event: string): string {
  switch (event) {
    case 'deploy_build_started':
      return 'Build d\u00e9marr\u00e9';
    case 'deploy_build_succeeded':
      return 'Build r\u00e9ussi';
    case 'deploy_build_failed':
      return 'Build \u00e9chou\u00e9';
    case 'deploy_boot':
      return 'D\u00e9marrage serveur';
    default:
      return event;
  }
}

function deployEventColor(event: string): string {
  switch (event) {
    case 'deploy_build_succeeded':
      return 'text-green-600 dark:text-green-400';
    case 'deploy_build_failed':
      return 'text-red-600 dark:text-red-400';
    case 'deploy_build_started':
      return 'text-blue-600 dark:text-blue-400';
    case 'deploy_boot':
      return 'text-purple-600 dark:text-purple-400';
    default:
      return 'text-muted-foreground';
  }
}

function eventLogLabel(eventType: string): string {
  switch (eventType) {
    case 'signup':
      return 'Inscription';
    case 'entitlement_granted':
      return 'Acc\u00e8s accord\u00e9';
    case 'entitlement_revoked':
      return 'Acc\u00e8s r\u00e9voqu\u00e9';
    default:
      return eventType;
  }
}

function eventLogColor(eventType: string): string {
  switch (eventType) {
    case 'signup':
      return 'text-blue-600 dark:text-blue-400';
    case 'entitlement_granted':
      return 'text-green-600 dark:text-green-400';
    case 'entitlement_revoked':
      return 'text-orange-600 dark:text-orange-400';
    default:
      return 'text-muted-foreground';
  }
}

// =========================================================================
// Error boundary (shared across all tabs — same pattern as analytics page)
// =========================================================================

interface MonitorErrorBoundaryState {
  error: Error | null;
}

class MonitorErrorBoundary extends Component<
  { children: ReactNode; fallbackTitle?: string },
  MonitorErrorBoundaryState
> {
  state: MonitorErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): MonitorErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[admin/monitoring] render error:', error, info);
  }

  handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
          <div className="text-center space-y-2">
            <h3 className="text-base font-semibold">
              {this.props.fallbackTitle ?? 'Une erreur est survenue.'}
            </h3>
            <p className="text-sm text-muted-foreground max-w-md">
              {this.state.error.message || 'Erreur inconnue.'}
            </p>
            <button
              className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
              onClick={this.handleRetry}
            >
              R\u00e9essayer
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// =========================================================================
// Tab 1: System Health — server / db / redis / ai / gateway status indicators
// =========================================================================

function SystemHealthTab() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchHealth();
      setHealth(data);
    } catch (err) {
      setError((err as Error)?.message ?? 'Erreur');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Auto-refresh every 30 seconds
    intervalRef.current = setInterval(load, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [load]);

  if (loading && !health) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    );
  }

  if (error && !health) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8">
        <AlertTriangleIcon className="h-8 w-8 text-yellow-500" />
        <p className="text-sm text-muted-foreground">
          Impossible de r\u00e9cup\u00e9rer l\u2019\u00e9tat du syst\u00e8me: {error}
        </p>
        <button
          className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          onClick={load}
        >
          R\u00e9essayer
        </button>
      </div>
    );
  }

  if (!health) return null;

  return (
    <div className="space-y-6">
      {/* Overall status banner */}
      <div
        className={`flex items-center gap-3 rounded-lg border p-4 ${
          health.overall === 'up'
            ? 'border-green-500/30 bg-green-500/5'
            : health.overall === 'down'
              ? 'border-red-500/30 bg-red-500/5'
              : 'border-yellow-500/30 bg-yellow-500/5'
        }`}
      >
        <div
          className={`h-3 w-3 rounded-full ${statusColor(health.overall)} ${
            health.overall === 'up' ? 'animate-pulse' : ''
          }`}
        />
        <div>
          <p className="text-sm font-semibold">
            \u00c9tat global: {statusLabel(health.overall)}
          </p>
          <p className="text-xs text-muted-foreground">
            V\u00e9rification auto toutes les 30 secondes \u2014 derni\u00e8re: {dateTimeFormatter.format(new Date(health.timestamp))}
          </p>
        </div>
      </div>

      {/* Individual checks */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {health.checks.map(check => (
          <Card key={check.key} className="border-border/60 bg-card shadow-1">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardDescription className="text-sm font-medium">
                  {check.name}
                </CardDescription>
                <div
                  className={`flex items-center gap-1.5 ${check.status === 'up' ? 'text-green-600 dark:text-green-400' : check.status === 'down' ? 'text-red-600 dark:text-red-400' : 'text-yellow-600 dark:text-yellow-400'}`}
                >
                  <div
                    className={`h-2.5 w-2.5 rounded-full ${statusColor(check.status)}`}
                  />
                  <span className="text-xs font-medium">
                    {statusLabel(check.status)}
                  </span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex items-baseline justify-between">
                <span className="text-lg font-semibold tabular-nums">
                  {check.latencyMs} ms
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground truncate" title={check.detail}>
                {check.detail}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// =========================================================================
// Tab 2: Deploy History — PostHog deploy events timeline + current BASE_IMAGE
// =========================================================================

function DeployHistoryTab() {
  const [deployEvents, setDeployEvents] = useState<DeployEventsResponse | null>(null);
  const [baseImage, setBaseImage] = useState<BaseImageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        setError(null);
        const [events, img] = await Promise.all([
          fetchDeployEvents(),
          fetchBaseImage(),
        ]);
        setDeployEvents(events);
        setBaseImage(img);
      } catch (err) {
        setError((err as Error)?.message ?? 'Erreur');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8">
        <AlertTriangleIcon className="h-8 w-8 text-yellow-500" />
        <p className="text-sm text-muted-foreground">
          Erreur: {error}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Current deployment info */}
      {baseImage && (
        <Card className="border-border/60 bg-card shadow-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <HistoryIcon className="h-4 w-4" aria-hidden="true" />
              D\u00e9ploiement actuel
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">Image de base (BASE_IMAGE)</p>
                <p className="font-mono text-sm font-medium break-all">
                  {baseImage.baseImage}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Version des donn\u00e9es</p>
                <p className="font-mono text-sm font-medium">
                  {baseImage.dataVersion}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Type de d\u00e9ploiement</p>
                <p className="text-sm font-medium">
                  {baseImage.deploymentType}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Namespace</p>
                <p className="text-sm font-medium">
                  {baseImage.namespace}
                </p>
              </div>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">
                Pour annuler un d\u00e9ploiement (rollback), utilisez le script
                <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">scripts/rollback.sh</code>
                ou d\u00e9finissez <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">BASE_IMAGE</code>
                sur une image ant\u00e9rieure dans Railway, puis red\u00e9ployez.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Deploy events timeline */}
      <Card className="border-border/60 bg-card shadow-1">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ActivityIcon className="h-4 w-4" aria-hidden="true" />
            Historique des d\u00e9ploiements
          </CardTitle>
          <CardDescription>
            \u00c9v\u00e9nements de build et de d\u00e9marrage captur\u00e9s par PostHog
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!deployEvents?.configured ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
                <p className="text-sm text-muted-foreground">
                  {deployEvents?.message ?? 'PostHog non configur\u00e9 pour la requ\u00eate d\u2019\u00e9v\u00e9nements.'}
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                Les \u00e9v\u00e9nements de d\u00e9ploiement
                (<code className="rounded bg-muted px-1.5 py-0.5 text-xs">deploy_build_started</code>,
                <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">deploy_build_succeeded</code>,
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">deploy_build_failed</code>,
                <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">deploy_boot</code>)
                sont d\u00e9j\u00e0 captur\u00e9s par GitHub Actions et le serveur. Pour les
                afficher ici, configurez
                <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">CDZ_POSTHOG_PERSONAL_KEY</code>
                et
                <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">CDZ_POSTHOG_PROJECT_ID</code>
                comme variables d\u2019environnement Railway.
              </p>
              {deployEvents?.posthogUrl && (
                <a
                  href={deployEvents.posthogUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
                >
                  Ouvrir PostHog \u2197
                </a>
              )}
            </div>
          ) : deployEvents.events.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              Aucun \u00e9v\u00e9nement de d\u00e9ploiement trouv\u00e9
            </div>
          ) : (
            <div className="space-y-2">
              {deployEvents.events.map((evt, i) => (
                <div
                  key={`${evt.event}-${evt.timestamp}-${i}`}
                  className="flex items-start gap-3 rounded-lg border border-border/40 p-3"
                >
                  <div
                    className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                      evt.event === 'deploy_build_failed'
                        ? 'bg-red-500'
                        : evt.event === 'deploy_build_succeeded'
                          ? 'bg-green-500'
                          : evt.event === 'deploy_build_started'
                            ? 'bg-blue-500'
                            : 'bg-purple-500'
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-sm font-medium ${deployEventColor(evt.event)}`}>
                        {deployEventLabel(evt.event)}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                        {dateTimeFormatter.format(new Date(evt.timestamp))}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                      {evt.properties.sha && (
                        <span>SHA: <span className="font-mono">{String(evt.properties.sha)}</span></span>
                      )}
                      {evt.properties.branch && (
                        <span>Branche: {String(evt.properties.branch)}</span>
                      )}
                      {evt.properties.actor && (
                        <span>D\u00e9clench\u00e9 par: {String(evt.properties.actor)}</span>
                      )}
                      {evt.properties.base_image && (
                        <span>Image: <span className="font-mono">{String(evt.properties.base_image)}</span></span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =========================================================================
// Tab 3: Event Log — recent signups + entitlement changes
// =========================================================================

function EventLogTab() {
  const [eventLog, setEventLog] = useState<EventLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchEventLog();
      setEventLog(data);
    } catch (err) {
      setError((err as Error)?.message ?? 'Erreur');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8">
        <AlertTriangleIcon className="h-8 w-8 text-yellow-500" />
        <p className="text-sm text-muted-foreground">Erreur: {error}</p>
        <button
          className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          onClick={load}
        >
          R\u00e9essayer
        </button>
      </div>
    );
  }

  if (!eventLog || eventLog.events.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        Aucun \u00e9v\u00e9nement r\u00e9cent
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {eventLog.total} \u00e9v\u00e9nements r\u00e9cents (50 max)
        </p>
        <button
          className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-medium transition hover:bg-accent"
          onClick={load}
        >
          Actualiser
        </button>
      </div>
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">Horodatage</TableHead>
              <TableHead className="w-36">Type</TableHead>
              <TableHead className="w-24">Utilisateur</TableHead>
              <TableHead>D\u00e9tails</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {eventLog.events.map((evt, i) => (
              <TableRow key={`${evt.timestamp}-${evt.eventType}-${evt.userId}-${i}`}>
                <TableCell className="text-xs text-muted-foreground tabular-nums">
                  {dateTimeFormatter.format(new Date(evt.timestamp))}
                </TableCell>
                <TableCell>
                  <span className={`text-sm font-medium ${eventLogColor(evt.eventType)}`}>
                    {eventLogLabel(evt.eventType)}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {evt.userId.slice(0, 8)}
                </TableCell>
                <TableCell className="text-sm">
                  {evt.detail}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// =========================================================================
// Tab 4: PostHog Analytics — dashboard link + embed + deploy events
// =========================================================================

function PostHogAnalyticsTab() {
  const [config, setConfig] = useState<PostHogConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const data = await fetchPostHogConfig();
        setConfig(data);
      } catch {
        // non-critical — show defaults
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return <Skeleton className="h-48 w-full" />;
  }

  return (
    <div className="space-y-6">
      {/* PostHog dashboard link */}
      <Card className="border-border/60 bg-card shadow-1">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ActivityIcon className="h-4 w-4" aria-hidden="true" />
            Tableau de bord PostHog
          </CardTitle>
          <CardDescription>
            Analytique cross-platform \u2014 d\u00e9ploiements, \u00e9v\u00e9nements, activit\u00e9
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">H\u00f4te PostHog</p>
              <p className="font-mono text-sm font-medium break-all">
                {config?.host ?? 'https://us.i.posthog.com'}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Cl\u00e9 projet configur\u00e9e</p>
              <p className="text-sm font-medium">
                {config?.hasProjectKey ? 'Oui' : 'Non'}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Cl\u00e9 personnelle (API requ\u00eate)</p>
              <p className="text-sm font-medium">
                {config?.hasPersonalKey ? 'Oui' : 'Non'}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">ID de projet</p>
              <p className="font-mono text-sm font-medium">
                {config?.projectId ?? 'Non configur\u00e9'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            {config?.dashboardUrl && (
              <a
                href={config.dashboardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
              >
                Ouvrir le tableau de bord PostHog \u2197
              </a>
            )}
            {config?.embedUrl && (
              <a
                href={config.embedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium transition hover:bg-accent"
              >
                Tableau de bord int\u00e9gr\u00e9 \u2197
              </a>
            )}
          </div>

          {!config?.hasPersonalKey && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
              <p className="text-sm text-muted-foreground">
                Pour interroger les \u00e9v\u00e9nements PostHog depuis l\u2019admin, configurez
                <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">CDZ_POSTHOG_PERSONAL_KEY</code>
                (cl\u00e9 API personnelle PostHog, diff\u00e9rente de la cl\u00e9 projet) et
                <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">CDZ_POSTHOG_PROJECT_ID</code>
                comme variables d\u2019environnement Railway. La cl\u00e9 projet
                (<code className="rounded bg-muted px-1.5 py-0.5 text-xs">CDZ_POSTHOG_KEY</code>)
                ne permet que la capture d\u2019\u00e9v\u00e9nements, pas leur lecture.
              </p>
            </div>
          )}

          {/* Embedded dashboard (if configured) */}
          {config?.embedUrl && (
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium">Tableau de bord int\u00e9gr\u00e9</p>
              <iframe
                src={config.embedUrl}
                className="h-96 w-full rounded-lg border border-border/60"
                title="PostHog Dashboard"
                loading="lazy"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Deploy events (reuse the deploy history component) */}
      <Card className="border-border/60 bg-card shadow-1">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ActivityIcon className="h-4 w-4" aria-hidden="true" />
            \u00c9v\u00e9nements de d\u00e9ploiement r\u00e9cents
          </CardTitle>
        </CardHeader>
        <CardContent>
          <MonitorErrorBoundary fallbackTitle="Impossible de charger les \u00e9v\u00e9nements de d\u00e9ploiement.">
            <PostHogDeployEventsInline />
          </MonitorErrorBoundary>
        </CardContent>
      </Card>
    </div>
  );
}

/** Inline deploy events list for the PostHog tab (separate fetch). */
function PostHogDeployEventsInline() {
  const [events, setEvents] = useState<DeployEventsResponse | null>(null);

  useEffect(() => {
    fetchDeployEvents().then(setEvents).catch(() => {});
  }, []);

  if (!events) return <Skeleton className="h-20 w-full" />;

  if (!events.configured) {
    return (
      <p className="text-sm text-muted-foreground">
        Configurez
        <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">CDZ_POSTHOG_PERSONAL_KEY</code>
        pour afficher les \u00e9v\u00e9nements.
      </p>
    );
  }

  if (events.events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Aucun \u00e9v\u00e9nement r\u00e9cent.</p>
    );
  }

  return (
    <div className="space-y-2">
      {events.events.slice(0, 10).map((evt, i) => (
        <div
          key={`${evt.event}-${evt.timestamp}-${i}`}
          className="flex items-center justify-between gap-2 text-sm"
        >
          <span className={deployEventColor(evt.event)}>
            {deployEventLabel(evt.event)}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {dateTimeFormatter.format(new Date(evt.timestamp))}
          </span>
        </div>
      ))}
    </div>
  );
}

// =========================================================================
// Tab 5: Alert Configuration — UI stubs with French labels
// =========================================================================

function AlertConfigTab() {
  const [alertBuildFail, setAlertBuildFail] = useState(false);
  const [alertUserSuspended, setAlertUserSuspended] = useState(false);
  const [alertStorageThreshold, setAlertStorageThreshold] = useState('80');

  return (
    <div className="space-y-6">
      <Card className="border-border/60 bg-card shadow-1">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellIcon className="h-4 w-4" aria-hidden="true" />
            Configuration des alertes
          </CardTitle>
          <CardDescription>
            Notifications automatiques (configuration \u2014 backend \u00e0 venir)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Build fail alert */}
          <div className="flex items-start gap-3">
            <Checkbox
              id="alert-build-fail"
              checked={alertBuildFail}
              onCheckedChange={(v) => setAlertBuildFail(v === true)}
            />
            <div className="space-y-1">
              <Label htmlFor="alert-build-fail" className="text-sm font-medium cursor-pointer">
                Alerte en cas d\u2019\u00e9chec de build
              </Label>
              <p className="text-xs text-muted-foreground">
                Recevoir une notification quand un build GitHub Actions \u00e9choue
                (\u00e9v\u00e9nement <code className="rounded bg-muted px-1 py-0.5 text-xs">deploy_build_failed</code>).
              </p>
            </div>
          </div>

          {/* User suspended alert */}
          <div className="flex items-start gap-3">
            <Checkbox
              id="alert-user-suspended"
              checked={alertUserSuspended}
              onCheckedChange={(v) => setAlertUserSuspended(v === true)}
            />
            <div className="space-y-1">
              <Label htmlFor="alert-user-suspended" className="text-sm font-medium cursor-pointer">
                Alerte quand un utilisateur est suspendu
              </Label>
              <p className="text-xs text-muted-foreground">
                Recevoir une notification quand un compte utilisateur est
                suspendu ou r\u00e9voqu\u00e9.
              </p>
            </div>
          </div>

          {/* Storage threshold alert */}
          <div className="space-y-2">
            <Label htmlFor="alert-storage" className="text-sm font-medium">
              Alerte quand le stockage d\u00e9passe un seuil
            </Label>
            <div className="flex items-center gap-3">
              <Input
                id="alert-storage"
                type="number"
                min="1"
                max="100"
                value={alertStorageThreshold}
                onChange={(e) => setAlertStorageThreshold(e.target.value)}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Recevoir une notification quand l\u2019utilisation du stockage
              d\u00e9passe ce pourcentage.
            </p>
          </div>

          {/* Save button (stub — no backend yet) */}
          <div className="flex justify-end">
            <button
              className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
              onClick={() => {
                // Stub — no backend endpoint yet. Show a toast notification.
                toast('Configuration des alertes enregistr\u00e9e (stub \u2014 backend \u00e0 venir)');
              }}
            >
              Enregistrer
            </button>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
        <p className="text-sm text-muted-foreground">
          \u2139\ufffe Les alertes sont actuellement des stubs UI. L\u2019impl\u00e9mentation
          backend n\u00e9cessitera un service de notification (PostHog notifications,
          email, ou webhook) et une table de configuration en base de donn\u00e9es.
        </p>
      </div>
    </div>
  );
}

// =========================================================================
// Main monitoring page — tabbed layout
// =========================================================================

function MonitoringPageContent() {
  return (
    <div className="h-dvh flex-1 flex-col flex overflow-hidden">
      <Header title="Surveillance" />
      <div className="flex-1 overflow-auto p-6">
        <Tabs defaultValue="health" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="health" className="gap-1.5">
              <HeartPulseIcon className="h-4 w-4" />
              Sant\u00e9 syst\u00e8me
            </TabsTrigger>
            <TabsTrigger value="deploys" className="gap-1.5">
              <HistoryIcon className="h-4 w-4" />
              D\u00e9ploiements
            </TabsTrigger>
            <TabsTrigger value="events" className="gap-1.5">
              <ListIcon className="h-4 w-4" />
              Journal d\u2019\u00e9v\u00e9nements
            </TabsTrigger>
            <TabsTrigger value="posthog" className="gap-1.5">
              <ActivityIcon className="h-4 w-4" />
              PostHog
            </TabsTrigger>
            <TabsTrigger value="alerts" className="gap-1.5">
              <BellIcon className="h-4 w-4" />
              Alertes
            </TabsTrigger>
          </TabsList>

          <TabsContent value="health">
            <MonitorErrorBoundary fallbackTitle="Impossible de charger l\u2019\u00e9tat du syst\u00e8me.">
              <SystemHealthTab />
            </MonitorErrorBoundary>
          </TabsContent>

          <TabsContent value="deploys">
            <MonitorErrorBoundary fallbackTitle="Impossible de charger l\u2019historique des d\u00e9ploiements.">
              <DeployHistoryTab />
            </MonitorErrorBoundary>
          </TabsContent>

          <TabsContent value="events">
            <MonitorErrorBoundary fallbackTitle="Impossible de charger le journal d\u2019\u00e9v\u00e9nements.">
              <EventLogTab />
            </MonitorErrorBoundary>
          </TabsContent>

          <TabsContent value="posthog">
            <MonitorErrorBoundary fallbackTitle="Impossible de charger la configuration PostHog.">
              <PostHogAnalyticsTab />
            </MonitorErrorBoundary>
          </TabsContent>

          <TabsContent value="alerts">
            <MonitorErrorBoundary fallbackTitle="Impossible de charger la configuration des alertes.">
              <AlertConfigTab />
            </MonitorErrorBoundary>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function MonitoringPageSkeleton() {
  return (
    <div className="h-dvh flex-1 flex-col flex overflow-hidden">
      <Header title="Surveillance" />
      <div className="flex-1 overflow-auto p-6 space-y-4">
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    </div>
  );
}

export function MonitoringPage() {
  return (
    <MonitorErrorBoundary>
      <Suspense fallback={<MonitoringPageSkeleton />}>
        <MonitoringPageContent />
      </Suspense>
    </MonitorErrorBoundary>
  );
}

export { MonitoringPage as Component };
