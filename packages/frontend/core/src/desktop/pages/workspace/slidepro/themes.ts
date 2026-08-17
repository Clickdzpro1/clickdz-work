// SlidePro — presentation themes. Five restrained, professional looks: real
// typography, considered palettes, subtle accents. NO rainbow gradients, no
// glow. Each theme is a flat token set the SlideView renderer reads; the same
// tokens drive the on-screen editor preview, present mode, and the print sheet,
// so what you edit is exactly what you present and export.

export interface SlideTheme {
  id: string;
  /** French display name for the theme switcher. */
  label: string;
  /** Slide background (solid or a very subtle vertical wash). */
  bg: string;
  /** Primary text (titles + body). */
  fg: string;
  /** Secondary/muted text (subtitles, footers, page numbers). */
  muted: string;
  /** Accent — bullet markers, title underline/kicker, quote bar. */
  accent: string;
  /** A faint surface used behind two-column / image captions. */
  surface: string;
  /** Hairline divider colour. */
  line: string;
  /** Heading font stack. */
  headingFont: string;
  /** Body font stack. */
  bodyFont: string;
  /** Small thumbnail swatch pair for the theme picker chip [bg, accent]. */
  swatch: [string, string];
}

// System-font stacks only — no webfont loading (keeps the studio dependency-free
// and instant, and matches the app's own type choices). Each theme pairs a
// distinctive heading stack with a readable body stack.
const SANS =
  '"Inter", "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif';
const GEOMETRIC =
  '"Futura", "Century Gothic", "Avenir Next", "Segoe UI", system-ui, sans-serif';
const SERIF =
  'Georgia, "Iowan Old Style", "Times New Roman", "Noto Serif", serif';
const GROTESK =
  '"Helvetica Neue", "Arial Nova", Arial, "Segoe UI", system-ui, sans-serif';
const MONO_ACCENT =
  '"SF Mono", "JetBrains Mono", "Roboto Mono", ui-monospace, monospace';

export const THEMES: SlideTheme[] = [
  {
    id: 'midnight',
    label: 'Minuit',
    bg: 'linear-gradient(180deg, #0f1720 0%, #0b1118 100%)',
    fg: '#f4f6f8',
    muted: '#9aa7b4',
    accent: '#4f9cf9',
    surface: 'rgba(255,255,255,0.05)',
    line: 'rgba(255,255,255,0.12)',
    headingFont: SANS,
    bodyFont: SANS,
    swatch: ['#0f1720', '#4f9cf9'],
  },
  {
    id: 'ivory',
    label: 'Ivoire',
    bg: '#faf8f4',
    fg: '#1c1a17',
    muted: '#6b655c',
    accent: '#b4703c',
    surface: '#f0ece3',
    line: '#e3ddd1',
    headingFont: SERIF,
    bodyFont: SANS,
    swatch: ['#faf8f4', '#b4703c'],
  },
  {
    id: 'slate',
    label: 'Ardoise',
    bg: '#ffffff',
    fg: '#0f172a',
    muted: '#64748b',
    accent: '#0f766e',
    surface: '#f1f5f9',
    line: '#e2e8f0',
    headingFont: GROTESK,
    bodyFont: GROTESK,
    swatch: ['#ffffff', '#0f766e'],
  },
  {
    id: 'oxford',
    label: 'Oxford',
    bg: 'linear-gradient(180deg, #10233f 0%, #0c1b30 100%)',
    fg: '#eef2f7',
    muted: '#9db0c6',
    accent: '#c9a24b',
    surface: 'rgba(255,255,255,0.06)',
    line: 'rgba(255,255,255,0.14)',
    headingFont: SERIF,
    bodyFont: SERIF,
    swatch: ['#10233f', '#c9a24b'],
  },
  {
    id: 'studio',
    label: 'Studio',
    bg: '#111112',
    fg: '#fafafa',
    muted: '#8a8a8f',
    accent: '#e4572e',
    surface: 'rgba(255,255,255,0.055)',
    line: 'rgba(255,255,255,0.13)',
    headingFont: GEOMETRIC,
    bodyFont: SANS,
    swatch: ['#111112', '#e4572e'],
  },
];

export const DEFAULT_THEME_ID = 'midnight';

export function getTheme(themeId: string | undefined): SlideTheme {
  return THEMES.find(t => t.id === themeId) ?? THEMES[0];
}

// Expose the accent-mono stack so a theme could opt into it later without a new
// import site; referenced here to keep it in the module's public surface.
export const ACCENT_MONO_FONT = MONO_ACCENT;
