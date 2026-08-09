import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';

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
  onAgentRunDone,
  type AgentRunRecord,
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
// P4 E1 additions:
//   • GET /api/v1/whatsappmax/qr.png  — stream gateway PNG (image/png, no-store)
//   • GET /api/v1/whatsappmax/qr      — raw QR string (JSON fallback B)
//   • POST /connect  phoneNumber OPTIONAL (QR-only; pair-code path REMOVED)
//   • GET/POST /api/v1/whatsappmax/media  — stream message media bytes
//   • POST /api/v1/whatsappmax/sendMedia  — send media (image/video/audio/doc)
//   • GET /api/v1/whatsappmax/contacts    — contact list
//   • POST /api/v1/whatsappmax/check      — verify numbers on WhatsApp
//   • POST /api/v1/whatsappmax/read       — set per-chat read watermark (unread)
//   • GET/POST /api/v1/whatsappmax/ai     — per-chat AI auto-reply toggle
//   • GET /api/v1/whatsappmax/messages    — extended with before/fromMe params
//   • registerWhatsappMaxRunDone          — additive completion hook (AI E2E fix)
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

// Poll bound for QR readiness on /connect (bounded ~10s, then return early with
// whatever status the instance is at — FE polls /status separately).
const QR_POLL_INTERVAL_MS = 800;
const QR_POLL_MAX_ATTEMPTS = 12;

// --- Redis key helpers (dedicated WhatsappMax namespace; no overlap with the
// agent channel's clickdz:agentchan:* / clickdz:wa:conn:*).
const maxKey = (userId: string) => `clickdz:wamax:${userId}`;
const maxConnKey = (connId: string) => `clickdz:wamax:conn:${connId}`;
const maxChatKey = (connId: string) => `clickdz:wamax:connchat:${connId}`;
// Per-chat AI auto-reply toggle: '1' = enabled, '0' or absent = disabled.
const maxAiKey = (userId: string, chatJidHash: string) =>
  `clickdz:wamax:ai:${userId}:${chatJidHash}`;
// Per-chat read watermark: last-read message ts (ms).
const maxReadKey = (userId: string, chatJidHash: string) =>
  `clickdz:wamax:read:${userId}:${chatJidHash}`;

// TTL (Cache API takes MILLISECONDS). 180d, re-armed on activity.
const MAX_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** A connection id: 16 hex chars (8 random bytes). Opaque; lives in the URL. */
function mintConnId(): string {
  // Lazy require keeps this pure module boot-safe; node:crypto is always present.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require('node:crypto');
  return randomBytes(8).toString('hex');
}

/** Stable short hash of a JID for use as a Redis key segment.
 * Uses SHA-256 (first 16 hex chars = 8 bytes, collision-negligible for a
 * single user's chat list). Never throws. */
function hashJid(jid: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('node:crypto');
    return createHash('sha256').update(String(jid || '')).digest('hex').slice(0, 16);
  } catch {
    // Defensive: if crypto is somehow unavailable, fall back to a simple
    // deterministic slice so key derivation is always defined.
    return Buffer.from(String(jid || '').slice(0, 16)).toString('hex').slice(0, 16);
  }
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
// client's control-plane surface (create/get/sendText/logout/delete) with
// the READ surface WhatsappMax needs (chats + messages + contacts + media) that
// the channel client does not expose. NEVER throws: a gateway/network hiccup
// resolves null/false.
//
// P4 E1 additions:
//   getQrPng      — stream gateway's /instances/:id/qr.png → raw bytes + status
//   sendMedia     — POST /instances/:id/messages/media
//   downloadMedia — GET /instances/:id/messages/:messageId/media (binary)
//   listContacts  — GET /instances/:id/contacts
//   checkNumbers  — POST /instances/:id/check
//   listMessages  — extended: before + fromMe params
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

  /** Raw binary fetch → { status, buf, contentType, contentDisposition } or null.
   * Used for streaming media + qr.png proxy. NEVER throws. */
  private async callBinary(
    path: string
  ): Promise<{ status: number; buf: Buffer; contentType: string; contentDisposition?: string } | null> {
    if (!this.configured) return null;
    try {
      const res = await fetch(`${WA_URL}${path}`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(WA_TIMEOUT_MS),
      });
      // Only 200 carries a body we can stream; 202 = not ready yet.
      if (res.status !== 200 && res.status !== 202) return null;
      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      const contentDisposition = res.headers.get('content-disposition') ?? undefined;
      return { status: res.status, buf, contentType, contentDisposition };
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

  /** Fetch the QR payload (JSON string) for an instance. null on failure. */
  async getQr(instanceId: string): Promise<{ qr?: string } | null> {
    if (!instanceId) return null;
    const r = await this.call(`/instances/${instanceId}/qr`, { method: 'GET' });
    if (!r || r.status !== 200) return null;
    const b = r.body || {};
    const qr = typeof b.qr === 'string' ? b.qr : undefined;
    return { qr };
  }

  /**
   * P4 E1.1 — Stream the gateway's QR PNG.
   * GET /instances/:id/qr.png → image/png (200) or 202 when not ready.
   * Returns { status, buf } — status 200 means scannable image; 202 = not ready.
   * null on any network/timeout error. NEVER throws.
   */
  async getQrPng(
    instanceId: string
  ): Promise<{ status: number; buf: Buffer } | null> {
    if (!instanceId) return null;
    const r = await this.callBinary(`/instances/${instanceId}/qr.png`);
    if (!r) return null;
    return { status: r.status, buf: r.buf };
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

  /**
   * P4 E1.2 — Send media over a specific instance.
   * POST /instances/:id/messages/media
   * kind: 'image'|'video'|'audio'|'document'; url XOR base64 required.
   * Returns { ok, messageId } shape or false on failure.
   */
  async sendMedia(
    instanceId: string,
    payload: {
      to: string;
      kind: string;
      url?: string;
      base64?: string;
      caption?: string;
      fileName?: string;
      mimetype?: string;
    }
  ): Promise<{ ok: boolean; messageId?: string }> {
    if (!instanceId || !payload?.to) return { ok: false };
    const r = await this.call(`/instances/${instanceId}/messages/media`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r || (r.status !== 201 && r.status !== 200)) return { ok: false };
    const b = r.body || {};
    if (b.ok === false) return { ok: false };
    return {
      ok: true,
      messageId: typeof b.messageId === 'string' ? b.messageId : undefined,
    };
  }

  /**
   * P4 E1.2 — Download raw media for a message.
   * GET /instances/:id/messages/:messageId/media
   * Returns raw bytes + content-type header. Requires a LIVE connected session.
   * null on failure. NEVER throws.
   */
  async downloadMedia(
    instanceId: string,
    messageId: string
  ): Promise<{
    status: number;
    buf: Buffer;
    contentType: string;
    contentDisposition?: string;
  } | null> {
    if (!instanceId || !messageId) return null;
    return this.callBinary(
      `/instances/${instanceId}/messages/${encodeURIComponent(messageId)}/media`
    );
  }

  /**
   * P4 E1.2 — List contacts for an instance.
   * GET /instances/:id/contacts?limit=
   * [] on failure.
   */
  async listContacts(instanceId: string, limit = 100): Promise<any[]> {
    if (!instanceId) return [];
    const params = new URLSearchParams({
      limit: String(Math.max(1, Math.min(500, limit))),
    });
    const r = await this.call(`/instances/${instanceId}/contacts?${params}`, {
      method: 'GET',
    });
    if (!r || r.status !== 200) return [];
    const b = r.body || {};
    if (Array.isArray(b)) return b;
    if (Array.isArray(b.contacts)) return b.contacts;
    return [];
  }

  /**
   * P4 E1.2 — Check whether numbers are on WhatsApp.
   * POST /instances/:id/check { numbers: string[] }
   * Returns { results: [{ input, jid, exists }] } or null on failure.
   */
  async checkNumbers(
    instanceId: string,
    numbers: string[]
  ): Promise<{ results: any[] } | null> {
    if (!instanceId || !numbers?.length) return null;
    const r = await this.call(`/instances/${instanceId}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ numbers }),
    });
    if (!r || r.status !== 200) return null;
    const b = r.body || {};
    if (Array.isArray(b.results)) return { results: b.results };
    return null;
  }

  /** Proxy GET /instances/:id/chats → the chat list. [] on failure. */
  async listChats(instanceId: string): Promise<any[]> {
    if (!instanceId) return [];
    // WS17: Baileys populates the chats store from messaging-history.set
    // ASYNC after connect — a fresh connection returns [] until the sync lands
    // (10-30s). Retry up to 3x with 2s backoff so a recently-connected instance
    // doesn't show "Aucune conversation" forever while the sync is in flight.
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this.call(`/instances/${instanceId}/chats`, {
        method: 'GET',
      });
      if (r && r.status === 200) {
        const b = r.body || {};
        const chats = Array.isArray(b) ? b : Array.isArray(b.chats) ? b.chats : [];
        if (chats.length > 0) return chats;
      }
      // empty or error — wait and retry (only between attempts)
      if (attempt < 2) await new Promise(res => setTimeout(res, 2000));
    }
    return [];
  }

  /**
   * Proxy GET /instances/:id/messages?chatJid&limit&before&fromMe → stored inbox.
   * P4 E1.2: extended with `before` (cursor ts) and `fromMe` (filter flag).
   * Maps gateway snake_case fields to camelCase for the FE:
   *   text_body → text, from_me → fromMe, message_id → id, ts → timestamp.
   * [] on failure.
   */
  async listMessages(
    instanceId: string,
    chatJid: string,
    limit: number,
    before?: number,
    fromMe?: boolean
  ): Promise<any[]> {
    if (!instanceId) return [];
    const params = new URLSearchParams();
    if (chatJid) params.set('chatJid', chatJid);
    params.set('limit', String(Math.max(1, Math.min(500, limit || 50))));
    if (before !== undefined && Number.isFinite(before)) {
      params.set('before', String(before));
    }
    if (fromMe !== undefined) {
      params.set('fromMe', fromMe ? 'true' : 'false');
    }
    const r = await this.call(
      `/instances/${instanceId}/messages?${params.toString()}`,
      { method: 'GET' }
    );
    if (!r || r.status !== 200) return [];
    const b = r.body || {};
    const raw: any[] = Array.isArray(b) ? b : Array.isArray(b.messages) ? b.messages : [];
    // Map snake_case gateway columns to camelCase FE shape.
    return raw.map(mapMessageRow);
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
 * Map a stored gateway message row (snake_case) to the FE camelCase shape.
 * text_body → text, from_me → fromMe, message_id → id, ts → timestamp.
 * Passes through any fields the gateway adds (type, pushName, chatJid, etc.).
 */
function mapMessageRow(row: any): any {
  if (!row || typeof row !== 'object') return row;
  const mapped: any = { ...row };
  // Normalise field names; keep originals as fallbacks so nothing is lost.
  if ('text_body' in row) mapped.text = row.text_body ?? mapped.text ?? null;
  if ('from_me' in row) mapped.fromMe = row.from_me ?? mapped.fromMe ?? false;
  if ('message_id' in row) mapped.id = row.message_id ?? mapped.id ?? null;
  if ('ts' in row) mapped.timestamp = row.ts ?? mapped.timestamp ?? null;
  return mapped;
}

/**
 * Shared feature gate. Both the env flag AND a usable secret box are required
 * (we seal the per-instance webhook secret). Off ⇒ every route 404s. Exported
 * so a future tool/hook can gate identically.
 */
export function studioEnabled(): boolean {
  return CDZ_WHATSAPPMAX_ENABLED === '1' && secretBoxReady();
}

// ---------------------------------------------------------------------------
// P4 E1.3 — AI completion hook (registerWhatsappMaxRunDone).
//
// Fixes the inbound→AI reply E2E by registering an ADDITIVE completion hook
// that filters on the 'wamax:{connId}' sentinel in rec.threadId. When a run
// created by handleInboundText finishes it carries threadId='wamax:{connId}'
// and channel='whatsapp'; this hook fires, resolves the instance + chatJid
// from the WhatsappMax Redis namespace, and sends the final answer over the
// right instance to the right chat. NEVER conflicts with the agent-channel
// hook (which keys off clickdz:agentchan:* and ignores wamax: threadIds).
// ---------------------------------------------------------------------------

let wamaxRunDoneRegistered = false;

/**
 * Register the WhatsappMax completion hook (additive, idempotent, fail-soft).
 * Filters rec.channel==='whatsapp' && rec.threadId?.startsWith('wamax:'),
 * recovers connId, resolves owner+instance+chatJid from the WhatsappMax
 * Redis namespace, and sends rec.finalText via the WhatsappMax instance.
 * Called once from the controller constructor (mirrors registerWhatsappRunDone).
 */
function registerWhatsappMaxRunDone(deps: { cache: Cache }): void {
  if (wamaxRunDoneRegistered) return;
  try {
    if (typeof onAgentRunDone !== 'function') return;
    onAgentRunDone(async (rec: AgentRunRecord) => {
      try {
        // Only handle WhatsappMax runs: channel='whatsapp' + wamax: sentinel.
        if (!rec || rec.channel !== 'whatsapp') return;
        if (!rec.threadId?.startsWith('wamax:')) return;
        if (!rec.userId) return;
        // Recover the connId from the sentinel threadId ('wamax:{connId}').
        const connId = rec.threadId.slice('wamax:'.length);
        if (!connId) return;
        // Resolve the owner from the connId→owner reverse map.
        let conn: WhatsappMaxConnRecord | null = null;
        try {
          conn = await deps.cache.get<WhatsappMaxConnRecord>(maxConnKey(connId));
        } catch {
          conn = null;
        }
        if (!conn || conn.userId !== rec.userId) return;
        // Load the owner's WhatsappMax record → instance.
        let wmRec: WhatsappMaxRecord | null = null;
        try {
          wmRec = await deps.cache.get<WhatsappMaxRecord>(maxKey(rec.userId));
        } catch {
          wmRec = null;
        }
        if (!wmRec || !wmRec.active || !wmRec.instanceId) return;
        // Load the reply-to chatJid (last inbound wins, bound by the webhook).
        let chatJid: string | undefined;
        try {
          const bind = await deps.cache.get<{ chatJid?: string }>(
            maxChatKey(connId)
          );
          chatJid = bind?.chatJid;
        } catch {
          chatJid = undefined;
        }
        if (!chatJid) return;
        // Build the reply text (mirror the agent-channel hook's fallback logic).
        const finalText =
          typeof rec.finalText === 'string' && rec.finalText.trim()
            ? rec.finalText.trim()
            : rec.state === 'failed'
              ? '⚠️ La tâche a échoué.'
              : '✅ Tâche terminée.';
        await gateway.sendText(wmRec.instanceId, chatJid, finalText);
      } catch {
        // A completion push must never surface — swallow and move on.
      }
    });
    wamaxRunDoneRegistered = true;
  } catch {
    // onAgentRunDone unavailable / threw on register: leave unregistered.
  }
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
  ) {
    // P4 E1.3: register the WhatsappMax-specific run-done hook (additive).
    // Mirrors the pattern used by ClickDzAgentWhatsappController at line 449.
    // Idempotent — safe to call on every boot; the guard flag ensures a single
    // registration even if the controller is somehow instantiated twice.
    registerWhatsappMaxRunDone({ cache: this.cache });
  }

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
  // P4 E1.1 — GET /api/v1/whatsappmax/qr.png
  //   Streams the gateway's PNG QR image (image/png, cache-control:no-store).
  //   200 = scannable QR image; 202 = not ready yet (FE retries).
  //   The FE renders: <img src="/api/v1/whatsappmax/qr.png?ts=…">
  //   polling every ~2s while status==='qr'.
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/qr.png')
  async qrPng(
    @CurrentUser() user: CurrentUser,
    @Res({ passthrough: true }) res: Response
  ): Promise<void> {
    this.assertEnabled();
    const rec = await this.loadRecord(user.id);
    if (!rec || !rec.active) {
      res.status(202).set({ 'cache-control': 'no-store' }).end();
      return;
    }
    const result = await gateway.getQrPng(rec.instanceId);
    if (!result) {
      res.status(202).set({ 'cache-control': 'no-store' }).end();
      return;
    }
    if (result.status === 202) {
      // QR not ready yet — return 202 so the FE <img> can retry.
      res.status(202).set({ 'cache-control': 'no-store' }).end();
      return;
    }
    // 200 — stream the PNG bytes.
    res
      .status(200)
      .set({
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': String(result.buf.length),
      })
      .end(result.buf);
  }

  // =========================================================================
  // P4 E1.1 — GET /api/v1/whatsappmax/qr
  //   Returns the raw QR string (fallback B for FE-side QR rendering).
  //   { qr: string|null, status: string }
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/qr')
  async qrRaw(@CurrentUser() user: CurrentUser): Promise<{
    qr: string | null;
    status: string;
  }> {
    this.assertEnabled();
    const rec = await this.loadRecord(user.id);
    if (!rec || !rec.active) {
      return { qr: null, status: 'not_connected' };
    }
    const qrData = await gateway.getQr(rec.instanceId);
    const view = await gateway.getInstance(rec.instanceId);
    return {
      qr: qrData?.qr ?? null,
      status: view?.status ?? rec.status ?? 'unknown',
    };
  }

  // =========================================================================
  // POST /api/v1/whatsappmax/connect  { phoneNumber? }
  //   → { ok, qr?, status }
  //
  // P4 E1.1: phoneNumber is now OPTIONAL (QR-only pairing; phone not required).
  // Provision a per-user gateway instance with an opaque per-connection webhookUrl,
  // seal + persist its per-instance webhookSecret + the record + the connId→owner
  // reverse map. Poll until QR is ready (~10s) and return early with qr string.
  // The dead pairWithRetry / pair() code path has been REMOVED.
  // Reconnect tears down the old instance first.
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/connect')
  async connect(
    @CurrentUser() user: CurrentUser,
    @Body() body: { phoneNumber?: unknown }
  ): Promise<{
    ok: boolean;
    qr?: string;
    status: string;
  }> {
    this.assertEnabled();
    // phoneNumber is OPTIONAL — QR pairing does not need it.
    // Normalize if provided; leave null if absent/invalid.
    const rawPhone = body?.phoneNumber;
    const phoneNumber =
      rawPhone !== undefined && rawPhone !== null && rawPhone !== ''
        ? normalizeMsisdn(rawPhone) || null
        : null;

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

    // (5) Poll until QR is ready (bounded ~10s), then return the QR string.
    // The FE then polls GET /status (drives created→connecting→qr→connected)
    // and while status==='qr' shows the live QR image via GET /qr.png.
    for (let attempt = 0; attempt < QR_POLL_MAX_ATTEMPTS; attempt++) {
      const view = await gateway.getInstance(created.id);
      const liveStatus = view?.status || '';
      if (liveStatus === 'qr') {
        const qrData = await gateway.getQr(created.id);
        return { ok: true, qr: qrData?.qr ?? undefined, status: 'qr' };
      }
      if (liveStatus === 'connected') {
        return { ok: true, status: 'connected' };
      }
      if (liveStatus === 'logged_out') {
        return { ok: true, status: 'logged_out' };
      }
      await sleep(QR_POLL_INTERVAL_MS);
    }
    // Timed out — return early with whatever status is available. FE polls /status.
    return { ok: true, status: 'connecting' };
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
    // Preserve full JIDs (1:1 '@s.whatsapp.net' and group '@g.us') — the gateway
    // accepts either a JID or bare digits. normalizeMsisdn strips ALL non-digits,
    // which mangles group JIDs ('12345@g.us' -> '12345') and silently breaks
    // group sends. Only normalize when the input is a bare phone (no '@').
    const rawTo = typeof body?.to === 'string' ? body.to.trim() : '';
    const to = rawTo.includes('@') ? rawTo : normalizeMsisdn(rawTo);
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
  // P4 E1.2 — POST /api/v1/whatsappmax/sendMedia
  //   { to, kind, url?|base64?, caption?, fileName?, mimetype? } → { ok, messageId? }
  //   Composer attach — proxies POST /instances/:id/messages/media.
  //   Validates `kind` ∈ {'image','video','audio','document'}.
  //   url XOR base64 required; base64 size-bounded (max 10MB decoded).
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/sendMedia')
  async sendMedia(
    @CurrentUser() user: CurrentUser,
    @Body()
    body: {
      to?: unknown;
      kind?: unknown;
      url?: unknown;
      base64?: unknown;
      caption?: unknown;
      fileName?: unknown;
      mimetype?: unknown;
    }
  ): Promise<{ ok: boolean; messageId?: string; note?: string }> {
    this.assertEnabled();
    // Preserve full JIDs (see /send above) — normalizeMsisdn mangles group JIDs.
    const rawTo = typeof body?.to === 'string' ? body.to.trim() : '';
    const to = rawTo.includes('@') ? rawTo : normalizeMsisdn(rawTo);
    if (!to) throw new BadRequest('invalid_to');
    const kind = typeof body?.kind === 'string' ? body.kind.trim() : '';
    const validKinds = ['image', 'video', 'audio', 'document'];
    if (!validKinds.includes(kind)) {
      throw new BadRequest('kind must be one of: image, video, audio, document');
    }
    const url = typeof body?.url === 'string' ? body.url.trim() : undefined;
    const base64 = typeof body?.base64 === 'string' ? body.base64 : undefined;
    if (!url && !base64) {
      throw new BadRequest('url or base64 required');
    }
    // Guard base64 size: 10MB decoded ≈ ~13.3MB base64 chars.
    if (base64 && base64.length > 14_000_000) {
      throw new BadRequest('base64 payload too large (max ~10MB)');
    }
    const rec = await this.loadRecord(user.id);
    if (!rec || !rec.active) {
      // Match /send's contract (ok:true + note:'not_connected') so the FE can
      // surface the specific 'Liez un numéro WhatsApp d'abord.' message instead
      // of a generic 'Envoi du média échoué.'
      return { ok: true, note: 'not_connected' };
    }
    const result = await gateway.sendMedia(rec.instanceId, {
      to,
      kind,
      url,
      base64,
      caption: typeof body?.caption === 'string' ? body.caption : undefined,
      fileName: typeof body?.fileName === 'string' ? body.fileName : undefined,
      mimetype: typeof body?.mimetype === 'string' ? body.mimetype : undefined,
    });
    return result;
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
    // Normalize + dedupe + cap the recipient list. Preserve full JIDs (group
    // '@g.us' / 1:1 '@s.whatsapp.net') — normalizeMsisdn strips non-digits and
    // would mangle a group JID. Only normalize bare phone numbers (no '@').
    const seen = new Set<string>();
    const recipients: string[] = [];
    for (const raw of rawTo) {
      const s = typeof raw === 'string' ? raw.trim() : '';
      const n = s.includes('@') ? s : normalizeMsisdn(s);
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
  //   Enriches each row with derived `unread` count from the read watermark.
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
  // P4 E1.2 — GET /api/v1/whatsappmax/messages?chatJid&limit&before&fromMe
  //   → { messages: [...] }
  //   Extended with `before` (cursor ts for "load older") and `fromMe` filter.
  //   Fields mapped: text_body→text, from_me→fromMe, message_id→id, ts→timestamp.
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/messages')
  async messages(
    @CurrentUser() user: CurrentUser,
    @Query('chatJid') chatJidRaw: string,
    @Query('limit') limitRaw: string,
    @Query('before') beforeRaw: string,
    @Query('fromMe') fromMeRaw: string
  ): Promise<{ messages: unknown[] }> {
    this.assertEnabled();
    const chatJid = typeof chatJidRaw === 'string' ? chatJidRaw.trim() : '';
    const limit = Number(limitRaw) || 50;
    const before =
      beforeRaw !== undefined && beforeRaw !== ''
        ? Number(beforeRaw) || undefined
        : undefined;
    const fromMe =
      fromMeRaw === 'true' ? true : fromMeRaw === 'false' ? false : undefined;
    const rec = await this.loadRecord(user.id);
    if (!rec || !rec.active) return { messages: [] };
    const messages = await gateway.listMessages(
      rec.instanceId,
      chatJid,
      limit,
      before,
      fromMe
    );
    return { messages };
  }

  // =========================================================================
  // P4 E1.2 — GET /api/v1/whatsappmax/media?messageId=
  //   Stream raw media bytes for a message (image/video/audio/document).
  //   Requires a LIVE connected session (Baileys re-download).
  //   Degrades gracefully (404) when the session is down or messageId not found.
  // =========================================================================
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/media')
  async media(
    @CurrentUser() user: CurrentUser,
    @Query('messageId') messageIdRaw: string,
    @Res({ passthrough: true }) res: Response
  ): Promise<void> {
    this.assertEnabled();
    const messageId = typeof messageIdRaw === 'string' ? messageIdRaw.trim() : '';
    if (!messageId) {
      res.status(400).json({ error: 'messageId required' });
      return;
    }
    const rec = await this.loadRecord(user.id);
    if (!rec || !rec.active) {
      res.status(404).json({ error: 'not_connected' });
      return;
    }
    const result = await gateway.downloadMedia(rec.instanceId, messageId);
    if (!result || result.status !== 200) {
      res.status(404).json({ error: 'media_not_found' });
      return;
    }
    const headers: Record<string, string> = {
      'content-type': result.contentType,
      'cache-control': 'private, max-age=3600',
      'content-length': String(result.buf.length),
    };
    if (result.contentDisposition) {
      headers['content-disposition'] = result.contentDisposition;
    }
    res.status(200).set(headers).end(result.buf);
  }

  // =========================================================================
  // P4 E1.2 — GET /api/v1/whatsappmax/contacts → { contacts: [...] }
  //   Proxy the gateway contact list for new-chat picker / address book.
  // =========================================================================
  @Throttle('default', { limit: 60, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/contacts')
  async contacts(
    @CurrentUser() user: CurrentUser,
    @Query('limit') limitRaw: string
  ): Promise<{ contacts: unknown[] }> {
    this.assertEnabled();
    const limit = Number(limitRaw) || 100;
    const rec = await this.loadRecord(user.id);
    if (!rec || !rec.active) return { contacts: [] };
    const contacts = await gateway.listContacts(rec.instanceId, limit);
    return { contacts };
  }

  // =========================================================================
  // P4 E1.2 — POST /api/v1/whatsappmax/check  { numbers: string[] }
  //   → { results: [{ input, jid, exists }] }
  //   Verify numbers are on WhatsApp (new-chat picker).
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/check')
  async check(
    @CurrentUser() user: CurrentUser,
    @Body() body: { numbers?: unknown }
  ): Promise<{ results: unknown[] }> {
    this.assertEnabled();
    const rawNums = Array.isArray(body?.numbers) ? (body.numbers as unknown[]) : [];
    const numbers: string[] = rawNums
      .map(n => normalizeMsisdn(n))
      .filter(Boolean)
      .slice(0, 100);
    if (!numbers.length) throw new BadRequest('numbers must be a non-empty array');
    const rec = await this.loadRecord(user.id);
    if (!rec || !rec.active) throw new BadRequest('not_connected');
    const result = await gateway.checkNumbers(rec.instanceId, numbers);
    return { results: result?.results ?? [] };
  }

  // =========================================================================
  // P4 E1.3 — POST /api/v1/whatsappmax/read  { chatJid }
  //   Set the per-chat read watermark (last-read ts = now) so the chat list
  //   can derive an unread count for the opened conversation.
  //   → { ok }
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/read')
  async setReadWatermark(
    @CurrentUser() user: CurrentUser,
    @Body() body: { chatJid?: unknown }
  ): Promise<{ ok: boolean }> {
    this.assertEnabled();
    const chatJid = typeof body?.chatJid === 'string' ? body.chatJid.trim() : '';
    if (!chatJid) throw new BadRequest('chatJid required');
    const rec = await this.loadRecord(user.id);
    if (!rec) return { ok: false };
    try {
      const key = maxReadKey(user.id, hashJid(chatJid));
      // Store the current ts as the read watermark (raw ioredis SET).
      await (this.redis as any).set(key, String(Date.now()), 'EX', Math.floor(MAX_TTL_MS / 1000));
    } catch {
      /* best-effort */
    }
    return { ok: true };
  }

  // =========================================================================
  // P4 E1.3 — GET /api/v1/whatsappmax/ai?chatJid=
  //   → { enabled: boolean }
  //   Returns the per-chat AI auto-reply toggle state (default: OFF).
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/ai')
  async getAiToggle(
    @CurrentUser() user: CurrentUser,
    @Query('chatJid') chatJidRaw: string
  ): Promise<{ enabled: boolean }> {
    this.assertEnabled();
    const chatJid = typeof chatJidRaw === 'string' ? chatJidRaw.trim() : '';
    if (!chatJid) throw new BadRequest('chatJid required');
    try {
      const val = await (this.redis as any).get(maxAiKey(user.id, hashJid(chatJid)));
      return { enabled: val === '1' };
    } catch {
      return { enabled: false };
    }
  }

  // =========================================================================
  // P4 E1.3 — POST /api/v1/whatsappmax/ai  { chatJid, enabled }
  //   → { ok, enabled }
  //   Set the per-chat AI auto-reply toggle (opt-in per conversation).
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/ai')
  async setAiToggle(
    @CurrentUser() user: CurrentUser,
    @Body() body: { chatJid?: unknown; enabled?: unknown }
  ): Promise<{ ok: boolean; enabled: boolean }> {
    this.assertEnabled();
    const chatJid = typeof body?.chatJid === 'string' ? body.chatJid.trim() : '';
    if (!chatJid) throw new BadRequest('chatJid required');
    const enabled = body?.enabled === true || body?.enabled === 'true' || body?.enabled === 1;
    try {
      const key = maxAiKey(user.id, hashJid(chatJid));
      await (this.redis as any).set(
        key,
        enabled ? '1' : '0',
        'EX',
        Math.floor(MAX_TTL_MS / 1000)
      );
    } catch {
      /* best-effort */
    }
    return { ok: true, enabled };
  }

  // =========================================================================
  // @Public POST /api/v1/whatsappmax/wh/:connId → {}
  //   Inbound webhook (no cookie) — authed SOLELY by the x-wa-signature HMAC over
  //   the RAW body under the connId record's per-instance sealed secret. Inbound
  //   text → a detached cdz-flash AI run bound to WhatsappMax's default agent.
  //   ALWAYS 200 {} (even on a bad/unknown connId or signature) — no leak, no
  //   retry-storm. Reuses the WhatsApp channel's verifyWaSignature + parseWaMessage.
  //
  //   P4 E1.3: checks the per-chat AI toggle before enqueuing a run.
  //   P4 E1.3: passes threadId: 'wamax:{connId}' sentinel to createAgentRun
  //            so registerWhatsappMaxRunDone can route the final answer back.
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
      // P4 E1.3: check per-chat AI toggle before enqueueing a run.
      let aiEnabled = false;
      try {
        const aiVal = await (this.redis as any).get(
          maxAiKey(conn.userId, hashJid(chatJid))
        );
        aiEnabled = aiVal === '1';
      } catch {
        aiEnabled = false;
      }
      await this.handleInboundText(conn.userId, chatJid, text, rec, id, aiEnabled);
    }
    return {};
  }

  /**
   * Turn inbound text into a detached cdz-flash run for the owner, bound to
   * WhatsappMax's default agent (hermes), then ack over the owner's OWN instance.
   * Every engine call is fail-soft. The final answer is pushed later by the
   * registerWhatsappMaxRunDone hook (which filters on the 'wamax:{connId}' sentinel
   * threadId — the fix that makes AI replies land E2E on the right instance/chat).
   *
   * P4 E1.3 changes:
   *   - passes threadId: 'wamax:{connId}' sentinel to createAgentRun
   *   - checks aiEnabled flag — only enqueues a run when AI toggle is ON
   */
  private async handleInboundText(
    userId: string,
    chatJid: string,
    text: string,
    rec: WhatsappMaxRecord,
    connId: string,
    aiEnabled: boolean
  ): Promise<void> {
    // If AI auto-reply is disabled for this chat, do not enqueue a run.
    if (!aiEnabled) return;

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
      // P4 E1.3: thread the 'wamax:{connId}' sentinel in threadId so the
      // registerWhatsappMaxRunDone hook can recover the connId and route the
      // final answer back over the WhatsappMax instance (the AI E2E fix).
      const run = await createAgentRun(this.redis as any, {
        userId,
        agentId: WHATSAPPMAX_AGENT,
        archetype: WHATSAPPMAX_AGENT,
        prompt: text,
        channel: 'whatsapp',
        threadId: `wamax:${connId}`,
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
