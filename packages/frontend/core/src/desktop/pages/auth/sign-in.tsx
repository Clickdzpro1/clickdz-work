import { notify } from '@affine/component';
import { AffineOtherPageLayout } from '@affine/component/affine-other-page-layout';
import { SignInPageContainer } from '@affine/component/auth-components';
import { SignInPanel } from '@affine/core/components/sign-in';
import { SignInBackgroundArts } from '@affine/core/components/sign-in/background-arts';
import { WebSingleStepSignIn } from '@affine/core/components/sign-in/web-single-step-sign-in';
import { DefaultServerService } from '@affine/core/modules/cloud';
import type { AuthSessionStatus } from '@affine/core/modules/cloud/entities/session';
import { useI18n } from '@affine/i18n';
import { FrameworkScope, useService } from '@toeverything/infra';
import { useCallback, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import {
  RouteLogic,
  useNavigateHelper,
} from '../../../components/hooks/use-navigate-helper';

export const SignIn = ({
  redirectUrl: redirectUrlFromProps,
}: {
  redirectUrl?: string;
}) => {
  const t = useI18n();
  const navigate = useNavigate();
  const { jumpToIndex } = useNavigateHelper();
  const [searchParams] = useSearchParams();
  const redirectUrl = redirectUrlFromProps ?? searchParams.get('redirect_uri');

  // ClickDz Work: the `server` query param lets Electron connect to an
  // arbitrary self-hosted server. Web always talks to the single server at
  // `location.origin`, so this affordance is ignored on web builds.
  const server = BUILD_CONFIG.isElectron
    ? (searchParams.get('server') ?? undefined)
    : undefined;
  const error = searchParams.get('error');

  useEffect(() => {
    if (error) {
      notify.error({
        title: t['com.affine.auth.toast.title.failed'](),
        message: error,
      });
    }
  }, [error, t]);

  const handleClose = useCallback(() => {
    jumpToIndex(RouteLogic.REPLACE, {
      search: searchParams.toString(),
    });
  }, [jumpToIndex, searchParams]);

  const handleAuthenticated = useCallback(
    (status: AuthSessionStatus) => {
      if (status === 'authenticated') {
        if (redirectUrl) {
          if (redirectUrl.toUpperCase() === 'CLOSE_POPUP') {
            window.close();
          }
          navigate(redirectUrl, {
            replace: true,
          });
        } else {
          handleClose();
        }
      }
    },
    [handleClose, navigate, redirectUrl]
  );

  const initStep = server ? 'addSelfhosted' : 'signIn';

  const defaultServerService = useService(DefaultServerService);

  return (
    <SignInPageContainer>
      <div style={{ maxWidth: '400px', width: '100%', zIndex: 1 }}>
        {BUILD_CONFIG.isElectron ? (
          <SignInPanel
            onSkip={handleClose}
            onAuthenticated={handleAuthenticated}
            initStep={initStep}
            server={server}
          />
        ) : (
          // ClickDz Work: web only ever gets the single-step email +
          // password form — no magic-link step, no "skip"/local-workspace
          // affordance. Sign-up is invite-only (see the admin note in the
          // form); there is nothing to "skip" to on web.
          <FrameworkScope scope={defaultServerService.server.scope}>
            <WebSingleStepSignIn
              redirectUrl={redirectUrl ?? undefined}
              onAuthenticated={handleAuthenticated}
            />
          </FrameworkScope>
        )}
      </div>
    </SignInPageContainer>
  );
};

export const Component = () => {
  return (
    <AffineOtherPageLayout>
      <SignInBackgroundArts />
      <SignIn />
    </AffineOtherPageLayout>
  );
};
