/**
 * ClickDz collection classification — pure helpers, no NestJS, no I/O.
 *
 * The data API (`clickdz-data.controller.ts`) stores per-(slug, collection)
 * records. Two classifications govern how a collection is treated:
 *
 *   • DURABLE — ERP/money/legal/PII collections. Postgres is the source of
 *     truth (dual-written, read from PG, NO Redis TTL). A 90-day silent Redis
 *     expiry of these was a live data-loss risk (a merchant who didn't open
 *     the app for 90 days lost legal invoices). Raised cap (5,000 records).
 *
 *   • EPHEMERAL — storefront render data (products/settings/categories/
 *     reviews/…). Cache-grade, Redis-only, 90-day TTL, 500-record cap.
 *
 * Money documents are stored month-partitioned as `<prefix>-YYYYMM`, so both
 * tests strip a trailing `-YYYYMM` (6-digit) partition suffix and check the
 * PREFIX. Extracted here so the classification is unit-testable without
 * booting NestJS, and so the mini-ERP template + sync engine can reuse it.
 *
 * Framework-free: stdlib only. Same contract as clickdz-erp-caisse.ts and
 * clickdz-erp-invoicing.ts (pure logic, no imports).
 */

/** Strips a trailing `-YYYYMM` (6-digit) month-partition suffix. */
export const PARTITION_SUFFIX_RE = /-\d{6}$/;

/**
 * Durable collection prefixes — ERP money, legal docs, PII, and the merchant
 * configuration set. These are dual-written to Postgres, read from PG, and
 * NEVER TTL-expire on Redis. A collection whose prefix (after stripping a
 * partition suffix) is in this set is durable.
 */
export const DURABLE_PREFIXES: ReadonlySet<string> = new Set([
  'orders',
  'customers',
  'clients',
  'expenses',
  'depenses',
  'caisse',
  'creances',
  'invoices',
  'invoice',
  'movements',
  'compta',
  'stock',
  'inventory',
  'products',
  'suppliers',
  'purchase-orders',
  'warehouses',
  'couriers',
  'shipping-rates',
  'staff',
  'settings',
]);

/**
 * True if a collection is DURABLE (PG source of truth, no Redis TTL, 5k cap).
 * Strips a trailing `-YYYYMM` partition suffix first so `invoices-202607` and
 * `caisse-202607` resolve to their durable prefixes.
 */
export function isDurableCollection(collection: string): boolean {
  const base = collection.replace(PARTITION_SUFFIX_RE, '');
  return DURABLE_PREFIXES.has(base) || DURABLE_PREFIXES.has(collection);
}
