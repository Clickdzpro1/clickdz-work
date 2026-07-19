/**
 * Studio switcher — a compact dropdown that jumps between the ClickDz studios.
 *
 * Reads the single-source-of-truth {@link STUDIOS} registry, buckets entries by
 * `group`, and floats the most-recently-used studios (via
 * {@link RecentStudiosService}) to the top. Selecting an entry navigates with
 * `WorkbenchService.workbench.open(route)` and records the visit. The active
 * studio is derived from `workbench.location$` + `studioForPath`, so highlight
 * state never drifts from the registry.
 *
 * Boot-safe icons only — every glyph rendered here comes from the registry's
 * icon thunks (which import only the six verified `@blocksuite/icons/rc`
 * symbols).
 */
import { Menu, MenuItem, MenuSeparator } from '@affine/component';
import { MenuItem as SidebarMenuItem } from '@affine/core/modules/app-sidebar/views';
import {
  RecentStudiosService,
  STUDIOS,
  type StudioDef,
  type StudioGroup,
  type StudioId,
  studioForPath,
} from '@affine/core/modules/studio';
import { WorkbenchService } from '@affine/core/modules/workbench';
import { ArrowDownSmallIcon } from '@blocksuite/icons/rc';
import { useLiveData, useService } from '@toeverything/infra';
import { useCallback, useMemo } from 'react';

const GROUP_ORDER: { id: StudioGroup; label: string }[] = [
  { id: 'create', label: 'Create' },
  { id: 'commerce', label: 'Commerce' },
  { id: 'agents', label: 'Agents' },
  { id: 'connect', label: 'Connect' },
];

const headingStyle = {
  fontSize: 11,
  fontWeight: 600,
  lineHeight: '18px',
  padding: '4px 12px 2px',
  color: 'var(--affine-text-secondary-color)',
} as const;

const StudioSwitcherMenu = () => {
  const workbench = useService(WorkbenchService).workbench;
  const recentStudios = useService(RecentStudiosService);
  const location = useLiveData(workbench.location$);
  const recentIds = useLiveData(recentStudios.recents$);

  const activeStudio = studioForPath(location.pathname);

  const onSelect = useCallback(
    (studio: StudioDef) => {
      workbench.open(studio.route);
      recentStudios.add(studio.id);
    },
    [recentStudios, workbench]
  );

  const byId = useMemo(() => {
    const map = new Map<StudioId, StudioDef>();
    for (const studio of STUDIOS) {
      map.set(studio.id, studio);
    }
    return map;
  }, []);

  const recentStudioDefs = useMemo(
    () =>
      recentIds
        .map(id => byId.get(id))
        .filter((studio): studio is StudioDef => !!studio),
    [byId, recentIds]
  );

  const renderItem = (studio: StudioDef) => (
    <MenuItem
      key={studio.id}
      data-testid={`studio-switcher-${studio.id}`}
      prefixIcon={studio.icon()}
      selected={activeStudio?.id === studio.id}
      onSelect={() => onSelect(studio)}
    >
      {studio.label}
    </MenuItem>
  );

  return (
    <>
      {recentStudioDefs.length > 0 ? (
        <>
          <div style={headingStyle}>Recent</div>
          {recentStudioDefs.map(studio => (
            <MenuItem
              key={`recent-${studio.id}`}
              data-testid={`studio-switcher-recent-${studio.id}`}
              prefixIcon={studio.icon()}
              selected={activeStudio?.id === studio.id}
              onSelect={() => onSelect(studio)}
            >
              {studio.label}
            </MenuItem>
          ))}
          <MenuSeparator />
        </>
      ) : null}
      {GROUP_ORDER.map(group => {
        const items = STUDIOS.filter(studio => studio.group === group.id);
        if (items.length === 0) return null;
        return (
          <div key={group.id}>
            <div style={headingStyle}>{group.label}</div>
            {items.map(renderItem)}
          </div>
        );
      })}
    </>
  );
};

export const StudioSwitcher = () => {
  const workbench = useService(WorkbenchService).workbench;
  const location = useLiveData(workbench.location$);
  const activeStudio = studioForPath(location.pathname);

  return (
    <Menu
      items={<StudioSwitcherMenu />}
      contentOptions={{ align: 'start', style: { minWidth: 220 } }}
    >
      <SidebarMenuItem
        data-testid="studio-switcher-trigger"
        icon={activeStudio ? activeStudio.icon() : undefined}
        postfix={<ArrowDownSmallIcon />}
        postfixDisplay="always"
      >
        {activeStudio ? activeStudio.label : 'Studios'}
      </SidebarMenuItem>
    </Menu>
  );
};
