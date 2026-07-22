// PulseCard — the business-pulse HERO of Hermès' "Le Bureau" (R11, WS11-7).
// A single agent-accent-tinted card that greets the shop owner with the five
// numbers that matter TODAY: commandes du jour, à confirmer, chiffre du jour
// (DZD), retours, stock bas. Pure presentational — the numbers + the loading /
// refresh handler arrive via props (Bureau fetches them from Pouls's
// GET /api/v1/agents/pulse). It NEVER fetches.
//
// Shape (contract): `pulse = { ordersToday, toConfirm, revenueTodayDzd, returns,
// lowStock } | null`. `null` ⇒ no shop connected yet → a warm "new hire" empty
// state (not an error). `loading` ⇒ a soft skeleton so the hero never flashes
// empty. The accent family (Hermès teal + payday gold for the money tile) comes
// from `accentFor(agent)` so this reads identically to the rest of the R10
// identity kit; the money figure uses the agent's `accentText` (payday gold),
// exactly the second-ink role the palette doc reserves for COD/money figures.
//
// i18n via useAgentLang() (FR default + darja) through the `bureau.*` key group
// Trame adds to i18n.ts. DZD is grouped with a local formatter that mirrors
// spend-meter's `formatDzd` (fr-DZ Intl grouping + a manual fallback so it never
// throws in a constrained runtime). RTL-safe: the card flips for 'ar' while the
// numeric tiles stay LTR.

import type { CSSProperties, ReactNode } from 'react';

import { useAgentLang } from '../i18n';
import { accentFor, AgentPalette as P, ensureAgentKeyframes } from './palette';
import { IconButton, Spinner } from './primitives';

// ---------------------------------------------------------------------------
// The pulse shape (contract-pinned). Every field a plain non-negative count;
// `revenueTodayDzd` is a dinar amount (grouped by the local formatter below).
// ---------------------------------------------------------------------------
export interface AgentPulse {
  ordersToday: number;
  toConfirm: number;
  revenueTodayDzd: number;
  returns: number;
  lowStock: number;
}

export interface PulseCardProps {
  /** Which agent's accent family tints the hero. Unknown → shared accent. */
  agent?: 'hermes' | 'openclaw' | string;
  /** The five business numbers, or `null` when no shop is connected yet. */
  pulse: AgentPulse | null;
  /** Soft skeleton while the numbers load (never flashes empty). */
  loading?: boolean;
  /** Optional manual refresh affordance (a small ↻ button in the header). */
  onRefresh?: () => void;
}

// ---------------------------------------------------------------------------
// Local DZD formatter — mirrors spend-meter.tsx `formatDzd` (fr-DZ grouping
// with a manual thousands fallback). Kept LOCAL (contract: "DZD via a local
// fmt") so PulseCard has no cross-component coupling; behaviour matches the kit.
// ---------------------------------------------------------------------------
function fmtDzd(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '0';
  const n = Math.round(amount);
  try {
    return new Intl.NumberFormat('fr-DZ').format(n);
  } catch {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
}

/** Coerce a loose numeric prop to a clean count ≥ 0 (never NaN/negative). */
function num(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

// A single KPI tile. `emphasis` (the money tile) inks the value in the agent's
// accentText (payday gold); `warn` (à confirmer / stock bas when non-zero) gives
// a soft amber bed so the owner's eye lands on what needs action.
function Tile({
  label,
  value,
  accent,
  emphasis,
  warn,
  suffix,
}: {
  label: string;
  value: ReactNode;
  accent: string;
  emphasis?: boolean;
  warn?: boolean;
  suffix?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: `${P.space.md}px ${P.space.md}px`,
        borderRadius: P.radius.md,
        border: `1px solid ${warn ? P.color.warnBorder : P.color.border}`,
        background: warn ? P.color.warnBg : P.color.panelRaised,
        minWidth: 0,
        boxSizing: 'border-box',
      }}
    >
      <span
        dir="ltr"
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 4,
          fontSize: 26,
          fontWeight: 800,
          lineHeight: 1.1,
          fontFamily: P.font.mono,
          letterSpacing: '-0.02em',
          color: emphasis ? accent : warn ? P.color.warn : P.color.text,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
        {suffix ? (
          <span style={{ fontSize: 12, fontWeight: 700, opacity: 0.7 }}>
            {suffix}
          </span>
        ) : null}
      </span>
      <span
        style={{
          fontSize: P.font.size.xs,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: P.color.muted,
          lineHeight: 1.3,
        }}
      >
        {label}
      </span>
    </div>
  );
}

const GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: P.space.sm,
};

export function PulseCard({ agent, pulse, loading, onRefresh }: PulseCardProps) {
  ensureAgentKeyframes();
  const { t, dir } = useAgentLang();
  const acc = accentFor(agent);

  const shell: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: P.space.md,
    padding: P.space.lg,
    borderRadius: P.radius.lg,
    border: `1px solid ${acc.accentSoft}`,
    // A soft accent wash behind the hero so it reads as the agent's own surface.
    background: `linear-gradient(135deg, ${acc.accentSoft}, ${P.color.panelRaised})`,
    boxSizing: 'border-box',
  };

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: P.space.sm,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: P.font.size.lg,
          fontWeight: 700,
          color: P.color.text,
        }}
      >
        {t('bureau.pulse.title')}
      </span>
      {loading ? <Spinner size={14} color={acc.accent} /> : null}
      {onRefresh ? (
        <IconButton label={t('common.refresh')} onClick={onRefresh}>
          ↻
        </IconButton>
      ) : null}
    </div>
  );

  // ── Loading skeleton: five soft placeholder tiles ─────────────────────────
  if (loading && !pulse) {
    return (
      <div dir={dir} className="cdz-agent-fade" style={shell}>
        {header}
        <div style={GRID}>
          {[0, 1, 2, 3, 4].map(i => (
            <div
              key={i}
              className="cdz-agent-motion"
              aria-hidden="true"
              style={{
                height: 74,
                borderRadius: P.radius.md,
                border: `1px solid ${P.color.border}`,
                background: P.color.panelRaised,
                opacity: 0.6,
                animation: 'cdz-agent-pulse 1.4s ease-in-out infinite',
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  // ── Not connected: warm new-hire empty state (not an error) ───────────────
  if (!pulse) {
    return (
      <div dir={dir} className="cdz-agent-fade" style={shell}>
        {header}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: `${P.space.md}px 2px`,
          }}
        >
          <span
            style={{
              fontSize: P.font.size.lg,
              fontWeight: 700,
              color: P.color.text,
            }}
          >
            {t('bureau.pulse.empty.title')}
          </span>
          <span
            style={{
              fontSize: P.font.size.md,
              color: P.color.muted,
              lineHeight: 1.55,
            }}
          >
            {t('bureau.pulse.empty.body')}
          </span>
        </div>
      </div>
    );
  }

  const p = pulse;
  return (
    <div dir={dir} className="cdz-agent-fade" style={shell}>
      {header}
      <div style={GRID}>
        <Tile
          label={t('bureau.pulse.ordersToday')}
          value={num(p.ordersToday)}
          accent={acc.accent}
        />
        <Tile
          label={t('bureau.pulse.toConfirm')}
          value={num(p.toConfirm)}
          accent={acc.accent}
          warn={num(p.toConfirm) > 0}
        />
        <Tile
          label={t('bureau.pulse.revenueToday')}
          value={fmtDzd(num(p.revenueTodayDzd))}
          suffix="DZD"
          accent={acc.accentText}
          emphasis
        />
        <Tile
          label={t('bureau.pulse.returns')}
          value={num(p.returns)}
          accent={acc.accent}
        />
        <Tile
          label={t('bureau.pulse.lowStock')}
          value={num(p.lowStock)}
          accent={acc.accent}
          warn={num(p.lowStock) > 0}
        />
      </div>
    </div>
  );
}

export default PulseCard;
