import ava, { type TestFn } from 'ava';

import {
  INVOICE_TYPES,
  INVOICE_PAYMENTS,
  computeTimbre,
  canConvert,
  buildDraftInvoice,
  buildConversion,
  orderPaymentToInvoice,
  type InvoicePayment,
  type InvoiceType,
  type InvoiceOptions,
} from '../../plugins/copilot/clickdz-erp-invoicing';

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
} from '../../plugins/copilot/clickdz-erp-accounting';

// ---------------------------------------------------------------------------
// Algeria compliance pack — pure-function regression guards.
//
// Covers: avoir/ticket/bon-de-commande document types, conversion chain,
// timbre on new types, SCF auto-journal, G50/G12 CSV+HTML exports,
// payment-method PCN mappings.
//
// Pure: no app bootstrap, no Postgres, no Redis. Runs in milliseconds.
// ---------------------------------------------------------------------------

const test = ava as TestFn;

const OPTS: InvoiceOptions = {
  tvaRate: 19,
  timbreRate: 1,
};

// ===========================================================================
// 1. INVOICE_TYPES — the six DZ fiscal document kinds
// ===========================================================================

test('INVOICE_TYPES includes avoir, ticket, bon-de-commande', t => {
  const types = INVOICE_TYPES as readonly string[];
  t.true(types.includes('avoir'));
  t.true(types.includes('ticket'));
  t.true(types.includes('bon-de-commande'));
  // Original three still present.
  t.true(types.includes('devis'));
  t.true(types.includes('bl'));
  t.true(types.includes('facture'));
  t.is(types.length, 6);
});

// ===========================================================================
// 2. Conversion chain — new types
// ===========================================================================

test('canConvert: bon-de-commande → devis (legal next step)', t => {
  t.true(canConvert('bon-de-commande', 'devis'));
});

test('canConvert: bon-de-commande can skip to bl or facture', t => {
  t.true(canConvert('bon-de-commande', 'bl'));
  t.true(canConvert('bon-de-commande', 'facture'));
});

test('canConvert: facture → avoir (reversal)', t => {
  t.true(canConvert('facture', 'avoir'));
});

test('canConvert: ticket → facture (upgrade to full invoice)', t => {
  t.true(canConvert('ticket', 'facture'));
});

test('canConvert: ticket → avoir (refund of retail sale)', t => {
  t.true(canConvert('ticket', 'avoir'));
});

test('canConvert: avoir cannot convert further (terminal)', t => {
  t.false(canConvert('avoir', 'facture'));
  t.false(canConvert('avoir', 'bl'));
  t.false(canConvert('avoir', 'devis'));
});

test('canConvert: never backwards', t => {
  t.false(canConvert('facture', 'bl'));
  t.false(canConvert('facture', 'devis'));
  t.false(canConvert('bl', 'devis'));
  t.false(canConvert('bl', 'bon-de-commande'));
});

test('canConvert: same type is never a conversion', t => {
  for (const ty of INVOICE_TYPES) {
    t.false(canConvert(ty, ty));
  }
});

// ===========================================================================
// 3. Timbre on new fiscal document types
// ===========================================================================

test('computeTimbre: ticket attracts timbre on cash (it IS a cash sale)', t => {
  t.is(computeTimbre('ticket', 'cash', 50_000), 750); // 1.5% bracket
  t.is(computeTimbre('ticket', 'cod', 10_000), 100);  // 1% bracket
});

test('computeTimbre: avoir attracts timbre on cash', t => {
  t.is(computeTimbre('avoir', 'cash', 50_000), 750);  // 1.5% bracket
});

test('computeTimbre: bon-de-commande is pre-fiscal (no timbre)', t => {
  t.is(computeTimbre('bon-de-commande', 'cash', 50_000), 0);
});

test('computeTimbre: ticket and avoir exempt on electronic payment', t => {
  for (const ep of ['chargily', 'virement', 'cheque', 'ccp', 'edahabia', 'cib'] as InvoicePayment[]) {
    t.is(computeTimbre('ticket', ep, 500_000), 0, `${ep} on ticket must be exempt`);
    t.is(computeTimbre('avoir', ep, 500_000), 0, `${ep} on avoir must be exempt`);
  }
});

// ===========================================================================
// 4. buildDraftInvoice — new types accepted
// ===========================================================================

const validInput = (type: string) => ({
  type,
  customer: { name: 'Test Client', nif: '123456789012345' },
  lines: [{ label: 'Article A', qty: 2, unitHT: 5000, tvaRate: 19 }],
  payment: 'cash',
  date: '2026-08-17',
});

test('buildDraftInvoice: avoir draft builds correctly', t => {
  const res = buildDraftInvoice(validInput('avoir'), 'draft-avoir1', OPTS);
  t.true(res.ok);
  if (res.ok) {
    t.is(res.record.type, 'avoir');
    t.is(res.record.status, 'brouillon');
    t.is(res.record.seq, 0);
    t.true(res.record.totalHT > 0);
  }
});

test('buildDraftInvoice: ticket draft builds correctly', t => {
  const res = buildDraftInvoice(validInput('ticket'), 'draft-ticket1', OPTS);
  t.true(res.ok);
  if (res.ok) {
    t.is(res.record.type, 'ticket');
    t.is(res.record.status, 'brouillon');
  }
});

test('buildDraftInvoice: bon-de-commande draft builds (no timbre)', t => {
  const res = buildDraftInvoice(validInput('bon-de-commande'), 'draft-bdc1', OPTS);
  t.true(res.ok);
  if (res.ok) {
    t.is(res.record.type, 'bon-de-commande');
    t.is(res.record.timbre, 0); // pre-fiscal, no timbre
  }
});

test('buildDraftInvoice: rejects an unknown type', t => {
  const res = buildDraftInvoice(validInput('unknown'), 'draft-x', OPTS);
  t.false(res.ok);
  if (!res.ok) t.is(res.reason, 'invalid_type');
});

// ===========================================================================
// 5. buildConversion — new conversion paths
// ===========================================================================

const validatedFacture = () => ({
  id: 'facture-2026-00001',
  type: 'facture' as InvoiceType,
  seq: 1,
  year: 2026,
  date: '2026-08-17',
  customer: { name: 'Test Client' },
  lines: [{ label: 'Article A', qty: 1, unitHT: 50_000, tvaRate: 19, lineHT: 50_000, lineTVA: 9_500 }],
  totalHT: 50_000,
  totalTVA: 9_500,
  timbre: 750,
  totalTTC: 60_250,
  status: 'valide' as const,
  payment: 'cash' as InvoicePayment,
});

test('buildConversion: facture → avoir produces an avoir draft', t => {
  const res = buildConversion(validatedFacture(), 'avoir', 'draft-av1', OPTS);
  t.true(res.ok);
  if (res.ok) {
    t.is(res.record.type, 'avoir');
    t.is(res.record.status, 'brouillon');
    t.is(res.record.convertedFrom, 'facture-2026-00001');
  }
});

test('buildConversion: bon-de-commande → devis produces a devis draft', t => {
  const bdc = {
    ...validatedFacture(),
    id: 'bon-de-commande-2026-00001',
    type: 'bon-de-commande' as InvoiceType,
    status: 'valide' as const,
  };
  const res = buildConversion(bdc, 'devis', 'draft-dv1', OPTS);
  t.true(res.ok);
  if (res.ok) {
    t.is(res.record.type, 'devis');
    t.is(res.record.convertedFrom, 'bon-de-commande-2026-00001');
  }
});

// ===========================================================================
// 6. orderPaymentToInvoice — new payment method mappings
// ===========================================================================

test('orderPaymentToInvoice: cheque maps to cheque', t => {
  t.is(orderPaymentToInvoice({ paymentMethod: 'cheque' }), 'cheque');
  t.is(orderPaymentToInvoice({ paymentMethod: 'chèque bancaire' }), 'cheque');
});

test('orderPaymentToInvoice: ccp maps to ccp', t => {
  t.is(orderPaymentToInvoice({ paymentMethod: 'ccp' }), 'ccp');
  t.is(orderPaymentToInvoice({ paymentMethod: 'mandat poste' }), 'ccp');
});

// ===========================================================================
// 7. Payment method → PCN account mapping
// ===========================================================================

test('paymentMethodToPCN: cash → 531 (caisse principale)', t => {
  t.is(paymentMethodToPCN('cash'), '531');
});

test('paymentMethodToPCN: cod → 532 (caisse COD)', t => {
  t.is(paymentMethodToPCN('cod'), '532');
});

test('paymentMethodToPCN: cheque → 512 (banque)', t => {
  t.is(paymentMethodToPCN('cheque'), '512');
});

test('paymentMethodToPCN: ccp → 514 (banque e-commerce/poste)', t => {
  t.is(paymentMethodToPCN('ccp'), '514');
});

test('paymentMethodToPCN: edahabia → 514 (e-commerce SATIM)', t => {
  t.is(paymentMethodToPCN('edahabia'), '514');
});

test('paymentMethodToPCN: cib → 514 (e-commerce SATIM)', t => {
  t.is(paymentMethodToPCN('cib'), '514');
});

test('paymentMethodToPCN: chargily → 514 (e-commerce gateway)', t => {
  t.is(paymentMethodToPCN('chargily'), '514');
});

test('paymentMethodToPCN: virement → 512 (banque)', t => {
  t.is(paymentMethodToPCN('virement'), '512');
});

test('paymentMethodToPCN: unknown/credit → 411 (clients)', t => {
  t.is(paymentMethodToPCN(''), '411');
  t.is(paymentMethodToPCN('credit'), '411');
  t.is(paymentMethodToPCN('unknown'), '411');
});

test('paymentMethodToPCN: all returned codes exist in PCN_CHART', t => {
  for (const method of INVOICE_PAYMENTS) {
    const code = paymentMethodToPCN(method);
    t.true(code in PCN_CHART, `${method} → ${code} must be a valid PCN account`);
  }
});

test('paymentMethodLabel: returns a non-empty French label for each method', t => {
  for (const method of INVOICE_PAYMENTS) {
    const label = paymentMethodLabel(method);
    t.true(label.length > 0, `${method} must have a label`);
  }
});

// ===========================================================================
// 8. SCF auto-journal — double-entry generation
// ===========================================================================

const invoiceLike = {
  id: 'facture-2026-00042',
  type: 'facture',
  date: '2026-08-17',
  totalHT: 100_000,
  totalTVA: 19_000,
  timbre: 0,
  totalTTC: 119_000,
  payment: 'cash',
  customer: { name: 'SARL Test' },
  lines: [{ tvaRate: 19, lineHT: 100_000, lineTVA: 19_000 }],
};

test('autoJournalFromInvoice: facture cash produces balanced entries', t => {
  const result = autoJournalFromInvoice(invoiceLike);
  t.is(result.entries.length, 3); // debit caisse, credit ventes, credit TVA
  // Verify balance: sum debits === sum credits
  const totalDebit = result.entries.reduce((s, e) => s + (e.debit as number), 0);
  const totalCredit = result.entries.reduce((s, e) => s + (e.credit as number), 0);
  t.is(totalDebit, 119_000);
  t.is(totalCredit, 119_000);
});

test('autoJournalFromInvoice: debit goes to caisse 531 for cash payment', t => {
  const result = autoJournalFromInvoice(invoiceLike);
  const debitEntry = result.entries.find(e => (e.debit as number) > 0);
  t.truthy(debitEntry);
  t.is(debitEntry!.accountCode, '531');
  t.is(debitEntry!.debit, 119_000);
});

test('autoJournalFromInvoice: cheque payment debits 512 (banque)', t => {
  const inv = { ...invoiceLike, payment: 'cheque' };
  const result = autoJournalFromInvoice(inv);
  const debitEntry = result.entries.find(e => (e.debit as number) > 0);
  t.is(debitEntry!.accountCode, '512');
});

test('autoJournalFromInvoice: edahabia payment debits 514 (e-commerce)', t => {
  const inv = { ...invoiceLike, payment: 'edahabia' };
  const result = autoJournalFromInvoice(inv);
  const debitEntry = result.entries.find(e => (e.debit as number) > 0);
  t.is(debitEntry!.accountCode, '514');
});

test('autoJournalFromInvoice: CCP payment debits 514', t => {
  const inv = { ...invoiceLike, payment: 'ccp' };
  const result = autoJournalFromInvoice(inv);
  const debitEntry = result.entries.find(e => (e.debit as number) > 0);
  t.is(debitEntry!.accountCode, '514');
});

test('autoJournalFromInvoice: CIB payment debits 514', t => {
  const inv = { ...invoiceLike, payment: 'cib' };
  const result = autoJournalFromInvoice(inv);
  const debitEntry = result.entries.find(e => (e.debit as number) > 0);
  t.is(debitEntry!.accountCode, '514');
});

test('autoJournalFromInvoice: timbre produces two extra entries (63 debit + caisse credit)', t => {
  const inv = { ...invoiceLike, timbre: 1_500, totalTTC: 120_500 };
  const result = autoJournalFromInvoice(inv);
  // 3 sale entries + 2 timbre entries = 5
  t.is(result.entries.length, 5);
  const timbreDebit = result.entries.find(
    e => e.accountCode === '63' && (e.debit as number) > 0
  );
  t.truthy(timbreDebit);
  t.is(timbreDebit!.debit, 1_500);
  const timbreCredit = result.entries.find(
    e => e.accountCode === '531' && (e.credit as number) === 1_500
  );
  t.truthy(timbreCredit);
});

test('autoJournalFromInvoice: avoir reverses the sale (debit revenue, credit settlement)', t => {
  const avoir = {
    ...invoiceLike,
    id: 'avoir-2026-00001',
    type: 'avoir',
    payment: 'cash',
  };
  const result = autoJournalFromInvoice(avoir);
  // Revenue is DEBITED (reversal), settlement is CREDITED
  const revenueEntry = result.entries.find(e => e.accountCode === '701');
  t.truthy(revenueEntry);
  t.is(revenueEntry!.debit, 100_000); // reversed
  t.is(revenueEntry!.credit, 0);
  const settlementEntry = result.entries.find(e => e.accountCode === '531');
  t.truthy(settlementEntry);
  t.is(settlementEntry!.credit, 119_000); // credited back
  t.is(settlementEntry!.debit, 0);
  // Balanced
  const totalDebit = result.entries.reduce((s, e) => s + (e.debit as number), 0);
  const totalCredit = result.entries.reduce((s, e) => s + (e.credit as number), 0);
  t.is(totalDebit, totalCredit);
});

test('autoJournalFromInvoice: ticket produces sale entries (same as facture)', t => {
  const ticket = { ...invoiceLike, id: 'ticket-2026-00001', type: 'ticket' };
  const result = autoJournalFromInvoice(ticket);
  t.true(result.entries.length >= 3);
  const totalDebit = result.entries.reduce((s, e) => s + (e.debit as number), 0);
  const totalCredit = result.entries.reduce((s, e) => s + (e.credit as number), 0);
  t.is(totalDebit, totalCredit);
});

test('autoJournalFromInvoice: devis produces NO entries (pre-fiscal)', t => {
  const devis = { ...invoiceLike, id: 'devis-2026-00001', type: 'devis' };
  const result = autoJournalFromInvoice(devis);
  t.is(result.entries.length, 0);
});

test('autoJournalFromInvoice: bl produces NO entries (pre-fiscal)', t => {
  const bl = { ...invoiceLike, id: 'bl-2026-00001', type: 'bl' };
  const result = autoJournalFromInvoice(bl);
  t.is(result.entries.length, 0);
});

test('autoJournalFromInvoice: bon-de-commande produces NO entries (pre-fiscal)', t => {
  const bdc = { ...invoiceLike, id: 'bon-de-commande-2026-00001', type: 'bon-de-commande' };
  const result = autoJournalFromInvoice(bdc);
  t.is(result.entries.length, 0);
});

test('autoJournalFromInvoice: every entry has a valid PCN accountCode', t => {
  const result = autoJournalFromInvoice(invoiceLike);
  for (const entry of result.entries) {
    t.true(
      str(entry.accountCode) in PCN_CHART,
      `${entry.accountCode} must be a valid PCN account`
    );
  }
});

test('autoJournalFromInvoice: every entry is debit-xor-credit', t => {
  const result = autoJournalFromInvoice(invoiceLike);
  for (const entry of result.entries) {
    const d = entry.debit as number;
    const c = entry.credit as number;
    t.true((d > 0 && c === 0) || (d === 0 && c > 0), 'must be debit XOR credit');
  }
});

test('autoJournalFromInvoice: all entries carry the invoice reference', t => {
  const result = autoJournalFromInvoice(invoiceLike);
  for (const entry of result.entries) {
    t.is(entry.reference, 'facture-2026-00042');
    t.is(entry.pieceRef, 'facture-2026-00042');
  }
});

// ===========================================================================
// 9. G50 CSV export
// ===========================================================================

const g50Entries: JournalEntry[] = [
  { id: 'e1', date: '2026-03-15', label: 'Vente', accountCode: '701', debit: 0, credit: 500_000 },
  { id: 'e2', date: '2026-03-15', label: 'Achat', accountCode: '601', debit: 200_000, credit: 0 },
  { id: 'e3', date: '2026-06-10', label: 'Salaire', accountCode: '641', debit: 80_000, credit: 0 },
];

test('exportG50CSV: produces semicolon-delimited CSV with rubric codes', t => {
  const summary = buildG50Summary(g50Entries, 2026);
  const csv = exportG50CSV(summary);
  t.true(csv.includes('Rubrique;Libellé;Montant (DZD)'));
  t.true(csv.includes('A;Chiffre d\'affaires;500000'));
  t.true(csv.includes('D;Achats;200000'));
  t.true(csv.includes('F;Charges de personnel (salaires);80000'));
  t.true(csv.includes('M;IRG dû;'));
});

test('exportG50HTML: produces a printable HTML document with the fiscal year', t => {
  const summary = buildG50Summary(g50Entries, 2026);
  const html = exportG50HTML(summary, 'SARL Test', '123456789012345');
  t.true(html.includes('<!DOCTYPE html>'));
  t.true(html.includes('G50'));
  t.true(html.includes('2026'));
  t.true(html.includes('SARL Test'));
  t.true(html.includes('123456789012345'));
  t.true(html.includes('@media print'));
});

// ===========================================================================
// 10. G12 CSV + HTML export
// ===========================================================================

const g12Entries: JournalEntry[] = [
  { id: 'e1', date: '2026-03-15', label: 'TVA collectée', accountCode: '441', debit: 0, credit: 95_000 },
  { id: 'e2', date: '2026-03-20', label: 'TVA déductible', accountCode: '445', debit: 40_000, credit: 0 },
  { id: 'e3', date: '2026-03-25', label: 'Timbre fiscal (charge)', accountCode: '63', debit: 750, credit: 0 },
];

test('buildG12Summary: computes collected, deductible, net due, and credit', t => {
  const summary = buildG12Summary(g12Entries, '2026-03');
  t.is(summary.period, '2026-03');
  t.is(summary.collectedTVA, 95_000);
  t.is(summary.deductibleTVA, 40_000);
  t.is(summary.netTVADue, 55_000); // 95k - 40k
  t.is(summary.creditTVA, 0);
  t.is(summary.timbreCollected, 750);
});

test('buildG12Summary: credit TVA when deductible > collected', t => {
  const entries: JournalEntry[] = [
    { id: 'e1', date: '2026-03-15', label: 'TVA collectée', accountCode: '441', debit: 0, credit: 30_000 },
    { id: 'e2', date: '2026-03-20', label: 'TVA déductible', accountCode: '445', debit: 50_000, credit: 0 },
  ];
  const summary = buildG12Summary(entries, '2026-03');
  t.is(summary.netTVADue, 0);
  t.is(summary.creditTVA, 20_000);
});

test('buildG12Summary: with invoices, breaks down TVA by rate', t => {
  const entries: JournalEntry[] = [
    { id: 'e1', date: '2026-03-15', label: 'TVA collectée', accountCode: '441', debit: 0, credit: 28_500 },
  ];
  const invoices = [
    {
      id: 'f1', type: 'facture', date: '2026-03-15',
      totalHT: 100_000, totalTVA: 19_000, timbre: 0, totalTTC: 119_000,
      payment: 'cash',
      lines: [{ tvaRate: 19, lineHT: 100_000, lineTVA: 19_000 }],
    },
    {
      id: 'f2', type: 'facture', date: '2026-03-16',
      totalHT: 50_000, totalTVA: 4_500, timbre: 0, totalTTC: 54_500,
      payment: 'cash',
      lines: [{ tvaRate: 9, lineHT: 50_000, lineTVA: 4_500 }],
    },
  ];
  const summary = buildG12Summary(entries, '2026-03', invoices as any[]);
  t.is(summary.tvaRate19, 19_000);
  t.is(summary.tvaRate9, 4_500);
  t.is(summary.tvaRate0, 0);
});

test('buildG12Summary: skips avoirs in the TVA-by-rate breakdown', t => {
  const invoices = [
    {
      id: 'av1', type: 'avoir', date: '2026-03-15',
      totalHT: 10_000, totalTVA: 1_900, timbre: 0, totalTTC: 11_900,
      payment: 'cash',
      lines: [{ tvaRate: 19, lineHT: 10_000, lineTVA: 1_900 }],
    },
  ];
  const summary = buildG12Summary([], '2026-03', invoices as any[]);
  t.is(summary.tvaRate19, 0); // avoir reversed, not counted
});

test('exportG12CSV: produces semicolon-delimited CSV with TVA rubrics', t => {
  const summary = buildG12Summary(g12Entries, '2026-03');
  const csv = exportG12CSV(summary);
  t.true(csv.includes('Rubrique;Libellé;Montant (DZD)'));
  t.true(csv.includes('4;Total TVA collectée'));
  t.true(csv.includes('5;TVA déductible;40000'));
  t.true(csv.includes('7;TVA à décaisser'));
  t.true(csv.includes('6;Timbre fiscal collecté;750'));
});

test('exportG12HTML: produces a printable HTML document with the period', t => {
  const summary = buildG12Summary(g12Entries, '2026-03');
  const html = exportG12HTML(summary, 'SARL Test', '123456789012345');
  t.true(html.includes('<!DOCTYPE html>'));
  t.true(html.includes('G12'));
  t.true(html.includes('2026-03'));
  t.true(html.includes('SARL Test'));
  t.true(html.includes('@media print'));
});

// ===========================================================================
// Helper: str for test assertions
// ===========================================================================
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
