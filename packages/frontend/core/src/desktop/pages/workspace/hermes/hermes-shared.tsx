import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import {
  type CSSProperties,
  type PropsWithChildren,
  type ReactNode,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// ClickDz Hermes — shared palette, small inline-styled helpers, and the thin
// API layer that talks to the REAL C5 per-user config routes
// (GET/PUT /api/v1/hermes/config). Mirrors the ShopERP shoperp-shared scaffold
// (dark palette, ViewTitle/…/ViewBody host, inline styles, no i18n, no new
// .css.ts). Everything here is client-side glue: the wizard, dashboard, and
// settings panel compose these primitives; nothing is faked. Every network
// call carries the session cookie (credentials:'include') so the backend's
// @CurrentUser AuthGuard authenticates the caller — same idiom as the agents
// api.ts REST client.
// ---------------------------------------------------------------------------

// Dark, app-consistent palette. Each value is an --affine-* theme var with a
// hard dark fallback so the surface reads correctly before theme vars load.
// Kept in lock-step with the console's AgentPalette.color so the wizard +
// dashboard read cohesively with the streaming console primitives.
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
  accentBorder:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 45%, transparent)',
  warnBg: 'color-mix(in srgb, #e8a33d 12%, transparent)',
  warnBorder: 'color-mix(in srgb, #e8a33d 40%, transparent)',
  errBg: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 12%, transparent)',
  errBorder:
    'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 40%, transparent)',
  okText: 'var(--affine-success-color, #4cae4c)',
  okSoft: 'color-mix(in srgb, var(--affine-success-color, #4cae4c) 14%, transparent)',
  okBorder: 'color-mix(in srgb, var(--affine-success-color, #4cae4c) 40%, transparent)',
} as const;

// ---------------------------------------------------------------------------
// C5 config contract — the exact per-user shape the AGENTS-BE controller
// persists at `clickdz:agent:config:<userId>:hermes` and serves from
// GET/PUT /api/v1/hermes/config. FE codes to these fields verbatim.
// ---------------------------------------------------------------------------

/** The agent run policy union (mirrors the console's AgentMode). */
export type AgentMode = 'auto' | 'ask' | 'dry';

/** A single saved workflow/procedure (replaces the static CATEGORIES per user). */
export interface SavedWorkflow {
  title: string;
  goal: string;
}

/**
 * The per-user Hermes config (C5). `provisioned` drives the onboarding gate:
 * false → wizard, true → dashboard. All optional fields default sanely so the
 * UI never crashes on a partial/empty document.
 */
export interface HermesConfig {
  provisioned: boolean;
  agentName?: string;
  personaGoal?: string;
  enabledTools?: string[];
  defaultMode?: AgentMode;
  savedWorkflows?: SavedWorkflow[];
}

/** The body PUT to /api/v1/hermes/config (server sets provisioned:true). */
export interface HermesConfigInput {
  agentName: string;
  personaGoal: string;
  enabledTools: string[];
  defaultMode: AgentMode;
  savedWorkflows: SavedWorkflow[];
  provisioned?: boolean;
}

const MODE_SET: readonly AgentMode[] = ['auto', 'ask', 'dry'];

/** Coerce an unknown mode into a valid AgentMode ('ask' is the safe default). */
export function coerceMode(v: unknown): AgentMode {
  return MODE_SET.includes(v as AgentMode) ? (v as AgentMode) : 'ask';
}

/**
 * Normalise the loosely-typed config JSON into HermesConfig. Anything missing
 * or malformed degrades to empty/false so the gate + dashboard never crash on
 * a partial document (and an absent config reads as unprovisioned → wizard).
 */
export function normalizeConfig(raw: unknown): HermesConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawWf = Array.isArray(r.savedWorkflows) ? r.savedWorkflows : [];
  const savedWorkflows: SavedWorkflow[] = rawWf
    .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
    .map(w => ({
      title: typeof w.title === 'string' ? w.title : '',
      goal: typeof w.goal === 'string' ? w.goal : '',
    }))
    .filter(w => w.goal.trim().length > 0);
  const rawTools = Array.isArray(r.enabledTools) ? r.enabledTools : [];
  const enabledTools = rawTools
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  return {
    provisioned: !!r.provisioned,
    agentName: typeof r.agentName === 'string' ? r.agentName : undefined,
    personaGoal: typeof r.personaGoal === 'string' ? r.personaGoal : undefined,
    enabledTools,
    defaultMode: coerceMode(r.defaultMode),
    savedWorkflows,
  };
}

export type ConfigOutcome =
  | { status: 'ok'; config: HermesConfig }
  | { status: 'error'; message: string };

/**
 * GET /api/v1/hermes/config. Returns the per-user config; a 404 (never
 * provisioned) or empty body degrades to an unprovisioned config so the caller
 * shows the wizard rather than an error. Only true transport / server faults
 * surface as an error outcome.
 */
export async function fetchConfig(): Promise<ConfigOutcome> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl('/api/v1/hermes/config'), {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return { status: 'error', message: 'Network error while loading your Hermes setup.' };
  }
  // A never-provisioned user may 404 — treat as "show the wizard".
  if (res.status === 404) {
    return { status: 'ok', config: { provisioned: false, enabledTools: [], savedWorkflows: [], defaultMode: 'ask' } };
  }
  if (res.status === 401) {
    return { status: 'error', message: 'Please sign in to set up Hermes.' };
  }
  if (!res.ok) {
    return { status: 'error', message: `Could not load your Hermes setup (${res.status}).` };
  }
  const data = (await res.json().catch(() => null)) as unknown;
  return { status: 'ok', config: normalizeConfig(data) };
}

/**
 * PUT /api/v1/hermes/config (upsert; the server sets provisioned:true). Returns
 * the persisted config echoed back, normalised. Never throws for a documented
 * 4xx — those come back as a typed error outcome carrying the server message.
 */
export async function saveConfig(input: HermesConfigInput): Promise<ConfigOutcome> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl('/api/v1/hermes/config'), {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...input, provisioned: true }),
    });
  } catch {
    return { status: 'error', message: 'Network error while saving your setup.' };
  }
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { message?: unknown; error?: unknown })
    | null;
  if (!res.ok) {
    const message =
      res.status === 401
        ? 'Please sign in to save your setup.'
        : res.status === 400
          ? typeof data?.message === 'string'
            ? (data.message as string)
            : 'Some of your setup values were invalid — please check and retry.'
          : typeof data?.message === 'string'
            ? (data.message as string)
            : `Saving failed (${res.status}).`;
    return { status: 'error', message };
  }
  // The server echoes the persisted config; if it returns an empty body, trust
  // the input we just sent (with provisioned:true).
  const config = data && Object.keys(data).length > 0
    ? normalizeConfig(data)
    : normalizeConfig({ ...input, provisioned: true });
  return { status: 'ok', config };
}

// ---------------------------------------------------------------------------
// Capabilities — the console/dashboard read the SAME global tool catalog from
// GET /api/v1/hermes/capabilities (C5). Shape mirrors hermes-connections.
// ---------------------------------------------------------------------------

export interface HermesTool {
  slug: string;
  label: string;
  available: boolean;
}

export interface HermesCaps {
  tools: HermesTool[];
  plannerReady: boolean;
  streaming?: boolean;
}

/** Normalise the loosely-typed capabilities JSON into HermesCaps. */
export function normalizeCaps(raw: unknown): HermesCaps {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawTools = Array.isArray(r.tools) ? r.tools : [];
  const tools: HermesTool[] = rawTools
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map(t => ({
      slug: typeof t.slug === 'string' ? t.slug : '',
      label: typeof t.label === 'string' ? t.label : String(t.slug ?? ''),
      available: !!t.available,
    }))
    .filter(t => t.slug);
  return {
    tools,
    plannerReady: !!r.plannerReady,
    streaming: !!r.streaming,
  };
}

// ---------------------------------------------------------------------------
// Client-side validation — cheap guards so the wizard blocks bad input before
// any network call (the server re-validates anyway).
// ---------------------------------------------------------------------------

export function validateAgentName(v: string): string | null {
  const name = v.trim();
  if (name.length === 0) return 'Give your agent a name.';
  if (name.length > 40) return 'Keep the name under 40 characters.';
  return null;
}

export function validatePersona(v: string): string | null {
  const p = v.trim();
  if (p.length === 0) return 'Describe what this agent should focus on.';
  if (p.length > 600) return 'Keep this under 600 characters.';
  return null;
}

// ---------------------------------------------------------------------------
// Small inline-styled shared UI (no exports from a .css.ts, per house rules).
// ---------------------------------------------------------------------------

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

// Primary / secondary / danger button style factory (shared by all views).
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
    fontFamily: 'inherit',
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

// Compact button variant for dense rows (dashboard tiles, workflow rows).
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

export const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: 84,
  resize: 'vertical',
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
    ok: { bg: C.okSoft, border: C.okBorder, color: C.text },
    warn: { bg: C.warnBg, border: C.warnBorder, color: C.text },
    error: { bg: C.errBg, border: C.errBorder, color: C.text },
  }[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      style={{
        padding: '12px 14px',
        borderRadius: 10,
        fontSize: 13,
        lineHeight: 1.5,
        background: map.bg,
        border: `1px solid ${map.border}`,
        color: map.color,
      }}
    >
      {children}
    </div>
  );
};

// Tiny CSS spinner (keyframes injected inline once via a <style> tag). A local
// copy so this module is boot-safe standalone (mirrors shoperp's Spinner).
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
      animation: 'cdz-hermes-spin 0.7s linear infinite',
    }}
  >
    <style>{'@keyframes cdz-hermes-spin{to{transform:rotate(360deg)}}'}</style>
  </span>
);

// A small controlled input row with label + optional hint + inline error.
export const Field = ({
  label,
  hint,
  error,
  children,
}: PropsWithChildren<{ label: string; hint?: string; error?: string | null }>) => {
  const [id] = useState(
    () => `cdz-hfld-${Math.random().toString(36).slice(2, 8)}`
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

// Titled panel card — the building block of the dashboard sections.
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

// Relative "time ago" formatter for run rows (ms epoch → "3m ago").
export function timeAgo(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return `${d}d ago`;
  }
}

// Human-readable label for a run policy mode (dashboard + review).
export const MODE_LABEL: Record<AgentMode, string> = {
  auto: 'Auto — run tools freely',
  ask: 'Ask — pause before writes / sends',
  dry: 'Dry run — plan only',
};
