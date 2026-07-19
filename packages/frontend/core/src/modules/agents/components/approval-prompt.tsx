// ApprovalPrompt — renders a pending `approval_request` SSE event (tool, title,
// summary, args) with Approve / Deny buttons. Used inline in the transcript when
// a run pauses on a consequential tool (Hermes 'ask' mode). The `request` shape
// is the AgentEvent 'approval_request' variant (C1). Pure — calls onDecide.

import { useState } from 'react';

import { AgentPalette as P, ensureAgentKeyframes } from './palette';
import { formatArgs, labelStyle, preStyle } from './primitives';

export interface ApprovalRequest {
  id: string;
  tool: string;
  title: string;
  summary: string;
  args?: unknown;
}

export function ApprovalPrompt({
  request,
  onDecide,
  disabled,
}: {
  request: ApprovalRequest;
  onDecide: (id: string, decision: 'approve' | 'deny') => void;
  disabled?: boolean;
}) {
  ensureAgentKeyframes();
  const [decided, setDecided] = useState<'approve' | 'deny' | null>(null);
  const [showArgs, setShowArgs] = useState(false);
  const argsText = formatArgs(request.args);

  const decide = (d: 'approve' | 'deny') => {
    if (decided || disabled) return;
    setDecided(d);
    onDecide(request.id, d);
  };

  const locked = decided !== null || disabled;

  return (
    <div
      className="cdz-agent-fade"
      role="group"
      aria-label="Approval required"
      style={{
        borderRadius: P.radius.md,
        border: `1px solid ${P.color.warnBorder}`,
        background: P.color.warnBg,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden="true" style={{ fontSize: 15, color: P.color.warn }}>
          ⚠
        </span>
        <span
          style={{
            fontSize: P.font.size.lg,
            fontWeight: 700,
            color: P.color.text,
            flex: 1,
            minWidth: 0,
          }}
        >
          {request.title || 'Approval required'}
        </span>
        <span
          style={{
            fontFamily: P.font.mono,
            fontSize: P.font.size.sm,
            color: P.color.warn,
            padding: '1px 8px',
            borderRadius: P.radius.pill,
            border: `1px solid ${P.color.warnBorder}`,
            whiteSpace: 'nowrap',
          }}
        >
          {request.tool}
        </span>
      </div>

      {request.summary ? (
        <div
          style={{
            fontSize: P.font.size.md,
            color: P.color.text,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {request.summary}
        </div>
      ) : null}

      {argsText ? (
        <div>
          <button
            type="button"
            onClick={() => setShowArgs(s => !s)}
            aria-expanded={showArgs}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              ...labelStyle,
              marginBottom: showArgs ? 6 : 0,
            }}
          >
            {showArgs ? '▾' : '▸'} Arguments
          </button>
          {showArgs ? <pre style={preStyle}>{argsText}</pre> : null}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => decide('deny')}
          disabled={locked}
          className="cdz-agent-motion"
          style={{
            appearance: 'none',
            padding: '7px 16px',
            borderRadius: P.radius.md,
            border: `1px solid ${P.color.border}`,
            background: 'transparent',
            color:
              decided === 'deny' ? P.color.errText : P.color.text,
            fontSize: P.font.size.md,
            fontWeight: 600,
            cursor: locked ? 'default' : 'pointer',
            opacity: locked && decided !== 'deny' ? 0.5 : 1,
          }}
        >
          {decided === 'deny' ? 'Denied' : 'Deny'}
        </button>
        <button
          type="button"
          onClick={() => decide('approve')}
          disabled={locked}
          className="cdz-agent-motion"
          style={{
            appearance: 'none',
            padding: '7px 18px',
            borderRadius: P.radius.md,
            border: '1px solid transparent',
            background:
              decided === 'approve' ? P.color.okBg : P.color.accent,
            color:
              decided === 'approve' ? P.color.okText : P.color.onAccent,
            fontSize: P.font.size.md,
            fontWeight: 700,
            cursor: locked ? 'default' : 'pointer',
            opacity: locked && decided !== 'approve' ? 0.6 : 1,
          }}
        >
          {decided === 'approve' ? '✓ Approved' : 'Approve'}
        </button>
      </div>
    </div>
  );
}
