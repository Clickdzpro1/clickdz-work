import { LiveData, Service } from '@toeverything/infra';

import type { StudioId } from '../studio/registry';

/**
 * The platform-wide "what is the user looking at right now" envelope. This is
 * the substrate the future cross-studio copilot reads to know which studio
 * (and, later, which record/thread) is active without every studio wiring in
 * a bespoke context feed.
 *
 * - `activeStudioId` is published automatically by the app-level route
 *   observer (see `useStudioContextObserver`), so it is always in sync with the
 *   current workbench location with zero per-studio edits.
 * - `activeRecord` / `activeThreadId` are reserved for individual studios to
 *   publish later via `setRecord` / `setThread`. Wiring those emit sites is out
 *   of scope this round — the setters exist so studios can adopt them without a
 *   service change.
 */
export interface ActiveContext {
  activeStudioId: StudioId | null;
  activeRecord?: { kind: string; id: string; label?: string } | null;
  activeThreadId?: string | null;
}

const INITIAL_CONTEXT: ActiveContext = {
  activeStudioId: null,
  activeRecord: null,
  activeThreadId: null,
};

/**
 * Frontend, in-memory context broker. All studios live in one app/window, so a
 * single `LiveData` gives instant same-window pub/sub with zero latency and no
 * backend (per RECON A4 — Option F). If cross-device sync ever becomes a hard
 * requirement, a future SSE feed can push into `context$` without changing this
 * public surface.
 */
export class PlatformContextService extends Service {
  readonly context$ = new LiveData<ActiveContext>(INITIAL_CONTEXT);

  setStudio(id: StudioId | null) {
    const current = this.context$.value;
    if (current.activeStudioId === id) {
      return;
    }
    this.context$.next({ ...current, activeStudioId: id });
  }

  setRecord(r: ActiveContext['activeRecord']) {
    this.context$.next({ ...this.context$.value, activeRecord: r ?? null });
  }

  setThread(id: string | null) {
    this.context$.next({ ...this.context$.value, activeThreadId: id });
  }
}
