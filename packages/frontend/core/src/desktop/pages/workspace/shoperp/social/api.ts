// social/api.ts — typed client for all /api/v1/social/* E1 endpoints.
// Types mirror the backend contract (p3e1.md) exactly.
// All fetches: credentials:'include', cdzApiUrl() for the base.

import { cdzApiUrl } from '@affine/core/blocksuite/ai/provider/ai-provider';

// ---------------------------------------------------------------------------
// Shared types (mirror E1 contract exactly)
// ---------------------------------------------------------------------------

export type SocialStatus =
  | 'draft'
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
  results: Array<{ network: string; ok: boolean; externalUrl?: string }>;
}

export interface AccountStatus {
  network: string;
  connected: boolean;
}

export interface AccountsResponse {
  enabled: boolean;
  accounts: AccountStatus[];
}

export interface ConnectResponse {
  redirectUrl: string;
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
  return { ok: false, error: (r.data as Record<string, unknown>).error as string | undefined };
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
}): Promise<{ ok: boolean; post?: SocialPost; error?: string; message?: string }> {
  const r = await apiFetch<SocialPost & { error?: string; message?: string }>(
    '/api/v1/social/posts',
    { method: 'POST', body: JSON.stringify(body) }
  );
  if (r.ok) return { ok: true, post: r.data as SocialPost };
  return {
    ok: false,
    error: (r.data as Record<string, unknown>).error as string | undefined,
    message: (r.data as Record<string, unknown>).message as string | undefined,
  };
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
