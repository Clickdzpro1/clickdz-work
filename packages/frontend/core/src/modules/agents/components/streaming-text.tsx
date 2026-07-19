// StreamingText — renders text with a blinking block cursor while `active`.
// Used inside assistant MessageBubbles for the live final-answer token stream.
// The cursor uses the shared `cdz-agent-blink` keyframe and is neutralised for
// prefers-reduced-motion users (rule in agentKeyframes) — reduced-motion users
// still see a steady cursor, just without the blink.

import { AgentPalette as P, ensureAgentKeyframes } from './palette';

export function StreamingText({
  text,
  active,
}: {
  text: string;
  active: boolean;
}) {
  ensureAgentKeyframes();
  return (
    <span
      style={{
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: P.color.text,
        fontSize: P.font.size.lg,
        lineHeight: 1.6,
      }}
    >
      {text}
      {active ? (
        <span
          className="cdz-agent-cursor cdz-agent-motion"
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: '0.55em',
            height: '1.05em',
            marginLeft: 2,
            transform: 'translateY(0.18em)',
            background: P.color.accent,
            borderRadius: 1,
            animation: 'cdz-agent-blink 1s steps(1) infinite',
          }}
        />
      ) : null}
    </span>
  );
}
