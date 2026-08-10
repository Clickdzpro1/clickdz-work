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
  deleteErpWarehouse,
  EmptyNote,
  type ErpInventory,
  type ErpProduct,
  fetchErpCollection,
  fetchErpInventory,
  Field,
  fmtDZD,
  inputStyle,
  isLowStock,
  linkBtnStyle,
  miniBtnStyle,
  type MovementReason,
  MOVEMENT_REASON_LABELS,
  MOVEMENT_REASONS,
  num,
  Panel,
  postErpMovement,
  postErpWarehouse,
  type ProductStock,
  productTitle,
  Spinner,
  tdStyle,
  thStyle,
  type Warehouse,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// Inventory (C4) — multi-warehouse stock management for one store. Reads the
// authed owner-only roll-up:
//   GET /api/v1/apps/:slug/erp/inventory
//     → { warehouses, stockByProduct:{[productKey]:{[warehouseId]:qty, total}}, lowStock }
// and mutates through:
//   POST   /api/v1/apps/:slug/erp/inventory/movement  {productKey,warehouseId,delta,reason,ref?}
//   POST   /api/v1/apps/:slug/erp/warehouse           {name,location?}
//   DELETE /api/v1/apps/:slug/erp/warehouse/:id
// The full product catalogue is read from the public per-slug data API (GET,
// no token) so every product shows a row even before it has any movement.
//
// DEGRADE GRACEFULLY:
//   • Server without the inventory route (or admin_writes_unavailable) →
//     fall back to the product.stock roll-up totals; warehouse controls hide,
//     an info banner explains the read-only fallback.
//   • No warehouses yet → an empty-state prompt to add the first one; the stock
//     table still shows each product's total (product.stock) so the page is
//     useful immediately.
// French where the UI is French (reason labels + prompts). Inline styles only,
// matching the rest of the shoperp page.
// ---------------------------------------------------------------------------

/** The product's business key (same rule the Stock admin + bridge use). */
function productKey(p: ErpProduct): string {
  return String(p.sku || p.title || p.name || p.id || '');
}

/** Dedupe a raw product list on its business key (replace = delete+recreate). */
function dedupeProducts(rows: ErpProduct[]): ErpProduct[] {
  const byKey = new Map<string, ErpProduct>();
  for (const p of rows) {
    const key = productKey(p);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || String(p.createdAt || '') > String(prev.createdAt || '')) {
      byKey.set(key, p);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    productTitle(a).localeCompare(productTitle(b))
  );
}

/** A product's total across warehouses — prefer the ledger roll-up, else stock. */
function stockTotal(
  p: ErpProduct,
  stockByProduct: Record<string, ProductStock>
): number {
  const entry = stockByProduct[productKey(p)];
  if (entry && Number.isFinite(entry.total)) return num(entry.total);
  return num(p.stock);
}

const numInputStyle: CSSProperties = {
  ...inputStyle,
  padding: '7px 9px',
  fontSize: 12.5,
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  padding: '7px 9px',
  fontSize: 12.5,
  cursor: 'pointer',
};

export const Inventory = ({
  slug,
  currency,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  /** The store's slug — also its data-API namespace. */
  slug: string;
  currency: string;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated: () => void;
}) => {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [inventory, setInventory] = useState<ErpInventory | null>(null);
  // When the inventory route isn't available we still render, using the
  // product.stock roll-up totals (fallback mode).
  const [fallback, setFallback] = useState(false);
  const [products, setProducts] = useState<ErpProduct[]>([]);

  const [busy, setBusy] = useState(false);
  const [showAddWh, setShowAddWh] = useState(false);
  const [movementFor, setMovementFor] = useState<ErpProduct | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error';
    text: string;
  } | null>(null);

  const load = useCallback(
    async (soft = false) => {
      if (!soft) setPhase('loading');
      // Always read the catalogue (public GET) so every product gets a row.
      const [inv, catalogue] = await Promise.all([
        fetchErpInventory(slug),
        fetchErpCollection<ErpProduct>(slug, 'products').catch(
          () => [] as ErpProduct[]
        ),
      ]);
      setProducts(dedupeProducts(catalogue));

      if (inv.status === 'ok') {
        setInventory(inv.inventory);
        setFallback(false);
        setPhase('ready');
      } else if (inv.status === 'unavailable') {
        // Route/writes not available → degrade to the product.stock roll-up.
        setInventory({ warehouses: [], stockByProduct: {}, lowStock: [] });
        setFallback(true);
        setPhase('ready');
      } else if (soft) {
        setNotice({ tone: 'error', text: inv.message });
      } else {
        setErrMsg(inv.message);
        setPhase('error');
      }
    },
    [slug]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const warehouses = inventory?.warehouses ?? [];
  const stockByProduct = inventory?.stockByProduct ?? {};

  const addWarehouse = useCallback(
    async (draft: { name: string; location: string }): Promise<boolean> => {
      if (readOnly || busy) return false;
      setBusy(true);
      setNotice(null);
      const out = await postErpWarehouse(slug, {
        name: draft.name,
        ...(draft.location ? { location: draft.location } : {}),
      });
      setBusy(false);
      if (out.status === 'ok') {
        setNotice({ tone: 'ok', text: `Entrepôt « ${draft.name} » ajouté.` });
        setShowAddWh(false);
        await load(true);
        onMutated();
        return true;
      }
      if (out.status === 'unavailable') {
        onWritesBlocked();
        return false;
      }
      setNotice({ tone: 'error', text: out.message });
      return false;
    },
    [readOnly, busy, slug, load, onMutated, onWritesBlocked]
  );

  const removeWarehouse = useCallback(
    async (w: Warehouse) => {
      if (readOnly || busy) return;
      const ok = window.confirm(
        `Supprimer l’entrepôt « ${w.name} » ? Ses mouvements enregistrés restent dans le registre, mais il disparaît du tableau de stock.`
      );
      if (!ok) return;
      setBusy(true);
      setNotice(null);
      const out = await deleteErpWarehouse(slug, w.id);
      setBusy(false);
      if (out.status === 'ok') {
        setNotice({ tone: 'ok', text: `Entrepôt « ${w.name} » supprimé.` });
        await load(true);
        onMutated();
      } else if (out.status === 'unavailable') {
        onWritesBlocked();
      } else {
        setNotice({ tone: 'error', text: out.message });
      }
    },
    [readOnly, busy, slug, load, onMutated, onWritesBlocked]
  );

  const submitMovement = useCallback(
    async (draft: {
      product: ErpProduct;
      warehouseId: string;
      delta: number;
      reason: MovementReason;
      ref: string;
    }): Promise<boolean> => {
      if (readOnly || busy) return false;
      setBusy(true);
      setNotice(null);
      const out = await postErpMovement(slug, {
        productKey: productKey(draft.product),
        warehouseId: draft.warehouseId,
        delta: draft.delta,
        reason: draft.reason,
        ...(draft.ref ? { ref: draft.ref } : {}),
      });
      setBusy(false);
      if (out.status === 'ok') {
        setNotice({
          tone: 'ok',
          text: `${productTitle(draft.product)} : ${draft.delta > 0 ? '+' : ''}${draft.delta} enregistré.`,
        });
        setMovementFor(null);
        await load(true);
        onMutated();
        return true;
      }
      if (out.status === 'unavailable') {
        onWritesBlocked();
        return false;
      }
      setNotice({ tone: 'error', text: out.message });
      return false;
    },
    [readOnly, busy, slug, load, onMutated, onWritesBlocked]
  );

  const lowCount = useMemo(() => {
    // Prefer the server's lowStock list; else derive from product.stock.
    if (inventory && inventory.lowStock.length > 0) {
      return inventory.lowStock.length;
    }
    return products.filter(isLowStock).length;
  }, [inventory, products]);

  if (phase === 'loading') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '24px 4px',
          color: C.muted,
        }}
      >
        <Spinner /> Chargement de l’inventaire…
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

  const noWarehouses = warehouses.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Summary line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, fontSize: 12.5, color: C.muted }}>
          {products.length} {products.length === 1 ? 'produit' : 'produits'}
          {' · '}
          {warehouses.length}{' '}
          {warehouses.length === 1 ? 'entrepôt' : 'entrepôts'}
          {lowCount > 0 ? (
            <span style={{ color: '#e8a33d', fontWeight: 700 }}>
              {' '}
              · {lowCount} en stock faible
            </span>
          ) : null}
        </div>
        <button
          style={miniBtnStyle('secondary', busy)}
          disabled={busy}
          onClick={() => void load(true)}
        >
          {busy ? <Spinner /> : <span aria-hidden>↻</span>} Actualiser
        </button>
      </div>

      {fallback ? (
        <Banner tone="info">
          L'inventaire multi-dépôts n'est pas encore disponible sur ce serveur —
          le <strong>stock total</strong> de chaque produit est affiché. Les
          modifications de stock restent disponibles dans l'onglet <strong>Stock</strong>.
        </Banner>
      ) : null}

      {notice ? (
        <Banner tone={notice.tone === 'ok' ? 'ok' : 'error'}>
          {notice.text}
        </Banner>
      ) : null}

      {/* Warehouses manager — hidden entirely in fallback mode (no route). */}
      {!fallback ? (
        <Panel
          title={`Entrepôts · ${warehouses.length}`}
          action={
            !showAddWh ? (
              <button
                style={miniBtnStyle('primary', readOnly || busy)}
                disabled={readOnly || busy}
                onClick={() => setShowAddWh(true)}
              >
                + Ajouter un dépôt
              </button>
            ) : null
          }
        >
          {showAddWh && !readOnly ? (
            <AddWarehouseForm
              busy={busy}
              onCancel={() => setShowAddWh(false)}
              onSubmit={addWarehouse}
            />
          ) : noWarehouses ? (
            <EmptyNote>
              Aucun entrepôt pour l’instant — ajoutez le premier (ex. « Dépôt principal ») pour commencer à suivre le stock par emplacement. En attendant, le tableau affiche le stock total de chaque produit.
            </EmptyNote>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {warehouses.map(w => (
                <div
                  key={w.id}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px 7px 12px',
                    borderRadius: 999,
                    background: C.panel2,
                    border: `1px solid ${C.border}`,
                  }}
                >
                  <span aria-hidden>🏬</span>
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{ fontWeight: 700, fontSize: 12.5, color: C.text }}
                    >
                      {w.name}
                    </span>
                    {w.location ? (
                      <span style={{ fontSize: 11.5, color: C.muted }}>
                        {' '}
                        · {w.location}
                      </span>
                    ) : null}
                  </span>
                  <button
                    style={{
                      ...linkBtnStyle,
                      color: 'var(--affine-error-color, #eb4b4b)',
                      textDecoration: 'none',
                      fontSize: 15,
                      lineHeight: 1,
                      opacity: readOnly || busy ? 0.4 : 1,
                      cursor: readOnly || busy ? 'default' : 'pointer',
                    }}
                    disabled={readOnly || busy}
                    aria-label={`Supprimer ${w.name}`}
                    title="Supprimer le dépôt"
                    onClick={() => void removeWarehouse(w)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </Panel>
      ) : null}

      {/* Per-product per-warehouse stock table */}
      <Panel title={`Stock par produit · ${products.length}`}>
        {products.length === 0 ? (
          <EmptyNote>
            Aucun produit pour le moment — ajoutez des produits dans l'onglet
            <strong>Stock</strong>, puis enregistrez les mouvements ici.
          </EmptyNote>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr>
                  <th style={thStyle}>Produit</th>
                  {warehouses.map(w => (
                    <th
                      key={w.id}
                      style={{ ...thStyle, textAlign: 'right' }}
                      title={w.location || w.name}
                    >
                      {w.name}
                    </th>
                  ))}
                  <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>État</th>
                  {!fallback ? <th style={thStyle} /> : null}
                </tr>
              </thead>
              <tbody>
                {products.map(p => {
                  const entry = stockByProduct[productKey(p)];
                  const total = stockTotal(p, stockByProduct);
                  const low = isLowStock(p);
                  const inactive = p.active === false;
                  return (
                    <tr
                      key={`${productKey(p)}:${p.id || ''}`}
                      style={inactive ? { opacity: 0.55 } : undefined}
                    >
                      <td style={tdStyle}>
                        <div
                          style={{
                            fontWeight: 700,
                            maxWidth: 240,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={productTitle(p)}
                        >
                          {productTitle(p)}
                        </div>
                        <div style={{ fontSize: 11, color: C.muted }}>
                          {[p.sku, p.category].filter(Boolean).join(' · ') ||
                            '—'}
                        </div>
                      </td>
                      {warehouses.map(w => {
                        const qty = entry ? num(entry[w.id]) : 0;
                        return (
                          <td
                            key={w.id}
                            style={{
                              ...tdStyle,
                              textAlign: 'right',
                              whiteSpace: 'nowrap',
                              fontVariantNumeric: 'tabular-nums',
                              color: qty === 0 ? C.muted : C.text,
                              fontWeight: qty === 0 ? 400 : 600,
                            }}
                          >
                            {qty}
                          </td>
                        );
                      })}
                      <td
                        style={{
                          ...tdStyle,
                          textAlign: 'right',
                          whiteSpace: 'nowrap',
                          fontWeight: 800,
                          fontVariantNumeric: 'tabular-nums',
                          color: low ? '#e8a33d' : C.text,
                        }}
                        title={
                          p.price != null
                            ? `Prix unitaire ${fmtDZD(num(p.price), currency)}`
                            : undefined
                        }
                      >
                        {total}
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          textAlign: 'right',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {inactive ? (
                          <span
                            style={{
                              fontSize: 11.5,
                              fontWeight: 700,
                              color: C.muted,
                            }}
                          >
                            Inactif
                          </span>
                        ) : low ? (
                          <span
                            style={{
                              fontSize: 11.5,
                              fontWeight: 700,
                              color: '#e8a33d',
                            }}
                          >
                            ⚠ Bas
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: 11.5,
                              fontWeight: 700,
                              color: C.okText,
                            }}
                          >
                            OK
                          </span>
                        )}
                      </td>
                      {!fallback ? (
                        <td
                          style={{
                            ...tdStyle,
                            textAlign: 'right',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <button
                            style={miniBtnStyle(
                              'secondary',
                              readOnly || busy || noWarehouses
                            )}
                            disabled={readOnly || busy || noWarehouses}
                            title={
                              noWarehouses
                                ? 'Ajoutez d’abord un dépôt'
                                : 'Enregistrer un mouvement de stock'
                            }
                            onClick={() => setMovementFor(p)}
                          >
                            ± Mouvement
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Stock movement modal */}
      {movementFor && !fallback ? (
        <MovementModal
          product={movementFor}
          warehouses={warehouses}
          currency={currency}
          busy={busy}
          onClose={() => setMovementFor(null)}
          onSubmit={submitMovement}
        />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Add-warehouse form (name + optional location).
// ---------------------------------------------------------------------------

const AddWarehouseForm = ({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: { name: string; location: string }) => Promise<boolean>;
}) => {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [nameErr, setNameErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const n = name.trim().slice(0, 60);
    if (!n) {
      setNameErr('Entrez un nom de dépôt.');
      return;
    }
    setNameErr(null);
    await onSubmit({ name: n, location: location.trim().slice(0, 80) });
  }, [name, location, onSubmit]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 10,
        }}
      >
        <Field label="Nom du dépôt" error={nameErr}>
          <input
            style={inputStyle}
            value={name}
            maxLength={60}
            placeholder="Ex : Dépôt principal"
            onChange={e => setName(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="Lieu" hint="Facultatif — ville / adresse.">
          <input
            style={inputStyle}
            value={location}
            maxLength={80}
            placeholder="Ex : Alger"
            onChange={e => setLocation(e.target.value)}
            disabled={busy}
          />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          style={btnStyle('primary', busy)}
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? (
            <>
              <Spinner dark /> Ajout…
            </>
          ) : (
            'Ajouter le dépôt'
          )}
        </button>
        <button
          style={btnStyle('secondary', busy)}
          disabled={busy}
          onClick={onCancel}
        >
          Annuler
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Stock movement modal — pick a warehouse, an amount, a direction, a reason,
// and an optional reference. The signed delta is (direction × amount): "sale"
// defaults to a negative sign; the toggle lets the owner flip it for
// corrections. Submits POST /erp/inventory/movement.
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
  width: 'min(460px, 96vw)',
  maxHeight: '90vh',
  overflowY: 'auto',
  background: C.panel,
  border: `1px solid ${C.border}`,
  borderRadius: 14,
  boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
  display: 'flex',
  flexDirection: 'column',
};

/** Reasons that default to a stock DECREASE (out); others default to increase. */
const OUT_REASONS: MovementReason[] = ['sale'];

const MovementModal = ({
  product,
  warehouses,
  currency,
  busy,
  onClose,
  onSubmit,
}: {
  product: ErpProduct;
  warehouses: Warehouse[];
  currency: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (draft: {
    product: ErpProduct;
    warehouseId: string;
    delta: number;
    reason: MovementReason;
    ref: string;
  }) => Promise<boolean>;
}) => {
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [reason, setReason] = useState<MovementReason>('purchase');
  // direction: +1 (in) / -1 (out). Defaults from the reason but stays editable.
  const [dir, setDir] = useState<1 | -1>(1);
  const [amount, setAmount] = useState('1');
  const [ref, setRef] = useState('');
  const [amountErr, setAmountErr] = useState<string | null>(null);

  const onReasonChange = useCallback((r: MovementReason) => {
    setReason(r);
    setDir(OUT_REASONS.includes(r) ? -1 : 1);
  }, []);

  const amountN = Math.max(0, Math.round(num(amount)));
  const delta = dir * amountN;

  const submit = useCallback(async () => {
    if (!warehouseId) return;
    if (amountN <= 0) {
      setAmountErr('Entrez une quantité de 1 ou plus.');
      return;
    }
    setAmountErr(null);
    await onSubmit({
      product,
      warehouseId,
      delta,
      reason,
      ref: ref.trim().slice(0, 60),
    });
  }, [warehouseId, amountN, delta, reason, ref, product, onSubmit]);

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label="Enregistrer un mouvement de stock"
      onClick={() => {
        if (!busy) onClose();
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
          <span aria-hidden>±</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>
              Mouvement de stock
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: C.muted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={productTitle(product)}
            >
              {productTitle(product)}
              {product.price != null
                ? ` · ${fmtDZD(num(product.price), currency)}`
                : ''}
            </div>
          </div>
          <button
            style={{ ...linkBtnStyle, color: C.muted, textDecoration: 'none' }}
            aria-label="Fermer"
            onClick={onClose}
            disabled={busy}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <Field label="Dépôt">
            <select
              style={selectStyle}
              value={warehouseId}
              disabled={busy}
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

          <Field label="Motif">
            <select
              style={selectStyle}
              value={reason}
              disabled={busy}
              onChange={e => onReasonChange(e.target.value as MovementReason)}
            >
              {MOVEMENT_REASONS.map(r => (
                <option key={r} value={r}>
                  {MOVEMENT_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
              alignItems: 'end',
            }}
          >
            <Field label="Sens">
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDir(1)}
                  style={{
                    ...miniBtnStyle(dir === 1 ? 'primary' : 'secondary', busy),
                    flex: 1,
                  }}
                >
                  + Entrée
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDir(-1)}
                  style={{
                    ...miniBtnStyle(dir === -1 ? 'danger' : 'secondary', busy),
                    flex: 1,
                  }}
                >
                  − Sortie
                </button>
              </div>
            </Field>
            <Field label="Quantité" error={amountErr}>
              <input
                type="number"
                min={1}
                step={1}
                style={numInputStyle}
                value={amount}
                disabled={busy}
                onChange={e => setAmount(e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Référence"
            hint="Facultatif — une réf. de bon de commande, de facture ou de commande pour le journal."
          >
            <input
              style={inputStyle}
              value={ref}
              maxLength={60}
              placeholder="Ex : PO-2026-014"
              disabled={busy}
              onChange={e => setRef(e.target.value)}
            />
          </Field>

          {/* Effect preview */}
          <div
            style={{
              fontSize: 12.5,
              color: C.muted,
              padding: '9px 12px',
              borderRadius: 8,
              background: C.panel2,
              border: `1px solid ${C.border}`,
            }}
          >
            Effet :{' '}
            <strong
              style={{
                color:
                  delta > 0
                    ? C.okText
                    : delta < 0
                      ? 'var(--affine-error-color, #eb4b4b)'
                      : C.muted,
              }}
            >
              {delta > 0 ? '+' : ''}
              {delta}
            </strong>{' '}
            sur{' '}
            <strong style={{ color: C.text }}>
              {warehouses.find(w => w.id === warehouseId)?.name || '—'}
            </strong>
            .
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            gap: 10,
            padding: '12px 16px',
            borderTop: `1px solid ${C.border}`,
          }}
        >
          <button
            style={btnStyle('primary', busy || !warehouseId)}
            disabled={busy || !warehouseId}
            onClick={() => void submit()}
          >
            {busy ? (
              <>
                <Spinner dark /> Enregistrement…
              </>
            ) : (
              'Enregistrer le mouvement'
            )}
          </button>
          <button
            style={btnStyle('secondary', busy)}
            disabled={busy}
            onClick={onClose}
          >
            Annuler
          </button>
        </div>
      </div>
    </div>
  );
};
