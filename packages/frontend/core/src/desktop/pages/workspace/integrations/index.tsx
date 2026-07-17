import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench';
import {
  type CSSProperties,
  type PropsWithChildren,
  useCallback,
  useEffect,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// ClickDz Integrations (Composio) — DARK by default.
//
// The whole surface is gated server-side behind COMPOSIO_API_KEY. This page
// simply reflects what /api/v1/integrations/* reports:
//   • {enabled:false}  -> friendly setup state (ask the owner to set the key)
//   • {enabled:true}   -> toolkit grid with Connect buttons + a ▶ Run section
// It is purely additive: with no key the only visible change in the whole app
// is the sidebar item + this informative page. No new .css.ts (inline styles
// only, per house rules — small new UI prefers inline styles).
// ---------------------------------------------------------------------------

interface CdzToolkit {
  slug: string;
  name: string;
  logo?: string;
}

interface ToolkitsResponse {
  enabled: boolean;
  toolkits: CdzToolkit[];
  error?: string;
}

// One executed orchestrator step, mirrors the backend RunStep shape.
interface RunStep {
  tool: string;
  arguments?: Record<string, unknown>;
  ok: boolean;
  resultPreview: string;
}

interface RunResponse {
  ok: boolean;
  answer: string;
  steps: RunStep[];
  iterations: number;
}

// Max toolkits the orchestrator accepts (mirrors backend RUN_MAX_TOOLKITS).
const RUN_MAX_TOOLKITS = 5;
const RUN_PROMPT_MAX = 4_000;

// Dark, app-consistent palette. Each value is an --affine-* theme var with a
// hard dark fallback so the page reads correctly even before theme vars load.
const C = {
  bg: 'var(--affine-background-primary-color, #141414)',
  panel: 'var(--affine-background-secondary-color, #1c1c1e)',
  border: 'var(--affine-border-color, #2a2a2c)',
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  accentSoft: 'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  warnBg: 'color-mix(in srgb, #e8a33d 12%, transparent)',
  warnBorder: 'color-mix(in srgb, #e8a33d 40%, transparent)',
  errBg: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 12%, transparent)',
  errBorder: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 40%, transparent)',
  okText: 'var(--affine-success-color, #4cae4c)',
} as const;

type LoadState = 'loading' | 'ready' | 'error';

const IntegrationsPage = () => {
  const [state, setState] = useState<LoadState>('loading');
  const [enabled, setEnabled] = useState(false);
  const [toolkits, setToolkits] = useState<CdzToolkit[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  // ---- ▶ Run orchestrator state ----
  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResponse | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setNotice(null);
    try {
      const res = await fetch(cdzApiUrl('/api/v1/integrations/toolkits'), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        setState('error');
        return;
      }
      const data = (await res.json()) as ToolkitsResponse;
      setEnabled(!!data.enabled);
      setToolkits(Array.isArray(data.toolkits) ? data.toolkits : []);
      if (data.error === 'composio_unreachable') {
        setNotice("Couldn't reach Composio right now — try again in a moment.");
      }
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = useCallback(async (slug: string) => {
    setConnecting(slug);
    setNotice(null);
    try {
      const res = await fetch(cdzApiUrl('/api/v1/integrations/connect'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolkit: slug }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        redirectUrl?: string;
        error?: string;
        detail?: string;
      };
      if (res.ok && data.redirectUrl) {
        window.open(data.redirectUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      if (data.error === 'not_configured') {
        setNotice('Integrations are not configured yet — ask the owner to set COMPOSIO_API_KEY.');
      } else {
        setNotice(
          `Could not start the connection${data.detail ? `: ${data.detail}` : ''}. Please try again.`
        );
      }
    } catch {
      setNotice('Could not start the connection. Please try again.');
    } finally {
      setConnecting(null);
    }
  }, []);

  // Toggle a toolkit chip on/off, enforcing the max-5 selection cap.
  const toggleToolkit = useCallback((slug: string) => {
    setSelected(prev => {
      if (prev.includes(slug)) return prev.filter(s => s !== slug);
      if (prev.length >= RUN_MAX_TOOLKITS) return prev;
      return [...prev, slug];
    });
  }, []);

  const run = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      const res = await fetch(cdzApiUrl('/api/v1/integrations/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed, toolkits: selected }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<RunResponse> & {
        error?: string;
      };
      if (res.status === 409 || data.error === 'not_configured') {
        setRunError('Integrations are not configured yet — ask the owner to set COMPOSIO_API_KEY.');
        return;
      }
      if (res.status === 502 || data.error === 'planner_unavailable') {
        setRunError("The integrations agent is unavailable right now. Please try again in a moment.");
        return;
      }
      if (!res.ok || !data.ok) {
        setRunError('The run could not be completed. Please try again.');
        return;
      }
      setResult({
        ok: true,
        answer: typeof data.answer === 'string' ? data.answer : '',
        steps: Array.isArray(data.steps) ? data.steps : [],
        iterations: typeof data.iterations === 'number' ? data.iterations : 0,
      });
    } catch {
      setRunError('Network error while running. Check your connection and try again.');
    } finally {
      setRunning(false);
    }
  }, [prompt, selected, running]);

  const canRun = enabled && state === 'ready' && prompt.trim().length > 0 && !running;

  return (
    <>
      <ViewTitle title="Integrations" />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: '100%',
            padding: '0 16px',
            fontSize: 14,
            fontWeight: 600,
            color: C.text,
          }}
        >
          <span style={{ fontSize: 16 }}>🔌</span>
          Integrations
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '15px',
              padding: '0 6px',
              borderRadius: 5,
              letterSpacing: '0.05em',
              color: C.muted,
              backgroundColor:
                'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 16%, transparent)',
            }}
          >
            béta
          </span>
        </div>
      </ViewHeader>
      <ViewBody>
        <div
          style={{
            height: '100%',
            width: '100%',
            overflow: 'auto',
            background: C.bg,
            color: C.text,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <div
            style={{
              maxWidth: 960,
              margin: '0 auto',
              padding: '28px 24px 48px',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: 24,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: C.text,
                }}
              >
                <span>🔌</span> Integrations
              </h1>
              <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
                Connect ClickDz Work to the tools you already use. Powered by
                Composio.
              </p>
            </header>

            {/* Status banner ------------------------------------------------ */}
            {state === 'loading' ? (
              <Banner tone="info">Loading integrations…</Banner>
            ) : state === 'error' ? (
              <Banner tone="error">
                Couldn&apos;t load integrations.{' '}
                <button style={linkBtnStyle} onClick={() => void load()}>
                  Retry
                </button>
              </Banner>
            ) : !enabled ? (
              <Banner tone="warn">
                <strong>Integrations aren&apos;t set up yet.</strong>
                <br />
                Ask the owner to set <code style={codeStyle}>
                  COMPOSIO_API_KEY
                </code>{' '}
                on the server, then reload this page. Until then this tab stays
                read-only and nothing is connected.
              </Banner>
            ) : (
              <Banner tone="ok">
                Integrations are live. Pick a tool below and press{' '}
                <strong>Connect</strong> to link your account.
              </Banner>
            )}

            {notice ? <Banner tone="info">{notice}</Banner> : null}

            {/* Toolkit grid ------------------------------------------------- */}
            {state === 'ready' && enabled ? (
              toolkits.length > 0 ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      'repeat(auto-fill, minmax(180px, 1fr))',
                    gap: 12,
                  }}
                >
                  {toolkits.map(tk => (
                    <div
                      key={tk.slug}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                        padding: 16,
                        borderRadius: 12,
                        background: C.panel,
                        border: `1px solid ${C.border}`,
                      }}
                    >
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                      >
                        <div
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 8,
                            flexShrink: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: C.accentSoft,
                            overflow: 'hidden',
                            fontSize: 16,
                          }}
                        >
                          {tk.logo ? (
                            <img
                              src={tk.logo}
                              alt=""
                              width={36}
                              height={36}
                              style={{ objectFit: 'contain' }}
                            />
                          ) : (
                            <span>🧩</span>
                          )}
                        </div>
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            color: C.text,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={tk.name}
                        >
                          {tk.name}
                        </span>
                      </div>
                      <button
                        disabled={connecting === tk.slug}
                        onClick={() => void connect(tk.slug)}
                        style={{
                          appearance: 'none',
                          border: 'none',
                          borderRadius: 8,
                          padding: '8px 12px',
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: connecting === tk.slug ? 'default' : 'pointer',
                          color: '#fff',
                          background: C.accent,
                          opacity: connecting === tk.slug ? 0.6 : 1,
                        }}
                      >
                        {connecting === tk.slug ? 'Connecting…' : 'Connect'}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <Banner tone="info">
                  No toolkits are available right now. Once the owner finishes
                  Composio setup they&apos;ll appear here.
                </Banner>
              )
            ) : null}

            {/* ▶ Run orchestrator ------------------------------------------- */}
            <section
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                padding: 18,
                borderRadius: 12,
                background: C.panel,
                border: `1px solid ${C.border}`,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <h2
                  style={{
                    margin: 0,
                    fontSize: 15,
                    fontWeight: 700,
                    color: C.text,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <span>▶</span> Run
                </h2>
                <p style={{ margin: 0, color: C.muted, fontSize: 12 }}>
                  Describe what you want to do; the agent picks and runs the
                  right tools from the toolkits you select below.
                </p>
              </div>

              {!enabled ? (
                <Banner tone="warn">
                  Running is disabled until an owner sets{' '}
                  <code style={codeStyle}>COMPOSIO_API_KEY</code> on the server.
                </Banner>
              ) : null}

              {/* Prompt */}
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value.slice(0, RUN_PROMPT_MAX))}
                disabled={!enabled || running}
                placeholder="e.g. Star the composiohq/composio repo on GitHub"
                rows={3}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  padding: '10px 12px',
                  borderRadius: 8,
                  fontSize: 13,
                  fontFamily: 'inherit',
                  lineHeight: 1.5,
                  color: C.text,
                  background: C.bg,
                  border: `1px solid ${C.border}`,
                  opacity: !enabled ? 0.55 : 1,
                }}
              />

              {/* Toolkit chips (click to toggle, max 5) */}
              {toolkits.length > 0 ? (
                <div
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
                  role="group"
                  aria-label="Toolkits to allow"
                >
                  {toolkits.map(tk => {
                    const on = selected.includes(tk.slug);
                    const capped = !on && selected.length >= RUN_MAX_TOOLKITS;
                    return (
                      <button
                        key={tk.slug}
                        type="button"
                        disabled={!enabled || running || capped}
                        onClick={() => toggleToolkit(tk.slug)}
                        title={
                          capped
                            ? `Up to ${RUN_MAX_TOOLKITS} toolkits`
                            : tk.name
                        }
                        style={{
                          appearance: 'none',
                          cursor:
                            !enabled || running || capped ? 'default' : 'pointer',
                          padding: '5px 12px',
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 600,
                          color: on ? '#fff' : C.text,
                          background: on ? C.accent : 'transparent',
                          border: `1px solid ${on ? C.accent : C.border}`,
                          opacity: capped ? 0.4 : 1,
                        }}
                      >
                        {tk.name}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {/* Run button + selection hint */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  type="button"
                  disabled={!canRun}
                  onClick={() => void run()}
                  style={{
                    appearance: 'none',
                    border: 'none',
                    borderRadius: 8,
                    padding: '9px 18px',
                    fontSize: 13,
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: canRun ? 'pointer' : 'default',
                    color: '#fff',
                    background: C.accent,
                    opacity: canRun ? 1 : 0.5,
                  }}
                >
                  {running ? (
                    <>
                      <Spinner /> Running…
                    </>
                  ) : (
                    <>▶ Run</>
                  )}
                </button>
                <span style={{ fontSize: 12, color: C.muted }}>
                  {selected.length > 0
                    ? `${selected.length}/${RUN_MAX_TOOLKITS} toolkit${selected.length > 1 ? 's' : ''} selected`
                    : 'No toolkit filter — the agent may have nothing to run.'}
                </span>
              </div>

              {/* Run error states (409 / 502 / network) */}
              {runError ? <Banner tone="error">{runError}</Banner> : null}

              {/* Results panel */}
              {result ? (
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
                >
                  {/* Final answer — prominent */}
                  <div
                    style={{
                      padding: '14px 16px',
                      borderRadius: 10,
                      background: C.accentSoft,
                      border: `1px solid ${C.border}`,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: C.muted,
                        marginBottom: 6,
                      }}
                    >
                      Answer
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        color: C.text,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {result.answer || '(no answer returned)'}
                    </div>
                  </div>

                  {/* Steps */}
                  {result.steps.length > 0 ? (
                    <div
                      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                    >
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          color: C.muted,
                        }}
                      >
                        Steps ({result.steps.length}) · {result.iterations}{' '}
                        iteration{result.iterations === 1 ? '' : 's'}
                      </div>
                      {result.steps.map((step, i) => (
                        <StepRow key={`${step.tool}-${i}`} step={step} index={i} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </ViewBody>
    </>
  );
};

// ---- small inline-styled helpers (no exports from a .css.ts) --------------

const codeStyle: CSSProperties = {
  fontFamily: 'var(--affine-font-code-family, monospace)',
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 4,
  background: 'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  color: 'var(--affine-text-primary-color, #ececec)',
};

const linkBtnStyle: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer',
  color: 'var(--affine-primary-color, #1e96eb)',
  textDecoration: 'underline',
};

// A single collapsible orchestrator step (tool name + ok/fail badge + <pre>).
const StepRow = ({ step, index }: { step: RunStep; index: number }) => {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        borderRadius: 8,
        background: C.bg,
        border: `1px solid ${C.border}`,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          appearance: 'none',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: C.text,
          textAlign: 'left',
          font: 'inherit',
        }}
      >
        <span style={{ fontSize: 11, color: C.muted, width: 18 }}>
          {index + 1}.
        </span>
        <span
          style={{
            fontFamily: 'var(--affine-font-code-family, monospace)',
            fontSize: 12,
            fontWeight: 600,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {step.tool}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            padding: '1px 8px',
            borderRadius: 999,
            color: step.ok ? C.okText : 'var(--affine-error-color, #eb4b4b)',
            background: step.ok ? C.accentSoft : C.errBg,
            border: `1px solid ${step.ok ? C.border : C.errBorder}`,
          }}
        >
          {step.ok ? 'ok' : 'failed'}
        </span>
        <span style={{ fontSize: 11, color: C.muted }}>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <pre
          style={{
            margin: 0,
            padding: '10px 12px',
            borderTop: `1px solid ${C.border}`,
            background: C.panel,
            color: C.muted,
            fontSize: 11.5,
            fontFamily: 'var(--affine-font-code-family, monospace)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 260,
            overflow: 'auto',
          }}
        >
          {step.resultPreview || '(empty result)'}
        </pre>
      ) : null}
    </div>
  );
};

// Tiny CSS spinner (keyframes injected inline once via a <style> tag).
const Spinner = () => (
  <span
    style={{
      display: 'inline-block',
      width: 12,
      height: 12,
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.4)',
      borderTopColor: '#fff',
      animation: 'cdz-integrations-spin 0.7s linear infinite',
    }}
  >
    <style>
      {'@keyframes cdz-integrations-spin{to{transform:rotate(360deg)}}'}
    </style>
  </span>
);

const Banner = ({
  tone,
  children,
}: PropsWithChildren<{ tone: 'info' | 'warn' | 'error' | 'ok' }>) => {
  const map = {
    info: { bg: C.accentSoft, border: C.border, color: C.text },
    ok: { bg: C.accentSoft, border: C.border, color: C.text },
    warn: { bg: C.warnBg, border: C.warnBorder, color: C.text },
    error: { bg: C.errBg, border: C.errBorder, color: C.text },
  }[tone];
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 10,
        fontSize: 13,
        background: map.bg,
        border: `1px solid ${map.border}`,
        color: map.color,
      }}
    >
      {children}
    </div>
  );
};

export const Component = () => {
  return <IntegrationsPage />;
};
