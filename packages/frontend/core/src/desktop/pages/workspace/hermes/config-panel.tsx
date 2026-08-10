import { getCapabilities } from '@affine/core/modules/agents/api';
import { ToolPermissions } from '@affine/core/modules/agents/components';
import { useAgents } from '@affine/core/modules/agents/use-agents';
import { useTelegramChannel } from '@affine/core/modules/agents/use-channels';
import { WorkbenchLink } from '@affine/core/modules/workbench';
import { TelegramChannelCard } from '../agents/channel-card';
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

// Tool grouping — Hermes tools carry no explicit group/consequential flags in
// the caps catalog (HermesTool = {slug,label,available}), so we derive both from
// the slug prefix here and feed them to Trame's <ToolPermissions> grouped grid:
//   • internal  → shops & data reads (safe, non-consequential)
//   • composio  → connected third-party apps (act on the outside world)
//   • make      → the built-in drafting/reasoning assistant (server-side)
type Kind = 'internal' | 'composio' | 'make';
const KIND_TITLE: Record<Kind, string> = {
  internal: '🧾 Interne — boutiques et données',
  composio: '🔗 Applications connectées (Composio)',
  make: '🤖 Assistant — rédaction et raisonnement',
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
        .map(w => ({ title: w.title || 'Flux enregistré', goal: w.goal })),
    [workflows]
  );

  // Map the live capabilities catalog into Trame's <ToolPermissions> contract
  // ({id,label,group,consequential}[]). `enabled` (a Set<string> of slugs) stays
  // the source of truth for the save; the grid drives it via onChange.
  const toolPermTools = useMemo(
    () =>
      (caps?.tools ?? []).map(tool => {
        const kind = classify(tool.slug);
        return {
          id: tool.slug,
          label: tool.label || tool.slug,
          group: KIND_TITLE[kind],
          // Internal reads are safe; connected-app + automation actions reach the
          // outside world, so mark them consequential (the grid can flag them).
          consequential: kind !== 'internal',
        };
      }),
    [caps]
  );

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
            ⚙ Configuration Hermes
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: C.muted }}>
            Modifiez le nom, le focus, les outils et les flux enregistrés de votre agent.
          </p>
        </div>
        <button style={btnStyle('secondary')} onClick={onClose}>
          ← Retour
        </button>
      </div>

      {save.kind === 'error' ? <Banner tone="error">{save.message}</Banner> : null}

      {/* Identity */}
      <Panel title="Identité">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Nom de l'agent" error={nameErr}>
            <input
              style={inputStyle}
              value={agentName}
              maxLength={40}
              onChange={e => setAgentName(e.target.value)}
            />
          </Field>
          <Field label="Persona / objectif permanent" error={personaErr}>
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
      <Panel title="Mode d'exécution par défaut">
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

      {/* Tools — per-agent permissions via Trame's shared <ToolPermissions>
          grouped toggle grid (R11). Replaces the bespoke checklist; `enabled`
          (a Set<string> of tool slugs) remains the source of truth persisted by
          the existing config PUT. The All/None action + the load / error / empty
          faces are kept; only the grid body is now the shared component. */}
      <Panel
        title={`Outils (${enabled.size} activé${enabled.size > 1 ? 's' : ''})`}
        action={
          caps && caps.tools.length > 0 ? (
            <span style={{ display: 'flex', gap: 8 }}>
              <button
                style={miniBtnStyle('secondary')}
                onClick={() => setEnabled(new Set(caps.tools.map(t => t.slug)))}
              >
                Tout
              </button>
              <button
                style={miniBtnStyle('secondary')}
                onClick={() => setEnabled(new Set())}
              >
                Aucun
              </button>
            </span>
          ) : undefined
        }
      >
        {capsError ? (
          <Banner tone="warn">
            Impossible de charger le catalogue d'outils.{' '}
            <button
              style={{ ...miniBtnStyle('secondary'), display: 'inline-flex' }}
              onClick={() => void loadCaps()}
            >
              Réessayer
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
            <Spinner /> Chargement des outils…
          </div>
        ) : caps.tools.length === 0 ? (
          <Banner tone="info">
            Aucun outil publié pour le moment. Connectez des applications depuis Intégrations pour
            débloquer des actions.
          </Banner>
        ) : (
          <ToolPermissions
            tools={toolPermTools}
            value={enabled}
            onChange={next => setEnabled(next)}
          />
        )}
      </Panel>

      {/* Canaux — how Hermes reaches the outside world (Telegram / WhatsApp /
          web). Read-only status derived from the account-level caps; the real
          setup lives on the global connections page. */}
      <CanauxPanel />

      {/* Saved workflows */}
      <Panel
        title={`Flux enregistrés (${cleanWorkflows.length})`}
        action={
          <button style={miniBtnStyle('primary')} onClick={addWorkflow}>
            + Ajouter
          </button>
        }
      >
        {workflows.length === 0 ? (
          <div style={{ fontSize: 12.5, color: C.muted, padding: '8px 4px' }}>
            Aucun flux enregistré. Ajoutez-en un pour qu'il apparaisse sur votre tableau de bord.
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
                    placeholder="Titre du flux"
                    onChange={e => updateWorkflow(i, { title: e.target.value })}
                  />
                  <button
                    style={miniBtnStyle('danger')}
                    onClick={() => removeWorkflow(i)}
                    title="Supprimer le flux"
                  >
                    Supprimer
                  </button>
                </div>
                <textarea
                  style={textareaStyle}
                  value={wf.goal}
                  maxLength={800}
                  placeholder="Objectif — formulez-le comme vous le demanderiez à Hermes."
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
            ✓ Enregistré
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        <button style={btnStyle('secondary')} onClick={onClose}>
          Annuler
        </button>
        <button style={btnStyle('primary', !canSave)} disabled={!canSave} onClick={() => void doSave()}>
          {save.kind === 'saving' ? (
            <>
              <Spinner dark /> Enregistrement…
            </>
          ) : (
            'Enregistrer les modifications'
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
      {/* R11 — a clearer "connecté à @bot" summary + a safe (confirm-gated)
          unpair, sitting above the R10 BYOT card. The R10 channel status shape
          ({connected,botUsername,connectedAt}) carries no bound-chat / last-
          inbound, so we surface the bot identity plainly rather than inventing
          fields. */}
      <TelegramBoundLine agent="hermes" />
      {/* R10 BYOT — connect your OWN Telegram bot to Hermes, right here. */}
      <div style={{ marginTop: 12 }}>
        <TelegramChannelCard agent="hermes" />
      </div>
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// TelegramBoundLine — a compact "connecté à @bot" strip shown ONLY when the
// user has a bot bound to this agent. Reads Passe's `useTelegramChannel(agent)`
// hook (the same hook the embedded card uses; safe to consume twice — each
// instance owns its own state and both read the same GET). Adds a confirm-gated
// "Dissocier" (unpair) affordance the raw card lacks. Fail-soft: any not-
// connected / dark / loading state renders nothing so the card owns those faces
// and this never double-renders an empty row.
//   CONSUMED CONTRACT — useTelegramChannel(agent) → { status:{connected,
//   botUsername?,connectedAt?}, disconnect(), loading }. Read defensively.
// ---------------------------------------------------------------------------
const TelegramBoundLine = ({ agent }: { agent: 'hermes' }) => {
  const channel = useTelegramChannel(agent) as
    | {
        status?: {
          connected?: boolean;
          botUsername?: string | null;
          connectedAt?: number | string;
        };
        disconnect?: () => Promise<void>;
        loading?: boolean;
      }
    | undefined;

  const status = channel?.status ?? {};
  const connected = !!status.connected;
  const botUsername = status.botUsername ?? undefined;

  const [confirming, setConfirming] = useState(false);
  const [unpairing, setUnpairing] = useState(false);

  const doUnpair = useCallback(() => {
    if (unpairing || !channel?.disconnect) return;
    setUnpairing(true);
    void (async () => {
      try {
        await channel.disconnect!();
      } catch {
        // Best-effort — the hook re-probes; a failed unpair leaves the
        // connected face up, which is honest.
      } finally {
        setUnpairing(false);
        setConfirming(false);
      }
    })();
  }, [unpairing, channel]);

  // Only render when a bot is actually bound; otherwise the card owns the UI.
  if (!connected) return null;

  return (
    <div
      style={{
        marginTop: 12,
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 9,
        background: C.okSoft,
        border: `1px solid ${C.okBorder}`,
      }}
    >
      <span aria-hidden style={{ fontSize: 15, flexShrink: 0 }}>
        ✈
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.text }}>
        Connecté à{' '}
        <span
          dir="ltr"
          style={{
            fontWeight: 700,
            fontFamily: 'var(--affine-font-code-family, monospace)',
          }}
        >
          @{botUsername || 'votre bot'}
        </span>
      </span>
      {confirming ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: C.muted }}>Dissocier ?</span>
          <button
            style={miniBtnStyle('danger')}
            disabled={unpairing}
            onClick={() => void doUnpair()}
          >
            {unpairing ? 'Dissociation…' : 'Confirmer'}
          </button>
          <button
            style={miniBtnStyle('secondary')}
            disabled={unpairing}
            onClick={() => setConfirming(false)}
          >
            Annuler
          </button>
        </span>
      ) : (
        <button
          style={miniBtnStyle('secondary')}
          onClick={() => setConfirming(true)}
          title="Dissocier ce bot de Hermès"
        >
          Dissocier
        </button>
      )}
    </div>
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

export default HermesConfigPanel;
