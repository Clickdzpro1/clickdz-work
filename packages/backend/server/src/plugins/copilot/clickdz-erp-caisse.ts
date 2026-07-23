// ---------------------------------------------------------------------------
// R2-d (WSE-8, TIROIR) — Caisse (cash register) + COD reconciliation.
//
// Pure, framework-free helper (no @nestjs imports, no decorators — same shape
// as clickdz-template-mint.ts). ALL data-layer I/O stays in the bridge, which
// owns the per-slug write token and the erpList/erpCreateRecord/upsert plumbing;
// this file owns ONLY the money math, validation, partition-name logic, and the
// server-side reconcile/day-close aggregation. The bridge fetches the raw
// records, hands them here, and writes back what these functions return.
//
// Storage model (respects the Mason data-layer contract):
//   • `caisse-YYYYMM`  monthly-partitioned cash-movement ledger, ONE Redis hash
//     per month (exactly like `movements-YYYYMM`), because the data API hard-caps
//     a collection at 500 records. `:` is illegal in a collection name, so the
//     suffix uses a dash → `caisse-YYYYMM` (13 chars, passes /^[a-z0-9_-]{1,32}$/).
//   • Money docs are updated IN PLACE via the native PUT upsert (never
//     delete+recreate) so a concurrent reader never sees a caisse entry vanish
//     mid-edit — the whole reason the PUT primitive (WSE-1) exists.
//
// Pinned Caisse entry shape (R2-CONTRACT, cross-builder — DO NOT change):
//   { id, date, kind:'in'|'out', amount, method:'cod'|'cash'|'chargily',
//     courierId?, orderRef?, note, sessionId? }  (+ server id/createdAt)
//
// Money is INTEGER DZD throughout: every amount is Math.round()ed on the way in
// and every accumulator below is an integer sum, so there is zero float drift
// (DZ cash is counted in whole dinars; no centimes on COD).
// ---------------------------------------------------------------------------

/** One data-API record (schemaless JSON + server-managed id/createdAt). */
export type CaisseRecord = Record<string, unknown>;

/** Caisse movement direction. */
export const CAISSE_KINDS = ['in', 'out'] as const;
export type CaisseKind = (typeof CAISSE_KINDS)[number];

/** Payment/settlement method for a caisse movement. */
export const CAISSE_METHODS = ['cod', 'cash', 'chargily'] as const;
export type CaisseMethod = (typeof CAISSE_METHODS)[number];

// Field caps (belt-and-braces on top of the data API's 8KB/record cap).
export const CAISSE_NOTE_MAX = 400;
export const CAISSE_ORDER_REF_MAX = 80;
export const CAISSE_COURIER_ID_MAX = 60;
export const CAISSE_SESSION_ID_MAX = 60;
// A single entry's amount is a non-negative integer; clamp its magnitude so a
// fat-finger can't write an absurd number (and to keep the record small).
export const CAISSE_AMOUNT_MAX = 1_000_000_000;
// Rolling read window for reconcile/day-close when a range spans months: how
// many monthly caisse partitions we ever fan out over. Bounds the fan-out so a
// long-lived shop never reads an unbounded number of hashes per request.
export const CAISSE_MONTHS_READ_MAX = 24;

// ---------------------------------------------------------------------------
// Small shared coercers (kept local so this file has ZERO imports — the bridge
// has its own erpNum/erpStr, but a pure sibling must not depend on them).
// ---------------------------------------------------------------------------

/** Number(v); non-finite → 0 (mirrors the bridge's erpNum). */
export function caisseNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Loose string read for schemaless records: null/undefined → ''. */
export function caisseStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * Round to a whole integer DZD. Money is counted in whole dinars end-to-end, so
 * every amount that enters the ledger or a reconcile/day-close accumulator goes
 * through this. Non-finite → 0. This is the single choke point that guarantees
 * "no float drift": there is no path where a fractional DZD is summed.
 */
export function caisseInt(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** UTC calendar day (YYYY-MM-DD), matching the bridge's erpTodayISO(). */
export function caisseTodayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The business date of any record as a YYYY-MM-DD string. For a caisse entry we
 * prefer its own `date`; for an ORDER we mirror the bridge's parseDate order
 * (orderedAt || date || createdAt). Empty → today. Always a 10-char slice.
 */
export function caisseParseDate(r: CaisseRecord): string {
  const raw =
    caisseStr(r.date) || caisseStr(r.orderedAt) || caisseStr(r.createdAt);
  return raw.slice(0, 10) || caisseTodayISO();
}

/**
 * Order total: stored `total`, else Σ item price×qty (qty ?? 1) — byte-identical
 * to the bridge's erpOrderTotal(), then rounded to an integer DZD so the
 * reconcile "expected" side never accumulates a fractional dinar.
 */
export function caisseOrderTotal(o: CaisseRecord): number {
  if (o.total != null && Number.isFinite(Number(o.total))) {
    return caisseInt(o.total);
  }
  const items = Array.isArray(o.items) ? (o.items as unknown[]) : [];
  let sum = 0;
  for (const raw of items) {
    const it = (raw ?? {}) as CaisseRecord;
    const qty = it.qty != null ? caisseNum(it.qty) : 1;
    sum += caisseInt(caisseNum(it.price) * qty);
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Partition names.
// ---------------------------------------------------------------------------

/** The caisse partition collection name for a given month (`caisse-YYYYMM`). */
export function caisseCollectionFor(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `caisse-${y}${m}`;
}

/**
 * The caisse partition collection name for a YYYY-MM-DD date string. Falls back
 * to the current-month partition when the string is empty/malformed (so a
 * write with a bad date still lands somewhere sane rather than throwing).
 */
export function caisseCollectionForDate(dateISO: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(caisseStr(dateISO));
  if (!m) return caisseCollectionFor();
  return `caisse-${m[1]}${m[2]}`;
}

/**
 * The DISTINCT monthly caisse partitions covering an inclusive [from,to] date
 * range, NEWEST first. Both bounds are YYYY-MM-DD (already normalized/ordered by
 * the caller). Bounded by CAISSE_MONTHS_READ_MAX so a huge range can never fan
 * out over an unbounded number of hashes. Empty/invalid bounds → the
 * current-month partition only.
 */
export function caisseCollectionsInRange(from: string, to: string): string[] {
  const mf = /^(\d{4})-(\d{2})-\d{2}$/.exec(caisseStr(from));
  const mt = /^(\d{4})-(\d{2})-\d{2}$/.exec(caisseStr(to));
  if (!mf || !mt) return [caisseCollectionFor()];
  const startY = Number(mf[1]);
  const startM = Number(mf[2]);
  const endY = Number(mt[1]);
  const endM = Number(mt[2]);
  // Walk month-by-month from `to` back to `from` (newest first), capped.
  const out: string[] = [];
  let y = endY;
  let m = endM;
  let guard = 0;
  while (
    (y > startY || (y === startY && m >= startM)) &&
    guard < CAISSE_MONTHS_READ_MAX
  ) {
    out.push(`caisse-${y}${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
    guard += 1;
  }
  return out.length ? out : [caisseCollectionFor()];
}

// ---------------------------------------------------------------------------
// Entry validation / normalization.
// ---------------------------------------------------------------------------

/** A validated, ready-to-store caisse entry (server id/createdAt added later). */
export interface CaisseEntryInput {
  date: string;
  kind: CaisseKind;
  amount: number;
  method: CaisseMethod;
  courierId?: string;
  orderRef?: string;
  note: string;
  sessionId?: string;
}

export type CaisseValidation =
  | { ok: true; entry: CaisseEntryInput; collection: string }
  | { ok: false; field: string; message: string };

/**
 * Validate + normalize a caisse entry create body against the pinned shape.
 * Returns the clean entry PLUS the monthly partition it belongs in (derived from
 * its own date, so a back-dated entry lands in the correct historical month).
 * Pure — no I/O; the bridge does the create/PUT with the write token.
 *
 * Rules:
 *   • kind ∈ {in,out}; method ∈ {cod,cash,chargily} — anything else → field err.
 *   • amount is a NON-NEGATIVE INTEGER DZD (rounded, clamped, >0 required).
 *   • date defaults to today (UTC) when absent/malformed; always a 10-char slice.
 *   • courierId only makes sense for a 'cod' 'in' entry (a manual COD hand-in);
 *     it is accepted (kept) on any entry but callers use it to tag COD receipts.
 *   • note capped; orderRef/courierId/sessionId capped; all optional-empty
 *     fields are OMITTED (not stored as '') to keep the record tiny.
 */
export function validateCaisseEntry(body: unknown): CaisseValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, field: 'body', message: 'Entry must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  const kind = caisseStr(b.kind).trim();
  if (!(CAISSE_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      field: 'kind',
      message: `"kind" must be one of: ${CAISSE_KINDS.join(', ')}`,
    };
  }

  const method = caisseStr(b.method).trim();
  if (!(CAISSE_METHODS as readonly string[]).includes(method)) {
    return {
      ok: false,
      field: 'method',
      message: `"method" must be one of: ${CAISSE_METHODS.join(', ')}`,
    };
  }

  // Integer DZD. Reject non-positive so an entry always moves real money.
  const amount = caisseInt(b.amount);
  if (!(amount > 0)) {
    return {
      ok: false,
      field: 'amount',
      message: '"amount" must be a positive integer (DZD)',
    };
  }
  if (amount > CAISSE_AMOUNT_MAX) {
    return {
      ok: false,
      field: 'amount',
      message: `"amount" exceeds the maximum (${CAISSE_AMOUNT_MAX})`,
    };
  }

  // Date: accept a YYYY-MM-DD (or a longer ISO we slice); default today.
  let date = caisseStr(b.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = caisseTodayISO();

  const note = caisseStr(b.note).slice(0, CAISSE_NOTE_MAX);
  const courierId = caisseStr(b.courierId).trim().slice(0, CAISSE_COURIER_ID_MAX);
  const orderRef = caisseStr(b.orderRef).trim().slice(0, CAISSE_ORDER_REF_MAX);
  const sessionId = caisseStr(b.sessionId).trim().slice(0, CAISSE_SESSION_ID_MAX);

  const entry: CaisseEntryInput = {
    date,
    kind: kind as CaisseKind,
    amount,
    method: method as CaisseMethod,
    note,
    ...(courierId ? { courierId } : {}),
    ...(orderRef ? { orderRef } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  return { ok: true, entry, collection: caisseCollectionForDate(date) };
}

/**
 * Merge a partial PUT-style patch onto an existing stored caisse entry, keeping
 * the pinned shape and re-validating. Used by the in-place update route: absent
 * fields keep their stored value; only kind/method/amount/date/note/courierId/
 * orderRef/sessionId can change. Returns the merged+validated entry so the
 * bridge can PUT it back IN PLACE (never delete+recreate a money doc).
 *
 * The record's own id/createdAt are NOT part of the returned entry (the PUT URL
 * is authoritative for id; the data controller preserves createdAt itself).
 */
export function mergeCaisseEntry(
  existing: CaisseRecord,
  patch: unknown
): CaisseValidation {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, field: 'body', message: 'Patch must be a JSON object' };
  }
  const p = patch as Record<string, unknown>;
  // Start from the existing pinned fields, overlay only provided keys, then run
  // the same strict validation so an edit can never produce an off-shape record.
  const merged: Record<string, unknown> = {
    date: existing.date,
    kind: existing.kind,
    amount: existing.amount,
    method: existing.method,
    note: existing.note,
    courierId: existing.courierId,
    orderRef: existing.orderRef,
    sessionId: existing.sessionId,
  };
  for (const k of [
    'date',
    'kind',
    'amount',
    'method',
    'note',
    'courierId',
    'orderRef',
    'sessionId',
  ]) {
    if (p[k] !== undefined) merged[k] = p[k];
  }
  return validateCaisseEntry(merged);
}

// ---------------------------------------------------------------------------
// Auto-entry hook: pending-COD marker when an order becomes 'Livrée'.
//
// The bridge's order-status handler calls buildPendingCodEntry() right after it
// successfully writes the 'Livrée' status. The returned entry is an 'in'/'cod'
// caisse row tagged with the order's ref + courierId (when the order carries
// one — Routier's tracking path sets `courierId` on the order record; if it is
// absent the marker is still written, just untagged) and flagged `pending: true`
// so the day-close and reconcile can distinguish an EXPECTED-but-not-yet-counted
// COD from a real manual hand-in. The amount is the order total (integer DZD).
//
// This is a MARKER, not a settlement: it records "this delivered order owes us
// its COD". The reconcile's "received" side counts ONLY non-pending manual 'in'
// entries, so a marker never double-counts as cash actually collected.
// ---------------------------------------------------------------------------

/**
 * Build the pending-COD marker entry for a just-delivered order. Returns null
 * when the order has no positive total (nothing to collect) — the caller then
 * writes nothing (the hook is a no-op, not an error). Pure: the bridge does the
 * create with the write token, fail-soft (never breaks the status update).
 *
 * The returned object is the ENTRY BODY (no id/createdAt) plus the target
 * `collection` (the partition for the order's delivery day, so a back-dated
 * delivery lands in the right month).
 */
export function buildPendingCodEntry(
  order: CaisseRecord
): { entry: CaisseRecord; collection: string } | null {
  const amount = caisseOrderTotal(order);
  if (!(amount > 0)) return null;
  const date = caisseParseDate(order);
  const ref = caisseStr(order.ref).trim().slice(0, CAISSE_ORDER_REF_MAX);
  const courierId = caisseStr(order.courierId)
    .trim()
    .slice(0, CAISSE_COURIER_ID_MAX);
  const entry: CaisseRecord = {
    date,
    kind: 'in',
    amount,
    method: 'cod',
    // `pending: true` marks this as an expected COD (delivered, not yet counted
    // in the drawer). Reconcile/day-close treat pending markers != real cash-in.
    pending: true,
    note: 'COD attendu (livraison)',
    ...(ref ? { orderRef: ref } : {}),
    ...(courierId ? { courierId } : {}),
  };
  return { entry, collection: caisseCollectionForDate(date) };
}

/**
 * Guard: has a pending-COD marker already been written for this order ref in the
 * given partition rows? Lets the caller stay idempotent (an order re-set to
 * 'Livrée' must not stack duplicate markers). Matches an 'in'/'cod' row with
 * `pending===true` and the same orderRef.
 */
export function hasPendingCodMarker(
  rows: CaisseRecord[],
  orderRef: string
): boolean {
  const ref = caisseStr(orderRef).trim();
  if (!ref) return false;
  return rows.some(
    r =>
      r.pending === true &&
      caisseStr(r.kind) === 'in' &&
      caisseStr(r.method) === 'cod' &&
      caisseStr(r.orderRef).trim() === ref
  );
}

// ---------------------------------------------------------------------------
// R15 — settled Chargily online payment -> caisse.
//
// Unlike the COD marker above, an online Chargily payment is REAL money in the
// moment the webhook confirms it, so its caisse row is NOT pending — it counts
// immediately in day-close/reconcile (inByMethod.chargily). The bridge's
// markOrderPaid() calls buildChargilyCaisseEntry() right after it flips the
// order to paid, then erpCreateRecord's the returned entry with the write token.
// ---------------------------------------------------------------------------

/**
 * Build the settled-Chargily caisse entry for an order that just went paid via
 * the webhook: 'in'/'chargily', amount = order total (integer DZD), tagged with
 * the order ref, NOT pending. Returns null when the total is <= 0 (no-op). Pure;
 * the bridge does the create fail-soft. Mirrors buildPendingCodEntry's shape so
 * the two settlement paths (COD marker, online paid) stay structurally aligned.
 */
export function buildChargilyCaisseEntry(
  order: CaisseRecord
): { entry: CaisseRecord; collection: string } | null {
  const amount = caisseOrderTotal(order);
  if (!(amount > 0)) return null;
  const date = caisseParseDate(order);
  const ref = caisseStr(order.ref).trim().slice(0, CAISSE_ORDER_REF_MAX);
  const entry: CaisseRecord = {
    date,
    kind: 'in',
    amount,
    method: 'chargily',
    note: 'Paiement Chargily (en ligne)',
    ...(ref ? { orderRef: ref } : {}),
  };
  return { entry, collection: caisseCollectionForDate(date) };
}

/**
 * Idempotency guard: an 'in'/'chargily' caisse row for this orderRef already
 * exists in the given partition rows. Lets markOrderPaid stay idempotent under
 * a re-fired webhook or a manual re-mark. Keyed on orderRef.
 */
export function hasChargilyCaisseEntry(
  rows: CaisseRecord[],
  orderRef: string
): boolean {
  const ref = caisseStr(orderRef).trim();
  if (!ref) return false;
  return rows.some(
    r =>
      caisseStr(r.kind) === 'in' &&
      caisseStr(r.method) === 'chargily' &&
      caisseStr(r.orderRef).trim() === ref
  );
}

// ---------------------------------------------------------------------------
// Date-range helpers for reconcile / day-close.
// ---------------------------------------------------------------------------

/**
 * Normalize a caller-supplied [from,to] pair to YYYY-MM-DD, defaulting a missing
 * bound and SWAPPING them if reversed, so downstream range math is always
 * `from <= to`. A single missing bound collapses to a one-day range on the
 * present bound; both missing → today..today.
 */
export function normalizeRange(
  fromRaw: unknown,
  toRaw: unknown
): { from: string; to: string } {
  const clean = (v: unknown): string => {
    const s = caisseStr(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  };
  let from = clean(fromRaw);
  let to = clean(toRaw);
  if (!from && !to) {
    const t = caisseTodayISO();
    return { from: t, to: t };
  }
  if (!from) from = to;
  if (!to) to = from;
  if (from > to) {
    const tmp = from;
    from = to;
    to = tmp;
  }
  return { from, to };
}

/** True when a YYYY-MM-DD day falls within the inclusive [from,to] range. */
export function inRange(day: string, from: string, to: string): boolean {
  return day >= from && day <= to;
}

// ---------------------------------------------------------------------------
// COD RECONCILIATION (per courier).
//
// expected = Σ delivered-order totals per courierId in the range MINUS that
//            courier's codFee per delivered order (the fee the courier keeps);
// received = Σ manual 'in' caisse entries tagged that courierId in the range
//            (NON-pending only — a pending marker is an expectation, not cash);
// gap      = expected - received  (positive ⇒ courier still owes; negative ⇒
//            over-remitted / a manual entry without a matching delivery).
//
// codFee semantics: the pinned Courier shape carries an optional `codFee`
// (number). We treat it as a PER-DELIVERED-ORDER fee the courier deducts before
// remitting (the common Algerian COD model). So expected nets out fees the
// shop never expects to receive in cash. All integer DZD.
// ---------------------------------------------------------------------------

export interface CourierLite {
  id: string;
  name?: string;
  codFee?: number;
}

export interface ReconcileOrderRef {
  ref: string;
  total: number;
  date: string;
}

export interface CourierReconcile {
  courierId: string;
  courierName: string;
  expectedTotal: number;
  receivedTotal: number;
  gap: number;
  codFeeTotal: number;
  deliveredCount: number;
  orders: ReconcileOrderRef[];
}

/**
 * Compute a single courier's COD reconciliation over [from,to].
 *
 * @param courierId  the courier to reconcile (already validated/trimmed).
 * @param courier    the courier record (for name + codFee); may be null when the
 *                   courier list is unavailable — then codFee is treated as 0
 *                   and the name falls back to the id.
 * @param orders     ALL orders (the bridge passes the full `orders` collection).
 *                   Only 'Livrée' orders whose `courierId` matches and whose
 *                   delivery day is in range are counted.
 * @param caisseRows caisse entries across the range's partitions (already
 *                   merged by the bridge). Only NON-pending 'in' entries tagged
 *                   this courierId AND dated in range count as received.
 *
 * All money is integer DZD; every accumulator is an integer sum (no float).
 */
export function reconcileCourier(
  courierId: string,
  courier: CourierLite | null,
  orders: CaisseRecord[],
  caisseRows: CaisseRecord[],
  from: string,
  to: string
): CourierReconcile {
  const cid = caisseStr(courierId).trim();
  const codFee = courier ? Math.max(0, caisseInt(courier.codFee)) : 0;
  const courierName = (courier && caisseStr(courier.name).trim()) || cid;

  let expectedGross = 0;
  let codFeeTotal = 0;
  let deliveredCount = 0;
  const refs: ReconcileOrderRef[] = [];
  for (const o of orders) {
    if (caisseStr(o.status) !== 'Livrée') continue;
    if (caisseStr(o.courierId).trim() !== cid) continue;
    const day = caisseParseDate(o);
    if (!inRange(day, from, to)) continue;
    const total = caisseOrderTotal(o);
    expectedGross += total;
    codFeeTotal += codFee;
    deliveredCount += 1;
    refs.push({ ref: caisseStr(o.ref).trim(), total, date: day });
  }
  // expected = gross delivered value MINUS the fees the courier keeps. Never
  // below zero (a codFee larger than the order value would otherwise go
  // negative; clamp so "expected to receive" stays a real, non-negative sum).
  const expectedTotal = Math.max(0, expectedGross - codFeeTotal);

  let receivedTotal = 0;
  for (const r of caisseRows) {
    if (r.pending === true) continue; // expectation, not cash
    if (caisseStr(r.kind) !== 'in') continue;
    if (caisseStr(r.courierId).trim() !== cid) continue;
    const day = caisseParseDate(r);
    if (!inRange(day, from, to)) continue;
    receivedTotal += caisseInt(r.amount);
  }

  return {
    courierId: cid,
    courierName,
    expectedTotal,
    receivedTotal,
    gap: expectedTotal - receivedTotal,
    codFeeTotal,
    deliveredCount,
    orders: refs,
  };
}

// ---------------------------------------------------------------------------
// DAY-CLOSE SUMMARY.
//
// For a single day (or any range the caller passes), totals of 'in' vs 'out'
// broken down by method (cod|cash|chargily), plus the net. Pending-COD markers
// are reported SEPARATELY (pendingCodTotal) and are NOT part of the in/out/net
// figures — they are expectations, not drawer movements. All integer DZD.
// ---------------------------------------------------------------------------

export interface MethodBreakdown {
  cod: number;
  cash: number;
  chargily: number;
}

export interface DayCloseSummary {
  date: string;
  from: string;
  to: string;
  inTotal: number;
  outTotal: number;
  net: number;
  inByMethod: MethodBreakdown;
  outByMethod: MethodBreakdown;
  pendingCodTotal: number;
  entryCount: number;
}

function emptyBreakdown(): MethodBreakdown {
  return { cod: 0, cash: 0, chargily: 0 };
}

/**
 * Build the day-close (or range-close) summary from caisse entries. `date` is
 * the reporting label (the caller's requested day); `from`/`to` bound which
 * entries are counted. Only entries whose method is one of the three known
 * methods contribute to the breakdowns (an unknown method still counts toward
 * in/out totals so nothing silently disappears, but is not attributed).
 */
export function buildDayClose(
  caisseRows: CaisseRecord[],
  date: string,
  from: string,
  to: string
): DayCloseSummary {
  let inTotal = 0;
  let outTotal = 0;
  let pendingCodTotal = 0;
  let entryCount = 0;
  const inByMethod = emptyBreakdown();
  const outByMethod = emptyBreakdown();

  for (const r of caisseRows) {
    const day = caisseParseDate(r);
    if (!inRange(day, from, to)) continue;
    const amount = caisseInt(r.amount);
    if (!(amount > 0)) continue;
    entryCount += 1;
    // Pending COD markers are expectations, tracked apart from real movements.
    if (r.pending === true) {
      pendingCodTotal += amount;
      continue;
    }
    const kind = caisseStr(r.kind);
    const method = caisseStr(r.method);
    const known = (CAISSE_METHODS as readonly string[]).includes(method);
    if (kind === 'in') {
      inTotal += amount;
      if (known) inByMethod[method as CaisseMethod] += amount;
    } else if (kind === 'out') {
      outTotal += amount;
      if (known) outByMethod[method as CaisseMethod] += amount;
    }
  }

  return {
    date,
    from,
    to,
    inTotal,
    outTotal,
    net: inTotal - outTotal,
    inByMethod,
    outByMethod,
    pendingCodTotal,
    entryCount,
  };
}
