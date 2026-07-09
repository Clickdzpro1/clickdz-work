/**
 * CDZ Chat components — public barrel.
 *
 * Phase 1: foundation — `cn` class-merge util, namespaced `--cdz-*` design
 *           tokens, idempotent token injector.
 * Phase 2: sidechat — `CdzPromptInput` (the ai-chat-input sidechat wired to CDZ
 *           models), the CDZ model registry, browser-capability detection for
 *           voice, and the scoped Tailwind v4 styles orchestrator.
 * Phase 3: main chat — `ClaudeChatInput` (the Claude-style main input), the
 *           Lit→React bridge, the host wiring (`CdzChatPanelInput`), and the
 *           model-service sync hook.
 *
 * Placement: `packages/frontend/core/src/components/cdz-chat/`
 *   - new React `.tsx` components live here (kept out of
 *     `@affine/component/src/ui/`, which is reserved for shared design-system
 *     primitives, and out of the Lit `blocksuite/ai/components/` tree).
 *   - import as `@affine/core/components/cdz-chat` (the `@affine/core`
 *     package maps `./*` -> `./src/*`).
 *
 * Phase 4 (feature bridge: workers picker, council trigger wiring into the
 * host) and Phase 5 (i18n + a11y) are still ahead.
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

// Main chat (Phase 3)
export { ClaudeChatInput, default } from './claude-style-chat-input';
export type {
  ClaudeChatInputProps,
  AttachedFile,
  PastedContent,
} from './claude-style-chat-input';
export { Icons as CdzChatIcons } from './icons';
export { CdzChatPanelInput } from './cdz-chat-panel-input';
export type { CdzChatPanelInputProps } from './cdz-chat-panel-input';
export { useCdzModelsFromService } from './use-cdz-models-from-service';
export { createReactBridge } from './lit-react-bridge';
