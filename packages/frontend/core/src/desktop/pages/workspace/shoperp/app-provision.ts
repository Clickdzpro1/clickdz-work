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

/**
 * Ask the backend for a one-time bridge code for `app`
 * ('slidepro' | 'socialplus' | 'coursepro' | 'zoomplus').
 *
 * Returns null on ANY failure (network error, non-2xx, malformed body) — the
 * caller must treat provisioning as optional and still load the bare URL.
 */
export async function provisionApp(app: string): Promise<ProvisionedApp | null> {
  try {
    const resp = await fetch('/api/v1/apps/provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app }),
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const code = data?.code;
    if (typeof code !== 'string' || !code) return null;
    // PostHog key action (no-op unless CDZ_POSTHOG_KEY/HOST configured).
    trackCdzEvent('app_provisioned', { app });
    return {
      code,
      username: data?.account?.username ?? '',
      loginUrl: typeof data?.loginUrl === 'string' ? data.loginUrl : undefined,
    };
  } catch {
    return null;
  }
}

/** Append `bridge_code` to a base URL, respecting any existing query string. */
export function withBridgeCode(baseUrl: string, code: string): string {
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}bridge_code=${encodeURIComponent(code)}`;
}
