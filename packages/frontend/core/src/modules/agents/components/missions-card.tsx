// MissionsCard — the "missions programmées" shelf in Hermès' Bureau (R11,
// WS11-7). A compact read-out of the agent's scheduled triggers (R8 shape): each
// row shows a human schedule label (parsed from the backend preset id), a short
// prompt preview and an active/paused toggle, plus a single "Gérer" that opens
// the full triggers page. It is the at-a-glance half of the triggers surface —
// the owner sees what will run itself, flips one on/off inline, and jumps to the
// full editor for anything more. Pure presentational — Bureau supplies
// `triggers`, `onToggle(id)`, `onOpen`; it NEVER fetches.
//
// Shape (contract): `triggers = { id, preset, prompt, active, nextFireAt? }[]`
// (a subset of the R8 AgentTrigger). Preset ids are the backend contract:
// `hourly` | `daily@HH:MM` | `weekly@D@HH:MM` (D = 1=Mon..7=Sun); the local
// `presetLabel` turns those into readable copy via the shared `triggers.preset.*`
// keys, falling back to the raw preset for anything unrecognised. Empty ⇒ a calm
// prompt to schedule the first mission (with the same "Gérer" entry).
//
// i18n via useAgentLang() (`bureau.missions.*` + reuses `triggers.*`). RTL-safe.

import { useState } from 'react';

import { useAgentLang } from '../i18n';
import { AgentPalette as P, ensureAgentKeyframes } from './palette';
import { Chip } from './primitives';

export interface MissionTrigger {
  /** Trigger id (what `onToggle` echoes back). */
  id: string;
  /** Backend preset id: `hourly` | `daily@HH:MM` | `weekly@D@HH:MM`. */
  preset?: string;
  /** The task the agent runs each fire (shown as a one-line preview). */
  prompt: string;
  /** Whether the trigger is active (paused ⇒ never fires). */
  active: boolean;
  /** ms-since-epoch of the next fire (optional; shown when present). */
  nextFireAt?: number;
}

export interface MissionsCardProps {
  triggers: MissionTrigger[];
  /** Toggle a mission active/paused. */
  onToggle: (id: string) => void;
  /** Open the full triggers/planification page. */
  onOpen: () => void;
}

// Weekday short labels (1=Mon..7=Sun) for a `weekly@D@HH:MM` preset. FR here is
// fine as a fallback ornament; the frequency word itself comes from i18n.
const WEEKDAYS_FR = ['', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];

/** Turn a backend preset id into a readable schedule label via `triggers.*`. */
function presetLabel(
  t: (k: string, v?: Record<string, string | number>) => string,
  preset: string | undefined
): string {
  const p = (preset || '').trim();
  if (!p) return t('bureau.missions.manual');
  if (p === 'hourly') return t('triggers.preset.hourly');
  if (p.startsWith('daily@')) {
    const hhmm = p.slice('daily@'.length);
    return `${t('triggers.preset.daily')}${hhmm ? ` · ${hhmm}` : ''}`;
  }
  if (p.startsWith('weekly@')) {
    const rest = p.slice('weekly@'.length); // "D@HH:MM"
    const [d, hhmm] = rest.split('@');
    const day = WEEKDAYS_FR[Number(d)] || '';
    return `${t('triggers.preset.weekly')}${day ? ` · ${day}` : ''}${
      hhmm ? ` ${hhmm}` : ''
    }`;
  }
  // Unrecognised preset — show it raw rather than an empty label.
  return p;
}

/** Local relative "next fire" using the shared `time.*` keys. */
function relNext(
  t: (k: string, v?: Record<string, string | number>) => string,
  at: number | undefined
): string | null {
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const ms = at - Date.now();
  if (ms <= 0) return t('time.now');
  const m = Math.round(ms / 60000);
  if (m < 60) return t('time.minAgo', { n: m }).replace(/^il y a /, '').trim() || `${m}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}j`;
}

export function MissionsCard({ triggers, onToggle, onOpen }: MissionsCardProps) {
  ensureAgentKeyframes();
  const { t, dir } = useAgentLang();
  // Track locally-toggled ids so the switch reflects the tap immediately; the
  // parent replacing the row with the server truth is what confirms it.
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const list = Array.isArray(triggers) ? triggers : [];

  const toggle = (id: string) => {
    setPending(prev => ({ ...prev, [id]: true }));
    onToggle(id);
  };

  const openBtn = (
    <button
      type="button"
      onClick={onOpen}
      className="cdz-agent-motion"
      style={{
        appearance: 'none',
        padding: '4px 12px',
        borderRadius: P.radius.sm,
        border: `1px solid ${P.color.border}`,
        background: 'transparent',
        color: P.color.text,
        fontSize: P.font.size.sm,
        // A <button> does NOT inherit the app font by default, so without this it
        // renders in the browser's default UI face — and it was observed clipped
        // to "…rer" in production. No clipping rule exists anywhere in this
        // repo's CSS for it, so the likely cause is that fallback font metric
        // (or an injected outer stylesheet) squeezing a fixed-height row.
        // Inheriting the font and refusing to wrap costs nothing at this size and
        // removes both possibilities.
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        fontWeight: 600,
        cursor: 'pointer',
        flex: '0 0 auto',
      }}
    >
      {t('bureau.missions.manage')}
    </button>
  );

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: P.space.sm,
        marginBottom: P.space.sm,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: P.font.size.xs,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: P.color.muted,
        }}
      >
        {t('bureau.missions.title')}
      </span>
      {openBtn}
    </div>
  );

  // ── Empty state ───────────────────────────────────────────────────────────
  if (list.length === 0) {
    return (
      <div dir={dir}>
        {header}
        <div
          style={{
            padding: `${P.space.lg}px ${P.space.md}px`,
            borderRadius: P.radius.md,
            border: `1px dashed ${P.color.border}`,
            background: P.color.panelRaised,
            color: P.color.muted,
            fontSize: P.font.size.md,
            textAlign: 'center',
            lineHeight: 1.5,
          }}
        >
          {t('bureau.missions.empty')}
        </div>
      </div>
    );
  }

  return (
    <div dir={dir}>
      {header}
      <div style={{ display: 'flex', flexDirection: 'column', gap: P.space.sm }}>
        {list.map(m => {
          const on = pending[m.id] !== undefined ? !m.active : m.active;
          const next = relNext(t, m.nextFireAt);
          return (
            <div
              key={m.id}
              className="cdz-agent-fade"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: P.space.md,
                padding: `${P.space.md}px ${P.space.md}px`,
                borderRadius: P.radius.md,
                border: `1px solid ${P.color.border}`,
                background: P.color.panelRaised,
                boxSizing: 'border-box',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    style={{
                      fontSize: P.font.size.md,
                      fontWeight: 700,
                      color: on ? P.color.text : P.color.muted,
                    }}
                  >
                    {presetLabel(t, m.preset)}
                  </span>
                  {next && on ? (
                    <Chip>
                      <span dir="ltr">{t('bureau.missions.next', { when: next })}</span>
                    </Chip>
                  ) : null}
                </div>
                <div
                  title={m.prompt}
                  style={{
                    marginTop: 3,
                    fontSize: P.font.size.sm,
                    color: P.color.muted,
                    lineHeight: 1.45,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    opacity: on ? 1 : 0.7,
                  }}
                >
                  {m.prompt || t('bureau.missions.noPrompt')}
                </div>
              </div>

              {/* Active toggle — a small pill switch (reduced-motion safe). */}
              <button
                type="button"
                role="switch"
                aria-checked={on}
                onClick={() => toggle(m.id)}
                aria-label={
                  on ? t('triggers.toggle.pause') : t('triggers.toggle.activate')
                }
                title={
                  on ? t('triggers.toggle.pause') : t('triggers.toggle.activate')
                }
                className="cdz-agent-motion"
                style={{
                  appearance: 'none',
                  position: 'relative',
                  width: 40,
                  height: 22,
                  flex: '0 0 auto',
                  borderRadius: P.radius.pill,
                  border: `1px solid ${on ? P.color.okBorder : P.color.border}`,
                  background: on ? P.color.okBg : 'transparent',
                  cursor: 'pointer',
                  transition: `background ${P.motion.base} ${P.motion.ease}, border-color ${P.motion.base} ${P.motion.ease}`,
                  padding: 0,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 2,
                    insetInlineStart: on ? 20 : 2,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: on ? P.color.ok : P.color.muted,
                    transition: `inset-inline-start ${P.motion.base} ${P.motion.ease}, background ${P.motion.base} ${P.motion.ease}`,
                  }}
                />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default MissionsCard;
