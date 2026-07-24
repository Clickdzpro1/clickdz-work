// ---------------------------------------------------------------------------
// R17 (PR-A) — YALIDINE provider. The first concrete `CourierProvider`
// (clickdz-courier.ts). Yalidine is Algeria's dominant courier; each ClickDz
// merchant connects THEIR OWN Yalidine account (X-API-ID + X-API-TOKEN from
// their dashboard — BYO-per-shop, verified-business account required).
//
// Framework-light: this file does `fetch` (mirroring how the bridge — not the
// pure Shipping module — owns network I/O), but imports NOTHING from Nest and
// throws NOTHING. Every method obeys the fail-soft contract from
// clickdz-courier.ts: resolve `CourierResult<T>` — a typed error on any
// failure, never a raw throw. The merchant's keys are read from `creds`, sent
// as headers, and NEVER logged or returned.
//
// API facts (live-verified 2026-07-23, yalidine-api.md):
//   Base    https://api.yalidine.app/v1/   (trailing slash matters on collections)
//   Auth    headers X-API-ID + X-API-TOKEN  (both required; 401 if either absent)
//   Create  POST /parcels/  — body is ALWAYS a JSON ARRAY; response is an OBJECT
//           keyed by order_id → { success, tracking, label, import_id, message }.
//           A 200 does NOT imply per-item success → inspect the entry.
//   Track   GET  /histories/{tracking}      → { data: [History] }
//   Fees    GET  /fees/?from_wilaya_id=&to_wilaya_id=
//   Wilayas GET  /wilayas/                  → { data: [{id,name,zone,is_deliverable}] }
//   Communes GET /communes/?wilaya_id=      → { data: [...] } (paginated)
//   Centers GET  /centers/?wilaya_id=       → { data: [...] }
//   Limits  ~5/s, 50/min, 1000/hr, 10000/day → 429 + Retry-After. NO sandbox.
//   Wilayas 58→69 since Nov 2025 — we DRIVE off /wilayas, never hardcode.
// ---------------------------------------------------------------------------

import {
  courierErr,
  courierOk,
  normalizeYalidineStatus,
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

// --- Config (module-load constants; the base is env-overridable for resellers
// e.g. Guepex/Goupex, which share the identical API under their own host, but
// defaults to the documented production host). NEVER interpolates a secret.
const YALIDINE_BASE = (
  process.env.CDZ_YALIDINE_BASE || 'https://api.yalidine.app/v1'
).replace(/\/+$/, '');

// Bounded per-call timeout. Yalidine calls are quick control-plane/reference
// lookups; a hung upstream must not hold a request thread. 15s per the design.
const YALIDINE_TIMEOUT_MS = 15_000;

// Communes are paginated (~1,540 rows); pull a large page so one call suffices
// for a single wilaya (the controller only ever lists communes for ONE wilaya).
const COMMUNE_PAGE_SIZE = 1900;

// ---------------------------------------------------------------------------
// Loose scalar readers for the schemaless JSON Yalidine returns (mirror the
// bridge's erpStr/erpNum so this file stays dependency-free).
// ---------------------------------------------------------------------------
function s(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
/** A price cell: a finite number, or null (Yalidine uses null for "n/a"). */
function priceOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

// ---------------------------------------------------------------------------
// Map an HTTP Response (or a network failure) to a typed CourierError. Reads
// Retry-After on a 429. NEVER reads/echoes credentials. `bodyMsg` is a short,
// secret-free upstream message when we could cheaply extract one.
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
// The Yalidine provider. One stateless singleton (registered at module load).
// Every method: build the URL, attach the two auth headers, 15s abort, then map
// the outcome to CourierResult. A thrown fetch (network/timeout/abort) →
// 'unreachable'; a non-2xx → the typed status map; a 2xx with an unparseable /
// unexpected body → 'malformed'.
// ---------------------------------------------------------------------------
class YalidineProvider implements CourierProvider {
  readonly id = 'yalidine' as const;
  /** Yalidine needs BOTH X-API-ID and X-API-TOKEN. */
  readonly requiresApiId = true as const;

  /** Build the two required auth headers from the unsealed creds. */
  private authHeaders(creds: CourierCredentials): Record<string, string> {
    return {
      'X-API-ID': s(creds?.apiId),
      'X-API-TOKEN': s(creds?.apiToken),
      Accept: 'application/json',
    };
  }

  /**
   * Core request → typed result carrying the parsed JSON. Reads the body ONCE.
   * On a non-2xx it best-effort extracts Yalidine's `{message}` (secret-free)
   * and, for a 429, the Retry-After. On a thrown fetch → 'unreachable'. Never
   * logs headers/creds; never throws.
   */
  private async request(
    creds: CourierCredentials,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<CourierResult<unknown>> {
    // Guard: both creds must be present before any network traffic (Yalidine
    // 401s on a missing header anyway, but this avoids a pointless round-trip
    // and a confusing upstream error).
    if (!s(creds?.apiId) || !s(creds?.apiToken)) {
      return courierErr('unauthorized', { message: 'missing_credentials' });
    }
    const url = `${YALIDINE_BASE}${path}`;
    const headers: Record<string, string> = this.authHeaders(creds);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(YALIDINE_TIMEOUT_MS),
      });
    } catch {
      // Network error / DNS / connection reset / AbortSignal timeout.
      return courierErr('unreachable');
    }
    // Read the body once, defensively (Yalidine returns JSON for both success
    // and typed errors; a proxy could return non-JSON on a 5xx).
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
      const msg =
        json && typeof json === 'object' && 'message' in (json as any)
          ? s((json as any).message).slice(0, 200)
          : undefined;
      return errorFromStatus(res.status, msg, parseRetryAfter(res));
    }
    return courierOk(json);
  }

  // -------------------------------------------------------------------------
  // createParcel — POST /parcels/ with a single-element ARRAY. Yalidine's
  // response is an OBJECT keyed by our order_id; a 200 does NOT guarantee the
  // item succeeded, so we locate our entry and require entry.success + a
  // tracking. Missing/failed entry → a typed 'bad_request' (carrying the
  // courier's per-item message when present). NOT wired to a route in PR-A.
  // -------------------------------------------------------------------------
  async createParcel(
    creds: CourierCredentials,
    parcel: ParcelInput
  ): Promise<CourierResult<ParcelResult>> {
    const orderId = s(parcel?.orderId);
    // One parcel = an array of one (the endpoint is inherently array-based).
    const payload = [
      {
        order_id: orderId,
        from_wilaya_name: s(parcel?.fromWilayaName),
        firstname: s(parcel?.firstname),
        familyname: s(parcel?.familyname),
        contact_phone: s(parcel?.contactPhone),
        address: s(parcel?.address),
        to_commune_name: s(parcel?.toCommuneName),
        to_wilaya_name: s(parcel?.toWilayaName),
        product_list: s(parcel?.productList),
        // price = COD amount = product subtotal (NOT total-with-shipping).
        price: n(parcel?.price),
        is_stopdesk: parcel?.isStopdesk === true,
        ...(parcel?.stopdeskId !== undefined
          ? { stopdesk_id: n(parcel.stopdeskId) }
          : {}),
        freeshipping: parcel?.freeshipping === true,
        ...(parcel?.weight !== undefined ? { weight: n(parcel.weight) } : {}),
        ...(parcel?.economic !== undefined
          ? { economic: parcel.economic === true }
          : {}),
        do_insurance: false,
        has_exchange: false,
      },
    ];
    const r = await this.request(creds, 'POST', '/parcels/', payload);
    if (!r.ok) return r;
    const data = r.value;
    if (!data || typeof data !== 'object') return courierErr('malformed');
    // Response is keyed by order_id. Prefer our exact key; else take the sole
    // entry (defensive against an echoed-but-normalized key).
    const map = data as Record<string, any>;
    const entry =
      (orderId && map[orderId]) ||
      (Object.keys(map).length === 1 ? map[Object.keys(map)[0]] : null);
    if (!entry || typeof entry !== 'object') return courierErr('malformed');
    const tracking = s(entry.tracking);
    if (entry.success !== true || !tracking) {
      // Per-item failure inside a 200 envelope — surface the courier's own
      // (secret-free) message as a client-fixable bad_request.
      return courierErr('bad_request', {
        message: s(entry.message).slice(0, 200) || 'parcel_rejected',
      });
    }
    const out: ParcelResult = { tracking };
    const label = s(entry.label);
    if (label) out.label = label;
    if (orderId) out.orderId = orderId;
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // trackParcel — GET /histories/{tracking} → { data: [History] }. We surface
  // the newest raw status (drives normalizeStatus) + all rows. An empty history
  // is a valid result (no events yet), NOT an error.
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
      `/histories/${encodeURIComponent(t)}`
    );
    if (!r.ok) return r;
    const rows = this.rowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const events: TrackEvent[] = rows.map(row => {
      const ev: TrackEvent = {
        date: s(row.date_status),
        rawStatus: s(row.status),
      };
      const reason = s(row.reason);
      if (reason) ev.reason = reason;
      const center = s(row.center_name);
      if (center) ev.centerName = center;
      const wilaya = s(row.wilaya_name);
      if (wilaya) ev.wilayaName = wilaya;
      const commune = s(row.commune_name);
      if (commune) ev.communeName = commune;
      return ev;
    });
    // Yalidine history is chronological; the LAST row is the most recent state.
    const lastRawStatus = events.length ? events[events.length - 1].rawStatus : '';
    return courierOk({ lastRawStatus, events });
  }

  // -------------------------------------------------------------------------
  // computeFees — GET /fees/?from_wilaya_id=&to_wilaya_id=. Returns the wilaya-
  // level surcharges + a per-commune matrix (four price classes each).
  // -------------------------------------------------------------------------
  async computeFees(
    creds: CourierCredentials,
    fromWilaya: number,
    toWilaya: number
  ): Promise<CourierResult<FeeResult>> {
    const from = n(fromWilaya);
    const to = n(toWilaya);
    if (!from || !to) {
      return courierErr('bad_request', { message: 'invalid_wilaya' });
    }
    const r = await this.request(
      creds,
      'GET',
      `/fees/?from_wilaya_id=${from}&to_wilaya_id=${to}`
    );
    if (!r.ok) return r;
    const d = r.value;
    if (!d || typeof d !== 'object') return courierErr('malformed');
    const obj = d as Record<string, any>;
    const perCommune: Record<string, CommuneFee> = {};
    const raw = obj.per_commune;
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(raw)) {
        const c = raw[key];
        if (!c || typeof c !== 'object') continue;
        perCommune[key] = {
          communeName: s(c.commune_name),
          expressHome: priceOrNull(c.express_home),
          expressDesk: priceOrNull(c.express_desk),
          economicHome: priceOrNull(c.economic_home),
          economicDesk: priceOrNull(c.economic_desk),
        };
      }
    }
    const out: FeeResult = {
      fromWilayaName: s(obj.from_wilaya_name),
      toWilayaName: s(obj.to_wilaya_name),
      perCommune,
    };
    if (obj.zone !== undefined) out.zone = n(obj.zone);
    if (obj.retour_fee !== undefined) out.retourFee = n(obj.retour_fee);
    if (obj.cod_percentage !== undefined)
      out.codPercentage = n(obj.cod_percentage);
    if (obj.insurance_percentage !== undefined)
      out.insurancePercentage = n(obj.insurance_percentage);
    if (obj.oversize_fee !== undefined) out.oversizeFee = n(obj.oversize_fee);
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // listWilayas — GET /wilayas/ → { data: [{id,name,zone,is_deliverable}] }.
  // This is THE source of the live wilaya count (58→69) — never hardcoded.
  // Also used by the controller's connect route as the cheap credential-
  // validation "test connection" call.
  // -------------------------------------------------------------------------
  async listWilayas(
    creds: CourierCredentials
  ): Promise<CourierResult<WilayaRef[]>> {
    const r = await this.request(creds, 'GET', '/wilayas/');
    if (!r.ok) return r;
    const rows = this.rowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const out: WilayaRef[] = rows.map(row => {
      const w: WilayaRef = { id: n(row.id), name: s(row.name) };
      if (row.zone !== undefined) w.zone = n(row.zone);
      if (row.is_deliverable !== undefined)
        w.isDeliverable = row.is_deliverable === true;
      return w;
    });
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // listCommunes — GET /communes/?wilaya_id= (paginated; one big page).
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
      `/communes/?wilaya_id=${w}&page_size=${COMMUNE_PAGE_SIZE}`
    );
    if (!r.ok) return r;
    const rows = this.rowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const out: CommuneRef[] = rows.map(row => {
      const c: CommuneRef = {
        id: n(row.id),
        name: s(row.name),
        wilayaId: n(row.wilaya_id) || w,
      };
      if (row.has_stop_desk !== undefined)
        c.hasStopDesk = row.has_stop_desk === true;
      if (row.is_deliverable !== undefined)
        c.isDeliverable = row.is_deliverable === true;
      return c;
    });
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // listCenters — GET /centers/?wilaya_id= → stop-desk offices for a wilaya.
  // -------------------------------------------------------------------------
  async listCenters(
    creds: CourierCredentials,
    wilayaId: number
  ): Promise<CourierResult<CenterRef[]>> {
    const w = n(wilayaId);
    if (!w) return courierErr('bad_request', { message: 'invalid_wilaya' });
    const r = await this.request(creds, 'GET', `/centers/?wilaya_id=${w}`);
    if (!r.ok) return r;
    const rows = this.rowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const out: CenterRef[] = rows.map(row => {
      const c: CenterRef = {
        centerId: n(row.center_id),
        name: s(row.name),
      };
      const address = s(row.address);
      if (address) c.address = address;
      if (row.commune_id !== undefined) c.communeId = n(row.commune_id);
      const communeName = s(row.commune_name);
      if (communeName) c.communeName = communeName;
      if (row.wilaya_id !== undefined) c.wilayaId = n(row.wilaya_id);
      const wilayaName = s(row.wilaya_name);
      if (wilayaName) c.wilayaName = wilayaName;
      return c;
    });
    return courierOk(out);
  }

  /** SYNC + pure: delegate to the shared Yalidine FR→sub-state map. */
  normalizeStatus(raw: string): CourierStatus {
    return normalizeYalidineStatus(raw);
  }

  /**
   * Yalidine collection responses wrap rows in `{ data: [...] }`. Return the
   * array, or `[]` when `data` is explicitly an empty array, or `null` when the
   * envelope is unexpected (→ the caller maps to 'malformed'). Tolerates a bare
   * top-level array too (defensive).
   *
   * FAIL-SOFT (Waybill F-1): every caller `.map`s the returned rows and reads
   * named fields off each (`s(row.status)`, `n(row.id)`, …). A malformed upstream
   * payload like `{ data: [null] }` / `{ data: ["x"] }` would make that deref
   * THROW a TypeError *inside* the map — escaping `request()`'s fetch-only
   * try/catch and breaking the never-throw provider contract (a live 500 on the
   * connect/refresh paths). So we filter to object rows here, at the single
   * choke point: well-formed responses are unaffected (every real row is an
   * object), and a junk element is dropped rather than crashing the request.
   * `computeFees` guards its cells inline and does not use this.
   */
  private rowsOf(payload: unknown): any[] | null {
    if (Array.isArray(payload)) {
      return payload.filter(r => r != null && typeof r === 'object');
    }
    if (payload && typeof payload === 'object') {
      const data = (payload as any).data;
      if (Array.isArray(data)) {
        return data.filter(r => r != null && typeof r === 'object');
      }
    }
    return null;
  }
}

// The shared singleton + self-registration. Importing this module registers the
// provider into clickdz-courier.ts's registry (the controller imports this file,
// so the side-effect runs at boot). Exported too for direct use/testing.
export const yalidineProvider = new YalidineProvider();
registerCourierProvider(yalidineProvider);
