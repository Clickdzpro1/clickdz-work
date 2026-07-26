import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  Banner,
  btnStyle,
  C,
  computeInvoiceDoc,
  computeInvoiceLine,
  convertInvoice,
  type CreateInvoiceBody,
  EmptyNote,
  type ErpOrder,
  type ErpSettings,
  fetchErpCollection,
  fetchInvoices,
  Field,
  fmtDZD,
  hintStyle,
  type InvoiceCustomer,
  INVOICE_MAX_LINES,
  INVOICE_PAYMENT_LABELS,
  INVOICE_PAYMENTS,
  INVOICE_STATUS_COLORS,
  INVOICE_STATUS_LABELS,
  INVOICE_TYPE_LABELS,
  INVOICE_TYPES,
  type InvoicePayment,
  type InvoiceStatus,
  type InvoiceType,
  type InvoiceView,
  inputStyle,
  labelStyle,
  miniBtnStyle,
  num,
  orderDate,
  orderTotal,
  Panel,
  postErpSettings,
  postInvoice,
  Spinner,
  tdStyle,
  thStyle,
  validateInvoice,
  voidInvoice,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// FACTURATION studio (WSE-3, R3-a). The owner-facing invoicing surface for one
// store: quotes (devis) → delivery notes (bon de livraison) → invoices
// (facture), with Algerian fiscal fields (RC/NIF/NIS/ART), TVA-per-line + timbre
// math (mirrored CLIENT-side for live display only — the R2 bridge always
// recomputes on save), gap-less legal numbering assigned at Valider, void, and
// convert. Plus an A4 PRINT sheet (window.print(), printing ONLY the sheet) that
// renders a professional French facture from the store's seller identity
// (seller* settings keys) + the invoice, and an "Afficher dans l'app" toggle
// that publishes the `factures` module to the deployed ERP via the erpBackends
// CSV settings key.
//
// Everything reads/writes through the authed bridge routes (fetchInvoices /
// postInvoice / validateInvoice / voidInvoice / convertInvoice from
// shoperp-shared); orders for "Créer depuis commande" come from the public
// per-slug data API (fetchErpCollection). Flag-off (CDZ_ERP_INVOICING) → the
// whole route family 404s → a QUIET "activation en attente" state, never a
// crash. Inline styles only (Panel/Field/Banner/Spinner/btnStyle from
// shoperp-shared), mobile single-column, FR labels. loading + error + empty +
// read-only states are all handled.
// ---------------------------------------------------------------------------

const MODULE_ID = 'factures';

/** The three doc types + an "all" pseudo-value for the list filter. */
type TypeFilter = InvoiceType | 'all';
type StatusFilter = InvoiceStatus | 'all';

/** YYYY-MM for the current UTC month (the default month picker value). */
function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** A blank editable line (label/qty/PU HT/TVA). Local editor state is strings. */
interface DraftLine {
  key: string;
  ref: string;
  label: string;
  qty: string;
  unitHT: string;
  tvaRate: string;
}

let lineKeySeq = 0;
function makeLine(seed?: Partial<DraftLine>): DraftLine {
  lineKeySeq += 1;
  return {
    key: `ln-${lineKeySeq}`,
    ref: '',
    label: '',
    qty: '1',
    unitHT: '',
    tvaRate: String(INVOICE_DEFAULT_TVA_FALLBACK),
    ...seed,
  };
}

// The default TVA the editor pre-fills (the store settings can override; the
// server holds the authoritative env default). Kept local to avoid a hard dep.
const INVOICE_DEFAULT_TVA_FALLBACK = 19;

/** Map a stored InvoiceView back into editable draft lines. */
function linesToDraft(inv: InvoiceView): DraftLine[] {
  if (!inv.lines.length) return [makeLine()];
  return inv.lines.map(l =>
    makeLine({
      ref: l.ref || '',
      label: l.label,
      qty: String(l.qty),
      unitHT: String(l.unitHT),
      tvaRate: String(l.tvaRate),
    })
  );
}

// FR labels for the server's machine `reason` codes (invalid_invoice bodies).
const REASON_FR: Record<string, string> = {
  invalid_type: 'Type de document invalide.',
  customer_required: 'Renseignez le client.',
  customer_name_required: 'Le nom du client est obligatoire.',
  lines_required: 'Ajoutez au moins une ligne.',
  too_many_lines: `Trop de lignes (max ${INVOICE_MAX_LINES}).`,
  invalid_line: 'Une ligne est invalide.',
  line_label_required: 'Chaque ligne doit avoir une désignation.',
  line_qty_invalid: 'Quantité invalide sur une ligne.',
  line_price_invalid: 'Prix unitaire invalide sur une ligne.',
  line_tva_invalid: 'Taux de TVA invalide sur une ligne.',
  order_has_no_lines: 'La commande ne contient aucun article.',
  not_a_draft: 'Ce document n’est plus un brouillon.',
  already_void: 'Ce document est déjà annulé.',
  illegal_conversion: 'Conversion non autorisée.',
  source_void: 'Le document source est annulé.',
};

function reasonFr(reason: string): string {
  return REASON_FR[reason] || 'Saisie invalide — vérifiez le formulaire.';
}

// ===========================================================================
// Main panel — owns the flag-off gate, the list/editor view switch, and the
// shared seller-identity + "show in app" settings. Accepts the dashboard's
// scope props (slug/settings/readOnly/onWritesBlocked/onMutated).
// ===========================================================================
export const InvoicingPanel = ({
  slug,
  settings,
  readOnly = false,
  onWritesBlocked,
  onMutated,
}: {
  /** The store's slug — its data-API namespace + authed bridge namespace. */
  slug: string;
  /** The live settings singleton (from the ERP summary) — seller* + erpBackends. */
  settings?: ErpSettings;
  readOnly?: boolean;
  onWritesBlocked?: () => void;
  onMutated?: () => void;
}) => {
  const [view, setView] = useState<
    { kind: 'list' } | { kind: 'edit'; invoice: InvoiceView | null }
  >({ kind: 'list' });

  // Feature-availability gate: fetchInvoices reports 'not-found' when the whole
  // route family 404s (CDZ_ERP_INVOICING off). We latch it so the page renders
  // the quiet activation state instead of the list.
  const [flagOff, setFlagOff] = useState(false);

  const handleWritesBlocked = useCallback(() => {
    onWritesBlocked?.();
  }, [onWritesBlocked]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {flagOff ? (
        <Banner tone="info">
          <strong>Facturation — activation en attente.</strong> Ce module
          (devis, bons de livraison, factures) sera bientôt disponible sur votre
          espace. Rien à faire de votre côté — il s’activera automatiquement.
        </Banner>
      ) : (
        <>
          <SellerIdentityPanel
            slug={slug}
            settings={settings}
            readOnly={readOnly}
            onWritesBlocked={handleWritesBlocked}
            onMutated={onMutated}
          />
          <ShowInAppPanel
            slug={slug}
            settings={settings}
            readOnly={readOnly}
            onWritesBlocked={handleWritesBlocked}
            onMutated={onMutated}
          />
          {view.kind === 'list' ? (
            <InvoiceList
              slug={slug}
              onFlagOff={() => setFlagOff(true)}
              onCreate={() => setView({ kind: 'edit', invoice: null })}
              onOpen={inv => setView({ kind: 'edit', invoice: inv })}
            />
          ) : (
            <InvoiceEditor
              slug={slug}
              settings={settings}
              initial={view.invoice}
              readOnly={readOnly}
              onWritesBlocked={handleWritesBlocked}
              onFlagOff={() => {
                setFlagOff(true);
                setView({ kind: 'list' });
              }}
              onDone={() => {
                setView({ kind: 'list' });
                onMutated?.();
              }}
              onBack={() => setView({ kind: 'list' })}
            />
          )}
        </>
      )}
    </div>
  );
};

// ===========================================================================
// LIST VIEW — month picker + type/status filters + rows (n°, date, client, TTC,
// status). Loading / error / empty / flag-off states.
// ===========================================================================
const InvoiceList = ({
  slug,
  onFlagOff,
  onCreate,
  onOpen,
}: {
  slug: string;
  onFlagOff: () => void;
  onCreate: () => void;
  onOpen: (inv: InvoiceView) => void;
}) => {
  const [month, setMonth] = useState<string>(currentMonth());
  const [typeF, setTypeF] = useState<TypeFilter>('all');
  const [statusF, setStatusF] = useState<StatusFilter>('all');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [rows, setRows] = useState<InvoiceView[]>([]);

  const load = useCallback(async () => {
    setPhase('loading');
    const out = await fetchInvoices(slug, {
      month,
      type: typeF === 'all' ? '' : typeF,
      status: statusF === 'all' ? '' : statusF,
    });
    if (out.status === 'ok') {
      setRows(out.invoices);
      setPhase('ready');
    } else if (out.status === 'not-found') {
      onFlagOff();
    } else {
      setErrMsg(out.message);
      setPhase('error');
    }
  }, [slug, month, typeF, statusF, onFlagOff]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel
      title="Factures"
      action={
        <button style={miniBtnStyle('primary')} onClick={onCreate}>
          + Nouveau document
        </button>
      }
    >
      {/* Filters ---------------------------------------------------------- */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>Mois</span>
          <input
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value || currentMonth())}
            style={{ ...inputStyle, width: 'auto', minWidth: 150 }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>Type</span>
          <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
            <FilterChip
              active={typeF === 'all'}
              onClick={() => setTypeF('all')}
              label="Tous"
            />
            {INVOICE_TYPES.map(t => (
              <FilterChip
                key={t}
                active={typeF === t}
                onClick={() => setTypeF(t)}
                label={INVOICE_TYPE_LABELS[t]}
              />
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>Statut</span>
          <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
            <FilterChip
              active={statusF === 'all'}
              onClick={() => setStatusF('all')}
              label="Tous"
            />
            {(['brouillon', 'valide', 'annule'] as InvoiceStatus[]).map(s => (
              <FilterChip
                key={s}
                active={statusF === s}
                onClick={() => setStatusF(s)}
                label={INVOICE_STATUS_LABELS[s]}
                color={INVOICE_STATUS_COLORS[s]}
              />
            ))}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button
          style={miniBtnStyle('secondary', phase === 'loading')}
          disabled={phase === 'loading'}
          onClick={() => void load()}
        >
          {phase === 'loading' ? <Spinner /> : <span aria-hidden>↻</span>}{' '}
          Actualiser
        </button>
      </div>

      {/* Body ------------------------------------------------------------- */}
      {phase === 'loading' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '22px 4px',
            color: C.muted,
          }}
        >
          <Spinner /> Chargement des factures…
        </div>
      ) : phase === 'error' ? (
        <Banner tone="error">
          {errMsg}{' '}
          <button style={linkish} onClick={() => void load()}>
            Réessayer
          </button>
        </Banner>
      ) : rows.length === 0 ? (
        <EmptyNote>
          Aucun document pour {month}. Créez un devis, un bon de livraison ou une
          facture — ou changez de mois.
        </EmptyNote>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}
          >
            <thead>
              <tr>
                {['N°', 'Date', 'Type', 'Client', 'TTC', 'Statut'].map(h => (
                  <th key={h} style={thStyle}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(inv => (
                <tr
                  key={inv.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => onOpen(inv)}
                >
                  <td
                    style={{
                      ...tdStyle,
                      fontFamily: 'var(--affine-font-code-family, monospace)',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {inv.status === 'brouillon'
                      ? '— (brouillon)'
                      : invoiceNumber(inv)}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                    {inv.date || '—'}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                    {INVOICE_TYPE_LABELS[inv.type]}
                  </td>
                  <td style={tdStyle}>{inv.customer.name || '—'}</td>
                  <td
                    style={{ ...tdStyle, fontWeight: 700, whiteSpace: 'nowrap' }}
                  >
                    {fmtDZD(inv.totalTTC)}
                  </td>
                  <td style={tdStyle}>
                    <InvoiceStatusBadge status={inv.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
};

// ===========================================================================
// EDITOR — create OR open one document. Client block (name + collapsible fiscal
// fields), lines editor with live client-side totals, and the lifecycle actions
// (save draft / valider / annuler / convertir) + the A4 print sheet.
// ===========================================================================
const InvoiceEditor = ({
  slug,
  settings,
  initial,
  readOnly,
  onWritesBlocked,
  onFlagOff,
  onBack,
}: {
  slug: string;
  settings?: ErpSettings;
  initial: InvoiceView | null;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onFlagOff: () => void;
  onDone: () => void;
  onBack: () => void;
}) => {
  // The live server-persisted record (null until a draft is saved). When set,
  // the lifecycle buttons (valider/annuler/convertir) act on it.
  const [saved, setSaved] = useState<InvoiceView | null>(initial);

  const [type, setType] = useState<InvoiceType>(initial?.type ?? 'facture');
  const [payment, setPayment] = useState<InvoicePayment>(
    initial?.payment ?? 'cod'
  );
  const [cust, setCust] = useState<InvoiceCustomer>(
    initial?.customer ?? { name: '' }
  );
  const [showFiscal, setShowFiscal] = useState<boolean>(
    !!(
      initial &&
      (initial.customer.rc ||
        initial.customer.nif ||
        initial.customer.nis ||
        initial.customer.art ||
        initial.customer.address)
    )
  );
  const [lines, setLines] = useState<DraftLine[]>(
    initial ? linesToDraft(initial) : [makeLine()]
  );

  const [busy, setBusy] = useState<null | 'save' | 'validate' | 'void' | 'convert'>(
    null
  );
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error' | 'info';
    text: string;
  } | null>(null);
  // Recent orders for the "Créer depuis commande" picker (fetched lazily).
  const [orderPickerOpen, setOrderPickerOpen] = useState(false);

  const isLocked =
    !!saved && (saved.status === 'valide' || saved.status === 'annule');
  const editable = !readOnly && !isLocked;

  // ---- Live totals (client-side mirror of the backend math; display only) --
  const totals = useMemo(() => {
    const parsed = lines.map(l => ({
      qty: num(l.qty),
      unitHT: num(l.unitHT),
      tvaRate: num(l.tvaRate),
    }));
    return computeInvoiceDoc(type, parsed, payment);
  }, [lines, type, payment]);

  // TVA breakdown by rate (for the print sheet + totals card).
  const tvaBreakdown = useMemo(() => {
    const map = new Map<number, { base: number; tva: number }>();
    for (const l of lines) {
      const { lineHT, lineTVA } = computeInvoiceLine(
        num(l.qty),
        num(l.unitHT),
        num(l.tvaRate)
      );
      const rate = num(l.tvaRate);
      const cur = map.get(rate) ?? { base: 0, tva: 0 };
      cur.base += lineHT;
      cur.tva += lineTVA;
      map.set(rate, cur);
    }
    return [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rate, v]) => ({ rate, base: v.base, tva: v.tva }));
  }, [lines]);

  const setCustField = useCallback(
    (k: keyof InvoiceCustomer, v: string) => {
      setCust(c => ({ ...c, [k]: v }));
    },
    []
  );

  const updateLine = useCallback(
    (key: string, patch: Partial<DraftLine>) => {
      setLines(cur => cur.map(l => (l.key === key ? { ...l, ...patch } : l)));
    },
    []
  );
  const addLine = useCallback(() => {
    setLines(cur =>
      cur.length >= INVOICE_MAX_LINES ? cur : [...cur, makeLine()]
    );
  }, []);
  const removeLine = useCallback((key: string) => {
    setLines(cur => (cur.length <= 1 ? cur : cur.filter(l => l.key !== key)));
  }, []);

  // ---- Build the create body from the editor state ------------------------
  const buildBody = useCallback((): CreateInvoiceBody => {
    const clean: InvoiceCustomer = { name: cust.name.trim() };
    for (const k of ['rc', 'nif', 'nis', 'art', 'address'] as const) {
      const v = (cust[k] || '').trim();
      if (v) clean[k] = v;
    }
    return {
      type,
      payment,
      customer: clean,
      lines: lines.map(l => ({
        ...(l.ref.trim() ? { ref: l.ref.trim() } : {}),
        label: l.label.trim(),
        qty: num(l.qty),
        unitHT: num(l.unitHT),
        tvaRate: num(l.tvaRate),
      })),
    };
  }, [cust, type, payment, lines]);

  const mapMutate = useCallback(
    (
      out: Awaited<ReturnType<typeof postInvoice>>,
      okText: string
    ): InvoiceView | null => {
      if (out.status === 'ok') {
        setNotice({ tone: 'ok', text: okText });
        return out.invoice;
      }
      if (out.status === 'unavailable') {
        onWritesBlocked();
        setNotice({
          tone: 'error',
          text: 'Les écritures sont indisponibles sur ce serveur — réessayez plus tard.',
        });
      } else if (out.status === 'not-found') {
        onFlagOff();
      } else if (out.status === 'invalid') {
        setNotice({ tone: 'error', text: reasonFr(out.reason) });
      } else if (out.status === 'conflict') {
        setNotice({
          tone: 'error',
          text:
            out.reason === 'invoice_not_draft'
              ? 'Ce document n’est plus un brouillon.'
              : out.reason === 'invoice_already_void'
                ? 'Ce document est déjà annulé.'
                : reasonFr(out.reason),
        });
      } else {
        setNotice({ tone: 'error', text: out.message });
      }
      return null;
    },
    [onWritesBlocked, onFlagOff]
  );

  // Client-side pre-checks (the server re-validates) so we fail fast + friendly.
  const preValidate = useCallback((): string | null => {
    if (!cust.name.trim()) return 'Le nom du client est obligatoire.';
    const usable = lines.filter(l => l.label.trim());
    if (usable.length === 0) return 'Ajoutez au moins une ligne (désignation).';
    for (const l of usable) {
      if (!(num(l.qty) > 0)) return `Quantité invalide pour « ${l.label.trim()} ».`;
      if (num(l.unitHT) < 0) return `Prix unitaire invalide pour « ${l.label.trim()} ».`;
    }
    return null;
  }, [cust, lines]);

  const doSave = useCallback(async () => {
    if (!editable || busy) return;
    setNotice(null);
    const err = preValidate();
    if (err) {
      setNotice({ tone: 'error', text: err });
      return;
    }
    setBusy('save');
    const body = buildBody();
    // Only send labelled lines (blank rows are editor scaffolding).
    body.lines = (body.lines || []).filter(l => l.label);
    const out = await postInvoice(slug, body);
    const inv = mapMutate(out, 'Brouillon enregistré.');
    if (inv) {
      setSaved(inv);
      setLines(linesToDraft(inv));
      setCust(inv.customer);
      setType(inv.type);
      if (inv.payment) setPayment(inv.payment);
    }
    setBusy(null);
  }, [editable, busy, preValidate, buildBody, slug, mapMutate]);

  const doValidate = useCallback(async () => {
    if (!saved || busy) return;
    setNotice(null);
    setBusy('validate');
    const out = await validateInvoice(slug, saved.id);
    const inv = mapMutate(out, 'Document validé — numéro légal attribué.');
    if (inv) {
      setSaved(inv);
      setLines(linesToDraft(inv));
    }
    setBusy(null);
  }, [saved, busy, slug, mapMutate]);

  const doVoid = useCallback(async () => {
    if (!saved || busy) return;
    setNotice(null);
    setBusy('void');
    const out = await voidInvoice(slug, saved.id);
    const inv = mapMutate(out, 'Document annulé.');
    if (inv) setSaved(inv);
    setBusy(null);
  }, [saved, busy, slug, mapMutate]);

  const doConvert = useCallback(
    async (to: InvoiceType) => {
      if (!saved || busy) return;
      setNotice(null);
      setBusy('convert');
      const out = await convertInvoice(slug, saved.id, to);
      const inv = mapMutate(
        out,
        `Nouveau brouillon (${INVOICE_TYPE_LABELS[to]}) créé depuis ce document.`
      );
      if (inv) {
        // Switch the editor to the freshly-minted draft.
        setSaved(inv);
        setType(inv.type);
        if (inv.payment) setPayment(inv.payment);
        setCust(inv.customer);
        setLines(linesToDraft(inv));
      }
      setBusy(null);
    },
    [saved, busy, slug, mapMutate]
  );

  // Convert targets: devis→BL / devis→facture / BL→facture (never backwards).
  const convertTargets: InvoiceType[] = useMemo(() => {
    if (!saved || saved.status === 'annule') return [];
    if (saved.type === 'devis') return ['bl', 'facture'];
    if (saved.type === 'bl') return ['facture'];
    return [];
  }, [saved]);

  const applyOrder = useCallback((order: ErpOrder) => {
    // Map an order → editable lines + client, mirroring buildInvoiceFromOrder.
    const items = Array.isArray(order.items) ? order.items : [];
    const drafted: DraftLine[] = items.length
      ? items.map(it =>
          makeLine({
            ref: String(it.id || ''),
            label: String(it.title || it.name || it.product || 'Article'),
            qty: String(it.qty != null ? num(it.qty) : 1),
            unitHT: String(num(it.price)),
            tvaRate: String(INVOICE_DEFAULT_TVA_FALLBACK),
          })
        )
      : [makeLine()];
    setLines(drafted);
    setCust({
      name: String(order.customer || 'Client'),
      ...(order.address ? { address: String(order.address) } : {}),
    });
    setType('facture');
    setPayment('cod');
    setOrderPickerOpen(false);
    setNotice({
      tone: 'info',
      text: `Pré-rempli depuis la commande ${order.ref || ''}. Vérifiez puis enregistrez.`,
    });
  }, []);

  const seller = useMemo(() => readSeller(settings), [settings]);

  const headingType = saved ? saved.type : type;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header row ------------------------------------------------------- */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
      >
        <button style={{ ...linkish, fontWeight: 700 }} onClick={onBack}>
          ← Factures
        </button>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>
            {saved
              ? `${INVOICE_TYPE_LABELS[headingType]} ${
                  saved.status === 'brouillon' ? '(brouillon)' : invoiceNumber(saved)
                }`
              : 'Nouveau document'}
          </div>
          {saved ? (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              {INVOICE_STATUS_LABELS[saved.status]} · {saved.date}
            </div>
          ) : null}
        </div>
        {saved && saved.status !== 'annule' ? (
          <button
            style={miniBtnStyle('secondary')}
            onClick={() => window.print()}
            title="Imprimer ou enregistrer en PDF (format A4)"
          >
            🖨️ Imprimer / PDF
          </button>
        ) : null}
      </div>

      {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
      {readOnly ? (
        <Banner tone="warn">
          Les écritures sont désactivées sur ce serveur — cet éditeur est en
          lecture seule.
        </Banner>
      ) : null}
      {isLocked ? (
        <Banner tone="info">
          {saved?.status === 'valide'
            ? 'Document validé (numéro légal attribué) — non modifiable. Vous pouvez l’imprimer, l’annuler ou le convertir.'
            : 'Document annulé — conservé pour la traçabilité légale.'}
        </Banner>
      ) : null}

      {/* Type + payment + create-from-order (only while a new draft) ------- */}
      {!saved ? (
        <Panel title="Type de document">
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 16,
              alignItems: 'flex-end',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={labelStyle}>Type</span>
              <div style={{ display: 'inline-flex', gap: 4 }}>
                {INVOICE_TYPES.map(t => (
                  <FilterChip
                    key={t}
                    active={type === t}
                    onClick={() => editable && setType(t)}
                    label={INVOICE_TYPE_LABELS[t]}
                  />
                ))}
              </div>
            </div>
            <PaymentSelect
              value={payment}
              disabled={!editable}
              onChange={setPayment}
            />
            <div style={{ flex: 1 }} />
            <button
              style={miniBtnStyle('secondary')}
              disabled={!editable}
              onClick={() => setOrderPickerOpen(true)}
            >
              📦 Créer depuis une commande
            </button>
          </div>
          {type === 'facture' &&
          (payment === 'cash' || payment === 'cod') ? (
            <div style={{ ...hintStyle, marginTop: 8 }}>
              Un timbre fiscal ({INVOICE_TIMBRE_RATE_LABEL}) s’applique aux
              factures réglées en espèces / à la livraison.
            </div>
          ) : null}
        </Panel>
      ) : null}

      {orderPickerOpen ? (
        <OrderPicker
          slug={slug}
          onPick={applyOrder}
          onClose={() => setOrderPickerOpen(false)}
        />
      ) : null}

      {/* Client block ----------------------------------------------------- */}
      <Panel
        title="Client"
        action={
          <button
            style={linkish}
            onClick={() => setShowFiscal(v => !v)}
            type="button"
          >
            {showFiscal ? 'Masquer les champs fiscaux' : 'Champs fiscaux (RC/NIF…)'}
          </button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Nom / Raison sociale">
            <input
              style={inputStyle}
              value={cust.name}
              maxLength={120}
              disabled={!editable}
              placeholder="Ex. SARL Exemple / Client comptoir"
              onChange={e => setCustField('name', e.target.value)}
            />
          </Field>
          {showFiscal ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 10,
              }}
            >
              <Field label="RC">
                <input
                  style={inputStyle}
                  value={cust.rc || ''}
                  maxLength={60}
                  disabled={!editable}
                  placeholder="Registre de commerce"
                  onChange={e => setCustField('rc', e.target.value)}
                />
              </Field>
              <Field label="NIF">
                <input
                  style={inputStyle}
                  value={cust.nif || ''}
                  maxLength={60}
                  disabled={!editable}
                  placeholder="N° d’identification fiscale"
                  onChange={e => setCustField('nif', e.target.value)}
                />
              </Field>
              <Field label="NIS">
                <input
                  style={inputStyle}
                  value={cust.nis || ''}
                  maxLength={60}
                  disabled={!editable}
                  placeholder="N° d’identification statistique"
                  onChange={e => setCustField('nis', e.target.value)}
                />
              </Field>
              <Field label="Art. (article d’imposition)">
                <input
                  style={inputStyle}
                  value={cust.art || ''}
                  maxLength={60}
                  disabled={!editable}
                  onChange={e => setCustField('art', e.target.value)}
                />
              </Field>
              <div style={{ gridColumn: '1 / -1' }}>
                <Field label="Adresse">
                  <input
                    style={inputStyle}
                    value={cust.address || ''}
                    maxLength={200}
                    disabled={!editable}
                    placeholder="Adresse du client"
                    onChange={e => setCustField('address', e.target.value)}
                  />
                </Field>
              </div>
            </div>
          ) : null}
        </div>
      </Panel>

      {/* Lines editor ----------------------------------------------------- */}
      <Panel
        title="Lignes"
        action={
          editable ? (
            <button
              style={miniBtnStyle('secondary', lines.length >= INVOICE_MAX_LINES)}
              disabled={lines.length >= INVOICE_MAX_LINES}
              onClick={addLine}
            >
              + Ligne
            </button>
          ) : undefined
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}
          >
            <thead>
              <tr>
                <th style={{ ...thStyle, minWidth: 180 }}>Désignation</th>
                <th style={{ ...thStyle, width: 90 }}>Qté</th>
                <th style={{ ...thStyle, width: 120 }}>PU HT</th>
                <th style={{ ...thStyle, width: 90 }}>TVA %</th>
                <th style={{ ...thStyle, width: 120 }}>Total HT</th>
                {editable ? <th style={{ ...thStyle, width: 40 }} /> : null}
              </tr>
            </thead>
            <tbody>
              {lines.map(l => {
                const { lineHT } = computeInvoiceLine(
                  num(l.qty),
                  num(l.unitHT),
                  num(l.tvaRate)
                );
                return (
                  <tr key={l.key}>
                    <td style={tdStyle}>
                      <input
                        style={cellInput}
                        value={l.label}
                        maxLength={160}
                        disabled={!editable}
                        placeholder="Article / prestation"
                        onChange={e =>
                          updateLine(l.key, { label: e.target.value })
                        }
                      />
                    </td>
                    <td style={tdStyle}>
                      <input
                        style={{ ...cellInput, textAlign: 'right' }}
                        value={l.qty}
                        inputMode="decimal"
                        disabled={!editable}
                        onChange={e => updateLine(l.key, { qty: e.target.value })}
                      />
                    </td>
                    <td style={tdStyle}>
                      <input
                        style={{ ...cellInput, textAlign: 'right' }}
                        value={l.unitHT}
                        inputMode="decimal"
                        disabled={!editable}
                        placeholder="0"
                        onChange={e =>
                          updateLine(l.key, { unitHT: e.target.value })
                        }
                      />
                    </td>
                    <td style={tdStyle}>
                      <input
                        style={{ ...cellInput, textAlign: 'right' }}
                        value={l.tvaRate}
                        inputMode="decimal"
                        disabled={!editable}
                        onChange={e =>
                          updateLine(l.key, { tvaRate: e.target.value })
                        }
                      />
                    </td>
                    <td
                      style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}
                    >
                      {fmtDZD(lineHT)}
                    </td>
                    {editable ? (
                      <td style={{ ...tdStyle, textAlign: 'center' }}>
                        <button
                          style={{
                            ...linkish,
                            color: 'var(--affine-error-color, #eb4b4b)',
                            opacity: lines.length <= 1 ? 0.4 : 1,
                          }}
                          disabled={lines.length <= 1}
                          onClick={() => removeLine(l.key)}
                          title="Supprimer la ligne"
                        >
                          ✕
                        </button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Live totals (client-side mirror; the server recomputes on save) - */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginTop: 12,
          }}
        >
          <div
            style={{
              minWidth: 260,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 13,
            }}
          >
            <TotalRow label="Total HT" value={fmtDZD(totals.totalHT)} />
            {tvaBreakdown
              .filter(b => b.rate > 0)
              .map(b => (
                <TotalRow
                  key={b.rate}
                  label={`TVA ${b.rate}%`}
                  value={fmtDZD(b.tva)}
                  muted
                />
              ))}
            <TotalRow label="Total TVA" value={fmtDZD(totals.totalTVA)} />
            {totals.timbre > 0 ? (
              <TotalRow label="Timbre fiscal" value={fmtDZD(totals.timbre)} />
            ) : null}
            <TotalRow
              label="Total TTC"
              value={fmtDZD(totals.totalTTC)}
              strong
            />
            <div style={{ ...hintStyle, fontSize: 11 }}>
              Totaux indicatifs — le serveur recalcule à l’enregistrement.
            </div>
          </div>
        </div>
      </Panel>

      {/* Lifecycle actions ------------------------------------------------- */}
      <div
        style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}
      >
        {editable ? (
          <button
            style={btnStyle('primary', busy === 'save')}
            disabled={busy === 'save'}
            onClick={() => void doSave()}
          >
            {busy === 'save' ? (
              <>
                <Spinner dark /> Enregistrement…
              </>
            ) : saved ? (
              'Enregistrer les modifications'
            ) : (
              'Enregistrer le brouillon'
            )}
          </button>
        ) : null}

        {saved && saved.status === 'brouillon' ? (
          <button
            style={btnStyle('primary', busy === 'validate')}
            disabled={!!busy}
            onClick={() => void doValidate()}
            title="Attribue le numéro légal (gap-less) et fige le document"
          >
            {busy === 'validate' ? (
              <>
                <Spinner dark /> Validation…
              </>
            ) : (
              '✓ Valider'
            )}
          </button>
        ) : null}

        {convertTargets.map(to => (
          <button
            key={to}
            style={btnStyle('secondary', busy === 'convert')}
            disabled={!!busy}
            onClick={() => void doConvert(to)}
          >
            {busy === 'convert' ? (
              <Spinner />
            ) : (
              <span aria-hidden>↳</span>
            )}{' '}
            Convertir en {INVOICE_TYPE_LABELS[to]}
          </button>
        ))}

        {saved && saved.status !== 'annule' ? (
          <button
            style={btnStyle('danger', busy === 'void')}
            disabled={!!busy}
            onClick={() => void doVoid()}
          >
            {busy === 'void' ? <Spinner /> : null} Annuler le document
          </button>
        ) : null}
      </div>

      {/* Hidden A4 print sheet — printed by window.print() via @media print. */}
      <InvoicePrintSheet
        seller={seller}
        type={headingType}
        number={saved && saved.status !== 'brouillon' ? invoiceNumber(saved) : ''}
        status={saved?.status ?? 'brouillon'}
        date={saved?.date || todayISO()}
        payment={payment}
        customer={cust}
        lines={lines}
        totals={totals}
        tvaBreakdown={tvaBreakdown}
      />
    </div>
  );
};

// ===========================================================================
// CRÉER DEPUIS COMMANDE — pick a recent order from the public data API.
// ===========================================================================
const OrderPicker = ({
  slug,
  onPick,
  onClose,
}: {
  slug: string;
  onPick: (order: ErpOrder) => void;
  onClose: () => void;
}) => {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [orders, setOrders] = useState<ErpOrder[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows = await fetchErpCollection<ErpOrder>(slug, 'orders');
        if (!alive) return;
        setOrders(rows.slice(0, 40));
        setPhase('ready');
      } catch {
        if (!alive) return;
        setPhase('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  return (
    <Panel
      title="Choisir une commande"
      action={
        <button style={linkish} onClick={onClose}>
          Fermer
        </button>
      }
    >
      {phase === 'loading' ? (
        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            padding: '14px 4px',
            color: C.muted,
          }}
        >
          <Spinner /> Chargement des commandes…
        </div>
      ) : phase === 'error' ? (
        <Banner tone="error">
          Impossible de charger les commandes pour l’instant.
        </Banner>
      ) : orders.length === 0 ? (
        <EmptyNote>Aucune commande à convertir pour le moment.</EmptyNote>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}
          >
            <thead>
              <tr>
                {['Réf', 'Date', 'Client', 'Total', ''].map(h => (
                  <th key={h} style={thStyle}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <tr key={String(o.ref || o.id)}>
                  <td
                    style={{
                      ...tdStyle,
                      fontFamily: 'var(--affine-font-code-family, monospace)',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {o.ref || '—'}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                    {orderDate(o) || '—'}
                  </td>
                  <td style={tdStyle}>{o.customer || '—'}</td>
                  <td style={{ ...tdStyle, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {fmtDZD(orderTotal(o))}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <button
                      style={miniBtnStyle('primary')}
                      onClick={() => onPick(o)}
                    >
                      Utiliser
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
};

// ===========================================================================
// SELLER IDENTITY settings — the seller* keys (written via postErpSettings).
// These populate the A4 facture header + legal footer.
// ===========================================================================
interface SellerIdentity {
  name: string;
  rc: string;
  nif: string;
  nis: string;
  art: string;
  address: string;
  phone: string;
}

function readSeller(settings?: ErpSettings): SellerIdentity {
  const s = (settings ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : '');
  return {
    name: str('sellerName') || str('shopName'),
    rc: str('sellerRc'),
    nif: str('sellerNif'),
    nis: str('sellerNis'),
    art: str('sellerArt'),
    address: str('sellerAddress'),
    phone: str('sellerPhone') || str('whatsapp'),
  };
}

const SellerIdentityPanel = ({
  slug,
  settings,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  slug: string;
  settings?: ErpSettings;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated?: () => void;
}) => {
  const stored = useMemo(() => readSeller(settings), [settings]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SellerIdentity>(stored);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(
    null
  );

  useEffect(() => {
    setForm(stored);
  }, [stored]);

  const set = (k: keyof SellerIdentity, v: string) =>
    setForm(f => ({ ...f, [k]: v }));

  const save = useCallback(async () => {
    if (readOnly || saving) return;
    setNotice(null);
    setSaving(true);
    const patch: Partial<ErpSettings> = {
      sellerName: form.name.trim(),
      sellerRc: form.rc.trim(),
      sellerNif: form.nif.trim(),
      sellerNis: form.nis.trim(),
      sellerArt: form.art.trim(),
      sellerAddress: form.address.trim(),
      sellerPhone: form.phone.trim(),
    } as Partial<ErpSettings>;
    const out = await postErpSettings(slug, patch);
    if (out.status === 'ok') {
      setNotice({ tone: 'ok', text: 'Identité vendeur enregistrée.' });
      onMutated?.();
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
    } else {
      setNotice({ tone: 'error', text: out.message });
    }
    setSaving(false);
  }, [readOnly, saving, form, slug, onMutated, onWritesBlocked]);

  return (
    <Panel
      title="Identité vendeur (facture)"
      action={
        <button style={linkish} onClick={() => setOpen(o => !o)}>
          {open ? 'Réduire' : stored.name ? 'Modifier' : 'Configurer'}
        </button>
      }
    >
      {!open ? (
        <div style={{ ...hintStyle }}>
          {stored.name ? (
            <>
              <strong style={{ color: C.text }}>{stored.name}</strong>
              {stored.rc ? ` · RC ${stored.rc}` : ''}
              {stored.nif ? ` · NIF ${stored.nif}` : ''}
              {' — figure en en-tête et pied de vos factures.'}
            </>
          ) : (
            'Renseignez votre raison sociale + RC/NIF/NIS/ART : ils apparaissent sur la facture imprimée (obligatoire légalement).'
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 10,
            }}
          >
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Raison sociale">
                <input
                  style={inputStyle}
                  value={form.name}
                  maxLength={80}
                  disabled={readOnly}
                  onChange={e => set('name', e.target.value)}
                />
              </Field>
            </div>
            <Field label="RC">
              <input
                style={inputStyle}
                value={form.rc}
                maxLength={60}
                disabled={readOnly}
                onChange={e => set('rc', e.target.value)}
              />
            </Field>
            <Field label="NIF">
              <input
                style={inputStyle}
                value={form.nif}
                maxLength={60}
                disabled={readOnly}
                onChange={e => set('nif', e.target.value)}
              />
            </Field>
            <Field label="NIS">
              <input
                style={inputStyle}
                value={form.nis}
                maxLength={60}
                disabled={readOnly}
                onChange={e => set('nis', e.target.value)}
              />
            </Field>
            <Field label="Art. imposition">
              <input
                style={inputStyle}
                value={form.art}
                maxLength={60}
                disabled={readOnly}
                onChange={e => set('art', e.target.value)}
              />
            </Field>
            <Field label="Téléphone">
              <input
                style={inputStyle}
                value={form.phone}
                maxLength={40}
                disabled={readOnly}
                onChange={e => set('phone', e.target.value)}
              />
            </Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Adresse">
                <input
                  style={inputStyle}
                  value={form.address}
                  maxLength={200}
                  disabled={readOnly}
                  onChange={e => set('address', e.target.value)}
                />
              </Field>
            </div>
          </div>
          <div>
            <button
              style={btnStyle('primary', saving || readOnly)}
              disabled={saving || readOnly}
              onClick={() => void save()}
            >
              {saving ? (
                <>
                  <Spinner dark /> Enregistrement…
                </>
              ) : (
                'Enregistrer l’identité'
              )}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
};

// ===========================================================================
// "AFFICHER DANS L'APP" — toggles the `factures` module id in the erpBackends
// CSV (settings key). The published ERP template shows the Factures tab only
// when the module is on AND erpBackends contains the id.
// ===========================================================================
function parseBackends(csv: unknown): string[] {
  if (typeof csv !== 'string' || !csv) return [];
  return csv
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

const ShowInAppPanel = ({
  slug,
  settings,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  slug: string;
  settings?: ErpSettings;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated?: () => void;
}) => {
  const enabled = useMemo(
    () => parseBackends((settings as Record<string, unknown>)?.erpBackends).includes(MODULE_ID),
    [settings]
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(
    null
  );

  const toggle = useCallback(async () => {
    if (readOnly || busy) return;
    setNotice(null);
    setBusy(true);
    const cur = parseBackends((settings as Record<string, unknown>)?.erpBackends);
    const next = enabled
      ? cur.filter(id => id !== MODULE_ID)
      : [...cur.filter(id => id !== MODULE_ID), MODULE_ID];
    const out = await postErpSettings(slug, {
      erpBackends: next.join(','),
    } as Partial<ErpSettings>);
    if (out.status === 'ok') {
      setNotice({
        tone: 'ok',
        text: enabled
          ? 'Module Factures retiré de l’app publiée.'
          : 'Module Factures activé dans l’app publiée. Re-publiez pour l’appliquer.',
      });
      onMutated?.();
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
    } else {
      setNotice({ tone: 'error', text: out.message });
    }
    setBusy(false);
  }, [readOnly, busy, settings, enabled, slug, onMutated, onWritesBlocked]);

  return (
    <Panel title="Afficher dans l’app publiée">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 200, ...hintStyle }}>
          Ajoute un onglet <strong style={{ color: C.text }}>Factures</strong> à
          votre application ERP publiée (le personnel pourra générer des
          documents depuis leur téléphone).
        </div>
        <button
          style={btnStyle(enabled ? 'secondary' : 'primary', busy || readOnly)}
          disabled={busy || readOnly}
          onClick={() => void toggle()}
        >
          {busy ? (
            <Spinner dark={!enabled} />
          ) : enabled ? (
            'Activé ✓ — retirer'
          ) : (
            'Activer dans l’app'
          )}
        </button>
      </div>
      {notice ? (
        <div style={{ marginTop: 10 }}>
          <Banner tone={notice.tone}>{notice.text}</Banner>
        </div>
      ) : null}
    </Panel>
  );
};

// ===========================================================================
// A4 PRINT SHEET — a hidden, print-only professional French facture. The inline
// <style> tag scopes @media print so ONLY this sheet prints (everything else in
// the app is hidden). window.print() (the "Imprimer / PDF" button) drives it.
// ===========================================================================
const InvoicePrintSheet = ({
  seller,
  type,
  number,
  status,
  date,
  payment,
  customer,
  lines,
  totals,
  tvaBreakdown,
}: {
  seller: SellerIdentity;
  type: InvoiceType;
  number: string;
  status: InvoiceStatus;
  date: string;
  payment: InvoicePayment;
  customer: InvoiceCustomer;
  lines: DraftLine[];
  totals: { totalHT: number; totalTVA: number; timbre: number; totalTTC: number };
  tvaBreakdown: Array<{ rate: number; base: number; tva: number }>;
}) => {
  const printable = lines.filter(l => l.label.trim());
  return (
    <div className="cdz-inv-print-root" aria-hidden>
      <style>{PRINT_CSS}</style>
      <div className="cdz-inv-sheet">
        {/* Header: seller identity (left) + document title/number (right) --- */}
        <div className="cdz-inv-head">
          <div className="cdz-inv-seller">
            <div className="cdz-inv-seller-name">
              {seller.name || 'Votre entreprise'}
            </div>
            {seller.address ? (
              <div className="cdz-inv-line">{seller.address}</div>
            ) : null}
            {seller.phone ? (
              <div className="cdz-inv-line">Tél : {seller.phone}</div>
            ) : null}
            <div className="cdz-inv-fiscal">
              {seller.rc ? <span>RC : {seller.rc}</span> : null}
              {seller.nif ? <span>NIF : {seller.nif}</span> : null}
              {seller.nis ? <span>NIS : {seller.nis}</span> : null}
              {seller.art ? <span>Art. : {seller.art}</span> : null}
            </div>
          </div>
          <div className="cdz-inv-doc">
            <div className="cdz-inv-doc-type">{INVOICE_TYPE_LABELS[type]}</div>
            {number ? <div className="cdz-inv-doc-no">N° {number}</div> : null}
            <div className="cdz-inv-line">Date : {date}</div>
            {status === 'annule' ? (
              <div className="cdz-inv-void">ANNULÉ</div>
            ) : status === 'brouillon' ? (
              <div className="cdz-inv-draft">BROUILLON</div>
            ) : null}
          </div>
        </div>

        {/* Client block ---------------------------------------------------- */}
        <div className="cdz-inv-client">
          <div className="cdz-inv-client-title">Client</div>
          <div className="cdz-inv-client-name">{customer.name || '—'}</div>
          {customer.address ? (
            <div className="cdz-inv-line">{customer.address}</div>
          ) : null}
          <div className="cdz-inv-fiscal">
            {customer.rc ? <span>RC : {customer.rc}</span> : null}
            {customer.nif ? <span>NIF : {customer.nif}</span> : null}
            {customer.nis ? <span>NIS : {customer.nis}</span> : null}
            {customer.art ? <span>Art. : {customer.art}</span> : null}
          </div>
        </div>

        {/* Lines table ----------------------------------------------------- */}
        <table className="cdz-inv-table">
          <thead>
            <tr>
              <th className="cdz-inv-th cdz-inv-th-label">Désignation</th>
              <th className="cdz-inv-th cdz-inv-th-num">Qté</th>
              <th className="cdz-inv-th cdz-inv-th-num">PU HT</th>
              <th className="cdz-inv-th cdz-inv-th-num">TVA %</th>
              <th className="cdz-inv-th cdz-inv-th-num">Total HT</th>
            </tr>
          </thead>
          <tbody>
            {printable.length === 0 ? (
              <tr>
                <td className="cdz-inv-td" colSpan={5}>
                  —
                </td>
              </tr>
            ) : (
              printable.map(l => {
                const { lineHT } = computeInvoiceLine(
                  num(l.qty),
                  num(l.unitHT),
                  num(l.tvaRate)
                );
                return (
                  <tr key={l.key}>
                    <td className="cdz-inv-td">
                      {l.ref.trim() ? (
                        <span className="cdz-inv-ref">{l.ref.trim()} · </span>
                      ) : null}
                      {l.label.trim()}
                    </td>
                    <td className="cdz-inv-td cdz-inv-num">{num(l.qty)}</td>
                    <td className="cdz-inv-td cdz-inv-num">
                      {fmtDZD(num(l.unitHT))}
                    </td>
                    <td className="cdz-inv-td cdz-inv-num">{num(l.tvaRate)}%</td>
                    <td className="cdz-inv-td cdz-inv-num">{fmtDZD(lineHT)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {/* Totals + TVA breakdown ------------------------------------------ */}
        <div className="cdz-inv-totals-wrap">
          <table className="cdz-inv-totals">
            <tbody>
              <tr>
                <td className="cdz-inv-tot-label">Total HT</td>
                <td className="cdz-inv-tot-val">{fmtDZD(totals.totalHT)}</td>
              </tr>
              {tvaBreakdown
                .filter(b => b.rate > 0)
                .map(b => (
                  <tr key={b.rate}>
                    <td className="cdz-inv-tot-label cdz-inv-tot-sub">
                      dont TVA {b.rate}% (base {fmtDZD(b.base)})
                    </td>
                    <td className="cdz-inv-tot-val cdz-inv-tot-sub">
                      {fmtDZD(b.tva)}
                    </td>
                  </tr>
                ))}
              <tr>
                <td className="cdz-inv-tot-label">Total TVA</td>
                <td className="cdz-inv-tot-val">{fmtDZD(totals.totalTVA)}</td>
              </tr>
              {totals.timbre > 0 ? (
                <tr>
                  <td className="cdz-inv-tot-label">Timbre fiscal</td>
                  <td className="cdz-inv-tot-val">{fmtDZD(totals.timbre)}</td>
                </tr>
              ) : null}
              <tr className="cdz-inv-tot-grand">
                <td className="cdz-inv-tot-label">Total TTC</td>
                <td className="cdz-inv-tot-val">{fmtDZD(totals.totalTTC)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Payment + legal footer ------------------------------------------ */}
        <div className="cdz-inv-pay">
          Mode de règlement : {INVOICE_PAYMENT_LABELS[payment]}
        </div>
        <div className="cdz-inv-foot">
          {seller.name || 'Votre entreprise'}
          {seller.rc ? ` — RC ${seller.rc}` : ''}
          {seller.nif ? ` — NIF ${seller.nif}` : ''}
          {seller.address ? ` — ${seller.address}` : ''}
        </div>
      </div>
    </div>
  );
};

// The print CSS: the sheet is invisible on screen (0 size, off-canvas); at print
// time we HIDE the app body and reveal ONLY the sheet at A4 with proper margins.
// Uses `visibility` so the print-root can escape overflow-clipped ancestors.
const PRINT_CSS = `
.cdz-inv-print-root{position:absolute;width:0;height:0;overflow:hidden;left:-9999px;top:0;}
@media print{
  @page{size:A4;margin:16mm 14mm;}
  html,body{background:#fff !important;}
  body *{visibility:hidden !important;}
  .cdz-inv-print-root,.cdz-inv-print-root *{visibility:visible !important;}
  .cdz-inv-print-root{position:absolute !important;left:0 !important;top:0 !important;width:100% !important;height:auto !important;overflow:visible !important;}
  .cdz-inv-sheet{width:100%;color:#111;font-family:Arial,'Helvetica Neue',sans-serif;font-size:11pt;line-height:1.45;}
  .cdz-inv-head{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:14px;}
  .cdz-inv-seller-name{font-size:15pt;font-weight:800;margin-bottom:3px;}
  .cdz-inv-line{font-size:9.5pt;color:#222;}
  .cdz-inv-fiscal{margin-top:4px;font-size:9pt;color:#333;display:flex;flex-wrap:wrap;gap:2px 10px;}
  .cdz-inv-doc{text-align:right;}
  .cdz-inv-doc-type{font-size:16pt;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;}
  .cdz-inv-doc-no{font-size:11pt;font-weight:700;margin-top:2px;font-family:monospace;}
  .cdz-inv-void{margin-top:6px;display:inline-block;border:2px solid #c00;color:#c00;font-weight:800;padding:2px 8px;transform:rotate(-4deg);}
  .cdz-inv-draft{margin-top:6px;display:inline-block;border:1px dashed #888;color:#888;font-weight:700;padding:2px 8px;}
  .cdz-inv-client{border:1px solid #ccc;padding:8px 10px;margin-bottom:12px;max-width:60%;}
  .cdz-inv-client-title{font-size:8pt;text-transform:uppercase;letter-spacing:0.06em;color:#666;margin-bottom:2px;}
  .cdz-inv-client-name{font-size:11.5pt;font-weight:700;}
  .cdz-inv-table{width:100%;border-collapse:collapse;margin-bottom:12px;}
  .cdz-inv-th{background:#f2f2f2;border:1px solid #bbb;padding:6px 8px;font-size:9pt;text-transform:uppercase;letter-spacing:0.03em;text-align:left;}
  .cdz-inv-th-num{text-align:right;white-space:nowrap;}
  .cdz-inv-td{border:1px solid #ccc;padding:5px 8px;font-size:10pt;vertical-align:top;}
  .cdz-inv-num{text-align:right;white-space:nowrap;}
  .cdz-inv-ref{color:#666;font-family:monospace;font-size:9pt;}
  .cdz-inv-totals-wrap{display:flex;justify-content:flex-end;margin-bottom:12px;}
  .cdz-inv-totals{border-collapse:collapse;min-width:52%;}
  .cdz-inv-tot-label{padding:4px 10px;font-size:10pt;text-align:left;}
  .cdz-inv-tot-val{padding:4px 10px;font-size:10pt;text-align:right;white-space:nowrap;font-weight:700;border-bottom:1px solid #eee;}
  .cdz-inv-tot-sub .cdz-inv-tot-label,.cdz-inv-tot-sub.cdz-inv-tot-val,.cdz-inv-tot-sub{font-size:8.5pt;color:#666;font-weight:400;}
  .cdz-inv-tot-grand .cdz-inv-tot-label,.cdz-inv-tot-grand .cdz-inv-tot-val{font-size:12pt;font-weight:800;border-top:2px solid #111;border-bottom:none;padding-top:6px;}
  .cdz-inv-pay{font-size:9.5pt;margin-bottom:18px;}
  .cdz-inv-foot{border-top:1px solid #ccc;padding-top:8px;font-size:8.5pt;color:#555;text-align:center;}
}
`;

// ===========================================================================
// Small shared presentational bits (inline styles only).
// ===========================================================================
const INVOICE_TIMBRE_RATE_LABEL = '1% · min 5 DZD';

/** Legal number for display: `<TYPE> AAAA/NNNNN` (server id is type-year-seq). */
function invoiceNumber(inv: InvoiceView): string {
  if (inv.status === 'brouillon' || !inv.seq) return '—';
  const pad = String(inv.seq).padStart(5, '0');
  return `${inv.year}/${pad}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const linkish: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
  color: C.accent,
  textDecoration: 'underline',
};

const cellInput: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  borderRadius: 6,
  fontSize: 12.5,
  fontFamily: 'inherit',
  color: C.text,
  background: C.bg,
  border: `1px solid ${C.border}`,
  outline: 'none',
};

const FilterChip = ({
  active,
  onClick,
  label,
  color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      appearance: 'none',
      cursor: 'pointer',
      borderRadius: 999,
      padding: '5px 12px',
      fontSize: 12,
      fontWeight: 700,
      whiteSpace: 'nowrap',
      border: `1px solid ${active ? color ?? C.accent : C.border}`,
      color: active ? color ?? C.accent : C.muted,
      background: active
        ? `color-mix(in srgb, ${color ?? C.accent} 12%, transparent)`
        : 'transparent',
      transition: 'color 160ms ease, border-color 160ms ease, background 160ms ease',
    }}
  >
    {label}
  </button>
);

const PaymentSelect = ({
  value,
  disabled,
  onChange,
}: {
  value: InvoicePayment;
  disabled: boolean;
  onChange: (p: InvoicePayment) => void;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <span style={labelStyle}>Règlement</span>
    <select
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value as InvoicePayment)}
      style={{ ...inputStyle, width: 'auto', minWidth: 180, cursor: disabled ? 'default' : 'pointer' }}
    >
      {INVOICE_PAYMENTS.map(p => (
        <option key={p} value={p}>
          {INVOICE_PAYMENT_LABELS[p]}
        </option>
      ))}
    </select>
  </div>
);

const InvoiceStatusBadge = ({ status }: { status: InvoiceStatus }) => {
  const color = INVOICE_STATUS_COLORS[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 9px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
      }}
    >
      {INVOICE_STATUS_LABELS[status]}
    </span>
  );
};

const TotalRow = ({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      gap: 16,
      alignItems: 'baseline',
      paddingTop: strong ? 6 : 0,
      borderTop: strong ? `2px solid ${C.border}` : 'none',
    }}
  >
    <span
      style={{
        color: muted ? C.muted : C.text,
        fontSize: muted ? 11.5 : strong ? 14 : 13,
        fontWeight: strong ? 800 : muted ? 400 : 600,
      }}
    >
      {label}
    </span>
    <span
      style={{
        color: muted ? C.muted : C.text,
        fontSize: muted ? 11.5 : strong ? 16 : 13,
        fontWeight: strong ? 800 : 700,
        whiteSpace: 'nowrap',
      }}
    >
      {value}
    </span>
  </div>
);
