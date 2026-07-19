// ConversationThread — the scrollable transcript. Renders a MessageBubble per
// AgentMessage plus an optional in-progress `streamingMessage`. Auto-scrolls to
// the bottom whenever content changes, UNLESS the user has scrolled up more than
// STICK_THRESHOLD px from the bottom (then it stays put and shows a
// "jump to latest" affordance). Typed against AgentMessage (C1). Pure — data +
// handlers via props, never fetches.

import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { AgentMessage } from '../types';
import { MessageBubble } from './message-bubble';
import { AgentPalette as P, ensureAgentKeyframes } from './palette';

const STICK_THRESHOLD = 80; // px from bottom within which we keep auto-scrolling

export function ConversationThread({
  messages,
  streamingMessage,
  renderExtras,
  emptyState,
  style,
}: {
  messages: AgentMessage[];
  streamingMessage?: AgentMessage | null;
  // Per-message injection point (artifacts, preview, inline approval, etc.).
  renderExtras?: (message: AgentMessage, isStreaming: boolean) => ReactNode;
  // Shown when there are no messages and nothing is streaming (pages pass an
  // <EmptyState/>).
  emptyState?: ReactNode;
  style?: React.CSSProperties;
}) {
  ensureAgentKeyframes();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return (
      el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD
    );
  }, []);

  const onScroll = useCallback(() => {
    const near = isNearBottom();
    stickRef.current = near;
    setShowJump(!near);
  }, [isNearBottom]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    stickRef.current = true;
    setShowJump(false);
  }, []);

  // Track content length + the streaming text so we re-run on every token.
  const streamLen = streamingMessage
    ? (streamingMessage.content?.length ?? 0) +
      (streamingMessage.steps?.length ?? 0)
    : 0;

  useLayoutEffect(() => {
    if (stickRef.current) {
      // 'auto' during a stream avoids fighting rapid token updates.
      scrollToBottom(streamingMessage ? 'auto' : 'smooth');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, streamLen, streamingMessage?.id]);

  // On first mount, jump straight to the bottom (loading an existing thread).
  useEffect(() => {
    scrollToBottom('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isEmpty = messages.length === 0 && !streamingMessage;

  return (
    <div
      style={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        ...style,
      }}
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversation transcript"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {isEmpty ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {emptyState}
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
              width: '100%',
              maxWidth: 820,
              margin: '0 auto',
            }}
          >
            {messages.map(m => (
              <MessageBubble
                key={m.id}
                message={m}
                extras={renderExtras?.(m, false)}
              />
            ))}
            {streamingMessage ? (
              <MessageBubble
                key={streamingMessage.id}
                message={streamingMessage}
                streaming
                extras={renderExtras?.(streamingMessage, true)}
              />
            ) : null}
            <div ref={bottomRef} style={{ height: 1 }} />
          </div>
        )}
      </div>

      {showJump ? (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="cdz-agent-fade cdz-agent-motion"
          aria-label="Jump to latest message"
          style={{
            position: 'absolute',
            bottom: 14,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            borderRadius: P.radius.pill,
            background: P.color.panel,
            border: `1px solid ${P.color.border}`,
            color: P.color.text,
            fontSize: P.font.size.sm,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
          }}
        >
          ↓ Latest
        </button>
      ) : null}
    </div>
  );
}
