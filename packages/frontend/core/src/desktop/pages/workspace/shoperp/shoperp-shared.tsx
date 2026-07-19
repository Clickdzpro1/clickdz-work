import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import { type CSSProperties, type PropsWithChildren, useState } from 'react';

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
 * POST /api/v1/apps/template. `settings` is optional; when present it maps to
 * the C5 body. A 400 invalid_settings surfaces the offending field so the
 * wizard can point at the right step (defensive — the wizard validates first).
 */
export async function fetchTemplate(body: {
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
