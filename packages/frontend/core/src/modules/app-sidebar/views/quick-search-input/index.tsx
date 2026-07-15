import { useI18n } from '@affine/i18n';
import { SearchIcon } from '@blocksuite/icons/rc';
import clsx from 'clsx';
import { type HTMLAttributes, useMemo } from 'react';

import * as styles from './index.css';

interface QuickSearchInputProps extends HTMLAttributes<HTMLDivElement> {
  onClick?: () => void;
}

// Although it is called an input, it is actually a button.
export function QuickSearchInput({ onClick, ...props }: QuickSearchInputProps) {
  const t = useI18n();
  const modKey = useMemo(() => (environment.isMacOs ? '⌘' : 'Ctrl'), []);

  return (
    <div
      {...props}
      className={clsx([props.className, styles.root])}
      onClick={onClick}
      tabIndex={0}
    >
      <SearchIcon className={styles.icon} />
      <span className={styles.quickSearchBarEllipsisStyle}>
        {t['Quick search']()}
      </span>
      <div className={styles.spacer} />
      <kbd className={styles.shortcutHint} aria-hidden="true">
        <span className={styles.shortcutKey}>{modKey}</span>
        <span className={styles.shortcutKey}>K</span>
      </kbd>
    </div>
  );
}
