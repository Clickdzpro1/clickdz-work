import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  Banner,
  btnStyle,
  C,
  type CaisseDayClose,
  type CaisseEntry,
  CAISSE_METHOD_LABELS,
  type CaisseMethod,
  type CaisseReconcile,
  type CourierLite,
  EmptyNote,
  type ErpSettings,
  fetchCaisse,
  fetchCaisseCouriers,
  fetchDayClose,
  fetchReconcile,
  Field,
  fmtDZD,
  hasErpModule,
  hintStyle,
  inputStyle,
  labelStyle,
  MODULE_LABELS,
  miniBtnStyle,
  num,
  Panel,
  postCaisseEntry,
  postErpBackends,
  putCaisseEntry,
  Skeleton,
  Spinner,
  tdStyle,
  thStyle,
  toggleErpModule,
} from './shoperp-shared';

// DzOS Phase 1: the offline-first local store. Caisse is the first panel
// migrated — reads hydrate the local store (instant on tab switch + offline),
// writes go through the outbox (work offline, sync when reconnected). The
// SyncStatusPill in the header shows 「synchronisé · N en attente · hors ligne」.
import { getErpRepo, SyncStatusPill } from '@affine/core/modules/dzos-store';

// Bilingual FR/AR i18n for the DzOS surface (ticket print sheet + RTL layout).
import {
  type DzosLang,
  dzosCaisseMethodLabels,
  dzosDir,
  dzosFmtDZD,
  dzosT,
  isRTL,
  useDzosLang,
} from './dzos-i18n';

// ---------------------------------------------------------------------------
// Caisse (cash register) studio page — WSE-9 (COMPTOIR). Three tools over the
// R2-d caisse bridge routes (/api/v1/apps/:slug/erp/caisse*), all money INTEGER
// DZD via fmtDZD:
//   1. Journal      — month picker + entries list (in/out badge, method,
//                     courier, pending-COD visually distinct) + quick-add form
//                     (kind/amount/method/courier/note) + edit-in-place (PUT).
//   2. Rapprochement COD — courier + date-range → reconcile card (attendu vs
//                     reçu vs écart big numbers, gap colored, codFee, livraisons
//                     count, expandable orders) + "Encaisser" (pre-fills an 'in'
//                     entry for the received amount).
//   3. Clôture du jour  — date (default today) → day-close card (in/out by
//                     method + net) + "copier le résumé" (FR text for WhatsApp).
// Plus an "Afficher dans l'app" toggle for module `caisse` via erpBackends.
//
// Inline styles only (mirrors shop-appearance.tsx / shoperp-shared primitives);
// FR labels + short darja hints; mobile single-column collapse; loading / error
// / empty states everywhere. Owner-only, authed: when the server reports
// admin_writes_unavailable every read stays usable and writes go read-only via
// onWritesBlocked (like the sibling admin panels). Couriers are fetched inline
// (the shared caisse wrapper), so this page has no hard dependency on Routier's
// shipping UI landing in the same round.
// ---------------------------------------------------------------------------

type Tab = 'journal' | 'reconcile' | 'dayclose';

// Tab labels are resolved via dzosT at render time (see CaissePanel below) so
// they follow the user's language preference. The static TABS array keeps the
// ids + icons; labels are filled in the component body.
const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'journal', label: 'Journal', icon: '📒' },
  { id: 'reconcile', label: 'Rapprochement COD', icon: '🔁' },
  { id: 'dayclose', label: 'Clôture du jour', icon: '🧾' },
];

// DzOS i18n key for each tab id (used by CaissePanel to resolve bilingual labels).
const TAB_I18N_KEYS: Record<Tab, string> = {
  journal: 'caisse.tab.journal',
  reconcile: 'caisse.tab.reconcile',
  dayclose: 'caisse.tab.dayclose',
};

export const CaissePanel = ({
  slug,
  settings,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  /** The store's slug — its data-API namespace + publish slug. */
  slug: string;
  /** Live settings singleton (for the erpBackends "show in app" toggle). */
  settings: ErpSettings;
  readOnly: boolean;
  onWritesBlocked: () => void;
  /** Refresh the parent summary (keeps settings.erpBackends in sync). */
  onMutated: () => void;
}) => {
  const [tab, setTab] = useState<Tab>('journal');
  // Bilingual label resolution — follows the user's global language preference.
  const lang = useDzosLang();
  // A prefill handed from the reconcile "Encaisser" action to the Journal form.
  const [prefill, setPrefill] = useState<QuickAddPrefill | null>(null);

  const goEncaisser = useCallback((p: QuickAddPrefill) => {
    setPrefill(p);
    setTab('journal');
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {readOnly ? (
        <Banner tone="warn">
          Les écritures de caisse sont indisponibles sur ce serveur pour le
          moment — cette page est en <strong>lecture seule</strong>. Vous pouvez
          consulter le journal et les rapprochements; les ajouts reviendront
          dès que l’écriture sera rétablie.
        </Banner>
      ) : null}

      <ShowInAppToggle
        slug={slug}
        settings={settings}
        readOnly={readOnly}
        onWritesBlocked={onWritesBlocked}
        onMutated={onMutated}
      />

      {/* Sub-tabs */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          flexWrap: 'wrap',
          borderBottom: `1px solid ${C.border}`,
          paddingBottom: 0,
        }}
      >
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            style={subTabStyle(tab === t.id)}
            onClick={() => setTab(t.id)}
          >
            <span aria-hidden>{t.icon}</span> {dzosT(TAB_I18N_KEYS[t.id], lang)}
          </button>
        ))}
      </div>

      {tab === 'journal' ? (
        <Journal
          slug={slug}
          readOnly={readOnly}
          onWritesBlocked={onWritesBlocked}
          prefill={prefill}
          onPrefillConsumed={() => setPrefill(null)}
        />
      ) : tab === 'reconcile' ? (
        <Reconcile slug={slug} readOnly={readOnly} onEncaisser={goEncaisser} />
      ) : (
        <DayClose slug={slug} />
      )}
    </div>
  );
};

// ===========================================================================
// "Afficher dans l'app" toggle — adds/removes 'caisse' in the erpBackends CSV
// (settings singleton) so the published ERP shows the Caisse tab. Same write
// path as every other setting (postErpSettings under the hood); read-only-safe.
// ===========================================================================

const ShowInAppToggle = ({
  slug,
  settings,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  slug: string;
  settings: ErpSettings;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated: () => void;
}) => {
  const on = hasErpModule(settings.erpBackends, 'caisse');
  const [saving, setSaving] = useState(false);
  const lang = useDzosLang();
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error';
    text: string;
  } | null>(null);

  const toggle = useCallback(async () => {
    if (readOnly || saving) return;
    setSaving(true);
    setNotice(null);
    const next = toggleErpModule(settings.erpBackends, 'caisse', !on);
    const out = await postErpBackends(slug, next);
    if (out.status === 'ok') {
      setNotice({
        tone: 'ok',
        text: on
          ? 'Module Caisse retiré de l’app publiée.'
          : 'Module Caisse activé dans l’app publiée. Republiez pour l’appliquer.',
      });
      onMutated();
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
    } else {
      setNotice({ tone: 'error', text: out.message });
    }
    setSaving(false);
  }, [readOnly, saving, settings.erpBackends, on, slug, onMutated, onWritesBlocked]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '10px 14px',
        borderRadius: 10,
        background: C.panel,
        border: `1px solid ${C.border}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
          Afficher « {MODULE_LABELS.caisse} » dans l’app
        </div>
        <div style={{ ...hintStyle, marginTop: 2 }}>
          Ajoute l’onglet Caisse à votre ERP publié (encaissements + clôture sur
          le téléphone). Republiez l’app pour l’appliquer.
        </div>
      </div>
      {notice ? (
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color:
              notice.tone === 'ok'
                ? C.okText
                : 'var(--affine-error-color, #eb4b4b)',
          }}
        >
          {notice.text}
        </span>
      ) : null}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={readOnly || saving}
        onClick={() => void toggle()}
        style={switchStyle(on, readOnly || saving)}
        title={on ? dzosT('invoice.editor.hideInAppToggle', lang) : dzosT('invoice.editor.showInAppToggle', lang)}
      >
        {saving ? <Spinner /> : null}
        <span style={switchKnobStyle(on)} aria-hidden />
        <span style={{ fontSize: 12, fontWeight: 700 }}>
          {on ? dzosT('invoice.editor.showInAppToggle', lang) : dzosT('invoice.editor.hideInAppToggle', lang)}
        </span>
      </button>
    </div>
  );
};

// ===========================================================================
// 1) JOURNAL — month picker + entries list + quick-add + edit-in-place.
// ===========================================================================

interface QuickAddPrefill {
  kind: 'in' | 'out';
  amount: number;
  method: CaisseMethod;
  courierId?: string;
  note?: string;
  date?: string;
}

/** Current UTC month as YYYYMM (matches the backend partition key). */
function currentMonthYYYYMM(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** A YYYY-MM-DD date → its YYYYMM partition (caisse-YYYYMM). */
function monthYYYYMM(date: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(date);
  return m ? `${m[1]}${m[2]}` : currentMonthYYYYMM();
}

/** YYYYMM → the <input type=month> value YYYY-MM (and back). */
function monthInputValue(yyyymm: string): string {
  return /^\d{6}$/.test(yyyymm)
    ? `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}`
    : '';
}
function monthInputToYYYYMM(v: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  return m ? `${m[1]}${m[2]}` : currentMonthYYYYMM();
}

const Journal = ({
  slug,
  readOnly,
  onWritesBlocked,
  prefill,
  onPrefillConsumed,
}: {
  slug: string;
  readOnly: boolean;
  onWritesBlocked: () => void;
  prefill: QuickAddPrefill | null;
  onPrefillConsumed: () => void;
}) => {
  const [month, setMonth] = useState<string>(currentMonthYYYYMM());
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [entries, setEntries] = useState<CaisseEntry[]>([]);
  const [couriers, setCouriers] = useState<CourierLite[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Phase 2: track the active month-load so a rapid month switch can't apply
  // a stale response (the old code raced: switch Jan→Feb→Mar quickly and the
  // Jan response could land last, overwriting Mar's entries).
  const loadTokenRef = useRef(0);

  const load = useCallback(async () => {
    const token = ++loadTokenRef.current;
    setPhase('loading');
    // DzOS Phase 1 END-STATE: read from the LOCAL store first (instant, works
    // offline). The /erp/changes pull keeps it fresh. Only on a cold start
    // (local partition empty — first-ever open) do we fetch + hydrate.
    const coll = `caisse-${month}`;
    try {
      const repo = await getErpRepo(slug);
      const local = await repo.list<CaisseEntry>(coll);
      if (local.length > 0) {
        if (token !== loadTokenRef.current) return; // stale — a newer load won
        setEntries(local.map((w) => w.data));
        setPhase('ready');
        return;
      }
    } catch {
      /* fall through to cold-start fetch */
    }
    // Cold start: fetch + hydrate, then read back from the local store.
    const out = await fetchCaisse(slug, month);
    if (token !== loadTokenRef.current) return; // stale — discard
    if (out.status === 'ok') {
      setEntries(out.entries);
      setPhase('ready');
      void getErpRepo(slug).then((repo) =>
        Promise.all(
          out.entries.map((e) =>
            repo.upsert(coll, e.id, e, { collectionOverride: coll }).catch(() => {})
          )
        ).catch(() => {})
      );
    } else if (out.status === 'unavailable') {
      // Offline + empty local store → quiet empty state (never crash).
      setEntries([]);
      setPhase('ready');
    } else {
      setErrMsg(out.message);
      setPhase('error');
    }
  }, [slug, month]);

  useEffect(() => {
    void load();
  }, [load]);

  // Couriers are optional context (label + method tag on the form/list). A
  // failure here never blocks the journal.
  useEffect(() => {
    let alive = true;
    void fetchCaisseCouriers(slug).then(list => {
      if (alive) setCouriers(list);
    });
    return () => {
      alive = false;
    };
  }, [slug]);

  const courierName = useCallback(
    (id?: string) => {
      if (!id) return '';
      const c = couriers.find(x => x.id === id);
      return c?.name || id;
    },
    [couriers]
  );

  const monthLabel = useMemo(() => {
    const iv = monthInputValue(month);
    if (!iv) return month;
    try {
      const d = new Date(`${iv}-01T00:00:00Z`);
      return d.toLocaleDateString('fr-DZ', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      });
    } catch {
      return iv;
    }
  }, [month]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <QuickAdd
        slug={slug}
        couriers={couriers}
        readOnly={readOnly}
        onWritesBlocked={onWritesBlocked}
        prefill={prefill}
        onPrefillConsumed={onPrefillConsumed}
        onAdded={() => void load()}
      />

      <Panel
        title={`Journal — ${monthLabel}`}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* DzOS Phase 1: the sync pill shows the outbox + online state. */}
            <SyncStatusPill slug={slug} />
            <input
              type="month"
              value={monthInputValue(month)}
              max={monthInputValue(currentMonthYYYYMM())}
              onChange={e => setMonth(monthInputToYYYYMM(e.target.value))}
              style={{ ...inputStyle, width: 'auto', padding: '5px 9px' }}
              aria-label="Mois"
            />
          </div>
        }
      >
        {phase === 'loading' ? (
          <Skeleton rows={5} height={38} gap={6} />
        ) : phase === 'error' ? (
          <Banner tone="error">
            {errMsg}{' '}
            <button style={miniBtnStyle('secondary')} onClick={() => void load()}>
              Réessayer
            </button>
          </Banner>
        ) : entries.length === 0 ? (
          <EmptyNote>
            Aucune écriture ce mois-ci. Ajoutez un encaissement ou une dépense
            ci-dessus. <span style={{ opacity: 0.7 }}>(walou hna)</span>
          </EmptyNote>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
              <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: C.panel2 }}>
                <tr>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Sens</th>
                  <th style={thStyle}>Méthode</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Montant</th>
                  <th style={thStyle}>Livreur</th>
                  <th style={thStyle}>Note</th>
                  <th style={{ ...thStyle, textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {entries.map(en =>
                  editingId === en.id ? (
                    <EditRow
                      key={en.id}
                      slug={slug}
                      entry={en}
                      couriers={couriers}
                      onWritesBlocked={onWritesBlocked}
                      onCancel={() => setEditingId(null)}
                      onSaved={() => {
                        setEditingId(null);
                        void load();
                      }}
                    />
                  ) : (
                    <EntryRow
                      key={en.id}
                      entry={en}
                      courierName={courierName(en.courierId)}
                      canEdit={!readOnly && !en.pending}
                      onEdit={() => setEditingId(en.id)}
                    />
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ ...hintStyle, marginTop: 10 }}>
          Les lignes <PendingDot /> « COD attendu » sont générées à la livraison
          (attendues, pas encore comptées). Encaissez-les depuis l’onglet
          Rapprochement.
        </div>
      </Panel>
    </div>
  );
};

const PendingDot = () => (
  <span
    style={{
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: '#e8a33d',
      verticalAlign: 'middle',
      margin: '0 2px',
    }}
    aria-hidden
  />
);

const KindBadge = ({ kind }: { kind?: string }) => {
  const isIn = kind === 'in';
  const color = isIn ? '#22c55e' : '#ef4444';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
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
      {isIn ? '↓ Entrée' : '↑ Sortie'}
    </span>
  );
};

const EntryRow = ({
  entry,
  courierName,
  canEdit,
  onEdit,
}: {
  entry: CaisseEntry;
  courierName: string;
  canEdit: boolean;
  onEdit: () => void;
}) => {
  const pending = entry.pending === true;
  return (
    <tr
      style={pending ? { background: C.warnBg, transition: 'background 140ms ease' } : { transition: 'background 140ms ease' }}
      onMouseEnter={e => { if (!pending) (e.currentTarget as HTMLElement).style.background = C.panel2; }}
      onMouseLeave={e => { if (!pending) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <td style={tdStyle}>
        <span style={{ whiteSpace: 'nowrap' }}>{entry.date || '—'}</span>
      </td>
      <td style={tdStyle}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {pending ? <PendingDot /> : null}
          <KindBadge kind={entry.kind} />
        </span>
      </td>
      <td style={tdStyle}>
        <span style={{ fontSize: 12.5 }}>
          {CAISSE_METHOD_LABELS[entry.method as CaisseMethod] || entry.method || '—'}
        </span>
      </td>
      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 800, whiteSpace: 'nowrap' }}>
        {fmtDZD(num(entry.amount))}
      </td>
      <td style={tdStyle}>
        <span style={{ fontSize: 12.5, color: C.muted }}>{courierName || '—'}</span>
      </td>
      <td style={tdStyle}>
        <span
          style={{
            fontSize: 12.5,
            color: pending ? '#c98a2b' : C.muted,
            display: 'inline-block',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={entry.note || ''}
        >
          {entry.note || '—'}
        </span>
      </td>
      <td style={{ ...tdStyle, textAlign: 'right' }}>
        {canEdit ? (
          <button style={miniBtnStyle('secondary')} onClick={onEdit}>
            Modifier
          </button>
        ) : pending ? (
          <span style={{ fontSize: 11, color: C.muted }}>attendu</span>
        ) : null}
      </td>
    </tr>
  );
};

// ---- Quick-add + edit share this small controlled form model ----------------

interface EntryDraft {
  kind: 'in' | 'out';
  amount: string;
  method: CaisseMethod;
  courierId: string;
  note: string;
  date: string;
}

function emptyDraft(): EntryDraft {
  return {
    kind: 'in',
    amount: '',
    method: 'cash',
    courierId: '',
    note: '',
    date: new Date().toISOString().slice(0, 10),
  };
}

const METHOD_ORDER: CaisseMethod[] = ['cash', 'cod', 'chargily'];

const QuickAdd = ({
  slug,
  couriers,
  readOnly,
  onWritesBlocked,
  prefill,
  onPrefillConsumed,
  onAdded,
}: {
  slug: string;
  couriers: CourierLite[];
  readOnly: boolean;
  onWritesBlocked: () => void;
  prefill: QuickAddPrefill | null;
  onPrefillConsumed: () => void;
  onAdded: () => void;
}) => {
  const [draft, setDraft] = useState<EntryDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  // A reconcile "Encaisser" prefill flows in → seed + focus the form.
  useEffect(() => {
    if (!prefill) return;
    setDraft({
      kind: prefill.kind === 'out' ? 'out' : 'in',
      amount: prefill.amount > 0 ? String(Math.round(prefill.amount)) : '',
      method: prefill.method,
      courierId: prefill.courierId || '',
      note: prefill.note || '',
      date: prefill.date || new Date().toISOString().slice(0, 10),
    });
    setErr(null);
    setOk(false);
    onPrefillConsumed();
  }, [prefill, onPrefillConsumed]);

  const set = useCallback(<K extends keyof EntryDraft>(k: K, v: EntryDraft[K]) => {
    setDraft(d => ({ ...d, [k]: v }));
    setOk(false);
  }, []);

  const submit = useCallback(async () => {
    if (readOnly || saving) return;
    const amount = Math.round(num(draft.amount));
    if (!(amount > 0)) {
      setErr('Le montant doit être un entier positif (DZD).');
      return;
    }
    setErr(null);
    setSaving(true);
    const entryBody = {
      kind: draft.kind,
      amount,
      method: draft.method,
      date: draft.date,
      note: draft.note.trim(),
      ...(draft.courierId ? { courierId: draft.courierId } : {}),
    };
    const out = await postCaisseEntry(slug, entryBody);
    if (out.status === 'ok') {
      // DzOS Phase 1: mirror the successful write into the local store so the
      // journal updates instantly (no refetch) and the entry survives offline.
      // The returned entry has a server-assigned id; upsert it into the
      // caisse-<month> partition. Best-effort — the server write already
      // succeeded, so a local-store failure doesn't undo it.
      const coll = `caisse-${monthYYYYMM(draft.date)}`;
      if (out.entry?.id) {
        void getErpRepo(slug).then((repo) =>
          repo
            .upsert(coll, out.entry.id, out.entry, { collectionOverride: coll })
            .catch(() => {})
        );
      }
      setOk(true);
      setDraft(d => ({ ...emptyDraft(), method: d.method, date: d.date }));
      onAdded();
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
    } else {
      setErr(out.message);
    }
    setSaving(false);
  }, [readOnly, saving, draft, slug, onAdded, onWritesBlocked]);

  return (
    <Panel title="Ajouter une écriture">
      {err ? (
        <div style={{ marginBottom: 10 }}>
          <Banner tone="error">{err}</Banner>
        </div>
      ) : null}
      {ok ? (
        <div style={{ marginBottom: 10 }}>
          <Banner tone="ok">Écriture enregistrée.</Banner>
        </div>
      ) : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 10,
          alignItems: 'end',
        }}
      >
        <Field label="Sens">
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              disabled={readOnly}
              onClick={() => set('kind', 'in')}
              style={segStyle(draft.kind === 'in', '#22c55e')}
            >
              Entrée
            </button>
            <button
              type="button"
              disabled={readOnly}
              onClick={() => set('kind', 'out')}
              style={segStyle(draft.kind === 'out', '#ef4444')}
            >
              Sortie
            </button>
          </div>
        </Field>

        <Field label="Montant (DZD)">
          <input
            style={inputStyle}
            inputMode="numeric"
            value={draft.amount}
            placeholder="0"
            disabled={readOnly}
            onChange={e => set('amount', e.target.value.replace(/[^0-9]/g, ''))}
          />
        </Field>

        <Field label="Méthode">
          <select
            style={{ ...inputStyle, appearance: 'auto' }}
            value={draft.method}
            disabled={readOnly}
            onChange={e => set('method', e.target.value as CaisseMethod)}
          >
            {METHOD_ORDER.map(m => (
              <option key={m} value={m}>
                {CAISSE_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Livreur (COD)" hint="Optionnel — pour le rapprochement.">
          <select
            style={{ ...inputStyle, appearance: 'auto' }}
            value={draft.courierId}
            disabled={readOnly || couriers.length === 0}
            onChange={e => set('courierId', e.target.value)}
          >
            <option value="">—</option>
            {couriers.map(c => (
              <option key={c.id} value={c.id}>
                {c.name || c.id}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Date">
          <input
            type="date"
            style={inputStyle}
            value={draft.date}
            max={new Date().toISOString().slice(0, 10)}
            disabled={readOnly}
            onChange={e => set('date', e.target.value)}
          />
        </Field>

        <Field label="Note">
          <input
            style={inputStyle}
            value={draft.note}
            placeholder="ex. remise livreur"
            maxLength={400}
            disabled={readOnly}
            onChange={e => set('note', e.target.value)}
          />
        </Field>
      </div>

      <div style={{ marginTop: 12 }}>
        <button
          style={btnStyle('primary', readOnly || saving)}
          disabled={readOnly || saving}
          onClick={() => void submit()}
        >
          {saving ? (
            <>
              <Spinner dark /> Enregistrement…
            </>
          ) : (
            '+ Ajouter'
          )}
        </button>
      </div>
    </Panel>
  );
};

const EditRow = ({
  slug,
  entry,
  couriers,
  onWritesBlocked,
  onCancel,
  onSaved,
}: {
  slug: string;
  entry: CaisseEntry;
  couriers: CourierLite[];
  onWritesBlocked: () => void;
  onCancel: () => void;
  onSaved: () => void;
}) => {
  const [draft, setDraft] = useState<EntryDraft>(() => ({
    kind: entry.kind === 'out' ? 'out' : 'in',
    amount: String(Math.round(num(entry.amount))),
    method: (['cash', 'cod', 'chargily'] as string[]).includes(entry.method || '')
      ? (entry.method as CaisseMethod)
      : 'cash',
    courierId: entry.courierId || '',
    note: entry.note || '',
    date: entry.date || new Date().toISOString().slice(0, 10),
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = useCallback(<K extends keyof EntryDraft>(k: K, v: EntryDraft[K]) => {
    setDraft(d => ({ ...d, [k]: v }));
  }, []);

  const save = useCallback(async () => {
    if (saving) return;
    const amount = Math.round(num(draft.amount));
    if (!(amount > 0)) {
      setErr('Montant invalide.');
      return;
    }
    setErr(null);
    setSaving(true);
    const out = await putCaisseEntry(slug, entry.id, {
      kind: draft.kind,
      amount,
      method: draft.method,
      date: draft.date,
      note: draft.note.trim(),
      // Send courierId even when cleared so the edit can UNSET it (backend
      // omits empty on re-validate).
      courierId: draft.courierId,
    });
    if (out.status === 'ok') {
      onSaved();
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
      onCancel();
    } else {
      setErr(out.message);
    }
    setSaving(false);
  }, [saving, draft, slug, entry.id, onSaved, onWritesBlocked, onCancel]);

  return (
    <tr style={{ background: C.accentSoft }}>
      <td style={tdStyle}>
        <input
          type="date"
          style={{ ...inputStyle, padding: '5px 7px', width: 138 }}
          value={draft.date}
          onChange={e => set('date', e.target.value)}
        />
      </td>
      <td style={tdStyle}>
        <select
          style={{ ...inputStyle, appearance: 'auto', padding: '5px 7px' }}
          value={draft.kind}
          onChange={e => set('kind', e.target.value as 'in' | 'out')}
        >
          <option value="in">Entrée</option>
          <option value="out">Sortie</option>
        </select>
      </td>
      <td style={tdStyle}>
        <select
          style={{ ...inputStyle, appearance: 'auto', padding: '5px 7px' }}
          value={draft.method}
          onChange={e => set('method', e.target.value as CaisseMethod)}
        >
          {METHOD_ORDER.map(m => (
            <option key={m} value={m}>
              {CAISSE_METHOD_LABELS[m]}
            </option>
          ))}
        </select>
      </td>
      <td style={{ ...tdStyle, textAlign: 'right' }}>
        <input
          style={{ ...inputStyle, padding: '5px 7px', width: 110, textAlign: 'right' }}
          inputMode="numeric"
          value={draft.amount}
          onChange={e => set('amount', e.target.value.replace(/[^0-9]/g, ''))}
        />
      </td>
      <td style={tdStyle}>
        <select
          style={{ ...inputStyle, appearance: 'auto', padding: '5px 7px' }}
          value={draft.courierId}
          disabled={couriers.length === 0}
          onChange={e => set('courierId', e.target.value)}
        >
          <option value="">—</option>
          {couriers.map(c => (
            <option key={c.id} value={c.id}>
              {c.name || c.id}
            </option>
          ))}
        </select>
      </td>
      <td style={tdStyle}>
        <input
          style={{ ...inputStyle, padding: '5px 7px' }}
          value={draft.note}
          maxLength={400}
          onChange={e => set('note', e.target.value)}
        />
      </td>
      <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
        {err ? (
          <div style={{ fontSize: 11, color: 'var(--affine-error-color, #eb4b4b)', marginBottom: 4 }}>
            {err}
          </div>
        ) : null}
        <button
          style={{ ...miniBtnStyle('primary', saving), marginRight: 6 }}
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? <Spinner dark /> : 'OK'}
        </button>
        <button style={miniBtnStyle('secondary')} onClick={onCancel}>
          Annuler
        </button>
      </td>
    </tr>
  );
};

// ===========================================================================
// 2) RAPPROCHEMENT COD — courier + date range → reconcile card.
// ===========================================================================

const Reconcile = ({
  slug,
  readOnly,
  onEncaisser,
}: {
  slug: string;
  readOnly: boolean;
  onEncaisser: (p: QuickAddPrefill) => void;
}) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const [couriers, setCouriers] = useState<CourierLite[]>([]);
  const [couriersLoaded, setCouriersLoaded] = useState(false);
  const [courierId, setCourierId] = useState('');
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);

  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState('');
  const [report, setReport] = useState<CaisseReconcile | null>(null);
  const [showOrders, setShowOrders] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchCaisseCouriers(slug).then(list => {
      if (!alive) return;
      setCouriers(list);
      setCouriersLoaded(true);
      if (list.length && !courierId) setCourierId(list[0].id);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const run = useCallback(async () => {
    if (!courierId) return;
    setPhase('loading');
    setShowOrders(false);
    const out = await fetchReconcile(slug, courierId, from, to);
    if (out.status === 'ok') {
      setReport(out.report);
      setPhase('ready');
    } else if (out.status === 'unavailable') {
      setReport(null);
      setPhase('ready');
    } else {
      setErrMsg(out.message);
      setPhase('error');
    }
  }, [slug, courierId, from, to]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel title="Rapprochement COD par livreur">
        {couriersLoaded && couriers.length === 0 ? (
          <Banner tone="info">
            Aucun livreur enregistré. Ajoutez vos livreurs dans Livraison, puis
            revenez rapprocher leurs encaissements COD.
          </Banner>
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: 10,
                alignItems: 'end',
              }}
            >
              <Field label="Livreur">
                <select
                  style={{ ...inputStyle, appearance: 'auto' }}
                  value={courierId}
                  onChange={e => setCourierId(e.target.value)}
                >
                  {couriers.length === 0 ? <option value="">—</option> : null}
                  {couriers.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Du">
                <input
                  type="date"
                  style={inputStyle}
                  value={from}
                  max={to}
                  onChange={e => setFrom(e.target.value)}
                />
              </Field>
              <Field label="Au">
                <input
                  type="date"
                  style={inputStyle}
                  value={to}
                  max={today}
                  onChange={e => setTo(e.target.value)}
                />
              </Field>
              <div>
                <button
                  style={btnStyle('primary', phase === 'loading' || !courierId)}
                  disabled={phase === 'loading' || !courierId}
                  onClick={() => void run()}
                >
                  {phase === 'loading' ? (
                    <>
                      <Spinner dark /> Calcul…
                    </>
                  ) : (
                    'Rapprocher'
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </Panel>

      {phase === 'error' ? (
        <Banner tone="error">
          {errMsg}{' '}
          <button style={miniBtnStyle('secondary')} onClick={() => void run()}>
            Réessayer
          </button>
        </Banner>
      ) : phase === 'ready' && report ? (
        <ReconcileCard
          report={report}
          from={from}
          to={to}
          readOnly={readOnly}
          showOrders={showOrders}
          onToggleOrders={() => setShowOrders(s => !s)}
          onEncaisser={() =>
            onEncaisser({
              kind: 'in',
              amount: Math.max(0, num(report.gap)),
              method: 'cod',
              courierId: report.courierId,
              note: `Encaissement COD ${report.courierName} (${from} → ${to})`,
              date: today,
            })
          }
        />
      ) : phase === 'ready' && !report ? (
        <Banner tone="info">
          Le rapprochement n’est pas disponible sur ce serveur pour le moment.
        </Banner>
      ) : null}
    </div>
  );
};

const ReconcileCard = ({
  report,
  from,
  to,
  readOnly,
  showOrders,
  onToggleOrders,
  onEncaisser,
}: {
  report: CaisseReconcile;
  from: string;
  to: string;
  readOnly: boolean;
  showOrders: boolean;
  onToggleOrders: () => void;
  onEncaisser: () => void;
}) => {
  const gap = num(report.gap);
  // gap > 0 ⇒ le livreur doit encore (rouge); ≤ 0 ⇒ soldé / trop remis (vert).
  const gapColor = gap > 0 ? 'var(--affine-error-color, #eb4b4b)' : C.okText;
  const gapLabel = gap > 0 ? 'Reste à encaisser' : gap < 0 ? 'Trop remis' : 'Soldé';

  return (
    <Panel title={`${report.courierName} · ${from} → ${to}`}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 12,
        }}
      >
        <BigStat label="Attendu" value={fmtDZD(num(report.expectedTotal))} />
        <BigStat label="Reçu" value={fmtDZD(num(report.receivedTotal))} />
        <BigStat label={gapLabel} value={fmtDZD(Math.abs(gap))} color={gapColor} />
      </div>

      <div
        style={{
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          marginTop: 14,
          fontSize: 12.5,
          color: C.muted,
        }}
      >
        <span>
          Livraisons: <strong style={{ color: C.text }}>{num(report.deliveredCount)}</strong>
        </span>
        <span>
          Frais COD retenus:{' '}
          <strong style={{ color: C.text }}>{fmtDZD(num(report.codFeeTotal))}</strong>
        </span>
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          style={btnStyle('primary', readOnly || !(gap > 0))}
          disabled={readOnly || !(gap > 0)}
          onClick={onEncaisser}
          title={
            gap > 0
              ? 'Créer une écriture d’entrée pour le montant restant'
              : 'Rien à encaisser (soldé)'
          }
        >
          💵 Encaisser {gap > 0 ? fmtDZD(gap) : ''}
        </button>
        {report.orders && report.orders.length ? (
          <button style={btnStyle('secondary')} onClick={onToggleOrders}>
            {showOrders ? 'Masquer' : 'Voir'} les livraisons ({report.orders.length})
          </button>
        ) : null}
      </div>

      {showOrders && report.orders && report.orders.length ? (
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 320 }}>
            <thead>
              <tr>
                <th style={thStyle}>Réf</th>
                <th style={thStyle}>Date</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Montant</th>
              </tr>
            </thead>
            <tbody>
              {report.orders.map((o, i) => (
                <tr key={`${o.ref}-${i}`}>
                  <td style={tdStyle}>{o.ref || '—'}</td>
                  <td style={tdStyle}>{o.date || '—'}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>
                    {fmtDZD(num(o.total))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
};

const BigStat = ({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) => (
  <div
    style={{
      padding: '14px 16px',
      borderRadius: 14,
      background: C.panel,
      border: `1px solid ${C.border}`,
      boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
    }}
  >
    <div style={{ ...labelStyle, marginBottom: 6 }}>{label}</div>
    <div
      style={{
        fontSize: 26,
        fontWeight: 900,
        lineHeight: 1.1,
        color: color || C.text,
        wordBreak: 'break-word',
        letterSpacing: '-0.5px',
      }}
    >
      {value}
    </div>
  </div>
);

// ===========================================================================
// 3) CLÔTURE DU JOUR — date → in/out by method + net + copy summary (FR).
// ===========================================================================

const DayClose = ({ slug }: { slug: string }) => {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [summary, setSummary] = useState<CaisseDayClose | null>(null);
  const [copied, setCopied] = useState(false);
  // Bilingual label resolution — follows the user's global language preference.
  const lang = useDzosLang();

  const load = useCallback(async () => {
    setPhase('loading');
    setCopied(false);
    const out = await fetchDayClose(slug, date);
    if (out.status === 'ok') {
      setSummary(out.summary);
      setPhase('ready');
    } else if (out.status === 'unavailable') {
      setSummary(null);
      setPhase('ready');
    } else {
      setErrMsg(out.message);
      setPhase('error');
    }
  }, [slug, date]);

  useEffect(() => {
    void load();
  }, [load]);

  const copySummary = useCallback(async () => {
    if (!summary) return;
    const text = buildDayCloseText(summary, date);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard blocked (permissions) — fall back to a select-all prompt.
      window.prompt('Copiez le résumé:', text);
    }
  }, [summary, date]);

  return (
    <Panel
      title={dzosT('caisse.dayclose.title', lang)}
      action={
        <input
          type="date"
          value={date}
          max={today}
          onChange={e => setDate(e.target.value)}
          style={{ ...inputStyle, width: 'auto', padding: '5px 9px' }}
          aria-label="Jour"
        />
      }
    >
      {phase === 'loading' ? (
        <Skeleton rows={3} height={70} gap={10} />
      ) : phase === 'error' ? (
        <Banner tone="error">
          {errMsg}{' '}
          <button style={miniBtnStyle('secondary')} onClick={() => void load()}>
            Réessayer
          </button>
        </Banner>
      ) : !summary ? (
        <Banner tone="info">
          La clôture n’est pas disponible sur ce serveur pour le moment.
        </Banner>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 12,
            }}
          >
            <BigStat label={dzosT('caisse.journal.kind.in', lang)} value={dzosFmtDZD(num(summary.inTotal), lang)} color={C.okText} />
            <BigStat
              label={dzosT('caisse.journal.kind.out', lang)}
              value={dzosFmtDZD(num(summary.outTotal), lang)}
              color="var(--affine-error-color, #eb4b4b)"
            />
            <BigStat
              label={dzosT('caisse.dayclose.net', lang)}
              value={dzosFmtDZD(num(summary.net), lang)}
              color={num(summary.net) >= 0 ? C.okText : 'var(--affine-error-color, #eb4b4b)'}
            />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 12,
            }}
          >
            <MethodTable title={dzosT('caisse.dayclose.inByMethod', lang)} bd={summary.inByMethod} lang={lang} />
            <MethodTable title={dzosT('caisse.dayclose.outByMethod', lang)} bd={summary.outByMethod} lang={lang} />
          </div>

          {num(summary.pendingCodTotal) > 0 ? (
            <Banner tone="warn">
              COD attendu (non encore encaissé) ce jour:{' '}
              <strong>{fmtDZD(num(summary.pendingCodTotal))}</strong> — encaissez
              via Rapprochement.
            </Banner>
          ) : null}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button style={btnStyle('secondary')} onClick={() => void copySummary()}>
              📋 {dzosT('caisse.dayclose.copySummary', lang)}
            </button>
            <button
              style={btnStyle('secondary')}
              onClick={() => window.print()}
              title={dzosT('invoice.editor.printTitle', lang)}
            >
              🖨️ {dzosT('invoice.editor.printBtn', lang)}
            </button>
            {copied ? (
              <span style={{ fontSize: 12, fontWeight: 600, color: C.okText }}>
                {dzosT('caisse.dayclose.copied', lang)}
              </span>
            ) : (
              <span style={{ ...hintStyle }}>
                {num(summary.entryCount)} écriture{num(summary.entryCount) > 1 ? 's' : ''}.
              </span>
            )}
          </div>

          {/* Hidden bilingual ticket print sheet — printed by window.print() via
              @media print. Renders a professional daily Z-report (ticket de
              caisse) from the day-close summary, in FR or AR with RTL layout. */}
          <TicketPrintSheet summary={summary} date={date} lang={lang} />
        </div>
      )}
    </Panel>
  );
};

const MethodTable = ({
  title,
  bd,
  lang = 'fr',
}: {
  title: string;
  bd: CaisseDayClose['inByMethod'];
  lang?: DzosLang;
}) => {
  const rows: Array<[CaisseMethod, number]> = [
    ['cash', num(bd?.cash)],
    ['cod', num(bd?.cod)],
    ['chargily', num(bd?.chargily)],
  ];
  const total = rows.reduce((s, [, v]) => s + v, 0);
  return (
    <div
      style={{
        borderRadius: 10,
        border: `1px solid ${C.border}`,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          background: C.panel2,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: C.muted,
        }}
      >
        {title}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map(([m, v]) => (
            <tr key={m}>
              <td style={{ ...tdStyle, borderTop: 'none' }}>
                {dzosCaisseMethodLabels[m](lang)}
              </td>
              <td
                style={{
                  ...tdStyle,
                  borderTop: 'none',
                  textAlign: 'right',
                  fontWeight: 700,
                  color: v > 0 ? C.text : C.muted,
                }}
              >
                {dzosFmtDZD(v, lang)}
              </td>
            </tr>
          ))}
          <tr>
            <td
              style={{
                ...tdStyle,
                fontWeight: 800,
                color: C.text,
              }}
            >
              {dzosT('common.total', lang)}
            </td>
            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 800 }}>
              {dzosFmtDZD(total, lang)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

/**
 * A plain-text FR day-close summary for pasting into WhatsApp or a notebook.
 * Uses fmtDZD so amounts read exactly as on screen (integer DZD, fr-DZ groups).
 */
function buildDayCloseText(s: CaisseDayClose, date: string): string {
  const L = (m: CaisseMethod, v: number) =>
    v > 0 ? `  • ${CAISSE_METHOD_LABELS[m]}: ${fmtDZD(v)}` : '';
  const inLines = [
    L('cash', num(s.inByMethod?.cash)),
    L('cod', num(s.inByMethod?.cod)),
    L('chargily', num(s.inByMethod?.chargily)),
  ].filter(Boolean);
  const outLines = [
    L('cash', num(s.outByMethod?.cash)),
    L('cod', num(s.outByMethod?.cod)),
    L('chargily', num(s.outByMethod?.chargily)),
  ].filter(Boolean);
  const parts: string[] = [];
  parts.push(`🧾 Clôture caisse — ${date}`);
  parts.push('');
  parts.push(`Entrées: ${fmtDZD(num(s.inTotal))}`);
  if (inLines.length) parts.push(...inLines);
  parts.push(`Sorties: ${fmtDZD(num(s.outTotal))}`);
  if (outLines.length) parts.push(...outLines);
  parts.push('');
  parts.push(`Net: ${fmtDZD(num(s.net))}`);
  if (num(s.pendingCodTotal) > 0) {
    parts.push(`COD attendu (non compté): ${fmtDZD(num(s.pendingCodTotal))}`);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Small inline style helpers (no .css.ts, per house rules).
// ---------------------------------------------------------------------------

function subTabStyle(active: boolean): CSSProperties {
  return {
    appearance: 'none',
    background: active ? C.accentSoft : 'none',
    border: active ? `1px solid ${C.accent}` : '1px solid transparent',
    borderRadius: 8,
    marginBottom: 6,
    padding: '7px 14px',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    color: active ? C.text : C.muted,
    transition: 'color 160ms ease, background 160ms ease, border-color 160ms ease',
  };
}

function segStyle(active: boolean, tint: string): CSSProperties {
  return {
    flex: 1,
    appearance: 'none',
    cursor: 'pointer',
    borderRadius: 8,
    padding: '9px 10px',
    fontSize: 13,
    fontWeight: 700,
    color: active ? tint : C.muted,
    background: active ? `color-mix(in srgb, ${tint} 15%, transparent)` : C.bg,
    border: `1px solid ${active ? `color-mix(in srgb, ${tint} 45%, transparent)` : C.border}`,
    transition: 'color 160ms ease, background 160ms ease, border-color 160ms ease',
  };
}

function switchStyle(on: boolean, disabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    padding: '6px 12px 6px 8px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    color: on ? '#fff' : C.text,
    background: on ? C.accent : C.bg,
    border: `1px solid ${on ? C.accent : C.border}`,
    transition: 'background 160ms ease, border-color 160ms ease',
  };
}

function switchKnobStyle(on: boolean): CSSProperties {
  return {
    width: 14,
    height: 14,
    borderRadius: '50%',
    background: on ? '#fff' : C.muted,
    boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
  };
}

// ===========================================================================
// TICKET PRINT SHEET — a hidden, print-only bilingual daily Z-report (ticket
// de caisse / إيصال صندوق). The inline <style> tag scopes @media print so ONLY
// this sheet prints (everything else in the app is hidden), mirroring the
// invoice print sheet pattern in invoicing.tsx. window.print() (the "Imprimer
// / PDF" button in the DayClose panel) drives it.
//
// The ticket is a compact thermal-receipt-style layout: header (store name +
// ticket title + date), in/out by method table, net total, and a footer. In
// Arabic the sheet flips to RTL with an Arabic-capable font stack. CSS uses
// logical properties (text-align: start/end) so the same rules work in both
// directions.
// ===========================================================================
const TicketPrintSheet = ({
  summary,
  date,
  lang,
}: {
  summary: CaisseDayClose;
  date: string;
  lang: DzosLang;
}) => {
  const rtl = isRTL(lang);
  const dir = dzosDir(lang);
  const fontStack = rtl
    ? "'Noto Sans Arabic','Noto Naskh Arabic',Arial,sans-serif"
    : "Arial,'Helvetica Neue',sans-serif";
  const methodRows: Array<[CaisseMethod, number]> = [
    ['cash', num(summary.inByMethod?.cash)],
    ['cod', num(summary.inByMethod?.cod)],
    ['chargily', num(summary.inByMethod?.chargily)],
  ];
  const outRows: Array<[CaisseMethod, number]> = [
    ['cash', num(summary.outByMethod?.cash)],
    ['cod', num(summary.outByMethod?.cod)],
    ['chargily', num(summary.outByMethod?.chargily)],
  ];
  return (
    <div className="cdz-tkt-print-root" aria-hidden>
      <style>{TICKET_PRINT_CSS}</style>
      <div className="cdz-tkt-sheet" dir={dir} style={{ fontFamily: fontStack }}>
        {/* Header ------------------------------------------------------- */}
        <div className="cdz-tkt-header">
          <div className="cdz-tkt-title">
            {dzosT('print.ticket.title', lang)}
          </div>
          <div className="cdz-tkt-date">
            {dzosT('print.ticket.date', lang)} : {date}
          </div>
        </div>

        <div className="cdz-tkt-sep" />

        {/* In by method ------------------------------------------------- */}
        <div className="cdz-tkt-section-label">
          {dzosT('caisse.dayclose.inByMethod', lang)}
        </div>
        <table className="cdz-tkt-table">
          <tbody>
            {methodRows.map(([m, v]) => (
              <tr key={`in-${m}`}>
                <td className="cdz-tkt-td-label">
                  {dzosCaisseMethodLabels[m](lang)}
                </td>
                <td className="cdz-tkt-td-val">{dzosFmtDZD(v, lang)}</td>
              </tr>
            ))}
            <tr className="cdz-tkt-subtotal">
              <td className="cdz-tkt-td-label">
                {dzosT('caisse.journal.kind.in', lang)}
              </td>
              <td className="cdz-tkt-td-val">
                {dzosFmtDZD(num(summary.inTotal), lang)}
              </td>
            </tr>
          </tbody>
        </table>

        {/* Out by method ------------------------------------------------ */}
        <div className="cdz-tkt-section-label">
          {dzosT('caisse.dayclose.outByMethod', lang)}
        </div>
        <table className="cdz-tkt-table">
          <tbody>
            {outRows.map(([m, v]) => (
              <tr key={`out-${m}`}>
                <td className="cdz-tkt-td-label">
                  {dzosCaisseMethodLabels[m](lang)}
                </td>
                <td className="cdz-tkt-td-val">{dzosFmtDZD(v, lang)}</td>
              </tr>
            ))}
            <tr className="cdz-tkt-subtotal">
              <td className="cdz-tkt-td-label">
                {dzosT('caisse.journal.kind.out', lang)}
              </td>
              <td className="cdz-tkt-td-val">
                {dzosFmtDZD(num(summary.outTotal), lang)}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="cdz-tkt-sep" />

        {/* Net total ---------------------------------------------------- */}
        <div className="cdz-tkt-net">
          <span className="cdz-tkt-net-label">
            {dzosT('caisse.dayclose.net', lang)}
          </span>
          <span className="cdz-tkt-net-val">
            {dzosFmtDZD(num(summary.net), lang)}
          </span>
        </div>

        {num(summary.pendingCodTotal) > 0 ? (
          <div className="cdz-tkt-pending">
            COD ({dzosT('caisse.journal.pending', lang)}) :{' '}
            {dzosFmtDZD(num(summary.pendingCodTotal), lang)}
          </div>
        ) : null}

        {/* Footer ------------------------------------------------------- */}
        <div className="cdz-tkt-foot">
          {dzosT('print.ticket.thanks', lang)}
        </div>
        <div className="cdz-tkt-printed-on">
          {dzosT('print.invoice.printedOn', lang)}{' '}
          {new Date().toLocaleString(rtl ? 'ar-DZ' : 'fr-DZ')}
        </div>
      </div>
    </div>
  );
};

// The ticket print CSS: thermal-receipt-style narrow column, invisible on
// screen (0 size, off-canvas); at print time we HIDE the app body and reveal
// ONLY the ticket. Uses `visibility` so the print-root can escape overflow-
// clipped ancestors. Logical properties (text-align: start/end) make the same
// rules work in both LTR and RTL.
const TICKET_PRINT_CSS = `
.cdz-tkt-print-root{position:absolute;width:0;height:0;overflow:hidden;left:-9999px;top:0;}
@media print{
  @page{size:80mm auto;margin:4mm;}
  html,body{background:#fff !important;}
  body *{visibility:hidden !important;}
  .cdz-tkt-print-root,.cdz-tkt-print-root *{visibility:visible !important;}
  .cdz-tkt-print-root{position:absolute !important;left:0 !important;top:0 !important;width:100% !important;height:auto !important;overflow:visible !important;}
  .cdz-tkt-sheet{width:100%;max-width:72mm;margin:0 auto;color:#111;font-size:9pt;line-height:1.4;}
  .cdz-tkt-header{text-align:center;margin-bottom:6px;}
  .cdz-tkt-title{font-size:12pt;font-weight:800;text-transform:uppercase;letter-spacing:0.03em;}
  .cdz-tkt-date{font-size:8.5pt;color:#444;margin-top:2px;}
  .cdz-tkt-sep{border-top:1px dashed #999;margin:6px 0;}
  .cdz-tkt-section-label{font-size:8pt;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#666;margin-bottom:3px;}
  .cdz-tkt-table{width:100%;border-collapse:collapse;margin-bottom:6px;}
  .cdz-tkt-td-label{padding:2px 0;font-size:9pt;text-align:start;}
  .cdz-tkt-td-val{padding:2px 0;font-size:9pt;text-align:end;white-space:nowrap;font-weight:600;}
  .cdz-tkt-subtotal .cdz-tkt-td-label{font-weight:700;border-top:1px solid #ccc;padding-top:4px;}
  .cdz-tkt-subtotal .cdz-tkt-td-val{font-weight:700;border-top:1px solid #ccc;padding-top:4px;}
  .cdz-tkt-net{display:flex;justify-content:space-between;align-items:center;padding:6px 0 4px;border-top:2px solid #111;border-bottom:2px solid #111;margin-bottom:6px;}
  .cdz-tkt-net-label{font-size:11pt;font-weight:800;}
  .cdz-tkt-net-val{font-size:12pt;font-weight:800;white-space:nowrap;}
  .cdz-tkt-pending{font-size:8pt;color:#666;margin-bottom:6px;text-align:start;}
  .cdz-tkt-foot{text-align:center;font-size:9pt;font-weight:600;margin-top:8px;margin-bottom:4px;}
  .cdz-tkt-printed-on{text-align:center;font-size:7.5pt;color:#999;}
}
`;
