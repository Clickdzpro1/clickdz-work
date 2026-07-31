/**
 * CaissePad — Numeric-First Cash Register Entry for ClickDz Mobile
 *
 * Hermes Wiring Pattern:
 *   data-cdz-surface="caisse-pad" on the outermost wrapper.
 *   Uses the CdzResponsive null-component for CSS injection.
 *   Import ensureClickDzResponsiveCss from workspace utilities.
 *
 * Features:
 *   - inputMode="decimal" on the amount field forces numeric keypad on Android
 *   - Big touch targets: min 48px height on every tappable element
 *   - Large text-2xl font on the amount display (readable at arm's length)
 *   - Green (+), red (-) amount toggle
 *   - Calculator-like layout with clear/reset button
 *   - French UI labels throughout
 *
 * Props:
 *   onValidate(amount: number) — called when the user confirms the amount
 *   onCancel()                  — called when the user dismisses
 *   currency (default "DZD")   — currency symbol displayed next to amount
 */

import React, { useCallback, useEffect, useState, useRef } from 'react';
import { MOBILE_COLORS } from '../clickdz-mobile/colors';

// ─── Hermes Responsive CSS Injection (stub) ────────────────────────────────────

function ensureClickDzResponsiveCss(): void {
  if (typeof document === 'undefined') return;
  const id = 'cdz-responsive-css';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    [data-cdz-surface="caisse-pad"] {
      display: flex;
      flex-direction: column;
      min-height: 100dvh;
    }
    @media (min-width: 600px) {
      [data-cdz-surface="caisse-pad"] {
        max-width: 420px;
        margin: 0 auto;
      }
    }
  `;
  document.head.appendChild(style);
}

function CdzResponsive(): null {
  useEffect(() => { ensureClickDzResponsiveCss(); }, []);
  return null;
}

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface CaissePadProps {
  /** Called when the user validates the entered amount */
  onValidate: (amount: number) => void;
  /** Called when the user cancels / dismisses the pad */
  onCancel: () => void;
  /** Currency code displayed as suffix (default "DZD") */
  currency?: string;
}

// ─── Keypad Layout ──────────────────────────────────────────────────────────────

type KeyAction = 'digit' | 'decimal' | 'clear' | 'backspace' | 'sign' | 'validate';

interface KeyDef {
  label: string;
  action: KeyAction;
  value?: string;
  span?: 1 | 2;
  variant?: 'digit' | 'action' | 'validate' | 'cancel' | 'sign';
}

const KEYPAD_ROWS: KeyDef[][] = [
  [
    { label: '7', action: 'digit', value: '7', variant: 'digit' },
    { label: '8', action: 'digit', value: '8', variant: 'digit' },
    { label: '9', action: 'digit', value: '9', variant: 'digit' },
    { label: '⌫', action: 'backspace', variant: 'action' },
  ],
  [
    { label: '4', action: 'digit', value: '4', variant: 'digit' },
    { label: '5', action: 'digit', value: '5', variant: 'digit' },
    { label: '6', action: 'digit', value: '6', variant: 'digit' },
    { label: 'Effacer', action: 'clear', variant: 'cancel' },
  ],
  [
    { label: '1', action: 'digit', value: '1', variant: 'digit' },
    { label: '2', action: 'digit', value: '2', variant: 'digit' },
    { label: '3', action: 'digit', value: '3', variant: 'digit' },
    { label: '±', action: 'sign', variant: 'sign' },
  ],
  [
    { label: '0', action: 'digit', value: '0', variant: 'digit', span: 2 },
    { label: ',', action: 'decimal', variant: 'digit' },
    { label: 'Valider', action: 'validate', variant: 'validate' },
  ],
];

// ─── Styles ─────────────────────────────────────────────────────────────────────

const GRID_GAP = 8;
const KEY_MIN_HEIGHT = 56; // generous touch target

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100dvh',
    backgroundColor: MOBILE_COLORS.appBg,
    color: MOBILE_COLORS.textPrimary,
    userSelect: 'none',
    WebkitUserSelect: 'none',
    padding: '12px 16px env(safe-area-inset-bottom, 12px)',
  },

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottom: `1px solid ${MOBILE_COLORS.divider}`,
    marginBottom: 8,
  },

  headerTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: MOBILE_COLORS.textSecondary,
  },

  cancelBtn: {
    background: 'none',
    border: 'none',
    color: MOBILE_COLORS.textMuted,
    fontSize: 15,
    padding: '8px 4px',
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  displayArea: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'flex-end',
    padding: '20px 8px',
    minHeight: 120,
  },

  currencyLabel: {
    fontSize: 14,
    fontWeight: 500,
    color: MOBILE_COLORS.textMuted,
    marginBottom: 4,
    letterSpacing: '0.5px',
  },

  amountDisplay: {
    fontSize: 42, // text-2xl equivalent, readable at arm's length
    fontWeight: 700,
    color: MOBILE_COLORS.textPrimary,
    lineHeight: 1.2,
    letterSpacing: '-0.5px',
    wordBreak: 'break-all',
    textAlign: 'right',
  },

  amountDisplayNegative: {
    color: '#EF4444', // red for negative
  },

  signIndicator: {
    fontSize: 14,
    fontWeight: 600,
    color: '#EF4444',
    marginBottom: 2,
  },

  keypad: {
    display: 'flex',
    flexDirection: 'column',
    gap: GRID_GAP,
    paddingTop: 8,
  },

  row: {
    display: 'flex',
    gap: GRID_GAP,
  },

  key: (variant: KeyDef['variant']): React.CSSProperties => {
    const base: React.CSSProperties = {
      flex: 1,
      minHeight: KEY_MIN_HEIGHT,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 'none',
      borderRadius: 14,
      fontSize: variant === 'digit' ? 24 : 15,
      fontWeight: variant === 'digit' ? 500 : 600,
      cursor: 'pointer',
      transition: 'background-color 0.12s ease, transform 0.08s ease',
      WebkitTapHighlightColor: 'transparent',
      touchAction: 'manipulation',
    };

    switch (variant) {
      case 'digit':
        return {
          ...base,
          backgroundColor: MOBILE_COLORS.surfaceAlt,
          color: MOBILE_COLORS.textPrimary,
        };
      case 'action':
        return {
          ...base,
          backgroundColor: 'transparent',
          color: MOBILE_COLORS.textSecondary,
        };
      case 'validate':
        return {
          ...base,
          backgroundColor: '#10B981', // green validate
          color: '#FFFFFF',
          fontWeight: 700,
          fontSize: 16,
        };
      case 'cancel':
        return {
          ...base,
          backgroundColor: 'rgba(239, 68, 68, 0.15)', // red tint
          color: '#EF4444',
        };
      case 'sign':
        return {
          ...base,
          backgroundColor: MOBILE_COLORS.surfaceAlt,
          color: MOBILE_COLORS.textSecondary,
        };
      default:
        return base;
    }
  },

  keyDouble: (variant: KeyDef['variant']): React.CSSProperties => ({
    ...styles.key(variant),
    flex: 2.25, // span 2 columns + gap
  }),

  // ── Amount toggle (+/-) quick buttons above keypad ──────────────────────────
  toggleRow: {
    display: 'flex',
    gap: 10,
    paddingBottom: 8,
    paddingTop: 4,
  },

  toggleBtn: (isPositive: boolean): React.CSSProperties => ({
    flex: 1,
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    border: `1px solid ${
      isPositive ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)'
    }`,
    borderRadius: 10,
    backgroundColor: isPositive
      ? 'rgba(16, 185, 129, 0.08)'
      : 'rgba(239, 68, 68, 0.08)',
    color: isPositive ? '#10B981' : '#EF4444',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background-color 0.12s ease',
    WebkitTapHighlightColor: 'transparent',
    touchAction: 'manipulation',
  }),
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatDisplay(raw: string, isNegative: boolean): string {
  if (raw === '') return '0';
  const trimmed = raw.replace(/^0+(?=\d)/, ''); // strip leading zeros
  const parts = trimmed.split('.');
  // integer part with spaces as thousands separator
  const intPart = parts[0] || '0';
  const fracPart = parts[1] !== undefined ? ',' + parts[1] : '';
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + fracPart;
  return (isNegative ? '−' : '') + formatted;
}

function parseAmount(raw: string, isNegative: boolean): number {
  const normalized = raw.replace(',', '.');
  const val = parseFloat(normalized) || 0;
  return isNegative ? -val : val;
}

// ─── Component ──────────────────────────────────────────────────────────────────

export function CaissePad({
  onValidate,
  onCancel,
  currency = 'DZD',
}: CaissePadProps) {
  const [raw, setRaw] = useState<string>('');
  const [isNegative, setIsNegative] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the hidden input on mount so the native numeric keyboard appears
  useEffect(() => {
    // Small delay so the component mounts first
    const t = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, []);

  // Re-focus on any interaction to keep the keyboard open
  const refocusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const handleKey = useCallback(
    (key: KeyDef) => {
      refocusInput();
      switch (key.action) {
        case 'digit':
          setRaw((prev) => {
            // Prevent more than 2 decimal places
            const parts = prev.split('.');
            if (parts[1] && parts[1].length >= 2) return prev;
            // Prevent absurdly long integers
            if (!parts[1] && prev.replace('.', '').length >= 9) return prev;
            return prev + (key.value ?? '');
          });
          break;
        case 'decimal':
          setRaw((prev) => {
            if (prev.includes('.')) return prev; // already has decimal
            if (prev === '') return '0.';
            return prev + '.';
          });
          break;
        case 'clear':
          setRaw('');
          setIsNegative(false);
          break;
        case 'backspace':
          setRaw((prev) => {
            if (prev === '') return prev;
            return prev.slice(0, -1);
          });
          break;
        case 'sign':
          setIsNegative((prev) => !prev);
          break;
        case 'validate': {
          const amount = parseAmount(raw, isNegative);
          onValidate(amount);
          break;
        }
      }
    },
    [raw, isNegative, onValidate, refocusInput],
  );

  // Sync raw from hidden input (handles native keyboard input on Android)
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      let val = e.target.value;
      // Replace comma with dot for decimal
      val = val.replace(',', '.');
      // Only allow digits and one decimal point
      val = val.replace(/[^0-9.]/g, '');
      // Prevent more than one decimal point
      const parts = val.split('.');
      if (parts.length > 2) val = parts[0] + '.' + parts.slice(1).join('');
      // Limit decimal places
      if (parts[1] && parts[1].length > 2) {
        val = parts[0] + '.' + parts[1].slice(0, 2);
      }
      // Limit integer length
      if (parts[0] && parts[0].length > 9) {
        val = parts[0].slice(0, 9) + (parts[1] ? '.' + parts[1] : '');
      }
      setRaw(val);
    },
    [],
  );

  const amount = parseAmount(raw, isNegative);
  const display = formatDisplay(raw || '0', isNegative);

  return (
    <div style={styles.wrapper} data-cdz-surface="caisse-pad">
      <CdzResponsive />

      {/* ── Hidden input to trigger native numeric keyboard ───────────────── */}
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={raw}
        onChange={handleInputChange}
        style={{
          position: 'absolute',
          opacity: 0,
          pointerEvents: 'none',
          width: 1,
          height: 1,
          top: -9999,
          left: -9999,
        }}
        aria-hidden="true"
        autoComplete="off"
      />

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>💰 Caisse</span>
        <button
          style={styles.cancelBtn}
          onClick={onCancel}
          aria-label="Annuler"
          type="button"
        >
          ✕
        </button>
      </div>

      {/* ── Amount Display ────────────────────────────────────────────────── */}
      <div style={styles.displayArea}>
        <div style={styles.currencyLabel}>{currency}</div>
        {isNegative && <div style={styles.signIndicator}>− Crédit</div>}
        <div
          style={{
            ...styles.amountDisplay,
            ...(isNegative ? styles.amountDisplayNegative : {}),
          }}
          aria-live="polite"
        >
          {display}
        </div>
      </div>

      {/* ── Quick Toggle (+/-) ────────────────────────────────────────────── */}
      <div style={styles.toggleRow}>
        <button
          type="button"
          style={styles.toggleBtn(true)}
          onClick={() => { setIsNegative(false); refocusInput(); }}
        >
          <span>+</span>
          <span>Encaissement</span>
        </button>
        <button
          type="button"
          style={styles.toggleBtn(false)}
          onClick={() => { setIsNegative(true); refocusInput(); }}
        >
          <span>−</span>
          <span>Décaissement</span>
        </button>
      </div>

      {/* ── Keypad Grid ───────────────────────────────────────────────────── */}
      <div style={styles.keypad}>
        {KEYPAD_ROWS.map((row, ri) => (
          <div key={ri} style={styles.row}>
            {row.map((key) => {
              const keyStyle =
                key.span === 2
                  ? styles.keyDouble(key.variant ?? 'digit')
                  : styles.key(key.variant ?? 'digit');

              return (
                <button
                  key={`${ri}-${key.label}`}
                  type="button"
                  style={keyStyle}
                  onClick={() => handleKey(key)}
                  aria-label={key.label}
                >
                  {key.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* ── Cancel Bottom Button ──────────────────────────────────────────── */}
      <button
        type="button"
        onClick={onCancel}
        style={{
          marginTop: 12,
          minHeight: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'transparent',
          border: `1px solid ${MOBILE_COLORS.border}`,
          borderRadius: 12,
          color: MOBILE_COLORS.textMuted,
          fontSize: 15,
          fontWeight: 500,
          cursor: 'pointer',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        Annuler
      </button>
    </div>
  );
}

export default CaissePad;
