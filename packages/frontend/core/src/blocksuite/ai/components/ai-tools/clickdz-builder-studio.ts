import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Studio v3 AI-editor modules (new sibling files).
import './cdz-diff-view'; // side-effect: registers <cdz-diff-view>
import { diffLines } from './cdz-html-diff';
import {
  makeMeta,
  renderVersionList,
  type CdzSnapshotKind,
  type CdzSnapshotMeta,
} from './cdz-history-meta';
import { buildSelectionDescriptor } from './cdz-selection-context';
import {
  coalesceProblem,
  normalizeConsoleMessage,
  CDZ_CONSOLE_BRIDGE,
  type CdzProblem,
} from './cdz-console-bridge';
import { renderProblems } from './cdz-problems-panel';
import {
  CDZ_EDIT_STYLE_PROPS,
  readStyleValue,
  type CdzStyleProp,
} from './cdz-style-editor';
import {
  canReparent,
  duplicateElement,
  reparentElement,
  removeElement,
} from './cdz-element-ops';

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

// Drag-reorder / reparent message from the preview bridge. `beforeId` is the
// data-cdz-id of the sibling to insert the dragged node before, or null to
// append at the end of the target container. `parentId` is the data-cdz-id of
// the container the node is being dropped INTO:
//   - absent/undefined → same-parent reorder (unchanged legacy path);
//   - a number → cross-parent reparent. When `beforeId` names a child of
//     `parentId`, insert before it ('before'); otherwise append into
//     `parentId` as its last child ('append-into').
interface CdzMoveMessage {
  type: 'cdz-move';
  id: number;
  beforeId: number | null;
  parentId?: number;
}

// Freeform-move message (Studio v3). The dragged element with data-cdz-id `id`
// was translated by (dx, dy) CSS px in free-move mode. The parent bakes this
// into the element's inline `transform: translate(...)`, accumulating onto any
// existing translate offset. DOM order is preserved (unlike cdz-move).
interface CdzFreeMessage {
  type: 'cdz-free';
  id: number;
  dx: number;
  dy: number;
}

// Inline text-edit message (S1). Posted after a double-click-to-edit on a
// text-bearing element commits (blur / Enter). `text` is the element's DIRECT
// text (own text nodes only, mirroring directText). The parent applies it as
// the element's direct text and commits an 'edit' snapshot.
interface CdzTextMessage {
  type: 'cdz-text';
  id: number;
  text: string;
}

// ── AI dock request/response contract (Studio v3: edit-in-context + multi-turn)
interface CdzTurn {
  role: 'user' | 'assistant';
  text: string;
}
interface CdzSelectionCtx {
  tag: string;
  text: string;
  descriptor?: string;
}
interface CdzGenerateRequest {
  prompt: string;
  slug?: string;
  currentHtml?: string;
  history?: CdzTurn[];
  selection?: CdzSelectionCtx | null;
}
interface CdzGenerateResponse {
  html?: string;
  slug?: string;
  summary?: string;
}

const PREVIEW_DEBOUNCE_MS = 400;
const IFRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals';
// Max document-history snapshots retained for undo/redo (Feature B).
const HISTORY_CAP = 30;
// Preset color swatches offered in the edit panel (Feature C).
const CDZ_SWATCHES = [
  '#10a37f',
  '#2f7bff',
  '#d33030',
  '#f59e0b',
  '#8b5cf6',
  '#ffffff',
  '#111111',
  '#6b7280',
];
// (Font-size min/max now come from the font-size prop in CDZ_EDIT_STYLE_PROPS.)
// Edit-in-context bounds for the AI dock request (mirror the backend caps).
const CDZ_HTML_CAP = 512_000;
const CDZ_HISTORY_MAX_TURNS = 6;
const CDZ_TURN_TEXT_CAP = 2_000;
const CDZ_HISTORY_TOTAL_CAP = 8_000;
const CDZ_SELECTION_TEXT_CAP = 200;
const CDZ_SELECTION_DESCRIPTOR_CAP = 500;
const CDZ_DEFAULT_SUMMARY = 'Updated';

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

    /* editable app title (v3) — looks like text until hover/focus */
    .cdz-title-input {
      min-width: 40px;
      max-width: 320px;
      padding: 2px 6px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--cdz-text);
      font-family: var(--cdz-sans);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.1px;
      text-overflow: ellipsis;
      cursor: text;
    }
    .cdz-title-input:hover {
      border-color: var(--cdz-border);
    }
    .cdz-title-input:focus {
      outline: none;
      border-color: var(--cdz-accent);
      background: color-mix(in srgb, var(--cdz-accent) 8%, transparent);
    }

    /* ── AI dock scope chip (Studio v3) ── */
    .cdz-scope {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .cdz-scope-chip {
      padding: 2px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--cdz-accent) 16%, transparent);
      color: var(--cdz-accent);
      font-family: var(--cdz-mono);
      font-size: 11px;
      font-weight: 600;
    }
    .cdz-scope-clear {
      border: 1px solid var(--cdz-border);
      border-radius: 6px;
      background: transparent;
      color: var(--cdz-text-2);
      font: inherit;
      font-size: 11px;
      padding: 2px 8px;
      cursor: pointer;
    }
    .cdz-scope-clear:hover {
      color: var(--cdz-text);
      border-color: var(--cdz-accent);
    }

    /* ── AI-edit diff review overlay (Studio v3) ── */
    .cdz-dock {
      position: relative;
    }
    .cdz-ai-diff {
      position: absolute;
      inset: 0;
      z-index: 6;
      display: flex;
      flex-direction: column;
      background: var(--cdz-bg-2);
    }
    .cdz-ai-diff-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--cdz-border);
      color: var(--cdz-accent);
    }
    .cdz-ai-diff-title {
      color: var(--cdz-text);
      font-weight: 700;
      font-size: 13px;
    }
    .cdz-ai-diff-body {
      flex: 1;
      min-height: 0;
      overflow: auto;
    }
    .cdz-ai-diff-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 14px;
      border-top: 1px solid var(--cdz-border);
    }
    .cdz-ai-diff-actions {
      display: flex;
      gap: 8px;
    }

    /* ── Version-history panel (Studio v3) ── */
    .cdz-shell {
      position: relative;
    }
    .cdz-versions {
      position: absolute;
      top: 56px;
      right: 16px;
      z-index: 30;
      width: min(300px, calc(100% - 32px));
      max-height: min(60vh, 460px);
      display: flex;
      flex-direction: column;
      border: 1px solid var(--cdz-border);
      border-radius: 12px;
      background: var(--cdz-bg-2);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }
    .cdz-versions-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--cdz-border);
      color: var(--cdz-text);
      font-weight: 700;
      font-size: 13px;
    }
    .cdz-versions-head span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .cdz-versions-body {
      overflow: auto;
      padding: 6px;
    }
    /* Problems panel (Debugging bundle) — reuses .cdz-versions chrome, wider. */
    .cdz-problems {
      width: min(360px, calc(100% - 32px));
    }
    .cdz-problems .cdz-versions-head span {
      color: #f59e0b;
    }
    /* toolbar error-count badge */
    .cdz-btn {
      position: relative;
    }
    .cdz-badge {
      position: absolute;
      top: -4px;
      right: -4px;
      min-width: 15px;
      height: 15px;
      padding: 0 4px;
      border-radius: 999px;
      background: var(--cdz-danger);
      color: #fff;
      font: 700 10px/15px var(--cdz-sans);
      text-align: center;
      box-shadow: 0 0 0 2px var(--cdz-bg-2);
    }

    /* segmented control — pill container w/ active "thumb" */
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
      padding: 6px 14px;
      cursor: pointer;
      color: var(--cdz-text-2);
      background: transparent;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      transition: color 0.15s ease, background 0.15s ease,
        box-shadow 0.15s ease;
    }

    .cdz-seg button:hover {
      color: var(--cdz-text);
    }

    .cdz-seg button.active {
      color: var(--cdz-text);
      background: var(--cdz-bg);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4),
        inset 0 0 0 1px rgba(255, 255, 255, 0.04);
    }

    .cdz-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      justify-content: flex-end;
    }

    /* group wrapper w/ 1px dividers between toolbar clusters */
    .cdz-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .cdz-group + .cdz-group {
      margin-left: 6px;
      padding-left: 8px;
      border-left: 1px solid var(--cdz-border);
    }

    /* ── unified button system ───────────────────────────── */
    button.cdz-btn,
    a.cdz-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      appearance: none;
      box-sizing: border-box;
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
      color: var(--cdz-text);
      background: transparent;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      line-height: 1;
      text-decoration: none;
      transition: border-color 0.15s ease, background 0.15s ease,
        color 0.15s ease, box-shadow 0.15s ease, transform 0.1s ease;
    }

    button.cdz-btn svg,
    a.cdz-btn svg {
      display: block;
      flex-shrink: 0;
    }

    button.cdz-btn:focus-visible,
    a.cdz-btn:focus-visible,
    .cdz-seg button:focus-visible,
    .cdz-swatch:focus-visible,
    .cdz-step:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--cdz-bg), 0 0 0 4px var(--cdz-accent);
    }

    /* primary — solid brand green w/ lift + shadow on hover */
    button.cdz-btn.primary,
    a.cdz-btn.primary {
      border-color: var(--cdz-accent);
      color: #04241b;
      background: var(--cdz-accent);
    }

    button.cdz-btn.primary:hover:not(:disabled),
    a.cdz-btn.primary:hover {
      background: #0d8a6c;
      border-color: #0d8a6c;
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(16, 163, 127, 0.32);
    }

    button.cdz-btn.primary:active:not(:disabled) {
      transform: translateY(0);
      box-shadow: 0 2px 8px rgba(16, 163, 127, 0.28);
    }

    /* secondary — outlined */
    button.cdz-btn.secondary,
    a.cdz-btn.secondary {
      border-color: var(--cdz-border);
      color: var(--cdz-text);
      background: var(--cdz-bg-3);
    }

    button.cdz-btn.secondary:hover:not(:disabled),
    a.cdz-btn.secondary:hover {
      border-color: #3a4048;
      background: #2a2f37;
    }

    /* ghost — text only, hover bg */
    button.cdz-btn.ghost,
    a.cdz-btn.ghost {
      border-color: transparent;
      color: var(--cdz-text-2);
      background: transparent;
    }

    button.cdz-btn.ghost:hover:not(:disabled),
    a.cdz-btn.ghost:hover {
      color: var(--cdz-text);
      background: var(--cdz-bg-3);
    }

    /* pressed / toggled state (inspect) */
    button.cdz-btn.toggled {
      border-color: var(--cdz-accent);
      color: var(--cdz-accent);
      background: rgba(16, 163, 127, 0.14);
    }

    /* icon-only button (square, holds a 16px svg) */
    button.cdz-btn.icon,
    a.cdz-btn.icon {
      width: 32px;
      height: 32px;
      padding: 0;
    }

    button.cdz-btn:disabled {
      cursor: not-allowed;
      opacity: 0.5;
      transform: none;
      box-shadow: none;
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
      width: min(320px, calc(100% - 32px));
      padding: 14px;
      border: 1px solid var(--cdz-border);
      border-radius: 12px;
      color: var(--cdz-text);
      background: var(--cdz-bg-2);
      box-shadow: 0 20px 56px rgba(0, 0, 0, 0.6),
        0 0 0 1px rgba(255, 255, 255, 0.03);
    }

    .cdz-edit-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    .cdz-edit-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-radius: 6px;
      color: var(--cdz-accent);
      background: rgba(16, 163, 127, 0.12);
      font-family: var(--cdz-mono);
      font-size: 11px;
      font-weight: 700;
      text-transform: lowercase;
    }

    /* on-canvas element actions (duplicate / move / delete) in the panel head */
    .cdz-el-toolbar {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      margin-left: auto;
      margin-right: 4px;
      padding: 2px;
      border-radius: 8px;
      background: var(--cdz-bg-3);
      border: 1px solid var(--cdz-border);
    }

    /* compact icon buttons inside the toolbar (smaller than the 32px default) */
    .cdz-el-toolbar button.cdz-btn.icon {
      width: 26px;
      height: 26px;
      border-radius: 6px;
    }

    .cdz-el-toolbar button.cdz-btn.icon svg {
      width: 15px;
      height: 15px;
    }

    /* delete button: danger tint on hover only (neutral at rest) */
    button.cdz-btn.ghost.danger:hover:not(:disabled) {
      color: var(--cdz-danger);
      background: rgba(242, 104, 107, 0.12);
    }

    .cdz-field {
      margin-top: 10px;
    }

    .cdz-edit-panel label {
      display: block;
      margin: 0 0 5px;
      color: var(--cdz-text-2);
      font-size: 11px;
      font-weight: 600;
    }

    .cdz-edit-panel textarea,
    .cdz-edit-panel input[type='number'],
    .cdz-edit-panel input[type='text'].cdz-text-input,
    .cdz-edit-panel select.cdz-select {
      box-sizing: border-box;
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--cdz-border);
      border-radius: 8px;
      color: var(--cdz-text);
      background: var(--cdz-bg);
      font: inherit;
      font-size: 12px;
    }

    .cdz-edit-panel select.cdz-select {
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
    }

    .cdz-edit-panel textarea {
      min-height: 58px;
      resize: vertical;
      font-family: var(--cdz-mono);
      line-height: 1.5;
    }

    .cdz-edit-panel textarea:focus,
    .cdz-edit-panel input:focus,
    .cdz-edit-panel select.cdz-select:focus {
      outline: none;
      border-color: var(--cdz-accent);
      box-shadow: 0 0 0 3px rgba(16, 163, 127, 0.16);
    }

    /* color swatch row */
    .cdz-swatches {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .cdz-swatch {
      width: 22px;
      height: 22px;
      padding: 0;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      cursor: pointer;
      transition: transform 0.1s ease, box-shadow 0.12s ease;
    }

    .cdz-swatch:hover {
      transform: translateY(-1px);
    }

    .cdz-swatch.active {
      box-shadow: 0 0 0 2px var(--cdz-bg-2), 0 0 0 4px var(--cdz-accent);
    }

    input[type='color'].cdz-color {
      box-sizing: border-box;
      width: 34px;
      height: 26px;
      padding: 2px;
      border: 1px solid var(--cdz-border);
      border-radius: 6px;
      background: var(--cdz-bg);
      cursor: pointer;
    }

    /* font-size stepper */
    .cdz-stepper {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .cdz-step {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 1px solid var(--cdz-border);
      border-radius: 7px;
      cursor: pointer;
      color: var(--cdz-text);
      background: var(--cdz-bg-3);
      font: inherit;
      font-size: 15px;
      font-weight: 600;
      line-height: 1;
      transition: border-color 0.12s ease, background 0.12s ease;
    }

    .cdz-step:hover {
      border-color: #3a4048;
      background: #2a2f37;
    }

    .cdz-stepper input[type='number'] {
      width: 58px;
      text-align: center;
    }

    /* strip native number spinners for a cleaner stepper */
    .cdz-stepper input[type='number']::-webkit-outer-spin-button,
    .cdz-stepper input[type='number']::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    .cdz-edit-foot {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }

    .cdz-edit-foot button {
      flex: 1;
    }

    .cdz-edit-hint {
      margin-top: 10px;
      color: var(--cdz-text-2);
      font-size: 10.5px;
      line-height: 1.4;
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
      border-radius: 10px;
      font-size: 12px;
      line-height: 1.45;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .cdz-msg.user {
      align-self: flex-end;
      color: var(--cdz-text);
      background: rgba(16, 163, 127, 0.18);
      border: 1px solid rgba(16, 163, 127, 0.34);
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

    /* typing indicator — 3 bouncing dots (shown while aiBusy) */
    .cdz-typing {
      align-self: flex-start;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 10px 12px;
      border: 1px solid var(--cdz-border);
      border-radius: 10px;
      border-bottom-left-radius: 3px;
      background: var(--cdz-bg-3);
    }

    .cdz-typing span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--cdz-text-2);
      animation: cdz-bounce 1.2s ease-in-out infinite;
    }

    .cdz-typing span:nth-child(2) {
      animation-delay: 0.15s;
    }

    .cdz-typing span:nth-child(3) {
      animation-delay: 0.3s;
    }

    @keyframes cdz-bounce {
      0%,
      60%,
      100% {
        transform: translateY(0);
        opacity: 0.5;
      }
      30% {
        transform: translateY(-4px);
        opacity: 1;
      }
    }

    /* dock send button (icon) sits inline with the hint */
    .cdz-dock-send .cdz-btn.icon {
      width: 34px;
      height: 34px;
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

  // Free-move mode (Studio v3): when on (implies inspect on), dragging an
  // element repositions it freely via inline transform instead of reordering.
  @state()
  private accessor freeMove = false;

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

  // AI-dock conversation log (user prompts + system status lines). Renamed
  // from `history` in v1 so the name doesn't collide with the undo/redo
  // snapshot stack below (Feature B), which is the *document* history.
  @state()
  private accessor chatLog: CdzHistoryItem[] = [];

  // Real model turn log (user prompts + accepted assistant summaries) sent as
  // multi-turn context — distinct from chatLog, which holds UI status lines.
  @state()
  private accessor turnLog: CdzTurn[] = [];

  // Pending AI edit awaiting Accept/Revert (diff gate, Studio v3).
  @state()
  private accessor pendingHtml: string | null = null;

  @state()
  private accessor pendingSummary = '';

  // Version-history panel visibility (Studio v3).
  @state()
  private accessor showVersions = false;

  // Captured runtime console/errors from the preview + panel visibility (v3).
  @state()
  private accessor problems: CdzProblem[] = [];

  @state()
  private accessor showProblems = false;

  @state()
  private accessor previewSrc = '';

  /* draft values for the floating edit panel */
  @state()
  private accessor editText = '';

  // Generic inline-style drafts for the selected element, one entry per
  // CdzStyleProp.key (e.g. { 'color': '#10a37f', 'font-size': '24' }). Number
  // kinds hold the BARE number (unit re-applied on Apply); color/select/text
  // kinds hold the raw string. Reseeded per selection by seedEditDrafts.
  @state()
  private accessor editStyles: Record<string, string> = {};

  // The prop keys the user actually touched this selection. Generalizes the old
  // single `editColorDirty` boolean: many controls (a native <input type=color>
  // defaulting to #000000, a select showing its first option) are never
  // "empty", so without per-field dirty tracking Apply would promote
  // untouched/class-based values to inline. Only keys in this set are written
  // on Apply. Reset per selection; set by every control handler via markDirty.
  @state()
  private accessor editDirty: Set<string> = new Set();

  /**
   * Undo/redo cursor (Feature B). Reactive so the toolbar undo/redo buttons
   * re-evaluate their `?disabled` getters (canUndo/canRedo) whenever we push or
   * move the cursor. The snapshot array itself (`history`) is a plain field —
   * only the index gates the buttons, and every push/undo/redo moves the index,
   * so index reactivity is sufficient to keep the UI in sync.
   */
  @state()
  private accessor historyIndex = -1;

  /* ─────────────────── non-reactive fields ─────────────────── */

  // Document undo/redo snapshot stack of workingHtml strings (Feature B).
  // Capped at HISTORY_CAP (oldest dropped). NOT the AI chatLog.
  private history: string[] = [];
  // Index-aligned metadata for `history` (label/kind/ts) — powers the version
  // panel without disturbing the proven undo/redo string stack (Studio v3).
  private historyMeta: CdzSnapshotMeta[] = [];

  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  // Debounced boundary for pushing a code-edit history snapshot (Feature B
  // push-point d) so a burst of keystrokes collapses to a single undo entry.
  private codeHistoryTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (this.codeHistoryTimer !== null) {
      clearTimeout(this.codeHistoryTimer);
      this.codeHistoryTimer = null;
    }
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>) {
    // Closing the overlay resets the session so the NEXT open re-seeds cleanly.
    if (changed.has('open') && !this.open) {
      this.initialized = false;
      this.selected = null;
      this.inspect = false;
      // Drop the document-history stack so the next open starts a fresh
      // baseline rather than letting undo reach into a prior session.
      this.history = [];
      this.historyMeta = [];
      this.historyIndex = -1;
      this.turnLog = [];
      this.pendingHtml = null;
      this.pendingSummary = '';
      this.showVersions = false;
      this.problems = [];
      this.showProblems = false;
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
      // Feature B push-point (a): seed the undo baseline with the opening
      // snapshot so the first structural edit has something to undo back to.
      this.pushHistory(this.workingHtml, makeMeta('baseline', 'Original'));
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
        // Keep the history invariant (tip === workingHtml): a genuine external
        // swap becomes a new checkpoint on the stack (Feature B).
        this.pushHistory(this.workingHtml, makeMeta('baseline'));
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
   * Feature B push-point (d): debounced code-edit history boundary. Called on
   * every code-editor keystroke; only the LAST keystroke of a burst survives
   * the debounce, at which point we push the settled workingHtml. pushHistory
   * collapses it against the current top, so a burst that lands identical to
   * the tip (or a no-op edit) adds nothing.
   */
  private scheduleCodeHistory() {
    if (this.codeHistoryTimer !== null) clearTimeout(this.codeHistoryTimer);
    this.codeHistoryTimer = setTimeout(() => {
      this.codeHistoryTimer = null;
      this.pushHistory(this.workingHtml, makeMeta('code'));
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
    // Each rebuild reloads the iframe → clear captured problems; the fresh run
    // repopulates them via cdz-console messages (Debugging bundle).
    this.problems = [];
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

    // Console/error capture — injected FIRST in <head> so it catches errors
    // from the app's very first line; posts cdz-console messages to the parent.
    const consoleScript = doc.createElement('script');
    consoleScript.textContent = CDZ_CONSOLE_BRIDGE;
    doc.head.insertBefore(consoleScript, doc.head.firstChild);

    // Hover / selection outline styles.
    const style = doc.createElement('style');
    style.textContent = CDZ_INSPECT_STYLE;
    doc.head.appendChild(style);

    // Inspect bridge script (guarded to only act when toggled on). Boots in the
    // current inspect + free-move mode so a rebuild preserves the active mode.
    const script = doc.createElement('script');
    script.textContent = buildBridgeScript(this.inspect, this.freeMove);
    doc.body.appendChild(script);

    const doctype = doc.doctype ? '<!DOCTYPE html>\n' : '';
    this.previewSrc = doctype + doc.documentElement.outerHTML;
  }

  /* ─────────────────── parent ⇄ iframe messaging ─────────────────── */

  private postToFrame(message: { type: string; on?: boolean; free?: boolean }) {
    const frame = this.renderRoot.querySelector<HTMLIFrameElement>(
      'iframe.cdz-studio-frame'
    );
    frame?.contentWindow?.postMessage(message, '*');
  }

  // Push the current inspect + free-move mode to the already-loaded frame.
  private postMode() {
    this.postToFrame({
      type: 'cdz-mode',
      on: this.inspect,
      free: this.freeMove,
    });
  }

  private handleMessage(event: MessageEvent) {
    if (!this.open) return;
    const frame = this.renderRoot.querySelector<HTMLIFrameElement>(
      'iframe.cdz-studio-frame'
    );
    // Only trust messages coming from our own preview iframe.
    if (!frame || event.source !== frame.contentWindow) return;

    const data = event.data as
      | Partial<
          CdzPickMessage & CdzMoveMessage & CdzFreeMessage & CdzTextMessage
        >
      | null;
    if (!data) return;

    // Drag-reorder / reparent — re-parse & relocate the node, then commit.
    if (data.type === 'cdz-move') {
      if (typeof data.id !== 'number') return;
      const beforeId =
        typeof data.beforeId === 'number' ? data.beforeId : null;
      const parentId =
        typeof data.parentId === 'number' ? data.parentId : undefined;
      this.moveNode(data.id, beforeId, parentId);
      return;
    }

    // Freeform move (Studio v3) — bake the translate delta into the element's
    // inline transform. DOM order is preserved, so any selection stays valid.
    if (data.type === 'cdz-free') {
      if (typeof data.id !== 'number') return;
      const dx = typeof data.dx === 'number' ? data.dx : 0;
      const dy = typeof data.dy === 'number' ? data.dy : 0;
      if (dx === 0 && dy === 0) return;
      this.applyFreeMove(data.id, dx, dy);
      return;
    }

    // Inline text edit (S1) — a double-click-to-edit on a text element
    // committed in the preview. Apply the new direct text + commit an edit.
    if (data.type === 'cdz-text') {
      if (typeof data.id !== 'number') return;
      const text = typeof data.text === 'string' ? data.text : '';
      this.applyTextEdit(data.id, text);
      return;
    }

    // Runtime console/errors captured from the preview (Debugging bundle).
    if ((data as { type?: unknown }).type === 'cdz-console') {
      const msg = normalizeConsoleMessage(data);
      if (msg) this.problems = coalesceProblem(this.problems, msg, 50);
      return;
    }

    if (data.type !== 'cdz-pick') return;
    if (typeof data.id !== 'number') return;

    this.selected = {
      id: data.id,
      tag: typeof data.tag === 'string' ? data.tag : '',
      text: typeof data.text === 'string' ? data.text : '',
    };
    // Seed the edit-panel drafts from the current DOM state of that node.
    this.seedEditDrafts(this.selected);
  }

  /**
   * Feature A / B — relocate the element with data-cdz-id `id` so it sits
   * immediately before the sibling with `beforeId` (or at the end of its parent
   * when `beforeId` is null). v1 scope is SAME-PARENT reorder only: a move whose
   * target sibling lives under a different parent is ignored.
   *
   * Routes through the SAME `walkBody` order used for augmentation/apply so the
   * ids in the message line up with the nodes here. Pushes an undo snapshot
   * BEFORE mutating, strips all bookkeeping ids, commits via the shared
   * replaceBodyInner path, and CLEARS `selected` (ids re-derive after the move,
   * so a stale selection would point at the wrong node).
   *
   * Returns the moved node's NEW id (its index in a fresh walk of the mutated
   * source) so callers like the arrow-nudge can re-identify and keep it
   * selected; returns null when the move was rejected/failed.
   */
  private moveNode(
    id: number,
    beforeId: number | null,
    parentId?: number
  ): number | null {
    // ── Cross-parent reparent path (cdz-element-ops) ───────────────────────
    // `parentId` names the container the node is dropped INTO. When `beforeId`
    // is a child of that container we insert before it; otherwise append into.
    if (typeof parentId === 'number') {
      let movingRef: Element | null = null;
      const doc = this.walkBody(this.workingHtml, (el, walkId) => {
        if (walkId === id) movingRef = el;
      });
      if (!doc || !movingRef) return null;
      const movingEl = movingRef as Element;

      let target: Element | null = null;
      if (beforeId !== null) {
        const all = doc.body.querySelectorAll('*');
        const cand = beforeId < all.length ? all[beforeId] : null;
        const parentEl = parentId < all.length ? all[parentId] : null;
        // Only treat it as a "before" target when it truly lives under
        // parentId (the bridge nulls beforeId for append-into, but guard).
        if (cand && parentEl && cand.parentElement === parentEl) {
          target = cand;
        }
      }
      const targetId = target !== null ? (beforeId as number) : parentId;
      const mode: 'before' | 'append-into' =
        target !== null ? 'before' : 'append-into';

      // Cycle / validity guard (self, target-inside-moving, bad ids).
      if (!canReparent(doc, id, targetId)) return null;
      if (!reparentElement(doc, id, targetId, mode)) return null;

      // New id via a fresh walk of the mutated doc, matched on live identity
      // (before stripping ids — walk order is identical either way).
      let newId: number | null = null;
      {
        const all = doc.body.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          if (all[i] === movingEl) {
            newId = i;
            break;
          }
        }
      }

      doc.body.querySelectorAll('[data-cdz-id]').forEach(el => {
        el.removeAttribute('data-cdz-id');
      });

      this.commitBodyMutation(doc, 'move');
      this.selected = null;
      return newId;
    }

    // ── Same-parent reorder path (legacy — unchanged) ──────────────────────
    let node: Element | null = null;
    let before: Element | null = null;
    const doc = this.walkBody(this.workingHtml, (el, walkId) => {
      if (walkId === id) node = el;
      if (beforeId !== null && walkId === beforeId) before = el;
    });
    if (!doc || !node) return null;
    // TS: `node`/`before` are narrowed to never inside the closure; re-assert.
    const moving = node as Element;
    const target = before as Element | null;

    const parent = moving.parentElement;
    if (!parent) return null;

    // v1 guard: same-parent only. A missing/other-parent target is rejected,
    // EXCEPT the null (append-to-end-of-this-parent) case which is always same
    // parent by construction.
    if (beforeId !== null) {
      if (!target) return null;
      if (target.parentElement !== parent) return null;
      if (target === moving) return null; // no-op drop onto itself
    }

    // (Feature B) The post-move state is pushed by commitBodyMutation below;
    // the pre-move state is already the current history tip.
    if (target) {
      parent.insertBefore(moving, target);
    } else {
      // Append at the end of the SAME parent (after its last sibling).
      parent.appendChild(moving);
    }

    // Compute the moved node's new id by re-walking the mutated doc BEFORE we
    // strip bookkeeping ids (walk order is identical either way, but we hold a
    // live reference so identity — not the attribute — is what we match on).
    let newId: number | null = null;
    {
      const all = doc.body.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        if (all[i] === moving) {
          newId = i;
          break;
        }
      }
    }

    // Strip bookkeeping ids from EVERY element before serializing back.
    doc.body.querySelectorAll('[data-cdz-id]').forEach(el => {
      el.removeAttribute('data-cdz-id');
    });

    this.commitBodyMutation(doc, 'move');
    // After a structural move the id space is re-derived; drop the stale
    // selection so the edit panel never lies about which node is active.
    this.selected = null;
    return newId;
  }

  /**
   * Freeform move (Studio v3): bake a translate delta into the element's inline
   * transform, accumulating onto any existing translate. Routes through the
   * shared walkBody id order and commitBodyMutation (so undo/redo + persistence
   * come for free). DOM order is unchanged — unlike moveNode — so the current
   * selection (if it is this node) stays valid and we leave it intact.
   */
  private applyFreeMove(id: number, dx: number, dy: number) {
    let matched = false;
    const doc = this.walkBody(this.workingHtml, (el, walkId) => {
      if (walkId !== id) return;
      matched = true;
      const style = el.getAttribute('style') ?? '';
      const tfMatch = /(?:^|;)\s*transform\s*:\s*([^;]+)/i.exec(style);
      const currentTf = tfMatch ? tfMatch[1].trim() : '';
      const base = readTranslate(currentTf);
      const nextTf = withTranslate(
        currentTf,
        Math.round(base.x + dx),
        Math.round(base.y + dy)
      );
      setInlineStyle(el, { transform: nextTf });
    });
    if (!doc || !matched) return;
    doc.body
      .querySelectorAll('[data-cdz-id]')
      .forEach(el => el.removeAttribute('data-cdz-id'));
    this.commitBodyMutation(doc, 'move');
  }

  /* ─────────────────── arrow-key nudge (Feature A) ─────────────────── */

  /**
   * Move the currently-selected element one slot earlier (`-1`) or later
   * (`+1`) among its ELEMENT siblings. Bound to Alt+ArrowUp / Alt+ArrowDown at
   * the overlay level (only when inspect is on and something is selected).
   *
   * Safety: a selection's id is only valid for the workingHtml snapshot it was
   * picked from, and workingHtml can change out from under it if the user typed
   * in the code editor. So before nudging we re-walk and verify the element at
   * `selected.id` still has the same tagName; on mismatch we drop the nudge and
   * clear the (now-stale) selection rather than move the wrong node.
   */
  private nudgeSelected(direction: -1 | 1) {
    const sel = this.selected;
    if (!sel || !this.inspect) return;

    // Single walk of the CURRENT source: record the element at sel.id plus a
    // map from every element to its walk-id. Doing this in ONE parse is
    // essential — nodes from separate DOMParser passes are distinct objects, so
    // cross-parse identity comparison would never match.
    let current: Element | null = null;
    const idOf = new Map<Element, number>();
    this.walkBody(this.workingHtml, (el, id) => {
      idOf.set(el, id);
      if (id === sel.id) current = el;
    });
    const el = current as Element | null;
    // Stale-selection guard: id no longer resolves, or now points at a
    // different tag → the source moved under us. Drop the nudge + selection.
    if (!el || el.tagName.toLowerCase() !== (sel.tag || '').toLowerCase()) {
      this.selected = null;
      return;
    }
    const node = el as Element;

    const parent = node.parentElement;
    if (!parent) return;

    // Element-only sibling list, in order (from the SAME parse).
    const siblings = Array.from(parent.children);
    const pos = siblings.indexOf(node);
    if (pos === -1) return;

    // Determine the reference sibling to insert BEFORE (or null = append).
    let refSibling: Element | null;
    if (direction === -1) {
      if (pos === 0) return; // already first — nothing to do
      refSibling = siblings[pos - 1]; // hop before the previous sibling
    } else {
      if (pos >= siblings.length - 1) return; // already last
      // Move past the next sibling: insert before the one AFTER next, or
      // append (null) when next is the final sibling.
      refSibling = siblings[pos + 2] ?? null;
    }

    // Translate the reference sibling into its walk-id (from the SAME map) so
    // we can reuse the shared moveNode routine, which re-parses from an
    // identical walk order and thus resolves the same ids.
    let refId: number | null = null;
    if (refSibling) {
      const found = idOf.get(refSibling);
      // Should always resolve (refSibling came from this walk); bail if not.
      if (found === undefined) return;
      refId = found;
    }

    const newId = this.moveNode(sel.id, refId);
    // Re-identify the moved node in the fresh id space so repeated Alt+Arrow
    // keeps working fluidly on the same element.
    if (newId !== null) {
      this.reselectById(newId);
    }
  }

  /**
   * Re-establish `selected` at a freshly-derived id after a structural move,
   * re-deriving tag/text from the (now-clean) workingHtml so the edit panel
   * tracks the same node the user was nudging.
   */
  private reselectById(id: number) {
    let tag = '';
    let text = '';
    let found = false;
    this.walkBody(this.workingHtml, (el, walkId) => {
      if (walkId !== id) return;
      found = true;
      tag = el.tagName.toLowerCase();
      text = this.directText(el);
    });
    if (!found) {
      this.selected = null;
      return;
    }
    this.selected = { id, tag, text };
    this.seedEditDrafts(this.selected);
  }

  /* ─────────────────── element toolbar ops (Studio v3) ─────────────────── */

  /**
   * Duplicate the currently-selected element: deep-clone it and insert the copy
   * immediately after the original (via cdz-element-ops.duplicateElement).
   * Re-selects the ORIGINAL by re-deriving its id in the mutated id space.
   */
  private duplicateSelected() {
    const sel = this.selected;
    if (!sel) return;
    let original: Element | null = null;
    const doc = this.walkBody(this.workingHtml, (el, walkId) => {
      if (walkId === sel.id) original = el;
    });
    if (!doc || !original) return;
    const originalEl = original as Element;

    if (!duplicateElement(doc, sel.id)) return;

    // New id of the ORIGINAL (identity match, before stripping ids).
    let newId: number | null = null;
    {
      const all = doc.body.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        if (all[i] === originalEl) {
          newId = i;
          break;
        }
      }
    }

    doc.body
      .querySelectorAll('[data-cdz-id]')
      .forEach(el => el.removeAttribute('data-cdz-id'));

    this.commitBodyMutation(doc, 'edit');

    // Re-derive selection onto the original so the panel stays open on it.
    if (newId !== null) this.reselectById(newId);
    else this.selected = null;
  }

  /**
   * Delete the currently-selected element (via cdz-element-ops.removeElement,
   * which refuses <body>/missing). Ids re-derive after removal — clear the
   * selection so the panel never points at the wrong node.
   */
  private deleteSelected() {
    const sel = this.selected;
    if (!sel) return;
    const doc = this.walkBody(this.workingHtml, () => {});
    if (!doc) return;

    if (!removeElement(doc, sel.id)) return;

    doc.body
      .querySelectorAll('[data-cdz-id]')
      .forEach(el => el.removeAttribute('data-cdz-id'));

    this.commitBodyMutation(doc, 'edit');
    this.selected = null;
  }

  /* ─────────────────── undo / redo (Feature B) ─────────────────── */

  private get canUndo(): boolean {
    return this.historyIndex > 0;
  }

  private get canRedo(): boolean {
    return this.historyIndex < this.history.length - 1;
  }

  /**
   * Push a snapshot onto the document-history stack. Truncates any redo tail
   * (standard branch behavior), collapses consecutive duplicates (so we never
   * store the same string twice in a row), and caps the stack at HISTORY_CAP by
   * dropping the oldest entry.
   */
  private pushHistory(snapshot: string, meta?: CdzSnapshotMeta) {
    // If the pointer isn't at the tip, drop the redo tail before pushing
    // (mirror the truncation onto historyMeta so the two stay index-aligned).
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.historyMeta = this.historyMeta.slice(0, this.historyIndex + 1);
    }
    // Collapse no-op pushes (identical to current top) — no meta added either.
    if (
      this.history.length > 0 &&
      this.history[this.history.length - 1] === snapshot
    ) {
      return;
    }
    this.history.push(snapshot);
    this.historyMeta.push(meta ?? makeMeta('edit'));
    if (this.history.length > HISTORY_CAP) {
      this.history.shift(); // drop oldest
      this.historyMeta.shift();
    }
    this.historyIndex = this.history.length - 1;
  }

  /**
   * If a debounced code-edit checkpoint is still pending, commit it now so the
   * current typed state is on the stack before we navigate history. Otherwise a
   * mid-burst undo could skip past the unsaved edit with no way to redo to it.
   */
  private flushPendingCodeHistory() {
    if (this.codeHistoryTimer !== null) {
      clearTimeout(this.codeHistoryTimer);
      this.codeHistoryTimer = null;
      this.pushHistory(this.workingHtml, makeMeta('code'));
    }
  }

  private undo() {
    this.flushPendingCodeHistory();
    if (!this.canUndo) return;
    this.historyIndex -= 1;
    this.restoreSnapshot(this.history[this.historyIndex]);
  }

  private redo() {
    this.flushPendingCodeHistory();
    if (!this.canRedo) return;
    this.historyIndex += 1;
    this.restoreSnapshot(this.history[this.historyIndex]);
  }

  /**
   * Restore a history snapshot into workingHtml, rebuild the preview, schedule
   * the html-change emit, and clear any selection (its id belongs to a
   * different source snapshot). Does NOT push — undo/redo only move the cursor.
   */
  private restoreSnapshot(snapshot: string) {
    this.workingHtml = snapshot;
    this.selected = null;
    this.buildPreviewNow();
    this.scheduleHtmlChange();
  }

  /**
   * Jump directly to a history index (version panel). A superset of undo/redo:
   * flush any pending code checkpoint, clamp, move the cursor, restore. Never
   * pushes, so entries above/below stay intact and canUndo/canRedo recompute.
   */
  private restoreTo(index: number) {
    this.flushPendingCodeHistory();
    if (
      index < 0 ||
      index >= this.history.length ||
      index === this.historyIndex
    ) {
      return;
    }
    this.historyIndex = index;
    this.restoreSnapshot(this.history[index]);
  }

  private seedEditDrafts(sel: CdzSelected) {
    // Default to the text the iframe reported, but prefer re-deriving it from
    // the canonical workingHtml (same deterministic walk) so the parent is the
    // source of truth and any iframe/source drift can't desync the editor.
    this.editText = sel.text;
    // Reset the generic style drafts + dirty set for the new selection.
    this.editStyles = {};
    this.editDirty = new Set();
    this.walkBody(this.workingHtml, (el, id) => {
      if (id !== sel.id) return;
      this.editText = this.directText(el);
      const style = el.getAttribute('style') ?? '';
      const next: Record<string, string> = {};
      for (const prop of CDZ_EDIT_STYLE_PROPS) {
        // readStyleValue returns '' when the prop is absent from the inline
        // style (mirrors setInlineStyle's lowercase-key merge semantics).
        const raw = readStyleValue(style, prop.key).trim();
        if (!raw) continue;
        if (prop.kind === 'color') {
          // Normalize to #rrggbb for the swatch highlight + native picker;
          // fall back to the raw value if it isn't a recognizable color.
          next[prop.key] = normalizeColor(raw) || raw.toLowerCase();
        } else if (prop.kind === 'number') {
          // Store the bare number (strip the unit) so the number input shows
          // "24" not "24px"; the unit is re-applied on Apply.
          const num = parseFloat(raw);
          next[prop.key] = Number.isFinite(num) ? String(num) : '';
        } else {
          next[prop.key] = raw;
        }
      }
      this.editStyles = next;
    });
  }

  /* ─────────────────── inspect toggle ─────────────────── */

  private toggleInspect() {
    this.inspect = !this.inspect;
    if (!this.inspect) {
      this.selected = null;
      // Free-move needs the overlay; turning inspect off turns it off too.
      this.freeMove = false;
    }
    // Rebuild srcdoc so the bridge boots in the right mode, then also post the
    // live mode for the already-loaded frame.
    this.buildPreviewNow();
    this.postMode();
  }

  // Free-move toggle (Studio v3). Turning it on implies inspect on (the overlay
  // must be active to receive pointer drags).
  private toggleFreeMove() {
    this.freeMove = !this.freeMove;
    if (this.freeMove && !this.inspect) this.inspect = true;
    this.buildPreviewNow();
    this.postMode();
  }

  private toggleVersions() {
    this.showVersions = !this.showVersions;
  }

  private toggleProblems() {
    this.showProblems = !this.showProblems;
  }

  // Error-only count for the toolbar Problems badge.
  private get problemErrorCount(): number {
    return this.problems.reduce(
      (n, p) => (p.level === 'error' ? n + p.count : n),
      0
    );
  }

  /* ─────────────────── apply a click-to-edit change ─────────────────── */

  /**
   * Collect the inline-style declarations to write on Apply: one entry per
   * DIRTY style prop (a key the user touched this selection), skipping empty
   * drafts. Number kinds re-append their unit (default 'px'); color/select/text
   * kinds pass the raw draft through. Keyed by the prop's lowercase css key so
   * it drops straight into setInlineStyle's merge.
   */
  private dirtyStyleDecls(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const prop of CDZ_EDIT_STYLE_PROPS) {
      if (!this.editDirty.has(prop.key)) continue;
      const raw = (this.editStyles[prop.key] ?? '').trim();
      if (!raw) continue;
      out[prop.key] =
        prop.kind === 'number' ? `${raw}${prop.unit ?? 'px'}` : raw;
    }
    return out;
  }

  private applyEdit() {
    const sel = this.selected;
    if (!sel) return;

    const newText = this.editText;
    // Build the inline-style declarations to merge: every DIRTY style prop,
    // re-appending the unit for number kinds. Untouched props are omitted so we
    // never promote a class-based value or a control default to inline.
    const decls = this.dirtyStyleDecls();

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

      // Merge inline style for every DIRTY prop in one pass. setInlineStyle
      // preserves any other existing declarations (lowercase-key, '; ' join),
      // so untouched inline props on the element survive.
      if (Object.keys(decls).length > 0) {
        setInlineStyle(el, decls);
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

    // Feature B push-point (b): commitBodyMutation records the post-edit state
    // as the new history tip (the pre-edit state is already on the stack).
    this.commitBodyMutation(doc, 'edit');
    this.selected = null;
  }

  /**
   * Inline text edit (S1): set the element at data-cdz-id `id` to have `text`
   * as its DIRECT text, then commit. Mirrors applyEdit's text branch — for an
   * element WITH element children we replace the first text node (or prepend
   * one) so child elements survive; otherwise we set textContent. Routes
   * through the shared walkBody id order, strips bookkeeping ids, and commits
   * an 'edit' snapshot. Does NOT touch `selected` — DOM order is unchanged.
   */
  private applyTextEdit(id: number, text: string) {
    let matched = false;
    const doc = this.walkBody(this.workingHtml, (el, walkId) => {
      if (walkId !== id) return;
      matched = true;
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
          firstText.textContent = text;
        } else if (text) {
          const owner = el.ownerDocument;
          el.insertBefore(owner.createTextNode(text), el.firstChild);
        }
      } else {
        el.textContent = text;
      }
    });
    if (!doc || !matched) return;
    doc.body
      .querySelectorAll('[data-cdz-id]')
      .forEach(el => el.removeAttribute('data-cdz-id'));
    this.commitBodyMutation(doc, 'edit');
  }

  /* ── edit-panel draft controls (generic per-prop) ─────────────────── */

  // Mark a style prop dirty (user touched its control this selection) — only
  // dirty props are written on Apply. Reassigns the Set for Lit reactivity.
  private markDirty(key: string) {
    if (this.editDirty.has(key)) return;
    this.editDirty = new Set(this.editDirty).add(key);
  }

  // Set a style-draft value for `key` and mark it dirty. Reassigns the record
  // so Lit's accessor change-detection fires.
  private setStyleDraft(key: string, value: string) {
    this.editStyles = { ...this.editStyles, [key]: value };
    this.markDirty(key);
  }

  // Pick a preset swatch → sets the color draft for `key` (drives both the
  // swatch-row highlight and the native color input, which read editStyles).
  private pickSwatch(key: string, hex: string) {
    this.setStyleDraft(key, normalizeColor(hex) || hex.toLowerCase());
  }

  // Number stepper: nudge the draft for `key` by `delta`, clamped to the prop's
  // [min, max]. An empty draft steps from a sensible default (16).
  private stepNumber(prop: CdzStyleProp, delta: number) {
    const lo = prop.min ?? 0;
    const hi = prop.max ?? Number.MAX_SAFE_INTEGER;
    const current = parseFloat(this.editStyles[prop.key] ?? '');
    const base = Number.isFinite(current) ? current : 16;
    const next = Math.max(lo, Math.min(hi, Math.round(base) + delta));
    this.setStyleDraft(prop.key, String(next));
  }

  // Manual entry into a number field for `prop`, clamped to [min, max] on the
  // way in. An empty field clears the draft (dirtyStyleDecls skips empties, so
  // clearing never emits an invalid bare-unit decl).
  private onNumberInput(prop: CdzStyleProp, raw: string) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      this.setStyleDraft(prop.key, '');
      return;
    }
    const value = parseFloat(trimmed);
    if (!Number.isFinite(value)) return;
    const lo = prop.min ?? 0;
    const hi = prop.max ?? Number.MAX_SAFE_INTEGER;
    this.setStyleDraft(prop.key, String(Math.max(lo, Math.min(hi, value))));
  }

  /**
   * Re-serialize a mutated document's <body> innerHTML back into workingHtml,
   * preserving everything outside <body> (doctype, <head>) from the ORIGINAL
   * source so we only touch the body region.
   */
  private commitBodyMutation(doc: Document, kind: CdzSnapshotKind = 'edit') {
    const newBodyInner = doc.body.innerHTML;
    const original = this.workingHtml ?? '';

    // Try to replace only the body's inner content in the original string so
    // head/doctype/attributes are untouched. Fall back to full-doc serialize.
    const replaced = replaceBodyInner(original, newBodyInner);
    this.workingHtml =
      replaced !== null ? replaced : serializeFullDoc(doc);

    // Feature B: record the committed result as the new history tip, tagged with
    // the mutation kind so the version panel can label it (visual edit vs move).
    this.pushHistory(this.workingHtml, makeMeta(kind));

    this.buildPreviewNow();
    this.scheduleHtmlChange();
  }

  /* ─────────────────── code editor input ─────────────────── */

  private onCodeInput(event: Event) {
    const target = event.target as HTMLTextAreaElement;
    this.workingHtml = target.value;
    this.scheduleRebuild();
    this.scheduleHtmlChange();
    this.scheduleCodeHistory();
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
    this.scheduleCodeHistory();
  }

  /* ─────────────────── AI dock ─────────────────── */

  private async sendAi() {
    const prompt = this.aiPrompt.trim();
    if (!prompt || this.aiBusy) return;

    // A fresh send supersedes any un-actioned pending diff.
    this.clearPending();

    // Prior turns become this request's history; the current prompt is sent
    // separately as `prompt`. Record the user turn AFTER capturing prior history.
    const priorHistory = this.boundHistory();
    this.turnLog = [...this.turnLog, { role: 'user', text: prompt }];
    this.chatLog = [...this.chatLog, { role: 'user', text: prompt }];
    this.aiPrompt = '';
    this.aiBusy = true;
    this.error = '';

    const selection = this.buildSelectionCtx();
    const request: CdzGenerateRequest = {
      prompt,
      ...(this.slug ? { slug: this.slug } : {}),
      currentHtml: (this.workingHtml ?? '').slice(0, CDZ_HTML_CAP),
      ...(priorHistory.length ? { history: priorHistory } : {}),
      ...(selection ? { selection } : {}),
    };

    try {
      const response = await fetch('/api/v1/apps/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const data = (await response
        .json()
        .catch(() => null)) as (CdzGenerateResponse & { error?: any }) | null;
      if (!response.ok) {
        throw new Error(
          data?.error?.message || `Generation failed (${response.status})`
        );
      }
      if (data && typeof data.slug === 'string' && data.slug) {
        this.slug = data.slug;
      }
      const summary =
        data && typeof data.summary === 'string' && data.summary.trim()
          ? data.summary.trim()
          : CDZ_DEFAULT_SUMMARY;
      if (data && typeof data.html === 'string' && data.html !== this.workingHtml) {
        // Stage as a pending edit for Accept/Revert review (diff gate).
        this.pendingHtml = data.html;
        this.pendingSummary = summary;
        this.chatLog = [
          ...this.chatLog,
          { role: 'system', text: `Review: ${summary}` },
        ];
      } else {
        this.chatLog = [
          ...this.chatLog,
          { role: 'system', text: 'No changes' },
        ];
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Generation failed';
      this.chatLog = [...this.chatLog, { role: 'system', text: message }];
      this.error = message;
    } finally {
      this.aiBusy = false;
    }
  }

  // Bounded prior-turn history for the request: last N turns, each clamped, with
  // a running total cap — mirrors the backend CdzGenerateRequest bounds.
  private boundHistory(): CdzTurn[] {
    const turns = this.turnLog
      .slice(-CDZ_HISTORY_MAX_TURNS)
      .map(t => ({ role: t.role, text: t.text.slice(0, CDZ_TURN_TEXT_CAP) }));
    let total = turns.reduce((n, t) => n + t.text.length, 0);
    while (turns.length && total > CDZ_HISTORY_TOTAL_CAP) {
      total -= turns[0].text.length;
      turns.shift();
    }
    return turns;
  }

  // Selection context for the request from the current pick (null when none).
  private buildSelectionCtx(): CdzSelectionCtx | null {
    const sel = this.selected;
    if (!sel) return null;
    let descriptor = '';
    try {
      descriptor = buildSelectionDescriptor(
        { id: sel.id, tag: sel.tag, text: sel.text },
        this.workingHtml
      );
    } catch {
      descriptor = '';
    }
    return {
      tag: sel.tag,
      text: (sel.text ?? '').slice(0, CDZ_SELECTION_TEXT_CAP),
      ...(descriptor
        ? { descriptor: descriptor.slice(0, CDZ_SELECTION_DESCRIPTOR_CAP) }
        : {}),
    };
  }

  // Clear the element scope so the next request targets the whole page.
  private clearSelectionScope() {
    this.selected = null;
  }

  /* ── AI-edit pending diff gate (Studio v3) ── */

  private acceptPending() {
    const html = this.pendingHtml;
    if (html === null) return;
    const summary = this.pendingSummary || CDZ_DEFAULT_SUMMARY;
    this.workingHtml = html;
    // One new history tip for the accepted AI edit (pre-edit state stays below).
    this.pushHistory(this.workingHtml, makeMeta('ai', summary));
    // Record the assistant turn only now that the edit is real (multi-turn ctx).
    this.turnLog = [...this.turnLog, { role: 'assistant', text: summary }];
    this.chatLog = [...this.chatLog, { role: 'system', text: `${summary} ✓` }];
    this.pendingHtml = null;
    this.pendingSummary = '';
    this.buildPreviewNow();
    this.scheduleHtmlChange();
  }

  private revertPending() {
    if (this.pendingHtml === null) return;
    this.pendingHtml = null;
    this.pendingSummary = '';
    this.chatLog = [...this.chatLog, { role: 'system', text: 'Reverted' }];
  }

  // Silent clear (superseded by a new send, Esc, or session close).
  private clearPending() {
    this.pendingHtml = null;
    this.pendingSummary = '';
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
      this.chatLog = [
        ...this.chatLog,
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

  /**
   * True when the event's composed path passes through a TEXTAREA/INPUT — i.e.
   * focus is in a text field. Shared by the Escape, undo/redo and nudge
   * handlers so none of them trap or clobber native text editing.
   */
  private eventInField(event: KeyboardEvent): boolean {
    return event.composedPath().some(node => {
      const el = node as HTMLElement;
      const tag = el?.tagName;
      return tag === 'TEXTAREA' || tag === 'INPUT';
    });
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (!this.open) return;

    const inField = this.eventInField(event);

    // Escape-to-close: ignore when focus is in a text field so typing isn't
    // trapped (unchanged v1 semantics).
    if (event.key === 'Escape') {
      if (inField) return;
      event.preventDefault();
      // Esc peels back UI layers before closing: pending AI diff first, then the
      // versions panel, then the overlay itself.
      if (this.pendingHtml !== null) {
        this.revertPending();
        return;
      }
      if (this.showVersions) {
        this.showVersions = false;
        return;
      }
      if (this.showProblems) {
        this.showProblems = false;
        return;
      }
      this.close();
      return;
    }

    // Undo / redo (Feature B). BAIL when focus is inside any input/textarea so
    // the browser's native text-undo keeps working in the code editor / fields.
    const meta = event.metaKey || event.ctrlKey;
    if (meta && !inField) {
      const key = event.key.toLowerCase();
      // Ctrl/Cmd+Shift+Z or Ctrl+Y → redo; Ctrl/Cmd+Z → undo.
      if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        this.redo();
        return;
      }
      if (key === 'z') {
        event.preventDefault();
        this.undo();
        return;
      }
    }

    // Alt+Arrow nudge (Feature A): reorder the selected element among its
    // siblings. Only when inspect is on, something is selected, and focus is
    // not in a text field (so Alt+Arrow inside the edit-panel text box is left
    // to the browser).
    if (
      event.altKey &&
      !inField &&
      this.inspect &&
      this.selected &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      event.preventDefault();
      this.nudgeSelected(event.key === 'ArrowUp' ? -1 : 1);
    }
  }

  private setView(view: 'split' | 'code' | 'preview') {
    this.view = view;
  }

  /* ─────────────────── render helpers ─────────────────── */

  /* ─────────────────── editable app title (v3) ─────────────────── */

  // Enter commits (via blur→change); Escape reverts the draft to the canonical
  // title. Both stop propagation so the overlay's global shortcuts (Esc closes
  // the studio) don't fire while renaming.
  private onTitleKeyDown(event: KeyboardEvent) {
    const input = event.target as HTMLInputElement;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      input.value = this.title;
      input.blur();
    }
  }

  // Commit a renamed title: ignore empty/unchanged, else update the local
  // property and notify the host card so it can override + persist (mirrors the
  // studio-html-change round-trip).
  private commitTitle(raw: string) {
    const next = raw.trim();
    if (!next || next === this.title) return;
    this.title = next;
    this.dispatchEvent(
      new CustomEvent('studio-title-change', {
        detail: { title: next },
        bubbles: true,
        composed: true,
      })
    );
  }

  private renderTopBar() {
    const openUrl = this.publishedUrl;
    return html`<div class="cdz-topbar">
      <div class="cdz-brand">
        <span class="cdz-dot"></span>
        <input
          class="cdz-title-input"
          .value=${this.title}
          title="Rename app"
          aria-label="App title"
          @keydown=${(e: KeyboardEvent) => this.onTitleKeyDown(e)}
          @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            this.commitTitle(input.value);
            // Normalize the field back to the canonical title (trims blanks,
            // reverts an empty/unchanged edit).
            input.value = this.title;
          }}
        />
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
        <div class="cdz-group">
          <button
            class="cdz-btn ghost icon"
            title="Undo (Ctrl/Cmd+Z)"
            aria-label="Undo"
            ?disabled=${!this.canUndo}
            @click=${() => this.undo()}
          >
            ${CDZ_ICONS.undo}
          </button>
          <button
            class="cdz-btn ghost icon"
            title="Redo (Ctrl/Cmd+Shift+Z)"
            aria-label="Redo"
            ?disabled=${!this.canRedo}
            @click=${() => this.redo()}
          >
            ${CDZ_ICONS.redo}
          </button>
          <button
            class=${classMap({
              'cdz-btn': true,
              ghost: true,
              icon: true,
              toggled: this.showVersions,
            })}
            title="Version history"
            aria-label="Version history"
            aria-pressed=${this.showVersions}
            @click=${() => this.toggleVersions()}
          >
            ${CDZ_ICONS.history}
          </button>
          <button
            class=${classMap({
              'cdz-btn': true,
              ghost: true,
              icon: true,
              toggled: this.showProblems,
            })}
            title="Problems — runtime console & errors"
            aria-label="Problems"
            aria-pressed=${this.showProblems}
            @click=${() => this.toggleProblems()}
          >
            ${CDZ_ICONS.alert}
            ${this.problemErrorCount > 0
              ? html`<span class="cdz-badge"
                  >${this.problemErrorCount > 99
                    ? '99+'
                    : this.problemErrorCount}</span
                >`
              : nothing}
          </button>
        </div>

        <div class="cdz-group">
          <button
            class=${classMap({
              'cdz-btn': true,
              secondary: !this.inspect,
              toggled: this.inspect,
            })}
            title="Click elements in the preview to edit them"
            aria-label="Inspect"
            aria-pressed=${this.inspect}
            @click=${() => this.toggleInspect()}
          >
            ${CDZ_ICONS.inspect} Inspect
          </button>
          <button
            class=${classMap({
              'cdz-btn': true,
              secondary: !this.freeMove,
              toggled: this.freeMove,
            })}
            title="Free move — drag elements to reposition them freely"
            aria-label="Free move"
            aria-pressed=${this.freeMove}
            @click=${() => this.toggleFreeMove()}
          >
            ${CDZ_ICONS.move} Move
          </button>
        </div>

        <div class="cdz-group">
          ${openUrl
            ? html`<a
                class="cdz-btn secondary"
                href=${openUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open published app"
                aria-label="Open published app"
                >${CDZ_ICONS.openExternal} Open</a
              >`
            : nothing}
          <button
            class="cdz-btn primary"
            ?disabled=${this.publishing}
            title=${openUrl ? 'Republish app' : 'Publish app'}
            @click=${() => this.publish()}
          >
            ${this.publishing
              ? html`<span class="cdz-spinner"></span>Publishing…`
              : html`${CDZ_ICONS.publish}${openUrl ? 'Republish' : 'Publish'}`}
          </button>
          <button
            class="cdz-btn ghost icon"
            title="Close"
            aria-label="Close"
            @click=${() => this.close()}
          >
            ${CDZ_ICONS.close}
          </button>
        </div>
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
        <div class="cdz-el-toolbar" role="toolbar" aria-label="Element actions">
          <button
            class="cdz-btn ghost icon"
            title="Duplicate element"
            aria-label="Duplicate element"
            @click=${() => this.duplicateSelected()}
          >
            ${CDZ_ICONS.duplicate}
          </button>
          <button
            class="cdz-btn ghost icon"
            title="Move up (Alt+↑)"
            aria-label="Move element up"
            @click=${() => this.nudgeSelected(-1)}
          >
            ${CDZ_ICONS.arrowUp}
          </button>
          <button
            class="cdz-btn ghost icon"
            title="Move down (Alt+↓)"
            aria-label="Move element down"
            @click=${() => this.nudgeSelected(1)}
          >
            ${CDZ_ICONS.arrowDown}
          </button>
          <button
            class="cdz-btn ghost icon danger"
            title="Delete element"
            aria-label="Delete element"
            @click=${() => this.deleteSelected()}
          >
            ${CDZ_ICONS.trash}
          </button>
        </div>
        <button
          class="cdz-btn ghost icon"
          title="Dismiss"
          aria-label="Dismiss"
          @click=${() => (this.selected = null)}
        >
          ${CDZ_ICONS.close}
        </button>
      </div>

      <div class="cdz-field">
        <label>Text</label>
        <textarea
          .value=${this.editText}
          @input=${(e: Event) =>
            (this.editText = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
      </div>

      ${CDZ_EDIT_STYLE_PROPS.map(prop => this.renderStyleField(prop))}

      <div class="cdz-edit-foot">
        <button
          class="cdz-btn ghost"
          @click=${() => (this.selected = null)}
        >
          Cancel
        </button>
        <button class="cdz-btn primary" @click=${() => this.applyEdit()}>
          Apply
        </button>
      </div>

      <div class="cdz-edit-hint">
        Alt+↑/↓ move · drag to ${this.freeMove ? 'reposition' : 'reorder'} ·
        dbl-click text to edit
      </div>
    </div>`;
  }

  // Render one edit-panel control for a CdzStyleProp, switching on its kind.
  // Reads/writes this.editStyles[prop.key]; every handler marks the key dirty.
  private renderStyleField(prop: CdzStyleProp) {
    const draft = this.editStyles[prop.key] ?? '';
    if (prop.kind === 'color') {
      const active = normalizeColor(draft) || draft.toLowerCase();
      return html`<div class="cdz-field">
        <label>${prop.label}</label>
        <div class="cdz-swatches">
          ${CDZ_SWATCHES.map(hex => {
            const isActive = active === hex.toLowerCase();
            return html`<button
              class=${classMap({ 'cdz-swatch': true, active: isActive })}
              style=${`background:${hex}`}
              title=${hex}
              aria-label=${`Set ${prop.label} ${hex}`}
              @click=${() => this.pickSwatch(prop.key, hex)}
            ></button>`;
          })}
          <input
            class="cdz-color"
            type="color"
            aria-label=${`Custom ${prop.label}`}
            .value=${active || '#000000'}
            @input=${(e: Event) =>
              this.pickSwatch(prop.key, (e.target as HTMLInputElement).value)}
          />
        </div>
      </div>`;
    }
    if (prop.kind === 'select') {
      return html`<div class="cdz-field">
        <label>${prop.label}</label>
        <select
          class="cdz-select"
          .value=${draft}
          @change=${(e: Event) =>
            this.setStyleDraft(prop.key, (e.target as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${draft === ''}>—</option>
          ${(prop.options ?? []).map(
            opt => html`<option
              value=${opt.value}
              ?selected=${draft === opt.value}
            >
              ${opt.label}
            </option>`
          )}
        </select>
      </div>`;
    }
    if (prop.kind === 'number') {
      const unit = prop.unit ?? 'px';
      return html`<div class="cdz-field">
        <label>${prop.label}${unit ? html` (${unit})` : nothing}</label>
        <div class="cdz-stepper">
          <button
            class="cdz-step"
            title=${`Decrease ${prop.label}`}
            aria-label=${`Decrease ${prop.label}`}
            @click=${() => this.stepNumber(prop, -1)}
          >
            −
          </button>
          <input
            type="number"
            min=${prop.min ?? nothing}
            max=${prop.max ?? nothing}
            placeholder="—"
            .value=${draft}
            @input=${(e: Event) =>
              this.onNumberInput(prop, (e.target as HTMLInputElement).value)}
          />
          <button
            class="cdz-step"
            title=${`Increase ${prop.label}`}
            aria-label=${`Increase ${prop.label}`}
            @click=${() => this.stepNumber(prop, 1)}
          >
            +
          </button>
        </div>
      </div>`;
    }
    // kind === 'text'
    return html`<div class="cdz-field">
      <label>${prop.label}</label>
      <input
        class="cdz-text-input"
        type="text"
        .value=${draft}
        @input=${(e: Event) =>
          this.setStyleDraft(prop.key, (e.target as HTMLInputElement).value)}
      />
    </div>`;
  }

  private renderDock() {
    const sel = this.selected;
    return html`<aside class="cdz-dock">
      <div class="cdz-dock-head">
        <div class="cdz-dock-title">${CDZ_ICONS.sparkle} AI edits</div>
        <div class="cdz-dock-sub">
          ${sel
            ? html`Editing the selected element — the current code is the context.`
            : html`Describe a change — the current code is the context.`}
        </div>
        ${sel
          ? html`<div class="cdz-scope">
              <span class="cdz-scope-chip"
                >Editing &lt;${sel.tag || 'node'}&gt;</span
              >
              <button
                class="cdz-scope-clear"
                title="Apply changes to the whole page instead"
                @click=${() => this.clearSelectionScope()}
              >
                Edit whole page
              </button>
            </div>`
          : nothing}
      </div>

      <div class="cdz-dock-log">
        ${this.chatLog.length === 0
          ? html`<div class="cdz-dock-empty">
              Describe a change and the assistant will edit the app using the
              current code as context.
            </div>`
          : this.chatLog.map(item => {
              const t = item.text;
              const isErr =
                item.role === 'system' &&
                !t.endsWith('✓') &&
                !t.startsWith('Review:') &&
                t !== 'No changes' &&
                t !== 'Reverted' &&
                !t.startsWith('Published');
              return html`<div
                class=${classMap({
                  'cdz-msg': true,
                  user: item.role === 'user',
                  system: item.role === 'system',
                  err: isErr,
                })}
              >
                ${t}
              </div>`;
            })}
        ${this.aiBusy
          ? html`<div class="cdz-typing" aria-label="Assistant is working">
              <span></span><span></span><span></span>
            </div>`
          : nothing}
      </div>

      <div class="cdz-dock-input">
        <textarea
          class="cdz-ai-prompt"
          placeholder=${sel
            ? `Change the selected <${sel.tag || 'element'}>…`
            : 'e.g. Make the hero headline bigger and change the CTA to teal'}
          .value=${this.aiPrompt}
          ?disabled=${this.aiBusy}
          @input=${(e: Event) =>
            (this.aiPrompt = (e.target as HTMLTextAreaElement).value)}
          @keydown=${(e: KeyboardEvent) => this.onAiKeyDown(e)}
        ></textarea>
        <div class="cdz-dock-send">
          <span class="cdz-hint">Enter to send · Shift+Enter for newline</span>
          <button
            class="cdz-btn primary icon"
            title="Send"
            aria-label="Send"
            ?disabled=${this.aiBusy || this.aiPrompt.trim().length === 0}
            @click=${() => this.sendAi()}
          >
            ${this.aiBusy
              ? html`<span class="cdz-spinner"></span>`
              : CDZ_ICONS.send}
          </button>
        </div>
      </div>

      ${this.renderAiDiff()}
    </aside>`;
  }

  // AI-edit review overlay (diff + Accept/Revert), shown over the dock when a
  // pending edit is staged (Studio v3).
  private renderAiDiff() {
    if (this.pendingHtml === null) return nothing;
    const rows = diffLines(this.workingHtml ?? '', this.pendingHtml);
    return html`<div class="cdz-ai-diff" role="dialog" aria-label="Review AI edit">
      <div class="cdz-ai-diff-head">
        ${CDZ_ICONS.sparkle}
        <span class="cdz-ai-diff-title"
          >${this.pendingSummary || CDZ_DEFAULT_SUMMARY}</span
        >
      </div>
      <cdz-diff-view class="cdz-ai-diff-body" .rows=${rows}></cdz-diff-view>
      <div class="cdz-ai-diff-foot">
        <span class="cdz-hint">Review the change, then keep or discard it.</span>
        <div class="cdz-ai-diff-actions">
          <button class="cdz-btn ghost" @click=${() => this.revertPending()}>
            Revert
          </button>
          <button class="cdz-btn primary" @click=${() => this.acceptPending()}>
            Accept
          </button>
        </div>
      </div>
    </div>`;
  }

  // Floating version-history panel (Studio v3): lists labeled snapshots and
  // restores on click, delegating the row markup to the shared helper.
  private renderVersionsPanel() {
    return html`<div
      class="cdz-versions"
      role="dialog"
      aria-label="Version history"
    >
      <div class="cdz-versions-head">
        <span>${CDZ_ICONS.history} Versions</span>
        <button
          class="cdz-btn ghost icon"
          title="Close"
          aria-label="Close version history"
          @click=${() => (this.showVersions = false)}
        >
          ${CDZ_ICONS.close}
        </button>
      </div>
      <div class="cdz-versions-body">
        ${renderVersionList(this.historyMeta, this.historyIndex, (i: number) =>
          this.restoreTo(i)
        )}
      </div>
    </div>`;
  }

  // Compose a fix prompt from the current problems and run it through the AI
  // dock — reuses sendAi, so the fix returns as a reviewable diff.
  private fixWithAi() {
    if (this.aiBusy) return;
    const fixable = this.problems.filter(
      p => p.level === 'error' || p.level === 'warn'
    );
    if (!fixable.length) return;
    const lines = fixable.slice(0, 10).map(p => {
      const loc = p.source
        ? ` (${p.source}${p.line ? ':' + p.line : ''})`
        : '';
      return `- [${p.level}]${loc} ${p.text.slice(0, 200)}`;
    });
    this.aiPrompt =
      'Fix these runtime errors and warnings in the app, keeping everything ' +
      'else intact:\n' +
      lines.join('\n');
    this.showProblems = false;
    void this.sendAi();
  }

  private renderProblemsPanel() {
    return html`<div
      class="cdz-versions cdz-problems"
      role="dialog"
      aria-label="Problems"
    >
      <div class="cdz-versions-head">
        <span>${CDZ_ICONS.alert} Problems</span>
        <button
          class="cdz-btn ghost icon"
          title="Close"
          aria-label="Close problems"
          @click=${() => (this.showProblems = false)}
        >
          ${CDZ_ICONS.close}
        </button>
      </div>
      <div class="cdz-versions-body">
        ${renderProblems(this.problems, {
          onFix: () => this.fixWithAi(),
          onClear: () => (this.problems = []),
        })}
      </div>
    </div>`;
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
        ${this.showVersions ? this.renderVersionsPanel() : nothing}
        ${this.showProblems ? this.renderProblemsPanel() : nothing}
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

/* ── inline SVG icon set (Feature C) ────────────────────────────────
 * 16px, stroke: currentColor, no fill, rounded caps/joins. Each is a complete
 * <svg> root so Lit's `html` tag namespaces them correctly. Purely decorative
 * → aria-hidden; the enclosing button carries the accessible label/title.
 */
const CDZ_ICONS = {
  // close — X
  close: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>`,
  // open-external — arrow-up-right in a box
  openExternal: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
    <polyline points="15 3 21 3 21 9"></polyline>
    <line x1="10" y1="14" x2="21" y2="3"></line>
  </svg>`,
  // inspect — crosshair / target
  inspect: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="8"></circle>
    <line x1="12" y1="2" x2="12" y2="6"></line>
    <line x1="12" y1="18" x2="12" y2="22"></line>
    <line x1="2" y1="12" x2="6" y2="12"></line>
    <line x1="18" y1="12" x2="22" y2="12"></line>
  </svg>`,
  // move — four-directional arrows (free-move, Studio v3)
  move: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <polyline points="5 9 2 12 5 15"></polyline>
    <polyline points="9 5 12 2 15 5"></polyline>
    <polyline points="15 19 12 22 9 19"></polyline>
    <polyline points="19 9 22 12 19 15"></polyline>
    <line x1="2" y1="12" x2="22" y2="12"></line>
    <line x1="12" y1="2" x2="12" y2="22"></line>
  </svg>`,
  // publish — upload cloud
  publish: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M16 16l-4-4-4 4"></path>
    <path d="M12 12v9"></path>
    <path
      d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"
    ></path>
    <path d="M16 16l-4-4-4 4"></path>
  </svg>`,
  // undo — arrow-counterclockwise
  undo: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M3 7v6h6"></path>
    <path d="M3 13a9 9 0 1 0 3-7.7L3 8"></path>
  </svg>`,
  // redo — arrow-clockwise
  redo: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M21 7v6h-6"></path>
    <path d="M21 13a9 9 0 1 1-3-7.7L21 8"></path>
  </svg>`,
  // history — clock (version history, Studio v3)
  history: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9"></circle>
    <polyline points="12 7 12 12 16 14"></polyline>
  </svg>`,
  // send — paper plane
  send: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <line x1="22" y1="2" x2="11" y2="13"></line>
    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
  </svg>`,
  // sparkle — AI dock header accent
  sparkle: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path
      d="M12 3l1.9 4.8L18.7 9.7l-4.8 1.9L12 16.4l-1.9-4.8L5.3 9.7l4.8-1.9L12 3z"
    ></path>
  </svg>`,
  // alert — warning triangle (Problems panel, Debugging bundle)
  alert: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
    <line x1="12" y1="9" x2="12" y2="13"></line>
    <line x1="12" y1="17" x2="12.01" y2="17"></line>
  </svg>`,
  // duplicate — two overlapping squares (copy)
  duplicate: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="12" height="12" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>`,
  // trash — delete bin
  trash: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
    <line x1="10" y1="11" x2="10" y2="17"></line>
    <line x1="14" y1="11" x2="14" y2="17"></line>
  </svg>`,
  // arrow-up — move earlier among siblings
  arrowUp: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <line x1="12" y1="19" x2="12" y2="5"></line>
    <polyline points="5 12 12 5 19 12"></polyline>
  </svg>`,
  // arrow-down — move later among siblings
  arrowDown: html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <polyline points="19 12 12 19 5 12"></polyline>
  </svg>`,
} as const;

// Injected into the preview <head>. Draws hover/selected outlines plus the
// drag-reorder affordances (dragging state, drop indicator line, drag handle
// chip). Kept as a plain string (no backticks) to avoid nesting template
// literals. All rules are !important so they win over app styles.
const CDZ_INSPECT_STYLE = [
  '[data-cdz-id].cdz-hover{outline:2px dashed #10a37f !important;',
  'outline-offset:1px !important;cursor:pointer !important;}',
  '[data-cdz-id].cdz-sel{outline:2px solid #10a37f !important;',
  'outline-offset:1px !important;}',
  // dragged element: dimmed + green outline, grabbing cursor.
  '[data-cdz-id].cdz-dragging{opacity:0.45 !important;',
  'outline:2px solid #10a37f !important;outline-offset:1px !important;',
  'cursor:grabbing !important;}',
  // free-move drag (v3): outlined + grabbing, but NOT dimmed — you want to see
  // the element while repositioning it.
  '[data-cdz-id].cdz-moving{outline:2px solid #10a37f !important;',
  'outline-offset:1px !important;cursor:grabbing !important;}',
  // While the overlay is active, let pointer drags on tagged elements win over
  // native touch scrolling so touch/pen drag works (Phase 0 pointer events).
  'html.cdz-active [data-cdz-id]{touch-action:none !important;}',
  // drop indicator line (positioned absolutely; reused element).
  '#cdz-drop-indicator{position:absolute !important;z-index:2147483646 !important;',
  'background:#10a37f !important;border-radius:2px !important;',
  'pointer-events:none !important;display:none !important;',
  'box-shadow:0 0 6px rgba(16,163,127,0.8) !important;}',
  // append-into drop zone: outline box variant (empty-container target).
  '#cdz-drop-indicator.cdz-drop-box{background:rgba(16,163,127,0.10) !important;',
  'border:2px dashed #10a37f !important;border-radius:6px !important;',
  'box-shadow:none !important;}',
  // drag handle chip (⠿) shown at the hovered element's top-left corner.
  '#cdz-drag-handle{position:absolute !important;z-index:2147483647 !important;',
  'display:none !important;align-items:center !important;',
  'justify-content:center !important;width:18px !important;height:18px !important;',
  'border-radius:5px !important;background:#10a37f !important;color:#04241b !important;',
  'font:600 12px/1 ui-monospace,monospace !important;',
  'pointer-events:none !important;box-shadow:0 2px 6px rgba(0,0,0,0.4) !important;}',
].join('');

/**
 * Build the bridge script string injected into the preview <body>.
 * It listens for {type:'cdz-mode', on, free} from the parent, manages hover +
 * selection classes, posts {type:'cdz-pick', id, tag, text} on click, and
 * implements pointer-based (mouse/touch/pen) drag: in reorder mode a
 * whiteboard-style same-parent reorder posting {type:'cdz-move', id, beforeId},
 * and in free-move mode a live inline-transform reposition posting
 * {type:'cdz-free', id, dx, dy} on drop.
 *
 * NOTE: this runs inside the sandboxed iframe (no allow-same-origin). It only
 * uses postMessage to talk to window.parent. The "direct text" logic here MUST
 * mirror ClickDzBuilderStudio.directText so the parent shows what was clicked.
 *
 * Written with string concatenation (no nested template literals / backticks)
 * so it composes cleanly inside this module's own tagged templates.
 */
function buildBridgeScript(initialOn: boolean, initialFree: boolean): string {
  return (
    '(function(){' +
    'var on=' +
    (initialOn ? 'true' : 'false') +
    ';' +
    'var free=' +
    (initialFree ? 'true' : 'false') +
    ';' +
    'var hovered=null;' +
    'document.documentElement.classList.toggle("cdz-active",on);' +
    // ── drag state ──────────────────────────────────────────────
    'var DRAG_THRESHOLD=6;' + // px pointer travel before a drag begins
    'var pressEl=null;' + // element under an active pointerdown (candidate)
    'var pressId=null;' + // pointerId of the active gesture (for capture)
    'var pressX=0,pressY=0;' + // pointerdown origin
    'var dragging=null;' + // the element currently being dragged (or null)
    'var dropBefore=null;' + // sibling to insert before (null = append)
    'var dropParent=null;' + // target container the node will land in
    'var dropInto=false;' + // true = append INTO dropParent (vs before dropBefore)
    'var suppressClick=false;' + // swallow the click that ends a drag gesture
    'var indicator=null;' + // reused drop-indicator line element
    'var handle=null;' + // reused drag-handle chip element
    'var baseTf="";var baseTx=0;var baseTy=0;' + // free-move base transform
    'var editingEl=null;' + // element in inline contenteditable edit (or null)
    // Resolve nearest ancestor-or-self carrying a data-cdz-id.
    'function pickEl(t){' +
    'if(!t)return null;' +
    'if(t.closest){return t.closest("[data-cdz-id]");}' +
    'while(t&&t.getAttribute&&t.getAttribute("data-cdz-id")===null){t=t.parentElement;}' +
    'return (t&&t.getAttribute&&t.getAttribute("data-cdz-id")!==null)?t:null;}' +
    'function idOf(el){return el?parseInt(el.getAttribute("data-cdz-id"),10):null;}' +
    'function clearHover(){if(hovered){hovered.classList.remove("cdz-hover");hovered=null;}}' +
    'function directText(el){' +
    'if(!el.firstElementChild){return (el.textContent||"").trim();}' +
    'var out="";var n=el.childNodes;' +
    'for(var i=0;i<n.length;i++){if(n[i].nodeType===3){out+=n[i].textContent||"";}}' +
    'return out.trim();}' +
    // Lazily create + return the reused drop-indicator element.
    'function getIndicator(){' +
    'if(!indicator){indicator=document.createElement("div");' +
    'indicator.id="cdz-drop-indicator";document.body.appendChild(indicator);}' +
    'return indicator;}' +
    'function hideIndicator(){if(indicator){indicator.style.display="none";}}' +
    // Lazily create + return the reused drag-handle chip element.
    'function getHandle(){' +
    'if(!handle){handle=document.createElement("div");' +
    'handle.id="cdz-drag-handle";handle.textContent="\\u283F";' + // ⠿
    'document.body.appendChild(handle);}' +
    'return handle;}' +
    'function hideHandle(){if(handle){handle.style.display="none";}}' +
    // Position the handle chip at the hovered element's top-left corner.
    'function showHandle(el){' +
    'var h=getHandle();var r=el.getBoundingClientRect();' +
    'h.style.left=(r.left+window.scrollX)+"px";' +
    'h.style.top=(r.top+window.scrollY)+"px";' +
    'h.style.display="flex";}' +
    // Element siblings (same parent, carrying data-cdz-id), excluding `except`.
    'function siblingsOf(el,except){' +
    'var out=[];var p=el.parentElement;if(!p)return out;' +
    'var kids=p.children;' +
    'for(var i=0;i<kids.length;i++){var k=kids[i];' +
    'if(k===except)continue;' +
    'if(k.getAttribute&&k.getAttribute("data-cdz-id")!==null){out.push(k);}}' +
    'return out;}' +
    // Tagged element children of `p` (carrying data-cdz-id), excluding `except`.
    // Same shape as siblingsOf but for an ARBITRARY container p.
    'function childrenOf(p,except){' +
    'var out=[];if(!p)return out;var kids=p.children;' +
    'for(var i=0;i<kids.length;i++){var k=kids[i];' +
    'if(k===except)continue;' +
    'if(k.getAttribute&&k.getAttribute("data-cdz-id")!==null){out.push(k);}}' +
    'return out;}' +
    // True if `node` is `anc` or a descendant of it — used to refuse dropping a
    // node into its own subtree (mirror of the parent-side canReparent guard,
    // so the live indicator never advertises an illegal drop).
    'function isInside(node,anc){' +
    'var n=node;while(n){if(n===anc)return true;n=n.parentElement;}return false;}' +
    // Resolve the tagged container under the pointer for a reparent drop: the
    // nearest tagged ancestor-or-self of the hit element that is NOT the
    // dragged node and does NOT sit inside it (cycle). elementFromPoint is used
    // (not e.target) because the dragged node has pointer-capture; hide the
    // indicator first so it is never itself the hit target.
    'function containerUnder(px,py){' +
    'hideIndicator();' +
    'var hit=document.elementFromPoint(px,py);' +
    'var c=pickEl(hit);' +
    'while(c){if(c!==dragging&&!isInside(c,dragging))return c;c=c.parentElement?pickEl(c.parentElement):null;}' +
    'return null;}' +
    // Decide the parent's dominant axis from consecutive sibling rect centers.
    // Returns true for a COLUMN (vertical) layout, false for a ROW.
    'function isColumn(list){' +
    'if(list.length<2)return true;' +
    'var dx=0,dy=0,c=0;var prev=null;' +
    'for(var i=0;i<list.length;i++){var r=list[i].getBoundingClientRect();' +
    'var cx=r.left+r.width/2,cy=r.top+r.height/2;' +
    'if(prev){dx+=Math.abs(cx-prev.x);dy+=Math.abs(cy-prev.y);c++;}' +
    'prev={x:cx,y:cy};}' +
    'if(!c)return true;return (dy/c)>=(dx/c);}' +
    // Given the drag pointer and a target `container`, compute the insertion
    // gap among its tagged children (excluding the dragged node). Sets
    // dropBefore, dropParent, dropInto and positions the indicator. When the
    // container has no eligible child the drop becomes an APPEND-INTO and the
    // indicator becomes a full-container outline box.
    'function computeDrop(px,py,container){' +
    'dropParent=container;' +
    'var list=childrenOf(container,dragging);' +
    'var col=isColumn(list);var before=null;' +
    'for(var i=0;i<list.length;i++){var r=list[i].getBoundingClientRect();' +
    'var mid=col?(r.top+r.height/2):(r.left+r.width/2);' +
    'var p=col?py:px;' +
    'if(p<mid){before=list[i];break;}}' +
    'dropBefore=before;' +
    'dropInto=(list.length===0);' +
    'var ind=getIndicator();' +
    'var pr=container.getBoundingClientRect();' +
    'if(dropInto){' + // empty container → outline the whole box as the zone
    'ind.className="cdz-drop-box";' +
    'ind.style.left=(pr.left+window.scrollX)+"px";' +
    'ind.style.top=(pr.top+window.scrollY)+"px";' +
    'ind.style.width=pr.width+"px";' +
    'ind.style.height=pr.height+"px";' +
    'ind.style.display="block";return;}' +
    'ind.className="";' +
    'if(col){' + // horizontal line spanning the container's width at the gap
    'var y;' +
    'if(before){var rb=before.getBoundingClientRect();y=rb.top;}' +
    'else if(list.length){var rl=list[list.length-1].getBoundingClientRect();y=rl.bottom;}' +
    'else{y=pr.top;}' +
    'ind.style.left=(pr.left+window.scrollX)+"px";' +
    'ind.style.width=pr.width+"px";' +
    'ind.style.top=(y+window.scrollY-1)+"px";' +
    'ind.style.height="2px";' +
    '}else{' + // vertical line spanning the container's height at the gap
    'var x;' +
    'if(before){var rb2=before.getBoundingClientRect();x=rb2.left;}' +
    'else if(list.length){var rl2=list[list.length-1].getBoundingClientRect();x=rl2.right;}' +
    'else{x=pr.left;}' +
    'ind.style.top=(pr.top+window.scrollY)+"px";' +
    'ind.style.height=pr.height+"px";' +
    'ind.style.left=(x+window.scrollX-1)+"px";' +
    'ind.style.width="2px";}' +
    'ind.style.display="block";}' +
    // Tear down an in-progress drag (both on drop and on cancel).
    'function endDrag(){' +
    'if(dragging){dragging.classList.remove("cdz-dragging");' +
    'dragging.classList.remove("cdz-moving");}' +
    'dragging=null;dropBefore=null;dropParent=null;dropInto=false;' +
    'pressEl=null;pressId=null;hideIndicator();}' +
    // free-move transform helpers (mirror the parent-side withTranslate/read
    // so the live preview and the committed source agree).
    'function readTx(tf){var m=/translate\\(\\s*(-?[0-9.]+)px\\s*,\\s*(-?[0-9.]+)px\\s*\\)/i.exec(tf||"");' +
    'return m?{x:parseFloat(m[1]),y:parseFloat(m[2])}:{x:0,y:0};}' +
    'function writeTx(tf,nx,ny){tf=(tf&&tf.toLowerCase()!=="none")?tf:"";' +
    'var t="translate("+nx+"px, "+ny+"px)";' +
    'var re=/translate\\(\\s*-?[0-9.]+px\\s*,\\s*-?[0-9.]+px\\s*\\)/i;' +
    'if(re.test(tf)){return tf.replace(re,t);}return tf?(t+" "+tf):t;}' +
    // Live-translate the dragged element during a free-move drag.
    'function moveFree(px,py){var ddx=px-pressX,ddy=py-pressY;' +
    'dragging.style.transform=writeTx(baseTf,baseTx+ddx,baseTy+ddy);}' +
    // Promote the held candidate to an active drag (reorder OR free).
    'function startDrag(px,py){dragging=pressEl;suppressClick=true;' +
    'clearHover();hideHandle();' +
    'try{document.documentElement.setPointerCapture(pressId);}catch(_e){}' +
    'if(free){dragging.classList.add("cdz-moving");' +
    'baseTf=dragging.style.transform||"";var b=readTx(baseTf);baseTx=b.x;baseTy=b.y;' +
    'moveFree(px,py);}' +
    'else{dragging.classList.add("cdz-dragging");' +
    'computeDrop(px,py,containerUnder(px,py)||dragging.parentElement);}}' +
    // pointerdown: record a drag candidate (do NOT start dragging yet).
    'document.addEventListener("pointerdown",function(e){' +
    'if(!on||!e.isPrimary)return;' +
    'if(e.pointerType==="mouse"&&e.button!==0)return;' +
    'if(editingEl&&editingEl.contains(e.target))return;' +
    'var el=pickEl(e.target);if(!el)return;' +
    'pressEl=el;pressId=e.pointerId;pressX=e.clientX;pressY=e.clientY;' +
    '},true);' +
    // pointermove: hover chip when idle; promote to drag past threshold; while
    // dragging, live-translate (free) or recompute the drop gap (reorder).
    'document.addEventListener("pointermove",function(e){' +
    'if(!on)return;' +
    'if(dragging){e.preventDefault();' +
    'if(free){moveFree(e.clientX,e.clientY);}' +
    'else{computeDrop(e.clientX,e.clientY,containerUnder(e.clientX,e.clientY)||dragging.parentElement);}' +
    'return;}' +
    'if(pressEl){var mdx=e.clientX-pressX,mdy=e.clientY-pressY;' +
    'if((mdx*mdx+mdy*mdy)>=(DRAG_THRESHOLD*DRAG_THRESHOLD)){startDrag(e.clientX,e.clientY);return;}}' +
    'var t=pickEl(e.target);' +
    'if(!t){clearHover();hideHandle();return;}' +
    'if(t!==hovered){clearHover();hovered=t;t.classList.add("cdz-hover");}' +
    'showHandle(t);' +
    '},true);' +
    // pointerup: commit the drag (cdz-free in free mode, else cdz-move), or a
    // plain press that will become a click→pick.
    'document.addEventListener("pointerup",function(e){' +
    'if(!on){pressEl=null;pressId=null;return;}' +
    'if(dragging){e.preventDefault();e.stopPropagation();' +
    'try{document.documentElement.releasePointerCapture(pressId);}catch(_e){}' +
    'var id=idOf(dragging);' +
    'if(free){var ddx=Math.round(e.clientX-pressX),ddy=Math.round(e.clientY-pressY);' +
    'if(id!==null&&(ddx!==0||ddy!==0)){' +
    'window.parent.postMessage({type:"cdz-free",id:id,dx:ddx,dy:ddy},"*");}' +
    'endDrag();return;}' +
    'var beforeId=(dropBefore!==null)?idOf(dropBefore):null;' +
    'var samePar=(!dropParent||dropParent===dragging.parentElement);' +
    'var parentId=samePar?null:idOf(dropParent);' +
    'if(id!==null){' +
    'var msg={type:"cdz-move",id:id,beforeId:beforeId};' +
    'if(parentId!==null){msg.parentId=parentId;msg.beforeId=dropInto?null:beforeId;}' +
    'window.parent.postMessage(msg,"*");}' +
    'endDrag();return;}' +
    'pressEl=null;pressId=null;' +
    '},true);' +
    // pointercancel: abort the gesture; restore the free-move base transform.
    'document.addEventListener("pointercancel",function(){' +
    'if(dragging&&free){dragging.style.transform=baseTf;}' +
    'endDrag();suppressClick=false;' +
    '},true);' +
    // click: normal pick, UNLESS this click terminated a drag gesture.
    'document.addEventListener("click",function(e){' +
    'if(!on)return;' +
    'if(editingEl&&editingEl.contains(e.target)){return;}' +
    'if(suppressClick){suppressClick=false;e.preventDefault();e.stopPropagation();return;}' +
    'var t=pickEl(e.target);' +
    'if(!t)return;' +
    'var idAttr=t.getAttribute("data-cdz-id");' +
    'if(idAttr===null)return;' +
    'e.preventDefault();e.stopPropagation();' +
    'var els=document.querySelectorAll(".cdz-sel");' +
    'for(var i=0;i<els.length;i++){els[i].classList.remove("cdz-sel");}' +
    't.classList.add("cdz-sel");' +
    'window.parent.postMessage({type:"cdz-pick",id:parseInt(idAttr,10),' +
    'tag:(t.tagName||"").toLowerCase(),text:directText(t)},"*");' +
    '},true);' +
    // ── inline text edit (dblclick → contenteditable) ─────────────
    // Commit the in-progress inline edit: read direct text, tear down the
    // contenteditable state, and post cdz-text to the parent. Idempotent.
    'function commitInlineEdit(){' +
    'if(!editingEl)return;' +
    'var el=editingEl;editingEl=null;' +
    'el.removeAttribute("contenteditable");' +
    'el.removeEventListener("blur",onEditBlur,true);' +
    'el.removeEventListener("keydown",onEditKey,true);' +
    'var id=idOf(el);' +
    'var txt=directText(el);' +
    'if(id!==null){window.parent.postMessage({type:"cdz-text",id:id,text:txt},"*");}' +
    '}' +
    // Cancel an inline edit WITHOUT posting (Escape): just tear down.
    'function cancelInlineEdit(){' +
    'if(!editingEl)return;' +
    'var el=editingEl;editingEl=null;' +
    'el.removeAttribute("contenteditable");' +
    'el.removeEventListener("blur",onEditBlur,true);' +
    'el.removeEventListener("keydown",onEditKey,true);' +
    'el.blur();' +
    '}' +
    'function onEditBlur(){commitInlineEdit();}' +
    // Enter (no Shift) commits; Escape cancels. Shift+Enter inserts a newline.
    'function onEditKey(e){' +
    'if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();commitInlineEdit();}' +
    'else if(e.key==="Escape"){e.preventDefault();cancelInlineEdit();}' +
    '}' +
    // dblclick a tagged element (inspect on) → enter inline edit. Suppress the
    // click paired with the second tap so it can't re-pick / preventDefault.
    'document.addEventListener("dblclick",function(e){' +
    'if(!on)return;' +
    'var t=pickEl(e.target);if(!t)return;' +
    'if(t.getAttribute("data-cdz-id")===null)return;' +
    'e.preventDefault();e.stopPropagation();' +
    'if(dragging){endDrag();}' +
    'suppressClick=false;' +
    'if(editingEl&&editingEl!==t){commitInlineEdit();}' +
    'editingEl=t;' +
    't.setAttribute("contenteditable","true");' +
    't.addEventListener("blur",onEditBlur,true);' +
    't.addEventListener("keydown",onEditKey,true);' +
    't.focus();' +
    // Place the caret at the click point (fallback: select all text).
    'try{' +
    'var sel=window.getSelection();sel.removeAllRanges();' +
    'var rng;' +
    'if(document.caretRangeFromPoint){rng=document.caretRangeFromPoint(e.clientX,e.clientY);}' +
    'if(!rng){rng=document.createRange();rng.selectNodeContents(t);}' +
    'sel.addRange(rng);' +
    '}catch(_e){}' +
    '},true);' +
    // Escape cancels an in-progress inline edit or drag cleanly (without
    // posting); in free mode it snaps the element back to its base transform.
    'document.addEventListener("keydown",function(e){' +
    'if(e.key==="Escape"&&editingEl){e.preventDefault();cancelInlineEdit();return;}' +
    'if(e.key==="Escape"&&dragging){e.preventDefault();suppressClick=false;' +
    'if(free){dragging.style.transform=baseTf;}endDrag();}' +
    '},true);' +
    // Parent → iframe mode update (on = inspect enabled, free = free-move).
    // Turning inspect off resets drag state, clears affordances + selection.
    'window.addEventListener("message",function(e){' +
    'if(e.source!==window.parent)return;' +
    'var d=e.data;' +
    'if(!d||d.type!=="cdz-mode")return;' +
    'on=!!d.on;free=!!d.free;' +
    'document.documentElement.classList.toggle("cdz-active",on);' +
    'if(!on){commitInlineEdit();clearHover();hideHandle();endDrag();suppressClick=false;' +
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
 * Read the (x, y) of a leading `translate(Xpx, Ypx)` in a CSS transform value,
 * or (0, 0) when absent. Mirrors the bridge's readTx so preview + commit agree.
 */
function readTranslate(transform: string): { x: number; y: number } {
  const m = /translate\(\s*(-?[0-9.]+)px\s*,\s*(-?[0-9.]+)px\s*\)/i.exec(
    transform || ''
  );
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
}

/**
 * Return `transform` with its translate component set to (nx, ny)px: replace an
 * existing translate in place, else prepend one (preserving any other transform
 * functions). Mirrors the bridge's writeTx. Treats `none` as empty.
 */
function withTranslate(transform: string, nx: number, ny: number): string {
  const base = transform && transform.toLowerCase() !== 'none' ? transform : '';
  const t = `translate(${nx}px, ${ny}px)`;
  const re = /translate\(\s*-?[0-9.]+px\s*,\s*-?[0-9.]+px\s*\)/i;
  if (re.test(base)) return base.replace(re, t);
  return base ? `${t} ${base}` : t;
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
