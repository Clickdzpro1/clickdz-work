import { LiveData, Service } from '@toeverything/infra';
import { map } from 'rxjs';

import type { WorkspaceLocalState } from '../workspace';
import type { StudioId } from './registry';

const RECENT_STUDIOS_LIMIT = 5;
const RECENT_STUDIOS_KEY = 'clickdz-recent-studios';

const EMPTY_ARRAY: StudioId[] = [];

/**
 * Workspace-scoped LRU of the most recently opened studios. Clones the
 * `RecentDocsService` idiom (WorkspaceLocalState Memento, string-array key,
 * unshift/filter/pop LRU) but exposes a reactive `recents$` so the switcher can
 * render recents on top without polling.
 */
export class RecentStudiosService extends Service {
  constructor(private readonly localState: WorkspaceLocalState) {
    super();
  }

  readonly recents$: LiveData<StudioId[]> = LiveData.from(
    this.localState
      .watch<StudioId[] | null>(RECENT_STUDIOS_KEY)
      .pipe(map(ids => ids ?? EMPTY_ARRAY)),
    this.getRecentStudioIds()
  );

  add(id: StudioId) {
    let recents = this.getRecentStudioIds();
    recents = recents.filter(existing => existing !== id);
    if (recents.length >= RECENT_STUDIOS_LIMIT) {
      recents.pop();
    }
    recents.unshift(id);
    this.localState.set(RECENT_STUDIOS_KEY, recents);
  }

  private getRecentStudioIds(): StudioId[] {
    return (
      this.localState.get<StudioId[] | null>(RECENT_STUDIOS_KEY) || EMPTY_ARRAY
    );
  }
}
