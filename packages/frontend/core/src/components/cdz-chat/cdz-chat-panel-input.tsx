/**
 * CDZ Chat — host wiring for the main chat input.
 *
 * `CdzChatPanelInput` is a thin React wrapper around `ClaudeChatInput` that
 * bridges the component's `onSendMessage` payload to the existing AFFiNE AI
 * chat runtime (`AIChatRuntime`) and model service (`AIModelService`). It is
 * designed to be rendered directly in the React chat host page
 * (`desktop/pages/workspace/chat/index.tsx`) as a sibling to the Lit
 * `ai-chat-content` message list — replacing the input area currently embedded
 * inside the Lit `ai-chat-content` → `ai-chat-composer` → `ai-chat-input`
 * chain.
 *
 * Responsibilities:
 *  - Pull the active session + runtime from `useAIChatRuntime`.
 *  - Read the live model list + current model id from `AIModelService` and feed
 *    them into the ClaudeChatInput's model selector (so the selector reflects
 *    the server-side model registry, not a hardcoded list).
 *  - On send: set the chosen model on `AIModelService.setModel()`, then
 *    `runtime.dispatch({ type: 'sendMessage', ... })` so the message flows
 *    through the exact same session/streaming pipeline the Lit input used.
 *  - Map `isThinkingEnabled` → `cdz-sage` (Opus 4.8) when the user has the
 *    smart router (cdz-ultra) selected, mirroring Claude's "extended thinking
 *    uses the most capable model" behavior. The host can instead forward it as
 *    a parameter once the CDZ API supports a `thinking` field.
 *  - Forward attached files into the runtime's `images`/`attachments` context.
 *
 * This keeps ALL existing ClickDz features intact (Plan mode, Council, Workers)
 * because they live in the runtime + model service, not in the input widget.
 * The input is purely the compose surface; the brains stay where they are.
 */
import { ClaudeChatInput } from './claude-style-chat-input';
import { useCdzModelsFromService } from './use-cdz-models-from-service';
import type { AttachedFile, PastedContent } from './claude-style-chat-input';
import { COUNCIL_MODEL_ID } from '@affine/core/modules/ai-button/services/models';
import { useCallback } from 'react';

export interface CdzChatPanelInputProps {
  /** Dispatch a chat message into the AI runtime. Provided by the host page. */
  onSend: (data: {
    text: string;
    model: string;
    images: File[];
    isThinkingEnabled: boolean;
    pastedContent: PastedContent[];
  }) => void;
  /** Optional: the currently-active session id (for council-mode bookkeeping). */
  sessionId?: string;
  /** Override placeholder. */
  placeholder?: string;
}

/**
 * Renders the Claude-style input wired to the CDZ model service + runtime.
 *
 * The host page passes `onSend`, which performs the actual
 * `runtime.dispatch({ type: 'sendMessage', ... })`. This wrapper only handles
 * model selection sync + the thinking→sage mapping.
 */
export function CdzChatPanelInput({
  onSend,
  sessionId,
  placeholder,
}: CdzChatPanelInputProps) {
  const { models, selectedModelId, setSelectedModelId } =
    useCdzModelsFromService(sessionId);

  const handleSendMessage = useCallback(
    (data: {
      message: string;
      files: AttachedFile[];
      pastedContent: PastedContent[];
      model: string;
      isThinkingEnabled: boolean;
    }) => {
      // Extended thinking: if the user picked the smart router (cdz-ultra) and
      // enabled thinking, route to cdz-sage (Opus 4.8) for deeper reasoning.
      // Council mode is preserved as-is (cdz-council) — thinking is orthogonal.
      const effectiveModel =
        data.isThinkingEnabled && data.model === 'cdz-ultra'
          ? 'cdz-sage'
          : data.model;

      // Keep the service's model id in sync so the rest of the app (toolbar,
      // preference popup, server-side prompt registry) sees the same selection.
      setSelectedModelId(effectiveModel);

      onSend({
        text: data.message,
        model: effectiveModel,
        images: data.files
          .filter(f => f.type.startsWith('image/'))
          .map(f => f.file),
        isThinkingEnabled: data.isThinkingEnabled,
        pastedContent: data.pastedContent,
      });
    },
    [onSend, setSelectedModelId]
  );

  return (
    <ClaudeChatInput
      models={models}
      defaultModelId={selectedModelId ?? 'cdz-ultra'}
      onSendMessage={handleSendMessage}
      placeholder={placeholder}
    />
  );
}

export { COUNCIL_MODEL_ID };
