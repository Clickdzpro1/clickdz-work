import { ResourceController } from '@blocksuite/affine-components/resource';
import type { StickerBlockModel } from '@blocksuite/affine-model';
import { GfxBlockComponent } from '@blocksuite/std/gfx';
import { computed } from '@preact/signals-core';
import { css, html, nothing } from 'lit';
import { query } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

export class StickerBlockComponent extends GfxBlockComponent<StickerBlockModel> {
  static override styles = css`
    :host {
      display: block;
      border-radius: 8px;
      overflow: hidden;
    }
    img {
      width: 100%;
      height: 100%;
      display: block;
      border-radius: 8px;
      filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.15));
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
      border-radius: 8px;
    }
  `;

  resourceController = new ResourceController(
    computed(() => this.model.props.sourceId$.value),
    'Sticker'
  );

  @query('canvas')
  accessor lottieCanvas!: HTMLCanvasElement | null;
  #lottieModule: any = null;
  #lottieInstance: any = null;

  get blobUrl() {
    return this.resourceController.blobUrl$.value;
  }

  get isAnimated() {
    return this.model.props.stickerType$.value === 'animated';
  }
  get animSrc() {
    return this.model.props.animSrc$.value;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.resourceController.setEngine(this.std.store.blobSync);
  }

  override updated() {
    if (this.isAnimated) void this.#renderLottie();
  }

  override disconnectedCallback() {
    this.#destroyLottie();
    super.disconnectedCallback();
  }

  async #loadLottie() {
    if (this.#lottieModule) return;
    this.#lottieModule = await import('@lottiefiles/dotlottie-web');
  }

  async #renderLottie() {
    if (!this.lottieCanvas) return;
    await this.#loadLottie();
    const url = this.blobUrl;
    if (!url || !this.#lottieModule) return;
    const { DotLottie } = this.#lottieModule;
    this.#destroyLottie();
    this.#lottieInstance = new DotLottie({
      canvas: this.lottieCanvas,
      src: url,
      autoplay: this.model.props.animAutoplay$.value ?? true,
      loop: true,
      autoResize: true,
      mode: 'forward',
    });
  }

  #destroyLottie() {
    try {
      this.#lottieInstance?.destroy?.();
    } catch {
      /* dispose silently */
    }
    this.#lottieInstance = null;
  }

  override render() {
    if (this.isAnimated) {
      return html`<canvas></canvas>`;
    }
    return html`<img src=${this.blobUrl || nothing} alt="sticker" />`;
  }
}
