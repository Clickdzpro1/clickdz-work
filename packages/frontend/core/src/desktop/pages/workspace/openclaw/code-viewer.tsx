import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useState,
} from 'react';

import { CodeBlock } from './code-block';

// ---------------------------------------------------------------------------
// OpenClaw workspace — CodeViewer
//
// A read-only single-file viewer. The header shows the file path + a Copy
// button; the body reuses the existing shiki-backed `CodeBlock` from
// ./code-block for syntax highlighting (CodeBlock already renders a plain <pre>
// fallback internally until shiki resolves, and never throws on wasm failure).
//
// `filename` is passed straight to CodeBlock so its own header also shows the
// path; we surface a top-level path header + Copy here to match the workspace
// panel chrome and to give a Copy affordance even before CodeBlock mounts /
// while the loading skeleton is showing.
//
// Self-contained: inline styles only, no icon imports, prefers-reduced-motion
// safe, no data fetching (content arrives via props).
// ---------------------------------------------------------------------------

const monoFamily =
  'var(--affine-font-code-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';

// Fixed console palette (dark in both app themes), matching code-block.tsx so
// the viewer header sits flush with the highlighted body below it.
const K = {
  bg: '#0d1117',
  headerBg: '#161b22',
  border: '#22272e',
  text: '#e6edf3',
  muted: '#8b949e',
  btnBg: '#21262d',
  btnBorder: '#30363d',
  btnText: '#c9d1d9',
} as const;

// Derive a display language from an explicit language prop or the file
// extension (purely cosmetic; CodeBlock resolves its own shiki grammar).
function extLanguage(path?: string): string | undefined {
  if (!path) return undefined;
  const base = path.split('/').pop() || path;
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return ext || undefined;
}

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

const copyBtnStyle: CSSProperties = {
  appearance: 'none',
  fontFamily: monoFamily,
  fontSize: 11,
  fontWeight: 600,
  padding: '3px 10px',
  borderRadius: 6,
  border: `1px solid ${K.btnBorder}`,
  background: K.btnBg,
  color: K.btnText,
  cursor: 'pointer',
  flexShrink: 0,
};

const SkeletonBar = ({ width }: { width: string | number }) => (
  <div
    className="cdz-openclaw-skel"
    style={{
      height: 11,
      width,
      borderRadius: 4,
      background:
        'linear-gradient(90deg, #1b2028 25%, #262c36 37%, #1b2028 63%)',
      backgroundSize: '400% 100%',
    }}
  />
);

export function CodeViewer({
  path,
  content,
  language,
  loading,
}: {
  path?: string;
  content?: string;
  language?: string;
  loading?: boolean;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle'
  );
  const lang = language || extLanguage(path);

  const copy = useCallback(() => {
    (async () => {
      try {
        if (!navigator.clipboard || !content) throw new Error('no clipboard');
        await navigator.clipboard.writeText(content);
        setCopyState('copied');
      } catch {
        setCopyState('failed');
      }
      window.setTimeout(() => setCopyState('idle'), 1600);
    })().catch(() => {});
  }, [content]);

  const shell = (children: ReactNode) => (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        borderRadius: 10,
        overflow: 'hidden',
        border: `1px solid ${K.border}`,
        background: K.bg,
      }}
    >
      {children}
      <style>
        {`
@keyframes cdz-openclaw-skel{0%{background-position:100% 0}100%{background-position:0 0}}
.cdz-openclaw-skel{animation:cdz-openclaw-skel 1.3s ease infinite}
@media (prefers-reduced-motion: reduce){.cdz-openclaw-skel{animation:none}}
`}
      </style>
    </div>
  );

  // Empty state: no file selected.
  if (!loading && !path && !content) {
    return shell(
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: 24,
          color: K.muted,
          textAlign: 'center',
        }}
      >
        <span aria-hidden style={{ fontSize: 26, opacity: 0.6 }}>
          📄
        </span>
        <span style={{ fontSize: 12.5 }}>Select a file to view</span>
      </div>
    );
  }

  const header = (
    <div style={headerStyle}>
      <span aria-hidden style={{ fontSize: 12, flexShrink: 0 }}>
        📄
      </span>
      <span style={pathStyle} title={path || ''}>
        {/* bdi keeps the RTL-truncated path readable left-to-right */}
        <bdi>{path || 'untitled'}</bdi>
      </span>
      <button
        type="button"
        onClick={copy}
        disabled={loading || !content}
        style={{
          ...copyBtnStyle,
          opacity: loading || !content ? 0.5 : 1,
          cursor: loading || !content ? 'default' : 'pointer',
        }}
      >
        {copyState === 'copied'
          ? 'Copied'
          : copyState === 'failed'
            ? 'Copy failed'
            : 'Copy'}
      </button>
    </div>
  );

  // Loading skeleton (path header stays, body becomes shimmering bars).
  if (loading) {
    return shell(
      <>
        {header}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            padding: '16px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {['70%', '92%', '48%', '84%', '60%', '76%', '40%', '88%'].map(
            (w, i) => (
              <SkeletonBar key={i} width={w} />
            )
          )}
        </div>
      </>
    );
  }

  // Loaded: header + the shiki CodeBlock (its own <pre> fallback + Copy live
  // inside; we scroll it within the panel). CodeBlock is keyed on the path so
  // switching files remounts the highlighter cleanly.
  return shell(
    <>
      {header}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <CodeBlock
          key={path || 'file'}
          code={content ?? ''}
          language={lang}
          filename={path}
        />
      </div>
    </>
  );
}
