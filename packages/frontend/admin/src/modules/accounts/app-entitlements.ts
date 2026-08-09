import {
  useMutateQueryResource,
  useMutation,
} from '@affine/admin/use-mutation';
import { useQuery } from '@affine/admin/use-query';
import type { GraphQLQuery } from '@affine/graphql';
import { useCallback } from 'react';
import { toast } from 'sonner';

/**
 * Per-user application gating (accès aux applications).
 *
 * The GraphQL operations below are hand-written because the
 * `userAppEntitlements` / `grantUserApp` / `revokeUserApp` schema additions
 * are not part of the generated `@affine/graphql` codegen yet. The shape
 * matches the backend schema (query userAppEntitlements(userId: String!),
 * mutations grantUserApp / revokeUserApp).
 */

export type UserAppKey =
  | 'SLIDE_PRO'
  | 'SOCIAL_PLUS'
  | 'COURSE_PRO'
  | 'ZOOM_PLUS'
  | 'VDZ'
  | 'VOICE'
  | 'APPS'
  | 'SHOPERP'
  | 'HERMES'
  | 'OPENCLAW'
  | 'AGENTS'
  | 'VPIC'
  | 'INTEGRATIONS'
  | 'WHATSAPPMAX'
  | 'AI_CHAT'
  | 'WHITEBOARD';

export interface UserAppEntitlement {
  app: string;
  active: boolean;
  plan?: string | null;
  expiresAt?: string | null;
}

export interface UserAppEntitlementsResponse {
  userAppEntitlements: UserAppEntitlement[];
}

export const userAppEntitlementsQuery = {
  id: 'userAppEntitlementsQuery' as const,
  op: 'userAppEntitlements',
  query: `query userAppEntitlements($userId: String!) {
  userAppEntitlements(userId: $userId) {
    app
    active
    plan
    expiresAt
  }
}`,
} satisfies GraphQLQuery;

export const grantUserAppMutation = {
  id: 'grantUserAppMutation' as const,
  op: 'grantUserApp',
  query: `mutation grantUserApp($input: GrantUserAppInput!) {
  grantUserApp(input: $input) {
    app
    active
    plan
    expiresAt
  }
}`,
} satisfies GraphQLQuery;

export const revokeUserAppMutation = {
  id: 'revokeUserAppMutation' as const,
  op: 'revokeUserApp',
  query: `mutation revokeUserApp($input: RevokeUserAppInput!) {
  revokeUserApp(input: $input) {
    app
    active
    plan
    expiresAt
  }
}`,
} satisfies GraphQLQuery;

/** All gateable applications, with their display labels. */
export const USER_APPS: { key: UserAppKey; label: string }[] = [
  { key: 'SLIDE_PRO', label: 'SlidePro' },
  { key: 'SOCIAL_PLUS', label: 'Social' },
  { key: 'COURSE_PRO', label: 'CoursePro' },
  { key: 'ZOOM_PLUS', label: 'ZOOM+' },
  { key: 'VDZ', label: 'Vdz Studio' },
  { key: 'VOICE', label: 'Voice Studio' },
  { key: 'APPS', label: 'ClickDz Apps' },
  { key: 'SHOPERP', label: 'DzOS' },
  { key: 'HERMES', label: 'Hermes' },
  { key: 'OPENCLAW', label: 'OpenClaw' },
  { key: 'AGENTS', label: 'Agents' },
  { key: 'VPIC', label: 'Studio Image' },
  { key: 'INTEGRATIONS', label: 'Integrations Flows' },
  { key: 'WHATSAPPMAX', label: 'WhatsappMax' },
  { key: 'AI_CHAT', label: 'AI Chat' },
  { key: 'WHITEBOARD', label: 'Whiteboard' },
];

/**
 * Fetch the app entitlements for a given user. Uses suspense-mode SWR, like
 * the other admin `useQuery` callers, so it must be rendered under a
 * <Suspense> boundary.
 */
export const useUserAppEntitlements = (userId: string) => {
  const { data } = useQuery({
    query: userAppEntitlementsQuery,
    variables: { userId },
  } as Parameters<typeof useQuery>[0]);

  const entitlements =
    (data as unknown as UserAppEntitlementsResponse | undefined)
      ?.userAppEntitlements ?? [];

  return { entitlements };
};

export const useUserAppMutations = (userId: string) => {
  // The hand-written mutations are cast through `GraphQLQuery` because their
  // variables are not part of the generated codegen types.
  const { trigger: grantTrigger, isMutating: granting } = useMutation({
    mutation: grantUserAppMutation as GraphQLQuery,
  });
  const { trigger: revokeTrigger, isMutating: revoking } = useMutation({
    mutation: revokeUserAppMutation as GraphQLQuery,
  });
  const revalidate = useMutateQueryResource();

  const grant = useCallback(
    async (app: UserAppKey, plan?: string) => {
      try {
        await grantTrigger({ input: { userId, app, plan } });
        await revalidate(userAppEntitlementsQuery as GraphQLQuery);
        toast('Accès accordé');
      } catch (e) {
        toast.error("Échec de l'attribution: " + (e as Error).message);
      }
    },
    [grantTrigger, revalidate, userId]
  );

  const revoke = useCallback(
    async (app: UserAppKey) => {
      try {
        await revokeTrigger({ input: { userId, app } });
        await revalidate(userAppEntitlementsQuery as GraphQLQuery);
        toast('Accès révoqué');
      } catch (e) {
        toast.error('Échec de la révocation: ' + (e as Error).message);
      }
    },
    [revokeTrigger, revalidate, userId]
  );

  return { grant, revoke, mutating: granting || revoking };
};
