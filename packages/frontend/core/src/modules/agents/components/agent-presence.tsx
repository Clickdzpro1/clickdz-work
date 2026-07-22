// AgentPresence — the shared "one dot, two personalities" status lamp (R10
// identity, WS11-1). Generalises the pulsing dot baked into StatusBar
// (status-bar.tsx L76-89) into a standalone, per-agent-tinted atom that Herald
// (Hermes) and Griffe (OpenClaw) drop into headers, greeting bars, run rows and
// sandbox chrome. It is the mechanical half of the identity system: the SAME
// nervous system (one `StatusPhase` → one lamp), two faces (Hermes teal glow,
// OpenClaw phosphor glow) via `accentFor`.
//
// Pure presentational: props in, styled <span> out. No fetching, no state, no
// new motion primitives — it reuses the existing `cdz-agent-pulse` keyframe (via
// ensureAgentKeyframes) and the `cdz-agent-motion` reduced-motion guard, exactly
// as StatusBar does.

import type { CSSProperties } from 'react';

import { accentFor, AgentPalette as P, ensureAgentKeyframes } from './palette';
import { PHASE_META, type StatusPhase } from './primitives';

// Which phases are the agent's "own accent" moments (thinking/working). For
// these we swap the generic PHASE_META accent (the shared blue) for the agent's
// branded accent, so Hermes pulses teal and OpenClaw pulses phosphor. Every
// other phase keeps its semantic PHASE_META colour (waiting_approval→warn,
// done→ok, error→err, stopped→muted) so the lamp stays coherent with the rest
// of the console kit.
const ACCENT_PHASES: ReadonlySet<StatusPhase> = new Set<StatusPhase>([
  'planning',
  'executing',
  'writing',
  'running',
  'installing',
  'previewing',
  'finalizing',
]);

// Phases that read as "in motion" — the lamp pulses on these (in addition to the
// caller's `running` flag). `done`/`error`/`stopped`/`waiting_approval` are
// resting states and never pulse on their own.
const MOTION_PHASES: ReadonlySet<StatusPhase> = new Set<StatusPhase>([
  'planning',
  'executing',
  'writing',
  'running',
  'installing',
  'previewing',
  'finalizing',
]);

export interface AgentPresenceProps {
  // Which agent's accent family to tint the active/working states with.
  // Unknown/omitted → shared accent (accentFor falls back gracefully).
  agent?: 'hermes' | 'openclaw' | string;
  // The live phase — the existing AgentEvent 'status'.phase union (C1). Maps
  // 1:1 to lamp colour + motion; no separate idle/working/done/error enum.
  phase: StatusPhase;
  // Stream `running` flag. When true the lamp pulses even for phases that are
  // not intrinsically in-motion (mirrors StatusBar's `running` behaviour).
  running?: boolean;
  // Dot diameter in px. Default 8 — the StatusBar dot size.
  size?: number;
  // Optional style escape hatch (e.g. margin when inline next to a name).
  style?: CSSProperties;
  // Optional accessible label; defaults to the phase's human label.
  title?: string;
}

export function AgentPresence({
  agent,
  phase,
  running = false,
  size = 8,
  style,
  title,
}: AgentPresenceProps) {
  ensureAgentKeyframes();

  const acc = accentFor(agent);
  const meta = PHASE_META[phase] ?? { color: P.color.muted, label: phase };

  // Colour: agent-branded for the working family, semantic PHASE_META otherwise.
  const color = ACCENT_PHASES.has(phase) ? acc.accent : meta.color;
  // Halo ring: the agent glow when branded, else a 22% wash of the phase colour
  // — same idiom/ratio as the StatusBar dot's box-shadow (L84).
  const ring = ACCENT_PHASES.has(phase)
    ? acc.glow
    : `color-mix(in srgb, ${color} 22%, transparent)`;

  // Pulse when the stream says so or the phase is intrinsically in motion.
  const animate = running || MOTION_PHASES.has(phase);

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={title ?? meta.label}
      title={title ?? meta.label}
      className={animate ? 'cdz-agent-motion' : undefined}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        boxShadow: `0 0 0 ${Math.max(2, Math.round(size * 0.38))}px ${ring}`,
        // Reuse the existing pulse keyframe (no new motion primitive). The
        // `cdz-agent-motion` class above lets prefers-reduced-motion kill it.
        animation: animate
          ? 'cdz-agent-pulse 1.4s ease-in-out infinite'
          : undefined,
        flex: '0 0 auto',
        ...style,
      }}
    />
  );
}
