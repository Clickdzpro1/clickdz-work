// ClickDz Ready Shop — the 20-vertical template catalog (PURE DATA).
//
// A "template" here is NOT a forked storefront HTML file. It is a preset bundle
// that re-selects primitives the single `CLICKDZ_SHOP_TEMPLATE_HTML` already
// ships (a theme id, a font id, a layout id, an accent) and injects a per-
// vertical content pack (store name, tagline, darja/FR hero line, categories,
// a seed pack of demo products + COD trust signals). Minting 20 templates adds
// ~0 bytes of new storefront HTML — only data.
//
// This module is intentionally framework-free and side-effect-free: no NestJS
// decorators, no DOM, no heavy imports, no network. It is a plain data array
// (`TEMPLATE_CATALOG`) plus a couple of tiny pure helpers (`getTemplateDef`,
// `listTemplates`, `listTemplateMeta`). It mirrors the pure-data-builder style
// of `packages/frontend/core/src/modules/vdz/presets.ts` and
// `.../modules/vdz/templates.ts` (the gallery reads those the same way).
//
// ── Structural contracts (do not drift) ──────────────────────────────────────
// • `theme`  ∈ THEMES ids in `clickdz-shop-template.ts`  : classic|dark|vibrant|minimal
// • `font`   ∈ FONTS  ids in `clickdz-shop-template.ts`  : system|inter|poppins|playfair
// • `layout` ∈ LAYOUTS ids in `clickdz-shop-template.ts` : standard|boutique
//            plus the two NEW ids the layout builder (WS4-2, `clickdz-shop-template.ts`)
//            adds alongside them : grid-dense|editorial-split
// • `features[]` uses ONLY canonical feature ids owned by the Forge feature
//   registry (`clickdz-features.ts`, plan 03-customization). Where a vertical's
//   ideal capability has no canonical id yet, the template ships INERT for that
//   capability (fewer / no features) rather than inventing an id — appearance +
//   seed differentiation alone delivers "20 different templates" (C2). See the
//   FEATURE_IDS allowlist below: every id in every def is asserted against it.
//
// The mint handler (WS4-4, `clickdz-bridge.controller.ts`) resolves a
// `TemplateDef` by id and substitutes the additive C5/C7 tokens. Each such token
// defaults to today's hardcoded value, so a mint WITHOUT a templateId stays
// byte-identical (the #1 safety invariant). This file only supplies the data;
// it performs no substitution and imports nothing from the template.

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

/** A shop theme id — must exist in `THEMES` in `clickdz-shop-template.ts`. */
export type TemplateThemeId = 'classic' | 'dark' | 'vibrant' | 'minimal';

/** A shop font id — must exist in `FONTS` in `clickdz-shop-template.ts`. */
export type TemplateFontId = 'system' | 'inter' | 'poppins' | 'playfair';

/**
 * A shop layout id — must exist in `LAYOUTS` in `clickdz-shop-template.ts`.
 * `standard` and `boutique` ship today; `grid-dense` and `editorial-split` are
 * added by the layout builder (WS4-2) in the same template file. Templates
 * reference these ids as specced; if WS4-2 has not landed, the runtime
 * `layoutId()` fallback resolves any unknown id to `standard` (a safe no-op),
 * so referencing them here never breaks a mint.
 */
export type TemplateLayoutId = 'standard' | 'boutique' | 'grid-dense' | 'editorial-split';

/**
 * A single seed product. Field-for-field identical to the objects returned by
 * `demoProducts()` in `clickdz-shop-template.ts`, so a seed pack drops straight
 * into the existing `seedProducts()` path (POSTed to the `products` collection
 * on first run). Prices are integer DZD. `imageUrl` is an Unsplash hotlink with
 * the `w/q/auto/fit` params the template already uses; a dead id degrades to the
 * 🛍️ placeholder via the card's `onerror`. IMPORTANT: because seed JSON may be
 * injected inside the `String.raw` template literal, product copy must contain
 * no backtick and no `${` — apostrophes in FR titles are avoided (use the
 * neutral form) to keep single-quoted JSON injection safe.
 */
export interface SeedProduct {
  /** Product name (FR, sometimes with a darja gloss) — the storefront title. */
  title: string;
  /** Price in whole DZD. */
  price: number;
  /** Category label — the chip row derives from these (`categories()`). */
  category: string;
  /** On-hand stock count. */
  stock: number;
  /** Low-stock threshold for the "Stock bas" badge. */
  reorderAt: number;
  /** Whether the product is visible on the storefront. */
  active: boolean;
  /** Image URL (Unsplash hotlink) or omitted for the placeholder glyph. */
  imageUrl: string;
  /** Short marketing description shown on the product detail page. */
  description: string;
}

/**
 * One template = an appearance preset (reusing runtime ids) + a content pack.
 * Data only; no logic. The gallery card is built from the metadata fields
 * (`emoji`, `gradient`, `name`, `nameDarja`, `vertical`); the mint uses the
 * appearance + content fields.
 */
export interface TemplateDef {
  /** Stable id, e.g. 'pharmacie' | 'resto-fastfood' | 'polyvalent'. */
  id: string;
  /** FR display name (gallery card title). */
  name: string;
  /** Darja label for the picker chip (Arabic script). */
  nameDarja: string;
  /** Free-text vertical tag; the gallery groups cards by `category`. */
  vertical: string;
  /** Picker category bucket (derived tabs: Santé / Food / Mode / Tech / Maison / Services / Général). */
  category: TemplateCategory;
  /** One-line targeting note (Clickdz outbound / ICP), not shown on the storefront. */
  icp: string;
  /** Single glyph for the gallery card. */
  emoji: string;

  /* --- appearance preset (reuses existing runtime ids) --- */
  /** Accent #RRGGBB → __CLICKDZ_ACCENT__. */
  accent: string;
  /** Theme id → __CLICKDZ_THEME__. */
  theme: TemplateThemeId;
  /** Font id → __CLICKDZ_FONT__. */
  font: TemplateFontId;
  /** Layout id → __CLICKDZ_LAYOUT__. */
  layout: TemplateLayoutId;
  /** Two colors for the gallery thumbnail gradient (card only, not the shop). */
  gradient: [string, string];
  /** Whether the shop defaults to RTL (dir="rtl") at mint → __CLICKDZ_RTL__ (WS4-6). */
  rtl: boolean;

  /* --- module preset (canonical Forge feature-registry ids only) --- */
  /**
   * Feature ids to enable, drawn ONLY from the Forge canonical registry
   * (`FEATURE_IDS`). Empty = baseline storefront (inert). Never invent ids.
   */
  features: string[];

  /* --- content pack --- */
  /** Default store name → __CLICKDZ_STORE_NAME__. */
  storeName: string;
  /** Tagline → __CLICKDZ_TAGLINE__ (default = today's hardcoded tagline). */
  tagline: string;
  /** Hero line (darja or FR per vertical) → __CLICKDZ_HERO__. */
  heroLine: string;
  /** Per-vertical COD / trust one-liner surfaced in the trust strip. */
  trustLine: string;
  /** Category chips (3–6) — also the categories the seed products are tagged with. */
  categories: string[];
  /** 8–12 demo products (DZD-priced, category-tagged). */
  products: SeedProduct[];
}

/** Gallery category buckets (the picker's derived tabs). */
export type TemplateCategory =
  | 'Santé'
  | 'Food'
  | 'Mode'
  | 'Tech'
  | 'Maison'
  | 'Services'
  | 'Général';

/* ---------------------------------------------------------------------------
 * Canonical feature-id allowlist (Forge registry — 03-customization.md).
 *
 * These are the ONLY ids a TemplateDef.features[] entry may use. The list is the
 * canonical shop-feature set Forge owns (`SHOP_FEATURES` in `clickdz-features.ts`):
 * the four content sections (hero/trust/categories/featured), plus the flag-
 * driven features Forge enumerates. Palette's plan proposed nicer per-vertical
 * slugs (booking, wa-confirm, lookbook, menu-categories, …) but those are NOT in
 * Forge's canonical list, so per BUILD-RULES ("features[] uses ONLY canonical
 * ids … never invent ids") and C2 ("templates may ship inert"), templates map
 * onto canonical ids where one fits and stay inert otherwise. A DEV assert below
 * fails loudly if any def references an id outside this set.
 * ------------------------------------------------------------------------- */
export const FEATURE_IDS = [
  // content sections (default-on content features, folded from `sections`)
  'hero',
  'trust',
  'categories',
  'featured',
  // flag-driven shop features (Forge canonical ids)
  'wishlist',
  'reviews',
  'promo',
  'variants',
  'delivery_matrix',
  'bundles',
  'loyalty',
  'announcement',
  'instagram',
  'tracking',
  'lang_toggle',
  'online_pay',
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

/* ---------------------------------------------------------------------------
 * Catalog version — bump when template ids/appearance/seed packs change so the
 * studio can detect a stale minted app (pairs with settings.tplVersion, plan
 * 03-customization). Stable exported const.
 * ------------------------------------------------------------------------- */
export const TEMPLATE_CATALOG_VERSION = 1 as const;

/* ---------------------------------------------------------------------------
 * The 20 templates.
 *
 * Grouped for the picker tabs. Layout key from Palette's table:
 *   S = standard, B = boutique, G = grid-dense, E = editorial-split.
 * Prices DZD. Hero lines are darja or FR per the plan. Product titles stay FR
 * (sellers type FR) with occasional darja glosses; all copy is single-quote /
 * backtick / ${ safe for String.raw injection.
 * ------------------------------------------------------------------------- */
export const TEMPLATE_CATALOG: TemplateDef[] = [
  /* ── 1 · Santé — Pharmacie / parapharmacie ─────────────────────────────── */
  {
    id: 'pharmacie',
    name: 'Pharmacie',
    nameDarja: 'صيدلية',
    vertical: 'pharmacie/parapharmacie',
    category: 'Santé',
    icp: 'Pharmacies & parapharmacies vendant OTC + hygiène en livraison locale.',
    emoji: '💊',
    accent: '#0ea5e9',
    theme: 'classic',
    font: 'inter',
    layout: 'standard',
    gradient: ['#0ea5e9', '#0369a1'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Pharmacie ClickDz',
    tagline: 'Votre sante, livree a domicile — paiement a la livraison.',
    heroLine: 'Votre sante, livree a domicile — paiement a la livraison',
    trustLine: 'Produits authentiques et controles',
    categories: ['Medicaments', 'Parapharmacie', 'Bebe', 'Hygiene'],
    products: [
      { title: 'Doliprane 1000mg (boite)', price: 600, category: 'Medicaments', stock: 60, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&q=75&auto=format&fit=crop', description: 'Paracetamol 1000mg, boite de 8 comprimes. Contre douleurs et fievre. Sur conseil pharmacien.' },
      { title: 'Serum physiologique x5', price: 350, category: 'Bebe', stock: 80, reorderAt: 15, active: true, imageUrl: 'https://images.unsplash.com/photo-1631549916768-4119b2e5f926?w=800&q=75&auto=format&fit=crop', description: 'Dosettes de serum physiologique steriles, lot de 5. Nettoyage nez et yeux de bebe.' },
      { title: 'Creme solaire SPF50', price: 1800, category: 'Parapharmacie', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=800&q=75&auto=format&fit=crop', description: 'Protection solaire haute SPF50, resistante a l eau. Peaux sensibles, visage et corps.' },
      { title: 'Vitamine C 1000mg', price: 900, category: 'Parapharmacie', stock: 45, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1550572017-edd951b55104?w=800&q=75&auto=format&fit=crop', description: 'Comprimes effervescents vitamine C, tube de 20. Coup de fouet et immunite.' },
      { title: 'Thermometre digital', price: 1200, category: 'Parapharmacie', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1584362917165-526a968579e8?w=800&q=75&auto=format&fit=crop', description: 'Thermometre electronique, mesure rapide, ecran LCD, embout flexible.' },
      { title: 'Gel hydroalcoolique 250ml', price: 450, category: 'Hygiene', stock: 90, reorderAt: 20, active: true, imageUrl: 'https://images.unsplash.com/photo-1584483720412-ce931f4aefa8?w=800&q=75&auto=format&fit=crop', description: 'Gel desinfectant mains 70 pourcent alcool, flacon pompe 250ml. Sechage rapide.' },
      { title: 'Pansements assortis (boite)', price: 300, category: 'Hygiene', stock: 70, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1603398938378-e54eab446dde?w=800&q=75&auto=format&fit=crop', description: 'Pansements adhesifs tailles assorties, boite de 40. Hypoallergeniques.' },
      { title: 'Lait infantile 1er age 400g', price: 2100, category: 'Bebe', stock: 20, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1590487988256-9ed24133863e?w=800&q=75&auto=format&fit=crop', description: 'Lait en poudre 1er age, formule enrichie, boite 400g. De 0 a 6 mois.' },
      { title: 'Sirop toux miel citron', price: 750, category: 'Medicaments', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1607619056574-7b8d3ee536b2?w=800&q=75&auto=format&fit=crop', description: 'Sirop apaisant gorge, miel et citron, flacon 125ml. Toux seche et irritation.' },
      { title: 'Coton hydrophile 100g', price: 250, category: 'Hygiene', stock: 65, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1631815588090-d1bcbe9a8537?w=800&q=75&auto=format&fit=crop', description: 'Coton 100 pourcent naturel, rouleau 100g. Soins et demaquillage.' },
      { title: 'Masques chirurgicaux x50', price: 500, category: 'Hygiene', stock: 55, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1586942593568-29361efcd571?w=800&q=75&auto=format&fit=crop', description: 'Masques 3 plis, boite de 50, filtration elevee. Confort respiratoire.' },
    ],
  },

  /* ── 2 · Food — Resto & Fast-Food ──────────────────────────────────────── */
  {
    id: 'resto-fastfood',
    name: 'Resto & Fast-Food',
    nameDarja: 'مطعم',
    vertical: 'restaurant/fast-food',
    category: 'Food',
    icp: 'Fast-foods & restos livrant repas chauds par quartier via WhatsApp + COD.',
    emoji: '🍔',
    accent: '#dc2626',
    theme: 'vibrant',
    font: 'poppins',
    layout: 'grid-dense',
    gradient: ['#dc2626', '#f97316'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Resto ClickDz',
    tagline: 'Plats chauds livres chez vous — paiement a la livraison.',
    heroLine: 'الأكل يوصلك سخون — كمّي و خلّص كي يوصل',
    trustLine: 'Livraison chaude en 30 min',
    categories: ['Burgers', 'Tacos & Sandwichs', 'Pizzas', 'Boissons', 'Desserts'],
    products: [
      { title: 'Burger Classic', price: 550, category: 'Burgers', stock: 100, reorderAt: 20, active: true, imageUrl: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800&q=75&auto=format&fit=crop', description: 'Steak hache, cheddar, salade, tomate, sauce maison, pain brioche. Servi chaud.' },
      { title: 'Tacos XL', price: 700, category: 'Tacos & Sandwichs', stock: 100, reorderAt: 20, active: true, imageUrl: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800&q=75&auto=format&fit=crop', description: 'Tacos double viande, frites, fromage fondu, sauce algerienne. Format XL.' },
      { title: 'Pizza Margherita', price: 900, category: 'Pizzas', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800&q=75&auto=format&fit=crop', description: 'Pate fine, sauce tomate, mozzarella, basilic frais. Cuite au four.' },
      { title: 'Poulet pane 6 pieces', price: 800, category: 'Burgers', stock: 70, reorderAt: 15, active: true, imageUrl: 'https://images.unsplash.com/photo-1562967914-608f82629710?w=800&q=75&auto=format&fit=crop', description: 'Six pieces de poulet croustillant, panure epicee. Avec sauce au choix.' },
      { title: 'Frites maison', price: 200, category: 'Burgers', stock: 120, reorderAt: 25, active: true, imageUrl: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=800&q=75&auto=format&fit=crop', description: 'Frites fraiches dorees, sel fin. Portion genereuse.' },
      { title: 'Coca-Cola 1.25L', price: 180, category: 'Boissons', stock: 150, reorderAt: 30, active: true, imageUrl: 'https://images.unsplash.com/photo-1554866585-cd94860890b7?w=800&q=75&auto=format&fit=crop', description: 'Bouteille 1.25L bien fraiche. Ideal a partager.' },
      { title: 'Assiette grillades', price: 1400, category: 'Pizzas', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=800&q=75&auto=format&fit=crop', description: 'Merguez, escalope, kebab, frites et salade. Assiette complete.' },
      { title: 'Tiramisu', price: 350, category: 'Desserts', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=800&q=75&auto=format&fit=crop', description: 'Tiramisu maison, mascarpone et cafe. Portion individuelle.' },
      { title: 'Sandwich escalope', price: 450, category: 'Tacos & Sandwichs', stock: 80, reorderAt: 15, active: true, imageUrl: 'https://images.unsplash.com/photo-1553909489-cd47e0ef937f?w=800&q=75&auto=format&fit=crop', description: 'Baguette, escalope de poulet, crudites, sauce. Sandwich genereux.' },
      { title: 'Jus orange frais 33cl', price: 220, category: 'Boissons', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1600271886742-f049cd451bba?w=800&q=75&auto=format&fit=crop', description: 'Jus d orange presse du jour, sans sucre ajoute. Gobelet 33cl.' },
    ],
  },

  /* ── 3 · Food — Patisserie / bakery ────────────────────────────────────── */
  {
    id: 'patisserie',
    name: 'Patisserie',
    nameDarja: 'حلويات',
    vertical: 'patisserie/bakery',
    category: 'Food',
    icp: 'Patisseries & boulangeries livrant gateaux frais et commandes evenements.',
    emoji: '🧁',
    accent: '#db2777',
    theme: 'vibrant',
    font: 'playfair',
    layout: 'boutique',
    gradient: ['#db2777', '#f9a8d4'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Patisserie ClickDz',
    tagline: 'Douceurs fraiches chaque jour, livrees chez vous.',
    heroLine: 'حلويات طازجة كل يوم — وصّلناهالك لباب دارك',
    trustLine: 'Prepare frais chaque matin',
    categories: ['Gateaux', 'Viennoiseries', 'Traditionnel', 'Petits fours'],
    products: [
      { title: 'Gateau chocolat (part)', price: 250, category: 'Gateaux', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=800&q=75&auto=format&fit=crop', description: 'Genoise cacao, ganache fondante. Part individuelle preparee du jour.' },
      { title: 'Croissant au beurre', price: 80, category: 'Viennoiseries', stock: 100, reorderAt: 20, active: true, imageUrl: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=800&q=75&auto=format&fit=crop', description: 'Croissant pur beurre, feuillete croustillant. Sorti du four le matin.' },
      { title: 'Makrout (boite 500g)', price: 900, category: 'Traditionnel', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1519676867240-f03562e64548?w=800&q=75&auto=format&fit=crop', description: 'Makrout aux dattes et semoule, trempes au miel. Boite 500g.' },
      { title: 'Tarte aux fraises', price: 1800, category: 'Gateaux', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=800&q=75&auto=format&fit=crop', description: 'Pate sablee, creme patissiere, fraises fraiches. Format 6 parts.' },
      { title: 'Pain au chocolat', price: 90, category: 'Viennoiseries', stock: 90, reorderAt: 18, active: true, imageUrl: 'https://images.unsplash.com/photo-1600617954089-e88865c6f7fc?w=800&q=75&auto=format&fit=crop', description: 'Feuillete beurre, deux barres de chocolat. Croustillant et fondant.' },
      { title: 'Baklawa (boite 500g)', price: 1200, category: 'Traditionnel', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1519915028121-7d3463d20b13?w=800&q=75&auto=format&fit=crop', description: 'Feuilles de brick, amandes et miel. Assortiment maison, boite 500g.' },
      { title: 'Cheesecake (part)', price: 350, category: 'Gateaux', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=800&q=75&auto=format&fit=crop', description: 'Cheesecake creme fromage, base biscuit, coulis fruits rouges.' },
      { title: 'Assortiment petits fours', price: 1500, category: 'Petits fours', stock: 22, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1558326567-98ae2405596b?w=800&q=75&auto=format&fit=crop', description: 'Douze mini gateaux varies, ideal reception. Presentation soignee.' },
      { title: 'Eclair vanille', price: 200, category: 'Petits fours', stock: 45, reorderAt: 9, active: true, imageUrl: 'https://images.unsplash.com/photo-1620980776848-84ac10194945?w=800&q=75&auto=format&fit=crop', description: 'Pate a choux, creme vanille, glacage. Preparation du jour.' },
      { title: 'Gateau anniversaire perso', price: 3500, category: 'Gateaux', stock: 10, reorderAt: 2, active: true, imageUrl: 'https://images.unsplash.com/photo-1535141192574-5d4897c12636?w=800&q=75&auto=format&fit=crop', description: 'Gateau personnalise sur commande, decor au choix. Precisez le message via WhatsApp.' },
    ],
  },

  /* ── 4 · Food — Cafe ───────────────────────────────────────────────────── */
  {
    id: 'cafe',
    name: 'Cafe',
    nameDarja: 'قهوة',
    vertical: 'cafe',
    category: 'Food',
    icp: 'Cafes & coffee-shops proposant boissons et snacks a emporter / livres.',
    emoji: '☕',
    accent: '#7c2d12',
    theme: 'classic',
    font: 'poppins',
    layout: 'grid-dense',
    gradient: ['#7c2d12', '#b45309'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Cafe ClickDz',
    tagline: 'Cafe et boissons, commandez et recuperez a la porte.',
    heroLine: 'قهوة و مشروبات — اطلب و استنى عند الباب',
    trustLine: 'Grains fraichement torrefies',
    categories: ['Cafes', 'Boissons chaudes', 'Boissons froides', 'Snacks'],
    products: [
      { title: 'Espresso', price: 120, category: 'Cafes', stock: 200, reorderAt: 40, active: true, imageUrl: 'https://images.unsplash.com/photo-1510707577719-ae7c14805e3a?w=800&q=75&auto=format&fit=crop', description: 'Espresso serre, cafe arabica torrefie. Intense et aromatique.' },
      { title: 'Cappuccino', price: 200, category: 'Cafes', stock: 180, reorderAt: 36, active: true, imageUrl: 'https://images.unsplash.com/photo-1572442388796-11668a67e53d?w=800&q=75&auto=format&fit=crop', description: 'Espresso, lait vapeur et mousse onctueuse. Saupoudre de cacao.' },
      { title: 'Cafe latte', price: 220, category: 'Cafes', stock: 150, reorderAt: 30, active: true, imageUrl: 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=800&q=75&auto=format&fit=crop', description: 'Cafe allonge au lait, mousse legere. Doux et cremeux.' },
      { title: 'The a la menthe', price: 150, category: 'Boissons chaudes', stock: 120, reorderAt: 24, active: true, imageUrl: 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=800&q=75&auto=format&fit=crop', description: 'The vert, menthe fraiche, sucre. Verre traditionnel.' },
      { title: 'Chocolat chaud', price: 250, category: 'Boissons chaudes', stock: 90, reorderAt: 18, active: true, imageUrl: 'https://images.unsplash.com/photo-1542990253-a781e04c0082?w=800&q=75&auto=format&fit=crop', description: 'Chocolat fondu, lait chaud, chantilly. Reconfortant.' },
      { title: 'Frappe caramel', price: 350, category: 'Boissons froides', stock: 70, reorderAt: 14, active: true, imageUrl: 'https://images.unsplash.com/photo-1461988320302-91bde64fc8e4?w=800&q=75&auto=format&fit=crop', description: 'Cafe glace mixe, caramel, chantilly. Servi frappe.' },
      { title: 'Jus detox 33cl', price: 300, category: 'Boissons froides', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1622597467836-f3285f2131b8?w=800&q=75&auto=format&fit=crop', description: 'Jus frais fruits et legumes, sans sucre ajoute. Gobelet 33cl.' },
      { title: 'Muffin myrtille', price: 220, category: 'Snacks', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1607958996333-41aef7caefaa?w=800&q=75&auto=format&fit=crop', description: 'Muffin moelleux aux myrtilles. Fait maison.' },
      { title: 'Cookie choco', price: 150, category: 'Snacks', stock: 80, reorderAt: 16, active: true, imageUrl: 'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?w=800&q=75&auto=format&fit=crop', description: 'Cookie aux pepites de chocolat, coeur fondant. Fait maison.' },
      { title: 'Croissant amande', price: 180, category: 'Snacks', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1568471173242-461f0a730452?w=800&q=75&auto=format&fit=crop', description: 'Croissant fourre creme d amande, amandes effilees. Gourmand.' },
    ],
  },

  /* ── 5 · Santé — Cabinet dentaire / medical (booking) ──────────────────── */
  {
    id: 'dentaire',
    name: 'Cabinet Dentaire',
    nameDarja: 'عيادة',
    vertical: 'dentaire/medical (booking)',
    category: 'Santé',
    icp: 'Cabinets dentaires / medicaux prenant des RDV en ligne, confirmation WhatsApp.',
    emoji: '🦷',
    accent: '#0891b2',
    theme: 'minimal',
    font: 'inter',
    layout: 'editorial-split',
    gradient: ['#0891b2', '#0e7490'],
    rtl: false,
    // Booking has no canonical Forge id yet → ships inert (baseline sections);
    // "services as products + WhatsApp confirmation" carries the flow today.
    features: ['hero', 'trust', 'categories'],
    storeName: 'Cabinet Dentaire ClickDz',
    tagline: 'Prenez rendez-vous en ligne, confirmation par WhatsApp.',
    heroLine: 'Prenez rendez-vous en ligne — confirmation WhatsApp',
    trustLine: 'Praticiens diplomes, hygiene stricte',
    categories: ['Consultations', 'Soins', 'Esthetique', 'Prevention'],
    products: [
      { title: 'Consultation de controle', price: 2000, category: 'Consultations', stock: 30, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1588776814546-1ffcf47267a5?w=800&q=75&auto=format&fit=crop', description: 'Examen complet et bilan bucco-dentaire. Reservez un creneau, confirmation WhatsApp.' },
      { title: 'Detartrage', price: 3500, category: 'Soins', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1609840114035-3c981b782dfe?w=800&q=75&auto=format&fit=crop', description: 'Nettoyage professionnel, elimination du tartre. Une seance.' },
      { title: 'Soin carie (composite)', price: 4000, category: 'Soins', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1606811841689-23dfddce3e95?w=800&q=75&auto=format&fit=crop', description: 'Traitement de carie et obturation composite couleur dent. Sur RDV.' },
      { title: 'Blanchiment dentaire', price: 12000, category: 'Esthetique', stock: 15, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1607613009820-a29f7bb81c04?w=800&q=75&auto=format&fit=crop', description: 'Eclaircissement en cabinet, resultat visible. Bilan prealable inclus.' },
      { title: 'Extraction simple', price: 3000, category: 'Soins', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1598256989800-fe5f95da9787?w=800&q=75&auto=format&fit=crop', description: 'Extraction dentaire sous anesthesie locale. Suivi post-op.' },
      { title: 'Radio panoramique', price: 2500, category: 'Consultations', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1629909613654-28e377c37b09?w=800&q=75&auto=format&fit=crop', description: 'Cliche panoramique dentaire numerique. Diagnostic precis.' },
      { title: 'Pose de couronne', price: 25000, category: 'Esthetique', stock: 10, reorderAt: 2, active: true, imageUrl: 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=800&q=75&auto=format&fit=crop', description: 'Couronne ceramique sur mesure. Empreinte et pose, plusieurs seances.' },
      { title: 'Bilan orthodontie enfant', price: 2500, category: 'Prevention', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1601053680509-19b9226b7e3e?w=800&q=75&auto=format&fit=crop', description: 'Evaluation orthodontique enfant, plan de traitement. Sur RDV.' },
      { title: 'Kit prevention (a domicile)', price: 1500, category: 'Prevention', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1559591935-c6c92c6f43f9?w=800&q=75&auto=format&fit=crop', description: 'Brosse, fil dentaire et dentifrice recommandes. Livre a domicile.' },
    ],
  },

  /* ── 6 · Mode — Mode femme ─────────────────────────────────────────────── */
  {
    id: 'mode-femme',
    name: 'Mode Femme',
    nameDarja: 'موضة',
    vertical: 'mode femme',
    category: 'Mode',
    icp: 'Boutiques mode femme, collections saisonnieres, livraison 58 wilayas + COD.',
    emoji: '👗',
    accent: '#be185d',
    theme: 'vibrant',
    font: 'playfair',
    layout: 'boutique',
    gradient: ['#be185d', '#f472b6'],
    rtl: false,
    // variants + wishlist are canonical Forge ids; lookbook is not → omitted.
    features: ['hero', 'trust', 'categories', 'featured', 'variants', 'wishlist'],
    storeName: 'Mode Femme ClickDz',
    tagline: 'Nouvelle collection — livraison 58 wilayas, paiement a la livraison.',
    heroLine: 'Nouvelle collection — livraison 58 wilayas, paiement a la livraison',
    trustLine: 'Echange facile sous 7 jours',
    categories: ['Robes', 'Ensembles', 'Sacs', 'Chaussures', 'Accessoires'],
    products: [
      { title: 'Robe d ete fluide', price: 4500, category: 'Robes', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=800&q=75&auto=format&fit=crop', description: 'Robe legere fluide, coupe evasee, ideale saison chaude. Plusieurs tailles.' },
      { title: 'Ensemble deux pieces', price: 6200, category: 'Ensembles', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1583496661160-fb5886a0aaaa?w=800&q=75&auto=format&fit=crop', description: 'Ensemble haut et pantalon assorti, tissu confortable. Look coordonne.' },
      { title: 'Sac a main cuir', price: 6500, category: 'Sacs', stock: 18, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=800&q=75&auto=format&fit=crop', description: 'Sac en cuir, finitions soignees, plusieurs compartiments. Elegant et pratique.' },
      { title: 'Escarpins classiques', price: 3800, category: 'Chaussures', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1543163521-1bf539c55dd2?w=800&q=75&auto=format&fit=crop', description: 'Escarpins talon moyen, cuir synthetique, confort assure. Du 36 au 41.' },
      { title: 'Foulard en soie', price: 1500, category: 'Accessoires', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1601924994987-69e26d50dc26?w=800&q=75&auto=format&fit=crop', description: 'Foulard soie, motifs elegants, toucher doux. Accessoire polyvalent.' },
      { title: 'Jean slim taille haute', price: 3200, category: 'Ensembles', stock: 35, reorderAt: 7, active: true, imageUrl: 'https://images.unsplash.com/photo-1541099649105-f69ad21f3246?w=800&q=75&auto=format&fit=crop', description: 'Jean slim stretch, taille haute, coupe flatteuse. Plusieurs tailles.' },
      { title: 'Blazer cintre', price: 5500, category: 'Ensembles', stock: 15, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1591047139829-d91aecb6caea?w=800&q=75&auto=format&fit=crop', description: 'Blazer structure, coupe cintree, chic bureau ou sortie. Doublure interieure.' },
      { title: 'Lunettes de soleil', price: 2200, category: 'Accessoires', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1511499767150-a48a237f0083?w=800&q=75&auto=format&fit=crop', description: 'Lunettes tendance, protection UV400, monture legere. Etui inclus.' },
      { title: 'Robe soiree longue', price: 8500, category: 'Robes', stock: 12, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1566174053879-31528523f8ae?w=800&q=75&auto=format&fit=crop', description: 'Robe longue elegante, tombe fluide, occasions speciales. Sur mesure disponible.' },
      { title: 'Ballerines confort', price: 2800, category: 'Chaussures', stock: 28, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1518049362265-d5b2a6467637?w=800&q=75&auto=format&fit=crop', description: 'Ballerines souples, semelle rembourree, port quotidien. Du 36 au 41.' },
    ],
  },

  /* ── 7 · Mode — Homme & Sneakers ───────────────────────────────────────── */
  {
    id: 'mode-homme',
    name: 'Homme & Sneakers',
    nameDarja: 'سنيكرز',
    vertical: 'mode homme/sneakers',
    category: 'Mode',
    icp: 'Streetwear & sneakers, produits authentiques, jeune clientele urbaine.',
    emoji: '👟',
    accent: '#1e293b',
    theme: 'dark',
    font: 'poppins',
    layout: 'boutique',
    gradient: ['#1e293b', '#0f172a'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured', 'variants', 'wishlist'],
    storeName: 'Homme & Sneakers ClickDz',
    tagline: 'Streetwear & sneakers — la piece originale livree chez vous.',
    heroLine: 'Streetwear & sneakers — القطعة الأصلية توصلك',
    trustLine: 'Articles 100 pourcent originaux',
    categories: ['Sneakers', 'T-shirts', 'Sweats', 'Pantalons', 'Casquettes'],
    products: [
      { title: 'Sneakers running', price: 7500, category: 'Sneakers', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800&q=75&auto=format&fit=crop', description: 'Sneakers amorti, mesh respirant, semelle adherente. Du 40 au 45.' },
      { title: 'Sneakers retro', price: 8900, category: 'Sneakers', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1600269452121-4f2416e55c28?w=800&q=75&auto=format&fit=crop', description: 'Modele retro cuir, look intemporel, confort quotidien. Du 40 au 45.' },
      { title: 'T-shirt oversize', price: 2200, category: 'T-shirts', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800&q=75&auto=format&fit=crop', description: 'Tee coton epais, coupe oversize, col renforce. Plusieurs coloris.' },
      { title: 'Sweat a capuche', price: 4200, category: 'Sweats', stock: 35, reorderAt: 7, active: true, imageUrl: 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=800&q=75&auto=format&fit=crop', description: 'Hoodie molleton, poche kangourou, capuche doublee. Chaud et confortable.' },
      { title: 'Jogging cargo', price: 3800, category: 'Pantalons', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1552902865-b72c031ac5ea?w=800&q=75&auto=format&fit=crop', description: 'Pantalon cargo poches multiples, bas resserre. Style utilitaire.' },
      { title: 'Casquette snapback', price: 1500, category: 'Casquettes', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1588850561407-ed78c282e89b?w=800&q=75&auto=format&fit=crop', description: 'Casquette reglable, visiere plate, broderie. Taille unique.' },
      { title: 'Jean droit brut', price: 4500, category: 'Pantalons', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1542272604-787c3835535d?w=800&q=75&auto=format&fit=crop', description: 'Jean coupe droite, denim brut, robuste. Plusieurs tailles.' },
      { title: 'Sweat col rond', price: 3500, category: 'Sweats', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?w=800&q=75&auto=format&fit=crop', description: 'Crewneck molleton, coupe droite, doux interieur. Coloris varies.' },
      { title: 'Slides sport', price: 1800, category: 'Sneakers', stock: 45, reorderAt: 9, active: true, imageUrl: 'https://images.unsplash.com/photo-1603487742131-4160ec999306?w=800&q=75&auto=format&fit=crop', description: 'Claquettes semelle souple, confort maison ou plage. Du 40 au 45.' },
      { title: 'Veste bomber', price: 6800, category: 'Sweats', stock: 15, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1591047139756-eec9f0b3e0c8?w=800&q=75&auto=format&fit=crop', description: 'Bomber leger, col cotele, zip metal. Mi-saison, look streetwear.' },
    ],
  },

  /* ── 8 · Mode — Cosmetiques / beaute ───────────────────────────────────── */
  {
    id: 'cosmetiques',
    name: 'Cosmetiques',
    nameDarja: 'تجميل',
    vertical: 'cosmetiques/beaute',
    category: 'Mode',
    icp: 'Boutiques beaute & soins, produits authentiques, forte demande feminine.',
    emoji: '💄',
    accent: '#c026d3',
    theme: 'vibrant',
    font: 'playfair',
    layout: 'boutique',
    gradient: ['#c026d3', '#f0abfc'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured', 'variants', 'wishlist'],
    storeName: 'Cosmetiques ClickDz',
    tagline: 'Beaute & soins — produits authentiques, COD partout.',
    heroLine: 'Beaute & soins — produits authentiques, COD partout',
    trustLine: 'Produits authentiques garantis',
    categories: ['Maquillage', 'Soins visage', 'Cheveux', 'Parfums'],
    products: [
      { title: 'Fond de teint mat', price: 2500, category: 'Maquillage', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1631730359585-38a4935cbec4?w=800&q=75&auto=format&fit=crop', description: 'Fond de teint fini mat, longue tenue, couvrance modulable. Plusieurs teintes.' },
      { title: 'Palette fards a paupieres', price: 3200, category: 'Maquillage', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1583241801160-9a15c6a58a1a?w=800&q=75&auto=format&fit=crop', description: 'Palette 12 teintes mates et satinees, pigmentation intense. Look jour et soir.' },
      { title: 'Rouge a levres', price: 1500, category: 'Maquillage', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1586495777744-4413f21062fa?w=800&q=75&auto=format&fit=crop', description: 'Rouge a levres cremeux, couleur intense, confort. Plusieurs teintes.' },
      { title: 'Serum acide hyaluronique', price: 3800, category: 'Soins visage', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=800&q=75&auto=format&fit=crop', description: 'Serum hydratant repulpant, acide hyaluronique. Toutes peaux.' },
      { title: 'Creme hydratante visage', price: 2800, category: 'Soins visage', stock: 35, reorderAt: 7, active: true, imageUrl: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=800&q=75&auto=format&fit=crop', description: 'Creme jour nourrissante, texture legere, non grasse. Hydratation 24h.' },
      { title: 'Masque cheveux nourrissant', price: 2200, category: 'Cheveux', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?w=800&q=75&auto=format&fit=crop', description: 'Masque reparateur, huiles nourrissantes, cheveux secs. Pot 300ml.' },
      { title: 'Huile d argan 100ml', price: 1800, category: 'Cheveux', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1608571423902-eed4a5ad8108?w=800&q=75&auto=format&fit=crop', description: 'Huile d argan pure, cheveux et peau. Nourrit et fait briller. Flacon 100ml.' },
      { title: 'Parfum femme 50ml', price: 5800, category: 'Parfums', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1541643600914-78b084683601?w=800&q=75&auto=format&fit=crop', description: 'Eau de parfum florale, tenue longue duree, sillage raffine. Flacon 50ml.' },
      { title: 'Mascara volume', price: 1600, category: 'Maquillage', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1512496015851-a90fb38ba796?w=800&q=75&auto=format&fit=crop', description: 'Mascara effet volume, brosse dense, tenue longue. Cils fournis.' },
      { title: 'Coffret soin visage', price: 4500, category: 'Soins visage', stock: 15, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1570194065650-d99fb4bedf0a?w=800&q=75&auto=format&fit=crop', description: 'Coffret nettoyant, serum et creme. Routine complete, ideal cadeau.' },
    ],
  },

  /* ── 9 · Tech — Electronique & Phones ──────────────────────────────────── */
  {
    id: 'electronique',
    name: 'Electronique & Phones',
    nameDarja: 'هواتف',
    vertical: 'electronique/phones',
    category: 'Tech',
    icp: 'Boutiques telephonie & electronique, garantie, jeune clientele tech.',
    emoji: '📱',
    accent: '#2563eb',
    theme: 'minimal',
    font: 'inter',
    layout: 'grid-dense',
    gradient: ['#2563eb', '#1d4ed8'],
    rtl: false,
    // specs-table/warranty-badge are not canonical Forge ids → ship inert.
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Electronique ClickDz',
    tagline: 'Smartphones & accessoires — garantie, paiement a la livraison.',
    heroLine: 'Smartphones & accessoires — garantie, paiement a la livraison',
    trustLine: 'Garantie et produits scelles',
    categories: ['Smartphones', 'Audio', 'Chargeurs', 'Accessoires', 'Objets connectes'],
    products: [
      { title: 'Smartphone X 128Go', price: 42000, category: 'Smartphones', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=800&q=75&auto=format&fit=crop', description: 'Ecran 6.5 pouces, 128Go, triple camera, batterie longue duree. Scelle, garanti.' },
      { title: 'Ecouteurs Bluetooth', price: 3200, category: 'Audio', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=800&q=75&auto=format&fit=crop', description: 'Ecouteurs sans fil, reduction de bruit, autonomie 24h avec boitier.' },
      { title: 'Chargeur rapide 65W', price: 2800, category: 'Chargeurs', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=800&q=75&auto=format&fit=crop', description: 'Chargeur GaN 65W, charge rapide, compatible multi-appareils.' },
      { title: 'Powerbank 20000mAh', price: 3500, category: 'Chargeurs', stock: 35, reorderAt: 7, active: true, imageUrl: 'https://images.unsplash.com/photo-1609091839311-d5365f9ff1c5?w=800&q=75&auto=format&fit=crop', description: 'Batterie externe 20000mAh, deux ports, charge rapide. Voyage et quotidien.' },
      { title: 'Cable USB-C 1m', price: 600, category: 'Accessoires', stock: 100, reorderAt: 20, active: true, imageUrl: 'https://images.unsplash.com/photo-1588599376442-3cbf9c67449e?w=800&q=75&auto=format&fit=crop', description: 'Cable USB-C tresse, charge et data, robuste. Longueur 1m.' },
      { title: 'Coque + verre trempe', price: 900, category: 'Accessoires', stock: 80, reorderAt: 16, active: true, imageUrl: 'https://images.unsplash.com/photo-1601784551446-20c9e07cdbdb?w=800&q=75&auto=format&fit=crop', description: 'Pack coque antichoc et film verre trempe. Protection complete.' },
      { title: 'Montre connectee', price: 8900, category: 'Objets connectes', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=800&q=75&auto=format&fit=crop', description: 'Smartwatch, suivi sante et notifications, ecran tactile. Autonomie plusieurs jours.' },
      { title: 'Enceinte Bluetooth', price: 4500, category: 'Audio', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=800&q=75&auto=format&fit=crop', description: 'Enceinte portable, son puissant, resistante eclaboussures. Autonomie 12h.' },
      { title: 'Support telephone voiture', price: 1200, category: 'Accessoires', stock: 45, reorderAt: 9, active: true, imageUrl: 'https://images.unsplash.com/photo-1591290619762-841e6ecf5b09?w=800&q=75&auto=format&fit=crop', description: 'Support magnetique grille aeration, rotation 360. Installation facile.' },
      { title: 'Ecouteurs filaires', price: 700, category: 'Audio', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1613040809024-b4ef7ba99bc3?w=800&q=75&auto=format&fit=crop', description: 'Ecouteurs intra-auriculaires, micro et telecommande, jack 3.5mm.' },
    ],
  },

  /* ── 10 · Tech — Accessoires telephone ─────────────────────────────────── */
  {
    id: 'accessoires-tel',
    name: 'Accessoires Tel',
    nameDarja: 'اكسسوار',
    vertical: 'accessoires telephone',
    category: 'Tech',
    icp: 'Vendeurs accessoires telephone, rotation rapide, prix accessibles.',
    emoji: '🔌',
    accent: '#0d9488',
    theme: 'classic',
    font: 'inter',
    layout: 'grid-dense',
    gradient: ['#0d9488', '#0f766e'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Accessoires Tel ClickDz',
    tagline: 'Tout pour votre telephone — bons prix, livraison rapide.',
    heroLine: 'كل ما يخص تيليفونك — أسعار بلاصة، توصيل سريع',
    trustLine: 'Meilleurs prix, livraison rapide',
    categories: ['Coques', 'Protections ecran', 'Chargeurs', 'Cables', 'Supports'],
    products: [
      { title: 'Coque silicone', price: 500, category: 'Coques', stock: 120, reorderAt: 24, active: true, imageUrl: 'https://images.unsplash.com/photo-1601784551446-20c9e07cdbdb?w=800&q=75&auto=format&fit=crop', description: 'Coque silicone souple, toucher doux, bords releves. Plusieurs coloris.' },
      { title: 'Coque antichoc', price: 900, category: 'Coques', stock: 80, reorderAt: 16, active: true, imageUrl: 'https://images.unsplash.com/photo-1592286927505-1def25115558?w=800&q=75&auto=format&fit=crop', description: 'Coque renforcee, coins absorbants, protection chute. Robuste.' },
      { title: 'Verre trempe (x2)', price: 600, category: 'Protections ecran', stock: 100, reorderAt: 20, active: true, imageUrl: 'https://images.unsplash.com/photo-1616353071855-2c5a25f494db?w=800&q=75&auto=format&fit=crop', description: 'Lot de 2 films verre trempe, durete elevee, pose sans bulles.' },
      { title: 'Chargeur mural 20W', price: 1200, category: 'Chargeurs', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=800&q=75&auto=format&fit=crop', description: 'Adaptateur mural 20W charge rapide, compact. Compatible multi-appareils.' },
      { title: 'Cable Lightning 1m', price: 700, category: 'Cables', stock: 90, reorderAt: 18, active: true, imageUrl: 'https://images.unsplash.com/photo-1588599376442-3cbf9c67449e?w=800&q=75&auto=format&fit=crop', description: 'Cable charge et data, gaine renforcee. Longueur 1m.' },
      { title: 'Support bureau', price: 800, category: 'Supports', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1591290619762-841e6ecf5b09?w=800&q=75&auto=format&fit=crop', description: 'Support telephone reglable en aluminium, angle ajustable. Stable.' },
      { title: 'Anneau support (ring)', price: 300, category: 'Supports', stock: 110, reorderAt: 22, active: true, imageUrl: 'https://images.unsplash.com/photo-1556656793-08538906a9f8?w=800&q=75&auto=format&fit=crop', description: 'Anneau adhesif rotatif, prise en main securisee, bequille. Fin.' },
      { title: 'Chargeur voiture double', price: 1000, category: 'Chargeurs', stock: 55, reorderAt: 11, active: true, imageUrl: 'https://images.unsplash.com/photo-1601999009148-52d2b8f4c48d?w=800&q=75&auto=format&fit=crop', description: 'Adaptateur allume-cigare deux ports USB, charge rapide. Compact.' },
      { title: 'Cable USB-C 2m', price: 900, category: 'Cables', stock: 70, reorderAt: 14, active: true, imageUrl: 'https://images.unsplash.com/photo-1600490722773-35753aea6332?w=800&q=75&auto=format&fit=crop', description: 'Cable USB-C tresse 2m, charge rapide et transfert. Durable.' },
      { title: 'Nettoyant ecran kit', price: 400, category: 'Protections ecran', stock: 65, reorderAt: 13, active: true, imageUrl: 'https://images.unsplash.com/photo-1563770660941-20978e870e26?w=800&q=75&auto=format&fit=crop', description: 'Spray nettoyant et chiffon microfibre. Ecran sans traces.' },
    ],
  },

  /* ── 11 · Maison — Superette / epicerie ────────────────────────────────── */
  {
    id: 'superette',
    name: 'Superette',
    nameDarja: 'سوبيريت',
    vertical: 'superette/epicerie',
    category: 'Maison',
    icp: 'Superettes / epiceries livrant le panier du foyer par quartier, COD.',
    emoji: '🛒',
    accent: '#16a34a',
    theme: 'classic',
    font: 'system',
    layout: 'grid-dense',
    gradient: ['#16a34a', '#15803d'],
    rtl: true,
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Superette ClickDz',
    tagline: 'Le panier de la maison livre chez vous — paiement a la livraison.',
    heroLine: 'قفة الدار توصلك — دفع كي توصل',
    trustLine: 'Produits frais du jour',
    categories: ['Epicerie', 'Frais', 'Boissons', 'Entretien', 'Bebe'],
    products: [
      { title: 'Huile de tournesol 5L', price: 950, category: 'Epicerie', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=800&q=75&auto=format&fit=crop', description: 'Bidon huile de tournesol 5L. Cuisine et friture. Format familial.' },
      { title: 'Semoule fine 5kg', price: 700, category: 'Epicerie', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=800&q=75&auto=format&fit=crop', description: 'Semoule de ble fine, sac 5kg. Couscous et patisserie.' },
      { title: 'Sucre cristallise 2kg', price: 320, category: 'Epicerie', stock: 80, reorderAt: 16, active: true, imageUrl: 'https://images.unsplash.com/photo-1581441363689-1f3c3c414635?w=800&q=75&auto=format&fit=crop', description: 'Sucre blanc cristallise, paquet 2kg. Usage quotidien.' },
      { title: 'Cafe moulu 250g', price: 450, category: 'Epicerie', stock: 70, reorderAt: 14, active: true, imageUrl: 'https://images.unsplash.com/photo-1447933601403-0c6688de566e?w=800&q=75&auto=format&fit=crop', description: 'Cafe moulu arabica, paquet 250g. Arome intense.' },
      { title: 'Lait UHT (pack 6)', price: 660, category: 'Frais', stock: 45, reorderAt: 9, active: true, imageUrl: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=800&q=75&auto=format&fit=crop', description: 'Pack de 6 briques lait demi-ecreme 1L. Conservation longue.' },
      { title: 'Oeufs (plateau 30)', price: 550, category: 'Frais', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1518569656558-1f25e69d93d7?w=800&q=75&auto=format&fit=crop', description: 'Plateau de 30 oeufs frais calibre moyen. Origine locale.' },
      { title: 'Eau minerale (pack 6)', price: 300, category: 'Boissons', stock: 90, reorderAt: 18, active: true, imageUrl: 'https://images.unsplash.com/photo-1616118132534-381148898bb4?w=800&q=75&auto=format&fit=crop', description: 'Pack 6 bouteilles eau minerale 1.5L. Source naturelle.' },
      { title: 'Detergent linge 3kg', price: 850, category: 'Entretien', stock: 35, reorderAt: 7, active: true, imageUrl: 'https://images.unsplash.com/photo-1626806787461-102c1bfaaea1?w=800&q=75&auto=format&fit=crop', description: 'Lessive poudre 3kg, linge blanc et couleur. Fraicheur longue duree.' },
      { title: 'Couches bebe T4 (x40)', price: 1400, category: 'Bebe', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1584839404042-8db95d29c65a?w=800&q=75&auto=format&fit=crop', description: 'Couches taille 4, paquet 40, absorption elevee. Confort bebe.' },
      { title: 'Pates alimentaires 500g', price: 120, category: 'Epicerie', stock: 100, reorderAt: 20, active: true, imageUrl: 'https://images.unsplash.com/photo-1551462147-ff29053bfc14?w=800&q=75&auto=format&fit=crop', description: 'Paquet de pates 500g, cuisson rapide. Repas du quotidien.' },
      { title: 'Concentre de tomate 800g', price: 280, category: 'Epicerie', stock: 75, reorderAt: 15, active: true, imageUrl: 'https://images.unsplash.com/photo-1592842232655-e5d345cbc2ee?w=800&q=75&auto=format&fit=crop', description: 'Boite concentre de tomate 800g, double concentre. Sauces et plats.' },
    ],
  },

  /* ── 12 · Général — Librairie & Papeterie ──────────────────────────────── */
  {
    id: 'librairie',
    name: 'Librairie & Papeterie',
    nameDarja: 'مكتبة',
    vertical: 'librairie/papeterie',
    category: 'Général',
    icp: 'Librairies-papeteries, rentree scolaire, livres et fournitures livres.',
    emoji: '📚',
    accent: '#4338ca',
    theme: 'classic',
    font: 'inter',
    layout: 'standard',
    gradient: ['#4338ca', '#3730a3'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Librairie ClickDz',
    tagline: 'Livres & fournitures, livres partout en Algerie.',
    heroLine: 'Livres & fournitures — livres partout en Algerie',
    trustLine: 'Large choix, envoi soigne',
    categories: ['Livres', 'Fournitures scolaires', 'Papeterie', 'Bureau'],
    products: [
      { title: 'Cahier 96 pages (x5)', price: 350, category: 'Fournitures scolaires', stock: 100, reorderAt: 20, active: true, imageUrl: 'https://images.unsplash.com/photo-1531346878377-a5be20888e57?w=800&q=75&auto=format&fit=crop', description: 'Lot de 5 cahiers 96 pages, grands carreaux, couverture cartonnee.' },
      { title: 'Stylos bille (boite 10)', price: 400, category: 'Papeterie', stock: 80, reorderAt: 16, active: true, imageUrl: 'https://images.unsplash.com/photo-1583485088034-697b5bc54ccd?w=800&q=75&auto=format&fit=crop', description: 'Boite de 10 stylos bille, encre fluide, prise confortable. Bleu.' },
      { title: 'Trousse scolaire garnie', price: 900, category: 'Fournitures scolaires', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1516414447565-b14be0adf13e?w=800&q=75&auto=format&fit=crop', description: 'Trousse complete: stylos, crayon, gomme, regle, taille-crayon.' },
      { title: 'Sac a dos scolaire', price: 2800, category: 'Fournitures scolaires', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800&q=75&auto=format&fit=crop', description: 'Cartable resistant, plusieurs compartiments, bretelles rembourrees.' },
      { title: 'Roman best-seller', price: 1200, category: 'Livres', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=800&q=75&auto=format&fit=crop', description: 'Roman format poche, edition recente. Lecture captivante.' },
      { title: 'Livre pour enfant', price: 800, category: 'Livres', stock: 35, reorderAt: 7, active: true, imageUrl: 'https://images.unsplash.com/photo-1512820790803-83ca734da794?w=800&q=75&auto=format&fit=crop', description: 'Album illustre jeunesse, grand format, pages solides. Des 3 ans.' },
      { title: 'Ramette papier A4', price: 650, category: 'Bureau', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1589391886645-d51941baf7fb?w=800&q=75&auto=format&fit=crop', description: 'Ramette 500 feuilles A4 80g, blancheur elevee. Impression nette.' },
      { title: 'Calculatrice scientifique', price: 2200, category: 'Bureau', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1596495578065-6e0763fa1178?w=800&q=75&auto=format&fit=crop', description: 'Calculatrice scientifique, fonctions completes, ecran clair. Lycee et fac.' },
      { title: 'Feutres coloriage (x24)', price: 700, category: 'Papeterie', stock: 45, reorderAt: 9, active: true, imageUrl: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=800&q=75&auto=format&fit=crop', description: 'Boite 24 feutres couleurs vives, pointe moyenne, lavables.' },
      { title: 'Classeur A4 + intercalaires', price: 550, category: 'Bureau', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1450101499163-c8848c66ca85?w=800&q=75&auto=format&fit=crop', description: 'Classeur rigide A4 avec jeu d intercalaires. Organisation dossiers.' },
    ],
  },

  /* ── 13 · Tech — Pieces auto ───────────────────────────────────────────── */
  {
    id: 'pieces-auto',
    name: 'Pieces Auto',
    nameDarja: 'قطع غيار',
    vertical: 'pieces auto',
    category: 'Tech',
    icp: 'Vendeurs pieces detachees auto, references multiples, livraison wilayas.',
    emoji: '🔧',
    accent: '#334155',
    theme: 'dark',
    font: 'inter',
    layout: 'grid-dense',
    gradient: ['#334155', '#1e293b'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Pieces Auto ClickDz',
    tagline: 'Pieces detachees pour toutes voitures, livraison rapide.',
    heroLine: 'قطع غيار لكل السيارات — نوصّلولك بسرعة',
    trustLine: 'References verifiees avant envoi',
    categories: ['Filtres', 'Freinage', 'Eclairage', 'Entretien', 'Accessoires'],
    products: [
      { title: 'Filtre a huile', price: 800, category: 'Filtres', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1486262715619-67b85e0b08d3?w=800&q=75&auto=format&fit=crop', description: 'Filtre a huile, filtration elevee. Precisez la reference vehicule via WhatsApp.' },
      { title: 'Plaquettes de frein (jeu)', price: 3200, category: 'Freinage', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1518987048-93e29699e79a?w=800&q=75&auto=format&fit=crop', description: 'Jeu de plaquettes de frein avant, freinage sur. Reference selon modele.' },
      { title: 'Filtre a air', price: 1200, category: 'Filtres', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?w=800&q=75&auto=format&fit=crop', description: 'Filtre a air moteur, protege l admission. Precisez le vehicule.' },
      { title: 'Ampoule H7 (x2)', price: 900, category: 'Eclairage', stock: 70, reorderAt: 14, active: true, imageUrl: 'https://images.unsplash.com/photo-1591439657848-9f4b9ce436b9?w=800&q=75&auto=format&fit=crop', description: 'Paire d ampoules H7 halogene, eclairage puissant. Montage facile.' },
      { title: 'Huile moteur 5W40 5L', price: 3500, category: 'Entretien', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1635784063388-1ff609e4a5e0?w=800&q=75&auto=format&fit=crop', description: 'Huile moteur synthetique 5W40, bidon 5L. Protection moteur.' },
      { title: 'Balais essuie-glace (paire)', price: 1400, category: 'Accessoires', stock: 45, reorderAt: 9, active: true, imageUrl: 'https://images.unsplash.com/photo-1600880292203-757bb62b4baf?w=800&q=75&auto=format&fit=crop', description: 'Paire de balais essuie-glace, caoutchouc souple, essuyage net.' },
      { title: 'Batterie 60Ah', price: 12000, category: 'Entretien', stock: 15, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1620714223084-8fcacc6dfd8d?w=800&q=75&auto=format&fit=crop', description: 'Batterie voiture 60Ah, demarrage fiable. Precisez le vehicule.' },
      { title: 'Bougies d allumage (x4)', price: 1600, category: 'Entretien', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1590142035743-9fb0e0b62e91?w=800&q=75&auto=format&fit=crop', description: 'Jeu de 4 bougies, allumage optimal. Reference selon moteur.' },
      { title: 'Tapis de sol (jeu)', price: 2200, category: 'Accessoires', stock: 35, reorderAt: 7, active: true, imageUrl: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=800&q=75&auto=format&fit=crop', description: 'Jeu de 4 tapis caoutchouc, decoupe universelle. Protege l habitacle.' },
      { title: 'Liquide de refroidissement 5L', price: 1500, category: 'Entretien', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1605218427368-e7b5b8b0dc0e?w=800&q=75&auto=format&fit=crop', description: 'Liquide de refroidissement pret a l emploi, bidon 5L. Antigel.' },
    ],
  },

  /* ── 14 · Maison — Meubles & Deco ──────────────────────────────────────── */
  {
    id: 'meubles-deco',
    name: 'Meubles & Deco',
    nameDarja: 'ديكور',
    vertical: 'meubles/deco',
    category: 'Maison',
    icp: 'Boutiques ameublement & decoration, panier moyen eleve, livraison soignee.',
    emoji: '🛋️',
    accent: '#92400e',
    theme: 'classic',
    font: 'playfair',
    layout: 'editorial-split',
    gradient: ['#92400e', '#b45309'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Meubles & Deco ClickDz',
    tagline: 'Meubles & deco pour votre interieur — paiement a la livraison.',
    heroLine: 'Meubles & deco pour votre interieur — paiement a la livraison',
    trustLine: 'Livraison et montage soignes',
    categories: ['Salon', 'Chambre', 'Rangement', 'Luminaires', 'Deco'],
    products: [
      { title: 'Canape 3 places', price: 45000, category: 'Salon', stock: 8, reorderAt: 2, active: true, imageUrl: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&q=75&auto=format&fit=crop', description: 'Canape trois places, tissu doux, assise confortable. Livraison a domicile.' },
      { title: 'Table basse bois', price: 12000, category: 'Salon', stock: 12, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1533090481720-856c6e3c1fdc?w=800&q=75&auto=format&fit=crop', description: 'Table basse bois massif, plateau spacieux, finition naturelle.' },
      { title: 'Lit 160x200', price: 38000, category: 'Chambre', stock: 6, reorderAt: 2, active: true, imageUrl: 'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?w=800&q=75&auto=format&fit=crop', description: 'Lit double 160x200, tete de lit capitonnee, sommier inclus. Montage sur place.' },
      { title: 'Armoire 3 portes', price: 32000, category: 'Rangement', stock: 8, reorderAt: 2, active: true, imageUrl: 'https://images.unsplash.com/photo-1595428774223-ef52624120d2?w=800&q=75&auto=format&fit=crop', description: 'Armoire 3 portes, penderie et etageres, grande capacite. Livree montee.' },
      { title: 'Bureau moderne', price: 15000, category: 'Rangement', stock: 15, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1518455027359-f3f8164ba6bd?w=800&q=75&auto=format&fit=crop', description: 'Bureau design avec tiroirs, plateau large. Ideal teletravail.' },
      { title: 'Lampadaire salon', price: 6500, category: 'Luminaires', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=800&q=75&auto=format&fit=crop', description: 'Lampadaire sur pied, lumiere chaleureuse, design epure. Ambiance salon.' },
      { title: 'Tapis salon 160x230', price: 9000, category: 'Deco', stock: 18, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1600166898405-da9535204843?w=800&q=75&auto=format&fit=crop', description: 'Tapis moelleux 160x230, motif moderne, doux au toucher. Chaleur du salon.' },
      { title: 'Etagere murale (x2)', price: 3500, category: 'Rangement', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1594620302200-9a762244a156?w=800&q=75&auto=format&fit=crop', description: 'Lot de 2 etageres murales bois, fixation incluse. Rangement deco.' },
      { title: 'Miroir decoratif rond', price: 4500, category: 'Deco', stock: 22, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1618220179428-22790b461013?w=800&q=75&auto=format&fit=crop', description: 'Miroir rond cadre fin, apporte lumiere et volume. Entree ou salon.' },
      { title: 'Coussins deco (lot 2)', price: 2000, category: 'Deco', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1584100936595-c0654b55a2e2?w=800&q=75&auto=format&fit=crop', description: 'Lot de 2 coussins decoratifs, housse dehoussable, moelleux. Touche cosy.' },
    ],
  },

  /* ── 15 · Mode — Bijouterie ────────────────────────────────────────────── */
  {
    id: 'bijouterie',
    name: 'Bijouterie',
    nameDarja: 'مجوهرات',
    vertical: 'bijouterie',
    category: 'Mode',
    icp: 'Bijoutiers or & argent, pieces a forte valeur, livraison securisee.',
    emoji: '💍',
    accent: '#a16207',
    theme: 'minimal',
    font: 'playfair',
    layout: 'boutique',
    gradient: ['#a16207', '#ca8a04'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured', 'variants', 'wishlist'],
    storeName: 'Bijouterie ClickDz',
    tagline: 'Or & argent — pieces uniques, livraison securisee.',
    heroLine: 'Or & argent — pieces uniques, livraison securisee',
    trustLine: 'Livraison securisee et assuree',
    categories: ['Bagues', 'Colliers', 'Bracelets', 'Boucles d oreilles', 'Montres'],
    products: [
      { title: 'Bague argent 925', price: 6500, category: 'Bagues', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1605100804763-247f67b3557e?w=800&q=75&auto=format&fit=crop', description: 'Bague argent 925, finition polie, design intemporel. Plusieurs tailles.' },
      { title: 'Collier plaque or', price: 4800, category: 'Colliers', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=800&q=75&auto=format&fit=crop', description: 'Collier fin plaque or, pendentif delicat, chaine ajustable. Elegant.' },
      { title: 'Bracelet jonc argent', price: 3800, category: 'Bracelets', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1611652022419-a9419f74343d?w=800&q=75&auto=format&fit=crop', description: 'Bracelet jonc argent, ligne epuree, se porte seul ou en accumulation.' },
      { title: 'Boucles d oreilles perles', price: 2900, category: 'Boucles d oreilles', stock: 35, reorderAt: 7, active: true, imageUrl: 'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?w=800&q=75&auto=format&fit=crop', description: 'Boucles perles nacrees, fermoir securise, raffinees. Cadeau ideal.' },
      { title: 'Alliance or 18k', price: 45000, category: 'Bagues', stock: 8, reorderAt: 2, active: true, imageUrl: 'https://images.unsplash.com/photo-1603561591411-07134e71a2a9?w=800&q=75&auto=format&fit=crop', description: 'Alliance or 18 carats, finition brillante. Gravure possible, plusieurs tailles.' },
      { title: 'Montre femme doree', price: 8900, category: 'Montres', stock: 15, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1524805444758-089113d48a6d?w=800&q=75&auto=format&fit=crop', description: 'Montre elegante bracelet dore, cadran raffine, quartz. Ecrin inclus.' },
      { title: 'Chaine homme argent', price: 5500, category: 'Colliers', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1620656798579-1984d9e87df7?w=800&q=75&auto=format&fit=crop', description: 'Chaine maille argent, robuste, fermoir securise. Longueur au choix.' },
      { title: 'Bracelet gourmette or', price: 32000, category: 'Bracelets', stock: 10, reorderAt: 2, active: true, imageUrl: 'https://images.unsplash.com/photo-1610694955371-d4a3e0ce4b52?w=800&q=75&auto=format&fit=crop', description: 'Gourmette plaquee or, maille classique. Gravure disponible.' },
      { title: 'Pendentif solitaire', price: 7500, category: 'Colliers', stock: 18, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=800&q=75&auto=format&fit=crop', description: 'Pendentif solitaire brillant, eclat lumineux, chaine incluse. Elegant.' },
      { title: 'Set bague + boucles', price: 9500, category: 'Bagues', stock: 12, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1602173574767-37ac01994b2a?w=800&q=75&auto=format&fit=crop', description: 'Parure assortie bague et boucles, coffret cadeau. Presentation soignee.' },
    ],
  },

  /* ── 16 · Santé — Bebe & puericulture ──────────────────────────────────── */
  {
    id: 'bebe',
    name: 'Bebe & Puericulture',
    nameDarja: 'بيبي',
    vertical: 'bebe/puericulture',
    category: 'Santé',
    icp: 'Boutiques puericulture, jeunes parents, qualite et securite, COD partout.',
    emoji: '🍼',
    accent: '#f472b6',
    theme: 'classic',
    font: 'poppins',
    layout: 'grid-dense',
    gradient: ['#f472b6', '#ec4899'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Bebe ClickDz',
    tagline: 'Tout pour bebe, qualite et securite, livre a domicile.',
    heroLine: 'كل ما يحتاجه بيبي — بجودة و أمان، يوصلك للدار',
    trustLine: 'Qualite et securite pour bebe',
    categories: ['Alimentation', 'Hygiene', 'Vetements', 'Eveil', 'Materiel'],
    products: [
      { title: 'Lait 2eme age 400g', price: 2100, category: 'Alimentation', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1590487988256-9ed24133863e?w=800&q=75&auto=format&fit=crop', description: 'Lait 2eme age enrichi, boite 400g. De 6 a 12 mois.' },
      { title: 'Couches T3 (x50)', price: 1500, category: 'Hygiene', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1584839404042-8db95d29c65a?w=800&q=75&auto=format&fit=crop', description: 'Couches taille 3, paquet 50, absorption elevee et douceur.' },
      { title: 'Lingettes bebe (x72)', price: 350, category: 'Hygiene', stock: 80, reorderAt: 16, active: true, imageUrl: 'https://images.unsplash.com/photo-1607081692251-8ad9f0e7f4ad?w=800&q=75&auto=format&fit=crop', description: 'Lingettes douces, sans alcool, paquet 72. Change et soin.' },
      { title: 'Biberon 260ml', price: 900, category: 'Materiel', stock: 45, reorderAt: 9, active: true, imageUrl: 'https://images.unsplash.com/photo-1544126592-807ade215a0b?w=800&q=75&auto=format&fit=crop', description: 'Biberon anti-colique 260ml, tetine debit lent. Sans BPA.' },
      { title: 'Body coton (lot 5)', price: 1800, category: 'Vetements', stock: 35, reorderAt: 7, active: true, imageUrl: 'https://images.unsplash.com/photo-1522771930-78848d9293e8?w=800&q=75&auto=format&fit=crop', description: 'Lot de 5 bodys coton doux, pression epaules. Plusieurs tailles.' },
      { title: 'Pyjama bebe', price: 1200, category: 'Vetements', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1519689680058-324335c77eba?w=800&q=75&auto=format&fit=crop', description: 'Pyjama velours doux, fermeture pression, chaud. Tailles variees.' },
      { title: 'Hochet d eveil', price: 700, category: 'Eveil', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1560582861-45078880e48e?w=800&q=75&auto=format&fit=crop', description: 'Hochet colore, textures et sons, stimule l eveil. Des la naissance.' },
      { title: 'Tapis d eveil', price: 3500, category: 'Eveil', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1522771930-78848d9293e8?w=800&q=75&auto=format&fit=crop', description: 'Tapis d eveil matelasse avec arches et jouets suspendus. Confort et jeu.' },
      { title: 'Chauffe-biberon', price: 3200, category: 'Materiel', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1519689680058-324335c77eba?w=800&q=75&auto=format&fit=crop', description: 'Chauffe-biberon rapide, temperature homogene, simple. Gain de temps.' },
      { title: 'Thermometre bebe', price: 1400, category: 'Materiel', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1584362917165-526a968579e8?w=800&q=75&auto=format&fit=crop', description: 'Thermometre frontal sans contact, lecture rapide. Douceur bebe.' },
    ],
  },

  /* ── 17 · Général — Sport & Fitness ────────────────────────────────────── */
  {
    id: 'sport',
    name: 'Sport & Fitness',
    nameDarja: 'رياضة',
    vertical: 'sport',
    category: 'Général',
    icp: 'Boutiques equipement sport & fitness, home-training, COD 58 wilayas.',
    emoji: '🏋️',
    accent: '#ea580c',
    theme: 'dark',
    font: 'poppins',
    layout: 'grid-dense',
    gradient: ['#ea580c', '#c2410c'],
    rtl: false,
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Sport ClickDz',
    tagline: 'Equipement sport & fitness — COD, 58 wilayas.',
    heroLine: 'Equipement sport & fitness — COD, 58 wilayas',
    trustLine: 'Materiel resistant, COD partout',
    categories: ['Musculation', 'Cardio', 'Vetements', 'Accessoires', 'Nutrition'],
    products: [
      { title: 'Halteres reglables 20kg', price: 8500, category: 'Musculation', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1638536532686-d610adfc8e5c?w=800&q=75&auto=format&fit=crop', description: 'Paire d halteres reglables jusqu a 20kg, disques inclus. Home gym.' },
      { title: 'Tapis de yoga', price: 1800, category: 'Cardio', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=800&q=75&auto=format&fit=crop', description: 'Tapis antiderapant, epais et confortable, sangle de transport. Yoga et fitness.' },
      { title: 'Corde a sauter', price: 900, category: 'Cardio', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1434682881908-b43d0467b798?w=800&q=75&auto=format&fit=crop', description: 'Corde a sauter reglable, poignees ergonomiques, roulement fluide. Cardio.' },
      { title: 'Bandes de resistance (set)', price: 1500, category: 'Musculation', stock: 45, reorderAt: 9, active: true, imageUrl: 'https://images.unsplash.com/photo-1598971639058-fab3c3b7c1cb?w=800&q=75&auto=format&fit=crop', description: 'Set de bandes elastiques multi-resistances, exercices varies. Compact.' },
      { title: 'Gourde sport 1L', price: 700, category: 'Accessoires', stock: 70, reorderAt: 14, active: true, imageUrl: 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=800&q=75&auto=format&fit=crop', description: 'Gourde 1L sans BPA, bouchon anti-fuite, graduation. Hydratation entrainement.' },
      { title: 'T-shirt technique', price: 2200, category: 'Vetements', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1581612129334-551ccd069e62?w=800&q=75&auto=format&fit=crop', description: 'Tee respirant sechage rapide, coupe sport, evacue la transpiration.' },
      { title: 'Short de sport', price: 1800, category: 'Vetements', stock: 55, reorderAt: 11, active: true, imageUrl: 'https://images.unsplash.com/photo-1591195853828-11db59a44f6b?w=800&q=75&auto=format&fit=crop', description: 'Short leger avec poches, ceinture elastique, confort mouvement.' },
      { title: 'Gants de musculation', price: 1200, category: 'Accessoires', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1517963879433-6ad2b056d712?w=800&q=75&auto=format&fit=crop', description: 'Gants rembourres, protection paumes, meilleure prise. Musculation.' },
      { title: 'Proteine whey 1kg', price: 6500, category: 'Nutrition', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1593095948071-474c5cc2989d?w=800&q=75&auto=format&fit=crop', description: 'Proteine whey 1kg, riche en proteines, gout chocolat. Recuperation.' },
      { title: 'Kettlebell 8kg', price: 3500, category: 'Musculation', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1517344884509-a0c97ec11bcc?w=800&q=75&auto=format&fit=crop', description: 'Kettlebell 8kg, revetement resistant, poignee large. Entrainement complet.' },
    ],
  },

  /* ── 18 · Maison — Droguerie & Quincaillerie ───────────────────────────── */
  {
    id: 'droguerie',
    name: 'Droguerie & Quincaillerie',
    nameDarja: 'دروڭري',
    vertical: 'droguerie/quincaillerie',
    category: 'Maison',
    icp: 'Drogueries-quincailleries, outillage et entretien maison, clientele mixte.',
    emoji: '🧰',
    accent: '#525252',
    theme: 'minimal',
    font: 'system',
    layout: 'grid-dense',
    gradient: ['#525252', '#404040'],
    rtl: true,
    features: ['hero', 'trust', 'categories', 'featured'],
    storeName: 'Droguerie ClickDz',
    tagline: 'Outils et produits pour la maison, tout en un.',
    heroLine: 'أدوات و مواد للبيت — كلش تلقاه هنا',
    trustLine: 'Tout pour la maison au meilleur prix',
    categories: ['Outillage', 'Peinture', 'Plomberie', 'Electricite', 'Entretien'],
    products: [
      { title: 'Perceuse sans fil 18V', price: 8500, category: 'Outillage', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=800&q=75&auto=format&fit=crop', description: 'Perceuse-visseuse 18V, batterie et chargeur inclus, couple reglable.' },
      { title: 'Jeu de tournevis (x12)', price: 1500, category: 'Outillage', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1591254498080-d217aa19e5df?w=800&q=75&auto=format&fit=crop', description: 'Set de 12 tournevis plats et cruciformes, embouts magnetiques.' },
      { title: 'Marteau arrache-clou', price: 900, category: 'Outillage', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1586864387789-628af9feed72?w=800&q=75&auto=format&fit=crop', description: 'Marteau tete acier, manche antiderapant, arrache-clou. Robuste.' },
      { title: 'Peinture murale 5L blanc', price: 2800, category: 'Peinture', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1562259949-e8e7689d7828?w=800&q=75&auto=format&fit=crop', description: 'Peinture acrylique mate 5L, bonne couvrance, sechage rapide. Interieur.' },
      { title: 'Rouleaux + bac peinture', price: 1200, category: 'Peinture', stock: 45, reorderAt: 9, active: true, imageUrl: 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?w=800&q=75&auto=format&fit=crop', description: 'Kit rouleaux, manche et bac. Application peinture facile.' },
      { title: 'Ruban adhesif toile', price: 400, category: 'Entretien', stock: 80, reorderAt: 16, active: true, imageUrl: 'https://images.unsplash.com/photo-1607472586893-edb57bdc0e39?w=800&q=75&auto=format&fit=crop', description: 'Adhesif toile resistant, multi-usages, forte adherence. Rouleau.' },
      { title: 'Multiprise 5 prises', price: 1100, category: 'Electricite', stock: 55, reorderAt: 11, active: true, imageUrl: 'https://images.unsplash.com/photo-1558002038-1055907df827?w=800&q=75&auto=format&fit=crop', description: 'Bloc multiprise 5 prises avec interrupteur, cable 1.5m. Protection.' },
      { title: 'Joint silicone + pistolet', price: 950, category: 'Plomberie', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=800&q=75&auto=format&fit=crop', description: 'Cartouche silicone etanche et pistolet. Cuisine et salle de bain.' },
      { title: 'Cadenas securite', price: 800, category: 'Outillage', stock: 60, reorderAt: 12, active: true, imageUrl: 'https://images.unsplash.com/photo-1558002038-1055907df827?w=800&q=75&auto=format&fit=crop', description: 'Cadenas anse acier trempe, trois cles fournies. Resistant.' },
      { title: 'Balai + serpilliere kit', price: 1300, category: 'Entretien', stock: 50, reorderAt: 10, active: true, imageUrl: 'https://images.unsplash.com/photo-1563453392212-326f5e854473?w=800&q=75&auto=format&fit=crop', description: 'Kit balai, seau essoreur et serpilliere. Nettoyage sols efficace.' },
    ],
  },

  /* ── 19 · Services — Salon & Coiffure (booking) ────────────────────────── */
  {
    id: 'salon-booking',
    name: 'Salon & Coiffure',
    nameDarja: 'صالون',
    vertical: 'services/booking',
    category: 'Services',
    icp: 'Salons coiffure & esthetique reservant des creneaux, confirmation WhatsApp.',
    emoji: '💈',
    accent: '#9333ea',
    theme: 'vibrant',
    font: 'poppins',
    layout: 'editorial-split',
    gradient: ['#9333ea', '#a855f7'],
    rtl: false,
    // Booking has no canonical Forge id → inert; "prestations as products +
    // WhatsApp confirmation" carries reservation today.
    features: ['hero', 'trust', 'categories'],
    storeName: 'Salon ClickDz',
    tagline: 'Reservez votre creneau — confirmation WhatsApp.',
    heroLine: 'Reservez votre creneau — coiffure, esthetique, confirmation WA',
    trustLine: 'Confirmation immediate par WhatsApp',
    categories: ['Coiffure', 'Coloration', 'Esthetique', 'Soins', 'Homme'],
    products: [
      { title: 'Coupe femme + brushing', price: 1500, category: 'Coiffure', stock: 30, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1560066984-138dadb4c035?w=800&q=75&auto=format&fit=crop', description: 'Coupe personnalisee et brushing. Reservez un creneau, confirmation WhatsApp.' },
      { title: 'Coloration complete', price: 4500, category: 'Coloration', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1522337660859-02fbefca4d79?w=800&q=75&auto=format&fit=crop', description: 'Coloration racines et longueurs, soin inclus. Sur rendez-vous.' },
      { title: 'Meches / balayage', price: 6000, category: 'Coloration', stock: 15, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1595476108010-b4d1f102b1b1?w=800&q=75&auto=format&fit=crop', description: 'Technique meches ou balayage, effet lumiere naturel. Duree variable.' },
      { title: 'Soin visage', price: 2500, category: 'Esthetique', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800&q=75&auto=format&fit=crop', description: 'Nettoyage, gommage et masque adapte. Peau nette et lumineuse.' },
      { title: 'Manucure + vernis', price: 1800, category: 'Esthetique', stock: 30, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1604654894610-df63bc536371?w=800&q=75&auto=format&fit=crop', description: 'Soin des mains, pose de vernis au choix. Finition soignee.' },
      { title: 'Epilation demi-jambes', price: 1200, category: 'Esthetique', stock: 25, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1512290923902-8a9f81dc236c?w=800&q=75&auto=format&fit=crop', description: 'Epilation cire demi-jambes, resultat durable. Sur rendez-vous.' },
      { title: 'Chignon evenement', price: 3500, category: 'Coiffure', stock: 12, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1519699047748-de8e457a634e?w=800&q=75&auto=format&fit=crop', description: 'Coiffure evenement, chignon ou attache elabore. Essai possible.' },
      { title: 'Coupe homme', price: 800, category: 'Homme', stock: 40, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=800&q=75&auto=format&fit=crop', description: 'Coupe homme moderne, finitions tondeuse et ciseaux. Sur RDV.' },
      { title: 'Taille de barbe', price: 600, category: 'Homme', stock: 45, reorderAt: 9, active: true, imageUrl: 'https://images.unsplash.com/photo-1521490878406-4d823e9e4b34?w=800&q=75&auto=format&fit=crop', description: 'Taille et contour de barbe, serviette chaude. Confort et style.' },
      { title: 'Soin capillaire keratine', price: 5000, category: 'Soins', stock: 15, reorderAt: 3, active: true, imageUrl: 'https://images.unsplash.com/photo-1626383137804-ba879e8b6f5a?w=800&q=75&auto=format&fit=crop', description: 'Traitement lissant keratine, cheveux disciplines et brillants. Sur RDV.' },
    ],
  },

  /* ── 20 · Général — Polyvalent / generique (DEFAULT, byte-identical) ────── */
  {
    id: 'polyvalent',
    name: 'Generique',
    nameDarja: 'متعدد',
    vertical: 'generique polyvalent',
    category: 'Général',
    icp: 'Vendeur polyvalent / demarrage rapide sans vertical precis. Look par defaut.',
    emoji: '🛍️',
    // Byte-identical defaults: these MUST equal the values hardcoded in
    // clickdz-shop-template.ts today (accent #0f766e, theme classic, font system,
    // layout standard, the exact default tagline). The mint substitutes the
    // C5/C7 token defaults, so picking 'polyvalent' == a no-templateId mint.
    accent: '#0f766e',
    theme: 'classic',
    font: 'system',
    layout: 'standard',
    gradient: ['#0f766e', '#0b5b54'],
    rtl: false,
    features: [],
    storeName: 'Ma Boutique',
    tagline: 'Produits de qualite, livres partout en Algerie — paiement a la livraison.',
    heroLine: 'Produits de qualite, livres partout — paiement a la livraison',
    trustLine: 'Paiement a la livraison partout en Algerie',
    categories: ['Accessoires', 'Mode', 'Electronique', 'Beaute', 'Maison'],
    products: [
      { title: 'Montre Elegance Classic', price: 4900, category: 'Accessoires', stock: 24, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1524592094714-0f0654e20314?w=800&q=75&auto=format&fit=crop', description: 'Montre a quartz, bracelet acier inoxydable, resistante a l eau. Un accessoire intemporel pour le quotidien.' },
      { title: 'Sac a Main Cuir Premium', price: 6500, category: 'Mode', stock: 12, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=800&q=75&auto=format&fit=crop', description: 'Sac en cuir veritable, finitions soignees, plusieurs compartiments. Elegance et robustesse au rendez-vous.' },
      { title: 'Ecouteurs Sans Fil Pro', price: 3200, category: 'Electronique', stock: 18, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=800&q=75&auto=format&fit=crop', description: 'Son immersif, reduction de bruit, autonomie 24h avec le boitier. Compatibles tous smartphones.' },
      { title: 'Parfum Oud Intense 50ml', price: 5800, category: 'Beaute', stock: 18, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1541643600914-78b084683601?w=800&q=75&auto=format&fit=crop', description: 'Fragrance orientale boisee, tenue longue duree. Un sillage raffine qui vous accompagne toute la journee.' },
      { title: 'Baskets Urban Confort', price: 4200, category: 'Mode', stock: 20, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=800&q=75&auto=format&fit=crop', description: 'Semelle amortissante, mesh respirant, style moderne. Ideales pour la ville comme pour le sport leger.' },
      { title: 'Lampe LED Design Bureau', price: 2400, category: 'Maison', stock: 30, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=800&q=75&auto=format&fit=crop', description: 'Eclairage reglable 3 intensites, port USB integre, bras articule. Parfaite pour le travail et la lecture.' },
      { title: 'Casque Audio Confort', price: 5500, category: 'Electronique', stock: 15, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&q=75&auto=format&fit=crop', description: 'Casque sans fil, coussinets moelleux, son riche, autonomie longue. Confort d ecoute prolonge.' },
      { title: 'Portefeuille Cuir', price: 2200, category: 'Accessoires', stock: 28, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1627123424574-724758594e93?w=800&q=75&auto=format&fit=crop', description: 'Portefeuille cuir compact, nombreux emplacements cartes. Finition soignee.' },
    ],
  },
];

/* ---------------------------------------------------------------------------
 * Tiny pure helpers (no side effects).
 * ------------------------------------------------------------------------- */

/** The stable id of the default (byte-identical) template. */
export const DEFAULT_TEMPLATE_ID = 'polyvalent' as const;

/** Return every template def, in catalog order. */
export function listTemplates(): TemplateDef[] {
  return TEMPLATE_CATALOG;
}

/**
 * Resolve a template def by id. Returns `undefined` for an unknown id so callers
 * can fall back to the default themselves (the mint handler treats a missing
 * def as "no templateId" = byte-identical).
 */
export function getTemplateDef(id: string | null | undefined): TemplateDef | undefined {
  if (!id) return undefined;
  for (let i = 0; i < TEMPLATE_CATALOG.length; i++) {
    if (TEMPLATE_CATALOG[i].id === id) return TEMPLATE_CATALOG[i];
  }
  return undefined;
}

/**
 * Lightweight gallery metadata for the `GET /api/v1/apps/templates` endpoint
 * (WS4-4). Deliberately excludes the heavy `products` seed and the long copy so
 * the list payload stays small (id/name/darja/vertical/category/emoji/gradient/
 * accent only) — the seed is injected server-side at mint, never sent to the
 * picker.
 */
export interface TemplateMeta {
  id: string;
  name: string;
  nameDarja: string;
  vertical: string;
  category: TemplateCategory;
  heroLine: string;
  emoji: string;
  accent: string;
  gradient: [string, string];
}

/** Return the small gallery metadata for every template, in catalog order. */
export function listTemplateMeta(): TemplateMeta[] {
  return TEMPLATE_CATALOG.map(function (t): TemplateMeta {
    return {
      id: t.id,
      name: t.name,
      nameDarja: t.nameDarja,
      vertical: t.vertical,
      category: t.category,
      heroLine: t.heroLine,
      emoji: t.emoji,
      accent: t.accent,
      gradient: t.gradient,
    };
  });
}

/** The distinct gallery category buckets, in first-seen catalog order. */
export function listTemplateCategories(): TemplateCategory[] {
  const seen: Record<string, boolean> = {};
  const out: TemplateCategory[] = [];
  for (let i = 0; i < TEMPLATE_CATALOG.length; i++) {
    const c = TEMPLATE_CATALOG[i].category;
    if (!seen[c]) {
      seen[c] = true;
      out.push(c);
    }
  }
  return out;
}
