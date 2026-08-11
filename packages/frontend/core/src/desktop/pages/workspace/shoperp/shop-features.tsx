import { type CSSProperties, useCallback, useMemo, useState } from 'react';

import {
  ERP_FEATURES,
  type FeatureDef,
  parseFeatures,
  SHOP_FEATURES,
} from '@affine/core/clickdz/features';

import {
  Banner,
  btnStyle,
  C,
  customizeApp,
  type CustomizeOutcome,
  type ErpSettings,
  Field,
  hintStyle,
  inputStyle,
  labelStyle,
  type RepublishOutcome,
  republishShop,
  Spinner,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// Shop / ERP "Fonctionnalités" tab (WSF-7). A self-serve feature catalog that
// is the *manual* half of the one customization path AI chat also converges on
// (POST /api/v1/apps/:slug/customize — see customizeApp in shoperp-shared).
// Appearance = look; Fonctionnalités = capabilities. Its sibling
// shop-appearance.tsx is the structural blueprint: same draft/dirty tracking,
// same "save → then re-publish to apply live" affordance, same read-only-safe
// behaviour, same inline-style palette, no i18n, no .css.ts.
//
// The feature catalog is the SINGLE source of truth (clickdz/features.ts /
// WSF-1). We NEVER hardcode ids or labels here — cards are rendered from
// SHOP_FEATURES / ERP_FEATURES filtered by `scope`. Storage stays IDs +
// scalars only: enablement is a CSV `settings.features` (same shape as
// `sections`), and each feature's small config params ride dedicated singleton
// keys named by its `settingsKeys`. Both go up in ONE /customize call.
//
// Gate: if the registry has no features for this scope, OR the /customize
// endpoint 404s (the CDZ_FEATURES_ENABLED flag is off on this server), the tab
// renders a quiet "bientôt disponible" state — it never crashes. Cards are
// disabled (with a clear hint) until the shop is published, since features only
// take effect on the live storefront.
// ---------------------------------------------------------------------------

/** French labels for the registry categories (display + grouping order). */
const CATEGORY_LABELS: Record<string, { label: string; sub: string; icon: string }> = {
  sell: { label: 'Vente', sub: 'kter el bi3', icon: '🛒' },
  engage: { label: 'Engagement', sub: 'rbet el client', icon: '💬' },
  logistics: { label: 'Logistique', sub: 'livraison w tetbi3', icon: '🚚' },
  content: { label: 'Contenu', sub: 'sections w affichage', icon: '📰' },
  i18n: { label: 'Langue', sub: 'darja w français', icon: '🌐' },
  erp_module: { label: 'Modules ERP', sub: 'zid des outils', icon: '🔧' },
};

/** Stable category display order; unknown categories fall to the end. */
const CATEGORY_ORDER = [
  'sell',
  'engage',
  'logistics',
  'content',
  'i18n',
  'erp_module',
];

// ---------------------------------------------------------------------------
// Param-schema reader. WSF-1 (Anvil) owns the exact `paramSchema` type; we read
// it DEFENSIVELY so whatever concrete scalar-descriptor shape ships, this form
// degrades gracefully (unknown/oversized shapes are skipped, never thrown on).
// We support the two common lite shapes: a `fields: [...]` array, or a
// `properties: { key: {...} }` map. Each descriptor may carry:
//   key/name (string)  · type ('text'|'number'|'boolean'|'select'|'string')
//   label/title · hint/description · placeholder · options (string[] | {value,label}[])
// Only recognisable SCALAR fields render; anything else is ignored silently.
// ---------------------------------------------------------------------------

interface ParamField {
  key: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  label: string;
  hint?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

function normType(raw: unknown): ParamField['type'] {
  const t = String(raw ?? '').toLowerCase();
  if (t === 'number' || t === 'integer' || t === 'int') return 'number';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (t === 'select' || t === 'enum' || t === 'options') return 'select';
  return 'text';
}

function normOptions(raw: unknown): ParamField['options'] {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .map(o => {
      if (o == null) return null;
      if (typeof o === 'string' || typeof o === 'number') {
        return { value: String(o), label: String(o) };
      }
      if (typeof o === 'object') {
        const rec = o as Record<string, unknown>;
        const value = rec.value ?? rec.id ?? rec.key;
        if (value == null) return null;
        return {
          value: String(value),
          label: String(rec.label ?? rec.title ?? value),
        };
      }
      return null;
    })
    .filter((x): x is { value: string; label: string } => !!x);
  return out.length ? out : undefined;
}

/** Coerce one raw descriptor into a ParamField, or null if it's not scalar. */
function toParamField(rawKey: string, raw: unknown): ParamField | null {
  const rec =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const key = String(rec.key ?? rec.name ?? rawKey ?? '').trim();
  if (!key) return null;
  const options = normOptions(rec.options ?? rec.enum);
  const type = options ? 'select' : normType(rec.type);
  const label = String(rec.label ?? rec.title ?? key);
  const field: ParamField = { key, type, label };
  const hint = rec.hint ?? rec.description;
  if (hint != null && String(hint)) field.hint = String(hint);
  const ph = rec.placeholder ?? rec.example;
  if (ph != null && String(ph)) field.placeholder = String(ph);
  if (options) field.options = options;
  return field;
}

/** Read a feature's paramSchema into a flat, render-safe field list. */
function readParamFields(feature: FeatureDef): ParamField[] {
  const schema = (feature as { paramSchema?: unknown }).paramSchema;
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as Record<string, unknown>;
  const fields: ParamField[] = [];
  // Shape A: { fields: [ {key,...}, ... ] }
  if (Array.isArray(s.fields)) {
    for (const f of s.fields) {
      const pf = toParamField(
        String((f as Record<string, unknown>)?.key ?? ''),
        f
      );
      if (pf) fields.push(pf);
    }
  }
  // Shape B: JSON-schema-lite { properties: { key: {...} } }
  else if (s.properties && typeof s.properties === 'object') {
    for (const [k, v] of Object.entries(
      s.properties as Record<string, unknown>
    )) {
      const pf = toParamField(k, v);
      if (pf) fields.push(pf);
    }
  }
  // Cap the rendered form so an unexpectedly huge schema can't wedge the UI.
  return fields.slice(0, 24);
}

// ---------------------------------------------------------------------------
// Public component. Rendered by dashboard.tsx for the 'features' section,
// mirroring the ShopAppearance props exactly.
// ---------------------------------------------------------------------------

export const ShopFeatures = ({
  slug,
  settings,
  url,
  storeSlug,
  readOnly,
  scope = 'shop',
  onWritesBlocked,
  onMutated,
}: {
  /** The store's slug — its data-API namespace + publish slug. */
  slug: string;
  /** The live settings singleton (from the ERP summary). */
  settings: ErpSettings;
  /** Live storefront URL, when known — its presence = the shop is published. */
  url?: string;
  /** Pairing key, forwarded to re-publish so the record stays paired. */
  storeSlug?: string;
  readOnly: boolean;
  /** Which catalog to show. Shop features by default; 'erp' for ERP modules. */
  scope?: 'shop' | 'erp';
  onWritesBlocked: () => void;
  onMutated: () => void;
}) => {
  // The catalog for this scope. Defensive: if the mirror is empty/absent we get
  // [] and fall through to the quiet "bientôt disponible" gate below.
  const catalog = useMemo<FeatureDef[]>(() => {
    const list = scope === 'erp' ? ERP_FEATURES : SHOP_FEATURES;
    return Array.isArray(list)
      ? list.filter(f => f && (f.scope === scope || scope === 'shop'))
      : [];
  }, [scope]);

  // ---- Draft state ---------------------------------------------------------
  // Enabled feature ids, seeded from the stored CSV. parseFeatures applies the
  // registry defaults (defaultOn) for a legacy singleton that predates features.
  const [enabled, setEnabled] = useState<string[]>(() =>
    normalizeEnabled(parseFeatures(settings.features, scope), catalog)
  );
  // Per-feature scalar params, seeded from the singleton keys each feature owns.
  const [params, setParams] = useState<Record<string, string>>(() =>
    seedParams(catalog, settings)
  );
  // Which cards are expanded (config visible). Non-persistent UI state.
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false); // a save landed → offer re-publish
  const [endpointMissing, setEndpointMissing] = useState(false); // 404 = flag off
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error' | 'info';
    text: string;
  } | null>(null);

  // Re-publish (post-save) state — mirrors shop-appearance's outcomes.
  const [republishing, setRepublishing] = useState(false);
  const [republished, setRepublished] = useState<string | null>(null);

  const published = !!url;
  const disabled = readOnly || saving || !published;

  // ---- Dirty tracking ------------------------------------------------------
  const storedEnabled = useMemo(
    () => normalizeEnabled(parseFeatures(settings.features, scope), catalog),
    [settings.features, scope, catalog]
  );
  const storedParams = useMemo(
    () => seedParams(catalog, settings),
    [catalog, settings]
  );

  const enabledDirty = !sameSet(enabled, storedEnabled);
  const paramsDirty = useMemo(() => {
    const keys = new Set([...Object.keys(params), ...Object.keys(storedParams)]);
    for (const k of keys) {
      if ((params[k] ?? '') !== (storedParams[k] ?? '')) return true;
    }
    return false;
  }, [params, storedParams]);
  const dirty = enabledDirty || paramsDirty;

  const isOn = useCallback((id: string) => enabled.includes(id), [enabled]);

  const toggle = useCallback(
    (feature: FeatureDef) => {
      if (disabled) return;
      setNotice(null);
      setEnabled(cur => {
        const on = cur.includes(feature.id);
        if (on) {
          // Turning off: also drop anything that depends on this feature.
          const dropped = new Set<string>([feature.id]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const f of catalog) {
              if (dropped.has(f.id)) continue;
              const deps = Array.isArray(f.deps) ? f.deps : [];
              if (deps.some(d => dropped.has(d)) && cur.includes(f.id)) {
                dropped.add(f.id);
                changed = true;
              }
            }
          }
          return cur.filter(id => !dropped.has(id));
        }
        // Turning on: pull in deps, drop declared conflicts.
        const next = new Set(cur);
        next.add(feature.id);
        for (const d of Array.isArray(feature.deps) ? feature.deps : []) {
          if (catalog.some(f => f.id === d)) next.add(d);
        }
        for (const c of Array.isArray(feature.conflicts)
          ? feature.conflicts
          : []) {
          next.delete(c);
        }
        // Auto-expand config on enable if the feature has params to fill.
        if (readParamFields(feature).length) {
          setOpen(o => ({ ...o, [feature.id]: true }));
        }
        return [...next];
      });
    },
    [disabled, catalog]
  );

  const setParam = useCallback((key: string, value: string) => {
    setParams(cur => ({ ...cur, [key]: value }));
  }, []);

  const resetDraft = useCallback(() => {
    setEnabled(storedEnabled);
    setParams(storedParams);
    setNotice(null);
  }, [storedEnabled, storedParams]);

  // ---- Save: build a {features, params} diff → POST /customize -------------
  const save = useCallback(async () => {
    if (disabled) return;
    setNotice(null);

    // Only send params for features that are enabled in the draft (a disabled
    // feature's stale config never rides along — keeps the singleton tiny).
    const enabledParamKeys = new Set<string>();
    for (const f of catalog) {
      if (!enabled.includes(f.id)) continue;
      for (const k of Array.isArray(f.settingsKeys) ? f.settingsKeys : []) {
        enabledParamKeys.add(k);
      }
    }
    const paramsBody: Record<string, string | number | boolean> = {};
    for (const k of enabledParamKeys) {
      const v = params[k];
      if (v == null || v === '') continue;
      // Preserve pure numbers / booleans as scalars; everything else is a string
      // (the backend allowlist re-validates against each feature's schema).
      if (v === 'true' || v === 'false') paramsBody[k] = v === 'true';
      else if (/^-?\d+(\.\d+)?$/.test(v)) paramsBody[k] = Number(v);
      else paramsBody[k] = v;
    }

    setSaving(true);
    const out: CustomizeOutcome = await customizeApp(slug, {
      features: enabled,
      ...(Object.keys(paramsBody).length ? { params: paramsBody } : {}),
    });
    if (out.status === 'ok') {
      setSaved(true);
      setRepublished(null);
      setNotice({
        tone: 'ok',
        text: out.remint
          ? 'Fonctionnalités enregistrées. Une nouvelle version de la boutique est en cours de publication.'
          : 'Fonctionnalités enregistrées. Re-publiez pour les appliquer à la boutique en ligne.',
      });
      onMutated(); // refresh the summary so stored settings stay in sync
    } else if (out.status === 'unavailable') {
      onWritesBlocked();
    } else if (out.status === 'not-found') {
      // The /customize route isn't on this server (flag off) → quiet-gate it.
      setEndpointMissing(true);
    } else if (out.status === 'cap') {
      setNotice({
        tone: 'error',
        text: 'Vous avez atteint la limite de publication — libérez un emplacement depuis Gérer, puis réessayez.',
      });
    } else if (out.status === 'upgrade') {
      setNotice({
        tone: 'error',
        text: 'Cette action nécessite un plan Pro sur cet espace.',
      });
    } else {
      // A rejected id / param surfaces here (server allowlist mismatch).
      setNotice({ tone: 'error', text: out.message });
    }
    setSaving(false);
  }, [
    disabled,
    catalog,
    enabled,
    params,
    slug,
    onMutated,
    onWritesBlocked,
  ]);

  const doRepublish = useCallback(async () => {
    if (republishing) return;
    setRepublishing(true);
    setNotice(null);
    const out: RepublishOutcome = await republishShop({
      slug,
      ...(storeSlug ? { storeSlug } : {}),
      kind: scope === 'erp' ? 'erp' : 'shop',
    });
    if (out.status === 'ok') {
      setRepublished(out.url || url || '');
      setSaved(false);
      setNotice({
        tone: 'ok',
        text: 'Re-publié — la boutique en ligne reflète maintenant vos fonctionnalités.',
      });
    } else if (out.status === 'no-source') {
      setNotice({
        tone: 'info',
        text: 'Enregistré. Pour l’appliquer en ligne, ouvrez la boutique dans votre Studio et re-publiez (sa source n’est pas en cache ici).',
      });
    } else if (out.status === 'cap') {
      setNotice({
        tone: 'error',
        text: 'Vous avez atteint la limite de publication — libérez un emplacement depuis Gérer, puis re-publiez.',
      });
    } else if (out.status === 'upgrade') {
      setNotice({
        tone: 'error',
        text: 'La re-publication nécessite un plan Pro sur cet espace.',
      });
    } else {
      setNotice({ tone: 'error', text: out.message });
    }
    setRepublishing(false);
  }, [republishing, slug, storeSlug, url, scope]);

  // ---- Group the catalog by category, in the canonical display order -------
  // (Computed BEFORE any early return so the hook order stays stable.)
  const groups = useMemo(() => {
    const byCat = new Map<string, FeatureDef[]>();
    for (const f of catalog) {
      const cat = String(f.category || 'sell');
      const arr = byCat.get(cat) ?? [];
      arr.push(f);
      byCat.set(cat, arr);
    }
    const orderedCats = [
      ...CATEGORY_ORDER.filter(c => byCat.has(c)),
      ...[...byCat.keys()].filter(c => !CATEGORY_ORDER.includes(c)),
    ];
    return orderedCats.map(cat => ({
      cat,
      meta: CATEGORY_LABELS[cat] ?? { label: cat, sub: '', icon: '📦' },
      features: byCat.get(cat) ?? [],
    }));
  }, [catalog]);

  // ---- Quiet gate: no features for this scope, or the endpoint is off ------
  if (catalog.length === 0 || endpointMissing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
            padding: '44px 20px',
            textAlign: 'center',
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 16,
            boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
          }}
        >
          <span aria-hidden style={{ width: 56, height: 56, borderRadius: 16, display: 'grid', placeItems: 'center', fontSize: 26, background: 'linear-gradient(135deg, var(--affine-primary-color, #1e96eb), color-mix(in srgb, var(--affine-primary-color, #1e96eb) 70%, #000))', border: `1px solid ${C.border}` }}>
            🧩
          </span>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>
            Fonctionnalités — bientôt disponible
          </div>
          <div
            style={{
              ...hintStyle,
              maxWidth: 380,
            }}
          >
            Bientôt, vous pourrez activer des fonctionnalités (liste de souhaits,
            avis, codes promo, frais par wilaya, suivi de commande…) directement
            ici, sans quitter votre studio. Cette section s’activera dès qu’elle
            sera prête sur votre boutique.
          </div>
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...btnStyle('secondary'), textDecoration: 'none' }}
            >
              Voir la boutique ↗
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  const enabledCount = enabled.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Applied-live hint + view-shop link (always visible when published). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          padding: '10px 14px',
          borderRadius: 12,
          background: C.accentSoft,
          border: `1px solid ${C.border}`,
          fontSize: 12.5,
          color: C.text,
        }}
      >
        <span aria-hidden style={{ width: 28, height: 28, borderRadius: 9, display: 'grid', placeItems: 'center', fontSize: 14, flexShrink: 0, background: 'linear-gradient(135deg, var(--affine-primary-color, #1e96eb), color-mix(in srgb, var(--affine-primary-color, #1e96eb) 70%, #000))' }}>
          ⚡
        </span>
        <span style={{ flex: 1, minWidth: 180 }}>
          Les fonctionnalités s’appliquent en direct après enregistrement +
          re-publication — pas besoin de recréer la boutique.
        </span>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: C.accent,
              fontWeight: 700,
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            Voir la boutique ↗
          </a>
        ) : null}
      </div>

      {notice ? (
        <Banner
          tone={
            notice.tone === 'ok'
              ? 'ok'
              : notice.tone === 'info'
                ? 'info'
                : 'error'
          }
        >
          {notice.text}
          {saved && notice.tone === 'ok' && !republishing ? (
            <>
              {' '}
              <button style={miniLinkStyle} onClick={() => void doRepublish()}>
                Re-publier maintenant
              </button>
            </>
          ) : null}
          {republished ? (
            <>
              {' · '}
              <a
                href={republished}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: C.accent }}
              >
                Ouvrir en ligne ↗
              </a>
            </>
          ) : null}
        </Banner>
      ) : null}

      {!published ? (
        <Banner tone="warn">
          Publiez d’abord votre boutique — les fonctionnalités ne s’appliquent
          qu’à une boutique <strong>en ligne</strong>. Vous pouvez les parcourir
          ci-dessous ; les activer sera possible après la publication.
        </Banner>
      ) : readOnly ? (
        <Banner tone="warn">
          Les modifications sont indisponibles sur ce serveur pour le moment —
          cet éditeur est en <strong>lecture seule</strong>.
        </Banner>
      ) : null}

      {/* Category groups of feature cards. */}
      {groups.map(group => (
        <div
          key={group.cat}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '4px 2px',
            }}
          >
            <span aria-hidden style={{ width: 36, height: 36, borderRadius: 11, display: 'grid', placeItems: 'center', fontSize: 16, flexShrink: 0, background: 'linear-gradient(135deg, var(--affine-primary-color, #1e96eb), color-mix(in srgb, var(--affine-primary-color, #1e96eb) 70%, #000))', border: `1px solid ${C.border}` }}>
              {group.meta.icon}
            </span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <span style={labelStyle}>{group.meta.label}</span>
              {group.meta.sub ? (
                <span style={{ fontSize: 11, color: C.muted }}>
                  · {group.meta.sub}
                </span>
              ) : null}
            </div>
          </div>
          {/* Single-column on mobile; two-up on wide via auto-fit grid. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 10,
              alignItems: 'start',
            }}
          >
            {group.features.map(feature => (
              <FeatureCard
                key={feature.id}
                feature={feature}
                on={isOn(feature.id)}
                open={!!open[feature.id]}
                disabled={disabled}
                params={params}
                onToggle={() => toggle(feature)}
                onToggleOpen={() =>
                  setOpen(o => ({ ...o, [feature.id]: !o[feature.id] }))
                }
                onParam={setParam}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Sticky save bar. */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          padding: '10px 0 2px',
          background: `linear-gradient(to top, ${C.bg} 60%, transparent)`,
        }}
      >
        <button
          style={btnStyle('primary', disabled || !dirty)}
          disabled={disabled || !dirty}
          onClick={() => void save()}
        >
          {saving ? (
            <>
              <Spinner dark /> Enregistrement…
            </>
          ) : (
            'Enregistrer'
          )}
        </button>
        {dirty && !saving ? (
          <button style={btnStyle('secondary')} onClick={resetDraft}>
            Annuler
          </button>
        ) : null}
        {saved && !dirty ? (
          <button
            style={btnStyle('secondary', republishing)}
            disabled={republishing}
            onClick={() => void doRepublish()}
          >
            {republishing ? (
              <>
                <Spinner /> Re-publication…
              </>
            ) : (
              '🚀 Re-publier la boutique'
            )}
          </button>
        ) : null}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: C.muted, whiteSpace: 'nowrap' }}>
          {enabledCount}{' '}
          {enabledCount === 1 ? 'activée' : 'activées'}
        </span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// One feature card: name (FR) + darja subtitle, a toggle, and an expandable
// config form for its scalar params. Presentational; all state lifted up.
// ---------------------------------------------------------------------------

const FeatureCard = ({
  feature,
  on,
  open,
  disabled,
  params,
  onToggle,
  onToggleOpen,
  onParam,
}: {
  feature: FeatureDef;
  on: boolean;
  open: boolean;
  disabled: boolean;
  params: Record<string, string>;
  onToggle: () => void;
  onToggleOpen: () => void;
  onParam: (key: string, value: string) => void;
}) => {
  const fields = useMemo(() => readParamFields(feature), [feature]);
  const nameFr = String(feature.nameFr || feature.id);
  const nameAr = String(feature.nameAr || '');
  const hasConfig = fields.length > 0;

  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${on ? C.accent : C.border}`,
        borderRadius: 12,
        overflow: 'hidden',
        transition: 'border-color 160ms ease, box-shadow 200ms ease',
        minWidth: 0,
        boxShadow: '0 1px 3px rgba(0,0,0,0.10)',
      }}
    >
      {/* Card head: label block + toggle switch. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 800,
              color: C.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {nameFr}
          </div>
          {nameAr ? (
            <div
              style={{
                fontSize: 12,
                color: C.muted,
                marginTop: 1,
                direction: 'rtl',
                textAlign: 'right',
                unicodeBidi: 'plaintext',
              }}
            >
              {nameAr}
            </div>
          ) : null}
        </div>
        <Toggle on={on} disabled={disabled} onClick={onToggle} label={nameFr} />
      </div>

      {/* Config affordance: only when the feature is ON and has scalar params. */}
      {hasConfig && on ? (
        <div style={{ borderTop: `1px solid ${C.border}` }}>
          <button
            type="button"
            onClick={onToggleOpen}
            style={{
              appearance: 'none',
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '9px 14px',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: C.muted,
              fontSize: 12,
              fontWeight: 700,
              textAlign: 'left',
            }}
          >
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                transform: open ? 'rotate(90deg)' : 'none',
                transition: 'transform 160ms ease',
              }}
            >
              ▸
            </span>
            Configurer
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11 }}>
              {fields.length} {fields.length === 1 ? 'champ' : 'champs'}
            </span>
          </button>
          {open ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                padding: '4px 14px 14px',
              }}
            >
              {fields.map(f => (
                <ParamInput
                  key={f.key}
                  field={f}
                  value={params[f.key] ?? ''}
                  disabled={disabled}
                  onChange={v => onParam(f.key, v)}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

// A single scalar-param control, dispatched by field type. Everything routes
// through the shared inputStyle / Field primitives so it reads like a sibling.
const ParamInput = ({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ParamField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) => {
  if (field.type === 'boolean') {
    return (
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <input
          type="checkbox"
          checked={value === 'true'}
          disabled={disabled}
          onChange={e => onChange(e.target.checked ? 'true' : 'false')}
          style={{ width: 16, height: 16, accentColor: C.accent }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
            {field.label}
          </span>
          {field.hint ? (
            <span style={{ display: 'block', fontSize: 11.5, color: C.muted }}>
              {field.hint}
            </span>
          ) : null}
        </span>
      </label>
    );
  }

  if (field.type === 'select' && field.options) {
    return (
      <Field label={field.label} hint={field.hint}>
        <select
          value={value}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
          style={{ ...inputStyle, cursor: disabled ? 'default' : 'pointer' }}
        >
          <option value="">—</option>
          {field.options.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  // text | number
  return (
    <Field label={field.label} hint={field.hint}>
      <input
        style={inputStyle}
        type={field.type === 'number' ? 'number' : 'text'}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        value={value}
        placeholder={field.placeholder}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      />
    </Field>
  );
};

// Accessible on/off switch (inline styled, no deps) — the card's primary action.
const Toggle = ({
  on,
  disabled,
  onClick,
  label,
}: {
  on: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
    style={{
      appearance: 'none',
      position: 'relative',
      flexShrink: 0,
      width: 42,
      height: 24,
      borderRadius: 999,
      border: `1px solid ${on ? C.accent : C.border}`,
      background: on ? C.accent : 'transparent',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      transition: 'background 160ms ease, border-color 160ms ease',
      padding: 0,
    }}
  >
    <span
      aria-hidden
      style={{
        position: 'absolute',
        top: 2,
        // `transform`, not `left`: animating `left` re-runs layout on every
        // frame, which stutters on the mid-range Android phones merchants use.
        // `translateX` stays on the compositor and looks identical.
        left: 2,
        transform: on ? 'translateX(18px)' : 'translateX(0)',
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: on ? '#fff' : C.muted,
        transition:
          'transform 160ms cubic-bezier(0.2, 0, 0, 1), background 160ms ease',
      }}
    />
  </button>
);

const miniLinkStyle: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontWeight: 700,
  cursor: 'pointer',
  color: C.accent,
  textDecoration: 'underline',
};

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

/** Keep only ids that still exist in the catalog (drop stale/unknown ids). */
function normalizeEnabled(ids: string[], catalog: FeatureDef[]): string[] {
  const known = new Set(catalog.map(f => f.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Seed the draft params from the singleton keys each feature declares. */
function seedParams(
  catalog: FeatureDef[],
  settings: ErpSettings
): Record<string, string> {
  const out: Record<string, string> = {};
  const bag = settings as unknown as Record<string, unknown>;
  for (const f of catalog) {
    for (const k of Array.isArray(f.settingsKeys) ? f.settingsKeys : []) {
      const v = bag[k];
      if (v == null) continue;
      out[k] = typeof v === 'boolean' ? String(v) : String(v);
    }
  }
  return out;
}

/** Order-independent set equality for the enabled-ids draft comparison. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}
