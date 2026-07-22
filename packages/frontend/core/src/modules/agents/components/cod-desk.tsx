// CodDesk — the cash-on-delivery counter in Hermès' Bureau (R11, WS11-7). A
// stack of COD orders straight from the shop's pipeline, each showing the
// customer, a WhatsApp tap (wa.me) on the phone, the wilaya, the DZD total and a
// status chip, plus the two moves an owner actually makes: Confirmer (Nouvelle →
// Confirmée) and Avancer (push to the next pipeline stage). COD is the dominant
// DZ checkout, so this desk is the operational heart of the hero. Pure
// presentational — Bureau supplies `orders`, `onConfirm(ref)`, `onAdvance(ref)`
// and `loading`; it NEVER fetches. Money uses the agent-money idiom (mono, LTR).
//
// Shape (contract): `orders = { ref, customer, phone, wilaya, totalDzd, status
// }[]`. `status` is the shop pipeline stage; the chip colour maps the known
// Nouvelle→Confirmée→Expédiée→Livrée/Retournée stages, unknown → neutral.
// `onConfirm` shows only while an order is still "Nouvelle"; `onAdvance` shows
// for any non-terminal stage. Empty ⇒ a calm "Aucune commande COD".
//
// i18n via useAgentLang() (`bureau.cod.*`). The customer phone opens a wa.me
// deep link in a new tab (digits only, normalised); RTL-safe layout for 'ar'.

import { useState } from 'react';

import { useAgentLang } from '../i18n';
import { AgentPalette as P, ensureAgentKeyframes } from './palette';
import { Chip } from './primitives';

export interface CodOrder {
  /** Stable order reference (what the action handlers echo back). */
  ref: string;
  /** Customer display name. */
  customer: string;
  /** Customer phone (any format — normalised to digits for the wa.me link). */
  phone: string;
  /** Wilaya (DZ province) label. */
  wilaya: string;
  /** Order total in Algerian dinar. */
  totalDzd: number;
  /** Pipeline stage (Nouvelle | Confirmée | Expédiée | Livrée | Retournée | …). */
  status: string;
}

export interface CodDeskProps {
  orders: CodOrder[];
  /** Confirm a still-new order (Nouvelle → Confirmée). */
  onConfirm: (ref: string) => void;
  /** Advance an order to the next pipeline stage. */
  onAdvance: (ref: string) => void;
  loading?: boolean;
}

// ── Local helpers ──────────────────────────────────────────────────────────

/** DZD grouping (mirrors the kit's formatDzd; whole dinar, fr-DZ grouping). */
function fmtDzd(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '0';
  const n = Math.round(amount);
  try {
    return new Intl.NumberFormat('fr-DZ').format(n);
  } catch {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
}

/** Build a wa.me deep link from a loose phone string (digits only). A leading
 * local `0` is dropped in favour of the DZ country code `213` so the link works
 * from any locale; already-international numbers pass through unchanged. */
function waMeHref(phone: string): string | null {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  const intl = digits.startsWith('0') ? `213${digits.slice(1)}` : digits;
  return `https://wa.me/${intl}`;
}

// Status → chip tint. Known DZ pipeline stages get semantic colours; anything
// else stays neutral so an evolving pipeline never breaks the chip.
function statusTint(status: string): { color: string; bg: string; border: string } {
  const s = (status || '').toLowerCase();
  if (s.includes('nouvel')) {
    return { color: P.color.warn, bg: P.color.warnBg, border: P.color.warnBorder };
  }
  if (s.includes('confirm')) {
    return { color: P.color.accent, bg: P.color.accentSoft, border: P.color.accentBorder };
  }
  if (s.includes('expéd') || s.includes('exped') || s.includes('livr')) {
    return { color: P.color.ok, bg: P.color.okBg, border: P.color.okBorder };
  }
  if (s.includes('retour')) {
    return { color: P.color.err, bg: P.color.errBg, border: P.color.errBorder };
  }
  return { color: P.color.muted, bg: 'transparent', border: P.color.border };
}

/** Is this a still-new order (Confirmer applies)? */
function isNew(status: string): boolean {
  return (status || '').toLowerCase().includes('nouvel');
}

/** Is this a terminal stage (nothing left to advance)? */
function isTerminal(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s.includes('livr') || s.includes('retour');
}

export function CodDesk({ orders, onConfirm, onAdvance, loading }: CodDeskProps) {
  ensureAgentKeyframes();
  const { t, dir } = useAgentLang();
  // Lock a row's action buttons the instant one is tapped (optimistic).
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const list = Array.isArray(orders) ? orders : [];

  const act = (ref: string, fn: (ref: string) => void) => {
    if (busy[ref]) return;
    setBusy(prev => ({ ...prev, [ref]: true }));
    fn(ref);
  };

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: P.space.sm,
        marginBottom: P.space.sm,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: P.font.size.xs,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: P.color.muted,
        }}
      >
        {t('bureau.cod.title')}
      </span>
      {list.length > 0 ? (
        <Chip>{list.length}</Chip>
      ) : null}
    </div>
  );

  // ── Empty state ───────────────────────────────────────────────────────────
  if (list.length === 0) {
    return (
      <div dir={dir}>
        {header}
        <div
          style={{
            padding: `${P.space.lg}px ${P.space.md}px`,
            borderRadius: P.radius.md,
            border: `1px dashed ${P.color.border}`,
            background: P.color.panelRaised,
            color: P.color.muted,
            fontSize: P.font.size.md,
            textAlign: 'center',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {t('bureau.cod.empty')}
        </div>
      </div>
    );
  }

  return (
    <div dir={dir}>
      {header}
      <div style={{ display: 'flex', flexDirection: 'column', gap: P.space.sm }}>
        {list.map(o => {
          const tint = statusTint(o.status);
          const href = waMeHref(o.phone);
          const rowBusy = !!busy[o.ref];
          const showConfirm = isNew(o.status);
          const showAdvance = !isTerminal(o.status);
          return (
            <div
              key={o.ref}
              className="cdz-agent-fade"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: P.space.sm,
                padding: `${P.space.md}px ${P.space.md}px`,
                borderRadius: P.radius.md,
                border: `1px solid ${P.color.border}`,
                background: P.color.panelRaised,
                opacity: rowBusy ? 0.6 : 1,
                transition: `opacity ${P.motion.base} ${P.motion.ease}`,
                boxSizing: 'border-box',
              }}
            >
              {/* Top row: customer + status chip + DZD total */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: P.space.sm,
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: P.font.size.md,
                    fontWeight: 700,
                    color: P.color.text,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {o.customer || t('bureau.cod.noName')}
                </span>
                <Chip color={tint.color} bg={tint.bg} border={tint.border}>
                  {o.status || t('states.unknown')}
                </Chip>
                <span
                  dir="ltr"
                  style={{
                    fontSize: P.font.size.lg,
                    fontWeight: 800,
                    fontFamily: P.font.mono,
                    color: P.color.text,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fmtDzd(o.totalDzd)}{' '}
                  <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.7 }}>
                    DZD
                  </span>
                </span>
              </div>

              {/* Meta row: wilaya + WhatsApp phone tap */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: P.space.md,
                  flexWrap: 'wrap',
                  fontSize: P.font.size.sm,
                  color: P.color.muted,
                }}
              >
                {o.wilaya ? (
                  <span
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <span aria-hidden="true">📍</span>
                    {o.wilaya}
                  </span>
                ) : null}
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="cdz-agent-motion"
                    title={t('bureau.cod.whatsapp')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      color: P.color.ok,
                      textDecoration: 'none',
                      fontFamily: P.font.mono,
                      direction: 'ltr',
                    }}
                  >
                    <span aria-hidden="true">🟢</span>
                    {o.phone}
                  </a>
                ) : o.phone ? (
                  <span dir="ltr" style={{ fontFamily: P.font.mono }}>
                    {o.phone}
                  </span>
                ) : null}
                <span
                  dir="ltr"
                  style={{
                    marginInlineStart: 'auto',
                    fontSize: P.font.size.xs,
                    fontFamily: P.font.mono,
                    opacity: 0.7,
                  }}
                >
                  #{o.ref}
                </span>
              </div>

              {/* Action row: Confirmer (new only) + Avancer (non-terminal) */}
              {showConfirm || showAdvance ? (
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  {showConfirm ? (
                    <button
                      type="button"
                      onClick={() => act(o.ref, onConfirm)}
                      disabled={rowBusy}
                      className="cdz-agent-motion"
                      style={{
                        appearance: 'none',
                        padding: '6px 14px',
                        borderRadius: P.radius.sm,
                        border: '1px solid transparent',
                        background: P.color.accent,
                        color: P.color.onAccent,
                        fontSize: P.font.size.sm,
                        fontWeight: 700,
                        cursor: rowBusy ? 'default' : 'pointer',
                      }}
                    >
                      {t('bureau.cod.confirm')}
                    </button>
                  ) : null}
                  {showAdvance ? (
                    <button
                      type="button"
                      onClick={() => act(o.ref, onAdvance)}
                      disabled={rowBusy}
                      className="cdz-agent-motion"
                      style={{
                        appearance: 'none',
                        padding: '6px 14px',
                        borderRadius: P.radius.sm,
                        border: `1px solid ${P.color.border}`,
                        background: 'transparent',
                        color: P.color.text,
                        fontSize: P.font.size.sm,
                        fontWeight: 600,
                        cursor: rowBusy ? 'default' : 'pointer',
                      }}
                    >
                      {t('bureau.cod.advance')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default CodDesk;
