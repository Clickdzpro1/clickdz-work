import { type CSSProperties, useCallback, useState } from 'react';

// ---------------------------------------------------------------------------
// OpenClaw workspace — PreviewPanel
//
// A live iframe preview of the user's generated app running in the sandbox
// (served from a vercel.run subdomain). The toolbar shows the read-only URL, a
// Refresh button (reloads the iframe by bumping its React key), and an
// Open-in-new-tab link. While status === 'starting' a spinner overlays the
// frame; with no url an empty state invites the user to run a dev server.
//
// The iframe is sandboxed but DOES allow scripts — it's the user's own
// generated application, so allow-scripts / allow-forms / allow-popups /
// allow-same-origin are enabled so the app actually runs. (allow-same-origin +
// allow-scripts is acceptable here because the content is a distinct origin the
// user generated, not the AFFiNE app origin.)
//
// Self-contained: inline styles only, no icon imports, prefers-reduced-motion
// safe, no data fetching (state arrives via props).
// ---------------------------------------------------------------------------

const monoFamily =
  'var(--affine-font-code-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';

// App-consistent palette (theme vars + dark fallbacks), plus a fixed light
// frame background so a not-yet-painted app doesn't flash black.
const C = {
  panel: 'var(--affine-background-secondary-color, #1c1c1e)',
  border: 'var(--affine-border-color, #2a2a2c)',
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  toolbarBg: '#161b22',
  toolbarBorder: '#22272e',
  urlBg: '#0d1117',
  urlText: '#e6edf3',
  frameBg: '#ffffff',
} as const;

const btnStyle: CSSProperties = {
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontFamily: monoFamily,
  fontSize: 11,
  fontWeight: 600,
  padding: '4px 10px',
  // Touch target: the chip stays compact but the hit area grows toward a
  // comfortable 34px (trivial min-height, no restructuring).
  minHeight: 34,
  borderRadius: 6,
  border: '1px solid #30363d',
  background: '#21262d',
  color: '#c9d1d9',
  cursor: 'pointer',
  textDecoration: 'none',
  flexShrink: 0,
  lineHeight: 1.2,
};

export function PreviewPanel({
  url,
  status,
  onRefresh,
}: {
  url?: string;
  status?: 'starting' | 'ready';
  onRefresh?: () => void;
}) {
  // Bumping this key remounts the iframe → a hard reload of the preview.
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    setNonce(n => n + 1);
    onRefresh?.();
  }, [onRefresh]);

  const hasUrl = typeof url === 'string' && url.trim().length > 0;
  const starting = status === 'starting';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        borderRadius: 10,
        overflow: 'hidden',
        border: `1px solid ${C.border}`,
        background: C.panel,
      }}
    >
      {/* Toolbar — wraps onto a second row on very narrow screens rather than
          clipping the Open-in-new-tab link or squashing the URL field to
          nothing. */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          rowGap: 6,
          gap: 8,
          padding: '8px 10px',
          background: C.toolbarBg,
          borderBottom: `1px solid ${C.toolbarBorder}`,
        }}
      >
        <button
          type="button"
          onClick={refresh}
          disabled={!hasUrl}
          title="Reload preview"
          style={{
            ...btnStyle,
            opacity: hasUrl ? 1 : 0.5,
            cursor: hasUrl ? 'pointer' : 'default',
          }}
        >
          <span aria-hidden>↻</span> Refresh
        </button>

        {/* Read-only URL field */}
        <div
          style={{
            flex: '1 1 160px',
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 6,
            background: C.urlBg,
            border: `1px solid ${C.toolbarBorder}`,
          }}
        >
          <span
            aria-hidden
            style={{
              fontSize: 10,
              color: starting ? '#e8a33d' : hasUrl ? '#4cae4c' : C.muted,
            }}
          >
            ●
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: monoFamily,
              fontSize: 11.5,
              color: hasUrl ? C.urlText : C.muted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={hasUrl ? url : undefined}
          >
            {hasUrl ? url : 'no preview url'}
          </span>
        </div>

        <a
          href={hasUrl ? url : undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!hasUrl}
          title="Open in new tab"
          onClick={e => {
            if (!hasUrl) e.preventDefault();
          }}
          style={{
            ...btnStyle,
            opacity: hasUrl ? 1 : 0.5,
            cursor: hasUrl ? 'pointer' : 'default',
          }}
        >
          Open <span aria-hidden>↗</span>
        </a>
      </div>

      {/* Body */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          background: hasUrl ? C.frameBg : C.panel,
        }}
      >
        {hasUrl ? (
          <iframe
            key={nonce}
            src={url}
            title="App preview"
            // The user's own generated app — allow it to actually run, but keep
            // it sandboxed to its own (distinct) origin.
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-same-origin allow-downloads"
            allow="clipboard-write; fullscreen"
            referrerPolicy="no-referrer"
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              border: 'none',
              background: C.frameBg,
            }}
          />
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: 24,
              color: C.muted,
              textAlign: 'center',
            }}
          >
            <span aria-hidden style={{ fontSize: 28, opacity: 0.6 }}>
              🖥️
            </span>
            <span style={{ fontSize: 13, color: C.text }}>
              No live preview
            </span>
            <span style={{ fontSize: 12, maxWidth: 320 }}>
              Run a dev server to see a live preview
            </span>
          </div>
        )}

        {/* Starting overlay */}
        {hasUrl && starting ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              background: 'rgba(13,17,23,0.82)',
              backdropFilter: 'blur(1px)',
              color: '#e6edf3',
            }}
          >
            <span
              className="cdz-openclaw-preview-spin"
              aria-hidden
              style={{
                width: 26,
                height: 26,
                borderRadius: '50%',
                border: '2.5px solid rgba(255,255,255,0.18)',
                borderTopColor: C.accent,
                display: 'inline-block',
              }}
            />
            <span style={{ fontSize: 12.5 }}>Starting dev server…</span>
          </div>
        ) : null}
      </div>

      <style>
        {`
@keyframes cdz-openclaw-preview-spin{to{transform:rotate(360deg)}}
.cdz-openclaw-preview-spin{animation:cdz-openclaw-preview-spin .8s linear infinite}
@media (prefers-reduced-motion: reduce){.cdz-openclaw-preview-spin{animation-duration:2.4s}}
`}
      </style>
    </div>
  );
}
