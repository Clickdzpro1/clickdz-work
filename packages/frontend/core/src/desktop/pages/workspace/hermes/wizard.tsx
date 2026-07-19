import { getCapabilities } from '@affine/core/modules/agents/api';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  type AgentMode,
  Banner,
  btnStyle,
  C,
  Field,
  fetchConfig,
  type HermesCaps,
  type HermesConfig,
  type HermesTool,
  hintStyle,
  inputStyle,
  MODE_LABEL,
  normalizeCaps,
  saveConfig,
  type SavedWorkflow,
  Spinner,
  textareaStyle,
  validateAgentName,
  validatePersona,
} from './hermes-shared';

// ---------------------------------------------------------------------------
// Hermes onboarding wizard. Mirrors the ShopERP wizard state machine: a linear
// step FLOW, then a post-confirm create pipeline that hits the REAL C5 backend
// (PUT /api/v1/hermes/config, which sets provisioned:true). Each user sets up
// their own Hermes like an app — name it, give it a persona/goal, pick the
// tools it may use (from GET /api/v1/hermes/capabilities), choose a default run
// mode, and seed a first saved workflow. On success onDone() flips the page to
// the dashboard. Inline styles, boot-safe, reduced-motion friendly, and every
// surface degrades cleanly (capabilities can fail to load without blocking the
// wizard — the user just picks no tools yet and enables them later).
// ---------------------------------------------------------------------------

type Step = 'welcome' | 'name' | 'persona' | 'tools' | 'mode' | 'workflow' | 'review';
const FLOW: Step[] = [
  'welcome',
  'name',
  'persona',
  'tools',
  'mode',
  'workflow',
  'review',
];

// The create phase after the user confirms on the Review step.
type Phase =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'done'; config: HermesConfig }
  | { kind: 'error'; message: string };

// Capabilities load state (independent of the step flow — the wizard is usable
// even if the catalog can't be fetched).
type CapsState = 'loading' | 'ready' | 'error';

// A tasteful starter persona so a click-through yields a valid, useful config.
const DEFAULT_PERSONA =
  'A hands-on operations assistant for my shops. Read my live orders, ERP and connected apps, summarize what needs attention, and draft the follow-ups — always show me writes and sends before doing them.';

// A curated first-workflow suggestion the user can accept or edit (seeds the
// per-user savedWorkflows that replace the static console library).
const DEFAULT_WORKFLOW: SavedWorkflow = {
  title: 'Daily orders digest',
  goal: 'List all my shops, then summarize today’s orders across them: total count, revenue, and a breakdown by status. Call out anything that needs attention.',
};

// A few more ready-to-use starters the user can one-tap to seed the workflow.
const WORKFLOW_SUGGESTIONS: SavedWorkflow[] = [
  DEFAULT_WORKFLOW,
  {
    title: 'Morning operations brief',
    goal: 'Build a morning operations brief across all my shops: today’s orders and revenue, pending fulfilment, and any low-stock products. Keep it to a short bulleted summary.',
  },
  {
    title: 'Pending-order chase list',
    goal: 'Find all pending and unfulfilled orders across my shops and draft a short, friendly WhatsApp broadcast asking those customers to confirm their order.',
  },
];

// Group meta for the tool picker (mirrors hermes-connections classify()).
type Kind = 'internal' | 'composio' | 'make';
const KIND_META: Record<Kind, { icon: string; title: string; blurb: string }> = {
  internal: {
    icon: '🧾',
    title: 'Internal — your shops & data',
    blurb: 'Reads your ClickDz shops and ERP data. No setup required.',
  },
  composio: {
    icon: '🔗',
    title: 'Connected apps (Composio)',
    blurb: 'Gmail, Sheets, Slack, Notion and more — connect them in Integrations.',
  },
  make: {
    icon: '🤖',
    title: 'Automations (Make.com)',
    blurb: 'Delegate longer drafting/reasoning to a Make agent.',
  },
};
const KIND_ORDER: Kind[] = ['internal', 'composio', 'make'];
function classify(slug: string): Kind {
  const s = slug.toLowerCase();
  if (s.startsWith('composio')) return 'composio';
  if (s.startsWith('make')) return 'make';
  return 'internal';
}

export const HermesWizard = ({
  onDone,
  onCancel,
  hasConfig,
  initialConfig,
}: {
  // Called after a successful save once the user leaves the result screen →
  // the page reloads the config and lands on the dashboard.
  onDone: () => void;
  // Called to abandon the wizard (only shown when a config already exists, i.e.
  // the wizard was re-opened from the dashboard to reconfigure).
  onCancel?: () => void;
  // True when re-running the wizard over an existing config (edit flow).
  hasConfig: boolean;
  // Seed values when editing an existing config.
  initialConfig?: HermesConfig | null;
}) => {
  const [stepIdx, setStepIdx] = useState(0);
  const step = FLOW[stepIdx];

  // ---- config model, seeded with sensible defaults (or the existing config) -
  const [agentName, setAgentName] = useState(initialConfig?.agentName || 'Hermes');
  const [persona, setPersona] = useState(
    initialConfig?.personaGoal || DEFAULT_PERSONA
  );
  const [mode, setMode] = useState<AgentMode>(initialConfig?.defaultMode || 'ask');
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(initialConfig?.enabledTools ?? [])
  );
  const [wfTitle, setWfTitle] = useState(
    initialConfig?.savedWorkflows?.[0]?.title || DEFAULT_WORKFLOW.title
  );
  const [wfGoal, setWfGoal] = useState(
    initialConfig?.savedWorkflows?.[0]?.goal || DEFAULT_WORKFLOW.goal
  );

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  // ---- capabilities (tool catalog for the picker) -------------------------
  const [capsState, setCapsState] = useState<CapsState>('loading');
  const [caps, setCaps] = useState<HermesCaps | null>(null);

  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      const raw = await getCapabilities('hermes');
      const normalized = normalizeCaps(raw);
      setCaps(normalized);
      setCapsState('ready');
      // First run (no existing selection): pre-select every available tool so a
      // click-through yields a useful agent. Editing keeps the user's choices.
      setEnabled(prev => {
        if (prev.size > 0 || initialConfig?.enabledTools?.length) return prev;
        return new Set(normalized.tools.filter(t => t.available).map(t => t.slug));
      });
    } catch {
      setCaps(null);
      setCapsState('error');
    }
  }, [initialConfig?.enabledTools?.length]);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  // ---- validation ---------------------------------------------------------
  const nameErr = validateAgentName(agentName);
  const personaErr = validatePersona(persona);

  const workflows: SavedWorkflow[] = useMemo(() => {
    const g = wfGoal.trim();
    if (!g) return [];
    return [{ title: wfTitle.trim() || 'Saved workflow', goal: g }];
  }, [wfTitle, wfGoal]);

  const canAdvance = ((): boolean => {
    switch (step) {
      case 'name':
        return !nameErr;
      case 'persona':
        return !personaErr;
      default:
        return true; // tools / mode / workflow are all optional-friendly
    }
  })();

  const next = useCallback(() => {
    setStepIdx(i => Math.min(i + 1, FLOW.length - 1));
  }, []);
  const back = useCallback(() => {
    setStepIdx(i => Math.max(i - 1, 0));
  }, []);

  const toggleTool = useCallback((slug: string) => {
    setEnabled(prev => {
      const nextSet = new Set(prev);
      if (nextSet.has(slug)) nextSet.delete(slug);
      else nextSet.add(slug);
      return nextSet;
    });
  }, []);

  // ---- the real create pipeline (PUT the config → provisioned:true) -------
  const create = useCallback(async () => {
    setPhase({ kind: 'saving' });
    const outcome = await saveConfig({
      agentName: agentName.trim() || 'Hermes',
      personaGoal: persona.trim(),
      enabledTools: Array.from(enabled),
      defaultMode: mode,
      savedWorkflows: workflows,
    });
    if (outcome.status === 'ok') {
      setPhase({ kind: 'done', config: outcome.config });
      return;
    }
    setPhase({ kind: 'error', message: outcome.message });
  }, [agentName, persona, enabled, mode, workflows]);

  // ----- Terminal phases render standalone ---------------------------------
  if (phase.kind === 'saving') {
    return (
      <Card>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
            padding: '32px 8px',
          }}
        >
          <Spinner />
          <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>
            Setting up {agentName.trim() || 'Hermes'}…
          </div>
          <div style={hintStyle}>Saving your agent configuration.</div>
        </div>
      </Card>
    );
  }

  if (phase.kind === 'error') {
    return (
      <Card>
        <Banner tone="error">{phase.message}</Banner>
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button style={btnStyle('primary')} onClick={() => void create()}>
            Try again
          </button>
          <button
            style={btnStyle('secondary')}
            onClick={() => setPhase({ kind: 'idle' })}
          >
            Back to review
          </button>
        </div>
      </Card>
    );
  }

  if (phase.kind === 'done') {
    return <DoneCard config={phase.config} onFinish={onDone} />;
  }

  // ----- Wizard steps -------------------------------------------------------
  const availableCount = caps?.tools.filter(t => t.available).length ?? 0;

  return (
    <Card>
      <StepDots total={FLOW.length} current={stepIdx} />

      {step === 'welcome' ? (
        <StepShell
          emoji="🪽"
          title={hasConfig ? 'Reconfigure Hermes' : 'Set up your Hermes'}
          subtitle="Hermes is your operations agent — give it a goal and it plans the steps, calls the right tools across your shops and connected apps, and reports back. Let’s set up your own in a few quick steps."
        >
          <ul
            style={{
              margin: '4px 0 0',
              paddingInlineStart: 18,
              color: C.muted,
              fontSize: 13,
              lineHeight: 1.7,
            }}
          >
            <li>Name your agent &amp; describe its focus</li>
            <li>Pick the tools it’s allowed to use</li>
            <li>Choose how boldly it should act</li>
            <li>Seed a first workflow to run</li>
          </ul>
        </StepShell>
      ) : null}

      {step === 'name' ? (
        <StepShell
          emoji="🏷️"
          title="Name your agent"
          subtitle="What should this agent be called? You’ll see this name on its dashboard and runs."
        >
          <Field
            label="Agent name"
            hint="Up to 40 characters."
            error={touchedErr(agentName, nameErr, 'Hermes')}
          >
            <input
              style={inputStyle}
              value={agentName}
              maxLength={40}
              placeholder="Hermes"
              onChange={e => setAgentName(e.target.value)}
              autoFocus
            />
          </Field>
        </StepShell>
      ) : null}

      {step === 'persona' ? (
        <StepShell
          emoji="🎯"
          title="Persona & goal"
          subtitle="Describe what this agent should focus on and how it should behave. This steers every run."
        >
          <Field
            label="Persona / standing goal"
            hint="A sentence or two. You can change this later."
            error={touchedErr(persona, personaErr, DEFAULT_PERSONA)}
          >
            <textarea
              style={textareaStyle}
              value={persona}
              maxLength={600}
              placeholder={DEFAULT_PERSONA}
              onChange={e => setPersona(e.target.value)}
              autoFocus
            />
          </Field>
        </StepShell>
      ) : null}

      {step === 'tools' ? (
        <StepShell
          emoji="🔌"
          title="Tools & toolkits"
          subtitle="Choose which tools Hermes may use. You can connect more apps anytime from Integrations."
        >
          {capsState === 'loading' ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '20px 4px',
                color: C.muted,
              }}
            >
              <Spinner /> Loading the tool catalog…
            </div>
          ) : capsState === 'error' ? (
            <Banner tone="warn">
              Couldn’t load the tool catalog right now. You can finish setup and
              enable tools later from the dashboard.{' '}
              <button
                style={{ ...btnStyle('secondary'), padding: '4px 10px', fontSize: 12 }}
                onClick={() => void loadCaps()}
              >
                Retry
              </button>
            </Banner>
          ) : caps && caps.tools.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 12,
                  color: C.muted,
                }}
              >
                <span>
                  {enabled.size} selected · {availableCount} available now
                </span>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  style={{ ...linkLike, color: C.accent }}
                  onClick={() =>
                    setEnabled(new Set(caps.tools.map(t => t.slug)))
                  }
                >
                  Select all
                </button>
                <button
                  type="button"
                  style={{ ...linkLike, color: C.muted }}
                  onClick={() => setEnabled(new Set())}
                >
                  Clear
                </button>
              </div>
              {KIND_ORDER.map(kind => {
                const list = caps.tools.filter(t => classify(t.slug) === kind);
                if (list.length === 0) return null;
                const meta = KIND_META[kind];
                return (
                  <section
                    key={kind}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      padding: 12,
                      borderRadius: 12,
                      background: C.bg,
                      border: `1px solid ${C.border}`,
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
                        <span aria-hidden style={{ marginRight: 6 }}>
                          {meta.icon}
                        </span>
                        {meta.title}
                      </span>
                      <span style={{ fontSize: 11, color: C.muted }}>
                        {meta.blurb}
                      </span>
                    </div>
                    {list.map(tool => (
                      <ToolRow
                        key={tool.slug}
                        tool={tool}
                        checked={enabled.has(tool.slug)}
                        onToggle={() => toggleTool(tool.slug)}
                      />
                    ))}
                  </section>
                );
              })}
            </div>
          ) : (
            <Banner tone="info">
              No tools are published yet. Hermes will still plan runs — connect
              apps from Integrations to unlock actions.
            </Banner>
          )}
        </StepShell>
      ) : null}

      {step === 'mode' ? (
        <StepShell
          emoji="🎚️"
          title="Default run mode"
          subtitle="How boldly should Hermes act by default? You can switch this per run from the console."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(['auto', 'ask', 'dry'] as AgentMode[]).map(m => {
              const on = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  style={{
                    appearance: 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 14px',
                    borderRadius: 10,
                    background: on ? C.accentSoft : C.bg,
                    border: `1px solid ${on ? C.accentBorder : C.border}`,
                    color: C.text,
                    transition: 'background 150ms ease, border-color 150ms ease',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 16,
                      height: 16,
                      flexShrink: 0,
                      borderRadius: '50%',
                      border: `2px solid ${on ? C.accent : C.border}`,
                      background: on ? C.accent : 'transparent',
                    }}
                  />
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                    {MODE_LABEL[m]}
                  </span>
                </button>
              );
            })}
          </div>
        </StepShell>
      ) : null}

      {step === 'workflow' ? (
        <StepShell
          emoji="⚡"
          title="Seed a first workflow"
          subtitle="Save one ready-to-run task. It’ll appear on your dashboard — one click loads it into the console."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {WORKFLOW_SUGGESTIONS.map(s => {
                const on = wfGoal.trim() === s.goal.trim();
                return (
                  <button
                    key={s.title}
                    type="button"
                    onClick={() => {
                      setWfTitle(s.title);
                      setWfGoal(s.goal);
                    }}
                    style={{
                      appearance: 'none',
                      cursor: 'pointer',
                      padding: '6px 12px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      color: on ? '#fff' : C.text,
                      background: on ? C.accent : C.bg,
                      border: `1px solid ${on ? 'transparent' : C.border}`,
                      transition: 'background 150ms ease',
                    }}
                  >
                    {s.title}
                  </button>
                );
              })}
            </div>
            <Field label="Workflow title" hint="A short label for the card.">
              <input
                style={inputStyle}
                value={wfTitle}
                maxLength={60}
                placeholder="Daily orders digest"
                onChange={e => setWfTitle(e.target.value)}
              />
            </Field>
            <Field
              label="Goal"
              hint="Phrase it the way you’d ask Hermes. Leave empty to skip seeding a workflow."
            >
              <textarea
                style={textareaStyle}
                value={wfGoal}
                maxLength={800}
                placeholder={DEFAULT_WORKFLOW.goal}
                onChange={e => setWfGoal(e.target.value)}
              />
            </Field>
          </div>
        </StepShell>
      ) : null}

      {step === 'review' ? (
        <StepShell
          emoji="✅"
          title="Review"
          subtitle="Here’s your Hermes. You can change any of this later from the dashboard settings."
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              borderRadius: 10,
              overflow: 'hidden',
              border: `1px solid ${C.border}`,
            }}
          >
            <ReviewRow
              label="Name"
              value={agentName.trim() || 'Hermes'}
              onEdit={() => setStepIdx(FLOW.indexOf('name'))}
            />
            <ReviewRow
              label="Persona"
              value={persona.trim()}
              onEdit={() => setStepIdx(FLOW.indexOf('persona'))}
            />
            <ReviewRow
              label="Tools"
              value={
                enabled.size > 0
                  ? `${enabled.size} enabled`
                  : 'None yet — enable later'
              }
              onEdit={() => setStepIdx(FLOW.indexOf('tools'))}
            />
            <ReviewRow
              label="Default mode"
              value={MODE_LABEL[mode]}
              onEdit={() => setStepIdx(FLOW.indexOf('mode'))}
            />
            <ReviewRow
              label="First workflow"
              value={workflows.length > 0 ? workflows[0].title : 'Skipped'}
              onEdit={() => setStepIdx(FLOW.indexOf('workflow'))}
            />
          </div>
          <Banner tone="info">
            We’ll save this as your personal Hermes configuration and open your
            dashboard. The streaming console stays one click away.
          </Banner>
        </StepShell>
      ) : null}

      {/* Footer nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 22 }}>
        {stepIdx > 0 ? (
          <button style={btnStyle('secondary')} onClick={back}>
            ← Back
          </button>
        ) : hasConfig && onCancel ? (
          <button style={btnStyle('secondary')} onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <span />
        )}
        <div style={{ flex: 1 }} />
        {step === 'review' ? (
          <button style={btnStyle('primary')} onClick={() => void create()}>
            {hasConfig ? '💾 Save changes' : '🪽 Create my Hermes'}
          </button>
        ) : (
          <button
            style={btnStyle('primary', !canAdvance)}
            disabled={!canAdvance}
            onClick={next}
          >
            {step === 'welcome' ? 'Get started' : 'Continue'} →
          </button>
        )}
      </div>
    </Card>
  );
};

// Show a field error only once the user has diverged from the seeded default
// (so the wizard doesn't scream red at first paint on the pre-filled defaults).
function touchedErr(value: string, err: string | null, seed: string): string | null {
  if (!err) return null;
  return value === seed ? null : err;
}

// ---- sub-components --------------------------------------------------------

const Card = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      maxWidth: 580,
      margin: '0 auto',
      padding: 24,
      borderRadius: 14,
      background: C.panel,
      border: `1px solid ${C.border}`,
      display: 'flex',
      flexDirection: 'column',
    }}
  >
    {children}
  </div>
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

const StepDots = ({ total, current }: { total: number; current: number }) => (
  <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
    {Array.from({ length: total }).map((_, i) => (
      <span
        key={i}
        style={{
          height: 4,
          flex: 1,
          borderRadius: 2,
          background: i <= current ? C.accent : C.border,
          transition: 'background 200ms ease',
        }}
      />
    ))}
  </div>
);

const ToolRow = ({
  tool,
  checked,
  onToggle,
}: {
  tool: HermesTool;
  checked: boolean;
  onToggle: () => void;
}) => (
  <button
    type="button"
    onClick={onToggle}
    style={{
      appearance: 'none',
      textAlign: 'left',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 10px',
      borderRadius: 8,
      background: checked ? C.accentSoft : C.panel,
      border: `1px solid ${checked ? C.accentBorder : C.border}`,
      color: C.text,
      transition: 'background 150ms ease, border-color 150ms ease',
    }}
  >
    <span
      aria-hidden
      style={{
        width: 16,
        height: 16,
        flexShrink: 0,
        borderRadius: 5,
        display: 'grid',
        placeItems: 'center',
        fontSize: 11,
        color: '#fff',
        border: `2px solid ${checked ? C.accent : C.border}`,
        background: checked ? C.accent : 'transparent',
      }}
    >
      {checked ? '✓' : ''}
    </span>
    <span style={{ flex: 1, minWidth: 0 }}>
      <span
        style={{
          display: 'block',
          fontSize: 12.5,
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {tool.label || tool.slug}
      </span>
      <span
        style={{
          display: 'block',
          fontSize: 10.5,
          color: C.muted,
          fontFamily: 'var(--affine-font-code-family, monospace)',
        }}
      >
        {tool.slug}
      </span>
    </span>
    <span
      style={{
        flexShrink: 0,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: tool.available ? C.okText : C.muted,
      }}
    >
      {tool.available ? 'Ready' : 'Needs setup'}
    </span>
  </button>
);

const ReviewRow = ({
  label,
  value,
  onEdit,
}: {
  label: string;
  value: string;
  onEdit: () => void;
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '11px 14px',
      background: C.bg,
    }}
  >
    <span style={{ fontSize: 12, color: C.muted, width: 108, flexShrink: 0, paddingTop: 1 }}>
      {label}
    </span>
    <span
      style={{
        flex: 1,
        fontSize: 13,
        fontWeight: 600,
        color: C.text,
        wordBreak: 'break-word',
        lineHeight: 1.5,
      }}
    >
      {value || '—'}
    </span>
    <button
      style={{
        appearance: 'none',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: C.accent,
        fontSize: 12,
        fontWeight: 600,
        padding: 0,
        flexShrink: 0,
      }}
      onClick={onEdit}
    >
      Edit
    </button>
  </div>
);

// The success screen after a successful PUT.
const DoneCard = ({
  config,
  onFinish,
}: {
  config: HermesConfig;
  onFinish: () => void;
}) => (
  <Card>
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
        {config.agentName || 'Hermes'} is ready
      </h2>
      <p style={{ margin: 0, fontSize: 13.5, color: C.muted, lineHeight: 1.55 }}>
        Your operations agent is set up. Open your dashboard to see runs, tools
        and saved workflows — or jump straight into a new run.
      </p>
    </div>

    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 20,
        padding: 14,
        borderRadius: 12,
        background: C.bg,
        border: `1px solid ${C.border}`,
      }}
    >
      <SummaryLine label="Tools enabled" value={`${config.enabledTools?.length ?? 0}`} />
      <SummaryLine
        label="Default mode"
        value={MODE_LABEL[config.defaultMode ?? 'ask']}
      />
      <SummaryLine
        label="Saved workflows"
        value={`${config.savedWorkflows?.length ?? 0}`}
      />
    </div>

    <div style={{ display: 'flex', marginTop: 22 }}>
      <div style={{ flex: 1 }} />
      <button style={btnStyle('primary')} onClick={onFinish}>
        Open my dashboard →
      </button>
    </div>
  </Card>
);

const SummaryLine = ({ label, value }: { label: string; value: string }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    <span style={{ fontSize: 12, color: C.muted, flex: 1 }}>{label}</span>
    <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{value}</span>
  </div>
);

const linkLike: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
};

export default HermesWizard;
