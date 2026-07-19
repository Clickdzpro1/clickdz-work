// Barrel for the shared agent-console UI kit (C8). Both the Hermes and OpenClaw
// pages compose these into a real agent interface. Pure presentational —
// components receive data + handlers via props and never fetch. All types are
// imported from `../types` (STREAMCLIENT, C1/C2). Inline styles only.

// ---- shared tokens ----
export {
  AgentPalette,
  type AgentPaletteType,
  agentKeyframes,
  ensureAgentKeyframes,
} from './palette';

// ---- small primitives (also useful to pages directly) ----
export {
  Chip,
  IconButton,
  KIND_META,
  PHASE_META,
  Spinner,
  type StatusPhase,
  type StepKind,
  formatArgs,
  formatDuration,
  truncate,
  labelStyle,
  preStyle,
} from './primitives';

// ---- transcript ----
export { ConversationThread } from './conversation-thread';
export { MessageBubble } from './message-bubble';
export { MarkdownLite } from './markdown-lite';
export { StepList, ToolCallCard } from './tool-call-card';
export { StreamingText } from './streaming-text';

// ---- input + status ----
export { Composer } from './composer';
export { StatusBar } from './status-bar';

// ---- approvals ----
export { ApprovalPrompt, type ApprovalRequest } from './approval-prompt';

// ---- history + hero ----
export { ThreadSidebar } from './thread-sidebar';
export { EmptyState } from './empty-state';
