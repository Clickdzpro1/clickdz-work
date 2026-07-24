// ---------------------------------------------------------------------------
// R17 (PR-D) — MAYSTRO DELIVERY provider. A concrete `CourierProvider`
// (clickdz-courier.ts) for Maystro Delivery (Algerian courier,
// maystro-delivery.com). Each ClickDz merchant connects THEIR OWN Maystro
// account. Ships DARK behind `CDZ_COURIER_MAYSTRO=1` until BYO creds are
// validated against the live API (see clickdz-courier.controller.ts).
//
// Framework-light (mirrors clickdz-courier-yalidine.ts EXACTLY): this file does
// `fetch`, imports NOTHING from Nest, and throws NOTHING. Every method obeys the
// fail-soft contract from clickdz-courier.ts: resolve `CourierResult<T>` — a
// typed error on any failure, never a raw throw. The merchant's token is read
// from `creds`, sent as an `Authorization` header, and NEVER logged or returned.
//
// SOURCES / CONFIDENCE (see /agent/workspace/research/maystro.md — graded):
//   Official GitBook docs (authoritative) + two open-source SDKs (KaziSTM/vargo,
//   PiteurStudio/CourierDZ) + an Odoo connector, cross-validated.
//   - auth (single `Authorization: Token`)        HIGH
//   - listWilayas / listCommunes                  HIGH  (path prefix `shared/` MED)
//   - trackParcel (history_order, numeric status) HIGH  (path prefix MED)
//   - normalizeStatus (numeric-code map)          HIGH
//   - computeFees (per-commune, one price/call)   MED   (FeeResult fit + cost)
//   - listCenters                                 LOW   (no desk-list endpoint)
//   - createParcel                                HIGH on mechanics /
//                                                 BLOCKED end-to-end (see below)
//
// ---------------------------------------------------------------------------
// SINGLE-TOKEN CREDENTIAL MODEL (this is the ONE provider with
// `requiresApiId = false`).
//   Auth is a single header: `Authorization: Token <apiToken>`. There is NO
//   X-API-ID equivalent. `CourierCredentials.apiId` is UNUSED by every method
//   here and is a PLACEHOLDER for Maystro: the controller allows a BLANK apiId
//   for token-only providers (it seals '' at connect; unseal returns '' which is
//   valid — see resolveCreds/`requiresApiId` in the controller). We therefore
//   guard on `apiToken` ONLY (never on apiId), unlike Yalidine which requires
//   both. NEVER interpolate apiId into a URL/header.
//   FORWARD PATH (spec R2): if product pre-registration is ever implemented,
//   `apiId` is the natural place to carry the Maystro `store_id` (a UUID) that
//   the product/stock endpoints require — at which point the {apiId, apiToken}
//   pair becomes fully used. Documented here so a future change is a field
//   repurpose, not a schema change.
//
// ---------------------------------------------------------------------------
// ⚠️ createParcel BLOCKER (R2 — HARD, HONORED, NOT FAKED).
//   Maystro's create (`POST /api/stores/orders/`) REQUIRES a non-empty
//   `products[]` whose `product_id` references a product that ALREADY EXISTS in
//   the merchant's Maystro store (the uuid `id` from `POST /api/stores/product/`).
//   You CANNOT create an order with an arbitrary ad-hoc product string — an
//   unknown id is rejected. ClickDz's `ParcelInput` carries only a FREE-TEXT
//   `productList` and has NO Maystro product id. So a real create cannot work
//   end-to-end yet.
//   THEREFORE this provider's `createParcel` returns a TYPED, SECRET-FREE
//   `courierErr('bad_request', { message: 'maystro_product_registration_required' })`
//   and performs NO network I/O. It NEVER attempts a broken create and NEVER
//   throws. This is the intended, honest SCAFFOLD behaviour — track/fees/
//   reference all work; create is guarded until R2 is resolved.
//   FORWARD PATH for whoever wires create later (spec §Ref-data + R2):
//     (a) register a single generic/reusable store product at connect time and
//         reuse its id for every order (per-line `logistical_description` still
//         carries the human contents) — pragmatic v1, MUST be confirmed live; or
//     (b) full catalog sync / per-order auto-register (POST /api/stores/product/,
//         cache a SKU→product-id map, needs the store_id UUID → apiId); or
//     (c) require merchants to pre-map their catalog in a setup step.
//   AND: Maystro create also needs INTEGER wilaya/commune ids, but `ParcelInput`
//   gives NAMES (`toWilayaName`/`toCommuneName`). A real create must first
//   resolve names → Maystro ids via listWilayas/listCommunes (reconcile by name,
//   accent/case-folded) — more work the scaffold intentionally defers.
//
// ⚠️ R1 — `product_price` semantics are CONTRADICTORY in Maystro's own docs.
//   The create field table says `product_price` = "Total price of the order
//   INCLUDING delivery fees", but the response example labels it "without
//   delivery fees", and vargo maps its COD amount straight to `product_price`.
//   ClickDz `ParcelInput.price` is defined as "COD subtotal, NOT total-with-
//   shipping". Sending the wrong one makes the courier COLLECT THE WRONG AMOUNT.
//   Whoever wires create MUST confirm COD semantics with a LIVE test order
//   (create → read back / check dashboard) before trusting either reading. Also
//   `ParcelInput.freeshipping` has no Maystro field — decide how "merchant
//   absorbs delivery" is expressed (likely via what goes in `product_price`).
//
// ---------------------------------------------------------------------------
// NO SANDBOX (R7). Neither the official docs nor any SDK document a test/sandbox
// mode, rate limits, throttling headers, or 429s. We ASSUME NO SANDBOX (verify
// live against a real then-cancelled order) and implement the SAME fail-soft
// 429 / Retry-After handling as Yalidine defensively — harmless if never fired.
//
// OPEN RISKS to verify with real creds (see maystro.md "Open risks"):
//   R1 product_price include-vs-exclude-delivery (COD correctness) — BLOCK create.
//   R2 product pre-registration (create blocker) — pick forward path (a/b/c).
//   R3 fee fan-out cost (60–120 calls/wilaya, no bulk endpoint) — product call.
//   R4 stop-desk: is delivery_type:2 alone enough? is a stopdesk_id ever needed?
//   R5 auth prefix `Token ` + host alias (backend. vs b.) — one live 200 settles.
//   R6 path drift: `shared/` vs `base/`, `stores/history_order/` vs `orders/…`.
//   R7 real rate limits / sandbox existence.
//   R8 wilaya numbering (58 partial ids, Maystro-internal ≠ ClickDz canonical).
// ---------------------------------------------------------------------------

import {
  courierErr,
  courierOk,
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

// --- Config (module-load constants; base is env-overridable exactly like the
// Yalidine provider). `backend.` is the canonical host (most widely documented);
// `b.maystro-delivery.com` is a documented alias (R5). NEVER interpolates a secret.
const MAYSTRO_BASE = (
  process.env.CDZ_MAYSTRO_BASE || 'https://backend.maystro-delivery.com/api'
).replace(/\/+$/, '');

// Bounded per-call timeout. Maystro calls are quick control-plane/reference
// lookups; a hung upstream must not hold a request thread. 15s (mirrors Yalidine).
const MAYSTRO_TIMEOUT_MS = 15_000;

// computeFees fan-out cap (R3). Maystro prices ONE (commune, delivery_type,
// express) per call with NO bulk endpoint, so a full wilaya matrix would cost
// 2×(commune count) requests (60–120). We NEVER loop unboundedly: cap the number
// of communes we price in a single computeFees call and null the rest, keeping
// the method bounded + fail-soft. The matrix is best-effort; the FeeResult
// documents the truncation is a Maystro cost limitation, not a courier gap.
const MAYSTRO_FEE_MAX_COMMUNES = 12;

// ---------------------------------------------------------------------------
// Loose scalar readers for the schemaless JSON Maystro returns (identical to the
// Yalidine provider's, so this file stays dependency-free).
// ---------------------------------------------------------------------------
function s(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
/** A price cell: a finite number, or null ("n/a"/not offered). */
function priceOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

// ---------------------------------------------------------------------------
// Numeric status map + normalizeMaystroStatus (spec §Status). Maystro history
// rows / webhooks give an INTEGER `status`; the provider stringifies it into
// `TrackEvent.rawStatus`, and normalizeStatus does a NUMERIC lookup (NOT the
// accent-folding text path Yalidine uses). Defined LOCALLY here (not in the pure
// clickdz-courier.ts) so this scaffold is self-contained and the pure module is
// untouched; it stays pure + framework-free all the same. 18 codes (4–53) →
// 4 ClickDz sub-states; unknown/blank ⇒ 'pending' (never spuriously terminal).
//
// Bucket rationale (fuses official meanings with vargo's normalizer, same
// philosophy as the Yalidine map — a failed ATTEMPT stays 'shipped'; only an
// explicit return/abort is 'returned'):
//   pending   4 CREATED, 5 PICK_UP_REQUESTED, 6 IN_PROCESS, 8 WAITING_TRANSIT,
//             11 PENDING, 12 OUT_OF_STOCK, 15 READY_TO_SHIP, 22 ASSIGNED
//   shipped   9 IN_TRANSIT_TO_BE_SHIPPED, 31 SHIPPED, 32 ALERTED (issue while
//             out for delivery), 42 POSTPONED (retryable in-network attempt)
//   delivered 41 DELIVERED (the one success terminal)
//   returned  10 IN_TRANSIT_TO_BE_RETURNED, 50 ABORTED, 51 READY_TO_RETURN,
//             52 TAKEN_BY_STORE, 53 NOT_RECEIVED (all terminal-return paths)
// (32 and 42 are the two deliberate deviations from vargo's raw buckets — see
// the spec; both are non-terminal so mapping them to 'shipped' is safe.)
// ---------------------------------------------------------------------------
const MAYSTRO_STATUS_MAP: Readonly<Record<number, CourierStatus>> =
  Object.freeze({
    // --- pending (created / not yet moving / blocked at origin) ---
    4: 'pending',
    5: 'pending',
    6: 'pending',
    8: 'pending',
    11: 'pending',
    12: 'pending',
    15: 'pending',
    22: 'pending',
    // --- shipped (in transit / out for delivery / retryable attempt) ---
    9: 'shipped',
    31: 'shipped',
    32: 'shipped',
    42: 'shipped',
    // --- delivered ---
    41: 'delivered',
    // --- returned (terminal back to store) ---
    10: 'returned',
    50: 'returned',
    51: 'returned',
    52: 'returned',
    53: 'returned',
  });

/**
 * Map a Maystro numeric status (as a string OR number) → a CourierStatus.
 * Non-numeric / unknown / blank ⇒ 'pending' (never spuriously terminal).
 * Pure + total (never throws on odd input). Exported standalone so it is
 * unit-testable without instantiating the provider.
 */
export function normalizeMaystroStatus(raw: string | number): CourierStatus {
  const code = Number(String(raw).trim());
  if (!Number.isFinite(code)) return 'pending';
  return MAYSTRO_STATUS_MAP[code] ?? 'pending';
}

// ---------------------------------------------------------------------------
// Map an HTTP Response status (or a network failure) to a typed CourierError.
// Reads Retry-After on a 429. NEVER reads/echoes credentials. `bodyMsg` is a
// short, secret-free upstream message when we could cheaply extract one.
// Identical shape to the Yalidine provider's `errorFromStatus`.
// ---------------------------------------------------------------------------
function errorFromStatus(status: number, bodyMsg?: string, retryAfter?: number) {
  if (status === 429) {
    return courierErr('rate_limited', {
      status,
      retryAfter,
      message: bodyMsg,
    });
  }
  if (status === 401 || status === 403) {
    return courierErr('unauthorized', { status, message: bodyMsg });
  }
  if (status === 404) {
    return courierErr('not_found', { status, message: bodyMsg });
  }
  if (status === 400) {
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
// The Maystro provider. One stateless singleton (registered at module load).
// Every network method: build the URL, attach the single auth header, 15s abort,
// then map the outcome to CourierResult. A thrown fetch (network/timeout/abort)
// → 'unreachable'; a non-2xx → the typed status map; a 2xx with an unparseable /
// unexpected body → 'malformed'. Mirrors YalidineProvider's structure exactly.
// ---------------------------------------------------------------------------
class MaystroProvider implements CourierProvider {
  readonly id = 'maystro' as const;
  /**
   * Maystro is TOKEN-ONLY: a single `Authorization: Token`. `apiId` is unused
   * (placeholder), so the controller connects with just the token and seals an
   * empty apiId. This is the ONE provider with `requiresApiId = false`.
   */
  readonly requiresApiId = false as const;

  /**
   * The single auth header from the unsealed creds. Maystro has NO X-API-ID
   * equivalent — apiId is intentionally NOT read here. The literal `Token `
   * prefix + a space is required (official docs + CourierDZ). NEVER logs.
   */
  private authHeaders(creds: CourierCredentials): Record<string, string> {
    return {
      Authorization: `Token ${s(creds?.apiToken)}`,
      Accept: 'application/json',
    };
  }

  /**
   * Core request → typed result carrying the parsed JSON. Reads the body ONCE.
   * On a non-2xx it best-effort extracts Maystro's `{detail}` (secret-free) and,
   * for a 429, the Retry-After. On a thrown fetch → 'unreachable'. Never logs
   * headers/creds; never throws.
   */
  private async request(
    creds: CourierCredentials,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    body?: unknown
  ): Promise<CourierResult<unknown>> {
    // Guard: TOKEN ONLY must be present before any network traffic (apiId is
    // unused for Maystro, so — unlike Yalidine — we do NOT require it). Maystro
    // 401s on a missing/blank token anyway; this avoids a pointless round-trip.
    if (!s(creds?.apiToken)) {
      return courierErr('unauthorized', { message: 'missing_credentials' });
    }
    const url = `${MAYSTRO_BASE}${path}`;
    const headers: Record<string, string> = this.authHeaders(creds);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(MAYSTRO_TIMEOUT_MS),
      });
    } catch {
      // Network error / DNS / connection reset / AbortSignal timeout.
      return courierErr('unreachable');
    }
    // Read the body once, defensively. Maystro returns JSON for success and
    // typed errors ({detail, status_code}); a proxy could return non-JSON on 5xx.
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
      // Maystro errors are `{detail, status_code}` (NOT Yalidine's `{message}`);
      // fall back to `message` just in case a proxy reshapes it. Secret-free.
      const msg =
        json && typeof json === 'object'
          ? s((json as any).detail || (json as any).message).slice(0, 200) ||
            undefined
          : undefined;
      return errorFromStatus(res.status, msg, parseRetryAfter(res));
    }
    return courierOk(json);
  }

  // -------------------------------------------------------------------------
  // createParcel — BLOCKED (R2). Maystro create requires products[].product_id
  // referencing a PRE-REGISTERED store product; ClickDz's ParcelInput carries
  // only a free-text productList (no Maystro product id) AND names (not the
  // integer wilaya/commune ids Maystro's create needs). A real create therefore
  // cannot work end-to-end yet. We return a TYPED, secret-free error and do NO
  // network I/O — we NEVER attempt a broken create and NEVER throw. See the
  // header NOTE for the forward path (register a generic store product at
  // connect / full catalog sync / pre-map) and R1 (product_price COD semantics
  // must be confirmed with a live test before create is trusted).
  // -------------------------------------------------------------------------
  async createParcel(
    _creds: CourierCredentials,
    _parcel: ParcelInput
  ): Promise<CourierResult<ParcelResult>> {
    // Honest scaffold: guarded, not faked. No fetch, no throw, no secret.
    return courierErr('bad_request', {
      message: 'maystro_product_registration_required',
    });
  }

  // -------------------------------------------------------------------------
  // trackParcel — GET /stores/history_order/{id} → [{status:int, created_at,
  // comment}] (chronological). We surface the newest numeric status (stringified,
  // drives normalizeStatus) + all rows. `{id}` is the order uuid from create.
  // An empty history is a VALID result (no events yet), NOT an error. (Path
  // caveat R6: `orders/history_order/{id}` is a documented fallback if this 404s
  // on a valid order — not auto-retried in the scaffold to keep behaviour honest.)
  // -------------------------------------------------------------------------
  async trackParcel(
    creds: CourierCredentials,
    tracking: string
  ): Promise<CourierResult<TrackResult>> {
    const t = s(tracking).trim();
    if (!t) return courierErr('bad_request', { message: 'missing_tracking' });
    const r = await this.request(
      creds,
      'GET',
      `/stores/history_order/${encodeURIComponent(t)}`
    );
    if (!r.ok) return r;
    const rows = this.rowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const events: TrackEvent[] = rows.map(row => {
      // Numeric status → store as a STRING (normalizeStatus does a numeric
      // lookup). No center/wilaya/commune in Maystro history rows.
      const ev: TrackEvent = {
        date: s(row.created_at),
        rawStatus: s(row.status),
      };
      const reason = s(row.comment);
      if (reason) ev.reason = reason;
      return ev;
    });
    // Maystro history is chronological; the LAST row is the most recent state.
    const lastRawStatus = events.length
      ? events[events.length - 1].rawStatus
      : '';
    return courierOk({ lastRawStatus, events });
  }

  // -------------------------------------------------------------------------
  // computeFees — Maystro prices PER COMMUNE, split by delivery_type (1=home /
  // 2=desk) and express (bool), ONE price per call, with NO bulk endpoint and NO
  // from-wilaya input (origin = store's fixed warehouse). So the wilaya-signature
  // method is an impedance mismatch (spec R3):
  //   - `fromWilaya` is IGNORED (no origin input).
  //   - `toWilaya` selects which communes to price.
  //   - We map Maystro's STANDARD (express=false) home/desk price into
  //     expressHome/expressDesk (ClickDz's only "standard" home/desk slots);
  //     economicHome/economicDesk are ALWAYS null (Maystro has no economic tier).
  //   - A 404 on a given (commune, delivery_type) means "not offered" → null.
  // BOUNDED (never loops unbounded): we price at most MAYSTRO_FEE_MAX_COMMUNES
  // communes (2 calls each) and null the rest — best-effort matrix, honestly
  // truncated. NEVER throws: a listCommunes failure or any per-cell error yields
  // null cells, not an exception. retour/cod/insurance/oversize are omitted
  // (Maystro's pricing API exposes none — do NOT invent numbers).
  // -------------------------------------------------------------------------
  async computeFees(
    creds: CourierCredentials,
    fromWilaya: number,
    toWilaya: number
  ): Promise<CourierResult<FeeResult>> {
    const to = n(toWilaya);
    if (!to) {
      return courierErr('bad_request', { message: 'invalid_wilaya' });
    }
    // Resolve the communes to price for this wilaya. If listCommunes fails we
    // surface that typed error (it already went through the fail-soft request()).
    const communesResult = await this.listCommunes(creds, to);
    if (!communesResult.ok) return communesResult;
    const communes = communesResult.value;

    const perCommune: Record<string, CommuneFee> = {};
    // Bound the fan-out. Price the first N communes fully; the rest are recorded
    // with null cells so the matrix key set is complete but the cost is capped.
    const priced = communes.slice(0, MAYSTRO_FEE_MAX_COMMUNES);
    const rest = communes.slice(MAYSTRO_FEE_MAX_COMMUNES);

    for (const c of priced) {
      const communeId = n(c.id);
      if (!communeId) continue;
      // Standard (express=false) home + desk. Each is best-effort; a 404 or any
      // typed error → null (never throws, never aborts the whole matrix).
      const expressHome = await this.deliveryPrice(creds, communeId, 1);
      const expressDesk = await this.deliveryPrice(creds, communeId, 2);
      perCommune[String(communeId)] = {
        communeName: s(c.name),
        expressHome,
        expressDesk,
        economicHome: null,
        economicDesk: null,
      };
    }
    // Communes beyond the cap: complete the key set with null cells (documents
    // the truncation as a Maystro cost limitation, not a courier gap).
    for (const c of rest) {
      const communeId = n(c.id);
      if (!communeId) continue;
      perCommune[String(communeId)] = {
        communeName: s(c.name),
        expressHome: null,
        expressDesk: null,
        economicHome: null,
        economicDesk: null,
      };
    }

    // fromWilayaName: Maystro has no origin input; leave '' (name unknown here).
    // toWilayaName: best-effort from a commune row's wilaya id is not a name, so
    // leave '' — the controller/FE reconciles Maystro ids → names. zone/retour/
    // cod/insurance/oversize all omitted (not exposed by Maystro's pricing API).
    const out: FeeResult = {
      fromWilayaName: '',
      toWilayaName: '',
      perCommune,
    };
    return courierOk(out);
  }

  /**
   * One best-effort per-commune price lookup: GET /stores/delivery_price/
   * ?commune=&delivery_type=&express=false → { delivery_price:number }.
   * Returns the number, or null on a 404 ("not offered"), any typed error, or a
   * malformed body. NEVER throws — this is the fail-soft cell reader computeFees
   * fans out over.
   */
  private async deliveryPrice(
    creds: CourierCredentials,
    communeId: number,
    deliveryType: 1 | 2
  ): Promise<number | null> {
    const r = await this.request(
      creds,
      'GET',
      `/stores/delivery_price/?commune=${communeId}&delivery_type=${deliveryType}&express=false`
    );
    if (!r.ok) return null; // 404 = not offered; any error → null cell.
    const d = r.value;
    if (!d || typeof d !== 'object') return null;
    return priceOrNull((d as any).delivery_price);
  }

  // -------------------------------------------------------------------------
  // listWilayas — GET /shared/wilayas/?country=1&language=en → an ARRAY OF
  // [id, name] PAIRS (2-element arrays), NOT objects (no zone / is_deliverable).
  // This is THE source of the live wilaya set (58 partial, Maystro-internal ids —
  // never hardcoded) AND the controller's connect-time credential-validation
  // call (a valid token 200s; a bad token 401s → unauthorized). (Path caveat R6:
  // `base/wilayas/` is a documented fallback if `shared/` 404s.)
  // -------------------------------------------------------------------------
  async listWilayas(
    creds: CourierCredentials
  ): Promise<CourierResult<WilayaRef[]>> {
    const r = await this.request(
      creds,
      'GET',
      '/shared/wilayas/?country=1&language=en'
    );
    if (!r.ok) return r;
    const rows = this.pairsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const out: WilayaRef[] = rows.map(pair => {
      // pair = [id, name]. zone/isDeliverable are not provided → leave undefined.
      const w: WilayaRef = { id: n(pair[0]), name: s(pair[1]) };
      return w;
    });
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // listCommunes — GET /shared/communes/?wilaya={id} → [{id,wilaya,name,
  // postcode,zone}]. `wilayaId` ← `wilaya`. hasStopDesk/isDeliverable are unknown
  // from this endpoint (left undefined). Maystro's commune `zone` is an internal
  // pricing bucket, NOT the Yalidine 1–5 — deliberately NOT surfaced.
  // (Defensive: if a large wilaya ever paginates into a {list:{results}} wrapper,
  // rowsOf/pairsOf handle a bare array; a wrapped array is handled by rowsOf.)
  // -------------------------------------------------------------------------
  async listCommunes(
    creds: CourierCredentials,
    wilayaId: number
  ): Promise<CourierResult<CommuneRef[]>> {
    const w = n(wilayaId);
    if (!w) return courierErr('bad_request', { message: 'invalid_wilaya' });
    const r = await this.request(creds, 'GET', `/shared/communes/?wilaya=${w}`);
    if (!r.ok) return r;
    const rows = this.rowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const out: CommuneRef[] = rows.map(row => {
      const c: CommuneRef = {
        id: n(row.id),
        name: s(row.name),
        wilayaId: n(row.wilaya) || w,
      };
      return c;
    });
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // listCenters — NO desk-list endpoint exists (spec §6, LOW). Maystro routes
  // stop-desk by commune via `delivery_type:2` on create, not by a caller-chosen
  // desk id — so there is no station list to return and ParcelInput.stopdeskId
  // has no Maystro create field (R4). We return an EMPTY list (a valid, honest
  // "no center list available") rather than erroring, so the controller's
  // reference proxy degrades gracefully. NEVER hits the network.
  // -------------------------------------------------------------------------
  async listCenters(
    _creds: CourierCredentials,
    _wilayaId: number
  ): Promise<CourierResult<CenterRef[]>> {
    // NOTE: intentionally no network call — Maystro exposes no desk-list endpoint.
    return courierOk([]);
  }

  /** SYNC + pure: delegate to the numeric Maystro status map. */
  normalizeStatus(raw: string): CourierStatus {
    return normalizeMaystroStatus(raw);
  }

  /**
   * Maystro OBJECT-list responses are a bare JSON array of row objects (communes,
   * history). Return the array filtered to OBJECT rows, or `null` when the shape
   * is unexpected (→ the caller maps to 'malformed'). Also tolerates a
   * `{list:{results:[...]}}` / `{data:[...]}` wrapper defensively (some Maystro
   * endpoints paginate that way).
   *
   * FAIL-SOFT (Waybill F-1 — do NOT reintroduce the live bug): every caller
   * `.map`s the returned rows and reads named fields off each (`s(row.status)`,
   * `n(row.id)`, …). A malformed upstream payload like `[null]` / `["x"]` /
   * `{data:[null]}` would make that deref THROW a TypeError *inside* the map —
   * escaping `request()`'s fetch-only try/catch and breaking the never-throw
   * provider contract. So we filter to OBJECT rows here, at the single choke
   * point: well-formed responses are unaffected (every real row is an object),
   * and a junk element is dropped rather than crashing the request. computeFees
   * guards its cells inline and does not use this.
   */
  private rowsOf(payload: unknown): any[] | null {
    if (Array.isArray(payload)) {
      return payload.filter(r => r != null && typeof r === 'object');
    }
    if (payload && typeof payload === 'object') {
      const p = payload as any;
      // {data:[...]} wrapper.
      if (Array.isArray(p.data)) {
        return p.data.filter((r: unknown) => r != null && typeof r === 'object');
      }
      // {list:{results:[...]}} wrapper (Maystro orders/products style).
      if (p.list && typeof p.list === 'object' && Array.isArray(p.list.results)) {
        return p.list.results.filter(
          (r: unknown) => r != null && typeof r === 'object'
        );
      }
    }
    return null;
  }

  /**
   * listWilayas returns an array of [id, name] PAIRS (2-element arrays), NOT
   * objects — so rowsOf (which filters to objects) would drop every row. This is
   * the pair-specific choke point: return the array filtered to non-empty ARRAY
   * rows (each real row is a 2-tuple), or `null` on an unexpected shape.
   *
   * FAIL-SOFT (same F-1 discipline): a junk element like `[null, 5]` still keys
   * safely because the caller reads `pair[0]`/`pair[1]` through `n()`/`s()`
   * (both total on any input), and we only admit rows that ARE arrays — so
   * `{data:[null]}`-style junk can never make the `.map` throw.
   */
  private pairsOf(payload: unknown): any[][] | null {
    if (Array.isArray(payload)) {
      return payload.filter(r => Array.isArray(r) && r.length >= 2);
    }
    if (payload && typeof payload === 'object') {
      const p = payload as any;
      if (Array.isArray(p.data)) {
        return p.data.filter((r: unknown) => Array.isArray(r) && r.length >= 2);
      }
    }
    return null;
  }
}

// The shared singleton + self-registration. Importing this module registers the
// provider into clickdz-courier.ts's registry (the controller imports this file,
// so the side-effect runs at boot). Exported too for direct use/testing.
export const maystroProvider = new MaystroProvider();
registerCourierProvider(maystroProvider);
