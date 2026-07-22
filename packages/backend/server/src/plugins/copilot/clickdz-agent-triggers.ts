import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Logger,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Response } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';

// JobQueue is the BullMQ wrapper (base/job barrel) — the SAME provider the
// copilot session / embedding job handlers + Moteur's run engine inject.
// NotFound / BadRequest are the typed AFFiNE errors (base/error): a raw
// @nestjs/common HttpException is coerced to a generic 500 by the global
// exception filter, so every gated-OFF route reports a clean typed 404 and every
// 4xx goes through these (or @Res passthrough) exactly like the sibling agent
// controllers. Throttle rate-caps the routes the same way the bridge / run
// controller do. ALL value-imported (lint-nest: every ctor-param + decorator
// identifier must resolve at boot — the #73 boot-crash lesson).
import { BadRequest, JobQueue, NotFound, Throttle } from '../../base';
// CacheRedis is the @Global raw ioredis provider (extends ioredis Redis) — the
// SAME handle clickdz-agent-runs / clickdz-bridge / clickdz-data inject. We take
// the RAW client (not the JSON Cache wrapper) because the sweep needs zset ops
// the wrapper does not surface: ZRANGEBYSCORE (due scan), ZADD/ZREM (reschedule)
// plus SET EX / GET / EXPIRE. Every call is wrapped fail-soft — Redis is a
// cache, never source of truth.
import { CacheRedis } from '../../base/redis';
// @Public marks the inbound webhook route as skipping the global cookie
// AuthGuard (an external caller has no app session — authenticated solely by the
// URL secret). CurrentUser both decorates (param) + types the cookie-session
// user on the CRUD routes. Both from core/auth exactly like the peer agent
// controllers (clickdz-agent-telegram / clickdz-agent-runs).
import { CurrentUser, Public } from '../../core/auth';
// safeEqual = constant-time string comparison (hashes both sides to a
// fixed-length digest first, so unequal lengths neither throw nor leak length
// through timing). Reused verbatim to gate the webhook secret — the SAME
// primitive cdz-data-token.ts uses for its write/blob/staff tokens and that
// clickdz-agent-telegram uses for its Bot API webhook secret.
import { safeEqual } from './cdz-data-token';
// Moteur's background run engine (owner: clickdz-agent-runs.ts). We call these
// by their pinned R6 names — REDIS-FIRST for createAgentRun/checkDailyRunCap,
// QUEUE-FIRST for enqueueAgentRun (the R6 telegram bug was calling these
// object-first). Every call is wrapped fail-soft so a partial/absent engine can
// never crash the sweep or a route.
import {
  checkDailyRunCap,
  createAgentRun,
  enqueueAgentRun,
} from './clickdz-agent-runs';
// Reuse the shared runtime's agent-name type so triggers speak ONE vocabulary
// with the run engine + FE.
import type { AgentName } from './clickdz-agent-runtime';

// ===========================================================================
// clickdz-agent-triggers.ts — SCHEDULED + WEBHOOK TRIGGERS (WSA-11, owner:
// Horloge). Turns an agent into something that runs ITSELF: on a preset
// schedule (a cron sweep fires due triggers) or on an inbound webhook POST.
// A fired trigger becomes a detached agent run (Moteur's queue drives it,
// channel 'schedule' | 'webhook').
//
// This one file owns THREE things (mirrors how clickdz-agent-runs.ts colocates
// its @OnJob class with its plain functions):
//   1. Plain exported functions (preset parsing + nextFireAt + record I/O) that
//      take a `redis` handle as the first param — unit-testable against a stub
//      redis with ZERO framework weight.
//   2. The @Cron EVERY_MINUTE sweep class (ONE Nest-decorated provider; injects
//      JobQueue + CacheRedis exactly like ClickDzAgentRunJob).
//   3. The @Controller class (CRUD routes + the @Public webhook route).
//
// EVERYTHING is inert unless BOTH gates are on, BOTH default OFF today:
//   · CDZ_AGENT_TRIGGERS_ENABLED — the '1' master gate for this feature.
//   · CDZ_AGENTS_ENABLED         — the agents master gate (already ON in prod).
// Flags off ⇒ the routes 404 and the sweep no-ops ⇒ byte-identical behaviour.
// ===========================================================================

// --- Config (read like every other CDZ env in this plugin: literal fallback).
function triggersEnabled(): boolean {
  return (
    process.env.CDZ_AGENT_TRIGGERS_ENABLED === '1' &&
    process.env.CDZ_AGENTS_ENABLED === '1'
  );
}

// The app's public origin — the exact env + fallback the bridge / telegram
// controller use everywhere they need an absolute, externally-reachable URL
// (here: to build the copy-paste webhook URL). Trailing slashes stripped.
const APP_EXTERNAL_URL = (
  process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
).replace(/\/+$/, '');

// ===========================================================================
// PRESET SCHEDULE ids (R8 — EXACT, no crontab). Three shapes ONLY:
//   hourly            — every hour, on the minute the trigger was created.
//   daily@HH:MM       — every day at HH:MM Algiers-local.
//   weekly@D@HH:MM    — every week on day D (1=Mon .. 7=Sun) at HH:MM.
// ===========================================================================

export type TriggerKind = 'cron' | 'webhook';

/** A parsed, validated preset. `kind` narrows which fields are meaningful. */
export type ParsedPreset =
  | { kind: 'hourly' }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; dow: number; hour: number; minute: number };

// Algiers is UTC+1 all year (no DST) — a FIXED offset. Every wall-clock
// computation shifts the epoch by this, does its arithmetic in "shifted UTC"
// (which then reads as Algiers-local via the UTC getters), then shifts back.
const ALGIERS_OFFSET_MS = 60 * 60 * 1000; // +01:00
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse + validate a preset id. Returns null for anything malformed / out of
 * range (so callers fail closed with a typed 400 rather than persisting junk).
 * Pure + deterministic.
 */
export function parsePreset(preset: unknown): ParsedPreset | null {
  if (typeof preset !== 'string') return null;
  const s = preset.trim();
  if (s === 'hourly') return { kind: 'hourly' };
  // daily@HH:MM
  let m = /^daily@(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (!isValidHM(hour, minute)) return null;
    return { kind: 'daily', hour, minute };
  }
  // weekly@D@HH:MM (D = 1..7, Mon..Sun)
  m = /^weekly@([1-7])@(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const dow = Number(m[1]);
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    if (dow < 1 || dow > 7 || !isValidHM(hour, minute)) return null;
    return { kind: 'weekly', dow, hour, minute };
  }
  return null;
}

function isValidHM(hour: number, minute: number): boolean {
  return (
    Number.isInteger(hour) &&
    Number.isInteger(minute) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59
  );
}

/** JS `getUTCDay()` is 0=Sun..6=Sat; our preset D is 1=Mon..7=Sun. Convert. */
function isoDow(jsDay: number): number {
  return jsDay === 0 ? 7 : jsDay;
}

/**
 * Compute the NEXT fire time (ms epoch, UTC) for a preset, strictly AFTER
 * `from`. All wall-clock reasoning is done in Africa/Algiers (fixed UTC+1, no
 * DST): we shift `from` into Algiers-local by adding the offset, read the local
 * Y/M/D/H/M with the UTC getters, find the next matching local slot, then shift
 * the resulting local epoch back to real UTC by subtracting the offset.
 *
 * Returns 0 for an unparseable preset (the sweep never schedules such a
 * trigger; a route validates before persisting). Never throws.
 */
export function nextFireAt(preset: string, from: number = Date.now()): number {
  const p = parsePreset(preset);
  if (!p) return 0;
  const base = Number.isFinite(from) ? from : Date.now();

  if (p.kind === 'hourly') {
    // Every hour on the minute the trigger fires. We anchor to the local
    // minute-of-hour of `from` and advance to the next hour boundary carrying
    // that minute. Working in Algiers-local space keeps the minute stable
    // across the offset (the minute-of-hour is offset-invariant for a whole-
    // hour offset, but we stay in local space for uniformity).
    const local = base + ALGIERS_OFFSET_MS;
    const d = new Date(local);
    const minuteOfHour = d.getUTCMinutes();
    // Truncate local to the start of this hour, add the target minute.
    const hourStart = Math.floor(local / HOUR_MS) * HOUR_MS;
    let candidateLocal = hourStart + minuteOfHour * 60 * 1000;
    if (candidateLocal <= local) candidateLocal += HOUR_MS;
    return candidateLocal - ALGIERS_OFFSET_MS;
  }

  // daily@ + weekly@ share the HH:MM slot logic; weekly additionally advances to
  // the matching day-of-week.
  const local = base + ALGIERS_OFFSET_MS;
  const d = new Date(local);
  // Start from today's local date at the target HH:MM.
  let candidate = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    p.hour,
    p.minute,
    0,
    0
  );
  if (p.kind === 'daily') {
    // Strictly after `from`: if today's slot already passed, jump a day.
    if (candidate <= local) candidate += DAY_MS;
    return candidate - ALGIERS_OFFSET_MS;
  }
  // weekly: advance to the target day-of-week (1..7). Compute today's ISO dow at
  // the candidate instant, then add whole days until it matches AND the slot is
  // strictly in the future (handles the WEEK WRAP: e.g. it's Sunday 10:00 and
  // the trigger is Mon 09:00 → +1 day; it's Mon 10:00 and trigger is Mon 09:00 →
  // +7 days).
  let guardDays = 0;
  // Re-derive dow from the candidate (same calendar day as `d`).
  let candDow = isoDow(new Date(candidate).getUTCDay());
  while ((candDow !== p.dow || candidate <= local) && guardDays < 8) {
    candidate += DAY_MS;
    candDow = isoDow(new Date(candidate).getUTCDay());
    guardDays += 1;
  }
  return candidate - ALGIERS_OFFSET_MS;
}

// ===========================================================================
// TRIGGER RECORD shape (R8 — EXACT). Persisted JSON at the record key below.
// ===========================================================================

export interface AgentTriggerRecord {
  id: string;
  userId: string;
  agent: AgentName;
  kind: TriggerKind;
  preset?: string;
  hookSecret?: string;
  prompt: string;
  active: boolean;
  lastFiredAt?: number;
  nextFireAt?: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Caps / TTLs. TTLs here are SECONDS (raw ioredis EXPIRE / SET EX), matching the
// run engine's convention. The record self-expires at 90d, re-armed on write.
// ---------------------------------------------------------------------------
const TRIG_TTL_SEC = 90 * 24 * 60 * 60; // record + per-user zset: ~90 days
const PROMPT_MIN = 2;
const PROMPT_MAX = 8_000;
const SWEEP_CAP = 20; // max triggers fired per minute-sweep (R8)
const WEBHOOK_BODY_MAX = 4 * 1024; // ≤4KB inbound body appended as context (R8)
const HOOK_SECRET_BYTES = 18; // → 24 base64url chars, unguessable one-way secret

// ---------------------------------------------------------------------------
// Redis key helpers (R8 — EXACT namespaces).
//   record       clickdz:agenttrig:{userId}:{id}      JSON, 90d
//   per-user set clickdz:agenttrigs:{userId}          zset, score=createdAt
//   GLOBAL due   clickdz:agenttrigs:due               zset, member {userId}:{id}
//                                                      score=nextFireAt (cron
//                                                      triggers only; webhook
//                                                      triggers are NOT here).
// ---------------------------------------------------------------------------
const trigKey = (userId: string, id: string) =>
  `clickdz:agenttrig:${userId}:${id}`;
const userTrigsKey = (userId: string) => `clickdz:agenttrigs:${userId}`;
const DUE_KEY = 'clickdz:agenttrigs:due';
const dueMember = (userId: string, id: string) => `${userId}:${id}`;

/** Split a due-zset member back into its {userId, id}. Fail-soft → null. */
function parseDueMember(member: string): { userId: string; id: string } | null {
  if (typeof member !== 'string') return null;
  const i = member.indexOf(':');
  if (i <= 0 || i >= member.length - 1) return null;
  return { userId: member.slice(0, i), id: member.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// The minimal ioredis surface the trigger store + sweep need. CacheRedis (which
// extends ioredis Redis) satisfies this structurally, and a test stub only has
// to implement these — same "accept a slice, not the class" trick the run engine
// (RunRedis) uses so this module carries ZERO framework weight in its functions.
// ---------------------------------------------------------------------------
export interface TrigRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<any>;
  del(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  zadd(key: string, ...args: (string | number)[]): Promise<any>;
  zrem(key: string, ...members: string[]): Promise<any>;
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    ...args: any[]
  ): Promise<string[]>;
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

function normalizeAgent(a: unknown): AgentName {
  return a === 'openclaw' ? 'openclaw' : 'hermes';
}

/** A webhook secret: short, URL-safe, unguessable. */
function mintHookSecret(): string {
  return randomBytes(HOOK_SECRET_BYTES).toString('base64url');
}

/** Coerce a possibly-partial persisted record into a well-formed record. */
function normalizeRecord(raw: any): AgentTriggerRecord | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
    return null;
  }
  const kind: TriggerKind = raw.kind === 'webhook' ? 'webhook' : 'cron';
  return {
    id: raw.id,
    userId: String(raw.userId ?? ''),
    agent: normalizeAgent(raw.agent),
    kind,
    preset: typeof raw.preset === 'string' ? raw.preset : undefined,
    hookSecret: typeof raw.hookSecret === 'string' ? raw.hookSecret : undefined,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    active: raw.active !== false,
    lastFiredAt:
      typeof raw.lastFiredAt === 'number' ? raw.lastFiredAt : undefined,
    nextFireAt: typeof raw.nextFireAt === 'number' ? raw.nextFireAt : undefined,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
  };
}

// ===========================================================================
// RECORD I/O — all fail-soft (Redis is a cache, never source of truth).
// ===========================================================================

async function writeTrigger(
  redis: TrigRedis,
  rec: AgentTriggerRecord
): Promise<void> {
  try {
    await redis.set(
      trigKey(rec.userId, rec.id),
      JSON.stringify(rec),
      'EX',
      TRIG_TTL_SEC
    );
  } catch {
    /* fail-soft */
  }
}

/** Read + normalize a trigger record. Returns null when missing/corrupt. */
export async function readTrigger(
  redis: TrigRedis,
  userId: string,
  id: string
): Promise<AgentTriggerRecord | null> {
  if (!userId || !id) return null;
  try {
    const raw = await redis.get(trigKey(userId, id));
    return normalizeRecord(safeParse<AgentTriggerRecord>(raw));
  } catch {
    return null;
  }
}

/**
 * List a user's trigger records for an agent, newest first (by createdAt).
 * Prunes zset entries whose record expired. Fail-soft → [].
 */
export async function listTriggers(
  redis: TrigRedis,
  userId: string,
  agent: AgentName
): Promise<AgentTriggerRecord[]> {
  if (!userId) return [];
  let ids: string[];
  try {
    ids = await redis.zrevrange(userTrigsKey(userId), 0, 199);
  } catch {
    return [];
  }
  if (!ids || !ids.length) return [];
  const out: AgentTriggerRecord[] = [];
  const dead: string[] = [];
  for (const id of ids) {
    const rec = await readTrigger(redis, userId, id);
    if (!rec) {
      dead.push(id); // expired/deleted → prune from index
      continue;
    }
    if (rec.agent === agent) out.push(rec);
  }
  if (dead.length) {
    try {
      await redis.zrem(userTrigsKey(userId), ...dead);
    } catch {
      /* fail-soft */
    }
  }
  return out;
}

// ===========================================================================
// CREATE — allocate id, compute first nextFireAt (cron only), persist, index in
// the per-user zset, and (cron only) add to the GLOBAL due zset.
// ===========================================================================

export interface CreateTriggerInput {
  userId: string;
  agent: AgentName;
  kind: TriggerKind;
  preset?: string;
  prompt: string;
}

/**
 * Create + persist a trigger. For kind 'cron' the caller MUST pass a valid
 * preset (validate with parsePreset first); we compute the first nextFireAt and
 * add it to the due zset. For kind 'webhook' we mint a one-way secret and DO NOT
 * add it to the due zset (it fires on inbound POST, not on a schedule). Returns
 * the record. Fail-soft on all Redis writes.
 */
export async function createTrigger(
  redis: TrigRedis,
  input: CreateTriggerInput
): Promise<AgentTriggerRecord> {
  const now = Date.now();
  const id = randomUUID();
  const isWebhook = input.kind === 'webhook';
  const rec: AgentTriggerRecord = {
    id,
    userId: input.userId,
    agent: normalizeAgent(input.agent),
    kind: isWebhook ? 'webhook' : 'cron',
    preset: isWebhook ? undefined : input.preset,
    hookSecret: isWebhook ? mintHookSecret() : undefined,
    prompt: truncate(input.prompt ?? '', PROMPT_MAX),
    active: true,
    createdAt: now,
    nextFireAt:
      !isWebhook && input.preset ? nextFireAt(input.preset, now) : undefined,
  };
  await writeTrigger(redis, rec);
  try {
    await redis.zadd(userTrigsKey(rec.userId), now, id);
    await redis.expire(userTrigsKey(rec.userId), TRIG_TTL_SEC);
  } catch {
    /* fail-soft */
  }
  if (isWebhook) {
    // Persist the id→owner pointer so the @Public webhook (URL carries only the
    // id) can locate this per-user-keyed record without a scan.
    await writeHookOwner(redis, id, rec.userId);
  } else if (rec.nextFireAt) {
    try {
      await redis.zadd(DUE_KEY, rec.nextFireAt, dueMember(rec.userId, id));
    } catch {
      /* fail-soft */
    }
  }
  return rec;
}

/** Delete a trigger + its index/due entries. Idempotent, fail-soft. */
export async function deleteTrigger(
  redis: TrigRedis,
  userId: string,
  id: string
): Promise<void> {
  try {
    await redis.del(trigKey(userId, id));
  } catch {
    /* fail-soft */
  }
  try {
    await redis.zrem(userTrigsKey(userId), id);
  } catch {
    /* fail-soft */
  }
  try {
    await redis.zrem(DUE_KEY, dueMember(userId, id));
  } catch {
    /* fail-soft */
  }
}

/**
 * Toggle a trigger active/inactive. When re-activating a CRON trigger we
 * recompute nextFireAt + re-add it to the due zset; when deactivating we remove
 * it from the due zset (so the sweep skips it entirely). Returns the updated
 * record or null when missing. Fail-soft.
 */
export async function toggleTrigger(
  redis: TrigRedis,
  userId: string,
  id: string
): Promise<AgentTriggerRecord | null> {
  const rec = await readTrigger(redis, userId, id);
  if (!rec) return null;
  rec.active = !rec.active;
  if (rec.kind === 'cron' && rec.preset) {
    if (rec.active) {
      rec.nextFireAt = nextFireAt(rec.preset, Date.now());
      try {
        await redis.zadd(DUE_KEY, rec.nextFireAt, dueMember(userId, id));
      } catch {
        /* fail-soft */
      }
    } else {
      try {
        await redis.zrem(DUE_KEY, dueMember(userId, id));
      } catch {
        /* fail-soft */
      }
    }
  }
  await writeTrigger(redis, rec);
  return rec;
}

// ===========================================================================
// deferConsequential — a run started by a schedule / webhook is UNSUPERVISED, so
// a consequential tool call inside it must be DEFERRED for approval rather than
// executed. Relance calls this in the hermes dispatch: if def.consequential &&
// deferConsequential(rec) → record a deferred step + fail-soft ping, do NOT run.
// We read only `channel` off the record (structural — accepts Moteur's
// AgentRunRecord or any {channel} shape) so there is no import cycle.
// ===========================================================================
export function deferConsequential(rec: { channel?: string } | null): boolean {
  const c = rec?.channel;
  return c === 'schedule' || c === 'webhook';
}

// ===========================================================================
// FIRE — the shared "turn a due/inbound trigger into a run" path, used by BOTH
// the sweep and the webhook route. Respects the per-user daily run cap; on a
// successful create it enqueues the detached job. Returns whether a run was
// created (the sweep uses this to decide reschedule-vs-cap-reschedule; the
// webhook uses it for its ack). Fail-soft: any throw ⇒ false, never surfaced.
// ===========================================================================

export interface FireResult {
  created: boolean;
  capped: boolean;
}

async function fireTrigger(
  redis: TrigRedis,
  queue: JobQueue,
  rec: AgentTriggerRecord,
  channel: 'schedule' | 'webhook',
  contextSuffix?: string
): Promise<FireResult> {
  // Daily cap: checkDailyRunCap INCRements the per-user counter (fails OPEN on
  // Redis error). When capped we DO NOT create/enqueue — the caller reschedules.
  let capped = false;
  try {
    const cap = await checkDailyRunCap(redis as any, rec.userId);
    if (!cap.allowed) capped = true;
  } catch {
    capped = false; // fail-open — the cap is an abuse guard, not correctness
  }
  if (capped) return { created: false, capped: true };

  const prompt =
    contextSuffix && contextSuffix.trim()
      ? truncate(`${rec.prompt}\n\n${contextSuffix.trim()}`, PROMPT_MAX)
      : rec.prompt;

  try {
    // REDIS-FIRST create (R6 signature: createAgentRun(redis, input)), then
    // QUEUE-FIRST enqueue (enqueueAgentRun(queue, rec)) — the exact order the
    // run controller + telegram controller use (the R6 telegram bug was calling
    // these object-first).
    const run = await createAgentRun(redis as any, {
      userId: rec.userId,
      agent: rec.agent,
      prompt,
      channel,
    });
    if (run) {
      await enqueueAgentRun(queue, run);
      return { created: true, capped: false };
    }
  } catch {
    /* fail-soft */
  }
  return { created: false, capped: false };
}

// ===========================================================================
// THE @Cron EVERY_MINUTE SWEEP — ONE Nest-decorated provider. Injects JobQueue
// + the raw CacheRedis (mirrors ClickDzAgentRunJob / CopilotCronJobs DI). Guards
// BOTH env flags; caps SWEEP_CAP triggers per tick; fail-soft PER trigger so one
// bad record never aborts the batch. Respects the daily cap (skip + reschedule
// when capped). The @Cron idiom mirrors cron.ts / abuse.ts exactly.
// ===========================================================================
@Injectable()
export class ClickDzAgentTriggerSweep {
  private readonly logger = new Logger(ClickDzAgentTriggerSweep.name);

  constructor(
    private readonly redis: CacheRedis,
    private readonly queue: JobQueue
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep() {
    if (!triggersEnabled()) return; // flags off ⇒ no-op (byte-identical)
    const redis = this.redis as unknown as TrigRedis;
    const now = Date.now();

    // Due members: cron triggers whose nextFireAt ≤ now, oldest-due first,
    // capped at SWEEP_CAP. ZRANGEBYSCORE with a LIMIT slice (raw ioredis args).
    let members: string[];
    try {
      members = await redis.zrangebyscore(
        DUE_KEY,
        '-inf',
        now,
        'LIMIT',
        0,
        SWEEP_CAP
      );
    } catch {
      return; // Redis unavailable this tick → nothing to do; try next minute.
    }
    if (!members || !members.length) return;

    for (const member of members) {
      // Per-trigger fail-soft: a single bad record must never abort the batch.
      try {
        await this.processDue(redis, member, now);
      } catch (err) {
        this.logger.warn(
          `agent-trigger sweep: member '${member}' failed: ${
            (err as Error)?.message ?? err
          }`
        );
        // Best-effort: drop a member we could not process so it does not wedge
        // the head of the due zset every tick.
        try {
          await redis.zrem(DUE_KEY, member);
        } catch {
          /* fail-soft */
        }
      }
    }
  }

  /**
   * Process ONE due member: load the record; if it is gone / not a cron trigger
   * / inactive → drop it from the due zset and stop. Otherwise fire it (respect
   * the daily cap) and reschedule to the next slot. Whether it fired or was
   * cap-skipped, a CRON trigger always gets a fresh nextFireAt so it keeps
   * ticking (a cap-skip reschedules to the next slot — the run is simply
   * dropped for today, not lost forever).
   */
  private async processDue(
    redis: TrigRedis,
    member: string,
    now: number
  ): Promise<void> {
    const parsed = parseDueMember(member);
    if (!parsed) {
      await redis.zrem(DUE_KEY, member);
      return;
    }
    const { userId, id } = parsed;
    const rec = await readTrigger(redis, userId, id);
    // Gone / not a schedulable cron / no preset / inactive → remove from due.
    if (!rec || rec.kind !== 'cron' || !rec.preset || !rec.active) {
      await redis.zrem(DUE_KEY, member);
      return;
    }

    const result = await fireTrigger(redis, this.queue, rec, 'schedule');
    // Reschedule to the next slot regardless of created/capped (a capped tick
    // still advances the schedule so we don't hammer the same minute).
    const next = nextFireAt(rec.preset, now);
    rec.nextFireAt = next;
    if (result.created) rec.lastFiredAt = now;
    await writeTrigger(redis, rec);
    try {
      if (next > 0) {
        await redis.zadd(DUE_KEY, next, member);
      } else {
        // Unparseable preset (should never happen — validated on create) → drop.
        await redis.zrem(DUE_KEY, member);
      }
    } catch {
      /* fail-soft */
    }
  }
}

// ===========================================================================
// THE @Controller — CRUD routes (@CurrentUser, gated → typed 404) + the @Public
// webhook route (constant-time secret compare, throttled like other public
// routes). Injects the raw CacheRedis + JobQueue exactly like the run
// controller. Thin: all state lives in the exported functions above.
// ===========================================================================
@Controller()
export class ClickDzAgentTriggersController {
  constructor(
    private readonly redis: CacheRedis,
    private readonly queue: JobQueue
  ) {}

  // Typed 404 when either gate is off — never leaks that the route exists.
  private gate(): void {
    if (!triggersEnabled()) {
      throw new NotFound('agent triggers are not enabled');
    }
  }

  private agentOf(agent: string): AgentName {
    if (agent === 'hermes' || agent === 'openclaw') return agent;
    throw new NotFound(`unknown agent "${agent}"`);
  }

  /** Build the copy-paste inbound webhook URL for a webhook-kind record. */
  private hookUrl(rec: AgentTriggerRecord): string | undefined {
    if (rec.kind !== 'webhook' || !rec.hookSecret) return undefined;
    return `${APP_EXTERNAL_URL}/api/v1/agents/hooks/${rec.id}.${rec.hookSecret}`;
  }

  /** Shape a record for the wire (adds the webhook URL for webhook kind). */
  private view(rec: AgentTriggerRecord) {
    return { ...rec, webhookUrl: this.hookUrl(rec) };
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/agents/:agent/triggers → AgentTriggerRecord[] (newest first).
  // -------------------------------------------------------------------------
  // R13 (429 fix): own per-route bucket via the custom override (';custom'
  // key, see base/throttler generateKey) — the bare 'default' tier shares ONE
  // 120/60s bucket per session across all default-tier routes, and the
  // dashboard's missions loader was competing in it (429 storm).
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/agents/:agent/triggers')
  async list(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string
  ) {
    this.gate();
    const agent = this.agentOf(agentParam);
    const recs = await listTriggers(this.redis as any, user.id, agent);
    return recs.map(r => this.view(r));
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/agents/:agent/triggers {kind, preset?, prompt}
  //   → the created record (incl. the webhook URL for kind 'webhook').
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/agents/:agent/triggers')
  async create(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string,
    @Body() body: any
  ) {
    this.gate();
    const agent = this.agentOf(agentParam);

    const kind: TriggerKind = body?.kind === 'webhook' ? 'webhook' : 'cron';
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (prompt.length < PROMPT_MIN || prompt.length > PROMPT_MAX) {
      throw new BadRequest(
        `"prompt" must be a string of ${PROMPT_MIN}..${PROMPT_MAX} chars`
      );
    }

    let preset: string | undefined;
    if (kind === 'cron') {
      preset = typeof body?.preset === 'string' ? body.preset.trim() : '';
      if (!parsePreset(preset)) {
        throw new BadRequest(
          '"preset" must be one of: hourly | daily@HH:MM | weekly@D@HH:MM (D=1-7)'
        );
      }
    }

    const rec = await createTrigger(this.redis as any, {
      userId: user.id,
      agent,
      kind,
      preset,
      prompt,
    });
    return this.view(rec);
  }

  // -------------------------------------------------------------------------
  // DELETE /api/v1/agents/:agent/triggers/:id → {ok:true} (idempotent).
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Delete('/api/v1/agents/:agent/triggers/:id')
  async remove(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string,
    @Param('id') id: string
  ): Promise<{ ok: true }> {
    this.gate();
    this.agentOf(agentParam);
    await deleteTrigger(this.redis as any, user.id, typeof id === 'string' ? id.trim() : '');
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/agents/:agent/triggers/:id/toggle → the updated record.
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/agents/:agent/triggers/:id/toggle')
  async toggle(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string,
    @Param('id') id: string
  ) {
    this.gate();
    const agent = this.agentOf(agentParam);
    const rec = await toggleTrigger(
      this.redis as any,
      user.id,
      typeof id === 'string' ? id.trim() : ''
    );
    if (!rec || rec.agent !== agent) {
      throw new NotFound(`trigger "${id}" not found`);
    }
    return this.view(rec);
  }

  // -------------------------------------------------------------------------
  // WEBHOOK. @Public (no cookie) — authenticated SOLELY by the URL `:hook`
  // segment `{id}.{secret}`, whose secret half is constant-time compared to the
  // record's stored hookSecret (via safeEqual — the SAME primitive the telegram
  // webhook + data token use). @Throttle('strict') exactly like the bridge's
  // other @Public routes. On a match we fire a detached run (channel 'webhook')
  // with the inbound body (≤4KB) appended to the prompt as a context preview.
  // A wrong/unknown hook is a typed 404 (indistinguishable from "no such
  // route"). ALWAYS fail-soft — never a raw 500.
  // -------------------------------------------------------------------------
  @Public()
  @Throttle('strict')
  @Post('/api/v1/agents/hooks/:hook')
  async webhook(
    @Param('hook') hook: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ ok: boolean }> {
    this.gate();
    // Parse `{id}.{secret}` — the id is a UUID (contains no dot), the secret is
    // base64url (no dot), so a split on the FIRST dot is unambiguous.
    const raw = typeof hook === 'string' ? hook : '';
    const dot = raw.indexOf('.');
    if (dot <= 0 || dot >= raw.length - 1) {
      throw new NotFound('Not found');
    }
    const id = raw.slice(0, dot);
    const secret = raw.slice(dot + 1);

    // The webhook URL carries only {id} (no userId — an external caller must not
    // need it), but records are keyed per-user, so we resolve the owner via the
    // id→userId pointer written at create time, then load + verify the record.
    const owner = await this.resolveHookOwner(id);
    if (!owner) {
      // Unknown hook → 404 (do not reveal whether the id or the secret was wrong)
      throw new NotFound('Not found');
    }
    const rec = await readTrigger(this.redis as any, owner, id);
    if (
      !rec ||
      rec.kind !== 'webhook' ||
      !rec.hookSecret ||
      !safeEqual(rec.hookSecret, secret)
    ) {
      throw new NotFound('Not found');
    }
    if (!rec.active) {
      // Paused webhook: accept the call but do nothing (ack 200 so the caller
      // does not retry-storm), same stance the telegram webhook takes.
      return { ok: true };
    }

    // Append the inbound body (≤4KB) as a context preview for the agent.
    let context = '';
    try {
      const asText =
        typeof body === 'string' ? body : JSON.stringify(body ?? {});
      if (asText && asText !== '{}') {
        context = `Contexte du webhook:\n${truncate(asText, WEBHOOK_BODY_MAX)}`;
      }
    } catch {
      context = '';
    }

    const result = await fireTrigger(
      this.redis as any,
      this.queue,
      rec,
      'webhook',
      context
    );
    if (result.created) {
      rec.lastFiredAt = Date.now();
      await writeTrigger(this.redis as any, rec);
    }
    // 429-ish signal without a raw throw: the body carries the outcome so the
    // caller can retry later, but we still ack 200 to avoid retry storms.
    if (result.capped) res.status(202);
    return { ok: result.created };
  }

  /**
   * Resolve a webhook record's owner from its id. Webhook records are keyed
   * per-user like every other trigger, but the @Public webhook URL only carries
   * the id (no userId — an external caller must not need to know it). We write a
   * tiny id→userId pointer at create time so the webhook can locate the record
   * without scanning. Kept private + fail-soft.
   */
  private async resolveHookOwner(id: string): Promise<string | null> {
    if (!id) return null;
    try {
      const owner = await (this.redis as any).get(hookOwnerKey(id));
      return typeof owner === 'string' && owner ? owner : null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook id→owner pointer. The @Public webhook URL carries only {id} (an
// external caller must not need the userId), but records are keyed per-user, so
// we persist a tiny id→userId pointer at webhook-create time (90d, same TTL as
// the record). This is written by createTrigger's webhook branch below via
// writeHookOwner — colocated here so the key helper + writer live together.
// ---------------------------------------------------------------------------
const hookOwnerKey = (id: string) => `clickdz:agenttrig:hook:${id}`;

export async function writeHookOwner(
  redis: TrigRedis,
  id: string,
  userId: string
): Promise<void> {
  if (!id || !userId) return;
  try {
    await redis.set(hookOwnerKey(id), userId, 'EX', TRIG_TTL_SEC);
  } catch {
    /* fail-soft */
  }
}
