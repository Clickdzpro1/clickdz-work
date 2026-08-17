/**
 * clickdz-social.service.ts — P3 Social Studio: shared publish logic.
 *
 * ClickDzSocialService owns:
 *  - Social-post data types (SocialPost, SocialTarget, SocialMedia, …)
 *  - Redis key builders + caps/TTLs (mirror flows/runs idiom)
 *  - Static per-network action map + live-discovery fallback
 *  - Persistence helpers: readPost, writePost, listPostSummaries,
 *    deletePost, appendPublishedLog
 *  - The shared publishPost() routine used by BOTH the controller
 *    (publish-now) and the BullMQ job worker (scheduled publish)
 *
 * Depends on:
 *  - Cache (@Global provider — fail-soft JSON Redis get/set/mapSet/mapKeys)
 *  - Plain fetch (same as the controller — no new deps)
 *
 * Per-user isolation: every Redis key and every Composio execute carries
 * user.id. No data is readable cross-user.
 *
 * Dark-by-default: publishPost() returns early with all targets
 * status:'failed' when COMPOSIO_API_KEY is absent (same convention as the
 * controller's 409 paths — the job worker logs, the route returns 409).
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { Cache } from '../../base';

// ---------------------------------------------------------------------------
// Module-level env reads (mirrors the controller's pattern).
// ---------------------------------------------------------------------------

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || '';
const COMPOSIO_TOOLS_EXECUTE_URL =
  'https://backend.composio.dev/api/v3/tools/execute';
const COMPOSIO_TOOLS_URL = 'https://backend.composio.dev/api/v3/tools';
const COMPOSIO_CONNECTED_ACCOUNTS_URL =
  'https://backend.composio.dev/api/v3/connected_accounts';
// UP1 — single connected-account GET, used to poll one account's live OAuth
// status (ACTIVE | INITIATED | INITIALIZING | EXPIRED | FAILED) after the user
// returns from the hosted auth-link tab. The list endpoint above stays the
// source of truth for the accounts grid; this is the cheap "did it connect?"
// poll the Connections view fires while a card shows "Connexion…".
const COMPOSIO_CONNECTED_ACCOUNT_ONE_URL =
  'https://backend.composio.dev/api/v3/connected_accounts';

// ---------------------------------------------------------------------------
// Social post data types (P3 plan §2 — mirror exactly so service + controller
// + job + FE api.ts all speak the same shapes).
// ---------------------------------------------------------------------------

export type SocialStatus =
  | 'draft'
  // UP1 — approval workflow: a draft the author submits for review sits in
  // 'pending-approval' until an approver moves it to 'scheduled'/publishes it.
  // Only surfaced when the workspace's queue rules set approvalRequired:true.
  | 'pending-approval'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'partial'
  | 'failed';

export interface SocialTarget {
  network: string;             // toolkit slug: 'twitter' | 'linkedin' | …
  action?: string;             // resolved create-post action slug (filled at publish)
  text?: string;               // per-network override; falls back to post.text
  status: 'pending' | 'ok' | 'failed';
  externalId?: string;         // returned post/tweet id when the action exposes it
  externalUrl?: string;        // permalink when derivable
  error?: string;              // truncated failure detail
  attempts: number;
}

export interface SocialMedia {
  kind: 'image' | 'video';
  url: string;                 // PUBLIC url handed to Composio
  mime?: string;
  width?: number;
  height?: number;
  alt?: string;
}

export interface SocialPost {
  id: string;
  userId: string;
  text: string;                // base caption
  media: SocialMedia[];
  targets: SocialTarget[];
  status: SocialStatus;
  scheduledAt?: number;        // epoch ms; absent ⇒ draft or immediate
  jobId?: string;              // BullMQ delayed job id
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
  lastError?: string;
  // UP1 — how many times the Plan-B/auto-requeue path has re-scheduled this
  // post after a failed publish (bounded by queue.autoRequeueMaxAttempts).
  autoRequeueAttempts?: number;
  // UP1 — first-comment text captured at compose time (per queue/network
  // defaults or explicit); posted as a follow-up after the main post succeeds.
  firstComment?: string;
}

export interface SocialPostSummary {
  id: string;
  status: SocialStatus;
  text: string;                // truncated preview
  networks: string[];
  scheduledAt?: number;
  publishedAt?: number;
  updatedAt: number;
  hasMedia: boolean;
}

export interface PublishedLogEntry {
  postId: string;
  publishedAt: number;
  results: Array<{
    network: string;
    ok: boolean;
    externalUrl?: string;
    // UP1 — richer log rows so the Journal can show per-network error detail +
    // the resolved action slug + attempt count (extends log.tsx). All optional
    // so historical entries (written before UP1) still deserialize cleanly.
    error?: string;
    action?: string;
    attempts?: number;
  }>;
}

// ---------------------------------------------------------------------------
// UP1 — Advanced per-workspace Social settings (persisted per-user through the
// same JSON Cache as posts). Two layers:
//   - defaults: per-network content defaults (hashtags, UTM, first-comment,
//     posting windows) applied at publish time / suggested in the composer.
//   - queue: workspace-wide posting rules (rate caps, min gap, backoff,
//     approval gate) enforced by the controller when scheduling.
// Everything is optional and fail-open: an absent settings blob means today's
// behaviour byte-for-byte (no hashtags appended, no UTM, no approval gate).
// ---------------------------------------------------------------------------

/** One weekday+hour posting-window suggestion (0=Sunday..6=Saturday, 0..23h). */
export interface PostingWindow {
  day: number; // 0..6 (Sun..Sat)
  hour: number; // 0..23 (local to `timezone`)
}

/** Per-network content defaults. Every field optional (fail-open). */
export interface NetworkDefaults {
  /** Hashtags appended to the caption when the post targets this network. */
  hashtags?: string[];
  /** First-comment text posted as a follow-up after the main post (best-effort). */
  firstComment?: string;
  /** Preferred posting windows (used for best-time suggestion chips + validation hints). */
  windows?: PostingWindow[];
}

/** Workspace-wide UTM link parameters appended to the FIRST URL in a caption. */
export interface UtmSettings {
  enabled?: boolean;
  source?: string; // utm_source (default 'social' when enabled + empty)
  medium?: string; // utm_medium (default the network slug)
  campaign?: string; // utm_campaign
}

/** Workspace-wide queue rules enforced when scheduling / publishing. */
export interface QueueRules {
  /** Max posts per network per rolling 24h. 0/absent = unlimited. */
  maxPerDayPerNetwork?: number;
  /** Minimum gap (minutes) between two scheduled posts. 0/absent = no gap. */
  minGapMinutes?: number;
  /** Auto-requeue a failed scheduled publish with exponential backoff. */
  autoRequeueOnFailure?: boolean;
  /** How many auto-requeue attempts before giving up (default 3, cap 6). */
  autoRequeueMaxAttempts?: number;
  /** Require approval: new posts land in 'pending-approval' before queueing. */
  approvalRequired?: boolean;
}

export interface SocialSettings {
  /** IANA timezone the posting windows are expressed in (e.g. 'Africa/Algiers'). */
  timezone?: string;
  /** Per-network content defaults, keyed by network slug. */
  networks?: Record<string, NetworkDefaults>;
  utm?: UtmSettings;
  queue?: QueueRules;
  updatedAt?: number;
}

/** Richer connected-account view for the Connections grid (UP1). */
export interface DetailedAccount {
  network: string;
  connected: boolean;
  status?: string; // Composio status: ACTIVE | INITIATED | INITIALIZING | EXPIRED | FAILED
  accountId?: string;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Caps / TTLs
// ---------------------------------------------------------------------------

export const SOCIAL_POST_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
export const SOCIAL_TEXT_MAX = 5000;
export const SOCIAL_TARGETS_MAX = 5; // mirrors RUN_MAX_TOOLKITS
export const SOCIAL_MEDIA_MAX = 4;
export const SOCIAL_INDEX_CAP = 500;
export const SOCIAL_SCHEDULE_MAX_AHEAD_MS = 180 * 24 * 60 * 60 * 1000;
export const SOCIAL_RETRY_MAX_ATTEMPTS = 4;
const SOCIAL_PUBLISH_TIMEOUT_MS = 25_000; // per-network execute budget
const SOCIAL_RETRY_BASE_MS = 500;
const SOCIAL_RETRY_CAP_MS = 8_000;

// UP1 — advanced-settings caps + auto-requeue defaults. Bounds keep an
// untrusted PUT /settings body well under the 8KB-ish record budget the sibling
// controllers use for JSON singletons.
export const SOCIAL_SETTINGS_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
export const SOCIAL_HASHTAGS_MAX = 15; // per network
export const SOCIAL_HASHTAG_LEN_MAX = 60;
export const SOCIAL_FIRST_COMMENT_MAX = 500;
export const SOCIAL_WINDOWS_MAX = 12; // per network
export const SOCIAL_UTM_FIELD_MAX = 80;
export const SOCIAL_TIMEZONE_MAX = 64;
export const SOCIAL_MAX_PER_DAY_CAP = 100; // clamp maxPerDayPerNetwork
export const SOCIAL_MIN_GAP_CAP = 720; // clamp minGapMinutes (12h)
export const SOCIAL_AUTO_REQUEUE_DEFAULT_ATTEMPTS = 3;
export const SOCIAL_AUTO_REQUEUE_MAX_ATTEMPTS = 6;
// Backoff between auto-requeue attempts grows 5min → 15min → 45min … capped.
const SOCIAL_AUTO_REQUEUE_BASE_MS = 5 * 60 * 1000;
const SOCIAL_AUTO_REQUEUE_CAP_MS = 6 * 60 * 60 * 1000; // 6h

// Text truncation cap for summaries (mirrors truncatePreview in controller).
const SUMMARY_TEXT_CAP = 120;

/**
 * UP1 — public backoff delay (ms) for the Nth (1-based) auto-requeue attempt of
 * a failed scheduled publish: 5min * 3^(n-1), capped at 6h. Exposed so the job
 * worker can compute the next scheduledAt when queue.autoRequeueOnFailure is on.
 */
export function autoRequeueDelayMs(attempt: number): number {
  const exp = SOCIAL_AUTO_REQUEUE_BASE_MS * Math.pow(3, Math.max(0, attempt - 1));
  return Math.min(exp, SOCIAL_AUTO_REQUEUE_CAP_MS);
}

// ---------------------------------------------------------------------------
// Redis key builders (per-user, mirrors flowKey/flowIndexKey pattern exactly).
// ---------------------------------------------------------------------------

export const socialPostKey = (userId: string, postId: string) =>
  `clickdz:social:post:${userId}:${postId}`;

export const socialPostIndexKey = (userId: string) =>
  `clickdz:social:postindex:${userId}`;

export const socialLogKey = (userId: string) =>
  `clickdz:social:log:${userId}`;

// UP1 — per-user advanced Social settings singleton (mirrors hermesConfigKey).
export const socialSettingsKey = (userId: string) =>
  `clickdz:social:settings:${userId}`;

// WS17: global index of userIds that have at least one scheduled post — the
// Plan-B cron sweep iterates this to find past-due 'scheduled' posts whose
// BullMQ job was lost (Redis flush / worker restart). A JSON array under a
// single key (the Cache provider doesn't expose SCAN or sadd/smembers).
export const socialSchedulersKey = () => 'clickdz:social:schedulers';

// ---------------------------------------------------------------------------
// Static per-network action map (verified slugs from P3 plan §1).
// Fallback to live discovery when a slug is missing (resolveSocialAction).
// ---------------------------------------------------------------------------

interface NetworkActionDef {
  post: string;          // primary create-post action slug
  media?: string;        // optional media-upload/container action slug
  container?: string;    // optional 2-step container → publish (Instagram)
  requiresMedia?: boolean; // IG / YouTube / TikTok / Pinterest
}

export const SOCIAL_ACTIONS: Record<string, NetworkActionDef> = {
  twitter: {
    post: 'TWITTER_CREATION_OF_A_POST',
  },
  linkedin: {
    post: 'LINKEDIN_CREATE_LINKED_IN_POST',
  },
  instagram: {
    post: 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH',
    requiresMedia: true,
  },
  facebook: {
    post: 'FACEBOOK_CREATE_POST',
  },
  youtube: {
    post: 'YOUTUBE_MULTIPART_UPLOAD_VIDEO',
    requiresMedia: true,
  },
  reddit: {
    post: 'REDDIT_CREATE_REDDIT_POST',
  },
  pinterest: {
    post: 'CREATE_PIN',
    requiresMedia: true,
  },
  telegram: {
    post: 'TELEGRAM_SENDMESSAGE',
  },
  discord: {
    post: 'DISCORD_SEND_MESSAGE_IN_A_CHANNEL',
  },
  tiktok: {
    post: 'TIKTOK_VIDEO_UPLOAD',
    requiresMedia: true,
  },
};

// UP1 — best-effort per-network "reply/comment" action slugs for the
// first-comment feature. Only networks with a plausible comment action are
// listed; a missing entry simply skips the follow-up comment (fail-open). These
// mirror the static-map-first / discovery-fallback philosophy of SOCIAL_ACTIONS
// but are intentionally conservative (the comment must never fail the post).
export const SOCIAL_COMMENT_ACTIONS: Record<string, string> = {
  twitter: 'TWITTER_CREATION_OF_A_POST', // reply = tweet with in_reply_to_tweet_id
  linkedin: 'LINKEDIN_CREATE_LINKED_IN_POST',
  instagram: 'INSTAGRAM_CREATE_COMMENT',
  facebook: 'FACEBOOK_CREATE_COMMENT',
  reddit: 'REDDIT_POST_COMMENT',
};

// The 10 social toolkit slugs we surface in the accounts list.
export const SOCIAL_NETWORKS = Object.keys(SOCIAL_ACTIONS);

// ---------------------------------------------------------------------------
// Pure helpers (module-level, no I/O).
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function isTransientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function fullJitterBackoffMs(attempt: number): number {
  const exp = SOCIAL_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exp, SOCIAL_RETRY_CAP_MS);
  return Math.floor(Math.random() * capped);
}

function truncateText(s: string, cap: number): string {
  if (!s) return '';
  return s.length <= cap ? s : s.slice(0, cap) + '…';
}

function buildSummary(post: SocialPost): SocialPostSummary {
  return {
    id: post.id,
    status: post.status,
    text: truncateText(post.text, SUMMARY_TEXT_CAP),
    networks: post.targets.map(t => t.network),
    scheduledAt: post.scheduledAt,
    publishedAt: post.publishedAt,
    updatedAt: post.updatedAt,
    hasMedia: post.media.length > 0,
  };
}

// ---------------------------------------------------------------------------
// UP1 — advanced-settings pure helpers (module-level, no I/O). Every one is
// fail-open: malformed input is dropped, never thrown, so a bad PUT can only
// narrow the effective settings, never break publishing.
// ---------------------------------------------------------------------------

function clampStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function clampInt(v: unknown, min: number, max: number): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Normalize one hashtag: strip whitespace, ensure a single leading '#'. */
function normalizeHashtag(raw: unknown): string | null {
  let s = clampStr(raw, SOCIAL_HASHTAG_LEN_MAX);
  if (!s) return null;
  s = s.replace(/\s+/g, '');
  if (!s) return null;
  if (!s.startsWith('#')) s = `#${s.replace(/^#+/, '')}`;
  return s.length > 1 ? s : null;
}

function normalizeWindows(raw: unknown): PostingWindow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PostingWindow[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    const day = clampInt((w as any)?.day, 0, 6);
    const hour = clampInt((w as any)?.hour, 0, 23);
    if (day == null || hour == null) continue;
    const key = `${day}:${hour}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ day, hour });
    if (out.length >= SOCIAL_WINDOWS_MAX) break;
  }
  return out.length ? out : undefined;
}

function normalizeNetworkDefaults(raw: unknown): NetworkDefaults | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: NetworkDefaults = {};
  if (Array.isArray(r.hashtags)) {
    const tags: string[] = [];
    for (const h of r.hashtags) {
      const t = normalizeHashtag(h);
      if (t && !tags.includes(t)) tags.push(t);
      if (tags.length >= SOCIAL_HASHTAGS_MAX) break;
    }
    if (tags.length) out.hashtags = tags;
  }
  const fc = clampStr(r.firstComment, SOCIAL_FIRST_COMMENT_MAX);
  if (fc) out.firstComment = fc;
  const windows = normalizeWindows(r.windows);
  if (windows) out.windows = windows;
  return Object.keys(out).length ? out : undefined;
}

function normalizeUtm(raw: unknown): UtmSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: UtmSettings = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  const source = clampStr(r.source, SOCIAL_UTM_FIELD_MAX);
  const medium = clampStr(r.medium, SOCIAL_UTM_FIELD_MAX);
  const campaign = clampStr(r.campaign, SOCIAL_UTM_FIELD_MAX);
  if (source) out.source = source;
  if (medium) out.medium = medium;
  if (campaign) out.campaign = campaign;
  return Object.keys(out).length ? out : undefined;
}

function normalizeQueue(raw: unknown): QueueRules | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: QueueRules = {};
  const maxDay = clampInt(r.maxPerDayPerNetwork, 0, SOCIAL_MAX_PER_DAY_CAP);
  if (maxDay != null) out.maxPerDayPerNetwork = maxDay;
  const gap = clampInt(r.minGapMinutes, 0, SOCIAL_MIN_GAP_CAP);
  if (gap != null) out.minGapMinutes = gap;
  if (typeof r.autoRequeueOnFailure === 'boolean')
    out.autoRequeueOnFailure = r.autoRequeueOnFailure;
  const maxAtt = clampInt(
    r.autoRequeueMaxAttempts,
    1,
    SOCIAL_AUTO_REQUEUE_MAX_ATTEMPTS
  );
  if (maxAtt != null) out.autoRequeueMaxAttempts = maxAtt;
  if (typeof r.approvalRequired === 'boolean')
    out.approvalRequired = r.approvalRequired;
  return Object.keys(out).length ? out : undefined;
}

/** Canonicalize a (possibly partial / untrusted) settings blob. */
export function normalizeSocialSettings(raw: unknown): SocialSettings {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: SocialSettings = {};
  const tz = clampStr(r.timezone, SOCIAL_TIMEZONE_MAX);
  if (tz) out.timezone = tz;
  if (r.networks && typeof r.networks === 'object') {
    const nets: Record<string, NetworkDefaults> = {};
    for (const [slug, def] of Object.entries(r.networks as Record<string, unknown>)) {
      const s = String(slug).trim().toLowerCase();
      if (!SOCIAL_NETWORKS.includes(s)) continue;
      const nd = normalizeNetworkDefaults(def);
      if (nd) nets[s] = nd;
    }
    if (Object.keys(nets).length) out.networks = nets;
  }
  const utm = normalizeUtm(r.utm);
  if (utm) out.utm = utm;
  const queue = normalizeQueue(r.queue);
  if (queue) out.queue = queue;
  if (typeof r.updatedAt === 'number') out.updatedAt = r.updatedAt;
  return out;
}

/**
 * Merge an incoming (normalized) patch over the current settings. Shallow at
 * the top level, but network defaults merge per-network so a PUT touching only
 * twitter doesn't wipe linkedin. Passing an explicit empty object for a section
 * clears it (PUT semantics the FE relies on for "remove all hashtags").
 */
export function mergeSocialSettings(
  current: SocialSettings,
  patch: unknown
): SocialSettings {
  const p = normalizeSocialSettings(patch);
  const rawP = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const out: SocialSettings = { ...current };
  if ('timezone' in rawP) out.timezone = p.timezone;
  if ('utm' in rawP) out.utm = p.utm;
  if ('queue' in rawP) out.queue = p.queue;
  if ('networks' in rawP) {
    // Merge per-network so a partial patch is additive per slug.
    const merged: Record<string, NetworkDefaults> = { ...(current.networks ?? {}) };
    const rawNets = (rawP.networks && typeof rawP.networks === 'object'
      ? rawP.networks
      : {}) as Record<string, unknown>;
    for (const slug of Object.keys(rawNets)) {
      const s = slug.trim().toLowerCase();
      if (!SOCIAL_NETWORKS.includes(s)) continue;
      const nd = p.networks?.[s];
      if (nd) merged[s] = nd;
      else delete merged[s]; // explicit empty defaults clear the slug
    }
    out.networks = Object.keys(merged).length ? merged : undefined;
  }
  return out;
}

/**
 * UP1 — append a network's default hashtags to a caption (deduped against tags
 * already present in the text). Pure. Used at publish time and echoed to the
 * composer preview. Never exceeds the network's char budget by more than the
 * tags themselves — the caller/UI owns hard char-limit enforcement.
 */
export function applyHashtags(text: string, hashtags?: string[]): string {
  if (!hashtags || !hashtags.length) return text;
  const lower = text.toLowerCase();
  const toAdd = hashtags.filter(h => !lower.includes(h.toLowerCase()));
  if (!toAdd.length) return text;
  const sep = text.trim().length ? '\n\n' : '';
  return `${text}${sep}${toAdd.join(' ')}`;
}

/**
 * UP1 — append UTM params to the FIRST http(s) URL in the caption. Pure, fail-
 * open: no URL → text unchanged; a URL that already carries utm_* is left as-is
 * (we don't double-tag). medium defaults to the network slug, source to
 * 'social'. Only the first URL is tagged (link posts usually carry one link).
 */
export function applyUtm(
  text: string,
  network: string,
  utm?: UtmSettings
): string {
  if (!utm?.enabled) return text;
  const urlRe = /(https?:\/\/[^\s]+)/;
  const m = urlRe.exec(text);
  if (!m) return text;
  const original = m[1];
  if (/[?&]utm_/i.test(original)) return text; // already tagged
  // Strip a trailing sentence punctuation so it isn't swallowed into the URL.
  const trailing = /[.,;:!?)]+$/.exec(original);
  const core = trailing ? original.slice(0, -trailing[0].length) : original;
  const suffixPunct = trailing ? trailing[0] : '';
  const params = new URLSearchParams();
  params.set('utm_source', utm.source || 'social');
  params.set('utm_medium', utm.medium || network);
  if (utm.campaign) params.set('utm_campaign', utm.campaign);
  const joiner = core.includes('?') ? '&' : '?';
  const tagged = `${core}${joiner}${params.toString()}${suffixPunct}`;
  return text.replace(original, tagged);
}

// ---------------------------------------------------------------------------
// ClickDzSocialService — @Injectable, injected by both the controller & job.
// ---------------------------------------------------------------------------

@Injectable()
export class ClickDzSocialService {
  private readonly logger = new Logger(ClickDzSocialService.name);

  constructor(private readonly cache: Cache) {}

  // ---- fetch helper --------------------------------------------------------

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number = SOCIAL_PUBLISH_TIMEOUT_MS
  ): Promise<globalThis.Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- action resolution --------------------------------------------------

  /**
   * Resolve the create-post action slug for a network. Uses the static map
   * first; falls back to a live Composio tools discovery (soft-fail).
   */
  async resolveSocialAction(network: string): Promise<string | null> {
    const def = SOCIAL_ACTIONS[network.toLowerCase()];
    if (def?.post) return def.post;
    // Live fallback: discover tools for the toolkit and pick the first
    // create/post/send action (heuristic — better than failing hard).
    return this.discoverFallbackAction(network);
  }

  private async discoverFallbackAction(network: string): Promise<string | null> {
    if (!COMPOSIO_API_KEY) return null;
    try {
      const params = new URLSearchParams({
        toolkit_slug: network,
        limit: '25',
      });
      const res = await this.fetchWithTimeout(
        `${COMPOSIO_TOOLS_URL}?${params}`,
        {
          method: 'GET',
          headers: { 'x-api-key': COMPOSIO_API_KEY, Accept: 'application/json' },
        },
        8_000
      );
      if (!res.ok) return null;
      const data: any = await res.json().catch(() => null);
      const list: any[] = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.tools)
          ? data.tools
          : Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data)
              ? data
              : [];
      const keywords = /create|post|send|publish|upload/i;
      const found = list.find(
        (t: any) =>
          typeof t?.slug === 'string' && keywords.test(t.slug)
      );
      return typeof found?.slug === 'string' ? found.slug : null;
    } catch {
      return null;
    }
  }

  // ---- Composio raw execute (mirrors controller's executeToolRaw) ----------

  async executeToolRaw(
    toolSlug: string,
    args: Record<string, unknown>,
    userId: string,
    idempotencyKey?: string
  ): Promise<{ status: number; ok: boolean; preview: string; detail?: string }> {
    const execArgs =
      idempotencyKey && !('idempotency_key' in args)
        ? { ...args, idempotency_key: idempotencyKey }
        : args;
    const headers: Record<string, string> = {
      'x-api-key': COMPOSIO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
    try {
      const res = await this.fetchWithTimeout(
        `${COMPOSIO_TOOLS_EXECUTE_URL}/${encodeURIComponent(toolSlug)}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ user_id: userId, arguments: execArgs }),
        }
      );
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail =
          typeof data?.error?.message === 'string'
            ? data.error.message
            : typeof data?.error === 'string'
              ? data.error
              : typeof data?.message === 'string'
                ? data.message
                : `composio responded ${res.status}`;
        return { status: res.status, ok: false, preview: truncateText(detail, 500), detail };
      }
      const payload = data?.data ?? data?.response_data ?? data;
      let preview: string;
      try {
        preview = typeof payload === 'string' ? payload : JSON.stringify(payload);
      } catch {
        preview = String(payload);
      }
      return { status: res.status, ok: true, preview: truncateText(preview, 500) };
    } catch (err) {
      const detail = (err as Error)?.message ?? 'execute_failed';
      return { status: 0, ok: false, preview: truncateText(detail, 500), detail };
    }
  }

  // ---- Connected accounts (for /social/accounts) --------------------------

  async fetchConnectedSlugsForSocial(userId: string): Promise<Set<string>> {
    if (!COMPOSIO_API_KEY) return new Set();
    try {
      const params = new URLSearchParams({ user_ids: userId, limit: '200' });
      const res = await this.fetchWithTimeout(
        `${COMPOSIO_CONNECTED_ACCOUNTS_URL}?${params}`,
        {
          method: 'GET',
          headers: { 'x-api-key': COMPOSIO_API_KEY, Accept: 'application/json' },
        },
        8_000
      );
      if (!res.ok) return new Set();
      const data: any = await res.json().catch(() => null);
      // Extract slugs — same defense-in-depth logic as controller's
      // extractConnectedSlugs (caller-id filter + field-name drift tolerance).
      const slugs = new Set<string>();
      const list: any[] = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data)
            ? data
            : [];
      for (const acct of list) {
        // Defense-in-depth: only the caller's own accounts.
        const uid =
          typeof acct?.user_id === 'string'
            ? acct.user_id
            : typeof acct?.userId === 'string'
              ? acct.userId
              : typeof acct?.entity_id === 'string'
                ? acct.entity_id
                : typeof acct?.entityId === 'string'
                  ? acct.entityId
                  : '';
        if (uid.trim() !== userId) continue;
        const raw =
          typeof acct?.toolkit_slug === 'string'
            ? acct.toolkit_slug
            : typeof acct?.toolkit?.slug === 'string'
              ? acct.toolkit.slug
              : typeof acct?.app_name === 'string'
                ? acct.app_name
                : typeof acct?.appName === 'string'
                  ? acct.appName
                  : '';
        const s = raw.trim().toLowerCase();
        if (s) slugs.add(s);
      }
      return slugs;
    } catch {
      return new Set();
    }
  }

  /** List connected accounts (raw Composio response) for a specific network
   *  slug — used by disconnect to find the account id(s) to delete. */
  async fetchConnectedAccountIds(
    userId: string,
    network: string
  ): Promise<string[]> {
    if (!COMPOSIO_API_KEY) return [];
    try {
      const params = new URLSearchParams({
        user_ids: userId,
        toolkit_slug: network,
        limit: '20',
      });
      const res = await this.fetchWithTimeout(
        `${COMPOSIO_CONNECTED_ACCOUNTS_URL}?${params}`,
        {
          method: 'GET',
          headers: { 'x-api-key': COMPOSIO_API_KEY, Accept: 'application/json' },
        },
        8_000
      );
      if (!res.ok) return [];
      const data: any = await res.json().catch(() => null);
      const list: any[] = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data)
            ? data
            : [];
      const ids: string[] = [];
      for (const acct of list) {
        const uid =
          typeof acct?.user_id === 'string'
            ? acct.user_id
            : typeof acct?.userId === 'string'
              ? acct.userId
              : typeof acct?.entity_id === 'string'
                ? acct.entity_id
                : typeof acct?.entityId === 'string'
                  ? acct.entityId
                  : '';
        if (uid.trim() !== userId) continue;
        const id =
          typeof acct?.id === 'string' ? acct.id : typeof acct?.connectedAccountId === 'string' ? acct.connectedAccountId : null;
        if (id) ids.push(id);
      }
      return ids;
    } catch {
      return [];
    }
  }

  async deleteConnectedAccount(accountId: string): Promise<boolean> {
    if (!COMPOSIO_API_KEY) return false;
    try {
      const res = await this.fetchWithTimeout(
        `${COMPOSIO_CONNECTED_ACCOUNTS_URL}/${encodeURIComponent(accountId)}`,
        {
          method: 'DELETE',
          headers: { 'x-api-key': COMPOSIO_API_KEY, Accept: 'application/json' },
        },
        8_000
      );
      return res.ok || res.status === 404; // 404 = already gone
    } catch {
      return false;
    }
  }

  // ---- UP1: detailed accounts + single-account status poll ----------------

  /**
   * UP1 — list the caller's connected accounts for the 10 social toolkits with
   * their live Composio status + account id + created time, so the Connections
   * grid can show "ACTIVE / INITIATED / EXPIRED" not just a boolean. One list
   * call (user-scoped) mapped to the newest account per network. Fail-soft: an
   * unreachable Composio yields every network `{connected:false}` — the grid
   * still renders and the boolean /accounts route is unaffected.
   */
  async fetchDetailedAccounts(userId: string): Promise<DetailedAccount[]> {
    const base: DetailedAccount[] = SOCIAL_NETWORKS.map(network => ({
      network,
      connected: false,
    }));
    if (!COMPOSIO_API_KEY) return base;
    try {
      const params = new URLSearchParams({ user_ids: userId, limit: '200' });
      const res = await this.fetchWithTimeout(
        `${COMPOSIO_CONNECTED_ACCOUNTS_URL}?${params}`,
        {
          method: 'GET',
          headers: { 'x-api-key': COMPOSIO_API_KEY, Accept: 'application/json' },
        },
        8_000
      );
      if (!res.ok) return base;
      const data: any = await res.json().catch(() => null);
      const list: any[] = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data)
            ? data
            : [];
      const byNetwork = new Map<string, DetailedAccount>();
      for (const acct of list) {
        const uid = this.acctUserId(acct);
        if (uid !== userId) continue; // defense-in-depth (see fetchConnectedSlugsForSocial)
        const slug = this.acctToolkitSlug(acct);
        if (!slug || !SOCIAL_NETWORKS.includes(slug)) continue;
        const status =
          typeof acct?.status === 'string'
            ? acct.status
            : typeof acct?.connectionStatus === 'string'
              ? acct.connectionStatus
              : undefined;
        const accountId =
          typeof acct?.id === 'string'
            ? acct.id
            : typeof acct?.connectedAccountId === 'string'
              ? acct.connectedAccountId
              : undefined;
        const createdAt =
          typeof acct?.created_at === 'string'
            ? acct.created_at
            : typeof acct?.createdAt === 'string'
              ? acct.createdAt
              : undefined;
        // ACTIVE (or missing status = treat as connected) marks connected.
        const connected =
          status == null || /active|connected/i.test(String(status));
        const prev = byNetwork.get(slug);
        // Prefer an ACTIVE row; otherwise keep the first seen.
        if (!prev || (connected && !prev.connected)) {
          byNetwork.set(slug, { network: slug, connected, status, accountId, createdAt });
        }
      }
      return base.map(b => byNetwork.get(b.network) ?? b);
    } catch {
      return base;
    }
  }

  /**
   * UP1 — poll ONE network's connection status for the caller (used by the
   * Connections view while a card shows "Connexion…" after the OAuth tab opens).
   * Returns the newest account's status or 'none' when the user has no account
   * for that network yet. Fail-soft → {connected:false, status:'unknown'}.
   */
  async fetchAccountStatus(
    userId: string,
    network: string
  ): Promise<{ connected: boolean; status: string; accountId?: string }> {
    if (!COMPOSIO_API_KEY) return { connected: false, status: 'not_configured' };
    try {
      const params = new URLSearchParams({
        user_ids: userId,
        toolkit_slug: network,
        limit: '10',
      });
      const res = await this.fetchWithTimeout(
        `${COMPOSIO_CONNECTED_ACCOUNT_ONE_URL}?${params}`,
        {
          method: 'GET',
          headers: { 'x-api-key': COMPOSIO_API_KEY, Accept: 'application/json' },
        },
        8_000
      );
      if (!res.ok) return { connected: false, status: 'unknown' };
      const data: any = await res.json().catch(() => null);
      const list: any[] = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data)
            ? data
            : [];
      let best: { connected: boolean; status: string; accountId?: string } | null = null;
      for (const acct of list) {
        if (this.acctUserId(acct) !== userId) continue;
        if (this.acctToolkitSlug(acct) !== network.toLowerCase()) continue;
        const status =
          typeof acct?.status === 'string'
            ? acct.status
            : typeof acct?.connectionStatus === 'string'
              ? acct.connectionStatus
              : 'unknown';
        const accountId =
          typeof acct?.id === 'string' ? acct.id : undefined;
        const connected = /active|connected/i.test(String(status));
        if (!best || (connected && !best.connected)) {
          best = { connected, status, accountId };
        }
      }
      return best ?? { connected: false, status: 'none' };
    } catch {
      return { connected: false, status: 'unknown' };
    }
  }

  /** Defensive: the account's own user/entity id (field-name drift tolerant). */
  private acctUserId(acct: any): string {
    const raw =
      typeof acct?.user_id === 'string'
        ? acct.user_id
        : typeof acct?.userId === 'string'
          ? acct.userId
          : typeof acct?.entity_id === 'string'
            ? acct.entity_id
            : typeof acct?.entityId === 'string'
              ? acct.entityId
              : typeof acct?.user?.id === 'string'
                ? acct.user.id
                : '';
    return String(raw).trim();
  }

  /** Defensive: the account's toolkit slug, lower-cased (field-name drift tolerant). */
  private acctToolkitSlug(acct: any): string {
    const raw =
      typeof acct?.toolkit_slug === 'string'
        ? acct.toolkit_slug
        : typeof acct?.toolkit?.slug === 'string'
          ? acct.toolkit.slug
          : typeof acct?.app_name === 'string'
            ? acct.app_name
            : typeof acct?.appName === 'string'
              ? acct.appName
              : typeof acct?.toolkit === 'string'
                ? acct.toolkit
                : '';
    return String(raw).trim().toLowerCase();
  }

  // ---- UP1: advanced settings persistence + normalization -----------------

  /** Read the caller's advanced Social settings (fail-soft → {} defaults). */
  async readSettings(userId: string): Promise<SocialSettings> {
    try {
      const raw = await this.cache.get<SocialSettings>(socialSettingsKey(userId));
      return normalizeSocialSettings(raw);
    } catch {
      return {};
    }
  }

  /** Persist advanced Social settings (validated + normalized). Never throws. */
  async writeSettings(
    userId: string,
    patch: unknown
  ): Promise<SocialSettings> {
    const current = await this.readSettings(userId);
    const next = mergeSocialSettings(current, patch);
    next.updatedAt = Date.now();
    try {
      await this.cache.set(socialSettingsKey(userId), next, {
        ttl: SOCIAL_SETTINGS_TTL_MS,
      });
    } catch (err) {
      this.logger.warn(
        `[social] writeSettings failed: ${(err as Error)?.message ?? err}`
      );
    }
    return next;
  }

  // ---- Persistence helpers (fail-soft — mirror writeFlow/writeRun idiom) ---

  /** Read one persisted SocialPost or null. Never throws. */
  async readPost(userId: string, postId: string): Promise<SocialPost | null> {
    try {
      const raw = await this.cache.get<SocialPost>(
        socialPostKey(userId, postId)
      );
      if (!raw || typeof raw !== 'object') return null;
      return raw as SocialPost;
    } catch {
      return null;
    }
  }

  /** Persist a SocialPost + upsert index summary + trim to cap. Never throws. */
  async writePost(userId: string, post: SocialPost): Promise<void> {
    try {
      post.updatedAt = Date.now();
      await this.cache.set(socialPostKey(userId, post.id), post, {
        ttl: SOCIAL_POST_TTL_MS,
      });
      await this.cache.mapSet<SocialPostSummary>(
        socialPostIndexKey(userId),
        post.id,
        buildSummary(post)
      );
      await this.trimSocialIndex(userId);
    } catch (err) {
      this.logger.warn(
        `[social] writePost ${post.id} failed: ${(err as Error)?.message ?? err}`
      );
    }
  }

  /** Soft-delete: remove post row + index entry. Never throws. */
  async deletePost(userId: string, postId: string): Promise<void> {
    try {
      await this.cache.delete(socialPostKey(userId, postId));
      await this.cache.mapDelete(socialPostIndexKey(userId), postId);
    } catch {
      /* fail-soft */
    }
  }

  /**
   * List all SocialPostSummary for the user (newest first, optional filters).
   * Prunes stale index entries (post record expired). Never throws.
   */
  async listPostSummaries(
    userId: string,
    opts?: { status?: string; from?: number; to?: number }
  ): Promise<SocialPostSummary[]> {
    try {
      const ids = await this.cache.mapKeys(socialPostIndexKey(userId));
      const summaries: SocialPostSummary[] = [];
      for (const id of ids) {
        const s = await this.cache.mapGet<SocialPostSummary>(
          socialPostIndexKey(userId),
          id
        );
        if (!s) {
          // Prune stale entry.
          await this.cache.mapDelete(socialPostIndexKey(userId), id);
          continue;
        }
        // Apply filters.
        if (opts?.status && s.status !== opts.status) continue;
        if (opts?.from && s.scheduledAt && s.scheduledAt < opts.from) continue;
        if (opts?.to && s.scheduledAt && s.scheduledAt > opts.to) continue;
        summaries.push(s);
      }
      summaries.sort((a, b) => b.updatedAt - a.updatedAt);
      return summaries;
    } catch {
      return [];
    }
  }

  /** Append a PublishedLogEntry to the per-user log hash. Never throws. */
  async appendPublishedLog(
    userId: string,
    entry: PublishedLogEntry
  ): Promise<void> {
    try {
      await this.cache.mapSet<PublishedLogEntry>(
        socialLogKey(userId),
        entry.postId,
        entry
      );
      // Trim to cap.
      await this.trimGenericIndex<PublishedLogEntry>(
        socialLogKey(userId),
        SOCIAL_INDEX_CAP,
        e => e.publishedAt
      );
    } catch (err) {
      this.logger.warn(
        `[social] appendPublishedLog ${entry.postId} failed: ${(err as Error)?.message ?? err}`
      );
    }
  }

  /** Read all PublishedLogEntry for user (newest first). Never throws. */
  async readPublishedLog(userId: string): Promise<PublishedLogEntry[]> {
    try {
      const ids = await this.cache.mapKeys(socialLogKey(userId));
      const entries: PublishedLogEntry[] = [];
      for (const id of ids) {
        const e = await this.cache.mapGet<PublishedLogEntry>(
          socialLogKey(userId),
          id
        );
        if (e) entries.push(e);
      }
      entries.sort((a, b) => b.publishedAt - a.publishedAt);
      return entries;
    } catch {
      return [];
    }
  }

  // ---- trimIndex (generic — mirrors controller's trimIndex) ----------------

  private async trimSocialIndex(userId: string): Promise<void> {
    await this.trimGenericIndex<SocialPostSummary>(
      socialPostIndexKey(userId),
      SOCIAL_INDEX_CAP,
      s => s.updatedAt
    );
  }

  private async trimGenericIndex<T>(
    mapKey: string,
    cap: number,
    orderOf: (entry: T) => number
  ): Promise<void> {
    try {
      const ids = await this.cache.mapKeys(mapKey);
      if (ids.length <= cap) return;
      const entries: Array<{ id: string; order: number }> = [];
      for (const id of ids) {
        const v = await this.cache.mapGet<T>(mapKey, id);
        entries.push({ id, order: v ? orderOf(v) : 0 });
      }
      entries.sort((a, b) => b.order - a.order);
      for (const stale of entries.slice(cap)) {
        await this.cache.mapDelete(mapKey, stale.id);
      }
    } catch {
      /* fail-soft */
    }
  }

  // =========================================================================
  // publishPost — THE SHARED PUBLISH ROUTINE
  //
  // Called by: the controller (publish-now path) AND the BullMQ job worker
  // (scheduled path). Both paths use the same per-target execute + retry.
  //
  // Contract:
  //  - Accepts a full SocialPost (already persisted with status 'publishing').
  //  - Resolves the create-post action for each target.
  //  - Calls executeToolRaw with backoff (SOCIAL_RETRY_MAX_ATTEMPTS).
  //  - Updates target status + writes back incrementally.
  //  - Returns the mutated SocialPost (status: published/partial/failed).
  //  - NEVER throws — all errors captured in target.error / post.lastError.
  //  - idempotencyKey = postId:network (de-dupes retried or replayed runs).
  // =========================================================================

  async publishPost(
    post: SocialPost,
    settings?: SocialSettings
  ): Promise<SocialPost> {
    if (!COMPOSIO_API_KEY) {
      for (const t of post.targets) {
        t.status = 'failed';
        t.error = 'not_configured';
        t.attempts = 0;
      }
      post.status = 'failed';
      post.lastError = 'COMPOSIO_API_KEY not set';
      return post;
    }

    const deadline = Date.now() + SOCIAL_PUBLISH_TIMEOUT_MS * post.targets.length;

    for (const target of post.targets) {
      // Only process pending (or failed for retry).
      if (target.status === 'ok') continue;

      const network = target.network.toLowerCase();
      const actionSlug = await this.resolveSocialAction(network);
      if (!actionSlug) {
        target.status = 'failed';
        target.error = `no_action_for_network:${network}`;
        target.attempts = (target.attempts ?? 0) + 1;
        target.action = undefined;
        await this.writePost(post.userId, post).catch(() => {});
        continue;
      }
      target.action = actionSlug;

      // Build Composio arguments for this network. UP1: apply the per-network
      // content defaults (default hashtags) + workspace UTM link tagging to the
      // effective caption before it goes to Composio. Both are pure + fail-open
      // (absent settings ⇒ the raw caption, i.e. today's behaviour).
      const rawText = target.text ?? post.text;
      const text = this.applyContentDefaults(rawText, network, settings);
      const args = this.buildPublishArgs(network, text, post.media, post.scheduledAt);

      const idempotencyKey = `${post.id}:${network}`;
      let attempt = 0;
      let last: { status: number; ok: boolean; preview: string; detail?: string } | null = null;

      while (attempt < SOCIAL_RETRY_MAX_ATTEMPTS) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        attempt++;
        last = await this.executeToolRaw(
          actionSlug,
          args,
          post.userId,
          idempotencyKey
        );
        if (last.ok) break;
        if (!isTransientStatus(last.status) || attempt >= SOCIAL_RETRY_MAX_ATTEMPTS) break;
        const backoff = Math.min(fullJitterBackoffMs(attempt), Math.max(0, deadline - Date.now()));
        if (backoff > 0) await sleep(backoff);
      }

      target.attempts = (target.attempts ?? 0) + attempt;

      if (last?.ok) {
        target.status = 'ok';
        target.error = undefined;
        // Best-effort external id extraction.
        try {
          const parsed = JSON.parse(last.preview);
          target.externalId =
            parsed?.id?.toString() ??
            parsed?.tweet_id?.toString() ??
            parsed?.post_id?.toString() ??
            undefined;
        } catch {
          /* no structured id */
        }
        // UP1: post the first-comment as a follow-up (best-effort, never blocks
        // or fails the post). Resolves the comment text from the post or the
        // per-network default; skips networks with no comment action.
        await this.postFirstComment(post, target, network, settings).catch(() => {});
      } else {
        target.status = 'failed';
        target.error = truncateText(last?.detail ?? 'execute_failed', 300);
      }

      await this.writePost(post.userId, post).catch(() => {});
    }

    // Aggregate status.
    const allOk = post.targets.every(t => t.status === 'ok');
    const anyOk = post.targets.some(t => t.status === 'ok');
    post.status = allOk ? 'published' : anyOk ? 'partial' : 'failed';

    if (post.status === 'published' || post.status === 'partial') {
      post.publishedAt = Date.now();
    }
    if (!allOk) {
      const failed = post.targets.filter(t => t.status === 'failed');
      post.lastError = failed.map(t => `${t.network}: ${t.error}`).join('; ');
    } else {
      post.lastError = undefined;
    }

    return post;
  }

  /**
   * UP1 — apply the per-network default hashtags + workspace UTM tagging to a
   * caption. Pure wrapper over applyHashtags/applyUtm; both are fail-open so an
   * absent/empty settings blob returns the caption unchanged.
   */
  applyContentDefaults(
    text: string,
    network: string,
    settings?: SocialSettings
  ): string {
    if (!settings) return text;
    let out = applyUtm(text, network, settings.utm);
    out = applyHashtags(out, settings.networks?.[network]?.hashtags);
    return out;
  }

  /**
   * UP1 — post the first-comment follow-up after a successful main post
   * (best-effort). The comment text is post.firstComment (captured at compose
   * time) or the per-network default. Only networks with a known comment action
   * are attempted; every failure is swallowed (the main post already succeeded,
   * a missing comment must never flip the post to failed). No retry — one shot.
   */
  private async postFirstComment(
    post: SocialPost,
    target: SocialTarget,
    network: string,
    settings?: SocialSettings
  ): Promise<void> {
    const comment =
      (post.firstComment && post.firstComment.trim()) ||
      settings?.networks?.[network]?.firstComment?.trim() ||
      '';
    if (!comment) return;
    const action = SOCIAL_COMMENT_ACTIONS[network];
    if (!action) return; // network has no comment action wired
    if (!target.externalId) return; // need the parent post id to attach a comment
    const args = this.buildCommentArgs(network, comment, target.externalId);
    await this.executeToolRaw(
      action,
      args,
      post.userId,
      `${post.id}:${network}:comment`
    );
  }

  /** Build the comment action arguments per network (best-effort shapes). */
  private buildCommentArgs(
    network: string,
    comment: string,
    parentId: string
  ): Record<string, unknown> {
    switch (network) {
      case 'twitter':
        // Reply in-thread: a tweet with in_reply_to_tweet_id.
        return { tweet_text: comment, in_reply_to_tweet_id: parentId, text: comment };
      case 'linkedin':
        return { message_text: comment, post_id: parentId, text: comment };
      case 'instagram':
        return { message: comment, media_id: parentId, text: comment };
      case 'facebook':
        return { message: comment, object_id: parentId, text: comment };
      case 'reddit':
        return { text: comment, thing_id: parentId };
      default:
        return { text: comment, parent_id: parentId };
    }
  }

  /**
   * Build Composio action arguments per network. Provides the text + any media
   * URLs; Facebook gets `scheduled_publish_time` when a native FB schedule date
   * is passed (optional optimization). Safe defaults for all other networks.
   */
  buildPublishArgs(
    network: string,
    text: string,
    media: SocialMedia[],
    scheduledAt?: number
  ): Record<string, unknown> {
    const mediaUrls = media.map(m => m.url).filter(Boolean);
    const firstMedia = mediaUrls[0] ?? undefined;

    const base: Record<string, unknown> = { text };

    switch (network) {
      case 'twitter':
        return { ...base, tweet_text: text, ...(firstMedia ? { media_url: firstMedia } : {}) };

      case 'linkedin':
        return { ...base, message_text: text, ...(firstMedia ? { image_url: firstMedia } : {}) };

      case 'instagram':
        return {
          ...base,
          caption: text,
          ...(firstMedia ? { image_url: firstMedia } : {}),
        };

      case 'facebook': {
        const fbArgs: Record<string, unknown> = {
          ...base,
          message: text,
          ...(firstMedia ? { url: firstMedia } : {}),
        };
        // Native FB scheduling: pass scheduled_publish_time only when the post
        // is meant for the future (>60s away). Also requires published=false.
        if (scheduledAt && scheduledAt - Date.now() > 60_000) {
          fbArgs.scheduled_publish_time = Math.floor(scheduledAt / 1000);
          fbArgs.published = false;
        }
        return fbArgs;
      }

      case 'youtube':
        return {
          ...base,
          title: text.slice(0, 100),
          description: text,
          ...(firstMedia ? { video_url: firstMedia } : {}),
        };

      case 'reddit':
        return {
          ...base,
          title: text.slice(0, 300),
          ...(firstMedia ? { url: firstMedia } : { selftext: text }),
        };

      case 'pinterest':
        return {
          ...base,
          note: text,
          ...(firstMedia ? { image_url: firstMedia } : {}),
        };

      case 'telegram':
        return { ...base, text };

      case 'discord':
        return { ...base, content: text };

      case 'tiktok':
        return {
          ...base,
          video_url: firstMedia ?? '',
          description: text,
        };

      default:
        return { ...base, ...(firstMedia ? { media_url: firstMedia } : {}) };
    }
  }

  // ---- mint helper ---------------------------------------------------------

  /** Mint a new SocialPost with defaults. */
  mintPost(
    userId: string,
    opts: {
      text: string;
      media?: SocialMedia[];
      targets: SocialTarget[];
      scheduledAt?: number;
      firstComment?: string;
    }
  ): SocialPost {
    const now = Date.now();
    return {
      id: randomUUID(),
      userId,
      text: opts.text,
      media: opts.media ?? [],
      targets: opts.targets,
      status: 'draft',
      scheduledAt: opts.scheduledAt,
      createdAt: now,
      updatedAt: now,
      ...(opts.firstComment ? { firstComment: opts.firstComment } : {}),
    };
  }

  /**
   * UP1 — enforce workspace queue rules for a NEW scheduled post. Reads the
   * user's existing scheduled/published-today posts from the index and checks:
   *   - maxPerDayPerNetwork: at most N posts per network in the rolling 24h
   *     window around the requested time.
   *   - minGapMinutes: no other scheduled post within ±gap of the requested time.
   * Returns null when the post is allowed, or a machine reason + detail the
   * controller maps to a typed 409. Fail-OPEN: any read error allows the post
   * (rules are a convenience guardrail, not a security control). `excludeId`
   * skips the post being rescheduled/edited so it doesn't conflict with itself.
   */
  async checkQueueRules(
    userId: string,
    opts: {
      networks: string[];
      scheduledAt: number;
      rules?: QueueRules;
      excludeId?: string;
    }
  ): Promise<{ reason: string; detail: string } | null> {
    const rules = opts.rules;
    if (!rules) return null;
    const maxPerDay = rules.maxPerDayPerNetwork ?? 0;
    const gapMin = rules.minGapMinutes ?? 0;
    if (maxPerDay <= 0 && gapMin <= 0) return null;
    let summaries: SocialPostSummary[];
    try {
      summaries = await this.listPostSummaries(userId);
    } catch {
      return null; // fail-open
    }
    const others = summaries.filter(
      s =>
        s.id !== opts.excludeId &&
        (s.status === 'scheduled' ||
          s.status === 'publishing' ||
          s.status === 'published') &&
        typeof s.scheduledAt === 'number'
    );

    // Min-gap: any other scheduled post within ±gap minutes.
    if (gapMin > 0) {
      const gapMs = gapMin * 60 * 1000;
      const clash = others.find(
        s => Math.abs((s.scheduledAt as number) - opts.scheduledAt) < gapMs
      );
      if (clash) {
        return {
          reason: 'min_gap_violation',
          detail: `Un autre post est programmé à moins de ${gapMin} min de cet horaire.`,
        };
      }
    }

    // Max-per-day-per-network: count same-network posts in the ±24h window.
    if (maxPerDay > 0) {
      const dayMs = 24 * 60 * 60 * 1000;
      for (const net of opts.networks) {
        const count = others.filter(
          s =>
            s.networks.includes(net) &&
            Math.abs((s.scheduledAt as number) - opts.scheduledAt) < dayMs
        ).length;
        if (count >= maxPerDay) {
          return {
            reason: 'max_per_day_violation',
            detail: `Limite de ${maxPerDay} post(s)/jour atteinte pour ${net}.`,
          };
        }
      }
    }
    return null;
  }

  /** Normalize a raw target array from the request body (fail-closed). */
  normalizeTargets(raw: any[]): SocialTarget[] {
    return raw
      .filter((t: any) => typeof t?.network === 'string' && t.network.trim())
      .slice(0, SOCIAL_TARGETS_MAX)
      .map((t: any): SocialTarget => ({
        network: t.network.trim().toLowerCase(),
        text: typeof t.text === 'string' ? t.text.trim().slice(0, SOCIAL_TEXT_MAX) || undefined : undefined,
        status: 'pending',
        attempts: 0,
      }));
  }

  /** Normalize a raw media array from the request body (fail-closed). */
  normalizeMedia(raw: any[]): SocialMedia[] {
    return raw
      .filter((m: any) => typeof m?.url === 'string' && m.url.trim())
      .slice(0, SOCIAL_MEDIA_MAX)
      .map((m: any): SocialMedia => {
        const kind: 'image' | 'video' =
          m.kind === 'video' ? 'video' : 'image';
        return {
          kind,
          url: m.url.trim(),
          mime: typeof m.mime === 'string' ? m.mime.trim() : undefined,
          alt: typeof m.alt === 'string' ? m.alt.trim().slice(0, 200) : undefined,
        };
      });
  }

  /**
   * WS17: validate that every media URL is publicly fetchable (http/https).
   * Browser blob: URLs (URL.createObjectURL) are only valid in the originating
   * browser — Composio's servers cannot fetch them, so a post with a blob:
   * media URL silently fails at publish time with a cryptic API error. This
   * returns the list of offending URLs so the caller can throw a clear 400.
   */
  invalidMediaUrls(media: SocialMedia[]): string[] {
    return media
      .map(m => m.url)
      .filter(u => !/^https?:\/\//i.test(u));
  }

  // -------------------------------------------------------------------------
  // WS17: Plan-B cron support — recover scheduled posts whose BullMQ job was
  // lost (Redis flush / worker restart). A global JSON array of userIds with
  // scheduled posts is maintained at enqueue time; the cron iterates it, reads
  // each user's postindex, and returns past-due 'scheduled' post ids for the
  // job to re-enqueue. Fail-soft on every step (a Redis hiccup only delays the
  // sweep; the UI's retry/reschedule path still works).
  // -------------------------------------------------------------------------

  /** Add a userId to the global schedulers index (idempotent, fail-soft). */
  async registerScheduler(userId: string): Promise<void> {
    try {
      const raw = (await this.cache.get<string[]>(socialSchedulersKey())) ?? [];
      const set = new Set(Array.isArray(raw) ? raw : []);
      set.add(userId);
      await this.cache.set(socialSchedulersKey(), [...set], {
        ttl: 365 * 24 * 60 * 60 * 1000,
      });
    } catch {
      /* fail-soft — the sweep is a safety net, not the primary path */
    }
  }

  /** Return all userIds known to have scheduled posts (fail-soft -> []). */
  async listSchedulerUserIds(): Promise<string[]> {
    try {
      const raw = (await this.cache.get<string[]>(socialSchedulersKey())) ?? [];
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  /**
   * Return the postIds for a user whose status is 'scheduled' AND scheduledAt is
   * past `dueBefore` (epoch ms). Used by the Plan-B cron to find missed posts.
   * Fail-soft -> [].
   */
  async listScheduledDue(
    userId: string,
    dueBefore: number
  ): Promise<string[]> {
    try {
      const ids = await this.cache.mapKeys(socialPostIndexKey(userId));
      const due: string[] = [];
      for (const id of ids) {
        const s = await this.cache.mapGet<SocialPostSummary>(
          socialPostIndexKey(userId),
          id
        );
        if (
          s &&
          s.status === 'scheduled' &&
          typeof s.scheduledAt === 'number' &&
          s.scheduledAt < dueBefore
        ) {
          due.push(id);
        }
      }
      return due;
    } catch {
      return [];
    }
  }
}
