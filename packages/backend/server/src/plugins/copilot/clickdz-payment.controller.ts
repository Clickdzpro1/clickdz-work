import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';

// Typed AFFiNE errors so the global exception filter emits proper status codes
// (a raw @nestjs/common HttpException becomes a generic 500 through the filter).
// NotFound = a gated-OFF route / unknown provider (a clean typed 404, the SAME
// stance the courier + agent controllers take). BadRequest carries the
// 'invalid_credentials' reject on connect + validation rejects. ActionForbidden
// is the typed 403 for the ERP ownership gate. Throttle rate-caps the routes
// exactly as the courier controller does. Public marks the webhook route as
// skipping the cookie AuthGuard (a gateway webhook has no session — it is
// authed SOLELY by the provider's signature). ALL value-imported (lint-nest:
// every ctor-param + decorator identifier must resolve at boot as a VALUE).
import { ActionForbidden, BadRequest, NotFound, Throttle } from '../../base';
// CacheRedis is the @Global ioredis client the courier/bridge controllers inject
// for per-owner/per-slug records; RedisModule is @Global so injecting it needs
// no module wiring. Used for (a) the ownership gate's published-apps set and
// (b) the sealed payment credential record + the payment-id→order reverse map.
import { CacheRedis } from '../../base/redis';
// The global AuthGuard authenticates the first-party routes (no @Public / no
// bridge token). CurrentUser RECEIVES the already-verified session user so the
// ownership gate can key on identity. Public exempts ONLY the webhook route.
import { CurrentUser, Public } from '../../core/auth';
// Serrure's authenticated secret box (WS13 — BYO key). sealSecret before writing
// a merchant's payment keys to Redis, openSecret after reading (null on any
// tamper/format/missing-key — never throws), secretBoxReady gates the whole
// feature alongside the env flag (we cannot accept a key we can't protect).
import { openSecret, sealSecret, secretBoxReady } from './clickdz-secret-box';
// The pluggable payment core (pure). getPaymentProvider resolves the concrete
// impl for a provider id; the shared types + fail-soft PaymentResult union flow
// through here. Importing this module also runs both providers' registration
// side-effect at boot (slickpay + stripe self-register in clickdz-payment.ts).
import {
  getPaymentProvider,
  isPaymentMode,
  isPaymentProviderId,
  type CheckoutInput,
  type CheckoutItem,
  type PaymentCredentials,
  type PaymentError,
  type PaymentMode,
  type PaymentProvider,
  type PaymentProviderId,
} from './clickdz-payment';

// ---------------------------------------------------------------------------
// WS13 — PAYMENT CONTROLLER. Per-merchant BYO payment credentials (SlickPay +
// Stripe) + a hosted-checkout lifecycle, behind the CDZ_PAYMENTS_ENABLED flag
// (ship-DARK). A near-mechanical CLONE of clickdz-courier.controller.ts:
//   · connect  — BYO entry; validate the pasted keys with a cheap live call,
//     then seal BEFORE store, then persist the sealed per-(slug,provider) record.
//   · status   — { connected, enabled, mode?, publishableKey? } (NEVER the secret).
//   · disconnect — delete the record (idempotent).
//   · checkout — resolve creds → provider.createCheckout → { payUrl }. Persists a
//     paymentId→orderId reverse map so status + the webhook can correlate.
//   · status/:paymentId — resolve creds → provider.getPaymentStatus → { status }.
//   · webhook  — @Public; signature-verified (Stripe: Stripe-Signature HMAC over
//     the RAW bytes). SlickPay has no strong webhook ⇒ a typed 'webhook_unsupported'
//     (the FE re-checks via the status route on the return URL).
//
// Mirrors the courier BYO discipline VERBATIM: connect seals-before-store, status
// NEVER returns the secret (Stripe's publishable key MAY be returned — it is
// public by design), disconnect is idempotent, the ownership gate (assertOwnsErpApp)
// keys off the caller's published-apps set, and resolveCreds is the ONLY place a
// secret is unsealed (strictly AFTER the ownership gate).
//
// FLAG (dark): paymentsEnabled() = CDZ_PAYMENTS_ENABLED === '1' && secretBoxReady().
// Unset ⇒ every route throws a typed NotFound, byte-identical to the feature not
// existing. Per-provider DARK gate CDZ_PAY_SLICKPAY / CDZ_PAY_STRIPE (copy of the
// courier providerAllowed): an un-flagged provider 404s exactly like unregistered.
//
// FAIL-SOFT: every provider call returns a typed PaymentResult (never throws);
// writePaymentError maps it to a clean passthrough JSON body. A gateway hiccup
// never crashes a route, 500s, or leaks a key.
//
// MULTI-TENANT ISOLATION: creds are keyed per (slug, provider) and unsealed ONLY
// inside a route already gated by the per-owner ownership check.
// lint-nest: @Controller with ONE value-imported ctor param (CacheRedis).
// ---------------------------------------------------------------------------

// --- Config (read once at module load, same idiom as the sibling controllers).
const CDZ_PAYMENTS_ENABLED = process.env.CDZ_PAYMENTS_ENABLED || '';

// Slug shape shared by the whole app (identical to the courier's APP_SLUG_RE).
const APP_SLUG_RE = /^[a-z0-9-]{3,50}$/;

// Per-owner published-apps set key — BYTE-IDENTICAL to the courier/bridge
// publishedAppsKey (clickdz:apps:published:{ownerId}); READ for the ownership
// gate (never written here).
const publishedAppsKey = (ownerId: string) =>
  `clickdz:apps:published:${ownerId}`;

// Per-(shop, provider) sealed credential record. New WS13 namespace, mirrors the
// courier's clickdz:ship:courier:{slug}:{provider}.
const payCredKey = (slug: string, provider: string) =>
  `clickdz:pay:cred:${slug}:${provider}`;

// paymentId → orderId reverse map so the webhook (which carries only the
// gateway's payment id) can correlate back to the merchant's order. Per (slug,
// provider) namespaced so ids never collide across shops.
const payOrderKey = (slug: string, provider: string, paymentId: string) =>
  `clickdz:pay:order:${slug}:${provider}:${paymentId}`;

// Idempotency lock per (slug, order): creating a checkout is cheap + reversible
// (unlike a courier parcel), but the lock still collapses a double-click TOCTOU.
const checkoutLockKey = (slug: string, provider: string, orderId: string) =>
  `clickdz:pay:lock:${slug}:${provider}:${orderId}`;
const CHECKOUT_LOCK_TTL_SEC = 30;

// Rolling TTL for a stored credential record — matches the courier's 90d.
const CRED_TTL_SECONDS = 90 * 24 * 60 * 60;
// paymentId→order map TTL — long enough for a customer to complete + a webhook
// to arrive (7d is ample for a hosted checkout).
const PAY_ORDER_TTL_SECONDS = 7 * 24 * 60 * 60;

// Belt-and-braces caps on pasted credentials (defensive; keys are bounded).
const KEY_MAX = 512;

// ---------------------------------------------------------------------------
// The sealed per-(shop, provider) credential record persisted at payCredKey.
// `secretSealed` is Serrure-sealed (NEVER plaintext); `publishableSealed` is the
// (public-by-design) Stripe pk_ — still sealed at rest for uniformity, but MAY
// be returned to the FE by status. `webhookSecretSealed` is the optional Stripe
// signing secret. `mode` is the SlickPay sandbox/prod selector. `status` returns
// ONLY {connected, enabled, mode?, publishableKey?}.
// ---------------------------------------------------------------------------
export interface PaymentCredRecord {
  provider: string;
  secretSealed: string;
  publishableSealed?: string;
  webhookSecretSealed?: string;
  mode?: PaymentMode;
  enabled: boolean;
  connectedAt: number;
}

/** Loose string read for schemaless bodies: null/undefined → ''. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Number(v); non-finite → 0. */
function num(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Map a fail-soft PaymentError → this surface's typed JSON body via the
 * passthrough res (a raw HttpException would be coerced to a 500 by the global
 * filter). NEVER carries secret material. A 429 re-emits Retry-After. Mirrors
 * the courier's writeCourierError exactly.
 */
function writePaymentError(res: Response, err: PaymentError): void {
  switch (err.error) {
    case 'rate_limited': {
      if (typeof err.retryAfter === 'number') {
        res.header('Retry-After', String(err.retryAfter));
      }
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    case 'unauthorized':
      // The merchant's key was rejected by the gateway (or absent). 400 so the
      // FE prompts a re-connect; we do NOT leak which key was wrong.
      res.status(400).json({ error: 'invalid_credentials' });
      return;
    case 'not_found':
      res.status(404).json({ error: 'not_found' });
      return;
    case 'bad_request':
      res.status(400).json({ error: 'bad_request' });
      return;
    case 'unreachable':
      res.status(502).json({ error: 'gateway_unreachable' });
      return;
    case 'malformed':
      res.status(502).json({ error: 'gateway_bad_response' });
      return;
    case 'upstream_error':
    default:
      res.status(502).json({
        error: 'gateway_error',
        ...(typeof err.status === 'number' ? { status: err.status } : {}),
      });
      return;
  }
}

@Controller()
export class ClickDzPaymentController {
  // CacheRedis for BOTH the per-owner published-apps set (ownership gate) and
  // the sealed payment records + reverse maps. @Global provider ⇒ no module
  // wiring. Same injection style as clickdz-courier.controller.ts.
  constructor(private readonly redis: CacheRedis) {}

  // -------------------------------------------------------------------------
  // FEATURE GATE. Both the env flag AND a usable secret box are required:
  // without CDZ_DATA_SECRET/CDZ_SECRETBOX_KEY we cannot seal a merchant's key,
  // so we must NOT accept it — the whole feature stays dark (typed 404) rather
  // than storing keys we can't protect. Identical stance to couriersEnabled().
  // -------------------------------------------------------------------------
  private paymentsEnabled(): boolean {
    return CDZ_PAYMENTS_ENABLED === '1' && secretBoxReady();
  }

  /** Typed 404 when the feature is off — never leaks that the route exists. */
  private assertEnabled(): void {
    if (!this.paymentsEnabled()) {
      throw new NotFound('Payment integration is not enabled');
    }
  }

  /**
   * Resolve the :provider path segment to a concrete PaymentProvider, or throw a
   * typed NotFound. An unknown provider, or a registered-but-DARK one (its
   * per-provider flag is off), 404s — byte-identical to the route not existing.
   */
  private resolveProviderOr404(provider: string): PaymentProvider {
    if (!isPaymentProviderId(provider)) {
      throw new NotFound(`unknown payment provider "${provider}"`);
    }
    if (!this.providerAllowed(provider)) {
      throw new NotFound(`payment provider "${provider}" is not available`);
    }
    const impl = getPaymentProvider(provider);
    if (!impl) {
      throw new NotFound(`payment provider "${provider}" is not available`);
    }
    return impl;
  }

  /**
   * Per-provider DARK gate (mirror of the courier providerAllowed). BOTH
   * providers require their OWN `CDZ_PAY_<ID>=1` flag (nothing grandfathered —
   * this is a net-new, ship-DARK feature). Read from env each call so a flag
   * flips a provider live WITHOUT a code change (the house '1' idiom).
   */
  private providerAllowed(id: PaymentProviderId): boolean {
    return (process.env[`CDZ_PAY_${id.toUpperCase()}`] || '') === '1';
  }

  // -------------------------------------------------------------------------
  // OWNERSHIP GATE — replicates the courier controller's assertOwnsErpApp
  // VERBATIM: the :slug must belong to the CALLER. Reuses the exact published-
  // apps set + the public-settings probe (data present ⇒ 403 not-owner; nothing
  // ⇒ 404). Fail-soft throughout.
  // -------------------------------------------------------------------------
  private async assertOwnsErpApp(
    user: CurrentUser,
    slug: string
  ): Promise<void> {
    if (typeof slug !== 'string' || !APP_SLUG_RE.test(slug)) {
      throw new BadRequest('Invalid app slug');
    }
    const records = await this.readPublishedApps(user.id);
    if (records.some(r => r.slug === slug || r.storeSlug === slug)) {
      return;
    }
    const probe = await this.probeSettings(slug);
    if (probe) {
      throw new ActionForbidden('You do not own this app');
    }
    throw new NotFound('App not found');
  }

  /** Read the caller's published-app records (skips corrupt members). Mirrors
   * the courier readPublishedApps — same key, same tolerant JSON.parse. Never
   * throws (a Redis hiccup → []). */
  private async readPublishedApps(
    ownerId: string
  ): Promise<Array<{ slug: string; storeSlug?: string }>> {
    let raw: string[] = [];
    try {
      const members = await this.redis.smembers(publishedAppsKey(ownerId));
      raw = Array.isArray(members) ? members : [];
    } catch {
      return [];
    }
    const out: Array<{ slug: string; storeSlug?: string }> = [];
    for (const entry of raw) {
      try {
        const rec = JSON.parse(entry) as { slug?: unknown; storeSlug?: unknown };
        if (rec && typeof rec.slug === 'string') {
          const storeSlug =
            typeof rec.storeSlug === 'string' && rec.storeSlug
              ? rec.storeSlug
              : undefined;
          out.push({ slug: rec.slug, ...(storeSlug ? { storeSlug } : {}) });
        }
      } catch {
        // ignore a corrupt member
      }
    }
    return out;
  }

  /** Ownership deny-path probe: does the shop's public `settings` collection hold
   * any record? Byte-identical semantics to the courier probeSettings. Fail-soft:
   * any error → false (deny-path only). */
  private async probeSettings(slug: string): Promise<boolean> {
    const base = (
      process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
    ).replace(/\/+$/, '');
    const url = `${base}/api/v2/apps-data/${slug}/settings?limit=1`;
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return false;
      const data = (await res.json().catch(() => null)) as unknown;
      return Array.isArray(data) && data.length > 0;
    } catch {
      return false;
    }
  }

  /** Read + validate the sealed credential record for (slug, provider); null when
   * unset/corrupt. Never throws. */
  private async readCredRecord(
    slug: string,
    provider: string
  ): Promise<PaymentCredRecord | null> {
    let raw: string | null = null;
    try {
      raw = await this.redis.get(payCredKey(slug, provider));
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw) as Partial<PaymentCredRecord>;
      const secretSealed = str(obj.secretSealed);
      if (!secretSealed) return null;
      const publishableSealed = str(obj.publishableSealed);
      const webhookSecretSealed = str(obj.webhookSecretSealed);
      return {
        provider: str(obj.provider) || provider,
        secretSealed,
        ...(publishableSealed ? { publishableSealed } : {}),
        ...(webhookSecretSealed ? { webhookSecretSealed } : {}),
        ...(isPaymentMode(obj.mode) ? { mode: obj.mode } : {}),
        enabled: obj.enabled === true,
        connectedAt:
          typeof obj.connectedAt === 'number' ? obj.connectedAt : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Unseal the stored record → the plaintext PaymentCredentials, or null when
   * there is no record or the secret can't be opened (tampered / key rotated).
   * The ONLY place a secret is unsealed, strictly AFTER the ownership gate.
   * Never throws; never logs a key.
   */
  private async resolveCreds(
    slug: string,
    provider: PaymentProvider
  ): Promise<PaymentCredentials | null> {
    const rec = await this.readCredRecord(slug, provider.id);
    if (!rec) return null;
    const secretKey = openSecret(rec.secretSealed);
    if (secretKey === null) return null;
    const creds: PaymentCredentials = { secretKey };
    if (rec.publishableSealed) {
      const pub = openSecret(rec.publishableSealed);
      if (pub !== null) creds.publishableKey = pub;
    }
    if (rec.webhookSecretSealed) {
      const whsec = openSecret(rec.webhookSecretSealed);
      if (whsec !== null) creds.webhookSecret = whsec;
    }
    if (rec.mode) creds.mode = rec.mode;
    // A provider that requires a publishable key must have one to operate.
    if (provider.requiresPublishableKey && !creds.publishableKey) return null;
    return creds;
  }

  // =========================================================================
  // POST /api/v1/apps/:slug/payment/:provider/connect
  //   body { secretKey, publishableKey?, webhookSecret?, sandbox? }
  //   → { connected: true, enabled: true, mode?, publishableKey? }
  //
  // The BYO entry point. Owner-gated. Validates the pasted key(s) with a CHEAP
  // live call (provider.validate); a typed error maps to the same passthrough
  // body (invalid_credentials on a 401). Then seal BEFORE store (never persist a
  // half-record) and write the record (90d). NEVER echoes the secret; the Stripe
  // publishable key MAY be echoed (public by design). @Throttle('strict').
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/payment/:provider/connect')
  async connect(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string,
    @Body()
    body: {
      secretKey?: unknown;
      publishableKey?: unknown;
      webhookSecret?: unknown;
      sandbox?: unknown;
    },
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);

    const secretKey = str(body?.secretKey).trim();
    const publishableKey = str(body?.publishableKey).trim();
    const webhookSecret = str(body?.webhookSecret).trim();
    // SlickPay stores the sandbox/prod mode; Stripe ignores it.
    const mode: PaymentMode = body?.sandbox === true ? 'sandbox' : 'prod';

    if (!secretKey) {
      throw new BadRequest('secretKey is required');
    }
    if (provider.requiresPublishableKey && !publishableKey) {
      throw new BadRequest('secretKey and publishableKey are required');
    }
    if (
      secretKey.length > KEY_MAX ||
      publishableKey.length > KEY_MAX ||
      webhookSecret.length > KEY_MAX
    ) {
      throw new BadRequest('credentials too long');
    }

    // (1) Validate with a cheap live call. A typed error (incl. 401
    // invalid_credentials) is surfaced via the passthrough body — never persist
    // unvalidated creds.
    const probeCreds: PaymentCredentials = {
      secretKey,
      ...(publishableKey ? { publishableKey } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
      mode,
    };
    const check = await provider.validate(probeCreds);
    if (!check.ok) {
      writePaymentError(res, check);
      return;
    }

    // (2) Seal BEFORE any store so we never persist a half-record.
    const secretSealed = sealSecret(secretKey);
    if (!secretSealed) {
      res.status(502).json({ error: 'payment_unavailable' });
      return;
    }
    const publishableSealed = publishableKey ? sealSecret(publishableKey) : '';
    const webhookSecretSealed = webhookSecret ? sealSecret(webhookSecret) : '';
    if (
      (publishableKey && !publishableSealed) ||
      (webhookSecret && !webhookSecretSealed)
    ) {
      res.status(502).json({ error: 'payment_unavailable' });
      return;
    }

    // (3) Persist the sealed record (rolling 90d TTL).
    const rec: PaymentCredRecord = {
      provider: provider.id,
      secretSealed,
      ...(publishableSealed ? { publishableSealed } : {}),
      ...(webhookSecretSealed ? { webhookSecretSealed } : {}),
      mode,
      enabled: true,
      connectedAt: Date.now(),
    };
    try {
      await this.redis.set(
        payCredKey(slug, provider.id),
        JSON.stringify(rec),
        'EX',
        CRED_TTL_SECONDS
      );
    } catch {
      res.status(502).json({ error: 'store_unavailable' });
      return;
    }
    // NEVER echo the secret. The publishable key is public by design — return it
    // so the FE can confirm the connected account.
    return {
      connected: true,
      enabled: true,
      mode,
      ...(publishableKey ? { publishableKey } : {}),
    };
  }

  // =========================================================================
  // GET /api/v1/apps/:slug/payment/:provider
  //   → { connected, enabled, mode?, publishableKey? }   (NEVER the secret)
  //   Owner-gated. @Throttle('default', {limit:300, ttl:60000}).
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/payment/:provider')
  async status(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string
  ): Promise<{
    connected: boolean;
    enabled: boolean;
    mode?: PaymentMode;
    publishableKey?: string;
  }> {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);
    const rec = await this.readCredRecord(slug, provider.id);
    if (!rec) {
      return { connected: false, enabled: false };
    }
    // The publishable key is public by design — unseal + return it (never the
    // secret). Unseal failures fall through to "not returned" (no key echoed).
    let publishableKey: string | undefined;
    if (rec.publishableSealed) {
      const pub = openSecret(rec.publishableSealed);
      if (pub) publishableKey = pub;
    }
    return {
      connected: true,
      enabled: rec.enabled,
      ...(rec.mode ? { mode: rec.mode } : {}),
      ...(publishableKey ? { publishableKey } : {}),
    };
  }

  // =========================================================================
  // POST /api/v1/apps/:slug/payment/:provider/disconnect → { ok: true }
  //   Delete the record (idempotent). Owner-gated. @Throttle('strict').
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/payment/:provider/disconnect')
  async disconnect(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string
  ): Promise<{ ok: boolean }> {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);
    try {
      await this.redis.del(payCredKey(slug, provider.id));
    } catch {
      // best-effort — disconnecting a non-connection still returns ok.
    }
    return { ok: true };
  }

  // =========================================================================
  // POST /api/v1/apps/:slug/payment/:provider/checkout
  //   body { orderId, amount, currency?, items?, returnUrl }
  //   → { ok, payUrl, paymentId }
  //
  // Owner-gated + flag-gated. Resolves the sealed creds (only here, after the
  // gate), calls provider.createCheckout, persists a paymentId→orderId reverse
  // map (so status + the webhook correlate), and returns the hosted-payment URL
  // the FE redirects the customer to. Idempotency lock collapses a double-click.
  // @Throttle('strict').
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/payment/:provider/checkout')
  async checkout(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string,
    @Body()
    body: {
      orderId?: unknown;
      amount?: unknown;
      currency?: unknown;
      items?: unknown;
      returnUrl?: unknown;
    },
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);

    const orderId = str(body?.orderId).trim();
    if (!orderId) {
      throw new BadRequest('orderId is required');
    }
    const amount = Math.max(0, Math.round(num(body?.amount)));
    if (amount <= 0) {
      throw new BadRequest('amount must be a positive integer');
    }
    const returnUrl = str(body?.returnUrl).trim();
    if (!/^https?:\/\//i.test(returnUrl)) {
      throw new BadRequest('returnUrl must be an absolute http(s) URL');
    }
    const currency = str(body?.currency).trim().toLowerCase() || 'dzd';
    const items: CheckoutItem[] = Array.isArray(body?.items)
      ? (body.items as unknown[]).slice(0, 100).map(raw => {
          const it = (raw ?? {}) as Record<string, unknown>;
          return {
            name: str(it.name).slice(0, 120) || 'Article',
            price: Math.max(0, Math.round(num(it.price))),
            quantity: Math.max(1, Math.round(num(it.quantity) || 1)),
          };
        })
      : [];

    const creds = await this.resolveCreds(slug, provider);
    if (!creds) {
      throw new BadRequest('not_connected');
    }

    // Idempotency lock (best-effort NX): collapses a concurrent double-click.
    const lockKey = checkoutLockKey(slug, provider.id, orderId);
    try {
      await this.redis.set(lockKey, '1', 'EX', CHECKOUT_LOCK_TTL_SEC, 'NX');
    } catch {
      // fail-soft — a lock hiccup never blocks a checkout.
    }

    const input: CheckoutInput = {
      orderId,
      amount,
      currency,
      items,
      returnUrl,
    };
    const result = await provider.createCheckout(creds, input);
    if (!result.ok) {
      writePaymentError(res, result);
      return;
    }

    // Persist the paymentId→orderId reverse map so status + the webhook can map
    // a gateway payment id back to the merchant's order (best-effort).
    try {
      await this.redis.set(
        payOrderKey(slug, provider.id, result.value.paymentId),
        orderId,
        'EX',
        PAY_ORDER_TTL_SECONDS
      );
    } catch {
      // best-effort — the FE still gets the payUrl + paymentId.
    }

    return {
      ok: true,
      payUrl: result.value.payUrl,
      paymentId: result.value.paymentId,
    };
  }

  // =========================================================================
  // GET /api/v1/apps/:slug/payment/:provider/status/:paymentId
  //   → { status: 'paid' | 'unpaid' | 'pending', orderId? }
  //   Owner-gated. Resolves the sealed creds, calls provider.getPaymentStatus.
  //   @Throttle('default', {limit:300, ttl:60000}).
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/payment/:provider/status/:paymentId')
  async paymentStatus(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string,
    @Param('paymentId') paymentIdParam: string,
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);

    const paymentId = str(paymentIdParam).trim();
    if (!paymentId) {
      throw new BadRequest('paymentId is required');
    }

    const creds = await this.resolveCreds(slug, provider);
    if (!creds) {
      throw new BadRequest('not_connected');
    }

    const result = await provider.getPaymentStatus(creds, paymentId);
    if (!result.ok) {
      writePaymentError(res, result);
      return;
    }
    // Best-effort correlate back to the merchant's order.
    let orderId: string | undefined;
    try {
      const mapped = await this.redis.get(
        payOrderKey(slug, provider.id, paymentId)
      );
      if (mapped) orderId = mapped;
    } catch {
      orderId = undefined;
    }
    return { status: result.value, ...(orderId ? { orderId } : {}) };
  }

  // =========================================================================
  // @Public POST /api/v1/apps/:slug/payment/:provider/webhook
  //   → { ok: true }   (ALWAYS 200 on a bad/unknown signature — never leaks)
  //
  // Signature-verified server-to-server callback. Stripe signs with the
  // Stripe-Signature header (HMAC-SHA256 over the RAW bytes under the merchant's
  // webhook secret) — verified CONSTANT-TIME against req.rawBody (server.ts
  // bootstraps rawBody:true, the SAME field the WhatsApp + chargily webhooks use).
  // SlickPay has no strong webhook ⇒ a provider without verifyWebhook answers a
  // typed 'webhook_unsupported' (the FE re-checks via the status route).
  //
  // We resolve the merchant's SEALED webhook secret WITHOUT an owner session
  // (the webhook has none) by loading the per-(slug,provider) record — the slug
  // is in the URL, and the HMAC over the raw body under the merchant's OWN sealed
  // secret is the authenticator. A wrong/absent signature ⇒ 200 {} (never a leak,
  // never a retry-storm). @Public + @Throttle('strict') like the WA webhook.
  // =========================================================================
  @Public()
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/payment/:provider/webhook')
  async webhook(
    @Param('slug') slug: string,
    @Param('provider') providerParam: string,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ ok: boolean } | void> {
    // Feature off ⇒ ack ok (never reveal the route exists / doesn't).
    if (!this.paymentsEnabled()) {
      return { ok: true };
    }
    if (typeof slug !== 'string' || !APP_SLUG_RE.test(slug)) {
      return { ok: true };
    }
    if (!isPaymentProviderId(providerParam) || !this.providerAllowed(providerParam)) {
      return { ok: true };
    }
    const provider = getPaymentProvider(providerParam);
    if (!provider) {
      return { ok: true };
    }
    // A provider without a strong webhook (SlickPay) → typed unsupported (the FE
    // re-checks status on the return URL). Not a security surface — no secret is
    // touched, so a plain typed body is fine here.
    if (typeof provider.verifyWebhook !== 'function') {
      res.status(400).json({ error: 'webhook_unsupported' });
      return;
    }

    // Load the merchant's SEALED creds by slug (no owner session on a webhook).
    const rec = await this.readCredRecord(slug, provider.id);
    if (!rec) {
      return { ok: true };
    }
    // Unseal only the secret + webhook secret needed to verify (never logged).
    const secretKey = openSecret(rec.secretSealed);
    const webhookSecret = rec.webhookSecretSealed
      ? openSecret(rec.webhookSecretSealed)
      : null;
    if (secretKey === null || !webhookSecret) {
      // No webhook secret stored ⇒ we cannot verify ⇒ ack empty (fail closed on
      // the write, never on the ack). The merchant must add a webhook secret.
      return { ok: true };
    }

    // Verify over the RAW request bytes — a re-stringify of the parsed body can
    // differ byte-for-byte and FALSE-REJECT a legit call.
    const rawBuf = req.rawBody;
    if (!rawBuf || rawBuf.length === 0) {
      return { ok: true };
    }
    const signature = str(req.headers['stripe-signature']);
    const creds: PaymentCredentials = { secretKey, webhookSecret };
    if (rec.mode) creds.mode = rec.mode;
    const event = provider.verifyWebhook(creds, rawBuf, signature);
    if (!event) {
      // Bad/absent signature → 200 {} (indistinguishable from a valid ack).
      return { ok: true };
    }

    // Authenticated event. Correlate the payment id back to the order (best-
    // effort) + re-arm the map TTL. The order paid-state write itself rides the
    // storefront/ERP data path the FE status poll already drives, so the webhook
    // is authoritative for correlation + is intentionally idempotent (a repeat
    // event resolves to the same order + status). We do NOT mutate order data
    // here beyond keeping the reverse map warm (additive, no cross-file writes).
    try {
      const orderId = await this.redis.get(
        payOrderKey(slug, provider.id, event.paymentId)
      );
      if (orderId) {
        await this.redis.set(
          payOrderKey(slug, provider.id, event.paymentId),
          orderId,
          'EX',
          PAY_ORDER_TTL_SECONDS
        );
      }
    } catch {
      // best-effort — a map hiccup never fails the ack.
    }
    return { ok: true };
  }
}
