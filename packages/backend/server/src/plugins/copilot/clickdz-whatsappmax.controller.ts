import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

// Typed AFFiNE errors + framework helpers. NotFound = a gated-OFF route (the
// clean typed 404 every ClickDz feature uses when dark). BadRequest carries the
// validation rejects. Cache is the @Global JSON-wrapped Redis provider
// (get<T>/set with a PX ttl in MS / delete — fail-soft, never throws), the SAME
// provider the WhatsApp channel + Telegram controllers use. JobQueue is the
// Moteur run transport (enqueueAgentRun). Throttle rate-caps the routes exactly
// like the sibling controllers. ALL value-imported (lint-nest: every ctor-param
// + decorator identifier must resolve at boot as a VALUE — the #73 lesson).
import { BadRequest, Cache, JobQueue, NotFound, Throttle } from '../../base';
// CacheRedis is the @Global ioredis client the run engine's REDIS-FIRST helpers
// (createAgentRun/checkDailyRunCap) take as their first arg — the SAME client the
// WhatsApp channel controller passes to them. @Global ⇒ no module wiring.
import { CacheRedis } from '../../base/redis';
// @Public exempts the inbound webhook route from the cookie AuthGuard (an inbound
// gateway webhook has no app session — authed SOLELY by the x-wa-signature HMAC).
// CurrentUser decorates + types the session user on the owner-facing routes.
import { CurrentUser, Public } from '../../core/auth';
// Serrure's authenticated secret box (BYOT). sealSecret before writing the
// per-user gateway webhook secret to Redis, openSecret after reading (null on any
// tamper/format/missing-key — never throws), secretBoxReady gates the whole
// feature alongside the env flag (we cannot provision an instance whose secret we
// can't protect). The SAME module the WhatsApp channel seals its secrets with.
import { openSecret, sealSecret, secretBoxReady } from './clickdz-secret-box';
// REUSE the WhatsApp channel's PURE helpers (no controller coupling — these are
// module-scope pure exports of clickdz-agent-whatsapp.ts, imported here without
// touching that file): normalizeMsisdn validates a phone to bare international
// digits; verifyWaSignature constant-time verifies the gateway's HMAC over the
// raw webhook bytes; parseWaMessage + WaWebhookEnvelope shape the inbound event.
import {
  normalizeMsisdn,
  parseWaMessage,
  verifyWaSignature,
  type WaWebhookEnvelope,
} from './clickdz-agent-whatsapp';
// Moteur's run engine (owner: clickdz-agent-runs.ts). The inbound webhook enqueues
// an AI run bound to WhatsappMax's default agent (cdz-flash path), exactly the way
// the WhatsApp channel does. Every call is wrapped fail-soft so a partially-loaded
// engine can never crash the webhook.
import {
  checkDailyRunCap,
  createAgentRun,
  enqueueAgentRun,
} from './clickdz-agent-runs';

// ---------------------------------------------------------------------------
// WS14 — WHATSAPPMAX STUDIO (backend). A thin per-user WhatsApp studio that
// REUSES the existing Railway whatsapp-gateway (CDZ_WA_URL / CDZ_WA_TOKEN) — the
// SAME gateway clickdz-agent-whatsapp.ts already drives. WhatsappMax adds the
// STUDIO surface (QR-pairing panel, send/broadcast, inbox) on top of that gateway
// WITHOUT rebuilding the channel: it provisions a per-user instance under the
// server-held tenant apiKey, seals its per-instance webhookSecret, and proxies the
// gateway's chats/messages endpoints (which the agent-channel controller does not
// expose). Inbound text rides the SAME enqueueAgentRun path for cdz-flash AI
// replies, bound to a default agent (hermes).
//
// It is DELIBERATELY SELF-CONTAINED (its own Redis namespace + its own gateway
// client) so it is purely ADDITIVE — nothing in clickdz-agent-whatsapp.ts is
// edited, and the two features can coexist (a user may have both an agent channel
// and a WhatsappMax studio instance).
//
// FLAG (dark): studioEnabled() = CDZ_WHATSAPPMAX_ENABLED === '1' && secretBoxReady().
// Unset ⇒ every route returns a typed 404 (NotFound), byte-identical to the
// feature not existing. Default OFF.
//
// No SDK — plain fetch to the gateway REST API (Bearer CDZ_WA_TOKEN), typed
// errors only, imports nothing from the frontend. lint-nest: @Controller with two
// value-imported ctor params (Cache, JobQueue).
// ---------------------------------------------------------------------------

// --- Config (read once at module load, same idiom as the sibling controllers).
const CDZ_WHATSAPPMAX_ENABLED = process.env.CDZ_WHATSAPPMAX_ENABLED || '';
// The gateway base URL + tenant token — the SAME envs clickdz-agent-whatsapp.ts
// reads (server-side only; NEVER reaches the browser). Trailing slashes trimmed.
const WA_URL = (process.env.CDZ_WA_URL || '').replace(/\/+$/, '');
const WA_TOKEN = process.env.CDZ_WA_TOKEN || '';
// The app's public origin — the gateway's webhookUrl target (same env + fallback
// the bridge/telegram/whatsapp use). Trailing slash trimmed.
const APP_EXTERNAL_URL = (
  process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
).replace(/\/+$/, '');

// The default agent an inbound WhatsappMax message drives (cdz-flash AI reply
// path). A built-in literal ('hermes') so no custom-agent resolution is needed —
// typed as the literal so it satisfies the run engine's AgentId/AgentName params.
const WHATSAPPMAX_AGENT = 'hermes' as const;

// Bounded timeout for a gateway call — quick control-plane + short reads.
const WA_TIMEOUT_MS = 10_000;
// WhatsApp text cap (the gateway accepts far more; we trim to a sane cap).
const WA_MAX_TEXT = 4000;
// Broadcast fan-out cap per call (respect the gateway's rate-limit/warm-up — a
// merchant with more recipients calls broadcast again).
const BROADCAST_MAX = 50;

// Pairing-race bound: requestPairingCode 409s until status='qr'. Poll GET
// /instances/:id at this cadence up to this many attempts (~10s) before returning
// 'retry' (the FE re-calls /pair). Mirror of the WhatsApp channel's bounds.
const PAIR_POLL_INTERVAL_MS = 800;
const PAIR_POLL_MAX_ATTEMPTS = 12;

// --- Redis key helpers (dedicated WhatsappMax namespace; no overlap with the
// agent channel's clickdz:agentchan:* / clickdz:wa:conn:*).
const maxKey = (userId: string) => `clickdz:wamax:${userId}`;
const maxConnKey = (connId: string) => `clickdz:wamax:conn:${connId}`;
const maxChatKey = (connId: string) => `clickdz:wamax:connchat:${connId}`;

// TTL (Cache API takes MILLISECONDS). 180d, re-armed on activity.
const MAX_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** A connection id: 16 hex chars (8 random bytes). Opaque; lives in the URL. */
function mintConnId(): string {
  // Lazy require keeps this pure module boot-safe; node:crypto is always present.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require('node:crypto');
  return randomBytes(8).toString('hex');
}

/** Await ms (bounded pairing-race poll only). */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The per-user WhatsappMax record. `webhookSecretSealed` is the Serrure-sealed
// per-instance gateway webhook secret (NEVER plaintext); everything else is
// non-secret connection metadata safe to return to the FE EXCEPT the secret.
// ---------------------------------------------------------------------------
export interface WhatsappMaxRecord {
  instanceId: string;
  webhookSecretSealed: string;
  connId: string;
  phoneNumber: string | null;
  status: string;
  connectedAt: number;
  active: boolean;
}

/** connId → owner pointer (webhook reverse map). */
export interface WhatsappMaxConnRecord {
  userId: string;
}

// ---------------------------------------------------------------------------
// WhatsappMax gateway client — a dedicated fail-soft client over the SAME gateway
// (Bearer CDZ_WA_TOKEN on CDZ_WA_URL, 10s timeout). Extends the agent-channel
// client's control-plane surface (create/get/pair/sendText/logout/delete) with
// the READ surface WhatsappMax needs (chats + messages) that the channel client
// does not expose. NEVER throws: a gateway/network hiccup resolves null/false.
// ---------------------------------------------------------------------------
export interface MaxInstanceView {
  id: string;
  status: string;
  phoneNumber: string | null;
  webhookSecret?: string | null;
}

class WhatsappMaxGatewayClient {
  get configured(): boolean {
    return !!WA_URL && !!WA_TOKEN;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${WA_TOKEN}`, ...extra };
  }

  /** Raw fetch → { status, body }, or null on a network/timeout error. NEVER
   * throws. Short-circuits to null (zero traffic) when the tenant creds are
   * absent. NEVER log `init.headers` (they carry the tenant token). */
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

  /** Create a per-connection instance with an opaque webhookUrl. The gateway
   * returns webhookSecret ONCE (201). null on any failure. */
  async createInstance(
    name: string,
    webhookUrl: string
  ): Promise<MaxInstanceView | null> {
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
      phoneNumber: typeof b.phoneNumber === 'string' ? b.phoneNumber : null,
      webhookSecret:
        typeof b.webhookSecret === 'string' ? b.webhookSecret : null,
    };
  }

  /** Live instance view. null on failure. */
  async getInstance(instanceId: string): Promise<MaxInstanceView | null> {
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

  /** Request the pairing code for an instance (409 until status='qr'). */
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

  /** Fetch the QR payload for an instance (JSON). null on failure. */
  async getQr(instanceId: string): Promise<{ qr?: string } | null> {
    if (!instanceId) return null;
    const r = await this.call(`/instances/${instanceId}/qr`, { method: 'GET' });
    if (!r || r.status !== 200) return null;
    const b = r.body || {};
    const qr = typeof b.qr === 'string' ? b.qr : undefined;
    return { qr };
  }

  /** Send a text over a specific instance. Returns true on the 201 ack. */
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

  /** Proxy GET /instances/:id/chats → the chat list. [] on failure. */
  async listChats(instanceId: string): Promise<any[]> {
    if (!instanceId) return [];
    const r = await this.call(`/instances/${instanceId}/chats`, {
      method: 'GET',
    });
    if (!r || r.status !== 200) return [];
    const b = r.body || {};
    if (Array.isArray(b)) return b;
    if (Array.isArray(b.chats)) return b.chats;
    return [];
  }

  /** Proxy GET /instances/:id/messages?chatJid&limit → stored inbox. [] on failure. */
  async listMessages(
    instanceId: string,
    chatJid: string,
    limit: number
  ): Promise<any[]> {
    if (!instanceId) return [];
    const params = new URLSearchParams();
    if (chatJid) params.set('chatJid', chatJid);
    params.set('limit', String(Math.max(1, Math.min(200, limit || 50))));
    const r = await this.call(
      `/instances/${instanceId}/messages?${params.toString()}`,
      { method: 'GET' }
    );
    if (!r || r.status !== 200) return [];
    const b = r.body || {};
    if (Array.isArray(b)) return b;
    if (Array.isArray(b.messages)) return b.messages;
    return [];
  }

  /** Best-effort logout. */
  async logout(instanceId: string): Promise<void> {
    if (!instanceId) return;
    await this.call(`/instances/${instanceId}/logout`, { method: 'POST' });
  }

  /** Best-effort delete. */
  async deleteInstance(instanceId: string): Promise<void> {
    if (!instanceId) return;
    await this.call(`/instances/${instanceId}`, { method: 'DELETE' });
  }
}

// A single shared client instance for the module.
const gateway = new WhatsappMaxGatewayClient();

/**
 * Shared feature gate. Both the env flag AND a usable secret box are required
 * (we seal the per-instance webhook secret). Off ⇒ every route 404s. Exported
 * so a future tool/hook can gate identically.
 */
export function studioEnabled(): boolean {
  return CDZ_WHATSAPPMAX_ENABLED === '1' && secretBoxReady();
}

// ---------------------------------------------------------------------------
// Controller. All owner routes gated by studioEnabled() — off ⇒ typed 404.
// Register ClickDzWhatsappMaxController in the copilot plugin's controller list.
// ---------------------------------------------------------------------------
@Controller()
export class ClickDzWhatsappMaxController {
  constructor(
    private readonly cache: Cache,
    private readonly jobs: JobQueue,
    private readonly redis: CacheRedis
  ) {}

  /** Typed 404 when the feature is off — never leaks that the route exists. */
  private assertEnabled(): void {
    if (!studioEnabled()) {
      throw new NotFound('WhatsappMax studio is not enabled');
    }
  }

  /** Load the caller's WhatsappMax record (fail-soft). */
  private async loadRecord(userId: string): Promise<WhatsappMaxRecord | null> {
    try {
      const rec = await this.cache.get<WhatsappMaxRecord>(maxKey(userId));
      return rec && rec.instanceId ? rec : null;
    } catch {
      return null;
    }
  }

  // =========================================================================
  // GET /api/v1/whatsappmax/status
  //   → { connected, phoneNumber?, status?, connectedAt? }   (NEVER the secret)
  //   Reflects the LIVE gateway status (created→connecting→qr→connected).
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/status')
  async status(@CurrentUser() user: CurrentUser): Promise<{
    connected: boolean;
    phoneNumber?: string;
    status?: string;
    connectedAt?: number;
  }> {
    this.assertEnabled();
    const rec = await this.loadRecord(user.id);
    if (!rec || !rec.active) {
      return { connected: false };
    }
    let liveStatus = rec.status;
    let livePhone = rec.phoneNumber;
    const view = await gateway.getInstance(rec.instanceId);
    if (view) {
      liveStatus = view.status || liveStatus;
      if (view.phoneNumber) livePhone = view.phoneNumber;
      if (liveStatus !== rec.status || livePhone !== rec.phoneNumber) {
        try {
          await this.cache.set(
            maxKey(user.id),
            { ...rec, status: liveStatus, phoneNumber: livePhone },
            { ttl: MAX_TTL_MS }
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

  // =========================================================================
  // POST /api/v1/whatsappmax/connect  { phoneNumber }
  //   → { ok, code?, formatted?, qr?, status }
  //
  // Provision a per-user gateway instance with an opaque per-connection webhookUrl,
  // seal + persist its per-instance webhookSecret (returned once) + the record +
  // the connId→owner reverse map, then handle the pairing race (poll until qr,
  // then request the pairing code). Reconnect tears down the old instance first.
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/connect')
  async connect(
    @CurrentUser() user: CurrentUser,
    @Body() body: { phoneNumber?: unknown }
  ): Promise<{
    ok: boolean;
    code?: string;
    formatted?: string;
    qr?: string;
    status: string;
  }> {
    this.assertEnabled();
    const phoneNumber = normalizeMsisdn(body?.phoneNumber);
    if (!phoneNumber) {
      throw new BadRequest('invalid_phone');
    }
    if (!gateway.configured) {
      throw new BadRequest('studio_unavailable');
    }

    // (1) Tear down a prior instance (reconnect) so we don't strand a socket.
    const prior = await this.loadRecord(user.id);
    if (prior) {
      try {
        await gateway.logout(prior.instanceId);
        await gateway.deleteInstance(prior.instanceId);
      } catch {
        /* best-effort */
      }
      try {
        if (prior.connId) {
          await this.cache.delete(maxConnKey(prior.connId));
          await this.cache.delete(maxChatKey(prior.connId));
        }
      } catch {
        /* best-effort */
      }
    }

    // (2) Mint an opaque connId + create the instance under the tenant.
    const connId = mintConnId();
    const webhookUrl = `${APP_EXTERNAL_URL}/api/v1/whatsappmax/wh/${connId}`;
    const created = await gateway.createInstance('clickdz:whatsappmax', webhookUrl);
    if (!created || !created.webhookSecret) {
      if (created?.id) {
        try {
          await gateway.deleteInstance(created.id);
        } catch {
          /* best-effort */
        }
      }
      throw new BadRequest('provision_failed');
    }

    // (3) Seal the per-instance secret BEFORE persisting.
    const webhookSecretSealed = sealSecret(created.webhookSecret);
    if (!webhookSecretSealed) {
      try {
        await gateway.deleteInstance(created.id);
      } catch {
        /* best-effort */
      }
      throw new BadRequest('studio_unavailable');
    }

    // (4) Persist the record + connId→owner reverse map (both 180d).
    const rec: WhatsappMaxRecord = {
      instanceId: created.id,
      webhookSecretSealed,
      connId,
      phoneNumber,
      status: created.status || 'created',
      connectedAt: Date.now(),
      active: true,
    };
    const storedRec = await this.cache.set(maxKey(user.id), rec, {
      ttl: MAX_TTL_MS,
    });
    const conn: WhatsappMaxConnRecord = { userId: user.id };
    const storedConn = await this.cache.set(maxConnKey(connId), conn, {
      ttl: MAX_TTL_MS,
    });
    if (!storedRec || !storedConn) {
      try {
        await gateway.deleteInstance(created.id);
      } catch {
        /* best-effort */
      }
      throw new BadRequest('studio_unavailable');
    }

    // (5) Pairing race: poll until qr, then request the code + best-effort the QR.
    const paired = await this.pairWithRetry(created.id, phoneNumber);
    if (paired.ok) {
      const qr = await gateway.getQr(created.id);
      return {
        ok: true,
        code: paired.code,
        formatted: paired.formatted,
        ...(qr?.qr ? { qr: qr.qr } : {}),
        status: 'qr',
      };
    }
    return { ok: true, status: 'retry' };
  }

  /** Poll GET /instances/:id until status='qr' (bounded), then request the code.
   * Fail-soft — never a hard fail (the FE re-calls /pair on 'retry'). */
  private async pairWithRetry(
    instanceId: string,
    phoneNumber: string
  ): Promise<{ ok: boolean; code?: string; formatted?: string }> {
    for (let attempt = 0; attempt < PAIR_POLL_MAX_ATTEMPTS; attempt++) {
      const view = await gateway.getInstance(instanceId);
      const status = view?.status || '';
      if (status === 'qr') {
        const p = await gateway.pair(instanceId, phoneNumber);
        if (p.ok) return { ok: true, code: p.code, formatted: p.formatted };
        if (p.status !== 409) return { ok: false };
      }
      if (status === 'connected' || status === 'logged_out') {
        return { ok: false };
      }
      await sleep(PAIR_POLL_INTERVAL_MS);
    }
    return { ok: false };
  }

  // =========================================================================
  // POST /api/v1/whatsappmax/pair → { ok, code?, formatted?, qr?, status }
  //   Re-issue the pairing code for the existing connection (the 'retry' path).
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/pair')
  async pair(@CurrentUser() user: CurrentUser): Promise<{
    ok: boolean;
    code?: string;
    formatted?: string;
    qr?: string;
    status: string;
  }> {
    this.assertEnabled();
    const rec = await this.loadRecord(user.id);
    if (!rec) return { ok: false, status: 'not_connected' };
    if (!rec.phoneNumber) return { ok: false, status: 'no_phone' };
    const paired = await this.pairWithRetry(rec.instanceId, rec.phoneNumber);
    if (paired.ok) {
      const qr = await gateway.getQr(rec.instanceId);
      return {
        ok: true,
        code: paired.code,
        formatted: paired.formatted,
        ...(qr?.qr ? { qr: qr.qr } : {}),
        status: 'qr',
      };
    }
    const view = await gateway.getInstance(rec.instanceId);
    return {
      ok: false,
      status: view?.status === 'connected' ? 'connected' : 'retry',
    };
  }

  // =========================================================================
  // POST /api/v1/whatsappmax/disconnect → { ok }
  //   Best-effort logout + delete the instance, then delete the records.
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/disconnect')
  async disconnect(
    @CurrentUser() user: CurrentUser
  ): Promise<{ ok: boolean }> {
    this.assertEnabled();
    const rec = await this.loadRecord(user.id);
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
          await this.cache.delete(maxConnKey(rec.connId));
          await this.cache.delete(maxChatKey(rec.connId));
        }
      } catch {
        /* best-effort */
      }
    }
    try {
      await this.cache.delete(maxKey(user.id));
    } catch {
      /* best-effort */
    }
    return { ok: true };
  }

  // =========================================================================
  // POST /api/v1/whatsappmax/send  { to, text } → { ok, sent }
  //   Send a single text over the user's OWN instance.
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/send')
  async send(
    @CurrentUser() user: CurrentUser,
    @Body() body: { to?: unknown; text?: unknown }
  ): Promise<{ ok: boolean; sent: boolean; note?: string }> {
    this.assertEnabled();
    const to = normalizeMsisdn(body?.to);
    if (!to) throw new BadRequest('invalid_to');
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) throw new BadRequest('text is required');
    const rec = await this.loadRecord(user.id);
    if (!rec || !rec.active) {
      return { ok: true, sent: false, note: 'not_connected' };
    }
    const sent = await gateway.sendText(rec.instanceId, to, text);
    return { ok: true, sent };
  }

  // =========================================================================
  // POST /api/v1/whatsappmax/broadcast  { to: string[], text } → { ok, sent, failed }
  //   Iterate recipients honoring the gateway's own rate-limit/warm-up (the
  //   gateway paces sends per its SEND_MIN/MAX_DELAY_MS + WARMUP settings; we cap
  //   the fan-out per call and let the gateway pace). Bounded (≤ BROADCAST_MAX).
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/broadcast')
  async broadcast(
    @CurrentUser() user: CurrentUser,
    @Body() body: { to?: unknown; text?: unknown }
  ): Promise<{ ok: boolean; sent: number; failed: number; total: number }> {
    this.assertEnabled();
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) throw new BadRequest('text is required');
    const rawTo = Array.isArray(body?.to) ? (body.to as unknown[]) : [];
    // Normalize + dedupe + cap the recipient list.
    const seen = new Set<string>();
    const recipients: string[] = [];
    for (const raw of rawTo) {
      const n = normalizeMsisdn(raw);
      if (n && !seen.has(n)) {
        seen.add(n);
        recipients.push(n);
        if (recipients.length >= BROADCAST_MAX) break;
      }
    }
    if (!recipients.length) throw new BadRequest('to must be a non-empty list of phone numbers');
    const rec = await this.loadRecord(user.id);
    if (!rec || !rec.active) {
      throw new BadRequest('not_connected');
    }
    let sent = 0;
    let failed = 0;
    for (const to of recipients) {
      const ok = await gateway.sendText(rec.instanceId, to, text);
      if (ok) sent++;
      else failed++;
    }
    return { ok: true, sent, failed, total: recipients.length };
  }

  // =========================================================================
  // GET /api/v1/whatsappmax/chats → { chats: [...] }
  //   Proxy the gateway chat list for the user's own instance.
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/chats')
  async chats(
    @CurrentUser() user: CurrentUser
  ): Promise<{ chats: unknown[] }> {
    this.assertEnabled();
    const rec = await this.loadRecord(user.id);
    if (!rec || !rec.active) return { chats: [] };
    const chats = await gateway.listChats(rec.instanceId);
    return { chats };
  }

  // =========================================================================
  // GET /api/v1/whatsappmax/messages?chatJid=&limit= → { messages: [...] }
  //   Proxy the gateway stored-inbox for a chat on the user's own instance.
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/messages')
  async messages(
    @CurrentUser() user: CurrentUser,
    @Query('chatJid') chatJidRaw: string,
    @Query('limit') limitRaw: string
  ): Promise<{ messages: unknown[] }> {
    this.assertEnabled();
    const chatJid = typeof chatJidRaw === 'string' ? chatJidRaw.trim() : '';
    const limit = Number(limitRaw) || 50;
    const rec = await this.loadRecord(user.id);
    if (!rec || !rec.active) return { messages: [] };
    const messages = await gateway.listMessages(rec.instanceId, chatJid, limit);
    return { messages };
  }

  // =========================================================================
  // @Public POST /api/v1/whatsappmax/wh/:connId → {}
  //   Inbound webhook (no cookie) — authed SOLELY by the x-wa-signature HMAC over
  //   the RAW body under the connId record's per-instance sealed secret. Inbound
  //   text → a detached cdz-flash AI run bound to WhatsappMax's default agent.
  //   ALWAYS 200 {} (even on a bad/unknown connId or signature) — no leak, no
  //   retry-storm. Reuses the WhatsApp channel's verifyWaSignature + parseWaMessage.
  // =========================================================================
  @Public()
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/wh/:connId')
  async webhook(
    @Param('connId') connId: string,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>
  ): Promise<Record<string, never>> {
    if (!studioEnabled()) return {};
    const id = typeof connId === 'string' ? connId.trim() : '';
    if (!id) return {};

    // (1) Resolve the connection owner from the opaque connId.
    let conn: WhatsappMaxConnRecord | undefined;
    try {
      conn = await this.cache.get<WhatsappMaxConnRecord>(maxConnKey(id));
    } catch {
      conn = undefined;
    }
    if (!conn || !conn.userId) return {};

    // (2) Load the owner's record.
    let rec: WhatsappMaxRecord | undefined;
    try {
      rec = await this.cache.get<WhatsappMaxRecord>(maxKey(conn.userId));
    } catch {
      rec = undefined;
    }
    if (!rec || !rec.active || !rec.webhookSecretSealed) return {};

    // (3) THE HARD GATE — constant-time HMAC over the RAW body bytes.
    const secret = openSecret(rec.webhookSecretSealed);
    if (!secret) return {};
    const rawBuf = req.rawBody;
    if (!rawBuf || rawBuf.length === 0) return {};
    const signature = String(req.headers['x-wa-signature'] || '');
    if (!signature || !verifyWaSignature(secret, rawBuf, signature)) {
      return {};
    }

    // Parse the envelope from the RAW bytes (exactly what was signed).
    let envelope: WaWebhookEnvelope;
    try {
      envelope = JSON.parse(rawBuf.toString('utf8')) as WaWebhookEnvelope;
    } catch {
      envelope = (body ?? {}) as WaWebhookEnvelope;
    }

    // Defence-in-depth: cross-check the signed instanceId matches the record's.
    if (
      typeof envelope.instanceId === 'string' &&
      envelope.instanceId &&
      rec.instanceId &&
      envelope.instanceId !== rec.instanceId
    ) {
      return {};
    }

    const { chatJid, text, fromMe, isGroup } = parseWaMessage(envelope);
    if (envelope.event !== 'message') return {};
    if (fromMe) return {};
    if (isGroup) return {};
    if (!chatJid) return {};

    // Re-arm TTLs + bind the reply-to chat (last inbound wins).
    try {
      await this.cache.set(maxChatKey(id), { chatJid }, { ttl: MAX_TTL_MS });
      await this.cache.set(maxKey(conn.userId), rec, { ttl: MAX_TTL_MS });
      await this.cache.set(maxConnKey(id), conn, { ttl: MAX_TTL_MS });
    } catch {
      /* best-effort */
    }

    if (text) {
      await this.handleInboundText(conn.userId, chatJid, text, rec);
    }
    return {};
  }

  /**
   * Turn inbound text into a detached cdz-flash run for the owner, bound to
   * WhatsappMax's default agent (hermes), then ack over the owner's OWN instance.
   * Every engine call is fail-soft. The final answer is pushed later by the SAME
   * run-done path the WhatsApp channel registers (channel:'whatsapp' hook) —
   * WhatsappMax tags its runs 'whatsapp' so the completion push reuses that hook.
   */
  private async handleInboundText(
    userId: string,
    chatJid: string,
    text: string,
    rec: WhatsappMaxRecord
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
      const run = await createAgentRun(this.redis as any, {
        userId,
        agentId: WHATSAPPMAX_AGENT,
        archetype: WHATSAPPMAX_AGENT,
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
        : 'Service momentanément indisponible, réessayez dans un instant.'
    );
  }
}
