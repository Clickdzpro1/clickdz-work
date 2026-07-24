// ---------------------------------------------------------------------------
// R17 (PR-D) — ECOTRACK provider. A GENERIC `CourierProvider`
// (clickdz-courier.ts) that fronts the ~72 Algerian couriers running on the
// Ecotrack platform (DHD, Conexlog/UPS DZ, MSM Go, World Express, Anderson,
// Speed Delivery, Rocket, Samex, …). Each is an independent delivery company
// with its own fleet/pricing but exposes the IDENTICAL Ecotrack API on its own
// tenant domain — so ONE impl serves all of them, keyed by the merchant's own
// Ecotrack tenant host.
//
// Framework-light: this file does `fetch` (mirroring the Yalidine provider —
// the bridge owns network I/O, not the pure Shipping module), but imports
// NOTHING from Nest and throws NOTHING. Every method obeys the fail-soft
// contract from clickdz-courier.ts: resolve `CourierResult<T>` — a typed error
// on any failure, never a raw throw. The merchant's token is read from `creds`,
// sent as a Bearer header, and NEVER logged, echoed, or returned.
//
// ⚠️ CREDENTIAL MODEL — apiId = TENANT HOST (differs from Yalidine's id+token):
//   Ecotrack's only real secret is a Bearer `api_token`; the second axis is the
//   courier's tenant BASE URL. We carry both in the existing 2-field
//   `CourierCredentials` with NO schema change:
//     creds.apiId    ← the tenant subdomain OR full host/URL
//                      (e.g. "dhd", "samex", "platform.dhd-dz.com",
//                       "https://samex.ecotrack.dz"). We BUILD the API base
//                      from it (baseFromApiId): strip scheme/slashes/junk,
//                      then — if it looks like a host (has a dot) use it as-is
//                      over https; else treat it as an Ecotrack subdomain and
//                      expand to https://<apiId>.ecotrack.dz. A blank/garbage
//                      apiId yields '' → every call fail-softs to
//                      'unauthorized' (never a bad fetch, never a throw).
//     creds.apiToken ← api_token → `Authorization: Bearer <token>`.
//   `requiresApiId = true` so the controller requires+seals BOTH fields and the
//   connect form must label apiId "Courier (Ecotrack subdomain or dashboard
//   URL)", NOT "X-API-ID". An optional env `CDZ_ECOTRACK_BASE` overrides the
//   base for ALL merchants (staging / a shared reseller host), but the
//   per-merchant apiId host is AUTHORITATIVE when present.
//
// API facts (reconstructed from open-source SDKs — see noest-ecotrack.md Part B,
// NOT yet live-verified; every path/field below carries a confidence in the
// header/OPEN RISKS):
//   Base    https://<tenant>.ecotrack.dz  (or a custom host) — from apiId
//   Auth    header Authorization: Bearer <api_token>  (only credential) [HIGH]
//   Create  POST api/v1/create/order   → body has `tracking` (create is
//           sufficient — no forced NOEST-style validate/"draft trap") [HIGH route/MED no-trap]
//   Track   GET  api/v1/get/trackings/info  — LIST-style; MUST match the exact
//           tracking or you attach a NEIGHBOUR's parcel to this order (G2) [HIGH]
//   Fees    GET  api/v1/get/fees        → home/desk tarif per wilaya [MED]
//   Wilayas GET  api/v1/get/wilayas     → {id/code, name/nom} [MED]
//   Communes GET api/v1/get/communes?wilaya_id=  (1–69) → {nom, wilaya_id, post_code} [MED]
//   Centers —    NOT AVAILABLE. Ecotrack exposes NO stop-desk office API (S1
//           getOffices() returns []). listCenters → courierOk([]); desk delivery
//           is effectively home-only via API in v1 (G4). [HIGH]
//   Label   GET  api/v1/get/order/label → RAW PDF BYTES, not a URL (G1). Our
//           ParcelResult.label is a URL field, so we leave it UNDEFINED here and
//           let a dedicated ClickDz label route stream the PDF. [HIGH]
//   Status  tenant-customizable labels → unknown/custom slug folds to 'pending'
//           (the safe default). ECOTRACK_STATUS_MAP below; accent/case-folded.
//   Wilayas 58→69 since Nov 2025 — we DRIVE off get/wilayas, never hardcode.
//
// OPEN RISKS (verify with REAL creds before the CDZ_COURIER_ECOTRACK dark flag
// flips — none can be settled from third-party SDKs alone):
//   • R1 [HIGH] Reference/fees ROW field names (get/wilayas, get/communes,
//     get/fees) — S1 gave method names + the create-body shape but the exact
//     reference-row keys were NOT fully captured. We read a tolerant SUPERSET of
//     aliases (id|code|wilaya_id, name|nom|libelle, tarif|delivery_home, …) so a
//     real response likely lands, but confirm the literal keys.
//   • R2 [HIGH] createParcel response envelope — we accept `tracking` at several
//     nesting spots (top-level, data.*, order.*); confirm the real shape and
//     whether a 200 can still be a per-item failure (Yalidine-style) so we don't
//     resolve a ParcelResult without a real tracking.
//   • R3 [MED] "No validate step" — sources show no NOEST-style draft trap, but
//     that's absence-of-evidence; if a tenant needs valid/order to schedule
//     pickup, create alone would strand parcels. Verify per tenant.
//   • R4 [MED] Label is PDF bytes → label is intentionally NOT returned here;
//     the download route is out of this file's scope.
//   • R5 [HIGH] Per-tenant status-label drift → the unknown→'pending' fallback
//     is load-bearing; the raw slug is preserved on every TrackEvent so the map
//     can be extended from real feeds (we do NOT log it — no logger here).
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

// --- Config (module-load constants). An OPTIONAL env base override for ALL
// merchants (staging / a shared reseller host); the per-merchant apiId host
// wins when present (see baseFromApiId). NEVER interpolates a secret.
const ECOTRACK_BASE_OVERRIDE = (process.env.CDZ_ECOTRACK_BASE || '').replace(
  /\/+$/,
  ''
);

// The apiId-fronted platform domain suffix. A bare subdomain apiId (e.g. "dhd")
// expands to `https://dhd.ecotrack.dz`; an apiId that already looks like a host
// (contains a dot) is used verbatim over https.
const ECOTRACK_DOMAIN = 'ecotrack.dz';

// Bounded per-call timeout — reference/control-plane lookups are quick; a hung
// tenant must not hold a request thread. 15s, matching the Yalidine provider.
const ECOTRACK_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Loose scalar readers for the schemaless JSON Ecotrack tenants return (mirror
// the Yalidine provider's s()/n()/priceOrNull so this file stays
// dependency-free and byte-consistent with the reference impl).
// ---------------------------------------------------------------------------
function s(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
/** A price cell: a finite number, or null ("n/a" — no such class/rate). */
function priceOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
/** First non-empty string among candidates (for tolerant alias reading). */
function firstStr(...vals: unknown[]): string {
  for (const v of vals) {
    const x = s(v);
    if (x) return x;
  }
  return '';
}
/** First finite number among candidates, else 0 (tolerant alias reading). */
function firstNum(...vals: unknown[]): number {
  for (const v of vals) {
    if (v === null || v === undefined || v === '') continue;
    const x = Number(v);
    if (Number.isFinite(x)) return x;
  }
  return 0;
}
/** First present price cell among candidates (finite → number, else null). */
function firstPrice(...vals: unknown[]): number | null {
  for (const v of vals) {
    const p = priceOrNull(v);
    if (p !== null) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// apiId → API base URL. THE Ecotrack-specific piece. Sanitizes the merchant's
// tenant host: trims, strips any scheme + path + trailing slashes, rejects
// obvious junk. If the sanitized value has a dot (or a colon → host:port) treat
// it as a full host; else treat it as an Ecotrack subdomain and expand to
// `<sub>.ecotrack.dz`. Always https. Returns '' when nothing usable remains
// (caller maps '' → 'unauthorized' — a garbage host can never issue a real
// fetch, keeping the never-throw contract). An env override wins outright.
// ---------------------------------------------------------------------------
function baseFromApiId(apiId: unknown): string {
  if (ECOTRACK_BASE_OVERRIDE) return ECOTRACK_BASE_OVERRIDE;
  let raw = s(apiId).trim();
  if (!raw) return '';
  // Drop scheme.
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Drop any path / query / fragment (keep only the authority).
  raw = raw.replace(/[/?#].*$/, '');
  // Drop surrounding whitespace/slashes that may remain.
  raw = raw.replace(/^\/+|\/+$/g, '').trim();
  if (!raw) return '';
  // Reject junk: a host/subdomain is letters, digits, dots, hyphens, and an
  // optional :port. Anything else (spaces, '@', unicode, control chars) → junk.
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(raw)) return '';
  // A leading/trailing dot or a doubled dot is not a real host.
  if (raw.startsWith('.') || raw.startsWith('-')) return '';
  const hostPart = raw.split(':')[0];
  if (!hostPart || hostPart.endsWith('.') || hostPart.includes('..')) return '';
  // Has a dot (or an explicit port) ⇒ a full host; else an Ecotrack subdomain.
  const isHost = hostPart.includes('.') || raw.includes(':');
  const host = isHost ? raw : `${raw}.${ECOTRACK_DOMAIN}`;
  return `https://${host}`;
}

// ---------------------------------------------------------------------------
// Map an HTTP Response status to a typed CourierError. Reads Retry-After on a
// 429. NEVER reads/echoes credentials. `bodyMsg` is a short, secret-free
// upstream message when we could cheaply extract one. Byte-identical shape to
// the Yalidine provider's errorFromStatus.
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
    // Ecotrack (Laravel) validation errors come back as 422; fold to bad_request.
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
// ECOTRACK status vocabulary → the 4 ClickDz sub-states. Verbatim slugs from
// noest-ecotrack.md Part B.6 (S1 `EcotrackPackagesStatus` + normalizer). Folded
// via normalizeStatusRaw (lowercase, accent-strip, whitespace-collapse) so
// `payé_et_archivé`, `en_livraison`, spelling/case drift all resolve. A status
// NOT in the map ⇒ 'pending' (safe default: a tenant-customized/never-seen
// label must never spuriously mark an order delivered/returned — this fallback
// is load-bearing, see R5).
//
// Buckets:
//   pending   — created / accepted-not-moving / prep (order info received,
//               notifications, ready-to-ship, in-preparation).
//   shipped   — picked / accepted-by-carrier / dispatched / attempt / hub /
//               out-for-delivery + `suspendu` (temporary — don't prematurely
//               mark returned).
//   delivered — delivered + its FINANCIAL terminals (encaissed/payed/archived):
//               unlike NOEST's finance events (which are pure money movement to
//               IGNORE), Ecotrack's cash states still MEAN the parcel reached
//               the customer, so S1 buckets them DELIVERED and so do we.
//   returned  — every return_*/retour_* state + `annule` (cancelled ≈ returned;
//               the 4-state model has no 'cancelled' bucket).
// Note: unlike NOEST there is NO finance-event filtering here — Ecotrack cash
// states are legitimately 'delivered', so trackParcel does not strip them.
// ---------------------------------------------------------------------------
const ECOTRACK_STATUS_MAP: Readonly<Record<string, CourierStatus>> =
  Object.freeze({
    // --- pending (created / not yet moving) ---
    order_information_received_by_carrier: 'pending',
    notification_on_order: 'pending',
    prete_a_expedier: 'pending',
    en_preparation_stock: 'pending',
    en_preparation: 'pending',
    // --- shipped (moving / out for delivery / in-network) ---
    picked: 'shipped',
    accepted_by_carrier: 'shipped',
    dispatched_to_driver: 'shipped',
    attempt_delivery: 'shipped',
    en_ramassage: 'shipped',
    vers_hub: 'shipped',
    en_hub: 'shipped',
    vers_wilaya: 'shipped',
    en_livraison: 'shipped',
    // suspendu (suspended) — temporary (fee refused / unreachable); don't
    // prematurely bucket as returned. [LOW judgement call — verify on a feed.]
    suspendu: 'shipped',
    // --- delivered (incl. cash/finance terminals — still means "reached customer") ---
    livred: 'delivered',
    encaissed: 'delivered',
    payed: 'delivered',
    livre_non_encaisse: 'delivered',
    encaisse_non_paye: 'delivered',
    paiements_prets: 'delivered',
    paye_et_archive: 'delivered',
    // --- returned (terminal back to center/vendor + cancelled) ---
    return_asked: 'returned',
    return_in_transit: 'returned',
    return_received: 'returned',
    retour_chez_livreur: 'returned',
    retour_transit_entrepot: 'returned',
    retour_en_traitement: 'returned',
    retour_recu: 'returned',
    retour_archive: 'returned',
    // annule (cancelled) — no 'cancelled' bucket; 'returned' is the closest
    // terminal. [MED — verify the tenant doesn't reuse 'annule' pre-ship.]
    annule: 'returned',
  });

/**
 * Map an Ecotrack raw status slug → a CourierStatus. Unknown/blank ⇒ 'pending'
 * (never spuriously terminal — Ecotrack tenants customize labels, so an
 * unrecognized slug MUST fall back safely). Exported standalone so it is
 * unit-testable without instantiating the provider; the provider's
 * `normalizeStatus` delegates straight here. Reuses the shared
 * `normalizeStatusRaw` folding (accent/case/whitespace) from clickdz-courier.ts.
 */
export function normalizeEcotrackStatus(raw: unknown): CourierStatus {
  const key = normalizeStatusRaw(raw);
  if (!key) return 'pending';
  return ECOTRACK_STATUS_MAP[key] ?? 'pending';
}

// ---------------------------------------------------------------------------
// The Ecotrack provider. One stateless singleton (registered at module load).
// Every method: derive the tenant base from creds.apiId, attach the Bearer
// header, 15s abort, then map the outcome to CourierResult. A thrown fetch
// (network/timeout/abort) → 'unreachable'; a non-2xx → the typed status map; a
// 2xx with an unparseable/unexpected body → 'malformed'. A blank/garbage apiId
// (no derivable base) → 'unauthorized' before any network traffic.
// ---------------------------------------------------------------------------
class EcotrackProvider implements CourierProvider {
  readonly id = 'ecotrack' as const;
  /** Ecotrack needs BOTH: apiId (tenant host) + apiToken (Bearer). */
  readonly requiresApiId = true as const;

  /** Build the Bearer auth header from the unsealed creds. Never logged. */
  private authHeaders(creds: CourierCredentials): Record<string, string> {
    return {
      Authorization: `Bearer ${s(creds?.apiToken)}`,
      Accept: 'application/json',
    };
  }

  /**
   * Core request → typed result carrying the parsed JSON. Reads the body ONCE.
   * On a non-2xx it best-effort extracts a secret-free `{message}` and, for a
   * 429, the Retry-After. On a thrown fetch → 'unreachable'. A missing token or
   * an unusable apiId (no derivable base) → 'unauthorized' with no round-trip.
   * Never logs headers/creds; never throws. `expectJson=false` (label route) is
   * reserved — this provider's JSON methods all use the default.
   */
  private async request(
    creds: CourierCredentials,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<CourierResult<unknown>> {
    // Guard: token must be present, and apiId must yield a usable base, before
    // any network traffic (an empty Bearer / junk host would just be a wasted,
    // confusing round-trip). Both map to the same secret-free 'unauthorized'.
    if (!s(creds?.apiToken)) {
      return courierErr('unauthorized', { message: 'missing_credentials' });
    }
    const base = baseFromApiId(creds?.apiId);
    if (!base) {
      return courierErr('unauthorized', { message: 'invalid_tenant_host' });
    }
    const url = `${base}${path}`;
    const headers: Record<string, string> = this.authHeaders(creds);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(ECOTRACK_TIMEOUT_MS),
      });
    } catch {
      // Network error / DNS / connection reset / AbortSignal timeout / bad host.
      return courierErr('unreachable');
    }
    // Read the body once, defensively (a tenant returns JSON for success + typed
    // errors; a proxy could return non-JSON on a 5xx).
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
   * Best-effort, SECRET-FREE upstream message extraction from an error body.
   * Ecotrack/Laravel typically returns `{message}` and sometimes `{errors:{...}}`;
   * we take `message` when it is a string. Capped to 200 chars. Never touches
   * headers/creds.
   */
  private messageOf(json: unknown): string | undefined {
    if (json && typeof json === 'object' && 'message' in (json as any)) {
      const m = s((json as any).message).slice(0, 200);
      return m || undefined;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // createParcel — POST api/v1/create/order. Ecotrack field names DIFFER from
  // NOEST/Yalidine (nom_client, telephone, code_wilaya [string], type, weight).
  // Create is sufficient — sources show NO NOEST-style forced validate step
  // (R3). A 200 with a readable `tracking` ⇒ ParcelResult; no tracking ⇒
  // 'malformed' (we never resolve a ParcelResult without a real tracking, per
  // the interface note). Label is PDF BYTES not a URL (G1/R4) → we do NOT set
  // `label`; a dedicated ClickDz route streams it. NOT wired to a route in
  // PR-A/PR-D scaffolding here.
  // -------------------------------------------------------------------------
  async createParcel(
    creds: CourierCredentials,
    parcel: ParcelInput
  ): Promise<CourierResult<ParcelResult>> {
    const orderId = s(parcel?.orderId);
    // code_wilaya is a STRING wilaya CODE on Ecotrack (≠ NOEST's int wilaya_id).
    // We only have the wilaya NAME in ParcelInput (ids are resolved from the
    // reference tables by the caller); Ecotrack's create also takes the commune
    // NAME. If a numeric code is embedded we pass it, else we send the name and
    // rely on the tenant resolving it (the commune name is authoritative here).
    const payload: Record<string, unknown> = {
      reference: orderId,
      nom_client: `${s(parcel?.firstname)} ${s(parcel?.familyname)}`.trim(),
      telephone: s(parcel?.contactPhone),
      adresse: s(parcel?.address),
      commune: s(parcel?.toCommuneName),
      // Send the wilaya NAME as code_wilaya (tenant maps name→code); the
      // reference table also lets the caller pre-resolve to a numeric code.
      code_wilaya: s(parcel?.toWilayaName),
      // montant = COD amount = product subtotal (NOT total-with-shipping).
      montant: n(parcel?.price),
      produit: s(parcel?.productList),
      // 0 = home, 1 = desk. NB: Ecotrack exposes NO office API (G4), so desk is
      // effectively unusable via API in v1; we still forward the flag honestly.
      stop_desk: parcel?.isStopdesk === true ? 1 : 0,
      type: 1,
      ...(parcel?.weight !== undefined ? { weight: n(parcel.weight) } : {}),
      fragile: 0,
    };
    const r = await this.request(creds, 'POST', '/api/v1/create/order', payload);
    if (!r.ok) return r;
    const data = r.value;
    if (!data || typeof data !== 'object') return courierErr('malformed');
    // Tolerant tracking extraction: top-level `tracking`, or nested under
    // common envelopes (data.*, order.*, OrderInfo.*). Confirm the real shape
    // against a live create (R2).
    const tracking = this.trackingOf(data);
    if (!tracking) {
      // No tracking issued → treat as a client-fixable rejection, surfacing the
      // tenant's own secret-free message when present.
      const msg = this.messageOf(data);
      return courierErr('bad_request', { message: msg || 'parcel_rejected' });
    }
    const out: ParcelResult = { tracking };
    // label intentionally omitted — Ecotrack's label is raw PDF bytes, not a
    // stable URL (G1). A ClickDz label route streams it on demand.
    if (orderId) out.orderId = orderId;
    return courierOk(out);
  }

  /**
   * Pull a tracking number out of a create/track object, tolerant of nesting.
   * Checks the object itself then a few common wrapper keys. Returns '' when
   * none is found (caller decides malformed vs not-found). Never throws.
   */
  private trackingOf(obj: unknown): string {
    if (!obj || typeof obj !== 'object') return '';
    const o = obj as Record<string, any>;
    const direct = firstStr(o.tracking, o.tracking_number, o.trackingNumber);
    if (direct) return direct;
    for (const key of ['data', 'order', 'OrderInfo', 'result']) {
      const inner = o[key];
      if (inner && typeof inner === 'object') {
        const t = firstStr(
          (inner as any).tracking,
          (inner as any).tracking_number,
          (inner as any).trackingNumber
        );
        if (t) return t;
      }
    }
    return '';
  }

  // -------------------------------------------------------------------------
  // trackParcel — GET api/v1/get/trackings/info. LIST-style: the endpoint can
  // return neighbouring parcels, so we MUST match the EXACT tracking (G2) — a
  // naive "first row" would attach another merchant's parcel status to this
  // order. We locate our tracking's entry (keyed-by-tracking map OR an array of
  // rows), read its activity[] into normalized events, and surface the newest
  // raw status. An empty history is a valid result (no events yet), NOT an error.
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
      `/api/v1/get/trackings/info?tracking=${encodeURIComponent(t)}`
    );
    if (!r.ok) return r;
    const activity = this.activityForTracking(r.value, t);
    if (activity === null) return courierErr('malformed');
    const events: TrackEvent[] = activity.map(row => {
      const ev: TrackEvent = {
        // S1 tries date/created_at/updated_at — read the first present.
        date: firstStr(row.date, row.created_at, row.updated_at, row.time),
        // status slug lives under event/event_key/status/status_code.
        rawStatus: firstStr(
          row.event,
          row.event_key,
          row.status,
          row.status_code
        ),
      };
      const reason = firstStr(row.reason, row.comment, row.remarque, row.note);
      if (reason) ev.reason = reason;
      const center = firstStr(row.center_name, row.center, row.by, row.station);
      if (center) ev.centerName = center;
      const wilaya = firstStr(row.wilaya_name, row.wilaya, row.state);
      if (wilaya) ev.wilayaName = wilaya;
      const commune = firstStr(row.commune_name, row.commune, row.city);
      if (commune) ev.communeName = commune;
      return ev;
    });
    // Ecotrack activity is chronological; the LAST row is the most recent state.
    const lastRawStatus = events.length
      ? events[events.length - 1].rawStatus
      : '';
    return courierOk({ lastRawStatus, events });
  }

  /**
   * Resolve the activity[] rows FOR THE EXACT tracking `t` from a list-style
   * trackings response (G2). Handles three envelope shapes seen across SDKs:
   *   1) keyed-by-tracking map:  { "<tracking>": { OrderInfo, activity:[…] } }
   *   2) `data` keyed-by-tracking: { data: { "<tracking>": {…} } }
   *   3) array of rows:          { data: [ { tracking, activity:[…] } , … ] }
   * Returns the matched entry's object-filtered activity rows, [] when the
   * tracking is present with no activity, or null when the envelope is
   * unrecognized (→ 'malformed'). NEVER returns a neighbour's rows: if a keyed
   * map or array is present but our exact tracking is absent, that is [] (no
   * events for us), not another parcel's history.
   */
  private activityForTracking(payload: unknown, t: string): any[] | null {
    if (!payload || typeof payload !== 'object') return null;
    const root = payload as Record<string, any>;
    // Unwrap a single `data` layer when it is itself an object/array container.
    const container: any =
      root.data && typeof root.data === 'object' ? root.data : root;

    // Shape 3: array of per-parcel rows — find the one whose tracking matches.
    if (Array.isArray(container)) {
      const match = container.find(
        row =>
          row &&
          typeof row === 'object' &&
          firstStr(
            (row as any).tracking,
            (row as any).tracking_number,
            (row as any).trackingNumber
          ) === t
      );
      if (!match) return []; // our tracking not in the list → no events (not a neighbour)
      return this.activityRows(match);
    }

    // Shapes 1 & 2: keyed-by-tracking map. Prefer our exact key.
    if (container && typeof container === 'object') {
      const entry = (container as Record<string, any>)[t];
      if (entry && typeof entry === 'object') {
        return this.activityRows(entry);
      }
      // Our tracking key is absent. If the object itself looks like a single
      // parcel entry FOR our tracking, use it; otherwise no events for us.
      const selfTracking = firstStr(
        (container as any).tracking,
        (container as any).tracking_number,
        (container as any).trackingNumber
      );
      if (selfTracking && selfTracking === t) {
        return this.activityRows(container);
      }
      // A keyed map that simply doesn't contain us → [] (never a neighbour).
      return [];
    }
    return null;
  }

  /**
   * Extract + object-filter the activity/history rows from a single parcel
   * entry. Reads `activity` (S1) with fallbacks (`history`, `events`,
   * `trackings`). FAIL-SOFT (F-1): filters to object rows so a malformed
   * `{activity:[null]}` can't throw inside the caller's `.map`. Returns [] when
   * there are no rows (a valid "no events yet").
   */
  private activityRows(entry: unknown): any[] {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, any>;
    const rows = e.activity ?? e.history ?? e.events ?? e.trackings;
    if (!Array.isArray(rows)) return [];
    return rows.filter(r => r != null && typeof r === 'object');
  }

  // -------------------------------------------------------------------------
  // computeFees — GET api/v1/get/fees. Ecotrack prices per WILAYA (home/desk
  // tarif), not per commune. We surface the requested `toWilaya`'s home + desk
  // tarif as a SINGLE synthetic per-commune entry keyed by the wilaya id (the
  // `perCommune` matrix is the shared shape; a per-wilaya courier populates one
  // row). economicHome/economicDesk = null (Ecotrack has no express/economic
  // split). retourFee from a return tarif when present. Field names are MED
  // confidence (R1) — we read a tolerant superset of aliases.
  // -------------------------------------------------------------------------
  async computeFees(
    creds: CourierCredentials,
    fromWilaya: number,
    toWilaya: number
  ): Promise<CourierResult<FeeResult>> {
    const from = n(fromWilaya);
    const to = n(toWilaya);
    if (!to) {
      return courierErr('bad_request', { message: 'invalid_wilaya' });
    }
    const r = await this.request(creds, 'GET', '/api/v1/get/fees');
    if (!r.ok) return r;
    const d = r.value;
    if (!d || typeof d !== 'object') return courierErr('malformed');
    // Fees may be a keyed-by-wilaya map, an array of rows, or nested under
    // `data`/`livraison`. Normalize to an array of rows, then find our wilaya.
    const rows = this.feeRows(d);
    if (rows === null) return courierErr('malformed');
    const row = rows.find(x => {
      const wid = firstNum(
        x.wilaya_id,
        x.wilayaId,
        x.code_wilaya,
        x.code,
        x.id
      );
      return wid === to;
    });
    // A missing row for this wilaya is NOT malformed — the courier may not serve
    // it. Surface a valid, empty-priced entry so the caller can render "n/a".
    const home = row
      ? firstPrice(row.tarif, row.delivery_home, row.home, row.prix, row.price)
      : null;
    const desk = row
      ? firstPrice(
          row.tarif_stopdesk,
          row.delivery_desk,
          row.stopdesk,
          row.desk,
          row.prix_stopdesk
        )
      : null;
    const key = String(to);
    const perCommune: Record<string, CommuneFee> = {
      [key]: {
        communeName: row ? firstStr(row.wilaya_name, row.nom, row.name) : '',
        expressHome: home,
        expressDesk: desk,
        economicHome: null,
        economicDesk: null,
      },
    };
    const out: FeeResult = {
      fromWilayaName: from ? String(from) : '',
      toWilayaName: row ? firstStr(row.wilaya_name, row.nom, row.name) : '',
      perCommune,
    };
    if (row) {
      const retour = firstPrice(
        row.tarif_retour,
        row.return_price,
        row.retour,
        row.returnPrice
      );
      if (retour !== null) out.retourFee = retour;
    }
    return courierOk(out);
  }

  /**
   * Normalize a fees body → an array of per-wilaya rows. Handles: a bare array,
   * `{data:[…]}`, a keyed-by-wilaya map `{ "16": {…} }` (values → rows, key
   * folded in as wilaya_id when the row omits it), or `{data:{…keyed…}}`.
   * Object-filters rows (F-1). null when nothing array/object-shaped is found.
   */
  private feeRows(payload: unknown): any[] | null {
    const unwrap = (v: any): any =>
      v && typeof v === 'object' && !Array.isArray(v) && v.data !== undefined
        ? v.data
        : v;
    const src = unwrap(payload);
    if (Array.isArray(src)) {
      return src.filter(r => r != null && typeof r === 'object');
    }
    if (src && typeof src === 'object') {
      // Keyed-by-wilaya map → rows, folding the key in as a wilaya id fallback.
      const out: any[] = [];
      for (const k of Object.keys(src)) {
        const row = (src as Record<string, any>)[k];
        if (row && typeof row === 'object') {
          out.push({
            wilaya_id:
              (row as any).wilaya_id ??
              (row as any).code_wilaya ??
              (Number.isFinite(Number(k)) ? Number(k) : undefined),
            ...row,
          });
        }
      }
      return out;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // listWilayas — GET api/v1/get/wilayas → the live wilaya list (58→69, never
  // hardcoded). ALSO the controller's connect-route credential-validation call,
  // so it must succeed with just Bearer + a valid tenant host. Row field names
  // are MED confidence (R1) → tolerant alias reading (id|code, name|nom|libelle).
  // -------------------------------------------------------------------------
  async listWilayas(
    creds: CourierCredentials
  ): Promise<CourierResult<WilayaRef[]>> {
    const r = await this.request(creds, 'GET', '/api/v1/get/wilayas');
    if (!r.ok) return r;
    const rows = this.rowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const out: WilayaRef[] = rows.map(row => {
      const w: WilayaRef = {
        id: firstNum(row.id, row.code, row.wilaya_id, row.code_wilaya),
        name: firstStr(row.name, row.nom, row.libelle, row.wilaya_name),
      };
      // Ecotrack does not expose a Yalidine-style pricing zone on the wilaya →
      // leave `zone` undefined. `isActive`/`is_deliverable` → isDeliverable.
      if (row.is_deliverable !== undefined || row.isActive !== undefined) {
        w.isDeliverable =
          row.is_deliverable === true ||
          row.is_deliverable === 1 ||
          row.isActive === true ||
          row.isActive === 1;
      }
      return w;
    });
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // listCommunes — GET api/v1/get/communes?wilaya_id= (1–69). Rows carry a
  // `post_code` (S1) and the commune name; commune id is read tolerantly (may
  // be absent → 0). MED confidence on field names (R1).
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
      `/api/v1/get/communes?wilaya_id=${w}`
    );
    if (!r.ok) return r;
    const rows = this.rowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const out: CommuneRef[] = rows.map(row => {
      const c: CommuneRef = {
        id: firstNum(row.id, row.commune_id, row.code),
        name: firstStr(row.name, row.nom, row.commune, row.libelle),
        wilayaId: firstNum(row.wilaya_id, row.code_wilaya) || w,
      };
      // Ecotrack has no per-commune stop-desk flag (no office API); leave
      // hasStopDesk undefined. is_deliverable/isActive → isDeliverable.
      if (row.is_deliverable !== undefined || row.isActive !== undefined) {
        c.isDeliverable =
          row.is_deliverable === true ||
          row.is_deliverable === 1 ||
          row.isActive === true ||
          row.isActive === 1;
      }
      return c;
    });
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // listCenters — Ecotrack exposes NO stop-desk office API (noest-ecotrack.md
  // B.3/B.5/G4: S1 getOffices() returns []). Per the fail-soft contract for an
  // absent reference endpoint, we return courierOk([]) — NEVER throw, never
  // fake data, never round-trip. Desk delivery is effectively home-only via API
  // in v1. If a tenant later exposes an office endpoint, wire it here.
  // -------------------------------------------------------------------------
  async listCenters(
    _creds: CourierCredentials,
    _wilayaId: number
  ): Promise<CourierResult<CenterRef[]>> {
    return courierOk([]);
  }

  /** SYNC + pure: delegate to the Ecotrack slug→sub-state map. */
  normalizeStatus(raw: string): CourierStatus {
    return normalizeEcotrackStatus(raw);
  }

  /**
   * Ecotrack collection responses wrap rows in `{ data: [...] }` (or return a
   * bare array). Return the OBJECT-FILTERED array, [] when `data` is an empty
   * array, or null when the envelope is unexpected (→ the caller maps to
   * 'malformed').
   *
   * FAIL-SOFT (Waybill F-1): every caller `.map`s the rows and reads named
   * fields off each (`firstStr(row.name, …)`, `firstNum(row.id, …)`). A
   * malformed payload like `{ data: [null] }` / `{ data: ["x"] }` would make
   * that deref THROW a TypeError INSIDE the map — escaping `request()`'s
   * fetch-only try/catch and breaking the never-throw contract (this was live
   * bug F-1). So we filter to object rows here, at the single choke point:
   * well-formed responses are unaffected (every real row is an object), and a
   * junk element is dropped rather than crashing the request. `computeFees`
   * guards its rows via `feeRows` and its cells inline; trackParcel guards via
   * `activityRows` — none re-use this.
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
// so the side-effect runs at boot). Exported too for direct use/testing. Ships
// DARK: gated OFF by the controller until CDZ_COURIER_ECOTRACK=1 and its BYO
// creds are validated against a live tenant (see OPEN RISKS in the header).
export const ecotrackProvider = new EcotrackProvider();
registerCourierProvider(ecotrackProvider);
