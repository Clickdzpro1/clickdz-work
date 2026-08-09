// Embedded-app provisioning bridge for the ShopERP panels (SlidePro, CoursePro,
// Social+, ZOOM+). POST /api/v1/apps/provision is session-gated and mints a
// one-time 90s bridge code that the target app redeems via its auth shim, so
// the iframe can auto-login the current user. Provisioning is BEST-EFFORT:
// any failure returns null and the panel still iframes the bare URL.
import { trackCdzEvent } from '@affine/core/clickdz/posthog';

/** The subset of the provision response the panels consume. */
export interface ProvisionedApp {
  code: string;
  username: string;
  /** When present, the iframe should load THIS url (it lands the user already
      logged in via the app's auth shim). Takes precedence over withBridgeCode. */
  loginUrl?: string;
}

// E1.1: backend provisioning does synchronous server-to-server work:
//   SlidePro  → admin-login + ensure-user + user-login (3 × up to 5 s = ≤15 s)
//   CoursePro → sign-up + login                        (2 × up to 5 s = ≤10 s)
// The old 4 s abort killed every cold-service call. Raise to 25 s (comfortably
// covers the worst case with margin) and add one automatic retry so a transient
// cold-start doesn't permanently show the red banner.
const PROVISION_TIMEOUT_MS = 25_000;
const PROVISION_MAX_ATTEMPTS = 2;

// C4: Per-app override for max provision attempts. ZOOM+ (Meet backend) is a
// cold-start-or-not service — retrying a 25s timeout twice just doubles the
// wait to 50s for the user. The frontend 'slow' state (15s threshold) already
// surfaces a retry/cancel UI, so the backend retry is redundant for zoomplus.
const PROVISION_MAX_ATTEMPTS_OVERRIDE: Record<string, number> = {
  zoomplus: 1,
};

function maxAttemptsFor(app: string): number {
  return PROVISION_MAX_ATTEMPTS_OVERRIDE[app] ?? PROVISION_MAX_ATTEMPTS;
}

async function provisionOnce(app: string): Promise<ProvisionedApp | null> {
  try {
    const resp = await fetch('/api/v1/apps/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app }),
      signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const code = data?.code;
    if (typeof code !== 'string' || !code) return null;
    return {
      code,
      username: data?.account?.username ?? '',
      loginUrl: typeof data?.loginUrl === 'string' ? data.loginUrl : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Ask the backend for a one-time bridge code for `app`
 * ('slidepro' | 'socialplus' | 'coursepro' | 'zoomplus').
 *
 * Returns null on ANY failure (network error, non-2xx, malformed body) — the
 * caller must treat provisioning as optional and still load the bare URL.
 *
 * E1.1 changes vs original:
 *  - Timeout raised from 4 s → 25 s (backend chain can take up to ~30 s cold).
 *  - One automatic retry so a cold-start transient doesn't hard-fail the panel.
 */
export async function provisionApp(app: string): Promise<ProvisionedApp | null> {
  const maxAttempts = maxAttemptsFor(app);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await provisionOnce(app);
    if (result !== null) {
      // PostHog key action (no-op unless CDZ_POSTHOG_KEY/HOST configured).
      trackCdzEvent('app_provisioned', { app });
      return result;
    }
  }
  return null;
}

/** Append `bridge_code` to a base URL, respecting any existing query string. */
export function withBridgeCode(baseUrl: string, code: string): string {
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}bridge_code=${encodeURIComponent(code)}`;
}
