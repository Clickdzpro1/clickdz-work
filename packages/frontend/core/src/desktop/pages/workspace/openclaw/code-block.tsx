import { type CSSProperties, useCallback, useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// OpenClaw code display — a read-only, console-styled code card.
//
// Highlighting: shiki (already in package.json, ^3.19.0) loaded via a DYNAMIC
// import inside an effect, so a shiki/wasm failure can never break page mount:
// until (or unless) highlighting succeeds we render a clean monospace <pre>
// with the exact same metrics, and simply swap in the highlighted HTML.
// shiki escapes the code content itself, so dangerouslySetInnerHTML is safe.
// No new .css.ts (inline styles + one scoped <style> tag, per house rules).
//
// WS12 upgrade (CLAWF2): the streaming console reuses this component inside the
// workspace CodeViewer panel, where the code area should fill the panel rather
// than cap at 420px. Two small ADDITIVE props keep every existing caller
// unchanged: `maxHeight` (override the 420px body cap; 'none' = fill) and
// `dense` (a tighter header + no rounded corners for a flush panel fit). The
// shiki dynamic-import boot-safety is untouched — this is still the one and
// only code highlighter, and it still can never break page mount.
// ---------------------------------------------------------------------------

// Languages we allow through to shiki. Anything else falls back to plaintext
// ('text' is shiki's built-in plain language, always available).
const LANG_ALIASES: Record<string, string> = {
  javascript: 'javascript',
  js: 'javascript',
  jsx: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'typescript',
  python: 'python',
  py: 'python',
  python3: 'python',
  json: 'json',
  jsonc: 'json',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  html: 'html',
  css: 'css',
  md: 'markdown',
  markdown: 'markdown',
  text: 'text',
  txt: 'text',
  plaintext: 'text',
};

export function resolveShikiLang(language?: string): string {
  const key = (language ?? '').toLowerCase().trim();
  return LANG_ALIASES[key] ?? 'text';
}

// Map a filename extension → a shiki language, so a file opened in the viewer
// highlights even when the backend didn't tag a language on the `file` event.
export function languageFromPath(path?: string): string | undefined {
  if (!path) return undefined;
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return LANG_ALIASES[ext];
}

// Don't feed pathological payloads to the highlighter.
const MAX_HIGHLIGHT_CHARS = 100_000;

// Fixed console palette (deliberately dark in both app themes — this is a
// terminal-style surface, like code blocks in docs sites).
const K = {
  bg: '#0d1117',
  headerBg: '#161b22',
  border: '#22272e',
  text: '#e6edf3',
  muted: '#8b949e',
  amber: '#e8a33d',
} as const;

const monoFamily =
  'var(--affine-font-code-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';

export const CodeBlock = ({
  code,
  language,
  filename,
  notExecuted,
  maxHeight,
  dense,
}: {
  code: string;
  language?: string;
  filename?: string;
  notExecuted?: boolean;
  /** Override the default 420px body cap. A number = px; 'none' = fill parent. */
  maxHeight?: number | 'none';
  /** Flush panel fit: square corners + tighter header (for the workspace panel). */
  dense?: boolean;
}) => {
  const [html, setHtml] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle'
  );
  const lang = resolveShikiLang(language);

  // Resolve the body height cap once so the plain <pre> fallback and the shiki
  // HTML share identical metrics (no layout jump when highlighting swaps in).
  const bodyMaxHeight: number | string =
    maxHeight === 'none' ? 'none' : (maxHeight ?? 420);

  const plainPreStyle: CSSProperties = {
    margin: 0,
    padding: '14px 16px',
    overflow: 'auto',
    maxHeight: bodyMaxHeight,
    height: maxHeight === 'none' ? '100%' : undefined,
    boxSizing: 'border-box',
    fontFamily: monoFamily,
    fontSize: 12.5,
    lineHeight: 1.65,
    color: K.text,
    whiteSpace: 'pre',
  };

  useEffect(() => {
    let alive = true;
    setHtml(null);
    if (!code || code.length > MAX_HIGHLIGHT_CHARS) return;
    (async () => {
      try {
        const shiki = await import('shiki');
        let out: string;
        try {
          out = await shiki.codeToHtml(code, { lang, theme: 'github-dark' });
        } catch {
          // Unknown language grammar → plaintext, same theme.
          out = await shiki.codeToHtml(code, {
            lang: 'text',
            theme: 'github-dark',
          });
        }
        if (alive) setHtml(out);
      } catch {
        // shiki failed to load — the plain <pre> fallback stays. Never throw.
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, lang]);

  const copy = useCallback(() => {
    (async () => {
      try {
        if (!navigator.clipboard) throw new Error('no clipboard');
        await navigator.clipboard.writeText(code);
        setCopyState('copied');
      } catch {
        setCopyState('failed');
      }
      window.setTimeout(() => setCopyState('idle'), 1600);
    })().catch(() => {});
  }, [code]);

  // A stable class hook so the scoped <style> can size the shiki <pre> to match
  // the same body cap the plain fallback uses (via CSS custom property).
  const shikiVars = {
    // CSS var consumed by the scoped rule below.
    ['--cdz-code-max' as any]:
      bodyMaxHeight === 'none' ? 'none' : `${bodyMaxHeight}px`,
    ['--cdz-code-h' as any]: maxHeight === 'none' ? '100%' : 'auto',
  } as CSSProperties;

  return (
    <div
      style={{
        borderRadius: dense ? 0 : 10,
        overflow: 'hidden',
        border: dense ? 'none' : `1px solid ${K.border}`,
        background: K.bg,
        display: 'flex',
        flexDirection: 'column',
        height: maxHeight === 'none' ? '100%' : undefined,
        minHeight: 0,
      }}
    >
      {/* Card header: language + optional filename / not-executed badge + Copy */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: dense ? '6px 12px' : '8px 12px',
          background: K.headerBg,
          borderBottom: `1px solid ${K.border}`,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: monoFamily,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: K.muted,
          }}
        >
          {lang}
        </span>
        {filename ? (
          <span
            style={{
              fontFamily: monoFamily,
              fontSize: 11,
              color: K.muted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={filename}
          >
            {filename}
          </span>
        ) : null}
        {notExecuted ? (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              padding: '1px 8px',
              borderRadius: 999,
              color: K.amber,
              background: 'color-mix(in srgb, #e8a33d 14%, transparent)',
            }}
          >
            Generated (not executed)
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={copy}
          style={{
            appearance: 'none',
            fontFamily: monoFamily,
            fontSize: 11,
            fontWeight: 600,
            padding: '3px 10px',
            borderRadius: 6,
            border: '1px solid #30363d',
            background: '#21262d',
            color: '#c9d1d9',
            cursor: 'pointer',
          }}
        >
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Copy failed'
              : 'Copy'}
        </button>
      </div>

      {/* Body: highlighted HTML once shiki resolves, plain <pre> otherwise. */}
      {html ? (
        <div
          className="cdz-openclaw-shiki cdz-openclaw-codefade"
          style={{
            ...shikiVars,
            flex: maxHeight === 'none' ? 1 : undefined,
            minHeight: 0,
            overflow: 'auto',
          }}
          // shiki output: escaped code wrapped in <pre>/<span> tokens only.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre style={plainPreStyle}>{code}</pre>
      )}

      <style>
        {`
.cdz-openclaw-shiki pre{margin:0;padding:14px 16px;background:transparent !important;overflow:auto;max-height:var(--cdz-code-max, 420px);height:var(--cdz-code-h, auto);box-sizing:border-box;font-family:${'var(--affine-font-code-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)'};font-size:12.5px;line-height:1.65;}
.cdz-openclaw-shiki code{font-family:inherit;background:transparent;}
@keyframes cdz-openclaw-codefade{from{opacity:0}to{opacity:1}}
.cdz-openclaw-codefade{animation:cdz-openclaw-codefade .18s ease both}
@media (prefers-reduced-motion: reduce){.cdz-openclaw-codefade{animation:none}}
`}
      </style>
    </div>
  );
};
