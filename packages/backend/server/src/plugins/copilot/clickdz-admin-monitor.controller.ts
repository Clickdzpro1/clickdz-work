import {
  Controller,
  Get,
  Logger,
  Query,
} from '@nestjs/common';

import { Throttle } from '../../base';
import { CacheRedis } from '../../base/redis';
import { Admin } from '../../core/common';
import { Models } from '../../models';

/**
 * ClickDz admin monitoring + PostHog analytics controller.
 *
 * Exposes REST endpoints (all admin-guarded via the @Admin() decorator) that
 * power the admin "Surveillance" tab:
 *
 *   GET /api/v1/admin/health      — system health (server / db / redis / ai / gateway)
 *   GET /api/v1/admin/deploy-events — recent PostHog deploy events (optional, needs personal key)
 *   GET /api/v1/admin/event-log   — recent platform events (signups + entitlement changes)
 *   GET /api/v1/admin/base-image  — current BASE_IMAGE env + data version
 *
 * The controller is registered in the Copilot module alongside the other
 * ClickDz controllers. It uses the same CacheRedis and Models injections as
 * the data/pg-admin controllers.
 *
 * FAILURE STANCE: health endpoints always return 200 with a status field — a
 * degraded component shows status "degraded" or "down", not a 5xx. This lets
 * the frontend render the full dashboard even when one upstream is unreachable.
 */
@Admin()
@Controller()
export class ClickDzAdminMonitorController {
  private readonly logger = new Logger(ClickDzAdminMonitorController.name);

  constructor(
    private readonly redis: CacheRedis,
    private readonly models: Models
  ) {}

  // -------------------------------------------------------------------------
  // GET /api/v1/admin/health — system health checks
  // -------------------------------------------------------------------------
  @Get('/api/v1/admin/health')
  @Throttle('default', { limit: 30, ttl: 60_000 })
  async getHealth(): Promise<HealthResponse> {
    const checks: HealthCheck[] = [];

    // 1. Server (always up if we got here)
    checks.push({
      name: 'Serveur',
      key: 'server',
      status: 'up',
      latencyMs: 0,
      detail: 'NestJS responding',
    });

    // 2. Database — run a trivial SELECT 1 via the models layer
    const dbCheck = await this.checkDatabase();
    checks.push(dbCheck);

    // 3. Redis — PING
    const redisCheck = await this.checkRedis();
    checks.push(redisCheck);

    // 4. cdz-ai upstream health
    const aiCheck = await this.checkUpstream(
      'cdz-ai',
      'CDZ_AI_BASE_URL',
      '/health',
      'IA en amont'
    );
    checks.push(aiCheck);

    // 5. WhatsApp gateway health
    const waCheck = await this.checkUpstream(
      'whatsapp-gateway',
      'CDZ_WA_URL',
      '/health',
      'Passerelle WhatsApp'
    );
    checks.push(waCheck);

    const allUp = checks.every(c => c.status === 'up');
    const anyDown = checks.some(c => c.status === 'down');

    return {
      overall: anyDown ? 'down' : allUp ? 'up' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/admin/deploy-events — recent PostHog deploy events
  // -------------------------------------------------------------------------
  @Get('/api/v1/admin/deploy-events')
  @Throttle('default', { limit: 20, ttl: 60_000 })
  async getDeployEvents(): Promise<DeployEventsResponse> {
    const personalKey = process.env.CDZ_POSTHOG_PERSONAL_KEY;
    const host = process.env.CDZ_POSTHOG_HOST || 'https://us.i.posthog.com';
    const projectId = process.env.CDZ_POSTHOG_PROJECT_ID;

    if (!personalKey || !projectId) {
      return {
        events: [],
        configured: false,
        message:
          'Cl\u00e9 API personnelle PostHog (CDZ_POSTHOG_PERSONAL_KEY) ou ID de projet (CDZ_POSTHOG_PROJECT_ID) non configur\u00e9e. Configurez ces variables d\u2019environnement pour interroger les \u00e9v\u00e9nements de d\u00e9ploiement.',
        posthogUrl: host,
      };
    }

    try {
      const events = await this.fetchPostHogDeployEvents(
        host,
        projectId,
        personalKey
      );
      return {
        events,
        configured: true,
        posthogUrl: host,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to fetch PostHog deploy events: ${(err as Error)?.message}`
      );
      return {
        events: [],
        configured: true,
        message: `Erreur lors de la r\u00e9cup\u00e9ration des \u00e9v\u00e9nements: ${(err as Error)?.message}`,
        posthogUrl: host,
      };
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/admin/base-image — current BASE_IMAGE + data version
  // -------------------------------------------------------------------------
  @Get('/api/v1/admin/base-image')
  @Throttle('default', { limit: 30, ttl: 60_000 })
  async getBaseImage(): Promise<BaseImageResponse> {
    return {
      baseImage: process.env.BASE_IMAGE || 'non d\u00e9fini',
      dataVersion: env?.version ?? 'inconnu',
      deploymentType: env?.DEPLOYMENT_TYPE ?? 'inconnu',
      namespace: env?.NAMESPACE ?? 'inconnu',
    };
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/admin/event-log — recent platform events (signups + entitlements)
  // -------------------------------------------------------------------------
  @Get('/api/v1/admin/event-log')
  @Throttle('default', { limit: 20, ttl: 60_000 })
  async getEventLog(
    @Query('limit') limit?: string
  ): Promise<EventLogResponse> {
    const maxLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

    const events: EventLogEntry[] = [];

    // Recent signups — query the user model for the most recently created users
    try {
      const recentUsers = await this.fetchRecentSignups(maxLimit);
      for (const user of recentUsers) {
        events.push({
          timestamp: user.createdAt,
          eventType: 'signup',
          userId: user.id,
          detail: user.email,
        });
      }
    } catch (err) {
      this.logger.warn(
        `Failed to fetch recent signups: ${(err as Error)?.message}`
      );
    }

    // Recent entitlement changes — query the userAppEntitlement model
    try {
      const recentEntitlements = await this.fetchRecentEntitlementChanges(
        maxLimit
      );
      for (const ent of recentEntitlements) {
        events.push({
          timestamp: ent.updatedAt,
          eventType: ent.active ? 'entitlement_granted' : 'entitlement_revoked',
          userId: ent.userId,
          detail: `${ent.app} ${ent.active ? 'activ\u00e9' : 'r\u00e9voqu\u00e9'}`,
        });
      }
    } catch (err) {
      this.logger.warn(
        `Failed to fetch recent entitlement changes: ${(err as Error)?.message}`
      );
    }

    // Sort all events by timestamp desc and limit
    events.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return tb - ta;
    });

    return {
      events: events.slice(0, maxLimit),
      total: events.length,
    };
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/admin/posthog-config — PostHog dashboard URL + embed info
  // -------------------------------------------------------------------------
  @Get('/api/v1/admin/posthog-config')
  @Throttle('default', { limit: 30, ttl: 60_000 })
  async getPostHogConfig(): Promise<PostHogConfigResponse> {
    const host = process.env.CDZ_POSTHOG_HOST || 'https://us.i.posthog.com';
    const projectKey = process.env.CDZ_POSTHOG_KEY;
    const personalKey = process.env.CDZ_POSTHOG_PERSONAL_KEY;
    const projectId = process.env.CDZ_POSTHOG_PROJECT_ID;
    const embedDashboardId = process.env.CDZ_POSTHOG_EMBED_DASHBOARD_ID;

    return {
      host,
      hasProjectKey: Boolean(projectKey),
      hasPersonalKey: Boolean(personalKey),
      projectId: projectId || null,
      embedUrl: embedDashboardId
        ? `${host}/embedded/dashboards/${embedDashboardId}`
        : null,
      dashboardUrl: projectId
        ? `${host}/dashboard/${projectId}`
        : host,
    };
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private async checkDatabase(): Promise<HealthCheck> {
    const start = Date.now();
    try {
      // Use the Prisma client directly — a simple SELECT 1 is the lightest
      // possible DB liveness probe. The Models object exposes the Prisma
      // client through models.db (typed as PrismaService / PrismaClient).
      const db = (this.models as any).db ?? (this.models as any).prisma;
      if (db && typeof db.$queryRaw === 'function') {
        await db.$queryRaw`SELECT 1`;
      } else {
        // Fallback: if we can't find the Prisma client directly, do a
        // trivial user query (lightest model-level probe).
        await this.models.user.list({ take: 1 });
      }
      return {
        name: 'Base de donn\u00e9es',
        key: 'database',
        status: 'up',
        latencyMs: Date.now() - start,
        detail: 'SELECT 1 ok',
      };
    } catch (err) {
      return {
        name: 'Base de donn\u00e9es',
        key: 'database',
        status: 'down',
        latencyMs: Date.now() - start,
        detail: `${(err as Error)?.message ?? 'erreur de connexion'}`,
      };
    }
  }

  private async checkRedis(): Promise<HealthCheck> {
    const start = Date.now();
    try {
      // CacheRedis extends ioredis — ping() is the standard liveness probe.
      await this.redis.ping();
      return {
        name: 'Redis',
        key: 'redis',
        status: 'up',
        latencyMs: Date.now() - start,
        detail: 'PING ok',
      };
    } catch (err) {
      return {
        name: 'Redis',
        key: 'redis',
        status: 'down',
        latencyMs: Date.now() - start,
        detail: `${(err as Error)?.message ?? 'erreur de connexion'}`,
      };
    }
  }

  private async checkUpstream(
    key: string,
    envVar: string,
    healthPath: string,
    label: string
  ): Promise<HealthCheck> {
    const baseUrl = process.env[envVar];
    const start = Date.now();
    if (!baseUrl) {
      return {
        name: label,
        key,
        status: 'degraded',
        latencyMs: 0,
        detail: `${envVar} non configur\u00e9`,
      };
    }
    try {
      const url = baseUrl.replace(/\/+$/, '') + healthPath;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timeout);
      const latency = Date.now() - start;
      if (resp.ok) {
        return {
          name: label,
          key,
          status: 'up',
          latencyMs: latency,
          detail: `HTTP ${resp.status}`,
        };
      }
      // 404 on /health — many services don't have a dedicated health endpoint
      // but are still alive. Treat 404/405 as "degraded" (alive but no health
      // endpoint), and 5xx as "down".
      if (resp.status === 404 || resp.status === 405) {
        // Try the base URL itself as a fallback
        try {
          const controller2 = new AbortController();
          const timeout2 = setTimeout(() => controller2.abort(), 5_000);
          const resp2 = await fetch(
            baseUrl.replace(/\/+$/, ''),
            { signal: controller2.signal }
          );
          clearTimeout(timeout2);
          if (resp2.ok || resp2.status < 500) {
            return {
              name: label,
              key,
              status: 'degraded',
              latencyMs: Date.now() - start,
              detail: `Pas d'endpoint /health, base HTTP ${resp2.status}`,
            };
          }
        } catch {
          // fall through to down
        }
      }
      return {
        name: label,
        key,
        status: resp.status >= 500 ? 'down' : 'degraded',
        latencyMs: latency,
        detail: `HTTP ${resp.status}`,
      };
    } catch (err) {
      const latency = Date.now() - start;
      const msg = (err as Error)?.message ?? 'erreur';
      // AbortError = timeout → degraded (slow), not fully down
      if (msg.includes('abort') || msg.includes('timeout')) {
        return {
          name: label,
          key,
          status: 'degraded',
          latencyMs: latency,
          detail: `D\u00e9lai d\u00e9pass\u00e9 (>5s)`,
        };
      }
      return {
        name: label,
        key,
        status: 'down',
        latencyMs: latency,
        detail: msg,
      };
    }
  }

  private async fetchPostHogDeployEvents(
    host: string,
    projectId: string,
    personalKey: string
  ): Promise<PostHogDeployEvent[]> {
    // PostHog Events API: GET /api/projects/<id>/events
    // Filter for deploy_* events. The API returns paginated events.
    const url = `${host}/api/projects/${projectId}/events?limit=50&event_deploy_build_started&event_deploy_build_succeeded&event_deploy_build_failed&event_deploy_boot`;
    // PostHog's events API doesn't support multi-event filtering in a single
    // query param like that. Instead, we fetch recent events and filter
    // client-side. Use a broader query and filter.
    const actualUrl = `${host}/api/projects/${projectId}/events?limit=100`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(actualUrl, {
      headers: {
        Authorization: `Bearer ${personalKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`PostHog API ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    const allEvents: PostHogDeployEvent[] = (data.results || [])
      .filter(
        (e: any) =>
          e.event === 'deploy_build_started' ||
          e.event === 'deploy_build_succeeded' ||
          e.event === 'deploy_build_failed' ||
          e.event === 'deploy_boot'
      )
      .map((e: any) => ({
        event: e.event,
        timestamp: e.timestamp,
        distinctId: e.distinct_id,
        properties: e.properties || {},
      }));

    return allEvents.slice(0, 50);
  }

  private async fetchRecentSignups(
    limit: number
  ): Promise<
    { id: string; email: string; createdAt: string }[]
  > {
    // The user model's list() orders by createdAt ASC (oldest first) and
    // takes { skip, take }. To get the MOST RECENT users, we query with a
    // high skip to get the tail, OR — more robustly — we use the Prisma
    // client directly to order DESC. The models.db exposes the Prisma client.
    const db = (this.models as any).db ?? (this.models as any).prisma;
    if (db && db.user && typeof db.user.findMany === 'function') {
      const users = await db.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, email: true, createdAt: true },
      });
      return users.map((u: any) => ({
        id: u.id,
        email: u.email ?? 'inconnu',
        createdAt:
          u.createdAt instanceof Date
            ? u.createdAt.toISOString()
            : String(u.createdAt ?? new Date().toISOString()),
      }));
    }
    // Fallback: use the model's list() with a large skip. This is less
    // reliable (we don't know the total), but works if Prisma isn't directly
    // accessible. We take the last `limit` users from the full list.
    const allUsers = await this.models.user.list({ take: limit * 5 });
    return allUsers
      .slice()
      .sort((a: any, b: any) => {
        const ta = new Date(a.createdAt).getTime();
        const tb = new Date(b.createdAt).getTime();
        return tb - ta;
      })
      .slice(0, limit)
      .map((u: any) => ({
        id: u.id,
        email: u.email ?? 'inconnu',
        createdAt:
          u.createdAt instanceof Date
            ? u.createdAt.toISOString()
            : String(u.createdAt ?? new Date().toISOString()),
      }));
  }

  private async fetchRecentEntitlementChanges(
    limit: number
  ): Promise<
    {
      userId: string;
      app: string;
      active: boolean;
      updatedAt: string;
    }[]
  > {
    // The userAppEntitlement model has a listAll() method (added in the
    // admin analytics deploy). It returns all entitlements — we sort by
    // updatedAt desc and take the top `limit`.
    const all = await this.models.userAppEntitlement.listAll();
    return all
      .map((e: any) => ({
        userId: e.userId,
        app: e.app,
        active: e.active,
        updatedAt:
          e.updatedAt instanceof Date
            ? e.updatedAt.toISOString()
            : String(e.updatedAt ?? new Date().toISOString()),
      }))
      .sort((a: any, b: any) => {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      })
      .slice(0, limit);
  }
}

// =========================================================================
// Response types (used by the frontend, exported for reference)
// =========================================================================

export type HealthStatus = 'up' | 'down' | 'degraded';

export interface HealthCheck {
  name: string;
  key: string;
  status: HealthStatus;
  latencyMs: number;
  detail: string;
}

export interface HealthResponse {
  overall: HealthStatus;
  checks: HealthCheck[];
  timestamp: string;
}

export interface PostHogDeployEvent {
  event: string;
  timestamp: string;
  distinctId: string;
  properties: Record<string, unknown>;
}

export interface DeployEventsResponse {
  events: PostHogDeployEvent[];
  configured: boolean;
  message?: string;
  posthogUrl: string;
}

export interface BaseImageResponse {
  baseImage: string;
  dataVersion: string;
  deploymentType: string;
  namespace: string;
}

export interface EventLogEntry {
  timestamp: string;
  eventType: 'signup' | 'entitlement_granted' | 'entitlement_revoked';
  userId: string;
  detail: string;
}

export interface EventLogResponse {
  events: EventLogEntry[];
  total: number;
}

export interface PostHogConfigResponse {
  host: string;
  hasProjectKey: boolean;
  hasPersonalKey: boolean;
  projectId: string | null;
  embedUrl: string | null;
  dashboardUrl: string;
}
