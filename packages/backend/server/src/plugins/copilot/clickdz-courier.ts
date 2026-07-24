// ---------------------------------------------------------------------------
// R17 (PR-A) — COURIER CORE: the pluggable per-merchant courier abstraction.
//
// This is a PURE logic module (interface + shared types + tiny pure helpers) —
// NO Nest decorators, NO framework error classes, NO Node imports — mirroring
// `clickdz-erp-shipping.ts` / `clickdz-features.ts`. It is therefore boot-safe
// when imported and unit-testable in isolation. Concrete providers
// (`clickdz-courier-yalidine.ts`) own the network I/O (fetch, rate-limit guard,
// error mapping); THIS file owns only the contract + the status normalization
// that maps a courier's own status vocabulary onto ClickDz's 4 courier
// sub-states. Nothing here reads env, throws, or touches a secret.
//
// WHY an abstraction: R17 ships Yalidine first, then ZR Express + Maystro behind
// the SAME interface — one active provider per shop, selected by the sealed
// credential record's `provider` field (see clickdz-courier.controller.ts). A new
// provider is a new file implementing `CourierProvider` + a registry entry; no
// route or controller change.
//
// FAIL-SOFT CONTRACT (pinned): every provider method resolves a discriminated
// union `CourierResult<T>` — { ok:true, value } on success, or a TYPED error
// { ok:false, error, status?, retryAfter? } on ANY failure (network, timeout,
// non-2xx, rate-limit, malformed body). A provider must NEVER throw a raw error
// and NEVER surface/return/log the merchant's API keys. The controller maps the
// typed error to a clean HTTP body; a courier outage can never crash a route or
// regress order state.
// ---------------------------------------------------------------------------

import type { TrackingStatus } from './clickdz-erp-shipping';

// ---------------------------------------------------------------------------
// Provider identity. The registry key + the credential record's authoritative
// `provider` field. One active provider per shop for v1; the credential key is
// per-provider so multi-provider is a later, cheap extension.
// ---------------------------------------------------------------------------

// Every courier ClickDz can integrate. `yalidine` is LIVE. The rest ship DARK
// (R17-PR-D): each is registered but gated OFF per-provider by the controller
// (env `CDZ_COURIER_<ID>=1`) until its BYO creds are validated against the live
// API — so an un-flagged provider 404s exactly like an unregistered one, and
// enabling one is a flag flip, not a deploy. Ecotrack is a GENERIC provider: one
// impl fronts the ~72 couriers that run on the Ecotrack platform, keyed by the
// merchant's own tenant host (see clickdz-courier-ecotrack.ts).
export const COURIER_PROVIDERS = [
  'yalidine',
  'zrexpress',
  'maystro',
  'noest',
  'ecotrack',
] as const;
export type CourierProviderId = (typeof COURIER_PROVIDERS)[number];

/** Type guard: a caller-supplied string is a known provider id. */
export function isCourierProviderId(v: unknown): v is CourierProviderId {
  return (
    typeof v === 'string' &&
    (COURIER_PROVIDERS as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Credentials. The UNSEALED pair a provider sends on every request. Resolved
// ONLY inside an owner-gated route (openSecret on the sealed record) and passed
// straight into a provider call — this module never seals/opens/persists them,
// and a provider must never echo them back or log them.
// ---------------------------------------------------------------------------

/** The unsealed per-merchant courier credentials (Yalidine needs BOTH). */
export interface CourierCredentials {
  /** Yalidine X-API-ID — numeric-looking string (≤20 chars), NOT a number. */
  apiId: string;
  /** Yalidine X-API-TOKEN — opaque string. */
  apiToken: string;
}

// ---------------------------------------------------------------------------
// Reference data (wilaya / commune / center). Shapes normalized across
// providers so the controller + FE consume one contract regardless of courier.
// Driven from the LIVE provider API — never a hardcoded 58-wilaya table (DZ
// moved to 69 wilayas in the Nov 2025 territorial reform).
// ---------------------------------------------------------------------------

/** One wilaya as returned by a provider (id + French name + pricing zone). */
export interface WilayaRef {
  id: number;
  name: string;
  /** Pricing zone (Yalidine 1–5); undefined when the provider omits it. */
  zone?: number;
  /** Whether the courier delivers to this wilaya at all. */
  isDeliverable?: boolean;
}

/** One commune within a wilaya (stop-desk availability drives desk vs home). */
export interface CommuneRef {
  id: number;
  name: string;
  wilayaId: number;
  hasStopDesk?: boolean;
  isDeliverable?: boolean;
}

/**
 * One stop-desk center (desk-pickup office) for a wilaya. `centerId` is
 * `number | string`: Yalidine/ZR use numeric desk ids, but NOEST identifies a
 * desk by an alphanumeric `station_code` (e.g. "16A") — so the shared shape
 * carries either, and each provider reads it back in its own createParcel
 * mapping (a numeric-only provider coerces via its own reader).
 */
export interface CenterRef {
  centerId: number | string;
  name: string;
  address?: string;
  communeId?: number;
  communeName?: string;
  wilayaId?: number;
  wilayaName?: string;
}

/** The reference `kind`s the controller can proxy from a provider. */
export const COURIER_REFERENCE_KINDS = [
  'wilayas',
  'communes',
  'centers',
] as const;
export type CourierReferenceKind = (typeof COURIER_REFERENCE_KINDS)[number];

export function isCourierReferenceKind(v: unknown): v is CourierReferenceKind {
  return (
    typeof v === 'string' &&
    (COURIER_REFERENCE_KINDS as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Parcel create. `ParcelInput` is the provider-agnostic order shape the caller
// (PR-B's "Expédier" action) assembles from an order record; a provider maps it
// onto its own field names. `ParcelResult` is the normalized create outcome —
// tracking + optional label URL. NB (Yalidine gotcha, honored by the impl): a
// 200 does NOT guarantee per-item success; the provider inspects each entry and
// maps a per-item failure to a typed error, so a `ParcelResult` always means a
// real tracking number was issued.
//
// PR-A does NOT expose a create route (that is PR-B); `createParcel` is on the
// interface + implemented by Yalidine now so the contract is complete and the
// provider is testable, but no controller route calls it yet.
// ---------------------------------------------------------------------------

/** Delivery mode — home delivery vs stop-desk pickup (mirrors Shipping). */
export type CourierDeliveryMode = 'home' | 'desk';

/** The provider-agnostic parcel to create (assembled from an order record). */
export interface ParcelInput {
  /** Merchant's order reference — echoed back so the caller can correlate. */
  orderId: string;
  /** Recipient. */
  firstname: string;
  familyname: string;
  contactPhone: string;
  address: string;
  /** Destination (names for create; ids resolved from the reference tables). */
  toWilayaName: string;
  toCommuneName: string;
  /** Origin — the merchant's pickup wilaya (fee origin / parcel from_wilaya). */
  fromWilayaName: string;
  /** Human-readable contents (used for the courier's product_list). */
  productList: string;
  /** COD amount to collect = product subtotal, NOT total-with-shipping. */
  price: number;
  /**
   * Desk pickup vs home delivery; desk requires a stopdeskId. The id is
   * `number | string` for the same reason as CenterRef.centerId (NOEST uses an
   * alphanumeric station_code). A numeric-only provider coerces via its own
   * reader (e.g. Yalidine's `n()` maps a non-numeric to 0/ignored).
   */
  isStopdesk?: boolean;
  stopdeskId?: number | string;
  /** Merchant absorbs delivery when true. */
  freeshipping?: boolean;
  /** Parcel weight in KG (>5KG incurs oversize fees at some couriers). */
  weight?: number;
  /** Economic vs express service class. */
  economic?: boolean;
}

/** The normalized result of a successful parcel create. */
export interface ParcelResult {
  /** The courier's tracking number (persisted on the order in PR-B). */
  tracking: string;
  /** Bordereau/label PDF URL when the courier returns one. */
  label?: string;
  /** The order id the courier echoed back (correlation). */
  orderId?: string;
}

// ---------------------------------------------------------------------------
// Tracking history. `TrackEvent` is one normalized history row; `rawStatus`
// preserves the courier's own (French) status string so the caller can re-run
// normalizeStatus or display it. `trackParcel` returns the raw payload + the
// parsed events.
// ---------------------------------------------------------------------------

/** One normalized tracking-history event. */
export interface TrackEvent {
  /** ISO-ish timestamp string as the courier reports it. */
  date: string;
  /** The courier's own status string (e.g. Yalidine French vocabulary). */
  rawStatus: string;
  /** Optional reason/detail the courier attaches (e.g. "Client absent"). */
  reason?: string;
  centerName?: string;
  wilayaName?: string;
  communeName?: string;
}

/** The normalized result of a tracking lookup. */
export interface TrackResult {
  /** The most recent raw status string (drives normalizeStatus), or ''. */
  lastRawStatus: string;
  /** All history rows, as the courier ordered them. */
  events: TrackEvent[];
}

// ---------------------------------------------------------------------------
// Fees. `FeeResult` is the normalized per-commune fee matrix + the wilaya-level
// surcharges. Any price may be null when the courier does not offer that class.
// ---------------------------------------------------------------------------

/** The four price classes a courier quotes per commune (DZD; null = n/a). */
export interface CommuneFee {
  communeName: string;
  expressHome: number | null;
  expressDesk: number | null;
  economicHome: number | null;
  economicDesk: number | null;
}

/** The normalized fee quote for a (fromWilaya, toWilaya) pair. */
export interface FeeResult {
  fromWilayaName: string;
  toWilayaName: string;
  /** Pricing zone (Yalidine 1–5) when the courier reports it. */
  zone?: number;
  /** Return-shipment fee (DZD). */
  retourFee?: number;
  /** COD commission percentage (e.g. ~1.5). */
  codPercentage?: number;
  /** Insurance percentage applied to declared value when insured. */
  insurancePercentage?: number;
  /** Oversize surcharge (DZD). */
  oversizeFee?: number;
  /** Per-commune price matrix, keyed by commune id (as the courier keys it). */
  perCommune: Record<string, CommuneFee>;
}

// ---------------------------------------------------------------------------
// Typed error + result union. The FAIL-SOFT contract every provider method
// obeys: resolve `CourierResult<T>`, never throw. `error` is a small closed set
// the controller maps to HTTP:
//   'rate_limited'    → 429 upstream (Retry-After surfaced in `retryAfter`)
//   'unauthorized'    → bad/absent merchant creds (401/403 from the courier)
//   'not_found'       → 404 from the courier (unknown tracking, etc.)
//   'bad_request'     → 400 from the courier (validation) — carries `status`
//   'unreachable'     → network/timeout/abort (no HTTP response)
//   'upstream_error'  → any other non-2xx (carries the numeric `status`)
//   'malformed'       → 2xx but the body could not be parsed/shaped
// NONE of these ever carry secret material.
// ---------------------------------------------------------------------------

export type CourierErrorCode =
  | 'rate_limited'
  | 'unauthorized'
  | 'not_found'
  | 'bad_request'
  | 'unreachable'
  | 'upstream_error'
  | 'malformed';

/** A typed provider failure (never thrown — always returned). */
export interface CourierError {
  ok: false;
  error: CourierErrorCode;
  /** The upstream HTTP status when there was an HTTP response. */
  status?: number;
  /** Seconds to wait, parsed from a 429 Retry-After header, when present. */
  retryAfter?: number;
  /** A short, SECRET-FREE upstream message (safe to surface/log). */
  message?: string;
}

/** Success wrapper. */
export interface CourierOk<T> {
  ok: true;
  value: T;
}

/** The fail-soft result every provider method resolves. */
export type CourierResult<T> = CourierOk<T> | CourierError;

/** Tiny constructors so providers stay terse + consistent. */
export function courierOk<T>(value: T): CourierOk<T> {
  return { ok: true, value };
}
export function courierErr(
  error: CourierErrorCode,
  extra?: { status?: number; retryAfter?: number; message?: string }
): CourierError {
  const e: CourierError = { ok: false, error };
  if (extra?.status !== undefined) e.status = extra.status;
  if (extra?.retryAfter !== undefined) e.retryAfter = extra.retryAfter;
  if (extra?.message !== undefined) e.message = extra.message;
  return e;
}

// ---------------------------------------------------------------------------
// COURIER SUB-STATES + normalizeStatus. ClickDz collapses a courier's own
// (often ~30-value) status vocabulary onto FOUR coarse sub-states used by the
// order UI / lifecycle sync:
//
//   'pending'   — created / not yet moving (Yalidine: En préparation, Ramassé…)
//   'shipped'   — in transit / out for delivery (Expédié, Sorti en livraison…)
//   'delivered' — Livré
//   'returned'  — any Retour*/Retourné* terminal-return state
//
// This is the `CourierProvider.normalizeStatus` return type. It is a DELIBERATE
// superset-collapse of `clickdz-erp-shipping.ts`'s TrackingStatus
// ('pris-en-charge' | 'en-route' | 'livre' | 'retour'): the two sub-state
// vocabularies map 1:1 both ways via `courierStatusToTracking` /
// `trackingToCourierStatus` below, so PR-B can feed a normalized courier status
// straight into `Shipping.buildTrackingPatch(...)` (which advances the order's
// canonical `status`) WITHOUT this pure module importing anything from the
// bridge. Keeping the FR-map here (next to the interface) keeps it framework-
// free + unit-testable, exactly as the design asks.
// ---------------------------------------------------------------------------

/** The four coarse courier sub-states (the normalizeStatus contract). */
export const COURIER_STATUSES = [
  'pending',
  'shipped',
  'delivered',
  'returned',
] as const;
export type CourierStatus = (typeof COURIER_STATUSES)[number];

export function isCourierStatus(v: unknown): v is CourierStatus {
  return (
    v === 'pending' || v === 'shipped' || v === 'delivered' || v === 'returned'
  );
}

/**
 * Bridge a coarse courier sub-state → the ERP's `TrackingStatus`
 * (clickdz-erp-shipping.ts). 1:1 and total, so PR-B's sync can do:
 *   const t = courierStatusToTracking(provider.normalizeStatus(raw));
 *   Shipping.buildTrackingPatch(t, now)   // advances order.status
 * 'pending' → 'pris-en-charge' (parcel accepted, order becomes Expédiée);
 * 'shipped' → 'en-route' (still Expédiée); 'delivered' → 'livre' (Livrée);
 * 'returned' → 'retour' (Retournée). Pure — the return type is imported as a
 * TYPE only, so this stays framework-free.
 */
export function courierStatusToTracking(s: CourierStatus): TrackingStatus {
  switch (s) {
    case 'pending':
      return 'pris-en-charge';
    case 'shipped':
      return 'en-route';
    case 'delivered':
      return 'livre';
    case 'returned':
      return 'retour';
  }
}

/** The inverse map (ERP TrackingStatus → coarse courier sub-state). */
export function trackingToCourierStatus(t: TrackingStatus): CourierStatus {
  switch (t) {
    case 'pris-en-charge':
      return 'pending';
    case 'en-route':
      return 'shipped';
    case 'livre':
      return 'delivered';
    case 'retour':
      return 'returned';
  }
}

// ---------------------------------------------------------------------------
// Yalidine FR status → CourierStatus map. Yalidine's ~30 French `last_status` /
// history `status` values (see yalidine-api.md), collapsed to the 4 sub-states.
// Accent spellings are taken VERBATIM from the community SDK types (e.g. `Echèc`,
// `Débloqué`, `Retourné`) since Yalidine's own docs are login-gated. Matching is
// accent- and case-insensitive + whitespace-normalized (see normalizeStatusRaw)
// so a minor accent/case drift on the wire still resolves.
//
// Rationale for the coarse buckets:
//   pending   — not yet handed to transit: pre-ship, prep, pickup-pending,
//               picked-up-but-not-moving, blocked/unblocked (still at origin).
//   shipped   — moving or out for delivery, incl. transfers + at-wilaya +
//               waiting-for-customer/for-courier + failed-attempt (still in the
//               delivery network, not a terminal return).
//   delivered — Livré (the one success terminal).
//   returned  — every Retour*/Retourné* state + failed-exchange (terminal back
//               to sender/center). A failed DELIVERY that has not yet become a
//               formal return stays 'shipped' (the courier will retry); only the
//               explicit Retour*/Retourné*/Echange échoué states are 'returned'.
// A status not in the map ⇒ normalizeStatus returns 'pending' (safe default: a
// never-seen status must not spuriously mark an order delivered/returned).
// ---------------------------------------------------------------------------

const YALIDINE_STATUS_MAP: Readonly<Record<string, CourierStatus>> =
  Object.freeze({
    // --- pending (not yet in transit) ---
    'pas encore expedie': 'pending',
    'a verifier': 'pending',
    'en preparation': 'pending',
    'pas encore ramasse': 'pending',
    'pret a expedier': 'pending',
    ramasse: 'pending',
    bloque: 'pending',
    debloque: 'pending',
    // --- shipped (moving / out for delivery / in-network) ---
    transfert: 'shipped',
    expedie: 'shipped',
    centre: 'shipped',
    'en localisation': 'shipped',
    'vers wilaya': 'shipped',
    'recu a wilaya': 'shipped',
    'en attente du client': 'shipped',
    'pret pour livreur': 'shipped',
    'sorti en livraison': 'shipped',
    'en attente': 'shipped',
    'en alerte': 'shipped',
    'tentative echouee': 'shipped',
    'echec livraison': 'shipped',
    // --- delivered ---
    livre: 'delivered',
    // --- returned (terminal back to center/vendor) ---
    'retour vers centre': 'returned',
    'retourne au centre': 'returned',
    'retour transfert': 'returned',
    'retour groupe': 'returned',
    'retour a retirer': 'returned',
    'retour vers vendeur': 'returned',
    'retourne au vendeur': 'returned',
    'echange echoue': 'returned',
  });

/**
 * Fold a raw status string to the map's key space: lowercase, strip accents
 * (combining marks), collapse internal whitespace, trim. So `"Retourné au
 * vendeur"`, `"RETOURNE AU VENDEUR"`, and `"retourne  au vendeur"` all key to
 * the same entry. Pure + total (never throws on odd input).
 */
export function normalizeStatusRaw(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // drop combining accents
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Map a Yalidine raw status string → a CourierStatus. Unknown/blank ⇒ 'pending'
 * (never spuriously terminal). Exported standalone so it is unit-testable
 * without instantiating the provider; the Yalidine provider's `normalizeStatus`
 * delegates straight here.
 */
export function normalizeYalidineStatus(raw: unknown): CourierStatus {
  const key = normalizeStatusRaw(raw);
  if (!key) return 'pending';
  return YALIDINE_STATUS_MAP[key] ?? 'pending';
}

// ---------------------------------------------------------------------------
// THE PROVIDER CONTRACT. A courier integration implements this. Every network
// method resolves a fail-soft `CourierResult<T>` (never throws, never leaks
// creds). `normalizeStatus` is SYNC + pure (no I/O). `creds` is the unsealed
// pair, resolved + passed by the owner-gated controller.
// ---------------------------------------------------------------------------

export interface CourierProvider {
  /** The provider id — matches the credential record's `provider` field. */
  readonly id: CourierProviderId;

  /**
   * Whether this provider needs BOTH credentials. `true` (Yalidine/ZR/NOEST:
   * id+token; Ecotrack: host+token) ⇒ the connect route requires and seals
   * both, and unseal fails if either is missing. `false` (Maystro: a single
   * `Authorization: Token` — `apiId` is unused/optional) ⇒ the controller
   * requires only `apiToken` and tolerates an empty `apiId`. This is the ONE
   * hook that lets a single-credential provider connect without loosening the
   * two-cred invariant for everyone else.
   */
  readonly requiresApiId: boolean;

  /** Create one parcel from a provider-agnostic order shape (PR-B action). */
  createParcel(
    creds: CourierCredentials,
    parcel: ParcelInput
  ): Promise<CourierResult<ParcelResult>>;

  /** Fetch the tracking history for a tracking number. */
  trackParcel(
    creds: CourierCredentials,
    tracking: string
  ): Promise<CourierResult<TrackResult>>;

  /** Compute the fee matrix for a (fromWilaya, toWilaya) pair. */
  computeFees(
    creds: CourierCredentials,
    fromWilaya: number,
    toWilaya: number
  ): Promise<CourierResult<FeeResult>>;

  /** List all wilayas the courier serves (drives the 69-wilaya reality). */
  listWilayas(creds: CourierCredentials): Promise<CourierResult<WilayaRef[]>>;

  /** List communes for a wilaya. */
  listCommunes(
    creds: CourierCredentials,
    wilayaId: number
  ): Promise<CourierResult<CommuneRef[]>>;

  /** List stop-desk centers for a wilaya. */
  listCenters(
    creds: CourierCredentials,
    wilayaId: number
  ): Promise<CourierResult<CenterRef[]>>;

  /**
   * Collapse a raw provider status string → one of the 4 coarse sub-states.
   * SYNC + pure (no network). Unknown ⇒ 'pending'.
   */
  normalizeStatus(raw: string): CourierStatus;
}

// ---------------------------------------------------------------------------
// PROVIDER REGISTRY. `getCourierProvider(id)` resolves the concrete singleton
// for a provider id, or null for an unknown/not-yet-implemented provider. The
// credential record's `provider` field is authoritative; the controller calls
// this to pick the impl. Registration is done by the concrete module via
// `registerCourierProvider` at import time (the controller imports the Yalidine
// module, whose module-load side-effect registers it) — this keeps THIS pure
// file free of any import cycle to a concrete provider.
// ---------------------------------------------------------------------------

const REGISTRY = new Map<CourierProviderId, CourierProvider>();

/** Register a concrete provider impl (called once at the impl's module load). */
export function registerCourierProvider(provider: CourierProvider): void {
  if (provider && isCourierProviderId(provider.id)) {
    REGISTRY.set(provider.id, provider);
  }
}

/** Resolve the provider for an id, or null when unknown/unimplemented. */
export function getCourierProvider(id: unknown): CourierProvider | null {
  if (!isCourierProviderId(id)) return null;
  return REGISTRY.get(id) ?? null;
}
