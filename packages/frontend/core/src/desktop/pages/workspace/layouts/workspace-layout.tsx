import { uniReactRoot } from '@affine/component';
import { ClickDzWorkspaceBoot } from '@affine/core/clickdz/workspace-boot';
import {
  identifyCdzPostHogUser,
  initCdzPostHog,
  trackCdzPageView,
} from '@affine/core/clickdz/posthog';
import { useStudioContextObserver } from '@affine/core/modules/platform-context';
import { AiLoginRequiredModal } from '@affine/core/components/affine/auth/ai-login-required';
import { useResponsiveSidebar } from '@affine/core/components/hooks/use-responsive-siedebar';
import { SWRConfigProvider } from '@affine/core/components/providers/swr-config-provider';
import { WorkspaceSideEffects } from '@affine/core/components/providers/workspace-side-effects';
import { AIIsland } from '@affine/core/desktop/components/ai-island';
import { AppContainer } from '@affine/core/desktop/components/app-container';
import { DocumentTitle } from '@affine/core/desktop/components/document-title';
import { WorkspaceDialogs } from '@affine/core/desktop/dialogs';
import { PeekViewManagerModal } from '@affine/core/modules/peek-view';
import { QuotaCheck } from '@affine/core/modules/quota';
import { AuthService } from '@affine/core/modules/cloud/services/auth';
import { WorkbenchService } from '@affine/core/modules/workbench';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { LiveData, useLiveData, useService } from '@toeverything/infra';
import type { PropsWithChildren } from 'react';
import { useEffect } from 'react';

export const WorkspaceLayout = function WorkspaceLayout({
  children,
}: PropsWithChildren) {
  const currentWorkspace = useService(WorkspaceService).workspace;
  return (
    <SWRConfigProvider>
      <WorkspaceDialogs />

      {/* ---- some side-effect components ---- */}
      {currentWorkspace?.flavour !== 'local' ? (
        <QuotaCheck workspaceMeta={currentWorkspace.meta} />
      ) : null}
      <AiLoginRequiredModal />
      <WorkspaceSideEffects />
      <PeekViewManagerModal />
      <DocumentTitle />

      <WorkspaceLayoutInner>{children}</WorkspaceLayoutInner>
      {/* should show after workspace loaded */}
      {/* FIXME: wait for better ai, <WorkspaceAIOnboarding /> */}
      <AIIsland />
      <uniReactRoot.Root />
    </SWRConfigProvider>
  );
};

/**
 * Wraps the workspace layout main router view
 */
const WorkspaceLayoutUIContainer = ({ children }: PropsWithChildren) => {
  const workbench = useService(WorkbenchService).workbench;
  const authSession = useService(AuthService).session;
  const account = useLiveData(authSession.account$);
  const currentPath = useLiveData(
    LiveData.computed(get => {
      return get(workbench.basename$) + get(workbench.location$).pathname;
    })
  );
  useResponsiveSidebar();
  // Keep PlatformContextService.activeStudio in sync with the route (app-wide,
  // once — this layout renders a single time around WorkbenchRoot).
  useStudioContextObserver();

  // PostHog product analytics (ClickDz): identify the signed-in user and emit
  // a $pageview per SPA route change. No-ops unless CDZ_POSTHOG_KEY +
  // CDZ_POSTHOG_HOST were set at build time (see clickdz/posthog.ts).
  useEffect(() => {
    initCdzPostHog().then(posthog => {
      if (!posthog) return;
      identifyCdzPostHogUser(
        account ? { id: account.id, email: account.email } : null
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id, account?.email]);

  useEffect(() => {
    trackCdzPageView(currentPath);
  }, [currentPath]);

  return (
    <AppContainer data-current-path={currentPath}>
      {children}
      <ClickDzWorkspaceBoot />
    </AppContainer>
  );
};
const WorkspaceLayoutInner = ({ children }: PropsWithChildren) => {
  return <WorkspaceLayoutUIContainer>{children}</WorkspaceLayoutUIContainer>;
};
