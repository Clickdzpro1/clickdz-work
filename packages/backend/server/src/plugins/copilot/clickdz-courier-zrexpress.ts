// ---------------------------------------------------------------------------
// R17 (PR-D, DARK) — ZR EXPRESS provider (legacy **Procolis** platform). The
// concrete `CourierProvider` (clickdz-courier.ts) `id: 'zrexpress'`. ZR Express
// is a major Algerian courier; the vast majority of ZR merchants are still on
// the legacy Procolis API (`https://procolis.com/api_v1`). Each ClickDz merchant
// connects THEIR OWN ZR account (Token + Clé from the ZR "Développement" page —
// BYO-per-shop). The SAME Procolis API + creds also front Abex/Leopard/Colilog/
// Flash white-labels, so this impl is reusable via the base-host override.
//
// Framework-light, mirroring clickdz-courier-yalidine.ts EXACTLY: dependency-
// free, does `fetch`, imports NOTHING from Nest, throws NOTHING. Every method
// obeys the fail-soft contract from clickdz-courier.ts — resolve
// `CourierResult<T>`, a TYPED error on any failure, never a raw throw. The
// merchant's keys are read from `creds`, sent as headers, and NEVER logged or
// returned.
//
// SOURCES + CONFIDENCE (see /agent/workspace/research/zrexpress.md):
//   • Official ZR "Développement" page (verbatim add_colis/lire JSON, endpoint
//     list, embedded 58-wilaya gtabWilaya)  — Tier-1.
//   • Live curl probes vs procolis.com/api_v1 (the AUTH behavior below)  — Tier-1.
//   • PiteurStudio/CourierDZ, tkawen/shipping-dz, KaziSTM/vargo PHP SDKs
//     (endpoints, header auth, {"Colis":[…]} wrapper, MessageRetour semantics,
//     the 27-value French Situation vocabulary)  — Tier-1.
//   • DZBuild docs/dzship (58 wilayas, no label/cancel/office API, Confrimee
//     [sic] quirk)  — Tier-2 corroborating.
//
// API facts (Procolis legacy):
//   Base    https://procolis.com/api_v1   (env-overridable for Abex/clones)
//   Auth    HEADERS `token` + `key` (case-insensitive on the wire). Our
//           CourierCredentials → Procolis mapping (CONFIDENCE HIGH):
//               apiToken → header `token`  (ZR label "Token")
//               apiId    → header `key`    (ZR label "Clé"/Key)
//           This pairing is a LOCAL CONVENTION: the two are opaque strings and
//           there is no external numeric "id". PiteurStudio's README shows
//           {id,token} — that is a DOC ERROR; its own runtime + tkawen("VERIFIED")
//           + vargo + the live probe all use the token+key HEADER pair. We follow
//           the runtime, not the README. We NEVER echo/return/log either value.
//   Verify  GET /token  → HTTP 200 { "Statut":"Accès activé" } on success.
//   Create  POST /add_colis  body {"Colis":[{…}]} (1..N; we send 1). Response
//           {"Colis":[{Tracking, id_Externe, MessageRetour}]}. A 200 does NOT
//           imply success → inspect MessageRetour ("Good" ⇒ ok; "Double Tracking"
//           / other ⇒ bad_request).
//   Track   POST /lire  body {"Colis":[{Tracking}]}. Current status =
//           Colis[0].Situation. Body literal `null` ⇒ not_found.
//   Fees    POST /tarification  (body {} required or HTTP 411). Returns a FLAT
//           per-wilaya array (NOT wrapped); filter IDWilaya==toWilaya.
//
// 🔴 CRITICAL AUTH GOTCHA (live-verified, contradicts the PHP SDKs): auth
//   failure returns HTTP **200**, not 401 — you MUST detect it by parsing the
//   body. The error field name differs by endpoint: `/token` → `Statut`; data
//   endpoints (add_colis/lire/tarification) → `Retour`. A value that starts with
//   "Clé non détectée" (S1=bad token, S2=bad key/API-off) or equals "Token
//   désactivé" ⇒ `unauthorized`. POSTs MUST send Content-Type + a (possibly `{}`)
//   body or you get HTTP 411 Length Required.
//
// 🟠 DEVIATION from the interface's "Driven from the LIVE provider API — never a
//   hardcoded 58-wilaya table" intent: **Procolis exposes NO reference-data
//   endpoints** (no wilaya/commune/office list — confirmed: none of the 3 real
//   SDKs call one; vargo's getStates/getMunicipalities/getOffices are stubs;
//   dzship vendors a static JSON). So here:
//     • listWilayas — DERIVED from the /tarification response (one row per served
//       wilaya) + a tiny static id→name map for display. This IS a real API call
//       (reflects the account's served wilayas), NOT a fabricated 58-table, and
//       it picks up new wilayas if ZR adds them.
//     • listCommunes — NO API source. Returns courierOk([]) (a static commune
//       dataset is intentionally NOT vendored into this pure file). Documented.
//     • listCenters — NO API source, NO reliable static source → courierOk([]).
//       Procolis stop-desk = free-text Commune + TypeLivraison:"1"; there is NO
//       numeric stopdeskId field on create, so ParcelInput.stopdeskId is UNUSED
//       for this provider.
//
// 🟠 WILAYA UNIVERSE: ZR/Procolis is capped at **58 wilayas** (the dashboard's
//   gtabWilaya ends at #58 "El Meniaa"). Algeria's Nov-2025 move to 69 is NOT
//   reflected here; an IDWilaya > 58 will likely be rejected/misrouted. We derive
//   the served set from /tarification (never hardcode a 58- or 69-list as truth);
//   the static map below is ONLY an id→name display fallback.
//
// 🟠 LABELS / CANCEL / WEBHOOKS — confirmed ABSENT on legacy Procolis: no label
//   endpoint (print from the ZR dashboard only → ParcelResult.label always
//   undefined); no cancel endpoint (cancel = dashboard / contact ZR); no push
//   webhook (a "derniers colis mis à jour" GET poll exists but its path is
//   unknown → not implemented). The NEW platform (api.zrexpress.app) offers all
//   three, but it is a DIFFERENT API + creds (key+tenant-UUID) and is OUT OF SCOPE.
//
// ⚠️ NO SANDBOX: Procolis has no test mode — every call hits production against
//   the real account (a create is a REAL parcel). We send id_Externe = orderId
//   and treat "Double Tracking" as a typed bad_request so a retry is idempotent-ish.
//
// OPEN RISKS to verify with REAL creds before the dark flag flips (CDZ_COURIER_
// ZREXPRESS=1):
//   1. /tarification field names — `IDWilaya` confirmed; `Domicile`/`Stopdesk`/
//      `Annuler` are MED confidence (vs vargo's unverified snake_case guess). We
//      read BOTH shapes defensively; one real GET settles it.
//   2. /lire event history to API clients is UNVERIFIED (vargo says events are
//      unavailable). We map a history array if present, else SYNTHESIZE one event
//      from the current Situation so events is never empty.
//   3. Create failure `MessageRetour` vocabulary beyond "Good"/"Double Tracking"
//      is not catalogued — we carry the verbatim message on bad_request.
//   4. Commune name matching has no pre-flight validation endpoint (transliteration
//      drift can silently fail a create).
//   5. Stop-desk mechanics (TypeLivraison:"1" + desk-serving Commune sufficiency).
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

// --- Config (module-load constants; the base is env-overridable for the
// Procolis-clone hosts — Abex/Leopard/Colilog/Flash share the identical API
// under their own host — but defaults to the documented Procolis production
// host, mirroring Yalidine's base-override pattern). NEVER interpolates a secret.
const ZREXPRESS_BASE = (
  process.env.CDZ_ZREXPRESS_BASE || 'https://procolis.com/api_v1'
).replace(/\/+$/, '');

// Bounded per-call timeout. Procolis calls are quick control-plane/reference
// lookups; a hung upstream must not hold a request thread. 15s (mirrors Yalidine).
const ZREXPRESS_TIMEOUT_MS = 15_000;

// The wilaya universe cap on legacy Procolis (dashboard gtabWilaya ends at #58).
// Used only to bound the static id→name display fallback; the SERVED set is
// derived live from /tarification. NOT sent to the API as a validator.
const ZREXPRESS_MAX_WILAYA = 58;

// ---------------------------------------------------------------------------
// Loose scalar readers for the schemaless JSON Procolis returns (everything on
// the wire is a string — "0","1000" — so these coerce defensively). Mirror the
// Yalidine impl's s()/n()/priceOrNull() so this file stays dependency-free.
// ---------------------------------------------------------------------------
function s(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
/** A price cell: a finite number, or null when the class is not offered. */
function priceOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

// ---------------------------------------------------------------------------
// Static id→name display fallback for the 58 legacy-Procolis wilayas (codes
// 1→58, the ZR dashboard's embedded gtabWilaya order, ending at #58 "El Meniaa").
// This is ONLY a display lookup for listWilayas (whose SERVED set is derived live
// from /tarification) and for computeFees' toWilayaName. It is deliberately NOT a
// source of truth for which wilayas exist — see the header deviation note.
// ---------------------------------------------------------------------------
const ZREXPRESS_WILAYA_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'Adrar',
  2: 'Chlef',
  3: 'Laghouat',
  4: 'Oum El Bouaghi',
  5: 'Batna',
  6: 'Béjaïa',
  7: 'Biskra',
  8: 'Béchar',
  9: 'Blida',
  10: 'Bouira',
  11: 'Tamanrasset',
  12: 'Tébessa',
  13: 'Tlemcen',
  14: 'Tiaret',
  15: 'Tizi Ouzou',
  16: 'Alger',
  17: 'Djelfa',
  18: 'Jijel',
  19: 'Sétif',
  20: 'Saïda',
  21: 'Skikda',
  22: 'Sidi Bel Abbès',
  23: 'Annaba',
  24: 'Guelma',
  25: 'Constantine',
  26: 'Médéa',
  27: 'Mostaganem',
  28: "M'Sila",
  29: 'Mascara',
  30: 'Ouargla',
  31: 'Oran',
  32: 'El Bayadh',
  33: 'Illizi',
  34: 'Bordj Bou Arréridj',
  35: 'Boumerdès',
  36: 'El Tarf',
  37: 'Tindouf',
  38: 'Tissemsilt',
  39: 'El Oued',
  40: 'Khenchela',
  41: 'Souk Ahras',
  42: 'Tipaza',
  43: 'Mila',
  44: 'Aïn Defla',
  45: 'Naâma',
  46: 'Aïn Témouchent',
  47: 'Ghardaïa',
  48: 'Relizane',
  49: 'Timimoun',
  50: 'Bordj Badji Mokhtar',
  51: 'Ouled Djellal',
  52: 'Béni Abbès',
  53: 'In Salah',
  54: 'In Guezzam',
  55: 'Touggourt',
  56: 'Djanet',
  // "El M'Ghair", matching the canonical WILAYAS table in clickdz-erp-shipping.
  // It read "M'Ghair" here, so `wilayaIdFromName` — which normalizes and
  // compares against THIS map — could not resolve the name the rest of the ERP
  // emits, and wilaya 57 silently failed name→id resolution.
  57: "El M'Ghair",
  58: 'El Meniaa',
});

/** Resolve a wilaya code → its French display name, or '' when out of the 1..58 set. */
function wilayaName(id: number): string {
  return ZREXPRESS_WILAYA_NAMES[id] ?? '';
}

// ---------------------------------------------------------------------------
// ZR Express / Procolis raw French `Situation` → CourierStatus map. Built from
// vargo's production `ProcolisPackagesStatus` enum (27 real values); collapsed
// to the 4 coarse sub-states. Keys are stored in the FOLDED key space produced
// by the interface's `normalizeStatusRaw` (NFD, strip combining accents,
// lowercase, collapse internal whitespace) so wire drift (accents, case, extra
// spaces) still resolves. Unknown/blank ⇒ 'pending' (safe default — a never-seen
// status must never spuriously mark an order delivered/returned), exactly like
// normalizeYalidineStatus.
//
// Bucket rationale (mirrors the Yalidine map already in clickdz-courier.ts):
//   pending   — created / prepared / not yet dispatched.
//   shipped   — moving OR a non-terminal delivery snag (postponed, no-answer,
//               waiting-at-desk, exchange) — the courier still holds it & may
//               retry; a failed ATTEMPT is NOT 'returned' until an explicit
//               Retour*/Annuler* state.
//   delivered — the Livrée / Colis Livrée / Livrée [Encaisser] success terminals.
//   returned  — every Retour* state + the Annuler*/SD-Annuler* cancellations
//               (parcel heading back to / arrived at vendor). ClickDz has no
//               failed/cancelled sub-state, so these fold into 'returned' (the
//               only defensible collapse into the 4 states).
// The `Appel sans Réponse 1/2/3` and `SD - Appel sans Réponse 1/2/3` compact
// forms from the spec are expanded here into explicit per-number keys.
// ---------------------------------------------------------------------------
const ZR_STATUS_MAP: Readonly<Record<string, CourierStatus>> = Object.freeze({
  // --- pending (created / prepared / not yet dispatched) ---
  'en preparation': 'pending',
  'en traitement - pret a expedie': 'pending',
  // --- shipped (moving / non-terminal snag / in-network) ---
  dispatcher: 'shipped',
  'en livraison': 'shipped',
  'en livraison ( 1528 )': 'shipped',
  'au bureau': 'shipped',
  reporte: 'shipped',
  'appel sans reponse 1': 'shipped',
  'appel sans reponse 2': 'shipped',
  'appel sans reponse 3': 'shipped',
  'sd - appel sans reponse 1': 'shipped',
  'sd - appel sans reponse 2': 'shipped',
  'sd - appel sans reponse 3': 'shipped',
  'sd - en attente du client': 'shipped',
  'sd - reporte': 'shipped',
  'a relance': 'shipped',
  echange: 'shipped',
  // --- delivered (success terminals only) ---
  livree: 'delivered',
  'colis livree': 'delivered',
  'livree [ encaisser ]': 'delivered',
  // --- returned (terminal, heading back to vendor) ---
  'annuler par le client': 'returned',
  'sd - annuler par le client': 'returned',
  'sd - annuler 3x': 'returned',
  'retour de dispatche': 'returned',
  'retour livreur': 'returned',
  'retour navette': 'returned',
  'retour stock': 'returned',
});

/**
 * Map a Procolis raw `Situation` string → a CourierStatus. Unknown/blank ⇒
 * 'pending' (never spuriously terminal). Accent/case/whitespace-insensitive via
 * the shared `normalizeStatusRaw`. Beyond the exact table, a small prefix-based
 * fallback absorbs the two documented drift families (hub-tagged `En Livraison
 * ( 1528 )`-style variants → shipped; any `retour…` prefix → returned) without
 * risking a false 'delivered'. Pure + total (never throws on odd input).
 */
function normalizeZRExpressStatus(raw: unknown): CourierStatus {
  const key = normalizeStatusRaw(raw);
  if (!key) return 'pending';
  const exact = ZR_STATUS_MAP[key];
  if (exact) return exact;
  // Drift-tolerant fallbacks (only for the SAFE, non-'delivered' buckets so a
  // tenant-customized string never spuriously reads as a success terminal).
  if (key.startsWith('retour')) return 'returned';
  if (key.startsWith('en livraison')) return 'shipped';
  if (key.startsWith('appel sans reponse')) return 'shipped';
  if (key.startsWith('sd - ')) return 'shipped';
  return 'pending';
}

/**
 * True when a Procolis status/response field carries an auth-failure sentinel.
 * Auth failure returns HTTP 200 with `Statut` (on /token) or `Retour` (on data
 * endpoints) = "Clé non détectée S1/S2" or "Token désactivé". Folded compare so
 * accent/case drift ("Clé"/"cle") still matches.
 */
function isAuthFailureText(v: unknown): boolean {
  const key = normalizeStatusRaw(v);
  if (!key) return false;
  return key.startsWith('cle non detectee') || key === 'token desactive';
}

// ---------------------------------------------------------------------------
// The ZR Express (Procolis) provider. One stateless singleton (registered at
// module load). Every method: build the URL, attach the two auth headers, 15s
// abort, then map the outcome to CourierResult. A thrown fetch (network/timeout/
// abort) → 'unreachable'; a non-2xx → the typed status map; a 200 whose BODY is
// an auth sentinel → 'unauthorized'; a 2xx with an unparseable/unexpected body
// → 'malformed'.
// ---------------------------------------------------------------------------
class ZRExpressProvider implements CourierProvider {
  readonly id = 'zrexpress' as const;
  /** ZR Express / Procolis needs BOTH creds (token + key headers). */
  readonly requiresApiId = true as const;

  /**
   * Build the two required auth headers from the unsealed creds. Mapping:
   * apiToken → `token`, apiId → `key` (see header comment). Lowercase names
   * (HTTP header names are case-insensitive; PiteurStudio/tkawen use lowercase).
   */
  private authHeaders(creds: CourierCredentials): Record<string, string> {
    return {
      token: s(creds?.apiToken),
      key: s(creds?.apiId),
      Accept: 'application/json',
    };
  }

  /**
   * Core request → typed result carrying the parsed JSON. Reads the body ONCE.
   * Handles Procolis' quirks: (a) auth failure arrives as HTTP 200 with an auth
   * sentinel in `Statut`/`Retour` → mapped to 'unauthorized' here so every
   * caller inherits it; (b) POSTs always carry Content-Type + a body (a bodyless
   * POST → HTTP 411). On a thrown fetch → 'unreachable'. On a real non-2xx → the
   * typed status map. Never logs headers/creds; never throws.
   */
  private async request(
    creds: CourierCredentials,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<CourierResult<unknown>> {
    // Guard: both creds must be present before any network traffic (Procolis
    // returns an auth sentinel anyway, but this avoids a pointless round-trip).
    if (!s(creds?.apiId) || !s(creds?.apiToken)) {
      return courierErr('unauthorized', { message: 'missing_credentials' });
    }
    const url = `${ZREXPRESS_BASE}${path}`;
    const headers: Record<string, string> = this.authHeaders(creds);
    // POSTs MUST send a body + Content-Type or Procolis answers HTTP 411. For a
    // POST with no explicit body we still send `{}` to satisfy Content-Length.
    const sendBody = method === 'POST' ? (body !== undefined ? body : {}) : body;
    if (sendBody !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(sendBody !== undefined ? { body: JSON.stringify(sendBody) } : {}),
        signal: AbortSignal.timeout(ZREXPRESS_TIMEOUT_MS),
      });
    } catch {
      // Network error / DNS / connection reset / AbortSignal timeout.
      return courierErr('unreachable');
    }
    // Read the body once, defensively. Procolis returns JSON for success AND for
    // its 200-with-error auth sentinels; /lire returns the literal `null` for an
    // unknown tracking; a proxy could return non-JSON on a 5xx.
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
      // A genuine HTTP error (405 wrong-method, 411 no-body, 5xx, etc.).
      const msg =
        json && typeof json === 'object'
          ? s((json as any).Retour || (json as any).Statut).slice(0, 200) ||
            undefined
          : undefined;
      return this.errorFromStatus(res.status, msg, this.parseRetryAfter(res));
    }
    // 🔴 200-on-failure: detect the auth sentinel in the BODY (field name differs
    // by endpoint: `Statut` on /token, `Retour` on data endpoints). This is the
    // live-verified gotcha the PHP SDKs miss.
    if (json && typeof json === 'object') {
      const sentinel =
        (json as any).Retour !== undefined
          ? (json as any).Retour
          : (json as any).Statut;
      if (sentinel !== undefined && isAuthFailureText(sentinel)) {
        return courierErr('unauthorized', {
          status: res.status,
          message: s(sentinel).slice(0, 200),
        });
      }
    }
    return courierOk(json);
  }

  /**
   * Map a real HTTP status → typed CourierError. Reads Retry-After on a 429.
   * NEVER reads/echoes credentials. (Procolis rarely emits a true non-2xx — 405
   * for a wrong method, 411 for a bodyless POST, or a 5xx — since auth failures
   * come back as 200 and are handled in request().)
   */
  private errorFromStatus(status: number, bodyMsg?: string, retryAfter?: number) {
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
  private parseRetryAfter(res: Response): number | undefined {
    const raw = res.headers.get('retry-after');
    if (!raw) return undefined;
    const secs = Number(raw.trim());
    return Number.isFinite(secs) && secs >= 0 ? secs : undefined;
  }

  /**
   * Unwrap Procolis' `{ "Colis": [...] }` envelope → the array, filtered to
   * OBJECT rows only, or null when the envelope is unexpected (→ the caller maps
   * to 'malformed'). Tolerates a bare top-level array too (defensive).
   *
   * FAIL-SOFT (Waybill F-1, carried over from the Yalidine impl): every caller
   * `.map`s these rows and dereferences named fields (`s(row.Tracking)`,
   * `s(row.Situation)`, …). A malformed upstream payload like `{"Colis":[null]}`
   * or `{"Colis":["x"]}` would make that deref THROW a TypeError *inside* the map
   * — escaping request()'s fetch-only try/catch and breaking the never-throw
   * contract. So we filter to object rows here at the single choke point:
   * well-formed responses are unaffected (every real row is an object) and a junk
   * element is dropped rather than crashing the request.
   */
  private colisOf(payload: unknown): any[] | null {
    if (Array.isArray(payload)) {
      return payload.filter(r => r != null && typeof r === 'object');
    }
    if (payload && typeof payload === 'object') {
      const arr = (payload as any).Colis;
      if (Array.isArray(arr)) {
        return arr.filter(r => r != null && typeof r === 'object');
      }
    }
    return null;
  }

  /**
   * Unwrap the /tarification response → the FLAT array of per-wilaya rows,
   * filtered to OBJECT rows only, or null when unexpected. Tarification is NOT
   * wrapped in `Colis` — it is a bare top-level array — but we also tolerate a
   * `{Colis:[…]}`/`{data:[…]}` wrap just in case a clone host differs. Same
   * object-filter guard as colisOf (F-1).
   */
  private tarifRowsOf(payload: unknown): any[] | null {
    if (Array.isArray(payload)) {
      return payload.filter(r => r != null && typeof r === 'object');
    }
    if (payload && typeof payload === 'object') {
      const arr =
        (payload as any).Colis ??
        (payload as any).data ??
        (payload as any).Tarifs;
      if (Array.isArray(arr)) {
        return arr.filter(r => r != null && typeof r === 'object');
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // createParcel — POST /add_colis with a single-element `Colis` array. The
  // response mirrors the request order; a 200 does NOT guarantee per-item
  // success, so we locate Colis[0] and require MessageRetour === "Good" + a
  // Tracking. "Double Tracking" (reused id_Externe/Tracking) → bad_request;
  // any other MessageRetour → bad_request carrying the verbatim message. No
  // label is ever returned (ParcelResult.label stays undefined). NOT wired to a
  // route in PR-A/PR-D (dark).
  //
  // Field notes: keep `Confrimee` MISSPELLED (the API's forever-typo); we send
  // "1" (create already ready-to-ship — the common integration path). fromWilaya,
  // weight, economic, stopdeskId, freeshipping have NO Procolis field (documented
  // in the header). Stop-desk = TypeLivraison "1" + free-text Commune, no id.
  // -------------------------------------------------------------------------
  async createParcel(
    creds: CourierCredentials,
    parcel: ParcelInput
  ): Promise<CourierResult<ParcelResult>> {
    const orderId = s(parcel?.orderId);
    const client = `${s(parcel?.firstname)} ${s(parcel?.familyname)}`.trim();
    // Resolve destination wilaya code from the provided name (best-effort; the
    // caller normally passes a name resolved from listWilayas). We accept a
    // numeric-looking name too.
    const wilayaCode = this.resolveWilayaCode(parcel?.toWilayaName);
    const item: Record<string, string> = {
      Tracking: '', // let ZR generate it (returned in the response).
      TypeLivraison: parcel?.isStopdesk === true ? '1' : '0', // 0 home, 1 stopdesk
      TypeColis: '0', // 1 = exchange; ParcelInput has no exchange flag → 0.
      Confrimee: '1', // [sic] 1 ⇒ created already-confirmed / ready-to-ship.
      Client: client,
      MobileA: s(parcel?.contactPhone),
      MobileB: '',
      Adresse: s(parcel?.address) || s(parcel?.toCommuneName),
      IDWilaya: wilayaCode > 0 ? String(wilayaCode) : s(parcel?.toWilayaName),
      Commune: s(parcel?.toCommuneName),
      // Total = COD amount in DZD (product subtotal). ZR always collects Total;
      // freeshipping is a caller-side pricing decision with no Procolis field.
      Total: String(n(parcel?.price)),
      Note: '',
      TProduit: s(parcel?.productList),
      id_Externe: orderId, // your order id, echoed back for correlation.
      Source: 'ClickDz',
    };
    const r = await this.request(creds, 'POST', '/add_colis', { Colis: [item] });
    if (!r.ok) return r;
    const rows = this.colisOf(r.value);
    if (rows === null) return courierErr('malformed');
    // The single parcel we sent → the first (and only) entry we expect back.
    const entry = rows.length ? rows[0] : null;
    if (!entry || typeof entry !== 'object') return courierErr('malformed');
    const message = s(entry.MessageRetour);
    const tracking = s(entry.Tracking);
    // Per-item success ⇔ MessageRetour === "Good" (+ a real tracking number).
    if (normalizeStatusRaw(message) !== 'good' || !tracking) {
      // "Double Tracking" (duplicate) and every other non-"Good" message are
      // client-fixable → typed bad_request carrying the verbatim ZR message.
      return courierErr('bad_request', {
        message: message.slice(0, 200) || 'parcel_rejected',
      });
    }
    const out: ParcelResult = { tracking };
    // Prefer the id_Externe ZR echoes back; fall back to our orderId.
    const echoed = s(entry.id_Externe) || orderId;
    if (echoed) out.orderId = echoed;
    // label is never returned by legacy Procolis → left undefined.
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // trackParcel — POST /lire with a single-element `Colis` array of {Tracking}.
  // Current status = Colis[0].Situation → lastRawStatus. Body literal `null`
  // (unknown tracking) → not_found. History-array availability to API clients is
  // UNVERIFIED (vargo reports events are unavailable): if the entry carries a
  // recognizable history array we map it; otherwise we SYNTHESIZE a single event
  // from the current Situation so `events` is never empty. Never throws.
  // -------------------------------------------------------------------------
  async trackParcel(
    creds: CourierCredentials,
    tracking: string
  ): Promise<CourierResult<TrackResult>> {
    const t = s(tracking).trim();
    if (!t) return courierErr('bad_request', { message: 'missing_tracking' });
    const r = await this.request(creds, 'POST', '/lire', {
      Colis: [{ Tracking: t }],
    });
    if (!r.ok) return r;
    // Unknown tracking ⇒ Procolis returns the literal `null` (parsed to JS null).
    if (r.value === null) return courierErr('not_found');
    const rows = this.colisOf(r.value);
    if (rows === null) return courierErr('malformed');
    const entry = rows.length ? rows[0] : null;
    if (!entry || typeof entry !== 'object') {
      // A well-formed-but-empty Colis array = no parcel matched → not_found.
      return courierErr('not_found');
    }
    const lastRawStatus = s(entry.Situation);
    // Try to surface a real history array if the API returns one to clients.
    const events = this.eventsFrom(entry);
    if (!events.length && lastRawStatus) {
      // Fallback: synthesize a single current-state event (no reliable date on
      // the wire → empty date). Documented as an OPEN RISK.
      events.push({ date: '', rawStatus: lastRawStatus });
    }
    return courierOk({ lastRawStatus, events });
  }

  // -------------------------------------------------------------------------
  // computeFees — POST /tarification (returns ALL served wilayas at once; there
  // is no per-pair query). We ignore `fromWilaya` (Procolis has NO origin
  // dimension), fetch the full array, find the row where IDWilaya == toWilaya,
  // and build a FeeResult. No matching row → not_found. Field names are read
  // DEFENSIVELY (Domicile ?? tarif_domicile, etc.) per the MED-confidence risk.
  // Procolis has no commune-level pricing/zone/COD-%/insurance/oversize → those
  // stay null/undefined; perCommune is ONE synthetic wilaya-level row.
  // -------------------------------------------------------------------------
  async computeFees(
    creds: CourierCredentials,
    fromWilaya: number,
    toWilaya: number
  ): Promise<CourierResult<FeeResult>> {
    const to = n(toWilaya);
    if (!to) return courierErr('bad_request', { message: 'invalid_wilaya' });
    const r = await this.request(creds, 'POST', '/tarification', {});
    if (!r.ok) return r;
    const rows = this.tarifRowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    // Locate the row for the destination wilaya (IDWilaya, defensively wilaya_id).
    const row = rows.find(
      x => n(x.IDWilaya !== undefined ? x.IDWilaya : x.wilaya_id) === to
    );
    if (!row) return courierErr('not_found');
    const home = priceOrNull(
      row.Domicile !== undefined ? row.Domicile : row.tarif_domicile
    );
    const desk = priceOrNull(
      row.Stopdesk !== undefined ? row.Stopdesk : row.tarif_stopdesk
    );
    const ret = priceOrNull(
      row.Annuler !== undefined ? row.Annuler : row.tarif_retour
    );
    const toName = wilayaName(to) || s(row.Wilaya) || String(to);
    const fromName = n(fromWilaya) > 0 ? wilayaName(n(fromWilaya)) : '';
    // Procolis has NO per-commune matrix → one synthetic row keyed by the wilaya
    // so the interface's Record<string,CommuneFee> is populated for the FE.
    const perCommune: Record<string, CommuneFee> = {
      [String(to)]: {
        communeName: toName, // wilaya-level price (no commune breakdown)
        expressHome: home, // Domicile
        expressDesk: desk, // Stopdesk
        economicHome: null, // Procolis has no economic class
        economicDesk: null,
      },
    };
    const out: FeeResult = {
      fromWilayaName: fromName,
      toWilayaName: toName,
      perCommune,
    };
    // Return fee (Annuler) when present; zone/codPercentage/insurance/oversize
    // are NOT provided by Procolis → intentionally omitted (never fabricated).
    if (ret !== null) out.retourFee = ret;
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // listWilayas — DERIVED from /tarification (Procolis has no wilaya-list
  // endpoint). One row per served wilaya → WilayaRef{ id, name (static lookup),
  // isDeliverable: true }. This is a real API call (reflects the account's served
  // set) and picks up new wilayas ZR adds; the static name map is display-only.
  // Rows with an out-of-range/zero IDWilaya are dropped. Also usable by the
  // controller's connect route as a credential-validation "test connection" call
  // (an auth sentinel already maps to 'unauthorized' in request()).
  // -------------------------------------------------------------------------
  async listWilayas(
    creds: CourierCredentials
  ): Promise<CourierResult<WilayaRef[]>> {
    const r = await this.request(creds, 'POST', '/tarification', {});
    if (!r.ok) return r;
    const rows = this.tarifRowsOf(r.value);
    if (rows === null) return courierErr('malformed');
    const seen = new Set<number>();
    const out: WilayaRef[] = [];
    for (const row of rows) {
      const id = n(row.IDWilaya !== undefined ? row.IDWilaya : row.wilaya_id);
      // Guard against a bad/zero id and de-dupe (the feed should be 1 row/wilaya).
      if (!id || id < 1 || id > ZREXPRESS_MAX_WILAYA || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: wilayaName(id) || s(row.Wilaya) || String(id),
        isDeliverable: true,
      });
    }
    return courierOk(out);
  }

  // -------------------------------------------------------------------------
  // listCommunes — NO Procolis endpoint and NO static dataset vendored into this
  // pure file → return courierOk([]) (an empty, honest result rather than a
  // fabricated list). Documented deviation: on this provider a commune is a
  // free-text `Commune` string on create, matched against ZR's internal list
  // (no pre-flight validation API). See header + OPEN RISKS #4.
  // -------------------------------------------------------------------------
  async listCommunes(
    creds: CourierCredentials,
    wilayaId: number
  ): Promise<CourierResult<CommuneRef[]>> {
    // Validate the arg shape for a consistent contract, but there is no source
    // to query — always an empty list. (creds intentionally unused: no network.)
    void creds;
    const w = n(wilayaId);
    if (!w) return courierErr('bad_request', { message: 'invalid_wilaya' });
    return courierOk<CommuneRef[]>([]);
  }

  // -------------------------------------------------------------------------
  // listCenters — NO Procolis endpoint and NO reliable static source for ZR's
  // stop-desk offices → return courierOk([]). Documented: Procolis stop-desk
  // selection uses the commune name + TypeLivraison:"1", NOT a numeric
  // stopdeskId (Procolis create has no stop-desk-id field → ParcelInput.stopdeskId
  // is UNUSED for this provider). See header + OPEN RISKS #6.
  // -------------------------------------------------------------------------
  async listCenters(
    creds: CourierCredentials,
    wilayaId: number
  ): Promise<CourierResult<CenterRef[]>> {
    void creds;
    const w = n(wilayaId);
    if (!w) return courierErr('bad_request', { message: 'invalid_wilaya' });
    return courierOk<CenterRef[]>([]);
  }

  /** SYNC + pure: delegate to the ZR/Procolis FR→sub-state map. */
  normalizeStatus(raw: string): CourierStatus {
    return normalizeZRExpressStatus(raw);
  }

  // -------------------------------------------------------------------------
  // Private helpers.
  // -------------------------------------------------------------------------

  /**
   * Best-effort resolve a wilaya NAME (or numeric-looking string) → its 1..58
   * Procolis code. Returns 0 when unresolved (the caller then falls back to the
   * raw string in IDWilaya). Accent/case/whitespace-insensitive via the shared
   * fold. Pure + total.
   */
  private resolveWilayaCode(name: unknown): number {
    // A numeric-looking name is taken as the code directly.
    const asNum = Number(s(name).trim());
    if (Number.isFinite(asNum) && asNum >= 1 && asNum <= ZREXPRESS_MAX_WILAYA) {
      return asNum;
    }
    const key = normalizeStatusRaw(name);
    if (!key) return 0;
    for (const idStr of Object.keys(ZREXPRESS_WILAYA_NAMES)) {
      const id = Number(idStr);
      if (normalizeStatusRaw(ZREXPRESS_WILAYA_NAMES[id]) === key) return id;
    }
    return 0;
  }

  /**
   * Extract a tracking history array from a /lire entry IF the API returns one
   * to clients (UNVERIFIED — see OPEN RISKS #2). Looks for the common shapes
   * (`h`, `historique`, `Situations`, `history`) and maps each OBJECT row to a
   * TrackEvent. Object-filtered so a junk row can't throw inside the map (F-1).
   * Returns [] when no recognizable array exists (the caller then synthesizes a
   * single current-state event). Pure + total.
   */
  private eventsFrom(entry: Record<string, any>): TrackEvent[] {
    const candidate =
      entry.h ?? entry.historique ?? entry.Situations ?? entry.history;
    if (!Array.isArray(candidate)) return [];
    const rows = candidate.filter(r => r != null && typeof r === 'object');
    return rows.map((row: any) => {
      // Date = DateA (date) optionally joined with Date_Action (time).
      const date = s(row.DateA);
      const time = s(row.Date_Action);
      const ev: TrackEvent = {
        date: time ? `${date} ${time}`.trim() : date,
        rawStatus: s(row.Situation),
      };
      const reason = s(row.Commentaire);
      if (reason) ev.reason = reason;
      const wname = wilayaName(n(row.IDWilaya));
      if (wname) ev.wilayaName = wname;
      const commune = s(row.Commune);
      if (commune) ev.communeName = commune;
      return ev;
    });
  }
}

// The shared singleton + self-registration. Importing this module registers the
// provider into clickdz-courier.ts's registry (the controller imports this file,
// so the side-effect runs at boot). Exported too for direct use/testing. The
// provider ships DARK — gated OFF by CDZ_COURIER_ZREXPRESS until real creds are
// validated against the live API (see header OPEN RISKS).
export const zrexpressProvider = new ZRExpressProvider();
registerCourierProvider(zrexpressProvider);
