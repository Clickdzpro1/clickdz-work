import { toggleGeneralAIOnboarding } from '@affine/core/components/affine/ai-onboarding/apis';
import type {
  AuthAccountInfo,
  AuthService,
  ServerService,
} from '@affine/core/modules/cloud';
import type { GlobalDialogService } from '@affine/core/modules/dialogs';

import type { AIRequestService } from '../runtime/request';
import { setAIRequestService } from '../runtime/request';
import { AIAppEvents } from './ai-app-events';
import { AIProvider, cdzApiUrl } from './ai-provider';
import { setupTracker } from './tracker';

function toAIUserInfo(account: AuthAccountInfo | null) {
  if (!account) return null;
  return {
    avatarUrl: account.avatar ?? '',
    email: account.email ?? '',
    id: account.id,
    name: account.label,
  };
}

export function setupAIProvider(
  requestService: AIRequestService,
  globalDialogService: GlobalDialogService,
  authService: AuthService,
  serverService: ServerService
) {
  setAIRequestService(requestService);

  // Expose the connected server's base URL so ClickDz bridge calls (image
  // generation, app builder) can be made absolute on desktop, where the
  // renderer origin (assets://.) is not the cloud server. No-op on web.
  AIProvider.provide('serverBaseUrl', () => serverService.server.baseUrl);

  AIProvider.provide('userInfo', () => {
    return toAIUserInfo(authService.session.account$.value);
  });

  const accountSubscription = authService.session.account$.subscribe(
    account => {
      AIAppEvents.userInfo.next(toAIUserInfo(account));
    }
  );

  AIProvider.provide('photoEngine', {
    async searchImages(options): Promise<string[]> {
      let url = '/api/copilot/unsplash/photos';
      if (options.query) {
        url += `?query=${encodeURIComponent(options.query)}`;
      }
      const result: {
        results?: {
          urls: {
            regular: string;
          };
        }[];
      } = await fetch(cdzApiUrl(url)).then((res: Response) => res.json());
      if (!result.results) return [];
      return result.results.map(r => {
        const url = new URL(r.urls.regular);
        url.searchParams.set('fit', 'crop');
        url.searchParams.set('crop', 'edges');
        url.searchParams.set('dpr', (window.devicePixelRatio ?? 2).toString());
        url.searchParams.set('w', `${options.width}`);
        url.searchParams.set('h', `${options.height}`);
        return url.toString();
      });
    },
  });

  AIProvider.provide('onboarding', toggleGeneralAIOnboarding);

  const disposeRequestLoginHandler = AIAppEvents.requestLogin.subscribe(() => {
    globalDialogService.open('sign-in', {});
  });

  const trackerDisposer = setupTracker(requestService);

  return () => {
    setAIRequestService(null);
    trackerDisposer();
    disposeRequestLoginHandler.unsubscribe();
    accountSubscription.unsubscribe();
  };
}
