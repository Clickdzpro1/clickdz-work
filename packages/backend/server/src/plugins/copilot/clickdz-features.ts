// ClickDz Work — Feature / Section / Module ID registry (SINGLE SOURCE OF TRUTH).
//
// Binding decision C2 (10-sequencing.md §1): this module owns every
// feature/section/module id used by the shop + ERP customization system. Every
// other builder (bridge allowlist, shop template, ERP template, studio
// "Fonctionnalités" tab, template catalog, AI-edit hook) consumes THESE ids —
// no duplicate literals anywhere. It fixes the pre-existing FE 3-id vs BE 4-id
// SECTION drift by declaring the 4 canonical section ids once (see SECTION_IDS).
//
// Design (Forge, 03-customization.md): typed FeatureDef records describe each
// capability — id (kebab-case, stable), FR + AR/darja names, category, scope
// (shop | erp), a scalar-only configSchema, defaultEnabled, and a `runtime`
// flag (true = a live settings-singleton flag flips it; false = needs re-mint).
// The existing appearance `sections` and the `onlinePay` boolean fold in here
// as first-class registry entries (backward-compatible — ids/defaults preserved).
//
// Dependency-light BY CONTRACT: types + data + tiny PURE helpers only. NO React,
// NO Nest, NO Node imports. This lets both the backend allowlist AND the
// frontend studio use identical logic. There is no cross-package import in this
// yarn-workspace layout (packages/frontend/core has no dependency on
// packages/backend/server, and no FE file imports from plugins/copilot today),
// so the frontend keeps a byte-identical MIRROR at
// packages/frontend/core/src/clickdz/features.ts — keep the two in lockstep.

/**
 * A single scalar config parameter a feature exposes. Values stored in the
 * settings singleton are IDs/scalars only (8KB cap discipline) — never blobs.
 * `key` is the settings-singleton field the value rides on.
 */
export interface FeatureParam {
  key: string; // settings-singleton key (camelCase to match existing fields)
  label: string; // FR label for the studio form
  labelAr?: string; // AR/darja label
  type: 'string' | 'number' | 'boolean' | 'enum';
  options?: string[]; // allowed values when type === 'enum'
  min?: number; // numeric bound (type === 'number')
  max?: number; // numeric bound (type === 'number')
  maxLen?: number; // string length cap (type === 'string')
  default?: string | number | boolean;
  hint?: string; // FR helper text
}

/**
 * The typed manifest record for one feature / section / ERP module. IDs are
 * kebab-case and STABLE (never renamed once shipped — published apps store them).
 */
export interface FeatureDef {
  /** kebab-case, stable, unique across the whole registry. */
  id: string;
  /** French display name (primary UI language). */
  nameFr: string;
  /** Arabic / Algerian darja display name. */
  nameAr: string;
  /** French one-line description for the studio card. */
  descFr?: string;
  /** Grouping bucket for the studio + intent. */
  category: 'sell' | 'engage' | 'logistics' | 'content' | 'i18n' | 'payment' | 'erp-module';
  /** Which product surface this belongs to. */
  scope: 'shop' | 'erp';
  /**
   * true  = pure runtime flag (a live settings-singleton value flips it; the
   *         deployed shell already carries the dormant code) — no re-mint.
   * false = altering the shipped HTML shell is required (re-mint, same slug).
   */
  runtime: boolean;
  /** Whether this capability is on by default (sections/core modules: true; new opt-in features: false). */
  defaultEnabled: boolean;
  /**
   * Scalar-only config parameters this feature reads. Empty for pure on/off
   * features. Stored as dedicated small settings-singleton keys (ids/scalars).
   */
  configSchema: FeatureParam[];
  /** Extra settings-singleton keys this feature reads (beyond the on/off flag + configSchema keys). */
  settingsKeys: string[];
  /** Where the storefront / ERP mounts it (documentation for the template slot hooks). */
  uiSlot: string;
  /** Other feature ids that must also be enabled (client-side enforcement). */
  deps?: string[];
  /** Other feature ids that cannot be enabled at the same time. */
  conflicts?: string[];
  /**
   * true for the folded-in appearance `sections` (hero/trust/categories/featured).
   * These persist via the legacy `settings.sections` CSV (not `settings.features`)
   * for backward compatibility. Non-section features persist via `settings.features`.
   */
  isSection?: boolean;
}

// ---------------------------------------------------------------------------
// Canonical SECTION ids — the ONE list (fixes the FE 3-id vs BE 4-id drift).
// Order is canonical (used for stable CSV serialization). All on by default
// (today's storefront shows them all). Stored in settings.sections (legacy key).
// ---------------------------------------------------------------------------
export const SECTION_IDS = ['hero', 'trust', 'categories', 'featured'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** Default = every section enabled (byte-identical to today's storefront). */
export const DEFAULT_SECTIONS: string[] = [...SECTION_IDS];
/** Default sections as the stored CSV (canonical order). */
export const DEFAULT_SECTIONS_CSV = SECTION_IDS.join(',');

// ---------------------------------------------------------------------------
// SHOP features. Ordered for a sensible studio layout (sections first, then
// payment, then sell / engage / logistics / content / i18n add-ons).
// The 4 sections + online-pay are folded-in existing capabilities (defaultEnabled
// reproduces today's behavior: sections ON, online-pay OFF). All new add-ons
// default OFF so an untouched shop is byte-identical to the legacy storefront.
// ---------------------------------------------------------------------------
export const SHOP_FEATURES: FeatureDef[] = [
  // --- Folded-in appearance sections (persist via settings.sections CSV) ---
  {
    id: 'hero',
    nameFr: 'Bannière héro',
    nameAr: 'شريط ترويسي',
    descFr: 'Le bandeau titre + appel à l’action.',
    category: 'content',
    scope: 'shop',
    runtime: true,
    defaultEnabled: true,
    configSchema: [],
    settingsKeys: ['sections'],
    uiSlot: 'home.hero',
    isSection: true,
  },
  {
    id: 'trust',
    nameFr: 'Bandeau confiance',
    nameAr: 'شريط الثقة',
    descFr: 'Rangée de réassurance COD / livraison / support.',
    category: 'content',
    scope: 'shop',
    runtime: true,
    defaultEnabled: true,
    configSchema: [],
    settingsKeys: ['sections'],
    uiSlot: 'home.trust',
    isSection: true,
  },
  {
    id: 'categories',
    nameFr: 'Rail de catégories',
    nameAr: 'شريط الفئات',
    descFr: 'Les puces horizontales de filtre par catégorie.',
    category: 'content',
    scope: 'shop',
    runtime: true,
    defaultEnabled: true,
    configSchema: [],
    settingsKeys: ['sections'],
    uiSlot: 'home.categories',
    isSection: true,
  },
  {
    id: 'featured',
    nameFr: 'Produits en vedette',
    nameAr: 'منتجات مميزة',
    descFr: 'La sélection de produits mis en avant sur l’accueil.',
    category: 'content',
    scope: 'shop',
    runtime: true,
    defaultEnabled: true,
    configSchema: [],
    settingsKeys: ['sections'],
    uiSlot: 'home.featured',
    isSection: true,
  },

  // --- Folded-in payment flag (existing settings.onlinePay boolean) ---
  {
    id: 'online-pay',
    nameFr: 'Paiement en ligne',
    nameAr: 'الدفع عبر الإنترنت',
    descFr: 'Ajoute le paiement en ligne (Chargily EDAHABIA/CIB) au paiement à la livraison.',
    category: 'payment',
    scope: 'shop',
    runtime: true,
    defaultEnabled: false,
    configSchema: [],
    // Legacy boolean lives at settings.onlinePay; the registry flag mirrors it.
    settingsKeys: ['onlinePay'],
    uiSlot: 'checkout.methods',
  },

  // --- New sell features ---
  {
    id: 'wishlist',
    nameFr: 'Liste de souhaits',
    nameAr: 'قائمة الرغبات',
    descFr: 'Les clients enregistrent des produits en favoris (stockés localement).',
    category: 'engage',
    scope: 'shop',
    runtime: true,
    defaultEnabled: false,
    configSchema: [],
    settingsKeys: [],
    uiSlot: 'product.actions',
  },
  {
    id: 'reviews',
    nameFr: 'Avis clients',
    nameAr: 'آراء الزبائن',
    descFr: 'Notes en étoiles + commentaires par produit (via l’API Data).',
    category: 'engage',
    scope: 'shop',
    runtime: true,
    defaultEnabled: false,
    configSchema: [
      {
        key: 'reviewsModeration',
        label: 'Modération avant publication',
        labelAr: 'المراجعة قبل النشر',
        type: 'boolean',
        default: false,
        hint: 'Si activé, les avis doivent être approuvés dans l’ERP avant d’apparaître.',
      },
    ],
    settingsKeys: ['reviewsModeration'],
    uiSlot: 'product.below',
  },
  {
    id: 'promo-codes',
    nameFr: 'Codes promo',
    nameAr: 'رموز التخفيض',
    descFr: 'Réductions au panier via un code (pourcentage ou montant fixe).',
    category: 'sell',
    scope: 'shop',
    runtime: true,
    defaultEnabled: false,
    configSchema: [],
    // Promo definitions live in their own Data API collection, not the singleton.
    settingsKeys: ['promoCodes'],
    uiSlot: 'cart.summary',
  },
  {
    id: 'variants',
    nameFr: 'Variantes produit',
    nameAr: 'خيارات المنتج',
    descFr: 'Options par produit (taille, couleur…) avec stock par variante.',
    category: 'sell',
    scope: 'shop',
    runtime: true,
    defaultEnabled: false,
    configSchema: [],
    settingsKeys: [],
    uiSlot: 'product.options',
  },
  {
    id: 'bundles',
    nameFr: 'Packs / Bundles',
    nameAr: 'حزم المنتجات',
    descFr: 'Vendez plusieurs produits en pack à prix réduit.',
    category: 'sell',
    scope: 'shop',
    runtime: true,
    defaultEnabled: false,
    configSchema: [],
    settingsKeys: ['bundles'],
    uiSlot: 'home.bundles',
  },
  {
    id: 'loyalty',
    nameFr: 'Points de fidélité',
    nameAr: 'نقاط الولاء',
    descFr: 'Les clients cumulent des points par commande, échangeables en réduction.',
    category: 'engage',
    scope: 'shop',
    runtime: true,
    defaultEnabled: false,
    configSchema: [
      {
        key: 'loyaltyRate',
        label: 'Points par 100 DZD dépensés',
        labelAr: 'نقاط لكل 100 دج',
        type: 'number',
        min: 1,
        max: 100,
        default: 1,
        hint: 'Nombre de points gagnés pour chaque tranche de 100 DZD.',
      },
    ],
    settingsKeys: ['loyaltyRate'],
    uiSlot: 'account.loyalty',
  },

  // --- New logistics features ---
  {
    id: 'delivery-matrix',
    nameFr: 'Frais de livraison par wilaya',
    nameAr: 'رسوم التوصيل حسب الولاية',
    descFr: 'Un tarif de livraison distinct pour chacune des 69 wilayas.',
    category: 'logistics',
    scope: 'shop',
    runtime: true,
    defaultEnabled: false,
    configSchema: [
      {
        key: 'deliveryDefaultFee',
        label: 'Frais par défaut (DZD)',
        labelAr: 'الرسوم الافتراضية (دج)',
        type: 'number',
        min: 0,
        max: 100000,
        default: 0,
        hint: 'Appliqué aux wilayas sans tarif spécifique.',
      },
    ],
    // Compact w:fee CSV in settings.deliveryMatrix (stays under the 8KB cap).
    settingsKeys: ['deliveryMatrix', 'deliveryDefaultFee'],
    uiSlot: 'checkout.shipping',
  },
  {
    id: 'order-tracking',
    nameFr: 'Suivi de commande',
    nameAr: 'تتبع الطلب',
    descFr: 'Une page où le client suit l’état de sa commande par numéro + téléphone.',
    category: 'logistics',
    scope: 'shop',
    runtime: true,
    defaultEnabled: false,
    configSchema: [],
    settingsKeys: [],
    uiSlot: 'route.track',
  },

  // --- New content features ---
  {
    id: 'announcement-bar',
    nameFr: 'Barre d’annonce',
    nameAr: 'شريط الإعلانات',
    descFr: 'Un bandeau défilant en haut du site (promo, info livraison…).',
    category: 'content',
    scope: 'shop',
    runtime: true,
    defaultEnabled: false,
    configSchema: [
      {
        key: 'announcementText',
        label: 'Texte de l’annonce',
        labelAr: 'نص الإعلان',
        type: 'string',
        maxLen: 140,
        default: '',
        hint: 'Court message affiché en haut de chaque page.',
      },
    ],
    settingsKeys: ['announcementText'],
    uiSlot: 'global.top',
  },
  {
    id: 'instagram-feed',
    nameFr: 'Flux Instagram',
    nameAr: 'خلاصة إنستغرام',
    descFr: 'Affiche les dernières publications Instagram de la boutique.',
    category: 'content',
    scope: 'shop',
    runtime: true,
    defaultEnabled: false,
    configSchema: [
      {
        key: 'instagramHandle',
        label: 'Nom d’utilisateur Instagram',
        labelAr: 'اسم المستخدم على إنستغرام',
        type: 'string',
        maxLen: 30,
        default: '',
        hint: 'Sans le @ (ex : ma_boutique).',
      },
    ],
    settingsKeys: ['instagramHandle', 'instagramImages'],
    uiSlot: 'home.bottom',
  },

  // --- Internationalization ---
  {
    id: 'lang-toggle',
    nameFr: 'Bascule darja / français',
    nameAr: 'تبديل الدارجة / الفرنسية',
    descFr: 'Un sélecteur de langue (français ↔ darja) sur la vitrine.',
    category: 'i18n',
    scope: 'shop',
    runtime: true,
    defaultEnabled: false,
    configSchema: [
      {
        key: 'defaultLang',
        label: 'Langue par défaut',
        labelAr: 'اللغة الافتراضية',
        type: 'enum',
        options: ['fr', 'ar'],
        default: 'fr',
        hint: 'La langue affichée au premier chargement.',
      },
    ],
    settingsKeys: ['defaultLang'],
    uiSlot: 'global.nav',
  },
];

// ---------------------------------------------------------------------------
// ERP module flags — ids match the ERP template TABS exactly
// (clickdz-erp-template.ts L519-526). `apercu` + `reglages` are CORE (always on,
// cannot be disabled); the rest are toggleable modules. Persist via
// settings.features (same CSV mechanism as shop features). Mason's ERP-core
// work (WSF-6 / Round 2) wires dormant module bodies to these exact ids.
// ---------------------------------------------------------------------------
export const ERP_FEATURES: FeatureDef[] = [
  {
    id: 'apercu',
    nameFr: 'Aperçu',
    nameAr: 'نظرة عامة',
    descFr: 'Tableau de bord KPIs + graphiques (module de base, toujours actif).',
    category: 'erp-module',
    scope: 'erp',
    runtime: true,
    defaultEnabled: true,
    configSchema: [],
    settingsKeys: ['features'],
    uiSlot: 'erp.nav',
  },
  {
    id: 'commandes',
    nameFr: 'Commandes',
    nameAr: 'الطلبات',
    descFr: 'Pipeline des commandes (Nouvelle → Confirmée → Expédiée → Livrée/Retournée).',
    category: 'erp-module',
    scope: 'erp',
    runtime: true,
    defaultEnabled: true,
    configSchema: [],
    settingsKeys: ['features'],
    uiSlot: 'erp.nav',
  },
  {
    id: 'stock',
    nameFr: 'Stock',
    nameAr: 'المخزون',
    descFr: 'Gestion de l’inventaire et des mouvements de stock.',
    category: 'erp-module',
    scope: 'erp',
    runtime: true,
    defaultEnabled: true,
    configSchema: [],
    settingsKeys: ['features'],
    uiSlot: 'erp.nav',
  },
  {
    id: 'clients',
    nameFr: 'Clients',
    nameAr: 'الزبائن',
    descFr: 'Fiche clients (CRM léger) et historique d’achats.',
    category: 'erp-module',
    scope: 'erp',
    runtime: true,
    defaultEnabled: true,
    configSchema: [],
    settingsKeys: ['features'],
    uiSlot: 'erp.nav',
  },
  {
    id: 'depenses',
    nameFr: 'Dépenses',
    nameAr: 'المصاريف',
    descFr: 'Suivi des dépenses et de la trésorerie.',
    category: 'erp-module',
    scope: 'erp',
    runtime: true,
    defaultEnabled: true,
    configSchema: [],
    settingsKeys: ['features'],
    uiSlot: 'erp.nav',
  },
  {
    id: 'factures',
    nameFr: 'Facturation',
    nameAr: 'الفواتير',
    descFr: 'Devis, bons de livraison et factures conformes DZ (TVA, timbre fiscal).',
    category: 'erp-module',
    scope: 'erp',
    runtime: true,
    defaultEnabled: false,
    configSchema: [],
    settingsKeys: ['features'],
    uiSlot: 'erp.nav',
  },
  {
    id: 'fournisseurs',
    nameFr: 'Fournisseurs',
    nameAr: 'الموردون',
    descFr: 'Fournisseurs et bons de commande avec réception de stock.',
    category: 'erp-module',
    scope: 'erp',
    runtime: true,
    defaultEnabled: false,
    configSchema: [],
    settingsKeys: ['features'],
    uiSlot: 'erp.nav',
  },
  {
    id: 'livraison',
    nameFr: 'Livraison',
    nameAr: 'التوصيل',
    descFr: 'Livreurs, tarifs par wilaya et suivi des expéditions.',
    category: 'erp-module',
    scope: 'erp',
    runtime: true,
    defaultEnabled: false,
    configSchema: [],
    settingsKeys: ['features'],
    uiSlot: 'erp.nav',
  },
  {
    id: 'caisse',
    nameFr: 'Caisse',
    nameAr: 'الصندوق',
    descFr: 'Caisse, encaissements COD et rapprochement par livreur.',
    category: 'erp-module',
    scope: 'erp',
    runtime: true,
    defaultEnabled: false,
    configSchema: [],
    settingsKeys: ['features'],
    uiSlot: 'erp.nav',
  },
  {
    id: 'reglages',
    nameFr: 'Réglages',
    nameAr: 'الإعدادات',
    descFr: 'Paramètres de la boutique et de l’ERP (module de base, toujours actif).',
    category: 'erp-module',
    scope: 'erp',
    runtime: true,
    defaultEnabled: true,
    configSchema: [],
    settingsKeys: ['features'],
    uiSlot: 'erp.nav',
  },
];

// ---------------------------------------------------------------------------
// ERP CORE module ids — always enabled, not user-removable. Everything else in
// ERP_FEATURES is toggleable. (`apercu` = the dashboard landing; `reglages` =
// settings — removing either would strand the user, so they are pinned on.)
// ---------------------------------------------------------------------------
export const ERP_CORE_MODULE_IDS = ['apercu', 'reglages'] as const;

// ---------------------------------------------------------------------------
// Convenience combined list (every registry entry, both scopes).
// ---------------------------------------------------------------------------
export const ALL_FEATURES: FeatureDef[] = [...SHOP_FEATURES, ...ERP_FEATURES];

/** Fast id → FeatureDef lookup across the whole registry. */
const FEATURE_BY_ID: Record<string, FeatureDef> = (() => {
  const m: Record<string, FeatureDef> = {};
  for (const f of ALL_FEATURES) m[f.id] = f;
  return m;
})();

// ---------------------------------------------------------------------------
// Tiny PURE helpers (no side effects, no imports). Shared by backend + FE.
// ---------------------------------------------------------------------------

/** True when `id` is a known feature/section/module id in the registry. */
export function isFeatureId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(FEATURE_BY_ID, id);
}

/** Look up a FeatureDef by id (undefined if unknown). */
export function getFeature(id: string): FeatureDef | undefined {
  return FEATURE_BY_ID[id];
}

/** All FeatureDefs for a scope, in declared (canonical) order. */
export function featuresForScope(scope: 'shop' | 'erp'): FeatureDef[] {
  return ALL_FEATURES.filter(f => f.scope === scope);
}

/** True when `id` is one of the 4 canonical storefront sections. */
export function isSectionId(id: string): id is SectionId {
  return (SECTION_IDS as readonly string[]).includes(id);
}

/** The section FeatureDefs, in canonical order. */
export function sectionFeatures(): FeatureDef[] {
  return SHOP_FEATURES.filter(f => f.isSection === true);
}

/** True when `id` is a core (non-removable) ERP module. */
export function isCoreErpModule(id: string): boolean {
  return (ERP_CORE_MODULE_IDS as readonly string[]).includes(id);
}

/**
 * Feature ids that are ON by default for a scope (used to seed a fresh app).
 * For shop this is the 4 sections; for erp it is every module (core + default).
 */
export function defaultEnabledIds(scope: 'shop' | 'erp'): string[] {
  return featuresForScope(scope)
    .filter(f => f.defaultEnabled)
    .map(f => f.id);
}

/**
 * Parse the compact `settings.features` CSV → the set of enabled feature ids,
 * scoped and allowlist-filtered. Unknown ids are dropped. `undefined`/unset
 * means "use the scope defaults"; an explicit empty string means "none on".
 * (Mirrors the existing parseSections contract for backward compatibility.)
 */
export function parseFeatures(
  csv: string | undefined,
  scope: 'shop' | 'erp'
): string[] {
  const defs = featuresForScope(scope).filter(f => !f.isSection);
  if (csv == null) return defs.filter(f => f.defaultEnabled).map(f => f.id);
  const wanted = new Set(
    String(csv)
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
  // Core ERP modules are always implicitly on.
  const enabled = defs
    .filter(f => wanted.has(f.id) || (scope === 'erp' && isCoreErpModule(f.id)))
    .map(f => f.id);
  return enabled;
}

/**
 * Serialize enabled feature ids back to the stored CSV, allowlist-filtered and
 * in canonical (declared) order. Section ids are excluded (they persist via the
 * legacy `settings.sections` CSV, not `settings.features`).
 */
export function serializeFeatures(
  enabled: string[],
  scope: 'shop' | 'erp'
): string {
  const want = new Set(enabled.map(s => s.trim().toLowerCase()).filter(Boolean));
  return featuresForScope(scope)
    .filter(f => !f.isSection && want.has(f.id))
    .map(f => f.id)
    .join(',');
}

/**
 * Resolve a stored features CSV into the effective enabled set for a scope,
 * applying deps (auto-enable) + conflicts (drop the later one) + core modules.
 * Pure — returns a new, canonically-ordered array. Used by both the studio
 * (preview) and the backend allowlist (persist) so they agree exactly.
 */
export function resolveFeatures(
  csv: string | undefined,
  scope: 'shop' | 'erp'
): string[] {
  const on = new Set(parseFeatures(csv, scope));
  // Auto-enable dependencies.
  for (const id of [...on]) {
    const def = FEATURE_BY_ID[id];
    if (def?.deps) for (const d of def.deps) if (isFeatureId(d)) on.add(d);
  }
  // Drop conflicting ids (keep the earlier one in canonical order).
  const ordered = featuresForScope(scope).filter(f => on.has(f.id));
  const kept = new Set<string>();
  for (const f of ordered) {
    const clash = (f.conflicts || []).some(c => kept.has(c));
    if (!clash) kept.add(f.id);
  }
  return featuresForScope(scope)
    .filter(f => kept.has(f.id))
    .map(f => f.id);
}

// Version of the registry SHAPE (bump when the FeatureDef shape changes so the
// FE mirror + template `tplVersion` staleness checks can reason about drift).
export const CLICKDZ_FEATURES_VERSION = 1;
