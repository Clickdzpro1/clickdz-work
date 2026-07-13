import { css, html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { CdzDiffRow } from './cdz-html-diff';
import { diffStats } from './cdz-html-diff';

/**
 * `<cdz-diff-view>` — a scrollable, unified line-diff surface for the ClickDz
 * Builder Studio.
 *
 * Renders the `CdzDiffRow[]` produced by `diffLines` (see `./cdz-html-diff`)
 * as a GitHub-style unified diff: a two-column line-number gutter
 * (old / new), a sign column (`+` / `−` / space) and the line text, all in
 * monospace. Added lines get an `--cdz-accent` tint, deleted lines an
 * `--cdz-danger` tint, and context lines are muted. A header summarises the
 * change with `+adds / −dels` derived from `diffStats`.
 *
 * Self-contained: imports only from `lit` and `lit/decorators.js`, plus the
 * diff types/helpers from its sibling util. It re-declares the `--cdz-*`
 * design tokens on `:host` (matching the studio) so it also looks correct when
 * used outside the studio; when nested inside the studio the inherited values
 * win, so the two always stay visually in sync.
 */
@customElement('cdz-diff-view')
export class CdzDiffView extends LitElement {
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

      display: block;
      color: var(--cdz-text);
      font-family: var(--cdz-sans);
    }

    .cdz-diff {
      display: flex;
      flex-direction: column;
      min-height: 0;
      max-height: 100%;
      border: 1px solid var(--cdz-border);
      border-radius: 10px;
      background: var(--cdz-bg);
      overflow: hidden;
    }

    /* ── Header ─────────────────────────────────────────────────────── */
    .cdz-diff-head {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: none;
      padding: 8px 12px;
      border-bottom: 1px solid var(--cdz-border);
      background: linear-gradient(
        180deg,
        var(--cdz-bg-2),
        var(--cdz-bg)
      );
      font-family: var(--cdz-mono);
      font-size: 12px;
      line-height: 1.4;
    }

    .cdz-diff-title {
      color: var(--cdz-text-2);
      letter-spacing: 0.02em;
      text-transform: uppercase;
      font-size: 11px;
    }

    .cdz-diff-stats {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
      font-variant-numeric: tabular-nums;
    }

    .cdz-stat {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 7px;
      border-radius: 999px;
      border: 1px solid transparent;
      font-weight: 600;
    }
    .cdz-stat.add {
      color: var(--cdz-accent);
      background: color-mix(in srgb, var(--cdz-accent) 12%, transparent);
      border-color: color-mix(in srgb, var(--cdz-accent) 30%, transparent);
    }
    .cdz-stat.del {
      color: var(--cdz-danger);
      background: color-mix(in srgb, var(--cdz-danger) 12%, transparent);
      border-color: color-mix(in srgb, var(--cdz-danger) 30%, transparent);
    }
    .cdz-stat.none {
      color: var(--cdz-text-2);
      background: var(--cdz-bg-3);
      border-color: var(--cdz-border);
      font-weight: 500;
    }

    /* ── Scroll body ────────────────────────────────────────────────── */
    .cdz-diff-body {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      font-family: var(--cdz-mono);
      font-size: 12px;
      line-height: 1.55;
      /* Faithful whitespace + horizontal scroll for long lines. */
      tab-size: 2;
      -moz-tab-size: 2;
    }

    .cdz-rows {
      display: table;
      width: 100%;
      border-collapse: collapse;
    }

    .cdz-row {
      display: table-row;
    }
    .cdz-row.add {
      background: color-mix(in srgb, var(--cdz-accent) 9%, transparent);
    }
    .cdz-row.del {
      background: color-mix(in srgb, var(--cdz-danger) 9%, transparent);
    }
    .cdz-row.add:hover {
      background: color-mix(in srgb, var(--cdz-accent) 15%, transparent);
    }
    .cdz-row.del:hover {
      background: color-mix(in srgb, var(--cdz-danger) 15%, transparent);
    }
    .cdz-row.ctx:hover {
      background: color-mix(in srgb, var(--cdz-text-2) 8%, transparent);
    }

    /* Gutter: old + new line numbers. */
    .cdz-gutter {
      display: table-cell;
      width: 1%;
      white-space: nowrap;
      padding: 0 8px;
      text-align: right;
      color: var(--cdz-text-2);
      background: color-mix(in srgb, var(--cdz-bg-2) 70%, transparent);
      border-right: 1px solid var(--cdz-border);
      user-select: none;
      font-variant-numeric: tabular-nums;
      vertical-align: top;
    }
    .cdz-gutter.new {
      /* Slightly tighter divider between the two number columns. */
      border-right: 1px solid var(--cdz-border);
    }
    .cdz-row.add .cdz-gutter {
      color: color-mix(in srgb, var(--cdz-accent) 75%, var(--cdz-text-2));
    }
    .cdz-row.del .cdz-gutter {
      color: color-mix(in srgb, var(--cdz-danger) 70%, var(--cdz-text-2));
    }

    /* Sign column: +, −, or blank. */
    .cdz-sign {
      display: table-cell;
      width: 1%;
      padding: 0 6px 0 8px;
      text-align: center;
      user-select: none;
      color: var(--cdz-text-2);
      vertical-align: top;
    }
    .cdz-row.add .cdz-sign {
      color: var(--cdz-accent);
    }
    .cdz-row.del .cdz-sign {
      color: var(--cdz-danger);
    }

    /* Code text. */
    .cdz-code {
      display: table-cell;
      width: 100%;
      padding: 0 12px 0 4px;
      white-space: pre;
      color: var(--cdz-text);
      vertical-align: top;
    }
    .cdz-row.ctx .cdz-code {
      color: var(--cdz-text-2);
    }

    /* ── Empty state ────────────────────────────────────────────────── */
    .cdz-diff-empty {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 28px 16px;
      color: var(--cdz-text-2);
      text-align: center;
    }
    .cdz-diff-empty .cdz-empty-mark {
      font-family: var(--cdz-mono);
      font-size: 18px;
      color: color-mix(in srgb, var(--cdz-accent) 60%, var(--cdz-text-2));
    }
    .cdz-diff-empty .cdz-empty-text {
      font-size: 12px;
    }
  `;

  /** The unified-diff rows to render (from `diffLines`). */
  @property({ attribute: false })
  accessor rows: CdzDiffRow[] = [];

  override render() {
    const rows = this.rows ?? [];
    const { added, removed } = diffStats(rows);

    return html`
      <div class="cdz-diff">
        <div class="cdz-diff-head">
          <span class="cdz-diff-title">Diff</span>
          <span class="cdz-diff-stats">${this.renderStats(added, removed)}</span>
        </div>
        ${rows.length === 0
          ? html`
              <div class="cdz-diff-empty">
                <span class="cdz-empty-mark">≡</span>
                <span class="cdz-empty-text">No changes</span>
              </div>
            `
          : html`
              <div class="cdz-diff-body">
                <div class="cdz-rows" role="table" aria-label="Unified diff">
                  ${rows.map(row => this.renderRow(row))}
                </div>
              </div>
            `}
      </div>
    `;
  }

  private renderStats(added: number, removed: number) {
    if (added === 0 && removed === 0) {
      return html`<span class="cdz-stat none">no changes</span>`;
    }
    return html`
      <span class="cdz-stat add" title="${added} added">+${added}</span>
      <span class="cdz-stat del" title="${removed} removed">−${removed}</span>
    `;
  }

  private renderRow(row: CdzDiffRow) {
    const sign = row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ';
    // `nothing` renders an empty cell for a missing side of the diff; the
    // gutter keeps its width via `width: 1%` + horizontal padding.
    const oldNo = row.oldLine ?? nothing;
    const newNo = row.newLine ?? nothing;

    return html`
      <div class="cdz-row ${row.type}" role="row">
        <span class="cdz-gutter old" role="cell" aria-hidden="true"
          >${oldNo}</span
        >
        <span class="cdz-gutter new" role="cell" aria-hidden="true"
          >${newNo}</span
        >
        <span class="cdz-sign" aria-hidden="true">${sign}</span>
        <span class="cdz-code" role="cell">${row.text}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cdz-diff-view': CdzDiffView;
  }
}
