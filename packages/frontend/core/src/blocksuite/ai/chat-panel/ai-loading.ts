import { WithDisposable } from '@blocksuite/affine/global/lit';
import { css, html, LitElement } from 'lit';
import { property } from 'lit/decorators.js';

// Side-effect import: registers <cdz-pulse-ticker> (reasoning-pulse animation
// shown beneath the "working" tip while the chat answer is pending).
import '../components/cdz-pulse-ticker';

export class AILoading extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
    }
    .cdz-chat-pulse {
      display: block;
      width: min(420px, 100%);
      margin-top: 8px;
    }
    .generating-tip {
      position: relative;
      display: flex;
      align-items: center;
      gap: 11px;
      overflow: hidden;
      width: min(420px, 100%);
      box-sizing: border-box;
      padding: 10px 12px 13px;
      border: 1px solid color-mix(in srgb, #2f7bff 28%, transparent);
      border-radius: 12px;
      color: var(--affine-v2-text-primary);
      background: color-mix(
        in srgb,
        #2f7bff 6%,
        var(--affine-v2-layer-background-primary)
      );
    }
    .orb {
      width: 22px;
      height: 22px;
      flex: 0 0 22px;
      border-radius: 7px;
      background: conic-gradient(
        from 45deg,
        #2f7bff,
        #8b5cf6,
        #10a37f,
        #2f7bff
      );
      box-shadow: 0 0 18px color-mix(in srgb, #2f7bff 42%, transparent);
      animation: cdz-orb 1.35s ease-in-out infinite;
    }
    .text {
      font-family: Inter, system-ui, sans-serif;
      font-size: 13px;
      font-weight: 650;
      line-height: 20px;
    }
    .dots::after {
      content: '';
      animation: cdz-dots 1.2s steps(4, end) infinite;
    }
    .progress {
      position: absolute;
      right: 0;
      bottom: 0;
      left: 0;
      height: 3px;
      background: color-mix(in srgb, #2f7bff 12%, transparent);
    }
    .progress::after {
      content: '';
      display: block;
      width: 42%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #2f7bff, #8b5cf6, #10a37f);
      animation: cdz-progress 1.25s ease-in-out infinite;
    }
    @keyframes cdz-orb {
      0%,
      100% {
        transform: scale(0.88) rotate(-8deg);
        opacity: 0.72;
      }
      50% {
        transform: scale(1.06) rotate(8deg);
        opacity: 1;
      }
    }
    @keyframes cdz-progress {
      from {
        transform: translateX(-110%);
      }
      to {
        transform: translateX(340%);
      }
    }
    @keyframes cdz-dots {
      0% {
        content: '';
      }
      25% {
        content: '.';
      }
      50% {
        content: '..';
      }
      75%,
      100% {
        content: '...';
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .orb,
      .progress::after,
      .dots::after {
        animation: none;
      }
      .dots::after {
        content: '...';
      }
    }
  `;

  @property({ attribute: false })
  accessor stopGenerating!: () => void;

  // First ~100 chars of the user's message driving this pending answer, passed
  // to the reasoning-pulse ticker as its `task` (empty → generic pulse lines).
  @property({ attribute: false })
  accessor task = '';

  @property({ attribute: 'data-testid', reflect: true })
  accessor testId = 'ai-loading';

  override render() {
    return html`<div class="generating-tip">
        <span class="orb" aria-hidden="true"></span>
        <span class="text">ClickDz AI is working<span class="dots"></span></span>
        <span class="progress" aria-hidden="true"></span>
      </div>
      <cdz-pulse-ticker
        class="cdz-chat-pulse"
        .task=${this.task}
        surface="chat"
        ?active=${true}
      ></cdz-pulse-ticker>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ai-loading': AILoading;
  }
}
