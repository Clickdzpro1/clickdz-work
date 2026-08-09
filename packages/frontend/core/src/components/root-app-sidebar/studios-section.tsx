/**
 * Left-rail "Studios" group — quick access to the ClickDz creative surfaces.
 * Renders as a collapsible section at the top of the scrollable sidebar area.
 */
import { useAgents } from '@affine/core/modules/agents/use-agents';
import { MenuLinkItem } from '@affine/core/modules/app-sidebar/views';
import {
  RecentStudiosService,
  STUDIO_GROUP_ORDER,
  visibleStudios,
  type StudioDef,
} from '@affine/core/modules/studio';
import { WorkbenchService } from '@affine/core/modules/workbench';
import { useLiveData, useService } from '@toeverything/infra';

import { CollapsibleSection } from '../../desktop/components/navigation-panel';

const NewChip = () => (
  <span
    style={{
      fontSize: 10,
      fontWeight: 700,
      lineHeight: '15px',
      padding: '0 6px',
      borderRadius: 5,
      letterSpacing: '0.05em',
      // Flat-sidebar rule: NO line box. A soft accent-tinted badge only —
      // the bordered pill read as an amateur "line box" (owner feedback).
      color: 'var(--affine-primary-color)',
      backgroundColor:
        'color-mix(in srgb, var(--affine-primary-color) 14%, transparent)',
    }}
  >
    NEW
  </span>
);

// Same flat, borderless shape as NewChip but NEUTRAL (muted grey) — signals
// "experimental" without competing with the accent NEW chip.
const BetaChip = () => (
  <span
    style={{
      fontSize: 10,
      fontWeight: 700,
      lineHeight: '15px',
      padding: '0 6px',
      borderRadius: 5,
      letterSpacing: '0.05em',
      color: 'var(--affine-text-secondary-color)',
      backgroundColor:
        'color-mix(in srgb, var(--affine-text-secondary-color) 16%, transparent)',
    }}
  >
    Beta
  </span>
);

export const StudiosSection = () => {
  const workbench = useService(WorkbenchService).workbench;
  const recentStudios = useService(RecentStudiosService);
  const location = useLiveData(workbench.location$);
  // Capability flags for the unified /agents studio. useAgents() starts from a
  // safe default (caps.multi === false) and treats the feature-dark 404 as
  // "disabled" without surfacing an error, so BEFORE caps resolve and whenever
  // CDZ_AGENTS_MULTI is off, `caps.multi` is false ⇒ visibleStudios(caps)
  // returns the legacy roster and this section renders BYTE-IDENTICAL to today.
  // The only new effect is one fail-soft GET /api/v1/agents on mount.
  const { caps } = useAgents();

  const visible = visibleStudios(caps);

  const renderStudio = (studio: StudioDef) => {
    const postfix = studio.isNew ? (
      <NewChip />
    ) : studio.beta ? (
      <BetaChip />
    ) : undefined;
    return (
      <MenuLinkItem
        key={studio.id}
        data-testid={studio.testId}
        active={location.pathname.startsWith(studio.route)}
        to={studio.route}
        icon={studio.icon()}
        postfix={postfix}
        postfixDisplay={postfix ? 'always' : undefined}
        onClick={() => recentStudios.add(studio.id)}
      >
        {studio.label}
      </MenuLinkItem>
    );
  };

  return (
    <CollapsibleSection
      path={['studios']}
      title="Studios"
      contentStyle={{ padding: '6px 8px 0 8px' }}
    >
      {STUDIO_GROUP_ORDER.map(({ group, label }) => {
        const groupStudios = visible.filter(s => s.group === group);
        if (groupStudios.length === 0) return null;
        return (
          <div key={group}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                lineHeight: '24px',
                padding: '8px 8px 2px 8px',
                color: 'var(--affine-text-secondary-color)',
                letterSpacing: '0.02em',
                textTransform: 'uppercase',
              }}
            >
              {label}
            </div>
            {groupStudios.map(renderStudio)}
          </div>
        );
      })}
      {/* Render any studios whose group is not in STUDIO_GROUP_ORDER (future-proofing) */}
      {visible
        .filter(s => !STUDIO_GROUP_ORDER.some(g => g.group === s.group))
        .map(renderStudio)}
    </CollapsibleSection>
  );
};
