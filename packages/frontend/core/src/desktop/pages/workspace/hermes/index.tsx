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

// ---------------------------------------------------------------------------
// ClickDz Hermes — autonomous operations agent console. DARK by default.
//
// Type a GOAL; the server-side agent (cdz-flash planner loop) picks tools and
// executes them, streaming back a step trace + a final answer. This page:
//   • reflects GET /api/v1/hermes/capabilities (tool chips + planner status)
//   • POSTs /api/v1/hermes/run {goal, dryRun} — runs can take up to ~90s,
//     so the fetch gets a generous 120s abort and a reassuring working state
//   • renders steps[] as a collapsible timeline + the final answer
//   • keeps the last 10 runs in localStorage with a re-run affordance
// Everything degrades gracefully: planner down -> retryable banner; a tool
// without keys -> greyed chip + friendly skip notice. No new .css.ts — inline
// styles only, mirroring the Integrations page scaffold (house rules).
// ---------------------------------------------------------------------------

interface HermesTool {
  slug: string;
  label: string;
  available: boolean;
}

interface CapabilitiesResponse {
  tools: HermesTool[];
  plannerReady: boolean;
  error?: string;
}

// One agent step, mirrors the backend HermesStep shape (contract C2).
interface HermesStep {
  i: number;
  thought?: string;
  tool?: string;
  args?: unknown;
  ok: boolean;
  resultPreview?: string;
  error?: string;
}

interface RunResponse {
  ok: boolean;
  answer: string;
  steps: HermesStep[];
  iterations: number;
}

// A completed run as rendered — `id` keys the timeline so expansion state and
// the reveal animation reset between runs; `dryRun` echoes the request flag.
interface RunResult extends RunResponse {
  id: string;
  dryRun: boolean;
}

interface HistoryEntry {
  id: string;
  goal: string;
  dryRun: boolean;
  ts: number;
  ok: boolean;
  summary: string;
}

// Run failure kinds that need bespoke surfaces:
//   planner  -> {error:'planner_unavailable'} / 502 (retryable, warn tone)
//   tool     -> {error:'tool_unavailable'|'not_configured'} (actionable, warn)
//   timeout  -> client-side abort after RUN_TIMEOUT_MS (retryable, error)
//   generic  -> anything else (retryable, error)
type RunErrorKind = 'planner' | 'tool' | 'timeout' | 'generic';

interface RunFailure {
  kind: RunErrorKind;
  message: string;
}

const GOAL_MAX = 4_000;
// Backend caps a run at 6 iterations / ~90s wall clock — give the fetch real
// headroom so slow-but-successful runs are not killed by the client.
const RUN_TIMEOUT_MS = 120_000;
const HISTORY_KEY = 'cdz:hermes-history';
const HISTORY_MAX = 10;

const EXAMPLE_GOALS = [
  "Summarize today's orders and draft a WhatsApp broadcast",
  'Find leads from last week and prepare a follow-up',
];

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
  errText: 'var(--affine-error-color, #eb4b4b)',
} as const;

type LoadState = 'loading' | 'ready' | 'error';

// Keyframes + prefers-reduced-motion opt-out. Injected once via a <style>
// tag (same trick as the Integrations spinner; names are page-unique). The
// step reveal is transform/opacity only, 240ms — and fully disabled for
// reduced-motion users via the class rules below (`!important` beats the
// element's inline animation/transition declarations).
const GLOBAL_CSS = `
@keyframes cdz-hermes-spin{to{transform:rotate(360deg)}}
@keyframes cdz-hermes-step-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes cdz-hermes-pulse{0%,100%{opacity:1}50%{opacity:0.35}}
.cdz-hermes-step{animation:cdz-hermes-step-in 240ms ease both}
@media (prefers-reduced-motion: reduce){
  .cdz-hermes-step{animation:none !important}
  .cdz-hermes-motion{animation:none !important;transition:none !important}
}
`;

// ---- localStorage history helpers (fail-soft: private mode etc.) ----------

function loadHistory(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is HistoryEntry =>
          !!e &&
          typeof (e as HistoryEntry).goal === 'string' &&
          typeof (e as HistoryEntry).ts === 'number'
      )
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

function persistHistory(entries: HistoryEntry[]) {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    // localStorage unavailable — history simply won't survive reloads.
  }
}

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function summarizeRun(r: RunResult): string {
  const flat = (r.answer || '').replace(/\s+/g, ' ').trim();
  if (flat) return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
  return r.ok
    ? `Completed in ${r.steps.length} step${r.steps.length === 1 ? '' : 's'}`
    : 'Run finished with errors';
}

// ---------------------------------------------------------------------------

const HermesPage = () => {
  // ---- capabilities ----
  const [capsState, setCapsState] = useState<LoadState>('loading');
  const [tools, setTools] = useState<HermesTool[]>([]);
  const [plannerReady, setPlannerReady] = useState(false);

  // ---- composer + run ----
  const [goal, setGoal] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<RunFailure | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  // ---- history ----
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // What the Retry button should re-run (the goal that just failed, even if
  // the composer has been edited since).
  const lastRunRef = useRef<{ goal: string; dry: boolean } | null>(null);

  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      const res = await fetch(cdzApiUrl('/api/v1/hermes/capabilities'), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      if (!res.ok) {
        setCapsState('error');
        return;
      }
      const data = (await res
        .json()
        .catch(() => ({}))) as Partial<CapabilitiesResponse>;
      setTools(Array.isArray(data.tools) ? data.tools : []);
      setPlannerReady(!!data.plannerReady);
      setCapsState('ready');
    } catch {
      setCapsState('error');
    }
  }, []);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  // Elapsed-seconds ticker while a run is in flight (reassurance copy).
  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const pushHistory = useCallback((entry: HistoryEntry) => {
    setHistory(prev => {
      const next = [entry, ...prev].slice(0, HISTORY_MAX);
      persistHistory(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory(() => {
      persistHistory([]);
      return [];
    });
  }, []);

  // The single run path — used by the Run button, history re-runs and the
  // failure Retry buttons (explicit args because setState is async).
  const executeRun = useCallback(
    async (goalText: string, dry: boolean) => {
      const trimmed = goalText.trim();
      if (!trimmed || running) return;
      // Reflect what is actually running in the composer (matters for re-run).
      setGoal(trimmed);
      setDryRun(dry);
      setRunning(true);
      setFailure(null);
      setResult(null);
      lastRunRef.current = { goal: trimmed, dry };

      const controller = new AbortController();
      const killer = window.setTimeout(
        () => controller.abort(),
        RUN_TIMEOUT_MS
      );
      try {
        const res = await fetch(cdzApiUrl('/api/v1/hermes/run'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ goal: trimmed, dryRun: dry }),
          signal: controller.signal,
        });
        const data = (await res
          .json()
          .catch(() => ({}))) as Partial<RunResponse> & { error?: string };

        if (res.status === 502 || data.error === 'planner_unavailable') {
          setFailure({
            kind: 'planner',
            message:
              'The AI planner is unreachable right now. This is usually temporary.',
          });
          return;
        }
        if (
          data.error === 'tool_unavailable' ||
          data.error === 'not_configured'
        ) {
          setFailure({
            kind: 'tool',
            message:
              'A tool Hermes needs is not configured on this server. Greyed-out chips in Agent status show what is missing — ask the owner to add those keys, or rephrase the goal around the available tools.',
          });
          return;
        }
        if (!res.ok) {
          setFailure({
            kind: 'generic',
            message: `The run could not be completed (HTTP ${res.status}). Please try again.`,
          });
          return;
        }

        const runResult: RunResult = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ok: !!data.ok,
          answer: typeof data.answer === 'string' ? data.answer : '',
          steps: Array.isArray(data.steps)
            ? data.steps.filter(s => !!s && typeof s === 'object')
            : [],
          iterations:
            typeof data.iterations === 'number' ? data.iterations : 0,
          dryRun: dry,
        };
        setResult(runResult);
        pushHistory({
          id: runResult.id,
          goal: trimmed,
          dryRun: dry,
          ts: Date.now(),
          ok: runResult.ok,
          summary: summarizeRun(runResult),
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setFailure({
            kind: 'timeout',
            message:
              'The run took longer than 2 minutes and was stopped on this side. The goal may be too broad — try a narrower one, or run it again.',
          });
        } else {
          setFailure({
            kind: 'generic',
            message:
              'Network error while running. Check your connection and try again.',
          });
        }
      } finally {
        window.clearTimeout(killer);
        setRunning(false);
      }
    },
    [pushHistory, running]
  );

  const retry = useCallback(() => {
    const last = lastRunRef.current;
    if (last) void executeRun(last.goal, last.dry);
    else void executeRun(goal, dryRun);
  }, [dryRun, executeRun, goal]);

  const loadIntoComposer = useCallback((entry: HistoryEntry) => {
    setGoal(entry.goal);
    setDryRun(entry.dryRun);
    textareaRef.current?.focus();
  }, []);

  const canRun = goal.trim().length > 0 && !running;
  const availableCount = tools.filter(t => t.available).length;

  return (
    <>
      <ViewTitle title="Hermes" />
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
          <span style={{ fontSize: 16 }}>⚡</span>
          Hermes
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
          <style>{GLOBAL_CSS}</style>
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
                <span>⚡</span> Hermes
              </h1>
              <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
                Your autonomous operations agent. Give it a goal — it plans the
                steps, runs the right tools, and reports back.
              </p>
            </header>

            {/* Agent status: planner indicator + tool chips ------------------ */}
            <section style={panelStyle}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <h2 style={sectionTitleStyle}>Agent status</h2>
                <span style={{ flex: 1 }} />
                {capsState === 'ready' ? (
                  <span style={{ fontSize: 12, color: C.muted }}>
                    {availableCount}/{tools.length} tools available
                  </span>
                ) : null}
                <button
                  style={linkBtnStyle}
                  disabled={capsState === 'loading'}
                  onClick={() => void loadCaps()}
                >
                  {capsState === 'loading' ? 'Checking…' : 'Refresh'}
                </button>
              </div>

              {capsState === 'loading' ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: C.muted,
                    fontSize: 12,
                  }}
                >
                  <Spinner /> Checking agent capabilities…
                </div>
              ) : capsState === 'error' ? (
                <Banner tone="error">
                  Couldn&apos;t load agent capabilities.{' '}
                  <button style={linkBtnStyle} onClick={() => void loadCaps()}>
                    Retry
                  </button>
                </Banner>
              ) : (
                <>
                  {/* Planner readiness */}
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <span
                      className="cdz-hermes-motion"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: plannerReady ? C.okText : C.errText,
                        animation: running
                          ? 'cdz-hermes-pulse 1.2s ease-in-out infinite'
                          : 'none',
                      }}
                    />
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      {plannerReady ? 'Planner ready' : 'Planner offline'}
                    </span>
                    <span style={{ fontSize: 12, color: C.muted }}>
                      {plannerReady
                        ? '— cdz-flash is reachable and will plan your runs.'
                        : '— runs will fail until the owner configures the AI planner.'}
                    </span>
                  </div>

                  {/* Tool chips */}
                  {tools.length > 0 ? (
                    <div
                      style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
                      role="list"
                      aria-label="Agent tools"
                    >
                      {tools.map(tool => (
                        <span
                          key={tool.slug}
                          role="listitem"
                          title={
                            tool.available
                              ? tool.label
                              : `${tool.label} — not configured on this server. Hermes will skip it until the owner adds its keys.`
                          }
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '5px 12px',
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: tool.available ? 'default' : 'help',
                            color: tool.available ? C.text : C.muted,
                            background: tool.available
                              ? C.accentSoft
                              : 'transparent',
                            border: `1px ${tool.available ? 'solid' : 'dashed'} ${C.border}`,
                            opacity: tool.available ? 1 : 0.55,
                          }}
                        >
                          {tool.label}
                          {!tool.available ? (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                letterSpacing: '0.04em',
                                textTransform: 'uppercase',
                              }}
                            >
                              off
                            </span>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <Banner tone="info">
                      No tools are registered yet — Hermes can still reason,
                      but it will have nothing to execute.
                    </Banner>
                  )}
                </>
              )}
            </section>

            {/* Goal composer ------------------------------------------------- */}
            <section style={panelStyle}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <h2 style={sectionTitleStyle}>
                  <span>▶</span> Goal
                </h2>
                <p style={{ margin: 0, color: C.muted, fontSize: 12 }}>
                  Describe the outcome you want. Hermes decides which tools to
                  call and in what order.
                </p>
              </div>

              {capsState === 'ready' && !plannerReady ? (
                <Banner tone="warn">
                  The AI planner is offline — runs will fail until the owner
                  configures <code style={codeStyle}>CDZ_AI_KEY</code> on the
                  server. You can still try: Hermes re-checks on every run.
                </Banner>
              ) : null}

              <textarea
                ref={textareaRef}
                value={goal}
                onChange={e => setGoal(e.target.value.slice(0, GOAL_MAX))}
                disabled={running}
                placeholder="e.g. Summarize today's orders and draft a WhatsApp broadcast"
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
                  opacity: running ? 0.55 : 1,
                }}
              />

              {/* Example goals */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 12, color: C.muted }}>Try:</span>
                {EXAMPLE_GOALS.map(example => (
                  <button
                    key={example}
                    type="button"
                    disabled={running}
                    onClick={() => {
                      setGoal(example);
                      textareaRef.current?.focus();
                    }}
                    style={{
                      appearance: 'none',
                      cursor: running ? 'default' : 'pointer',
                      padding: '5px 12px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 500,
                      color: C.text,
                      background: 'transparent',
                      border: `1px solid ${C.border}`,
                      opacity: running ? 0.5 : 1,
                    }}
                  >
                    {example}
                  </button>
                ))}
              </div>

              {/* Controls row: dry-run toggle + run button */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="button"
                  disabled={!canRun}
                  onClick={() => void executeRun(goal, dryRun)}
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
                  ) : dryRun ? (
                    <>▶ Plan (dry run)</>
                  ) : (
                    <>▶ Run</>
                  )}
                </button>
                <Toggle
                  on={dryRun}
                  disabled={running}
                  onChange={setDryRun}
                  label="Dry run (plan only)"
                />
                <span style={{ fontSize: 12, color: C.muted }}>
                  {dryRun
                    ? 'Hermes will plan the steps but execute nothing.'
                    : 'Hermes will actually execute the tools it picks.'}
                </span>
              </div>

              {/* Working state (runs can take up to ~90s) */}
              {running ? (
                <div
                  role="status"
                  aria-live="polite"
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: '14px 16px',
                    borderRadius: 10,
                    background: C.accentSoft,
                    border: `1px solid ${C.border}`,
                  }}
                >
                  <span style={{ marginTop: 2 }}>
                    <Spinner />
                  </span>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      Hermes is working
                      {dryRun ? ' on the plan' : ''}… {elapsed}s
                    </span>
                    <span style={{ fontSize: 12, color: C.muted }}>
                      Planning{dryRun ? '' : ' and executing'} can take up to
                      ~90 seconds for multi-step goals. Hang tight — this page
                      will show every step as soon as the run finishes.
                    </span>
                  </div>
                </div>
              ) : null}

              {/* Failure surfaces (distinct per kind) */}
              {failure ? (
                <Banner
                  tone={
                    failure.kind === 'planner' || failure.kind === 'tool'
                      ? 'warn'
                      : 'error'
                  }
                >
                  {failure.kind === 'planner' ? (
                    <strong>AI planner unreachable. </strong>
                  ) : failure.kind === 'tool' ? (
                    <strong>Tool unavailable. </strong>
                  ) : failure.kind === 'timeout' ? (
                    <strong>Run timed out. </strong>
                  ) : null}
                  {failure.message}
                  {failure.kind !== 'tool' ? (
                    <div style={{ marginTop: 8 }}>
                      <button
                        style={linkBtnStyle}
                        disabled={running}
                        onClick={retry}
                      >
                        {running ? 'Retrying…' : 'Retry'}
                      </button>
                    </div>
                  ) : null}
                </Banner>
              ) : null}

              {/* Result: step timeline, then the final answer ---------------- */}
              {result ? (
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
                >
                  {result.steps.length > 0 ? (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
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
                        {result.dryRun
                          ? ' · dry run — nothing was executed'
                          : ''}
                      </div>
                      {result.steps.map((step, i) => (
                        <StepRow
                          key={`${result.id}-${i}`}
                          step={step}
                          index={i}
                          dryRun={result.dryRun}
                        />
                      ))}
                    </div>
                  ) : (
                    <Banner tone="info">
                      The agent returned no steps for this run.
                    </Banner>
                  )}

                  {/* Final answer — prominent, revealed after the steps */}
                  <div
                    className="cdz-hermes-step"
                    style={{
                      padding: '14px 16px',
                      borderRadius: 10,
                      background: result.ok ? C.accentSoft : C.errBg,
                      border: `1px solid ${result.ok ? C.border : C.errBorder}`,
                      animationDelay: `${Math.min(result.steps.length, 9) * 55}ms`,
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
                      {result.dryRun
                        ? 'Proposed plan'
                        : result.ok
                          ? 'Answer'
                          : 'Answer · finished with errors'}
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
                </div>
              ) : null}
            </section>

            {/* Run history ---------------------------------------------------- */}
            <section style={panelStyle}>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 12 }}
              >
                <h2 style={sectionTitleStyle}>Recent runs</h2>
                <span style={{ fontSize: 12, color: C.muted }}>
                  last {HISTORY_MAX}, stored on this device
                </span>
                <span style={{ flex: 1 }} />
                {history.length > 0 ? (
                  <button style={linkBtnStyle} onClick={clearHistory}>
                    Clear
                  </button>
                ) : null}
              </div>
              {history.length === 0 ? (
                <div style={{ fontSize: 12, color: C.muted }}>
                  No runs yet — your last {HISTORY_MAX} runs will appear here,
                  ready to re-run.
                </div>
              ) : (
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {history.map(entry => (
                    <div
                      key={entry.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '9px 12px',
                        borderRadius: 8,
                        background: C.bg,
                        border: `1px solid ${C.border}`,
                      }}
                    >
                      <span
                        title={entry.ok ? 'Completed' : 'Finished with errors'}
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          flexShrink: 0,
                          background: entry.ok ? C.okText : C.errText,
                        }}
                      />
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 1,
                        }}
                      >
                        <span
                          title={entry.goal}
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: C.text,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {entry.goal}
                        </span>
                        <span
                          title={entry.summary}
                          style={{
                            fontSize: 11.5,
                            color: C.muted,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {timeAgo(entry.ts)}
                          {entry.dryRun ? ' · dry run' : ''}
                          {entry.summary ? ` · ${entry.summary}` : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={running}
                        onClick={() => loadIntoComposer(entry)}
                        title="Load this goal into the composer without running"
                        style={{
                          ...historyBtnStyle,
                          opacity: running ? 0.5 : 1,
                          cursor: running ? 'default' : 'pointer',
                        }}
                      >
                        Load
                      </button>
                      <button
                        type="button"
                        disabled={running}
                        onClick={() =>
                          void executeRun(entry.goal, entry.dryRun)
                        }
                        title="Run this goal again"
                        style={{
                          ...historyBtnStyle,
                          color: '#fff',
                          background: C.accent,
                          border: `1px solid ${C.accent}`,
                          opacity: running ? 0.5 : 1,
                          cursor: running ? 'default' : 'pointer',
                        }}
                      >
                        ↻ Re-run
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </ViewBody>
    </>
  );
};

// ---- small inline-styled helpers (no exports from a .css.ts) --------------

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 18,
  borderRadius: 12,
  background: C.panel,
  border: `1px solid ${C.border}`,
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 700,
  color: C.text,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

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

const historyBtnStyle: CSSProperties = {
  appearance: 'none',
  flexShrink: 0,
  padding: '5px 10px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 600,
  color: C.text,
  background: 'transparent',
  border: `1px solid ${C.border}`,
};

const stepLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: C.muted,
  marginBottom: 4,
};

const stepPreStyle: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  borderRadius: 6,
  background: C.bg,
  border: `1px solid ${C.border}`,
  color: C.muted,
  fontSize: 11.5,
  fontFamily: 'var(--affine-font-code-family, monospace)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 260,
  overflow: 'auto',
};

// Accessible dry-run switch — inline styles, 150ms transform/background
// transition (killed under prefers-reduced-motion via .cdz-hermes-motion).
const Toggle = ({
  on,
  disabled,
  onChange,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    disabled={disabled}
    onClick={() => onChange(!on)}
    style={{
      appearance: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      background: 'none',
      border: 'none',
      padding: 0,
      cursor: disabled ? 'default' : 'pointer',
      color: C.text,
      font: 'inherit',
      opacity: disabled ? 0.6 : 1,
    }}
  >
    <span
      className="cdz-hermes-motion"
      style={{
        width: 30,
        height: 18,
        borderRadius: 999,
        position: 'relative',
        flexShrink: 0,
        background: on
          ? C.accent
          : 'color-mix(in srgb, var(--affine-text-secondary-color, #9aa0a6) 30%, transparent)',
        transition: 'background 150ms ease',
      }}
    >
      <span
        className="cdz-hermes-motion"
        style={{
          position: 'absolute',
          top: 2,
          left: 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#fff',
          transform: on ? 'translateX(12px)' : 'none',
          transition: 'transform 150ms ease',
        }}
      />
    </span>
    <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
  </button>
);

// A single collapsible agent step: number + tool (or "thinking") + status
// pill + one-line thought preview; expands to full thought / args / result /
// error. Failed steps start expanded. The row reveal is staggered ≤9 steps.
const StepRow = ({
  step,
  index,
  dryRun,
}: {
  step: HermesStep;
  index: number;
  dryRun: boolean;
}) => {
  const [open, setOpen] = useState(() => !step.ok && !!step.error);
  const argsText = formatArgs(step.args);
  const toolMissing =
    !!step.error && /unavailable|not[_ ]configured/i.test(step.error);
  const pill = !step.ok
    ? { text: 'failed', color: C.errText, bg: C.errBg, border: C.errBorder }
    : dryRun && step.tool
      ? { text: 'planned', color: C.accent, bg: C.accentSoft, border: C.border }
      : { text: 'ok', color: C.okText, bg: C.accentSoft, border: C.border };

  return (
    <div
      className="cdz-hermes-step"
      style={{
        borderRadius: 8,
        background: C.bg,
        border: `1px solid ${C.border}`,
        overflow: 'hidden',
        animationDelay: `${Math.min(index, 9) * 55}ms`,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          appearance: 'none',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: '9px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: C.text,
          textAlign: 'left',
          font: 'inherit',
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
          }}
        >
          <span style={{ fontSize: 11, color: C.muted, width: 18 }}>
            {index + 1}.
          </span>
          {step.tool ? (
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
          ) : (
            <span
              style={{
                fontSize: 12,
                fontStyle: 'italic',
                color: C.muted,
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              thinking
            </span>
          )}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              padding: '1px 8px',
              borderRadius: 999,
              color: pill.color,
              background: pill.bg,
              border: `1px solid ${pill.border}`,
            }}
          >
            {pill.text}
          </span>
          <span style={{ fontSize: 11, color: C.muted }}>
            {open ? '▾' : '▸'}
          </span>
        </span>
        {step.thought ? (
          <span
            style={{
              fontSize: 11.5,
              color: C.muted,
              paddingLeft: 28,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '100%',
              boxSizing: 'border-box',
            }}
          >
            {step.thought}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '10px 12px',
            borderTop: `1px solid ${C.border}`,
            background: C.panel,
          }}
        >
          {step.thought ? (
            <div>
              <div style={stepLabelStyle}>Thought</div>
              <div
                style={{
                  fontSize: 12,
                  color: C.text,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {step.thought}
              </div>
            </div>
          ) : null}
          {step.tool ? (
            <div>
              <div style={stepLabelStyle}>
                Tool call{dryRun ? ' (planned, not executed)' : ''}
              </div>
              <pre style={stepPreStyle}>
                {step.tool}
                {argsText ? `\n${argsText}` : ''}
              </pre>
            </div>
          ) : null}
          {step.resultPreview ? (
            <div>
              <div style={stepLabelStyle}>Result</div>
              <pre style={stepPreStyle}>{step.resultPreview}</pre>
            </div>
          ) : null}
          {step.error ? (
            <div>
              <div style={stepLabelStyle}>Error</div>
              <div
                style={{
                  fontSize: 12,
                  color: C.errText,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {step.error}
              </div>
              {toolMissing ? (
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                  This tool isn&apos;t configured on the server, so Hermes
                  skipped it. Greyed-out chips under Agent status show what
                  is missing.
                </div>
              ) : null}
            </div>
          ) : null}
          {!step.thought && !step.tool && !step.resultPreview && !step.error ? (
            <div style={{ fontSize: 12, color: C.muted }}>
              (empty step)
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

// Tiny CSS spinner (keyframes live in GLOBAL_CSS; page-unique name).
const Spinner = () => (
  <span
    className="cdz-hermes-motion"
    style={{
      display: 'inline-block',
      width: 12,
      height: 12,
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.4)',
      borderTopColor: '#fff',
      animation: 'cdz-hermes-spin 0.7s linear infinite',
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
  return <HermesPage />;
};
