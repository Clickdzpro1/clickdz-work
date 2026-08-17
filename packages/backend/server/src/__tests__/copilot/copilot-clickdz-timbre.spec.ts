import ava, { type TestFn } from 'ava';

import {
  applyValidation,
  computeInvoiceTotals,
  computeTimbre,
  INVOICE_PAYMENTS,
  resolveInvoiceRates,
  resolveTimbreScale,
  TIMBRE_MIN_DZD,
  TIMBRE_SCALE_LF2025,
  type InvoicePayment,
  type InvoiceRecord,
  type InvoiceType,
} from '../../plugins/copilot/clickdz-erp-invoicing';

// ---------------------------------------------------------------------------
// LF2025 timbre fiscal — progressive scale regression guards.
//
// Pre-2025 the rule was a flat 1% capped at 10,000 DZD. LF2025 (Art.100/258
// quinquies) replaced it with a PROGRESSIVE scale by cash-amount, kept the 5
// DZD floor, DROPPED the cap, and EXEMPTED electronic payments entirely. These
// tests lock the new behaviour at every bracket boundary and the e-payment
// exemption, so a regression to the old flat-rate code is caught immediately.
//
// Pure: no app bootstrap, no Postgres, no Redis. Runs in milliseconds.
// ---------------------------------------------------------------------------

const test = ava as TestFn;

/** Build a minimal validable draft facture with a given TTC base + payment. */
const draftFacture = (
  baseTTC: number,
  payment: InvoicePayment | undefined
): InvoiceRecord => ({
  id: 'draft-x',
  type: 'facture' as InvoiceType,
  seq: 0,
  year: 2026,
  date: '2026-08-17',
  customer: { name: 'Test Client' },
  // One line carrying the whole base as HT (TVA 0) so baseTTC === totalHT.
  lines: [{ label: 'x', qty: 1, unitHT: baseTTC, tvaRate: 0, lineHT: baseTTC, lineTVA: 0 }],
  totalHT: baseTTC,
  totalTVA: 0,
  timbre: 0,
  totalTTC: baseTTC,
  status: 'brouillon',
  payment,
});

// --- computeTimbre: bracket boundaries (LF2025 default scale) ---------------

test('computeTimbre: 1% bracket on base ≤ 30,000 (boundary 30,000 exact)', t => {
  t.is(computeTimbre('facture', 'cash', 30_000), 300); // 1% of 30,000
  t.is(computeTimbre('facture', 'cash', 10_000), 100); // 1% of 10,000
});

test('computeTimbre: 1.5% bracket on 30,000 < base ≤ 100,000 (boundary 100,000 exact)', t => {
  t.is(computeTimbre('facture', 'cash', 100_000), 1_500); // 1.5% of 100,000
  t.is(computeTimbre('facture', 'cash', 50_000), 750); // 1.5% of 50,000
});

test('computeTimbre: 2% bracket on base > 100,000 (NO cap — LF2025 removed it)', t => {
  t.is(computeTimbre('facture', 'cash', 200_000), 4_000); // 2% of 200,000
  t.is(computeTimbre('facture', 'cash', 5_000_000), 100_000); // 2%, no 10k cap
});

test('computeTimbre: floor of 5 DZD applies on a tiny cash base', t => {
  // 1% of 100 = 1 DZD → floored to 5.
  t.is(computeTimbre('facture', 'cash', 100), 5);
  // 1% of 300 = 3 DZD → floored to 5.
  t.is(computeTimbre('facture', 'cash', 300), 5);
  // 1% of 500 = 5 DZD → exactly the floor, no rounding issue.
  t.is(computeTimbre('facture', 'cash', 500), 5);
});

test('computeTimbre: COD counts as cash (physical cash at the door)', t => {
  t.is(computeTimbre('facture', 'cod', 30_000), 300);
  t.is(computeTimbre('facture', 'cod', 150_000), 3_000); // 2% bracket
});

test('computeTimbre: electronic payments are EXEMPT (LF2025)', t => {
  for (const ep of [
    'chargily',
    'virement',
    'cheque',
    'ccp',
    'edahabia',
    'cib',
  ] as InvoicePayment[]) {
    t.is(computeTimbre('facture', ep, 500_000), 0, `${ep} must be exempt`);
  }
});

test('computeTimbre: no timbre on devis/bl (only facture)', t => {
  t.is(computeTimbre('devis', 'cash', 50_000), 0);
  t.is(computeTimbre('bl', 'cash', 50_000), 0);
});

test('computeTimbre: no timbre on a zero-value cash facture', t => {
  t.is(computeTimbre('facture', 'cash', 0), 0);
});

test('computeTimbre: undefined payment → no timbre (no cash settlement)', t => {
  t.is(computeTimbre('facture', undefined, 50_000), 0);
});

// --- computeInvoiceTotals: scale + legacy number both accepted -------------

test('computeInvoiceTotals accepts a progressive scale (preferred)', t => {
  const r = computeInvoiceTotals('facture', [], 'cash', TIMBRE_SCALE_LF2025);
  // empty lines → base 0 → no timbre
  t.is(r.timbre, 0);
  t.is(r.totalTTC, 0);
});

test('computeInvoiceTotals accepts a legacy flat rate (number) for back-compat', t => {
  // A number is folded into a synthetic one-bracket scale.
  const r = computeInvoiceTotals('facture', [], 'cash', 1);
  t.is(r.timbre, 0); // base 0
});

// --- resolveTimbreScale: env parsing ----------------------------------------

test('resolveTimbreScale: LF2025 default when no env', t => {
  const s = resolveTimbreScale(undefined, undefined, undefined);
  t.is(s, TIMBRE_SCALE_LF2025);
  t.is(s.length, 3);
});

test('resolveTimbreScale: JSON env overrides the scale', t => {
  const custom = JSON.stringify([
    { upTo: 50_000, rate: 0.5 },
    { upTo: null, rate: 1 },
  ]);
  const s = resolveTimbreScale(custom, undefined, undefined);
  t.is(s.length, 2);
  t.is(s[0].rate, 0.5);
  t.is(s[1].upTo, null);
});

test('resolveTimbreScale: malformed JSON falls back to LF2025 default', t => {
  const s = resolveTimbreScale('not-json', undefined, undefined);
  t.is(s, TIMBRE_SCALE_LF2025);
});

test('resolveTimbreScale: legacy flat rate honored only with the opt-in flag', t => {
  // Without the flag, the legacy rate env is IGNORED (LF2025 wins).
  const s1 = resolveTimbreScale(undefined, '3', undefined);
  t.is(s1, TIMBRE_SCALE_LF2025);
  // With the flag, a synthetic one-bracket scale is built from the rate.
  const s2 = resolveTimbreScale(undefined, '3', '1');
  t.is(s2.length, 1);
  t.is(s2[0].rate, 3);
  t.is(s2[0].upTo, null);
});

// --- resolveInvoiceRates: returns the scale alongside the legacy rate ------

test('resolveInvoiceRates: returns tvaRate, timbreRate, timbreScale', t => {
  // Simulate the bridge reading process.env.
  const orig = { ...process.env };
  try {
    delete process.env.CDZ_ERP_TIMBRE_SCALE;
    delete process.env.CDZ_ERP_TIMBRE_LEGACY_FLAT;
    const r = resolveInvoiceRates(undefined, undefined);
    t.is(r.tvaRate, 19);
    t.is(r.timbreRate, 1);
    t.is(r.timbreScale, TIMBRE_SCALE_LF2025);
  } finally {
    process.env = orig;
  }
});

// --- applyValidation: end-to-end timbre on a validated facture -------------

test('applyValidation: a cash facture at 50,000 TTC carries the 1.5% timbre (750)', t => {
  const opts = { tvaRate: 19, timbreRate: 1, timbreScale: TIMBRE_SCALE_LF2025 };
  const res = applyValidation(draftFacture(50_000, 'cash'), 1, opts);
  t.true(res.ok);
  if (res.ok) {
    t.is(res.record.timbre, 750);
    t.is(res.record.totalTTC, 50_750);
    t.is(res.record.status, 'valide');
    t.is(res.record.seq, 1);
  }
});

test('applyValidation: an electronic facture at 500,000 carries NO timbre', t => {
  const opts = { tvaRate: 19, timbreRate: 1, timbreScale: TIMBRE_SCALE_LF2025 };
  const res = applyValidation(draftFacture(500_000, 'virement'), 2, opts);
  t.true(res.ok);
  if (res.ok) {
    t.is(res.record.timbre, 0);
    t.is(res.record.totalTTC, 500_000);
  }
});

test('applyValidation: a cash facture above 100k carries 2% with NO 10k cap', t => {
  const opts = { tvaRate: 19, timbreRate: 1, timbreScale: TIMBRE_SCALE_LF2025 };
  // 5,000,000 DZD cash → 2% = 100,000 DZD timbre. Pre-LF2025 this was capped
  // at 10,000. The cap MUST be gone.
  const res = applyValidation(draftFacture(5_000_000, 'cash'), 3, opts);
  t.true(res.ok);
  if (res.ok) {
    t.is(res.record.timbre, 100_000);
    t.is(res.record.totalTTC, 5_100_000);
  }
});

test('applyValidation: rejects a non-draft', t => {
  const opts = { tvaRate: 19, timbreRate: 1, timbreScale: TIMBRE_SCALE_LF2025 };
  const d = draftFacture(50_000, 'cash');
  d.status = 'valide';
  const res = applyValidation(d, 4, opts);
  t.false(res.ok);
  if (!res.ok) t.is(res.reason, 'not_a_draft');
});

// --- INVOICE_PAYMENTS: e-payment set is complete ---------------------------

test('INVOICE_PAYMENTS includes the LF2025 electronic methods', t => {
  const methods = INVOICE_PAYMENTS as readonly string[];
  for (const ep of ['chargily', 'virement', 'cheque', 'ccp', 'edahabia', 'cib']) {
    t.true(methods.includes(ep), `${ep} must be a known payment method`);
  }
  // cash + cod still present (the timbre-bearing methods).
  t.true(methods.includes('cash'));
  t.true(methods.includes('cod'));
});

// --- regression: the old flat-rate + cap behavior is GONE ------------------

test('regression: pre-LF2025 1%-cap-10k behavior no longer applies', t => {
  // 5,000,000 DZD cash under the OLD rule = min(10000, 1% of 5M=50000) = 10000.
  // Under LF2025 = 2% of 5M = 100000. The two are different; LF2025 wins.
  const lf2025 = computeTimbre('facture', 'cash', 5_000_000);
  t.not(lf2025, 10_000); // the old capped value is gone
  t.is(lf2025, 100_000); // the new uncapped 2% value
  // And the floor still applies on a tiny base (was 5, still 5).
  t.is(computeTimbre('facture', 'cash', 100), TIMBRE_MIN_DZD);
});
