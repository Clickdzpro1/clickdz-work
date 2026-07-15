/**
 * Left-rail "Studios" group — quick access to the ClickDz creative surfaces.
 * Renders as a collapsible section at the top of the scrollable sidebar area.
 */
import { MenuLinkItem } from '@affine/core/modules/app-sidebar/views';
import { WorkbenchService } from '@affine/core/modules/workbench';
import { AiIcon, FrameIcon } from '@blocksuite/icons/rc';
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
      // accent-tinted pill: legible on every theme (no white-on-accent risk)
      // and reads as premium rather than a loud solid badge.
      color: 'var(--affine-primary-color)',
      backgroundColor:
        'color-mix(in srgb, var(--affine-primary-color) 16%, transparent)',
      border:
        '1px solid color-mix(in srgb, var(--affine-primary-color) 32%, transparent)',
    }}
  >
    NEW
  </span>
);

export const StudiosSection = () => {
  const workbench = useService(WorkbenchService).workbench;
  const location = useLiveData(workbench.location$);

  return (
    <CollapsibleSection
      path={['studios']}
      title="Studios"
      contentStyle={{ padding: '6px 8px 0 8px' }}
    >
      <MenuLinkItem
        data-testid="slider-bar-vdz-studio-button"
        active={location.pathname.startsWith('/vdz')}
        to={'/vdz'}
        icon={<FrameIcon />}
        postfix={<NewChip />}
        postfixDisplay="always"
      >
        Vdz Studio
      </MenuLinkItem>
      <MenuLinkItem
        data-testid="slider-bar-clickdz-apps-button"
        active={location.pathname.startsWith('/chat')}
        to={'/chat'}
        icon={<AiIcon />}
      >
        ClickDz Apps
      </MenuLinkItem>
    </CollapsibleSection>
  );
};
