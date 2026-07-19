import { IconButton, Menu } from '@affine/component';
import { STUDIOS } from '@affine/core/modules/studio/registry';
import { WorkbenchService } from '@affine/core/modules/workbench';
import { NotificationIcon } from '@blocksuite/icons/rc';
import { useLiveData, useService } from '@toeverything/infra';
import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';

import * as styles from './bell.css';
import type { AppNotification } from './service';
import { PlatformNotifyService } from './service';

/** Compact, dependency-free relative time (e.g. "just now", "5m", "3h", "2d"). */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Studio icon element for a notification, falling back to the bell glyph. */
function studioIcon(studio: AppNotification['studio']): ReactNode {
  const def = STUDIOS.find(s => s.id === studio);
  return def ? def.icon() : <NotificationIcon />;
}

const Badge = ({ count }: { count: number }) => {
  if (count <= 0) return null;
  return <span className={styles.badge}>{count > 99 ? '99+' : count}</span>;
};

const NotifyItem = ({
  item,
  onAction,
}: {
  item: AppNotification;
  onAction: (item: AppNotification) => void;
}) => {
  const handleAction = useCallback(() => {
    onAction(item);
  }, [item, onAction]);

  return (
    <div className={styles.item} data-testid="notify-item">
      <span className={styles.itemIcon}>{studioIcon(item.studio)}</span>
      <div className={styles.itemBody}>
        <div className={styles.itemTitle}>
          {!item.read ? <span className={styles.unreadDot} /> : null}
          {item.title}
        </div>
        {item.body ? <div className={styles.itemText}>{item.body}</div> : null}
        <div className={styles.itemMeta}>
          <span className={styles.itemTime}>{relativeTime(item.ts)}</span>
          {item.action ? (
            <button
              type="button"
              className={styles.actionButton}
              onClick={handleAction}
            >
              {item.action.label}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const NotifyInbox = () => {
  const notifyService = useService(PlatformNotifyService);
  const workbenchService = useService(WorkbenchService);
  const items = useLiveData(notifyService.items$);

  const handleAction = useCallback(
    (item: AppNotification) => {
      notifyService.markRead(item.id);
      const route = item.action?.route;
      if (route) {
        workbenchService.workbench.open(route);
      }
    },
    [notifyService, workbenchService]
  );

  const handleClear = useCallback(() => {
    notifyService.clear();
  }, [notifyService]);

  return (
    <div className={styles.inbox}>
      <div className={styles.inboxHeader}>
        <span className={styles.inboxTitle}>Notifications</span>
        {items.length > 0 ? (
          <button
            type="button"
            className={styles.clearButton}
            onClick={handleClear}
          >
            Clear
          </button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <div className={styles.empty}>You&apos;re all caught up.</div>
      ) : (
        <div className={styles.list}>
          {items.map(item => (
            <NotifyItem key={item.id} item={item} onAction={handleAction} />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Header bell button: a boot-safe {@link NotificationIcon} with an unread badge
 * that opens the platform-notifications inbox in a popover. Marks everything
 * read when the inbox is opened. Reduced-motion safe (transitions live in the
 * CSS and are disabled under `prefers-reduced-motion`).
 *
 * Mount it in a studio/app header's right-hand action cluster. It resolves
 * {@link PlatformNotifyService} via the framework, so it must render inside the
 * WorkspaceScope (every studio header already does).
 */
export const NotifyBell = () => {
  const notifyService = useService(PlatformNotifyService);
  const unreadCount = useLiveData(notifyService.unreadCount$);
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        // Opening the inbox clears the unread badge.
        notifyService.markAllRead();
      }
    },
    [notifyService]
  );

  return (
    <Menu
      rootOptions={{ open, onOpenChange: handleOpenChange }}
      contentOptions={{ align: 'end', sideOffset: 8 }}
      items={<NotifyInbox />}
    >
      <span className={styles.bellRoot}>
        <IconButton
          size="20"
          variant="plain"
          tooltip="Notifications"
          data-testid="platform-notify-bell"
          aria-label="Notifications"
        >
          <NotificationIcon />
        </IconButton>
        <Badge count={unreadCount} />
      </span>
    </Menu>
  );
};
