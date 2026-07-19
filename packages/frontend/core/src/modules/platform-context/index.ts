import type { Framework } from '@toeverything/infra';

import { WorkspaceScope } from '../workspace';
import { PlatformContextService } from './service';

export type { ActiveContext } from './service';
export { PlatformContextService } from './service';
export { useActiveContext } from './use-active-context';
export { useStudioContextObserver } from './use-studio-context-observer';

export function configurePlatformContextModule(framework: Framework) {
  framework.scope(WorkspaceScope).service(PlatformContextService);
}
