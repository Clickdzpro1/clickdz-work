// ---------------------------------------------------------------------------
// clickdz-agent-memory.ts — PER-AGENT LONG-TERM MEMORY (R8 / WSA-10, owner:
// Souvenir).
//
// A tiny, durable "memory of the agent" keyed per (user, agent). It lets a
// Hermes/OpenClaw agent (a) carry a handful of user-stated FACTS + PREFERENCES
// across runs, and (b) accumulate one-line SUMMARIES of past runs — so the next
// run's planner prompt can be primed with "what we already know". Nothing here
// is a source of truth: it is a best-effort recall cache on Redis, and EVERY
// path is fail-soft — a memory hiccup (Redis down, bad JSON, cdz-flash timeout)
// must NEVER break or slow an agent run.
//
// Framework-light by design (mirrors clickdz-shop-state.ts + the RunRedis seam
// in clickdz-agent-runs.ts): every persistence export takes a raw-ioredis-shaped
// `redis` slice as its FIRST parameter instead of importing CacheRedis, so this
// module carries ZERO Nest weight and unit-tests against a stub with no DI. The
// summarizer's `deps` carry the run-engine handle + redis it needs (documented
// as MEMORY-DEPS in NOTES.md for Relance, who wires it from the hermes ctor).
//
// Storage layout (per owner+agent):
//   clickdz:agentmem:{userId}:{agent}  → the JSON AgentMemory blob (v1)
// A single 90-day rolling TTL that every write RE-ARMS (same window the run
// engine + shop/data layers use): an actively-used agent's memory never expires
// out from under it, an abandoned one self-cleans on the same 90d clock.
//
// Gating: EVERYTHING is behind `memoryEnabled()` = CDZ_AGENT_MEMORY_ENABLED==='1'.
// Off/absent ⇒ readAgentMemory/writeAgentMemory/appendFact/setPref/append-
// RunSummary all no-op (empty memory, no writes), buildMemoryPromptBlock returns
// '', createMemoryTools returns [] (no tools registered), and
// registerMemorySummarizer installs a callback that early-returns ⇒ byte-
// identical current behaviour.
// ---------------------------------------------------------------------------

// WS17: memory keys now accept the raw agent id (string) so custom agents get
// their own namespace. The builtin ids ('hermes' | 'openclaw') still pass
// through; the strict AgentName union is no longer imported here.
// The run-done completion hook + record shape live in the run engine. We import
// `onAgentRunDone` (registered fail-soft, exactly like Telegramme's run-done
// push) and the record type so the summarizer reads only the pinned fields.
import { onAgentRunDone } from './clickdz-agent-runs';
import type { AgentRunRecord } from './clickdz-agent-runs';
// Regis's pinned tool shapes. Type-only imports are ERASED by the transpile-only
// build, so this never adds a runtime edge (no boot risk even mid-parallel-
// build) yet the returned defs are exactly Regis's AgentToolDef — honouring the
// R8 contract's "registry shapes from clickdz-agent-tools.ts".
import type { AgentToolCtx, AgentToolDef } from './clickdz-agent-tools';

// ===========================================================================
// Gate.
// ===========================================================================

/** Master gate. OFF/absent ⇒ every memory path is inert (byte-identical). */
export function memoryEnabled(): boolean {
  return process.env.CDZ_AGENT_MEMORY_ENABLED === '1';
}

// ===========================================================================
// Shape + caps (R8-CONTRACT §Memory — EXACT).
// ===========================================================================

/** Current on-disk schema version of the memory blob. */
export const AGENT_MEMORY_VERSION = 1 as const;

/** 90-day rolling TTL (SECONDS — raw ioredis EX form, re-armed on every write). */
export const AGENT_MEMORY_TTL_SECONDS = 90 * 24 * 60 * 60;

// Hard caps (pinned). facts: newest-40, each text ≤280ch. prefs: ≤20 keys.
// summaries: newest-10 (FIFO), each text ≤400ch.
export const MEM_FACTS_CAP = 40;
export const MEM_FACT_TEXT_CAP = 280;
export const MEM_PREFS_CAP = 20;
export const MEM_PREF_KEY_CAP = 64;
export const MEM_PREF_VAL_CAP = 280;
export const MEM_SUMMARIES_CAP = 10;
export const MEM_SUMMARY_TEXT_CAP = 400;

/** One remembered fact — a short user-stated statement, timestamped. */
export interface MemoryFact {
  t: number;
  text: string;
}

/** One remembered run summary — a cdz-flash one-liner tied to its runId. */
export interface MemorySummary {
  t: number;
  runId: string;
  text: string;
}

/**
 * The persisted memory blob (PINNED shape). Tolerant on read: any missing /
 * wrong-typed field heals toward these defaults, so a legacy or partial blob
 * never throws — it just normalizes on the next write.
 */
export interface AgentMemory {
  v: typeof AGENT_MEMORY_VERSION;
  facts: MemoryFact[];
  prefs: Record<string, string>;
  summaries: MemorySummary[];
}

// ===========================================================================
// Key builder — pure, single source of the key shape (impossible to typo
// differently across reads/writes). Agent is validated to the known union so a
// stray value can't write to a rogue key.
// ===========================================================================

/** Primary key holding the JSON AgentMemory blob for `{userId}:{agent}`. */
// WS17: accept the raw agent id (string) so a custom agent (e.g. cz_abc123)
// gets its OWN memory namespace instead of being collapsed into 'hermes'.
// The builtin ids ('hermes' | 'openclaw') pass through unchanged; a custom id
// is used verbatim (it's already a safe kebab-ish slug from createCustomAgent).
export const agentMemoryKey = (userId: string, agent: string): string =>
  `clickdz:agentmem:${userId}:${normalizeAgent(agent)}`;

/**
 * WS17: pass through any non-builtin agent id verbatim instead of coercing it
 * to 'hermes' (which caused cross-agent memory bleed — a custom agent's run
 * summary overwrote the user's Hermes memory). Returns 'hermes' only for
 * empty/garbage input (fail-safe to the default agent), not for valid custom ids.
 */
function normalizeAgent(agent: unknown): string {
  if (typeof agent !== 'string') return 'hermes';
  const a = agent.trim();
  if (!a) return 'hermes';
  return a;
}

// ===========================================================================
// The minimal ioredis surface memory needs — the SAME "accept a slice, not the
// class" trick clickdz-shop-state.ts / clickdz-agent-runs.ts use so this module
// is framework-light and stub-testable. CacheRedis (extends ioredis) satisfies
// it structurally; a test stub only implements these three.
// ===========================================================================

export interface MemoryRedis {
  get(key: string): Promise<string | null>;
  // Accept the `('EX', seconds)` TTL form the run engine / bridge use.
  set(key: string, value: string, ...args: any[]): Promise<any>;
  expire(key: string, seconds: number): Promise<any>;
}

// ===========================================================================
// Small pure helpers.
// ===========================================================================

function validUser(userId: unknown): userId is string {
  return typeof userId === 'string' && userId.length > 0;
}

function clip(s: unknown, cap: number): string {
  const str = typeof s === 'string' ? s : String(s ?? '');
  return str.length > cap ? str.slice(0, cap) : str;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** A brand-new, empty memory blob (used when nothing is persisted yet). */
function emptyMemory(): AgentMemory {
  return { v: AGENT_MEMORY_VERSION, facts: [], prefs: {}, summaries: [] };
}

/** Coerce one fact entry; drops entries with no usable text. */
function normalizeFact(raw: unknown): MemoryFact | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const text = clip(o.text, MEM_FACT_TEXT_CAP).trim();
  if (!text) return null;
  return { t: typeof o.t === 'number' ? o.t : Date.now(), text };
}

/** Coerce one summary entry; drops entries with no usable text. */
function normalizeSummary(raw: unknown): MemorySummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const text = clip(o.text, MEM_SUMMARY_TEXT_CAP).trim();
  if (!text) return null;
  return {
    t: typeof o.t === 'number' ? o.t : Date.now(),
    runId: typeof o.runId === 'string' ? o.runId : '',
    text,
  };
}

/** Coerce prefs into a capped Record<string,string> (both key + value clipped). */
function normalizePrefs(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MEM_PREFS_CAP) break;
    const key = clip(k, MEM_PREF_KEY_CAP).trim();
    if (!key) continue;
    out[key] = clip(v, MEM_PREF_VAL_CAP);
    n += 1;
  }
  return out;
}

/**
 * Coerce an arbitrary parsed value into a well-formed, CAP-ENFORCED AgentMemory.
 * facts + summaries keep the NEWEST N (assumes append-order oldest→newest, so a
 * slice(-N) keeps the freshest); prefs keep the first ≤20 keys.
 */
function normalizeMemory(raw: unknown): AgentMemory {
  const base = emptyMemory();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;
  const facts = Array.isArray(o.facts)
    ? o.facts
        .map(normalizeFact)
        .filter((f): f is MemoryFact => f !== null)
        .slice(-MEM_FACTS_CAP)
    : [];
  const summaries = Array.isArray(o.summaries)
    ? o.summaries
        .map(normalizeSummary)
        .filter((s): s is MemorySummary => s !== null)
        .slice(-MEM_SUMMARIES_CAP)
    : [];
  return {
    v: AGENT_MEMORY_VERSION,
    facts,
    prefs: normalizePrefs(o.prefs),
    summaries,
  };
}

// ===========================================================================
// PERSISTENCE — read/write, all fail-soft. Writes RE-ARM the 90d TTL.
// ===========================================================================

/**
 * Read the memory for `{userId, agent}`. Returns a fully-formed (normalized)
 * AgentMemory even when nothing is persisted (an empty blob) so callers never
 * branch on null. A corrupt/legacy blob is healed to the current shape on read.
 * Returns the empty blob when memory is OFF or on any store hiccup — never
 * throws.
 */
export async function readAgentMemory(
  redis: MemoryRedis,
  userId: string,
  agent: string
): Promise<AgentMemory> {
  if (!memoryEnabled() || !validUser(userId)) return emptyMemory();
  let raw: string | null = null;
  try {
    raw = await redis.get(agentMemoryKey(userId, agent));
  } catch {
    return emptyMemory();
  }
  if (!raw) return emptyMemory();
  return normalizeMemory(safeParse<AgentMemory>(raw));
}

/**
 * Persist `mem` (normalized + capped first) and RE-ARM the 90d TTL. No-op when
 * memory is OFF. Fail-soft: a store write failure is swallowed (memory is a
 * cache, never source of truth) — it NEVER throws, so a caller in a hot run
 * path can `void writeAgentMemory(...)` safely. Returns the normalized blob
 * that was written (or would have been), so callers can reuse it.
 */
export async function writeAgentMemory(
  redis: MemoryRedis,
  userId: string,
  agent: string,
  mem: AgentMemory
): Promise<AgentMemory> {
  const next = normalizeMemory(mem);
  if (!memoryEnabled() || !validUser(userId)) return next;
  try {
    await redis.set(
      agentMemoryKey(userId, agent),
      JSON.stringify(next),
      'EX',
      AGENT_MEMORY_TTL_SECONDS
    );
  } catch {
    /* fail-soft: Redis is a cache, not source of truth */
  }
  return next;
}

// ===========================================================================
// MUTATORS — read-modify-write helpers. Each returns the written memory. All
// fail-soft + no-op when OFF.
// ===========================================================================

/**
 * Append a fact (newest-last, deduped against an identical trailing text) and
 * rotate to the newest MEM_FACTS_CAP. Empty/blank text is ignored (returns the
 * current memory unchanged). Never throws.
 */
export async function appendFact(
  redis: MemoryRedis,
  userId: string,
  agent: string,
  text: string
): Promise<AgentMemory> {
  const current = await readAgentMemory(redis, userId, agent);
  if (!memoryEnabled()) return current;
  const clean = clip(text, MEM_FACT_TEXT_CAP).trim();
  if (!clean) return current;
  // Skip a no-op duplicate of the most recent fact (agents re-state facts a lot).
  const last = current.facts[current.facts.length - 1];
  if (last && last.text === clean) return current;
  const facts = [...current.facts, { t: Date.now(), text: clean }].slice(
    -MEM_FACTS_CAP
  );
  return writeAgentMemory(redis, userId, agent, { ...current, facts });
}

/**
 * Set (or overwrite) a preference key. Enforces the 20-key cap: an existing key
 * is always updated; a NEW key is dropped once the cap is reached (rather than
 * evicting an existing pref — prefs are user-set + stable, so we prefer keeping
 * what's there over silently rotating). Blank key ⇒ no-op. Never throws.
 */
export async function setPref(
  redis: MemoryRedis,
  userId: string,
  agent: string,
  key: string,
  value: string
): Promise<AgentMemory> {
  const current = await readAgentMemory(redis, userId, agent);
  if (!memoryEnabled()) return current;
  const k = clip(key, MEM_PREF_KEY_CAP).trim();
  if (!k) return current;
  const isNew = !(k in current.prefs);
  if (isNew && Object.keys(current.prefs).length >= MEM_PREFS_CAP) {
    // At cap and this is a new key — refuse silently (keep existing prefs).
    return current;
  }
  const prefs = { ...current.prefs, [k]: clip(value, MEM_PREF_VAL_CAP) };
  return writeAgentMemory(redis, userId, agent, { ...current, prefs });
}

/**
 * Append a run summary (FIFO, newest-last) and rotate to the newest
 * MEM_SUMMARIES_CAP (=10). Blank text ⇒ no-op. Skips a duplicate runId (a run
 * finishing twice / double-delivery must not double-append). Never throws.
 */
export async function appendRunSummary(
  redis: MemoryRedis,
  userId: string,
  agent: string,
  runId: string,
  text: string
): Promise<AgentMemory> {
  const current = await readAgentMemory(redis, userId, agent);
  if (!memoryEnabled()) return current;
  const clean = clip(text, MEM_SUMMARY_TEXT_CAP).trim();
  if (!clean) return current;
  const id = typeof runId === 'string' ? runId : '';
  if (id && current.summaries.some(s => s.runId === id)) return current;
  const summaries = [
    ...current.summaries,
    { t: Date.now(), runId: id, text: clean },
  ].slice(-MEM_SUMMARIES_CAP);
  return writeAgentMemory(redis, userId, agent, { ...current, summaries });
}

// ===========================================================================
// PROMPT BLOCK — the FR-framed recall the planner prompt is primed with.
// ===========================================================================

/** Hard cap on the rendered prompt block (R8-CONTRACT: ≤1500 chars). */
export const MEMORY_PROMPT_MAX_CHARS = 1500;

/**
 * Render the memory as a compact French-framed prompt block ("Mémoire de
 * l'agent:") the loop injects ahead of the user goal. Returns '' when memory is
 * OFF or the blob is empty (no facts/prefs/summaries) — so an empty memory adds
 * ZERO bytes to the prompt. Guaranteed ≤MEMORY_PROMPT_MAX_CHARS: sections are
 * rendered newest-first and the whole block is hard-clipped as a final belt-and-
 * braces guard. Pure + synchronous (takes the already-read `mem`).
 */
export function buildMemoryPromptBlock(mem: AgentMemory | null | undefined): string {
  if (!memoryEnabled()) return '';
  const m = normalizeMemory(mem);
  const prefEntries = Object.entries(m.prefs);
  if (m.facts.length === 0 && prefEntries.length === 0 && m.summaries.length === 0) {
    return '';
  }

  const lines: string[] = ["Mémoire de l'agent:"];

  // Preferences first (most steering value), then facts, then recent runs —
  // each newest-first so a truncation drops the OLDEST context, not the newest.
  if (prefEntries.length) {
    lines.push('Préférences:');
    for (const [k, v] of prefEntries) {
      lines.push(`- ${k}: ${v}`);
    }
  }
  if (m.facts.length) {
    lines.push('Faits connus:');
    for (const f of [...m.facts].reverse()) {
      lines.push(`- ${f.text}`);
    }
  }
  if (m.summaries.length) {
    lines.push('Exécutions récentes:');
    for (const s of [...m.summaries].reverse()) {
      lines.push(`- ${s.text}`);
    }
  }

  // Assemble line-by-line, stopping before we would exceed the cap so we cut on
  // a clean line boundary; a final hard clip guarantees the ceiling regardless.
  let block = '';
  for (const line of lines) {
    const candidate = block ? `${block}\n${line}` : line;
    if (candidate.length > MEMORY_PROMPT_MAX_CHARS) break;
    block = candidate;
  }
  return clip(block, MEMORY_PROMPT_MAX_CHARS);
}

// ===========================================================================
// TOOLS — createMemoryTools(deps) → AgentToolDef[]. Two tools the agent can
// call to persist to / recall from its own memory:
//   · memory_write {text}  (consequential:false) — save a fact/pref line.
//   · memory_read  {}      (consequential:false) — read back current memory.
// Both scope:'all' (either agent), available() only when memoryEnabled(). Return
// [] when OFF so nothing is registered / advertised. The tool ctx already
// carries `services.redis` (the raw CacheRedis) + userId + agent, so the deps
// here only need whatever a tool can't get from ctx — which is nothing; we keep
// a `deps` param for signature parity with the other tool factories (Regis /
// Telegramme) and so a future need (a shared redis handle) has a home.
// ===========================================================================

/** Deps for `createMemoryTools`. Kept structural + optional — see MEMORY-DEPS. */
export interface MemoryToolDeps {
  /** Optional Redis slice to use instead of ctx.services.redis (tests). */
  redis?: MemoryRedis;
}

/** Best-effort MemoryRedis from a tool ctx (its raw CacheRedis) or deps. */
function redisFromCtx(deps: MemoryToolDeps, ctx: AgentToolCtx): MemoryRedis | null {
  const r = deps?.redis ?? (ctx?.services?.redis as MemoryRedis | undefined);
  return r && typeof r.get === 'function' && typeof r.set === 'function'
    ? r
    : null;
}

export function createMemoryTools(deps: MemoryToolDeps = {}): AgentToolDef[] {
  if (!memoryEnabled()) return [];

  const memoryWrite: AgentToolDef = {
    name: 'memory_write',
    description:
      "Mémorise un fait ou une préférence de l'utilisateur pour les prochaines exécutions (mémoire persistante de l'agent). Un fait: 'text'. Une préférence: 'text' = 'clé: valeur'.",
    scope: 'all',
    consequential: false,
    inputSummary: 'text',
    available: () => memoryEnabled(),
    run: async (args: Record<string, unknown>, ctx: AgentToolCtx) => {
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      if (!text) {
        return { ok: false, result: { error: 'text is required' } };
      }
      const redis = redisFromCtx(deps, ctx);
      if (!redis) {
        return { ok: false, result: { error: 'memory_unavailable' } };
      }
      const agent = normalizeAgent(ctx.agent);
      // A leading "key: value" (short key, no newline in the key) is stored as a
      // preference; anything else is stored as a plain fact. Fail-soft either way.
      const prefMatch = /^([^\n:]{1,64}):\s*([\s\S]+)$/.exec(text);
      try {
        if (prefMatch) {
          await setPref(redis, ctx.userId, agent, prefMatch[1].trim(), prefMatch[2].trim());
          return {
            ok: true,
            result: { saved: 'pref' },
            preview: clip(text, 200),
          };
        }
        await appendFact(redis, ctx.userId, agent, text);
        return {
          ok: true,
          result: { saved: 'fact' },
          preview: clip(text, 200),
        };
      } catch {
        // Memory failures must NEVER break a run — report a soft failure.
        return { ok: false, result: { error: 'memory_write_failed' } };
      }
    },
  };

  const memoryRead: AgentToolDef = {
    name: 'memory_read',
    description:
      "Lit la mémoire persistante de l'agent (faits connus, préférences, résumés des exécutions récentes) pour cet utilisateur.",
    scope: 'all',
    consequential: false,
    inputSummary: '{}',
    available: () => memoryEnabled(),
    run: async (_args: Record<string, unknown>, ctx: AgentToolCtx) => {
      const redis = redisFromCtx(deps, ctx);
      if (!redis) {
        return { ok: false, result: { error: 'memory_unavailable' } };
      }
      const agent = normalizeAgent(ctx.agent);
      try {
        const mem = await readAgentMemory(redis, ctx.userId, agent);
        const result = {
          facts: mem.facts.map(f => f.text),
          prefs: mem.prefs,
          summaries: mem.summaries.map(s => s.text),
        };
        const preview = clip(
          `${result.facts.length} faits, ${Object.keys(result.prefs).length} préférences, ${result.summaries.length} résumés`,
          200
        );
        return { ok: true, result, preview };
      } catch {
        return { ok: false, result: { error: 'memory_read_failed' } };
      }
    },
  };

  return [memoryWrite, memoryRead];
}

// ===========================================================================
// SUMMARIZER — registerMemorySummarizer(deps). Hooks the run engine's
// `onAgentRunDone` (exactly like Telegramme's run-done push): when a run
// finishes DONE, ask cdz-flash for a one-line summary and append it via
// appendRunSummary. Fail-soft throughout; registered once, idempotent.
//
// The cdz-flash call MIRRORS the proven direct-CDZ_AI path in conversation/
// compact.ts + hermes callPlanner: OpenAI-compatible POST to
// `${CDZ_AI_BASE_URL}/v1/chat/completions`, model cdz-flash (CDZ_PLANNER_MODEL),
// `Authorization: Bearer ${CDZ_AI_KEY}`, tiny token budget, short
// AbortSignal.timeout, fail-CLOSED parsing (choices[0].message.content or null).
// ===========================================================================

// --- CDZ_AI direct-path envs (mirrors compact.ts:31-35 / hermes:150-155). The
// base is normalized to strip a trailing slash AND a trailing /v1 (operators set
// it either way) before we append the single canonical path. ---
const CDZ_AI_BASE_URL = (process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '')
  .replace(/\/+$/, '');
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';
// Reuse the SAME model env the hermes planner reads (default cdz-flash) so the
// summary rides the same model config as the loop it summarizes.
const CDZ_MEMORY_MODEL = process.env.CDZ_PLANNER_MODEL || 'cdz-flash';
const CDZ_MEMORY_URL = `${CDZ_AI_BASE_URL}/v1/chat/completions`;

// Budgets: a one-liner needs almost nothing; keep the call cheap + fast.
const MEMORY_SUMMARY_MAX_TOKENS = 120;
const MEMORY_SUMMARY_TIMEOUT_MS = 8000;
// Cap the transcript we feed the summariser so the request stays cheap
// regardless of how long a run got.
const MEMORY_PROMPT_TEXT_CAP = 2000;

const MEMORY_SUMMARY_INSTRUCTION = [
  "Tu résumes en UNE seule phrase courte (français) ce qu'un agent a fait lors d'une exécution,",
  "pour la mémoire long-terme de l'agent. Capture l'objectif et le résultat clé.",
  'Pas de préambule, pas de guillemets, pas de markdown. Maximum ~40 mots.',
].join('\n');

/**
 * Deps for the summarizer. Structural + minimal (framework-light): it needs the
 * raw redis handle to append the summary, nothing else. See MEMORY-DEPS in
 * NOTES.md — Relance constructs this from the hermes ctor (`{ redis: this.redis }`)
 * behind the memory + agents flags.
 */
export interface MemorySummarizerDeps {
  redis: MemoryRedis;
}

let summarizerRegistered = false;

/**
 * Call cdz-flash for a one-line run summary. Returns the trimmed line or null on
 * ANY failure (no key, non-2xx, timeout, empty) — fail-CLOSED, never throws,
 * never logs key material. Mirrors compact.ts callCdzFlash / hermes callPlanner.
 */
async function summarizeRun(rec: AgentRunRecord): Promise<string | null> {
  if (!CDZ_AI_KEY) return null;
  // Compose a compact transcript: the prompt + a trailing slice of step
  // previews + the final answer. Bounded to keep the request cheap.
  const stepLines = Array.isArray(rec.steps)
    ? rec.steps
        .slice(-8)
        .map(s => {
          const tag = s.tool ? `[${s.tool}]` : `[${s.kind}]`;
          const detail = s.preview || s.argsPreview || '';
          return `${tag} ${detail}`.trim();
        })
        .filter(Boolean)
    : [];
  const transcript = clip(
    [
      `Objectif: ${rec.prompt || ''}`,
      stepLines.length ? `Étapes:\n${stepLines.join('\n')}` : '',
      rec.finalText ? `Résultat: ${rec.finalText}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    MEMORY_PROMPT_TEXT_CAP
  );
  try {
    const response = await fetch(CDZ_MEMORY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CDZ_AI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CDZ_MEMORY_MODEL,
        messages: [
          { role: 'system', content: MEMORY_SUMMARY_INSTRUCTION },
          { role: 'user', content: transcript },
        ],
        max_tokens: MEMORY_SUMMARY_MAX_TOKENS,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(MEMORY_SUMMARY_TIMEOUT_MS),
    });
    const data = (await response.json().catch(() => null)) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (response.ok && typeof content === 'string' && content.trim()) {
      return clip(content.trim(), MEM_SUMMARY_TEXT_CAP);
    }
  } catch {
    // fall through — fail-closed (a summary is best-effort, never load-bearing).
  }
  return null;
}

/**
 * Register the memory summarizer with the run engine (idempotent, fail-soft).
 * On a DONE run (skips failed/stopped/empty), asks cdz-flash for a one-liner and
 * appends it to the run owner's per-agent memory. Called by Relance from the
 * hermes ctor behind the memory flag. Safe to call when the engine is absent
 * (onAgentRunDone missing) — the registration is simply skipped. Never throws.
 */
export function registerMemorySummarizer(deps: MemorySummarizerDeps): void {
  if (summarizerRegistered) return;
  if (!deps || !deps.redis) return;
  try {
    if (typeof onAgentRunDone !== 'function') return;
    onAgentRunDone(async (rec: AgentRunRecord) => {
      try {
        // Gate re-checked at fire time (flag may flip without a restart) so this
        // is a true no-op when memory is OFF.
        if (!memoryEnabled()) return;
        if (!rec || rec.state !== 'done') return;
        if (!validUser(rec.userId)) return;
        // Nothing worth summarizing (no answer + no work) ⇒ skip the call.
        if (!rec.finalText && (!rec.steps || rec.steps.length === 0)) return;
        const line = await summarizeRun(rec);
        if (!line) return;
        await appendRunSummary(
          deps.redis,
          rec.userId,
          normalizeAgent(rec.agent),
          rec.runId,
          line
        );
      } catch {
        // A summary problem must NEVER surface to the run — swallow.
      }
    });
    summarizerRegistered = true;
  } catch {
    // onAgentRunDone unavailable / threw on register: leave unregistered.
  }
}
