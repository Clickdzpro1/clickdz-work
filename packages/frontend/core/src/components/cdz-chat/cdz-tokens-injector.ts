/**
 * CDZ Chat — design-token injector.
 *
 * Injects the namespaced `--cdz-*` tokens (see `cdz-tokens.ts`) exactly once
 * into the document head as a <style> element. This mirrors the existing
 * ClickDz pattern in `clickdz/workspace-boot.tsx` (which injects
 * `ONBOARDING_CSS_FIX` the same way) and keeps the chat components
 * self-contained — they don't have to edit the shared
 * `@affine/component/theme/global.css`.
 *
 * Safe to call from any mount point (workspace boot, chat page, sidebar). It
 * is idempotent: repeated calls no-op once the element with id
 * `cdz-chat-tokens` exists.
 */
import { cdzTokensCss } from './cdz-tokens';

const STYLE_ELEMENT_ID = 'cdz-chat-tokens';

let injected = false;

export function ensureCdzTokens(): void {
  if (injected) return;
  if (typeof document === 'undefined') return; // SSR / non-browser guard

  if (document.getElementById(STYLE_ELEMENT_ID)) {
    injected = true;
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = cdzTokensCss;
  document.head.appendChild(style);
  injected = true;
}
