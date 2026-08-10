import { LiveData, OnEvent, Service } from '@toeverything/infra';

import { resolveLinkToDoc } from '../../navigation';
import type { GlobalSessionState, GlobalState } from '../../storage';
import { WorkbenchLocationChanged } from '../../workbench/services/workbench';
import type { WorkspacesService } from '../../workspace';
import { getLocalWorkspaceIds } from '../../workspace-engine/impls/local';

const storageKey = 'open-link-mode';
// Session-only suppression for a plain Dismiss (no "remember" checkbox):
// the banner should not come back for the rest of the browser session
// (survives in-app navigation AND reloads of the same tab), but should not
// leak into a brand-new tab/window the way the persisted localStorage
// choice does. sessionStorage is the right primitive for that.
const sessionDismissedKey = 'open-in-app-banner-dismissed';

export enum OpenLinkMode {
  ALWAYS_ASK = 'always-ask', // default
  OPEN_IN_WEB = 'open-in-web',
  OPEN_IN_DESKTOP_APP = 'open-in-desktop-app',
}

@OnEvent(WorkbenchLocationChanged, e => e.onNavigation)
export class OpenInAppService extends Service {
  private initialized = false;

  private initialUrl: string | undefined;

  readonly showOpenInAppBanner$ = new LiveData<boolean>(false);
  readonly showOpenInAppPage$ = new LiveData<boolean | undefined>(undefined);

  constructor(
    public readonly globalState: GlobalState,
    public readonly workspacesService: WorkspacesService,
    public readonly globalSessionState: GlobalSessionState
  ) {
    super();
  }

  onNavigation() {
    // check doc id instead?
    if (window.location.href === this.initialUrl) {
      return;
    }
    this.showOpenInAppBanner$.next(false);
  }

  /**
   * Given the initial URL, check if we need to redirect to the desktop app.
   */
  bootstrap() {
    if (this.initialized || !window) {
      return;
    }

    this.initialized = true;
    this.initialUrl = window.location.href;

    const maybeDocLink = resolveLinkToDoc(this.initialUrl);
    let shouldOpenInApp = false;

    const localWorkspaceIds = getLocalWorkspaceIds();

    if (
      maybeDocLink &&
      !localWorkspaceIds.includes(maybeDocLink.workspaceId) &&
      !this.globalSessionState.get<boolean>(sessionDismissedKey)
    ) {
      switch (this.getOpenLinkMode()) {
        case OpenLinkMode.OPEN_IN_DESKTOP_APP:
          shouldOpenInApp = true;
          break;
        case OpenLinkMode.ALWAYS_ASK:
          this.showOpenInAppBanner$.next(true);
          break;
        default:
          break;
      }
    }
    this.showOpenInAppPage$.next(shouldOpenInApp);
  }

  showOpenInAppPage() {
    this.showOpenInAppPage$.next(true);
  }

  hideOpenInAppPage() {
    this.showOpenInAppPage$.next(false);
  }

  getOpenLinkMode() {
    return (
      this.globalState.get<OpenLinkMode>(storageKey) ?? OpenLinkMode.ALWAYS_ASK
    );
  }

  openLinkMode$ = LiveData.from(
    this.globalState.watch<OpenLinkMode>(storageKey),
    this.getOpenLinkMode()
  ).map(v => v ?? OpenLinkMode.ALWAYS_ASK);

  setOpenLinkMode(mode: OpenLinkMode) {
    this.globalState.set(storageKey, mode);
  }

  dismissBanner(rememberMode: OpenLinkMode | undefined) {
    if (rememberMode) {
      // "Remember choice" — persisted across tabs/reloads/new browser
      // sessions on this device.
      this.globalState.set(storageKey, rememberMode);
    } else {
      // Plain dismiss — do not ask again for the rest of THIS browser
      // session (same tab, including reloads), but do not persist forever.
      this.globalSessionState.set(sessionDismissedKey, true);
    }
    this.showOpenInAppBanner$.next(false);
  }
}
