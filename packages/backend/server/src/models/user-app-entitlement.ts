import { Injectable } from '@nestjs/common';

import { BaseModel } from './base';

// ClickDz per-user app entitlement (all studios + AI Chat + Whiteboard).
// Mirrors user-feature.ts (get/has/list/upsert/remove over a per-user join
// table). The schema model `UserAppEntitlement` (@@map "user_app_entitlements")
// backs the `userAppEntitlement` Prisma delegate. `has()` is the provisioning
// gate: entitled ⇔ a row exists that is active AND not expired (null expiresAt
// = no expiry).

export const APP_ENTITLEMENT_APPS = [
  'slidepro',
  'socialplus',
  'coursepro',
  'zoomplus',
  'vdz',
  'voice',
  'apps',
  'shoperp',
  'hermes',
  'openclaw',
  'agents',
  'vpic',
  'integrations',
  'whatsappmax',
  'ai_chat',
  'whiteboard',
] as const;
export type AppEntitlementApp = (typeof APP_ENTITLEMENT_APPS)[number];

export type UserAppEntitlementRow = {
  id: string;
  userId: string;
  app: string;
  plan: string;
  active: boolean;
  reason: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type UserAppEntitlementDelegate = {
  findUnique(args: unknown): Promise<UserAppEntitlementRow | null>;
  findFirst(args: unknown): Promise<UserAppEntitlementRow | null>;
  findMany(args: unknown): Promise<UserAppEntitlementRow[]>;
  upsert(args: unknown): Promise<UserAppEntitlementRow>;
  updateMany(args: unknown): Promise<{ count: number }>;
};

@Injectable()
export class UserAppEntitlementModel extends BaseModel {
  // Typed accessor so the model compiles before `prisma generate` runs with
  // the new schema (the delegate appears on the generated client after
  // codegen; at runtime it is present once the migration + generate deploy).
  private get entitlement(): UserAppEntitlementDelegate {
    return (this.db as any).userAppEntitlement as UserAppEntitlementDelegate;
  }

  async get(userId: string, app: string) {
    return await this.entitlement.findUnique({
      where: { userId_app: { userId, app } },
    });
  }

  /**
   * True only when a row exists, is `active`, and is not expired
   * (expiresAt null or in the future).
   */
  async has(userId: string, app: string) {
    const row = await this.entitlement.findFirst({
      where: {
        userId,
        app,
        active: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true },
    });

    return row !== null;
  }

  async list(userId: string) {
    return await this.entitlement.findMany({
      where: { userId },
      orderBy: { app: 'asc' },
    });
  }

  /**
   * List ALL app entitlements across all users, ordered by userId.
   * Used by the admin analytics `adminUserAppEntitlements` query which
   * groups the rows by userId on the resolver side.
   */
  async listAll() {
    return await this.entitlement.findMany({
      orderBy: { userId: 'asc' },
    });
  }

  async upsert(
    userId: string,
    app: string,
    data: { plan?: string; expiresAt?: Date | null; reason?: string | null }
  ) {
    const entitlement = await this.entitlement.upsert({
      where: { userId_app: { userId, app } },
      create: {
        userId,
        app,
        plan: data.plan ?? 'manual',
        active: true,
        reason: data.reason ?? null,
        expiresAt: data.expiresAt ?? null,
      },
      update: {
        active: true,
        ...(data.plan !== undefined ? { plan: data.plan } : {}),
        ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
        ...(data.reason !== undefined ? { reason: data.reason } : {}),
      },
    });

    this.logger.verbose(`App ${app} granted to user ${userId}`);

    return entitlement;
  }

  /** Deactivates (soft-revoke) the entitlement; returns rows affected. */
  async remove(userId: string, app: string) {
    const { count } = await this.entitlement.updateMany({
      where: { userId, app },
      data: { active: false },
    });

    if (count > 0) {
      this.logger.verbose(`App ${app} revoked for user ${userId}`);
    }

    return count;
  }
}
