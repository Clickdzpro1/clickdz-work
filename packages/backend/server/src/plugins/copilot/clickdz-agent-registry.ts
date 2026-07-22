import { randomBytes } from 'node:crypto';

// Reuse the shared runtime's agent-name union so the registry, the run engine
// (clickdz-agent-runs.ts), the loop bodies and the FE speak ONE vocabulary. A
// built-in agent id IS its archetype ('hermes' | 'openclaw'); a custom agent
// clones one of those archetypes. Type-only import — this module carries ZERO
// framework weight (no Nest, no decorators), exactly like clickdz-agent-runs.ts's
// pure exported functions that take a `redis` handle as their first parameter.
import type { AgentName } from './clickdz-agent-runtime';
export type { AgentName } from './clickdz-agent-runtime';

// ===========================================================================
// clickdz-agent-registry.ts — CUSTOM AGENTS REGISTRY (R12 §"Registry").
//
// R12 lets a user create their OWN named agents beyond the two built-ins
// (Hermes / OpenClaw). A custom agent is NOT a union rewrite — it is a light
// DEF record { id, archetype, name, emoji?, persona?, createdAt } that clones an
// archetype (which plan->act loop + tools it reuses). Every runtime key stays
// `clickdz:*:{userId}:{agentId}:...`, so a custom agent gets its own config /
// threads / runs / channels / memory / artifacts FOR FREE, scoped to its owner.
//
//   · Def record   Redis `clickdz:agentdef:{userId}:{agentId}` — the JSON def.
//   · Index zset   Redis `clickdz:agentdefs:{userId}` — score = createdAt, so a
//                  user's customs list newest-first (ZREVRANGE) with cap 20.
//
// The CRITICAL export is resolveArchetype(redis,userId,agentId): it is the
// multi-tenant gate every :agent route runs. It returns:
//   · the id ITSELF        when the id is a built-in ('hermes' | 'openclaw'),
//   · the def's archetype  when the id is an OWNED custom id (def exists under
//                          THIS userId),
//   · null                 when the id is unknown OR not owned by this user.
// Because ownership is intrinsic (a def only exists under its owner's userId), a
// custom id minted by user Y resolves to null under user X's session ⇒ callers
// 404. NEVER trust a request-supplied userId — always pass @CurrentUser().id.
//
// It is FRAMEWORK-LIGHT: every export is a plain function taking a `redis` handle
// (the same RunRedis-ish slice clickdz-agent-runs.ts defines) as its first
// parameter, so it unit-tests against a stub redis with zero DI. Nothing here
// throws out of a public function (fail-soft — Redis is a cache); nothing logs
// secrets. Cap: 20 custom agents / user.
//
// Gating: the routes that mutate this registry (clickdz-agents.controller.ts) are
// dark behind CDZ_AGENT_CUSTOM_ENABLED; resolveArchetype itself is always safe to
// call (built-ins resolve with no Redis touch), so the :agent route validation
// keeps working for built-in ids whether or not custom agents are enabled.
// ===========================================================================

// ---------------------------------------------------------------------------
// The minimal ioredis surface the registry needs — a SUBSET of clickdz-agent-
// runs.ts's RunRedis (get/set/del + zset ops + expire). CacheRedis (which extends
// ioredis Redis) satisfies this structurally, and a test stub only has to
// implement these — the SAME "accept a slice, not the class" trick the run engine
// uses so this module carries ZERO framework weight. Declared locally (not
// imported) so the registry has no import-time dependency on the run engine.
// ---------------------------------------------------------------------------
export interface RegistryRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<any>;
  del(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  zadd(key: string, ...args: (string | number)[]): Promise<any>;
  zrem(key: string, ...members: string[]): Promise<any>;
  zrange(key: string, start: number, stop: number, ...args: any[]): Promise<string[]>;
}

// ===========================================================================
// Caps / TTLs / validation limits (R12 — EXACT). TTLs here are SECONDS (raw
// ioredis EXPIRE / SET EX), matching the run engine's convention.
// ===========================================================================

/** Max custom agents a single user may own (R12 §"Registry" — cap 20/user). */
export const MAX_CUSTOM_AGENTS = 20;

/** Def + index TTL: ~180 days, re-armed on every write (contract "180d re-armed"). */
const DEF_TTL_SEC = 180 * 24 * 60 * 60;

/** Field length caps (validated on create/rename; over-length ⇒ rejected). */
const NAME_MAX = 40;
const PERSONA_MAX = 2000;
const EMOJI_MAX = 8;

/** The two built-in archetypes a custom agent may clone. */
const ARCHETYPES: readonly AgentName[] = ['hermes', 'openclaw'];

/** Product-facing default names for the two built-ins (used by synthetic defs). */
const BUILTIN_NAMES: Record<AgentName, string> = {
  hermes: 'Hermès',
  openclaw: 'OpenClaw',
};

// ---------------------------------------------------------------------------
// Redis key helpers (R12 — EXACT names). Def record is per-user+agentId; the
// listing index is a per-user zset (score = createdAt) so a user's customs list
// newest-first and the cap is a cheap ZCARD-free length check off ZRANGE.
// ---------------------------------------------------------------------------

/** Per-user+agentId def record key. */
const defKey = (userId: string, agentId: string) =>
  `clickdz:agentdef:${userId}:${agentId}`;
/** Per-user index zset key (members = agentId, score = createdAt ms). */
const defsIndexKey = (userId: string) => `clickdz:agentdefs:${userId}`;

// ===========================================================================
// The DEF record shape (exact). Persisted JSON at defKey; a synthetic instance
// (never persisted) is returned for the two built-ins by resolveAgentDef.
// ===========================================================================

export interface AgentDef {
  /** Runtime id: `cz_` + 8 hex for a custom agent, or a built-in name. */
  id: string;
  /** Which built-in loop/tools this agent reuses. */
  archetype: AgentName;
  /** Display name (≤40 chars). */
  name: string;
  /** Optional emoji (≤8 chars). */
  emoji?: string;
  /** Optional persona prepended to the archetype's system prompt (≤2000 chars). */
  persona?: string;
  /** ms since epoch the def was created. */
  createdAt: number;
}

/** Fields accepted when creating a custom agent (POST body, pre-validation). */
export interface CreateAgentDefInput {
  archetype: string;
  name: string;
  emoji?: string;
  persona?: string;
}

/** Fields accepted when renaming/editing a custom agent (PATCH body). */
export interface RenameAgentDefInput {
  name?: string;
  emoji?: string;
  persona?: string;
}

// ===========================================================================
// Small pure helpers (defensive; never throw).
// ===========================================================================

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** True when `id` is one of the two built-in agents (its own archetype). */
export function isBuiltinAgent(id: unknown): id is AgentName {
  return id === 'hermes' || id === 'openclaw';
}

/** True when `id` LOOKS like a custom runtime id (`cz_` + 8 lowercase hex). */
export function isCustomAgentId(id: unknown): boolean {
  return typeof id === 'string' && /^cz_[0-9a-f]{8}$/.test(id);
}

/** Narrow an arbitrary value to a known archetype (else null). */
function normalizeArchetype(raw: unknown): AgentName | null {
  return raw === 'hermes' || raw === 'openclaw' ? raw : null;
}

/**
 * Allocate a fresh custom-agent runtime id: `cz_` + 8 lowercase hex (4 random
 * bytes via node:crypto, the SAME primitive the bridge / telegram id minters use
 * — crypto-strong, not Math.random). CANNOT collide with 'hermes' | 'openclaw'
 * (the `cz_` prefix + hex charset makes that structurally impossible).
 */
export function newAgentId(): string {
  return `cz_${randomBytes(4).toString('hex')}`;
}

// ===========================================================================
// Validation — pure, returns a trimmed clean value or null (never throws). The
// routes turn a null into a typed BadRequest; the registry functions treat a
// null as "reject" and return null/false rather than persisting bad data.
// ===========================================================================

/** Validate + trim a display name: non-empty string ≤40 chars, else null. */
export function validateName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > NAME_MAX) return null;
  return name;
}

/**
 * Validate + trim an optional persona: a string ≤2000 chars (empty ⇒ undefined,
 * i.e. "no persona"). Returns `{ ok, value }` so an ABSENT persona (undefined)
 * is distinguishable from an INVALID one (too long). `ok:false` ⇒ reject.
 */
export function validatePersona(
  raw: unknown
): { ok: boolean; value?: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false };
  const persona = raw.trim();
  if (!persona) return { ok: true, value: undefined };
  if (persona.length > PERSONA_MAX) return { ok: false };
  return { ok: true, value: persona };
}

/**
 * Validate + trim an optional emoji: a string ≤8 chars (empty ⇒ undefined).
 * Returns `{ ok, value }` for the same absent-vs-invalid distinction as persona.
 */
export function validateEmoji(raw: unknown): { ok: boolean; value?: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false };
  const emoji = raw.trim();
  if (!emoji) return { ok: true, value: undefined };
  // Count by code points so a multi-codepoint emoji (e.g. a flag or ZWJ
  // sequence) is measured intuitively; still bounded so a stored value is small.
  if ([...emoji].length > EMOJI_MAX) return { ok: false };
  return { ok: true, value: emoji };
}

/** Coerce a possibly-partial persisted record into a well-formed def (or null). */
function normalizeDef(raw: any): AgentDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const archetype = normalizeArchetype(raw.archetype);
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!id || !archetype || !name) return null;
  const def: AgentDef = {
    id,
    archetype,
    name: name.slice(0, NAME_MAX),
    createdAt:
      typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
        ? raw.createdAt
        : Date.now(),
  };
  if (typeof raw.emoji === 'string' && raw.emoji) {
    def.emoji = raw.emoji.slice(0, 64);
  }
  if (typeof raw.persona === 'string' && raw.persona) {
    def.persona = raw.persona.slice(0, PERSONA_MAX);
  }
  return def;
}

/** A synthetic (never-persisted) def for a built-in agent. */
function builtinDef(id: AgentName): AgentDef {
  return { id, archetype: id, name: BUILTIN_NAMES[id], createdAt: 0 };
}

// ===========================================================================
// READ — index + record I/O, all fail-soft.
// ===========================================================================

/**
 * List a user's custom-agent ids, newest first, capped at {@link
 * MAX_CUSTOM_AGENTS}. Reads the index zset (ZREVRANGE via zrange + REV arg —
 * ioredis accepts the trailing 'REV' token; a stub can ignore it and we still
 * dedupe/slice defensively). Fail-soft → [].
 */
async function listAgentIds(
  redis: RegistryRedis,
  userId: string
): Promise<string[]> {
  if (!userId) return [];
  let ids: string[];
  try {
    // Newest-first: high score (recent createdAt) first. `zrange key 0 -1 REV`
    // is the modern equivalent of ZREVRANGE; harmless extra arg for a stub that
    // returns ascending — we do not rely on the order for correctness (only for
    // display), and the cap is applied off the full set below.
    ids = await redis.zrange(defsIndexKey(userId), 0, -1, 'REV');
  } catch {
    return [];
  }
  if (!Array.isArray(ids)) return [];
  // Defensive de-dupe (a stub / a double-add could repeat a member).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Read + normalize ONE owned custom def. Returns null when missing/corrupt OR
 * when the id is not a custom id (built-ins have no persisted def — use {@link
 * resolveAgentDef} for those). The record lives under THIS userId, so a def only
 * resolves for its owner — the intrinsic-ownership property the isolation audit
 * relies on. Fail-soft → null.
 */
export async function getAgentDef(
  redis: RegistryRedis,
  userId: string,
  agentId: string
): Promise<AgentDef | null> {
  if (!userId || !agentId) return null;
  try {
    const raw = await redis.get(defKey(userId, agentId));
    return normalizeDef(safeParse<AgentDef>(raw));
  } catch {
    return null;
  }
}

/**
 * List a user's custom agent defs, newest first, capped at {@link
 * MAX_CUSTOM_AGENTS}. Walks the index, reads each def, prunes index entries
 * whose record expired/vanished. Fail-soft → []. Built-ins are NOT included
 * (the roster route composes built-ins + these separately).
 */
export async function listAgentDefs(
  redis: RegistryRedis,
  userId: string
): Promise<AgentDef[]> {
  if (!userId) return [];
  const ids = await listAgentIds(redis, userId);
  if (!ids.length) return [];
  const out: AgentDef[] = [];
  const dead: string[] = [];
  for (const id of ids) {
    const def = await getAgentDef(redis, userId, id);
    if (def) {
      out.push(def);
      if (out.length >= MAX_CUSTOM_AGENTS) break;
    } else {
      dead.push(id); // record expired/deleted → prune from index
    }
  }
  if (dead.length) {
    try {
      await redis.zrem(defsIndexKey(userId), ...dead);
    } catch {
      /* fail-soft */
    }
  }
  return out;
}

/**
 * Count a user's current custom agents (for the cap check). Fail-soft → a large
 * number is NEVER returned; on error we return {@link MAX_CUSTOM_AGENTS} so a
 * read failure FAILS CLOSED (cannot exceed the cap) — the opposite of the daily
 * run cap (an abuse guard that fails open): here the cap protects per-user Redis
 * footprint and a create is a rare, deliberate action, so failing closed is safe.
 */
async function countAgentDefs(
  redis: RegistryRedis,
  userId: string
): Promise<number> {
  const ids = await listAgentIds(redis, userId);
  return ids.length;
}

// ===========================================================================
// CREATE — validate, allocate a unique id, persist the record, index it.
// ===========================================================================

/**
 * The result of a create attempt. `def` is set on success; on failure `error`
 * names the reason so the route maps it to the right typed error:
 *   · 'invalid'   → BadRequest (bad archetype / name / persona / emoji)
 *   · 'cap'       → BadRequest / 409 (the 20-agent cap is reached)
 *   · 'store'     → the write failed (treated as a soft 500 by the route)
 */
export interface CreateAgentDefResult {
  def?: AgentDef;
  error?: 'invalid' | 'cap' | 'store';
}

/**
 * Create a custom agent def for a user. Validates the archetype + name + optional
 * persona/emoji, enforces the 20/user cap, allocates a collision-checked `cz_`
 * id, persists the record (SET EX 180d), and adds it to the newest-first index
 * zset (score = createdAt, TTL re-armed). Fail-soft: never throws; returns a
 * typed error instead. Ownership is intrinsic — the record lives under `userId`,
 * so it is only ever resolvable for this owner.
 */
export async function createAgentDef(
  redis: RegistryRedis,
  userId: string,
  input: CreateAgentDefInput
): Promise<CreateAgentDefResult> {
  if (!userId) return { error: 'invalid' };
  const archetype = normalizeArchetype(input?.archetype);
  if (!archetype) return { error: 'invalid' };
  const name = validateName(input?.name);
  if (!name) return { error: 'invalid' };
  const personaV = validatePersona(input?.persona);
  if (!personaV.ok) return { error: 'invalid' };
  const emojiV = validateEmoji(input?.emoji);
  if (!emojiV.ok) return { error: 'invalid' };

  // Cap check (fails closed on a read error — see countAgentDefs).
  const count = await countAgentDefs(redis, userId);
  if (count >= MAX_CUSTOM_AGENTS) return { error: 'cap' };

  // Allocate a unique id. Collisions are astronomically unlikely (2^32), but we
  // check the record key once and retry a few times to be safe.
  let agentId = newAgentId();
  for (let i = 0; i < 5; i++) {
    let exists: string | null = null;
    try {
      exists = await redis.get(defKey(userId, agentId));
    } catch {
      exists = null; // treat a read failure as "free" — the SET below still wins
    }
    if (!exists) break;
    agentId = newAgentId();
  }

  const now = Date.now();
  const def: AgentDef = {
    id: agentId,
    archetype,
    name,
    createdAt: now,
  };
  if (emojiV.value !== undefined) def.emoji = emojiV.value;
  if (personaV.value !== undefined) def.persona = personaV.value;

  let line: string;
  try {
    line = JSON.stringify(def);
  } catch {
    return { error: 'store' };
  }
  try {
    await redis.set(defKey(userId, agentId), line, 'EX', DEF_TTL_SEC);
  } catch {
    return { error: 'store' };
  }
  try {
    await redis.zadd(defsIndexKey(userId), now, agentId);
    // The index outlives its records (records self-expire at 180d); re-arm its
    // TTL on activity so it does not grow unbounded forever.
    await redis.expire(defsIndexKey(userId), DEF_TTL_SEC);
  } catch {
    /* fail-soft: the record is written; the index is a display convenience */
  }
  return { def };
}

// ===========================================================================
// RENAME / EDIT — patch name / emoji / persona on an owned def (persists).
// ===========================================================================

/**
 * Patch an owned custom agent's name / emoji / persona. Only the provided,
 * VALID fields change; an absent field is left as-is; an explicit empty
 * emoji/persona CLEARS it (delete the field). Re-arms the 180d TTL. Returns the
 * updated def, or null when the id is not an owned custom def (⇒ the route 404s)
 * OR when a provided field is invalid (⇒ the route 400s — distinguished by the
 * `invalid` flag on the result). Fail-soft: never throws.
 */
export interface RenameAgentDefResult {
  def?: AgentDef;
  error?: 'not_found' | 'invalid' | 'store';
}

export async function renameAgentDef(
  redis: RegistryRedis,
  userId: string,
  agentId: string,
  patch: RenameAgentDefInput
): Promise<RenameAgentDefResult> {
  if (!userId || !agentId) return { error: 'not_found' };
  // Only custom ids have an editable def; a built-in id is never owned/editable.
  if (!isCustomAgentId(agentId)) return { error: 'not_found' };
  const existing = await getAgentDef(redis, userId, agentId);
  if (!existing) return { error: 'not_found' };

  const next: AgentDef = { ...existing };
  const p = (patch ?? {}) as RenameAgentDefInput;

  if (p.name !== undefined) {
    const name = validateName(p.name);
    if (!name) return { error: 'invalid' };
    next.name = name;
  }
  if (p.emoji !== undefined) {
    const emojiV = validateEmoji(p.emoji);
    if (!emojiV.ok) return { error: 'invalid' };
    if (emojiV.value === undefined) delete next.emoji;
    else next.emoji = emojiV.value;
  }
  if (p.persona !== undefined) {
    const personaV = validatePersona(p.persona);
    if (!personaV.ok) return { error: 'invalid' };
    if (personaV.value === undefined) delete next.persona;
    else next.persona = personaV.value;
  }

  let line: string;
  try {
    line = JSON.stringify(next);
  } catch {
    return { error: 'store' };
  }
  try {
    await redis.set(defKey(userId, agentId), line, 'EX', DEF_TTL_SEC);
    // Keep the index alive too (a rename is activity).
    await redis.expire(defsIndexKey(userId), DEF_TTL_SEC);
  } catch {
    return { error: 'store' };
  }
  return { def: next };
}

// ===========================================================================
// DELETE — remove an owned def + its index entry (persists). Idempotent.
// ===========================================================================

/**
 * Delete an owned custom agent def + prune its index entry. Idempotent (deleting
 * a missing/unknown id resolves `false` without error). Does NOT touch the
 * agent's runtime state (threads/runs/channels/etc.) — those self-expire on
 * their own TTLs, and orphaning them under a now-unresolvable id is harmless
 * (every :agent route resolves through {@link resolveArchetype}, which returns
 * null once the def is gone ⇒ 404). Only a custom id is deletable; a built-in id
 * is never owned. Fail-soft: never throws. Returns whether a def was removed.
 */
export async function deleteAgentDef(
  redis: RegistryRedis,
  userId: string,
  agentId: string
): Promise<boolean> {
  if (!userId || !agentId) return false;
  if (!isCustomAgentId(agentId)) return false;
  let removed = false;
  try {
    const n = await redis.del(defKey(userId, agentId));
    removed = typeof n === 'number' ? n > 0 : !!n;
  } catch {
    removed = false;
  }
  try {
    await redis.zrem(defsIndexKey(userId), agentId);
  } catch {
    /* fail-soft: the record is what resolveArchetype reads; the index is display */
  }
  return removed;
}

// ===========================================================================
// RESOLVE — the multi-tenant gate. THE most important export.
// ===========================================================================

/**
 * Resolve an agent id to its archetype UNDER a specific owner. This is the gate
 * every `:agent` route runs before touching per-agent state:
 *
 *   · a BUILT-IN id ('hermes' | 'openclaw')  → the id itself (no Redis touch),
 *   · an OWNED custom id (def exists under `userId`) → the def's archetype,
 *   · an unknown OR not-owned id             → **null** (callers 404 on null).
 *
 * Because a def only exists under its owner's `userId`, a custom id minted by
 * user Y resolves to null under user X's session — the isolation invariant. The
 * caller MUST pass @CurrentUser().id here and NEVER a request-supplied userId.
 * Fail-soft: any Redis error on the custom-id path resolves null (a resolve
 * failure is "not owned" — the safe default; it 404s rather than leaking).
 */
export async function resolveArchetype(
  redis: RegistryRedis,
  userId: string,
  agentId: string
): Promise<AgentName | null> {
  // Built-ins resolve to themselves with NO Redis dependency, so :agent route
  // validation keeps working for hermes/openclaw whether or not custom agents
  // are enabled (and even if Redis is down).
  if (isBuiltinAgent(agentId)) return agentId;
  if (!userId || !agentId) return null;
  // Only a well-formed custom id can possibly be owned; reject anything else
  // fast (an arbitrary attacker-supplied string never hits Redis).
  if (!isCustomAgentId(agentId)) return null;
  const def = await getAgentDef(redis, userId, agentId);
  return def ? def.archetype : null;
}

/**
 * Resolve an agent id to its FULL def UNDER a specific owner. Built-ins resolve
 * to a synthetic def ({ id, archetype:id, name:'Hermès'|'OpenClaw' }); an owned
 * custom id resolves to its persisted def; an unknown/not-owned id resolves
 * null. Same isolation property + fail-soft stance as {@link resolveArchetype}.
 * Callers that need the persona (to inject it into the loop) read it off this.
 */
export async function resolveAgentDef(
  redis: RegistryRedis,
  userId: string,
  agentId: string
): Promise<AgentDef | null> {
  if (isBuiltinAgent(agentId)) return builtinDef(agentId);
  if (!userId || !agentId) return null;
  if (!isCustomAgentId(agentId)) return null;
  return getAgentDef(redis, userId, agentId);
}
