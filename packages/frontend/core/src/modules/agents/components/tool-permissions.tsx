// ToolPermissions — a grouped toggle grid for an agent's enabled tools (R11,
// WS11-10). The owner sees every tool the agent CAN use, grouped by category,
// and flips each on/off; consequential tools (those that send/spend/act on the
// outside world) carry a small ⚠ hint so the owner knows which ones matter. Pure
// presentational — Réglages supplies the `tools` catalogue + the current `value`
// (a Set of enabled ids) + `onChange(nextSet)` (saved via the agent config put);
// it NEVER fetches. `disabled` freezes the whole grid (e.g. while saving).
//
// Shape (contract): `tools = { id, label, group, consequential }[]`,
// `value = Set<string>`, `onChange(nextSet: Set<string>)`. The handler always
// receives a NEW Set (never a mutation of the passed-in one) so callers can rely
// on referential change. Tools are bucketed by `group` in first-seen order so
// the grid layout is stable across renders; an empty catalogue ⇒ a quiet note.
//
// i18n via useAgentLang() (`toolperms.*`). RTL-safe (flips for 'ar').

import { useAgentLang } from '../i18n';
import { AgentPalette as P, ensureAgentKeyframes } from './palette';

export interface ToolPermissionItem {
  /** Stable tool id (member of the `value` set when enabled). */
  id: string;
  /** Human label shown on the toggle. */
  label: string;
  /** Category the tool is grouped under. */
  group: string;
  /** True ⇒ the tool acts on the outside world (send/spend) → ⚠ hint. */
  consequential?: boolean;
}

export interface ToolPermissionsProps {
  tools: ToolPermissionItem[];
  /** The set of currently-enabled tool ids. */
  value: Set<string>;
  /** Called with a NEW Set reflecting the toggle. */
  onChange: (nextSet: Set<string>) => void;
  /** Freeze the whole grid (e.g. while a save is in flight). */
  disabled?: boolean;
}

/** Bucket tools by `group`, preserving first-seen group order for a stable grid. */
function byGroup(
  tools: ToolPermissionItem[]
): Array<{ group: string; items: ToolPermissionItem[] }> {
  const order: string[] = [];
  const map = new Map<string, ToolPermissionItem[]>();
  for (const tItem of tools) {
    const g = tItem.group || '';
    if (!map.has(g)) {
      map.set(g, []);
      order.push(g);
    }
    map.get(g)!.push(tItem);
  }
  return order.map(g => ({ group: g, items: map.get(g)! }));
}

export function ToolPermissions({
  tools,
  value,
  onChange,
  disabled,
}: ToolPermissionsProps) {
  ensureAgentKeyframes();
  const { t, dir } = useAgentLang();

  const list = Array.isArray(tools) ? tools : [];
  const enabled = value instanceof Set ? value : new Set<string>();

  const toggle = (id: string) => {
    if (disabled) return;
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  // ── Empty catalogue ───────────────────────────────────────────────────────
  if (list.length === 0) {
    return (
      <div
        dir={dir}
        style={{
          padding: `${P.space.md}px ${P.space.md}px`,
          borderRadius: P.radius.md,
          border: `1px dashed ${P.color.border}`,
          background: P.color.panelRaised,
          color: P.color.muted,
          fontSize: P.font.size.md,
          textAlign: 'center',
        }}
      >
        {t('toolperms.empty')}
      </div>
    );
  }

  const groups = byGroup(list);

  return (
    <div
      dir={dir}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: P.space.lg,
        opacity: disabled ? 0.6 : 1,
        transition: `opacity ${P.motion.base} ${P.motion.ease}`,
      }}
    >
      {groups.map(({ group, items }) => (
        <div key={group || '_'}>
          {group ? (
            <div
              style={{
                fontSize: P.font.size.xs,
                fontWeight: 700,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                color: P.color.muted,
                marginBottom: P.space.sm,
              }}
            >
              {group}
            </div>
          ) : null}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: P.space.sm,
            }}
          >
            {items.map(tool => {
              const on = enabled.has(tool.id);
              return (
                <button
                  key={tool.id}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() => toggle(tool.id)}
                  disabled={disabled}
                  className="cdz-agent-motion"
                  title={
                    tool.consequential ? t('toolperms.consequential') : undefined
                  }
                  style={{
                    appearance: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: P.space.sm,
                    textAlign: 'start',
                    padding: `${P.space.sm}px ${P.space.md}px`,
                    borderRadius: P.radius.md,
                    border: `1px solid ${on ? P.color.accentBorder : P.color.border}`,
                    background: on ? P.color.accentSoft : 'transparent',
                    color: on ? P.color.text : P.color.muted,
                    cursor: disabled ? 'default' : 'pointer',
                    transition: `background ${P.motion.fast} ${P.motion.ease}, border-color ${P.motion.fast} ${P.motion.ease}, color ${P.motion.fast} ${P.motion.ease}`,
                    boxSizing: 'border-box',
                    minWidth: 0,
                  }}
                >
                  {/* Checkbox glyph */}
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 18,
                      height: 18,
                      flex: '0 0 auto',
                      borderRadius: P.radius.xs,
                      border: `1px solid ${on ? P.color.accent : P.color.border}`,
                      background: on ? P.color.accent : 'transparent',
                      color: P.color.onAccent,
                      fontSize: 12,
                      lineHeight: 1,
                    }}
                  >
                    {on ? '✓' : ''}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: P.font.size.md,
                      fontWeight: 600,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {tool.label || tool.id}
                  </span>
                  {tool.consequential ? (
                    <span
                      aria-label={t('toolperms.consequential')}
                      title={t('toolperms.consequential')}
                      style={{
                        flex: '0 0 auto',
                        fontSize: 12,
                        color: P.color.warn,
                      }}
                    >
                      ⚠
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default ToolPermissions;
