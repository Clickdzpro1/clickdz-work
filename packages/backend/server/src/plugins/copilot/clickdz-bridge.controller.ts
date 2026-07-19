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
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
// SECURITY: cryptographically strong randomness for unguessable auto-slugs.
import { randomBytes } from 'node:crypto';

// WS4 publish-cap: the global AuthGuard already authenticates these first-party
// routes (no @Public / no bridge token). `CurrentUser` just RECEIVES the
// already-verified session user so the per-owner cap can key on identity.
import { CurrentUser, Public } from '../../core/auth';
// SECURITY: hard per-IP rate cap for cost/side-effecting routes (strict = 20/min).
// AuthenticationRequired -> typed 401 (raw HttpException becomes a generic 500 here).
// WS4: BadRequest/NotFound are the typed 4xx (a raw HttpException becomes a
// generic 500 through the global filter — see the vdz controller / LANDMINES).
// WS11/C6: ActionForbidden is the typed 403 for the ERP ownership gate.
import { ActionForbidden, AuthenticationRequired, BadRequest, NotFound, Throttle } from '../../base';
// WS4: per-owner published-apps set, mimicking the vdz controller's CacheRedis
// pattern. RedisModule is @Global, so injecting it needs no module wiring.
import { CacheRedis } from '../../base/redis';
// WS4 premium gate (env-gated OFF by default): ModelsModule is @Global, so
// `models.userFeature.has(userId, 'pro_plan_v1')` needs no module wiring.
import { Models } from '../../models';
import {
  buildEditContent,
  buildNewAppContent,
  type AppHistoryTurn,
  type AppSelectionContext,
} from './clickdz-app-prompt';
// SECURITY: constant-time token compare + per-slug Data API write tokens.
import { dataWriteToken, safeEqual } from './cdz-data-token';
// WS3 templates — COMPLETE single-file HTML apps authored in sibling files
// (Merchant/Clerk own them, in parallel). We code against the export names; the
// files may not exist locally yet. Each contains the SAME placeholder tokens the
// generate path emits (__CLICKDZ_DATA_URL__ / __CLICKDZ_DATA_TOKEN__) plus
// __CLICKDZ_SLUG__, which /apps/template substitutes with the real minted values.
import { CLICKDZ_SHOP_TEMPLATE_HTML } from './clickdz-shop-template';
import { CLICKDZ_ERP_TEMPLATE_HTML } from './clickdz-erp-template';

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

const MAKE_API_BASE = process.env.MAKE_API_BASE || 'https://eu1.make.com/api/v2';
const MAKE_API_KEY = process.env.MAKE_API_KEY || '';
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID || '';
const MAKE_AGENT_ID = process.env.MAKE_SUPERAGENT_ID || process.env.MAKE_AGENT_ID || '';
const MAKE_ARABIC_AGENT_ID = process.env.MAKE_ARABIC_AGENT_ID || MAKE_AGENT_ID;
// WS1 (CDZIMAGE): ONE unified OpenAI key for all image generation. Order:
// the dedicated image key, then the app's canonical OPEN_AI (present on
// prod), then the generic fallback.
const OPENAI_IMAGE_API_KEY =
  process.env.OPENAI_IMAGE_API_KEY ||
  process.env.OPEN_AI ||
  process.env.OPENAI_API_KEY ||
  '';
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
const DEEPGRAM_TTS_DEFAULT_VOICE = 'aura-2-thalia-en';
const DEEPGRAM_TTS_VOICES = [
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
] as const;
// OpenAI /v1/audio/speech voices (tts-1). The frontend renders exactly these
// for the OpenAI card. Unknown/empty -> 'alloy'. `speed` is clamped 0.25–4.0
// per the OpenAI contract; Deepgram has no speed knob so it is ignored there.
const OPENAI_TTS_DEFAULT_VOICE = 'alloy';
const OPENAI_TTS_VOICES = [
  'alloy',
  'echo',
  'fable',
  'onyx',
  'nova',
  'shimmer',
] as const;
const MAKE_OCR_WEBHOOK_URL = process.env.MAKE_OCR_WEBHOOK_URL || '';
const MAKE_CODE_AGENT_ID = process.env.MAKE_CODE_AGENT_ID || '';
const MAKE_BUILDER_AGENT_ID = process.env.MAKE_BUILDER_AGENT_ID || '';
// machine access token for external OpenAI-compatible clients
// (ClickDz Builder / bolt.diy). Unset = machine access disabled.
const CLICKDZ_BRIDGE_TOKEN = process.env.CLICKDZ_BRIDGE_TOKEN || '';
const CDZ_AI_BASE_URL = (
  process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai'
).replace(/\/+$/, '');
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';
// CDZ_AI direct-path models: the OpenAI-compatible `cdz-*` catalog served by
// CDZ_AI_BASE_URL (same ids `runFastPlanner`/pulse/vdz use). ONLY these can be
// real-streamed pass-through (A1); the marketing `clickdz-*` ids map to the
// Make agent, which has no token stream, so they keep the buffered path.
const CDZ_DIRECT_STREAM_MODELS = new Set([
  'cdz-ultra',
  'cdz-council',
  'cdz-sage',
  'cdz-architect',
  'cdz-scholar',
  'cdz-flash',
  'cdz-polyglot',
]);
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
// Slug shape shared by generate/deploy (same as the SLUG_RE the data API uses).
const APP_SLUG_RE = /^[a-z0-9-]{3,50}$/;

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
// CDZIMAGE tiers (WS1) — display aliases over OpenAI gpt-image engines.
// 2.0 = flagship default, 1.5 = balanced, 1.0 = economy (UI exposes 1.0 in
// Vdz only, per owner decision; the server accepts all three). dall-e-* and
// bare gpt-image-1 are RETIRED as targets (gpt-image-1 deprecates upstream
// 2026-10-23) — legacy ids resolve to the nearest tier so old clients keep
// working during the transition.
// ---------------------------------------------------------------------------
const CDZIMAGE_TIERS: Record<
  string,
  { engine: string; quality: 'low' | 'medium' | 'high'; label: string }
> = {
  'cdzimage-2.0': { engine: 'gpt-image-2', quality: 'high', label: 'CDZIMAGE 2.0' },
  'cdzimage-1.5': { engine: 'gpt-image-1.5', quality: 'medium', label: 'CDZIMAGE 1.5' },
  'cdzimage-1.0': { engine: 'gpt-image-1-mini', quality: 'low', label: 'CDZIMAGE 1.0' },
};
const CDZIMAGE_DEFAULT_TIER = 'cdzimage-2.0';
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

const MODELS = [
  'clickdz-ultra',
  'clickdz-builder',
  'clickdz-fast',
  'clickdz-smart',
  'clickdz-arabic',
  'gpt-5.5',
  'gpt-5-mini',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'gemini-3.5-flash',
  'gemini-2.5-pro',
  // CDZIMAGE tiers (dall-e-3 retired; legacy ids still resolve server-side)
  'cdzimage-2.0',
  'cdzimage-1.5',
  'cdzimage-1.0',
];

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
// Verbatim default tagline from the shop template's defaultSettings().
const ERP_DEFAULT_TAGLINE =
  'Produits de qualité, livrés partout en Algérie — paiement à la livraison.';

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
 */
function normalizeErpSettings(row: ErpRecord | undefined) {
  const accent = erpStr(row?.accent);
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
    accent: CDZ_ACCENT_RE.test(accent) ? accent : CDZ_TPL_DEFAULT_ACCENT,
    currency: erpStr(row?.currency).trim() || 'DZD',
  };
}

@Controller()
export class ClickDzBridgeController {
  private readonly logger = new Logger(ClickDzBridgeController.name);

  // WS4: CacheRedis for the per-owner published-apps set (same injection style
  // as clickdz-vdz.controller.ts), and Models for the optional premium gate.
  // Both providers are @Global, so this adds no module wiring.
  constructor(
    private readonly redis: CacheRedis,
    private readonly models: Models
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
      const [pro, lifetime] = await Promise.all([
        this.models.userFeature.has(user.id, 'pro_plan_v1'),
        this.models.userFeature.has(user.id, 'lifetime_pro_plan_v1'),
      ]);
      if (pro || lifetime) return true;
    } catch (e) {
      // On a feature-store hiccup, fail CLOSED for the paid gate (deny) — the
      // gate exists to protect publishing. Log and treat as not-entitled.
      this.logger.warn(
        `[apps] premium-gate feature lookup failed for user=${user.id}: ${String(e)}`
      );
    }
    res.status(HttpStatus.PAYMENT_REQUIRED).json({ error: 'upgrade_required' });
    return false;
  }

  /**
   * WS4 cap enforcement, folded into the deploy path. Returns true when the
   * deploy may proceed. When a NEW slug would exceed the per-owner cap, writes
   * the exact contract 409 body and returns false. Same-slug redeploy is always
   * allowed. An optional body.replaceSlug is unpublished FIRST (freeing a slot).
   */
  private async assertUnderPublishCap(
    ownerId: string,
    slug: string,
    replaceSlug: string | undefined,
    res: Response
  ): Promise<boolean> {
    // replaceSlug: unpublish that slug first (Vercel delete + srem), freeing a
    // slot before the cap check. Fail-soft on Vercel 404 (still srem).
    if (replaceSlug && replaceSlug !== slug) {
      await this.deleteAppFromVercel(replaceSlug);
      await this.sremPublishedApp(ownerId, replaceSlug);
    }
    const existing = await this.readPublishedApps(ownerId);
    // Same-slug redeploy never grows the set — always allowed.
    if (existing.some(r => r.slug === slug)) return true;
    if (existing.length >= CDZ_PUBLISH_MAX_APPS) {
      res.status(HttpStatus.CONFLICT).json({
        error: 'publish_limit_reached',
        limit: CDZ_PUBLISH_MAX_APPS,
        existing: existing.map(r => ({ slug: r.slug, url: r.url })),
      });
      return false;
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
  private async deleteAppFromVercel(slug: string): Promise<void> {
    if (!VERCEL_TOKEN) return;
    const projectName = `clickdz-app-${slug}`.slice(0, 52);
    const teamQuery = VERCEL_TEAM_ID
      ? `?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`
      : '';
    try {
      const res = await fetch(
        `https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}${teamQuery}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
          signal: AbortSignal.timeout(15000),
        }
      );
      // 200/204 = deleted; 404 = already absent (fail-soft). Anything else is
      // logged but swallowed so the Redis bookkeeping still proceeds.
      if (!res.ok && res.status !== 404) {
        this.logger.warn(
          `[apps] Vercel project delete for ${projectName} returned ${res.status}`
        );
      }
    } catch (e) {
      this.logger.warn(
        `[apps] Vercel project delete for ${projectName} failed: ${String(e)}`
      );
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
            model: 'cdz-flash',
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
          model: 'cdz-flash',
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
  private async streamCdzChat(
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
  models(@Req() req: Request) {
    this.assertBridgeToken(req);
    return {
      object: 'list',
      data: MODELS.map(id => ({
        id,
        object: 'model',
        created: now(),
        owned_by: id.startsWith('cdzimage-') ? 'openai-images' : 'make.com',
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
    const model = body?.model || 'clickdz-smart';
    const messages = normalizeMessages(body?.messages || []);

    // REAL streaming (A1), opt-in behind the SAME `body.stream` flag: only for
    // the CDZ_AI direct-path `cdz-*` models when a key is configured. Everything
    // else (marketing `clickdz-*` → Make, or no CDZ_AI key) is UNCHANGED below.
    // Pipes upstream SSE deltas straight through; on a clean upstream failure it
    // returns false and we fall back to the existing buffered path — no
    // regression to the OpenAI-shape contract external clients consume.
    if (body?.stream && CDZ_AI_KEY && CDZ_DIRECT_STREAM_MODELS.has(model)) {
      // Tie an AbortController to the response lifecycle: `close` fires when the
      // client disconnects, letting us cancel the upstream fetch. (`res.on` is
      // always available and typed; Express 4's `req.signal` is not.)
      const clientAbort = new AbortController();
      res.on('close', () => clientAbort.abort());
      const streamed = await this.streamCdzChat(
        res,
        id,
        model,
        messages,
        clampMaxTokens(body?.max_tokens, DEFAULT_MAX_TOKENS),
        clientAbort.signal
      );
      if (streamed) return;
      // else: upstream didn't start — fall through to the buffered path.
    }

    const agentOverride = this.resolveAgentForRequest(model, messages);
    const content = await this.runMakeAgent(messages, model, agentOverride);

    if (body?.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`
      );
      const chunks = content.match(/.{1,48}(\s|$)/g) || [content];
      for (const chunk of chunks) {
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`
        );
      }
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
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
        {
          error: {
            message: 'A request is required',
            type: 'invalid_request_error',
            code: 'request_missing',
          },
        },
        HttpStatus.BAD_REQUEST
      );
    }
    // SECURITY: cap request size on this cost-triggering route (413).
    if (request.length > MAX_PROMPT_CHARS) {
      throw new PayloadTooLargeException(
        `Request is too long (max ${MAX_PROMPT_CHARS} characters)`
      );
    }

    const raw = await this.runFastPlanner(request);

    return parsePlanClarification(raw);
  }

  /**
   * CDZIMAGE detail-gathering (WS1 PR6): one fast, SKIPPABLE clarification
   * before an image generation. cdz-flash inspects the prompt and returns
   * `needs_details` + one decisive question with 2–4 concrete option chips +
   * suggested enrichments. Rich prompts auto-skip (`needs_details: false`).
   * FAIL-OPEN CONTRACT: any parse/model failure returns needs_details:false —
   * a clarifier hiccup must never block generation, and the client's
   * "Generate now" button simply ignores the card.
   */
  @Throttle('strict')
  @Post('/api/v1/images/clarify')
  async clarifyImagePrompt(@Body() body: any) {
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      throw new HttpException(
        {
          error: {
            message: 'A non-empty "prompt" string is required',
            type: 'invalid_request_error',
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
            model: 'cdz-flash',
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
      const response = await fetch(MAKE_OCR_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_url: fileUrl }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) return '';
      const data = (await response.json()) as { text?: string };
      return typeof data?.text === 'string' ? data.text.slice(0, 4000) : '';
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
            model: 'cdz-flash',
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
            model: 'cdz-flash',
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
  async imageGenerations(@Body() body: any) {
    if (!OPENAI_IMAGE_API_KEY) {
      throw new HttpException(
        { error: { message: 'OpenAI image generation key is not configured', type: 'configuration_error', code: 'openai_image_key_missing' } },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
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

    // ---- Prompt-pro (always on for tier/legacy/default requests) ---------
    // Raw-engine requests (OpenAI-compatible machine clients) keep their
    // prompt verbatim; `enhance: false` is the explicit opt-out for everyone.
    // Edit mode enhances the INSTRUCTION only (the engine sees the pixels);
    // reinterpret mode folds the vision description into the enhancement.
    let prompt = String(body?.prompt || '');
    let enhancedPrompt: string | undefined;
    let ocrUsed = false;
    const wantsEnhance =
      body?.enhance !== false && resolution.source !== 'raw-engine';
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
    // (all CDZIMAGE engines are gpt-image-*, guard kept for safety.)
    const isGptImage = String(model).startsWith('gpt-image');
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

    let response: Awaited<ReturnType<typeof fetch>>;
    if (i2iMode === 'edit') {
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
    const data = (await response.json()) as any;
    if (!response.ok) {
      throw new HttpException(data, response.status);
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
      ...(i2iMode !== 'none'
        ? {
            i2i: {
              mode: i2iMode,
              mask_used: i2iMode === 'edit' && Boolean(maskRef),
            },
          }
        : {}),
    };
    return data;
  }

  /** deploy a single-file app to Vercel and wait briefly for it to go live */
  private async deployAppToVercel(slug: string, html: string) {
    const projectName = `clickdz-app-${slug}`.slice(0, 52);
    const teamQuery = VERCEL_TEAM_ID
      ? `?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`
      : '';
    const createRes = await fetch(
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
    const created = (await createRes.json()) as any;
    if (!createRes.ok) {
      throw new HttpException(
        { error: { message: created?.error?.message || 'Vercel deployment failed', type: 'provider_error', code: 'vercel_deploy_failed' } },
        HttpStatus.BAD_GATEWAY
      );
    }
    // poll briefly until the deployment is READY (static deploys are fast)
    let state = created.readyState as string;
    for (let i = 0; i < 10 && state !== 'READY' && state !== 'ERROR'; i++) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const pollRes = await fetch(
        `https://api.vercel.com/v13/deployments/${created.id}${teamQuery}`,
        {
          headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
          signal: AbortSignal.timeout(15000),
        }
      );
      const polled = (await pollRes.json()) as any;
      state = polled.readyState || state;
    }
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
      const domains = (await domainsRes.json()) as any;
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
      slug,
      state,
      url: liveUrl ?? `https://${projectName}.vercel.app`,
      deploymentUrl: created.url ? `https://${created.url}` : undefined,
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
    const slug =
      typeof body?.slug === 'string' && /^[a-z0-9-]{3,50}$/.test(body.slug)
        ? body.slug
        : slugifyAppName(prompt);
    this.logger.log(
      `[apps] generate (${currentHtml ? 'edit' : 'new'}) user=${user.id} slug=${slug} prompt=${prompt.slice(0, 80)}`
    );
    let html = await this.buildAppHtml(prompt, currentHtml, history, selection);
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
      .replaceAll('__CLICKDZ_DATA_TOKEN__', dataWriteToken(slug));
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
    if (!VERCEL_TOKEN) {
      throw new HttpException(
        { error: { message: 'Vercel deployment is not configured', type: 'configuration_error', code: 'vercel_token_missing' } },
        HttpStatus.SERVICE_UNAVAILABLE
      );
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
    if (!(await this.assertUnderPublishCap(user.id, slug, replaceSlug, res))) {
      return;
    }
    // C5: optional pairing metadata. A ShopERP deploy passes kind ('shop'|'erp')
    // and the shared storeSlug so GET /apps/mine can label + pair them. Both are
    // validated/normalized and simply omitted when absent (legacy/plain apps).
    const kindRaw = String(body?.kind || '').trim().toLowerCase();
    const kind: 'shop' | 'erp' | undefined =
      kindRaw === 'shop' || kindRaw === 'erp' ? kindRaw : undefined;
    const storeSlug =
      typeof body?.storeSlug === 'string' && APP_SLUG_RE.test(body.storeSlug)
        ? body.storeSlug
        : undefined;
    if (!html.includes('Built with ClickDz') && html.includes('</body>')) {
      html = html.replace('</body>', `${CLICKDZ_APP_WATERMARK}</body>`);
    }
    this.logger.log(
      `[apps] deploying ${html.length} chars as slug=${slug} user=${user.id}`
    );
    const deployed = await this.deployAppToVercel(slug, html);
    this.logger.log(`[apps] deployed: ${deployed.url} (${deployed.state})`);
    // WS4: record the successful publish under the caller's set (idempotent per
    // slug) so it counts toward the cap and appears in GET /apps/mine.
    await this.recordPublishedApp(user.id, slug, deployed.url, {
      kind,
      storeSlug,
    });
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
    const dataToken = dataWriteToken(slug);
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
    html = html
      .split('__CLICKDZ_DATA_URL__')
      .join(dataUrl)
      .split('__CLICKDZ_DATA_TOKEN__')
      .join(dataToken)
      .split('__CLICKDZ_SLUG__')
      .join(slug)
      .split('__CLICKDZ_STORE_NAME__')
      .join(tokens.storeName)
      .split('__CLICKDZ_WHATSAPP__')
      .join(tokens.whatsapp)
      .split('__CLICKDZ_ACCENT__')
      .join(tokens.accent)
      .split('__CLICKDZ_PIN__')
      .join(tokens.pin);
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
    await this.deleteAppFromVercel(slug);
    await this.sremPublishedApp(user.id, slug);
    this.logger.log(`[apps] unpublished slug=${slug} user=${user.id}`);
    return { ok: true };
  }

  @Throttle('strict')
  @Post('/api/voice/token')
  async deepgramToken() {
    if (!DEEPGRAM_API_KEY) {
      throw new HttpException({ error: 'Deepgram is not configured' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: 60 }),
    });
    const data = (await response.json()) as any;
    if (!response.ok) {
      throw new HttpException(data, response.status);
    }
    return data;
  }

  /**
   * GET /api/voice/capabilities — what the Voice Studio can offer right now.
   *
   * Purely a reflection of which provider keys are set on the deployment, so
   * the frontend can render each provider card enabled/disabled with the right
   * voice list WITHOUT probing a real generation. Auth'd like the rest of the
   * voice surface (session cookie). No key => that provider `available:false`;
   * the page then disables its card and shows a tooltip. Additive, read-only.
   */
  @Throttle('strict')
  @Get('/api/voice/capabilities')
  voiceCapabilities() {
    return {
      transcription: {
        // STT is OpenAI Whisper only (the working path). No key => the
        // Transcribe tab shows a friendly "not configured" state.
        available: !!OPENAI_VOICE_API_KEY,
        provider: 'openai' as const,
        model: 'whisper-1',
      },
      tts: {
        // Default provider preserved as Deepgram (current behaviour).
        defaultProvider: 'deepgram' as const,
        providers: [
          {
            id: 'deepgram' as const,
            label: 'Deepgram Aura-2',
            available: !!DEEPGRAM_API_KEY,
            voices: DEEPGRAM_TTS_VOICES,
            defaultVoice: DEEPGRAM_TTS_DEFAULT_VOICE,
            supportsSpeed: false,
          },
          {
            id: 'openai' as const,
            label: 'OpenAI',
            available: !!OPENAI_VOICE_API_KEY,
            voices: OPENAI_TTS_VOICES,
            defaultVoice: OPENAI_TTS_DEFAULT_VOICE,
            supportsSpeed: true,
          },
        ],
      },
    };
  }

  /**
   * POST /api/voice/tts (and the legacy /api/copilot/voice/tts alias) — text
   * to speech. Streams raw `audio/mpeg` bytes on success (unchanged wire shape).
   *
   * BODY: `{ text, provider?: 'deepgram'|'openai', voice?, speed? }`.
   *  • provider omitted / 'deepgram'  -> EXACT current behaviour: Deepgram
   *    Aura-2 /v1/speak, default model 'aura-2-thalia-en'. Do NOT break this.
   *  • provider 'openai'              -> OpenAI /v1/audio/speech (tts-1, mp3),
   *    voices alloy/echo/fable/onyx/nova/shimmer, optional `speed` 0.25–4.0.
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
      const speedNum = Number(body?.speed);
      const payload: Record<string, unknown> = {
        model: 'tts-1',
        input: text,
        voice,
        response_format: 'mp3',
      };
      if (Number.isFinite(speedNum) && speedNum > 0) {
        payload.speed = Math.max(0.25, Math.min(4, speedNum));
      }
      const response = await fetch(OPENAI_SPEECH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_VOICE_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
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
          `[voice] openai tts upstream ${response.status} detail=${detail.slice(0, 200)}`
        );
        res.status(HttpStatus.BAD_GATEWAY).json({
          error: 'tts_failed',
          provider: 'openai',
          status: response.status,
        });
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(buffer);
      return;
    }

    // provider === 'deepgram' — unchanged working path (extended only with the
    // 501 contract body when the key is missing, replacing the old 503 throw).
    if (!DEEPGRAM_API_KEY) {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json({ error: 'provider_unavailable', provider: 'deepgram' });
      return;
    }
    const model = body?.voice || DEEPGRAM_TTS_DEFAULT_VOICE;
    const response = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'tts_failed',
        provider: 'deepgram',
        status: response.status,
      });
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
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
    const res = await fetch(
      `${this.erpDataBase(slug)}/${collection}?limit=500`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(ERP_DATA_TIMEOUT_MS),
      }
    ).catch(() => null);
    if (!res || !res.ok) {
      this.logger.warn(
        `[erp] list failed slug=${slug} coll=${collection} status=${res ? res.status : 'unreachable'}`
      );
      return null;
    }
    const data = (await res.json().catch(() => null)) as unknown;
    return Array.isArray(data) ? (data as ErpRecord[]) : null;
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
  @Throttle('strict')
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
    const lowStock = products.filter(
      p => p.reorderAt != null && erpNum(p.stock) <= erpNum(p.reorderAt)
    );
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
    // Size-check BEFORE deleting: a rejected recreate must never cost the
    // original record.
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > ERP_MAX_WRITE_BYTES) {
      throw new BadRequest('Order record too large');
    }
    for (const m of matches) {
      const id = erpStr(m.id);
      if (!id) continue;
      if (!(await this.erpDeleteRecord(slug, 'orders', id, token))) {
        res
          .status(HttpStatus.BAD_GATEWAY)
          .json({ error: 'data_write_failed' });
        return;
      }
    }
    const created = await this.erpCreateRecord(slug, 'orders', next, token);
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
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
    for (const m of matches) {
      const id = erpStr(m.id);
      if (!id) continue;
      if (!(await this.erpDeleteRecord(slug, 'products', id, token))) {
        res
          .status(HttpStatus.BAD_GATEWAY)
          .json({ error: 'data_write_failed' });
        return;
      }
    }
    const created = await this.erpCreateRecord(slug, 'products', merged, token);
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
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
    if (badField) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'invalid_settings', field: badField });
      return;
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequest(
        '"patch" must include at least one of: shopName, tagline, whatsapp, deliveryFee, accent, adminPin'
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
    const merged: ErpRecord = {
      ...normalizeErpSettings(baseRow),
      ...patch,
      key: 'settings',
    };
    if (
      Buffer.byteLength(JSON.stringify(merged), 'utf8') > ERP_MAX_WRITE_BYTES
    ) {
      throw new BadRequest('Settings record too large');
    }
    // Replace the singleton: drop EVERY existing row first (self-heals
    // duplicate singletons left by crashed replaces), then recreate.
    for (const row of rows) {
      const id = erpStr(row.id);
      if (!id) continue;
      if (!(await this.erpDeleteRecord(slug, 'settings', id, token))) {
        res
          .status(HttpStatus.BAD_GATEWAY)
          .json({ error: 'data_write_failed' });
        return;
      }
    }
    const created = await this.erpCreateRecord(slug, 'settings', merged, token);
    if (!created.ok) {
      this.erpWriteFailed(res, created.status);
      return;
    }
    this.logger.log(
      `[erp] settings saved slug=${slug} user=${user.id} fields=${Object.keys(patch).join(',')}`
    );
    return { ok: true, settings: created.record };
  }
}
