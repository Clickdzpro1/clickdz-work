import {
  buildClickDzThemeStylesheet,
  ClickDzThemeService,
} from '@affine/core/modules/clickdz-theme';
import { useLiveData, useService } from '@toeverything/infra';
import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';

const STYLE_ELEMENT_ID = 'clickdz-theme-vars';

/**
 * Applies the selected ClickDz theme preset app-wide.
 *
 * Unlike {@link CustomThemeModifier} (which wipes and rewrites inline styles on
 * `document.documentElement`), this injects a single static `<style>` element
 * holding every preset's scoped variable block and simply flips the
 * `data-cdz-theme` attribute on `<html>`. That keeps it independent of — and
 * non-destructive toward — the theme-editor's inline styles and next-themes'
 * class toggling, so all three coexist. Switching presets is instant (attribute
 * swap, no reload) and persists via `ClickDzThemeService` / GlobalState.
 */
export const ClickDzThemeModifier = () => {
  const themeService = useService(ClickDzThemeService);
  const theme = useLiveData(themeService.theme$);
  const explicitlySet = useLiveData(themeService.explicitlySet$);
  const { setTheme } = useTheme();
  // The base mode is enforced when the *selected preset* changes, not on every
  // light/dark toggle — so the appearance radio stays usable afterwards.
  const lastAppliedBaseFor = useRef<string | null>(null);

  // Inject the preset stylesheet once (idempotent across HMR / remounts).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let styleEl = document.getElementById(
      STYLE_ELEMENT_ID
    ) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ELEMENT_ID;
      document.head.appendChild(styleEl);
    }
    const css = buildClickDzThemeStylesheet();
    if (styleEl.textContent !== css) {
      styleEl.textContent = css;
    }
  }, []);

  // Reflect the current selection onto <html> and align the light/dark base.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.cdzTheme = theme.id;

    // Only switch the base mode once the user has explicitly picked a preset,
    // and only when the selection actually changed — never on first load for a
    // user who has never chosen a ClickDz theme.
    if (explicitlySet && lastAppliedBaseFor.current !== theme.id) {
      lastAppliedBaseFor.current = theme.id;
      setTheme(theme.base);
    }
  }, [theme.id, theme.base, explicitlySet, setTheme]);

  return null;
};
