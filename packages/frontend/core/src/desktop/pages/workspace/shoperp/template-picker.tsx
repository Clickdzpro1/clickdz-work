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
// ShopERP wizard — the template gallery step (WS4-5). A PURE ADDITIVE step:
// it fetches the vertical catalog from GET /api/v1/apps/templates and lets the
// user pick a starting template (accent + look + darja hero + seed pack, all
// resolved server-side at mint via templateId). When the catalog endpoint is
// absent/empty (flag CDZ_TEMPLATE_CATALOG OFF → 404, or an older server) the
// step is NEVER inserted into the wizard flow and the wizard behaves EXACTLY as
// today — byte-identical mint with no templateId.
//
// Reuses the vdz/template-gallery pattern (category chips derived from the data,
// gradient/accent thumb cards, a default card shown first) but inline-styled to
// match the shoperp pages — no .css.ts, no portal, no new deps. It renders as a
// step body inside the wizard's existing Card/StepShell chrome.
//
// The "Sans modèle" card (templateId = null) is FIRST and selected by default,
// so a user who clicks straight through gets today's generic shop unchanged.
//
// Flow control lives in `useShopTemplates()`: the wizard calls the hook, and
// only inserts the `template` step when the hook reports `ready` with ≥1
// template. All catalog fetching/parsing stays in this file + the shared
// wrapper; the wizard snippet is a thin consumer.
// ---------------------------------------------------------------------------

const ALL = 'Tous';

// A human FR label for the common vertical buckets. The tab set is still
// DERIVED from the data (first-seen order); this only prettifies the chip text
// when a known bucket keyword is present, otherwise the raw vertical is shown.
// Kept intentionally forgiving — an unknown vertical surfaces its own chip.
const VERTICAL_LABELS: Array<{ match: RegExp; label: string }> = [
  { match: /pharma|sant[ée]|dentaire|m[ée]dic/i, label: 'Santé' },
  { match: /resto|food|fast|p[âa]tiss|caf[ée]|bakery|boulanger/i, label: 'Food' },
  { match: /mode|fashion|femme|homme|sneaker|cosm|beaut|bijou/i, label: 'Mode' },
  { match: /[ée]lectro|phone|t[ée]l|tech|informat/i, label: 'Tech' },
  {
    match: /meuble|d[ée]co|maison|droguerie|quincaill|superette|[ée]picerie/i,
    label: 'Maison',
  },
  { match: /salon|coiffure|service|booking|r[ée]serv/i, label: 'Services' },
];

/** Map a raw `vertical` to a coarse category bucket for the tab row. */
function bucketOf(vertical: string): string {
  const v = String(vertical || '').trim();
  if (!v) return 'Général';
  for (const { match, label } of VERTICAL_LABELS) {
    if (match.test(v)) return label;
  }
  return v;
}

export type TemplatesState =
  | { kind: 'loading' }
  | { kind: 'ready'; templates: ShopTemplateMeta[] }
  | { kind: 'unavailable' };

/**
 * Fetch the shop-template catalog ONCE. Returns a discriminated state the
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

  // Category chips derived from the data, first-seen order, ALL first.
  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const t of templates) {
      const b = bucketOf(t.vertical);
      if (!seen.includes(b)) seen.push(b);
    }
    return [ALL, ...seen];
  }, [templates]);

  const visible = useMemo(
    () =>
      category === ALL
        ? templates
        : templates.filter(t => bucketOf(t.vertical) === category),
    [templates, category]
  );

  const pick = useCallback(
    (id: string | null) => () => onSelect(id),
    [onSelect]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Category tabs — derived from the data (vertical buckets). */}
      <div
        role="tablist"
        aria-label="Filtrer les modèles par catégorie"
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

      {/* Card grid — 2 columns, collapsing to 1 on narrow viewports. auto-fill
          + minmax(150px) fills 2 columns at the wizard's card width and drops
          to 1 column on phones. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: 10,
        }}
      >
        {/* "Sans modèle" default card — FIRST, in every category. Selecting it
            clears the templateId → today's generic shop (byte-identical mint). */}
        {category === ALL ? (
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
        ) : null}

        {visible.map(t => (
          <TemplateCard
            key={t.id}
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
        ))}
      </div>

      <Banner tone="info">
        Un modèle pré-remplit le look, les catégories et des produits d’exemple —
        vous personnalisez tout ensuite. « Sans modèle » démarre une boutique
        générique.
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
    <div style={hintStyle}>Chargement des modèles…</div>
  </div>
);

// ---- Card ------------------------------------------------------------------

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
    style={{
      appearance: 'none',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: 8,
      padding: 10,
      borderRadius: 12,
      textAlign: 'left',
      cursor: 'pointer',
      color: C.text,
      background: selected ? C.accentSoft : C.bg,
      border: `1px solid ${selected ? C.accent : C.border}`,
      boxShadow: selected ? `0 0 0 1px ${C.accent}` : 'none',
      transition:
        'border-color 150ms ease, background 150ms ease, box-shadow 150ms ease',
      minWidth: 0,
    }}
  >
    {/* Accent color swatch header (gradient thumb + emoji glyph). */}
    <div
      aria-hidden
      style={{
        position: 'relative',
        height: 64,
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 26,
        color: dashed ? C.muted : '#fff',
        background: `linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})`,
        ...(dashed ? { border: `1px dashed ${C.border}` } : {}),
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
        marginTop: 2,
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
