// ---------------------------------------------------------------------------
// R2 (WSE-2, LEDGER) — FACTURATION DZ: pure invoicing logic.
//
// The DZ SMB "Facturation" domain: quotes (devis) → delivery notes (bon de
// livraison, BL) → invoices (facture), with Algerian fiscal math (TVA per line,
// timbre fiscal on cash sales) and gap-less legal numbering. This module is the
// PURE brain behind the bridge's `/erp/invoices*` routes: it validates input,
// computes totals, builds the pinned Invoice record, names monthly partitions,
// and answers "which number comes next" via an injected Redis-like INCR — it
// does NO network I/O and owns NO framework types.
//
// DESIGN: a PURE helper module (no Nest decorators, no `../../base` error
// classes, no Node singletons) mirroring `cdz-data-token.ts` / `clickdz-app-
// source.ts` — boot-safe when imported, unit-testable in isolation. It NEVER
// throws for EXPECTED failure modes; instead it returns discriminated-union
// results and the bridge controller (which owns `@Res` passthrough + the typed
// `../../base` errors) maps a failure `reason` to the right HTTP status. Every
// cross-cutting value it needs — the per-slug write token, the external base
// URL, the TVA/timbre env rates, and the Redis-like client used for the atomic
// sequence INCR — is INJECTED by the caller, so there is no duplicated env
// coupling and no hidden global state (exactly how the sibling helpers stay
// framework-light).
//
// MONEY MATH IS INTEGER-DZD-SAFE. Algerian invoicing practice quotes and files
// in whole dinars (DZD) — centimes are not used on B2B facturation — so every
// monetary field in this module is a plain JS integer number of dinars, and the
// ROUNDING RULE is fixed and documented: for each line we compute
// `lineHT = round(qty * unitHT)` and `lineTVA = round(lineHT * tvaRate / 100)`,
// rounding EACH line to the nearest integer dinar (half-up, via Math.round)
// BEFORE summing. The document totals are the sums of the already-rounded line
// figures (`totalHT = Σ lineHT`, `totalTVA = Σ lineTVA`), so `totalTTC =
// totalHT + totalTVA + timbre` is an exact integer with NO floating-point drift
// across the document (we never sum floats then round once — we round then sum,
// which is what a printed DZ facture shows line-by-line and what the fisc
// expects to reconcile). All arithmetic stays within JS safe-integer range
// because per-record caps (line count, qty, unitHT) below bound the magnitude.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Caps & knobs. These keep an invoice record comfortably under the data API's
// 8KB/record cap (checked again by the bridge with real byte length) and keep
// the money math inside JS safe-integer range.
// ---------------------------------------------------------------------------
/** Max line items on one invoice (a fat invoice must still fit in ~8KB). */
export const INVOICE_MAX_LINES = 60;
/** Field caps (chars) — belt-and-braces on top of the 8KB record cap. */
export const INVOICE_LABEL_MAX = 160;
export const INVOICE_REF_MAX = 60;
export const INVOICE_CUSTOMER_NAME_MAX = 120;
export const INVOICE_CUSTOMER_FIELD_MAX = 60; // rc / nif / nis / art
export const INVOICE_CUSTOMER_ADDRESS_MAX = 200;
export const INVOICE_ORDER_REF_MAX = 80;
/** Per-line magnitude clamps (a fat-finger can't mint an absurd total). */
export const INVOICE_QTY_MAX = 1_000_000;
export const INVOICE_UNIT_HT_MAX = 1_000_000_000; // 1e9 DZD/unit ceiling
/** TVA rate clamp (percent). 0 = exonéré is legal; cap well above 19. */
export const INVOICE_TVA_RATE_MAX = 100;

// DZ timbre fiscal (fiscal stamp) constants — the legal defaults. Overridable
// by the caller via `opts.timbreRate` (env `CDZ_ERP_TIMBRE_RATE`, percent).
/** Minimum timbre per cash invoice (DZD). */
export const TIMBRE_MIN_DZD = 5;
/** Maximum timbre per cash invoice (DZD). */
export const TIMBRE_MAX_DZD = 10_000;

/** The three fiscal document kinds, in their legal conversion order. */
export const INVOICE_TYPES = ['devis', 'bl', 'facture'] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

/** Document lifecycle. Numbering is assigned at VALIDATION, never at draft. */
export const INVOICE_STATUSES = ['brouillon', 'valide', 'annule'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Payment method carried on a facture (drives whether timbre applies). */
export const INVOICE_PAYMENTS = ['cash', 'cod', 'chargily', 'virement'] as const;
export type InvoicePayment = (typeof INVOICE_PAYMENTS)[number];

// ---------------------------------------------------------------------------
// Pinned record shapes (R2-CONTRACT §"Invoice"). Kept exactly to the contract:
//   Invoice: collection `invoices-YYYYMM`,
//   { id: '<type>-<year>-<seq>', type, seq, year, date,
//     customer:{name, rc?, nif?, nis?, art?, address?},
//     lines:[{ref?, label, qty, unitHT, tvaRate}],
//     totalHT, totalTVA, timbre, totalTTC,
//     status:'brouillon'|'valide'|'annule', orderRef? }
// Plus a few additive, back-compat fields the domain needs (payment method to
// decide timbre; convertedFrom to carry the devis→bl→facture lineage). Server-
// managed `createdAt`/`updatedAt` are stamped by the data API, not here.
// ---------------------------------------------------------------------------
export interface InvoiceCustomer {
  name: string;
  rc?: string;
  nif?: string;
  nis?: string;
  art?: string;
  address?: string;
}

export interface InvoiceLine {
  ref?: string;
  label: string;
  qty: number;
  unitHT: number;
  tvaRate: number;
  // Derived, stored for a faithful printed facture (round-then-sum rule):
  lineHT: number;
  lineTVA: number;
}

export interface InvoiceRecord {
  id: string;
  type: InvoiceType;
  seq: number; // 0 while draft (unassigned); a gap-less positive int once valid
  year: number;
  date: string; // YYYY-MM-DD (business date)
  customer: InvoiceCustomer;
  lines: InvoiceLine[];
  totalHT: number;
  totalTVA: number;
  timbre: number;
  totalTTC: number;
  status: InvoiceStatus;
  payment?: InvoicePayment;
  orderRef?: string;
  convertedFrom?: string; // source doc id (devis→bl→facture lineage)
  [k: string]: unknown; // schemaless-tolerant (data API adds id/createdAt)
}

/** Caller-injected options (env rates + the current date). Framework-free. */
export interface InvoiceOptions {
  /** TVA percent when a line omits its own rate (env CDZ_ERP_TVA_RATE, def 19). */
  tvaRate: number;
  /** Timbre percent of TTC on cash sales (env CDZ_ERP_TIMBRE_RATE, def 1). */
  timbreRate: number;
  /** Business date override (YYYY-MM-DD); defaults to today (UTC). */
  today?: string;
}

// ---------------------------------------------------------------------------
// Small pure readers (loose, schemaless — never throw). Mirror the bridge's
// erpStr/erpNum spirit so behaviour matches the rest of the ERP surface.
// ---------------------------------------------------------------------------
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** UTC calendar day (same slice the ERP templates/bridge use). */
export function invoiceTodayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse the TVA/timbre env values the way the bridge reads other CDZ_ envs:
 * `Number(process.env.X ?? default)`, clamped to a sane range. Exposed so the
 * controller can build InvoiceOptions from `process.env` in one line.
 */
export function resolveInvoiceRates(
  tvaEnv: string | undefined,
  timbreEnv: string | undefined
): { tvaRate: number; timbreRate: number } {
  const tvaRaw = Number(tvaEnv ?? '19');
  const timbreRaw = Number(timbreEnv ?? '1');
  const tvaRate = Number.isFinite(tvaRaw)
    ? Math.max(0, Math.min(INVOICE_TVA_RATE_MAX, tvaRaw))
    : 19;
  const timbreRate = Number.isFinite(timbreRaw)
    ? Math.max(0, Math.min(100, timbreRaw))
    : 1;
  return { tvaRate, timbreRate };
}

// ===========================================================================
// PARTITION NAMING — monthly collections `invoices-YYYYMM`.
// `:` is illegal in a collection name (data API COLLECTION_RE), so the suffix
// uses a dash, exactly like the inventory ledger's `movements-YYYYMM`. A record
// lands in the partition of its business DATE, so listing/reads are month-scoped.
// ===========================================================================
/** The `invoices-YYYYMM` partition for a given date (default: now, UTC). */
export function invoiceCollection(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `invoices-${y}${m}`;
}

/** The partition name for a YYYY-MM-DD business date string. */
export function invoiceCollectionForDate(dateISO: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(str(dateISO));
  if (m) return `invoices-${m[1]}${m[2]}`;
  return invoiceCollection();
}

/**
 * Partition names spanning an inclusive [fromMonth, toMonth] range (YYYY-MM),
 * NEWEST first, bounded so a long-lived shop never fans out unboundedly. When
 * both bounds are absent, returns just the current month. `maxMonths` caps the
 * window (default 24 → last two years).
 */
export function invoiceCollectionsInRange(
  fromMonth?: string,
  toMonth?: string,
  maxMonths = 24
): string[] {
  const now = new Date();
  const curY = now.getUTCFullYear();
  const curM = now.getUTCMonth(); // 0-based
  const parse = (s: string | undefined): { y: number; m: number } | null => {
    const mm = /^(\d{4})-(\d{2})$/.exec(str(s));
    if (!mm) return null;
    const y = Number(mm[1]);
    const m = Number(mm[2]) - 1;
    if (!Number.isInteger(y) || m < 0 || m > 11) return null;
    return { y, m };
  };
  const to = parse(toMonth) ?? { y: curY, m: curM };
  // Default the lower bound to the SAME month as `to` when only `to` is given,
  // else to `to` itself — i.e. a single month unless a real range is asked for.
  const from = parse(fromMonth) ?? to;
  // Absolute month indices for iteration (year*12 + month).
  let hi = to.y * 12 + to.m;
  let lo = from.y * 12 + from.m;
  if (lo > hi) [lo, hi] = [hi, lo]; // tolerate swapped bounds
  const cap = Math.max(1, Math.min(Math.floor(maxMonths), 240));
  if (hi - lo + 1 > cap) lo = hi - cap + 1; // keep the most-recent `cap` months
  const out: string[] = [];
  for (let idx = hi; idx >= lo; idx--) {
    const y = Math.floor(idx / 12);
    const m = idx % 12;
    out.push(`invoices-${y}${String(m + 1).padStart(2, '0')}`);
  }
  return out;
}

// ===========================================================================
// SEQUENCE — gap-less legal numbering via injected Redis INCR.
// Key per R2-CONTRACT: `clickdz:erpseq:{slug}:{docType}:{year}`. One sequence
// per (slug, docType, year) so devis / bl / facture keep INDEPENDENT yearly
// series that reset each January — the DZ convention. Server-side ONLY (the key
// is never exposed to the client). The number is consumed at VALIDATION, not at
// draft creation, so unsent drafts never burn a legal number.
// ===========================================================================
/** A minimal Redis-like surface — just the atomic INCR we need (ioredis-shaped). */
export interface SeqClient {
  incr(key: string): Promise<number>;
}

/** The Redis key holding the gap-less counter for one (slug, type, year). */
export function invoiceSeqKey(
  slug: string,
  type: InvoiceType,
  year: number
): string {
  return `clickdz:erpseq:${slug}:${type}:${year}`;
}

// NOTE (Ledger SAFE-POLISH): the legacy `reserveInvoiceSeq(redis, …)` helper that
// once lived here was a plain Redis INCR with no durable floor. It was SUPERSEDED
// by the bridge's `erpReserveSeq` (clickdz-bridge.controller.ts), which INCRs the
// SAME `invoiceSeqKey` but adds the Postgres max-merge floor + Redis forward-heal
// (R18) so a Redis regression can never REISSUE a burned legal number. The old
// export had ZERO callers (verified tree-wide) and was removed to leave one — and
// only one — reserve path. `invoiceSeqKey` (+ the `SeqClient` shape) stay: the
// bridge imports `invoiceSeqKey` for exactly that PG-floored path.

/**
 * Format the legal document id/number: `<type>-<year>-<seq>` with the seq
 * zero-padded to 5 digits (e.g. `facture-2026-00042`). The zero pad keeps ids
 * lexicographically sortable within a year and reads like a printed facture
 * number. Draft (unassigned) documents use seq 0 → a `<type>-<year>-draft-...`
 * shape is NOT used; drafts get a temporary uuid-ish id from the caller.
 */
export function formatInvoiceId(
  type: InvoiceType,
  year: number,
  seq: number
): string {
  return `${type}-${year}-${String(Math.max(0, Math.floor(seq))).padStart(5, '0')}`;
}

// ===========================================================================
// MONEY MATH — round-then-sum, integer DZD. See the file header for the rule.
// ===========================================================================
/**
 * Compute a single line's rounded HT and TVA (integer DZD). The rule, applied
 * per line BEFORE any summing:
 *   lineHT  = round(qty * unitHT)
 *   lineTVA = round(lineHT * tvaRate / 100)
 * Rounding is half-up (Math.round). Inputs are clamped/normalized by the caller
 * (normalizeLine) so this stays a pure arithmetic helper.
 */
export function computeLineTotals(
  qty: number,
  unitHT: number,
  tvaRate: number
): { lineHT: number; lineTVA: number } {
  const lineHT = Math.round(qty * unitHT);
  const lineTVA = Math.round((lineHT * tvaRate) / 100);
  return { lineHT, lineTVA };
}

/**
 * DZ timbre fiscal. Legal rule (encoded per R2-CONTRACT):
 *   • applies ONLY to a `facture` (never devis/bl) PAID IN CASH,
 *   • = `timbreRate`% of the TTC-before-timbre (HT + TVA),
 *   • rounded to the nearest integer dinar,
 *   • then floored at TIMBRE_MIN_DZD (5) and capped at TIMBRE_MAX_DZD (10 000).
 * The min/cap apply only when there is a taxable base (base > 0) — a zero-value
 * cash facture carries no timbre. Every other case returns 0.
 *
 * NOTE on "cash": DZ timbre attaches to cash-settled sales. We treat method
 * `cash` as cash; `cod` (cash-on-delivery, the dominant DZ channel) is ALSO
 * physical cash collected at the door, so it counts as cash for timbre. Bank
 * transfer (`virement`) and Chargily (card/EDAHABIA electronic) do NOT.
 */
export function computeTimbre(
  type: InvoiceType,
  payment: InvoicePayment | undefined,
  baseTTC: number,
  timbreRate: number
): number {
  if (type !== 'facture') return 0;
  const isCash = payment === 'cash' || payment === 'cod';
  if (!isCash) return 0;
  if (!(baseTTC > 0)) return 0;
  const raw = Math.round((baseTTC * timbreRate) / 100);
  return Math.max(TIMBRE_MIN_DZD, Math.min(TIMBRE_MAX_DZD, raw));
}

/**
 * Roll a set of normalized lines + a doc kind/payment into the document totals,
 * applying the round-then-sum rule and the timbre rule. Pure; no side effects.
 */
export function computeInvoiceTotals(
  type: InvoiceType,
  lines: InvoiceLine[],
  payment: InvoicePayment | undefined,
  timbreRate: number
): { totalHT: number; totalTVA: number; timbre: number; totalTTC: number } {
  let totalHT = 0;
  let totalTVA = 0;
  for (const l of lines) {
    totalHT += l.lineHT;
    totalTVA += l.lineTVA;
  }
  const baseTTC = totalHT + totalTVA;
  const timbre = computeTimbre(type, payment, baseTTC, timbreRate);
  return { totalHT, totalTVA, timbre, totalTTC: baseTTC + timbre };
}

// ===========================================================================
// VALIDATION + NORMALIZATION — sanitize caller input into clean domain objects.
// Returns discriminated unions; the controller maps `reason` to a typed 4xx.
// ===========================================================================
export type ValidationError = { ok: false; reason: string; field?: string };

/** Clean one raw line into a normalized InvoiceLine (with computed totals). */
function normalizeLine(
  raw: unknown,
  defaultTvaRate: number
): { ok: true; line: InvoiceLine } | ValidationError {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_line', field: 'lines' };
  }
  const r = raw as Record<string, unknown>;
  const label = str(r.label).trim().slice(0, INVOICE_LABEL_MAX);
  if (!label) return { ok: false, reason: 'line_label_required', field: 'label' };
  // qty: positive number (fractional qty allowed — DZ invoices bill e.g. 2.5 kg),
  // clamped to the magnitude ceiling. unitHT: non-negative integer DZD.
  const qtyRaw = num(r.qty);
  if (!(qtyRaw > 0)) return { ok: false, reason: 'line_qty_invalid', field: 'qty' };
  const qty = Math.min(qtyRaw, INVOICE_QTY_MAX);
  const unitRaw = num(r.unitHT);
  if (unitRaw < 0) return { ok: false, reason: 'line_price_invalid', field: 'unitHT' };
  const unitHT = Math.min(Math.round(unitRaw), INVOICE_UNIT_HT_MAX);
  // tvaRate: per-line override, else the doc default. 0 (exonéré) is valid.
  let tvaRate = r.tvaRate == null ? defaultTvaRate : num(r.tvaRate);
  if (tvaRate < 0 || tvaRate > INVOICE_TVA_RATE_MAX) {
    return { ok: false, reason: 'line_tva_invalid', field: 'tvaRate' };
  }
  tvaRate = Math.round(tvaRate * 100) / 100; // keep at most 2 decimals
  const ref = str(r.ref).trim().slice(0, INVOICE_REF_MAX);
  const { lineHT, lineTVA } = computeLineTotals(qty, unitHT, tvaRate);
  const line: InvoiceLine = {
    label,
    qty,
    unitHT,
    tvaRate,
    lineHT,
    lineTVA,
    ...(ref ? { ref } : {}),
  };
  return { ok: true, line };
}

/** Clean the raw customer object into a normalized InvoiceCustomer. */
function normalizeCustomer(
  raw: unknown
): { ok: true; customer: InvoiceCustomer } | ValidationError {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'customer_required', field: 'customer' };
  }
  const c = raw as Record<string, unknown>;
  const name = str(c.name).trim().slice(0, INVOICE_CUSTOMER_NAME_MAX);
  if (!name) return { ok: false, reason: 'customer_name_required', field: 'customer.name' };
  const customer: InvoiceCustomer = { name };
  const opt = (k: 'rc' | 'nif' | 'nis' | 'art') => {
    const v = str(c[k]).trim().slice(0, INVOICE_CUSTOMER_FIELD_MAX);
    if (v) customer[k] = v;
  };
  opt('rc');
  opt('nif');
  opt('nis');
  opt('art');
  const address = str(c.address).trim().slice(0, INVOICE_CUSTOMER_ADDRESS_MAX);
  if (address) customer.address = address;
  return { ok: true, customer };
}

/** Normalize a payment method (default cod — the dominant DZ channel). */
function normalizePayment(raw: unknown): InvoicePayment | undefined {
  const p = str(raw).trim().toLowerCase();
  if (!p) return undefined;
  return (INVOICE_PAYMENTS as readonly string[]).includes(p)
    ? (p as InvoicePayment)
    : undefined;
}

export interface CreateInvoiceInput {
  type: unknown;
  customer: unknown;
  lines: unknown;
  payment?: unknown;
  orderRef?: unknown;
  date?: unknown;
}

/**
 * Build a DRAFT invoice record from caller input (create path). No sequence is
 * reserved and no number is assigned — `status='brouillon'`, `seq=0`, and the
 * `id` is a caller-supplied temporary (passed in via `draftId`). Totals ARE
 * computed so the draft prints/estimates correctly. Returns a discriminated
 * union so the controller can map a `reason` to a typed 400.
 *
 * The record's business `date` fixes its monthly partition (the controller
 * derives `invoiceCollectionForDate(record.date)` for the write).
 */
export function buildDraftInvoice(
  input: CreateInvoiceInput,
  draftId: string,
  opts: InvoiceOptions
): { ok: true; record: InvoiceRecord } | ValidationError {
  const type = str(input.type).trim().toLowerCase();
  if (!(INVOICE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'invalid_type', field: 'type' };
  }
  const docType = type as InvoiceType;

  const cust = normalizeCustomer(input.customer);
  if (!cust.ok) return cust;

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { ok: false, reason: 'lines_required', field: 'lines' };
  }
  if (input.lines.length > INVOICE_MAX_LINES) {
    return { ok: false, reason: 'too_many_lines', field: 'lines' };
  }
  const lines: InvoiceLine[] = [];
  for (const raw of input.lines) {
    const r = normalizeLine(raw, opts.tvaRate);
    if (!r.ok) return r;
    lines.push(r.line);
  }

  const payment = normalizePayment(input.payment);
  const orderRef = str(input.orderRef).trim().slice(0, INVOICE_ORDER_REF_MAX);
  const dateRaw = str(input.date).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
    ? dateRaw
    : opts.today || invoiceTodayISO();
  const year = Number(date.slice(0, 4));

  const totals = computeInvoiceTotals(docType, lines, payment, opts.timbreRate);

  const record: InvoiceRecord = {
    id: draftId,
    type: docType,
    seq: 0,
    year,
    date,
    customer: cust.customer,
    lines,
    ...totals,
    status: 'brouillon',
    ...(payment ? { payment } : {}),
    ...(orderRef ? { orderRef } : {}),
  };
  return { ok: true, record };
}

// ===========================================================================
// VALIDATE (assign gap-less number) — the legal transition brouillon → valide.
// The number is reserved HERE, at validation, never at draft creation. The
// caller reserves via the bridge's erpReserveSeq() (PG-floored), then stamps here.
// ===========================================================================
/**
 * Produce the VALIDATED form of a draft: assign `seq` (the reserved gap-less
 * number), rebuild the legal `id` as `<type>-<year>-<seq>`, and set
 * `status='valide'`. Totals are RECOMPUTED from the stored lines (defensive —
 * the persisted figures are authoritative and must match the printed doc). The
 * source record must be a draft; anything else is a no-op error the controller
 * maps to a 409-style typed body.
 *
 * IMPORTANT (gap-less contract): the caller must reserve `seq` immediately
 * before persisting the returned record, and must NOT reserve again on a failed
 * persist — a consumed-but-unwritten number is a legal gap.
 */
export function applyValidation(
  draft: InvoiceRecord,
  seq: number,
  timbreRate: number
): { ok: true; record: InvoiceRecord } | ValidationError {
  if (draft.status !== 'brouillon') {
    return { ok: false, reason: 'not_a_draft', field: 'status' };
  }
  const s = Math.max(1, Math.floor(seq));
  const lines = Array.isArray(draft.lines) ? draft.lines : [];
  const totals = computeInvoiceTotals(
    draft.type,
    lines,
    normalizePayment(draft.payment),
    timbreRate
  );
  const record: InvoiceRecord = {
    ...draft,
    seq: s,
    id: formatInvoiceId(draft.type, draft.year, s),
    status: 'valide',
    ...totals,
  };
  return { ok: true, record };
}

// ===========================================================================
// VOID — valide → annule. A validated legal document is NEVER deleted (its
// number must remain accounted-for); it is marked `annule`. A draft may also be
// voided (nothing legal was emitted). Idempotent-friendly: re-voiding an
// already-voided doc is reported as such so the controller can 200 or 409.
// ===========================================================================
export function applyVoid(
  doc: InvoiceRecord
): { ok: true; record: InvoiceRecord } | ValidationError {
  if (doc.status === 'annule') {
    return { ok: false, reason: 'already_void', field: 'status' };
  }
  const record: InvoiceRecord = {
    ...doc,
    status: 'annule',
    voidedAt: new Date().toISOString(),
  };
  return { ok: true, record };
}

// ===========================================================================
// CONVERT — devis → bl → facture. The legal chain: a quote becomes a delivery
// note, which becomes an invoice. Conversion CARRIES the lines + customer +
// order ref and records the source doc id in `convertedFrom` (lineage). The
// NEW document is born as a DRAFT (seq 0, brouillon) — it gets its own gap-less
// number only when validated (a facture's number must come from the facture
// series at facture time, not inherited from the devis).
// ===========================================================================
/** Allowed one-step forward conversions (strict legal order). */
const CONVERSION_NEXT: Record<InvoiceType, InvoiceType | null> = {
  devis: 'bl',
  bl: 'facture',
  facture: null,
};

/** Is `to` a legal next step from `from`? (devis→bl, bl→facture, or a skip). */
export function canConvert(from: InvoiceType, to: InvoiceType): boolean {
  if (from === to) return false;
  // Strict single step OR the legal skip devis→facture (a direct facture from a
  // quote is common when no separate BL is issued). Never backwards.
  if (CONVERSION_NEXT[from] === to) return true;
  if (from === 'devis' && to === 'facture') return true;
  return false;
}

/**
 * Build the converted DRAFT from a source document. `source` must be a
 * validated (or at least non-void) doc of a type that legally precedes `to`.
 * The new doc:
 *   • type = `to`, status = 'brouillon', seq = 0 (number assigned at its own
 *     validation), id = the caller-supplied `draftId`,
 *   • carries customer + lines (re-normalized, totals recomputed for the NEW
 *     kind so e.g. a facture picks up timbre a devis never had),
 *   • records `convertedFrom = source.id` and keeps `orderRef`,
 *   • date = today (a new document is dated when issued).
 * Returns a discriminated union; the controller maps `reason` to a typed body.
 */
export function buildConversion(
  source: InvoiceRecord,
  to: unknown,
  draftId: string,
  opts: InvoiceOptions
): { ok: true; record: InvoiceRecord } | ValidationError {
  const target = str(to).trim().toLowerCase();
  if (!(INVOICE_TYPES as readonly string[]).includes(target)) {
    return { ok: false, reason: 'invalid_type', field: 'to' };
  }
  const toType = target as InvoiceType;
  if (source.status === 'annule') {
    return { ok: false, reason: 'source_void', field: 'status' };
  }
  if (!canConvert(source.type, toType)) {
    return { ok: false, reason: 'illegal_conversion', field: 'to' };
  }
  // Re-normalize the carried lines against the NEW doc's default TVA so the
  // conversion is self-consistent even if env rates changed since the source.
  const srcLines = Array.isArray(source.lines) ? source.lines : [];
  const lines: InvoiceLine[] = [];
  for (const raw of srcLines) {
    const r = normalizeLine(raw, opts.tvaRate);
    if (!r.ok) return r;
    lines.push(r.line);
  }
  if (lines.length === 0) {
    return { ok: false, reason: 'lines_required', field: 'lines' };
  }
  const cust = normalizeCustomer(source.customer);
  if (!cust.ok) return cust;
  const payment = normalizePayment(source.payment);
  const date = opts.today || invoiceTodayISO();
  const year = Number(date.slice(0, 4));
  const totals = computeInvoiceTotals(toType, lines, payment, opts.timbreRate);
  const orderRef = str(source.orderRef).trim().slice(0, INVOICE_ORDER_REF_MAX);

  const record: InvoiceRecord = {
    id: draftId,
    type: toType,
    seq: 0,
    year,
    date,
    customer: cust.customer,
    lines,
    ...totals,
    status: 'brouillon',
    ...(payment ? { payment } : {}),
    ...(orderRef ? { orderRef } : {}),
    convertedFrom: source.id,
  };
  return { ok: true, record };
}

// ===========================================================================
// CONVERT-FROM-ORDER — mint a DRAFT invoice from a shop ORDER (orderRef). The
// storefront's `orders` collection carries `{ ref, items:[{title/name, price,
// qty}], total, customer/name/phone/address, paymentMethod?, ... }`. We map an
// order's items to invoice lines (unitHT = the order's per-unit price, treated
// as HT — DZ storefront prices are pre-tax on the facture), default the doc
// type to `facture` (the usual "make me an invoice for this order" action), and
// carry the order ref so the invoice links back. Draft only — number at
// validation. Pure; the caller supplies the fetched order record.
// ===========================================================================
export interface ConvertFromOrderInput {
  /** Target doc type (default 'facture'). */
  type?: unknown;
  /** Override customer (else derived from the order). */
  customer?: unknown;
  /** Override payment (else derived from the order's paymentMethod). */
  payment?: unknown;
}

/** Map an order's payment method string to our InvoicePayment vocabulary. */
function orderPaymentToInvoice(order: Record<string, unknown>): InvoicePayment {
  const raw = str(order.paymentMethod || order.payment || order.method)
    .trim()
    .toLowerCase();
  if (raw.includes('chargily') || raw.includes('cib') || raw.includes('edahabia')) {
    return 'chargily';
  }
  if (raw.includes('virement') || raw.includes('transfer') || raw.includes('bank')) {
    return 'virement';
  }
  // COD is the DZ default and what an untagged order almost always is.
  return 'cod';
}

/**
 * Build a DRAFT invoice from a shop order record. Returns a discriminated union.
 * `order` is the record the controller fetched from the `orders` collection
 * (matched by `orderRef`); this function does no I/O.
 */
export function buildInvoiceFromOrder(
  order: Record<string, unknown>,
  input: ConvertFromOrderInput,
  draftId: string,
  opts: InvoiceOptions
): { ok: true; record: InvoiceRecord } | ValidationError {
  const type = input.type == null ? 'facture' : str(input.type).trim().toLowerCase();
  if (!(INVOICE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'invalid_type', field: 'type' };
  }
  const docType = type as InvoiceType;

  const items = Array.isArray(order.items) ? (order.items as unknown[]) : [];
  if (items.length === 0) {
    return { ok: false, reason: 'order_has_no_lines', field: 'orderRef' };
  }
  if (items.length > INVOICE_MAX_LINES) {
    return { ok: false, reason: 'too_many_lines', field: 'lines' };
  }
  const lines: InvoiceLine[] = [];
  for (const raw of items) {
    const it = (raw ?? {}) as Record<string, unknown>;
    // Order items carry title||name + price (per-unit) + qty (default 1).
    const label = (str(it.title).trim() || str(it.name).trim()).slice(
      0,
      INVOICE_LABEL_MAX
    );
    const mapped = normalizeLine(
      {
        label,
        qty: it.qty == null ? 1 : it.qty,
        unitHT: it.price,
        ref: it.sku,
      },
      opts.tvaRate
    );
    if (!mapped.ok) return mapped;
    lines.push(mapped.line);
  }

  // Customer: explicit override, else derive from the order's fields.
  let customer: InvoiceCustomer;
  if (input.customer != null) {
    const c = normalizeCustomer(input.customer);
    if (!c.ok) return c;
    customer = c.customer;
  } else {
    const derived = normalizeCustomer({
      name:
        str((order.customer as Record<string, unknown> | undefined)?.name) ||
        str(order.name) ||
        str(order.customerName) ||
        'Client',
      address: str(order.address) || str(order.wilaya),
    });
    if (!derived.ok) return derived;
    customer = derived.customer;
  }

  const payment =
    normalizePayment(input.payment) ?? orderPaymentToInvoice(order);
  const orderRef = str(order.ref).trim().slice(0, INVOICE_ORDER_REF_MAX);
  const date = opts.today || invoiceTodayISO();
  const year = Number(date.slice(0, 4));
  const totals = computeInvoiceTotals(docType, lines, payment, opts.timbreRate);

  const record: InvoiceRecord = {
    id: draftId,
    type: docType,
    seq: 0,
    year,
    date,
    customer,
    lines,
    ...totals,
    status: 'brouillon',
    payment,
    ...(orderRef ? { orderRef } : {}),
  };
  return { ok: true, record };
}

// ===========================================================================
// LIST FILTERING — the controller fetches the relevant monthly partitions and
// merges; this pure helper applies the query filters (type/status) and sorts
// newest-first (by date then seq) so the API returns a stable, month-spanning
// ledger view. Kept pure so listing logic is unit-testable without the network.
// ===========================================================================
export interface InvoiceListFilter {
  type?: string;
  status?: string;
}

/** Coerce a raw stored record into an InvoiceRecord-ish view (tolerant). */
export function coerceInvoice(raw: unknown): InvoiceRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const type = str(r.type).toLowerCase();
  if (!(INVOICE_TYPES as readonly string[]).includes(type)) return null;
  return r as InvoiceRecord;
}

/**
 * Filter + sort a merged set of raw records for the list endpoint. Drops
 * non-invoice rows, applies optional type/status filters (validated against the
 * enums — an unknown filter value yields an empty result rather than throwing),
 * and sorts newest-first by business date then descending seq.
 */
export function filterInvoices(
  rawRecords: unknown[],
  filter: InvoiceListFilter
): InvoiceRecord[] {
  const wantType = str(filter.type).trim().toLowerCase();
  const wantStatus = str(filter.status).trim().toLowerCase();
  if (wantType && !(INVOICE_TYPES as readonly string[]).includes(wantType)) {
    return [];
  }
  if (wantStatus && !(INVOICE_STATUSES as readonly string[]).includes(wantStatus)) {
    return [];
  }
  const out: InvoiceRecord[] = [];
  for (const raw of rawRecords) {
    const inv = coerceInvoice(raw);
    if (!inv) continue;
    if (wantType && str(inv.type).toLowerCase() !== wantType) continue;
    if (wantStatus && str(inv.status).toLowerCase() !== wantStatus) continue;
    out.push(inv);
  }
  out.sort((a, b) => {
    const da = str(a.date);
    const db = str(b.date);
    if (da !== db) return db.localeCompare(da);
    return num(b.seq) - num(a.seq);
  });
  return out;
}
