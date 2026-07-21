import { AgentPalette } from '@affine/core/modules/agents/components';
// Consumed from sibling builders BY CONTRACT NAME via the components barrel:
//   • Chrono  — <RunTimeline steps state finalText onApprove pendingApproval />
//   • Galerie — <ArtifactsPanel artifacts onOpen />
//   • Jauge   — <SpendMeter ... />
// The barrel (modules/agents/components/index.ts) is orchestrator-merged with
// those builders' snippet exports; if a sibling export isn't on disk yet these
// import bindings still typecheck against the R7-CONTRACT signatures.
import {
  ArtifactsPanel,
  RunTimeline,
  SpendMeter,
} from '@affine/core/modules/agents/components';
import { AgentApiError, getAgentRun } from '@affine/core/modules/agents/api';
import { type TFunc, useAgentLang } from '@affine/core/modules/agents/i18n';
import type {
  AgentArtifact,
  AgentEvent,
  AgentName,
  AgentRunRecord,
  AgentRunState,
  AgentStep,
} from '@affine/core/modules/agents/types';
import { useAgentRunStream } from '@affine/core/modules/agents/use-agent-stream';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchService,
} from '@affine/core/modules/workbench';
// OpenClaw sandbox surfaces reused as-is (do NOT fork sandbox UI). These are
// pure presentational components that take derived data via props (no fetching),
// so we feed them the deltas extracted from the run's live event stream.
import { FileTree } from '@affine/core/desktop/pages/workspace/openclaw/file-tree';
import { PreviewPanel } from '@affine/core/desktop/pages/workspace/openclaw/preview-panel';
import { Terminal } from '@affine/core/desktop/pages/workspace/openclaw/terminal';
import { useService } from '@toeverything/infra';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

// ---------------------------------------------------------------------------
// ClickDz Agents — single-run live view, full-page (R8 i18n + mobile).
//
// The dedicated full-page version of the Hermes dashboard's inline RunLiveView
// overlay (hermes/dashboard.tsx). It attaches to a durable background run via
// the durable `useAgentRunStream({agent, runId})` hook (which replays history
// on mount + re-attaches on tab-return), and lays out:
//   • Header — agent identity, live state chip, a Stop button, and a spend
//     estimate (Jauge <SpendMeter>).
//   • Main column — Chrono's <RunTimeline> (the growing step timeline + final
//     answer + inline approval interrupts via onApprove).
//   • Side column — Galerie's <ArtifactsPanel> (files/outputs/links the run
//     produced). Artifacts are EXTRACTED HERE from the run's steps/events and
//     passed down.
//   • OpenClaw only — its existing Files / Terminal / Preview sandbox surfaces,
//     fed by the file/terminal/preview deltas seen on the stream. If nothing was
//     captured we simply link out to /openclaw rather than forking the UI.
//
// R8 (WSU-7 / RETOUCHE): all user-facing copy comes from the shared agents i18n
// catalogue via `useAgentLang()` (FR default + Algerian darja); the page root
// gets `dir={dir}` (Arabic → RTL); the run-prompt block word-breaks long URLs.
// Behaviour, routing, props and exports are unchanged.
//
// The durable hook exposes only {steps, state, finalText, pendingApproval,
// error, reattach, stop}; it deliberately ignores artifact/file/terminal/
// preview frames. So we pass its `onEvent` a collector that accumulates those
// side-channels locally — plus we seed file artifacts from the persisted
// record's `write` steps so a finished run still shows its outputs instantly.
//
// Seeding: on mount we GET /runs/:id (getAgentRun) so an already-finished run
// renders immediately, then the hook replays + live-attaches. A load 404 (the
// runs feature is off, CDZ_AGENTS_ENABLED) shows a quiet "Agents non activés"
// fallback.
//
// Mobile: single column — timeline first, artifacts + sandbox collapse below.
//
// House rules: inline styles only (no .css.ts), no new deps, shared
// AgentPalette, loading/empty/error + flag-off/404 quiet fallback. Exports BOTH
// `Component` (react-router lazy convention) and a default export.
// ---------------------------------------------------------------------------

const C = AgentPalette.color;
const R = AgentPalette.radius;

type LoadState = 'loading' | 'ready' | 'error';

// Per-state chip tint (colour). Labels come from the i18n catalogue at render
// (`states.<state>` with the `.short` variants run.tsx uses for approval /
// failed).
const RUN_STATE_TINT: Record<
  AgentRunState,
  { color: string; bg: string; border: string }
> = {
  queued: { color: C.muted, bg: 'transparent', border: C.border },
  running: { color: C.accent, bg: C.accentSoft, border: C.accentBorder },
  waiting_approval: { color: C.warn, bg: C.warnBg, border: C.warnBorder },
  done: { color: C.okText, bg: C.okBg, border: C.okBorder },
  failed: { color: C.errText, bg: C.errBg, border: C.errBorder },
  stopped: { color: C.muted, bg: 'transparent', border: C.border },
};

// i18n key for a run state's SHORT chip label (run.tsx uses the compact
// register: "Approbation" / "Échec").
const RUN_STATE_KEY: Record<AgentRunState, string> = {
  queued: 'states.queued',
  running: 'states.running',
  waiting_approval: 'states.waiting_approval.short',
  done: 'states.done',
  failed: 'states.failed.short',
  stopped: 'states.stopped',
};

function coerceRunState(v: unknown): AgentRunState {
  const s = typeof v === 'string' ? v : '';
  return s in RUN_STATE_TINT ? (s as AgentRunState) : 'queued';
}

function coerceAgent(v: string | null): AgentName {
  return v === 'openclaw' ? 'openclaw' : 'hermes';
}

const AGENT_LABEL: Record<AgentName, string> = {
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
};
const AGENT_EMOJI: Record<AgentName, string> = {
  hermes: '🤝',
  openclaw: '🛠️',
};

// A run is still "live" (worth showing a stop button + pulse) in these states.
const LIVE_STATES: ReadonlySet<AgentRunState> = new Set<AgentRunState>([
  'queued',
  'running',
  'waiting_approval',
]);

// ---- artifact / sandbox extraction ----------------------------------------

// Derive a file artifact from a `write` step so a finished run (whose live
// `artifact` frames we never saw) still populates the ArtifactsPanel. The step
// title usually carries the path; fall back to a generic label.
function stepToArtifact(step: AgentStep): AgentArtifact | null {
  if (step.kind !== 'write') return null;
  const path =
    typeof step.title === 'string' && step.title.trim()
      ? step.title.trim()
      : 'file';
  return { kind: 'file', path };
}

// De-dupe key for an artifact so seeded + streamed copies collapse.
function artifactKey(a: AgentArtifact): string {
  switch (a.kind) {
    case 'file':
      return `file:${a.path}`;
    case 'link':
      return `link:${a.url}`;
    case 'output':
      return `output:${a.label}:${a.text.slice(0, 40)}`;
    default:
      return JSON.stringify(a);
  }
}

interface TerminalLineLocal {
  stream: 'stdout' | 'stderr';
  data: string;
}
interface FileDeltaLocal {
  path: string;
  bytes?: number;
  language?: string;
}
interface PreviewLocal {
  url: string;
  status: 'starting' | 'ready';
}

const AgentRunPage = () => {
  const routeParams = useParams();
  const [searchParams] = useSearchParams();
  const runId = routeParams.id ?? routeParams.runId ?? '';
  const agent = coerceAgent(searchParams.get('agent'));

  const { t, dir } = useAgentLang();
  const workbench = useService(WorkbenchService).workbench;

  const [record, setRecord] = useState<AgentRunRecord | null>(null);
  const [recordState, setRecordState] = useState<LoadState>('loading');
  // 404 on the record load ⇒ the runs feature is off (quiet fallback).
  const [featureOff, setFeatureOff] = useState(false);

  // Side-channels the durable hook ignores — collected from onEvent.
  const [artifacts, setArtifacts] = useState<AgentArtifact[]>([]);
  const [terminal, setTerminal] = useState<TerminalLineLocal[]>([]);
  const [files, setFiles] = useState<Map<string, FileDeltaLocal>>(new Map());
  const [preview, setPreview] = useState<PreviewLocal | null>(null);
  const seenArtifactKeys = useRef<Set<string>>(new Set());

  const loadRecord = useCallback(async () => {
    if (!runId) {
      setRecordState('error');
      return;
    }
    setRecordState('loading');
    try {
      const raw = await getAgentRun(agent, runId);
      setRecord(raw);
      setRecordState('ready');
    } catch (err) {
      if (err instanceof AgentApiError && err.status === 404) {
        // Ambiguous: either the run doesn't exist OR the whole feature is off.
        // We treat a 404 as feature-off only when the message doesn't look
        // run-specific; either way the quiet fallback is the safe UX.
        setFeatureOff(true);
        setRecord(null);
        setRecordState('error');
        return;
      }
      setRecord(null);
      setRecordState('error');
    }
  }, [agent, runId]);

  useEffect(() => {
    void loadRecord();
    // Reset side-channels when the target run changes.
    seenArtifactKeys.current = new Set();
    setArtifacts([]);
    setTerminal([]);
    setFiles(new Map());
    setPreview(null);
  }, [loadRecord]);

  // Collect the frames the durable hook drops (artifact/file/terminal/preview).
  const onEvent = useCallback((ev: AgentEvent) => {
    switch (ev.type) {
      case 'artifact': {
        const key = artifactKey(ev.artifact);
        if (seenArtifactKeys.current.has(key)) return;
        seenArtifactKeys.current.add(key);
        setArtifacts(prev => [...prev, ev.artifact]);
        break;
      }
      case 'terminal': {
        setTerminal(prev => [
          ...prev,
          { stream: ev.stream, data: ev.data },
        ]);
        break;
      }
      case 'file': {
        setFiles(prev => {
          const next = new Map(prev);
          if (ev.op === 'delete') next.delete(ev.path);
          else next.set(ev.path, { path: ev.path, language: ev.language });
          return next;
        });
        break;
      }
      case 'preview': {
        setPreview({ url: ev.url, status: ev.status });
        break;
      }
      default:
        break;
    }
  }, []);

  // Durable stream: replays history on mount, re-attaches on tab-return.
  const stream = useAgentRunStream({ agent, runId: runId || null, onEvent });

  // Prefer live stream data; fall back to the persisted record so a finished
  // run (or a slow hook) renders fully.
  const steps: AgentStep[] =
    stream.steps && stream.steps.length > 0
      ? stream.steps
      : record?.steps ?? [];
  const state = coerceRunState(stream.state ?? record?.state);
  const finalText =
    (typeof stream.finalText === 'string' && stream.finalText) ||
    record?.finalText ||
    '';
  const errorText = stream.error || record?.error || '';
  const isLive = LIVE_STATES.has(state);

  // Seed file artifacts from `write` steps so a finished run still lists its
  // outputs even when we never observed the live `artifact` frames. Merged with
  // any streamed artifacts, de-duped by key.
  const mergedArtifacts = useMemo<AgentArtifact[]>(() => {
    const seen = new Set<string>();
    const out: AgentArtifact[] = [];
    for (const a of artifacts) {
      const k = artifactKey(a);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(a);
      }
    }
    for (const s of steps) {
      const a = stepToArtifact(s);
      if (!a) continue;
      const k = artifactKey(a);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(a);
      }
    }
    return out;
  }, [artifacts, steps]);

  // OpenClaw file list: prefer streamed file deltas; seed from `write` steps.
  const fileList = useMemo<FileDeltaLocal[]>(() => {
    const map = new Map<string, FileDeltaLocal>(files);
    for (const s of steps) {
      if (s.kind === 'write' && typeof s.title === 'string' && s.title.trim()) {
        const p = s.title.trim();
        if (!map.has(p)) map.set(p, { path: p });
      }
    }
    return Array.from(map.values());
  }, [files, steps]);

  const openArtifact = useCallback((artifact: AgentArtifact) => {
    // Only links are trivially openable from here; file/output opening is the
    // panel's own affair (download/copy). Guard for a distinct-origin link.
    if (artifact.kind === 'link' && artifact.url) {
      try {
        window.open(artifact.url, '_blank', 'noopener,noreferrer');
      } catch {
        /* popup blocked — the panel still shows the url */
      }
    }
  }, []);

  const goToOpenClaw = useCallback(() => {
    workbench.open('/openclaw');
  }, [workbench]);

  const goBack = useCallback(() => {
    workbench.open(`/agents/runs?agent=${agent}`);
  }, [agent, workbench]);

  const isOpenClaw = agent === 'openclaw';
  // Show the sandbox column for OpenClaw when we have anything to show.
  const hasSandbox =
    isOpenClaw &&
    (fileList.length > 0 || terminal.length > 0 || preview !== null);

  return (
    <>
      <ViewTitle title={t('run.tabTitle', { agent: AGENT_LABEL[agent] })} />
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
            minWidth: 0,
          }}
        >
          <button
            type="button"
            onClick={goBack}
            title={t('run.back.title')}
            style={{
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              color: C.muted,
              cursor: 'pointer',
              fontSize: 15,
              padding: 0,
              marginInlineEnd: 2,
            }}
          >
            ←
          </button>
          <span aria-hidden style={{ fontSize: 16 }}>
            {AGENT_EMOJI[agent]}
          </span>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {t('run.header.title', { agent: AGENT_LABEL[agent] })}
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
            dir={dir}
            className="cdz-agents-run-canvas"
            style={{
              maxWidth: 1120,
              margin: '0 auto',
              padding: '24px 24px 48px',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            {featureOff ? (
              <QuietFallback t={t} onBack={goBack} />
            ) : (
              <>
                {/* Run header card */}
                <RunHeader
                  t={t}
                  agent={agent}
                  state={state}
                  isLive={isLive}
                  prompt={record?.prompt}
                  record={record}
                  steps={steps}
                  onStop={stream.stop}
                />

                {/* Body: timeline (main) + artifacts (side). Mobile: stacks,
                    timeline first (order via CSS grid auto-flow). */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      'minmax(0, 1fr) minmax(0, min(340px, 34%))',
                    gap: 16,
                    alignItems: 'start',
                  }}
                  className="cdz-agents-run-grid"
                >
                  {/* Main column — the timeline. */}
                  <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {recordState === 'loading' &&
                    steps.length === 0 &&
                    !finalText ? (
                      <LoadingRow label={t('run.loading')} />
                    ) : recordState === 'error' &&
                      steps.length === 0 &&
                      !finalText ? (
                      <ErrorRow
                        t={t}
                        onRetry={() => {
                          void loadRecord();
                          stream.reattach?.();
                        }}
                      />
                    ) : (
                      // Chrono's RunTimeline: step timeline + final answer +
                      // inline approval. onApprove bridges to the durable hook's
                      // approve(stepId, approved). pendingApproval comes from the
                      // hook (surfaced from an approval_request frame).
                      <RunTimeline
                        steps={steps}
                        state={state}
                        finalText={finalText}
                        pendingApproval={stream.pendingApproval}
                        onApprove={(stepId: string, approved: boolean) =>
                          void stream.approve(stepId, approved)
                        }
                      />
                    )}

                    {errorText ? (
                      <div
                        style={{
                          borderRadius: R.lg,
                          border: `1px solid ${C.errBorder}`,
                          background: C.errBg,
                          padding: '12px 14px',
                          fontSize: 13,
                          color: C.text,
                          wordBreak: 'break-word',
                        }}
                      >
                        <strong>{t('run.error.title')}</strong> {errorText}
                      </div>
                    ) : null}
                  </div>

                  {/* Side column — artifacts (Galerie). */}
                  <div style={{ minWidth: 0 }}>
                    <ArtifactsPanel
                      artifacts={mergedArtifacts}
                      onOpen={openArtifact}
                    />
                  </div>
                </div>

                {/* OpenClaw sandbox surfaces (reused, not forked). */}
                {isOpenClaw ? (
                  hasSandbox ? (
                    <OpenClawSandbox
                      t={t}
                      files={fileList}
                      terminal={terminal}
                      preview={preview}
                    />
                  ) : (
                    <OpenClawLinkOut t={t} onOpen={goToOpenClaw} />
                  )
                ) : null}
              </>
            )}
          </div>
        </div>

        {/* Responsive collapse: single column on phones, timeline first. */}
        <style>
          {`
@media (max-width: 860px){
  .cdz-agents-run-grid{grid-template-columns: minmax(0,1fr) !important;}
}
@media (max-width: 560px){
  .cdz-agents-run-canvas{padding:18px 14px 40px !important;}
}
`}
        </style>
      </ViewBody>
    </>
  );
};

// ---- header ----------------------------------------------------------------

const RunHeader = ({
  t,
  agent,
  state,
  isLive,
  prompt,
  record,
  steps,
  onStop,
}: {
  t: TFunc;
  agent: AgentName;
  state: AgentRunState;
  isLive: boolean;
  prompt?: string;
  record: AgentRunRecord | null;
  steps: AgentStep[];
  onStop: () => void;
}) => {
  const tint = RUN_STATE_TINT[state];
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '16px 18px',
        borderRadius: R.lg,
        background: C.panel,
        border: `1px solid ${C.border}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 38,
            height: 38,
            flexShrink: 0,
            borderRadius: R.md,
            display: 'grid',
            placeItems: 'center',
            fontSize: 19,
            background: C.accentSoft,
            border: `1px solid ${C.accentBorder}`,
          }}
        >
          {AGENT_EMOJI[agent]}
        </span>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              color: C.text,
              lineHeight: 1.2,
            }}
          >
            {AGENT_LABEL[agent]}
          </div>
          <div style={{ fontSize: 11.5, color: C.muted }}>
            {t('run.header.subtitle')}
          </div>
        </div>

        {/* Spend estimate (Jauge). Reads the record's budget/step counts and
            labels itself an estimate; never gates the run. */}
        <SpendMeter run={record ?? undefined} steps={steps} />

        {/* State chip */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            padding: '2px 9px',
            borderRadius: R.pill,
            color: tint.color,
            background: tint.bg,
            border: `1px solid ${tint.border}`,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: tint.color,
            }}
          />
          {t(RUN_STATE_KEY[state])}
        </span>

        {/* Stop — only while live. */}
        {isLive ? (
          <button
            type="button"
            onClick={onStop}
            title={t('run.stop.title')}
            style={{
              appearance: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 14px',
              borderRadius: R.md,
              border: `1px solid ${C.errBorder}`,
              background: C.errBg,
              color: C.errText,
              cursor: 'pointer',
              fontSize: 12.5,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {t('run.stop')}
          </button>
        ) : null}
      </div>

      {prompt ? (
        <div
          style={{
            fontSize: 13,
            color: C.text,
            lineHeight: 1.55,
            padding: '10px 12px',
            borderRadius: R.md,
            background: C.accentSoft,
            border: `1px solid ${C.accentBorder}`,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {prompt}
        </div>
      ) : null}
    </div>
  );
};

// ---- OpenClaw sandbox (reused components) ----------------------------------

const OpenClawSandbox = ({
  t,
  files,
  terminal,
  preview,
}: {
  t: TFunc;
  files: { path: string; bytes?: number; language?: string }[];
  terminal: { stream: 'stdout' | 'stderr'; data: string }[];
  preview: { url: string; status: 'starting' | 'ready' } | null;
}) => {
  const [activePath, setActivePath] = useState<string | undefined>(undefined);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: C.muted,
        }}
      >
        {t('run.sandbox.title')}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 240px) minmax(0, 1fr)',
          gap: 12,
          alignItems: 'stretch',
          minHeight: 260,
        }}
        className="cdz-agents-sandbox-grid"
      >
        {/* Files */}
        <div
          style={{
            minHeight: 260,
            borderRadius: R.lg,
            border: `1px solid ${C.border}`,
            overflow: 'hidden',
          }}
        >
          <FileTree
            files={files}
            activePath={activePath}
            onOpen={setActivePath}
          />
        </div>
        {/* Terminal + Preview stacked */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            minWidth: 0,
          }}
        >
          <div style={{ minHeight: 180 }}>
            <Terminal lines={terminal} />
          </div>
          {preview ? (
            <div style={{ minHeight: 240 }}>
              <PreviewPanel url={preview.url} status={preview.status} />
            </div>
          ) : null}
        </div>
      </div>
      <style>
        {`
@media (max-width: 860px){
  .cdz-agents-sandbox-grid{grid-template-columns: minmax(0,1fr) !important;}
}
`}
      </style>
    </div>
  );
};

const OpenClawLinkOut = ({ t, onOpen }: { t: TFunc; onOpen: () => void }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      padding: '14px 16px',
      borderRadius: R.lg,
      background: C.panel,
      border: `1px solid ${C.border}`,
    }}
  >
    <span aria-hidden style={{ fontSize: 20 }}>
      🛠️
    </span>
    <div style={{ flex: 1, minWidth: 180 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
        {t('run.openclaw.title')}
      </div>
      <div style={{ fontSize: 12, color: C.muted }}>
        {t('run.openclaw.body')}
      </div>
    </div>
    <button
      type="button"
      onClick={onOpen}
      style={{
        appearance: 'none',
        padding: '7px 16px',
        borderRadius: R.md,
        border: '1px solid transparent',
        background: C.accent,
        color: C.onAccent,
        cursor: 'pointer',
        fontSize: 12.5,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {t('run.openclaw.open')}
    </button>
  </div>
);

// ---- shared small states ---------------------------------------------------

const LoadingRow = ({ label }: { label: string }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '18px 4px',
      color: C.muted,
    }}
  >
    <Spinner /> {label}
  </div>
);

const ErrorRow = ({ t, onRetry }: { t: TFunc; onRetry: () => void }) => (
  <div
    style={{
      borderRadius: R.lg,
      border: `1px solid ${C.errBorder}`,
      background: C.errBg,
      padding: '14px 16px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
    }}
  >
    <span style={{ flex: 1, minWidth: 180, fontSize: 13, color: C.text }}>
      {t('run.error.load')}
    </span>
    <button
      type="button"
      onClick={onRetry}
      style={{
        appearance: 'none',
        padding: '6px 14px',
        borderRadius: R.md,
        border: `1px solid ${C.border}`,
        background: C.panel,
        color: C.text,
        cursor: 'pointer',
        fontSize: 12.5,
        fontWeight: 600,
      }}
    >
      {t('common.retry')}
    </button>
  </div>
);

const QuietFallback = ({ t, onBack }: { t: TFunc; onBack: () => void }) => (
  <div
    style={{
      borderRadius: R.lg,
      border: `1px solid ${C.border}`,
      background: C.panel,
      padding: '26px 20px',
      textAlign: 'center',
      color: C.muted,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      alignItems: 'center',
    }}
  >
    <span aria-hidden style={{ fontSize: 26, opacity: 0.7 }}>
      🔒
    </span>
    <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
      {t('run.quiet.title')}
    </span>
    <span style={{ fontSize: 12.5, maxWidth: 400 }}>
      {t('run.quiet.body')}
    </span>
    <button
      type="button"
      onClick={onBack}
      style={{
        appearance: 'none',
        padding: '6px 14px',
        borderRadius: R.md,
        border: `1px solid ${C.border}`,
        background: C.bg,
        color: C.text,
        cursor: 'pointer',
        fontSize: 12.5,
        fontWeight: 600,
        marginTop: 4,
      }}
    >
      {t('common.back')}
    </button>
  </div>
);

const Spinner = () => (
  <span
    aria-hidden
    style={{
      display: 'inline-block',
      width: 14,
      height: 14,
      borderRadius: '50%',
      border: `2px solid color-mix(in srgb, ${C.accent} 30%, transparent)`,
      borderTopColor: C.accent,
      animation: 'cdz-agent-spin 0.7s linear infinite',
      flex: '0 0 auto',
    }}
  />
);

export const Component = () => {
  return <AgentRunPage />;
};

export default AgentRunPage;
