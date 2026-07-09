"use client";

/**
 * CDZ Council trigger — a toggle button for the 3-vendor fan-out mode.
 *
 * Council is a REAL backend model: selecting `cdz-council` tells the CDZ AI
 * server (cdz-ai/index.mjs runCouncil) to fan the prompt out to Claude + GPT
 * + Gemini in parallel and synthesize the result. The client only needs to
 * set the model id — no client-side member picker (membership is fixed
 * server-side).
 *
 * This button calls `AIModelService.setCouncilMode(on)`, which remembers the
 * user's pre-council model and restores it when toggled off. It renders as a
 * pill in the chat toolbar with a triple-orb glyph; when active it shows the
 * accent color + a "Council on" label.
 */
import { AIModelService } from '@affine/core/modules/ai-button/services/models';
import { useService } from '@toeverything/infra';
import { cn } from './cn';
import { ensureCdzChatStyles } from './cdz-styles';
import { useEffect, useState } from 'react';

export interface CdzCouncilTriggerProps {
  /** Optional className for layout integration. */
  className?: string;
}

export function CdzCouncilTrigger({ className }: CdzCouncilTriggerProps) {
  const aiModelService = useService(AIModelService);
  const [active, setActive] = useState(false);

  useEffect(() => {
    ensureCdzChatStyles();
    // Reflect the live model id into local state (council == cdz-council).
    const update = () =>
      setActive(aiModelService.modelId.value === 'cdz-council');
    update();
    // Poll-free: re-check on each render is enough since the signal drives
    // re-render via useService; but also subscribe for immediacy.
    const sub = aiModelService.modelId.subscribe(update);
    return () => sub();
  }, [aiModelService]);

  const toggle = () => {
    const next = !active;
    aiModelService.setCouncilMode(next);
    setActive(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={active}
      aria-label={active ? 'Disable Council mode' : 'Enable Council mode — 3-vendor fan-out'}
      title={
        active
          ? 'Council mode is on (3-vendor fan-out + synthesis)'
          : 'Enable Council mode — 3-vendor fan-out + synthesis'
      }
      className={cn(
        'cdz-chat-scope inline-flex items-center gap-1.5 h-8 px-3 rounded-xl text-xs font-medium transition-all duration-200 active:scale-95',
        active
          ? 'bg-accent/15 text-accent border border-accent/40'
          : 'text-text-400 hover:text-text-200 hover:bg-bg-200 border border-transparent',
        className
      )}
    >
      {/* Triple-orb council glyph */}
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
        className={cn(active && 'animate-fade-in')}
      >
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="12" r="3" />
        <circle cx="12" cy="6" r="3" />
        <path d="M9 12h6M8 9l8 6M8 15l8-6" opacity="0.4" />
      </svg>
      <span>{active ? 'Council on' : 'Council'}</span>
    </button>
  );
}

export default CdzCouncilTrigger;
