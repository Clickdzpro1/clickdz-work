// ---------------------------------------------------------------------------
// "Hire an employee" wizard — the goal-first onboarding for the unified /agents
// studio (router lazy target at /agents/new). It reframes agent setup as HIRING
// an employee for a concrete job, not configuring a cron:
//
//   Step 1  Pick a job-to-be-done (JTBD_PRESETS) — or « Partir de zéro »
//   Step 2  Name + persona            (prefilled from the chosen job)
//   Step 3  Tools & channels review    (web toggle · Telegram/WhatsApp badges
//                                        read live caps; WA = "bientôt")
//   Step 4  Déclencheur / planning     (manuel pour l'instant — scheduling R8)
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

import { startBackgroundRun } from '@affine/core/modules/agents/api';
import { AgentPalette } from '@affine/core/modules/agents/components';
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
const STEP_LABEL: Record<Step, string> = {
  job: 'Le poste',
  identity: 'Identité',
  tools: 'Outils & canaux',
  trigger: 'Déclencheur',
  test: 'Essai',
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

  // ---- provisioning (branch by agent → the EXISTING config endpoint) -------
  const finishHire = useCallback(async () => {
    setHire({ kind: 'saving' });
    const name = agentName.trim() || (agent === 'openclaw' ? 'OpenClaw' : 'Hermes');
    try {
      if (agent === 'openclaw') {
        // OpenClaw provisioning: PUT /api/v1/openclaw/config (putConfig). The
        // coding agent has no tool/persona fields — persist the sensible
        // defaults the shipping wizard uses.
        await putConfig({ defaultRuntime: 'node24', previewAutoOpen: true });
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
            : 'Impossible de finaliser l’embauche. Réessayez.',
      });
    }
  }, [agent, agentName, persona, tools, preset]);

  // ---- test-run (reuse startBackgroundRun) ---------------------------------
  const starterPrompt = useMemo(() => {
    if (preset) return preset.starterPrompt;
    return persona.trim() || SCRATCH_PERSONA;
  }, [preset, persona]);

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
          ? 'Les essais en direct ne sont pas encore activés sur ce serveur — vous pourrez lancer votre agent depuis /agents après l’embauche.'
          : status === 429
            ? 'Limite d’essais atteinte pour aujourd’hui. Réessayez plus tard.'
            : err instanceof Error && err.message
              ? err.message
              : 'Impossible de lancer l’essai. Réessayez.';
      setRun({ kind: 'error', message });
    }
  }, [agent, starterPrompt]);

  // ---- terminal hire phases render standalone ------------------------------
  if (hire.kind === 'done') {
    return (
      <Shell>
        <DoneCard
          agent={hire.agent}
          name={agentName.trim() || (hire.agent === 'openclaw' ? 'OpenClaw' : 'Hermes')}
          onOpenAgents={() => navigate('/agents')}
        />
      </Shell>
    );
  }

  // ---- step body -----------------------------------------------------------
  return (
    <Shell>
      <div style={cardStyle}>
        <Stepper stepIdx={stepIdx} />

        {step === 'job' ? (
          <JobStep choice={choice} onPick={applyChoice} />
        ) : null}

        {step === 'identity' ? (
          <IdentityStep
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
            agent={agent}
            caps={caps}
            preset={preset}
            tools={tools}
            webOn={webOn}
            onWeb={setWebOn}
            onNavigate={navigate}
          />
        ) : null}

        {step === 'trigger' ? <TriggerStep /> : null}

        {step === 'test' ? (
          <TestStep
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
              ← Retour
            </button>
          ) : (
            <button style={btnStyle('secondary')} onClick={() => navigate('/agents')}>
              Annuler
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
                ? 'Embauche…'
                : agent === 'openclaw'
                  ? '🛠️ Embaucher mon agent'
                  : '🪽 Embaucher mon employé'}
            </button>
          ) : (
            <button
              style={btnStyle('primary', !canAdvance)}
              disabled={!canAdvance}
              onClick={next}
            >
              Continuer →
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
  choice,
  onPick,
}: {
  choice: string | null;
  onPick: (p: JtbdPreset | 'scratch') => void;
}) => (
  <StepShell
    emoji="🧑‍💼"
    title="Quel poste voulez-vous pourvoir ?"
    subtitle="Choisissez le travail à confier — واش تحب يدير ليك. On préremplit tout le reste."
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
                <span style={jobTitleStyle}>{p.titleFr}</span>
                <span style={jobDarjaStyle} dir="rtl">
                  {p.titleDarja}
                </span>
              </span>
              {on ? <span style={{ color: C.accent, fontSize: 16 }}>✓</span> : null}
            </div>
            <span style={jobDescStyle}>{p.desc}</span>
            <span style={jobTagStyle}>
              {p.agent === 'openclaw' ? '🛠️ Agent développeur' : '🪽 Agent opérations'}
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
            <span style={jobTitleStyle}>Partir de zéro</span>
            <span style={jobDarjaStyle} dir="rtl">
              نبدا من الصفر
            </span>
          </span>
        </div>
        <span style={jobDescStyle}>
          Configurez un agent opérations vierge et décrivez son rôle vous-même.
        </span>
      </button>
    </div>
  </StepShell>
);

// ---------------------------------------------------------------------------
// Step 2 — name + persona (prefilled from the job).
// ---------------------------------------------------------------------------
const IdentityStep = ({
  agent,
  preset,
  name,
  persona,
  nameErr,
  personaErr,
  onName,
  onPersona,
}: {
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
    title="Présentez votre nouvel employé"
    subtitle={
      preset
        ? `Pour le poste « ${preset.titleFr} » — ajustez son nom et sa mission.`
        : 'Donnez-lui un nom et décrivez sa mission.'
    }
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <LabeledField label="Nom de l’agent" hint="Jusqu’à 40 caractères — c’est le nom affiché." error={nameErr}>
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
        <Banner tone="info">
          L’agent développeur écrit et exécute du code dans un sandbox isolé — pas
          besoin de persona. Vous pourrez ajuster ses préférences après l’embauche.
        </Banner>
      ) : (
        <LabeledField
          label="Mission / persona"
          hint="Une phrase ou deux. Modifiable plus tard."
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
  agent,
  caps,
  preset,
  tools,
  webOn,
  onWeb,
  onNavigate,
}: {
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

  return (
    <StepShell
      emoji="🔌"
      title="Outils & canaux"
      subtitle="Ce que votre agent peut utiliser. Vous pourrez tout changer plus tard."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Web access toggle */}
        <ToggleRow
          checked={webOn && caps.webEnabled}
          disabled={!caps.webEnabled}
          onChange={onWeb}
          emoji="🌐"
          label="Accès web"
          hint={
            caps.webEnabled
              ? 'Recherche et lecture de pages web en direct.'
              : 'L’accès web n’est pas activé sur ce serveur pour l’instant.'
          }
        />

        {/* Channels — badges reading live caps */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={sectionCaptionStyle}>Canaux</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <ChannelBadge
              emoji="✈️"
              label="Telegram"
              // Ready when the server has Telegram enabled; else "bientôt".
              state={caps.telegramEnabled ? 'ready' : 'soon'}
              wanted={wantsChannel('telegram')}
            />
            <ChannelBadge
              emoji="💬"
              label="WhatsApp"
              // No WA capability yet → always "bientôt" (honest, never faked).
              state="soon"
              wanted={wantsChannel('whatsapp')}
            />
          </div>
          <span style={hintStyle}>
            Les canaux se relient après l’embauche depuis la page Connexions.{' '}
            {caps.telegramEnabled ? '' : 'Telegram et '}
            WhatsApp arrivent bientôt.
          </span>
        </div>

        {/* Suggested tools (Hermes) */}
        {agent === 'hermes' ? (
          tools.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={sectionCaptionStyle}>Outils suggérés pour ce poste</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {tools.map(t => (
                  <span key={t} style={toolChipStyle}>
                    {t}
                  </span>
                ))}
              </div>
              <span style={hintStyle}>
                Ces outils seront proposés à votre agent selon ce qui est
                disponible sur votre compte. Gérez les connexions depuis{' '}
                <button
                  type="button"
                  style={linkLike}
                  onClick={() => onNavigate('/integrations')}
                >
                  Intégrations
                </button>
                .
              </span>
            </div>
          ) : (
            <Banner tone="info">
              Aucun outil spécifique pour ce poste — votre agent planifiera ses
              actions et vous pourrez connecter des apps depuis Intégrations.
            </Banner>
          )
        ) : (
          <Banner tone="info">
            L’agent développeur travaille dans son sandbox de code — les outils
            sont l’éditeur, le terminal et l’aperçu en direct.
          </Banner>
        )}
      </div>
    </StepShell>
  );
};

// ---------------------------------------------------------------------------
// Step 4 — trigger / scheduling stub (R8 lands real scheduling).
// ---------------------------------------------------------------------------
const TriggerStep = () => (
  <StepShell
    emoji="⏰"
    title="Quand doit-il travailler ?"
    subtitle="Pour l’instant, votre agent travaille à la demande."
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={triggerCardStyle(true)}>
        <span style={{ fontSize: 20 }} aria-hidden>
          ▶️
        </span>
        <span style={{ flex: 1 }}>
          <span style={triggerTitleStyle}>Manuel</span>
          <span style={hintStyle}>
            Vous lancez chaque tâche vous-même depuis la page de l’agent.
          </span>
        </span>
        <span style={pillStyle(C.accent, C.accentSoft, C.accentBorder)}>Actif</span>
      </div>
      <div style={triggerCardStyle(false)}>
        <span style={{ fontSize: 20, opacity: 0.6 }} aria-hidden>
          🗓️
        </span>
        <span style={{ flex: 1 }}>
          <span style={triggerTitleStyle}>Planification</span>
          <span style={hintStyle}>
            Faire tourner l’agent automatiquement (ex. tous les matins). لسه ماشي
            جاهز.
          </span>
        </span>
        <span style={pillStyle(C.muted, C.panel2, C.border)}>Bientôt</span>
      </div>
      <Banner tone="info">
        La planification automatique arrive prochainement. Pour l’instant, tout
        est manuel — vous gardez le contrôle sur chaque exécution.
      </Banner>
    </div>
  </StepShell>
);

// ---------------------------------------------------------------------------
// Step 5 — test-run (kick a background run + link to its run view).
// ---------------------------------------------------------------------------
const TestStep = ({
  agent,
  name,
  starterPrompt,
  run,
  onStart,
  onOpenRun,
}: {
  agent: AgentName;
  name: string;
  starterPrompt: string;
  run: RunPhase;
  onStart: () => void;
  onOpenRun: (agent: AgentName, runId: string) => void;
}) => (
  <StepShell
    emoji="🧪"
    title="Faites-lui passer un essai"
    subtitle={`Lancez une première tâche pour voir ${name} à l’œuvre — c’est optionnel avant l’embauche.`}
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={sectionCaptionStyle}>Tâche d’essai</span>
        <div style={promptPreviewStyle}>{starterPrompt}</div>
      </div>

      {run.kind === 'idle' ? (
        <div>
          <button style={btnStyle('secondary')} onClick={onStart}>
            ▶️ Lancer l’essai
          </button>
        </div>
      ) : run.kind === 'starting' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted }}>
          <MiniSpinner /> Lancement de l’essai…
        </div>
      ) : run.kind === 'started' ? (
        <Banner tone="ok">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>
              Essai lancé ✓ — {name} travaille en arrière-plan. Vous pouvez suivre
              son exécution en direct.
            </span>
            <div>
              <button
                style={{ ...btnStyle('primary'), padding: '7px 14px', fontSize: 12.5 }}
                onClick={() => onOpenRun(run.agent, run.runId)}
              >
                Voir l’exécution →
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
              Réessayer
            </button>
          </div>
        </div>
      )}

      <Banner tone="info">
        Prêt ? Cliquez sur « Embaucher » ci-dessous : on enregistre votre agent et
        on vous emmène à la page des agents.
      </Banner>
    </div>
  </StepShell>
);

// ---------------------------------------------------------------------------
// Done screen.
// ---------------------------------------------------------------------------
const DoneCard = ({
  agent,
  name,
  onOpenAgents,
}: {
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
        {name} est embauché !
      </h2>
      <p style={{ margin: 0, fontSize: 13.5, color: C.muted, lineHeight: 1.55 }}>
        {agent === 'openclaw'
          ? 'Votre agent développeur est prêt. Confiez-lui une tâche et regardez-le construire.'
          : 'Votre employé est prêt. Retrouvez-le sur la page des agents pour lancer des tâches et suivre ses exécutions.'}
      </p>
    </div>
    <div style={{ display: 'flex', marginTop: 24, justifyContent: 'center' }}>
      <button style={btnStyle('primary')} onClick={onOpenAgents}>
        Voir mes agents →
      </button>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Layout + shared sub-components (inline styles, mobile-friendly).
// ---------------------------------------------------------------------------
const Shell = ({ children }: { children: ReactNode }) => (
  <>
    <ViewTitle title="Embaucher un agent" />
    <ViewIcon icon="edgeless" />
    <ViewHeader>
      <div style={headerStyle}>
        <span style={{ fontSize: 16 }} aria-hidden>
          🧑‍💼
        </span>
        Embaucher un agent
        <span style={betaBadgeStyle}>béta</span>
      </div>
    </ViewHeader>
    <ViewBody>
      <div style={scrollStyle}>
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

const Stepper = ({ stepIdx }: { stepIdx: number }) => (
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
      Étape {stepIdx + 1}/{FLOW.length} · {STEP_LABEL[FLOW[stepIdx]]}
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
  emoji,
  label,
  state,
  wanted,
}: {
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
        {ready ? 'prêt' : 'bientôt'}
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
