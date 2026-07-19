import { type Framework } from '@toeverything/infra';

import { WorkspaceLocalState, WorkspaceScope } from '../workspace';
import { RecentStudiosService } from './recent-studios';

export type { StudioDef, StudioGroup, StudioId } from './registry';
export { STUDIOS, studioForPath } from './registry';
export { RecentStudiosService } from './recent-studios';

export function configureStudioModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(RecentStudiosService, [WorkspaceLocalState]);
}
