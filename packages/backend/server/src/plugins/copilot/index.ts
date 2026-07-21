import './config';

import { Module } from '@nestjs/common';

import { ServerConfigModule } from '../../core';
import { DocStorageModule } from '../../core/doc';
import { FeatureModule } from '../../core/features';
import { PermissionModule } from '../../core/permission';
import { QuotaModule } from '../../core/quota';
import { StorageModule } from '../../core/storage';
import { WorkspaceModule } from '../../core/workspaces';
import { IndexerModule } from '../indexer';
import { ClickDzBridgeController } from './clickdz-bridge.controller';
import { ClickDzDataController } from './clickdz-data.controller';
import { ClickDzAgentTelegramController } from './clickdz-agent-telegram';
import { ClickDzAgentTriggersController } from './clickdz-agent-triggers';
import { ClickDzHermesController } from './clickdz-hermes.controller';
import { ClickDzIntegrationsController } from './clickdz-integrations.controller';
import { ClickDzOpenclawController } from './clickdz-openclaw.controller';
import { ClickDzPulseController } from './clickdz-pulse.controller';
import { ClickDzAgentsController } from './clickdz-agents.controller';
import { ClickDzReleasesController } from './clickdz-releases.controller';
import { ClickDzAgentRunsController } from './clickdz-agent-runs.controller';
import { ClickDzVdzController } from './clickdz-vdz.controller';
import { ClickDzVdzComposeController } from './clickdz-vdz-compose.controller';
import { ClickDzVdzRenderController } from './clickdz-vdz-render.controller';
import { CopilotController } from './controller';
import { WorkspaceMcpController } from './mcp/controller';
import {
  COPILOT_API_PROVIDERS,
  COPILOT_CONTEXT_REALTIME_PROVIDERS,
  COPILOT_FEATURE_PROVIDERS,
  COPILOT_KERNEL_PROVIDERS,
  COPILOT_TRANSCRIPT_REALTIME_PROVIDERS,
} from './module-providers';

const COPILOT_SHARED_IMPORTS = [
  DocStorageModule,
  FeatureModule,
  QuotaModule,
  PermissionModule,
  ServerConfigModule,
  StorageModule,
  WorkspaceModule,
  IndexerModule,
];

@Module({
  imports: [...COPILOT_SHARED_IMPORTS],
  providers: [...COPILOT_KERNEL_PROVIDERS],
  exports: [...COPILOT_KERNEL_PROVIDERS],
})
export class CopilotKernelModule {}

@Module({
  imports: [PermissionModule],
  providers: [...COPILOT_TRANSCRIPT_REALTIME_PROVIDERS],
})
export class CopilotRealtimeModule {}

@Module({
  imports: [PermissionModule],
  providers: [...COPILOT_CONTEXT_REALTIME_PROVIDERS],
})
export class CopilotEmbeddingRealtimeModule {}

@Module({
  imports: [...COPILOT_SHARED_IMPORTS, CopilotKernelModule],
  providers: [...COPILOT_FEATURE_PROVIDERS],
  exports: [...COPILOT_FEATURE_PROVIDERS],
})
export class CopilotFeatureModule {}

@Module({
  imports: [
    ...COPILOT_SHARED_IMPORTS,
    CopilotKernelModule,
    CopilotFeatureModule,
  ],
  providers: [...COPILOT_API_PROVIDERS],
  exports: [...COPILOT_API_PROVIDERS],
})
export class CopilotApiModule {}

@Module({
  imports: [
    CopilotKernelModule,
    CopilotFeatureModule,
    CopilotApiModule,
    StorageModule,
    PermissionModule,
  ],
  controllers: [
    CopilotController,
    ClickDzBridgeController,
    ClickDzDataController,
    ClickDzAgentTelegramController,
    ClickDzAgentTriggersController,
    ClickDzHermesController,
    ClickDzIntegrationsController,
    ClickDzOpenclawController,
    ClickDzPulseController,
    ClickDzAgentsController,
    ClickDzReleasesController,
    ClickDzAgentRunsController,
    ClickDzVdzController,
    ClickDzVdzComposeController,
    ClickDzVdzRenderController,
    WorkspaceMcpController,
  ],
})
export class CopilotModule {}
