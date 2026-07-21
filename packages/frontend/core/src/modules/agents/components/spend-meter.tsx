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

import type { CSSProperties, ReactNode } from 'react';

import type { AgentRunRecord, AgentRunSummary } from '../types';
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
// SpendMeter — chip (compact) or card (full).
// ---------------------------------------------------------------------------
export function SpendMeter(props: SpendMeterProps) {
  const { compact, style, children } = props;
  const est = estimateSpend(props);
  const hasCost = est.dzd != null;
  const costLabel = hasCost ? `≈ ${formatDzd(est.dzd as number)} DZD` : '—';

  // ── Compact: a single chip for a list row (≈ 12 DZD) ──────────────────────
  if (compact) {
    // When pricing is set → show the DZD estimate; when unset → show the
    // tool-call count so the chip is never empty/misleading.
    const chipText = hasCost
      ? costLabel
      : `${est.toolCalls} ${est.toolCalls === 1 ? 'outil' : 'outils'}`;
    const title = hasCost
      ? `Coût estimé (estimation${
          est.tokensExact ? '' : ' d’après le nombre d’appels d’outils'
        }) — non exact`
      : 'Prix par 1k tokens non configuré — appels d’outils uniquement';
    return (
      <Chip
        color={hasCost ? P.color.text : P.color.muted}
        bg={hasCost ? P.color.accentSoft : undefined}
        border={hasCost ? P.color.accentBorder : P.color.border}
        title={title}
        style={style}
      >
        {chipText}
      </Chip>
    );
  }

  // ── Full: a small card (counts + DZD estimate + an "estimé" note) ─────────
  const noteText = hasCost
    ? est.tokensExact
      ? 'Estimé — coût indicatif, non facturé ici.'
      : 'Estimé d’après le nombre d’appels d’outils — pas une facture.'
    : 'Prix par 1k tokens non configuré : aucun montant affiché.';

  return (
    <div
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
          Coût estimé
        </span>
        <span
          title={
            hasCost
              ? est.tokensExact
                ? 'Estimation — non exact'
                : 'Estimation d’après les appels d’outils — non exact'
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
          {est.toolCalls} {est.toolCalls === 1 ? 'appel d’outil' : 'appels d’outils'}
        </Chip>
        <Chip
          title={
            est.tokensExact
              ? 'Tokens (exact)'
              : `Tokens estimés (~${NOMINAL_TOKENS_PER_TOOL_CALL}/appel d’outil)`
          }
        >
          {est.tokensExact ? '' : '≈ '}
          {formatTokens(est.tokens)} tokens
          {est.tokensExact ? '' : ' (est.)'}
        </Chip>
        {est.dzdPer1k > 0 ? (
          <span
            style={{
              fontSize: P.font.size.xs,
              color: P.color.muted,
              fontFamily: P.font.mono,
            }}
          >
            {formatDzd(est.dzdPer1k)} DZD / 1k
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
