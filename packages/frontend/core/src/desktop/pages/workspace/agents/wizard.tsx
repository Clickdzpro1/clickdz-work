// ---------------------------------------------------------------------------
// "Hire an employee" wizard — the goal-first onboarding for the unified /agents
// studio (router lazy target at /agents/new). It reframes agent setup as HIRING
// an employee for a concrete job, not configuring a cron:
//
//   Step 1  Pick a job-to-be-done (JTBD_PRESETS) — or « Partir de zéro »
//   Step 2  Name + persona            (prefilled from the chosen job)
//   Step 3  Tools & channels review    (web toggle · Telegram/WhatsApp badges
//                                        read live caps; WA = "bientôt")
//   Step 4  Déclencheur / planning     (R8: REAL preset scheduling — manuel OU
//                                        Chaque heure / Chaque jour à HH:MM /
//                                        Chaque lundi à HH:MM; a cron trigger is
//                                        created on finish via createTrigger)
//   Step 5  Essai (test-run)           (kick a background run with the starter
//                                        prompt → link to its run view)
//   Finish  Provision via the EXISTING per-user config endpoint, then → /agents
//
// PROVISIONING REUSE (no new API invented):
//   · agent === 'hermes'   → saveConfig()  from ../hermes/hermes-shared
//                            (PUT /api/v1/hermes/config, sets provisioned:true)
//   · agent === 'openclaw' → putConfig()   from ../openclaw/openclaw-shared
//                            (PUT /api/v1/openclaw/config, sets provisioned:true)
//   The wizard branches by JTBD.agent — exactly the two provisioning calls the
//   shipping hermes/openclaw wizards already use.
//
// TEST-RUN REUSE: startBackgroundRun(agent, prompt) from modules/agents/api
//   (POST /api/v1/agents/:agent/runs) — the R6 durable-run entry point.
//
// Consumed sibling contracts (by name, R7): Annuaire's useAgents() →
//   { agents, caps, loading, error, reload } with caps.{multi,telegramEnabled,
//   webEnabled,dzdPer1k}. The wizard degrades gracefully when the hook is
//   unavailable (feature dark / 404) — channels fall back to web-only display
//   and provisioning still works.
//
// House rules: default export (+ a `Component` alias for the router's lazy
// convention), inline styles only (reuse the shared AgentPalette + hermes-shared
// primitives), no .css.ts, no new deps, FR primary + darja hints, mobile single
// -column, and loading/error states per step.
// ---------------------------------------------------------------------------

import { createTrigger, startBackgroundRun } from '@affine/core/modules/agents/api';
import { AgentPalette } from '@affine/core/modules/agents/components';
// Locale (R8, WSU-7) owns this i18n module: `useAgentLang()` → { lang, setLang,
// t, dir }. `t(key, vars?)` is fail-soft — an unknown key returns the key
// itself, so any string we haven't catalogued degrades to readable text rather
// than throwing. Consumed by contract name; may not resolve in an isolated
// single-file esbuild check (same as the sibling `useAgents` import below).
import { type TFunc, useAgentLang } from '@affine/core/modules/agents/i18n';
import type { AgentName } from '@affine/core/modules/agents/types';
// Annuaire (R7) owns this hook; it may not resolve in an isolated single-file
// esbuild check — expected, same pattern the openclaw page uses for its C9
// workspace imports. Consumed by contract name.
import { useAgents } from '@affine/core/modules/agents/use-agents';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchService,
} from '@affine/core/modules/workbench';
import { useService } from '@toeverything/infra';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from 'react';

// Reuse the shipping provisioning calls + the shared inline-styled primitives
// (palette, buttons, banner, spinner, field, inputs). No duplication.
import {
  Banner,
  btnStyle,
  C,
  type HermesConfigInput,
  hintStyle,
  inputStyle,
  saveConfig,
  textareaStyle,
  validateAgentName,
  validatePersona,
} from '../hermes/hermes-shared';
import { putConfig } from '../openclaw/openclaw-shared';
import {
  getJtbdPreset,
  type JtbdChannel,
  JTBD_PRESETS,
  type JtbdPreset,
} from './jtbd-presets';

const mono = AgentPalette.font.mono;

// ---------------------------------------------------------------------------
// Local, defensive mirror of Annuaire's AgentCaps (R7). We only READ the fields
// we need; a missing hook / 404 collapses to this safe default so the wizard is
// always usable (web on, other channels "bientôt").
// ---------------------------------------------------------------------------
interface Caps {
  multi: boolean;
  telegramEnabled: boolean;
  webEnabled: boolean;
  dzdPer1k: number;
}
const CAPS_FALLBACK: Caps = {
  multi: false,
  telegramEnabled: false,
  webEnabled: true,
  dzdPer1k: 0,
};

// Steps of the hire flow.
type Step = 'job' | 'identity' | 'tools' | 'trigger' | 'test';
const FLOW: Step[] = ['job', 'identity', 'tools', 'trigger', 'test'];
// i18n key per step (Locale catalog `wizard.step.*`). The Stepper resolves these
// through `t()` so the label follows the active language; a missing key fails
// soft to the key text (Locale ships every one of these).
const STEP_LABEL_KEY: Record<Step, string> = {
  job: 'wizard.step.job',
  identity: 'wizard.step.identity',
  tools: 'wizard.step.tools',
  trigger: 'wizard.step.trigger',
  test: 'wizard.step.test',
};

// The provisioning phase (after the user confirms hiring on the last step).
type HirePhase =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; agent: AgentName };

// The test-run phase (kicked on the Essai step; independent of hiring).
type RunPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'started'; agent: AgentName; runId: string }
  | { kind: 'error'; message: string };

// A tasteful default persona when hiring from scratch.
const SCRATCH_PERSONA =
  'Un assistant opérationnel pour mes boutiques : lis mes commandes et mes données ERP, résume ce qui demande attention et prépare les suivis — montre-moi toujours les envois et écritures avant de les faire.';

// ---------------------------------------------------------------------------
// Trigger preset model (R8). The step-4 picker builds a Horloge preset id from
// a coarse cadence choice + (for daily/weekly) an HH:MM time and (weekly) a
// day-of-week. The id shapes are EXACTLY Horloge's contract (parsePreset):
//   'hourly'            — every hour
//   'daily@HH:MM'       — every day at HH:MM (Africa/Algiers)
//   'weekly@D@HH:MM'    — every week on day D (1=Mon .. 7=Sun) at HH:MM
// `null` (the default "Manuel" choice) creates NO trigger — the agent stays
// on-demand, byte-identical to the pre-R8 wizard.
// ---------------------------------------------------------------------------
type Cadence = 'manual' | 'hourly' | 'daily' | 'weekly';

// Day-of-week options for the weekly picker (D = 1..7, Mon..Sun — Horloge's
// convention). FR label + a short darja hint mirror the bilingual register.
const DOW_OPTIONS: { value: number; fr: string }[] = [
  { value: 1, fr: 'Lundi' },
  { value: 2, fr: 'Mardi' },
  { value: 3, fr: 'Mercredi' },
  { value: 4, fr: 'Jeudi' },
  { value: 5, fr: 'Vendredi' },
  { value: 6, fr: 'Samedi' },
  { value: 7, fr: 'Dimanche' },
];

// Validate an HH:MM string (00:00..23:59). The <input type="time"> already
// constrains this, but we re-check before building an id so a hand-typed value
// can never persist junk (fail closed → treated as no preset).
function isValidTime(hhmm: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

// Normalize an HH:MM to zero-padded 2-digit hour (Horloge accepts H or HH but
// we always emit HH:MM for a stable, canonical id).
function padTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!m) return '09:00';
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

/**
 * Build a Horloge preset id from the picker state, or null for 'manual' / an
 * invalid time (fail closed). Pure — the wizard calls it on finish + to gate
 * the "will schedule" summary.
 */
function buildPreset(
  cadence: Cadence,
  time: string,
  dow: number
): string | null {
  switch (cadence) {
    case 'hourly':
      return 'hourly';
    case 'daily':
      return isValidTime(time) ? `daily@${padTime(time)}` : null;
    case 'weekly': {
      const d = dow >= 1 && dow <= 7 ? dow : 1;
      return isValidTime(time) ? `weekly@${d}@${padTime(time)}` : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Page component.
// ---------------------------------------------------------------------------
const AgentsWizardPage = () => {
  const workbench = useService(WorkbenchService).workbench;
  const navigate = useCallback(
    (route: string) => {
      try {
        workbench.open(route);
      } catch {
        // Extremely defensive: navigation must never throw out of a click.
      }
    },
    [workbench]
  );

  // ---- i18n (Locale, R8). `t` is fail-soft; `dir` flips the shell to RTL for
  // Arabic. The wizard has no language toggle of its own (the /agents home
  // header owns it — Retouche); it simply follows the persisted choice. ----
  const { t, dir } = useAgentLang();

  // ---- caps (channels) via Annuaire; degrade to fallback if unavailable ----
  const caps = useCapsSafe();

  // ---- step machine ----
  const [stepIdx, setStepIdx] = useState(0);
  const step = FLOW[stepIdx];

  // ---- selection + config model ----
  // `null` = nothing picked yet · 'scratch' = start from zero · else a preset id.
  const [choice, setChoice] = useState<string | null>(null);
  const preset = useMemo(() => getJtbdPreset(choice), [choice]);
  const agent: AgentName = preset?.agent ?? 'hermes';

  const [agentName, setAgentName] = useState('');
  const [persona, setPersona] = useState('');
  const [webOn, setWebOn] = useState(true);
  const [tools, setTools] = useState<string[]>([]);
  // Whether the user has hand-edited identity (so re-picking a job can refill).
  const [identityTouched, setIdentityTouched] = useState(false);

  const [hire, setHire] = useState<HirePhase>({ kind: 'idle' });
  const [run, setRun] = useState<RunPhase>({ kind: 'idle' });

  // ---- step-4 trigger picker state (R8). Default 'manual' ⇒ no trigger, the
  // agent stays on-demand (unchanged behaviour). `triggerTime` seeds 09:00 (the
  // canonical morning slot the JTBD reports assume); `triggerDow` seeds Monday.
  const [cadence, setCadence] = useState<Cadence>('manual');
  const [triggerTime, setTriggerTime] = useState('09:00');
  const [triggerDow, setTriggerDow] = useState(1);
  const selectedPreset = useMemo(
    () => buildPreset(cadence, triggerTime, triggerDow),
    [cadence, triggerTime, triggerDow]
  );

  // Apply a choice's defaults into the model. `p === 'scratch'` clears to a
  // blank Hermes ops agent; a preset prefills name/persona/tools/channels.
  const applyChoice = useCallback(
    (p: JtbdPreset | 'scratch') => {
      const isScratch = p === 'scratch';
      setChoice(isScratch ? 'scratch' : p.id);
      setRun({ kind: 'idle' });
      // Only overwrite identity the user hasn't hand-edited.
      if (!identityTouched) {
        setAgentName(isScratch ? 'Hermes' : defaultNameFor(p));
        setPersona(isScratch ? SCRATCH_PERSONA : personaFor(p));
      }
      setTools(isScratch ? [] : p.suggestedTools);
      setWebOn(isScratch ? true : p.suggestedChannels.includes('web'));
    },
    [identityTouched]
  );

  // ---- validation ----
  const nameErr = validateAgentName(agentName);
  const personaErr = validatePersona(persona);
  const canAdvance = ((): boolean => {
    switch (step) {
      case 'job':
        // Must pick a job OR explicitly choose "from scratch".
        return choice !== null;
      case 'identity':
        return !nameErr && !personaErr;
      default:
        return true;
    }
  })();

  const next = useCallback(
    () => setStepIdx(i => Math.min(i + 1, FLOW.length - 1)),
    []
  );
  const back = useCallback(() => setStepIdx(i => Math.max(i - 1, 0)), []);

  // The starter task the agent runs — the preset's ready-made prompt, else the
  // persona. Also used as the scheduled trigger's prompt (a preset-scheduled
  // agent should run its signature task each cycle). Declared before finishHire
  // so the finish path can persist it as the trigger prompt.
  const starterPrompt = useMemo(() => {
    if (preset) return preset.starterPrompt;
    return persona.trim() || SCRATCH_PERSONA;
  }, [preset, persona]);

  // ---- provisioning (branch by agent → the EXISTING config endpoint) -------
  const finishHire = useCallback(async () => {
    setHire({ kind: 'saving' });
    const name = agentName.trim() || (agent === 'openclaw' ? 'OpenClaw' : 'Hermes');

    // If a schedule was picked, create the cron trigger AFTER provisioning
    // succeeds. Best-effort: a trigger failure (feature dark → 404, or a cap)
    // must NEVER block the hire — the agent is still saved and the user lands on
    // /agents. The prompt is the agent's starter task, clamped to Horloge's
    // 8000-char ceiling by the backend.
    const scheduleAfterHire = async () => {
      if (!selectedPreset) return;
      const prompt = (starterPrompt || '').trim();
      if (prompt.length < 2) return; // Horloge requires ≥2 chars — skip empties.
      try {
        await createTrigger(agent, {
          kind: 'cron',
          preset: selectedPreset,
          prompt,
        });
      } catch {
        // Triggers feature off / cap / transport — silently skip. The hire has
        // already succeeded; the user can add a schedule later from /agents/triggers.
      }
    };

    try {
      if (agent === 'openclaw') {
        // OpenClaw provisioning: PUT /api/v1/openclaw/config (putConfig). The
        // coding agent has no tool/persona fields — persist the sensible
        // defaults the shipping wizard uses.
        await putConfig({ defaultRuntime: 'node24', previewAutoOpen: true });
        await scheduleAfterHire();
        setHire({ kind: 'done', agent });
        return;
      }
      // Hermes provisioning: PUT /api/v1/hermes/config (saveConfig).
      const input: HermesConfigInput = {
        agentName: name,
        personaGoal: persona.trim() || SCRATCH_PERSONA,
        enabledTools: tools,
        defaultMode: 'ask',
        savedWorkflows: preset
          ? [{ title: preset.titleFr, goal: preset.starterPrompt }]
          : [],
      };
      const outcome = await saveConfig(input);
      if (outcome.status === 'ok') {
        await scheduleAfterHire();
        setHire({ kind: 'done', agent });
        return;
      }
      setHire({ kind: 'error', message: outcome.message });
    } catch (err) {
      setHire({
        kind: 'error',
        message:
          err instanceof Error && err.message
            ? err.message
            : t('wizard.hire.err.generic'),
      });
    }
  }, [agent, agentName, persona, tools, preset, selectedPreset, starterPrompt, t]);

  // ---- test-run (reuse startBackgroundRun) ---------------------------------
  const startTest = useCallback(async () => {
    setRun({ kind: 'starting' });
    try {
      const { runId } = await startBackgroundRun(agent, starterPrompt);
      setRun({ kind: 'started', agent, runId });
    } catch (err) {
      // A 404 means the durable-run feature is dark — say so without blocking.
      const status = (err as { status?: number } | null)?.status;
      const message =
        status === 404
          ? t('wizard.test.err.404')
          : status === 429
            ? t('wizard.test.err.429')
            : err instanceof Error && err.message
              ? err.message
              : t('wizard.test.err.generic');
      setRun({ kind: 'error', message });
    }
  }, [agent, starterPrompt, t]);

  // ---- terminal hire phases render standalone ------------------------------
  if (hire.kind === 'done') {
    return (
      <Shell t={t} dir={dir}>
        <DoneCard
          t={t}
          agent={hire.agent}
          name={agentName.trim() || (hire.agent === 'openclaw' ? 'OpenClaw' : 'Hermes')}
          onOpenAgents={() => navigate('/agents')}
        />
      </Shell>
    );
  }

  // ---- step body -----------------------------------------------------------
  return (
    <Shell t={t} dir={dir}>
      <div style={cardStyle}>
        <Stepper t={t} stepIdx={stepIdx} />

        {step === 'job' ? (
          <JobStep t={t} choice={choice} onPick={applyChoice} />
        ) : null}

        {step === 'identity' ? (
          <IdentityStep
            t={t}
            agent={agent}
            preset={preset}
            name={agentName}
            persona={persona}
            nameErr={touchedErr(nameErr, identityTouched)}
            personaErr={touchedErr(personaErr, identityTouched)}
            onName={v => {
              setIdentityTouched(true);
              setAgentName(v);
            }}
            onPersona={v => {
              setIdentityTouched(true);
              setPersona(v);
            }}
          />
        ) : null}

        {step === 'tools' ? (
          <ToolsStep
            t={t}
            agent={agent}
            caps={caps}
            preset={preset}
            tools={tools}
            webOn={webOn}
            onWeb={setWebOn}
            onNavigate={navigate}
          />
        ) : null}

        {step === 'trigger' ? (
          <TriggerStep
            t={t}
            cadence={cadence}
            time={triggerTime}
            dow={triggerDow}
            onCadence={setCadence}
            onTime={setTriggerTime}
            onDow={setTriggerDow}
          />
        ) : null}

        {step === 'test' ? (
          <TestStep
            t={t}
            agent={agent}
            name={agentName.trim() || (agent === 'openclaw' ? 'OpenClaw' : 'Hermes')}
            starterPrompt={starterPrompt}
            run={run}
            onStart={() => void startTest()}
            onOpenRun={(a, id) => navigate(`/agents/run/${id}?agent=${a}`)}
          />
        ) : null}

        {/* Hire error surfaces inline above the footer (never a dead-end). */}
        {hire.kind === 'error' ? (
          <div style={{ marginTop: 16 }}>
            <Banner tone="error">{hire.message}</Banner>
          </div>
        ) : null}

        {/* Footer nav */}
        <div style={footerStyle}>
          {stepIdx > 0 ? (
            <button style={btnStyle('secondary')} onClick={back} disabled={hire.kind === 'saving'}>
              {t('common.back')}
            </button>
          ) : (
            <button style={btnStyle('secondary')} onClick={() => navigate('/agents')}>
              {t('common.cancel')}
            </button>
          )}
          <div style={{ flex: 1 }} />
          {step === 'test' ? (
            <button
              style={btnStyle('primary', hire.kind === 'saving')}
              disabled={hire.kind === 'saving'}
              onClick={() => void finishHire()}
            >
              {hire.kind === 'saving'
                ? t('wizard.hire.saving')
                : agent === 'openclaw'
                  ? t('wizard.hire.openclaw')
                  : t('wizard.hire.hermes')}
            </button>
          ) : (
            <button
              style={btnStyle('primary', !canAdvance)}
              disabled={!canAdvance}
              onClick={next}
            >
              {t('common.continue')}
            </button>
          )}
        </div>
      </div>
    </Shell>
  );
};

// Read Annuaire's caps defensively. The hook throwing (unresolved / provider
// missing) must never crash the wizard — we swallow and use the fallback.
function useCapsSafe(): Caps {
  try {
    const res = (useAgents as unknown as () => { caps?: Partial<Caps> } | undefined)();
    const c = res?.caps;
    if (!c) return CAPS_FALLBACK;
    return {
      multi: c.multi ?? CAPS_FALLBACK.multi,
      telegramEnabled: c.telegramEnabled ?? CAPS_FALLBACK.telegramEnabled,
      webEnabled: c.webEnabled ?? CAPS_FALLBACK.webEnabled,
      dzdPer1k: c.dzdPer1k ?? CAPS_FALLBACK.dzdPer1k,
    };
  } catch {
    return CAPS_FALLBACK;
  }
}

// Only show a field error once the user has diverged from the seeded default.
function touchedErr(err: string | null, touched: boolean): string | null {
  return touched ? err : null;
}

function defaultNameFor(p: JtbdPreset): string {
  if (p.agent === 'openclaw') return 'OpenClaw';
  // A friendly employee name derived from the job.
  switch (p.id) {
    case 'cod-confirm':
      return 'Agent COD';
    case 'whatsapp-support':
      return 'Support WhatsApp';
    case 'competitor-watch':
      return 'Veille concurrence';
    case 'daily-sales-report':
      return 'Rapport ventes';
    default:
      return 'Hermes';
  }
}

function personaFor(p: JtbdPreset): string {
  // Seed the persona from the job's description + starter intent.
  return `${p.desc}`;
}

// ---------------------------------------------------------------------------
// Step 1 — pick a job-to-be-done (or start from scratch).
// ---------------------------------------------------------------------------
const JobStep = ({
  t,
  choice,
  onPick,
}: {
  t: TFunc;
  choice: string | null;
  onPick: (p: JtbdPreset | 'scratch') => void;
}) => (
  <StepShell
    emoji="🧑‍💼"
    title={t('wizard.job.title')}
    subtitle={t('wizard.job.subtitle')}
  >
    <div style={gridStyle}>
      {JTBD_PRESETS.map(p => {
        const on = choice === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p)}
            style={jobCardStyle(on)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 24 }} aria-hidden>
                {p.emoji}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                {/* JTBD copy is pure data (jtbd-presets.ts) — not in the i18n
                    catalog; rendered verbatim as the job's own FR/darja label. */}
                <span style={jobTitleStyle}>{p.titleFr}</span>
                <span style={jobDarjaStyle} dir="rtl">
                  {p.titleDarja}
                </span>
              </span>
              {on ? <span style={{ color: C.accent, fontSize: 16 }}>✓</span> : null}
            </div>
            <span style={jobDescStyle}>{p.desc}</span>
            <span style={jobTagStyle}>
              {p.agent === 'openclaw' ? t('wizard.job.devTag') : t('wizard.job.opsTag')}
            </span>
          </button>
        );
      })}

      {/* Start from scratch — selects with the 'scratch' sentinel. */}
      <button
        type="button"
        onClick={() => onPick('scratch')}
        style={{
          ...jobCardStyle(choice === 'scratch'),
          borderStyle: 'dashed',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 24 }} aria-hidden>
            ⬜
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={jobTitleStyle}>{t('wizard.job.scratch.title')}</span>
            <span style={jobDarjaStyle} dir="rtl">
              {t('wizard.job.scratch.darja')}
            </span>
          </span>
        </div>
        <span style={jobDescStyle}>{t('wizard.job.scratch.desc')}</span>
      </button>
    </div>
  </StepShell>
);

// ---------------------------------------------------------------------------
// Step 2 — name + persona (prefilled from the job).
// ---------------------------------------------------------------------------
const IdentityStep = ({
  t,
  agent,
  preset,
  name,
  persona,
  nameErr,
  personaErr,
  onName,
  onPersona,
}: {
  t: TFunc;
  agent: AgentName;
  preset: JtbdPreset | undefined;
  name: string;
  persona: string;
  nameErr: string | null;
  personaErr: string | null;
  onName: (v: string) => void;
  onPersona: (v: string) => void;
}) => (
  <StepShell
    emoji="🏷️"
    title={t('wizard.identity.title')}
    subtitle={
      preset
        ? t('wizard.identity.subtitle.preset', { job: preset.titleFr })
        : t('wizard.identity.subtitle.blank')
    }
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <LabeledField
        label={t('wizard.identity.name.label')}
        hint={t('wizard.identity.name.hint')}
        error={nameErr}
      >
        <input
          style={inputStyle}
          value={name}
          maxLength={40}
          placeholder={agent === 'openclaw' ? 'OpenClaw' : 'Hermes'}
          onChange={e => onName(e.target.value)}
          autoFocus
        />
      </LabeledField>
      {agent === 'openclaw' ? (
        <Banner tone="info">{t('wizard.identity.openclaw.note')}</Banner>
      ) : (
        <LabeledField
          label={t('wizard.identity.persona.label')}
          hint={t('wizard.identity.persona.hint')}
          error={personaErr}
        >
          <textarea
            style={textareaStyle}
            value={persona}
            maxLength={600}
            placeholder={SCRATCH_PERSONA}
            onChange={e => onPersona(e.target.value)}
          />
        </LabeledField>
      )}
    </div>
  </StepShell>
);

// ---------------------------------------------------------------------------
// Step 3 — tools & channels review.
// ---------------------------------------------------------------------------
const ToolsStep = ({
  t,
  agent,
  caps,
  preset,
  tools,
  webOn,
  onWeb,
  onNavigate,
}: {
  t: TFunc;
  agent: AgentName;
  caps: Caps;
  preset: JtbdPreset | undefined;
  tools: string[];
  webOn: boolean;
  onWeb: (v: boolean) => void;
  onNavigate: (route: string) => void;
}) => {
  const wantsChannel = (ch: JtbdChannel): boolean =>
    preset ? preset.suggestedChannels.includes(ch) : ch === 'web';

  // The channels hint carries a `{telegram}` slot: when Telegram is NOT enabled
  // we prefix "Telegram et " so the sentence reads "Telegram et WhatsApp
  // arrivent bientôt."; when it IS enabled the slot collapses to "".
  const channelsHint = t('wizard.tools.channels.hint', {
    telegram: caps.telegramEnabled
      ? ''
      : t('wizard.tools.channels.hint.telegramPrefix'),
  });

  // The suggested-tools hint carries a `{link}` slot we render as a real button;
  // split the localized TEMPLATE around the literal token (no vars -> the fail-
  // soft interpolator leaves `{link}` intact) and interleave the link. If the
  // key is missing / has no slot, `suggAfter` is undefined and we render just the
  // leading text + link (still readable).
  const suggestedRaw = t('wizard.tools.suggested.hint');
  const [suggBefore, suggAfter] = suggestedRaw.split('{link}');

  return (
    <StepShell
      emoji="🔌"
      title={t('wizard.tools.title')}
      subtitle={t('wizard.tools.subtitle')}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Web access toggle */}
        <ToggleRow
          checked={webOn && caps.webEnabled}
          disabled={!caps.webEnabled}
          onChange={onWeb}
          emoji="🌐"
          label={t('wizard.tools.web.label')}
          hint={caps.webEnabled ? t('wizard.tools.web.on') : t('wizard.tools.web.off')}
        />

        {/* Channels — badges reading live caps */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={sectionCaptionStyle}>{t('wizard.tools.channels')}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <ChannelBadge
              t={t}
              emoji="✈️"
              label={t('card.channel.telegram')}
              // Ready when the server has Telegram enabled; else "bientôt".
              state={caps.telegramEnabled ? 'ready' : 'soon'}
              wanted={wantsChannel('telegram')}
            />
            <ChannelBadge
              t={t}
              emoji="💬"
              label={t('connections.whatsapp.title')}
              // No WA capability yet → always "bientôt" (honest, never faked).
              state="soon"
              wanted={wantsChannel('whatsapp')}
            />
          </div>
          <span style={hintStyle}>{channelsHint}</span>
        </div>

        {/* Suggested tools (Hermes) */}
        {agent === 'hermes' ? (
          tools.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={sectionCaptionStyle}>{t('wizard.tools.suggested')}</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {tools.map(tool => (
                  <span key={tool} style={toolChipStyle}>
                    {tool}
                  </span>
                ))}
              </div>
              <span style={hintStyle}>
                {suggBefore}
                <button
                  type="button"
                  style={linkLike}
                  onClick={() => onNavigate('/integrations')}
                >
                  {t('wizard.tools.integrationsLink')}
                </button>
                {suggAfter ?? ''}
              </span>
            </div>
          ) : (
            <Banner tone="info">{t('wizard.tools.noTools')}</Banner>
          )
        ) : (
          <Banner tone="info">{t('wizard.tools.openclaw.note')}</Banner>
        )}
      </div>
    </StepShell>
  );
};

// ---------------------------------------------------------------------------
// Step 4 — trigger / scheduling (R8: REAL preset scheduling). The user picks a
// cadence; on finish a cron trigger is created (Horloge) unless 'Manuel' (the
// default) is kept, in which case the agent stays purely on-demand — unchanged.
// ---------------------------------------------------------------------------
const TriggerStep = ({
  t,
  cadence,
  time,
  dow,
  onCadence,
  onTime,
  onDow,
}: {
  t: TFunc;
  cadence: Cadence;
  time: string;
  dow: number;
  onCadence: (c: Cadence) => void;
  onTime: (v: string) => void;
  onDow: (v: number) => void;
}) => {
  // The cadence options, in order. 'manual' first (the default, no trigger).
  const OPTIONS: {
    value: Cadence;
    emoji: string;
    title: string;
    hint: string;
  }[] = [
    {
      value: 'manual',
      emoji: '▶️',
      title: t('wizard.trigger.manual.title'),
      hint: t('wizard.trigger.manual.hint'),
    },
    {
      value: 'hourly',
      emoji: '⏰',
      title: t('triggers.preset.hourly'),
      hint: t('triggers.prompt.hint'),
    },
    {
      value: 'daily',
      emoji: '🗓️',
      title: t('triggers.preset.daily'),
      hint: t('triggers.prompt.hint'),
    },
    {
      value: 'weekly',
      emoji: '📅',
      title: t('triggers.preset.weekly'),
      hint: t('triggers.prompt.hint'),
    },
  ];

  return (
    <StepShell
      emoji="⏰"
      title={t('wizard.trigger.title')}
      subtitle={t('triggers.subtitle')}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {OPTIONS.map(opt => {
          const on = cadence === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onCadence(opt.value)}
              style={{
                ...triggerCardStyle(on),
                appearance: 'none',
                textAlign: 'left',
                cursor: 'pointer',
                width: '100%',
              }}
            >
              <span style={{ fontSize: 20 }} aria-hidden>
                {opt.emoji}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={triggerTitleStyle}>{opt.title}</span>
                <span style={hintStyle}>{opt.hint}</span>
              </span>
              {on ? (
                <span style={pillStyle(C.accent, C.accentSoft, C.accentBorder)}>
                  {t('common.active')}
                </span>
              ) : null}
            </button>
          );
        })}

        {/* Time input for daily/weekly; day select for weekly. */}
        {cadence === 'daily' || cadence === 'weekly' ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              padding: '12px 14px',
              borderRadius: 10,
              background: C.bg,
              border: `1px solid ${C.border}`,
            }}
          >
            {cadence === 'weekly' ? (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 140 }}>
                <span style={labelStyle}>{t('wizard.step.trigger')}</span>
                <select
                  value={dow}
                  onChange={e => onDow(Number(e.target.value))}
                  style={selectStyle}
                >
                  {DOW_OPTIONS.map(d => (
                    <option key={d.value} value={d.value}>
                      {d.fr}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 120 }}>
              <span style={labelStyle}>{t('triggers.preset.label')}</span>
              <input
                type="time"
                value={time}
                onChange={e => onTime(e.target.value)}
                style={{ ...inputStyle, fontFamily: mono }}
              />
            </label>
          </div>
        ) : null}

        <Banner tone="info">{t('triggers.prompt.hint')}</Banner>
      </div>
    </StepShell>
  );
};

// ---------------------------------------------------------------------------
// Step 5 — test-run (kick a background run + link to its run view).
// ---------------------------------------------------------------------------
const TestStep = ({
  t,
  agent: _agent,
  name,
  starterPrompt,
  run,
  onStart,
  onOpenRun,
}: {
  t: TFunc;
  agent: AgentName;
  name: string;
  starterPrompt: string;
  run: RunPhase;
  onStart: () => void;
  onOpenRun: (agent: AgentName, runId: string) => void;
}) => (
  <StepShell
    emoji="🧪"
    title={t('wizard.test.title')}
    subtitle={t('wizard.test.subtitle', { name })}
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={sectionCaptionStyle}>{t('wizard.test.taskLabel')}</span>
        <div style={promptPreviewStyle}>{starterPrompt}</div>
      </div>

      {run.kind === 'idle' ? (
        <div>
          <button style={btnStyle('secondary')} onClick={onStart}>
            {t('wizard.test.start')}
          </button>
        </div>
      ) : run.kind === 'starting' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted }}>
          <MiniSpinner /> {t('wizard.test.starting')}
        </div>
      ) : run.kind === 'started' ? (
        <Banner tone="ok">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>{t('wizard.test.started', { name })}</span>
            <div>
              <button
                style={{ ...btnStyle('primary'), padding: '7px 14px', fontSize: 12.5 }}
                onClick={() => onOpenRun(run.agent, run.runId)}
              >
                {t('wizard.test.openRun')}
              </button>
            </div>
          </div>
        </Banner>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Banner tone="warn">{run.message}</Banner>
          <div>
            <button
              style={{ ...btnStyle('secondary'), padding: '6px 12px', fontSize: 12 }}
              onClick={onStart}
            >
              {t('common.retry')}
            </button>
          </div>
        </div>
      )}

      <Banner tone="info">{t('wizard.test.banner')}</Banner>
    </div>
  </StepShell>
);

// ---------------------------------------------------------------------------
// Done screen.
// ---------------------------------------------------------------------------
const DoneCard = ({
  t,
  agent,
  name,
  onOpenAgents,
}: {
  t: TFunc;
  agent: AgentName;
  name: string;
  onOpenAgents: () => void;
}) => (
  <div style={cardStyle}>
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 40 }} aria-hidden>
        🎉
      </div>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>
        {t('wizard.done.title', { name })}
      </h2>
      <p style={{ margin: 0, fontSize: 13.5, color: C.muted, lineHeight: 1.55 }}>
        {agent === 'openclaw'
          ? t('wizard.done.openclaw')
          : t('wizard.done.hermes')}
      </p>
    </div>
    <div style={{ display: 'flex', marginTop: 24, justifyContent: 'center' }}>
      <button style={btnStyle('primary')} onClick={onOpenAgents}>
        {t('wizard.done.cta')}
      </button>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Layout + shared sub-components (inline styles, mobile-friendly).
// ---------------------------------------------------------------------------
const Shell = ({
  t,
  dir,
  children,
}: {
  t: TFunc;
  dir: 'rtl' | 'ltr';
  children: ReactNode;
}) => (
  <>
    <ViewTitle title={t('wizard.tabTitle')} />
    <ViewIcon icon="edgeless" />
    <ViewHeader>
      <div style={headerStyle}>
        <span style={{ fontSize: 16 }} aria-hidden>
          🧑‍💼
        </span>
        {t('wizard.tabTitle')}
        <span style={betaBadgeStyle}>{t('common.beta')}</span>
      </div>
    </ViewHeader>
    <ViewBody>
      <div style={scrollStyle} dir={dir}>
        <div style={innerStyle}>{children}</div>
      </div>
    </ViewBody>
  </>
);

const StepShell = ({
  emoji,
  title,
  subtitle,
  children,
}: {
  emoji: string;
  title: string;
  subtitle: string;
  children?: ReactNode;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 30 }} aria-hidden>
        {emoji}
      </div>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text }}>
        {title}
      </h2>
      <p style={{ margin: 0, fontSize: 13.5, color: C.muted, lineHeight: 1.55 }}>
        {subtitle}
      </p>
    </div>
    {children}
  </div>
);

const Stepper = ({ t, stepIdx }: { t: TFunc; stepIdx: number }) => (
  <div style={{ marginBottom: 20 }}>
    <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
      {FLOW.map((_, i) => (
        <span
          key={i}
          style={{
            height: 4,
            flex: 1,
            borderRadius: 2,
            background: i <= stepIdx ? C.accent : C.border,
            transition: 'background 200ms ease',
          }}
        />
      ))}
    </div>
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: C.muted }}>
      {t('wizard.progress', {
        current: stepIdx + 1,
        total: FLOW.length,
        label: t(STEP_LABEL_KEY[FLOW[stepIdx]]),
      })}
    </div>
  </div>
);

const LabeledField = ({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <span style={labelStyle}>{label}</span>
    {children}
    {error ? (
      <span style={{ fontSize: 12, color: 'var(--affine-error-color, #eb4b4b)' }}>{error}</span>
    ) : hint ? (
      <span style={hintStyle}>{hint}</span>
    ) : null}
  </div>
);

const ToggleRow = ({
  checked,
  disabled,
  onChange,
  emoji,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  emoji: string;
  label: string;
  hint?: string;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => !disabled && onChange(!checked)}
    style={{
      appearance: 'none',
      textAlign: 'left',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: '13px 14px',
      borderRadius: 10,
      background: C.bg,
      border: `1px solid ${checked ? C.accentBorder : C.border}`,
      color: C.text,
      transition: 'border-color 150ms ease',
    }}
  >
    <span style={{ fontSize: 20 }} aria-hidden>
      {emoji}
    </span>
    <span style={{ flex: 1, minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: C.text }}>
        {label}
      </span>
      {hint ? <span style={hintStyle}>{hint}</span> : null}
    </span>
    <span
      aria-hidden
      style={{
        width: 38,
        height: 22,
        flexShrink: 0,
        borderRadius: 999,
        padding: 2,
        marginTop: 1,
        background: checked ? C.accent : C.border,
        transition: 'background 160ms ease',
        display: 'inline-flex',
        justifyContent: checked ? 'flex-end' : 'flex-start',
      }}
    >
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff' }} />
    </span>
  </button>
);

const ChannelBadge = ({
  t,
  emoji,
  label,
  state,
  wanted,
}: {
  t: TFunc;
  emoji: string;
  label: string;
  state: 'ready' | 'soon';
  wanted: boolean;
}) => {
  const ready = state === 'ready';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '7px 11px',
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: 600,
        color: C.text,
        background: wanted ? C.accentSoft : C.bg,
        border: `1px solid ${wanted ? C.accentBorder : C.border}`,
      }}
    >
      <span aria-hidden>{emoji}</span>
      {label}
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          padding: '1px 7px',
          borderRadius: 999,
          fontFamily: mono,
          color: ready ? C.okText : C.muted,
          background: ready ? C.okSoft : C.panel2,
          border: `1px solid ${ready ? C.okBorder : C.border}`,
        }}
      >
        {ready ? 'prêt' : t('common.soon')}
      </span>
    </span>
  );
};

const MiniSpinner = () => (
  <span
    style={{
      display: 'inline-block',
      width: 14,
      height: 14,
      borderRadius: '50%',
      border: `2px solid ${C.border}`,
      borderTopColor: C.accent,
      animation: 'cdz-agents-wiz-spin 0.7s linear infinite',
    }}
  >
    <style>
      {'@keyframes cdz-agents-wiz-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){span{animation:none !important}}'}
    </style>
  </span>
);

// ---------------------------------------------------------------------------
// Styles.
// ---------------------------------------------------------------------------
const scrollStyle: CSSProperties = {
  height: '100%',
  width: '100%',
  overflow: 'auto',
  background: C.bg,
  color: C.text,
  fontSize: 13,
  lineHeight: 1.5,
};

const innerStyle: CSSProperties = {
  maxWidth: 640,
  margin: '0 auto',
  padding: '28px 16px 48px',
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
  boxSizing: 'border-box',
};

const cardStyle: CSSProperties = {
  padding: 24,
  borderRadius: 14,
  background: C.panel,
  border: `1px solid ${C.border}`,
  display: 'flex',
  flexDirection: 'column',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: '100%',
  padding: '0 16px',
  fontSize: 14,
  fontWeight: 600,
  color: C.text,
};

const betaBadgeStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  padding: '1px 7px',
  borderRadius: 999,
  color: C.muted,
  background: C.panel2,
  border: `1px solid ${C.border}`,
};

const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginTop: 22,
  flexWrap: 'wrap',
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 12,
};

function jobCardStyle(on: boolean): CSSProperties {
  return {
    appearance: 'none',
    textAlign: 'left',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 14,
    borderRadius: 12,
    background: on ? C.accentSoft : C.bg,
    border: `1px solid ${on ? C.accentBorder : C.border}`,
    color: C.text,
    transition: 'background 150ms ease, border-color 150ms ease',
    minWidth: 0,
  };
}

const jobTitleStyle: CSSProperties = {
  display: 'block',
  fontSize: 14,
  fontWeight: 700,
  color: C.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const jobDarjaStyle: CSSProperties = {
  display: 'block',
  fontSize: 11.5,
  color: C.muted,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const jobDescStyle: CSSProperties = {
  fontSize: 12.5,
  color: C.muted,
  lineHeight: 1.5,
};

const jobTagStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: C.muted,
};

const sectionCaptionStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: C.muted,
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: C.muted,
};

const toolChipStyle: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  padding: '4px 10px',
  borderRadius: 999,
  color: C.text,
  background: C.panel2,
  border: `1px solid ${C.border}`,
  fontFamily: mono,
};

// A <select> styled to match the shared inputStyle (used by the weekly
// day-of-week picker in step 4).
const selectStyle: CSSProperties = {
  appearance: 'none',
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 11px',
  borderRadius: 8,
  background: C.panel,
  border: `1px solid ${C.border}`,
  color: C.text,
  fontSize: 13.5,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

function triggerCardStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '13px 14px',
    borderRadius: 10,
    background: C.bg,
    border: `1px solid ${active ? C.accentBorder : C.border}`,
  };
}

const triggerTitleStyle: CSSProperties = {
  display: 'block',
  fontSize: 14,
  fontWeight: 700,
  color: C.text,
  marginBottom: 2,
};

function pillStyle(color: string, bg: string, border: string): CSSProperties {
  return {
    flexShrink: 0,
    alignSelf: 'center',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    padding: '2px 9px',
    borderRadius: 999,
    color,
    background: bg,
    border: `1px solid ${border}`,
  };
}

const promptPreviewStyle: CSSProperties = {
  padding: '12px 14px',
  borderRadius: 10,
  background: C.bg,
  border: `1px solid ${C.border}`,
  color: C.text,
  fontSize: 13,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const linkLike: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: C.accent,
  fontSize: 'inherit',
  fontWeight: 600,
  fontFamily: 'inherit',
  textDecoration: 'underline',
};

// Default export (router lazy target /agents/new) + `Component` alias so the
// route can wire it either way (the shipping pages export `Component`).
export default AgentsWizardPage;
export const Component = AgentsWizardPage;
