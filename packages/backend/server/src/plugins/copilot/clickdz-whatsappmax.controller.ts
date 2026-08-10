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

// --- WS-AI: synchronous AI assist (draft/summary/translate) -----------------
// Same OpenAI-compatible cdz-flash brain the bridge controller's direct fast
// path calls (clickdz-bridge.controller.ts ~L490-530), re-derived HERE from the
// SAME env vars so this controller stays import-isolated from the bridge one
// (no cross-controller coupling — additive, self-contained, same idiom as the
// gateway client above). CDZ_AI_BASE_URL may or may not carry a trailing `/v1`
// depending on deploy config; strip it once so the single canonical
// `/v1/chat/completions` path below is appended exactly once either way.
const WAMAX_AI_ORIGIN = (process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '');
const WAMAX_AI_KEY = process.env.CDZ_AI_KEY || '';
const WAMAX_AI_MODEL = process.env.CDZ_AGENT_MODEL || 'cdz-flash';
// Bounded timeout for the synchronous assist calls — these back a live UI
// affordance (draft/summarize/translate button), so fail fast rather than hang.
const WAMAX_AI_TIMEOUT_MS = 15_000;
// Hard cap on any owner-supplied instruction/text fed to the assist routes.
const WAMAX_AI_INPUT_MAX_CHARS = 2000;

// --- Redis key helpers (dedicated WhatsappMax namespace; no overlap with the
// agent channel's clickdz:agentchan:* / clickdz:wa:conn:*).
// P4 W3: Per-connId record key — one record per connection (multi-account).
const maxKey = (userId: string, connId: string) =>
  `clickdz:wamax:${userId}:${connId}`;
// Legacy flat key (pre-multi-account) — used ONLY for back-compat migration.
const maxKeyLegacy = (userId: string) => `clickdz:wamax:${userId}`;
// Index key: a Redis SET of connIds for a user (multi-account registry).
const maxIdxKey = (userId: string) => `clickdz:wamax:idx:${userId}`;
const maxConnKey = (connId: string) => `clickdz:wamax:conn:${connId}`;
const maxChatKey = (connId: string) => `clickdz:wamax:connchat:${connId}`;
// Per-chat AI auto-reply toggle: '1' = enabled, '0' or absent = disabled.
// P4 W3: scoped by connId so per-chat settings don't bleed across accounts.
const maxAiKey = (userId: string, connId: string, chatJidHash: string) =>
  `clickdz:wamax:ai:${userId}:${connId}:${chatJidHash}`;
// Per-chat read watermark: last-read message ts (ms).
// P4 W3: scoped by connId so read state doesn't bleed across accounts.
const maxReadKey = (userId: string, connId: string, chatJidHash: string) =>
  `clickdz:wamax:read:${userId}:${connId}:${chatJidHash}`;
// WS-MAXP: per-connection AI settings (persona/tone/language/auto-reply default
// + quick replies). One JSON record per (userId, connId), sanitized on
// read AND write by sanitizeWamaxAiSettings.
const maxAiSettingsKey = (userId: string, connId: string) =>
  `clickdz:wamax:aiset:${userId}:${connId}`;
// WS-MAXP: profile-photo URL cache — per (connId, jidHash). A photo lookup is a
// LIVE gateway call (Baileys profilePicture), so hits keep the chat list cheap.
// Successful URLs cache 12h; a null (hidden/unavailable/session-down) caches 1h
// so a temporary gateway hiccup can't pin "no photo" for half a day.
const maxAvatarKey = (connId: string, jidHash: string) =>
  `clickdz:wamax:av:${connId}:${jidHash}`;
const AVATAR_TTL_MS = 12 * 60 * 60 * 1000;
const AVATAR_NULL_TTL_MS = 60 * 60 * 1000;

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
// WS-MAXP — per-connection AI settings. Configures HOW the WhatsappMax AI
// behaves for this shop: the business persona/context fed to every assist
// prompt AND to the inbound auto-reply run (via createAgentRun's persona
// threading), the reply tone, the reply language, whether NEW chats default to
// AI auto-reply (the per-chat toggle still overrides), and the owner's
// quick-reply templates surfaced in the composer.
// ---------------------------------------------------------------------------
export interface WamaxAiSettings {
  businessName: string;
  persona: string;
  tone: 'pro' | 'amical' | 'vendeur' | 'neutre';
  language: 'auto' | 'fr' | 'darija' | 'ar' | 'en';
  autoReplyDefault: boolean;
  quickReplies: string[];
}

const WAMAX_TONES: ReadonlyArray<WamaxAiSettings['tone']> = [
  'pro',
  'amical',
  'vendeur',
  'neutre',
];
const WAMAX_LANGS: ReadonlyArray<WamaxAiSettings['language']> = [
  'auto',
  'fr',
  'darija',
  'ar',
  'en',
];
const WAMAX_PERSONA_MAX = 1500;
const WAMAX_BIZNAME_MAX = 120;
const WAMAX_QUICKREPLY_MAX = 10;
const WAMAX_QUICKREPLY_LEN = 300;

const DEFAULT_WAMAX_AI_SETTINGS: WamaxAiSettings = {
  businessName: '',
  persona: '',
  tone: 'pro',
  language: 'auto',
  autoReplyDefault: false,
  quickReplies: [],
};

/** Sanitize an untrusted/partial settings blob into a full, bounded record.
 * Unknown fields are DROPPED, strings trimmed + clamped, enums validated.
 * NEVER throws — any garbage collapses to the defaults. */
function sanitizeWamaxAiSettings(raw: unknown): WamaxAiSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const businessName =
    typeof r.businessName === 'string'
      ? r.businessName.trim().slice(0, WAMAX_BIZNAME_MAX)
      : '';
  const persona =
    typeof r.persona === 'string'
      ? r.persona.trim().slice(0, WAMAX_PERSONA_MAX)
      : '';
  const tone = WAMAX_TONES.includes(r.tone as WamaxAiSettings['tone'])
    ? (r.tone as WamaxAiSettings['tone'])
    : DEFAULT_WAMAX_AI_SETTINGS.tone;
  const language = WAMAX_LANGS.includes(
    r.language as WamaxAiSettings['language']
  )
    ? (r.language as WamaxAiSettings['language'])
    : DEFAULT_WAMAX_AI_SETTINGS.language;
  const autoReplyDefault =
    r.autoReplyDefault === true ||
    r.autoReplyDefault === 'true' ||
    r.autoReplyDefault === 1;
  const quickReplies = Array.isArray(r.quickReplies)
    ? (r.quickReplies as unknown[])
        .map(q =>
          typeof q === 'string' ? q.trim().slice(0, WAMAX_QUICKREPLY_LEN) : ''
        )
        .filter(Boolean)
        .slice(0, WAMAX_QUICKREPLY_MAX)
    : [];
  return { businessName, persona, tone, language, autoReplyDefault, quickReplies };
}

/** French prompt fragment for the configured reply tone. */
function wamaxToneLine(tone: WamaxAiSettings['tone']): string {
  switch (tone) {
    case 'amical':
      return 'Adopte un ton chaleureux et amical.';
    case 'vendeur':
      return 'Adopte un ton commercial et persuasif, orienté vente.';
    case 'neutre':
      return 'Adopte un ton neutre et factuel.';
    default:
      return 'Adopte un ton professionnel et courtois.';
  }
}

/** French prompt fragment for the configured reply language. */
function wamaxLangLine(language: WamaxAiSettings['language']): string {
  switch (language) {
    case 'fr':
      return 'Réponds toujours en français.';
    case 'darija':
      return 'Réponds toujours en darija algérienne, comme un commerçant algérien.';
    case 'ar':
      return 'Réponds toujours en arabe.';
    case 'en':
      return 'Always reply in English.';
    default:
      return 'Réponds dans la langue de la conversation (français, darija ou arabe selon le cas).';
  }
}

/** Build the persona string threaded to createAgentRun for inbound auto-reply
 * runs. Returns undefined when the settings are entirely default (no persona,
 * no business name, default tone+language) so legacy behavior stays
 * byte-identical for unconfigured shops. */
function buildWamaxRunPersona(s: WamaxAiSettings): string | undefined {
  const configured =
    !!s.persona ||
    !!s.businessName ||
    s.tone !== DEFAULT_WAMAX_AI_SETTINGS.tone ||
    s.language !== DEFAULT_WAMAX_AI_SETTINGS.language;
  if (!configured) return undefined;
  const parts: string[] = [];
  parts.push(
    s.businessName
      ? `Tu réponds sur WhatsApp AU NOM de l’entreprise « ${s.businessName} », à un client.`
      : 'Tu réponds sur WhatsApp AU NOM de l’entreprise, à un client.'
  );
  if (s.persona) parts.push(`Contexte de l’entreprise : ${s.persona}`);
  parts.push(wamaxToneLine(s.tone));
  parts.push(wamaxLangLine(s.language));
  parts.push(
    'Réponds de façon brève et directement envoyable sur WhatsApp — pas de préambule, pas de signature.'
  );
  return parts.join(' ');
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
   * WS-MAXP — Live profile-photo URL for a contact/group JID.
   * GET /instances/:id/contacts/:jid/photo → { jid, url }
   * The URL is a WhatsApp CDN link (pps.whatsapp.net) directly renderable in
   * an <img>. null when hidden/unavailable or the session is down. NEVER throws.
   */
  async getProfilePicture(
    instanceId: string,
    jid: string
  ): Promise<string | null> {
    if (!instanceId || !jid) return null;
    const r = await this.call(
      `/instances/${instanceId}/contacts/${encodeURIComponent(jid)}/photo`,
      { method: 'GET' }
    );
    if (!r || r.status !== 200) return null;
    const b = r.body || {};
    return typeof b.url === 'string' && b.url ? b.url : null;
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

  /** POST /instances/:id/sync — kick the gateway's chat-history re-sync
   * (the gateway's on-ready sync is one-shot fire-and-forget; if it fails or
   * is interrupted by a redeploy, nothing retries it — this endpoint is the
   * designed escape hatch). true when the gateway accepted the request. */
  async triggerSync(instanceId: string): Promise<boolean> {
    if (!instanceId) return false;
    const r = await this.call(`/instances/${instanceId}/sync`, {
      method: 'POST',
    });
    return !!r && r.status >= 200 && r.status < 300;
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
    before?: string,
    fromMe?: boolean
  ): Promise<any[]> {
    if (!instanceId) return [];
    const params = new URLSearchParams();
    if (chatJid) params.set('chatJid', chatJid);
    params.set('limit', String(Math.max(1, Math.min(500, limit || 50))));
    // WS-MAXP fix: the gateway parses `before` with `new Date(q.before)`, which
    // rejects a milliseconds-since-epoch STRING ("17232…" → Invalid Date → SQL
    // error → empty page). Always pass an ISO-8601 string — the /messages route
    // normalizes both ms and ISO inputs to ISO before calling here.
    if (before) {
      params.set('before', before);
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
        // P4 W3: per-connId key (connId recovered from the sentinel at line 574).
        let wmRec: WhatsappMaxRecord | null = null;
        try {
          wmRec = await deps.cache.get<WhatsappMaxRecord>(
            maxKey(rec.userId, connId)
          );
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

  /** Load a specific connection's WhatsappMax record (fail-soft).
   *  P4 W3: per-connId key with lazy back-compat migration from the legacy
   *  flat key (clickdz:wamax:{userId}). If the new key misses but a legacy
   *  record exists AND its connId matches, we migrate: write the new key,
   *  add to the index, delete the legacy key. This self-heals existing users
   *  on first access after the deploy. */
  private async loadRecord(
    userId: string,
    connId: string
  ): Promise<WhatsappMaxRecord | null> {
    if (!connId) return null;
    try {
      const rec = await this.cache.get<WhatsappMaxRecord>(
        maxKey(userId, connId)
      );
      if (rec && rec.instanceId) return rec;
      // Miss — try legacy flat key for back-compat migration.
      const legacy = await this.cache.get<WhatsappMaxRecord>(
        maxKeyLegacy(userId)
      );
      if (legacy && legacy.instanceId && legacy.connId === connId) {
        // Migrate: write new key, index, delete legacy.
        try {
          await this.cache.set(maxKey(userId, connId), legacy, {
            ttl: MAX_TTL_MS,
          });
          await this.indexAddConn(userId, connId);
          await this.cache.delete(maxKeyLegacy(userId));
        } catch {
          /* best-effort migration — legacy key still readable */
        }
        return legacy;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Load ALL of a user's WhatsappMax records (multi-account).
   *  P4 W3: reads the connId index; if empty, falls back to legacy migration
   *  (single-account era). Returns records WITHOUT the sealed secret. */
  private async loadRecords(
    userId: string
  ): Promise<WhatsappMaxRecord[]> {
    try {
      const connIds = await this.indexListConn(userId);
      if (connIds.length > 0) {
        const records: WhatsappMaxRecord[] = [];
        for (const cid of connIds) {
          const rec = await this.cache.get<WhatsappMaxRecord>(
            maxKey(userId, cid)
          );
          if (rec && rec.instanceId) {
            records.push(rec);
          }
        }
        return records;
      }
      // Index empty — try legacy migration (single-account back-compat).
      const legacy = await this.cache.get<WhatsappMaxRecord>(
        maxKeyLegacy(userId)
      );
      if (legacy && legacy.instanceId && legacy.connId) {
        try {
          await this.cache.set(
            maxKey(userId, legacy.connId),
            legacy,
            { ttl: MAX_TTL_MS }
          );
          await this.indexAddConn(userId, legacy.connId);
          await this.cache.delete(maxKeyLegacy(userId));
        } catch {
          /* best-effort */
        }
        return [legacy];
      }
      return [];
    } catch {
      return [];
    }
  }

  /** Resolve a single record by connId, or fall back to the first connected
   *  account when connId is absent (back-compat shim during migration).
   *  P4 W3: used by route handlers that can optionally accept connId. */
  private async resolveRecord(
    userId: string,
    connId?: string
  ): Promise<{ rec: WhatsappMaxRecord; connId: string } | null> {
    if (connId) {
      const rec = await this.loadRecord(userId, connId);
      if (rec) return { rec, connId };
      return null;
    }
    // No connId — fall back to first connected account (back-compat).
    const records = await this.loadRecords(userId);
    if (records.length > 0 && records[0].connId) {
      return { rec: records[0], connId: records[0].connId };
    }
    return null;
  }

  /** WS-MAXP — Load the per-connection AI settings (defaults on any miss/error).
   * Always returns a FULL sanitized record — callers never see partials. */
  private async loadAiSettings(
    userId: string,
    connId: string
  ): Promise<WamaxAiSettings> {
    try {
      const raw = await this.cache.get<Partial<WamaxAiSettings>>(
        maxAiSettingsKey(userId, connId)
      );
      return sanitizeWamaxAiSettings(raw);
    } catch {
      return { ...DEFAULT_WAMAX_AI_SETTINGS };
    }
  }

  // --- P4 W3: Index helpers (raw Redis SET ops via this.redis) ---
  // Best-effort; wrapped in try/catch so a Redis hiccup never crashes a route.

  /** Add a connId to the user's account index (Redis SADD + EXPIRE). */
  private async indexAddConn(userId: string, connId: string): Promise<void> {
    try {
      const key = maxIdxKey(userId);
      await (this.redis as any).sadd(key, connId);
      await (this.redis as any).expire(
        key,
        Math.floor(MAX_TTL_MS / 1000)
      );
    } catch {
      /* best-effort */
    }
  }

  /** Remove a connId from the user's account index (Redis SREM). */
  private async indexRemoveConn(
    userId: string,
    connId: string
  ): Promise<void> {
    try {
      await (this.redis as any).srem(maxIdxKey(userId), connId);
    } catch {
      /* best-effort */
    }
  }

  /** List all connIds in the user's account index (Redis SMEMBERS). */
  private async indexListConn(userId: string): Promise<string[]> {
    try {
      const vals = await (this.redis as any).smembers(maxIdxKey(userId));
      return Array.isArray(vals) ? vals.filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  // =========================================================================
  // GET /api/v1/whatsappmax/status
  //   → { connected, phoneNumber?, status?, connectedAt? }   (NEVER the secret)
  //   Reflects the LIVE gateway status (created→connecting→qr→connected).
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/status')
  async status(
    @CurrentUser() user: CurrentUser,
    @Query('connId') connIdRaw: string
  ): Promise<{
    connected: boolean;
    phoneNumber?: string;
    status?: string;
    connectedAt?: number;
    connId?: string;
  }> {
    this.assertEnabled();
    const connId = typeof connIdRaw === 'string' ? connIdRaw.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved || !resolved.rec.active) {
      return { connected: false };
    }
    const rec = resolved.rec;
    const resolvedConnId = resolved.connId;
    let liveStatus = rec.status;
    let livePhone = rec.phoneNumber;
    const view = await gateway.getInstance(rec.instanceId);
    if (view) {
      liveStatus = view.status || liveStatus;
      if (view.phoneNumber) livePhone = view.phoneNumber;
      if (liveStatus !== rec.status || livePhone !== rec.phoneNumber) {
        try {
          await this.cache.set(
            maxKey(user.id, resolvedConnId),
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
      connId: resolvedConnId,
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
    @Query('connId') connIdRaw: string,
    @Res({ passthrough: true }) res: Response
  ): Promise<void> {
    this.assertEnabled();
    const connId = typeof connIdRaw === 'string' ? connIdRaw.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved || !resolved.rec.active) {
      res.status(202).set({ 'cache-control': 'no-store' }).end();
      return;
    }
    const result = await gateway.getQrPng(resolved.rec.instanceId);
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
  async qrRaw(
    @CurrentUser() user: CurrentUser,
    @Query('connId') connIdRaw: string
  ): Promise<{
    qr: string | null;
    status: string;
  }> {
    this.assertEnabled();
    const connId = typeof connIdRaw === 'string' ? connIdRaw.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved || !resolved.rec.active) {
      return { qr: null, status: 'not_connected' };
    }
    const qrData = await gateway.getQr(resolved.rec.instanceId);
    const view = await gateway.getInstance(resolved.rec.instanceId);
    return {
      qr: qrData?.qr ?? null,
      status: view?.status ?? resolved.rec.status ?? 'unknown',
    };
  }

  // =========================================================================
  // POST /api/v1/whatsappmax/connect  { phoneNumber? }
  //   → { ok, qr?, status, connId? }
  //
  // P4 E1.1: phoneNumber is now OPTIONAL (QR-only pairing; phone not required).
  // Provision a per-user gateway instance with an opaque per-connection webhookUrl,
  // seal + persist its per-instance webhookSecret + the record + the connId→owner
  // reverse map. Poll until QR is ready (~10s) and return early with qr string.
  // The dead pairWithRetry / pair() code path has been REMOVED.
  // P4 W3: NO tear-down of prior instances — multi-account support. Each
  // connect() mints a new connId and persists a separate record. The return
  // now includes connId so the FE can track the new account.
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
    connId?: string;
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

    // P4 W3: NO tear-down of prior instances — multi-account support.
    // Each connect() mints a new connId and persists a separate record.
    // The old tear-down block (lines 798-815) has been REMOVED.

    // (1) Mint an opaque connId + create the instance under the tenant.
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

    // (2) Seal the per-instance secret BEFORE persisting.
    const webhookSecretSealed = sealSecret(created.webhookSecret);
    if (!webhookSecretSealed) {
      try {
        await gateway.deleteInstance(created.id);
      } catch {
        /* best-effort */
      }
      throw new BadRequest('studio_unavailable');
    }

    // (3) Persist the record + connId→owner reverse map (both 180d).
    // P4 W3: per-connId key + index registration.
    const rec: WhatsappMaxRecord = {
      instanceId: created.id,
      webhookSecretSealed,
      connId,
      phoneNumber,
      status: created.status || 'created',
      connectedAt: Date.now(),
      active: true,
    };
    const storedRec = await this.cache.set(maxKey(user.id, connId), rec, {
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
    // P4 W3: register the connId in the user's account index.
    await this.indexAddConn(user.id, connId);

    // (4) Poll until QR is ready (bounded ~10s), then return the QR string.
    // The FE then polls GET /status (drives created→connecting→qr→connected)
    // and while status==='qr' shows the live QR image via GET /qr.png.
    for (let attempt = 0; attempt < QR_POLL_MAX_ATTEMPTS; attempt++) {
      const view = await gateway.getInstance(created.id);
      const liveStatus = view?.status || '';
      if (liveStatus === 'qr') {
        const qrData = await gateway.getQr(created.id);
        return { ok: true, qr: qrData?.qr ?? undefined, status: 'qr', connId };
      }
      if (liveStatus === 'connected') {
        return { ok: true, status: 'connected', connId };
      }
      if (liveStatus === 'logged_out') {
        return { ok: true, status: 'logged_out', connId };
      }
      await sleep(QR_POLL_INTERVAL_MS);
    }
    // Timed out — return early with whatever status is available. FE polls /status.
    return { ok: true, status: 'connecting', connId };
  }

  // =========================================================================
  // POST /api/v1/whatsappmax/disconnect → { ok }
  //   Best-effort logout + delete the instance, then delete the records.
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/disconnect')
  async disconnect(
    @CurrentUser() user: CurrentUser,
    @Body() body: { connId?: unknown }
  ): Promise<{ ok: boolean }> {
    this.assertEnabled();
    // P4 W3: accept connId from body; fall back to first account if absent.
    const connIdRaw = body?.connId;
    const connId =
      typeof connIdRaw === 'string' ? connIdRaw.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (resolved) {
      const rec = resolved.rec;
      const resolvedConnId = resolved.connId;
      if (rec.instanceId) {
        try {
          await gateway.logout(rec.instanceId);
          await gateway.deleteInstance(rec.instanceId);
        } catch {
          /* best-effort */
        }
      }
      try {
        await this.cache.delete(maxConnKey(resolvedConnId));
        await this.cache.delete(maxChatKey(resolvedConnId));
      } catch {
        /* best-effort */
      }
      try {
        await this.cache.delete(maxKey(user.id, resolvedConnId));
      } catch {
        /* best-effort */
      }
      // P4 W3: remove from the user's account index.
      await this.indexRemoveConn(user.id, resolvedConnId);
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
    @Body() body: { to?: unknown; text?: unknown; connId?: unknown }
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
    // P4 W3: per-connId record.
    const connId =
      typeof body?.connId === 'string' ? body.connId.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved || !resolved.rec.active) {
      return { ok: true, sent: false, note: 'not_connected' };
    }
    const sent = await gateway.sendText(resolved.rec.instanceId, to, text);
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
      connId?: unknown;
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
    // P4 W3: per-connId record.
    const connId =
      typeof body?.connId === 'string' ? body.connId.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved || !resolved.rec.active) {
      // Match /send's contract (ok:true + note:'not_connected') so the FE can
      // surface the specific 'Liez un numéro WhatsApp d'abord.' message instead
      // of a generic 'Envoi du média échoué.'
      return { ok: true, note: 'not_connected' };
    }
    const result = await gateway.sendMedia(resolved.rec.instanceId, {
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
    @Body() body: { to?: unknown; text?: unknown; connId?: unknown }
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
    // P4 W3: per-connId record.
    const connId =
      typeof body?.connId === 'string' ? body.connId.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved || !resolved.rec.active) {
      throw new BadRequest('not_connected');
    }
    let sent = 0;
    let failed = 0;
    for (const to of recipients) {
      const ok = await gateway.sendText(resolved.rec.instanceId, to, text);
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
    @CurrentUser() user: CurrentUser,
    @Query('connId') connIdRaw: string
  ): Promise<{ chats: unknown[] }> {
    this.assertEnabled();
    const connId = typeof connIdRaw === 'string' ? connIdRaw.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved || !resolved.rec.active) return { chats: [] };
    const chats = await gateway.listChats(resolved.rec.instanceId);
    if (chats.length > 0) {
      return {
        chats: await this.enrichChats(
          user.id,
          resolved.connId,
          resolved.rec,
          chats
        ),
      };
    }

    // Self-heal: a CONNECTED instance with an empty chat list usually means
    // the gateway's one-shot on-ready history sync failed or was interrupted
    // (e.g. gateway redeploy mid-sync) — the user then sees "no chat system"
    // forever. Kick the gateway's POST /instances/:id/sync (at most once per
    // 5 min per instance) and give the re-sync a short window to land within
    // this same request so a simple refresh brings the conversations in.
    const kickKey = `clickdz:wamax:sync-kick:${resolved.rec.instanceId}`;
    const alreadyKicked = await this.cache.get<boolean>(kickKey);
    if (!alreadyKicked) {
      await this.cache.set(kickKey, true, { ttl: 5 * 60 * 1000 });
      const kicked = await gateway.triggerSync(resolved.rec.instanceId);
      if (kicked) {
        for (let i = 0; i < 2; i++) {
          await new Promise(res => setTimeout(res, 4000));
          const retry = await gateway.listChats(resolved.rec.instanceId);
          if (retry.length > 0) {
            return {
              chats: await this.enrichChats(
                user.id,
                resolved.connId,
                resolved.rec,
                retry
              ),
            };
          }
        }
      }
    }
    return { chats };
  }

  /**
   * WS-MAXP — Enrich raw gateway chat rows with a last-message preview
   * (`last_text` / `last_type` / `last_from_me`) and a REAL `unread` count.
   *
   * ONE extra gateway call: the latest 300 messages across ALL chats (the
   * gateway's queryMessages without a chatJid filter, ts DESC). Grouped by
   * chat_jid, the first row per chat is its last message; inbound rows newer
   * than the chat's read watermark (maxReadKey, set by POST /read on open —
   * falling back to the record's connectedAt for never-opened chats) count as
   * unread. A chat whose last message fell outside the 300-row window simply
   * stays un-enriched — the FE renders it exactly like before.
   *
   * Fail-soft: ANY error returns the original rows untouched.
   */
  private async enrichChats(
    userId: string,
    connId: string,
    rec: WhatsappMaxRecord,
    chats: any[]
  ): Promise<any[]> {
    try {
      if (!Array.isArray(chats) || chats.length === 0) return chats;
      const recent = await gateway.listMessages(rec.instanceId, '', 300);
      if (!Array.isArray(recent) || recent.length === 0) return chats;
      interface ChatAgg {
        lastText: string | null;
        lastType: string | null;
        lastFromMe: boolean;
        inbound: number[];
      }
      const byChat = new Map<string, ChatAgg>();
      // `recent` is newest-first — the first row seen per chat IS its last message.
      for (const m of recent) {
        const jid =
          typeof m?.chat_jid === 'string' && m.chat_jid
            ? m.chat_jid
            : typeof m?.chatJid === 'string'
              ? m.chatJid
              : '';
        if (!jid) continue;
        const fromMe = m?.from_me === true || m?.fromMe === true;
        let agg = byChat.get(jid);
        if (!agg) {
          agg = {
            lastText:
              typeof m?.text === 'string'
                ? m.text
                : typeof m?.text_body === 'string'
                  ? m.text_body
                  : null,
            lastType: typeof m?.type === 'string' ? m.type : null,
            lastFromMe: fromMe,
            inbound: [],
          };
          byChat.set(jid, agg);
        }
        if (!fromMe) {
          const rawTs = m?.ts ?? m?.timestamp;
          const tsMs = rawTs ? new Date(rawTs).getTime() : NaN;
          if (Number.isFinite(tsMs)) agg.inbound.push(tsMs);
        }
      }
      const fallbackMark = Number(rec.connectedAt) || 0;
      const out: any[] = [];
      for (const c of chats) {
        const jid = typeof c?.jid === 'string' ? c.jid : '';
        const agg = jid ? byChat.get(jid) : undefined;
        if (!agg) {
          out.push(c);
          continue;
        }
        let mark = fallbackMark;
        try {
          const v = await (this.redis as any).get(
            maxReadKey(userId, connId, hashJid(jid))
          );
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) mark = n;
        } catch {
          /* fallbackMark */
        }
        const unread = agg.inbound.reduce(
          (acc, t) => (t > mark ? acc + 1 : acc),
          0
        );
        out.push({
          ...c,
          last_text: agg.lastText,
          last_type: agg.lastType,
          last_from_me: agg.lastFromMe,
          unread,
        });
      }
      return out;
    } catch {
      return chats;
    }
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
    @Query('fromMe') fromMeRaw: string,
    @Query('connId') connIdRaw: string
  ): Promise<{ messages: unknown[] }> {
    this.assertEnabled();
    const chatJid = typeof chatJidRaw === 'string' ? chatJidRaw.trim() : '';
    const limit = Number(limitRaw) || 50;
    // WS-MAXP fix: accept `before` as EITHER ms-since-epoch or an ISO string
    // and normalize to ISO — the gateway parses it with `new Date(value)`,
    // which rejects a ms STRING (the old pass-through silently broke the
    // "load older messages" cursor end-to-end).
    const before = (() => {
      const raw = typeof beforeRaw === 'string' ? beforeRaw.trim() : '';
      if (!raw) return undefined;
      const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      if (!Number.isFinite(ms) || ms <= 0) return undefined;
      return new Date(ms).toISOString();
    })();
    const fromMe =
      fromMeRaw === 'true' ? true : fromMeRaw === 'false' ? false : undefined;
    const connId = typeof connIdRaw === 'string' ? connIdRaw.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved || !resolved.rec.active) return { messages: [] };
    const messages = await gateway.listMessages(
      resolved.rec.instanceId,
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
    @Query('connId') connIdRaw: string,
    @Res({ passthrough: true }) res: Response
  ): Promise<void> {
    this.assertEnabled();
    const messageId = typeof messageIdRaw === 'string' ? messageIdRaw.trim() : '';
    if (!messageId) {
      res.status(400).json({ error: 'messageId required' });
      return;
    }
    const connId = typeof connIdRaw === 'string' ? connIdRaw.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved || !resolved.rec.active) {
      res.status(404).json({ error: 'not_connected' });
      return;
    }
    const result = await gateway.downloadMedia(resolved.rec.instanceId, messageId);
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
    @Query('limit') limitRaw: string,
    @Query('connId') connIdRaw: string
  ): Promise<{ contacts: unknown[] }> {
    this.assertEnabled();
    const limit = Number(limitRaw) || 100;
    const connId = typeof connIdRaw === 'string' ? connIdRaw.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved || !resolved.rec.active) return { contacts: [] };
    const contacts = await gateway.listContacts(resolved.rec.instanceId, limit);
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
    @Body() body: { numbers?: unknown; connId?: unknown }
  ): Promise<{ results: unknown[] }> {
    this.assertEnabled();
    const rawNums = Array.isArray(body?.numbers) ? (body.numbers as unknown[]) : [];
    const numbers: string[] = rawNums
      .map(n => normalizeMsisdn(n))
      .filter(Boolean)
      .slice(0, 100);
    if (!numbers.length) throw new BadRequest('numbers must be a non-empty array');
    // P4 W3: per-connId record.
    const connId =
      typeof body?.connId === 'string' ? body.connId.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved || !resolved.rec.active) throw new BadRequest('not_connected');
    const result = await gateway.checkNumbers(resolved.rec.instanceId, numbers);
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
    @Body() body: { chatJid?: unknown; connId?: unknown }
  ): Promise<{ ok: boolean }> {
    this.assertEnabled();
    const chatJid = typeof body?.chatJid === 'string' ? body.chatJid.trim() : '';
    if (!chatJid) throw new BadRequest('chatJid required');
    // P4 W3: per-connId record.
    const connId =
      typeof body?.connId === 'string' ? body.connId.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved) return { ok: false };
    try {
      const key = maxReadKey(user.id, resolved.connId, hashJid(chatJid));
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
    @Query('chatJid') chatJidRaw: string,
    @Query('connId') connIdRaw: string
  ): Promise<{ enabled: boolean; source: 'chat' | 'default' }> {
    this.assertEnabled();
    const chatJid = typeof chatJidRaw === 'string' ? chatJidRaw.trim() : '';
    if (!chatJid) throw new BadRequest('chatJid required');
    // P4 W3: per-connId record.
    const connId = typeof connIdRaw === 'string' ? connIdRaw.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved) return { enabled: false, source: 'default' };
    // WS-MAXP: report the EFFECTIVE state — an explicit per-chat value wins;
    // otherwise the connection-level autoReplyDefault applies (the same
    // resolution the inbound webhook uses, so the pill never lies).
    try {
      const val = await (this.redis as any).get(
        maxAiKey(user.id, resolved.connId, hashJid(chatJid))
      );
      if (val === '1') return { enabled: true, source: 'chat' };
      if (val === '0') return { enabled: false, source: 'chat' };
    } catch {
      /* fall through to the default below */
    }
    const settings = await this.loadAiSettings(user.id, resolved.connId);
    return { enabled: settings.autoReplyDefault === true, source: 'default' };
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
    @Body() body: { chatJid?: unknown; enabled?: unknown; connId?: unknown }
  ): Promise<{ ok: boolean; enabled: boolean }> {
    this.assertEnabled();
    const chatJid = typeof body?.chatJid === 'string' ? body.chatJid.trim() : '';
    if (!chatJid) throw new BadRequest('chatJid required');
    const enabled = body?.enabled === true || body?.enabled === 'true' || body?.enabled === 1;
    // P4 W3: per-connId record.
    const connId =
      typeof body?.connId === 'string' ? body.connId.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved) return { ok: false, enabled };
    try {
      const key = maxAiKey(user.id, resolved.connId, hashJid(chatJid));
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
  // P4 W3 — GET /api/v1/whatsappmax/accounts
  //   → { accounts: [{ connId, phoneNumber, status, connectedAt, active }] }
  //   Lists ALL of the user's connected WhatsApp accounts (multi-account).
  //   NEVER includes the sealed webhook secret. Best-effort live status refresh
  //   from gateway.getInstance for each account.
  // =========================================================================
  @Throttle('default', { limit: 60, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/accounts')
  async accounts(
    @CurrentUser() user: CurrentUser
  ): Promise<{
    accounts: Array<{
      connId: string;
      phoneNumber: string | null;
      status: string;
      connectedAt: number;
      active: boolean;
    }>;
  }> {
    this.assertEnabled();
    const records = await this.loadRecords(user.id);
    const accounts: Array<{
      connId: string;
      phoneNumber: string | null;
      status: string;
      connectedAt: number;
      active: boolean;
    }> = [];
    for (const rec of records) {
      // Best-effort live status refresh from the gateway.
      let liveStatus = rec.status;
      let livePhone = rec.phoneNumber;
      if (rec.active && rec.instanceId) {
        try {
          const view = await gateway.getInstance(rec.instanceId);
          if (view) {
            liveStatus = view.status || liveStatus;
            if (view.phoneNumber) livePhone = view.phoneNumber;
          }
        } catch {
          /* best-effort — use stored status */
        }
      }
      accounts.push({
        connId: rec.connId,
        phoneNumber: livePhone,
        status: liveStatus,
        connectedAt: rec.connectedAt,
        active: rec.active,
      });
    }
    return { accounts };
  }

  // =========================================================================
  // WS-MAXP — GET /api/v1/whatsappmax/settings?connId=
  //   → { ok, settings, connId? }
  //   Per-connection AI settings (persona/tone/language/auto-reply default +
  //   quick replies). Defaults when nothing stored — the FE always gets a
  //   full record.
  // =========================================================================
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/settings')
  async getSettings(
    @CurrentUser() user: CurrentUser,
    @Query('connId') connIdRaw: string
  ): Promise<{ ok: boolean; settings: WamaxAiSettings; connId?: string }> {
    this.assertEnabled();
    const connId = typeof connIdRaw === 'string' ? connIdRaw.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved) {
      return { ok: true, settings: { ...DEFAULT_WAMAX_AI_SETTINGS } };
    }
    const settings = await this.loadAiSettings(user.id, resolved.connId);
    return { ok: true, settings, connId: resolved.connId };
  }

  // =========================================================================
  // WS-MAXP — POST /api/v1/whatsappmax/settings
  //   { connId?, businessName?, persona?, tone?, language?,
  //     autoReplyDefault?, quickReplies? } → { ok, settings }
  //   Partial merge over the stored record; every field sanitized/clamped by
  //   sanitizeWamaxAiSettings (unknown fields dropped, enums validated).
  // =========================================================================
  @Throttle('strict')
  @Post('/api/v1/whatsappmax/settings')
  async setSettings(
    @CurrentUser() user: CurrentUser,
    @Body()
    body: {
      connId?: unknown;
      businessName?: unknown;
      persona?: unknown;
      tone?: unknown;
      language?: unknown;
      autoReplyDefault?: unknown;
      quickReplies?: unknown;
    }
  ): Promise<{ ok: boolean; settings: WamaxAiSettings }> {
    this.assertEnabled();
    const connId =
      typeof body?.connId === 'string' ? body.connId.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved) throw new BadRequest('not_connected');
    const current = await this.loadAiSettings(user.id, resolved.connId);
    // Only merge the fields present in the body — an omitted field keeps its
    // stored value (partial update semantics for the FE form).
    const patch: Record<string, unknown> = {};
    const src = (body ?? {}) as Record<string, unknown>;
    for (const field of [
      'businessName',
      'persona',
      'tone',
      'language',
      'autoReplyDefault',
      'quickReplies',
    ]) {
      if (field in src && src[field] !== undefined) patch[field] = src[field];
    }
    const merged = sanitizeWamaxAiSettings({ ...current, ...patch });
    try {
      await this.cache.set(
        maxAiSettingsKey(user.id, resolved.connId),
        merged,
        { ttl: MAX_TTL_MS }
      );
    } catch {
      /* best-effort — the sanitized record is still returned */
    }
    return { ok: true, settings: merged };
  }

  // =========================================================================
  // WS-MAXP — GET /api/v1/whatsappmax/avatar?jid=&connId=
  //   → { url: string | null }
  //   Profile-photo URL for a chat/contact JID (WhatsApp CDN link, directly
  //   renderable in an <img>). Redis-cached (12h hit / 1h null) because the
  //   gateway lookup is a LIVE session call. null = hidden/unavailable — the
  //   FE falls back to initials.
  // =========================================================================
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/whatsappmax/avatar')
  async avatar(
    @CurrentUser() user: CurrentUser,
    @Query('jid') jidRaw: string,
    @Query('connId') connIdRaw: string
  ): Promise<{ url: string | null }> {
    this.assertEnabled();
    const jid = typeof jidRaw === 'string' ? jidRaw.trim() : '';
    if (!jid) return { url: null };
    const connId = typeof connIdRaw === 'string' ? connIdRaw.trim() : '';
    const resolved = await this.resolveRecord(user.id, connId || undefined);
    if (!resolved || !resolved.rec.active) return { url: null };
    const cacheKey = maxAvatarKey(resolved.connId, hashJid(jid));
    try {
      const cached = await this.cache.get<{ url: string | null }>(cacheKey);
      if (cached && typeof cached === 'object' && 'url' in cached) {
        return { url: cached.url ?? null };
      }
    } catch {
      /* cache miss path below */
    }
    const url = await gateway.getProfilePicture(resolved.rec.instanceId, jid);
    try {
      await this.cache.set(
        cacheKey,
        { url: url ?? null },
        { ttl: url ? AVATAR_TTL_MS : AVATAR_NULL_TTL_MS }
      );
    } catch {
      /* best-effort */
    }
    return { url: url ?? null };
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
    // P4 W3: per-connId key (id is the connId URL param).
    let rec: WhatsappMaxRecord | undefined;
    try {
      rec = await this.cache.get<WhatsappMaxRecord>(
        maxKey(conn.userId, id)
      );
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
    // P4 W3: per-connId key for the record re-arm.
    try {
      await this.cache.set(maxChatKey(id), { chatJid }, { ttl: MAX_TTL_MS });
      await this.cache.set(maxKey(conn.userId, id), rec, { ttl: MAX_TTL_MS });
      await this.cache.set(maxConnKey(id), conn, { ttl: MAX_TTL_MS });
    } catch {
      /* best-effort */
    }

    if (text) {
      // P4 E1.3: check per-chat AI toggle before enqueueing a run.
      // P4 W3: per-connId scoped AI key.
      // WS-MAXP: an explicit per-chat value ('1'/'0') wins; when the chat has
      // never been toggled, the connection-level autoReplyDefault applies.
      let aiEnabled = false;
      try {
        const aiVal = await (this.redis as any).get(
          maxAiKey(conn.userId, id, hashJid(chatJid))
        );
        if (aiVal === '1') {
          aiEnabled = true;
        } else if (aiVal === '0') {
          aiEnabled = false;
        } else {
          const settings = await this.loadAiSettings(conn.userId, id);
          aiEnabled = settings.autoReplyDefault === true;
        }
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
      // WS-MAXP: thread the shop's configured AI persona (business context +
      // tone + language) into the run — createAgentRun prepends `persona` to
      // the loop's system prompt. undefined for unconfigured shops ⇒ the run
      // stays byte-identical to the legacy behavior.
      let runPersona: string | undefined;
      try {
        runPersona = buildWamaxRunPersona(
          await this.loadAiSettings(userId, connId)
        );
      } catch {
        runPersona = undefined;
      }
      const run = await createAgentRun(this.redis as any, {
        userId,
        agentId: WHATSAPPMAX_AGENT,
        archetype: WHATSAPPMAX_AGENT,
        prompt: text,
        channel: 'whatsapp',
        threadId: `wamax:${connId}`,
        persona: runPersona,
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

  // =========================================================================
  // WS-AI — synchronous AI assist (draft / summary / translate).
  //
  // Direct-call the SAME OpenAI-compatible cdz-flash brain the bridge
  // controller's fast path uses, but SYNCHRONOUSLY (request/response, no
  // job-queue/run-engine round trip) since these back a live "help me write
  // this reply" UI affordance rather than an autonomous agent turn. Every
  // handler is wrapped so nothing ever throws raw to the client, message
  // contents are never logged, and the AI key never appears in a log line.
  // =========================================================================

  /**
   * Shared LLM caller for all three assist routes. POSTs to the cdz-flash
   * OpenAI-compatible endpoint with a bounded timeout; returns the trimmed
   * completion text, or null on ANY failure (missing key, non-2xx, timeout,
   * malformed body, empty content). Callers translate a null into the
   * uniform `{ ok: false, error: 'ai_unavailable' }` shape.
   */
  private async callWamaxAi(
    messages: Array<{ role: string; content: string }>,
    maxTokens = 500
  ): Promise<string | null> {
    if (!WAMAX_AI_KEY) return null;
    try {
      const response = await fetch(`${WAMAX_AI_ORIGIN}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WAMAX_AI_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: WAMAX_AI_MODEL,
          messages,
          stream: false,
          max_tokens: Math.max(1, Math.min(4096, maxTokens || 500)),
        }),
        signal: AbortSignal.timeout(WAMAX_AI_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const data = (await response.json().catch(() => null)) as any;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) return null;
      return content.trim();
    } catch {
      // Network error, abort/timeout, or malformed response — never throw.
      return null;
    }
  }

  /** Normalise + cap an owner-supplied free-text field (instruction/text). */
  private clampAiInput(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, WAMAX_AI_INPUT_MAX_CHARS);
  }

  /**
   * Render a fetched message list as a compact "Client: …" / "Moi: …"
   * transcript for the LLM prompt. Skips rows with no usable text.
   */
  private renderTranscript(messages: any[]): string {
    const lines: string[] = [];
    for (const m of messages) {
      const text = typeof m?.text === 'string' ? m.text.trim() : '';
      if (!text) continue;
      lines.push(`${m?.fromMe ? 'Moi' : 'Client'}: ${text}`);
    }
    return lines.join('\n');
  }

  // =========================================================================
  // POST /api/v1/whatsappmax/ai/draft
  //   body { connId, chatJid, instruction? }
  //   → { ok: true, draft } | { ok: false, error }
  //   Drafts a WhatsApp reply on behalf of the owner from the recent chat
  //   context (+ optional free-text instruction).
  // =========================================================================
  @Throttle('default', { limit: 60, ttl: 60_000 })
  @Post('/api/v1/whatsappmax/ai/draft')
  async aiDraft(
    @CurrentUser() user: CurrentUser,
    @Body()
    body: { connId?: string; chatJid?: string; instruction?: string }
  ): Promise<{ ok: boolean; draft?: string; error?: string }> {
    try {
      this.assertEnabled();
      const connId =
        typeof body?.connId === 'string' ? body.connId.trim() : '';
      const chatJid =
        typeof body?.chatJid === 'string' ? body.chatJid.trim() : '';
      const instruction = this.clampAiInput(body?.instruction);
      if (!chatJid) return { ok: false, error: 'chatJid required' };

      const resolved = await this.resolveRecord(user.id, connId || undefined);
      if (!resolved || !resolved.rec.active) {
        return { ok: false, error: 'not_connected' };
      }

      let transcript = '';
      try {
        const recent = await gateway.listMessages(
          resolved.rec.instanceId,
          chatJid,
          20
        );
        transcript = this.renderTranscript(recent);
      } catch {
        transcript = '';
      }

      // WS-MAXP: the draft speaks with the shop's configured voice — business
      // name + persona/context + tone + language from the per-connection AI
      // settings. Defaults reproduce the original fixed prompt.
      const settings = await this.loadAiSettings(user.id, resolved.connId);
      const promptParts: string[] = [
        settings.businessName
          ? `Tu rédiges une réponse WhatsApp AU NOM de l’entreprise « ${settings.businessName} » (le compte "Moi" dans la conversation ci-dessous).`
          : 'Tu rédiges une réponse WhatsApp AU NOM du propriétaire de l’entreprise (le compte "Moi" dans la conversation ci-dessous).',
      ];
      if (settings.persona) {
        promptParts.push(`Contexte de l’entreprise : ${settings.persona}`);
      }
      promptParts.push(wamaxLangLine(settings.language));
      promptParts.push(wamaxToneLine(settings.tone));
      promptParts.push(
        'Sois concis, naturel, dans le registre WhatsApp (pas de formalisme excessif). ' +
          'N’ajoute AUCUN commentaire, guillemet ou préambule : réponds UNIQUEMENT avec le texte du message à envoyer.'
      );
      const systemPrompt = promptParts.join(' ');

      const userParts: string[] = [];
      if (transcript) {
        userParts.push(`Conversation récente :\n${transcript}`);
      } else {
        userParts.push('Aucun historique de conversation disponible.');
      }
      if (instruction) {
        userParts.push(`Consigne du propriétaire : ${instruction}`);
      }

      const draft = await this.callWamaxAi([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userParts.join('\n\n') },
      ]);
      if (!draft) return { ok: false, error: 'ai_unavailable' };
      return { ok: true, draft: draft.trim() };
    } catch {
      return { ok: false, error: 'ai_unavailable' };
    }
  }

  // =========================================================================
  // POST /api/v1/whatsappmax/ai/summary
  //   body { connId, chatJid }
  //   → { ok: true, summary } | { ok: false, error }
  //   Summarizes the recent conversation in French for the business owner.
  // =========================================================================
  @Throttle('default', { limit: 60, ttl: 60_000 })
  @Post('/api/v1/whatsappmax/ai/summary')
  async aiSummary(
    @CurrentUser() user: CurrentUser,
    @Body() body: { connId?: string; chatJid?: string }
  ): Promise<{ ok: boolean; summary?: string; error?: string }> {
    try {
      this.assertEnabled();
      const connId =
        typeof body?.connId === 'string' ? body.connId.trim() : '';
      const chatJid =
        typeof body?.chatJid === 'string' ? body.chatJid.trim() : '';
      if (!chatJid) return { ok: false, error: 'chatJid required' };

      const resolved = await this.resolveRecord(user.id, connId || undefined);
      if (!resolved || !resolved.rec.active) {
        return { ok: false, error: 'not_connected' };
      }

      let transcript = '';
      try {
        const recent = await gateway.listMessages(
          resolved.rec.instanceId,
          chatJid,
          60
        );
        transcript = this.renderTranscript(recent);
      } catch {
        transcript = '';
      }
      if (!transcript) return { ok: false, error: 'no_messages' };

      const systemPrompt =
        'Résume cette conversation WhatsApp en français, à l’attention du propriétaire de l’entreprise. ' +
        'Utilise des puces courtes couvrant : qui est le client, ce qu’il veut, le statut de la demande, et toute action à faire. ' +
        'Reste factuel et concis.';

      const summary = await this.callWamaxAi(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Conversation :\n${transcript}` },
        ],
        700
      );
      if (!summary) return { ok: false, error: 'ai_unavailable' };
      return { ok: true, summary: summary.trim() };
    } catch {
      return { ok: false, error: 'ai_unavailable' };
    }
  }

  // =========================================================================
  // POST /api/v1/whatsappmax/ai/translate
  //   body { connId, chatJid, text? }
  //   → { ok: true, translation, original } | { ok: false, error }
  //   Translates the given text, or — when omitted — the last inbound
  //   message, to French (or to English when already French).
  // =========================================================================
  @Throttle('default', { limit: 60, ttl: 60_000 })
  @Post('/api/v1/whatsappmax/ai/translate')
  async aiTranslate(
    @CurrentUser() user: CurrentUser,
    @Body()
    body: { connId?: string; chatJid?: string; text?: string }
  ): Promise<{
    ok: boolean;
    translation?: string;
    original?: string;
    error?: string;
  }> {
    try {
      this.assertEnabled();
      const connId =
        typeof body?.connId === 'string' ? body.connId.trim() : '';
      const chatJid =
        typeof body?.chatJid === 'string' ? body.chatJid.trim() : '';
      const explicitText = this.clampAiInput(body?.text);

      let original = explicitText;
      if (!original) {
        if (!chatJid) return { ok: false, error: 'chatJid required' };
        const resolved = await this.resolveRecord(
          user.id,
          connId || undefined
        );
        if (!resolved || !resolved.rec.active) {
          return { ok: false, error: 'not_connected' };
        }
        try {
          const recent = await gateway.listMessages(
            resolved.rec.instanceId,
            chatJid,
            20,
            undefined,
            false
          );
          for (let i = recent.length - 1; i >= 0; i--) {
            const text =
              typeof recent[i]?.text === 'string' ? recent[i].text.trim() : '';
            if (text) {
              original = text;
              break;
            }
          }
        } catch {
          original = '';
        }
        if (!original) return { ok: false, error: 'no_message' };
        original = this.clampAiInput(original);
      }

      const systemPrompt =
        'Traduis le texte suivant en français. S’il est déjà en français, traduis-le en anglais. ' +
        'Ne réponds qu’avec la traduction, sans aucun commentaire ni guillemet.';

      const translation = await this.callWamaxAi([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: original },
      ]);
      if (!translation) return { ok: false, error: 'ai_unavailable' };
      return { ok: true, translation: translation.trim(), original };
    } catch {
      return { ok: false, error: 'ai_unavailable' };
    }
  }
}

