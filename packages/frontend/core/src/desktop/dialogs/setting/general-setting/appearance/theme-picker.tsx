import type { ClickDzThemeBase } from '@affine/core/modules/clickdz-theme';
import {
  CLICKDZ_THEMES,
  ClickDzThemeService,
} from '@affine/core/modules/clickdz-theme';
import { DoneIcon } from '@blocksuite/icons/rc';
import { useLiveData, useService } from '@toeverything/infra';
import { useCallback } from 'react';

import * as styles from './theme-picker.css';

// Display-only French labels for the theme base. Do NOT use these for logic —
// `theme.base` itself stays 'light' | 'dark' everywhere else.
const BASE_LABEL_FR: Record<ClickDzThemeBase, string> = {
  dark: 'sombre',
  light: 'clair',
};

export const ThemePicker = () => {
  const themeService = useService(ClickDzThemeService);
  const activeId = useLiveData(themeService.themeId$);

  const onSelect = useCallback(
    (id: string) => {
      themeService.setTheme(id);
    },
    [themeService]
  );

  return (
    <div className={styles.grid} data-testid="clickdz-theme-picker">
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
            data-testid={`clickdz-theme-${theme.id}`}
            className={styles.card}
            onClick={() => onSelect(theme.id)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(theme.id);
              }
            }}
          >
            <div className={styles.preview} style={{ background: p.bg }}>
              <div
                className={styles.previewSidebar}
                style={{ background: p.surface }}
              />
              <div
                className={styles.previewDot}
                style={{ background: p.accent }}
              />
              <div
                className={styles.previewRow}
                style={{
                  background: p.text,
                  top: 26,
                  left: '44%',
                  width: '44%',
                }}
              />
              <div
                className={styles.previewRow}
                style={{
                  background: p.textSecondary,
                  top: 38,
                  left: '44%',
                  width: '32%',
                }}
              />
            </div>
            <div className={styles.label}>
              <span>{theme.name}</span>
              <span className={styles.baseTag}>
                · {BASE_LABEL_FR[theme.base]}
              </span>
            </div>
            {selected ? (
              <span className={styles.checkBadge}>
                <DoneIcon width={11} height={11} />
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
