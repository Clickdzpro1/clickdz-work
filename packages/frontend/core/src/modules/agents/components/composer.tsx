// Composer — the bottom input. Auto-growing textarea (Enter=send,
// Shift+Enter=newline), a Send button that becomes a Stop button while
// `running`, and leftSlot/rightSlot for mode/runtime pickers the pages inject.
// Controlled (value/onChange). Pure — calls onSend/onStop, never fetches.

import { type ReactNode, useCallback, useEffect, useRef } from 'react';

import { AgentPalette as P } from './palette';
import { Spinner } from './primitives';

const MAX_ROWS_PX = 200;

export function Composer({
  value,
  onChange,
  onSend,
  running,
  onStop,
  disabled,
  placeholder,
  leftSlot,
  rightSlot,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  running: boolean;
  onStop: () => void;
  disabled?: boolean;
  placeholder?: string;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const canSend = !disabled && !running && value.trim().length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div
      style={{
        borderTop: `1px solid ${P.color.border}`,
        background: P.color.bg,
        padding: '10px 14px 12px',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          borderRadius: P.radius.lg,
          border: `1px solid ${P.color.border}`,
          background: P.color.panel,
          padding: 8,
          transition: `border-color ${P.motion.base} ${P.motion.ease}`,
        }}
        onFocusCapture={e => {
          (e.currentTarget as HTMLElement).style.borderColor =
            P.color.accentBorder;
        }}
        onBlurCapture={e => {
          (e.currentTarget as HTMLElement).style.borderColor = P.color.border;
        }}
      >
        <textarea
          ref={ref}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled}
          placeholder={
            placeholder ?? 'Ask anything — Enter to send, Shift+Enter for a new line'
          }
          aria-label="Message"
          style={{
            appearance: 'none',
            width: '100%',
            resize: 'none',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: P.color.text,
            fontFamily: P.font.body,
            fontSize: P.font.size.lg,
            lineHeight: 1.5,
            padding: '4px 6px',
            maxHeight: MAX_ROWS_PX,
            overflowY: 'auto',
            boxSizing: 'border-box',
          }}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flex: 1,
              minWidth: 0,
              flexWrap: 'wrap',
            }}
          >
            {leftSlot}
          </div>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {rightSlot}
            {running ? (
              <button
                type="button"
                onClick={onStop}
                className="cdz-agent-motion"
                aria-label="Stop generating"
                style={{
                  appearance: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '7px 14px',
                  borderRadius: P.radius.md,
                  border: `1px solid ${P.color.errBorder}`,
                  background: P.color.errBg,
                  color: P.color.errText,
                  fontSize: P.font.size.md,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: `filter ${P.motion.fast} ${P.motion.ease}`,
                }}
              >
                <Spinner size={12} color={P.color.errText} />
                <span
                  aria-hidden="true"
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 2,
                    background: P.color.errText,
                  }}
                />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => canSend && onSend()}
                disabled={!canSend}
                className="cdz-agent-motion"
                aria-label="Send message"
                style={{
                  appearance: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '7px 16px',
                  borderRadius: P.radius.md,
                  border: '1px solid transparent',
                  background: canSend ? P.color.accent : P.color.border,
                  color: canSend ? P.color.onAccent : P.color.muted,
                  fontSize: P.font.size.md,
                  fontWeight: 600,
                  cursor: canSend ? 'pointer' : 'default',
                  transition: `background ${P.motion.fast} ${P.motion.ease}, filter ${P.motion.fast} ${P.motion.ease}`,
                }}
                onMouseEnter={e => {
                  if (canSend) e.currentTarget.style.filter = 'brightness(1.08)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.filter = 'none';
                }}
              >
                Send
                <span aria-hidden="true" style={{ fontSize: 13 }}>
                  ↵
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
