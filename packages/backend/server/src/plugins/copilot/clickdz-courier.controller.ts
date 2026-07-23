import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

// Typed AFFiNE errors so the global exception filter emits proper status codes
// (a raw @nestjs/common HttpException becomes a generic 500 through the filter —
// see base/nestjs/exception.ts). NotFound is how a gated-OFF route (or an
// unknown provider) reports "feature disabled" as a clean typed 404, the SAME
// stance the sibling agent controllers + the bridge's feature gates take;
// BadRequest carries the 'invalid_credentials' reject on connect; ActionForbidden
// is the typed 403 for the ERP ownership gate (mirrors the bridge). Throttle
// rate-caps the routes exactly as the bridge / telegram controllers do — ALL
// value-imported (lint-nest Gen1: every ctor-param + decorator identifier must
// resolve at boot as a VALUE, per the #73 boot-crash lesson).
import { ActionForbidden, BadRequest, NotFound, Throttle } from '../../base';
// CacheRedis is the @Global ioredis client the bridge/vdz controllers inject for
// per-owner/per-shop records; RedisModule is @Global so injecting it needs no
// module wiring. We use it for (a) the per-owner published-apps set that powers
// the ownership gate and (b) the sealed courier credential record + reference
// cache. Value-imported (ctor param).
import { CacheRedis } from '../../base/redis';
// The global AuthGuard already authenticates these first-party routes (no
// @Public / no bridge token). CurrentUser RECEIVES the already-verified session
// user so the ownership gate can key on identity. Value-imported (decorator).
import { CurrentUser } from '../../core/auth';
// Serrure's authenticated secret box (R10). sealSecret before writing a
// merchant's courier keys to Redis, openSecret after reading (null on any
// tamper/format/missing-key — never throws), secretBoxReady gates the whole
// feature alongside the env flag (we cannot accept a key we can't protect).
import { openSecret, sealSecret, secretBoxReady } from './clickdz-secret-box';
// The pluggable courier core (pure). getCourierProvider resolves the concrete
// impl for a provider id; the shared types + fail-soft CourierResult union flow
// through here. Importing the Yalidine module below both makes it a value-usable
// provider AND runs its self-registration side-effect at boot.
import {
  getCourierProvider,
  isCourierProviderId,
  isCourierReferenceKind,
  type CourierCredentials,
  type CourierError,
  type CourierProvider,
  type CourierReferenceKind,
} from './clickdz-courier';
// Side-effect + value import: loading this module registers the Yalidine
// provider into the core registry (so getCourierProvider('yalidine') resolves).
// Referenced as a value below (a defensive touch) so the import can never be
// tree-shaken to a type-only elision that would skip the registration.
import { yalidineProvider } from './clickdz-courier-yalidine';

// ---------------------------------------------------------------------------
// R17 (PR-A) — COURIER CONTROLLER. Per-merchant BYO courier credentials +
// read/connect routes, behind the CDZ_COURIERS_ENABLED flag (ship-DARK).
//
// Mirrors the Telegram BYOT discipline (connect seals-before-store / status
// NEVER returns the keys / disconnect is idempotent) and the bridge's ERP
// ownership gate (assertOwnsErpApp: readPublishedApps(user.id) → slug/storeSlug
// match, else probe the public settings collection → typed 403/404). It does
// NOT reuse the bridge's PLAINTEXT Chargily storage — courier keys are SEALED.
//
// FLAG (dark): couriersEnabled() = CDZ_COURIERS_ENABLED === '1' && secretBoxReady().
// Unset ⇒ every route throws a typed NotFound, byte-identical to the feature not
// existing (nothing leaks that the routes are there). secretBoxReady() is false
// when CDZ_DATA_SECRET is unset ⇒ we must NOT accept keys we can't seal.
//
// FAIL-SOFT: every provider call returns a typed CourierResult (never throws);
// courierErrorToHttp maps it to a clean passthrough JSON body (429 w/ Retry-After,
// 401→invalid creds, 502 unreachable, …). A courier outage never crashes a route.
//
// MULTI-TENANT ISOLATION: creds are keyed per (slug, provider) and unsealed ONLY
// inside a route already gated by the per-owner ownership check — user Y can
// never read/use user X's shop's courier keys.
//
// NO SDK — plain use of the pure provider; typed errors only; no key is ever
// logged or returned. lint-nest: @Controller with ONE value-imported ctor param
// (CacheRedis).
// ---------------------------------------------------------------------------

// --- Config (read once at module load, same idiom as the sibling controllers).
const CDZ_COURIERS_ENABLED = process.env.CDZ_COURIERS_ENABLED || '';

// Slug shape shared by the whole app (identical to the bridge's APP_SLUG_RE /
// the data API's SLUG_RE). Validated before any Redis/data touch.
const APP_SLUG_RE = /^[a-z0-9-]{3,50}$/;

// Per-owner published-apps set key — BYTE-IDENTICAL to the bridge's
// publishedAppsKey (clickdz:apps:published:{ownerId}); we READ it for the
// ownership gate (never write it). Rolling TTL is owned by the bridge's writes.
const publishedAppsKey = (ownerId: string) =>
  `clickdz:apps:published:${ownerId}`;

// Per-(shop, provider) sealed credential record. New R17 namespace.
const courierCredKey = (slug: string, provider: string) =>
  `clickdz:ship:courier:${slug}:${provider}`;

// Short-TTL reference cache (wilayas/communes/centers) to respect Yalidine's
// 5/s..10k/day limits — reference data changes rarely. Communes/centers are
// per-wilaya, so the wilaya id is folded into the key.
const courierRefKey = (
  provider: string,
  kind: string,
  wilayaId?: number
) =>
  wilayaId !== undefined && wilayaId !== null
    ? `clickdz:ship:georef:${provider}:${kind}:${wilayaId}`
    : `clickdz:ship:georef:${provider}:${kind}`;

// Rolling TTL for a stored credential record — matches the bridge's
// PUBLISHED_APPS_TTL_SECONDS (90d) so a long-lived shop's keys don't outlive its
// data window; re-armed on connect.
const CRED_TTL_SECONDS = 90 * 24 * 60 * 60;
// Reference cache TTL — 6h (reference data is near-static; well within limits).
const REF_TTL_SECONDS = 6 * 60 * 60;

// Belt-and-braces caps on the pasted credentials (defensive; Yalidine's API-ID
// is numeric ≤20 chars and the token is a bounded opaque string).
const API_ID_MAX = 64;
const API_TOKEN_MAX = 512;

// ---------------------------------------------------------------------------
// The sealed per-(shop, provider) credential record persisted at
// courierCredKey. `apiIdSealed`/`apiTokenSealed` are Serrure-sealed (NEVER the
// plaintext); `provider` self-describes the row; `enabled` toggles use;
// `connectedAt` stamps the connect. `status` returns ONLY {connected, enabled}
// — the sealed fields NEVER leave the server.
// ---------------------------------------------------------------------------
export interface CourierCredRecord {
  provider: string;
  apiIdSealed: string;
  apiTokenSealed: string;
  enabled: boolean;
  connectedAt: number;
}

/** Loose string read for schemaless bodies: null/undefined → ''. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * Map a fail-soft CourierError → this surface's typed JSON body via the
 * passthrough res (a raw HttpException would be coerced to a 500 by the global
 * filter). NEVER carries secret material. A 429 re-emits Retry-After. Kept as a
 * plain writer (not a thrown typed error) so the exact upstream status/Retry
 * hints survive to the client.
 */
function writeCourierError(res: Response, err: CourierError): void {
  switch (err.error) {
    case 'rate_limited': {
      if (typeof err.retryAfter === 'number') {
        res.header('Retry-After', String(err.retryAfter));
      }
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    case 'unauthorized':
      // The merchant's creds were rejected by the courier (or absent). 400 so
      // the FE prompts a re-connect; we do NOT leak which of id/token was wrong.
      res.status(400).json({ error: 'invalid_credentials' });
      return;
    case 'not_found':
      res.status(404).json({ error: 'not_found' });
      return;
    case 'bad_request':
      res.status(400).json({ error: 'bad_request' });
      return;
    case 'unreachable':
      res.status(502).json({ error: 'courier_unreachable' });
      return;
    case 'malformed':
      res.status(502).json({ error: 'courier_bad_response' });
      return;
    case 'upstream_error':
    default:
      res
        .status(502)
        .json({
          error: 'courier_error',
          ...(typeof err.status === 'number' ? { status: err.status } : {}),
        });
      return;
  }
}

@Controller()
export class ClickDzCourierController {
  // CacheRedis for BOTH the per-owner published-apps set (ownership gate) and
  // the sealed courier records + reference cache. @Global provider ⇒ no module
  // wiring. Same injection style as clickdz-bridge.controller.ts.
  constructor(private readonly redis: CacheRedis) {
    // Defensive value-touch of the Yalidine provider so its self-registration
    // import is never elided; the registry lookup below is the real path.
    void yalidineProvider;
  }

  // -------------------------------------------------------------------------
  // FEATURE GATE. Both the env flag AND a usable secret box are required:
  // without CDZ_DATA_SECRET we cannot seal a merchant's courier keys, so we must
  // NOT accept them — the whole feature stays dark (typed 404) rather than
  // storing keys we can't protect. Identical stance to Telegram's
  // channelsEnabled(). Off ⇒ every route 404s.
  // -------------------------------------------------------------------------
  private couriersEnabled(): boolean {
    return CDZ_COURIERS_ENABLED === '1' && secretBoxReady();
  }

  /** Typed 404 when the feature is off — never leaks that the route exists. */
  private assertEnabled(): void {
    if (!this.couriersEnabled()) {
      throw new NotFound('Courier integration is not enabled');
    }
  }

  /**
   * Resolve the :provider path segment to a concrete CourierProvider, or throw a
   * typed NotFound. An unknown/unimplemented provider (e.g. zrexpress/maystro
   * until PR-D) 404s — byte-identical to the route not existing for that
   * provider. The credential record's key is per-provider, so this also scopes
   * the record namespace.
   */
  private resolveProviderOr404(provider: string): CourierProvider {
    if (!isCourierProviderId(provider)) {
      throw new NotFound(`unknown courier provider "${provider}"`);
    }
    const impl = getCourierProvider(provider);
    if (!impl) {
      throw new NotFound(`courier provider "${provider}" is not available`);
    }
    return impl;
  }

  // -------------------------------------------------------------------------
  // OWNERSHIP GATE — replicates the bridge's private assertOwnsErpApp VERBATIM
  // (it is not exported): the :slug must belong to the CALLER. Reuses the exact
  // /apps/mine mechanism (readPublishedApps → a record whose `slug` OR paired
  // `storeSlug` matches proves ownership). Not-owner (403) vs unknown (404)
  // without a global slug registry: the per-slug settings collection is publicly
  // readable, so probing it leaks nothing new — data present ⇒ the namespace
  // belongs to SOMEONE (just not the caller) ⇒ 403; nothing at all (or data API
  // down) ⇒ 404. Fail-soft throughout.
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

  /**
   * Read the caller's published-app records from the per-owner Redis set
   * (skips corrupt members). Mirrors the bridge's readPublishedApps — same key,
   * same tolerant JSON.parse, same {slug, storeSlug} fields we need for the gate.
   * Never throws (a Redis hiccup → []).
   */
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
        const rec = JSON.parse(entry) as {
          slug?: unknown;
          storeSlug?: unknown;
        };
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

  /**
   * Ownership deny-path probe: does the shop's public `settings` collection hold
   * any record? A live shop seeds its settings singleton on first load, so data
   * present ⇒ the namespace belongs to SOMEONE (⇒ 403 not-owner); nothing (or
   * the data API is unreachable) ⇒ treat as unknown (⇒ 404). Byte-identical
   * semantics to the bridge's `erpList(slug,'settings')` probe. Fail-soft: any
   * error → false (deny-path only, so a false here can never grant access).
   */
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

  /**
   * Read + validate the sealed credential record for (slug, provider); null when
   * unset/corrupt. Never throws.
   */
  private async readCredRecord(
    slug: string,
    provider: string
  ): Promise<CourierCredRecord | null> {
    let raw: string | null = null;
    try {
      raw = await this.redis.get(courierCredKey(slug, provider));
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw) as Partial<CourierCredRecord>;
      const apiIdSealed = str(obj.apiIdSealed);
      const apiTokenSealed = str(obj.apiTokenSealed);
      if (!apiIdSealed || !apiTokenSealed) return null;
      return {
        provider: str(obj.provider) || provider,
        apiIdSealed,
        apiTokenSealed,
        enabled: obj.enabled === true,
        connectedAt:
          typeof obj.connectedAt === 'number' ? obj.connectedAt : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Unseal the stored record → the plaintext CourierCredentials, or null when
   * there is no record or a seal can't be opened (tampered / key rotated). This
   * is the ONLY place creds are unsealed, and it happens strictly AFTER the
   * ownership gate. Never throws; never logs the keys.
   */
  private async resolveCreds(
    slug: string,
    provider: string
  ): Promise<CourierCredentials | null> {
    const rec = await this.readCredRecord(slug, provider);
    if (!rec) return null;
    const apiId = openSecret(rec.apiIdSealed);
    const apiToken = openSecret(rec.apiTokenSealed);
    if (!apiId || !apiToken) return null;
    return { apiId, apiToken };
  }

  // =========================================================================
  // POST /api/v1/apps/:slug/courier/:provider/connect  { apiId, apiToken }
  //   → { connected: true, enabled: true }
  //
  // The BYO entry point. Owner-gated. Validates the pasted keys with a CHEAP
  // live call (listWilayas — the documented "test connection"); a typed courier
  // error maps to the same passthrough body (invalid_credentials on a 401).
  // Then seal BEFORE store (so we never persist a half-record) and write the
  // record (90d). NEVER echoes the keys. @Throttle('strict').
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/courier/:provider/connect')
  async connect(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string,
    @Body() body: { apiId?: unknown; apiToken?: unknown },
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);

    const apiId = str(body?.apiId).trim();
    const apiToken = str(body?.apiToken).trim();
    if (!apiId || !apiToken) {
      throw new BadRequest('apiId and apiToken are required');
    }
    if (apiId.length > API_ID_MAX || apiToken.length > API_TOKEN_MAX) {
      throw new BadRequest('credentials too long');
    }

    // (1) Validate the creds with a cheap live reference call. A typed error
    // (incl. 401 invalid_credentials) is surfaced via the passthrough body —
    // we never persist unvalidated creds.
    const creds: CourierCredentials = { apiId, apiToken };
    const check = await provider.listWilayas(creds);
    if (!check.ok) {
      writeCourierError(res, check);
      return;
    }

    // (2) Seal BEFORE any store so we never persist a half-record. secretBoxReady
    // gated us in, so a null here is an unexpected transient → soft 502.
    const apiIdSealed = sealSecret(apiId);
    const apiTokenSealed = sealSecret(apiToken);
    if (!apiIdSealed || !apiTokenSealed) {
      res.status(502).json({ error: 'courier_unavailable' });
      return;
    }

    // (3) Persist the sealed record (rolling 90d TTL).
    const rec: CourierCredRecord = {
      provider: provider.id,
      apiIdSealed,
      apiTokenSealed,
      enabled: true,
      connectedAt: Date.now(),
    };
    try {
      await this.redis.set(
        courierCredKey(slug, provider.id),
        JSON.stringify(rec),
        'EX',
        CRED_TTL_SECONDS
      );
    } catch {
      res.status(502).json({ error: 'store_unavailable' });
      return;
    }
    // NEVER log or echo the keys — connected state only.
    return { connected: true, enabled: true };
  }

  // =========================================================================
  // GET /api/v1/apps/:slug/courier/:provider → { connected, enabled }
  //   NEVER the keys. Owner-gated. @Throttle('default', {limit:300, ttl:60000}).
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/courier/:provider')
  async status(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string
  ): Promise<{ connected: boolean; enabled: boolean }> {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);
    const rec = await this.readCredRecord(slug, provider.id);
    if (!rec) {
      return { connected: false, enabled: false };
    }
    // Return ONLY non-secret state. The sealed keys NEVER leave the server.
    return { connected: true, enabled: rec.enabled };
  }

  // =========================================================================
  // POST /api/v1/apps/:slug/courier/:provider/disconnect → { ok: true }
  //   Delete the record (idempotent). Owner-gated. @Throttle('strict').
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/courier/:provider/disconnect')
  async disconnect(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string
  ): Promise<{ ok: boolean }> {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);
    try {
      await this.redis.del(courierCredKey(slug, provider.id));
    } catch {
      // best-effort — disconnecting a non-connection still returns ok.
    }
    return { ok: true };
  }

  // =========================================================================
  // GET /api/v1/apps/:slug/courier/:provider/fees?to_wilaya=&from_wilaya=
  //   → computeFees (resolves sealed creds). Owner-gated.
  //   @Throttle('default', {limit:300, ttl:60000}).
  //
  // from_wilaya is optional; when omitted we cannot infer a pickup wilaya in
  // PR-A (the merchant's pickup wilaya lands with the ERP tab in PR-C), so a
  // missing/!numeric from_wilaya is a typed 400.
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/courier/:provider/fees')
  async fees(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string,
    @Query('to_wilaya') toWilayaRaw: string,
    @Query('from_wilaya') fromWilayaRaw: string,
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);

    const toWilaya = Number(str(toWilayaRaw).trim());
    const fromWilaya = Number(str(fromWilayaRaw).trim());
    if (
      !Number.isInteger(toWilaya) ||
      toWilaya <= 0 ||
      !Number.isInteger(fromWilaya) ||
      fromWilaya <= 0
    ) {
      throw new BadRequest('from_wilaya and to_wilaya are required (numeric)');
    }

    const creds = await this.resolveCreds(slug, provider.id);
    if (!creds) {
      // No usable connection — typed 400 so the FE prompts a (re)connect. Does
      // not distinguish "never connected" from "seal unreadable" (both = fix by
      // reconnecting) and leaks nothing about the keys.
      throw new BadRequest('not_connected');
    }

    const result = await provider.computeFees(creds, fromWilaya, toWilaya);
    if (!result.ok) {
      writeCourierError(res, result);
      return;
    }
    return { fees: result.value };
  }

  // =========================================================================
  // GET /api/v1/apps/:slug/courier/:provider/reference?kind=wilayas|communes|
  //     centers[&wilaya_id=]
  //   → reference lists (cache-friendly). Owner-gated.
  //   @Throttle('default', {limit:300, ttl:60000}).
  //
  // Cached in Redis short-TTL (6h) to respect Yalidine's 5/s..10k/day limits —
  // reference data is near-static. communes/centers require a numeric wilaya_id;
  // wilayas takes none. The cache is keyed per (provider, kind, wilayaId) and is
  // NOT tenant-specific because reference data is identical across merchants for
  // a given courier — but it is only ever SERVED to an owner-gated caller with a
  // live connection (we resolve creds first), so an unauthenticated party can't
  // warm or read it.
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/courier/:provider/reference')
  async reference(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string,
    @Query('kind') kindRaw: string,
    @Query('wilaya_id') wilayaIdRaw: string,
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);

    const kind = str(kindRaw).trim();
    if (!isCourierReferenceKind(kind)) {
      throw new BadRequest('kind must be one of wilayas|communes|centers');
    }
    // communes + centers are per-wilaya and REQUIRE a numeric wilaya_id.
    let wilayaId: number | undefined;
    if (kind === 'communes' || kind === 'centers') {
      const w = Number(str(wilayaIdRaw).trim());
      if (!Number.isInteger(w) || w <= 0) {
        throw new BadRequest('wilaya_id is required (numeric) for this kind');
      }
      wilayaId = w;
    }

    // Serve from the short-TTL cache when warm (reference data is near-static).
    const cacheKey = courierRefKey(provider.id, kind, wilayaId);
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as unknown;
        if (Array.isArray(parsed)) {
          return { kind, items: parsed, cached: true };
        }
      }
    } catch {
      // ignore a cache miss/corruption — fall through to a live fetch
    }

    // Cold: need a live connection to fetch from the courier.
    const creds = await this.resolveCreds(slug, provider.id);
    if (!creds) {
      throw new BadRequest('not_connected');
    }

    const result = await this.fetchReference(provider, creds, kind, wilayaId);
    if (!result.ok) {
      writeCourierError(res, result);
      return;
    }
    // Warm the cache (best-effort — a store failure must not fail the read).
    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(result.value),
        'EX',
        REF_TTL_SECONDS
      );
    } catch {
      // best-effort
    }
    return { kind, items: result.value, cached: false };
  }

  /**
   * Dispatch a reference `kind` to the right provider method. Returns the
   * fail-soft CourierResult unchanged (the caller maps errors). `items` is
   * typed loosely (the three kinds return different row shapes) — the FE keys
   * off `kind`.
   */
  private async fetchReference(
    provider: CourierProvider,
    creds: CourierCredentials,
    kind: CourierReferenceKind,
    wilayaId: number | undefined
  ) {
    if (kind === 'wilayas') {
      return provider.listWilayas(creds);
    }
    if (kind === 'communes') {
      return provider.listCommunes(creds, wilayaId as number);
    }
    return provider.listCenters(creds, wilayaId as number);
  }
}
