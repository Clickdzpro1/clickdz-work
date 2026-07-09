/**
 * CDZ Chat — dispatch hook: bridges the chat inputs to the AIChatRuntime.
 *
 * `useCdzChatDispatch(runtime)` returns an `onSend` function that maps the
 * payload from the chat inputs (text, model, images, thinking, pasted content,
 * active worker) into the exact `runtime.dispatch({ type: 'send', ... })`
 * action the existing Lit input uses (see
 * blocksuite/ai/runtime/chat/actions.ts AIChatSendOptions).
 *
 * Worker integration: when an active worker is set, we:
 *   1. fetch its system prompt from CDZ AI /v1/workers/:id (lazy, cached)
 *   2. prepend the worker's system directive to the user input so the chosen
 *      CDZ model answers as that specialist
 *   3. route to the worker's category recommendedModel (unless the user
 *      explicitly picked a different model in the selector — explicit picks win)
 *
 * This keeps ALL dispatch flowing through the same runtime pipeline the Lit
 * input used, so streaming, history, abort, and the server-side prompt
 * registry all keep working unchanged.
 */
import { useCallback, useRef } from 'react';
import type { AIChatRuntime } from '@affine/core/blocksuite/ai';
import { fetchCdzWorkerPrompt } from './cdz-workers-catalog';
import type { PastedContent } from './claude-style-chat-input';

export interface CdzSendPayload {
  text: string;
  model: string; // CDZ model id, e.g. 'cdz-ultra'
  images: File[];
  isThinkingEnabled: boolean;
  pastedContent: PastedContent[];
}

export interface CdzActiveWorker {
  id: string;
  name: string;
  category: string;
  recommendedModel: string;
}

export function useCdzChatDispatch(runtime: AIChatRuntime) {
  // Cache worker system prompts so we don't refetch on every send.
  const promptCache = useRef<Map<string, string>>(new Map());

  return useCallback(
    async (payload: CdzSendPayload, activeWorker?: CdzActiveWorker | null) => {
      let { text, model } = payload;

      // Worker injection: prepend the worker's system directive + route to its
      // recommended model (unless the user overrode the model in the selector).
      if (activeWorker) {
        let prompt = promptCache.current.get(activeWorker.id);
        if (!prompt) {
          prompt = await fetchCdzWorkerPrompt(activeWorker.id);
          if (prompt) promptCache.current.set(activeWorker.id, prompt);
        }
        if (prompt) {
          // Prepend the worker's directive as a system-style prefix on the
          // user turn. The CDZ API treats the first user message as context,
          // so wrapping the directive here makes the chosen model answer as
          // that specialist.
          text = `${prompt}\n\n---\n\n${text}`;
        }
        // Route to the worker's recommended model unless the user picked a
        // non-default model themselves (cdz-ultra = default router).
        if (model === 'cdz-ultra') {
          model = activeWorker.recommendedModel || model;
        }
      }

      // Append pasted content as additional context after the message.
      if (payload.pastedContent.length > 0) {
        const pastedBlock = payload.pastedContent
          .map(p => p.content)
          .join('\n\n');
        text = `${text}\n\n--- Pasted context ---\n${pastedBlock}`;
      }

      runtime.dispatch({
        type: 'send',
        input: text,
        modelId: model,
        attachments: payload.images,
        attachmentPreviews: payload.images.map(f => URL.createObjectURL(f)),
        reasoning: payload.isThinkingEnabled,
      });
    },
    [runtime]
  );
}
