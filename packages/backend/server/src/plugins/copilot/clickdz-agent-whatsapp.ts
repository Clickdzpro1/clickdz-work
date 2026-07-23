import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, randomBytes } from 'node:crypto';

// Typed AFFiNE errors so the global exception filter emits proper status codes
// (a raw @nestjs/common HttpException becomes a generic 500 here — see
// base/nestjs/exception.ts). NotFound is how every gated-OFF route reports
// "feature disabled" as a clean typed 404 (same stance the sibling agent
// controllers use); BadRequest carries the 'invalid_phone' / provisioning
// rejects on connect. Cache is the @Global JSON-wrapped Redis provider
// (get<T>/set with a PX ttl in MS / delete / expire — fail-soft: undefined/false
// on any error, never throws) — the SAME provider the Telegram channel + Hermes
// controllers use, so all our per-user channel records persist identically.
// JobQueue is the same transport the copilot cron/session providers already
// inject; Moteur's `enqueueAgentRun(queue, rec)` uses it to dispatch the run.
// Throttle rate-caps the routes the same way the telegram / bridge / triggers
// controllers do. ALL value-imported (lint-nest: every ctor-param + decorator
// identifier must resolve at boot — the #73 boot-crash lesson).
import { BadRequest, Cache, JobQueue, NotFound, Throttle } from '../../base';
import { CacheRedis } from '../../base/redis';
// @Public marks the webhook route as skipping the global cookie AuthGuard (an
// inbound gateway webhook has no app session — authenticated SOLELY by the
// x-wa-signature HMAC header, the same non-cookie stance the telegram webhook +
// triggers webhook + bridge /chat/completions + chargily /pay/webhook routes
// take). CurrentUser both decorates (param) + types the cookie-session user on
// the connect/status/disconnect/pair/test routes. Both from core/auth exactly
// like the peers.
import { CurrentUser, Public } from '../../core/auth';
// safeEqual = constant-time string comparison (hashes both sides to a
// fixed-length digest first, so unequal lengths neither throw nor leak length
// through timing). Reused verbatim to gate the webhook HMAC — the SAME primitive
// the telegram webhook uses for its secret_token header, the chargily webhook
// uses for its signature, and cdz-data-token.ts uses for its write/blob/staff
// tokens.
import { safeEqual } from './cdz-data-token';
// Serrure's authenticated secret box (R10 — BYOT). sealSecret before writing a
// per-user gateway webhook secret to Redis, openSecret after reading (null on
// any tamper/format/missing-key — never throws), secretBoxReady gates the whole
// feature alongside the env flag. Zero deps beyond node:crypto; the SAME module
// the Telegram channel seals its bot tokens with.
import { openSecret, sealSecret, secretBoxReady } from './clickdz-secret-box';
// Moteur's run engine (owner: clickdz-agent-runs.ts). We call these by their
// pinned R6 names — REDIS-FIRST for createAgentRun/checkDailyRunCap, QUEUE-FIRST
// for enqueueAgentRun (the R6 telegram bug was calling these object-first). Every
// call is wrapped fail-soft below so a missing / partially-loaded engine can
// never crash the webhook or the tool. The orchestrator merges all R6 files
// together so this static import resolves at boot; the try/catch guards
// behavioural (not link-time) failure. R16 adds 'whatsapp' to RunChannel +
// normalizeChannel so a WA-channel run is tagged/routed exactly like a telegram one.
import {
  checkDailyRunCap,
  createAgentRun,
  enqueueAgentRun,
  onAgentRunDone,
} from './clickdz-agent-runs';
// R12 (custom agents): AgentId is the opaque runtime-id type (built-in name OR an
// owned custom `cz_` id). A per-(user, agent) whatsapp channel is keyed by this id,
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
// CDZ AGENT — WHATSAPP CHANNEL (R16 — per-user BYOT, "Bring Your Own Number").
//
// TWIN of clickdz-agent-telegram.ts, adapted for the Railway whatsapp-gateway's
// per-INSTANCE model + the pair-by-code route. The OLD design (clickdz-wa-client
// + clickdz-wa-webhook.controller) used ONE global gateway instance
// (`CDZ_WA_INSTANCE_ID`), a single global webhook secret, and could not attribute
// an inbound message to a user+agent — so inbound was verify+log only. The NEW
// model mirrors Telegram BYOT exactly:
//
//   · Each user connects THEIR OWN WhatsApp number to a SPECIFIC agent
//     (hermes | openclaw | an owned custom `cz_` id) from the in-app channels card.
//   · `connect` creates a per-(user,agent) gateway INSTANCE server-side (under
//     ClickDz's single server-held tenant apiKey CDZ_WA_TOKEN — NEVER the browser)
//     with an OPAQUE per-connection webhookUrl carrying a random connId, and its
//     own per-instance `webhookSecret` (returned ONCE by the gateway).
//   · That webhook secret is sealed (AES-256-GCM, Serrure) and stored
//     per-(user, agent): `clickdz:agentchan:{userId}:{agent}:whatsapp`.
//   · A connId→{userId,agent} reverse map lets the @Public webhook resolve which
//     user + agent an inbound `message` event belongs to WITHOUT any userId in the
//     URL — exactly Telegram's reverse-map isolation.
//   · The gateway signs every webhook with HMAC-SHA256 over JSON.stringify(envelope)
//     (header `x-wa-signature`, hex). We verify it CONSTANT-TIME against the RAW
//     request bytes (req.rawBody — server.ts bootstraps rawBody:true, see the
//     webhook note) using the per-connection sealed secret.
//   · Inbound text → a detached run for THAT user + THAT agent (Moteur's queue);
//     the final answer is pushed back over THAT user's OWN instance by the
//     run-done hook.
//
// NO shared platform instance. The gateway client is INSTANCE-PARAMETERIZED:
// every send takes the caller's instanceId explicitly. The legacy global
// CDZ_WA_INSTANCE_ID / CDZ_WA_WEBHOOK_SECRET envs are kept as inert no-op
// back-compat (mirror of Telegram's LEGACY_TG_TOKEN) but the per-user store
// ALWAYS wins — nothing in the per-user path reads them.
//
// EVERYTHING is fail-soft dark behind `channelsEnabled()`:
//   channelsEnabled() = CDZ_AGENT_WHATSAPP_ENABLED === '1' && secretBoxReady()
// (secretBoxReady() is false when CDZ_DATA_SECRET is unset ⇒ we cannot seal the
// per-instance secret ⇒ the feature must not provision an instance whose secret
// it can't protect). Off ⇒ every route returns a typed 404 (NotFound),
// byte-identical to the feature not existing; the send tool advertises
// available:false; the run-done push is inert.
//
// No SDK — plain fetch to the gateway REST API (Bearer CDZ_WA_TOKEN), typed
// errors only, never a raw HttpException, imports nothing from the frontend.
// lint-nest: @Controller with three value-imported ctor params (Cache, JobQueue,
// CacheRedis).
// ---------------------------------------------------------------------------

// --- Config (read once at module load, same idiom as the sibling controllers).
// The '1' master gate for the ROUTES. Paired with secretBoxReady() below.
const CDZ_AGENT_WHATSAPP_ENABLED = process.env.CDZ_AGENT_WHATSAPP_ENABLED || '';
// The gateway base URL. Trailing slashes trimmed exactly like the render/wa
// client so `${WA_URL}${path}` never doubles a slash. Server-side only.
const WA_URL = (process.env.CDZ_WA_URL || '').replace(/\/+$/, '');
// The gateway's PER-TENANT api key (returned once by POST /admin/tenants, then
// used to create instances under that tenant) — see clickdz-wa-client.ts's
// header note. Sent as a Bearer token. NEVER reaches the browser: the app IS the
// tenant; the browser only calls these ClickDz backend routes. This STAYS after
// R16 (it is how we create the per-user instances).
const WA_TOKEN = process.env.CDZ_WA_TOKEN || '';
// The app's public origin — the exact env + fallback the bridge/telegram/chargily
// use everywhere they need an absolute, externally-reachable URL (the gateway's
// webhookUrl target). Trailing slash trimmed.
const APP_EXTERNAL_URL = (
  process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
).replace(/\/+$/, '');

// Bounded timeout for every gateway call — quick control-plane calls (create /
// pair / status / send), never a long poll. Matches the wa client + telegram
// client 10s ceiling; guards a hung upstream from taking a request thread.
const WA_TIMEOUT_MS = 10_000;
// WhatsApp text cap — the gateway accepts up to 65536 (routes/messages.ts), but
// we trim to a sane conversational cap so an agent's long finalText is delivered
// (truncated) rather than dumped. Matches the wa client's send-tool intent.
const WA_MAX_TEXT = 4000;

// Pairing-race bound (see connect()). requestPairingCode 409s until the gateway
// instance reaches status='qr'; a freshly-created instance is 'created'→
// 'connecting'→'qr'. Poll GET /instances/:id at this cadence up to this many
// attempts (~10s total) before returning a 'retry' state the FE re-calls (we
// NEVER hard-fail on the race).
const PAIR_POLL_INTERVAL_MS = 800;
const PAIR_POLL_MAX_ATTEMPTS = 12;

// --- Redis key helpers (mirror the R10 Telegram contract namespaces, ':whatsapp').
// Per-user per-agent channel record (the sealed webhook secret + instance id +
// phone). R12: `agent` is the RUNTIME ID (a built-in name OR an owned custom
// `cz_` id); the interpolated key is byte-identical for a built-in and a custom
// agent keys its own channel record FOR FREE.
const chanKey = (userId: string, agent: AgentId) =>
  `clickdz:agentchan:${userId}:${agent}:whatsapp`;
// connId → { userId, agent } — the webhook's opaque-URL reverse lookup.
const connKey = (connId: string) => `clickdz:wa:conn:${connId}`;
// connId → { chatJid } — the "reply-to" chat for a connection (last inbound wins).
const connChatKey = (connId: string) => `clickdz:wa:connchat:${connId}`;

// TTLs (Cache API takes MILLISECONDS). 180d, re-armed on activity so an active
// connection never expires out from under a user — exactly Telegram's window.
const CHAN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** A connection id: 16 hex chars (8 random bytes). Opaque; lives in the URL.
 * SAME minter as the telegram channel (crypto-strong, not Math.random). */
function mintConnId(): string {
  return randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// The per-user per-agent channel record persisted at chanKey. `webhookSecretSealed`
// is the Serrure-sealed per-instance gateway webhook secret (NEVER the plaintext);
// everything else is non-secret connection metadata safe to return to the FE
// EXCEPT the secret (status intentionally omits it).
// ---------------------------------------------------------------------------
export interface WhatsappChannelRecord {
  instanceId: string;
  webhookSecretSealed: string;
  connId: string;
  phoneNumber: string | null;
  status: string;
  connectedAt: number;
  active: boolean;
}

/** connId → owner pointer written alongside the record (webhook reverse map). R12:
 * `agent` is the RUNTIME ID (built-in name OR owned custom `cz_` id). Written at
 * connect time under the AUTHENTICATED owner, so the webhook (which resolves it
 * from the opaque connId + the HMAC gate) can trust it as the run's agent WITHOUT
 * re-validating a path id (there is none on the webhook). */
export interface WhatsappConnRecord {
  userId: string;
  agent: AgentId;
}

// ---------------------------------------------------------------------------
// Minimal WhatsApp gateway control-plane client (fail-soft, TENANT-scoped, but
// every instance op takes an explicit instanceId — there is NO module-level
// "the instance" for the per-user path). Bearer CDZ_WA_TOKEN on CDZ_WA_URL, 10s
// timeout. No throwing: a gateway/network hiccup resolves null/false (callers
// degrade, never 500). One shared stateless instance serves the controller +
// tool + run-done hook, exactly like the telegram client.
// ---------------------------------------------------------------------------
export interface WaInstanceView {
  id: string;
  status: string;
  phoneNumber: string | null;
  webhookSecret?: string | null;
}

export class WhatsappGatewayClient {
  /** True only when the tenant creds are present (URL + tenant token). The
   * per-instance secret box gate is layered on top by channelsEnabled(). */
  get configured(): boolean {
    return !!WA_URL && !!WA_TOKEN;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${WA_TOKEN}`, ...extra };
  }

  /** Raw fetch → parsed JSON body + status, or null on a network/timeout error.
   * NEVER throws. Short-circuits to null with ZERO network traffic when the
   * tenant creds are absent. */
  private async call(
    path: string,
    init: RequestInit
  ): Promise<{ status: number; body: any } | null> {
    if (!this.configured) return null;
    try {
      const res = await fetch(`${WA_URL}${path}`, {
        ...init,
        headers: this.headers(
          (init.headers as Record<string, string>) || undefined
        ),
        signal: AbortSignal.timeout(WA_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as any;
      return { status: res.status, body };
    } catch {
      return null;
    }
  }

  /**
   * Create a per-connection instance under the tenant with an opaque webhookUrl.
   * Returns {id, status, webhookSecret} — webhookSecret is returned ONCE by the
   * gateway (POST /instances 201). null on any failure (caller surfaces a typed
   * 400 and does NOT persist a half-connection).
   */
  async createInstance(
    name: string,
    webhookUrl: string
  ): Promise<WaInstanceView | null> {
    const r = await this.call('/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, webhookUrl }),
    });
    if (!r || (r.status !== 201 && r.status !== 200)) return null;
    const b = r.body || {};
    if (!b.id) return null;
    return {
      id: String(b.id),
      status: typeof b.status === 'string' ? b.status : 'created',
      phoneNumber:
        typeof b.phoneNumber === 'string' ? b.phoneNumber : null,
      // Gateway returns the plaintext secret ONCE here; seal it immediately.
      webhookSecret:
        typeof b.webhookSecret === 'string' ? b.webhookSecret : null,
    };
  }

  /** Live instance view (reflects the running session status). null on failure. */
  async getInstance(instanceId: string): Promise<WaInstanceView | null> {
    if (!instanceId) return null;
    const r = await this.call(`/instances/${instanceId}`, { method: 'GET' });
    if (!r || r.status !== 200) return null;
    const b = r.body || {};
    if (!b.id) return null;
    return {
      id: String(b.id),
      status: typeof b.status === 'string' ? b.status : 'unknown',
      phoneNumber: typeof b.phoneNumber === 'string' ? b.phoneNumber : null,
    };
  }

  /**
   * Request (or re-request) the 8-char pairing code for an instance. The gateway
   * 409s (`requestPairingCode`) until the instance is in status='qr' (see the
   * pairing-race handling in connect()). Returns {code, formatted} on success,
   * or a status-tagged failure so the caller can distinguish "not qr yet"
   * (retry) from a hard error. NEVER throws.
   */
  async pair(
    instanceId: string,
    phoneNumber: string
  ): Promise<{ ok: boolean; status: number; code?: string; formatted?: string }> {
    if (!instanceId) return { ok: false, status: 0 };
    const r = await this.call(`/instances/${instanceId}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber }),
    });
    if (!r) return { ok: false, status: 0 };
    if (r.status !== 200) return { ok: false, status: r.status };
    const b = r.body || {};
    const code = typeof b.code === 'string' ? b.code : undefined;
    const formatted = typeof b.formatted === 'string' ? b.formatted : code;
    if (!code) return { ok: false, status: r.status };
    return { ok: true, status: r.status, code, formatted };
  }

  /** Send a text over a SPECIFIC instance. `to` may be a JID or bare digits (the
   * gateway's resolveChatId handles either). Returns true on the 201 ack. */
  async sendText(
    instanceId: string,
    to: string,
    text: string
  ): Promise<boolean> {
    if (!instanceId || !to) return false;
    const trimmed = String(text ?? '').slice(0, WA_MAX_TEXT);
    if (!trimmed) return false;
    const r = await this.call(`/instances/${instanceId}/messages/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, text: trimmed }),
    });
    return !!r && (r.status === 201 || r.status === 200) && r.body?.ok !== false;
  }

  /** Best-effort logout — invalidates the WhatsApp link. Ignored outcome. */
  async logout(instanceId: string): Promise<void> {
    if (!instanceId) return;
    await this.call(`/instances/${instanceId}/logout`, { method: 'POST' });
  }

  /** Best-effort delete — removes the instance + its data. Ignored outcome. */
  async deleteInstance(instanceId: string): Promise<void> {
    if (!instanceId) return;
    await this.call(`/instances/${instanceId}`, { method: 'DELETE' });
  }
}

// A single shared client instance for the module (controller + tool + hook).
const gateway = new WhatsappGatewayClient();

// ---------------------------------------------------------------------------
// Inbound webhook envelope + message parsing. The gateway signs and posts a
// `WebhookEnvelope` (webhooks/dispatcher.ts):
//   { event, instanceId, tenantId, timestamp, data }
// and for event==='message' the `data` is (whatsapp/session.ts onMessage):
//   { id, chatJid, chatPhone, fromMe, sender, senderPhone, pushName, type, text,
//     timestamp, isGroup, hasMedia }
// We act ONLY on event==='message' && data.fromMe===false && !isGroup && text.
// Defensive: any missing field yields empties and the webhook simply acks 200.
// ---------------------------------------------------------------------------
export interface WaWebhookEnvelope {
  event?: string;
  instanceId?: string;
  tenantId?: string;
  timestamp?: string;
  data?: unknown;
}

export interface ParsedWaMessage {
  chatJid: string | null;
  text: string;
  fromMe: boolean;
  isGroup: boolean;
}

export function parseWaMessage(envelope: WaWebhookEnvelope): ParsedWaMessage {
  const empty: ParsedWaMessage = {
    chatJid: null,
    text: '',
    fromMe: false,
    isGroup: false,
  };
  if (!envelope || envelope.event !== 'message') return empty;
  const data = (envelope.data ?? {}) as Record<string, unknown>;
  const chatJid =
    typeof data.chatJid === 'string' && data.chatJid ? data.chatJid : null;
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  const fromMe = data.fromMe === true;
  const isGroup =
    data.isGroup === true || String(chatJid ?? '').endsWith('@g.us');
  return { chatJid, text, fromMe, isGroup };
}

// ---------------------------------------------------------------------------
// Shared feature gate. Both the env flag AND a usable secret box are required:
// without CDZ_DATA_SECRET we cannot seal the per-instance webhook secret, so we
// must NOT provision an instance — the whole feature stays dark (typed 404).
// Exported so the tool/hook can gate identically. (Note: the tenant creds
// URL/token are checked at call time by the gateway client — a route with the
// flag on but creds absent will surface a typed 'channel_unavailable', not a
// crash.)
// ---------------------------------------------------------------------------
export function channelsEnabled(): boolean {
  return CDZ_AGENT_WHATSAPP_ENABLED === '1' && secretBoxReady();
}

/**
 * Resolve the sending instance for a (userId, agent) connection. Returns the
 * record (with its instanceId) when there is an active connection, else null.
 * Used by BOTH the send tool and the run-done push so an agent can only ever
 * message through the user's OWN instance. Fail-soft, never throws.
 */
async function resolveInstance(
  cache: Cache,
  userId: string,
  agent: AgentId
): Promise<WhatsappChannelRecord | null> {
  if (!userId) return null;
  let rec: WhatsappChannelRecord | undefined;
  try {
    rec = await cache.get<WhatsappChannelRecord>(chanKey(userId, agent));
  } catch {
    rec = undefined;
  }
  if (!rec || !rec.active || !rec.instanceId) return null;
  return rec;
}

// ---------------------------------------------------------------------------
// Controller. All routes gated by channelsEnabled() — off ⇒ typed 404. Register
// ClickDzAgentWhatsappController in the copilot plugin's controller list
// (index.ts) — REPLACES the old ClickDzWaWebhookController.
// ---------------------------------------------------------------------------
@Controller()
export class ClickDzAgentWhatsappController {
  constructor(
    private readonly cache: Cache,
    private readonly jobs: JobQueue,
    private readonly redis: CacheRedis
  ) {
    // R16: wire the run-done push so a completed WhatsApp-channel run sends its
    // final answer back over the run OWNER's own instance. Fail-soft inside;
    // idempotent so re-instantiation never double-registers.
    registerWhatsappRunDone({ cache: this.cache });
  }

  /** Typed 404 when the feature is off — never leaks that the route exists. */
  private assertEnabled(): void {
    if (!channelsEnabled()) {
      throw new NotFound('WhatsApp channel is not enabled');
    }
  }

  // R12 multi-tenant gate for the per-agent channel routes. Custom-agent
  // resolution is behind CDZ_AGENT_CUSTOM_ENABLED: OFF ⇒ ONLY the two built-ins
  // resolve; ON ⇒ an OWNED custom id also resolves. Mirrors the telegram controller.
  private customAgentsEnabled(): boolean {
    return process.env.CDZ_AGENT_CUSTOM_ENABLED === '1';
  }

  /**
   * Resolve + AUTHORIZE the :agent path segment to the channel's RUNTIME ID under
   * this user, or throw a typed NotFound. Returns the runtime id (the built-in
   * name, or the owned custom `cz_` id) — the SAME value that keys the
   * per-(user, agent) channel record. resolveArchetype resolves a built-in with
   * NO Redis touch and returns null for an unknown OR NOT-OWNED id (a def only
   * exists under its owner's userId), so a custom id minted by user Y 404s under
   * user X's session — the isolation invariant. The caller MUST pass
   * @CurrentUser().id, NEVER a path-supplied id. Verbatim mirror of the telegram
   * controller's resolveAgentOr404.
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
  // POST /api/v1/agents/:agent/channels/whatsapp/connect  {phoneNumber}
  //   → { ok, code, formatted, status }
  //
  // The BYOT entry point (twin of telegram connect). Validate the phone (≥8
  // digits incl. country code; the gateway re-validates). If a prior connection
  // exists for this (user, agent), best-effort DELETE the old instance first.
  // Create a fresh gateway instance with an opaque per-connection webhookUrl,
  // SEAL + persist its per-instance webhookSecret (returned once) + the record +
  // the connId→owner reverse map. Then HANDLE THE PAIRING RACE: the gateway 409s
  // requestPairingCode until status='qr', so poll GET /instances/:id (bounded,
  // ~10s) until qr, THEN pair; if still not qr, return status:'retry' (NOT a hard
  // fail) so the FE re-calls .../pair.
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/agents/:agent/channels/whatsapp/connect')
  async connect(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string,
    @Body() body: { phoneNumber?: unknown }
  ): Promise<{
    ok: boolean;
    code?: string;
    formatted?: string;
    status: string;
  }> {
    this.assertEnabled();
    const agent = await this.resolveAgentOr404(user.id, agentParam);
    const phoneNumber = normalizeMsisdn(body?.phoneNumber);
    if (!phoneNumber) {
      throw new BadRequest('invalid_phone');
    }

    // Gateway creds must be present to provision — surface a typed unavailable
    // (not a crash) when the flag is on but the tenant creds are unset.
    if (!gateway.configured) {
      throw new BadRequest('channel_unavailable');
    }

    // (1) If reconnecting, best-effort tear down the OLD instance first so we
    // don't strand a second live socket for this (user, agent). Ignore outcome.
    const prior = await resolveInstance(this.cache, user.id, agent);
    if (prior) {
      try {
        await gateway.logout(prior.instanceId);
        await gateway.deleteInstance(prior.instanceId);
      } catch {
        /* best-effort */
      }
      try {
        if (prior.connId) {
          await this.cache.delete(connKey(prior.connId));
          await this.cache.delete(connChatKey(prior.connId));
        }
      } catch {
        /* best-effort */
      }
    }

    // (2) Mint an opaque connId + build the per-connection webhookUrl, then
    // create the instance under the tenant. The gateway returns the webhookSecret
    // ONCE here — we MUST seal + persist it now (a second read is impossible).
    const connId = mintConnId();
    const webhookUrl = `${APP_EXTERNAL_URL}/api/v1/agents/whatsapp/wh/${connId}`;
    const created = await gateway.createInstance(
      `clickdz:${agent}`,
      webhookUrl
    );
    if (!created || !created.webhookSecret) {
      // No instance, or the gateway didn't return a secret (it only does when a
      // webhookUrl was accepted) ⇒ we cannot verify inbound. Roll back + 400.
      if (created?.id) {
        try {
          await gateway.deleteInstance(created.id);
        } catch {
          /* best-effort */
        }
      }
      throw new BadRequest('provision_failed');
    }

    // (3) Seal the per-instance secret BEFORE persisting. secretBoxReady() gated
    // us in, so a null here is an unexpected transient — roll back the instance.
    const webhookSecretSealed = sealSecret(created.webhookSecret);
    if (!webhookSecretSealed) {
      try {
        await gateway.deleteInstance(created.id);
      } catch {
        /* best-effort */
      }
      throw new BadRequest('channel_unavailable');
    }

    // (4) Persist the record + connId→owner reverse map (both 180d) BEFORE
    // pairing, so an inbound webhook that races the pair call can already resolve.
    const rec: WhatsappChannelRecord = {
      instanceId: created.id,
      webhookSecretSealed,
      connId,
      phoneNumber,
      status: created.status || 'created',
      connectedAt: Date.now(),
      active: true,
    };
    const storedRec = await this.cache.set(chanKey(user.id, agent), rec, {
      ttl: CHAN_TTL_MS,
    });
    const conn: WhatsappConnRecord = { userId: user.id, agent };
    const storedConn = await this.cache.set(connKey(connId), conn, {
      ttl: CHAN_TTL_MS,
    });
    if (!storedRec || !storedConn) {
      // Storage hiccup: roll back the instance so we don't strand an orphan
      // pointing at a connId we didn't persist (Telegram's rollback pattern).
      try {
        await gateway.deleteInstance(created.id);
      } catch {
        /* best-effort */
      }
      throw new BadRequest('channel_unavailable');
    }

    // (5) Pairing race: poll until status='qr', then request the code. If it
    // never reaches qr in the window, return 'retry' — the FE re-calls .../pair.
    const paired = await this.pairWithRetry(created.id, phoneNumber);
    if (paired.ok) {
      return {
        ok: true,
        code: paired.code,
        formatted: paired.formatted,
        status: 'qr',
      };
    }
    // Not qr yet (or a transient) — connection IS persisted; FE re-issues via /pair.
    return { ok: true, status: 'retry' };
  }

  /**
   * Poll GET /instances/:id until status='qr' (bounded), then request the pairing
   * code. Returns {ok:true, code, formatted} on success, or {ok:false} when the
   * instance never reached qr in the window OR pairing 409'd (⇒ caller returns
   * 'retry', never a hard fail). Fail-soft.
   */
  private async pairWithRetry(
    instanceId: string,
    phoneNumber: string
  ): Promise<{ ok: boolean; code?: string; formatted?: string }> {
    for (let attempt = 0; attempt < PAIR_POLL_MAX_ATTEMPTS; attempt++) {
      let status = '';
      const view = await gateway.getInstance(instanceId);
      status = view?.status || '';
      if (status === 'qr') {
        const p = await gateway.pair(instanceId, phoneNumber);
        if (p.ok) return { ok: true, code: p.code, formatted: p.formatted };
        // A 409 here means the status flipped away from qr between the read and
        // the pair — fall through and retry the poll a couple more times.
        if (p.status !== 409) return { ok: false };
      }
      if (status === 'connected' || status === 'logged_out') {
        // Already connected ⇒ no code needed; logged_out ⇒ nothing to pair.
        return { ok: false };
      }
      await sleep(PAIR_POLL_INTERVAL_MS);
    }
    return { ok: false };
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/agents/:agent/channels/whatsapp
  //   → { connected, phoneNumber?, status?, connectedAt? }   (NEVER the secret)
  //
  // Reflects the LIVE gateway status: loads the record, then proxies GET
  // /instances/:id so the FE sees created→connecting→qr→connected transitions.
  // -------------------------------------------------------------------------
  @Throttle('default', { limit: 300, ttl: 60000 })
  @Get('/api/v1/agents/:agent/channels/whatsapp')
  async status(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string
  ): Promise<{
    connected: boolean;
    phoneNumber?: string;
    status?: string;
    connectedAt?: number;
  }> {
    this.assertEnabled();
    const agent = await this.resolveAgentOr404(user.id, agentParam);
    let rec: WhatsappChannelRecord | undefined;
    try {
      rec = await this.cache.get<WhatsappChannelRecord>(
        chanKey(user.id, agent)
      );
    } catch {
      rec = undefined;
    }
    if (!rec || !rec.active) {
      return { connected: false };
    }
    // Reflect the LIVE gateway status (best-effort). A gateway hiccup falls back
    // to the stored status so the card still renders.
    let liveStatus = rec.status;
    let livePhone = rec.phoneNumber;
    const view = await gateway.getInstance(rec.instanceId);
    if (view) {
      liveStatus = view.status || liveStatus;
      if (view.phoneNumber) livePhone = view.phoneNumber;
      // Re-arm the record with the fresh status/phone (best-effort, 180d).
      if (liveStatus !== rec.status || livePhone !== rec.phoneNumber) {
        try {
          await this.cache.set(
            chanKey(user.id, agent),
            { ...rec, status: liveStatus, phoneNumber: livePhone },
            { ttl: CHAN_TTL_MS }
          );
        } catch {
          /* best-effort */
        }
      }
    }
    return {
      connected: liveStatus === 'connected',
      phoneNumber: livePhone ?? undefined,
      status: liveStatus,
      connectedAt: rec.connectedAt,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/agents/:agent/channels/whatsapp/disconnect → { ok }
  //
  // Best-effort logout + delete the gateway instance, then delete BOTH records
  // (channel + connId→owner map) + the reply-to pointer. Idempotent: disconnecting
  // a non-connection still returns { ok:true }.
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/agents/:agent/channels/whatsapp/disconnect')
  async disconnect(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string
  ): Promise<{ ok: boolean }> {
    this.assertEnabled();
    const agent = await this.resolveAgentOr404(user.id, agentParam);
    let rec: WhatsappChannelRecord | undefined;
    try {
      rec = await this.cache.get<WhatsappChannelRecord>(
        chanKey(user.id, agent)
      );
    } catch {
      rec = undefined;
    }
    if (rec) {
      if (rec.instanceId) {
        try {
          await gateway.logout(rec.instanceId);
          await gateway.deleteInstance(rec.instanceId);
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
  // POST /api/v1/agents/:agent/channels/whatsapp/pair → { ok, code?, formatted?, status }
  //
  // Re-issue the pairing code for an EXISTING connection (the re-request-while-qr
  // case + the connect() 'retry' path). Loads the record, runs the same
  // poll-until-qr-then-pair helper. Uses the user's OWN instance. Idempotent.
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/agents/:agent/channels/whatsapp/pair')
  async pair(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string
  ): Promise<{
    ok: boolean;
    code?: string;
    formatted?: string;
    status: string;
  }> {
    this.assertEnabled();
    const agent = await this.resolveAgentOr404(user.id, agentParam);
    const rec = await resolveInstance(this.cache, user.id, agent);
    if (!rec) {
      return { ok: false, status: 'not_connected' };
    }
    if (!rec.phoneNumber) {
      return { ok: false, status: 'no_phone' };
    }
    const paired = await this.pairWithRetry(rec.instanceId, rec.phoneNumber);
    if (paired.ok) {
      return {
        ok: true,
        code: paired.code,
        formatted: paired.formatted,
        status: 'qr',
      };
    }
    // Reflect the live status so the FE can decide (e.g. already connected).
    const view = await gateway.getInstance(rec.instanceId);
    return {
      ok: false,
      status: view?.status === 'connected' ? 'connected' : 'retry',
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/agents/:agent/channels/whatsapp/test → { ok, sent, note? }
  //
  // Send a probe WA message to the CONNECTED number via that instance. If not
  // connected yet, returns sent:false with a note. Uses the user's OWN instance.
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/agents/:agent/channels/whatsapp/test')
  async test(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string
  ): Promise<{ ok: boolean; sent: boolean; note?: string }> {
    this.assertEnabled();
    const agent = await this.resolveAgentOr404(user.id, agentParam);
    const rec = await resolveInstance(this.cache, user.id, agent);
    if (!rec) {
      return { ok: false, sent: false, note: 'not_connected' };
    }
    // The probe target is the connected number itself (the owner's own phone).
    // Prefer the live phone from the gateway; fall back to the stored one.
    const view = await gateway.getInstance(rec.instanceId);
    const status = view?.status || rec.status;
    const phone = (view?.phoneNumber || rec.phoneNumber || '').replace(
      /[^\d]/g,
      ''
    );
    if (status !== 'connected') {
      return {
        ok: true,
        sent: false,
        note: 'Connectez d’abord votre numéro (scannez / entrez le code de liaison).',
      };
    }
    if (!phone) {
      return { ok: true, sent: false, note: 'no_phone' };
    }
    const sent = await gateway.sendText(
      rec.instanceId,
      phone,
      '✅ ClickDz Work est bien connecté à ce numéro WhatsApp.'
    );
    return { ok: true, sent };
  }

  // -------------------------------------------------------------------------
  // WEBHOOK. @Public (no cookie) — authenticated SOLELY by the `x-wa-signature`
  // HMAC header, constant-time compared (safeEqual) to HMAC-SHA256 of the RAW
  // request body under the connId record's per-instance sealed secret. The connId
  // in the URL is OPAQUE (not a secret; the HMAC is). We ALWAYS return 200 {} —
  // even on a bad/unknown connId or a wrong signature — so nothing is leaked and
  // the gateway never retry-storms. @Throttle('strict') like the other @Public
  // routes.
  //
  // rawBody: the gateway signs JSON.stringify(envelope) (webhooks/dispatcher.ts).
  // A re-stringify of the parsed body can differ byte-for-byte (key order /
  // whitespace) and FALSE-REJECT a legit call, so we verify against req.rawBody —
  // the exact bytes, populated because server.ts bootstraps NestFactory with
  // `rawBody: true` (server.ts:31), the SAME field the chargily /pay/webhook uses.
  // No bootstrap change is needed. A verify+log fallback covers a malformed body.
  // -------------------------------------------------------------------------
  @Public()
  @Throttle('strict')
  @Post('/api/v1/agents/whatsapp/wh/:connId')
  async webhook(
    @Param('connId') connId: string,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>
  ): Promise<Record<string, never>> {
    // Feature off ⇒ ack empty (never reveal the route exists / doesn't).
    if (!channelsEnabled()) return {};
    const id = typeof connId === 'string' ? connId.trim() : '';
    if (!id) return {};

    // (1) Resolve the connection owner from the opaque connId.
    let conn: WhatsappConnRecord | undefined;
    try {
      conn = await this.cache.get<WhatsappConnRecord>(connKey(id));
    } catch {
      conn = undefined;
    }
    if (!conn || !conn.userId) return {};
    // R12: the connId is opaque and the owner pointer was written under the
    // AUTHENTICATED user at connect time, so `conn.agent` is the run's RUNTIME ID
    // (a built-in name OR an owned custom `cz_` id). Route it FAITHFULLY — DON'T
    // collapse a custom id to a built-in. Defensive default to 'hermes' only for
    // a legacy/corrupt pointer.
    const agent: AgentId =
      typeof conn.agent === 'string' && conn.agent ? conn.agent : 'hermes';

    // (2) Load the channel record for the resolved (user, agent).
    let rec: WhatsappChannelRecord | undefined;
    try {
      rec = await this.cache.get<WhatsappChannelRecord>(
        chanKey(conn.userId, agent)
      );
    } catch {
      rec = undefined;
    }
    if (!rec || !rec.active || !rec.webhookSecretSealed) return {};

    // (3) THE HARD GATE — constant-time compare the HMAC over the RAW body bytes.
    // Unseal the per-instance secret; a null (tampered/rotated) fails closed.
    const secret = openSecret(rec.webhookSecretSealed);
    if (!secret) return {};
    const rawBuf = req.rawBody;
    // RAW bytes are REQUIRED — a re-stringify of the parsed body can false-reject.
    if (!rawBuf || rawBuf.length === 0) return {};
    const signature = String(req.headers['x-wa-signature'] || '');
    if (!signature || !verifyWaSignature(secret, rawBuf, signature)) {
      // Wrong/absent signature → 200 empty (indistinguishable from a valid ack).
      return {};
    }

    // Authenticated. Parse the envelope from the RAW bytes (so we act on exactly
    // what was signed) — fall back to the framework-parsed body if the raw JSON
    // is somehow unparseable (verify+log fallback for a malformed body).
    let envelope: WaWebhookEnvelope;
    try {
      envelope = JSON.parse(rawBuf.toString('utf8')) as WaWebhookEnvelope;
    } catch {
      envelope = (body ?? {}) as WaWebhookEnvelope;
    }

    // (3b) Defence-in-depth: the URL connId already scoped the owner; also
    // cross-check the signed instanceId matches the record's instance. A mismatch
    // (a replayed/foreign envelope that somehow validated) is dropped.
    if (
      typeof envelope.instanceId === 'string' &&
      envelope.instanceId &&
      rec.instanceId &&
      envelope.instanceId !== rec.instanceId
    ) {
      return {};
    }

    // Only inbound conversational messages drive a run; everything else (qr,
    // instance.ready, connection.update, message.status, ...) is a no-op ack.
    const { chatJid, text, fromMe, isGroup } = parseWaMessage(envelope);
    if (envelope.event !== 'message') return {};
    if (fromMe) return {};
    if (isGroup) return {}; // skip group noise (avoid spurious runs / cap burn)
    if (!chatJid) return {};

    // Re-arm the connection TTLs on inbound activity (best-effort).
    try {
      await this.cache.expire(chanKey(conn.userId, agent), CHAN_TTL_MS);
      await this.cache.expire(connKey(id), CHAN_TTL_MS);
    } catch {
      /* best-effort */
    }

    // Bind the reply-to chat (last inbound wins) so the run-done hook + tool know
    // where to reply. Idempotent + cheap.
    await this.bindChat(id, chatJid);

    // Inbound text → a detached run for THIS user + THIS agent.
    if (text) {
      await this.handleInboundText(conn.userId, agent, chatJid, text, rec);
    }
    return {};
  }

  /**
   * Bind a chat to a connection: set the connection's reply-to chatJid pointer
   * (last inbound wins). 180d. Fail-soft.
   */
  private async bindChat(connId: string, chatJid: string): Promise<void> {
    try {
      await this.cache.set(
        connChatKey(connId),
        { chatJid },
        { ttl: CHAN_TTL_MS }
      );
    } catch {
      /* best-effort */
    }
  }

  /**
   * Turn inbound text into a detached run for (userId, agent): daily-cap check,
   * createAgentRun (REDIS-FIRST — the R6 bug was calling it object-first),
   * enqueue via Moteur (QUEUE-FIRST), then ack over the user's OWN instance.
   * Every engine call is fail-soft (a partial/absent engine degrades to an
   * apology, never a 500). The final answer is pushed later by the run-done hook.
   */
  private async handleInboundText(
    userId: string,
    agent: AgentId,
    chatJid: string,
    text: string,
    rec: WhatsappChannelRecord
  ): Promise<void> {
    let created = false;
    try {
      const cap = await checkDailyRunCap(this.redis as any, userId);
      if (!cap.allowed) {
        await gateway.sendText(
          rec.instanceId,
          chatJid,
          'Limite quotidienne atteinte. Réessayez demain.'
        );
        return;
      }
      // R12: resolve the archetype (loop dispatch) + persona under the OWNER's
      // userId. For a built-in this is a no-Redis short-circuit: archetype ===
      // agent, no persona ⇒ byte-identical.
      const def = await resolveAgentDef(this.redis as any, userId, agent);
      const archetype: AgentName =
        agent === 'openclaw'
          ? 'openclaw'
          : agent === 'hermes'
            ? 'hermes'
            : def?.archetype ?? 'hermes';
      const run = await createAgentRun(this.redis as any, {
        userId,
        agentId: agent,
        archetype,
        persona: def?.persona,
        prompt: text,
        channel: 'whatsapp',
      });
      if (run) {
        await enqueueAgentRun(this.jobs, run);
        created = true;
      }
    } catch {
      created = false;
    }

    await gateway.sendText(
      rec.instanceId,
      chatJid,
      created
        ? '🤖 Je traite votre demande…'
        : 'Agent momentanément indisponible, réessayez dans un instant.'
    );
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers (module-scope so the tool + hook reuse them).
// ---------------------------------------------------------------------------

/** Await ms. Used only by the bounded pairing-race poll. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Validate a caller-supplied phone to bare international DIGITS (≥8, incl. the
 * country code — the gateway re-validates the same way). Strips '+', spaces,
 * dashes, a leading '00' international prefix. Does NOT force a country default
 * (unlike the shop-template normalizePhone) — WhatsApp pairing needs the exact
 * country code the number was registered with. Returns '' for garbage/too-short.
 */
export function normalizeMsisdn(raw: unknown): string {
  let s = String(raw ?? '').replace(/[^\d]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = s.slice(2);
  if (s.length < 8) return '';
  return s;
}

/**
 * Compute the gateway's expected signature over the exact bytes it signed and
 * constant-time compare it to the inbound `x-wa-signature` header. `raw` MUST be
 * the exact request body bytes (Buffer) — the gateway signs
 * JSON.stringify(envelope) (webhooks/dispatcher.ts:signPayload), so a re-serialize
 * can differ byte-for-byte and false-reject. Pure; never throws.
 */
export function verifyWaSignature(
  secret: string,
  raw: Buffer,
  signatureHeader: string
): boolean {
  if (!secret || !raw || !raw.length || !signatureHeader) return false;
  try {
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    return safeEqual(expected, signatureHeader);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// OUTBOUND TOOL — `whatsapp_send` {to, text}. Registered into Regis's default
// registry via this factory (imported fail-soft in buildDefaultRegistry by
// registerWhatsappFailSoft, mirror of the telegram_send wiring). consequential:true
// (it messages a human), scope:'all' (both agents may use it). In BYOT the
// SENDING instance is per-(user, agent): the tool resolves the RUN's user + agent
// from ctx, loads THAT connection's instanceId, and sends to the arg `to` over
// THAT instance — NOT a global CDZ_WA_INSTANCE_ID. available() is true only when
// the feature is enabled; run() does the authoritative "is there a connection"
// check and returns {ok:false} (never throws) when the caller has none.
//
// `deps` mirrors the shape the telegram tool takes: we only need the JSON Cache
// to resolve the channel record (stored via Cache).
// ---------------------------------------------------------------------------
export interface WhatsappToolDeps {
  cache: Cache;
}

// Structural mirror of Regis's AgentToolDef / AgentToolCtx (R6-CONTRACT pinned
// shape). Kept local (not imported) so this file compiles standalone under the
// transpile-only build; Regis's real interface is structurally identical.
interface WaToolCtx {
  userId: string;
  // R12: the run's RUNTIME agent id (a built-in name OR an owned custom `cz_` id).
  agent: AgentId;
  runId?: string;
  threadId?: string;
  signal?: AbortSignal;
  log: (m: string) => void;
  services: { redis: any; config: any };
}
interface WaToolDef {
  name: string;
  description: string;
  scope: 'hermes' | 'openclaw' | 'all';
  consequential: boolean;
  available(ctx: WaToolCtx): boolean;
  inputSummary?: string;
  run(
    args: Record<string, unknown>,
    ctx: WaToolCtx
  ): Promise<{ ok: boolean; result: unknown; preview?: string }>;
}

export function createWhatsappSendTool(deps: WhatsappToolDeps): WaToolDef {
  return {
    name: 'whatsapp_send',
    description:
      "Envoie un message WhatsApp à un numéro (chiffres, format international) via le numéro WhatsApp connecté du propriétaire de cette exécution. À utiliser pour notifier un client ou livrer un résultat.",
    scope: 'all',
    consequential: true,
    inputSummary: '{"to":"213…","text":"…"}',
    // Feature-level gate only (sync). run() does the authoritative per-user
    // connection lookup and fails soft when absent — dark when the user has not
    // connected a WhatsApp number for this agent.
    available: (_ctx: WaToolCtx) => channelsEnabled(),
    run: async (args: Record<string, unknown>, ctx: WaToolCtx) => {
      const to = normalizeMsisdn(args?.to);
      if (!to) {
        return { ok: false, result: { error: 'to is required (phone digits)' } };
      }
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      if (!text) {
        return { ok: false, result: { error: 'text is required' } };
      }
      if (!channelsEnabled()) {
        return { ok: false, result: { error: 'wa_dark' } };
      }
      // R12: resolve the SENDING instance under the run's RUNTIME agent id (pass
      // it through — don't collapse a custom id to a built-in, or the tool would
      // look up the wrong channel record). For a built-in this is byte-identical.
      const agent: AgentId =
        typeof ctx.agent === 'string' && ctx.agent ? ctx.agent : 'hermes';
      const rec = await resolveInstance(deps.cache, ctx.userId, agent);
      if (!rec) {
        ctx.log('whatsapp_send: no whatsapp connection for this user+agent');
        return { ok: false, result: { error: 'no_connection' } };
      }
      const sent = await gateway.sendText(rec.instanceId, to, text);
      return sent
        ? {
            ok: true,
            result: { delivered: true, to },
            preview: `→ ${to}: ${text.slice(0, 180)}`,
          }
        : { ok: false, result: { error: 'send_failed', to } };
    },
  };
}

// ---------------------------------------------------------------------------
// RUN-DONE HOOK. Moteur emits a completion callback via `onAgentRunDone`; we
// register one that, when a WhatsApp-channel run finishes, pushes its finalText
// to the OWNER's bound chat — over the OWNER's OWN instance (resolved per
// (userId, agent) from the channel store). Registered ONCE (idempotent),
// fail-soft: a missing/partial engine (onAgentRunDone absent) is swallowed so
// import can never crash boot, and the callback itself never throws. Twin of
// registerTelegramRunDone.
//
// `rec` is Moteur's run record; we read only the fields the R6 contract pins
// (channel, userId, agent, state, finalText). A JSON Cache handle is needed to
// resolve the connection — registerWhatsappRunDone(deps) is called by the
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
 * Register the WhatsApp completion hook with Moteur (idempotent, fail-soft). Safe
 * to call when the engine is absent — the registration is simply skipped.
 */
export function registerWhatsappRunDone(deps: WhatsappToolDeps): void {
  if (runDoneRegistered) return;
  try {
    if (typeof onAgentRunDone !== 'function') return;
    onAgentRunDone(async (rec: RunDoneRec) => {
      try {
        if (!rec || rec.channel !== 'whatsapp') return;
        if (!rec.userId) return;
        if (!channelsEnabled()) return;
        // R12: the completed run's `agent` is its RUNTIME id. Push the final
        // answer over the OWNER's instance for THAT agent's channel.
        const agent: AgentId =
          typeof rec.agent === 'string' && rec.agent ? rec.agent : 'hermes';
        const chan = await resolveInstance(deps.cache, rec.userId, agent);
        if (!chan) return;
        let chatJid: string | undefined;
        try {
          const bind = await deps.cache.get<{ chatJid?: string }>(
            connChatKey(chan.connId)
          );
          chatJid = bind?.chatJid;
        } catch {
          chatJid = undefined;
        }
        if (!chatJid) return;
        const finalText =
          typeof rec.finalText === 'string' && rec.finalText.trim()
            ? rec.finalText.trim()
            : rec.state === 'failed'
              ? '⚠️ La tâche a échoué.'
              : '✅ Tâche terminée.';
        await gateway.sendText(chan.instanceId, chatJid, finalText);
      } catch {
        // A completion push must never surface — swallow and move on.
      }
    });
    runDoneRegistered = true;
  } catch {
    // onAgentRunDone unavailable / threw on register: leave unregistered.
  }
}
