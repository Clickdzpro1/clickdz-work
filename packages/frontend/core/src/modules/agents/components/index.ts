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
  accentFor,
  AGENT_ACCENT,
  type AgentAccent,
  type AgentAccentKey,
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
export { RunTimeline, type RunTimelineProps } from './run-timeline';
export { StreamingAnswer } from './streaming-answer';

// ---- input + status ----
export { Composer } from './composer';
export { StatusBar } from './status-bar';

// ---- approvals ----
export { ApprovalPrompt, type ApprovalRequest } from './approval-prompt';

// ---- history + hero ----
export { ThreadSidebar } from './thread-sidebar';
export { EmptyState } from './empty-state';

// ---- spend estimate ----
export {
  SpendMeter,
  estimateSpend,
  formatDzd,
  formatTokens,
  NOMINAL_TOKENS_PER_TOOL_CALL,
  type SpendMeterProps,
  type SpendEstimate,
} from './spend-meter';

// ---- artifacts ----
export { ArtifactsPanel } from './artifacts-panel';

// ---- presence (per-agent status lamp) ----
export { AgentPresence, type AgentPresenceProps } from './agent-presence';

// ---- Le Bureau + budgets + tool-perms (R11 shared kit — Trame) ----
export { PulseCard, type PulseCardProps, type AgentPulse } from './pulse-card';
export {
  ApprovalInbox,
  type ApprovalInboxProps,
  type ApprovalInboxItem,
} from './approval-inbox';
export { CodDesk, type CodDeskProps, type CodOrder } from './cod-desk';
export {
  MissionsCard,
  type MissionsCardProps,
  type MissionTrigger,
} from './missions-card';
export { BudgetBar, type BudgetBarProps, type AgentBudget } from './budget-bar';
export {
  ToolPermissions,
  type ToolPermissionsProps,
  type ToolPermissionItem,
} from './tool-permissions';
