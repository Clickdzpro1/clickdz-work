import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';

import {
  Banner,
  btnStyle,
  C,
  EmptyNote,
  type ErpSummary,
  Field,
  fmtDZD,
  hintStyle,
  inputStyle,
  Panel,
  Skeleton,
  Spinner,
  tdStyle,
  thStyle,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// Comptabilité (WS-ERP-ACCOUNTING) studio page — PCN DZ over the compta bridge
// routes (/api/v1/apps/:slug/erp/compta*). ALL money math lives server-side in
// clickdz-erp-accounting.ts (INTEGER DZD); this panel only collects params,
// calls the routes and renders. Four tools:
//   1. Journal   — month picker + entries list + quick-add form (date, compte
//                  PCN, libellé, débit XOR crédit, réf, pièce).
//   2. Rapports  — balance générale, grand livre, compte de résultat, bilan,
//                  flux de trésorerie, balance âgée.
//   3. Fiscalité — G50 annuel + TVA (CA3) mensuelle.
//   4. Facture   — Facture Normalisée (Art. 23 LF 2022) → HTML à imprimer.
// The PCN chart is fetched from the bridge (never duplicated client-side).
//
// Inline styles only (mirrors caisse.tsx / shoperp-shared primitives); FR
// labels; loading / error / empty states everywhere. Owner-only, authed: when
// the server reports admin_writes_unavailable every read stays usable and the
// journal form goes read-only via onWritesBlocked (like the sibling panels).
// La facture reste disponible en lecture seule : c'est un calcul pur, rien
// n'est écrit.
// ---------------------------------------------------------------------------

type ComptaTab = 'journal' | 'rapports' | 'fiscal' | 'facture';

const COMPTA_TABS: Array<{ id: ComptaTab; label: string; icon: string }> = [
  { id: 'journal', label: 'Journal', icon: '📒' },
  { id: 'rapports', label: 'Rapports', icon: '📊' },
  { id: 'fiscal', label: 'Fiscalité', icon: '🏛️' },
  { id: 'facture', label: 'Facture Normalisée', icon: '🧾' },
];

const CLASS_LABELS: Record<number, string> = {
  1: 'Classe 1 — Capitaux permanents',
  2: 'Classe 2 — Immobilisations',
  3: 'Classe 3 — Stocks',
  4: 'Classe 4 — Tiers',
  5: 'Classe 5 — Financiers',
  6: 'Classe 6 — Charges',
  7: 'Classe 7 — Produits',
};

interface ChartAccount {
  code: string;
  label: string;
  class: number;
  sign: 'debit' | 'credit';
}

interface ComptaEntry {
  id?: string;
  date?: string;
  label?: string;
  accountCode?: string;
  debit?: number;
  credit?: number;
  reference?: string;
  pieceRef?: string;
}

// Report payload mirrors (render-only fields — the bridge owns the shapes).
interface TrialLine {
  accountCode: string;
  accountLabel: string;
  accountClass: number;
  movementsDebit: number;
  movementsCredit: number;
  closingDebit: number;
  closingCredit: number;
}
interface LedgerView {
  accountCode: string;
  accountLabel: string;
  entries: Array<{
    date: string;
    label: string;
    reference: string;
    debit: number;
    credit: number;
    balance: number;
  }>;
  totalDebit: number;
  totalCredit: number;
  balance: number;
}
interface PLSectionView {
  label: string;
  lines: { label: string; amount: number }[];
  total: number;
}
interface IncomeView {
  fiscalYear: string;
  revenue: PLSectionView;
  costOfSales: PLSectionView;
  grossMargin: number;
  operatingExpenses: PLSectionView;
  operatingResult: number;
  financialResult: number;
  netBeforeTax: number;
  incomeTax: number;
  netIncome: number;
}
interface BilanView {
  fiscalYear: string;
  assets: { label: string; gross: number; amortProv: number; net: number }[];
  totalAssetsNet: number;
  liabilities: { label: string; amount: number }[];
  totalLiabilities: number;
}
interface CashflowView {
  fiscalYear: string;
  operatingCashFlow: number;
  investingCashFlow: number;
  financingCashFlow: number;
  netChangeInCash: number;
  openingCash: number;
  closingCash: number;
}
interface AgedBucketView {
  label: string;
  total: number;
  count: number;
}
interface G50View {
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
interface TVAView {
  period: string;
  collectedTVA: number;
  deductibleTVA: number;
  netTVADue: number;
}

// ---------------------------------------------------------------------------
// API layer — thin local wrappers over the compta bridge routes, mirroring the
// discriminated-outcome convention of shoperp-shared's fetchCaisse family.
// ---------------------------------------------------------------------------

type ComptaOutcome<T> =
  | { status: 'ok'; data: T }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

async function comptaGet<T>(path: string): Promise<ComptaOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(path), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  } catch {
    return { status: 'error', message: 'Erreur réseau lors du chargement.' };
  }
  if (res.status === 404 || res.status === 501) return { status: 'unavailable' };
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown })
    | null;
  if (data?.error === 'data_api_unavailable') return { status: 'unavailable' };
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : typeof data?.message === 'string' && data.message
          ? data.message
          : `Erreur serveur (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', data: (data ?? {}) as T };
}

async function comptaPost<T>(
  path: string,
  body: unknown
): Promise<ComptaOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    return {
      status: 'error',
      message: 'Erreur réseau — rien n’a été enregistré.',
    };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown })
    | null;
  if (
    res.status === 404 ||
    res.status === 501 ||
    data?.error === 'admin_writes_unavailable' ||
    data?.error === 'data_api_unavailable'
  ) {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : typeof data?.message === 'string' && data.message
          ? data.message
          : `Erreur serveur (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', data: (data ?? {}) as T };
}

// ---------------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------------

const selectStyle: CSSProperties = { ...inputStyle, appearance: 'auto' };

// Phase 2: AccountSelect hoisted to module level. When it was declared inside
// the AccountingPanel component, React unmounted and remounted the <select>
// on every keystroke (new function identity each render), causing focus loss
// and making it impossible to type an account code in the dropdown. As a
// module-level component it has a stable identity; the groups are passed as a
// prop so it re-renders only when the chart actually changes.
const AccountSelect = ({
  groups,
  value,
  onChange,
  allowEmpty,
}: {
  groups: Array<[number, ChartAccount[]]>;
  value: string;
  onChange: (code: string) => void;
  allowEmpty?: boolean;
}) => (
  <select
    value={value}
    onChange={e => onChange(e.target.value)}
    style={selectStyle}
  >
    {allowEmpty ? <option value="">— Compte PCN —</option> : null}
    {groups.map(([cls, accounts]) => (
      <optgroup key={cls} label={CLASS_LABELS[cls] ?? `Classe ${cls}`}>
        {accounts.map(a => (
          <option key={a.code} value={a.code}>
            {a.code} — {a.label}
          </option>
        ))}
      </optgroup>
    ))}
  </select>
);

const numTd: CSSProperties = {
  ...tdStyle,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};

const KpiRow = ({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      gap: 12,
      padding: '8px 0',
      borderBottom: `1px solid ${C.border}`,
      fontSize: 13,
      color: strong ? C.text : C.muted,
      fontWeight: strong ? 700 : 400,
    }}
  >
    <span>{label}</span>
    <span style={{ fontVariantNumeric: 'tabular-nums', color: C.text }}>
      {value}
    </span>
  </div>
);

function currentMonthInput(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function monthParam(ym: string): string {
  return /^\d{4}-\d{2}$/.test(ym) ? ym.replace('-', '') : '';
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export const AccountingPanel = ({
  slug,
  summary,
  currency,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  /** The store's slug — its data-API namespace + publish slug. */
  slug: string;
  /** Live dashboard summary (seller prefill for the facture). */
  summary: ErpSummary;
  currency: string;
  readOnly: boolean;
  onWritesBlocked: () => void;
  /** Refresh the parent summary after a journal mutation. */
  onMutated: () => void;
}) => {
  const [tab, setTab] = useState<ComptaTab>('journal');

  // PCN chart — fetched once, shared by every tab (account pickers).
  const [chart, setChart] = useState<Record<string, ChartAccount> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void comptaGet<{ chart: Record<string, ChartAccount> }>(
      `/api/v1/apps/${encodeURIComponent(slug)}/erp/compta/chart`
    ).then(out => {
      if (!cancelled && out.status === 'ok') setChart(out.data.chart || {});
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const accountGroups = useMemo(() => {
    const groups = new Map<number, ChartAccount[]>();
    for (const acct of Object.values(chart ?? {})) {
      const list = groups.get(acct.class) ?? [];
      list.push(acct);
      groups.set(acct.class, list);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.code.localeCompare(b.code));
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [chart]);

  const accountLabel = useCallback(
    (code: string) => {
      const acct = chart?.[code];
      return acct ? `${acct.code} — ${acct.label}` : code;
    },
    [chart]
  );

  // Phase 2: AccountSelect is now a module-level component (see above). It
  // receives accountGroups as a prop instead of closing over it, so it has a
  // stable identity across renders and doesn't lose focus on keystroke.

  // ------------------------------------------------------------------ journal
  const [month, setMonth] = useState(currentMonthInput());
  const [entries, setEntries] = useState<ComptaEntry[] | null>(null);
  const [journalState, setJournalState] = useState<
    'loading' | 'ok' | 'unavailable' | 'error'
  >('loading');
  const [journalError, setJournalError] = useState('');

  const loadJournal = useCallback(async () => {
    setJournalState('loading');
    const qs = monthParam(month) ? `?month=${monthParam(month)}` : '';
    const out = await comptaGet<{ entries: ComptaEntry[] }>(
      `/api/v1/apps/${encodeURIComponent(slug)}/erp/compta${qs}`
    );
    if (out.status === 'ok') {
      setEntries(Array.isArray(out.data.entries) ? out.data.entries : []);
      setJournalState('ok');
    } else if (out.status === 'unavailable') {
      setJournalState('unavailable');
    } else {
      setJournalError(out.message);
      setJournalState('error');
    }
  }, [slug, month]);

  useEffect(() => {
    void loadJournal();
  }, [loadJournal]);

  const journalTotals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const e of entries ?? []) {
      debit += Number(e.debit) || 0;
      credit += Number(e.credit) || 0;
    }
    return { debit, credit };
  }, [entries]);

  const todayISO = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    date: todayISO,
    accountCode: '',
    label: '',
    debit: '',
    credit: '',
    reference: '',
    pieceRef: '',
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const submitEntry = useCallback(async () => {
    setFormError('');
    const debit = Math.round(Number(form.debit) || 0);
    const credit = Math.round(Number(form.credit) || 0);
    if (!form.accountCode) {
      setFormError('Choisissez un compte PCN.');
      return;
    }
    if (form.label.trim().length < 2) {
      setFormError('Libellé requis (2 caractères minimum).');
      return;
    }
    if ((debit > 0) === (credit > 0)) {
      setFormError('Saisissez un débit OU un crédit (pas les deux).');
      return;
    }
    setSaving(true);
    const out = await comptaPost<{ ok?: boolean }>(
      `/api/v1/apps/${encodeURIComponent(slug)}/erp/compta`,
      {
        date: form.date,
        accountCode: form.accountCode,
        label: form.label.trim(),
        debit,
        credit,
        reference: form.reference.trim(),
        pieceRef: form.pieceRef.trim(),
      }
    );
    setSaving(false);
    if (out.status === 'unavailable') {
      onWritesBlocked();
      return;
    }
    if (out.status === 'error') {
      setFormError(out.message);
      return;
    }
    setForm(f => ({ ...f, label: '', debit: '', credit: '', reference: '', pieceRef: '' }));
    onMutated();
    void loadJournal();
  }, [form, slug, onWritesBlocked, onMutated, loadJournal]);

  // ----------------------------------------------------------------- rapports
  type ReportKind = 'trial' | 'ledger' | 'income' | 'bilan' | 'cashflow' | 'aged';
  const [reportKind, setReportKind] = useState<ReportKind>('trial');
  const [reportYear, setReportYear] = useState(String(new Date().getUTCFullYear()));
  const [reportAccount, setReportAccount] = useState('411');
  const [reportAsof, setReportAsof] = useState(todayISO);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState('');
  const [report, setReport] = useState<
    | { kind: 'trial'; data: TrialLine[] }
    | { kind: 'ledger'; data: LedgerView }
    | { kind: 'income'; data: IncomeView }
    | { kind: 'bilan'; data: BilanView }
    | { kind: 'cashflow'; data: CashflowView }
    | { kind: 'aged'; data: AgedBucketView[] }
    | null
  >(null);

  const runReport = useCallback(async () => {
    setReportBusy(true);
    setReportError('');
    setReport(null);
    const y = /^\d{4}$/.test(reportYear) ? reportYear : String(new Date().getUTCFullYear());
    const params = new URLSearchParams({ type: reportKind, year: y });
    if (reportKind === 'ledger' || reportKind === 'aged') {
      params.set('account', reportAccount);
    }
    if (reportKind === 'aged') params.set('asof', reportAsof);
    const out = await comptaGet<{ report: unknown }>(
      `/api/v1/apps/${encodeURIComponent(slug)}/erp/compta/report?${params.toString()}`
    );
    setReportBusy(false);
    if (out.status === 'unavailable') {
      setReportError('Données indisponibles pour le moment.');
      return;
    }
    if (out.status === 'error') {
      setReportError(out.message);
      return;
    }
    const r = out.data.report;
    if (reportKind === 'trial') setReport({ kind: 'trial', data: r as TrialLine[] });
    else if (reportKind === 'ledger') setReport({ kind: 'ledger', data: r as LedgerView });
    else if (reportKind === 'income') setReport({ kind: 'income', data: r as IncomeView });
    else if (reportKind === 'bilan') setReport({ kind: 'bilan', data: r as BilanView });
    else if (reportKind === 'cashflow') setReport({ kind: 'cashflow', data: r as CashflowView });
    else setReport({ kind: 'aged', data: r as AgedBucketView[] });
  }, [slug, reportKind, reportYear, reportAccount, reportAsof]);

  // ------------------------------------------------------------------- fiscal
  const [fiscalYear, setFiscalYear] = useState(String(new Date().getUTCFullYear()));
  const [tvaMonth, setTvaMonth] = useState(currentMonthInput());
  const [fiscalBusy, setFiscalBusy] = useState(false);
  const [fiscalError, setFiscalError] = useState('');
  const [g50, setG50] = useState<G50View | null>(null);
  const [tva, setTva] = useState<TVAView | null>(null);

  const runFiscal = useCallback(async () => {
    setFiscalBusy(true);
    setFiscalError('');
    const y = /^\d{4}$/.test(fiscalYear) ? fiscalYear : String(new Date().getUTCFullYear());
    const g50Out = await comptaGet<{ report: G50View }>(
      `/api/v1/apps/${encodeURIComponent(slug)}/erp/compta/report?type=g50&year=${y}`
    );
    const tvaOut = await comptaGet<{ report: TVAView }>(
      `/api/v1/apps/${encodeURIComponent(slug)}/erp/compta/report?type=tva&month=${encodeURIComponent(tvaMonth)}`
    );
    setFiscalBusy(false);
    if (g50Out.status === 'ok') setG50(g50Out.data.report);
    if (tvaOut.status === 'ok') setTva(tvaOut.data.report);
    if (g50Out.status !== 'ok' && tvaOut.status !== 'ok') {
      setFiscalError(
        g50Out.status === 'error'
          ? g50Out.message
          : 'Données fiscales indisponibles pour le moment.'
      );
    }
  }, [slug, fiscalYear, tvaMonth]);

  // ------------------------------------------------------------------ facture
  const sellerStorageKey = `cdz-compta-seller-${slug}`;
  const [seller, setSeller] = useState<{
    name: string;
    address: string;
    nif: string;
    rc: string;
    ais: string;
  }>(() => {
    const base = {
      name: summary.settings.shopName || '',
      address: '',
      nif: '',
      rc: '',
      ais: '',
    };
    try {
      const raw = localStorage.getItem(sellerStorageKey);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<typeof base> | null;
        return { ...base, ...(saved ?? {}) };
      }
    } catch {
      // localStorage unavailable — start clean.
    }
    return base;
  });
  const [buyer, setBuyer] = useState({ name: '', address: '', nif: '' });
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(todayISO);
  const [items, setItems] = useState([
    { description: '', quantity: '1', unitPrice: '', tvaRate: '0.19' },
  ]);
  const [factureBusy, setFactureBusy] = useState(false);
  const [factureError, setFactureError] = useState('');
  const [factureHtml, setFactureHtml] = useState('');

  const factureTotals = useMemo(() => {
    let ht = 0;
    let tvaTotal = 0;
    for (const it of items) {
      const q = Math.round(Number(it.quantity) || 0);
      const pu = Math.round(Number(it.unitPrice) || 0);
      const lineHT = q * pu;
      ht += lineHT;
      tvaTotal += Math.round(lineHT * Number(it.tvaRate));
    }
    return { ht, tva: tvaTotal, ttc: ht + tvaTotal };
  }, [items]);

  const setItem = useCallback(
    (index: number, patch: Partial<(typeof items)[number]>) => {
      setItems(list => list.map((it, i) => (i === index ? { ...it, ...patch } : it)));
    },
    []
  );

  const submitFacture = useCallback(async () => {
    setFactureError('');
    setFactureHtml('');
    if (!/^\d{15}$/.test(seller.nif.replace(/\s/g, ''))) {
      setFactureError('NIF vendeur : 15 chiffres requis.');
      return;
    }
    if (!/^\d{15}$/.test(buyer.nif.replace(/\s/g, ''))) {
      setFactureError('NIF acheteur : 15 chiffres requis.');
      return;
    }
    const validItems = items.filter(
      it => it.description.trim() && Math.round(Number(it.quantity) || 0) > 0
    );
    if (validItems.length === 0) {
      setFactureError('Ajoutez au moins une ligne (description + quantité).');
      return;
    }
    try {
      localStorage.setItem(sellerStorageKey, JSON.stringify(seller));
    } catch {
      // Best-effort convenience only.
    }
    setFactureBusy(true);
    const out = await comptaPost<{ html?: string }>(
      `/api/v1/apps/${encodeURIComponent(slug)}/erp/compta/facture`,
      {
        sellerName: seller.name,
        sellerAddress: seller.address,
        sellerNIF: seller.nif,
        sellerRC: seller.rc,
        sellerAIS: seller.ais || undefined,
        buyerName: buyer.name,
        buyerAddress: buyer.address,
        buyerNIF: buyer.nif,
        invoiceNumber,
        invoiceDate,
        items: validItems.map(it => ({
          description: it.description.trim(),
          quantity: Math.round(Number(it.quantity) || 0),
          unitPrice: Math.round(Number(it.unitPrice) || 0),
          tvaRate: Number(it.tvaRate),
        })),
      }
    );
    setFactureBusy(false);
    if (out.status === 'unavailable') {
      setFactureError('Service indisponible pour le moment.');
      return;
    }
    if (out.status === 'error') {
      setFactureError(out.message);
      return;
    }
    const html = out.data.html || '';
    setFactureHtml(html);
    try {
      const blob = new Blob([html], { type: 'text/html' });
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch {
      // The download button below stays available.
    }
  }, [seller, buyer, invoiceNumber, invoiceDate, items, slug, sellerStorageKey]);

  // ------------------------------------------------------------------- render
  const inputColStyle: CSSProperties = { minWidth: 0, flex: '1 1 160px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {COMPTA_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              ...btnStyle(tab === t.id ? 'primary' : 'secondary'),
              padding: '7px 14px',
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'journal' ? (
        <>
          {readOnly ? (
            <Banner tone="warn">
              Écritures en lecture seule — les écritures comptables ne sont pas
              disponibles sur ce déploiement.
            </Banner>
          ) : null}
          <Panel
            title="Journal comptable"
            action={
              <input
                type="month"
                value={month}
                onChange={e => setMonth(e.target.value)}
                style={{ ...inputStyle, width: 150 }}
              />
            }
          >
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {journalState === 'loading' ? (
                <Skeleton />
              ) : journalState === 'unavailable' ? (
                <Banner tone="warn">
                  Données comptables indisponibles pour le moment.
                </Banner>
              ) : journalState === 'error' ? (
                <Banner tone="error">{journalError}</Banner>
              ) : (entries ?? []).length === 0 ? (
                <EmptyNote>
                  Aucune écriture ce mois-ci. Ajoutez la première ci-dessous.
                </EmptyNote>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Date</th>
                        <th style={thStyle}>Compte</th>
                        <th style={thStyle}>Libellé</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Débit</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Crédit</th>
                        <th style={thStyle}>Réf</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(entries ?? []).map((e, i) => (
                        <tr key={e.id ?? i}>
                          <td style={tdStyle}>{e.date ?? ''}</td>
                          <td style={tdStyle} title={accountLabel(String(e.accountCode ?? ''))}>
                            {e.accountCode ?? ''}
                          </td>
                          <td style={tdStyle}>{e.label ?? ''}</td>
                          <td style={numTd}>
                            {Number(e.debit) > 0 ? fmtDZD(Number(e.debit), currency) : ''}
                          </td>
                          <td style={numTd}>
                            {Number(e.credit) > 0 ? fmtDZD(Number(e.credit), currency) : ''}
                          </td>
                          <td style={tdStyle}>{e.reference ?? ''}</td>
                        </tr>
                      ))}
                      <tr>
                        <td style={{ ...tdStyle, fontWeight: 700 }} colSpan={3}>
                          Totaux
                        </td>
                        <td style={{ ...numTd, fontWeight: 700 }}>
                          {fmtDZD(journalTotals.debit, currency)}
                        </td>
                        <td style={{ ...numTd, fontWeight: 700 }}>
                          {fmtDZD(journalTotals.credit, currency)}
                        </td>
                        <td style={tdStyle}>
                          {journalTotals.debit === journalTotals.credit ? (
                            <span style={{ color: C.okText }}>équilibré</span>
                          ) : (
                            <span style={{ color: C.muted }}>
                              écart {fmtDZD(Math.abs(journalTotals.debit - journalTotals.credit), currency)}
                            </span>
                          )}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Panel>

          <Panel title="Nouvelle écriture">
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={inputColStyle}>
                  <Field label="Date">
                    <input
                      type="date"
                      value={form.date}
                      onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                      style={inputStyle}
                      disabled={readOnly}
                    />
                  </Field>
                </div>
                <div style={{ ...inputColStyle, flex: '2 1 260px' }}>
                  <Field label="Compte PCN" hint="Plan Comptable National (SCF 2010)">
                    <AccountSelect
                      groups={accountGroups}
                      value={form.accountCode}
                      onChange={code => setForm(f => ({ ...f, accountCode: code }))}
                      allowEmpty
                    />
                  </Field>
                </div>
                <div style={{ ...inputColStyle, flex: '2 1 220px' }}>
                  <Field label="Libellé">
                    <input
                      value={form.label}
                      onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                      placeholder="ex. Vente comptoir, achat stock…"
                      style={inputStyle}
                      disabled={readOnly}
                    />
                  </Field>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={inputColStyle}>
                  <Field label="Débit (DZD)">
                    <input
                      inputMode="numeric"
                      value={form.debit}
                      onChange={e => setForm(f => ({ ...f, debit: e.target.value, credit: '' }))}
                      placeholder="0"
                      style={inputStyle}
                      disabled={readOnly}
                    />
                  </Field>
                </div>
                <div style={inputColStyle}>
                  <Field label="Crédit (DZD)">
                    <input
                      inputMode="numeric"
                      value={form.credit}
                      onChange={e => setForm(f => ({ ...f, credit: e.target.value, debit: '' }))}
                      placeholder="0"
                      style={inputStyle}
                      disabled={readOnly}
                    />
                  </Field>
                </div>
                <div style={inputColStyle}>
                  <Field label="Référence" hint="n° commande, contrat…">
                    <input
                      value={form.reference}
                      onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
                      style={inputStyle}
                      disabled={readOnly}
                    />
                  </Field>
                </div>
                <div style={inputColStyle}>
                  <Field label="Pièce" hint="n° de pièce justificative">
                    <input
                      value={form.pieceRef}
                      onChange={e => setForm(f => ({ ...f, pieceRef: e.target.value }))}
                      style={inputStyle}
                      disabled={readOnly}
                    />
                  </Field>
                </div>
              </div>
              {formError ? <Banner tone="error">{formError}</Banner> : null}
              <div>
                <button
                  onClick={() => void submitEntry()}
                  disabled={readOnly || saving}
                  style={btnStyle('primary', readOnly || saving)}
                >
                  {saving ? <Spinner /> : null} Enregistrer l’écriture
                </button>
              </div>
            </div>
          </Panel>
        </>
      ) : null}

      {tab === 'rapports' ? (
        <Panel title="États financiers">
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={inputColStyle}>
                <Field label="Rapport">
                  <select
                    value={reportKind}
                    onChange={e => setReportKind(e.target.value as ReportKind)}
                    style={selectStyle}
                  >
                    <option value="trial">Balance générale</option>
                    <option value="ledger">Grand livre (un compte)</option>
                    <option value="income">Compte de résultat</option>
                    <option value="bilan">Bilan comptable</option>
                    <option value="cashflow">Flux de trésorerie</option>
                    <option value="aged">Balance âgée (créances)</option>
                  </select>
                </Field>
              </div>
              <div style={{ ...inputColStyle, maxWidth: 120 }}>
                <Field label="Exercice">
                  <input
                    value={reportYear}
                    onChange={e => setReportYear(e.target.value)}
                    placeholder="2026"
                    style={inputStyle}
                  />
                </Field>
              </div>
              {reportKind === 'ledger' || reportKind === 'aged' ? (
                <div style={{ ...inputColStyle, flex: '2 1 260px' }}>
                  <Field label="Compte">
                    <AccountSelect groups={accountGroups} value={reportAccount} onChange={setReportAccount} />
                  </Field>
                </div>
              ) : null}
              {reportKind === 'aged' ? (
                <div style={inputColStyle}>
                  <Field label="Au">
                    <input
                      type="date"
                      value={reportAsof}
                      onChange={e => setReportAsof(e.target.value)}
                      style={inputStyle}
                    />
                  </Field>
                </div>
              ) : null}
              <div>
                <button
                  onClick={() => void runReport()}
                  disabled={reportBusy}
                  style={btnStyle('primary', reportBusy)}
                >
                  {reportBusy ? <Spinner /> : null} Générer
                </button>
              </div>
            </div>

            {reportError ? <Banner tone="error">{reportError}</Banner> : null}

            {report?.kind === 'trial' ? (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Compte</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Mvts débit</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Mvts crédit</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Solde débit</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Solde crédit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.data
                      .filter(
                        l =>
                          l.movementsDebit !== 0 ||
                          l.movementsCredit !== 0 ||
                          l.closingDebit !== 0 ||
                          l.closingCredit !== 0
                      )
                      .map(l => (
                        <tr key={l.accountCode}>
                          <td style={tdStyle}>
                            {l.accountCode} — {l.accountLabel}
                          </td>
                          <td style={numTd}>{fmtDZD(l.movementsDebit, currency)}</td>
                          <td style={numTd}>{fmtDZD(l.movementsCredit, currency)}</td>
                          <td style={numTd}>{fmtDZD(l.closingDebit, currency)}</td>
                          <td style={numTd}>{fmtDZD(l.closingCredit, currency)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {report.data.every(
                  l =>
                    l.movementsDebit === 0 &&
                    l.movementsCredit === 0 &&
                    l.closingDebit === 0 &&
                    l.closingCredit === 0
                ) ? (
                  <EmptyNote>Aucun mouvement sur la période.</EmptyNote>
                ) : null}
              </div>
            ) : null}

            {report?.kind === 'ledger' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 13, color: C.muted }}>
                  {report.data.accountCode} — {report.data.accountLabel} · solde{' '}
                  <strong style={{ color: C.text }}>
                    {fmtDZD(report.data.balance, currency)}
                  </strong>
                </div>
                {report.data.entries.length === 0 ? (
                  <EmptyNote>Aucune écriture sur ce compte.</EmptyNote>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={thStyle}>Date</th>
                          <th style={thStyle}>Libellé</th>
                          <th style={thStyle}>Réf</th>
                          <th style={{ ...thStyle, textAlign: 'right' }}>Débit</th>
                          <th style={{ ...thStyle, textAlign: 'right' }}>Crédit</th>
                          <th style={{ ...thStyle, textAlign: 'right' }}>Solde</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.data.entries.map((l, i) => (
                          <tr key={i}>
                            <td style={tdStyle}>{l.date}</td>
                            <td style={tdStyle}>{l.label}</td>
                            <td style={tdStyle}>{l.reference}</td>
                            <td style={numTd}>{l.debit ? fmtDZD(l.debit, currency) : ''}</td>
                            <td style={numTd}>{l.credit ? fmtDZD(l.credit, currency) : ''}</td>
                            <td style={numTd}>{fmtDZD(l.balance, currency)}</td>
                          </tr>
                        ))}
                        <tr>
                          <td style={{ ...tdStyle, fontWeight: 700 }} colSpan={3}>
                            Totaux
                          </td>
                          <td style={{ ...numTd, fontWeight: 700 }}>
                            {fmtDZD(report.data.totalDebit, currency)}
                          </td>
                          <td style={{ ...numTd, fontWeight: 700 }}>
                            {fmtDZD(report.data.totalCredit, currency)}
                          </td>
                          <td style={numTd} />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : null}

            {report?.kind === 'income' ? (
              <div style={{ maxWidth: 560 }}>
                {[report.data.revenue, report.data.costOfSales, report.data.operatingExpenses].map(
                  section => (
                    <div key={section.label} style={{ marginBottom: 10 }}>
                      <KpiRow label={section.label} value={fmtDZD(section.total, currency)} strong />
                      {section.lines.map(line => (
                        <KpiRow
                          key={line.label}
                          label={`· ${line.label}`}
                          value={fmtDZD(line.amount, currency)}
                        />
                      ))}
                    </div>
                  )
                )}
                <KpiRow label="Marge brute" value={fmtDZD(report.data.grossMargin, currency)} strong />
                <KpiRow
                  label="Résultat opérationnel"
                  value={fmtDZD(report.data.operatingResult, currency)}
                  strong
                />
                <KpiRow
                  label="Résultat financier"
                  value={fmtDZD(report.data.financialResult, currency)}
                />
                <KpiRow
                  label="Résultat avant impôt"
                  value={fmtDZD(report.data.netBeforeTax, currency)}
                />
                <KpiRow label="IBS" value={fmtDZD(report.data.incomeTax, currency)} />
                <KpiRow
                  label={`Résultat net ${report.data.fiscalYear}`}
                  value={fmtDZD(report.data.netIncome, currency)}
                  strong
                />
              </div>
            ) : null}

            {report?.kind === 'bilan' ? (
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Actif</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Brut</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Amort.</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.data.assets.map(a => (
                        <tr key={a.label}>
                          <td style={tdStyle}>{a.label}</td>
                          <td style={numTd}>{fmtDZD(a.gross, currency)}</td>
                          <td style={numTd}>{fmtDZD(a.amortProv, currency)}</td>
                          <td style={numTd}>{fmtDZD(a.net, currency)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td style={{ ...tdStyle, fontWeight: 700 }} colSpan={3}>
                          Total actif net
                        </td>
                        <td style={{ ...numTd, fontWeight: 700 }}>
                          {fmtDZD(report.data.totalAssetsNet, currency)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Passif</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Montant</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.data.liabilities.map(l => (
                        <tr key={l.label}>
                          <td style={tdStyle}>{l.label}</td>
                          <td style={numTd}>{fmtDZD(l.amount, currency)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td style={{ ...tdStyle, fontWeight: 700 }}>Total passif</td>
                        <td style={{ ...numTd, fontWeight: 700 }}>
                          {fmtDZD(report.data.totalLiabilities, currency)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {report?.kind === 'cashflow' ? (
              <div style={{ maxWidth: 480 }}>
                <KpiRow
                  label="Trésorerie d’ouverture"
                  value={fmtDZD(report.data.openingCash, currency)}
                />
                <KpiRow
                  label="Flux d’exploitation"
                  value={fmtDZD(report.data.operatingCashFlow, currency)}
                />
                <KpiRow
                  label="Flux d’investissement"
                  value={fmtDZD(report.data.investingCashFlow, currency)}
                />
                <KpiRow
                  label="Flux de financement"
                  value={fmtDZD(report.data.financingCashFlow, currency)}
                />
                <KpiRow
                  label="Variation nette"
                  value={fmtDZD(report.data.netChangeInCash, currency)}
                  strong
                />
                <KpiRow
                  label={`Trésorerie de clôture ${report.data.fiscalYear}`}
                  value={fmtDZD(report.data.closingCash, currency)}
                  strong
                />
              </div>
            ) : null}

            {report?.kind === 'aged' ? (
              <div style={{ overflowX: 'auto', maxWidth: 560 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Ancienneté</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Écritures</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.data.map(b => (
                      <tr key={b.label}>
                        <td style={tdStyle}>{b.label}</td>
                        <td style={numTd}>{b.count}</td>
                        <td style={numTd}>{fmtDZD(b.total, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {tab === 'fiscal' ? (
        <Panel title="Fiscalité DZ — G50 & TVA">
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ ...inputColStyle, maxWidth: 120 }}>
                <Field label="Exercice (G50)">
                  <input
                    value={fiscalYear}
                    onChange={e => setFiscalYear(e.target.value)}
                    placeholder="2026"
                    style={inputStyle}
                  />
                </Field>
              </div>
              <div style={{ ...inputColStyle, maxWidth: 170 }}>
                <Field label="Mois (TVA / CA3)">
                  <input
                    type="month"
                    value={tvaMonth}
                    onChange={e => setTvaMonth(e.target.value)}
                    style={inputStyle}
                  />
                </Field>
              </div>
              <div>
                <button
                  onClick={() => void runFiscal()}
                  disabled={fiscalBusy}
                  style={btnStyle('primary', fiscalBusy)}
                >
                  {fiscalBusy ? <Spinner /> : null} Calculer
                </button>
              </div>
            </div>
            <span style={hintStyle}>
              Montants indicatifs calculés depuis le journal — à vérifier avec
              votre comptable avant toute déclaration.
            </span>

            {fiscalError ? <Banner tone="error">{fiscalError}</Banner> : null}

            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              {g50 ? (
                <div style={{ flex: '1 1 340px', minWidth: 0, maxWidth: 520 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, color: C.text }}>
                    G50 — exercice {g50.fiscalYear}
                  </div>
                  <KpiRow label="Chiffre d’affaires" value={fmtDZD(g50.turnover, currency)} />
                  <KpiRow label="Autres produits" value={fmtDZD(g50.otherIncome, currency)} />
                  <KpiRow label="Total produits" value={fmtDZD(g50.totalRevenue, currency)} strong />
                  <KpiRow label="Achats" value={fmtDZD(g50.purchases, currency)} />
                  <KpiRow label="Services extérieurs" value={fmtDZD(g50.externalServices, currency)} />
                  <KpiRow label="Salaires" value={fmtDZD(g50.salaries, currency)} />
                  <KpiRow label="Charges sociales (CNAS/CASNOS)" value={fmtDZD(g50.socialCharges, currency)} />
                  <KpiRow label="Impôts et taxes payés" value={fmtDZD(g50.taxesPaid, currency)} />
                  <KpiRow label="Charges financières" value={fmtDZD(g50.financialCharges, currency)} />
                  <KpiRow label="Dotations amortissements" value={fmtDZD(g50.depreciation, currency)} />
                  <KpiRow label="Total charges" value={fmtDZD(g50.totalExpenses, currency)} strong />
                  <KpiRow label="Résultat imposable" value={fmtDZD(g50.netTaxableIncome, currency)} strong />
                  <KpiRow label="IRG dû" value={fmtDZD(g50.irgDue, currency)} strong />
                </div>
              ) : null}

              {tva ? (
                <div style={{ flex: '1 1 280px', minWidth: 0, maxWidth: 420 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, color: C.text }}>
                    TVA (CA3) — {tva.period}
                  </div>
                  <KpiRow label="TVA collectée (441)" value={fmtDZD(tva.collectedTVA, currency)} />
                  <KpiRow label="TVA déductible (445)" value={fmtDZD(tva.deductibleTVA, currency)} />
                  <KpiRow label="TVA à payer" value={fmtDZD(tva.netTVADue, currency)} strong />
                </div>
              ) : null}
            </div>

            {!g50 && !tva && !fiscalBusy && !fiscalError ? (
              <EmptyNote>
                Choisissez l’exercice et le mois puis cliquez « Calculer ».
              </EmptyNote>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {tab === 'facture' ? (
        <Panel title="Facture Normalisée (Art. 23 LF 2022)">
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: C.text }}>Vendeur</div>
                <Field label="Raison sociale">
                  <input
                    value={seller.name}
                    onChange={e => setSeller(s => ({ ...s, name: e.target.value }))}
                    style={inputStyle}
                  />
                </Field>
                <Field label="Adresse">
                  <input
                    value={seller.address}
                    onChange={e => setSeller(s => ({ ...s, address: e.target.value }))}
                    style={inputStyle}
                  />
                </Field>
                <Field label="NIF" hint="15 chiffres">
                  <input
                    value={seller.nif}
                    onChange={e => setSeller(s => ({ ...s, nif: e.target.value }))}
                    style={inputStyle}
                  />
                </Field>
                <Field label="RC">
                  <input
                    value={seller.rc}
                    onChange={e => setSeller(s => ({ ...s, rc: e.target.value }))}
                    style={inputStyle}
                  />
                </Field>
                <Field label="AIS" hint="Article d’imposition (optionnel)">
                  <input
                    value={seller.ais}
                    onChange={e => setSeller(s => ({ ...s, ais: e.target.value }))}
                    style={inputStyle}
                  />
                </Field>
              </div>
              <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: C.text }}>Acheteur</div>
                <Field label="Raison sociale">
                  <input
                    value={buyer.name}
                    onChange={e => setBuyer(b => ({ ...b, name: e.target.value }))}
                    style={inputStyle}
                  />
                </Field>
                <Field label="Adresse">
                  <input
                    value={buyer.address}
                    onChange={e => setBuyer(b => ({ ...b, address: e.target.value }))}
                    style={inputStyle}
                  />
                </Field>
                <Field label="NIF" hint="15 chiffres">
                  <input
                    value={buyer.nif}
                    onChange={e => setBuyer(b => ({ ...b, nif: e.target.value }))}
                    style={inputStyle}
                  />
                </Field>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <div style={inputColStyle}>
                    <Field label="N° facture">
                      <input
                        value={invoiceNumber}
                        onChange={e => setInvoiceNumber(e.target.value)}
                        placeholder="FAC-2026-001"
                        style={inputStyle}
                      />
                    </Field>
                  </div>
                  <div style={inputColStyle}>
                    <Field label="Date">
                      <input
                        type="date"
                        value={invoiceDate}
                        onChange={e => setInvoiceDate(e.target.value)}
                        style={inputStyle}
                      />
                    </Field>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Description</th>
                    <th style={{ ...thStyle, width: 80 }}>Qté</th>
                    <th style={{ ...thStyle, width: 130 }}>PU HT (DZD)</th>
                    <th style={{ ...thStyle, width: 110 }}>TVA</th>
                    <th style={{ ...thStyle, width: 60 }} />
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={i}>
                      <td style={tdStyle}>
                        <input
                          value={it.description}
                          onChange={e => setItem(i, { description: e.target.value })}
                          placeholder="Produit ou service"
                          style={inputStyle}
                        />
                      </td>
                      <td style={tdStyle}>
                        <input
                          inputMode="numeric"
                          value={it.quantity}
                          onChange={e => setItem(i, { quantity: e.target.value })}
                          style={inputStyle}
                        />
                      </td>
                      <td style={tdStyle}>
                        <input
                          inputMode="numeric"
                          value={it.unitPrice}
                          onChange={e => setItem(i, { unitPrice: e.target.value })}
                          style={inputStyle}
                        />
                      </td>
                      <td style={tdStyle}>
                        <select
                          value={it.tvaRate}
                          onChange={e => setItem(i, { tvaRate: e.target.value })}
                          style={selectStyle}
                        >
                          <option value="0.19">19%</option>
                          <option value="0.09">9%</option>
                          <option value="0">0%</option>
                        </select>
                      </td>
                      <td style={tdStyle}>
                        <button
                          onClick={() => setItems(list => list.filter((_, j) => j !== i))}
                          disabled={items.length <= 1}
                          style={btnStyle('secondary', items.length <= 1)}
                          title="Supprimer la ligne"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <button
                onClick={() =>
                  setItems(list => [
                    ...list,
                    { description: '', quantity: '1', unitPrice: '', tvaRate: '0.19' },
                  ])
                }
                style={btnStyle('secondary')}
              >
                + Ajouter une ligne
              </button>
            </div>

            <div style={{ maxWidth: 380 }}>
              <KpiRow label="Total HT" value={fmtDZD(factureTotals.ht, currency)} />
              <KpiRow label="TVA" value={fmtDZD(factureTotals.tva, currency)} />
              <KpiRow label="Total TTC" value={fmtDZD(factureTotals.ttc, currency)} strong />
              <span style={hintStyle}>
                Timbre fiscal appliqué automatiquement sur la facture générée
                (paiement espèces).
              </span>
            </div>

            {factureError ? <Banner tone="error">{factureError}</Banner> : null}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                onClick={() => void submitFacture()}
                disabled={factureBusy}
                style={btnStyle('primary', factureBusy)}
              >
                {factureBusy ? <Spinner /> : null} Générer la facture
              </button>
              {factureHtml ? (
                <a
                  href={URL.createObjectURL(new Blob([factureHtml], { type: 'text/html' }))}
                  download={`facture-${invoiceNumber || 'normalisee'}.html`}
                  style={{ ...btnStyle('secondary'), textDecoration: 'none' }}
                >
                  Télécharger le HTML
                </a>
              ) : null}
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
};
