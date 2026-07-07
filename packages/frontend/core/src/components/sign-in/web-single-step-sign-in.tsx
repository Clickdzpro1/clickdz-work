import { Button, notify } from '@affine/component';
import {
  AuthContainer,
  AuthContent,
  AuthHeader,
  AuthInput,
} from '@affine/component/auth-components';
import { OAuth } from '@affine/core/components/affine/auth/oauth';
import { useAsyncCallback } from '@affine/core/components/hooks/affine-async-hooks';
import { useSelfhostLoginVersionGuard } from '@affine/core/components/hooks/affine/use-selfhost-login-version-guard';
import {
  AuthService,
  CaptchaService,
  getSelfHostedServerName,
  ServerService,
} from '@affine/core/modules/cloud';
import type { AuthSessionStatus } from '@affine/core/modules/cloud/entities/session';
import { UserFriendlyError } from '@affine/error';
import { ServerDeploymentType } from '@affine/graphql';
import { useI18n } from '@affine/i18n';
import { useLiveData, useService } from '@toeverything/infra';
import { useEffect, useState } from 'react';

import { Captcha } from './captcha';
import * as style from './style.css';

// ClickDz Work: admin contact shown to anyone who fails to sign in — the
// server does not allow public sign-up, only administrator-provisioned
// accounts.
const ADMIN_CONTACT_EMAIL = 'admin@clickdz.ai';
const WRONG_CREDENTIALS_MESSAGE = 'Wrong email or password.';
const INVITE_ONLY_NOTE = `ClickDz Work is invite-only — ask your administrator for an account: ${ADMIN_CONTACT_EMAIL}`;

const emailRegex =
  /^(?:(?:[^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@(?:(?:\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|((?:[a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

function validateEmail(email: string) {
  return emailRegex.test(email);
}

/**
 * ClickDz Work: single-step email + password sign-in used on WEB builds
 * only (see desktop/pages/auth/sign-in.tsx). Unlike the shared
 * `SignInPanel` state machine (components/sign-in/index.tsx), this never
 * offers a magic-link / email-code step — the server is invite-only and
 * every account already has a password set by the administrator.
 *
 * This intentionally does not reuse `SignInStep` / `SignInWithPasswordStep`
 * so those files (and the Electron/mobile flows that still depend on them)
 * are left completely untouched.
 */
export const WebSingleStepSignIn = ({
  redirectUrl,
  onAuthenticated,
}: {
  redirectUrl?: string;
  onAuthenticated?: (status: AuthSessionStatus) => void;
}) => {
  const t = useI18n();
  const serverService = useService(ServerService);
  const authService = useService(AuthService);
  const captchaService = useService(CaptchaService);

  const versionError = useSelfhostLoginVersionGuard(serverService.server);
  const isSelfhosted = useLiveData(
    serverService.server.config$.selector(
      c => c.type === ServerDeploymentType.Selfhosted
    )
  );
  const serverName = useLiveData(
    serverService.server.config$.selector(c => c.serverName)
  );
  const signInServerName = isSelfhosted
    ? getSelfHostedServerName(serverName)
    : serverName;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isValidEmail, setIsValidEmail] = useState(true);
  const [passwordError, setPasswordError] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const verifyToken = useLiveData(captchaService.verifyToken$);
  const needCaptcha = useLiveData(captchaService.needCaptcha$);
  const challenge = useLiveData(captchaService.challenge$);

  const loginStatus = useLiveData(authService.session.status$);

  useEffect(() => {
    if (loginStatus === 'authenticated') {
      notify.success({
        title: t['com.affine.auth.toast.title.signed-in'](),
        message: t['com.affine.auth.toast.message.signed-in'](),
      });
    }
    onAuthenticated?.(loginStatus);
  }, [loginStatus, onAuthenticated, t]);

  const onSignIn = useAsyncCallback(async () => {
    if (isLoading || (!verifyToken && needCaptcha)) return;

    if (!validateEmail(email)) {
      setIsValidEmail(false);
      return;
    }
    setIsValidEmail(true);
    setPasswordError(false);

    setIsLoading(true);
    try {
      // ClickDz Work: this is the exact same password sign-in call used by
      // the shared SignInWithPasswordStep, preserving session handling.
      await authService.signInPassword({
        email,
        password,
        verifyToken,
        challenge,
      });
    } catch (err) {
      console.error(err);
      const error = UserFriendlyError.fromAny(err);

      if (
        error.is('WRONG_SIGN_IN_CREDENTIALS') ||
        error.is('PASSWORD_REQUIRED')
      ) {
        setPasswordError(true);
      } else {
        setPasswordError(false);
        notify.error({
          title: t['com.affine.auth.toast.title.failed'](),
          message: error.is('REQUEST_ABORTED')
            ? t['error.NETWORK_ERROR']()
            : t[`error.${error.name}`](error.data),
        });
      }
      captchaService.revalidate();
    } finally {
      setIsLoading(false);
    }
  }, [
    isLoading,
    verifyToken,
    needCaptcha,
    email,
    password,
    challenge,
    authService,
    captchaService,
    t,
  ]);

  if (versionError && isSelfhosted) {
    return (
      <AuthContainer>
        <AuthHeader
          title={t['com.affine.auth.sign.in']()}
          subTitle={signInServerName}
        />
        <AuthContent>
          <div>{versionError}</div>
        </AuthContent>
      </AuthContainer>
    );
  }

  return (
    <AuthContainer>
      <AuthHeader
        title={t['com.affine.auth.sign.in']()}
        subTitle={signInServerName}
      />

      <AuthContent>
        <OAuth redirectUrl={redirectUrl} />

        <form
          onSubmit={event => {
            event.preventDefault();
            onSignIn();
          }}
        >
          <AuthInput
            className={style.authInput}
            label={t['com.affine.settings.email']()}
            placeholder={t['com.affine.auth.sign.email.placeholder']()}
            value={email}
            onChange={value => {
              setEmail(value);
              if (!isValidEmail) setIsValidEmail(true);
              if (passwordError) setPasswordError(false);
            }}
            error={!isValidEmail}
            errorHint={
              isValidEmail ? '' : t['com.affine.auth.sign.email.error']()
            }
            type="email"
            name="username"
            autoComplete="username"
          />

          <AuthInput
            data-testid="password-input"
            label={t['com.affine.auth.password']()}
            placeholder={t['com.affine.auth.password']()}
            value={password}
            onChange={value => {
              setPassword(value);
              if (passwordError) setPasswordError(false);
            }}
            error={passwordError}
            errorHint={passwordError ? WRONG_CREDENTIALS_MESSAGE : ''}
            onEnter={onSignIn}
            type="password"
            name="password"
            autoComplete="current-password"
          />

          {!verifyToken && needCaptcha && <Captcha />}

          <Button
            className={style.signInButton}
            style={{ width: '100%' }}
            size="extraLarge"
            data-testid="sign-in-button"
            block
            variant="primary"
            loading={isLoading}
            disabled={isLoading || (!verifyToken && needCaptcha)}
          >
            {t['com.affine.auth.sign.in']()}
          </Button>
        </form>

        <div className={style.authMessage} style={{ marginTop: 16 }}>
          {INVITE_ONLY_NOTE}
        </div>
      </AuthContent>
    </AuthContainer>
  );
};
