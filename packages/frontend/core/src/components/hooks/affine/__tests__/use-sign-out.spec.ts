/* eslint-disable rxjs/finnish */
/**
 * @vitest-environment happy-dom
 */
import { ServerFeature } from '@affine/graphql';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// mocks
const signOutFn = vi.fn();
const jumpToIndex = vi.fn();
const jumpToSignIn = vi.fn();
let allowGuestDemo: boolean | undefined = true;

vi.mock('@affine/core/modules/cloud', () => ({
  AuthService: class {},
  DefaultServerService: class {},
}));

vi.mock('@toeverything/infra', () => {
  return {
    useService: () => ({ signOut: signOutFn }),
    useServices: () => ({
      defaultServerService: {
        server: {
          config$: {
            value: {
              get features() {
                return allowGuestDemo !== false
                  ? [ServerFeature.LocalWorkspace]
                  : [];
              },
            },
          },
        },
      },
    }),
  };
});

vi.mock('@affine/component', () => {
  return {
    useConfirmModal: () => ({
      openConfirmModal: ({ onConfirm }: { onConfirm?: () => unknown }) => {
        return Promise.resolve(onConfirm?.());
      },
    }),
    notify: { error: vi.fn() },
  };
});

vi.mock('@affine/i18n', () => ({
  useI18n: () => new Proxy({}, { get: () => () => '' }),
}));

vi.mock('../../use-navigate-helper', () => ({
  useNavigateHelper: () => ({ jumpToIndex, jumpToSignIn }),
}));

import { useSignOut } from '../use-sign-out';

describe('useSignOut', () => {
  beforeEach(() => {
    signOutFn.mockClear();
    jumpToIndex.mockClear();
    jumpToSignIn.mockClear();
  });

  // ClickDz Work: this test suite runs with BUILD_CONFIG for the `web`
  // distribution (BUILD_CONFIG.isElectron === false, see
  // scripts/setup/global.ts), so sign-out must always land on /sign-in,
  // never back on the index route — regardless of what the server reports
  // for the local/demo workspace feature. Electron is not exercised by
  // this suite, but keeps the original (server-flag-driven) behavior.

  test('redirects to sign in on web even when guest demo allowed', async () => {
    allowGuestDemo = true;
    const { result } = renderHook(() => useSignOut());
    result.current();
    await waitFor(() => expect(signOutFn).toHaveBeenCalled());
    expect(jumpToSignIn).toHaveBeenCalled();
    expect(jumpToIndex).not.toHaveBeenCalled();
  });

  test('redirects to sign in on web when guest demo config not provided', async () => {
    allowGuestDemo = undefined;
    const { result } = renderHook(() => useSignOut());
    result.current();
    await waitFor(() => expect(signOutFn).toHaveBeenCalled());
    expect(jumpToSignIn).toHaveBeenCalled();
    expect(jumpToIndex).not.toHaveBeenCalled();
  });

  test('redirects to sign in when guest demo disabled', async () => {
    allowGuestDemo = false;
    const { result } = renderHook(() => useSignOut());
    result.current();
    await waitFor(() => expect(signOutFn).toHaveBeenCalled());
    expect(jumpToSignIn).toHaveBeenCalled();
    expect(jumpToIndex).not.toHaveBeenCalled();
  });
});
