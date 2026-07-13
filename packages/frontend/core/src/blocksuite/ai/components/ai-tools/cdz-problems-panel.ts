import { html } from 'lit';

import type { CdzProblem } from './cdz-console-bridge';

/**
 * `cdz-problems-panel.ts` — render helper for the Studio's Problems panel
 * (SHARED BRIEF §3). This is a *module-level render helper*, NOT a custom
 * element: it returns a Lit template (`unknown`) that the studio drops into its
 * own floating-panel chrome (like `renderVersionList` in `cdz-history-meta.ts`).
 *
 * Because it renders into the studio's light DOM there is no Shadow DOM / `css`
 * tagged styles here — styling is inline and MUST use the studio's design
 * tokens: `--cdz-accent`, `--cdz-bg`, `--cdz-bg-2`, `--cdz-bg-3`, `--cdz-border`,
 * `--cdz-text`, `--cdz-text-2`, `--cdz-danger`, `--cdz-mono`, `--cdz-sans`.
 * Warn/amber has no token, so we use the literal `#f59e0b` (SHARED BRIEF §0 —
 * matches an existing swatch). Buttons also carry the studio's `.cdz-btn`
 * class hooks so, when mounted inside the studio, they inherit the unified
 * button system (hover/focus/disabled); the inline styles keep the helper
 * self-contained and correct even without that stylesheet.
 *
 * The panel is intentionally calm: a compact header (summary + Clear + primary
 * "Fix N with AI"), a scrollable list of monospace problem rows, and a quiet
 * empty state. The "Fix N with AI" button is disabled when there are zero
 * error/warn problems (log-only or empty) — there is nothing to fix.
 */

/* ── per-level presentation ────────────────────────────────────────────
 * error → --cdz-danger, warn → #f59e0b (literal), log → --cdz-text-2.
 * Kept in one place so the chip, glyph and any future accents stay in sync.
 */
const LEVEL_COLOR: Record<CdzProblem['level'], string> = {
  error: 'var(--cdz-danger)',
  warn: '#f59e0b',
  log: 'var(--cdz-text-2)',
};

/* ── inline SVG icon set ───────────────────────────────────────────────
 * 16px, viewBox 0 0 24 24, stroke: currentColor, rounded caps/joins — matching
 * the studio's `CDZ_ICONS` / `KIND_ICONS` convention. Purely decorative →
 * aria-hidden; the row's monospace text carries the meaning. Color is applied
 * by the wrapping chip via `currentColor`, so each glyph is level-agnostic.
 */

// error — x inside a circle
const ERROR_GLYPH = html`<svg
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
  <line x1="15" y1="9" x2="9" y2="15"></line>
  <line x1="9" y1="9" x2="15" y2="15"></line>
</svg>`;

// warn — triangle with a bang
const WARN_GLYPH = html`<svg
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
</svg>`;

// log — info circle
const LOG_GLYPH = html`<svg
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
  <line x1="12" y1="11" x2="12" y2="16"></line>
  <line x1="12" y1="8" x2="12.01" y2="8"></line>
</svg>`;

const LEVEL_GLYPH: Record<CdzProblem['level'], unknown> = {
  error: ERROR_GLYPH,
  warn: WARN_GLYPH,
  log: LOG_GLYPH,
};

// empty state — a calm check
const CHECK_GLYPH = html`<svg
  width="28"
  height="28"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M20 6 9 17l-5-5"></path>
</svg>`;

/**
 * Build the header summary line, e.g. "3 errors · 1 warning". Zero categories
 * are omitted entirely; each surviving category is pluralized correctly. Logs
 * are included as their own category when present (they are still "problems"
 * captured in the list), but they never enable the Fix button.
 *
 * Returns an empty string when there is nothing to summarize (caller shows the
 * empty state instead), so this is safe/pure for any list.
 */
export function summarizeProblems(problems: readonly CdzProblem[]): string {
  let errors = 0;
  let warnings = 0;
  let logs = 0;
  for (const p of problems) {
    // Count each row once (a coalesced ×N row is still one "problem" line);
    // this keeps the header stable and readable rather than exploding on loops.
    if (p.level === 'error') errors++;
    else if (p.level === 'warn') warnings++;
    else logs++;
  }
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
  if (warnings > 0)
    parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
  if (logs > 0) parts.push(`${logs} ${logs === 1 ? 'log' : 'logs'}`);
  return parts.join(' · ');
}

/**
 * Count problems eligible for an AI fix: errors + warnings. Logs are excluded —
 * they are informational and do not represent something to repair. The "Fix N
 * with AI" button uses this for both its label (N) and its disabled state
 * (disabled when N === 0). Pure/deterministic.
 */
export function fixableCount(problems: readonly CdzProblem[]): number {
  let n = 0;
  for (const p of problems) if (p.level === 'error' || p.level === 'warn') n++;
  return n;
}

/**
 * Render the Problems panel body: a compact header (summary + Clear + primary
 * "Fix N with AI") over a scrollable, monospace list of problem rows. Renders a
 * calm empty state when `problems` is empty.
 *
 * @param problems accumulated, coalesced problems (oldest → newest); the studio
 *   owns this array (see §4). Rendered top-to-bottom in given order.
 * @param handlers `onFix` → compose a fix prompt + run the AI dock flow;
 *   `onClear` → reset the studio's problem list. Both are invoked with no args.
 *
 * Styling is inline + design-token based so the helper is self-contained; the
 * `.cdz-btn` class hooks let the buttons also adopt the studio's button system
 * when mounted there.
 */
export function renderProblems(
  problems: readonly CdzProblem[],
  handlers: { onFix: () => void; onClear: () => void }
): unknown {
  const total = problems.length;
  const fixable = fixableCount(problems);
  const fixDisabled = fixable === 0;

  // ── header (always shown, even on empty, so Clear/summary have a home) ──
  const summary = total === 0 ? 'No problems' : summarizeProblems(problems);
  const header = html`<div
    style="
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--cdz-border);
      font-family: var(--cdz-sans);
    "
  >
    <span
      style="
        flex: 1 1 auto;
        min-width: 0;
        font-size: 12px;
        font-weight: 600;
        color: var(--cdz-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      "
      title=${summary}
      >${summary}</span
    >
    <button
      type="button"
      class="cdz-btn ghost"
      title="Clear all problems"
      aria-label="Clear all problems"
      ?disabled=${total === 0}
      @click=${() => handlers.onClear()}
      style="
        flex: none;
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid transparent;
        cursor: ${total === 0 ? 'not-allowed' : 'pointer'};
        opacity: ${total === 0 ? '0.5' : '1'};
        font: inherit;
        font-size: 12px;
        font-weight: 600;
        color: var(--cdz-text-2);
        background: transparent;
      "
    >
      Clear
    </button>
    <button
      type="button"
      class="cdz-btn primary"
      title=${fixDisabled
        ? 'No errors or warnings to fix'
        : `Fix ${fixable} problem${fixable === 1 ? '' : 's'} with AI`}
      aria-label=${fixDisabled
        ? 'No errors or warnings to fix'
        : `Fix ${fixable} problem${fixable === 1 ? '' : 's'} with AI`}
      ?disabled=${fixDisabled}
      @click=${() => {
        if (!fixDisabled) handlers.onFix();
      }}
      style="
        flex: none;
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: 8px;
        border: 1px solid var(--cdz-accent);
        cursor: ${fixDisabled ? 'not-allowed' : 'pointer'};
        opacity: ${fixDisabled ? '0.5' : '1'};
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        color: #04241b;
        background: var(--cdz-accent);
      "
    >
      Fix ${fixable} with AI
    </button>
  </div>`;

  // ── empty state ──
  if (total === 0) {
    return html`<div
      style="
        display: flex;
        flex-direction: column;
        font-family: var(--cdz-sans);
      "
    >
      ${header}
      <div
        style="
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 32px 16px;
          color: var(--cdz-text-2);
          text-align: center;
        "
      >
        <span style="display: inline-flex; color: var(--cdz-accent);"
          >${CHECK_GLYPH}</span
        >
        <span style="font-size: 12px; color: var(--cdz-text-2);"
          >No problems detected</span
        >
      </div>
    </div>`;
  }

  // ── scrollable list ──
  const list = html`<div
    role="list"
    aria-label="Problems"
    style="
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 320px;
      overflow-y: auto;
      padding: 6px;
      font-family: var(--cdz-sans);
    "
  >
    ${problems.map(problem => {
      const color = LEVEL_COLOR[problem.level];
      const glyph = LEVEL_GLYPH[problem.level];
      // `source:line` when we have a source; append `:line` only if line given.
      const location =
        problem.source != null && problem.source !== ''
          ? problem.line != null
            ? `${problem.source}:${problem.line}`
            : problem.source
          : '';
      return html`<div
        role="listitem"
        style="
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 6px 8px;
          border-radius: 6px;
          border-left: 3px solid ${color};
          background: var(--cdz-bg-3);
        "
      >
        <span
          title=${problem.level}
          style="
            flex: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-top: 1px;
            color: ${color};
          "
          >${glyph}</span
        >
        <span
          style="
            flex: 1 1 auto;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 2px;
          "
        >
          <span
            style="
              font-family: var(--cdz-mono);
              font-size: 12px;
              line-height: 1.4;
              color: var(--cdz-text);
              white-space: pre-wrap;
              overflow-wrap: anywhere;
              word-break: break-word;
            "
            >${problem.text}</span
          >
          ${location
            ? html`<span
                style="
                  font-family: var(--cdz-mono);
                  font-size: 11px;
                  line-height: 1.2;
                  color: var(--cdz-text-2);
                  white-space: nowrap;
                  overflow: hidden;
                  text-overflow: ellipsis;
                "
                title=${location}
                >${location}</span
              >`
            : ''}
        </span>
        ${problem.count > 1
          ? html`<span
              title=${`${problem.count} occurrences`}
              aria-label=${`${problem.count} occurrences`}
              style="
                flex: none;
                align-self: center;
                min-width: 20px;
                padding: 1px 6px;
                border-radius: 999px;
                text-align: center;
                font-family: var(--cdz-mono);
                font-size: 11px;
                font-weight: 600;
                color: var(--cdz-text);
                background: var(--cdz-bg);
                border: 1px solid var(--cdz-border);
              "
              >×${problem.count}</span
            >`
          : ''}
      </div>`;
    })}
  </div>`;

  return html`<div
    style="display: flex; flex-direction: column; font-family: var(--cdz-sans);"
  >
    ${header}${list}
  </div>`;
}
