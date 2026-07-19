import { useLiveData, useService } from '@toeverything/infra';

import type { ActiveContext } from './service';
import { PlatformContextService } from './service';

/**
 * Read the current platform context (active studio, and — later — active
 * record/thread). Reactive: re-renders when the route observer or a studio
 * publishes a new envelope.
 */
export function useActiveContext(): ActiveContext {
  const service = useService(PlatformContextService);
  return useLiveData(service.context$);
}
