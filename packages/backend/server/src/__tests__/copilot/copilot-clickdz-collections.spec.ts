import ava, { type TestFn } from 'ava';

import {
  DURABLE_PREFIXES,
  isDurableCollection,
  PARTITION_SUFFIX_RE,
} from '../../plugins/copilot/clickdz-erp-collections';

// ---------------------------------------------------------------------------
// DzOS Phase 0 (WS-A) — durable vs ephemeral collection classification.
//
// The data API treats durable collections (ERP money, legal docs, PII) as
// Postgres-source-of-truth: dual-written, read from PG, NO Redis TTL, 5,000-
// record cap. Ephemeral collections (storefront render data) stay Redis-only
// with the legacy 90-day TTL and 500-record cap. A wrong classification is
// either a data-loss risk (a durable collection treated as ephemeral expires
// at 90d) or a cost/perf regression (an ephemeral collection treated as
// durable is mirrored to PG for no benefit). These tests lock the boundary.
//
// Pure: no app bootstrap, no Postgres, no Redis. Runs in milliseconds.
// ---------------------------------------------------------------------------

const test = ava as TestFn;

// --- partition suffix stripping --------------------------------------------

test('PARTITION_SUFFIX_RE strips a trailing -YYYYMM (6 digits)', t => {
  t.is('invoices-202607'.replace(PARTITION_SUFFIX_RE, ''), 'invoices');
  t.is('caisse-202512'.replace(PARTITION_SUFFIX_RE, ''), 'caisse');
  t.is('orders'.replace(PARTITION_SUFFIX_RE, ''), 'orders');
  // 5 digits is NOT a partition suffix (a collection named orders-12345 is
  // a literal collection name, not a month partition).
  t.is('orders-12345'.replace(PARTITION_SUFFIX_RE, ''), 'orders-12345');
});

// --- durable: ERP money + legal + PII + config ------------------------------

test('durable: the core ERP money collections are durable', t => {
  for (const c of [
    'orders',
    'customers',
    'clients',
    'expenses',
    'depenses',
    'caisse',
    'creances',
    'invoices',
    'movements',
    'compta',
  ]) {
    t.true(isDurableCollection(c), `${c} must be durable`);
  }
});

test('durable: inventory + procurement + logistics collections are durable', t => {
  for (const c of [
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
  ]) {
    t.true(isDurableCollection(c), `${c} must be durable`);
  }
});

test('durable: month-partitioned money collections resolve via prefix stripping', t => {
  t.true(isDurableCollection('invoices-202607'));
  t.true(isDurableCollection('caisse-202512'));
  t.true(isDurableCollection('compta-202601'));
  t.true(isDurableCollection('movements-202608'));
});

// --- ephemeral: storefront render data -------------------------------------

test('ephemeral: storefront render collections are NOT durable', t => {
  for (const c of [
    'categories',
    'reviews',
    'banners',
    'hero',
    'pages',
    'menus',
    'coupons',
  ]) {
    t.false(isDurableCollection(c), `${c} must be ephemeral`);
  }
});

test('ephemeral: an unknown collection a generated app invented is ephemeral (fail-safe)', t => {
  // Fail-safe: an unknown collection is treated as ephemeral (cache-grade),
  // never as durable (which would mirror it to PG unnecessarily). The DGI
  // risk runs the other way — a durable collection misclassified as
  // ephemeral expires — so the durable set is an explicit allowlist.
  t.false(isDurableCollection('custom-widget'));
  t.false(isDurableCollection('app-state-xyz'));
});

// --- DURABLE_PREFIXES sanity ------------------------------------------------

test('DURABLE_PREFIXES: the set is non-empty and frozen', t => {
  t.true(DURABLE_PREFIXES.size > 15);
  t.true(DURABLE_PREFIXES.has('orders'));
  t.true(DURABLE_PREFIXES.has('invoices'));
});

// --- regression: the pre-Phase-0 90d TTL data-loss path is closed -----------

test('regression: legal invoices (partitioned) are durable → no 90d Redis expiry', t => {
  // The live data-loss bug: invoices-YYYYMM sat in Redis with a 90d TTL and the
  // PG mirror OFF. A merchant who didn't open the app for 90 days lost every
  // legal invoice. Durable classification + Phase 0 default-on dual-write +
  // no-TTL-on-durable closes it. This test guards the classification half.
  t.true(isDurableCollection('invoices-202601'));
  t.true(isDurableCollection('invoices-202602'));
  t.true(isDurableCollection('invoices-202512'));
});
