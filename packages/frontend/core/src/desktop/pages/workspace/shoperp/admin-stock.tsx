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
  type DescribeResult,
  type ErpProduct,
  fetchErpCollection,
  Field,
  fmtDZD,
  hintStyle,
  inputStyle,
  isLowStock,
  linkBtnStyle,
  miniBtnStyle,
  num,
  Panel,
  postErpDescribe,
  postErpProduct,
  productTitle,
  Skeleton,
  Spinner,
  tdStyle,
  thStyle,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// Stock admin — products + inventory. Reads the full catalogue straight from
// the public per-slug data API; edits go through the authed bridge route
// POST /api/v1/apps/:slug/erp/product {product} (upsert by sku/title — the
// backend deletes + recreates the record, so rows are keyed on business keys
// and the list re-fetches after every save). Edits are draft-until-saved:
// tweak stock / reorder threshold with the steppers, then hit Save.
// Shop products use `title`, ERP-created ones use `name`/`sku` — both render.
// ---------------------------------------------------------------------------

const numInputStyle: CSSProperties = {
  ...inputStyle,
  width: 64,
  padding: '5px 8px',
  fontSize: 12.5,
  textAlign: 'center',
};

const stepBtnStyle = (disabled: boolean): CSSProperties => ({
  ...miniBtnStyle('secondary', disabled),
  width: 26,
  height: 26,
  padding: 0,
  fontSize: 14,
  lineHeight: 1,
});

function productKey(p: ErpProduct): string {
  return String(p.sku || p.title || p.name || p.id || '');
}

// The product model carries a single `description` field (bridge caps it at
// ~900 chars). Fold any generated bullets into the body as a plain "• " list so
// the whole result is preserved when written via the existing erp/product
// route. Trimmed to a safe length client-side (the server re-clamps anyway).
const DESC_MAX = 900;
function composeDescription(result: DescribeResult): string {
  const parts: string[] = [];
  const body = String(result.description || '').trim();
  if (body) parts.push(body);
  const bullets = Array.isArray(result.bullets)
    ? result.bullets.map(b => String(b).trim()).filter(Boolean)
    : [];
  if (bullets.length) {
    parts.push(bullets.map(b => `• ${b}`).join('\n'));
  }
  return parts.join('\n\n').slice(0, DESC_MAX);
}

export const StockAdmin = ({
  slug,
  currency,
  readOnly,
  onWritesBlocked,
  onMutated,
}: {
  slug: string;
  currency: string;
  readOnly: boolean;
  onWritesBlocked: () => void;
  onMutated: () => void;
}) => {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [products, setProducts] = useState<ErpProduct[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error';
    text: string;
  } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  // Phase 2: paginate the products table (was rendering ALL rows at once —
  // fine for 20 products, janky at 500+). 25 rows per page keeps the DOM lean.
  const PRODUCTS_PER_PAGE = 25;
  const [productPage, setProductPage] = useState(0);
  // The product whose AI description is being generated/previewed (C5).
  const [describeFor, setDescribeFor] = useState<ErpProduct | null>(null);
  const [applying, setApplying] = useState(false);

  const load = useCallback(
    async (soft = false) => {
      if (!soft) setPhase('loading');
      try {
        const rows = await fetchErpCollection<ErpProduct>(slug, 'products');
        // Dedupe on the business key (sku/title) — replace = delete+recreate.
        const byKey = new Map<string, ErpProduct>();
        for (const p of rows) {
          const key = productKey(p);
          if (!key) continue;
          const prev = byKey.get(key);
          if (
            !prev ||
            String(p.createdAt || '') > String(prev.createdAt || '')
          ) {
            byKey.set(key, p);
          }
        }
        const list = [...byKey.values()].sort((a, b) =>
          productTitle(a).localeCompare(productTitle(b))
        );
        setProducts(list);
        setPhase('ready');
      } catch {
        if (!soft) setPhase('error');
      }
    },
    [slug]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Phase 2: reset to page 0 when the product list changes (refetch / filter).
  useEffect(() => {
    setProductPage(0);
  }, [products]);

  // Phase 2: clamp the page when products shrink (e.g. after a delete).
  const totalProductPages = Math.max(1, Math.ceil(products.length / PRODUCTS_PER_PAGE));
  const safePage = Math.min(productPage, totalProductPages - 1);
  const pagedProducts = useMemo(
    () => products.slice(safePage * PRODUCTS_PER_PAGE, (safePage + 1) * PRODUCTS_PER_PAGE),
    [products, safePage]
  );

  // Shared outcome handling for row saves + the add form.
  const submitProduct = useCallback(
    async (product: ErpProduct, okText: string): Promise<boolean> => {
      const out = await postErpProduct(slug, product);
      if (out.status === 'ok') {
        setNotice({ tone: 'ok', text: okText });
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
    [slug, load, onMutated, onWritesBlocked]
  );

  const saveRow = useCallback(
    async (p: ErpProduct, stock: number, reorderAt: number) => {
      const key = productKey(p);
      if (!key || readOnly || busyKey) return;
      setBusyKey(key);
      setNotice(null);
      await submitProduct(
        { ...p, stock, reorderAt },
        `${productTitle(p)} enregistré — stock ${stock}, réappro à ${reorderAt}.`
      );
      setBusyKey(null);
    },
    [readOnly, busyKey, submitProduct]
  );

  const addProduct = useCallback(
    async (draft: {
      title: string;
      price: number;
      stock: number;
      reorderAt: number;
    }): Promise<boolean> => {
      if (readOnly || busyKey) return false;
      setBusyKey('__add__');
      setNotice(null);
      const ok = await submitProduct(
        {
          type: 'product',
          title: draft.title,
          price: draft.price,
          stock: draft.stock,
          reorderAt: draft.reorderAt,
          category: '',
          description: '',
          imageUrl: '',
          active: true,
        },
        `${draft.title} ajouté au catalogue.`
      );
      setBusyKey(null);
      if (ok) setShowAdd(false);
      return ok;
    },
    [readOnly, busyKey, submitProduct]
  );

  // Apply a generated description to the product (writes via the EXISTING
  // erp/product route). The product model has a single `description` field, so
  // any bullets are folded into the body as a bullet list on write.
  const applyDescription = useCallback(
    async (product: ErpProduct, result: DescribeResult): Promise<boolean> => {
      if (readOnly || applying) return false;
      setApplying(true);
      setNotice(null);
      const description = composeDescription(result);
      const ok = await submitProduct(
        { ...product, description },
        `${productTitle(product)} — description mise à jour.`
      );
      setApplying(false);
      if (ok) setDescribeFor(null);
      return ok;
    },
    [readOnly, applying, submitProduct]
  );

  if (phase === 'loading') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 12,
          }}
        >
          <Skeleton rows={1} height={70} />
          <Skeleton rows={1} height={70} />
          <Skeleton rows={1} height={70} />
        </div>
        <Skeleton rows={6} height={48} gap={8} />
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
          <Spinner /> Chargement des produits…
        </div>
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <Banner tone="error">
        Impossible de charger les produits.{' '}
        <button style={linkBtnStyle} onClick={() => void load()}>
          Réessayer
        </button>
      </Banner>
    );
  }

  const lowCount = products.filter(isLowStock).length;

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
            background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 15,
            flexShrink: 0,
          }}
        >
          🏷️
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text, letterSpacing: '-0.01em' }}>
            Catalogue produits
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 1 }}>
            {products.length} {products.length === 1 ? 'produit' : 'produits'}
            {lowCount > 0 ? (
              <span style={{ color: '#e8a33d', fontWeight: 700 }}>
                {' '}· {lowCount} en stock faible
              </span>
            ) : null}
          </div>
        </div>
        {!showAdd ? (
          <button
            style={miniBtnStyle('primary', readOnly)}
            disabled={readOnly}
            onClick={() => setShowAdd(true)}
          >
            + Ajouter un produit
          </button>
        ) : null}
      </div>

      {/* KPI chips */}
      {products.length > 0 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: 10,
          }}
        >
          <div
            style={{
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 12,
              padding: '10px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: C.muted }}>
              Produits actifs
            </div>
            <div style={{ fontSize: 19, fontWeight: 800, color: C.text, letterSpacing: '-0.02em' }}>
              {products.filter(p => p.active !== false).length}
            </div>
          </div>
          <div
            style={{
              background: lowCount > 0 ? 'color-mix(in srgb, #e8a33d 8%, transparent)' : C.panel,
              border: `1px solid ${lowCount > 0 ? 'color-mix(in srgb, #e8a33d 40%, transparent)' : C.border}`,
              borderRadius: 12,
              padding: '10px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: lowCount > 0 ? '#e8a33d' : C.muted }}>
              Stock faible
            </div>
            <div style={{ fontSize: 19, fontWeight: 800, color: lowCount > 0 ? '#e8a33d' : C.text, letterSpacing: '-0.02em' }}>
              {lowCount}
            </div>
          </div>
          <div
            style={{
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 12,
              padding: '10px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: C.muted }}>
              Catégories
            </div>
            <div style={{ fontSize: 19, fontWeight: 800, color: C.text, letterSpacing: '-0.02em' }}>
              {new Set(products.map(p => p.category).filter(Boolean)).size || '—'}
            </div>
          </div>
        </div>
      ) : null}

      {notice ? (
        <Banner tone={notice.tone === 'ok' ? 'ok' : 'error'}>
          {notice.text}
        </Banner>
      ) : null}

      {showAdd && !readOnly ? (
        <AddProductForm
          currency={currency}
          busy={busyKey === '__add__'}
          onCancel={() => setShowAdd(false)}
          onSubmit={addProduct}
        />
      ) : null}

      <Panel title={`Catalogue · ${products.length}`}>
        {products.length === 0 ? (
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
            <span aria-hidden style={{ fontSize: 40, lineHeight: 1, opacity: 0.5 }}>🏷️</span>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
              Aucun produit pour le moment
            </div>
            <div style={{ fontSize: 12.5, color: C.muted, maxWidth: 320, lineHeight: 1.5 }}>
              Ajoutez votre premier produit (nom, prix, stock) pour commencer à vendre.
            </div>
            {!readOnly ? (
              <button
                style={miniBtnStyle('primary')}
                onClick={() => setShowAdd(true)}
              >
                + Ajouter un produit
              </button>
            ) : null}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 12.5,
              }}
            >
              <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: C.panel2 }}>
                <tr>
                  {['Produit', 'Prix', 'Stock', 'Seuil réappro', 'État', ''].map(
                    (h, i) => (
                      <th key={`${h}-${i}`} style={thStyle}>
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {pagedProducts.map(p => (
                  <ProductRow
                    // id changes after every replace → the row remounts with
                    // fresh saved values once the re-fetch lands.
                    key={`${productKey(p)}:${p.id || ''}`}
                    product={p}
                    currency={currency}
                    readOnly={readOnly}
                    busy={busyKey === productKey(p)}
                    anyBusy={busyKey !== null}
                    onSave={saveRow}
                    onDescribe={() => setDescribeFor(p)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* Phase 2: pagination controls for the products table. */}
        {products.length > PRODUCTS_PER_PAGE ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', padding: '8px 0' }}>
            <button
              style={miniBtnStyle('secondary', safePage === 0)}
              disabled={safePage === 0}
              onClick={() => setProductPage(p => Math.max(0, p - 1))}
            >
              ← Précédent
            </button>
            <span style={{ fontSize: 12.5, color: C.muted }}>
              {safePage + 1} / {totalProductPages}
            </span>
            <button
              style={miniBtnStyle('secondary', safePage >= totalProductPages - 1)}
              disabled={safePage >= totalProductPages - 1}
              onClick={() => setProductPage(p => Math.min(totalProductPages - 1, p + 1))}
            >
              Suivant →
            </button>
          </div>
        ) : null}
      </Panel>

      {/* AI description generator + preview (C5) */}
      {describeFor ? (
        <DescribeModal
          key={productKey(describeFor)}
          slug={slug}
          product={describeFor}
          applying={applying}
          onClose={() => {
            if (!applying) setDescribeFor(null);
          }}
          onApply={applyDescription}
          onWritesBlocked={onWritesBlocked}
        />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// One catalogue row — draft stock/reorder inputs + Save when dirty.
// ---------------------------------------------------------------------------

const ProductRow = ({
  product: p,
  currency,
  readOnly,
  busy,
  anyBusy,
  onSave,
  onDescribe,
}: {
  product: ErpProduct;
  currency: string;
  readOnly: boolean;
  busy: boolean;
  anyBusy: boolean;
  onSave: (p: ErpProduct, stock: number, reorderAt: number) => Promise<void>;
  onDescribe: () => void;
}) => {
  const [stock, setStock] = useState(String(num(p.stock)));
  const [reorder, setReorder] = useState(String(num(p.reorderAt)));

  const stockN = Math.max(0, Math.round(num(stock)));
  const reorderN = Math.max(0, Math.round(num(reorder)));
  const dirty = stockN !== num(p.stock) || reorderN !== num(p.reorderAt);
  const frozen = readOnly || anyBusy;
  const inactive = p.active === false;

  return (
    <tr
      style={inactive ? { opacity: 0.55 } : undefined}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = C.panel2; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <td style={tdStyle}>
        <div
          style={{
            fontWeight: 700,
            maxWidth: 260,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={productTitle(p)}
        >
          {productTitle(p)}
        </div>
        <div style={{ fontSize: 11, color: C.muted }}>
          {[p.sku, p.category].filter(Boolean).join(' · ') || '—'}
        </div>
      </td>
      <td style={{ ...tdStyle, whiteSpace: 'nowrap', fontWeight: 600 }}>
        {fmtDZD(num(p.price), currency)}
      </td>
      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <button
            style={stepBtnStyle(frozen)}
            disabled={frozen}
            aria-label="Diminuer le stock"
            onClick={() => setStock(s => String(Math.max(0, num(s) - 1)))}
          >
            −
          </button>
          <input
            type="number"
            min={0}
            step={1}
            value={stock}
            disabled={frozen}
            onChange={e => setStock(e.target.value)}
            style={numInputStyle}
            aria-label={`Stock de ${productTitle(p)}`}
          />
          <button
            style={stepBtnStyle(frozen)}
            disabled={frozen}
            aria-label="Augmenter le stock"
            onClick={() => setStock(s => String(num(s) + 1))}
          >
            +
          </button>
        </div>
      </td>
      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
        <input
          type="number"
          min={0}
          step={1}
          value={reorder}
          disabled={frozen}
          onChange={e => setReorder(e.target.value)}
          style={numInputStyle}
          aria-label={`Seuil de réappro de ${productTitle(p)}`}
        />
      </td>
      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
        {inactive ? (
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
              background: 'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 14%, transparent)',
              border: `1px solid color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 30%, transparent)`,
            }}
          >
            Inactif
          </span>
        ) : isLowStock(p) ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              fontWeight: 700,
              padding: '3px 9px',
              borderRadius: 999,
              color: '#e8a33d',
              background: 'color-mix(in srgb, #e8a33d 14%, transparent)',
              border: '1px solid color-mix(in srgb, #e8a33d 35%, transparent)',
            }}
          >
            ⚠ Bas
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
              color: 'var(--affine-success-color, #4cae4c)',
              background: 'color-mix(in srgb, var(--affine-success-color, #4cae4c) 14%, transparent)',
              border: '1px solid color-mix(in srgb, var(--affine-success-color, #4cae4c) 30%, transparent)',
            }}
          >
            ✓ OK
          </span>
        )}
      </td>
      <td style={{ ...tdStyle, whiteSpace: 'nowrap', textAlign: 'right' }}>
        {busy ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: C.muted,
              fontSize: 11.5,
            }}
          >
            <Spinner /> Enregistrement…
          </span>
        ) : (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              justifyContent: 'flex-end',
            }}
          >
            {!readOnly ? (
              <button
                style={miniBtnStyle('secondary', anyBusy)}
                disabled={anyBusy}
                title="Générer une description produit avec l’IA"
                onClick={onDescribe}
              >
                ✨ Décrire
              </button>
            ) : null}
            {dirty && !readOnly ? (
              <button
                style={miniBtnStyle('primary', anyBusy)}
                disabled={anyBusy}
                onClick={() => void onSave(p, stockN, reorderN)}
              >
                Enregistrer
              </button>
            ) : null}
          </div>
        )}
      </td>
    </tr>
  );
};

// ---------------------------------------------------------------------------
// Add-product form (title / price / initial stock / reorder threshold).
// ---------------------------------------------------------------------------

const AddProductForm = ({
  currency,
  busy,
  onCancel,
  onSubmit,
}: {
  currency: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: {
    title: string;
    price: number;
    stock: number;
    reorderAt: number;
  }) => Promise<boolean>;
}) => {
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('10');
  const [reorder, setReorder] = useState('3');
  const [titleErr, setTitleErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const name = title.trim().slice(0, 120);
    if (!name) {
      setTitleErr('Entrez un nom de produit.');
      return;
    }
    setTitleErr(null);
    await onSubmit({
      title: name,
      price: Math.max(0, Math.round(num(price))),
      stock: Math.max(0, Math.round(num(stock))),
      reorderAt: Math.max(0, Math.round(num(reorder))),
    });
  }, [title, price, stock, reorder, onSubmit]);

  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
        Nouveau produit
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 10,
        }}
      >
        <Field label="Titre" error={titleErr}>
          <input
            style={inputStyle}
            value={title}
            maxLength={120}
            placeholder="Ex : Casque Bluetooth"
            onChange={e => setTitle(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label={`Prix (${currency})`}>
          <input
            type="number"
            min={0}
            step={1}
            style={inputStyle}
            value={price}
            placeholder="2500"
            onChange={e => setPrice(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="Stock initial">
          <input
            type="number"
            min={0}
            step={1}
            style={inputStyle}
            value={stock}
            onChange={e => setStock(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="Seuil réappro" hint="Seuil d’alerte de stock bas.">
          <input
            type="number"
            min={0}
            step={1}
            style={inputStyle}
            value={reorder}
            onChange={e => setReorder(e.target.value)}
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
            'Ajouter le produit'
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
// Describe modal (C5) — generates a grounded AI description for one product and
// previews it (description + bullets) before the owner applies it. On open it
// POSTs /erp/describe {productKey, tone?, lang?}; the owner can pick a tone /
// language and Regenerate. Apply writes the product via the EXISTING erp/product
// route (postErpProduct, in the parent). Degrades gracefully:
//   • 502 (planner down) → a soft, retryable error message.
//   • admin_writes_unavailable → bubbles to onWritesBlocked (read-only).
// The current description is shown for comparison; nothing is written until Apply.
// ---------------------------------------------------------------------------

const TONES: Array<{ id: string; label: string }> = [
  { id: 'friendly', label: 'Amical' },
  { id: 'professional', label: 'Professionnel' },
  { id: 'punchy', label: 'Percutant' },
  { id: 'luxury', label: 'Luxe' },
];

const LANGS: Array<{ id: string; label: string }> = [
  { id: 'fr', label: 'Français' },
  { id: 'ar', label: 'العربية' },
  { id: 'en', label: 'English' },
];

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

const selectStyle: CSSProperties = {
  ...inputStyle,
  padding: '7px 9px',
  fontSize: 12.5,
  cursor: 'pointer',
};

const DescribeModal = ({
  slug,
  product,
  applying,
  onClose,
  onApply,
  onWritesBlocked,
}: {
  slug: string;
  product: ErpProduct;
  applying: boolean;
  onClose: () => void;
  onApply: (product: ErpProduct, result: DescribeResult) => Promise<boolean>;
  onWritesBlocked: () => void;
}) => {
  const [tone, setTone] = useState('friendly');
  const [lang, setLang] = useState('fr');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [result, setResult] = useState<DescribeResult | null>(null);

  const key = String(product.sku || product.title || product.name || product.id || '');

  const generate = useCallback(async () => {
    setPhase('loading');
    setErrMsg('');
    const out = await postErpDescribe(slug, {
      productKey: key,
      tone,
      lang,
    });
    if (out.status === 'ok') {
      setResult(out.result);
      setPhase('ready');
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
      onClose();
    } else {
      setErrMsg(out.message);
      setPhase('error');
    }
  }, [slug, key, tone, lang, onWritesBlocked, onClose]);

  // Generate once on open. Regenerate is manual (button) so tone/lang changes
  // are intentional, not a fetch per keystroke.
  useEffect(() => {
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = phase === 'loading' || applying;

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label="Générer la description du produit"
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
          <span aria-hidden>✨</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>
              Description IA
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
              {product.category ? ` · ${product.category}` : ''}
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
          {/* Tone + language controls */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
            }}
          >
            <Field label="Ton">
              <select
                style={selectStyle}
                value={tone}
                disabled={busy}
                onChange={e => setTone(e.target.value)}
              >
                {TONES.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Langue">
              <select
                style={selectStyle}
                value={lang}
                disabled={busy}
                onChange={e => setLang(e.target.value)}
              >
                {LANGS.map(l => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div style={hintStyle}>
            Basé uniquement sur le titre, la catégorie et le prix de ce produit — aucun fait inventé.
          </div>

          {/* Preview / states */}
          {phase === 'loading' ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '20px 4px',
                color: C.muted,
              }}
            >
              <Spinner /> Génération de la description…
            </div>
          ) : phase === 'error' ? (
            <Banner tone="error">
              {errMsg}{' '}
              <button style={linkBtnStyle} onClick={() => void generate()}>
                Réessayer
              </button>
            </Banner>
          ) : result ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ ...hintStyle, marginBottom: 4 }}>Aperçu</div>
                <div
                  style={{
                    whiteSpace: 'pre-wrap',
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: C.text,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: C.bg,
                    border: `1px solid ${C.border}`,
                  }}
                >
                  {result.description}
                </div>
              </div>
              {result.bullets && result.bullets.length > 0 ? (
                <div>
                  <div style={{ ...hintStyle, marginBottom: 4 }}>
                    Points clés
                  </div>
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: 20,
                      fontSize: 12.5,
                      lineHeight: 1.6,
                      color: C.text,
                    }}
                  >
                    {result.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* Current description, for comparison */}
              {product.description && product.description.trim() ? (
                <details>
                  <summary
                    style={{
                      cursor: 'pointer',
                      fontSize: 12,
                      color: C.muted,
                      userSelect: 'none',
                    }}
                  >
                    Description actuelle
                  </summary>
                  <div
                    style={{
                      whiteSpace: 'pre-wrap',
                      fontSize: 12.5,
                      lineHeight: 1.6,
                      color: C.muted,
                      marginTop: 6,
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: `1px dashed ${C.border}`,
                    }}
                  >
                    {product.description}
                  </div>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            gap: 10,
            padding: '12px 16px',
            borderTop: `1px solid ${C.border}`,
            flexWrap: 'wrap',
          }}
        >
          <button
            style={btnStyle('primary', busy || !result)}
            disabled={busy || !result}
            onClick={() => {
              if (result) void onApply(product, result);
            }}
          >
            {applying ? (
              <>
                <Spinner dark /> Application…
              </>
            ) : (
              'Appliquer au produit'
            )}
          </button>
          <button
            style={btnStyle('secondary', busy)}
            disabled={busy}
            onClick={() => void generate()}
            title="Générer une nouvelle variante"
          >
            ↻ Régénérer
          </button>
          <button
            style={{ ...btnStyle('secondary', applying), marginLeft: 'auto' }}
            disabled={applying}
            onClick={onClose}
          >
            Annuler
          </button>
        </div>
      </div>
    </div>
  );
};
