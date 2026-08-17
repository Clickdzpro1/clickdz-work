// Standalone test runner for the compliance pack — no ava, no prelude, no env.
// Uses node:assert to verify the pure functions. Run with: npx tsx <this file>.
import assert from 'node:assert';

import {
  INVOICE_TYPES,
  INVOICE_PAYMENTS,
  computeTimbre,
  canConvert,
  buildDraftInvoice,
  buildConversion,
  orderPaymentToInvoice,
  applyValidation,
  type InvoicePayment,
  type InvoiceType,
  type InvoiceOptions,
} from './src/plugins/copilot/clickdz-erp-invoicing';

import {
  PCN_CHART,
  buildG50Summary,
  buildG12Summary,
  exportG50CSV,
  exportG50HTML,
  exportG12CSV,
  exportG12HTML,
  autoJournalFromInvoice,
  paymentMethodToPCN,
  paymentMethodLabel,
  type JournalEntry,
} from './src/plugins/copilot/clickdz-erp-accounting';

const OPTS: InvoiceOptions = { tvaRate: 19, timbreRate: 1 };
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(e as Error).message}`);
  }
}

console.log('\n=== Algeria Compliance Pack Tests ===\n');

// 1. INVOICE_TYPES
test('INVOICE_TYPES includes avoir, ticket, bon-de-commande', () => {
  const types = INVOICE_TYPES as readonly string[];
  assert.ok(types.includes('avoir'));
  assert.ok(types.includes('ticket'));
  assert.ok(types.includes('bon-de-commande'));
  assert.ok(types.includes('devis'));
  assert.ok(types.includes('bl'));
  assert.ok(types.includes('facture'));
  assert.strictEqual(types.length, 6);
});

// 2. Conversion chain
test('canConvert: bon-de-commande → devis', () => {
  assert.ok(canConvert('bon-de-commande', 'devis'));
});
test('canConvert: bon-de-commande can skip to bl or facture', () => {
  assert.ok(canConvert('bon-de-commande', 'bl'));
  assert.ok(canConvert('bon-de-commande', 'facture'));
});
test('canConvert: facture → avoir', () => {
  assert.ok(canConvert('facture', 'avoir'));
});
test('canConvert: ticket → facture', () => {
  assert.ok(canConvert('ticket', 'facture'));
});
test('canConvert: ticket → avoir', () => {
  assert.ok(canConvert('ticket', 'avoir'));
});
test('canConvert: avoir cannot convert further', () => {
  assert.ok(!canConvert('avoir', 'facture'));
  assert.ok(!canConvert('avoir', 'bl'));
});
test('canConvert: never backwards', () => {
  assert.ok(!canConvert('facture', 'bl'));
  assert.ok(!canConvert('bl', 'devis'));
});
test('canConvert: same type never a conversion', () => {
  for (const ty of INVOICE_TYPES) assert.ok(!canConvert(ty, ty));
});

// 3. Timbre on new types
test('computeTimbre: ticket attracts timbre on cash', () => {
  assert.strictEqual(computeTimbre('ticket', 'cash', 50_000), 750);
  assert.strictEqual(computeTimbre('ticket', 'cod', 10_000), 100);
});
test('computeTimbre: avoir attracts timbre on cash', () => {
  assert.strictEqual(computeTimbre('avoir', 'cash', 50_000), 750);
});
test('computeTimbre: bon-de-commande is pre-fiscal (no timbre)', () => {
  assert.strictEqual(computeTimbre('bon-de-commande', 'cash', 50_000), 0);
});
test('computeTimbre: ticket and avoir exempt on electronic', () => {
  for (const ep of ['chargily', 'virement', 'cheque', 'ccp', 'edahabia', 'cib'] as InvoicePayment[]) {
    assert.strictEqual(computeTimbre('ticket', ep, 500_000), 0);
    assert.strictEqual(computeTimbre('avoir', ep, 500_000), 0);
  }
});

// 4. buildDraftInvoice
const validInput = (type: string) => ({
  type,
  customer: { name: 'Test Client', nif: '123456789012345' },
  lines: [{ label: 'Article A', qty: 2, unitHT: 5000, tvaRate: 19 }],
  payment: 'cash',
  date: '2026-08-17',
});
test('buildDraftInvoice: avoir draft builds', () => {
  const res = buildDraftInvoice(validInput('avoir'), 'draft-av1', OPTS);
  assert.ok(res.ok);
  if (res.ok) { assert.strictEqual(res.record.type, 'avoir'); assert.strictEqual(res.record.status, 'brouillon'); }
});
test('buildDraftInvoice: ticket draft builds', () => {
  const res = buildDraftInvoice(validInput('ticket'), 'draft-tk1', OPTS);
  assert.ok(res.ok);
  if (res.ok) assert.strictEqual(res.record.type, 'ticket');
});
test('buildDraftInvoice: bon-de-commande draft builds (no timbre)', () => {
  const res = buildDraftInvoice(validInput('bon-de-commande'), 'draft-bdc1', OPTS);
  assert.ok(res.ok);
  if (res.ok) assert.strictEqual(res.record.timbre, 0);
});
test('buildDraftInvoice: rejects unknown type', () => {
  const res = buildDraftInvoice(validInput('unknown'), 'draft-x', OPTS);
  assert.ok(!res.ok);
});

// 5. buildConversion
const validatedFacture = () => ({
  id: 'facture-2026-00001', type: 'facture' as InvoiceType, seq: 1, year: 2026,
  date: '2026-08-17', customer: { name: 'Test Client' },
  lines: [{ label: 'A', qty: 1, unitHT: 50_000, tvaRate: 19, lineHT: 50_000, lineTVA: 9_500 }],
  totalHT: 50_000, totalTVA: 9_500, timbre: 750, totalTTC: 60_250,
  status: 'valide' as const, payment: 'cash' as InvoicePayment,
});
test('buildConversion: facture → avoir', () => {
  const res = buildConversion(validatedFacture(), 'avoir', 'draft-av1', OPTS);
  assert.ok(res.ok);
  if (res.ok) { assert.strictEqual(res.record.type, 'avoir'); assert.strictEqual(res.record.convertedFrom, 'facture-2026-00001'); }
});
test('buildConversion: bon-de-commande → devis', () => {
  const bdc = { ...validatedFacture(), id: 'bon-de-commande-2026-00001', type: 'bon-de-commande' as InvoiceType, status: 'valide' as const };
  const res = buildConversion(bdc, 'devis', 'draft-dv1', OPTS);
  assert.ok(res.ok);
  if (res.ok) assert.strictEqual(res.record.type, 'devis');
});

// 6. orderPaymentToInvoice
test('orderPaymentToInvoice: cheque', () => {
  assert.strictEqual(orderPaymentToInvoice({ paymentMethod: 'cheque' }), 'cheque');
  assert.strictEqual(orderPaymentToInvoice({ paymentMethod: 'chèque bancaire' }), 'cheque');
});
test('orderPaymentToInvoice: ccp', () => {
  assert.strictEqual(orderPaymentToInvoice({ paymentMethod: 'ccp' }), 'ccp');
  assert.strictEqual(orderPaymentToInvoice({ paymentMethod: 'mandat poste' }), 'ccp');
});

// 7. Payment method → PCN
test('paymentMethodToPCN: cash → 531', () => { assert.strictEqual(paymentMethodToPCN('cash'), '531'); });
test('paymentMethodToPCN: cod → 532', () => { assert.strictEqual(paymentMethodToPCN('cod'), '532'); });
test('paymentMethodToPCN: cheque → 512', () => { assert.strictEqual(paymentMethodToPCN('cheque'), '512'); });
test('paymentMethodToPCN: ccp → 514', () => { assert.strictEqual(paymentMethodToPCN('ccp'), '514'); });
test('paymentMethodToPCN: edahabia → 514', () => { assert.strictEqual(paymentMethodToPCN('edahabia'), '514'); });
test('paymentMethodToPCN: cib → 514', () => { assert.strictEqual(paymentMethodToPCN('cib'), '514'); });
test('paymentMethodToPCN: chargily → 514', () => { assert.strictEqual(paymentMethodToPCN('chargily'), '514'); });
test('paymentMethodToPCN: virement → 512', () => { assert.strictEqual(paymentMethodToPCN('virement'), '512'); });
test('paymentMethodToPCN: unknown → 411', () => { assert.strictEqual(paymentMethodToPCN(''), '411'); });
test('paymentMethodToPCN: all codes valid in PCN_CHART', () => {
  for (const m of INVOICE_PAYMENTS) {
    assert.ok(paymentMethodToPCN(m) in PCN_CHART, `${m} → ${paymentMethodToPCN(m)}`);
  }
});
test('paymentMethodLabel: non-empty for each method', () => {
  for (const m of INVOICE_PAYMENTS) assert.ok(paymentMethodLabel(m).length > 0);
});

// 8. SCF auto-journal
const invoiceLike = {
  id: 'facture-2026-00042', type: 'facture', date: '2026-08-17',
  totalHT: 100_000, totalTVA: 19_000, timbre: 0, totalTTC: 119_000,
  payment: 'cash', customer: { name: 'SARL Test' },
  lines: [{ tvaRate: 19, lineHT: 100_000, lineTVA: 19_000 }],
};
test('autoJournal: facture cash balanced', () => {
  const r = autoJournalFromInvoice(invoiceLike);
  assert.strictEqual(r.entries.length, 3);
  const td = r.entries.reduce((s, e) => s + (e.debit as number), 0);
  const tc = r.entries.reduce((s, e) => s + (e.credit as number), 0);
  assert.strictEqual(td, 119_000);
  assert.strictEqual(tc, 119_000);
});
test('autoJournal: cash debits 531', () => {
  const r = autoJournalFromInvoice(invoiceLike);
  const d = r.entries.find(e => (e.debit as number) > 0);
  assert.strictEqual(d!.accountCode, '531');
});
test('autoJournal: cheque debits 512', () => {
  const r = autoJournalFromInvoice({ ...invoiceLike, payment: 'cheque' });
  const d = r.entries.find(e => (e.debit as number) > 0);
  assert.strictEqual(d!.accountCode, '512');
});
test('autoJournal: edahabia debits 514', () => {
  const r = autoJournalFromInvoice({ ...invoiceLike, payment: 'edahabia' });
  const d = r.entries.find(e => (e.debit as number) > 0);
  assert.strictEqual(d!.accountCode, '514');
});
test('autoJournal: CCP debits 514', () => {
  const r = autoJournalFromInvoice({ ...invoiceLike, payment: 'ccp' });
  const d = r.entries.find(e => (e.debit as number) > 0);
  assert.strictEqual(d!.accountCode, '514');
});
test('autoJournal: CIB debits 514', () => {
  const r = autoJournalFromInvoice({ ...invoiceLike, payment: 'cib' });
  const d = r.entries.find(e => (e.debit as number) > 0);
  assert.strictEqual(d!.accountCode, '514');
});
test('autoJournal: timbre produces 5 entries', () => {
  const r = autoJournalFromInvoice({ ...invoiceLike, timbre: 1_500, totalTTC: 120_500 });
  assert.strictEqual(r.entries.length, 5);
  const td = r.entries.find(e => e.accountCode === '63' && (e.debit as number) > 0);
  assert.ok(td);
  assert.strictEqual(td!.debit, 1_500);
});
test('autoJournal: avoir reverses', () => {
  const r = autoJournalFromInvoice({ ...invoiceLike, id: 'avoir-2026-00001', type: 'avoir' });
  const rev = r.entries.find(e => e.accountCode === '701');
  assert.strictEqual(rev!.debit, 100_000);
  assert.strictEqual(rev!.credit, 0);
  const td = r.entries.reduce((s, e) => s + (e.debit as number), 0);
  const tc = r.entries.reduce((s, e) => s + (e.credit as number), 0);
  assert.strictEqual(td, tc);
});
test('autoJournal: devis no entries', () => {
  assert.strictEqual(autoJournalFromInvoice({ ...invoiceLike, type: 'devis' }).entries.length, 0);
});
test('autoJournal: bl no entries', () => {
  assert.strictEqual(autoJournalFromInvoice({ ...invoiceLike, type: 'bl' }).entries.length, 0);
});
test('autoJournal: bon-de-commande no entries', () => {
  assert.strictEqual(autoJournalFromInvoice({ ...invoiceLike, type: 'bon-de-commande' }).entries.length, 0);
});
test('autoJournal: all entries valid PCN + debit-xor-credit', () => {
  const r = autoJournalFromInvoice(invoiceLike);
  for (const e of r.entries) {
    assert.ok(e.accountCode in PCN_CHART);
    const d = e.debit as number, c = e.credit as number;
    assert.ok((d > 0 && c === 0) || (d === 0 && c > 0));
  }
});
test('autoJournal: entries carry reference', () => {
  const r = autoJournalFromInvoice(invoiceLike);
  for (const e of r.entries) {
    assert.strictEqual(e.reference, 'facture-2026-00042');
  }
});

// 9. G50
const g50Entries: JournalEntry[] = [
  { id: 'e1', date: '2026-03-15', label: 'Vente', accountCode: '701', debit: 0, credit: 500_000 },
  { id: 'e2', date: '2026-03-15', label: 'Achat', accountCode: '601', debit: 200_000, credit: 0 },
  { id: 'e3', date: '2026-06-10', label: 'Salaire', accountCode: '641', debit: 80_000, credit: 0 },
];
test('exportG50CSV: semicolon-delimited with rubric codes', () => {
  const s = buildG50Summary(g50Entries, 2026);
  const csv = exportG50CSV(s);
  assert.ok(csv.includes('Rubrique;Libellé;Montant (DZD)'));
  assert.ok(csv.includes('A;Chiffre d\'affaires;500000'));
  assert.ok(csv.includes('D;Achats;200000'));
});
test('exportG50HTML: printable HTML with year', () => {
  const s = buildG50Summary(g50Entries, 2026);
  const html = exportG50HTML(s, 'SARL Test', '123456789012345');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('G50'));
  assert.ok(html.includes('2026'));
  assert.ok(html.includes('SARL Test'));
  assert.ok(html.includes('@media print'));
});

// 10. G12
const g12Entries: JournalEntry[] = [
  { id: 'e1', date: '2026-03-15', label: 'TVA collectée', accountCode: '441', debit: 0, credit: 95_000 },
  { id: 'e2', date: '2026-03-20', label: 'TVA déductible', accountCode: '445', debit: 40_000, credit: 0 },
  { id: 'e3', date: '2026-03-25', label: 'Timbre fiscal (charge)', accountCode: '63', debit: 750, credit: 0 },
];
test('buildG12Summary: computes collected, deductible, net due', () => {
  const s = buildG12Summary(g12Entries, '2026-03');
  assert.strictEqual(s.collectedTVA, 95_000);
  assert.strictEqual(s.deductibleTVA, 40_000);
  assert.strictEqual(s.netTVADue, 55_000);
  assert.strictEqual(s.creditTVA, 0);
  assert.strictEqual(s.timbreCollected, 750);
});
test('buildG12Summary: credit TVA when deductible > collected', () => {
  const s = buildG12Summary([
    { id: 'e1', date: '2026-03-15', label: '', accountCode: '441', debit: 0, credit: 30_000 },
    { id: 'e2', date: '2026-03-20', label: '', accountCode: '445', debit: 50_000, credit: 0 },
  ], '2026-03');
  assert.strictEqual(s.netTVADue, 0);
  assert.strictEqual(s.creditTVA, 20_000);
});
test('buildG12Summary: TVA by rate from invoices', () => {
  const s = buildG12Summary([], '2026-03', [
    { id: 'f1', type: 'facture', date: '2026-03-15', totalHT: 100_000, totalTVA: 19_000, timbre: 0, totalTTC: 119_000, payment: 'cash', lines: [{ tvaRate: 19, lineHT: 100_000, lineTVA: 19_000 }] },
    { id: 'f2', type: 'facture', date: '2026-03-16', totalHT: 50_000, totalTVA: 4_500, timbre: 0, totalTTC: 54_500, payment: 'cash', lines: [{ tvaRate: 9, lineHT: 50_000, lineTVA: 4_500 }] },
  ] as any[]);
  assert.strictEqual(s.tvaRate19, 19_000);
  assert.strictEqual(s.tvaRate9, 4_500);
});
test('buildG12Summary: skips avoirs in TVA breakdown', () => {
  const s = buildG12Summary([], '2026-03', [
    { id: 'av1', type: 'avoir', date: '2026-03-15', totalHT: 10_000, totalTVA: 1_900, timbre: 0, totalTTC: 11_900, payment: 'cash', lines: [{ tvaRate: 19, lineHT: 10_000, lineTVA: 1_900 }] },
  ] as any[]);
  assert.strictEqual(s.tvaRate19, 0);
});
test('exportG12CSV: semicolon-delimited with TVA rubrics', () => {
  const s = buildG12Summary(g12Entries, '2026-03');
  const csv = exportG12CSV(s);
  assert.ok(csv.includes('Rubrique;Libellé;Montant (DZD)'));
  assert.ok(csv.includes('5;TVA déductible;40000'));
  assert.ok(csv.includes('6;Timbre fiscal collecté;750'));
});
test('exportG12HTML: printable HTML with period', () => {
  const s = buildG12Summary(g12Entries, '2026-03');
  const html = exportG12HTML(s, 'SARL Test', '123456789012345');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('G12'));
  assert.ok(html.includes('2026-03'));
  assert.ok(html.includes('@media print'));
});

// 11. applyValidation with new types
test('applyValidation: ticket cash carries timbre', () => {
  const draft = {
    id: 'draft-x', type: 'ticket' as InvoiceType, seq: 0, year: 2026,
    date: '2026-08-17', customer: { name: 'X' },
    lines: [{ label: 'x', qty: 1, unitHT: 50_000, tvaRate: 0, lineHT: 50_000, lineTVA: 0 }],
    totalHT: 50_000, totalTVA: 0, timbre: 0, totalTTC: 50_000, status: 'brouillon' as const, payment: 'cash' as InvoicePayment,
  };
  const optsWithScale = { tvaRate: 19, timbreRate: 1, timbreScale: [
    { upTo: 30_000, rate: 1 },
    { upTo: 100_000, rate: 1.5 },
    { upTo: null, rate: 2 },
  ] as const };
  const res = applyValidation(draft, 1, optsWithScale);
  assert.ok(res.ok);
  if (res.ok) { assert.strictEqual(res.record.timbre, 750); assert.strictEqual(res.record.status, 'valide'); }
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
