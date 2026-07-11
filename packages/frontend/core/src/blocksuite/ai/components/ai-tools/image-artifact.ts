/**
 * In-chat Image Artifact — replaces the orphan floating image modal UX.
 * Card lives in the message stream; full view uses ArtifactPreviewPanel.
 * Artifacts are persisted via artifactStore so Close does not lose them.
 */
import { WithDisposable } from '@blocksuite/affine/global/lit';
import { unsafeCSSVarV2 } from '@blocksuite/affine/shared/theme';
import { ShadowlessElement } from '@blocksuite/affine/std';
import { DownloadIcon, ResetIcon } from '@blocksuite/icons/lit';
import { css, html, nothing } from 'lit';
import { property } from 'lit/decorators.js';

import {
  artifactStore,
  newArtifactId,
  type CdzArtifact,
} from '../../../../modules/ai-artifacts/store';
import { renderPreviewPanel } from './artifacts-preview-panel';

/**
 * Lightweight host used when an image finishes generating (e.g. from ChatCopyMore).
 * Renders an elegant in-thread card and opens the split ArtifactPreviewPanel.
 */
export class ImageArtifactHost extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    :host {
      display: block;
      margin: 8px 0;
      max-width: 420px;
    }

    .cdz-image-card {
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid ${unsafeCSSVarV2('layer/insideBorder/border')};
      background: ${unsafeCSSVarV2('layer/background/secondary')};
      cursor: pointer;
      transition: box-shadow 0.15s ease;
    }

    .cdz-image-card:hover {
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.25);
    }

    .cdz-image-card img {
      width: 100%;
      display: block;
      max-height: 320px;
      object-fit: contain;
      background: #0a0a0a;
    }

    .cdz-image-card-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      font-size: 13px;
      color: ${unsafeCSSVarV2('text/secondary')};
    }

    .cdz-image-card-actions {
      display: flex;
      gap: 6px;
      padding: 0 12px 10px;
    }

    .cdz-image-card-btn {
      background: transparent;
      border-radius: 8px;
      border: 1px solid ${unsafeCSSVarV2('button/innerBlackBorder')};
      cursor: pointer;
      font-size: 13px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 10px;
      height: 28px;
      font-weight: 500;
      color: ${unsafeCSSVarV2('text/primary')};
    }

    .cdz-image-card-btn:hover {
      background: ${unsafeCSSVarV2('layer/background/hoverOverlay')};
    }
  `;

  @property({ attribute: false })
  accessor artifact: CdzArtifact | null = null;

  @property({ attribute: false })
  accessor onRegenerate: ((prompt: string) => void) | undefined = undefined;

  @property({ type: Boolean })
  accessor autoOpenPanel = true;

  override connectedCallback() {
    super.connectedCallback();
    if (this.artifact && this.autoOpenPanel) {
      queueMicrotask(() => this.openPanel());
    }
  }

  openPanel = () => {
    if (!this.artifact) return;
    const art = this.artifact;

    const content = html`<div
      style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--affine-background-secondary-color);overflow:auto;padding:16px;box-sizing:border-box;"
    >
      <img
        src=${art.payload}
        alt=${art.title}
        style="max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;"
      />
    </div>`;

    const download = (e: Event) => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = art.payload;
      a.download = `${art.title || 'clickdz-image'}.png`;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      a.remove();
    };

    const regenerate = (e: Event) => {
      e.stopPropagation();
      if (art.prompt && this.onRegenerate) this.onRegenerate(art.prompt);
    };

    const controls = html`
      <button
        style="background:transparent;border-radius:8px;border:1px solid var(--affine-border-color);cursor:pointer;font-size:14px;display:inline-flex;align-items:center;gap:4px;padding:0 10px;height:32px;font-weight:500;"
        @click=${download}
      >
        ${DownloadIcon({ width: '18', height: '18' })} Download
      </button>
      ${art.prompt && this.onRegenerate
        ? html`<button
            style="background:transparent;border-radius:8px;border:1px solid var(--affine-border-color);cursor:pointer;font-size:14px;display:inline-flex;align-items:center;gap:4px;padding:0 10px;height:32px;font-weight:500;"
            @click=${regenerate}
          >
            ${ResetIcon({ width: '18', height: '18' })} Regenerate
          </button>`
        : nothing}
    `;

    renderPreviewPanel(this, content, controls);
  };

  private _download = (e: Event) => {
    e.stopPropagation();
    if (!this.artifact) return;
    const a = document.createElement('a');
    a.href = this.artifact.payload;
    a.download = `${this.artifact.title || 'clickdz-image'}.png`;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  };

  private _regenerate = (e: Event) => {
    e.stopPropagation();
    if (this.artifact?.prompt && this.onRegenerate) {
      this.onRegenerate(this.artifact.prompt);
    }
  };

  override render() {
    if (!this.artifact) return nothing;
    const art = this.artifact;
    return html`
      <div
        class="cdz-image-card"
        data-testid="image-artifact-inline"
        data-artifact-id=${art.id}
        @click=${this.openPanel}
      >
        <img src=${art.payload} alt=${art.title} />
        <div class="cdz-image-card-meta">
          <span>${art.title}</span>
          <span>Open</span>
        </div>
        <div class="cdz-image-card-actions">
          <button class="cdz-image-card-btn" @click=${this._download}>
            ${DownloadIcon({ width: '16', height: '16' })} Download
          </button>
          ${art.prompt && this.onRegenerate
            ? html`<button
                class="cdz-image-card-btn"
                @click=${this._regenerate}
              >
                ${ResetIcon({ width: '16', height: '16' })} Regenerate
              </button>`
            : nothing}
        </div>
      </div>
    `;
  }
}

/** Persist generated image so Close never loses it. */
export function persistGeneratedImage(opts: {
  url: string;
  title?: string;
  prompt?: string;
  sessionId?: string;
  messageId?: string;
}): CdzArtifact {
  return artifactStore.upsert({
    id: newArtifactId('img'),
    type: 'image',
    title: opts.title || 'Generated image',
    payload: opts.url,
    prompt: opts.prompt,
    sessionId: opts.sessionId,
    messageId: opts.messageId,
    mimeType: 'image/png',
  });
}

declare global {
  interface HTMLElementTagNameMap {
    'image-artifact-host': ImageArtifactHost;
  }
}
