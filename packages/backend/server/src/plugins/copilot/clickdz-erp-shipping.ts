// ---------------------------------------------------------------------------
// WSE-6 (R2-c) — LIVRAISON: couriers + the canonical 58-wilaya shipping matrix.
//
// This is a PURE logic module (types + validation + tiny pure helpers only) —
// NO Nest decorators, NO framework error classes, NO fetch, NO Node imports —
// mirroring `clickdz-features.ts` / `clickdz-app-source.ts`. It is therefore
// boot-safe when imported and unit-testable in isolation. The bridge controller
// (`clickdz-bridge.controller.ts`) owns the network side (server-side data-API
// fetch, the re-derived per-slug write token, ownership via assertOwnsErpApp,
// `@Res` passthrough + typed `../../base` errors); it delegates ALL computation
// — validation, id building, CSV parsing, fee lookup, tracking-status mapping,
// order-record shaping — to the pure functions exported here. Cross-cutting
// values (the existing collection rows, the write token) are INJECTED by the
// caller rather than re-read here, so there is no duplicated env/coupling.
//
// Record shapes are PINNED by R2-CONTRACT.md (cross-builder — Tiroir's caisse
// references `courierId`; do NOT change field names):
//   Courier       collection `couriers`      { id, name, phone?, active,
//                                               codFee?, createdAt }  id kebab
//   Shipping rate collection `shipping-rates` { id: '<courierId>:<wilayaCode>',
//                                               courierId, wilaya (1-58), fee,
//                                               homeFee?, deskFee? }
//
// Tracking is a SUB-state stored ON the order record (fields `tracking` +
// `courierId` + `deliveryMode` + `trackingAt`); it maps onto the existing 5
// order statuses (Nouvelle/Confirmée/Expédiée/Livrée/Retournée) WITHOUT
// replacing them — see TRACKING_STATUSES / trackingToOrderStatus below.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CANONICAL 58-WILAYA TABLE — the single server-side source of truth.
//
// Extracted VERBATIM from the shop template's checkout selector
// (`clickdz-shop-template.ts`, the `var WILAYAS = [...]` list, official DZ
// numbering 1-58). The template stores each option as a display string
// `'NN - Name'`; here we split it into a typed { code, name } record so server
// code can look up / validate by numeric code without re-parsing the label.
// Tiroir (caisse) and future FE consume THIS export — its name + shape are the
// contract (see NOTES). The `label` getter reproduces the template's exact
// `'NN - Name'` string so a UI can render the identical option text.
// ---------------------------------------------------------------------------

/** One Algerian wilaya: official code (1-58) + French name. */
export interface Wilaya {
  code: number;
  name: string;
}

/**
 * The definitive 58 Algerian wilayas (official 2019+ numbering incl. the 10 new
 * southern wilayas 49-58). Names are byte-identical to the shop template's
 * checkout options. Frozen so no consumer can mutate the shared source.
 */
export const WILAYAS: readonly Wilaya[] = Object.freeze([
  { code: 1, name: 'Adrar' },
  { code: 2, name: 'Chlef' },
  { code: 3, name: 'Laghouat' },
  { code: 4, name: 'Oum El Bouaghi' },
  { code: 5, name: 'Batna' },
  { code: 6, name: 'Béjaïa' },
  { code: 7, name: 'Biskra' },
  { code: 8, name: 'Béchar' },
  { code: 9, name: 'Blida' },
  { code: 10, name: 'Bouira' },
  { code: 11, name: 'Tamanrasset' },
  { code: 12, name: 'Tébessa' },
  { code: 13, name: 'Tlemcen' },
  { code: 14, name: 'Tiaret' },
  { code: 15, name: 'Tizi Ouzou' },
  { code: 16, name: 'Alger' },
  { code: 17, name: 'Djelfa' },
  { code: 18, name: 'Jijel' },
  { code: 19, name: 'Sétif' },
  { code: 20, name: 'Saïda' },
  { code: 21, name: 'Skikda' },
  { code: 22, name: 'Sidi Bel Abbès' },
  { code: 23, name: 'Annaba' },
  { code: 24, name: 'Guelma' },
  { code: 25, name: 'Constantine' },
  { code: 26, name: 'Médéa' },
  { code: 27, name: 'Mostaganem' },
  { code: 28, name: "M'Sila" },
  { code: 29, name: 'Mascara' },
  { code: 30, name: 'Ouargla' },
  { code: 31, name: 'Oran' },
  { code: 32, name: 'El Bayadh' },
  { code: 33, name: 'Illizi' },
  { code: 34, name: 'Bordj Bou Arréridj' },
  { code: 35, name: 'Boumerdès' },
  { code: 36, name: 'El Tarf' },
  { code: 37, name: 'Tindouf' },
  { code: 38, name: 'Tissemsilt' },
  { code: 39, name: 'El Oued' },
  { code: 40, name: 'Khenchela' },
  { code: 41, name: 'Souk Ahras' },
  { code: 42, name: 'Tipaza' },
  { code: 43, name: 'Mila' },
  { code: 44, name: 'Aïn Defla' },
  { code: 45, name: 'Naâma' },
  { code: 46, name: 'Aïn Témouchent' },
  { code: 47, name: 'Ghardaïa' },
  { code: 48, name: 'Relizane' },
  { code: 49, name: 'Timimoun' },
  { code: 50, name: 'Bordj Badji Mokhtar' },
  { code: 51, name: 'Ouled Djellal' },
  { code: 52, name: 'Béni Abbès' },
  { code: 53, name: 'In Salah' },
  { code: 54, name: 'In Guezzam' },
  { code: 55, name: 'Touggourt' },
  { code: 56, name: 'Djanet' },
  { code: 57, name: "El M'Ghair" },
  { code: 58, name: 'El Meniaa' },
]);

/** Total number of wilayas — the matrix always has exactly this many rows. */
export const WILAYA_COUNT = WILAYAS.length; // 58

/** Fast code→name map for O(1) validation / label rendering. */
const WILAYA_NAME_BY_CODE: ReadonlyMap<number, string> = new Map(
  WILAYAS.map(w => [w.code, w.name])
);

/** A wilaya code is valid iff it is an integer in the canonical [1,58] set. */
export function isValidWilaya(code: unknown): boolean {
  const n = Number(code);
  return Number.isInteger(n) && WILAYA_NAME_BY_CODE.has(n);
}

/** Name for a code, or '' when the code is not a canonical wilaya. */
export function wilayaName(code: number): string {
  return WILAYA_NAME_BY_CODE.get(code) ?? '';
}

/**
 * The exact `'NN - Name'` display label the shop template's checkout selector
 * uses (zero-padded 2-digit code). '' for an unknown code.
 */
export function wilayaLabel(code: number): string {
  const name = wilayaName(code);
  if (!name) return '';
  return `${String(code).padStart(2, '0')} - ${name}`;
}

/**
 * Extract the leading numeric wilaya code from any of the shapes an order/
 * checkout may carry: a bare number, a numeric string, or the template's
 * `'NN - Name'` option value (also '16 Alger' / '16'). 0 when none parses —
 * mirrors the template's `wilCode()` (strip leading zeros).
 */
export function wilayaCodeFrom(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : 0;
  }
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  const m = s.match(/\d+/);
  if (!m) return 0;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Shared scalar readers (module-local; mirror the bridge's erpStr/erpNum so the
// pure module stays dependency-free — the bridge passes schemaless data-API
// records straight in).
// ---------------------------------------------------------------------------
type Rec = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
/** Non-negative rounded integer (DZD fees are whole dinars). */
function fee(v: unknown): number {
  return Math.max(0, Math.round(num(v)));
}

// ---------------------------------------------------------------------------
// COURIER (pinned shape). CRUD is delegated to the data API by the bridge; this
// module owns id derivation + field validation + the stored record shape.
// ---------------------------------------------------------------------------

/** Courier record as stored in collection `couriers` (R2-CONTRACT pinned). */
export interface Courier {
  id: string;
  name: string;
  phone?: string;
  active: boolean;
  codFee?: number;
  createdAt: string;
}

/** Delivery modes an order can pick — home delivery vs stop-desk pickup. */
export const DELIVERY_MODES = ['home', 'desk'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** Default mode when none is supplied (Algeria: à-domicile is the common case). */
export const DEFAULT_DELIVERY_MODE: DeliveryMode = 'home';

export function isDeliveryMode(v: unknown): v is DeliveryMode {
  return v === 'home' || v === 'desk';
}

/** Coerce/normalize a delivery mode; unknown/absent → the default. */
export function normalizeDeliveryMode(v: unknown): DeliveryMode {
  return isDeliveryMode(v) ? v : DEFAULT_DELIVERY_MODE;
}

const COURIER_ID_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const COURIER_NAME_MAX = 60;
const COURIER_PHONE_MAX = 20;

/**
 * Kebab-case a courier NAME into a stable business-key id (matches
 * R2-CONTRACT: "id kebab-case slug"). Accents are stripped, non-alphanumerics
 * collapse to single hyphens, result is lowercased + trimmed to ≤50 chars.
 * '' when nothing usable remains (caller must reject).
 */
export function courierIdFromName(name: string): string {
  const slug = str(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // drop combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  // WS17: isValidCourierId requires 2-50 chars. A single-word name like "A"
  // produces a 1-char slug that would fail validation. Pad with a short suffix
  // so a valid name never gets rejected on the id field.
  if (slug.length === 1) return `${slug}-x`;
  return slug;
}

/** A courier id is valid iff kebab-case, 2-50 chars, no leading/trailing dash. */
export function isValidCourierId(id: unknown): boolean {
  return typeof id === 'string' && COURIER_ID_RE.test(id);
}

export type CourierValidation =
  | { ok: true; courier: Courier }
  | { ok: false; field: string };

/**
 * Validate + shape a courier for CREATE. `raw` is the caller body. Derives the
 * id from `id` (if a valid slug) else from `name`. Returns the exact record to
 * persist (pinned shape) or the offending field name. `createdAt` is injected
 * by the caller-controlled `now` so this stays pure/deterministic.
 */
export function buildCourierRecord(raw: unknown, now: string): CourierValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, field: 'body' };
  }
  const r = raw as Rec;
  const name = str(r.name).trim().slice(0, COURIER_NAME_MAX);
  if (!name) return { ok: false, field: 'name' };
  const suppliedId = str(r.id).trim().toLowerCase();
  const id = isValidCourierId(suppliedId) ? suppliedId : courierIdFromName(name);
  if (!isValidCourierId(id)) return { ok: false, field: 'id' };
  const courier: Courier = {
    id,
    name,
    active: r.active === undefined ? true : Boolean(r.active),
    createdAt: str(now) || new Date(0).toISOString(),
  };
  const phone = str(r.phone).trim().slice(0, COURIER_PHONE_MAX);
  if (phone) courier.phone = phone;
  if (r.codFee !== undefined) courier.codFee = fee(r.codFee);
  return { ok: true, courier };
}

/**
 * Merge a caller PATCH onto an existing stored courier for UPDATE (PUT). The id
 * + createdAt are IMMUTABLE (kept from `existing`); only name/phone/active/
 * codFee may change. Absent fields are preserved. Returns the full merged
 * record to write in place, or the offending field.
 */
export function mergeCourierPatch(
  existing: Rec,
  patch: unknown
): CourierValidation {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, field: 'body' };
  }
  const p = patch as Rec;
  const id = str(existing.id);
  if (!isValidCourierId(id)) return { ok: false, field: 'id' };
  const merged: Courier = {
    id,
    name: str(existing.name).slice(0, COURIER_NAME_MAX),
    active: existing.active === undefined ? true : Boolean(existing.active),
    createdAt: str(existing.createdAt) || new Date(0).toISOString(),
  };
  const existingPhone = str(existing.phone).trim();
  if (existingPhone) merged.phone = existingPhone.slice(0, COURIER_PHONE_MAX);
  if (existing.codFee !== undefined) merged.codFee = fee(existing.codFee);

  if (p.name !== undefined) {
    const name = str(p.name).trim().slice(0, COURIER_NAME_MAX);
    if (!name) return { ok: false, field: 'name' };
    merged.name = name;
  }
  if (p.phone !== undefined) {
    const phone = str(p.phone).trim().slice(0, COURIER_PHONE_MAX);
    if (phone) merged.phone = phone;
    else delete merged.phone;
  }
  if (p.active !== undefined) merged.active = Boolean(p.active);
  if (p.codFee !== undefined) merged.codFee = fee(p.codFee);
  return { ok: true, courier: merged };
}

// ---------------------------------------------------------------------------
// SHIPPING RATE MATRIX (pinned shape). Each courier has up to 58 rows in the
// unpartitioned `shipping-rates` collection, one per wilaya, id
// `<courierId>:<wilayaCode>`. This keeps records tiny (well under the 8KB cap)
// and lets a single wilaya's fee be edited in place without rewriting a 58-entry
// singleton (which would also risk the 8KB limit for verbose courier names).
// ---------------------------------------------------------------------------

/** Shipping-rate record as stored in collection `shipping-rates` (pinned). */
export interface ShippingRate {
  id: string;
  courierId: string;
  wilaya: number;
  fee: number;
  homeFee?: number;
  deskFee?: number;
}

/** The pinned id format for a rate row: `<courierId>:<wilayaCode>`. */
export function rateId(courierId: string, wilaya: number): string {
  return `${courierId}:${wilaya}`;
}

/** Parse a rate id back into its parts, or null when malformed. */
export function parseRateId(
  id: string
): { courierId: string; wilaya: number } | null {
  const idx = str(id).lastIndexOf(':');
  if (idx <= 0) return null;
  const courierId = id.slice(0, idx);
  const wilaya = parseInt(id.slice(idx + 1), 10);
  if (!isValidCourierId(courierId) || !isValidWilaya(wilaya)) return null;
  return { courierId, wilaya };
}

/** One incoming rate row before validation (from the bulk-set body). */
export interface RateInput {
  wilaya: unknown;
  fee?: unknown;
  homeFee?: unknown;
  deskFee?: unknown;
}

export type BulkRatesResult =
  | { ok: true; records: ShippingRate[] }
  | { ok: false; error: string; wilaya?: number };

/**
 * Validate + shape a BULK rate-set for one courier. Each input row must carry a
 * canonical wilaya code and at least one fee (`fee`, `homeFee`, or `deskFee`).
 * `fee` acts as the base/fallback; when only home/desk are given, `fee` is
 * derived as the min of the two (so a single-fee matrix lookup still resolves).
 * Duplicate wilayas collapse to the LAST occurrence. Returns one pinned-shape
 * record per row (id = `<courierId>:<wilaya>`), ready for the caller to upsert.
 */
export function buildBulkRates(
  courierId: string,
  rows: unknown
): BulkRatesResult {
  if (!isValidCourierId(courierId)) {
    return { ok: false, error: 'invalid_courier' };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: 'rates_required' };
  }
  if (rows.length > WILAYA_COUNT) {
    return { ok: false, error: 'too_many_rates' };
  }
  const byWilaya = new Map<number, ShippingRate>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'bad_row' };
    }
    const row = raw as RateInput;
    const w = wilayaCodeFrom(row.wilaya);
    if (!isValidWilaya(w)) {
      return { ok: false, error: 'bad_wilaya', wilaya: w || undefined };
    }
    const hasBase = row.fee !== undefined && row.fee !== null && row.fee !== '';
    const hasHome =
      row.homeFee !== undefined && row.homeFee !== null && row.homeFee !== '';
    const hasDesk =
      row.deskFee !== undefined && row.deskFee !== null && row.deskFee !== '';
    if (!hasBase && !hasHome && !hasDesk) {
      return { ok: false, error: 'no_fee', wilaya: w };
    }
    const homeFee = hasHome ? fee(row.homeFee) : undefined;
    const deskFee = hasDesk ? fee(row.deskFee) : undefined;
    // Base fee: explicit when given, else the min of home/desk so a
    // mode-less lookup still returns a sensible number.
    let base: number;
    if (hasBase) base = fee(row.fee);
    else {
      const candidates = [homeFee, deskFee].filter(
        (n): n is number => typeof n === 'number'
      );
      base = candidates.length ? Math.min(...candidates) : 0;
    }
    const rec: ShippingRate = {
      id: rateId(courierId, w),
      courierId,
      wilaya: w,
      fee: base,
    };
    if (homeFee !== undefined) rec.homeFee = homeFee;
    if (deskFee !== undefined) rec.deskFee = deskFee;
    byWilaya.set(w, rec);
  }
  return { ok: true, records: [...byWilaya.values()] };
}

/**
 * Resolve the delivery fee for (courier, wilaya, mode) from a list of stored
 * rate rows (as returned by the data API for `courierId`). Mode selects
 * homeFee/deskFee when present, else falls back to the base `fee`. Returns null
 * when the courier has no row for that wilaya — the CALLER then applies the
 * flat `settings.deliveryFee` fallback (backward-compatible with the pre-matrix
 * behaviour, per WSE-6). `rows` may contain other couriers' rows; they are
 * filtered by courierId + wilaya.
 */
export function feeFor(
  rows: readonly Rec[],
  courierId: string,
  wilaya: number,
  mode: DeliveryMode = DEFAULT_DELIVERY_MODE
): number | null {
  const w = wilayaCodeFrom(wilaya);
  const wantId = rateId(courierId, w);
  const match = rows.find(
    r => str(r.id) === wantId || (str(r.courierId) === courierId && num(r.wilaya) === w)
  );
  if (!match) return null;
  if (mode === 'home' && match.homeFee !== undefined && match.homeFee !== null) {
    return fee(match.homeFee);
  }
  if (mode === 'desk' && match.deskFee !== undefined && match.deskFee !== null) {
    return fee(match.deskFee);
  }
  return fee(match.fee);
}

// ---------------------------------------------------------------------------
// CSV IMPORT — merchants paste courier price PDFs re-typed as CSV. Each line is
// `wilayaCode,fee,homeFee,deskFee` (fee/home/desk optional after the code). A
// header line (containing 'wilaya' or non-numeric first cell) is skipped, blank
// lines ignored. Output feeds straight into buildBulkRates (same courier).
// ---------------------------------------------------------------------------

export type CsvParseResult =
  | { ok: true; rows: RateInput[]; skipped: number }
  | { ok: false; error: string; line?: number };

/**
 * Parse a pasted CSV blob into RateInput rows (NOT yet courier-bound — pass the
 * result to buildBulkRates). Tolerant: comma/semicolon/tab separators, optional
 * header, CRLF or LF, surrounding whitespace. A row's first cell is the wilaya
 * code; remaining cells are fee, homeFee, deskFee in that order. A row with an
 * unparseable wilaya code that is NOT the header returns a typed error with the
 * 1-based line number so the merchant can fix the paste.
 */
export function parseRatesCsv(csv: unknown): CsvParseResult {
  const text = str(csv);
  if (!text.trim()) return { ok: false, error: 'empty_csv' };
  const lines = text.split(/\r?\n/);
  const rows: RateInput[] = [];
  let skipped = 0;
  const seen = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = line.split(/[,;\t]/).map(c => c.trim());
    const first = cells[0] ?? '';
    const w = wilayaCodeFrom(first);
    // Header / label line: first cell has no digits (e.g. "Wilaya,Tarif").
    if (!/\d/.test(first)) {
      skipped++;
      continue;
    }
    if (!isValidWilaya(w)) {
      return { ok: false, error: 'bad_wilaya', line: i + 1 };
    }
    if (seen.has(w)) {
      skipped++; // later duplicate — buildBulkRates would keep the last anyway
    }
    seen.add(w);
    const row: RateInput = { wilaya: w };
    if (cells[1] !== undefined && cells[1] !== '') row.fee = cells[1];
    if (cells[2] !== undefined && cells[2] !== '') row.homeFee = cells[2];
    if (cells[3] !== undefined && cells[3] !== '') row.deskFee = cells[3];
    if (row.fee === undefined && row.homeFee === undefined && row.deskFee === undefined) {
      return { ok: false, error: 'no_fee', line: i + 1 };
    }
    rows.push(row);
  }
  if (rows.length === 0) return { ok: false, error: 'no_rows' };
  return { ok: true, rows, skipped };
}

// ---------------------------------------------------------------------------
// MATRIX EXPORT — a dense 58-row view for the studio grid / CSV download. Every
// canonical wilaya is present (missing rows → nulls) so the UI renders the full
// table and the merchant sees the gaps to fill.
// ---------------------------------------------------------------------------

export interface MatrixRow {
  wilaya: number;
  name: string;
  fee: number | null;
  homeFee: number | null;
  deskFee: number | null;
}

/**
 * Project stored rate rows for `courierId` onto the full 58-wilaya table.
 * `rows` may include other couriers (filtered out). Rows are ordered by
 * canonical code 1..58; a wilaya with no stored rate has null fees.
 */
export function exportMatrix(
  rows: readonly Rec[],
  courierId: string
): MatrixRow[] {
  const byWilaya = new Map<number, Rec>();
  for (const r of rows) {
    if (str(r.courierId) !== courierId) continue;
    const w = num(r.wilaya);
    if (isValidWilaya(w)) byWilaya.set(w, r);
  }
  return WILAYAS.map(({ code, name }) => {
    const r = byWilaya.get(code);
    return {
      wilaya: code,
      name,
      fee: r && r.fee !== undefined && r.fee !== null ? fee(r.fee) : null,
      homeFee: r && r.homeFee !== undefined && r.homeFee !== null ? fee(r.homeFee) : null,
      deskFee: r && r.deskFee !== undefined && r.deskFee !== null ? fee(r.deskFee) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// ORDER ASSIGNMENT + TRACKING. Tracking is a SUB-state stored on the order
// record; it maps onto — never replaces — the existing 5 order statuses.
//
//   tracking          →  implied order status (advances it, never regresses)
//   'pris-en-charge'  →  'Expédiée'   (courier picked the parcel up)
//   'en-route'        →  'Expédiée'   (out for delivery — still expédiée)
//   'livre'           →  'Livrée'     (delivered)
//   'retour'          →  'Retournée'  (returned to sender)
//
// The 5 canonical statuses live in the shop template / bridge
// (Nouvelle/Confirmée/Expédiée/Livrée/Retournée); we reference them by literal
// here (this pure module has no bridge import) and expose the mapping so the
// bridge can advance the order's `status` field alongside the tracking field.
// ---------------------------------------------------------------------------

/** Courier tracking sub-states (kebab, ASCII — safe as data-API values). */
export const TRACKING_STATUSES = [
  'pris-en-charge',
  'en-route',
  'livre',
  'retour',
] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

export function isTrackingStatus(v: unknown): v is TrackingStatus {
  return (
    v === 'pris-en-charge' ||
    v === 'en-route' ||
    v === 'livre' ||
    v === 'retour'
  );
}

/** The 5 canonical order statuses (mirrors the shop template — literals only). */
export const ORDER_STATUSES = [
  'Nouvelle',
  'Confirmée',
  'Expédiée',
  'Livrée',
  'Retournée',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TRACKING_TO_STATUS: Record<TrackingStatus, OrderStatus> = {
  'pris-en-charge': 'Expédiée',
  'en-route': 'Expédiée',
  livre: 'Livrée',
  retour: 'Retournée',
};

/** The order status a tracking sub-state implies. */
export function trackingToOrderStatus(t: TrackingStatus): OrderStatus {
  return TRACKING_TO_STATUS[t];
}

export type AssignResult =
  | { ok: true; patch: Rec }
  | { ok: false; field: string };

/**
 * Compute the FIELD PATCH to apply to an order record when assigning a courier.
 * Writes `courierId` + `deliveryMode` (+ `trackingAt` stamp). Does NOT touch
 * the order's `status` — assignment alone doesn't move the pipeline (the
 * merchant confirms first). The caller merges this patch onto the stored order
 * and writes it back IN PLACE (PUT-by-id) so the server-managed id/createdAt
 * and all other order fields are preserved. `now` is caller-injected.
 */
export function buildAssignPatch(
  courierId: unknown,
  mode: unknown,
  now: string
): AssignResult {
  const id = str(courierId).trim().toLowerCase();
  if (!isValidCourierId(id)) return { ok: false, field: 'courierId' };
  const patch: Rec = {
    courierId: id,
    deliveryMode: normalizeDeliveryMode(mode),
    trackingAt: str(now),
  };
  return { ok: true, patch };
}

export type TrackingResult =
  | { ok: true; patch: Rec; orderStatus: OrderStatus }
  | { ok: false; field: string };

/**
 * Compute the FIELD PATCH for a tracking-status change on an order. Sets the
 * `tracking` sub-state + `trackingAt` stamp AND returns the implied canonical
 * `orderStatus` so the caller advances the order's `status` in the same write.
 * The status is set (not blindly forced backwards): the caller is expected to
 * apply `orderStatus` — a 'livre'/'retour' is terminal, 'pris-en-charge'/
 * 'en-route' both mean 'Expédiée'. Preserves everything else on the record.
 */
export function buildTrackingPatch(
  status: unknown,
  now: string
): TrackingResult {
  if (!isTrackingStatus(status)) return { ok: false, field: 'status' };
  const orderStatus = trackingToOrderStatus(status);
  const patch: Rec = {
    tracking: status,
    status: orderStatus,
    trackingAt: str(now),
  };
  // MONEY-3: stamp the DELIVERY moment here, because this is the patch every
  // courier-driven delivery flows through — the courier poll (syncOneOrder), the
  // manual tracking route, and any future provider webhook all call this one
  // builder. The pending-COD marker and the caisse reconcile "expected" side are
  // partitioned BY MONTH and must be dated by delivery, not by order placement:
  // with Algerian COD lags of 2-7 days, an order placed 28 June and delivered
  // 3 July otherwise lands in June's books, so July never sees the COD it is
  // owed and June changes retroactively after it may already have been closed.
  //
  // Stamping in the builder (rather than only in the studio's order-status
  // route) is what makes the fix cover the COMMON case. If only the studio
  // stamped it, courier deliveries would keep the old placement-date behaviour
  // while manual clicks moved — two paths disagreeing about which month a COD
  // belongs to, which is worse than the original bug.
  //
  // The caller merges this patch onto the stored order, so a `deliveredAt`
  // already present is overwritten only when this transition is itself a
  // delivery; callers that must preserve a first-delivery timestamp drop the
  // field before merging (see erpOrderStatus's !next.deliveredAt guard).
  if (orderStatus === 'Livrée') {
    patch.deliveredAt = str(now);
  }
  return { ok: true, patch, orderStatus };
}
