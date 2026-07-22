// SpendMeter — a pure, DISPLAY-ONLY estimate of what a background agent run cost
// the user, in Algerian dinar (DZD). It is deliberately soft: the run record
// today carries NO token count (see below), so the estimate is derived from the
// tool-call budget and is ALWAYS labelled "estimé" and prefixed "≈". It NEVER
// gates, blocks, warns-hard, or interrupts a run — it only shows a number so a
// DZ SMB owner has a rough feel for spend. Consumed by Scene's run.tsx (full
// card) and runs.tsx (compact chip in each history row).
//
// ── What cost signal actually exists (read from the code, do NOT assume) ──
// Backend run record  `clickdz-agent-runs.ts` → `AgentRunRecord.budget: RunBudget`
//   = { maxToolCalls: number; maxWallMs: number; toolCalls: number }.  There is
//   NO token field, NO usage field, NO cost field anywhere on the record.
// FE mirror `modules/agents/types.ts` → `AgentRunRecord.budget?: {
//   maxToolCalls?: number; maxWallMs?: number; toolCalls?: number }`.
// So the ONLY spend signal we can read off a run is `budget.toolCalls` (how many
//   tool calls the loop charged). Tokens are unknown → we approximate them from
//   the tool-call count via a nominal, clearly-labelled constant. If a real
//   token count is ever added (record field or a caller that has it), pass it as
//   the `tokens` prop and the exact path is used instead of the estimate.
//
// caps.dzdPer1k (from Annuaire's AgentCaps, GET /api/v1/agents → caps.dzdPer1k =
//   Number(process.env.CDZ_DZD_PER_1K||'0')) is the DZD price per 1k tokens.
//   When it is 0 / unset we show the raw counts and a neutral "—" for cost — no
//   invented money figure.
//
// R8 (POLI, additive): the user-facing copy — title, count labels, token label,
// price line + the "estimé" note — flows through the agents i18n table via
// `useAgentLang()` (FR default + Algerian darja). The PURE math/format helpers
// (`estimateSpend`, `formatDzd`, `formatTokens`, `NOMINAL_TOKENS_PER_TOOL_CALL`)
// and ALL exports + prop signatures are BYTE-IDENTICAL — only presentational
// strings inside the component were localised. RTL-safe: the card flips for 'ar'
// while numeric/technical spans (DZD figures, token counts) stay LTR. A couple
// of hover-only tooltips with no catalogue key keep their FR text (fail-soft).

import type { CSSProperties, ReactNode } from 'react';

import type { AgentRunRecord, AgentRunSummary } from '../types';
import { useAgentLang } from '../i18n';
import { AgentPalette as P } from './palette';
import { Chip } from './primitives';

// ---------------------------------------------------------------------------
// Estimation constants — the coarse fallback when no token count is available.
// ---------------------------------------------------------------------------
/**
 * Nominal tokens attributed to one tool-call round-trip (prompt + tool schema +
 * model reply). A deliberately round, conservative figure used ONLY to turn a
 * tool-call count into a rough token estimate for the DZD math. It is NOT a
 * measurement; every figure derived from it is shown with "≈" and "estimé".
 * Exported so a caller/test can reference the same assumption.
 */
export const NOMINAL_TOKENS_PER_TOOL_CALL = 1500;

// ---------------------------------------------------------------------------
// Props — one clean API that accepts either a run record (convenience) or the
// raw numbers, plus the price either directly or via a caps object.
// ---------------------------------------------------------------------------
export interface SpendMeterProps {
  /**
   * A background-run record/summary to read the tool-call count from
   * (`run.budget?.toolCalls`). Convenience for the common call site; ignored for
   * any field also passed explicitly below.
   */
  run?: AgentRunRecord | AgentRunSummary | null;
  /**
   * Exact token count, when a caller actually has one. Today NOTHING on the run
   * record exposes this, so it is normally omitted and the tool-call estimate is
   * used; wired up now so the exact path lights up for free if tokens ever land.
   */
  tokens?: number | null;
  /**
   * Explicit tool-call count. Overrides `run.budget?.toolCalls` when provided.
   */
  toolCalls?: number | null;
  /**
   * DZD price per 1000 tokens (i.e. `caps.dzdPer1k`). 0 / undefined ⇒ pricing is
   * unset ⇒ no DZD figure is shown (cost renders as "—"). Takes precedence over
   * `caps.dzdPer1k` when both are given.
   */
  dzdPer1k?: number | null;
  /** Alternative to `dzdPer1k`: pass the caps object and we read `.dzdPer1k`. */
  caps?: { dzdPer1k?: number | null } | null;
  /** Compact = a single small chip (list rows). Default (false) = a small card. */
  compact?: boolean;
  /** Optional style escape hatch for the outer element. */
  style?: CSSProperties;
  /** Optional extra content rendered under the card body (full variant only). */
  children?: ReactNode;
}

// ---------------------------------------------------------------------------
// Formatters — mirror the primitives.tsx `format*` naming idiom.
// ---------------------------------------------------------------------------

/** Coerce a possibly-undefined/negative/NaN numeric prop to a clean count ≥ 0. */
function count(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Format a DZD amount for display. Small amounts keep one decimal (≈ 1.4 DZD)
 * so a cheap run doesn't collapse to "0"; larger amounts round to a whole,
 * thousands-separated dinar figure. Uses fr-DZ grouping when available, with a
 * manual fallback so it never throws in a constrained runtime.
 */
export function formatDzd(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '—';
  const decimals = amount > 0 && amount < 10 ? 1 : 0;
  try {
    return new Intl.NumberFormat('fr-DZ', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    // Manual grouping fallback (no Intl / unknown locale).
    const fixed = amount.toFixed(decimals);
    const [int, frac] = fixed.split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return frac ? `${grouped},${frac}` : grouped;
  }
}

/** Compact token count: 2400 → "2.4k", 900 → "900". */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < 1000) return String(Math.round(tokens));
  const k = tokens / 1000;
  return `${k.toFixed(k < 10 ? 1 : 0)}k`;
}

// ---------------------------------------------------------------------------
// Core estimate — the single source of truth both variants render from.
// ---------------------------------------------------------------------------
export interface SpendEstimate {
  /** Tool calls the run charged (0 when unknown). */
  toolCalls: number;
  /** Token count used for the DZD math (exact if provided, else estimated). */
  tokens: number;
  /** True when `tokens` is an exact caller-supplied count (not derived). */
  tokensExact: boolean;
  /** DZD price per 1k tokens actually in effect (0 ⇒ pricing unset). */
  dzdPer1k: number;
  /** Estimated cost in DZD, or null when pricing is unset (dzdPer1k === 0). */
  dzd: number | null;
}

/**
 * Resolve the props into a normalized estimate. Pure + exported so run.tsx /
 * runs.tsx (or a test) can reuse the exact same math outside the component.
 *
 * Precedence: explicit `tokens`/`toolCalls`/`dzdPer1k` props win over the `run`
 * record / `caps` object. Tokens are EXACT only when passed explicitly; the
 * tool-call → tokens path is an estimate (see NOMINAL_TOKENS_PER_TOOL_CALL).
 */
export function estimateSpend(props: SpendMeterProps): SpendEstimate {
  const toolCalls = count(
    props.toolCalls ?? props.run?.budget?.toolCalls
  );

  const explicitTokens = count(props.tokens);
  const tokensExact = explicitTokens > 0;
  // No token field on the record → fall back to the tool-call estimate.
  const tokens = tokensExact
    ? explicitTokens
    : toolCalls * NOMINAL_TOKENS_PER_TOOL_CALL;

  const dzdPer1k = count(props.dzdPer1k ?? props.caps?.dzdPer1k);

  // Pricing unset ⇒ no money figure (never invent one).
  const dzd = dzdPer1k > 0 ? (tokens / 1000) * dzdPer1k : null;

  return { toolCalls, tokens, tokensExact, dzdPer1k, dzd };
}

// ---------------------------------------------------------------------------
// R11 (WS11-11, BUDGET) — BudgetBar math helpers. ADDITIVE ONLY: everything
// above (SpendMeter's props/exports + the estimate math) is byte-identical. The
// shared <BudgetBar budget/> (Trame) shows a soft month-to-date spend bar that
// warns at ≥80% and NEVER blocks; when `monthDzd === 0` there is no limit, so it
// shows usage only. These pure helpers give that component (and any caller/test)
// ONE source of truth for the ratio + warn/over levels, so the home BudgetBar
// and the per-run SpendMeter stay visually consistent (both use `formatDzd` /
// `formatTokens` above for their figures). No React, no fetch — pure math.
// ---------------------------------------------------------------------------

/** The soft spend threshold (fraction of the monthly limit) at which the bar
 * turns to a warning tint. Matches the R11 BudgetBar contract ("warns ≥80%"). */
export const BUDGET_WARN_RATIO = 0.8;

/** Spend level for the soft budget bar: no configured limit, normal usage,
 * approaching the limit (≥80%), or over it (≥100%). Never a hard block. */
export type BudgetLevel = 'unlimited' | 'ok' | 'warn' | 'over';

/**
 * Fraction of the monthly DZD limit already spent, clamped to [0, 1] for bar
 * width. Returns `null` when there is NO limit (`monthDzd <= 0`) — the caller
 * then renders usage only (no bar/percentage). Defensive against NaN/negative.
 */
export function budgetRatio(
  spentDzd: number | null | undefined,
  monthDzd: number | null | undefined
): number | null {
  const limit = count(monthDzd);
  if (limit <= 0) return null; // usage-only mode (no configured budget)
  const spent = count(spentDzd);
  const r = spent / limit;
  if (!Number.isFinite(r) || r < 0) return 0;
  return r > 1 ? 1 : r;
}

/**
 * Classify the month's spend into a {@link BudgetLevel}. `'unlimited'` when no
 * limit is set (`monthDzd <= 0`); otherwise `'ok'` / `'warn'` (≥80%) / `'over'`
 * (≥100%). Purely presentational — the bar is ALWAYS soft and never gates.
 */
export function budgetLevel(
  spentDzd: number | null | undefined,
  monthDzd: number | null | undefined
): BudgetLevel {
  const limit = count(monthDzd);
  if (limit <= 0) return 'unlimited';
  const spent = count(spentDzd);
  const r = limit > 0 ? spent / limit : 0;
  if (r >= 1) return 'over';
  if (r >= BUDGET_WARN_RATIO) return 'warn';
  return 'ok';
}

/**
 * Format the spend as an integer percentage of the monthly limit (e.g. `84%`),
 * or `null` when there is no limit. Uncapped (can exceed 100% so the label can
 * read e.g. "120%"), unlike {@link budgetRatio} which clamps the BAR width.
 */
export function budgetPercentLabel(
  spentDzd: number | null | undefined,
  monthDzd: number | null | undefined
): string | null {
  const limit = count(monthDzd);
  if (limit <= 0) return null;
  const spent = count(spentDzd);
  const pct = Math.round((spent / limit) * 100);
  return `${Number.isFinite(pct) && pct >= 0 ? pct : 0}%`;
}

// ---------------------------------------------------------------------------
// SpendMeter — chip (compact) or card (full).
// ---------------------------------------------------------------------------
export function SpendMeter(props: SpendMeterProps) {
  const { compact, style, children } = props;
  // Language-aware copy (FR default). Subscribes this meter to the module-level
  // language so a toggle anywhere re-renders it.
  const { t, dir } = useAgentLang();
  const est = estimateSpend(props);
  const hasCost = est.dzd != null;
  const costLabel = hasCost ? `≈ ${formatDzd(est.dzd as number)} DZD` : '—';

  // ── Compact: a single chip for a list row (≈ 12 DZD) ──────────────────────
  if (compact) {
    // When pricing is set → show the DZD estimate; when unset → show the
    // tool-call count so the chip is never empty/misleading.
    const chipText = hasCost
      ? costLabel
      : `${est.toolCalls} ${
          est.toolCalls === 1 ? t('spend.tool.one') : t('spend.tool.many')
        }`;
    // Priced tooltip reuses the "estimé" note copy; unpriced uses its own key.
    const title = hasCost
      ? est.tokensExact
        ? t('spend.note.exact')
        : t('spend.note.estimated')
      : t('spend.title.compact.unpriced');
    return (
      <Chip
        color={hasCost ? P.color.text : P.color.muted}
        bg={hasCost ? P.color.accentSoft : undefined}
        border={hasCost ? P.color.accentBorder : P.color.border}
        title={title}
        style={style}
      >
        <span dir={hasCost ? 'ltr' : dir}>{chipText}</span>
      </Chip>
    );
  }

  // ── Full: a small card (counts + DZD estimate + an "estimé" note) ─────────
  const noteText = hasCost
    ? est.tokensExact
      ? t('spend.note.exact')
      : t('spend.note.estimated')
    : t('spend.note.unpriced');

  return (
    <div
      dir={dir}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: P.space.sm,
        padding: `${P.space.md}px ${P.space.md}px`,
        borderRadius: P.radius.md,
        border: `1px solid ${P.color.border}`,
        background: P.color.panelRaised,
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {/* Header row: caption + the headline DZD estimate (or "—"). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: P.space.sm,
        }}
      >
        <span
          style={{
            fontSize: P.font.size.xs,
            fontWeight: 700,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: P.color.muted,
          }}
        >
          {t('spend.title')}
        </span>
        <span
          dir="ltr"
          title={
            hasCost
              ? est.tokensExact
                ? t('spend.note.exact')
                : t('spend.note.estimated')
              : undefined
          }
          style={{
            fontSize: P.font.size.xl,
            fontWeight: 700,
            fontFamily: P.font.mono,
            color: hasCost ? P.color.text : P.color.muted,
            letterSpacing: '-0.01em',
            whiteSpace: 'nowrap',
          }}
        >
          {costLabel}
        </span>
      </div>

      {/* Metrics row: tool-calls + tokens (tokens marked "est." when derived). */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: P.space.sm,
          alignItems: 'center',
        }}
      >
        <Chip title="Appels d’outils facturés sur ce run">
          {est.toolCalls}{' '}
          {est.toolCalls === 1 ? t('spend.toolCall.one') : t('spend.toolCall.many')}
        </Chip>
        <Chip
          title={
            est.tokensExact
              ? 'Tokens (exact)'
              : `Tokens estimés (~${NOMINAL_TOKENS_PER_TOOL_CALL}/appel d’outil)`
          }
        >
          <span dir="ltr">
            {est.tokensExact
              ? t('spend.tokens', { value: formatTokens(est.tokens) })
              : t('spend.tokens.est', { value: formatTokens(est.tokens) })}
          </span>
        </Chip>
        {est.dzdPer1k > 0 ? (
          <span
            dir="ltr"
            style={{
              fontSize: P.font.size.xs,
              color: P.color.muted,
              fontFamily: P.font.mono,
            }}
          >
            {t('spend.perThousand', { price: formatDzd(est.dzdPer1k) })}
          </span>
        ) : null}
      </div>

      {/* The always-present "this is an estimate" note. */}
      <span
        style={{
          fontSize: P.font.size.xs,
          color: P.color.muted,
          lineHeight: 1.5,
        }}
      >
        {noteText}
      </span>

      {children}
    </div>
  );
}

export default SpendMeter;
