// social/api.ts — typed client for all /api/v1/social/* E1 endpoints.
// Types mirror the backend contract (p3e1.md) exactly.
// All fetches: credentials:'include', cdzApiUrl() for the base.

import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';

// ---------------------------------------------------------------------------
// Shared types (mirror E1 contract exactly)
// ---------------------------------------------------------------------------

export type SocialStatus =
  | 'draft'
  | 'pending-approval'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'partial'
  | 'failed';

export interface SocialTarget {
  network: string;
  action?: string;
  text?: string;
  status: 'pending' | 'ok' | 'failed';
  externalId?: string;
  externalUrl?: string;
  error?: string;
  attempts: number;
}

export interface SocialMedia {
  kind: 'image' | 'video';
  url: string;
  mime?: string;
  alt?: string;
}

export interface SocialPost {
  id: string;
  userId: string;
  text: string;
  media: SocialMedia[];
  targets: SocialTarget[];
  status: SocialStatus;
  scheduledAt?: number;
  jobId?: string;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
  lastError?: string;
  // UP1
  autoRequeueAttempts?: number;
  firstComment?: string;
}

export interface SocialPostSummary {
  id: string;
  status: SocialStatus;
  text: string;
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
    // UP1 — richer per-network log detail
    error?: string;
    action?: string;
    attempts?: number;
  }>;
}

export interface AccountStatus {
  network: string;
  connected: boolean;
  // UP1 — live Composio status + account metadata
  status?: string;
  accountId?: string;
  createdAt?: string;
}

export interface AccountsResponse {
  enabled: boolean;
  accounts: AccountStatus[];
}

export interface ConnectResponse {
  redirectUrl: string;
}

// ---------------------------------------------------------------------------
// UP1 — Social config + advanced settings
// ---------------------------------------------------------------------------

export interface SocialConfig {
  composioConfigured: boolean;
  aiConfigured: boolean;
  networks: string[];
  mode: 'composio' | 'disabled';
}

export interface PostingWindow {
  day: number; // 0..6 (Sun..Sat)
  hour: number; // 0..23
}

export interface NetworkDefaults {
  hashtags?: string[];
  firstComment?: string;
  windows?: PostingWindow[];
}

export interface UtmSettings {
  enabled?: boolean;
  source?: string;
  medium?: string;
  campaign?: string;
}

export interface QueueRules {
  maxPerDayPerNetwork?: number;
  minGapMinutes?: number;
  autoRequeueOnFailure?: boolean;
  autoRequeueMaxAttempts?: number;
  approvalRequired?: boolean;
}

export interface SocialSettings {
  timezone?: string;
  networks?: Record<string, NetworkDefaults>;
  utm?: UtmSettings;
  queue?: QueueRules;
  updatedAt?: number;
}

export interface ComposeResponse {
  content: string;
  variants?: Record<string, string>;
}

export interface AnalyticsResponse {
  available: boolean;
  network: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Network metadata (char limits, media requirements, UI labels)
// ---------------------------------------------------------------------------

export interface NetworkMeta {
  slug: string;
  label: string;
  icon: string;
  charLimit: number;
  mediaRequired: boolean;
}

export const SOCIAL_NETWORKS: NetworkMeta[] = [
  { slug: 'twitter',   label: 'X / Twitter', icon: 'X',  charLimit: 280,   mediaRequired: false },
  { slug: 'linkedin',  label: 'LinkedIn',     icon: 'in', charLimit: 3000,  mediaRequired: false },
  { slug: 'instagram', label: 'Instagram',    icon: 'IG', charLimit: 2200,  mediaRequired: true  },
  { slug: 'facebook',  label: 'Facebook',     icon: 'f',  charLimit: 63206, mediaRequired: false },
  { slug: 'youtube',   label: 'YouTube',      icon: 'YT', charLimit: 5000,  mediaRequired: true  },
  { slug: 'reddit',    label: 'Reddit',       icon: 'R',  charLimit: 40000, mediaRequired: false },
  { slug: 'pinterest', label: 'Pinterest',    icon: 'P',  charLimit: 500,   mediaRequired: true  },
  { slug: 'telegram',  label: 'Telegram',     icon: 'TG', charLimit: 4096,  mediaRequired: false },
  { slug: 'discord',   label: 'Discord',      icon: 'D',  charLimit: 2000,  mediaRequired: false },
  { slug: 'tiktok',    label: 'TikTok',       icon: 'TK', charLimit: 2200,  mediaRequired: true  },
];

export function getNetworkMeta(slug: string): NetworkMeta | undefined {
  return SOCIAL_NETWORKS.find(n => n.slug === slug);
}

// ---------------------------------------------------------------------------
// UP1 — static best-time-to-post heuristic table (LABELLED AS A SUGGESTION in
// the UI — not per-account analytics). Hours are local to the user's timezone;
// values are widely-cited engagement windows per network. The composer renders
// these as clickable chips that fill the schedule input.
// ---------------------------------------------------------------------------

export interface BestTimeSuggestion {
  label: string; // FR label, e.g. "Mar 10h"
  day: number; // 0..6 (Sun..Sat)
  hour: number; // 0..23
}

const DAY_LABELS_FR = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

const BEST_TIME_TABLE: Record<string, Array<[number, number]>> = {
  // [day, hour] pairs — 3 suggestions per network.
  twitter: [[2, 9], [3, 12], [4, 15]],
  linkedin: [[2, 8], [3, 10], [4, 12]],
  instagram: [[1, 11], [3, 13], [5, 19]],
  facebook: [[3, 13], [4, 15], [6, 11]],
  youtube: [[5, 17], [6, 10], [0, 15]],
  reddit: [[1, 8], [3, 9], [6, 9]],
  pinterest: [[6, 20], [0, 15], [5, 21]],
  telegram: [[2, 10], [4, 19], [6, 12]],
  discord: [[5, 20], [6, 16], [0, 18]],
  tiktok: [[2, 18], [4, 20], [6, 11]],
};

/** Best-time suggestions for a network (FR labels). Empty for unknown slugs. */
export function bestTimes(network: string): BestTimeSuggestion[] {
  const rows = BEST_TIME_TABLE[network] ?? [];
  return rows.map(([day, hour]) => ({
    label: `${DAY_LABELS_FR[day]} ${String(hour).padStart(2, '0')}h`,
    day,
    hour,
  }));
}

/**
 * Resolve a best-time suggestion to the NEXT matching future datetime, returned
 * as a `datetime-local`-ready string (local time, no timezone suffix). Advances
 * to next week if today's slot already passed.
 */
export function nextDateForWindow(day: number, hour: number): string {
  const now = new Date();
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  let delta = (day - now.getDay() + 7) % 7;
  if (delta === 0 && d.getTime() <= now.getTime()) delta = 7;
  d.setDate(d.getDate() + delta);
  // Format as YYYY-MM-DDTHH:mm in LOCAL time (datetime-local expects no TZ).
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(cdzApiUrl(path), {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const data = await res.json().catch(() => ({})) as T;
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export async function fetchAccounts(): Promise<AccountsResponse> {
  const r = await apiFetch<AccountsResponse>('/api/v1/social/accounts');
  if (r.ok) return r.data;
  return { enabled: false, accounts: [] };
}

// UP1 — poll ONE network's live connection status (used while a card shows
// "Connexion…" after the OAuth tab opens).
export async function fetchAccountStatus(
  network: string
): Promise<{ enabled: boolean; connected: boolean; status: string; accountId?: string }> {
  const r = await apiFetch<{ enabled?: boolean; connected?: boolean; status?: string; accountId?: string }>(
    `/api/v1/social/accounts/${encodeURIComponent(network)}/status`
  );
  if (r.ok) {
    return {
      enabled: !!r.data.enabled,
      connected: !!r.data.connected,
      status: r.data.status ?? 'unknown',
      accountId: r.data.accountId,
    };
  }
  return { enabled: false, connected: false, status: 'unknown' };
}

// ---------------------------------------------------------------------------
// UP1 — Config + advanced settings
// ---------------------------------------------------------------------------

export async function fetchConfig(): Promise<SocialConfig> {
  const r = await apiFetch<SocialConfig>('/api/v1/social/config');
  if (r.ok && r.data) return r.data;
  return { composioConfigured: false, aiConfigured: false, networks: [], mode: 'disabled' };
}

export async function fetchSettings(): Promise<SocialSettings> {
  const r = await apiFetch<SocialSettings>('/api/v1/social/settings');
  if (r.ok && r.data && typeof r.data === 'object') return r.data;
  return {};
}

/**
 * PUT advanced settings. Network defaults merge per-slug server-side; passing
 * an explicit empty section (e.g. { networks: { twitter: {} } }) clears it.
 * Returns the normalized result the server persisted.
 */
export async function saveSettings(
  patch: SocialSettings
): Promise<{ ok: boolean; settings?: SocialSettings; error?: string }> {
  const r = await apiFetch<SocialSettings & { error?: string }>(
    '/api/v1/social/settings',
    { method: 'PUT', body: JSON.stringify(patch) }
  );
  if (r.ok) return { ok: true, settings: r.data as SocialSettings };
  return { ok: false, error: (r.data as Record<string, unknown> | undefined)?.error as string | undefined };
}

export async function connectAccount(
  network: string
): Promise<{ ok: boolean; redirectUrl?: string; error?: string; detail?: string }> {
  const r = await apiFetch<{ redirectUrl?: string; error?: string; detail?: string }>(
    `/api/v1/social/accounts/${encodeURIComponent(network)}/connect`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  if (r.ok && r.data.redirectUrl) return { ok: true, redirectUrl: r.data.redirectUrl };
  return { ok: false, error: r.data.error, detail: r.data.detail };
}

export async function disconnectAccount(
  network: string
): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch<{ ok?: boolean; error?: string }>(
    `/api/v1/social/accounts/${encodeURIComponent(network)}`,
    { method: 'DELETE' }
  );
  return { ok: r.ok && !!r.data.ok, error: r.data.error };
}

// ---------------------------------------------------------------------------
// Compose (AI)
// ---------------------------------------------------------------------------

export async function composeContent(opts: {
  brief: string;
  networks?: string[];
  tone?: string;
  perNetwork?: boolean;
  hashtags?: boolean;
  emoji?: boolean;
}): Promise<{ ok: boolean; data?: ComposeResponse; error?: string }> {
  const r = await apiFetch<ComposeResponse & { error?: string }>(
    '/api/v1/social/compose',
    { method: 'POST', body: JSON.stringify(opts) }
  );
  if (r.ok) return { ok: true, data: r.data };
  // WS17: r.data may be undefined when the response has no JSON body — guard
  // before casting so a malformed error response can't throw a TypeError.
  return {
    ok: false,
    error: r.data ? (r.data as Record<string, unknown>).error as string | undefined : undefined,
  };
}

// ---------------------------------------------------------------------------
// Posts CRUD
// ---------------------------------------------------------------------------

export async function createOrUpdatePost(body: {
  id?: string;
  text: string;
  media?: SocialMedia[];
  targets: Array<{ network: string; text?: string }>;
  scheduledAt?: number;
  publishNow?: boolean;
  // UP1
  firstComment?: string;
  submitForApproval?: boolean;
}): Promise<{ ok: boolean; post?: SocialPost; error?: string; message?: string; detail?: string }> {
  const r = await apiFetch<SocialPost & { error?: string; message?: string }>(
    '/api/v1/social/posts',
    { method: 'POST', body: JSON.stringify(body) }
  );
  if (r.ok) return { ok: true, post: r.data as SocialPost };
  // WS17: r.data may be undefined for an empty/non-JSON body — guard before
  // casting so a malformed error response can't throw a TypeError.
  const errData = r.data as Record<string, unknown> | undefined;
  return {
    ok: false,
    error: errData ? (errData.error as string | undefined) : undefined,
    message: errData ? (errData.message as string | undefined) : undefined,
    // UP1 — queue-rule 409s carry a human `detail` (e.g. min-gap / max-per-day).
    detail: errData ? (errData.detail as string | undefined) : undefined,
  };
}

// ---------------------------------------------------------------------------
// UP1 — approve a pending-approval post (approver action). Publishes now or
// enqueues the scheduled job depending on the stored scheduledAt.
// ---------------------------------------------------------------------------
export async function approvePost(
  id: string
): Promise<{ ok: boolean; post?: SocialPost; error?: string; detail?: string }> {
  const r = await apiFetch<SocialPost & { error?: string; detail?: string }>(
    `/api/v1/social/posts/${encodeURIComponent(id)}/approve`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  if (r.ok) return { ok: true, post: r.data as SocialPost };
  const errData = r.data as Record<string, unknown> | undefined;
  return {
    ok: false,
    error: errData ? (errData.error as string | undefined) : undefined,
    detail: errData ? (errData.detail as string | undefined) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Media upload (WS17) — store an uploaded file and get a PUBLIC URL Composio
// can fetch. Browser blob: URLs can't be used (Composio can't reach them).
// ---------------------------------------------------------------------------
export async function uploadMedia(
  file: File
): Promise<{ ok: boolean; url?: string; kind?: 'image' | 'video'; mime?: string; error?: string }> {
  const kind: 'image' | 'video' = file.type.startsWith('video') ? 'video' : 'image';
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
  const r = await apiFetch<{ url: string; kind: string; mime: string } & { error?: string }>(
    '/api/v1/social/media/upload',
    {
      method: 'POST',
      body: JSON.stringify({ kind, mime: file.type || (kind === 'video' ? 'video/mp4' : 'image/png'), base64: dataUrl, name: file.name }),
    }
  );
  if (r.ok) return { ok: true, url: r.data.url, kind, mime: r.data.mime || file.type };
  return { ok: false, error: (r.data as Record<string, unknown> | undefined)?.error as string | undefined };
}

export async function listPosts(opts?: {
  status?: SocialStatus;
  from?: number;
  to?: number;
}): Promise<SocialPostSummary[]> {
  const params = new URLSearchParams();
  if (opts?.status) params.set('status', opts.status);
  if (opts?.from != null) params.set('from', String(opts.from));
  if (opts?.to != null) params.set('to', String(opts.to));
  const q = params.toString();
  const r = await apiFetch<SocialPostSummary[]>(
    `/api/v1/social/posts${q ? '?' + q : ''}`
  );
  return r.ok && Array.isArray(r.data) ? r.data : [];
}

export async function getPost(
  id: string
): Promise<{ ok: boolean; post?: SocialPost; notFound?: boolean }> {
  const r = await apiFetch<SocialPost & { error?: string }>(`/api/v1/social/posts/${encodeURIComponent(id)}`);
  if (r.ok) return { ok: true, post: r.data as SocialPost };
  if (r.status === 404) return { ok: false, notFound: true };
  return { ok: false };
}

export async function deletePost(id: string): Promise<boolean> {
  const r = await apiFetch<{ ok?: boolean }>(
    `/api/v1/social/posts/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
  return r.ok;
}

export async function reschedulePost(
  id: string,
  scheduledAt: number
): Promise<{ ok: boolean; post?: SocialPost; error?: string }> {
  const r = await apiFetch<SocialPost & { error?: string; message?: string }>(
    `/api/v1/social/posts/${encodeURIComponent(id)}/reschedule`,
    { method: 'POST', body: JSON.stringify({ scheduledAt }) }
  );
  if (r.ok) return { ok: true, post: r.data as SocialPost };
  return {
    ok: false,
    error:
      ((r.data as Record<string, unknown>).message as string | undefined) ||
      ((r.data as Record<string, unknown>).error as string | undefined),
  };
}

export async function retryPost(
  id: string
): Promise<{ ok: boolean; post?: SocialPost; error?: string }> {
  const r = await apiFetch<SocialPost & { error?: string; message?: string }>(
    `/api/v1/social/posts/${encodeURIComponent(id)}/retry`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  if (r.ok) return { ok: true, post: r.data as SocialPost };
  return {
    ok: false,
    error:
      ((r.data as Record<string, unknown>).message as string | undefined) ||
      ((r.data as Record<string, unknown>).error as string | undefined),
  };
}

// ---------------------------------------------------------------------------
// Log + Analytics
// ---------------------------------------------------------------------------

export async function fetchLog(): Promise<PublishedLogEntry[]> {
  const r = await apiFetch<PublishedLogEntry[]>('/api/v1/social/log');
  return r.ok && Array.isArray(r.data) ? r.data : [];
}

export async function fetchAnalytics(
  network: string
): Promise<AnalyticsResponse> {
  const r = await apiFetch<AnalyticsResponse>(
    `/api/v1/social/analytics/${encodeURIComponent(network)}`
  );
  if (r.ok) return r.data;
  return { available: false, network };
}

// ---------------------------------------------------------------------------
// CDZIMAGE — AI image generation (POST /api/v1/images/generations)
// ---------------------------------------------------------------------------

export async function generateImage(
  prompt: string,
  modelId: string
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const r = await apiFetch<{ data?: Array<{ url?: string }>; error?: string }>(
    '/api/v1/images/generations',
    { method: 'POST', body: JSON.stringify({ prompt, model: modelId }) }
  );
  if (r.ok) {
    const url = r.data.data?.[0]?.url;
    if (url) return { ok: true, url };
    return { ok: false, error: 'no_url' };
  }
  return { ok: false, error: r.data.error };
}
