import { html } from 'lit';

/**
 * `cdz-history-meta.ts` — NON-INVASIVE version-history metadata layer.
 *
 * The Builder Studio keeps a raw undo/redo stack as `history: string[]` +
 * `historyIndex` (Feature B). This module does NOT replace or wrap that stack.
 * Instead it provides a *parallel*, index-aligned array of lightweight
 * `CdzSnapshotMeta` records: `metas[i]` describes `history[i]`. The studio owns
 * both arrays and keeps them the same length; this file only defines the shape
 * of a meta record, cheap constructors/formatters, and a render helper.
 *
 * Design constraints (see SHARED BRIEF §4):
 *   - No new dependencies. Lit `html` import only (this is a helper module, not
 *     a custom element, so there is no Shadow DOM / `css` tagged styles here —
 *     styling is inline and MUST use the studio's design tokens only).
 *   - TypeScript strict.
 *
 * Design tokens (declared on the studio host, inherited through the light DOM
 * where this template is placed): `--cdz-accent`, `--cdz-bg`, `--cdz-bg-2`,
 * `--cdz-bg-3`, `--cdz-border`, `--cdz-text`, `--cdz-text-2`, `--cdz-danger`,
 * `--cdz-mono`, `--cdz-sans`. Never hardcode colors.
 */

/**
 * What produced a given snapshot. Aligned 1:1 with the studio's history
 * push-points:
 *   - `baseline` — the first/original snapshot for a document (index 0).
 *   - `code`     — a code-editor edit boundary.
 *   - `ai`       — a committed AI generation result.
 *   - `move`     — a drag/reorder (visual move) commit.
 *   - `edit`     — a visual (click-to-edit) property/content change.
 */
export type CdzSnapshotKind = 'baseline' | 'code' | 'ai' | 'move' | 'edit';

/**
 * Metadata for one history entry. `metas[i]` describes `history[i]`; keep the
 * two arrays index-aligned in the studio.
 */
export interface CdzSnapshotMeta {
  /** Short human-readable label, e.g. "AI edit" or a custom summary line. */
  label: string;
  /** The kind of change that produced this snapshot. */
  kind: CdzSnapshotKind;
  /** Creation time, epoch ms (from `Date.now()`). */
  ts: number;
}

/**
 * Human-readable default label for a snapshot kind. Used when the caller does
 * not supply a richer label (e.g. an AI "what changed" summary).
 */
export function defaultLabel(kind: CdzSnapshotKind): string {
  switch (kind) {
    case 'baseline':
      return 'Original';
    case 'code':
      return 'Code edit';
    case 'ai':
      return 'AI edit';
    case 'move':
      return 'Move';
    case 'edit':
      return 'Visual edit';
    default:
      // Exhaustiveness guard: if `CdzSnapshotKind` grows, this keeps the return
      // type sound at runtime rather than yielding `undefined`.
      return assertNever(kind);
  }
}

/**
 * Build a meta record for a new snapshot. Stamps `ts` with `Date.now()`. When
 * `label` is omitted (or blank) falls back to `defaultLabel(kind)`.
 */
export function makeMeta(kind: CdzSnapshotKind, label?: string): CdzSnapshotMeta {
  const trimmed = label?.trim();
  return {
    kind,
    label: trimmed ? trimmed : defaultLabel(kind),
    ts: Date.now(),
  };
}

/**
 * Format an epoch-ms timestamp as a short local wall-clock time, e.g. "14:07".
 * 24-hour, zero-padded. Falls back to a manual `HH:MM` build if
 * `Intl`/`toLocaleTimeString` is unavailable or throws (defensive; keeps the
 * helper pure and never throwing for a valid finite `ts`).
 */
export function formatTs(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  try {
    return d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}

/* ── inline SVG icon set ───────────────────────────────────────────────
 * 16px, stroke: currentColor, no fill, rounded caps/joins — matching the
 * studio's `CDZ_ICONS` convention. Purely decorative → aria-hidden; the row
 * itself carries the accessible label. One glyph per snapshot kind so the list
 * reads at a glance.
 */
const KIND_ICONS: Record<CdzSnapshotKind, unknown> = {
  // baseline — flag (the starting point)
  baseline: html`<svg
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
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
    <line x1="4" y1="22" x2="4" y2="15"></line>
  </svg>`,
  // code — angle brackets
  code: html`<svg
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
    <polyline points="16 18 22 12 16 6"></polyline>
    <polyline points="8 6 2 12 8 18"></polyline>
  </svg>`,
  // ai — sparkles
  ai: html`<svg
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
    <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15l-1.9-4.1L5.5 9l4.6-1.4z"></path>
    <path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"></path>
  </svg>`,
  // move — four-way arrows
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
  // edit — pencil
  edit: html`<svg
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
    <path d="M12 20h9"></path>
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"></path>
  </svg>`,
};

// restore — counter-clockwise arrow; shown on non-active rows as the affordance.
const RESTORE_ICON = html`<svg
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
  <polyline points="1 4 1 10 7 10"></polyline>
  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
</svg>`;

/**
 * Render a compact, scrollable version list.
 *
 * Ordering matches the studio's `history` array: oldest at the top, newest at
 * the bottom (index 0 = the baseline/original). The entry at `activeIndex`
 * (i.e. the current `historyIndex`) is highlighted with `--cdz-accent` and
 * marked as "Current"; it is not restorable (it is already active). Clicking
 * any non-active row invokes `onRestore(index)` with that row's array index so
 * the studio can move its `historyIndex` there and restore the snapshot.
 *
 * Styling is inline and uses design tokens only (this template renders into the
 * studio's light DOM, which declares the tokens on its host).
 */
export function renderVersionList(
  metas: readonly CdzSnapshotMeta[],
  activeIndex: number,
  onRestore: (index: number) => void
): unknown {
  if (metas.length === 0) {
    return html`<div
      style="
        padding: 12px;
        font-family: var(--cdz-sans);
        font-size: 12px;
        color: var(--cdz-text-2);
        text-align: center;
      "
    >
      No versions yet
    </div>`;
  }

  return html`<div
    role="list"
    aria-label="Version history"
    style="
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 320px;
      overflow-y: auto;
      padding: 4px;
      font-family: var(--cdz-sans);
    "
  >
    ${metas.map((meta, index) => {
      const isActive = index === activeIndex;
      const rowBg = isActive ? 'var(--cdz-bg-3)' : 'transparent';
      const rowBorder = isActive
        ? '1px solid var(--cdz-accent)'
        : '1px solid transparent';
      // The accent is used for the active row's left rail + text; non-active
      // rows lean on --cdz-text / --cdz-text-2 so the current one stands out.
      const iconColor = isActive ? 'var(--cdz-accent)' : 'var(--cdz-text-2)';
      const labelColor = isActive ? 'var(--cdz-text)' : 'var(--cdz-text)';

      return html`<div
        role="listitem"
        style="
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          border-radius: 6px;
          background: ${rowBg};
          border: ${rowBorder};
          border-left: 3px solid ${isActive
          ? 'var(--cdz-accent)'
          : 'var(--cdz-border)'};
        "
      >
        <span
          style="
            display: inline-flex;
            flex: none;
            color: ${iconColor};
          "
          >${KIND_ICONS[meta.kind]}</span
        >
        <span
          style="
            flex: 1 1 auto;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 1px;
          "
        >
          <span
            style="
              font-size: 12px;
              line-height: 1.3;
              color: ${labelColor};
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            "
            title=${meta.label}
            >${meta.label}</span
          >
          <span
            style="
              font-size: 11px;
              line-height: 1.2;
              color: var(--cdz-text-2);
              font-family: var(--cdz-mono);
            "
            >${formatTs(meta.ts)}</span
          >
        </span>
        ${isActive
          ? html`<span
              style="
                flex: none;
                font-size: 10px;
                font-weight: 600;
                letter-spacing: 0.04em;
                text-transform: uppercase;
                color: var(--cdz-accent);
                font-family: var(--cdz-sans);
              "
              >Current</span
            >`
          : html`<button
              type="button"
              title="Restore this version"
              aria-label=${`Restore ${meta.label} from ${formatTs(meta.ts)}`}
              @click=${() => onRestore(index)}
              style="
                flex: none;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                padding: 0;
                border-radius: 5px;
                cursor: pointer;
                color: var(--cdz-text-2);
                background: var(--cdz-bg-2);
                border: 1px solid var(--cdz-border);
              "
            >
              ${RESTORE_ICON}
            </button>`}
      </div>`;
    })}
  </div>`;
}

/**
 * Compile-time exhaustiveness helper. Callers should never reach this at
 * runtime for a valid `CdzSnapshotKind`; it exists so adding a new kind to the
 * union surfaces as a type error at every `switch` that forgot to handle it.
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled CdzSnapshotKind: ${String(value)}`);
}
