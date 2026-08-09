// modules/stickers/senior-tool.ts
//
// P5/E1 — Discoverable "Stickers" senior tool for the main edgeless toolbar.
//
// Registers a SeniorToolExtension('cdz-sticker', …) that renders an
// <edgeless-cdz-sticker-button> in the main edgeless toolbar.
// The button opens a popover panel with:
//   • a proper prompt input (replaces the old window.prompt)
//   • an optional "Animer" toggle with preset selector
//   • "Generer" -> generateStickerImage -> ingestStickerAsset -> addSticker
//   • on animated: animateImageBlobToSticker(preset)
//
// Gated by enable_cdz_sticker_ai. Additive — the element-toolbar actions in
// toolbar.ts (Animate / Generate variant on selected sticker/image) are kept.

import { toast } from '@blocksuite/affine/components/toast';
import { FeatureFlagService } from '@blocksuite/affine/shared/services';
import { SeniorToolExtension } from '@blocksuite/affine-widget-edgeless-toolbar';
import { WithDisposable } from '@blocksuite/global/lit';
import type { BlockComponent } from '@blocksuite/std';
import type { GfxController } from '@blocksuite/std/gfx';
import { SmileIcon } from '@blocksuite/icons/lit';
import { css, html, LitElement, type TemplateResult } from 'lit';
import { property, query, state } from 'lit/decorators.js';

import { animateImageBlobToSticker } from './animate';
import { generateStickerImage } from './generate';
import {
  DEFAULT_STICKER_ANIM_PRESET,
  STICKER_ANIM_PRESET_LABELS,
  STICKER_ANIM_PRESETS,
  type StickerAnimPreset,
} from './lottie-presets';
import { addSticker, ingestStickerAsset } from './provider';

const FLAG = 'enable_cdz_sticker_ai';

// ---------------------------------------------------------------------------
// <edgeless-cdz-sticker-button> — senior tool panel button
// ---------------------------------------------------------------------------

export class EdgelessCdzStickerButton extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      position: relative;
      display: block;
    }

    .cdz-trigger {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 64px;
      cursor: pointer;
      gap: 4px;
      color: var(--affine-icon-color);
    }

    .cdz-trigger svg {
      width: 24px;
      height: 24px;
    }

    .cdz-label {
      font-size: 10px;
      font-family: var(--affine-font-family);
      color: var(--affine-text-secondary-color);
      white-space: nowrap;
    }

    /* Popover panel */
    .cdz-panel {
      position: fixed;
      bottom: 106px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 9999;
      background: var(--affine-background-overlay-panel-color, #fff);
      border: 1px solid var(--affine-border-color, #e3e2e4);
      border-radius: 12px;
      box-shadow: var(--affine-menu-shadow, 0 4px 24px rgba(0, 0, 0, 0.14));
      padding: 20px;
      width: 320px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .cdz-panel[hidden] {
      display: none;
    }

    .cdz-panel-title {
      font-size: 14px;
      font-weight: 600;
      font-family: var(--affine-font-family);
      color: var(--affine-text-primary-color);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .cdz-panel-title svg {
      width: 18px;
      height: 18px;
    }

    .cdz-row {
      display: flex;
      gap: 8px;
    }

    .cdz-input {
      flex: 1;
      border: 1.5px solid var(--affine-border-color, #e3e2e4);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
      font-family: var(--affine-font-family);
      color: var(--affine-text-primary-color);
      background: var(--affine-background-primary-color, #fff);
      outline: none;
      transition: border-color 0.15s;
      /* WS17: the edgeless canvas + toolbar set user-select:none which INHERITS
         into this shadow-DOM input — on mobile/iOS that prevents focus/typing.
         Override so the input is always editable. */
      user-select: text;
      -webkit-user-select: text;
    }

    .cdz-input:focus {
      border-color: var(--affine-primary-color, #1e96eb);
    }

    .cdz-btn {
      flex-shrink: 0;
      padding: 0 16px;
      height: 36px;
      border-radius: 8px;
      border: none;
      background: var(--affine-primary-color, #1e96eb);
      color: #fff;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;
    }

    .cdz-btn:hover:not(:disabled) {
      opacity: 0.88;
    }

    .cdz-btn:disabled {
      opacity: 0.45;
      cursor: default;
    }

    .cdz-opts {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .cdz-animate-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--affine-text-secondary-color);
      font-family: var(--affine-font-family);
      cursor: pointer;
      user-select: none;
    }

    .cdz-animate-toggle input {
      width: 14px;
      height: 14px;
      cursor: pointer;
    }

    .cdz-preset-sel {
      border: 1px solid var(--affine-border-color, #e3e2e4);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 12px;
      font-family: var(--affine-font-family);
      background: var(--affine-background-primary-color, #fff);
      color: var(--affine-text-primary-color);
      cursor: pointer;
    }

    .cdz-hint {
      font-size: 11px;
      color: var(--affine-text-secondary-color);
      font-family: var(--affine-font-family);
      line-height: 1.5;
    }
  `;

  @property({ attribute: false })
  accessor block!: BlockComponent;

  @property({ attribute: false })
  accessor gfx!: GfxController;

  @state()
  private accessor _open = false;

  @state()
  private accessor _loading = false;

  @state()
  private accessor _animated = false;

  @state()
  private accessor _preset: StickerAnimPreset = DEFAULT_STICKER_ANIM_PRESET;

  @query('.cdz-input')
  private accessor _input!: HTMLInputElement | null;

  private _toggle() {
    this._open = !this._open;
    if (this._open) {
      requestAnimationFrame(() => this._input?.focus());
    }
  }

  private _close() {
    this._open = false;
  }

  private async _generate() {
    const prompt = this._input?.value?.trim();
    if (!prompt || this._loading) return;
    this._loading = true;

    toast(this.block.host, 'Génération du sticker…');
    const { blob, fail } = await generateStickerImage({
      prompt,
      model: 'cdzimage-2.0',
    });

    if (!blob) {
      this._loading = false;
      toast(
        this.block.host,
        fail === 'aiUnavailable'
          ? 'Service IA indisponible'
          : 'Impossible de générer le sticker'
      );
      return;
    }

    try {
      if (this._animated) {
        await animateImageBlobToSticker(this.block.std, blob, {
          preset: this._preset,
        });
        toast(this.block.host, 'Sticker animé ajouté');
      } else {
        const sourceId = await ingestStickerAsset(this.block.std, blob);
        addSticker(this.block.std, sourceId, 'static');
        toast(this.block.host, 'Sticker ajouté');
      }
      if (this._input) this._input.value = '';
      this._close();
    } catch {
      toast(this.block.host, 'Impossible de placer le sticker');
    } finally {
      this._loading = false;
    }
  }

  private _onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void this._generate();
    } else if (e.key === 'Escape') {
      this._close();
    }
  }

  override render(): TemplateResult {
    const presetOpts = this._animated
      ? html`<select
          class="cdz-preset-sel"
          .value=${this._preset}
          @change=${(e: Event) => {
            this._preset = (e.target as HTMLSelectElement)
              .value as StickerAnimPreset;
          }}
        >
          ${STICKER_ANIM_PRESETS.map(
            p => html`<option value=${p}>${STICKER_ANIM_PRESET_LABELS[p]}</option>`
          )}
        </select>`
      : null;

    return html`
      <edgeless-toolbar-button @click=${this._toggle}>
        <div class="cdz-trigger">
          ${SmileIcon()}
          <span class="cdz-label">Stickers</span>
        </div>
      </edgeless-toolbar-button>

      <div class="cdz-panel" ?hidden=${!this._open}>
        <div class="cdz-panel-title">${SmileIcon()} Générer un sticker IA</div>

        <div class="cdz-row">
          <input
            class="cdz-input"
            type="text"
            placeholder="Ex: avocat souriant, chat astronaute…"
            ?disabled=${this._loading}
            @keydown=${this._onKey}
          />
          <button
            class="cdz-btn"
            ?disabled=${this._loading}
            @click=${() => this._generate()}
          >
            ${this._loading ? 'Chargement…' : 'Générer'}
          </button>
        </div>

        <div class="cdz-opts">
          <label class="cdz-animate-toggle">
            <input
              type="checkbox"
              .checked=${this._animated}
              @change=${(e: Event) => {
                this._animated = (e.target as HTMLInputElement).checked;
              }}
            />
            Animer
          </label>
          ${presetOpts}
        </div>

        <div class="cdz-hint">
          Fond transparent, contour blanc. Placé au centre du canvas.
        </div>
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// Factory — returns the ExtensionType for get-config.ts
// ---------------------------------------------------------------------------

function isFlagOn(block: BlockComponent): boolean {
  try {
    const ffs = block.std.get(FeatureFlagService);
    return !!ffs.getFlag(FLAG);
  } catch {
    return false;
  }
}

export const cdzStickerSeniorTool = SeniorToolExtension(
  'cdz-sticker',
  ({ block, gfx }) => ({
    name: 'Stickers',
    enable: isFlagOn(block),
    content: html`<edgeless-cdz-sticker-button
      .block=${block}
      .gfx=${gfx}
    ></edgeless-cdz-sticker-button>`,
  })
);
