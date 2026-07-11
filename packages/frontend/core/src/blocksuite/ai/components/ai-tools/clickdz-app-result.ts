import { unsafeCSSVarV2 } from '@blocksuite/affine/shared/theme';
import { ShadowlessElement } from '@blocksuite/affine/std';
import { css, html, nothing } from 'lit';
import { property, state } from 'lit/decorators.js';

import { artifactStore } from '../../../../modules/ai-artifacts/store';
import type { StreamObject } from '../ai-chat-messages';

type ClickDzAppResult = {
  title: string;
  slug: string;
  html: string;
  size: number;
  url?: string;
};

export class ClickDzAppResultCard extends ShadowlessElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      margin: 10px 0;
    }
    .app-card {
      overflow: hidden;
      border: 1px solid ${unsafeCSSVarV2('layer/insideBorder/border')};
      border-radius: 14px;
      background: ${unsafeCSSVarV2('layer/background/secondary')};
    }
    .app-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      border-bottom: 1px solid ${unsafeCSSVarV2('layer/insideBorder/border')};
    }
    .app-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      color: ${unsafeCSSVarV2('text/primary')};
      font-size: 13px;
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .app-toggle {
      display: flex;
      gap: 2px;
      padding: 2px;
      border-radius: 7px;
      background: ${unsafeCSSVarV2('segment/background')};
    }
    button,
    a {
      border: 1px solid ${unsafeCSSVarV2('layer/insideBorder/border')};
      border-radius: 7px;
      padding: 4px 9px;
      cursor: pointer;
      color: ${unsafeCSSVarV2('text/primary')};
      background: transparent;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
    }
    .app-toggle button {
      border: 0;
    }
    .app-toggle button.active {
      background: ${unsafeCSSVarV2('segment/button')};
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14);
    }
    button.primary {
      border-color: #2f7bff;
      color: white;
      background: #2f7bff;
    }
    button:disabled {
      cursor: wait;
      opacity: 0.6;
    }
    .app-preview {
      height: min(460px, 56vh);
      min-height: 320px;
      background: #fff;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: 0;
      background: #fff;
    }
    pre {
      height: 100%;
      box-sizing: border-box;
      margin: 0;
      padding: 14px;
      overflow: auto;
      color: ${unsafeCSSVarV2('text/primary')};
      background: ${unsafeCSSVarV2('layer/background/primary')};
      font:
        12px/1.55 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
      white-space: pre;
    }
    .app-error {
      padding: 8px 12px;
      color: #c2410c;
      font-size: 12px;
    }
  `;

  @property({ attribute: false })
  accessor data!: StreamObject;

  @state()
  private accessor mode: 'preview' | 'code' = 'preview';

  @state()
  private accessor publishing = false;

  @state()
  private accessor publishedUrl = '';

  @state()
  private accessor error = '';

  private get result(): ClickDzAppResult | null {
    if (
      this.data.type !== 'tool-result' ||
      this.data.toolName !== 'clickdz_app'
    ) {
      return null;
    }
    const result = this.data.result;
    if (!result || typeof result !== 'object' || !('html' in result))
      return null;
    return result as ClickDzAppResult;
  }

  private async publish() {
    const result = this.result;
    if (!result || this.publishing) return;
    this.publishing = true;
    this.error = '';
    try {
      const response = await fetch('/api/v1/apps/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: result.html, slug: result.slug }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          data?.error?.message || `Publish failed (${response.status})`
        );
      }
      this.publishedUrl = String(data.url || '');
      const existing = artifactStore.get(`app_${result.slug}`);
      if (existing) {
        artifactStore.upsert({ ...existing, url: this.publishedUrl });
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Publish failed';
    } finally {
      this.publishing = false;
    }
  }

  protected override render() {
    const result = this.result;
    if (!result) return nothing;
    const url = this.publishedUrl || result.url;
    return html`<section class="app-card" data-testid="clickdz-app-result">
      <div class="app-toolbar">
        <div class="app-title">🚀 ${result.title}</div>
        <div class="app-toggle">
          <button
            class=${this.mode === 'preview' ? 'active' : ''}
            @click=${() => (this.mode = 'preview')}
          >
            Preview
          </button>
          <button
            class=${this.mode === 'code' ? 'active' : ''}
            @click=${() => (this.mode = 'code')}
          >
            Code
          </button>
        </div>
        <button
          class="primary"
          ?disabled=${this.publishing}
          @click=${() => this.publish()}
        >
          ${this.publishing ? 'Publishing…' : url ? 'Republish' : 'Publish'}
        </button>
        ${url
          ? html`<a href=${url} target="_blank" rel="noopener noreferrer"
              >Open ↗</a
            >`
          : nothing}
      </div>
      <div class="app-preview">
        ${this.mode === 'preview'
          ? html`<iframe
              .srcdoc=${result.html}
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              title=${result.title}
            ></iframe>`
          : html`<pre><code>${result.html}</code></pre>`}
      </div>
      ${this.error ? html`<div class="app-error">${this.error}</div>` : nothing}
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'clickdz-app-result': ClickDzAppResultCard;
  }
}
