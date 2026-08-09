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

// ---------------------------------------------------------------------------
// Social post data types (P3 plan §2 — mirror exactly so service + controller
// + job + FE api.ts all speak the same shapes).
// ---------------------------------------------------------------------------

export type SocialStatus =
  | 'draft'
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
  results: Array<{ network: string; ok: boolean; externalUrl?: string }>;
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

// Text truncation cap for summaries (mirrors truncatePreview in controller).
const SUMMARY_TEXT_CAP = 120;

// ---------------------------------------------------------------------------
// Redis key builders (per-user, mirrors flowKey/flowIndexKey pattern exactly).
// ---------------------------------------------------------------------------

export const socialPostKey = (userId: string, postId: string) =>
  `clickdz:social:post:${userId}:${postId}`;

export const socialPostIndexKey = (userId: string) =>
  `clickdz:social:postindex:${userId}`;

export const socialLogKey = (userId: string) =>
  `clickdz:social:log:${userId}`;

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

  async publishPost(post: SocialPost): Promise<SocialPost> {
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

      // Build Composio arguments for this network.
      const text = target.text ?? post.text;
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
    };
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
