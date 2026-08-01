import { sentry, tracker } from '@affine/track';
import { APP_SETTINGS_STORAGE_KEY } from '@toeverything/infra/atom';

import { initCdzPostHog, trackCdzEvent } from '../clickdz/posthog';

tracker.init();
sentry.init();

// PostHog product analytics (ClickDz): lazy-loads posthog-js and is a no-op
// unless CDZ_POSTHOG_KEY + CDZ_POSTHOG_HOST are set at build time. Fires the
// `app_opened` key action once per app boot; pageviews and user identity are
// wired via trackCdzPageView / identifyCdzPostHogUser (see clickdz/posthog.ts
// and components/workspace/index.tsx).
initCdzPostHog().then(posthog => {
  if (posthog) {
    trackCdzEvent('app_opened', { surface: 'web' });
  }
});

if (typeof localStorage !== 'undefined') {
  let enabled = true;
  const settingsStr = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);

  if (settingsStr) {
    const parsed = JSON.parse(settingsStr);
    enabled = parsed.enableTelemetry;
  }

  if (!enabled) {
    // NOTE: telemetry setting is respected by tracker and sentry.
    sentry.disable();
    tracker.opt_out_tracking();
  }
}
