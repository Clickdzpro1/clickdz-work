import { WithDisposable } from '@blocksuite/affine/global/lit';
import { css, html, LitElement } from 'lit';
import { property } from 'lit/decorators.js';

/**
 * Compact "thinking" indicator shown for a pending assistant turn BEFORE the
 * first token (or first reasoning delta) arrives.
 *
 * This replaces the old `cdz-pulse-ticker`-driven card, which faked reasoning
 * by streaming canned French phrases fetched from `/api/v1/ai/pulse`. Real
 * reasoning now renders in <chat-content-reasoning> once the model emits it, so
 * this element only needs to bridge the brief gap until the stream starts: a
 * small pulsing brand dot + a single shimmering "Réflexion…" line. No network,
 * no rotating copy, nothing dated.
 */
export class AILoading extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
    }
    .cdz-thinking {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 4px 0;
      color: var(--affine-text-secondary-color);
      font-family: Inter, system-ui, -apple-system, 'Segoe UI', Roboto,
        Helvetica, Arial, sans-serif;
      font-size: 13px;
      font-weight: 500;
      line-height: 20px;
    }
    .dot {
      flex: 0 0 9px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background-image: linear-gradient(135deg, #5b8cff, #a06bff);
      animation: cdz-thinking-pulse 1.4s ease-in-out infinite;
    }
    /* Shimmer sweep across the single line — quiet, brand-tinted. */
    .label {
      background: linear-gradient(
        90deg,
        var(--affine-text-secondary-color) 0%,
        var(--affine-text-primary-color) 20%,
        var(--affine-text-secondary-color) 40%
      );
      background-size: 200% 100%;
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      animation: cdz-thinking-shimmer 2s linear infinite;
    }
    @keyframes cdz-thinking-pulse {
      0%,
      100% {
        transform: scale(0.82);
        box-shadow: 0 0 0 0 rgba(91, 140, 255, 0.5);
        opacity: 0.85;
      }
      50% {
        transform: scale(1.12);
        box-shadow: 0 0 10px 3px rgba(160, 107, 255, 0.4);
        opacity: 1;
      }
    }
    @keyframes cdz-thinking-shimmer {
      from {
        background-position: 200% 0;
      }
      to {
        background-position: -200% 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .dot {
        animation: none;
        opacity: 0.9;
      }
      .label {
        animation: none;
        -webkit-text-fill-color: var(--affine-text-secondary-color);
      }
    }
  `;

  @property({ attribute: false })
  accessor stopGenerating: (() => void) | undefined;

  // Retained for backward compatibility with call sites that still pass the
  // originating user prompt; no longer used for content (the fake reasoning
  // ticker it fed has been removed).
  @property({ attribute: false })
  accessor task = '';

  @property({ attribute: 'data-testid', reflect: true })
  accessor testId = 'ai-loading';

  override render() {
    return html`<div class="cdz-thinking" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      <span class="label">Réflexion…</span>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ai-loading': AILoading;
  }
}
