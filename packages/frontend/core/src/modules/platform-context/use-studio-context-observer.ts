import { useService } from '@toeverything/infra';
import { useEffect } from 'react';

import { studioForPath } from '../studio/registry';
import { WorkbenchService } from '../workbench';
import { PlatformContextService } from './service';

/**
 * App-level route observer: watches the workbench location and keeps
 * `PlatformContextService.context$.activeStudioId` in sync with the current
 * studio (resolved via the registry's `studioForPath`). Mount this exactly
 * ONCE in an app-global component that has `WorkbenchService` in scope (see the
 * NOTES for the workspace root layout) so the whole app gets automatic
 * active-studio tracking with zero per-studio edits.
 *
 * `location$` is a `LiveData`, so it emits its current value on subscribe —
 * activeStudio is correct immediately on mount, not just on the next
 * navigation. `setStudio` is a no-op when the studio hasn't changed, so this
 * stays cheap across intra-studio navigation.
 */
export function useStudioContextObserver(): void {
  const workbench = useService(WorkbenchService).workbench;
  const platformContext = useService(PlatformContextService);

  useEffect(() => {
    const subscription = workbench.location$.subscribe(location => {
      const studio = studioForPath(location.pathname);
      platformContext.setStudio(studio?.id ?? null);
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [platformContext, workbench]);
}
