import { DefaultServerService } from '@affine/core/modules/cloud';
import { DesktopApiService } from '@affine/core/modules/desktop-api';
import { WorkspacesService } from '@affine/core/modules/workspace';
import {
  buildShowcaseWorkspace,
  createFirstAppData,
} from '@affine/core/utils/first-app-data';
import { ServerFeature } from '@affine/graphql';
import {
  useLiveData,
  useService,
  useServiceOptional,
} from '@toeverything/infra';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  RouteLogic,
  useNavigateHelper,
} from '../../../components/hooks/use-navigate-helper';
import { WorkspaceNavigator } from '../../../components/workspace-selector';
import { AuthService } from '../../../modules/cloud';
import { AppContainer } from '../../components/app-container';

/**
 * index page
 *
 * query string:
 * - initCloud: boolean, if true, when user is logged in, create a cloud workspace
 */
export const Component = ({
  // ClickDz Work opens on the AI chat entry, not the AFFiNE doc list and not
  // the ERP. Landing on 'all' meant every session opened on an empty documents
  // page; landing on 'shoperp' pushed every merchant — including ones who never
  // intend to run a store — straight into the ERP, and dropped freshly
  // onboarded users into shop setup as their very first screen. '/chat' is the
  // one surface that makes sense cold: ask for something and the workspace
  // routes you from there. The mobile index still passes its own 'home'.
  defaultIndexRoute = 'chat',
  children,
  fallback,
  createErrorFallback,
}: {
  defaultIndexRoute?: string;
  children?: ReactNode;
  fallback?: ReactNode;
  createErrorFallback?: (retry: () => void) => ReactNode;
}) => {
  // navigating and creating may be slow, to avoid flickering, we show workspace fallback
  const [navigating, setNavigating] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const [createAttempt, setCreateAttempt] = useState(0);
  const authService = useService(AuthService);
  const defaultServerService = useService(DefaultServerService);

  const loggedIn = useLiveData(
    authService.session.status$.map(s => s === 'authenticated')
  );
  const serverReportedLocalWorkspace =
    useLiveData(
      defaultServerService.server.config$.selector(
        c =>
          c.features.includes(ServerFeature.LocalWorkspace) ||
          BUILD_CONFIG.isNative
      )
    ) ?? true;
  // ClickDz Work: the local/demo workspace (and any "skip sign-in" affordance)
  // must never be reachable on web builds, regardless of what the server
  // reports via ServerFeature.LocalWorkspace. Electron keeps the original
  // behavior so the desktop app can still work fully offline.
  const enableLocalWorkspace =
    BUILD_CONFIG.isElectron && serverReportedLocalWorkspace;

  const workspacesService = useService(WorkspacesService);
  const list = useLiveData(workspacesService.list.workspaces$);
  const listIsLoading = useLiveData(workspacesService.list.isRevalidating$);

  const { openPage, jumpToPage, jumpToSignIn } = useNavigateHelper();
  const [searchParams] = useSearchParams();

  const createOnceRef = useRef(false);

  const createCloudWorkspace = useCallback(() => {
    if (createOnceRef.current) return;
    createOnceRef.current = true;
    // TODO: support selfhosted
    // ClickDz Work: named for the merchant ("Ma Boutique", not "AFFiNE Cloud")
    // and seeded EMPTY — see buildShowcaseWorkspace's seedShowcase param for
    // why the English tutorial docs are not imported for cloud workspaces.
    buildShowcaseWorkspace(
      workspacesService,
      'affine-cloud',
      'Ma Boutique',
      false
    )
      .then(({ meta, defaultDocId }) => {
        if (defaultDocId) {
          jumpToPage(meta.id, defaultDocId);
        } else {
          openPage(meta.id, defaultIndexRoute);
        }
      })
      .catch(err => {
        console.error('Failed to create cloud workspace', err);
        // Recover rather than stranding the user. This path now runs
        // automatically for every signed-in account with no workspace, so a
        // transient failure (500, quota, offline right after signup, expired
        // session) must not leave them staring at the loading skeleton
        // forever. Release the latch so a retry is possible, and stop
        // "navigating" so the WorkspaceNavigator fallback renders and they
        // have a working manual create button — exactly what they used to get.
        createOnceRef.current = false;
        setNavigating(false);
      });
  }, [defaultIndexRoute, jumpToPage, openPage, workspacesService]);

  useLayoutEffect(() => {
    if (!navigating) {
      return;
    }

    if (listIsLoading) {
      return;
    }

    if (!enableLocalWorkspace && !loggedIn) {
      localStorage.removeItem('last_workspace_id');
      jumpToSignIn();
      return;
    }

    // ClickDz Work: first-run onboarding wizard (collect info + pick templates)
    // runs once before the app. The wizard sets the flag then returns to '/'.
    try {
      if (!localStorage.getItem('clickdz:onboarded:v1')) {
        window.location.replace('/welcome');
        return;
      }
    } catch {
      /* storage unavailable — skip onboarding */
    }

    // check is user logged in && has cloud workspace
    if (searchParams.get('initCloud') === 'true') {
      if (loggedIn) {
        if (list.every(w => w.flavour !== 'affine-cloud')) {
          createCloudWorkspace();
          return;
        }

        // open first cloud workspace
        const openWorkspace =
          list.find(w => w.flavour === 'affine-cloud') ?? list[0];
        openPage(openWorkspace.id, defaultIndexRoute);
      } else {
        return;
      }
    } else {
      if (list.length === 0) {
        // upstream 0.27.3: on mobile editions with local workspaces enabled the
        // local-workspace effect further down creates the first workspace, so
        // bail out here rather than racing it. Mutually exclusive with the
        // ClickDz branch below (that one requires !enableLocalWorkspace).
        if (BUILD_CONFIG.isMobileEdition && enableLocalWorkspace) {
          return;
        }
        // ClickDz Work: a signed-in merchant with no workspace must never be
        // dropped on the bare WorkspaceNavigator fallback below. That screen
        // asks a non-technical shop owner to understand the word "workspace"
        // and name one in an English dialog before they can reach anything —
        // it was a full-funnel dead end for every new account. Create their
        // cloud workspace silently and land them on `defaultIndexRoute`.
        //
        // `!enableLocalWorkspace` keeps this to WEB. On Electron that flag is
        // on and the local-workspace effect below already creates a "Demo
        // Workspace" for this same state; running both would create two
        // workspaces and race two navigations against each other. Desktop
        // keeps its existing behaviour untouched.
        if (loggedIn && !enableLocalWorkspace) {
          createCloudWorkspace();
          return;
        }
        setNavigating(false);
        return;
      }
      // open last workspace
      const lastId = localStorage.getItem('last_workspace_id');

      const openWorkspace = list.find(w => w.id === lastId) ?? list[0];
      openPage(openWorkspace.id, defaultIndexRoute, RouteLogic.REPLACE);
    }
  }, [
    enableLocalWorkspace,
    createCloudWorkspace,
    list,
    openPage,
    searchParams,
    jumpToSignIn,
    listIsLoading,
    loggedIn,
    navigating,
    defaultIndexRoute,
  ]);

  const desktopApi = useServiceOptional(DesktopApiService);

  useEffect(() => {
    desktopApi?.handler.ui.pingAppLayoutReady().catch(console.error);
  }, [desktopApi]);

  useEffect(() => {
    // ClickDz Work: this creates the local "Demo Workspace" when no
    // workspace exists yet. `enableLocalWorkspace` is already forced to
    // false on web (see above), so this can never run there — only
    // Electron (BUILD_CONFIG.isElectron) can hit this path.
    if (listIsLoading || list.length > 0 || !enableLocalWorkspace) {
      return;
    }

    const creation = createFirstAppData(workspacesService);
    if (!creation) return;

    setCreateError(false);
    setCreating(true);
    creation
      .then(createdWorkspace => {
        if (createdWorkspace) {
          if (createdWorkspace.defaultPageId) {
            jumpToPage(
              createdWorkspace.meta.id,
              createdWorkspace.defaultPageId
            );
          } else {
            openPage(createdWorkspace.meta.id, 'all');
          }
        }
      })
      .catch(err => {
        console.error('Failed to create first app data', err);
        setCreateError(true);
      })
      .finally(() => {
        setCreating(false);
      });
  }, [
    jumpToPage,
    openPage,
    workspacesService,
    listIsLoading,
    list,
    enableLocalWorkspace,
    createAttempt,
  ]);

  const retryCreate = useCallback(() => {
    setCreateAttempt(attempt => attempt + 1);
  }, []);

  if (createError && createErrorFallback) {
    return createErrorFallback(retryCreate);
  }

  if (navigating || creating) {
    return fallback ?? <AppContainer fallback />;
  }

  // TODO(@eyhn): We need a no workspace page
  return (
    children ?? (
      <div
        style={{
          position: 'fixed',
          left: 'calc(50% - 150px)',
          top: '50%',
        }}
      >
        <WorkspaceNavigator
          open={true}
          menuContentOptions={{
            forceMount: true,
          }}
        />
      </div>
    )
  );
};
