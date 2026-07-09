/**
 * CDZ Chat — namespaced design tokens (source of truth, as a CSS string).
 *
 * Why a string and not a `.css` import? Two reasons:
 *  1. It mirrors the existing ClickDz pattern: `clickdz/workspace-boot.tsx`
 *     injects `ONBOARDING_CSS_FIX` (a CSS string exported from `niches.ts`)
 *     via a <style> element. We follow the same, proven, zero-build-config
 *     approach so the chat components are self-contained.
 *  2. It avoids assuming any particular CSS-loader behavior. The app's build
 *     is Vite + vanilla-extract; a raw `.css` string import would need a
 *     `?inline` query or a loader. A TS string just works everywhere.
 *
 * `cdz-tokens.css` (sibling file) is kept as the human-readable,
 * syntax-highlighted reference copy. If you edit the tokens, edit BOTH files
 * and keep them in sync. (A future refactor can switch to a real `.css?inline`
 * import once the scoped Tailwind v4 layer lands in Phase 2.)
 *
 * DESIGN PRINCIPLES
 * -----------------
 * 1. Namespace: every variable is prefixed `--cdz-` so it can NEVER collide
 *    with AFFiNE's own `--affine-*` / `--affine-v2-*` design tokens (defined
 *    in `@toeverything/theme`, numbering in the hundreds).
 * 2. Theme consistency: each `--cdz-*` token maps to the corresponding
 *    `--affine-v2-*` token with a hardcoded fallback, so the chat UI follows
 *    the user's AFFiNE light/dark theme AND any custom theme-editor overrides.
 * 3. Covers BOTH component vocabularies we are bringing in:
 *      - Claude-style: bg-0..bg-300, text-100..text-500, accent/accent-hover,
 *        font-serif, font-sans
 *      - shadcn (sidechat): background, foreground, card, popover, primary,
 *        secondary, muted, accent, destructive, border, input, ring, radius,
 *        + the sidebar-* set
 *    Both map onto the same `--affine-v2-*` source for a single color truth.
 */
export const cdzTokensCss = /* css */ `
:root {
  /* --- Claude-style background scale (warm-neutral surfaces) --- */
  --cdz-bg-0: var(--affine-v2-layer-background-primary, #faf9f5);
  --cdz-bg-000: var(--affine-v2-layer-background-primary, #ffffff);
  --cdz-bg-100: var(--affine-v2-layer-background-secondary, #ffffff);
  --cdz-bg-200: var(--affine-v2-layer-background-hoverOverlay, #f0eee6);
  --cdz-bg-300: var(--affine-v2-layer-insideBorder-border, #dddddd);

  /* --- Claude-style text scale --- */
  --cdz-text-100: var(--affine-v2-text-primary, #1f1e1d);
  --cdz-text-200: var(--affine-v2-text-primary, #3d3d3a);
  --cdz-text-300: var(--affine-v2-text-secondary, #73726c);
  --cdz-text-400: var(--affine-v2-text-secondary, #888888);
  --cdz-text-500: var(--affine-v2-text-tertiary, #999999);

  /* --- Accent (Claude terracotta) — kept as a brand accent, not mapped to
   *     AFFiNE's blue primary, because the chat components lean on this warm
   *     accent for their signature look. Overridable via the theme editor. --- */
  --cdz-accent: #d97757;
  --cdz-accent-hover: #c6613f;

  /* --- Fonts --- */
  --cdz-font-serif: 'Source Serif 4', Georgia, 'Times New Roman', serif;
  --cdz-font-sans: 'Inter', 'Onest', system-ui, -apple-system, sans-serif;

  /* --- Radius / motion --- */
  --cdz-radius: var(--affine-popover-radius, 0.75rem);
  --cdz-ease-silk: cubic-bezier(0.2, 0, 0, 1);

  /* --- shadcn vocabulary (maps onto the same AFFiNE v2 tokens) --- */
  --cdz-background: var(--cdz-bg-0);
  --cdz-foreground: var(--cdz-text-100);
  --cdz-card: var(--cdz-bg-100);
  --cdz-card-foreground: var(--cdz-text-100);
  --cdz-popover: var(--affine-v2-layer-background-overlayPanel, var(--cdz-bg-100));
  --cdz-popover-foreground: var(--cdz-text-100);
  --cdz-primary: var(--affine-v2-button-primary, var(--cdz-accent));
  --cdz-primary-foreground: var(--affine-v2-button-pureWhiteText, #ffffff);
  --cdz-secondary: var(--cdz-bg-200);
  --cdz-secondary-foreground: var(--cdz-text-100);
  --cdz-muted: var(--affine-v2-layer-background-tertiary, var(--cdz-bg-200));
  --cdz-muted-foreground: var(--cdz-text-300);
  --cdz-accent-foreground: var(--affine-v2-button-pureWhiteText, #ffffff);
  --cdz-destructive: var(--affine-v2-button-error, oklch(0.577 0.245 27.325));
  --cdz-destructive-foreground: var(--affine-v2-button-pureWhiteText, #ffffff);
  --cdz-border: var(--cdz-bg-300);
  --cdz-input: var(--cdz-bg-300);
  --cdz-ring: var(--cdz-accent);

  /* --- Sidebar vocabulary (for the sidechat in a sidebar shell) --- */
  --cdz-sidebar: var(--affine-v2-layer-background-secondary, var(--cdz-bg-100));
  --cdz-sidebar-foreground: var(--cdz-text-100);
  --cdz-sidebar-primary: var(--cdz-primary);
  --cdz-sidebar-primary-foreground: var(--cdz-primary-foreground);
  --cdz-sidebar-accent: var(--cdz-bg-200);
  --cdz-sidebar-accent-foreground: var(--cdz-text-100);
  --cdz-sidebar-border: var(--cdz-bg-300);
  --cdz-sidebar-ring: var(--cdz-ring);

  /* --- CDZ supermodel badge colors (per model id) --- */
  --cdz-badge-ultra: #8b5cf6;
  --cdz-badge-council: #ec4899;
  --cdz-badge-sage: #f59e0b;
  --cdz-badge-architect: #3b82f6;
  --cdz-badge-scholar: #10b981;
  --cdz-badge-flash: #06b6d4;
  --cdz-badge-polyglot: #6366f1;
}

/* Dark theme — AFFiNE toggles via html[data-theme="dark"] (next-themes) AND
 * a .dark class on <html>; we cover both selectors. */
.dark,
html[data-theme='dark'] {
  --cdz-bg-0: var(--affine-v2-layer-background-primary, #212121);
  --cdz-bg-000: var(--affine-v2-layer-background-primary, #2a2a2e);
  --cdz-bg-100: var(--affine-v2-layer-background-secondary, #262624);
  --cdz-bg-200: var(--affine-v2-layer-background-hoverOverlay, #30302e);
  --cdz-bg-300: var(--affine-v2-layer-insideBorder-border, #454540);

  --cdz-text-100: var(--affine-v2-text-primary, #ececec);
  --cdz-text-200: var(--affine-v2-text-primary, #e1e1e0);
  --cdz-text-300: var(--affine-v2-text-secondary, #b4b4b4);
  --cdz-text-400: var(--affine-v2-text-secondary, #8a8a88);
  --cdz-text-500: var(--affine-v2-text-tertiary, #6b6b65);

  /* Terracotta reads slightly brighter on dark backgrounds. */
  --cdz-accent: #d2996e;
  --cdz-accent-hover: #e5aa7f;

  --cdz-background: var(--cdz-bg-0);
  --cdz-foreground: var(--cdz-text-100);
  --cdz-card: var(--cdz-bg-100);
  --cdz-card-foreground: var(--cdz-text-100);
  --cdz-popover: var(--affine-v2-layer-background-overlayPanel, var(--cdz-bg-100));
  --cdz-popover-foreground: var(--cdz-text-100);
  --cdz-primary: var(--affine-v2-button-primary, var(--cdz-accent));
  --cdz-primary-foreground: var(--affine-v2-button-pureWhiteText, #212121);
  --cdz-secondary: var(--cdz-bg-200);
  --cdz-secondary-foreground: var(--cdz-text-100);
  --cdz-muted: var(--affine-v2-layer-background-tertiary, var(--cdz-bg-200));
  --cdz-muted-foreground: var(--cdz-text-300);
  --cdz-accent-foreground: var(--affine-v2-button-pureWhiteText, #212121);
  --cdz-destructive: var(--affine-v2-button-error, #f87171);
  --cdz-destructive-foreground: var(--affine-v2-button-pureWhiteText, #212121);
  --cdz-border: var(--cdz-bg-300);
  --cdz-input: var(--cdz-bg-300);
  --cdz-ring: var(--cdz-accent);

  --cdz-sidebar: var(--affine-v2-layer-background-secondary, var(--cdz-bg-100));
  --cdz-sidebar-foreground: var(--cdz-text-100);
  --cdz-sidebar-primary: var(--cdz-primary);
  --cdz-sidebar-primary-foreground: var(--cdz-primary-foreground);
  --cdz-sidebar-accent: var(--cdz-bg-200);
  --cdz-sidebar-accent-foreground: var(--cdz-text-100);
  --cdz-sidebar-border: var(--cdz-bg-300);
  --cdz-sidebar-ring: var(--cdz-ring);
}

/* fadeIn keyframe — used by the Claude-style greeting / suggestion chips.
 * Kept here (not in tw-animate-css) so the main chat component works even
 * before its scoped Tailwind layer is wired in Phase 2. */
@keyframes cdz-fade-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
    filter: blur(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
    filter: blur(0);
  }
}
`;
