// MessageBubble — one turn in the transcript. User turns are a compact
// right-aligned accent bubble; assistant turns are a full-width surface that
// renders the step timeline (StepList) above the answer (MarkdownLite) with a
// live StreamingText cursor while `streaming`. Typed against AgentMessage (C1).
// Pure presentational.

import type { ReactNode } from 'react';

import type { AgentMessage } from '../types';
import { MarkdownLite } from './markdown-lite';
import { AgentPalette as P } from './palette';
import { StepList } from './tool-call-card';
import { StreamingText } from './streaming-text';

function Avatar({ role, agent }: { role: string; agent?: string }) {
  const isUser = role === 'user';
  const glyph = isUser ? 'You' : agent === 'openclaw' ? '›_' : '⚡';
  return (
    <div
      aria-hidden="true"
      style={{
        width: 26,
        height: 26,
        borderRadius: P.radius.sm,
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: isUser ? 10 : 13,
        fontWeight: 700,
        fontFamily: agent === 'openclaw' && !isUser ? P.font.mono : P.font.body,
        color: isUser ? P.color.muted : P.color.onAccent,
        background: isUser ? 'transparent' : P.color.accent,
        border: isUser ? `1px solid ${P.color.border}` : 'none',
      }}
    >
      {glyph}
    </div>
  );
}

export function MessageBubble({
  message,
  streaming,
  extras,
}: {
  message: AgentMessage;
  streaming?: boolean;
  // Pages can inject per-message panels (artifacts, preview links, approval
  // prompts) beneath the answer via ConversationThread.renderExtras.
  extras?: ReactNode;
}) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div
        className="cdz-agent-fade"
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          padding: '2px 0',
        }}
      >
        <div
          style={{
            maxWidth: '82%',
            padding: '9px 13px',
            borderRadius: `${P.radius.lg}px ${P.radius.lg}px ${P.radius.xs}px ${P.radius.lg}px`,
            background: P.color.accentSoft,
            border: `1px solid ${P.color.accentBorder}`,
            color: P.color.text,
            fontSize: P.font.size.lg,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {message.content}
        </div>
        <Avatar role="user" />
      </div>
    );
  }

  const hasSteps = !!message.steps && message.steps.length > 0;
  const activeIndex =
    streaming && message.steps ? message.steps.length - 1 : undefined;

  return (
    <div
      className="cdz-agent-fade"
      style={{ display: 'flex', gap: 10, padding: '2px 0' }}
    >
      <Avatar role="assistant" agent={message.agent} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {hasSteps ? (
          <div style={{ marginBottom: message.content ? 12 : 0 }}>
            <StepList steps={message.steps ?? []} activeIndex={activeIndex} />
          </div>
        ) : null}
        {message.content ? (
          streaming ? (
            <StreamingText text={message.content} active />
          ) : (
            <MarkdownLite text={message.content} />
          )
        ) : streaming && !hasSteps ? (
          // Nothing yet — a bare cursor so the surface doesn't read as empty.
          <StreamingText text="" active />
        ) : null}
        {extras ? <div style={{ marginTop: 12 }}>{extras}</div> : null}
      </div>
    </div>
  );
}
