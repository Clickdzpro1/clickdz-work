// ---------------------------------------------------------------------------
// OpenClaw studio — per-user config API layer + small inline-styled primitives
// shared by the onboarding wizard (wizard.tsx) and the dashboard (dashboard.tsx).
//
// This is the thin JSON client for the C5 per-user config routes:
//   GET  /api/v1/openclaw/config       → OpenClawConfig
//   PUT  /api/v1/openclaw/config       → upsert (sets provisioned:true)
//   GET  /api/v1/openclaw/capabilities → ClawCapabilities (sandbox status, etc.)
//   GET  /api/v1/openclaw/threads      → AgentThreadSummary[] (dashboard rows)
// Every request goes through cdzApiUrl + credentials:'include' (the existing
// agent-console idiom — the backend authenticates via the cookie session on
// @CurrentUser). Nothing here is faked; shapes are pinned to the AGENTS-BE
// contract. Inline styles only (house rule); the palette is the shared
// AgentPalette so the studio reads identically to the console.
// ---------------------------------------------------------------------------

import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import {
  sandboxHealth,
  type SandboxHealth,
} from '@affine/core/modules/agents/api';
import { AgentPalette } from '@affine/core/modules/agents/components';
import { useAgentLang } from '@affine/core/modules/agents/i18n';
import type { AgentThreadSummary } from '@affine/core/modules/agents/types';
import {
  type CSSProperties,
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useState,
} from 'react';

// Shared palette shorthand (identical to the console page).
export const C = AgentPalette.color;
export const monoFamily = AgentPalette.font.mono;

// ---------------------------------------------------------------------------
// Contract shapes (C5 — must match AGENTS-BE clickdz-openclaw.controller.ts)
// ---------------------------------------------------------------------------

export type Runtime = 'node24' | 'python3.13';

export const RUNTIMES: Runtime[] = ['node24', 'python3.13'];
export const RUNTIME_LABELS: Record<string, string> = {
  node24: 'Node.js 24',
  'python3.13': 'Python 3.13',
};
export const RUNTIME_BLURB: Record<string, string> = {
  node24: 'JavaScript / TypeScript, npm, and web dev servers.',
  'python3.13': 'Python 3, pip, scripts and data tasks.',
};

/**
 * GET/PUT /api/v1/openclaw/config body. `provisioned` drives the onboarding
 * gate; the PUT upserts and flips it true (config is a per-user singleton — no
 * 409, the runs live on threads).
 */
export interface OpenClawConfig {
  provisioned: boolean;
  defaultRuntime?: Runtime;
  previewAutoOpen?: boolean;
}

/**
 * GET /api/v1/openclaw/capabilities. `sandbox` is the honest live-execution
 * flag; `reason` explains why it is off (C6 fix now surfaces the real cause —
 * bad token vs. plan gate vs. create failure — instead of a blanket "not
 * enabled"). The FE never fakes this; it renders whatever the backend reports.
 */
export interface ClawCapabilities {
  sandbox: boolean;
  reason?: string;
  plannerReady: boolean;
  runtimes: string[];
  streaming?: boolean;
}

const DEFAULT_RUNTIMES: string[] = ['node24', 'python3.13'];

// ---------------------------------------------------------------------------
// API layer — defensive JSON over the real routes. GETs never throw for a
// missing/blank body (they normalise to a safe default); PUT throws a typed
// Error so the wizard can surface err.message.
// ---------------------------------------------------------------------------

async function readErr(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as {
      message?: unknown;
      error?: unknown;
    } | null;
    const msg =
      (data && typeof data.message === 'string' && data.message) ||
      (data &&
        typeof data.error === 'object' &&
        data.error &&
        typeof (data.error as { message?: unknown }).message === 'string' &&
        (data.error as { message: string }).message) ||
      (data && typeof data.error === 'string' && data.error) ||
      '';
    if (msg) return msg;
  } catch {
    // fall through
  }
  return res.statusText || `Request failed (${res.status})`;
}

/** GET the caller's OpenClaw config. Missing/blank → unprovisioned default. */
export async function getConfig(): Promise<OpenClawConfig> {
  const res = await fetch(cdzApiUrl('/api/v1/openclaw/config'), {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(await readErr(res));
  }
  const data = (await res.json().catch(() => null)) as Partial<
    OpenClawConfig
  > | null;
  return normalizeConfig(data);
}

/** PUT the caller's OpenClaw config (upsert; sets provisioned:true). */
export async function putConfig(
  body: Omit<OpenClawConfig, 'provisioned'>
): Promise<OpenClawConfig> {
  let res: Response;
  try {
    res = await fetch(cdzApiUrl('/api/v1/openclaw/config'), {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Network error while saving your setup.');
  }
  if (!res.ok) {
    throw new Error(await readErr(res));
  }
  const data = (await res.json().catch(() => null)) as Partial<
    OpenClawConfig
  > | null;
  // The PUT response echoes the saved config; if the server returns an empty
  // body, synthesize a provisioned config from what we just sent.
  return normalizeConfig(
    data ?? {
      provisioned: true,
      defaultRuntime: body.defaultRuntime,
      previewAutoOpen: body.previewAutoOpen,
    }
  );
}

/** GET capabilities, normalised so callers can read defensively. */
export async function getCapabilities(): Promise<ClawCapabilities> {
  const res = await fetch(cdzApiUrl('/api/v1/openclaw/capabilities'), {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(await readErr(res));
  }
  const data = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  return normalizeCaps(data);
}

/** GET the caller's OpenClaw threads (dashboard rows). Never throws for []. */
export async function getThreads(): Promise<AgentThreadSummary[]> {
  const res = await fetch(cdzApiUrl('/api/v1/openclaw/threads'), {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(await readErr(res));
  }
  const rows = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is AgentThreadSummary => !!r && typeof r === 'object')
    // Annotated so `agent: 'openclaw'` keeps its literal type (an
    // uncontextualized map callback widens it to `string`).
    .map((r): AgentThreadSummary => ({
      id: String((r as AgentThreadSummary).id ?? ''),
      agent: 'openclaw',
      title: String((r as AgentThreadSummary).title ?? 'Untitled task'),
      createdAt: num((r as AgentThreadSummary).createdAt),
      updatedAt: num((r as AgentThreadSummary).updatedAt),
      messageCount: num((r as AgentThreadSummary).messageCount),
    }))
    .filter(r => r.id);
}

export function normalizeConfig(
  data: Partial<OpenClawConfig> | null
): OpenClawConfig {
  const rt = data?.defaultRuntime;
  return {
    provisioned: data?.provisioned === true,
    defaultRuntime:
      rt === 'node24' || rt === 'python3.13' ? rt : 'node24',
    previewAutoOpen: data?.previewAutoOpen !== false,
  };
}

export function normalizeCaps(
  data: Record<string, unknown> | null
): ClawCapabilities {
  const runtimes =
    Array.isArray(data?.runtimes) && (data!.runtimes as unknown[]).length > 0
      ? (data!.runtimes as unknown[]).filter(
          (r): r is string => typeof r === 'string'
        )
      : DEFAULT_RUNTIMES;
  return {
    sandbox: !!data?.sandbox,
    reason: typeof data?.reason === 'string' ? data.reason : undefined,
    plannerReady: data?.plannerReady !== false,
    runtimes,
    streaming: data?.streaming !== false,
  };
}

// ---------------------------------------------------------------------------
// Small numeric + time helpers.
// ---------------------------------------------------------------------------

export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Compact relative time (mirrors the ThreadSidebar's relTime). */
export function relTime(ts: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  try {
    return new Date(ts).toLocaleDateString();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Shared inline-styled UI (no .css.ts — house rule).
// ---------------------------------------------------------------------------

export function btnStyle(
  variant: 'primary' | 'secondary' | 'danger',
  disabled = false
): CSSProperties {
  const base: CSSProperties = {
    appearance: 'none',
    borderRadius: AgentPalette.radius.md,
    padding: '9px 16px',
    // Touch target: the shared button used across the wizard/dashboard —
    // min-height nudges it to a comfortable size without changing the
    // visual padding/size on desktop pointer input.
    minHeight: 40,
    fontSize: 13,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition:
      'background 160ms ease, border-color 160ms ease, opacity 160ms ease',
  };
  if (variant === 'primary') {
    return { ...base, border: 'none', color: C.onAccent, background: C.accent };
  }
  if (variant === 'danger') {
    return {
      ...base,
      border: `1px solid ${C.errBorder}`,
      color: C.errText,
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

export const linkBtnStyle: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer',
  color: C.accent,
  textDecoration: 'underline',
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
    info: { bg: C.accentSoft, border: C.border },
    ok: { bg: C.okBg, border: C.okBorder },
    warn: { bg: C.warnBg, border: C.warnBorder },
    error: { bg: C.errBg, border: C.errBorder },
  }[tone];
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: AgentPalette.radius.lg,
        fontSize: 13,
        background: map.bg,
        border: `1px solid ${map.border}`,
        color: C.text,
        lineHeight: 1.55,
      }}
    >
      {children}
    </div>
  );
};

export const Spinner = () => (
  <span
    className="cdz-openclaw-studio-spinner"
    style={{
      display: 'inline-block',
      width: 14,
      height: 14,
      borderRadius: '50%',
      border: `2px solid ${C.border}`,
      borderTopColor: C.accent,
    }}
  >
    <style>
      {`@keyframes cdz-openclaw-studio-spin{to{transform:rotate(360deg)}}
.cdz-openclaw-studio-spinner{animation:cdz-openclaw-studio-spin .7s linear infinite}
@media (prefers-reduced-motion: reduce){.cdz-openclaw-studio-spinner{animation:none !important}}`}
    </style>
  </span>
);

/** Titled panel card — the dashboard building block. */
export const Panel = ({
  title,
  action,
  children,
}: PropsWithChildren<{ title: string; action?: ReactNode }>) => (
  <div
    style={{
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: AgentPalette.radius.lg,
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
        background: C.panelRaised,
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

/**
 * A sandbox-status pill/row driven ONLY by capabilities — honest by design.
 * `sandbox:true` → live; else generate-only with the backend's reason. Compact
 * variant renders an inline chip; otherwise a full row with the reason line.
 */
export const SandboxStatus = ({
  caps,
  compact,
}: {
  caps: ClawCapabilities | null;
  compact?: boolean;
}) => {
  const { t } = useAgentLang();
  const on = !!caps?.sandbox;
  const color = on ? C.okText : C.amber;
  const bg = on ? C.okBg : C.warnBg;
  const border = on ? C.okBorder : C.warnBorder;
  // Honest off-copy: map the backend `reason` to merchant FR/darja text via the
  // shared classifier (never print the raw reason string). A missing reason ⇒
  // the generic "off on this server" line.
  const offCopy = caps?.reason
    ? t('openclaw.sandbox.off', { reason: reasonMessage(t, caps.reason) })
    : t('openclaw.sandbox.offGeneric');
  if (compact) {
    return (
      <span
        title={on ? t('openclaw.sandbox.live') : offCopy}
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          padding: '1px 8px',
          borderRadius: AgentPalette.radius.pill,
          fontFamily: monoFamily,
          color,
          background: bg,
          border: `1px solid ${border}`,
        }}
      >
        {on ? t('openclaw.sandbox.chipLive') : t('openclaw.sandbox.chipOff')}
      </span>
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '12px 14px',
        borderRadius: AgentPalette.radius.lg,
        background: bg,
        border: `1px solid ${border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: color,
            boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)`,
          }}
        />
        <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>
          {on
            ? t('openclaw.sandbox.enabled')
            : t('openclaw.sandbox.disabled')}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            padding: '1px 8px',
            borderRadius: AgentPalette.radius.pill,
            fontFamily: monoFamily,
            color,
            border: `1px solid ${border}`,
          }}
        >
          {on ? t('openclaw.sandbox.chipLive') : t('openclaw.sandbox.chipOff')}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.55 }}>
        {on ? t('openclaw.sandbox.liveLong') : offCopy}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sandbox reason mapping + the REAL health-probe button (R16).
//
// The honest replacement for the passive capability read: `SandboxHealthButton`
// actually POSTs /sandbox/health (which creates a microVM, runs `echo`, tears it
// down) and renders a green "opérationnel (Xms)" / red mapped-reason inline
// Banner. NEVER prints a raw HTTP/stack — a failure is classified to one of the
// three sandbox rows in the design's error table and shown as merchant copy.
// ---------------------------------------------------------------------------

type TT = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Classify a FREE-TEXT backend `reason` string (from `/capabilities`, which
 * carries a human-readable cause) into the merchant-facing FR/darja message, per
 * the design's error table. Keyword-matched, NEVER printed raw:
 *   quota | concurren | capacity  → row 1 (trop d'agents actifs)
 *   cold  | timeout              → row 2 (démarrage à froid)
 *   token | plan | auth | billing → row 3 (compte / génération-seule)
 *   anything else                → generic probe-fail ("injoignable, 3awd mera")
 */
export function reasonMessage(t: TT, reason?: string): string {
  const r = (reason ?? '').toLowerCase();
  if (!r) return t('openclaw.sandbox.err.probeFail');
  if (
    r.includes('capacity') ||
    r.includes('quota') ||
    r.includes('concurren')
  ) {
    return t('openclaw.sandbox.err.atCapacity');
  }
  if (r.includes('cold') || r.includes('timeout')) {
    return t('openclaw.sandbox.err.coldStart');
  }
  if (
    r.includes('token') ||
    r.includes('plan') ||
    r.includes('auth') ||
    r.includes('billing') ||
    r.includes('not_configured') ||
    r.includes('not_enabled')
  ) {
    return t('openclaw.sandbox.err.token');
  }
  return t('openclaw.sandbox.err.probeFail');
}

/**
 * Classify a failed {@link SandboxHealth} probe result into merchant copy, from
 * the REAL backend fields (`detail.code`, `detail.status`, `stage`, verbatim
 * `error`) — the raw string is NEVER shown. Maps to the design's three sandbox
 * rows:
 *   · upstream 429 / capacity|quota|concurren      → row 1 (trop d'agents actifs)
 *   · code 'timeout' OR a create-leg timeout        → row 2 (démarrage à froid)
 *   · code not_configured|not_enabled OR 401/402/403
 *     OR token|plan|auth|billing                    → row 3 (compte / gén-seule)
 *   · anything else                                 → generic probe-fail
 */
export function healthMessage(t: TT, h: SandboxHealth | null): string {
  const detail = h?.detail;
  const status = typeof detail?.status === 'number' ? detail.status : undefined;
  const code = (detail?.code ?? '').toLowerCase();
  const raw = `${h?.error ?? ''} ${detail?.bodyPreview ?? ''}`.toLowerCase();

  // Row 1 — capacity / concurrency exhausted (upstream 429 or a capacity string).
  if (
    status === 429 ||
    raw.includes('capacity') ||
    raw.includes('quota') ||
    raw.includes('concurren')
  ) {
    return t('openclaw.sandbox.err.atCapacity');
  }
  // Row 2 — cold-start / create timeout.
  if (code === 'timeout' || raw.includes('cold') || raw.includes('timeout')) {
    return t('openclaw.sandbox.err.coldStart');
  }
  // Row 3 — token / plan / billing / auth gate (config-off or an auth/billing HTTP).
  if (
    code === 'not_configured' ||
    code === 'not_enabled' ||
    status === 401 ||
    status === 402 ||
    status === 403 ||
    raw.includes('token') ||
    raw.includes('plan') ||
    raw.includes('auth') ||
    raw.includes('billing')
  ) {
    return t('openclaw.sandbox.err.token');
  }
  return t('openclaw.sandbox.err.probeFail');
}

/** Local phase for the health-probe button — idle → testing → ok / error. */
type ProbePhase =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; ms?: number }
  | { kind: 'error'; message: string };

/**
 * The REAL "Tester le sandbox" button. On press it runs {@link sandboxHealth}
 * (create → exec → teardown, ≤20s via an AbortController on the backend) and
 * shows a green "✅ sandbox opérationnel (Xms)" or a red mapped-reason Banner
 * with a [Réessayer]. One probe per press — no background poll (R13-safe). Never
 * surfaces the raw `error`; a `{ ok:false, reason }` result is classified to
 * copy. A 404 (feature dark) maps to the generate-only note, not a red error.
 */
export const SandboxHealthButton = () => {
  const { t } = useAgentLang();
  const [phase, setPhase] = useState<ProbePhase>({ kind: 'idle' });

  const run = useCallback(() => {
    setPhase({ kind: 'testing' });
    void (async () => {
      try {
        const res: SandboxHealth = await sandboxHealth();
        if (res && res.ok) {
          setPhase({
            kind: 'ok',
            ms: typeof res.ms === 'number' ? res.ms : undefined,
          });
        } else {
          // A sandbox failure comes back HTTP 200 as { ok:false, ... } — classify
          // from the real backend fields; never surface the verbatim error.
          setPhase({ kind: 'error', message: healthMessage(t, res ?? null) });
        }
      } catch (err) {
        // A dark feature (404) is not a red error — it's the generate-only note.
        const status =
          err && typeof err === 'object' && 'status' in err
            ? (err as { status?: number }).status
            : undefined;
        if (status === 404) {
          setPhase({ kind: 'error', message: t('openclaw.sandbox.err.token') });
        } else {
          setPhase({ kind: 'error', message: t('openclaw.sandbox.err.probeFail') });
        }
      }
    })();
  }, [t]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <button
          type="button"
          style={btnStyle('primary', phase.kind === 'testing')}
          disabled={phase.kind === 'testing'}
          onClick={run}
        >
          {phase.kind === 'testing' ? (
            <>
              <Spinner /> {t('openclaw.sandbox.testing')}
            </>
          ) : (
            t('openclaw.sandbox.test')
          )}
        </button>
      </div>

      {phase.kind === 'ok' ? (
        <Banner tone="ok">
          {typeof phase.ms === 'number'
            ? t('openclaw.sandbox.testOkMs', { ms: phase.ms })
            : t('openclaw.sandbox.testOk')}
        </Banner>
      ) : null}

      {phase.kind === 'error' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Banner tone="error">{phase.message}</Banner>
          <div>
            <button
              type="button"
              style={{ ...btnStyle('secondary'), padding: '6px 12px', fontSize: 12 }}
              onClick={run}
            >
              {t('openclaw.sandbox.retry')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
