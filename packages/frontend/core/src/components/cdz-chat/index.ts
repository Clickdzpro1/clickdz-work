/**
 * CDZ Chat components — public barrel.
 *
 * Phase 1: foundation — `cn` class-merge util, namespaced `--cdz-*` design
 *           tokens, idempotent token injector.
 * Phase 2: sidechat — `CdzPromptInput` (the ai-chat-input sidechat wired to CDZ
 *           models), the CDZ model registry, browser-capability detection for
 *           voice, and the scoped Tailwind v4 styles orchestrator.
 *
 * Placement: `packages/frontend/core/src/components/cdz-chat/`
 *   - new React `.tsx` components live here (kept out of
 *     `@affine/component/src/ui/`, which is reserved for shared design-system
 *     primitives, and out of the Lit `blocksuite/ai/components/` tree).
 *   - import as `@affine/core/components/cdz-chat` (the `@affine/core`
 *     package maps `./*` -> `./src/*`).
 *
 * The main chat input (claude-style-chat-input) and the CDZ model/workers
 * pickers land in Phase 3 and will be re-exported from here as they are added.
 */

// Foundation (Phase 1)
export { cn } from './cn';
export { cdzTokensCss } from './cdz-tokens';
export { ensureCdzTokens } from './cdz-tokens-injector';

// Sidechat (Phase 2)
export { CdzPromptInput, default } from './ai-chat-input';
export type { CdzPromptInputProps } from './ai-chat-input';
export {
  CDZ_MODELS,
  CDZ_EFFORTS,
  CDZ_DEFAULT_MODEL_ID,
  getCdzModel,
} from './cdz-models';
export type { CdzModelOption, CdzModelKind, CdzEffort } from './cdz-models';
export { useCdzBrowserCapabilities } from './use-cdz-browser-capabilities';
export type { CdzBrowserCapabilities } from './use-cdz-browser-capabilities';
export { ensureCdzChatStyles } from './cdz-styles';
