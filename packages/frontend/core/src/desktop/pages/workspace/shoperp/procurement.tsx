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
  cancelPurchaseOrder,
  createPurchaseOrder,
  Field,
  fetchErpInventory,
  fetchPurchaseOrder,
  fetchPurchaseOrders,
  fetchSuppliers,
  fmtDZD,
  inputStyle,
  linkBtnStyle,
  miniBtnStyle,
  num,
  Panel,
  PO_STATUS_LABELS,
  poStatusColor,
  type ProcPurchaseOrder,
  type ProcPurchaseOrderLine,
  type ProcSupplier,
  receivePurchaseOrder,
  saveSupplier,
  Skeleton,
  Spinner,
  tdStyle,
  thStyle,
  type Warehouse,
} from './shoperp-shared';

// DzOS Phase 1: offline-first local store. procurement (suppliers + POs) is
// the 6th panel migrated. Reads hydrate the local store (instant on tab
// switch + offline); supplier + PO writes mirror into the local store. Hybrid:
// the bridge calls stay (server authoritative); offline writes queue. The
// SyncStatusPill shows the sync state.
import { getErpRepo, SyncStatusPill } from '@affine/core/modules/dzos-store';

// ---------------------------------------------------------------------------
// Fournisseurs + Bons de commande (WSE-5, R2-b procurement) — the STUDIO
// procurement surface for one store, on top of the authed owner-only bridge
// routes:
//   GET  /api/v1/apps/:slug/erp/suppliers                       → list
//   POST /api/v1/apps/:slug/erp/suppliers        { supplier }   → upsert (create)
//   PUT  /api/v1/apps/:slug/erp/suppliers/:id     { supplier }  → edit in place
//   GET  /api/v1/apps/:slug/erp/purchase-orders                 → list
//   GET  /api/v1/apps/:slug/erp/purchase-orders/:id             → one PO
//   POST /api/v1/apps/:slug/erp/purchase-orders   { supplierId, lines, … }
//   POST /api/v1/apps/:slug/erp/purchase-orders/:id/receive { lines?, warehouseId? }
//   POST /api/v1/apps/:slug/erp/purchase-orders/:id/cancel
//
// RECEIVING posts REAL stock through the existing multi-warehouse ledger
// server-side (reason 'purchase'), then bumps the supplier balance (dette) by
// the received cost — so after a receive we surface "stock mis à jour" and
// reload to show the new dette. Warehouses are fetched via the inventory
// wrapper; when none exist (or the route is unavailable) the warehouse select
// is omitted and the PO's own warehouseId (if any) is used.
//
// Degrade gracefully: a 501 admin_writes_unavailable flips the surface
// read-only (onWritesBlocked); a 502 data_api_unavailable / network error shows
// a retryable error. FR labels + short darja hints; inline styles only, mobile
// single-column collapse — mirrors inventory.tsx / shop-appearance.tsx.
// ---------------------------------------------------------------------------

type ProcTab = 'suppliers' | 'orders';

const numInputStyle: CSSProperties = {
  ...inputStyle,
  padding: '7px 9px',
  fontSize: 12.5,
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  padding: '9px 11px',
  fontSize: 13,
  cursor: 'pointer',
};

const tabletStyle = (active: boolean): CSSProperties => ({
  appearance: 'none',
  cursor: 'pointer',
  borderRadius: 999,
  padding: '7px 16px',
  fontSize: 13,
  fontWeight: 700,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  color: active ? C.text : C.muted,
  background: active ? C.accentSoft : 'transparent',
  border: `1px solid ${active ? C.accent : C.border}`,
  transition: 'color 160ms ease, border-color 160ms ease, background 160ms ease',
});

// A supplier's dette (balance) read as "we owe them" — positive = outstanding.
function detteLabel(balance: number): { text: string; color: string } {
  const b = num(balance);
  if (b > 0) return { text: fmtDZD(b), color: '#e8a33d' };
  if (b < 0) return { text: `${fmtDZD(-b)} crédit`, color: C.okText };
  return { text: fmtDZD(0), color: C.muted };
}

// ---------------------------------------------------------------------------
// Root panel — owns loading of suppliers + POs + warehouses, the two tab-lets,
// and every mutation. Accepts the dashboard's admin-panel prop shape; currency/
// readOnly/onMutated are optional so it also works with the minimal
// { slug, onWritesBlocked } render chain the tab registration wires.
// ---------------------------------------------------------------------------
export const ProcurementPanel = ({
  slug,
  currency = 'DZD',
  readOnly = false,
  onWritesBlocked,
  onMutated,
}: {
  /** The store's slug — also its data-API namespace. */
  slug: string;
  currency?: string;
  readOnly?: boolean;
  onWritesBlocked?: () => void;
  onMutated?: () => void;
}) => {
  const [tab, setTab] = useState<ProcTab>('suppliers');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');

  const [suppliers, setSuppliers] = useState<ProcSupplier[]>([]);
  const [orders, setOrders] = useState<ProcPurchaseOrder[]>([]);
  // Warehouses (from the inventory roll-up). Empty when the route is
  // unavailable or the shop has none yet → the receive flow omits the select.
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error';
    text: string;
  } | null>(null);

  const load = useCallback(
    async (soft = false) => {
      if (!soft) setPhase('loading');
      const [sup, pos, inv] = await Promise.all([
        fetchSuppliers(slug),
        fetchPurchaseOrders(slug),
        fetchErpInventory(slug),
      ]);

      // Warehouses are best-effort — never block procurement on the inventory
      // route being present.
      setWarehouses(inv.status === 'ok' ? inv.inventory.warehouses : []);

      // Suppliers drive both tab-lets (a PO shows its supplier's name), so a
      // hard failure there is the page's failure; POs failing alone is softer.
      if (sup.status === 'ok') {
        setSuppliers(sup.suppliers);
      } else if (sup.status === 'unavailable') {
        onWritesBlocked?.();
        setSuppliers([]);
      } else if (!soft) {
        setErrMsg(sup.message);
        setPhase('error');
        return;
      } else {
        setNotice({ tone: 'error', text: sup.message });
      }

      if (pos.status === 'ok') {
        setOrders(pos.purchaseOrders);
      } else if (pos.status === 'unavailable') {
        onWritesBlocked?.();
        setOrders([]);
      } else if (soft) {
        setNotice({ tone: 'error', text: pos.message });
      }

      setPhase('ready');
      // DzOS Phase 1: hydrate the local store (suppliers + POs) so the next
      // open is instant + works offline. Best-effort.
      void getErpRepo(slug).then((repo) =>
        Promise.all([
          ...(sup.status === 'ok' ? sup.suppliers.map((s) => repo.upsert('suppliers', String(s.id), s).catch(() => {})) : []),
          ...(pos.status === 'ok' ? pos.purchaseOrders.map((p) => repo.upsert('purchase-orders', String(p.id), p).catch(() => {})) : []),
        ]).catch(() => {})
      );
    },
    [slug, onWritesBlocked]
  );

  useEffect(() => {
    void load().catch(async () => {
      // DzOS Phase 1: offline-read fallback. If the fetches throw (network
      // down), try the local store so suppliers + POs still render.
      try {
        const repo = await getErpRepo(slug);
        const [supLocal, poLocal] = await Promise.all([
          repo.list<ProcSupplier>('suppliers').catch(() => []),
          repo.list<ProcPurchaseOrder>('purchase-orders').catch(() => []),
        ]);
        setSuppliers(supLocal.map((w) => w.data));
        setOrders(poLocal.map((w) => w.data));
        setPhase('ready');
      } catch {
        setPhase('error');
      }
    });
  }, [load, slug]);

  const supplierById = useMemo(() => {
    const m = new Map<string, ProcSupplier>();
    for (const s of suppliers) m.set(s.id, s);
    return m;
  }, [suppliers]);

  // ---- Supplier mutations -------------------------------------------------
  const submitSupplier = useCallback(
    async (
      draft: {
        name: string;
        phone: string;
        email: string;
        address: string;
        active: boolean;
      },
      editId?: string
    ): Promise<boolean> => {
      if (readOnly || busy) return false;
      setBusy(true);
      setNotice(null);
      const out = await saveSupplier(
        slug,
        {
          name: draft.name,
          phone: draft.phone,
          ...(draft.email ? { email: draft.email } : {}),
          ...(draft.address ? { address: draft.address } : {}),
          active: draft.active,
        },
        editId
      );
      setBusy(false);
      if (out.status === 'ok') {
        setNotice({
          tone: 'ok',
          text: `Fournisseur « ${out.supplier.name} » enregistré.`,
        });
        // DzOS Phase 1: mirror the saved supplier into the local store.
        void getErpRepo(slug).then((repo) =>
          repo.upsert('suppliers', String(out.supplier.id), out.supplier).catch(() => {})
        );
        await load(true);
        onMutated?.();
        return true;
      }
      if (out.status === 'unavailable') {
        onWritesBlocked?.();
        return false;
      }
      setNotice({ tone: 'error', text: out.message });
      return false;
    },
    [readOnly, busy, slug, load, onMutated, onWritesBlocked]
  );

  // ---- PO mutations -------------------------------------------------------
  const submitPurchaseOrder = useCallback(
    async (draft: {
      supplierId: string;
      lines: Array<{ label: string; qty: number; unitCost: number }>;
      note: string;
    }): Promise<boolean> => {
      if (readOnly || busy) return false;
      setBusy(true);
      setNotice(null);
      const out = await createPurchaseOrder(slug, {
        supplierId: draft.supplierId,
        lines: draft.lines,
        ...(draft.note ? { note: draft.note } : {}),
      });
      setBusy(false);
      if (out.status === 'ok') {
        setNotice({
          tone: 'ok',
          text: `Bon de commande ${out.purchaseOrder.id} créé.`,
        });
        // DzOS Phase 1: mirror the new PO into the local store.
        void getErpRepo(slug).then((repo) =>
          repo.upsert('purchase-orders', String(out.purchaseOrder.id), out.purchaseOrder).catch(() => {})
        );
        await load(true);
        onMutated?.();
        return true;
      }
      if (out.status === 'unavailable') {
        onWritesBlocked?.();
        return false;
      }
      setNotice({ tone: 'error', text: out.message });
      return false;
    },
    [readOnly, busy, slug, load, onMutated, onWritesBlocked]
  );

  const [detailId, setDetailId] = useState<string | null>(null);

  if (phase === 'loading') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' }}>
        {/* Tab-lets skeleton */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ width: 150, height: 36, borderRadius: 8, background: C.panel2, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
            <Skeleton rows={1} height={36} />
          </div>
          <div style={{ width: 180, height: 36, borderRadius: 8, background: C.panel2, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
            <Skeleton rows={1} height={36} />
          </div>
        </div>
        <Skeleton rows={5} height={48} gap={8} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: C.muted,
            fontSize: 12.5,
          }}
          role="status"
        >
          <Spinner /> Chargement des fournisseurs…
        </div>
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <Banner tone="error">
        {errMsg}{' '}
        <button style={linkBtnStyle} onClick={() => void load()}>
          Réessayer
        </button>
      </Banner>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Section header with gradient icon chip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          aria-hidden
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            background: 'linear-gradient(135deg, #e8a33d, #c97d1f)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 15,
            flexShrink: 0,
          }}
        >
          🏭
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text, letterSpacing: '-0.01em' }}>
            Fournisseurs & Approvisionnement
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 1 }}>
            {suppliers.length} fournisseur{suppliers.length !== 1 ? 's' : ''} · {orders.length} bon{orders.length !== 1 ? 's' : ''} de commande
          </div>
        </div>
        <button
          style={miniBtnStyle('secondary', busy)}
          disabled={busy}
          onClick={() => void load(true)}
        >
          {busy ? <Spinner /> : <span aria-hidden>↻</span>} Actualiser
        </button>
      </div>

      {/* Tab-lets */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'inline-flex', gap: 6 }}>
          <button style={tabletStyle(tab === 'suppliers')} onClick={() => setTab('suppliers')}>
            <span aria-hidden>🏭</span> Fournisseurs
            <span style={{ opacity: 0.7 }}>· {suppliers.length}</span>
          </button>
          <button style={tabletStyle(tab === 'orders')} onClick={() => setTab('orders')}>
            <span aria-hidden>🧾</span> Bons de commande
            <span style={{ opacity: 0.7 }}>· {orders.length}</span>
          </button>
        </div>
      </div>

      {readOnly ? (
        <Banner tone="warn">
          Les modifications sont indisponibles sur ce serveur pour le moment —
          cette page est en <strong>lecture seule</strong>. Vous pouvez toujours
          consulter fournisseurs et bons de commande.
        </Banner>
      ) : null}

      {notice ? (
        <Banner tone={notice.tone === 'ok' ? 'ok' : 'error'}>{notice.text}</Banner>
      ) : null}

      {tab === 'suppliers' ? (
        <SuppliersTablet
          suppliers={suppliers}
          currency={currency}
          readOnly={readOnly}
          busy={busy}
          onSubmit={submitSupplier}
        />
      ) : (
        <OrdersTablet
          slug={slug}
          orders={orders}
          suppliers={suppliers}
          supplierById={supplierById}
          warehouses={warehouses}
          currency={currency}
          readOnly={readOnly}
          busy={busy}
          detailId={detailId}
          onOpenDetail={setDetailId}
          onCreate={submitPurchaseOrder}
          onReceived={async () => {
            await load(true);
            onMutated?.();
          }}
          onWritesBlocked={onWritesBlocked}
          setBusy={setBusy}
          setNotice={setNotice}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// FOURNISSEURS tab-let — list (name, phone tap-to-chat, dette, active) + an
// inline create/edit form. The phone links open WhatsApp (wa.me), Telegram-
// style tap-to-chat, exactly like admin-clients.
// ---------------------------------------------------------------------------

const SuppliersTablet = ({
  suppliers,
  currency,
  readOnly,
  busy,
  onSubmit,
}: {
  suppliers: ProcSupplier[];
  currency: string;
  readOnly: boolean;
  busy: boolean;
  onSubmit: (
    draft: {
      name: string;
      phone: string;
      email: string;
      address: string;
      active: boolean;
    },
    editId?: string
  ) => Promise<boolean>;
}) => {
  // null = form closed; '' = creating; an id = editing that supplier.
  const [formFor, setFormFor] = useState<string | null>(null);

  const editing = useMemo(
    () => (formFor ? suppliers.find(s => s.id === formFor) ?? null : null),
    [formFor, suppliers]
  );

  const totalDette = useMemo(
    () => suppliers.reduce((s, sup) => s + Math.max(0, num(sup.balance)), 0),
    [suppliers]
  );

  return (
    <Panel
      title={`Fournisseurs · ${suppliers.length}`}
      action={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SyncStatusPill slug={slug} />
          {!readOnly && formFor === null ? (
            <button style={miniBtnStyle('primary', busy)} disabled={busy} onClick={() => setFormFor('')}>
              + Nouveau fournisseur
            </button>
          ) : null}
        </div>
      }
    >
      {formFor !== null && !readOnly ? (
        <div style={{ marginBottom: suppliers.length ? 14 : 0 }}>
          <SupplierForm
            key={formFor || 'new'}
            editing={editing}
            busy={busy}
            onCancel={() => setFormFor(null)}
            onSubmit={async draft => {
              const ok = await onSubmit(draft, editing?.id);
              if (ok) setFormFor(null);
              return ok;
            }}
          />
        </div>
      ) : null}

      {suppliers.length === 0 ? (
        formFor === null ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              padding: '36px 16px',
              textAlign: 'center',
            }}
          >
            <span aria-hidden style={{ fontSize: 40, lineHeight: 1, opacity: 0.5 }}>🏭</span>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
              Aucun fournisseur
            </div>
            <div style={{ fontSize: 12.5, color: C.muted, maxWidth: 340, lineHeight: 1.5 }}>
              Ajoutez votre premier fournisseur (nom + numéro WhatsApp) pour créer des bons de commande.
            </div>
            {!readOnly ? (
              <button style={miniBtnStyle('primary', busy)} disabled={busy} onClick={() => setFormFor('')}>
                + Nouveau fournisseur
              </button>
            ) : null}
          </div>
        ) : null
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: C.panel2 }}>
              <tr>
                <th style={thStyle}>Nom</th>
                <th style={thStyle}>Téléphone</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Dette</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Actif</th>
                {!readOnly ? <th style={thStyle} /> : null}
              </tr>
            </thead>
            <tbody>
              {suppliers.map(s => {
                const dette = detteLabel(num(s.balance));
                const phoneDigits = s.phone.replace(/[^0-9]/g, '');
                return (
                  <tr
                    key={s.id}
                    style={s.active ? undefined : { opacity: 0.55 }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = C.panel2; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <td style={tdStyle}>
                      <div
                        style={{
                          fontWeight: 700,
                          maxWidth: 220,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={s.name}
                      >
                        {s.name}
                      </div>
                      {s.email || s.address ? (
                        <div style={{ fontSize: 11, color: C.muted }}>
                          {[s.email, s.address].filter(Boolean).join(' · ')}
                        </div>
                      ) : null}
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        whiteSpace: 'nowrap',
                        fontFamily: 'var(--affine-font-code-family, monospace)',
                      }}
                    >
                      {phoneDigits ? (
                        <a
                          href={`https://wa.me/${phoneDigits}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            color: C.text,
                            textDecoration: 'none',
                          }}
                          title="Ouvrir la discussion WhatsApp"
                        >
                          <span aria-hidden>💬</span>
                          {s.phone}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        fontWeight: 700,
                        fontVariantNumeric: 'tabular-nums',
                        color: dette.color,
                      }}
                    >
                      {dette.text}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'center', whiteSpace: 'nowrap' }}>
                      {s.active ? (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 11,
                            fontWeight: 700,
                            padding: '3px 9px',
                            borderRadius: 999,
                            color: 'var(--affine-success-color, #4cae4c)',
                            background: 'color-mix(in srgb, var(--affine-success-color, #4cae4c) 14%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--affine-success-color, #4cae4c) 30%, transparent)',
                          }}
                        >
                          ✓ Actif
                        </span>
                      ) : (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 11,
                            fontWeight: 700,
                            padding: '3px 9px',
                            borderRadius: 999,
                            color: C.muted,
                            background: 'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 12%, transparent)',
                            border: `1px solid color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 25%, transparent)`,
                          }}
                        >
                          Inactif
                        </span>
                      )}
                    </td>
                    {!readOnly ? (
                      <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          style={miniBtnStyle('secondary', busy)}
                          disabled={busy}
                          onClick={() => setFormFor(s.id)}
                        >
                          Modifier
                        </button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
            {totalDette > 0 ? (
              <tfoot>
                <tr>
                  <td style={{ ...tdStyle, fontWeight: 700, color: C.muted }}>Total dette</td>
                  <td style={tdStyle} />
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: 'right',
                      fontWeight: 800,
                      color: '#e8a33d',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {fmtDZD(totalDette, currency)}
                  </td>
                  <td style={tdStyle} />
                  {!readOnly ? <td style={tdStyle} /> : null}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      )}
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// Supplier create/edit form (inline). name required; phone digits-only; email/
// address optional; active toggle.
// ---------------------------------------------------------------------------

const SupplierForm = ({
  editing,
  busy,
  onCancel,
  onSubmit,
}: {
  editing: ProcSupplier | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: {
    name: string;
    phone: string;
    email: string;
    address: string;
    active: boolean;
  }) => Promise<boolean>;
}) => {
  const [name, setName] = useState(editing?.name ?? '');
  const [phone, setPhone] = useState(editing?.phone ?? '');
  const [email, setEmail] = useState(editing?.email ?? '');
  const [address, setAddress] = useState(editing?.address ?? '');
  const [active, setActive] = useState(editing?.active ?? true);
  const [nameErr, setNameErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const n = name.trim().slice(0, 120);
    if (!n) {
      setNameErr('Entrez un nom de fournisseur.');
      return;
    }
    setNameErr(null);
    await onSubmit({
      name: n,
      phone: phone.replace(/[^0-9+]/g, '').slice(0, 40),
      email: email.trim().slice(0, 160),
      address: address.trim().slice(0, 300),
      active,
    });
  }, [name, phone, email, address, active, onSubmit]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 12,
        borderRadius: 10,
        background: C.panel2,
        border: `1px solid ${C.border}`,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 800, color: C.text }}>
        {editing ? `Modifier « ${editing.name} »` : 'Nouveau fournisseur'}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 10,
        }}
      >
        <Field label="Nom" error={nameErr}>
          <input
            style={inputStyle}
            value={name}
            maxLength={120}
            placeholder="ex. Grossiste Bab Ezzouar"
            disabled={busy}
            onChange={e => setName(e.target.value)}
          />
        </Field>
        <Field label="Téléphone (WhatsApp)" hint="Chiffres seulement, ex. 213600000000.">
          <input
            style={{ ...inputStyle, fontFamily: 'var(--affine-font-code-family, monospace)' }}
            value={phone}
            maxLength={40}
            placeholder="213600000000"
            inputMode="tel"
            disabled={busy}
            onChange={e => setPhone(e.target.value)}
          />
        </Field>
        <Field label="Email" hint="Optionnel.">
          <input
            style={inputStyle}
            value={email}
            maxLength={160}
            placeholder="contact@fournisseur.dz"
            inputMode="email"
            disabled={busy}
            onChange={e => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Adresse" hint="Optionnel.">
          <input
            style={inputStyle}
            value={address}
            maxLength={300}
            placeholder="ex. Zone industrielle, Alger"
            disabled={busy}
            onChange={e => setAddress(e.target.value)}
          />
        </Field>
      </div>
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          cursor: busy ? 'default' : 'pointer',
          fontSize: 13,
          color: C.text,
        }}
      >
        <input
          type="checkbox"
          checked={active}
          disabled={busy}
          onChange={e => setActive(e.target.checked)}
          style={{ width: 16, height: 16, accentColor: C.accent }}
        />
        Fournisseur actif
      </label>
      <div style={{ display: 'flex', gap: 10 }}>
        <button style={btnStyle('primary', busy)} disabled={busy} onClick={() => void submit()}>
          {busy ? (
            <>
              <Spinner dark /> Enregistrement…
            </>
          ) : editing ? (
            'Enregistrer'
          ) : (
            'Ajouter le fournisseur'
          )}
        </button>
        <button style={btnStyle('secondary', busy)} disabled={busy} onClick={onCancel}>
          Annuler
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// BONS DE COMMANDE tab-let — list (id, supplier name, status chip, total),
// a create form (supplier select + lines editor with live total), and a detail
// drawer (receive + cancel). Opening a row fetches the fresh PO (fetchPurchase-
// Order) so the detail always reflects the latest received quantities.
// ---------------------------------------------------------------------------

const OrdersTablet = ({
  slug,
  orders,
  suppliers,
  supplierById,
  warehouses,
  currency,
  readOnly,
  busy,
  detailId,
  onOpenDetail,
  onCreate,
  onReceived,
  onWritesBlocked,
  setBusy,
  setNotice,
}: {
  slug: string;
  orders: ProcPurchaseOrder[];
  suppliers: ProcSupplier[];
  supplierById: Map<string, ProcSupplier>;
  warehouses: Warehouse[];
  currency: string;
  readOnly: boolean;
  busy: boolean;
  detailId: string | null;
  onOpenDetail: (id: string | null) => void;
  onCreate: (draft: {
    supplierId: string;
    lines: Array<{ label: string; qty: number; unitCost: number }>;
    note: string;
  }) => Promise<boolean>;
  onReceived: () => Promise<void>;
  onWritesBlocked?: () => void;
  setBusy: (b: boolean) => void;
  setNotice: (n: { tone: 'ok' | 'error'; text: string } | null) => void;
}) => {
  const [creating, setCreating] = useState(false);

  const supplierName = useCallback(
    (id: string) => supplierById.get(id)?.name || id,
    [supplierById]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel
        title={`Bons de commande · ${orders.length}`}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SyncStatusPill slug={slug} />
            {!readOnly && !creating ? (
              <button
                style={miniBtnStyle('primary', busy || suppliers.length === 0)}
                disabled={busy || suppliers.length === 0}
                title={suppliers.length === 0 ? "Ajoutez d'abord un fournisseur" : "Créer un bon de commande"}
                onClick={() => setCreating(true)}
              >
                + Nouveau bon
              </button>
            ) : null}
          </div>
        }
      >
        {creating && !readOnly ? (
          <div style={{ marginBottom: orders.length ? 14 : 0 }}>
            <PurchaseOrderForm
              suppliers={suppliers}
              currency={currency}
              busy={busy}
              onCancel={() => setCreating(false)}
              onSubmit={async draft => {
                const ok = await onCreate(draft);
                if (ok) setCreating(false);
                return ok;
              }}
            />
          </div>
        ) : null}

        {orders.length === 0 ? (
          !creating ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                padding: '36px 16px',
                textAlign: 'center',
              }}
            >
              <span aria-hidden style={{ fontSize: 40, lineHeight: 1, opacity: 0.5 }}>🧾</span>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
                {suppliers.length === 0 ? "Ajoutez d'abord un fournisseur" : 'Aucun bon de commande'}
              </div>
              <div style={{ fontSize: 12.5, color: C.muted, maxWidth: 340, lineHeight: 1.5 }}>
                {suppliers.length === 0
                  ? "Ajoutez d'abord un fournisseur, puis créez votre premier bon de commande."
                  : 'Créez un bon de commande pour commander du stock à un fournisseur.'}
              </div>
              {suppliers.length > 0 && !readOnly ? (
                <button
                  style={miniBtnStyle('primary', busy || suppliers.length === 0)}
                  disabled={busy || suppliers.length === 0}
                  onClick={() => setCreating(true)}
                >
                  + Nouveau bon de commande
                </button>
              ) : null}
            </div>
          ) : null
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: C.panel2 }}>
                <tr>
                  <th style={thStyle}>N°</th>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Fournisseur</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                  <th style={thStyle}>Statut</th>
                  <th style={thStyle} />
                </tr>
              </thead>
              <tbody>
                {orders.map(po => (
                  <tr
                    key={po.id}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = C.panel2; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <td
                      style={{
                        ...tdStyle,
                        fontFamily: 'var(--affine-font-code-family, monospace)',
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {po.id}
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{po.date || '—'}</td>
                    <td style={tdStyle}>
                      <div
                        style={{
                          maxWidth: 200,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={supplierName(po.supplierId)}
                      >
                        {supplierName(po.supplierId)}
                      </div>
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: 'right',
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {fmtDZD(num(po.totalCost), currency)}
                    </td>
                    <td style={tdStyle}>
                      <PoStatusChip status={po.status} />
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        style={miniBtnStyle('secondary', busy)}
                        disabled={busy}
                        onClick={() => onOpenDetail(po.id)}
                      >
                        Détails
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {detailId ? (
        <PurchaseOrderDetail
          slug={slug}
          poId={detailId}
          supplierName={supplierName}
          warehouses={warehouses}
          currency={currency}
          readOnly={readOnly}
          parentBusy={busy}
          setBusy={setBusy}
          setNotice={setNotice}
          onClose={() => onOpenDetail(null)}
          onReceived={onReceived}
          onWritesBlocked={onWritesBlocked}
        />
      ) : null}
    </div>
  );
};

// A status pill for a PO (French label + status color).
const PoStatusChip = ({ status }: { status: string }) => {
  const color = poStatusColor(status);
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
      {PO_STATUS_LABELS[status] || status || '—'}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Purchase-order create form — supplier select + a lines editor (label / qty /
// PU achat), with a LIVE total. At least one valid line (label) is required.
// ---------------------------------------------------------------------------

interface DraftLine {
  label: string;
  qty: string;
  unitCost: string;
}

const emptyLine = (): DraftLine => ({ label: '', qty: '1', unitCost: '0' });

const PurchaseOrderForm = ({
  suppliers,
  currency,
  busy,
  onCancel,
  onSubmit,
}: {
  suppliers: ProcSupplier[];
  currency: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: {
    supplierId: string;
    lines: Array<{ label: string; qty: number; unitCost: number }>;
    note: string;
  }) => Promise<boolean>;
}) => {
  // Default to the first active supplier (else the first one at all).
  const [supplierId, setSupplierId] = useState(
    () => suppliers.find(s => s.active)?.id ?? suppliers[0]?.id ?? ''
  );
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const total = useMemo(
    () =>
      lines.reduce(
        (s, l) => s + Math.max(0, Math.round(num(l.qty))) * Math.max(0, Math.round(num(l.unitCost))),
        0
      ),
    [lines]
  );

  const setLine = useCallback((i: number, patch: Partial<DraftLine>) => {
    setLines(cur => cur.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }, []);
  const addLine = useCallback(() => setLines(cur => [...cur, emptyLine()]), []);
  const removeLine = useCallback(
    (i: number) => setLines(cur => (cur.length <= 1 ? cur : cur.filter((_, idx) => idx !== i))),
    []
  );

  const submit = useCallback(async () => {
    if (!supplierId) {
      setErr('Choisissez un fournisseur.');
      return;
    }
    const clean = lines
      .map(l => ({
        label: l.label.trim().slice(0, 160),
        qty: Math.max(0, Math.round(num(l.qty))),
        unitCost: Math.max(0, Math.round(num(l.unitCost))),
      }))
      .filter(l => l.label);
    if (clean.length === 0) {
      setErr('Ajoutez au moins une ligne avec un libellé.');
      return;
    }
    setErr(null);
    await onSubmit({ supplierId, lines: clean, note: note.trim().slice(0, 500) });
  }, [supplierId, lines, note, onSubmit]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 12,
        borderRadius: 10,
        background: C.panel2,
        border: `1px solid ${C.border}`,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 800, color: C.text }}>Nouveau bon de commande</div>

      <Field label="Fournisseur">
        <select
          style={selectStyle}
          value={supplierId}
          disabled={busy}
          onChange={e => setSupplierId(e.target.value)}
        >
          {suppliers.map(s => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.active ? '' : ' (inactif)'}
            </option>
          ))}
        </select>
      </Field>

      {/* Lines editor */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: C.muted }}>
          Lignes
        </div>
        {lines.map((l, i) => {
          const lineTotal =
            Math.max(0, Math.round(num(l.qty))) * Math.max(0, Math.round(num(l.unitCost)));
          return (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(120px, 1fr) 70px 100px auto',
                gap: 6,
                alignItems: 'center',
              }}
            >
              <input
                style={numInputStyle}
                value={l.label}
                maxLength={160}
                placeholder="Libellé (ex. T-shirt L)"
                disabled={busy}
                onChange={e => setLine(i, { label: e.target.value })}
              />
              <input
                type="number"
                min={0}
                step={1}
                style={{ ...numInputStyle, textAlign: 'right' }}
                value={l.qty}
                placeholder="Qté"
                disabled={busy}
                onChange={e => setLine(i, { qty: e.target.value })}
                title="Quantité"
              />
              <input
                type="number"
                min={0}
                step={1}
                style={{ ...numInputStyle, textAlign: 'right' }}
                value={l.unitCost}
                placeholder="PU achat"
                disabled={busy}
                onChange={e => setLine(i, { unitCost: e.target.value })}
                title="Prix unitaire d'achat (DZD)"
              />
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  whiteSpace: 'nowrap',
                }}
              >
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: C.muted,
                    fontVariantNumeric: 'tabular-nums',
                    minWidth: 64,
                    textAlign: 'right',
                  }}
                >
                  {fmtDZD(lineTotal, currency)}
                </span>
                <button
                  style={{
                    ...linkBtnStyle,
                    color: 'var(--affine-error-color, #eb4b4b)',
                    textDecoration: 'none',
                    fontSize: 16,
                    lineHeight: 1,
                    opacity: busy || lines.length <= 1 ? 0.4 : 1,
                    cursor: busy || lines.length <= 1 ? 'default' : 'pointer',
                  }}
                  disabled={busy || lines.length <= 1}
                  aria-label="Supprimer la ligne"
                  title="Supprimer la ligne"
                  onClick={() => removeLine(i)}
                >
                  ×
                </button>
              </span>
            </div>
          );
        })}
        <div>
          <button style={miniBtnStyle('secondary', busy)} disabled={busy} onClick={addLine}>
            + Ajouter une ligne
          </button>
        </div>
      </div>

      <Field label="Note" hint="Optionnel.">
        <input
          style={inputStyle}
          value={note}
          maxLength={500}
          placeholder="ex. Livraison prévue semaine prochaine"
          disabled={busy}
          onChange={e => setNote(e.target.value)}
        />
      </Field>

      {/* Live total */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '9px 12px',
          borderRadius: 8,
          background: C.bg,
          border: `1px solid ${C.border}`,
        }}
      >
        <span style={{ fontSize: 12.5, color: C.muted, fontWeight: 700 }}>Total du bon</span>
        <span style={{ fontSize: 15, fontWeight: 800, color: C.text, fontVariantNumeric: 'tabular-nums' }}>
          {fmtDZD(total, currency)}
        </span>
      </div>

      {err ? (
        <span style={{ fontSize: 12, color: 'var(--affine-error-color, #eb4b4b)' }}>{err}</span>
      ) : null}

      <div style={{ display: 'flex', gap: 10 }}>
        <button
          style={btnStyle('primary', busy || !supplierId)}
          disabled={busy || !supplierId}
          onClick={() => void submit()}
        >
          {busy ? (
            <>
              <Spinner dark /> Création…
            </>
          ) : (
            'Créer le bon de commande'
          )}
        </button>
        <button style={btnStyle('secondary', busy)} disabled={busy} onClick={onCancel}>
          Annuler
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Purchase-order detail modal — line table with qtyReceived progress bars, a
// Réceptionner flow (per-line qty inputs capped at the outstanding qty, an
// optional warehouse select when warehouses exist), and Annuler for a
// brouillon/commande PO. Fetches the fresh PO on open so it always reflects the
// latest received state. On a successful receive we surface "stock mis à jour"
// (+ the new supplier dette when the backend returns it) and reload the parent.
// ---------------------------------------------------------------------------

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};

const modalStyle: CSSProperties = {
  width: 'min(560px, 96vw)',
  maxHeight: '90vh',
  overflowY: 'auto',
  background: C.panel,
  border: `1px solid ${C.border}`,
  borderRadius: 14,
  boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
  display: 'flex',
  flexDirection: 'column',
};

const PurchaseOrderDetail = ({
  slug,
  poId,
  supplierName,
  warehouses,
  currency,
  readOnly,
  parentBusy,
  setBusy,
  setNotice,
  onClose,
  onReceived,
  onWritesBlocked,
}: {
  slug: string;
  poId: string;
  supplierName: (id: string) => string;
  warehouses: Warehouse[];
  currency: string;
  readOnly: boolean;
  parentBusy: boolean;
  setBusy: (b: boolean) => void;
  setNotice: (n: { tone: 'ok' | 'error'; text: string } | null) => void;
  onClose: () => void;
  onReceived: () => Promise<void>;
  onWritesBlocked?: () => void;
}) => {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [po, setPo] = useState<ProcPurchaseOrder | null>(null);
  const [receiving, setReceiving] = useState(false);
  // Per-line receive quantities (index → string), only used in receive mode.
  const [recvQty, setRecvQty] = useState<Record<number, string>>({});
  const [warehouseId, setWarehouseId] = useState('');
  const [localBusy, setLocalBusy] = useState(false);
  const [localNotice, setLocalNotice] = useState<string | null>(null);

  const loadPo = useCallback(async () => {
    setPhase('loading');
    const out = await fetchPurchaseOrder(slug, poId);
    if (out.status === 'ok') {
      setPo(out.purchaseOrder);
      // Default the warehouse select to the PO's own, else the first warehouse.
      setWarehouseId(out.purchaseOrder.warehouseId || warehouses[0]?.id || '');
      setPhase('ready');
    } else if (out.status === 'unavailable') {
      onWritesBlocked?.();
      setErrMsg('Indisponible sur ce serveur.');
      setPhase('error');
    } else {
      setErrMsg(out.message);
      setPhase('error');
    }
  }, [slug, poId, warehouses, onWritesBlocked]);

  useEffect(() => {
    void loadPo();
  }, [loadPo]);

  const lines = po?.lines ?? [];
  const outstanding = useCallback(
    (l: ProcPurchaseOrderLine) => Math.max(0, num(l.qty) - num(l.qtyReceived)),
    []
  );
  const totalOutstanding = useMemo(
    () => lines.reduce((s, l) => s + outstanding(l), 0),
    [lines, outstanding]
  );

  const canReceive =
    !!po && po.status !== 'annule' && po.status !== 'recu' && totalOutstanding > 0;
  const canCancel = !!po && (po.status === 'brouillon' || po.status === 'commande');
  // A warehouse is required to receive: either the PO already has one, or the
  // shop has warehouses to pick from. If neither, receiving is blocked with a hint.
  const hasWarehouse = !!(po?.warehouseId || warehouses.length > 0);

  const startReceive = useCallback(() => {
    // Pre-fill each line's receive qty with its full outstanding amount.
    const seed: Record<number, string> = {};
    lines.forEach((l, i) => {
      const out = outstanding(l);
      if (out > 0) seed[i] = String(out);
    });
    setRecvQty(seed);
    setReceiving(true);
    setLocalNotice(null);
  }, [lines, outstanding]);

  const doReceive = useCallback(async () => {
    if (!po || localBusy) return;
    // Build the receive lines from the per-line inputs, clamped to outstanding.
    const reqLines: Array<{ label: string; productId?: string; qty: number }> = [];
    lines.forEach((l, i) => {
      const want = Math.max(0, Math.round(num(recvQty[i] ?? '0')));
      const take = Math.min(want, outstanding(l));
      if (take > 0) {
        reqLines.push({
          label: l.label,
          ...(l.productId ? { productId: l.productId } : {}),
          qty: take,
        });
      }
    });
    if (reqLines.length === 0) {
      setLocalNotice('Entrez une quantité à réceptionner (au moins 1).');
      return;
    }
    setLocalBusy(true);
    setBusy(true);
    const out = await receivePurchaseOrder(slug, po.id, {
      lines: reqLines,
      ...(warehouseId ? { warehouseId } : {}),
    });
    setLocalBusy(false);
    setBusy(false);
    if (out.status === 'ok') {
      const parts = [
        out.movements > 0 ? 'stock mis à jour' : 'bon mis à jour',
      ];
      if (out.supplierBalance !== undefined) {
        parts.push(`dette fournisseur : ${fmtDZD(out.supplierBalance, currency)}`);
      }
      setNotice({ tone: 'ok', text: `Réception enregistrée — ${parts.join(' · ')}.` });
      setReceiving(false);
      setPo(out.purchaseOrder);
      await onReceived();
      // Fully received → close; else keep open showing the updated progress.
      if (out.purchaseOrder.status === 'recu') onClose();
      return;
    }
    if (out.status === 'unavailable') {
      onWritesBlocked?.();
      return;
    }
    setLocalNotice(out.message);
  }, [
    po,
    localBusy,
    lines,
    recvQty,
    outstanding,
    slug,
    warehouseId,
    currency,
    setBusy,
    setNotice,
    onReceived,
    onClose,
    onWritesBlocked,
  ]);

  const doCancel = useCallback(async () => {
    if (!po || localBusy) return;
    const ok = window.confirm(
      `Annuler le bon de commande ${po.id} ? Cette action est définitive.`
    );
    if (!ok) return;
    setLocalBusy(true);
    setBusy(true);
    const out = await cancelPurchaseOrder(slug, po.id);
    setLocalBusy(false);
    setBusy(false);
    if (out.status === 'ok') {
      setNotice({ tone: 'ok', text: `Bon de commande ${po.id} annulé.` });
      await onReceived();
      onClose();
      return;
    }
    if (out.status === 'unavailable') {
      onWritesBlocked?.();
      return;
    }
    setLocalNotice(out.message);
  }, [po, localBusy, slug, setBusy, setNotice, onReceived, onClose, onWritesBlocked]);

  const disabled = readOnly || parentBusy || localBusy;

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label="Détails du bon de commande"
      onClick={() => {
        if (!localBusy) onClose();
      }}
    >
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            borderBottom: `1px solid ${C.border}`,
            background: C.panel2,
            borderTopLeftRadius: 14,
            borderTopRightRadius: 14,
          }}
        >
          <span aria-hidden>🧾</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 800,
                color: C.text,
                fontFamily: 'var(--affine-font-code-family, monospace)',
              }}
            >
              {poId}
            </div>
            {po ? (
              <div
                style={{
                  fontSize: 11.5,
                  color: C.muted,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={supplierName(po.supplierId)}
              >
                {supplierName(po.supplierId)}
                {po.date ? ` · ${po.date}` : ''}
              </div>
            ) : null}
          </div>
          {po ? <PoStatusChip status={po.status} /> : null}
          <button
            style={{ ...linkBtnStyle, color: C.muted, textDecoration: 'none' }}
            aria-label="Fermer"
            onClick={onClose}
            disabled={localBusy}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {phase === 'loading' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, padding: '12px 0' }}>
              <Spinner /> Chargement du bon…
            </div>
          ) : phase === 'error' ? (
            <Banner tone="error">
              {errMsg}{' '}
              <button style={linkBtnStyle} onClick={() => void loadPo()}>
                Réessayer
              </button>
            </Banner>
          ) : po ? (
            <>
              {localNotice ? <Banner tone="error">{localNotice}</Banner> : null}

              {/* Lines with progress bars */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: C.panel2 }}>
                    <tr>
                      <th style={thStyle}>Article</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>PU</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Reçu / Cmd</th>
                      <th style={{ ...thStyle, width: 110 }}>Progression</th>
                      {receiving ? <th style={{ ...thStyle, textAlign: 'right', width: 84 }}>Recevoir</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => {
                      const ordered = num(l.qty);
                      const received = num(l.qtyReceived);
                      const out = outstanding(l);
                      const pct = ordered > 0 ? Math.min(100, Math.round((received / ordered) * 100)) : 0;
                      return (
                        <tr key={`${l.label}-${i}`}>
                          <td style={tdStyle}>
                            <div
                              style={{
                                fontWeight: 600,
                                maxWidth: 200,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={l.label}
                            >
                              {l.label}
                            </div>
                          </td>
                          <td
                            style={{
                              ...tdStyle,
                              textAlign: 'right',
                              whiteSpace: 'nowrap',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {fmtDZD(num(l.unitCost), currency)}
                          </td>
                          <td
                            style={{
                              ...tdStyle,
                              textAlign: 'right',
                              whiteSpace: 'nowrap',
                              fontVariantNumeric: 'tabular-nums',
                              fontWeight: 700,
                              color: received >= ordered ? C.okText : C.text,
                            }}
                          >
                            {received} / {ordered}
                          </td>
                          <td style={tdStyle}>
                            <div
                              style={{
                                height: 8,
                                borderRadius: 999,
                                background: C.panel2,
                                border: `1px solid ${C.border}`,
                                overflow: 'hidden',
                              }}
                              title={`${pct}%`}
                            >
                              <div
                                style={{
                                  height: '100%',
                                  width: `${pct}%`,
                                  background: pct >= 100
                                    ? 'linear-gradient(90deg, var(--affine-success-color, #4cae4c), #22c55e)'
                                    : 'linear-gradient(90deg, #1e96eb, #0e6bbf)',
                                  transition: 'width 300ms ease',
                                  borderRadius: 999,
                                }}
                              />
                            </div>
                          </td>
                          {receiving ? (
                            <td style={{ ...tdStyle, textAlign: 'right' }}>
                              {out > 0 ? (
                                <input
                                  type="number"
                                  min={0}
                                  max={out}
                                  step={1}
                                  style={{ ...numInputStyle, textAlign: 'right', width: 72 }}
                                  value={recvQty[i] ?? '0'}
                                  disabled={disabled}
                                  onChange={e => {
                                    const v = Math.max(0, Math.min(out, Math.round(num(e.target.value))));
                                    setRecvQty(cur => ({ ...cur, [i]: String(v) }));
                                  }}
                                  title={`Max ${out}`}
                                />
                              ) : (
                                <span style={{ fontSize: 11.5, color: C.okText, fontWeight: 700 }}>Complet</span>
                              )}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Total + note */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 12.5,
                  color: C.muted,
                }}
              >
                <span>
                  {po.note ? (
                    <span style={{ color: C.text }}>{po.note}</span>
                  ) : (
                    <span>{lines.length} ligne(s)</span>
                  )}
                </span>
                <span style={{ fontWeight: 800, color: C.text, fontVariantNumeric: 'tabular-nums' }}>
                  Total {fmtDZD(num(po.totalCost), currency)}
                </span>
              </div>

              {/* Warehouse select (receive mode) — only when warehouses exist. */}
              {receiving && warehouses.length > 0 ? (
                <Field label="Entrepôt de réception" hint="Le stock reçu entre dans cet entrepôt.">
                  <select
                    style={selectStyle}
                    value={warehouseId}
                    disabled={disabled}
                    onChange={e => setWarehouseId(e.target.value)}
                  >
                    {warehouses.map(w => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                        {w.location ? ` — ${w.location}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}

              {receiving && warehouses.length === 0 && !po.warehouseId ? (
                <Banner tone="info">
                  Aucun entrepôt configuré — le stock reçu sera enregistré sur
                  l'entrepôt par défaut du bon. Ajoutez des entrepôts dans
                  l'onglet <strong>Inventaire</strong> pour choisir la destination.
                </Banner>
              ) : null}
            </>
          ) : null}
        </div>

        {/* Footer — actions */}
        {phase === 'ready' && po ? (
          <div
            style={{
              display: 'flex',
              gap: 10,
              flexWrap: 'wrap',
              padding: '12px 16px',
              borderTop: `1px solid ${C.border}`,
            }}
          >
            {!receiving ? (
              <>
                {canReceive && !readOnly ? (
                  <button
                    style={btnStyle('primary', disabled || !hasWarehouse)}
                    disabled={disabled || !hasWarehouse}
                    title={hasWarehouse ? "Réceptionner du stock" : "Ajoutez d'abord un entrepôt (onglet Inventaire)"}
                    onClick={startReceive}
                  >
                    📥 Réceptionner
                  </button>
                ) : null}
                {canCancel && !readOnly ? (
                  <button style={btnStyle('danger', disabled)} disabled={disabled} onClick={() => void doCancel()}>
                    {localBusy ? (
                      <>
                        <Spinner /> Annulation…
                      </>
                    ) : (
                      'Annuler le bon'
                    )}
                  </button>
                ) : null}
                {!canReceive && po.status === 'recu' ? (
                  <span style={{ fontSize: 12.5, color: C.okText, fontWeight: 700, alignSelf: 'center' }}>
                    ✓ Entièrement réceptionné
                  </span>
                ) : null}
                {po.status === 'annule' ? (
                  <span style={{ fontSize: 12.5, color: C.muted, fontWeight: 700, alignSelf: 'center' }}>
                    Bon annulé
                  </span>
                ) : null}
                <div style={{ flex: 1 }} />
                <button style={btnStyle('secondary', localBusy)} disabled={localBusy} onClick={onClose}>
                  Fermer
                </button>
              </>
            ) : (
              <>
                <button style={btnStyle('primary', disabled)} disabled={disabled} onClick={() => void doReceive()}>
                  {localBusy ? (
                    <>
                      <Spinner dark /> Réception…
                    </>
                  ) : (
                    'Confirmer la réception'
                  )}
                </button>
                <button
                  style={btnStyle('secondary', localBusy)}
                  disabled={localBusy}
                  onClick={() => setReceiving(false)}
                >
                  Retour
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};
