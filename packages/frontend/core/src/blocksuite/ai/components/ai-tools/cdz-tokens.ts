/**
 * `cdz-tokens` — parse and edit the `:root` CSS custom properties ("design
 * tokens") of a self-contained ClickDz Studio `index.html` document.
 *
 * The Studio edits ONE vanilla-HTML document whose theme is driven by CSS
 * custom properties declared on `:root` (and sometimes `html`) inside inline
 * `<style>` tags. This module surfaces those declarations for a live quick
 * editor and writes edits back into the document, all as pure string in /
 * string out — no Lit, no third-party deps, and no hard dependency on the DOM.
 *
 * Two operations:
 *   - {@link parseTokens}  — read every custom property declared in a `:root`
 *     (or `html`) block across all `<style>` tags, de-duplicated by name
 *     (last declaration wins) while preserving first-seen order.
 *   - {@link applyTokens}  — write a set of `--name → value` edits back into the
 *     FIRST `:root` block, updating existing declarations in place and
 *     appending the rest. Robust to a missing `:root` (created inside the first
 *     `<style>`) and to a missing `<style>` (returns the input unchanged).
 *
 * Determinism & robustness:
 *   - Same input always yields identical output — no randomness, no time or
 *     locale dependence, no reliance on DOM iteration order.
 *   - Tolerant of multiple `<style>` blocks, CSS comments, arbitrary
 *     whitespace, grouped selectors (`:root,html{…}` / `html , :root {…}`), and
 *     values that themselves contain colons (`url(...)`, `linear-gradient(...)`,
 *     `data:` URIs). Declarations are split on `;`, and only the FIRST `:` in a
 *     declaration separates the property name from its value.
 *
 * DOMParser: allowed at runtime but never required. The core path here is
 * pure regex / string manipulation so this module is safe to import from a bare
 * `node` self-test. {@link parseTokensViaDom} is an optional convenience that
 * guards `typeof DOMParser` and falls back to the string parser under node.
 *
 * Pure util: no `lit` import, no mandatory DOM — safe to import anywhere.
 */

/** A single CSS custom property. `name` INCLUDES the leading `--`. */
export interface CdzToken {
  /** Full custom-property name including the leading `--`, e.g. `--cdz-accent`. */
  name: string;
  /** Declaration value, trimmed of surrounding whitespace. */
  value: string;
}

/**
 * A `:root` / `html` block found inside a `<style>` tag, with the absolute
 * offsets (into the ORIGINAL html string) of the region between its `{` and
 * `}` braces. Used internally by {@link applyTokens} to rewrite in place.
 */
interface RootBlock {
  /** Index in the original html of the first char AFTER the opening `{`. */
  bodyStart: number;
  /** Index in the original html of the closing `}` (exclusive end of body). */
  bodyEnd: number;
}

/**
 * Match a whole `<style …>…</style>` element. Captures:
 *   [1] everything up to and including the opening tag's `>` (so we know where
 *       the body starts), and
 *   [2] the raw body between the tags.
 * The tag name and closing tag are matched case-insensitively; attributes on
 * the opening tag (e.g. `<style type="text/css">`) are tolerated. `[\s\S]`
 * is used instead of the `s` flag for maximum runtime compatibility.
 */
const STYLE_TAG_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/** Match a CSS block comment `/* … *\/` (non-greedy, spans newlines). */
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

/**
 * Replace every CSS comment in `css` with an equal-length run of spaces. Using
 * same-length padding (rather than deletion) keeps every surviving character at
 * its original offset, which lets the caller map offsets computed on the
 * "clean" string straight back onto the original string.
 */
function blankComments(css: string): string {
  return css.replace(CSS_COMMENT_RE, m => ' '.repeat(m.length));
}

/**
 * True when a raw selector list (the text before a `{`) targets `:root` or
 * `html` — including grouped selectors such as `:root, html` or `html , :root`.
 * Matching is done token-by-token on comma-separated, trimmed selectors so a
 * class like `.rooted` or `.html-thing` never counts as a match.
 */
function selectorTargetsRootOrHtml(selectorList: string): boolean {
  const parts = selectorList.split(',');
  for (const part of parts) {
    const sel = part.trim().toLowerCase();
    if (sel === ':root' || sel === 'html') return true;
  }
  return false;
}

/**
 * Split a CSS declaration body (the text inside `{ … }`) into `--name / value`
 * pairs. Only custom properties (names starting with `--`) are returned.
 *
 * Splitting rules match the contract:
 *   - declarations are separated by `;` (NOT by `:`);
 *   - within a declaration, only the FIRST `:` separates name from value, so a
 *     value like `url(https://x)` or `linear-gradient(...)` survives intact;
 *   - names and values are trimmed; empty fragments are skipped.
 */
function customPropsFromBody(body: string): CdzToken[] {
  const out: CdzToken[] = [];
  const decls = body.split(';');
  for (const decl of decls) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    const name = decl.slice(0, colon).trim();
    if (!name.startsWith('--')) continue;
    const value = decl.slice(colon + 1).trim();
    out.push({ name, value });
  }
  return out;
}

/**
 * Scan `css` (already comment-blanked) starting at `from` and return the offsets
 * of the balanced `{ … }` block that begins at the first `{` at/after `from`.
 * Brace nesting is tracked so nested blocks (rare in a flat token sheet, but
 * possible via at-rules) don't terminate the block early. Returns `null` if no
 * `{` is found or the braces are unbalanced (unclosed).
 */
function findBlockBraces(
  css: string,
  from: number
): { open: number; close: number } | null {
  const open = css.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

/**
 * Iterate every rule block inside one comment-blanked stylesheet `css`,
 * yielding the raw selector list and the block's brace offsets (relative to
 * `css`). This is a tiny top-level CSS tokenizer: it walks selector→`{…}`
 * pairs, skipping balanced blocks so it never mis-parses nested braces.
 */
function* iterateRuleBlocks(
  css: string
): Generator<{ selectorList: string; open: number; close: number }> {
  let cursor = 0;
  while (cursor < css.length) {
    const braces = findBlockBraces(css, cursor);
    if (!braces) break;
    const selectorList = css.slice(cursor, braces.open);
    yield { selectorList, open: braces.open, close: braces.close };
    cursor = braces.close + 1;
  }
}

/**
 * Parse all design tokens (`--*` custom properties) declared on `:root` /
 * `html` across every `<style>` tag in `html`.
 *
 * De-duplication: if the same `--name` is declared more than once (in the same
 * block or across blocks), the LAST declaration's value wins, but the token
 * keeps its FIRST-seen position in the returned array. This mirrors CSS cascade
 * for value while giving the editor a stable, source-ordered list.
 *
 * @param html full document source (may contain any number of `<style>` tags).
 * @returns tokens in first-seen order; `[]` when none are declared.
 */
export function parseTokens(html: string): CdzToken[] {
  if (typeof html !== 'string' || html.length === 0) return [];

  // name -> array index in `ordered`, so we can update-in-place (last wins)
  // while preserving first-seen order.
  const indexByName = new Map<string, number>();
  const ordered: CdzToken[] = [];

  STYLE_TAG_RE.lastIndex = 0;
  let styleMatch: RegExpExecArray | null;
  while ((styleMatch = STYLE_TAG_RE.exec(html)) !== null) {
    const rawBody = styleMatch[1];
    if (!rawBody) continue;
    const css = blankComments(rawBody);

    for (const rule of iterateRuleBlocks(css)) {
      if (!selectorTargetsRootOrHtml(rule.selectorList)) continue;
      const blockBody = css.slice(rule.open + 1, rule.close);
      for (const token of customPropsFromBody(blockBody)) {
        const existing = indexByName.get(token.name);
        if (existing === undefined) {
          indexByName.set(token.name, ordered.length);
          ordered.push(token);
        } else {
          // last declaration wins for the value; position is unchanged.
          ordered[existing] = { name: token.name, value: token.value };
        }
      }
    }
  }

  return ordered;
}

/**
 * Convenience wrapper that parses via `DOMParser` when it is available (browser)
 * and transparently falls back to {@link parseTokens} otherwise (node / worker
 * without DOMParser). The result is identical either way; this exists only so
 * callers that prefer a DOM path can opt in without writing the guard.
 *
 * Never throws for a missing DOMParser — it checks `typeof DOMParser` first.
 */
export function parseTokensViaDom(html: string): CdzToken[] {
  if (typeof DOMParser === 'undefined') return parseTokens(html);
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const styles = Array.from(doc.querySelectorAll('style'));
    if (styles.length === 0) return [];
    // Reassemble just the style contents and reuse the deterministic string
    // parser so DOM and non-DOM paths can never diverge.
    const joined = styles
      .map(s => `<style>${s.textContent ?? ''}</style>`)
      .join('\n');
    return parseTokens(joined);
  } catch {
    return parseTokens(html);
  }
}

/**
 * Locate the FIRST `:root` / `html` block in the ORIGINAL `html` string and
 * return the absolute offsets of its body (between the braces). Comments are
 * blanked on a COPY for detection only; because `blankComments` preserves
 * length and offsets, the offsets returned index straight into the original
 * `html`. Returns `null` when no such block exists.
 */
function findFirstRootBlock(html: string): RootBlock | null {
  const clean = blankComments(html);

  STYLE_TAG_RE.lastIndex = 0;
  let styleMatch: RegExpExecArray | null;
  while ((styleMatch = STYLE_TAG_RE.exec(clean)) !== null) {
    const body = styleMatch[1] ?? '';
    // The style body begins right after the opening tag's `>`. Deriving the
    // base from the opening tag (rather than subtracting a hardcoded
    // `</style>` length) tolerates any closing-tag spelling / spacing.
    const bodyBaseInHtml = clean.indexOf('>', styleMatch.index) + 1;

    for (const rule of iterateRuleBlocks(body)) {
      if (!selectorTargetsRootOrHtml(rule.selectorList)) continue;
      // rule.open / rule.close are relative to `body`; shift into html space.
      return {
        bodyStart: bodyBaseInHtml + rule.open + 1,
        bodyEnd: bodyBaseInHtml + rule.close,
      };
    }
  }
  return null;
}

/**
 * Given the ORIGINAL body text of a `:root` block, produce a rewritten body in
 * which every edit whose `--name` already appears has its value replaced in
 * place, and every remaining edit is appended as a new declaration. Declaration
 * boundaries are `;`; only the first `:` per declaration splits name/value, so
 * colon-bearing values are never corrupted.
 *
 * Formatting: existing declarations keep their surrounding whitespace exactly;
 * only the value text (between the first `:` and the terminating `;`/end) is
 * swapped. Appended declarations are added compactly as `\n  --name: value;`
 * with a trailing newline, which reads well inside a typical indented block but
 * does not depend on the original indentation.
 */
function rewriteRootBody(
  body: string,
  edits: Record<string, string>
): string {
  const remaining = new Map<string, string>(Object.entries(edits));

  // Walk declarations by `;`, rebuilding the string so we can substitute values
  // without disturbing anything else (comments already blanked upstream? no —
  // here we operate on the ORIGINAL body, so preserve it verbatim except for
  // the value we replace).
  let result = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    let semi = body.indexOf(';', i);
    const isLast = semi === -1;
    if (semi === -1) semi = n;
    const segment = body.slice(i, semi); // declaration WITHOUT the ';'
    const rebuilt = rewriteDeclaration(segment, remaining);
    result += rebuilt;
    if (!isLast) result += ';';
    i = semi + 1;
  }

  // Append any edits that were not found as existing declarations, in the
  // insertion order of the `edits` object (deterministic for a given caller).
  if (remaining.size > 0) {
    // Ensure the existing body ends cleanly before we append.
    let prefix = result;
    // If there is non-whitespace content not terminated by ';', add one.
    const trimmedEnd = prefix.replace(/\s+$/, '');
    if (trimmedEnd.length > 0 && !trimmedEnd.endsWith(';')) {
      prefix = trimmedEnd + ';';
    } else {
      prefix = trimmedEnd;
    }
    let appended = prefix;
    for (const [name, value] of remaining) {
      appended += `\n  ${name}: ${value};`;
    }
    appended += '\n';
    result = appended;
  }

  return result;
}

/**
 * Rewrite a single declaration `segment` (the text of one `;`-delimited chunk,
 * without the `;`). If it is a custom property present in `remaining`, its value
 * is replaced and the entry consumed from `remaining`. Otherwise the segment is
 * returned unchanged. Leading/trailing whitespace of the segment is preserved.
 */
function rewriteDeclaration(
  segment: string,
  remaining: Map<string, string>
): string {
  const colon = segment.indexOf(':');
  if (colon === -1) return segment; // not a declaration (e.g. trailing space)
  const rawName = segment.slice(0, colon);
  const name = rawName.trim();
  if (!name.startsWith('--')) return segment;
  if (!remaining.has(name)) return segment;

  const newValue = remaining.get(name)!;
  remaining.delete(name);

  // Preserve the value segment's leading whitespace (typically one space after
  // the colon) and any trailing whitespace, replacing only the value's core.
  const valuePart = segment.slice(colon + 1);
  const leadMatch = valuePart.match(/^\s*/);
  const trailMatch = valuePart.match(/\s*$/);
  const lead = leadMatch ? leadMatch[0] : '';
  const trail = trailMatch ? trailMatch[0] : '';
  // Keep the name portion byte-for-byte (indentation + name), swap value core.
  return `${rawName}:${lead}${newValue}${trail}`;
}

/**
 * Write `edits` (keyed by full `--name`) back into `html`.
 *
 * Behaviour (per contract §2):
 *   - Replace the values of any tokens that already exist in the FIRST `:root`
 *     block, in place; append tokens that don't yet exist into that block.
 *   - If the document has a `<style>` but no `:root` block, create a `:root{}`
 *     at the top of the FIRST `<style>` and add all edits there.
 *   - If the document has NO `<style>` at all, return `html` UNCHANGED (the
 *     caller decides what to do).
 *
 * Pure and deterministic: identical input → identical output. Empty `edits`
 * returns the input unchanged.
 *
 * @param html  full document source.
 * @param edits map of `--name → value` to write.
 * @returns the rewritten document (or the original when there is no `<style>`).
 */
export function applyTokens(
  html: string,
  edits: Record<string, string>
): string {
  if (typeof html !== 'string') return html;
  const editKeys = Object.keys(edits ?? {});
  if (editKeys.length === 0) return html;

  // 1) No <style> anywhere → no-op return the input unchanged.
  STYLE_TAG_RE.lastIndex = 0;
  const firstStyle = STYLE_TAG_RE.exec(html);
  if (!firstStyle) return html;

  // 2) There IS a :root/html block → rewrite the first one in place.
  const root = findFirstRootBlock(html);
  if (root) {
    const originalBody = html.slice(root.bodyStart, root.bodyEnd);
    const newBody = rewriteRootBody(originalBody, edits);
    if (newBody === originalBody) return html;
    return html.slice(0, root.bodyStart) + newBody + html.slice(root.bodyEnd);
  }

  // 3) <style> exists but no :root → create a :root{} at the top of the FIRST
  //    <style> body and add every edit. The body starts right after the
  //    opening tag's `>`.
  const openTagEnd = html.indexOf('>', firstStyle.index) + 1;

  let block = ':root {';
  for (const key of editKeys) {
    block += `\n  ${key}: ${edits[key]};`;
  }
  block += '\n}\n';

  // Insert the new :root block at the very start of the style body, preserving
  // whatever already lives in the stylesheet after it.
  return html.slice(0, openTagEnd) + '\n' + block + html.slice(openTagEnd);
}
