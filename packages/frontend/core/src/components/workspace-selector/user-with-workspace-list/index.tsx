import { ScrollableContainer } from '@affine/component';
import { MenuItem } from '@affine/component/ui/menu';
import { AuthService, DefaultServerService } from '@affine/core/modules/cloud';
import { GlobalDialogService } from '@affine/core/modules/dialogs';
import { type WorkspaceMetadata } from '@affine/core/modules/workspace';
import { ServerFeature } from '@affine/graphql';
import { useI18n } from '@affine/i18n';
import { track } from '@affine/track';
const ClickDzLogo = ({ size = 20 }: { size?: number }) => (
  <img src="/imgs/app-icon-stable.png" width={size} height={size} alt="ClickDz Work" style={{ borderRadius: '4px' }} />
);
import { useLiveData, useService } from '@toeverything/infra';
import { useCallback } from 'react';

import { AddWorkspace } from './add-workspace';
import * as styles from './index.css';
import { AFFiNEWorkspaceList } from './workspace-list';

export const SignInItem = () => {
  const globalDialogService = useService(GlobalDialogService);

  const t = useI18n();

  const onClickSignIn = useCallback(() => {
    track.$.navigationPanel.workspaceList.requestSignIn();
    globalDialogService.open('sign-in', {});
  }, [globalDialogService]);

  return (
    <MenuItem
      className={styles.menuItem}
      onClick={onClickSignIn}
      data-testid="cloud-signin-button"
    >
      <div className={styles.signInWrapper}>
        <div className={styles.iconContainer}>
          <ClickDzLogo />
        </div>

        <div className={styles.signInTextContainer}>
          <div className={styles.signInTextPrimary}>
            {t['com.affine.workspace.cloud.auth']()}
          </div>
          <div className={styles.signInTextSecondary}>
            {t['com.affine.workspace.cloud.description']()}
          </div>
        </div>
      </div>
    </MenuItem>
  );
};

interface UserWithWorkspaceListProps {
  onEventEnd?: () => void;
  onClickWorkspace?: (workspace: WorkspaceMetadata) => void;
  onCreatedWorkspace?: (payload: {
    metadata: WorkspaceMetadata;
    defaultDocId?: string;
  }) => void;
  showEnableCloudButton?: boolean;
}

export const UserWithWorkspaceList = ({
  onEventEnd,
  onClickWorkspace,
  onCreatedWorkspace,
  showEnableCloudButton,
}: UserWithWorkspaceListProps) => {
  const globalDialogService = useService(GlobalDialogService);
  const session = useLiveData(useService(AuthService).session.session$);
  const defaultServerService = useService(DefaultServerService);

  const isAuthenticated = session.status === 'authenticated';

  const openSignInModal = useCallback(() => {
    globalDialogService.open('sign-in', {});
  }, [globalDialogService]);

  const onNewWorkspace = useCallback(() => {
    // ClickDz Work: never allow anonymous local-workspace creation on web,
    // regardless of server-reported feature flags. Electron is unaffected.
    const enableLocalWorkspace =
      BUILD_CONFIG.isElectron &&
      (BUILD_CONFIG.isNative ||
        defaultServerService.server.config$.value.features.includes(
          ServerFeature.LocalWorkspace
        ));
    if (!isAuthenticated && !enableLocalWorkspace) {
      return openSignInModal();
    }
    track.$.navigationPanel.workspaceList.createWorkspace();
    globalDialogService.open('create-workspace', {}, payload => {
      if (payload) {
        onCreatedWorkspace?.(payload);
      }
    });
    onEventEnd?.();
  }, [
    globalDialogService,
    defaultServerService,
    isAuthenticated,
    onCreatedWorkspace,
    onEventEnd,
    openSignInModal,
  ]);

  const onAddWorkspace = useCallback(() => {
    track.$.navigationPanel.workspaceList.createWorkspace({
      control: 'import',
    });
    globalDialogService.open('import-workspace', undefined, payload => {
      if (payload) {
        onCreatedWorkspace?.({ metadata: payload.workspace });
      }
    });
    onEventEnd?.();
  }, [globalDialogService, onCreatedWorkspace, onEventEnd]);

  return (
    <>
      <ScrollableContainer
        className={styles.workspaceScrollArea}
        viewPortClassName={styles.workspaceScrollAreaViewport}
        scrollBarClassName={styles.scrollbar}
        scrollThumbClassName={styles.scrollbarThumb}
      >
        <AFFiNEWorkspaceList
          onEventEnd={onEventEnd}
          onClickWorkspace={onClickWorkspace}
          showEnableCloudButton={showEnableCloudButton}
        />
      </ScrollableContainer>
      <div className={styles.workspaceFooter}>
        <AddWorkspace
          onAddWorkspace={onAddWorkspace}
          onNewWorkspace={onNewWorkspace}
        />
      </div>
    </>
  );
};
