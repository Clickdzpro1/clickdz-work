import type { FeatureFlagService } from '@affine/core/modules/feature-flag';
import type { PeekViewService } from '@affine/core/modules/peek-view';
import type { AppThemeService } from '@affine/core/modules/theme';
import type { CopilotChatHistoryFragment } from '@affine/graphql';
import { WithDisposable } from '@blocksuite/affine/global/lit';
import { isInsidePageEditor } from '@blocksuite/affine/shared/utils';
import {
  type BlockStdScope,
  type EditorHost,
  ShadowlessElement,
} from '@blocksuite/affine/std';
import type { ExtensionType } from '@blocksuite/affine/store';
import type { NotificationService } from '@blocksuite/affine-shared/services';
import type { Signal } from '@preact/signals-core';
import { css, html, nothing } from 'lit';
import { property, state } from 'lit/decorators.js';

import {
  EdgelessEditorActions,
  PageEditorActions,
} from '../../_common/chat-actions-handle';
import type { DocDisplayConfig } from '../../components/ai-chat-chips';
import {
  type ChatMessage,
  type ChatStatus,
  isChatMessage,
  type StreamObject,
} from '../../components/ai-chat-messages';
import { AIChatErrorRenderer } from '../../messages/error';
import { AIAppEvents, type AIError, cdzApiUrl } from '../../provider';
import { mergeStreamContent } from '../../utils/stream-objects';

export class ChatMessageAssistant extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    .message-info {
      color: var(--affine-placeholder-color);
      font-size: var(--affine-font-xs);
      font-weight: 400;
    }
    .cdz-followups {
      display: flex;
      flex-direction: column;
      gap: 7px;
      margin: 12px 0 2px;
    }
    .cdz-followups-title {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--affine-v2-text-secondary);
      opacity: 0.72;
    }
    /* The "AI-suggested" sparkle before the section title. */
    .cdz-followups-title::before {
      content: '✦';
      font-size: 11px;
      line-height: 1;
      color: #6e56cf;
      opacity: 0.9;
    }
    .cdz-followups-row {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    /*
     * Follow-up chips, restyled with a per-intent identity. Every chip carries
     * an intent class (deepen / actionable / reframe) set by the render from a
     * light French-keyword heuristic; the class drives a leading glyph (via
     * ::before) and a per-intent accent used for the left tint, hover fill and
     * focus ring. RTL-aware: the glyph uses logical margin (margin-inline-end)
     * and the row/flow inherits the panel's dir, so an Arabic answer flips
     * the chip order and glyph side automatically.
     */
    .cdz-followup {
      --cdz-fu-accent: #2f7bff;
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--affine-v2-layer-insideBorder-border);
      border-radius: 999px;
      padding: 6px 13px;
      cursor: pointer;
      color: var(--affine-v2-text-secondary);
      background: color-mix(in srgb, var(--cdz-fu-accent) 5%, transparent);
      font: inherit;
      font-size: 12.5px;
      font-weight: 500;
      line-height: 1.35;
      text-align: start;
      transition:
        background 0.15s ease,
        color 0.15s ease,
        border-color 0.15s ease,
        box-shadow 0.15s ease,
        transform 0.12s ease;
    }
    /* Leading per-intent glyph. */
    .cdz-followup::before {
      content: '';
      font-size: 12px;
      line-height: 1;
      margin-inline-end: 6px;
      opacity: 0.9;
    }
    .cdz-followup.cdz-fu-deepen {
      --cdz-fu-accent: #6e56cf;
    }
    .cdz-followup.cdz-fu-deepen::before {
      content: '🔍';
    }
    .cdz-followup.cdz-fu-actionable {
      --cdz-fu-accent: #10a37f;
    }
    .cdz-followup.cdz-fu-actionable::before {
      content: '⚡';
    }
    .cdz-followup.cdz-fu-reframe {
      --cdz-fu-accent: #2f7bff;
    }
    .cdz-followup.cdz-fu-reframe::before {
      content: '🔁';
    }
    .cdz-followup:hover {
      color: var(--affine-v2-text-primary);
      background: color-mix(in srgb, var(--cdz-fu-accent) 14%, transparent);
      border-color: color-mix(in srgb, var(--cdz-fu-accent) 55%, transparent);
      transform: translateY(-1px);
    }
    .cdz-followup:active {
      transform: translateY(0);
    }
    .cdz-followup:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px
        color-mix(in srgb, var(--cdz-fu-accent) 45%, transparent);
    }
    @media (prefers-reduced-motion: reduce) {
      .cdz-followup {
        transition: none;
      }
      .cdz-followup:hover,
      .cdz-followup:active {
        transform: none;
      }
    }

    /*
     * Streaming tail caret.
     *
     * While the answer is actively streaming (host reflects
     * data-status="transmitting") a soft gradient caret pulses at the very end
     * of the flowed content. It is an inline ::after on the content wrapper, so
     * it naturally trails the last streamed token; when the stream finishes the
     * status attribute flips and the pseudo-element (and its animation) is
     * dropped in the same frame — no teardown code, no leftover node. Only
     * opacity/transform animate, so it stays on the GPU compositor. During the
     * pre-token "loading" phase <ai-loading> is shown instead, so the caret is
     * correctly scoped to transmitting only.
     */
    chat-message-assistant[data-status='transmitting'] .item-wrapper::after {
      content: '';
      display: inline-block;
      width: 0.5em;
      height: 1.05em;
      margin-left: 2px;
      vertical-align: text-bottom;
      border-radius: 2px;
      background: linear-gradient(
        180deg,
        #2f7bff,
        #8b5cf6 55%,
        color-mix(in srgb, #10a37f 85%, transparent)
      );
      background-size: 100% 220%;
      box-shadow: 0 0 8px color-mix(in srgb, #2f7bff 55%, transparent);
      transform-origin: center bottom;
      animation:
        cdz-caret-pulse 1.05s ease-in-out infinite,
        cdz-caret-sheen 2.4s linear infinite;
    }
    @keyframes cdz-caret-pulse {
      0%,
      100% {
        opacity: 0.35;
        transform: scaleY(0.82);
      }
      50% {
        opacity: 1;
        transform: scaleY(1);
      }
    }
    @keyframes cdz-caret-sheen {
      from {
        background-position: 0 0;
      }
      to {
        background-position: 0 -220%;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      chat-message-assistant[data-status='transmitting'] .item-wrapper::after {
        animation: none;
        opacity: 0.7;
        transform: none;
      }
    }
  `;

  @property({ attribute: false })
  accessor host: EditorHost | null | undefined;

  @property({ attribute: false })
  accessor std: BlockStdScope | null | undefined;

  @property({ attribute: false })
  accessor item!: ChatMessage;

  @property({ attribute: false })
  accessor isLast: boolean = false;

  @property({ attribute: 'data-status', reflect: true })
  accessor status: ChatStatus = 'idle';

  @property({ attribute: false })
  accessor error: AIError | null = null;

  @property({ attribute: false })
  accessor extensions!: ExtensionType[];

  @property({ attribute: false })
  accessor affineFeatureFlagService!: FeatureFlagService;

  @property({ attribute: false })
  accessor affineThemeService!: AppThemeService;

  @property({ attribute: false })
  accessor session!: CopilotChatHistoryFragment | null | undefined;

  @property({ attribute: false })
  accessor retry!: () => void;

  @property({ attribute: 'data-testid', reflect: true })
  accessor testId = 'chat-message-assistant';

  @property({ attribute: false })
  accessor width: Signal<number | undefined> | undefined;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor independentMode: boolean | undefined;

  @property({ attribute: false })
  accessor docDisplayService!: DocDisplayConfig;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  @property({ attribute: false })
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  // Text of the user message this pending answer replies to (first ~100 chars),
  // forwarded to the loading indicator's reasoning-pulse ticker as its `task`.
  @property({ attribute: false })
  accessor pulseTask = '';

  // AI-upgraded follow-up pairs for THIS message; null until the fetch lands
  // (the deterministic French heuristic row renders in the meantime).
  @state()
  private accessor _followUps: Array<{ label: string; prompt: string }> | null =
    null;

  // Guards against an out-of-date fetch overwriting a newer message's row.
  private _followUpsRunId = 0;
  private _followUpsFetchedFor = '';

  get state() {
    const { isLast, status } = this;
    return isLast
      ? status !== 'loading' && status !== 'transmitting'
        ? 'finished'
        : 'generating'
      : 'finished';
  }

  renderHeader() {
    const isWithDocs =
      'content' in this.item &&
      this.item.content &&
      this.item.content.includes('[^') &&
      /\[\^\d+\]:{"type":"doc","docId":"[^"]+"}/.test(this.item.content);

    return html`<div class="user-info">
      <chat-assistant-avatar .status=${this.status}></chat-assistant-avatar>
      ${isWithDocs
        ? html`<span class="message-info">with your docs</span>`
        : nothing}
    </div>`;
  }

  renderContent() {
    const { host, item, isLast, status, error } = this;
    const { streamObjects, content } = item;
    const shouldRenderError = isLast && status === 'error' && !!error;

    return html`
      ${this.renderImages()}
      ${streamObjects?.length
        ? this.renderStreamObjects(streamObjects)
        : this.renderRichText(content)}
      ${shouldRenderError ? AIChatErrorRenderer(error, host) : nothing}
      ${this.renderEditorActions()} ${this.renderFollowUps()}
    `;
  }

  protected override updated() {
    // Fetch AI-upgraded follow-ups once per settled message. The row renders the
    // instant French heuristic immediately; this upgrades it in place. Keyed on
    // the message id + settled status so a re-send / retry re-fetches.
    const { isLast, status, item } = this;
    const settled = status === 'success' || status === 'idle';
    const key = settled && isLast && item.content ? `${item.id}:${status}` : '';
    if (key && key !== this._followUpsFetchedFor) {
      this._followUpsFetchedFor = key;
      this._followUps = null;
      void this._fetchFollowUps();
    }
  }

  private renderImages() {
    const { item } = this;
    if (!item.attachments) return nothing;

    return html`<chat-content-images
      .images=${item.attachments}
      .layout=${'column'}
    ></chat-content-images>`;
  }

  private renderStreamObjects(answer: StreamObject[]) {
    return html`<chat-content-stream-objects
      .host=${this.host}
      .std=${this.std}
      .answer=${answer}
      .state=${this.state}
      .width=${this.width}
      .extensions=${this.extensions}
      .affineFeatureFlagService=${this.affineFeatureFlagService}
      .notificationService=${this.notificationService}
      .theme=${this.affineThemeService.appTheme.themeSignal}
      .independentMode=${this.independentMode}
      .docDisplayService=${this.docDisplayService}
      .peekViewService=${this.peekViewService}
      .onOpenDoc=${this.onOpenDoc}
    ></chat-content-stream-objects>`;
  }

  private renderRichText(text: string) {
    return html`<chat-content-rich-text
      .text=${text}
      .state=${this.state}
      .extensions=${this.extensions}
      .affineFeatureFlagService=${this.affineFeatureFlagService}
      .theme=${this.affineThemeService.appTheme.themeSignal}
    ></chat-content-rich-text>`;
  }

  /**
   * Follow-up suggestions, decoupled: a short French LABEL on the chip, a rich
   * self-contained PROMPT that is what actually gets sent on click.
   *
   * Two layers, per the modern pattern (Perplexity "Related", Theo's
   * follow_ups: [{label, prompt}]): an instant deterministic FRENCH fallback
   * renders immediately (never an empty row), and a fast-model call to
   * POST /api/v1/ai/suggestions upgrades it with pairs grounded in the actual
   * question + answer. The model labels stay questions (≤ ~9 words); the
   * prompts are 1-2 sentence instructions that stand alone, so clicking a chip
   * sends a fully-formed next turn — not a bare 3-word label. French-first to
   * match the product voice (quick-starts are French; these were English, an
   * inconsistency the user flagged).
   */
  private _cdzHeuristicFollowUps(): Array<{ label: string; prompt: string }> {
    const { item } = this;
    const text = item.content ?? '';

    const tools = new Set<string>();
    for (const object of item.streamObjects ?? []) {
      if (object.type === 'tool-call' || object.type === 'tool-result') {
        tools.add(object.toolName);
      }
    }

    const out: Array<{ label: string; prompt: string }> = [];
    const add = (label: string, prompt: string) => {
      if (out.length < 3 && !out.some(f => f.label === label))
        out.push({ label, prompt });
    };

    // 1. What this turn produced.
    if (tools.has('clickdz_app')) {
      add(
        'Rendre cela plus abouti ?',
        'Peux-tu rendre cette application plus aboutie : meilleure mise en page, transitions et finition visuelle ?'
      );
      add(
        'Ajouter une fonctionnalité utile ?',
        'Ajoute une fonctionnalité vraiment utile à cette application, adaptée à mon activité.'
      );
    }
    if (item.attachments?.length) {
      add(
        'Créer une variante raffinée ?',
        'Crée une variante plus raffinée de ce résultat, avec un rendu plus soigné.'
      );
      add(
        'Le rendre plus cinématographique ?',
        'Rends ce résultat plus cinématographique : lumière, cadrage et ambiance.'
      );
    }

    // 2. How the answer is shaped.
    if (text.includes('```')) {
      add(
        'M’expliquer ce code pas à pas ?',
        'Peux-tu m’expliquer ce code pas à pas, en français, de façon simple ?'
      );
      add(
        'Ajouter la gestion des erreurs ?',
        'Ajoute une gestion des erreurs robuste à ce code, en expliquant chaque ajout.'
      );
    }
    if (/^\s*\|.*\|/m.test(text)) {
      add(
        'Transformer ces données en graphique ?',
        'Transforme ces données en un graphique clair et lisible, avec un titre et des libellés en français.'
      );
    }
    if (/^\s*(?:\d+[.)]|[-*+])\s+\S/m.test(text)) {
      add(
        'Transformer en plan d’action ?',
        'Transforme cette réponse en plan d’action clair, étape par étape, que je peux suivre.'
      );
    }
    if (/https?:\/\//.test(text)) {
      add(
        'Résumer les sources ?',
        'Peux-tu résumer les points clés des sources citées dans cette réponse ?'
      );
    }

    // 3. Bulk heuristics — a wall of text and a one-liner want opposite things.
    if (text.length > 1400) {
      add(
        'Résumer en trois points ?',
        'Résume cette réponse en trois points clés, simples et directs.'
      );
    }
    if (text.length > 0 && text.length < 320) {
      add(
        'Approfondir avec des exemples ?',
        'Peux-tu approfondir cette réponse avec des exemples concrets adaptés à mon activité ?'
      );
    }

    // 4. Backstop, so the row is never empty.
    add(
      'Approfondir avec des exemples ?',
      'Peux-tu approfondir cette réponse avec des exemples concrets adaptés à mon activité ?'
    );
    add(
      'Transformer en plan d’action ?',
      'Transforme cette réponse en plan d’action clair, étape par étape, que je peux suivre.'
    );

    return out;
  }

  private async _fetchFollowUps() {
    const { item } = this;
    const runId = ++this._followUpsRunId;
    const answer = (item.content ?? '').slice(0, 2000);
    if (!answer) return;
    const question = (this.pulseTask ?? '').slice(0, 2000);
    try {
      const res = await fetch(cdzApiUrl('/api/v1/ai/suggestions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { suggestions?: unknown };
      // Ignore if a newer fetch started (message flipped / re-sent).
      if (runId !== this._followUpsRunId) return;
      const list = Array.isArray(data?.suggestions) ? data.suggestions : [];
      const cleaned: Array<{ label: string; prompt: string }> = [];
      for (const s of list) {
        if (!s || typeof s !== 'object') continue;
        const label = String((s as any).label ?? '').trim();
        const prompt = String((s as any).prompt ?? '').trim();
        if (label && prompt) cleaned.push({ label, prompt });
        if (cleaned.length >= 3) break;
      }
      if (cleaned.length) this._followUps = cleaned;
    } catch {
      // Cosmetic route — keep the heuristic row on any failure.
    }
  }

  /**
   * Classify a follow-up into one of three intents for its visual identity:
   *   · actionable — "turn this into a plan / do it / build / create"
   *   · reframe    — "summarise / simplify / rephrase / shorter"
   *   · deepen     — the default (explain more, examples, go further)
   * A light FR/EN keyword heuristic on the label+prompt; cosmetic only, so a
   * misclassification just picks a different accent/glyph, never a wrong action.
   */
  private _cdzFollowUpIntent(f: {
    label: string;
    prompt: string;
  }): 'deepen' | 'actionable' | 'reframe' {
    const text = `${f.label} ${f.prompt}`.toLowerCase();
    if (
      /(r[ée]sum|simplif|reformul|synth[èe]|plus court|en trois|en 3|shorter|summar)/.test(
        text
      )
    ) {
      return 'reframe';
    }
    if (
      /(plan d.?action|[ée]tape|transforme|cr[ée]e|construis|g[ée]n[èe]re|ajoute|fais(-| )|action|build|create|turn (this|it) into|step)/.test(
        text
      )
    ) {
      return 'actionable';
    }
    return 'deepen';
  }

  private renderFollowUps() {
    const { isLast, status, host } = this;
    if (!isLast || !host || (status !== 'success' && status !== 'idle')) {
      return nothing;
    }
    const suggestions = this._followUps ?? this._cdzHeuristicFollowUps();
    return html`<div class="cdz-followups" data-testid="clickdz-followups">
      <span class="cdz-followups-title">À approfondir</span>
      <div class="cdz-followups-row">
        ${suggestions.map(s => {
          const intent = this._cdzFollowUpIntent(s);
          return html`<button
            class="cdz-followup cdz-fu-${intent}"
            data-intent=${intent}
            title=${s.prompt}
            @click=${() =>
              AIAppEvents.requestOpenWithChat.next({
                host,
                input: s.prompt,
                fromAnswer: true,
              })}
          >
            ${s.label}
          </button>`;
        })}
      </div>
    </div>`;
  }

  private renderEditorActions() {
    const { item, isLast, status, host, session } = this;

    if (!isChatMessage(item) || item.role !== 'assistant') return nothing;

    if (
      isLast &&
      status !== 'success' &&
      status !== 'idle' &&
      status !== 'error'
    )
      return nothing;

    const { content, streamObjects, id: messageId } = item;
    const markdown = streamObjects?.length
      ? mergeStreamContent(streamObjects)
      : content;

    const actions = host
      ? isInsidePageEditor(host)
        ? PageEditorActions
        : EdgelessEditorActions
      : null;

    const showActions = host && !!markdown && !this.independentMode;

    return html`
      <chat-copy-more
        .host=${host}
        .session=${session}
        .actions=${showActions ? actions : []}
        .content=${markdown}
        .isLast=${isLast}
        .messageId=${messageId}
        .withMargin=${true}
        .retry=${() => this.retry()}
        .notificationService=${this.notificationService}
      ></chat-copy-more>
      ${isLast && showActions
        ? html`<chat-action-list
            .actions=${actions}
            .host=${host}
            .session=${session}
            .content=${markdown}
            .messageId=${messageId ?? undefined}
            .withMargin=${true}
            .notificationService=${this.notificationService}
          ></chat-action-list>`
        : nothing}
    `;
  }

  protected override render() {
    const { isLast, status } = this;

    if (isLast && status === 'loading') {
      return html`<ai-loading .task=${this.pulseTask}></ai-loading>`;
    }

    // aria-live="polite" lets screen readers announce the streamed assistant
    // answer as it fills in; aria-atomic="false" announces only the newly
    // appended text rather than re-reading the whole answer on each token.
    return html`
      ${this.renderHeader()}
      <div class="item-wrapper" aria-live="polite" aria-atomic="false">
        ${this.renderContent()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-message-assistant': ChatMessageAssistant;
  }
}
