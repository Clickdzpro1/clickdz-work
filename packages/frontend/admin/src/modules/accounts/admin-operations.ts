import {
  useMutateQueryResource,
  useMutation,
} from '@affine/admin/use-mutation';
import type { GraphQLQuery } from '@affine/graphql';
import { useCallback } from 'react';
import { toast } from 'sonner';

/**
 * Hand-written GraphQL operations for the new admin user-management
 * mutations. These are NOT part of the generated @affine/graphql codegen
 * yet — the shapes match the backend resolvers in user/resolver.ts and
 * features/resolver.ts.
 */

// ── suspendUser ──────────────────────────────────────────────────────
export const suspendUserMutation = {
  id: 'suspendUserMutation' as const,
  op: 'suspendUser',
  query: `mutation suspendUser($id: String!) {
  suspendUser(id: $id) {
    id
    name
    email
    disabled
  }
}`,
} satisfies GraphQLQuery;

// ── bulkSuspendUsers ─────────────────────────────────────────────────
export const bulkSuspendUsersMutation = {
  id: 'bulkSuspendUsersMutation' as const,
  op: 'bulkSuspendUsers',
  query: `mutation bulkSuspendUsers($ids: [String!]!) {
  bulkSuspendUsers(ids: $ids)
}`,
} satisfies GraphQLQuery;

// ── bulkEnableUsers ──────────────────────────────────────────────────
export const bulkEnableUsersMutation = {
  id: 'bulkEnableUsersMutation' as const,
  op: 'bulkEnableUsers',
  query: `mutation bulkEnableUsers($ids: [String!]!) {
  bulkEnableUsers(ids: $ids)
}`,
} satisfies GraphQLQuery;

// ── bulkGrantUserApp ─────────────────────────────────────────────────
export const bulkGrantUserAppMutation = {
  id: 'bulkGrantUserAppMutation' as const,
  op: 'bulkGrantUserApp',
  query: `mutation bulkGrantUserApp($userIds: [String!]!, $app: String!, $plan: String) {
  bulkGrantUserApp(userIds: $userIds, app: $app, plan: $plan)
}`,
} satisfies GraphQLQuery;

// ── bulkRevokeUserApp ────────────────────────────────────────────────
export const bulkRevokeUserAppMutation = {
  id: 'bulkRevokeUserAppMutation' as const,
  op: 'bulkRevokeUserApp',
  query: `mutation bulkRevokeUserApp($userIds: [String!]!, $app: String!) {
  bulkRevokeUserApp(userIds: $userIds, app: $app)
}`,
} satisfies GraphQLQuery;

// ── grantAdmin ───────────────────────────────────────────────────────
export const grantAdminMutation = {
  id: 'grantAdminMutation' as const,
  op: 'grantAdmin',
  query: `mutation grantAdmin($userId: String!) {
  grantAdmin(userId: $userId)
}`,
} satisfies GraphQLQuery;

// ── revokeAdmin ──────────────────────────────────────────────────────
export const revokeAdminMutation = {
  id: 'revokeAdminMutation' as const,
  op: 'revokeAdmin',
  query: `mutation revokeAdmin($userId: String!) {
  revokeAdmin(userId: $userId)
}`,
} satisfies GraphQLQuery;

// ── userById (fetch full user details) ───────────────────────────────
export const userByIdQuery = {
  id: 'userByIdAdminQuery' as const,
  op: 'userById',
  query: `query userByIdAdmin($id: String!) {
  userById(id: $id) {
    id
    name
    email
    avatarUrl
    emailVerified
    hasPassword
    createdAt
    disabled
  }
}`,
} satisfies GraphQLQuery;

// ── Hooks ────────────────────────────────────────────────────────────

export const useSuspendUser = () => {
  const { trigger: suspendTrigger, isMutating: suspending } = useMutation({
    mutation: suspendUserMutation as GraphQLQuery,
  });
  const revalidate = useMutateQueryResource();

  const suspend = useCallback(
    async (id: string, callback?: () => void) => {
      try {
        await suspendTrigger({ id });
        await revalidate(suspendUserMutation as GraphQLQuery);
        toast(`Utilisateur suspendu`);
        callback?.();
      } catch (e) {
        toast.error(`Échec de la suspension: ${(e as Error).message}`);
      }
    },
    [suspendTrigger, revalidate]
  );

  return { suspend, suspending };
};

export const useBulkSuspendUsers = () => {
  const { trigger: bulkSuspendTrigger, isMutating: suspending } = useMutation({
    mutation: bulkSuspendUsersMutation as GraphQLQuery,
  });
  const revalidate = useMutateQueryResource();

  const bulkSuspend = useCallback(
    async (ids: string[], callback?: () => void) => {
      try {
        await bulkSuspendTrigger({ ids });
        await revalidate(bulkSuspendUsersMutation as GraphQLQuery);
        toast(`${ids.length} utilisateur(s) suspendu(s)`);
        callback?.();
      } catch (e) {
        toast.error(`Échec de la suspension: ${(e as Error).message}`);
      }
    },
    [bulkSuspendTrigger, revalidate]
  );

  return { bulkSuspend, suspending };
};

export const useBulkEnableUsers = () => {
  const { trigger: bulkEnableTrigger, isMutating: enabling } = useMutation({
    mutation: bulkEnableUsersMutation as GraphQLQuery,
  });
  const revalidate = useMutateQueryResource();

  const bulkEnable = useCallback(
    async (ids: string[], callback?: () => void) => {
      try {
        await bulkEnableTrigger({ ids });
        await revalidate(bulkEnableUsersMutation as GraphQLQuery);
        toast(`${ids.length} utilisateur(s) activé(s)`);
        callback?.();
      } catch (e) {
        toast.error(`Échec de l\u{2019}activation: ${(e as Error).message}`);
      }
    },
    [bulkEnableTrigger, revalidate]
  );

  return { bulkEnable, enabling };
};

export const useBulkGrantUserApp = () => {
  const { trigger: bulkGrantTrigger, isMutating: granting } = useMutation({
    mutation: bulkGrantUserAppMutation as GraphQLQuery,
  });
  const revalidate = useMutateQueryResource();

  const bulkGrant = useCallback(
    async (userIds: string[], app: string, plan?: string, callback?: () => void) => {
      try {
        await bulkGrantTrigger({ userIds, app, plan });
        await revalidate(bulkGrantUserAppMutation as GraphQLQuery);
        toast(`Accès accordé à ${userIds.length} utilisateur(s)`);
        callback?.();
      } catch (e) {
        toast.error(`Échec de l\u{2019}attribution: ${(e as Error).message}`);
      }
    },
    [bulkGrantTrigger, revalidate]
  );

  return { bulkGrant, granting };
};

export const useBulkRevokeUserApp = () => {
  const { trigger: bulkRevokeTrigger, isMutating: revoking } = useMutation({
    mutation: bulkRevokeUserAppMutation as GraphQLQuery,
  });
  const revalidate = useMutateQueryResource();

  const bulkRevoke = useCallback(
    async (userIds: string[], app: string, callback?: () => void) => {
      try {
        await bulkRevokeTrigger({ userIds, app });
        await revalidate(bulkRevokeUserAppMutation as GraphQLQuery);
        toast(`Accès révoqué pour ${userIds.length} utilisateur(s)`);
        callback?.();
      } catch (e) {
        toast.error(`Échec de la révocation: ${(e as Error).message}`);
      }
    },
    [bulkRevokeTrigger, revalidate]
  );

  return { bulkRevoke, revoking };
};

export const useGrantAdmin = () => {
  const { trigger: grantAdminTrigger, isMutating: granting } = useMutation({
    mutation: grantAdminMutation as GraphQLQuery,
  });
  const revalidate = useMutateQueryResource();

  const grantAdmin = useCallback(
    async (userId: string, callback?: () => void) => {
      try {
        await grantAdminTrigger({ userId });
        await revalidate(grantAdminMutation as GraphQLQuery);
        toast(`Privilèges administrateur accordés`);
        callback?.();
      } catch (e) {
        toast.error(`Échec: ${(e as Error).message}`);
      }
    },
    [grantAdminTrigger, revalidate]
  );

  return { grantAdmin, granting };
};

export const useRevokeAdmin = () => {
  const { trigger: revokeAdminTrigger, isMutating: revoking } = useMutation({
    mutation: revokeAdminMutation as GraphQLQuery,
  });
  const revalidate = useMutateQueryResource();

  const revokeAdmin = useCallback(
    async (userId: string, callback?: () => void) => {
      try {
        await revokeAdminTrigger({ userId });
        await revalidate(revokeAdminMutation as GraphQLQuery);
        toast(`Privilèges administrateur révoqués`);
        callback?.();
      } catch (e) {
        toast.error(`Échec: ${(e as Error).message}`);
      }
    },
    [revokeAdminTrigger, revalidate]
  );

  return { revokeAdmin, revoking };
};
