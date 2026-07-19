import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// OpenClaw workspace — Terminal
//
// A live console that renders streamed stdout/stderr lines. stderr is tinted a
// distinct color; the surface is a fixed dark console (like code-block.tsx).
// Autoscrolls to the bottom as new lines arrive UNLESS the user has scrolled
// up (in which case a "jump to latest" affordance appears). ANSI escape codes
// are stripped with a simple regex. Render is capped to ~2000 lines so a very
// chatty build can't blow up the DOM.
//
// Self-contained: inline styles only, no icon imports, prefers-reduced-motion
// safe, no data fetching (lines arrive via props).
// ---------------------------------------------------------------------------

const monoFamily =
  'var(--affine-font-code-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';

// Fixed terminal palette (dark in both app themes), matching the OpenClaw
// page's console surfaces.
const K = {
  bg: '#0d1117',
  headerBg: '#161b22',
  border: '#22272e',
  text: '#e6edf3',
  muted: '#8b949e',
  stderr: '#ffa198',
  accent: '#79c0ff',
} as const;

export interface TerminalLine {
  stream: 'stdout' | 'stderr';
  data: string;
}

const MAX_RENDER_LINES = 2000;

// Strip ANSI CSI / SGR sequences (colors, cursor moves) — control chars in the
// ESC [ ... m family plus a few common single-char escapes. Kept simple &
// defensive; we render plain text only.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]|[()][AB012]|[=>]/g;
function stripAnsi(s: string): string {
  if (!s) return '';
  return s.replace(ANSI_RE, '');
}

const NEAR_BOTTOM_PX = 40;

export function Terminal({ lines }: { lines: TerminalLine[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Whether we should keep pinning to the bottom on new output.
  const [stuck, setStuck] = useState(true);
  const stuckRef = useRef(true);
  stuckRef.current = stuck;

  const safeLines = useMemo<TerminalLine[]>(
    () => (Array.isArray(lines) ? lines : []),
    [lines]
  );
  const total = safeLines.length;

  // Only render the tail; earlier output is summarised by a header note.
  const visible = useMemo(() => {
    const start = Math.max(0, total - MAX_RENDER_LINES);
    return safeLines.slice(start).map(l => ({
      stream: l?.stream === 'stderr' ? 'stderr' : 'stdout',
      text: stripAnsi(typeof l?.data === 'string' ? l.data : ''),
    }));
  }, [safeLines, total]);
  const truncated = total - visible.length;

  // Track whether the user is near the bottom; if they scroll up we stop
  // pinning until they return to the bottom.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStuck(distance <= NEAR_BOTTOM_PX);
  };

  // Autoscroll on new lines when pinned. useLayoutEffect avoids a visible jump.
  useLayoutEffect(() => {
    if (!stuckRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStuck(true);
  };

  // If the list resets to empty, re-pin for the next run.
  useEffect(() => {
    if (total === 0) setStuck(true);
  }, [total]);

  return (
    <div
      style={{
        position: 'relative',
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
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: K.headerBg,
          borderBottom: `1px solid ${K.border}`,
        }}
      >
        <span aria-hidden style={{ fontFamily: monoFamily, color: K.muted }}>
          {'>_'}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: K.muted,
          }}
        >
          Terminal
        </span>
        <span style={{ flex: 1 }} />
        {total > 0 ? (
          <span style={{ fontSize: 11, color: K.muted }}>
            {total} {total === 1 ? 'line' : 'lines'}
          </span>
        ) : null}
      </div>

      {total === 0 ? (
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
          <span aria-hidden style={{ fontSize: 22, opacity: 0.6 }}>
            {'>_'}
          </span>
          <span style={{ fontSize: 12.5 }}>No output yet</span>
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            padding: '10px 14px',
            fontFamily: monoFamily,
            fontSize: 12.5,
            lineHeight: 1.6,
            color: K.text,
          }}
        >
          {truncated > 0 ? (
            <div
              style={{
                color: K.muted,
                fontStyle: 'italic',
                paddingBottom: 6,
                marginBottom: 6,
                borderBottom: `1px dashed ${K.border}`,
              }}
            >
              … {truncated.toLocaleString()} earlier{' '}
              {truncated === 1 ? 'line' : 'lines'} hidden
            </div>
          ) : null}
          {visible.map((l, i) => (
            <div
              key={i}
              style={
                {
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: l.stream === 'stderr' ? K.stderr : K.text,
                } as CSSProperties
              }
            >
              {l.text.length ? l.text : ' '}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {total > 0 && !stuck ? (
        <button
          type="button"
          onClick={jumpToBottom}
          style={{
            position: 'absolute',
            right: 14,
            bottom: 14,
            appearance: 'none',
            fontFamily: monoFamily,
            fontSize: 11,
            fontWeight: 600,
            padding: '4px 10px',
            borderRadius: 999,
            border: `1px solid ${K.border}`,
            background: K.headerBg,
            color: K.accent,
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
          }}
        >
          ↓ Latest
        </button>
      ) : null}
    </div>
  );
}
