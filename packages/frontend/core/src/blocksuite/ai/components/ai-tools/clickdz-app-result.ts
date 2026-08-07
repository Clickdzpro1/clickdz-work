import { unsafeCSSVarV2 } from '@blocksuite/affine/shared/theme';
import { ShadowlessElement } from '@blocksuite/affine/std';
import { css, html, nothing } from 'lit';
import { property, state } from 'lit/decorators.js';

import { persistAppDraft } from '../../../../modules/ai-artifacts/store';
import { cdzApiUrl } from '../../provider';
import type { StreamObject } from '../ai-chat-messages';
// Side-effect import: registers the <clickdz-builder-studio> custom element
// (self-registers via its @customElement decorator) used by the studio overlay.
import './clickdz-builder-studio';

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
    button.studio-btn {
      border-color: #10a37f;
      color: #0d8a6c;
      font-weight: 700;
    }
    button.studio-btn:hover {
      background: color-mix(in srgb, #10a37f 12%, transparent);
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

  // Full-screen Lovable-style studio (code editor + live preview + AI dock).
  @state()
  private accessor studioOpen = false;

  // Once the studio edits the app, its HTML becomes the live source of truth
  // for this card's preview / code view / publish (the stream-object result is
  // immutable, so we keep the working copy here).
  @state()
  private accessor liveHtml = '';

  // Renamed title from the studio wins over the immutable stream-object title
  // (parallels liveHtml). Empty = fall back to the original result title.
  @state()
  private accessor liveTitle = '';

  // When the studio's one-click Ready Shop loads a freshly-created app in place,
  // it becomes the studio's live source under a NEW slug. We adopt that slug
  // here (parallels liveHtml/liveTitle) so this card's studio prop bindings
  // (.slug/.title/.html) and publish/persist target the loaded app instead of
  // fighting it. Empty = fall back to the original result slug.
  @state()
  private accessor liveSlug = '';

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

  /** The current working HTML: studio edits win over the original result. */
  private get currentHtml(): string {
    return this.liveHtml || this.result?.html || '';
  }

  /** The current title: a studio rename wins over the original result title. */
  private get effectiveTitle(): string {
    return this.liveTitle || this.result?.title || 'App';
  }

  /** The current slug: a Ready-Shop in-place load wins over the result slug. */
  private get effectiveSlug(): string {
    return this.liveSlug || this.result?.slug || '';
  }

  /** Persist the working HTML (and any URL) so the composer + shelf stay in sync. */
  private persistApp(url?: string) {
    const result = this.result;
    if (!result) return;
    // Shared draft-persist path (WS1): identical to clickdz-builder-home so the
    // two studio hosts can never drift. prompt keeps the original result title
    // as its seed when the record is first created.
    persistAppDraft({
      slug: this.effectiveSlug,
      html: this.currentHtml,
      title: this.effectiveTitle,
      url: url ?? (this.publishedUrl || undefined),
      prompt: result.title,
    });
  }

  private async publish() {
    const result = this.result;
    if (!result || this.publishing) return;
    this.publishing = true;
    this.error = '';
    try {
      const response = await fetch(cdzApiUrl('/api/v1/apps/deploy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: this.currentHtml, slug: result.slug }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          data?.error?.message || `Publish failed (${response.status})`
        );
      }
      this.publishedUrl = String(data.url || '');
      this.persistApp(this.publishedUrl);
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
    const currentHtml = this.currentHtml;
    return html`<section class="app-card" data-testid="clickdz-app-result">
      <div class="app-toolbar">
        <div class="app-title">🚀 ${this.effectiveTitle}</div>
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
          class="studio-btn"
          data-testid="clickdz-open-studio"
          title="Open the visual studio — edit code and preview side by side"
          @click=${() => (this.studioOpen = true)}
        >
          ⤢ Studio
        </button>
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
              .srcdoc=${currentHtml}
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              title=${result.title}
            ></iframe>`
          : html`<pre><code>${currentHtml}</code></pre>`}
      </div>
      ${this.error ? html`<div class="app-error">${this.error}</div>` : nothing}
      <clickdz-builder-studio
        .open=${this.studioOpen}
        .slug=${this.effectiveSlug}
        .title=${this.effectiveTitle}
        .html=${currentHtml}
        .publishedUrl=${url ?? ''}
        @studio-close=${() => (this.studioOpen = false)}
        @studio-title-change=${(event: CustomEvent<{ title: string }>) => {
          this.liveTitle = event.detail.title;
          this.persistApp();
        }}
        @studio-html-change=${(event: CustomEvent<{ html: string }>) => {
          this.liveHtml = event.detail.html;
          this.persistApp();
        }}
        @studio-app-loaded=${(
          event: CustomEvent<{ slug: string; title: string; html: string }>
        ) => {
          // Ready Shop loaded a new app in place: adopt its identity so our
          // studio bindings + publish/persist follow the loaded app. The app
          // itself is already saved to the shelf by the studio; a fresh URL is
          // minted only when the user publishes it.
          this.liveSlug = event.detail.slug;
          this.liveTitle = event.detail.title;
          this.liveHtml = event.detail.html;
          this.publishedUrl = '';
        }}
        @studio-published=${(event: CustomEvent<{ url: string }>) => {
          this.publishedUrl = event.detail.url;
          this.persistApp(event.detail.url);
        }}
      ></clickdz-builder-studio>
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'clickdz-app-result': ClickDzAppResultCard;
  }
}
