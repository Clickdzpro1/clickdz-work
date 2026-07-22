import { type CSSProperties, useMemo } from 'react';

// ---------------------------------------------------------------------------
// OpenClaw workspace — DiffView (R11 / WS11-7, INVERSION)
//
// The "code-review diff moment" from the OpenClaw identity: when the agent
// rewrites an EXISTING file, the workspace hero shows a red/green UNIFIED diff
// (old → new) before the change is adopted, with Appliquer / Rejeter — the
// engineer reviews the patch. OpenClaw's equivalent of Hermes' approval inbox.
//
// Pure presentational: props in, styled diff out. NO data fetching, NO app
// state, NO external deps — the line diff is computed inline (a compact LCS
// over the two line arrays, then a linear back-walk into +/-/context rows).
// Inline styles only (house rule); fixed dark console palette matching
// code-viewer.tsx / code-block.tsx so it sits flush in the workspace panel.
// Motion-free (nothing animates), so it is prefers-reduced-motion safe by
// construction.
// ---------------------------------------------------------------------------

const monoFamily =
  'var(--affine-font-code-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';

// Fixed console palette (dark in both app themes), matching code-viewer.tsx so
// the diff header sits flush with the highlighted body idiom used elsewhere in
// the workspace hero. Add/del tints are github-dark-ish so the red/green reads
// like a real code review, not a SaaS toast.
const K = {
  bg: '#0d1117',
  headerBg: '#161b22',
  border: '#22272e',
  text: '#e6edf3',
  muted: '#8b949e',
  // gutter / line-number column
  gutterText: '#6e7681',
  // added / removed line beds + inks
  addBg: 'rgba(46, 160, 67, 0.15)',
  addSign: '#3fb950',
  addText: '#aff5b4',
  delBg: 'rgba(248, 81, 73, 0.15)',
  delSign: '#f85149',
  delText: '#ffdcd7',
  // context (unchanged) line ink
  ctxText: '#8b949e',
  // buttons
  applyBg: '#238636',
  applyBorder: '#2ea043',
  applyText: '#ffffff',
  rejectBg: '#21262d',
  rejectBorder: '#30363d',
  rejectText: '#c9d1d9',
} as const;

// A single rendered diff row.
type DiffOp = 'ctx' | 'add' | 'del';
interface DiffRow {
  op: DiffOp;
  // line numbers in the old / new file (null when the row doesn't exist there)
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

// Split into lines WITHOUT a trailing empty element for a final newline, so a
// file that ends in "\n" doesn't render a phantom blank last line.
function splitLines(src: string): string[] {
  const s = src ?? '';
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Compute a line-level diff via LCS (Longest Common Subsequence). Classic DP
// table over the two line arrays, then a back-walk emitting context / add / del
// rows in file order. O(n·m) time/space — fine for the file sizes OpenClaw
// writes; guarded so pathologically huge inputs fall back to a plain
// del-all/add-all (still correct, just not minimal).
function computeDiff(oldText: string, newText: string): DiffRow[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;

  // Guard: skip the O(n·m) table for very large pairs; emit a coarse diff.
  if (n * m > 4_000_000) {
    const rows: DiffRow[] = [];
    for (let i = 0; i < n; i++)
      rows.push({ op: 'del', oldNo: i + 1, newNo: null, text: a[i] });
    for (let j = 0; j < m; j++)
      rows.push({ op: 'add', oldNo: null, newNo: j + 1, text: b[j] });
    return rows;
  }

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ op: 'ctx', oldNo: i + 1, newNo: j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ op: 'del', oldNo: i + 1, newNo: null, text: a[i] });
      i++;
    } else {
      rows.push({ op: 'add', oldNo: null, newNo: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < n) {
    rows.push({ op: 'del', oldNo: i + 1, newNo: null, text: a[i] });
    i++;
  }
  while (j < m) {
    rows.push({ op: 'add', oldNo: null, newNo: j + 1, text: b[j] });
    j++;
  }
  return rows;
}

const shellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  borderRadius: 10,
  overflow: 'hidden',
  border: `1px solid ${K.border}`,
  background: K.bg,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexShrink: 0,
  padding: '8px 12px',
  background: K.headerBg,
  borderBottom: `1px solid ${K.border}`,
};

const pathStyle: CSSProperties = {
  flex: 1,
  fontFamily: monoFamily,
  fontSize: 12,
  color: K.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  direction: 'rtl', // keep the filename (end of path) visible when truncated
  textAlign: 'left',
};

const statChipStyle: CSSProperties = {
  fontFamily: monoFamily,
  fontSize: 11,
  fontWeight: 700,
  flexShrink: 0,
  display: 'inline-flex',
  gap: 8,
  alignItems: 'center',
};

const btnBaseStyle: CSSProperties = {
  appearance: 'none',
  fontFamily: monoFamily,
  fontSize: 11.5,
  fontWeight: 600,
  padding: '4px 12px',
  borderRadius: 6,
  cursor: 'pointer',
  flexShrink: 0,
};

const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  flexShrink: 0,
  padding: '8px 12px',
  background: K.headerBg,
  borderTop: `1px solid ${K.border}`,
};

const gutterCellStyle: CSSProperties = {
  userSelect: 'none',
  width: 76,
  minWidth: 76,
  boxSizing: 'border-box',
  padding: '0 8px',
  textAlign: 'right',
  fontFamily: monoFamily,
  fontSize: 11,
  lineHeight: '18px',
  color: K.gutterText,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

// ---------------------------------------------------------------------------
// DiffView — old vs new, unified red/green, with Appliquer / Rejeter.
//
// Props (the exact contract the OpenClaw console mounts against):
//   old:       previous file content (the tree's known version)
//   new:       incoming content the agent wrote (fetched from the sandbox)
//   path:      the file path (header title)
//   onApply:   adopt the new version (console closes the diff, shows new)
//   onReject:  discard the review (console closes the diff, keeps old view)
//   busy?:     optional — disables the buttons while the parent is working
// ---------------------------------------------------------------------------
export function DiffView({
  old,
  new: next,
  path,
  onApply,
  onReject,
  busy,
}: {
  old: string;
  new: string;
  path: string;
  onApply: () => void;
  onReject: () => void;
  busy?: boolean;
}) {
  const rows = useMemo(() => computeDiff(old ?? '', next ?? ''), [old, next]);
  const added = useMemo(() => rows.filter(r => r.op === 'add').length, [rows]);
  const removed = useMemo(
    () => rows.filter(r => r.op === 'del').length,
    [rows]
  );

  return (
    <div style={shellStyle}>
      <div style={headerStyle}>
        <span aria-hidden style={{ fontSize: 12, flexShrink: 0 }}>
          ±
        </span>
        <span style={pathStyle} title={path || ''}>
          <bdi>{path || 'untitled'}</bdi>
        </span>
        <span style={statChipStyle} aria-label={`${added} ajouts, ${removed} suppressions`}>
          <span style={{ color: K.addSign }}>+{added}</span>
          <span style={{ color: K.delSign }}>-{removed}</span>
        </span>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          background: K.bg,
          padding: '6px 0',
        }}
      >
        {rows.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              color: K.muted,
              fontFamily: monoFamily,
              fontSize: 12.5,
            }}
          >
            Aucun changement.
          </div>
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontFamily: monoFamily,
              fontSize: 12,
              lineHeight: '18px',
            }}
          >
            <tbody>
              {rows.map((r, idx) => {
                const bg =
                  r.op === 'add'
                    ? K.addBg
                    : r.op === 'del'
                      ? K.delBg
                      : 'transparent';
                const sign =
                  r.op === 'add' ? '+' : r.op === 'del' ? '-' : ' ';
                const signColor =
                  r.op === 'add'
                    ? K.addSign
                    : r.op === 'del'
                      ? K.delSign
                      : K.gutterText;
                const textColor =
                  r.op === 'add'
                    ? K.addText
                    : r.op === 'del'
                      ? K.delText
                      : K.ctxText;
                return (
                  <tr key={idx} style={{ background: bg }}>
                    <td style={gutterCellStyle}>
                      {r.oldNo ?? ''}
                    </td>
                    <td style={gutterCellStyle}>
                      {r.newNo ?? ''}
                    </td>
                    <td
                      style={{
                        width: 18,
                        minWidth: 18,
                        textAlign: 'center',
                        color: signColor,
                        userSelect: 'none',
                        fontWeight: 700,
                        lineHeight: '18px',
                      }}
                    >
                      {sign}
                    </td>
                    <td
                      style={{
                        padding: '0 12px 0 4px',
                        color: textColor,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        lineHeight: '18px',
                      }}
                    >
                      {r.text === '' ? ' ' : r.text}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div style={footerStyle}>
        <button
          type="button"
          onClick={onReject}
          disabled={busy}
          style={{
            ...btnBaseStyle,
            background: K.rejectBg,
            border: `1px solid ${K.rejectBorder}`,
            color: K.rejectText,
            opacity: busy ? 0.5 : 1,
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          Rejeter
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={busy}
          style={{
            ...btnBaseStyle,
            background: K.applyBg,
            border: `1px solid ${K.applyBorder}`,
            color: K.applyText,
            opacity: busy ? 0.5 : 1,
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          Appliquer
        </button>
      </div>
    </div>
  );
}
