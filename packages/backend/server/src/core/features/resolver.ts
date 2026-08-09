import {
  Args,
  Field,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Parent,
  Query,
  registerEnumType,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { difference } from 'lodash-es';

import { BadRequest, EventBus } from '../../base';
import {
  APP_ENTITLEMENT_APPS,
  Feature,
  Models,
  type UserFeatureName,
} from '../../models';
import { Admin } from '../common';
import { EntitlementService } from '../entitlement';
import { UserType } from '../user/types';
import { AvailableUserFeatureConfig } from './types';

registerEnumType(Feature, {
  name: 'FeatureType',
});

@ObjectType('UserAppEntitlement')
class UserAppEntitlementType {
  @Field()
  app!: string;

  @Field()
  plan!: string;

  @Field()
  active!: boolean;

  @Field(() => String, { nullable: true })
  reason?: string | null;

  @Field(() => Date, { nullable: true })
  expiresAt?: Date | null;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;
}

@ObjectType('AdminUserAppEntitlement')
class AdminUserAppEntitlementType {
  @Field()
  userId!: string;

  @Field(() => [UserAppEntitlementType])
  entitlements!: UserAppEntitlementType[];
}

@InputType()
class GrantUserAppInput {
  @Field()
  userId!: string;

  @Field()
  app!: string;

  @Field(() => String, { nullable: true })
  plan?: string;

  @Field(() => Date, { nullable: true })
  expiresAt?: Date;
}

@InputType()
class RevokeUserAppInput {
  @Field()
  userId!: string;

  @Field()
  app!: string;
}

@Resolver(() => UserType)
export class UserFeatureResolver extends AvailableUserFeatureConfig {
  constructor(private readonly models: Models) {
    super();
  }

  @ResolveField(() => [Feature], {
    name: 'features',
    description: 'Enabled features of a user',
  })
  async userFeatures(@Parent() user: UserType) {
    const features = await this.models.userFeature.list(
      user.id,
      undefined,
      Array.from(this.availableUserFeatures())
    );
    const availableUserFeatures = this.availableUserFeatures();
    return features.filter(feature => availableUserFeatures.has(feature));
  }
}

@Admin()
@Resolver(() => Boolean)
export class AdminFeatureManagementResolver extends AvailableUserFeatureConfig {
  constructor(
    private readonly models: Models,
    private readonly entitlement: EntitlementService,
    private readonly event: EventBus
  ) {
    super();
  }

  @Mutation(() => [Feature], {
    description: 'update user enabled feature',
  })
  async updateUserFeatures(
    @Args('id') id: string,
    @Args({ name: 'features', type: () => [Feature] })
    features: UserFeatureName[]
  ) {
    const configurableUserFeatures = this.configurableUserFeatures();
    const unsupported = features.filter(
      feature => !configurableUserFeatures.has(feature)
    );
    if (unsupported.length) {
      throw new BadRequest(
        `User feature ${unsupported.join(', ')} is not configurable`
      );
    }
    const removed = difference(Array.from(configurableUserFeatures), features);

    await Promise.all(
      features.map(feature =>
        this.models.userFeature.add(id, feature, 'admin panel')
      )
    );

    await Promise.all(
      removed.map(feature => this.models.userFeature.remove(id, feature))
    );

    const user = await this.models.user.get(id);
    if (user) {
      this.event.emit('user.updated', user);
    }

    return features;
  }

  @Mutation(() => Boolean)
  async grantCommercialEntitlement(
    @Args('targetType', { type: () => String })
    targetType: 'user' | 'workspace',
    @Args('targetId', { type: () => String }) targetId: string,
    @Args('plan', { type: () => String }) plan: string,
    @Args('quantity', { type: () => Int, nullable: true }) quantity?: number
  ) {
    await this.entitlement.upsertAdminGrant({
      targetType,
      targetId,
      plan,
      quantity,
    });
    return true;
  }

  @Mutation(() => Boolean)
  async revokeCommercialEntitlement(
    @Args('targetType', { type: () => String })
    targetType: 'user' | 'workspace',
    @Args('targetId', { type: () => String }) targetId: string
  ) {
    await this.entitlement.revokeAdminGrant(targetType, targetId);
    return true;
  }

  @Mutation(() => UserAppEntitlementType, {
    description: 'Grant a ClickDz app entitlement to a user (admin)',
  })
  async grantUserApp(
    @Args('input', { type: () => GrantUserAppInput }) input: GrantUserAppInput
  ) {
    const normalized = input.app.toLowerCase();
    if (!APP_ENTITLEMENT_APPS.includes(normalized as any)) {
      throw new BadRequest(`Unknown app "${input.app}"`);
    }
    return await this.models.userAppEntitlement.upsert(input.userId, normalized, {
      plan: input.plan ?? 'manual',
      expiresAt: input.expiresAt ?? null,
      reason: 'admin panel',
    });
  }

  @Mutation(() => UserAppEntitlementType, {
    description: 'Revoke a ClickDz app entitlement from a user (admin)',
  })
  async revokeUserApp(
    @Args('input', { type: () => RevokeUserAppInput }) input: RevokeUserAppInput
  ) {
    const normalized = input.app.toLowerCase();
    await this.models.userAppEntitlement.remove(input.userId, normalized);
    // Return the deactivated row so the frontend gets the updated entitlement
    return await this.models.userAppEntitlement.get(input.userId, normalized);
  }

  @Query(() => [UserAppEntitlementType], {
    description: 'List ClickDz app entitlements of a user (admin)',
  })
  async userAppEntitlements(@Args('userId') userId: string) {
    return await this.models.userAppEntitlement.list(userId);
  }

  @Query(() => [AdminUserAppEntitlementType], {
    description: 'List ClickDz app entitlements grouped by user (admin analytics)',
  })
  async adminUserAppEntitlements() {
    const rows = await this.models.userAppEntitlement.listAll();

    // Group by userId, preserving the order of first appearance
    const map = new Map<string, UserAppEntitlementType[]>();
    for (const row of rows) {
      const group = map.get(row.userId);
      if (group) {
        group.push(row);
      } else {
        map.set(row.userId, [row]);
      }
    }

    return Array.from(map.entries()).map(([userId, entitlements]) => ({
      userId,
      entitlements,
    }));
  }
}
