/**
 * `cdz-style-editor` — the richer inline-style editing model for the ClickDz
 * Builder Studio's visual edit panel.
 *
 * Two things live here:
 *   1. {@link CDZ_EDIT_STYLE_PROPS} — a declarative list of the CSS properties
 *      the edit panel exposes as controls (color / background / typography /
 *      spacing / radius), each described by a {@link CdzStyleProp} so the panel
 *      can render the right widget (colour swatch, `<select>`, number stepper,
 *      free text) without hard-coding per-field UI.
 *   2. Three pure helpers — {@link parseInlineStyle}, {@link serializeInlineStyle}
 *      and {@link readStyleValue} — for reading and rewriting the `style`
 *      attribute of an element as a `Map<string, string>`.
 *
 * The parse/serialize semantics deliberately MIRROR the studio's private
 * `setInlineStyle(el, decls)` (in `clickdz-builder-studio.ts`) so that a value
 * read here, round-tripped, and later merged by the studio stays byte-identical:
 *   - declarations are split on `;`, each trimmed, empties dropped;
 *   - a declaration is `prop:value` split at the FIRST `:` — a colon at index 0
 *     (no property name) is ignored, matching `idx > 0`;
 *   - property keys are lower-cased and trimmed; values are trimmed;
 *   - later declarations win (last-wins) because they overwrite the map entry;
 *   - serialization joins entries as `prop: value` (single space after the
 *     colon) with `'; '` between declarations, preserving insertion order.
 *
 * Pure, deterministic, dependency-free: no `lit` import, no DOM, no third-party
 * deps — same input always yields the same output, so it is safe to import from
 * anywhere (browser or a node self-test).
 */

/**
 * One editable CSS property surfaced in the studio's visual edit panel.
 *
 * `kind` selects the control the panel renders:
 *   - `'color'`  → a colour input / swatch (value is any CSS colour string);
 *   - `'select'` → a `<select>` populated from {@link options};
 *   - `'number'` → a numeric stepper, clamped to {@link min}/{@link max} and
 *                  written back with {@link unit} appended (e.g. `16px`);
 *   - `'text'`   → a free-text field (raw CSS value).
 */
export interface CdzStyleProp {
  /** CSS property name, always lower-cased, e.g. `'background-color'`. */
  key: string;
  /** Human label shown next to the control, e.g. `'Background'`. */
  label: string;
  /** Which control the edit panel renders for this property. */
  kind: 'color' | 'select' | 'number' | 'text';
  /** Unit appended to numeric values on write, e.g. `'px'` for `number` kinds. */
  unit?: string;
  /** Choices for `select` kinds. `value` is the raw CSS written to `style`. */
  options?: { value: string; label: string }[];
  /** Inclusive lower bound for `number` kinds. */
  min?: number;
  /** Inclusive upper bound for `number` kinds. */
  max?: number;
}

/**
 * Font-family choices. Each `value` is a complete, self-contained CSS stack
 * with a fallback keyword so the app renders sanely even if the primary face is
 * unavailable — no `@font-face`, no CDN, no build step (studio constraint).
 */
const FONT_FAMILY_OPTIONS: { value: string; label: string }[] = [
  {
    value:
      "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    label: 'System',
  },
  {
    value:
      "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    label: 'Inter',
  },
  {
    value: "Georgia, Cambria, 'Times New Roman', Times, serif",
    label: 'Georgia (serif)',
  },
  {
    value:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    label: 'Mono',
  },
  {
    value: "Helvetica, Arial, sans-serif",
    label: 'Helvetica',
  },
  {
    value: "'Times New Roman', Times, serif",
    label: 'Times',
  },
  {
    value: "'Courier New', Courier, monospace",
    label: 'Courier',
  },
];

/** Font-weight choices, from regular through extra-bold. */
const FONT_WEIGHT_OPTIONS: { value: string; label: string }[] = [
  { value: '400', label: 'Regular (400)' },
  { value: '500', label: 'Medium (500)' },
  { value: '600', label: 'Semibold (600)' },
  { value: '700', label: 'Bold (700)' },
  { value: '800', label: 'Extrabold (800)' },
];

/** Horizontal text-alignment choices. */
const TEXT_ALIGN_OPTIONS: { value: string; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
  { value: 'justify', label: 'Justify' },
];

/**
 * The ordered set of CSS properties the studio's edit panel exposes as
 * controls. Order here is the render order in the panel.
 *
 * Keys are lower-cased to match {@link parseInlineStyle}/`setInlineStyle`, so a
 * value seeded from an element's inline style compares and merges cleanly.
 */
export const CDZ_EDIT_STYLE_PROPS: CdzStyleProp[] = [
  { key: 'color', label: 'Text color', kind: 'color' },
  { key: 'background-color', label: 'Background', kind: 'color' },
  {
    key: 'font-size',
    label: 'Font size',
    kind: 'number',
    unit: 'px',
    min: 8,
    max: 96,
  },
  {
    key: 'font-family',
    label: 'Font',
    kind: 'select',
    options: FONT_FAMILY_OPTIONS,
  },
  {
    key: 'font-weight',
    label: 'Weight',
    kind: 'select',
    options: FONT_WEIGHT_OPTIONS,
  },
  {
    key: 'text-align',
    label: 'Align',
    kind: 'select',
    options: TEXT_ALIGN_OPTIONS,
  },
  {
    key: 'padding',
    label: 'Padding',
    kind: 'number',
    unit: 'px',
    min: 0,
    max: 96,
  },
  {
    key: 'border-radius',
    label: 'Radius',
    kind: 'number',
    unit: 'px',
    min: 0,
    max: 96,
  },
];

/**
 * Parse a `style` attribute string into an ordered `Map` of
 * lower-cased property → trimmed value.
 *
 * Mirrors `setInlineStyle`'s reader exactly: split on `;`, trim, drop empties,
 * split each declaration at the FIRST `:` (a leading colon with no property is
 * ignored, matching `idx > 0`), lower-case + trim the property, trim the value,
 * and skip declarations whose property is empty. Duplicate properties are
 * last-wins (a later `Map.set` overwrites the earlier entry) while insertion
 * order is preserved for the first occurrence.
 *
 * @param style raw `style` attribute text (may be empty / null-ish)
 * @returns a fresh `Map<string, string>`; empty for empty/garbage input
 */
export function parseInlineStyle(style: string): Map<string, string> {
  const map = new Map<string, string>();
  (style ?? '')
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
  return map;
}

/**
 * Serialize a property→value `Map` back into a `style` attribute string.
 *
 * Mirrors `setInlineStyle`'s writer exactly: `prop: value` (single space after
 * the colon) joined by `'; '`, in the map's iteration (insertion) order. An
 * empty map serializes to `''` (the caller can then `removeAttribute('style')`).
 *
 * @param map property→value map (keys assumed already lower-cased/trimmed)
 * @returns the serialized inline-style string, or `''` when the map is empty
 */
export function serializeInlineStyle(map: Map<string, string>): string {
  return Array.from(map.entries())
    .map(([prop, val]) => `${prop}: ${val}`)
    .join('; ');
}

/**
 * Read a single declaration's value out of a `style` string.
 *
 * Parses via {@link parseInlineStyle} (so the same last-wins + normalization
 * rules apply) and looks up the lower-cased `key`. Returns `''` when the
 * property is absent, giving callers a safe default with no undefined checks.
 *
 * @param style raw `style` attribute text
 * @param key CSS property to read (matched case-insensitively)
 * @returns the trimmed value, or `''` if the property is not present
 */
export function readStyleValue(style: string, key: string): string {
  return parseInlineStyle(style).get(key.trim().toLowerCase()) ?? '';
}
