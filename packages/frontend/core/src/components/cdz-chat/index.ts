/**
 * CDZ Chat components — public barrel.
 *
 * Phase 1: foundation — `cn` class-merge util, namespaced `--cdz-*` design
 *           tokens, idempotent token injector.
 * Phase 2: sidechat — `CdzPromptInput` (the ai-chat-input sidechat wired to CDZ
 *           models), the CDZ model registry, browser-capability detection for
 *           voice, and the scoped Tailwind v4 styles orchestrator.
 * Phase 3: main chat — `ClaudeChatInput` (the Claude-style main input), the
 *           Lit→React bridge, the host wiring, and the model-service sync hook.
 * Phase 4: feature bridge — the Workers picker (502 skills), the Council
 *           trigger, the dispatch hook (worker system-prompt injection +
 *           runtime.dispatch wiring), and the integrated host panel.
 *
 * Placement: `packages/frontend/core/src/components/cdz-chat/`
 *   - new React `.tsx` components live here (kept out of
 *     `@affine/component/src/ui/`, which is reserved for shared design-system
 *     primitives, and out of the Lit `blocksuite/ai/components/` tree).
 *   - import as `@affine/core/components/cdz-chat` (the `@affine/core`
 *     package maps `./*` -> `./src/*`).
 *
 * The chat host page (desktop/pages/workspace/chat/index.tsx) mounts
 * `CdzChatPanelInput` behind the `enable_cdz_chat` feature flag.
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
export { ClaudeChatInput } from './claude-style-chat-input';
export type {
  ClaudeChatInputProps,
  AttachedFile,
  PastedContent,
} from './claude-style-chat-input';
export { Icons as CdzChatIcons } from './icons';
export { useCdzModelsFromService } from './use-cdz-models-from-service';
export { createReactBridge } from './lit-react-bridge';

// Feature bridge (Phase 4)
export { CdzChatPanelInput, default } from './cdz-chat-panel-input';
export type { CdzChatPanelInputProps } from './cdz-chat-panel-input';
export { CdzWorkersPicker } from './cdz-workers-picker';
export type {
  CdzWorkersPickerProps,
  CdzSelectedWorker,
} from './cdz-workers-picker';
export {
  useCdzWorkersCatalog,
  fetchCdzWorkerPrompt,
  flattenWorkers,
} from './cdz-workers-catalog';
export type {
  CdzWorker,
  CdzWorkerCategory,
  CdzWorkersCatalog,
  UseCdzWorkersResult,
} from './cdz-workers-catalog';
export { CdzCouncilTrigger } from './cdz-council-trigger';
export type { CdzCouncilTriggerProps } from './cdz-council-trigger';
export { useCdzChatDispatch } from './cdz-chat-dispatch';
export type {
  CdzSendPayload,
  CdzActiveWorker,
} from './cdz-chat-dispatch';
