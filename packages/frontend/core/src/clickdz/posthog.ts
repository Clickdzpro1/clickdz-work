// ClickDz Work — PostHog product analytics (FRONTEND).
//
// Lazy-loads `posthog-js` (dynamic import — nothing is added to the main
// bundle) and wires user identification + pageviews + ClickDz key actions.
// The whole module is a NO-OP when either env var is unset:
//
//   CDZ_POSTHOG_KEY  — PostHog PROJECT api key (starts with `phc_…`)
//   CDZ_POSTHOG_HOST — capture host, e.g. https://eu.i.posthog.com
//                      (EU Cloud) or https://us.i.posthog.com / self-hosted
//
// NOTE: `process.env.CDZ_*` is baked at BUILD time (webpack DefinePlugin),
// so these must be present when the web/mobile bundle is built — setting
// them on the server at runtime does nothing. Mirror the value you set in
// the backend (which reads process.env at runtime) for full-stack coverage.
//
// `posthog-js` is NOT yet a package.json dependency; the dynamic import below
// is inside try/catch so the build and runtime both survive its absence. To
// activate: `yarn workspace @affine/core add posthog-js` and set the env vars.

export type CdzPostHogUser = { id: string; email?: string | null };

export type CdzPostHogEvent =
  | 'app_opened'
  | 'deck_generated'
  | 'image_generated';

type PostHogLike = {
  capture: (event: string, properties?: Record<string, unknown>) => void;
  identify: (distinctId: string, properties?: Record<string, unknown>) => void;
  reset: () => void;
};

let client: PostHogLike | null = null;
let initStarted = false;
let enabled = false;

function envValue(name: 'CDZ_POSTHOG_KEY' | 'CDZ_POSTHOG_HOST'): string {
  try {
    if (typeof process !== 'undefined' && process.env) {
      const value = process.env[name];
      return typeof value === 'string' ? value.trim() : '';
    }
  } catch {
    /* process unavailable in some runtimes — treated as unset */
  }
  return '';
}

/**
 * Whether PostHog capture is configured. Checked on every call so tests and
 * hot-reloaded builds behave sanely.
 */
export function isCdzPostHogEnabled(): boolean {
  return Boolean(envValue('CDZ_POSTHOG_KEY') && envValue('CDZ_POSTHOG_HOST'));
}

/**
 * Lazy-load posthog-js and init the singleton. Safe to call multiple times;
 * resolves to `null` (no-op) when env vars are unset or the dep is missing.
 */
export async function initCdzPostHog(): Promise<PostHogLike | null> {
  if (client || initStarted) {
    return client;
  }
  initStarted = true;

  const key = envValue('CDZ_POSTHOG_KEY');
  const host = envValue('CDZ_POSTHOG_HOST');
  if (!key || !host) {
    return null;
  }

  try {
    // Dynamic import: posthog-js is an optional dependency — the app builds
    // and runs fine without it; capture simply stays a no-op until the dep
    // is added (`yarn workspace @affine/core add posthog-js`).
    const mod = (await import('posthog-js')) as {
      default?: {
        init: (
          k: string,
          o: Record<string, unknown>
        ) => PostHogLike;
      };
      init?: (k: string, o: Record<string, unknown>) => PostHogLike;
    };
    const posthog = (mod.default ?? mod) as {
      init: (k: string, o: Record<string, unknown>) => PostHogLike;
    };
    client = posthog.init(key, {
      api_host: host.replace(/\/+$/, ''),
      autocapture: false, // explicit events only — keep the event stream clean
      capture_pageview: false, // we emit $pageview manually via trackCdzPageView
      capture_pageleave: true,
      persistence: 'localStorage+cookie',
      disable_session_recording: true,
    }) as PostHogLike;
    enabled = true;
    return client;
  } catch {
    // posthog-js not installed (or failed to load) — stay a no-op.
    client = null;
    enabled = false;
    return null;
  }
}

/**
 * Identify the signed-in user (distinct id + email person property).
 * Call once after login / session restore. Pass `null` on logout to reset.
 */
export function identifyCdzPostHogUser(user: CdzPostHogUser | null): void {
  if (!client || !enabled) {
    return;
  }
  try {
    if (user && user.id) {
      client.identify(user.id, user.email ? { email: user.email } : {});
    } else {
      client.reset();
    }
  } catch {
    /* analytics must never break the app */
  }
}

/** Track a SPA pageview. `$current_url` is included automatically. */
export function trackCdzPageView(path?: string): void {
  if (!client || !enabled) {
    return;
  }
  try {
    client.capture('$pageview', path ? { $current_url_override: path } : {});
  } catch {
    /* no-op */
  }
}

/**
 * Track a ClickDz key action:
 *   - 'app_opened'      — user opened the ClickDz app / a provisioned app
 *   - 'deck_generated'  — a slide deck (SlidePro) generation completed
 *   - 'image_generated' — an AI image generation completed
 */
export function trackCdzEvent(
  event: CdzPostHogEvent | string,
  properties?: Record<string, unknown>
): void {
  if (!client || !enabled) {
    return;
  }
  try {
    client.capture(event, properties);
  } catch {
    /* no-op */
  }
}
