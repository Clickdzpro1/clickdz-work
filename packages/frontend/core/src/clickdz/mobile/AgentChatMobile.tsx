/**
 * AgentChatMobile — Chat-First Mobile View for Agents / Hermes / OpenClaw
 *
 * Hermes Wiring Pattern:
 *   data-cdz-surface="agent-chat" on the outermost chat wrapper.
 *   data-cdz-shell="agent-chat" on the full-viewport container.
 *   Uses CdzResponsive null-component for CSS injection.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────┐
 *   │  [Agent Name]  ▸ Header bar                  │
 *   ├─────────────────────────────────────────────┤
 *   │                                             │
 *   │  Chat messages (scrollable, fills space)    │
 *   │  ├─ Text bubbles                            │
 *   │  ├─ Inline file cards                       │
 *   │  └─ ...                                     │
 *   │                                             │
 *   ├─────────────────────────────────────────────┤
 *   │  [Input bar — pinned bottom, safe-area]     │
 *   └─────────────────────────────────────────────┘
 *                    ┌──────┐
 *                    │  🤖  │  ← Floating avatar button
 *                    └──────┘     Triggers agent rail slide-over
 *
 * Agent Rail (slide-over sheet):
 *   Slides up from bottom via @radix-ui/react-dialog.
 *   Lists available agents. Tapping one switches the chat context.
 *   Never competes for screen space — fully overlays.
 *
 * Features:
 *   - Chat fills the viewport entirely
 *   - Agent rail is a slide-over sheet triggered by floating avatar (bottom-right)
 *   - Sheet slides up with agent list
 *   - File cards rendered inline in the chat (no side panel)
 *   - Input bar pinned to bottom, safe-area-aware
 *   - French UI labels throughout
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { MOBILE_COLORS } from '../clickdz-mobile/colors';

// ─── Hermes CSS Injection ──────────────────────────────────────────────────────

function ensureClickDzResponsiveCss(): void {
  if (typeof document === 'undefined') return;
  const id = 'cdz-responsive-css';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    [data-cdz-shell="agent-chat"] {
      display: flex;
      flex-direction: column;
      height: 100dvh;
      overflow: hidden;
    }
    [data-cdz-surface="agent-chat"] {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    @media (min-width: 600px) {
      [data-cdz-surface="agent-rail-trigger"] {
        display: none;
      }
      [data-cdz-shell="agent-chat"] {
        max-width: 420px;
        margin: 0 auto;
        border-left: 1px solid var(--cdz-border, rgba(255,255,255,0.08));
        border-right: 1px solid var(--cdz-border, rgba(255,255,255,0.08));
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

export interface AgentInfo {
  id: string;
  name: string;
  avatar: string;       // emoji or initials
  description: string;
  status: 'online' | 'offline' | 'busy';
  model?: string;       // e.g. "Hermes", "OpenClaw", "Claude"
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;    // ISO string
  files?: ChatFile[];
}

export interface ChatFile {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  url?: string;
}

export interface AgentChatMobileProps {
  /** Current active agent */
  activeAgent?: AgentInfo;
  /** Available agents for the rail */
  agents: AgentInfo[];
  /** Chat messages to display */
  messages: ChatMessage[];
  /** Called when the user sends a new message */
  onSendMessage: (text: string, files?: File[]) => void;
  /** Called when switching to a different agent */
  onSwitchAgent: (agent: AgentInfo) => void;
  /** Called when tapping a file card */
  onFileTap?: (file: ChatFile) => void;
  /** Whether new messages are loading */
  isLoading?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function fileIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.includes('pdf')) return '📕';
  if (mimeType.includes('spreadsheet') || mimeType.includes('csv')) return '📊';
  if (mimeType.includes('document') || mimeType.includes('word')) return '📝';
  return '📎';
}

// ─── Styles ─────────────────────────────────────────────────────────────────────

const INPUT_MIN_HEIGHT = 48;
const HEADER_HEIGHT = 52;
const FAB_SIZE = 56;
const FAB_MARGIN = 16;

const styles: Record<string, React.CSSProperties> = {
  // ── Shell ──────────────────────────────────────────────────────────────────
  shell: {
    display: 'flex',
    flexDirection: 'column',
    height: '100dvh',
    backgroundColor: MOBILE_COLORS.appBg,
    color: MOBILE_COLORS.textPrimary,
    overflow: 'hidden',
    position: 'relative',
  },

  // ── Header ─────────────────────────────────────────────────────────────────
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    height: HEADER_HEIGHT,
    padding: '0 16px',
    flexShrink: 0,
    borderBottom: `1px solid ${MOBILE_COLORS.divider}`,
    backgroundColor: MOBILE_COLORS.surface,
  },

  headerAgentAvatar: {
    width: 34,
    height: 34,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: MOBILE_COLORS.surfaceAlt,
    fontSize: 18,
    flexShrink: 0,
  },

  headerInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },

  headerName: {
    fontSize: 15,
    fontWeight: 700,
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

  headerModel: {
    fontSize: 12,
    color: MOBILE_COLORS.textMuted,
    lineHeight: 1.2,
  },

  headerStatusDot: (status: AgentInfo['status']): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
    backgroundColor:
      status === 'online' ? '#10B981' : status === 'busy' ? '#F59E0B' : '#6B7280',
  }),

  // ── Chat Messages Area ─────────────────────────────────────────────────────
  messagesArea: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: '12px 12px 4px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    WebkitOverflowScrolling: 'touch',
  },

  // ── Message Bubble ─────────────────────────────────────────────────────────
  msgRow: (role: ChatMessage['role']): React.CSSProperties => ({
    display: 'flex',
    flexDirection: 'column',
    alignItems: role === 'user' ? 'flex-end' : 'flex-start',
    maxWidth: '100%',
  }),

  msgBubble: (role: ChatMessage['role']): React.CSSProperties => {
    const isUser = role === 'user';
    const bg = isUser ? MOBILE_COLORS.accent : MOBILE_COLORS.surface;
    const fg = isUser ? MOBILE_COLORS.textInverse : MOBILE_COLORS.textPrimary;
    return {
      maxWidth: '85%',
      padding: '10px 14px',
      borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
      backgroundColor: bg,
      color: fg,
      fontSize: 15,
      lineHeight: 1.45,
      wordBreak: 'break-word',
    };
  },

  msgSystemBubble: {
    maxWidth: '92%',
    padding: '8px 14px',
    borderRadius: 10,
    backgroundColor: MOBILE_COLORS.surfaceAlt,
    color: MOBILE_COLORS.textMuted,
    fontSize: 13,
    lineHeight: 1.4,
    fontStyle: 'italic',
    textAlign: 'center',
  },

  msgTime: (role: ChatMessage['role']): React.CSSProperties => ({
    fontSize: 11,
    color: MOBILE_COLORS.textMuted,
    marginTop: 2,
    padding: role === 'user' ? '0 4px 0 0' : '0 0 0 4px',
  }),

  // ── Inline File Card ───────────────────────────────────────────────────────
  fileCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
    backgroundColor: MOBILE_COLORS.surfaceAlt,
    borderRadius: 10,
    border: `1px solid ${MOBILE_COLORS.border}`,
    marginTop: 6,
    cursor: 'pointer',
    transition: 'background-color 0.12s ease',
    WebkitTapHighlightColor: 'transparent',
    minHeight: 48,
  },

  fileCardIcon: {
    fontSize: 24,
    flexShrink: 0,
  },

  fileCardInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },

  fileCardName: {
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

  fileCardSize: {
    fontSize: 11,
    color: MOBILE_COLORS.textMuted,
  },

  // ── Typing Indicator ───────────────────────────────────────────────────────
  typingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
  },

  typingDots: {
    display: 'flex',
    gap: 4,
  },

  typingDot: (delay: number): React.CSSProperties => ({
    width: 7,
    height: 7,
    borderRadius: '50%',
    backgroundColor: MOBILE_COLORS.textMuted,
    animation: `cdz-typing-bounce 1.4s ${delay}s infinite ease-in-out`,
  }),

  typingLabel: {
    fontSize: 12,
    color: MOBILE_COLORS.textMuted,
    fontStyle: 'italic',
  },

  // ── Input Bar ──────────────────────────────────────────────────────────────
  inputBar: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 8,
    padding: '8px 12px',
    paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))',
    borderTop: `1px solid ${MOBILE_COLORS.divider}`,
    backgroundColor: MOBILE_COLORS.surface,
    flexShrink: 0,
  },

  inputField: {
    flex: 1,
    minHeight: INPUT_MIN_HEIGHT,
    maxHeight: 120,
    padding: '10px 14px',
    borderRadius: 24,
    border: `1px solid ${MOBILE_COLORS.border}`,
    backgroundColor: MOBILE_COLORS.surfaceAlt,
    color: MOBILE_COLORS.textPrimary,
    fontSize: 15,
    lineHeight: 1.4,
    resize: 'none',
    outline: 'none',
    fontFamily: 'inherit',
    WebkitAppearance: 'none',
  },

  sendBtn: {
    width: 44,
    height: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: '50%',
    backgroundColor: MOBILE_COLORS.accent,
    color: MOBILE_COLORS.textInverse,
    fontSize: 18,
    fontWeight: 700,
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'opacity 0.12s ease',
    WebkitTapHighlightColor: 'transparent',
  },

  sendBtnDisabled: {
    opacity: 0.4,
  },

  // ── Floating Action Button (Agent Rail trigger) ────────────────────────────
  fab: {
    position: 'fixed',
    bottom: `calc(${FAB_MARGIN}px + env(safe-area-inset-bottom, 0px))`,
    right: FAB_MARGIN,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: MOBILE_COLORS.surface,
    border: `1px solid ${MOBILE_COLORS.borderStrong}`,
    boxShadow: `0 4px 16px ${MOBILE_COLORS.shadow}`,
    cursor: 'pointer',
    zIndex: 1050,
    fontSize: 22,
    transition: 'transform 0.15s ease, box-shadow 0.15s ease',
    WebkitTapHighlightColor: 'transparent',
  },

  fabBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: '50%',
    backgroundColor: '#EF4444',
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
  },

  // ── Agent Rail (Dialog slide-over) ─────────────────────────────────────────
  railOverlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: MOBILE_COLORS.backdrop,
    zIndex: 2000,
  },

  railContent: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 2001,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: MOBILE_COLORS.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    boxShadow: `0 -8px 32px ${MOBILE_COLORS.shadow}`,
    maxHeight: '75dvh',
    overflow: 'hidden',
    animation: 'cdz-agent-rail-slide-up 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
  },

  railHandle: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '12px 0 8px',
    flexShrink: 0,
    cursor: 'grab',
    touchAction: 'none',
  },

  railHandleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: MOBILE_COLORS.borderStrong,
  },

  railTitle: {
    fontSize: 17,
    fontWeight: 700,
    padding: '0 20px 12px',
    flexShrink: 0,
  },

  railList: {
    flex: 1,
    overflowY: 'auto',
    padding: '0 12px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    WebkitOverflowScrolling: 'touch',
  },

  railAgentCard: (isActive: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    borderRadius: 14,
    backgroundColor: isActive ? MOBILE_COLORS.accentMuted : 'transparent',
    border: isActive
      ? `1px solid ${MOBILE_COLORS.accent}`
      : `1px solid transparent`,
    cursor: 'pointer',
    transition: 'background-color 0.12s ease, border-color 0.12s ease',
    WebkitTapHighlightColor: 'transparent',
    minHeight: 60,
  }),

  railAgentAvatar: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: MOBILE_COLORS.surfaceAlt,
    fontSize: 22,
    flexShrink: 0,
  },

  railAgentInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },

  railAgentName: {
    fontSize: 15,
    fontWeight: 600,
    lineHeight: 1.3,
  },

  railAgentDesc: {
    fontSize: 12,
    color: MOBILE_COLORS.textMuted,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

  railAgentStatusDot: (status: AgentInfo['status']): React.CSSProperties => ({
    width: 10,
    height: 10,
    borderRadius: '50%',
    flexShrink: 0,
    backgroundColor:
      status === 'online' ? '#10B981' : status === 'busy' ? '#F59E0B' : '#6B7280',
  }),

  // ── Empty Chat ─────────────────────────────────────────────────────────────
  emptyChat: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 32,
  },

  emptyChatIcon: {
    fontSize: 52,
    opacity: 0.4,
  },

  emptyChatText: {
    fontSize: 16,
    fontWeight: 600,
    textAlign: 'center',
  },

  emptyChatSub: {
    fontSize: 14,
    color: MOBILE_COLORS.textMuted,
    textAlign: 'center',
  },

  // ── Scroll anchor ──────────────────────────────────────────────────────────
  scrollAnchor: {
    height: 1,
    flexShrink: 0,
  },

  // ── Attachment chip ────────────────────────────────────────────────────────
  attachBtn: {
    width: 40,
    height: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'none',
    color: MOBILE_COLORS.textSecondary,
    fontSize: 22,
    cursor: 'pointer',
    flexShrink: 0,
    padding: 0,
    WebkitTapHighlightColor: 'transparent',
  },

  // ── Keyboard spacer ────────────────────────────────────────────────────────
  keyboardSpacer: {
    height: 'env(keyboard-inset-height, 0px)',
    transition: 'height 0.15s ease',
  },
};

// ─── Typing indicator animation keyframes (injected once) ──────────────────────

function injectKeyframes(): void {
  if (typeof document === 'undefined') return;
  const id = 'cdz-agent-chat-keyframes';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    @keyframes cdz-typing-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-6px); }
    }
    @keyframes cdz-agent-rail-slide-up {
      from { transform: translateY(100%); }
      to { transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

// ─── Components ─────────────────────────────────────────────────────────────────

/** A single chat message bubble */
const MessageBubble: React.FC<{
  msg: ChatMessage;
  onFileTap?: (file: ChatFile) => void;
}> = React.memo(({ msg, onFileTap }) => {
  if (msg.role === 'system') {
    return (
      <div style={styles.msgRow('system')}>
        <div style={styles.msgSystemBubble}>{msg.content}</div>
        <div style={styles.msgTime('system')}>{formatTime(msg.timestamp)}</div>
      </div>
    );
  }

  return (
    <div style={styles.msgRow(msg.role)}>
      <div style={styles.msgBubble(msg.role)}>{msg.content}</div>

      {/* Inline file cards */}
      {msg.files && msg.files.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
          {msg.files.map((file) => (
            <div
              key={file.id}
              style={styles.fileCard}
              onClick={() => onFileTap?.(file)}
              role="button"
              tabIndex={0}
            >
              <span style={styles.fileCardIcon}>{fileIcon(file.mimeType)}</span>
              <div style={styles.fileCardInfo}>
                <span style={styles.fileCardName}>{file.name}</span>
                <span style={styles.fileCardSize}>{formatFileSize(file.sizeBytes)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={styles.msgTime(msg.role)}>{formatTime(msg.timestamp)}</div>
    </div>
  );
});
MessageBubble.displayName = 'MessageBubble';

/** Typing indicator — three bouncing dots */
const TypingIndicator: React.FC = React.memo(() => (
  <div style={styles.typingRow}>
    <div style={styles.typingDots}>
      <span style={styles.typingDot(0)} />
      <span style={styles.typingDot(0.2)} />
      <span style={styles.typingDot(0.4)} />
    </div>
    <span style={styles.typingLabel}>En cours…</span>
  </div>
));
TypingIndicator.displayName = 'TypingIndicator';

// ─── Main Component ─────────────────────────────────────────────────────────────

export function AgentChatMobile({
  activeAgent,
  agents,
  messages,
  onSendMessage,
  onSwitchAgent,
  onFileTap,
  isLoading = false,
}: AgentChatMobileProps) {
  const [inputText, setInputText] = useState('');
  const [railOpen, setRailOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Inject keyframe animations once
  useEffect(() => { injectKeyframes(); }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Auto-resize textarea
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInputText(e.target.value);
      // Reset height then grow to fit content
      const ta = e.target;
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    },
    [],
  );

  // Send message
  const handleSend = useCallback(() => {
    const trimmed = inputText.trim();
    if (!trimmed || isLoading) return;
    onSendMessage(trimmed);
    setInputText('');
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    // Refocus after send
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [inputText, isLoading, onSendMessage]);

  // Send on Enter (without Shift)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Agent rail handlers
  const openRail = useCallback(() => setRailOpen(true), []);
  const closeRail = useCallback(() => setRailOpen(false), []);

  const handleSelectAgent = useCallback(
    (agent: AgentInfo) => {
      onSwitchAgent(agent);
      closeRail();
    },
    [onSwitchAgent, closeRail],
  );

  const canSend = inputText.trim().length > 0 && !isLoading;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={styles.shell} data-cdz-shell="agent-chat">
      <CdzResponsive />

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={styles.header}>
        {activeAgent ? (
          <>
            <div style={styles.headerAgentAvatar}>{activeAgent.avatar}</div>
            <div style={styles.headerInfo}>
              <div style={styles.headerName}>{activeAgent.name}</div>
              {activeAgent.model && (
                <div style={styles.headerModel}>{activeAgent.model}</div>
              )}
            </div>
            <div style={styles.headerStatusDot(activeAgent.status)} />
          </>
        ) : (
          <>
            <div style={styles.headerAgentAvatar}>🤖</div>
            <div style={styles.headerInfo}>
              <div style={styles.headerName}>Agents</div>
              <div style={styles.headerModel}>Sélectionnez un agent</div>
            </div>
          </>
        )}
      </div>

      {/* ── Chat Messages ─────────────────────────────────────────────────── */}
      <div
        style={styles.messagesArea}
        data-cdz-surface="agent-chat"
        id="agent-chat-messages"
      >
        {messages.length === 0 && !isLoading ? (
          <div style={styles.emptyChat}>
            <div style={styles.emptyChatIcon}>💬</div>
            <div style={styles.emptyChatText}>
              {activeAgent
                ? `Discutez avec ${activeAgent.name}`
                : 'Sélectionnez un agent pour commencer'}
            </div>
            <div style={styles.emptyChatSub}>
              Vos conversations apparaîtront ici
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} onFileTap={onFileTap} />
          ))
        )}

        {isLoading && <TypingIndicator />}

        {/* Scroll anchor */}
        <div ref={messagesEndRef} style={styles.scrollAnchor} />
      </div>

      {/* ── Keyboard spacer (visual) ──────────────────────────────────────── */}
      <div style={styles.keyboardSpacer} />

      {/* ── Input Bar ─────────────────────────────────────────────────────── */}
      <div style={styles.inputBar}>
        <button
          type="button"
          style={styles.attachBtn}
          aria-label="Joindre un fichier"
          title="Joindre un fichier"
        >
          📎
        </button>

        <textarea
          ref={textareaRef}
          style={styles.inputField}
          value={inputText}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={activeAgent ? 'Écrivez votre message…' : 'Sélectionnez un agent…'}
          rows={1}
          disabled={!activeAgent}
          aria-label="Message"
        />

        <button
          type="button"
          style={{
            ...styles.sendBtn,
            ...(canSend ? {} : styles.sendBtnDisabled),
          }}
          onClick={handleSend}
          disabled={!canSend}
          aria-label="Envoyer"
        >
          ↑
        </button>
      </div>

      {/* ── Floating Avatar Button (Agent Rail trigger) ───────────────────── */}
      <button
        type="button"
        style={styles.fab}
        onClick={openRail}
        aria-label="Liste des agents"
        data-cdz-surface="agent-rail-trigger"
      >
        {activeAgent?.avatar ?? '🤖'}
        {agents.length > 1 && (
          <span style={styles.fabBadge}>{agents.length}</span>
        )}
      </button>

      {/* ── Agent Rail Slide-Over Sheet ───────────────────────────────────── */}
      <Dialog.Root open={railOpen} onOpenChange={setRailOpen}>
        <Dialog.Portal>
          <Dialog.Overlay style={styles.railOverlay} />
          <Dialog.Content
            style={styles.railContent}
            aria-describedby={undefined}
          >
            <Dialog.Title style={{ display: 'none' }}>
              Agents disponibles
            </Dialog.Title>

            {/* Drag handle */}
            <div style={styles.railHandle}>
              <div style={styles.railHandleBar} />
            </div>

            <div style={styles.railTitle}>🤖 Agents disponibles</div>

            {/* Agent list */}
            <div style={styles.railList}>
              {agents.map((agent) => {
                const isActive = activeAgent?.id === agent.id;
                return (
                  <div
                    key={agent.id}
                    style={styles.railAgentCard(isActive)}
                    onClick={() => handleSelectAgent(agent)}
                    role="button"
                    tabIndex={0}
                  >
                    <div style={styles.railAgentAvatar}>{agent.avatar}</div>
                    <div style={styles.railAgentInfo}>
                      <div style={styles.railAgentName}>{agent.name}</div>
                      <div style={styles.railAgentDesc}>
                        {agent.model ?? agent.description}
                      </div>
                    </div>
                    <div style={styles.railAgentStatusDot(agent.status)} />
                    {isActive && <span style={{ fontSize: 14 }}>✓</span>}
                  </div>
                );
              })}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default AgentChatMobile;
