import { artifactStore } from '@affine/core/modules/ai-artifacts/store';
import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import {
  type CSSProperties,
  type PropsWithChildren,
  type ReactNode,
  useEffect,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// ClickDz ShopERP — shared palette, small inline-styled helpers, and the thin
// API layer that talks to the REAL /api/v1/apps/* routes. DARK by default,
// mirroring the Integrations page scaffold (ViewTitle/…/ViewBody + inline
// styles, no i18n, no new .css.ts). Everything here is client-side glue: the
// wizard and management views compose these primitives; nothing is faked.
// ---------------------------------------------------------------------------

// Dark, app-consistent palette. Each value is an --affine-* theme var with a
// hard dark fallback so the surface reads correctly before theme vars load.
export const C = {
  bg: 'var(--affine-background-primary-color, #141414)',
  panel: 'var(--affine-background-secondary-color, #1c1c1e)',
  panel2: 'var(--affine-background-tertiary-color, #232326)',
  border: 'var(--affine-border-color, #2a2a2c)',
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  accentSoft:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  warnBg: 'color-mix(in srgb, #e8a33d 12%, transparent)',
  warnBorder: 'color-mix(in srgb, #e8a33d 40%, transparent)',
  errBg: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 12%, transparent)',
  errBorder:
    'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 40%, transparent)',
  okText: 'var(--affine-success-color, #4cae4c)',
} as const;

// ---------------------------------------------------------------------------
// API layer — thin wrappers over the real backend routes. Each returns a
// discriminated result so callers can render loading / error / empty / 409
// (publish cap) states without guessing.
// ---------------------------------------------------------------------------

export type AppKind = 'shop' | 'erp' | 'app';

/** A published app as returned by GET /api/v1/apps/mine (C5 adds kind/storeSlug). */
export interface MineApp {
  slug: string;
  url: string;
  createdAt: string;
  kind?: AppKind;
  storeSlug?: string;
}

/** Creation-time settings, mirrors the C5 backend contract. */
export interface ShopSettings {
  storeName: string;
  whatsapp: string;
  accentColor: string;
  adminPin: string;
}

/** The template response shape (subset we consume). */
export interface TemplateResult {
  slug: string;
  storeSlug: string;
  kind: AppKind;
  html: string;
  bytes?: number;
}

/** A deployed app (subset). */
export interface DeployResult {
  url: string;
  state?: string;
}

/** The 409 publish-cap body the deploy route emits. */
export interface PublishCapInfo {
  limit: number;
  existing: Array<{ slug: string; url: string }>;
}

// Discriminated deploy outcomes so the caller can branch on the cap explicitly.
export type DeployOutcome =
  | { status: 'ok'; result: DeployResult }
  | { status: 'cap'; info: PublishCapInfo }
  | { status: 'upgrade' }
  | { status: 'error'; message: string };

/** GET the caller's published apps. Throws only on network failure. */
export async function fetchMyApps(): Promise<MineApp[]> {
  const res = await fetch(cdzApiUrl('/api/v1/apps/mine'), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Impossible de charger vos applications (${res.status})`);
  }
  const data = (await res.json().catch(() => ({}))) as { apps?: MineApp[] };
  const apps = Array.isArray(data.apps) ? data.apps : [];
  return apps.map(a => ({
    slug: String(a.slug || ''),
    url: String(a.url || ''),
    createdAt: String(a.createdAt || ''),
    ...(a.kind ? { kind: a.kind } : {}),
    ...(a.storeSlug ? { storeSlug: a.storeSlug } : {}),
  }));
}

/**
 * Catalog metadata for one shop template (WS4-5 picker). Mirrors the
 * GET /api/v1/apps/templates item shape — metadata ONLY (id/name/darja/
 * vertical/emoji/accent/gradient/hero), never the seed products. Every field
 * past `id` is optional so the picker renders defensively against an older or
 * partial server.
 */
export interface ShopTemplateMeta {
  id: string;
  name: string;
  /** Darja label shown as the card subtitle (RTL). */
  nameDarja?: string;
  vertical: string;
  /** Emoji glyph for the gallery card. */
  emoji?: string;
  /** Hex accent for the card swatch + badge (→ __CLICKDZ_ACCENT__ at mint). */
  accent?: string;
  /** Two-stop gradient for the card thumb; falls back to the accent. */
  gradient?: [string, string];
  /** One-line hero preview (darja or FR per vertical). */
  heroLine?: string;
}

/**
 * GET /api/v1/apps/templates — the vertical catalog for the wizard picker.
 * Additive + fail-soft: the endpoint only exists when CDZ_TEMPLATE_CATALOG is
 * ON, so a 404 (flag OFF / older server), an error, or an empty list all resolve
 * to `[]`. The picker treats `[]` as "no catalog" and skips its step, preserving
 * the exact pre-catalog wizard flow. NEVER throws — returns `[]` on any failure.
 */
export async function fetchShopTemplates(): Promise<ShopTemplateMeta[]> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl('/api/v1/apps/templates'), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return [];
  }
  if (!res.ok) {
    // 404 = catalog flag OFF / route absent → no picker (fall back to today).
    return [];
  }
  const data = (await res.json().catch(() => null)) as
    | { templates?: unknown }
    | unknown[]
    | null;
  // Tolerate both { templates: [...] } and a bare [...] payload.
  const raw = Array.isArray(data)
    ? data
    : Array.isArray((data as { templates?: unknown })?.templates)
      ? ((data as { templates?: unknown }).templates as unknown[])
      : [];
  const out: ShopTemplateMeta[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const id = typeof t.id === 'string' ? t.id : '';
    const name = typeof t.name === 'string' ? t.name : '';
    if (!id || !name) continue;
    const gradient =
      Array.isArray(t.gradient) &&
      t.gradient.length === 2 &&
      typeof t.gradient[0] === 'string' &&
      typeof t.gradient[1] === 'string'
        ? ([String(t.gradient[0]), String(t.gradient[1])] as [string, string])
        : undefined;
    out.push({
      id,
      name,
      vertical: typeof t.vertical === 'string' ? t.vertical : '',
      ...(typeof t.nameDarja === 'string' ? { nameDarja: t.nameDarja } : {}),
      ...(typeof t.emoji === 'string' ? { emoji: t.emoji } : {}),
      ...(typeof t.accent === 'string' ? { accent: t.accent } : {}),
      ...(gradient ? { gradient } : {}),
      ...(typeof t.heroLine === 'string' ? { heroLine: t.heroLine } : {}),
    });
  }
  return out;
}

/**
 * POST /api/v1/apps/template. `settings` is optional; when present it maps to
 * the C5 body. A 400 invalid_settings surfaces the offending field so the
 * wizard can point at the right step (defensive — the wizard validates first).
 */
export async function fetchTemplate(body: {
  templateId?: string;
  kind: 'shop' | 'erp';
  storeSlug?: string;
  settings?: Partial<ShopSettings>;
}): Promise<TemplateResult> {
  const res = await fetch(cdzApiUrl('/api/v1/apps/template'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | (Partial<TemplateResult> & { error?: string; field?: string })
    | null;
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Veuillez vous connecter pour créer une boutique.');
    }
    if (data?.error === 'invalid_settings') {
      throw new Error(
        `Le champ ${data.field || 'valeur'} n’est pas valide — veuillez le vérifier et réessayer.`
      );
    }
    throw new Error(`Création échouée (${res.status}).`);
  }
  const slug = typeof data?.slug === 'string' ? data.slug : '';
  const html = typeof data?.html === 'string' ? data.html : '';
  if (!slug || !html) {
    throw new Error('La réponse du gabarit était incomplète. Veuillez réessayer.');
  }
  return {
    slug,
    storeSlug: typeof data?.storeSlug === 'string' ? data.storeSlug : slug,
    kind: (data?.kind as AppKind) || body.kind,
    html,
    ...(typeof data?.bytes === 'number' ? { bytes: data.bytes } : {}),
  };
}

/**
 * POST /api/v1/apps/deploy. Publishes reviewed HTML under `slug`; forwards the
 * optional C5 kind/storeSlug so the publish record is labeled + paired.
 * `replaceSlug` frees a slot first (the cap-replace flow). Never throws for the
 * documented 402/409 — those come back as typed outcomes.
 */
export async function deployApp(body: {
  html: string;
  slug: string;
  kind?: 'shop' | 'erp';
  storeSlug?: string;
  replaceSlug?: string;
}): Promise<DeployOutcome> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl('/api/v1/apps/deploy'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors de la publication.') };
  }
  const data = (await res.json().catch(() => null)) as
    | {
        url?: string;
        deploymentUrl?: string;
        state?: string;
        error?: string | { message?: string };
        limit?: number;
        existing?: Array<{ slug: string; url: string }>;
      }
    | null;
  if (res.status === 409 && (data?.error as string) === 'publish_limit_reached') {
    return {
      status: 'cap',
      info: {
        limit: typeof data?.limit === 'number' ? data.limit : 1,
        existing: Array.isArray(data?.existing) ? data.existing : [],
      },
    };
  }
  if (res.status === 402 || (data?.error as string) === 'upgrade_required') {
    return { status: 'upgrade' };
  }
  if (!res.ok) {
    const msg =
      typeof data?.error === 'object' && data.error?.message
        ? data.error.message
        : `Publication échouée (${res.status}).`;
    return { status: 'error', message: msg };
  }
  const url = String(data?.url || data?.deploymentUrl || '');
  return { status: 'ok', result: { url, state: data?.state } };
}

/** DELETE /api/v1/apps/:slug. Returns true on success (or already-gone 404). */
export async function deleteApp(slug: string): Promise<boolean> {
  const res = await fetch(
    cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}`),
    { method: 'DELETE', headers: { Accept: 'application/json' } }
  );
  // 404 means it's already gone from the caller's set — treat as success so the
  // UI converges (the row disappears either way).
  return res.ok || res.status === 404;
}

// ---------------------------------------------------------------------------
// ERP data layer — the in-app dashboard reads the SAME live data the deployed
// shop writes. Summary + admin mutations go through the authed owner-only
// bridge routes (/api/v1/apps/:slug/erp/*); full collection reads use the
// public per-slug data API (GET needs no token, same origin). The order/
// product/settings shapes mirror the shop + ERP templates exactly — status
// strings are the ACCENTED French values ('Livrée', not 'Livree') and product
// titles tolerate both `title` (shop) and `name` (ERP) fields.
// ---------------------------------------------------------------------------

/** The five order pipeline states — exact accented strings from the templates. */
export const ORDER_STATUSES = [
  'Nouvelle',
  'Confirmée',
  'Expédiée',
  'Livrée',
  'Retournée',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Forward flow; 'Retournée' is reachable from any state as the return branch. */
export const NEXT_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  Nouvelle: 'Confirmée',
  'Confirmée': 'Expédiée',
  'Expédiée': 'Livrée',
};

/** Per-status colors (mirrors the ERP template's info/brand/violet/ok/bad). */
export const STATUS_COLORS: Record<OrderStatus, string> = {
  Nouvelle: '#38bdf8',
  'Confirmée': '#2f6bff',
  'Expédiée': '#8b5cf6',
  'Livrée': '#22c55e',
  'Retournée': '#ef4444',
};

/** Valid status-advance targets from a given state (forward + return branch). */
export function statusTargets(status: string | undefined): OrderStatus[] {
  const out: OrderStatus[] = [];
  const next = NEXT_STATUS[status as OrderStatus];
  if (next) out.push(next);
  if (status && status !== 'Retournée') out.push('Retournée');
  return out;
}

export interface ErpSettings {
  key?: string;
  shopName?: string;
  tagline?: string;
  /**
   * HERO-1 — the line under the shop name in the storefront hero. The deployed
   * template has always read this (falling back to `tagline`); it only became
   * writable when the bridge grew a validation branch for it.
   */
  heroLine?: string;
  whatsapp?: string;
  deliveryFee?: number;
  adminPin?: string;
  accent?: string;
  currency?: string;
  // C7 appearance fields — preset IDs (never raw CSS). The bridge allowlist
  // (normalizeErpSettings + POST /erp/settings) validates these against the
  // same id sets below; SHOP-TEMPLATE maps each id to its :root vars/layout at
  // runtime. All optional: a legacy singleton omits them and renders today's
  // look (theme 'classic' / template 'standard' / font 'system' / all sections).
  theme?: string;
  template?: string;
  font?: string;
  /** Compact CSV of enabled section ids, e.g. 'hero,trust,categories'. */
  sections?: string;
  /**
   * Compact CSV of enabled FEATURE ids — the same shape as `sections`.
   *
   * The backend has always stored and returned this (its settings normalizer
   * carries `row.features` through as a <=500-char string, and /customize
   * writes it), but the type never declared the field — so `shop-features.tsx`
   * read `settings.features` and failed to typecheck.
   */
  features?: string;
  /** Corner style id; 'auto' (default) keeps the theme preset's radius. */
  radius?: string;
  // C6 online-payments flag — NON-sensitive (the Chargily SECRET lives in a
  // private Redis store, never here). When true the deployed storefront shows a
  // "Payer en ligne" option (SHOPTPL gates on this); the bridge allowlist
  // (normalizeErpSettings) validates it. Unset/false = cash-on-delivery only.
  onlinePay?: boolean;
  // WSE-9 (COMPTOIR) — CSV of enabled published-ERP module ids
  // (factures|livraison|caisse). Rides the settings singleton; the studio
  // "Afficher dans l'app" toggles add/remove an id here (postErpBackends).
  erpBackends?: string;
  staffAuth?: string;
  sellerName?: string;
  sellerRc?: string;
  sellerNif?: string;
  sellerNis?: string;
  sellerArt?: string;
  sellerAddress?: string;
  sellerPhone?: string;
}

export interface ErpOrderItem {
  id?: string;
  title?: string;
  name?: string;
  product?: string;
  price?: number;
  qty?: number;
}

export interface ErpOrder {
  id?: string;
  ref?: string;
  status?: string;
  customer?: string;
  phone?: string;
  wilaya?: string;
  commune?: string;
  address?: string;
  note?: string;
  items?: ErpOrderItem[];
  subtotal?: number;
  deliveryFee?: number;
  total?: number;
  orderedAt?: string;
  date?: string;
  createdAt?: string;
  type?: string;
}

export interface ErpProduct {
  id?: string;
  type?: string;
  sku?: string;
  title?: string;
  name?: string;
  price?: number;
  stock?: number;
  reorderAt?: number;
  category?: string;
  description?: string;
  imageUrl?: string;
  active?: boolean;
  createdAt?: string;
}

export interface ErpKpis {
  revenueMonth: number;
  pendingCount: number;
  avgBasket: number;
  expensesMonth: number;
  margin: number;
  lowStockCount: number;
  ordersTotal: number;
}

/** GET /api/v1/apps/:slug/erp/summary response (C6 contract). */
export interface ErpSummary {
  settings: ErpSettings;
  currency: string;
  kpis: ErpKpis;
  ordersByStatus: Record<string, number>;
  revenueByDay: Array<{ date: string; revenue: number }>;
  lowStock: ErpProduct[];
  recentOrders: ErpOrder[];
  topProducts: Array<{ title: string; qty: number; revenue: number }>;
}

/** Coerce anything numeric-ish to a finite number (template `num()` mirror). */
export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** `fmtDZD` mirror: rounded fr-DZ grouping + currency suffix (always DZD). */
export function fmtDZD(v: number, currency = 'DZD'): string {
  const n = Math.round(num(v));
  let s: string;
  try {
    s = n.toLocaleString('fr-DZ');
  } catch {
    s = String(n);
  }
  return `${s} ${currency}`;
}

/** Template `orderTotal()` mirror — total field, else sum of items. */
export function orderTotal(o: ErpOrder): number {
  if (o.total != null && Number.isFinite(Number(o.total))) return num(o.total);
  const items = Array.isArray(o.items) ? o.items : [];
  return items.reduce(
    (s, it) => s + num(it.price) * (it.qty != null ? num(it.qty) : 1),
    0
  );
}

/** Template `parseDate()` mirror — stable business date, YYYY-MM-DD. */
export function orderDate(o: ErpOrder): string {
  return String(o.orderedAt || o.date || o.createdAt || '').slice(0, 10);
}

/** Shop products use `title`, ERP products use `name` — read both. */
export function productTitle(p: ErpProduct): string {
  return String(p.title || p.name || 'Article');
}

/** A product is low when stock ≤ reorderAt (and a threshold is set). */
export function isLowStock(p: ErpProduct): boolean {
  return p.reorderAt != null && num(p.stock) <= num(p.reorderAt);
}

export type ErpSummaryOutcome =
  | { status: 'ok'; summary: ErpSummary; offline?: boolean; cachedAt?: number }
  | { status: 'error'; message: string };

/** GET the authed per-shop ERP summary (KPIs, charts, recent orders…). */
export async function fetchErpSummary(slug: string): Promise<ErpSummaryOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/summary`),
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
  } catch {
    // Offline / network failure: serve the last cached summary if we have
    // one, rather than blanking the dashboard.
    const cached = readErpCache<ErpSummary>(slug, 'summary');
    if (cached) {
      setOfflineHit({ slug, cachedAt: cached.cachedAt });
      return {
        status: 'ok',
        summary: cached.data,
        offline: true,
        cachedAt: cached.cachedAt,
      };
    }
    return {
      status: 'error',
      message: netErrorMessage('Erreur réseau lors du chargement du tableau de bord.'),
    };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<ErpSummary> & { message?: string })
    | null;
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous connecter pour voir ce tableau de bord.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : res.status === 404
            ? 'Cette boutique est introuvable — elle a peut-être été supprimée.'
            : typeof data?.message === 'string'
              ? data.message
              : `Impossible de charger le tableau de bord (${res.status}).`;
    return { status: 'error', message };
  }
  const kpis = (data?.kpis ?? {}) as Partial<ErpKpis>;
  const summary: ErpSummary = {
    settings: (data?.settings && typeof data.settings === 'object'
      ? data.settings
      : {}) as ErpSettings,
    currency:
      typeof data?.currency === 'string' && data.currency
        ? data.currency
        : 'DZD',
    kpis: {
      revenueMonth: num(kpis.revenueMonth),
      pendingCount: num(kpis.pendingCount),
      avgBasket: num(kpis.avgBasket),
      expensesMonth: num(kpis.expensesMonth),
      margin: num(kpis.margin),
      lowStockCount: num(kpis.lowStockCount),
      ordersTotal: num(kpis.ordersTotal),
    },
    ordersByStatus: (data?.ordersByStatus &&
    typeof data.ordersByStatus === 'object'
      ? data.ordersByStatus
      : {}) as Record<string, number>,
    revenueByDay: Array.isArray(data?.revenueByDay) ? data.revenueByDay : [],
    lowStock: Array.isArray(data?.lowStock) ? data.lowStock : [],
    recentOrders: Array.isArray(data?.recentOrders) ? data.recentOrders : [],
    topProducts: Array.isArray(data?.topProducts) ? data.topProducts : [],
  };
  cacheErpGet(slug, 'summary', summary);
  clearOfflineHit();
  return {
    status: 'ok',
    summary,
  };
}

/**
 * GET a full collection through the owner-authenticated bridge route.
 * Newest-first, capped at 500.
 *
 * SEC-2: this used to read the data API's @Public GET directly, with no
 * credential. That works only while CDZ_DATA_READ_GATE is off — and while it is
 * off, anyone who knows a shop slug can dump that shop's `orders` and
 * `customers`, i.e. Algerian buyers' phone numbers and street addresses. Slugs
 * are public by construction; they appear in every storefront URL.
 *
 * The gate could not be switched on while the studio read anonymously, because
 * all 8 sensitive-collection reads across 5 panels (orders, customers, creances)
 * would have started 401-ing and every ERP panel would have blanked. So reads now
 * go through GET /api/v1/apps/:slug/erp/collections/:collection, which asserts
 * app ownership from the session and re-derives the per-slug token server-side —
 * the mirror image of the SEC-1 write route. The token never reaches the browser.
 */
export async function fetchErpCollection<T = Record<string, unknown>>(
  storeSlug: string,
  collection: string
): Promise<T[]> {
  const cacheResource = `collections/${collection}`;
  try {
    const res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(storeSlug)}/erp/collections/${encodeURIComponent(collection)}`
      ),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      }
    );
    if (!res.ok) {
      throw new Error(`Impossible de charger ${collection} (${res.status})`);
    }
    const data = (await res.json().catch(() => null)) as unknown;
    // The bridge wraps its payload as { ok, records } (the house shape for
    // owner-gated ERP routes); the old data-API route returned a bare array. Accept
    // both so this helper stays correct whichever route it is pointed at.
    let rows: T[];
    if (Array.isArray(data)) {
      rows = data as T[];
    } else {
      const records = (data as { records?: unknown } | null)?.records;
      rows = Array.isArray(records) ? (records as T[]) : [];
    }
    cacheErpGet(storeSlug, cacheResource, rows);
    clearOfflineHit();
    return rows;
  } catch (err) {
    // Network failure (offline) — fall back to the last cached copy of this
    // collection rather than throwing and blanking the panel. A non-network
    // error (e.g. the explicit `!res.ok` throw above) still surfaces as-is
    // when no cache exists.
    const cached = readErpCache<T[]>(storeSlug, cacheResource);
    if (cached) {
      setOfflineHit({ slug: storeSlug, cachedAt: cached.cachedAt });
      return cached.data;
    }
    throw err;
  }
}

// Admin mutations return a discriminated outcome; 'unavailable' means the
// server can't derive the write token (C6 fallback) → the UI goes read-only
// but keeps every read working.
export type ErpMutateOutcome<T> =
  | { status: 'ok'; data: T }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

async function erpMutate<T>(
  slug: string,
  path: 'order-status' | 'product' | 'settings',
  body: Record<string, unknown>
): Promise<ErpMutateOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/${path}`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été modifié.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown })
    | null;
  if (data?.error === 'admin_writes_unavailable') {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : res.status === 404
            ? 'Introuvable — cela a peut-être été modifié ailleurs. Actualisez et réessayez.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `La modification a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', data: data as T };
}

/** POST /erp/order-status — advance one order (delete+recreate by ref). */
export function postOrderStatus(
  slug: string,
  ref: string,
  status: OrderStatus
): Promise<ErpMutateOutcome<{ ok?: boolean; order?: ErpOrder }>> {
  return erpMutate(slug, 'order-status', { ref, status });
}

/** POST /erp/product — upsert a product by sku/title (delete+recreate). */
export function postErpProduct(
  slug: string,
  product: ErpProduct
): Promise<ErpMutateOutcome<{ ok?: boolean; product?: ErpProduct }>> {
  // The data API assigns fresh id/createdAt on recreate; business keys
  // (sku/title) drive the upsert, so never send stale identity fields.
  const { id: _id, createdAt: _createdAt, ...body } = product;
  return erpMutate(slug, 'product', { product: body });
}

/** POST /erp/settings — merge a patch into the settings singleton. */
export function postErpSettings(
  slug: string,
  patch: Partial<ErpSettings>
): Promise<ErpMutateOutcome<{ ok?: boolean; settings?: ErpSettings }>> {
  return erpMutate(slug, 'settings', { patch });
}

// ---------------------------------------------------------------------------
// WSF-2 CUSTOMIZE — the feature-aware wrapper over the settings primitive. The
// Fonctionnalités tab (shop-features.tsx) and AI chat edits both converge here:
//   POST /api/v1/apps/:slug/customize { features?, params?, appearance? }
//     → validates via the feature registry/allowlist → merges the settings
//       singleton → re-mints HTML (same slug) if a touched feature is
//       runtime:false → { ok, settings, remint, url? }
// Gated server-side by CDZ_FEATURES_ENABLED (default OFF) → a 404 means the
// flag is off on this server; callers quiet-gate to "bientôt disponible".
// `params` are scalars only (IDs/numbers/booleans) — never raw HTML — so the
// 8KB settings cap holds. Invalid ids/params come back via the passthrough-res
// body (like /erp/settings), surfaced as a typed 'error'.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WSE-3 FACTURATION — thin, typed client over the R2 invoicing bridge routes
// (all @CurrentUser-authed, owner-only, gated server-side by CDZ_ERP_INVOICING):
//   GET  /api/v1/apps/:slug/erp/invoices?month=YYYY-MM&type=&status=
//        → { invoices: InvoiceView[], partitionsRead }
//   GET  /api/v1/apps/:slug/erp/invoices/:id            → { invoice }
//   POST /api/v1/apps/:slug/erp/invoices                → { ok, invoice }
//        body { type, customer, lines, orderRef?, payment?, date? }
//   POST /api/v1/apps/:slug/erp/invoices/:id/validate   → { ok, invoice }
//   POST /api/v1/apps/:slug/erp/invoices/:id/void       → { ok, invoice }
//   POST /api/v1/apps/:slug/erp/invoices/:id/convert    → { ok, invoice }  {to}
// The FLAG-OFF contract: the whole route family 404s while CDZ_ERP_INVOICING is
// off → both list + mutate wrappers surface that as a distinct 'not-found'
// outcome so the page renders a quiet "activation en attente" state (never a
// crash). Money math (HT/TVA/timbre/TTC) is authored on the server — these
// wrappers ship a CLIENT-SIDE MIRROR (computeInvoiceLine/computeInvoiceDoc)
// for LIVE display in the editor ONLY; the server always recomputes on save.
// credentials:'include' matches the inventory/customize wrappers (session
// cookie). Reads use the same authed bridge route (NOT the public data API) so
// only the owner sees drafts. Everything fails soft — never throws for a
// documented HTTP status.
// ---------------------------------------------------------------------------

/** The three fiscal document kinds, in their legal conversion order. */
export const INVOICE_TYPES = ['devis', 'bl', 'facture'] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

/** Document lifecycle — numbering is assigned at VALIDATION, never at draft. */
export const INVOICE_STATUSES = ['brouillon', 'valide', 'annule'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Payment method carried on a facture (drives whether timbre applies).
 * LF2025: only `cash` and `cod` attract the timbre; ALL electronic methods
 * (chargily/Edahabia/CIB, virement, chèque, CCP) are EXEMPT.
 */
export const INVOICE_PAYMENTS = [
  'cash',
  'cod',
  'chargily',
  'virement',
  'cheque',
  'ccp',
  'edahabia',
  'cib',
] as const;
export type InvoicePayment = (typeof INVOICE_PAYMENTS)[number];

/** FR labels for the doc kinds (this surface is French where the shop is). */
export const INVOICE_TYPE_LABELS: Record<InvoiceType, string> = {
  devis: 'Devis',
  bl: 'Bon de livraison',
  facture: 'Facture',
};

/** FR labels for the statuses. */
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  brouillon: 'Brouillon',
  valide: 'Validée',
  annule: 'Annulée',
};

/** Per-status colors (mirrors the order STATUS_COLORS spirit). */
export const INVOICE_STATUS_COLORS: Record<InvoiceStatus, string> = {
  brouillon: '#9aa0a6',
  valide: '#22c55e',
  annule: '#ef4444',
};

/** FR labels for the payment methods. */
export const INVOICE_PAYMENT_LABELS: Record<InvoicePayment, string> = {
  cash: 'Espèces',
  cod: 'Paiement à la livraison',
  chargily: 'En ligne (Chargily)',
  virement: 'Virement bancaire',
  cheque: 'Chèque',
  ccp: 'CCP / Mandat',
  edahabia: 'Edahabia',
  cib: 'Carte CIB',
};

/** True when a payment method is electronic (LF2025 timbre-exempt). */
export const isElectronicPayment = (p: InvoicePayment | undefined): boolean =>
  p === 'chargily' ||
  p === 'virement' ||
  p === 'cheque' ||
  p === 'ccp' ||
  p === 'edahabia' ||
  p === 'cib';

/** Fiscal client block — RC/NIF/NIS/ART are the DZ legal identifiers. */
export interface InvoiceCustomer {
  name: string;
  rc?: string;
  nif?: string;
  nis?: string;
  art?: string;
  address?: string;
}

/** One invoice line. `lineHT`/`lineTVA` are server-computed (round-then-sum). */
export interface InvoiceLine {
  ref?: string;
  label: string;
  qty: number;
  unitHT: number;
  tvaRate: number;
  lineHT?: number;
  lineTVA?: number;
}

/** A stored invoice record — mirrors the R2 clickdz-erp-invoicing shape. */
export interface InvoiceView {
  id: string;
  type: InvoiceType;
  seq: number;
  year: number;
  date: string;
  customer: InvoiceCustomer;
  lines: InvoiceLine[];
  totalHT: number;
  totalTVA: number;
  timbre: number;
  totalTTC: number;
  status: InvoiceStatus;
  payment?: InvoicePayment;
  orderRef?: string;
  convertedFrom?: string;
  createdAt?: string;
  updatedAt?: string;
  [k: string]: unknown;
}

/** Default TVA rate (percent) — DZ standard 19% unless a line overrides it. */
export const INVOICE_DEFAULT_TVA = 19;

/**
 * LF2025 progressive timbre scale (Loi de Finances 2025, Art.100/258 quinquies).
 * Replaces the pre-2025 flat 1% capped at 10,000 DZD. Brackets by cash-amount:
 *   • 1%   on TTC ≤ 30,000 DZD
 *   • 1.5% on 30,000 < TTC ≤ 100,000 DZD
 *   • 2%   on TTC > 100,000 DZD
 * Floor 5 DZD retained; the 10,000 cap was REMOVED. Electronic payments are
 * EXEMPT (virement, chargily/Edahabia/CIB, chèque, CCP) — only cash + COD pay.
 * The scale is a config table so a future LF change is a data edit, not code.
 */
export interface TimbreBracket {
  upTo: number | null; // inclusive ceiling in DZD, or null = open-ended top
  rate: number; // percent
}
export const TIMBRE_SCALE_LF2025: readonly TimbreBracket[] = Object.freeze([
  { upTo: 30_000, rate: 1 },
  { upTo: 100_000, rate: 1.5 },
  { upTo: null, rate: 2 },
]);
/** Minimum timbre per cash invoice (DZD) — LF2025 unchanged floor. */
export const INVOICE_TIMBRE_MIN = 5;
/**
 * @deprecated legacy flat rate (pre-LF2025). Kept only for back-compat with
 * code that still reads a single rate; the ACTIVE rule is TIMBRE_SCALE_LF2025.
 */
export const INVOICE_TIMBRE_RATE = 1;
/**
 * @deprecated legacy cap (pre-LF2025, removed by LF2025). Kept as a no-op
 * reference; computeInvoiceDoc no longer applies it.
 */
export const INVOICE_TIMBRE_MAX = 10_000;
/** Belt-and-braces cap matching the server INVOICE_MAX_LINES (8KB record). */
export const INVOICE_MAX_LINES = 60;

/**
 * CLIENT-SIDE mirror of the backend per-line math (clickdz-erp-invoicing
 * computeLineTotals): lineHT = round(qty*unitHT); lineTVA = round(lineHT*rate/100).
 * Round-then-sum, integer DZD. FOR DISPLAY ONLY — the server recomputes on save.
 */
export function computeInvoiceLine(
  qty: number,
  unitHT: number,
  tvaRate: number
): { lineHT: number; lineTVA: number } {
  const q = num(qty);
  const u = Math.round(num(unitHT));
  const r = num(tvaRate);
  const lineHT = Math.round(q * u);
  const lineTVA = Math.round((lineHT * r) / 100);
  return { lineHT, lineTVA };
}

/**
 * CLIENT-SIDE mirror of the backend document math (computeInvoiceTotals +
 * computeTimbre): sum the ALREADY-ROUNDED line figures, then apply the LF2025
 * progressive timbre rule (facture + cash/cod only, bracket rate by base TTC,
 * floored at INVOICE_TIMBRE_MIN, NO cap, only when the base is positive).
 * Electronic payments are exempt. FOR DISPLAY ONLY — the server recomputes.
 */
export function computeInvoiceDoc(
  type: InvoiceType,
  lines: Array<{ qty: number; unitHT: number; tvaRate: number }>,
  payment: InvoicePayment | undefined,
  scale: readonly TimbreBracket[] = TIMBRE_SCALE_LF2025
): { totalHT: number; totalTVA: number; timbre: number; totalTTC: number } {
  let totalHT = 0;
  let totalTVA = 0;
  for (const l of lines) {
    const { lineHT, lineTVA } = computeInvoiceLine(l.qty, l.unitHT, l.tvaRate);
    totalHT += lineHT;
    totalTVA += lineTVA;
  }
  const baseTTC = totalHT + totalTVA;
  let timbre = 0;
  const isCash = payment === 'cash' || payment === 'cod';
  if (type === 'facture' && isCash && baseTTC > 0) {
    const bracket =
      scale.find((b) => b.upTo == null || baseTTC <= b.upTo) ??
      scale[scale.length - 1];
    const raw = Math.round((baseTTC * bracket.rate) / 100);
    timbre = Math.max(INVOICE_TIMBRE_MIN, raw);
  }
  return { totalHT, totalTVA, timbre, totalTTC: baseTTC + timbre };
}

/** Coerce a raw wire record into a well-typed InvoiceView (tolerant). */
function coerceInvoiceView(raw: unknown): InvoiceView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const type = String(r.type || '').toLowerCase();
  if (!(INVOICE_TYPES as readonly string[]).includes(type)) return null;
  const status = String(r.status || 'brouillon').toLowerCase();
  const custRaw = (r.customer && typeof r.customer === 'object'
    ? r.customer
    : {}) as Record<string, unknown>;
  const customer: InvoiceCustomer = {
    name: String(custRaw.name || ''),
  };
  for (const k of ['rc', 'nif', 'nis', 'art', 'address'] as const) {
    const v = custRaw[k];
    if (typeof v === 'string' && v) customer[k] = v;
  }
  const lines: InvoiceLine[] = Array.isArray(r.lines)
    ? (r.lines as unknown[]).map(lv => {
        const l = (lv && typeof lv === 'object' ? lv : {}) as Record<
          string,
          unknown
        >;
        const line: InvoiceLine = {
          label: String(l.label || ''),
          qty: num(l.qty),
          unitHT: num(l.unitHT),
          tvaRate: num(l.tvaRate),
          lineHT: num(l.lineHT),
          lineTVA: num(l.lineTVA),
        };
        if (typeof l.ref === 'string' && l.ref) line.ref = l.ref;
        return line;
      })
    : [];
  return {
    id: String(r.id || ''),
    type: type as InvoiceType,
    seq: num(r.seq),
    year: num(r.year),
    date: String(r.date || '').slice(0, 10),
    customer,
    lines,
    totalHT: num(r.totalHT),
    totalTVA: num(r.totalTVA),
    timbre: num(r.timbre),
    totalTTC: num(r.totalTTC),
    status: (INVOICE_STATUSES as readonly string[]).includes(status)
      ? (status as InvoiceStatus)
      : 'brouillon',
    ...(typeof r.payment === 'string' &&
    (INVOICE_PAYMENTS as readonly string[]).includes(r.payment)
      ? { payment: r.payment as InvoicePayment }
      : {}),
    ...(typeof r.orderRef === 'string' && r.orderRef
      ? { orderRef: r.orderRef }
      : {}),
    ...(typeof r.convertedFrom === 'string' && r.convertedFrom
      ? { convertedFrom: r.convertedFrom }
      : {}),
    ...(typeof r.createdAt === 'string' ? { createdAt: r.createdAt } : {}),
    ...(typeof r.updatedAt === 'string' ? { updatedAt: r.updatedAt } : {}),
  };
}

// List outcome: 'not-found' = the whole route family 404'd (flag CDZ_ERP_INVOICING
// off, or app absent) → the page shows the quiet activation state.
export type InvoiceListOutcome =
  | { status: 'ok'; invoices: InvoiceView[] }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/**
 * GET /erp/invoices — the month-scoped ledger view. `month` is YYYY-MM (the
 * backend collapses it to a one-month partition read); optional type/status
 * filters are validated server-side. A 404 (flag off / app not found) →
 * 'not-found'; a 502 data-API failure → a retryable 'error'. Never throws.
 */
export async function fetchInvoices(
  slug: string,
  query: { month?: string; type?: InvoiceType | ''; status?: InvoiceStatus | '' } = {}
): Promise<InvoiceListOutcome> {
  const qs = new URLSearchParams();
  if (query.month) qs.set('month', query.month);
  if (query.type) qs.set('type', query.type);
  if (query.status) qs.set('status', query.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(slug)}/erp/invoices${suffix}`
      ),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement des factures.') };
  }
  if (res.status === 404) {
    return { status: 'not-found' };
  }
  const data = (await res.json().catch(() => null)) as
    | { invoices?: unknown; error?: unknown; message?: unknown }
    | null;
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : data?.error === 'data_api_unavailable'
            ? 'Le service de données est momentanément indisponible — réessayez.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `Impossible de charger les factures (${res.status}).`;
    return { status: 'error', message };
  }
  const raw = Array.isArray(data?.invoices) ? (data.invoices as unknown[]) : [];
  const invoices: InvoiceView[] = [];
  for (const r of raw) {
    const inv = coerceInvoiceView(r);
    if (inv) invoices.push(inv);
  }
  return { status: 'ok', invoices };
}

export type InvoiceOneOutcome =
  | { status: 'ok'; invoice: InvoiceView }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/** GET /erp/invoices/:id — fetch one invoice by id. 404 → 'not-found'. */
export async function fetchInvoice(
  slug: string,
  id: string
): Promise<InvoiceOneOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(slug)}/erp/invoices/${encodeURIComponent(id)}`
      ),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement de la facture.') };
  }
  if (res.status === 404) {
    return { status: 'not-found' };
  }
  const data = (await res.json().catch(() => null)) as
    | { invoice?: unknown; message?: unknown }
    | null;
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible de charger la facture (${res.status}).`;
    return { status: 'error', message };
  }
  const inv = coerceInvoiceView(data?.invoice);
  if (!inv) {
    return { status: 'error', message: 'Réponse incomplète du serveur.' };
  }
  return { status: 'ok', invoice: inv };
}

// Mutation outcome. 'unavailable' = admin writes can't be signed (server can't
// derive the write token → read-only, like the other ERP mutations).
// 'not-found' = the route 404'd (flag off) OR the target invoice is gone.
// 'invalid' carries the machine `reason`+`field` so the form points at the bad
// input; 'conflict' carries a `reason` (invoice_not_draft / already_void / a
// convert conflict) so the UI explains why the transition was refused.
export type InvoiceMutateOutcome =
  | { status: 'ok'; invoice: InvoiceView }
  | { status: 'unavailable' }
  | { status: 'not-found' }
  | { status: 'invalid'; reason: string; field?: string }
  | { status: 'conflict'; reason: string }
  | { status: 'error'; message: string };

/** Shared POST helper for the invoice mutations — maps every documented body. */
async function invoiceMutate(
  slug: string,
  path: string,
  body: Record<string, unknown> | undefined
): Promise<InvoiceMutateOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/${path}`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body ?? {}),
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été modifié.') };
  }
  if (res.status === 404) {
    // Route missing (flag off) OR the target invoice/order was not found. Both
    // degrade to 'not-found'; the page decides whether to quiet-gate or refresh.
    return { status: 'not-found' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & {
        error?: unknown;
        reason?: unknown;
        field?: unknown;
        message?: unknown;
        invoice?: unknown;
      })
    | null;
  if (data?.error === 'admin_writes_unavailable') {
    return { status: 'unavailable' };
  }
  if (res.status === 400 && data?.error === 'invalid_invoice') {
    return {
      status: 'invalid',
      reason: String(data?.reason || 'invalid'),
      ...(typeof data?.field === 'string' ? { field: data.field } : {}),
    };
  }
  if (res.status === 409) {
    const reason =
      data?.error === 'invoice_not_draft'
        ? 'invoice_not_draft'
        : data?.error === 'invoice_already_void'
          ? 'invoice_already_void'
          : String(data?.reason || data?.error || 'conflict');
    return { status: 'conflict', reason };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : data?.error === 'data_api_unavailable' ||
              data?.error === 'data_write_failed'
            ? 'Le service de données est momentanément indisponible — réessayez.'
            : data?.error === 'data_rejected'
              ? 'Enregistrement refusé (trop volumineux ou invalide).'
              : typeof data?.message === 'string'
                ? (data.message as string)
                : `L’opération a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  const inv = coerceInvoiceView(data?.invoice);
  if (!inv) {
    return { status: 'error', message: 'Réponse incomplète du serveur.' };
  }
  return { status: 'ok', invoice: inv };
}

/** The create-invoice body (a draft). `orderRef` without `lines` mints from an order. */
export interface CreateInvoiceBody {
  type: InvoiceType;
  customer: InvoiceCustomer;
  lines?: Array<{
    ref?: string;
    label: string;
    qty: number;
    unitHT: number;
    tvaRate: number;
  }>;
  payment?: InvoicePayment;
  orderRef?: string;
  date?: string;
}

/** POST /erp/invoices — create a DRAFT (brouillon, no number yet). */
export function postInvoice(
  slug: string,
  body: CreateInvoiceBody
): Promise<InvoiceMutateOutcome> {
  return invoiceMutate(slug, 'invoices', body as unknown as Record<string, unknown>);
}

/** POST /erp/invoices/:id/validate — assign the gap-less legal number. */
export function validateInvoice(
  slug: string,
  id: string
): Promise<InvoiceMutateOutcome> {
  return invoiceMutate(
    slug,
    `invoices/${encodeURIComponent(id)}/validate`,
    undefined
  );
}

/** POST /erp/invoices/:id/void — mark a document annulée (never deleted). */
export function voidInvoice(
  slug: string,
  id: string
): Promise<InvoiceMutateOutcome> {
  return invoiceMutate(
    slug,
    `invoices/${encodeURIComponent(id)}/void`,
    undefined
  );
}

/** POST /erp/invoices/:id/convert — devis→bl→facture (or the legal skip). */
export function convertInvoice(
  slug: string,
  id: string,
  to: InvoiceType
): Promise<InvoiceMutateOutcome> {
  return invoiceMutate(slug, `invoices/${encodeURIComponent(id)}/convert`, {
    to,
  });
}

// ---------------------------------------------------------------------------
// WSE-5 PROCUREMENT — Fournisseurs + Bons de commande. Thin typed wrappers over
// the R2-b authed owner-only bridge routes (credentials:'include', same shape
// as fetchErpSummary / erpMutate). Reads never throw; mutations return a
// discriminated ErpMutateOutcome-style union ('unavailable' = 501
// admin_writes_unavailable → the caller goes read-only). Records mirror the
// clickdz-erp-procurement contract exactly:
//   supplier { id, name, phone, email?, address?, balance, active, createdAt }
//   PO       { id 'po-YYYY-seq', supplierId, date, status, lines[], totalCost,
//              warehouseId?, note, createdAt }
//   PO line  { productId?, label, qty, qtyReceived, unitCost }
// ---------------------------------------------------------------------------

/** A procurement supplier (reference data). balance = dette we owe (DZD). */
export interface ProcSupplier {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  balance: number;
  active: boolean;
  createdAt?: string;
}

/** One purchase-order line (qty ordered vs qtyReceived + unit purchase cost). */
export interface ProcPurchaseOrderLine {
  productId?: string;
  label: string;
  qty: number;
  qtyReceived: number;
  unitCost: number;
}

/** A purchase order. status ∈ brouillon|commande|recu-partiel|recu|annule. */
export interface ProcPurchaseOrder {
  id: string;
  supplierId: string;
  date?: string;
  status: string;
  lines: ProcPurchaseOrderLine[];
  totalCost: number;
  warehouseId?: string;
  note?: string;
  createdAt?: string;
}

/** French labels for the PO status vocabulary (mirrors PROC_PO_STATUSES). */
export const PO_STATUS_LABELS: Record<string, string> = {
  brouillon: 'Brouillon',
  commande: 'Commandé',
  'recu-partiel': 'Reçu partiel',
  recu: 'Reçu',
  annule: 'Annulé',
};

/** Status → chip color (draft grey, ordered blue, partial amber, done green). */
export function poStatusColor(status: string): string {
  switch (status) {
    case 'commande':
      return '#38bdf8';
    case 'recu-partiel':
      return '#e8a33d';
    case 'recu':
      return '#22c55e';
    case 'annule':
      return '#ef4444';
    default:
      return '#9aa0a6';
  }
}

/** Coerce a raw record into the normalized ProcSupplier shape (defensive). */
function normalizeSupplier(raw: unknown): ProcSupplier {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: String(s.id ?? ''),
    name: String(s.name ?? ''),
    phone: String(s.phone ?? ''),
    ...(s.email ? { email: String(s.email) } : {}),
    ...(s.address ? { address: String(s.address) } : {}),
    balance: num(s.balance),
    active: s.active !== false,
    ...(s.createdAt ? { createdAt: String(s.createdAt) } : {}),
  };
}

/** Coerce a raw record into the normalized ProcPurchaseOrder shape (defensive). */
function normalizePurchaseOrder(raw: unknown): ProcPurchaseOrder {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawLines = Array.isArray(p.lines) ? (p.lines as unknown[]) : [];
  const lines: ProcPurchaseOrderLine[] = rawLines.map(item => {
    const l = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const productId = String(l.productId ?? '').trim();
    return {
      ...(productId ? { productId } : {}),
      label: String(l.label ?? productId ?? ''),
      qty: num(l.qty),
      qtyReceived: num(l.qtyReceived),
      unitCost: num(l.unitCost),
    };
  });
  return {
    id: String(p.id ?? ''),
    supplierId: String(p.supplierId ?? ''),
    ...(p.date ? { date: String(p.date) } : {}),
    status: String(p.status ?? 'brouillon'),
    lines,
    totalCost: num(p.totalCost),
    ...(p.warehouseId ? { warehouseId: String(p.warehouseId) } : {}),
    ...(p.note ? { note: String(p.note) } : {}),
    ...(p.createdAt ? { createdAt: String(p.createdAt) } : {}),
  };
}

export type SuppliersOutcome =
  | { status: 'ok'; suppliers: ProcSupplier[] }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** GET /erp/suppliers — list suppliers (newest-first). Never throws. */
export async function fetchSuppliers(slug: string): Promise<SuppliersOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/suppliers`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement des fournisseurs.') };
  }
  const data = (await res.json().catch(() => null)) as
    | { suppliers?: unknown; error?: unknown; message?: unknown }
    | null;
  if (res.status === 404 || res.status === 501) return { status: 'unavailable' };
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible de charger les fournisseurs (${res.status}).`;
    return { status: 'error', message };
  }
  const rows = Array.isArray(data?.suppliers) ? (data!.suppliers as unknown[]) : [];
  return { status: 'ok', suppliers: rows.map(normalizeSupplier).filter(s => s.id) };
}

export type SupplierMutateOutcome =
  | { status: 'ok'; supplier: ProcSupplier }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/**
 * Upsert a supplier. With `editId` → PUT /erp/suppliers/:id (edit in place);
 * without → POST /erp/suppliers (create by kebab-slug of the name). Body is
 * `{ supplier }`; partial edits preserve balance/createdAt server-side.
 */
export async function saveSupplier(
  slug: string,
  supplier: {
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    active?: boolean;
  },
  editId?: string
): Promise<SupplierMutateOutcome> {
  let res: Response;
  const url = editId
    ? cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(slug)}/erp/suppliers/${encodeURIComponent(editId)}`
      )
    : cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/suppliers`);
  try {
    res = await fetch(url, {
      method: editId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ supplier }),
    });
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — aucune modification enregistrée.') };
  }
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; supplier?: unknown; error?: unknown; message?: unknown }
    | null;
  if (data?.error === 'admin_writes_unavailable' || res.status === 501) {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : res.status === 404
            ? 'Fournisseur introuvable — actualisez et réessayez.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `L’enregistrement a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', supplier: normalizeSupplier(data?.supplier) };
}

export type PurchaseOrdersOutcome =
  | { status: 'ok'; purchaseOrders: ProcPurchaseOrder[] }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** GET /erp/purchase-orders — list POs (newest-first). Never throws. */
export async function fetchPurchaseOrders(slug: string): Promise<PurchaseOrdersOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/purchase-orders`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement des bons de commande.') };
  }
  const data = (await res.json().catch(() => null)) as
    | { purchaseOrders?: unknown; error?: unknown; message?: unknown }
    | null;
  if (res.status === 404 || res.status === 501) return { status: 'unavailable' };
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible de charger les bons de commande (${res.status}).`;
    return { status: 'error', message };
  }
  const rows = Array.isArray(data?.purchaseOrders)
    ? (data!.purchaseOrders as unknown[])
    : [];
  return { status: 'ok', purchaseOrders: rows.map(normalizePurchaseOrder).filter(p => p.id) };
}

export type PurchaseOrderOutcome =
  | { status: 'ok'; purchaseOrder: ProcPurchaseOrder }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** GET /erp/purchase-orders/:id — fetch one PO (freshest received state). */
export async function fetchPurchaseOrder(
  slug: string,
  id: string
): Promise<PurchaseOrderOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(slug)}/erp/purchase-orders/${encodeURIComponent(id)}`
      ),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement du bon.') };
  }
  const data = (await res.json().catch(() => null)) as
    | { purchaseOrder?: unknown; error?: unknown; message?: unknown }
    | null;
  if (res.status === 501) return { status: 'unavailable' };
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : res.status === 404
            ? 'Bon de commande introuvable.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `Impossible de charger le bon (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', purchaseOrder: normalizePurchaseOrder(data?.purchaseOrder) };
}

/**
 * POST /erp/purchase-orders — create a PO. BODY `{ supplierId, lines:[{label,
 * qty, unitCost, productId?}], note?, warehouseId?, date?, status? }`. The
 * server mints the gap-less `po-YYYY-seq` id and computes totalCost.
 */
export async function createPurchaseOrder(
  slug: string,
  body: {
    supplierId: string;
    lines: Array<{ label: string; qty: number; unitCost: number; productId?: string }>;
    note?: string;
    warehouseId?: string;
    date?: string;
  }
): Promise<PurchaseOrderOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/purchase-orders`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — le bon n’a pas été créé.') };
  }
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; purchaseOrder?: unknown; error?: unknown; message?: unknown }
    | null;
  if (data?.error === 'admin_writes_unavailable' || res.status === 501) {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : res.status === 404
            ? 'Fournisseur introuvable — actualisez et réessayez.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `La création du bon a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', purchaseOrder: normalizePurchaseOrder(data?.purchaseOrder) };
}

export type ReceivePurchaseOrderOutcome =
  | {
      status: 'ok';
      purchaseOrder: ProcPurchaseOrder;
      /** Count of stock movements the backend posted to the ledger. */
      movements: number;
      /** The supplier's new balance (dette) after the receive, when returned. */
      supplierBalance?: number;
    }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/**
 * POST /erp/purchase-orders/:id/receive — receive stock. BODY `{ lines:[{label
 * |productId, qty}], warehouseId? }` (empty/absent lines ⇒ receive ALL). The
 * server posts real 'purchase' movements through the inventory ledger, updates
 * the PO in place, and bumps the supplier balance by the received cost.
 */
export async function receivePurchaseOrder(
  slug: string,
  id: string,
  body: {
    lines?: Array<{ label?: string; productId?: string; qty: number }>;
    warehouseId?: string;
  }
): Promise<ReceivePurchaseOrderOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(slug)}/erp/purchase-orders/${encodeURIComponent(id)}/receive`
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — la réception n’a pas été enregistrée.') };
  }
  const data = (await res.json().catch(() => null)) as
    | {
        ok?: boolean;
        purchaseOrder?: unknown;
        movements?: unknown;
        supplierBalance?: unknown;
        error?: unknown;
        message?: unknown;
      }
    | null;
  if (data?.error === 'admin_writes_unavailable' || res.status === 501) {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : res.status === 404
            ? 'Bon ou entrepôt introuvable — actualisez et réessayez.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `La réception a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return {
    status: 'ok',
    purchaseOrder: normalizePurchaseOrder(data?.purchaseOrder),
    movements: num(data?.movements),
    ...(data?.supplierBalance !== undefined
      ? { supplierBalance: num(data.supplierBalance) }
      : {}),
  };
}

/** POST /erp/purchase-orders/:id/cancel — cancel a brouillon/commande PO. */
export async function cancelPurchaseOrder(
  slug: string,
  id: string
): Promise<PurchaseOrderOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(slug)}/erp/purchase-orders/${encodeURIComponent(id)}/cancel`
      ),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — le bon n’a pas été annulé.') };
  }
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; purchaseOrder?: unknown; error?: unknown; message?: unknown }
    | null;
  if (data?.error === 'admin_writes_unavailable' || res.status === 501) {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : res.status === 404
            ? 'Bon de commande introuvable.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `L’annulation a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', purchaseOrder: normalizePurchaseOrder(data?.purchaseOrder) };
}
/** A scalar feature param — IDs / numbers / booleans only (8KB-cap safe). */
// ---------------------------------------------------------------------------
// WSE-7 (R3-c, BOUSSOLE) — LIVRAISON studio API layer. Thin wrappers over the
// R2 shipping bridge routes (all owner-only, first-party session cookie via
// credentials:'include', mirroring customizeApp). Record shapes are PINNED by
// the pure module `clickdz-erp-shipping.ts` (Courier / ShippingRate / MatrixRow
// / Wilaya / TrackingStatus) — do NOT rename fields. Every mutation returns an
// ErpMutateOutcome-style discriminated union so the studio page can render
// loading / error / empty / read-only (admin_writes_unavailable) states without
// guessing. Reads never throw for a documented status — they resolve to typed
// outcomes.
// ---------------------------------------------------------------------------

/** Courier record (collection `couriers`, pinned by clickdz-erp-shipping.ts). */
export interface ShipCourier {
  id: string;
  name: string;
  phone?: string;
  active: boolean;
  codFee?: number;
  createdAt?: string;
}

/** One Algerian wilaya — official code (1-58) + French name (from the endpoint). */
export interface ShipWilaya {
  code: number;
  name: string;
}

/** A dense matrix row for the 58-wilaya grid (missing rows → null fees). */
export interface ShipMatrixRow {
  wilaya: number;
  name: string;
  fee: number | null;
  homeFee: number | null;
  deskFee: number | null;
}

/** One rate row to bulk-set (fee/homeFee/deskFee all optional; ≥1 required). */
export interface ShipRateInput {
  wilaya: number;
  fee?: number;
  homeFee?: number;
  deskFee?: number;
}

/** Courier tracking sub-states — map onto the 5 order statuses server-side. */
export const TRACKING_STATUSES = [
  'pris-en-charge',
  'en-route',
  'livre',
  'retour',
] as const;
export type ShipTrackingStatus = (typeof TRACKING_STATUSES)[number];

/** Delivery mode an order can carry (home = à domicile, desk = stop-desk). */
export type ShipDeliveryMode = 'home' | 'desk';

// ---- Read outcomes ---------------------------------------------------------

export type CouriersOutcome =
  | { status: 'ok'; couriers: ShipCourier[] }
  | { status: 'error'; message: string };

export type WilayasOutcome =
  | { status: 'ok'; wilayas: ShipWilaya[] }
  | { status: 'error'; message: string };

export type ShippingRatesOutcome =
  | { status: 'ok'; courierId: string; matrix: ShipMatrixRow[] }
  | { status: 'error'; message: string };

// ---- Small internal helper: a friendly message for a failed read ----------

function shipReadMessage(status: number, fallback: string): string {
  return status === 401
    ? 'Veuillez vous reconnecter.'
    : status === 403
      ? 'Cette boutique appartient à un autre compte.'
      : status === 404
        ? 'This shop was not found — it may have been deleted.'
        : fallback;
}

/** GET /erp/shipping/wilayas — the canonical 58-wilaya table (reference data). */
export async function fetchWilayas(slug: string): Promise<WilayasOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/shipping/wilayas`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement des wilayas.') };
  }
  const data = (await res.json().catch(() => null)) as
    | { wilayas?: unknown; message?: unknown }
    | null;
  if (!res.ok) {
    return {
      status: 'error',
      message: shipReadMessage(
        res.status,
        typeof data?.message === 'string'
          ? data.message
          : `Impossible de charger les wilayas (${res.status}).`
      ),
    };
  }
  const raw = Array.isArray(data?.wilayas) ? (data.wilayas as unknown[]) : [];
  const wilayas: ShipWilaya[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    const code = num(w.code);
    const name = typeof w.name === 'string' ? w.name : '';
    if (code >= 1 && code <= 58 && name) wilayas.push({ code, name });
  }
  return { status: 'ok', wilayas };
}

/** GET /erp/couriers — the store's couriers (newest-first as the API returns). */
export async function fetchCouriers(slug: string): Promise<CouriersOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/couriers`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement des transporteurs.') };
  }
  const data = (await res.json().catch(() => null)) as
    | { couriers?: unknown; message?: unknown }
    | null;
  if (!res.ok) {
    return {
      status: 'error',
      message: shipReadMessage(
        res.status,
        typeof data?.message === 'string'
          ? data.message
          : `Impossible de charger les transporteurs (${res.status}).`
      ),
    };
  }
  const raw = Array.isArray(data?.couriers) ? (data.couriers as unknown[]) : [];
  const couriers: ShipCourier[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const id = typeof c.id === 'string' ? c.id : '';
    const name = typeof c.name === 'string' ? c.name : '';
    if (!id) continue;
    const courier: ShipCourier = {
      id,
      name: name || id,
      active: c.active === undefined ? true : Boolean(c.active),
    };
    if (typeof c.phone === 'string' && c.phone) courier.phone = c.phone;
    if (c.codFee !== undefined) courier.codFee = num(c.codFee);
    if (typeof c.createdAt === 'string') courier.createdAt = c.createdAt;
    couriers.push(courier);
  }
  return { status: 'ok', couriers };
}

/** GET /erp/shipping/rates?courierId= — the dense 58-row matrix for a courier. */
export async function fetchShippingRates(
  slug: string,
  courierId: string
): Promise<ShippingRatesOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(slug)}/erp/shipping/rates?courierId=${encodeURIComponent(courierId)}`
      ),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement des tarifs.') };
  }
  const data = (await res.json().catch(() => null)) as
    | { courierId?: unknown; matrix?: unknown; message?: unknown }
    | null;
  if (!res.ok) {
    return {
      status: 'error',
      message: shipReadMessage(
        res.status,
        typeof data?.message === 'string'
          ? data.message
          : `Impossible de charger les tarifs (${res.status}).`
      ),
    };
  }
  const raw = Array.isArray(data?.matrix) ? (data.matrix as unknown[]) : [];
  const matrix: ShipMatrixRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const wilaya = num(r.wilaya);
    if (wilaya < 1 || wilaya > 58) continue;
    matrix.push({
      wilaya,
      name: typeof r.name === 'string' ? r.name : '',
      fee: r.fee === null || r.fee === undefined ? null : num(r.fee),
      homeFee: r.homeFee === null || r.homeFee === undefined ? null : num(r.homeFee),
      deskFee: r.deskFee === null || r.deskFee === undefined ? null : num(r.deskFee),
    });
  }
  return {
    status: 'ok',
    courierId: typeof data?.courierId === 'string' ? data.courierId : courierId,
    matrix,
  };
}

// ---- Mutation helper (mirrors erpMutate, but for the shipping route tree) --

async function shipMutate<T>(
  path: string,
  body: Record<string, unknown>
): Promise<ErpMutateOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été modifié.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown })
    | null;
  if (data?.error === 'admin_writes_unavailable') {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : res.status === 404
            ? 'Introuvable — cela a peut-être été modifié ailleurs. Actualisez et réessayez.'
            : res.status === 409
              ? 'Un transporteur portant ce nom existe déjà.'
              : typeof data?.message === 'string'
                ? (data.message as string)
                : typeof data?.error === 'string'
                  ? `La modification a échoué (${data.error}).`
                  : `La modification a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', data: data as T };
}

async function shipMutatePut<T>(
  path: string,
  body: Record<string, unknown>
): Promise<ErpMutateOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été modifié.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown })
    | null;
  if (data?.error === 'admin_writes_unavailable') {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : res.status === 404
            ? 'Introuvable — actualisez et réessayez.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `La modification a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', data: data as T };
}

/** POST /erp/couriers — create a courier (id derived kebab-case from name). */
export function saveCourier(
  slug: string,
  body: { name: string; phone?: string; codFee?: number; active?: boolean }
): Promise<ErpMutateOutcome<{ ok?: boolean; courier?: ShipCourier }>> {
  return shipMutate(
    `/api/v1/apps/${encodeURIComponent(slug)}/erp/couriers`,
    body as Record<string, unknown>
  );
}

/** PUT /erp/couriers/:id — update a courier in place (id/createdAt immutable). */
export function updateCourier(
  slug: string,
  id: string,
  patch: { name?: string; phone?: string; codFee?: number; active?: boolean }
): Promise<ErpMutateOutcome<{ ok?: boolean; courier?: ShipCourier }>> {
  return shipMutatePut(
    `/api/v1/apps/${encodeURIComponent(slug)}/erp/couriers/${encodeURIComponent(id)}`,
    patch as Record<string, unknown>
  );
}

/** POST /erp/shipping/rates — bulk-set a courier's rate matrix. */
export function postShippingRates(
  slug: string,
  courierId: string,
  rates: ShipRateInput[]
): Promise<ErpMutateOutcome<{ ok?: boolean; courierId?: string; written?: number }>> {
  return shipMutate(
    `/api/v1/apps/${encodeURIComponent(slug)}/erp/shipping/rates`,
    { courierId, rates }
  );
}

/** POST /erp/shipping/rates/import-csv — parse + bulk-set a pasted CSV blob. */
export function importRatesCsv(
  slug: string,
  courierId: string,
  csv: string
): Promise<
  ErpMutateOutcome<{ ok?: boolean; courierId?: string; written?: number; skipped?: number }>
> {
  return shipMutate(
    `/api/v1/apps/${encodeURIComponent(slug)}/erp/shipping/rates/import-csv`,
    { courierId, csv }
  );
}

/** POST /erp/orders/:orderId/assign-courier — attach a courier to an order. */
export function assignCourier(
  slug: string,
  orderId: string,
  courierId: string,
  mode?: ShipDeliveryMode
): Promise<ErpMutateOutcome<{ ok?: boolean; order?: ErpOrder }>> {
  return shipMutate(
    `/api/v1/apps/${encodeURIComponent(slug)}/erp/orders/${encodeURIComponent(orderId)}/assign-courier`,
    { courierId, ...(mode ? { mode } : {}) }
  );
}

/** POST /erp/orders/:orderId/tracking — advance the tracking sub-state (also
 *  moves the order's canonical status: livre→Livrée, retour→Retournée). */
export function postTracking(
  slug: string,
  orderId: string,
  status: ShipTrackingStatus
): Promise<ErpMutateOutcome<{ ok?: boolean; order?: ErpOrder }>> {
  return shipMutate(
    `/api/v1/apps/${encodeURIComponent(slug)}/erp/orders/${encodeURIComponent(orderId)}/tracking`,
    { status }
  );
}

// ---------------------------------------------------------------------------
// R17 (PR-C) — COURIER integration client layer (Yalidine first). Thin, typed
// wrappers over the OWNER-AUTHED courier controller routes, which live under a
// SEPARATE path tree from the /erp bridge:
//     /api/v1/apps/:slug/courier/:provider/…      (provider = 'yalidine')
// All calls are session-cookie authed (credentials:'include', identical to the
// shipping wrappers above). The whole feature ships DARK behind CDZ_COURIERS_
// ENABLED on the server: when the flag is off EVERY route returns a typed 404,
// byte-identical to the routes not existing. So the FE treats a 404 on the GET
// status probe as a first-class 'dark' outcome (render a subtle "bientôt" and
// STOP) — NOT an error. Mirrors the WSF-2 customize dark-gating stance.
//
// Backend response contracts (PR-A + PR-B, live on canary):
//   GET  …/                      → { connected, enabled }              | 404 dark
//   POST …/connect {apiId,apiToken} → { connected, enabled }  (400 invalid_credentials)
//   POST …/disconnect            → { ok }
//   GET  …/fees?to_wilaya=&from_wilaya= → { fees }
//   GET  …/reference?kind=wilayas|communes|centers[&wilaya_id=] → { kind, items, cached }
//   POST …/ship {orderId, fromWilaya, price?, isStopdesk?, …} →
//            { ok, tracking, label?, courierStatus, alreadyShipped?, persisted? }
//   POST …/sync {orderId?}       → { ok, scanned, total, capped, updated,
//            delivered, results:[{ orderId, outcome, courierStatus?, delivered? }] }
//   POST …/ship/:orderId/refresh → { ok, orderId, outcome, courierStatus?, delivered? }
//
// The typed error bodies the controller emits on a provider hiccup
// (invalid_credentials / rate_limited / courier_unreachable / not_connected …)
// are mapped to human FR copy in courierErrMessage — NEVER a raw HTTP code.
// ---------------------------------------------------------------------------

/**
 * Courier providers. Yalidine is LIVE today; the rest ride the same per-provider
 * routes (`/courier/:provider/…`) and stay DARK (backend 404 → 'bientôt') until
 * their server flag flips. Widening this union is safe: the route base already
 * interpolates `:provider` and every wrapper defaults to 'yalidine'.
 */
export type CourierProviderId =
  | 'yalidine'
  | 'zrexpress'
  | 'maystro'
  | 'noest'
  | 'ecotrack';

/**
 * Per-provider display + connect-form metadata. Drives the Transporteurs picker
 * and the connect card so the form renders per provider WITHOUT branching in the
 * component: `singleToken` hides the API-ID field (Maystro); `apiIdLabel`/
 * `apiIdHint` relabel it (Ecotrack asks for the merchant's Ecotrack host, not an
 * id). `label` replaces the former module-local COURIER_PROVIDER_LABEL constant.
 * `tokenLabel`/`tokenHint` keep the (non-secret) copy provider-specific.
 */
export interface CourierProviderMeta {
  id: CourierProviderId;
  label: string;
  /** Token-only provider: hide the API-ID field and gate submit on the token alone. */
  singleToken: boolean;
  /** Label for the first credential field (API ID by default). */
  apiIdLabel?: string;
  /** Hint under the first credential field. */
  apiIdHint?: string;
  /** Placeholder for the first credential field. */
  apiIdPlaceholder?: string;
  /** maxLength for the first credential field (Ecotrack host needs more room). */
  apiIdMaxLength?: number;
  /** Label for the token field. */
  tokenLabel?: string;
  /** Hint under the token field. */
  tokenHint?: string;
  /** Optional provider-specific note appended to the connect hint (e.g. where to
   *  find the keys). Kept per-provider so the live Yalidine copy is unchanged. */
  connectHintExtra?: string;
}

export const COURIER_PROVIDERS: CourierProviderMeta[] = [
  {
    id: 'yalidine',
    label: 'Yalidine',
    singleToken: false,
    apiIdLabel: 'API ID',
    apiIdHint: 'Identifiant API Yalidine (X-API-ID).',
    apiIdPlaceholder: 'Ex. 12345678',
    apiIdMaxLength: 64,
    tokenLabel: 'API Token',
    tokenHint: 'Jeton API Yalidine (X-API-TOKEN).',
    connectHintExtra: ' (Développeurs → API)',
  },
  {
    id: 'zrexpress',
    label: 'ZR Express',
    singleToken: false,
    apiIdLabel: 'Token ID (key)',
    apiIdHint: 'Identifiant (key) de votre espace ZR Express.',
    apiIdPlaceholder: 'Ex. votre key',
    tokenLabel: 'API Token',
    tokenHint: 'Jeton API ZR Express.',
  },
  {
    id: 'maystro',
    label: 'Maystro',
    // Token-only: Maystro authenticates with a single API token (no separate id).
    singleToken: true,
    tokenLabel: 'API Token',
    tokenHint: 'Jeton API Maystro.',
  },
  {
    id: 'noest',
    label: 'Noest',
    singleToken: false,
    apiIdLabel: 'API ID',
    apiIdHint: 'Identifiant API Noest.',
    apiIdPlaceholder: 'Ex. votre identifiant',
    tokenLabel: 'API Token',
    tokenHint: 'Jeton API Noest.',
  },
  {
    id: 'ecotrack',
    label: 'Ecotrack',
    singleToken: false,
    // Ecotrack's "id" is the merchant's own Ecotrack domain/host, not a key.
    apiIdLabel: 'Domaine Ecotrack',
    apiIdHint: 'Votre domaine Ecotrack, ex. https://xxx.ecotrack.dz.',
    apiIdPlaceholder: 'https://xxx.ecotrack.dz',
    apiIdMaxLength: 256,
    tokenLabel: 'API Token',
    tokenHint: 'Jeton API Ecotrack.',
  },
];

/** Look up a provider's metadata (falls back to Yalidine's for an unknown id). */
export function courierProviderMeta(provider: CourierProviderId): CourierProviderMeta {
  return COURIER_PROVIDERS.find(p => p.id === provider) ?? COURIER_PROVIDERS[0];
}

/** A provider's human label (used in FR copy + error messages). */
export function courierProviderLabel(provider: CourierProviderId): string {
  return courierProviderMeta(provider).label;
}

/**
 * Coarse per-parcel courier sub-state the backend persists on an order
 * (normalizeStatus maps a provider's ~30 raw statuses onto these four). Kept in
 * lock-step with the server's CourierStatus union (clickdz-courier.ts).
 */
export type CourierStatus = 'pending' | 'shipped' | 'delivered' | 'returned';

/** FR labels + accent colors for the four courier sub-states (this surface is French). */
export const COURIER_STATUS_LABELS: Record<CourierStatus, string> = {
  pending: 'En préparation',
  shipped: 'Expédié',
  delivered: 'Livré',
  returned: 'Retourné',
};
export const COURIER_STATUS_COLORS: Record<CourierStatus, string> = {
  pending: '#38bdf8',
  shipped: '#8b5cf6',
  delivered: '#22c55e',
  returned: '#ef4444',
};

/** Reference-list kinds the controller serves (cache-friendly geo data). */
export type CourierReferenceKind = 'wilayas' | 'communes' | 'centers';

/** One wilaya row from the courier reference endpoint (drives the pickup picker). */
export interface CourierWilaya {
  id: number;
  name: string;
}

/** Connect/status probe outcome. 'dark' = the feature flag is OFF (404) — hide
 *  the panel behind a subtle "bientôt" note, never an error. */
export type CourierStatusOutcome =
  | { status: 'ok'; connected: boolean; enabled: boolean }
  | { status: 'dark' }
  | { status: 'error'; message: string };

/** connect / disconnect outcome (dark-aware; inline error, never a raw code). */
export type CourierConnectOutcome =
  | { status: 'ok'; connected: boolean; enabled: boolean }
  | { status: 'dark' }
  | { status: 'error'; message: string };

export type CourierDisconnectOutcome =
  | { status: 'ok' }
  | { status: 'dark' }
  | { status: 'error'; message: string };

/** ship outcome — carries the tracking + optional label + the coarse status. */
export type CourierShipOutcome =
  | {
      status: 'ok';
      tracking: string;
      label?: string;
      courierStatus: CourierStatus;
      alreadyShipped: boolean;
      persisted: boolean;
    }
  | { status: 'dark' }
  | { status: 'error'; message: string };

/** One order's sync result (aggregated by the batch sync + returned by refresh). */
export interface CourierSyncResult {
  orderId: string;
  outcome: string;
  courierStatus?: CourierStatus;
  delivered?: boolean;
}
export type CourierSyncOutcome =
  | {
      status: 'ok';
      scanned: number;
      total: number;
      capped: boolean;
      updated: number;
      delivered: number;
      results: CourierSyncResult[];
    }
  | { status: 'dark' }
  | { status: 'error'; message: string };

export type CourierRefreshOutcome =
  | {
      status: 'ok';
      orderId: string;
      outcome: string;
      courierStatus?: CourierStatus;
      delivered: boolean;
    }
  | { status: 'dark' }
  | { status: 'error'; message: string };

export type CourierFeesOutcome =
  | { status: 'ok'; fees: unknown }
  | { status: 'dark' }
  | { status: 'error'; message: string };

export type CourierReferenceOutcome =
  | { status: 'ok'; kind: CourierReferenceKind; items: unknown[]; cached: boolean }
  | { status: 'dark' }
  | { status: 'error'; message: string };

/** Base path for a courier route. provider is a fixed literal today ('yalidine'). */
function courierBase(slug: string, provider: CourierProviderId): string {
  return `/api/v1/apps/${encodeURIComponent(slug)}/courier/${encodeURIComponent(
    provider
  )}`;
}

/**
 * Map the courier controller's typed error body → human FR copy. NEVER a raw
 * HTTP status. `error` is the machine code the passthrough JSON carries
 * (invalid_credentials, rate_limited, courier_unreachable, not_connected, …);
 * `status` is the HTTP code as a fallback for the unmapped case.
 */
function courierErrMessage(
  errCode: string,
  httpStatus: number,
  fallbackMsg?: string,
  provider: CourierProviderId = 'yalidine'
): string {
  const label = courierProviderLabel(provider);
  switch (errCode) {
    case 'invalid_credentials':
      return `Identifiants ${label} refusés — vérifiez l’API ID et l’API Token, puis réessayez.`;
    case 'rate_limited':
      return `Trop de requêtes vers ${label} — patientez un instant avant de réessayer.`;
    case 'courier_unreachable':
      return `${label} est injoignable pour le moment. Réessayez dans quelques minutes.`;
    case 'courier_bad_response':
    case 'courier_error':
      return `Réponse inattendue de ${label}. Réessayez ; si ça persiste, contactez le support.`;
    case 'not_connected':
      return `Compte transporteur non connecté — connectez ${label} d’abord.`;
    case 'not_shipped':
      return 'Cette commande n’a pas encore été expédiée.';
    case 'provider_mismatch':
      return 'Cette commande a été expédiée avec un autre transporteur.';
    case 'invalid_order':
      return 'Informations de commande incomplètes (client, wilaya, commune ou téléphone).';
    case 'admin_writes_unavailable':
      return 'Écritures indisponibles sur ce serveur — réessayez plus tard.';
    case 'store_unavailable':
    case 'data_api_unavailable':
      return 'Service de données indisponible — réessayez dans un instant.';
    case 'order_unwritable':
      return 'Impossible d’enregistrer le suivi sur cette commande.';
    default:
      break;
  }
  if (httpStatus === 401) return 'Reconnectez-vous pour continuer.';
  if (httpStatus === 403) return 'Cette boutique appartient à un autre compte.';
  if (httpStatus === 400 && fallbackMsg) {
    // Surface a validation reason plainly (never leak internal detail).
    return 'Requête invalide — vérifiez les informations saisies.';
  }
  return fallbackMsg || `L’opération a échoué (${httpStatus}).`;
}

/** Pull the machine error code + optional message off a parsed JSON body. */
function courierErrParts(
  data: (Record<string, unknown> & { error?: unknown; message?: unknown }) | null
): { code: string; message?: string } {
  const code = typeof data?.error === 'string' ? data.error : '';
  const message = typeof data?.message === 'string' ? data.message : undefined;
  return { code, message };
}

/**
 * GET …/courier/:provider — connection status. A 404 means the feature flag is
 * OFF on this server → 'dark' (hide behind a subtle "bientôt", NEVER error).
 */
export async function fetchCourierStatus(
  slug: string,
  provider: CourierProviderId = 'yalidine'
): Promise<CourierStatusOutcome> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(courierBase(slug, provider)), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — impossible de vérifier le transporteur.') };
  }
  if (res.status === 404) {
    // Feature dark (flag off) — treated as "not available yet", not an error.
    return { status: 'dark' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { connected?: unknown; enabled?: unknown })
    | null;
  if (!res.ok) {
    const { code, message } = courierErrParts(data);
    return { status: 'error', message: courierErrMessage(code, res.status, message, provider) };
  }
  return {
    status: 'ok',
    connected: data?.connected === true,
    enabled: data?.enabled === true,
  };
}

/**
 * POST …/courier/:provider/connect { apiId, apiToken }. The server validates the
 * keys with a live Yalidine call BEFORE sealing them; a 400 invalid_credentials
 * surfaces as inline FR copy. A 404 = flag off (dark). NEVER echoes the keys.
 */
export async function connectCourier(
  slug: string,
  apiId: string,
  apiToken: string,
  provider: CourierProviderId = 'yalidine'
): Promise<CourierConnectOutcome> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(`${courierBase(slug, provider)}/connect`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ apiId, apiToken }),
    });
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été enregistré.') };
  }
  if (res.status === 404) {
    return { status: 'dark' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { connected?: unknown; enabled?: unknown })
    | null;
  if (!res.ok) {
    const { code, message } = courierErrParts(data);
    return { status: 'error', message: courierErrMessage(code, res.status, message, provider) };
  }
  return {
    status: 'ok',
    connected: data?.connected === true,
    enabled: data?.enabled === true,
  };
}

/** POST …/courier/:provider/disconnect — idempotent; a 404 = flag off (dark). */
export async function disconnectCourier(
  slug: string,
  provider: CourierProviderId = 'yalidine'
): Promise<CourierDisconnectOutcome> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(`${courierBase(slug, provider)}/disconnect`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été modifié.') };
  }
  if (res.status === 404) {
    return { status: 'dark' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { ok?: unknown })
    | null;
  if (!res.ok) {
    const { code, message } = courierErrParts(data);
    return { status: 'error', message: courierErrMessage(code, res.status, message, provider) };
  }
  return { status: 'ok' };
}

/**
 * POST …/courier/:provider/ship { orderId, fromWilaya, price?, isStopdesk?, … }.
 * Idempotent on the server (an order already carrying a tracking returns it with
 * alreadyShipped:true). `persisted:false` means the parcel exists at the courier
 * but the tracking couldn't be written onto the order (surface the tracking, let
 * the merchant re-ship — it will short-circuit once the write lands).
 */
export async function courierShip(
  slug: string,
  orderId: string,
  fromWilaya: string | number,
  opts?: { price?: number; isStopdesk?: boolean; freeshipping?: boolean },
  provider: CourierProviderId = 'yalidine'
): Promise<CourierShipOutcome> {
  const body: Record<string, unknown> = { orderId, fromWilaya };
  if (opts?.price !== undefined) body.price = opts.price;
  if (opts?.isStopdesk !== undefined) body.isStopdesk = opts.isStopdesk;
  if (opts?.freeshipping !== undefined) body.freeshipping = opts.freeshipping;
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(`${courierBase(slug, provider)}/ship`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — la commande n’a pas été expédiée.') };
  }
  if (res.status === 404) {
    return { status: 'dark' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & {
        tracking?: unknown;
        label?: unknown;
        courierStatus?: unknown;
        alreadyShipped?: unknown;
        persisted?: unknown;
      })
    | null;
  if (!res.ok) {
    const { code, message } = courierErrParts(data);
    return { status: 'error', message: courierErrMessage(code, res.status, message, provider) };
  }
  const cs = typeof data?.courierStatus === 'string' ? data.courierStatus : 'pending';
  return {
    status: 'ok',
    tracking: typeof data?.tracking === 'string' ? data.tracking : '',
    ...(typeof data?.label === 'string' && data.label ? { label: data.label } : {}),
    courierStatus: (isCourierStatusValue(cs) ? cs : 'pending') as CourierStatus,
    alreadyShipped: data?.alreadyShipped === true,
    // The server omits `persisted` on the happy fast-return, so default true.
    persisted: data?.persisted !== false,
  };
}

/**
 * POST …/courier/:provider/sync { orderId? } — poll tracking → advance orders +
 * caisse. Without orderId, scans all shipped-but-non-terminal parcels (bounded
 * server-side). Button-driven only (no tight polling) to respect rate limits.
 */
export async function courierSync(
  slug: string,
  orderId?: string,
  provider: CourierProviderId = 'yalidine'
): Promise<CourierSyncOutcome> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(`${courierBase(slug, provider)}/sync`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(orderId ? { orderId } : {}),
    });
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — le suivi n’a pas été actualisé.') };
  }
  if (res.status === 404) {
    return { status: 'dark' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & {
        scanned?: unknown;
        total?: unknown;
        capped?: unknown;
        updated?: unknown;
        delivered?: unknown;
        results?: unknown;
      })
    | null;
  if (!res.ok) {
    const { code, message } = courierErrParts(data);
    return { status: 'error', message: courierErrMessage(code, res.status, message, provider) };
  }
  const rawResults = Array.isArray(data?.results) ? (data.results as unknown[]) : [];
  const results: CourierSyncResult[] = [];
  for (const item of rawResults) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const oid = typeof r.orderId === 'string' ? r.orderId : '';
    if (!oid) continue;
    const cs = typeof r.courierStatus === 'string' ? r.courierStatus : '';
    results.push({
      orderId: oid,
      outcome: typeof r.outcome === 'string' ? r.outcome : '',
      ...(isCourierStatusValue(cs) ? { courierStatus: cs as CourierStatus } : {}),
      ...(r.delivered === true ? { delivered: true } : {}),
    });
  }
  return {
    status: 'ok',
    scanned: num(data?.scanned),
    total: num(data?.total),
    capped: data?.capped === true,
    updated: num(data?.updated),
    delivered: num(data?.delivered),
    results,
  };
}

/**
 * POST …/courier/:provider/ship/:orderId/refresh — single-order tracking refresh
 * (folds into the same sync-one path server-side, so the caisse hook applies).
 */
export async function courierRefresh(
  slug: string,
  orderId: string,
  provider: CourierProviderId = 'yalidine'
): Promise<CourierRefreshOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `${courierBase(slug, provider)}/ship/${encodeURIComponent(orderId)}/refresh`
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — le suivi n’a pas été actualisé.') };
  }
  if (res.status === 404) {
    return { status: 'dark' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & {
        orderId?: unknown;
        outcome?: unknown;
        courierStatus?: unknown;
        delivered?: unknown;
      })
    | null;
  if (!res.ok) {
    const { code, message } = courierErrParts(data);
    return { status: 'error', message: courierErrMessage(code, res.status, message, provider) };
  }
  const cs = typeof data?.courierStatus === 'string' ? data.courierStatus : '';
  return {
    status: 'ok',
    orderId: typeof data?.orderId === 'string' ? data.orderId : orderId,
    outcome: typeof data?.outcome === 'string' ? data.outcome : '',
    ...(isCourierStatusValue(cs) ? { courierStatus: cs as CourierStatus } : {}),
    delivered: data?.delivered === true,
  };
}

/**
 * GET …/courier/:provider/fees?to_wilaya=&from_wilaya= — a delivery-fee quote.
 * Both wilayas are numeric codes; the server requires from_wilaya (the pickup).
 */
export async function courierFees(
  slug: string,
  fromWilaya: number,
  toWilaya: number,
  provider: CourierProviderId = 'yalidine'
): Promise<CourierFeesOutcome> {
  const qs = `?to_wilaya=${encodeURIComponent(String(toWilaya))}&from_wilaya=${encodeURIComponent(
    String(fromWilaya)
  )}`;
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(`${courierBase(slug, provider)}/fees${qs}`), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — impossible de récupérer le tarif.') };
  }
  if (res.status === 404) {
    return { status: 'dark' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { fees?: unknown })
    | null;
  if (!res.ok) {
    const { code, message } = courierErrParts(data);
    return { status: 'error', message: courierErrMessage(code, res.status, message, provider) };
  }
  return { status: 'ok', fees: data?.fees };
}

/**
 * GET …/courier/:provider/reference?kind=wilayas|communes|centers[&wilaya_id=].
 * Cache-friendly geo lists. communes/centers require a numeric wilaya_id.
 */
export async function fetchCourierReference(
  slug: string,
  kind: CourierReferenceKind,
  wilayaId?: number,
  provider: CourierProviderId = 'yalidine'
): Promise<CourierReferenceOutcome> {
  let qs = `?kind=${encodeURIComponent(kind)}`;
  if (wilayaId !== undefined) {
    qs += `&wilaya_id=${encodeURIComponent(String(wilayaId))}`;
  }
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(`${courierBase(slug, provider)}/reference${qs}`), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — impossible de charger la liste.') };
  }
  if (res.status === 404) {
    return { status: 'dark' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { kind?: unknown; items?: unknown; cached?: unknown })
    | null;
  if (!res.ok) {
    const { code, message } = courierErrParts(data);
    return { status: 'error', message: courierErrMessage(code, res.status, message, provider) };
  }
  return {
    status: 'ok',
    kind: (typeof data?.kind === 'string' ? data.kind : kind) as CourierReferenceKind,
    items: Array.isArray(data?.items) ? (data.items as unknown[]) : [],
    cached: data?.cached === true,
  };
}

/**
 * Parse the courier reference `wilayas` payload into a compact {id,name} list
 * (drives the pickup-wilaya picker). Yalidine wilaya rows carry {id, name, …};
 * tolerant of missing fields so an older/newer shape never throws.
 */
export function parseCourierWilayas(items: unknown[]): CourierWilaya[] {
  const out: CourierWilaya[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    const id = num(w.id !== undefined ? w.id : w.wilaya_id);
    const name =
      typeof w.name === 'string'
        ? w.name
        : typeof w.wilaya_name === 'string'
          ? w.wilaya_name
          : '';
    if (id >= 1 && name) out.push({ id, name });
  }
  return out;
}

/** Type-guard for the four courier sub-states (mirrors server isCourierStatus). */
function isCourierStatusValue(v: string): v is CourierStatus {
  return v === 'pending' || v === 'shipped' || v === 'delivered' || v === 'returned';
}

// ---------------------------------------------------------------------------
// WSE-9 (COMPTOIR) — Caisse (cash register) + COD reconciliation client layer.
// Thin wrappers over the R2-d bridge routes (/api/v1/apps/:slug/erp/caisse*),
// mirroring the fetchErpSummary / erpMutate outcome style (discriminated unions,
// credentials:'include', 404/501 → quiet 'unavailable'). Money is INTEGER DZD
// end-to-end (the backend rounds + validates; these types carry plain numbers).
// The pinned entry shape { id, date, kind:'in'|'out', amount, method, courierId?,
// orderRef?, note, pending? } and the reconcile/day-close shapes are byte-aligned
// with ./clickdz-erp-caisse.ts (server) — DO NOT drift them.
// ---------------------------------------------------------------------------

/** Payment/settlement method for a caisse movement (backend allowlist). */
export type CaisseMethod = 'cod' | 'cash' | 'chargily';

/** FR labels for the three methods (this surface is French). */
export const CAISSE_METHOD_LABELS: Record<CaisseMethod, string> = {
  cash: 'Espèces',
  cod: 'COD (livraison)',
  chargily: 'Chargily (en ligne)',
};

/** One caisse ledger entry (raw data-API record + pinned fields). */
export interface CaisseEntry {
  id: string;
  date: string;
  kind: 'in' | 'out';
  amount: number;
  method: CaisseMethod | string;
  courierId?: string;
  orderRef?: string;
  note?: string;
  /** true = pending-COD marker (expected, not yet counted as real cash). */
  pending?: boolean;
  createdAt?: string;
}

/** A courier as consumed by the caisse UI (subset of the couriers record). */
export interface CourierLite {
  id: string;
  name?: string;
  codFee?: number;
  active?: boolean;
}

/** One delivered-order reference inside a reconcile report. */
export interface ReconcileOrderRef {
  ref: string;
  total: number;
  date: string;
}

/** GET /erp/caisse/reconcile → { range, report } — the report shape. */
export interface CaisseReconcile {
  courierId: string;
  courierName: string;
  expectedTotal: number;
  receivedTotal: number;
  gap: number;
  codFeeTotal: number;
  deliveredCount: number;
  orders: ReconcileOrderRef[];
}

/** Per-method money breakdown (integer DZD). */
export interface CaisseMethodBreakdown {
  cod: number;
  cash: number;
  chargily: number;
}

/** GET /erp/caisse/day-close → the day-close (or range) summary. */
export interface CaisseDayClose {
  date: string;
  from: string;
  to: string;
  inTotal: number;
  outTotal: number;
  net: number;
  inByMethod: CaisseMethodBreakdown;
  outByMethod: CaisseMethodBreakdown;
  pendingCodTotal: number;
  entryCount: number;
}

export type CaisseListOutcome =
  | { status: 'ok'; entries: CaisseEntry[] }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

export type CaisseReconcileOutcome =
  | { status: 'ok'; report: CaisseReconcile }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

export type CaisseDayCloseOutcome =
  | { status: 'ok'; summary: CaisseDayClose }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** Coerce a raw record into a well-typed CaisseEntry (defensive). */
function normalizeCaisseEntry(raw: unknown): CaisseEntry {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ''),
    date: String(r.date ?? '').slice(0, 10),
    kind: r.kind === 'out' ? 'out' : 'in',
    amount: num(r.amount),
    method: typeof r.method === 'string' ? r.method : 'cash',
    ...(r.courierId ? { courierId: String(r.courierId) } : {}),
    ...(r.orderRef ? { orderRef: String(r.orderRef) } : {}),
    ...(r.note != null ? { note: String(r.note) } : {}),
    ...(r.pending === true ? { pending: true } : {}),
    ...(r.createdAt ? { createdAt: String(r.createdAt) } : {}),
  };
}

function emptyBreakdown(raw: unknown): CaisseMethodBreakdown {
  const b = (raw ?? {}) as Record<string, unknown>;
  return { cod: num(b.cod), cash: num(b.cash), chargily: num(b.chargily) };
}

/**
 * GET /api/v1/apps/:slug/erp/caisse?month=YYYYMM — one monthly partition,
 * newest-first. 404/501/502 → 'unavailable' so the Journal shows a quiet empty
 * state (never crashes). `month` is YYYYMM; omit for the current month.
 */
export async function fetchCaisse(
  slug: string,
  month?: string
): Promise<CaisseListOutcome> {
  const qs = /^\d{6}$/.test(String(month || '')) ? `?month=${month}` : '';
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/caisse${qs}`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement du journal.') };
  }
  if (res.status === 404 || res.status === 501) return { status: 'unavailable' };
  const data = (await res.json().catch(() => null)) as
    | { entries?: unknown; error?: unknown; message?: unknown }
    | null;
  if (data?.error === 'data_api_unavailable') return { status: 'unavailable' };
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible de charger le journal (${res.status}).`;
    return { status: 'error', message };
  }
  const rows = Array.isArray(data?.entries) ? (data!.entries as unknown[]) : [];
  return { status: 'ok', entries: rows.map(normalizeCaisseEntry).filter(e => e.id) };
}

/**
 * POST /api/v1/apps/:slug/erp/caisse — create one entry (pinned shape). Returns
 * the created record. 501 admin_writes_unavailable → 'unavailable' (read-only).
 */
export async function postCaisseEntry(
  slug: string,
  body: {
    kind: 'in' | 'out';
    amount: number;
    method: CaisseMethod;
    date?: string;
    courierId?: string;
    orderRef?: string;
    note?: string;
  }
): Promise<ErpMutateOutcome<{ ok?: boolean; entry?: CaisseEntry }>> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/caisse`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été enregistré.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown; field?: unknown })
    | null;
  if (data?.error === 'admin_writes_unavailable') return { status: 'unavailable' };
  if (!res.ok) {
    const message =
      res.status === 400 && data?.error === 'invalid_entry'
        ? typeof data?.message === 'string'
          ? (data.message as string)
          : 'Écriture invalide — vérifiez les champs.'
        : res.status === 401
          ? 'Veuillez vous reconnecter.'
          : res.status === 403
            ? 'Cette boutique appartient à un autre compte.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `L’enregistrement a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', data: data as { ok?: boolean; entry?: CaisseEntry } };
}

/**
 * PUT /api/v1/apps/:slug/erp/caisse/:id — edit an entry IN PLACE (native upsert;
 * money docs never delete+recreate). Partial patch; sends `date` as the month
 * hint the backend uses to locate the partition cheaply. 404 → typed error.
 */
export async function putCaisseEntry(
  slug: string,
  id: string,
  patch: {
    kind?: 'in' | 'out';
    amount?: number;
    method?: CaisseMethod;
    date?: string;
    courierId?: string;
    orderRef?: string;
    note?: string;
  }
): Promise<ErpMutateOutcome<{ ok?: boolean; entry?: CaisseEntry }>> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(slug)}/erp/caisse/${encodeURIComponent(id)}`
      ),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(patch),
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été modifié.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown })
    | null;
  if (data?.error === 'admin_writes_unavailable') return { status: 'unavailable' };
  if (!res.ok) {
    const message =
      res.status === 400 && data?.error === 'invalid_entry'
        ? typeof data?.message === 'string'
          ? (data.message as string)
          : 'Écriture invalide.'
        : res.status === 404
          ? 'Écriture introuvable — actualisez et réessayez.'
          : res.status === 401
            ? 'Veuillez vous reconnecter.'
            : res.status === 403
              ? 'Cette boutique appartient à un autre compte.'
              : typeof data?.message === 'string'
                ? (data.message as string)
                : `La modification a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', data: data as { ok?: boolean; entry?: CaisseEntry } };
}

/**
 * GET /api/v1/apps/:slug/erp/caisse/reconcile?courierId=&from=&to= — per-courier
 * COD reconciliation. Unwraps the { range, report } envelope to the report.
 * 404/501/502 → 'unavailable'.
 */
export async function fetchReconcile(
  slug: string,
  courierId: string,
  from: string,
  to: string
): Promise<CaisseReconcileOutcome> {
  const qs = `?courierId=${encodeURIComponent(courierId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/caisse/reconcile${qs}`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du rapprochement.') };
  }
  if (res.status === 404 || res.status === 501) return { status: 'unavailable' };
  const data = (await res.json().catch(() => null)) as
    | { report?: unknown; error?: unknown; message?: unknown }
    | null;
  if (data?.error === 'data_api_unavailable') return { status: 'unavailable' };
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Le rapprochement a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  const r = (data?.report ?? {}) as Record<string, unknown>;
  const orders = Array.isArray(r.orders) ? (r.orders as unknown[]) : [];
  return {
    status: 'ok',
    report: {
      courierId: String(r.courierId ?? courierId),
      courierName: String(r.courierName ?? r.courierId ?? courierId),
      expectedTotal: num(r.expectedTotal),
      receivedTotal: num(r.receivedTotal),
      gap: num(r.gap),
      codFeeTotal: num(r.codFeeTotal),
      deliveredCount: num(r.deliveredCount),
      orders: orders.map(o => {
        const o2 = (o ?? {}) as Record<string, unknown>;
        return {
          ref: String(o2.ref ?? ''),
          total: num(o2.total),
          date: String(o2.date ?? '').slice(0, 10),
        };
      }),
    },
  };
}

/**
 * GET /api/v1/apps/:slug/erp/caisse/day-close?date=YYYY-MM-DD — the day-close
 * summary (returned directly, not wrapped). 404/501/502 → 'unavailable'.
 */
export async function fetchDayClose(
  slug: string,
  date?: string
): Promise<CaisseDayCloseOutcome> {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/caisse/day-close${qs}`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors de la clôture.') };
  }
  if (res.status === 404 || res.status === 501) return { status: 'unavailable' };
  const data = (await res.json().catch(() => null)) as
    | (Partial<CaisseDayClose> & { error?: unknown; message?: unknown })
    | null;
  if ((data as { error?: unknown })?.error === 'data_api_unavailable') {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `La clôture a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return {
    status: 'ok',
    summary: {
      date: String(data?.date ?? date ?? '').slice(0, 10),
      from: String(data?.from ?? '').slice(0, 10),
      to: String(data?.to ?? '').slice(0, 10),
      inTotal: num(data?.inTotal),
      outTotal: num(data?.outTotal),
      net: num(data?.net),
      inByMethod: emptyBreakdown(data?.inByMethod),
      outByMethod: emptyBreakdown(data?.outByMethod),
      pendingCodTotal: num(data?.pendingCodTotal),
      entryCount: num(data?.entryCount),
    },
  };
}

/**
 * GET /api/v1/apps/:slug/erp/couriers — the courier list, unwrapped to a lite
 * shape for the caisse form/reconcile pickers. NEVER throws: any failure (route
 * absent because Routier's shipping backend isn't on this server, 404, network)
 * resolves to [] so the caisse page has no hard dependency on shipping. Reused
 * by the shipping UI post-merge if it wants a lite courier read.
 */
export async function fetchCaisseCouriers(slug: string): Promise<CourierLite[]> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/couriers`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as
    | { couriers?: unknown }
    | unknown[]
    | null;
  const raw = Array.isArray(data)
    ? data
    : Array.isArray((data as { couriers?: unknown })?.couriers)
      ? ((data as { couriers?: unknown }).couriers as unknown[])
      : [];
  const out: CourierLite[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const id = String(c.id ?? '').trim();
    if (!id) continue;
    out.push({
      id,
      ...(c.name != null ? { name: String(c.name) } : {}),
      ...(c.codFee != null ? { codFee: num(c.codFee) } : {}),
      ...(c.active != null ? { active: c.active === true } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// erpBackends — published-app module activation. `settings.erpBackends` is a CSV
// of enabled published-ERP module ids (factures|livraison|caisse). Studio pages
// offer an "Afficher dans l'app" toggle that adds/removes their id; the published
// template shows those tabs only when the module is on AND its id is present. The
// value rides the EXISTING settings singleton (postErpSettings under the hood),
// so the orchestrator only needs to allowlist `erpBackends` in normalizeErpSettings.
// ---------------------------------------------------------------------------

/** The published-ERP module ids that can be toggled into erpBackends. */
export const MODULE_IDS = ['factures', 'livraison', 'caisse'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** FR labels for the toggleable modules. */
export const MODULE_LABELS: Record<ModuleId, string> = {
  factures: 'Factures',
  livraison: 'Livraison',
  caisse: 'Caisse',
};

/** Parse the erpBackends CSV → the set of enabled module ids. */
export function parseErpBackends(csv: string | undefined): ModuleId[] {
  if (!csv) return [];
  const wanted = String(csv)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return MODULE_IDS.filter(id => wanted.includes(id));
}

/** Is a given module id currently enabled in the erpBackends CSV? */
export function hasErpModule(csv: string | undefined, id: ModuleId): boolean {
  return parseErpBackends(csv).includes(id);
}

/** Add/remove a module id, returning the new stable-ordered CSV. */
export function toggleErpModule(
  csv: string | undefined,
  id: ModuleId,
  on: boolean
): string {
  const cur = new Set(parseErpBackends(csv));
  if (on) cur.add(id);
  else cur.delete(id);
  return MODULE_IDS.filter(m => cur.has(m)).join(',');
}

/**
 * Persist the erpBackends CSV via the settings singleton. Thin cast over the
 * same /erp/settings write path as every other setting (postErpSettings), so the
 * outcome semantics (ok / unavailable / error) are identical.
 */
export function postErpBackends(
  slug: string,
  csv: string
): Promise<ErpMutateOutcome<{ ok?: boolean; settings?: ErpSettings }>> {
  return postErpSettings(slug, { erpBackends: csv } as Partial<ErpSettings>);
}
// ---------------------------------------------------------------------------
// R3 — generic collection write wrappers (WSE-10 créances, and any future
// studio-owned collection with no dedicated bridge route). Reads already go
// through fetchErpCollection (public v2 GET, no token).
//
// SEC-1: these wrappers USED TO write directly to the data API's v1 alias
// (/api/apps-data/...), because v1 accepted writes with NO token while v2
// requires the per-slug HMAC write token that only a PUBLISHED app carries —
// the owner's browser cannot hold it. That worked, but it meant the merchant's
// own Créances ledger rode an endpoint that was equally open to the whole
// internet: anyone could create or delete records on any slug, unauthenticated
// (verified against production). The v1 alias is now token-gated like v2, so
// these wrappers go through an owner-authenticated BRIDGE route instead:
//   POST   /api/v1/apps/:slug/erp/collections/:collection
//   DELETE /api/v1/apps/:slug/erp/collections/:collection/:id
// The bridge asserts app ownership from the session, then re-derives the write
// token server-side and forwards to v2. The token never reaches the browser.
//
// Outcome shape (ErpMutateOutcome<T>) is unchanged, so callers keep the same
// ok/unavailable/error branching. Records are schemaless; the data API assigns
// id + createdAt on create. There is still no update route, so callers
// implement "edit" as deleteErpRecord + postErpRecord (delete+recreate), the
// same pattern the published templates' replaceRec() uses.
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/apps/:slug/erp/collections/:collection (auth'd, owner-only) —
 * append one record to a studio-owned collection. `record` is any JSON object
 * (< 8KB); the server stamps id + createdAt and echoes the stored record. A
 * 404/absent collection is created on first write. Never throws — network
 * failure and the server's own unavailability come back as typed outcomes.
 */
export async function postErpRecord<T = Record<string, unknown>>(
  storeSlug: string,
  collection: string,
  record: Record<string, unknown>
): Promise<ErpMutateOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(storeSlug)}/erp/collections/${encodeURIComponent(collection)}`
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(record),
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été enregistré.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown })
    | null;
  // 401/403 means the owner session is gone or the deployment can't write
  // (admin_writes_unavailable) → 'unavailable' so the caller degrades to
  // read-only rather than surfacing a scary error.
  if (
    data?.error === 'admin_writes_unavailable' ||
    res.status === 401 ||
    res.status === 403
  ) {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 429
        ? 'Trop de changements d’un coup — patientez un instant puis réessayez.'
        : typeof data?.message === 'string'
          ? (data.message as string)
          : `L’enregistrement a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  // SEC-1 contract note: the bridge route wraps its payload as
  // `{ ok: true, record }` (the house shape for owner-gated ERP mutations —
  // compare erpCaisseCreate's `{ ok, entry }`), whereas the data API's v1 route
  // this used to call returned the stored record BARE. Callers consume
  // `outcome.data` AS the record (e.g. admin-clients' addDebt does
  // `setCreances(prev => [outcome.data, ...prev])`), so unwrap here and keep the
  // ErpMutateOutcome contract unchanged. Without this the UI would prepend the
  // envelope: a row with no id (so it could never be settled) and no amount (so
  // the client's outstanding balance would not move), and a settled debt would
  // reappear as OPEN because `settled` would read undefined. The `?? data`
  // fallback keeps the bare-record shape working, so this wrapper stays correct
  // whichever route it is pointed at.
  const unwrapped =
    data && typeof data === 'object' && 'record' in data
      ? (data as { record?: unknown }).record
      : data;
  return { status: 'ok', data: (unwrapped ?? data) as T };
}

/**
 * DELETE /api/v1/apps/:slug/erp/collections/:collection/:id (auth'd, owner-only)
 * — remove one record by its data-API id. A 404 (already gone) converges to 'ok'
 * so the UI settles either way. Mirrors deleteErpWarehouse's outcome handling.
 */
export async function deleteErpRecord(
  storeSlug: string,
  collection: string,
  id: string
): Promise<ErpMutateOutcome<{ ok?: boolean }>> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(storeSlug)}/erp/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`
      ),
      {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été modifié.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown })
    | null;
  if (
    data?.error === 'admin_writes_unavailable' ||
    res.status === 401 ||
    res.status === 403
  ) {
    return { status: 'unavailable' };
  }
  // SEC-1: 404 is NO LONGER a benign "record already gone".
  //
  // On the data API's v1 route this used to call, a 404 meant exactly that, so
  // converging it to 'ok' let the UI settle idempotently. The owner-gated bridge
  // route has a different vocabulary: it answers 404 when the APP is not found
  // for this session (assertOwnsErpApp -> NotFound), and the data API itself
  // reports an already-deleted record as 200 {deleted:false}, never 404.
  //
  // Treating an ownership 404 as success would be actively harmful in
  // settleDebt: the delete would fake-succeed, the follow-up create would then
  // fail the same way, and the open debt would disappear from the merchant's
  // screen while still existing on the server. So a 404 is now a real error.
  if (!res.ok) {
    const message =
      res.status === 429
        ? 'Trop de changements d’un coup — patientez un instant puis réessayez.'
        : res.status === 404
          ? 'Boutique introuvable — rechargez la page puis réessayez.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `La suppression a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', data: { ok: true } };
}

// ---------------------------------------------------------------------------
// WSE-11 (R3-f) RAPPORTS — caisse month rollup for the studio Reports page. The
// deep reporting surface (reports.tsx) needs a period's cash summary; it reads
// ONE monthly caisse partition via the authed bridge route
//   GET /api/v1/apps/:slug/erp/caisse?month=YYYYMM → { collection, entries }
// and rolls the raw entries up client-side into in/out/net (+ pending-COD),
// mirroring the server's buildDayClose math (kind 'in'/'out', integer DZD,
// pending markers tracked apart). This is additive + fail-soft: a 404 (route
// absent / flag off) or a 502 data_api_unavailable resolves to 'unavailable' so
// the caller renders a quiet "activation en attente" state; only an unexpected
// failure is 'error'. Named distinctly (…Month) to avoid colliding with any
// sibling caisse wrapper merged the same round.
// ---------------------------------------------------------------------------

/** Client-rolled caisse totals for one month (mirrors DayCloseSummary math). */
export interface CaisseMonthTotals {
  /** The resolved partition, e.g. 'caisse-202607'. */
  collection: string;
  inTotal: number;
  outTotal: number;
  net: number;
  pendingCodTotal: number;
  entryCount: number;
}

export type CaisseMonthOutcome =
  | { status: 'ok'; totals: CaisseMonthTotals }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/**
 * GET /erp/caisse?month=YYYYMM and roll the raw entries up into month totals.
 * `month` must be 6 digits (YYYYMM); anything else lets the server default to
 * the current month. Pending-COD markers (`pending===true`) are summed apart
 * and excluded from in/out/net — they are expectations, not drawer movements.
 */
export async function fetchErpCaisseMonth(
  slug: string,
  month: string
): Promise<CaisseMonthOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(slug)}/erp/caisse?month=${encodeURIComponent(month)}`
      ),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement de la caisse.') };
  }
  const data = (await res.json().catch(() => null)) as
    | {
        collection?: string;
        entries?: unknown;
        error?: unknown;
        message?: unknown;
      }
    | null;
  // Route missing (flag off / older server) OR the data API is unreachable →
  // treat as a quiet "not activated yet" state, never a hard failure.
  if (res.status === 404 || data?.error === 'data_api_unavailable') {
    return { status: 'unavailable' };
  }
  if (data?.error === 'admin_writes_unavailable') {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous connecter pour voir la caisse.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible de charger la caisse (${res.status}).`;
    return { status: 'error', message };
  }
  const entries = Array.isArray(data?.entries)
    ? (data.entries as Array<Record<string, unknown>>)
    : [];
  let inTotal = 0;
  let outTotal = 0;
  let pendingCodTotal = 0;
  let entryCount = 0;
  for (const r of entries) {
    const amount = num(r?.amount);
    if (!(amount > 0)) continue;
    entryCount += 1;
    if (r?.pending === true) {
      pendingCodTotal += amount;
      continue;
    }
    const kind = String(r?.kind ?? '');
    if (kind === 'in') inTotal += amount;
    else if (kind === 'out') outTotal += amount;
  }
  return {
    status: 'ok',
    totals: {
      collection: typeof data?.collection === 'string' ? data.collection : '',
      inTotal,
      outTotal,
      net: inTotal - outTotal,
      pendingCodTotal,
      entryCount,
    },
  };
}

// ===========================================================================
// WSE-13 (R3-g) — ERP STAFF & ROLES wrappers (Portail). Owner-authed CRUD over
// the published-app staff auth (POST/GET /erp/staff, PUT/revoke), plus a small
// wa.me link helper. Every route is gated server-side by CDZ_ERP_STAFF_AUTH:
// while OFF the bridge returns a typed 404, which we surface as a discriminated
// 'disabled' outcome so the Équipe page renders a quiet "activation en attente"
// state instead of an error. All calls use credentials:'include' (owner session
// cookie), mirroring fetchErpInventory/postErpWarehouse above.
// ===========================================================================

// Declaration-merge the published staff-login flag onto the settings singleton
// (ErpSettings is declared earlier in this file). staffAuth==='1' turns the
// published ERP's staff-token login ON; absent/'0' keeps the legacy PIN. The
// bridge allowlist (normalizeErpSettings) must preserve this key — see NOTES.
export interface ErpSettings {
  /** '1' = published-app staff-token login; absent/'0' = legacy PIN (default). */
  staffAuth?: string;
}

/** The three ERP roles, matching StaffRole in cdz-data-token.ts (BE). */
export type StaffRoleId = 'owner' | 'manager' | 'staff';

/** A staff member as returned by GET/POST/PUT /erp/staff (NEVER any secret). */
export interface StaffMember {
  id: string;
  name: string;
  phone: string;
  role: string;
  active: boolean;
  createdAt: string;
}

/** FR role metadata for studio pickers + explainer (label + app-scope copy). */
export const STAFF_ROLE_META: Record<
  StaffRoleId,
  { label: string; scope: string }
> = {
  owner: {
    label: 'Propriétaire',
    scope: 'Tous les onglets, y compris Réglages et la gestion de l’équipe.',
  },
  manager: {
    label: 'Gérant',
    scope: 'Tous les onglets sauf Réglages (commandes, stock, clients, dépenses…).',
  },
  staff: {
    label: 'Employé',
    scope: 'Commandes uniquement — prise et suivi des commandes.',
  },
};

/** Result of GET /erp/staff: 'disabled' = flag OFF (404) → quiet gate. */
export type StaffListOutcome =
  | { status: 'ok'; staff: StaffMember[] }
  | { status: 'disabled' }
  | { status: 'error'; message: string };

/** Staff mutations: adds 'disabled' (flag-off 404) to the standard outcome. */
export type StaffMutateOutcome<T> =
  | { status: 'ok'; data: T }
  | { status: 'disabled' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** Normalize one raw staff row from the bridge to the pinned StaffMember shape. */
function toStaffMember(raw: unknown): StaffMember | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id || '');
  if (!id) return null;
  return {
    id,
    name: String(r.name || ''),
    phone: String(r.phone || ''),
    role: String(r.role || ''),
    active: r.active !== false,
    createdAt: String(r.createdAt || ''),
  };
}

/** Build a wa.me link for a DZ phone (0X… → 213X…); '' → bare wa.me. */
export function waHref(phone: string | undefined): string {
  let d = String(phone || '').replace(/[^0-9]/g, '');
  if (!d) return 'https://wa.me/';
  if (d.charAt(0) === '0') d = '213' + d.slice(1);
  return 'https://wa.me/' + d;
}

/** GET /api/v1/apps/:slug/erp/staff — list staff (owner-authed). */
export async function fetchStaff(slug: string): Promise<StaffListOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/staff`),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — impossible de charger l’équipe.') };
  }
  // 404 = CDZ_ERP_STAFF_AUTH off (route absent) → quiet "activation en attente".
  if (res.status === 404) {
    return { status: 'disabled' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { staff?: unknown; message?: unknown })
    | null;
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Connectez-vous pour gérer l’équipe.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible de charger l’équipe (${res.status}).`;
    return { status: 'error', message };
  }
  const staff = Array.isArray(data?.staff)
    ? (data.staff as unknown[])
        .map(toStaffMember)
        .filter((m): m is StaffMember => m != null)
    : [];
  return { status: 'ok', staff };
}

/** Shared response handler for the staff mutation routes (create/update/revoke). */
async function staffMutate<T>(
  path: string,
  method: 'POST' | 'PUT',
  body?: Record<string, unknown>
): Promise<StaffMutateOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl(path), {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été modifié.') };
  }
  // 404 = flag off (route absent) → 'disabled'. NOTE: the update/revoke routes
  // also 404 on a genuinely missing staff id, but that path only runs when the
  // list (same flag) already returned rows, so a 404 here means the flag flipped.
  if (res.status === 404) {
    return { status: 'disabled' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown })
    | null;
  if (data?.error === 'admin_writes_unavailable') {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Reconnectez-vous.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : res.status === 400 && typeof data?.message === 'string'
            ? (data.message as string)
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `L’opération a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', data: data as T };
}

/**
 * POST /api/v1/apps/:slug/erp/staff — create a staff member. Returns the record
 * PLUS a ONE-TIME staffToken (shown once; never re-derivable from the list).
 */
export function createStaff(
  slug: string,
  body: { name: string; phone?: string; role: StaffRoleId }
): Promise<StaffMutateOutcome<{ ok?: boolean; staff?: StaffMember; staffToken?: string }>> {
  return staffMutate(
    `/api/v1/apps/${encodeURIComponent(slug)}/erp/staff`,
    'POST',
    body
  );
}

/** PUT /api/v1/apps/:slug/erp/staff/:id — update role and/or active flag. */
export function updateStaff(
  slug: string,
  id: string,
  patch: { role?: StaffRoleId; active?: boolean }
): Promise<StaffMutateOutcome<{ ok?: boolean; staff?: StaffMember }>> {
  return staffMutate(
    `/api/v1/apps/${encodeURIComponent(slug)}/erp/staff/${encodeURIComponent(id)}`,
    'PUT',
    patch
  );
}

/**
 * POST /api/v1/apps/:slug/erp/staff/:id/revoke — rotate the revocation nonce
 * (every old token for this member dies immediately) and return a fresh
 * one-time staffToken so the owner can re-share access.
 */
export function revokeStaff(
  slug: string,
  id: string
): Promise<StaffMutateOutcome<{ ok?: boolean; staffToken?: string }>> {
  return staffMutate(
    `/api/v1/apps/${encodeURIComponent(slug)}/erp/staff/${encodeURIComponent(id)}/revoke`,
    'POST'
  );
}

// ---------------------------------------------------------------------------
// R3-h (WSB-4/5) — "Modifier avec l'IA" API layer. Thin wrappers over the R2
// shop-AI-edit + ShopState + staleness routes, each returning a discriminated
// outcome so the panel (shop-ai-edit.tsx) renders loading/error/quiet-gate
// states without guessing. Flag-gated routes (CDZ_SHOP_AI_EDIT / CDZ_SHOP_STATE
// / CDZ_FEATURES_ENABLED) 404 when OFF → surfaced as 'unavailable' so the UI
// quiet-gates to "bientôt" rather than erroring. All same-origin via cdzApiUrl +
// credentials:'include' (first-party session cookie), matching the wrappers
// above. NONE of these throw for a documented status — network faults degrade to
// a typed 'error'.
// ---------------------------------------------------------------------------

/** GET /api/v1/apps/:slug/source — recover the live storefront HTML (edit base). */
export type ShopSourceOutcome =
  | { status: 'ok'; html: string; source: string }
  | { status: 'unavailable' } // route 404 (CDZ_SHOP_AI_EDIT off) or app not found
  | { status: 'error'; message: string };

/**
 * GET the current published HTML for a store (server-side recovery so editing
 * works cross-device). A 404 means the flag is off OR the app is unknown →
 * 'unavailable' (caller quiet-gates). A 502 source_fetch_failed is a transient
 * recovery problem → typed 'error'.
 */
export async function fetchShopSource(slug: string): Promise<ShopSourceOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/source`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement de la boutique.') };
  }
  if (res.status === 404) {
    return { status: 'unavailable' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<{ html: string; source: string }> & { error?: unknown; message?: unknown })
    | null;
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible de récupérer la source (${res.status}).`;
    return { status: 'error', message };
  }
  const html = typeof data?.html === 'string' ? data.html : '';
  if (!html) {
    return { status: 'error', message: 'La source récupérée est vide — réessayez.' };
  }
  return {
    status: 'ok',
    html,
    source: typeof data?.source === 'string' ? data.source : 'render',
  };
}

/** POST /api/v1/apps/:slug/ai-edit response — does NOT deploy (FE previews then deploys). */
export type AiEditOutcome =
  | { status: 'ok'; html: string; bytes: number; seconds?: number; summary?: string }
  | { status: 'contract'; violations: string[]; message: string } // 422 contract_violation
  | { status: 'unavailable' } // route 404 (CDZ_SHOP_AI_EDIT off)
  | { status: 'error'; message: string };

/**
 * POST an AI edit instruction for a store. On 422 the shop-contract lint (+ one
 * server-side auto-retry) still failed → the violation list comes back so the
 * caller can show a friendly error + réessayer. On success the FULL edited HTML
 * comes back for a srcdoc preview; publishing goes through the existing deployApp
 * (same slug = cap-safe). Never throws for a documented status.
 */
export async function aiEditShop(
  slug: string,
  instruction: string
): Promise<AiEditOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/ai-edit`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ instruction }),
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — aucune modification effectuée.') };
  }
  if (res.status === 404) {
    return { status: 'unavailable' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<{
        ok: boolean;
        html: string;
        bytes: number;
        seconds: number;
        summary: string;
        error: string | { message?: string };
        violations: unknown;
        message: string;
      }>)
    | null;
  if (res.status === 422 && (data?.error as string) === 'contract_violation') {
    const violations = Array.isArray(data?.violations)
      ? (data.violations as unknown[]).map(v => String(v)).filter(Boolean)
      : [];
    return {
      status: 'contract',
      violations,
      message:
        typeof data?.message === 'string' && data.message
          ? data.message
          : 'La modification proposée casserait votre boutique.',
    };
  }
  if (!res.ok) {
    const message =
      typeof data?.error === 'object' && data.error?.message
        ? (data.error.message as string)
        : res.status === 401
          ? 'Veuillez vous reconnecter.'
          : res.status === 403
            ? 'Cette boutique appartient à un autre compte.'
            : res.status === 413
              ? 'Votre instruction est trop longue — raccourcissez-la.'
              : res.status === 502
                ? 'Le générateur est indisponible pour le moment — réessayez dans un instant.'
                : typeof data?.message === 'string'
                  ? (data.message as string)
                  : `La modification a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  const html = typeof data?.html === 'string' ? data.html : '';
  if (!html) {
    return { status: 'error', message: 'Le générateur a renvoyé une page vide — réessayez.' };
  }
  return {
    status: 'ok',
    html,
    bytes: typeof data?.bytes === 'number' ? data.bytes : html.length,
    ...(typeof data?.seconds === 'number' ? { seconds: data.seconds } : {}),
    ...(typeof data?.summary === 'string' && data.summary ? { summary: data.summary } : {}),
  };
}

/** One recorded ShopState version — METADATA only (HTML fetched via versions/:id). */
export interface ShopStateVersion {
  id: string;
  at: string;
  note: string;
  bytes: number;
}

/** One ShopState activity-log entry. */
export interface ShopStateLogEntry {
  at: string;
  kind: 'deploy' | 'ai' | 'feature' | 'appearance' | 'rollback' | 'note';
  note: string;
}

/** Client-safe ShopState projection (GET /state) — never carries raw HTML. */
export interface ShopStateMeta {
  templateId: string | null;
  featureSet: string[];
  hasAiPatch: boolean;
  versions: ShopStateVersion[];
  log: ShopStateLogEntry[];
}

export type ShopStateOutcome =
  | { status: 'ok'; state: ShopStateMeta }
  | { status: 'unavailable' } // route 404 (CDZ_SHOP_STATE off) or app not found
  | { status: 'error'; message: string };

/** GET /api/v1/apps/:slug/state — the server-side ShopState metadata + versions. */
export async function fetchShopState(slug: string): Promise<ShopStateOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/state`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement de l’historique.') };
  }
  if (res.status === 404) {
    return { status: 'unavailable' };
  }
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; state?: Partial<ShopStateMeta> & Record<string, unknown>; message?: unknown }
    | null;
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible de charger l’historique (${res.status}).`;
    return { status: 'error', message };
  }
  const s = (data?.state && typeof data.state === 'object' ? data.state : {}) as Record<
    string,
    unknown
  >;
  const versions = Array.isArray(s.versions)
    ? (s.versions as unknown[])
        .map(v => v as Partial<ShopStateVersion>)
        .filter(v => v && typeof v.id === 'string' && v.id)
        .map(v => ({
          id: String(v.id),
          at: typeof v.at === 'string' ? v.at : '',
          note: typeof v.note === 'string' ? v.note : '',
          bytes: typeof v.bytes === 'number' ? v.bytes : 0,
        }))
    : [];
  const log = Array.isArray(s.log)
    ? (s.log as unknown[])
        .map(l => l as Partial<ShopStateLogEntry>)
        .filter(l => l && typeof l.kind === 'string')
        .map(l => ({
          at: typeof l.at === 'string' ? l.at : '',
          kind: (l.kind as ShopStateLogEntry['kind']) || 'note',
          note: typeof l.note === 'string' ? l.note : '',
        }))
    : [];
  return {
    status: 'ok',
    state: {
      templateId: typeof s.templateId === 'string' ? s.templateId : null,
      featureSet: Array.isArray(s.featureSet)
        ? (s.featureSet as unknown[]).map(f => String(f)).filter(Boolean)
        : [],
      hasAiPatch: s.hasAiPatch === true,
      versions,
      log,
    },
  };
}

export type ShopStateVersionOutcome =
  | { status: 'ok'; html: string; bytes: number }
  | { status: 'not-found' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** GET /api/v1/apps/:slug/state/versions/:id — one version's full HTML. */
export async function fetchShopStateVersion(
  slug: string,
  versionId: string
): Promise<ShopStateVersionOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(slug)}/state/versions/${encodeURIComponent(versionId)}`
      ),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement de la version.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<{ html: string; bytes: number }> & { message?: unknown })
    | null;
  if (res.status === 404) {
    // Ambiguous (flag off vs unknown id); the caller treats both as recoverable.
    return { status: 'not-found' };
  }
  if (!res.ok) {
    const message =
      typeof data?.message === 'string'
        ? (data.message as string)
        : `Impossible de charger la version (${res.status}).`;
    return { status: 'error', message };
  }
  const html = typeof data?.html === 'string' ? data.html : '';
  return {
    status: 'ok',
    html,
    bytes: typeof data?.bytes === 'number' ? data.bytes : html.length,
  };
}

// NOTE: no `unavailable` member — rollbackShopState never produces one (every
// non-ok path maps to not-found / writes-blocked / error), and a phantom member
// breaks the caller's `not-found ? … : out.message` narrowing in shop-ai-edit.
export type RollbackOutcome =
  | { status: 'ok'; url: string; rolledBackTo: string }
  | { status: 'not-found' }
  | { status: 'writes-blocked' }
  | { status: 'error'; message: string };

/**
 * POST /api/v1/apps/:slug/state/rollback { versionId } — re-deploy that version's
 * HTML under the same slug (idempotent, never trips the publish cap) and record a
 * fresh append-only history point. Never throws for a documented status.
 */
export async function rollbackShopState(
  slug: string,
  versionId: string
): Promise<RollbackOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/state/rollback`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ versionId }),
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — aucune restauration effectuée.') };
  }
  if (res.status === 404) {
    return { status: 'not-found' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<{ url: string; deploymentUrl: string; rolledBackTo: string }> & {
        error?: unknown;
        message?: unknown;
      })
    | null;
  if (data?.error === 'admin_writes_unavailable') {
    return { status: 'writes-blocked' };
  }
  if (!res.ok) {
    const message =
      typeof data?.error === 'object' && (data.error as { message?: string })?.message
        ? ((data.error as { message?: string }).message as string)
        : res.status === 401
          ? 'Veuillez vous reconnecter.'
          : res.status === 403
            ? 'Cette boutique appartient à un autre compte.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `La restauration a échoué (${res.status}).`;
    return { status: 'error', message };
  }
  return {
    status: 'ok',
    url: String(data?.url || data?.deploymentUrl || ''),
    rolledBackTo: typeof data?.rolledBackTo === 'string' ? data.rolledBackTo : versionId,
  };
}

/** GET /api/v1/apps/:slug/staleness — model-version drift hint. */
export type StalenessOutcome =
  | { status: 'ok'; stale: boolean; from?: string; to?: string; templateId?: string }
  | { status: 'unavailable' } // route 404 (CDZ_FEATURES_ENABLED off)
  | { status: 'error'; message: string };

/**
 * GET the staleness status for a store. The route is fail-soft server-side
 * (never 5xx for a source problem → { stale:false }); here a 404 (flag off) maps
 * to 'unavailable' so the caller simply hides the hint.
 */
export async function fetchStaleness(slug: string): Promise<StalenessOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/staleness`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau.') };
  }
  if (res.status === 404) {
    return { status: 'unavailable' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<{ stale: boolean; from: string; to: string; templateId: string }> & {
        message?: unknown;
      })
    | null;
  if (!res.ok) {
    return { status: 'error', message: `Impossible de vérifier la version (${res.status}).` };
  }
  return {
    status: 'ok',
    stale: data?.stale === true,
    ...(typeof data?.from === 'string' ? { from: data.from } : {}),
    ...(typeof data?.to === 'string' ? { to: data.to } : {}),
    ...(typeof data?.templateId === 'string' ? { templateId: data.templateId } : {}),
  };
}

export type FeatureParamValue = string | number | boolean;

/** POST /customize body — a {features,params} diff (+ optional appearance). */
export interface CustomizeBody {
  features?: string[];
  params?: Record<string, FeatureParamValue>;
  appearance?: Partial<ErpSettings>;
}

export type CustomizeOutcome =
  | { status: 'ok'; settings: ErpSettings; remint: boolean; url?: string }
  | { status: 'unavailable' }
  | { status: 'not-found' }
  | { status: 'cap' }
  | { status: 'upgrade' }
  | { status: 'error'; message: string };

/**
 * POST /api/v1/apps/:slug/customize — apply a feature/param/appearance diff.
 * Never throws for the documented 402/404/409 — those come back as typed
 * outcomes so the UI can quiet-gate (404), prompt (409 cap), or upsell (402).
 */
export async function customizeApp(
  slug: string,
  body: CustomizeBody
): Promise<CustomizeOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/customize`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été modifié.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<{
        ok: boolean;
        settings: ErpSettings;
        remint: boolean;
        url: string;
        error: string | { message?: string };
        limit: number;
        existing: Array<{ slug: string; url: string }>;
      }> & { message?: unknown })
    | null;
  // Route absent (CDZ_FEATURES_ENABLED off) → let the caller show the quiet gate.
  if (res.status === 404) {
    return { status: 'not-found' };
  }
  if (data?.error === 'admin_writes_unavailable') {
    return { status: 'unavailable' };
  }
  if (res.status === 409 && (data?.error as string) === 'publish_limit_reached') {
    return { status: 'cap' };
  }
  if (res.status === 402 || (data?.error as string) === 'upgrade_required') {
    return { status: 'upgrade' };
  }
  if (!res.ok) {
    const message =
      typeof data?.error === 'object' && data.error?.message
        ? (data.error.message as string)
        : res.status === 401
          ? 'Veuillez vous reconnecter.'
          : res.status === 403
            ? 'Cette boutique appartient à un autre compte.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `Impossible d’appliquer les modifications (${res.status}).`;
    return { status: 'error', message };
  }
  return {
    status: 'ok',
    settings: (data?.settings && typeof data.settings === 'object'
      ? data.settings
      : {}) as ErpSettings,
    remint: data?.remint === true,
    ...(typeof data?.url === 'string' && data.url ? { url: data.url } : {}),
  };
}

/** The per-feature enablement + params view the /customize GET side returns. */
export interface AppFeaturesState {
  features: string[];
  params: Record<string, FeatureParamValue>;
}

export type AppFeaturesOutcome =
  | { status: 'ok'; state: AppFeaturesState }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/**
 * GET /api/v1/apps/:slug/customize — read the live feature-set + params for a
 * shop. The Fonctionnalités tab seeds its draft from the settings singleton it
 * already has (via the ERP summary), so this is provided for the AI-hook / any
 * caller that needs the enablement view standalone. A 404 (flag off) or an
 * app-not-found is reported as 'unavailable' so callers degrade quietly.
 */
export async function fetchAppFeatures(
  slug: string
): Promise<AppFeaturesOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/customize`),
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include' }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau lors du chargement des fonctionnalités.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<AppFeaturesState> & { error?: unknown; message?: unknown })
    | null;
  // 404 = route missing (flag off) OR app not found → degrade quietly.
  if (res.status === 404) {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous connecter pour voir les fonctionnalités.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible de charger les fonctionnalités (${res.status}).`;
    return { status: 'error', message };
  }
  return {
    status: 'ok',
    state: {
      features: Array.isArray(data?.features)
        ? (data.features as unknown[]).map(f => String(f)).filter(Boolean)
        : [],
      params:
        data?.params && typeof data.params === 'object'
          ? (data.params as Record<string, FeatureParamValue>)
          : {},
    },
  };
}

// ---------------------------------------------------------------------------
// C7 APPEARANCE — theme / layout-template / font / section catalogs. These are
// the SINGLE source of the id strings the Shop Appearance editor writes into
// the settings singleton (POST /erp/settings). The ids MUST match SHOP-TEMPLATE
// (clickdz-shop-template.ts), which maps each id → :root vars / layout, and the
// BRIDGE-BE allowlist (normalizeErpSettings), which validates them. We store
// IDS ONLY (never raw CSS) to respect the 8KB settings cap. Every DEFAULT below
// is chosen so an unset field renders today's look (byte-identical legacy).
//   theme:    classic | dark | vibrant | minimal        (default 'classic')
//   template: standard | boutique                       (default 'standard')
//   font:     system | inter | georgia | helvetica | mono (default 'system')
//   sections: CSV of { hero, trust, categories }         (default all on)
// The `preview` fields drive the lightweight in-app preview only — the deployed
// storefront's authoritative styling comes from SHOP-TEMPLATE reading settings.
// ---------------------------------------------------------------------------

export interface ThemeOption {
  id: string;
  label: string;
  hint: string;
  /** Preview-only swatches (bg / surface / ink) — NOT the deployed CSS. */
  preview: { bg: string; card: string; ink: string; line: string };
}

/** Theme presets — order = display order; first is the default ('classic'). */
export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'classic',
    label: 'Classique',
    hint: 'Le look d’aujourd’hui — clair, aéré, teinte sarcelle.',
    preview: { bg: '#f6f7f9', card: '#ffffff', ink: '#0f172a', line: '#e5e7eb' },
  },
  {
    id: 'dark',
    label: 'Sombre',
    hint: 'Surfaces neutres profondes avec un accent lumineux.',
    preview: { bg: '#0b0f19', card: '#151b2b', ink: '#e8ecf4', line: '#26304a' },
  },
  {
    id: 'vibrant',
    label: 'Vibrant',
    hint: 'Chaleureux, très contrasté, dégradés d’accent percutants.',
    preview: { bg: '#fff7ed', card: '#ffffff', ink: '#1f130a', line: '#f3d9bf' },
  },
  {
    id: 'minimal',
    label: 'Minimal',
    hint: 'Plat, monochrome, lignes fines — le contenu avant tout.',
    preview: { bg: '#ffffff', card: '#ffffff', ink: '#111111', line: '#ececec' },
  },
  // Market themes — each one is a distinct design (surfaces, ink, status
  // colours, shadow depth AND corner radius), aimed at a real DZ merchant
  // segment rather than being a palette swap of the four above.
  {
    id: 'sahara',
    label: 'Sahara',
    hint: 'Sable chaud et terracotta — pâtisserie, épicerie, produits du terroir.',
    preview: { bg: '#faf5ec', card: '#fffdf8', ink: '#3b2f23', line: '#eadfcc' },
  },
  {
    id: 'nuit-doree',
    label: 'Nuit dorée',
    hint: 'Noir profond et or — bijouterie, parfumerie, cosmétique premium.',
    preview: { bg: '#101014', card: '#1a1a20', ink: '#ece7db', line: '#2a2a31' },
  },
  {
    id: 'olive',
    label: 'Olive',
    hint: 'Crème et olive — élégant et calme, mode modeste.',
    preview: { bg: '#f8f7f2', card: '#ffffff', ink: '#26301c', line: '#e4e4d8' },
  },
  {
    id: 'azur',
    label: 'Azur',
    hint: 'Bleu ardoise net — électronique, téléphonie, revendeur officiel.',
    preview: { bg: '#f1f5f9', card: '#ffffff', ink: '#0c1a2b', line: '#dbe4ee' },
  },
  {
    id: 'flash',
    label: 'Flash',
    hint: 'Noir et rouge vif — promos, arrivages, énergie des ventes flash.',
    preview: { bg: '#0d0d0f', card: '#17171b', ink: '#f4f4f5', line: '#26262c' },
  },
];

export interface TemplateOption {
  id: string;
  label: string;
  hint: string;
}

/** Layout templates — first is the default ('standard'). */
export const TEMPLATE_OPTIONS: TemplateOption[] = [
  {
    id: 'standard',
    label: 'Standard',
    hint: 'Bandeau hero + rail de catégories + grille de produits (par défaut).',
  },
  {
    id: 'boutique',
    label: 'Boutique',
    hint: 'En-tête éditorial compact, cartes plus grandes, sans bandeau hero.',
  },
  // These two were already fully implemented in the storefront template AND
  // allowlisted server-side (ERP_TEMPLATE_IDS) — they were simply missing from
  // this list, so no merchant could ever pick them. Reachable before only if a
  // wizard vertical preset happened to set them.
  {
    id: 'grid-dense',
    label: 'Grille dense',
    hint: 'En-tête compact, grille serrée — pour les gros catalogues.',
  },
  {
    id: 'editorial-split',
    label: 'Éditorial',
    hint: 'Hero asymétrique avec une grande photo produit.',
  },
  {
    id: 'landing',
    label: 'Page produit',
    hint: 'Un seul produit en vedette, gros bouton commander — idéal pub Facebook.',
  },
];

export interface RadiusOption {
  id: string;
  label: string;
  hint: string;
}

/** Corner style. 'auto' defers to the theme, which is what every shop had before
    this control existed. */
export const RADIUS_OPTIONS: RadiusOption[] = [
  {
    id: 'auto',
    label: 'Selon le thème',
    hint: 'Garde les coins du thème choisi.',
  },
  { id: 'carre', label: 'Carré', hint: 'Coins nets — technique, officiel.' },
  { id: 'doux', label: 'Doux', hint: 'Légèrement arrondi — équilibré.' },
  { id: 'arrondi', label: 'Arrondi', hint: 'Coins généreux — chaleureux.' },
];

export const DEFAULT_RADIUS = 'auto';

export function resolveRadius(id: unknown): RadiusOption {
  const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
  return RADIUS_OPTIONS.find(r => r.id === key) ?? RADIUS_OPTIONS[0];
}

export interface FontOption {
  id: string;
  label: string;
  /** Preview-only CSS font stack; SHOP-TEMPLATE owns the deployed --font. */
  stack: string;
}

/** Curated fonts — ids map to a --font stack in SHOP-TEMPLATE. */
export const FONT_OPTIONS: FontOption[] = [
  {
    id: 'system',
    label: 'Système',
    stack:
      "'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,'Noto Sans Arabic',sans-serif",
  },
  {
    id: 'inter',
    label: 'Inter',
    stack: "'Inter',system-ui,-apple-system,Segoe UI,Arial,sans-serif",
  },
  {
    id: 'poppins',
    label: 'Poppins',
    stack: "'Poppins',system-ui,-apple-system,Segoe UI,Arial,sans-serif",
  },
  {
    id: 'playfair',
    label: 'Playfair',
    stack: "'Playfair Display',Georgia,'Times New Roman',Times,serif",
  },
];

export interface SectionOption {
  id: string;
  label: string;
  hint: string;
}

/** Toggleable storefront sections — all enabled by default. */
export const SECTION_OPTIONS: SectionOption[] = [
  { id: 'hero', label: 'Bandeau hero', hint: 'Le bandeau titre + appel à l’action.' },
  { id: 'trust', label: 'Bandeau de confiance', hint: 'La ligne de réassurance paiement à la livraison / livraison / support.' },
  {
    id: 'categories',
    label: 'Rail de catégories',
    hint: 'Les puces de filtre de catégories horizontales.',
  },
];

export const DEFAULT_THEME = 'classic';
export const DEFAULT_TEMPLATE = 'standard';
export const DEFAULT_FONT = 'system';
/** Default = every section enabled (today's storefront shows them all). */
export const DEFAULT_SECTIONS: string[] = SECTION_OPTIONS.map(s => s.id);

/** Resolve a stored theme id to a known option (falls back to the default). */
export function resolveTheme(id: string | undefined): ThemeOption {
  return THEME_OPTIONS.find(t => t.id === id) ?? THEME_OPTIONS[0];
}
export function resolveTemplate(id: string | undefined): TemplateOption {
  return TEMPLATE_OPTIONS.find(t => t.id === id) ?? TEMPLATE_OPTIONS[0];
}
export function resolveFont(id: string | undefined): FontOption {
  return FONT_OPTIONS.find(f => f.id === id) ?? FONT_OPTIONS[0];
}

/** Parse the compact sections CSV → the set of enabled ids (unset = all on). */
export function parseSections(csv: string | undefined): string[] {
  if (csv == null || csv === '') return [...DEFAULT_SECTIONS];
  const wanted = String(csv)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const enabled = SECTION_OPTIONS.filter(s => wanted.includes(s.id)).map(
    s => s.id
  );
  // An explicit empty-but-present value means "all off"; only fall back to the
  // default when nothing recognizable was stored at all.
  return enabled;
}

/** Serialize enabled section ids back to the stored CSV (stable order). */
export function serializeSections(enabled: string[]): string {
  return SECTION_OPTIONS.filter(s => enabled.includes(s.id))
    .map(s => s.id)
    .join(',');
}

// ---------------------------------------------------------------------------
// Republish helper — after saving appearance to the settings singleton, the
// deployed storefront only reflects it on its next load IF it re-reads settings
// (SHOP-TEMPLATE's runtime applyTheme). We re-deploy the store's staged HTML
// under the SAME slug (idempotent — an existing slug never trips the publish
// cap) so a fresh copy goes live immediately; the HTML itself is unchanged, so
// this is safe even before SHOP-TEMPLATE lands. The source HTML is read from
// the shared studio shelf (artifactStore `app_<slug>`), exactly as the wizard's
// ERP-publish flow does. Degrades cleanly: if no shelf HTML is present we report
// 'no-source' and the caller tells the user to re-publish from Manage/Studio.
// ---------------------------------------------------------------------------

export type RepublishOutcome =
  | { status: 'ok'; url: string }
  | { status: 'no-source' }
  | { status: 'cap' }
  | { status: 'upgrade' }
  | { status: 'error'; message: string };

/**
 * Re-deploy the store's storefront (by slug) from its staged shelf HTML so the
 * live site re-fetches the updated settings singleton. `storeSlug`/`kind` are
 * forwarded so the publish record keeps its pairing + label.
 */
export async function republishShop(input: {
  slug: string;
  storeSlug?: string;
  kind?: 'shop' | 'erp';
}): Promise<RepublishOutcome> {
  const art = artifactStore.get(`app_${input.slug}`);
  const html = art?.payload;
  if (!html || html.length < 20) {
    return { status: 'no-source' };
  }
  const outcome = await deployApp({
    html,
    slug: input.slug,
    ...(input.kind ?? art?.kind ? { kind: (input.kind ?? art?.kind) as 'shop' | 'erp' } : {}),
    ...(input.storeSlug ?? art?.storeSlug
      ? { storeSlug: (input.storeSlug ?? art?.storeSlug) as string }
      : {}),
  });
  if (outcome.status === 'ok') {
    // Keep the shelf URL fresh so later reads/links stay correct.
    if (art) {
      artifactStore.upsert({ ...art, url: outcome.result.url });
    }
    return { status: 'ok', url: outcome.result.url };
  }
  if (outcome.status === 'cap') return { status: 'cap' };
  if (outcome.status === 'upgrade') return { status: 'upgrade' };
  return { status: 'error', message: outcome.message };
}

// ---------------------------------------------------------------------------
// C4 INVENTORY v2 — multi-warehouse stock on the data API. The bridge exposes
// authed owner-only routes that read/merge the monthly-partitioned `movements`
// ledger + the `warehouses` collection server-side and roll up per-(product,
// warehouse) balances. Shapes below mirror the C4 contract EXACTLY:
//   GET  /api/v1/apps/:slug/erp/inventory
//        → { warehouses, stockByProduct:{[productKey]:{[warehouseId]:qty,total}}, lowStock }
//   POST /api/v1/apps/:slug/erp/inventory/movement
//        { productKey, warehouseId, delta, reason, ref? } → { ok, stock }
//   POST   /api/v1/apps/:slug/erp/warehouse   { name, location? }
//   DELETE /api/v1/apps/:slug/erp/warehouse/:id
// All via cdzApiUrl + credentials:'include' (first-party session cookie). When
// no warehouse exists yet the table degrades to the product.stock roll-up.
// ---------------------------------------------------------------------------

export interface Warehouse {
  id: string;
  name: string;
  location?: string;
  createdAt?: string;
}

/** The five ledger reasons — byte-exact with the C4 backend movement contract. */
export const MOVEMENT_REASONS = [
  'purchase',
  'sale',
  'adjust',
  'return',
  'transfer',
] as const;
export type MovementReason = (typeof MOVEMENT_REASONS)[number];

/** French labels for the reasons (this surface is French where the shop is). */
export const MOVEMENT_REASON_LABELS: Record<MovementReason, string> = {
  purchase: 'Achat (entrée)',
  sale: 'Vente (sortie)',
  adjust: 'Ajustement',
  return: 'Retour',
  transfer: 'Transfert',
};

/** Per-warehouse quantities for one product + the rolled-up total. */
export interface ProductStock {
  total: number;
  [warehouseId: string]: number;
}

/** GET /erp/inventory response (C4 contract). */
export interface ErpInventory {
  warehouses: Warehouse[];
  stockByProduct: Record<string, ProductStock>;
  lowStock: ErpProduct[];
}

export type ErpInventoryOutcome =
  | { status: 'ok'; inventory: ErpInventory }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** Coerce the raw stockByProduct map into a well-typed, numeric structure. */
function normalizeStockByProduct(
  raw: unknown
): Record<string, ProductStock> {
  const out: Record<string, ProductStock> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue;
    const entry: ProductStock = { total: 0 };
    for (const [wid, qty] of Object.entries(val as Record<string, unknown>)) {
      entry[wid] = num(qty);
    }
    entry.total = num((val as Record<string, unknown>).total);
    out[key] = entry;
  }
  return out;
}

/** GET the authed per-shop inventory (warehouses + per-warehouse balances). */
export async function fetchErpInventory(
  slug: string
): Promise<ErpInventoryOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/inventory`),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      }
    );
  } catch {
    return {
      status: 'error',
      message: netErrorMessage('Erreur réseau lors du chargement du stock.'),
    };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<ErpInventory> & { error?: unknown; message?: unknown })
    | null;
  // The route may not exist on an older server, or writes may be unavailable —
  // treat both as a graceful "degrade to product.stock totals" signal.
  if (
    data?.error === 'admin_writes_unavailable' ||
    data?.error === 'inventory_unavailable'
  ) {
    return { status: 'unavailable' };
  }
  if (res.status === 404) {
    // Ambiguous: could be the app OR the route missing. Let the caller fall
    // back to the product.stock roll-up rather than hard-failing.
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous connecter pour voir le stock.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible de charger le stock (${res.status}).`;
    return { status: 'error', message };
  }
  return {
    status: 'ok',
    inventory: {
      warehouses: Array.isArray(data?.warehouses)
        ? (data.warehouses as unknown[])
            .map(w => w as Partial<Warehouse>)
            .filter(w => w && typeof w.id === 'string' && w.id)
            .map(w => ({
              id: String(w.id),
              name: String(w.name || w.id),
              ...(w.location ? { location: String(w.location) } : {}),
              ...(w.createdAt ? { createdAt: String(w.createdAt) } : {}),
            }))
        : [],
      stockByProduct: normalizeStockByProduct(data?.stockByProduct),
      lowStock: Array.isArray(data?.lowStock)
        ? (data.lowStock as ErpProduct[])
        : [],
    },
  };
}

/**
 * POST /erp/inventory/movement — append one ledger entry (delta ±) for a
 * (product, warehouse) pair and roll the product.stock total forward. Returns
 * the updated stock snapshot the backend recomputed.
 */
export async function postErpMovement(
  slug: string,
  body: {
    productKey: string;
    warehouseId: string;
    delta: number;
    reason: MovementReason;
    ref?: string;
  }
): Promise<ErpMutateOutcome<{ ok?: boolean; stock?: ProductStock }>> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(slug)}/erp/inventory/movement`
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été modifié.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown })
    | null;
  if (data?.error === 'admin_writes_unavailable') {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : res.status === 404
            ? 'Introuvable — actualisez et réessayez.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `The movement failed (${res.status}).`;
    return { status: 'error', message };
  }
  return {
    status: 'ok',
    data: data as { ok?: boolean; stock?: ProductStock },
  };
}

/** POST /erp/warehouse — create a warehouse (name + optional location). */
export async function postErpWarehouse(
  slug: string,
  body: { name: string; location?: string }
): Promise<ErpMutateOutcome<{ ok?: boolean; warehouse?: Warehouse }>> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/warehouse`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été modifié.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown })
    | null;
  if (data?.error === 'admin_writes_unavailable') {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible d’ajouter l’entrepôt (${res.status}).`;
    return { status: 'error', message };
  }
  return {
    status: 'ok',
    data: data as { ok?: boolean; warehouse?: Warehouse },
  };
}

/** DELETE /erp/warehouse/:id — remove a warehouse by id. */
export async function deleteErpWarehouse(
  slug: string,
  warehouseId: string
): Promise<ErpMutateOutcome<{ ok?: boolean }>> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(
        `/api/v1/apps/${encodeURIComponent(slug)}/erp/warehouse/${encodeURIComponent(warehouseId)}`
      ),
      {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      }
    );
  } catch {
    return { status: 'error', message: netErrorMessage('Erreur réseau — rien n’a été modifié.') };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; message?: unknown })
    | null;
  if (data?.error === 'admin_writes_unavailable') {
    return { status: 'unavailable' };
  }
  // 404 = already gone → converge (the row disappears either way).
  if (!res.ok && res.status !== 404) {
    const message =
      res.status === 401
        ? 'Veuillez vous reconnecter.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible de supprimer l’entrepôt (${res.status}).`;
    return { status: 'error', message };
  }
  return { status: 'ok', data: { ok: true } };
}

// ---------------------------------------------------------------------------
// C5 PIM AI descriptions — the bridge grounds a cdz-flash prompt strictly in a
// product's canonical attributes and returns copy the owner previews + applies.
//   POST /api/v1/apps/:slug/erp/describe { productKey, tone?, lang? }
//        → { description, bullets? }
// Fail-closed: a planner-down 502 surfaces as an error state; the caller keeps
// the manual description editor fully usable.
// ---------------------------------------------------------------------------

export interface DescribeResult {
  description: string;
  bullets?: string[];
}

export type DescribeOutcome =
  | { status: 'ok'; result: DescribeResult }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** POST /erp/describe — generate a grounded product description + bullets. */
export async function postErpDescribe(
  slug: string,
  body: { productKey: string; tone?: string; lang?: string }
): Promise<DescribeOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/erp/describe`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      }
    );
  } catch {
    return {
      status: 'error',
      message: netErrorMessage('Erreur réseau lors de la génération de la description.'),
    };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<DescribeResult> & { error?: unknown; message?: unknown })
    | null;
  if (data?.error === 'admin_writes_unavailable') {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    // 502 = the AI planner is down/misbehaving → a soft, retryable message.
    const message =
      res.status === 502
        ? 'Le générateur de description est indisponible pour le moment — veuillez réessayer dans un instant.'
        : res.status === 401
          ? 'Veuillez vous reconnecter.'
          : res.status === 403
            ? 'Cette boutique appartient à un autre compte.'
            : res.status === 404
              ? 'Ce produit est introuvable — actualisez et réessayez.'
              : typeof data?.message === 'string'
                ? (data.message as string)
                : `Impossible de générer une description (${res.status}).`;
    return { status: 'error', message };
  }
  const description =
    typeof data?.description === 'string' ? data.description : '';
  if (!description) {
    return {
      status: 'error',
      message: 'Le générateur a renvoyé une description vide — veuillez réessayer.',
    };
  }
  return {
    status: 'ok',
    result: {
      description,
      ...(Array.isArray(data?.bullets)
        ? { bullets: data.bullets.map(b => String(b)).filter(Boolean) }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// C6 CHARGILY payments — merchant secret lives in a PRIVATE Redis store (never
// the public settings singleton); the FE only ever sees a masked view. Routes:
//   PUT /api/v1/apps/:slug/pay/chargily { apiSecret, mode:'test'|'live', enabled }
//   GET /api/v1/apps/:slug/pay/chargily → { configured, mode, enabled, maskedKey }
// The "Accept online payments" toggle is a NON-sensitive flag → it rides the
// EXISTING erp/settings route as settings.onlinePay (postErpSettings). When
// Chargily is not configured the storefront simply stays cash-on-delivery only.
// ---------------------------------------------------------------------------

export type ChargilyMode = 'test' | 'live';

/** GET /pay/chargily response — masked-only, never the full secret. */
export interface ChargilyStatus {
  configured: boolean;
  mode: ChargilyMode;
  enabled: boolean;
  maskedKey: string;
}

export type ChargilyStatusOutcome =
  | { status: 'ok'; chargily: ChargilyStatus }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** GET the masked Chargily configuration state for this shop. */
export async function fetchChargilyStatus(
  slug: string
): Promise<ChargilyStatusOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/pay/chargily`),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      }
    );
  } catch {
    return {
      status: 'error',
      message: netErrorMessage('Erreur réseau lors du chargement des paramètres de paiement.'),
    };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<ChargilyStatus> & { error?: unknown; message?: unknown })
    | null;
  if (res.status === 404) {
    // Route not present on this server → treat as "not available", COD only.
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Veuillez vous connecter pour voir les paramètres de paiement.'
        : res.status === 403
          ? 'Cette boutique appartient à un autre compte.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Impossible de charger les paramètres de paiement (${res.status}).`;
    return { status: 'error', message };
  }
  const mode: ChargilyMode = data?.mode === 'live' ? 'live' : 'test';
  return {
    status: 'ok',
    chargily: {
      configured: data?.configured === true,
      mode,
      enabled: data?.enabled === true,
      maskedKey: typeof data?.maskedKey === 'string' ? data.maskedKey : '',
    },
  };
}

/**
 * PUT /pay/chargily — store/update the merchant secret + mode + enabled flag.
 * `apiSecret` is optional on an UPDATE (omit to keep the stored key while just
 * flipping mode/enabled); the backend keeps it private and echoes masked only.
 */
export async function putChargily(
  slug: string,
  body: { apiSecret?: string; mode: ChargilyMode; enabled: boolean }
): Promise<ChargilyStatusOutcome> {
  let res: Response;
  try {
    res = await fetch(
      cdzApiUrl(`/api/v1/apps/${encodeURIComponent(slug)}/pay/chargily`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      }
    );
  } catch {
    return {
      status: 'error',
      message: netErrorMessage('Erreur réseau — les paramètres de paiement n’ont pas été enregistrés.'),
    };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<ChargilyStatus> & { error?: unknown; message?: unknown })
    | null;
  if (res.status === 404) {
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    const message =
      res.status === 400
        ? typeof data?.message === 'string'
          ? (data.message as string)
          : 'Cette clé secrète API semble invalide — veuillez la vérifier et réessayer.'
        : res.status === 401
          ? 'Veuillez vous reconnecter.'
          : res.status === 403
            ? 'Cette boutique appartient à un autre compte.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `Impossible d’enregistrer les paramètres de paiement (${res.status}).`;
    return { status: 'error', message };
  }
  const mode: ChargilyMode = data?.mode === 'live' ? 'live' : body.mode;
  return {
    status: 'ok',
    chargily: {
      configured:
        data?.configured === true ||
        (!!body.apiSecret && body.apiSecret.trim().length > 0),
      mode,
      enabled: data?.enabled === true ? true : body.enabled,
      maskedKey: typeof data?.maskedKey === 'string' ? data.maskedKey : '',
    },
  };
}

// ---------------------------------------------------------------------------
// Client-side settings validation — mirrors the C5 server rules so the wizard
// blocks bad input before any network call (the server re-validates anyway).
// ---------------------------------------------------------------------------

export const WHATSAPP_RE = /^[0-9]{8,15}$/;
export const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
export const PIN_RE = /^[0-9]{4,8}$/;

export function validateStoreName(v: string): string | null {
  const name = v.trim();
  if (name.length === 0) return 'Entrez un nom de boutique.';
  if (name.length > 60) return 'Limitez le nom à 60 caractères.';
  return null;
}
export function validateWhatsapp(v: string): string | null {
  if (!WHATSAPP_RE.test(v)) {
    return 'Chiffres uniquement, 8 à 15, sans « + » (ex. 213600000000).';
  }
  return null;
}
export function validateAccent(v: string): string | null {
  if (!ACCENT_RE.test(v)) return 'Utilisez une couleur hexadécimale comme #0f766e.';
  return null;
}
export function validatePin(v: string): string | null {
  if (!PIN_RE.test(v)) return 'Utilisez 4 à 8 chiffres.';
  return null;
}

// ---------------------------------------------------------------------------
// Small inline-styled shared UI (no exports from a .css.ts, per house rules).
// ---------------------------------------------------------------------------

export const codeStyle: CSSProperties = {
  fontFamily: 'var(--affine-font-code-family, monospace)',
  fontSize: 11.5,
  padding: '2px 7px',
  borderRadius: 6,
  background:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 16%, transparent)',
  color: 'var(--affine-text-primary-color, #ececec)',
  border: '1px solid color-mix(in srgb, var(--affine-primary-color, #1e96eb) 28%, transparent)',
  // Prevent the slug badge from wrapping its own text onto a second line on
  // narrow viewports — the outer title row already handles overflow via
  // textOverflow on the shop-name span.
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

export const linkBtnStyle: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer',
  color: 'var(--affine-primary-color, #1e96eb)',
  textDecoration: 'underline',
};

// Primary / secondary / danger button style factory (shared by both views).
export function btnStyle(
  variant: 'primary' | 'secondary' | 'danger',
  disabled = false
): CSSProperties {
  const base: CSSProperties = {
    appearance: 'none',
    borderRadius: 999,
    padding: '9px 18px',
    fontSize: 13,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'background 160ms ease, border-color 160ms ease, opacity 160ms ease',
  };
  if (variant === 'primary') {
    return { ...base, border: 'none', color: '#fff', background: C.accent };
  }
  if (variant === 'danger') {
    return {
      ...base,
      border: `1px solid ${C.errBorder}`,
      color: 'var(--affine-error-color, #eb4b4b)',
      background: C.errBg,
    };
  }
  return {
    ...base,
    border: `1px solid ${C.border}`,
    color: C.text,
    background: 'transparent',
  };
}

// Compact button variant for dense rows (management list, admin tables).
export function miniBtnStyle(
  variant: 'primary' | 'secondary' | 'danger',
  disabled = false
): CSSProperties {
  return {
    ...btnStyle(variant, disabled),
    padding: '5px 13px',
    fontSize: 12,
    borderRadius: 999,
    gap: 6,
  };
}

export const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 12px',
  borderRadius: 10,
  fontSize: 14,
  fontFamily: 'inherit',
  lineHeight: 1.5,
  color: C.text,
  background: C.bg,
  border: `1px solid ${C.border}`,
  outline: 'none',
};

export const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: C.muted,
};

export const hintStyle: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  lineHeight: 1.5,
};

// Dense data-table cell styles (dashboard + admin tables).
export const thStyle: CSSProperties = {
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: C.muted,
  padding: '8px 12px',
  whiteSpace: 'nowrap',
};

export const tdStyle: CSSProperties = {
  padding: '10px 12px',
  borderTop: `1px solid ${C.border}`,
  color: C.text,
  verticalAlign: 'middle',
  fontSize: 12.5,
};

export const Banner = ({
  tone,
  children,
}: PropsWithChildren<{ tone: 'info' | 'warn' | 'error' | 'ok' }>) => {
  const map = {
    info: { bg: C.accentSoft, border: C.border, color: C.text },
    ok: { bg: C.accentSoft, border: C.border, color: C.text },
    warn: { bg: C.warnBg, border: C.warnBorder, color: C.text },
    error: { bg: C.errBg, border: C.errBorder, color: C.text },
  }[tone];
  return (
    <div
      style={{
        padding: '12px 16px',
        borderRadius: 12,
        fontSize: 13,
        lineHeight: 1.55,
        background: map.bg,
        border: `1px solid ${map.border}`,
        color: map.color,
      }}
    >
      {children}
    </div>
  );
};

// Tiny CSS spinner (keyframes injected inline once via a <style> tag).
export const Spinner = ({ dark = false }: { dark?: boolean }) => (
  <span
    style={{
      display: 'inline-block',
      width: 12,
      height: 12,
      borderRadius: '50%',
      border: dark
        ? '2px solid rgba(255,255,255,0.35)'
        : `2px solid ${C.border}`,
      borderTopColor: dark ? '#fff' : C.accent,
      animation: 'cdz-shoperp-spin 0.7s linear infinite',
    }}
  >
    <style>{'@keyframes cdz-shoperp-spin{to{transform:rotate(360deg)}}'}</style>
  </span>
);

/**
 * A loading placeholder shaped like the content that is coming.
 *
 * A spinner tells the merchant "wait"; a skeleton tells them "a table of five
 * rows is arriving, here is where it will be". The second reads as faster even
 * at identical latency, because the layout stops jumping when the data lands.
 *
 * The shimmer itself lives in the injected shoperp motion stylesheet, keyed off
 * `data-cdz-skeleton`, so it honours prefers-reduced-motion for free. Purely
 * decorative, hence aria-hidden — the surrounding panel owns the live region.
 */
export const Skeleton = ({
  rows = 4,
  height = 34,
  gap = 8,
}: {
  rows?: number;
  height?: number;
  gap?: number;
}) => (
  <div
    aria-hidden
    style={{ display: 'flex', flexDirection: 'column', gap }}
  >
    {Array.from({ length: Math.max(1, rows) }, (_, i) => (
      <div
        key={i}
        data-cdz-skeleton=""
        style={{
          height,
          // Taper the last row so the block reads as text, not as a solid slab.
          width: i === rows - 1 ? '62%' : '100%',
          color: C.text,
        }}
      />
    ))}
  </div>
);

// A labeled kind badge (Shop / ERP / App) used in the management list.
export const KindBadge = ({ kind }: { kind?: AppKind }) => {
  const label = kind === 'shop' ? 'Boutique' : kind === 'erp' ? 'ERP' : 'App';
  const emoji = kind === 'shop' ? '🛍️' : kind === 'erp' ? '📊' : '⚡';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        padding: '3px 9px',
        borderRadius: 999,
        color: kind ? '#fff' : C.muted,
        background: kind === 'shop' ? '#0f766e' : kind === 'erp' ? '#2f6bff' : C.panel2,
        border: `1px solid ${kind ? 'transparent' : C.border}`,
        boxShadow: kind ? '0 1px 4px rgba(0,0,0,0.25)' : 'none',
      }}
    >
      <span aria-hidden>{emoji}</span>
      {label}
    </span>
  );
};

// Order-status pill — keeps the exact accented French label as the data value.
export const StatusBadge = ({ status }: { status?: string }) => {
  const color =
    (STATUS_COLORS as Record<string, string>)[status || ''] ?? '#9aa0a6';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 700,
        padding: '3px 10px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 38%, transparent)`,
      }}
    >
      {status || '—'}
    </span>
  );
};

// Titled panel card — the building block of the dashboard + admin sections.
export const Panel = ({
  title,
  action,
  children,
}: PropsWithChildren<{ title: string; action?: ReactNode }>) => (
  <div
    style={{
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 14,
      overflow: 'hidden',
      minWidth: 0,
      boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 16px',
        borderBottom: `1px solid ${C.border}`,
        background: C.panel2,
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: C.muted,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </div>
      {action}
    </div>
    <div style={{ padding: 16 }}>{children}</div>
  </div>
);

// Centered muted placeholder for empty panels (no data yet).
export const EmptyNote = ({ children }: PropsWithChildren) => (
  <div
    style={{
      padding: '22px 10px',
      textAlign: 'center',
      fontSize: 12.5,
      color: C.muted,
      lineHeight: 1.7,
    }}
  >
    {children}
  </div>
);

// A small controlled text input row with label + optional hint + inline error.
export const Field = ({
  label,
  hint,
  error,
  children,
}: PropsWithChildren<{ label: string; hint?: string; error?: string | null }>) => {
  const [id] = useState(
    () => `cdz-fld-${Math.random().toString(36).slice(2, 8)}`
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      <div id={id}>{children}</div>
      {error ? (
        <span style={{ fontSize: 12, color: 'var(--affine-error-color, #eb4b4b)' }}>
          {error}
        </span>
      ) : hint ? (
        <span style={hintStyle}>{hint}</span>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Mobile-responsive CSS — injected once, scoped under [data-cdz-motion] so it
// can only affect the ERP dashboard surface, never the surrounding AFFiNE
// chrome. Uses the established motion.ts pattern (single <style> tag, id-
// guarded idempotent inject). The tab buttons each carry data-cdz-tour so we
// can target their containing flex row via :has() without touching dashboard.tsx.
// ---------------------------------------------------------------------------

/**
 * CSS injected to make the ERP dashboard tab bar and header usable on narrow
 * phone viewports (breakpoint ≤600 px). Desktop (>600 px) is unaffected.
 *
 * What it does at ≤600 px:
 *  • Tab bar  — switches from a wrapping flex grid to a single-row strip with
 *    overflow-x:auto (momentum scrolling, hidden scrollbar) and scroll-snap so
 *    the active tab snaps into view. Tabs stay at least 44 px tall (touch
 *    target). Wrapping is disabled so all 15 tabs fit in one scrollable row.
 *  • Dashboard header — converts the single flat flexbox row into a two-step
 *    layout: the title block (shop name + slug badge) spans the full width on
 *    its own line so the name never truncates; the action buttons (Actualiser /
 *    Visite guidée / Voir la boutique) scroll horizontally in their own row.
 *  • Outer container — swaps the 24 px side padding for 12 px on small screens
 *    so content doesn't feel caged on a 360 px device.
 *
 * Selectors explained:
 *  [data-cdz-motion]                   — root of ErpDashboard (always present)
 *  div:has(>[data-cdz-tour])           — the tab-bar wrapper (identified by
 *                                        the data-cdz-tour attrs on each tab)
 *  [data-cdz-motion]>div:first-child   — the header row (first child of root)
 */
const SHOPERP_RESPONSIVE_CSS = `
/* ── Outer container: tighter horizontal padding on phones ─────────────── */
@media (max-width: 600px) {
  .cdz-page-wrap {
    padding-inline: 12px !important;
  }
}

/* ── Tab bar: single scrollable row, no wrapping ───────────────────────── */
@media (max-width: 600px) {
  [data-cdz-motion] [data-cdz-tabbar] {
    flex-wrap: nowrap !important;
    overflow-x: auto;
    overflow-y: visible;
    -webkit-overflow-scrolling: touch;
    scroll-snap-type: x proximity;
    /* Hide scrollbar on Webkit/Blink without losing function */
    scrollbar-width: none;
  }
  [data-cdz-motion] [data-cdz-tabbar]::-webkit-scrollbar {
    display: none;
  }
  /* Each tab: minimum 44 px touch target, no shrinking */
  [data-cdz-motion] [data-cdz-tour] {
    flex-shrink: 0;
    min-height: 44px;
    scroll-snap-align: start;
    white-space: nowrap;
  }
}

/* ── Dashboard header: full-width title row, then scrollable actions ───── */
@media (max-width: 600px) {
  /* The header is the first direct child of [data-cdz-motion]. Convert it to
     a column so the title block always gets its own full-width row. */
  [data-cdz-motion]>div:first-child {
    flex-direction: column !important;
    align-items: flex-start !important;
    gap: 8px !important;
  }
  /* The title block (flex:1 div) should span full width in column layout */
  [data-cdz-motion]>div:first-child>div[style*="flex: 1"],
  [data-cdz-motion]>div:first-child>div[style*="flex:1"] {
    width: 100% !important;
    min-width: 0 !important;
  }
  /* The shop name span must be allowed to wrap (no truncation at full width) */
  [data-cdz-motion]>div:first-child span[style*="ellipsis"] {
    white-space: normal !important;
    overflow: visible !important;
    text-overflow: unset !important;
  }
  /* Action buttons cluster: row, scrollable, wraps cleanly */
  [data-cdz-motion]>div:first-child>button,
  [data-cdz-motion]>div:first-child>a {
    flex-shrink: 0;
    white-space: nowrap;
  }
}
`;

const RESPONSIVE_STYLE_ID = 'cdz-shoperp-responsive';

/**
 * Inject {@link SHOPERP_RESPONSIVE_CSS} once per document. Idempotent.
 * Call from a useEffect in any shoperp component that mounts the dashboard.
 */
export function ensureShoperpResponsiveCss(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(RESPONSIVE_STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = RESPONSIVE_STYLE_ID;
  el.textContent = SHOPERP_RESPONSIVE_CSS;
  document.head.appendChild(el);
}

// ---------------------------------------------------------------------------
// Offline read cache — DzOS/ERP must keep showing last-known data (and stay
// usable for reading) when the connection drops. Every successful ERP GET
// this module makes is mirrored into localStorage under a namespaced key; on
// network failure the cached copy is served back instead of an error, with an
// `offline: true` marker so pages/components can render a banner. Writes are
// NOT queued — a lost write is safer than a silently-replayed one on a money
// path — but their existing French error copy gets an offline-specific hint.
// ---------------------------------------------------------------------------

const ERP_CACHE_PREFIX = 'cdz:erp-cache:';
const ERP_CACHE_MAX_BYTES = 500_000; // ~500KB guard against localStorage quota

interface ErpCacheEntry<T> {
  data: T;
  cachedAt: number; // epoch ms
}

/** True once any ERP read has fallen back to a cached copy this session. */
let lastOfflineHit: { slug: string; cachedAt: number } | null = null;
type OfflineListener = (hit: { slug: string; cachedAt: number } | null) => void;
const offlineListeners = new Set<OfflineListener>();

function setOfflineHit(hit: { slug: string; cachedAt: number } | null): void {
  lastOfflineHit = hit;
  for (const listener of offlineListeners) listener(hit);
}

/** Subscribe to offline/back-online transitions detected by the ERP cache. */
export function onErpOfflineChange(listener: OfflineListener): () => void {
  offlineListeners.add(listener);
  return () => offlineListeners.delete(listener);
}

/** Current cached-fallback state, if any ERP read is presently serving stale data. */
export function getErpOfflineHit(): { slug: string; cachedAt: number } | null {
  return lastOfflineHit;
}

/** Clear the offline marker (e.g. once a fresh read succeeds again). */
function clearOfflineHit(): void {
  if (lastOfflineHit) setOfflineHit(null);
}

function erpCacheKey(slug: string, resource: string): string {
  return `${ERP_CACHE_PREFIX}${slug}:${resource}`;
}

/** Best-effort cache write. Guarded against quota errors and oversized payloads. */
function cacheErpGet<T>(slug: string, resource: string, data: T): void {
  try {
    const entry: ErpCacheEntry<T> = { data, cachedAt: Date.now() };
    const serialized = JSON.stringify(entry);
    if (serialized.length > ERP_CACHE_MAX_BYTES) return;
    window.localStorage.setItem(erpCacheKey(slug, resource), serialized);
  } catch {
    // Quota exceeded, storage disabled, or non-browser context — skip silently.
  }
}

/** Best-effort cache read. Returns null when absent, corrupt, or unavailable. */
function readErpCache<T>(
  slug: string,
  resource: string
): ErpCacheEntry<T> | null {
  try {
    const raw = window.localStorage.getItem(erpCacheKey(slug, resource));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ErpCacheEntry<T>;
    if (!parsed || typeof parsed.cachedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Append an offline-specific hint to the existing French network-error copy
 * when the browser reports it has no connection. Behaviour (and message) is
 * unchanged while online — this only adds context when `navigator.onLine`
 * is false, per the owner’s “ERP must work offline” requirement.
 */
function netErrorMessage(fallback: string): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'Vous êtes hors ligne — cette action nécessite une connexion.';
  }
  return fallback;
}

/**
 * Slim amber banner shown when a page is displaying a cached (stale) ERP
 * read served while offline. `cachedAt` is the epoch ms of the cached copy.
 */
export const OfflineBanner = ({ cachedAt }: { cachedAt: number }) => {
  let when: string;
  try {
    when = new Date(cachedAt).toLocaleString('fr-DZ', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    when = new Date(cachedAt).toISOString();
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 16px',
        borderRadius: 12,
        fontSize: 12.5,
        lineHeight: 1.55,
        background: C.warnBg,
        border: `1px solid ${C.warnBorder}`,
        color: C.text,
      }}
      role="status"
    >
      <span aria-hidden>📴</span>
      <span>
        Mode hors ligne — données du {when}. Les modifications seront
        possibles au retour de la connexion.
      </span>
    </div>
  );
};

/**
 * Convenience hook: mounts a listener on {@link onErpOfflineChange} and
 * returns the current offline hit (or null), re-rendering the caller when it
 * changes. Kept tiny and dependency-free so any shoperp page can opt in.
 */
export function useErpOfflineHit(): { slug: string; cachedAt: number } | null {
  const [hit, setHit] = useState(getErpOfflineHit());
  useEffect(() => {
    return onErpOfflineChange(setHit);
  }, []);
  return hit;
}
