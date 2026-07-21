import { artifactStore } from '@affine/core/modules/ai-artifacts/store';
import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import {
  type CSSProperties,
  type PropsWithChildren,
  type ReactNode,
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
    throw new Error(`Could not load your apps (${res.status})`);
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
      throw new Error('Please sign in to create a shop.');
    }
    if (data?.error === 'invalid_settings') {
      throw new Error(
        `That ${data.field || 'value'} isn't valid — please check it and try again.`
      );
    }
    throw new Error(`Creation failed (${res.status}).`);
  }
  const slug = typeof data?.slug === 'string' ? data.slug : '';
  const html = typeof data?.html === 'string' ? data.html : '';
  if (!slug || !html) {
    throw new Error('The template response was incomplete. Please try again.');
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
    return { status: 'error', message: 'Network error while publishing.' };
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
        : `Publish failed (${res.status}).`;
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
  // C6 online-payments flag — NON-sensitive (the Chargily SECRET lives in a
  // private Redis store, never here). When true the deployed storefront shows a
  // "Payer en ligne" option (SHOPTPL gates on this); the bridge allowlist
  // (normalizeErpSettings) validates it. Unset/false = cash-on-delivery only.
  onlinePay?: boolean;
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
  | { status: 'ok'; summary: ErpSummary }
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
    return {
      status: 'error',
      message: 'Network error while loading the dashboard.',
    };
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<ErpSummary> & { message?: string })
    | null;
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Please sign in to view this dashboard.'
        : res.status === 403
          ? 'This shop belongs to another account.'
          : res.status === 404
            ? 'This shop was not found — it may have been deleted.'
            : typeof data?.message === 'string'
              ? data.message
              : `Could not load the dashboard (${res.status}).`;
    return { status: 'error', message };
  }
  const kpis = (data?.kpis ?? {}) as Partial<ErpKpis>;
  return {
    status: 'ok',
    summary: {
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
    },
  };
}

/**
 * GET a full collection from the public per-slug data API (no token needed for
 * reads — same design the deployed shop/ERP uses). Newest-first, capped at 500.
 */
export async function fetchErpCollection<T = Record<string, unknown>>(
  storeSlug: string,
  collection: string
): Promise<T[]> {
  const res = await fetch(
    cdzApiUrl(
      `/api/v2/apps-data/${encodeURIComponent(storeSlug)}/${encodeURIComponent(collection)}?limit=500`
    ),
    { method: 'GET', headers: { Accept: 'application/json' } }
  );
  if (!res.ok) {
    throw new Error(`Could not load ${collection} (${res.status})`);
  }
  const data = (await res.json().catch(() => null)) as unknown;
  return Array.isArray(data) ? (data as T[]) : [];
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
    return { status: 'error', message: 'Network error — nothing was changed.' };
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
        ? 'Please sign in again.'
        : res.status === 403
          ? 'This shop belongs to another account.'
          : res.status === 404
            ? 'Not found — it may have been changed elsewhere. Refresh and retry.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `The change failed (${res.status}).`;
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

/** A scalar feature param — IDs / numbers / booleans only (8KB-cap safe). */
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
    return { status: 'error', message: 'Network error — nothing was changed.' };
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
          ? 'Please sign in again.'
          : res.status === 403
            ? 'This shop belongs to another account.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `Could not apply the changes (${res.status}).`;
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
    return { status: 'error', message: 'Network error while loading features.' };
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
        ? 'Please sign in to view features.'
        : res.status === 403
          ? 'This shop belongs to another account.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Could not load features (${res.status}).`;
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
    label: 'Classic',
    hint: 'Today’s look — light, airy, teal-friendly.',
    preview: { bg: '#f6f7f9', card: '#ffffff', ink: '#0f172a', line: '#e5e7eb' },
  },
  {
    id: 'dark',
    label: 'Dark',
    hint: 'Deep neutral surfaces with a bright accent.',
    preview: { bg: '#0b0f19', card: '#151b2b', ink: '#e8ecf4', line: '#26304a' },
  },
  {
    id: 'vibrant',
    label: 'Vibrant',
    hint: 'Warm, high-contrast, punchy accent gradients.',
    preview: { bg: '#fff7ed', card: '#ffffff', ink: '#1f130a', line: '#f3d9bf' },
  },
  {
    id: 'minimal',
    label: 'Minimal',
    hint: 'Flat, monochrome, thin lines — content first.',
    preview: { bg: '#ffffff', card: '#ffffff', ink: '#111111', line: '#ececec' },
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
    hint: 'Hero banner + category rail + product grid (the default).',
  },
  {
    id: 'boutique',
    label: 'Boutique',
    hint: 'Compact editorial header, larger cards, no hero band.',
  },
];

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
    label: 'System',
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
  { id: 'hero', label: 'Hero banner', hint: 'The headline + call-to-action band.' },
  { id: 'trust', label: 'Trust strip', hint: 'COD / delivery / support reassurance row.' },
  {
    id: 'categories',
    label: 'Category rail',
    hint: 'The horizontal category filter chips.',
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
      message: 'Network error while loading inventory.',
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
        ? 'Please sign in to view inventory.'
        : res.status === 403
          ? 'This shop belongs to another account.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Could not load inventory (${res.status}).`;
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
    return { status: 'error', message: 'Network error — nothing was changed.' };
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
        ? 'Please sign in again.'
        : res.status === 403
          ? 'This shop belongs to another account.'
          : res.status === 404
            ? 'Not found — refresh and retry.'
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
    return { status: 'error', message: 'Network error — nothing was changed.' };
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
        ? 'Please sign in again.'
        : res.status === 403
          ? 'This shop belongs to another account.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Could not add the warehouse (${res.status}).`;
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
    return { status: 'error', message: 'Network error — nothing was changed.' };
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
        ? 'Please sign in again.'
        : res.status === 403
          ? 'This shop belongs to another account.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Could not remove the warehouse (${res.status}).`;
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
      message: 'Network error while generating the description.',
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
        ? 'The description generator is unavailable right now — please try again in a moment.'
        : res.status === 401
          ? 'Please sign in again.'
          : res.status === 403
            ? 'This shop belongs to another account.'
            : res.status === 404
              ? 'That product was not found — refresh and retry.'
              : typeof data?.message === 'string'
                ? (data.message as string)
                : `Could not generate a description (${res.status}).`;
    return { status: 'error', message };
  }
  const description =
    typeof data?.description === 'string' ? data.description : '';
  if (!description) {
    return {
      status: 'error',
      message: 'The generator returned an empty description — please retry.',
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
      message: 'Network error while loading payment settings.',
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
        ? 'Please sign in to view payment settings.'
        : res.status === 403
          ? 'This shop belongs to another account.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Could not load payment settings (${res.status}).`;
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
      message: 'Network error — payment settings were not saved.',
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
          : 'That API secret looks invalid — please check it and try again.'
        : res.status === 401
          ? 'Please sign in again.'
          : res.status === 403
            ? 'This shop belongs to another account.'
            : typeof data?.message === 'string'
              ? (data.message as string)
              : `Could not save payment settings (${res.status}).`;
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
  if (name.length === 0) return 'Enter a store name.';
  if (name.length > 60) return 'Keep the name under 60 characters.';
  return null;
}
export function validateWhatsapp(v: string): string | null {
  if (!WHATSAPP_RE.test(v)) {
    return 'Digits only, 8–15, no “+” (e.g. 213600000000).';
  }
  return null;
}
export function validateAccent(v: string): string | null {
  if (!ACCENT_RE.test(v)) return 'Use a hex color like #0f766e.';
  return null;
}
export function validatePin(v: string): string | null {
  if (!PIN_RE.test(v)) return 'Use 4–8 digits.';
  return null;
}

// ---------------------------------------------------------------------------
// Small inline-styled shared UI (no exports from a .css.ts, per house rules).
// ---------------------------------------------------------------------------

export const codeStyle: CSSProperties = {
  fontFamily: 'var(--affine-font-code-family, monospace)',
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 4,
  background:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  color: 'var(--affine-text-primary-color, #ececec)',
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
    borderRadius: 8,
    padding: '9px 16px',
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
    padding: '5px 11px',
    fontSize: 12,
    borderRadius: 7,
    gap: 6,
  };
}

export const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  borderRadius: 8,
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
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: C.muted,
  padding: '6px 10px',
  whiteSpace: 'nowrap',
};

export const tdStyle: CSSProperties = {
  padding: '8px 10px',
  borderTop: `1px solid ${C.border}`,
  color: C.text,
  verticalAlign: 'middle',
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
        padding: '12px 14px',
        borderRadius: 10,
        fontSize: 13,
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

// A labeled kind badge (Shop / ERP / App) used in the management list.
export const KindBadge = ({ kind }: { kind?: AppKind }) => {
  const label = kind === 'shop' ? 'Shop' : kind === 'erp' ? 'ERP' : 'App';
  const emoji = kind === 'shop' ? '🛍️' : kind === 'erp' ? '📊' : '⚡';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        padding: '2px 8px',
        borderRadius: 999,
        color: kind ? '#fff' : C.muted,
        background: kind === 'shop' ? '#0f766e' : kind === 'erp' ? '#2f6bff' : C.panel2,
        border: `1px solid ${kind ? 'transparent' : C.border}`,
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
        padding: '2px 9px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
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
      borderRadius: 12,
      overflow: 'hidden',
      minWidth: 0,
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '9px 14px',
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
          letterSpacing: '0.04em',
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
    <div style={{ padding: 14 }}>{children}</div>
  </div>
);

// Centered muted placeholder for empty panels (no data yet).
export const EmptyNote = ({ children }: PropsWithChildren) => (
  <div
    style={{
      padding: '18px 8px',
      textAlign: 'center',
      fontSize: 12.5,
      color: C.muted,
      lineHeight: 1.6,
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
