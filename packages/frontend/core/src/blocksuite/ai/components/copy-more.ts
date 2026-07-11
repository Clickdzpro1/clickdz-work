import type { CopilotChatHistoryFragment } from '@affine/graphql';
import { Tooltip } from '@blocksuite/affine/components/tooltip';
import { WithDisposable } from '@blocksuite/affine/global/lit';
import { noop } from '@blocksuite/affine/global/utils';
import { unsafeCSSVarV2 } from '@blocksuite/affine/shared/theme';
import { createButtonPopper } from '@blocksuite/affine/shared/utils';
import type {
  BlockSelection,
  EditorHost,
  TextSelection,
} from '@blocksuite/affine/std';
import type { NotificationService } from '@blocksuite/affine-shared/services';
import { CopyIcon, MoreHorizontalIcon, ResetIcon } from '@blocksuite/icons/lit';
import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { property, query, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import type { ChatAction } from '../_common/chat-actions-handle';
import { copyText } from '../utils/editor-actions';
import { persistGeneratedImage } from './ai-tools/image-artifact';
import { type CdzArtifact } from '../../../modules/ai-artifacts/store';

noop(Tooltip);

export class ChatCopyMore extends WithDisposable(LitElement) {
  static override styles = css`
    .copy-more {
      display: flex;
      gap: 8px;
      height: 36px;
      box-sizing: border-box;
      justify-content: flex-end;
      align-items: center;
      padding: 8px 0;

      div {
        cursor: pointer;
        border-radius: 4px;
      }

      div:hover {
        background-color: var(--affine-hover-color);
      }

      .button {
        display: flex;
        align-items: center;
        justify-content: center;

        svg {
          color: ${unsafeCSSVarV2('icon/primary')};
        }
      }
    }

    .more-menu {
      width: 226px;
      border-radius: 8px;
      background-color: var(--affine-background-overlay-panel-color);
      box-shadow: var(--affine-menu-shadow);
      display: flex;
      flex-direction: column;
      gap: 4px;
      position: absolute;
      z-index: 1;
      user-select: none;

      > div {
        height: 30px;
        display: flex;
        gap: 8px;
        align-items: center;
        cursor: pointer;

        svg {
          margin-left: 12px;
        }
      }

      > div:hover {
        background-color: var(--affine-hover-color);
      }
    }
  `;

  private get _selectionValue() {
    return this.host?.selection.value ?? [];
  }

  private get _currentTextSelection(): TextSelection | undefined {
    return this._selectionValue.find(v => v.type === 'text') as TextSelection;
  }

  private get _currentBlockSelections(): BlockSelection[] | undefined {
    return this._selectionValue.filter(v => v.type === 'block');
  }

  @state()
  private accessor _showMoreMenu = false;

  @query('.button.more')
  private accessor _moreButton!: HTMLDivElement;

  @query('.more-menu')
  private accessor _moreMenu!: HTMLDivElement;

  private _morePopper: ReturnType<typeof createButtonPopper> | null = null;

  @property({ attribute: false })
  accessor host: EditorHost | null | undefined;

  @property({ attribute: false })
  accessor actions: ChatAction[] = [];

  @property({ attribute: false })
  accessor session!: CopilotChatHistoryFragment | null | undefined;

  @property({ attribute: false })
  accessor content!: string;

  @property({ attribute: false })
  accessor messageId: string | undefined = undefined;

  @property({ attribute: false })
  accessor isLast!: boolean;

  @property({ attribute: false })
  accessor withMargin = false;

  @property({ attribute: false })
  accessor retry = () => {};

  @property({ attribute: 'data-testid', reflect: true })
  accessor testId = 'chat-actions';

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  // ---- TTS state ----
  private _ttsAudio: HTMLAudioElement | null = null;
  private _isSpeaking = false;
  private static _autoPlayEnabled = false;

  // Inline SVG icon for speaker (lit-compatible)
  private _SpeakerIcon = (active: boolean) => html`
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
      ${active
        ? html`<path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>`
        : html`<line x1="23" y1="9" x2="17" y2="15"></line>
             <line x1="17" y1="9" x2="23" y2="15"></line>`}
    </svg>
  `;

  // Inline SVG icon for image generation
  private _ImageIcon = () => html`
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <circle cx="8.5" cy="8.5" r="1.5"></circle>
      <polyline points="21 15 16 10 5 21"></polyline>
    </svg>
  `;

  private _stopSpeaking() {
    if (this._ttsAudio) {
      try {
        this._ttsAudio.pause();
        this._ttsAudio.src = '';
      } catch {
        // ignore teardown errors
      }
      this._ttsAudio = null;
    }
    this._isSpeaking = false;
    this.requestUpdate();
  }

  private async _speak(text: string) {
    if (!text) return;
    // toggle: clicking while speaking STOPS playback
    if (this._isSpeaking || this._ttsAudio) {
      this._stopSpeaking();
      return;
    }
    this._isSpeaking = true;
    this.requestUpdate();
    try {
      const res = await fetch('/api/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this._ttsAudio = audio;
      await new Promise<void>((resolve) => {
        audio.onended = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        // manual stop pauses the audio — resolve the wait instead of hanging
        audio.onpause = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.play().catch(() => resolve());
      });
    } catch {
      // TTS failure is non-fatal
    } finally {
      this._isSpeaking = false;
      this._ttsAudio = null;
      this.requestUpdate();
    }
  }

  private _toggleAutoPlay() {
    ChatCopyMore._autoPlayEnabled = !ChatCopyMore._autoPlayEnabled;
    this.requestUpdate();
  }

  // ---- Image Generation state ----
  @state()
  private accessor _isGeneratingImage = false;
  @state()
  private accessor _imageArtifact: CdzArtifact | null = null;

  // ClickDz AI prompt enhancer — transforms simple prompts into high-quality image prompts
  private _enhanceImagePrompt(userPrompt: string): string {
    const enhancerBase = `You are a world-class prompt engineer for DALL-E 3 / GPT-4o image generation. Transform the user's simple description into a highly detailed, visually rich prompt that produces professional, stunning images. Add: artistic style, lighting, composition, mood, color palette, camera angle, and quality keywords. Keep it concise (under 400 chars). Output ONLY the enhanced prompt — no explanations, no markdown.`;
    // For now, use a simple rule-based enhancement + creative expansion
    const clean = userPrompt.trim().replace(/^(generate|create|make|draw|image of|picture of)\s*/i, '');
    if (!clean) return 'Abstract digital art, vibrant colors, flowing geometry, studio lighting, 8k render, professional quality';
    // Rule-based enhancement with art-direction
    const enhancements = [
      'professional photography style',
      'cinematic lighting',
      'highly detailed',
      '8k resolution',
      'masterpiece quality',
      'vivid colors',
      'sharp focus',
    ];
    // If user prompt is short, expand it; otherwise just enhance
    if (clean.length < 60) {
      return `${clean}, ${enhancements.slice(0, 4).join(', ')}, digital art, ultra-detailed, award-winning composition`;
    }
    return `${clean}, ${enhancements.slice(0, 2).join(', ')}`;
  }

  private async _generateImage() {
    if (this._isGeneratingImage) return;
    const prompt = this._enhanceImagePrompt(this.content);
    this._isGeneratingImage = true;
    this.requestUpdate();
    try {
      // ClickDz 1.0: Make-enhanced super prompt -> gpt-image-1
      const res = await fetch('/api/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'clickdz-image-1.0', prompt, n: 1, size: '1024x1024' }),
      });
      if (!res.ok) throw new Error(`Image ${res.status}`);
      const data = await res.json();
      const url = data.url || data.imageUrl || data.data?.[0]?.url || null;
      if (url) {
        this._imageArtifact = persistGeneratedImage({
          url,
          title: 'Generated image',
          prompt: this.content,
          sessionId: this.session?.sessionId,
          messageId: this.messageId,
        });
        this._notifySuccess('Image generated!');
      } else {
        this._notifySuccess('Image generation failed');
      }
    } catch {
      this._notifySuccess('Image generation failed');
    } finally {
      this._isGeneratingImage = false;
      this.requestUpdate();
    }
  }

  private _toggle() {
    this._morePopper?.toggle();
  }

  private readonly _notifySuccess = (title: string) => {
    this.notificationService.notify({
      title: title,
      accent: 'success',
      onClose: function (): void {},
    });
  };

  protected override updated(changed: PropertyValues): void {
    // Auto-play TTS when new assistant message arrives
    if ((changed.has('isLast') || changed.has('content')) && this.isLast && this.content && ChatCopyMore._autoPlayEnabled && !this._isSpeaking) {
      const oldContent = changed.get('content') as string | undefined;
      if (oldContent !== this.content) {
        this._speak(this.content);
      }
    }
    if (changed.has('isLast')) {
      if (this.isLast) {
        this._morePopper?.dispose();
        this._morePopper = null;
      } else if (!this._morePopper) {
        this._morePopper = createButtonPopper({
          reference: this._moreButton,
          popperElement: this._moreMenu,
          stateUpdated: ({ display }) =>
            (this._showMoreMenu = display === 'show'),
          mainAxis: 0,
          crossAxis: -100,
        });
        this.disposables.add(() => this._morePopper?.dispose());
      }
    }
  }

  override render() {
    const { host, content, isLast, messageId, actions } = this;
    const showMoreIcon = !isLast && actions.length > 0;
    return html`<style>
        .copy-more {
          margin-top: ${this.withMargin ? '8px' : '0px'};
          margin-bottom: ${this.withMargin ? '12px' : '0px'};
        }
        .more-menu {
          padding: ${this._showMoreMenu ? '8px' : '0px'};
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes clickdz-speak-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
      </style>
      <div class="copy-more">
        ${content
          ? html`<div
              class="button copy"
              @click=${async () => {
                const success = await copyText(content);
                if (success) {
                  this._notifySuccess('Copied to clipboard');
                }
              }}
              data-testid="action-copy-button"
            >
              ${CopyIcon({ width: '20px', height: '20px' })}
              <affine-tooltip>Copy</affine-tooltip>
            </div>`
          : nothing}
        ${isLast
          ? html`<div
              class="button retry"
              @click=${() => this.retry()}
              data-testid="action-retry-button"
            >
              ${ResetIcon({ width: '20px', height: '20px' })}
              <affine-tooltip .autoShift=${true}>Retry</affine-tooltip>
            </div>`
          : nothing}
        ${content
          ? html`<div
                class="button speak"
                @click=${() => this._speak(content)}
                data-testid="action-speak-button"
                style="${this._isSpeaking ? 'color: var(--affine-primary-color); animation: clickdz-speak-pulse 1.2s ease-in-out infinite;' : ''}"
              >
                ${this._isSpeaking
                  ? html`<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`
                  : this._SpeakerIcon(false)}
                <affine-tooltip>${this._isSpeaking ? 'Stop' : 'Read aloud'}</affine-tooltip>
              </div>
              <div
                class="button generate-image"
                @click=${() => this._generateImage()}
                data-testid="action-generate-image-button"
                style="${this._isGeneratingImage ? 'color: var(--affine-primary-color);' : ''}"
              >
                ${this._isGeneratingImage
                  ? html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s linear infinite;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`
                  : this._ImageIcon()}
                <affine-tooltip>Generate image from this message</affine-tooltip>
              </div>
              ${isLast
                ? html`<div
                      class="button auto-play"
                      @click=${() => this._toggleAutoPlay()}
                      data-testid="action-auto-play-button"
                      style="${ChatCopyMore._autoPlayEnabled ? 'color: var(--affine-primary-color);' : ''}"
                    >
                      ${ChatCopyMore._autoPlayEnabled
                        ? html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path><circle cx="20" cy="4" r="3" fill="currentColor" stroke="none"></circle></svg>`
                        : html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`}
                      <affine-tooltip>${ChatCopyMore._autoPlayEnabled ? 'Auto-play ON — new messages will be spoken' : 'Auto-play OFF — click to enable'}</affine-tooltip>
                    </div>`
                : nothing}`
          : nothing}

      ${this._imageArtifact
        ? html`<image-artifact-host
              .artifact=${this._imageArtifact}
              .onRegenerate=${(prompt: string) => {
                this.content = prompt;
                this._generateImage();
              }}
              .autoOpenPanel=${true}
            ></image-artifact-host>`
        : nothing}
        ${showMoreIcon && host
          ? html`<div
              class="button more"
              data-testid="action-more-button"
              @click=${this._toggle}
            >
              ${MoreHorizontalIcon({ width: '20px', height: '20px' })}
            </div> `
          : nothing}
      </div>

      <div class="more-menu">
        ${this._showMoreMenu && host
          ? repeat(
              actions.filter(action => action.showWhen(host)),
              action => action.title,
              action => {
                const currentSelections = {
                  text: this._currentTextSelection,
                  blocks: this._currentBlockSelections,
                };
                return html`<div
                  @click=${async () => {
                    const sessionId = this.session?.sessionId;
                    const success = await action.handler(
                      host,
                      content,
                      currentSelections,
                      sessionId,
                      messageId
                    );

                    if (success) {
                      this._notifySuccess(action.toast);
                    }
                  }}
                >
                  ${action.icon}
                  <div>${action.title}</div>
                </div>`;
              }
            )
          : nothing}
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-copy-more': ChatCopyMore;
  }
}
