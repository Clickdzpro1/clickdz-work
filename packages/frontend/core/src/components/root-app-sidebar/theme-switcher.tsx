/**
 * Compact theme switcher for the sidebar header row.
 *
 * A small palette icon that opens a popover of the 5 ClickDz theme swatches.
 * One click applies the preset via {@link ClickDzThemeService}. This surfaces
 * the theme picker (otherwise buried in Settings > Appearance) without leaving
 * the sidebar.
 */
import { IconButton, Menu, type MenuProps } from '@affine/component';
import {
  CLICKDZ_THEMES,
  ClickDzThemeService,
} from '@affine/core/modules/clickdz-theme';
import { DoneIcon, PaletteIcon } from '@blocksuite/icons/rc';
import { useLiveData, useService } from '@toeverything/infra';
import { useCallback } from 'react';

import * as styles from './theme-switcher.css';

const contentOptions: MenuProps['contentOptions'] = {
  align: 'end',
  className: styles.menu,
};

const ThemeSwitcherMenu = () => {
  const themeService = useService(ClickDzThemeService);
  const activeId = useLiveData(themeService.themeId$);

  const onSelect = useCallback(
    (id: string) => {
      themeService.setTheme(id);
    },
    [themeService]
  );

  return (
    <div role="radiogroup" aria-label="Theme">
      <div className={styles.heading}>Theme</div>
      <div className={styles.list}>
        {CLICKDZ_THEMES.map(theme => {
          const selected = theme.id === activeId;
          const p = theme.palette;
          return (
            <div
              key={theme.id}
              role="radio"
              aria-checked={selected}
              aria-label={theme.name}
              tabIndex={0}
              data-selected={selected}
              data-testid={`sidebar-theme-${theme.id}`}
              className={styles.row}
              onClick={() => onSelect(theme.id)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(theme.id);
                }
              }}
            >
              <span
                className={styles.swatch}
                style={{
                  background: `linear-gradient(135deg, ${p.accent} 0%, ${p.accent2} 100%)`,
                }}
              />
              <span className={styles.rowLabel}>{theme.name}</span>
              {selected ? (
                <span className={styles.check}>
                  <DoneIcon width={16} height={16} />
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const ThemeSwitcher = () => {
  return (
    <Menu items={<ThemeSwitcherMenu />} contentOptions={contentOptions}>
      <IconButton
        data-testid="sidebar-theme-switcher"
        variant="plain"
        size="20"
        tooltip="Switch theme"
        className={styles.triggerButton}
      >
        <PaletteIcon />
      </IconButton>
    </Menu>
  );
};
