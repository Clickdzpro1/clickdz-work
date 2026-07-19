import type { AIToolsConfigService } from '@affine/core/modules/ai-button';
import { type AIModelService } from '@affine/core/modules/ai-button/services/models';
import {
  CDZ_FLAGSHIP_MODELS,
  CDZ_MODEL_ICONS,
  CDZ_VENDOR_ICONS,
} from '../../_common/cdz-assets';
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
  type MenuConfig,
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

import {
  CDZ_IMAGE_MODEL_OPTIONS,
  getPreferredImageModel,
  setPreferredImageModel,
} from '../../utils/image-model-preference';
import {
  type CdzContextMode,
  getContextMode,
  setContextMode,
} from '../../utils/context-mode-preference';

const modelSubMenuMiddleware = [
  autoPlacement({ allowedPlacements: ['right-start', 'left-start'] }),
  offset({ mainAxis: 4, crossAxis: 0 }),
  shift({ crossAxis: true, padding: 8 }),
];

// WS2 — model-switch context handoff. A thread longer than this many user
// turns is compacted (leading summary + tail) rather than sent recent-window
// whole; matches the server's contextMode='compact' contract.
const CDZ_LONG_THREAD_TURNS = 12;

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
      /* taller so all ~16 models are browsable at once (was 348px) */
      max-height: min(560px, 68vh);
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
    /* ===== vendor group header (non-interactive) ===== */
    .ai-model-group-header {
      padding: 6px 8px 2px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: ${unsafeCSSVarV2('text/secondary')};
      pointer-events: none;
      user-select: none;
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

    /* ===== icon frame (polished squircle, gold ring for flagships) ===== */
    .ai-model-icon-frame {
      position: relative;
      width: 26px;
      height: 26px;
      padding: 1px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--affine-v2-layer-background-hoverOverlay);
      box-shadow: inset 0 0 0 0.5px var(--affine-v2-layer-insideBorder-border);
      transition: transform 0.16s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .ai-model-item:hover .ai-model-icon-frame {
      transform: scale(1.08);
    }
    .ai-model-icon {
      width: 100%;
      height: 100%;
      border-radius: 7px;
      object-fit: cover;
      display: block;
    }
    /* vendor SVG marks breathe inside the chip */
    .ai-model-icon[data-kind='vendor'] {
      object-fit: contain;
      padding: 3px;
      box-sizing: border-box;
    }
    /* gold flagship ring — a slowly turning gold sheen + soft glow that
       marks the most powerful engines (Ultra, Council, Opus 4.8, GPT 5.5,
       Gemini 3.1 Pro) */
    @property --cdz-gold-angle {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }
    .ai-model-icon-frame.gold {
      padding: 2px;
      background: conic-gradient(
        from var(--cdz-gold-angle, 0deg),
        #fff3c4,
        #ffd700 22%,
        #b8860b 46%,
        #ffe14d 68%,
        #b8860b 84%,
        #fff3c4
      );
      box-shadow:
        0 0 8px rgba(255, 200, 40, 0.4),
        0 0 1px rgba(184, 134, 11, 0.8);
      animation:
        cdz-gold-spin 3.2s linear infinite,
        cdz-gold-glow 2.4s ease-in-out infinite;
    }
    .ai-model-icon-frame.gold .ai-model-icon {
      background: var(--affine-v2-layer-background-primary, #fff);
    }
    @keyframes cdz-gold-spin {
      to {
        --cdz-gold-angle: 360deg;
      }
    }
    @keyframes cdz-gold-glow {
      0%,
      100% {
        box-shadow:
          0 0 6px rgba(255, 200, 40, 0.35),
          0 0 1px rgba(184, 134, 11, 0.8);
      }
      50% {
        box-shadow:
          0 0 12px rgba(255, 210, 60, 0.6),
          0 0 2px rgba(184, 134, 11, 0.9);
      }
    }
    /* flagship rows glow softly in the list */
    .ai-model-flagship {
      background: linear-gradient(
        90deg,
        rgba(255, 200, 40, 0.09),
        rgba(255, 200, 40, 0.02) 55%,
        transparent
      );
    }
    .ai-model-flagship:hover {
      background: linear-gradient(
        90deg,
        rgba(255, 200, 40, 0.16),
        rgba(255, 200, 40, 0.04) 60%,
        transparent
      );
    }
    .ai-model-flagship-badge {
      font-size: 10px;
      font-weight: 700;
      line-height: 16px;
      padding: 0 6px;
      border-radius: 999px;
      letter-spacing: 0.03em;
      color: #7a5901;
      background: linear-gradient(120deg, #ffe89a, #ffd700 55%, #f3c14b);
      box-shadow: 0 0 6px rgba(255, 200, 40, 0.35);
    }
    @media (prefers-reduced-motion: reduce) {
      .ai-model-icon-frame.gold {
        animation: none;
      }
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

  // WS2 — fresh-start ("Nouvelle discussion"). Optional so existing hosts
  // that don't pass it keep working unchanged (keep-context paths are
  // unaffected either way); when provided, invoking it performs the actual
  // session swap + navigation on the host side (mirrors the runtime's own
  // `createNewSession` dispatch used by the "+ New Chat" toolbar button —
  // RECON B8 / ai-chat-toolbar.ts `onPlusClick`). The popup itself never
  // touches CopilotClient/forkSession directly; it only signals intent.
  @property({ attribute: false })
  accessor onNewSession: (() => void | Promise<void>) | undefined;

  model = computed(() => {
    // Use the service's reconciled id so a stale persisted modelId (one no
    // longer in the current list) resolves to the default instead of leaving
    // the picker with no active/selected model.
    const modelId = this.aiModelService.resolvedModelId.value;
    const activeModel = this.aiModelService.models.value.find(
      model => model.id === modelId
    );
    const defaultModel = this.aiModelService.models.value.find(
      model => model.isDefault
    );
    return activeModel || defaultModel;
  });

  // WS2 — how many real conversation turns the bound session already holds.
  // Reachable cheaply straight off the CopilotChatHistory fragment
  // (`session.messages`, RECON G): count user-role messages = turns. If the
  // roles are somehow unreadable but messages exist, fall back to the raw
  // message count so a bound-but-opaque session still counts as ≥1.
  private get sessionTurnCount(): number {
    const messages = this.session?.messages;
    if (!messages || messages.length === 0) return 0;
    const userTurns = messages.filter(
      message => message.role === 'user'
    ).length;
    return userTurns > 0 ? userTurns : messages.length;
  }

  // The context handoff only makes sense once there is at least one turn for
  // a newly-picked model to read (or discard).
  private get hasHandoffContext(): boolean {
    return !!this.session?.sessionId && this.sessionTurnCount >= 1;
  }

  // Keep-context default: 'recent' for short threads, 'compact' once the
  // thread is long (>12 turns) so the new model gets a summary + tail instead
  // of a truncated recent window.
  private get defaultKeepMode(): CdzContextMode {
    return this.sessionTurnCount > CDZ_LONG_THREAD_TURNS
      ? 'compact'
      : 'recent';
  }

  // Store the keep-context choice for the current session. Called both when a
  // different model is picked (default keep) and from the explicit second-step
  // row, so the chosen mode rides subsequent sends via the transport.
  private keepContextForSwitch() {
    const sessionId = this.session?.sessionId;
    if (!sessionId) return;
    setContextMode(sessionId, this.defaultKeepMode);
  }

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

    // model switch — restyled rows with real vendor icons, a gold flagship
    // tier, animated selection and a genuinely scrollable list
    const allModels = this.aiModelService.models.value;

    // one model row — identical markup/behavior to before, just factored out
    // so it can be reused inside per-vendor groups
    const renderModelAction = (model: (typeof allModels)[number]) => {
      const isSelected = model.id === this.model.value?.id;
      const isSelfHosted =
        this.serverService.server.config$.value?.type ===
        ServerDeploymentType.Selfhosted;
      const status =
        this.subscriptionService.subscription.ai$.value?.status;
      const isSubscribed = status === SubscriptionStatus.Active;
      const isFlagship = CDZ_FLAGSHIP_MODELS.has(model.id);
      const chipInitial = model.category.slice(0, 1).toUpperCase();
      const cdzIcon = CDZ_MODEL_ICONS[model.id];
      const vendorIcon = CDZ_VENDOR_ICONS[model.category];
      const modelIcon = cdzIcon || vendorIcon;
      return menu.action({
        name: model.name,
        class: {
          'ai-model-item': true,
          'ai-model-selected': isSelected,
          'ai-model-flagship': isFlagship,
        },
        info:
          isFlagship || model.isDefault
            ? html`
                ${isFlagship
                  ? html`<span class="ai-model-flagship-badge">★</span>`
                  : ''}
                ${model.isDefault
                  ? html`<span class="ai-model-default-badge">Default</span>`
                  : ''}
              `
            : undefined,
        prefix: html`
          <div class="ai-model-prefix">
            <span class="ai-model-icon-frame ${isFlagship ? 'gold' : ''}">
              ${modelIcon
                ? html`<img
                    class="ai-model-icon"
                    data-kind=${cdzIcon ? 'cdz' : 'vendor'}
                    src=${modelIcon}
                    alt=""
                  />`
                : html`<span class="ai-model-chip" data-cat=${model.category}>
                    ${chipInitial}
                  </span>`}
            </span>
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
          // WS2 — switching to a DIFFERENT model on a session that already has
          // ≥1 turn stages the context handoff. The default is keep-context
          // (the second-step row below lets the user review it in the same
          // visual language); the stored mode then rides subsequent sends.
          const isDifferent = model.id !== this.model.value?.id;
          this.aiModelService.setModel(model.id);
          if (isDifferent && this.hasHandoffContext) {
            this.keepContextForSwitch();
          }
        },
      });
    };

    // a small non-interactive vendor header (hidden while searching).
    const renderGroupHeader =
      (label: string): MenuConfig =>
      menu =>
        menu.searchName$.value.length > 0
          ? undefined
          : html`<div class="ai-model-group-header">${label}</div>`;

    // group the roster by vendor; keep flagship-first order WITHIN each group.
    const VENDOR_ORDER = ['CDZ', 'Claude', 'Gemini', 'GPT'];
    const vendorRank = (category: string) => {
      const i = VENDOR_ORDER.indexOf(category);
      return i === -1 ? VENDOR_ORDER.length : i;
    };
    const flagshipFirst = (list: typeof allModels) => [
      ...list.filter(model => CDZ_FLAGSHIP_MODELS.has(model.id)),
      ...list.filter(model => !CDZ_FLAGSHIP_MODELS.has(model.id)),
    ];
    const vendorsPresent = [
      ...new Set(allModels.map(model => model.category)),
    ].sort((a, b) => vendorRank(a) - vendorRank(b) || a.localeCompare(b));

    const modelGroups = vendorsPresent.map(vendor => {
      const rows = flagshipFirst(
        allModels.filter(model => model.category === vendor)
      ).map(renderModelAction);
      return menu.group({
        name: vendor,
        items: [renderGroupHeader(vendor), ...rows],
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
          items: modelGroups,
        },
      })
    );

    // when the model sub-menu opens, bring the selected model into view
    this.watchModelSubMenuOpen();

    // WS2 — model-switch context handoff (inline second step). Only shown
    // when the bound session already has ≥1 turn, so a newly-picked model has
    // something to read. Same visual language as the Image-model submenu
    // (identical `.ai-model-item` rows + check badge). Picking a different
    // model above already stores the keep-context default; this row surfaces
    // that decision and lets the user re-affirm it.
    //
    // "Nouvelle discussion" (fresh start) sits beside the keep-context row:
    // the host (chat-input) now threads an optional `onNewSession` callback
    // that performs the actual session swap (it dispatches the runtime's own
    // `createNewSession` action — the same primitive the "+ New Chat"
    // toolbar button already uses, see ai-chat-toolbar.ts `onPlusClick`).
    // The popup never touches CopilotClient/forkSession itself, so there is
    // no orphan-session risk: it only signals intent through the callback.
    // If a host doesn't pass the callback (not yet wired), the row is hidden
    // rather than firing nothing on click.
    if (this.hasHandoffContext) {
      const sessionId = this.session?.sessionId ?? '';
      const storedMode = getContextMode(sessionId);
      const keepMode = this.defaultKeepMode;
      // Keep-context is the effective/highlighted choice whenever the stored
      // mode is a context-carrying one (recent | compact) — which is exactly
      // what a model switch stores by default.
      const keepSelected = storedMode === 'recent' || storedMode === 'compact';
      const keepLabel =
        keepMode === 'compact'
          ? '🧠 Garder le contexte (résumé)'
          : '🧠 Garder le contexte';
      const onNewSession = this.onNewSession;
      modelItems.push(
        menu.subMenu({
          name: 'Contexte du modèle',
          prefix: AiOutlineIcon(),
          middleware: modelSubMenuMiddleware,
          postfix: html`
            <span class="ai-active-model-name">
              ${keepSelected ? 'Conservé' : 'Auto'}
            </span>
          `,
          options: {
            items: [
              renderGroupHeader(
                'Le nouveau modèle doit-il lire la conversation ?'
              ),
              menu.action({
                name: keepLabel,
                class: {
                  'ai-model-item': true,
                  'ai-model-selected': keepSelected,
                },
                postfix: keepSelected
                  ? html`<span class="ai-model-check">${DoneIcon()}</span>`
                  : undefined,
                select: () => {
                  this.keepContextForSwitch();
                },
              }),
              // Only rendered once the host wires the callback (RECON B8):
              // the fork/new-session mutation exists client-side, but firing
              // it without a session-swap + navigation handle would strand
              // an orphan session, so this row stays hidden until a real
              // `onNewSession` is threaded through from the chat-input host.
              ...(onNewSession
                ? [
                    menu.action({
                      name: '🆕 Nouvelle discussion',
                      class: {
                        'ai-model-item': true,
                      },
                      select: () => {
                        void onNewSession();
                      },
                    }),
                  ]
                : []),
            ],
          },
        })
      );
    }

    // CDZIMAGE (WS1 PR5): which engine the NATIVE image actions use —
    // Generate image, the style filters, upscale, remove-background — on
    // both the AI box and the Whiteboard. These surfaces offer 2.0/1.5 only
    // (the economy 1.0 tier is a Vdz-only offering by policy). The choice is
    // read as the modelId fallback by the image transport on every request.
    const preferredImageModel = getPreferredImageModel();
    const activeImageOption =
      CDZ_IMAGE_MODEL_OPTIONS.find(
        option => option.id === preferredImageModel
      ) ?? CDZ_IMAGE_MODEL_OPTIONS[0];
    modelItems.push(
      menu.subMenu({
        name: 'Image model',
        prefix: AiOutlineIcon(),
        middleware: modelSubMenuMiddleware,
        postfix: html`
          <span class="ai-active-model-name">
            ${activeImageOption.label.split(' · ')[0]}
          </span>
        `,
        options: {
          items: CDZ_IMAGE_MODEL_OPTIONS.map(option =>
            menu.action({
              name: option.label,
              class: {
                'ai-model-item': true,
                'ai-model-selected': option.id === preferredImageModel,
              },
              postfix:
                option.id === preferredImageModel
                  ? html`<span class="ai-model-check">${DoneIcon()}</span>`
                  : undefined,
              select: () => {
                setPreferredImageModel(option.id);
              },
            })
          ),
        },
      })
    );

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
