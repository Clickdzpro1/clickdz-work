import { WithDisposable } from '@blocksuite/affine/global/lit';
import { ShadowlessElement } from '@blocksuite/affine/std';
import { css, html, nothing } from 'lit';
import { property } from 'lit/decorators.js';

import { type ChatMessage } from '../../components/ai-chat-messages';

// matches the council briefing injected by the chat input so the raw
// instructions never render in the user's bubble — only a sleek badge
const COUNCIL_BRIEFING_RE =
  /^\[ClickDz Council — members: ([^\]\n]+)\]\n[\s\S]*?\n\nQuestion: ([\s\S]*)$/;

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

    .council-briefing-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      align-self: flex-end;
      margin-bottom: 4px;
      padding: 2px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      line-height: 18px;
      color: #6e56cf;
      background: color-mix(in srgb, #6e56cf 14%, transparent);
      border: 1px solid color-mix(in srgb, #6e56cf 35%, transparent);
      animation: council-chip-in 0.25s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes council-chip-in {
      from {
        opacity: 0;
        transform: translateY(-3px) scale(0.96);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
  `;

  @property({ attribute: false })
  accessor item!: ChatMessage;

  @property({ attribute: 'data-testid', reflect: true })
  accessor testId = 'chat-message-user';

  renderContent() {
    const { item } = this;
    const councilMatch = item.content.match(COUNCIL_BRIEFING_RE);

    return html`
      ${item.attachments
        ? html`<chat-content-images
            class="chat-content-images"
            .images=${item.attachments}
          ></chat-content-images>`
        : nothing}
      ${councilMatch
        ? html`<div
            class="council-briefing-chip"
            title="ClickDz Council briefing applied — members: ${councilMatch[1]}"
          >
            <span>🏛️</span>
            <span>${councilMatch[1]}</span>
          </div>`
        : nothing}
      <div
        class="text-content-wrapper"
        data-test-id="chat-content-user-text"
        style="max-width: 100%;"
      >
        <chat-content-pure-text
          .text=${councilMatch ? councilMatch[2] : item.content}
        ></chat-content-pure-text>
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
