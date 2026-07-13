/**
 * Selection context — builds `CdzSelectionCtx.descriptor` (shared brief §5).
 *
 * When the user inspects/selects an element in the Builder Studio preview, we
 * ship a compact, human/AI-readable locator to the backend so the model knows
 * *which* element to edit. This is a best-effort, richer companion to the raw
 * {tag, text} pick — the AI still receives the full working HTML, so this only
 * needs to point unambiguously enough at the node.
 *
 * ── Deterministic-id invariant (must match the studio) ────────────────────
 * The studio's `walkBody` parses the clean `workingHtml` with `DOMParser`,
 * takes `doc.body`, and walks `body.querySelectorAll('*')` — which yields
 * elements in document (tree) order — assigning ids 0,1,2,… (index === id).
 * We reproduce that EXACT walk here so `sel.id` resolves to the same node the
 * user clicked. See clickdz-builder-studio.ts `walkBody` / `directText`.
 *
 * Guarantees:
 *  - Output is <= 500 chars (backend cap for `selection.descriptor`).
 *  - Never emits the editor bookkeeping attribute `data-cdz-id`.
 *  - Dependency-free. Uses the browser-global `DOMParser` at runtime; when
 *    that global is absent (e.g. a plain Node self-test) the DOM path is
 *    skipped and we return the deterministic fallback.
 */

// Explicit module marker: this file has no top-level `import`, so this keeps
// it unambiguously an ES module (the sole named export lives far below).
export {};

const MAX_DESCRIPTOR = 500;
const MAX_TEXT = 200;
const MAX_ANCESTORS = 4;
const MAX_ATTR_VALUE = 80;

// Attributes worth surfacing to the model, in priority order. `id` and the
// first class token are handled separately (they get compact `#`/`.` syntax).
const KEY_ATTRS: readonly string[] = ['aria-label', 'name', 'type', 'href'];

/**
 * The "direct text" of an element, mirroring the studio's `directText`: if the
 * element has an element child we take only its own text nodes (so we don't
 * slurp descendants); otherwise its full textContent. Trimmed + collapsed.
 */
function directText(el: Element): string {
  const hasElementChild = el.firstElementChild !== null;
  let raw: string;
  if (!hasElementChild) {
    raw = el.textContent ?? '';
  } else {
    let out = '';
    el.childNodes.forEach(node => {
      if (node.nodeType === 3 /* Node.TEXT_NODE */) {
        out += node.textContent ?? '';
      }
    });
    raw = out;
  }
  return collapse(raw);
}

/** Trim and collapse internal whitespace runs to single spaces. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** First non-empty, whitespace-separated class token, or ''. */
function firstClassToken(el: Element): string {
  const cls = el.getAttribute('class');
  if (!cls) return '';
  for (const token of cls.split(/\s+/)) {
    if (token) return token;
  }
  return '';
}

/** A short, safe attribute value (single line, bounded). */
function attrValue(raw: string): string {
  const v = collapse(raw);
  return v.length > MAX_ATTR_VALUE ? v.slice(0, MAX_ATTR_VALUE) + '…' : v;
}

/**
 * A shallow ancestor path from the outermost tracked ancestor down to (but not
 * including) the element itself, e.g. `section > div > button` describes the
 * button's context. Walks up parentElement, stops at <body>, keeps the nearest
 * `MAX_ANCESTORS`.
 */
function ancestorPath(el: Element): string {
  const chain: string[] = [];
  let cur: Element | null = el.parentElement;
  while (cur && cur.tagName.toLowerCase() !== 'body') {
    chain.push(cur.tagName.toLowerCase());
    if (chain.length >= MAX_ANCESTORS) break;
    cur = cur.parentElement;
  }
  // chain is nearest→outermost; render outermost→nearest→element.
  chain.reverse();
  return chain.join(' > ');
}

/** The deterministic, DOM-free fallback locator. */
function fallback(sel: { tag: string; text: string }): string {
  const text = collapse(sel.text).slice(0, MAX_TEXT);
  return `${sel.tag}: "${text}"`;
}

/**
 * Build a compact locator string for the selected element.
 *
 * @param sel         The pick: `{ id, tag, text }` where `id` is the studio's
 *                    document-order index and `text` is the direct text.
 * @param workingHtml The clean working index.html (no `data-cdz-id`).
 * @returns A locator <= 500 chars. Falls back to `tag: "text"` when the
 *          element can't be resolved (bad html, out-of-range id, or no
 *          `DOMParser` in the current environment).
 */
export function buildSelectionDescriptor(
  sel: { id: number; tag: string; text: string },
  workingHtml: string
): string {
  // Node self-test / non-browser: no DOMParser → deterministic fallback only.
  if (typeof DOMParser === 'undefined') {
    return fallback(sel);
  }

  let el: Element | null = null;
  try {
    const doc = new DOMParser().parseFromString(workingHtml, 'text/html');
    const body = doc.body;
    if (body) {
      // Same walk as the studio's walkBody: elements in document order.
      const all = body.querySelectorAll('*');
      if (sel.id >= 0 && sel.id < all.length) {
        el = all[sel.id];
      }
    }
  } catch {
    el = null;
  }

  if (!el) return fallback(sel);

  // ── Assemble the parts ──────────────────────────────────────────────────
  const parts: string[] = [];

  // 1. tag (+ compact #id / .class), never data-cdz-id.
  const tag = el.tagName.toLowerCase();
  let head = tag;
  const idAttr = el.getAttribute('id');
  if (idAttr) head += '#' + attrValue(idAttr);
  const cls = firstClassToken(el);
  if (cls) head += '.' + attrValue(cls);
  parts.push(head);

  // 2. key attributes (aria-label, name, type, href) if present.
  for (const attr of KEY_ATTRS) {
    const raw = el.getAttribute(attr);
    if (raw !== null && raw !== '') {
      parts.push(`${attr}="${attrValue(raw)}"`);
    }
  }

  // 3. ancestor path for context.
  const path = ancestorPath(el);
  if (path) parts.push(`in ${path}`);

  // 4. trimmed text snippet (prefer live DOM text; fall back to the pick text).
  const text = (directText(el) || collapse(sel.text)).slice(0, MAX_TEXT);
  if (text) parts.push(`text: "${text}"`);

  const descriptor = parts.join(' | ');

  // Never leak the bookkeeping attribute, and enforce the hard cap.
  const safe = descriptor.includes('data-cdz-id')
    ? fallback(sel)
    : descriptor;
  return safe.length > MAX_DESCRIPTOR
    ? safe.slice(0, MAX_DESCRIPTOR - 1) + '…'
    : safe;
}
