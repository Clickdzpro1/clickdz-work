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
  useRef,
  useState,
} from 'react';

import { CodeBlock } from './code-block';

// ---------------------------------------------------------------------------
// OpenClaw — autonomous coding agent console.
//
// Type a coding task; the agent (cdz-flash planner, server-side) writes code,
// runs it in an isolated Vercel Sandbox, reads the output and iterates until
// it succeeds. This page only reflects /api/v1/openclaw/*:
//   • capabilities {sandbox:false} → friendly notice; runs still GENERATE code
//     (honestly labelled "Generated (not executed)").
//   • capabilities {sandbox:true}  → live execution with runtime picker.
// No new .css.ts (inline styles only, per house rules — small new UI prefers
// inline styles). Animations are subtle and prefers-reduced-motion safe.
// ---------------------------------------------------------------------------

interface ClawCapabilities {
  sandbox: boolean;
  reason?: string;
  plannerReady: boolean;
  runtimes: string[];
}

// One agent step, mirrors the backend ClawStep shape (contract C3).
interface ClawStep {
  i: number;
  thought?: string;
  action?: 'write' | 'run' | 'final';
  file?: string;
  command?: string;
  exitCode?: number;
  outputPreview?: string;
  ok: boolean;
  error?: string;
}

interface RunResponse {
  ok: boolean;
  answer: string;
  steps: ClawStep[];
  code?: string;
  language?: string;
  output?: string;
  executed: boolean;
  sandbox: boolean;
  reason?: string;
  iterations: number;
}

// Client-side result = server response + the runtime we asked for.
interface RunResult extends RunResponse {
  clientRuntime: string;
}

interface RunError {
  message: string;
  retryable: boolean;
}

interface HistoryEntry {
  task: string;
  runtime: string;
  at: number;
}

const TASK_MAX = 4_000;
// Backend caps the loop at ~110s wall time; leave headroom for network.
const RUN_TIMEOUT_MS = 125_000;
const CAPS_TIMEOUT_MS = 15_000;
const HISTORY_KEY = 'cdz:openclaw:history:v1';
const HISTORY_MAX = 10;
const DEFAULT_RUNTIMES = ['node24', 'python3.13'];
const RUNTIME_LABELS: Record<string, string> = {
  node24: 'Node.js 24',
  'python3.13': 'Python 3.13',
};

const EXAMPLES = [
  {
    label: 'First 20 primes',
    text: 'Compute the first 20 primes and print them',
  },
  {
    label: 'Summarize JSON fields',
    text: 'Fetch this JSON URL and summarize the fields: https://jsonplaceholder.typicode.com/todos/1',
  },
];

// Reassuring working-state phases (advance every ~5s, then hold on the last).
const PHASES_SANDBOX = [
  'Planning the approach…',
  'Writing code…',
  'Running it in the sandbox…',
  'Reading the output…',
  'Fixing and retrying…',
];
const PHASES_NO_SANDBOX = [
  'Planning the approach…',
  'Writing code…',
  'Preparing the explanation…',
];

// Dark, app-consistent palette: --affine-* theme vars with hard dark
// fallbacks (same idiom as the Integrations page).
const C = {
  bg: 'var(--affine-background-primary-color, #141414)',
  panel: 'var(--affine-background-secondary-color, #1c1c1e)',
  border: 'var(--affine-border-color, #2a2a2c)',
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  accentSoft:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
  warnBg: 'color-mix(in srgb, #e8a33d 12%, transparent)',
  warnBorder: 'color-mix(in srgb, #e8a33d 40%, transparent)',
  errBg: 'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 12%, transparent)',
  errBorder:
    'color-mix(in srgb, var(--affine-error-color, #eb4b4b) 40%, transparent)',
  okText: 'var(--affine-success-color, #4cae4c)',
  okBg: 'color-mix(in srgb, var(--affine-success-color, #4cae4c) 12%, transparent)',
  amber: '#e8a33d',
  // Fixed terminal palette for code/output surfaces (dark in both themes).
  consoleBg: '#0d1117',
  consoleBorder: '#22272e',
  consoleText: '#e6edf3',
  stderrText: '#ffa198',
} as const;

const monoFamily =
  'var(--affine-font-code-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';

// Per-action tint in the step timeline (github-dark-ish hues).
const ACTION_META: Record<string, { label: string; color: string }> = {
  write: { label: 'write', color: '#7ee787' },
  run: { label: 'run', color: '#79c0ff' },
  final: { label: 'final', color: '#d2a8ff' },
};

type LoadState = 'loading' | 'ready' | 'error';

// AbortSignal.timeout with a defensive fallback (no signal on old engines).
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== 'undefined' &&
      typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(ms)
      : undefined;
  } catch {
    return undefined;
  }
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (e): e is HistoryEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as HistoryEntry).task === 'string' &&
          typeof (e as HistoryEntry).runtime === 'string' &&
          typeof (e as HistoryEntry).at === 'number'
      )
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    // localStorage full/blocked — history is a nicety, never an error.
  }
}

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// The contract exposes a single output string. If the backend used a stderr
// separator we split and tint it; otherwise everything renders as stdout.
const STDERR_MARKERS = ['\n--- stderr ---\n', '\n[stderr]\n'];
function splitOutput(raw: string): { stdout: string; stderr?: string } {
  let output = raw;
  if (output.startsWith('--- stdout ---\n')) {
    output = output.slice('--- stdout ---\n'.length);
  }
  for (const marker of STDERR_MARKERS) {
    const idx = output.indexOf(marker);
    if (idx !== -1) {
      return {
        stdout: output.slice(0, idx),
        stderr: output.slice(idx + marker.length),
      };
    }
  }
  for (const lead of ['--- stderr ---\n', '[stderr]\n']) {
    if (output.startsWith(lead)) {
      return { stdout: '', stderr: output.slice(lead.length) };
    }
  }
  return { stdout: output };
}

const OpenClawPage = () => {
  // ---- capabilities ----
  const [capsState, setCapsState] = useState<LoadState>('loading');
  const [caps, setCaps] = useState<ClawCapabilities | null>(null);

  // ---- composer ----
  const [task, setTask] = useState('');
  const [runtime, setRuntime] = useState(DEFAULT_RUNTIMES[0]);
  const taskRef = useRef<HTMLTextAreaElement | null>(null);

  // ---- run ----
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [runError, setRunError] = useState<RunError | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  // ---- history ----
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      const res = await fetch(cdzApiUrl('/api/v1/openclaw/capabilities'), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
        signal: timeoutSignal(CAPS_TIMEOUT_MS),
      });
      if (!res.ok) {
        setCapsState('error');
        return;
      }
      const data = (await res.json().catch(() => ({}))) as
        Partial<ClawCapabilities>;
      setCaps({
        sandbox: !!data.sandbox,
        reason: typeof data.reason === 'string' ? data.reason : undefined,
        plannerReady: data.plannerReady !== false,
        runtimes:
          Array.isArray(data.runtimes) && data.runtimes.length > 0
            ? data.runtimes.filter((r): r is string => typeof r === 'string')
            : DEFAULT_RUNTIMES,
      });
      setCapsState('ready');
    } catch {
      setCapsState('error');
    }
  }, []);

  useEffect(() => {
    void loadCaps();
    setHistory(loadHistory());
  }, [loadCaps]);

  // Keep the selected runtime valid once real capabilities arrive.
  useEffect(() => {
    if (!caps) return;
    if (!caps.runtimes.includes(runtime)) {
      setRuntime(caps.runtimes[0] ?? DEFAULT_RUNTIMES[0]);
    }
  }, [caps, runtime]);

  // Working-state clock (drives the elapsed counter + phase text).
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const t = window.setInterval(() => setElapsed(s => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const pushHistory = useCallback((taskText: string, rt: string) => {
    setHistory(prev => {
      const next = [
        { task: taskText, runtime: rt, at: Date.now() },
        ...prev.filter(e => !(e.task === taskText && e.runtime === rt)),
      ].slice(0, HISTORY_MAX);
      saveHistory(next);
      return next;
    });
  }, []);

  const doRun = useCallback(
    async (taskText: string, rt: string) => {
      const trimmed = taskText.trim();
      if (!trimmed || running) return;
      setRunning(true);
      setRunError(null);
      setResult(null);
      pushHistory(trimmed, rt);
      try {
        const res = await fetch(cdzApiUrl('/api/v1/openclaw/run'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({ task: trimmed, runtime: rt }),
          // Generous: the agent iterates (write → run → fix, up to ~110s).
          signal: timeoutSignal(RUN_TIMEOUT_MS),
        });
        const data = (await res.json().catch(() => ({}))) as
          Partial<RunResponse> & { error?: string };
        if (res.status === 401 || res.status === 403) {
          setRunError({
            message: 'You need to be signed in to use OpenClaw.',
            retryable: false,
          });
          return;
        }
        if (res.status === 502 || data.error === 'planner_unavailable') {
          setRunError({
            message:
              'The AI planner is unreachable right now — it usually comes back within a minute.',
            retryable: true,
          });
          return;
        }
        if (res.status === 429) {
          setRunError({
            message: 'Rate limited — give it a few seconds, then run again.',
            retryable: true,
          });
          return;
        }
        const steps: ClawStep[] = Array.isArray(data.steps)
          ? (data.steps as unknown[]).filter(
              (s): s is ClawStep => !!s && typeof s === 'object'
            )
          : [];
        if (!res.ok && steps.length === 0 && typeof data.code !== 'string') {
          setRunError({
            message: 'The run could not be completed. Please try again.',
            retryable: true,
          });
          return;
        }
        setResult({
          ok: !!data.ok,
          answer: typeof data.answer === 'string' ? data.answer : '',
          steps,
          code:
            typeof data.code === 'string' && data.code.length > 0
              ? data.code
              : undefined,
          language:
            typeof data.language === 'string' ? data.language : undefined,
          output: typeof data.output === 'string' ? data.output : undefined,
          executed: !!data.executed,
          sandbox: !!data.sandbox,
          reason: typeof data.reason === 'string' ? data.reason : undefined,
          iterations:
            typeof data.iterations === 'number'
              ? data.iterations
              : steps.length,
          clientRuntime: rt,
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        setRunError(
          name === 'TimeoutError' || name === 'AbortError'
            ? {
                message:
                  'Timed out after ~2 minutes — the task may be heavy. Try a smaller task or run it again.',
                retryable: true,
              }
            : {
                message:
                  'Network error while running. Check your connection and try again.',
                retryable: true,
              }
        );
      } finally {
        setRunning(false);
      }
    },
    [running, pushHistory]
  );

  const reRun = useCallback(
    (entry: HistoryEntry) => {
      setTask(entry.task);
      setRuntime(entry.runtime);
      void doRun(entry.task, entry.runtime);
    },
    [doRun]
  );

  const applyExample = useCallback((text: string) => {
    setTask(text);
    taskRef.current?.focus();
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
  }, []);

  const sandboxOn = capsState === 'ready' && !!caps?.sandbox;
  const plannerDown = capsState === 'ready' && caps?.plannerReady === false;
  const runtimes = caps?.runtimes ?? DEFAULT_RUNTIMES;
  const canRun = task.trim().length > 0 && !running && !plannerDown;

  const phases = sandboxOn ? PHASES_SANDBOX : PHASES_NO_SANDBOX;
  const phase =
    phases[Math.min(Math.floor(elapsed / 5), phases.length - 1)];

  const lastExit = result
    ? [...result.steps]
        .reverse()
        .find(s => s.action === 'run' && typeof s.exitCode === 'number')
        ?.exitCode
    : undefined;

  const codeLanguage =
    result?.language ??
    (result?.clientRuntime === 'python3.13' ? 'python' : 'javascript');
  const lastWrittenFile = result
    ? [...result.steps]
        .reverse()
        .find(s => s.action === 'write' && typeof s.file === 'string')?.file
    : undefined;

  return (
    <>
      <ViewTitle title="OpenClaw" />
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
          <span
            style={{
              fontFamily: monoFamily,
              fontWeight: 700,
              fontSize: 13,
              color: C.accent,
            }}
          >
            {'>_'}
          </span>
          OpenClaw
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
                <span
                  style={{
                    fontFamily: monoFamily,
                    color: C.accent,
                    fontSize: 20,
                  }}
                >
                  {'>_'}
                </span>
                OpenClaw
              </h1>
              <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
                Give the agent a coding task. It writes the code, runs it in an
                isolated Vercel Sandbox, reads the output and iterates until it
                works.
              </p>
            </header>

            {/* Sandbox / planner status banner ------------------------------ */}
            {capsState === 'loading' ? (
              <Banner tone="info">Checking sandbox availability…</Banner>
            ) : capsState === 'error' ? (
              <Banner tone="error">
                Couldn&apos;t load OpenClaw capabilities.{' '}
                <button style={linkBtnStyle} onClick={() => void loadCaps()}>
                  Retry
                </button>
              </Banner>
            ) : sandboxOn ? (
              <Banner tone="ok">
                <strong>Sandbox ready.</strong> Tasks run live in an isolated
                Vercel Sandbox VM — pick a runtime below (
                <code style={codeChipStyle}>
                  {runtimes.join(' · ')}
                </code>
                ) and press Run.
              </Banner>
            ) : (
              <Banner tone="info">
                <strong>Live execution is off for now.</strong>
                <br />
                Live execution needs Vercel Sandbox enabled — OpenClaw will
                still generate &amp; explain code.
                {caps?.reason ? (
                  <div style={{ marginTop: 6, color: C.muted, fontSize: 12 }}>
                    Reason: {caps.reason}
                  </div>
                ) : null}
              </Banner>
            )}

            {plannerDown ? (
              <Banner tone="warn">
                The AI planner isn&apos;t configured — ask the owner to set{' '}
                <code style={codeChipStyle}>CDZ_AI_KEY</code> on the server.
                Running is disabled until then.
              </Banner>
            ) : null}

            {/* Task composer ------------------------------------------------ */}
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
                  }}
                >
                  Task
                </h2>
                <p style={{ margin: 0, color: C.muted, fontSize: 12 }}>
                  Describe what the code should do — the agent handles the rest.
                </p>
              </div>

              <textarea
                ref={taskRef}
                value={task}
                onChange={e => setTask(e.target.value.slice(0, TASK_MAX))}
                disabled={running}
                placeholder="e.g. Compute the first 20 primes and print them"
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
                  opacity: running ? 0.7 : 1,
                }}
              />

              {/* Example chips */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 12, color: C.muted }}>Try:</span>
                {EXAMPLES.map(ex => (
                  <button
                    key={ex.label}
                    type="button"
                    disabled={running}
                    onClick={() => applyExample(ex.text)}
                    title={ex.text}
                    style={{
                      appearance: 'none',
                      cursor: running ? 'default' : 'pointer',
                      padding: '4px 12px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      color: C.text,
                      background: 'transparent',
                      border: `1px solid ${C.border}`,
                      opacity: running ? 0.5 : 1,
                    }}
                  >
                    {ex.label}
                  </button>
                ))}
              </div>

              {/* Runtime picker + Run button */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 12,
                }}
              >
                <div
                  role="radiogroup"
                  aria-label="Runtime"
                  style={{ display: 'inline-flex', gap: 6 }}
                >
                  {runtimes.map(rt => {
                    const on = rt === runtime;
                    return (
                      <button
                        key={rt}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        disabled={running}
                        onClick={() => setRuntime(rt)}
                        title={RUNTIME_LABELS[rt] ?? rt}
                        style={{
                          appearance: 'none',
                          cursor: running ? 'default' : 'pointer',
                          padding: '5px 12px',
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 600,
                          fontFamily: monoFamily,
                          color: on ? '#fff' : C.text,
                          background: on ? C.accent : 'transparent',
                          border: `1px solid ${on ? C.accent : C.border}`,
                        }}
                      >
                        {rt}
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  disabled={!canRun}
                  onClick={() => void doRun(task, runtime)}
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
                      <Spinner /> Working…
                    </>
                  ) : sandboxOn ? (
                    <>▶ Run task</>
                  ) : (
                    <>▶ Generate code</>
                  )}
                </button>

                <span style={{ fontSize: 12, color: C.muted }}>
                  {sandboxOn
                    ? `Runs live on ${RUNTIME_LABELS[runtime] ?? runtime}.`
                    : 'Runtime steers the generated language.'}
                </span>
              </div>
            </section>

            {/* Working state (the agent iterates — keep the user reassured) - */}
            {running ? (
              <section
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '16px 18px',
                  borderRadius: 12,
                  background: C.panel,
                  border: `1px solid ${C.border}`,
                }}
              >
                <Spinner size={18} tone="accent" />
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
                    OpenClaw is working{' '}
                    <span
                      style={{
                        fontFamily: monoFamily,
                        fontWeight: 600,
                        color: C.muted,
                        fontSize: 12,
                      }}
                    >
                      {elapsed}s
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: C.muted }}>
                    {phase}{' '}
                    {sandboxOn
                      ? 'The agent writes code, runs it, and fixes failures — longer tasks can take a minute or two.'
                      : 'Live execution is off, so the agent generates and explains the code without running it.'}
                  </div>
                </div>
              </section>
            ) : null}

            {/* Run errors (planner-down and transient failures are retryable) */}
            {runError ? (
              <Banner tone={runError.retryable ? 'warn' : 'error'}>
                {runError.message}
                {runError.retryable ? (
                  <div style={{ marginTop: 8 }}>
                    <button
                      style={linkBtnStyle}
                      disabled={running || !task.trim()}
                      onClick={() => void doRun(task, runtime)}
                    >
                      {running ? 'Retrying…' : 'Retry'}
                    </button>
                  </div>
                ) : null}
              </Banner>
            ) : null}

            {/* Results ------------------------------------------------------ */}
            {result ? (
              <section
                style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
              >
                {/* Status strip */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 8,
                  }}
                >
                  {result.executed ? (
                    result.ok ? (
                      <Pill color={C.okText} bg={C.okBg}>
                        Ran successfully
                      </Pill>
                    ) : (
                      <Pill
                        color="var(--affine-error-color, #eb4b4b)"
                        bg={C.errBg}
                      >
                        Finished with errors
                      </Pill>
                    )
                  ) : (
                    <Pill color={C.amber} bg={C.warnBg}>
                      Generated (not executed)
                    </Pill>
                  )}
                  <span
                    style={{
                      fontFamily: monoFamily,
                      fontSize: 11,
                      color: C.muted,
                      padding: '2px 8px',
                      borderRadius: 999,
                      border: `1px solid ${C.border}`,
                    }}
                  >
                    {result.clientRuntime}
                  </span>
                  <span style={{ fontSize: 12, color: C.muted }}>
                    {result.iterations} iteration
                    {result.iterations === 1 ? '' : 's'}
                  </span>
                </div>
                {!result.executed ? (
                  <div style={{ fontSize: 12, color: C.muted, marginTop: -6 }}>
                    {result.reason ??
                      'Vercel Sandbox isn’t enabled on this server, so the code was not run.'}
                  </div>
                ) : null}

                {/* Answer */}
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: 10,
                    background: C.accentSoft,
                    border: `1px solid ${C.border}`,
                  }}
                >
                  <div style={sectionLabelStyle}>Agent answer</div>
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

                {/* Step timeline */}
                {result.steps.length > 0 ? (
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                  >
                    <div style={sectionLabelStyle}>
                      Agent steps ({result.steps.length})
                    </div>
                    {result.steps.map((step, i) => (
                      <div
                        key={`${step.action ?? 'step'}-${i}`}
                        className="cdz-openclaw-step"
                        style={{ animationDelay: `${Math.min(i * 45, 400)}ms` }}
                      >
                        <StepRow step={step} index={i} />
                      </div>
                    ))}
                  </div>
                ) : null}

                {/* Final code */}
                {result.code ? (
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                  >
                    <div style={sectionLabelStyle}>Code</div>
                    <CodeBlock
                      code={result.code}
                      language={codeLanguage}
                      filename={lastWrittenFile}
                      notExecuted={!result.executed}
                    />
                  </div>
                ) : null}

                {/* Execution output */}
                {result.executed ? (
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                  >
                    <div style={sectionLabelStyle}>Execution output</div>
                    <OutputBlock output={result.output} exitCode={lastExit} />
                  </div>
                ) : null}
              </section>
            ) : null}

            {/* History ------------------------------------------------------ */}
            {history.length > 0 ? (
              <section
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  padding: '14px 18px 6px',
                  borderRadius: 12,
                  background: C.panel,
                  border: `1px solid ${C.border}`,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingBottom: 8,
                  }}
                >
                  <div style={sectionLabelStyle}>
                    Recent tasks ({history.length})
                  </div>
                  <button style={linkBtnStyle} onClick={clearHistory}>
                    Clear
                  </button>
                </div>
                {history.map((entry, i) => (
                  <div
                    key={`${entry.at}-${i}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 0',
                      borderTop: `1px solid ${C.border}`,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setTask(entry.task);
                        setRuntime(entry.runtime);
                        taskRef.current?.focus();
                      }}
                      title="Load into the composer"
                      style={{
                        appearance: 'none',
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        font: 'inherit',
                        cursor: 'pointer',
                        textAlign: 'left',
                        flex: 1,
                        minWidth: 0,
                        color: C.text,
                      }}
                    >
                      <span
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          fontSize: 13,
                        }}
                      >
                        {entry.task}
                      </span>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 8,
                          marginTop: 3,
                          fontSize: 11,
                          color: C.muted,
                        }}
                      >
                        <span style={{ fontFamily: monoFamily }}>
                          {entry.runtime}
                        </span>
                        · {fmtAgo(entry.at)}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={running || plannerDown}
                      onClick={() => reRun(entry)}
                      style={{
                        appearance: 'none',
                        flexShrink: 0,
                        cursor: running || plannerDown ? 'default' : 'pointer',
                        padding: '5px 12px',
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: 600,
                        color: C.text,
                        background: 'transparent',
                        border: `1px solid ${C.border}`,
                        opacity: running || plannerDown ? 0.5 : 1,
                      }}
                    >
                      ▶ Run again
                    </button>
                  </div>
                ))}
              </section>
            ) : null}
          </div>
        </div>

        {/* Page-scoped keyframes + prefers-reduced-motion guards. */}
        <style>
          {`
@keyframes cdz-openclaw-spin{to{transform:rotate(360deg)}}
@keyframes cdz-openclaw-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.cdz-openclaw-spinner{animation:cdz-openclaw-spin .7s linear infinite}
.cdz-openclaw-step{animation:cdz-openclaw-rise .24s ease both}
@media (prefers-reduced-motion: reduce){
  .cdz-openclaw-spinner{animation:none !important}
  .cdz-openclaw-step{animation:none !important}
}
`}
        </style>
      </ViewBody>
    </>
  );
};

// ---- small inline-styled helpers (no exports from a .css.ts) --------------

const sectionLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: C.muted,
  marginBottom: 6,
};

const codeChipStyle: CSSProperties = {
  fontFamily: monoFamily,
  fontSize: 12,
  padding: '1px 5px',
  borderRadius: 4,
  background: C.accentSoft,
  color: C.text,
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

const Pill = ({
  color,
  bg,
  children,
}: PropsWithChildren<{ color: string; bg: string }>) => (
  <span
    style={{
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      padding: '2px 10px',
      borderRadius: 999,
      color,
      background: bg,
    }}
  >
    {children}
  </span>
);

// One collapsible agent step: action tag + detail + exit code + ok/fail.
const StepRow = ({ step, index }: { step: ClawStep; index: number }) => {
  const [open, setOpen] = useState(false);
  const meta = step.action ? ACTION_META[step.action] : undefined;
  const detail =
    step.action === 'write'
      ? (step.file ?? 'file')
      : step.action === 'run'
        ? (step.command ?? 'command')
        : step.action === 'final'
          ? 'final answer'
          : (step.thought ?? '…');
  const hasBody = !!(step.thought || step.outputPreview || step.error);
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
            fontFamily: monoFamily,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: meta?.color ?? C.muted,
            flexShrink: 0,
            width: 40,
          }}
        >
          {meta?.label ?? 'think'}
        </span>
        <span
          style={{
            fontFamily: monoFamily,
            fontSize: 12,
            fontWeight: 600,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={detail}
        >
          {detail}
        </span>
        {typeof step.exitCode === 'number' ? (
          <span
            style={{
              fontFamily: monoFamily,
              fontSize: 10,
              fontWeight: 700,
              padding: '1px 8px',
              borderRadius: 999,
              flexShrink: 0,
              color:
                step.exitCode === 0
                  ? C.okText
                  : 'var(--affine-error-color, #eb4b4b)',
              background: step.exitCode === 0 ? C.okBg : C.errBg,
            }}
          >
            exit {step.exitCode}
          </span>
        ) : null}
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            padding: '1px 8px',
            borderRadius: 999,
            flexShrink: 0,
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
        <div
          style={{
            borderTop: `1px solid ${C.border}`,
            background: C.panel,
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {step.thought ? (
            <div style={{ fontSize: 12, color: C.muted }}>{step.thought}</div>
          ) : null}
          {step.error ? (
            <div
              style={{
                fontSize: 12,
                color: 'var(--affine-error-color, #eb4b4b)',
              }}
            >
              {step.error}
            </div>
          ) : null}
          {step.outputPreview ? (
            <pre
              style={{
                margin: 0,
                padding: '10px 12px',
                borderRadius: 6,
                background: C.consoleBg,
                border: `1px solid ${C.consoleBorder}`,
                color: C.consoleText,
                fontSize: 11.5,
                fontFamily: monoFamily,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 260,
                overflow: 'auto',
              }}
            >
              {step.outputPreview}
            </pre>
          ) : null}
          {!hasBody ? (
            <div style={{ fontSize: 12, color: C.muted }}>(no details)</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

// Terminal-styled execution output. stdout and (when the backend marks it)
// stderr are visually distinguished; the exit code rides in the header.
const OutputBlock = ({
  output,
  exitCode,
}: {
  output?: string;
  exitCode?: number;
}) => {
  const { stdout, stderr } = splitOutput(output ?? '');
  const empty = !stdout.trim() && !stderr?.trim();
  const outPre: CSSProperties = {
    margin: 0,
    padding: '12px 16px',
    fontFamily: monoFamily,
    fontSize: 12.5,
    lineHeight: 1.65,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 320,
    overflow: 'auto',
  };
  return (
    <div
      style={{
        borderRadius: 10,
        overflow: 'hidden',
        border: `1px solid ${C.consoleBorder}`,
        background: C.consoleBg,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          background: '#161b22',
          borderBottom: `1px solid ${C.consoleBorder}`,
        }}
      >
        <span
          style={{
            fontFamily: monoFamily,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: '#8b949e',
          }}
        >
          console
        </span>
        <span style={{ flex: 1 }} />
        {typeof exitCode === 'number' ? (
          <span
            style={{
              fontFamily: monoFamily,
              fontSize: 10,
              fontWeight: 700,
              padding: '1px 8px',
              borderRadius: 999,
              color: exitCode === 0 ? '#7ee787' : C.stderrText,
              background:
                exitCode === 0
                  ? 'color-mix(in srgb, #7ee787 12%, transparent)'
                  : 'color-mix(in srgb, #ffa198 12%, transparent)',
            }}
          >
            exit {exitCode}
          </span>
        ) : null}
      </div>
      {empty ? (
        <div
          style={{
            padding: '12px 16px',
            fontFamily: monoFamily,
            fontSize: 12,
            color: '#8b949e',
          }}
        >
          (no output)
        </div>
      ) : (
        <>
          {stdout.trim() ? (
            <pre style={{ ...outPre, color: C.consoleText }}>{stdout}</pre>
          ) : null}
          {stderr?.trim() ? (
            <div style={{ borderTop: `1px solid ${C.consoleBorder}` }}>
              <div
                style={{
                  padding: '6px 16px 0',
                  fontFamily: monoFamily,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: C.stderrText,
                }}
              >
                stderr
              </div>
              <pre style={{ ...outPre, color: C.stderrText }}>{stderr}</pre>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};

// Tiny CSS spinner (keyframes live in the page-level <style> block above,
// on a class so the reduced-motion media query can disable it).
// tone 'onAccent' = white spinner for the accent Run button;
// tone 'accent'   = theme-accent spinner for neutral panel backgrounds.
const Spinner = ({
  size = 12,
  tone = 'onAccent',
}: {
  size?: number;
  tone?: 'onAccent' | 'accent';
}) => (
  <span
    className="cdz-openclaw-spinner"
    style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      border:
        tone === 'onAccent'
          ? '2px solid rgba(255,255,255,0.4)'
          : `2px solid ${C.accentSoft}`,
      borderTopColor: tone === 'onAccent' ? '#fff' : C.accent,
      flexShrink: 0,
    }}
  />
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
  return <OpenClawPage />;
};
