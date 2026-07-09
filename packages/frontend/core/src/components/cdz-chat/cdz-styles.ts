/**
 * CDZ Chat — styles orchestrator.
 *
 * Ensures the chat components have their styling prerequisites injected once:
 *   1. The namespaced `--cdz-*` design tokens (from `./cdz-tokens`) — a CSS
 *      string injected as a <style> element, mirroring the existing
 *      clickdz/workspace-boot.tsx pattern.
 *   2. The scoped Tailwind v4 layer (`./cdz-chat.css`) — imported as a build
 *      side-effect so the rspack `@tailwindcss/postcss` pipeline processes it
 *      and emits the generated utilities into the bundle.
 *
 * Why split them: the tokens are static CSS custom properties (cheap to inject
 * at runtime, no build step needed), while the Tailwind layer must go through
 * the build's PostCSS pipeline to generate utilities from the classes the
 * components use. Importing the .css here pulls it into the module graph so
 * the bundler processes it exactly once.
 *
 * `ensureCdzChatStyles()` is idempotent and safe to call from any mount point.
 */
import { cdzTokensCss } from './cdz-tokens';
import { ensureCdzTokens } from './cdz-tokens-injector';

// Side-effect import: pulls cdz-chat.css into the module graph so the build
// processes it through @tailwindcss/postcss. (The file is also imported below
// in ensureCdzChatStyles for clarity, but this top-level import guarantees it
// is included even if a consumer forgets to call the ensure function.)
import './cdz-chat.css';

let ensured = false;

/**
 * Inject the --cdz-* token <style> element once. The Tailwind layer is already
 * pulled in by the side-effect import above, so this only needs to handle the
 * runtime token definitions.
 */
export function ensureCdzChatStyles(): void {
  if (ensured) return;
  ensureCdzTokens(); // injects the <style id="cdz-chat-tokens"> element
  ensured = true;
}

/** Re-exported for tests / consumers that want the raw token CSS string. */
export { cdzTokensCss };
