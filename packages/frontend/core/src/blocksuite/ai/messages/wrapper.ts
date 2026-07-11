import type { EditorHost } from '@blocksuite/affine/std';
import { css, html, LitElement, nothing } from 'lit';
import { property } from 'lit/decorators.js';

import { getAIPanelWidget } from '../utils/ai-widgets';
import { preprocessHtml } from '../utils/html';
import type { AffineAIPanelWidgetConfig } from '../widgets/ai-panel/type';

type AIAnswerWrapperOptions = {
  height: number;
};

export class AIAnswerWrapper extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      box-sizing: border-box;
      border-radius: 12px;
      border: 1px solid var(--affine-border-color);
      box-shadow: var(--affine-shadow-1);
      background: var(--affine-background-secondary-color);
      overflow: hidden;
    }

    ::slotted(.ai-answer-iframe) {
      width: 100%;
      height: 100%;
      border: none;
    }

    ::slotted(.ai-answer-image) {
      width: 100%;
      height: 100%;
    }
  `;

  @property({ attribute: false })
  accessor options: AIAnswerWrapperOptions | undefined = undefined;

  protected override render() {
    return html`<style>
        :host {
          height: ${this.options?.height
            ? this.options?.height + 'px'
            : '100%'};
        }
      </style>
      <slot></slot> `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ai-answer-wrapper': AIAnswerWrapper;
  }
}

export const createIframeRenderer: (
  host: EditorHost,
  options?: AIAnswerWrapperOptions
) => AffineAIPanelWidgetConfig['answerRenderer'] = (host, options) => {
  return (answer, state) => {
    if (state === 'generating') {
      // Elegant skeleton in the panel — not empty black void
      return html`<ai-answer-wrapper .options=${options}>
        <div
          class="ai-answer-iframe"
          style="display:flex;align-items:center;justify-content:center;height:100%;background:var(--affine-background-secondary-color);"
        >
          <div style="text-align:center;opacity:0.7;">
            <div
              style="width:48px;height:48px;margin:0 auto 12px;border-radius:12px;border:2px solid var(--affine-primary-color);border-top-color:transparent;animation:cdz-spin 0.8s linear infinite;"
            ></div>
            <style>
              @keyframes cdz-spin {
                to {
                  transform: rotate(360deg);
                }
              }
            </style>
            <div style="font-size:13px;color:var(--affine-text-secondary-color);">
              Building preview…
            </div>
          </div>
        </div>
      </ai-answer-wrapper>`;
    }

    if (state !== 'finished' && state !== 'error') {
      return nothing;
    }

    const template = html`<iframe
      class="ai-answer-iframe"
      sandbox="allow-scripts"
      scrolling="no"
      .srcdoc=${preprocessHtml(answer)}
    >
    </iframe>`;
    return html`<ai-answer-wrapper .options=${options}
      >${template}</ai-answer-wrapper
    >`;
  };
};

export const createImageRenderer: (
  host: EditorHost,
  options?: AIAnswerWrapperOptions
) => AffineAIPanelWidgetConfig['answerRenderer'] = (host, options) => {
  return (answer, state) => {
    if (state === 'generating') {
      // Show skeleton card instead of nothing + floating empty modal
      const panel = getAIPanelWidget(host);
      panel.generatingElement?.updateLoadingProgress(2);
      return html`<ai-answer-wrapper .options=${options}>
        <div
          class="ai-answer-image"
          style="display:flex;align-items:center;justify-content:center;height:100%;background:linear-gradient(135deg,#111 0%,#1a1a1a 100%);"
        >
          <div style="text-align:center;">
            <div
              style="width:64px;height:64px;margin:0 auto 12px;border-radius:16px;background:rgba(255,255,255,0.06);animation:cdz-pulse 1.4s ease-in-out infinite;"
            ></div>
            <style>
              @keyframes cdz-pulse {
                0%,
                100% {
                  opacity: 0.4;
                }
                50% {
                  opacity: 1;
                }
              }
            </style>
            <div style="font-size:13px;color:var(--affine-text-secondary-color);">
              Generating image…
            </div>
          </div>
        </div>
      </ai-answer-wrapper>`;
    }

    if (state !== 'finished' && state !== 'error') {
      return nothing;
    }

    const template = html`<style>
        .ai-answer-image {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #0a0a0a;
        }
        .ai-answer-image img {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }
      </style>
      <div class="ai-answer-image" data-testid="ai-answer-image">
        <img src=${answer} alt="AI generated" />
      </div>`;

    return html`<ai-answer-wrapper .options=${options}
      >${template}</ai-answer-wrapper
    >`;
  };
};
