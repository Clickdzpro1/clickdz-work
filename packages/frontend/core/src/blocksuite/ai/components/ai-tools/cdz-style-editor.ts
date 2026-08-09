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
 *   - `'color'`     → a colour input / swatch (value is any CSS colour string);
 *   - `'select'`    → a `<select>` populated from {@link options};
 *   - `'number'`    → a numeric stepper, clamped to {@link min}/{@link max} and
 *                     written back with {@link unit} appended (e.g. `16px`);
 *   - `'text'`      → a free-text field (raw CSS value);
 *   - `'animation'` → a `<select>` of motion presets (fade-in-up, zoom-in,
 *                     count-up, marquee, hover-lift) whose value is a preset
 *                     token the studio expands, rather than a raw CSS value.
 */
export interface CdzStyleProp {
  /** CSS property name, always lower-cased, e.g. `'background-color'`. */
  key: string;
  /** Human label shown next to the control, e.g. `'Background'`. */
  label: string;
  /** Which control the edit panel renders for this property. */
  kind: 'color' | 'select' | 'number' | 'text' | 'animation';
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
 * The synthetic key used for the Animation preset control. It is NOT a real CSS
 * property — the studio special-cases it (a) to seed it from the element's
 * `data-cdz-anim` attribute rather than the inline style, and (b) to expand the
 * preset into the runtime instead of writing it verbatim into `style`.
 */
export const CDZ_ANIMATION_KEY = 'cdz-animation';

/**
 * Selectable motion presets for the studio's Animation row. `value` is a
 * preset TOKEN (not a raw CSS value): the studio expands it into the inline
 * `animation` shorthand (via {@link CDZ_ANIMATION_INLINE}) and injects the
 * matching @keyframes + interaction runtime once into the app's <head> (see
 * {@link CDZ_ANIMATION_RUNTIME_CSS}/{@link CDZ_ANIMATION_RUNTIME_JS}). Purely
 * self-contained inline CSS/JS — no external libraries (app-builder constraint).
 */
export const CDZ_ANIMATION_PRESETS: { value: string; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fade-in-up', label: 'Fade in up' },
  { value: 'zoom-in', label: 'Zoom in' },
  { value: 'count-up', label: 'Count up' },
  { value: 'marquee', label: 'Marquee (scroll)' },
  { value: 'hover-lift', label: 'Hover lift' },
];

/**
 * The inline `animation` shorthand applied to the element for each PURE-CSS
 * preset. `count-up` and `hover-lift` are interaction-driven so they map to ''
 * (their effect comes from the injected runtime via the element's
 * `data-cdz-anim` tag, not an inline animation value); `none` also maps to ''.
 */
export const CDZ_ANIMATION_INLINE: Record<string, string> = {
  'fade-in-up': 'cdz-anim-fade-up 0.6s ease both',
  'zoom-in': 'cdz-anim-zoom-in 0.45s ease both',
  'count-up': '',
  marquee: 'cdz-anim-marquee 14s linear infinite',
  'hover-lift': '',
};

/**
 * The CSS runtime (keyframes + interaction rules) the studio injects once into
 * the app's <head>. Pure inline CSS, self-contained, scoped under a
 * `data-cdz-anim` attribute so it never bleeds into unrelated elements.
 */
export const CDZ_ANIMATION_RUNTIME_CSS =
  '@keyframes cdz-anim-fade-up{from{opacity:0;transform:translateY(16px)}' +
  'to{opacity:1;transform:translateY(0)}}' +
  '@keyframes cdz-anim-zoom-in{from{opacity:0;transform:scale(.92)}' +
  'to{opacity:1;transform:scale(1)}}' +
  '@keyframes cdz-anim-marquee{from{transform:translateX(100%)}' +
  'to{transform:translateX(-100%)}}' +
  '[data-cdz-anim="hover-lift"]{transition:transform .2s ease, box-shadow .2s ease;}' +
  '[data-cdz-anim="hover-lift"]:hover{transform:translateY(-4px);' +
  'box-shadow:0 10px 24px rgba(0,0,0,.14);}';

/**
 * The tiny vanilla-JS runtime for `count-up`: animates the numeric part of any
 * element tagged `data-cdz-anim="count-up"` from 0 up to its text value. Pure
 * inline JS, self-contained, dependency-free, respects existing suffixes (%, DZD).
 */
export const CDZ_ANIMATION_RUNTIME_JS =
  '(function(){' +
  'var els=document.querySelectorAll(\'[data-cdz-anim="count-up"]\');' +
  'for(var i=0;i<els.length;i++){(function(el){' +
  'var txt=el.textContent||"";' +
  'var m=txt.replace(/[^0-9.,]/g,"");' +
  'var num=parseFloat(m.replace(/,/g,""));' +
  'if(!isFinite(num)||num<=0)return;' +
  'var suf=txt.replace(/[0-9.,]+/g,"");' +
  'var start=0,dur=1100,t0=null;' +
  'function fmt(n){return Math.round(n).toLocaleString("fr-FR")+suf;}' +
  'function step(ts){if(!t0)t0=ts;var p=Math.min(1,(ts-t0)/dur);' +
  'el.textContent=fmt(start+(num-start)*(p*p));' +
  'if(p<1&&typeof requestAnimationFrame==="function")requestAnimationFrame(step);' +
  '}' +
  'if(typeof requestAnimationFrame==="function")requestAnimationFrame(step);' +
  '})(els[i]);}' +
  '})();';

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
  {
    key: CDZ_ANIMATION_KEY,
    label: 'Animation',
    kind: 'animation',
    options: CDZ_ANIMATION_PRESETS,
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
