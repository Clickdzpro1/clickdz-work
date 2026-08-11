import { PagedList } from '@affine/core/clickdz/paged-list';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Banner,
  btnStyle,
  C,
  fetchShopTemplates,
  hintStyle,
  type ShopTemplateMeta,
  Spinner,
} from './shoperp-shared';

// ---------------------------------------------------------------------------
// DzOS wizard — the "Modèles de business" step (WS4-5, reframed R9). A PURE
// ADDITIVE step: it fetches the vertical catalog from GET /api/v1/apps/templates
// and lets the user pick a starting BUSINESS template (accent + look + darja
// hero + seed pack, all resolved server-side at mint via templateId). When the
// catalog endpoint is absent/empty (flag CDZ_TEMPLATE_CATALOG OFF → 404, or an
// older server) the step is NEVER inserted into the wizard flow and the wizard
// behaves EXACTLY as today — byte-identical mint with no templateId.
//
// R9 reframe (Fateh: "they aren't shops, they are business"): the gallery is
// "Modèles de business". Header/catalog copy talks about a *type of business*
// (pharmacie, restaurant, cabinet, mode…), not a "boutique". The word
// "boutique" only survives inside an individual card seed where it means the
// storefront itself (e.g. the "Sans modèle" generic seed).
//
// Business-type tabs are DERIVED from the catalog data (each template's raw
// `vertical`), mapped DEFENSIVELY into seven fixed business buckets — Santé /
// Restauration & Café / Mode & Beauté / Commerce / Maison & Auto / Services /
// Autres. Anything we can't recognise falls into "Autres" so no template ever
// disappears. "Tous" shows everything. The grid is a PagedList (pageSize 8,
// grid mode) — no scroll container; the wizard card grows to fit one page.
//
// The "Sans modèle" card (templateId = null) is FIRST on page 1 of "Tous" and
// selected by default, so a user who clicks straight through gets today's
// generic shop unchanged.
//
// Flow control lives in `useShopTemplates()`: the wizard calls the hook, and
// only inserts the `template` step when the hook reports `ready` with ≥1
// template. All catalog fetching/parsing stays in this file + the shared
// wrapper; the wizard snippet is a thin consumer.
// ---------------------------------------------------------------------------

const ALL = 'Tous';
const OTHER = 'Autres';

// Fixed business-type buckets, in the order Fateh grouped them. "Tous" is the
// implicit first tab (prepended); "Autres" is the guaranteed catch-all so an
// unmapped vertical is never lost. Kept in this order for the tab row.
const BUCKET_ORDER = [
  'Santé',
  'Restauration & Café',
  'Mode & Beauté',
  'Commerce',
  'Maison & Auto',
  'Services',
  OTHER,
] as const;

type Bucket = (typeof BUCKET_ORDER)[number];

// Primary map: the catalog's stable template `id` → business bucket. Ids are the
// canonical TemplateDef ids (clickdz-shop-catalog.ts) and are the most reliable
// key. Any id not listed here falls through to the vertical-keyword pass, then
// to "Autres". This is the source of the category→vertical grouping in NOTES.
const ID_BUCKET: Record<string, Bucket> = {
  // Santé
  pharmacie: 'Santé',
  dentaire: 'Santé',
  // Restauration & Café
  'resto-fastfood': 'Restauration & Café',
  patisserie: 'Restauration & Café',
  cafe: 'Restauration & Café',
  // Mode & Beauté
  'mode-femme': 'Mode & Beauté',
  'mode-homme': 'Mode & Beauté',
  cosmetiques: 'Mode & Beauté',
  bijouterie: 'Mode & Beauté',
  // Commerce
  superette: 'Commerce',
  librairie: 'Commerce',
  electronique: 'Commerce',
  'accessoires-tel': 'Commerce',
  bebe: 'Commerce',
  sport: 'Commerce',
  // Maison & Auto
  'meubles-deco': 'Maison & Auto',
  'pieces-auto': 'Maison & Auto',
  droguerie: 'Maison & Auto',
  // Services
  'salon-booking': 'Services',
  // Tous/Autres — the generic polyvalent template lives in Autres.
  polyvalent: OTHER,
};

// Secondary pass for verticals we don't recognise by id (older/newer server,
// renamed ids). Keyword → bucket, first match wins. Deliberately forgiving; the
// final fallback is always "Autres" so nothing disappears.
const VERTICAL_RULES: Array<{ match: RegExp; bucket: Bucket }> = [
  { match: /pharma|sant[ée]|dentaire|m[ée]dic|parapharm/i, bucket: 'Santé' },
  {
    match: /resto|restaurant|food|fast|p[âa]tiss|bakery|boulanger|caf[ée]|traiteur/i,
    bucket: 'Restauration & Café',
  },
  {
    match: /mode|fashion|femme|homme|sneaker|cosm[ée]?tiq|beaut[ée]|bijou|parfum/i,
    bucket: 'Mode & Beauté',
  },
  {
    match:
      /superette|[ée]picerie|librairie|papeter|[ée]lectro|phone|t[ée]l[ée]?phone|informat|b[ée]b[ée]|pu[ée]ricult|sport|fitness|jouet/i,
    bucket: 'Commerce',
  },
  {
    match: /meuble|d[ée]co|maison|droguerie|quincaill|auto|pi[èe]ce|bricol/i,
    bucket: 'Maison & Auto',
  },
  { match: /salon|coiffure|service|booking|r[ée]serv|rendez/i, bucket: 'Services' },
];

/**
 * Map one template to its business bucket — DEFENSIVELY. Tries the stable id
 * first, then vertical keywords, then lands on "Autres". Never returns
 * undefined, so every template is always reachable from some tab.
 */
function bucketOf(t: ShopTemplateMeta): Bucket {
  const id = String(t.id || '').trim();
  if (id && ID_BUCKET[id]) return ID_BUCKET[id];
  const v = String(t.vertical || '').trim();
  if (v) {
    for (const { match, bucket } of VERTICAL_RULES) {
      if (match.test(v)) return bucket;
    }
  }
  return OTHER;
}

export type TemplatesState =
  | { kind: 'loading' }
  | { kind: 'ready'; templates: ShopTemplateMeta[] }
  | { kind: 'unavailable' };

/**
 * Fetch the business-template catalog ONCE. Returns a discriminated state the
 * wizard uses to decide whether to insert the picker step:
 *   - loading      → don't insert yet (welcome shows first, as today)
 *   - unavailable  → never insert (404/empty/error → exact pre-catalog flow)
 *   - ready        → insert the step and hand `templates` to <TemplatePicker/>
 * Never throws; a failure resolves to `unavailable`.
 */
export function useShopTemplates(): TemplatesState {
  const [state, setState] = useState<TemplatesState>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    void (async () => {
      const templates = await fetchShopTemplates();
      if (!alive) return;
      setState(
        templates.length > 0
          ? { kind: 'ready', templates }
          : { kind: 'unavailable' }
      );
    })();
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

// A picker row item: either the "Sans modèle" sentinel or a catalog template.
// PagedList paginates this flat array; the sentinel is prepended only on the
// "Tous" tab so it stays FIRST on page 1 (byte-identical default mint path).
type PickerItem =
  | { kind: 'none' }
  | { kind: 'tpl'; tpl: ShopTemplateMeta };

export const TemplatePicker = ({
  templates,
  selectedTemplateId,
  onSelect,
}: {
  // The resolved catalog (the wizard only renders this step when non-empty).
  templates: ShopTemplateMeta[];
  // The currently chosen templateId (null = "Sans modèle", today's default).
  selectedTemplateId: string | null;
  // Report the user's pick up to the wizard. null clears back to the default.
  onSelect: (templateId: string | null) => void;
}) => {
  const [category, setCategory] = useState<string>(ALL);

  // Business-type tabs: ALL first, then only the fixed buckets that actually
  // contain ≥1 template, in BUCKET_ORDER. "Autres" only appears when something
  // maps to it. Derived from the catalog data via bucketOf().
  const categories = useMemo(() => {
    const present = new Set<Bucket>();
    for (const t of templates) present.add(bucketOf(t));
    const tabs: string[] = [ALL];
    for (const b of BUCKET_ORDER) if (present.has(b)) tabs.push(b);
    return tabs;
  }, [templates]);

  // If the active tab vanishes (shouldn't happen — catalog is static per load),
  // snap back to "Tous" so the grid is never empty by accident.
  useEffect(() => {
    if (!categories.includes(category)) setCategory(ALL);
  }, [categories, category]);

  // Templates for the active tab, catalog order preserved.
  const visibleTemplates = useMemo(
    () =>
      category === ALL
        ? templates
        : templates.filter(t => bucketOf(t) === category),
    [templates, category]
  );

  // Flat item list for PagedList. "Sans modèle" is prepended ONLY on "Tous" so
  // it is the very first card on page 1; on a specific business tab the grid is
  // just that bucket's templates.
  const items = useMemo<PickerItem[]>(() => {
    const tpls: PickerItem[] = visibleTemplates.map(tpl => ({
      kind: 'tpl',
      tpl,
    }));
    return category === ALL ? [{ kind: 'none' }, ...tpls] : tpls;
  }, [visibleTemplates, category]);

  const pick = useCallback(
    (id: string | null) => () => onSelect(id),
    [onSelect]
  );

  // Render one PagedList item as a TemplateCard. Kept stable across pages so
  // selection highlighting and clicks behave identically to the old grid.
  const renderItem = useCallback(
    (item: PickerItem): ReactNode => {
      if (item.kind === 'none') {
        return (
          <TemplateCard
            selected={selectedTemplateId == null}
            onClick={pick(null)}
            accent={C.muted}
            gradient={[C.panel2, C.panel]}
            glyph="✚"
            name="Sans modèle"
            darja="متعدد"
            vertical="Générique"
            hero="Boutique polyvalente — repartez de zéro, tout est modifiable."
            dashed
          />
        );
      }
      const t = item.tpl;
      return (
        <TemplateCard
          selected={selectedTemplateId === t.id}
          onClick={pick(t.id)}
          accent={t.accent || C.accent}
          gradient={
            t.gradient && t.gradient.length === 2
              ? t.gradient
              : [t.accent || C.accent, t.accent || C.accent]
          }
          glyph={t.emoji || '🛍️'}
          name={t.name}
          darja={t.nameDarja}
          vertical={t.vertical}
          hero={t.heroLine}
        />
      );
    },
    [selectedTemplateId, pick]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{tplCardHoverStyle}</style>
      {/* Header / intro copy — business-type framing, not boutique-centric. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span
          aria-hidden
          style={{
            width: 36,
            height: 36,
            borderRadius: 11,
            background: 'linear-gradient(135deg, #1e96eb, #0e6bbf)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 17,
            flexShrink: 0,
            boxShadow: '0 2px 8px rgba(30, 150, 235, 0.25)',
          }}
        >
          🎨
        </span>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
            Modèles de business
          </span>
          <span style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.45 }}>
            Pharmacie, restaurant, cabinet, mode… choisissez votre type de
            business.
          </span>
        </div>
      </div>

      {/* Business-type tabs — derived from the catalog data (mapped verticals). */}
      <div
        role="tablist"
        aria-label="Filtrer les modèles par type de business"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
      >
        {categories.map(cat => {
          const active = cat === category;
          return (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setCategory(cat)}
              style={{
                appearance: 'none',
                border: `1px solid ${active ? C.accent : C.border}`,
                background: active ? C.accentSoft : 'transparent',
                color: active ? C.text : C.muted,
                fontSize: 12,
                lineHeight: 1,
                padding: '6px 12px',
                borderRadius: 999,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition:
                  'color 150ms ease, border-color 150ms ease, background 150ms ease',
              }}
            >
              {cat}
            </button>
          );
        })}
      </div>

      {/* Paginated card grid via PagedList (pageSize 8, grid mode). No scroll
          container — the card grows to fit one page; the pager sits below. The
          grid drops 2→1 column on phones (PagedList's grid minmax handles it).
          "Sans modèle" is item 0 on page 1 of "Tous" (see items memo). */}
      <PagedList<PickerItem>
        items={items}
        pageSize={8}
        grid
        minItemWidth={230}
        renderItem={renderItem}
        emptyState={
          <div style={{ ...hintStyle, padding: '20px 8px', textAlign: 'center' }}>
            Aucun modèle dans cette catégorie.
          </div>
        }
      />

      <Banner tone="info">
        Un modèle pré-remplit le look, les catégories et des produits d’exemple
        pour votre type de business — vous personnalisez tout ensuite. « Sans
        modèle » démarre un business générique, vierge.
      </Banner>
    </div>
  );
};

// A tiny centered spinner block for the wizard to show while the catalog loads
// (used only if the wizard chooses to render a transient loading step; kept
// exported so all picker chrome lives in this file).
export const TemplatePickerLoading = () => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 12,
      padding: '28px 8px',
    }}
  >
    <Spinner />
    <div style={hintStyle}>Chargement des modèles de business…</div>
  </div>
);

// ---- Card ------------------------------------------------------------------

// Scoped hover lift for unselected template cards — inline styles cannot
// express :hover, so a tiny <style> block handles the shadow/transform.
const tplCardHoverStyle = `
[data-cdz-tpl-card]:hover {
  box-shadow: 0 4px 14px rgba(0,0,0,0.18) !important;
  transform: translateY(-2px);
}
[data-cdz-tpl-card]:active {
  transform: translateY(0);
}
`;

const TemplateCard = ({
  selected,
  onClick,
  accent,
  gradient,
  glyph,
  name,
  darja,
  vertical,
  hero,
  dashed,
}: {
  selected: boolean;
  onClick: () => void;
  accent: string;
  gradient: [string, string];
  glyph: string;
  name: string;
  darja?: string;
  vertical?: string;
  hero?: string;
  dashed?: boolean;
}) => (
  <button
    type="button"
    aria-pressed={selected}
    onClick={onClick}
    data-cdz-tpl-card={selected ? '' : undefined}
    style={{
      appearance: 'none',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: 8,
      padding: 10,
      borderRadius: 14,
      textAlign: 'left',
      cursor: 'pointer',
      color: C.text,
      background: selected ? C.accentSoft : C.bg,
      border: `1px solid ${selected ? C.accent : C.border}`,
      boxShadow: selected ? `0 0 0 1px ${C.accent}, 0 2px 8px rgba(0,0,0,0.12)` : '0 1px 2px rgba(0,0,0,0.08)',
      transition:
        'border-color 150ms ease, background 150ms ease, box-shadow 200ms ease, transform 200ms ease',
      minWidth: 0,
      width: '100%',
      height: '100%',
    }}
  >
    {/* Accent color swatch header (gradient thumb + emoji glyph). */}
    <div
      aria-hidden
      style={{
        position: 'relative',
        height: 64,
        borderRadius: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 26,
        color: dashed ? C.muted : '#fff',
        background: `linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})`,
        ...(dashed ? { border: `1px dashed ${C.border}` } : { boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)' }),
      }}
    >
      {glyph}
      {/* Accent chip in the corner so the buyer's brand color is legible. */}
      {!dashed ? (
        <span
          style={{
            position: 'absolute',
            top: 6,
            insetInlineEnd: 6,
            width: 14,
            height: 14,
            borderRadius: 4,
            background: accent,
            border: '1px solid rgba(255,255,255,0.65)',
          }}
        />
      ) : null}
    </div>

    {/* FR name + darja subtitle. */}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: C.text,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
      {darja ? (
        <span
          dir="rtl"
          style={{
            fontSize: 12,
            color: C.muted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {darja}
        </span>
      ) : null}
    </div>

    {/* Vertical badge. */}
    {vertical ? (
      <span
        style={{
          alignSelf: 'flex-start',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: accent,
          background: `color-mix(in srgb, ${accent} 15%, transparent)`,
          border: `1px solid color-mix(in srgb, ${accent} 35%, transparent)`,
          padding: '2px 8px',
          borderRadius: 999,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {vertical}
      </span>
    ) : null}

    {/* Hero line preview. */}
    {hero ? (
      <span
        style={{
          fontSize: 11.5,
          color: C.muted,
          lineHeight: 1.45,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {hero}
      </span>
    ) : null}

    {/* Select state — the 'Choisir' / 'Choisi ✓' affordance. */}
    <span
      style={{
        ...btnStyle(selected ? 'primary' : 'secondary'),
        marginTop: 'auto',
        width: '100%',
        padding: '6px 10px',
        fontSize: 12,
        pointerEvents: 'none',
      }}
    >
      {selected ? 'Choisi ✓' : 'Choisir'}
    </span>
  </button>
);
