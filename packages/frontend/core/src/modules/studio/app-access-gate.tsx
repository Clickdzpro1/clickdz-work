import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { AuthService } from '@affine/core/modules/cloud';
import { useService } from '@toeverything/infra';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

/**
 * App access gate — checks whether the signed-in user has an active
 * entitlement for a gated application (all studios + AI Chat + Whiteboard).
 * If the entitlement is inactive or absent, renders an
 * "Upgrade to get access" screen instead of the children.
 *
 * The check is a lightweight GraphQL query against the backend
 * `myAppEntitlements` field (public, uses the session user) with a fallback
 * to the admin-only `userAppEntitlements(userId: String!)` field.
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

export type GatedApp =
  | 'SLIDE_PRO'
  | 'SOCIAL_PLUS'
  | 'COURSE_PRO'
  | 'ZOOM_PLUS'
  | 'VDZ'
  | 'VOICE'
  | 'APPS'
  | 'SHOPERP'
  | 'HERMES'
  | 'OPENCLAW'
  | 'AGENTS'
  | 'VPIC'
  | 'INTEGRATIONS'
  | 'WHATSAPPMAX'
  | 'AI_CHAT'
  | 'WHITEBOARD';

interface EntitlementRow {
  app: string;
  active: boolean;
  plan?: string | null;
  expiresAt?: string | null;
}

interface EntitlementsResponse {
  data?: {
    userAppEntitlements?: EntitlementRow[];
    myAppEntitlements?: EntitlementRow[];
  };
  errors?: Array<{ message: string }>;
}

// ---------------------------------------------------------------------------
// API call — fetch the current user's entitlements via GraphQL
// ---------------------------------------------------------------------------

/**
 * Fetch the signed-in user's own app entitlements. Uses the public
 * `myAppEntitlements` GraphQL query (no userId arg — the backend resolver
 * uses @CurrentUser to read the session). Falls back to the admin-only
 * `userAppEntitlements(userId)` query if the public one is not yet
 * deployed, ensuring backward compatibility.
 *
 * Uses the same `cdzApiUrl` + `credentials: 'include'` idiom as the agents
 * REST client (modules/agents/api.ts) so desktop/native builds resolve
 * correctly.
 *
 * The GraphQL endpoint is at `/graphql` (the same path the AFFiNE framework
 * uses). We send a minimal query selecting only the fields the gate needs.
 */
async function fetchEntitlements(userId: string): Promise<EntitlementRow[]> {
  // Primary: the public myAppEntitlements query (no userId arg, uses session).
  const publicQuery = `query myAppEntitlementsSelf {
  myAppEntitlements {
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
      body: JSON.stringify({ query: publicQuery }),
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
    if (json.errors || !json.data?.myAppEntitlements) {
      // Public query may not be deployed yet — fall back to the admin query.
      return await fetchEntitlementsFallback(userId);
    }
    return json.data.myAppEntitlements;
  } catch {
    return [];
  }
}

/**
 * Fallback: use the admin-only userAppEntitlements(userId) query.
 * This requires the user to be an admin, but preserves backward compatibility
 * for deployments where the public myAppEntitlements resolver is not yet
 * available.
 */
async function fetchEntitlementsFallback(userId: string): Promise<EntitlementRow[]> {
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
    return [];
  }

  if (!res.ok) {
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
  VDZ: `Vdz Studio`,
  VOICE: `Voice Studio`,
  APPS: `ClickDz Apps`,
  SHOPERP: `DzOS`,
  HERMES: `Hermes`,
  OPENCLAW: `OpenClaw`,
  AGENTS: `Agents`,
  VPIC: `Studio Image`,
  INTEGRATIONS: `Integrations Flows`,
  WHATSAPPMAX: `WhatsappMax`,
  AI_CHAT: `AI Chat`,
  WHITEBOARD: `Whiteboard`,
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
    // Case-insensitive match: the backend stores lowercase app keys
    // (e.g. 'slide_pro'), the gate receives uppercase (e.g. 'SLIDE_PRO').
    const row = entitlements.find(e => e.app.toLowerCase() === app.toLowerCase());
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
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 24px',
          background: 'var(--affine-background-primary-color, #141414)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 20,
            width: '100%',
            maxWidth: 420,
            padding: '44px 36px',
            borderRadius: 20,
            textAlign: 'center',
            background: 'var(--affine-background-overlay-panel-color, var(--affine-background-secondary-color, #1c1c1e))',
            border: '1px solid var(--affine-border-color, #2a2a2c)',
            boxShadow: 'var(--affine-shadow-2, 0 12px 40px rgba(0, 0, 0, 0.24))',
          }}
        >
          {/* CSS-only lock badge — a soft circular halo behind a padlock
              glyph, built entirely from vanilla CSS (no external image
              assets), so it renders instantly and themes with the app's
              CSS variables. */}
          <div
            style={{
              position: 'relative',
              width: 72,
              height: 72,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              background:
                'radial-gradient(circle at 50% 40%, var(--affine-primary-color, #1e96eb) 0%, transparent 72%)',
              opacity: 0.16,
            }}
          />
          <div
            style={{
              position: 'relative',
              marginTop: -72,
              width: 72,
              height: 72,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              border: '1px solid var(--affine-border-color, #2a2a2c)',
              background: 'var(--affine-background-primary-color, #141414)',
              fontSize: 28,
            }}
          >
            {`\u{1F512}`}
          </div>
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--affine-text-secondary-color, #9aa0a6)',
            }}
          >
            {`Accès restreint`}
          </div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: 'var(--affine-text-primary-color, #ececec)',
            }}
          >
            {label}
          </div>
          <div
            style={{
              fontSize: 14,
              lineHeight: 1.6,
              color: 'var(--affine-text-secondary-color, #9aa0a6)',
            }}
          >
            {`Cette application n\u{2019}est pas incluse dans votre offre actuelle. Contactez l\u{2019}administrateur pour l\u{2019}activer sur votre espace.`}
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              width: '100%',
              marginTop: 8,
            }}
          >
            <a
              href={`mailto:support@clickdz.ai?subject=${encodeURIComponent(
                `Demande d\u{2019}accès — ${label}`
              )}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '10px 20px',
                fontSize: 14,
                fontWeight: 600,
                borderRadius: 10,
                border: 'none',
                background: 'var(--affine-primary-color, #1e96eb)',
                color: 'var(--affine-white, #ffffff)',
                textDecoration: 'none',
                cursor: 'pointer',
              }}
            >
              {`Contacter l\u{2019}administrateur`}
            </a>
            <button
              onClick={() => window.history.back()}
              style={{
                padding: '10px 20px',
                fontSize: 14,
                fontWeight: 600,
                borderRadius: 10,
                border: '1px solid var(--affine-border-color, #2a2a2c)',
                background: 'transparent',
                color: 'var(--affine-text-primary-color, #ececec)',
                cursor: 'pointer',
              }}
            >
              {`Retour`}
            </button>
          </div>
        </div>
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
