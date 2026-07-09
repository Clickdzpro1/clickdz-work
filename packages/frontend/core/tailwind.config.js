/**
 * Tailwind config — scoped to the CDZ chat components ONLY.
 *
 * Why this exists: the rspack build (tools/cli/src/rspack/index.ts) auto-enables
 * `@tailwindcss/postcss` for a package when a `tailwind.config.js` is present
 * in that package. We deliberately scope `content` to the `cdz-chat/` folder so
 * Tailwind only scans + generates utilities for the new chat components
 * (claude-style-chat-input, ai-chat-input sidechat, model picker, workers
 * picker). It does NOT scan the rest of @affine/core, so the existing
 * vanilla-extract + AFFiNE design system is untouched and there is zero risk
 * of Tailwind utilities leaking into the broader app.
 *
 * This mirrors the proven @affine/admin setup (which uses the same
 * `@tailwindcss/postcss` + `tailwindcss-animate` + `@toeverything/theme`
 * mapping) but with a tight content scope.
 *
 * @type {import('tailwindcss').Config}
 */
const { baseTheme, themeToVar } = require('@toeverything/theme');

const themeVar = (key, fallback) =>
  `var(${themeToVar(key)}${fallback ? `, ${fallback}` : ''})`;

module.exports = {
  darkMode: ['class'],
  // ONLY scan the CDZ chat components. This is the key scoping decision — it
  // keeps Tailwind's generated CSS minimal and prevents it from rewriting
  // styles anywhere else in @affine/core.
  content: ['./src/components/cdz-chat/**/*.{ts,tsx}'],
  prefix: '',
  theme: {
    extend: {
      fontFamily: {
        // Claude-style components reference font-serif (Source Serif 4) and
        // font-sans (Inter/Onest) via the --cdz-font-* tokens.
        serif: ['var(--cdz-font-serif)'],
        sans: ['var(--cdz-font-sans)'],
        mono: themeVar('fontCodeFamily', baseTheme.fontCodeFamily),
      },
      fontSize: {
        base: themeVar('fontBase', baseTheme.fontBase),
        sm: themeVar('fontSm', baseTheme.fontSm),
        xs: themeVar('fontXs', baseTheme.fontXs),
      },
      colors: {
        // Map the shadcn semantic colors onto the namespaced --cdz-* tokens
        // (which themselves map to --affine-v2-*). This keeps a single source
        // of truth for color and automatic light/dark theme consistency.
        border: 'var(--cdz-border)',
        input: 'var(--cdz-input)',
        ring: 'var(--cdz-ring)',
        background: 'var(--cdz-background)',
        foreground: 'var(--cdz-foreground)',
        primary: {
          DEFAULT: 'var(--cdz-primary)',
          foreground: 'var(--cdz-primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--cdz-secondary)',
          foreground: 'var(--cdz-secondary-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--cdz-destructive)',
          foreground: 'var(--cdz-destructive-foreground)',
        },
        muted: {
          DEFAULT: 'var(--cdz-muted)',
          foreground: 'var(--cdz-muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--cdz-accent)',
          foreground: 'var(--cdz-accent-foreground)',
        },
        popover: {
          DEFAULT: 'var(--cdz-popover)',
          foreground: 'var(--cdz-popover-foreground)',
        },
        card: {
          DEFAULT: 'var(--cdz-card)',
          foreground: 'var(--cdz-card-foreground)',
        },
        // Claude-style background + text scales (bg-bg-0 .. text-text-500)
        'bg-0': 'var(--cdz-bg-0)',
        'bg-000': 'var(--cdz-bg-000)',
        'bg-100': 'var(--cdz-bg-100)',
        'bg-200': 'var(--cdz-bg-200)',
        'bg-300': 'var(--cdz-bg-300)',
        'text-100': 'var(--cdz-text-100)',
        'text-200': 'var(--cdz-text-200)',
        'text-300': 'var(--cdz-text-300)',
        'text-400': 'var(--cdz-text-400)',
        'text-500': 'var(--cdz-text-500)',
        // CDZ supermodel badge colors
        'badge-ultra': 'var(--cdz-badge-ultra)',
        'badge-council': 'var(--cdz-badge-council)',
        'badge-sage': 'var(--cdz-badge-sage)',
        'badge-architect': 'var(--cdz-badge-architect)',
        'badge-scholar': 'var(--cdz-badge-scholar)',
        'badge-flash': 'var(--cdz-badge-flash)',
        'badge-polyglot': 'var(--cdz-badge-polyglot)',
      },
      borderRadius: {
        lg: 'var(--cdz-radius)',
        md: 'calc(var(--cdz-radius) - 2px)',
        sm: 'calc(var(--cdz-radius) - 4px)',
      },
      boxShadow: {
        menu: themeVar('menuShadow'),
        overlay: themeVar('overlayShadow'),
      },
      keyframes: {
        'cdz-fade-in': {
          from: {
            opacity: '0',
            transform: 'translateY(8px) scale(0.98)',
            filter: 'blur(4px)',
          },
          to: {
            opacity: '1',
            transform: 'translateY(0) scale(1)',
            filter: 'blur(0)',
          },
        },
      },
      animation: {
        'fade-in': 'cdz-fade-in 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
