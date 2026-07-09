import { WithDisposable } from '@blocksuite/affine/global/lit';
import { ShadowlessElement } from '@blocksuite/affine/std';
import { css, html, nothing } from 'lit';
import { property } from 'lit/decorators.js';

import { stripCdzDirectives } from '../../_common/cdz-directives';
import { type ChatMessage } from '../../components/ai-chat-messages';

export class ChatMessageUser extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    chat-message-user {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }

    .chat-message-user {
      display: flex;
      flex-direction: column;
      max-width: calc(100% - 58px);
    }

    .chat-content-images {
      display: flex;
      justify-content: flex-end;

      .images-row {
        margin-left: auto;
      }
    }

    .text-content-wrapper {
      align-self: flex-end;
    }

    /* compact chips standing in for hidden directives (worker / plan) */
    .cdz-mode-badges {
      display: flex;
      justify-content: flex-end;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 4px;
    }
    .cdz-mode-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 600;
      line-height: 18px;
      padding: 0 8px;
      border-radius: 999px;
      color: var(--affine-v2-text-secondary);
      background: var(--affine-v2-layer-background-hoverOverlay);
      border: 0.5px solid var(--affine-v2-layer-insideBorder-border);
    }
  `;

  @property({ attribute: false })
  accessor item!: ChatMessage;

  @property({ attribute: 'data-testid', reflect: true })
  accessor testId = 'chat-message-user';

  renderContent() {
    const { item } = this;
    // hidden directives (worker skills, plan mode) never render — show a
    // compact mode chip instead of the raw instruction text
    const { text, badges } = stripCdzDirectives(item.content);

    return html`
      ${item.attachments
        ? html`<chat-content-images
            class="chat-content-images"
            .images=${item.attachments}
          ></chat-content-images>`
        : nothing}
      ${badges.length
        ? html`<div class="cdz-mode-badges">
            ${badges.map(
              badge =>
                html`<span class="cdz-mode-badge"
                  >${badge.icon ?? ''} ${badge.label ?? badge.kind}</span
                >`
            )}
          </div>`
        : nothing}
      <div
        class="text-content-wrapper"
        data-test-id="chat-content-user-text"
        style="max-width: 100%;"
      >
        <chat-content-pure-text .text=${text}></chat-content-pure-text>
      </div>
    `;
  }

  protected override render() {
    return html` <div class="chat-message-user">${this.renderContent()}</div> `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-message-user': ChatMessageUser;
  }
}
