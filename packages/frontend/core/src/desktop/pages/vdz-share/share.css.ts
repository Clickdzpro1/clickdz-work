import { style } from '@vanilla-extract/css';

import { vdzTheme } from '../workspace/vdz/theme.css';

/**
 * Share-viewer page shell. IMPORTANT: `vdzTheme` (which defines the --vdz-*
 * variables) must reach the page via CSS COMPOSITION here — theme.css.ts
 * exports a helper FUNCTION (`accentAlpha`), so importing it from RUNTIME
 * code trips vanilla-extract's "Invalid exports" serialization rule (only
 * plain values may cross into runtime). Every vdz surface root follows this
 * same compose-in-css pattern.
 */
export const page = style([
  vdzTheme,
  {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
    padding: '32px 5vw 40px',
    background: 'var(--vdz-bg, #0b0d12)',
    color: 'var(--vdz-text, #e6e9f0)',
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
]);
