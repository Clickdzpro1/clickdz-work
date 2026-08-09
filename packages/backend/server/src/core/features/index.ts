import { Module } from '@nestjs/common';

import { EntitlementModule } from '../entitlement';
import {
  AdminFeatureManagementResolver,
  UserAppEntitlementResolver,
  UserFeatureResolver,
} from './resolver';
import { FeatureService } from './service';

@Module({
  imports: [EntitlementModule],
  providers: [
    UserFeatureResolver,
    AdminFeatureManagementResolver,
    UserAppEntitlementResolver,
    FeatureService,
  ],
  exports: [FeatureService],
})
export class FeatureModule {}

export { FeatureService };
export { AvailableUserFeatureConfig } from './types';
