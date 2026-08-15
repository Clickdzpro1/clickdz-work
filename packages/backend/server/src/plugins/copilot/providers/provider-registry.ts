import type {
  CopilotProviderConfigMap,
  CopilotProviderDefaults,
  CopilotProviderProfile,
  ProviderMiddlewareConfig,
} from '../config';
import { resolveProviderMiddleware } from './provider-middleware';
import { CopilotProviderType, ModelOutputType } from './types';

const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9-_]+$/;

// WS14: this is now an ALLOWLIST, not a floor.
//
// It used to hold the 15 legacy Make-engine ids and was UNIONED into the
// `cdz-ai` profile so a stale DB profile could never shrink the catalog. That
// union is precisely why repointing the profile at the Vercel AI Gateway still
// surfaced models nobody registered: whatever the bootstrap wrote, these ids
// were added back on every registry load, so the profile could only ever grow.
// Inverting it to a filter means the effective model set can never exceed this
// list, so a stale DB row or config-volume profile cannot smuggle a Gateway
// model (e.g. poolside/laguna-s-2.1-free) into the registry.
//
// The bootstrap remains the source of credentials and base URL. Keep in sync
// with CDZ_MODELS in scripts/cdz-ai-config.mjs and CDZ_CHAT_MODEL in
// clickdz-bridge.controller.ts.
const CLICKDZ_PROVIDER_MODELS = ['zai/glm-4.6v-flash'] as const;

const LEGACY_PROVIDER_ORDER: CopilotProviderType[] = [
  CopilotProviderType.OpenAI,
  CopilotProviderType.CloudflareWorkersAi,
  CopilotProviderType.FAL,
  CopilotProviderType.Gemini,
  CopilotProviderType.GeminiVertex,
  CopilotProviderType.Anthropic,
  CopilotProviderType.AnthropicVertex,
];

const LEGACY_PROVIDER_PRIORITY = LEGACY_PROVIDER_ORDER.reduce(
  (acc, type, index) => {
    acc[type] = LEGACY_PROVIDER_ORDER.length - index;
    return acc;
  },
  {} as Record<CopilotProviderType, number>
);

type LegacyProvidersConfig = Partial<
  Record<CopilotProviderType, CopilotProviderConfigMap[CopilotProviderType]>
>;

export type CopilotProvidersConfigInput = LegacyProvidersConfig & {
  profiles?: CopilotProviderProfile[] | null;
  defaults?: CopilotProviderDefaults | null;
};

export type NormalizedCopilotProviderProfile = Omit<
  CopilotProviderProfile,
  'enabled' | 'priority' | 'middleware'
> & {
  enabled: boolean;
  priority: number;
  middleware: ProviderMiddlewareConfig;
};

export type CopilotProviderRegistry = {
  profiles: Map<string, NormalizedCopilotProviderProfile>;
  defaults: CopilotProviderDefaults;
  order: string[];
  byType: Map<CopilotProviderType, string[]>;
};

export type ResolveModelResult = {
  rawModelId?: string;
  modelId?: string;
  explicitProviderId?: string;
  candidateProviderIds: string[];
};

type ResolveModelOptions = {
  registry: CopilotProviderRegistry;
  modelId?: string;
  outputType?: ModelOutputType;
  availableProviderIds?: Iterable<string>;
  preferredProviderIds?: Iterable<string>;
};

function unique<T>(list: T[]): T[] {
  return [...new Set(list)];
}

function asArray<T>(iter?: Iterable<T>): T[] {
  return iter ? Array.from(iter) : [];
}

function parseModelPrefix(
  registry: CopilotProviderRegistry,
  modelId: string
): { providerId: string; modelId?: string } | null {
  const index = modelId.indexOf('/');
  if (index <= 0) {
    return null;
  }

  const providerId = modelId.slice(0, index);
  if (!registry.profiles.has(providerId)) {
    return null;
  }

  const model = modelId.slice(index + 1);
  return { providerId, modelId: model || undefined };
}

// Clamp the `cdz-ai` profile to the WS14 allowlist. Never returns an empty
// list: a profile with no usable ids falls back to the allowlist itself, so a
// partial DB row degrades to the known-good model rather than leaving the
// provider with nothing to serve (which reads to users as "native AI is down").
function clampToClickDzCatalog(models?: string[]): string[] {
  const allowed = CLICKDZ_PROVIDER_MODELS as readonly string[];
  if (!models?.length) {
    return [...allowed];
  }
  const kept = models.filter(model => allowed.includes(model));
  return kept.length ? kept : [...allowed];
}

function normalizeProfile(
  profile: CopilotProviderProfile
): NormalizedCopilotProviderProfile {
  return {
    ...profile,
    models:
      profile.id === 'cdz-ai'
        ? clampToClickDzCatalog(profile.models)
        : profile.models,
    enabled: profile.enabled !== false,
    priority: profile.priority ?? 0,
    middleware: resolveProviderMiddleware(profile.type, profile.middleware),
  };
}

function toLegacyProfiles(
  config: CopilotProvidersConfigInput
): CopilotProviderProfile[] {
  const legacyProfiles: CopilotProviderProfile[] = [];
  for (const type of LEGACY_PROVIDER_ORDER) {
    const legacyConfig = config[type];
    if (!legacyConfig) {
      continue;
    }
    legacyProfiles.push({
      id: `${type}-default`,
      type,
      priority: LEGACY_PROVIDER_PRIORITY[type],
      config: legacyConfig,
    } as CopilotProviderProfile);
  }
  return legacyProfiles;
}

function mergeProfiles(
  explicitProfiles: CopilotProviderProfile[],
  legacyProfiles: CopilotProviderProfile[]
): CopilotProviderProfile[] {
  const profiles = new Map<string, CopilotProviderProfile>();

  for (const profile of explicitProfiles) {
    if (!PROVIDER_ID_PATTERN.test(profile.id)) {
      throw new Error(`Invalid copilot provider profile id: ${profile.id}`);
    }
    if (profiles.has(profile.id)) {
      throw new Error(`Duplicated copilot provider profile id: ${profile.id}`);
    }
    profiles.set(profile.id, profile);
  }

  for (const profile of legacyProfiles) {
    if (!profiles.has(profile.id)) {
      profiles.set(profile.id, profile);
    }
  }

  return Array.from(profiles.values());
}

function sortProfiles(profiles: NormalizedCopilotProviderProfile[]) {
  return profiles.toSorted((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    return a.id.localeCompare(b.id);
  });
}

function assertDefaults(
  defaults: CopilotProviderDefaults,
  profiles: Map<string, NormalizedCopilotProviderProfile>
) {
  for (const providerId of Object.values(defaults)) {
    if (!providerId) {
      continue;
    }
    if (!profiles.has(providerId)) {
      throw new Error(
        `Copilot provider defaults references unknown providerId: ${providerId}`
      );
    }
  }
}

export function buildProviderRegistry(
  config: CopilotProvidersConfigInput
): CopilotProviderRegistry {
  const explicitProfiles = config.profiles ?? [];
  const legacyProfiles = toLegacyProfiles(config);
  const mergedProfiles = mergeProfiles(explicitProfiles, legacyProfiles)
    .map(normalizeProfile)
    .filter(profile => profile.enabled);
  const sortedProfiles = sortProfiles(mergedProfiles);

  const profiles = new Map(
    sortedProfiles.map(profile => [profile.id, profile] as const)
  );
  const defaults = config.defaults ?? {};
  assertDefaults(defaults, profiles);

  const order = sortedProfiles.map(profile => profile.id);
  const byType = new Map<CopilotProviderType, string[]>();
  for (const profile of sortedProfiles) {
    const ids = byType.get(profile.type) ?? [];
    ids.push(profile.id);
    byType.set(profile.type, ids);
  }

  return { profiles, defaults, order, byType };
}

export function resolveModel({
  registry,
  modelId,
  outputType,
  availableProviderIds,
  preferredProviderIds,
}: ResolveModelOptions): ResolveModelResult {
  const available = new Set(asArray(availableProviderIds));
  const preferred = new Set(asArray(preferredProviderIds));
  const hasAvailableFilter = available.size > 0;
  const hasPreferredFilter = preferred.size > 0;

  const isAllowed = (providerId: string) => {
    const profile = registry.profiles.get(providerId);
    if (!profile?.enabled) {
      return false;
    }
    if (hasAvailableFilter && !available.has(providerId)) {
      return false;
    }
    if (hasPreferredFilter && !preferred.has(providerId)) {
      return false;
    }
    return true;
  };

  const prefixed = modelId ? parseModelPrefix(registry, modelId) : null;
  if (prefixed) {
    return {
      rawModelId: modelId,
      modelId: prefixed.modelId,
      explicitProviderId: prefixed.providerId,
      candidateProviderIds: isAllowed(prefixed.providerId)
        ? [prefixed.providerId]
        : [],
    };
  }

  if (modelId) {
    return {
      rawModelId: modelId,
      modelId,
      candidateProviderIds: registry.order.filter(providerId =>
        isAllowed(providerId)
      ),
    };
  }

  const defaultProviderId =
    outputType && outputType !== ModelOutputType.Rerank
      ? registry.defaults[outputType]
      : undefined;

  const fallbackOrder = [
    ...(defaultProviderId ? [defaultProviderId] : []),
    registry.defaults.fallback,
    ...registry.order,
  ].filter((id): id is string => !!id);

  return {
    rawModelId: modelId,
    modelId,
    candidateProviderIds: unique(
      fallbackOrder.filter(providerId => isAllowed(providerId))
    ),
  };
}

export function stripProviderPrefix(
  registry: CopilotProviderRegistry,
  providerId: string,
  modelId?: string
) {
  if (!modelId) {
    return modelId;
  }
  const prefixed = parseModelPrefix(registry, modelId);
  if (!prefixed) {
    return modelId;
  }
  if (prefixed.providerId !== providerId) {
    return modelId;
  }
  return prefixed.modelId;
}
