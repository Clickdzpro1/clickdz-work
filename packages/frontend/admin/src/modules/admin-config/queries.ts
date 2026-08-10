// ClickDz Work — Admin Configuration shared GraphQL queries + types.
//
// Hand-written GraphQL operations (same pattern as accounts/app-entitlements.ts)
// because the adminFeatureFlags / adminSystemInfo schema additions are
// code-first NestJS GraphQL (generated at runtime, not in @affine/graphql
// codegen). The query shapes match the backend ObjectType definitions in
// clickdz-admin-config.resolver.ts.

import type { GraphQLQuery } from '@affine/graphql';

// ---------------------------------------------------------------------------
// Feature Flags query (read-only)
// ---------------------------------------------------------------------------

export interface FeatureFlagInfo {
  envVar: string;
  enabled: boolean;
  descriptionFr: string;
}

interface FeatureFlagsResponse {
  adminFeatureFlags: FeatureFlagInfo[];
}

export const adminFeatureFlagsQuery = {
  id: 'adminFeatureFlagsQuery' as const,
  op: 'adminFeatureFlags',
  query: `query adminFeatureFlags {
  adminFeatureFlags {
    envVar
    enabled
    descriptionFr
  }
}`,
} satisfies GraphQLQuery;

// ---------------------------------------------------------------------------
// System Info query
// ---------------------------------------------------------------------------

export interface SystemInfo {
  version: string;
  deploymentType: string;
  databaseType: string;
  databaseUrlMasked: string;
  redisHostMasked: string;
  baseImage: string;
  posthogKeyMasked: string;
  posthogHost: string;
  posthogZone: string;
  aiBaseUrl: string;
  aiModels: string[];
  githubRepo: string;
  githubBranch: string;
  railwayProjectId: string;
}

interface SystemInfoResponse {
  adminSystemInfo: SystemInfo;
}

export const adminSystemInfoQuery = {
  id: 'adminSystemInfoQuery' as const,
  op: 'adminSystemInfo',
  query: `query adminSystemInfo {
  adminSystemInfo {
    version
    deploymentType
    databaseType
    databaseUrlMasked
    redisHostMasked
    baseImage
    posthogKeyMasked
    posthogHost
    posthogZone
    aiBaseUrl
    aiModels
    githubRepo
    githubBranch
    railwayProjectId
  }
}`,
} satisfies GraphQLQuery;

// Re-export response interfaces for consumers
export type { FeatureFlagsResponse, SystemInfoResponse };
