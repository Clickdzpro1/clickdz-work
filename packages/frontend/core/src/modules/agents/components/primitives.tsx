// Shared inline-styled primitives used across the agent-console kit: phase/kind
// metadata, small formatters, and a couple of tiny presentational atoms
// (Spinner, Chip, IconButton). Pure — no fetching, no external deps.

import type { CSSProperties, ReactNode } from 'react';

import { AgentPalette as P, ensureAgentKeyframes } from './palette';

// ---------------------------------------------------------------------------
// Step-kind metadata — icon (glyph) + accent per AgentStep.kind (C1).
// ---------------------------------------------------------------------------
export type StepKind = 'thought' | 'tool' | 'write' | 'run' | 'final';

export const KIND_META: Record<
  StepKind,
  { icon: string; label: string; color: string }
> = {
  thought: { icon: '✷', label: 'thinking', color: P.color.kindThought },
  tool: { icon: '⚙', label: 'tool', color: P.color.kindTool },
  write: { icon: '✎', label: 'write', color: P.color.kindWrite },
  run: { icon: '›_', label: 'run', color: P.color.kindRun },
  final: { icon: '✓', label: 'final', color: P.color.kindFinal },
};

// ---------------------------------------------------------------------------
// Status-phase metadata — colour + short label per AgentEvent 'status'.phase.
// ---------------------------------------------------------------------------
export type StatusPhase =
  | 'planning'
  | 'executing'
  | 'writing'
  | 'running'
  | 'installing'
  | 'previewing'
  | 'waiting_approval'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'stopped';

export const PHASE_META: Record<
  StatusPhase,
  { color: string; label: string }
> = {
  planning: { color: P.color.kindTool, label: 'Planning' },
  executing: { color: P.color.accent, label: 'Executing' },
  writing: { color: P.color.kindWrite, label: 'Writing' },
  running: { color: P.color.kindRun, label: 'Running' },
  installing: { color: P.color.kindRun, label: 'Installing' },
  previewing: { color: P.color.kindFinal, label: 'Previewing' },
  waiting_approval: { color: P.color.warn, label: 'Waiting for approval' },
  finalizing: { color: P.color.accent, label: 'Finalizing' },
  done: { color: P.color.ok, label: 'Done' },
  error: { color: P.color.err, label: 'Error' },
  stopped: { color: P.color.muted, label: 'Stopped' },
};

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
export function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export function truncate(text: string, max = 160): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// Spinner — reuses the shared cdz-agent-spin keyframe; reduced-motion safe.
// ---------------------------------------------------------------------------
export function Spinner({
  size = 14,
  color = P.color.accent,
}: {
  size?: number;
  color?: string;
}) {
  ensureAgentKeyframes();
  return (
    <span
      className="cdz-agent-motion"
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        border: `2px solid color-mix(in srgb, ${color} 30%, transparent)`,
        borderTopColor: color,
        animation: 'cdz-agent-spin 0.7s linear infinite',
        flex: '0 0 auto',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Chip — the uppercase status pill idiom shared by every current StepRow.
// ---------------------------------------------------------------------------
export function Chip({
  children,
  color = P.color.muted,
  bg,
  border,
  title,
  style,
}: {
  children: ReactNode;
  color?: string;
  bg?: string;
  border?: string;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: P.font.size.xs,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        padding: '1px 8px',
        borderRadius: P.radius.pill,
        color,
        background: bg ?? 'transparent',
        border: `1px solid ${border ?? P.color.border}`,
        whiteSpace: 'nowrap',
        lineHeight: 1.6,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// IconButton — small square ghost button (rename/delete/refresh affordances).
// ---------------------------------------------------------------------------
export function IconButton({
  children,
  onClick,
  label,
  danger,
  disabled,
  style,
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
      className="cdz-agent-motion"
      style={{
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: P.radius.sm,
        border: '1px solid transparent',
        background: 'transparent',
        color: danger ? P.color.errText : P.color.muted,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        fontSize: 13,
        lineHeight: 1,
        transition: `background ${P.motion.fast} ${P.motion.ease}, color ${P.motion.fast} ${P.motion.ease}`,
        flex: '0 0 auto',
        ...style,
      }}
      onMouseEnter={e => {
        if (disabled) return;
        e.currentTarget.style.background = danger
          ? P.color.errBg
          : P.color.accentSoft;
        e.currentTarget.style.color = danger ? P.color.errText : P.color.text;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = danger ? P.color.errText : P.color.muted;
      }}
    >
      {children}
    </button>
  );
}

// Shared label style for the little section captions inside expanded cards
// (matches the current `stepLabelStyle`).
export const labelStyle: CSSProperties = {
  fontSize: P.font.size.xs,
  fontWeight: 700,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: P.color.muted,
  marginBottom: 4,
};

// Shared <pre> style for args / result blocks (matches `stepPreStyle`).
export const preStyle: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  borderRadius: P.radius.sm,
  background: P.color.consoleBg,
  border: `1px solid ${P.color.consoleBorder}`,
  color: P.color.consoleText,
  fontFamily: P.font.mono,
  fontSize: P.font.size.md,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowX: 'auto',
  maxHeight: 260,
  overflowY: 'auto',
};
