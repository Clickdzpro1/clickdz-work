import { Body, Controller, Get, Param, Post } from '@nestjs/common';

// Typed AFFiNE errors (a raw HttpException is coerced to a generic 500 by
// base/nestjs/exception.ts): NotFound = the gated-OFF "feature disabled" 404,
// the SAME stance the sibling agent controllers take; BadRequest = bad body.
// Cache = the @Global JSON Redis provider (get<T> / set w/ PX ttl in MS, fail-
// soft) — the SAME provider Hermes + the Telegram channel use, so the tg binding
// written there (clickdz:tg:user:{userId}) is read here as-is.
import { BadRequest, Cache, NotFound } from '../../base';
// CacheRedis = the @Global raw ioredis provider — the SAME handle Hermes/bridge/
// the run engine inject. Moteur's listAgentRuns() needs the RAW client (zset
// ops), which CacheRedis satisfies structurally (its RunRedis slice).
import { CacheRedis } from '../../base/redis';
// CurrentUser decorates (param) + types the cookie-session user, from core/auth
// like every peer. Ownership is by user.id (all keys per-user); AuthGuard gates.
import { CurrentUser } from '../../core/auth';
// Moteur's run engine (clickdz-agent-runs.ts). AgentName = shared 'hermes'|
// 'openclaw' union; listAgentRuns reads the per-user+agent zset newest-first.
// Called fail-soft below so a missing/partial engine never crashes this read.
// The orchestrator merges all R6 files, so this static import resolves at boot.
import { type AgentName, listAgentRuns } from './clickdz-agent-runs';

// ---------------------------------------------------------------------------
// CDZ AGENTS — STATUS + STATE (WSU-8, R6 §"Agents status backend").
// A tiny owner-scoped surface the R7 agents UI keys off:
//   · GET  /api/v1/agents              — roster; per agent its newest run
//                                        (lastRun) + Telegram-binding flag.
//   · POST /api/v1/agents/:agent/state — persist an informational enabled flag
//                                        (clickdz:agentstate:{userId}:{agent}).
// Both gated by CDZ_AGENTS_ENABLED (R6 master gate): OFF ⇒ typed 404, byte-
// identical to the feature not existing. Fail-soft everywhere (Redis is a
// cache): a failed read degrades to "no data", never a 500. No SSE; typed
// errors only; imports nothing from the frontend.
// ---------------------------------------------------------------------------

// Config (read once at module load, same idiom as the sibling controllers).
const CDZ_AGENTS_ENABLED = process.env.CDZ_AGENTS_ENABLED || '';

// The fixed agent roster (order = display order). `beta` flags both while the
// R6/R7 runtime stabilises; labels are the product-facing names.
interface AgentDescriptor {
  id: AgentName;
  label: string;
  beta: boolean;
}
const AGENTS: readonly AgentDescriptor[] = [
  { id: 'hermes', label: 'Hermes', beta: true },
  { id: 'openclaw', label: 'OpenClaw', beta: true },
];

// --- Redis key helpers (EXACTLY the contract's namespaces).
// Per-user Telegram outbound binding written by the Telegram channel
// (clickdz-agent-telegram.ts): userId → { chatId }. Its presence == the caller
// has a bound Telegram chat, i.e. the `channels.telegram` boolean here.
const userTgBindKey = (userId: string) => `clickdz:tg:user:${userId}`;
// Informational per-user+agent enable flag (POST /state target). Consumed by
// the R7 UI; the runtime itself does NOT gate on it (runs are gated by env).
const agentStateKey = (userId: string, agent: AgentName) =>
  `clickdz:agentstate:${userId}:${agent}`;

// State-flag TTL (Cache API takes MS). 90d, re-armed on write — matches the
// tg-binding lifetime so a settings toggle sticks.
const STATE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// The lastRun projection the FE needs off a run record (thin, stable slice).
interface AgentLastRun {
  runId: string;
  state: string;
  at: number;
}

// One roster row on the wire.
interface AgentStatus {
  id: AgentName;
  label: string;
  beta: boolean;
  lastRun?: AgentLastRun;
  channels: { telegram: boolean };
}

/** Narrow a `:agent` path segment to the known union (else null). */
function normalizeAgent(raw: unknown): AgentName | null {
  return raw === 'hermes' || raw === 'openclaw' ? raw : null;
}

@Controller()
export class ClickDzAgentsController {
  // Raw ioredis (satisfies Moteur's RunRedis for the zset reads) + the JSON
  // Cache (tg binding + state flag) — the SAME dual-handle idiom Hermes uses.
  constructor(
    private readonly redis: CacheRedis,
    private readonly cache: Cache
  ) {}

  /** Typed 404 when the master gate is off — never leaks that the route exists. */
  private assertEnabled() {
    if (CDZ_AGENTS_ENABLED !== '1') {
      throw new NotFound('Agents are not enabled');
    }
  }

  /** Caller's newest run for one agent → lastRun projection (fail-soft → undefined). */
  private async lastRunFor(
    userId: string,
    agent: AgentName
  ): Promise<AgentLastRun | undefined> {
    try {
      // listAgentRuns takes the RAW redis first (RunRedis slice); newest entry
      // from the per-user+agent zset (newest-first). Prefer endedAt then startedAt.
      const runs = await listAgentRuns(this.redis as any, userId, agent, 1);
      const rec = runs && runs.length ? runs[0] : null;
      if (!rec || typeof rec.runId !== 'string') return undefined;
      return {
        runId: rec.runId,
        state: typeof rec.state === 'string' ? rec.state : 'queued',
        at:
          typeof rec.endedAt === 'number'
            ? rec.endedAt
            : typeof rec.startedAt === 'number'
              ? rec.startedAt
              : Date.now(),
      };
    } catch {
      return undefined; // fail-soft: a read failure is "no runs yet"
    }
  }

  /** True when the caller has a bound Telegram chat (fail-soft → false). */
  private async hasTelegram(userId: string): Promise<boolean> {
    try {
      const bind = await this.cache.get<{ chatId?: number | string }>(
        userTgBindKey(userId)
      );
      return bind != null && bind.chatId != null;
    } catch {
      return false;
    }
  }

  // GET /api/v1/agents — the roster. @CurrentUser, owner-scoped (keyed by
  // user.id): one row per agent with its newest run + Telegram-binding flag.
  // Read-only, fail-soft, never SSE.
  @Get('/api/v1/agents')
  async listAgents(
    @CurrentUser() user: CurrentUser
  ): Promise<{ agents: AgentStatus[] }> {
    this.assertEnabled();
    // The tg binding is one lookup for the whole user; do it once.
    const telegram = await this.hasTelegram(user.id);
    const agents: AgentStatus[] = [];
    for (const descriptor of AGENTS) {
      const lastRun = await this.lastRunFor(user.id, descriptor.id);
      agents.push({
        id: descriptor.id,
        label: descriptor.label,
        beta: descriptor.beta,
        ...(lastRun ? { lastRun } : {}),
        channels: { telegram },
      });
    }
    return { agents };
  }

  // POST /api/v1/agents/:agent/state — persist an informational enabled flag
  // for the R7 UI. @CurrentUser. Body { enabled: boolean }. Typed 404 for an
  // unknown :agent, typed 400 for a bad body. The flag does NOT gate runtime.
  @Post('/api/v1/agents/:agent/state')
  async setAgentState(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string,
    @Body() body: unknown
  ): Promise<{ ok: boolean; enabled: boolean }> {
    this.assertEnabled();
    const agent = normalizeAgent(agentParam);
    if (!agent) {
      // Unknown agent — a typed 404 (indistinguishable from "no such route").
      throw new NotFound(`unknown agent "${agentParam}"`);
    }
    const payload = (body ?? {}) as Record<string, unknown>;
    if (typeof payload.enabled !== 'boolean') {
      throw new BadRequest('"enabled" must be a boolean');
    }
    const enabled = payload.enabled;
    let ok = false;
    // Persist {enabled} via the JSON Cache (fail-soft), 90d TTL. A false return
    // (Redis down) leaves ok:false but we still echo the intended state so the
    // UI can proceed optimistically.
    try {
      const stored = await this.cache.set(
        agentStateKey(user.id, agent),
        { enabled },
        { ttl: STATE_TTL_MS }
      );
      ok = !!stored;
    } catch {
      ok = false;
    }
    return { ok, enabled };
  }
}
