import type { AIToolsConfigService } from '@affine/core/modules/ai-button';
import type { PeekViewService } from '@affine/core/modules/peek-view';
import type { AppThemeService } from '@affine/core/modules/theme';
import type { CopilotChatHistoryFragment } from '@affine/graphql';
import { WithDisposable } from '@blocksuite/affine/global/lit';
import {
  DocModeProvider,
  type FeatureFlagService,
  type NotificationService,
} from '@blocksuite/affine/shared/services';
import { type EditorHost, ShadowlessElement } from '@blocksuite/affine/std';
import type { BaseSelection, ExtensionType } from '@blocksuite/affine/store';
import { ArrowDownBigIcon as ArrowDownIcon } from '@blocksuite/icons/lit';
import type { Signal } from '@preact/signals-core';
import { css, html, nothing, type PropertyValues } from 'lit';
import { property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { debounce, throttle } from 'lodash-es';

import { CLICKDZ_LOGO } from '../../_common/cdz-assets';
import {
  AIAppEvents,
  type AIError,
  GeneralNetworkError,
  UnauthorizedError,
} from '../../provider';
import type { AIChatRuntime, AIChatSnapshot } from '../../runtime/chat';
import type { DocDisplayConfig } from '../ai-chat-chips';
import { type ChatContextValue } from '../ai-chat-content/type';
import type { AIReasoningConfig } from '../ai-chat-input';
import {
  AI_CHAT_AUTO_SCROLL_PAUSE_EVENT,
  AI_CHAT_AUTO_SCROLL_RESUME_THRESHOLD,
  AI_CHAT_SCROLL_DOWN_INDICATOR_THRESHOLD,
} from './auto-scroll';
import { type HistoryMessage, isChatAction, isChatMessage } from './type';

export class AIChatMessages extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    ai-chat-messages {
      position: relative;
    }

    .chat-panel-messages-container {
      display: flex;
      flex-direction: column;
      gap: 28px;
      min-height: 100%;
      position: relative;
      line-height: 1.6;
    }

    chat-panel-assistant-message,
    chat-panel-user-message {
      display: contents;
    }

    /*
     * Message entrance motion.
     *
     * The <chat-message-*> hosts are shadowless (light DOM) with 'display:
     * contents' semantics, so the transform is applied to their real content
     * boxes instead of the host. The parent stamps [data-cdz-enter] on a
     * message host ONLY the render cycle it is first appended (see the key
     * diff in render()); it is never set on the initial history batch, so a
     * freshly-opened conversation paints instantly with no motion. Because the
     * flag rides a per-message key that stays stable while tokens stream, the
     * entrance fires exactly once per message and streaming never re-triggers
     * it. Assistant boxes lag the user bubble slightly for a conversational
     * call-and-response rhythm.
     */
    chat-message-user[data-cdz-enter] .chat-message-user {
      animation: cdz-msg-in 220ms cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    chat-message-assistant[data-cdz-enter] .user-info,
    chat-message-assistant[data-cdz-enter] .item-wrapper {
      animation: cdz-msg-in 240ms cubic-bezier(0.16, 1, 0.3, 1) both;
      animation-delay: 60ms;
    }
    @keyframes cdz-msg-in {
      from {
        opacity: 0;
        transform: translateY(8px) scale(0.99);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      chat-message-user[data-cdz-enter] .chat-message-user,
      chat-message-assistant[data-cdz-enter] .user-info,
      chat-message-assistant[data-cdz-enter] .item-wrapper {
        animation: none;
      }
    }

    .user-info {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 4px;
      color: var(--affine-text-primary-color);
      font-size: var(--affine-font-sm);
      font-weight: 500;
      user-select: none;
    }

    /* Minimal empty state: a small centered logo and a single greeting line,
       with generous breathing room — no quick-action cards, no onboarding
       list, in the spirit of a normal AI chatbot. */
    .messages-placeholder {
      width: 100%;
      position: absolute;
      z-index: 1;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
    }
    .cdz-ready-logo-wrap {
      position: relative;
      width: 76px;
      height: 76px;
      display: grid;
      place-items: center;
      animation: cdz-logo-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    .cdz-ready-logo {
      width: 60px;
      height: 60px;
      border-radius: 16px;
      position: relative;
      z-index: 2;
      box-shadow: 0 12px 34px rgba(47, 123, 255, 0.45);
      animation: cdz-logo-float 4s ease-in-out infinite;
    }
    .cdz-ready-logo.loading {
      animation: cdz-logo-spin 1.1s linear infinite;
    }
    .cdz-ready-halo {
      position: absolute;
      inset: -6px;
      border-radius: 22px;
      background: radial-gradient(
        circle,
        rgba(47, 123, 255, 0.45),
        transparent 70%
      );
      filter: blur(10px);
      z-index: 1;
      animation: cdz-halo-pulse 3s ease-in-out infinite;
    }
    @keyframes cdz-logo-float {
      50% {
        transform: translateY(-7px);
      }
    }
    @keyframes cdz-logo-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @keyframes cdz-halo-pulse {
      0%,
      100% {
        opacity: 0.5;
        transform: scale(0.92);
      }
      50% {
        opacity: 0.9;
        transform: scale(1.08);
      }
    }
    @keyframes cdz-logo-in {
      from {
        opacity: 0;
        transform: scale(0.6);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .cdz-ready-logo,
      .cdz-ready-halo,
      .cdz-ready-logo-wrap {
        animation: none;
      }
    }
    .independent-mode .messages-placeholder {
      position: static;
      transform: none;
    }

    .messages-placeholder-title {
      font-size: 17px;
      font-weight: 500;
      line-height: 1.5;
      text-align: center;
      color: var(--affine-text-primary-color);
    }

    .messages-placeholder-title[data-loading='true'] {
      font-size: var(--affine-font-sm);
      color: var(--affine-text-secondary-color);
    }

    .down-indicator {
      position: fixed;
      left: 50%;
      transform: translate(-50%, 0);
      bottom: 166px;
      z-index: 1;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      border: 0.5px solid var(--affine-border-color);
      background-color: var(--affine-background-primary-color);
      box-shadow: var(--affine-shadow-2);
      display: flex;
      justify-content: center;
      align-items: center;
      cursor: pointer;
    }
  `;

  @state()
  accessor _selectionValue: BaseSelection[] = [];

  @state()
  accessor canScrollDown = false;

  @state()
  accessor avatarUrl = '';

  @property({ attribute: false })
  accessor independentMode: boolean | undefined;

  @property({ attribute: false })
  accessor messages!: HistoryMessage[];

  @property({ attribute: false })
  accessor host: EditorHost | null | undefined;

  @property({ attribute: false })
  accessor workspaceId!: string;

  @property({ attribute: false })
  accessor docId: string | undefined;

  @property({ attribute: false })
  accessor isHistoryLoading!: boolean;

  @property({ attribute: false })
  accessor chatContextValue!: ChatContextValue;

  @property({ attribute: false })
  accessor session!: CopilotChatHistoryFragment | null | undefined;

  @property({ attribute: false })
  accessor runtime: AIChatRuntime | null | undefined;

  @property({ attribute: false })
  accessor runtimeSnapshot: AIChatSnapshot | null | undefined;

  @property({ attribute: false })
  accessor updateContext!: (context: Partial<ChatContextValue>) => void;

  @property({ attribute: false })
  accessor extensions!: ExtensionType[];

  @property({ attribute: false })
  accessor affineFeatureFlagService!: FeatureFlagService;

  @property({ attribute: false })
  accessor affineThemeService!: AppThemeService;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor reasoningConfig!: AIReasoningConfig;

  @property({ attribute: false })
  accessor width: Signal<number | undefined> | undefined;

  @property({ attribute: false })
  accessor docDisplayService!: DocDisplayConfig;

  @property({ attribute: false })
  accessor aiToolsConfigService!: AIToolsConfigService;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  @property({ attribute: false })
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  @property({
    type: String,
    attribute: 'data-testid',
    reflect: true,
  })
  accessor testId = 'chat-panel-messages';

  private _autoScrollEnabled = true;

  private _lastObservedScrollTop = 0;

  // Keys rendered in prior cycles + a first-paint guard, used to animate ONLY
  // newly appended messages (not the initial history batch). See render().
  private _seenMessageKeys = new Set<string>();

  private _hasRenderedMessages = false;

  // Keys that (ever) entered — persist so [data-cdz-enter] survives the
  // streaming re-renders and the one-shot entrance animation gets to commit.
  private _enteringKeys = new Set<string>();

  // A single user turn appends at most a user + assistant message; a larger
  // batch of new keys means a history/session load, which should not animate.
  private static readonly ENTRANCE_BATCH_LIMIT = 2;

  // Live reduced-motion preference so scrollToEnd() can pick instant vs. smooth
  // scrolling (CSS @media can't reach the scrollTo behavior option). Queried on
  // demand so an OS-level toggle mid-session is honored; guarded for non-DOM
  // (SSR/test) environments where matchMedia is unavailable.
  private get _prefersReducedMotion() {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  private get chatStatus() {
    return this.runtimeSnapshot?.status ?? this.chatContextValue.status;
  }

  private get chatError(): AIError | null {
    return this.toAIError(
      this.runtimeSnapshot?.error ?? this.chatContextValue.error
    );
  }

  private toAIError(error: Error | null): AIError | null {
    if (!error) return null;
    return 'type' in error
      ? (error as AIError)
      : new GeneralNetworkError(error.message);
  }

  private _onScroll() {
    const { scrollTop } = this;
    const distanceFromBottom = this._getDistanceFromBottom();

    this.canScrollDown =
      distanceFromBottom > AI_CHAT_SCROLL_DOWN_INDICATOR_THRESHOLD;

    if (distanceFromBottom <= AI_CHAT_AUTO_SCROLL_RESUME_THRESHOLD) {
      this._autoScrollEnabled = true;
    } else if (scrollTop < this._lastObservedScrollTop) {
      this._autoScrollEnabled = false;
    }

    this._lastObservedScrollTop = scrollTop;
  }

  private readonly _debouncedOnScroll = debounce(
    this._onScroll.bind(this),
    100
  );

  private readonly _throttledScrollToEnd = throttle(() => {
    if (!this._autoScrollEnabled) {
      return;
    }
    this.scrollToEnd();
  }, 200);

  private _onDownIndicatorClick() {
    this._autoScrollEnabled = true;
    this.canScrollDown = false;
    this.scrollToEnd();
  }

  private _pauseAutoScroll() {
    this._autoScrollEnabled = false;
    requestAnimationFrame(() => this._onScroll());
  }

  private _getDistanceFromBottom() {
    const { clientHeight, scrollTop, scrollHeight } = this;
    return scrollHeight - scrollTop - clientHeight;
  }

  private _getMessageKey(item: HistoryMessage, index: number) {
    const tabKey =
      this.runtimeSnapshot?.activeTabId ??
      this.runtimeSnapshot?.activeSessionId ??
      'legacy';
    if (isChatMessage(item)) {
      return `${tabKey}:${item.id || index}`;
    }
    return `${tabKey}:${index}`;
  }

  // Diff the current message keys against those seen in prior render cycles to
  // find genuinely new (appended) messages. Runs each render, before the list
  // is emitted, and folds the current keys into the seen-set afterwards.
  //  - First population is never animated (initial history batch).
  //  - A large jump in new keys (session switch / history load) is treated as
  //    a batch and skipped; only a normal 1–2 message append animates.
  //  - Entered keys ACCUMULATE in `_enteringKeys` (never removed here). The
  //    streamed answer mutates the same message object (stable id) but the list
  //    re-renders on every token, so a transient set would strip [data-cdz-enter]
  //    a microtask after it was set — before the CSS animation commits — and
  //    messages would snap in with no motion. The flag stays applied so the
  //    one-shot `cdz-msg-in` (fill-mode `both`) runs once on the node's first
  //    paint and lands at opacity:1; re-renders leave the attribute unchanged,
  //    so the animation never replays.
  private _computeEnteringKeys(items: HistoryMessage[]) {
    const currentKeys = items.map((item, index) =>
      this._getMessageKey(item, index)
    );

    const entering = new Set<string>();
    if (this._hasRenderedMessages) {
      for (const key of currentKeys) {
        if (!this._seenMessageKeys.has(key)) {
          entering.add(key);
        }
      }
      // Batch loads (history/session switch) — don't stagger a whole transcript.
      if (entering.size <= AIChatMessages.ENTRANCE_BATCH_LIMIT) {
        entering.forEach(key => this._enteringKeys.add(key));
      }
    }

    this._seenMessageKeys = new Set(currentKeys);
    if (items.length > 0) {
      this._hasRenderedMessages = true;
    }
  }

  protected override render() {
    const status = this.chatStatus;
    const error = this.chatError;
    const { isHistoryLoading } = this;
    const filteredItems = this.messages;

    this._computeEnteringKeys(filteredItems);

    const showDownIndicator = this.canScrollDown && filteredItems.length > 0;

    return html`
      <div
        class=${classMap({
          'chat-panel-messages-container': true,
          'independent-mode': !!this.independentMode,
        })}
        data-testid="chat-panel-messages-container"
      >
        ${filteredItems.length === 0
          ? html`<div
              class="messages-placeholder"
              data-testid="chat-panel-messages-placeholder"
            >
              <div class="cdz-ready-logo-wrap">
                <span class="cdz-ready-halo"></span>
                <img
                  class="cdz-ready-logo ${isHistoryLoading ? 'loading' : ''}"
                  src=${CLICKDZ_LOGO}
                  alt="ClickDz AI"
                />
              </div>
              <div
                class="messages-placeholder-title"
                data-loading=${isHistoryLoading}
              >
                ${this.isHistoryLoading
                  ? html`<span data-testid="chat-panel-loading-state"
                      >ClickDz AI is loading history...</span
                    >`
                  : html`<span data-testid="chat-panel-empty-state"
                      >Comment puis-je vous aider aujourd’hui ?</span
                    >`}
              </div>
            </div> `
          : repeat(
              filteredItems,
              (item, index) => this._getMessageKey(item, index),
              (item, index) => {
                const isLast = index === filteredItems.length - 1;
                // Entrance flag: true only on the cycle this key first appears
                // (never on initial history / batch loads — see render()).
                const isEntering = this._enteringKeys.has(
                  this._getMessageKey(item, index)
                );
                if (isChatMessage(item) && item.role === 'user') {
                  return html`<chat-message-user
                    ?data-cdz-enter=${isEntering}
                    .item=${item}
                  ></chat-message-user>`;
                } else if (isChatMessage(item) && item.role === 'assistant') {
                  // Task for the loading ticker: the nearest preceding user
                  // message (first ~100 chars). Only needed while this is the
                  // last, still-loading answer.
                  let pulseTask = '';
                  if (isLast) {
                    for (let i = index - 1; i >= 0; i--) {
                      const prev = filteredItems[i];
                      if (isChatMessage(prev) && prev.role === 'user') {
                        pulseTask = (prev.content ?? '').slice(0, 100);
                        break;
                      }
                    }
                  }
                  return html`<chat-message-assistant
                    ?data-cdz-enter=${isEntering}
                    .host=${this.host}
                    .session=${this.session}
                    .item=${item}
                    .isLast=${isLast}
                    .status=${isLast ? status : 'idle'}
                    .pulseTask=${pulseTask}
                    .error=${isLast ? error : null}
                    .extensions=${this.extensions}
                    .affineFeatureFlagService=${this.affineFeatureFlagService}
                    .affineThemeService=${this.affineThemeService}
                    .notificationService=${this.notificationService}
                    .retry=${() => this.retry()}
                    .width=${this.width}
                    .independentMode=${this.independentMode}
                    .docDisplayService=${this.docDisplayService}
                    .peekViewService=${this.peekViewService}
                    .onOpenDoc=${this.onOpenDoc}
                  ></chat-message-assistant>`;
                } else if (isChatAction(item) && this.host) {
                  return html`<chat-message-action
                    .host=${this.host}
                    .item=${item}
                  ></chat-message-action>`;
                }
                return nothing;
              }
            )}
      </div>
      ${showDownIndicator && filteredItems.length > 0
        ? html`<div
            data-testid="chat-panel-scroll-down-indicator"
            class="down-indicator"
            @click=${this._onDownIndicatorClick}
          >
            ${ArrowDownIcon()}
          </div>`
        : nothing}
    `;
  }

  override connectedCallback() {
    super.connectedCallback();
    const { disposables } = this;

    this.avatarUrl = AIAppEvents.userInfo.value?.avatarUrl ?? '';

    disposables.add(
      AIAppEvents.userInfo.subscribe(userInfo => {
        const status = this.chatStatus;
        const error = this.chatError;
        this.avatarUrl = userInfo?.avatarUrl ?? '';
        if (
          status === 'error' &&
          error instanceof UnauthorizedError &&
          userInfo
        ) {
          this.runtime?.dispatch({ type: 'clearError' }).catch(console.error);
          this.updateContext({ status: 'idle', error: null });
        }
      })
    );

    const selection$ = this.host?.selection.slots.changed;
    if (selection$) {
      disposables.add(
        selection$.subscribe(() => {
          this._selectionValue = this.host?.selection.value ?? [];
        })
      );
    }

    const docModeService = this.host?.std.get(DocModeProvider);
    if (docModeService && this.docId) {
      disposables.add(
        docModeService.onPrimaryModeChange(
          () => this.requestUpdate(),
          this.docId
        )
      );
    }

    // Add scroll event listener to the host element
    this.addEventListener('scroll', this._debouncedOnScroll);
    this.addEventListener(
      AI_CHAT_AUTO_SCROLL_PAUSE_EVENT,
      this._pauseAutoScroll as EventListener
    );
    disposables.add(() => {
      this.removeEventListener('scroll', this._debouncedOnScroll);
      this.removeEventListener(
        AI_CHAT_AUTO_SCROLL_PAUSE_EVENT,
        this._pauseAutoScroll as EventListener
      );
    });
  }

  protected override updated(changedProperties: PropertyValues) {
    if (changedProperties.has('isHistoryLoading')) {
      this.canScrollDown = false;
      this._autoScrollEnabled = true;
    }

    if (changedProperties.has('messages')) {
      this._onScroll();

      if (this.chatStatus === 'transmitting') {
        this._throttledScrollToEnd();
      } else if (this._autoScrollEnabled) {
        this.scrollToEnd();
      }
    }

    if (
      (changedProperties.has('chatContextValue') ||
        changedProperties.has('runtimeSnapshot')) &&
      (this.chatStatus === 'success' || this.chatStatus === 'error')
    ) {
      this._onScroll();
    }
  }

  scrollToEnd() {
    // Smooth-pin to the bottom while pinned; fall back to an instant jump when
    // the reader prefers reduced motion (CSS can't reach scrollTo's behavior).
    const behavior: ScrollBehavior = this._prefersReducedMotion
      ? 'auto'
      : 'smooth';
    requestAnimationFrame(() => {
      this.scrollTo({
        top: this.scrollHeight,
        behavior,
      });
    });
  }

  scrollToPos(top: number) {
    requestAnimationFrame(() => {
      this.scrollTo({ top });
    });
  }

  retry = async () => {
    if (!this.runtime) return;
    const last = this.messages.at(-1);
    await this.runtime.dispatch({
      type: 'retry',
      messageId: last && isChatMessage(last) ? last.id : '',
    });
  };
}
