import { getCapabilities } from '@affine/core/modules/agents/api';
import { useAgents } from '@affine/core/modules/agents/use-agents';
import { WorkbenchLink } from '@affine/core/modules/workbench';
import {
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
  type HermesCaps,
  type HermesConfig,
  type HermesTool,
  inputStyle,
  MODE_LABEL,
  miniBtnStyle,
  normalizeCaps,
  Panel,
  saveConfig,
  type SavedWorkflow,
  Spinner,
  textareaStyle,
  validateAgentName,
  validatePersona,
} from './hermes-shared';

// ---------------------------------------------------------------------------
// Hermes settings panel — edit the per-user config inline (without walking the
// full wizard) and PUT it back to /api/v1/hermes/config. Same C5 shape, same
// real endpoint. Used by the dashboard's "Settings" affordance as a lighter
// alternative to re-running the wizard. Loads the live capabilities so the tool
// checklist reflects what's actually available. Degrades cleanly: a caps load
// failure still lets the user edit name/persona/mode/workflows.
// ---------------------------------------------------------------------------

type Kind = 'internal' | 'composio' | 'make';
const KIND_ORDER: Kind[] = ['internal', 'composio', 'make'];
const KIND_TITLE: Record<Kind, string> = {
  internal: '🧾 Internal — shops & data',
  composio: '🔗 Connected apps (Composio)',
  make: '🤖 Automations (Make.com)',
};
function classify(slug: string): Kind {
  const s = slug.toLowerCase();
  if (s.startsWith('composio')) return 'composio';
  if (s.startsWith('make')) return 'make';
  return 'internal';
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

export const HermesConfigPanel = ({
  config,
  onSaved,
  onClose,
}: {
  // The current per-user config to edit.
  config: HermesConfig;
  // Called after a successful PUT with the persisted config so the parent can
  // refresh the dashboard.
  onSaved: (next: HermesConfig) => void;
  // Close the settings panel without saving.
  onClose: () => void;
}) => {
  const [agentName, setAgentName] = useState(config.agentName || 'Hermes');
  const [persona, setPersona] = useState(config.personaGoal || '');
  const [mode, setMode] = useState<AgentMode>(config.defaultMode || 'ask');
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(config.enabledTools ?? [])
  );
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>(
    () => (config.savedWorkflows ?? []).map(w => ({ ...w }))
  );

  const [caps, setCaps] = useState<HermesCaps | null>(null);
  const [capsError, setCapsError] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

  const loadCaps = useCallback(async () => {
    setCapsError(false);
    try {
      const raw = await getCapabilities('hermes');
      setCaps(normalizeCaps(raw));
    } catch {
      setCaps(null);
      setCapsError(true);
    }
  }, []);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  const nameErr = validateAgentName(agentName);
  const personaErr = validatePersona(persona);
  const canSave = !nameErr && !personaErr && save.kind !== 'saving';

  const cleanWorkflows = useMemo(
    () =>
      workflows
        .map(w => ({ title: w.title.trim(), goal: w.goal.trim() }))
        .filter(w => w.goal.length > 0)
        .map(w => ({ title: w.title || 'Saved workflow', goal: w.goal })),
    [workflows]
  );

  const toggleTool = useCallback((slug: string) => {
    setEnabled(prev => {
      const nextSet = new Set(prev);
      if (nextSet.has(slug)) nextSet.delete(slug);
      else nextSet.add(slug);
      return nextSet;
    });
  }, []);

  const updateWorkflow = useCallback(
    (idx: number, patch: Partial<SavedWorkflow>) => {
      setWorkflows(prev =>
        prev.map((w, i) => (i === idx ? { ...w, ...patch } : w))
      );
    },
    []
  );
  const removeWorkflow = useCallback((idx: number) => {
    setWorkflows(prev => prev.filter((_, i) => i !== idx));
  }, []);
  const addWorkflow = useCallback(() => {
    setWorkflows(prev => [...prev, { title: '', goal: '' }]);
  }, []);

  const doSave = useCallback(async () => {
    if (!canSave) return;
    setSave({ kind: 'saving' });
    const outcome = await saveConfig({
      agentName: agentName.trim() || 'Hermes',
      personaGoal: persona.trim(),
      enabledTools: Array.from(enabled),
      defaultMode: mode,
      savedWorkflows: cleanWorkflows,
    });
    if (outcome.status === 'ok') {
      setSave({ kind: 'saved' });
      onSaved(outcome.config);
    } else {
      setSave({ kind: 'error', message: outcome.message });
    }
  }, [canSave, agentName, persona, enabled, mode, cleanWorkflows, onSaved]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.text }}>
            ⚙ Hermes settings
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: C.muted }}>
            Edit your agent’s name, focus, tools and saved workflows.
          </p>
        </div>
        <button style={btnStyle('secondary')} onClick={onClose}>
          ← Back
        </button>
      </div>

      {save.kind === 'error' ? <Banner tone="error">{save.message}</Banner> : null}

      {/* Identity */}
      <Panel title="Identity">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Agent name" error={nameErr}>
            <input
              style={inputStyle}
              value={agentName}
              maxLength={40}
              onChange={e => setAgentName(e.target.value)}
            />
          </Field>
          <Field label="Persona / standing goal" error={personaErr}>
            <textarea
              style={textareaStyle}
              value={persona}
              maxLength={600}
              onChange={e => setPersona(e.target.value)}
            />
          </Field>
        </div>
      </Panel>

      {/* Default mode */}
      <Panel title="Default run mode">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 9,
                  background: on ? C.accentSoft : C.bg,
                  border: `1px solid ${on ? C.accentBorder : C.border}`,
                  color: C.text,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 15,
                    height: 15,
                    flexShrink: 0,
                    borderRadius: '50%',
                    border: `2px solid ${on ? C.accent : C.border}`,
                    background: on ? C.accent : 'transparent',
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{MODE_LABEL[m]}</span>
              </button>
            );
          })}
        </div>
      </Panel>

      {/* Tools */}
      <Panel
        title={`Tools (${enabled.size} enabled)`}
        action={
          caps ? (
            <span style={{ display: 'flex', gap: 8 }}>
              <button
                style={miniBtnStyle('secondary')}
                onClick={() => setEnabled(new Set(caps.tools.map(t => t.slug)))}
              >
                All
              </button>
              <button
                style={miniBtnStyle('secondary')}
                onClick={() => setEnabled(new Set())}
              >
                None
              </button>
            </span>
          ) : undefined
        }
      >
        {capsError ? (
          <Banner tone="warn">
            Couldn’t load the tool catalog.{' '}
            <button
              style={{ ...miniBtnStyle('secondary'), display: 'inline-flex' }}
              onClick={() => void loadCaps()}
            >
              Retry
            </button>
          </Banner>
        ) : !caps ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 4px',
              color: C.muted,
            }}
          >
            <Spinner /> Loading tools…
          </div>
        ) : caps.tools.length === 0 ? (
          <Banner tone="info">
            No tools published yet. Connect apps from Integrations to unlock
            actions.
          </Banner>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {KIND_ORDER.map(kind => {
              const list = caps.tools.filter(t => classify(t.slug) === kind);
              if (list.length === 0) return null;
              return (
                <div key={kind} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.muted }}>
                    {KIND_TITLE[kind]}
                  </span>
                  {list.map(tool => (
                    <ToolToggle
                      key={tool.slug}
                      tool={tool}
                      checked={enabled.has(tool.slug)}
                      onToggle={() => toggleTool(tool.slug)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* Canaux — how Hermes reaches the outside world (Telegram / WhatsApp /
          web). Read-only status derived from the account-level caps; the real
          setup lives on the global connections page. */}
      <CanauxPanel />

      {/* Saved workflows */}
      <Panel
        title={`Saved workflows (${cleanWorkflows.length})`}
        action={
          <button style={miniBtnStyle('primary')} onClick={addWorkflow}>
            + Add
          </button>
        }
      >
        {workflows.length === 0 ? (
          <div style={{ fontSize: 12.5, color: C.muted, padding: '8px 4px' }}>
            No saved workflows. Add one so it appears on your dashboard.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {workflows.map((wf, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: 12,
                  borderRadius: 10,
                  background: C.bg,
                  border: `1px solid ${C.border}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    style={{ ...inputStyle, flex: 1 }}
                    value={wf.title}
                    maxLength={60}
                    placeholder="Workflow title"
                    onChange={e => updateWorkflow(i, { title: e.target.value })}
                  />
                  <button
                    style={miniBtnStyle('danger')}
                    onClick={() => removeWorkflow(i)}
                    title="Remove workflow"
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  style={textareaStyle}
                  value={wf.goal}
                  maxLength={800}
                  placeholder="Goal — phrase it the way you’d ask Hermes."
                  onChange={e => updateWorkflow(i, { goal: e.target.value })}
                />
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {save.kind === 'saved' ? (
          <span style={{ fontSize: 12.5, color: C.okText, fontWeight: 600 }}>
            ✓ Saved
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        <button style={btnStyle('secondary')} onClick={onClose}>
          Cancel
        </button>
        <button style={btnStyle('primary', !canSave)} disabled={!canSave} onClick={() => void doSave()}>
          {save.kind === 'saving' ? (
            <>
              <Spinner dark /> Saving…
            </>
          ) : (
            'Save changes'
          )}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Canaux — the account-level channel status card. Reads the R7 roster caps via
// useAgents() (GET /api/v1/agents → telegramEnabled / whatsappEnabled /
// webEnabled). This is read-only: pairing / setup happens on the global
// connections studio, reachable from the button. Fail-soft: when the roster
// endpoint 404s (feature dark) useAgents flips `disabled` and hands back the
// safe DEFAULT_AGENT_CAPS, so every channel simply reads "non configuré" — no
// error surfaces (a dark feature is not a failure). The button is always shown
// so the user still has a path to the connections page.
// ---------------------------------------------------------------------------
type ChannelTone = 'ok' | 'muted';

const CanauxPanel = () => {
  const { caps, loading } = useAgents();
  // `whatsappEnabled` is surfaced on the caps object by the backend but is not
  // yet in the AgentCaps type — read it defensively (same idiom the /agents
  // connections page uses) so this stays byte-safe if the field is absent.
  const telegramOn = !!caps.telegramEnabled;
  const whatsappOn = !!(caps as { whatsappEnabled?: boolean }).whatsappEnabled;
  const webOn = !!caps.webEnabled;

  return (
    <Panel
      title="Canaux"
      action={
        <WorkbenchLink
          to="/agents/connections"
          draggable={false}
          style={{ ...miniBtnStyle('secondary'), textDecoration: 'none' }}
        >
          Gérer les connexions →
        </WorkbenchLink>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ChannelRow
          icon="✈"
          label="Telegram"
          on={telegramOn}
          loading={loading}
          okLabel="Configuré"
          explain="Un bot Telegram doit être configuré par l’admin."
        />
        <ChannelRow
          icon="💬"
          label="WhatsApp"
          on={whatsappOn}
          loading={loading}
          okLabel="Configuré"
          explain="La passerelle WhatsApp arrive — sera activée automatiquement."
        />
        <ChannelRow
          icon="🌐"
          label="Accès web"
          on={webOn}
          loading={loading}
          okLabel="Activé"
          offLabel="Désactivé"
          explain="Vos agents peuvent chercher sur le web."
          explainWhenOn
        />
      </div>
    </Panel>
  );
};

// One channel row: an icon + label on the left, a status chip on the right, and
// a one-line explain beneath. `on` drives the green "configuré/activé" chip;
// otherwise a neutral chip with the channel's copy. While the roster is loading
// we show a neutral "…" chip rather than a misleading state.
const ChannelRow = ({
  icon,
  label,
  on,
  loading,
  okLabel,
  offLabel = 'Non configuré — token requis',
  explain,
  explainWhenOn = false,
}: {
  icon: string;
  label: string;
  on: boolean;
  loading: boolean;
  okLabel: string;
  offLabel?: string;
  explain: string;
  // When true the explain line also shows in the enabled state (used for the
  // web row, whose copy is informational rather than a "how to enable" hint).
  explainWhenOn?: boolean;
}) => {
  const tone: ChannelTone = on ? 'ok' : 'muted';
  const chipLabel = loading ? '…' : on ? okLabel : offLabel;
  const showExplain = !loading && (on ? explainWhenOn : true);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '10px 12px',
        borderRadius: 9,
        background: C.bg,
        border: `1px solid ${C.border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden style={{ fontSize: 15, flexShrink: 0 }}>
          {icon}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: C.text }}>
          {label}
        </span>
        <ChannelChip tone={tone}>{chipLabel}</ChannelChip>
      </div>
      {showExplain ? (
        <span style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.5, paddingLeft: 25 }}>
          {explain}
        </span>
      ) : null}
    </div>
  );
};

// A compact status chip: green (configured/enabled) or neutral (everything
// else). Mirrors the connections-page chip tones using the Hermes C palette.
const ChannelChip = ({
  tone,
  children,
}: {
  tone: ChannelTone;
  children: ReactNode;
}) => (
  <span
    style={{
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 9px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 600,
      whiteSpace: 'nowrap',
      color: tone === 'ok' ? C.okText : C.muted,
      background: tone === 'ok' ? C.okSoft : 'transparent',
      border: `1px solid ${tone === 'ok' ? C.okBorder : C.border}`,
    }}
  >
    <span
      aria-hidden
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: tone === 'ok' ? C.okText : C.muted,
      }}
    />
    {children}
  </span>
);

const ToolToggle = ({
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

export default HermesConfigPanel;
