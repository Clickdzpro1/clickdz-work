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
  courierStatusToTracking,
  getCourierProvider,
  isCourierProviderId,
  isCourierReferenceKind,
  isCourierStatus,
  type CourierCredentials,
  type CourierError,
  type CourierProvider,
  type CourierReferenceKind,
  type CourierStatus,
  type ParcelInput,
} from './clickdz-courier';
// Side-effect + value import: loading a provider module registers it into the
// core registry (so getCourierProvider(id) resolves). Referenced as a value in
// the constructor (a defensive touch) so the import can never be tree-shaken to
// a type-only elision that would skip the registration. Yalidine is LIVE; the
// R17-PR-D providers are registered too but gated OFF per-provider (see
// providerAllowed) so they 404 until their CDZ_COURIER_<ID> flag is set.
import { yalidineProvider } from './clickdz-courier-yalidine';
import { zrexpressProvider } from './clickdz-courier-zrexpress';
import { maystroProvider } from './clickdz-courier-maystro';
import { noestProvider } from './clickdz-courier-noest';
import { ecotrackProvider } from './clickdz-courier-ecotrack';
// R17 PR-B — the per-slug Data API write token (HMAC of `appdata:{slug}`). The
// SAME token the bridge re-derives for every ERP write; '' when the deploy has
// no CDZ_DATA_SECRET (⇒ admin writes unavailable, typed 501). Value-imported.
import { dataWriteToken } from './cdz-data-token';
// R17 PR-B — pure shipping logic (framework-free, no Nest deps). We reuse
// Shipping.buildTrackingPatch + its status literals so the courier tracking sync
// advances an order's canonical `status` BYTE-IDENTICALLY to the bridge's
// erpOrderTracking PUT path (one source of truth for tracking→status).
import * as Shipping from './clickdz-erp-shipping';
// R17 PR-B — pure caisse logic (framework-free). THE CAISSE FIX: on a courier-
// driven delivery we call the SAME pending-COD builder + idempotency guard the
// bridge's erpOrderStatus uses (buildPendingCodEntry / hasPendingCodMarker), so
// courier-delivered COD is NOT silently missed at day-close/reconcile. The
// tracking path does not otherwise fire this — that is exactly the gap R17 closes.
import {
  buildPendingCodEntry,
  caisseStr,
  hasPendingCodMarker,
  pendingCodMarkerPartitions,
  type CaisseRecord,
} from './clickdz-erp-caisse';

// ---------------------------------------------------------------------------
// R17 — COURIER CONTROLLER. Per-merchant BYO courier credentials + the courier
// ORDER LIFECYCLE, behind the CDZ_COURIERS_ENABLED flag (ship-DARK).
//
//   PR-A (merged): connect / status / disconnect / fees / reference routes +
//   the sealed per-(slug,provider) credential store + resolveCreds + the
//   ownership gate. Unchanged below.
//
//   PR-B (this change): the order lifecycle —
//     • ship   POST …/courier/:provider/ship {orderId} — turn a paid order into
//              a real courier parcel (provider.createParcel), then persist
//              {courierProvider, trackingNumber, labelUrl, courierStatus:'pending',
//              shippedAt} onto the ORDER record via the data API (PUT-by-id).
//              Idempotent: an order that already has a trackingNumber returns it
//              (never double-creates a parcel).
//     • sync   POST …/courier/:provider/sync {orderId?} — poll provider.trackParcel
//              → normalizeStatus → advance the order's courierStatus AND its
//              canonical ERP `status` via Shipping.buildTrackingPatch. Bounded
//              (≤ SYNC_MAX orders/call) + fail-soft PER order. With `orderId`,
//              refreshes exactly one order.
//     • refresh POST …/courier/:provider/ship/:orderId/refresh — single-order
//              convenience alias that folds into the same sync-one path.
//
//   ⚠️ THE CAISSE FIX: when the sync moves an order to DELIVERED it calls the
//   SAME pending-COD caisse write erpOrderStatus does (buildPendingCodEntry,
//   idempotent via hasPendingCodMarker) — the tracking/PUT path does NOT fire it
//   on its own, so courier-delivered COD would otherwise silently miss day-close.
//
// Mirrors the Telegram BYOT discipline (connect seals-before-store / status
// NEVER returns the keys / disconnect is idempotent) and the bridge's ERP
// ownership gate (assertOwnsErpApp) + its Data-API I/O (erpList/erpPutRecord/
// erpCreateRecord idiom, re-derived per-slug dataWriteToken, 15s timeout, the
// externalBase data URL). It does NOT reuse the bridge's PLAINTEXT Chargily
// storage — courier keys are SEALED.
//
// FLAG (dark): couriersEnabled() = CDZ_COURIERS_ENABLED === '1' && secretBoxReady().
// Unset ⇒ every route throws a typed NotFound, byte-identical to the feature not
// existing (nothing leaks that the routes are there). secretBoxReady() is false
// when CDZ_DATA_SECRET is unset ⇒ we must NOT accept keys we can't seal.
//
// FAIL-SOFT: every provider call returns a typed CourierResult (never throws);
// writeCourierError maps it to a clean passthrough JSON body (429 w/ Retry-After,
// 401→invalid creds, 502 unreachable, …). A courier OR caisse hiccup never
// crashes a route, 500s, or regresses the order — the parcel/tracking write and
// the caisse marker are each independently fail-soft.
//
// MULTI-TENANT ISOLATION: creds are keyed per (slug, provider) and unsealed ONLY
// inside a route already gated by the per-owner ownership check — user Y can
// never read/use user X's shop's courier keys, and every order read/write is
// scoped to the gated slug's data namespace.
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

// -------------------------------------------------------------------------
// SHIP IDEMPOTENCY (Waybill F-2). Creating a parcel at the courier is the one
// IRREVERSIBLE side effect in this controller (a COD-dominant market → a
// duplicate parcel = a duplicate delivery + double cash to collect). Two keys
// harden it beyond the order's own `trackingNumber`:
//
//  • shipLockKey — a short-lived NX lock per (slug, order) held across the
//    create+persist critical section. Closes the TOCTOU where two concurrent
//    ship calls both read an empty trackingNumber and both create a parcel.
//  • shipOrphanKey — when the parcel WAS created but persisting the tracking
//    onto the order failed (data-API hiccup), we stash the tracking here so a
//    later re-ship SHORT-CIRCUITS to it instead of creating a second parcel.
//    Longer TTL than the lock (the order may stay un-persisted for a while);
//    cleared on a successful persist.
// Both are keyed by the order's server id (recId), the same id the tracking is
// persisted under. Fail-soft: a Redis hiccup on either never blocks a ship.
// -------------------------------------------------------------------------
const shipLockKey = (slug: string, provider: string, recId: string) =>
  `clickdz:ship:lock:${slug}:${provider}:${recId}`;
const shipOrphanKey = (slug: string, provider: string, recId: string) =>
  `clickdz:ship:orphan:${slug}:${provider}:${recId}`;
// Lock TTL: comfortably longer than one create+persist round-trip (provider
// 15s abort + a data write) yet short enough to auto-heal a crashed holder.
const SHIP_LOCK_TTL_SEC = 45;
// Orphan TTL: the window in which a re-ship should reuse a created-but-unsaved
// tracking rather than re-create. 24h is ample for a merchant to retry.
const SHIP_ORPHAN_TTL_SEC = 24 * 60 * 60;

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
// R17 PR-B — Data-API I/O config, BYTE-IDENTICAL to the bridge's constants so
// the courier lifecycle reads/writes the SAME per-slug order datastore the
// storefront + ERP + bridge use. (The courier controller is a SEPARATE Nest
// controller from the bridge; the bridge's helpers are private, so we replicate
// the tiny amount of I/O plumbing we need here rather than couple the two.)
// ---------------------------------------------------------------------------

// Per-request timeout for a Data-API call (matches bridge ERP_DATA_TIMEOUT_MS).
const ERP_DATA_TIMEOUT_MS = 15_000;
// Stay under the data API's 8KB/record cap WITH headroom for the id/createdAt it
// appends (matches bridge ERP_MAX_WRITE_BYTES) — checked BEFORE any order write.
const ERP_MAX_WRITE_BYTES = 8 * 1024 - 128;
// The delivered ERP order status (French) — the one that owes a COD marker. The
// exact literal the shop template + bridge use (Shipping.ORDER_STATUSES[3]).
const ORDER_STATUS_DELIVERED = 'Livrée';
// The returned ERP order status (French) — the other TERMINAL canonical status
// (Shipping.ORDER_STATUSES[4]). Used with ORDER_STATUS_DELIVERED to detect an
// order a human already settled via the Commandes tab (erpOrderStatus advances
// the canonical `status` but does NOT set `courierStatus`), so a later courier
// poll must not regress it (Waybill F-3).
const ORDER_STATUS_RETURNED = 'Retournée';
// Bounded fan-out for a batch sync: cap how many non-terminal parcels we poll in
// one call (each is a live provider round-trip + a data write) so one call can
// never burst Yalidine's 5/s..10k/day limits or run unbounded. A merchant with
// more open parcels just calls sync again (it resumes from the still-open ones).
const SYNC_MAX = 50;

// ---------------------------------------------------------------------------
// R17 PR-B — loose schemaless readers for order records (mirror the bridge's
// erpStr/erpNum so this controller stays dependency-free). `erpRec` is the
// data-API record shape.
// ---------------------------------------------------------------------------
type ErpRecord = Record<string, unknown>;

/** Number(v); non-finite → 0 (mirrors the bridge's erpNum). */
function num(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Extract the FRENCH wilaya name Yalidine's create-by-name endpoint wants from
 * an order's stored `wilaya` value. Storefront stores it as `"16 - Alger"`
 * (numeric code + " - " + French name); Yalidine takes the name. Strips a
 * leading `"NN - "` / `"NN-"` code prefix; returns the trimmed remainder (or the
 * whole trimmed string when there is no code prefix). Pure + total.
 */
function wilayaNameOf(raw: unknown): string {
  const s = (typeof raw === 'string' ? raw : raw == null ? '' : String(raw)).trim();
  // Sentinel F-2: a bare code with no name ("16", "16 - ") has no wilaya NAME —
  // return '' so the caller emits a typed 400 rather than a greedy mis-parse
  // ("16" → "6"). Only strip the "NN - " prefix when a real name follows.
  if (/^\d{1,3}\s*[-–—]?\s*$/.test(s)) return '';
  // "16 - Alger" | "16-Alger" | "16 Alger" → "Alger"; "Alger" → "Alger".
  // (bare-code cases already returned '' above, so the greedy tail is safe now.)
  const m = s.match(/^\s*\d{1,3}\s*[-–—]?\s*(.+)$/);
  return (m ? m[1] : s).trim();
}

/**
 * Split a storefront `customer` full-name string into Yalidine's firstname +
 * familyname. First whitespace token → firstname; the rest → familyname. A
 * single token is used for BOTH (Yalidine rejects an empty familyname). Pure.
 */
function splitName(full: unknown): { firstname: string; familyname: string } {
  const s = (typeof full === 'string' ? full : full == null ? '' : String(full))
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { firstname: '', familyname: '' };
  const sp = s.indexOf(' ');
  if (sp < 0) return { firstname: s, familyname: s };
  return { firstname: s.slice(0, sp), familyname: s.slice(sp + 1) };
}

/**
 * Order total = stored `total`, else Σ item price×qty (qty ?? 1) — byte-identical
 * to the bridge's erpOrderTotal AND caisse's caisseOrderTotal, so the COD amount
 * we hand the courier is exactly what caisse day-close later expects to reconcile.
 */
function orderTotal(o: ErpRecord): number {
  if (o.total != null && Number.isFinite(Number(o.total))) return num(o.total);
  const items = Array.isArray(o.items) ? (o.items as unknown[]) : [];
  return items.reduce<number>((sum, raw) => {
    const it = (raw ?? {}) as ErpRecord;
    return sum + num(it.price) * num(it.qty != null ? it.qty : 1);
  }, 0);
}

/**
 * A short, human-readable product description for the courier's product_list,
 * built from the order items ("2× Écouteurs, 1× Chargeur"). Capped so the parcel
 * payload stays small; falls back to the order ref when there are no items.
 */
function productListOf(o: ErpRecord): string {
  const items = Array.isArray(o.items) ? (o.items as unknown[]) : [];
  const parts: string[] = [];
  for (const raw of items) {
    const it = (raw ?? {}) as ErpRecord;
    const title =
      (typeof it.title === 'string' && it.title.trim()) ||
      (typeof it.name === 'string' && it.name.trim()) ||
      'Produit';
    const qty = num(it.qty != null ? it.qty : 1) || 1;
    parts.push(`${qty}× ${title}`);
    if (parts.join(', ').length > 200) break;
  }
  const desc = parts.join(', ').slice(0, 240);
  return desc || `Commande ${typeof o.ref === 'string' ? o.ref : ''}`.trim();
}

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

/**
 * R17 PR-B — the outcome of syncing ONE order's tracking (the shared result of
 * syncOneOrder, aggregated by the batch sync + returned by refresh). A closed
 * set of typed outcomes so a caller never has to interpret a free-form string.
 */
type SyncOutcome =
  | 'updated'
  | 'unchanged'
  | 'no_tracking'
  | 'terminal'
  | 'courier_error'
  | 'write_failed';
interface SyncOneResult {
  orderId: string;
  outcome: SyncOutcome;
  courierStatus?: CourierStatus;
  delivered?: boolean;
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
    // Defensive value-touch of every provider so its self-registration import is
    // never elided; the registry lookup below is the real path. Yalidine is LIVE;
    // the rest are registered-but-dark (providerAllowed gates them).
    void yalidineProvider;
    void zrexpressProvider;
    void maystroProvider;
    void noestProvider;
    void ecotrackProvider;
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
   * typed NotFound. An unknown provider, or a registered-but-DARK one (its
   * per-provider flag is off), 404s — byte-identical to the route not existing
   * for that provider. The credential record's key is per-provider, so this also
   * scopes the record namespace.
   */
  private resolveProviderOr404(provider: string): CourierProvider {
    if (!isCourierProviderId(provider)) {
      throw new NotFound(`unknown courier provider "${provider}"`);
    }
    if (!this.providerAllowed(provider)) {
      // Registered but dark → 404 (same body as unregistered): never reveals
      // that an un-flagged provider exists. Enabling = a flag flip, not a deploy.
      throw new NotFound(`courier provider "${provider}" is not available`);
    }
    const impl = getCourierProvider(provider);
    if (!impl) {
      throw new NotFound(`courier provider "${provider}" is not available`);
    }
    return impl;
  }

  /**
   * Per-provider DARK gate (R17-PR-D). Yalidine is grandfathered ON — it went
   * live in R17 under CDZ_COURIERS_ENABLED alone, so its live behavior is
   * byte-unchanged. Every PR-D provider (zrexpress/maystro/noest/ecotrack)
   * requires its OWN `CDZ_COURIER_<ID>=1` flag, so each ships dark until its BYO
   * creds are validated against the live API; an un-flagged provider is a typed
   * 404, identical to being unregistered. Read from env each call so a flag
   * flips a provider live WITHOUT a code change (matches the house '1' idiom).
   */
  private providerAllowed(id: CourierProviderId): boolean {
    if (id === 'yalidine') return true;
    return (process.env[`CDZ_COURIER_${id.toUpperCase()}`] || '') === '1';
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
    provider: CourierProvider
  ): Promise<CourierCredentials | null> {
    const rec = await this.readCredRecord(slug, provider.id);
    if (!rec) return null;
    const apiId = openSecret(rec.apiIdSealed);
    const apiToken = openSecret(rec.apiTokenSealed);
    // apiToken is ALWAYS required. apiId is required only for providers that
    // declare it (requiresApiId) — a token-only provider (Maystro) sealed an
    // empty apiId at connect, so openSecret returns '' here, which is valid.
    // openSecret returns null only on a real unseal failure (tampered / rotated
    // key); '' vs null are distinct, so we test for null explicitly.
    if (apiToken === null) return null;
    if (provider.requiresApiId && !apiId) return null;
    return { apiId: apiId ?? '', apiToken };
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
    // apiToken is always required. apiId is required only for providers that
    // declare requiresApiId (Yalidine/ZR/NOEST id+token; Ecotrack host+token).
    // A token-only provider (Maystro) connects with just the token — apiId may
    // be blank and is sealed as '' so the record shape stays uniform.
    if (!apiToken || (provider.requiresApiId && !apiId)) {
      throw new BadRequest(
        provider.requiresApiId
          ? 'apiId and apiToken are required'
          : 'apiToken is required'
      );
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

    const creds = await this.resolveCreds(slug, provider);
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
    const creds = await this.resolveCreds(slug, provider);
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

  // =========================================================================
  // R17 PR-B — DATA-API I/O. The per-slug order datastore, reached with the
  // SAME primitives the bridge uses (re-derived dataWriteToken, 15s timeout,
  // the externalBase data URL). Every method is FAIL-SOFT: a data-API hiccup
  // returns null / {ok:false}, never throws, and never logs the token. These
  // are only ever called from a route already past assertOwnsErpApp, so the
  // slug's namespace is the caller's.
  // =========================================================================

  /**
   * Absolute per-slug Data API base — BYTE-IDENTICAL to the bridge's
   * erpDataBase, so the courier lifecycle and the storefront/ERP/bridge all hit
   * the one shared datastore for this shop.
   */
  private erpDataBase(slug: string): string {
    const externalBase = (
      process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
    ).replace(/\/+$/, '');
    return `${externalBase}/api/v2/apps-data/${slug}`;
  }

  /**
   * GET the whole `orders` collection (≤500, newest-first — the data API's own
   * sort/cap). null when the data API is unreachable / non-2xx / malformed;
   * callers map that to a typed 502. Never throws.
   */
  private async erpListOrders(slug: string): Promise<ErpRecord[] | null> {
    // SEC-2: carry the per-slug token on internal reads. `orders` is one of the
    // PII-bearing collections the read gate protects, so once
    // CDZ_DATA_READ_GATE is on, an unauthenticated read here would 401 and the
    // whole courier lifecycle (ship, track, sync, COD reconcile) would break.
    // Harmless while the gate is off — the @Public GET ignores a header it does
    // not need — so this ships safely ahead of the flag. Never logged.
    const token = dataWriteToken(slug);
    const res = await fetch(`${this.erpDataBase(slug)}/orders?limit=500`, {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(ERP_DATA_TIMEOUT_MS),
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const data = (await res.json().catch(() => null)) as unknown;
    return Array.isArray(data) ? (data as ErpRecord[]) : null;
  }

  /**
   * GET one collection's rows (used by the caisse-marker dedupe read). Same
   * fail-soft contract as erpListOrders. null on any failure.
   */
  private async erpListCollection(
    slug: string,
    collection: string
  ): Promise<ErpRecord[] | null> {
    // SEC-2: same reasoning as erpListOrders — this reads caisse partitions for
    // the pending-COD marker dedupe, and `caisse` is read-gate protected.
    const token = dataWriteToken(slug);
    const res = await fetch(
      `${this.erpDataBase(slug)}/${collection}?limit=500`,
      {
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(ERP_DATA_TIMEOUT_MS),
      }
    ).catch(() => null);
    if (!res || !res.ok) return null;
    const data = (await res.json().catch(() => null)) as unknown;
    return Array.isArray(data) ? (data as ErpRecord[]) : null;
  }

  /**
   * PUT one order IN PLACE via the data API's atomic v2 PUT-by-id upsert, using
   * the re-derived per-slug write token. Preserves the record's id + createdAt
   * (the storefront/ERP reference an order by its server id, so ship/sync must
   * NOT delete+recreate). {ok:false,status} on failure (status 0 = unreachable).
   * NEVER logs the token.
   */
  private async erpPutRecord(
    slug: string,
    collection: string,
    id: string,
    record: ErpRecord,
    token: string
  ): Promise<{ ok: true; record: ErpRecord } | { ok: false; status: number }> {
    const res = await fetch(
      `${this.erpDataBase(slug)}/${collection}/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(ERP_DATA_TIMEOUT_MS),
      }
    ).catch(() => null);
    if (!res || !res.ok) {
      return { ok: false, status: res ? res.status : 0 };
    }
    const saved = (await res.json().catch(() => null)) as ErpRecord | null;
    return { ok: true, record: saved ?? record };
  }

  /**
   * POST one record with the per-slug write token (used ONLY for the caisse
   * pending-COD marker). {ok:false,status} on failure. NEVER logs the token.
   */
  private async erpCreateRecord(
    slug: string,
    collection: string,
    record: ErpRecord,
    token: string
  ): Promise<{ ok: true; record: ErpRecord } | { ok: false; status: number }> {
    const res = await fetch(`${this.erpDataBase(slug)}/${collection}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(ERP_DATA_TIMEOUT_MS),
    }).catch(() => null);
    if (!res || !res.ok) {
      return { ok: false, status: res ? res.status : 0 };
    }
    const created = (await res.json().catch(() => null)) as ErpRecord | null;
    return { ok: true, record: created ?? record };
  }

  // =========================================================================
  // R17 PR-B — ⚠️ THE CAISSE FIX. Replicates the bridge's private
  // erpWritePendingCod EXACTLY (same pure buildPendingCodEntry builder, same
  // hasPendingCodMarker idempotency guard, same fail-soft swallow). Called from
  // the sync's DELIVERED-transition branch, because the tracking/PUT path does
  // NOT fire the caisse hook on its own — only erpOrderStatus does — so without
  // this a courier-delivered COD order would silently miss day-close/reconcile.
  //
  // The marker is an 'in'/'cod' pending caisse row tagged with the order's ref +
  // courierId (buildPendingCodEntry reads both off the order — the order carries
  // courierId from ship/assign, so the per-courier reconcile tag is correct).
  // Idempotent: skips when a marker for the ref already exists in the partition,
  // so re-syncing a delivered order never stacks duplicate markers. NEVER throws.
  // =========================================================================
  private async writePendingCod(
    slug: string,
    order: ErpRecord,
    token: string
  ): Promise<void> {
    try {
      const built = buildPendingCodEntry(order as CaisseRecord);
      if (!built) return; // total <= 0 → nothing to collect (no-op, not an error)
      const ref = caisseStr((built.entry as ErpRecord).orderRef).trim();
      // MONEY-3: check EVERY partition the marker could already be in. Markers
      // are filed by delivery month now, but ones written before deliveredAt
      // existed sit in the placement month, and markers are never cleaned up —
      // a single-partition check would let the same COD be counted twice in
      // pendingCodTotal, permanently.
      if (ref) {
        for (const coll of pendingCodMarkerPartitions(order as CaisseRecord)) {
          const rows = await this.erpListCollection(slug, coll);
          if (rows && hasPendingCodMarker(rows as CaisseRecord[], ref)) {
            return; // marker already present somewhere — stay idempotent
          }
        }
      }
      await this.erpCreateRecord(
        slug,
        built.collection,
        built.entry as ErpRecord,
        token
      );
    } catch {
      // Fail-soft: a delivered order must still advance even if caisse is down.
      // Swallowed (no logger on this controller) — never regresses the order.
    }
  }

  // =========================================================================
  // R17 PR-B — order → ParcelInput mapping. Assembles the provider-agnostic
  // parcel from a stored order record + the ship request. All reads are loose
  // (schemaless order). Returns null with a `field` when a required field is
  // missing so the route can 400 without a provider round-trip.
  //
  //   recipient  : order.customer (full name) → firstname + familyname
  //   phone      : order.phone (digits, '0555…')
  //   to wilaya  : order.wilaya ('16 - Alger') → FR name 'Alger'
  //   to commune : order.commune (FR free text)
  //   from wilaya: request `fromWilaya` (name OR '16 - Alger' OR '16' code →
  //                resolved to a FR name); the cred record does not store a pickup
  //                wilaya (that lands with the ERP tab), so ship supplies it.
  //   price(COD) : request `price` if given, else order total — the SAME amount
  //                caisse day-close expects to reconcile. freeshipping defaults
  //                true so Yalidine does not add a SECOND delivery fee on top of
  //                the shop's own (the customer pays exactly the shop total);
  //                both are body-overridable.
  //   is_stopdesk: order.deliveryMode === 'desk' (unless overridden)
  // =========================================================================
  private orderToParcel(
    order: ErpRecord,
    body: {
      fromWilaya?: unknown;
      price?: unknown;
      freeshipping?: unknown;
      weight?: unknown;
      economic?: unknown;
      stopdeskId?: unknown;
      isStopdesk?: unknown;
    }
  ): { ok: true; parcel: ParcelInput } | { ok: false; field: string } {
    const orderId = str(order.ref).trim() || str(order.id).trim();
    if (!orderId) return { ok: false, field: 'ref' };

    const { firstname, familyname } = splitName(order.customer);
    if (!firstname) return { ok: false, field: 'customer' };

    const contactPhone = str(order.phone).trim();
    if (!contactPhone) return { ok: false, field: 'phone' };

    const toWilayaName = wilayaNameOf(order.wilaya);
    if (!toWilayaName) return { ok: false, field: 'wilaya' };

    const toCommuneName = str(order.commune).trim();
    if (!toCommuneName) return { ok: false, field: 'commune' };

    // Pickup wilaya: accept a FR name, a '16 - Alger' label, or a bare '16'
    // code — all normalized to the FR name Yalidine's create-by-name wants.
    const fromWilayaName = wilayaNameOf(body?.fromWilaya);
    if (!fromWilayaName) return { ok: false, field: 'fromWilaya' };

    // COD amount: explicit override wins; else the order total (== what caisse
    // reconcile expects). Non-negative integer.
    const priceOverride =
      body?.price !== undefined && body?.price !== null && body?.price !== ''
        ? num(body.price)
        : orderTotal(order);
    const price = Math.max(0, Math.round(priceOverride));

    // Desk vs home: explicit override, else the order's assigned deliveryMode.
    const isStopdesk =
      body?.isStopdesk !== undefined
        ? body.isStopdesk === true || body.isStopdesk === 'desk'
        : str(order.deliveryMode).trim().toLowerCase() === 'desk';

    // freeshipping: default TRUE (customer pays exactly the shop total; merchant
    // absorbs the courier's delivery fee) unless the caller sets it false.
    const freeshipping =
      body?.freeshipping !== undefined ? body.freeshipping === true : true;

    const parcel: ParcelInput = {
      orderId,
      firstname,
      familyname,
      contactPhone,
      address: str(order.address).trim() || toCommuneName,
      toWilayaName,
      toCommuneName,
      fromWilayaName,
      productList: productListOf(order),
      price,
      isStopdesk,
      freeshipping,
    };
    if (body?.stopdeskId !== undefined && body?.stopdeskId !== null && body?.stopdeskId !== '') {
      parcel.stopdeskId = num(body.stopdeskId);
    }
    if (body?.weight !== undefined && body?.weight !== null && body?.weight !== '') {
      parcel.weight = num(body.weight);
    } else if (order.weight !== undefined) {
      parcel.weight = num(order.weight);
    }
    if (body?.economic !== undefined) {
      parcel.economic = body.economic === true;
    }
    return { ok: true, parcel };
  }

  // =========================================================================
  // POST /api/v1/apps/:slug/courier/:provider/ship  { orderId, fromWilaya,
  //   mode?, price?, freeshipping?, weight?, economic?, stopdeskId? }
  //   → { ok, tracking, label?, courierStatus, alreadyShipped? }
  //
  // Turn a paid order into a real courier parcel. Owner-gated + flag-gated.
  // IDEMPOTENT: an order that already carries a trackingNumber returns it (never
  // double-creates). Persists {courierProvider, trackingNumber, labelUrl,
  // courierStatus:'pending', shippedAt} onto the ORDER via PUT-by-id. Fail-soft:
  // a provider outage returns a typed passthrough body and leaves the order
  // untouched (no partial write); a data-write failure after a successful create
  // is surfaced (the tracking exists at the courier — the FE can re-run ship,
  // which will then hit the idempotency short-circuit once the write lands).
  // @Throttle('strict').
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/courier/:provider/ship')
  async ship(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string,
    @Body() body: {
      orderId?: unknown;
      fromWilaya?: unknown;
      price?: unknown;
      freeshipping?: unknown;
      weight?: unknown;
      economic?: unknown;
      stopdeskId?: unknown;
      isStopdesk?: unknown;
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

    // A write token is required to persist the tracking; fail early (before any
    // provider call) if the deploy can't do admin writes.
    const token = dataWriteToken(slug);
    if (!token) {
      res.status(501).json({ error: 'admin_writes_unavailable' });
      return;
    }

    // Resolve the connection (unsealed only here, after the ownership gate).
    const creds = await this.resolveCreds(slug, provider);
    if (!creds) {
      throw new BadRequest('not_connected');
    }

    // Load the order (owner-scoped namespace). `:orderId` matches the data-API
    // record id OR the business `ref` (the FE has the id; a caller may pass ref).
    const orders = await this.erpListOrders(slug);
    if (!orders) {
      res.status(502).json({ error: 'data_api_unavailable' });
      return;
    }
    const order = orders.find(
      o => str(o.id) === orderId || str(o.ref).trim() === orderId
    );
    if (!order) {
      throw new NotFound('Order not found');
    }
    const recId = str(order.id);
    if (!recId) {
      // No server id to PUT by — cannot persist safely; do not create a parcel.
      res.status(502).json({ error: 'order_unwritable' });
      return;
    }

    // IDEMPOTENCY: already shipped ⇒ return the existing tracking, do NOT create
    // a second parcel at the courier.
    const existingTracking = str(order.trackingNumber).trim();
    if (existingTracking) {
      return {
        ok: true,
        tracking: existingTracking,
        ...(str(order.labelUrl) ? { label: str(order.labelUrl) } : {}),
        courierStatus: str(order.courierStatus) || 'pending',
        alreadyShipped: true,
      };
    }

    // IDEMPOTENCY (orphan reuse, F-2): a prior ship may have created the parcel
    // at the courier but failed to persist the tracking onto the order (a
    // data-API hiccup / record-too-big). We stashed that tracking under
    // shipOrphanKey; reuse it now instead of creating a SECOND COD parcel. A
    // Redis miss just falls through. Best-effort re-persist so the fast-path
    // (order.trackingNumber) takes over next time; we return the tracking
    // regardless so the merchant never loses it.
    let orphanTracking = '';
    try {
      orphanTracking = str(
        await this.redis.get(shipOrphanKey(slug, provider.id, recId))
      ).trim();
    } catch {
      orphanTracking = '';
    }
    if (orphanTracking) {
      const healed: ErpRecord = {
        ...order,
        courierProvider: provider.id,
        trackingNumber: orphanTracking,
        courierStatus: (str(order.courierStatus) || 'pending') as CourierStatus,
      };
      delete (healed as { createdAt?: unknown }).createdAt;
      let persisted = false;
      if (
        Buffer.byteLength(JSON.stringify(healed), 'utf8') <= ERP_MAX_WRITE_BYTES
      ) {
        const reSaved = await this.erpPutRecord(
          slug,
          'orders',
          recId,
          healed,
          token
        );
        persisted = reSaved.ok;
        if (persisted) {
          try {
            await this.redis.del(shipOrphanKey(slug, provider.id, recId));
          } catch {
            /* fail-soft: orphan clears on TTL anyway */
          }
        }
      }
      return {
        ok: true,
        tracking: orphanTracking,
        ...(str(order.labelUrl) ? { label: str(order.labelUrl) } : {}),
        courierStatus: str(order.courierStatus) || 'pending',
        alreadyShipped: true,
        persisted,
      };
    }

    // CONCURRENCY LOCK (F-2): the order's own `trackingNumber` is written only
    // AFTER the courier round-trip, so it cannot serialize two simultaneous ship
    // calls — both would read it empty and both create a parcel. Hold a short NX
    // lock (per slug+provider+order) across the create+persist critical section:
    // a held lock ⇒ a ship is already in flight ⇒ typed 409, no second parcel.
    // FAIL-OPEN on a Redis outage (availability over the rare double-ship; the
    // orphan reuse + trackingNumber checks still cover the common retry paths).
    const lockKey = shipLockKey(slug, provider.id, recId);
    let locked = false;
    try {
      const acquired = await this.redis.set(
        lockKey,
        new Date().toISOString(),
        'EX',
        SHIP_LOCK_TTL_SEC,
        'NX'
      );
      locked = acquired === 'OK';
      if (!locked) {
        res.status(409).json({ error: 'ship_in_progress' });
        return;
      }
    } catch {
      locked = false; // Redis unreachable → proceed lock-free (fail-open).
    }

    try {
      // Map order → parcel; a missing required field is a client-fixable 400.
      const mapped = this.orderToParcel(order, body);
      if (!mapped.ok) {
        res.status(400).json({ error: 'invalid_order', field: mapped.field });
        return;
      }

      // Create the parcel. Any provider failure is typed + passthrough; the order
      // is left UNTOUCHED (we only write on a real tracking number).
      const created = await provider.createParcel(creds, mapped.parcel);
      if (!created.ok) {
        writeCourierError(res, created);
        return;
      }
      const tracking = str(created.value.tracking).trim();
      if (!tracking) {
        // Defensive — the provider contract guarantees a tracking on ok, but never
        // persist an empty one.
        res.status(502).json({ error: 'courier_bad_response' });
        return;
      }
      const label = str(created.value.label).trim();

      // Persist onto the ORDER (PUT-by-id upsert; id/createdAt preserved).
      // Additive fields only — never touches the order's status/paid sub-state.
      const now = new Date().toISOString();
      const patch: ErpRecord = {
        courierProvider: provider.id,
        trackingNumber: tracking,
        courierStatus: 'pending' as CourierStatus,
        shippedAt: now,
      };
      if (label) patch.labelUrl = label;
      const merged: ErpRecord = { ...order, ...patch };
      delete (merged as { createdAt?: unknown }).createdAt; // upsert keeps stored createdAt

      const tooBig =
        Buffer.byteLength(JSON.stringify(merged), 'utf8') > ERP_MAX_WRITE_BYTES;
      const saved = tooBig
        ? null
        : await this.erpPutRecord(slug, 'orders', recId, merged, token);
      if (tooBig || !saved || !saved.ok) {
        // Parcel created at the courier but NOT persisted onto the order (record
        // too big, or the write failed). Stash the tracking under shipOrphanKey
        // so a re-ship REUSES it rather than creating a second parcel (F-2).
        // Fail-soft: even if the stash fails, we still return the tracking so it
        // is never lost — but the orphan write is what closes the double-parcel
        // window, so it is attempted first.
        try {
          await this.redis.set(
            shipOrphanKey(slug, provider.id, recId),
            tracking,
            'EX',
            SHIP_ORPHAN_TTL_SEC
          );
        } catch {
          /* fail-soft: best-effort orphan stash */
        }
        res.status(200).json({
          ok: true,
          tracking,
          ...(label ? { label } : {}),
          courierStatus: 'pending',
          persisted: false,
        });
        return;
      }

      // Persisted cleanly — drop any stale orphan marker for this order.
      try {
        await this.redis.del(shipOrphanKey(slug, provider.id, recId));
      } catch {
        /* fail-soft */
      }
      return {
        ok: true,
        tracking,
        ...(label ? { label } : {}),
        courierStatus: 'pending',
        persisted: true,
      };
    } finally {
      // Release the lock as soon as the critical section ends (success OR any
      // handled failure/return above); the TTL is only a crash-safety net.
      if (locked) {
        try {
          await this.redis.del(lockKey);
        } catch {
          /* fail-soft: lock auto-expires via its TTL */
        }
      }
    }
  }

  // =========================================================================
  // R17 PR-B — the per-order sync step (shared by batch sync + refresh).
  // Polls provider.trackParcel → normalizeStatus → (when the coarse courier
  // sub-state changed) advances BOTH the order's courierStatus AND — via
  // Shipping.buildTrackingPatch — its canonical ERP `status`, IN PLACE. On a
  // DELIVERED transition it fires the caisse pending-COD marker (THE FIX).
  //
  // FAIL-SOFT + isolated: any provider/data failure for ONE order returns a
  // typed outcome; the caller keeps going with the rest of the batch. Returns a
  // small result the batch route aggregates. NEVER throws.
  // =========================================================================
  private async syncOneOrder(
    slug: string,
    provider: CourierProvider,
    creds: CourierCredentials,
    order: ErpRecord,
    token: string
  ): Promise<SyncOneResult> {
    const recId = str(order.id);
    const tracking = str(order.trackingNumber).trim();
    const orderId = recId || str(order.ref).trim();
    if (!tracking) return { orderId, outcome: 'no_tracking' };

    // Current coarse courier sub-state on the order (default 'pending').
    const prevRaw = str(order.courierStatus);
    const prev: CourierStatus = isCourierStatus(prevRaw) ? prevRaw : 'pending';
    // The canonical ERP status a HUMAN may have set from the Commandes tab. The
    // status route (erpOrderStatus) advances `status` to 'Livrée'/'Retournée'
    // WITHOUT writing `courierStatus`, so a manually-settled order can still carry
    // a non-terminal courierStatus (Waybill F-3). We must treat a terminal
    // canonical status as terminal too — otherwise a stale courier poll (e.g.
    // 'en-route') would overwrite the human's 'Livrée' back to 'Expédiée'.
    const canonical = str(order.status).trim();
    const canonicalDelivered = canonical === ORDER_STATUS_DELIVERED;
    const canonicalTerminal =
      canonicalDelivered || canonical === ORDER_STATUS_RETURNED;
    // Terminal states are never re-polled (delivered/returned don't change at the
    // courier). BUT a `delivered` order still gets a best-effort caisse retry: if
    // a prior sync advanced the ERP status yet the pending-COD marker write hiccuped,
    // this re-attempts it — idempotent via hasPendingCodMarker, so it's a no-op once
    // the marker exists. This guarantees a courier-delivered COD is never lost.
    if (prev === 'delivered' || prev === 'returned' || canonicalTerminal) {
      if ((prev === 'delivered' || canonicalDelivered) && recId) {
        await this.writePendingCod(slug, order, token);
      }
      return {
        orderId,
        outcome: 'terminal',
        courierStatus: prev === 'pending' && canonicalDelivered ? 'delivered' : prev,
      };
    }

    // Poll the courier. A typed error is isolated to THIS order.
    const tracked = await provider.trackParcel(creds, tracking);
    if (!tracked.ok) {
      return { orderId, outcome: 'courier_error' };
    }
    const next = provider.normalizeStatus(tracked.value.lastRawStatus);

    // No coarse-state change ⇒ nothing to write (avoids a needless PUT + keeps
    // us idempotent when the courier hasn't advanced).
    if (next === prev) {
      return { orderId, outcome: 'unchanged', courierStatus: prev };
    }

    // Advance the order: courierStatus + (via the SAME pure builder the bridge's
    // tracking route uses) the canonical ERP status. buildTrackingPatch is total
    // over the mapped TrackingStatus, so ok is always true here.
    const trackingStatus = courierStatusToTracking(next);
    const built = Shipping.buildTrackingPatch(
      trackingStatus,
      new Date().toISOString()
    );
    if (!built.ok) {
      return { orderId, outcome: 'unchanged', courierStatus: prev };
    }
    const merged: ErpRecord = {
      ...order,
      ...built.patch, // { tracking, status, trackingAt } — advances ERP status
      courierStatus: next,
    };
    delete (merged as { createdAt?: unknown }).createdAt;
    if (!recId) {
      return { orderId, outcome: 'write_failed', courierStatus: prev };
    }
    if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > ERP_MAX_WRITE_BYTES) {
      return { orderId, outcome: 'write_failed', courierStatus: prev };
    }
    const saved = await this.erpPutRecord(slug, 'orders', recId, merged, token);
    if (!saved.ok) {
      return { orderId, outcome: 'write_failed', courierStatus: prev };
    }

    // ⚠️ THE CAISSE FIX: a courier-driven DELIVERED transition owes a pending-COD
    // marker, exactly like erpOrderStatus's `if (status === 'Livrée')` branch.
    // Fail-soft + idempotent; uses the freshly-saved record (carries courierId).
    const delivered = built.orderStatus === ORDER_STATUS_DELIVERED;
    if (delivered) {
      await this.writePendingCod(slug, saved.record, token);
    }
    return {
      orderId,
      outcome: 'updated',
      courierStatus: next,
      delivered,
    };
  }

  // =========================================================================
  // POST /api/v1/apps/:slug/courier/:provider/sync  { orderId? }
  //   → { ok, scanned, updated, delivered, results:[{orderId,outcome,...}] }
  //
  // Tracking sync. Owner-gated + flag-gated. With `orderId`, refreshes exactly
  // that one order; without, scans the `orders` collection for parcels with a
  // trackingNumber and a NON-terminal courierStatus and polls up to SYNC_MAX of
  // them (bounded, to respect the courier's rate limits). Each order is synced
  // fail-soft in isolation — one bad parcel never aborts the batch. On any order
  // that transitions to DELIVERED, the pending-COD caisse marker is written (the
  // fix). @Throttle('strict').
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/courier/:provider/sync')
  async sync(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string,
    @Body() body: { orderId?: unknown },
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);

    const token = dataWriteToken(slug);
    if (!token) {
      res.status(501).json({ error: 'admin_writes_unavailable' });
      return;
    }
    const creds = await this.resolveCreds(slug, provider);
    if (!creds) {
      throw new BadRequest('not_connected');
    }
    const orders = await this.erpListOrders(slug);
    if (!orders) {
      res.status(502).json({ error: 'data_api_unavailable' });
      return;
    }

    // Candidate set: this provider's shipped-but-not-terminal parcels.
    const wantId = str(body?.orderId).trim();
    const candidates = orders.filter(o => {
      if (!str(o.trackingNumber).trim()) return false;
      // Only sync parcels that belong to THIS provider (a shop could in future
      // connect more than one). Tolerate a legacy row with no courierProvider.
      const cp = str(o.courierProvider).trim();
      if (cp && cp !== provider.id) return false;
      if (wantId) {
        return str(o.id) === wantId || str(o.ref).trim() === wantId;
      }
      const cs = str(o.courierStatus);
      const norm: CourierStatus = isCourierStatus(cs) ? cs : 'pending';
      return norm !== 'delivered' && norm !== 'returned';
    });
    if (wantId && candidates.length === 0) {
      throw new NotFound('Order not found or not shipped');
    }

    const batch = candidates.slice(0, SYNC_MAX);
    const results: SyncOneResult[] = [];
    let updated = 0;
    let delivered = 0;
    // Sequential (not Promise.all) so a burst of parcels paces out under the
    // courier's 5/s limit and the fan-out stays bounded + predictable. Each
    // order is additionally try/caught here as defense-in-depth: syncOneOrder is
    // already fail-soft (typed outcomes, never throws), but this GUARANTEES one
    // pathological parcel can never abort the batch — the whole point of a
    // bounded, fault-tolerant sync.
    for (const o of batch) {
      let r: SyncOneResult;
      try {
        r = await this.syncOneOrder(slug, provider, creds, o, token);
      } catch {
        r = {
          orderId: str(o.id) || str(o.ref).trim(),
          outcome: 'courier_error',
        };
      }
      results.push(r);
      if (r.outcome === 'updated') updated++;
      if (r.delivered) delivered++;
    }
    return {
      ok: true,
      scanned: batch.length,
      total: candidates.length,
      capped: candidates.length > batch.length,
      updated,
      delivered,
      results,
    };
  }

  // =========================================================================
  // POST /api/v1/apps/:slug/courier/:provider/ship/:orderId/refresh
  //   → { ok, orderId, outcome, courierStatus?, delivered? }
  //
  // Single-order tracking refresh — a convenience alias that folds into the
  // SAME fail-soft syncOneOrder path (so the caisse fix applies identically).
  // Owner-gated + flag-gated. @Throttle('strict').
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/courier/:provider/ship/:orderId/refresh')
  async refresh(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string,
    @Param('orderId') orderId: string,
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);

    const token = dataWriteToken(slug);
    if (!token) {
      res.status(501).json({ error: 'admin_writes_unavailable' });
      return;
    }
    const creds = await this.resolveCreds(slug, provider);
    if (!creds) {
      throw new BadRequest('not_connected');
    }
    const orders = await this.erpListOrders(slug);
    if (!orders) {
      res.status(502).json({ error: 'data_api_unavailable' });
      return;
    }
    const wantId = str(orderId).trim();
    const order = orders.find(
      o => str(o.id) === wantId || str(o.ref).trim() === wantId
    );
    if (!order) {
      throw new NotFound('Order not found');
    }
    if (!str(order.trackingNumber).trim()) {
      // Not shipped yet — nothing to refresh (client-fixable, not a 500).
      res.status(400).json({ error: 'not_shipped' });
      return;
    }
    // Guard the provider match so a refresh can't cross a (future) multi-provider
    // order onto the wrong courier's API.
    const cp = str(order.courierProvider).trim();
    if (cp && cp !== provider.id) {
      res.status(400).json({ error: 'provider_mismatch' });
      return;
    }
    const r = await this.syncOneOrder(slug, provider, creds, order, token);
    return {
      ok: true,
      orderId: r.orderId,
      outcome: r.outcome,
      ...(r.courierStatus ? { courierStatus: r.courierStatus } : {}),
      ...(r.delivered ? { delivered: true } : {}),
    };
  }

  // =========================================================================
  // GET /api/v1/apps/:slug/courier/:provider/ship/:orderId/label
  //   → the shipping label, streamed as bytes (application/pdf)
  //
  // Most couriers return a label URL on ParcelResult.label, which the merchant
  // opens directly. Ecotrack returns the PDF ITSELF from a Bearer-authenticated
  // tenant endpoint — there is no URL a browser can follow, and the merchant's
  // browser must never hold the courier token. Without this route an Ecotrack
  // parcel could be created and then never printed, so the driver could not
  // take it.
  //
  // Owner-gated and flag-gated like every sibling route. The provider must
  // implement the optional `fetchLabel`; the rest answer a typed
  // `label_not_supported` rather than a confusing 404, so the client can say
  // "use the label link" instead of "something went wrong".
  // =========================================================================
  @Throttle('strict')
  @Get('/api/v1/apps/:slug/courier/:provider/ship/:orderId/label')
  async label(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('provider') providerParam: string,
    @Param('orderId') orderId: string,
    @Res() res: Response
  ) {
    this.assertEnabled();
    const provider = this.resolveProviderOr404(providerParam);
    await this.assertOwnsErpApp(user, slug);

    if (typeof provider.fetchLabel !== 'function') {
      // Not an error condition — this courier simply hands back a URL.
      res.status(400).json({ error: 'label_not_supported' });
      return;
    }
    const creds = await this.resolveCreds(slug, provider);
    if (!creds) {
      throw new BadRequest('not_connected');
    }
    const orders = await this.erpListOrders(slug);
    if (!orders) {
      res.status(502).json({ error: 'data_api_unavailable' });
      return;
    }
    const wantId = str(orderId).trim();
    const order = orders.find(
      o => str(o.id) === wantId || str(o.ref).trim() === wantId
    );
    if (!order) {
      throw new NotFound('Order not found');
    }
    const tracking = str(order.trackingNumber).trim();
    if (!tracking) {
      res.status(400).json({ error: 'not_shipped' });
      return;
    }
    // Same cross-provider guard as refresh(): never ask courier B for a label
    // that belongs to courier A.
    const cp = str(order.courierProvider).trim();
    if (cp && cp !== provider.id) {
      res.status(400).json({ error: 'provider_mismatch' });
      return;
    }
    const out = await provider.fetchLabel(creds, tracking);
    if (!out.ok) {
      // Map the provider's typed error onto an honest status, mirroring how
      // the ship route surfaces upstream failures. Never leak credentials.
      const status =
        out.error === 'rate_limited'
          ? 429
          : out.error === 'bad_request'
            ? 400
            : out.error === 'not_found'
              ? 404
              : // unauthorized / unreachable / upstream_error / malformed are
                // all "the courier failed us", not "the merchant did something
                // wrong" — 502 keeps that distinction honest. In particular a
                // credential problem is OUR stored secret, not the caller's
                // session, so it must never surface as a 401.
                502;
      res.status(status).json({
        error: out.error,
        ...(out.message ? { message: out.message } : {}),
      });
      return;
    }
    res.setHeader('Content-Type', out.value.contentType);
    // `inline` so it previews in the browser's PDF viewer; the merchant prints
    // from there. The tracking number makes a saved file self-identifying.
    res.setHeader(
      'Content-Disposition',
      `inline; filename="label-${tracking.replace(/[^A-Za-z0-9_-]/g, '')}.pdf"`
    );
    // A label is per-parcel and credential-derived — never cache it anywhere.
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(out.value.bytes));
  }
}
