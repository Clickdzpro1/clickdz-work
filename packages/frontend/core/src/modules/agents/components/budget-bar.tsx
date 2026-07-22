// BudgetBar — a SOFT monthly-spend read-out for the agents home (R11, WS11-11).
// Same philosophy as SpendMeter (spend-meter.tsx): it INFORMS, it never blocks.
// When a monthly DZD budget is configured (`monthDzd > 0`) it shows a gentle
// progress bar of spent/month that tints amber at ≥80% and red at ≥100% — but it
// is purely visual: nothing is gated, capped, or interrupted, ever. When no
// budget is set (`monthDzd === 0`, the default: env CDZ_AGENT_MONTHLY_DZD unset)
// it drops the limit bar entirely and shows a plain USAGE line — runs today (vs
// the daily cap, if any) + tokens this month — so a DZ SMB owner still gets a
// feel for consumption without an invented ceiling. Pure presentational — Budget
// supplies the numbers via `budget`; it NEVER fetches.
//
// Shape (contract): `budget = { monthDzd, spentDzd, runsToday, runsCap, tokens
// }`. All coerced to clean counts (never NaN/negative). DZD grouped by a local
// formatter mirroring the kit; token counts compacted (2.4k) like formatTokens.
//
// i18n via useAgentLang() (`budget.*`). RTL-safe: the bar/labels flip for 'ar'
// while numeric spans (DZD, %, tokens) stay LTR.

import { useAgentLang } from '../i18n';
import { AgentPalette as P, ensureAgentKeyframes } from './palette';

export interface AgentBudget {
  /** Monthly DZD budget. 0 ⇒ no limit → usage-only mode (no bar). */
  monthDzd: number;
  /** DZD spent so far this month (the accumulator). */
  spentDzd: number;
  /** Runs started today (against `runsCap`). */
  runsToday: number;
  /** Daily run cap (0 / undefined ⇒ no cap shown). */
  runsCap: number;
  /** Tokens consumed this month (compacted for display). */
  tokens: number;
}

export interface BudgetBarProps {
  budget: AgentBudget;
}

// ── Local formatters (mirror the kit; keep BudgetBar self-contained) ─────────

function num(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function fmtDzd(amount: number): string {
  const n = Math.round(num(amount));
  try {
    return new Intl.NumberFormat('fr-DZ').format(n);
  } catch {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
}

/** Compact token count: 2400 → "2.4k", 900 → "900" (matches formatTokens). */
function fmtTokens(tokens: number): string {
  const v = num(tokens);
  if (v <= 0) return '0';
  if (v < 1000) return String(Math.round(v));
  const k = v / 1000;
  return `${k.toFixed(k < 10 ? 1 : 0)}k`;
}

export function BudgetBar({ budget }: BudgetBarProps) {
  ensureAgentKeyframes();
  const { t, dir } = useAgentLang();

  const monthDzd = num(budget?.monthDzd);
  const spentDzd = num(budget?.spentDzd);
  const runsToday = num(budget?.runsToday);
  const runsCap = num(budget?.runsCap);
  const tokens = num(budget?.tokens);

  const shell = {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: P.space.sm,
    padding: `${P.space.md}px ${P.space.md}px`,
    borderRadius: P.radius.md,
    border: `1px solid ${P.color.border}`,
    background: P.color.panelRaised,
    boxSizing: 'border-box' as const,
  };

  const caption = (
    <span
      style={{
        fontSize: P.font.size.xs,
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: P.color.muted,
      }}
    >
      {t('budget.title')}
    </span>
  );

  // ── Usage-only mode: no budget set ⇒ no bar, just the counts ──────────────
  if (monthDzd <= 0) {
    return (
      <div dir={dir} style={shell}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: P.space.sm,
          }}
        >
          {caption}
          <span
            style={{
              fontSize: P.font.size.xs,
              color: P.color.muted,
            }}
          >
            {t('budget.noLimit')}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: P.space.md,
            alignItems: 'baseline',
          }}
        >
          <span
            dir="ltr"
            style={{
              fontSize: P.font.size.md,
              color: P.color.text,
              fontFamily: P.font.mono,
            }}
          >
            <strong style={{ fontWeight: 800 }}>{runsToday}</strong>
            {runsCap > 0 ? (
              <span style={{ color: P.color.muted }}>/{runsCap}</span>
            ) : null}{' '}
            <span
              style={{
                fontFamily: P.font.body,
                fontSize: P.font.size.sm,
                color: P.color.muted,
              }}
            >
              {t('budget.runsToday')}
            </span>
          </span>
          <span
            dir="ltr"
            style={{
              fontSize: P.font.size.md,
              color: P.color.text,
              fontFamily: P.font.mono,
            }}
          >
            <strong style={{ fontWeight: 800 }}>{fmtTokens(tokens)}</strong>{' '}
            <span
              style={{
                fontFamily: P.font.body,
                fontSize: P.font.size.sm,
                color: P.color.muted,
              }}
            >
              {t('budget.tokensMonth')}
            </span>
          </span>
        </div>
      </div>
    );
  }

  // ── Budgeted mode: a soft progress bar (amber ≥80%, red ≥100%) ────────────
  const ratio = spentDzd / monthDzd; // may exceed 1 — we clamp only the fill
  const pct = Math.round(ratio * 100);
  const fillPct = Math.max(0, Math.min(100, ratio * 100));
  const over = ratio >= 1;
  const warn = ratio >= 0.8;
  const barColor = over ? P.color.err : warn ? P.color.warn : P.color.accent;
  const noteColor = over ? P.color.errText : warn ? P.color.warn : P.color.muted;

  return (
    <div dir={dir} style={shell}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: P.space.sm,
        }}
      >
        {caption}
        <span
          dir="ltr"
          style={{
            fontSize: P.font.size.md,
            fontWeight: 700,
            fontFamily: P.font.mono,
            color: P.color.text,
            whiteSpace: 'nowrap',
          }}
        >
          {fmtDzd(spentDzd)}{' '}
          <span style={{ color: P.color.muted, fontWeight: 400 }}>
            / {fmtDzd(monthDzd)} DZD
          </span>
        </span>
      </div>

      {/* The soft bar — decorative, never a gate. */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.max(0, Math.min(100, pct))}
        aria-label={t('budget.title')}
        style={{
          position: 'relative',
          height: 8,
          borderRadius: P.radius.pill,
          background: P.color.border,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            position: 'absolute',
            insetInlineStart: 0,
            top: 0,
            bottom: 0,
            width: `${fillPct}%`,
            background: barColor,
            borderRadius: P.radius.pill,
            transition: `width ${P.motion.slow} ${P.motion.ease}, background ${P.motion.base} ${P.motion.ease}`,
          }}
        />
      </div>

      {/* Footer: % used (warns) + the usage counts alongside. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: P.space.sm,
          flexWrap: 'wrap',
        }}
      >
        <span
          dir="ltr"
          style={{
            fontSize: P.font.size.xs,
            fontWeight: 700,
            color: noteColor,
          }}
        >
          {over
            ? t('budget.over', { pct })
            : warn
              ? t('budget.warn', { pct })
              : t('budget.used', { pct })}
        </span>
        <span
          dir="ltr"
          style={{
            fontSize: P.font.size.xs,
            color: P.color.muted,
            fontFamily: P.font.mono,
          }}
        >
          {runsToday}
          {runsCap > 0 ? `/${runsCap}` : ''} · {fmtTokens(tokens)} tok
        </span>
      </div>
    </div>
  );
}

export default BudgetBar;
