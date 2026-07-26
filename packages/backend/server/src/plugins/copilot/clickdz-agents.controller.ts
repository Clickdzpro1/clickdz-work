import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

// Typed AFFiNE errors (a raw HttpException is coerced to a generic 500 by
// base/nestjs/exception.ts): NotFound = the gated-OFF "feature disabled" 404,
// the SAME stance the sibling agent controllers take; BadRequest = bad body.
// Cache = the @Global JSON Redis provider (get<T> / set w/ PX ttl in MS, fail-
// soft) — the SAME provider Hermes + the Telegram channel use, so the tg binding
// written there (clickdz:tg:user:{userId}) is read here as-is.
import { BadRequest, Cache, NotFound } from '../../base';
// CacheRedis = the @Global raw ioredis provider — the SAME handle Hermes/bridge/
// the run engine inject. Moteur's listAgentRuns() needs the RAW client (zset
// ops), which CacheRedis satisfies structurally (its RunRedis slice). The
// budget route also reads the R6 daily-run counter (a plain GET) off it.
import { CacheRedis } from '../../base/redis';
// CurrentUser decorates (param) + types the cookie-session user, from core/auth
// like every peer. Ownership is by user.id (all keys per-user); AuthGuard gates.
import { CurrentUser } from '../../core/auth';
// Moteur's run engine (clickdz-agent-runs.ts). AgentName = shared 'hermes'|
// 'openclaw' union; listAgentRuns reads the per-user+agent zset newest-first.
// Called fail-soft below so a missing/partial engine never crashes this read.
// The orchestrator merges all R6 files, so this static import resolves at boot.
// listAgentArtifacts + AgentArtifactRecord (R10, WS11-6, Musée): reads the
// per-user artifacts library list (clickdz:agentart:{userId}) newest-first,
// optionally filtered by agent. Called fail-soft below; gated by the same
// CDZ_AGENTS_ENABLED master switch as the rest of this controller.
// R11 (WS11-9, Pouls): the budget route reads the month's spend accumulator via
// readMonthSpend (Budget writes it on run completion — key
// clickdz:agentspend:{userId}:{YYYYMM} = {tokens,dzd}) and the run cap /
// UTC-day helpers (maxRunsPerDay, utcDay) so the daily-counter key + cap match
// the run engine EXACTLY. All called fail-soft; static import resolves at boot.
import {
  type AgentArtifactRecord,
  type AgentName,
  listAgentArtifacts,
  listAgentRuns,
  maxRunsPerDay,
  readMonthSpend,
  utcDay,
} from './clickdz-agent-runs';
// Wassila's WhatsApp stub (clickdz-wa-client.ts). waCapsEnabled() is an env-ONLY,
// fetch-free predicate (CDZ_WA_URL && CDZ_WA_TOKEN && CDZ_AGENT_WHATSAPP_ENABLED
// === '1'); today all unset ⇒ false. VALUE import — it is CALLED at runtime by
// buildCaps below, so it must be a real binding (not `import type`). Pure, so it
// is safe on the caps hot path (no I/O). The orchestrator merges R8 files, so
// this static import resolves at boot; flags-off it just returns false.
import { waCapsEnabled } from './clickdz-wa-client';
// The reset key builders live in a PURE module (no imports, no framework) so the
// fast guards spec can import them directly — importing THIS controller pulls in
// the Rust native addon, which that job does not build. See the module header for
// why the reset is index-driven rather than glob-driven.
import {
  isResetSafeKey,
  RESET_MAX_IDS,
  resetRunKeys,
  resetSingletonKeys,
  resetThreadKey,
} from './clickdz-agent-reset-keys';
// Horloge's trigger helpers (clickdz-agent-triggers.ts). The reset route uses
// `deleteTrigger` rather than deleting trigger keys directly, because it also
// ZREMs the caller's members from the GLOBAL cross-user due zset — the one thing
// a per-user wipe must prune rather than delete.
import {
  deleteTrigger,
  listTriggers,
} from './clickdz-agent-triggers';
// SEC-2: the pulse reads the shop's `orders` collection, which the read gate
// protects, so it must carry the same per-slug token every other internal reader
// now sends. Derived server-side per call; never logged, never returned.
import { dataWriteToken } from './cdz-data-token';
// R12 (custom agents — owner: Fonderie, clickdz-agent-registry.ts). The registry
// is FRAMEWORK-LIGHT (plain functions taking the raw redis handle first — the
// SAME RunRedis-ish slice this controller already injects as CacheRedis), so the
// CRUD routes + the roster extension call these directly, fail-soft. The CRITICAL
// export is resolveArchetype: a custom id resolves ONLY under its owner's
// user.id, so a non-owned id ⇒ null ⇒ 404 (the multi-tenant gate). listAgentDefs
// composes the roster's custom rows; create/rename/delete back the CRUD routes;
// AgentDef is the wire shape. All VALUE imports (called at runtime) except the
// type. The orchestrator lands the registry next to this file, so the static
// import resolves at boot; every call is guarded fail-soft below.
import {
  type AgentDef,
  createAgentDef,
  deleteAgentDef,
  listAgentDefs,
  renameAgentDef,
} from './clickdz-agent-registry';

// ---------------------------------------------------------------------------
// CDZ AGENTS — STATUS + STATE (WSU-8, R6 §"Agents status backend").
// A tiny owner-scoped surface the R7 agents UI keys off:
//   · GET  /api/v1/agents              — roster; per agent its newest run
//                                        (lastRun) + Telegram-binding flag.
//   · POST /api/v1/agents/:agent/state — persist an informational enabled flag
//                                        (clickdz:agentstate:{userId}:{agent}).
// R11 (WS11-9, Pouls) adds two owner-scoped, read-only, fail-soft reads the
// Hermes "Bureau" hero (PulseCard) and the agents-home BudgetBar consume:
//   · GET  /api/v1/agents/pulse        — the caller's connected shop aggregated
//                                        into the PulseCard shape (or zeros +
//                                        {connected:false} when no shop).
//   · GET  /api/v1/agents/budget       — the month's DZD/token spend + today's
//                                        run count vs the daily cap (BudgetBar).
// Both gated by CDZ_AGENTS_ENABLED (R6 master gate): OFF ⇒ typed 404, byte-
// identical to the feature not existing. Fail-soft everywhere (Redis is a
// cache): a failed read degrades to "no data", never a 500. No SSE; typed
// errors only; imports nothing from the frontend.
// ---------------------------------------------------------------------------

// Config (read once at module load, same idiom as the sibling controllers).
const CDZ_AGENTS_ENABLED = process.env.CDZ_AGENTS_ENABLED || '';
// R12 — the custom-agents master gate. OFF (default) ⇒ the /agents/custom CRUD
// routes return a typed 404 AND the roster omits custom agents ⇒ byte-identical
// built-ins-only behaviour. Flip to '1' at deploy. Read once, same idiom as the
// gate above (a per-request read is unnecessary — env is fixed for the process).
const CDZ_AGENT_CUSTOM_ENABLED = process.env.CDZ_AGENT_CUSTOM_ENABLED || '';

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
// R11 — the R6 per-user daily run counter. The run engine INCRs this on every
// start (checkDailyRunCap) but keeps the key helper module-private, so the
// budget route REPLICATES the exact string here (clickdz:agentruns:count:
// {userId}:{YYYYMMDD}) and reads it with a plain GET. utcDay() is the run
// engine's OWN exported UTC-day formatter, so the day segment matches byte-for-
// byte (never a drifted "today"). Read-only — this route never writes it.
const dailyRunCountKey = (userId: string, day: string) =>
  `clickdz:agentruns:count:${userId}:${day}`;

// State-flag TTL (Cache API takes MS). 90d, re-armed on write — matches the
// tg-binding lifetime so a settings toggle sticks.
const STATE_TTL_MS = 90 * 24 * 60 * 60 * 1000;


// ---------------------------------------------------------------------------
// R11 — SHOP PULSE (WS11-9, Pouls). The PulseCard hero on the Bureau reads the
// caller's FIRST connected shop/erp app and shows five live business counters.
// We do NOT import the bridge (a controller must not depend on another
// controller): instead we REPLICATE its read exactly. The bridge's erpList
// (clickdz-bridge.controller.ts) does NOT touch Redis for ERP data — it does a
// server-side HTTP GET against the per-slug Data API the deployed shop/ERP also
// hit: `${AFFINE_SERVER_EXTERNAL_URL||'https://work.clickdz.ai'}/api/v2/apps-
// data/{dataSlug}/{collection}?limit=500`, Accept: application/json, 15s abort,
// → array | null. That URL (NOT a bare Redis key) IS the ERP data source, so we
// mirror it 1:1. The publish set IS a Redis key (clickdz:apps:published:
// {userId}) whose members are JSON {slug,url,createdAt,kind?,storeSlug?}; the
// data slug for a record is `storeSlug || slug` (the bridge's own pairing rule,
// see erpDataBase callers / staleness renderTemplate). The KPI math mirrors the
// bridge's /erp/summary metrics() verbatim (delivered = 'Livrée', pending-to-
// confirm = 'Nouvelle', returns = 'Retournée', lowStock stock<=reorderAt).
// FAIL-SOFT: ANY read error (publish set, data API, malformed JSON) degrades to
// zeros — a pulse read must NEVER 500 (it decorates a hero, it is not a source
// of truth). No shop at all ⇒ {connected:false} + zeros.
// ---------------------------------------------------------------------------

// Same env + trailing-slash strip the bridge's erpDataBase uses, so the in-app
// pulse and the deployed shop hit one shared datastore.
const CDZ_ERP_EXTERNAL_BASE = (
  process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
).replace(/\/+$/, '');
// The bridge's ERP_DATA_TIMEOUT_MS (15s) — a slow data API must not stall the
// hero; on timeout the fetch rejects and we fall through to zeros.
const PULSE_DATA_TIMEOUT_MS = 15_000;
// The five French pipeline states (bridge ERP_ORDER_STATUSES). Only the two we
// key off are named here (the rest are irrelevant to the pulse counters).
const PULSE_STATUS_DELIVERED = 'Livrée';
const PULSE_STATUS_TO_CONFIRM = 'Nouvelle';
const PULSE_STATUS_RETURNED = 'Retournée';

/** One data-API record (schemaless JSON + server-managed id/createdAt). */
type PulseRecord = Record<string, unknown>;

/** A published-app record as stored in the Redis publish set (bridge shape). */
interface PulsePublishedApp {
  slug: string;
  kind?: 'shop' | 'erp' | 'app';
  storeSlug?: string;
}

/**
 * The PulseCard payload (contract shape). `connected` is Pouls-local metadata
 * (the card treats `pulse === null` as "no shop"; we send explicit zeros +
 * connected:false so the Bureau can render a "connect a shop" nudge without a
 * second request). All five counters are non-negative integers/DZD numbers.
 */
interface AgentPulse {
  connected: boolean;
  ordersToday: number;
  toConfirm: number;
  revenueTodayDzd: number;
  returns: number;
  lowStock: number;
}

// Bridge math helpers, REPLICATED (they are module-private in the bridge; a
// controller cannot import another controller's internals). Byte-identical
// semantics so the pulse counters agree with /erp/summary.

/** Template `num()`: Number(v), non-finite → 0. */
function pulseNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Loose string read for schemaless records: null/undefined → ''. */
function pulseStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** UTC calendar day (the templates + bridge use the same slice). */
function pulseTodayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Template parseDate(): business date — orderedAt || date || createdAt. */
function pulseParseDate(r: PulseRecord): string {
  const raw =
    pulseStr(r.orderedAt) || pulseStr(r.date) || pulseStr(r.createdAt);
  return raw.slice(0, 10) || pulseTodayISO();
}

/** Template orderTotal(): stored total, else Σ item price×qty (qty ?? 1). */
function pulseOrderTotal(o: PulseRecord): number {
  if (o.total != null && Number.isFinite(Number(o.total))) {
    return pulseNum(o.total);
  }
  const items = Array.isArray(o.items) ? (o.items as unknown[]) : [];
  return items.reduce<number>((sum, raw) => {
    const it = (raw ?? {}) as PulseRecord;
    return sum + pulseNum(it.price) * pulseNum(it.qty != null ? it.qty : 1);
  }, 0);
}

// The lastRun projection the FE needs off a run record (thin, stable slice).
interface AgentLastRun {
  runId: string;
  state: string;
  at: number;
}

// One roster row on the wire. R12 widens `id` from the built-in union to any
// string (a custom agent's `cz_` runtime id is opaque) and adds `archetype`
// (the built-in loop it reuses — a built-in's archetype IS its own id) plus the
// optional `name`/`emoji` a custom agent carries. Built-in rows keep their exact
// prior fields (archetype === id, no emoji, name omitted) so an existing FE
// consumer reading id/label/beta/lastRun/channels is byte-unaffected.
interface AgentStatus {
  id: string;
  /** Which built-in loop/tools this agent uses ('hermes'|'openclaw'). */
  archetype: AgentName;
  label: string;
  /** Custom agent's display name (built-ins omit it — `label` is their name). */
  name?: string;
  /** Custom agent's emoji, when set. */
  emoji?: string;
  beta: boolean;
  lastRun?: AgentLastRun;
  channels: { telegram: boolean };
}

// Top-level capability flags returned alongside the roster on GET /api/v1/agents.
// The R7 unified /agents UI keys off these (multi = master switch for the unified
// surface; dzdPer1k feeds the spend "estimé"; the channel flags toggle the
// Telegram/WhatsApp/web affordances). Read from env per-request (same inline
// process.env idiom the bridge controller uses); all default to the OFF value so
// an unset env == feature dark == byte-identical legacy behavior on the client.
interface AgentCaps {
  multi: boolean;
  dzdPer1k: number;
  telegramEnabled: boolean;
  webEnabled: boolean;
  // R8 additions (all default OFF/false ⇒ unset env == feature dark on the
  // client): WhatsApp tool availability (env-only, via Wassila's waCapsEnabled),
  // per-agent memory, and scheduled/webhook triggers. The R7 keys above are kept
  // verbatim so existing FE consumers are unaffected.
  whatsappEnabled: boolean;
  memoryEnabled: boolean;
  triggersEnabled: boolean;
  // R12: whether users can create their OWN named agents (the "Créer un agent"
  // flow on the /agents home). Default OFF ⇒ unset env == the create UI hidden +
  // the roster carries built-ins only (byte-identical legacy behaviour).
  customEnabled: boolean;
  // R14: whether the VPIC image-editor studio tab is available. Default OFF ⇒
  // unset env == the tab hidden (the FE studio registry gates on this flag).
  vpicEnabled: boolean;
}

/**
 * The BudgetBar payload (contract shape). `monthDzd === 0` ⇒ the bar shows
 * usage-only (no hard limit) — that is the default (env unset). `spentDzd` +
 * `tokens` come from the month accumulator Budget writes; `runsToday` /
 * `runsCap` come from the R6 daily counter + the run engine's own cap.
 */
interface AgentBudget {
  monthDzd: number;
  spentDzd: number;
  runsToday: number;
  runsCap: number;
  tokens: number;
}

// Build the caps object from the environment. Pure; no I/O. Kept a tiny helper
// so the exact env expressions live in one place (and the return object stays
// readable). Matches the contract's literal expressions verbatim.
function buildCaps(): AgentCaps {
  return {
    multi: process.env.CDZ_AGENTS_MULTI === '1',
    dzdPer1k: Number(process.env.CDZ_DZD_PER_1K || '0'),
    telegramEnabled: process.env.CDZ_AGENT_TELEGRAM_ENABLED === '1',
    webEnabled: process.env.CDZ_AGENT_WEB_ENABLED === '1',
    // R8: WhatsApp cap is Wassila's env-only predicate (URL+TOKEN pair AND the
    // master WA flag) — a fetch-free read on the caps hot path; false today.
    whatsappEnabled: waCapsEnabled(),
    // R8: memory + triggers gates, same inline process.env idiom; default OFF.
    memoryEnabled: process.env.CDZ_AGENT_MEMORY_ENABLED === '1',
    triggersEnabled: process.env.CDZ_AGENT_TRIGGERS_ENABLED === '1',
    // R12: custom-agents gate (same inline idiom; default OFF). The FE gates the
    // "Créer un agent" flow on this flag.
    customEnabled: CDZ_AGENT_CUSTOM_ENABLED === '1',
    // R14: VPIC image-editor studio gate (same inline process.env idiom; default
    // OFF). The FE studio registry gates the VPIC tab's visibility on this flag.
    vpicEnabled: process.env.CDZ_VPIC_ENABLED === '1',
  };
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

  /** Caller's newest run for one built-in agent → lastRun projection (fail-soft → undefined). */
  private async lastRunFor(
    userId: string,
    agent: AgentName
  ): Promise<AgentLastRun | undefined> {
    return this.lastRunForId(userId, agent);
  }

  /**
   * Caller's newest run for an OPAQUE agent id → lastRun projection (fail-soft →
   * undefined). R12: the run engine keys its per-user+agent zset by the agent
   * STRING (opaque — already works for a custom `cz_` id), so this powers both
   * the built-in rows (via {@link lastRunFor}) and the custom rows. `userId` is
   * always @CurrentUser().id, so a caller only ever sees THEIR own runs.
   */
  private async lastRunForId(
    userId: string,
    agentId: string
  ): Promise<AgentLastRun | undefined> {
    try {
      // listAgentRuns takes the RAW redis first (RunRedis slice); newest entry
      // from the per-user+agent zset (newest-first). Prefer endedAt then startedAt.
      // The `agent` param is opaque to the engine (a Redis key segment), so a
      // custom id is passed through as-is (cast to the AgentName param type).
      const runs = await listAgentRuns(
        this.redis as any,
        userId,
        agentId as AgentName,
        1
      );
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

  // -------------------------------------------------------------------------
  // R11 pulse helpers — a faithful, self-contained REPLICA of the bridge's
  // publish-set read + ERP data read (see the header block above). Everything
  // here is fail-soft; no method throws.
  // -------------------------------------------------------------------------

  /**
   * Read the caller's published-app records from the Redis publish set
   * (clickdz:apps:published:{userId}) — the SAME set + member shape the bridge's
   * readPublishedApps parses. Fail-soft → [] (a read/JSON failure is "no apps").
   * Only the three fields the pulse needs (slug/kind/storeSlug) are projected.
   */
  private async readPublishedAppsForPulse(
    userId: string
  ): Promise<PulsePublishedApp[]> {
    try {
      const raw = await (this.redis as any).smembers(
        `clickdz:apps:published:${userId}`
      );
      if (!Array.isArray(raw)) return [];
      const out: PulsePublishedApp[] = [];
      for (const entry of raw) {
        try {
          const rec = JSON.parse(entry) as PulsePublishedApp;
          if (rec && typeof rec.slug === 'string') {
            const kind =
              rec.kind === 'shop' || rec.kind === 'erp' || rec.kind === 'app'
                ? rec.kind
                : undefined;
            const storeSlug =
              typeof rec.storeSlug === 'string' && rec.storeSlug
                ? rec.storeSlug
                : undefined;
            out.push({
              slug: rec.slug,
              ...(kind ? { kind } : {}),
              ...(storeSlug ? { storeSlug } : {}),
            });
          }
        } catch {
          // ignore a corrupt member (the bridge prunes it on the next write)
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * GET a whole ERP collection server-side, EXACTLY like the bridge's erpList:
   * `${externalBase}/api/v2/apps-data/{dataSlug}/{collection}?limit=500`,
   * Accept: application/json, 15s abort. Returns [] on any failure (unreachable
   * data API, non-2xx, malformed JSON) — the pulse never distinguishes "empty"
   * from "unavailable"; both degrade to zero counters.
   */
  private async pulseErpList(
    dataSlug: string,
    collection: string
  ): Promise<PulseRecord[]> {
    try {
      // SEC-2: carry the per-slug token, like the bridge's erpList and the
      // courier's list helpers now do. This reads `orders`, which the read gate
      // protects — and because this helper swallows every failure into [], an
      // unauthenticated read would not error once the gate is on: it would
      // silently report the merchant's pulse as zero orders and zero revenue,
      // with `connected: true`. A wrong number presented confidently is worse
      // than an error. Harmless while the gate is off (the @Public GET ignores a
      // header it does not need). Never logged.
      const token = dataWriteToken(dataSlug);
      const res = await fetch(
        `${CDZ_ERP_EXTERNAL_BASE}/api/v2/apps-data/${dataSlug}/${collection}?limit=500`,
        {
          headers: {
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: AbortSignal.timeout(PULSE_DATA_TIMEOUT_MS),
        }
      ).catch(() => null);
      if (!res || !res.ok) return [];
      const data = (await res.json().catch(() => null)) as unknown;
      return Array.isArray(data) ? (data as PulseRecord[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Aggregate one shop's `orders` + `products` collections into the PulseCard
   * counters. Pure (given the two arrays). Mirrors /erp/summary math:
   *   ordersToday       count of orders whose business date == today (UTC)
   *   toConfirm         count of 'Nouvelle' orders (awaiting confirmation)
   *   revenueTodayDzd   Σ orderTotal of 'Livrée' orders dated today
   *   returns           count of 'Retournée' orders (all-time)
   *   lowStock          products where reorderAt != null && stock <= reorderAt
   */
  private aggregatePulse(
    orders: PulseRecord[],
    products: PulseRecord[]
  ): Omit<AgentPulse, 'connected'> {
    const today = pulseTodayISO();
    let ordersToday = 0;
    let toConfirm = 0;
    let revenueTodayDzd = 0;
    let returns = 0;
    for (const o of orders) {
      const status = pulseStr(o.status);
      const day = pulseParseDate(o);
      if (day === today) ordersToday += 1;
      if (status === PULSE_STATUS_TO_CONFIRM) toConfirm += 1;
      if (status === PULSE_STATUS_RETURNED) returns += 1;
      if (status === PULSE_STATUS_DELIVERED && day === today) {
        revenueTodayDzd += pulseOrderTotal(o);
      }
    }
    // lowStock uses the `stock` roll-up predicate (byte-identical to the bridge's
    // pre-C4 fallback). We deliberately do NOT fan out the multi-warehouse
    // inventory ledger here — the pulse is a cheap hero read, and the roll-up is
    // kept in sync by the ERP's own upsert path, so this never over/under-counts
    // for a normally-operated shop.
    let lowStock = 0;
    for (const p of products) {
      if (p.reorderAt == null) continue;
      if (pulseNum(p.stock) <= pulseNum(p.reorderAt)) lowStock += 1;
    }
    return {
      ordersToday,
      toConfirm,
      revenueTodayDzd: Math.round(revenueTodayDzd),
      returns,
      lowStock,
    };
  }

  // GET /api/v1/agents — the roster. @CurrentUser, owner-scoped (keyed by
  // user.id): one row per agent with its newest run + Telegram-binding flag.
  // Read-only, fail-soft, never SSE.
  @Get('/api/v1/agents')
  async listAgents(
    @CurrentUser() user: CurrentUser
  ): Promise<{ agents: AgentStatus[]; caps: AgentCaps }> {
    this.assertEnabled();
    // The tg binding is one lookup for the whole user; do it once.
    const telegram = await this.hasTelegram(user.id);
    const agents: AgentStatus[] = [];
    for (const descriptor of AGENTS) {
      const lastRun = await this.lastRunFor(user.id, descriptor.id);
      agents.push({
        id: descriptor.id,
        // A built-in's archetype IS its own id — keeps the row shape uniform
        // with custom rows without changing any existing field.
        archetype: descriptor.id,
        label: descriptor.label,
        beta: descriptor.beta,
        ...(lastRun ? { lastRun } : {}),
        channels: { telegram },
      });
    }
    // R12: append the caller's CUSTOM agents (owner-scoped — listAgentDefs reads
    // clickdz:agentdefs:{user.id}, so ONLY this user's agents appear; a custom id
    // is intrinsically owner-bound). Gated by CDZ_AGENT_CUSTOM_ENABLED: OFF ⇒
    // this block is skipped ⇒ the roster is byte-identical built-ins-only. Each
    // row carries its archetype (loop it reuses), name/emoji, a beta flag, and
    // its newest run keyed by the OPAQUE custom id (listAgentRuns keys by the
    // agent string, which already works for a cz_ id). Fail-soft: a registry
    // read failure degrades to "no custom agents", never a 500.
    if (CDZ_AGENT_CUSTOM_ENABLED === '1') {
      try {
        const defs = await listAgentDefs(this.redis as any, user.id);
        for (const def of defs) {
          const lastRun = await this.lastRunForId(user.id, def.id);
          agents.push({
            id: def.id,
            archetype: def.archetype,
            // `label` mirrors the display name so an FE reading only `label`
            // (like it does for built-ins) still shows the custom agent's name.
            label: def.name,
            name: def.name,
            ...(def.emoji ? { emoji: def.emoji } : {}),
            beta: true,
            ...(lastRun ? { lastRun } : {}),
            channels: { telegram },
          });
        }
      } catch {
        /* fail-soft: a registry read failure is "no custom agents" */
      }
    }
    // Top-level capability flags for the R7 unified /agents UI. Env-derived,
    // gated by the same CDZ_AGENTS_ENABLED master switch as the whole endpoint
    // (assertEnabled above already 404'd if off), so caps only ships when the
    // feature is on; each flag defaults OFF so an unset env == legacy behavior.
    const caps = buildCaps();
    return { agents, caps };
  }

  // GET /api/v1/agents/pulse — the caller's connected shop aggregated into the
  // PulseCard shape (R11, WS11-9). @CurrentUser, owner-scoped. Reads the publish
  // set, picks the FIRST shop/erp app, reads its orders+products the SAME way
  // the bridge does (server-side Data API GET), and returns the five counters.
  // No shop ⇒ {connected:false} + zeros. Gated by CDZ_AGENTS_ENABLED (typed 404
  // when off). FAIL-SOFT: any read error → zeros, never a 500.
  @Get('/api/v1/agents/pulse')
  async getPulse(@CurrentUser() user: CurrentUser): Promise<AgentPulse> {
    this.assertEnabled();
    const zero: AgentPulse = {
      connected: false,
      ordersToday: 0,
      toConfirm: 0,
      revenueTodayDzd: 0,
      returns: 0,
      lowStock: 0,
    };
    try {
      const apps = await this.readPublishedAppsForPulse(user.id);
      // The FIRST shop/erp app (the bridge labels 'app' as a non-ERP build, so
      // only shop/erp carry ERP collections). The DATA slug is storeSlug||slug
      // (the bridge's pairing rule — an ERP app points at its paired shop's
      // datastore via storeSlug).
      const shop = apps.find(a => a.kind === 'shop' || a.kind === 'erp');
      if (!shop) return zero;
      const dataSlug = shop.storeSlug || shop.slug;
      // Two collections in parallel (mirrors the bridge's loadAll fan-out); each
      // resolves to [] on any failure, so a partial data API degrades to zeros.
      const [orders, products] = await Promise.all([
        this.pulseErpList(dataSlug, 'orders'),
        this.pulseErpList(dataSlug, 'products'),
      ]);
      return { connected: true, ...this.aggregatePulse(orders, products) };
    } catch {
      // A pulse read must NEVER 500 — degrade to "connected:false" + zeros.
      return zero;
    }
  }

  // GET /api/v1/agents/budget — the month's spend + today's run count vs the
  // daily cap (R11, WS11-9, BudgetBar). @CurrentUser, owner-scoped. spentDzd +
  // tokens from Budget's month accumulator (readMonthSpend, fail-soft
  // {tokens:0,dzd:0}); runsToday from the R6 daily counter (plain GET, fail-soft
  // 0); monthDzd/runsCap from env (defaults: 0 = usage-only, 50). Gated by
  // CDZ_AGENTS_ENABLED (typed 404 when off). FAIL-SOFT everywhere.
  @Get('/api/v1/agents/budget')
  async getBudget(@CurrentUser() user: CurrentUser): Promise<AgentBudget> {
    this.assertEnabled();
    // Month spend (Budget owns the writer; we read fail-soft). readMonthSpend
    // takes the RAW redis first (RunRedis slice), then the owner id, and returns
    // {tokens,dzd} — a missing key / read failure yields zeros inside it, but we
    // guard here too so a throw can never escape.
    let spend: { tokens: number; dzd: number } = { tokens: 0, dzd: 0 };
    try {
      const s = await readMonthSpend(this.redis as any, user.id);
      if (s && typeof s === 'object') {
        spend = {
          tokens:
            typeof s.tokens === 'number' && Number.isFinite(s.tokens)
              ? s.tokens
              : 0,
          dzd:
            typeof s.dzd === 'number' && Number.isFinite(s.dzd) ? s.dzd : 0,
        };
      }
    } catch {
      spend = { tokens: 0, dzd: 0 };
    }
    // Today's run count — the R6 per-user daily counter (INCR'd by the run
    // engine). Read-only GET; a missing key or read failure is 0 runs.
    let runsToday = 0;
    try {
      const raw = await (this.redis as any).get(
        dailyRunCountKey(user.id, utcDay())
      );
      const n = Number.parseInt(pulseStr(raw), 10);
      runsToday = Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      runsToday = 0;
    }
    // runsCap = the run engine's OWN cap resolver (maxRunsPerDay: env
    // CDZ_AGENT_MAX_RUNS_PER_DAY, default 50) so the bar's denominator matches
    // the value the engine actually enforces (never a drifted second read).
    let runsCap = 50;
    try {
      const cap = maxRunsPerDay();
      runsCap = Number.isFinite(cap) && cap > 0 ? cap : 50;
    } catch {
      runsCap = 50;
    }
    // monthDzd = the soft monthly budget (env, default 0 = usage-only). The bar
    // shows usage without a limit when this is 0 (contract).
    const monthDzd = Number(process.env.CDZ_AGENT_MONTHLY_DZD || 0);
    return {
      monthDzd: Number.isFinite(monthDzd) && monthDzd > 0 ? monthDzd : 0,
      spentDzd: spend.dzd,
      runsToday,
      runsCap,
      tokens: spend.tokens,
    };
  }

  // GET /api/v1/agents/artifacts?agent=&limit= — the caller's "Livrables"
  // library (R10, WS11-6, Musée): every deliverable (file / output / link) a
  // run produced, persisted across runs by the run engine's appendRunEvent
  // (clickdz:agentart:{userId}). @CurrentUser, owner-scoped. Optional `agent`
  // filters the list; optional `limit` caps the row count (server default 60).
  // Gated by the same CDZ_AGENTS_ENABLED master switch (assertEnabled 404s when
  // off). Read-only, fail-soft (a read failure degrades to an empty list).
  @Get('/api/v1/agents/artifacts')
  async listArtifacts(
    @CurrentUser() user: CurrentUser,
    @Query('agent') agentParam?: string,
    @Query('limit') limitParam?: string
  ): Promise<{ artifacts: AgentArtifactRecord[] }> {
    this.assertEnabled();
    // An unknown/absent `agent` query means "all agents" (undefined filter);
    // only a valid known agent narrows the list. Never 400s on a bad filter.
    const agent = normalizeAgent(agentParam) ?? undefined;
    const parsed =
      typeof limitParam === 'string' && limitParam.trim() !== ''
        ? Number.parseInt(limitParam, 10)
        : NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    try {
      // listAgentArtifacts takes the RAW redis first (RunRedis slice), then the
      // owner id, the optional agent filter, and the limit. Fail-soft -> [].
      const artifacts = await listAgentArtifacts(
        this.redis as any,
        user.id,
        agent,
        limit
      );
      return { artifacts: Array.isArray(artifacts) ? artifacts : [] };
    } catch {
      return { artifacts: [] }; // fail-soft: a read failure is "no artifacts"
    }
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

  // =========================================================================
  // R12 — CUSTOM AGENTS CRUD. Users create their OWN named agents (each cloning
  // a built-in archetype) beyond Hermes/OpenClaw. ALL routes are @CurrentUser
  // (ownership intrinsic — every registry read/write is keyed by user.id, so a
  // caller can only ever touch THEIR OWN agents; a non-owned/unknown id resolves
  // to "not found" ⇒ 404, never leaking another user's agent). Gated by
  // CDZ_AGENT_CUSTOM_ENABLED: OFF ⇒ a typed 404 (indistinguishable from the
  // routes not existing), byte-identical to the feature not shipping. The
  // registry is fail-soft; we map its typed error codes to typed AFFiNE errors
  // (BadRequest / NotFound) so the exception filter emits the right status.
  // =========================================================================

  /**
   * Typed 404 when EITHER master gate is off. The custom routes require BOTH the
   * agents surface (CDZ_AGENTS_ENABLED) AND the custom-agents flag
   * (CDZ_AGENT_CUSTOM_ENABLED); off ⇒ a NotFound that never reveals the route.
   */
  private assertCustomEnabled() {
    if (CDZ_AGENTS_ENABLED !== '1' || CDZ_AGENT_CUSTOM_ENABLED !== '1') {
      throw new NotFound('Custom agents are not enabled');
    }
  }

  // POST /api/v1/agents/custom — create a custom agent. @CurrentUser, owner-
  // scoped. Body {archetype:'hermes'|'openclaw', name, emoji?, persona?}. The
  // registry validates + enforces the 20/user cap; a bad body ⇒ BadRequest, the
  // cap ⇒ BadRequest ('custom_agent_limit_reached'), a store failure ⇒
  // BadRequest. Returns the created def.
  @Post('/api/v1/agents/custom')
  async createCustomAgent(
    @CurrentUser() user: CurrentUser,
    @Body() body: unknown
  ): Promise<AgentDef> {
    this.assertCustomEnabled();
    const payload = (body ?? {}) as Record<string, unknown>;
    // createAgentDef is fail-soft (never throws) — it returns a typed error we
    // translate. It reads/writes clickdz:agentdef:{user.id}:{id} + the per-user
    // index, so the agent is created UNDER THIS user and only resolvable by them.
    const result = await createAgentDef(this.redis as any, user.id, {
      archetype: String(payload.archetype ?? ''),
      name: String(payload.name ?? ''),
      emoji: typeof payload.emoji === 'string' ? payload.emoji : undefined,
      persona: typeof payload.persona === 'string' ? payload.persona : undefined,
    });
    if (result.def) return result.def;
    if (result.error === 'cap') {
      throw new BadRequest('custom_agent_limit_reached');
    }
    if (result.error === 'store') {
      throw new BadRequest('could not save the agent, please retry');
    }
    // 'invalid' (or any other) — bad archetype/name/persona/emoji.
    throw new BadRequest(
      'invalid agent: archetype must be hermes|openclaw, name 1..40 chars, persona ≤2000, emoji ≤8'
    );
  }

  // GET /api/v1/agents/custom — list the caller's custom agents (newest first).
  // @CurrentUser, owner-scoped (listAgentDefs reads clickdz:agentdefs:{user.id}
  // ONLY). Fail-soft → []. Gated by CDZ_AGENT_CUSTOM_ENABLED (typed 404 when off).
  @Get('/api/v1/agents/custom')
  async listCustomAgents(
    @CurrentUser() user: CurrentUser
  ): Promise<{ agents: AgentDef[] }> {
    this.assertCustomEnabled();
    try {
      const agents = await listAgentDefs(this.redis as any, user.id);
      return { agents: Array.isArray(agents) ? agents : [] };
    } catch {
      return { agents: [] }; // fail-soft: a read failure is "no custom agents"
    }
  }

  // PATCH /api/v1/agents/custom/:id — edit a custom agent's name/emoji/persona.
  // @CurrentUser, owner-scoped: renameAgentDef only resolves a def under
  // user.id, so a non-owned/unknown id ⇒ 'not_found' ⇒ typed 404 (the isolation
  // gate — a custom id from another user is invisible here). A bad field ⇒
  // BadRequest. Gated by CDZ_AGENT_CUSTOM_ENABLED (typed 404 when off).
  @Patch('/api/v1/agents/custom/:id')
  async updateCustomAgent(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<AgentDef> {
    this.assertCustomEnabled();
    const payload = (body ?? {}) as Record<string, unknown>;
    const patch: {
      name?: string;
      emoji?: string;
      persona?: string;
    } = {};
    // Only forward fields the caller actually sent (so an omitted field is left
    // as-is by the registry; an explicit '' clears emoji/persona there).
    if ('name' in payload) patch.name = String(payload.name ?? '');
    if ('emoji' in payload) patch.emoji = String(payload.emoji ?? '');
    if ('persona' in payload) patch.persona = String(payload.persona ?? '');
    const result = await renameAgentDef(this.redis as any, user.id, id, patch);
    if (result.def) return result.def;
    if (result.error === 'invalid') {
      throw new BadRequest(
        'invalid update: name 1..40 chars, persona ≤2000, emoji ≤8'
      );
    }
    if (result.error === 'store') {
      throw new BadRequest('could not save the agent, please retry');
    }
    // 'not_found' — unknown id OR not owned by this caller (isolation ⇒ 404).
    throw new NotFound(`unknown agent "${id}"`);
  }

  // DELETE /api/v1/agents/custom/:id — delete a custom agent. @CurrentUser,
  // owner-scoped: deleteAgentDef only removes a def under user.id (a non-owned
  // id is a no-op). Idempotent — deleting a missing/unknown/not-owned id returns
  // {deleted:false} rather than an error (a delete need not distinguish "was not
  // there" from "not yours"; both leave the caller with nothing). Gated by
  // CDZ_AGENT_CUSTOM_ENABLED (typed 404 when off).
  @Delete('/api/v1/agents/custom/:id')
  async deleteCustomAgent(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string
  ): Promise<{ deleted: boolean }> {
    this.assertCustomEnabled();
    let deleted = false;
    try {
      deleted = await deleteAgentDef(this.redis as any, user.id, id);
    } catch {
      deleted = false; // fail-soft: a delete failure is reported, never a 500
    }
    return { deleted };
  }

  /**
   * UNLINK an explicit list of keys, re-checking each one.
   *
   * Defence in depth: every key here was built from a per-agent index, so it is
   * already owner-scoped — but each is re-verified to start with `clickdz:agent`
   * and to contain the caller's id before deletion. The cost of a mistake in
   * this Redis DB is a merchant's orders, so the check is worth its microsecond.
   *
   * UNLINK rather than DEL so reclamation happens off Redis's main thread.
   */
  private async unlinkKeys(keys: string[], userId: string): Promise<number> {
    const safe = Array.from(
      new Set(
        keys.filter(k => isResetSafeKey(k, userId))
      )
    );
    if (!safe.length) return 0;
    let removed = 0;
    // Chunked so one command never carries an unbounded argument list.
    for (let i = 0; i < safe.length; i += 100) {
      const chunk = safe.slice(i, i + 100);
      try {
        await this.redis.unlink(...chunk);
        removed += chunk.length;
      } catch {
        /* fail-soft — every one of these keys is TTL'd anyway */
      }
    }
    return removed;
  }

  /**
   * POST /api/v1/agents/:agent/reset — wipe THIS caller's state for ONE agent
   * and return it to its first-run state.
   *
   * Why this route exists: there was no way to reset an agent. Configs are
   * write-only (every PUT forces `provisioned: true`), and runs, memory and
   * artifacts had no delete path at all — so a merchant whose Hermes had
   * accumulated bad state could not start over, and neither could we.
   *
   * Order matters, and it is not the obvious one:
   *
   *  1. CHANNELS FIRST, through the disconnect helpers rather than by deleting
   *     keys. The channel record holds the SEALED bot token, and that token is
   *     what lets us call Telegram's deleteWebhook / the WhatsApp gateway's
   *     deleteInstance. Delete the key first and those external registrations
   *     are orphaned — still pointed at this server, with no way left to
   *     retract them. (Channels are left to the existing disconnect routes; we
   *     deliberately do NOT touch `clickdz:agentchan:*` here, and say so in the
   *     response.)
   *  2. TRIGGERS via `deleteTrigger`, which also ZREMs the caller's members
   *     from the GLOBAL due zset. Deleting the trigger records directly would
   *     leave the sweep firing schedules whose definition no longer exists.
   *  3. Threads and runs by reading each agent's OWN index for ids, never by
   *     globbing. Both families are keyed per-USER with the agent stored inside
   *     the record, so `clickdz:agent:<userId>:*` would take the other agent's
   *     threads too — resetting Hermes would silently wipe OpenClaw.
   *  4. The named per-agent singletons (config, memory, indexes, state flag).
   *
   * NOT touched, deliberately: the shop (`clickdz:appdata:*`), the published-app
   * registry, integration flows, the shared artifacts/spend/daily-counter keys
   * (one per USER across every agent — wiping "just hermes" through those would
   * silently reset OpenClaw's accounting too), and the global due zset itself.
   *
   * Idempotent: resetting an already-clean agent removes nothing and still
   * returns 200. Fail-soft throughout — a partial wipe reports what it did.
   */
  @Post('/api/v1/agents/:agent/reset')
  async resetAgent(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string
  ): Promise<{
    ok: true;
    agent: AgentName;
    keysRemoved: number;
    triggersRemoved: number;
    note: string;
  }> {
    this.assertEnabled();
    const agent = normalizeAgent(agentParam);
    if (!agent) {
      throw new BadRequest('Unknown agent');
    }

    // (2) Triggers — through the helper, so the global due zset stays correct.
    let triggersRemoved = 0;
    try {
      const triggers = await listTriggers(this.redis as any, user.id, agent);
      for (const t of triggers) {
        try {
          await deleteTrigger(this.redis as any, user.id, t.id);
          triggersRemoved += 1;
        } catch {
          /* fail-soft per trigger */
        }
      }
    } catch {
      /* fail-soft: no trigger list ⇒ nothing to prune */
    }

    // (3) THREADS — ids come from this agent's own index, so the other agent's
    // threads (which share the `clickdz:agent:<userId>:` namespace) are never
    // touched.
    const keys: string[] = [];
    try {
      const raw = await this.cache.get<unknown>(
        `clickdz:agent:index:${user.id}:${agent}`
      );
      const threadIds = Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === 'string')
        : [];
      for (const id of threadIds.slice(0, RESET_MAX_IDS)) {
        keys.push(resetThreadKey(user.id, id));
      }
    } catch {
      /* fail-soft: no index ⇒ no threads we can safely identify */
    }

    // (3b) RUNS — same reasoning: the run-id zset is per-agent, the run KEY is
    // per-user, so the index is the only safe source of ids.
    try {
      const runs = await listAgentRuns(
        this.redis as any,
        user.id,
        agent,
        100 // listAgentRuns clamps to 100 internally
      );
      for (const r of runs) {
        keys.push(...resetRunKeys(user.id, r.runId));
      }
    } catch {
      /* fail-soft */
    }

    // (4) The named per-agent singletons.
    keys.push(...resetSingletonKeys(user.id, agent));

    const keysRemoved = await this.unlinkKeys(keys, user.id);

    return {
      ok: true,
      agent,
      keysRemoved,
      triggersRemoved,
      note: 'Channels are not reset here — disconnect them first so their external webhooks are retracted. Your shop data is never touched.',
    };
  }
}
