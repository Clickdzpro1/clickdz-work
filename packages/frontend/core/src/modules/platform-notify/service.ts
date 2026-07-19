import { notify } from '@affine/component';
import type { StudioId } from '@affine/core/modules/studio/registry';
import { LiveData, Service } from '@toeverything/infra';
import { map } from 'rxjs';

import type { WorkspaceLocalState } from '../workspace';

/**
 * A single platform notification, as rendered by the bell inbox.
 *
 * `studio` is a {@link StudioId} (so the inbox can show the studio icon via the
 * registry) or the literal `'platform'` for shell-level events that don't
 * belong to one studio. Everything here is JSON-serialisable so the whole list
 * round-trips through `WorkspaceLocalState` unchanged.
 */
export interface AppNotification {
  id: string;
  studio: StudioId | 'platform';
  title: string;
  body?: string;
  ts: number;
  read: boolean;
  action?: { label: string; route?: string };
}

/** Input for {@link PlatformNotifyService.notify}. */
export interface NotifyInput {
  studio: StudioId | 'platform';
  title: string;
  body?: string;
  action?: { label: string; route?: string };
}

const NOTIFICATIONS_KEY = 'clickdz-notifications';
/** Hard cap on the persisted list — newest kept, oldest dropped. */
const MAX_ITEMS = 50;

const EMPTY: AppNotification[] = [];

/**
 * Frontend, single-window platform notifications hub.
 *
 * This is a deliberately backend-free notifications centre (recon
 * RECON-NOTIFY-HYGIENE §A3): AFFiNE's own `modules/notification` is
 * GraphQL/DB-bound, so instead of extending it we keep a small
 * `WorkspaceLocalState`-persisted list here and pair it with a transient
 * `notify()` (sonner) toast for the pop.
 *
 * The persisted list is the single source of truth. `items$` is a `LiveData`
 * derived from `localState.watch(...)`, which means:
 *   - the bell re-renders reactively whenever the list changes, and
 *   - a FUTURE server-authoritative feed (SSE) can push into the exact same
 *     store by calling {@link ingest} (or writing the key) — the UI needs zero
 *     changes to start showing pushed items.
 *
 * LIMITATION (single-window): today notifications are minted only for events an
 * in-app live hook observes (e.g. the agent SSE `final` frame while the console
 * is open). While-away / cross-device delivery is a later cross-device item;
 * `items$`/`ingest` are shaped so that feed can drop in without touching the
 * bell. Nothing here ever throws — a broken persist/parse degrades to an empty
 * list rather than crashing the shell.
 */
export class PlatformNotifyService extends Service {
  constructor(private readonly localState: WorkspaceLocalState) {
    super();
  }

  /** Newest-first, capped list, reactively backed by the persisted key. */
  readonly items$ = LiveData.from<AppNotification[]>(
    this.localState
      .watch<AppNotification[]>(NOTIFICATIONS_KEY)
      .pipe(map(list => (Array.isArray(list) ? list : EMPTY))),
    this.read()
  );

  /** Count of unread items, derived from {@link items$}. */
  readonly unreadCount$ = this.items$.map(
    list => list.filter(n => !n.read).length
  );

  /**
   * Record a notification: prepend it to the persisted list AND fire a
   * transient success toast via the app's `notify()` util. Safe to call from
   * anywhere (event handlers, SSE hooks) — it never throws.
   */
  notify(input: NotifyInput): void {
    const item: AppNotification = {
      id: `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      studio: input.studio,
      title: input.title,
      body: input.body,
      ts: Date.now(),
      read: false,
      action: input.action,
    };
    this.ingest(item);
    try {
      notify.success({
        title: input.title,
        message: input.body,
      });
    } catch {
      // A toast failure must never break the caller's flow.
    }
  }

  /**
   * Push a fully-formed notification into the store (newest-first, capped).
   * This is the seam a future SSE/server feed writes through — same store, same
   * reactive `items$`, no UI change required.
   */
  ingest(item: AppNotification): void {
    const next = [item, ...this.read()].slice(0, MAX_ITEMS);
    this.write(next);
  }

  /** Mark every item as read. */
  markAllRead(): void {
    const list = this.read();
    if (!list.some(n => !n.read)) return;
    this.write(list.map(n => (n.read ? n : { ...n, read: true })));
  }

  /** Mark a single item read by id (no-op if already read / missing). */
  markRead(id: string): void {
    const list = this.read();
    if (!list.some(n => n.id === id && !n.read)) return;
    this.write(list.map(n => (n.id === id ? { ...n, read: true } : n)));
  }

  /** Empty the inbox. */
  clear(): void {
    if (this.read().length === 0) return;
    this.write([]);
  }

  private read(): AppNotification[] {
    try {
      const list = this.localState.get<AppNotification[]>(NOTIFICATIONS_KEY);
      return Array.isArray(list) ? list : EMPTY;
    } catch {
      return EMPTY;
    }
  }

  private write(list: AppNotification[]): void {
    try {
      this.localState.set(NOTIFICATIONS_KEY, list);
    } catch {
      // Persist failures are non-fatal; the UI simply keeps its last state.
    }
  }
}
