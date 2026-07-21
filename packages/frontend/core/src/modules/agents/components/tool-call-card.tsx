// ToolCallCard + StepList — the collapsible step timeline. Each card mirrors the
// canonical ClickDz StepRow idiom (index • kind-icon • title/mono-tool • status
// pill • duration • chevron), expanding into labelled Thought / Args / Result /
// Error sections. Failed steps start expanded; the in-progress step can pulse.
// Typed against AgentStep (C1). Pure presentational.
//
// R7 upgrade (Chrono, additive): tool-call steps now read as human "verbs" —
// while running they show a present-tense action + pulsing tool glyph
// ("Recherche web…", "Lecture d'une page…", "Envoi WhatsApp…"); once finished
// they flip to past tense with the ok/error pill. Non-tool steps keep the exact
// prior behaviour (title || kind label). The StepList + ToolCallCard exports and
// their props are UNCHANGED so existing Scene/Vitrail callers compile identically.

import { useState } from 'react';

import type { AgentStep } from '../types';
import { AgentPalette as P, ensureAgentKeyframes } from './palette';
import {
  Chip,
  formatArgs,
  formatDuration,
  KIND_META,
  labelStyle,
  preStyle,
  type StepKind,
} from './primitives';

// ---------------------------------------------------------------------------
// Verb presentation for tool calls (R7). Maps a tool slug → a small glyph and
// a { running, done } French label pair. The keys cover the agent-runtime tools
// (web_search / web_fetch / telegram_send / shop_erp_summary / shops_list /
// whatsapp_send / code|run …); anything unknown falls back to a humanised slug.
// Emoji glyphs are fine here (house rule) and degrade to KIND_META otherwise.
// ---------------------------------------------------------------------------
interface Verb {
  icon: string;
  /** Present-continuous label shown while the step is in-flight. */
  running: string;
  /** Past-tense label shown once the step has completed. */
  done: string;
}

const VERB_MAP: Record<string, Verb> = {
  web_search: { icon: '🔎', running: 'Recherche web…', done: 'Recherche web' },
  web_fetch: {
    icon: '🌐',
    running: "Lecture d'une page…",
    done: 'Page lue',
  },
  web_crawl: {
    icon: '🌐',
    running: "Lecture d'une page…",
    done: 'Page lue',
  },
  web_browse: {
    icon: '🌐',
    running: "Lecture d'une page…",
    done: 'Page lue',
  },
  telegram_send: {
    icon: '📨',
    running: 'Envoi Telegram…',
    done: 'Message Telegram envoyé',
  },
  whatsapp_send: {
    icon: '💬',
    running: 'Envoi WhatsApp…',
    done: 'Message WhatsApp envoyé',
  },
  shop_erp_summary: {
    icon: '📊',
    running: 'Lecture ERP…',
    done: 'ERP consulté',
  },
  shops_list: {
    icon: '🏪',
    running: 'Liste des boutiques…',
    done: 'Boutiques listées',
  },
  code: { icon: '⌨️', running: 'Exécution…', done: 'Code exécuté' },
  run: { icon: '›_', running: 'Exécution…', done: 'Commande exécutée' },
  shell: { icon: '›_', running: 'Exécution…', done: 'Commande exécutée' },
};

// Humanise an unknown tool slug into a readable label: strip a common provider
// prefix, split on _/-/. and Title-case the words ("composio.gmail_send" →
// "Gmail send"). Keeps it short; never throws on odd input.
function humanizeTool(tool: string): string {
  const cleaned = (tool || '').split(/[.:/]/).pop() ?? tool;
  const words = cleaned
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return tool || 'Outil';
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/**
 * Derive the headline + glyph for a step. Tool-call steps get the verb
 * treatment (present tense while running, past tense once done); every other
 * kind keeps the historical `title || KIND_META.label` behaviour.
 */
function stepPresentation(
  step: AgentStep,
  running: boolean
): { label: string; icon: string; isVerb: boolean } {
  const meta = KIND_META[(step.kind as StepKind) ?? 'tool'] ?? KIND_META.tool;
  if (step.kind === 'tool' && step.tool) {
    const verb = VERB_MAP[step.tool];
    if (verb) {
      return {
        label: running ? verb.running : verb.done,
        icon: verb.icon,
        isVerb: true,
      };
    }
    // Unknown tool: humanise the slug, add an ellipsis while running.
    const human = humanizeTool(step.tool);
    return {
      label: running ? `${human}…` : human,
      icon: meta.icon,
      isVerb: true,
    };
  }
  return {
    label: step.title || meta.label,
    icon: meta.icon,
    isVerb: false,
  };
}

function statusPill(step: AgentStep): {
  text: string;
  color: string;
  bg: string;
  border: string;
} {
  if (step.error || step.ok === false) {
    return {
      text: 'failed',
      color: P.color.errText,
      bg: P.color.errBg,
      border: P.color.errBorder,
    };
  }
  if (step.ok === true) {
    return {
      text: 'ok',
      color: P.color.okText,
      bg: P.color.okBg,
      border: P.color.okBorder,
    };
  }
  // Undefined ok → in-progress / informational (thoughts, planned calls).
  return {
    text: step.kind === 'thought' ? 'thinking' : 'pending',
    color: P.color.muted,
    bg: 'transparent',
    border: P.color.border,
  };
}

export function ToolCallCard({
  step,
  index,
  active,
  defaultOpen,
}: {
  step: AgentStep;
  index?: number;
  active?: boolean;
  defaultOpen?: boolean;
}) {
  ensureAgentKeyframes();
  const meta = KIND_META[(step.kind as StepKind) ?? 'tool'] ?? KIND_META.tool;
  const failed = step.error || step.ok === false;
  // "Running" = actively-highlighted AND not yet resolved (no ok/error yet).
  const running = !!active && step.ok === undefined && !step.error;
  const present = stepPresentation(step, running);
  const [open, setOpen] = useState(() => defaultOpen ?? !!failed);
  const argsText = formatArgs(step.args);
  const pill = statusPill(step);
  const n = index ?? step.i;
  const dur = formatDuration((step as { durationMs?: number }).durationMs);
  const hasBody =
    !!step.detail ||
    !!step.tool ||
    !!argsText ||
    !!step.resultPreview ||
    !!step.error;

  return (
    <div
      className="cdz-agent-step"
      style={{
        borderRadius: P.radius.md,
        background: P.color.bg,
        border: `1px solid ${
          failed ? P.color.errBorder : P.color.border
        }`,
        overflow: 'hidden',
        animationDelay: `${Math.min(Math.max(n, 0), 9) * 55}ms`,
      }}
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen(o => !o)}
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
        style={{
          appearance: 'none',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          padding: '9px 12px',
          background: 'transparent',
          border: 'none',
          cursor: hasBody ? 'pointer' : 'default',
          color: P.color.text,
          textAlign: 'left',
          font: 'inherit',
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
          }}
        >
          <span
            aria-hidden="true"
            className={running ? 'cdz-agent-motion' : undefined}
            style={{
              fontSize: 13,
              width: 16,
              textAlign: 'center',
              color: meta.color,
              flex: '0 0 auto',
              animation: running
                ? 'cdz-agent-pulse 1.4s ease-in-out infinite'
                : undefined,
            }}
          >
            {present.icon}
          </span>
          <span
            style={{
              fontSize: P.font.size.md,
              fontWeight: 600,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color:
                present.isVerb || step.title ? P.color.text : P.color.muted,
            }}
          >
            {present.label}
          </span>
          {step.tool ? (
            <span
              style={{
                fontFamily: P.font.mono,
                fontSize: P.font.size.sm,
                color: P.color.muted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 160,
              }}
            >
              {step.tool}
            </span>
          ) : null}
          {typeof step.exitCode === 'number' ? (
            <Chip
              color={step.exitCode === 0 ? P.color.okText : P.color.errText}
              bg={step.exitCode === 0 ? P.color.okBg : P.color.errBg}
              border={
                step.exitCode === 0 ? P.color.okBorder : P.color.errBorder
              }
              title={`Process exit code ${step.exitCode}`}
            >
              exit {step.exitCode}
            </Chip>
          ) : null}
          {dur ? (
            <span style={{ fontSize: P.font.size.xs, color: P.color.muted }}>
              {dur}
            </span>
          ) : null}
          <Chip color={pill.color} bg={pill.bg} border={pill.border}>
            {pill.text}
          </Chip>
          {hasBody ? (
            <span style={{ fontSize: 11, color: P.color.muted, width: 10 }}>
              {open ? '▾' : '▸'}
            </span>
          ) : (
            <span style={{ width: 10 }} />
          )}
        </span>
        {!open && step.detail ? (
          <span
            style={{
              fontSize: P.font.size.sm,
              color: P.color.muted,
              paddingLeft: 26,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '100%',
              boxSizing: 'border-box',
            }}
          >
            {step.detail}
          </span>
        ) : null}
      </button>

      {open && hasBody ? (
        <div
          className="cdz-agent-fade"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '10px 12px',
            borderTop: `1px solid ${P.color.border}`,
            background: P.color.panel,
          }}
        >
          {step.detail ? (
            <div>
              <div style={labelStyle}>Detail</div>
              <div
                style={{
                  fontSize: P.font.size.md,
                  color: P.color.text,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  lineHeight: 1.55,
                }}
              >
                {step.detail}
              </div>
            </div>
          ) : null}
          {step.tool ? (
            <div>
              <div style={labelStyle}>Tool call</div>
              <pre style={preStyle}>
                {step.tool}
                {argsText ? `\n${argsText}` : ''}
              </pre>
            </div>
          ) : argsText ? (
            <div>
              <div style={labelStyle}>Arguments</div>
              <pre style={preStyle}>{argsText}</pre>
            </div>
          ) : null}
          {step.resultPreview ? (
            <div>
              <div style={labelStyle}>Result</div>
              <pre style={preStyle}>{step.resultPreview}</pre>
            </div>
          ) : null}
          {step.error ? (
            <div>
              <div style={labelStyle}>Error</div>
              <pre
                style={{
                  ...preStyle,
                  color: P.color.stderrText,
                  border: `1px solid ${P.color.errBorder}`,
                }}
              >
                {step.error}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function StepList({
  steps,
  activeIndex,
}: {
  steps: AgentStep[];
  activeIndex?: number;
}) {
  if (!steps || steps.length === 0) return null;
  return (
    <div
      role="list"
      aria-label="Agent steps"
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      {steps.map((step, idx) => (
        <div role="listitem" key={`${step.i}-${step.ts}-${idx}`}>
          <ToolCallCard
            step={step}
            index={idx}
            active={activeIndex === idx}
          />
        </div>
      ))}
    </div>
  );
}
