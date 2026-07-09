/**
 * CDZ Chat components — public barrel.
 *
 * Phase 1 (this commit): foundation only — the `cn` class-merge utility, the
 * namespaced `--cdz-*` design tokens, and the idempotent token injector.
 *
 * The actual chat components (claude-style-chat-input, ai-chat-input sidechat,
 * CDZ model picker, workers picker, plan-mode toggle, council trigger) land in
 * later phases and will be re-exported from here as they are added.
 *
 * Placement: `packages/frontend/core/src/components/cdz-chat/`
 *   - new React `.tsx` components live here (kept out of
 *     `@affine/component/src/ui/`, which is reserved for shared design-system
 *     primitives, and out of the Lit `blocksuite/ai/components/` tree).
 *   - import as `@affine/core/components/cdz-chat` (the `@affine/core`
 *     package maps `./*` -> `./src/*`).
 */

export { cn } from './cn';
export { cdzTokensCss } from './cdz-tokens';
export { ensureCdzTokens } from './cdz-tokens-injector';
