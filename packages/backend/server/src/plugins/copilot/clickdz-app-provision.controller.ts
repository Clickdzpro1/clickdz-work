import {
  Body,
  Controller,
  Headers,
  Logger,
  Post,
} from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';

// Typed AFFiNE errors + the @Global CacheRedis raw handle + the session user.
// AuthGuard gates every route here (none are @Public except the code exchange,
// which is guarded by the bridge secret instead). Ownership is by user.id.
import { AccessDenied, BadRequest, Throttle } from '../../base';
import { CacheRedis } from '../../base/redis';
import { CurrentUser } from '../../core/auth';
import { Public } from '../../core/auth/guard';
import { createPostHogClientFromEnv } from '../../core/telemetry/posthog-client';
import { Models } from '../../models';
import { safeEqual } from './cdz-data-token';
import { sealSecret, openSecret } from './clickdz-secret-box';

/**
 * ClickDz App Provisioning — automatic per-user accounts for the embedded
 * open-source apps (CoursePro, ZOOM+).
 *
 * SlidePro NOTE: SlidePro was DELETED as an embedded app. It is now a fully
 * native in-house studio (React page + POST /api/v1/slidepro/* AI endpoints,
 * see clickdz-slidepro.controller.ts) that reuses the app's own copilot AI
 * gateway and image-generation routes. It no longer iframes an external
 * presenton fork, so it is no longer provisioned here (removed from APPS below,
 * along with its admin-login/ensure-user chain and CDZ_SLIDEPRO_* env vars).
 *
 * The user's standing directive: every remaining embedded app opens with an
 * account ALREADY made for the current user — no signup screen, no external
 * link. This controller is the AFFiNE-side half of that contract. Two route
 * families:
 *
 *  1. POST /api/v1/apps/provision  (session-gated, per-user)
 *     Called by the frontend panel before it iframes an app. Resolves the
 *     current user, looks up (or lazily creates) their account for that app,
 *     and returns a short-lived, one-time "bridge code" the embedded app can
 *     redeem server-to-server for the identity it should log in as.
 *
 *  2. POST /api/bridge/exchange  (bridge-secret gated, server-to-server)
 *     Called by an embedded service's auth shim (e.g. the ZOOM+ OIDC bridge,
 *     or a per-app login proxy) holding a bridge code. Verifies the code is
 *     unexpired + unspent + correctly signed, burns it, and returns the
 *     identity { sub, email, name } the service should provision/login.
 *
 * BRIDGE CODE format (mirrors the cdz-data-token idiom — versioned, self-
 * describing, expiring, stateless signature, but the nonce is STORED so each
 * code is single-use):
 *   base64url("b1." + userId + "." + app + "." + nonce + "." + exp + "." + sig)
 * sig = HMAC-SHA256(BRIDGE_SECRET, "bridge:{userId}:{app}:{nonce}:{exp}")
 * The nonce is setnx'd into Redis with the code's TTL on mint and DELeted on
 * exchange — a code can be redeemed exactly once.
 *
 * SECRET: a DEDICATED env CDZ_BRIDGE_CODE_SECRET (the SEC-4 rule in
 * cdz-data-token.ts forbids one secret backing multiple trust domains, so we
 * do NOT reuse CDZ_DATA_SECRET or CLICKDZ_BRIDGE_TOKEN). In dev it falls back
 * to an ephemeral random value (codes won't survive a restart — fine locally).
 *
 * Per-user account records are kept in Redis under
 *   clickdz:appacct:{app}:{userId}
 * with any app credential sealed via clickdz-secret-box (AES-256-GCM) at rest.
 */

const BRIDGE_SECRET =
  process.env.CDZ_BRIDGE_CODE_SECRET ||
  // dev-only fallback: ephemeral per-process (a restart invalidates codes).
  (process.env.NODE_ENV === 'production'
    ? ''
    : randomBytes(32).toString('hex'));

// Codes are short-lived; 90s covers the iframe load + redirect round-trip.
const CODE_TTL_MS = 90_000;

// WS9: 'socialplus' is no longer provisioned here — the native Social studio
// connects/publishes per-user through Composio (clickdz-integrations.controller)
// and no longer embeds Postiz, so it needs no bridge account/login URL.
// SlidePro removed: it is now a native in-house studio (no external app to
// provision/auto-login into) — see clickdz-slidepro.controller.ts.
const APPS = ['coursepro', 'zoomplus'] as const;
type AppId = (typeof APPS)[number];

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}
function fromB64url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function signBridgePayload(payload: string): string {
  return createHmac('sha256', BRIDGE_SECRET).update(payload).digest('base64url');
}

function acctKey(app: string, userId: string): string {
  return `clickdz:appacct:${app}:${userId}`;
}
function nonceKey(nonce: string): string {
  return `clickdz:bridgecode:${nonce}`;
}

// ---------------------------------------------------------------------------
// SlidePro removed (now native): the Presenton per-user provisioning +
// auto-login chain (admin-login → ensure-user → user-login minting a
// presenton_session JWT) and its CDZ_SLIDEPRO_URL / CDZ_SLIDEPRO_ADMIN_* env
// vars were deleted. SlidePro no longer embeds an external service, so there is
// no upstream account to create or session to mint here.
// ---------------------------------------------------------------------------

// WS9: the Social+ (Postiz) provisioning helpers (postizRegister/postizLogin +
// POSTIZ_URL / CDZ_POSTIZ_URL / CDZ_POSTIZ_SHIM_URL) were removed. The native
// Social studio connects and publishes per-user directly through Composio
// (clickdz-integrations.controller.ts) under ONE COMPOSIO_API_KEY, so there is
// no Postiz account to register or auto-login into anymore.

// ---------------------------------------------------------------------------
// CoursePro (ClassroomIO) — per-user provisioning via Better Auth email routes.
// Sign-up auto-activates (minimal SMTP → no verification wall). The session
// cookie is __Secure-classroomio.session_token (signed value, 30-day). Requires
// an Origin header (CSRF) equal to the dashboard origin on every auth call.
// ---------------------------------------------------------------------------
const COURSEPRO_URL = (
  process.env.CDZ_COURSEPRO_URL ||
  'https://cio-dashboard-production-c568.up.railway.app'
).replace(/\/+$/, '');

// ClassroomIO runs self-hosted (single shared org). Its signup is guarded by
// `signupGuard`, which 400s with ORG_CONTEXT_REQUIRED unless the request carries
// a `cio-org-id` header identifying the org to attach the new user to. The shared
// "ClickDz" org was bootstrapped once; its id is the default below and can be
// overridden with CDZ_COURSEPRO_ORG_ID.
const COURSEPRO_ORG_ID =
  process.env.CDZ_COURSEPRO_ORG_ID ||
  '615b23a6-4a7b-4c71-aeb8-0d88ec7534cd';

function courseproHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Origin: COURSEPRO_URL,
    'cio-org-id': COURSEPRO_ORG_ID,
  };
}

function courseproSessionCookie(setCookie: string): string | null {
  const match = setCookie.match(
    /__Secure-classroomio\.session_token=([^;]+)/
  );
  return match ? match[1] : null;
}

// E1.2: per-call upstream timeouts shortened from 12 s → 5 s so the worst-case
// CoursePro chain (sign-up + login = 2 × 5 s = 10 s) fits comfortably within
// the FE's 25 s budget even on a cold service.
const COURSEPRO_CALL_TIMEOUT_MS = 5_000;

async function courseproSignUp(
  name: string,
  email: string,
  password: string
): Promise<boolean> {
  try {
    const res = await fetch(`${COURSEPRO_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: courseproHeaders(),
      body: JSON.stringify({ name, email, password }),
      signal: AbortSignal.timeout(COURSEPRO_CALL_TIMEOUT_MS),
    });
    // 200 created; 422 already-exists — both mean the account is usable.
    return res.ok || res.status === 422;
  } catch {
    return false;
  }
}

async function courseproLogin(
  email: string,
  password: string
): Promise<string | null> {
  try {
    const res = await fetch(`${COURSEPRO_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: courseproHeaders(),
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(COURSEPRO_CALL_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return courseproSessionCookie(res.headers.get('set-cookie') || '');
  } catch {
    return null;
  }
}

@Controller()
export class ClickDzAppProvisionController {
  private readonly logger = new Logger(ClickDzAppProvisionController.name);

  constructor(
    private readonly redis: CacheRedis,
    private readonly models: Models
  ) {}

  /**
   * POST /api/v1/apps/provision
   * Body: { app: 'coursepro'|'zoomplus' }
   * Returns: { code, expiresAt, account: { username } , appUrl }
   * Ensures the current user has an account record for the app (creating a
   * sealed credential on first call), then mints a one-time bridge code.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/provision')
  async provision(
    @CurrentUser() user: CurrentUser,
    @Body() body: unknown
  ): Promise<{
    code: string;
    expiresAt: number;
    account: { username: string };
    /** When set, the iframe should use this URL — it carries the one-time
        credential that lands the user already logged in (best-effort). */
    loginUrl?: string;
  }> {
    if (!BRIDGE_SECRET) {
      throw new BadRequest(
        'App provisioning is not configured (CDZ_BRIDGE_CODE_SECRET unset)'
      );
    }
    const app = String((body as any)?.app ?? '').toLowerCase();
    if (!APPS.includes(app as AppId)) {
      throw new BadRequest(`Unknown app "${app}"`);
    }

    // Per-user app-entitlement gate.
    //
    // PRODUCT DECISION (ClickDz): every workspace user auto-provisions an
    // account in every embedded app the moment they open it — no admin grant,
    // no request step. So the gate is DEFAULT-OPEN: provisioning always
    // proceeds. Set CDZ_APP_ENTITLEMENT_ENFORCE=1 to switch back to grant-gated
    // access (admin panel grants become required). Even when enforcing, we
    // FAIL-OPEN if the entitlement table is unreachable (e.g. migration not yet
    // applied — P2021/42P01) so a schema hiccup never locks users out.
    const enforceEntitlements = /^(1|true|yes)$/i.test(
      process.env.CDZ_APP_ENTITLEMENT_ENFORCE ?? ''
    );
    if (enforceEntitlements) {
      try {
        const entitled = await this.models.userAppEntitlement.has(user.id, app);
        if (!entitled) {
          throw new AccessDenied(
            `You don't have access to "${app}". Ask an admin to grant it.`
          );
        }
      } catch (err) {
        if (err instanceof AccessDenied) throw err;
        this.logger.error(
          `Entitlement check failed (fail-open, allowing ${app} for ${user.id}): ${(err as Error)?.message ?? err}`
        );
      }
    }

    // Look up (or lazily create) the per-user account record for this app.
    // E1.2: track whether the record already existed so downstream code can
    // skip the first-provision-only admin-login + ensure-user chain.
    const key = acctKey(app, user.id);
    let record: {
      username: string;
      credential?: string;
      email?: string;
      name?: string;
    } | null = null;
    try {
      const raw = await this.redis.get(key);
      if (raw) record = JSON.parse(raw);
    } catch {
      record = null;
    }
    const recordAlreadyExisted = record !== null;
    if (!record) {
      // Deterministic, URL-safe per-user username scoped to the app.
      const username = `u_${user.id.replace(/-/g, '').slice(0, 20)}`;
      // A random per-user credential, sealed at rest. The actual per-app
      // account is created lazily by the service's auth shim when it redeems a
      // code (Postiz /auth/register, Meet OIDC, etc.).
      const credential = randomBytes(24).toString('base64url');
      const sealed = sealSecret(credential);
      record = {
        username,
        credential: sealed ?? undefined,
        email: user.email ?? undefined,
        name: user.name ?? undefined,
      };
      // Persist (no expiry — the account is durable; the credential is sealed).
      try {
        await this.redis.set(key, JSON.stringify(record));
      } catch {
        /* non-fatal: we still mint a code; the record re-creates next time */
      }
    }
    // The plaintext credential, for services we provision server-to-server.
    const plainCredential = record.credential
      ? openSecret(record.credential)
      : null;

    // Mint the one-time bridge code.
    const nonce = randomBytes(16).toString('base64url');
    const exp = Date.now() + CODE_TTL_MS;
    const payload = `bridge:${user.id}:${app}:${nonce}:${exp}`;
    const sig = signBridgePayload(payload);
    const code = b64url(`b1.${user.id}.${app}.${nonce}.${exp}.${sig}`);
    // Store the nonce (single-use) with the code's TTL. setnx so a collision
    // can't overwrite an in-flight code.
    try {
      await this.redis.set(nonceKey(nonce), user.id, 'PX', CODE_TTL_MS, 'NX');
    } catch {
      /* if Redis is down the code still verifies by signature, just re-usable */
    }

    // SlidePro removed (now native): its server-to-server provisioning branch
    // (admin-login → ensure-user → user-login, stashing a presenton_session JWT
    // for the shim) was deleted. SlidePro no longer embeds an external service,
    // so no auto-login URL is minted for it here.
    let loginUrl: string | undefined;

    // WS9: the Social+ (Postiz) provisioning branch was removed. The native
    // Social studio connects/publishes per-user through Composio and no longer
    // provisions a Postiz account or shim login URL here.

    // CoursePro: provision via Better Auth sign-up (auto-activated) + stash the
    // signed session cookie for the shim, best-effort.
    //
    // E1.2 optimisation: skip courseproSignUp on repeat opens (account already
    // exists — the 422 path is harmless but wastes 5 s on a cold service).
    // On first provision the sign-up call is still needed to create the account.
    if (app === 'coursepro' && plainCredential) {
      try {
        const email = `${record.username}@apps.clickdz.local`;
        const displayName = record.name || record.username;
        if (!recordAlreadyExisted) {
          await courseproSignUp(displayName, email, plainCredential);
        }
        const sessionCookie = await courseproLogin(email, plainCredential);
        if (sessionCookie) {
          try {
            await this.redis.set(
              `clickdz:appsession:${nonce}`,
              sessionCookie,
              'PX',
              CODE_TTL_MS,
              'NX'
            );
          } catch {
            /* non-fatal */
          }
          const shim = (
            process.env.CDZ_COURSEPRO_SHIM_URL || COURSEPRO_URL
          ).replace(/\/+$/, '');
          loginUrl = `${shim}/?ticket=${encodeURIComponent(code)}`;
        }
      } catch {
        loginUrl = undefined;
      }
    }

    // ZOOM+ (La Suite Meet): unlike the cookie-shim apps, Meet authenticates
    // via OIDC against our meet-idp-bridge. Meet's OIDC client builds a fixed
    // /authorize URL and drops our bridge_code, so we can't ride it in on the
    // authorize redirect. Instead we point the iframe at the IdP's /prime
    // endpoint, which stashes the code in a first-party cookie on the IdP domain
    // and redirects into Meet; when Meet bounces back to /authorize the IdP
    // reads that cookie and auto-approves — no login form. The code is consumed
    // by /api/bridge/exchange (already implemented below), so no server-to-
    // server provisioning step is needed here.
    if (app === 'zoomplus') {
      const idp = (
        process.env.CDZ_ZOOM_IDP_URL ||
        'https://cdz-zoom-idp-production.up.railway.app'
      ).replace(/\/+$/, '');
      // Self-host transition (ZOOM+ upgrade): when CDZ_ZOOMPLUS_USE_SELF_HOSTED
      // is enabled, prefer CDZ_ZOOMPLUS_SELF_HOSTED_URL (our branded
      // meet.clickdz.ai instance) over the legacy CDZ_ZOOMPLUS_URL default. The
      // flag defaults OFF so the existing Railway-hosted flow is unchanged until
      // the owner flips it — a zero-risk, per-request rollback path.
      const selfHostedUrl = process.env.CDZ_ZOOMPLUS_SELF_HOSTED_URL?.trim();
      const useSelfHosted =
        process.env.CDZ_ZOOMPLUS_USE_SELF_HOSTED === '1' && !!selfHostedUrl;
      const meetFrontend = (
        (useSelfHosted && selfHostedUrl) ||
        process.env.CDZ_ZOOMPLUS_URL ||
        'https://meet-frontend-production.up.railway.app'
      ).replace(/\/+$/, '');
      // Point `next` at Meet's OIDC authenticate endpoint (not the marketing
      // home) so the flow fires immediately: /prime stashes the bridge_code as a
      // first-party cookie on the IdP domain, then redirects into
      // authenticate → IdP /authorize (cookie present) → auto-approve →
      // callback → LOGIN_REDIRECT_URL (Meet home, now authenticated). Without
      // this the SPA just shows a "Login" button and never auto-logs-in.
      //
      // ZOOM+ meetings upgrade: when the panel passes a specific `room`, ask
      // Meet to return the browser INTO that room after auth instead of the
      // Meet home, so the iframe lands directly in the meeting. We pass BOTH the
      // Django-standard `next` (REDIRECT_FIELD_NAME, honoured by
      // mozilla-django-oidc) and a `returnTo` alias, since the Meet frontend has
      // used either name across versions. This is best-effort: if Meet ignores
      // it the user still lands logged-in on the Meet home and can open the room
      // via the copyable deep-link. A blank room preserves prior behaviour
      // exactly. Only a same-origin Meet path is ever built (no open redirect);
      // the room is sanitized to a safe path segment.
      const rawRoom = String((body as any)?.room ?? '').trim();
      const room = rawRoom.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 96);
      let meetAuthenticate = `${meetFrontend}/api/v1.0/authenticate/`;
      if (room) {
        const roomUrl = `${meetFrontend}/${encodeURIComponent(room)}`;
        const enc = encodeURIComponent(roomUrl);
        meetAuthenticate += `?next=${enc}&returnTo=${enc}`;
      }
      loginUrl = `${idp}/prime?code=${encodeURIComponent(code)}&next=${encodeURIComponent(meetAuthenticate)}`;
    }

    // PostHog server-side event (no-op unless CDZ_POSTHOG_KEY/HOST are set):
    // a user provisioned (opened) an embedded app. Fire-and-forget.
    void createPostHogClientFromEnv().capture({
      event: 'user_provisioned_app',
      distinctId: user.id,
      properties: {
        app,
        username: record.username,
        has_login_url: Boolean(loginUrl),
      },
    });

    return {
      code,
      expiresAt: exp,
      account: { username: record.username },
      loginUrl,
    };
  }

  /**
   * POST /api/bridge/session
   * Headers: Authorization: Bearer <BRIDGE_SECRET>  (the login shim)
   * Body: { ticket, app }
   * Returns: { cookie_name, cookie_value }
   * Verifies a bridge code (same format as /api/bridge/exchange) and, if a
   * per-user app session was stashed for it at provision time, returns + burns
   * it. The shim sets it as a first-party cookie on the app domain. The cookie
   * name differs per app (Postiz `auth`, ClassroomIO
   * `__Secure-classroomio.session_token`), so we return the pair and let the
   * shim set it generically.
   */
  @Public()
  @Throttle('strict')
  @Post('/api/bridge/session')
  async bridgeSession(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown
  ): Promise<{ cookie_name: string; cookie_value: string }> {
    if (!BRIDGE_SECRET) {
      throw new BadRequest('Bridge session is not configured');
    }
    const expected = `Bearer ${BRIDGE_SECRET}`;
    if (!authorization || !safeEqual(authorization, expected)) {
      throw new BadRequest('Invalid bridge credentials');
    }
    const ticket = String((body as any)?.ticket ?? '');
    if (!ticket) throw new BadRequest('Missing ticket');

    // Re-derive the nonce from the ticket (same b1.* format) and verify sig.
    let decoded: string;
    try {
      decoded = fromB64url(ticket);
    } catch {
      throw new BadRequest('Malformed ticket');
    }
    const parts = decoded.split('.');
    if (parts.length !== 6 || parts[0] !== 'b1') {
      throw new BadRequest('Malformed ticket');
    }
    const [, userId, app, nonce, expStr, sig] = parts;
    if (!userId || !app || !nonce || !expStr || !sig) {
      throw new BadRequest('Malformed ticket');
    }
    if (Date.now() > Number(expStr)) {
      throw new BadRequest('Ticket expired');
    }
    const payload = `bridge:${userId}:${app}:${nonce}:${expStr}`;
    if (!safeEqual(signBridgePayload(payload), sig)) {
      throw new BadRequest('Bad signature');
    }

    const sessionKey = `clickdz:appsession:${nonce}`;
    let jwt = '';
    try {
      jwt = (await this.redis.get(sessionKey)) || '';
      if (jwt) await this.redis.del(sessionKey); // single-use
    } catch {
      jwt = '';
    }
    if (!jwt) {
      throw new BadRequest('No session for ticket');
    }
    // Cookie name per app (Postiz `auth`, ClassroomIO
    // `__Secure-classroomio.session_token`). The `presenton_session` fallback is
    // LEGACY-ONLY now: SlidePro is native and no longer stashes a session here,
    // so nothing reaches this default via provision(). It is retained solely so
    // a stale deployed shim mid-transition still gets a well-formed reply.
    const cookieName =
      app === 'postiz'
        ? 'auth'
        : app === 'coursepro'
          ? '__Secure-classroomio.session_token'
          : 'presenton_session';
    return { cookie_name: cookieName, cookie_value: jwt };
  }

  /**
   * POST /api/bridge/bootstrap
   * Headers: Authorization: Bearer <BRIDGE_SECRET>  (the login shim)
   * Body: { ticket }
   * Returns: { presenton_session, cookie_name, cookie_value }
   * Same verification as /api/bridge/session but ALSO returns the legacy
   * `presenton_session` field name so a v1 shim reading either shape works.
   * LEGACY-ONLY: SlidePro is now native and no longer provisioned, so nothing in
   * this codebase calls bootstrap for it — the route is kept purely so a stale
   * deployed shim mid-transition still gets a well-formed reply.
   */
  @Public()
  @Throttle('strict')
  @Post('/api/bridge/bootstrap')
  async bridgeBootstrap(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown
  ): Promise<{
    presenton_session: string;
    cookie_name: string;
    cookie_value: string;
  }> {
    const { cookie_name, cookie_value } = await this.bridgeSession(
      authorization,
      body
    );
    return {
      presenton_session: cookie_value,
      cookie_name,
      cookie_value,
    };
  }

  /**
   * POST /api/bridge/exchange
   * Headers: Authorization: Bearer <BRIDGE_SECRET>  (the embedded service's shim)
   * Body: { code }
   * Returns: { sub, email, name, app, username }
   * Verifies + burns a bridge code and returns the identity to provision/login.
   */
  @Public()
  @Throttle('strict')
  @Post('/api/bridge/exchange')
  async exchange(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown
  ): Promise<{
    sub: string;
    email: string;
    name: string;
    app: string;
    username: string;
  }> {
    if (!BRIDGE_SECRET) {
      throw new BadRequest('Bridge exchange is not configured');
    }
    const expected = `Bearer ${BRIDGE_SECRET}`;
    if (!authorization || !safeEqual(authorization, expected)) {
      throw new BadRequest('Invalid bridge credentials');
    }
    const code = String((body as any)?.code ?? '');
    if (!code) throw new BadRequest('Missing code');

    let decoded: string;
    try {
      decoded = fromB64url(code);
    } catch {
      throw new BadRequest('Malformed code');
    }
    const parts = decoded.split('.');
    // b1.{userId}.{app}.{nonce}.{exp}.{sig}
    if (parts.length !== 6 || parts[0] !== 'b1') {
      throw new BadRequest('Malformed code');
    }
    const [, userId, app, nonce, expStr, sig] = parts;
    const exp = Number(expStr);
    if (!userId || !app || !nonce || !exp || !sig) {
      throw new BadRequest('Malformed code');
    }
    if (Date.now() > exp) {
      throw new BadRequest('Code expired');
    }
    const payload = `bridge:${userId}:${app}:${nonce}:${expStr}`;
    if (!safeEqual(signBridgePayload(payload), sig)) {
      throw new BadRequest('Bad signature');
    }

    // Burn the nonce (single-use). If it was stored, DEL it; a missing key just
    // means Redis was down at mint — the signature+expiry already validated it.
    try {
      await this.redis.del(nonceKey(nonce));
    } catch {
      /* non-fatal */
    }

    // Resolve the identity + the per-app account record.
    let username = `u_${userId.replace(/-/g, '').slice(0, 20)}`;
    let email = `${username}@apps.clickdz.local`;
    let name = username;
    try {
      const raw = await this.redis.get(acctKey(app, userId));
      if (raw) {
        const rec = JSON.parse(raw);
        if (rec?.username) username = rec.username;
        if (rec?.email) email = rec.email;
        if (rec?.name) name = rec.name;
        if (rec?.credential) openSecret(rec.credential); // sealed at rest
      }
    } catch {
      /* fall back to derived identity */
    }

    // The identity is keyed by the stable user id (sub) — that is what the
    // embedded services join on (Presenton owner_id, Meet sub, etc.).
    return { sub: userId, email, name, app, username };
  }
}
