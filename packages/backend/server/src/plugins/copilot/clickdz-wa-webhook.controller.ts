import { Body, Controller, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac } from 'node:crypto';

// Throttle rate-caps this route the same way every other @Public route in the
// copilot plugin does (bridge / triggers / telegram webhook). VALUE-imported
// (lint-nest: a decorator identifier must resolve at boot — the #73 lesson).
import { Throttle } from '../../base';
// @Public marks this webhook as skipping the global cookie AuthGuard — an
// inbound gateway call has no app session, authenticated SOLELY by the
// x-wa-signature header (verified below). Same non-cookie stance the telegram
// webhook + triggers webhook + bridge /chat/completions routes take.
import { Public } from '../../core/auth';
// safeEqual = constant-time string comparison (hashes both sides to a
// fixed-length digest first, so unequal lengths neither throw nor leak length
// through timing). Reused verbatim — the SAME primitive the telegram webhook
// uses for its secret_token header and cdz-data-token.ts uses for its
// write/blob/staff tokens.
import { safeEqual } from './cdz-data-token';
// waEnabled() is the SAME master gate clickdz-wa-client.ts exports for the
// outbound tool + caps read — reused here so inbound and outbound share one
// on/off switch (no route exists in a state where sending is dark but
// receiving is live, or vice versa). Pure, env-only, safe to call per-request.
import { waEnabled } from './clickdz-wa-client';

// ---------------------------------------------------------------------------
// CDZ AGENT — WHATSAPP INBOUND WEBHOOK (WSA-7 follow-up, owner: Wassila).
//
// Receives the gateway's per-instance webhook POSTs (see clickdz-wa-client.ts's
// header note for the verified /instances/:id API). The gateway signs every
// webhook body with HMAC-SHA256 (hex, header `x-wa-signature`) using a
// `webhookSecret` returned once when the instance's webhook was registered
// (POST /instances or PATCH /instances/:id, body {webhookUrl}) — mirror that
// secret into CDZ_WA_WEBHOOK_SECRET below. This is the missing half of the R8
// WhatsApp stub: clickdz-wa-client.ts was outbound-only; nothing received a
// gateway callback. Modeled on clickdz-agent-telegram.ts's @Public webhook
// (opaque-URL + header-secret auth, always-ack-200, never-throw), adapted for
// HMAC-over-body instead of a flat secret_token header, since there is no
// per-connection URL here — WhatsApp is ONE shared gateway instance
// (CDZ_WA_INSTANCE_ID), not a per-user BYOT channel like Telegram.
//
// SCOPE OF THIS PR: verify the signature, parse the event envelope, and ack
// fast — deliberately NOT dispatching inbound WhatsApp text into an agent run.
// Telegram's webhook can do that safely because the per-connection connId
// encodes an owning (userId, agent) pair; WhatsApp's single shared instance has
// no such mapping today, and inventing one (e.g. "route every inbound message
// to the account owner's default agent") is a product decision this PR should
// not make unilaterally. Logged via Logger so nothing is silently dropped;
// wiring a specific dispatch behavior is a follow-up once that decision is
// made. `instance.ready` / `connection.update` / `qr` events are exactly the
// kind of thing a future admin status card would read — also deliberately not
// persisted here (would need a Cache/Redis ctor param, i.e. more surface area
// than this fix needs — see the PR description).
//
// EVERYTHING is fail-soft dark behind `waEnabled()` AND a configured
// CDZ_WA_WEBHOOK_SECRET: either absent ⇒ ack {} with zero verification work
// (byte-identical to the route not existing, same stance every other gated-off
// @Public route in this plugin takes).
// ---------------------------------------------------------------------------

// The gateway's per-instance webhook signing secret (returned once at
// instance-creation/patch time on the gateway side — see the header note).
const WA_WEBHOOK_SECRET = process.env.CDZ_WA_WEBHOOK_SECRET || '';

/**
 * Compute the gateway's expected signature over the exact bytes it signed and
 * constant-time compare it to the inbound `x-wa-signature` header. `raw` MUST
 * be the exact request body bytes as sent — a re-serialized
 * `JSON.stringify(body)` can differ byte-for-byte from the original (key
 * order, whitespace) and would false-reject a legitimate call. Pure; never
 * throws (a malformed secret/header just fails the compare).
 */
function verifyWaSignature(raw: string, signatureHeader: string): boolean {
  if (!WA_WEBHOOK_SECRET || !raw || !signatureHeader) return false;
  try {
    const expected = createHmac('sha256', WA_WEBHOOK_SECRET)
      .update(raw)
      .digest('hex');
    return safeEqual(expected, signatureHeader);
  } catch {
    return false;
  }
}

/** The subset of the gateway's webhook envelope this route reads (see
 * clickdz-wa-client.ts's header note for the full verified shape). Everything
 * else in `data` is event-specific and intentionally untyped here. */
interface WaWebhookEnvelope {
  event?: string;
  instanceId?: string;
  tenantId?: string;
  timestamp?: string;
  data?: unknown;
}

@Controller()
export class ClickDzWaWebhookController {
  private readonly logger = new Logger(ClickDzWaWebhookController.name);

  // -------------------------------------------------------------------------
  // WEBHOOK. @Public (no cookie) — authenticated SOLELY by the
  // `x-wa-signature` header (HMAC-SHA256 of the raw body, constant-time
  // compared via safeEqual). ALWAYS returns 200 {} — even on a bad signature,
  // an off feature, or an unparseable body — so nothing is leaked and the
  // gateway never retry-storms, the exact stance clickdz-agent-telegram.ts's
  // webhook takes. @Throttle('strict') like every other @Public route here.
  // -------------------------------------------------------------------------
  @Public()
  @Throttle('strict')
  @Post('/api/v1/agents/whatsapp/wh')
  async webhook(
    @Body() body: unknown,
    @Req() req: Request
  ): Promise<Record<string, never>> {
    // Feature off, or no signing secret configured ⇒ ack empty, zero
    // verification work, never reveal the route exists (Telegram's stance).
    if (!waEnabled() || !WA_WEBHOOK_SECRET) return {};

    // Prefer the exact raw bytes when the app captures them (Express's JSON
    // body-parser can be configured with a `verify` callback that stashes the
    // buffer on `req.rawBody`, the same trick Stripe/webhook integrations use
    // — check whether this app's bootstrap already does that for a peer
    // webhook before relying on this route in prod; see the PR description).
    // Falls back to a re-serialization when it doesn't — a KNOWN approximation
    // that can false-reject a legitimate signature if the gateway's original
    // byte order/whitespace differs from Node's re-stringify. Flagged, not
    // silently assumed correct.
    const rawBody = (req as unknown as { rawBody?: unknown }).rawBody;
    const raw =
      typeof rawBody !== 'undefined'
        ? Buffer.isBuffer(rawBody)
          ? rawBody.toString('utf8')
          : String(rawBody)
        : JSON.stringify(body ?? {});

    const signature = String(req.headers['x-wa-signature'] || '');
    if (!verifyWaSignature(raw, signature)) {
      // Wrong/absent signature → ack empty, indistinguishable from any other
      // ack (never reveal whether the secret was close).
      return {};
    }

    const envelope = (body ?? {}) as WaWebhookEnvelope;
    const event = typeof envelope.event === 'string' ? envelope.event : 'unknown';
    // No per-user routing model exists for inbound WhatsApp today (see the
    // header note) — logging is the deliberately-scoped behavior for this PR.
    // Never throws past this point; a logging failure must not affect the ack.
    try {
      this.logger.log(
        `whatsapp webhook: event=${event} instanceId=${envelope.instanceId ?? ''}`
      );
    } catch {
      /* best-effort */
    }

    return {};
  }
}
