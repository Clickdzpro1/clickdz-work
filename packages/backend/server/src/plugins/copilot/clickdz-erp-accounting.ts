// ---------------------------------------------------------------------------
// WS-ERP-ACCOUNTING — Plan Comptable National Algérien (PCN DZ) +
// Grand Livre + Journal + Balance + États Financiers.
//
// Framework-free helper (same contract as clickdz-erp-caisse.ts):
// ZERO imports, ZERO framework deps — pure money math. The bridge owns
// all data-layer I/O; this file owns ONLY the accounting logic.
//
// Money: INTEGER DZD (Math.round), zero float drift. All accounts follow
// PCN DZ classification (Classes 1-7) mapped to the SCF (Système Comptable
// Financier) framework effective 2010.
//
// Partition model: `compta-entries-YYYYMM` — one Redis hash per month
// for accounting journal entries, same pattern as caisse and movements.
// Each entry is a schemaless record with:
//   { id, date, label, accountCode, debit, credit, reference, pieceRef, partnerId? }
//
// DZ fiscal year: January 1 → December 31 (Government Fiscal Year).
// TVA rate: 19% standard, 9% reduced (construction, electricity, gas).
// IRG (Impôt sur le Revenu Global): progressive scale, monthly withholding.
// TAP (Taxe sur l'Activité Professionnelle): 2% of turnover.
// IBS (Impôt sur les Bénéfices des Sociétés): 19/23/26% depending on sector.
// ---------------------------------------------------------------------------

export type JournalEntry = Record<string, unknown>;

// ---------------------------------------------------------------------------
// PCN DZ — Plan Comptable National standardisé (comptes principaux)
// ---------------------------------------------------------------------------

/**
 * PCN DZ Chart of Accounts — Classes 1 through 7.
 * Each account has: code (String), label (French/Arabic), class (1-7),
 * and a debitSign ('debit' means normal balance is debit; 'credit' for credit).
 */
export const PCN_CHART = {
  // ---- CLASSE 1 : CAPITAUX PERMANENTS ----
  10:  { code: '10',  label: 'Capital / Fonds propres (Capital, dotations, réserves)', class: 1, sign: 'credit' as const },
  101: { code: '101', label: 'Capital social (Capital libéré/actions)', class: 1, sign: 'credit' as const },
  102: { code: '102', label: 'Capital indivis / EURL (Capital affecté à l\'activité)', class: 1, sign: 'credit' as const },
  106: { code: '106', label: 'Réserves (légales, statutaires, facultatives)', class: 1, sign: 'credit' as const },
  11:  { code: '11',  label: 'Report à nouveau (bénéfices non distribués)', class: 1, sign: 'credit' as const },
  12:  { code: '12',  label: 'Résultat de l\'exercice (bénéfice ou perte)', class: 1, sign: 'credit' as const },
  13:  { code: '13',  label: 'Subventions d\'investissement', class: 1, sign: 'credit' as const },
  15:  { code: '15',  label: 'Provisions pour charges (risques, litiges)', class: 1, sign: 'credit' as const },
  16:  { code: '16',  label: 'Emprunts & dettes assimilées (long terme)', class: 1, sign: 'credit' as const },
  164: { code: '164', label: 'Emprunts bancaires (crédits d\'investissement)', class: 1, sign: 'credit' as const },
  165: { code: '165', label: 'Dettes de leasing (location-financement)', class: 1, sign: 'credit' as const },

  // ---- CLASSE 2 : IMMOBILISATIONS ----
  20:  { code: '20',  label: 'Immobilisations incorporelles (fonds commercial, brevets, licences, logiciels)', class: 2, sign: 'debit' as const },
  21:  { code: '21',  label: 'Immobilisations corporelles (terrains, constructions, installations)', class: 2, sign: 'debit' as const },
  218: { code: '218', label: 'Matériel de transport (véhicules de livraison, flotte)', class: 2, sign: 'debit' as const },
  2183:{ code: '2183',label: 'Matériel informatique & bureau (PC, imprimantes, serveurs)', class: 2, sign: 'debit' as const },
  22:  { code: '22',  label: 'Immobilisations mises en concession', class: 2, sign: 'debit' as const },
  28:  { code: '28',  label: 'Amortissements des immobilisations', class: 2, sign: 'credit' as const },
  29:  { code: '29',  label: 'Provisions pour dépréciation des immobilisations', class: 2, sign: 'credit' as const },

  // ---- CLASSE 3 : STOCKS & EN-COURS ----
  30:  { code: '30',  label: 'Marchandises (stocks de revente, stock commerçant)', class: 3, sign: 'debit' as const },
  31:  { code: '31',  label: 'Matières premières & fournitures', class: 3, sign: 'debit' as const },
  32:  { code: '32',  label: 'Autres approvisionnements (emballages, consommables)', class: 3, sign: 'debit' as const },
  35:  { code: '35',  label: 'Produits finis (stock de production propre)', class: 3, sign: 'debit' as const },
  39:  { code: '39',  label: 'Provisions pour dépréciation des stocks', class: 3, sign: 'credit' as const },

  // ---- CLASSE 4 : COMPTES DE TIERS (créances & dettes) ----
  40:  { code: '40',  label: 'Fournisseurs & comptes rattachés (dettes d\'exploitation)', class: 4, sign: 'credit' as const },
  401: { code: '401', label: 'Fournisseurs — Achats de biens & services', class: 4, sign: 'credit' as const },
  404: { code: '404', label: 'Fournisseurs — Immobilisations', class: 4, sign: 'credit' as const },
  41:  { code: '41',  label: 'Clients & comptes rattachés (créances commerciales)', class: 4, sign: 'debit' as const },
  411: { code: '411', label: 'Clients — Ventes de biens & services', class: 4, sign: 'debit' as const },
  416: { code: '416', label: 'Clients douteux / litigieux (créances compromises)', class: 4, sign: 'debit' as const },
  42:  { code: '42',  label: 'Personnel & comptes rattachés (salaires, charges sociales)', class: 4, sign: 'credit' as const },
  421: { code: '421', label: 'Rémunérations dues au personnel (salaires nets à payer)', class: 4, sign: 'credit' as const },
  43:  { code: '43',  label: 'Sécurité sociale & organismes sociaux (CNAS, CASNOS, CACOBATPH)', class: 4, sign: 'credit' as const },
  431: { code: '431', label: 'CNAS — Cotisations patronales & salariales (sécurité sociale DZ)', class: 4, sign: 'credit' as const },
  432: { code: '432', label: 'CASNOS — Cotisations non-salariés (commerçants, artisans)', class: 4, sign: 'credit' as const },
  44:  { code: '44',  label: 'État — Impôts & taxes (collectivités publiques)', class: 4, sign: 'credit' as const },
  441: { code: '441', label: 'TVA à décaisser (TVA collectée - TVA déductible)', class: 4, sign: 'credit' as const },
  442: { code: '442', label: 'IRG / Retenues à la source (salarial + professionnel)', class: 4, sign: 'credit' as const },
  443: { code: '443', label: 'TAP (Taxe sur l\'Activité Professionnelle) à payer', class: 4, sign: 'credit' as const },
  444: { code: '444', label: 'IBS (Impôt sur les Bénéfices des Sociétés) à payer', class: 4, sign: 'credit' as const },
  445: { code: '445', label: 'TVA récupérable / déductible (crédit de TVA)', class: 4, sign: 'debit' as const },
  446: { code: '446', label: 'Droits de douane & taxes assimilées', class: 4, sign: 'credit' as const },
  45:  { code: '45',  label: 'Associés & groupe (comptes courants, dividendes)', class: 4, sign: 'credit' as const },
  46:  { code: '46',  label: 'Débiteurs & créditeurs divers (acomptes, avances, dépôts)', class: 4, sign: 'debit' as const },
  47:  { code: '47',  label: 'Comptes de régularisation (charges/produits constatés d\'avance)', class: 4, sign: 'debit' as const },

  // ---- CLASSE 5 : FINANCIERS (trésorerie) ----
  50:  { code: '50',  label: 'Valeurs mobilières de placement', class: 5, sign: 'debit' as const },
  51:  { code: '51',  label: 'Banques & établissements financiers', class: 5, sign: 'debit' as const },
  512: { code: '512', label: 'Banque — Compte courant principal (BNA/CPA/BADR/BEA/BNP)', class: 5, sign: 'debit' as const },
  514: { code: '514', label: 'Banque — Compte E-commerce (Chargily/SATIM/CIB)', class: 5, sign: 'debit' as const },
  53:  { code: '53',  label: 'Caisse (espèces, fonds de caisse)', class: 5, sign: 'debit' as const },
  531: { code: '531', label: 'Caisse principale (commerce physique, boutique, dépôt)', class: 5, sign: 'debit' as const },
  532: { code: '532', label: 'Caisse COD (contre-remboursement, livreurs)', class: 5, sign: 'debit' as const },
  58:  { code: '58',  label: 'Virements internes (compensation inter-banques, transferts)', class: 5, sign: 'debit' as const },
  59:  { code: '59',  label: 'Provisions pour dépréciation des comptes financiers', class: 5, sign: 'credit' as const },

  // ---- CLASSE 6 : CHARGES (comptes de gestion) ----
  60:  { code: '60',  label: 'Achats consommés (marchandises, matières, emballages)', class: 6, sign: 'debit' as const },
  601: { code: '601', label: 'Achats de marchandises (revente en l\'état)', class: 6, sign: 'debit' as const },
  602: { code: '602', label: 'Achats de matières premières & fournitures', class: 6, sign: 'debit' as const },
  604: { code: '604', label: 'Achats d\'études & prestations de services', class: 6, sign: 'debit' as const },
  61:  { code: '61',  label: 'Services extérieurs (sous-traitance, transport, logistique)', class: 6, sign: 'debit' as const },
  613: { code: '613', label: 'Livraison & transport sur ventes (frais d\'expédition, coursier)', class: 6, sign: 'debit' as const },
  616: { code: '616', label: 'Frais de télécom & internet (ADSL, 4G, fibre, SMS pro)', class: 6, sign: 'debit' as const },
  62:  { code: '62',  label: 'Autres services extérieurs (loyer, électricité, assurance)', class: 6, sign: 'debit' as const },
  622: { code: '622', label: 'Loyer & charges locatives (local commercial, dépôt)', class: 6, sign: 'debit' as const },
  626: { code: '626', label: 'Assurances (RC pro, multirisque, flotte véhicules)', class: 6, sign: 'debit' as const },
  628: { code: '628', label: 'Frais bancaires & commissions (tenue de compte, TPE, virement)', class: 6, sign: 'debit' as const },
  63:  { code: '63',  label: 'Impôts & taxes (TAP, vignette auto, taxes foncières, timbres)', class: 6, sign: 'debit' as const },
  64:  { code: '64',  label: 'Charges de personnel (salaires, cotisations sociales)', class: 6, sign: 'debit' as const },
  641: { code: '641', label: 'Salaires bruts (rémunérations, primes, indemnités)', class: 6, sign: 'debit' as const },
  645: { code: '645', label: 'Cotisations patronales CNAS/CASNOS/CACOBATPH', class: 6, sign: 'debit' as const },
  65:  { code: '65',  label: 'Autres charges de gestion courante', class: 6, sign: 'debit' as const },
  66:  { code: '66',  label: 'Charges financières (intérêts bancaires, agios, découverts)', class: 6, sign: 'debit' as const },
  68:  { code: '68',  label: 'Dotations aux amortissements & provisions', class: 6, sign: 'debit' as const },
  681: { code: '681', label: 'Dotations aux amortissements (linéaire, dégressif)', class: 6, sign: 'debit' as const },
  69:  { code: '69',  label: 'Impôts sur les bénéfices (IBS, acomptes provisionnels)', class: 6, sign: 'debit' as const },

  // ---- CLASSE 7 : PRODUITS (comptes de gestion) ----
  70:  { code: '70',  label: 'Ventes de marchandises & produits finis', class: 7, sign: 'credit' as const },
  701: { code: '701', label: 'Ventes de marchandises (commerce de détail/gros, e-commerce)', class: 7, sign: 'credit' as const },
  702: { code: '702', label: 'Ventes de produits finis (fabrication propre)', class: 7, sign: 'credit' as const },
  704: { code: '704', label: 'Ventes de prestations de services', class: 7, sign: 'credit' as const },
  706: { code: '706', label: 'Revenus de livraison / frais de port facturés', class: 7, sign: 'credit' as const },
  71:  { code: '71',  label: 'Production stockée / immobilisée', class: 7, sign: 'credit' as const },
  74:  { code: '74',  label: 'Subventions d\'exploitation (ANSEJ, CNAC, ANDI, ANDPME)', class: 7, sign: 'credit' as const },
  75:  { code: '75',  label: 'Autres produits de gestion courante', class: 7, sign: 'credit' as const },
  76:  { code: '76',  label: 'Produits financiers (intérêts perçus, dividendes, gains de change)', class: 7, sign: 'credit' as const },
  78:  { code: '78',  label: 'Reprises sur amortissements & provisions', class: 7, sign: 'credit' as const },
} as const;

export type AccountCode = keyof typeof PCN_CHART;

// ---------------------------------------------------------------------------
// Small shared coercers (identical to caisse pattern — framework-free)
// ---------------------------------------------------------------------------

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function str(v: unknown): string { return typeof v === 'string' ? v : v == null ? '' : String(v); }
function int(v: unknown): number { return Math.round(num(v)); }

// ---------------------------------------------------------------------------
// Journal Entry CRUD
// ---------------------------------------------------------------------------

/** Collection name for a month partition: `compta-entries-YYYYMM`. */
export function entriesCollectionFor(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `compta-entries-${y}${m}`;
}

export function entriesCollectionForDate(dateISO: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(str(dateISO));
  return m ? `compta-entries-${m[1]}${m[2]}` : entriesCollectionFor();
}

/** Validate a single journal entry. Returns an error string or null. */
export function validateJournalEntry(entry: JournalEntry): string | null {
  const code = str(entry.accountCode);
  const label = str(entry.label);
  const debit = int(entry.debit);
  const credit = int(entry.credit);
  const date = str(entry.date);

  if (!date || date.length < 10) return 'Date is required (YYYY-MM-DD)';
  if (!label || label.length < 2) return 'Label is required (min 2 chars)';
  if (!code) return 'Account code is required';
  if (!(code in PCN_CHART)) return `Unknown PCN account code: ${code}`;
  if (debit < 0 || credit < 0) return 'Amounts must be non-negative';
  if (debit === 0 && credit === 0) return 'Debit or credit must be > 0';
  if (debit > 0 && credit > 0) return 'Entry cannot have both debit and credit';
  if (debit > 1_000_000_000 || credit > 1_000_000_000) return 'Amount exceeds maximum (1bn DZD)';
  return null;
}

// ---------------------------------------------------------------------------
// Grand Livre (General Ledger)
// ---------------------------------------------------------------------------

export interface LedgerLine {
  date: string;
  entryId: string;
  label: string;
  reference: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface AccountLedger {
  accountCode: string;
  accountLabel: string;
  accountClass: number;
  entries: LedgerLine[];
  totalDebit: number;
  totalCredit: number;
  balance: number;
}

/** Build General Ledger for ONE account from raw journal entries. */
export function buildAccountLedger(
  entries: JournalEntry[],
  accountCode: string,
  openingBalance: number = 0
): AccountLedger | null {
  const account = PCN_CHART[accountCode as AccountCode];
  if (!account) return null;

  const filtered = entries
    .filter(e => str(e.accountCode) === accountCode)
    .sort((a, b) => str(a.date).localeCompare(str(b.date)) || str(a.id).localeCompare(str(b.id)));

  let runningBalance = openingBalance;
  const lines: LedgerLine[] = [];

  for (const e of filtered) {
    const debit = int(e.debit);
    const credit = int(e.credit);
    runningBalance = account.sign === 'debit'
      ? runningBalance + debit - credit
      : runningBalance + credit - debit;

    lines.push({
      date: str(e.date).slice(0, 10),
      entryId: str(e.id),
      label: str(e.label),
      reference: str(e.reference || e.pieceRef || ''),
      debit,
      credit,
      balance: runningBalance,
    });
  }

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);

  return {
    accountCode,
    accountLabel: account.label,
    accountClass: account.class,
    entries: lines,
    totalDebit,
    totalCredit,
    balance: runningBalance,
  };
}

// ---------------------------------------------------------------------------
// Balance Générale (Trial Balance)
// ---------------------------------------------------------------------------

export interface TrialBalanceLine {
  accountCode: string;
  accountLabel: string;
  accountClass: number;
  openingDebit: number;
  openingCredit: number;
  movementsDebit: number;
  movementsCredit: number;
  closingDebit: number;
  closingCredit: number;
}

/**
 * Build Trial Balance from journal entries for a date range.
 * Ordered by account class (1-7), then account code.
 */
export function buildTrialBalance(
  entries: JournalEntry[],
  from: string,
  to: string
): TrialBalanceLine[] {
  const map = new Map<string, TrialBalanceLine>();

  // Initialize all PCN accounts
  for (const [code, acct] of Object.entries(PCN_CHART)) {
    map.set(code, {
      accountCode: code,
      accountLabel: acct.label,
      accountClass: acct.class,
      openingDebit: 0,
      openingCredit: 0,
      movementsDebit: 0,
      movementsCredit: 0,
      closingDebit: 0,
      closingCredit: 0,
    });
  }

  // Accumulate movements
  for (const e of entries) {
    const code = str(e.accountCode);
    const line = map.get(code);
    if (!line) continue;
    const date = str(e.date);
    if (date < from || date > to) continue;
    line.movementsDebit += int(e.debit);
    line.movementsCredit += int(e.credit);
  }

  // Calculate closing balances
  const result: TrialBalanceLine[] = [];
  for (const [code, line] of map) {
    const acct = PCN_CHART[code as AccountCode]!;
    const balance = acct.sign === 'debit'
      ? line.openingDebit - line.openingCredit + line.movementsDebit - line.movementsCredit
      : line.openingCredit - line.openingDebit + line.movementsCredit - line.movementsDebit;

    if (balance >= 0) {
      line.closingDebit = balance;
      line.closingCredit = 0;
    } else {
      line.closingDebit = 0;
      line.closingCredit = Math.abs(balance);
    }

    result.push(line);
  }

  return result.sort((a, b) => a.accountClass - b.accountClass || a.accountCode.localeCompare(b.accountCode));
}

// ---------------------------------------------------------------------------
// Compte de Résultat (P&L / Income Statement)
// ---------------------------------------------------------------------------

export interface PLSection {
  label: string;
  lines: { label: string; amount: number }[];
  total: number;
}

export interface IncomeStatement {
  fiscalYear: string;
  revenue: PLSection;
  costOfSales: PLSection;
  grossMargin: number;
  operatingExpenses: PLSection;
  operatingResult: number;
  financialResult: number;
  netBeforeTax: number;
  incomeTax: number;
  netIncome: number;
}

/** Build a DZ-format Income Statement (SCF model). */
export function buildIncomeStatement(entries: JournalEntry[], year: number): IncomeStatement {
  const y = String(year);
  const filtered = entries.filter(e => str(e.date).startsWith(y));

  function sumAccounts(...codes: string[]): number {
    let total = 0;
    for (const e of filtered) {
      if (codes.includes(str(e.accountCode))) {
        total += int(e.credit) - int(e.debit); // Revenue accounts are credit-natured
      }
    }
    return total;
  }

  function sumExpenseAccounts(...codes: string[]): number {
    let total = 0;
    for (const e of filtered) {
      if (codes.includes(str(e.accountCode))) {
        total += int(e.debit); // Expense accounts are debit-natured
      }
    }
    return total;
  }

  const revenue = {
    label: 'Chiffre d\'affaires',
    lines: [
      { label: 'Ventes de marchandises (701)', amount: sumAccounts('701') },
      { label: 'Ventes de produits finis (702)', amount: sumAccounts('702') },
      { label: 'Prestations de services (704)', amount: sumAccounts('704') },
      { label: 'Livraison facturée (706)', amount: sumAccounts('706') },
    ],
    total: 0,
  };
  revenue.total = revenue.lines.reduce((s, l) => s + l.amount, 0);

  // Align cost of sales: Class 6 accounts but specifically the direct cost ones
  const costOfSales = {
    label: 'Coût des ventes',
    lines: [
      { label: 'Achats de marchandises (601)', amount: sumExpenseAccounts('601') },
      { label: 'Matières premières (602)', amount: sumExpenseAccounts('602') },
      { label: 'Livraison & transport (613)', amount: sumExpenseAccounts('613') },
    ],
    total: 0,
  };
  costOfSales.total = costOfSales.lines.reduce((s, l) => s + l.amount, 0);

  const grossMargin = revenue.total - costOfSales.total;

  const operatingExpenses = {
    label: 'Charges d\'exploitation',
    lines: [
      { label: 'Services extérieurs (61-601-602-604)', amount: sumExpenseAccounts('61') },
      { label: 'Loyer & charges (622)', amount: sumExpenseAccounts('622') },
      { label: 'Assurances (626)', amount: sumExpenseAccounts('626') },
      { label: 'Télécom & internet (616)', amount: sumExpenseAccounts('616') },
      { label: 'Frais bancaires (628)', amount: sumExpenseAccounts('628') },
      { label: 'Salaires bruts (641)', amount: sumExpenseAccounts('641') },
      { label: 'Cotisations sociales (645)', amount: sumExpenseAccounts('645') },
      { label: 'Impôts & taxes (63)', amount: sumExpenseAccounts('63') },
      { label: 'Dotations amortissements (681)', amount: sumExpenseAccounts('681') },
      { label: 'Autres services (62)', amount: sumExpenseAccounts('62') },
      { label: 'Autres charges (65)', amount: sumExpenseAccounts('65') },
    ],
    total: 0,
  };
  operatingExpenses.total = operatingExpenses.lines.reduce((s, l) => s + l.amount, 0);

  const operatingResult = grossMargin - operatingExpenses.total;

  const financialIncome = sumAccounts('76');
  const financialExpense = sumExpenseAccounts('66');
  const financialResult = financialIncome - financialExpense;

  const netBeforeTax = operatingResult + financialResult;
  const incomeTax = netBeforeTax > 0 ? sumExpenseAccounts('69') : 0;
  const netIncome = netBeforeTax - incomeTax;

  return {
    fiscalYear: y,
    revenue,
    costOfSales,
    grossMargin,
    operatingExpenses,
    operatingResult,
    financialResult,
    netBeforeTax,
    incomeTax,
    netIncome,
  };
}

// ---------------------------------------------------------------------------
// Bilan Comptable (Balance Sheet) — SCF format
// ---------------------------------------------------------------------------

export interface BalanceSheet {
  fiscalYear: string;
  assets: { label: string; gross: number; amortProv: number; net: number }[];
  totalAssetsNet: number;
  liabilities: { label: string; amount: number }[];
  totalLiabilities: number;
}

export function buildBalanceSheet(entries: JournalEntry[], year: number): BalanceSheet {
  const y = String(year);
  const filtered = entries.filter(e => str(e.date) <= y + '-12-31');

  function netDebit(...codes: string[]): number {
    let total = 0;
    for (const e of filtered) {
      if (codes.includes(str(e.accountCode))) {
        total += int(e.debit) - int(e.credit);
      }
    }
    return Math.max(0, total);
  }

  function netCredit(...codes: string[]): number {
    let total = 0;
    for (const e of filtered) {
      if (codes.includes(str(e.accountCode))) {
        total += int(e.credit) - int(e.debit);
      }
    }
    return Math.max(0, total);
  }

  // --- ACTIF ---
  const imobGross = netDebit('20', '21', '218', '2183');
  const amort = netCredit('28', '29');
  const stockNet = netDebit('30', '31', '32', '35') - netCredit('39');
  const clientsNet = netDebit('41', '411') - netCredit('416');
  const banqueNet = netDebit('512', '514');
  const caisseNet = netDebit('531', '532');

  const taxReceivable = netDebit('445');

  const assets = [
    { label: 'Immobilisations incorporelles (20)', gross: netDebit('20'), amortProv: netCredit('28'), net: netDebit('20') - netCredit('28') },
    { label: 'Immobilisations corporelles (21-218)', gross: netDebit('21','218','2183'), amortProv: 0, net: netDebit('21','218','2183') },
    { label: 'Stocks & en-cours (30-35)', gross: netDebit('30','31','32','35'), amortProv: netCredit('39'), net: stockNet },
    { label: 'Créances clients (41)', gross: netDebit('41','411'), amortProv: netCredit('416'), net: clientsNet },
    { label: 'Crédit TVA / impôts (445)', gross: taxReceivable, amortProv: 0, net: taxReceivable },
    { label: 'Banques (512-514)', gross: banqueNet, amortProv: 0, net: banqueNet },
    { label: 'Caisse (531-532)', gross: caisseNet, amortProv: 0, net: caisseNet },
  ];

  const totalAssetsNet = assets.reduce((s, a) => s + a.net, 0);

  // --- PASSIF ---
  const liabilities = [
    { label: 'Capital social (101-102)', amount: netCredit('101','102') },
    { label: 'Réserves (106)', amount: netCredit('106') },
    { label: 'Report à nouveau (11)', amount: netCredit('11') },
    { label: 'Résultat de l\'exercice (12)', amount: netCredit('12') },
    { label: 'Subventions (13)', amount: netCredit('13') },
    { label: 'Emprunts bancaires (16-164-165)', amount: netCredit('16','164','165') },
    { label: 'Dettes fournisseurs (40-401-404)', amount: netCredit('40','401','404') },
    { label: 'Dettes fiscales TVA (441)', amount: netCredit('441') },
    { label: 'Dettes IRG (442)', amount: netCredit('442') },
    { label: 'Dettes TAP (443)', amount: netCredit('443') },
    { label: 'Dettes IBS (444)', amount: netCredit('444') },
    { label: 'Dettes CNAS/CASNOS (431-432)', amount: netCredit('431','432') },
    { label: 'Dettes personnel (421)', amount: netCredit('421') },
    { label: 'Associés (45)', amount: netCredit('45') },
    { label: 'Provisions pour risques (15)', amount: netCredit('15') },
  ];

  const totalLiabilities = liabilities.reduce((s, l) => s + l.amount, 0);

  return { fiscalYear: y, assets, totalAssetsNet, liabilities, totalLiabilities };
}

// ---------------------------------------------------------------------------
// DZ Fiscal Tools
// ---------------------------------------------------------------------------

/** DZ TVA rates */
export const TVA_STANDARD = 0.19;
export const TVA_REDUCED = 0.09;

/** Progressive IRG scale (monthly withholding, DZ 2025-2026 scale). */
export const IRG_SCALE = [
  { from: 0,       to: 20_000,  rate: 0.00 },
  { from: 20_001,  to: 40_000,  rate: 0.23 },
  { from: 40_001,  to: 80_000,  rate: 0.27 },
  { from: 80_001,  to: 160_000, rate: 0.30 },
  { from: 160_001, to: 320_000, rate: 0.33 },
  { from: 320_001, to: Infinity, rate: 0.35 },
];

/** TAP rate: 2% of turnover for commercial activities. */
export const TAP_RATE = 0.02;

/** IBS rates for manufacturing/retail. */
export const IBS_RATE_STANDARD = 0.19;
export const IBS_RATE_MANUFACTURING = 0.23;
export const IBS_RATE_HYDROCARBONS = 0.26;

/** Calculate monthly IRG withholding from gross salary. */
export function computeIRG(monthlyGross: number): number {
  let remaining = Math.round(monthlyGross);
  let tax = 0;
  for (const bracket of IRG_SCALE) {
    const slice = Math.min(remaining, bracket.to - bracket.from);
    if (slice > 0) {
      tax += Math.round(slice * bracket.rate);
      remaining -= slice;
    }
    if (remaining <= 0) break;
  }
  return tax;
}

/** Calculate TAP (Taxe sur l'Activité Professionnelle) from quarterly turnover. */
export function computeTAP(quarterlyTurnover: number): number {
  return Math.round(quarterlyTurnover * TAP_RATE);
}

/** Calculate IBS (Impôt sur les Bénéfices des Sociétés). */
export function computeIBS(netProfit: number, sector: 'standard' | 'manufacturing' | 'hydrocarbons' = 'standard'): number {
  if (netProfit <= 0) return 0;
  const rate = sector === 'manufacturing' ? IBS_RATE_MANUFACTURING
    : sector === 'hydrocarbons' ? IBS_RATE_HYDROCARBONS
    : IBS_RATE_STANDARD;
  return Math.round(netProfit * rate);
}

/**
 * Generate G50 (Déclaration Annuelle des Revenus) summary.
 * G50 is the DZ annual summary for professional income, required for
 * sole proprietors, EURL, and partnerships.
 */
export interface G50Summary {
  fiscalYear: number;
  turnover: number;
  otherIncome: number;
  totalRevenue: number;
  purchases: number;
  externalServices: number;
  salaries: number;
  socialCharges: number;
  taxesPaid: number;
  financialCharges: number;
  depreciation: number;
  totalExpenses: number;
  netTaxableIncome: number;
  irgDue: number;
}

export function buildG50Summary(entries: JournalEntry[], year: number): G50Summary {
  const y = String(year);
  const filtered = entries.filter(e => str(e.date).startsWith(y));

  function sumCredit(...codes: string[]): number {
    return filtered.filter(e => codes.includes(str(e.accountCode)))
      .reduce((s, e) => s + int(e.credit) - int(e.debit), 0);
  }

  function sumDebit(...codes: string[]): number {
    return filtered.filter(e => codes.includes(str(e.accountCode)))
      .reduce((s, e) => s + int(e.debit), 0);
  }

  const turnover = sumCredit('701', '702', '704', '706');
  const otherIncome = sumCredit('70', '71', '74', '75', '76', '78') - turnover;
  const purchases = sumDebit('601', '602');
  const externalServices = sumDebit('61', '62', '616', '622', '626', '628');
  const salaries = sumDebit('641');
  const socialCharges = sumDebit('645');
  const taxesPaid = sumDebit('63');
  const financialCharges = sumDebit('66');
  const depreciation = sumDebit('681');
  const totalRevenue = turnover + otherIncome;
  const totalExpenses = purchases + externalServices + salaries + socialCharges + taxesPaid + financialCharges + depreciation;
  const netTaxableIncome = totalRevenue - totalExpenses;

  return {
    fiscalYear: year,
    turnover,
    otherIncome,
    totalRevenue,
    purchases,
    externalServices,
    salaries,
    socialCharges,
    taxesPaid,
    financialCharges,
    depreciation,
    totalExpenses,
    netTaxableIncome,
    irgDue: computeIRG(netTaxableIncome / 12) * 12,
  };
}

// ---------------------------------------------------------------------------
// TVA Summary (CA3 / Déclaration mensuelle/trimestrielle)
// ---------------------------------------------------------------------------

export interface TVASummary {
  period: string; // YYYY-MM
  collectedTVA: number;  // TVA collectée sur ventes (441)
  deductibleTVA: number; // TVA déductible sur achats (445)
  netTVADue: number;     // À payer ou crédit
}

export function buildTVASummary(entries: JournalEntry[], yearMonth: string): TVASummary {
  const filtered = entries.filter(e => str(e.date).startsWith(yearMonth));

  const collected = filtered
    .filter(e => str(e.accountCode) === '441')
    .reduce((s, e) => s + int(e.credit), 0);

  const deductible = filtered
    .filter(e => str(e.accountCode) === '445')
    .reduce((s, e) => s + int(e.debit), 0);

  return {
    period: yearMonth,
    collectedTVA: collected,
    deductibleTVA: deductible,
    netTVADue: Math.max(0, collected - deductible),
  };
}

// ---------------------------------------------------------------------------
// Aged Receivables / Aged Payables
// ---------------------------------------------------------------------------

export interface AgedBucket {
  label: string;    // e.g. "Current", "1-30 jours", "31-60 jours"
  daysMin: number;
  daysMax: number;
  total: number;
  count: number;
}

export function buildAgedReceivables(entries: JournalEntry[], asOfDate: string, accountCode: string): AgedBucket[] {
  const asOf = new Date(asOfDate + 'T00:00:00Z');
  const filtered = entries.filter(e => str(e.accountCode) === accountCode);

  const buckets = [
    { label: 'Courant', daysMin: 0, daysMax: 0, total: 0, count: 0 },
    { label: '1-30 jours', daysMin: 1, daysMax: 30, total: 0, count: 0 },
    { label: '31-60 jours', daysMin: 31, daysMax: 60, total: 0, count: 0 },
    { label: '61-90 jours', daysMin: 61, daysMax: 90, total: 0, count: 0 },
    { label: '> 90 jours', daysMin: 91, daysMax: Infinity, total: 0, count: 0 },
  ];

  for (const e of filtered) {
    const date = new Date(str(e.date) + 'T00:00:00Z');
    if (isNaN(date.getTime())) continue;
    const days = Math.floor((asOf.getTime() - date.getTime()) / 86400000);
    const amount = Math.max(0, int(e.debit) - int(e.credit));
    if (amount === 0) continue;

    for (const b of buckets) {
      if (days >= b.daysMin && days <= b.daysMax) {
        b.total += amount;
        b.count++;
        break;
      }
    }
  }

  return buckets;
}

// ---------------------------------------------------------------------------
// Cash Flow Statement (Tableau des Flux de Trésorerie)
// ---------------------------------------------------------------------------

export interface CashFlowStatement {
  fiscalYear: string;
  operatingCashFlow: number;
  investingCashFlow: number;
  financingCashFlow: number;
  netChangeInCash: number;
  openingCash: number;
  closingCash: number;
}

export function buildCashFlowStatement(
  entries: JournalEntry[],
  year: number,
  openingCashBalance: number
): CashFlowStatement {
  const y = String(year);
  const filtered = entries.filter(e => str(e.date).startsWith(y));

  // Operating: revenue (class 7) - expenses (class 6, excl 66/69)
  const opRevenue = filtered
    .filter(e => str(e.accountCode).match(/^7/))
    .reduce((s, e) => s + int(e.credit) - int(e.debit), 0);
  const opExpenses = filtered
    .filter(e => str(e.accountCode).match(/^6[0-58]/))
    .reduce((s, e) => s + int(e.debit), 0);
  const operatingCashFlow = opRevenue - opExpenses;

  // Investing: asset purchases (class 2 debit)
  const assetPurchases = filtered
    .filter(e => str(e.accountCode).match(/^2[0-8]/))
    .reduce((s, e) => s + int(e.debit), 0);
  const investingCashFlow = -assetPurchases;

  // Financing: loans (16 credit), equity (101-102 credit) minus dividends
  const loansReceived = filtered
    .filter(e => str(e.accountCode).match(/^16/) && str(e.label).includes('emprunt'))
    .reduce((s, e) => s + int(e.credit), 0);
  const loanRepayments = filtered
    .filter(e => str(e.accountCode).match(/^16/) && str(e.label).includes('remboursement'))
    .reduce((s, e) => s + int(e.debit), 0);
  const equity = filtered
    .filter(e => ['101', '102'].includes(str(e.accountCode)))
    .reduce((s, e) => s + int(e.credit) - int(e.debit), 0);
  const financingCashFlow = loansReceived - loanRepayments + equity;

  const netChangeInCash = operatingCashFlow + investingCashFlow + financingCashFlow;
  const closingCash = openingCashBalance + netChangeInCash;

  return {
    fiscalYear: y,
    operatingCashFlow,
    investingCashFlow,
    financingCashFlow,
    netChangeInCash,
    openingCash: openingCashBalance,
    closingCash,
  };
}

// ---------------------------------------------------------------------------
// DZ Compliance — NIF/RC/NIS validation, Facture Normalisée
// ---------------------------------------------------------------------------

/** Validate DZ NIF (Numéro d'Identification Fiscale) — 15 digits. */
export function validateNIF(nif: string): { valid: boolean; error?: string } {
  const clean = nif.replace(/\s/g, '');
  if (!/^\d{15}$/.test(clean)) return { valid: false, error: 'NIF must be exactly 15 digits' };
  return { valid: true };
}

/** Validate DZ RC (Registre de Commerce) — format: YY-X-XXXXXX-XX */
export function validateRC(rc: string): { valid: boolean; error?: string } {
  const clean = rc.replace(/\s/g, '');
  if (!/^\d{2}[A-Z]\d{6,8}\d{2}$/.test(clean)) {
    return { valid: false, error: 'RC must match format YY-X-XXXXXX-XX (e.g. 24A12345616)' };
  }
  return { valid: true };
}

/**
 * Generate a compliant "Facture Normalisée" (DZ invoice HTML template).
 * Required for all B2B transactions in Algeria (Article 23 LF 2022).
 */
export function generateFactureNormalisee(args: {
  sellerName: string; sellerAddress: string; sellerNIF: string; sellerRC: string;
  sellerAIS?: string;  // Article d'Imposition Spécifique
  buyerName: string; buyerAddress: string; buyerNIF: string;
  invoiceNumber: string; invoiceDate: string;
  items: { description: string; quantity: number; unitPrice: number; tvaRate: number }[];
}): string {
  const lines = args.items.map((item, i) => {
    const totalHT = Math.round(item.quantity * item.unitPrice);
    const tva = Math.round(totalHT * item.tvaRate);
    const totalTTC = totalHT + tva;
    return [
      `    <tr>`,
      `      <td>${i + 1}</td>`,
      `      <td>${item.description}</td>`,
      `      <td>${item.quantity}</td>`,
      `      <td>${item.unitPrice.toLocaleString()} DZD</td>`,
      `      <td>${totalHT.toLocaleString()} DZD</td>`,
      `      <td>${(item.tvaRate * 100).toFixed(0)}%</td>`,
      `      <td>${tva.toLocaleString()} DZD</td>`,
      `      <td>${totalTTC.toLocaleString()} DZD</td>`,
      `    </tr>`,
    ].join('\n');
  }).join('\n');

  const totalHT = Math.round(args.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0));
  const totalTVA = Math.round(args.items.reduce((s, i) => s + Math.round(i.quantity * i.unitPrice * i.tvaRate), 0));
  const totalTTC = totalHT + totalTVA;

  const timbre = totalTTC >= 100_000 ? 500 : totalTTC >= 10_000 ? 250 : 0;
  const netAPayer = totalTTC + timbre;

  return [
    '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Facture Normalisée</title>',
    '<style>body{font-family:Arial,sans-serif;margin:40px;color:#1a1a1a}h1{font-size:18px;border-bottom:2px solid #333;padding-bottom:8px}',
    '.info{display:flex;justify-content:space-between;margin-bottom:20px}.box{flex:1;border:1px solid #ccc;padding:12px;margin:4px}',
    'table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #ccc;padding:6px 8px;text-align:right;font-size:12px}',
    'th{background:#f5f5f5;font-weight:bold}td:first-child,td:nth-child(2){text-align:left}.totals{margin-top:16px;text-align:right}',
    '</style></head><body>',
    '<h1>FACTURE NORMALISÉE N° ' + args.invoiceNumber + '</h1>',
    '<div class="info">',
    '  <div class="box"><strong>VENDEUR</strong><br>' + args.sellerName + '<br>' + args.sellerAddress + '<br>NIF: ' + args.sellerNIF + '<br>RC: ' + args.sellerRC + (args.sellerAIS ? '<br>AIS: ' + args.sellerAIS : '') + '</div>',
    '  <div class="box"><strong>CLIENT</strong><br>' + args.buyerName + '<br>' + args.buyerAddress + '<br>NIF: ' + args.buyerNIF + '</div>',
    '</div>',
    '<p>Date: ' + args.invoiceDate + '</p>',
    '<table><thead><tr><th>N°</th><th>Désignation</th><th>Qté</th><th>P.U. HT</th><th>Total HT</th><th>TVA</th><th>Mt TVA</th><th>Total TTC</th></tr></thead><tbody>',
    lines,
    '</tbody></table>',
    '<div class="totals">',
    '  <p><strong>Total HT:</strong> ' + totalHT.toLocaleString() + ' DZD</p>',
    '  <p><strong>Total TVA:</strong> ' + totalTVA.toLocaleString() + ' DZD</p>',
    '  <p><strong>Total TTC:</strong> ' + totalTTC.toLocaleString() + ' DZD</p>',
    (timbre > 0 ? '  <p><strong>Timbre fiscal:</strong> ' + timbre.toLocaleString() + ' DZD</p>' : ''),
    '  <p style="font-size:16px;font-weight:bold;border-top:1px solid #333;padding-top:8px">NET À PAYER: ' + netAPayer.toLocaleString() + ' DZD</p>',
    '</div>',
    '<p style="font-size:10px;color:#888;margin-top:30px">',
    'Article 23 LF 2022 — Facture obligatoire pour toute transaction commerciale B2B.<br>',
    'TVA applicable au taux en vigueur (19% standard). Paiement dû à réception de facture sauf convention contraire.',
    '</p>',
    '</body></html>',
  ].join('\n');
}
