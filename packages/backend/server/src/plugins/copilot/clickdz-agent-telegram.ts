import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';

// Typed AFFiNE errors so the global exception filter emits proper status codes
// (a raw @nestjs/common HttpException becomes a generic 500 here — see
// base/nestjs/exception.ts). NotFound is how every gated-OFF route reports
// "feature disabled" as a clean typed 404 (same stance the sibling agent
// controllers use); BadRequest carries the 'invalid_token' reject on connect.
// Cache is the @Global JSON-wrapped Redis provider (get<T>/set with a PX ttl in
// MS / delete / expire — fail-soft: undefined/false on any error, never throws)
// — the SAME provider ClickDzHermesController uses for its per-user config, so
// all our per-user channel records persist through it identically. JobQueue is
// the same transport the copilot cron/session providers already inject; Moteur's
// `enqueueAgentRun(queue, rec)` uses it to dispatch the run. Throttle rate-caps
// the routes the same way the bridge / run / triggers controllers do. ALL
// value-imported (lint-nest: every ctor-param + decorator identifier must
// resolve at boot — the #73 boot-crash lesson).
import { BadRequest, Cache, JobQueue, NotFound, Throttle } from '../../base';
import { CacheRedis } from '../../base/redis';
// @Public marks the webhook route as skipping the global cookie AuthGuard (an
// inbound Telegram webhook has no app session — authenticated SOLELY by the
// X-Telegram-Bot-Api-Secret-Token header, same non-cookie stance the triggers
// webhook + bridge /chat/completions routes take). CurrentUser both decorates
// (param) + types the cookie-session user on the connect/status/disconnect/test
// routes. Both from core/auth exactly like the peers.
import { CurrentUser, Public } from '../../core/auth';
// safeEqual = constant-time string comparison (hashes both sides to a
// fixed-length digest first, so unequal lengths neither throw nor leak length
// through timing). Reused verbatim to gate the webhook secret_token header — the
// SAME primitive cdz-data-token.ts uses for its write/blob/staff tokens and the
// triggers webhook uses for its hook secret.
import { safeEqual } from './cdz-data-token';
// Serrure's authenticated secret box (R10 — BYOT). sealSecret before writing a
// per-user bot token to Redis, openSecret after reading (null on any
// tamper/format/missing-key — never throws), secretBoxReady gates the whole
// feature alongside the env flag. Zero deps beyond node:crypto; imported as a
// co-located sibling (the orchestrator lands clickdz-secret-box.ts next to this).
import { openSecret, sealSecret, secretBoxReady } from './clickdz-secret-box';
// Moteur's run engine (owner: clickdz-agent-runs.ts). We call these by their
// pinned R6 names — REDIS-FIRST for createAgentRun/checkDailyRunCap, QUEUE-FIRST
// for enqueueAgentRun (the R6 telegram bug was calling these object-first). Every
// call is wrapped fail-soft below so a missing / partially-loaded engine can
// never crash the webhook or the tool. The orchestrator merges all R6 files
// together so this static import resolves at boot; the try/catch guards
// behavioural (not link-time) failure.
import {
  checkDailyRunCap,
  createAgentRun,
  enqueueAgentRun,
  onAgentRunDone,
} from './clickdz-agent-runs';
// R12 (custom agents): AgentId is the opaque runtime-id type (built-in name OR an
// owned custom `cz_` id). A per-(user, agent) telegram channel is keyed by this id,
// so a custom agent gets its own channel FOR FREE. The channel key segment is an
// opaque string already — widening the type is documentation, not a behaviour change.
import type { AgentId } from './clickdz-agent-runs';
import type { AgentName } from './clickdz-agent-runtime';
// Fonderie's registry owns the multi-tenant gate. resolveArchetype(redis,userId,id)
// → the archetype for a built-in / OWNED custom id, or null (unknown/not-owned ⇒
// 404). resolveAgentDef returns the full def (built-ins → synthetic) so the inbound
// run-create path can thread a custom agent's persona. A custom id resolves ONLY
// under its owner's userId — a request-supplied id is NEVER trusted without this.
// Pure, framework-light, fail-soft (never throw).
import { resolveAgentDef, resolveArchetype } from './clickdz-agent-registry';

// ---------------------------------------------------------------------------
// CDZ AGENT — TELEGRAM CHANNEL (R10 — BYOT, "Bring Your Own Token").
//
// REWRITTEN for the multi-tenant model. The OLD design used ONE global platform
// bot (`CDZ_TG_TOKEN` env), a webhook secret DERIVED from it, and hardcoded every
// inbound message to agent 'hermes' — wrong for a product where each customer
// wants THEIR own bot answering THEIR agent. The NEW model:
//
//   · Each user creates their own bot via @BotFather and connects that token to
//     a SPECIFIC agent (hermes | openclaw) from the in-app channels card.
//   · The token is sealed (AES-256-GCM, Serrure) and stored per-(user, agent):
//     `clickdz:agentchan:{userId}:{agent}:telegram`.
//   · setWebhook points Telegram at an OPAQUE per-connection URL carrying a
//     random connId; the real auth is the `X-Telegram-Bot-Api-Secret-Token`
//     header (constant-time compared to the stored per-connection secretToken).
//   · A connId→{userId,agent} reverse map lets the @Public webhook resolve which
//     user + agent an inbound update belongs to WITHOUT any userId in the URL.
//   · Inbound text → a detached run for THAT user + THAT agent (Moteur's queue);
//     the ack + the final answer are pushed back over THAT user's own bot token.
//
// NO shared platform bot. The TelegramClient is TOKEN-PARAMETERIZED: every method
// takes the caller's token explicitly. A legacy `CDZ_TG_TOKEN` const is still
// read for backward-compat ONLY (see LEGACY_TG_TOKEN) but the per-user store
// ALWAYS wins — nothing in the per-user path depends on it.
//
// EVERYTHING is fail-soft dark behind `channelsEnabled()`:
//   channelsEnabled() = CDZ_AGENT_TELEGRAM_ENABLED === '1' && secretBoxReady()
// (secretBoxReady() is false when CDZ_DATA_SECRET is unset ⇒ we cannot seal
// tokens ⇒ the feature must not accept a token it can't protect). Off ⇒ every
// route returns a typed 404 (NotFound), byte-identical to the feature not
// existing; the send tool advertises available:false; the run-done push is inert.
//
// No SDK — plain fetch to the Bot API, typed errors only, never a raw
// HttpException, imports nothing from the frontend. lint-nest: @Controller with
// three value-imported ctor params (Cache, JobQueue, CacheRedis).
// ---------------------------------------------------------------------------

// --- Config (read once at module load, same idiom as the sibling controllers).
// The '1' master gate for the ROUTES. Paired with secretBoxReady() below.
const CDZ_AGENT_TELEGRAM_ENABLED = process.env.CDZ_AGENT_TELEGRAM_ENABLED || '';
// LEGACY: the OLD single global bot token (CDZ_TG_TOKEN) is deliberately NOT
// read by this module anymore — the per-user BYOT store always wins and new
// deployments leave it unset (no platform bot). A deployment that still sets it
// is harmless; only Hermès' unattended-deferral ping still honors it.
// The app's public origin — the exact env + fallback the bridge/triggers use
// everywhere they need an absolute, externally-reachable URL (setWebhook target).
const APP_EXTERNAL_URL = (
  process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
).replace(/\/+$/, '');

// Bot API base. Interpolated with the caller's token; NEVER logged. Guarded so an
// empty token short-circuits before any URL is built (see the client below).
const TG_API_BASE = 'https://api.telegram.org';
// Bounded timeout for every Bot API call — quick control-plane calls, never a
// long poll. Guards against a hung upstream taking a request thread with it.
const TG_TIMEOUT_MS = 10_000;
// Telegram hard-caps a message at 4096 chars; we trim well inside that so an
// agent's long finalText is delivered (truncated) rather than rejected.
const TG_MAX_TEXT = 3900;

// --- Redis key helpers (EXACTLY the R10 contract namespaces).
// Per-user per-agent channel record (the sealed token + bot identity + conn). R12:
// `agent` is the RUNTIME ID (AgentId — a built-in name OR an owned custom `cz_`
// id); the interpolated key is byte-identical for a built-in and a custom agent
// keys its own channel record FOR FREE (the segment was always an opaque string).
const chanKey = (userId: string, agent: AgentId) =>
  `clickdz:agentchan:${userId}:${agent}:telegram`;
// WS17: exported so the agents roster (hasTelegram) can check the per-agent
// channel record the BYOT model actually writes — the old userTgBindKey is
// never written in BYOT, so the roster always showed channels.telegram:false.
export const tgChanKey = chanKey;
// connId → { userId, agent } — the webhook's opaque-URL reverse lookup.
const connKey = (connId: string) => `clickdz:tg:conn:${connId}`;
// (connId, chatId) → true — a chat bound to a connection (inbound source guard).
const chatBindKey = (connId: string, chatId: string | number) =>
  `clickdz:tg:chat:${connId}:${chatId}`;
// connId → { chatId } — the "reply-to" chat for a connection (last /start wins).
const connChatKey = (connId: string) => `clickdz:tg:connchat:${connId}`;

// TTLs (Cache API takes MILLISECONDS). All 180d, re-armed on activity so an
// active connection never expires out from under a user.
const CHAN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** A connection id: 16 hex chars (8 random bytes). Opaque; lives in the URL. */
function mintConnId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * A per-connection webhook secret: 32 hex chars (16 random bytes). Telegram's
 * `secret_token` charset is A-Z a-z 0-9 _ - (1-256 chars), so hex is valid. This
 * is the ACTUAL webhook auth — sent by Telegram in the
 * X-Telegram-Bot-Api-Secret-Token header on every update and constant-time
 * compared to the stored value.
 */
function mintSecretToken(): string {
  return randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// The per-user per-agent channel record persisted at chanKey. `tokenSealed` is
// the Serrure-sealed bot token (NEVER the plaintext); everything else is
// non-secret bot identity / connection metadata safe to return to the FE EXCEPT
// the token (status intentionally omits it).
// ---------------------------------------------------------------------------
export interface TelegramChannelRecord {
  tokenSealed: string;
  botUsername: string | null;
  botId: number | null;
  connId: string;
  secretToken: string;
  connectedAt: number;
  active: boolean;
}

/** connId → owner pointer written alongside the record (webhook reverse map). R12:
 * `agent` is the RUNTIME ID (AgentId — built-in name OR owned custom `cz_` id). It
 * is written at connect time under the AUTHENTICATED owner, so the webhook (which
 * resolves it from the opaque connId + secret-token gate) can trust it as the run's
 * agent WITHOUT re-validating a path id (there is none on the webhook). */
export interface TelegramConnRecord {
  userId: string;
  agent: AgentId;
}

// ---------------------------------------------------------------------------
// Minimal Telegram Bot API client (fail-soft, TOKEN-PARAMETERIZED). Every method
// takes an explicit `token` — there is NO module-level token dependency for the
// per-user path. An empty/absent token short-circuits to null/false with ZERO
// network traffic. No throwing: a Bot API / network hiccup resolves null/false
// (callers degrade, they never 500). One shared stateless instance serves the
// controller + tool + run-done hook.
// ---------------------------------------------------------------------------
export class TelegramClient {
  /** POST a Bot API method for a SPECIFIC token; resolves `result` or null. */
  private async call<T = any>(
    token: string,
    method: string,
    payload: Record<string, unknown>
  ): Promise<T | null> {
    if (!token) return null;
    try {
      const res = await fetch(`${TG_API_BASE}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TG_TIMEOUT_MS),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: T;
      } | null;
      if (!json || json.ok !== true) return null;
      return (json.result ?? null) as T | null;
    } catch {
      return null;
    }
  }

  /**
   * Validate a token + fetch the bot's identity (getMe). Returns {id, username}
   * on success or null when the token is empty/invalid/unreachable — the connect
   * route maps null to a typed 400 'invalid_token'.
   */
  async getMe(
    token: string
  ): Promise<{ id: number | null; username: string | null } | null> {
    const me = await this.call<{ id?: number; username?: string }>(
      token,
      'getMe',
      {}
    );
    if (!me) return null;
    return {
      id: typeof me.id === 'number' ? me.id : null,
      username: me.username ? String(me.username) : null,
    };
  }

  /**
   * Register `url` as the bot's webhook (setWebhook) with a per-connection
   * `secret_token`, so Telegram echoes that secret in the
   * X-Telegram-Bot-Api-Secret-Token header on every delivered update. Restricts
   * updates to `message`. Returns true when Telegram accepted it. NEVER called at
   * boot — only from the explicit /connect route once the user pastes a token.
   */
  async setWebhook(
    token: string,
    url: string,
    secretToken: string
  ): Promise<boolean> {
    const result = await this.call(token, 'setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message'],
    });
    return !!result;
  }

  /**
   * Remove the bot's webhook (deleteWebhook). Best-effort: used on
   * reconnect/disconnect to detach the old registration. Returns true on success.
   */
  async deleteWebhook(token: string): Promise<boolean> {
    const result = await this.call(token, 'deleteWebhook', {});
    return !!result;
  }

  /** Send a text message to a chat via a SPECIFIC token (auto-trimmed). */
  async sendMessage(
    token: string,
    chatId: string | number,
    text: string
  ): Promise<boolean> {
    if (!token) return false;
    const trimmed = String(text ?? '').slice(0, TG_MAX_TEXT);
    if (!trimmed) return false;
    const result = await this.call(token, 'sendMessage', {
      chat_id: chatId,
      text: trimmed,
      disable_web_page_preview: true,
    });
    return !!result;
  }
}

// A single shared client instance for the module (controller + tool + hook).
const telegram = new TelegramClient();

// ---------------------------------------------------------------------------
// Inbound update parsing. We only care about `message.text` + the chat id; a
// `/start` first token flags the chat-binding handshake. Defensive: any missing
// field yields nulls and the webhook simply acks 200 (Telegram must always get a
// 2xx or it retries the update).
// ---------------------------------------------------------------------------
export interface ParsedUpdate {
  chatId: number | null;
  text: string;
  isStart: boolean;
}

export function parseTelegramUpdate(update: unknown): ParsedUpdate {
  const empty: ParsedUpdate = { chatId: null, text: '', isStart: false };
  if (!update || typeof update !== 'object') return empty;
  const msg = (update as any).message ?? (update as any).edited_message;
  if (!msg || typeof msg !== 'object') return empty;
  const chatId =
    msg.chat && typeof msg.chat.id === 'number' ? (msg.chat.id as number) : null;
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  // `/start` (with or without a payload) is the bind handshake — in BYOT the bot
  // is already known (the user created it), so `/start` just binds THIS chat to
  // THIS connection; no pairing code is needed anymore.
  const isStart = /^\/start(\s|$|@)/.test(text);
  return { chatId, text, isStart };
}

// ---------------------------------------------------------------------------
// Shared feature gate. Both the env flag AND a usable secret box are required:
// without CDZ_DATA_SECRET we cannot seal a user's bot token, so we must NOT
// accept one — the whole feature stays dark (typed 404) rather than storing a
// token we can't protect. Exported so the tool/hook can gate identically.
// ---------------------------------------------------------------------------
export function channelsEnabled(): boolean {
  return CDZ_AGENT_TELEGRAM_ENABLED === '1' && secretBoxReady();
}

/**
 * Resolve + unseal the bot token for a (userId, agent) connection. Returns null
 * when there is no active connection or the seal can't be opened (tampered /
 * key rotated). Used by BOTH the send tool and the run-done push so an agent can
 * only ever message through the user's OWN bot. Fail-soft, never throws.
 */
async function resolveToken(
  cache: Cache,
  userId: string,
  agent: AgentId
): Promise<{ token: string; rec: TelegramChannelRecord } | null> {
  if (!userId) return null;
  let rec: TelegramChannelRecord | undefined;
  try {
    rec = await cache.get<TelegramChannelRecord>(chanKey(userId, agent));
  } catch {
    rec = undefined;
  }
  if (!rec || !rec.active || !rec.tokenSealed) return null;
  const token = openSecret(rec.tokenSealed);
  if (!token) return null;
  return { token, rec };
}

// ---------------------------------------------------------------------------
// Controller. All routes gated by channelsEnabled() — off ⇒ typed 404. The class
// name is UNCHANGED (ClickDzAgentTelegramController) so the copilot plugin's
// controller list needs no edit.
// ---------------------------------------------------------------------------
@Controller()
export class ClickDzAgentTelegramController {
  constructor(
    private readonly cache: Cache,
    private readonly jobs: JobQueue,
    private readonly redis: CacheRedis
  ) {
    // R10 (F-4): wire the run-done push so a completed Telegram-channel run sends
    // its final answer back over the run OWNER's own bot token. Fail-soft inside;
    // idempotent so re-instantiation never double-registers.
    registerTelegramRunDone({ cache: this.cache });
  }

  /** Typed 404 when the feature is off — never leaks that the route exists. */
  private assertEnabled(): void {
    if (!channelsEnabled()) {
      throw new NotFound('Telegram channel is not enabled');
    }
  }

  // R12 multi-tenant gate for the per-agent channel routes. Custom-agent
  // resolution is behind CDZ_AGENT_CUSTOM_ENABLED: OFF ⇒ ONLY the two built-ins
  // resolve, byte-identical to the old sync agentOf (an arbitrary id 404s). ON ⇒ an
  // OWNED custom id (a def exists at clickdz:agentdef:{userId}:{id}) also resolves.
  private customAgentsEnabled(): boolean {
    return process.env.CDZ_AGENT_CUSTOM_ENABLED === '1';
  }

  /**
   * Resolve + AUTHORIZE the :agent path segment to the channel's RUNTIME ID under
   * this user, or throw a typed NotFound. Replaces the old sync `agentOf`. Returns
   * the runtime id (the built-in name, or the owned custom `cz_` id) — the SAME
   * value that keys the per-(user, agent) channel record (for a built-in the id IS
   * its archetype ⇒ byte-identical). resolveArchetype resolves a built-in with NO
   * Redis touch and returns null for an unknown OR NOT-OWNED id (a def only exists
   * under its owner's userId), so a custom id minted by user Y 404s under user X's
   * session — the isolation invariant. Custom resolution is skipped entirely when
   * the flag is off. The caller MUST pass @CurrentUser().id, NEVER a path-supplied id.
   */
  private async resolveAgentOr404(
    userId: string,
    agent: string
  ): Promise<AgentId> {
    const id = typeof agent === 'string' ? agent : '';
    if (id === 'hermes' || id === 'openclaw') return id;
    if (this.customAgentsEnabled()) {
      const archetype = await resolveArchetype(this.redis as any, userId, id);
      if (archetype) return id; // owned custom id — key the channel by the id itself
    }
    throw new NotFound(`unknown agent "${agent}"`);
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/agents/:agent/channels/telegram/connect  {token}
  //   → { ok, botUsername, botId }
  //
  // The BYOT entry point. Validates the pasted BotFather token via getMe (reject
  // 400 'invalid_token' on failure — NEVER echo the token). If a prior connection
  // exists for this (user, agent), best-effort deleteWebhook(oldToken) first so
  // the old bot stops delivering. Mint a fresh connId + secretToken, point the
  // bot's webhook at the opaque per-connection URL with that secret_token, seal
  // the token, and persist the record + the connId→owner reverse map (180d).
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/agents/:agent/channels/telegram/connect')
  async connect(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string,
    @Body() body: { token?: unknown }
  ): Promise<{ ok: boolean; botUsername: string | null; botId: number | null }> {
    this.assertEnabled();
    const agent = await this.resolveAgentOr404(user.id, agentParam);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token) {
      throw new BadRequest('invalid_token');
    }

    // (1) Validate the token + learn the bot identity. null ⇒ bad token.
    const me = await telegram.getMe(token);
    if (!me) {
      throw new BadRequest('invalid_token');
    }

    // (2) Seal BEFORE any external mutation so we never register a webhook we
    // then can't persist a token for. secretBoxReady() gated us in, so a null
    // here is an unexpected transient — treat as a soft failure.
    const tokenSealed = sealSecret(token);
    if (!tokenSealed) {
      throw new BadRequest('channel_unavailable');
    }

    // (3) If reconnecting, detach the OLD webhook first (best-effort, its own
    // token). Ignore the outcome — a dead old token must not block a reconnect.
    const prior = await resolveToken(this.cache, user.id, agent);
    if (prior) {
      try {
        await telegram.deleteWebhook(prior.token);
      } catch {
        /* best-effort */
      }
    }

    // (4) Point the bot at an opaque per-connection URL guarded by secretToken.
    const connId = mintConnId();
    const secretToken = mintSecretToken();
    const webhookUrl = `${APP_EXTERNAL_URL}/api/v1/agents/telegram/wh/${connId}`;
    const hooked = await telegram.setWebhook(token, webhookUrl, secretToken);
    if (!hooked) {
      // Telegram rejected the webhook (unreachable URL, etc.). Do not persist a
      // half-connection — surface a typed 400 the FE can retry.
      throw new BadRequest('webhook_failed');
    }

    // (5) Persist the sealed record + the connId→owner reverse map (both 180d).
    const rec: TelegramChannelRecord = {
      tokenSealed,
      botUsername: me.username,
      botId: me.id,
      connId,
      secretToken,
      connectedAt: Date.now(),
      active: true,
    };
    const storedRec = await this.cache.set(chanKey(user.id, agent), rec, {
      ttl: CHAN_TTL_MS,
    });
    const conn: TelegramConnRecord = { userId: user.id, agent };
    const storedConn = await this.cache.set(connKey(connId), conn, {
      ttl: CHAN_TTL_MS,
    });
    if (!storedRec || !storedConn) {
      // Storage hiccup: roll back the webhook we just set so we don't strand an
      // orphan registration pointing at a connId we didn't persist.
      try {
        await telegram.deleteWebhook(token);
      } catch {
        /* best-effort */
      }
      throw new BadRequest('channel_unavailable');
    }

    return { ok: true, botUsername: me.username, botId: me.id };
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/agents/:agent/channels/telegram
  //   → { connected, botUsername?, connectedAt? }   (NEVER the token)
  // -------------------------------------------------------------------------
  @Throttle('default')
  @Get('/api/v1/agents/:agent/channels/telegram')
  async status(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string
  ): Promise<{
    connected: boolean;
    botUsername?: string;
    connectedAt?: number;
  }> {
    this.assertEnabled();
    const agent = await this.resolveAgentOr404(user.id, agentParam);
    let rec: TelegramChannelRecord | undefined;
    try {
      rec = await this.cache.get<TelegramChannelRecord>(chanKey(user.id, agent));
    } catch {
      rec = undefined;
    }
    if (!rec || !rec.active) {
      return { connected: false };
    }
    // Return ONLY non-secret identity. The sealed token + secretToken NEVER leave
    // the server.
    return {
      connected: true,
      botUsername: rec.botUsername ?? undefined,
      connectedAt: rec.connectedAt,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/agents/:agent/channels/telegram/disconnect → { ok }
  //
  // Best-effort deleteWebhook(token) then delete BOTH records (channel + the
  // connId→owner map) + the reply-to chat pointer. Idempotent: disconnecting a
  // non-connection still returns { ok:true }.
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/agents/:agent/channels/telegram/disconnect')
  async disconnect(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string
  ): Promise<{ ok: boolean }> {
    this.assertEnabled();
    const agent = await this.resolveAgentOr404(user.id, agentParam);
    let rec: TelegramChannelRecord | undefined;
    try {
      rec = await this.cache.get<TelegramChannelRecord>(chanKey(user.id, agent));
    } catch {
      rec = undefined;
    }
    if (rec) {
      // Detach the bot's webhook using its own (unsealed) token, best-effort.
      const token = rec.tokenSealed ? openSecret(rec.tokenSealed) : null;
      if (token) {
        try {
          await telegram.deleteWebhook(token);
        } catch {
          /* best-effort */
        }
      }
      try {
        if (rec.connId) {
          await this.cache.delete(connKey(rec.connId));
          await this.cache.delete(connChatKey(rec.connId));
        }
      } catch {
        /* best-effort */
      }
    }
    try {
      await this.cache.delete(chanKey(user.id, agent));
    } catch {
      /* best-effort */
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/agents/:agent/channels/telegram/test → { ok, sent, note? }
  //
  // Send a probe message to the connection's bound chat (if the user has messaged
  // the bot at least once). If no chat is bound yet, return sent:false with a note
  // telling the user to message their bot first. Uses the user's OWN token.
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/agents/:agent/channels/telegram/test')
  async test(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string
  ): Promise<{ ok: boolean; sent: boolean; note?: string }> {
    this.assertEnabled();
    const agent = await this.resolveAgentOr404(user.id, agentParam);
    const resolved = await resolveToken(this.cache, user.id, agent);
    if (!resolved) {
      return { ok: false, sent: false, note: 'not_connected' };
    }
    let chatId: number | string | undefined;
    try {
      const bind = await this.cache.get<{ chatId?: number | string }>(
        connChatKey(resolved.rec.connId)
      );
      chatId = bind?.chatId;
    } catch {
      chatId = undefined;
    }
    if (chatId == null) {
      return {
        ok: true,
        sent: false,
        note: 'Envoyez d’abord un message à votre bot (ex. /start) pour lier ce chat.',
      };
    }
    const sent = await telegram.sendMessage(
      resolved.token,
      chatId,
      '✅ ClickDz Work est bien connecté à ce bot.'
    );
    return { ok: true, sent };
  }

  // -------------------------------------------------------------------------
  // WEBHOOK. @Public (no cookie) — authenticated SOLELY by the
  // X-Telegram-Bot-Api-Secret-Token header, constant-time compared (safeEqual) to
  // the connId record's stored secretToken. The connId in the URL is OPAQUE (it
  // is not a secret; the header is). We ALWAYS return 200 {} — even on a bad/
  // unknown connId or a wrong secret — so nothing is leaked and Telegram never
  // retry-storms. @Throttle('strict') like the other @Public routes.
  // -------------------------------------------------------------------------
  @Public()
  @Throttle('strict')
  @Post('/api/v1/agents/telegram/wh/:connId')
  async webhook(
    @Param('connId') connId: string,
    @Body() body: unknown,
    @Req() req: Request
  ): Promise<Record<string, never>> {
    // Feature off ⇒ ack empty (never reveal the route exists / doesn't).
    if (!channelsEnabled()) return {};
    const id = typeof connId === 'string' ? connId.trim() : '';
    if (!id) return {};

    // (1) Resolve the connection owner from the opaque connId.
    let conn: TelegramConnRecord | undefined;
    try {
      conn = await this.cache.get<TelegramConnRecord>(connKey(id));
    } catch {
      conn = undefined;
    }
    if (!conn || !conn.userId) return {};
    // R12: the connId is opaque and the owner pointer was written under the
    // AUTHENTICATED user at connect time, so `conn.agent` is the run's RUNTIME ID
    // (a built-in name OR an owned custom `cz_` id). Route it FAITHFULLY — DON'T
    // collapse a custom id to a built-in (that would misroute a custom agent's
    // channel record + run). The webhook's gate is unchanged: it still resolves the
    // owner purely from the opaque connId + the constant-time secret-token compare
    // below — there is NO path :agent to validate here. Defensive default to
    // 'hermes' only for a legacy/corrupt pointer. (Flag OFF ⇒ no `cz_` id is ever
    // stored ⇒ this is byte-identical to the previous coercion.)
    const agent: AgentId =
      typeof conn.agent === 'string' && conn.agent ? conn.agent : 'hermes';

    // (2) Load the channel record for the resolved (user, agent).
    let rec: TelegramChannelRecord | undefined;
    try {
      rec = await this.cache.get<TelegramChannelRecord>(
        chanKey(conn.userId, agent)
      );
    } catch {
      rec = undefined;
    }
    if (!rec || !rec.active || !rec.secretToken) return {};

    // (3) THE HARD GATE — constant-time compare the secret_token header. Telegram
    // sends the exact secret we registered; anyone else guessing the connId does
    // not have it. Header names are lowercased by Node's http parser.
    const headerSecret = String(
      req.headers['x-telegram-bot-api-secret-token'] || ''
    );
    if (!headerSecret || !safeEqual(rec.secretToken, headerSecret)) {
      // Wrong/absent secret → 200 empty (indistinguishable from a valid ack; do
      // not reveal that the connId maps to a real connection).
      return {};
    }

    // Authenticated. Unseal the owner's token once for any outbound replies.
    const token = rec.tokenSealed ? openSecret(rec.tokenSealed) : null;

    const { chatId, text, isStart } = parseTelegramUpdate(body);
    if (chatId == null) return {};

    // Re-arm the connection TTLs on inbound activity so an active user never
    // expires (best-effort).
    try {
      await this.cache.expire(chanKey(conn.userId, agent), CHAN_TTL_MS);
      await this.cache.expire(connKey(id), CHAN_TTL_MS);
    } catch {
      /* best-effort */
    }

    // (4) `/start` (or any first contact) binds THIS chat to THIS connection so
    // the agent knows where to reply. Records the reply-to chat + a per-chat
    // membership marker (both 180d).
    if (isStart) {
      await this.bindChat(id, chatId);
      if (token) {
        await telegram.sendMessage(
          token,
          chatId,
          '✅ Chat lié. Envoyez-moi une tâche et je m’en occupe.'
        );
      }
      return {};
    }

    // (5) Inbound text → a detached run for THIS user + THIS agent.
    if (text) {
      // Ensure this chat is bound (first message might not be /start). Binding is
      // idempotent + cheap; it also sets the reply-to pointer.
      await this.bindChat(id, chatId);
      await this.handleInboundText(conn.userId, agent, id, chatId, text, token);
    }
    return {};
  }

  /**
   * Bind a chat to a connection: mark membership (connId, chatId) and set the
   * connection's reply-to chat pointer (last chat wins). Both 180d. Fail-soft.
   */
  private async bindChat(connId: string, chatId: number): Promise<void> {
    try {
      await this.cache.set(chatBindKey(connId, chatId), true, {
        ttl: CHAN_TTL_MS,
      });
      await this.cache.set(
        connChatKey(connId),
        { chatId },
        { ttl: CHAN_TTL_MS }
      );
    } catch {
      /* best-effort */
    }
  }

  /**
   * Turn inbound text into a detached run for (userId, agent): daily-cap check,
   * createAgentRun (REDIS-FIRST — the R6 bug was calling it object-first),
   * enqueue via Moteur (QUEUE-FIRST), then ack over the user's OWN token. Every
   * engine call is fail-soft (a partial/absent engine degrades to an apology,
   * never a 500). The final answer is pushed later by the run-done hook.
   */
  private async handleInboundText(
    userId: string,
    agent: AgentId,
    connId: string,
    chatId: number,
    text: string,
    token: string | null
  ): Promise<void> {
    let created = false;
    try {
      const cap = await checkDailyRunCap(this.redis as any, userId);
      if (!cap.allowed) {
        if (token) {
          await telegram.sendMessage(
            token,
            chatId,
            'Limite quotidienne atteinte. Réessayez demain.'
          );
        }
        return;
      }
      // R12: resolve the archetype (loop dispatch) + persona under the OWNER's
      // userId (the conn pointer was written by the owner ⇒ intrinsic ownership; a
      // custom def only resolves for its owner). For a built-in agent this is a
      // no-Redis short-circuit: archetype === agent, no persona ⇒ byte-identical.
      const def = await resolveAgentDef(this.redis as any, userId, agent);
      const archetype: AgentName =
        agent === 'openclaw'
          ? 'openclaw'
          : agent === 'hermes'
            ? 'hermes'
            : def?.archetype ?? 'hermes';
      const rec = await createAgentRun(this.redis as any, {
        userId,
        // Key the run by the RUNTIME ID; dispatch its loop by the resolved
        // ARCHETYPE; thread the custom persona (undefined for a built-in).
        agentId: agent,
        archetype,
        persona: def?.persona,
        prompt: text,
        channel: 'telegram',
      });
      if (rec) {
        await enqueueAgentRun(this.jobs, rec);
        created = true;
      }
    } catch {
      created = false;
    }

    if (token) {
      await telegram.sendMessage(
        token,
        chatId,
        created
          ? '🤖 Je traite votre demande…'
          : 'Agent momentanément indisponible, réessayez dans un instant.'
      );
    }
    // Nothing depends on connId here beyond the reply-to binding done by the
    // caller; kept in the signature for symmetry with the record namespace.
    void connId;
  }
}

// ---------------------------------------------------------------------------
// OUTBOUND TOOL — `telegram_send` {text}. Registered into Regis's default
// registry via this factory (imported fail-soft in buildDefaultRegistry).
// consequential:true (it messages a human), scope:'all' (both agents may use it).
// In BYOT the token is per-(user, agent): the tool resolves the RUN's user +
// agent from ctx, unseals THAT connection's token, and messages THAT
// connection's bound chat. available() is true only when the feature is enabled;
// run() does the authoritative "is there a connection + bound chat" check and
// returns {ok:false} (never throws) when the caller has none — so an unconnected
// user never gets a tool that can't work.
//
// `deps` mirrors the shape Regis passes its factories: we only need the JSON
// Cache to resolve the channel record + bound chat (both stored via Cache).
// ---------------------------------------------------------------------------
export interface TelegramToolDeps {
  cache: Cache;
}

// Structural mirror of Regis's AgentToolDef / AgentToolCtx (R6-CONTRACT pinned
// shape). Kept local (not imported) so this file compiles standalone under the
// transpile-only build; Regis's real interface is structurally identical, so the
// returned object satisfies it.
interface TgToolCtx {
  userId: string;
  // R12: the run's RUNTIME agent id (a built-in name OR an owned custom `cz_` id).
  // Widened from the built-in union so the tool resolves the OUTBOUND token under
  // the SAME per-(user, agent) channel key the run's agent is stored at.
  agent: AgentId;
  runId?: string;
  threadId?: string;
  signal?: AbortSignal;
  log: (m: string) => void;
  services: { redis: any; config: any };
}
interface TgToolDef {
  name: string;
  description: string;
  scope: 'hermes' | 'openclaw' | 'all';
  consequential: boolean;
  available(ctx: TgToolCtx): boolean;
  inputSummary?: string;
  run(
    args: Record<string, unknown>,
    ctx: TgToolCtx
  ): Promise<{ ok: boolean; result: unknown; preview?: string }>;
}

export function createTelegramSendTool(deps: TelegramToolDeps): TgToolDef {
  return {
    name: 'telegram_send',
    description:
      "Envoie un message Telegram à l'utilisateur propriétaire de cette exécution (le chat lié à SON bot). À utiliser pour notifier, poser une question, ou livrer un résultat.",
    scope: 'all',
    consequential: true,
    inputSummary: 'text',
    // Feature-level gate only (sync). run() does the authoritative per-user
    // connection + bound-chat lookup and fails soft when absent — dark when the
    // user has not connected a bot for this agent.
    available: (_ctx: TgToolCtx) => channelsEnabled(),
    run: async (args: Record<string, unknown>, ctx: TgToolCtx) => {
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      if (!text) {
        return { ok: false, result: { error: 'text is required' } };
      }
      if (!channelsEnabled()) {
        return { ok: false, result: { error: 'telegram_not_configured' } };
      }
      // R12: resolve the token under the run's RUNTIME agent id (pass it through —
      // don't collapse a custom id to a built-in, or the tool would look up the
      // wrong channel record). For a built-in this is byte-identical.
      const agent: AgentId =
        typeof ctx.agent === 'string' && ctx.agent ? ctx.agent : 'hermes';
      const resolved = await resolveToken(deps.cache, ctx.userId, agent);
      if (!resolved) {
        ctx.log('telegram_send: no telegram connection for this user+agent');
        return { ok: false, result: { error: 'no_connection' } };
      }
      let chatId: number | string | undefined;
      try {
        const bind = await deps.cache.get<{ chatId?: number | string }>(
          connChatKey(resolved.rec.connId)
        );
        chatId = bind?.chatId;
      } catch {
        chatId = undefined;
      }
      if (chatId == null) {
        ctx.log('telegram_send: no bound chat for this connection');
        return { ok: false, result: { error: 'no_bound_chat' } };
      }
      const sent = await telegram.sendMessage(resolved.token, chatId, text);
      return sent
        ? {
            ok: true,
            result: { delivered: true },
            preview: text.slice(0, 200),
          }
        : { ok: false, result: { error: 'send_failed' } };
    },
  };
}

// ---------------------------------------------------------------------------
// RUN-DONE HOOK. Moteur emits a completion callback via `onAgentRunDone`; we
// register one that, when a Telegram-channel run finishes, pushes its finalText
// to the OWNER's bound chat — over the OWNER's OWN bot token (resolved per
// (userId, agent) from the channel store). Registered ONCE (idempotent),
// fail-soft: a missing/partial engine (onAgentRunDone absent) is swallowed so
// import can never crash boot, and the callback itself never throws.
//
// `rec` is Moteur's run record; we read only the fields the R6 contract pins
// (channel, userId, agent, state, finalText). A JSON Cache handle is needed to
// resolve the connection — registerTelegramRunDone(deps) is called by the
// controller ctor with the same Cache the tool uses.
// ---------------------------------------------------------------------------
export interface RunDoneRec {
  runId?: string;
  userId?: string;
  agent?: string;
  channel?: string;
  state?: string;
  finalText?: string;
}

let runDoneRegistered = false;

/**
 * Register the Telegram completion hook with Moteur (idempotent, fail-soft). Safe
 * to call when the engine is absent — the registration is simply skipped.
 */
export function registerTelegramRunDone(deps: TelegramToolDeps): void {
  if (runDoneRegistered) return;
  try {
    if (typeof onAgentRunDone !== 'function') return;
    onAgentRunDone(async (rec: RunDoneRec) => {
      try {
        if (!rec || rec.channel !== 'telegram') return;
        if (!rec.userId) return;
        if (!channelsEnabled()) return;
        // R12: the completed run's `agent` is its RUNTIME id (built-in name OR an
        // owned custom `cz_` id). Push the final answer over the OWNER's bot for
        // THAT agent's channel — pass the id through (a custom run's token is stored
        // under its own id). For a built-in this is byte-identical.
        const agent: AgentId =
          typeof rec.agent === 'string' && rec.agent ? rec.agent : 'hermes';
        const resolved = await resolveToken(deps.cache, rec.userId, agent);
        if (!resolved) return;
        const bind = await deps.cache.get<{ chatId?: number | string }>(
          connChatKey(resolved.rec.connId)
        );
        const chatId = bind?.chatId;
        if (chatId == null) return;
        const finalText =
          typeof rec.finalText === 'string' && rec.finalText.trim()
            ? rec.finalText.trim()
            : rec.state === 'failed'
              ? '⚠️ La tâche a échoué.'
              : '✅ Tâche terminée.';
        await telegram.sendMessage(resolved.token, chatId, finalText);
      } catch {
        // A completion push must never surface — swallow and move on.
      }
    });
    runDoneRegistered = true;
  } catch {
    // onAgentRunDone unavailable / threw on register: leave unregistered.
  }
}

// ---------------------------------------------------------------------------
// LEGACY / DEPRECATED (R10 REMOVED). The OLD global-bot design is gone:
//   · CDZ_TG_TOKEN as a live dependency — replaced by per-user sealed tokens
//     (LEGACY_TG_TOKEN is still READ above for backward-compat but never used on
//     the per-user path; the store always wins).
//   · telegramWebhookSecret() / verifyTelegramSecret() — the sha256(token)-derived
//     URL secret. Replaced by a per-connection random secretToken validated via
//     the X-Telegram-Bot-Api-Secret-Token header (constant-time). REMOVED.
//   · GET  /api/v1/agents/telegram/pair            (one-shot pairing code)
//   · POST /api/v1/agents/telegram/setup           (operator setWebhook)
//   · POST /api/v1/agents/telegram/webhook/:secret  (global-bot inbound)
//     All three REMOVED — superseded by the per-agent connect/status/disconnect/
//     test routes + the per-connection @Public /wh/:connId webhook above. The FE
//     for the old pair/setup flow is retired by Réglage's channel card.
// This block is documentation only (no runtime effect); boot is unaffected.
// ---------------------------------------------------------------------------
