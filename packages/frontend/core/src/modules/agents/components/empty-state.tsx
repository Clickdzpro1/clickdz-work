// EmptyState — the hero shown in a fresh console: an icon, title, subtitle, a
// grid of clickable example chips that seed the composer, and an optional
// `children` slot pages use to inject panels (Hermes workflows / connections,
// OpenClaw runtime hints). Pure — calls onPickExample.

import type { ReactNode } from 'react';

import { AgentPalette as P, ensureAgentKeyframes } from './palette';

export function EmptyState({
  icon,
  title,
  subtitle,
  examples,
  onPickExample,
  children,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  examples?: string[];
  onPickExample?: (example: string) => void;
  children?: ReactNode;
}) {
  ensureAgentKeyframes();
  return (
    <div
      className="cdz-agent-fade"
      style={{
        width: '100%',
        maxWidth: 640,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 14,
        padding: '24px 16px',
      }}
    >
      {icon ? (
        <div
          aria-hidden="true"
          style={{
            width: 52,
            height: 52,
            borderRadius: P.radius.lg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 24,
            background: P.color.accentSoft,
            border: `1px solid ${P.color.accentBorder}`,
            color: P.color.accent,
          }}
        >
          {icon}
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 700,
            color: P.color.text,
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </h2>
        {subtitle ? (
          <p
            style={{
              margin: 0,
              fontSize: P.font.size.lg,
              color: P.color.muted,
              lineHeight: 1.55,
              maxWidth: 480,
            }}
          >
            {subtitle}
          </p>
        ) : null}
      </div>

      {examples && examples.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            justifyContent: 'center',
            marginTop: 2,
          }}
        >
          {examples.map((ex, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onPickExample?.(ex)}
              className="cdz-agent-motion"
              style={{
                appearance: 'none',
                textAlign: 'left',
                padding: '8px 13px',
                borderRadius: P.radius.pill,
                border: `1px solid ${P.color.border}`,
                background: P.color.panel,
                color: P.color.text,
                fontSize: P.font.size.md,
                lineHeight: 1.4,
                cursor: 'pointer',
                maxWidth: 320,
                transition: `background ${P.motion.fast} ${P.motion.ease}, border-color ${P.motion.fast} ${P.motion.ease}, transform ${P.motion.fast} ${P.motion.ease}`,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = P.color.accentSoft;
                e.currentTarget.style.borderColor = P.color.accentBorder;
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = P.color.panel;
                e.currentTarget.style.borderColor = P.color.border;
              }}
            >
              {ex}
            </button>
          ))}
        </div>
      ) : null}

      {children ? (
        <div style={{ width: '100%', marginTop: 6 }}>{children}</div>
      ) : null}
    </div>
  );
}
