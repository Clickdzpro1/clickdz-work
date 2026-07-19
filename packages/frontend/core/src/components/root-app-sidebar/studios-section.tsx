/**
 * Left-rail "Studios" group — quick access to the ClickDz creative surfaces.
 * Renders as a collapsible section at the top of the scrollable sidebar area.
 */
import { MenuLinkItem } from '@affine/core/modules/app-sidebar/views';
import { WorkbenchService } from '@affine/core/modules/workbench';
import { AiIcon, BlockLinkIcon, FrameIcon, VoiceIcon } from '@blocksuite/icons/rc';
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
    béta
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
      <MenuLinkItem
        data-testid="slider-bar-integrations-button"
        active={location.pathname.startsWith('/integrations')}
        to={'/integrations'}
        icon={<BlockLinkIcon />}
        postfix={<BetaChip />}
        postfixDisplay="always"
      >
        🔌 Integrations
      </MenuLinkItem>
      <MenuLinkItem
        data-testid="slider-bar-shoperp-button"
        active={location.pathname.startsWith('/shoperp')}
        to={'/shoperp'}
        icon={<BlockLinkIcon />}
        postfix={<BetaChip />}
        postfixDisplay="always"
      >
        🛍️ Shop ERP
      </MenuLinkItem>
      <MenuLinkItem
        data-testid="slider-bar-voice-studio-button"
        active={location.pathname.startsWith('/voice')}
        to={'/voice'}
        icon={<VoiceIcon />}
        postfix={<BetaChip />}
        postfixDisplay="always"
      >
        Voice Studio
      </MenuLinkItem>
    </CollapsibleSection>
  );
};
