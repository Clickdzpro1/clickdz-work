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
 * open-source apps (SlidePro, Social+, CoursePro, ZOOM+).
 *
 * The user's standing directive: every app opens with an account ALREADY made
 * for the current user — no signup screen, no external link. This controller is
 * the AFFiNE-side half of that contract. Two route families:
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

const APPS = ['slidepro', 'socialplus', 'coursepro', 'zoomplus'] as const;
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
// SlidePro (Presenton) — real per-user account provisioning + auto-login.
// The admin creds are Railway references to the cdz-slidepro service's own
// AUTH_USERNAME/AUTH_PASSWORD (never handled in plaintext here). We log in as
// admin once per call to create the user (idempotent on 409), then log in AS
// the user to mint their presenton_session JWT, which we hand back as a
// one-time auto-login URL fragment for the iframe.
// ---------------------------------------------------------------------------
const SLIDEPRO_URL = (
  process.env.CDZ_SLIDEPRO_URL ||
  'https://cdz-slidepro-production.up.railway.app'
).replace(/\/+$/, '');
const SLIDEPRO_ADMIN_USERNAME = process.env.CDZ_SLIDEPRO_ADMIN_USERNAME || '';
const SLIDEPRO_ADMIN_PASSWORD = process.env.CDZ_SLIDEPRO_ADMIN_PASSWORD || '';

interface SlideProSession {
  cookie: string; // "presenton_session=<jwt>"
}

async function slideproLogin(
  username: string,
  password: string
): Promise<SlideProSession | null> {
  try {
    const res = await fetch(`${SLIDEPRO_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/presenton_session=([^;]+)/);
    if (!match) return null;
    return { cookie: `presenton_session=${match[1]}` };
  } catch {
    return null;
  }
}

async function slideproEnsureUser(
  adminCookie: string,
  username: string,
  password: string
): Promise<boolean> {
  try {
    const res = await fetch(`${SLIDEPRO_URL}/api/v1/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10_000),
    });
    // 201 created, 409 already exists — both mean the account is usable.
    return res.status === 201 || res.status === 409;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Social+ (Postiz) — per-user account provisioning via the public register
// route. With RESEND_API_KEY unset, Postiz auto-activates new accounts, so
// POST /api/auth/register both creates AND immediately activates the user's
// org + account. We then log in to capture the auth cookie for auto-login.
// DISABLE_REGISTRATION=true on the service keeps strangers out — our backend
// is the only provisioner.
// ---------------------------------------------------------------------------
const POSTIZ_URL = (
  process.env.CDZ_POSTIZ_URL ||
  'https://postiz-production-2db4.up.railway.app'
).replace(/\/+$/, '');

async function postizRegister(
  email: string,
  password: string,
  company: string
): Promise<boolean> {
  try {
    const res = await fetch(`${POSTIZ_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'LOCAL',
        email,
        password,
        company,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    // 201/200 created; 409/400 already-exists — all mean the account is usable.
    return res.ok || res.status === 409 || res.status === 400;
  } catch {
    return false;
  }
}

async function postizLogin(
  email: string,
  password: string
): Promise<string | null> {
  try {
    const res = await fetch(`${POSTIZ_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/(?:^|,\s*)auth=([^;]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

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
      signal: AbortSignal.timeout(12_000),
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
      signal: AbortSignal.timeout(12_000),
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
   * Body: { app: 'slidepro'|'socialplus'|'coursepro'|'zoomplus' }
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
    if (!record) {
      // Deterministic, URL-safe per-user username scoped to the app.
      const username = `u_${user.id.replace(/-/g, '').slice(0, 20)}`;
      // A random per-user credential, sealed at rest. The actual per-app
      // account is created lazily by the service's auth shim when it redeems a
      // code (SlidePro admin API, Postiz /auth/register, Meet OIDC, etc.).
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

    // SlidePro: provision the account + build an auto-login URL, best-effort.
    // We do this server-to-server so the iframe can land the user already
    // logged in without ever showing a signup/login screen.
    let loginUrl: string | undefined;
    if (
      app === 'slidepro' &&
      SLIDEPRO_ADMIN_USERNAME &&
      SLIDEPRO_ADMIN_PASSWORD &&
      plainCredential
    ) {
      try {
        const admin = await slideproLogin(
          SLIDEPRO_ADMIN_USERNAME,
          SLIDEPRO_ADMIN_PASSWORD
        );
        if (admin) {
          await slideproEnsureUser(
            admin.cookie,
            record.username,
            plainCredential
          );
          const userSess = await slideproLogin(
            record.username,
            plainCredential
          );
          if (userSess) {
            // Stash the user's presenton_session JWT in Redis keyed by the code
            // nonce; the login shim redeems it (one-time, short TTL) via
            // /api/bridge/session, sets it as a first-party cookie on the shim
            // domain, and lands in the app authenticated.
            const jwt = userSess.cookie.replace(/^presenton_session=/, '');
            try {
              await this.redis.set(
                `clickdz:appsession:${nonce}`,
                jwt,
                'PX',
                CODE_TTL_MS,
                'NX'
              );
            } catch {
              /* non-fatal */
            }
            const shim = (
              process.env.CDZ_SLIDEPRO_SHIM_URL || SLIDEPRO_URL
            ).replace(/\/+$/, '');
            loginUrl = `${shim}/?ticket=${encodeURIComponent(code)}`;
          }
        }
      } catch {
        loginUrl = undefined; // fall through to the code-only flow
      }
    }

    // Social+: provision via Postiz register (auto-activated) + stash the auth
    // cookie for the shim, best-effort. The Postiz account uses the per-app
    // username as its email local-part (Postiz requires an email-shaped id).
    if (app === 'socialplus' && plainCredential) {
      try {
        const email = `${record.username}@apps.clickdz.local`;
        await postizRegister(email, plainCredential, record.username);
        const authJwt = await postizLogin(email, plainCredential);
        if (authJwt) {
          try {
            await this.redis.set(
              `clickdz:appsession:${nonce}`,
              authJwt,
              'PX',
              CODE_TTL_MS,
              'NX'
            );
          } catch {
            /* non-fatal */
          }
          const shim = (
            process.env.CDZ_POSTIZ_SHIM_URL || POSTIZ_URL
          ).replace(/\/+$/, '');
          loginUrl = `${shim}/?ticket=${encodeURIComponent(code)}`;
        }
      } catch {
        loginUrl = undefined;
      }
    }

    // CoursePro: provision via Better Auth sign-up (auto-activated) + stash the
    // signed session cookie for the shim, best-effort.
    if (app === 'coursepro' && plainCredential) {
      try {
        const email = `${record.username}@apps.clickdz.local`;
        const displayName = record.name || record.username;
        await courseproSignUp(displayName, email, plainCredential);
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
      const meetFrontend = (
        process.env.CDZ_ZOOMPLUS_URL ||
        'https://meet-frontend-production.up.railway.app'
      ).replace(/\/+$/, '');
      loginUrl = `${idp}/prime?code=${encodeURIComponent(code)}&next=${encodeURIComponent(meetFrontend + '/')}`;
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
   * name differs per app (Presenton `presenton_session`, Postiz `auth`), so we
   * return the pair and let the shim set it generically.
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
    // Cookie name per app (Presenton `presenton_session`, Postiz `auth`,
    // ClassroomIO `__Secure-classroomio.session_token`).
    const cookieName =
      app === 'socialplus'
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
   * Returns: { presenton_session, auth, cookie_name, cookie_value }
   * Same verification as /api/bridge/session but ALSO returns the legacy
   * `presenton_session`/`auth` field names so a v1 shim reading either shape
   * works. (The deployed SlidePro shim v1 reads `presenton_session` directly.)
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
