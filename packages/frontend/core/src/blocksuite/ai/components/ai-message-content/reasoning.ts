import type { FeatureFlagService } from '@affine/core/modules/feature-flag';
import type { ColorScheme } from '@blocksuite/affine/model';
import { ShadowlessElement } from '@blocksuite/affine/std';
import type { ExtensionType } from '@blocksuite/affine/store';
import type { Signal } from '@preact/signals-core';
import { css, html, nothing } from 'lit';
import { property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

import type { AffineAIPanelState } from '../../widgets/ai-panel/type';

/**
 * Renders one assistant message's reasoning ("thinking") section.
 *
 * Lifecycle, driven entirely by the two inputs `text` + `active`:
 *  - WHILE the model is reasoning (`active` true): an auto-expanded, collapsible
 *    panel with a shimmering "Réflexion…" header + a live elapsed-seconds
 *    counter, streaming the reasoning text in a muted style.
 *  - ONCE the answer starts / the turn finishes (`active` false): the panel
 *    auto-collapses to a single-line summary chip ("Raisonnement · 4s") the
 *    reader can click to re-expand. The user's manual expand/collapse always
 *    wins over the auto behavior once they've interacted.
 *
 * Purely presentational — it never fetches anything (unlike the retired
 * cdz-pulse-ticker, which faked reasoning by streaming canned phrases from the
 * server). The text shown here is the model's real reasoning stream.
 */
export class ChatContentReasoning extends ShadowlessElement {
  static override styles = css`
    chat-content-reasoning {
      display: block;
      margin: 4px 0 10px;
    }

    .cdz-reasoning {
      border: 1px solid var(--affine-border-color);
      border-radius: 10px;
      background: var(--affine-background-secondary-color);
      overflow: hidden;
      transition: background 0.2s ease;
    }
    .cdz-reasoning.active {
      border-color: color-mix(in srgb, #8b5cf6 32%, transparent);
      background: color-mix(
        in srgb,
        #8b5cf6 5%,
        var(--affine-background-secondary-color)
      );
    }

    .cdz-reasoning-header {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      box-sizing: border-box;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      border: none;
      background: transparent;
      color: var(--affine-text-secondary-color);
      font-family: inherit;
      font-size: var(--affine-font-xs);
      font-weight: 500;
      text-align: left;
    }
    .cdz-reasoning-header:hover {
      color: var(--affine-text-primary-color);
    }

    .cdz-reasoning-dot {
      flex: 0 0 8px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-image: linear-gradient(135deg, #5b8cff, #a06bff);
    }
    .cdz-reasoning.active .cdz-reasoning-dot {
      animation: cdz-reasoning-pulse 1.4s ease-in-out infinite;
    }

    /* Shimmer only rides the label while reasoning is live. */
    .cdz-reasoning-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .cdz-reasoning.active .cdz-reasoning-label {
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
      animation: cdz-reasoning-shimmer 2s linear infinite;
    }

    .cdz-reasoning-elapsed {
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
      color: var(--affine-text-secondary-color);
      opacity: 0.85;
    }

    .cdz-reasoning-caret {
      flex-shrink: 0;
      display: inline-flex;
      transition: transform 0.2s ease;
    }
    .cdz-reasoning.expanded .cdz-reasoning-caret {
      transform: rotate(90deg);
    }

    .cdz-reasoning-body {
      padding: 0 12px 12px 28px;
      color: var(--affine-text-secondary-color);
      font-size: var(--affine-font-sm);
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      /* muted, slightly de-emphasized vs. the final answer */
      opacity: 0.9;
    }

    @keyframes cdz-reasoning-pulse {
      0%,
      100% {
        transform: scale(0.82);
        opacity: 0.85;
      }
      50% {
        transform: scale(1.12);
        opacity: 1;
      }
    }
    @keyframes cdz-reasoning-shimmer {
      from {
        background-position: 200% 0;
      }
      to {
        background-position: -200% 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .cdz-reasoning.active .cdz-reasoning-dot,
      .cdz-reasoning.active .cdz-reasoning-label {
        animation: none;
      }
      .cdz-reasoning.active .cdz-reasoning-label {
        -webkit-text-fill-color: var(--affine-text-secondary-color);
      }
    }
  `;

  /** The accumulated reasoning text streamed so far. */
  @property({ attribute: false })
  accessor text = '';

  /** True while the model is still emitting reasoning (pre-answer). */
  @property({ attribute: false })
  accessor active = false;

  @property({ attribute: false })
  accessor state: AffineAIPanelState = 'finished';

  @property({ attribute: false })
  accessor extensions: ExtensionType[] | undefined;

  @property({ attribute: false })
  accessor affineFeatureFlagService: FeatureFlagService | undefined;

  @property({ attribute: false })
  accessor theme: Signal<ColorScheme> | undefined;

  // Undefined = follow the auto behavior (open while active, closed after).
  // Once the user clicks, their explicit choice sticks.
  @state()
  private accessor _userExpanded: boolean | undefined = undefined;

  // Elapsed reasoning seconds. Started on first activation, frozen when the
  // reasoning phase ends so the summary chip keeps the final duration.
  @state()
  private accessor _elapsed = 0;

  private _startedAt: number | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;

  private get _expanded() {
    return this._userExpanded ?? this.active;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('active')) {
      if (this.active && this._startedAt === null) {
        this._startedAt = Date.now();
        this._tick();
        this._timer = setInterval(() => this._tick(), 500);
      } else if (!this.active) {
        this._freeze();
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._clearTimer();
  }

  private _tick() {
    if (this._startedAt === null) return;
    this._elapsed = Math.max(0, Math.round((Date.now() - this._startedAt) / 1000));
  }

  private _freeze() {
    if (this._startedAt !== null) {
      this._tick();
    }
    this._clearTimer();
  }

  private _clearTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private _toggle() {
    this._userExpanded = !this._expanded;
  }

  override render() {
    if (!this.text && !this.active) return nothing;

    const expanded = this._expanded;
    const label = this.active
      ? 'Réflexion…'
      : this._elapsed > 0
        ? `Raisonnement · ${this._elapsed}s`
        : 'Raisonnement';

    return html`
      <div
        class=${classMap({
          'cdz-reasoning': true,
          active: this.active,
          expanded,
        })}
      >
        <button
          class="cdz-reasoning-header"
          type="button"
          aria-expanded=${expanded ? 'true' : 'false'}
          @click=${this._toggle}
          data-testid="chat-reasoning-toggle"
        >
          <span class="cdz-reasoning-dot" aria-hidden="true"></span>
          <span class="cdz-reasoning-label">${label}</span>
          ${this.active && this._elapsed > 0
            ? html`<span class="cdz-reasoning-elapsed">${this._elapsed}s</span>`
            : nothing}
          <span class="cdz-reasoning-caret" aria-hidden="true">›</span>
        </button>
        ${expanded && this.text
          ? html`<div
              class="cdz-reasoning-body"
              data-testid="chat-reasoning-body"
            >
              ${this.text}
            </div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-content-reasoning': ChatContentReasoning;
  }
}
