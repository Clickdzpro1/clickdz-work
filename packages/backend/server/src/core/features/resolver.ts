import {
  Args,
  Field,
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

  @Field({ nullable: true })
  expiresAt?: Date | null;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
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

  @Mutation(() => Boolean, {
    description: 'Grant a ClickDz app entitlement to a user (admin)',
  })
  async grantUserApp(
    @Args('userId') userId: string,
    @Args('app') app: string,
    @Args('plan', { type: () => String, nullable: true }) plan?: string,
    @Args('expiresAt', { type: () => Date, nullable: true }) expiresAt?: Date
  ) {
    const normalized = app.toLowerCase();
    if (!APP_ENTITLEMENT_APPS.includes(normalized as any)) {
      throw new BadRequest(`Unknown app "${app}"`);
    }
    await this.models.userAppEntitlement.upsert(userId, normalized, {
      plan: plan ?? 'manual',
      expiresAt: expiresAt ?? null,
      reason: 'admin panel',
    });
    return true;
  }

  @Mutation(() => Boolean, {
    description: 'Revoke a ClickDz app entitlement from a user (admin)',
  })
  async revokeUserApp(
    @Args('userId') userId: string,
    @Args('app') app: string
  ) {
    await this.models.userAppEntitlement.remove(userId, app.toLowerCase());
    return true;
  }

  @Query(() => [UserAppEntitlementType], {
    description: 'List ClickDz app entitlements of a user (admin)',
  })
  async userAppEntitlements(@Args('userId') userId: string) {
    return await this.models.userAppEntitlement.list(userId);
  }
}
