/**
 * CDZ context-handoff preference for the model-switch UX (WS2 PR-B).
 *
 * When the user switches to a DIFFERENT model mid-conversation, the
 * preference popup asks whether the new model should read the existing
 * thread. The answer is stored here, PER SESSION, and read back by the chat
 * transport so the chosen mode rides every subsequent send as the
 * `?contextMode=` query param the copilot controller already forwards.
 *
 * Persistence mirrors `image-model-preference.ts` exactly — blocksuite land
 * has no service DI at this layer, so the choice lives in a module-level map
 * mirrored to localStorage (same class of storage as the vdz layout). The
 * only difference from the image preference is the shape: this one is a
 * `{ [sessionId]: mode }` map rather than a single scalar, because the
 * handoff decision is scoped to one conversation, not global.
 *
 * ZERO-REGRESSION CONTRACT: an unset session returns `undefined`, and the
 * transport skips the query param entirely when it is `undefined` — so with
 * no stored mode a request is byte-identical to today's (no empty param).
 */

const STORAGE_KEY = 'cdz:context-mode:v1';

export const CDZ_CONTEXT_MODES = ['recent', 'compact', 'fresh'] as const;

export type CdzContextMode = (typeof CDZ_CONTEXT_MODES)[number];

function isContextMode(value: unknown): value is CdzContextMode {
  return (
    value === 'recent' || value === 'compact' || value === 'fresh'
  );
}

// Module-level per-session map (the contract's "module-level per-session
// map"). Hydrated lazily from localStorage on first touch and kept in sync on
// every write, so repeated reads within a session never re-parse storage.
let cache: Record<string, CdzContextMode> | null = null;

function load(): Record<string, CdzContextMode> {
  if (cache) return cache;
  const next: Record<string, CdzContextMode> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        for (const [sessionId, mode] of Object.entries(
          parsed as Record<string, unknown>
        )) {
          if (isContextMode(mode)) next[sessionId] = mode;
        }
      }
    }
  } catch {
    // no storage (SSR / private mode) or corrupt JSON — start empty
  }
  cache = next;
  return cache;
}

function persist(map: Record<string, CdzContextMode>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // non-fatal: the in-memory map still serves this session
  }
}

/**
 * The context mode chosen for `sessionId`, or `undefined` when the user has
 * not made a handoff choice for this conversation. `undefined` MUST be
 * treated as "exactly today's behavior" by callers (no query param emitted).
 */
export function getContextMode(sessionId: string): CdzContextMode | undefined {
  if (!sessionId) return undefined;
  return load()[sessionId];
}

/** Record the handoff choice for `sessionId`. */
export function setContextMode(
  sessionId: string,
  mode: CdzContextMode
): void {
  if (!sessionId) return;
  const map = load();
  map[sessionId] = mode;
  persist(map);
}

/**
 * Forget the handoff choice for `sessionId` (used when a fresh discussion is
 * started so the reset conversation falls back to default behavior).
 */
export function clearContextMode(sessionId: string): void {
  if (!sessionId) return;
  const map = load();
  if (sessionId in map) {
    delete map[sessionId];
    persist(map);
  }
}
