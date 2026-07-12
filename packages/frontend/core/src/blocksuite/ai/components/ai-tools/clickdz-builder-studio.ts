import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

/**
 * `<clickdz-builder-studio>` — a Lovable-style "Builder Studio" overlay for the
 * ClickDz AI app builder.
 *
 * It presents a full-viewport IDE-like surface with a code editor, a live
 * sandboxed preview, a visual click-to-edit bridge, and a right-hand AI dock
 * that continues editing the app using the current HTML as context.
 *
 * Self-contained: imports only from `lit`, `lit/decorators.js` and
 * `lit/directives/*`. Talks to two same-origin endpoints:
 *   - POST /api/v1/apps/generate  { prompt, slug?, currentHtml? }
 *   - POST /api/v1/apps/deploy    { html, slug }
 *
 * ── Deterministic-id invariant (click-to-edit) ────────────────────────────
 * The canonical source is always `workingHtml` (clean, WITHOUT any editor
 * bookkeeping attributes). To make a preview and to apply an edit we parse
 * `workingHtml` with `DOMParser` and walk `body`'s descendant elements via a
 * SINGLE shared helper (`walkBody`) that assigns an incrementing integer id
 * (starting at 0) to each element in document order. Because both passes —
 * the preview-augmentation pass and the apply pass — start from the exact same
 * `workingHtml` string and use the exact same walk (`querySelectorAll('*')`
 * over `body`, which yields elements in tree/document order), a given
 * `data-cdz-id` maps to the same node in both passes. Any mutation to
 * `workingHtml` re-derives ids from scratch, so ids are only ever stable for
 * the duration of a single (source, pick, apply) cycle — which is all that is
 * required, since a pick and its apply share the same source snapshot.
 */

interface CdzSelected {
  id: number;
  tag: string;
  text: string;
}

type CdzHistoryItem = {
  role: 'user' | 'system';
  text: string;
};

// Messages posted FROM the preview iframe back to this parent element.
interface CdzPickMessage {
  type: 'cdz-pick';
  id: number;
  tag: string;
  text: string;
}

const PREVIEW_DEBOUNCE_MS = 400;
const IFRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals';

@customElement('clickdz-builder-studio')
export class ClickDzBuilderStudio extends LitElement {
  static override styles = css`
    :host {
      --cdz-accent: #10a37f;
      --cdz-bg: var(--affine-v2-layer-background-primary, #16181c);
      --cdz-bg-2: var(--affine-v2-layer-background-secondary, #1c1f24);
      --cdz-bg-3: #23272e;
      --cdz-border: var(--affine-v2-layer-insideBorder-border, #2b2f36);
      --cdz-text: var(--affine-v2-text-primary, #e8eaed);
      --cdz-text-2: var(--affine-v2-text-secondary, #9aa0a6);
      --cdz-danger: #f2686b;
      --cdz-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas,
        'Liberation Mono', monospace;
      --cdz-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
        sans-serif;
    }

    .cdz-backdrop {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      background: rgba(8, 9, 11, 0.62);
      backdrop-filter: blur(4px);
      color: var(--cdz-text);
      font-family: var(--cdz-sans);
      font-size: 13px;
      -webkit-font-smoothing: antialiased;
    }

    .cdz-shell {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      margin: 20px;
      overflow: hidden;
      border: 1px solid var(--cdz-border);
      border-radius: 14px;
      background: var(--cdz-bg);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
    }

    /* ── top bar ─────────────────────────────────────────── */
    .cdz-topbar {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
      height: 52px;
      padding: 0 14px;
      border-bottom: 1px solid var(--cdz-border);
      background: linear-gradient(
        180deg,
        var(--cdz-bg-2),
        var(--cdz-bg)
      );
    }

    .cdz-brand {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
      flex: 1;
    }

    .cdz-dot {
      width: 9px;
      height: 9px;
      flex-shrink: 0;
      border-radius: 50%;
      background: var(--cdz-accent);
      box-shadow: 0 0 0 4px rgba(16, 163, 127, 0.16);
    }

    .cdz-title {
      overflow: hidden;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.1px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .cdz-slug {
      color: var(--cdz-text-2);
      font-family: var(--cdz-mono);
      font-size: 11px;
      font-weight: 500;
    }

    /* segmented control */
    .cdz-seg {
      display: flex;
      gap: 2px;
      padding: 3px;
      border-radius: 9px;
      background: var(--cdz-bg-3);
      border: 1px solid var(--cdz-border);
    }

    .cdz-seg button {
      appearance: none;
      border: 0;
      border-radius: 6px;
      padding: 5px 13px;
      cursor: pointer;
      color: var(--cdz-text-2);
      background: transparent;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      transition: color 0.12s, background 0.12s;
    }

    .cdz-seg button:hover {
      color: var(--cdz-text);
    }

    .cdz-seg button.active {
      color: var(--cdz-text);
      background: var(--cdz-bg);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    }

    .cdz-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      justify-content: flex-end;
    }

    button.cdz-btn,
    a.cdz-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      appearance: none;
      border: 1px solid var(--cdz-border);
      border-radius: 8px;
      padding: 6px 11px;
      cursor: pointer;
      color: var(--cdz-text);
      background: var(--cdz-bg-3);
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
      transition: border-color 0.12s, background 0.12s, color 0.12s;
    }

    button.cdz-btn:hover,
    a.cdz-btn:hover {
      border-color: #3a4048;
      background: #2a2f37;
    }

    button.cdz-btn:focus-visible,
    a.cdz-btn:focus-visible,
    .cdz-seg button:focus-visible {
      outline: 2px solid var(--cdz-accent);
      outline-offset: 2px;
    }

    button.cdz-btn.toggled {
      border-color: var(--cdz-accent);
      color: var(--cdz-accent);
      background: rgba(16, 163, 127, 0.12);
    }

    button.cdz-primary {
      border-color: var(--cdz-accent);
      color: #06231b;
      background: var(--cdz-accent);
    }

    button.cdz-primary:hover {
      border-color: #14b98f;
      background: #14b98f;
    }

    button.cdz-btn:disabled {
      cursor: wait;
      opacity: 0.6;
    }

    /* ── center ──────────────────────────────────────────── */
    .cdz-body {
      display: flex;
      flex: 1;
      min-height: 0;
    }

    .cdz-center {
      display: flex;
      flex: 1;
      min-width: 0;
      min-height: 0;
    }

    .cdz-pane {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      background: var(--cdz-bg);
    }

    .cdz-pane.code {
      flex: 0 0 48%;
    }

    .cdz-pane.preview {
      flex: 1;
      background: #fff;
    }

    .cdz-center.single .cdz-pane {
      flex: 1;
    }

    .cdz-divider {
      flex: 0 0 1px;
      width: 1px;
      cursor: default;
      background: var(--cdz-border);
      box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.03);
    }

    /* ── code editor ─────────────────────────────────────── */
    .cdz-code-head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
      height: 30px;
      padding: 0 12px;
      border-bottom: 1px solid var(--cdz-border);
      color: var(--cdz-text-2);
      background: var(--cdz-bg-2);
      font-family: var(--cdz-mono);
      font-size: 11px;
      font-weight: 600;
    }

    textarea.cdz-studio-code {
      flex: 1;
      box-sizing: border-box;
      width: 100%;
      min-height: 0;
      margin: 0;
      padding: 14px 16px;
      resize: none;
      border: 0;
      outline: none;
      color: var(--cdz-text);
      background: var(--cdz-bg);
      font-family: var(--cdz-mono);
      font-size: 12.5px;
      line-height: 1.6;
      tab-size: 2;
      white-space: pre;
      overflow: auto;
    }

    textarea.cdz-studio-code::selection {
      background: rgba(16, 163, 127, 0.32);
    }

    .cdz-code-foot {
      display: flex;
      gap: 14px;
      flex-shrink: 0;
      height: 26px;
      align-items: center;
      padding: 0 14px;
      border-top: 1px solid var(--cdz-border);
      color: var(--cdz-text-2);
      background: var(--cdz-bg-2);
      font-family: var(--cdz-mono);
      font-size: 11px;
    }

    /* ── preview ─────────────────────────────────────────── */
    .cdz-preview-wrap {
      position: relative;
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }

    iframe.cdz-studio-frame {
      width: 100%;
      height: 100%;
      flex: 1;
      border: 0;
      background: #fff;
    }

    .cdz-inspect-banner {
      position: absolute;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 3;
      padding: 5px 12px;
      border-radius: 999px;
      color: #06231b;
      background: var(--cdz-accent);
      font-size: 11px;
      font-weight: 700;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
      pointer-events: none;
    }

    /* ── edit panel (floating, over preview) ─────────────── */
    .cdz-edit-panel {
      position: absolute;
      right: 16px;
      bottom: 16px;
      z-index: 4;
      width: min(300px, calc(100% - 32px));
      padding: 12px;
      border: 1px solid var(--cdz-border);
      border-radius: 12px;
      color: var(--cdz-text);
      background: var(--cdz-bg-2);
      box-shadow: 0 16px 44px rgba(0, 0, 0, 0.5);
    }

    .cdz-edit-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 9px;
    }

    .cdz-edit-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--cdz-accent);
      font-family: var(--cdz-mono);
      font-size: 11px;
      font-weight: 700;
      text-transform: lowercase;
    }

    .cdz-edit-panel label {
      display: block;
      margin: 8px 0 4px;
      color: var(--cdz-text-2);
      font-size: 11px;
      font-weight: 600;
    }

    .cdz-edit-panel textarea,
    .cdz-edit-panel input[type='number'] {
      box-sizing: border-box;
      width: 100%;
      padding: 7px 9px;
      border: 1px solid var(--cdz-border);
      border-radius: 8px;
      color: var(--cdz-text);
      background: var(--cdz-bg);
      font: inherit;
      font-size: 12px;
    }

    .cdz-edit-panel textarea {
      min-height: 58px;
      resize: vertical;
      font-family: var(--cdz-mono);
      line-height: 1.5;
    }

    .cdz-edit-panel textarea:focus,
    .cdz-edit-panel input:focus {
      outline: none;
      border-color: var(--cdz-accent);
    }

    .cdz-edit-row {
      display: flex;
      gap: 10px;
    }

    .cdz-edit-row > div {
      flex: 1;
    }

    input[type='color'].cdz-color {
      box-sizing: border-box;
      width: 100%;
      height: 30px;
      padding: 2px;
      border: 1px solid var(--cdz-border);
      border-radius: 8px;
      background: var(--cdz-bg);
      cursor: pointer;
    }

    .cdz-edit-foot {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }

    .cdz-edit-foot button {
      flex: 1;
    }

    .cdz-iconbtn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      cursor: pointer;
      color: var(--cdz-text-2);
      background: transparent;
      font-size: 14px;
      line-height: 1;
    }

    .cdz-iconbtn:hover {
      color: var(--cdz-text);
      background: var(--cdz-bg-3);
    }

    /* ── AI dock ─────────────────────────────────────────── */
    .cdz-dock {
      display: flex;
      flex-direction: column;
      flex: 0 0 300px;
      min-height: 0;
      border-left: 1px solid var(--cdz-border);
      background: var(--cdz-bg-2);
    }

    .cdz-dock-head {
      flex-shrink: 0;
      padding: 12px 14px;
      border-bottom: 1px solid var(--cdz-border);
    }

    .cdz-dock-title {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      font-weight: 700;
    }

    .cdz-dock-sub {
      margin-top: 3px;
      color: var(--cdz-text-2);
      font-size: 11px;
      line-height: 1.4;
    }

    .cdz-dock-log {
      flex: 1;
      min-height: 0;
      padding: 12px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .cdz-msg {
      max-width: 92%;
      padding: 8px 11px;
      border-radius: 11px;
      font-size: 12px;
      line-height: 1.45;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .cdz-msg.user {
      align-self: flex-end;
      color: #06231b;
      background: var(--cdz-accent);
      border-bottom-right-radius: 3px;
    }

    .cdz-msg.system {
      align-self: flex-start;
      color: var(--cdz-text);
      background: var(--cdz-bg-3);
      border: 1px solid var(--cdz-border);
      border-bottom-left-radius: 3px;
    }

    .cdz-msg.system.err {
      color: var(--cdz-danger);
      border-color: rgba(242, 104, 107, 0.4);
      background: rgba(242, 104, 107, 0.1);
    }

    .cdz-dock-empty {
      margin: auto;
      max-width: 200px;
      color: var(--cdz-text-2);
      font-size: 12px;
      line-height: 1.5;
      text-align: center;
    }

    .cdz-dock-input {
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
      padding: 12px;
      border-top: 1px solid var(--cdz-border);
    }

    textarea.cdz-ai-prompt {
      box-sizing: border-box;
      width: 100%;
      min-height: 62px;
      max-height: 160px;
      padding: 9px 11px;
      resize: none;
      border: 1px solid var(--cdz-border);
      border-radius: 10px;
      color: var(--cdz-text);
      background: var(--cdz-bg);
      font: inherit;
      font-size: 12.5px;
      line-height: 1.5;
    }

    textarea.cdz-ai-prompt:focus {
      outline: none;
      border-color: var(--cdz-accent);
      box-shadow: 0 0 0 3px rgba(16, 163, 127, 0.16);
    }

    .cdz-dock-send {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .cdz-dock-send .cdz-hint {
      flex: 1;
      color: var(--cdz-text-2);
      font-size: 10.5px;
    }

    .cdz-spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid rgba(255, 255, 255, 0.4);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: cdz-spin 0.7s linear infinite;
    }

    @keyframes cdz-spin {
      to {
        transform: rotate(360deg);
      }
    }

    .cdz-topbar-err {
      flex-shrink: 0;
      padding: 7px 16px;
      color: var(--cdz-danger);
      background: rgba(242, 104, 107, 0.1);
      border-bottom: 1px solid rgba(242, 104, 107, 0.3);
      font-size: 12px;
    }
  `;

  /* ─────────────────── public API ─────────────────── */

  @property({ attribute: false })
  accessor open = false;

  @property({ attribute: false })
  accessor slug = '';

  @property({ attribute: false })
  accessor html = '';

  @property({ attribute: false })
  accessor title = 'App';

  @property({ attribute: false })
  accessor publishedUrl = '';

  /* ─────────────────── internal state ─────────────────── */

  @state()
  private accessor view: 'split' | 'code' | 'preview' = 'split';

  @state()
  private accessor workingHtml = '';

  @state()
  private accessor inspect = false;

  @state()
  private accessor selected: CdzSelected | null = null;

  @state()
  private accessor aiPrompt = '';

  @state()
  private accessor aiBusy = false;

  @state()
  private accessor publishing = false;

  @state()
  private accessor error = '';

  @state()
  private accessor history: CdzHistoryItem[] = [];

  @state()
  private accessor previewSrc = '';

  /* draft values for the floating edit panel */
  @state()
  private accessor editText = '';

  @state()
  private accessor editColor = '';

  @state()
  private accessor editFontSize = '';

  /* ─────────────────── non-reactive fields ─────────────────── */

  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  // Bound so add/removeEventListener reference the same function object.
  private readonly onMessage = (event: MessageEvent) =>
    this.handleMessage(event);
  private readonly onKeyDown = (event: KeyboardEvent) =>
    this.handleKeyDown(event);
  // Tracks whether we've seeded workingHtml for the current open session.
  private initialized = false;
  // Last html we emitted via studio-html-change. The host echoes this straight
  // back into the `html` prop, so we must never treat that echo as a genuine
  // external swap (which would clobber the user's in-progress edits).
  private lastEmittedHtml = '';

  /* ─────────────────── lifecycle ─────────────────── */

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('message', this.onMessage);
    window.addEventListener('keydown', this.onKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('message', this.onMessage);
    window.removeEventListener('keydown', this.onKeyDown);
    this.clearTimers();
  }

  private clearTimers() {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    if (this.changeTimer !== null) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>) {
    // Closing the overlay resets the session so the NEXT open re-seeds cleanly.
    if (changed.has('open') && !this.open) {
      this.initialized = false;
      this.selected = null;
      this.inspect = false;
      // Cancel any pending debounced work so a timer can't fire (and dispatch
      // studio-html-change) after the overlay has already closed.
      this.clearTimers();
      return;
    }

    if (!this.open) return;

    if (!this.initialized) {
      // First render of an open session: adopt the html prop verbatim as the
      // canonical working source, then build the preview once.
      this.workingHtml = this.html ?? '';
      this.initialized = true;
      this.buildPreviewNow();
      return;
    }

    // Already initialized & open: only re-seed if the host swapped in a
    // genuinely different `html` prop. This guards the user's in-progress
    // edits — we NEVER overwrite workingHtml just because we re-rendered; the
    // html PROP itself must have changed AND differ from what we hold.
    if (changed.has('html')) {
      const incoming = this.html ?? '';
      // Ignore the echo of our own last emission — only a genuinely new,
      // externally-sourced html swap should re-seed the working copy.
      if (
        incoming &&
        incoming !== this.workingHtml &&
        incoming !== this.lastEmittedHtml
      ) {
        this.workingHtml = incoming;
        this.buildPreviewNow();
      }
    }
  }

  /* ─────────────────── deterministic id walk ─────────────────── */

  /**
   * Parse `workingHtml` and invoke `visit(el, id)` for every element inside
   * <body>, in document order, assigning ids 0,1,2,… This is the single source
   * of the deterministic-id invariant: every consumer (preview build + apply)
   * routes through here so ids line up across passes for a given source string.
   * Returns the parsed Document, or null if there is no usable <body>.
   */
  private walkBody(
    source: string,
    visit: (el: Element, id: number) => void
  ): Document | null {
    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(source, 'text/html');
    } catch {
      return null;
    }
    const body = doc.body;
    if (!body) return null;
    const all = body.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      visit(all[i], i);
    }
    return doc;
  }

  /**
   * The "direct text" of an element: if it has element children we take only
   * its own text nodes (so we don't slurp descendants' text); otherwise its
   * full textContent. Mirrors the logic embedded in the injected preview
   * script so the parent shows the same text the user clicked.
   */
  private directText(el: Element): string {
    const hasElementChild = el.firstElementChild !== null;
    if (!hasElementChild) return (el.textContent ?? '').trim();
    let out = '';
    el.childNodes.forEach(node => {
      if (node.nodeType === 3 /* Node.TEXT_NODE */) {
        out += node.textContent ?? '';
      }
    });
    return out.trim();
  }

  /* ─────────────────── preview building ─────────────────── */

  private scheduleRebuild() {
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      this.buildPreviewNow();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private scheduleHtmlChange() {
    if (this.changeTimer !== null) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.lastEmittedHtml = this.workingHtml;
      this.dispatchEvent(
        new CustomEvent('studio-html-change', {
          detail: { html: this.workingHtml },
          bubbles: true,
          composed: true,
        })
      );
    }, PREVIEW_DEBOUNCE_MS);
  }

  /**
   * Build the augmented srcdoc from `workingHtml`: tag every body element with
   * a deterministic data-cdz-id, inject the hover/select stylesheet and the
   * inspect bridge script, then serialize. This augmented doc is PREVIEW-ONLY;
   * `workingHtml` stays clean.
   */
  private buildPreviewNow() {
    const source = this.workingHtml ?? '';
    const doc = this.walkBody(source, (el, id) => {
      el.setAttribute('data-cdz-id', String(id));
    });

    if (!doc) {
      // No usable body → degrade gracefully: show the raw source, and force
      // inspect off so the UI never advertises a click-to-edit mode that has
      // no bridge script behind it.
      this.inspect = false;
      this.selected = null;
      this.previewSrc = source;
      return;
    }

    // Hover / selection outline styles.
    const style = doc.createElement('style');
    style.textContent = CDZ_INSPECT_STYLE;
    doc.head.appendChild(style);

    // Inspect bridge script (guarded to only act when toggled on).
    const script = doc.createElement('script');
    script.textContent = buildBridgeScript(this.inspect);
    doc.body.appendChild(script);

    const doctype = doc.doctype ? '<!DOCTYPE html>\n' : '';
    this.previewSrc = doctype + doc.documentElement.outerHTML;
  }

  /* ─────────────────── parent ⇄ iframe messaging ─────────────────── */

  private postToFrame(message: { type: string; on?: boolean }) {
    const frame = this.renderRoot.querySelector<HTMLIFrameElement>(
      'iframe.cdz-studio-frame'
    );
    frame?.contentWindow?.postMessage(message, '*');
  }

  private handleMessage(event: MessageEvent) {
    if (!this.open) return;
    const frame = this.renderRoot.querySelector<HTMLIFrameElement>(
      'iframe.cdz-studio-frame'
    );
    // Only trust messages coming from our own preview iframe.
    if (!frame || event.source !== frame.contentWindow) return;

    const data = event.data as Partial<CdzPickMessage> | null;
    if (!data || data.type !== 'cdz-pick') return;
    if (typeof data.id !== 'number') return;

    this.selected = {
      id: data.id,
      tag: typeof data.tag === 'string' ? data.tag : '',
      text: typeof data.text === 'string' ? data.text : '',
    };
    // Seed the edit-panel drafts from the current DOM state of that node.
    this.seedEditDrafts(this.selected);
  }

  private seedEditDrafts(sel: CdzSelected) {
    // Default to the text the iframe reported, but prefer re-deriving it from
    // the canonical workingHtml (same deterministic walk) so the parent is the
    // source of truth and any iframe/source drift can't desync the editor.
    this.editText = sel.text;
    this.editColor = '';
    this.editFontSize = '';
    this.walkBody(this.workingHtml, (el, id) => {
      if (id !== sel.id) return;
      this.editText = this.directText(el);
      const style = el.getAttribute('style') ?? '';
      const colorMatch = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style);
      const sizeMatch = /(?:^|;)\s*font-size\s*:\s*([0-9.]+)px/i.exec(style);
      if (colorMatch) this.editColor = normalizeColor(colorMatch[1].trim());
      if (sizeMatch) this.editFontSize = sizeMatch[1].trim();
    });
  }

  /* ─────────────────── inspect toggle ─────────────────── */

  private toggleInspect() {
    this.inspect = !this.inspect;
    if (!this.inspect) this.selected = null;
    // Rebuild srcdoc so the bridge boots in the right mode, then also post the
    // live toggle for the already-loaded frame.
    this.buildPreviewNow();
    this.postToFrame({ type: 'cdz-inspect', on: this.inspect });
  }

  /* ─────────────────── apply a click-to-edit change ─────────────────── */

  private applyEdit() {
    const sel = this.selected;
    if (!sel) return;

    const newText = this.editText;
    const newColor = this.editColor.trim();
    const newSize = this.editFontSize.trim();

    let matched = false;
    const doc = this.walkBody(this.workingHtml, (el, id) => {
      if (id !== sel.id) return;
      matched = true;

      // Update text: replace direct text. If the element has element children,
      // set the text of the FIRST text node (or prepend one) to avoid wiping
      // child elements; otherwise just set textContent.
      if (el.firstElementChild) {
        const children = el.childNodes;
        let firstText: ChildNode | undefined;
        for (let k = 0; k < children.length; k++) {
          const node = children[k];
          if (node.nodeType === 3 /* Node.TEXT_NODE */) {
            firstText = node;
            break;
          }
        }
        if (firstText) {
          firstText.textContent = newText;
        } else if (newText) {
          const owner = el.ownerDocument;
          el.insertBefore(owner.createTextNode(newText), el.firstChild);
        }
      } else {
        el.textContent = newText;
      }

      // Merge inline style for color / font-size.
      if (newColor || newSize) {
        setInlineStyle(el, {
          ...(newColor ? { color: newColor } : {}),
          ...(newSize ? { 'font-size': `${newSize}px` } : {}),
        });
      }
    });

    if (!doc || !matched) {
      // Could not locate node (source changed under us) — just close panel.
      this.selected = null;
      return;
    }

    // Strip our bookkeeping attribute from EVERY element before serializing
    // back to the canonical clean source.
    doc.body.querySelectorAll('[data-cdz-id]').forEach(el => {
      el.removeAttribute('data-cdz-id');
    });

    this.commitBodyMutation(doc);
    this.selected = null;
  }

  /**
   * Re-serialize a mutated document's <body> innerHTML back into workingHtml,
   * preserving everything outside <body> (doctype, <head>) from the ORIGINAL
   * source so we only touch the body region.
   */
  private commitBodyMutation(doc: Document) {
    const newBodyInner = doc.body.innerHTML;
    const original = this.workingHtml ?? '';

    // Try to replace only the body's inner content in the original string so
    // head/doctype/attributes are untouched. Fall back to full-doc serialize.
    const replaced = replaceBodyInner(original, newBodyInner);
    this.workingHtml =
      replaced !== null ? replaced : serializeFullDoc(doc);

    this.buildPreviewNow();
    this.scheduleHtmlChange();
  }

  /* ─────────────────── code editor input ─────────────────── */

  private onCodeInput(event: Event) {
    const target = event.target as HTMLTextAreaElement;
    this.workingHtml = target.value;
    this.scheduleRebuild();
    this.scheduleHtmlChange();
  }

  private onCodeKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const ta = event.target as HTMLTextAreaElement;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const value = ta.value;
    const next = value.slice(0, start) + '  ' + value.slice(end);
    ta.value = next;
    ta.selectionStart = ta.selectionEnd = start + 2;
    this.workingHtml = next;
    this.scheduleRebuild();
    this.scheduleHtmlChange();
  }

  /* ─────────────────── AI dock ─────────────────── */

  private async sendAi() {
    const prompt = this.aiPrompt.trim();
    if (!prompt || this.aiBusy) return;

    this.history = [...this.history, { role: 'user', text: prompt }];
    this.aiPrompt = '';
    this.aiBusy = true;
    this.error = '';

    try {
      const response = await fetch('/api/v1/apps/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          slug: this.slug || undefined,
          currentHtml: this.workingHtml,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          data?.error?.message || `Generation failed (${response.status})`
        );
      }
      if (data && typeof data.html === 'string') {
        this.workingHtml = data.html;
      }
      if (data && typeof data.slug === 'string' && data.slug) {
        this.slug = data.slug;
      }
      this.buildPreviewNow();
      this.scheduleHtmlChange();
      this.history = [...this.history, { role: 'system', text: 'Updated ✓' }];
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Generation failed';
      this.history = [...this.history, { role: 'system', text: message }];
      this.error = message;
    } finally {
      this.aiBusy = false;
    }
  }

  private onAiKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.sendAi();
    }
  }

  /* ─────────────────── publish ─────────────────── */

  private async publish() {
    if (this.publishing) return;
    this.publishing = true;
    this.error = '';
    try {
      const response = await fetch('/api/v1/apps/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: this.workingHtml, slug: this.slug }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          data?.error?.message || `Publish failed (${response.status})`
        );
      }
      const url = String(data?.url || data?.deploymentUrl || '');
      this.publishedUrl = url;
      this.history = [
        ...this.history,
        { role: 'system', text: url ? `Published → ${url}` : 'Published ✓' },
      ];
      this.dispatchEvent(
        new CustomEvent('studio-published', {
          detail: { url },
          bubbles: true,
          composed: true,
        })
      );
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Publish failed';
    } finally {
      this.publishing = false;
    }
  }

  /* ─────────────────── close / keyboard ─────────────────── */

  private close() {
    this.dispatchEvent(
      new CustomEvent('studio-close', { bubbles: true, composed: true })
    );
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (!this.open || event.key !== 'Escape') return;
    // Don't trap typing: ignore Escape when focus is in a text field.
    const path = event.composedPath();
    const inField = path.some(node => {
      const el = node as HTMLElement;
      const tag = el?.tagName;
      return tag === 'TEXTAREA' || tag === 'INPUT';
    });
    if (inField) return;
    event.preventDefault();
    this.close();
  }

  private setView(view: 'split' | 'code' | 'preview') {
    this.view = view;
  }

  /* ─────────────────── render helpers ─────────────────── */

  private renderTopBar() {
    const openUrl = this.publishedUrl;
    return html`<div class="cdz-topbar">
      <div class="cdz-brand">
        <span class="cdz-dot"></span>
        <span class="cdz-title" title=${this.title}>${this.title}</span>
        ${this.slug
          ? html`<span class="cdz-slug">/${this.slug}</span>`
          : nothing}
      </div>

      <div class="cdz-seg" role="tablist" aria-label="View">
        <button
          class=${classMap({ active: this.view === 'code' })}
          role="tab"
          aria-selected=${this.view === 'code'}
          @click=${() => this.setView('code')}
        >
          Code
        </button>
        <button
          class=${classMap({ active: this.view === 'split' })}
          role="tab"
          aria-selected=${this.view === 'split'}
          @click=${() => this.setView('split')}
        >
          Split
        </button>
        <button
          class=${classMap({ active: this.view === 'preview' })}
          role="tab"
          aria-selected=${this.view === 'preview'}
          @click=${() => this.setView('preview')}
        >
          Preview
        </button>
      </div>

      <div class="cdz-actions">
        <button
          class=${classMap({ 'cdz-btn': true, toggled: this.inspect })}
          title="Click elements in the preview to edit them"
          aria-pressed=${this.inspect}
          @click=${() => this.toggleInspect()}
        >
          ⌖ Inspect
        </button>
        <button
          class="cdz-btn cdz-primary"
          ?disabled=${this.publishing}
          @click=${() => this.publish()}
        >
          ${this.publishing
            ? html`<span class="cdz-spinner"></span>Publishing…`
            : openUrl
              ? 'Republish'
              : 'Publish'}
        </button>
        ${openUrl
          ? html`<a
              class="cdz-btn"
              href=${openUrl}
              target="_blank"
              rel="noopener noreferrer"
              >Open ↗</a
            >`
          : nothing}
        <button class="cdz-btn" title="Close" @click=${() => this.close()}>
          Close ✕
        </button>
      </div>
    </div>`;
  }

  private renderCodePane() {
    const lines = this.workingHtml ? this.workingHtml.split('\n').length : 0;
    const chars = this.workingHtml.length;
    return html`<div class="cdz-pane code">
      <div class="cdz-code-head">index.html</div>
      <textarea
        class="cdz-studio-code"
        .value=${this.workingHtml}
        spellcheck="false"
        wrap="off"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        @input=${(e: Event) => this.onCodeInput(e)}
        @keydown=${(e: KeyboardEvent) => this.onCodeKeyDown(e)}
      ></textarea>
      <div class="cdz-code-foot">
        <span>${lines} lines</span>
        <span>${chars} chars</span>
      </div>
    </div>`;
  }

  private renderPreviewPane() {
    return html`<div class="cdz-pane preview">
      <div class="cdz-preview-wrap">
        ${this.inspect
          ? html`<div class="cdz-inspect-banner">
              Inspect mode — click any element to edit
            </div>`
          : nothing}
        <iframe
          class="cdz-studio-frame"
          .srcdoc=${this.previewSrc}
          sandbox=${IFRAME_SANDBOX}
          title=${`${this.title} preview`}
        ></iframe>
        ${this.renderEditPanel()}
      </div>
    </div>`;
  }

  private renderEditPanel() {
    const sel = this.selected;
    if (!sel) return nothing;
    return html`<div class="cdz-edit-panel" @keydown=${stopKeydown}>
      <div class="cdz-edit-head">
        <span class="cdz-edit-tag">&lt;${sel.tag || 'node'}&gt;</span>
        <button
          class="cdz-iconbtn"
          title="Dismiss"
          @click=${() => (this.selected = null)}
        >
          ✕
        </button>
      </div>

      <label>Text</label>
      <textarea
        .value=${this.editText}
        @input=${(e: Event) =>
          (this.editText = (e.target as HTMLTextAreaElement).value)}
      ></textarea>

      <div class="cdz-edit-row">
        <div>
          <label>Color</label>
          <input
            class="cdz-color"
            type="color"
            .value=${this.editColor || '#000000'}
            @input=${(e: Event) =>
              (this.editColor = (e.target as HTMLInputElement).value)}
          />
        </div>
        <div>
          <label>Font size (px)</label>
          <input
            type="number"
            min="1"
            placeholder="—"
            .value=${this.editFontSize}
            @input=${(e: Event) =>
              (this.editFontSize = (e.target as HTMLInputElement).value)}
          />
        </div>
      </div>

      <div class="cdz-edit-foot">
        <button class="cdz-btn" @click=${() => (this.selected = null)}>
          Cancel
        </button>
        <button class="cdz-btn cdz-primary" @click=${() => this.applyEdit()}>
          Apply
        </button>
      </div>
    </div>`;
  }

  private renderDock() {
    return html`<aside class="cdz-dock">
      <div class="cdz-dock-head">
        <div class="cdz-dock-title">✦ AI edits</div>
        <div class="cdz-dock-sub">The code is the context.</div>
      </div>

      <div class="cdz-dock-log">
        ${this.history.length === 0
          ? html`<div class="cdz-dock-empty">
              Describe a change and the assistant will edit the app using the
              current code as context.
            </div>`
          : this.history.map(item => {
              const isErr =
                item.role === 'system' &&
                item.text !== 'Updated ✓' &&
                !item.text.startsWith('Published');
              return html`<div
                class=${classMap({
                  'cdz-msg': true,
                  user: item.role === 'user',
                  system: item.role === 'system',
                  err: isErr,
                })}
              >
                ${item.text}
              </div>`;
            })}
      </div>

      <div class="cdz-dock-input">
        <textarea
          class="cdz-ai-prompt"
          placeholder="e.g. Make the hero headline bigger and change the CTA to teal"
          .value=${this.aiPrompt}
          ?disabled=${this.aiBusy}
          @input=${(e: Event) =>
            (this.aiPrompt = (e.target as HTMLTextAreaElement).value)}
          @keydown=${(e: KeyboardEvent) => this.onAiKeyDown(e)}
        ></textarea>
        <div class="cdz-dock-send">
          <span class="cdz-hint">Enter to send · Shift+Enter for newline</span>
          <button
            class="cdz-btn cdz-primary"
            ?disabled=${this.aiBusy || this.aiPrompt.trim().length === 0}
            @click=${() => this.sendAi()}
          >
            ${this.aiBusy
              ? html`<span class="cdz-spinner"></span>Working…`
              : 'Send'}
          </button>
        </div>
      </div>
    </aside>`;
  }

  private renderCenter() {
    if (this.view === 'code') {
      return html`<div class="cdz-center single">
        ${this.renderCodePane()}
      </div>`;
    }
    if (this.view === 'preview') {
      return html`<div class="cdz-center single">
        ${this.renderPreviewPane()}
      </div>`;
    }
    return html`<div class="cdz-center">
      ${this.renderCodePane()}
      <div class="cdz-divider"></div>
      ${this.renderPreviewPane()}
    </div>`;
  }

  protected override render() {
    if (!this.open) return nothing;
    return html`<div class="cdz-backdrop" @keydown=${stopKeydown}>
      <div class="cdz-shell" role="dialog" aria-label="Builder Studio">
        ${this.renderTopBar()}
        ${this.error
          ? html`<div class="cdz-topbar-err">${this.error}</div>`
          : nothing}
        <div class="cdz-body">${this.renderCenter()} ${this.renderDock()}</div>
      </div>
    </div>`;
  }
}

/* ─────────────────── module-level pure helpers ─────────────────── */

// A key-typing keydown inside the overlay should not bubble up to the global
// Escape handler and close the studio while someone is editing.
function stopKeydown(event: KeyboardEvent) {
  event.stopPropagation();
}

// Injected into the preview <head>. Draws hover/selected outlines. Kept as a
// plain string (no backticks) to avoid nesting template literals.
const CDZ_INSPECT_STYLE = [
  '[data-cdz-id].cdz-hover{outline:2px dashed #10a37f !important;',
  'outline-offset:1px !important;cursor:pointer !important;}',
  '[data-cdz-id].cdz-sel{outline:2px solid #10a37f !important;',
  'outline-offset:1px !important;}',
].join('');

/**
 * Build the bridge script string injected into the preview <body>.
 * It listens for {type:'cdz-inspect', on} from the parent, manages hover +
 * selection classes, and posts {type:'cdz-pick', id, tag, text} on click.
 *
 * NOTE: this runs inside the sandboxed iframe (no allow-same-origin). It only
 * uses postMessage to talk to window.parent. The "direct text" logic here MUST
 * mirror ClickDzBuilderStudio.directText so the parent shows what was clicked.
 *
 * Written with string concatenation (no nested template literals / backticks)
 * so it composes cleanly inside this module's own tagged templates.
 */
function buildBridgeScript(initialOn: boolean): string {
  return (
    '(function(){' +
    'var on=' +
    (initialOn ? 'true' : 'false') +
    ';' +
    'var hovered=null;' +
    'function clearHover(){if(hovered){hovered.classList.remove("cdz-hover");hovered=null;}}' +
    'function directText(el){' +
    'if(!el.firstElementChild){return (el.textContent||"").trim();}' +
    'var out="";var n=el.childNodes;' +
    'for(var i=0;i<n.length;i++){if(n[i].nodeType===3){out+=n[i].textContent||"";}}' +
    'return out.trim();}' +
    'document.addEventListener("mousemove",function(e){' +
    'if(!on)return;' +
    'var t=e.target;' +
    'if(!t||!t.getAttribute||t.getAttribute("data-cdz-id")===null){clearHover();return;}' +
    'if(t!==hovered){clearHover();hovered=t;t.classList.add("cdz-hover");}' +
    '},true);' +
    'document.addEventListener("click",function(e){' +
    'if(!on)return;' +
    'var t=e.target;' +
    'if(!t||!t.getAttribute)return;' +
    'var idAttr=t.getAttribute("data-cdz-id");' +
    'if(idAttr===null)return;' +
    'e.preventDefault();e.stopPropagation();' +
    'var els=document.querySelectorAll(".cdz-sel");' +
    'for(var i=0;i<els.length;i++){els[i].classList.remove("cdz-sel");}' +
    't.classList.add("cdz-sel");' +
    'window.parent.postMessage({type:"cdz-pick",id:parseInt(idAttr,10),' +
    'tag:(t.tagName||"").toLowerCase(),text:directText(t)},"*");' +
    '},true);' +
    'window.addEventListener("message",function(e){' +
    'if(e.source!==window.parent)return;' +
    'var d=e.data;' +
    'if(!d||d.type!=="cdz-inspect")return;' +
    'on=!!d.on;' +
    'if(!on){clearHover();' +
    'var s=document.querySelectorAll(".cdz-sel");' +
    'for(var i=0;i<s.length;i++){s[i].classList.remove("cdz-sel");}}' +
    '});' +
    '})();'
  );
}

/**
 * Set/merge inline style declarations on an element without disturbing other
 * declarations already present in its `style` attribute.
 */
function setInlineStyle(el: Element, decls: Record<string, string>) {
  const existing = el.getAttribute('style') ?? '';
  const map = new Map<string, string>();
  existing
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(decl => {
      const idx = decl.indexOf(':');
      if (idx > 0) {
        const prop = decl.slice(0, idx).trim().toLowerCase();
        const val = decl.slice(idx + 1).trim();
        if (prop) map.set(prop, val);
      }
    });
  Object.keys(decls).forEach(prop => {
    map.set(prop.toLowerCase(), decls[prop]);
  });
  const serialized = Array.from(map.entries())
    .map(([prop, val]) => `${prop}: ${val}`)
    .join('; ');
  if (serialized) el.setAttribute('style', serialized);
  else el.removeAttribute('style');
}

/**
 * Replace ONLY the inner content of the first <body>…</body> in `source` with
 * `newInner`, preserving the original doctype/head/body-attributes verbatim.
 * Returns null if a body region can't be confidently located.
 */
function replaceBodyInner(source: string, newInner: string): string | null {
  const openMatch = /<body\b[^>]*>/i.exec(source);
  if (!openMatch) return null;
  const openEnd = openMatch.index + openMatch[0].length;
  const closeIdx = source.toLowerCase().lastIndexOf('</body>');
  if (closeIdx === -1 || closeIdx < openEnd) return null;
  return source.slice(0, openEnd) + newInner + source.slice(closeIdx);
}

/**
 * Full-document serialization fallback (adds a doctype when the parsed doc had
 * one). Used only when `replaceBodyInner` can't locate a body region.
 */
function serializeFullDoc(doc: Document): string {
  const doctype = doc.doctype ? '<!DOCTYPE html>\n' : '';
  return doctype + doc.documentElement.outerHTML;
}

/**
 * Best-effort normalization of an arbitrary CSS color string into a
 * `#rrggbb` value suitable for an <input type="color">. Falls back to the
 * raw value's lower-cased form when it already looks like a hex triple, else
 * empty (leaving the color input at its default).
 */
function normalizeColor(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  if (/^#[0-9a-f]{3}$/.test(value)) {
    return (
      '#' +
      value
        .slice(1)
        .split('')
        .map(c => c + c)
        .join('')
    );
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value);
  if (rgb) {
    const hex = (n: string) =>
      Math.max(0, Math.min(255, parseInt(n, 10)))
        .toString(16)
        .padStart(2, '0');
    return '#' + hex(rgb[1]) + hex(rgb[2]) + hex(rgb[3]);
  }
  return '';
}

declare global {
  interface HTMLElementTagNameMap {
    'clickdz-builder-studio': ClickDzBuilderStudio;
  }
}
