// AgentPalette — the single shared token object both the Hermes and OpenClaw
// consoles reuse. Derived verbatim from the current pages' `const C = {...}`
// (hermes/index.tsx L104-118 + openclaw/index.tsx L120-142) so the new console
// reads identically to the shipping surfaces, then extended with radii / spacing
// / font tokens the shared components need. Every colour is an `--affine-*`
// theme var with a hard dark fallback so the UI is correct before theme vars
// resolve. Inline-styles only (house rule) — this is a plain TS object, no
// .css.ts.

export const AgentPalette = {
  color: {
    // ---- base surface set (identical in both current pages) ----
    bg: 'var(--affine-background-primary-color, #141414)',
    panel: 'var(--affine-background-secondary-color, #1c1c1e)',
    // A third, slightly-raised surface for cards on top of `panel`.
    panelRaised:
      'color-mix(in srgb, var(--affine-background-secondary-color, #1c1c1e) 60%, #ffffff 4%)',
    border: 'var(--affine-border-color, #2a2a2c)',
    text: 'var(--affine-text-primary-color, #ececec)',
    muted: 'var(--affine-text-secondary-color, #9aa0a6)',
    accent: 'var(--affine-primary-color, #1e96eb)',
    accentSoft:
      'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
    accentBorder:
      'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 45%, transparent)',
    onAccent: '#ffffff',

    // ---- status tints (from both pages) ----
    warn: '#e8a33d',
    warnBg: 'color-mix(in srgb, #e8a33d 12%, transparent)',
    warnBorder: 'color-mix(in srgb, #e8a33d 40%, transparent)',
    err: 'var(--affine-error-color, #eb4b4b)',
    errText: 'var(--affine-error-color, #eb4b4b)',
    errBg: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 12%, transparent)',
    errBorder:
      'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 40%, transparent)',
    ok: 'var(--affine-success-color, #4cae4c)',
    okText: 'var(--affine-success-color, #4cae4c)',
    okBg: 'color-mix(in srgb, var(--affine-success-color, #4cae4c) 12%, transparent)',
    okBorder:
      'color-mix(in srgb, var(--affine-success-color, #4cae4c) 40%, transparent)',
    amber: '#e8a33d',

    // ---- fixed terminal/console palette (dark in both themes) ----
    consoleBg: '#0d1117',
    consoleBorder: '#22272e',
    consoleText: '#e6edf3',
    stdoutText: '#e6edf3',
    stderrText: '#ffa198',

    // ---- per-step-kind accents (github-dark-ish; extends ACTION_META) ----
    kindThought: '#9aa0a6',
    kindTool: '#79c0ff',
    kindWrite: '#7ee787',
    kindRun: '#d29922',
    kindFinal: '#d2a8ff',
  },

  radius: {
    xs: 4,
    sm: 6,
    md: 8,
    lg: 12,
    pill: 999,
  },

  space: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
  },

  font: {
    body: 'var(--affine-font-family, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)',
    mono: 'var(--affine-font-code-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
    size: {
      xs: 10,
      sm: 11.5,
      md: 12.5,
      lg: 14,
      xl: 17,
    },
  },

  // Motion: subtle, transform/opacity only, always reduced-motion-guarded by the
  // consumers via `agentKeyframes` (below). Kept here so pages can match timings.
  motion: {
    fast: '120ms',
    base: '180ms',
    slow: '260ms',
    ease: 'cubic-bezier(0.2, 0, 0.2, 1)',
  },
} as const;

export type AgentPaletteType = typeof AgentPalette;

// Shared keyframes + prefers-reduced-motion opt-out. Consumers inject this ONCE
// via a <style> tag (same trick the current pages use with `GLOBAL_CSS`). Names
// are prefixed `cdz-agent-*` so they never collide with the page-local
// `cdz-hermes-*` / `cdz-openclaw-*` keyframes. The `.cdz-agent-motion` class is
// applied to any element carrying a decorative animation/transition so the
// reduced-motion rule can neutralise it with `!important`.
export const agentKeyframes = `
@keyframes cdz-agent-spin{to{transform:rotate(360deg)}}
@keyframes cdz-agent-step-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes cdz-agent-pulse{0%,100%{opacity:1}50%{opacity:0.4}}
@keyframes cdz-agent-blink{0%,49%{opacity:1}50%,100%{opacity:0}}
@keyframes cdz-agent-fade-in{from{opacity:0}to{opacity:1}}
.cdz-agent-step{animation:cdz-agent-step-in 240ms cubic-bezier(0.2,0,0.2,1) both}
.cdz-agent-fade{animation:cdz-agent-fade-in 180ms ease both}
@media (prefers-reduced-motion: reduce){
  .cdz-agent-step{animation:none !important}
  .cdz-agent-fade{animation:none !important}
  .cdz-agent-motion{animation:none !important;transition:none !important}
  .cdz-agent-cursor{animation:none !important}
}
`;

// Convenience: a <StyleInjector/>-free way for pages to ensure the keyframes are
// present exactly once regardless of how many console instances mount. Idempotent
// by id; safe to call from every component's module scope. No-op during SSR.
let injected = false;
export function ensureAgentKeyframes(): void {
  if (injected || typeof document === 'undefined') return;
  const id = 'cdz-agent-keyframes';
  if (document.getElementById(id)) {
    injected = true;
    return;
  }
  try {
    const el = document.createElement('style');
    el.id = id;
    el.textContent = agentKeyframes;
    document.head.appendChild(el);
    injected = true;
  } catch {
    // DOM unavailable — components still render; only decorative motion is lost.
  }
}
