/**
 * `cdz-html-diff` — a small, dependency-free line-based diff engine for the
 * ClickDz Builder Studio.
 *
 * It compares two strings line by line and returns a unified sequence of
 * {@link CdzDiffRow}s (added / removed / context) suitable for rendering in
 * `<cdz-diff-view>`. The diff is computed from a proper Longest-Common-
 * Subsequence (LCS) so the output is minimal, deterministic and stable across
 * runs (same input → identical output, no randomness, no time-dependence).
 *
 * Implementation notes:
 *   - The LCS is found with Hirschberg's algorithm — an O(n·m) time,
 *     O(min(n, m)) space divide-and-conquer refinement of the classic
 *     Needleman–Wunsch DP. This keeps memory bounded to two rolling rows of
 *     ints (never the full n·m table), so a large-but-allowed diff stays cheap.
 *   - Lines are compared by exact string equality (interned to small integer
 *     ids first, so the inner loops compare numbers, not strings).
 *   - Huge inputs are guarded: if either side exceeds `maxLines` (default
 *     ~4000) we skip the quadratic diff entirely and return a single coarse
 *     `ctx` summary row computed in O(n) — never a hang.
 *
 * Pure util: no `lit` import, no DOM, no third-party deps — safe to import
 * from anywhere (browser or node self-test).
 */

export type CdzDiffType = 'add' | 'del' | 'ctx';

export interface CdzDiffRow {
  type: CdzDiffType;
  text: string;
  /** 1-based line number in the OLD text (set for `del` and `ctx`). */
  oldLine?: number;
  /** 1-based line number in the NEW text (set for `add` and `ctx`). */
  newLine?: number;
}

/** Default upper bound on line count before falling back to a coarse summary. */
const DEFAULT_MAX_LINES = 4000;

/**
 * Split a string into lines without inventing a trailing empty line for input
 * that does not end in a newline. A trailing `\n` DOES yield a final empty
 * line (so "a\n" is two rows: "a" and ""), matching how editors count lines
 * and keeping the diff symmetric.
 *
 * `\r\n` and `\r` are normalised to `\n` first so a CRLF/LF mismatch alone
 * does not surface as spurious add/del rows.
 */
function splitLines(str: string): string[] {
  if (str === '') return [];
  return str.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Intern two line arrays into parallel `Int32Array`s of small integer ids, so
 * the LCS inner loop compares 32-bit ints instead of strings. Identical lines
 * always map to the same id, which is what makes the result deterministic.
 */
function internLines(
  a: readonly string[],
  b: readonly string[]
): { ea: Int32Array; eb: Int32Array } {
  const ids = new Map<string, number>();
  const encode = (lines: readonly string[]): Int32Array => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      out[i] = id;
    }
    return out;
  };
  return { ea: encode(a), eb: encode(b) };
}

/**
 * One half of Hirschberg: the last row of the LCS-length DP table between
 * `a[a0..a1)` and `b[b0..b1)`. `forward` controls scan direction so the caller
 * can align a forward pass with a reversed pass. Uses two rolling rows only.
 */
function lcsLastRow(
  a: Int32Array,
  a0: number,
  a1: number,
  b: Int32Array,
  b0: number,
  b1: number,
  forward: boolean
): Int32Array {
  const bLen = b1 - b0;
  let prev = new Int32Array(bLen + 1);
  let curr = new Int32Array(bLen + 1);
  const aLen = a1 - a0;
  for (let i = 1; i <= aLen; i++) {
    const av = forward ? a[a0 + i - 1] : a[a1 - i];
    for (let j = 1; j <= bLen; j++) {
      const bv = forward ? b[b0 + j - 1] : b[b1 - j];
      if (av === bv) {
        curr[j] = prev[j - 1] + 1;
      } else {
        const up = prev[j];
        const left = curr[j - 1];
        curr[j] = up >= left ? up : left;
      }
    }
    // swap rolling rows
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev;
}

/**
 * Hirschberg divide-and-conquer: append the LCS of `a[a0..a1) × b[b0..b1)`
 * onto `out` as [aIndex, bIndex] matched pairs (both 0-based, in increasing
 * order). Linear space; the recursion depth is O(log · aLen).
 */
function hirschberg(
  a: Int32Array,
  a0: number,
  a1: number,
  b: Int32Array,
  b0: number,
  b1: number,
  out: Array<[number, number]>
): void {
  const aLen = a1 - a0;
  const bLen = b1 - b0;
  if (aLen === 0 || bLen === 0) return;

  if (aLen === 1) {
    // Match the single a-line against the FIRST equal b-line (leftmost →
    // deterministic and stable).
    const av = a[a0];
    for (let j = b0; j < b1; j++) {
      if (b[j] === av) {
        out.push([a0, j]);
        return;
      }
    }
    return;
  }

  const aMid = a0 + (aLen >> 1);
  // Forward LCS lengths for the top half, reverse LCS lengths for the bottom.
  const scoreL = lcsLastRow(a, a0, aMid, b, b0, b1, true);
  const scoreR = lcsLastRow(a, aMid, a1, b, b0, b1, false);

  // Find the b split point that maximises scoreL[k] + scoreR[bLen - k].
  let best = -1;
  let bestK = 0;
  for (let k = 0; k <= bLen; k++) {
    const total = scoreL[k] + scoreR[bLen - k];
    if (total > best) {
      best = total;
      bestK = k;
    }
  }
  const bMid = b0 + bestK;

  hirschberg(a, a0, aMid, b, b0, bMid, out);
  hirschberg(a, aMid, a1, b, bMid, b1, out);
}

/**
 * Cheap O(n) coarse summary used when input exceeds `maxLines`. We do not run
 * the quadratic diff; instead we report the raw line-count delta so the UI can
 * still show *something* truthful without hanging.
 */
function coarseSummaryRow(
  oldLines: readonly string[],
  newLines: readonly string[]
): CdzDiffRow {
  const removed = oldLines.length;
  const added = newLines.length;
  return {
    type: 'ctx',
    text: `Large change: -${removed} / +${added} lines`,
  };
}

/**
 * Produce a unified line diff of `oldStr` → `newStr`.
 *
 * Returns rows in display order. `del` rows carry a 1-based `oldLine`, `add`
 * rows carry a 1-based `newLine`, and unchanged `ctx` rows carry both.
 *
 * Guard: if either side has more than `opts.maxLines` (default ~4000) lines,
 * the quadratic LCS is skipped and a single coarse `ctx` summary row is
 * returned instead (see {@link coarseSummaryRow}).
 */
export function diffLines(
  oldStr: string,
  newStr: string,
  opts?: { maxLines?: number }
): CdzDiffRow[] {
  const maxLines =
    opts?.maxLines && opts.maxLines > 0 ? opts.maxLines : DEFAULT_MAX_LINES;

  const oldLines = splitLines(oldStr);
  const newLines = splitLines(newStr);

  // Huge-input guard: bail before the O(n·m) work.
  if (oldLines.length > maxLines || newLines.length > maxLines) {
    return [coarseSummaryRow(oldLines, newLines)];
  }

  const rows: CdzDiffRow[] = [];

  // Fast paths (also keep the common "nothing changed" case allocation-light).
  if (oldLines.length === 0 && newLines.length === 0) return rows;
  if (oldLines.length === 0) {
    for (let j = 0; j < newLines.length; j++) {
      rows.push({ type: 'add', text: newLines[j], newLine: j + 1 });
    }
    return rows;
  }
  if (newLines.length === 0) {
    for (let i = 0; i < oldLines.length; i++) {
      rows.push({ type: 'del', text: oldLines[i], oldLine: i + 1 });
    }
    return rows;
  }

  const { ea, eb } = internLines(oldLines, newLines);

  // Compute the LCS as matched (oldIndex, newIndex) pairs, in increasing order.
  const matches: Array<[number, number]> = [];
  hirschberg(ea, 0, ea.length, eb, 0, eb.length, matches);

  // Walk both sequences, emitting del/add for the gaps and ctx for the matches.
  let i = 0; // cursor into oldLines
  let j = 0; // cursor into newLines
  for (let m = 0; m < matches.length; m++) {
    const [ai, bj] = matches[m];
    while (i < ai) {
      rows.push({ type: 'del', text: oldLines[i], oldLine: i + 1 });
      i++;
    }
    while (j < bj) {
      rows.push({ type: 'add', text: newLines[j], newLine: j + 1 });
      j++;
    }
    rows.push({
      type: 'ctx',
      text: oldLines[ai],
      oldLine: ai + 1,
      newLine: bj + 1,
    });
    i = ai + 1;
    j = bj + 1;
  }
  // Trailing tails after the last match.
  while (i < oldLines.length) {
    rows.push({ type: 'del', text: oldLines[i], oldLine: i + 1 });
    i++;
  }
  while (j < newLines.length) {
    rows.push({ type: 'add', text: newLines[j], newLine: j + 1 });
    j++;
  }

  return rows;
}

/**
 * Count added / removed rows produced by {@link diffLines}. `ctx` rows (both
 * unchanged lines and the coarse fallback summary) are ignored, so a
 * summary-only result reports `{ added: 0, removed: 0 }`.
 */
export function diffStats(rows: CdzDiffRow[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.type === 'add') added++;
    else if (row.type === 'del') removed++;
  }
  return { added, removed };
}
