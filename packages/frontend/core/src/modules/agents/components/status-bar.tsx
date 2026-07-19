// StatusBar — a compact phase chip (colour per phase) + free-text label + an
// elapsed timer. Ticks locally once/second while `running` so the timer advances
// even between SSE frames; freezes on the last value when the run ends. Phase is
// the AgentEvent 'status'.phase union (C1). Pure presentational.

import { useEffect, useRef, useState } from 'react';

import { AgentPalette as P, ensureAgentKeyframes } from './palette';
import { formatDuration, PHASE_META, type StatusPhase } from './primitives';

export function StatusBar({
  phase,
  label,
  elapsedMs,
  running,
}: {
  phase: StatusPhase;
  label: string;
  elapsedMs?: number;
  running: boolean;
}) {
  ensureAgentKeyframes();
  const meta = PHASE_META[phase] ?? { color: P.color.muted, label: phase };

  // Local ticking clock: anchor to (now - elapsedMs) at the moment `running`
  // flips true, then re-render every second.
  const [, force] = useState(0);
  const anchorRef = useRef<number | null>(null);

  useEffect(() => {
    if (running) {
      anchorRef.current = Date.now() - (elapsedMs ?? 0);
      const id = setInterval(() => force(n => n + 1), 1000);
      return () => clearInterval(id);
    }
    anchorRef.current = null;
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const shownMs =
    running && anchorRef.current != null
      ? Date.now() - anchorRef.current
      : elapsedMs;
  const timer = formatDuration(shownMs);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 14px',
        borderTop: `1px solid ${P.color.border}`,
        borderBottom: `1px solid ${P.color.border}`,
        background: P.color.panel,
        minHeight: 34,
        boxSizing: 'border-box',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          fontSize: P.font.size.sm,
          fontWeight: 700,
          letterSpacing: '0.03em',
          textTransform: 'uppercase',
          color: meta.color,
          flex: '0 0 auto',
        }}
      >
        <span
          aria-hidden="true"
          className={running ? 'cdz-agent-motion' : undefined}
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: meta.color,
            boxShadow: `0 0 0 3px color-mix(in srgb, ${meta.color} 22%, transparent)`,
            animation: running
              ? 'cdz-agent-pulse 1.4s ease-in-out infinite'
              : undefined,
          }}
        />
        {meta.label}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: P.font.size.md,
          color: P.color.muted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {timer ? (
        <span
          style={{
            fontSize: P.font.size.sm,
            color: P.color.muted,
            fontFamily: P.font.mono,
            flex: '0 0 auto',
          }}
        >
          {timer}
        </span>
      ) : null}
    </div>
  );
}
