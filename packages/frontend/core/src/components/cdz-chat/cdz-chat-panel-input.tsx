"use client";

/**
 * CDZ Chat — host wiring for the main chat input (Phase 4: feature bridge).
 *
 * `CdzChatPanelInput` is the React wrapper that mounts the Claude-style input
 * PLUS the CDZ Workers picker and the Council trigger into the AI chat host
 * page. It bridges everything to the existing `AIChatRuntime` + `AIModelService`
 * via the dispatch hook, so all ClickDz features (Plan mode, Council, Workers)
 * flow through the same server-side pipeline the Lit input used.
 *
 * Layout:
 *   ┌─────────────────────────────────────────┐
 *   │ [🧰 Workers chip] [Council toggle]       │  ← toolbar row (Phase 4)
 *   ├─────────────────────────────────────────┤
 *   │ (active worker chip if selected)         │
 *   ├─────────────────────────────────────────┤
 *   │ ClaudeChatInput (model picker + send)    │  ← Phase 3
 *   └─────────────────────────────────────────┘
 *
 * On send: the dispatch hook prepends the active worker's system prompt,
 * routes to the worker's recommended model (unless overridden), appends pasted
 * context, then `runtime.dispatch({ type: 'send', ... })`.
 */
import { ClaudeChatInput } from './claude-style-chat-input';
import type { AttachedFile, PastedContent } from './claude-style-chat-input';
import { cn } from './cn';
import { CdzCouncilTrigger } from './cdz-council-trigger';
import { useCdzChatDispatch, type CdzActiveWorker } from './cdz-chat-dispatch';
import { ensureCdzChatStyles } from './cdz-styles';
import { useCdzModelsFromService } from './use-cdz-models-from-service';
import {
  CdzWorkersPicker,
  type CdzSelectedWorker,
} from './cdz-workers-picker';
import { Icons } from './icons';
import type { AIChatRuntime } from '@affine/core/blocksuite/ai';
import { useCallback, useEffect, useState } from 'react';

export interface CdzChatPanelInputProps {
  /** The AI chat runtime from the host page. */
  runtime: AIChatRuntime;
  /** The currently-active session id (for model/council bookkeeping). */
  sessionId?: string;
  /** Override placeholder. */
  placeholder?: string;
}

export function CdzChatPanelInput({
  runtime,
  sessionId,
  placeholder,
}: CdzChatPanelInputProps) {
  const { models, selectedModelId, setSelectedModelId } =
    useCdzModelsFromService(sessionId);
  const dispatch = useCdzChatDispatch(runtime);

  const [workersPickerOpen, setWorkersPickerOpen] = useState(false);
  const [activeWorker, setActiveWorker] = useState<CdzActiveWorker | null>(null);

  useEffect(() => {
    ensureCdzChatStyles();
  }, []);

  const handleSelectWorker = useCallback(
    (worker: CdzSelectedWorker) => {
      setActiveWorker(worker);
      setWorkersPickerOpen(false);
    },
    []
  );

  const handleClearWorker = useCallback(() => {
    setActiveWorker(null);
  }, []);

  const handleSendMessage = useCallback(
    (data: {
      message: string;
      files: AttachedFile[];
      pastedContent: PastedContent[];
      model: string;
      isThinkingEnabled: boolean;
    }) => {
      // Extended thinking + cdz-ultra -> cdz-sage (Opus 4.8). Council is
      // preserved as-is (cdz-council) — thinking is orthogonal.
      const effectiveModel =
        data.isThinkingEnabled && data.model === 'cdz-ultra'
          ? 'cdz-sage'
          : data.model;

      // Keep the model service in sync so the rest of the app sees the pick.
      setSelectedModelId(effectiveModel);

      // Dispatch through the runtime with worker injection. The dispatch hook
      // is async (it may fetch the worker prompt) — fire-and-forget; the
      // runtime handles streaming/errors.
      void dispatch(
        {
          text: data.message,
          model: effectiveModel,
          images: data.files
            .filter(f => f.type.startsWith('image/'))
            .map(f => f.file),
          isThinkingEnabled: data.isThinkingEnabled,
          pastedContent: data.pastedContent,
        },
        activeWorker
      );
    },
    [activeWorker, dispatch, setSelectedModelId]
  );

  return (
    <div className={cn('cdz-chat-scope flex flex-col gap-2 w-full')}>
      {/* Toolbar row: Workers + Council */}
      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={() => setWorkersPickerOpen(true)}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-xl text-xs font-medium transition-all duration-200 active:scale-95',
            activeWorker
              ? 'bg-accent/15 text-accent border border-accent/40'
              : 'text-text-400 hover:text-text-200 hover:bg-bg-200 border border-transparent'
          )}
          aria-label="Open CDZ Workers picker"
          title="Browse 502 specialist skills"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M3 7h18M3 12h18M3 17h18" strokeLinecap="round" />
          </svg>
          <span>{activeWorker ? activeWorker.name : 'Workers'}</span>
        </button>

        <CdzCouncilTrigger />

        {activeWorker && (
          <button
            type="button"
            onClick={handleClearWorker}
            className="inline-flex items-center gap-1 h-8 px-2 rounded-lg text-xs text-text-400 hover:text-text-200 hover:bg-bg-200 transition-colors"
            aria-label={`Clear active worker ${activeWorker.name}`}
            title="Clear worker"
          >
            <Icons.X className="w-3 h-3" />
            clear
          </button>
        )}
      </div>

      {/* Active worker chip (shown above the input when a worker is selected) */}
      {activeWorker && (
        <div className="px-1 -mb-1">
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] bg-accent/10 text-accent border border-accent/30">
            <Icons.Thinking className="w-3 h-3" />
            Answering as <strong className="font-semibold">{activeWorker.name}</strong>
            <span className="text-accent/70">· {activeWorker.category}</span>
          </span>
        </div>
      )}

      {/* The main Claude-style input */}
      <ClaudeChatInput
        models={models}
        defaultModelId={selectedModelId ?? 'cdz-ultra'}
        onSendMessage={handleSendMessage}
        placeholder={placeholder}
      />

      {/* Workers picker overlay */}
      <CdzWorkersPicker
        open={workersPickerOpen}
        onClose={() => setWorkersPickerOpen(false)}
        onSelect={handleSelectWorker}
        activeWorkerId={activeWorker?.id ?? null}
      />
    </div>
  );
}

export default CdzChatPanelInput;
