// ---------------------------------------------------------------------------
// R2-b (WSE-4) — SUPPLIERS + PURCHASE ORDERS (procurement).
//
// Two reference collections layered on the SAME per-slug data API the ERP admin
// routes already use (server-side, with the re-derived write token):
//   • `suppliers`        [{ id, name, phone, email?, address?, balance?, active,
//                          createdAt }] — bounded reference data (kebab-slug id).
//   • `purchase-orders`  [{ id:'po-<year>-<seq>', supplierId, date, status,
//                          lines:[{productId?, label, qty, qtyReceived, unitCost}],
//                          totalCost, warehouseId?, note, createdAt }].
//
// RECEIVING (the load-bearing invariant): a partial/full receive of a PO posts
// stock through the EXISTING multi-warehouse inventory v2 ledger — NOT a parallel
// one. The controller writes each computed movement via its existing
// `erpCreateRecord(slug, erpMovementCollection(), movement, token)` into the
// monthly `movements-YYYYMM` partition and then recomputes the product roll-up
// via `erpApplyStockRollup`, byte-identical to how POST /erp/inventory/movement
// works. This module only SHAPES the movement records (reason 'purchase',
// signed positive delta, productKey/warehouseId keyed exactly like the ledger)
// and computes the PO/line/status/balance side of the receive; it never fetches.
//
// DESIGN: PURE helper module (no Nest decorators, no framework error classes),
// mirroring `clickdz-app-source.ts` / `cdz-data-token.ts` — boot-safe when
// imported and unit-testable in isolation. It NEVER throws for expected
// validation failures; instead it returns discriminated-union results and the
// controller (which owns `@Res` passthrough + the typed `../../base` errors)
// maps a failure `reason` to the right typed HTTP status. Cross-cutting values
// (the data-API base URL, the per-slug write token) are INJECTED by the caller
// so there is no duplicated env/coupling.
//
// Gap-less PO numbering uses a server-side Redis INCR on
// `clickdz:erpseq:{slug}:po:{year}` (per R2 contract) — the controller owns the
// INCR; this module only formats the resulting `po-<year>-<seq>` id. Because the
// data API's POST mints its OWN id, PO/supplier records are written at their
// business-key id via the v2 PUT-upsert primitive (WSE-1) — see putErpRecord.
// ---------------------------------------------------------------------------

// One data-API record (schemaless JSON + server-managed id/createdAt) — the same
// loose shape the bridge uses so records round-trip without re-typing.
export type ProcRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Caps & knobs. All belt-and-braces on top of the data API's own 8KB/record and
// 500/collection caps; kept tiny so a fat-finger can't bloat a record.
// ---------------------------------------------------------------------------
const PROC_FETCH_TIMEOUT_MS = 15_000; // matches the bridge's ERP_DATA_TIMEOUT_MS
const SUPPLIER_NAME_MAX = 120;
const SUPPLIER_PHONE_MAX = 40;
const SUPPLIER_EMAIL_MAX = 160;
const SUPPLIER_ADDRESS_MAX = 300;
const SUPPLIER_ID_MAX = 60;
const PO_NOTE_MAX = 500;
const PO_LABEL_MAX = 160;
const PO_PRODUCTID_MAX = 120;
const PO_WAREHOUSE_ID_MAX = 60;
const PO_MAX_LINES = 100;
// A qty / unit cost is a non-negative number; clamp magnitudes so a bad caller
// can't create absurd values (and to keep the record small).
const PO_QTY_MAX = 1_000_000;
const PO_UNIT_COST_MAX = 100_000_000;
// A supplier balance can go negative (we owe them) or positive (credit); clamp.
const SUPPLIER_BALANCE_ABS_MAX = 1_000_000_000;

// The PO status vocabulary (French, mirroring the shop/ERP status idiom). A
// draft PO ('brouillon') carries no stock effect; 'commande' = ordered; a
// receive drives it to 'recu-partiel' (some lines outstanding) or 'recu' (all
// lines fully received); 'annule' = cancelled (terminal, no further receiving).
export const PROC_PO_STATUSES = [
  'brouillon',
  'commande',
  'recu-partiel',
  'recu',
  'annule',
] as const;
export type ProcPoStatus = (typeof PROC_PO_STATUSES)[number];

// The inventory ledger's controlled vocabulary uses 'purchase' for a stock-in
// from a supplier — reused VERBATIM here so PO receiving records are
// indistinguishable from a manual purchase movement in the ledger.
export const PROC_MOVEMENT_REASON = 'purchase' as const;

// ---------------------------------------------------------------------------
// Loose readers (mirror the bridge's erpStr/erpNum so records round-trip 1:1).
// ---------------------------------------------------------------------------
/** Number(v), non-finite → 0. */
function procNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
/** null/undefined → ''. */
function procStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
/** Clamp n into [lo, hi] and round to an integer. */
function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * Canonical kebab-slug business key for a supplier, derived from its name
 * (lowercased, non-alphanumerics → '-', collapsed, trimmed). Stable across
 * edits so a supplier is upserted in place. Empty when the name yields nothing
 * usable (caller rejects). Matches the courier id convention (kebab-case slug)
 * pinned in the R2 contract.
 */
export function procSupplierId(name: string): string {
  return procStr(name)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics (accents)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SUPPLIER_ID_MAX);
}

/**
 * The Redis key the controller INCRs for gap-less PO numbering (per R2
 * contract: `clickdz:erpseq:{slug}:{docType}:{year}`). Server-side only —
 * never client-minted.
 */
export function procPoSeqKey(slug: string, year: number): string {
  return `clickdz:erpseq:${slug}:po:${year}`;
}

/** Format a PO business-key id from a year + a gap-less sequence number. */
export function procPoId(year: number, seq: number): string {
  return `po-${year}-${seq}`;
}

// ---------------------------------------------------------------------------
// SUPPLIERS
// ---------------------------------------------------------------------------
export type SupplierResult =
  | { ok: true; record: ProcRecord; id: string }
  | { ok: false; reason: 'name_required' };

/**
 * Sanitize + shape a supplier upsert body into the pinned record shape
 * `{ id, name, phone, email?, address?, balance?, active, createdAt }`. The id
 * is the kebab-slug of the name (stable business key). `prev` (an existing
 * record matched by id) lets a partial edit PRESERVE fields the body omits —
 * critically `balance` (money) and `createdAt`, so a name/phone edit can never
 * wipe the running balance. Optional string fields are omitted when empty (keeps
 * the record tiny). `active` defaults to true; only an explicit `false` disables.
 */
export function buildSupplierRecord(
  body: unknown,
  prev?: ProcRecord
): SupplierResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = procStr(b.name).trim().slice(0, SUPPLIER_NAME_MAX);
  if (!name) return { ok: false, reason: 'name_required' };
  const id = procSupplierId(name) || procSupplierId(procStr(prev?.id));
  if (!id) return { ok: false, reason: 'name_required' };

  const phone =
    b.phone !== undefined
      ? procStr(b.phone).replace(/[^0-9+]/g, '').slice(0, SUPPLIER_PHONE_MAX)
      : procStr(prev?.phone);
  const emailRaw =
    b.email !== undefined ? procStr(b.email).trim() : procStr(prev?.email);
  const email = emailRaw.slice(0, SUPPLIER_EMAIL_MAX);
  const address =
    b.address !== undefined
      ? procStr(b.address).trim().slice(0, SUPPLIER_ADDRESS_MAX)
      : procStr(prev?.address);
  // Balance: explicit body value wins (clamped); else preserve prior; else 0.
  const balance =
    b.balance !== undefined
      ? clampInt(procNum(b.balance), -SUPPLIER_BALANCE_ABS_MAX, SUPPLIER_BALANCE_ABS_MAX)
      : prev?.balance !== undefined
        ? clampInt(procNum(prev.balance), -SUPPLIER_BALANCE_ABS_MAX, SUPPLIER_BALANCE_ABS_MAX)
        : 0;
  const active =
    b.active !== undefined
      ? b.active !== false
      : prev?.active !== undefined
        ? prev.active !== false
        : true;
  const createdAt = procStr(prev?.createdAt) || new Date().toISOString();

  const record: ProcRecord = {
    id,
    name,
    phone,
    ...(email ? { email } : {}),
    ...(address ? { address } : {}),
    balance,
    active,
    createdAt,
  };
  return { ok: true, record, id };
}

/**
 * Compute a supplier's new balance after applying a signed `delta` (positive =
 * we now owe MORE; e.g. receiving goods on credit increases what we owe).
 * Returns a fresh supplier record with the clamped balance, preserving every
 * other field. `prev` is the current stored supplier record.
 */
export function applySupplierBalanceDelta(
  prev: ProcRecord,
  delta: number
): ProcRecord {
  const current = procNum(prev.balance);
  const next = clampInt(
    current + procNum(delta),
    -SUPPLIER_BALANCE_ABS_MAX,
    SUPPLIER_BALANCE_ABS_MAX
  );
  const merged: ProcRecord = { ...prev };
  merged.balance = next;
  return merged;
}

// ---------------------------------------------------------------------------
// PURCHASE ORDERS
// ---------------------------------------------------------------------------
/** A normalized PO line (the shape stored in the record's `lines` array). */
export interface ProcPoLine {
  productId?: string;
  label: string;
  qty: number;
  qtyReceived: number;
  unitCost: number;
}

/** Σ(qty × unitCost) over the lines, rounded to an integer (DZD). */
export function computePoTotalCost(lines: ProcPoLine[]): number {
  let total = 0;
  for (const l of lines) total += procNum(l.qty) * procNum(l.unitCost);
  return Math.max(0, Math.round(total));
}

/**
 * Normalize + validate the caller-supplied lines of a new PO. Each line needs a
 * `label` (or a `productId` we fall back to as the label). qty defaults to 1;
 * qtyReceived starts at 0 (a fresh PO has received nothing); unitCost defaults
 * to 0. Returns null when there are no usable lines OR the count exceeds the
 * cap (caller rejects with a 400). Fields are clamped to non-negative integers.
 */
export function normalizePoLines(raw: unknown): ProcPoLine[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0 || raw.length > PO_MAX_LINES) return null;
  const out: ProcPoLine[] = [];
  for (const item of raw) {
    const l = (item ?? {}) as Record<string, unknown>;
    const productId = procStr(l.productId).trim().slice(0, PO_PRODUCTID_MAX);
    const label =
      procStr(l.label).trim().slice(0, PO_LABEL_MAX) || productId;
    if (!label) return null; // a line with neither a label nor a productId is invalid
    const qty = clampInt(procNum(l.qty != null ? l.qty : 1), 0, PO_QTY_MAX);
    const unitCost = clampInt(procNum(l.unitCost), 0, PO_UNIT_COST_MAX);
    out.push({
      ...(productId ? { productId } : {}),
      label,
      qty,
      qtyReceived: 0,
      unitCost,
    });
  }
  return out;
}

export type PoBuildResult =
  | { ok: true; record: ProcRecord }
  | {
      ok: false;
      reason: 'lines_required' | 'bad_status' | 'bad_supplier';
    };

/**
 * Shape a NEW purchase order record. The `id` is minted by the caller
 * (procPoId with a gap-less Redis INCR seq) and passed in. status defaults to
 * 'brouillon' (a draft PO has no stock effect until received). supplierId is
 * required (a PO is always against a supplier). warehouseId is optional here
 * (the receive call can also supply/override it). totalCost is computed from
 * the lines. note is optional/omitted when empty.
 */
export function buildPoRecord(input: {
  id: string;
  supplierId: string;
  date?: unknown;
  status?: unknown;
  lines: ProcPoLine[];
  warehouseId?: unknown;
  note?: unknown;
}): PoBuildResult {
  const supplierId = procStr(input.supplierId).trim().slice(0, SUPPLIER_ID_MAX);
  if (!supplierId) return { ok: false, reason: 'bad_supplier' };
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { ok: false, reason: 'lines_required' };
  }
  let status: ProcPoStatus = 'brouillon';
  if (input.status !== undefined) {
    const s = procStr(input.status).trim();
    if (!(PROC_PO_STATUSES as readonly string[]).includes(s)) {
      return { ok: false, reason: 'bad_status' };
    }
    status = s as ProcPoStatus;
  }
  const date = procStr(input.date).slice(0, 10) || new Date().toISOString().slice(0, 10);
  const warehouseId = procStr(input.warehouseId).trim().slice(0, PO_WAREHOUSE_ID_MAX);
  const note = procStr(input.note).trim().slice(0, PO_NOTE_MAX);
  const totalCost = computePoTotalCost(input.lines);
  const record: ProcRecord = {
    id: input.id,
    supplierId,
    date,
    status,
    lines: input.lines,
    totalCost,
    ...(warehouseId ? { warehouseId } : {}),
    ...(note ? { note } : {}),
    createdAt: new Date().toISOString(),
  };
  return { ok: true, record };
}

/** Read a PO's stored lines back into the normalized ProcPoLine shape. */
export function readPoLines(po: ProcRecord): ProcPoLine[] {
  const raw = Array.isArray(po.lines) ? (po.lines as unknown[]) : [];
  return raw.map(item => {
    const l = (item ?? {}) as Record<string, unknown>;
    const productId = procStr(l.productId).trim();
    return {
      ...(productId ? { productId } : {}),
      label: procStr(l.label).trim() || productId,
      qty: clampInt(procNum(l.qty), 0, PO_QTY_MAX),
      qtyReceived: clampInt(procNum(l.qtyReceived), 0, PO_QTY_MAX),
      unitCost: clampInt(procNum(l.unitCost), 0, PO_UNIT_COST_MAX),
    };
  });
}

/**
 * The canonical inventory-ledger product key for a PO line: prefer the line's
 * `productId` (which the storefront/ERP product carries as `sku`), else the
 * line label lowercased/trimmed — EXACTLY the resolution the bridge's
 * erpProductKey performs (sku → display title lowercased), so a receiving
 * movement's productKey lines up with the product roll-up. A line whose key is
 * empty simply produces no stock movement (the PO line is still received).
 */
export function procLineProductKey(line: ProcPoLine): string {
  const pid = procStr(line.productId).trim();
  if (pid) return pid;
  return procStr(line.label).trim().toLowerCase();
}

/** A single stock movement to append to the ledger, in its EXACT record shape. */
export interface ProcMovement {
  ts: string;
  productKey: string;
  warehouseId: string;
  delta: number;
  reason: typeof PROC_MOVEMENT_REASON;
  ref?: string;
}

export type ReceiveResult =
  | {
      ok: true;
      // The updated PO record to persist (in place, at its business-key id).
      po: ProcRecord;
      // Movement records to append to the CURRENT-month `movements-YYYYMM`
      // partition via the bridge's existing erpCreateRecord — one per received
      // line that maps to a product key, positive delta, reason 'purchase'.
      movements: ProcMovement[];
      // Per-productKey received qty (for logging / roll-up hints). The bridge
      // recomputes the authoritative roll-up from the ledger after appending.
      receivedByKey: Record<string, number>;
      // Total cost of the goods received in THIS call (Σ receivedQty×unitCost) —
      // the amount to add to the supplier balance (we now owe this).
      receivedCost: number;
      nextStatus: ProcPoStatus;
    }
  | {
      ok: false;
      reason:
        | 'not_receivable' // PO is cancelled or already fully received
        | 'no_warehouse' // no warehouseId on the PO and none supplied
        | 'nothing_to_receive' // request matched no outstanding line qty
        | 'bad_lines'; // malformed receive body
    };

/**
 * Compute the effect of a receive request on a PO, WITHOUT any I/O.
 *
 * `req.lines` is `[{ label|productId, qty }]` — the qty being received now for
 * each line. Lines are matched to PO lines by productId first (exact), else by
 * label (case-insensitive). Each match receives up to the OUTSTANDING qty
 * (qty − qtyReceived); over-receipt is clamped so qtyReceived never exceeds the
 * ordered qty. When `req.lines` is empty/absent, the WHOLE remaining PO is
 * received (a convenient "receive all" default).
 *
 * Produces:
 *  • the updated PO (incremented qtyReceived per line; new status),
 *  • one positive-delta 'purchase' movement per received line that resolves to
 *    a product key, into `warehouseId` (req override → PO's → error if neither),
 *  • the supplier-balance delta (receivedCost) so the caller can bump balance.
 *
 * New status: 'recu' when every line is fully received, else 'recu-partiel'.
 * A 'brouillon'/'commande'/'recu-partiel' PO is receivable; 'annule'/'recu' are
 * not (returns not_receivable).
 */
export function computeReceive(
  po: ProcRecord,
  req: { lines?: unknown; warehouseId?: unknown },
  nowIso: string = new Date().toISOString()
): ReceiveResult {
  const status = procStr(po.status).trim() as ProcPoStatus;
  if (status === 'annule' || status === 'recu') {
    return { ok: false, reason: 'not_receivable' };
  }
  const warehouseId =
    procStr(req.warehouseId).trim().slice(0, PO_WAREHOUSE_ID_MAX) ||
    procStr(po.warehouseId).trim();
  if (!warehouseId) return { ok: false, reason: 'no_warehouse' };

  const lines = readPoLines(po);
  if (lines.length === 0) return { ok: false, reason: 'bad_lines' };

  // Build the requested receive quantities. Empty request ⇒ receive ALL
  // outstanding qty on every line ("receive all" convenience).
  const rawReq = req.lines;
  const receiveAll = rawReq == null || (Array.isArray(rawReq) && rawReq.length === 0);
  if (!receiveAll && !Array.isArray(rawReq)) {
    return { ok: false, reason: 'bad_lines' };
  }

  // Map each PO line index → qty to receive now.
  const wantByIndex = new Map<number, number>();
  if (receiveAll) {
    lines.forEach((l, i) => {
      const outstanding = Math.max(0, l.qty - l.qtyReceived);
      if (outstanding > 0) wantByIndex.set(i, outstanding);
    });
  } else {
    for (const item of rawReq as unknown[]) {
      const r = (item ?? {}) as Record<string, unknown>;
      const qty = clampInt(procNum(r.qty), 0, PO_QTY_MAX);
      if (qty <= 0) continue;
      const productId = procStr(r.productId).trim();
      const label = procStr(r.label).trim().toLowerCase();
      // Find the first PO line matching by productId, else by label, that still
      // has outstanding qty and hasn't already been targeted this call.
      let idx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (wantByIndex.has(i)) continue;
        const l = lines[i];
        const matchesPid = productId && procStr(l.productId).trim() === productId;
        const matchesLabel = !productId && label && l.label.toLowerCase() === label;
        if (matchesPid || matchesLabel) {
          idx = i;
          break;
        }
      }
      if (idx < 0) continue; // no matching outstanding line — ignore silently
      const outstanding = Math.max(0, lines[idx].qty - lines[idx].qtyReceived);
      const take = Math.min(qty, outstanding);
      if (take > 0) wantByIndex.set(idx, take);
    }
  }

  if (wantByIndex.size === 0) {
    return { ok: false, reason: 'nothing_to_receive' };
  }

  // Apply the receipts: bump qtyReceived, build movements + cost.
  const ref = procStr(po.id).trim().slice(0, PO_LABEL_MAX);
  const movements: ProcMovement[] = [];
  const receivedByKey: Record<string, number> = {};
  let receivedCost = 0;
  const nextLines: ProcPoLine[] = lines.map((l, i) => {
    const take = wantByIndex.get(i) ?? 0;
    if (take <= 0) return l;
    const qtyReceived = Math.min(l.qty, l.qtyReceived + take);
    const actuallyTaken = qtyReceived - l.qtyReceived;
    if (actuallyTaken > 0) {
      receivedCost += actuallyTaken * l.unitCost;
      const key = procLineProductKey(l);
      if (key) {
        movements.push({
          ts: nowIso,
          productKey: key,
          warehouseId,
          delta: actuallyTaken,
          reason: PROC_MOVEMENT_REASON,
          ...(ref ? { ref } : {}),
        });
        receivedByKey[key] = (receivedByKey[key] ?? 0) + actuallyTaken;
      }
    }
    return { ...l, qtyReceived };
  });

  // New status: fully received on every line ⇒ 'recu', else 'recu-partiel'.
  const fullyReceived = nextLines.every(l => l.qtyReceived >= l.qty);
  const nextStatus: ProcPoStatus = fullyReceived ? 'recu' : 'recu-partiel';

  // Rebuild the PO record: preserve all fields, swap lines/status, keep the
  // resolved warehouseId (so a PO that had none now records where it landed).
  const nextPo: ProcRecord = { ...po };
  nextPo.lines = nextLines;
  nextPo.status = nextStatus;
  nextPo.warehouseId = warehouseId;
  nextPo.totalCost = computePoTotalCost(nextLines);

  return {
    ok: true,
    po: nextPo,
    movements,
    receivedByKey,
    receivedCost: Math.max(0, Math.round(receivedCost)),
    nextStatus,
  };
}

export type CancelResult =
  | { ok: true; po: ProcRecord }
  | { ok: false; reason: 'not_cancellable' };

/**
 * Cancel a PO (terminal). A PO that has ALREADY received stock ('recu-partiel'
 * or 'recu') is NOT cancellable — cancelling it would require reversing ledger
 * movements, which the append-only ledger models as compensating entries, not
 * deletions; that is out of scope here (the owner reverses via a manual
 * negative movement). Only 'brouillon'/'commande' POs cancel cleanly. Already
 * 'annule' ⇒ not_cancellable (idempotency is the caller's concern via 404/409).
 */
export function computeCancel(po: ProcRecord): CancelResult {
  const status = procStr(po.status).trim() as ProcPoStatus;
  if (status !== 'brouillon' && status !== 'commande') {
    return { ok: false, reason: 'not_cancellable' };
  }
  const next: ProcRecord = { ...po };
  next.status = 'annule';
  return { ok: true, po: next };
}

// ---------------------------------------------------------------------------
// DATA-API WRITE (self-contained, injected base+token) — the v2 PUT-upsert.
//
// The data API's POST create() ALWAYS mints its own random id, so it cannot
// preserve a business-key id like `po-2026-7` or a supplier kebab-slug. WSE-1
// added the atomic `PUT /api/v2/apps-data/:slug/:collection/:id` primitive that
// writes at a CALLER-CHOSEN id in place (one HSET, no delete window). This helper
// wraps it, mirroring the bridge's erpCreateRecord contract (returns the stored
// record on success; status 0 = unreachable). NEVER logs the token.
//
// It is a self-contained fetch (like clickdz-app-source's fetchDeployedHtml) so
// it introduces no private-method collision with sibling bridge blocks. The base
// is INJECTED (the controller passes its erpDataBase(slug)) to avoid duplicating
// the env read here.
// ---------------------------------------------------------------------------
export async function putErpRecord(
  dataBase: string,
  collection: string,
  id: string,
  record: ProcRecord,
  token: string
): Promise<{ ok: true; record: ProcRecord } | { ok: false; status: number }> {
  const url = `${dataBase}/${collection}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(record),
    signal: AbortSignal.timeout(PROC_FETCH_TIMEOUT_MS),
  }).catch(() => null);
  if (!res || !res.ok) {
    return { ok: false, status: res ? res.status : 0 };
  }
  const stored = (await res.json().catch(() => null)) as ProcRecord | null;
  return { ok: true, record: stored ?? record };
}
