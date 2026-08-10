// ClickDz Work — Admin Configuration & System Info resolver.
//
// Provides admin-only GraphQL queries for the admin panel's new configuration
// pages:
//   · adminFeatureFlags  — read-only state of platform-wide env-var feature
//                          flags (toggling requires a Railway redeploy, so the
//                          UI is read-only; this query exposes current state +
//                          descriptions so the admin can see what is on/off).
//   · adminSystemInfo    — server version, database type + masked connection
//                          string, Redis host (masked), BASE_IMAGE tag, PostHog
//                          config (key masked), AI base URL + model list, GitHub
//                          repo + branch, Railway project ID.
//
// Both queries are @Admin()-guarded (same guard the existing
// AdminFeatureManagementResolver uses). No mutations — these are read-only
// diagnostic views. The resolver is registered in the CopilotModule alongside
// the other ClickDz controllers/resolvers.

import { Field, ObjectType, Query, Resolver } from '@nestjs/graphql';

import { Admin } from '../../core/common';

// ---------------------------------------------------------------------------
// Feature-flag definitions — the env-var keys the platform reads at boot. The
// admin UI shows these as a read-only list with ON/OFF indicators + French
// descriptions. Changing them requires a Railway redeploy (they are process.env
// reads, not runtime-mutable config), so the UI is intentionally read-only.
// ---------------------------------------------------------------------------
interface FlagDef {
  envVar: string;
  /** French description of what the flag controls. */
  descriptionFr: string;
}

const FEATURE_FLAG_DEFS: FlagDef[] = [
  {
    envVar: 'CDZ_WHATSAPPMAX_ENABLED',
    descriptionFr: `Active le studio WhatsappMax dans la barre latérale (multi-comptes WhatsApp).`,
  },
  {
    envVar: 'CDZ_AGENT_MEMORY_ENABLED',
    descriptionFr: `Active la mémoire des agents IA (conversation contextuelle persistante).`,
  },
  {
    envVar: 'CDZ_AGENT_TRIGGERS_ENABLED',
    descriptionFr: `Active les déclencheurs d’agents (webhooks entrants, programmations).`,
  },
  {
    envVar: 'CDZ_ZOOMPLUS_ENABLED',
    descriptionFr: `Active le studio ZOOM+ (visioconférence intégrée via Meet).`,
  },
  {
    envVar: 'CDZ_DATA_READ_GATE',
    descriptionFr: `Active le contrôle d’accès en lecture aux données ERP (token requis).`,
  },
  {
    envVar: 'CDZ_APP_TEMPLATE_CATALOG',
    descriptionFr: `Active le catalogue de modèles d’applications personnalisées.`,
  },
  {
    envVar: 'CDZ_TEMPLATE_CATALOG',
    descriptionFr: `Active le catalogue de modèles de boutique/ERP.`,
  },
];

// ---------------------------------------------------------------------------
// System info helpers — mask sensitive values (connection strings, API keys).
// ---------------------------------------------------------------------------

/** Mask all but the scheme + host of a URL, hiding credentials + path. */
function maskUrl(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    // Show scheme://host but hide any userinfo, port, path, query
    return `${u.protocol}//${u.hostname}`;
  } catch {
    // Not a URL — mask as a generic secret (show first/last 2 chars)
    if (raw.length <= 8) return '****';
    return `${raw.slice(0, 2)}…${raw.slice(-2)}`;
  }
}

/** Mask a PostHog key — show the prefix (phc_) + last 4 chars. */
function maskKey(raw: string | undefined): string {
  if (!raw) return '';
  if (raw.length <= 8) return '****';
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

/** Mask a connection string — show scheme + host only. */
function maskConnString(raw: string | undefined): string {
  if (!raw) return '';
  // Postgres: postgresql://user:pass@host:port/db
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}:${u.port || '5432'}`;
  } catch {
    return maskUrl(raw);
  }
}

/** Extract the database type from a connection string prefix. */
function dbType(connStr: string | undefined): string {
  if (!connStr) return 'unknown';
  if (connStr.startsWith('postgresql://') || connStr.startsWith('postgres://'))
    return 'postgresql';
  if (connStr.startsWith('mysql://')) return 'mysql';
  if (connStr.startsWith('mongodb://') || connStr.startsWith('mongodb+srv://'))
    return 'mongodb';
  if (connStr.startsWith('sqlite://')) return 'sqlite';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// GraphQL ObjectTypes
// ---------------------------------------------------------------------------

@ObjectType()
export class AdminFeatureFlagType {
  @Field()
  envVar!: string;

  @Field()
  enabled!: boolean;

  @Field()
  descriptionFr!: string;
}

@ObjectType()
export class AdminSystemInfoType {
  @Field()
  version!: string;

  @Field()
  deploymentType!: string;

  @Field()
  databaseType!: string;

  @Field()
  databaseUrlMasked!: string;

  @Field()
  redisHostMasked!: string;

  @Field()
  baseImage!: string;

  @Field()
  posthogKeyMasked!: string;

  @Field()
  posthogHost!: string;

  @Field()
  posthogZone!: string;

  @Field()
  aiBaseUrl!: string;

  @Field(() => [String])
  aiModels!: string[];

  @Field()
  githubRepo!: string;

  @Field()
  githubBranch!: string;

  @Field()
  railwayProjectId!: string;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

@Admin()
@Resolver()
export class ClickDzAdminConfigResolver {
  @Query(() => [AdminFeatureFlagType], {
    description: `Liste les feature flags platform-wide (lecture seule — modifier nécessite un redéploiement Railway).`,
  })
  async adminFeatureFlags(): Promise<AdminFeatureFlagType[]> {
    return FEATURE_FLAG_DEFS.map(def => ({
      envVar: def.envVar,
      enabled: process.env[def.envVar] === '1',
      descriptionFr: def.descriptionFr,
    }));
  }

  @Query(() => AdminSystemInfoType, {
    description: `Informations système de la plateforme (version, base de données, Redis, PostHog, IA, GitHub, Railway).`,
  })
  async adminSystemInfo(): Promise<AdminSystemInfoType> {
    const dbUrl = process.env.DATABASE_URL;
    const redisUrl =
      process.env.REDIS_URL ||
      process.env.REDIS_INTERNAL_URL ||
      process.env.REDIS_HOST;
    const posthogKey = process.env.CDZ_POSTHOG_KEY;
    const posthogHost = process.env.CDZ_POSTHOG_HOST || '';
    const aiBaseUrl = process.env.CDZ_AI_BASE_URL || '';
    const aiModelsRaw = process.env.CDZ_AI_MODELS || '';
    const aiModels = aiModelsRaw
      ? aiModelsRaw.split(',').map(m => m.trim()).filter(Boolean)
      : [];

    // PostHog zone: derive from host (us.i.posthog.com → US, eu.i.posthog.com → EU)
    let posthogZone = 'unknown';
    if (posthogHost.includes('us.i.posthog.com') || posthogHost.includes('us.posthog.com')) {
      posthogZone = 'US';
    } else if (posthogHost.includes('eu.i.posthog.com') || posthogHost.includes('eu.posthog.com')) {
      posthogZone = 'EU';
    }

    return {
      version: env.version,
      deploymentType: env.DEPLOYMENT_TYPE,
      databaseType: dbType(dbUrl),
      databaseUrlMasked: maskConnString(dbUrl),
      redisHostMasked: maskUrl(redisUrl),
      baseImage: process.env.BASE_IMAGE || '',
      posthogKeyMasked: maskKey(posthogKey),
      posthogHost,
      posthogZone,
      aiBaseUrl,
      aiModels,
      githubRepo: 'Clickdzpro1/clickdz-work',
      githubBranch: 'canary',
      railwayProjectId: process.env.RAILWAY_PROJECT_ID || '2db22118-85ba-4f0c-bdde-70afb29bb41f',
    };
  }
}
