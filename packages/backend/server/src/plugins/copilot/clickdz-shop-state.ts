// ---------------------------------------------------------------------------
// R2-h (WSB-3) — ShopState: the server-side single source of truth for a
// published storefront. Binding decision C7: Redis JSON v1 (NOT Postgres) — it
// mirrors the publish-record pattern already in the bridge, ships in one image
// build, and needs no Prisma migration on the money path.
//
// Framework-light by design: every export takes the Redis client (`cache`) as
// its FIRST parameter instead of importing CacheRedis, so this module has ZERO
// framework imports and is trivially unit-testable with a stub. The bridge
// passes `this.redis` (a CacheRedis, which extends ioredis) — it satisfies the
// tiny `ShopStateCache` interface structurally, no cast needed.
//
// Storage layout (per owner+slug):
//   clickdz:shopstate:{userId}:{slug}        → the JSON ShopState blob
//   clickdz:shopstate:{userId}:{slug}:v:{id} → a single version's full HTML
// Both carry a 90-day rolling TTL that every write RE-ARMS, so an actively
// edited shop's state never expires out from under it, while an abandoned one
// self-cleans on the same 90d window the rest of the ClickDz data layer uses.
//
// Everything here is gated at the ROUTE layer by env CDZ_SHOP_STATE (OFF ⇒ the
// bridge routes 404 and this module is never called ⇒ byte-identical current
// behaviour). This file itself is behaviour-neutral until a route invokes it.
// ---------------------------------------------------------------------------

/**
 * The minimal slice of the ioredis surface ShopState needs. CacheRedis (which
 * extends ioredis) satisfies this structurally, so the bridge can pass
 * `this.redis` directly. Keeping the contract tiny is what makes this module
 * framework-light and stub-testable.
 */
export interface ShopStateCache {
  get(key: string): Promise<string | null>;
  // Overloaded to accept the `('EX', seconds)` TTL form used across the bridge.
  set(key: string, value: string): Promise<unknown>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/** Current on-disk schema version of the ShopState blob. */
export const SHOP_STATE_VERSION = 1 as const;

/** 90-day rolling TTL (seconds) — same window the publish set / data layer use. */
export const SHOP_STATE_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Keep at most this many rolled versions; older ones are dropped + their HTML freed. */
export const SHOP_STATE_MAX_VERSIONS = 5;

/** Cap the in-blob activity log so the JSON never balloons (newest kept). */
const SHOP_STATE_MAX_LOG = 50;

/** Slug shape shared with the bridge/data API (lowercase, digits, dashes, 3–50). */
const SHOP_STATE_SLUG_RE = /^[a-z0-9-]{3,50}$/;

/** What kinds of changes the log records. */
export type ShopLogKind =
  | 'deploy'
  | 'ai'
  | 'feature'
  | 'appearance'
  | 'rollback'
  | 'note';

/** One rolled version — METADATA only; the HTML lives in a side-key by `id`. */
export interface ShopVersion {
  id: string;
  at: string;
  note: string;
  bytes: number;
}

/** One activity-log entry. */
export interface ShopLogEntry {
  at: string;
  kind: ShopLogKind;
  note: string;
}

/**
 * The persisted ShopState blob (PINNED shape, R2-CONTRACT §"ShopState").
 * `settingsRef` is always the literal 'live' in v1 — the live storefront reads
 * its appearance/feature settings from the data-API singleton at runtime, so
 * ShopState only points at it rather than duplicating it.
 */
export interface ShopState {
  v: typeof SHOP_STATE_VERSION;
  templateId: string | null;
  featureSet: string[];
  settingsRef: 'live';
  aiPatchHtml: string | null;
  versions: ShopVersion[];
  log: ShopLogEntry[];
}

/** A patch for writeShopState — every field OPTIONAL; only present keys apply. */
export interface ShopStatePatch {
  templateId?: string | null;
  featureSet?: string[];
  aiPatchHtml?: string | null;
  // versions/log are managed via recordVersion/appendLog, not patched directly,
  // but allowing them here keeps the writer general (callers rarely set them).
  versions?: ShopVersion[];
  log?: ShopLogEntry[];
}

// ---------------------------------------------------------------------------
// KEY BUILDERS — kept as pure functions so the exact key shape is auditable in
// one place and impossible to typo differently across reads/writes.
// ---------------------------------------------------------------------------

/** Primary key holding the JSON ShopState blob for `{userId}:{slug}`. */
export const shopStateKey = (userId: string, slug: string): string =>
  `clickdz:shopstate:${userId}:${slug}`;

/** Side-key holding ONE version's full HTML (kept out of the blob to stay small). */
export const shopVersionKey = (
  userId: string,
  slug: string,
  versionId: string
): string => `clickdz:shopstate:${userId}:${slug}:v:${versionId}`;

// ---------------------------------------------------------------------------
// INTERNAL HELPERS
// ---------------------------------------------------------------------------

/** Validate the owner+slug pair; a bad pair means "no state" rather than a throw. */
function validKeyParts(userId: string, slug: string): boolean {
  return (
    typeof userId === 'string' &&
    userId.length > 0 &&
    typeof slug === 'string' &&
    SHOP_STATE_SLUG_RE.test(slug)
  );
}

/** A brand-new, empty ShopState (used when nothing is persisted yet). */
function emptyShopState(): ShopState {
  return {
    v: SHOP_STATE_VERSION,
    templateId: null,
    featureSet: [],
    settingsRef: 'live',
    aiPatchHtml: null,
    versions: [],
    log: [],
  };
}

/**
 * Coerce an arbitrary parsed JSON value into a well-formed ShopState. Tolerant
 * by construction: any missing/wrong-typed field falls back to its empty
 * default, so a legacy or partially-written blob NEVER throws on read — it just
 * heals toward the current shape on the next write.
 */
function normalizeShopState(raw: unknown): ShopState {
  const base = emptyShopState();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;
  return {
    v: SHOP_STATE_VERSION,
    templateId: typeof o.templateId === 'string' ? o.templateId : null,
    featureSet: Array.isArray(o.featureSet)
      ? o.featureSet.filter((f): f is string => typeof f === 'string')
      : [],
    settingsRef: 'live',
    aiPatchHtml: typeof o.aiPatchHtml === 'string' ? o.aiPatchHtml : null,
    versions: Array.isArray(o.versions)
      ? o.versions
          .map(normalizeVersion)
          .filter((v): v is ShopVersion => v !== null)
      : [],
    log: Array.isArray(o.log)
      ? o.log.map(normalizeLog).filter((l): l is ShopLogEntry => l !== null)
      : [],
  };
}

/** Coerce one version entry; returns null (dropped) when it lacks a usable id. */
function normalizeVersion(raw: unknown): ShopVersion | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : '';
  if (!id) return null;
  return {
    id,
    at: typeof o.at === 'string' ? o.at : new Date().toISOString(),
    note: typeof o.note === 'string' ? o.note : '',
    bytes: typeof o.bytes === 'number' && o.bytes >= 0 ? o.bytes : 0,
  };
}

/** Coerce one log entry; returns null when it is unusable. */
function normalizeLog(raw: unknown): ShopLogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  const okKind =
    kind === 'deploy' ||
    kind === 'ai' ||
    kind === 'feature' ||
    kind === 'appearance' ||
    kind === 'rollback' ||
    kind === 'note';
  return {
    at: typeof o.at === 'string' ? o.at : new Date().toISOString(),
    kind: okKind ? (kind as ShopLogKind) : 'note',
    note: typeof o.note === 'string' ? o.note.slice(0, 400) : '',
  };
}

/**
 * Persist the blob and RE-ARM the 90d TTL atomically. Central so every mutating
 * export shares one write path (single source of the TTL discipline). Throws on
 * a Redis failure — callers that must never break a deploy wrap it in try/catch.
 */
async function persistShopState(
  cache: ShopStateCache,
  userId: string,
  slug: string,
  state: ShopState
): Promise<void> {
  await cache.set(
    shopStateKey(userId, slug),
    JSON.stringify(state),
    'EX',
    SHOP_STATE_TTL_SECONDS
  );
}

/** Mint a short, sortable, collision-resistant version id (ts + random tail). */
function mintVersionId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// PUBLIC API — the exact export names Plume codes against (KEEP NAMES EXACT).
// ---------------------------------------------------------------------------

/**
 * Read the ShopState for `{userId, slug}`. Returns a fully-formed (normalized)
 * ShopState even when nothing is persisted (an empty state) so callers never
 * branch on null. A corrupt/legacy blob is healed to the current shape on read.
 * Never throws on a store hiccup — degrades to the empty state.
 */
export async function readShopState(
  cache: ShopStateCache,
  userId: string,
  slug: string
): Promise<ShopState> {
  if (!validKeyParts(userId, slug)) return emptyShopState();
  let raw: string | null = null;
  try {
    raw = await cache.get(shopStateKey(userId, slug));
  } catch {
    return emptyShopState();
  }
  if (!raw) return emptyShopState();
  try {
    return normalizeShopState(JSON.parse(raw));
  } catch {
    // Unparseable member — treat as empty; the next write replaces it cleanly.
    return emptyShopState();
  }
}

/**
 * Merge a partial patch onto the current ShopState and persist it (re-arming
 * the 90d TTL). Only the keys PRESENT on `patch` change; everything else is
 * carried through. Returns the written state. `settingsRef` is always 'live'
 * (v1). Throws only if the store write itself fails.
 */
export async function writeShopState(
  cache: ShopStateCache,
  userId: string,
  slug: string,
  patch: ShopStatePatch
): Promise<ShopState> {
  const current = await readShopState(cache, userId, slug);
  const next: ShopState = {
    ...current,
    v: SHOP_STATE_VERSION,
    settingsRef: 'live',
    templateId:
      patch.templateId !== undefined ? patch.templateId : current.templateId,
    featureSet:
      patch.featureSet !== undefined
        ? patch.featureSet.filter(f => typeof f === 'string')
        : current.featureSet,
    aiPatchHtml:
      patch.aiPatchHtml !== undefined
        ? patch.aiPatchHtml
        : current.aiPatchHtml,
    versions:
      patch.versions !== undefined
        ? patch.versions.slice(0, SHOP_STATE_MAX_VERSIONS)
        : current.versions,
    log:
      patch.log !== undefined
        ? patch.log.slice(0, SHOP_STATE_MAX_LOG)
        : current.log,
  };
  await persistShopState(cache, userId, slug, next);
  return next;
}

/**
 * Record a new version of the shop's HTML: store the HTML in a side-key (with
 * its own 90d TTL), prepend a metadata entry to `versions`, and ROTATE so at
 * most SHOP_STATE_MAX_VERSIONS (=5) are kept — the HTML side-keys of any dropped
 * versions are deleted so storage is bounded. Also appends a matching log entry.
 * Returns the new ShopVersion metadata. Throws only on a store write failure.
 */
export async function recordVersion(
  cache: ShopStateCache,
  userId: string,
  slug: string,
  html: string,
  note: string
): Promise<ShopVersion> {
  const id = mintVersionId();
  const safeHtml = typeof html === 'string' ? html : '';
  const entry: ShopVersion = {
    id,
    at: new Date().toISOString(),
    note: typeof note === 'string' ? note.slice(0, 200) : '',
    bytes: safeHtml.length,
  };
  // Stash this version's HTML first (own rolling TTL) — if this fails we throw
  // before mutating the blob, so metadata never references missing HTML.
  await cache.set(
    shopVersionKey(userId, slug, id),
    safeHtml,
    'EX',
    SHOP_STATE_TTL_SECONDS
  );
  const current = await readShopState(cache, userId, slug);
  // Newest first, then rotate: keep the head N, drop the tail's side-keys.
  const combined = [entry, ...current.versions];
  const kept = combined.slice(0, SHOP_STATE_MAX_VERSIONS);
  const dropped = combined.slice(SHOP_STATE_MAX_VERSIONS);
  const next: ShopState = {
    ...current,
    versions: kept,
    log: [
      { at: entry.at, kind: 'deploy', note: entry.note || 'version recorded' },
      ...current.log,
    ].slice(0, SHOP_STATE_MAX_LOG),
  };
  await persistShopState(cache, userId, slug, next);
  // Free the HTML of rotated-out versions (best-effort; a failed del just leaves
  // an orphan side-key that expires on its own 90d TTL — never fatal).
  for (const old of dropped) {
    try {
      await cache.del(shopVersionKey(userId, slug, old.id));
    } catch {
      /* orphan self-expires on TTL */
    }
  }
  return entry;
}

/**
 * Fetch the full HTML of a previously-recorded version. Returns null when the
 * versionId is unknown, its HTML has expired/been rotated out, or on a store
 * hiccup. Validates the id against the blob's `versions` list first so a caller
 * can't read an arbitrary side-key by guessing.
 */
export async function getVersionHtml(
  cache: ShopStateCache,
  userId: string,
  slug: string,
  versionId: string
): Promise<string | null> {
  if (!validKeyParts(userId, slug)) return null;
  if (typeof versionId !== 'string' || !/^[a-z0-9]{1,32}$/.test(versionId)) {
    return null;
  }
  const state = await readShopState(cache, userId, slug);
  if (!state.versions.some(v => v.id === versionId)) return null;
  try {
    return await cache.get(shopVersionKey(userId, slug, versionId));
  } catch {
    return null;
  }
}

/**
 * Stage a pending AI-authored full-HTML patch on the ShopState (the "customization
 * delta" as a materialized single-file document). Sets `aiPatchHtml` and logs
 * an 'ai' entry. Returns the written state. Throws only on a store write failure.
 */
export async function setPendingAiPatch(
  cache: ShopStateCache,
  userId: string,
  slug: string,
  html: string
): Promise<ShopState> {
  const current = await readShopState(cache, userId, slug);
  const next: ShopState = {
    ...current,
    aiPatchHtml: typeof html === 'string' ? html : null,
    log: [
      {
        at: new Date().toISOString(),
        kind: 'ai',
        note: 'ai patch staged',
      },
      ...current.log,
    ].slice(0, SHOP_STATE_MAX_LOG),
  };
  await persistShopState(cache, userId, slug, next);
  return next;
}

/**
 * Clear any staged AI patch (sets `aiPatchHtml` back to null) and log the reset.
 * Idempotent — clearing an already-empty patch is a harmless re-write that also
 * re-arms the TTL. Returns the written state. Throws only on a store failure.
 */
export async function clearPendingAiPatch(
  cache: ShopStateCache,
  userId: string,
  slug: string
): Promise<ShopState> {
  const current = await readShopState(cache, userId, slug);
  const next: ShopState = {
    ...current,
    aiPatchHtml: null,
    log: [
      {
        at: new Date().toISOString(),
        kind: 'ai',
        note: 'ai patch cleared',
      },
      ...current.log,
    ].slice(0, SHOP_STATE_MAX_LOG),
  };
  await persistShopState(cache, userId, slug, next);
  return next;
}

/**
 * Append an activity-log entry (newest-first, capped at SHOP_STATE_MAX_LOG) and
 * persist (re-arming the TTL). Returns the written state. Throws only on a
 * store write failure. Used by the /state/note route and by internal hooks.
 */
export async function appendLog(
  cache: ShopStateCache,
  userId: string,
  slug: string,
  kind: ShopLogKind,
  note: string
): Promise<ShopState> {
  const current = await readShopState(cache, userId, slug);
  const entry: ShopLogEntry = {
    at: new Date().toISOString(),
    kind,
    note: typeof note === 'string' ? note.slice(0, 400) : '',
  };
  const next: ShopState = {
    ...current,
    log: [entry, ...current.log].slice(0, SHOP_STATE_MAX_LOG),
  };
  await persistShopState(cache, userId, slug, next);
  return next;
}

/**
 * Client-safe projection of a ShopState for the GET /state route: it MUST NEVER
 * expose raw HTML (neither `aiPatchHtml` nor any version body), only metadata.
 * Version HTML is fetched separately via the /state/versions/:id route (which
 * uses getVersionHtml). This keeps the state endpoint cheap + leak-free.
 */
export function publicShopState(state: ShopState): {
  v: number;
  templateId: string | null;
  featureSet: string[];
  settingsRef: 'live';
  hasAiPatch: boolean;
  versions: ShopVersion[];
  log: ShopLogEntry[];
} {
  return {
    v: state.v,
    templateId: state.templateId,
    featureSet: state.featureSet,
    settingsRef: state.settingsRef,
    hasAiPatch: state.aiPatchHtml != null && state.aiPatchHtml.length > 0,
    versions: state.versions,
    log: state.log,
  };
}
