import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { AuthService } from '@affine/core/modules/cloud';
import { useService } from '@toeverything/infra';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

/**
 * App access gate — checks whether the signed-in user has an active
 * entitlement for a gated application (SLIDE_PRO, SOCIAL_PLUS, COURSE_PRO,
 * ZOOM_PLUS). If the entitlement is inactive or absent, renders an
 * "Upgrade to get access" screen instead of the children.
 *
 * The check is a lightweight GraphQL query against the backend
 * `userAppEntitlements(userId: String!)` field, passing the current user's
 * own session id (obtained from `AuthService`). The backend resolver allows
 * a user to query their own entitlements.
 *
 * FAIL-OPEN: if the entitlement check itself errors (network, 401, 403, etc.),
 * the gate renders the children unchanged. This preserves existing access for
 * users when the entitlement service is unavailable, rather than locking
 * everyone out. The admin toggles an entitlement OFF to gate a user; a
 * service outage should NOT gate them.
 *
 * French strings use U+2019 (curved apostrophe) inside template literals to
 * avoid the swc-loader curly-quote-in-single-quote trap documented in the
 * project handoff.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GatedApp = 'SLIDE_PRO' | 'SOCIAL_PLUS' | 'COURSE_PRO' | 'ZOOM_PLUS';

interface EntitlementRow {
  app: string;
  active: boolean;
  plan?: string | null;
  expiresAt?: string | null;
}

interface EntitlementsResponse {
  data?: {
    userAppEntitlements?: EntitlementRow[];
  };
  errors?: Array<{ message: string }>;
}

// ---------------------------------------------------------------------------
// API call — fetch the current user's entitlements via GraphQL
// ---------------------------------------------------------------------------

/**
 * Fetch the signed-in user's own app entitlements. Uses the same `cdzApiUrl`
 * + `credentials: 'include'` idiom as the agents REST client
 * (modules/agents/api.ts) so desktop/native builds resolve correctly.
 *
 * The GraphQL endpoint is at `/graphql` (the same path the AFFiNE framework
 * uses). We send a minimal query selecting only the fields the gate needs.
 */
async function fetchEntitlements(userId: string): Promise<EntitlementRow[]> {
  const query = `query userAppEntitlementsSelf($userId: String!) {
  userAppEntitlements(userId: $userId) {
    app
    active
    plan
    expiresAt
  }
}`;

  let res: Response;
  try {
    res = await fetch(cdzApiUrl('/graphql'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ query, variables: { userId } }),
    });
  } catch {
    // Network error — fail open.
    return [];
  }

  if (!res.ok) {
    // Non-OK response — fail open.
    return [];
  }

  try {
    const json = (await res.json()) as EntitlementsResponse;
    if (json.errors || !json.data?.userAppEntitlements) {
      return [];
    }
    return json.data.userAppEntitlements;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Display labels for the gated apps (used in the upgrade screen)
// ---------------------------------------------------------------------------

const APP_LABELS: Record<GatedApp, string> = {
  SLIDE_PRO: `SlidePro`,
  SOCIAL_PLUS: `Social`,
  COURSE_PRO: `CoursePro`,
  ZOOM_PLUS: `ZOOM+`,
};

// ---------------------------------------------------------------------------
// Gate component
// ---------------------------------------------------------------------------

interface AppAccessGateProps {
  app: GatedApp;
  children: ReactNode;
}

export function AppAccessGate({ app, children }: AppAccessGateProps) {
  const [state, setState] = useState<
    'checking' | 'allowed' | 'gated'
  >('checking');
  const auth = useService(AuthService);
  const userId = auth.session.account$.value?.id;

  const check = useCallback(async () => {
    if (!userId) {
      // No session — fail open (the studio page itself will handle auth).
      setState('allowed');
      return;
    }
    const entitlements = await fetchEntitlements(userId);
    const row = entitlements.find(e => e.app === app);
    if (row && row.active === false) {
      setState('gated');
    } else {
      // Active entitlement, OR no entitlement row at all (fail-open —
      // the user hasn't been gated by an admin, so they keep access).
      setState('allowed');
    }
  }, [app, userId]);

  useEffect(() => {
    void check();
  }, [check]);

  if (state === 'allowed') {
    return <>{children}</>;
  }

  if (state === 'gated') {
    const label = APP_LABELS[app] ?? app;
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: '40px 24px',
          background:
            'var(--affine-background-primary-color, #141414)',
          color: 'var(--affine-text-primary-color, #ececec)',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 48, lineHeight: 1 }}>
          {`\u{1F512}`}
        </div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>{label}</div>
        <div
          style={{
            fontSize: 14,
            maxWidth: 380,
            lineHeight: 1.6,
            color: 'var(--affine-text-secondary-color, #9aa0a6)',
          }}
        >
          {`Cette application nécessite un accès premium. Contactez l\u{2019}administrateur pour l\u{2019}activer.`}
        </div>
        <button
          onClick={() => window.history.back()}
          style={{
            marginTop: 8,
            padding: '8px 20px',
            fontSize: 14,
            fontWeight: 600,
            borderRadius: 8,
            border: '1px solid var(--affine-border-color, #2a2a2c)',
            background:
              'var(--affine-background-secondary-color, #1c1c1e)',
            color: 'var(--affine-text-primary-color, #ececec)',
            cursor: 'pointer',
          }}
        >
          {`Retour`}
        </button>
      </div>
    );
  }

  // 'checking' state — minimal loading indicator.
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--affine-text-secondary-color, #9aa0a6)',
        fontSize: 14,
      }}
    >
      {`Chargement…`}
    </div>
  );
}
