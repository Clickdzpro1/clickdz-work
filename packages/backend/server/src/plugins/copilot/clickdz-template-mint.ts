// ClickDz — template token resolution + feature-settings validation (pure).
//
// This module is the LOGIC HOME for two bridge-controller concerns that used to
// live inline in clickdz-bridge.controller.ts (`templateApp` + the C7 settings
// allowlist). The bridge is orchestrator-merged (C1) and MUST stay thin, so the
// substance lives here and the bridge holds only wafer-thin call sites.
//
// Framework-free: no @nestjs imports, no decorators, no Express types. Everything
// here is a pure function over plain data so it transpiles standalone and is
// trivially unit-testable (the byte-identical mint invariant is asserted here).
//
// It composes three sibling modules (all under plugins/copilot/):
//   • ./clickdz-features      (Anvil, WSF-1) — feature registry / SHOP_FEATURES / ERP_FEATURES
//   • ./clickdz-shop-catalog  (Loom,  WS4-1) — TemplateDef data + the 20 verticals
//   • the template constants   (Chisel, WS4-2/3/6) — new __CLICKDZ_*__ tokens
//
// -------------------------------------------------------------------------
// BYTE-IDENTICAL MINT INVARIANT (house rule #1 / C5 / Palette landmine #1)
// -------------------------------------------------------------------------
// resolveTemplateTokens(html, null, opts) — i.e. NO templateId — MUST substitute
// every NEW token with the EXACT string that was hardcoded in the template
// before Chisel's token seam landed. The defaults below are that ground truth,
// copied verbatim from clickdz-shop-template.ts defaultSettings()/demoProducts().
// If any default here diverges by a single byte, a no-templateId mint silently
// reshapes every existing shop on re-publish. Snapshot-test accordingly.
// =========================================================================

// The registry lives in a sibling file (Anvil owns it). We import the feature
// list + shape by NAME per the plan (03-customization §"Feature manifest").
// Type-only where possible so a not-yet-present local copy never trips the
// transpile-only image build; the value import is the runtime allowlist source.
import type { FeatureDef } from './clickdz-features';
import { SHOP_FEATURES, ERP_FEATURES } from './clickdz-features';
// The template catalog (Loom owns it). TemplateDef is the per-vertical preset
// bundle (appearance ids + copy + seed pack). See coordination notes below for
// the exact accessor name the merge must reconcile.
import type { TemplateDef, SeedProduct } from './clickdz-shop-catalog';
import { getTemplateDef, listTemplateMeta as listTemplateSummaries } from './clickdz-shop-catalog';
// R2-i (WSF-8): the catalog's stable version integer. It is stamped into every
// TEMPLATED mint (see injectTplStamp / TPL_STAMP_RE below) and is the CURRENT
// value isStale() compares a parsed stamp against. Imported by NAME (value
// import) so a stamp always carries the version the catalog shipped at mint.
import { TEMPLATE_CATALOG_VERSION } from './clickdz-shop-catalog';

// =========================================================================
// ENV GATES — mirror how the bridge reads CDZ_PUBLISH_MAX_APPS today
// (module-scope const-from-process.env, read once). Exposed as functions so the
// bridge call sites read intent-fully (`if (templateCatalogEnabled())`) and so a
// test can stub process.env before first call if needed.
// =========================================================================

/** Gate the whole 20-template picker + `templateId` handling. Default OFF. */
export function templateCatalogEnabled(): boolean {
  return process.env.CDZ_TEMPLATE_CATALOG === '1';
}

/** Gate the /customize route + Fonctionnalités feature system. Default OFF. */
export function featuresEnabled(): boolean {
  return process.env.CDZ_FEATURES_ENABLED === '1';
}

/**
 * Optional server-side kill-switch: a CSV of feature ids Fateh can disable
 * without a redeploy (03-customization §Env). Read lazily (not module-frozen)
 * so an env flip takes effect on the next request. Lowercased + trimmed.
 */
function disabledFeatureIds(): Set<string> {
  return new Set(
    (process.env.CDZ_FEATURES_DISABLED_IDS || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

// =========================================================================
// TOKEN DEFAULTS — verbatim from clickdz-shop-template.ts (byte-identical).
// These are the fallbacks used when NO templateId resolves a TemplateDef.
// Keep in lockstep with the template constant; a mismatch breaks re-publish.
// =========================================================================

// C5 wiring + settings tokens (the existing 7 the bridge already substitutes).
const DEFAULT_STORE_NAME = 'Ma Boutique';
const DEFAULT_WHATSAPP = '213600000000';
const DEFAULT_ACCENT = '#0f766e';
const DEFAULT_PIN = '1234';
// Chisel's NEW appearance tokens — defaults = today's defaultSettings() ids.
const DEFAULT_THEME = 'classic';
const DEFAULT_FONT = 'system';
const DEFAULT_LAYOUT = 'standard';
// Chisel's NEW content tokens — defaults = today's hardcoded copy/seed.
// Tagline: verbatim from defaultSettings() (note the em dash "—").
const DEFAULT_TAGLINE =
  'Produits de qualité, livrés partout en Algérie — paiement à la livraison.';
// Hero line: the default storefront has no distinct hero string beyond the
// tagline (viewHome derives its hero from shopName + tagline). Chisel documents
// the exact __CLICKDZ_HERO__ default in his NOTES; until reconciled we default
// it to the tagline so the no-templateId output is unchanged. FLAGGED in NOTES.
const DEFAULT_HERO = '';
// Categories chip row derives from products at runtime (categories()), so the
// token default is the empty string (a no-op injection). FLAGGED in NOTES.
const DEFAULT_CATEGORIES = '';
// RTL: today's template is dir="ltr" / lang="fr"; the default token value must
// keep it LTR. Empty string = "not rtl" per WS4-6's dir seam. FLAGGED in NOTES.
const DEFAULT_RTL = '';
// Seed products: the EXACT 6-product array demoProducts() returns today, as a
// double-quoted JSON string (no single quotes, no backtick, no ${ — it is
// injected inside String.raw then JSON.parse'd — Palette landmine #3). This is
// the byte-identical default for __CLICKDZ_SEED__. Kept verbatim from the
// template's demoProducts(); apostrophes in FR copy ("d'eau") are rendered as
// the Unicode right-single-quote to stay JSON- and String.raw-safe.
const DEFAULT_SEED_JSON =
  '[' +
  '{"title":"Montre Élégance Classic","price":4900,"category":"Accessoires","stock":24,"reorderAt":5,"active":true,"imageUrl":"https://images.unsplash.com/photo-1524592094714-0f0654e20314?w=600&q=70&auto=format&fit=crop","description":"Montre à quartz, bracelet acier inoxydable, résistante à l’eau. Un accessoire intemporel pour le quotidien."},' +
  '{"title":"Sac à Main Cuir Premium","price":6500,"category":"Mode","stock":12,"reorderAt":4,"active":true,"imageUrl":"https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=600&q=70&auto=format&fit=crop","description":"Sac en cuir véritable, finitions soignées, plusieurs compartiments. Élégance et robustesse au rendez-vous."},' +
  '{"title":"Écouteurs Sans Fil Pro","price":3200,"category":"Électronique","stock":3,"reorderAt":6,"active":true,"imageUrl":"https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=600&q=70&auto=format&fit=crop","description":"Son immersif, réduction de bruit, autonomie 24h avec le boîtier. Compatibles tous smartphones."},' +
  '{"title":"Parfum Oud Intense 50ml","price":5800,"category":"Beauté","stock":18,"reorderAt":5,"active":true,"imageUrl":"https://images.unsplash.com/photo-1541643600914-78b084683601?w=600&q=70&auto=format&fit=crop","description":"Fragrance orientale boisée, tenue longue durée. Un sillage raffiné qui vous accompagne toute la journée."},' +
  '{"title":"Baskets Urban Confort","price":4200,"category":"Mode","stock":0,"reorderAt":4,"active":true,"imageUrl":"https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=600&q=70&auto=format&fit=crop","description":"Semelle amortissante, mesh respirant, style moderne. Idéales pour la ville comme pour le sport léger."},' +
  '{"title":"Lampe LED Design Bureau","price":2400,"category":"Maison","stock":30,"reorderAt":8,"active":true,"imageUrl":"https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=600&q=70&auto=format&fit=crop","description":"Éclairage réglable 3 intensités, port USB intégré, bras articulé. Parfaite pour le travail et la lecture."}' +
  ']';

// =========================================================================
// resolveTemplateTokens — the single substitution primitive.
// =========================================================================

/**
 * The wiring + validated-settings values the bridge already computes for a mint.
 * These map 1:1 to the existing 7 tokens the bridge substitutes TODAY
 * (dataUrl/dataToken/slug are wiring; storeName/whatsapp/accent/pin come from
 * parseTemplateSettings). Passed in verbatim so this module never re-derives
 * secrets or re-validates settings — it only substitutes.
 */
export interface TemplateMintOpts {
  dataUrl: string;
  dataToken: string;
  slug: string;
  storeName: string;
  whatsapp: string;
  accent: string;
  pin: string;
}

/** The full set of token→value pairs a mint resolves to (for tests/telemetry). */
export interface ResolvedTokenMap {
  __CLICKDZ_DATA_URL__: string;
  __CLICKDZ_DATA_TOKEN__: string;
  __CLICKDZ_SLUG__: string;
  __CLICKDZ_STORE_NAME__: string;
  __CLICKDZ_WHATSAPP__: string;
  __CLICKDZ_ACCENT__: string;
  __CLICKDZ_PIN__: string;
  __CLICKDZ_THEME__: string;
  __CLICKDZ_FONT__: string;
  __CLICKDZ_LAYOUT__: string;
  __CLICKDZ_TAGLINE__: string;
  __CLICKDZ_HERO__: string;
  /** The vertical's reassurance line; '' for the no-template mint. */
  __CLICKDZ_TRUST__: string;
  __CLICKDZ_CATEGORIES__: string;
  __CLICKDZ_RTL__: string;
  __CLICKDZ_SEED__: string;
}

/** Compact JSON of a TemplateDef's seed pack, String.raw + JSON.parse safe. */
function seedToJson(products: SeedProduct[] | undefined): string {
  if (!Array.isArray(products) || products.length === 0) return DEFAULT_SEED_JSON;
  // JSON.stringify already emits double-quoted, backslash-escaped strings — the
  // only hazards inside a String.raw literal are a raw backtick or a `${`
  // sequence in the DATA (not the delimiters). Neutralize both defensively so a
  // stray char in an author's copy can never break the template constant. This
  // mirrors the template file's authoring warning (Palette landmine #3).
  let json = JSON.stringify(products);
  // Escape any literal backtick and any `${` that would otherwise be live inside
  // String.raw`...` at the injection site. JSON has no semantic use for either,
  // so \u-escaping them is loss-free and round-trips through JSON.parse.
  json = json.split('`').join('\\u0060').split('${').join('$\\u007b');
  return json;
}

/** A category CSV for the chip row from a def; '' when none (runtime derives). */
function categoriesToCsv(categories: string[] | undefined): string {
  if (!Array.isArray(categories) || categories.length === 0) {
    return DEFAULT_CATEGORIES;
  }
  return categories.map(c => String(c).trim()).filter(Boolean).join(',');
}

/**
 * Build the full token map for a mint. When `def` is null every NEW token takes
 * its byte-identical default, so the resulting map — fed through the SAME
 * split/join the bridge already uses — reproduces the exact pre-catalog output.
 * When `def` is present, appearance ids + content come from the TemplateDef; the
 * accent still honors the caller's validated `opts.accent` (a def's accent is
 * only the DEFAULT the wizard pre-fills, and the user may have overridden it).
 */
export function buildTemplateTokenMap(
  def: TemplateDef | null | undefined,
  opts: TemplateMintOpts
): ResolvedTokenMap {
  return {
    // Wiring + C5 settings tokens — always the caller's exact values.
    __CLICKDZ_DATA_URL__: opts.dataUrl,
    __CLICKDZ_DATA_TOKEN__: opts.dataToken,
    __CLICKDZ_SLUG__: opts.slug,
    __CLICKDZ_STORE_NAME__: opts.storeName || DEFAULT_STORE_NAME,
    __CLICKDZ_WHATSAPP__: opts.whatsapp || DEFAULT_WHATSAPP,
    __CLICKDZ_ACCENT__: opts.accent || DEFAULT_ACCENT,
    __CLICKDZ_PIN__: opts.pin || DEFAULT_PIN,
    // Appearance tokens — def ids or today's defaults.
    __CLICKDZ_THEME__: (def && def.theme) || DEFAULT_THEME,
    __CLICKDZ_FONT__: (def && def.font) || DEFAULT_FONT,
    __CLICKDZ_LAYOUT__: (def && def.layout) || DEFAULT_LAYOUT,
    // Content tokens — def copy or today's defaults.
    __CLICKDZ_TAGLINE__: (def && def.tagline) || DEFAULT_TAGLINE,
    __CLICKDZ_HERO__: (def && def.heroLine) || DEFAULT_HERO,
    // The vertical's own reassurance line (e.g. pharmacie: 'Produits
    // authentiques et controles'). Every TemplateDef has carried one since the
    // catalog shipped; until now nothing consumed it. Empty for the
    // no-template mint, which keeps that output byte-identical.
    __CLICKDZ_TRUST__: (def && def.trustLine) || '',
    __CLICKDZ_CATEGORIES__: def ? categoriesToCsv(def.categories) : DEFAULT_CATEGORIES,
    // RTL: a def may opt in (droguerie/supérette); default keeps LTR.
    __CLICKDZ_RTL__: def && (def as { rtl?: boolean }).rtl ? '1' : DEFAULT_RTL,
    // Seed pack — def's products (JSON) or today's 6-product default JSON.
    __CLICKDZ_SEED__: def ? seedToJson(def.products) : DEFAULT_SEED_JSON,
  };
}

/**
 * Substitute ALL template tokens in `html`. Uses split/join (not regex) exactly
 * like the bridge does today, so replacement order is irrelevant and a token
 * appearing many times is fully replaced. No substituted value contains another
 * __CLICKDZ_*__ sequence (wiring values are URLs/opaque, appearance ids are
 * short enums, seed JSON is escaped). Returns the resolved HTML string.
 *
 * `def == null` (no templateId) ⇒ output is byte-identical to the pre-catalog
 * mint for the same opts — the core invariant, unit-testable via buildTokenMap.
 */
export function resolveTemplateTokens(
  html: string,
  def: TemplateDef | null | undefined,
  opts: TemplateMintOpts
): string {
  const map = buildTemplateTokenMap(def, opts);
  let out = html;
  // Deterministic key order; split/join per token. Object key order is
  // insertion order here, but order does not matter (see contract above).
  const keys = Object.keys(map) as (keyof ResolvedTokenMap)[];
  for (const token of keys) {
    out = out.split(token).join(map[token]);
  }
  // R2-i (WSF-8): stamp the artifact with a version marker — but ONLY for a
  // TEMPLATED mint (def present). A no-templateId mint (def == null) MUST stay
  // byte-identical to the pre-catalog output (the #1 invariant), so it receives
  // NO stamp — a legacy shop is thus never "stale" and never nagged. The stamp
  // is an HTML comment node (does not affect rendering) inserted right after the
  // doctype (see injectTplStamp), carrying the catalog version + the templateId.
  if (def) {
    out = injectTplStamp(out, def.id);
  }
  return out;
}

// =========================================================================
// R2-i (WSF-8) — tplVersion stamp + staleness. The upgrade-path primitive
// (03-customization §"Upgrade path for published apps"): stamp a version marker
// into every TEMPLATED artifact so the studio can later detect that a published
// shop was minted against an OLDER catalog and offer "Update app to unlock new
// features". A legacy (no-templateId) shop carries NO stamp and is treated as
// current (never stale) so it is never nagged.
//
// The marker is a single HTML comment placed just after the doctype:
//   <!-- cdz-tpl v:<TEMPLATE_CATALOG_VERSION> t:<templateId|none> -->
// A comment node is inert (does not render, does not change the DOM the shop's
// SPA builds), and it is only ever ADDED to a templated mint — so the byte-
// identical-default invariant for a no-templateId mint is untouched.
// =========================================================================

/** The literal comment marker prefix (kept in one place; parser derives from it). */
const TPL_STAMP_PREFIX = '<!-- cdz-tpl ';
/**
 * Match a stamp anywhere in the document (there is only ever one, injected right
 * after the doctype). Captures the integer version and the templateId token.
 * `t:` is a slug (kebab-case ids like `resto-fastfood`) or the literal `none`.
 * Kept intentionally permissive on the id charset so a future id shape still
 * parses; the version is the only field staleness math consumes.
 */
const TPL_STAMP_RE = /<!--\s*cdz-tpl\s+v:(\d+)\s+t:([A-Za-z0-9_-]+)\s*-->/;

/**
 * Insert the version marker immediately AFTER the doctype declaration (so the
 * doctype stays at byte 0, which some static hosts/validators expect). If no
 * doctype is present the marker is prepended. Idempotent: an existing stamp is
 * replaced (never duplicated) so a re-mint of already-stamped HTML stays clean.
 * `templateId` blank/absent ⇒ the `none` sentinel (a stamp is only ever written
 * for a templated mint, but the sentinel keeps the format total).
 */
export function injectTplStamp(html: string, templateId?: string | null): string {
  if (typeof html !== 'string' || html.length === 0) return html;
  const id = typeof templateId === 'string' && templateId.trim() ? templateId.trim() : 'none';
  const marker = TPL_STAMP_PREFIX + 'v:' + String(TEMPLATE_CATALOG_VERSION) + ' t:' + id + ' -->';
  // Drop any pre-existing stamp first (idempotent re-mint) — split/join, no regex
  // replace side effects. Only the marker text is removed; surrounding HTML kept.
  let out = html;
  const existing = out.match(TPL_STAMP_RE);
  if (existing) {
    out = out.split(existing[0]).join('');
  }
  // Place after the doctype line when present; else prepend.
  const m = out.match(/<!doctype html>/i);
  if (m && typeof m.index === 'number') {
    const at = m.index + m[0].length;
    return out.slice(0, at) + '\n' + marker + out.slice(at);
  }
  return marker + '\n' + out;
}

/** The parsed contents of a stamp. `templateId` is `null` for the `none` sentinel. */
export interface TplStamp {
  /** The TEMPLATE_CATALOG_VERSION the artifact was minted against. */
  v: number;
  /** The template id, or null when the stamp carried the `none` sentinel. */
  templateId: string | null;
}

/**
 * Parse the version stamp out of an artifact's HTML. Returns null when there is
 * NO stamp (a legacy / no-templateId mint) — the caller reads "no stamp" as
 * "current, do not nag". Never throws; a malformed marker simply yields null.
 */
export function readTplStamp(html: unknown): TplStamp | null {
  if (typeof html !== 'string' || html.length === 0) return null;
  const m = html.match(TPL_STAMP_RE);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const rawId = m[2];
  const templateId = rawId && rawId !== 'none' ? rawId : null;
  return { v, templateId };
}

/** The result of a staleness check. `from` present only when a stamp was read. */
export interface StalenessResult {
  /** True when the artifact was minted against an OLDER catalog version. */
  stale: boolean;
  /** The stamped version (absent when there is no stamp = legacy). */
  from?: number;
  /** The current catalog version (always present). */
  to: number;
  /** The stamped template id (absent when no stamp / `none` sentinel). */
  templateId?: string;
}

/**
 * Compare an artifact's stamp against the CURRENT TEMPLATE_CATALOG_VERSION.
 *   • no stamp (legacy / no-templateId mint) ⇒ { stale:false, to } — NEVER nag a
 *     legacy shop (it opted out of the catalog; it has no upgrade to offer).
 *   • stamp.v <  current ⇒ { stale:true,  from, to, templateId } — offer update.
 *   • stamp.v >= current ⇒ { stale:false, from, to, templateId } — up to date.
 * Pure + total; a bad/absent stamp degrades to "not stale", never to an error.
 */
export function isStale(html: unknown): StalenessResult {
  const to = TEMPLATE_CATALOG_VERSION as number;
  const stamp = readTplStamp(html);
  if (!stamp) {
    // Legacy / untemplated artifact — no stamp means "current", never stale.
    return { stale: false, to };
  }
  const result: StalenessResult = { stale: stamp.v < to, from: stamp.v, to };
  if (stamp.templateId) result.templateId = stamp.templateId;
  return result;
}

// =========================================================================
// remintFromState — the deterministic re-mint primitive (R3's UI calls it).
//
// Given a shop's saved {templateId, featureSet, settings} plus the current
// template HTML + wiring (the caller injects CLICKDZ_SHOP_TEMPLATE_HTML and the
// minted data-url/token/slug exactly as templateApp / renderTemplateSource do —
// this module stays free of the template constant + env, so it is boot-safe and
// unit-testable). Produces FRESH html via the SAME resolveTemplateTokens path,
// so the output is byte-for-byte what a fresh `templateApp` mint of the same
// inputs would emit — including the current version stamp. This is the "re-mint
// keeping data" step of the upgrade path (data lives in the per-slug Data API,
// untouched by a re-deploy; only the HTML shell + settings singleton change).
//
// featureSet is accepted for forward-compatibility (R3 threads it into the
// settings singleton the studio persists separately); it does not alter the
// minted shell today because features resolve at RUNTIME from the singleton
// (03-customization "data-driven runtime flags"), not at mint. Kept in the
// signature so the re-mint call site is stable when a feature ever needs a
// mint-time token. Returns '' only when given empty template HTML.
// =========================================================================

/** Saved shop state the re-mint reads (mirrors Coffre's ShopState shape subset). */
export interface RemintState {
  /** The catalog template id to re-resolve; null/absent ⇒ default (untemplated). */
  templateId?: string | null;
  /** Enabled feature ids (runtime flags; carried for the singleton, not the mint). */
  featureSet?: string[];
  /** The wiring + validated settings values (same as a fresh mint's opts). */
  settings: TemplateMintOpts;
}

export function remintFromState(
  templateHtml: string,
  state: RemintState
): string {
  if (typeof templateHtml !== 'string' || templateHtml.length === 0) return '';
  // Resolve the def by id honoring the env gate (null ⇒ byte-identical default
  // mint, i.e. an untemplated re-mint stays legacy — and thus gets NO stamp).
  const def = resolveTemplateDef(state.templateId);
  return resolveTemplateTokens(templateHtml, def, state.settings);
}

/**
 * Resolve a TemplateDef from the catalog by id, honoring the env gate. Returns
 * null when the catalog is disabled, the id is absent/blank, or the id is
 * unknown — callers then fall back to the byte-identical default mint. NEVER
 * throws (a bad templateId must degrade to the current behavior, not 500).
 */
export function resolveTemplateDef(
  templateId: unknown
): TemplateDef | null {
  if (!templateCatalogEnabled()) return null;
  if (typeof templateId !== 'string') return null;
  const id = templateId.trim().toLowerCase();
  if (!id) return null;
  try {
    const def = getTemplateDef(id);
    return def || null;
  } catch {
    return null;
  }
}

/**
 * The public catalog listing for GET /api/v1/apps/templates — metadata ONLY
 * (id, names, vertical, accent, hero, emoji/gradient for the gallery card).
 * Deliberately EXCLUDES seed products (keep the payload small — Palette WS4-4).
 * Returns [] when the catalog is disabled so the route can 404/empty cleanly.
 */
export interface TemplateSummary {
  id: string;
  name: string;
  nameDarja?: string;
  vertical: string;
  accent: string;
  heroLine: string;
  emoji?: string;
  gradient?: [string, string];
}

export function listTemplateCatalog(): TemplateSummary[] {
  if (!templateCatalogEnabled()) return [];
  try {
    const rows = listTemplateSummaries();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

// =========================================================================
// validateFeatureSettings — the feature-aware allowlist (WSF-2).
//
// Extends the existing C7 IDS-only allowlist approach (normalizeErpSettings /
// POST /erp/settings) to features:
//   • `features`  — a CSV/array of registry feature ids. Unknown ids REJECTED.
//   • per-feature scalar params — only keys the enabled features DECLARE in
//     their registry `settingsKeys`, and only scalar values (string/number/
//     boolean). Objects/arrays/functions REJECTED (they belong in a Data API
//     collection, not the 8KB singleton — Forge landmine).
// Storage stays IDs + scalars only; a hard <8KB size guard mirrors
// ERP_MAX_WRITE_BYTES so a features patch can never overflow the singleton.
// =========================================================================

// Match the bridge's ERP_MAX_WRITE_BYTES (8*1024 - 128). Kept as a local const
// so this module needs no import from the controller; the bridge applies its
// own guard on the MERGED record too (belt-and-braces).
const FEATURE_MAX_BYTES = 8 * 1024 - 128;
// Defensive cap on the stored features CSV length (ids only; tiny by design).
const FEATURE_CSV_MAX_LEN = 512;
// The scope this validation is running for. Shop and ERP draw from different
// registry slices but share the identical id+scalar discipline.
export type FeatureScope = 'shop' | 'erp';

/** A validated feature patch ready to merge into the settings singleton. */
export interface FeaturePatch {
  /** Canonical, de-duplicated CSV of enabled feature ids (registry order). */
  features: string;
  /** Per-feature scalar params, keyed by the feature's declared settingsKeys. */
  params: Record<string, string | number | boolean>;
}

export type FeatureValidation =
  | { ok: true; patch: FeaturePatch }
  | { ok: false; field: string };

type Scalar = string | number | boolean;

function isScalar(v: unknown): v is Scalar {
  return (
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  );
}

/** The registry slice for a scope, minus any server-killed ids. */
function registryFor(scope: FeatureScope): FeatureDef[] {
  const all = scope === 'erp' ? ERP_FEATURES : SHOP_FEATURES;
  const list = Array.isArray(all) ? all : [];
  const killed = disabledFeatureIds();
  return list.filter(f => f && typeof f.id === 'string' && !killed.has(f.id));
}

/** Normalize a features field (CSV string or string[]) → array of raw ids. */
function toIdArray(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    return raw.map(v => (typeof v === 'string' ? v : ''));
  }
  if (typeof raw === 'string') {
    return raw.split(',');
  }
  return null;
}

/**
 * Validate a {features?, settings?} customization input against the registry.
 *
 * `input.features` — CSV or string[] of feature ids. Every id MUST exist in the
 * scope's registry (after kill-switch filtering); an unknown id ⇒
 * `{ok:false, field:'features'}`. The result CSV is de-duplicated and ordered by
 * the registry (stable, tiny).
 *
 * `input.settings` — a flat object of per-feature scalar params. A key is
 * accepted ONLY if (a) it is declared by some ENABLED feature's `settingsKeys`
 * and (b) its value is a scalar. Any key not owned by an enabled feature, or any
 * non-scalar value, ⇒ `{ok:false, field:<offending key>}`. This is the same
 * "allowlist by declared keys" posture C7 uses for theme/font/sections.
 *
 * Finally a <8KB guard on the serialized patch (mirrors ERP_MAX_WRITE_BYTES);
 * oversize ⇒ `{ok:false, field:'settings'}`.
 *
 * Returns the FIRST offending field name so the caller can emit the SAME
 * `{error:'invalid_settings', field}` contract body the bridge already uses
 * (via passthrough res — a typed error can't carry `field`).
 */
export function validateFeatureSettings(
  input: unknown,
  scope: FeatureScope = 'shop'
): FeatureValidation {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, field: 'body' };
  }
  const body = input as { features?: unknown; settings?: unknown };
  const registry = registryFor(scope);
  const byId = new Map<string, FeatureDef>();
  for (const f of registry) byId.set(f.id, f);

  // ----- features CSV / array ------------------------------------------------
  const enabledIds = new Set<string>();
  if (body.features !== undefined && body.features !== null) {
    const arr = toIdArray(body.features);
    if (arr === null) return { ok: false, field: 'features' };
    for (const raw of arr) {
      const id = raw.trim().toLowerCase();
      if (!id) continue;
      if (!byId.has(id)) return { ok: false, field: 'features' };
      enabledIds.add(id);
    }
  }
  // Canonical CSV in registry order (stable, de-duplicated, tiny).
  const featuresCsv = registry
    .filter(f => enabledIds.has(f.id))
    .map(f => f.id)
    .join(',');
  if (featuresCsv.length > FEATURE_CSV_MAX_LEN) {
    return { ok: false, field: 'features' };
  }

  // ----- per-feature scalar params ------------------------------------------
  // The union of settingsKeys declared by the ENABLED features. A param key is
  // only writable if some enabled feature owns it (prevents smuggling arbitrary
  // singleton keys through this route).
  const allowedKeys = new Set<string>();
  for (const id of enabledIds) {
    const def = byId.get(id);
    const keys = def && Array.isArray(def.settingsKeys) ? def.settingsKeys : [];
    for (const k of keys) if (typeof k === 'string' && k) allowedKeys.add(k);
  }
  const params: Record<string, Scalar> = {};
  if (body.settings !== undefined && body.settings !== null) {
    if (typeof body.settings !== 'object' || Array.isArray(body.settings)) {
      return { ok: false, field: 'settings' };
    }
    const s = body.settings as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      const val = s[key];
      if (val === undefined) continue;
      if (!allowedKeys.has(key)) return { ok: false, field: key };
      if (!isScalar(val)) return { ok: false, field: key };
      params[key] = val;
    }
  }

  // ----- size guard (mirror ERP_MAX_WRITE_BYTES) ----------------------------
  const patch: FeaturePatch = { features: featuresCsv, params };
  const bytes = Buffer.byteLength(
    JSON.stringify({ features: featuresCsv, ...params }),
    'utf8'
  );
  if (bytes > FEATURE_MAX_BYTES) return { ok: false, field: 'settings' };

  return { ok: true, patch };
}

/**
 * Does toggling any of these feature ids require a re-mint (runtime:false), or
 * are they all pure runtime flags? Drives the /customize re-publish decision:
 * pure-runtime changes reflect on the next settings fetch (no redeploy), while a
 * runtime:false feature needs the shipped HTML shell regenerated. Unknown ids
 * are treated as runtime:true (safe — they were already rejected by validation
 * upstream, this is only consulted on the validated id set).
 */
export function featuresRequireRemint(
  featureIds: string[],
  scope: FeatureScope = 'shop'
): boolean {
  const registry = registryFor(scope);
  const byId = new Map<string, FeatureDef>();
  for (const f of registry) byId.set(f.id, f);
  for (const id of featureIds) {
    const def = byId.get(id.trim().toLowerCase());
    // runtime === false means the feature injects net-new HTML the deployed
    // shell can't express ⇒ re-mint. Absent/true ⇒ pure runtime flag.
    if (def && def.runtime === false) return true;
  }
  return false;
}

/** Parse a stored/patched features CSV → id[] (for the re-mint decision). */
export function parseFeatureCsv(csv: unknown): string[] {
  if (typeof csv !== 'string') return [];
  return csv
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}
