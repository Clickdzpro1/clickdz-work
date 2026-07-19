import {
  type CSSProperties,
  useCallback,
  useEffect,
  useState,
} from 'react';

import {
  Banner,
  btnStyle,
  C,
  EmptyNote,
  type ErpProduct,
  fetchErpCollection,
  Field,
  fmtDZD,
  inputStyle,
  isLowStock,
  linkBtnStyle,
  miniBtnStyle,
  num,
  Panel,
  postErpProduct,
  productTitle,
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
        `${productTitle(p)} saved — stock ${stock}, reorder at ${reorderAt}.`
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
        `${draft.title} added to the catalogue.`
      );
      setBusyKey(null);
      if (ok) setShowAdd(false);
      return ok;
    },
    [readOnly, busyKey, submitProduct]
  );

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
        <Spinner /> Loading products…
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <Banner tone="error">
        Couldn&apos;t load the products.{' '}
        <button style={linkBtnStyle} onClick={() => void load()}>
          Retry
        </button>
      </Banner>
    );
  }

  const lowCount = products.filter(isLowStock).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, fontSize: 12.5, color: C.muted }}>
          {products.length} {products.length === 1 ? 'product' : 'products'}
          {lowCount > 0 ? (
            <span style={{ color: '#e8a33d', fontWeight: 700 }}>
              {' '}
              · {lowCount} low on stock
            </span>
          ) : null}
        </div>
        {!showAdd ? (
          <button
            style={miniBtnStyle('primary', readOnly)}
            disabled={readOnly}
            onClick={() => setShowAdd(true)}
          >
            + Add product
          </button>
        ) : null}
      </div>

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
          <EmptyNote>
            No products yet — add your first product to start selling.
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
                  {['Product', 'Price', 'Stock', 'Reorder at', 'State', ''].map(
                    (h, i) => (
                      <th key={`${h}-${i}`} style={thStyle}>
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {products.map(p => (
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
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
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
}: {
  product: ErpProduct;
  currency: string;
  readOnly: boolean;
  busy: boolean;
  anyBusy: boolean;
  onSave: (p: ErpProduct, stock: number, reorderAt: number) => Promise<void>;
}) => {
  const [stock, setStock] = useState(String(num(p.stock)));
  const [reorder, setReorder] = useState(String(num(p.reorderAt)));

  const stockN = Math.max(0, Math.round(num(stock)));
  const reorderN = Math.max(0, Math.round(num(reorder)));
  const dirty = stockN !== num(p.stock) || reorderN !== num(p.reorderAt);
  const frozen = readOnly || anyBusy;
  const inactive = p.active === false;

  return (
    <tr style={inactive ? { opacity: 0.55 } : undefined}>
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
            aria-label="Decrease stock"
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
            aria-label={`Stock for ${productTitle(p)}`}
          />
          <button
            style={stepBtnStyle(frozen)}
            disabled={frozen}
            aria-label="Increase stock"
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
          aria-label={`Reorder threshold for ${productTitle(p)}`}
        />
      </td>
      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
        {inactive ? (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: C.muted }}>
            Inactive
          </span>
        ) : isLowStock(p) ? (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: '#e8a33d' }}>
            ⚠ Low
          </span>
        ) : (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: C.okText }}>
            OK
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
            <Spinner /> Saving…
          </span>
        ) : dirty && !readOnly ? (
          <button
            style={miniBtnStyle('primary', anyBusy)}
            disabled={anyBusy}
            onClick={() => void onSave(p, stockN, reorderN)}
          >
            Save
          </button>
        ) : null}
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
      setTitleErr('Enter a product title.');
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
        New product
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 10,
        }}
      >
        <Field label="Title" error={titleErr}>
          <input
            style={inputStyle}
            value={title}
            maxLength={120}
            placeholder="e.g. Casque Bluetooth"
            onChange={e => setTitle(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label={`Price (${currency})`}>
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
        <Field label="Initial stock">
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
        <Field label="Reorder at" hint="Low-stock alert threshold.">
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
              <Spinner dark /> Adding…
            </>
          ) : (
            'Add product'
          )}
        </button>
        <button
          style={btnStyle('secondary', busy)}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};
