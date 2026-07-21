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
//
// R8 upgrade (POLI, additive): all user-facing copy — verb labels, status pills,
// and the expanded section labels — flows through the agents i18n table via the
// `useAgentLang()` hook (FR default + Algerian darja). VERB_MAP is now lang-aware:
// it keeps the per-slug glyph while the running/done labels resolve from the
// `verbs.<slug>.running|.done` keys. Exports + props are BYTE-IDENTICAL, so the
// legacy Hermes/OpenClaw pages (which import StepList/ToolCallCard) render exactly
// as before at the default 'fr' language. RTL-safe: technical spans (tool slug,
// args/result/error blocks) stay dir="ltr" while natural-language copy follows
// the active direction.

import { useState } from 'react';

import type { AgentStep } from '../types';
import { type TFunc, useAgentLang } from '../i18n';
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
// Verb presentation for tool calls (R7 + R8). Maps a tool slug → a small glyph;
// the running/done labels are LANGUAGE-AWARE and resolved at render time from
// the i18n `verbs.<slug>.running|.done` keys. The keys cover the agent-runtime
// tools (web_search / web_fetch / telegram_send / shop_erp_summary / shops_list /
// whatsapp_send / code|run|shell …); anything unknown falls back to a humanised
// slug. Emoji glyphs are fine here (house rule) and degrade to KIND_META otherwise.
// ---------------------------------------------------------------------------
interface Verb {
  /** Small glyph shown before the verb label (present + past). */
  icon: string;
}

// Per-slug glyphs. The running/past labels live in i18n (`verbs.<slug>.*`) so a
// language switch flips them; keeping the icon here preserves the exact glyphs.
const VERB_MAP: Record<string, Verb> = {
  web_search: { icon: '🔎' },
  web_fetch: { icon: '🌐' },
  web_crawl: { icon: '🌐' },
  web_browse: { icon: '🌐' },
  telegram_send: { icon: '📨' },
  whatsapp_send: { icon: '💬' },
  shop_erp_summary: { icon: '📊' },
  shops_list: { icon: '🏪' },
  code: { icon: '⌨️' },
  run: { icon: '›_' },
  shell: { icon: '›_' },
};

// Humanise an unknown tool slug into a readable label: strip a common provider
// prefix, split on _/-/. and Title-case the words ("composio.gmail_send" →
// "Gmail send"). Keeps it short; never throws on odd input. `fallback` is the
// (already-localised) label used when the slug yields no words.
function humanizeTool(tool: string, fallback: string): string {
  const cleaned = (tool || '').split(/[.:/]/).pop() ?? tool;
  const words = cleaned
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return tool || fallback;
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/**
 * Derive the headline + glyph for a step. Tool-call steps get the verb
 * treatment (present tense while running, past tense once done); every other
 * kind keeps the historical `title || KIND_META.label` behaviour. `t` resolves
 * the language-aware verb labels + the humanise fallback.
 */
function stepPresentation(
  step: AgentStep,
  running: boolean,
  t: TFunc
): { label: string; icon: string; isVerb: boolean } {
  const meta = KIND_META[(step.kind as StepKind) ?? 'tool'] ?? KIND_META.tool;
  if (step.kind === 'tool' && step.tool) {
    const verb = VERB_MAP[step.tool];
    if (verb) {
      return {
        label: running
          ? t(`verbs.${step.tool}.running`)
          : t(`verbs.${step.tool}.done`),
        icon: verb.icon,
        isVerb: true,
      };
    }
    // Unknown tool: humanise the slug, add an ellipsis while running.
    const human = humanizeTool(step.tool, t('toolcall.fallback'));
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

// Status pill: colours are fixed; the short text label is language-aware
// (toolcall.pill.failed|ok|thinking|pending).
function statusPill(
  step: AgentStep,
  t: TFunc
): {
  text: string;
  color: string;
  bg: string;
  border: string;
} {
  if (step.error || step.ok === false) {
    return {
      text: t('toolcall.pill.failed'),
      color: P.color.errText,
      bg: P.color.errBg,
      border: P.color.errBorder,
    };
  }
  if (step.ok === true) {
    return {
      text: t('toolcall.pill.ok'),
      color: P.color.okText,
      bg: P.color.okBg,
      border: P.color.okBorder,
    };
  }
  // Undefined ok → in-progress / informational (thoughts, planned calls).
  return {
    text: step.kind === 'thought'
      ? t('toolcall.pill.thinking')
      : t('toolcall.pill.pending'),
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
  // Language-aware copy (FR default). The hook subscribes this card to the
  // module-level language so a toggle anywhere re-renders it.
  const { t, dir } = useAgentLang();
  const meta = KIND_META[(step.kind as StepKind) ?? 'tool'] ?? KIND_META.tool;
  const failed = step.error || step.ok === false;
  // "Running" = actively-highlighted AND not yet resolved (no ok/error yet).
  const running = !!active && step.ok === undefined && !step.error;
  const present = stepPresentation(step, running, t);
  const [open, setOpen] = useState(() => defaultOpen ?? !!failed);
  const argsText = formatArgs(step.args);
  const pill = statusPill(step, t);
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
      dir={dir}
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
              minWidth: 0,
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
              dir="ltr"
              style={{
                fontFamily: P.font.mono,
                fontSize: P.font.size.sm,
                color: P.color.muted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
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
            <span
              dir="ltr"
              style={{ fontSize: P.font.size.xs, color: P.color.muted }}
            >
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
              <div style={labelStyle}>{t('toolcall.detail')}</div>
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
              <div style={labelStyle}>{t('toolcall.toolCall')}</div>
              <pre dir="ltr" style={preStyle}>
                {step.tool}
                {argsText ? `\n${argsText}` : ''}
              </pre>
            </div>
          ) : argsText ? (
            <div>
              <div style={labelStyle}>{t('toolcall.arguments')}</div>
              <pre dir="ltr" style={preStyle}>{argsText}</pre>
            </div>
          ) : null}
          {step.resultPreview ? (
            <div>
              <div style={labelStyle}>{t('toolcall.result')}</div>
              <pre dir="ltr" style={preStyle}>{step.resultPreview}</pre>
            </div>
          ) : null}
          {step.error ? (
            <div>
              <div style={labelStyle}>{t('toolcall.error')}</div>
              <pre
                dir="ltr"
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
