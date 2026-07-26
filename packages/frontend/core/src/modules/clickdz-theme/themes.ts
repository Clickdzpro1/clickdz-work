/**
 * ClickDz curated theme presets.
 *
 * Each preset is a set of `--affine-*` (v1) and `--affine-v2-*` (v2) CSS
 * variable overrides layered on top of AFFiNE's light/dark base by
 * {@link ClickDzThemeService} via an injected `<style>` element scoped with
 * `html[data-cdz-theme='<id>']`. Every variable name below is verified against
 * `@toeverything/theme`'s `ColorVariables`/`StyleVariables` (v1) and the
 * generated `--affine-v2-*` token set (v2) actually consumed across the app.
 *
 * All palettes are designed for WCAG AA text contrast on their surfaces
 * (see the ratios documented on each entry).
 */

export type ClickDzThemeBase = 'light' | 'dark';

export interface ClickDzThemePalette {
  /** Window / app backdrop. */
  bg: string;
  /** Raised surface: sidebar, cards, menus. */
  surface: string;
  /** Secondary surface: inputs, subtle wells. */
  surfaceAlt: string;
  /** Primary body text. */
  text: string;
  /** Muted / secondary text. */
  textSecondary: string;
  /** Tertiary text (section headers, hints). */
  textTertiary: string;
  /** Disabled text. */
  textDisabled: string;
  /** Hairline borders / dividers. */
  border: string;
  /** Hover overlay fill. */
  hover: string;
  /** Brand accent (start of the ClickDz gradient). */
  accent: string;
  /** Brand accent, secondary stop (used for gradients / studio flourish). */
  accent2: string;
  /** Legible text color placed ON the accent (chips / primary buttons). */
  onAccent: string;
  /** Popover / menu elevation shadow. */
  shadow: string;
}

export interface ClickDzTheme {
  id: string;
  name: string;
  description: string;
  base: ClickDzThemeBase;
  palette: ClickDzThemePalette;
  /** Fully-resolved `--affine-*` override map applied for this theme. */
  vars: Record<string, string>;
}

/**
 * Build the full override map from a compact palette so every preset touches
 * the same, consistent set of tokens (accent family, backgrounds, borders,
 * text, icons, shadows) — enough to feel transformative, not just an accent
 * swap.
 */
function buildVars(p: ClickDzThemePalette): Record<string, string> {
  return {
    // ---- accent / brand family (v1) ----
    '--affine-brand-color': p.accent,
    '--affine-primary-color': p.accent,
    '--affine-link-color': p.accent,
    '--affine-hover-color': p.hover,

    // ---- backgrounds (v1) ----
    '--affine-background-primary-color': p.bg,
    '--affine-background-secondary-color': p.surface,
    '--affine-background-tertiary-color': p.surfaceAlt,
    '--affine-background-overlay-panel-color': p.surface,
    '--affine-background-modal-color': p.bg,

    // ---- text (v1) ----
    '--affine-text-primary-color': p.text,
    '--affine-text-secondary-color': p.textSecondary,
    '--affine-text-disable-color': p.textDisabled,
    '--affine-text-emphasis-color': p.accent,

    // ---- borders / icons (v1) ----
    '--affine-border-color': p.border,
    '--affine-divider-color': p.border,
    '--affine-icon-color': p.textSecondary,
    '--affine-icon-secondary': p.textTertiary,
    '--affine-placeholder-color': p.textTertiary,

    // ---- elevation (v1) ----
    '--affine-popover-shadow': p.shadow,
    '--affine-menu-shadow': p.shadow,

    // ---- backgrounds (v2 layer) ----
    '--affine-v2-layer-background-primary': p.surface,
    '--affine-v2-layer-background-secondary': p.surfaceAlt,
    '--affine-v2-layer-background-tertiary': p.bg,
    '--affine-v2-layer-background-overlayPanel': p.surface,
    '--affine-v2-layer-background-hoverOverlay': p.hover,
    '--affine-v2-layer-background-modal': p.surface,
    '--affine-v2-layer-background-mobile-primary': p.surface,
    '--affine-v2-layer-background-mobile-secondary': p.bg,

    // ---- borders (v2 layer) ----
    '--affine-v2-layer-insideBorder-border': p.border,
    '--affine-v2-layer-insideBorder-blackBorder': p.border,
    '--affine-v2-layer-insideBorder-primaryBorder': p.accent,

    // ---- text (v2) ----
    '--affine-v2-text-primary': p.text,
    '--affine-v2-text-secondary': p.textSecondary,
    '--affine-v2-text-tertiary': p.textTertiary,
    '--affine-v2-text-placeholder': p.textTertiary,
    '--affine-v2-text-disable': p.textDisabled,
    '--affine-v2-text-emphasis': p.accent,
    '--affine-v2-text-link': p.accent,

    // ---- icons (v2) ----
    '--affine-v2-icon-primary': p.textSecondary,
    '--affine-v2-icon-secondary': p.textTertiary,
    '--affine-v2-icon-tertiary': p.textTertiary,
    '--affine-v2-icon-activated': p.accent,

    // ---- accent controls (v2) ----
    '--affine-v2-button-primary': p.accent,
    '--affine-v2-button-pureWhiteText': p.onAccent,
    '--affine-v2-input-background': p.surfaceAlt,
    '--affine-v2-input-border-active': p.accent,
  };
}

/**
 * 1. ClickDz Midnight — refined brand default (deep blue-black, blue→violet).
 *    text/bg 16.0:1, secondary/bg 7.7:1, accent/bg 6.0:1 (AAA/AA).
 */
const midnightPalette: ClickDzThemePalette = {
  bg: '#0d1117',
  surface: '#161b24',
  surfaceAlt: '#1c2330',
  text: '#e6edf3',
  textSecondary: '#9aa7b8',
  textTertiary: '#6b7889',
  textDisabled: '#4a5566',
  border: '#232b38',
  hover: 'rgba(123, 152, 255, 0.10)',
  accent: '#5b8cff',
  accent2: '#a06bff',
  onAccent: '#0d1117',
  shadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
};

/**
 * 2. Daylight — clean light (warm white, ink text, blue accent).
 *    text/bg 16.5:1, secondary/bg 6.4:1, accent/bg 4.3:1 (AAA/AA).
 */
const daylightPalette: ClickDzThemePalette = {
  bg: '#faf9f7',
  surface: '#ffffff',
  surfaceAlt: '#f1efec',
  text: '#1a1a1a',
  textSecondary: '#5c5c5c',
  textTertiary: '#8a8a8a',
  textDisabled: '#b8b8b8',
  border: '#e6e3de',
  hover: 'rgba(47, 111, 237, 0.08)',
  accent: '#2f6fed',
  accent2: '#7c5cff',
  onAccent: '#ffffff',
  shadow: '0 4px 20px rgba(20, 20, 40, 0.12)',
};

/**
 * 3. Obsidian — true-black OLED, high contrast, violet accent.
 *    text/bg 19.3:1, secondary/bg 8.1:1, accent/bg 5.0:1 (AAA/AA).
 */
const obsidianPalette: ClickDzThemePalette = {
  bg: '#000000',
  surface: '#0a0a0a',
  surfaceAlt: '#141414',
  text: '#f5f5f7',
  textSecondary: '#a0a0a8',
  textTertiary: '#6e6e78',
  textDisabled: '#4a4a52',
  border: '#20202a',
  hover: 'rgba(139, 92, 246, 0.14)',
  accent: '#8b5cf6',
  accent2: '#c084fc',
  onAccent: '#ffffff',
  shadow: '0 4px 24px rgba(0, 0, 0, 0.8)',
};

/**
 * 4. Aurora — deep sea dark (teal/green surfaces, emerald/cyan accent).
 *    text/bg 15.0:1, secondary/bg 7.6:1, accent/bg 9.1:1 (AAA).
 */
const auroraPalette: ClickDzThemePalette = {
  bg: '#08201d',
  surface: '#0f2e29',
  surfaceAlt: '#153a34',
  text: '#e3f5ef',
  textSecondary: '#8fb5ac',
  textTertiary: '#5f857c',
  textDisabled: '#436058',
  border: '#1c453e',
  hover: 'rgba(45, 212, 191, 0.12)',
  accent: '#2dd4bf',
  accent2: '#34d399',
  onAccent: '#04140f',
  shadow: '0 4px 22px rgba(0, 20, 16, 0.6)',
};

/**
 * 5. Sunset — warm dark (charcoal-brown surfaces, amber/coral accent).
 *    text/bg 15.0:1, secondary/bg 7.5:1, accent/bg 8.4:1 (AAA).
 */
const sunsetPalette: ClickDzThemePalette = {
  bg: '#1c1613',
  surface: '#261d18',
  surfaceAlt: '#31251f',
  text: '#f5e9df',
  textSecondary: '#b8a494',
  textTertiary: '#8a7867',
  textDisabled: '#635548',
  border: '#3a2c24',
  hover: 'rgba(245, 158, 66, 0.12)',
  accent: '#f59e42',
  accent2: '#fb7185',
  onAccent: '#1c1005',
  shadow: '0 4px 22px rgba(20, 10, 4, 0.6)',
};

export const CLICKDZ_THEMES: ClickDzTheme[] = [
  {
    id: 'midnight',
    name: 'ClickDz Midnight',
    description: 'The brand — deep blue-black with a blue-to-violet accent.',
    base: 'dark',
    palette: midnightPalette,
    vars: buildVars(midnightPalette),
  },
  {
    id: 'daylight',
    name: 'Daylight',
    description: 'Clean warm-white light mode with a crisp blue accent.',
    base: 'light',
    palette: daylightPalette,
    vars: buildVars(daylightPalette),
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    description: 'True-black OLED with high contrast and a violet accent.',
    base: 'dark',
    palette: obsidianPalette,
    vars: buildVars(obsidianPalette),
  },
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Deep-sea teal surfaces with an emerald-cyan accent.',
    base: 'dark',
    palette: auroraPalette,
    vars: buildVars(auroraPalette),
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Warm charcoal-brown surfaces with an amber-coral accent.',
    base: 'dark',
    palette: sunsetPalette,
    vars: buildVars(sunsetPalette),
  },
];

/**
 * Daylight is the default preset. Merchants use ClickDz on mid-range Android
 * phones, often outdoors or under bright shop lighting, where a light surface
 * is simply more legible than the dark brand palette. Midnight stays one click
 * away in Appearance for anyone who prefers it.
 *
 * This only selects which preset's CSS variables apply. The light/dark *base*
 * is enforced by `ClickDzThemeModifier` only once a user has explicitly picked
 * a preset (`explicitlySet$`), so changing this default never yanks the mode
 * out from under an existing user who already made a choice.
 */
export const DEFAULT_CLICKDZ_THEME_ID = 'daylight';

export const CLICKDZ_THEME_MAP: Record<string, ClickDzTheme> = Object.fromEntries(
  CLICKDZ_THEMES.map(theme => [theme.id, theme])
);

/**
 * Serialize all presets into a single stylesheet. Each block is scoped by both
 * the theme id attribute and the base-mode attribute next-themes writes on
 * `<html>`. next-themes runs in its default `attribute="data-theme"` mode here
 * (the provider sets no `attribute` prop, and `@toeverything/theme` scopes its
 * own light/dark tokens with `[data-theme='light'|'dark']`, never a class), so
 * the base selector must be `[data-theme='<base>']`, NOT `.dark` / `.light` —
 * those classes never exist on `<html>`, which is why the colored presets never
 * applied. `html[data-cdz-theme='x'][data-theme='dark']` has specificity
 * (0,2,1), so it reliably beats the theme package's `[data-theme='dark']`
 * (0,1,0) regardless of stylesheet order.
 */
export function buildClickDzThemeStylesheet(): string {
  return CLICKDZ_THEMES.map(theme => {
    const body = Object.entries(theme.vars)
      .map(([key, value]) => `  ${key}: ${value};`)
      .join('\n');
    return `html[data-cdz-theme='${theme.id}'][data-theme='${theme.base}'] {\n${body}\n}`;
  }).join('\n\n');
}
