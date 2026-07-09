import type { AIToolsConfigService } from '@affine/core/modules/ai-button';
import { type AIModelService } from '@affine/core/modules/ai-button/services/models';
import { CDZ_MODEL_ICONS, CDZ_VENDOR_ICONS } from '../../_common/cdz-assets';
import type {
  ServerService,
  SubscriptionService,
} from '@affine/core/modules/cloud';
import {
  type CopilotChatHistoryFragment,
  ServerDeploymentType,
  SubscriptionStatus,
} from '@affine/graphql';
import {
  menu,
  popMenu,
  popupTargetFromElement,
} from '@blocksuite/affine/components/context-menu';
import { SignalWatcher, WithDisposable } from '@blocksuite/affine/global/lit';
import { unsafeCSSVarV2 } from '@blocksuite/affine/shared/theme';
import type { NotificationService } from '@blocksuite/affine-shared/services';
import {
  AiOutlineIcon,
  ArrowDownSmallIcon,
  CloudWorkspaceIcon,
  DoneIcon,
  LockIcon,
  ThinkingIcon,
} from '@blocksuite/icons/lit';
import { ShadowlessElement } from '@blocksuite/std';
import { autoPlacement, offset, shift } from '@floating-ui/dom';
import { computed } from '@preact/signals-core';
import { css, html } from 'lit';
import { property } from 'lit/decorators.js';

const modelSubMenuMiddleware = [
  autoPlacement({ allowedPlacements: ['right-start', 'left-start'] }),
  offset({ mainAxis: 4, crossAxis: 0 }),
  shift({ crossAxis: true, padding: 8 }),
];

export class ChatInputPreference extends SignalWatcher(
  WithDisposable(ShadowlessElement)
) {
  static override styles = css`
    /* ===== ClickDz model picker — container ===== */
    /* The menu system ignores custom option classes, so we scope on the
       presence of our tagged rows via :has() — this only ever matches the
       model sub-menu. */
    affine-menu:has(.ai-model-item) {
      border-radius: 12px;
      padding: 6px;
      gap: 4px;
      transform-origin: top left;
      animation: clickdz-menu-in 0.18s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    affine-menu:has(.ai-model-item) .affine-menu-body {
      max-height: 348px;
      overflow-y: auto;
      overscroll-behavior: contain;
      scroll-behavior: smooth;
      gap: 2px;
      padding: 6px 4px;
      scrollbar-width: thin;
      scrollbar-color: var(--affine-v2-layer-background-hoverOverlay)
        transparent;
      /* soft scroll hint fades at both ends */
      mask-image: linear-gradient(
        to bottom,
        transparent 0,
        black 10px,
        black calc(100% - 10px),
        transparent 100%
      );
    }
    affine-menu:has(.ai-model-item) .affine-menu-body::-webkit-scrollbar {
      width: 5px;
    }
    affine-menu:has(.ai-model-item)
      .affine-menu-body::-webkit-scrollbar-track {
      background: transparent;
    }
    affine-menu:has(.ai-model-item)
      .affine-menu-body::-webkit-scrollbar-thumb {
      background: var(--affine-v2-layer-background-hoverOverlay);
      border-radius: 3px;
    }
    affine-menu:has(.ai-model-item)
      .affine-menu-body::-webkit-scrollbar-thumb:hover {
      background: ${unsafeCSSVarV2('icon/tertiary')};
    }
    affine-menu:has(.ai-model-item) .affine-menu-search-container {
      border-radius: 8px;
    }
    @keyframes clickdz-menu-in {
      from {
        opacity: 0;
        transform: translateY(-6px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    /* ===== rows ===== */
    .ai-model-item {
      border-radius: 8px;
      transition:
        background-color 0.14s ease,
        transform 0.14s ease;
      animation: clickdz-item-in 0.22s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    .ai-model-item:hover {
      transform: translateX(2px);
    }
    .ai-model-selected {
      background-color: var(--affine-v2-layer-background-hoverOverlay);
    }
    /* gentle stagger for the first rows */
    affine-menu-button:nth-of-type(1) .ai-model-item { animation-delay: 0.015s; }
    affine-menu-button:nth-of-type(2) .ai-model-item { animation-delay: 0.03s; }
    affine-menu-button:nth-of-type(3) .ai-model-item { animation-delay: 0.045s; }
    affine-menu-button:nth-of-type(4) .ai-model-item { animation-delay: 0.06s; }
    affine-menu-button:nth-of-type(5) .ai-model-item { animation-delay: 0.075s; }
    affine-menu-button:nth-of-type(6) .ai-model-item { animation-delay: 0.09s; }
    affine-menu-button:nth-of-type(7) .ai-model-item { animation-delay: 0.105s; }
    affine-menu-button:nth-of-type(8) .ai-model-item { animation-delay: 0.12s; }
    affine-menu-button:nth-of-type(9) .ai-model-item { animation-delay: 0.135s; }
    affine-menu-button:nth-of-type(10) .ai-model-item { animation-delay: 0.15s; }
    @keyframes clickdz-item-in {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      affine-menu:has(.ai-model-item),
      .ai-model-item {
        animation: none;
      }
    }

    /* ===== provider chip ===== */
    .ai-model-chip {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
      background: color-mix(in srgb, var(--chip-color, #8a8a8a) 16%, transparent);
      color: var(--chip-color, #8a8a8a);
      transition: box-shadow 0.14s ease;
    }
    .ai-model-selected .ai-model-chip {
      box-shadow: 0 0 0 1.5px
        color-mix(in srgb, var(--chip-color, #8a8a8a) 55%, transparent);
    }
    .ai-model-chip[data-cat='ClickDz'] { --chip-color: #6e56cf; }
    .ai-model-chip[data-cat='Gemini'] { --chip-color: #4285f4; }
    .ai-model-chip[data-cat='GPT'],
    .ai-model-chip[data-cat='o1'],
    .ai-model-chip[data-cat='o3'] { --chip-color: #10a37f; }
    .ai-model-chip[data-cat='Claude'] { --chip-color: #d97757; }
    .ai-model-icon {
      width: 24px;
      height: 24px;
      border-radius: 7px;
      object-fit: cover;
      box-shadow: 0 2px 8px rgba(47, 123, 255, 0.28);
    }

    /* ===== selected check / badges ===== */
    .ai-model-check svg {
      width: 20px;
      height: 20px;
      color: ${unsafeCSSVarV2('icon/activated')};
      animation: clickdz-check-pop 0.18s cubic-bezier(0.34, 1.56, 0.64, 1) both;
    }
    @keyframes clickdz-check-pop {
      from {
        opacity: 0;
        transform: scale(0.5);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
    .ai-model-default-badge {
      font-size: 10px;
      font-weight: 600;
      line-height: 16px;
      padding: 0 6px;
      border-radius: 999px;
      color: ${unsafeCSSVarV2('text/secondary')};
      background: var(--affine-v2-layer-background-hoverOverlay);
    }

    .chat-input-preference-trigger {
      display: flex;
      align-items: center;
      padding: 0px 4px;
      color: var(--affine-v2-icon-primary);
      transition: all 0.23s ease;
      border-radius: 4px;
      background: transparent;
      border: none;
      cursor: pointer;
    }
    .chat-input-preference-trigger:hover {
      background-color: var(--affine-v2-layer-background-hoverOverlay);
    }
    .chat-input-preference-trigger-label {
      font-size: 14px;
      line-height: 22px;
      font-weight: 500;
      padding: 0px 4px;
    }
    .chat-input-preference-trigger-icon {
      font-size: 20px;
      line-height: 0;
    }
    .preference-action {
      white-space: nowrap;
      min-width: 220px;
    }
    .ai-active-model-name {
      font-size: 14px;
      color: ${unsafeCSSVarV2('text/secondary')};
      line-height: 22px;
      margin-left: 40px;
    }
    .ai-model-prefix {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ai-model-postfix {
      display: flex;
      align-items: center;
    }
    .ai-model-postfix svg:hover {
      color: ${unsafeCSSVarV2('icon/activated')};
    }
  `;

  @property({ attribute: false })
  accessor session!: CopilotChatHistoryFragment | null | undefined;
  // --------- model props end ---------

  // --------- extended thinking props start ---------
  @property({ attribute: false })
  accessor extendedThinking: boolean = false;

  @property({ attribute: false })
  accessor onExtendedThinkingChange:
    | ((extendedThinking: boolean) => void)
    | undefined;
  // --------- extended thinking props end ---------

  @property({ attribute: false })
  accessor serverService!: ServerService;

  @property({ attribute: false })
  accessor toolsConfigService!: AIToolsConfigService;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor subscriptionService!: SubscriptionService;

  @property({ attribute: false })
  accessor aiModelService!: AIModelService;

  @property({ attribute: false })
  accessor onAISubscribe!: () => Promise<void>;

  model = computed(() => {
    const modelId = this.aiModelService.modelId.value;
    const activeModel = this.aiModelService.models.value.find(
      model => model.id === modelId
    );
    const defaultModel = this.aiModelService.models.value.find(
      model => model.isDefault
    );
    return activeModel || defaultModel;
  });

  private watchModelSubMenuOpen() {
    // the menu system has no onOpen hook for sub-menus, so watch the DOM:
    // when the model list mounts, center the currently selected model
    const observer = new MutationObserver(() => {
      const selected = document.querySelector('affine-menu .ai-model-selected');
      if (selected) {
        observer.disconnect();
        clearTimeout(timeout);
        requestAnimationFrame(() => {
          selected.scrollIntoView({ block: 'center' });
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // give up quietly if the sub-menu never opens
    const timeout = setTimeout(() => observer.disconnect(), 15000);
    this.disposables.add(() => {
      observer.disconnect();
      clearTimeout(timeout);
    });
  }

  openPreference(e: Event) {
    const element = e.currentTarget;
    if (!(element instanceof HTMLElement)) return;
    const modelItems = [];
    const searchItems = [];

    // model switch — restyled rows with provider chips, animated selection
    // and a genuinely scrollable list (see :has(.ai-model-item) styles)
    const allModels = this.aiModelService.models.value;
    const modelActionItems = allModels.map(model => {
      const isSelected = model.id === this.model.value?.id;
      const isSelfHosted =
        this.serverService.server.config$.value?.type ===
        ServerDeploymentType.Selfhosted;
      const status =
        this.subscriptionService.subscription.ai$.value?.status;
      const isSubscribed = status === SubscriptionStatus.Active;
      const chipInitial = model.category.slice(0, 1).toUpperCase();
      const modelIcon =
        CDZ_MODEL_ICONS[model.id] || CDZ_VENDOR_ICONS[model.category];
      return menu.action({
        name: model.name,
        class: {
          'ai-model-item': true,
          'ai-model-selected': isSelected,
        },
        info: model.isDefault
          ? html`<span class="ai-model-default-badge">Default</span>`
          : undefined,
        prefix: html`
          <div class="ai-model-prefix">
            ${modelIcon
              ? html`<img class="ai-model-icon" src=${modelIcon} alt="" />`
              : html`<span class="ai-model-chip" data-cat=${model.category}>
                  ${chipInitial}
                </span>`}
          </div>
        `,
        postfix: html`
          <div
            class="ai-model-postfix"
            data-model-selected=${isSelected ? 'true' : 'false'}
            @click=${model.isPro && !isSubscribed ? this.onAISubscribe : undefined}
          >
            ${isSelected
              ? html`<span class="ai-model-check">${DoneIcon()}</span>`
              : model.isPro && !isSubscribed
                ? LockIcon()
                : undefined}
          </div>
        `,
        select: () => {
          if (model.isPro && !isSelfHosted && !isSubscribed) {
            this.notificationService.toast(
              `Pro models require a ClickDz AI subscription.`
            );
            return;
          }
          this.aiModelService.setModel(model.id);
        },
      });
    });

    modelItems.push(
      menu.subMenu({
        name: 'Model',
        prefix: AiOutlineIcon(),
        middleware: modelSubMenuMiddleware,
        postfix: html`
          <span class="ai-active-model-name"> ${this.model.value?.name} </span>
        `,
        options: {
          items: modelActionItems,
        },
      })
    );

    // when the model sub-menu opens, bring the selected model into view
    this.watchModelSubMenuOpen();

    // NOTE: the council roster is fixed server-side (CDZ Council fans out to
    // three frontier models + synthesis inside CDZ AI), so there is no
    // client-side member picker anymore — selecting the CDZ Council model is
    // all that's needed.

    modelItems.push(
      menu.toggleSwitch({
        name: 'Extended Thinking',
        prefix: ThinkingIcon(),
        on: this.extendedThinking,
        onChange: (value: boolean) => this.onExtendedThinkingChange?.(value),
        class: { 'preference-action': true },
      })
    );

    searchItems.push(
      menu.toggleSwitch({
        name: 'Workspace All Docs',
        prefix: CloudWorkspaceIcon(),
        on:
          !!this.toolsConfigService.config.value.searchWorkspace &&
          !!this.toolsConfigService.config.value.readingDocs,
        onChange: (value: boolean) =>
          this.toolsConfigService.setConfig({
            searchWorkspace: value,
            readingDocs: value,
          }),
        class: { 'preference-action': true },
      })
    );

    popMenu(popupTargetFromElement(element), {
      options: {
        items: [
          menu.group({
            items: [...modelItems],
          }),
          menu.group({
            items: [...searchItems],
          }),
        ],
        testId: 'chat-input-preference',
      },
    });
  }

  override render() {
    return html`<button
      @click=${this.openPreference}
      data-testid="chat-input-preference-trigger"
      class="chat-input-preference-trigger"
    >
      <span class="chat-input-preference-trigger-label">
        ${this.model.value?.category}
      </span>
      <span class="chat-input-preference-trigger-icon">
        ${ArrowDownSmallIcon()}
      </span>
    </button>`;
  }
}
