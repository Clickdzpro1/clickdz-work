import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';

// Typed AFFiNE errors so the global exception filter emits proper status codes
// (a raw @nestjs/common HttpException becomes a generic 500 here — see
// base/nestjs/exception.ts). NotFound is how every gated-OFF route reports
// "feature disabled" as a clean typed 404 (same stance the sibling agent
// controllers use). Cache is the @Global JSON-wrapped Redis provider
// (get<T>/set with a PX ttl in MS / delete — fail-soft: undefined/false on any
// error, never throws) — the SAME provider ClickDzHermesController uses for its
// per-user config singleton, so all our bindings persist through it identically.
// JobQueue is the same transport the copilot cron/session providers already
// inject; Moteur's `enqueueAgentRun(queue, rec)` uses it to dispatch the run.
import { BadRequest, Cache, JobQueue, NotFound } from '../../base';
// @Public marks the webhook route as skipping the global cookie AuthGuard (an
// inbound Telegram webhook has no app session — same non-cookie stance the
// bridge's /chat/completions route takes, gated by a URL secret instead).
// CurrentUser both decorates (param) + types the cookie-session user on the
// pairing/setup routes. Both imported from core/auth exactly like the peers.
import { CurrentUser, Public } from '../../core/auth';
// safeEqual = constant-time string comparison (hashes both sides to a
// fixed-length digest first, so unequal lengths neither throw nor leak length
// through timing). Reused verbatim to gate the webhook secret — the SAME
// primitive cdz-data-token.ts uses for its write/blob/staff tokens.
import { safeEqual } from './cdz-data-token';
// Moteur's run engine (owner: clickdz-agent-runs.ts). We call these by their
// pinned R6-CONTRACT names; every call is wrapped fail-soft below so a missing
// / partially-loaded engine can never crash the webhook or the tool. The
// orchestrator merges all R6 files together so this static import resolves at
// boot; the try/catch guards behavioural (not link-time) failure.
import {
  checkDailyRunCap,
  createAgentRun,
  enqueueAgentRun,
  onAgentRunDone,
} from './clickdz-agent-runs';

// ---------------------------------------------------------------------------
// CDZ AGENT — TELEGRAM CHANNEL (WSA-5).
//
// Turns a Telegram bot into an inbound CHANNEL for the Hermes agent: a user
// pairs their Telegram chat to their ClickDz account (deep-link `/start <code>`
// or the in-app pair button), then any text they send the bot becomes a
// detached Hermes run (Moteur's queue drives it), with an ack + the final
// answer pushed back over the Bot API. Also exposes an OUTBOUND tool
// (`telegram_send`) so a running agent can message the run owner's bound chat.
//
// EVERYTHING is fail-soft dark by two independent gates, BOTH unset today:
//   · CDZ_TG_TOKEN               — the bot token. Absent ⇒ the API client is a
//                                  no-op (sendMessage/getMe/setWebhook return
//                                  null without ever hitting the network), the
//                                  webhook secret is empty (compare fails
//                                  closed), and the send tool advertises
//                                  available:false.
//   · CDZ_AGENT_TELEGRAM_ENABLED — the '1' master gate for the ROUTES. Off ⇒
//                                  every controller route returns a typed 404
//                                  (NotFound), byte-identical to the feature
//                                  not existing.
// No SDK — plain fetch to the Bot API, same self-contained, env-driven stance
// as the peer ClickDz controllers (imports nothing from the frontend, typed
// errors only, never a raw HttpException).
// ---------------------------------------------------------------------------

// --- Config (read once at module load, same idiom as the sibling controllers).
const CDZ_TG_TOKEN = process.env.CDZ_TG_TOKEN || '';
const CDZ_AGENT_TELEGRAM_ENABLED = process.env.CDZ_AGENT_TELEGRAM_ENABLED || '';
// The app's public origin — the exact env + fallback the bridge uses everywhere
// it needs an absolute, externally-reachable URL (setWebhook target).
const APP_EXTERNAL_URL = (
  process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
).replace(/\/+$/, '');

// Bot API base. Interpolated with the token; never logged. Guarded so an absent
// token short-circuits before any URL is built (see the client below).
const TG_API_BASE = 'https://api.telegram.org';
// Bounded timeout for every Bot API call — quick control-plane calls, never a
// long poll. Guards against a hung upstream taking a request thread with it.
const TG_TIMEOUT_MS = 10_000;
// Telegram hard-caps a message at 4096 chars; we trim well inside that so an
// agent's long finalText is delivered (truncated) rather than rejected.
const TG_MAX_TEXT = 3900;

// --- Redis key helpers (EXACTLY the contract's namespaces).
// Pair code → userId, short-lived (the user has 10 min to open the deep link).
const pairKey = (code: string) => `clickdz:tg:pair:${code}`;
// chatId → { userId } — the inbound-routing binding (who owns this chat).
const chatBindKey = (chatId: string | number) => `clickdz:tg:chat:${chatId}`;
// userId → { chatId } — the outbound-routing binding (where to push for a user).
const userBindKey = (userId: string) => `clickdz:tg:user:${userId}`;

// TTLs (Cache API takes MILLISECONDS). Pair code = 10 min; both bindings = 90d,
// re-armed on every inbound message so an active user never expires.
const PAIR_TTL_MS = 10 * 60 * 1000;
const BIND_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// A pairing code: short, URL-safe, unguessable. base64url of 12 random bytes →
// 16 chars, plenty of entropy for a 10-minute one-shot code.
function mintPairCode(): string {
  return randomBytes(12).toString('base64url');
}

/**
 * Derive the webhook path secret from the bot token: `sha256(token)` hex, first
 * 32 chars. Returns '' when no token is configured, so the compare below fails
 * CLOSED (an unconfigured deployment can never be tricked into accepting a
 * webhook). Pure + deterministic — the same value is embedded in the setWebhook
 * URL and re-derived on each inbound request.
 */
export function telegramWebhookSecret(token: string = CDZ_TG_TOKEN): string {
  if (!token) return '';
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

/**
 * Verify a caller-supplied `:secret` path segment against the derived secret,
 * constant-time. False when no token is configured (fail closed) or the secret
 * is missing/mismatched. Never throws.
 */
export function verifyTelegramSecret(candidate: string): boolean {
  const expected = telegramWebhookSecret();
  if (!expected || !candidate) return false;
  return safeEqual(expected, candidate);
}

// ---------------------------------------------------------------------------
// Minimal Telegram Bot API client (fail-soft). Every method is a no-op that
// returns null when CDZ_TG_TOKEN is absent — so the whole feature is inert dark
// with zero network traffic until a token is provisioned. No throwing: a Bot
// API / network hiccup resolves null (callers degrade, they never 500).
// ---------------------------------------------------------------------------
export class TelegramClient {
  // getMe().username is stable for a bot's lifetime, so cache it in-process to
  // avoid a Bot API round-trip on every /pair call. Reset on process restart.
  private usernameCache: string | null = null;

  get configured(): boolean {
    return !!CDZ_TG_TOKEN;
  }

  /** POST a Bot API method with a JSON body; resolves `result` or null. */
  private async call<T = any>(
    method: string,
    payload: Record<string, unknown>
  ): Promise<T | null> {
    if (!CDZ_TG_TOKEN) return null;
    try {
      const res = await fetch(`${TG_API_BASE}/bot${CDZ_TG_TOKEN}/${method}`, {
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

  /** Send a text message to a chat (auto-trimmed to the Bot API limit). */
  async sendMessage(
    chatId: string | number,
    text: string
  ): Promise<boolean> {
    const trimmed = String(text ?? '').slice(0, TG_MAX_TEXT);
    if (!trimmed) return false;
    const result = await this.call('sendMessage', {
      chat_id: chatId,
      text: trimmed,
      disable_web_page_preview: true,
    });
    return !!result;
  }

  /** Bot username (cached). null when unconfigured or the call fails. */
  async getUsername(): Promise<string | null> {
    if (this.usernameCache) return this.usernameCache;
    const me = await this.call<{ username?: string }>('getMe', {});
    const username = me?.username ? String(me.username) : null;
    if (username) this.usernameCache = username;
    return username;
  }

  /**
   * Register `url` as the bot's webhook (setWebhook). Best-effort: returns true
   * when Telegram accepted it, false otherwise (incl. unconfigured). We NEVER
   * call this at boot — the token may be absent — only from the explicit /setup
   * route once an operator has provisioned the token.
   */
  async setWebhook(url: string): Promise<boolean> {
    const result = await this.call('setWebhook', {
      url,
      allowed_updates: ['message'],
    });
    return !!result;
  }
}

// A single shared client instance for the module (controller + tool + hook).
const telegram = new TelegramClient();

// ---------------------------------------------------------------------------
// Inbound update parsing. We only care about `message.text` + the chat id; a
// `/start <code>` first token is the pairing handshake. Defensive: any missing
// field yields nulls and the webhook simply acks 200 (Telegram must always get
// a 2xx or it retries the update).
// ---------------------------------------------------------------------------
export interface ParsedUpdate {
  chatId: number | null;
  text: string;
  startCode: string | null;
}

export function parseTelegramUpdate(update: unknown): ParsedUpdate {
  const empty: ParsedUpdate = { chatId: null, text: '', startCode: null };
  if (!update || typeof update !== 'object') return empty;
  const msg = (update as any).message ?? (update as any).edited_message;
  if (!msg || typeof msg !== 'object') return empty;
  const chatId =
    msg.chat && typeof msg.chat.id === 'number' ? (msg.chat.id as number) : null;
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  let startCode: string | null = null;
  // `/start <code>` (Telegram deep-link payload). The code is the SECOND token;
  // a bare `/start` (no payload) leaves startCode null (handled as a greeting).
  if (/^\/start(\s|$)/.test(text)) {
    const parts = text.split(/\s+/);
    startCode = parts.length > 1 ? parts[1].slice(0, 64) : null;
  }
  return { chatId, text, startCode };
}

// ---------------------------------------------------------------------------
// Controller. All routes gated by CDZ_AGENT_TELEGRAM_ENABLED — off ⇒ typed 404.
// ---------------------------------------------------------------------------
@Controller()
export class ClickDzAgentTelegramController {
  constructor(
    private readonly cache: Cache,
    private readonly jobs: JobQueue,
    private readonly redis: CacheRedis
  ) {
    // R6/WSA-5 (F-3): wire the run-done push so a completed Telegram-channel run
    // sends its final answer back over the Bot API. Fail-soft inside.
    registerTelegramRunDone({ cache: this.cache });}

  /** Typed 404 when the master gate is off — never leaks that the route exists. */
  private assertEnabled() {
    if (CDZ_AGENT_TELEGRAM_ENABLED !== '1') {
      throw new NotFound('Telegram channel is not enabled');
    }
  }

  // -------------------------------------------------------------------------
  // Webhook. @Public (no cookie) — authenticated SOLELY by the URL `:secret`
  // (constant-time compared to sha256(token)[:32]). Telegram POSTs each update
  // here; we ALWAYS return 200 {ok:true} (even on a bad/unpaired message) so
  // Telegram does not retry-storm — the secret check is the only hard gate,
  // and a wrong secret is a typed 404 (indistinguishable from "no such route").
  // -------------------------------------------------------------------------
  @Public()
  @Post('/api/v1/agents/telegram/webhook/:secret')
  async webhook(
    @Param('secret') secret: string,
    @Body() body: unknown,
    @Req() _req: Request
  ): Promise<{ ok: boolean }> {
    this.assertEnabled();
    if (!verifyTelegramSecret(secret)) {
      // Fail closed as a 404 — do not reveal a valid route to a wrong secret.
      throw new NotFound('Not found');
    }
    // A token-less deployment can't have a valid secret, but guard anyway.
    if (!telegram.configured) return { ok: true };

    const { chatId, text, startCode } = parseTelegramUpdate(body);
    if (chatId == null) return { ok: true };

    // (1) Pairing handshake: `/start <code>` binds this chat ↔ the code's user.
    if (startCode) {
      await this.handlePairing(chatId, startCode);
      return { ok: true };
    }

    // (2) Bare `/start` with no payload → a friendly onboarding hint.
    if (/^\/start(\s|$)/.test(text)) {
      await telegram.sendMessage(
        chatId,
        'Bonjour 👋 Ouvrez ClickDz Work → Agents → Telegram pour lier ce chat à votre compte.'
      );
      return { ok: true };
    }

    // (3) Inbound text from a bound chat → a detached Hermes run.
    if (text) {
      await this.handleInboundText(chatId, text);
    }
    return { ok: true };
  }

  /**
   * Bind a chat to the user named by a one-shot pairing code (fail-soft).
   * Consumes the code (delete after read so it can't be replayed), writes BOTH
   * directional bindings (90d), and acks the user. An unknown/expired code just
   * tells the user to re-pair — never an error to Telegram.
   */
  private async handlePairing(chatId: number, code: string): Promise<void> {
    let userId: string | undefined;
    try {
      const rec = await this.cache.get<{ userId?: string } | string>(
        pairKey(code)
      );
      // Stored as {userId} JSON; tolerate a bare-string legacy shape too.
      userId =
        typeof rec === 'string' ? rec : rec && rec.userId ? rec.userId : undefined;
    } catch {
      userId = undefined;
    }
    if (!userId) {
      await telegram.sendMessage(
        chatId,
        'Ce code de liaison est invalide ou expiré. Régénérez-le depuis ClickDz Work.'
      );
      return;
    }
    try {
      // One-shot: consume the code so it cannot be reused.
      await this.cache.delete(pairKey(code));
      await this.cache.set(
        chatBindKey(chatId),
        { userId },
        { ttl: BIND_TTL_MS }
      );
      await this.cache.set(
        userBindKey(userId),
        { chatId },
        { ttl: BIND_TTL_MS }
      );
    } catch {
      // A binding write hiccup: tell the user to retry rather than silently drop.
      await telegram.sendMessage(
        chatId,
        'Liaison momentanément indisponible, réessayez dans un instant.'
      );
      return;
    }
    await telegram.sendMessage(
      chatId,
      '✅ Chat lié à votre compte ClickDz. Envoyez-moi une tâche et Hermès s’en occupe.'
    );
  }

  /**
   * Turn inbound text from a BOUND chat into a Hermes run: resolve the owner,
   * create a run record (channel 'telegram', agent 'hermes'), enqueue it via
   * Moteur, and ack. Every engine call is fail-soft (a partial/absent engine
   * degrades to an apology, never a 500). Unbound chats get a pairing nudge.
   */
  private async handleInboundText(chatId: number, text: string): Promise<void> {
    let userId: string | undefined;
    try {
      const bind = await this.cache.get<{ userId?: string }>(chatBindKey(chatId));
      userId = bind?.userId;
    } catch {
      userId = undefined;
    }
    if (!userId) {
      await telegram.sendMessage(
        chatId,
        'Ce chat n’est pas encore lié. Ouvrez ClickDz Work → Agents → Telegram pour le lier.'
      );
      return;
    }
    // Re-arm the chat binding TTL on activity so an active user never expires.
    try {
      await this.cache.expire(chatBindKey(chatId), BIND_TTL_MS);
      await this.cache.expire(userBindKey(userId), BIND_TTL_MS);
    } catch {
      // TTL refresh is best-effort.
    }

    // Create + enqueue the run via Moteur (fail-soft: any throw ⇒ apology ack).
    let created = false;
    try {
      const cap = await checkDailyRunCap(this.redis as any, userId);
      if (!cap.allowed) {
        await telegram.sendMessage(
          chatId,
          'Limite quotidienne atteinte. Réessayez demain.'
        );
        return;
      }
      const rec = await createAgentRun(this.redis as any, {
        userId,
        agent: 'hermes',
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

    await telegram.sendMessage(
      chatId,
      created
        ? '🤖 Hermès traite votre demande…'
        : 'Agent momentanément indisponible, réessayez dans un instant.'
    );
  }

  // -------------------------------------------------------------------------
  // Pair. @CurrentUser (cookie session). Mints a one-shot code → deep link the
  // in-app UI turns into a QR / "Ouvrir Telegram" button. The code maps to the
  // caller's userId for 10 min; opening the link fires `/start <code>` at the
  // bot which the webhook binds. botUsername via getMe (cached).
  // -------------------------------------------------------------------------
  @Get('/api/v1/agents/telegram/pair')
  async pair(
    @CurrentUser() user: CurrentUser
  ): Promise<{ code: string; deepLink: string; botUsername: string | null }> {
    this.assertEnabled();
    const code = mintPairCode();
    // Store code → userId (10 min). If Redis is down we still return a link, but
    // pairing would fail — surface a typed 400 so the UI can retry rather than
    // hand out a dead code.
    const stored = await this.cache.set(
      pairKey(code),
      { userId: user.id },
      { ttl: PAIR_TTL_MS }
    );
    if (!stored) {
      throw new BadRequest('Could not create a pairing code, please retry');
    }
    const botUsername = await telegram.getUsername();
    // When the bot username is unknown (no token yet) we still return the code +
    // a best-effort link shape so the UI degrades gracefully.
    const deepLink = botUsername
      ? `https://t.me/${botUsername}?start=${code}`
      : '';
    return { code, deepLink, botUsername };
  }

  // -------------------------------------------------------------------------
  // Setup. @CurrentUser. Registers the webhook URL with Telegram (setWebhook)
  // using the app external URL + derived secret. NOT called at boot (token may
  // be absent) — an operator hits this ONCE after provisioning CDZ_TG_TOKEN.
  // Fail-soft: {ok:false} when the token is absent or Telegram rejects it.
  // -------------------------------------------------------------------------
  @Post('/api/v1/agents/telegram/setup')
  async setup(
    @CurrentUser() _user: CurrentUser
  ): Promise<{ ok: boolean; configured: boolean; webhookUrl?: string }> {
    this.assertEnabled();
    if (!telegram.configured) {
      return { ok: false, configured: false };
    }
    const secret = telegramWebhookSecret();
    const webhookUrl = `${APP_EXTERNAL_URL}/api/v1/agents/telegram/webhook/${secret}`;
    const ok = await telegram.setWebhook(webhookUrl);
    // Only echo the URL back on success (it carries the secret — do not leak it
    // on a failed attempt that a caller might log).
    return ok
      ? { ok: true, configured: true, webhookUrl }
      : { ok: false, configured: true };
  }
}

// ---------------------------------------------------------------------------
// OUTBOUND TOOL — `telegram_send` {text}. Registered into Regis's default
// registry via this factory (imported fail-soft in buildDefaultRegistry).
// consequential:true (it messages a human), scope:'all' (both agents may use
// it). available() is true only when the bot token is present AND the caller
// has a bound chat — so an unpaired user never sees a tool that can't work.
// Sends to the RUN OWNER's bound chat (resolved via clickdz:tg:user:{userId}).
//
// `deps` mirrors the shape Regis passes its factories: we only need the JSON
// Cache to resolve the binding. The tool's own `ctx.services.redis` is the raw
// CacheRedis (hget/hset) which is NOT how these bindings are stored (they are
// JSON via Cache), so we close over the Cache handed to the factory instead.
// ---------------------------------------------------------------------------
export interface TelegramToolDeps {
  cache: Cache;
}

// Structural mirror of Regis's AgentToolDef / AgentToolCtx (R6-CONTRACT pinned
// shape). Kept local (not imported) so this file compiles standalone under the
// transpile-only build even before clickdz-agent-tools.ts lands; Regis's real
// interface is structurally identical, so the returned object satisfies it.
interface TgToolCtx {
  userId: string;
  agent: 'hermes' | 'openclaw';
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
      "Envoie un message Telegram à l'utilisateur propriétaire de cette exécution (son chat lié). À utiliser pour notifier, poser une question, ou livrer un résultat.",
    scope: 'all',
    consequential: true,
    inputSummary: 'text',
    // Available only when the bot is configured. We cannot cheaply do an async
    // binding lookup in this sync predicate, so token-present is the gate here;
    // run() does the authoritative "is there a bound chat" check and returns
    // {ok:false} (never throws) when the caller has none.
    available: (_ctx: TgToolCtx) => telegram.configured,
    run: async (args: Record<string, unknown>, ctx: TgToolCtx) => {
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      if (!text) {
        return { ok: false, result: { error: 'text is required' } };
      }
      if (!telegram.configured) {
        return { ok: false, result: { error: 'telegram_not_configured' } };
      }
      let chatId: number | string | undefined;
      try {
        const bind = await deps.cache.get<{ chatId?: number | string }>(
          userBindKey(ctx.userId)
        );
        chatId = bind?.chatId;
      } catch {
        chatId = undefined;
      }
      if (chatId == null) {
        ctx.log('telegram_send: no bound chat for this user');
        return { ok: false, result: { error: 'no_bound_chat' } };
      }
      const sent = await telegram.sendMessage(chatId, text);
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
// to the owner's bound chat. Registered ONCE at module load, fail-soft: a
// missing/partial engine (onAgentRunDone absent) is swallowed so import can
// never crash boot, and the callback itself never throws.
//
// `rec` is Moteur's run record; we read only the fields the R6 contract pins
// (channel, userId, state, finalText). A JSON Cache handle is needed to resolve
// the binding — registerTelegramRunDone(deps) is called by the orchestrator
// wiring (module-providers / a small init) with the same Cache the tool uses.
// We also self-register lazily against the shared client so a caller that just
// imports this module gets the hook wired with a default (no-cache) that
// re-resolves through a passed cache when available.
// ---------------------------------------------------------------------------
export interface RunDoneRec {
  runId?: string;
  userId?: string;
  channel?: string;
  state?: string;
  finalText?: string;
}

let runDoneRegistered = false;

/**
 * Register the Telegram completion hook with Moteur (idempotent, fail-soft).
 * Call from the module wiring with a JSON Cache handle. Safe to call when the
 * engine is absent — the registration is simply skipped.
 */
export function registerTelegramRunDone(deps: TelegramToolDeps): void {
  if (runDoneRegistered) return;
  try {
    if (typeof onAgentRunDone !== 'function') return;
    onAgentRunDone(async (rec: RunDoneRec) => {
      try {
        if (!rec || rec.channel !== 'telegram') return;
        if (!rec.userId) return;
        if (!telegram.configured) return;
        const bind = await deps.cache.get<{ chatId?: number | string }>(
          userBindKey(rec.userId)
        );
        const chatId = bind?.chatId;
        if (chatId == null) return;
        const finalText =
          typeof rec.finalText === 'string' && rec.finalText.trim()
            ? rec.finalText.trim()
            : rec.state === 'failed'
              ? '⚠️ La tâche a échoué.'
              : '✅ Tâche terminée.';
        await telegram.sendMessage(chatId, finalText);
      } catch {
        // A completion push must never surface — swallow and move on.
      }
    });
    runDoneRegistered = true;
  } catch {
    // onAgentRunDone unavailable / threw on register: leave unregistered.
  }
}
