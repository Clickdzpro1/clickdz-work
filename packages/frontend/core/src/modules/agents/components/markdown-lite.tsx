// markdown-lite — a deliberately tiny, safe subset renderer for assistant
// answers. Builds React nodes directly (NO dangerouslySetInnerHTML), so it is
// XSS-safe by construction: any HTML in the model output is rendered as literal
// text. Supports: fenced ``` code blocks, `inline code`, **bold**, *italic*,
// [text](url) links (http/https/mailto only), and paragraph/line breaks.
// Anything unrecognised falls through as plain text.

import { memo, type ReactNode, useMemo } from 'react';

import { AgentPalette as P } from './palette';

const SAFE_URL_RE = /^(https?:|mailto:)/i;

// Inline pass: split a single line into bold/italic/code/link spans.
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Combined tokenizer. Order matters: code first (so ** inside code is inert).
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          style={{
            fontFamily: P.font.mono,
            fontSize: '0.9em',
            padding: '1px 5px',
            borderRadius: P.radius.xs,
            background: P.color.accentSoft,
            border: `1px solid ${P.color.border}`,
          }}
        >
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith('**')) {
      nodes.push(
        <strong key={key} style={{ fontWeight: 700 }}>
          {tok.slice(2, -2)}
        </strong>
      );
    } else if (tok.startsWith('*')) {
      nodes.push(
        <em key={key} style={{ fontStyle: 'italic' }}>
          {tok.slice(1, -1)}
        </em>
      );
    } else {
      // [label](url)
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (mm && SAFE_URL_RE.test(mm[2])) {
        nodes.push(
          <a
            key={key}
            href={mm[2]}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: P.color.accent, textDecoration: 'underline' }}
          >
            {mm[1]}
          </a>
        );
      } else {
        nodes.push(mm ? mm[1] : tok);
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * MEMOISED ON PURPOSE — this component was the streaming lag.
 *
 * It reparses the whole answer (split on fences, regex-tokenise every inline
 * span, rebuild the entire ReactNode tree) on every single render, and it was a
 * plain unmemoised function component. Two compounding costs followed:
 *
 *  1. While an answer streams, `text` grows by a token per render, so the total
 *     parse work over one answer is quadratic in its final length. Long answers
 *     visibly stuttered near the end.
 *  2. Worse, EVERY unrelated re-render of a chat surface reparsed EVERY message
 *     in the transcript. The reasoning ticker alone swaps its line every 1.8-3s,
 *     so an idle conversation with N settled answers was doing N full markdown
 *     parses several times a minute for no reason at all.
 *
 * memo() fixes (2) outright: settled messages keep their text identity, so they
 * never reparse again. useMemo fixes the repeat-render case for identical text
 * within a single instance. (1) is inherent to re-rendering on each token and
 * would need coalescing in the stream hook, but with (2) gone the per-token cost
 * is now paid by the one streaming message instead of the whole transcript.
 */
function MarkdownLiteImpl({ text }: { text: string }) {
  const rendered = useMemo(() => buildMarkdownNodes(text), [text]);
  return rendered;
}

export const MarkdownLite = memo(MarkdownLiteImpl);

function buildMarkdownNodes(text: string) {
  if (!text) return null;
  const blocks: ReactNode[] = [];
  // Split into fenced code blocks vs prose.
  const parts = text.split(/```/);
  parts.forEach((part, idx) => {
    const isCode = idx % 2 === 1;
    if (isCode) {
      // First line may be a language hint — drop it from the display body.
      const nl = part.indexOf('\n');
      const body = nl >= 0 ? part.slice(nl + 1) : part;
      blocks.push(
        <pre
          key={`c-${idx}`}
          style={{
            margin: '8px 0',
            padding: '10px 12px',
            borderRadius: P.radius.sm,
            background: P.color.consoleBg,
            border: `1px solid ${P.color.consoleBorder}`,
            color: P.color.consoleText,
            fontFamily: P.font.mono,
            fontSize: P.font.size.md,
            lineHeight: 1.5,
            overflowX: 'auto',
            whiteSpace: 'pre',
          }}
        >
          {body.replace(/\n$/, '')}
        </pre>
      );
      return;
    }
    if (!part) return;
    // Prose: paragraphs separated by blank lines; single newlines → <br/>.
    part.split(/\n{2,}/).forEach((para, pIdx) => {
      const trimmed = para.replace(/^\n+|\n+$/g, '');
      if (!trimmed) return;
      const lines = trimmed.split('\n');
      blocks.push(
        <p
          key={`p-${idx}-${pIdx}`}
          style={{
            margin: '0 0 8px',
            fontSize: P.font.size.lg,
            lineHeight: 1.6,
            color: P.color.text,
            whiteSpace: 'normal',
            wordBreak: 'break-word',
          }}
        >
          {lines.map((line, lIdx) => (
            <span key={lIdx}>
              {renderInline(line, `${idx}-${pIdx}-${lIdx}`)}
              {lIdx < lines.length - 1 ? <br /> : null}
            </span>
          ))}
        </p>
      );
    });
  });
  return <div style={{ display: 'flow-root' }}>{blocks}</div>;
}
