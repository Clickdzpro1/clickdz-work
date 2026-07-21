import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

// JobQueue (BullMQ wrapper) + OnJob decorator + JOB_SIGNAL come from the base
// barrel — same import the doc-service / copilot-embedding job handlers use.
import { JOB_SIGNAL, JobQueue, OnJob } from '../../base';
// CacheRedis is the @Global raw ioredis provider (extends ioredis Redis) — the
// SAME handle clickdz-bridge / clickdz-data / clickdz-hermes inject. We take the
// RAW client here (not the JSON `Cache` wrapper) because the run engine needs
// zset (ZADD/ZREVRANGE), list-trim (LTRIM) and INCR — ops the Cache wrapper does
// not surface. Every call is wrapped fail-soft: Redis is a cache, never source
// of truth (recon §landmine 3).
import { CacheRedis } from '../../base/redis';
// Reuse the shared runtime's wire-protocol + agent-name types so the run engine,
// the loop bodies (Filaire/Passerelle) and the FE speak ONE vocabulary.
import type { AgentEvent, AgentName } from './clickdz-agent-runtime';
export type { AgentEvent, AgentName } from './clickdz-agent-runtime';

// ===========================================================================
// clickdz-agent-runs.ts — the BACKGROUND RUN ENGINE (R6 §"Run engine").
//
// The two agent consoles (HERMES + OPENCLAW) currently run their plan->act loop
// INSIDE the request handler bound to an open SSE socket: close the tab and the
// run dies (recon §gap "Long-running background runs"). This module decouples a
// run from any socket:
//
//   1. A durable RUN RECORD in Redis (clickdz:agentrun:{uid}:{runId}, 30d) that
//      captures state + a capped step trail + budgets + the final answer.
//   2. A BullMQ job `copilot.agent.run` whose @OnJob handler drives the loop
//      DETACHED from the request. enqueueAgentRun() puts it on the `copilot`
//      queue.
//   3. An EVENT REPLAY buffer (a Redis list, RPUSH + LTRIM 500, 24h) so a client
//      that (re)attaches — via Canal's SSE endpoint — gets full history, then
//      live events. emit() appends to that list AND forwards to any live SSE
//      forwarder registered in-process for that runId.
//   4. Budgets: tool-call cap + wall-clock (AbortController) + a per-user daily
//      run cap (Redis INCR).
//   5. A completion hook (onAgentRunDone) so Telegramme can push the result to a
//      bound chat when a run finishes.
//
// It is FRAMEWORK-LIGHT: only the @OnJob handler is Nest-decorated (it needs
// JobQueue + CacheRedis injected). Everything else is plain exported functions
// taking a `redis` handle as the first parameter, so it unit-tests against a
// stub redis and a stub loop fn with zero DI. Nothing here throws out of a
// public function; nothing logs secrets.
//
// Gating: the engine is inert unless a run is created + enqueued, which only
// Canal/Telegramme do behind CDZ_AGENTS_ENABLED. Flags off ⇒ byte-identical.
// ===========================================================================

// ---------------------------------------------------------------------------
// BullMQ job augmentation. `copilot` is an existing Queue (base/job/queue/def.ts
// Queue.COPILOT = 'copilot'), so the `copilot.*` namespace is valid — mirror the
// def.ts `declare global { interface Jobs {} }` pattern the other consumers use.
// ---------------------------------------------------------------------------
declare global {
  interface Jobs {
    'copilot.agent.run': {
      userId: string;
      runId: string;
      agent: AgentName;
    };
  }
}

// ===========================================================================
// R6 — RUN RECORD shape (exact). Persisted JSON at the record key below.
// ===========================================================================

export type RunChannel = 'web' | 'telegram';

export type RunState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'done'
  | 'failed'
  | 'stopped';

export type RunStepKind = 'tool' | 'plan' | 'final';

export interface RunStep {
  i: number;
  kind: RunStepKind;
  tool?: string;
  argsPreview?: string;
  ok?: boolean;
  preview?: string;
  at: number;
}

export interface RunBudget {
  maxToolCalls: number;
  maxWallMs: number;
  toolCalls: number;
}

export interface AgentRunRecord {
  v: 1;
  runId: string;
  agent: AgentName;
  userId: string;
  threadId?: string;
  prompt: string;
  channel: RunChannel;
  state: RunState;
  steps: RunStep[];
  startedAt: number;
  endedAt?: number;
  error?: string;
  finalText?: string;
  budget: RunBudget;
}

// ===========================================================================
// Caps / TTLs (R6 §"Run engine" — EXACT). TTLs here are SECONDS (raw ioredis
// EXPIRE / SET EX), unlike the JSON Cache wrapper which takes PX ms.
// ===========================================================================

const RUN_TTL_SEC = 30 * 24 * 60 * 60; // record: ~30 days
const EVENTS_TTL_SEC = 24 * 60 * 60; // event replay list: ~24 hours
const EVENTS_CAP = 500; // LTRIM keeps the newest 500 events
const DAILY_COUNT_TTL_SEC = 2 * 24 * 60 * 60; // daily run-count key: ~2 days
const STEP_CAP = 60; // steps[] cap on the record (R6)
const PREVIEW_CAP = 600; // per-step preview char cap (R6)
const ARGS_PREVIEW_CAP = 600; // argsPreview char cap (same budget)
const FINAL_TEXT_CAP = 20_000; // keep finalText bounded on the record
const ERROR_CAP = 600;

// ---------------------------------------------------------------------------
// Env-derived budget defaults. Read like every other CDZ env in this plugin
// (`process.env.CDZ_...` with a literal fallback) — recon §env.
// ---------------------------------------------------------------------------

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function maxToolCalls(): number {
  return envInt('CDZ_AGENT_MAX_TOOL_CALLS', 12);
}
export function maxWallMs(): number {
  return envInt('CDZ_AGENT_MAX_WALL_MS', 300_000);
}
export function maxRunsPerDay(): number {
  return envInt('CDZ_AGENT_MAX_RUNS_PER_DAY', 50);
}

// ---------------------------------------------------------------------------
// Redis key helpers (R6 — EXACT names). Record + events are per-user+runId; the
// listing index is a per-user+agent zset; the daily counter is per-user+day.
// ---------------------------------------------------------------------------

const runKey = (userId: string, runId: string) =>
  `clickdz:agentrun:${userId}:${runId}`;
const eventsKey = (userId: string, runId: string) =>
  `clickdz:agentrun:${userId}:${runId}:events`;
const indexKey = (userId: string, agent: AgentName) =>
  `clickdz:agentruns:${userId}:${agent}`;
const dailyCountKey = (userId: string, day: string) =>
  `clickdz:agentruns:count:${userId}:${day}`;

/** UTC YYYYMMDD used by the daily run-cap key. */
export function utcDay(ts: number = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// The minimal ioredis surface the engine needs. CacheRedis (which extends
// ioredis Redis) satisfies this structurally, and a test stub only has to
// implement these — same "accept a slice, not the class" trick clickdz-shop-
// state.ts uses so this module carries ZERO framework weight.
// ---------------------------------------------------------------------------

export interface RunRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<any>;
  del(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  incr(key: string): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<any>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  zadd(key: string, ...args: (string | number)[]): Promise<any>;
  zrem(key: string, ...members: string[]): Promise<any>;
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
}

// ===========================================================================
// RUN-ENGINE-DEPS — the seam Filaire/Passerelle/Canal code against.
// ===========================================================================

/**
 * What emit() does: append the SSE event to the durable replay list AND push it
 * to any live SSE forwarder attached for this run. The loop bodies (hermes /
 * openclaw) receive this and treat it EXACTLY like the runtime's SSE writer
 * `emit` — one call per event, never throws.
 */
export type RunEmit = (ev: AgentEvent) => void;

/**
 * Everything a detached loop body needs. Moteur owns the state machine + budget
 * enforcement AROUND this; the caller (Filaire for hermes, Passerelle for
 * openclaw) injects the actual per-agent loop via `loop`.
 *
 *  - `redis`      the raw handle (record/event/index/counter I/O).
 *  - `planner`    the cdz-flash chat-completions caller the existing loops use
 *                 (opaque here — the loop body owns its prompt/plan/act cycle).
 *  - `registry`   the shared ClickDzToolRegistry (Regis) the loop dispatches
 *                 tools through. Opaque to the engine.
 *  - `loop`       the per-agent detached loop body. Receives the (frozen-ish)
 *                 run record, an `emit`, an `AbortSignal` (tripped on wall-clock
 *                 or stop), and helpers to record steps / count tool calls /
 *                 check the cooperative stop flag. Returns the final answer text
 *                 (or throws → the engine marks the run failed).
 *  - `config`     optional app Config (planner keys etc.), passed through.
 *  - `runtime`    optional ClickDzAgentRuntime, so a loop body can reuse thread
 *                 persistence / awaitApproval / stop registry unchanged.
 */
export interface AgentLoopDeps {
  redis: RunRedis;
  planner?: unknown;
  registry?: unknown;
  config?: unknown;
  runtime?: unknown;
  loop: AgentLoopFn;
}

/** Context handed to the injected per-agent loop body. */
export interface AgentLoopContext {
  emit: RunEmit;
  /** Aborts on wall-clock timeout OR a cooperative stop request. */
  signal: AbortSignal;
  /**
   * Record a step on the run record (capped + previews truncated) AND emit the
   * matching SSE event. Returns the step index. The loop calls this instead of
   * touching the record directly.
   */
  recordStep: (step: Omit<RunStep, 'i' | 'at'>) => Promise<number>;
  /**
   * Increment the tool-call counter and return whether the budget is exhausted
   * (`allowed:false` ⇒ the loop must stop before the next tool call). Persists
   * budget.toolCalls on the record.
   */
  chargeToolCall: () => Promise<{ allowed: boolean; toolCalls: number }>;
  /** True once a cooperative stop was requested (or the signal aborted). */
  isStopped: () => Promise<boolean>;
  /** The (mutable copy of the) run record the loop is executing. */
  record: AgentRunRecord;
  planner?: unknown;
  registry?: unknown;
  config?: unknown;
  runtime?: unknown;
}

/**
 * The per-agent loop body signature. Filaire exports `runHermesLoop`, Passerelle
 * exports the openclaw equivalent; both are adapted to this shape and injected
 * as `deps.loop`. Resolve with the final answer text.
 */
export type AgentLoopFn = (ctx: AgentLoopContext) => Promise<string>;

// ===========================================================================
// In-process live SSE forwarder registry. Canal's stream endpoint registers a
// forwarder for a runId while a client is attached; the job (which may run in
// the SAME process) forwards live events through it. Cross-process attach still
// works via the replay list — the forwarder is a best-effort live fast-path.
// ===========================================================================

type RunForwarder = (ev: AgentEvent) => void;
const forwarders = new Map<string, Set<RunForwarder>>();

/** Attach a live forwarder for a run. Returns an unregister fn. */
export function registerRunForwarder(
  runId: string,
  fn: RunForwarder
): () => void {
  if (!runId || typeof fn !== 'function') return () => {};
  let set = forwarders.get(runId);
  if (!set) {
    set = new Set();
    forwarders.set(runId, set);
  }
  set.add(fn);
  return () => unregisterRunForwarder(runId, fn);
}

/** Detach a previously-registered forwarder. */
export function unregisterRunForwarder(runId: string, fn: RunForwarder): void {
  const set = forwarders.get(runId);
  if (!set) return;
  set.delete(fn);
  if (set.size === 0) forwarders.delete(runId);
}

function fanoutLive(runId: string, ev: AgentEvent): void {
  const set = forwarders.get(runId);
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try {
      fn(ev);
    } catch {
      /* a bad forwarder must not break the run */
    }
  }
}

// ===========================================================================
// Completion hook. Telegramme registers a callback so a finished run can be
// pushed to the caller's bound chat. Exported registerable list — fail-soft.
// ===========================================================================

type RunDoneCallback = (rec: AgentRunRecord) => void | Promise<void>;
const doneCallbacks: RunDoneCallback[] = [];

/** Register a completion callback (Telegramme's notifyRunDone). Idempotent-ish. */
export function onAgentRunDone(cb: RunDoneCallback): () => void {
  if (typeof cb !== 'function') return () => {};
  doneCallbacks.push(cb);
  return () => {
    const i = doneCallbacks.indexOf(cb);
    if (i >= 0) doneCallbacks.splice(i, 1);
  };
}

async function fireRunDone(rec: AgentRunRecord): Promise<void> {
  for (const cb of doneCallbacks.slice()) {
    try {
      await cb(rec);
    } catch {
      /* a bad completion callback must not fail the job */
    }
  }
}

// ===========================================================================
// Small pure helpers.
// ===========================================================================

function truncate(s: unknown, cap: number): string {
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

function normalizeChannel(c: unknown): RunChannel {
  return c === 'telegram' ? 'telegram' : 'web';
}

/** Coerce a possibly-partial persisted record into a well-formed record. */
function normalizeRecord(raw: any): AgentRunRecord | null {
  if (!raw || typeof raw !== 'object' || typeof raw.runId !== 'string') {
    return null;
  }
  const agent: AgentName = raw.agent === 'openclaw' ? 'openclaw' : 'hermes';
  const steps: RunStep[] = Array.isArray(raw.steps)
    ? raw.steps
        .filter((s: any) => s && typeof s === 'object')
        .map((s: any, idx: number) => ({
          i: typeof s.i === 'number' ? s.i : idx,
          kind:
            s.kind === 'tool' || s.kind === 'plan' || s.kind === 'final'
              ? s.kind
              : 'plan',
          tool: typeof s.tool === 'string' ? s.tool : undefined,
          argsPreview:
            typeof s.argsPreview === 'string' ? s.argsPreview : undefined,
          ok: typeof s.ok === 'boolean' ? s.ok : undefined,
          preview: typeof s.preview === 'string' ? s.preview : undefined,
          at: typeof s.at === 'number' ? s.at : Date.now(),
        }))
        .slice(-STEP_CAP)
    : [];
  const b = raw.budget && typeof raw.budget === 'object' ? raw.budget : {};
  return {
    v: 1,
    runId: raw.runId,
    agent,
    userId: String(raw.userId ?? ''),
    threadId: typeof raw.threadId === 'string' ? raw.threadId : undefined,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    channel: normalizeChannel(raw.channel),
    state: isRunState(raw.state) ? raw.state : 'queued',
    steps,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : Date.now(),
    endedAt: typeof raw.endedAt === 'number' ? raw.endedAt : undefined,
    error: typeof raw.error === 'string' ? raw.error : undefined,
    finalText: typeof raw.finalText === 'string' ? raw.finalText : undefined,
    budget: {
      maxToolCalls:
        typeof b.maxToolCalls === 'number' ? b.maxToolCalls : maxToolCalls(),
      maxWallMs: typeof b.maxWallMs === 'number' ? b.maxWallMs : maxWallMs(),
      toolCalls: typeof b.toolCalls === 'number' ? b.toolCalls : 0,
    },
  };
}

function isRunState(s: unknown): s is RunState {
  return (
    s === 'queued' ||
    s === 'running' ||
    s === 'waiting_approval' ||
    s === 'done' ||
    s === 'failed' ||
    s === 'stopped'
  );
}

const TERMINAL: RunState[] = ['done', 'failed', 'stopped'];
function isTerminal(s: RunState): boolean {
  return TERMINAL.includes(s);
}

// ===========================================================================
// RECORD I/O — all fail-soft.
// ===========================================================================

async function writeRecord(
  redis: RunRedis,
  rec: AgentRunRecord
): Promise<void> {
  try {
    // Enforce record caps before persisting.
    if (rec.steps.length > STEP_CAP) rec.steps = rec.steps.slice(-STEP_CAP);
    if (rec.finalText) rec.finalText = truncate(rec.finalText, FINAL_TEXT_CAP);
    if (rec.error) rec.error = truncate(rec.error, ERROR_CAP);
    await redis.set(
      runKey(rec.userId, rec.runId),
      JSON.stringify(rec),
      'EX',
      RUN_TTL_SEC
    );
  } catch {
    /* fail-soft: Redis is a cache, not source of truth */
  }
}

/** Read + normalize a run record. Returns null when missing/corrupt. */
export async function readAgentRun(
  redis: RunRedis,
  userId: string,
  runId: string
): Promise<AgentRunRecord | null> {
  if (!userId || !runId) return null;
  try {
    const raw = await redis.get(runKey(userId, runId));
    return normalizeRecord(safeParse<AgentRunRecord>(raw));
  } catch {
    return null;
  }
}

// ===========================================================================
// CREATE — allocate runId, write record, add to the per-user+agent zset index.
// ===========================================================================

export interface CreateAgentRunInput {
  userId: string;
  agent: AgentName;
  prompt: string;
  channel?: RunChannel;
  threadId?: string;
  budget?: Partial<RunBudget>;
}

/**
 * Allocate a run, persist its record, index it in the newest-first zset. Does
 * NOT enqueue (call enqueueAgentRun next) and does NOT enforce the daily cap
 * (call checkDailyRunCap first if you want to gate). Returns the record.
 */
export async function createAgentRun(
  redis: RunRedis,
  input: CreateAgentRunInput
): Promise<AgentRunRecord> {
  const now = Date.now();
  const runId = randomUUID();
  const rec: AgentRunRecord = {
    v: 1,
    runId,
    agent: input.agent === 'openclaw' ? 'openclaw' : 'hermes',
    userId: input.userId,
    threadId: input.threadId,
    prompt: truncate(input.prompt ?? '', 8_000),
    channel: normalizeChannel(input.channel),
    state: 'queued',
    steps: [],
    startedAt: now,
    budget: {
      maxToolCalls: input.budget?.maxToolCalls ?? maxToolCalls(),
      maxWallMs: input.budget?.maxWallMs ?? maxWallMs(),
      toolCalls: 0,
    },
  };
  await writeRecord(redis, rec);
  try {
    await redis.zadd(indexKey(rec.userId, rec.agent), now, runId);
    // The index outlives its records (records self-expire at 30d); refresh its
    // TTL on activity so it doesn't grow unbounded forever.
    await redis.expire(indexKey(rec.userId, rec.agent), RUN_TTL_SEC);
  } catch {
    /* fail-soft */
  }
  return rec;
}

/**
 * List run records for a user+agent, newest first, capped at `limit` (default
 * 30, hard max 100). Prunes zset entries whose record expired. Fail-soft → [].
 */
export async function listAgentRuns(
  redis: RunRedis,
  userId: string,
  agent: AgentName,
  limit = 30
): Promise<AgentRunRecord[]> {
  if (!userId) return [];
  const n = Math.max(1, Math.min(100, Number.isFinite(limit) ? limit : 30));
  let ids: string[];
  try {
    ids = await redis.zrevrange(indexKey(userId, agent), 0, n - 1);
  } catch {
    return [];
  }
  if (!ids || !ids.length) return [];
  const out: AgentRunRecord[] = [];
  const dead: string[] = [];
  for (const id of ids) {
    const rec = await readAgentRun(redis, userId, id);
    if (rec) out.push(rec);
    else dead.push(id); // expired/deleted → prune from index
  }
  if (dead.length) {
    try {
      await redis.zrem(indexKey(userId, agent), ...dead);
    } catch {
      /* fail-soft */
    }
  }
  return out;
}

// ===========================================================================
// STATE — transition helper (persists). Never regresses a terminal state.
// ===========================================================================

export async function setRunState(
  redis: RunRedis,
  userId: string,
  runId: string,
  state: RunState,
  patch: Partial<Pick<AgentRunRecord, 'endedAt' | 'error' | 'finalText'>> = {}
): Promise<AgentRunRecord | null> {
  const rec = await readAgentRun(redis, userId, runId);
  if (!rec) return null;
  if (isTerminal(rec.state) && !isTerminal(state)) {
    // Do not resurrect a terminal run into a live one.
    return rec;
  }
  rec.state = state;
  if (patch.endedAt !== undefined) rec.endedAt = patch.endedAt;
  if (patch.error !== undefined) rec.error = truncate(patch.error, ERROR_CAP);
  if (patch.finalText !== undefined)
    rec.finalText = truncate(patch.finalText, FINAL_TEXT_CAP);
  await writeRecord(redis, rec);
  return rec;
}

// ===========================================================================
// EVENT replay buffer — RPUSH + LTRIM cap 500 + EXPIRE 24h.
// ===========================================================================

/** Append one event to the durable replay list (capped + TTL-refreshed). */
export async function appendRunEvent(
  redis: RunRedis,
  userId: string,
  runId: string,
  ev: AgentEvent
): Promise<void> {
  if (!userId || !runId) return;
  // Never persist heartbeats — they carry no history value and would evict real
  // events under the 500 cap.
  if ((ev as any)?.type === 'ping') return;
  const key = eventsKey(userId, runId);
  let line: string;
  try {
    line = JSON.stringify(ev);
  } catch {
    return; // non-serializable event → skip rather than crash the run
  }
  try {
    await redis.rpush(key, line);
    await redis.ltrim(key, -EVENTS_CAP, -1);
    await redis.expire(key, EVENTS_TTL_SEC);
  } catch {
    /* fail-soft */
  }
}

/** Read the buffered events for replay (oldest→newest). Fail-soft → []. */
export async function readRunEvents(
  redis: RunRedis,
  userId: string,
  runId: string
): Promise<AgentEvent[]> {
  if (!userId || !runId) return [];
  let raw: string[];
  try {
    raw = await redis.lrange(eventsKey(userId, runId), 0, -1);
  } catch {
    return [];
  }
  const out: AgentEvent[] = [];
  for (const line of raw ?? []) {
    const ev = safeParse<AgentEvent>(line);
    if (ev) out.push(ev);
  }
  return out;
}

// ===========================================================================
// BUDGET — daily per-user run cap via INCR (key TTL 2d).
// ===========================================================================

export interface DailyCapResult {
  allowed: boolean;
  count: number;
  limit: number;
}

/**
 * Atomically INCR the per-user daily run counter and decide whether the run is
 * allowed. Sets the key TTL to ~2d on first increment. On any Redis error we
 * FAIL OPEN (allow) — the cap is an abuse guard, not a correctness invariant.
 */
export async function checkDailyRunCap(
  redis: RunRedis,
  userId: string,
  now: number = Date.now()
): Promise<DailyCapResult> {
  const limit = maxRunsPerDay();
  const key = dailyCountKey(userId, utcDay(now));
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, DAILY_COUNT_TTL_SEC);
    }
    return { allowed: count <= limit, count, limit };
  } catch {
    return { allowed: true, count: 0, limit };
  }
}

// ===========================================================================
// ENQUEUE — put the detached run on the `copilot` BullMQ queue.
// ===========================================================================

/**
 * Enqueue a run for detached execution. `jobId` is derived from the runId so a
 * double-enqueue is idempotent at the queue level. Returns the BullMQ job (or
 * undefined on failure — callers should already have persisted the record).
 */
export async function enqueueAgentRun(queue: JobQueue, rec: AgentRunRecord) {
  try {
    return await queue.add(
      'copilot.agent.run',
      { userId: rec.userId, runId: rec.runId, agent: rec.agent },
      { jobId: `copilot-agent-run:${rec.runId}` }
    );
  } catch {
    return undefined;
  }
}

// ===========================================================================
// emit() FACTORY — the RunEmit a running job hands to the loop body. Appends to
// the replay list AND fans out to any live in-process forwarder.
// ===========================================================================

export function makeRunEmit(
  redis: RunRedis,
  userId: string,
  runId: string
): RunEmit {
  return (ev: AgentEvent) => {
    // Live fan-out first (lowest latency for an attached client)…
    fanoutLive(runId, ev);
    // …then durably append (fire-and-forget; never blocks the loop).
    void appendRunEvent(redis, userId, runId, ev);
  };
}

// ===========================================================================
// THE STATE MACHINE around the injected loop body.
// runDetachedAgentLoop: load→running→(loop)→done/failed/stopped, budgets
// enforced (tool-call cap + wall-clock via AbortController), completion hook
// fired. NEVER throws — the loop's throw is caught and mapped to `failed`.
// ===========================================================================

/**
 * Drive one detached run to completion. `rec` is the record loaded by the job
 * handler; `emit` is `makeRunEmit(...)` bound to this run. Mutates + persists
 * the record as it goes.
 */
export async function runDetachedAgentLoop(
  deps: AgentLoopDeps,
  rec: AgentRunRecord,
  emit: RunEmit
): Promise<AgentRunRecord> {
  const { redis } = deps;
  const userId = rec.userId;
  const runId = rec.runId;

  // Wall-clock AbortController. Aborting signals the loop body (which threads
  // the signal into every fetch/planner call) to wind down cooperatively.
  const controller = new AbortController();
  const wallMs =
    rec.budget.maxWallMs > 0 ? rec.budget.maxWallMs : maxWallMs();
  const wallTimer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  }, wallMs);
  (wallTimer as any).unref?.();

  // --- flip to running + emit status ---
  rec.state = 'running';
  rec.startedAt = rec.startedAt || Date.now();
  await writeRecord(redis, rec);
  emit({ type: 'status', phase: 'planning', label: 'running' });

  const recordStep: AgentLoopContext['recordStep'] = async step => {
    const i = rec.steps.length;
    const entry: RunStep = {
      i,
      kind: step.kind,
      tool: step.tool,
      argsPreview:
        step.argsPreview !== undefined
          ? truncate(step.argsPreview, ARGS_PREVIEW_CAP)
          : undefined,
      ok: step.ok,
      preview:
        step.preview !== undefined
          ? truncate(step.preview, PREVIEW_CAP)
          : undefined,
      at: Date.now(),
    };
    rec.steps.push(entry);
    if (rec.steps.length > STEP_CAP) rec.steps = rec.steps.slice(-STEP_CAP);
    await writeRecord(redis, rec);
    // Mirror onto the SSE wire as a `step` frame the FE already renders.
    emit({
      type: 'step',
      step: {
        i: entry.i,
        kind:
          entry.kind === 'tool'
            ? 'tool'
            : entry.kind === 'final'
              ? 'final'
              : 'thought',
        title: entry.tool ? entry.tool : entry.kind,
        detail: entry.argsPreview,
        tool: entry.tool,
        ok: entry.ok,
        resultPreview: entry.preview,
        ts: entry.at,
      },
    });
    return i;
  };

  const chargeToolCall: AgentLoopContext['chargeToolCall'] = async () => {
    rec.budget.toolCalls += 1;
    await writeRecord(redis, rec);
    const cap =
      rec.budget.maxToolCalls > 0 ? rec.budget.maxToolCalls : maxToolCalls();
    return { allowed: rec.budget.toolCalls <= cap, toolCalls: rec.budget.toolCalls };
  };

  const isStopped: AgentLoopContext['isStopped'] = async () => {
    if (controller.signal.aborted) return true;
    // Reuse the runtime's cooperative stop flag if a runtime + threadId exist.
    const rt: any = deps.runtime;
    if (rt && typeof rt.isStopRequested === 'function' && rec.threadId) {
      try {
        return await rt.isStopRequested(rec.threadId);
      } catch {
        return false;
      }
    }
    return false;
  };

  const ctx: AgentLoopContext = {
    emit,
    signal: controller.signal,
    recordStep,
    chargeToolCall,
    isStopped,
    record: rec,
    planner: deps.planner,
    registry: deps.registry,
    config: deps.config,
    runtime: deps.runtime,
  };

  let finalRec: AgentRunRecord = rec;
  try {
    const finalText = await deps.loop(ctx);
    // Distinguish a stop from a clean finish.
    const stopped = await isStopped();
    if (stopped) {
      finalRec =
        (await setRunState(redis, userId, runId, 'stopped', {
          endedAt: Date.now(),
          finalText: truncate(finalText ?? '', FINAL_TEXT_CAP),
        })) ?? rec;
      emit({ type: 'status', phase: 'stopped', label: 'stopped' });
    } else {
      finalRec =
        (await setRunState(redis, userId, runId, 'done', {
          endedAt: Date.now(),
          finalText: truncate(finalText ?? '', FINAL_TEXT_CAP),
        })) ?? rec;
      if (finalText) emit({ type: 'token', text: '' }); // no-op flush guard
      emit({ type: 'status', phase: 'done', label: 'done' });
    }
  } catch (err) {
    const aborted = controller.signal.aborted;
    const message = aborted
      ? 'wall_clock_exceeded'
      : truncate((err as Error)?.message ?? 'agent_run_failed', ERROR_CAP);
    finalRec =
      (await setRunState(redis, userId, runId, aborted ? 'failed' : 'failed', {
        endedAt: Date.now(),
        error: message,
      })) ?? rec;
    // NEVER re-throw: the job handler treats a failed run as a completed job.
    emit({ type: 'error', code: aborted ? 'timeout' : 'run_failed', message });
    emit({ type: 'status', phase: 'error', label: 'error' });
  } finally {
    clearTimeout(wallTimer);
  }

  // Terminal `done` SSE frame so any attached client closes cleanly, then fire
  // the completion hook (Telegramme push, etc.).
  emit({ type: 'ping' }); // cheap keepalive before we detach forwarders
  await fireRunDone(finalRec);
  return finalRec;
}

// ===========================================================================
// THE @OnJob HANDLER — the ONE Nest-decorated class. Injects JobQueue + the raw
// CacheRedis (mirrors doc-service/job.ts DI: @Injectable + constructor deps).
//
// The per-agent loop body is NOT known to this class — Filaire/Passerelle
// register their loop via `registerAgentLoop(agent, fn)` at module init. The
// handler resolves the loop for the job's agent; if none is registered (loop
// bodies not wired yet, or flags off) it marks the run failed and returns —
// byte-safe no-op behavior.
// ===========================================================================

type LoopFactory = (rec: AgentRunRecord) => AgentLoopDeps;
const loopFactories = new Map<AgentName, LoopFactory>();

/**
 * Filaire (hermes) / Passerelle (openclaw) call this once at startup to supply
 * the AgentLoopDeps builder for their agent. The builder receives the run
 * record and returns the deps (planner + registry + the bound loop fn). Kept as
 * a module registry so the @OnJob handler stays free of per-agent imports (no
 * circular deps with the giant controllers).
 */
export function registerAgentLoop(agent: AgentName, factory: LoopFactory): void {
  if (typeof factory === 'function') loopFactories.set(agent, factory);
}

@Injectable()
export class ClickDzAgentRunJob {
  private readonly logger = new Logger(ClickDzAgentRunJob.name);

  constructor(
    private readonly queue: JobQueue,
    private readonly redis: CacheRedis
  ) {}

  @OnJob('copilot.agent.run')
  async runAgent({ userId, runId, agent }: Jobs['copilot.agent.run']) {
    const redis = this.redis as unknown as RunRedis;
    const rec = await readAgentRun(redis, userId, runId);
    if (!rec) {
      this.logger.warn(
        `copilot.agent.run: run ${runId} for ${userId} missing/expired; dropping`
      );
      return JOB_SIGNAL.Done;
    }
    if (isTerminal(rec.state)) {
      // Already finished (double-delivery / manual replay) — nothing to do.
      return JOB_SIGNAL.Done;
    }

    const factory = loopFactories.get(agent) ?? loopFactories.get(rec.agent);
    if (!factory) {
      this.logger.warn(
        `copilot.agent.run: no loop registered for agent '${agent}'; marking failed`
      );
      await setRunState(redis, userId, runId, 'failed', {
        endedAt: Date.now(),
        error: 'agent_loop_unavailable',
      });
      return JOB_SIGNAL.Done;
    }

    let deps: AgentLoopDeps;
    try {
      deps = factory(rec);
      // The factory MAY hand back a different redis (e.g. its own Cache); prefer
      // the injected raw handle if it didn't set one.
      if (!deps.redis) deps.redis = redis;
    } catch (err) {
      this.logger.error(
        `copilot.agent.run: loop factory threw for ${runId}: ${
          (err as Error)?.message ?? err
        }`
      );
      await setRunState(redis, userId, runId, 'failed', {
        endedAt: Date.now(),
        error: 'agent_loop_init_failed',
      });
      return JOB_SIGNAL.Done;
    }

    const emit = makeRunEmit(deps.redis, userId, runId);
    await runDetachedAgentLoop(deps, rec, emit);
    // A run is a single detached execution; we do not auto-repeat the job.
    return JOB_SIGNAL.Done;
  }
}
