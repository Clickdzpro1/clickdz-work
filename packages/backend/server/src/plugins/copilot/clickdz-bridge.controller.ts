import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
// C6 (CHARGILY WEBHOOK): RawBodyRequest exposes req.rawBody (a Buffer of the
// exact bytes) when the app is bootstrapped with `rawBody: true` — which
// server.ts does. The Stripe webhook controller uses this same type + field to
// verify an HMAC signature against the UNPARSED body (a JSON-parsed object can't
// reproduce the signed bytes). Type-only import (verbatimModuleSyntax).
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
// SECURITY: cryptographically strong randomness for unguessable auto-slugs.
// C6: createHmac also powers the Chargily webhook signature check (HMAC-SHA256
// of the raw body with the merchant's apiSecret, compared constant-time).
import { createHash, createHmac, randomBytes } from 'node:crypto';

// WS4 publish-cap: the global AuthGuard already authenticates these first-party
// routes (no @Public / no bridge token). `CurrentUser` just RECEIVES the
// already-verified session user so the per-owner cap can key on identity.
import { CurrentUser, Public } from '../../core/auth';
// ClickDz PostHog server-side capture (no-op unless CDZ_POSTHOG_KEY/HOST set).
import { createPostHogClientFromEnv } from '../../core/telemetry/posthog-client';
// SECURITY: hard per-IP rate cap for cost/side-effecting routes (strict = 20/min).
// AuthenticationRequired -> typed 401 (raw HttpException becomes a generic 500 here).
// WS4: BadRequest/NotFound are the typed 4xx (a raw HttpException becomes a
// generic 500 through the global filter — see the vdz controller / LANDMINES).
// WS11/C6: ActionForbidden is the typed 403 for the ERP ownership gate.
import { ActionForbidden, AuthenticationRequired, BadRequest, InternalServerError, NotFound, Throttle } from '../../base';
// WS4: per-owner published-apps set, mimicking the vdz controller's CacheRedis
// pattern. RedisModule is @Global, so injecting it needs no module wiring.
import { CacheRedis } from '../../base/redis';
// CDZ VOICE (bulk TTS): CopilotStorage persists the concatenated clip bytes
// under the user's copilot scope and returns the replay URL for <audio>. The
// same provider the ClickDzAudioLibraryController uses, so a bulk clip lands in
// the Library list too. Injectable from the backend plugin provider list.
import { CopilotStorage } from './storage';
// WS4 premium gate (env-gated OFF by default): ModelsModule is @Global, so
// `models.userFeature.has(userId, 'pro_plan_v1')` needs no module wiring.
import { EntitlementService } from '../../core/entitlement';
import { Models } from '../../models';
import {
  buildEditContent,
  buildNewAppContent,
  type AppHistoryTurn,
  type AppSelectionContext,
  buildShopEditContent,
} from './clickdz-app-prompt';
// SECURITY: constant-time token compare + per-slug Data API write tokens.
// C6: verifyDataToken gates the @Public() /pay/checkout route with the SAME
// per-slug token the published shop already sends on data writes (checkout auth
// == data-write auth), so no new secret/credential is introduced.
import { dataWriteToken, publicDataToken, safeEqual, verifyDataToken,
  staffToken,
  verifyStaffToken,
  staffCan,
  staffPermissions,
  type StaffRole,
} from './cdz-data-token';
// WS3 templates — COMPLETE single-file HTML apps authored in sibling files
// (Merchant/Clerk own them, in parallel). We code against the export names; the
// files may not exist locally yet. Each contains the SAME placeholder tokens the
// generate path emits (__CLICKDZ_DATA_URL__ / __CLICKDZ_DATA_TOKEN__) plus
// __CLICKDZ_SLUG__, which /apps/template substitutes with the real minted values.
import { CLICKDZ_SHOP_TEMPLATE_HTML } from './clickdz-shop-template';
import { CLICKDZ_ERP_TEMPLATE_HTML } from './clickdz-erp-template';
// SETTINGS-1: the feature registries, so the settings merge can enumerate every
// per-feature param key it must preserve rather than hardcoding a list that
// silently rots as features are added.
import { ERP_FEATURES, SHOP_FEATURES } from './clickdz-features';
// R1-d (GATE): pure template-token resolver + feature-settings allowlist +
// env gates. Logic lives in the sibling file so this controller stays thin.
import {
  resolveTemplateTokens,
  resolveTemplateDef,
  listTemplateCatalog,
  templateCatalogEnabled,
  featuresEnabled,
  validateFeatureSettings,
  featuresRequireRemint,
  parseFeatureCsv,
  type TemplateMintOpts,
  isStale,
} from './clickdz-template-mint';
// APP-CAT — the App Builder template catalog (non-shop business tools). Pure
// data + self-gated helpers (CDZ_APP_TEMPLATE_CATALOG, default OFF): a def's
// French generation brief is prepended to the user's prompt on a gallery pick;
// the list route serves display metadata only. Mirrors the shop catalog split.
import {
  appTemplateCatalogEnabled,
  getAppTemplateDef,
  listAppTemplateCatalog,
} from './clickdz-app-catalog';
// R0-b (WSB-2) — shop source recovery. Pure helpers behind GET /apps/:slug/source:
// fetchDeployedHtml (recover a published app's HTML from its live Vercel URL,
// SSRF-guarded/timed/size-capped) + resolveAppSource (template kind → server-render
// fast path; else deployed-HTML fetch fallback). renderTemplateSource does the SAME
// __CLICKDZ_*__ substitution templateApp does — the controller injects the template
// HTML + minted token values so the helper stays import/env-free (boot-safe).
import {
  fetchDeployedHtml,
  resolveAppSource,
  type AppSourceRecord,
  renderTemplateSource,
} from './clickdz-app-source';
import {
  applyValidation,
  applyVoid,
  buildConversion,
  buildDraftInvoice,
  buildInvoiceFromOrder,
  checkSellerIdentity,
  coerceInvoice,
  filterInvoices,
  invoiceCollectionForDate,
  invoiceCollectionsInRange,
  invoiceSeqKey,
  resolveInvoiceRates,
  type InvoiceOptions,
  type InvoiceRecord,
  type InvoiceType,
  type ValidationError,
} from './clickdz-erp-invoicing';
import {
  applySupplierBalanceDelta,
  buildPoRecord,
  buildSupplierRecord,
  computeCancel,
  computeReceive,
  normalizePoLines,
  procPoId,
  procPoSeqKey,
  putErpRecord,
} from './clickdz-erp-procurement';
import {
  buildChargilyCaisseEntry,
  buildDayClose,
  buildPendingCodEntry,
  caisseCollectionFor,
  caisseCollectionForDate,
  caisseCollectionsInRange,
  caisseStr,
  hasChargilyCaisseEntry,
  hasPendingCodMarker,
  mergeCaisseEntry,
  normalizeRange,
  pendingCodMarkerPartitions,
  reconcileCourier,
  validateCaisseEntry,
  type CaisseRecord,
  type CourierLite,
} from './clickdz-erp-caisse';
import {
  buildAccountLedger,
  buildAgedReceivables,
  buildBalanceSheet,
  buildCashFlowStatement,
  buildG50Summary,
  buildIncomeStatement,
  buildTrialBalance,
  buildTVASummary,
  entriesCollectionFor,
  entriesCollectionForDate,
  generateFactureNormalisee,
  PCN_CHART,
  validateJournalEntry,
  validateNIF,
  type JournalEntry,
} from './clickdz-erp-accounting';
import {
  describeViolations,
  lintShopContract,
} from './clickdz-shop-contract';
import {
  appendLog,
  getVersionHtml,
  publicShopState,
  readShopState,
  recordVersion,
  setPendingAiPatch,
  writeShopState,
  type ShopState,
} from './clickdz-shop-state';
import * as Shipping from './clickdz-erp-shipping';
// WS17: shared Voice Library index helpers so the bulk-TTS route appends its
// clip to the SAME Redis index the Library tab reads (clickdz-audio-library).
import { CDZ_VOICE_LIBRARY, type LibraryRecord } from './clickdz-audio-library.controller';

// SECURITY: input caps for cost/side-effecting routes (images, apps, plan).
// Non-breaking for normal use; reject oversized/abusive payloads early.
const MAX_PROMPT_CHARS = 8_000;
const MAX_HTML_CHARS = 512_000;
// SECURITY: edit-in-context conversation caps for /apps/generate. Match the
// canonical CdzGenerateRequest bounds; reject (not clamp) oversized inputs so
// abuse is refused, then the prompt builder's internal clamps are belt-and-braces.
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_TURN_CHARS = 2_000;
const MAX_HISTORY_TOTAL_CHARS = 8_000;
const MAX_SELECTION_TEXT_CHARS = 200;
const MAX_SELECTION_DESCRIPTOR_CHARS = 500;

// SEC-1: collections the studio may write through the generic owner-gated
// /erp/collections route. Deliberately an ALLOWLIST, not a denylist: this route
// exists only so studio-owned collections that have no dedicated bridge route
// (créances today) stop depending on the data API's unauthenticated v1 alias.
// Money documents with their own validated routes — caisse, invoices, orders,
// products, suppliers, purchase-orders, inventory — must keep going through
// those routes so their shape validation and side effects are not bypassed.
// Adding a name here grants schemaless owner-authenticated create/delete on it;
// do that only for collections the studio genuinely owns end to end.
const STUDIO_OWNED_COLLECTIONS = new Set(['creances']);
// SECURITY: hard ceiling on max_tokens forwarded to upstream model APIs, to
// cap per-request cost. Floor of 1 keeps requests valid.
const MAX_TOKENS_CEILING = 4096;
const DEFAULT_MAX_TOKENS = 700;

/**
 * SECURITY: clamp a caller/requested max_tokens value to a sane range before
 * it reaches an upstream (paid) model API. Falls back to `fallback` when the
 * requested value is missing or not a finite number, then clamps to
 * [1, MAX_TOKENS_CEILING].
 */
function clampMaxTokens(
  requested: unknown,
  fallback: number = DEFAULT_MAX_TOKENS
): number {
  const n = Number(requested);
  const base = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(1, Math.min(Math.floor(base), MAX_TOKENS_CEILING));
}

/**
 * SECURITY (SSRF mitigation): decide whether a user-supplied URL is safe to
 * fetch server-side. Requires http/https and rejects loopback, private,
 * link-local and cloud-metadata targets. This is the pragmatic P1 mitigation:
 * it blocks literal-IP and known-bad hostnames WITHOUT resolving DNS, so a
 * hostname that resolves to a private IP is not caught here (documented
 * residual risk). Prefer https.
 */
function isSafePublicUrl(u: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  // only http/https (prefer https); block file:, gopher:, data:, etc.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // known-bad / metadata hostnames
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    host.endsWith('.local')
  ) {
    return false;
  }
  // shared IPv4 range check: true = private/loopback/link-local/reserved.
  const isPrivateV4 = (a: number, b: number): boolean =>
    a === 127 || // 127.0.0.0/8 loopback
    a === 10 || // 10.0.0.0/8 private
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (incl. 169.254.169.254)
    a === 0; // 0.0.0.0/8 "this host"
  // IPv6 literals: loopback (::1), unique-local (fc00::/7 => fc/fd prefix),
  // link-local (fe80::/10 => fe8/fe9/fea/feb prefix).
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return false;
    if (/^f[cd]/i.test(host)) return false; // fc00::/7
    if (/^fe[89ab]/i.test(host)) return false; // fe80::/10
    // IPv4-mapped IPv6. Node's URL normalizes ::ffff:169.254.169.254 to the
    // compressed hex form ::ffff:a9fe:a9fe, so match BOTH the dotted-quad and
    // the trailing two hex groups and range-check the embedded IPv4. This
    // closes the metadata-endpoint bypass via mapped addresses.
    const dotted = host.match(/::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
    if (dotted && isPrivateV4(Number(dotted[1]), Number(dotted[2]))) return false;
    const hex = host.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >> 8) & 0xff;
      const d = lo & 0xff;
      // reconstruct a.b.c.d; reject if it decodes to a private/reserved range
      if (isPrivateV4(a, b) || (a === 169 && b === 254 && c === 169 && d === 254)) {
        return false;
      }
    }
    return true;
  }
  // IPv4 literal? if it looks like a dotted quad, range-check it.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    if (isPrivateV4(Number(m[1]), Number(m[2]))) return false;
    return true;
  }
  // a regular DNS hostname we can't classify without resolution — allow it
  // (documented residual SSRF risk: no DNS resolution is performed).
  return true;
}

// WS14: Make.com AI Agents retired. All chat flows now use a SINGLE model —
// zai/glm-4.6v-flash (9B vision-language, 128K ctx, 1.5s latency, 126 TPS)
// via the SAME Vercel AI Gateway key the image pipeline and LLMs already use.
// WS1 (CDZIMAGE): ONE unified OpenAI key for all image generation. Order:
// the dedicated image key, then the app's canonical OPEN_AI (present on
// prod), then the generic fallback.
const OPENAI_IMAGE_API_KEY =
  process.env.OPENAI_IMAGE_API_KEY ||
  process.env.OPEN_AI ||
  process.env.OPENAI_API_KEY ||
  '';
// CDZIM (Gemini image models): a SECOND image provider next to the OpenAI
// gpt-image engines.
//
// Key resolution order (first non-empty wins):
//   1. CDZ_GEMINI_IMAGE_KEY  — preferred dedicated key for Gemini image calls.
//                              MUST be a Google AIza... key (39 chars, starts
//                              "AIza"). The GEMINI env on humanizily-backend is
//                              a CDZ-gateway JWT (eyJ..., ~1140 chars) and will
//                              be rejected by generativelanguage.googleapis.com
//                              when passed as a ?key= query parameter — do NOT
//                              map that token here.
// WS14: Gemini image generation retired in favour of Prodia Flux Schnell via
// Vercel AI Gateway. The Gateway provides unified billing, retries, and failover.
// All image-only models now route through POST /v1/images/generations
// (OpenAI-compatible endpoint). The same key works for both text and images.
const CDZ_AI_GATEWAY_IMAGE_KEY =
  process.env.CDZ_AI_GATEWAY_KEY ||
  process.env.CUSTOM_LLM_API_KEY ||
  '';
const CDZ_AI_GATEWAY_IMAGE_BASE =
  process.env.CDZ_AI_GATEWAY_BASE || 'https://ai-gateway.vercel.sh';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
// P5 (VOICE STUDIO): OpenAI as a SECOND voice provider (STT via Whisper + TTS
// via /v1/audio/speech). Key cascade mirrors the vdz controller's AUDIO cascade
// (a dedicated voice key first, then the app's canonical OPEN_AI present on
// prod, then the generic fallbacks — falling all the way through to the image
// key as a last resort, exactly like clickdz-vdz.controller.ts does). This is
// the ONLY new env this feature introduces; everything else reuses existing
// keys. No key set on any hop -> the OpenAI provider reports unavailable and
// the frontend disables it (never a crash).
const OPENAI_VOICE_API_KEY =
  process.env.OPENAI_VOICE_API_KEY ||
  process.env.OPENAI_AUDIO_API_KEY ||
  process.env.OPEN_AI ||
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_IMAGE_API_KEY ||
  '';
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
// Whisper's own hard cap is 25MB; reject just under it. Voice-Studio audio
// arrives as RAW bytes (application/octet-stream) through the app's 100MB raw
// body parser — identical stance to /api/v1/vdz/transcribe (base64-in-JSON
// would bloat ~33% and risk the 20MB json ceiling). Timeout matches vdz.
const MAX_VOICE_TRANSCRIBE_BYTES = 24 * 1024 * 1024;
const VOICE_TRANSCRIBE_TIMEOUT_MS = 180_000;
const VOICE_TTS_TIMEOUT_MS = 60_000;
// CDZIMAGE fast mode (Bolt): the normal upstream abort budget for
// /v1/images/edits and /v1/images/generations is 180s. Fast-mode requests
// already trade quality for speed (prompt-pro skipped, tier dropped a notch —
// see `fastMode` below), so give them a tighter upstream budget too. Gated
// strictly on `fastMode`; non-fast requests are UNCHANGED at 180s.
const FAST_IMAGE_TIMEOUT_MS = 60_000;
// Deepgram Aura-2 TTS voices this route accepts (the working provider's
// supported set). The frontend renders exactly these for the Deepgram card.
// Unknown/empty -> the historical default so old callers stay byte-identical.
// C3 (VOICE): the list is broadened to the fuller Aura-2 English roster across
// registers/accents/genders. The historical default and the original ten voices
// are still first in the array, so an old caller that passed any of them (or
// nothing) resolves to the exact same voice as before — additive only.
const DEEPGRAM_TTS_DEFAULT_VOICE = 'aura-2-thalia-en';
const DEEPGRAM_TTS_VOICES = [
  // — original ten (kept first, order-stable for byte-compatible callers) —
  'aura-2-thalia-en',
  'aura-2-andromeda-en',
  'aura-2-helena-en',
  'aura-2-apollo-en',
  'aura-2-arcas-en',
  'aura-2-aries-en',
  'aura-2-luna-en',
  'aura-2-orion-en',
  'aura-2-orpheus-en',
  'aura-2-zeus-en',
  // — C3 additions: fuller Aura-2 English library —
  'aura-2-amalthea-en',
  'aura-2-asteria-en',
  'aura-2-athena-en',
  'aura-2-atlas-en',
  'aura-2-aurora-en',
  'aura-2-callista-en',
  'aura-2-cora-en',
  'aura-2-cordelia-en',
  'aura-2-delia-en',
  'aura-2-draco-en',
  'aura-2-electra-en',
  'aura-2-harmonia-en',
  'aura-2-hera-en',
  'aura-2-hermes-en',
  'aura-2-hyperion-en',
  'aura-2-iris-en',
  'aura-2-janus-en',
  'aura-2-juno-en',
  'aura-2-jupiter-en',
  'aura-2-mars-en',
  'aura-2-minerva-en',
  'aura-2-neptune-en',
  'aura-2-odysseus-en',
  'aura-2-ophelia-en',
  'aura-2-pandora-en',
  'aura-2-phoebe-en',
  'aura-2-pluto-en',
  'aura-2-saturn-en',
  'aura-2-selene-en',
  'aura-2-theia-en',
  'aura-2-vesta-en',
] as const;
// OpenAI /v1/audio/speech voices. The frontend renders exactly these for the
// OpenAI card. Unknown/empty -> 'alloy'. `speed` is clamped 0.25–4.0 per the
// OpenAI contract; Deepgram has no speed knob so it is ignored there.
// C3 (VOICE): expanded to the full roster shipped by gpt-4o-mini-tts — the six
// legacy tts-1 voices (kept first for byte-compatibility) plus ash/ballad/coral/
// sage/verse. Any previously-valid voice still validates to the same value.
const OPENAI_TTS_DEFAULT_VOICE = 'alloy';
const OPENAI_TTS_VOICES = [
  'alloy',
  'echo',
  'fable',
  'onyx',
  'nova',
  'shimmer',
  'ash',
  'ballad',
  'coral',
  'sage',
  'verse',
] as const;
// C3 (VOICE): OpenAI TTS models. `gpt-4o-mini-tts` is the new default — it
// honours a free-text `instructions` field (emotion/prosody steerability), the
// real ElevenLabs-style-control analog. `tts-1`/`tts-1-hd` stay selectable and
// ignore `instructions`. Unknown/omitted model -> the default below.
const OPENAI_TTS_DEFAULT_MODEL = 'gpt-4o-mini-tts';
const OPENAI_TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] as const;
// Only gpt-4o-mini-tts steers on `instructions`; tts-1* silently ignore it, so
// we only forward the field for the model that supports it (avoids upstream 400s
// on the legacy models). Kept as a set for O(1) membership checks.
const OPENAI_TTS_INSTRUCTION_MODELS = new Set<string>(['gpt-4o-mini-tts']);
// C3 (VOICE): output container/format the client may request. Default stays
// 'mp3' so the wire shape (audio/mpeg) is byte-identical for existing callers.
// Each maps to the upstream response_format value + the Content-Type we set.
const VOICE_TTS_FORMATS: Record<
  string,
  { openai: string; deepgram: string; contentType: string }
> = {
  mp3: { openai: 'mp3', deepgram: 'mp3', contentType: 'audio/mpeg' },
  opus: { openai: 'opus', deepgram: 'opus', contentType: 'audio/ogg' },
  aac: { openai: 'aac', deepgram: 'aac', contentType: 'audio/aac' },
  flac: { openai: 'flac', deepgram: 'flac', contentType: 'audio/flac' },
  wav: { openai: 'wav', deepgram: 'wav', contentType: 'audio/wav' },
};
const VOICE_TTS_DEFAULT_FORMAT = 'mp3';
// Cap the free-text OpenAI `instructions` field so it can't be abused as a
// giant prompt against the paid speech API.
const MAX_TTS_INSTRUCTIONS_CHARS = 1_000;
// CDZ VOICE: single-shot /api/voice/tts text cap. The FE caps at TTS_MAX_CHARS
// (2000) but the route had NO length guard, so a direct API caller could send
// arbitrarily large text to the paid Deepgram/OpenAI endpoint. 4000 allows FE
// headroom while blocking abuse; longer scripts must use /api/v1/voice/tts-bulk.
const TTS_MAX_TEXT_CHARS = 4_000;
// CDZ VOICE (bulk/long-script TTS): splitting + persistence bounds for the
// /api/v1/voice/tts-bulk route. A long script is split sentence-aware into
// chunks of at most BULK_TTS_MAX_CHUNK_CHARS, synthesized serially with the
// SAME provider/voice/format logic the single-shot /api/voice/tts uses, then
// byte-concatenated into one clip and persisted to the Library via
// CopilotStorage. The whole script is capped (a realistic long read) and a
// single chunk stays under OpenAI/Deepgram's comfortable per-request text
// limits while still being prosody-friendly.
const BULK_TTS_MAX_INPUT_CHARS = 48_000;
const BULK_TTS_MAX_CHUNK_CHARS = 1_500;
// Upper bound on chunks per request protects the serial loop and rate budget.
const BULK_TTS_MAX_CHUNKS = 120;
const MAKE_OCR_WEBHOOK_URL = process.env.MAKE_OCR_WEBHOOK_URL || '';
// WS14: Make.com AI Agents + api.clickdz.ai retired. All LLM traffic now
// flows through Vercel AI Gateway on the same key already used for images.
// Single model: zai/glm-4.6v-flash (9B vision-language, 128K ctx, streaming).
const CLICKDZ_BRIDGE_TOKEN = process.env.CLICKDZ_BRIDGE_TOKEN || '';
const CDZ_CHAT_MODEL = 'zai/glm-4.6v-flash';

// Legacy alias preserved for downstream code that references these constants
// by name (runFastPlanner, Hermes, vdz compose, etc.). All point at Gateway.
const CDZ_AI_BASE_URL = CDZ_AI_GATEWAY_IMAGE_BASE;
const CDZ_AI_KEY = CDZ_AI_GATEWAY_IMAGE_KEY;
const CDZ_AI_ORIGIN = CDZ_AI_GATEWAY_IMAGE_KEY ? CDZ_AI_GATEWAY_IMAGE_BASE : '';
const CDZ_AGENT_MODEL = CDZ_CHAT_MODEL;
// WS14 REGRESSION FIX (2026-08-15): the chat-consolidation commit deleted
// these const definitions but kept resolveAgentForRequest/assertMakeReady/
// runMakeAgent, which still reference them — the server build is
// transpile-only (no typecheck), so the dangling identifiers shipped and
// every runMakeAgent call became an instant ReferenceError (6 call sites:
// image enhancer, shop copy, ERP describe, ...). Restored verbatim from
// pre-WS14 (61067f24): with the reroute flag ON (the default whenever the
// Gateway key exists) runMakeAgent serves via the Gateway and these consts
// only gate the legacy fallback, which cleanly 503s (make_not_configured)
// when the MAKE_* env vars are absent.
const MAKE_API_BASE = process.env.MAKE_API_BASE || 'https://eu1.make.com/api/v2';
const MAKE_API_KEY = process.env.MAKE_API_KEY || '';
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID || '';
const MAKE_AGENT_ID = process.env.MAKE_SUPERAGENT_ID || process.env.MAKE_AGENT_ID || '';
const MAKE_ARABIC_AGENT_ID = process.env.MAKE_ARABIC_AGENT_ID || MAKE_AGENT_ID;
const MAKE_CODE_AGENT_ID = process.env.MAKE_CODE_AGENT_ID || '';
const MAKE_BUILDER_AGENT_ID = process.env.MAKE_BUILDER_AGENT_ID || '';
// Master switch for the reroute. Defaults ON whenever a Gateway key is present
// (the working path). Set CDZ_AGENT_VIA_CDZ_AI=0 to force the legacy Make path.
const CDZ_AGENT_VIA_CDZ_AI =
  process.env.CDZ_AGENT_VIA_CDZ_AI === '0' ? false : !!CDZ_AI_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';

// ---------------------------------------------------------------------------
// WS4 — per-owner publish limits (Redis, keyed by the authenticated user id).
// These routes are first-party (session cookie, real CurrentUser); the cap is
// enforced at DEPLOY time (generate never publishes). Template deploys flow
// through the same deploy path, so they count toward the cap automatically.
// ---------------------------------------------------------------------------
// Max distinct published slugs per owner (default '1'). Same-slug redeploy is
// always allowed (it does not grow the set).
const CDZ_PUBLISH_MAX_APPS = (() => {
  const n = parseInt(process.env.CDZ_PUBLISH_MAX_APPS || '1', 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
})();
// Premium gate. OFF by default: when '1', publishing requires a Pro/Lifetime
// feature OR an allow-listed admin email; otherwise 402 upgrade_required.
const CDZ_PUBLISH_REQUIRE_PRO = process.env.CDZ_PUBLISH_REQUIRE_PRO === '1';
// R0-b (WSB-2). Gates GET /api/v1/apps/:slug/source (the cross-device source
// recovery path). OFF by default → the route 404s and behaviour is byte-identical
// to today. Turn on to let the shop studio fetch a published app's HTML server-side.
const CDZ_SHOP_AI_EDIT = process.env.CDZ_SHOP_AI_EDIT === '1';
// CSV of admin emails (lowercased) that bypass the premium gate.
const CDZ_PUBLISH_ADMIN_EMAILS = (process.env.CDZ_PUBLISH_ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);
// 90-day rolling TTL on the published-apps set (mirrors the vdz project store).
const PUBLISHED_APPS_TTL_SECONDS = 90 * 24 * 60 * 60;
// Redis SET of JSON records `{slug,url,createdAt}`, one entry per published slug.
const publishedAppsKey = (ownerId: string) =>
  `clickdz:apps:published:${ownerId}`;
// WS1 — owner-scoped, per-slug DRAFT store. Unlike the published SET this is a
// single JSON blob `{html,title,updatedAt}` per (owner,slug), holding the last
// autosaved studio draft so in-progress edits survive reload / a second device
// (the published `/source` path only ever recovers the last DEPLOYED HTML).
// Same owner-scoped key convention + rolling TTL as the published set.
const appDraftKey = (ownerId: string, slug: string) =>
  `clickdz:apps:draft:${ownerId}:${slug}`;
// Rolling TTL on a draft (same 90-day window + seconds unit as the published
// set's `expire`), re-armed on every autosave via ioredis `set ... EX`.
const APP_DRAFT_TTL_SECONDS = 90 * 24 * 60 * 60;
// Stored draft shape.
interface AppDraftRecord {
  html: string;
  title: string;
  updatedAt: string;
}
// Slug shape shared by generate/deploy (same as the SLUG_RE the data API uses).
const APP_SLUG_RE = /^[a-z0-9-]{3,50}$/;

// ---------------------------------------------------------------------------
// MONEY-2 — settlement idempotency lock.
//
// markOrderPaid is reached from the Chargily payment webhook. Its dedupe was
// read-then-write over a remote HTTP data API: list orders, check whether every
// copy is already paid, then write. Two concurrent deliveries of the SAME
// payment event (Chargily retries on timeout, and the handler chain is five-plus
// serial HTTPS round-trips through our own public URL, so a timeout-retry
// overlapping the still-running first delivery is the normal case, not the edge
// case) both pass the check and both write. Result: the order's total counted
// twice in the caisse `in/chargily` bucket, so day-close and reconcile show the
// drawer over by one order.
//
// Same NX-lock idiom as clickdz-courier.controller.ts's shipLockKey, for the
// same reason and with the same properties: keyed per (slug, orderRef), short
// TTL so a crashed holder auto-heals. H4: FAIL-CLOSED on a Redis outage — a
// double-processed payment is worse than a delayed one, and the provider
// (Chargily/Stripe) retries for hours. On contention or Redis-down we return
// 'in_progress'/'lock_failed' and the webhook answers 429 so the provider
// retries; the next attempt either acquires the lock or hits `already`.
// orderRef is bounded to 80 chars here (matching CHARGILY_ORDER_REF_MAX, which
// is declared further down) so a forged webhook can never mint an unbounded
// Redis key. The literal avoids a use-before-declaration on that const.
const payLockKey = (slug: string, orderRef: string) =>
  `clickdz:pay:paid:lock:${slug}:${orderRef.slice(0, 80)}`;
// Longer than the worst-case chain (list + put + N deletes + caisse list +
// caisse create, each with a 15s abort budget) but short enough to self-heal.
const PAY_LOCK_TTL_SEC = 90;

// ---------------------------------------------------------------------------
// C5 — TEMPLATE SETTINGS (SOUK/P4 ShopERP). /apps/template accepts an optional
// `settings` object that customizes the shop/erp templates at CREATION time by
// substituting four tokens the template files now carry. The DEFAULTS below are
// byte-for-byte the values that used to be hardcoded in those templates, so a
// template minted WITHOUT settings is byte-identical to the pre-C5 output.
// ---------------------------------------------------------------------------
const CDZ_TPL_DEFAULT_STORE_NAME = 'Ma Boutique';
const CDZ_TPL_DEFAULT_WHATSAPP = '213600000000';
const CDZ_TPL_DEFAULT_ACCENT = '#0f766e';
const CDZ_TPL_DEFAULT_ERP_ACCENT = '#2f6bff';
const CDZ_TPL_DEFAULT_PIN = '1234';
// WhatsApp: digits only, no leading '+', 8–15 digits (E.164-ish, no separators).
const CDZ_WHATSAPP_RE = /^[0-9]{8,15}$/;
// Accent: strict #RRGGBB (6 hex digits, leading '#').
const CDZ_ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
// Admin PIN: 4–8 digits.
const CDZ_PIN_RE = /^[0-9]{4,8}$/;

/** The four token replacements a validated `settings` object resolves to. */
interface TemplateTokens {
  storeName: string;
  whatsapp: string;
  accent: string;
  pin: string;
}

/**
 * C5 validation. Parses/validates the optional `settings` object from an
 * /apps/template body. Every field is OPTIONAL; an omitted field keeps the
 * template's original hardcoded default (so no-settings == byte-identical).
 * `erpAccentDefault` differs from the shop accent (the ERP's --brand hue), so
 * the correct per-kind default is used when accentColor is omitted.
 *
 * Returns `{ ok:true, tokens }` on success, or `{ ok:false, field }` naming the
 * FIRST offending field (the exact `field` the 400 body must carry). The caller
 * writes the 400 via passthrough res — a typed error can't carry this body.
 */
function parseTemplateSettings(
  raw: unknown,
  accentDefault: string
): { ok: true; tokens: TemplateTokens } | { ok: false; field: string } {
  const tokens: TemplateTokens = {
    storeName: CDZ_TPL_DEFAULT_STORE_NAME,
    whatsapp: CDZ_TPL_DEFAULT_WHATSAPP,
    accent: accentDefault,
    pin: CDZ_TPL_DEFAULT_PIN,
  };
  // No settings at all → all defaults (byte-identical output). null/undefined ok.
  if (raw == null) return { ok: true, tokens };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, field: 'settings' };
  }
  const s = raw as Record<string, unknown>;

  // storeName: trim, non-empty after trim, ≤60 chars.
  if (s.storeName !== undefined && s.storeName !== null) {
    if (typeof s.storeName !== 'string') return { ok: false, field: 'storeName' };
    const name = s.storeName.trim();
    if (name.length === 0 || name.length > 60) {
      return { ok: false, field: 'storeName' };
    }
    tokens.storeName = name;
  }

  // whatsapp: digits only, 8–15, no '+'.
  if (s.whatsapp !== undefined && s.whatsapp !== null) {
    if (typeof s.whatsapp !== 'string' || !CDZ_WHATSAPP_RE.test(s.whatsapp)) {
      return { ok: false, field: 'whatsapp' };
    }
    tokens.whatsapp = s.whatsapp;
  }

  // accentColor: strict #RRGGBB.
  if (s.accentColor !== undefined && s.accentColor !== null) {
    if (typeof s.accentColor !== 'string' || !CDZ_ACCENT_RE.test(s.accentColor)) {
      return { ok: false, field: 'accentColor' };
    }
    tokens.accent = s.accentColor;
  }

  // adminPin: 4–8 digits.
  if (s.adminPin !== undefined && s.adminPin !== null) {
    if (typeof s.adminPin !== 'string' || !CDZ_PIN_RE.test(s.adminPin)) {
      return { ok: false, field: 'adminPin' };
    }
    tokens.pin = s.adminPin;
  }

  return { ok: true, tokens };
}

/**
 * A single published-app record stored in the per-owner Redis set.
 * C5: `kind`/`storeSlug` are OPTIONAL — legacy records written before this
 * change (and non-shop generated apps) have neither; readers must be null-safe.
 */
interface PublishedAppRecord {
  slug: string;
  url: string;
  createdAt: string;
  kind?: 'shop' | 'erp' | 'app';
  storeSlug?: string;
}

// ClickDz Apps — the app-builder system prompt + message-content builders now
// live in ./clickdz-app-prompt (imported above). buildAppHtml delegates to them.

const CLICKDZ_APP_WATERMARK =
  '<div style="position:fixed;bottom:10px;right:12px;font:600 11px system-ui;opacity:.55;z-index:99999"><a href="https://work.clickdz.ai" style="color:inherit;text-decoration:none" target="_blank" rel="noopener">⚡ Built with ClickDz</a></div>';

function slugifyAppName(input: string): string {
  // keep slugs short: long project names make Vercel truncate the
  // auto-assigned <project>.vercel.app domain unpredictably
  const base = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join('-')
    .replace(/-+/g, '-')
    .slice(0, 18)
    .replace(/^-|-$/g, '');
  // SECURITY: auto-generated slugs gate access to the PUBLIC per-slug
  // datastore, so they must not be guessable. Use crypto-strong randomness
  // (randomBytes) instead of Math.random(). 4 bytes -> 8 lowercase hex chars,
  // which stay inside the SLUG_RE /^[a-z0-9-]{3,50}$/ used for lookups.
  // base (<=18) + '-' (1) + 8 hex = <=27 chars, well within the 50-char slug
  // cap and the 52-char Vercel project cap (see deployAppToVercel).
  const rand = randomBytes(4).toString('hex');
  return base ? `${base}-${rand}` : `app-${rand}`;
}

function extractHtmlApp(reply: string): string {
  const block = reply.match(/```html\s*([\s\S]*?)```/i)?.[1];
  const candidate = (block ?? reply).trim();
  if (/^<!doctype html/i.test(candidate) || /^<html[\s>]/i.test(candidate)) {
    return candidate;
  }
  return '';
}

// ---------------------------------------------------------------------------
// CDZIMAGE tiers (WS1) — display aliases over the image engines.
// 2.0 = flagship default, 1.5 = balanced, 1.0 = economy (UI exposes 1.0 in
// Vdz only, per owner decision; the server accepts all three). dall-e-* and
// bare gpt-image-1 are RETIRED as targets (gpt-image-1 deprecates upstream
// 2026-10-23) — legacy ids resolve to the nearest tier so old clients keep
// working during the transition.
// CDZIM: the gemini-* tiers are REAL engines on the Gemini generateContent
// API (routed upstream by the gemini branch below) — raw gemini-* ids also
// resolve through the raw-engine loop, so `resolveCdzImageModel` accepts both
// the tier id and the engine id for each.
// ---------------------------------------------------------------------------
const CDZIMAGE_TIERS: Record<
  string,
  { engine: string; quality: 'low' | 'medium' | 'high'; label: string }
> = {
  'cdzimage-2.0': { engine: 'gpt-image-2', quality: 'high', label: 'CDZIMAGE 2.0' },
  'cdzimage-1.5': { engine: 'gpt-image-1.5', quality: 'medium', label: 'CDZIMAGE 1.5' },
  'cdzimage-1.0': { engine: 'gpt-image-1-mini', quality: 'low', label: 'CDZIMAGE 1.0' },
  // WS14: CDZIM Flux — Prodia Flux Schnell via Vercel AI Gateway. Text-to-image
  // only (no i2i). ~$0.001-0.0025/img (33-67x cheaper than Gemini nanobanana2).
  'cdzimage-flux': { engine: 'prodia-flux-schnell', quality: 'medium', label: 'CDZIMAGE Flux' }
};
// WS14: default image tier switched to Prodia Flux Schnell via Vercel AI Gateway.
// ~$0.001-0.0025/img (33-67x cheaper than nanobanana2) with comparable quality
// for presentation visuals. Text-to-image only — i2i/edit requests must use a
// gpt-image-* tier explicitly. Env-overridable via CDZIMAGE_DEFAULT_TIER so ops
// can revert to cdzimage-1.0 without a redeploy if needed.
const CDZIMAGE_DEFAULT_TIER =
  process.env.CDZIMAGE_DEFAULT_TIER || 'cdzimage-flux';
const CDZIMAGE_LEGACY_ALIASES: Record<string, string> = {
  // the old "ClickDz 1.0 smart image" marketing ids → best tier
  'clickdz-image': CDZIMAGE_DEFAULT_TIER,
  'clickdz-image-1.0': CDZIMAGE_DEFAULT_TIER,
  // retired engines → nearest tier
  'dall-e-3': CDZIMAGE_DEFAULT_TIER,
  'dall-e-2': 'cdzimage-1.0',
  'gpt-image-1': 'cdzimage-1.5',
};
/**
 * Strict mode: when '1', requests WITHOUT a model are rejected with
 * `image_model_required` (the owner's "every generation must pick a model").
 * Ships OFF so existing clients keep working until the surface pickers land
 * (WS1 PR4/PR5); flip the env after those deploy.
 */
const CDZIMAGE_REQUIRE_MODEL = process.env.CDZIMAGE_REQUIRE_MODEL === '1';

// ImgPerf: prompt-pro (enhancement) is OFF by default — it adds 2–8s of
// cdz-flash latency on the critical path for EVERY non-fast request. The owner
// reported "takes forever"; enhancement is the single biggest non-provider
// latency contributor. Set CDZIMAGE_ENHANCE_DEFAULT=1 to restore the old
// always-on behavior. Explicit body.enhance=true / body.enhance=false always
// win over this default (see wantsEnhance below).
const ENHANCE_DEFAULT_ON = process.env.CDZIMAGE_ENHANCE_DEFAULT === '1';

// ImgPerf: Redis prompt-hash cache for text-to-image generations. ON by
// default (CDZ_IMAGE_CACHE_ENABLED !== '0'); eliminates 20–40% of provider
// calls by returning the cached response for identical prompts. Only
// text-to-image (i2iMode 'none') is cached — edit/reinterpret modes depend on
// input pixels the hash can't capture, so they always bypass the cache. Fail-
// open: any cache read/write error falls through to a normal generation.
const CDZ_IMAGE_CACHE_ENABLED = process.env.CDZ_IMAGE_CACHE_ENABLED !== '0';
const CDZ_IMAGE_CACHE_TTL = Math.max(
  60,
  Number(process.env.CDZ_IMAGE_CACHE_TTL) || 86400
);
const CDZ_IMAGE_CACHE_PREFIX = 'cdzimg:v1:';

interface CdzImageResolution {
  tierId: string;
  engine: string;
  quality: 'low' | 'medium' | 'high';
  label: string;
  /** How the tier was chosen — echoed in the response for observability. */
  source: 'tier' | 'legacy' | 'raw-engine' | 'default';
}

/**
 * Resolve a requested model id to a CDZIMAGE tier.
 * Returns 'missing' (no id — caller applies strict/default policy) or
 * 'invalid' (unknown id — always a 400; previously junk ids fell through RAW
 * to OpenAI, which is tightened here on purpose).
 */
function resolveCdzImageModel(
  requested: string
): CdzImageResolution | 'missing' | 'invalid' {
  const id = requested.trim().toLowerCase();
  if (!id) return 'missing';
  const tier = CDZIMAGE_TIERS[id];
  if (tier) return { tierId: id, ...tier, source: 'tier' };
  const legacyTier = CDZIMAGE_LEGACY_ALIASES[id];
  if (legacyTier) {
    return { tierId: legacyTier, ...CDZIMAGE_TIERS[legacyTier], source: 'legacy' };
  }
  // Explicit raw engine ids stay honored for OpenAI-compatible machine
  // clients (mapped back to their tier for metadata/quality defaults).
  for (const [tierId, spec] of Object.entries(CDZIMAGE_TIERS)) {
    if (spec.engine === id) return { tierId, ...spec, source: 'raw-engine' };
  }
  return 'invalid';
}

// ---------------------------------------------------------------------------
// Image-to-image inputs (WS1 PR2). An input image (and optional mask) may be
// a data: URL (decoded inline, no network) or a PUBLIC https URL (fetched
// server-side behind the same SSRF guard the OCR path uses). Hard size cap —
// this route pays per request.
// ---------------------------------------------------------------------------
const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const DATA_URL_IMAGE_RE =
  /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)$/i;
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
};

interface FetchedImageInput {
  bytes: Uint8Array;
  mime: string;
  origin: 'data-url' | 'remote';
}

/** OpenAI-error-shaped 400 for bad i2i inputs (this is the OpenAI-compatible surface). */
function badImageInput(label: string, message: string): HttpException {
  return new HttpException(
    {
      error: {
        message: `${label}: ${message}`,
        type: 'invalid_request_error',
        code: 'image_input_invalid',
      },
    },
    HttpStatus.BAD_REQUEST
  );
}

/** Resolve an i2i input ref (data: URL or public https URL) to raw bytes. */
async function fetchImageInput(
  ref: string,
  label: string
): Promise<FetchedImageInput> {
  const dataMatch = ref.match(DATA_URL_IMAGE_RE);
  if (dataMatch) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(dataMatch[2].replace(/\s+/g, ''), 'base64');
    } catch {
      throw badImageInput(label, 'data URL is not valid base64');
    }
    if (bytes.length === 0) throw badImageInput(label, 'empty image data');
    if (bytes.length > MAX_IMAGE_INPUT_BYTES) {
      throw badImageInput(
        label,
        `image too large (max ${Math.floor(MAX_IMAGE_INPUT_BYTES / (1024 * 1024))}MB)`
      );
    }
    return {
      bytes: new Uint8Array(bytes),
      mime: dataMatch[1].toLowerCase(),
      origin: 'data-url',
    };
  }
  if (/^data:/i.test(ref)) {
    throw badImageInput(label, 'only base64 png/jpeg/webp data URLs are supported');
  }
  if (!isSafePublicUrl(ref)) {
    throw badImageInput(label, 'URL must be a public http(s) address');
  }
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(ref, { signal: AbortSignal.timeout(20000) });
  } catch {
    throw badImageInput(label, 'could not fetch the image URL');
  }
  if (!response.ok) {
    throw badImageInput(label, `image URL returned ${response.status}`);
  }
  const mime = (response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!IMAGE_MIME_EXT[mime]) {
    throw badImageInput(label, `unsupported content-type "${mime}" (png/jpeg/webp only)`);
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.length === 0) throw badImageInput(label, 'empty image data');
  if (buf.length > MAX_IMAGE_INPUT_BYTES) {
    throw badImageInput(
      label,
      `image too large (max ${Math.floor(MAX_IMAGE_INPUT_BYTES / (1024 * 1024))}MB)`
    );
  }
  return { bytes: buf, mime, origin: 'remote' };
}
const IMAGE_ENHANCER_GUIDELINES = [
  'You are ClickDz 1.0, an elite image prompt engineer. Rewrite the request',
  'below into ONE masterful English image-generation prompt.',
  'Rules:',
  '- preserve the user intent and every explicit detail they gave',
  '- specify: subject, setting, composition (framing, perspective), lighting',
  '  (quality, direction, mood), color palette, style or medium, fine textures',
  '- add tasteful photographic/artistic vocabulary (lens, film stock, render',
  '  style) only when it fits the request',
  '- if the request is Arabic or French, translate the intent faithfully into',
  '  English, but keep any text that must appear INSIDE the image in its',
  '  original language, wrapped in double quotes',
  '- never invent brands, logos, real people or watermarks not requested',
  '- output ONLY the final prompt text, no commentary, at most 180 words',
].join('\n');

// WS14: Single model architecture — zai/glm-4.6v-flash for chat/vision/planning,
// prodia/flux-fast-schnell for images. One Gateway key, one billing line.
const MODELS = [CDZ_CHAT_MODEL, 'cdzimage-flux'];

function now() {
  return Math.floor(Date.now() / 1000);
}

function hasArabic(text: string) {
  return /[\u0600-\u06FF]/.test(text);
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

function normalizeMessages(messages: Array<{ role: string; content: unknown }>) {
  return (messages || []).map(message => ({
    role: message.role,
    content: flattenContent(message.content),
  }));
}

function openAIChatResponse(id: string, model: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: now(),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function parseMakeAgentResponse(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.reply === 'string') return parsed.reply;
      if (typeof parsed.answer === 'string') return parsed.answer;
      if (typeof parsed.content === 'string') return parsed.content;
      if (typeof parsed.response === 'string') return parsed.response;
      return raw;
    } catch {
      return raw;
    }
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.reply === 'string') return obj.reply;
    if (typeof obj.answer === 'string') return obj.answer;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.response === 'string') return parseMakeAgentResponse(obj.response);
  }
  return '';
}

/**
 * A single proposed plan step. `recommended` steps are checked by default in
 * the UI (the core plan); non-recommended steps render as unchecked optional
 * "suggestions" the user can opt into. This powers the v3 checklist UX.
 */
type PlanStep = {
  text: string;
  recommended: boolean;
};

type PlanClarification = {
  /** One-line statement of what the plan will accomplish. */
  goal: string;
  question: string;
  options: string[];
  /** Ordered checklist of proposed steps. Always non-empty. */
  steps: PlanStep[];
  /** Flat prose form of the plan, kept for backwards compatibility. */
  draftPlan: string;
};

/**
 * Derive an ordered step list from free-form plan prose. Handles numbered
 * ("1) …", "2. …"), bulleted ("- …", "• …"), and line-per-step formats, and
 * falls back to sentence splitting for a single dense paragraph.
 */
function derivePlanSteps(plan: string): string[] {
  const text = plan.trim();
  if (!text) return [];
  const numbered = text
    .split(/(?:^|\s)(?:\d{1,2}[).:]|[-•*])\s+/)
    .map(part => part.trim().replace(/[\s,;]+$/, ''))
    .filter(part => part.length > 2);
  if (numbered.length >= 2) return numbered.slice(0, 8);
  const lines = text
    .split(/\n+/)
    .map(line => line.trim().replace(/^(?:\d{1,2}[).:]|[-•*])\s*/, ''))
    .filter(Boolean);
  if (lines.length >= 2) return lines.slice(0, 8);
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 2);
  if (sentences.length >= 2) return sentences.slice(0, 8);
  return [text];
}

/** Coerce whatever the model returned in `steps` into PlanStep objects. */
function normalizePlanSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanStep[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      const text = String(obj.text ?? obj.step ?? obj.title ?? '').trim();
      if (!text) continue;
      // Default to recommended unless the model explicitly opts it out.
      const recommended =
        obj.recommended === false || obj.optional === true ? false : true;
      out.push({ text, recommended });
    } else {
      const text = String(entry).trim();
      if (text) out.push({ text, recommended: true });
    }
  }
  return out.slice(0, 10);
}

const FALLBACK_PLAN_STEPS: PlanStep[] = [
  { text: 'Confirm the target outcome and constraints.', recommended: true },
  { text: 'Execute the request end to end.', recommended: true },
  { text: 'Verify the result and report what was done.', recommended: true },
];

/** CDZIMAGE clarify response (WS1 PR6). */
interface ImageClarification {
  needs_details: boolean;
  question: string;
  options: string[];
  suggested: { subject: string; style: string; mood: string; aspect: string };
}

/**
 * Defensive parse of the image clarifier's JSON. FAIL-OPEN: anything
 * unusable yields `needs_details: false` with empty enrichments so the
 * caller just generates — a clarifier failure never blocks an image.
 */
function parseImageClarification(raw: string): ImageClarification {
  const fallback: ImageClarification = {
    needs_details: false,
    question: '',
    options: [],
    suggested: { subject: '', style: '', mood: '', aspect: '' },
  };
  const unfenced = raw
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) return fallback;
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
    const suggestedRaw = (parsed.suggested ?? {}) as Record<string, unknown>;
    const aspect = String(suggestedRaw.aspect || '').toLowerCase();
    const question = String(parsed.question || '').trim().slice(0, 300);
    const options = Array.isArray(parsed.options)
      ? parsed.options
          .map(option => String(option).trim().slice(0, 60))
          .filter(Boolean)
          .slice(0, 4)
      : [];
    // A "needs details" verdict is only actionable with a real question and
    // at least two choices — otherwise fail open.
    const needsDetails =
      parsed.needs_details === true && question.length > 0 && options.length >= 2;
    return {
      needs_details: needsDetails,
      question,
      options,
      suggested: {
        subject: String(suggestedRaw.subject || '').trim().slice(0, 200),
        style: String(suggestedRaw.style || '').trim().slice(0, 120),
        mood: String(suggestedRaw.mood || '').trim().slice(0, 120),
        aspect: ['square', 'landscape', 'portrait'].includes(aspect)
          ? aspect
          : '',
      },
    };
  } catch {
    return fallback;
  }
}

function parsePlanClarification(raw: string): PlanClarification {
  const unfenced = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(unfenced.slice(start, end + 1)) as Record<
        string,
        unknown
      >;
      const goal = String(parsed.goal || parsed.summary || '').trim();
      const question = String(parsed.question || '').trim();
      const options = Array.isArray(parsed.options)
        ? parsed.options
            .map(option => String(option).trim())
            .filter(Boolean)
            .slice(0, 4)
        : [];
      let steps = normalizePlanSteps(parsed.steps);
      // Merge any explicit optional "suggestions" the model returned as
      // unchecked steps the user can opt into.
      const suggestions = normalizePlanSteps(parsed.suggestions).map(step => ({
        ...step,
        recommended: false,
      }));
      steps = [...steps, ...suggestions];
      const draftPlan = String(parsed.draftPlan || '').trim();
      if (!steps.length && draftPlan) {
        steps = derivePlanSteps(draftPlan).map(text => ({
          text,
          recommended: true,
        }));
      }
      if (steps.length) {
        return {
          goal: goal || draftPlan || 'Execute the request.',
          question: question || 'What outcome matters most before I run this?',
          options,
          steps: steps.slice(0, 10),
          draftPlan:
            draftPlan || steps.map(step => step.text).join('\n'),
        };
      }
    } catch {
      // fall through to a useful deterministic clarification
    }
  }
  const derived = derivePlanSteps(raw).map(text => ({ text, recommended: true }));
  const steps = derived.length ? derived : FALLBACK_PLAN_STEPS;
  return {
    goal: raw.trim().slice(0, 160) || 'Execute the request.',
    question: 'What outcome matters most before I execute this plan?',
    options: ['Fast first version', 'Highest quality', 'Lowest risk'],
    steps,
    draftPlan: raw.trim() || steps.map(step => step.text).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// WS11/C6 — IN-APP ERP (KEEPER). Owner-only ERP endpoints over the SAME
// per-slug Data API namespace the deployed shop/ERP templates read and write
// (collections: orders / products / customers / expenses / settings).
//   • Reads: the data GET is @Public (no token on v1 or v2) — the bridge
//     fetches it SERVER-SIDE so the browser only ever talks to this authed
//     surface and the per-slug write token never reaches the client.
//   • Writes: the data API's v2 mutations require the per-slug HMAC write
//     token. The bridge RE-DERIVES it with dataWriteToken(slug) — the exact
//     mint clickdz-data.controller.ts verifies (HMAC-SHA256 over
//     `appdata:${slug}` keyed by CDZ_DATA_SECRET, falling back to
//     CLICKDZ_BRIDGE_TOKEN — see cdz-data-token.ts) and the same call the
//     generate/template paths already use to bake tokens into app HTML.
//   • No secret configured ⇒ dataWriteToken() returns '' ⇒ write endpoints
//     answer a typed 501 {error:'admin_writes_unavailable'} (never a crash).
// Field tolerance mirrors the templates: products carry `title` (shop shape)
// or `name`/`sku` (ERP shape); expenses carry `montant` or `amount`; the
// business date is orderedAt || date || createdAt. The KPI math mirrors the
// deployed ERP template's metrics() verbatim so both dashboards agree.
// There is NO record update op on the data API — every edit is delete +
// recreate keyed on a stable BUSINESS key (order `ref`, product `sku`/title,
// settings key='settings'), exactly like the deployed admin surfaces.
// ---------------------------------------------------------------------------
const ERP_ORDER_STATUSES = [
  'Nouvelle',
  'Confirmée',
  'Expédiée',
  'Livrée',
  'Retournée',
] as const;
type ErpOrderStatus = (typeof ERP_ORDER_STATUSES)[number];
/** One data-API record (schemaless JSON + server-managed id/createdAt). */
type ErpRecord = Record<string, unknown>;
const ERP_DATA_TIMEOUT_MS = 15_000;
const ERP_REVENUE_DAYS = 14;
const ERP_RECENT_ORDERS_MAX = 20;
const ERP_TOP_PRODUCTS_MAX = 5;
// Stay under the data API's 8KB/record cap WITH headroom for the id/createdAt
// it appends — checked BEFORE the delete half of a delete+recreate so an
// oversized replacement can never destroy the record it was replacing.
const ERP_MAX_WRITE_BYTES = 8 * 1024 - 128;
const CDZ_SHOP_STATE = process.env.CDZ_SHOP_STATE === '1';
// R18 PR-B — durable ERP legal counters. OFF (default) = the legacy bare Redis
// INCR, byte-identical behaviour. '1' = Postgres cdz_erp_seq becomes the
// monotonic floor via max-merge (see CdzErpSeqModel.reserve + erpReserveSeq).
const CDZ_ERPSEQ_PG = process.env.CDZ_ERPSEQ_PG === '1';
// SEC-5 — refuse to legally number a FACTURE while the seller's fiscal
// identity (sellerName + RC/NIF/NIS/ART, "obligatoire légalement" on the
// printed sheet) is blank in the settings singleton. Default ON; set
// CDZ_ERP_SELLER_ID_ENFORCE=0 to restore the old permissive behaviour (e.g.
// while migrating merchants who validated factures before this gate existed).
// Devis/BL are NOT gated — they are not fiscal invoices.
const CDZ_ERP_SELLER_ID_ENFORCE =
  process.env.CDZ_ERP_SELLER_ID_ENFORCE !== '0';
// Bound the PG hop on the validation path; past this the reserve fails soft to
// the Redis number so invoicing never stalls on a slow Postgres.
const CDZ_ERPSEQ_PG_TIMEOUT_MS = Math.max(
  250,
  Number(process.env.CDZ_ERPSEQ_PG_TIMEOUT_MS) || 2500
);
// WSE-12 (R2-e) — staff auth. Roles mirror ./cdz-data-token's StaffRole union
// (owner=all, manager=all-minus-staff.manage/settings.write, staff=orders only).
const ERP_STAFF_ROLES = ['owner', 'manager', 'staff'] as const;
// Defensive cap on staff per shop (an SMB owner + a handful of staff). Keeps the
// `staff` collection well under the data API's 500-record ceiling.
const ERP_MAX_STAFF = 50;
// Verbatim default tagline from the shop template's defaultSettings().
const ERP_DEFAULT_TAGLINE =
  'Produits de qualité, livrés partout en Algérie — paiement à la livraison.';

// ---------------------------------------------------------------------------
// C7 — SHOP APPEARANCE allowlist (theme / template / font / sections).
// The settings singleton stores APPEARANCE as IDS/ENUMS only — NEVER raw CSS —
// so the record stays tiny (well under the 8KB cap) and the storefront template
// (owned by SHOP-TEMPLATE) resolves each id to its concrete :root vars / layout
// at render time. The DEFAULTS below reproduce today's single look, so a legacy
// singleton (no appearance fields) normalizes to the byte-identical current
// storefront. Unknown ids are REJECTED (400 invalid_settings) — the server
// never trusts a caller-supplied style string.
// ---------------------------------------------------------------------------
// Theme presets (≥4). 'classic' == today's teal look (the default).
// Corner style. 'auto' = keep the theme preset's radius (the default, and what
// every existing shop implicitly has), so adding this key changes nothing until a
// merchant picks otherwise.
const ERP_RADIUS_IDS = ['auto', 'carre', 'doux', 'arrondi'] as const;
const ERP_DEFAULT_RADIUS = 'auto';
const ERP_THEME_IDS = [
  'classic',
  'dark',
  'vibrant',
  'minimal',
  // Added with the five market themes; each must ALSO exist in the storefront
  // template's THEMES map or the runtime guard falls back to classic.
  'sahara',
  'nuit-doree',
  'olive',
  'azur',
  'flash',
] as const;
const ERP_DEFAULT_THEME = 'classic';
// Layout templates (≥2, ids owned by clickdz-shop-template.ts). 'standard' ==
// today's hero + product grid (default); 'boutique' == editorial layout.
const ERP_TEMPLATE_IDS = [
  'standard',
  'boutique',
  'grid-dense',
  'editorial-split',
  'landing',
] as const;
const ERP_DEFAULT_TEMPLATE = 'standard';
// Font ids map to a --font stack in the template (mirrors the studio's
// cdz-style-editor font choices). 'system' == today's stack (the default).
const ERP_FONT_IDS = ['system', 'inter', 'poppins', 'playfair'] as const;
const ERP_DEFAULT_FONT = 'system';
// Toggleable storefront sections (ids only). Default = all on (today's look).
const ERP_SECTION_IDS = ['hero', 'trust', 'categories', 'featured'] as const;
const ERP_DEFAULT_SECTIONS = ERP_SECTION_IDS.join(',');
// Cap the stored sections CSV defensively (ids only; this is belt-and-braces).
const ERP_MAX_SECTIONS_LEN = 200;

/**
 * C7: validate + normalize the optional `sections` field. Accepts either a
 * CSV string ('hero,trust') or a string[] of ids; returns a de-duplicated,
 * allowlist-filtered CSV in the canonical ERP_SECTION_IDS order, or null when
 * the input is malformed / contains an unknown id (caller emits 400). An empty
 * selection is valid (all sections hidden) and normalizes to ''.
 */
function normalizeErpSections(raw: unknown): string | null {
  let parts: string[];
  if (Array.isArray(raw)) {
    parts = raw.map(v => (typeof v === 'string' ? v : ''));
  } else if (typeof raw === 'string') {
    parts = raw.split(',');
  } else {
    return null;
  }
  const wanted = new Set(parts.map(s => s.trim().toLowerCase()).filter(Boolean));
  for (const id of wanted) {
    if (!(ERP_SECTION_IDS as readonly string[]).includes(id)) return null;
  }
  // Canonical order + de-dup; keep it tiny.
  const csv = ERP_SECTION_IDS.filter(id => wanted.has(id)).join(',');
  if (csv.length > ERP_MAX_SECTIONS_LEN) return null;
  return csv;
}

/** Template `num()`: Number(v), non-finite → 0. */
function erpNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Loose string read for schemaless records: null/undefined → ''. */
function erpStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Template todayISO(): UTC calendar day (the templates use the same slice). */
function erpTodayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Template parseDate(): business date — orderedAt || date || createdAt. */
function erpParseDate(r: ErpRecord): string {
  const raw = erpStr(r.orderedAt) || erpStr(r.date) || erpStr(r.createdAt);
  return raw.slice(0, 10) || erpTodayISO();
}

/** Template orderTotal(): stored total, else Σ item price×qty (qty ?? 1). */
function erpOrderTotal(o: ErpRecord): number {
  if (o.total != null && Number.isFinite(Number(o.total))) {
    return erpNum(o.total);
  }
  const items = Array.isArray(o.items) ? (o.items as unknown[]) : [];
  return items.reduce<number>((sum, raw) => {
    const it = (raw ?? {}) as ErpRecord;
    return sum + erpNum(it.price) * erpNum(it.qty != null ? it.qty : 1);
  }, 0);
}

/** Shop products carry `title`, ERP products carry `name` — accept both. */
function erpDisplayTitle(rec: ErpRecord): string {
  return erpStr(rec.title).trim() || erpStr(rec.name).trim();
}

/**
 * Normalize the settings singleton row into the full field set the deployed
 * shop's saveSettings() writes ({key, shopName, tagline, whatsapp,
 * deliveryFee, adminPin, accent, currency}) with the SAME defaults as its
 * defaultSettings(), so a never-visited shop still yields a complete,
 * render-ready object. The accent is regex-checked server-side because the
 * dashboard injects it into inline styles.
 *
 * C7 (APPEARANCE): the object is EXTENDED (additive) with theme/template/font/
 * sections — IDS ONLY, each validated against its allowlist and falling back to
 * the default (today's look) when absent or unrecognized. A legacy singleton
 * (none of these fields set) therefore normalizes to the byte-identical current
 * storefront, and a stored-but-corrupt id can never break rendering. No raw CSS
 * is ever read or stored.
 */
function normalizeErpSettings(row: ErpRecord | undefined) {
  const accent = erpStr(row?.accent);
  const theme = erpStr(row?.theme).trim().toLowerCase();
  const template = erpStr(row?.template).trim().toLowerCase();
  const font = erpStr(row?.font).trim().toLowerCase();
  const radius = erpStr(row?.radius).trim().toLowerCase();
  // sections: accept a stored CSV (or legacy array), re-validate to a canonical
  // CSV; anything invalid → the default (all sections on).
  const sections = normalizeErpSections(
    row?.sections !== undefined ? row.sections : ERP_DEFAULT_SECTIONS
  );
  return {
    key: 'settings',
    shopName:
      erpStr(row?.shopName).trim().slice(0, 60) || CDZ_TPL_DEFAULT_STORE_NAME,
    tagline:
      row?.tagline !== undefined
        ? erpStr(row.tagline).slice(0, 200)
        : ERP_DEFAULT_TAGLINE,
    whatsapp:
      erpStr(row?.whatsapp).replace(/[^0-9]/g, '') || CDZ_TPL_DEFAULT_WHATSAPP,
    deliveryFee:
      row?.deliveryFee != null
        ? Math.max(0, Math.round(erpNum(row.deliveryFee)))
        : 500,
    adminPin: erpStr(row?.adminPin).slice(0, 12) || CDZ_TPL_DEFAULT_PIN,
    // R3 — staff auth + published-module activation + seller identity (facturation).
    staffAuth: erpStr(row?.staffAuth) === '1' ? '1' : '0',
    erpBackends: erpStr(row?.erpBackends).slice(0, 200),
    sellerName: erpStr(row?.sellerName).slice(0, 80),
    sellerRc: erpStr(row?.sellerRc).slice(0, 40),
    sellerNif: erpStr(row?.sellerNif).slice(0, 40),
    sellerNis: erpStr(row?.sellerNis).slice(0, 40),
    sellerArt: erpStr(row?.sellerArt).slice(0, 40),
    sellerAddress: erpStr(row?.sellerAddress).slice(0, 200),
    sellerPhone: erpStr(row?.sellerPhone).slice(0, 20),
    accent: CDZ_ACCENT_RE.test(accent) ? accent : CDZ_TPL_DEFAULT_ACCENT,
    currency: erpStr(row?.currency).trim() || 'DZD',
    // C7 appearance ids (validated; defaults reproduce today's look).
    theme: (ERP_THEME_IDS as readonly string[]).includes(theme)
      ? theme
      : ERP_DEFAULT_THEME,
    template: (ERP_TEMPLATE_IDS as readonly string[]).includes(template)
      ? template
      : ERP_DEFAULT_TEMPLATE,
    font: (ERP_FONT_IDS as readonly string[]).includes(font)
      ? font
      : ERP_DEFAULT_FONT,
    sections: sections ?? ERP_DEFAULT_SECTIONS,
    radius: (ERP_RADIUS_IDS as readonly string[]).includes(radius)
      ? radius
      : ERP_DEFAULT_RADIUS,
  };
}

// ---------------------------------------------------------------------------
// SETTINGS-1 — keys the settings singleton carries that this controller does NOT
// edit, preserved verbatim through every merge.
//
// THE BUG THIS FIXES (live data loss): both settings writers rebuild the record as
// `{ ...normalizeErpSettings(baseRow), ...patch }`. normalizeErpSettings returns
// only the fields IT owns — appearance ids, seller identity, pin, whatsapp… — so
// any key it does not name was silently DESTROYED on the next save. Concretely: a
// merchant who enabled shop features (wishlist, reviews, promo codes, delivery
// matrix, order tracking, loyalty…) and then changed their theme or font on the
// Appearance tab lost every one of them, plus onlinePay, the darja/RTL state and
// every per-feature parameter. Nothing warned them; the storefront just quietly
// reverted.
//
// The deployed storefront's own admin already got this right — it explicitly
// preserves the fields its form does not edit — so the bridge was the odd one out.
//
// Param keys are enumerated from the feature registries rather than hardcoded, so
// a feature added later cannot silently start getting wiped again. Values are
// bounded (the caller's 8KB guard still applies) and only scalars are carried, so
// a malformed stored row cannot smuggle structure through.
const ERP_FEATURE_PARAM_KEYS: readonly string[] = Array.from(
  new Set(
    [...SHOP_FEATURES, ...ERP_FEATURES].flatMap(f =>
      Array.isArray(f.settingsKeys) ? f.settingsKeys : []
    )
  )
);

function erpSettingsPassthrough(row: ErpRecord | undefined): ErpRecord {
  const out: ErpRecord = {};
  if (!row) return out;
  if (typeof row.features === 'string') {
    out.features = row.features.slice(0, 500);
  }
  if (row.onlinePay === true) out.onlinePay = true;
  if (row.rtl === true) out.rtl = true;
  if (typeof row.lang === 'string') out.lang = row.lang.slice(0, 12);
  if (typeof row.heroLine === 'string') {
    out.heroLine = row.heroLine.slice(0, 200);
  }
  for (const k of ERP_FEATURE_PARAM_KEYS) {
    // `sections`/`onlinePay` are declared as feature settingsKeys but are owned by
    // normalizeErpSettings / handled above; the spread order below means the owner
    // always wins, so carrying them here is harmless.
    const v = (row as Record<string, unknown>)[k];
    if (typeof v === 'string') out[k] = v.slice(0, 1000);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// C4 — INVENTORY v2 (multi-warehouse, data-API collections).
//
// Two NET-NEW collections layered on the SAME per-slug data API the ERP admin
// routes already use (server-side, with the re-derived write token):
//   • `warehouses`            [{ id, name, location?, createdAt }] — bounded/tiny.
//   • `movements-YYYYMM`      append-only ledger, ONE Redis hash per month:
//        [{ id, ts, productKey, warehouseId, delta:int, reason, ref? }].
// Per-(product,warehouse) stock = Σ delta across the read window; the product's
// `stock` roll-up (total) is kept in sync via the existing erpUpsertProduct
// delete+recreate path so the storefront cards + erpSummary/lowStock keep
// working UNCHANGED (back-compat).
//
// WHY monthly partitions: the data API hard-caps a collection at 500 records
// (BadRequest "Collection is full") and `list()` reads exactly ONE hash — an
// append-only single `movements` collection would fill and start failing writes.
// `:` is ILLEGAL in a collection name (COLLECTION_RE), so the partition suffix
// uses a dash: `movements-YYYYMM` (16 chars, passes /^[a-z0-9_-]{1,32}$/). Reads
// fan out over a bounded window of monthly partitions and merge (exactly how the
// deployed ERP's loadAll() already fans one GET per collection).
// ---------------------------------------------------------------------------
// Movement reasons (the ledger's controlled vocabulary). Unknown reason → 400.
const ERP_MOVEMENT_REASONS = [
  'purchase',
  'sale',
  'adjust',
  'return',
  'transfer',
] as const;
type ErpMovementReason = (typeof ERP_MOVEMENT_REASONS)[number];
// Rolling read window: how many monthly partitions the inventory GET merges
// (current month + the previous 12 → last ~13 months). Bounds the fan-out so a
// long-lived shop never reads an unbounded number of hashes per request.
const ERP_MOVEMENT_MONTHS_READ = 13;
// Defensive cap on the warehouse list (well under the data API's 500/collection).
const ERP_MAX_WAREHOUSES = 100;
// Per-field caps for warehouse records (kept tiny; 8KB record cap is belt-and-
// braces on top of these).
const ERP_WAREHOUSE_NAME_MAX = 80;
const ERP_WAREHOUSE_LOCATION_MAX = 120;
const ERP_MOVEMENT_REF_MAX = 120;
// A movement delta is a signed integer; clamp its magnitude so a fat-finger
// can't write an absurd number (and to keep the record small).
const ERP_MOVEMENT_DELTA_MAX = 1_000_000;

/** The current-month movements partition collection name (`movements-YYYYMM`). */
function erpMovementCollection(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `movements-${y}${m}`;
}

/**
 * The last `count` monthly movement partition names, NEWEST first (current
 * month → older). Bounded by ERP_MOVEMENT_MONTHS_READ at the call sites.
 */
function erpMovementCollections(count: number): string[] {
  const out: string[] = [];
  const now = new Date();
  const n = Math.max(1, Math.min(Math.floor(count), 60));
  for (let i = 0; i < n; i++) {
    out.push(
      erpMovementCollection(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      )
    );
  }
  return out;
}

/**
 * Canonical product key for the inventory ledger: prefer `sku` (ERP shape),
 * else the display title (title||name), lowercased/trimmed. Matches the same
 * business key erpUpsertProduct upserts by, so a movement's productKey and the
 * product roll-up always line up.
 */
function erpProductKey(rec: ErpRecord): string {
  const sku = erpStr(rec.sku).trim();
  if (sku) return sku;
  return erpDisplayTitle(rec).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// C6 — CHARGILY payments (merchant keys / checkout / webhook).
//
// The merchant's Chargily API secret is a REAL credential and MUST NOT live in
// the public `settings` singleton (that collection is world-readable via the
// @Public data GET — it already leaks adminPin/whatsapp). It lives in a PRIVATE
// Redis key written only by an authed, owner-gated route and NEVER echoed in
// full (masked to last-4). Same CacheRedis the published-apps set uses.
// ---------------------------------------------------------------------------
/** Private Redis key holding the per-slug Chargily config (never public). */
const chargilyKey = (slug: string) => `clickdz:pay:chargily:${slug}`;
/** Private Redis key for the OPTIONAL PIM audit trail (never a public collection). */
const erpAuditKey = (slug: string) => `clickdz:erp:audit:${slug}`;
// Chargily Pay v2 REST bases. Live vs test are DISTINCT hosts (test never
// touches real money). Env-overridable for staging, defaulting to the documented
// production hosts.
const CHARGILY_LIVE_BASE = (
  process.env.CHARGILY_LIVE_BASE || 'https://pay.chargily.net/api/v2'
).replace(/\/+$/, '');
const CHARGILY_TEST_BASE = (
  process.env.CHARGILY_TEST_BASE || 'https://pay.chargily.net/test/api/v2'
).replace(/\/+$/, '');
const CHARGILY_TIMEOUT_MS = 15_000;
// Cap the order reference we forward as Chargily metadata / echo back.
const CHARGILY_ORDER_REF_MAX = 80;
// The paid amount is in DZD (integer dinars); clamp to a sane range so a bad
// caller can't create an absurd checkout.
const CHARGILY_MAX_AMOUNT = 100_000_000;

/** Chargily config as persisted in the private Redis key. */
interface ChargilyConfig {
  apiSecret: string;
  mode: 'test' | 'live';
  enabled: boolean;
}

/** Mask a secret to a hint (never returns more than the last 4 chars). */
function maskSecret(secret: string): string {
  const s = erpStr(secret);
  if (!s) return '';
  if (s.length <= 4) return '••••';
  return `••••${s.slice(-4)}`;
}

@Controller()
export class ClickDzBridgeController {
  private readonly logger = new Logger(ClickDzBridgeController.name);

  // WS4: CacheRedis for the per-owner published-apps set (same injection style
  // as clickdz-vdz.controller.ts). Models is still needed for cdzErpSeq (the
  // gap-less invoice sequence floor).
  //
  // EntitlementService replaces the old Models.userFeature premium lookup:
  // AFFiNE 0.27.3 narrowed UserFeatureName to 'administrator' and deleted
  // pro_plan_v1 / lifetime_pro_plan_v1, moving paid state to the entitlement
  // table. CacheRedis and Models are @Global; EntitlementModule is NOT, so it
  // is imported explicitly by CopilotModule.
  constructor(
    private readonly redis: CacheRedis,
    private readonly models: Models,
    private readonly entitlement: EntitlementService,
    private readonly copilotStorage: CopilotStorage
  ) {}

  // WS4 — per-owner published-apps set (Redis). Mirrors the vdz controller's
  // readOwnedIds / rolling-TTL idiom, but stores full {slug,url,createdAt}
  // records so /apps/mine can return them directly.

  /** Read the caller's published-app records (skips corrupt members). */
  private async readPublishedApps(ownerId: string): Promise<PublishedAppRecord[]> {
    const raw = await this.redis.smembers(publishedAppsKey(ownerId));
    if (!Array.isArray(raw)) return [];
    const out: PublishedAppRecord[] = [];
    for (const entry of raw) {
      try {
        const rec = JSON.parse(entry) as PublishedAppRecord;
        if (rec && typeof rec.slug === 'string') {
          // C5: carry kind/storeSlug when present (null-safe for legacy rows
          // written before this change — those simply omit the fields).
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
            url: typeof rec.url === 'string' ? rec.url : '',
            createdAt:
              typeof rec.createdAt === 'string'
                ? rec.createdAt
                : new Date().toISOString(),
            ...(kind ? { kind } : {}),
            ...(storeSlug ? { storeSlug } : {}),
          });
        }
      } catch {
        // ignore a corrupt member; it will be replaced on the next write
      }
    }
    return out;
  }

  /** Remove every stored record for `slug` from the caller's set (any url). */
  private async sremPublishedApp(ownerId: string, slug: string): Promise<void> {
    const records = await this.readPublishedApps(ownerId);
    const matches = records.filter(r => r.slug === slug);
    if (matches.length) {
      await this.redis.srem(
        publishedAppsKey(ownerId),
        ...matches.map(r => JSON.stringify(r))
      );
    }
  }

  /**
   * Record a successful publish for `slug` (idempotent per slug): drop any prior
   * record for the same slug, add the fresh one, and refresh the rolling TTL.
   */
  private async recordPublishedApp(
    ownerId: string,
    slug: string,
    url: string,
    // C5: optional pairing metadata persisted alongside the publish record so
    // GET /apps/mine can label Shop/ERP/App and thread the storeSlug pairing.
    meta?: { kind?: 'shop' | 'erp' | 'app'; storeSlug?: string }
  ): Promise<void> {
    const existing = await this.readPublishedApps(ownerId);
    const prior = existing.find(r => r.slug === slug);
    // Replace the slug's record in place (keep original createdAt if present).
    await this.sremPublishedApp(ownerId, slug);
    // Prefer freshly-supplied meta; otherwise preserve whatever the prior record
    // carried (a same-slug redeploy without meta must not drop its kind/store).
    const kind = meta?.kind ?? prior?.kind;
    const storeSlug = meta?.storeSlug ?? prior?.storeSlug;
    const record: PublishedAppRecord = {
      slug,
      url,
      createdAt: prior?.createdAt ?? new Date().toISOString(),
      ...(kind ? { kind } : {}),
      ...(storeSlug ? { storeSlug } : {}),
    };
    await this.redis.sadd(publishedAppsKey(ownerId), JSON.stringify(record));
    await this.redis.expire(publishedAppsKey(ownerId), PUBLISHED_APPS_TTL_SECONDS);
  }

  /**
   * WS4 premium gate. When CDZ_PUBLISH_REQUIRE_PRO is off (default) this is a
   * no-op. When on: allow if the user has a Pro/Lifetime feature OR their email
   * is allow-listed; otherwise emit a 402 upgrade_required and return false so
   * the caller stops. Uses @Res passthrough (the exact contract body/status can
   * only be produced by writing the response, not by a typed error's envelope).
   */
  private async assertCanPublish(
    user: CurrentUser,
    res: Response
  ): Promise<boolean> {
    if (!CDZ_PUBLISH_REQUIRE_PRO) return true;
    const email = (user.email || '').toLowerCase();
    if (email && CDZ_PUBLISH_ADMIN_EMAILS.includes(email)) return true;
    try {
      // getBestEntitlement already restricts to entitlements that are valid
      // right now (status/starts_at/expires_at/grace, plus self-host license
      // verification) and excludes the 'ai' plan for user targets, so a hit
      // here means a genuinely active paid entitlement. 'pro' and
      // 'lifetime_pro' are the successors of the removed pro_plan_v1 and
      // lifetime_pro_plan_v1 features.
      const ent = await this.entitlement.getBestEntitlement('user', user.id);
      if (ent?.plan === 'pro' || ent?.plan === 'lifetime_pro') return true;
    } catch (e) {
      // On an entitlement-store hiccup, fail CLOSED for the paid gate (deny) —
      // the gate exists to protect publishing. Log and treat as not-entitled.
      this.logger.warn(
        `[apps] premium-gate entitlement lookup failed for user=${user.id}: ${String(e)}`
      );
    }
    res.status(HttpStatus.PAYMENT_REQUIRED).json({ error: 'upgrade_required' });
    return false;
  }

  /**
   * WS4 + C2 cap enforcement, folded into the deploy path. Returns true when the
   * deploy may proceed. On ANY breach it writes the exact typed 409 body (whose
   * `message` NAMES the limit) and returns false. Same-slug redeploy is always
   * allowed. An optional body.replaceSlug is unpublished FIRST (freeing a slot).
   *
   * C2 (QUOTAS) — three caps, all computed from the existing Redis SET (no
   * schema change; the record already carries `kind`/`storeSlug`):
   *   1. TOTAL apps: at most CDZ_PUBLISH_MAX_APPS distinct published slugs
   *      (default 1) — the pre-existing behaviour, preserved.
   *   2. SHOP: at most one `kind:'shop'` store per user. A 2nd shop (a shop
   *      record with a DIFFERENT storeSlug) is a typed 409 `shop_limit_reached`.
   *   3. ERP: at most one STANDALONE `kind:'erp'` per user. A shop's PAIRED ERP
   *      (its storeSlug matches an existing shop's slug/storeSlug) is ALWAYS
   *      allowed — the shop+erp pair counts as the ONE shop. A 2nd standalone
   *      erp is a typed 409 `erp_limit_reached`.
   * Net product rule: 1 app, 1 shop(+its erp) per user.
   */
  private async assertUnderPublishCap(
    ownerId: string,
    slug: string,
    replaceSlug: string | undefined,
    // C2: the kind + shared storeSlug of THIS deploy (both may be undefined for
    // a plain generated app). Drive the per-kind caps + shop/erp pairing.
    kind: 'shop' | 'erp' | undefined,
    storeSlug: string | undefined,
    res: Response
  ): Promise<boolean> {
    // replaceSlug: unpublish that slug first (Vercel delete + srem), freeing a
    // slot before the cap check. Fail-soft on Vercel 404 (still srem).
    if (replaceSlug && replaceSlug !== slug) {
      await this.deleteAppFromVercel(replaceSlug, ownerId);
      await this.sremPublishedApp(ownerId, replaceSlug);
    }
    const existing = await this.readPublishedApps(ownerId);
    // Same-slug redeploy never grows the set — always allowed (unchanged).
    if (existing.some(r => r.slug === slug)) return true;

    // The storeSlug this deploy binds to. A shop's own slug doubles as its
    // storeSlug (the template returns storeSlug === slug), so fall back to the
    // slug when a shop deploy omits storeSlug.
    const thisStore = storeSlug || (kind === 'shop' ? slug : undefined);

    // ----- C2 (2): one SHOP store per user -----------------------------------
    if (kind === 'shop') {
      // Existing shop stores that are NOT this same store (a re-mint of the same
      // shop store keeps the count at one and is allowed to proceed to the total
      // cap check below).
      const otherShops = existing.filter(
        r =>
          r.kind === 'shop' &&
          (r.storeSlug || r.slug) !== thisStore
      );
      if (otherShops.length >= 1) {
        res.status(HttpStatus.CONFLICT).json({
          error: 'shop_limit_reached',
          limit: 1,
          message:
            'You can only have one shop. Delete your existing shop before creating another.',
          existing: otherShops.map(r => ({ slug: r.slug, url: r.url })),
        });
        return false;
      }
    }

    // ----- C2 (3): one STANDALONE ERP per user (a shop's paired ERP is free) --
    if (kind === 'erp') {
      // Is this ERP the paired ERP of an existing shop? (shares that shop's
      // slug/storeSlug). If so it belongs to the ONE shop and is always allowed.
      const isPairedWithShop =
        !!thisStore &&
        existing.some(
          r => r.kind === 'shop' && (r.storeSlug || r.slug) === thisStore
        );
      if (!isPairedWithShop) {
        // Standalone ERP. Count OTHER standalone erps (an erp whose store is
        // not this one and which is not itself paired to any shop store).
        const shopStores = new Set(
          existing
            .filter(r => r.kind === 'shop')
            .map(r => r.storeSlug || r.slug)
        );
        const otherStandaloneErps = existing.filter(
          r =>
            r.kind === 'erp' &&
            (r.storeSlug || r.slug) !== thisStore &&
            !shopStores.has(r.storeSlug || r.slug)
        );
        if (otherStandaloneErps.length >= 1) {
          res.status(HttpStatus.CONFLICT).json({
            error: 'erp_limit_reached',
            limit: 1,
            message:
              'You can only have one standalone ERP. Delete the existing one before creating another.',
            existing: otherStandaloneErps.map(r => ({
              slug: r.slug,
              url: r.url,
            })),
          });
          return false;
        }
      }
    }

    // ----- WS4 (1): generic-APP cap (CDZ_PUBLISH_MAX_APPS, preserved) ---------
    // The app cap governs GENERIC apps only (kind not shop/erp). This keeps the
    // net rule "1 app, 1 shop(+its erp)" possible — a shop and its paired ERP do
    // NOT consume the generic-app budget (they're governed by the per-kind caps
    // above). For a user who only ever publishes generic apps, this is identical
    // to the pre-C2 total cap (there are no shop/erp records to exclude).
    if (kind !== 'shop' && kind !== 'erp') {
      const genericApps = existing.filter(
        r => r.kind !== 'shop' && r.kind !== 'erp'
      );
      if (genericApps.length >= CDZ_PUBLISH_MAX_APPS) {
        res.status(HttpStatus.CONFLICT).json({
          error: 'publish_limit_reached',
          limit: CDZ_PUBLISH_MAX_APPS,
          message: `You have reached the limit of ${CDZ_PUBLISH_MAX_APPS} published app${CDZ_PUBLISH_MAX_APPS === 1 ? '' : 's'}.`,
          existing: genericApps.map(r => ({ slug: r.slug, url: r.url })),
        });
        return false;
      }
    }
    return true;
  }

  /**
   * Delete a deployed app's Vercel PROJECT (removes all its deployments +
   * the <project>.vercel.app domain). Mirrors deployAppToVercel's project-name
   * derivation, teamQuery builder and Bearer auth, using the v9 DELETE endpoint.
   * FAIL-SOFT: a Vercel 404 (already gone) is treated as success so the caller
   * still srem's the Redis record; other errors are logged, never thrown (the
   * srem must still happen so the user isn't wedged over the cap).
   */
  private async deleteAppFromVercel(slug: string, ownerId?: string): Promise<void> {
    if (!VERCEL_TOKEN) return;
    // WS17: namespace the Vercel project name per-owner so a slug collision
    // across users can't overwrite another user's live app. Vercel project names
    // are GLOBAL within a team; the prior `clickdz-app-${slug}` let a user pass
    // another user's slug and deploy over their project. The 8-char owner prefix
    // is unique per user and stays within the 52-char Vercel cap. Falls back to
    // the legacy `clickdz-app-${slug}` name for apps deployed before this change.
    const ownerPrefix = ownerId ? ownerId.slice(0, 8) : 'shared';
    const projectName = `cdz-${ownerPrefix}-${slug}`.slice(0, 52);
    const legacyProjectName = `clickdz-app-${slug}`.slice(0, 52);
    const teamQuery = VERCEL_TEAM_ID
      ? `?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`
      : '';
    // Try the new namespaced name; if Vercel 404s, try the legacy name too so
    // apps deployed before this change can still be unpublished.
    for (const name of [projectName, legacyProjectName]) {
      try {
        const res = await fetch(
          `https://api.vercel.com/v9/projects/${encodeURIComponent(name)}${teamQuery}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
            signal: AbortSignal.timeout(15000),
          }
        );
        // 200/204 = deleted; 404 = absent. A 404 on the first name means try the
        // legacy fallback; a 404 on the legacy name too is fine (already gone).
        if (res.ok || res.status === 404) {
          if (res.ok) {
            this.logger.log(`[apps] Vercel project ${name} deleted`);
          }
          // If the new name was found+deleted, no need to try legacy. If 404,
          // continue to the legacy fallback.
          if (res.ok || name === legacyProjectName) break;
          continue;
        }
        this.logger.warn(
          `[apps] Vercel project delete for ${name} returned ${res.status}`
        );
        break; // non-404 error on the first name — don't blindly retry legacy
      } catch (e) {
        this.logger.warn(
          `[apps] Vercel project delete for ${name} failed: ${String(e)}`
        );
        break;
      }
    }
  }

  /** bearer-token gate for external OpenAI-compatible clients */
  private assertBridgeToken(req: Request) {
    if (!CLICKDZ_BRIDGE_TOKEN) {
      throw new HttpException(
        { error: { message: 'Machine access to the ClickDz bridge is not configured', type: 'configuration_error', code: 'bridge_token_missing' } },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
    const auth = String(req.headers.authorization || '');
    // Constant-time compare so the bridge token can't be recovered by timing.
    if (!safeEqual(auth, `Bearer ${CLICKDZ_BRIDGE_TOKEN}`)) {
      throw new AuthenticationRequired('Invalid bridge token');
    }
  }

  /**
   * ClickDz smart router: picks the best Make agent for the request.
   * - clickdz-builder -> the high-token Builder runtime (IDE traffic)
   * - clickdz-ultra   -> intent-based routing across all agents
   * - everything else -> default agent selection (incl. Arabic detection)
   */
  private resolveAgentForRequest(
    model: string,
    messages: Array<{ role: string; content: string }>
  ): string | undefined {
    if (model === 'clickdz-builder' && MAKE_BUILDER_AGENT_ID) {
      return MAKE_BUILDER_AGENT_ID;
    }
    if (model !== 'clickdz-ultra') return undefined;
    const joined = messages.map(m => m.content).join('\n');
    const codeSignals =
      /```|<\/?[a-z]+>|\bfunction\b|\bconst\b|\bimport\b|\bcode\b|\bdebug\b|\bapp\b|\bcomponent\b|\bAPI\b/i;
    if (codeSignals.test(joined)) {
      return MAKE_BUILDER_AGENT_ID || MAKE_CODE_AGENT_ID || undefined;
    }
    if (hasArabic(joined)) return MAKE_ARABIC_AGENT_ID || undefined;
    // heavy/analytical and default traffic both fall through: the default
    // agent selection already prefers the Make super-agent when configured
    return undefined;
  }

  private assertMakeReady() {
    if (!MAKE_API_KEY || !MAKE_TEAM_ID || !MAKE_AGENT_ID) {
      throw new HttpException(
        {
          error: {
            message: 'Make.com AI agent is not configured',
            type: 'configuration_error',
            code: 'make_not_configured',
          },
        },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
  }

  private async runMakeAgent(
    messages: Array<{ role: string; content: string }>,
    model: string,
    agentIdOverride?: string,
    timeoutMs = 240000
  ) {
    // REROUTE: prefer the WORKING cdz-flash brain (api.clickdz.ai, OpenAI-
    // compatible) over the dead/paused Make AI-Agents path. Isolated, additive,
    // fail-open: any non-2xx / empty / throw / timeout falls through to the
    // untouched legacy Make call below, so behavior is unchanged when the
    // reroute is off or when cdz-flash is unavailable. Returns the same content
    // string shape callers already consume from parseMakeAgentResponse.
    if (CDZ_AGENT_VIA_CDZ_AI && CDZ_AI_KEY) {
      try {
        const response = await fetch(`${CDZ_AI_ORIGIN}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CDZ_AI_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: CDZ_AGENT_MODEL,
            messages,
            // SECURITY: clamp to the shared ceiling (<=4096, floor 1). Reuse the
            // existing clamp/DEFAULT machinery, requesting a roomier 2048 for
            // agent-style completions.
            max_tokens: clampMaxTokens(2048, DEFAULT_MAX_TOKENS),
          }),
          signal: AbortSignal.timeout(60000),
        });
        const data = (await response.json().catch(() => null)) as any;
        const content = data?.choices?.[0]?.message?.content;
        if (response.ok && typeof content === 'string' && content.trim()) {
          this.logger.log(
            `runMakeAgent reroute: served via cdz-flash (${CDZ_AGENT_MODEL}) for model=${model}`
          );
          return content;
        }
        this.logger.warn(
          `runMakeAgent reroute: cdz-flash unavailable (status=${response.status}); falling back to Make for model=${model}`
        );
      } catch {
        this.logger.warn(
          `runMakeAgent reroute: cdz-flash threw/timed out; falling back to Make for model=${model}`
        );
      }
    }

    this.assertMakeReady();
    const joined = messages
      .map(message => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n');
    const agentId =
      agentIdOverride ||
      (hasArabic(joined) || model.includes('arabic')
        ? MAKE_ARABIC_AGENT_ID
        : MAKE_AGENT_ID);
    const response = await fetch(
      `${MAKE_API_BASE}/ai-agents/v1/agents/${agentId}/run?teamId=${MAKE_TEAM_ID}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${MAKE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: `You are ClickDz Work AI. Answer directly and helpfully. Requested model: ${model}.\n\n${joined}`,
            },
          ],
          config: {},
        }),
        // large code generations can take a couple of minutes — fail
        // controlled instead of hanging forever
        signal: AbortSignal.timeout(timeoutMs),
      }
    );

    if (!response.ok) {
      throw new HttpException(
        {
          error: {
            message: `Make.com agent failed: ${response.status} ${response.statusText}`,
            type: 'provider_error',
            code: 'make_agent_failed',
          },
        },
        HttpStatus.BAD_GATEWAY
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    return parseMakeAgentResponse(data.response ?? data);
  }

  private async runFastPlanner(request: string) {
    const prompt = [
      'Act as the fast planning preflight for ClickDz Work.',
      'Read the request and return ONLY valid JSON with this exact shape:',
      '{"goal":"one short sentence stating what the plan achieves, in the user language","question":"one decisive clarification in the user language","options":["2 to 4 short answer choices"],"steps":[{"text":"a single concrete ordered action","recommended":true}],"suggestions":[{"text":"an optional nice-to-have step the user may want","recommended":false}]}',
      'Rules: "steps" = 3 to 6 core actions the plan needs, each recommended:true. "suggestions" = 0 to 3 OPTIONAL extra steps (recommended:false) the user can opt into — do not duplicate core steps. Ask exactly one high-value question. Keep every step short and imperative. Do NOT execute the request.',
      '',
      `REQUEST:\n${request.slice(0, 12000)}`,
    ].join('\n');

    if (CDZ_AI_KEY) {
      try {
        const response = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CDZ_AI_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: CDZ_CHAT_MODEL,
            messages: [{ role: 'user', content: prompt }],
            // SECURITY: clamp to a sane ceiling (<=4096, floor 1) to cap
            // upstream cost. Keeps the existing 700 default.
            max_tokens: clampMaxTokens(700, DEFAULT_MAX_TOKENS),
          }),
          signal: AbortSignal.timeout(30000),
        });
        const data = (await response.json()) as any;
        const content = data?.choices?.[0]?.message?.content;
        if (response.ok && typeof content === 'string' && content.trim()) {
          return content;
        }
      } catch {
        // Fall through to the Make agent so Plan mode stays available.
      }
    }

    return this.runMakeAgent(
      [{ role: 'user', content: prompt }],
      'clickdz-fast',
      undefined,
      30000
    );
  }

  /**
   * Best-effort one-line "what changed" summary for an app EDIT, produced by a
   * fast CDZ_AI (`cdz-flash`) call. The frontend (clickdz-builder-studio) already
   * reads `data.summary` and renders it in the version list; when this returns
   * nothing useful the client falls back to its own default label.
   *
   * Kept deliberately cheap and non-blocking: 5s timeout, tiny token budget, and
   * a deterministic fallback on ANY failure so a summary problem never breaks or
   * slows the edit itself. We pass only a size/shape diff-hint (not full HTML) to
   * keep the prompt small and the call fast.
   */
  private async summarizeEdit(
    prompt: string,
    oldHtml: string,
    newHtml: string
  ): Promise<string> {
    const fallback = 'Updated the app.';
    if (!CDZ_AI_KEY) {
      return fallback;
    }
    // Cheap structural diff-hint: byte delta + a coarse count of section-ish
    // landmarks so the model can describe the change without seeing the doc.
    const sectionCount = (html: string) =>
      (html.match(/<(section|header|footer|nav|main|article|form)\b/gi) || [])
        .length;
    const diffHint = [
      `bytes: ${oldHtml.length} -> ${newHtml.length} (delta ${newHtml.length - oldHtml.length})`,
      `sections: ${sectionCount(oldHtml)} -> ${sectionCount(newHtml)}`,
    ].join(', ');
    const summaryPrompt = [
      'You summarize a single edit made to a web app for a version history label.',
      'Return ONE short past-tense sentence (max ~12 words) describing what changed.',
      'No preamble, no quotes, no markdown. Example: "Added a pricing section with 3 tiers."',
      '',
      `USER REQUEST:\n${prompt.slice(0, 2000)}`,
      '',
      `CHANGE HINT: ${diffHint}`,
    ].join('\n');

    try {
      const response = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CDZ_AI_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CDZ_CHAT_MODEL,
          messages: [{ role: 'user', content: summaryPrompt }],
          max_tokens: clampMaxTokens(60, 60),
        }),
        // fast-tier: never let the summary delay the edit response
        signal: AbortSignal.timeout(5000),
      });
      const data = (await response.json()) as any;
      const content = data?.choices?.[0]?.message?.content;
      if (response.ok && typeof content === 'string' && content.trim()) {
        // one line only; strip wrapping quotes/backticks the model may add
        return content
          .trim()
          .split('\n')[0]
          .replace(/^["'`]+|["'`]+$/g, '')
          .slice(0, 140);
      }
    } catch {
      // fall through to deterministic fallback
    }
    return fallback;
  }

  /**
   * REAL SSE pass-through for the CDZ_AI direct path (A1). Calls the upstream
   * OpenAI-compatible `/v1/chat/completions` with `stream:true` and pipes its
   * `chat.completion.chunk` deltas straight to the client AS THEY ARRIVE — no
   * buffering of the full body — while re-stamping `id`/`model` to the bridge's
   * values so the emitted contract is byte-for-byte the shape the existing
   * fake-stream produced (`{id,object:'chat.completion.chunk',created,model,
   * choices:[{index,delta,finish_reason}]}` + a terminal `finish_reason:'stop'`
   * + `data: [DONE]`).
   *
   * Contract-preserving fallback: if the upstream does NOT start cleanly (network
   * error, non-2xx, or missing body) BEFORE any bytes are sent, returns `false`
   * so the caller runs the existing buffered Make path — no regression, no
   * dead-end. Once streaming has begun we own the response: an error mid-stream
   * emits a terminal `finish_reason:'stop'` + `[DONE]` and closes; a client abort
   * cancels the upstream fetch. Returns `true` when it has handled the response.
   */
  private async streamGatewayChat(
    res: Response,
    id: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    maxTokens: number,
    clientSignal: AbortSignal
  ): Promise<boolean> {
    // Abort upstream if the client disconnects or the request is aborted.
    const upstream = new AbortController();
    const onAbort = () => upstream.abort();
    if (clientSignal.aborted) upstream.abort();
    else clientSignal.addEventListener('abort', onAbort, { once: true });

    // NB: this file imports `Response` from express, so use the fetch return
    // type (not the DOM/global `Response`) to type the upstream response.
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CDZ_AI_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          max_tokens: maxTokens,
        }),
        signal: upstream.signal,
      });
    } catch {
      // Upstream never opened — no bytes sent yet, so the caller can safely
      // fall back to the buffered path.
      clientSignal.removeEventListener('abort', onAbort);
      return false;
    }

    if (!response.ok || !response.body) {
      // Non-2xx before we streamed anything: drain briefly (best-effort) and
      // let the caller fall back to Make so a transient upstream hiccup doesn't
      // become a hard failure.
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      clientSignal.removeEventListener('abort', onAbort);
      return false;
    }

    // We are committed to streaming now — headers + response are ours.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const send = (delta: Record<string, unknown>, finish: string | null) => {
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      );
    };
    // Opening role chunk — identical to the fake-stream's first frame.
    send({ role: 'assistant' }, null);

    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    try {
      // Node 18+/undici streams are async-iterable byte chunks. Parse the SSE
      // frames incrementally and forward ONLY the assistant delta text, so a
      // difference in the upstream envelope can never leak to our clients.
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(bytes, { stream: true });
        let sep: number;
        // SSE events are separated by a blank line ("\n\n").
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of rawEvent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            if (payload === '[DONE]') {
              finished = true;
              break;
            }
            try {
              const parsed = JSON.parse(payload) as {
                choices?: Array<{
                  delta?: { content?: unknown };
                  finish_reason?: string | null;
                }>;
              };
              const choice = parsed.choices?.[0];
              const text = choice?.delta?.content;
              if (typeof text === 'string' && text) {
                send({ content: text }, null);
              }
              // Upstream may signal completion via finish_reason instead of
              // (or before) a [DONE] line.
              if (choice?.finish_reason) finished = true;
            } catch {
              // Ignore a malformed/partial frame; the next chunk may complete it.
            }
          }
          if (finished) break;
        }
        if (finished) break;
      }
      // Normal completion: emit the terminal stop frame + [DONE], mirroring the
      // existing fake-stream contract exactly.
      send({}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
      return true;
    } catch {
      // Error AFTER streaming began (upstream drop / client abort). We can't
      // fall back now — close the stream cleanly with a terminal stop + [DONE]
      // so clients that already consumed deltas end gracefully rather than hang.
      try {
        if (!clientSignal.aborted) {
          send({}, 'stop');
          res.write('data: [DONE]\n\n');
        }
      } catch {
        /* the socket may already be gone */
      }
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return true;
    } finally {
      clientSignal.removeEventListener('abort', onAbort);
      upstream.abort();
    }
  }

  @Public()
  @Get(['/api/v1/models', '/v1/models'])
  // NOTE: must NOT be named `models` — that collides with the injected
  // `private readonly models: Models` property (TS2300), which shadows this
  // method on the instance. Route paths are unchanged.
  listModels(@Req() req: Request) {
    this.assertBridgeToken(req);
    return {
      object: 'list',
      data: MODELS.map(id => ({
        id,
        object: 'model',
        created: now(),
        owned_by:
          // WS14: all models served via Vercel AI Gateway
          'clickdz-ai',
      })),
    };
  }

  @Public()
  @Throttle('strict')
  @Post(['/api/v1/chat/completions', '/v1/chat/completions'])
  async chatCompletions(
    @Req() req: Request,
    @Body() body: any,
    @Res() res: Response
  ) {
    this.assertBridgeToken(req);
    const id = `chatcmpl_${Date.now()}`;
    // WS14: single model — zai/glm-4.6v-flash (9B vision-language, 128K ctx)
    const model = CDZ_CHAT_MODEL;
    const messages = normalizeMessages(body?.messages || []);
    const maxTokens = clampMaxTokens(body?.max_tokens, DEFAULT_MAX_TOKENS);
    const gatewayKey = CDZ_AI_GATEWAY_IMAGE_KEY;
    if (!gatewayKey) {
      throw new HttpException(
        { error: { message: 'AI Gateway key not configured', type: 'configuration_error', code: 'gateway_key_missing' } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // Always stream — native SSE pass-through from GLM-4.6V-Flash.
    if (body?.stream !== false) {
      const clientAbort = new AbortController();
      res.on('close', () => clientAbort.abort());
      const streamed = await this.streamGatewayChat(res, id, model, messages, maxTokens, clientAbort.signal);
      if (streamed) return;
    }

    // Non-streaming fallback (bufif body.stream === false)
    const resp = await fetch(`${CDZ_AI_GATEWAY_IMAGE_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gatewayKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(60000),
    });
    const data = (await resp.json().catch(() => null)) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!resp.ok || typeof content !== 'string') {
      throw new HttpException(
        { error: { message: `Chat failed: ${resp.status}`, type: 'provider_error' } },
        HttpStatus.BAD_GATEWAY,
      );
    }
    res.json(openAIChatResponse(id, model, content));
  }

  /** Fast Plan-mode preflight: one decisive question before the full model runs. */
  @Throttle('strict')
  @Post('/api/v1/plan/clarify')
  async clarifyPlan(@Body() body: any) {
    const request = String(body?.request || '').trim();
    if (!request) {
      throw new HttpException(
        { error: { message: 'A request is required', type: 'invalid_request_error', code: 'request_missing' } },
        HttpStatus.BAD_REQUEST
      );
    }
    if (request.length > MAX_PROMPT_CHARS) {
      throw new PayloadTooLargeException(`Request is too long (max ${MAX_PROMPT_CHARS} characters)`);
    }
    const raw = await this.runFastPlanner(request);
    return parsePlanClarification(raw);
  }

  /**
   * WS1 PR6 — image prompt clarifier (zai/glm-4.6v-flash, vision-capable).
   */
  @Throttle('strict')
  @Post('/api/v1/images/clarify')
  async clarifyImagePrompt(@Body() body: any) {
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      throw new HttpException(
        { error: { message: 'A non-empty "prompt" string is required', type: 'invalid_request_error',
            code: 'prompt_missing',
          },
        },
        HttpStatus.BAD_REQUEST
      );
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new PayloadTooLargeException(
        `Prompt is too long (max ${MAX_PROMPT_CHARS} characters)`
      );
    }
    const raw = await this.runImageClarifier(prompt);
    return parseImageClarification(raw);
  }

  /**
   * cdz-flash image-prompt clarifier (Make fallback, empty-string last —
   * the parser fail-opens on anything unusable).
   */
  private async runImageClarifier(request: string): Promise<string> {
    const prompt = [
      'You are the image-request clarifier for ClickDz Work.',
      'Decide if this image request needs ONE clarifying question before',
      'generation, and return ONLY valid JSON with this exact shape:',
      '{"needs_details": true, "question": "one short decisive question in the user language", "options": ["2 to 4 short concrete choices"], "suggested": {"subject": "the main subject, enriched", "style": "a fitting visual style", "mood": "a fitting mood/lighting", "aspect": "square|landscape|portrait"}}',
      'Rules:',
      '- needs_details=false when the request ALREADY specifies a clear subject',
      '  plus at least one of: style, mood, setting, or composition. Rich',
      '  requests must auto-skip — do not invent questions for them.',
      '- Ask about the single BIGGEST missing visual decision only (style vs',
      '  subject detail vs mood — never more than one question).',
      '- Options must be concrete and instantly pickable (e.g. "cinematic',
      '  photo", "flat illustration"), never "other" or "you decide".',
      '- suggested.* must always be filled with your best enrichment of the',
      '  request, usable as-is if the user skips.',
      '- Do NOT generate the image. Output the JSON only.',
      '',
      `REQUEST:\n${request.slice(0, 4000)}`,
    ].join('\n');

    if (CDZ_AI_KEY) {
      try {
        const response = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CDZ_AI_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: CDZ_CHAT_MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: clampMaxTokens(400, DEFAULT_MAX_TOKENS),
          }),
          signal: AbortSignal.timeout(12000),
        });
        const data = (await response.json()) as any;
        const content = data?.choices?.[0]?.message?.content;
        if (response.ok && typeof content === 'string' && content.trim()) {
          return content;
        }
      } catch {
        // fall through to the Make agent
      }
    }
    try {
      return await this.runMakeAgent(
        [{ role: 'user', content: prompt }],
        'clickdz-fast',
        undefined,
        15000
      );
    } catch {
      return '';
    }
  }

  /** extract text from an attached image via the Make OCR scenario */
  private async ocrImageContext(fileUrl: string): Promise<string> {
    if (!MAKE_OCR_WEBHOOK_URL || !fileUrl) return '';
    // SECURITY (SSRF): fileUrl is user-supplied and gets fetched (server-side,
    // via the OCR scenario). Reject loopback/private/link-local/metadata
    // targets before use. On rejection, return empty OCR context so image
    // generation still proceeds (non-breaking) and log a warning.
    if (!isSafePublicUrl(fileUrl)) {
      this.logger.warn(
        `[ocr] rejected unsafe image URL (SSRF guard): ${String(fileUrl).slice(0, 120)}`
      );
      return '';
    }
    try {
      // R15: fetch the image bytes ourselves; the new Make OCR scenario takes
      // base64 in JSON and returns the extracted text as a raw text/plain body
      // (the old {file_url}->{text} contract belonged to the prior account).
      const imgRes = await fetch(fileUrl, { signal: AbortSignal.timeout(30000) });
      if (!imgRes.ok) return '';
      const bytes = Buffer.from(await imgRes.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_INPUT_BYTES) return '';
      const imageBase64 = bytes.toString('base64');

      const response = await fetch(MAKE_OCR_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64 }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) return '';
      const text = await response.text();
      return typeof text === 'string' ? text.trim().slice(0, 4000) : '';
    } catch {
      // OCR is best-effort context — never block generation on it
      return '';
    }
  }

  /**
   * WS1 PR2 — vision description for the REINTERPRET path: a fast cdz-flash
   * vision call describes the reference image (subjects, composition, style,
   * palette, visible text verbatim) for prompt-pro to blend into a fresh
   * generation. Falls back to the Make OCR webhook (remote URLs only — the
   * webhook can't fetch a data: URL), then to empty context. Best-effort:
   * never blocks generation.
   */
  private async describeImageContext(
    imageRef: string,
    // Fast mode passes ~6s; default preserves the original 15s budget.
    timeoutMs = 15000
  ): Promise<string> {
    if (!imageRef) return '';
    if (CDZ_AI_KEY) {
      try {
        const response = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CDZ_AI_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: CDZ_CHAT_MODEL,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Describe this image precisely as reference context for an image-generation prompt: subject(s), composition, style, color palette, lighting, mood, and any visible text VERBATIM in quotes. Plain text, at most 120 words.',
                  },
                  { type: 'image_url', image_url: { url: imageRef } },
                ],
              },
            ],
            max_tokens: clampMaxTokens(350, DEFAULT_MAX_TOKENS),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = (await response.json()) as any;
        const content = data?.choices?.[0]?.message?.content;
        if (response.ok && typeof content === 'string' && content.trim()) {
          return content.trim().slice(0, 2000);
        }
      } catch {
        // fall through to the OCR webhook
      }
    }
    if (/^data:/i.test(imageRef)) return '';
    return this.ocrImageContext(imageRef);
  }

  /**
   * Prompt-pro (WS1): enhance a raw image prompt via a FAST direct cdz-flash
   * call, falling back to the Make agent, falling back to the user's own
   * words. Never blocks generation — every failure path returns a usable
   * prompt. cdz-flash replaces Make as primary because the enhancement sits
   * on the critical path of every CDZIMAGE generation and the direct call is
   * seconds faster (same swap the fast-planner made).
   */
  private async enhanceImagePrompt(
    rawPrompt: string,
    ocrContext: string
  ): Promise<string> {
    const parts = [IMAGE_ENHANCER_GUIDELINES];
    if (ocrContext) {
      parts.push(
        `Content extracted from the user's attached reference image:\n"""${ocrContext}"""\nBlend this reference faithfully into the scene.`
      );
    }
    parts.push(`Request: ${rawPrompt}`);
    const enhancerInput = parts.join('\n\n');

    // sanity shared by both paths: reject junk, keep the user's words
    const accept = (candidate: string): string | null => {
      const cleaned = (candidate || '').trim().replace(/^["'`]+|["'`]+$/g, '');
      if (cleaned.length < 10 || cleaned.length > 4000) return null;
      return cleaned;
    };

    if (CDZ_AI_KEY) {
      try {
        const response = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CDZ_AI_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: CDZ_CHAT_MODEL,
            messages: [{ role: 'user', content: enhancerInput }],
            // ~180-word prompt ceiling per the guidelines; clamp cost hard.
            max_tokens: clampMaxTokens(400, DEFAULT_MAX_TOKENS),
          }),
          // Cap the primary cdz-flash call at 8s (was 12s) so a slow enhancer
          // degrades to the Make fallback / raw prompt faster.
          signal: AbortSignal.timeout(8000),
        });
        const data = (await response.json()) as any;
        const content = data?.choices?.[0]?.message?.content;
        if (response.ok && typeof content === 'string') {
          const cleaned = accept(content);
          if (cleaned) return cleaned;
        }
      } catch {
        // fall through to the Make enhancer
      }
    }

    try {
      const enhanced = await this.runMakeAgent(
        [{ role: 'user', content: enhancerInput }],
        'clickdz-image-enhancer'
      );
      const cleaned = accept(enhanced || '');
      if (cleaned) return cleaned;
      return rawPrompt;
    } catch {
      return rawPrompt;
    }
  }

  @Throttle('strict')
  @Post(['/api/v1/images/generations', '/v1/images/generations'])
  async imageGenerations(
    @Body() body: any,
    @CurrentUser() user?: CurrentUser
  ) {
    // SECURITY: this route hits the paid OpenAI images API. Validate input
    // defensively before doing any upstream work.
    if (typeof body?.prompt !== 'string' || !body.prompt.trim()) {
      throw new BadRequestException(
        'A non-empty "prompt" string is required'
      );
    }
    if (body.prompt.length > MAX_PROMPT_CHARS) {
      throw new PayloadTooLargeException(
        `Prompt is too long (max ${MAX_PROMPT_CHARS} characters)`
      );
    }

    // ---- Per-user generation cap (2026-08-14 budget hardening) ------------
    // Enforce daily quota per authenticated user via Redis INCR + EXPIRE.
    // Config via env: CDZ_IMAGE_DAILY_LIMIT (default 50), CDZ_IMAGE_DAILY_LIMIT_ENABLED (default 1).
    // Fail-open on Redis errors so a cache outage does not block generations.
    const dailyLimitEnabled = process.env.CDZ_IMAGE_DAILY_LIMIT_ENABLED !== '0';
    const dailyLimit = Math.max(1, parseInt(process.env.CDZ_IMAGE_DAILY_LIMIT || '50', 10) || 50);
    if (dailyLimitEnabled && user?.id) {
      const dayKey = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const quotaKey = `clickdz:gen:${user.id}:${dayKey}`;
      try {
        const count = await this.redis.incr(quotaKey);
        if (count === 1) {
          await this.redis.expire(quotaKey, 86400);
        }
        if (count > dailyLimit) {
          await this.redis.decr(quotaKey);
          throw new HttpException(
            {
              error: {
                message: `Daily image generation limit reached (${dailyLimit}/day). Try again tomorrow.`,
                type: 'rate_limit_error',
                code: 'daily_limit_exceeded',
                limit: dailyLimit,
                count,
              },
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      } catch (err) {
        if (
          err instanceof HttpException &&
          (err as any)?.getResponse?.()?.error?.code === 'daily_limit_exceeded'
        ) {
          throw err;
        }
        // Fail-open on Redis errors (log but allow generation)
        try {
          this.logger?.warn?.(`Quota check failed (fail-open) for ${user.id}: ${(err as Error)?.message}`);
        } catch {}
      }
    }

    // ---- CDZIMAGE model resolution (WS1) --------------------------------
    const requestedModel = String(body?.model || '');
    let resolution = resolveCdzImageModel(requestedModel);
    if (resolution === 'invalid') {
      throw new HttpException(
        {
          error: {
            message: `Unknown image model "${requestedModel}". Valid: ${[
              ...Object.keys(CDZIMAGE_TIERS),
              ...Object.keys(CDZIMAGE_LEGACY_ALIASES),
            ].join(', ')}`,
            type: 'invalid_request_error',
            code: 'image_model_invalid',
          },
        },
        HttpStatus.BAD_REQUEST
      );
    }
    if (resolution === 'missing') {
      if (CDZIMAGE_REQUIRE_MODEL) {
        // Strict mode (flips on once every surface ships its picker): the
        // owner's contract that EVERY generation carries an explicit choice.
        throw new HttpException(
          {
            error: {
              message: `An image model is required. Pick one of: ${Object.keys(CDZIMAGE_TIERS).join(', ')}`,
              type: 'invalid_request_error',
              code: 'image_model_required',
            },
          },
          HttpStatus.BAD_REQUEST
        );
      }
      // Transition mode: default to the flagship tier so pre-picker clients
      // (e.g. the Vdz media bin until WS1 PR4) keep working — upgraded, even.
      resolution = {
        tierId: CDZIMAGE_DEFAULT_TIER,
        ...CDZIMAGE_TIERS[CDZIMAGE_DEFAULT_TIER],
        source: 'default',
      };
    }

    // ---- Provider key guards (per resolved engine) -----------------------
    // The OpenAI key is only required when the resolved engine is actually a
    // gpt-image model — a gemini-* request must NOT 503 just because the
    // OpenAI key is absent. Conversely a gemini engine without a Gemini key
    // 503s with its own typed code; the OpenAI path is byte-identical.
    if (!String(resolution.engine).startsWith('gemini-') && !OPENAI_IMAGE_API_KEY) {
      throw new HttpException(
        { error: { message: 'OpenAI image generation key is not configured', type: 'configuration_error', code: 'openai_image_key_missing' } },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
    // WS14: Prodia Flux Schnell via Vercel AI Gateway — text-to-image only.
    // The gateway key is the same CUSTOM_LLM_API_KEY used for chat LLMs.
    if (String(resolution.engine) === 'prodia-flux-schnell' && !CDZ_AI_GATEWAY_IMAGE_KEY) {
      throw new HttpException(
        {
          error: {
            message:
              'Flux image generation is not configured. Set CDZ_AI_GATEWAY_KEY or CUSTOM_LLM_API_KEY to a valid Vercel AI Gateway key.',
            type: 'configuration_error',
            code: 'flux_image_key_missing',
          },
        },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }

    // ---- Image-to-image router (WS1 PR2) ---------------------------------
    // `image` / `image_url` (+ optional `mask` / `mask_url`) supplies an
    // input image. Default with an image = a TRUE EDIT via /v1/images/edits
    // (the engine sees the pixels; the mask marks the editable region).
    // `mode: 'reinterpret'` instead ANALYZES the reference (cdz-flash vision,
    // Make-OCR fallback) and feeds the description through prompt-pro into a
    // FRESH generation — the old reference behavior, upgraded.
    const imageRef =
      typeof body?.image === 'string' && body.image
        ? String(body.image)
        : typeof body?.image_url === 'string'
          ? String(body.image_url)
          : '';
    const maskRef =
      typeof body?.mask === 'string' && body.mask
        ? String(body.mask)
        : typeof body?.mask_url === 'string'
          ? String(body.mask_url)
          : '';
    const requestedMode =
      body?.mode === 'reinterpret' || body?.mode === 'edit'
        ? (body.mode as 'reinterpret' | 'edit')
        : undefined;
    if (requestedMode === 'edit' && !imageRef) {
      throw new HttpException(
        {
          error: {
            message: 'mode "edit" requires an input image ("image" or "image_url")',
            type: 'invalid_request_error',
            code: 'image_input_required',
          },
        },
        HttpStatus.BAD_REQUEST
      );
    }
    const i2iMode: 'edit' | 'reinterpret' | 'none' = imageRef
      ? (requestedMode ?? 'edit')
      : 'none';

    // Fast mode (Bolt): additive, fail-open latency cut — skips prompt-pro,
    // drops tier quality one notch (below), and runs reinterpret's vision pass
    // on a ~6s budget folded into the raw prompt.
    const fastMode = body?.fast === true;

    // ---- Prompt-pro (env-gated default; explicit opt-in/out wins) -------
    // Raw-engine requests (OpenAI-compatible machine clients) keep their
    // prompt verbatim. For everyone else, enhancement defaults OFF
    // (ENHANCE_DEFAULT_ON — set CDZIMAGE_ENHANCE_DEFAULT=1 to restore the old
    // always-on behavior). body.enhance=true is a hard opt-in, body.enhance=
    // false is a hard opt-out; fastMode skips enhancement below regardless.
    // Edit mode enhances the INSTRUCTION only (the engine sees the pixels);
    // reinterpret mode folds the vision description into the enhancement.
    let prompt = String(body?.prompt || '');
    let enhancedPrompt: string | undefined;
    let ocrUsed = false;
    const wantsEnhance =
      resolution.source !== 'raw-engine' &&
      (body?.enhance === true ||
        (body?.enhance !== false && ENHANCE_DEFAULT_ON));
    if (fastMode) {
      // Skip prompt-pro; still fold a reinterpret reference in via a tightened
      // (~6s) vision describe, falling open to the bare prompt on timeout.
      if (wantsEnhance && prompt && i2iMode === 'reinterpret') {
        const referenceContext = await this.describeImageContext(imageRef, 6000);
        ocrUsed = !!referenceContext;
        if (referenceContext) {
          prompt = `${prompt}\n\nReference context: ${referenceContext}`;
        }
      }
    } else if (wantsEnhance && prompt) {
      const referenceContext =
        i2iMode === 'reinterpret'
          ? await this.describeImageContext(imageRef)
          : '';
      ocrUsed = !!referenceContext;
      enhancedPrompt = await this.enhanceImagePrompt(prompt, referenceContext);
      prompt = enhancedPrompt;
    }

    const model = resolution.engine;
    // gpt-image-* rejects response_format/style and always returns b64_json;
    // (all CDZIMAGE OpenAI engines are gpt-image-*, guard kept for safety.)
    const isGptImage = String(model).startsWith('gpt-image');
    // WS14: prodia-flux-schnell routes through Vercel AI Gateway's OpenAI-compatible
    // /v1/images/generations endpoint. Flux is text-to-image only — i2i requests
    // fall through to the gpt-image-* OpenAI edit path.
    const isFluxGateway = String(model) === 'prodia-flux-schnell';
    // Per-tier quality default (2.0 high / 1.5 medium / 1.0 low); explicit
    // body.quality wins when it's one of the valid knobs. Fast mode drops the
    // resolved-tier default one notch (never the engine); body.quality wins.
    const tierQuality = fastMode
      ? ({ high: 'medium', medium: 'low', low: 'low' } as const)[
          resolution.quality
        ]
      : resolution.quality;
    const requestedQuality = String(body?.quality || '');
    const quality = ['low', 'medium', 'high', 'auto'].includes(requestedQuality)
      ? requestedQuality
      : tierQuality;
    const finalPrompt = String(prompt || body?.prompt || '');
    const size = String(body?.size || '1024x1024');

    // ImgPerf: Redis prompt-hash cache (text-to-image only). Computes a stable
    // key from the canonicalized request, checks the cache, and returns the
    // stored response on a hit — skipping the provider call entirely. Fail-
    // open: any cache error falls through to a normal generation below.
    if (CDZ_IMAGE_CACHE_ENABLED && i2iMode === 'none') {
      const normalizedPrompt = finalPrompt
        .normalize('NFC')
        .trim()
        .replace(/\s+/g, ' ');
      const cacheKey =
        CDZ_IMAGE_CACHE_PREFIX +
        createHash('sha256')
          .update(
            JSON.stringify({
              prompt: normalizedPrompt,
              model,
              size,
              quality,
              enhance: wantsEnhance,
              i2iMode,
            })
          )
          .digest('hex');
      try {
        const cached = await this.redis.get(cacheKey).catch(() => null);
        if (cached) {
          const cachedData = JSON.parse(cached) as any;
          if (cachedData && Array.isArray(cachedData?.data)) {
            // Re-attach the live clickdz metadata so the response carries
            // current resolution info; mark the cache hit for observability.
            cachedData.clickdz = {
              ...(cachedData.clickdz ?? {}),
              model: resolution.tierId,
              label: resolution.label,
              engine: resolution.engine,
              model_source: resolution.source,
              enhanced_prompt: cachedData.clickdz?.enhanced_prompt,
              reference_ocr_used: cachedData.clickdz?.reference_ocr_used ?? false,
              fast: fastMode,
              quality,
              imageCacheHit: true,
            };
            cachedData._cache = 'hit';
            void createPostHogClientFromEnv().capture({
              event: 'generation_completed',
              distinctId: user?.id ?? 'anonymous',
              properties: {
                kind: 'image',
                model: resolution.tierId,
                engine: resolution.engine,
                quality,
                fast: fastMode,
                i2i: i2iMode,
                cache: 'hit',
              },
            });
            return cachedData;
          }
        }
      } catch {
        // Cache read/parse failure — fail open, proceed to live generation.
      }
    }

    let response: Awaited<ReturnType<typeof fetch>>;
    let data: any;
    if (isFluxGateway) {
      // WS14: Prodia Flux Schnell via Vercel AI Gateway (OpenAI-compatible endpoint).
      // Text-to-image only — Flux has no image-to-image capability. The Gateway
      // provides automatic retry, failover, and unified billing on the existing key.
      // Response is already in OpenAI shape: { data: [{ b64_json }] }.
      if (i2iMode === 'edit') {
        throw new HttpException(
          {
            error: {
              message:
                'Flux Schnell is text-to-image only. Use a gpt-image-* tier for image-to-image editing.',
              type: 'invalid_request_error',
              code: 'flux_no_i2i',
            },
          },
          HttpStatus.BAD_REQUEST
        );
      }
      const fluxRes = await fetch(
        `${CDZ_AI_GATEWAY_IMAGE_BASE}/v1/images/generations`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CDZ_AI_GATEWAY_IMAGE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'prodia/flux-fast-schnell',
            prompt: finalPrompt,
            n: 1,
            size,
          }),
          signal: AbortSignal.timeout(
            fastMode ? FAST_IMAGE_TIMEOUT_MS : 120000
          ),
        }
      );
      data = (await fluxRes.json()) as any;
      if (!fluxRes.ok) {
        throw new HttpException(data, fluxRes.status);
      }
    } else if (i2iMode === 'edit') {
      // TRUE image-to-image: multipart to /v1/images/edits. Inputs resolve
      // from data: URLs (inline) or SSRF-guarded public URLs; hard size caps.
      const image = await fetchImageInput(imageRef, 'image');
      const mask = maskRef ? await fetchImageInput(maskRef, 'mask') : null;
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', finalPrompt);
      form.append('n', '1');
      form.append('size', size);
      if (isGptImage) form.append('quality', quality);
      form.append(
        'image',
        new Blob([image.bytes], { type: image.mime }),
        `image.${IMAGE_MIME_EXT[image.mime] ?? 'png'}`
      );
      if (mask) {
        form.append(
          'mask',
          new Blob([mask.bytes], { type: mask.mime }),
          `mask.${IMAGE_MIME_EXT[mask.mime] ?? 'png'}`
        );
      }
      response = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_IMAGE_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(
          fastMode ? FAST_IMAGE_TIMEOUT_MS : 180000
        ),
      });
    } else {
      const payload: Record<string, unknown> = {
        model,
        prompt: finalPrompt,
        n: Math.min(Number(body?.n || 1), 1),
        size,
      };
      if (isGptImage) {
        payload.quality = quality;
      } else {
        payload.response_format = body?.response_format || 'url';
        payload.style = body?.style || 'vivid';
      }
      response = await fetch(
        'https://api.openai.com/v1/images/generations',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${OPENAI_IMAGE_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(
            fastMode ? FAST_IMAGE_TIMEOUT_MS : 180000
          ),
        }
      );
    }
    if (!isGemini) {
      data = (await response.json()) as any;
      if (!response.ok) {
        throw new HttpException(data, response.status);
      }
    }
    // normalize: expose a data URL for b64 responses so url-consumers work
    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        if (item && !item.url && typeof item.b64_json === 'string') {
          item.url = `data:image/png;base64,${item.b64_json}`;
        }
      }
    }
    // CDZIMAGE metadata — now attached to EVERY generation (superset of the
    // old clickdz-only shape; enhanced_prompt/reference_ocr_used keys kept).
    data.clickdz = {
      model: resolution.tierId,
      label: resolution.label,
      engine: resolution.engine,
      model_source: resolution.source,
      enhanced_prompt: enhancedPrompt,
      reference_ocr_used: ocrUsed,
      fast: fastMode,
      quality,
      imageCacheHit: false,
      ...(i2iMode !== 'none'
        ? {
            i2i: {
              mode: i2iMode,
              mask_used: i2iMode === 'edit' && Boolean(maskRef),
            },
          }
        : {}),
    };
    // ImgPerf: store successful text-to-image generations in the prompt-hash
    // cache so identical subsequent requests hit instead of re-calling the
    // provider. Only text-to-image (i2iMode 'none') — edit/reinterpret depend
    // on input pixels the hash can't capture. Fail-open: a cache write error
    // is swallowed and NEVER breaks a successful generation.
    if (CDZ_IMAGE_CACHE_ENABLED && i2iMode === 'none') {
      try {
        const normalizedPrompt = finalPrompt
          .normalize('NFC')
          .trim()
          .replace(/\s+/g, ' ');
        const cacheKey =
          CDZ_IMAGE_CACHE_PREFIX +
          createHash('sha256')
            .update(
              JSON.stringify({
                prompt: normalizedPrompt,
                model,
                size,
                quality,
                enhance: wantsEnhance,
                i2iMode,
              })
            )
            .digest('hex');
        await this.redis
          .set(cacheKey, JSON.stringify(data), 'EX', CDZ_IMAGE_CACHE_TTL)
          .catch(() => {});
      } catch {
        // Cache write failure — fail open, the generation already succeeded.
      }
    }
    data._cache = 'miss';
    // PostHog server-side event (no-op unless CDZ_POSTHOG_KEY/HOST are set):
    // a generation completed on the paid images route. Fire-and-forget — never
    // delays or fails the response.
    void createPostHogClientFromEnv().capture({
      event: 'generation_completed',
      distinctId: user?.id ?? 'anonymous',
      properties: {
        kind: 'image',
        model: resolution.tierId,
        engine: resolution.engine,
        quality,
        fast: fastMode,
        i2i: i2iMode,
      },
    });
    return data;
  }

  /**
   * C2 (VERCEL HARDENING): map a Vercel upstream HTTP status to this route's
   * typed contract body (written via passthrough `res` — a raw HttpException
   * would be flattened to a generic 500 by the global filter, dropping the
   * body). Distinguishes:
   *   401            -> 503 vercel_auth_failed   (token invalid/expired: config)
   *   402 / 403      -> 402 vercel_quota_or_plan (billing/plan/quota — user-fix)
   *   429            -> 429 vercel_rate_limited  (transient; retry later)
   *   anything else  -> 502 vercel_deploy_failed (generic upstream failure)
   * The message NAMES the reason so the frontend can tell the user what to do.
   * NEVER logs the token. `detail` is a short upstream message slice only.
   */
  private writeVercelUpstreamError(
    res: Response,
    status: number,
    detail: string
  ): void {
    const short = (detail || '').slice(0, 200);
    if (status === 401) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: 'vercel_auth_failed',
        message:
          'Publishing is misconfigured: Vercel rejected the deploy token (401). An administrator must refresh VERCEL_TOKEN.',
        status,
      });
    } else if (status === 402 || status === 403) {
      res.status(HttpStatus.PAYMENT_REQUIRED).json({
        error: 'vercel_quota_or_plan',
        message:
          'Vercel refused the deployment for a plan/quota/permission reason (402/403). Check the Vercel plan or project limits.',
        status,
      });
    } else if (status === 429) {
      res.status(HttpStatus.TOO_MANY_REQUESTS).json({
        error: 'vercel_rate_limited',
        message:
          'Vercel is rate-limiting deployments (429). Please wait a moment and try publishing again.',
        status,
      });
    } else {
      res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'vercel_deploy_failed',
        message: short || 'The deployment provider returned an error.',
        status,
      });
    }
  }

  /**
   * Deploy a single-file app to Vercel and wait for it to go live.
   *
   * C2 (VERCEL HARDENING): takes the deploy route's passthrough `res` and
   * returns a discriminated result. On ANY failure it writes the exact typed
   * contract body to `res` (503/502/402/429 — see writeVercelUpstreamError) and
   * returns `{ ok: false }`; the caller then returns immediately WITHOUT
   * recording a publish (no silent partial success). On success it returns
   * `{ ok: true, deployed }` with the SAME success wire shape as before.
   *
   * Hardening vs. the previous implementation:
   *  • preflight VERCEL_TOKEN inside the helper too -> typed 503 (belt & braces
   *    with the route's own preflight).
   *  • the create POST + its JSON parse are wrapped so a network throw / non-JSON
   *    body becomes a typed 502 instead of an uncaught 500.
   *  • the poll loop uses incremental backoff with a ~40s HARD DEADLINE and each
   *    poll fetch/parse is individually try/caught (a transient poll throw is
   *    tolerated, not fatal); still-not-READY at the deadline OR a terminal
   *    'ERROR'/'CANCELED' build is a typed 502 — never returned as success.
   */
  private async deployAppToVercel(
    slug: string,
    html: string,
    res: Response,
    ownerId?: string
  ): Promise<
    | {
        ok: true;
        deployed: {
          slug: string;
          state: string;
          url: string;
          deploymentUrl: string | undefined;
        };
      }
    | { ok: false }
  > {
    // Preflight: no token -> publishing is not configured (typed 503).
    if (!VERCEL_TOKEN) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: 'publishing_not_configured',
        message: 'Publishing is not configured on this deployment.',
      });
      return { ok: false };
    }
    // WS17: namespace the Vercel project name per-owner so a slug collision
    // across users can't overwrite another user's live app. Vercel project names
    // are GLOBAL within a team; the prior `clickdz-app-${slug}` let a user pass
    // another user's slug and deploy over their project. The 8-char owner prefix
    // is unique per user and stays within the 52-char Vercel cap. Falls back to
    // the legacy `clickdz-app-${slug}` name for apps deployed before this change.
    const ownerPrefix = ownerId ? ownerId.slice(0, 8) : 'shared';
    const projectName = `cdz-${ownerPrefix}-${slug}`.slice(0, 52);
    const teamQuery = VERCEL_TEAM_ID
      ? `?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`
      : '';

    // ----- create the deployment (Vercel auto-creates the project by name) ----
    let createRes: globalThis.Response;
    try {
      createRes = await fetch(
        `https://api.vercel.com/v13/deployments${teamQuery}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${VERCEL_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: projectName,
            files: [{ file: 'index.html', data: html }],
            projectSettings: { framework: null },
            target: 'production',
          }),
          signal: AbortSignal.timeout(30000),
        }
      );
    } catch (e) {
      // Network error / timeout reaching Vercel — typed 502, never an uncaught
      // 500. NEVER logs the token.
      this.logger.warn(`[apps] Vercel create unreachable slug=${slug}: ${String(e)}`);
      res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'vercel_deploy_failed',
        message: 'Could not reach the deployment provider. Please try again.',
      });
      return { ok: false };
    }
    // Parse the body defensively (a non-JSON error page must not throw).
    const created = (await createRes.json().catch(() => null)) as any;
    if (!createRes.ok) {
      const detail =
        (created?.error?.message as string | undefined) ||
        (typeof created === 'string' ? created : '') ||
        '';
      this.logger.warn(
        `[apps] Vercel create failed slug=${slug} status=${createRes.status} detail=${detail.slice(0, 200)}`
      );
      this.writeVercelUpstreamError(res, createRes.status, detail);
      return { ok: false };
    }
    if (!created || typeof created.id !== 'string') {
      // 2xx but a body we can't act on — treat as a provider failure, not a lie.
      this.logger.warn(`[apps] Vercel create returned no deployment id slug=${slug}`);
      res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'vercel_deploy_failed',
        message: 'The deployment provider returned an unexpected response.',
      });
      return { ok: false };
    }

    // ----- poll until READY, with backoff + a hard deadline -------------------
    // Terminal-failure states never resolve to a live URL; we must not record
    // them as a successful publish.
    let state = (created.readyState as string) || 'QUEUED';
    const deadline = Date.now() + 40_000; // ~40s hard ceiling
    let delay = 1_000; // incremental backoff: 1s, 1.5s, 2.25s … capped at 5s
    while (
      state !== 'READY' &&
      state !== 'ERROR' &&
      state !== 'CANCELED' &&
      Date.now() < deadline
    ) {
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(Math.round(delay * 1.5), 5_000);
      try {
        const pollRes = await fetch(
          `https://api.vercel.com/v13/deployments/${created.id}${teamQuery}`,
          {
            headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
            signal: AbortSignal.timeout(15000),
          }
        );
        if (!pollRes.ok) {
          // A transient poll error (e.g. 5xx) is tolerated — keep polling until
          // the deadline rather than failing a build that may still be going.
          // An auth/plan error here, however, is terminal.
          if (
            pollRes.status === 401 ||
            pollRes.status === 402 ||
            pollRes.status === 403
          ) {
            const detail = await pollRes.text().catch(() => '');
            this.logger.warn(
              `[apps] Vercel poll auth/plan error slug=${slug} status=${pollRes.status}`
            );
            this.writeVercelUpstreamError(res, pollRes.status, detail);
            return { ok: false };
          }
          continue;
        }
        const polled = (await pollRes.json().catch(() => null)) as any;
        if (polled && typeof polled.readyState === 'string') {
          state = polled.readyState;
        }
      } catch (e) {
        // Poll network throw: tolerate and retry until the deadline. This is the
        // GAP that previously escaped as an uncaught 500.
        this.logger.warn(`[apps] Vercel poll hiccup slug=${slug}: ${String(e)}`);
      }
    }

    // Terminal failure OR still-not-READY at the deadline -> typed 502. Do NOT
    // return a non-READY deploy as success (no silent partial success).
    if (state === 'ERROR' || state === 'CANCELED') {
      this.logger.warn(`[apps] Vercel build ${state} slug=${slug}`);
      res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'vercel_deploy_failed',
        message: `The deployment failed to build (${state}).`,
        state,
      });
      return { ok: false };
    }
    if (state !== 'READY') {
      this.logger.warn(
        `[apps] Vercel deploy not READY at deadline slug=${slug} state=${state}`
      );
      res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'vercel_deploy_timeout',
        message:
          'The deployment did not go live in time. It may still finish — check your published apps shortly.',
        state,
      });
      return { ok: false };
    }

    // ----- resolve the REAL live URL (fail-soft) ------------------------------
    // never GUESS the live URL — Vercel may truncate long project names when
    // assigning the <project>.vercel.app domain, so read the real one
    let liveUrl = created.url ? `https://${created.url}` : undefined;
    try {
      const domainsRes = await fetch(
        `https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}/domains${teamQuery}`,
        {
          headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
          signal: AbortSignal.timeout(15000),
        }
      );
      const domains = (await domainsRes.json().catch(() => null)) as any;
      const assigned =
        (domains?.domains || []).find(
          (d: any) => d.verified && String(d.name).endsWith('.vercel.app')
        ) ?? (domains?.domains || [])[0];
      if (assigned?.name) {
        liveUrl = `https://${assigned.name}`;
      }
    } catch {
      // keep the deployment-specific URL as a safe fallback
    }
    return {
      ok: true,
      deployed: {
        slug,
        state,
        url: liveUrl ?? `https://${projectName}.vercel.app`,
        deploymentUrl: created.url ? `https://${created.url}` : undefined,
      },
    };
  }

  /**
   * SECURITY / validation: parse + bound the optional `history` and `selection`
   * fields from an /apps/generate body. Rejects malformed shapes with 400 and
   * oversized inputs with 413 (consistent with this route's existing caps),
   * then returns normalized values the prompt builder can consume directly.
   * Absent fields are fine: returns { history: undefined, selection: undefined }.
   */
  private parseAppEditContext(body: any): {
    history: AppHistoryTurn[] | undefined;
    selection: AppSelectionContext | null | undefined;
  } {
    // ----- history -----
    let history: AppHistoryTurn[] | undefined;
    if (body?.history != null) {
      if (!Array.isArray(body.history)) {
        throw new BadRequestException('"history" must be an array of turns');
      }
      if (body.history.length > MAX_HISTORY_TURNS) {
        throw new PayloadTooLargeException(
          `Too many history turns (max ${MAX_HISTORY_TURNS})`
        );
      }
      let total = 0;
      const turns: AppHistoryTurn[] = [];
      for (const turn of body.history) {
        if (!turn || typeof turn !== 'object') {
          throw new BadRequestException('Each history turn must be an object');
        }
        const role = (turn as any).role;
        const text = (turn as any).text;
        if (role !== 'user' && role !== 'assistant') {
          throw new BadRequestException(
            'Each history turn role must be "user" or "assistant"'
          );
        }
        if (typeof text !== 'string') {
          throw new BadRequestException('Each history turn text must be a string');
        }
        if (text.length > MAX_HISTORY_TURN_CHARS) {
          throw new PayloadTooLargeException(
            `A history turn is too long (max ${MAX_HISTORY_TURN_CHARS} characters)`
          );
        }
        total += text.length;
        turns.push({ role, text });
      }
      if (total > MAX_HISTORY_TOTAL_CHARS) {
        throw new PayloadTooLargeException(
          `History is too long (max ${MAX_HISTORY_TOTAL_CHARS} characters total)`
        );
      }
      history = turns.length ? turns : undefined;
    }

    // ----- selection -----
    let selection: AppSelectionContext | null | undefined;
    if (body?.selection != null) {
      const sel = body.selection;
      if (typeof sel !== 'object' || Array.isArray(sel)) {
        throw new BadRequestException('"selection" must be an object or null');
      }
      const tag = (sel as any).tag;
      const text = (sel as any).text;
      const descriptor = (sel as any).descriptor;
      if (typeof tag !== 'string') {
        throw new BadRequestException('"selection.tag" must be a string');
      }
      if (typeof text !== 'string') {
        throw new BadRequestException('"selection.text" must be a string');
      }
      if (text.length > MAX_SELECTION_TEXT_CHARS) {
        throw new PayloadTooLargeException(
          `selection.text is too long (max ${MAX_SELECTION_TEXT_CHARS} characters)`
        );
      }
      if (descriptor != null && typeof descriptor !== 'string') {
        throw new BadRequestException('"selection.descriptor" must be a string');
      }
      if (
        typeof descriptor === 'string' &&
        descriptor.length > MAX_SELECTION_DESCRIPTOR_CHARS
      ) {
        throw new PayloadTooLargeException(
          `selection.descriptor is too long (max ${MAX_SELECTION_DESCRIPTOR_CHARS} characters)`
        );
      }
      selection = {
        tag,
        text,
        ...(typeof descriptor === 'string' ? { descriptor } : {}),
      };
    }

    return { history, selection };
  }

  /** run the code agent to produce a complete single-file app (new or edited) */
  private async buildAppHtml(
    prompt: string,
    currentHtml?: string,
    history?: AppHistoryTurn[],
    selection?: AppSelectionContext | null
  ): Promise<string> {
    // Content construction (system prompt + edit-in-context transcript) now
    // lives in ./clickdz-app-prompt. The edit branch fires only when there is a
    // real working document; the builder slices currentHtml internally
    // (MAX_EDIT_HTML_CHARS), so we do NOT slice it again here.
    const isEdit = !!currentHtml && currentHtml.length > 20;
    const content = isEdit
      ? buildEditContent({
          prompt,
          currentHtml: currentHtml as string,
          history,
          selection,
        })
      : buildNewAppContent(prompt);
    const reply = await this.runMakeAgent(
      [{ role: 'user', content }],
      'clickdz-apps',
      MAKE_CODE_AGENT_ID || undefined
    );
    let html = extractHtmlApp(reply || '');
    if (!html) {
      throw new HttpException(
        { error: { message: 'The model did not return a valid app. Try rephrasing.', type: 'provider_error', code: 'app_generation_failed' } },
        HttpStatus.BAD_GATEWAY
      );
    }
    if (html.length > 400_000) html = html.slice(0, 400_000);
    return html;
  }

  /**
   * STREAM-GEN — POST /api/v1/apps/generate/stream.
   *
   * The same generation as `/apps/generate`, but the merchant watches it happen
   * instead of staring at a spinner for one to four minutes with no signal that
   * anything is working. That wait is the single worst moment in the builder,
   * and it is entirely a feedback problem: the code arrives steadily, we just
   * never showed it.
   *
   * Typed SSE events rather than an OpenAI-shaped chunk stream, because the
   * client's job here is not "append tokens to a chat bubble" but "paint a live
   * preview and then hand a finished app to the studio":
   *
   *   phase  {phase,label}                 a human step, for the status line
   *   delta  {text}                        raw model output as it arrives
   *   done   {slug,html,bytes,seconds}     the finished, token-substituted app
   *   error  {message}                     a typed, secret-free failure
   *
   * TWO PATHS, one client contract. When CDZ_AI_KEY is configured we stream the
   * `cdz-architect` completion token-by-token, so `delta` carries real
   * incremental HTML and the client can paint a progressive preview. Otherwise
   * the Make code agent is the only backend available and it returns ONE buffered
   * JSON body — no token stream exists to forward — so we emit honest `phase`
   * heartbeats while it works and a single `done` at the end. The client cannot
   * tell the difference structurally, and we never fake per-token progress we do
   * not have.
   *
   * Deliberately NOT reusing `streamCdzChat`: that helper speaks the
   * OpenAI-compatible chunk envelope for `/v1/chat/completions` passthrough. Its
   * incremental SSE frame parser is the part worth copying, and it is copied
   * faithfully here (same blank-line framing, same `[DONE]` handling, same
   * partial-frame tolerance) — but wrapped in this route's own event vocabulary.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/generate/stream')
  async generateAppStream(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Res() res: Response
  ) {
    const startedAt = Date.now();
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      throw new BadRequest('A description of the app is required');
    }
    // Same input caps as the buffered route — this runs the same paid agent.
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new PayloadTooLargeException(
        `Prompt is too long (max ${MAX_PROMPT_CHARS} characters)`
      );
    }
    if (
      typeof body?.currentHtml === 'string' &&
      body.currentHtml.length > MAX_HTML_CHARS
    ) {
      throw new PayloadTooLargeException(
        `currentHtml is too large (max ${MAX_HTML_CHARS} characters)`
      );
    }
    const currentHtml =
      typeof body?.currentHtml === 'string' ? body.currentHtml : undefined;
    const { history, selection } = this.parseAppEditContext(body);
    // Identical template resolution to the buffered route: gate-honouring,
    // new-builds-only, null for unknown ids.
    const appTemplate =
      !currentHtml &&
      typeof body?.templateId === 'string' &&
      body.templateId.length <= 64
        ? getAppTemplateDef(body.templateId)
        : null;
    const briefedPrompt = appTemplate
      ? `${appTemplate.brief}\n\nDemande du commerçant : ${prompt}`
      : prompt;
    const slug =
      typeof body?.slug === 'string' && /^[a-z0-9-]{3,50}$/.test(body.slug)
        ? body.slug
        : slugifyAppName(prompt);
    const isEdit = !!currentHtml && currentHtml.length > 20;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Defeat proxy buffering — without this nginx can hold the whole stream and
    // deliver it at the end, which is exactly the spinner we are removing.
    res.setHeader('X-Accel-Buffering', 'no');
    const emit = (event: string, data: unknown) => {
      // WS17: guard against writing to a response the client already closed
      // (tab close / navigate away). Without this, the Path-B heartbeat
      // interval keeps calling res.write() on a finished/closed stream and
      // throws an uncaught exception. res.writableEnded is set after res.end();
      // res.destroyed is set when the socket is gone.
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Abort upstream when the merchant closes the tab or navigates away, so a
    // cancelled Path-A build stops costing model time.
    //
    // `res.on('close')`, NOT `req.on('close')` — this is the same house pattern
    // used by the chat-completions passthrough above, and the distinction is
    // load-bearing: since Node 16, `IncomingMessage` emits 'close' when the
    // REQUEST MESSAGE completes (i.e. once the body parser has drained the POST
    // body), which here happens in middleware BEFORE this handler even runs. A
    // listener attached to `req` would therefore never fire at all — not on
    // completion (already emitted) and not on disconnect (only `res` emits
    // then). The ServerResponse's 'close' is what actually tracks the socket.
    //
    // Path B cannot be cancelled: `runMakeAgent` takes no external signal, only
    // its own timeout. A disconnect there lets the Make run finish and be
    // discarded; the heartbeat below is cleared either way.
    const upstream = new AbortController();
    // WS17: hoist the Path-B heartbeat handle so the close handler can clear it
    // too — otherwise a client disconnect leaves the 4s interval running, calling
    // emit() on a closed response (the guard above stops the throw, but the
    // interval itself must be cleared to stop the leak).
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    res.on('close', () => {
      upstream.abort();
      if (heartbeat) clearInterval(heartbeat);
    });

    /** Substitute the per-slug Data API URL + token, then emit `done`. */
    const finish = (raw: string) => {
      let html = extractHtmlApp(raw);
      if (!html) {
        emit('error', {
          message:
            'The model did not return a valid app. Try rephrasing your request.',
        });
        res.end();
        return;
      }
      if (html.length > 400_000) html = html.slice(0, 400_000);
      const externalBase = (
        process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
      ).replace(/\/+$/, '');
      html = html
        .replaceAll(
          '__CLICKDZ_DATA_URL__',
          `${externalBase}/api/v2/apps-data/${slug}`
        )
        .replaceAll('__CLICKDZ_DATA_TOKEN__', publicDataToken(slug));
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      this.logger.log(
        `[apps] stream-generated ${html.length} chars in ${seconds}s slug=${slug} user=${user.id}`
      );
      emit('done', { slug, html, bytes: html.length, seconds });
      res.end();
    };

    const content = isEdit
      ? buildEditContent({
          prompt: briefedPrompt,
          currentHtml: currentHtml as string,
          history,
          selection,
        })
      : buildNewAppContent(briefedPrompt);

    emit('phase', { phase: 'analyse', label: 'Analyse de votre demande…' });

    // ---- Path A: real token streaming via the CDZ_AI direct path. ----------
    if (CDZ_AI_KEY) {
      let upstreamRes: Awaited<ReturnType<typeof fetch>> | null = null;
      try {
        upstreamRes = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CDZ_AI_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model: CDZ_CHAT_MODEL,
            messages: [{ role: 'user', content }],
            stream: true,
            max_tokens: 16000,
          }),
          signal: upstream.signal,
        });
      } catch {
        upstreamRes = null; // never opened — fall through to Make
      }
      if (upstreamRes?.ok && upstreamRes.body) {
        emit('phase', { phase: 'code', label: 'Écriture du code…' });
        const decoder = new TextDecoder();
        let buffer = '';
        let raw = '';
        try {
          for await (const bytes of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
            buffer += decoder.decode(bytes, { stream: true });
            // SSE frames are separated by a blank line; a frame may arrive
            // split across chunks, so only complete ones are consumed.
            let sep: number;
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              for (const line of frame.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                try {
                  const text = JSON.parse(payload)?.choices?.[0]?.delta
                    ?.content;
                  if (typeof text === 'string' && text) {
                    raw += text;
                    emit('delta', { text });
                  }
                } catch {
                  /* partial/unknown frame — skip it, never break the stream */
                }
              }
            }
          }
        } catch {
          // Mid-stream failure. We have already sent bytes, so falling back to
          // Make would double-charge and confuse the client; if anything usable
          // arrived, finish with it, else report.
          if (!raw) {
            emit('error', { message: 'The connection was interrupted.' });
            res.end();
            return;
          }
        }
        finish(raw);
        return;
      }
      // Non-2xx / no body before any bytes were sent: drain and fall through.
      try {
        await upstreamRes?.body?.cancel();
      } catch {
        /* ignore */
      }
    }

    // ---- Path B: the Make code agent. ONE buffered body, so no token stream
    // exists to forward. Emit honest elapsed-time heartbeats instead of
    // fabricating per-token progress, and keep the same `done` contract. ------
    heartbeat = setInterval(() => {
      emit('phase', {
        phase: 'code',
        label: 'Génération en cours…',
        seconds: Math.round((Date.now() - startedAt) / 1000),
      });
    }, 4000);
    try {
      const reply = await this.runMakeAgent(
        [{ role: 'user', content }],
        'clickdz-apps',
        MAKE_CODE_AGENT_ID || undefined
      );
      clearInterval(heartbeat);
      finish(reply || '');
    } catch (err) {
      clearInterval(heartbeat);
      emit('error', {
        message:
          err instanceof Error && err.message
            ? err.message
            : 'Generation failed. Please try again.',
      });
      res.end();
    }
  }

  /** GENERATE ONLY — returns full HTML for instant preview; does NOT deploy */
  @Throttle('strict')
  @Post('/api/v1/apps/generate')
  async generateApp(@CurrentUser() user: CurrentUser, @Body() body: any) {
    // WS4: the global AuthGuard already authenticated this first-party route;
    // we receive the user for observability/parity with deploy. Generate never
    // publishes, so the per-owner publish cap is NOT enforced here (it is at
    // deploy time, which template deploys also flow through).
    const startedAt = Date.now();
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      throw new HttpException(
        { error: { message: 'A description of the app is required', type: 'invalid_request_error', code: 'prompt_missing' } },
        HttpStatus.BAD_REQUEST
      );
    }
    // SECURITY: this route runs the (paid) code agent. Cap input sizes.
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new PayloadTooLargeException(
        `Prompt is too long (max ${MAX_PROMPT_CHARS} characters)`
      );
    }
    if (
      typeof body?.currentHtml === 'string' &&
      body.currentHtml.length > MAX_HTML_CHARS
    ) {
      throw new PayloadTooLargeException(
        `currentHtml is too large (max ${MAX_HTML_CHARS} characters)`
      );
    }
    const currentHtml =
      typeof body?.currentHtml === 'string' ? body.currentHtml : undefined;
    // Validate + bound the optional edit-in-context fields (rejects malformed
    // shapes 400 / oversized inputs 413 per the canonical request bounds).
    const { history, selection } = this.parseAppEditContext(body);
    // APP-CAT: optional `templateId` — a gallery pick resolves a server-side
    // generation brief that is PREPENDED to the user's prompt. The brief is
    // trusted catalog data, so it is deliberately NOT counted against the
    // MAX_PROMPT_CHARS cap already enforced on `prompt` above. Applies to NEW
    // builds only (an edit already carries its context via currentHtml).
    // getAppTemplateDef honors the CDZ_APP_TEMPLATE_CATALOG gate and returns
    // null for gate-off/unknown ids, so a stale or bad templateId degrades to
    // a plain generate rather than a 500 (mirrors resolveTemplateDef).
    const appTemplate =
      !currentHtml &&
      typeof body?.templateId === 'string' &&
      body.templateId.length <= 64
        ? getAppTemplateDef(body.templateId)
        : null;
    const briefedPrompt = appTemplate
      ? `${appTemplate.brief}\n\nDemande du commerçant : ${prompt}`
      : prompt;
    const slug =
      typeof body?.slug === 'string' && /^[a-z0-9-]{3,50}$/.test(body.slug)
        ? body.slug
        : slugifyAppName(prompt);
    this.logger.log(
      `[apps] generate (${currentHtml ? 'edit' : 'new'}) user=${user.id} slug=${slug} prompt=${prompt.slice(0, 80)}`
    );
    let html = await this.buildAppHtml(
      briefedPrompt,
      currentHtml,
      history,
      selection
    );
    // wire the app to its own Data API namespace so preview + live share state
    const externalBase = (
      process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
    ).replace(/\/+$/, '');
    // Point new apps at the token-gated /v2 Data API and inject the per-slug
    // write token (P0 safety). Existing deployed apps keep using /v1.
    html = html
      .replaceAll(
        '__CLICKDZ_DATA_URL__',
        `${externalBase}/api/v2/apps-data/${slug}`
      )
      .replaceAll('__CLICKDZ_DATA_TOKEN__', publicDataToken(slug));
    this.logger.log(
      `[apps] generated ${html.length} chars in ${Math.round((Date.now() - startedAt) / 1000)}s`
    );
    // "What changed" label for the version list. Only meaningful for edits (an
    // existing working doc); best-effort and never blocks/breaks the response.
    // Additive field — existing consumers ignore it, the app-builder reads it.
    const isEdit = !!currentHtml && currentHtml.length > 20;
    const summary = isEdit
      ? await this.summarizeEdit(prompt, currentHtml as string, html)
      : undefined;
    return {
      slug,
      prompt,
      html,
      bytes: html.length,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      ...(summary ? { summary } : {}),
    };
  }

  /** DEPLOY — takes reviewed HTML + slug, publishes to Vercel, returns URL */
  @Throttle('strict')
  @Post('/api/v1/apps/deploy')
  async deployApp(
    // WS4: global AuthGuard already authenticated this first-party route; we
    // receive the user to key the per-owner publish cap. @Res passthrough lets
    // us emit the EXACT contract 409/402 bodies (a typed error can only produce
    // its own envelope) while the success path still returns normally.
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    // C2 (VERCEL HARDENING): publishing not configured -> typed 503 via
    // passthrough (a raw HttpException here is flattened to a generic 500 by the
    // global filter, dropping the contract body). The deploy helper preflights
    // the token again as belt-and-braces.
    if (!VERCEL_TOKEN) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: 'publishing_not_configured',
        message: 'Publishing is not configured on this deployment.',
      });
      return;
    }
    // SECURITY: reject wrong-typed html before coercion (a non-string that
    // stringifies to garbage should not reach the deploy pipeline).
    if (body?.html != null && typeof body.html !== 'string') {
      throw new BadRequestException('"html" must be a string');
    }
    let html = String(body?.html || '');
    if (html.length < 20) {
      throw new HttpException(
        { error: { message: 'No app HTML to deploy', type: 'invalid_request_error', code: 'html_missing' } },
        HttpStatus.BAD_REQUEST
      );
    }
    // SECURITY: reject clearly-abusive oversize payloads (413) on this
    // Vercel-deploying route. The existing 400_000 truncation below still
    // trims normal-but-large apps (non-breaking).
    if (html.length > MAX_HTML_CHARS) {
      throw new PayloadTooLargeException(
        `App HTML is too large (max ${MAX_HTML_CHARS} characters)`
      );
    }
    if (html.length > 400_000) html = html.slice(0, 400_000);
    const slug =
      typeof body?.slug === 'string' && /^[a-z0-9-]{3,50}$/.test(body.slug)
        ? body.slug
        : slugifyAppName('app');
    // WS4 premium gate (env-gated OFF by default). On a 402 the response has
    // already been written via passthrough — stop here.
    if (!(await this.assertCanPublish(user, res))) return;
    // WS4 publish cap. An optional body.replaceSlug (validated) is unpublished
    // first to free a slot. A NEW slug over the cap writes the 409 body here.
    const replaceSlug =
      typeof body?.replaceSlug === 'string' && APP_SLUG_RE.test(body.replaceSlug)
        ? body.replaceSlug
        : undefined;
    // C5: optional pairing metadata. A ShopERP deploy passes kind ('shop'|'erp')
    // and the shared storeSlug so GET /apps/mine can label + pair them. Both are
    // validated/normalized and simply omitted when absent (legacy/plain apps).
    // C2 (QUOTAS): parsed BEFORE the cap check so the per-kind guard can see the
    // kind + the shop/erp pairing (a shop's paired ERP shares the storeSlug).
    const kindRaw = String(body?.kind || '').trim().toLowerCase();
    const kind: 'shop' | 'erp' | undefined =
      kindRaw === 'shop' || kindRaw === 'erp' ? kindRaw : undefined;
    const storeSlug =
      typeof body?.storeSlug === 'string' && APP_SLUG_RE.test(body.storeSlug)
        ? body.storeSlug
        : undefined;
    // C2 (QUOTAS): the total-app cap AND the per-kind caps (1 shop(+its erp),
    // 1 standalone erp) are all enforced here off the existing Redis SET. A
    // breach writes the exact typed 409 (message names the limit) and returns
    // false — the response is already committed, so stop.
    if (
      !(await this.assertUnderPublishCap(
        user.id,
        slug,
        replaceSlug,
        kind,
        storeSlug,
        res
      ))
    ) {
      return;
    }
    if (!html.includes('Built with ClickDz') && html.includes('</body>')) {
      html = html.replace('</body>', `${CLICKDZ_APP_WATERMARK}</body>`);
    }
    this.logger.log(
      `[apps] deploying ${html.length} chars as slug=${slug} user=${user.id}`
    );
    // C2 (VERCEL HARDENING): the helper owns `res` on failure (typed 503/502/
    // 402/429 already written) — stop WITHOUT recording, so there is no silent
    // partial success. Only a READY deploy reaches recordPublishedApp.
    const result = await this.deployAppToVercel(slug, html, res, user.id);
    if (!result.ok) return;
    const deployed = result.deployed;
    this.logger.log(`[apps] deployed: ${deployed.url} (${deployed.state})`);
    // WS4: record the successful publish under the caller's set (idempotent per
    // slug) so it counts toward the cap and appears in GET /apps/mine.
    await this.recordPublishedApp(user.id, slug, deployed.url, {
      kind,
      storeSlug,
    });
    // R2-h (WSB-3): persist the just-deployed shop HTML as a ShopState version
    // and update the state blob so the studio has a server-side source of truth
    // (kills the no-source-across-devices failure). SHOP kind only; gated by
    // CDZ_SHOP_STATE. Fail-soft (own try/catch): a Redis hiccup here must NEVER
    // break a successful deploy. A shop's own slug doubles as its storeSlug.
    if (CDZ_SHOP_STATE && kind === 'shop') {
      try {
        const stateSlug =
          storeSlug && APP_SLUG_RE.test(storeSlug) ? storeSlug : slug;
        await recordVersion(this.redis, user.id, stateSlug, html, 'deploy');
        await writeShopState(this.redis, user.id, stateSlug, {
          aiPatchHtml: html,
        });
      } catch {
        /* ShopState is best-effort; the deploy already succeeded */
      }
    }
    return { ...deployed, bytes: html.length };
  }

  /**
   * WS3 — TEMPLATE ENDPOINT. Loads a canned single-file HTML app (shop/erp),
   * substitutes the SAME placeholder tokens the generate path injects, and
   * returns the SAME response shape as generateApp (slug/html/data wiring).
   * Does NOT deploy — the client stages it, then publishing flows through
   * /apps/deploy (so template deploys count toward the publish cap too).
   *
   * storeSlug given → reuse that slug + its data token (pairing a shop with its
   * ERP so they share one datastore); else mint a fresh slug (reusing the same
   * minting code the generate path uses).
   *
   * C5: an optional `settings` object customizes the template at CREATION time
   * (store name / WhatsApp / accent / admin PIN). Invalid settings → 400
   * `{error:'invalid_settings', field}` via passthrough res (a typed error can't
   * carry the `field`). Omitted fields keep the template defaults, so a request
   * with no `settings` produces byte-identical output to the pre-C5 path.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/template')
  async templateApp(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    // Passthrough lets us hand-write the exact 400 invalid_settings body while
    // the success path still returns its object normally.
    @Res({ passthrough: true }) res: Response
  ) {
    const startedAt = Date.now();
    const kind = String(body?.kind || '').trim().toLowerCase();
    if (kind !== 'shop' && kind !== 'erp') {
      throw new BadRequest('"kind" must be "shop" or "erp"');
    }
    // C5: validate the optional settings BEFORE minting anything. The accent
    // default is per-kind (shop teal vs ERP blue) so an omitted accentColor
    // keeps each template byte-identical.
    const parsed = parseTemplateSettings(
      body?.settings,
      kind === 'shop' ? CDZ_TPL_DEFAULT_ACCENT : CDZ_TPL_DEFAULT_ERP_ACCENT
    );
    if (!parsed.ok) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'invalid_settings', field: parsed.field });
      return;
    }
    const tokens = parsed.tokens;
    // storeSlug: reuse for pairing (shop + its ERP share one datastore). Mint a
    // new slug otherwise — SAME code path as generate/deploy.
    const slug =
      typeof body?.storeSlug === 'string' && APP_SLUG_RE.test(body.storeSlug)
        ? body.storeSlug
        : slugifyAppName(kind === 'shop' ? 'shop' : 'erp');
    // Load the sibling-authored template HTML.
    let html = kind === 'shop' ? CLICKDZ_SHOP_TEMPLATE_HTML : CLICKDZ_ERP_TEMPLATE_HTML;
    // Compute the SAME real values the generate path injects.
    const externalBase = (
      process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
    ).replace(/\/+$/, '');
    const dataUrl = `${externalBase}/api/v2/apps-data/${slug}`;
    // SEC-3: embedded in served HTML → the PUBLIC scoped profile (no `clear`,
    // finite expiry), never the full-scope internal mint.
    const dataToken = publicDataToken(slug);
    // Map the contract's placeholder tokens → real minted values. The generate
    // path substitutes __CLICKDZ_DATA_URL__/__CLICKDZ_DATA_TOKEN__ with these
    // exact values; templates additionally carry __CLICKDZ_SLUG__ (mapped to the
    // bare slug). Using split/join keeps the mapping explicit and robust even if
    // a token appears many times.
    // C5: the four customization tokens are mapped in the SAME chain. Their
    // values are either the validated settings or the per-kind defaults, so a
    // no-settings request substitutes the exact strings that used to be
    // hardcoded → byte-identical output. None of the substituted values contain
    // another __CLICKDZ_*__ sequence, so replacement order is irrelevant.
    // R1-d (GATE/WS4-4): optional `templateId` selects a catalog vertical when
    // CDZ_TEMPLATE_CATALOG is ON (shop only). def=null (no id / gate off / erp)
    // ⇒ the resolver substitutes today's exact defaults ⇒ byte-identical mint.
    const templateDef =
      kind === 'shop' ? resolveTemplateDef(body?.templateId) : null;
    const mintOpts: TemplateMintOpts = {
      dataUrl,
      dataToken,
      slug,
      storeName: tokens.storeName,
      whatsapp: tokens.whatsapp,
      accent: tokens.accent,
      pin: tokens.pin,
    };
    html = resolveTemplateTokens(html, templateDef, mintOpts);
    if (html.length > 400_000) html = html.slice(0, 400_000);
    this.logger.log(
      `[apps] template kind=${kind} user=${user.id} slug=${slug} bytes=${html.length}`
    );
    // SAME response shape as generateApp (slug/prompt/html/bytes/seconds), plus
    // storeSlug so the client can pair the follow-up ERP to this shop.
    return {
      slug,
      storeSlug: slug,
      kind,
      prompt: `ClickDz ${kind === 'shop' ? 'Ready Shop' : 'Manage (ERP)'} template`,
      html,
      bytes: html.length,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    };
  }

  /**
   * WS4 — GET /api/v1/apps/mine. The caller's published apps (auth'd).
   * Prunes any malformed records lazily via readPublishedApps.
   *
   * C5: each item now carries `kind` ('shop'|'erp'|'app') and `storeSlug` when
   * the publish record has them. Records written before this change (and plain
   * generated apps) omit both — the ShopERP page treats a missing `kind` as a
   * generic "App" and a missing `storeSlug` as unpaired (null-safe).
   */
  @Throttle('strict')
  @Get('/api/v1/apps/mine')
  async listMyApps(
    @CurrentUser() user: CurrentUser
  ): Promise<{ apps: PublishedAppRecord[] }> {
    const records = await this.readPublishedApps(user.id);
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      apps: records.map(r => ({
        slug: r.slug,
        url: r.url,
        createdAt: r.createdAt,
        // Only present when known — legacy rows leave these undefined so the
        // JSON simply omits them (client reads them as optional).
        ...(r.kind ? { kind: r.kind } : {}),
        ...(r.storeSlug ? { storeSlug: r.storeSlug } : {}),
      })),
    };
  }

  /**
   * R1-d (WS4-4) — GET /api/v1/apps/templates. The 20-vertical catalog metadata
   * (id/name/darja/vertical/accent/hero/emoji/gradient) for the wizard gallery.
   * Seed products are intentionally excluded (keep the payload small). Gated by
   * CDZ_TEMPLATE_CATALOG: OFF ⇒ typed 404 (picker hidden), never an empty 200
   * that would render a blank gallery. auth'd via the global AuthGuard.
   */
  // WS17: 'default' throttle — read-only catalog listing fetched on wizard
  // open; 'strict' (20/min) would hide the gallery on a few rapid reopens.
  @Throttle('default')
  @Get('/api/v1/apps/templates')
  async listTemplates(@CurrentUser() _user: CurrentUser) {
    if (!templateCatalogEnabled()) {
      throw new NotFound('Template catalog not enabled');
    }
    return { templates: listTemplateCatalog() };
  }

  /**
   * APP-CAT — GET /api/v1/apps/app-templates. The APP catalog's display
   * metadata (id/name/darja/emoji/category/pitch/accent/gradient) for the
   * builder gallery. Generation briefs are deliberately EXCLUDED — they are
   * server-side only, reached via `templateId` on POST /apps/generate. Gated by
   * CDZ_APP_TEMPLATE_CATALOG: OFF ⇒ typed 404 so the gallery hides itself,
   * never an empty 200 that would render a blank shelf. Mirrors the shop
   * catalog route above, gate and typed-404 included.
   */
  // WS17: 'default' throttle (not 'strict' = 20/min) — this is a lightweight
  // read-only metadata listing the FE fetches on every /apps page load. A
  // merchant reopening the gallery a few times would otherwise hit strict and
  // see the gallery disappear (FE treats non-200 as 'hide gallery').
  @Throttle('default')
  @Get('/api/v1/apps/app-templates')
  async listAppTemplates(@CurrentUser() _user: CurrentUser) {
    if (!appTemplateCatalogEnabled()) {
      throw new NotFound('App template catalog not enabled');
    }
    return { templates: listAppTemplateCatalog() };
  }

  /**
   * WS4 — DELETE /api/v1/apps/:slug (auth'd). Unpublish one of the CALLER's own
   * apps: only if the slug is in the caller's Redis set → delete the Vercel
   * project (fail-soft on 404) + srem → { ok: true }. A slug the caller does not
   * own is a 404 (never let a user delete another owner's project).
   */
  @Throttle('strict')
  @Delete('/api/v1/apps/:slug')
  async deleteApp(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string
  ): Promise<{ ok: true }> {
    if (typeof slug !== 'string' || !APP_SLUG_RE.test(slug)) {
      throw new BadRequest('Invalid app slug');
    }
    const records = await this.readPublishedApps(user.id);
    if (!records.some(r => r.slug === slug)) {
      throw new NotFound('App not found');
    }
    // Vercel project deletion mirrors deployAppToVercel's conventions (v9 DELETE,
    // same teamQuery/Bearer), fail-soft on 404 — then always srem.
    await this.deleteAppFromVercel(slug, user.id);
    await this.sremPublishedApp(user.id, slug);
    this.logger.log(`[apps] unpublished slug=${slug} user=${user.id}`);
    return { ok: true };
  }

  /**
   * R0-b (WSB-2) — GET /api/v1/apps/:slug/source (auth'd, owner-only). Recovers
   * a published app's HTML SERVER-SIDE so editing works cross-device (today the
   * only source is the browser's client `artifactStore`, so a 2nd device gets
   * `no-source`). Two sources, chosen by `resolveAppSource`:
   *   - RENDER (fast path): a template kind (kind 'shop'|'erp', or a record with
   *     a `storeSlug`) is re-rendered from the sibling template via the SAME
   *     `__CLICKDZ_*__` substitution `templateApp` performs → source:'render'.
   *   - DEPLOYED (fallback): a plain generated app has its live HTML fetched from
   *     its Vercel URL (SSRF-guarded/timed/size-capped) → source:'deployed'.
   * Env-gated by CDZ_SHOP_AI_EDIT (OFF → 404, byte-identical current behaviour).
   * Ownership reuses the /apps/mine mechanism (readPublishedApps; slug OR paired
   * storeSlug match). Passthrough res carries the exact typed error bodies (a raw
   * HttpException is flattened to a generic 500 by the global filter).
   */
  @Throttle('strict')
  @Get('/api/v1/apps/:slug/source')
  async appSource(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response
  ) {
    // Feature flag OFF → behave as if the route does not exist (typed 404).
    if (!CDZ_SHOP_AI_EDIT) {
      throw new NotFound('App not found');
    }
    if (typeof slug !== 'string' || !APP_SLUG_RE.test(slug)) {
      throw new BadRequest('Invalid app slug');
    }
    // Ownership: the caller must own this slug (or its paired storeSlug). Same
    // mechanism as assertOwnsErpApp / GET /apps/mine.
    const records = await this.readPublishedApps(user.id);
    const record =
      records.find(r => r.slug === slug) ??
      records.find(r => r.storeSlug === slug);
    if (!record) {
      throw new NotFound('App not found');
    }

    // RENDER closure: reconstruct a template-kind app's HTML with the SAME token
    // values templateApp injects. The appearance/customization tokens are the
    // template DEFAULTS here (the storefront reads its saved appearance at
    // runtime, so the base render is a faithful editable skeleton); the deployed
    // fetch is the higher-fidelity path when a re-render can't reproduce the art.
    const externalBase = (
      process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
    ).replace(/\/+$/, '');
    const renderTemplate = (rec: AppSourceRecord): string => {
      const templateHtml =
        rec.kind === 'erp'
          ? CLICKDZ_ERP_TEMPLATE_HTML
          : rec.kind === 'shop'
            ? CLICKDZ_SHOP_TEMPLATE_HTML
            : '';
      if (!templateHtml) return '';
      // A shop's own slug doubles as its storeSlug (templateApp returns
      // storeSlug === slug); prefer the paired storeSlug when present so the
      // data namespace matches the deployed one.
      const dataSlug = rec.storeSlug || rec.slug;
      const dataUrl = `${externalBase}/api/v2/apps-data/${dataSlug}`;
      const dataToken = publicDataToken(dataSlug);
      return renderTemplateSource({
        templateHtml,
        slug: dataSlug,
        dataUrl,
        dataToken,
        tokens: {
          storeName: CDZ_TPL_DEFAULT_STORE_NAME,
          whatsapp: CDZ_TPL_DEFAULT_WHATSAPP,
          accent:
            rec.kind === 'erp'
              ? CDZ_TPL_DEFAULT_ERP_ACCENT
              : CDZ_TPL_DEFAULT_ACCENT,
          pin: CDZ_TPL_DEFAULT_PIN,
        },
      });
    };

    const resolved = await resolveAppSource(record, { renderTemplate });
    if (!resolved.ok) {
      // Map the helper's failure reason → the right typed status. A missing/
      // unreachable/oversized/non-HTML deployed artifact is an upstream fetch
      // problem (502 via passthrough, like deployApp's vercel_* errors); a
      // non-renderable template kind is a 404 (nothing to recover).
      if (resolved.reason === 'not_renderable') {
        throw new NotFound('App source is not available');
      }
      // Every other reason is a deployed-fetch problem (missing/unreachable/
      // non-2xx/non-HTML/oversized/empty) — a typed 502, like deployApp's
      // vercel_* upstream errors, carried via passthrough res.
      res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'source_fetch_failed',
        reason: resolved.reason,
        message: 'Could not recover the published source. Please try again.',
      });
      return;
    }
    this.logger.log(
      `[apps] source slug=${slug} user=${user.id} via=${resolved.source} bytes=${resolved.bytes}`
    );
    return { slug, html: resolved.html, source: resolved.source };
  }

  /**
   * WS1 — GET /api/v1/apps/:slug/draft (auth'd, owner-only). Returns the last
   * autosaved studio draft for this owner+slug, or 404 when there is none.
   *
   * This is the CROSS-DEVICE / post-eviction recovery path for UNPUBLISHED
   * edits: `/source` only ever recovers the last *deployed* HTML, so a merchant
   * who edits on device A and reopens on device B (or after localStorage
   * eviction) would otherwise lose in-progress work. The studio prefers this
   * draft over `/source` on open.
   *
   * Auth is owner-scoped purely by the Redis key (`appDraftKey(user.id, slug)`)
   * — a draft is only ever visible to the user that wrote it, so no
   * published-set membership check is needed (a draft can exist for a slug that
   * was never published). Same env flag as `/source` so the pair ships together;
   * OFF → typed 404, byte-identical to today.
   */
  @Throttle('strict')
  @Get('/api/v1/apps/:slug/draft')
  async getAppDraft(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string
  ) {
    if (!CDZ_SHOP_AI_EDIT) {
      throw new NotFound('App not found');
    }
    if (typeof slug !== 'string' || !APP_SLUG_RE.test(slug)) {
      throw new BadRequest('Invalid app slug');
    }
    // `this.redis` is a raw ioredis client (CacheRedis extends Redis), so `get`
    // returns the stored string (or null) — parse it defensively.
    const rawDraft = await this.redis
      .get(appDraftKey(user.id, slug))
      .catch(() => null);
    let draft: AppDraftRecord | null = null;
    if (rawDraft) {
      try {
        draft = JSON.parse(rawDraft) as AppDraftRecord;
      } catch {
        draft = null;
      }
    }
    if (!draft || typeof draft.html !== 'string' || !draft.html) {
      throw new NotFound('No draft found');
    }
    return {
      slug,
      html: draft.html,
      title: typeof draft.title === 'string' ? draft.title : '',
      updatedAt:
        typeof draft.updatedAt === 'string'
          ? draft.updatedAt
          : new Date().toISOString(),
    };
  }

  /**
   * WS1 — POST /api/v1/apps/:slug/draft (auth'd, owner-only). Upserts the
   * owner-scoped studio draft `{html,title}` under a rolling 90-day TTL. The
   * studio's debounced autosave calls this; the record is keyed exclusively by
   * the authenticated user + slug so drafts are private and never collide across
   * owners. Additive and idempotent — it never publishes and never touches the
   * published SET, so it cannot affect CREATE or DEPLOY. Mirrors the deploy
   * route's html validation (typed 400 for non-string / empty, 413 for oversize).
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/draft')
  async saveAppDraft(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any
  ) {
    if (!CDZ_SHOP_AI_EDIT) {
      throw new NotFound('App not found');
    }
    if (typeof slug !== 'string' || !APP_SLUG_RE.test(slug)) {
      throw new BadRequest('Invalid app slug');
    }
    if (body?.html != null && typeof body.html !== 'string') {
      throw new BadRequest('"html" must be a string');
    }
    const html = String(body?.html || '');
    if (html.length < 1) {
      throw new BadRequest('No app HTML to save');
    }
    if (html.length > MAX_HTML_CHARS) {
      throw new PayloadTooLargeException(
        `App HTML is too large (max ${MAX_HTML_CHARS} characters)`
      );
    }
    const title =
      typeof body?.title === 'string' ? body.title.slice(0, 200) : '';
    const record: AppDraftRecord = {
      html,
      title,
      updatedAt: new Date().toISOString(),
    };
    // Fail-soft: the studio also keeps a localStorage copy, so a store hiccup
    // must not surface as a save error. `this.redis` is a raw ioredis client
    // (CacheRedis extends Redis) — write the JSON blob with a rolling TTL via
    // `set ... EX <seconds>`, same seconds unit the published set's `expire`
    // uses. Swallow redis errors and report the write outcome.
    let ok = false;
    try {
      const result = await this.redis.set(
        appDraftKey(user.id, slug),
        JSON.stringify(record),
        'EX',
        APP_DRAFT_TTL_SECONDS
      );
      ok = result === 'OK';
    } catch {
      ok = false;
    }
    this.logger.log(
      `[apps] draft ${ok ? 'saved' : 'save-failed'} slug=${slug} user=${user.id} bytes=${html.length}`
    );
    return { slug, saved: ok, updatedAt: record.updatedAt };
  }

  // POST /api/voice/token (Deepgram short-lived browser grant) was removed
  // alongside the floating voice-guide orb, which was its only caller. It
  // minted a 60s Deepgram key straight to the browser so the orb could open a
  // client-side STT socket; with the orb gone that is an unused credential
  // hand-out. Voice Studio's transcription and TTS both proxy through the
  // server (`/api/voice/tts` below) and never needed this route.

  /**
   * GET /api/voice/capabilities — what the Voice Studio can offer right now.
   *
   * Purely a reflection of which provider keys are set on the deployment, so
   * the frontend can render each provider card enabled/disabled with the right
   * voice list WITHOUT probing a real generation. Auth'd like the rest of the
   * voice surface (session cookie). No key => that provider `available:false`;
   * the page then disables its card and shows a tooltip. Additive, read-only.
   *
   * C3 (VOICE): the per-provider shape is EXTENDED (additive — every prior key
   * is unchanged) with `models[]`, `supportsInstructions`, `formats[]`,
   * `defaultModel` and a `cloning:{ supported:false, reason }` block so the
   * Studio can render model pickers, an instructions/style textarea, a format
   * picker, and an honest "cloning needs another provider" note. The existing
   * `id/label/available/voices/defaultVoice/supportsSpeed` keys are preserved so
   * the current Generate tab keeps working unchanged.
   */
  @Throttle('strict')
  @Get('/api/voice/capabilities')
  voiceCapabilities() {
    // Neither OpenAI /v1/audio/speech nor Deepgram Aura-2 accepts a reference
    // sample to reproduce a specific person's voice — cloning is out of scope
    // for BOTH providers. Report it honestly so the UI shows "needs a cloning
    // provider" instead of faking a cloning affordance.
    const cloning = {
      supported: false,
      reason:
        'Voice cloning requires a dedicated cloning provider; OpenAI and Deepgram offer preset voices only.',
    } as const;
    return {
      transcription: {
        // STT is OpenAI Whisper only (the working path). No key => the
        // Transcribe tab shows a friendly "not configured" state.
        available: !!OPENAI_VOICE_API_KEY,
        provider: 'openai' as const,
        model: 'whisper-1',
        models: ['whisper-1'],
      },
      // Cloning verdict surfaced at the top level too so the Studio can render a
      // single global "cloning unavailable" banner without inspecting providers.
      cloning,
      tts: {
        // Default provider preserved as Deepgram (current behaviour).
        defaultProvider: 'deepgram' as const,
        // Advertised output formats (default first). All callers keep mp3.
        formats: Object.keys(VOICE_TTS_FORMATS),
        defaultFormat: VOICE_TTS_DEFAULT_FORMAT,
        providers: [
          {
            id: 'deepgram' as const,
            label: 'Deepgram Aura-2',
            available: !!DEEPGRAM_API_KEY,
            voices: DEEPGRAM_TTS_VOICES,
            defaultVoice: DEEPGRAM_TTS_DEFAULT_VOICE,
            // C3: Aura-2 accepts a rate control on /v1/speak — flip this on so
            // the UI shows a speed slider for Deepgram too.
            supportsSpeed: true,
            // Deepgram has no free-text style steering.
            supportsInstructions: false,
            // Aura-2 is a single-model TTS surface (voice == model here).
            models: [],
            defaultModel: null,
            formats: Object.keys(VOICE_TTS_FORMATS),
            cloning,
          },
          {
            id: 'openai' as const,
            label: 'OpenAI',
            available: !!OPENAI_VOICE_API_KEY,
            voices: OPENAI_TTS_VOICES,
            defaultVoice: OPENAI_TTS_DEFAULT_VOICE,
            supportsSpeed: true,
            // gpt-4o-mini-tts honours a free-text `instructions` field.
            supportsInstructions: true,
            models: OPENAI_TTS_MODELS,
            defaultModel: OPENAI_TTS_DEFAULT_MODEL,
            // Only gpt-4o-mini-tts actually steers on instructions; the UI can
            // grey the textarea out for the legacy tts-1 models.
            instructionModels: Array.from(OPENAI_TTS_INSTRUCTION_MODELS),
            formats: Object.keys(VOICE_TTS_FORMATS),
            cloning,
          },
        ],
      },
    };
  }

  /**
   * C3 (VOICE): pipe an upstream TTS audio body straight to the Express
   * response for low-latency time-to-first-audio, falling back to a buffered
   * send when the runtime doesn't expose an async-iterable body. Headers are
   * NOT committed until the upstream is confirmed OK by the caller, so an error
   * body can still be written as JSON. Returns nothing — it owns `res` from the
   * first byte. Mirrors the SSE-streaming idiom already used by the chat path
   * (`for await (const bytes of response.body …)`). NEVER logs keys.
   */
  private async streamAudioBody(
    res: Response,
    response: Response | globalThis.Response,
    contentType: string
  ): Promise<void> {
    const upstream = response as unknown as {
      body: AsyncIterable<Uint8Array> | null;
      arrayBuffer(): Promise<ArrayBuffer>;
    };
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    // Prefer true streaming when the body is async-iterable (undici on Node
    // 18+). Any mid-stream error can't retro-actively change the status (bytes
    // are already flowing), so we just end the response — the client hears a
    // truncated clip rather than a 200-with-garbage lie.
    if (upstream.body && typeof (upstream.body as any)[Symbol.asyncIterator] === 'function') {
      try {
        for await (const bytes of upstream.body) {
          // Respect backpressure: stop if the client hung up.
          if (res.writableEnded || res.destroyed) break;
          res.write(Buffer.from(bytes));
        }
        res.end();
        return;
      } catch (e) {
        this.logger.warn(`[voice] tts stream interrupted: ${String(e)}`);
        if (!res.writableEnded) res.end();
        return;
      }
    }
    // Buffered fallback (no streamable body).
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  }

  /**
   * POST /api/voice/tts (and the legacy /api/copilot/voice/tts alias) — text
   * to speech. Streams the audio body on success (mp3 by default, so the wire
   * shape is byte-identical for existing callers).
   *
   * BODY: `{ text, provider?: 'deepgram'|'openai', voice?, speed?, instructions?,
   *          model?, format? }` — ALL new fields are optional; a legacy body
   *          `{ text, provider?, voice?, speed? }` behaves exactly as before.
   *  • provider omitted / 'deepgram'  -> Deepgram Aura-2 /v1/speak, default
   *    model 'aura-2-thalia-en'. `speed` (Aura-2 rate) + `format` are threaded
   *    through as query params; with neither supplied the request is identical
   *    to the historical `?model=<voice>&encoding=mp3` call.
   *  • provider 'openai'              -> OpenAI /v1/audio/speech. Default model
   *    is now `gpt-4o-mini-tts` (honouring a free-text `instructions` field for
   *    emotion/prosody); `tts-1`/`tts-1-hd` remain selectable via `model` and
   *    ignore `instructions`. Full voice roster; optional `speed` 0.25–4.0.
   *
   * A missing key for the CHOSEN provider -> 501 {error:'provider_unavailable',
   * provider} written straight to `res` (NOT a raw HttpException — the global
   * filter would coerce that to a generic 500 and drop the contract body).
   */
  @Throttle('strict')
  @Post(['/api/voice/tts', '/api/copilot/voice/tts'])
  async tts(@Body() body: any, @Res() res: Response) {
    const provider = body?.provider === 'openai' ? 'openai' : 'deepgram';
    const text = typeof body?.text === 'string' ? body.text : '';
    // WS17: length guard — block oversized text from reaching the paid speech
    // API. The FE caps at 2000; longer scripts must use /api/v1/voice/tts-bulk.
    if (text.length > TTS_MAX_TEXT_CHARS) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'text_too_long', max: TTS_MAX_TEXT_CHARS, got: text.length });
      return;
    }
    // Shared, additive format selection (default mp3 => byte-identical wire).
    const fmtKey =
      typeof body?.format === 'string' && body.format in VOICE_TTS_FORMATS
        ? body.format
        : VOICE_TTS_DEFAULT_FORMAT;
    const fmt = VOICE_TTS_FORMATS[fmtKey];

    if (provider === 'openai') {
      if (!OPENAI_VOICE_API_KEY) {
        res
          .status(HttpStatus.NOT_IMPLEMENTED)
          .json({ error: 'provider_unavailable', provider: 'openai' });
        return;
      }
      // Voice/speed validation: unknown voice -> default; speed clamped to the
      // OpenAI-accepted range (a missing/NaN speed omits the field entirely).
      const voice = OPENAI_TTS_VOICES.includes(body?.voice)
        ? body.voice
        : OPENAI_TTS_DEFAULT_VOICE;
      // Model: validated against the allowlist; unknown/omitted -> the new
      // gpt-4o-mini-tts default. Legacy callers that never sent `model` now get
      // the better default model with the SAME voices + mp3 output.
      const model =
        typeof body?.model === 'string' && (OPENAI_TTS_MODELS as readonly string[]).includes(body.model)
          ? body.model
          : OPENAI_TTS_DEFAULT_MODEL;
      const speedNum = Number(body?.speed);
      const payload: Record<string, unknown> = {
        model,
        input: text,
        voice,
        response_format: fmt.openai,
      };
      if (Number.isFinite(speedNum) && speedNum > 0) {
        payload.speed = Math.max(0.25, Math.min(4, speedNum));
      }
      // `instructions` (emotion/prosody) — only forwarded for models that
      // actually support it, and only when non-empty. tts-1* silently ignore
      // the field upstream, but we omit it there to avoid a 400 on strict tiers.
      if (
        OPENAI_TTS_INSTRUCTION_MODELS.has(model) &&
        typeof body?.instructions === 'string' &&
        body.instructions.trim()
      ) {
        payload.instructions = body.instructions
          .trim()
          .slice(0, MAX_TTS_INSTRUCTIONS_CHARS);
      }
      const response = await fetch(OPENAI_SPEECH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_VOICE_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: fmt.contentType,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(VOICE_TTS_TIMEOUT_MS),
      }).catch(() => null);
      if (!response) {
        res
          .status(HttpStatus.BAD_GATEWAY)
          .json({ error: 'tts_failed', provider: 'openai' });
        return;
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        this.logger.warn(
          `[voice] openai tts upstream ${response.status} model=${model} detail=${detail.slice(0, 200)}`
        );
        res.status(HttpStatus.BAD_GATEWAY).json({
          error: 'tts_failed',
          provider: 'openai',
          status: response.status,
        });
        return;
      }
      await this.streamAudioBody(res, response, fmt.contentType);
      return;
    }

    // provider === 'deepgram' — the working path. Extended additively: the 501
    // contract body when the key is missing, plus optional speed/format query
    // params. With neither speed nor a non-mp3 format the outbound request is
    // byte-identical to the historical `?model=<voice>&encoding=mp3` call.
    if (!DEEPGRAM_API_KEY) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'provider_unavailable', provider: 'deepgram' });
      return;
    }
    const model = body?.voice || DEEPGRAM_TTS_DEFAULT_VOICE;
    // Aura-2 encoding param: mp3 stays 'mp3'; other formats map through the same
    // table (opus/aac/flac/wav are valid Deepgram encodings).
    const dgEncoding = fmt.deepgram;
    let dgUrl = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=${encodeURIComponent(dgEncoding)}`;
    // Aura-2 supports a playback rate control; forward a clamped `speed` when a
    // finite, positive, non-default value is supplied (omit otherwise so the
    // default request is unchanged).
    const dgSpeed = Number(body?.speed);
    if (Number.isFinite(dgSpeed) && dgSpeed > 0 && dgSpeed !== 1) {
      dgUrl += `&speed=${encodeURIComponent(String(Math.max(0.25, Math.min(4, dgSpeed))))}`;
    }
    const response = await fetch(dgUrl, {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: fmt.contentType,
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(VOICE_TTS_TIMEOUT_MS),
    }).catch(() => null);
    if (!response) {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'tts_failed', provider: 'deepgram' });
      return;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.warn(
        `[voice] deepgram tts upstream ${response.status} detail=${detail.slice(0, 200)}`
      );
      res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'tts_failed',
        provider: 'deepgram',
        status: response.status,
      });
      return;
    }
    await this.streamAudioBody(res, response, fmt.contentType);
  }

  /**
   * POST /api/v1/voice/tts-bulk — long-script / bulk text-to-speech.
   *
   * Splits a long text into sentence-boundary-respecting chunks (each <=
   * BULK_TTS_MAX_CHUNK_CHARS), synthesizes every chunk S E R I A L L Y with the
   * SAME provider/voice/model/speed/instructions/format logic the single-shot
   * /api/voice/tts route above uses (an identical request shape + headers +
   * format table), byte-concatenates the audio, persists the resulting clip to
   * the user's Voice Library (CopilotStorage), and returns the Library record
   * so the Studio can play/download it immediately.
   *
   * BODY: `{ text, provider?, voice?, model?, speed?, instructions?, format?,
   *          name? }` (all TTS fields optional, same semantics as /api/voice/tts).
   * RESPONSE: `{ clip: { id, url, name, createdAt, kind:'tts' }, chunks: n }`.
   *
   * Auth: session-authed like every voice surface. Errors: typed 4xx/5xx —
   * BadRequest for a bad/oversized body, InternalServerError/509-style 502 for
   * an upstream TTS failure or persist failure. Bytes are concatenated per-format
   * the same way the Studio's client-side concatBlobs works, so mp3 stays
   * byte-compatible for existing players.
   */
  @Throttle('strict')
  @Post('/api/v1/voice/tts-bulk')
  async ttsBulk(
    @CurrentUser() user: CurrentUser,
    @Body() body: any
  ): Promise<{
    clip: {
      id: string;
      url: string;
      name: string;
      createdAt: number;
      kind: 'tts';
    };
    chunks: number;
  }> {
    const provider = body?.provider === 'openai' ? 'openai' : 'deepgram';
    const text = typeof body?.text === 'string' ? body.text : '';
    const trimmed = text.trim();
    if (!trimmed) {
      throw new BadRequest('A non-empty "text" is required');
    }
    if (trimmed.length > BULK_TTS_MAX_INPUT_CHARS) {
      throw new BadRequest(
        `"text" is too long for bulk TTS (max ${BULK_TTS_MAX_INPUT_CHARS} characters)`
      );
    }

    // Shared, additive format selection (default mp3 => audio/mpeg), identical
    // to the single-shot route.
    const fmtKey =
      typeof body?.format === 'string' && body.format in VOICE_TTS_FORMATS
        ? body.format
        : VOICE_TTS_DEFAULT_FORMAT;
    const fmt = VOICE_TTS_FORMATS[fmtKey];

    // Resolve the same per-provider voice/model/params the single-shot route
    // resolves, so a bulk clip is byte-identical to N consecutive /api/voice/tts
    // calls under the same body.
    const openaiVoice = OPENAI_TTS_VOICES.includes(body?.voice)
      ? body.voice
      : OPENAI_TTS_DEFAULT_VOICE;
    const openaiModel =
      typeof body?.model === 'string' &&
      (OPENAI_TTS_MODELS as readonly string[]).includes(body.model)
        ? body.model
        : OPENAI_TTS_DEFAULT_MODEL;
    const speedNum = Number(body?.speed);
    const hasSpeed = Number.isFinite(speedNum) && speedNum > 0;
    const speed = hasSpeed ? Math.max(0.25, Math.min(4, speedNum)) : undefined;
    const instructions =
      OPENAI_TTS_INSTRUCTION_MODELS.has(openaiModel) &&
      typeof body?.instructions === 'string' &&
      body.instructions.trim()
        ? body.instructions.trim().slice(0, MAX_TTS_INSTRUCTIONS_CHARS)
        : undefined;
    const dgVoice = body?.voice || DEEPGRAM_TTS_DEFAULT_VOICE;

    // Sentence-boundary-respecting chunking: pack whole sentences together up
    // to the per-chunk cap; only hard-wrap (best effort) when a single sentence
    // alone exceeds the cap. WS17: include Arabic/Darija sentence punctuation
    // (؟ U+061F question mark, ۝ not used here) plus the Arabic comma U+060C as
    // a secondary split point so non-Latin scripts chunk naturally instead of
    // being treated as one giant sentence and hard-wrapped mid-word.
    const sentenceParts = trimmed
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?؟\u060C])\s+/)
      .map(chunk => chunk.trim())
      .filter(Boolean);
    const chunks: string[] = [];
    let current = '';
    const finishCurrent = () => {
      if (current) {
        chunks.push(current);
        current = '';
      }
    };
    const pushHardWrapped = (long: string) => {
      let slice = long;
      while (slice.length > BULK_TTS_MAX_CHUNK_CHARS) {
        chunks.push(slice.slice(0, BULK_TTS_MAX_CHUNK_CHARS));
        slice = slice.slice(BULK_TTS_MAX_CHUNK_CHARS);
      }
      if (slice) chunks.push(slice);
    };
    for (const sentence of sentenceParts) {
      if (!current) {
        if (sentence.length <= BULK_TTS_MAX_CHUNK_CHARS) {
          current = sentence;
        } else {
          // A single over-cap sentence: hard-wrap at the char cap.
          pushHardWrapped(sentence);
        }
        continue;
      }
      if ((current + ' ' + sentence).length <= BULK_TTS_MAX_CHUNK_CHARS) {
        current += ' ' + sentence;
      } else {
        finishCurrent();
        if (sentence.length <= BULK_TTS_MAX_CHUNK_CHARS) {
          current = sentence;
        } else {
          pushHardWrapped(sentence);
        }
      }
    }
    finishCurrent();

    if (!chunks.length || chunks.length > BULK_TTS_MAX_CHUNKS) {
      throw new BadRequest('"text" could not be chunked for synthesis');
    }

    // Serial synthesis — reuse the exact per-provider fetch shape of the
    // single-shot /api/voice/tts route, collecting raw audio buffers.
    const buffers: Buffer[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const part = chunks[i];
      let out: Buffer | null = null;
      if (provider === 'openai') {
        if (!OPENAI_VOICE_API_KEY) {
          throw new InternalServerError('Voice provider is not configured');
        }
        const payload: Record<string, unknown> = {
          model: openaiModel,
          input: part,
          voice: openaiVoice,
          response_format: fmt.openai,
        };
        if (typeof speed === 'number') payload.speed = speed;
        if (instructions) payload.instructions = instructions;
        const response = await fetch(OPENAI_SPEECH_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${OPENAI_VOICE_API_KEY}`,
            'Content-Type': 'application/json',
            Accept: fmt.contentType,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(VOICE_TTS_TIMEOUT_MS),
        }).catch(() => null);
        if (!response) {
          throw new InternalServerError(
            `Bulk TTS failed on chunk ${i + 1}/${chunks.length}`
          );
        }
        if (!response.ok) {
          throw new InternalServerError(
            `Bulk TTS upstream error on chunk ${i + 1}/${chunks.length}`
          );
        }
        out = Buffer.from(await response.arrayBuffer());
      } else {
        if (!DEEPGRAM_API_KEY) {
          throw new InternalServerError('Voice provider is not configured');
        }
        let dgUrl = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(
          dgVoice
        )}&encoding=${encodeURIComponent(fmt.deepgram)}`;
        if (typeof speed === 'number' && speed !== 1) {
          dgUrl += `&speed=${encodeURIComponent(String(speed))}`;
        }
        const response = await fetch(dgUrl, {
          method: 'POST',
          headers: {
            Authorization: `Token ${DEEPGRAM_API_KEY}`,
            'Content-Type': 'application/json',
            Accept: fmt.contentType,
          },
          body: JSON.stringify({ text: part }),
          signal: AbortSignal.timeout(VOICE_TTS_TIMEOUT_MS),
        }).catch(() => null);
        if (!response) {
          throw new InternalServerError(
            `Bulk TTS failed on chunk ${i + 1}/${chunks.length}`
          );
        }
        if (!response.ok) {
          throw new InternalServerError(
            `Bulk TTS upstream error on chunk ${i + 1}/${chunks.length}`
          );
        }
        out = Buffer.from(await response.arrayBuffer());
      }
      if (!out || out.length === 0) {
        throw new InternalServerError(
          `Bulk TTS produced empty audio on chunk ${i + 1}/${chunks.length}`
        );
      }
      buffers.push(out);
    }

    // Byte-concatenate (the same container-less / frame-concat semantics as
    // the Studio's concatBlobs) and persist to the Library via CopilotStorage.
    const concatenated = Buffer.concat(buffers);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const key = `voice-library/tts/${id}`;
    const rawName = typeof body?.name === 'string' ? body.name : '';
    const name = (rawName.trim().slice(0, 200) || 'Clip').trim();
    let url: string;
    let createdAt = Date.now();
    try {
      url = await this.copilotStorage.put(
        user.id,
        'voice',
        key,
        concatenated,
        fmt.contentType
      );
    } catch (e) {
      throw new InternalServerError(
        e instanceof Error && e.message
          ? `Failed to persist clip: ${e.message}`
          : 'Failed to persist clip'
      );
    }

    this.logger.log(
      `[voice] tts-bulk user=${user.id} provider=${provider} chunks=${chunks.length} bytes=${concatenated.length}`
    );

    // WS17: append to the Voice Library Redis index so the clip appears in
    // GET /api/v1/voice/library/clips (the Library tab). Fail-soft — a Redis
    // hiccup only loses the list row, not the bytes (the URL still works).
    const record: LibraryRecord = {
      id,
      key,
      url,
      name,
      kind: 'tts',
      createdAt,
    };
    try {
      const idxKey = CDZ_VOICE_LIBRARY.indexKey(user.id);
      let items: LibraryRecord[] = [];
      const raw = await this.redis.get(idxKey);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          items = parsed.filter(
            (r): r is LibraryRecord =>
              !!r &&
              typeof (r as Partial<LibraryRecord>)?.id === 'string' &&
              typeof (r as Partial<LibraryRecord>)?.key === 'string' &&
              typeof (r as Partial<LibraryRecord>)?.url === 'string' &&
              typeof (r as Partial<LibraryRecord>)?.name === 'string' &&
              ((r as Partial<LibraryRecord>)?.kind === 'tts' ||
                (r as Partial<LibraryRecord>)?.kind === 'transcript') &&
              typeof (r as Partial<LibraryRecord>)?.createdAt === 'number'
          );
        }
      }
      const next = [record, ...items].slice(0, CDZ_VOICE_LIBRARY.maxItems);
      await this.redis.set(idxKey, JSON.stringify(next));
      await this.redis.expire(idxKey, CDZ_VOICE_LIBRARY.ttlSeconds);
    } catch (e) {
      this.logger.warn(
        `[voice] tts-bulk library index write failed user=${user.id}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }

    return {
      clip: { id, url, name, createdAt, kind: 'tts' },
      chunks: chunks.length,
    };
  }

  /**
   * POST /api/voice/transcribe (and the legacy /api/copilot/voice/transcribe
   * alias) — speech to text. This was a permanent stub; it is now REAL, using
   * the SAME OpenAI Whisper mechanics as /api/v1/vdz/transcribe.
   *
   * BODY: the RAW audio bytes with `Content-Type: application/octet-stream`
   * (routed through the app's 100MB raw parser — NOT JSON). QUERY: `?mime=`
   * the real audio mime, `?name=` an optional filename hint (both sanitized).
   *
   * Engine: OpenAI `whisper-1`, `verbose_json`, word timestamps requested.
   * RESPONSE: `{ text, words?: [{w,t0,t1}], language? }` (absolute audio
   * seconds). No key => 501 {error:'provider_unavailable', provider:'openai'}
   * via `res` (never a raw HttpException). Payload-shaped upstream failures ->
   * 400; everything else -> 502.
   */
  @Throttle('strict')
  @Post(['/api/voice/transcribe', '/api/copilot/voice/transcribe'])
  async transcribe(
    @Body() body: unknown,
    @Res() res: Response,
    @Query('mime') mime?: string,
    @Query('name') name?: string
  ) {
    if (!OPENAI_VOICE_API_KEY) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'provider_unavailable', provider: 'openai' });
      return;
    }
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'bad_audio',
        message:
          'Send the raw audio bytes with Content-Type: application/octet-stream',
      });
      return;
    }
    if (body.length > MAX_VOICE_TRANSCRIBE_BYTES) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'too_large',
        message: `Audio too large for transcription (max ${Math.floor(
          MAX_VOICE_TRANSCRIBE_BYTES / (1024 * 1024)
        )}MB)`,
      });
      return;
    }
    // Sanitize the client-supplied hints (they only shape the upload part) —
    // identical rules to the vdz transcribe route.
    const safeMime =
      typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mime)
        ? mime
        : 'audio/mpeg';
    const safeName =
      typeof name === 'string' && name.trim()
        ? name.trim().slice(0, 120).replace(/[^\w.\- ]+/g, '_')
        : 'audio';

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(body)], { type: safeMime }),
      safeName
    );
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    // Repeated `timestamp_granularities[]` field (one append per value); `word`
    // populates a top-level words:[{word,start,end}] array we normalize below.
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');

    const response = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_VOICE_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(VOICE_TRANSCRIBE_TIMEOUT_MS),
    }).catch(() => null);
    if (!response) {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'transcribe_failed', message: 'Service unreachable' });
      return;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.warn(
        `[voice] transcribe upstream ${response.status} bytes=${body.length} detail=${detail.slice(0, 300)}`
      );
      if (
        response.status === 400 ||
        response.status === 415 ||
        response.status === 422
      ) {
        res.status(HttpStatus.BAD_REQUEST).json({
          error: 'bad_audio',
          message:
            'The audio could not be transcribed (unsupported or corrupt format)',
        });
        return;
      }
      res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'transcribe_failed',
        status: response.status,
      });
      return;
    }

    const data = (await response.json().catch(() => null)) as {
      text?: unknown;
      language?: unknown;
      words?: unknown;
    } | null;
    if (!data) {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'transcribe_failed', message: 'Malformed response' });
      return;
    }
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    // Word timestamps arrive as a TOP-LEVEL words:[{word,start,end}] array
    // (verbose_json + timestamp_granularities['word']). Normalize to the
    // contract's `{ w, t0, t1 }` (absolute audio seconds); attach only when
    // present so old callers that ignore `words` see a stable shape.
    const words = (Array.isArray(data.words) ? data.words : [])
      .map(raw => {
        const w = (raw ?? {}) as Record<string, unknown>;
        return {
          w: typeof w.word === 'string' ? w.word : '',
          t0: Number(w.start) || 0,
          t1: Number(w.end) || 0,
        };
      })
      .filter(w => w.w.trim().length > 0);
    const language =
      typeof data.language === 'string' && data.language.trim()
        ? data.language.trim()
        : undefined;

    this.logger.log(
      `[voice] transcribe bytes=${body.length} chars=${text.length} words=${words.length}`
    );
    res.json({
      text,
      ...(words.length > 0 ? { words } : {}),
      ...(language ? { language } : {}),
    });
  }

  // ===========================================================================
  // WS11/C6 — IN-APP ERP (KEEPER): owner-only dashboard + admin endpoints.
  // Every route: session auth (@CurrentUser via the global AuthGuard) + an
  // ownership check against the caller's published-apps set. Typed errors
  // only (BadRequest/NotFound/ActionForbidden) or hand-written passthrough
  // bodies — NEVER a raw HttpException (the global filter coerces it to 500).
  // ===========================================================================

  /**
   * Absolute per-slug Data API base — the SAME externalBase the
   * generate/template paths bake into app HTML, so the in-app dashboard and
   * the deployed shop/ERP hit one shared datastore.
   */
  private erpDataBase(slug: string): string {
    const externalBase = (
      process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
    ).replace(/\/+$/, '');
    return `${externalBase}/api/v2/apps-data/${slug}`;
  }

  /**
   * GET a whole collection server-side (≤500 records, newest-first — the data
   * API's own sort/caps). Returns null when the data API is unreachable or
   * answers malformed JSON; callers map that to a typed 502 body.
   */
  private async erpList(
    slug: string,
    collection: string
  ): Promise<ErpRecord[] | null> {
    // SEC-2: carry the per-slug read/write token on internal reads.
    //
    // This helper is the backend's own read path for every ERP collection —
    // orders, caisse, invoices, customers, products, suppliers. It previously
    // sent no credential, which works only while CDZ_DATA_READ_GATE is off. The
    // moment that gate is switched on to stop anonymous scraping of buyers'
    // phone numbers and addresses, every one of these internal reads would 401
    // and the ERP backend would break wholesale — courier sync, reconciliation,
    // invoicing, the dashboard.
    //
    // The token is the same value verifyDataToken checks on the read side (the
    // gate reuses the write secret deliberately — no new auth mechanism), it is
    // re-derived server-side per request, and it never reaches the browser.
    // Sending it while the gate is OFF is a no-op: the @Public GET ignores an
    // Authorization header it does not need. So this is safe to ship BEFORE the
    // flag flips, which is exactly the staged rollout the gate was designed for.
    //
    // WS17: the data API caps a single list at 500 rows. Previously this helper
    // made ONE request with ?limit=500 and silently dropped anything older — a
    // monthly invoice partition or products/orders collection with >500 records
    // was truncated, causing missed invoices and stale counts. Now it paginates
    // with ?offset until the collection is exhausted (or ERP_LIST_MAX_ROWS is
    // reached, a hard guard against unbounded reads on a runaway collection).
    const token = dataWriteToken(slug);
    const out: ErpRecord[] = [];
    let offset = 0;
    const pageSize = 500;
    // Hard guard: 5000 rows is far beyond any realistic ERP collection and stops
    // a degenerate collection from fanning out into 10s of requests.
    const ERP_LIST_MAX_ROWS = 5000;
    while (offset < ERP_LIST_MAX_ROWS) {
      const res = await fetch(
        `${this.erpDataBase(slug)}/${collection}?limit=${pageSize}&offset=${offset}`,
        {
          headers: {
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: AbortSignal.timeout(ERP_DATA_TIMEOUT_MS),
        }
      ).catch(() => null);
      if (!res || !res.ok) {
        if (offset === 0) {
          this.logger.warn(
            `[erp] list failed slug=${slug} coll=${collection} status=${res ? res.status : 'unreachable'}`
          );
          return null;
        }
        // Partial result on a later page is better than nothing; break and
        // return what we have so far.
        break;
      }
      const data = (await res.json().catch(() => null)) as unknown;
      if (!Array.isArray(data)) {
        if (offset === 0) return null;
        break;
      }
      const page = data as ErpRecord[];
      out.push(...page);
      // Fewer than a full page means we've reached the end.
      if (page.length < pageSize) break;
      offset += pageSize;
    }
    return out;
  }

  /**
   * DELETE one record using the re-derived per-slug write token (Bearer).
   * NEVER logs the token. false ⇒ the delete did not go through — callers
   * abort BEFORE the recreate half so a failed replace can't duplicate.
   */
  private async erpDeleteRecord(
    slug: string,
    collection: string,
    id: string,
    token: string
  ): Promise<boolean> {
    const res = await fetch(
      `${this.erpDataBase(slug)}/${collection}/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(ERP_DATA_TIMEOUT_MS),
      }
    ).catch(() => null);
    if (!res || !res.ok) {
      this.logger.warn(
        `[erp] delete failed slug=${slug} coll=${collection} id=${id} status=${res ? res.status : 'unreachable'}`
      );
      return false;
    }
    return true;
  }

  /**
   * POST one record using the re-derived per-slug write token. On success
   * returns the stored record (with the data API's fresh id/createdAt).
   * status 0 = unreachable. NEVER logs the token.
   */
  private async erpCreateRecord(
    slug: string,
    collection: string,
    record: ErpRecord,
    token: string
  ): Promise<{ ok: true; record: ErpRecord } | { ok: false; status: number }> {
    const res = await fetch(`${this.erpDataBase(slug)}/${collection}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(ERP_DATA_TIMEOUT_MS),
    }).catch(() => null);
    if (!res || !res.ok) {
      const status = res ? res.status : 0;
      this.logger.warn(
        `[erp] create failed slug=${slug} coll=${collection} status=${status || 'unreachable'}`
      );
      return { ok: false, status };
    }
    const created = (await res.json().catch(() => null)) as ErpRecord | null;
    return { ok: true, record: created ?? record };
  }

  /**
   * Map a failed data-API create to this surface's typed JSON bodies (via
   * passthrough res — a raw HttpException would be coerced to a 500).
   */
  private erpWriteFailed(res: Response, status: number): void {
    if (status === 401) {
      // The data API rejected OUR freshly-minted token ⇒ the write secret is
      // not usable on this deployment (CDZ_DATA_SECRET / CLICKDZ_BRIDGE_TOKEN
      // mismatch across replicas). Same contract body as the no-secret case
      // so the frontend shows ONE clear "admin writes unavailable" notice.
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
    } else if (status === 400 || status === 413) {
      // The data API's own typed validation said no (record too large /
      // collection full / malformed) — surface as a client-fixable 400.
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'data_rejected', status });
    } else {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'data_write_failed', ...(status ? { status } : {}) });
    }
  }

  /**
   * C6 ownership gate: the :slug must belong to the CALLER. Reuses the exact
   * /apps/mine mechanism (readPublishedApps) — a record whose `slug` OR
   * paired `storeSlug` matches proves ownership of the data namespace.
   *
   * Not-owner (403) vs unknown (404) without a global slug registry: the
   * per-slug collections are publicly readable anyway (the data GET is
   * @Public), so probing the settings collection leaks nothing new. A live
   * shop seeds its settings singleton on first load, so data present ⇒ the
   * namespace belongs to SOMEONE — just not the caller ⇒ typed 403. No
   * records at all (or data API down, deny-path only) ⇒ typed 404.
   */
  // =========================================================================
  // WSE-2 (LEDGER) — FACTURATION DZ. Owner-gated invoice routes (devis/bl/
  // facture) gated by env CDZ_ERP_INVOICING. Pure math/validation/partition/
  // sequence logic lives in ./clickdz-erp-invoicing; these routes only do I/O
  // (ownership, data-API reads/writes with the re-derived write token) and map
  // the module's discriminated-union `reason`s to typed 4xx bodies. Money docs
  // are written with the ATOMIC data-API PUT (never delete+recreate) so an
  // invoice never vanishes mid-edit and a gap-less legal number is never
  // re-minted. Typed errors from ../../base or hand-written passthrough — never
  // a raw HttpException (the global filter coerces it to 500).
  // =========================================================================

  /** WSE-2: invoicing on? (env CDZ_ERP_INVOICING; OFF = routes 404). */
  private erpInvoicingEnabled(): boolean {
    const v = String(process.env.CDZ_ERP_INVOICING || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes';
  }

  /** WSE-2: guard — throw a typed 404 when the feature flag is off. */
  private assertInvoicingEnabled(): void {
    if (!this.erpInvoicingEnabled()) {
      throw new NotFound('Facturation is not enabled');
    }
  }

  /** WSE-2: build InvoiceOptions from env (TVA/timbre rates + today). */
  private erpInvoiceOptions(): InvoiceOptions {
    const { tvaRate, timbreRate } = resolveInvoiceRates(
      process.env.CDZ_ERP_TVA_RATE,
      process.env.CDZ_ERP_TIMBRE_RATE
    );
    return { tvaRate, timbreRate };
  }

  /** WSE-2: a fresh temporary draft id (bridge has no randomUUID — use bytes). */
  private erpDraftId(): string {
    return `draft-${randomBytes(6).toString('hex')}`;
  }

  /**
   * WSE-2 helper — ATOMIC upsert of one money document via the data API's PUT
   * route (R1 `PUT /api/v2/apps-data/:slug/:collection/:id`). No delete window:
   * a concurrent reader sees old-or-new, never a gap. Returns the stored record
   * or a status (0 = unreachable). NEVER logs the token.
   */
  private async erpInvoicePut(
    slug: string,
    collection: string,
    id: string,
    record: ErpRecord,
    token: string
  ): Promise<{ ok: true; record: ErpRecord } | { ok: false; status: number }> {
    const res = await fetch(
      `${this.erpDataBase(slug)}/${collection}/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(ERP_DATA_TIMEOUT_MS),
      }
    ).catch(() => null);
    if (!res || !res.ok) {
      const status = res ? res.status : 0;
      this.logger.warn(
        `[erp] invoice put failed slug=${slug} coll=${collection} id=${id} status=${status || 'unreachable'}`
      );
      return { ok: false, status };
    }
    const stored = (await res.json().catch(() => null)) as ErpRecord | null;
    return { ok: true, record: stored ?? record };
  }

  /**
   * WSE-2 helper — find one invoice by its id across a bounded window of
   * monthly partitions (newest-first). Returns the record + its partition
   * collection name (needed to PUT the update back into the SAME partition),
   * or null when not found / the data API is unreachable on every read.
   */
  private async erpFindInvoice(
    slug: string,
    id: string
  ): Promise<{ record: InvoiceRecord; collection: string } | null> {
    // WS17: a validated id encodes its year (<type>-<year>-<seq>, e.g.
    // facture-2026-00042), so we can scan ONLY that year's 12 monthly partitions
    // instead of the last 24 — a ~2x reduction in data-API calls and latency on
    // every invoice lookup. Draft ids (draft-xxxxxx) don't encode a year, but
    // drafts are always recent, so scan just the current month for them. Fall
    // back to the 24-month sweep only if the year can't be parsed.
    const yearMatch = /^[\w-]+-(\d{4})-/.exec(id);
    const isDraft = /^draft-/i.test(id);
    let cols: string[];
    if (yearMatch) {
      const yr = Number(yearMatch[1]);
      cols = invoiceCollectionsInRange(`${yr}-01`, `${yr}-12`, 12);
    } else if (isDraft) {
      const now = new Date();
      const curMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      cols = invoiceCollectionsInRange(curMonth, curMonth, 1);
    } else {
      // Unknown id shape — fall back to the last 24 months (prior behavior).
      const now = new Date();
      const from = new Date(
        Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)
      );
      cols = invoiceCollectionsInRange(
        `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`,
        `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
        24
      );
    }
    for (const col of cols) {
      const rows = await this.erpList(slug, col);
      if (!rows) continue;
      const hit = rows.find(r => erpStr(r.id) === id);
      if (hit) {
        const inv = coerceInvoice(hit);
        if (inv) return { record: inv, collection: col };
      }
    }
    return null;
  }

  /**
   * WSE-2 — map a clickdz-erp-invoicing ValidationError `reason` to a typed 400
   * body (passthrough res — a raw HttpException would be coerced to 500). The
   * reason string is a stable machine code; the frontend renders the FR label.
   */
  private erpInvoiceBadInput(res: Response, reason: string, field?: string): void {
    res.status(HttpStatus.BAD_REQUEST).json({
      error: 'invalid_invoice',
      reason,
      ...(field ? { field } : {}),
    });
  }

  /**
   * WSE-2 — POST /api/v1/apps/:slug/erp/invoices (auth'd, owner-only).
   * BODY `{ type, customer, lines, orderRef?, payment?, date? }` — create a
   * DRAFT invoice (status brouillon, NO number yet). When `orderRef` is present
   * and `lines` is absent, mints the draft FROM the shop order (items→lines).
   * Written atomically via PUT at a temp draft id into the date's monthly
   * partition. Returns `{ ok, invoice }`.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/invoices')
  async erpCreateInvoice(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertInvoicingEnabled();
    await this.assertOwnsErpApp(user, slug);
    const opts = this.erpInvoiceOptions();
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const draftId = this.erpDraftId();
    const orderRef = erpStr(body?.orderRef).trim();
    const hasLines = Array.isArray(body?.lines) && body.lines.length > 0;

    let built:
      | { ok: true; record: InvoiceRecord }
      | { ok: false; reason: string; field?: string };
    if (orderRef && !hasLines) {
      // convert-from-order: fetch the order (matched by ref) then map it.
      const orders = await this.erpList(slug, 'orders');
      if (!orders) {
        res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
        return;
      }
      const order = orders.find(o => erpStr(o.ref).trim() === orderRef);
      if (!order) {
        throw new NotFound('Order not found');
      }
      built = buildInvoiceFromOrder(
        order,
        { type: body?.type, customer: body?.customer, payment: body?.payment },
        draftId,
        opts
      );
    } else {
      built = buildDraftInvoice(
        {
          type: body?.type,
          customer: body?.customer,
          lines: body?.lines,
          payment: body?.payment,
          orderRef: body?.orderRef,
          date: body?.date,
        },
        draftId,
        opts
      );
    }
    if (!built.ok) {
      this.erpInvoiceBadInput(res, built.reason, built.field);
      return;
    }
    const record = built.record;
    if (
      Buffer.byteLength(JSON.stringify(record), 'utf8') > ERP_MAX_WRITE_BYTES
    ) {
      throw new BadRequest('Invoice record too large (8KB cap; reduce line count)');
    }
    const collection = invoiceCollectionForDate(String(record.date));
    const put = await this.erpInvoicePut(
      slug,
      collection,
      draftId,
      record as unknown as ErpRecord,
      token
    );
    if (!put.ok) {
      this.erpWriteFailed(res, put.status);
      return;
    }
    this.logger.log(
      `[erp] invoice draft slug=${slug} user=${user.id} type=${record.type} coll=${collection}${orderRef ? ` order=${orderRef.slice(0, 40)}` : ''}`
    );
    return { ok: true, invoice: put.record };
  }

  /**
   * WSE-2 — GET /api/v1/apps/:slug/erp/invoices (auth'd, owner-only).
   * QUERY `month?=YYYY-MM` (or `from`/`to` range), `type?`, `status?`. Fetches
   * the matching monthly partitions server-side, merges, filters + sorts
   * (newest-first) via the pure module. Returns `{ invoices, partitionsRead }`.
   *
   * THROTTLE-1 — why this is not a bare @Throttle('strict'), and why every other
   * read-only GET in this controller now matches:
   *
   * CloudThrottlerGuard keys a bare named throttler as `${tracker};strict`, so all
   * 68 routes here shared ONE bucket of 20 requests per 60 seconds, per session
   * (see base/throttler: generateKey, plus config.ts where strict = limit 20 /
   * ttl 60_000). A merchant touring panels legitimately spends 14-16 of those, so
   * the margin was already thin; when SEC-2 moved the studio's collection reads
   * through this controller it tipped over, and Facturation and Fournisseurs began
   * answering "Too many requests" in production.
   *
   * Supplying an explicit limit/ttl makes the guard append ';custom' and key the
   * bucket PER HANDLER, so one read-heavy panel can no longer starve the others —
   * or, worse, starve the WRITE routes, which is how a read 429 turns into a
   * merchant who cannot record an order.
   *
   * Writes deliberately stay on the shared strict bucket: that is what it exists
   * to protect, and no human legitimately fires 20 writes a minute by hand.
   */
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/invoices')
  async erpListInvoices(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Query('month') month: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('type') type: string | undefined,
    @Query('status') status: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertInvoicingEnabled();
    await this.assertOwnsErpApp(user, slug);
    // A single `month` collapses to a one-month range; else `from`/`to`; else
    // the module defaults to the current month.
    const cols = month
      ? invoiceCollectionsInRange(month, month, 24)
      : invoiceCollectionsInRange(from, to, 24);
    const merged: ErpRecord[] = [];
    let read = 0;
    let failed = 0;
    for (const col of cols) {
      const rows = await this.erpList(slug, col);
      if (!rows) {
        failed++;
        continue;
      }
      read++;
      for (const r of rows) merged.push(r);
    }
    if (read === 0 && failed > 0) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const invoices = filterInvoices(merged, { type, status });
    return { invoices, partitionsRead: read };
  }

  /**
   * WSE-2 — GET /api/v1/apps/:slug/erp/invoices/:id (auth'd, owner-only).
   * Finds one invoice across the partition window. 404 when absent.
   */
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/invoices/:id')
  async erpGetInvoice(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertInvoicingEnabled();
    await this.assertOwnsErpApp(user, slug);
    const found = await this.erpFindInvoice(slug, erpStr(id).trim());
    if (!found) {
      throw new NotFound('Invoice not found');
    }
    return { invoice: found.record };
  }

  // R18 PR-B — durable gap-less reserve, shared by invoice validation and PO
  // creation. The legacy Redis INCR stays the source of the hint (and the
  // whole answer while CDZ_ERPSEQ_PG is off — byte-identical legacy path).
  // Flag on: Postgres cdz_erp_seq becomes the monotonic floor via max-merge
  // (CdzErpSeqModel.reserve) — the returned number is always >= the Redis one
  // and two concurrent validations still get distinct numbers. PG trouble does
  // not block invoicing: the PG hop is bounded by CDZ_ERPSEQ_PG_TIMEOUT_MS and
  // fails soft — BUT never blindly (Sentinel MAJOR-1): before trusting the raw
  // Redis number the fallback takes a fast look at the PG floor; if PG proves
  // the number was already issued (floor >= rNum ⇒ Redis has regressed, e.g.
  // RDB restore), it atomically jumps Redis PAST the floor with INCRBY (which
  // can never regress, so concurrent healers get distinct numbers — worst case
  // a small burned gap, never a duplicate) and returns the healed number. Only
  // when PG is completely unreadable does it return the raw Redis number —
  // exactly today's pre-PR exposure, never worse. Duplicates are fiscal
  // violations; rare gaps are the documented gap-less cost (see the burned-
  // number note in erpValidateInvoice). When PG advances past Redis on the
  // happy path, the Redis key heals forward (best-effort SET outside the
  // fallback so a heal failure can't discard PG's answer).
  private async erpReserveSeq(
    key: string,
    slug: string,
    docType: string,
    year: number
  ): Promise<number> {
    const rNum = Math.max(
      1,
      Math.floor(Number(await this.redis.incr(key)) || 1)
    );
    if (!CDZ_ERPSEQ_PG) return rNum;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finalN = rNum;
    try {
      const running = this.models.cdzErpSeq.reserve(slug, docType, year, rNum);
      running.catch(() => {});
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('erpseq pg timeout')),
          CDZ_ERPSEQ_PG_TIMEOUT_MS
        );
      });
      finalN = await Promise.race([running, timeout]);
    } catch (err) {
      this.logger.warn(
        `[cdz-erpseq-pg] reserve failed (${String(
          (err as Error)?.message ?? err
        ).slice(0, 160)}) key=${key} — checking floor before fallback`
      );
      return await this.erpReserveFallback(key, slug, docType, year, rNum);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (finalN > rNum) {
      try {
        await this.redis.set(key, String(finalN));
      } catch {
        // Heal is cosmetic (keeps the hint close); PG's floor already
        // guarantees monotonicity, so a failed SET changes nothing.
      }
    }
    return finalN;
  }

  // The MAJOR-1 guard (see erpReserveSeq). Runs only when the main PG reserve
  // failed/timed out. Bounded fast floor read (min(1s, main timeout)):
  //   floor unreadable       → PG fully down; return the raw Redis number
  //                            (identical to the pre-PR exposure — never worse).
  //   floor <  rNum          → Redis is ahead of PG; rNum was never issued
  //                            before — safe to use.
  //   floor >= rNum          → Redis has REGRESSED (restore) — rNum may already
  //                            be on a merchant's facture. Self-heal: INCRBY
  //                            jumps Redis past the floor atomically (INCRBY
  //                            never regresses ⇒ concurrent healers still get
  //                            distinct numbers; worst case burns a small gap,
  //                            never duplicates) and the healed number is
  //                            returned. If even that INCRBY fails (Redis broke
  //                            in the last millisecond), throw a typed 4xx so
  //                            the merchant retries — the ONLY deliberate throw
  //                            on this path, because the alternative is issuing
  //                            a duplicate legal number.
  private async erpReserveFallback(
    key: string,
    slug: string,
    docType: string,
    year: number,
    rNum: number
  ): Promise<number> {
    let floorV: number | null = null;
    let floorTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reading = this.models.cdzErpSeq.floor(slug, docType, year);
      reading.catch(() => {});
      const floorTimeout = new Promise<never>((_, reject) => {
        floorTimer = setTimeout(
          () => reject(new Error('erpseq floor timeout')),
          Math.min(1000, CDZ_ERPSEQ_PG_TIMEOUT_MS)
        );
      });
      floorV = await Promise.race([reading, floorTimeout]);
    } catch {
      floorV = null;
    } finally {
      if (floorTimer) clearTimeout(floorTimer);
    }
    if (floorV === null || floorV < rNum) {
      this.logger.warn(
        `[cdz-erpseq-pg] fallback to redis number (floor=${floorV === null ? 'unreadable' : floorV}) key=${key}`
      );
      return rNum;
    }
    try {
      const jumped = Math.floor(
        Number(await this.redis.incrby(key, floorV - rNum + 1))
      );
      // Airtight invariant: the heal path must NEVER hand out a number <= the
      // proven floor (that would be the very duplicate this guard exists to
      // prevent). A racing SET-heal can theoretically drag the counter down;
      // refuse rather than trust an anomalous result.
      if (!Number.isFinite(jumped) || jumped <= floorV) {
        throw new Error(`incrby anomaly (got ${jumped}, floor ${floorV})`);
      }
      this.logger.warn(
        `[cdz-erpseq-pg] healed regressed counter (floor=${floorV} redis=${rNum} → ${jumped}) key=${key}`
      );
      return jumped;
    } catch (err) {
      this.logger.error(
        `[cdz-erpseq-pg] REFUSING potential duplicate (floor=${floorV} >= redis=${rNum}, heal failed: ${String(
          (err as Error)?.message ?? err
        ).slice(0, 120)}) key=${key}`
      );
      throw new BadRequest(
        'Numérotation momentanément indisponible — réessayez'
      );
    }
  }

  /**
   * WSE-2 — POST /api/v1/apps/:slug/erp/invoices/:id/validate (auth'd, owner).
   * Assigns the gap-less legal number AT VALIDATION (Redis INCR; with
   * CDZ_ERPSEQ_PG on, PG max-merge floors it — see erpReserveSeq), stamps the
   * legal id `<type>-<year>-<seq>`, status→valide, and writes the NEW id via
   * PUT while removing the old draft record from the same partition. The seq is
   * reserved immediately before the write; a failed write does not retry the
   * INCR (documented gap-less contract). 409-style body on non-draft source.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/invoices/:id/validate')
  async erpValidateInvoice(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertInvoicingEnabled();
    await this.assertOwnsErpApp(user, slug);
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const found = await this.erpFindInvoice(slug, erpStr(id).trim());
    if (!found) {
      throw new NotFound('Invoice not found');
    }
    const draft = found.record;
    if (draft.status !== 'brouillon') {
      res
        .status(HttpStatus.CONFLICT)
        .json({ error: 'invoice_not_draft', status: draft.status });
      return;
    }
    // SEC-5: a facture must not receive a legal number while the seller's
    // mandatory identity fields are blank. Checked BEFORE the seq reservation
    // so a refusal never burns a gap-less number. Settings unreadable (data
    // API down) ⇒ typed 502, same contract as the settings routes — never a
    // silent pass. Same typed 400 body shape as every other invoice refusal.
    if (CDZ_ERP_SELLER_ID_ENFORCE && draft.type === 'facture') {
      const settingsRows = await this.erpList(slug, 'settings');
      if (!settingsRows) {
        res
          .status(HttpStatus.BAD_GATEWAY)
          .json({ error: 'data_api_unavailable' });
        return;
      }
      const settingsRow =
        settingsRows.find(r => erpStr(r.key) === 'settings') ?? settingsRows[0];
      const seller = checkSellerIdentity(settingsRow);
      if (!seller.ok) {
        this.erpInvoiceBadInput(res, seller.reason, seller.field);
        return;
      }
    }
    const { timbreRate } = this.erpInvoiceOptions();
    // Reserve the gap-less number ONLY now, right before persisting. Routed
    // through erpReserveSeq: legacy Redis INCR when CDZ_ERPSEQ_PG is off,
    // PG-floored max-merge when on (same clamp semantics as reserveInvoiceSeq).
    const seq = await this.erpReserveSeq(
      invoiceSeqKey(slug, draft.type as InvoiceType, Number(draft.year)),
      slug,
      String(draft.type),
      Number(draft.year)
    );
    const validated = applyValidation(draft, seq, timbreRate);
    if (!validated.ok) {
      this.erpInvoiceBadInput(res, validated.reason, validated.field);
      return;
    }
    const record = validated.record;
    if (
      Buffer.byteLength(JSON.stringify(record), 'utf8') > ERP_MAX_WRITE_BYTES
    ) {
      throw new BadRequest('Invoice record too large');
    }
    // Write the validated record at its NEW legal id (atomic PUT). Then remove
    // the old draft id from the same partition (best-effort; the validated doc
    // is authoritative once written).
    const put = await this.erpInvoicePut(
      slug,
      found.collection,
      String(record.id),
      record as unknown as ErpRecord,
      token
    );
    if (!put.ok) {
      // Do NOT retry the INCR — the reserved number is consumed. Surface the
      // write failure; the (rare) burned number is the documented gap-less cost.
      this.erpWriteFailed(res, put.status);
      return;
    }
    if (String(record.id) !== String(draft.id)) {
      await this.erpDeleteRecord(slug, found.collection, String(draft.id), token);
    }
    this.logger.log(
      `[erp] invoice validate slug=${slug} user=${user.id} ${draft.id} -> ${record.id}`
    );
    return { ok: true, invoice: put.record };
  }

  /**
   * WSE-2 — POST /api/v1/apps/:slug/erp/invoices/:id/void (auth'd, owner-only).
   * Marks the document `annule` in place (a validated legal doc is NEVER
   * deleted — its number stays accounted-for). Atomic PUT at the same id.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/invoices/:id/void')
  async erpVoidInvoice(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertInvoicingEnabled();
    await this.assertOwnsErpApp(user, slug);
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const found = await this.erpFindInvoice(slug, erpStr(id).trim());
    if (!found) {
      throw new NotFound('Invoice not found');
    }
    const voided = applyVoid(found.record);
    if (!voided.ok) {
      res
        .status(HttpStatus.CONFLICT)
        .json({ error: 'invoice_already_void' });
      return;
    }
    const record = voided.record;
    const put = await this.erpInvoicePut(
      slug,
      found.collection,
      String(record.id),
      record as unknown as ErpRecord,
      token
    );
    if (!put.ok) {
      this.erpWriteFailed(res, put.status);
      return;
    }
    this.logger.log(
      `[erp] invoice void slug=${slug} user=${user.id} id=${record.id}`
    );
    return { ok: true, invoice: put.record };
  }

  /**
   * WSE-2 — POST /api/v1/apps/:slug/erp/invoices/:id/convert (auth'd, owner).
   * BODY `{ to }` — devis→bl→facture (or the legal skip devis→facture). Mints a
   * NEW DRAFT (seq 0, brouillon) carrying the source lines + customer + orderRef
   * and recording `convertedFrom`. The new doc gets its own gap-less number
   * only when it is later validated. Atomic PUT of the new draft.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/invoices/:id/convert')
  async erpConvertInvoice(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    this.assertInvoicingEnabled();
    await this.assertOwnsErpApp(user, slug);
    const opts = this.erpInvoiceOptions();
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const found = await this.erpFindInvoice(slug, erpStr(id).trim());
    if (!found) {
      throw new NotFound('Invoice not found');
    }
    const draftId = this.erpDraftId();
    const built = buildConversion(found.record, body?.to, draftId, opts);
    if (!built.ok) {
      // illegal_conversion / source_void are conflicts; the rest are 400s.
      if (built.reason === 'illegal_conversion' || built.reason === 'source_void') {
        res
          .status(HttpStatus.CONFLICT)
          .json({ error: 'invoice_convert_conflict', reason: built.reason });
        return;
      }
      this.erpInvoiceBadInput(res, built.reason, built.field);
      return;
    }
    const record = built.record;
    if (
      Buffer.byteLength(JSON.stringify(record), 'utf8') > ERP_MAX_WRITE_BYTES
    ) {
      throw new BadRequest('Invoice record too large');
    }
    const collection = invoiceCollectionForDate(String(record.date));
    const put = await this.erpInvoicePut(
      slug,
      collection,
      draftId,
      record as unknown as ErpRecord,
      token
    );
    if (!put.ok) {
      this.erpWriteFailed(res, put.status);
      return;
    }
    this.logger.log(
      `[erp] invoice convert slug=${slug} user=${user.id} ${found.record.id}(${found.record.type}) -> ${record.type} ${record.id}`
    );
    return { ok: true, invoice: put.record };
  }

  // =========================================================================
  // R2-b (WSE-4) — SUPPLIERS + PURCHASE ORDERS (procurement). Every route is
  // authed (@CurrentUser via the global AuthGuard) + owner-gated
  // (assertOwnsErpApp) and reuses the SAME erpList / erpCreateRecord /
  // erpApplyStockRollup helpers + the re-derived per-slug write token as the
  // inventory v2 routes above. Suppliers/POs are written at their business-key
  // id via the WSE-1 PUT-upsert primitive (data POST would clobber the id).
  // RECEIVING posts stock through the EXISTING movements-YYYYMM ledger — the
  // exact record shape + roll-up as POST /erp/inventory/movement. Pure shaping /
  // receive math lives in clickdz-erp-procurement.ts. No env gate (reference
  // data is harmless; plan WSE-4 specifies none). Typed errors / passthrough.
  // =========================================================================

  /** Normalize a stored supplier row to the pinned public shape. */
  private erpSupplierView(s: ErpRecord) {
    return {
      id: erpStr(s.id),
      name: erpStr(s.name),
      phone: erpStr(s.phone),
      ...(erpStr(s.email) ? { email: erpStr(s.email) } : {}),
      ...(erpStr(s.address) ? { address: erpStr(s.address) } : {}),
      balance: Math.round(erpNum(s.balance)),
      active: s.active !== false,
      createdAt: erpStr(s.createdAt),
    };
  }

  /**
   * R2-b — GET /api/v1/apps/:slug/erp/suppliers (auth'd, owner-only).
   * Lists the `suppliers` reference collection (newest-first, ≤500).
   */
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/suppliers')
  async erpSuppliers(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const rows = await this.erpList(slug, 'suppliers');
    if (!rows) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    return { suppliers: rows.map(s => this.erpSupplierView(s)) };
  }

  /**
   * R2-b — POST /api/v1/apps/:slug/erp/suppliers (auth'd, owner-only).
   * BODY `{ supplier }` — upsert a supplier by its kebab-slug business key
   * (derived from the name). Existing fields are preserved on a partial edit
   * (balance/createdAt never wiped). Written IN PLACE via the v2 PUT-upsert.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/suppliers')
  async erpCreateSupplier(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const raw = body?.supplier;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequest('"supplier" must be an object');
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res.status(HttpStatus.NOT_IMPLEMENTED).json({ error: 'admin_writes_unavailable' });
      return;
    }
    const existing = await this.erpList(slug, 'suppliers');
    if (!existing) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const built = buildSupplierRecord(raw);
    if (!built.ok) {
      throw new BadRequest('"supplier" needs a "name"');
    }
    const prior = existing.find(s => erpStr(s.id) === built.id);
    const merged = buildSupplierRecord(raw, prior);
    if (!merged.ok) {
      throw new BadRequest('"supplier" needs a "name"');
    }
    if (Buffer.byteLength(JSON.stringify(merged.record), 'utf8') > ERP_MAX_WRITE_BYTES) {
      throw new BadRequest('Supplier record too large');
    }
    const wrote = await putErpRecord(
      this.erpDataBase(slug),
      'suppliers',
      merged.id,
      merged.record,
      token
    );
    if (!wrote.ok) {
      this.erpWriteFailed(res, wrote.status);
      return;
    }
    this.logger.log(`[erp] supplier upsert slug=${slug} user=${user.id} id=${merged.id}`);
    return { ok: true, supplier: this.erpSupplierView(wrote.record) };
  }

  /**
   * R2-b — PUT /api/v1/apps/:slug/erp/suppliers/:id (auth'd, owner-only).
   * In-place edit of an existing supplier by id. BODY `{ supplier }`. Absent
   * fields are preserved; the id in the path is authoritative (renaming a
   * supplier keeps the same id — its business key is stable).
   */
  @Throttle('strict')
  @Put('/api/v1/apps/:slug/erp/suppliers/:id')
  async erpUpdateSupplier(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const sid = erpStr(id).trim();
    if (!sid) throw new BadRequest('"id" is required');
    const raw = body?.supplier;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequest('"supplier" must be an object');
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res.status(HttpStatus.NOT_IMPLEMENTED).json({ error: 'admin_writes_unavailable' });
      return;
    }
    const existing = await this.erpList(slug, 'suppliers');
    if (!existing) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const prior = existing.find(s => erpStr(s.id) === sid);
    if (!prior) throw new NotFound('Supplier not found');
    // Force the stored name when the body omits one so the id (kebab of name)
    // stays pinned to the existing record even on a phone/address-only edit.
    const patchBody = { ...raw } as Record<string, unknown>;
    if (patchBody.name === undefined) patchBody.name = prior.name;
    const merged = buildSupplierRecord(patchBody, prior);
    if (!merged.ok) throw new BadRequest('"supplier" needs a "name"');
    // Keep the caller's original id (path) as authoritative.
    merged.record.id = sid;
    if (Buffer.byteLength(JSON.stringify(merged.record), 'utf8') > ERP_MAX_WRITE_BYTES) {
      throw new BadRequest('Supplier record too large');
    }
    const wrote = await putErpRecord(
      this.erpDataBase(slug),
      'suppliers',
      sid,
      merged.record,
      token
    );
    if (!wrote.ok) {
      this.erpWriteFailed(res, wrote.status);
      return;
    }
    this.logger.log(`[erp] supplier update slug=${slug} user=${user.id} id=${sid}`);
    return { ok: true, supplier: this.erpSupplierView(wrote.record) };
  }

  /**
   * R2-b — GET /api/v1/apps/:slug/erp/purchase-orders (auth'd, owner-only).
   * Lists the `purchase-orders` collection (newest-first, ≤500).
   */
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/purchase-orders')
  async erpPurchaseOrders(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const rows = await this.erpList(slug, 'purchase-orders');
    if (!rows) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    return { purchaseOrders: rows };
  }

  /**
   * R2-b — GET /api/v1/apps/:slug/erp/purchase-orders/:id (auth'd, owner-only).
   */
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/purchase-orders/:id')
  async erpPurchaseOrder(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const pid = erpStr(id).trim();
    if (!pid) throw new BadRequest('"id" is required');
    const rows = await this.erpList(slug, 'purchase-orders');
    if (!rows) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const po = rows.find(r => erpStr(r.id) === pid);
    if (!po) throw new NotFound('Purchase order not found');
    return { purchaseOrder: po };
  }

  /**
   * R2-b — POST /api/v1/apps/:slug/erp/purchase-orders (auth'd, owner-only).
   * BODY `{ supplierId, lines:[{productId?, label, qty, unitCost}], date?,
   * status?, warehouseId?, note? }`. Mints a gap-less id `po-<year>-<seq>` via
   * Redis INCR, then writes the record IN PLACE at that id via PUT-upsert.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/purchase-orders')
  async erpCreatePurchaseOrder(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const supplierId = erpStr(body?.supplierId).trim();
    if (!supplierId) throw new BadRequest('"supplierId" is required');
    const lines = normalizePoLines(body?.lines);
    if (!lines) throw new BadRequest('"lines" must be a non-empty array (max 100)');
    const token = dataWriteToken(slug);
    if (!token) {
      res.status(HttpStatus.NOT_IMPLEMENTED).json({ error: 'admin_writes_unavailable' });
      return;
    }
    // Supplier must exist (a PO is always against a known supplier).
    const suppliers = await this.erpList(slug, 'suppliers');
    if (!suppliers) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    if (!suppliers.some(s => erpStr(s.id) === supplierId)) {
      throw new NotFound('Supplier not found');
    }
    // Gap-less numbering: reserve the seq only after a successful write would be
    // rare to fail here, but the reserve is atomic so numbers are monotonic per
    // year (Redis INCR; PG-floored via erpReserveSeq when CDZ_ERPSEQ_PG is on).
    const year = new Date().getUTCFullYear();
    const seq = await this.erpReserveSeq(
      procPoSeqKey(slug, year),
      slug,
      'po',
      year
    );
    const built = buildPoRecord({
      id: procPoId(year, seq),
      supplierId,
      date: body?.date,
      status: body?.status,
      lines,
      warehouseId: body?.warehouseId,
      note: body?.note,
    });
    if (!built.ok) {
      throw new BadRequest('Invalid purchase order');
    }
    if (Buffer.byteLength(JSON.stringify(built.record), 'utf8') > ERP_MAX_WRITE_BYTES) {
      throw new BadRequest('Purchase order too large (reduce lines/note)');
    }
    const wrote = await putErpRecord(
      this.erpDataBase(slug),
      'purchase-orders',
      erpStr(built.record.id),
      built.record,
      token
    );
    if (!wrote.ok) {
      this.erpWriteFailed(res, wrote.status);
      return;
    }
    this.logger.log(
      `[erp] po create slug=${slug} user=${user.id} id=${erpStr(built.record.id)} lines=${lines.length}`
    );
    return { ok: true, purchaseOrder: wrote.record };
  }

  /**
   * R2-b — POST /api/v1/apps/:slug/erp/purchase-orders/:id/receive (owner-only).
   * BODY `{ lines:[{label|productId, qty}], warehouseId? }` (empty lines ⇒
   * receive ALL outstanding). Computes the receive (clickdz-erp-procurement),
   * then posts stock through the EXISTING movements ledger: one positive
   * 'purchase' movement per received line into the current-month
   * `movements-YYYYMM` partition via erpCreateRecord, recomputes each affected
   * product's roll-up via erpApplyStockRollup, updates the PO in place, and
   * bumps the supplier balance by the received cost.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/purchase-orders/:id/receive')
  async erpReceivePurchaseOrder(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const pid = erpStr(id).trim();
    if (!pid) throw new BadRequest('"id" is required');
    const token = dataWriteToken(slug);
    if (!token) {
      res.status(HttpStatus.NOT_IMPLEMENTED).json({ error: 'admin_writes_unavailable' });
      return;
    }
    // H1 BUG4: serialize concurrent receives on the SAME PO with a Redis SETNX
    // lock. Without this, two concurrent receive calls on the same PO both
    // read the same qtyReceived, both compute the same outstanding qty, both
    // write movements, and the PO gets double-incremented. The lock is
    // fail-open on a Redis error (a receive should not be blocked by a Redis
    // outage) but we log the failure. TTL 30s auto-heals a crashed holder.
    const poReceiveLockKey = `clickdz:erp:po-receive:${slug}:${pid}`;
    let poReceiveLocked = false;
    try {
      const acquired = await this.redis.set(
        poReceiveLockKey,
        new Date().toISOString(),
        'EX',
        30,
        'NX'
      );
      poReceiveLocked = acquired === 'OK';
      if (!poReceiveLocked) {
        this.logger.warn(
          `[erp] po-receive lock contention slug=${slug} id=${pid} — another receive in progress`
        );
        res
          .status(HttpStatus.CONFLICT)
          .json({ error: 'po_receive_in_progress', poId: pid });
        return;
      }
    } catch (lockErr) {
      // Redis down — fail open (proceed unlocked) but log.
      this.logger.warn(
        `[erp] po-receive lock unavailable slug=${slug} id=${pid}: ${String((lockErr as Error)?.message || lockErr).slice(0, 120)}`
      );
    }
    try {
    const [pos, warehouses] = await Promise.all([
      this.erpList(slug, 'purchase-orders'),
      this.erpList(slug, 'warehouses'),
    ]);
    if (!pos || !warehouses) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const po = pos.find(r => erpStr(r.id) === pid);
    if (!po) throw new NotFound('Purchase order not found');
    const result = computeReceive(po, {
      lines: body?.lines,
      warehouseId: body?.warehouseId,
    });
    if (!result.ok) {
      if (result.reason === 'not_receivable') {
        throw new BadRequest('Purchase order is not receivable (cancelled or fully received)');
      }
      if (result.reason === 'no_warehouse') {
        throw new BadRequest('"warehouseId" is required (none on the PO)');
      }
      if (result.reason === 'nothing_to_receive') {
        throw new BadRequest('Nothing to receive (no outstanding matching line qty)');
      }
      throw new BadRequest('Invalid receive request');
    }
    // The target warehouse must exist (movements into an unknown warehouse are a
    // client bug — same rule as POST /erp/inventory/movement).
    const targetWh = erpStr(result.po.warehouseId).trim();
    if (targetWh && !warehouses.some(w => erpStr(w.id) === targetWh)) {
      throw new NotFound('Warehouse not found');
    }
    // WS17: persist the updated PO FIRST (incremented qtyReceived + new status),
    // BEFORE appending movements. This makes a retry idempotent: computeReceive
    // derives movements from `actuallyTaken = newQtyReceived - oldQtyReceived`,
    // so a retry that re-reads the already-incremented PO computes outstanding=0
    // for received lines and produces NO duplicate movements. The prior order
    // (movements first, PO last) left already-written movements in the ledger on
    // a mid-loop failure, and a retry re-received ALL lines -> inflated stock.
    if (Buffer.byteLength(JSON.stringify(result.po), 'utf8') > ERP_MAX_WRITE_BYTES) {
      throw new BadRequest('Purchase order too large after receive');
    }
    const poWrote = await putErpRecord(
      this.erpDataBase(slug),
      'purchase-orders',
      pid,
      result.po,
      token
    );
    if (!poWrote.ok) {
      this.erpWriteFailed(res, poWrote.status);
      return;
    }
    // H1 BUG4: track which movements have been SUCCESSFULLY written so we can
    // compensate on a mid-loop failure. If a movement write fails after some
    // movements already landed, the PO says received but the stock ledger is
    // missing movements — a retry can't fix it (computeReceive sees the
    // already-incremented qtyReceived and produces 0 outstanding). The
    // compensation writes inverse-delta movements for each succeeded movement,
    // reverts the PO to its pre-receive state, and returns the error.
    const collection = erpMovementCollection();
    const succeededMovements: { productKey: string; warehouseId: string; delta: number }[] = [];
    for (const mv of result.movements) {
      if (Buffer.byteLength(JSON.stringify(mv), 'utf8') > ERP_MAX_WRITE_BYTES) {
        // Compensation: this is a client bug (oversized record), not a data API
        // failure. Revert the PO and compensate any movements already written.
        await this.compensatePoReceive(
          slug,
          pid,
          po,
          collection,
          succeededMovements,
          token
        );
        throw new BadRequest('Movement record too large');
      }
      const created = await this.erpCreateRecord(slug, collection, mv as unknown as ErpRecord, token);
      if (!created.ok) {
        // H1 BUG4: a movement write failed mid-loop. Write compensating negative
        // movements for each SUCCEEDED movement, revert the PO to its pre-receive
        // value, log the compensation, and surface the error.
        this.logger.error(
          `[erp] po-receive movement write FAILED slug=${slug} poId=${pid} ` +
            `succeeded=${succeededMovements.length}/${result.movements.length} ` +
            `status=${created.status} — compensating + reverting PO`
        );
        await this.compensatePoReceive(
          slug,
          pid,
          po,
          collection,
          succeededMovements,
          token
        );
        this.erpWriteFailed(res, created.status);
        return;
      }
      succeededMovements.push(mv);
    }
    // Recompute + persist each affected product's roll-up from the ledger (now
    // including the just-appended movements) — reuses erpApplyStockRollup. This
    // is self-correcting on retry: it reads the FULL ledger and recomputes, so a
    // partial-failure retry produces the correct stock regardless of which
    // movements already landed.
    if (result.movements.length > 0) {
      const { totals } = await this.erpReadMovements(slug, ERP_MOVEMENT_MONTHS_READ);
      for (const key of Object.keys(result.receivedByKey)) {
        const newStock = Math.max(0, Math.round(totals.get(key) ?? 0));
        await this.erpApplyStockRollup(slug, key, newStock, token);
      }
    }
    // Bump the supplier balance by the received cost (we now owe more).
    // H2 BUG5: use a dedicated Redis HINCRBY counter for atomic balance updates,
    // then sync the counter value back to the supplier record. This eliminates
    // the lost-update race where two concurrent receives both read the same
    // stale balance and the last PUT wins (losing one delta).
    let supplierBalance: number | undefined;
    if (result.receivedCost > 0) {
      const supplierId = erpStr(po.supplierId).trim();
      if (supplierId) {
        supplierBalance = await this.atomicSupplierBalanceDelta(
          slug,
          supplierId,
          result.receivedCost,
          token
        );
      }
    }
    this.logger.log(
      `[erp] po receive slug=${slug} user=${user.id} id=${pid} movements=${result.movements.length} status=${result.nextStatus} cost=${result.receivedCost}`
    );
    return {
      ok: true,
      purchaseOrder: poWrote.record,
      movements: result.movements.length,
      ...(supplierBalance !== undefined ? { supplierBalance } : {}),
    };
    } finally {
      // H1: release the per-PO receive lock.
      if (poReceiveLocked) {
        try {
          await this.redis.del(poReceiveLockKey);
        } catch {
          // Lock expires on its own; nothing to do.
        }
      }
    }
  }

  /**
   * H1 BUG4 — compensate a partially-failed PO receive by writing inverse-delta
   * movements for each SUCCEEDED movement and reverting the PO to its
   * pre-receive state. Best-effort: if a compensating movement write also fails,
   * it is logged but does not block the PO revert (the ledger is the source of
   * truth and the stock roll-up is self-correcting on the next read).
   */
  private async compensatePoReceive(
    slug: string,
    poId: string,
    originalPo: ErpRecord,
    collection: string,
    succeededMovements: { productKey: string; warehouseId: string; delta: number }[],
    token: string
  ): Promise<void> {
    // (a) Write compensating negative movements for each succeeded movement.
    for (const mv of succeededMovements) {
      const compMovement: ErpRecord = {
        ts: new Date().toISOString(),
        productKey: mv.productKey,
        warehouseId: mv.warehouseId,
        delta: -Math.abs(mv.delta),
        reason: 'adjust' as ErpMovementReason,
        ref: `receive_reversal:${poId}`,
      };
      try {
        const comp = await this.erpCreateRecord(
          slug,
          collection,
          compMovement,
          token
        );
        if (!comp.ok) {
          this.logger.error(
            `[erp] po-receive COMPENSATION movement write FAILED slug=${slug} ` +
              `poId=${poId} productKey=${mv.productKey.slice(0, 40)} ` +
              `warehouseId=${mv.warehouseId} delta=${-Math.abs(mv.delta)} status=${comp.status}`
          );
        }
      } catch (e) {
        this.logger.error(
          `[erp] po-receive COMPENSATION error slug=${slug} poId=${poId}: ${String((e as Error)?.message || e).slice(0, 200)}`
        );
      }
    }
    // (b) Revert the PO to its pre-receive value.
    try {
      const reverted = await putErpRecord(
        this.erpDataBase(slug),
        'purchase-orders',
        poId,
        originalPo,
        token
      );
      if (!reverted.ok) {
        this.logger.error(
          `[erp] po-receive PO REVERT FAILED slug=${slug} poId=${poId} status=${reverted.status} ` +
            `— PO may show received but movements were compensated; manual cleanup needed`
        );
      } else {
        this.logger.log(
          `[erp] po-receive compensated slug=${slug} poId=${poId} ` +
            `movementsReverted=${succeededMovements.length} poReverted=true`
        );
      }
    } catch (e) {
      this.logger.error(
        `[erp] po-receive PO REVERT error slug=${slug} poId=${poId}: ${String((e as Error)?.message || e).slice(0, 200)}`
      );
    }
    // (c) Recompute stock roll-ups for affected products so the product.stock
    // snapshot reflects the compensated (net-zero) ledger.
    if (succeededMovements.length > 0) {
      try {
        const { totals } = await this.erpReadMovements(slug, ERP_MOVEMENT_MONTHS_READ);
        const affectedKeys = new Set(succeededMovements.map(m => m.productKey));
        for (const key of affectedKeys) {
          const newStock = Math.max(0, Math.round(totals.get(key) ?? 0));
          await this.erpApplyStockRollup(slug, key, newStock, token);
        }
      } catch {
        // Best-effort — the ledger is the source of truth.
      }
    }
  }

  /**
   * H2 BUG5 — atomically increment a supplier's balance using a dedicated Redis
   * counter key (HINCRBY is atomic). The counter is the source of truth; the
   * supplier record's `balance` field is a denormalized snapshot synced
   * best-effort. On first use for a supplier, the counter is initialized from
   * the current record balance via SETNX (so HINCRBY starts from the right
   * base). Returns the new balance after the increment, or undefined on failure.
   */
  private async atomicSupplierBalanceDelta(
    slug: string,
    supplierId: string,
    delta: number,
    token: string
  ): Promise<number | undefined> {
    const balanceKey = `clickdz:erp:supplier-balance:${slug}:${supplierId}`;
    try {
      // SETNX: if the counter doesn't exist yet, initialize it from the current
      // record balance. Returns 1 if it set (first time) or 0 if it already
      // existed — either way the counter is correct after this.
      const freshSuppliers = await this.erpList(slug, 'suppliers');
      const freshSupplier = freshSuppliers?.find(
        s => erpStr(s.id) === supplierId
      );
      if (freshSupplier) {
        const currentBalance = Math.round(erpNum(freshSupplier.balance));
        await this.redis.set(balanceKey, String(currentBalance), 'NX');
      }
      // HINCRBY is atomic — no lost update possible even under concurrency.
      // The counter is a plain Redis string key holding an integer; SETNX above
      // initializes it, and INCRBY atomically increments it.
      const newBalance = await this.redis.incrby(balanceKey, delta);
      const roundedBalance = Math.round(Number(newBalance) || 0);
      // Sync the counter value back to the supplier record (best-effort
      // snapshot). The counter is the source of truth.
      if (freshSupplier) {
        const updated = applySupplierBalanceDelta(freshSupplier, 0);
        updated.balance = roundedBalance;
        await putErpRecord(
          this.erpDataBase(slug),
          'suppliers',
          supplierId,
          updated,
          token
        );
      }
      this.logger.log(
        `[erp] supplier-balance atomic delta slug=${slug} supplierId=${supplierId} ` +
          `delta=${delta} newBalance=${roundedBalance}`
      );
      return roundedBalance;
    } catch (e) {
      // Fallback to the old read-modify-write path if Redis is down.
      this.logger.warn(
        `[erp] supplier-balance HINCRBY failed, falling back to read-modify-write ` +
          `slug=${slug} supplierId=${supplierId}: ${String((e as Error)?.message || e).slice(0, 120)}`
      );
      try {
        const fs = await this.erpList(slug, 'suppliers');
        const fSup = fs?.find(s => erpStr(s.id) === supplierId);
        if (fSup) {
          const updated = applySupplierBalanceDelta(fSup, delta);
          const sw = await putErpRecord(
            this.erpDataBase(slug),
            'suppliers',
            supplierId,
            updated,
            token
          );
          if (sw.ok) return Math.round(erpNum(sw.record.balance));
        }
      } catch {
        // Both Redis and data API are down — nothing more we can do.
      }
      return undefined;
    }
  }

  /**
   * R2-b — POST /api/v1/apps/:slug/erp/purchase-orders/:id/cancel (owner-only).
   * Cancels a 'brouillon'/'commande' PO (sets status 'annule'). A PO that has
   * already received stock is NOT cancellable (append-only ledger — reverse via
   * a manual negative movement instead). Written in place via PUT-upsert.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/purchase-orders/:id/cancel')
  async erpCancelPurchaseOrder(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const pid = erpStr(id).trim();
    if (!pid) throw new BadRequest('"id" is required');
    const token = dataWriteToken(slug);
    if (!token) {
      res.status(HttpStatus.NOT_IMPLEMENTED).json({ error: 'admin_writes_unavailable' });
      return;
    }
    const pos = await this.erpList(slug, 'purchase-orders');
    if (!pos) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const po = pos.find(r => erpStr(r.id) === pid);
    if (!po) throw new NotFound('Purchase order not found');
    const result = computeCancel(po);
    if (!result.ok) {
      throw new BadRequest('Purchase order cannot be cancelled (already received or cancelled)');
    }
    const wrote = await putErpRecord(
      this.erpDataBase(slug),
      'purchase-orders',
      pid,
      result.po,
      token
    );
    if (!wrote.ok) {
      this.erpWriteFailed(res, wrote.status);
      return;
    }
    this.logger.log(`[erp] po cancel slug=${slug} user=${user.id} id=${pid}`);
    return { ok: true, purchaseOrder: wrote.record };
  }

  // ===========================================================================
  // WSE-6 (ROUTIER) — LIVRAISON: couriers + 58-wilaya shipping matrix + order
  // courier-assignment / tracking. Owner-only (assertOwnsErpApp). Reuses
  // erpList / erpCreateRecord / erpDeleteRecord + the re-derived per-slug write
  // token; logic delegated to ./clickdz-erp-shipping (imported as `Shipping`).
  // Collections: `couriers`, `shipping-rates` (both unpartitioned reference
  // data). Tracking is a SUB-state written on the `orders` record.
  // ===========================================================================

  /**
   * PUT one record IN PLACE via the data API's atomic upsert (v2 PUT-by-id),
   * using the re-derived per-slug write token (Bearer). Unlike delete+recreate,
   * this preserves the record's id + createdAt — required for order edits whose
   * server-generated id other data may reference. status 0 = unreachable.
   */
  private async erpPutRecord(
    slug: string,
    collection: string,
    id: string,
    record: ErpRecord,
    token: string
  ): Promise<{ ok: true; record: ErpRecord } | { ok: false; status: number }> {
    const res = await fetch(
      `${this.erpDataBase(slug)}/${collection}/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(ERP_DATA_TIMEOUT_MS),
      }
    ).catch(() => null);
    if (!res || !res.ok) {
      const status = res ? res.status : 0;
      this.logger.warn(
        `[erp] put failed slug=${slug} coll=${collection} id=${id} status=${status || 'unreachable'}`
      );
      return { ok: false, status };
    }
    const saved = (await res.json().catch(() => null)) as ErpRecord | null;
    return { ok: true, record: saved ?? record };
  }

  /**
   * WSE-6 — GET /api/v1/apps/:slug/erp/shipping/wilayas (owner-only).
   * The canonical 58-wilaya table (single server-side source). No write token
   * needed — pure reference data.
   */
  @Get('/api/v1/apps/:slug/erp/shipping/wilayas')
  async erpShippingWilayas(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string
  ) {
    await this.assertOwnsErpApp(user, slug);
    return { wilayas: Shipping.WILAYAS };
  }

  /** WSE-6 — GET /api/v1/apps/:slug/erp/couriers (owner-only). */
  @Get('/api/v1/apps/:slug/erp/couriers')
  async erpCouriersList(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const couriers = await this.erpList(slug, 'couriers');
    if (!couriers) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    return { couriers };
  }

  /**
   * WSE-6 — POST /api/v1/apps/:slug/erp/couriers (owner-only). Create a courier
   * (pinned shape). Id is derived kebab-case from name (or a supplied valid id).
   * Rejects a duplicate id (409) so the business key stays unique.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/couriers')
  async erpCourierCreate(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const built = Shipping.buildCourierRecord(
      body,
      new Date().toISOString()
    );
    if (!built.ok) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'invalid_courier', field: built.field });
      return;
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res.status(HttpStatus.NOT_IMPLEMENTED).json({ error: 'admin_writes_unavailable' });
      return;
    }
    const existing = await this.erpList(slug, 'couriers');
    if (!existing) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    if (existing.some(c => erpStr(c.id) === built.courier.id)) {
      res.status(HttpStatus.CONFLICT).json({ error: 'courier_exists', id: built.courier.id });
      return;
    }
    // WS17: use PUT-by-id (not POST) so the courier's business-key id is
    // preserved. erpCreateRecord (POST) overwrites the body's id with a random
    // UUID, after which no lookup by business-key id can match (update, assign,
    // duplicate guard all fail). Mirrors suppliers (line 6138) and POs (6315).
    const created = await putErpRecord(
      this.erpDataBase(slug),
      'couriers',
      built.courier.id,
      built.courier as unknown as ErpRecord,
      token
    );
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    this.logger.log(`[erp] courier create slug=${slug} user=${user.id} id=${built.courier.id}`);
    return { ok: true, courier: created.record };
  }

  /**
   * WSE-6 — PUT /api/v1/apps/:slug/erp/couriers/:id (owner-only). Update a
   * courier in place (id + createdAt immutable). Uses PUT-by-id upsert.
   */
  @Throttle('strict')
  @Put('/api/v1/apps/:slug/erp/couriers/:id')
  async erpCourierUpdate(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    if (!Shipping.isValidCourierId(id)) {
      throw new BadRequest('Invalid courier id');
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res.status(HttpStatus.NOT_IMPLEMENTED).json({ error: 'admin_writes_unavailable' });
      return;
    }
    const couriers = await this.erpList(slug, 'couriers');
    if (!couriers) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const found = couriers.find(c => erpStr(c.id) === id);
    if (!found) throw new NotFound('Courier not found');
    const merged = Shipping.mergeCourierPatch(found, body);
    if (!merged.ok) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'invalid_courier', field: merged.field });
      return;
    }
    // The stored record's data-API id is the same business id we PUT by.
    const recId = erpStr(found.id);
    const saved = await this.erpPutRecord(slug, 'couriers', recId, merged.courier as unknown as ErpRecord, token);
    if (!saved.ok) {
      this.erpWriteFailed(res, saved.status);
      return;
    }
    this.logger.log(`[erp] courier update slug=${slug} user=${user.id} id=${id}`);
    return { ok: true, courier: saved.record };
  }

  /**
   * WSE-6 — GET /api/v1/apps/:slug/erp/shipping/rates?courierId= (owner-only).
   * Returns the dense 58-row matrix for the courier (missing rows → null fees).
   */
  @Get('/api/v1/apps/:slug/erp/shipping/rates')
  async erpShippingRates(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Query('courierId') courierId: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const cid = erpStr(courierId).trim().toLowerCase();
    if (!Shipping.isValidCourierId(cid)) {
      throw new BadRequest('"courierId" query param is required');
    }
    const rows = await this.erpList(slug, 'shipping-rates');
    if (!rows) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    return { courierId: cid, matrix: Shipping.exportMatrix(rows, cid) };
  }

  /**
   * WSE-6 — POST /api/v1/apps/:slug/erp/shipping/rates (owner-only). Bulk-set a
   * courier's rate matrix. BODY `{ courierId, rates: [{wilaya, fee?, homeFee?,
   * deskFee?}] }`. Each rate → one `<courierId>:<wilayaCode>` record, written
   * in place (PUT-by-id upsert) so re-setting a wilaya just overwrites its row.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/shipping/rates')
  async erpShippingRatesSet(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const cid = erpStr(body?.courierId).trim().toLowerCase();
    const built = Shipping.buildBulkRates(cid, body?.rates);
    if (!built.ok) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: built.error, ...(built.wilaya ? { wilaya: built.wilaya } : {}) });
      return;
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res.status(HttpStatus.NOT_IMPLEMENTED).json({ error: 'admin_writes_unavailable' });
      return;
    }
    let written = 0;
    for (const rec of built.records) {
      const saved = await this.erpPutRecord(slug, 'shipping-rates', rec.id, rec as unknown as ErpRecord, token);
      if (!saved.ok) {
        this.erpWriteFailed(res, saved.status);
        return;
      }
      written++;
    }
    this.logger.log(`[erp] rates set slug=${slug} user=${user.id} courier=${cid} rows=${written}`);
    return { ok: true, courierId: cid, written };
  }

  /**
   * WSE-6 — POST /api/v1/apps/:slug/erp/shipping/rates/import-csv (owner-only).
   * BODY `{ courierId, csv }`. Parses pasted `wilayaCode,fee,homeFee,deskFee`
   * lines (courier PDFs re-typed as CSV) and bulk-sets them like the JSON path.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/shipping/rates/import-csv')
  async erpShippingRatesImportCsv(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const cid = erpStr(body?.courierId).trim().toLowerCase();
    if (!Shipping.isValidCourierId(cid)) {
      throw new BadRequest('"courierId" is required');
    }
    const parsed = Shipping.parseRatesCsv(body?.csv);
    if (!parsed.ok) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: parsed.error, ...(parsed.line ? { line: parsed.line } : {}) });
      return;
    }
    const built = Shipping.buildBulkRates(cid, parsed.rows);
    if (!built.ok) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: built.error, ...(built.wilaya ? { wilaya: built.wilaya } : {}) });
      return;
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res.status(HttpStatus.NOT_IMPLEMENTED).json({ error: 'admin_writes_unavailable' });
      return;
    }
    let written = 0;
    for (const rec of built.records) {
      const saved = await this.erpPutRecord(slug, 'shipping-rates', rec.id, rec as unknown as ErpRecord, token);
      if (!saved.ok) {
        this.erpWriteFailed(res, saved.status);
        return;
      }
      written++;
    }
    this.logger.log(`[erp] rates import-csv slug=${slug} user=${user.id} courier=${cid} rows=${written} skipped=${parsed.skipped}`);
    return { ok: true, courierId: cid, written, skipped: parsed.skipped };
  }

  /**
   * WSE-6 — POST /api/v1/apps/:slug/erp/orders/:orderId/assign-courier
   * (owner-only). BODY `{ courierId, mode? }`. Writes courierId + deliveryMode
   * on the order record IN PLACE (PUT-by-id, id/createdAt preserved). Does not
   * move the order status. `:orderId` is the data-API record id.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/orders/:orderId/assign-courier')
  async erpOrderAssignCourier(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('orderId') orderId: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const built = Shipping.buildAssignPatch(body?.courierId, body?.mode, new Date().toISOString());
    if (!built.ok) {
      throw new BadRequest('"courierId" is required (a valid courier id)');
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res.status(HttpStatus.NOT_IMPLEMENTED).json({ error: 'admin_writes_unavailable' });
      return;
    }
    const orders = await this.erpList(slug, 'orders');
    if (!orders) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const order = orders.find(o => erpStr(o.id) === orderId);
    if (!order) throw new NotFound('Order not found');
    // Verify the courier exists so an order can't point at a phantom id.
    const couriers = await this.erpList(slug, 'couriers');
    if (couriers && !couriers.some(c => erpStr(c.id) === built.patch.courierId)) {
      throw new NotFound('Courier not found');
    }
    const merged: ErpRecord = { ...order, ...built.patch };
    delete (merged as any).createdAt; // upsert preserves the stored createdAt
    if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > ERP_MAX_WRITE_BYTES) {
      throw new BadRequest('Order record too large');
    }
    const saved = await this.erpPutRecord(slug, 'orders', orderId, merged, token);
    if (!saved.ok) {
      this.erpWriteFailed(res, saved.status);
      return;
    }
    this.logger.log(`[erp] assign-courier slug=${slug} user=${user.id} order=${orderId} courier=${built.patch.courierId}`);
    return { ok: true, order: saved.record };
  }

  /**
   * WSE-6 — POST /api/v1/apps/:slug/erp/orders/:orderId/tracking (owner-only).
   * BODY `{ status }` — one of pris-en-charge|en-route|livre|retour. Sets the
   * tracking sub-state AND advances the order's canonical status accordingly,
   * IN PLACE (PUT-by-id). `:orderId` is the data-API record id.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/orders/:orderId/tracking')
  async erpOrderTracking(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('orderId') orderId: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const built = Shipping.buildTrackingPatch(body?.status, new Date().toISOString());
    if (!built.ok) {
      throw new BadRequest(`"status" must be one of: ${Shipping.TRACKING_STATUSES.join(', ')}`);
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res.status(HttpStatus.NOT_IMPLEMENTED).json({ error: 'admin_writes_unavailable' });
      return;
    }
    const orders = await this.erpList(slug, 'orders');
    if (!orders) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const order = orders.find(o => erpStr(o.id) === orderId);
    if (!order) throw new NotFound('Order not found');
    const merged: ErpRecord = { ...order, ...built.patch };
    delete (merged as any).createdAt;
    if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > ERP_MAX_WRITE_BYTES) {
      throw new BadRequest('Order record too large');
    }
    const saved = await this.erpPutRecord(slug, 'orders', orderId, merged, token);
    if (!saved.ok) {
      this.erpWriteFailed(res, saved.status);
      return;
    }
    this.logger.log(`[erp] tracking slug=${slug} user=${user.id} order=${orderId} -> ${body?.status} (${built.orderStatus})`);
    return { ok: true, order: saved.record };
  }

  // =========================================================================
  // R2-d (WSE-8, TIROIR) — CAISSE (cash register) + COD RECONCILIATION.
  // Every route is authed (@CurrentUser via the global AuthGuard) + owner-gated
  // (assertOwnsErpApp) and reuses the SAME erpList/erpCreateRecord helpers +
  // re-derived per-slug write token as the sibling ERP routes. Money docs are
  // updated IN PLACE via the data API's native PUT upsert (never delete+recreate)
  // — a caisse entry must never vanish mid-edit. All logic (validation, money
  // math, partition names, reconcile, day-close) lives in ./clickdz-erp-caisse;
  // these are thin call sites. Typed errors / passthrough res only.
  // =========================================================================

  /**
   * Fail-soft delivered-COD hook (called from erpOrderStatus on a 'Livrée'
   * transition). Writes a pending-COD MARKER entry ('in'/'cod', pending:true,
   * amount = order total, tagged orderRef + courierId when present) into the
   * caisse partition for the order's delivery day, so day-close/reconcile know a
   * delivered order owes its COD. Idempotent (skips if a marker for the ref
   * already exists). NEVER throws — any failure is logged and swallowed so a
   * caisse hiccup can never break the status update. Returns nothing.
   */
  private async erpWritePendingCod(
    slug: string,
    order: ErpRecord,
    token: string
  ): Promise<void> {
    try {
      const built = buildPendingCodEntry(order as CaisseRecord);
      if (!built) return;
      const ref = caisseStr((built.entry as ErpRecord).orderRef);
      // MONEY-3: check EVERY partition the marker could already be in, not just
      // the one we are about to write to. Markers are filed by delivery month
      // now, but a courier poll that ran before anything stamped deliveredAt
      // filed by placement month — and markers are never cleaned up, so a
      // single-partition check would let the same COD be counted twice in
      // pendingCodTotal, permanently.
      if (ref) {
        for (const coll of pendingCodMarkerPartitions(order as CaisseRecord)) {
          const rows = await this.erpList(slug, coll);
          if (rows && hasPendingCodMarker(rows as CaisseRecord[], ref)) {
            return; // marker already present somewhere — stay idempotent
          }
        }
      }
      const created = await this.erpCreateRecord(
        slug,
        built.collection,
        built.entry as ErpRecord,
        token
      );
      if (created.ok) {
        this.logger.log(
          `[erp] caisse pending-COD slug=${slug} ref=${ref.slice(0, 40)} amount=${(built.entry as ErpRecord).amount}`
        );
      }
    } catch (e) {
      // Fail-soft: a delivered order must still advance even if caisse is down.
      this.logger.warn(
        `[erp] caisse pending-COD write skipped slug=${slug}: ${String((e as Error)?.message || e).slice(0, 120)}`
      );
    }
  }

  /**
   * R15 — mirror a just-settled Chargily online payment into the caisse ledger
   * as a real (non-pending) 'in'/'chargily' row, so day-close/reconcile counts
   * online revenue. Structurally identical to erpWritePendingCod: pure builder →
   * list → dedupe guard → create, fully fail-soft (a caisse hiccup must NEVER
   * regress the order's paid flip or the webhook 200 ack). Idempotent on orderRef.
   */
  private async erpWriteChargilyCaisse(
    slug: string,
    order: ErpRecord,
    token: string
  ): Promise<void> {
    try {
      const built = buildChargilyCaisseEntry(order as CaisseRecord);
      if (!built) return;
      const existing = await this.erpList(slug, built.collection);
      const ref = caisseStr((built.entry as ErpRecord).orderRef);
      if (
        existing &&
        ref &&
        hasChargilyCaisseEntry(existing as CaisseRecord[], ref)
      ) {
        return; // already posted — stay idempotent
      }
      const created = await this.erpCreateRecord(
        slug,
        built.collection,
        built.entry as ErpRecord,
        token
      );
      if (created.ok) {
        this.logger.log(
          `[pay] caisse chargily slug=${slug} ref=${ref.slice(0, 40)} amount=${(built.entry as ErpRecord).amount}`
        );
      }
    } catch (e) {
      // Fail-soft: an online payment stays 'paid' even if the caisse write hiccups.
      this.logger.warn(
        `[pay] caisse chargily write skipped slug=${slug}: ${String((e as Error)?.message || e).slice(0, 120)}`
      );
    }
  }

  /**
   * R2-d — GET /api/v1/apps/:slug/erp/caisse?month=YYYYMM (auth'd, owner-only).
   * Lists ONE monthly partition (`caisse-YYYYMM`); defaults to the current month.
   * `month` is validated to 6 digits (bad → current month). Returns the raw
   * entries newest-first (the data API's own sort) plus the resolved collection.
   */
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/caisse')
  async erpCaisseList(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Query('month') month: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const m = caisseStr(month).trim();
    const collection = /^\d{6}$/.test(m)
      ? `caisse-${m}`
      : caisseCollectionFor();
    const entries = await this.erpList(slug, collection);
    if (!entries) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    this.logger.log(
      `[erp] caisse-list slug=${slug} user=${user.id} coll=${collection} n=${entries.length}`
    );
    return { collection, entries };
  }

  /**
   * R2-d — POST /api/v1/apps/:slug/erp/caisse (auth'd, owner-only).
   * BODY = the pinned Caisse entry shape. Validated/normalized in the sibling
   * helper (integer DZD, kind/method allowlists), then created in the monthly
   * partition derived from the entry's own date (back-dated entries land in the
   * right month). Rejects invalid input as a typed 400 (invalid_entry{field}).
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/caisse')
  async erpCaisseCreate(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const v = validateCaisseEntry(body);
    if (!v.ok) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'invalid_entry', field: v.field, message: v.message });
      return;
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const created = await this.erpCreateRecord(
      slug,
      v.collection,
      v.entry as unknown as ErpRecord,
      token
    );
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    this.logger.log(
      `[erp] caisse-create slug=${slug} user=${user.id} coll=${v.collection} kind=${v.entry.kind} amount=${v.entry.amount}`
    );
    return { ok: true, entry: created.record };
  }

  /**
   * R2-d — PUT /api/v1/apps/:slug/erp/caisse/:id (auth'd, owner-only).
   * In-place money-doc update. Locates the existing entry (this month, then the
   * previous 24 partitions) by id, merges the partial patch onto it (sibling
   * helper re-validates the pinned shape), and writes it back via the data API's
   * native PUT upsert (single HSET — no delete window). 404 when the id is not
   * found in the read window.
   */
  @Throttle('strict')
  @Put('/api/v1/apps/:slug/erp/caisse/:id')
  async erpCaisseUpdate(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const entryId = caisseStr(id).trim();
    if (!entryId) throw new BadRequest('Entry id is required');
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    // Find the entry + its partition. Try the patch's date month first (cheap),
    // then fan out over the rolling window (a caisse entry can be edited months
    // later). We search a bounded set of partitions and stop at the first hit.
    const hintDate = caisseStr(body?.date).slice(0, 10);
    const partitions = new Set<string>();
    if (/^\d{4}-\d{2}-\d{2}$/.test(hintDate)) {
      partitions.add(caisseCollectionForDate(hintDate));
    }
    for (const c of caisseCollectionsInRange(
      new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10),
      new Date().toISOString().slice(0, 10)
    )) {
      partitions.add(c);
    }
    let found: ErpRecord | null = null;
    let foundCollection = '';
    for (const collection of partitions) {
      const rows = await this.erpList(slug, collection);
      if (!rows) continue;
      const hit = rows.find(r => caisseStr(r.id) === entryId);
      if (hit) {
        found = hit;
        foundCollection = collection;
        break;
      }
    }
    if (!found) throw new NotFound('Caisse entry not found');
    const merged = mergeCaisseEntry(found as CaisseRecord, body);
    if (!merged.ok) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({
          error: 'invalid_entry',
          field: merged.field,
          message: merged.message,
        });
      return;
    }
    // The entry's month may have CHANGED (date edited). PUT into the partition
    // for the NEW date; if that differs from where it was stored, delete the old
    // copy so it doesn't linger in two months (best-effort — PUT is the source
    // of truth). Normal case: same partition, a pure in-place HSET.
    const targetCollection = merged.collection;
    const saved = await this.erpPutRecord(
      slug,
      targetCollection,
      entryId,
      merged.entry as unknown as ErpRecord,
      token
    );
    if (!saved.ok) {
      this.erpWriteFailed(res, saved.status);
      return;
    }
    // MONEY-4: a cross-month move must not leave the entry in BOTH partitions.
    // The PUT above wrote it into the new month; if removing the old copy fails
    // silently, the same money is counted twice by any report that spans both
    // months. H3: change from a warning to a BLOCK — return HTTP 409 with the
    // exact ids for manual cleanup. The frontend should surface a modal requiring
    // acknowledgment. Best-effort write a superseded:true flag on the old copy so
    // a human cleaning up knows which one is stale.
    if (foundCollection && foundCollection !== targetCollection) {
      let dropped = await this.erpDeleteRecord(
        slug,
        foundCollection,
        entryId,
        token
      );
      if (!dropped) {
        dropped = await this.erpDeleteRecord(
          slug,
          foundCollection,
          entryId,
          token
        );
      }
      if (!dropped) {
        // Best-effort: write a superseded:true flag on the old copy so a human
        // can identify it for cleanup. If even this flag update fails, the 409
        // still surfaces the ids.
        try {
          const oldRows = await this.erpList(slug, foundCollection);
          const oldCopy = oldRows?.find(r => caisseStr(r.id) === entryId);
          if (oldCopy) {
            const flagged: ErpRecord = {};
            for (const k of Object.keys(oldCopy)) {
              if (k !== 'id' && k !== 'createdAt') flagged[k] = (oldCopy as ErpRecord)[k];
            }
            flagged.superseded = true;
            await this.erpPutRecord(slug, foundCollection, entryId, flagged, token);
          }
        } catch {
          // The 409 still surfaces the ids for manual cleanup.
        }
        this.logger.error(
          `[erp] caisse-update DOUBLE-COUNT BLOCKED slug=${slug} id=${entryId} ` +
            `moved ${foundCollection} -> ${targetCollection} but the old copy ` +
            `could not be deleted; it now exists in BOTH partitions (superseded flag best-effort)`
        );
        res.status(HttpStatus.CONFLICT).json({
          error: 'double_count_risk',
          entryId,
          oldPartition: foundCollection,
          newPartition: targetCollection,
        });
        return;
      }
    }
    this.logger.log(
      `[erp] caisse-update slug=${slug} user=${user.id} id=${entryId} coll=${targetCollection}`
    );
    return { ok: true, entry: saved.record };
  }

  // ---------------------------------------------------------------------------
  // COMPTA (WS-ERP-ACCOUNTING) — PCN DZ journal + états financiers + fiscal.
  // Mirrors the R2-d caisse surface: auth'd owner-only, monthly Redis-hash
  // partitions (`compta-entries-YYYYMM`), INTEGER DZD. ALL money math lives in
  // ./clickdz-erp-accounting (zero-import helper, same contract as
  // clickdz-erp-caisse.ts); these routes own ONLY the I/O — resolve partitions,
  // validate, create, hand raw entries to the builders.
  // ---------------------------------------------------------------------------

  /**
   * Monthly `compta-entries-YYYYMM` partitions covering [fromISO, toISO],
   * oldest-first, capped (a fiscal year is 12; the cap bounds degenerate
   * ranges the same way caisse's 730-day window does). Falls back to the
   * current month when the range is unusable.
   */
  private comptaPartitionsInRange(
    fromISO: string,
    toISO: string,
    cap = 24
  ): string[] {
    const from = /^\d{4}-\d{2}/.test(fromISO) ? fromISO.slice(0, 7) : '';
    const to = /^\d{4}-\d{2}/.test(toISO) ? toISO.slice(0, 7) : '';
    if (!from || !to || from > to) return [entriesCollectionFor()];
    const out: string[] = [];
    let y = parseInt(from.slice(0, 4), 10);
    let m = parseInt(from.slice(5, 7), 10);
    const ty = parseInt(to.slice(0, 4), 10);
    const tm = parseInt(to.slice(5, 7), 10);
    while (y < ty || (y === ty && m <= tm)) {
      out.push(`compta-entries-${y}${String(m).padStart(2, '0')}`);
      if (out.length >= cap) break;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  }

  /**
   * Read + concat several monthly partitions. A single failed partition is
   * skipped (a month with no entries yet must not 502 a year report — same
   * stance as the caisse PUT's partition scan); null ONLY when EVERY read
   * failed, which is indistinguishable from the data API being down.
   */
  private async comptaReadPartitions(
    slug: string,
    partitions: string[]
  ): Promise<JournalEntry[] | null> {
    const out: JournalEntry[] = [];
    let okCount = 0;
    for (const collection of partitions) {
      const rows = await this.erpList(slug, collection);
      if (rows) {
        okCount += 1;
        out.push(...(rows as JournalEntry[]));
      }
    }
    return okCount === 0 && partitions.length > 0 ? null : out;
  }

  /**
   * COMPTA — GET /api/v1/apps/:slug/erp/compta?month=YYYYMM (auth'd,
   * owner-only). Lists ONE monthly journal partition; defaults to the current
   * month. Mirrors the caisse list route exactly.
   */
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/compta')
  async erpComptaList(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Query('month') month: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const m = caisseStr(month).trim();
    const collection = /^\d{6}$/.test(m)
      ? `compta-entries-${m}`
      : entriesCollectionFor();
    const entries = await this.erpList(slug, collection);
    if (!entries) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    this.logger.log(
      `[erp] compta-list slug=${slug} user=${user.id} coll=${collection} n=${entries.length}`
    );
    return { collection, entries };
  }

  /**
   * COMPTA — GET /api/v1/apps/:slug/erp/compta/chart (auth'd, owner-only).
   * The PCN DZ chart of accounts, served so the studio's account picker is
   * always in sync with what validateJournalEntry accepts (the chart lives
   * server-side only — the frontend must never duplicate it).
   */
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/compta/chart')
  async erpComptaChart(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string
  ) {
    await this.assertOwnsErpApp(user, slug);
    return { chart: PCN_CHART };
  }

  /**
   * COMPTA — POST /api/v1/apps/:slug/erp/compta (auth'd, owner-only).
   * BODY = one journal entry { date, label, accountCode, debit XOR credit,
   * reference?, pieceRef?, partnerId? }. Normalized here (integer DZD, trimmed
   * + capped strings), validated by the sibling helper (PCN code allowlist,
   * debit-xor-credit), created in the monthly partition derived from the
   * entry's own date (back-dated entries land in the right month).
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/compta')
  async erpComptaCreate(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const entry: JournalEntry = {
      date: caisseStr(body?.date).slice(0, 10),
      label: caisseStr(body?.label).trim().slice(0, 200),
      accountCode: caisseStr(body?.accountCode).trim().slice(0, 8),
      debit: Math.max(0, Math.round(Number(body?.debit) || 0)),
      credit: Math.max(0, Math.round(Number(body?.credit) || 0)),
      reference: caisseStr(body?.reference).trim().slice(0, 64),
      pieceRef: caisseStr(body?.pieceRef).trim().slice(0, 64),
    };
    const partnerId = caisseStr(body?.partnerId).trim().slice(0, 64);
    if (partnerId) entry.partnerId = partnerId;
    const invalid = validateJournalEntry(entry);
    if (invalid) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'invalid_entry', message: invalid });
      return;
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const created = await this.erpCreateRecord(
      slug,
      entriesCollectionForDate(caisseStr(entry.date)),
      entry as unknown as ErpRecord,
      token
    );
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    this.logger.log(
      `[erp] compta-create slug=${slug} user=${user.id} code=${entry.accountCode} d=${entry.debit} c=${entry.credit}`
    );
    return { ok: true, entry: created.record };
  }

  /**
   * COMPTA — GET /api/v1/apps/:slug/erp/compta/report (auth'd, owner-only).
   * One aggregating read for every état: ?type=trial|ledger|income|bilan|
   * cashflow|g50|tva|aged plus the params each builder needs. Reads the
   * partitions the period spans and hands the raw entries to the zero-import
   * builders — no money math here.
   */
  @Throttle('default', { limit: 60, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/compta/report')
  async erpComptaReport(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Query('type') type: string | undefined,
    @Query('year') year: string | undefined,
    @Query('month') month: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('account') account: string | undefined,
    @Query('asof') asof: string | undefined,
    @Query('openingCash') openingCash: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const kind = caisseStr(type).trim();
    const yStr = caisseStr(year).trim();
    const fiscalYear = /^\d{4}$/.test(yStr)
      ? parseInt(yStr, 10)
      : new Date().getUTCFullYear();
    const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    const fromISO = isDate(caisseStr(from).trim())
      ? caisseStr(from).trim()
      : `${fiscalYear}-01-01`;
    const toISO = isDate(caisseStr(to).trim())
      ? caisseStr(to).trim()
      : `${fiscalYear}-12-31`;
    const fail502 = () => {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
    };

    if (kind === 'trial' || kind === 'ledger') {
      const entries = await this.comptaReadPartitions(
        slug,
        this.comptaPartitionsInRange(fromISO, toISO)
      );
      if (!entries) return fail502();
      if (kind === 'trial') {
        return {
          type: kind,
          from: fromISO,
          to: toISO,
          report: buildTrialBalance(entries, fromISO, toISO),
        };
      }
      const code = caisseStr(account).trim();
      const ledger = buildAccountLedger(entries, code);
      if (!ledger) {
        res
          .status(HttpStatus.BAD_REQUEST)
          .json({ error: 'unknown_account', account: code });
        return;
      }
      return { type: kind, from: fromISO, to: toISO, report: ledger };
    }

    if (
      kind === 'income' ||
      kind === 'bilan' ||
      kind === 'cashflow' ||
      kind === 'g50'
    ) {
      const entries = await this.comptaReadPartitions(
        slug,
        this.comptaPartitionsInRange(`${fiscalYear}-01-01`, `${fiscalYear}-12-31`)
      );
      if (!entries) return fail502();
      if (kind === 'income') {
        return { type: kind, report: buildIncomeStatement(entries, fiscalYear) };
      }
      if (kind === 'bilan') {
        return { type: kind, report: buildBalanceSheet(entries, fiscalYear) };
      }
      if (kind === 'g50') {
        return { type: kind, report: buildG50Summary(entries, fiscalYear) };
      }
      const opening = Math.round(Number(caisseStr(openingCash).trim()) || 0);
      return {
        type: kind,
        report: buildCashFlowStatement(entries, fiscalYear, opening),
      };
    }

    if (kind === 'tva') {
      const raw = caisseStr(month).trim();
      const ym = /^\d{6}$/.test(raw)
        ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}`
        : /^\d{4}-\d{2}$/.test(raw)
          ? raw
          : new Date().toISOString().slice(0, 7);
      const entries = await this.comptaReadPartitions(slug, [
        `compta-entries-${ym.replace('-', '')}`,
      ]);
      if (!entries) return fail502();
      return { type: kind, report: buildTVASummary(entries, ym) };
    }

    if (kind === 'aged') {
      const asOfISO = isDate(caisseStr(asof).trim())
        ? caisseStr(asof).trim()
        : new Date().toISOString().slice(0, 10);
      const windowStart = new Date(
        new Date(`${asOfISO}T00:00:00Z`).getTime() - 730 * 86_400_000
      )
        .toISOString()
        .slice(0, 10);
      const entries = await this.comptaReadPartitions(
        slug,
        this.comptaPartitionsInRange(windowStart, asOfISO)
      );
      if (!entries) return fail502();
      const code = caisseStr(account).trim() || '411';
      return {
        type: kind,
        asof: asOfISO,
        account: code,
        report: buildAgedReceivables(entries, asOfISO, code),
      };
    }

    res
      .status(HttpStatus.BAD_REQUEST)
      .json({ error: 'unknown_report', type: kind });
    return;
  }

  /**
   * COMPTA — POST /api/v1/apps/:slug/erp/compta/facture (auth'd, owner-only).
   * Generates a Facture Normalisée (Article 23 LF 2022) as standalone HTML.
   * Pure compute — nothing is written. NIFs are validated with the sibling
   * helper (15 digits, the legal identifier); every string is HTML-escaped
   * HERE because the generator interpolates its args verbatim, and the result
   * is opened as a document by the studio.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/compta/facture')
  async erpComptaFacture(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const esc = (v: unknown) =>
      caisseStr(v)
        .slice(0, 300)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const sellerNIF = caisseStr(body?.sellerNIF).replace(/\s/g, '');
    const buyerNIF = caisseStr(body?.buyerNIF).replace(/\s/g, '');
    const badNif = (field: string, message: string | undefined) => {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'invalid_nif', field, message });
    };
    const vSeller = validateNIF(sellerNIF);
    if (!vSeller.valid) return badNif('sellerNIF', vSeller.error);
    const vBuyer = validateNIF(buyerNIF);
    if (!vBuyer.valid) return badNif('buyerNIF', vBuyer.error);
    const rawItems = Array.isArray(body?.items) ? body.items.slice(0, 50) : [];
    if (rawItems.length === 0) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'invalid_items', message: 'At least one item required' });
      return;
    }
    const TVA_RATES = [0, 0.09, 0.19];
    const items: {
      description: string;
      quantity: number;
      unitPrice: number;
      tvaRate: number;
    }[] = [];
    for (const raw of rawItems) {
      const quantity = Math.round(Number(raw?.quantity) || 0);
      const unitPrice = Math.round(Number(raw?.unitPrice) || 0);
      const tvaRate = Number(raw?.tvaRate);
      if (quantity <= 0 || unitPrice < 0 || !TVA_RATES.includes(tvaRate)) {
        res.status(HttpStatus.BAD_REQUEST).json({
          error: 'invalid_items',
          message:
            'Each item needs quantity > 0, unitPrice >= 0 (integer DZD) and tvaRate in {0, 0.09, 0.19}',
        });
        return;
      }
      items.push({
        description: esc(raw?.description) || '—',
        quantity,
        unitPrice,
        tvaRate,
      });
    }
    // RC format varies across legacy registrations, so it is escaped but NOT
    // format-blocked (unlike the NIF, whose 15-digit shape is unambiguous).
    const html = generateFactureNormalisee({
      sellerName: esc(body?.sellerName) || '—',
      sellerAddress: esc(body?.sellerAddress) || '—',
      sellerNIF,
      sellerRC: esc(body?.sellerRC),
      sellerAIS: esc(body?.sellerAIS) || undefined,
      buyerName: esc(body?.buyerName) || '—',
      buyerAddress: esc(body?.buyerAddress) || '—',
      buyerNIF,
      invoiceNumber: esc(body?.invoiceNumber) || '—',
      invoiceDate: esc(body?.invoiceDate) || new Date().toISOString().slice(0, 10),
      items,
    });
    this.logger.log(
      `[erp] compta-facture slug=${slug} user=${user.id} items=${items.length}`
    );
    return { html };
  }

  /**
   * SEC-1 — POST/DELETE /api/v1/apps/:slug/erp/collections/:collection[/:id]
   * (auth'd, owner-only). Generic studio-owned collection writes.
   *
   * WHY THIS EXISTS: the studio used to write these records straight to the
   * data API's *v1* alias (`POST /api/apps-data/:slug/:collection`) precisely
   * because v1 accepted writes with NO token — the owner's browser cannot hold
   * the per-slug HMAC write token, which only a published app carries. That
   * made the merchant's own Créances ledger depend on an endpoint that was
   * equally open to the entire internet (anonymous create/delete on any slug,
   * verified against production). Closing the v1 hole therefore REQUIRES giving
   * the studio an authenticated channel first — this is it.
   *
   * Same shape as every other owner-gated ERP mutation here: assert ownership,
   * re-derive the write token SERVER-SIDE (never exposed to the browser), then
   * go through the normal erpCreateRecord/erpDeleteRecord helpers, which target
   * v2. Records stay schemaless (the data API stamps id + createdAt).
   *
   * The collection name is allowlisted rather than free-form: this route must
   * not become a generic write primitive over money documents that have their
   * own validated routes (caisse/invoices/orders/products/...). Anything not in
   * STUDIO_OWNED_COLLECTIONS is refused with a typed 400.
   */
  /**
   * SEC-2 — GET /api/v1/apps/:slug/erp/collections/:collection (auth'd,
   * owner-only). Owner-authenticated READ of any of the shop's collections.
   *
   * WHY THIS EXISTS: the studio reads its ERP panels straight off the data API's
   * @Public GET with no credential at all — 8 call sites across 5 surfaces
   * (orders, customers, creances). That works today only because the read gate
   * (CDZ_DATA_READ_GATE) is off, which is exactly the problem: while it is off,
   * ANYONE who knows a shop slug can dump that shop's orders and customers,
   * i.e. Algerian buyers' phone numbers and street addresses. Slugs are public
   * by construction — they are in every storefront URL.
   *
   * The gate cannot simply be switched on, because the studio's own reads would
   * start 401-ing and every ERP panel would blank. So the studio needs an
   * authenticated read channel first — this is it, and it is the mirror image of
   * the SEC-1 write route: assert ownership from the session, re-derive the
   * per-slug token SERVER-SIDE, and read through it. The token never reaches the
   * browser.
   *
   * No allowlist here (unlike the write route): reading is not destructive, and
   * the caller has already proven they own the shop, so they are entitled to any
   * of its collections. The collection name is still shape-validated by the data
   * API itself.
   */
  // Deliberately NOT a bare @Throttle('strict'). The guard keys a bare named
  // throttler as `${tracker};strict`, i.e. ONE bucket of 20 requests/60s shared
  // across every strict route in this controller — and this route now absorbs the
  // studio's collection reads (admin-clients alone loads 3, reports 4). A merchant
  // moving between panels within a minute would exhaust the shared bucket and get
  // 429s on their reads AND on any subsequent write. Supplying an explicit
  // limit/ttl makes the guard append ';custom' and key the bucket PER HANDLER
  // (see CloudThrottlerGuard.handleRequest + generateKey), so heavy read traffic
  // can no longer starve the write routes. 120/60s is generous for a human
  // browsing panels and still bounds abuse.
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/collections/:collection')
  async erpStudioCollectionList(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const rows = await this.erpList(slug, collection);
    if (!rows) {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'data_api_unavailable' });
      return;
    }
    return { ok: true, records: rows };
  }

  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/collections/:collection')
  async erpStudioCollectionCreate(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    if (!STUDIO_OWNED_COLLECTIONS.has(collection)) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'collection_not_allowed', collection });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'invalid_record', message: 'Record must be an object' });
      return;
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const created = await this.erpCreateRecord(
      slug,
      collection,
      body as ErpRecord,
      token
    );
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    this.logger.log(
      `[erp] studio-coll-create slug=${slug} user=${user.id} coll=${collection}`
    );
    return { ok: true, record: created.record };
  }

  @Throttle('strict')
  @Delete('/api/v1/apps/:slug/erp/collections/:collection/:id')
  async erpStudioCollectionDelete(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    if (!STUDIO_OWNED_COLLECTIONS.has(collection)) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'collection_not_allowed', collection });
      return;
    }
    if (!id) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'invalid_record', message: 'Record id is required' });
      return;
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const ok = await this.erpDeleteRecord(slug, collection, id, token);
    if (!ok) {
      this.erpWriteFailed(res, 0);
      return;
    }
    this.logger.log(
      `[erp] studio-coll-delete slug=${slug} user=${user.id} coll=${collection} id=${id}`
    );
    return { ok: true, deleted: true };
  }

  /**
   * R2-d — GET /api/v1/apps/:slug/erp/caisse/reconcile?courierId=&from=&to=
   * (auth'd, owner-only). Per-courier COD reconciliation over [from,to]:
   *   expected = Σ delivered-order totals for courierId in range − codFee×count
   *   received = Σ non-pending 'in' caisse entries tagged courierId in range
   *   gap      = expected − received (+ per-order refs).
   * Reads ALL orders + the couriers list + the caisse partitions spanning the
   * range; all math in the sibling helper (integer DZD). `courierId` required.
   */
  @Throttle('default', { limit: 60, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/caisse/reconcile')
  async erpCaisseReconcile(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Query('courierId') courierId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const cid = caisseStr(courierId).trim();
    if (!cid) throw new BadRequest('"courierId" query param is required');
    const range = normalizeRange(from, to);
    const [orders, couriers] = await Promise.all([
      this.erpList(slug, 'orders'),
      this.erpList(slug, 'couriers'),
    ]);
    if (!orders || !couriers) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    // Merge the caisse partitions covering the range (best-effort: a missing
    // partition is simply empty; a failed read is skipped, matching inventory).
    const collections = caisseCollectionsInRange(range.from, range.to);
    const parts = await Promise.all(collections.map(c => this.erpList(slug, c)));
    const caisseRows: ErpRecord[] = [];
    for (const rows of parts) {
      if (rows) caisseRows.push(...rows);
    }
    const courier =
      (couriers.find(c => caisseStr(c.id).trim() === cid) as
        | CourierLite
        | undefined) ?? null;
    const report = reconcileCourier(
      cid,
      courier,
      orders as CaisseRecord[],
      caisseRows as CaisseRecord[],
      range.from,
      range.to
    );
    this.logger.log(
      `[erp] caisse-reconcile slug=${slug} user=${user.id} courier=${cid} ${range.from}..${range.to} expected=${report.expectedTotal} received=${report.receivedTotal} gap=${report.gap}`
    );
    return { range, report };
  }

  /**
   * R2-d — GET /api/v1/apps/:slug/erp/caisse/day-close?date=YYYY-MM-DD
   * (auth'd, owner-only). Day-close (or single-day) summary: in/out totals by
   * method (cod|cash|chargily) + net, with pending-COD markers reported
   * separately. `date` defaults to today (UTC). All integer DZD.
   */
  @Throttle('default', { limit: 60, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/caisse/day-close')
  async erpCaisseDayClose(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Query('date') date: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const range = normalizeRange(date, date);
    const collections = caisseCollectionsInRange(range.from, range.to);
    const parts = await Promise.all(collections.map(c => this.erpList(slug, c)));
    // A single failed partition read is degraded (empty) rather than 502-ing the
    // whole close; but if EVERY partition is unreachable, surface the outage.
    if (parts.every(p => p === null)) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const caisseRows: ErpRecord[] = [];
    for (const rows of parts) {
      if (rows) caisseRows.push(...rows);
    }
    const summary = buildDayClose(
      caisseRows as CaisseRecord[],
      range.from,
      range.from,
      range.to
    );
    this.logger.log(
      `[erp] caisse-day-close slug=${slug} user=${user.id} date=${range.from} in=${summary.inTotal} out=${summary.outTotal} net=${summary.net}`
    );
    return summary;
  }

  // -------------------------------------------------------------------------
  // R2-g (WSB-2) — POST /api/v1/apps/:slug/ai-edit (auth'd, owner-only).
  // "Modifier avec l'IA": edit a LIVE published storefront with the shop-aware
  // prompt, then MECHANICALLY lint the result against the storefront contract
  // (data-API wiring, Bearer write-auth, the orders POST + 5 status literals,
  // the settings singleton, featureOn/sectionOn gating). On a lint failure it
  // retries the model ONCE with the concrete violations appended; a second
  // failure is a typed 422 (never deployed). Success returns the edited HTML —
  // it does NOT deploy (the FE deploys via the existing deployApp path, same
  // slug → cap-safe). When CDZ_SHOP_STATE is on it ALSO best-effort stages the
  // HTML as a ShopState pending patch (Coffre's clickdz-shop-state.ts, resolved
  // by fail-soft dynamic import so a parallel-built/renamed module can never
  // break this route or boot).
  //
  // Env-gated by CDZ_SHOP_AI_EDIT (OFF → typed 404, byte-identical to today —
  // same flag that gates GET /apps/:slug/source, whose helpers this reuses).
  // Ownership + current-HTML resolution reuse the EXACT mechanism of the
  // /source route: readPublishedApps + resolveAppSource with the same
  // renderTemplate closure. The LLM call mirrors buildAppHtml verbatim
  // (runMakeAgent 'clickdz-apps' + MAKE_CODE_AGENT_ID, then extractHtmlApp).
  // Passthrough res carries the typed 422 body (a raw HttpException would be
  // flattened to a generic 500 by the global filter).
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/ai-edit')
  async aiEditShop(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    // Feature flag OFF → behave as if the route does not exist (typed 404).
    if (!CDZ_SHOP_AI_EDIT) {
      throw new NotFound('App not found');
    }
    if (typeof slug !== 'string' || !APP_SLUG_RE.test(slug)) {
      throw new BadRequest('Invalid app slug');
    }
    const instruction = String(body?.instruction || '').trim();
    if (!instruction) {
      throw new BadRequest('An edit instruction is required');
    }
    // SECURITY: this route runs the (paid) code agent. Cap the instruction like
    // the generate route caps its prompt.
    if (instruction.length > MAX_PROMPT_CHARS) {
      throw new PayloadTooLargeException(
        `Instruction is too long (max ${MAX_PROMPT_CHARS} characters)`
      );
    }

    // Ownership: the caller must own this slug (or its paired storeSlug). SAME
    // mechanism as assertOwnsErpApp / GET /apps/mine / GET /apps/:slug/source.
    const records = await this.readPublishedApps(user.id);
    const record =
      records.find(r => r.slug === slug) ??
      records.find(r => r.storeSlug === slug);
    if (!record) {
      throw new NotFound('App not found');
    }

    // ----- resolve the current published HTML (the edit base) ---------------
    // Reuse the EXACT source-resolution the /source route uses: the same
    // renderTemplate closure (template-kind → server-render fast path; else
    // fetch the deployed artifact). This gives us the live storefront to edit.
    const externalBase = (
      process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
    ).replace(/\/+$/, '');
    const renderTemplate = (rec: AppSourceRecord): string => {
      const templateHtml =
        rec.kind === 'erp'
          ? CLICKDZ_ERP_TEMPLATE_HTML
          : rec.kind === 'shop'
            ? CLICKDZ_SHOP_TEMPLATE_HTML
            : '';
      if (!templateHtml) return '';
      const dataSlug = rec.storeSlug || rec.slug;
      const dataUrl = `${externalBase}/api/v2/apps-data/${dataSlug}`;
      const dataToken = publicDataToken(dataSlug);
      return renderTemplateSource({
        templateHtml,
        slug: dataSlug,
        dataUrl,
        dataToken,
        tokens: {
          storeName: CDZ_TPL_DEFAULT_STORE_NAME,
          whatsapp: CDZ_TPL_DEFAULT_WHATSAPP,
          accent:
            rec.kind === 'erp'
              ? CDZ_TPL_DEFAULT_ERP_ACCENT
              : CDZ_TPL_DEFAULT_ACCENT,
          pin: CDZ_TPL_DEFAULT_PIN,
        },
      });
    };
    const resolved = await resolveAppSource(record, { renderTemplate });
    if (!resolved.ok) {
      if (resolved.reason === 'not_renderable') {
        throw new NotFound('App source is not available');
      }
      res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'source_fetch_failed',
        reason: resolved.reason,
        message: 'Could not recover the published source to edit. Please try again.',
      });
      return;
    }
    const currentHtml = resolved.html;

    // ----- LLM edit + contract lint, with a SINGLE auto-retry ---------------
    // The generation call mirrors buildAppHtml exactly (same agent id + model
    // tiering): runMakeAgent('clickdz-apps', MAKE_CODE_AGENT_ID) → extractHtmlApp.
    // The only difference is the shop-aware content builder + the lint/retry
    // loop wrapped around it (we can't reuse buildAppHtml verbatim because it
    // neither lints nor retries).
    const startedAt = Date.now();
    const runShopEdit = async (violations?: string[]): Promise<string> => {
      const content = buildShopEditContent({
        prompt: instruction,
        currentHtml,
        ...(violations && violations.length ? { violations } : {}),
      });
      const reply = await this.runMakeAgent(
        [{ role: 'user', content }],
        'clickdz-apps',
        MAKE_CODE_AGENT_ID || undefined
      );
      let html = extractHtmlApp(reply || '');
      if (!html) {
        throw new HttpException(
          { error: { message: 'The model did not return a valid app. Try rephrasing.', type: 'provider_error', code: 'app_generation_failed' } },
          HttpStatus.BAD_GATEWAY
        );
      }
      if (html.length > 400_000) html = html.slice(0, 400_000);
      return html;
    };

    let html = await runShopEdit();
    let lint = lintShopContract(html);
    if (!lint.ok) {
      this.logger.warn(
        `[apps] ai-edit slug=${slug} contract violations (attempt 1): ${lint.violations.length} — retrying once`
      );
      // Single auto-retry with the concrete violations appended to the prompt.
      html = await runShopEdit(lint.violations);
      lint = lintShopContract(html);
    }
    if (!lint.ok) {
      this.logger.warn(
        `[apps] ai-edit slug=${slug} contract violations persist after retry: ${describeViolations(lint.violations)}`
      );
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        error: 'contract_violation',
        violations: lint.violations,
        message: describeViolations(lint.violations),
      });
      return;
    }

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    this.logger.log(
      `[apps] ai-edit slug=${slug} user=${user.id} ok bytes=${html.length} in ${seconds}s`
    );

    // Best-effort ShopState pending-patch hand-off (Coffre owns the module and
    // builds in parallel → resolved by fail-soft dynamic import so a missing /
    // renamed export can NEVER break this response or crash boot). Purely
    // additive; the FE still deploys via the existing path regardless.
    await this.stageShopStatePatch(user.id, record, html, instruction);

    // "What changed" label for the version list (best-effort; never blocks).
    let summary: string | undefined;
    try {
      summary = await this.summarizeEdit(instruction, currentHtml, html);
    } catch {
      summary = undefined;
    }

    return {
      ok: true,
      slug,
      html,
      lint: { ok: true },
      bytes: html.length,
      seconds,
      ...(summary ? { summary } : {}),
    };
  }

  /**
   * R2-g — best-effort ShopState pending-patch stage. When CDZ_SHOP_STATE is on
   * we hand the freshly-edited HTML to Coffre's ShopState module (WSB-3,
   * clickdz-shop-state.ts) so a later deploy/rollback has the delta server-side.
   * Coffre's module is built IN PARALLEL and R2-CONTRACT pins only its DATA
   * shape, not export names — so we resolve it via a fail-soft dynamic import
   * and feature-detect a pending-patch entry point among the plausible names.
   * ANY failure (flag off, module absent, name mismatch, throw) is swallowed:
   * this is additive and must never break the ai-edit response or boot.
   */
  private async stageShopStatePatch(
    ownerId: string,
    record: PublishedAppRecord,
    html: string,
    note: string
  ): Promise<void> {
    if (process.env.CDZ_SHOP_STATE !== '1') return;
    try {
      // Sentinel R2 fix: direct positional call via the static import — the
      // probe/object-bag pattern mis-matched setPendingAiPatch(cache, userId,
      // slug, html) and silently no-opped. note flows to the version label via
      // the deploy hook; keeping this call minimal and fail-soft.
      void note;
      await setPendingAiPatch(this.redis, ownerId, record.slug, html);
    } catch (err) {
      this.logger.warn(
        `[apps] ai-edit ShopState stage skipped (fail-soft): ${(err as Error)?.message || err}`
      );
    }
  }

  /**
   * R2-h (WSB-3) — GET /api/v1/apps/:slug/state (auth'd, owner-only). Returns the
   * server-side ShopState for this store: templateId, featureSet, settingsRef,
   * whether an AI patch is staged, version METADATA and the activity log. NEVER
   * returns raw HTML (version bodies are fetched via /state/versions/:id). Gated
   * by CDZ_SHOP_STATE (OFF -> typed 404, byte-identical current behaviour).
   */
  @Throttle('strict')
  @Get('/api/v1/apps/:slug/state')
  async shopStateGet(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!CDZ_SHOP_STATE) {
      throw new NotFound('App not found');
    }
    await this.assertOwnsErpApp(user, slug);
    const state = await readShopState(this.redis, user.id, slug);
    return { ok: true, state: publicShopState(state) };
  }

  /**
   * R2-h (WSB-3) — GET /api/v1/apps/:slug/state/versions/:id (auth'd, owner-only).
   * Returns that recorded version's FULL HTML (the one place a version body is
   * exposed, for preview/rollback confirmation). Unknown/expired id -> typed 404.
   * Gated by CDZ_SHOP_STATE.
   */
  @Throttle('strict')
  @Get('/api/v1/apps/:slug/state/versions/:id')
  async shopStateVersionGet(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!CDZ_SHOP_STATE) {
      throw new NotFound('App not found');
    }
    await this.assertOwnsErpApp(user, slug);
    const html = await getVersionHtml(this.redis, user.id, slug, id);
    if (html == null) {
      throw new NotFound('Version not found');
    }
    return { ok: true, id, html, bytes: html.length };
  }

  /**
   * R2-h (WSB-3) — POST /api/v1/apps/:slug/state/rollback (auth'd, owner-only).
   * BODY `{ versionId }`. Loads that version's stored HTML and RE-DEPLOYS it via
   * the SAME internal deploy path deployApp uses (deployAppToVercel, same slug ->
   * idempotent, never trips the publish cap), then records a fresh 'rollback'
   * version so the timeline stays append-only. Gated by CDZ_SHOP_STATE.
   * Passthrough res carries the exact deploy failure bodies (a typed error would
   * be flattened to a 500 by the global filter).
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/state/rollback')
  async shopStateRollback(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!CDZ_SHOP_STATE) {
      throw new NotFound('App not found');
    }
    await this.assertOwnsErpApp(user, slug);
    const versionId = typeof body?.versionId === 'string' ? body.versionId : '';
    if (!versionId) {
      throw new BadRequest('"versionId" is required');
    }
    const html = await getVersionHtml(this.redis, user.id, slug, versionId);
    if (html == null || html.length < 20) {
      throw new NotFound('Version not found');
    }
    // Re-deploy via the SAME internal path as deployApp. deployAppToVercel owns
    // `res` on failure (typed 503/502 already written) -> stop without recording.
    const result = await this.deployAppToVercel(slug, html, res, user.id);
    if (!result.ok) return;
    const deployed = result.deployed;
    this.logger.log(
      `[shopstate] rollback slug=${slug} user=${user.id} to=${versionId}`
    );
    // Record the rolled-back HTML as a NEW version (append-only history) and
    // reflect it as the staged patch. Fail-soft: never undo a successful deploy.
    try {
      await recordVersion(
        this.redis,
        user.id,
        slug,
        html,
        `rollback ${versionId}`
      );
      await writeShopState(this.redis, user.id, slug, { aiPatchHtml: html });
      await appendLog(
        this.redis,
        user.id,
        slug,
        'rollback',
        `rolled back to ${versionId}`
      );
    } catch {
      /* ShopState is best-effort; the deploy already succeeded */
    }
    return { ...deployed, bytes: html.length, rolledBackTo: versionId };
  }

  /**
   * R2-h (WSB-3) — POST /api/v1/apps/:slug/state/note (auth'd, owner-only).
   * BODY `{ note }`. Appends a free-text 'note' entry to the ShopState activity
   * log (newest-first, capped). Gated by CDZ_SHOP_STATE.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/state/note')
  async shopStateNote(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!CDZ_SHOP_STATE) {
      throw new NotFound('App not found');
    }
    await this.assertOwnsErpApp(user, slug);
    const note =
      typeof body?.note === 'string' ? body.note.trim().slice(0, 400) : '';
    if (!note) {
      throw new BadRequest('"note" is required');
    }
    const state = await appendLog(this.redis, user.id, slug, 'note', note);
    return { ok: true, state: publicShopState(state) };
  }

  // ===========================================================================
  // WSE-12 (R2-e) — ERP STAFF AUTH & ROLES (CLEF). All routes gated by
  // CDZ_ERP_STAFF_AUTH: OFF (default) ⇒ typed 404 (route behaves as if it does
  // not exist), so the legacy single-PIN published-app path is byte-identical.
  // Owner-gated CRUD (session + assertOwnsErpApp) mints/rotates HMAC staff
  // tokens (logic in ./cdz-data-token); the @Public verify route is what the
  // PUBLISHED ERP app calls at login (R3). Token logic is delegated to the
  // sibling file — this controller only does I/O + role/permission mapping.
  // Typed errors (BadRequest/NotFound) or passthrough res only — never a raw
  // HttpException (the global filter would coerce it to 500).
  // ===========================================================================

  /** Staff records live in the unpartitioned `staff` collection (Mason WSE). */
  private staffAuthEnabled(): boolean {
    return process.env.CDZ_ERP_STAFF_AUTH === '1';
  }

  /**
   * Normalize a raw `staff` data-record to the pinned shape. A record with no
   * `nonce` (e.g. a legacy/hand-seeded row) defaults to '0' so tokens can still
   * be minted + rotated deterministically.
   */
  private erpStaffView(r: ErpRecord): {
    id: string;
    name: string;
    phone: string;
    role: string;
    active: boolean;
    nonce: string;
    createdAt: string;
  } {
    return {
      id: erpStr(r.id),
      name: erpStr(r.name),
      phone: erpStr(r.phone),
      role: erpStr(r.role),
      active: r.active !== false,
      nonce: erpStr(r.nonce) || '0',
      createdAt: erpStr(r.createdAt),
    };
  }

  /**
   * WSE-12 — GET /api/v1/apps/:slug/erp/staff (auth'd, owner-only).
   * Lists staff records (NEVER any secret material — no token, no pinHash).
   * CDZ_ERP_STAFF_AUTH OFF ⇒ typed 404.
   */
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/staff')
  async erpListStaff(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!this.staffAuthEnabled()) {
      throw new NotFound('Staff auth not enabled');
    }
    await this.assertOwnsErpApp(user, slug);
    const rows = await this.erpList(slug, 'staff');
    if (!rows) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const staff = rows.map(r => {
      const v = this.erpStaffView(r);
      // Never leak the nonce/pinHash to the client — expose only display fields.
      return {
        id: v.id,
        name: v.name,
        phone: v.phone,
        role: v.role,
        active: v.active,
        createdAt: v.createdAt,
      };
    });
    this.logger.log(
      `[erp] staff list slug=${slug} user=${user.id} count=${staff.length}`
    );
    return { staff };
  }

  /**
   * WSE-12 — POST /api/v1/apps/:slug/erp/staff (auth'd, owner-only).
   * BODY `{ name, phone?, role }` — creates a staff record
   * `{ id, name, phone, role, active, nonce, createdAt }` (id = kebab slug of
   * name + short random suffix). Returns the record PLUS a ONE-TIME
   * `staffToken` (shown once; never re-derivable from the list route). Bad role
   * ⇒ 400. CDZ_ERP_STAFF_AUTH OFF ⇒ typed 404.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/staff')
  async erpCreateStaff(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!this.staffAuthEnabled()) {
      throw new NotFound('Staff auth not enabled');
    }
    await this.assertOwnsErpApp(user, slug);
    const name = erpStr(body?.name).trim().slice(0, 80);
    if (!name) {
      throw new BadRequest('"name" is required');
    }
    const phone = erpStr(body?.phone).trim().slice(0, 40);
    const role = erpStr(body?.role).trim();
    if (!(ERP_STAFF_ROLES as readonly string[]).includes(role)) {
      throw new BadRequest(
        `"role" must be one of: ${ERP_STAFF_ROLES.join(', ')}`
      );
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const existing = await this.erpList(slug, 'staff');
    if (!existing) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    if (existing.length >= ERP_MAX_STAFF) {
      throw new BadRequest(`Too many staff (max ${ERP_MAX_STAFF})`);
    }
    // Stable, human-ish business id: kebab of the name + a short random suffix
    // (unguessable + collision-safe across a rename).
    const kebab =
      name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 40) || 'staff';
    const id = `${kebab}-${randomBytes(3).toString('hex')}`;
    // Fresh revocation nonce — folded into every token this staff carries.
    const nonce = randomBytes(6).toString('hex');
    const record: ErpRecord = {
      id,
      name,
      ...(phone ? { phone } : {}),
      role,
      active: true,
      nonce,
      createdAt: new Date().toISOString(),
    };
    if (
      Buffer.byteLength(JSON.stringify(record), 'utf8') > ERP_MAX_WRITE_BYTES
    ) {
      throw new BadRequest('Staff record too large');
    }
    const created = await this.erpCreateRecord(slug, 'staff', record, token);
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    // ONE-TIME token — minted here and returned exactly once; the list route
    // never exposes it. Logic delegated to ./cdz-data-token.
    const staffTok = staffToken(slug, id, role as StaffRole, nonce);
    this.logger.log(
      `[erp] staff create slug=${slug} user=${user.id} id=${id} role=${role}`
    );
    return {
      ok: true,
      staff: {
        id,
        name,
        phone,
        role,
        active: true,
        createdAt: record.createdAt,
      },
      // Present ONCE — the owner hands it to the staff member. NEVER logged.
      staffToken: staffTok,
    };
  }

  /**
   * WSE-12 — PUT /api/v1/apps/:slug/erp/staff/:id (auth'd, owner-only).
   * BODY `{ role?, active? }` — updates a staff member's role and/or active
   * flag via delete+recreate on the business `id` (preserves name/phone/nonce/
   * createdAt). Changing a role does NOT rotate the nonce, but an outstanding
   * token still carries the OLD role in its signature, so it keeps its old
   * permissions until re-issued — call `/revoke` to force re-login on a
   * demotion. CDZ_ERP_STAFF_AUTH OFF ⇒ typed 404.
   */
  @Throttle('strict')
  @Put('/api/v1/apps/:slug/erp/staff/:id')
  async erpUpdateStaff(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!this.staffAuthEnabled()) {
      throw new NotFound('Staff auth not enabled');
    }
    await this.assertOwnsErpApp(user, slug);
    const sid = erpStr(id).trim();
    if (!sid) {
      throw new BadRequest('"id" is required');
    }
    const hasRole = body?.role !== undefined;
    const hasActive = body?.active !== undefined;
    if (!hasRole && !hasActive) {
      throw new BadRequest('Nothing to update (role and/or active)');
    }
    let role = '';
    if (hasRole) {
      role = erpStr(body?.role).trim();
      if (!(ERP_STAFF_ROLES as readonly string[]).includes(role)) {
        throw new BadRequest(
          `"role" must be one of: ${ERP_STAFF_ROLES.join(', ')}`
        );
      }
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const rows = await this.erpList(slug, 'staff');
    if (!rows) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const matches = rows.filter(r => erpStr(r.id) === sid);
    if (matches.length === 0) {
      throw new NotFound('Staff not found');
    }
    // Merge onto the authoritative (newest-first) copy; drop server-managed
    // fields the recreate will re-mint.
    const base = matches[0];
    const merged: ErpRecord = {};
    for (const k of Object.keys(base)) {
      if (k !== 'createdAt') merged[k] = base[k];
    }
    if (hasRole) merged.role = role;
    if (hasActive) merged.active = body.active !== false;
    merged.id = sid;
    merged.createdAt = erpStr(base.createdAt) || new Date().toISOString();
    if (
      Buffer.byteLength(JSON.stringify(merged), 'utf8') > ERP_MAX_WRITE_BYTES
    ) {
      throw new BadRequest('Staff record too large');
    }
    // MONEY-1: upsert IN PLACE, then clean up duplicates (see markOrderPaid).
    // The delete-then-recreate this replaces destroyed the staff record if the
    // recreate failed after the deletes landed.
    const survivorRecId = erpStr(base.id);
    if (!survivorRecId) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_write_failed' });
      return;
    }
    const created = await this.erpPutRecord(
      slug,
      'staff',
      survivorRecId,
      merged,
      token
    );
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    for (const m of matches.slice(1)) {
      const recId = erpStr(m.id);
      if (!recId || recId === survivorRecId) continue;
      await this.erpDeleteRecord(slug, 'staff', recId, token);
    }
    const v = this.erpStaffView(merged);
    this.logger.log(
      `[erp] staff update slug=${slug} user=${user.id} id=${sid} role=${v.role} active=${v.active}`
    );
    return {
      ok: true,
      staff: {
        id: v.id,
        name: v.name,
        phone: v.phone,
        role: v.role,
        active: v.active,
        createdAt: v.createdAt,
      },
    };
  }

  /**
   * WSE-12 — POST /api/v1/apps/:slug/erp/staff/:id/revoke (auth'd, owner-only).
   * Rotates the staff member's revocation `nonce` (delete+recreate, preserving
   * every other field). Because the nonce is folded into every token's
   * signature, ALL outstanding tokens for this staff member fail verification
   * immediately (instant device kill / password-reset semantics). Returns the
   * new one-time `staffToken` so the owner can re-issue access. OFF ⇒ 404.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/staff/:id/revoke')
  async erpRevokeStaff(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!this.staffAuthEnabled()) {
      throw new NotFound('Staff auth not enabled');
    }
    await this.assertOwnsErpApp(user, slug);
    const sid = erpStr(id).trim();
    if (!sid) {
      throw new BadRequest('"id" is required');
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const rows = await this.erpList(slug, 'staff');
    if (!rows) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const matches = rows.filter(r => erpStr(r.id) === sid);
    if (matches.length === 0) {
      throw new NotFound('Staff not found');
    }
    const base = matches[0];
    // Bump the nonce — this is what kills every old token on next verify.
    const newNonce = randomBytes(6).toString('hex');
    const merged: ErpRecord = {};
    for (const k of Object.keys(base)) {
      if (k !== 'createdAt') merged[k] = base[k];
    }
    merged.id = sid;
    merged.nonce = newNonce;
    merged.createdAt = erpStr(base.createdAt) || new Date().toISOString();
    // MONEY-1: upsert IN PLACE, then clean up duplicates (see markOrderPaid).
    // Losing a staff row here would strand the merchant's team member; the
    // nonce rotation that revokes their old tokens must not cost the record.
    const survivorRecId = erpStr(base.id);
    if (!survivorRecId) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_write_failed' });
      return;
    }
    const created = await this.erpPutRecord(
      slug,
      'staff',
      survivorRecId,
      merged,
      token
    );
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    for (const m of matches.slice(1)) {
      const recId = erpStr(m.id);
      if (!recId || recId === survivorRecId) continue;
      await this.erpDeleteRecord(slug, 'staff', recId, token);
    }
    const role = erpStr(merged.role);
    const staffTok = (ERP_STAFF_ROLES as readonly string[]).includes(role)
      ? staffToken(slug, sid, role as StaffRole, newNonce)
      : '';
    this.logger.log(
      `[erp] staff revoke slug=${slug} user=${user.id} id=${sid} (nonce rotated)`
    );
    // New one-time token so the owner can re-issue; old tokens are now dead.
    return { ok: true, staffToken: staffTok };
  }

  /**
   * WSE-12 — @Public() POST /api/v1/apps-staff/verify.
   * The PUBLISHED ERP app (no session cookie) calls this at LOGIN with the
   * per-staff token it holds. BODY `{ slug, token }` → verifies the HMAC token
   * (constant-time, expiry-bound) AND that its embedded revocation nonce still
   * matches the CURRENT staff record AND that the member is still active →
   * `{ ok, staffId, role, permissions[] }`. ANY failure ⇒ `{ ok: false }` (no
   * detail leaked). CDZ_ERP_STAFF_AUTH OFF ⇒ typed 404. Rate-limited exactly
   * like the other @Public routes (@Throttle('strict')). Typed errors /
   * passthrough only (a raw HttpException would become a 500).
   *
   * NOTE: this is a TOP-LEVEL path (NOT under /apps/:slug/...) so the published
   * app can reach it without an owner session; the slug travels in the body.
   */
  @Public()
  @Throttle('strict')
  @Post('/api/v1/apps-staff/verify')
  async erpStaffVerify(
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!this.staffAuthEnabled()) {
      throw new NotFound('Staff auth not enabled');
    }
    const slug = erpStr(body?.slug).trim();
    if (!slug || !APP_SLUG_RE.test(slug)) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'invalid_slug' });
      return;
    }
    const token = erpStr(body?.token).trim();
    // Cryptographic check first (cheap, constant-time, no I/O on failure).
    const verified = verifyStaffToken(slug, token);
    if (!verified.ok || !verified.staffId || !verified.role) {
      return { ok: false };
    }
    // Bind the token to the LIVE staff record: the embedded nonce must still
    // match (a revoke bumps it) and the member must still be active. Reading
    // the collection here is the ONE stateful check that powers revocation.
    const rows = await this.erpList(slug, 'staff');
    if (!rows) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const rec = rows
      .map(r => this.erpStaffView(r))
      .find(v => v.id === verified.staffId);
    if (!rec || !rec.active) {
      return { ok: false };
    }
    if (!safeEqual(rec.nonce, verified.nonce ?? '')) {
      // Token carries a stale nonce ⇒ it was revoked ⇒ reject.
      return { ok: false };
    }
    // Trust the LIVE record's role (not the token's) so a demotion takes effect
    // on next login even before the old token expires; permissions derive from
    // it via the single source of truth in ./cdz-data-token.
    const role = (ERP_STAFF_ROLES as readonly string[]).includes(rec.role)
      ? (rec.role as StaffRole)
      : verified.role;
    this.logger.log(
      `[erp] staff verify slug=${slug} id=${rec.id} role=${role} ok`
    );
    return {
      ok: true,
      staffId: rec.id,
      role,
      permissions: staffPermissions(role),
    };
  }

  /**
   * R2-i (WSF-8) — GET /api/v1/apps/:slug/staleness (auth'd, owner-only).
   * Reports whether a published shop was minted against an OLDER template
   * catalog version, so the studio can offer "Update app to unlock new
   * features" (03-customization §"Upgrade path for published apps"). Fetches the
   * app's CURRENT html via the SAME R1 source internals `/apps/:slug/source`
   * uses (resolveAppSource → template-kind server-render fast path; deployed
   * fetch fallback), then runs the pure `isStale` stamp check on it.
   *   • no stamp (legacy / no-templateId mint) ⇒ { stale:false } — never nag.
   *   • older stamp ⇒ { stale:true, from, to, templateId }.
   * Gated by CDZ_FEATURES_ENABLED (OFF ⇒ typed 404 — byte-identical current
   * behaviour). FAIL-SOFT: any source-fetch failure (unreachable origin,
   * non-renderable, etc.) returns { stale:false } rather than a 5xx — a staleness
   * probe must never break the studio; a missed nag is harmless.
   */
  @Throttle('strict')
  @Get('/api/v1/apps/:slug/staleness')
  async appStaleness(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response
  ) {
    // Feature flag OFF → behave as if the route does not exist (typed 404).
    if (!featuresEnabled()) {
      throw new NotFound('App not found');
    }
    if (typeof slug !== 'string' || !APP_SLUG_RE.test(slug)) {
      throw new BadRequest('Invalid app slug');
    }
    // Ownership: same mechanism as assertOwnsErpApp / GET /apps/:slug/source.
    await this.assertOwnsErpApp(user, slug);
    const records = await this.readPublishedApps(user.id);
    const record =
      records.find(r => r.slug === slug) ??
      records.find(r => r.storeSlug === slug);
    // No record for this owner ⇒ nothing to compare against ⇒ not stale.
    if (!record) {
      return { stale: false };
    }
    // RENDER closure: reconstruct the CURRENT template artifact with the SAME
    // token values templateApp / appSource inject. The stamp lives in the shell
    // (added at mint for a templated app), so the render fast path reproduces it;
    // the deployed fetch fallback recovers the live artifact's stamp verbatim.
    const externalBase = (
      process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
    ).replace(/\/+$/, '');
    const renderTemplate = (rec: AppSourceRecord): string => {
      const templateHtml =
        rec.kind === 'erp'
          ? CLICKDZ_ERP_TEMPLATE_HTML
          : rec.kind === 'shop'
            ? CLICKDZ_SHOP_TEMPLATE_HTML
            : '';
      if (!templateHtml) return '';
      const dataSlug = rec.storeSlug || rec.slug;
      const dataUrl = `${externalBase}/api/v2/apps-data/${dataSlug}`;
      const dataToken = publicDataToken(dataSlug);
      return renderTemplateSource({
        templateHtml,
        slug: dataSlug,
        dataUrl,
        dataToken,
        tokens: {
          storeName: CDZ_TPL_DEFAULT_STORE_NAME,
          whatsapp: CDZ_TPL_DEFAULT_WHATSAPP,
          accent:
            rec.kind === 'erp'
              ? CDZ_TPL_DEFAULT_ERP_ACCENT
              : CDZ_TPL_DEFAULT_ACCENT,
          pin: CDZ_TPL_DEFAULT_PIN,
        },
      });
    };
    // FAIL-SOFT: never let a source-fetch problem 5xx a staleness probe.
    let html: string | null = null;
    try {
      const resolved = await resolveAppSource(record, { renderTemplate });
      if (resolved.ok) html = resolved.html;
    } catch {
      html = null;
    }
    if (!html) {
      return { stale: false };
    }
    const status = isStale(html);
    this.logger.log(
      `[apps] staleness slug=${slug} user=${user.id} stale=${status.stale} from=${status.from ?? '-'} to=${status.to}`
    );
    // { stale, from?, to, templateId? } — undefined fields are omitted in JSON.
    return {
      stale: status.stale,
      from: status.from,
      to: status.to,
      templateId: status.templateId,
    };
  }

  private async assertOwnsErpApp(
    user: CurrentUser,
    slug: string
  ): Promise<void> {
    if (typeof slug !== 'string' || !APP_SLUG_RE.test(slug)) {
      throw new BadRequest('Invalid app slug');
    }
    const records = await this.readPublishedApps(user.id);
    if (records.some(r => r.slug === slug || r.storeSlug === slug)) {
      return;
    }
    const probe = await this.erpList(slug, 'settings');
    if (probe && probe.length > 0) {
      throw new ActionForbidden('You do not own this app');
    }
    throw new NotFound('App not found');
  }

  /**
   * C6 — GET /api/v1/apps/:slug/erp/summary (auth'd, owner-only). Fetches the
   * shop's five collections server-side and computes the dashboard payload.
   * KPI math mirrors the deployed ERP template's metrics() verbatim:
   *   revenueMonth  Σ orderTotal of 'Livrée' orders this month
   *   pendingCount  count of Nouvelle + Confirmée
   *   avgBasket     all-time delivered total ÷ delivered count
   *   expensesMonth Σ montant||amount of this month's expenses
   *   margin        revenueMonth − expensesMonth
   *   lowStock      products where stock <= reorderAt (reorderAt != null)
   * plus ordersByStatus (5 French states), revenueByDay (last 14 days,
   * oldest→newest, delivered only), recentOrders (≤20, newest-first) and
   * topProducts (≤5 by delivered revenue, title||name tolerant).
   */
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/summary')
  async erpSummary(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    // All five collections in parallel — mirrors the deployed ERP's loadAll().
    // `customers` is fetched for loadAll parity (and namespace health) even
    // though the C6 summary shape derives everything from the other four.
    const [orders, products, customers, expenses, settingsRows] =
      await Promise.all([
        this.erpList(slug, 'orders'),
        this.erpList(slug, 'products'),
        this.erpList(slug, 'customers'),
        this.erpList(slug, 'expenses'),
        this.erpList(slug, 'settings'),
      ]);
    if (!orders || !products || !customers || !expenses || !settingsRows) {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'data_api_unavailable' });
      return;
    }

    const month = erpTodayISO().slice(0, 7);
    // Last 14 UTC days, oldest → newest, ending today (template chartRevenue).
    const days: string[] = [];
    const revenueOfDay = new Map<string, number>();
    for (let i = ERP_REVENUE_DAYS - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      days.push(day);
      revenueOfDay.set(day, 0);
    }

    let revenueMonth = 0;
    let pendingCount = 0;
    let deliveredAllTotal = 0;
    let deliveredAllCount = 0;
    const ordersByStatus: Record<ErpOrderStatus, number> = {
      Nouvelle: 0,
      Confirmée: 0,
      Expédiée: 0,
      Livrée: 0,
      Retournée: 0,
    };
    const topMap = new Map<
      string,
      { title: string; qty: number; revenue: number }
    >();
    for (const o of orders) {
      const status = erpStr(o.status);
      if ((ERP_ORDER_STATUSES as readonly string[]).includes(status)) {
        ordersByStatus[status as ErpOrderStatus] += 1;
      }
      if (status === 'Nouvelle' || status === 'Confirmée') {
        pendingCount += 1;
      }
      if (status !== 'Livrée') continue;
      const total = erpOrderTotal(o);
      const day = erpParseDate(o);
      deliveredAllTotal += total;
      deliveredAllCount += 1;
      if (day.slice(0, 7) === month) revenueMonth += total;
      if (revenueOfDay.has(day)) {
        revenueOfDay.set(day, (revenueOfDay.get(day) ?? 0) + total);
      }
      // Top products from delivered order items (there is no per-product
      // ledger in the datastore). Items carry title (shop) or name (ERP).
      const items = Array.isArray(o.items) ? (o.items as unknown[]) : [];
      for (const raw of items) {
        const it = (raw ?? {}) as ErpRecord;
        const title =
          erpDisplayTitle(it) || erpStr(it.product).trim() || 'Article';
        const qty = erpNum(it.qty != null ? it.qty : 1);
        const key = title.toLowerCase();
        const entry = topMap.get(key) ?? { title, qty: 0, revenue: 0 };
        entry.qty += qty;
        entry.revenue += erpNum(it.price) * qty;
        topMap.set(key, entry);
      }
    }
    let expensesMonth = 0;
    for (const x of expenses) {
      if (erpParseDate(x).slice(0, 7) === month) {
        expensesMonth += erpNum(x.montant != null ? x.montant : x.amount);
      }
    }
    const avgBasket = deliveredAllCount
      ? deliveredAllTotal / deliveredAllCount
      : 0;
    // C4: prefer per-warehouse totals from the inventory ledger where available,
    // falling back to the product's `stock` roll-up. Best-effort + fail-open:
    // when there are no movement partitions (or a read fails) the map is empty
    // and EVERY product falls back to `erpNum(p.stock)` — i.e. byte-identical to
    // the pre-C4 predicate. So `lowStock`/`lowStockCount` never regress.
    const invTotals = await this.erpInventoryTotals(slug);
    const lowStock = products.filter(p => {
      if (p.reorderAt == null) return false;
      const key = erpProductKey(p);
      const onHand =
        key && invTotals.has(key)
          ? (invTotals.get(key) as number)
          : erpNum(p.stock);
      return onHand <= erpNum(p.reorderAt);
    });
    const topProducts = [...topMap.values()]
      .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty)
      .slice(0, ERP_TOP_PRODUCTS_MAX);
    const settingsRow =
      settingsRows.find(r => erpStr(r.key) === 'settings') ?? settingsRows[0];
    const settings = normalizeErpSettings(settingsRow);
    this.logger.log(
      `[erp] summary slug=${slug} user=${user.id} orders=${orders.length} products=${products.length}`
    );
    return {
      settings,
      currency: settings.currency,
      kpis: {
        revenueMonth,
        pendingCount,
        avgBasket,
        expensesMonth,
        margin: revenueMonth - expensesMonth,
        lowStockCount: lowStock.length,
        ordersTotal: orders.length,
      },
      ordersByStatus,
      revenueByDay: days.map(date => ({
        date,
        revenue: revenueOfDay.get(date) ?? 0,
      })),
      lowStock,
      recentOrders: orders.slice(0, ERP_RECENT_ORDERS_MAX),
      topProducts,
    };
  }

  /**
   * C6 — POST /api/v1/apps/:slug/erp/order-status (auth'd, owner-only).
   * BODY `{ ref, status }` — advances an order through the pipeline
   * (Nouvelle→Confirmée→Expédiée→Livrée, Retournée as the return branch).
   * The data API has no update op, so this is the templates' delete+recreate
   * on the STABLE business key `ref`: copy every field except server-managed
   * id/createdAt, set the new status, preserve orderedAt (backfilled from the
   * business date exactly like the ERP's advanceStatus). Deletes EVERY copy
   * of the ref first, which self-heals duplicates left by crashed replaces.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/order-status')
  async erpOrderStatus(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const ref = erpStr(body?.ref).trim();
    if (!ref || ref.length > 80) {
      throw new BadRequest('"ref" is required (the order reference)');
    }
    const status = erpStr(body?.status);
    if (!(ERP_ORDER_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequest(
        `"status" must be one of: ${ERP_ORDER_STATUSES.join(', ')}`
      );
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const orders = await this.erpList(slug, 'orders');
    if (!orders) {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'data_api_unavailable' });
      return;
    }
    const matches = orders.filter(o => erpStr(o.ref).trim() === ref);
    if (matches.length === 0) {
      throw new NotFound('Order not found');
    }
    // Newest-first list ⇒ matches[0] is the authoritative copy if duplicates
    // exist. Copy business fields, drop server-managed id/createdAt — the
    // exact field handling of the ERP template's advanceStatus().
    const base = matches[0];
    const next: ErpRecord = {};
    for (const k of Object.keys(base)) {
      if (k !== 'id' && k !== 'createdAt') next[k] = base[k];
    }
    next.status = status;
    if (!next.orderedAt) next.orderedAt = erpParseDate(base);
    // MONEY-3: stamp the DELIVERY moment. The pending-COD marker and the caisse
    // reconcile "expected" side both need to know WHEN a COD order was
    // delivered, not when it was placed — Algerian COD delivery lags of 2-7 days
    // mean every order near a month boundary was being filed into the wrong
    // month's books. Additive field, mirroring the existing paidAt pattern; only
    // set once so a re-flip to Livrée cannot move an already-recorded delivery.
    // Only stamp on a genuine transition INTO Livrée, and only once. Re-POSTing
    // Livrée on an already-delivered order must not move its delivery date (and
    // therefore must not move which month its COD belongs to) — this route has no
    // transition gate of its own, so the guard lives here.
    const wasDelivered = erpStr(base.status) === 'Livrée';
    if (status === 'Livrée' && !wasDelivered && !next.deliveredAt) {
      next.deliveredAt = new Date().toISOString();
    }
    // Size-check BEFORE writing: a rejected write must never cost the original
    // record.
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > ERP_MAX_WRITE_BYTES) {
      throw new BadRequest('Order record too large');
    }
    // MONEY-1: upsert IN PLACE (see markOrderPaid for the full rationale). The
    // delete-then-recreate this replaces could destroy a merchant's order if the
    // recreate failed after the deletes landed — on the HUMAN path, where a
    // merchant advancing an order to Livrée would watch it vanish. The caller
    // does at least get a 502 here (unlike the webhook path), but there was no
    // restore, so the record was gone regardless.
    const survivorId = erpStr(base.id);
    if (!survivorId) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_write_failed' });
      return;
    }
    const created = await this.erpPutRecord(
      slug,
      'orders',
      survivorId,
      next,
      token
    );
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    for (const m of matches.slice(1)) {
      const id = erpStr(m.id);
      if (!id || id === survivorId) continue;
      await this.erpDeleteRecord(slug, 'orders', id, token);
    }
    // R2-d (WSE-8): on delivery, write a pending-COD marker so caisse day-close
    // & per-courier reconcile know this order owes its COD. Fail-soft — never
    // breaks the status update (helper swallows all errors); idempotent.
    if (status === 'Livrée') {
      await this.erpWritePendingCod(slug, created.record, token);
    }
    this.logger.log(
      `[erp] order-status slug=${slug} user=${user.id} ref=${ref.slice(0, 40)} -> ${status}`
    );
    return { ok: true, order: created.record };
  }

  /**
   * C6 — POST /api/v1/apps/:slug/erp/product (auth'd, owner-only).
   * BODY `{ product }` — upsert a product (stock edits included) by its
   * stable business key: `sku` when present (ERP shape), else title||name
   * (shop shape, case-insensitive). Fields are sanitized with the shop
   * template's cleanProduct() rules (title≤120, imageUrl URL-ish ≤1500,
   * category≤40, description≤900, non-negative ints, 8KB cap). Existing
   * fields not present in the incoming product are PRESERVED (partial
   * update); new products get cleanProduct-shape defaults so the deployed
   * storefront renders them. `title`/`name` are kept in sync so the shop
   * (reads title) and the deployed ERP (reads name) agree.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/product')
  async erpUpsertProduct(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const raw = body?.product;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequest('"product" must be an object');
    }
    const p = raw as Record<string, unknown>;
    const title = (erpStr(p.title).trim() || erpStr(p.name).trim()).slice(
      0,
      120
    );
    const sku = erpStr(p.sku).trim().slice(0, 60);
    if (!title && !sku) {
      throw new BadRequest(
        '"product" needs a "title" (or "name"/"sku") to upsert by'
      );
    }
    // Sanitize ONLY the provided fields (cleanProduct rules) — absent fields
    // keep their stored values so a stock-only edit can't wipe the price.
    const patch: ErpRecord = {};
    if (title) patch.title = title;
    if (sku) patch.sku = sku;
    if (p.price !== undefined) {
      patch.price = Math.max(0, Math.round(erpNum(p.price)));
    }
    if (p.stock !== undefined) {
      patch.stock = Math.max(0, Math.round(erpNum(p.stock)));
    }
    if (p.reorderAt !== undefined) {
      patch.reorderAt = Math.max(0, Math.round(erpNum(p.reorderAt)));
    }
    if (p.imageUrl !== undefined) {
      let img = erpStr(p.imageUrl).trim();
      if (img.length > 1500 || (img && !/^https?:\/\//i.test(img))) img = '';
      patch.imageUrl = img;
    }
    if (p.category !== undefined) {
      patch.category = erpStr(p.category).slice(0, 40);
    }
    if (p.description !== undefined) {
      patch.description = erpStr(p.description).slice(0, 900);
    }
    if (p.active !== undefined) patch.active = p.active !== false;
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const products = await this.erpList(slug, 'products');
    if (!products) {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'data_api_unavailable' });
      return;
    }
    // Business-key match: sku first (exact), else display title (title||name,
    // case-insensitive). ALL matches are replaced by one clean record.
    const titleKey = title.toLowerCase();
    const bySku = sku
      ? products.filter(x => erpStr(x.sku).trim() === sku)
      : [];
    const matches = bySku.length
      ? bySku
      : titleKey
        ? products.filter(
            x => erpDisplayTitle(x).toLowerCase() === titleKey
          )
        : [];
    const baseRec: ErpRecord | undefined = matches[0];
    if (!baseRec && !title) {
      throw new BadRequest('A new product needs a "title" (or "name")');
    }
    const merged: ErpRecord = {};
    if (baseRec) {
      for (const k of Object.keys(baseRec)) {
        if (k !== 'id' && k !== 'createdAt') merged[k] = baseRec[k];
      }
    }
    Object.assign(merged, patch);
    if (!baseRec) {
      // cleanProduct-shape defaults so the storefront card is complete.
      const defaults: ErpRecord = {
        type: 'product',
        price: 0,
        imageUrl: '',
        stock: 0,
        reorderAt: 0,
        category: '',
        description: '',
        active: true,
      };
      for (const [k, v] of Object.entries(defaults)) {
        if (merged[k] === undefined) merged[k] = v;
      }
    }
    // Keep the two template shapes in sync: shop reads `title`, ERP `name`.
    const displayName = erpStr(merged.title).trim() || erpStr(merged.name).trim();
    if (displayName) {
      merged.title = displayName;
      if (merged.name !== undefined) merged.name = displayName;
    }
    if (
      Buffer.byteLength(JSON.stringify(merged), 'utf8') > ERP_MAX_WRITE_BYTES
    ) {
      throw new BadRequest('Product record too large (8KB cap; use an image URL, not base64)');
    }
    // MONEY-1: upsert IN PLACE when a product already exists (see markOrderPaid
    // for the full rationale). The delete-then-recreate this replaces would
    // destroy the merchant's product — title, price, images, stock, reorder
    // point — if the recreate failed after the deletes had landed. A genuinely
    // NEW product still goes through create, since there is no id to write to.
    const survivorId = baseRec ? erpStr(baseRec.id) : '';
    const created = survivorId
      ? await this.erpPutRecord(slug, 'products', survivorId, merged, token)
      : await this.erpCreateRecord(slug, 'products', merged, token);
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    if (survivorId) {
      for (const m of matches.slice(1)) {
        const id = erpStr(m.id);
        if (!id || id === survivorId) continue;
        await this.erpDeleteRecord(slug, 'products', id, token);
      }
    }
    this.logger.log(
      `[erp] product upsert slug=${slug} user=${user.id} key=${(sku || titleKey).slice(0, 40)} ${baseRec ? 'replaced' : 'created'}`
    );
    return { ok: true, product: created.record };
  }

  /**
   * C6 — POST /api/v1/apps/:slug/erp/settings (auth'd, owner-only).
   * BODY `{ patch }` — merge into the settings singleton (delete+recreate on
   * key='settings', like the shop admin's saveSettings). Supported fields:
   * shopName (1–60), tagline (≤200), whatsapp (8–15 digits), deliveryFee
   * (number ≥0), accent (#RRGGBB), adminPin (4–8 digits). An invalid field →
   * 400 {error:'invalid_settings', field} — the SAME contract body
   * /apps/template emits (passthrough res carries the field name). The merge
   * base is the stored singleton normalized to the deployed shop's full field
   * set, so unpatched fields keep their values (defaults when never set).
   *
   * C7 (APPEARANCE): the allowlist is EXTENDED (additive) with theme/template/
   * font/sections — IDS/ENUMS ONLY, validated against their allowlists; NEVER
   * raw CSS (store ids, the template resolves them). An unknown id → the same
   * 400 {error:'invalid_settings', field}. Everything else (delete+recreate on
   * the singleton, 8KB cap, per-slug write token, French status strings) is
   * unchanged.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/settings')
  async erpSaveSettings(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const raw = body?.patch;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequest('"patch" must be an object');
    }
    const s = raw as Record<string, unknown>;
    const patch: ErpRecord = {};
    let badField = '';
    if (s.shopName != null) {
      const name = typeof s.shopName === 'string' ? s.shopName.trim() : '';
      if (!name || name.length > 60) badField = 'shopName';
      else patch.shopName = name;
    }
    if (!badField && s.tagline != null) {
      if (typeof s.tagline !== 'string') badField = 'tagline';
      else patch.tagline = s.tagline.slice(0, 200);
    }
    // HERO-1: the storefront template ALREADY honors settings.heroLine (it reads
    // it in heroLine() and renders it in the standard and boutique heroes,
    // falling back to the tagline) — there was simply no way to write it, so the
    // merchant could never change the line above their hero. Same shape and cap
    // as tagline. Carried through merges by erpSettingsPassthrough.
    if (!badField && s.heroLine != null) {
      if (typeof s.heroLine !== 'string') badField = 'heroLine';
      else patch.heroLine = s.heroLine.slice(0, 200);
    }
    if (!badField && s.whatsapp != null) {
      if (typeof s.whatsapp !== 'string' || !CDZ_WHATSAPP_RE.test(s.whatsapp)) {
        badField = 'whatsapp';
      } else patch.whatsapp = s.whatsapp;
    }
    if (!badField && s.deliveryFee != null) {
      const fee = Number(s.deliveryFee);
      if (!Number.isFinite(fee) || fee < 0) badField = 'deliveryFee';
      else patch.deliveryFee = Math.round(fee);
    }
    if (!badField && s.accent != null) {
      if (typeof s.accent !== 'string' || !CDZ_ACCENT_RE.test(s.accent)) {
        badField = 'accent';
      } else patch.accent = s.accent;
    }
    if (!badField && s.adminPin != null) {
      if (typeof s.adminPin !== 'string' || !CDZ_PIN_RE.test(s.adminPin)) {
        badField = 'adminPin';
      } else patch.adminPin = s.adminPin;
    }
    // C7 (APPEARANCE): theme / template / font — validated ID enums, stored as
    // lowercase ids (never raw CSS). An unknown id is a per-field 400.
    if (!badField && s.theme != null) {
      const id = typeof s.theme === 'string' ? s.theme.trim().toLowerCase() : '';
      if (!(ERP_THEME_IDS as readonly string[]).includes(id)) badField = 'theme';
      else patch.theme = id;
    }
    if (!badField && s.template != null) {
      const id =
        typeof s.template === 'string' ? s.template.trim().toLowerCase() : '';
      if (!(ERP_TEMPLATE_IDS as readonly string[]).includes(id)) {
        badField = 'template';
      } else patch.template = id;
    }
    if (!badField && s.font != null) {
      const id = typeof s.font === 'string' ? s.font.trim().toLowerCase() : '';
      if (!(ERP_FONT_IDS as readonly string[]).includes(id)) badField = 'font';
      else patch.font = id;
    }
    if (!badField && s.radius != null) {
      const id = typeof s.radius === 'string' ? s.radius.trim().toLowerCase() : '';
      if (!(ERP_RADIUS_IDS as readonly string[]).includes(id)) badField = 'radius';
      else patch.radius = id;
    }
    // C7: sections — a CSV/array of allowed section ids, normalized to a
    // canonical CSV. Malformed / unknown id → 400. Empty selection is valid.
    if (!badField && s.sections != null) {
      const csv = normalizeErpSections(s.sections);
      if (csv === null) badField = 'sections';
      else patch.sections = csv;
    }
    if (badField) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'invalid_settings', field: badField });
      return;
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequest(
        '"patch" must include at least one of: shopName, tagline, heroLine, whatsapp, deliveryFee, accent, adminPin, theme, template, font, radius, sections'
      );
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const rows = await this.erpList(slug, 'settings');
    if (!rows) {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'data_api_unavailable' });
      return;
    }
    const baseRow = rows.find(r => erpStr(r.key) === 'settings') ?? rows[0];
    // SETTINGS-1: carry the keys this route does not own (features, onlinePay,
    // rtl/lang, heroLine, per-feature params) FIRST, so normalizeErpSettings and
    // the incoming patch still win for everything they do own. Without this,
    // saving the Appearance tab wiped the shop's enabled features.
    const merged: ErpRecord = {
      ...erpSettingsPassthrough(baseRow),
      ...normalizeErpSettings(baseRow),
      ...patch,
      key: 'settings',
    };
    if (
      Buffer.byteLength(JSON.stringify(merged), 'utf8') > ERP_MAX_WRITE_BYTES
    ) {
      throw new BadRequest('Settings record too large');
    }
    // MONEY-1: write the singleton IN PLACE, then drop any duplicate rows (see
    // markOrderPaid). The previous order — delete EVERY row, then recreate —
    // meant a failed recreate left the shop with NO settings at all: store name,
    // WhatsApp number, PIN, Chargily keys, all gone. Writing to the surviving
    // row's id first makes that unreachable; duplicate cleanup after is
    // best-effort because an extra row is self-healed on the next save, whereas
    // zero rows is a broken storefront.
    // Write to the row we MERGED FROM (baseRow), not blindly to rows[0]: when
    // duplicate singletons exist those can differ, and writing the merged
    // content to one row while deleting the row it came from would lose the
    // merge.
    const survivorId = erpStr(baseRow?.id);
    const created = survivorId
      ? await this.erpPutRecord(slug, 'settings', survivorId, merged, token)
      : await this.erpCreateRecord(slug, 'settings', merged, token);
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    for (const row of rows) {
      const id = erpStr(row.id);
      if (!id || id === survivorId) continue;
      await this.erpDeleteRecord(slug, 'settings', id, token);
    }
    this.logger.log(
      `[erp] settings saved slug=${slug} user=${user.id} fields=${Object.keys(patch).join(',')}`
    );
    return { ok: true, settings: created.record };
  }

  /**
   * R1-d (WSF-2) — POST /api/v1/apps/:slug/customize (auth'd, owner-only).
   * The feature-aware wrapper over the settings singleton: manual toggles AND
   * AI-chat edits converge here. BODY `{ features?, settings? }`:
   *   • features — CSV/array of registry feature ids (Anvil). Unknown ⇒ 400.
   *   • settings — per-feature scalar params (only keys the enabled features
   *     declare; only scalars). Unknown key / non-scalar ⇒ 400.
   * Validation delegates to validateFeatureSettings (ids+scalars, <8KB). The
   * validated {features,params} is merged into the singleton via the SAME
   * delete+recreate path /erp/settings uses (normalizeErpSettings base, 8KB cap,
   * per-slug write token). `remint` tells the client whether a runtime:false
   * feature was touched (⇒ it should re-publish via republishShop); pure runtime
   * flags reflect on the next settings fetch with no redeploy. Gated by
   * CDZ_FEATURES_ENABLED (OFF ⇒ typed 404). Invalid field ⇒ 400
   * {error:'invalid_settings', field} via passthrough res (SAME contract).
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/customize')
  async customizeApp(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!featuresEnabled()) {
      throw new NotFound('Feature customization not enabled');
    }
    await this.assertOwnsErpApp(user, slug);
    // Validate against the registry (shop scope — a shop slug drives storefront
    // features; the paired ERP shares the same namespace).
    const v = validateFeatureSettings(
      { features: body?.features, settings: body?.settings },
      'shop'
    );
    if (!v.ok) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'invalid_settings', field: v.field });
      return;
    }
    // Nothing to change ⇒ no-op success (idempotent; no write, no re-publish).
    if (
      v.patch.features === '' &&
      Object.keys(v.patch.params).length === 0
    ) {
      return { ok: true, remint: false, noop: true };
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const rows = await this.erpList(slug, 'settings');
    if (!rows) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const baseRow = rows.find(r => erpStr(r.key) === 'settings') ?? rows[0];
    // Merge onto the normalized singleton (same base as /erp/settings), then
    // layer the features CSV + per-feature scalar params.
    // SETTINGS-1: passthrough first for the same reason as /erp/settings — this
    // route owns `features` and its params, but not rtl/lang/heroLine/onlinePay,
    // and it must not destroy them.
    const merged: ErpRecord = {
      ...erpSettingsPassthrough(baseRow),
      ...normalizeErpSettings(baseRow),
      ...v.patch.params,
      features: v.patch.features,
      key: 'settings',
    };
    if (
      Buffer.byteLength(JSON.stringify(merged), 'utf8') > ERP_MAX_WRITE_BYTES
    ) {
      throw new BadRequest('Settings record too large');
    }
    // MONEY-1: write the singleton IN PLACE, then drop duplicates (see the
    // sibling erpSaveSettings above — a failed recreate used to leave the shop
    // with no settings row at all).
    // Write to the row we MERGED FROM (baseRow), not blindly to rows[0] — see
    // the sibling erpSaveSettings above.
    const survivorId = erpStr(baseRow?.id);
    const created = survivorId
      ? await this.erpPutRecord(slug, 'settings', survivorId, merged, token)
      : await this.erpCreateRecord(slug, 'settings', merged, token);
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    for (const row of rows) {
      const id = erpStr(row.id);
      if (!id || id === survivorId) continue;
      await this.erpDeleteRecord(slug, 'settings', id, token);
    }
    // Re-publish only when a runtime:false feature was touched.
    const remint = featuresRequireRemint(parseFeatureCsv(v.patch.features), 'shop');
    this.logger.log(
      `[erp] customize slug=${slug} user=${user.id} features=${v.patch.features || '-'} remint=${remint}`
    );
    return { ok: true, settings: created.record, remint };
  }

  // =========================================================================
  // C4 — INVENTORY v2 (multi-warehouse ledger on the data API).
  // Every route here is authed (@CurrentUser via the global AuthGuard) +
  // owner-gated (assertOwnsErpApp) and reuses the SAME erpList/erpCreateRecord/
  // erpDeleteRecord helpers (re-derived per-slug write token, delete+recreate,
  // 8KB cap) as the ERP admin routes above. Typed errors / passthrough only.
  // =========================================================================

  /**
   * Read the movements ledger across the rolling window and return
   * per-(product,warehouse) stock plus a per-product total. Best-effort: a
   * missing/empty partition is simply skipped; a partition whose read FAILS
   * (data API down) is skipped too, so callers degrade gracefully rather than
   * 502-ing a whole dashboard on one bad month. `read`/`failed` report how many
   * partitions were read vs unreachable (the inventory GET surfaces `capped`).
   */
  private async erpReadMovements(
    slug: string,
    months: number
  ): Promise<{
    byProduct: Map<string, Map<string, number>>;
    totals: Map<string, number>;
    read: number;
    failed: number;
  }> {
    const collections = erpMovementCollections(
      Math.min(months, ERP_MOVEMENT_MONTHS_READ)
    );
    // Fan out one GET per monthly partition (like the ERP's loadAll()).
    const results = await Promise.all(
      collections.map(c => this.erpList(slug, c))
    );
    const byProduct = new Map<string, Map<string, number>>();
    const totals = new Map<string, number>();
    let read = 0;
    let failed = 0;
    for (const rows of results) {
      if (rows === null) {
        failed += 1;
        continue;
      }
      read += 1;
      for (const raw of rows) {
        const m = (raw ?? {}) as ErpRecord;
        const key = erpStr(m.productKey).trim();
        const wid = erpStr(m.warehouseId).trim();
        if (!key || !wid) continue;
        const delta = Math.round(erpNum(m.delta));
        if (!Number.isFinite(delta) || delta === 0) continue;
        let per = byProduct.get(key);
        if (!per) {
          per = new Map<string, number>();
          byProduct.set(key, per);
        }
        per.set(wid, (per.get(wid) ?? 0) + delta);
        totals.set(key, (totals.get(key) ?? 0) + delta);
      }
    }
    return { byProduct, totals, read, failed };
  }

  /**
   * C4 helper for erpSummary: per-product on-hand totals from the ledger. Empty
   * map when the ledger is unused/unreachable ⇒ the summary falls back to the
   * product `stock` roll-up (byte-identical to the pre-C4 lowStock predicate).
   */
  private async erpInventoryTotals(slug: string): Promise<Map<string, number>> {
    try {
      const { totals } = await this.erpReadMovements(
        slug,
        ERP_MOVEMENT_MONTHS_READ
      );
      return totals;
    } catch {
      return new Map<string, number>();
    }
  }

  /**
   * C4 — GET /api/v1/apps/:slug/erp/inventory (auth'd, owner-only).
   * Reads the `warehouses` collection + the last ~13 monthly movement
   * partitions and returns:
   *   { warehouses, stockByProduct:{[productKey]:{[warehouseId]:qty, total}},
   *     lowStock:[...] }
   * lowStock uses the SAME predicate as erpSummary but prefers the ledger total
   * (fallback to product.stock). `partitionsRead`/`capped` report the read
   * window so the UI can note truncation.
   */
  @Throttle('default', { limit: 120, ttl: 60_000 })
  @Get('/api/v1/apps/:slug/erp/inventory')
  async erpInventory(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const [warehousesRaw, products] = await Promise.all([
      this.erpList(slug, 'warehouses'),
      this.erpList(slug, 'products'),
    ]);
    if (!warehousesRaw || !products) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const { byProduct, totals, read, failed } = await this.erpReadMovements(
      slug,
      ERP_MOVEMENT_MONTHS_READ
    );
    // Normalize warehouse records to the pinned shape (newest-first already).
    const warehouses = warehousesRaw.map(w => ({
      id: erpStr(w.id),
      name: erpStr(w.name),
      ...(erpStr(w.location) ? { location: erpStr(w.location) } : {}),
      createdAt: erpStr(w.createdAt),
    }));
    // Build stockByProduct: {[productKey]: {[warehouseId]: qty, total}}.
    const stockByProduct: Record<
      string,
      Record<string, number>
    > = {};
    for (const [key, per] of byProduct.entries()) {
      const entry: Record<string, number> = {};
      let total = 0;
      for (const [wid, qty] of per.entries()) {
        entry[wid] = qty;
        total += qty;
      }
      entry.total = total;
      stockByProduct[key] = entry;
    }
    // lowStock — same predicate as summary; prefer the ledger total.
    const lowStock = products.filter(p => {
      if (p.reorderAt == null) return false;
      const key = erpProductKey(p);
      const onHand =
        key && totals.has(key) ? (totals.get(key) as number) : erpNum(p.stock);
      return onHand <= erpNum(p.reorderAt);
    });
    this.logger.log(
      `[erp] inventory slug=${slug} user=${user.id} warehouses=${warehouses.length} products=${products.length} partitions=${read}/${read + failed}`
    );
    return {
      warehouses,
      stockByProduct,
      lowStock,
      partitionsRead: read,
      // `capped` = a partition in the window was unreachable OR we hit the read
      // ceiling; the UI can hint that totals may be partial.
      capped: failed > 0,
    };
  }

  /**
   * C4 — POST /api/v1/apps/:slug/erp/inventory/movement (auth'd, owner-only).
   * BODY `{ productKey, warehouseId, delta, reason, ref? }` — appends a movement
   * to the CURRENT-month partition (`movements-YYYYMM`) then recomputes the
   * product's `stock` roll-up (Σ deltas across the read window) and writes it
   * back via delete+recreate on the product's business key. Returns
   * `{ ok, stock }` (the new roll-up total). Reuses erpCreateRecord/
   * erpDeleteRecord + the 8KB pre-check; a full partition surfaces as the data
   * API's own typed 400 (data_rejected) via erpWriteFailed.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/inventory/movement')
  async erpInventoryMovement(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const productKey = erpStr(body?.productKey).trim().slice(0, 120);
    if (!productKey) {
      throw new BadRequest('"productKey" is required');
    }
    const warehouseId = erpStr(body?.warehouseId).trim();
    if (!warehouseId) {
      throw new BadRequest('"warehouseId" is required');
    }
    const reason = erpStr(body?.reason).trim();
    if (!(ERP_MOVEMENT_REASONS as readonly string[]).includes(reason)) {
      throw new BadRequest(
        `"reason" must be one of: ${ERP_MOVEMENT_REASONS.join(', ')}`
      );
    }
    const deltaNum = Number(body?.delta);
    if (!Number.isFinite(deltaNum) || Math.round(deltaNum) === 0) {
      throw new BadRequest('"delta" must be a non-zero integer');
    }
    const delta = Math.max(
      -ERP_MOVEMENT_DELTA_MAX,
      Math.min(ERP_MOVEMENT_DELTA_MAX, Math.round(deltaNum))
    );
    const ref = erpStr(body?.ref).trim().slice(0, ERP_MOVEMENT_REF_MAX);
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    // Warehouse must exist (a movement into an unknown warehouse is a client bug).
    const warehouses = await this.erpList(slug, 'warehouses');
    if (!warehouses) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    if (!warehouses.some(w => erpStr(w.id) === warehouseId)) {
      throw new NotFound('Warehouse not found');
    }
    // Append the movement to the current-month partition.
    const movement: ErpRecord = {
      ts: new Date().toISOString(),
      productKey,
      warehouseId,
      delta,
      reason: reason as ErpMovementReason,
      ...(ref ? { ref } : {}),
    };
    if (
      Buffer.byteLength(JSON.stringify(movement), 'utf8') > ERP_MAX_WRITE_BYTES
    ) {
      throw new BadRequest('Movement record too large');
    }
    const collection = erpMovementCollection();
    const created = await this.erpCreateRecord(
      slug,
      collection,
      movement,
      token
    );
    if (!created.ok) {
      // 400 from the data API here most likely = partition full (500 records).
      this.erpWriteFailed(res, created.status);
      return;
    }
    // Recompute the product roll-up (Σ deltas across the read window, which now
    // includes the just-appended movement) and persist it to product.stock via
    // delete+recreate on the business key (same shape erpUpsertProduct writes).
    const { totals } = await this.erpReadMovements(
      slug,
      ERP_MOVEMENT_MONTHS_READ
    );
    const newStock = Math.max(0, Math.round(totals.get(productKey) ?? delta));
    const rollup = await this.erpApplyStockRollup(
      slug,
      productKey,
      newStock,
      token
    );
    this.logger.log(
      `[erp] movement slug=${slug} user=${user.id} product=${productKey.slice(0, 40)} wh=${warehouseId} delta=${delta} reason=${reason} -> stock=${newStock}${rollup.applied ? '' : ' (no product roll-up)'}`
    );
    return { ok: true, stock: newStock, movement: created.record };
  }

  /**
   * C4 helper — write a product's `stock` roll-up by delete+recreate on its
   * business key (sku exact, else display title case-insensitive). Preserves
   * every other field. Returns { applied } — false when no product matches the
   * key (the movement is still recorded; there is just no roll-up to update) or
   * a write step fails (best-effort; the ledger remains the source of truth).
   * NEVER logs the token.
   */
  private async erpApplyStockRollup(
    slug: string,
    productKey: string,
    newStock: number,
    token: string
  ): Promise<{ applied: boolean }> {
    const products = await this.erpList(slug, 'products');
    if (!products) return { applied: false };
    const wanted = productKey.toLowerCase();
    const matches = products.filter(
      p => erpProductKey(p) === productKey || erpProductKey(p) === wanted
    );
    const baseRec = matches[0];
    if (!baseRec) return { applied: false };
    const merged: ErpRecord = {};
    for (const k of Object.keys(baseRec)) {
      if (k !== 'id' && k !== 'createdAt') merged[k] = baseRec[k];
    }
    merged.stock = newStock;
    if (
      Buffer.byteLength(JSON.stringify(merged), 'utf8') > ERP_MAX_WRITE_BYTES
    ) {
      return { applied: false };
    }
    // MONEY-1: upsert IN PLACE (see markOrderPaid for the full rationale).
    //
    // The delete-then-recreate this replaces was the most failure-prone instance
    // of the pattern in this file: it runs once PER PRODUCT in a loop straight
    // after a purchase-order receive has already spent writes from the shared
    // 60/min per-slug budget, so a mid-loop 429 was realistic. When the recreate
    // failed the product record was destroyed outright — title, price, images,
    // reorder point, everything — and because the only caller discards this
    // result, the merchant was never told. Their catalogue silently lost an item.
    const survivorId = erpStr(baseRec.id);
    if (!survivorId) return { applied: false };
    const saved = await this.erpPutRecord(
      slug,
      'products',
      survivorId,
      merged,
      token
    );
    if (!saved.ok) return { applied: false };
    for (const m of matches.slice(1)) {
      const id = erpStr(m.id);
      if (!id || id === survivorId) continue;
      await this.erpDeleteRecord(slug, 'products', id, token);
    }
    return { applied: true };
  }

  /**
   * C4 — POST /api/v1/apps/:slug/erp/warehouse (auth'd, owner-only).
   * BODY `{ name, location? }` — creates a warehouse record
   * `{ id, name, location?, createdAt }`. The data API mints id/createdAt, but
   * we ALSO mint a stable `id` in the body so movements can reference it (the
   * data API's own id lives alongside; movements key on our `id`). Caps the
   * warehouse count defensively.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/warehouse')
  async erpCreateWarehouse(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const name = erpStr(body?.name).trim().slice(0, ERP_WAREHOUSE_NAME_MAX);
    if (!name) {
      throw new BadRequest('"name" is required');
    }
    const location = erpStr(body?.location)
      .trim()
      .slice(0, ERP_WAREHOUSE_LOCATION_MAX);
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const existing = await this.erpList(slug, 'warehouses');
    if (!existing) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    if (existing.length >= ERP_MAX_WAREHOUSES) {
      throw new BadRequest(
        `Too many warehouses (max ${ERP_MAX_WAREHOUSES})`
      );
    }
    // Stable business id (independent of the data API's own record id) so
    // movements can reference a warehouse durably across a delete+recreate.
    const wid = `wh_${randomBytes(6).toString('hex')}`;
    const record: ErpRecord = {
      id: wid,
      name,
      ...(location ? { location } : {}),
      createdAt: new Date().toISOString(),
    };
    if (
      Buffer.byteLength(JSON.stringify(record), 'utf8') > ERP_MAX_WRITE_BYTES
    ) {
      throw new BadRequest('Warehouse record too large');
    }
    const created = await this.erpCreateRecord(
      slug,
      'warehouses',
      record,
      token
    );
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    this.logger.log(
      `[erp] warehouse create slug=${slug} user=${user.id} id=${wid}`
    );
    // Echo OUR stable id (not the data API's field id) — movements key on this.
    return { ok: true, warehouse: { ...record } };
  }

  /**
   * C4 — DELETE /api/v1/apps/:slug/erp/warehouse/:id (auth'd, owner-only).
   * Deletes the warehouse whose business `id` (our minted `wh_...`) matches.
   * Movements that referenced it are left in the ledger (append-only history);
   * they simply stop mapping to a live warehouse in stockByProduct's per-wh
   * breakdown, which is harmless. Idempotent-ish: no match ⇒ 404.
   */
  @Throttle('strict')
  @Delete('/api/v1/apps/:slug/erp/warehouse/:id')
  async erpDeleteWarehouse(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const wid = erpStr(id).trim();
    if (!wid) {
      throw new BadRequest('"id" is required');
    }
    const token = dataWriteToken(slug);
    if (!token) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'admin_writes_unavailable' });
      return;
    }
    const warehouses = await this.erpList(slug, 'warehouses');
    if (!warehouses) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    // Match on OUR business id; delete every data-API record carrying it (self-
    // heals dupes). The data API's own record id is the deletion key.
    const matches = warehouses.filter(w => erpStr(w.id) === wid);
    if (matches.length === 0) {
      throw new NotFound('Warehouse not found');
    }
    for (const m of matches) {
      // The record's data-API id: warehouses we mint carry OUR id in `id`, but
      // the data API also assigns its own field `id` on create — they are the
      // SAME field here (we set `id` in the body, create() only sets it when
      // absent). Delete by that value.
      const recId = erpStr(m.id);
      if (!recId) continue;
      if (!(await this.erpDeleteRecord(slug, 'warehouses', recId, token))) {
        res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_write_failed' });
        return;
      }
    }
    this.logger.log(
      `[erp] warehouse delete slug=${slug} user=${user.id} id=${wid}`
    );
    return { ok: true };
  }

  // =========================================================================
  // C5 — PIM AI product descriptions (grounded, no invented facts).
  // Reuses the bridge's cdz-flash idiom (summarizeEdit L~1615): same
  // CDZ_AI_BASE_URL/CDZ_AI_KEY, /v1/chat/completions, fail-closed parse.
  // =========================================================================

  /**
   * C5 — POST /api/v1/apps/:slug/erp/describe (auth'd, owner-only).
   * BODY `{ productKey, tone?, lang? }` — grounds a cdz-flash prompt STRICTLY in
   * the product's canonical attributes (title, price, category, specs — no
   * invented facts) and returns `{ description, bullets? }`. Planner down / no
   * key / unparseable ⇒ typed 502 (never a raw HttpException). Optional private
   * audit trail in Redis (clickdz:erp:audit:<slug>) — NOT a public collection.
   */
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/erp/describe')
  async erpDescribe(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const productKey = erpStr(body?.productKey).trim().slice(0, 120);
    if (!productKey) {
      throw new BadRequest('"productKey" is required');
    }
    // tone/lang are OPTIONAL style knobs — validated to short allowlists so they
    // can't be abused as a prompt-injection vector. Unknown ⇒ sensible default.
    const tone = erpStr(body?.tone).trim().toLowerCase().slice(0, 24);
    const lang = erpStr(body?.lang).trim().toLowerCase().slice(0, 12) || 'fr';
    if (!CDZ_AI_KEY) {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'planner_unavailable' });
      return;
    }
    // Fetch the product to ground on its CANONICAL attributes only.
    const products = await this.erpList(slug, 'products');
    if (!products) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'data_api_unavailable' });
      return;
    }
    const wanted = productKey.toLowerCase();
    const product = products.find(
      p => erpProductKey(p) === productKey || erpProductKey(p) === wanted
    );
    if (!product) {
      throw new NotFound('Product not found');
    }
    // Canonical, server-trusted facts — the ONLY grounding the model may use.
    const title = erpDisplayTitle(product) || 'Produit';
    const price = erpNum(product.price);
    const category = erpStr(product.category).trim();
    // Optional structured specs: accept a small string-map on the product OR the
    // request body (caller-supplied), stringified compactly. No other free text.
    const specsSource =
      body?.specs && typeof body.specs === 'object' && !Array.isArray(body.specs)
        ? body.specs
        : product.specs && typeof product.specs === 'object'
          ? product.specs
          : null;
    const specLines: string[] = [];
    if (specsSource) {
      for (const [k, v] of Object.entries(specsSource as Record<string, unknown>)) {
        const kk = erpStr(k).trim().slice(0, 40);
        const vv = erpStr(v).trim().slice(0, 120);
        if (kk && vv) specLines.push(`${kk}: ${vv}`);
        if (specLines.length >= 20) break;
      }
    }
    const facts = [
      `Title: ${title}`,
      price > 0 ? `Price: ${price} DZD` : '',
      category ? `Category: ${category}` : '',
      ...specLines.map(s => `Spec — ${s}`),
    ]
      .filter(Boolean)
      .join('\n');
    const prompt = [
      'You are a product copywriter for an Algerian e-commerce shop.',
      `Write a concise, appealing product description in ${lang === 'ar' ? 'Arabic' : lang === 'en' ? 'English' : 'French'}${tone ? ` with a ${tone} tone` : ''}.`,
      'GROUND STRICTLY in the FACTS below. Do NOT invent specifications, materials,',
      'sizes, origins, certifications, warranties, or any detail not present in the',
      'facts. If a detail is unknown, omit it — never guess.',
      'Return STRICT JSON only, no markdown, of the shape:',
      '{"description": "<2-4 sentences>", "bullets": ["<short selling point>", ...]}',
      'Provide 3-5 bullets, each grounded in a fact. No preamble.',
      '',
      'FACTS:',
      facts,
    ].join('\n');

    let raw = '';
    try {
      const response = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CDZ_AI_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CDZ_CHAT_MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: clampMaxTokens(500, 500),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await response.json()) as any;
      const content = data?.choices?.[0]?.message?.content;
      if (response.ok && typeof content === 'string') {
        raw = content;
      }
    } catch {
      // fall through → typed 502 below
    }
    if (!raw.trim()) {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'planner_unavailable' });
      return;
    }
    // Fail-closed parse: pull the first JSON object; tolerate a fenced block.
    const parsed = this.parseDescribeJson(raw);
    if (!parsed) {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'planner_unparseable' });
      return;
    }
    const description = erpStr(parsed.description).trim().slice(0, 900);
    const bullets = Array.isArray(parsed.bullets)
      ? parsed.bullets
          .map(b => erpStr(b).trim().slice(0, 160))
          .filter(Boolean)
          .slice(0, 8)
      : [];
    if (!description) {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'planner_unparseable' });
      return;
    }
    // OPTIONAL private audit trail (never a public collection; best-effort).
    try {
      await this.redis.lpush(
        erpAuditKey(slug),
        JSON.stringify({
          ts: new Date().toISOString(),
          user: user.id,
          productKey,
          tone: tone || undefined,
          lang,
          len: description.length,
        })
      );
      await this.redis.ltrim(erpAuditKey(slug), 0, 199);
      await this.redis.expire(erpAuditKey(slug), PUBLISHED_APPS_TTL_SECONDS);
    } catch {
      // audit is best-effort; never fail the describe on a Redis hiccup.
    }
    this.logger.log(
      `[erp] describe slug=${slug} user=${user.id} product=${productKey.slice(0, 40)} lang=${lang} len=${description.length}`
    );
    return {
      description,
      ...(bullets.length ? { bullets } : {}),
    };
  }

  /**
   * C5 helper — fail-closed JSON extraction from a model reply. Strips an
   * optional ```json fence, then parses the first {...} object. Returns null on
   * any failure (caller emits a typed 502) — NEVER throws.
   */
  private parseDescribeJson(
    raw: string
  ): { description?: unknown; bullets?: unknown } | null {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return obj as { description?: unknown; bullets?: unknown };
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  // =========================================================================
  // C6 — CHARGILY payments (private keys / public checkout / public webhook).
  // Merchant secret lives ONLY in private Redis (clickdz:pay:chargily:<slug>),
  // NEVER echoed in full, NEVER in the public settings singleton. Checkout auth
  // == the per-slug data write token (verifyDataToken). Webhook verifies an
  // HMAC-SHA256 of the RAW body (req.rawBody) constant-time, never logs secrets.
  // =========================================================================

  /** External base for THIS app's routes (webhook endpoint / success URL). */
  private erpAppBase(slug: string): string {
    const externalBase = (
      process.env.AFFINE_SERVER_EXTERNAL_URL || 'https://work.clickdz.ai'
    ).replace(/\/+$/, '');
    return `${externalBase}/api/v1/apps/${slug}`;
  }

  /** Read + validate the private Chargily config; null when unset/corrupt. */
  private async readChargilyConfig(
    slug: string
  ): Promise<ChargilyConfig | null> {
    let raw: string | null = null;
    try {
      raw = await this.redis.get(chargilyKey(slug));
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw) as Partial<ChargilyConfig>;
      const apiSecret = typeof obj.apiSecret === 'string' ? obj.apiSecret : '';
      const mode = obj.mode === 'live' ? 'live' : 'test';
      const enabled = obj.enabled === true;
      if (!apiSecret) return null;
      return { apiSecret, mode, enabled };
    } catch {
      return null;
    }
  }

  /**
   * C6 — PUT /api/v1/apps/:slug/pay/chargily (auth'd, owner-only).
   * BODY `{ apiSecret, mode:'test'|'live', enabled:boolean }` — stores the
   * config in PRIVATE Redis. The secret is NEVER echoed (response returns the
   * masked state only). A blank apiSecret with an existing config keeps the
   * stored secret (lets the merchant toggle enabled/mode without re-entering it).
   */
  @Throttle('strict')
  @Put('/api/v1/apps/:slug/pay/chargily')
  async payChargilyPut(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.assertOwnsErpApp(user, slug);
    const incomingSecret = erpStr(body?.apiSecret).trim();
    const mode = body?.mode === 'live' ? 'live' : 'test';
    const enabled = body?.enabled === true;
    // Keep the existing secret when the caller submits a blank (masked) field.
    const existing = await this.readChargilyConfig(slug);
    const apiSecret = incomingSecret || existing?.apiSecret || '';
    if (!apiSecret) {
      throw new BadRequest('"apiSecret" is required');
    }
    if (apiSecret.length > 512) {
      throw new BadRequest('"apiSecret" is too long');
    }
    const config: ChargilyConfig = { apiSecret, mode, enabled };
    try {
      // Rolling TTL (atomic EX) so a long-lived shop's key doesn't outlive its
      // data window — same idiom as the vdz controller's transcript store.
      await this.redis.set(
        chargilyKey(slug),
        JSON.stringify(config),
        'EX',
        PUBLISHED_APPS_TTL_SECONDS
      );
    } catch {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'store_unavailable' });
      return;
    }
    // NEVER log or echo the secret — masked state only.
    this.logger.log(
      `[pay] chargily config saved slug=${slug} user=${user.id} mode=${mode} enabled=${enabled}`
    );
    return {
      configured: true,
      mode,
      enabled,
      maskedKey: maskSecret(apiSecret),
    };
  }

  /**
   * C6 — GET /api/v1/apps/:slug/pay/chargily (auth'd, owner-only).
   * Returns `{ configured, mode, enabled, maskedKey }` — masked only, never the
   * full secret.
   */
  @Throttle('strict')
  @Get('/api/v1/apps/:slug/pay/chargily')
  async payChargilyGet(
    @CurrentUser() user: CurrentUser,
    @Param('slug') slug: string
  ) {
    await this.assertOwnsErpApp(user, slug);
    const config = await this.readChargilyConfig(slug);
    if (!config) {
      return { configured: false, mode: 'test', enabled: false, maskedKey: '' };
    }
    return {
      configured: true,
      mode: config.mode,
      enabled: config.enabled,
      maskedKey: maskSecret(config.apiSecret),
    };
  }

  /**
   * C6 — @Public() POST /api/v1/apps/:slug/pay/checkout.
   * The PUBLISHED shop (no cookie) calls this with the per-slug data token it
   * already holds. BODY `{ orderRef, amount, dataToken }` → verifies the token
   * (== data-write auth) → creates a Chargily checkout → `{ checkout_url }`.
   * Not configured/enabled ⇒ typed 400 {error:'pay_not_configured'}. Typed
   * errors / passthrough only (a raw HttpException would become a 500).
   */
  @Public()
  @Throttle('strict')
  @Post('/api/v1/apps/:slug/pay/checkout')
  async payCheckout(
    @Param('slug') slug: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ) {
    if (typeof slug !== 'string' || !APP_SLUG_RE.test(slug)) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'invalid_slug' });
      return;
    }
    const dataToken = erpStr(body?.dataToken).trim();
    // Same auth as the data-write path — constant-time verify of the per-slug
    // token. On failure, a generic 401 (no detail leaked).
    if (!dataToken || !verifyDataToken(slug, dataToken)) {
      res.status(HttpStatus.UNAUTHORIZED).json({ error: 'unauthorized' });
      return;
    }
    const orderRef = erpStr(body?.orderRef).trim().slice(0, CHARGILY_ORDER_REF_MAX);
    if (!orderRef) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'orderRef_required' });
      return;
    }
    const amount = Math.round(erpNum(body?.amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount > CHARGILY_MAX_AMOUNT) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'invalid_amount' });
      return;
    }
    const config = await this.readChargilyConfig(slug);
    if (!config || !config.enabled || !config.apiSecret) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'pay_not_configured' });
      return;
    }
    const base = config.mode === 'live' ? CHARGILY_LIVE_BASE : CHARGILY_TEST_BASE;
    const appBase = this.erpAppBase(slug);
    let checkoutUrl = '';
    try {
      const response = await fetch(`${base}/checkouts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiSecret}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          amount,
          currency: 'dzd',
          success_url: `${appBase}/pay/success`,
          webhook_endpoint: `${appBase}/pay/webhook`,
          metadata: { slug, orderRef },
        }),
        signal: AbortSignal.timeout(CHARGILY_TIMEOUT_MS),
      });
      const data = (await response.json().catch(() => null)) as any;
      if (response.ok && data && typeof data.checkout_url === 'string') {
        checkoutUrl = data.checkout_url;
      } else {
        // NEVER log the secret; log only the upstream status.
        this.logger.warn(
          `[pay] chargily checkout failed slug=${slug} status=${response.status}`
        );
      }
    } catch {
      this.logger.warn(`[pay] chargily checkout unreachable slug=${slug}`);
    }
    if (!checkoutUrl) {
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'checkout_failed' });
      return;
    }
    this.logger.log(
      `[pay] checkout slug=${slug} ref=${orderRef.slice(0, 40)} amount=${amount} mode=${config.mode}`
    );
    return { checkout_url: checkoutUrl };
  }

  /**
   * C6 — @Public() POST /api/v1/apps/:slug/pay/webhook.
   * Reads the RAW body (req.rawBody — populated because server.ts bootstraps
   * with rawBody:true) and verifies the `signature` header equals
   * HMAC-SHA256(rawBody, apiSecret) in CONSTANT TIME (safeEqual). On
   * checkout.paid / invoice.paid it marks the order paid via the EXISTING erp
   * order write helper (delete+recreate) — ADDING a `paid:true` field WITHOUT
   * touching the 5 French status strings. Idempotent (a duplicate event that
   * finds the order already paid is a no-op). NEVER logs the signature/secret.
   * Always returns 200 for a VALID-signature event so the provider stops
   * retrying; a bad/missing signature ⇒ typed 401.
   */
  @Public()
  @Post('/api/v1/apps/:slug/pay/webhook')
  async payWebhook(
    @Param('slug') slug: string,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response
  ) {
    if (typeof slug !== 'string' || !APP_SLUG_RE.test(slug)) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'invalid_slug' });
      return;
    }
    const config = await this.readChargilyConfig(slug);
    if (!config || !config.apiSecret) {
      // No config ⇒ nothing to verify against. 400 (not 500) — never leak why.
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'pay_not_configured' });
      return;
    }
    // RAW bytes are REQUIRED — a JSON-parsed body can't reproduce the signed
    // digest. `req.rawBody` is the exact buffer captured by the body parser.
    const raw = req.rawBody;
    if (!raw || raw.length === 0) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'empty_body' });
      return;
    }
    const signature = erpStr(req.headers['signature']).trim();
    const expected = createHmac('sha256', config.apiSecret)
      .update(raw)
      .digest('hex');
    // Constant-time compare (safeEqual hashes both sides → length-safe).
    if (!signature || !safeEqual(expected, signature)) {
      // NEVER log the signature or secret.
      this.logger.warn(`[pay] webhook bad signature slug=${slug}`);
      res.status(HttpStatus.UNAUTHORIZED).json({ error: 'bad_signature' });
      return;
    }
    // Signature verified — parse the event from the RAW bytes.
    let event: any = null;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      // Verified but unparseable — ack so it isn't retried forever.
      res.status(HttpStatus.OK).json({ ok: true });
      return;
    }
    const type = erpStr(event?.type).trim();
    const paidTypes = new Set(['checkout.paid', 'invoice.paid']);
    if (!paidTypes.has(type)) {
      // A valid but non-terminal event (e.g. checkout.failed) — ack, no-op.
      res.status(HttpStatus.OK).json({ ok: true });
      return;
    }
    // Resolve the order ref from the Chargily metadata we set at checkout.
    const data = (event?.data ?? {}) as Record<string, unknown>;
    const meta = (data?.metadata ?? event?.metadata ?? {}) as Record<
      string,
      unknown
    >;
    const orderRef = erpStr(meta?.orderRef).trim();
    if (!orderRef) {
      // Verified but no ref to act on — ack (no retry).
      res.status(HttpStatus.OK).json({ ok: true });
      return;
    }
    // Mark the order paid via the EXISTING delete+recreate order helper path.
    // ADD `paid:true` (+ a paidAt timestamp); DO NOT change the French status.
    const marked = await this.markOrderPaid(slug, orderRef);
    this.logger.log(
      `[pay] webhook slug=${slug} type=${type} ref=${orderRef.slice(0, 40)} -> ${marked}`
    );
    // H4: FAIL-CLOSED — if the settlement lock could not be acquired (Redis down
    // or already locked), return 429 so the provider retries. A double-processed
    // payment is worse than a delayed one. For 'in_progress' (another delivery
    // holds the lock), also return 429 so the provider retries and the next
    // attempt hits 'already'. For all other outcomes (paid, already, not_found,
    // write_failed, no_token), ack 200 so the provider stops retrying.
    if (marked === 'lock_failed' || marked === 'in_progress') {
      res.status(HttpStatus.TOO_MANY_REQUESTS).json({
        ok: false,
        retry: true,
        reason: marked,
      });
      return;
    }
    // Always 200 on a verified event so the provider stops retrying.
    res.status(HttpStatus.OK).json({ ok: true });
  }

  /**
   * C6 helper — flip an order's `paid` flag to true via an in-place upsert on
   * the business key `ref` (the SAME mechanism erpOrderStatus uses). Preserves
   * every field including the exact French `status` string — only ADDS
   * `paid:true` + `paidAt`. Idempotent: an order already `paid:true` is a no-op
   * ('already'). Returns a short status string for logging; NEVER throws (the
   * webhook must ack).
   *
   * MONEY-2: serialised per (slug, orderRef) by an NX lock so two concurrent
   * deliveries of the same payment event cannot both pass the `already` check
   * and both write a caisse entry. H4: FAIL-CLOSED — if the lock cannot be
   * acquired (Redis down OR already locked), returns 'lock_failed' or
   * 'in_progress' and the caller returns 429 so the provider retries. A
   * double-processed payment is worse than a delayed one.
   */
  private async markOrderPaid(
    slug: string,
    orderRef: string
  ): Promise<
    | 'paid'
    | 'already'
    | 'not_found'
    | 'write_failed'
    | 'no_token'
    | 'in_progress'
    | 'lock_failed'
  > {
    const token = dataWriteToken(slug);
    if (!token) return 'no_token';
    // H4: FAIL-CLOSED for payment webhooks. A double-processed payment is worse
    // than a delayed one — the provider (Chargily/Stripe) retries for hours. If
    // the NX lock cannot be acquired (Redis down OR already locked), do NOT
    // process the payment unlocked. Return 'lock_failed' or 'in_progress' so the
    // caller can return a 429 and the provider retries.
    const lockKey = payLockKey(slug, orderRef);
    let locked = false;
    try {
      const acquired = await this.redis.set(
        lockKey,
        new Date().toISOString(),
        'EX',
        PAY_LOCK_TTL_SEC,
        'NX'
      );
      locked = acquired === 'OK';
      if (!locked) return 'in_progress';
    } catch (lockErr) {
      // H4: Redis down — FAIL-CLOSED. Do NOT proceed unlocked. The provider will
      // retry and the next attempt will either acquire the lock or hit 'already'.
      this.logger.error(
        `[pay] settlement lock FAILED (Redis down) slug=${slug} ref=${orderRef.slice(0, 40)}: ${String((lockErr as Error)?.message || lockErr).slice(0, 120)} — NOT processing, provider will retry`
      );
      return 'lock_failed';
    }
    try {
      return await this.markOrderPaidLocked(slug, orderRef, token);
    } finally {
      if (locked) {
        try {
          await this.redis.del(lockKey);
        } catch {
          // Lock expires on its own; nothing to do.
        }
      }
    }
  }

  /** MONEY-2: the critical section of markOrderPaid, run under the NX lock. */
  private async markOrderPaidLocked(
    slug: string,
    orderRef: string,
    token: string
  ): Promise<'paid' | 'already' | 'not_found' | 'write_failed'> {
    const orders = await this.erpList(slug, 'orders');
    if (!orders) return 'write_failed';
    const matches = orders.filter(o => erpStr(o.ref).trim() === orderRef);
    if (matches.length === 0) return 'not_found';
    // Idempotency: if EVERY matching copy is already paid, do nothing.
    if (matches.every(o => o.paid === true)) return 'already';
    const base = matches[0];
    const next: ErpRecord = {};
    for (const k of Object.keys(base)) {
      if (k !== 'id' && k !== 'createdAt') next[k] = base[k];
    }
    // Additive ONLY: set paid; preserve the exact French status string.
    next.paid = true;
    if (!next.paidAt) next.paidAt = new Date().toISOString();
    if (!next.orderedAt) next.orderedAt = erpParseDate(base);
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > ERP_MAX_WRITE_BYTES) {
      return 'write_failed';
    }
    // MONEY-1: upsert IN PLACE, never delete-then-recreate.
    //
    // This used to delete every matching copy and then create a fresh record.
    // If the create failed after the deletes had landed — a 429 from the shared
    // per-slug write budget (the deletes themselves consume it), a network blip,
    // or the collection hitting its record cap — the order was GONE from Redis
    // and from the PG mirror, with no transaction to roll back and no restore
    // path. The webhook still answered 200, so Chargily never retried: a paid
    // order simply ceased to exist, at the exact moment money changed hands.
    //
    // Writing to the FIRST match's existing id closes that window. erpPutRecord
    // is a single atomic HSET, so a concurrent reader sees either the old or the
    // new document, never a gap — the data controller's own upsert() documents
    // this as "the primitive the delete+recreate path cannot give". Duplicate
    // copies (only possible from a pre-fix concurrent write) are cleaned up
    // AFTER the survivor is safely persisted, and their failure is deliberately
    // non-fatal: a lingering duplicate is recoverable, a lost order is not.
    const survivorId = erpStr(matches[0].id);
    if (!survivorId) return 'write_failed';
    const saved = await this.erpPutRecord(
      slug,
      'orders',
      survivorId,
      next,
      token
    );
    if (!saved.ok) return 'write_failed';
    for (const m of matches.slice(1)) {
      const id = erpStr(m.id);
      if (!id || id === survivorId) continue;
      // Best-effort: erpDeleteRecord already logs its own failures.
      await this.erpDeleteRecord(slug, 'orders', id, token);
    }
    // R15: mirror the paid order into the caisse ledger (fail-soft, deduped) so
    // online revenue shows up in day-close/reconcile alongside COD + cash.
    await this.erpWriteChargilyCaisse(slug, next, token);
    return 'paid';
  }
}
