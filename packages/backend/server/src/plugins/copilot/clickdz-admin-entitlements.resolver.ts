// ClickDz Work — Admin analytics entitlements resolver.
//
// The admin analytics dashboard queries
//   adminUserAppEntitlements { userId entitlements { app active plan expiresAt } }
// (see packages/frontend/admin/src/modules/analytics/index.tsx —
// EntitlementsMetricCard, AppEntitlementsSection and the CSV export), but no
// backend resolver defined this query. NestJS code-first GraphQL therefore
// rejected it at schema validation, and the dashboard's error boundary showed
// "Resource not found".
//
// This resolver (@Admin()-guarded, same pattern as ClickDzAdminConfigResolver)
// reads every entitlement row via UserAppEntitlementModel.listAll() and groups
// them by userId. App names are returned as stored (lowercase, per
// APP_ENTITLEMENT_APPS) — the frontend lowercases its own keys to match.
// Read-only; registered in the CopilotModule alongside the other ClickDz
// resolvers.

import { Field, ObjectType, Query, Resolver } from '@nestjs/graphql';

import { Admin } from '../../core/common';
import { Models } from '../../models';

@ObjectType()
export class AdminAppEntitlementEntryType {
  @Field()
  app!: string;

  @Field()
  active!: boolean;

  @Field()
  plan!: string;

  @Field(() => Date, { nullable: true })
  expiresAt!: Date | null;
}

@ObjectType()
export class AdminUserAppEntitlementType {
  @Field()
  userId!: string;

  @Field(() => [AdminAppEntitlementEntryType])
  entitlements!: AdminAppEntitlementEntryType[];
}

@Admin()
@Resolver()
export class ClickDzAdminEntitlementsResolver {
  constructor(private readonly models: Models) {}

  @Query(() => [AdminUserAppEntitlementType], {
    description: `Entitlements d’applications par utilisateur (tableau de bord analytique admin).`,
  })
  async adminUserAppEntitlements(): Promise<AdminUserAppEntitlementType[]> {
    const rows = await this.models.userAppEntitlement.listAll();

    const byUser = new Map<string, AdminAppEntitlementEntryType[]>();
    for (const row of rows) {
      let list = byUser.get(row.userId);
      if (!list) {
        list = [];
        byUser.set(row.userId, list);
      }
      list.push({
        app: row.app,
        active: row.active,
        plan: row.plan,
        expiresAt: row.expiresAt,
      });
    }

    return Array.from(byUser.entries(), ([userId, entitlements]) => ({
      userId,
      entitlements,
    }));
  }
}
