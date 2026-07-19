import { type Framework } from '@toeverything/infra';

import { WorkspaceLocalState, WorkspaceScope } from '../workspace';
import { PlatformNotifyService } from './service';

export { NotifyBell } from './bell';
export {
  type AppNotification,
  type NotifyInput,
  PlatformNotifyService,
} from './service';

/**
 * Register the platform-notifications hub.
 *
 * WorkspaceScope + WorkspaceLocalState (workspace-scoped persistence, exactly
 * like RecentDocsService) so the inbox rides with the active workspace. Call
 * this from `FE/modules/index.ts` alongside the other `configure*Module`s (see
 * NOTES-modules-index.ts.md).
 */
export function configurePlatformNotifyModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(PlatformNotifyService, [WorkspaceLocalState]);
}
