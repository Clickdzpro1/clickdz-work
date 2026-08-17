// ---------------------------------------------------------------------------
// R17 (PR-D) — NOEST EXPRESS provider. A concrete `CourierProvider`
// (clickdz-courier.ts) for Nord et Ouest Express (NOEST). NOEST is the largest
// independent DZ COD courier after the big three; each ClickDz merchant connects
// THEIR OWN NOEST account. NOEST is "Yalidine-shaped" in payload but uses an
// Ecotrack-style Bearer auth — a hybrid.
//
// Framework-light: like clickdz-courier-yalidine.ts this file does `fetch` and
// imports NOTHING from Nest and throws NOTHING. Every method obeys the fail-soft
// contract from clickdz-courier.ts: resolve `CourierResult<T>` — a typed error
// on any failure, never a raw throw. The merchant's keys are read from `creds`,
// placed (token in a header, guid in the body) per NOEST, and NEVER logged or
// returned.
//
// -----------------------------------------------------------------------------
// SOURCES & CONFIDENCE (research/noest-ecotrack.md, Part A; 2026-07-24)
//   Triangulated from four OSS SDKs (S1 KaziSTM/vargo — typed DTOs + Laravel
//   rules, the richest source; S2 DZBuild/dzship — gotchas + status semantics;
//   S3 courier-dz — base URL/endpoints/type_id; S4 PiteurStudio) + S5 (Cirtasoft
//   NOEST plugin / company profile). NO official NOEST doc is open (login-gated),
//   NO sandbox exists (same as Yalidine) — field names are strong enough to build
//   against but the FIRST integration test MUST be a real merchant account.
//   HIGH = 2+ sources agree; MED = one strong typed source; LOW = inferred.
//
// CREDENTIAL MAPPING ({apiId, apiToken} — requiresApiId = true) [HIGH]
//   NOEST needs TWO secrets, but their ROLE is INVERSE to Yalidine:
//     apiId    ← user_guid  → injected into the JSON BODY of every WRITE/action
//                             call (create/valid/track), NOT a header.
//     apiToken ← api_token  → sent as the header `Authorization: Bearer <token>`.
//   Read-only reference calls (wilayas/communes/fees/label) authenticate with the
//   Bearer token alone; create/valid/track carry user_guid in the body too. The
//   FE connect form must label the two fields "User GUID" and "API Token" (NOT
//   "X-API-ID"). We never echo/log either secret.
//
// BASE URL — https://app.noest-dz.com [HIGH]; env-overridable via CDZ_NOEST_BASE
//   (Yalidine-style) so NOEST-clones that share the identical shape (Guepex /
//   Yalitec / Easy&Speed) can point the same provider at their own host.
//
// ⚠ TWO-CALL CREATE — THE #1 TRAP (§A.4) [HIGH]
//   On NOEST, POST create/order only makes a DRAFT. Until you SEPARATELY POST
//   valid/order {tracking}, logistics never sees the parcel: no pickup, nothing
//   moves, and NO error is returned. A one-call impl SILENTLY STRANDS every
//   parcel. So `createParcel` here is TWO calls: create/order → read `tracking`
//   → valid/order {tracking} → only THEN resolve a `ParcelResult`. If create
//   succeeds but valid FAILS, we return a TYPED courierErr (never `ok`) whose
//   `message` embeds the draft tracking ("created_not_validated:<tracking>") so
//   the caller knows the parcel EXISTS and can re-drive validation idempotently
//   rather than re-create (which would double-create). For NOEST, a ParcelResult
//   means created AND validated. After valid/order the parcel can no longer be
//   deleted (cancellation is dashboard-only) — acceptable for the v1 contract.
//
// ⚠ STOP-DESK station_code IS A STRING (§A.5/§A.8) [HIGH]
//   NOEST identifies a desk by an ALPHANUMERIC `station_code` (e.g. "16A" =
//   wilaya number + letter), which is why CenterRef.centerId and
//   ParcelInput.stopdeskId are `number | string`. We READ and EMIT these as
//   STRINGS via `sid()` — we do NOT coerce a station_code to a number (a number
//   can't round-trip "16A"). `listCenters` derives the desk's wilaya by
//   stripping non-digits from the code ("16A" → 16). On create, station_code is
//   only sent when stop_desk = 1.
//
// LABEL AVAILABILITY (§A.8 / R3) [MED]
//   GET api/public/get/order/label returns a bordereau PDF, but the link is
//   EPHEMERAL — S3 reports a 302 → pre-signed S3 URL expiring ~300s; S2 calls it
//   a direct download. Either way it is NOT a stable URL. We build a fresh label
//   URL on create carrying the token+tracking (so it works now) but the caller
//   must treat it as short-lived and regenerate on demand rather than persist it.
//
// TRACKING FINANCE FILTER (§A.7 / R5) [HIGH]
//   NOEST's tracking feed mixes finance/payment events (`verssement_*`) that are
//   NOT parcel movement. `trackParcel` FILTERS these out so they never become
//   TrackEvents and `lastRawStatus` never becomes a finance slug. normalizeStatus
//   also maps a finance slug to the safe `pending` default.
//
// NO SANDBOX — every field/route here is reconstructed from third-party SDKs, not
// NOEST's own docs. Safe to build; verify against a live account before trusting.
//
// OPEN RISKS to verify with REAL creds (defensively coded here):
//   • R8 [LOW] The literal GET route strings for wilayas / communes / offices /
//     fees are the WEAKEST evidence — S1 gave the response MAPPERS (field names)
//     and S3 the METHOD names + the fees path, but the exact reference-list route
//     strings were NOT extractable. We use `api/public/fees` (S3) and the best-
//     guess sibling paths `api/public/get/wilayas|communes|offices` under the same
//     `api/public/get/...` family, and parse the response DEFENSIVELY (object
//     guards, tolerate {code,nom} or {id,name}, tolerate a bare array or a {data}
//     / {items} / {offices} wrapper). CONFIRM these four routes on a live account;
//     create/track/valid/label are HIGH and unblocked.
//   • R4 [LOW] `type_id` semantics disputed (S1: 1=normal,2=fragile,3=exchange;
//     S3: 1=livraison,2=échange,3=pickup). We hard-default to type_id = 1
//     (normal) and do NOT expose exchange until verified.
//   • R6 [LOW] `reference` rule is min:5 — a short ClickDz orderId is rejected by
//     NOEST validation. We LEFT-PAD a short reference to ≥5 chars (see refOf).
//   • R7 [LOW] phone rule is /^\d{9,10}$/ — `+213`/spaces are rejected. We strip
//     to digits and drop a leading 213 country code before sending (see phoneOf).
//   • Commune has NO numeric id (NOEST keys communes by NAME) — listCommunes
//     synthesizes a stable id from a 1-based index (create sends the NAME anyway).
//   • create-response envelope shape is MED — we read `tracking` across several
//     plausible keys (tracking / tracking_number / OrderInfo.tracking / data.*).
// ---------------------------------------------------------------------------

import {
  courierErr,
  courierOk,
  normalizeStatusRaw,
  registerCourierProvider,
  type CenterRef,
  type CommuneFee,
  type CommuneRef,
  type CourierCredentials,
  type CourierProvider,
  type CourierResult,
  type CourierStatus,
  type FeeResult,
  type ParcelInput,
  type ParcelResult,
  type TrackEvent,
  type TrackResult,
  type WilayaRef,
} from './clickdz-courier';
// The canonical 58-wilaya table. `clickdz-erp-shipping` is a pure, zero-import
// module (same purity contract as `clickdz-courier`), so importing it here is
// boot-safe and keeps ONE source of truth for wilaya names.
import * as Shipping from './clickdz-erp-shipping';

// --- Config (module-load constants; the base is env-overridable for NOEST-clones
// e.g. Guepex/Yalitec/Easy&Speed which share the identical shape under their own
// host, but defaults to the documented production host). NEVER interpolates a
// secret.
const NOEST_BASE = (
  process.env.CDZ_NOEST_BASE || 'https://app.noest-dz.com'
).replace(/\/+$/, '');

// Bounded per-call timeout. NOEST calls are quick control-plane/reference
// lookups; a hung upstream must not hold a request thread. 15s (Yalidine-style).
const NOEST_TIMEOUT_MS = 15_000;

// NOEST `reference` validation is min:5 (§A.8/R6) — pad a short orderId so create
// is not rejected on a spurious length rule.
const NOEST_REFERENCE_MIN = 5;

// ---------------------------------------------------------------------------
// Loose scalar readers for the schemaless JSON NOEST returns (mirror the
// Yalidine impl's s()/n()/priceOrNull so this file stays dependency-free).
// ---------------------------------------------------------------------------
function s(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
/** A price cell: a finite number, or null (used for "n/a" service classes). */
function priceOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
/**
 * A stop-desk id reader that PRESERVES an alphanumeric station_code ("16A") as a
 * string. NOEST desks are NOT numeric (§A.5/§A.8) — coercing "16A" to a number
 * would lose the letter. Returns a trimmed string, or '' for null/undefined.
 * A numeric station_code still round-trips fine as its string form.
 */
function sid(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v.trim() : String(v).trim();
}

/**
 * Strip a station_code down to its leading wilaya digits ("16A" → 16, "9" → 9);
 * 0 when there are no digits. Used only to DERIVE a desk's wilaya for CenterRef
 * (the code itself stays a string). Pure + total.
 */
function wilayaOfStationCode(code: string): number {
  const digits = s(code).replace(/\D+/g, '');
  return digits ? n(digits) : 0;
}

/**
 * Resolve a destination wilaya NAME (or a numeric-looking value) to its 1..58
 * canonical code, using the same table the rest of the ERP emits from.
 *
 * WHY this exists: `createParcel` previously derived `wilaya_id` ONLY from a
 * desk's alphanumeric station_code ("16A" → 16). For HOME delivery there is no
 * station_code, so `wilaya_id` was never sent at all — and NOEST requires it.
 * Every home-delivery create therefore failed upstream validation. The comment
 * there said the caller must resolve name→id "before calling", but nothing in
 * the pipeline did, and ParcelInput only ever carries names.
 *
 * Accent/case/punctuation-insensitive via the shared `normalizeStatusRaw` fold,
 * which is what makes "Béjaïa" match "bejaia" and "El M'Ghair" match "el
 * mghair". Returns 0 when unresolvable, in which case the caller omits the
 * field and lets NOEST answer with its own typed validation error rather than
 * inventing a wrong destination.
 */
function noestWilayaIdFromName(value: unknown): number {
  const raw = s(value);
  if (!raw) return 0;
  // A bare number (or "16 - Alger") resolves directly when it is in range.
  const direct = Shipping.wilayaCodeFrom(raw);
  if (direct >= 1 && Shipping.isValidWilaya(direct)) {
    // Guard against a pure-name string whose first digits are incidental
    // (e.g. a street number leaking in) by requiring the value to START with
    // the digits we matched.
    if (/^\s*\d/.test(raw)) return direct;
  }
  const key = normalizeStatusRaw(raw);
  if (!key) return 0;
  for (const w of Shipping.WILAYAS) {
    if (normalizeStatusRaw(w.name) === key) return w.code;
  }
  return 0;
}

/**
 * Normalize a merchant orderId into a NOEST `reference` (rule: string|min:5|
 * max:255, §A.8/R6). Left-pad a short id with '0' to reach the min, and clamp to
 * 255. A blank id yields '' (create will still send it; NOEST validation, not us,
 * decides — but we avoid a guaranteed length rejection when there IS an id).
 */
function refOf(orderId: string): string {
  const id = s(orderId).trim();
  if (!id) return '';
  const padded = id.length < NOEST_REFERENCE_MIN ? id.padStart(NOEST_REFERENCE_MIN, '0') : id;
  return padded.slice(0, 255);
}

/**
 * Normalize a phone to NOEST's rule /^\d{9,10}$/ (§A.8/R7): strip everything but
 * digits, drop a leading 213 country code, and keep the last 10 digits. Best-
 * effort — if the result still isn't 9–10 digits NOEST validation will reject it
 * with a typed bad_request, which is the correct surface. Pure + total.
 */
function phoneOf(raw: string): string {
  let d = s(raw).replace(/\D+/g, '');
  if (d.startsWith('213')) d = d.slice(3);
  if (d.length > 10) d = d.slice(-10);
  return d;
}

// ---------------------------------------------------------------------------
// NOEST status slugs → the 4 ClickDz coarse sub-states (§A.7). Verbatim slugs
// from S1's `NoestPackagesStatus` enum + its own `NoestPackageStatusNormalizer`,
// folded to pending|shipped|delivered|returned. Matching is accent/case-folded +
// whitespace-normalized via the shared `normalizeStatusRaw` (so a minor drift on
// the wire still resolves). Unknown/blank ⇒ 'pending' (never spuriously terminal).
//
// Bucket rationale:
//   pending   — created / draft / awaiting customer validation (not yet moving).
//   shipped   — anything moving or in-network: collected, received at hub, out
//               for delivery (fdr), redispatch, pickups, re-attempt. Also the two
//               LOW judgement calls (see below): a SUSPENSION and a return being
//               RE-SENT for delivery are treated as still-in-network, not terminal.
//   delivered — livre / livred (S1 keeps the misspelling variant — include both).
//   returned  — every return-family terminal (asked/received/dispatched/validated
//               back to hub/warehouse/partner) + failed-delivery-received-back.
// FINANCE events (`verssement_*`) are NOT parcel movement — they map to 'pending'
// (the safe default) AND are filtered out of the tracking feed in trackParcel, so
// `lastRawStatus` never becomes a finance slug.
// ---------------------------------------------------------------------------
const NOEST_STATUS_MAP: Readonly<Record<string, CourierStatus>> = Object.freeze({
  // --- pending (created / not yet in transit) ---
  upload: 'pending', // order created / draft
  customer_validation: 'pending',
  // --- shipped (moving / in-network / out for delivery) ---
  validation_collect_colis: 'shipped',
  validation_reception_admin: 'shipped',
  validation_reception: 'shipped',
  fdr_activated: 'shipped', // out for delivery ("feuille de route")
  sent_to_redispatch: 'shipped',
  pickedup: 'shipped',
  valid_return_pickup: 'shipped',
  pickup_picked_recu: 'shipped',
  nouvel_tentative_asked_by_customer: 'shipped', // re-attempt requested
  colis_suspendu: 'shipped', // LOW: suspension is often temporary → not terminal
  return_redispatched_to_livraison: 'shipped', // LOW: return being re-sent for delivery
  // --- delivered ---
  livre: 'delivered',
  livred: 'delivered', // S1 keeps the misspelling variant
  // --- returned (terminal back to hub/warehouse/partner/vendor) ---
  return_asked_by_customer: 'returned',
  return_asked_by_hub: 'returned',
  retour_dispatched_to_partenaires: 'returned',
  return_dispatched_to_partenaire: 'returned',
  colis_retour_transmit_to_partner: 'returned',
  livraison_echoue_recu: 'returned', // failed delivery received back
  return_validated_by_partener: 'returned',
  return_dispatched_to_warehouse: 'returned',
  // --- finance (NOT movement — safe default; also filtered from the feed) ---
  verssement_admin_cust: 'pending',
  verssement_admin_cust_canceled: 'pending',
});

/**
 * True when a raw slug is a finance/payment event (`verssement_*`) that must be
 * kept OUT of the tracking feed (§A.7/R5). Accent/case-folded first so a drift
 * like "Verssement..." still matches. Pure + total.
 */
function isNoestFinanceEvent(raw: unknown): boolean {
  return normalizeStatusRaw(raw).startsWith('verssement');
}

/**
 * Map a NOEST raw status slug → a CourierStatus. Unknown/blank ⇒ 'pending' (never
 * spuriously terminal). Standalone + pure so it is unit-testable without the
 * provider; the provider's `normalizeStatus` delegates straight here.
 */
function normalizeNoestStatus(raw: unknown): CourierStatus {
  const key = normalizeStatusRaw(raw);
  if (!key) return 'pending';
  return NOEST_STATUS_MAP[key] ?? 'pending';
}

// ---------------------------------------------------------------------------
// Map an HTTP Response status to a typed CourierError. Reads Retry-After on a
// 429. NEVER reads/echoes credentials. `bodyMsg` is a short, secret-free upstream
// message when we could cheaply extract one. Mirrors the Yalidine impl exactly.
// ---------------------------------------------------------------------------
function errorFromStatus(status: number, bodyMsg?: string, retryAfter?: number) {
  if (status === 429) {
    return courierErr('rate_limited', { status, retryAfter, message: bodyMsg });
  }
  if (status === 401 || status === 403) {
    return courierErr('unauthorized', { status, message: bodyMsg });
  }
  if (status === 404) {
    return courierErr('not_found', { status, message: bodyMsg });
  }
  if (status === 400 || status === 422) {
    // NOEST is Laravel — validation failures surface as 422 (as well as 400);
    // both are client-fixable bad_request.
    return courierErr('bad_request', { status, message: bodyMsg });
  }
  return courierErr('upstream_error', { status, message: bodyMsg });
}

/** Parse a Retry-After header (delta-seconds form) → seconds, or undefined. */
function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw.trim());
  return Number.isFinite(secs) && secs >= 0 ? secs : undefined;
}

// ---------------------------------------------------------------------------
// The NOEST provider. One stateless singleton (registered at module load).
// Every method: build the URL, attach the Bearer header, inject user_guid into
// the body for write/action calls, 15s abort, then map the outcome to
// CourierResult. A thrown fetch (network/timeout/abort) → 'unreachable'; a
// non-2xx → the typed status map; a 2xx with an unparseable/unexpected body →
// 'malformed'.
// ---------------------------------------------------------------------------
class NoestProvider implements CourierProvider {
  readonly id = 'noest' as const;
  /** NOEST needs BOTH secrets: user_guid (apiId, body) + api_token (apiToken, header). */
  readonly requiresApiId = true as const;

  /** Build the Bearer auth header from the unsealed creds (token only). */
  private authHeaders(creds: CourierCredentials): Record<string, string> {
    return {
      Authorization: `Bearer ${s(creds?.apiToken)}`,
      Accept: 'application/json',
    };
  }

  /**
   * Core request → typed result carrying the parsed JSON. Reads the body ONCE.
   * On a non-2xx it best-effort extracts a secret-free `{message}` and, for a
   * 429, the Retry-After. On a thrown fetch → 'unreachable'. Never logs
   * headers/creds; never throws.
   *
   * `body` is the request payload for POST calls; the caller injects `user_guid`
   * (from apiId) into that body for write/action calls (create/valid/track).
   * Read-only reference calls (GET) send only the Bearer header.
   */
  private async request(
    creds: CourierCredentials,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<CourierResult<unknown>> {
    // Guard: both creds must be present before any network traffic (NOEST would
    // reject anyway, but this avoids a pointless round-trip and a confusing
    // upstream error). Applies uniformly — the Bearer token is always needed and
    // user_guid is needed for every write path we call.
    if (!s(creds?.apiId) || !s(creds?.apiToken)) {
      return courierErr('unauthorized', { message: 'missing_credentials' });
    }
    const url = `${NOEST_BASE}/${path.replace(/^\/+/, '')}`;
    const headers: Record<string, string> = this.authHeaders(creds);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(NOEST_TIMEOUT_MS),
      });
    } catch {
      // Network error / DNS / connection reset / AbortSignal timeout.
      return courierErr('unreachable');
    }
    // Read the body once, defensively (NOEST returns JSON for both success and
    // typed errors; a proxy could return non-JSON on a 5xx).
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const msg = this.messageOf(json);
      return errorFromStatus(res.status, msg, parseRetryAfter(res));
    }
    return courierOk(json);
  }

  /**
   * Best-effort secret-free upstream message. NOEST (Laravel) may return a flat
   * `{message}` OR a validation `{message, errors:{field:[...]}}`; we surface the
   * top-level message, capped. Never touches credential fields.
   */
  private messageOf(json: unknown): string | undefined {
    if (json && typeof json === 'object' && 'message' in (json as any)) {
      const m = s((json as any).message).slice(0, 200);
      return m || undefined;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // createParcel — THE TWO-CALL TRAP (§A.4). NOEST create is TWO steps:
  //   (1) POST api/public/create/order  {user_guid, reference, client, phone,
  //       adresse, wilaya_id, commune, montant, produit, type_id, stop_desk,
  //       [station_code], [poids]}  → read `tracking` (parcel is a DRAFT).
  //   (2) POST api/public/valid/order  {user_guid, tracking}  → NOW logistics
  //       sees it; a pickup is scheduled.
  // A ParcelResult means created AND validated. If (1) succeeds but (2) fails we
  // return a TYPED error (NOT ok) whose message embeds the draft tracking
  // ("created_not_validated:<tracking>") so the caller can RE-DRIVE validation
  // idempotently instead of re-creating (which would double-create). NOT wired to
  // a route in PR-A/PR-D (createParcel is exercised by PR-B).
  // -------------------------------------------------------------------------
  async createParcel(
    creds: CourierCredentials,
    parcel: ParcelInput
  ): Promise<CourierResult<ParcelResult>> {
    const orderId = s(parcel?.orderId);
    const reference = refOf(orderId);
    // NOEST wants ONE `client` full name; S1 trims "first last".
    const client = `${s(parcel?.firstname)} ${s(parcel?.familyname)}`.trim();
    const isDesk = parcel?.isStopdesk === true;
    const stationCode = sid(parcel?.stopdeskId);

    // --- (1) create/order — build the draft. user_guid (apiId) goes in the BODY.
    const createBody: Record<string, unknown> = {
      user_guid: s(creds?.apiId),
      client,
      phone: phoneOf(parcel?.contactPhone as unknown as string),
      adresse: s(parcel?.address).slice(0, 255),
      // Destination wilaya rides in `wilaya_id` below (resolved from the name);
      // the commune NAME is sent verbatim, which is what NOEST routes on.
      commune: s(parcel?.toCommuneName),
      montant: n(parcel?.price), // COD = product subtotal (NOT total-with-shipping)
      produit: s(parcel?.productList),
      type_id: 1, // R4 [LOW]: 1=normal; do NOT expose exchange until verified.
      stop_desk: isDesk ? 1 : 0,
    };
    // reference is optional but min:5 when present — only send a non-empty one.
    if (reference) createBody.reference = reference;
    // NOEST REQUIRES a numeric wilaya_id. This used to be derived ONLY from a
    // desk's station_code ("16A" → 16), which meant HOME delivery — where there
    // is no station_code — never sent the field at all and every such create
    // was rejected upstream. Resolve it from the destination name (the only
    // wilaya ParcelInput actually carries), and keep the station_code
    // derivation as a desk-mode fallback for the case where a desk was picked
    // but the name did not resolve. Unresolvable ⇒ omit, and let NOEST answer
    // with its own typed validation error rather than routing to a guess.
    const wilayaFromName = noestWilayaIdFromName(parcel?.toWilayaName);
    const wilayaId =
      wilayaFromName || (isDesk ? wilayaOfStationCode(stationCode) : 0);
    if (wilayaId) createBody.wilaya_id = wilayaId;
    // station_code is REQUIRED IF stop_desk=1 — send it as a STRING, never coerced.
    if (isDesk && stationCode) createBody.station_code = stationCode;
    // weight is optional (kg).
    if (parcel?.weight !== undefined) createBody.poids = n(parcel.weight);

    const created = await this.request(
      creds,
      'POST',
      'api/public/create/order',
      createBody
    );
    if (!created.ok) return created;
    const tracking = this.trackingOf(created.value);
    if (!tracking) {
      // Create returned 2xx but no tracking we can validate → malformed envelope.
      return courierErr('malformed', {
        message: this.messageOf(created.value) || 'create_no_tracking',
      });
    }

    // --- (2) valid/order — promote the draft so a pickup is scheduled. On ANY
    // failure here the parcel EXISTS as a draft: return a TYPED error carrying the
    // draft tracking so the caller re-drives validation, never re-creates.
    const validated = await this.request(creds, 'POST', 'api/public/valid/order', {
      user_guid: s(creds?.apiId),
      tracking,
    });
    if (!validated.ok) {
      // Preserve the original typed error code (unreachable / upstream_error /
      // bad_request / rate_limited …) but enrich the message with the draft
      // tracking so PR-B can re-validate idempotently rather than re-create.
      const base = validated.error;
      const suffix = `created_not_validated:${tracking}`;
      const prior = validated.message ? `${validated.message}; ` : '';
      return courierErr(base, {
        status: validated.status,
        retryAfter: validated.retryAfter,
        message: `${prior}${suffix}`,
      });
    }

    // Created AND validated → a real, moving parcel.
    const out: ParcelResult = { tracking };
    // Label is EPHEMERAL (R3): build a fresh URL carrying token+tracking. The
    // caller must treat it as short-lived and regenerate on demand.
    const label = this.buildLabelUrl(creds, tracking);
    if (label) out.label = label;
    if (orderId) out.orderId = orderId;
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // trackParcel — POST api/public/get/trackings/info {user_guid, trackings:[t]}.
  // Response is keyed by tracking → {OrderInfo, activity:[...]}. We surface the
  // newest raw status (drives normalizeStatus) + all rows, FILTERING OUT finance
  // events (`verssement_*`, §A.7/R5) so they never drive state. An empty history
  // is a valid result (no events yet), NOT an error.
  // -------------------------------------------------------------------------
  async trackParcel(
    creds: CourierCredentials,
    tracking: string
  ): Promise<CourierResult<TrackResult>> {
    const t = s(tracking).trim();
    if (!t) return courierErr('bad_request', { message: 'missing_tracking' });
    const r = await this.request(creds, 'POST', 'api/public/get/trackings/info', {
      user_guid: s(creds?.apiId),
      trackings: [t],
    });
    if (!r.ok) return r;
    const activity = this.activityOf(r.value, t);
    if (activity === null) return courierErr('malformed');
    const events: TrackEvent[] = [];
    for (const row of activity) {
      const rawStatus = s(row.event ?? row.event_key ?? row.status);
      // FINANCE FILTER: drop verssement_* so lastRawStatus can't become finance.
      if (isNoestFinanceEvent(rawStatus)) continue;
      const ev: TrackEvent = {
        // S1 tries date / created_at / updated_at in that order.
        date: s(row.date ?? row.created_at ?? row.updated_at),
        rawStatus,
      };
      const reason = s(row.reason ?? row.comment ?? row.note);
      if (reason) ev.reason = reason;
      const center = s(row.center_name ?? row.by ?? row.station);
      if (center) ev.centerName = center;
      const wilaya = s(row.wilaya_name ?? row.wilaya);
      if (wilaya) ev.wilayaName = wilaya;
      const commune = s(row.commune_name ?? row.commune ?? row.location);
      if (commune) ev.communeName = commune;
      events.push(ev);
    }
    // NOEST activity is chronological; the LAST kept row is the most recent
    // non-finance state (finance events were filtered above).
    const lastRawStatus = events.length ? events[events.length - 1].rawStatus : '';
    return courierOk({ lastRawStatus, events });
  }

  // -------------------------------------------------------------------------
  // computeFees — GET api/public/fees (§A.6). NOEST prices PER WILAYA, not per
  // commune, and has no express/economic split — a flat tarif (home) +
  // tarif_stopdesk (desk) per wilaya, plus a return tarif. We shoehorn the
  // to-wilaya row into a SINGLE synthetic per-commune entry keyed by the wilaya
  // id: expressHome←tarif, expressDesk←tarif_stopdesk, economic*←null,
  // retourFee←returnPrice. Route is MED; response parsed defensively.
  // -------------------------------------------------------------------------
  async computeFees(
    creds: CourierCredentials,
    fromWilaya: number,
    toWilaya: number
  ): Promise<CourierResult<FeeResult>> {
    const to = n(toWilaya);
    if (!to) return courierErr('bad_request', { message: 'invalid_wilaya' });
    // NOEST infers origin from the account; fromWilaya is accepted for the
    // interface but only echoed back (not sent). We still query the flat fees list.
    const r = await this.request(creds, 'GET', 'api/public/fees');
    if (!r.ok) return r;
    const rows = this.rowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    // Find the row for the destination wilaya (rows carry `wilaya_id`).
    const row = rows.find(x => n(x.wilaya_id) === to) || null;
    const perCommune: Record<string, CommuneFee> = {};
    if (row) {
      // A single synthetic entry keyed by the wilaya id (NOEST prices per wilaya).
      perCommune[String(to)] = {
        communeName: s(row.wilaya_name ?? row.nom),
        expressHome: priceOrNull(row.tarif ?? row.home_delivery ?? row.delivery),
        expressDesk: priceOrNull(row.tarif_stopdesk ?? row.stopdesk),
        economicHome: null, // NOEST has no express/economic split.
        economicDesk: null,
      };
    }
    const out: FeeResult = {
      fromWilayaName: s(fromWilaya ? String(fromWilaya) : ''),
      toWilayaName: row ? s(row.wilaya_name ?? row.nom) : s(String(to)),
      perCommune,
    };
    // Return tarif when the row (or a sibling return group) surfaces it.
    const retour = priceOrNull(row?.return ?? row?.retour ?? row?.return_price ?? row?.tarif_retour);
    if (retour !== null) out.retourFee = retour;
    // No zone / codPercentage / insurance / oversize on NOEST fees → left undefined.
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // listWilayas — GET reference list → rows of {code, nom} (S1 mapper). Route
  // string is LOW (§A.2 gap) — best-guess api/public/get/wilayas under the same
  // family; parsed defensively (tolerate {code,nom} or {id,name}). Also the cheap
  // "test connection" call for the connect route. 69 wilayas.
  // -------------------------------------------------------------------------
  async listWilayas(
    creds: CourierCredentials
  ): Promise<CourierResult<WilayaRef[]>> {
    const r = await this.request(creds, 'GET', 'api/public/get/wilayas');
    if (!r.ok) return r;
    const rows = this.rowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const out: WilayaRef[] = rows.map(row => {
      // NOEST wilaya id is `code`; name is `nom` (tolerate id/name too).
      const w: WilayaRef = {
        id: n(row.code ?? row.id ?? row.wilaya_id),
        name: s(row.nom ?? row.name ?? row.wilaya_name),
      };
      // NOEST does not expose a Yalidine-style pricing zone → leave undefined.
      // S3 exposes an `isActive` per wilaya → map to isDeliverable when present.
      if (row.isActive !== undefined) w.isDeliverable = row.isActive === true;
      else if (row.is_active !== undefined) w.isDeliverable = row.is_active === true;
      else if (row.is_deliverable !== undefined)
        w.isDeliverable = row.is_deliverable === true;
      return w;
    });
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // listCommunes — GET reference list for a wilaya → rows of {nom, wilaya_id,
  // code_postal} (S1 mapper). NOEST has NO numeric commune id (S1 sets id:null,
  // NOEST keys communes by NAME) — so we SYNTHESIZE a stable id from a 1-based
  // index (create sends the commune NAME anyway, so the id is display-only for the
  // FE picker). Route string is LOW (§A.2 gap); parsed defensively.
  // -------------------------------------------------------------------------
  async listCommunes(
    creds: CourierCredentials,
    wilayaId: number
  ): Promise<CourierResult<CommuneRef[]>> {
    const w = n(wilayaId);
    if (!w) return courierErr('bad_request', { message: 'invalid_wilaya' });
    const r = await this.request(
      creds,
      'GET',
      `api/public/get/communes?wilaya_id=${w}`
    );
    if (!r.ok) return r;
    const rows = this.rowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const out: CommuneRef[] = rows.map((row, i) => {
      // Synthesize a stable, non-null id (NOEST commune has none). Prefer a real
      // id if the account ever returns one; else use the 1-based index.
      const realId = n(row.id ?? row.commune_id);
      const c: CommuneRef = {
        id: realId || i + 1,
        name: s(row.nom ?? row.name ?? row.commune_name),
        wilayaId: n(row.wilaya_id) || w,
      };
      // NOEST models desks as separate offices, not a per-commune flag → leave
      // hasStopDesk undefined. S3 adds isActive → map to isDeliverable.
      if (row.isActive !== undefined) c.isDeliverable = row.isActive === true;
      else if (row.is_active !== undefined) c.isDeliverable = row.is_active === true;
      return c;
    });
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // listCenters — GET office list → rows keyed by an ALPHANUMERIC station_code
  // ("16A") with {name, code, address, ...} (S1 mapper). centerId is kept a
  // STRING (never coerced); the desk's wilaya is derived by stripping non-digits
  // from the code ("16A" → 16). Route string is LOW (§A.2 gap); parsed
  // defensively, tolerating either an array of office objects OR an object map
  // keyed by station_code.
  // -------------------------------------------------------------------------
  async listCenters(
    creds: CourierCredentials,
    wilayaId: number
  ): Promise<CourierResult<CenterRef[]>> {
    const w = n(wilayaId);
    if (!w) return courierErr('bad_request', { message: 'invalid_wilaya' });
    const r = await this.request(
      creds,
      'GET',
      `api/public/get/offices?wilaya_id=${w}`
    );
    if (!r.ok) return r;
    const rows = this.centerRowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const out: CenterRef[] = [];
    for (const row of rows) {
      // station_code is the desk selector — KEEP IT A STRING ("16A"). Tolerate the
      // several key spellings a mapper might expose.
      const code = sid(row.code ?? row.station_code ?? row.stationCode ?? row.id);
      const name = s(row.name ?? row.nom);
      if (!code && !name) continue; // junk row
      const digits = wilayaOfStationCode(code);
      // Filter to the requested wilaya when the code encodes one; keep otherwise.
      if (digits && digits !== w) continue;
      const c: CenterRef = {
        centerId: code, // STRING — do NOT coerce "16A" to a number.
        name,
      };
      const address = s(row.address ?? row.adresse);
      if (address) c.address = address;
      const communeName = s(row.commune_name ?? row.commune);
      if (communeName) c.communeName = communeName;
      // Derive wilaya from the code digits (authoritative per S1); fall back to w.
      c.wilayaId = digits || w;
      const wilayaName = s(row.wilaya_name ?? row.wilaya);
      if (wilayaName) c.wilayaName = wilayaName;
      out.push(c);
    }
    return courierOk(out);
  }

  /** SYNC + pure: delegate to the NOEST slug→sub-state map. Unknown ⇒ 'pending'. */
  normalizeStatus(raw: string): CourierStatus {
    return normalizeNoestStatus(raw);
  }

  // -------------------------------------------------------------------------
  // Internal helpers.
  // -------------------------------------------------------------------------

  /**
   * Build an EPHEMERAL label URL (R3): GET api/public/get/order/label carrying the
   * tracking. NOEST's label link expires (~300s per S3), so this is meant to be
   * built fresh on demand, not persisted. The token is sent as a header by the
   * label fetch, so it is NOT interpolated into the URL (never leak a secret in a
   * URL). Returns '' if there is no tracking. `creds` is accepted for symmetry /
   * future signing but intentionally unused in the URL to keep the token out of it.
   */
  private buildLabelUrl(creds: CourierCredentials, tracking: string): string {
    void creds; // token stays in the Authorization header, never in the URL.
    const t = s(tracking).trim();
    if (!t) return '';
    return `${NOEST_BASE}/api/public/get/order/label?tracking=${encodeURIComponent(t)}`;
  }

  /**
   * Extract a tracking number from a create response across the plausible
   * envelope shapes (MED confidence, §A.3): a flat `{tracking}` /
   * `{tracking_number}`, a nested `{OrderInfo:{tracking}}`, or a `{data:{...}}`
   * wrapper around either. Returns '' when none is present. Pure + total (object
   * guards throughout — never derefs a non-object).
   */
  private trackingOf(payload: unknown): string {
    const pick = (o: any): string => {
      if (!o || typeof o !== 'object') return '';
      const direct = s(o.tracking ?? o.tracking_number ?? o.trackingNumber);
      if (direct) return direct;
      const oi = o.OrderInfo ?? o.orderInfo ?? o.order_info;
      if (oi && typeof oi === 'object') {
        const nested = s(oi.tracking ?? oi.tracking_number ?? oi.trackingNumber);
        if (nested) return nested;
      }
      return '';
    };
    if (!payload || typeof payload !== 'object') return '';
    const top = pick(payload);
    if (top) return top;
    const data = (payload as any).data;
    if (data && typeof data === 'object') {
      const inData = pick(data);
      if (inData) return inData;
    }
    return '';
  }

  /**
   * From a trackings/info response (keyed by tracking → {OrderInfo, activity[]}),
   * return the `activity` array for our tracking as OBJECT rows only, `[]` when
   * there are no events yet, or `null` when the envelope is unshaped (→ caller
   * maps to 'malformed'). Tolerates the response being keyed by tracking OR a
   * flat `{activity}` / `{data}` shape.
   *
   * FAIL-SOFT (mirrors Yalidine F-1): the caller reads named fields off each row,
   * so a junk element like `null`/`"x"` would THROW inside the loop and escape the
   * fetch-only try/catch. We filter to object rows HERE at the single choke point.
   */
  private activityOf(payload: unknown, tracking: string): any[] | null {
    const asRows = (v: unknown): any[] | null => {
      if (Array.isArray(v)) return v.filter(r => r != null && typeof r === 'object');
      return null;
    };
    if (!payload || typeof payload !== 'object') return null;
    const obj = payload as Record<string, any>;
    // (a) keyed by our exact tracking → { OrderInfo, activity }.
    const entry = obj[tracking];
    if (entry && typeof entry === 'object') {
      const act = asRows(entry.activity ?? entry.activities ?? entry.events);
      if (act !== null) return act;
      // Entry present but no activity array yet → no events, not an error.
      return [];
    }
    // (b) sole keyed entry (defensive against a normalized key).
    const keys = Object.keys(obj).filter(k => k !== 'data' && k !== 'success');
    if (keys.length === 1) {
      const only = obj[keys[0]];
      if (only && typeof only === 'object') {
        const act = asRows(only.activity ?? only.activities ?? only.events);
        if (act !== null) return act;
      }
    }
    // (c) flat { activity: [...] } or { data: { activity: [...] } }.
    const flat = asRows(obj.activity ?? obj.activities ?? obj.events);
    if (flat !== null) return flat;
    const data = obj.data;
    if (data && typeof data === 'object') {
      const inData = asRows(
        (data as any).activity ?? (data as any).activities ?? (data as any).events
      );
      if (inData !== null) return inData;
    }
    // A 2xx with a keyed-but-empty envelope (no activity anywhere) → no events.
    if (entry !== undefined) return [];
    return null;
  }

  /**
   * Reference-list rows for wilayas/communes/fees. NOEST reference responses are
   * LOW-confidence in shape (§A.2) — tolerate a BARE top-level array, or an
   * object wrapping the rows under `data` / `items` / `results` / `rows`. Return
   * OBJECT rows only (F-1 guard), or `null` when unshaped (→ 'malformed').
   */
  private rowsOf(payload: unknown): any[] | null {
    if (Array.isArray(payload)) {
      return payload.filter(r => r != null && typeof r === 'object');
    }
    if (payload && typeof payload === 'object') {
      const o = payload as Record<string, any>;
      const arr = o.data ?? o.items ?? o.results ?? o.rows ?? o.list;
      if (Array.isArray(arr)) {
        return arr.filter(r => r != null && typeof r === 'object');
      }
    }
    return null;
  }

  /**
   * Office rows for listCenters. NOEST offices are described as KEYED BY
   * station_code (an object map), but a mapper might also return an array —
   * tolerate BOTH. For an object map we fold each value into a row, injecting the
   * KEY as `code` when the value doesn't carry one (so "16A" survives). Returns
   * OBJECT rows only (F-1 guard), or `null` when unshaped.
   */
  private centerRowsOf(payload: unknown): any[] | null {
    // First unwrap the common array wrappers via rowsOf; if that yields rows, use
    // them (offices returned as an array).
    if (Array.isArray(payload)) {
      return payload.filter(r => r != null && typeof r === 'object');
    }
    if (payload && typeof payload === 'object') {
      const o = payload as Record<string, any>;
      const arr = o.data ?? o.offices ?? o.items ?? o.results ?? o.rows ?? o.list;
      if (Array.isArray(arr)) {
        return arr.filter(r => r != null && typeof r === 'object');
      }
      // Object map keyed by station_code → [{code:<key>, ...value}].
      const out: any[] = [];
      for (const key of Object.keys(o)) {
        if (key === 'success' || key === 'message') continue;
        const v = o[key];
        if (v && typeof v === 'object') {
          // Inject the key as `code` when the value lacks one (preserve "16A").
          if (v.code === undefined && v.station_code === undefined) {
            out.push({ ...v, code: key });
          } else {
            out.push(v);
          }
        }
      }
      if (out.length) return out;
      // An empty object map is a valid "no offices" answer, not malformed.
      if (Object.keys(o).length === 0) return [];
    }
    return null;
  }
}

// The shared singleton + self-registration. Importing this module registers the
// provider into clickdz-courier.ts's registry (the controller imports this file,
// so the side-effect runs at boot). Exported too for direct use/testing.
export const noestProvider = new NoestProvider();
registerCourierProvider(noestProvider);
