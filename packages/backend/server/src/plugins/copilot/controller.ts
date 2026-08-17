import {
  BeforeApplicationShutdown,
  Controller,
  Get,
  Logger,
  Param,
  Query,
  Req,
  Res,
  Sse,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  BehaviorSubject,
  catchError,
  filter,
  finalize,
  from,
  interval,
  lastValueFrom,
  map,
  merge,
  Observable,
  of,
  Subject,
  take,
  takeUntil,
} from 'rxjs';

import {
  applyAttachHeaders,
  BlobNotFound,
  CallMetric,
  Config,
  mapSseError,
  metrics,
} from '../../base';
import { CurrentUser, Public } from '../../core/auth';
import {
  type ContextMode,
  parseContextMode,
} from './conversation/store';
import {
  ActionStreamHost,
  projectActionEventToChatEvent,
} from './runtime/hosts/action-stream-host';
import { TurnOrchestrator } from './runtime/turn-orchestrator';
import { isUpstreamScenarioFailed } from './runtime/upstream-error-detector';
import { CopilotStorage } from './storage';
import { getSignal } from './utils';

export interface ChatEvent {
  type: 'event' | 'attachment' | 'message' | 'error' | 'ping';
  id?: string;
  data: string | object;
}

const PING_INTERVAL = 5000;

// ---- WS11 STOCK — multi-provider stock photo search ------------------------

/** Providers the stock search can serve. Openverse requires NO api key. */
const STOCK_PROVIDERS = ['openverse', 'pexels', 'pixabay', 'unsplash'] as const;
type StockProvider = (typeof STOCK_PROVIDERS)[number];

const STOCK_PROVIDER_LABELS: Record<StockProvider, string> = {
  openverse: 'Openverse',
  pexels: 'Pexels',
  pixabay: 'Pixabay',
  unsplash: 'Unsplash',
};

/**
 * One normalized stock photo. New consumers read the flat fields
 * (`url`/`thumb`/`full`/`author`/`link`/`source`); the `urls` block mirrors
 * the original Unsplash passthrough shape (`results[].urls.regular`) so the
 * legacy consumers (Vdz media bin, the edgeless photoEngine in
 * setup-provider.tsx) keep working unchanged.
 */
interface StockPhoto {
  id: string;
  source: StockProvider;
  /** Display-quality image URL (same value as `urls.regular`). */
  url: string;
  thumb: string;
  full: string;
  width: number | null;
  height: number | null;
  description: string;
  author: string;
  authorUrl: string | null;
  /** Landing page for the photo on its provider (use for credit links). */
  link: string;
  license?: string;
  urls: { thumb: string; small: string; regular: string; full: string };
}

type StockProviderOutcome =
  | { ok: true; results: StockPhoto[]; totalPages: number | null }
  | { ok: false; status?: number; message: string };

const STOCK_UPSTREAM_TIMEOUT_MS = 15_000;
/** Openverse's anonymous page-size cap (20) is the lowest common cap. */
const STOCK_MAX_PER_PAGE = 20;

/** Parse an int query param with clamping; `fallback` when absent/invalid. */
function stockInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function stockNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stockStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Build a normalized {@link StockPhoto}; null when no usable image URL. */
function stockPhoto(input: {
  source: StockProvider;
  id: string;
  thumb?: string;
  regular?: string;
  full?: string;
  width?: unknown;
  height?: unknown;
  description?: string;
  author?: string;
  authorUrl?: string;
  link?: string;
  license?: string;
}): StockPhoto | null {
  const regular = input.regular || input.full || input.thumb || '';
  if (!regular) return null;
  const thumb = input.thumb || regular;
  const full = input.full || regular;
  return {
    id: input.id,
    source: input.source,
    url: regular,
    thumb,
    full,
    width: stockNum(input.width),
    height: stockNum(input.height),
    description: input.description || '',
    author: input.author || '',
    authorUrl: input.authorUrl || null,
    link: input.link || regular,
    license: input.license || undefined,
    urls: { thumb, small: thumb, regular, full },
  };
}

/**
 * Fetch an upstream stock API defensively: network errors, non-2xx statuses
 * and non-JSON bodies (e.g. Unsplash's text/plain "Rate Limit Exceeded",
 * which crashed the old handler's `response.json()`) all come back as
 * values — this never throws.
 */
async function stockFetch(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<
  | { ok: true; json: any }
  | { ok: false; status?: number; message: string }
> {
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, { headers, signal });
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'network request failed',
    };
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: text.slice(0, 200) || response.statusText || 'upstream error',
    };
  }
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      status: response.status,
      message: 'invalid (non-JSON) upstream response',
    };
  }
}

/** Format Openverse's license fields into a short credit-friendly label. */
function openverseLicense(license: string, version: string): string {
  if (!license) return '';
  const lower = license.toLowerCase();
  const name =
    lower === 'cc0'
      ? 'CC0'
      : lower === 'pdm'
        ? 'Public Domain'
        : `CC ${license.toUpperCase()}`;
  return version && lower !== 'pdm' ? `${name} ${version}` : name;
}

/** Openverse — https://api.openverse.org/v1/images/ — no API key required. */
async function searchOpenverse(
  query: string,
  page: number,
  perPage: number,
  signal: AbortSignal
): Promise<StockProviderOutcome> {
  const qs = new URLSearchParams({
    page: String(page),
    page_size: String(perPage),
    mature: 'false',
  });
  if (query) qs.set('q', query);
  const upstream = await stockFetch(
    `https://api.openverse.org/v1/images/?${qs}`,
    { Accept: 'application/json' },
    signal
  );
  if (!upstream.ok) return upstream;
  const data = upstream.json as {
    page_count?: number;
    results?: Array<Record<string, any>>;
  };
  const rows = Array.isArray(data.results) ? data.results : [];
  const results: StockPhoto[] = [];
  rows.forEach((row, index) => {
    const full = stockStr(row.url);
    const thumb = stockStr(row.thumbnail);
    const photo = stockPhoto({
      source: 'openverse',
      id: `openverse-${stockStr(row.id) || index}`,
      thumb: thumb || full,
      regular: full || thumb,
      full: full || thumb,
      width: row.width,
      height: row.height,
      description: stockStr(row.title),
      author: stockStr(row.creator) || 'Unknown creator',
      authorUrl: stockStr(row.creator_url),
      link: stockStr(row.foreign_landing_url),
      license: openverseLicense(
        stockStr(row.license),
        stockStr(row.license_version)
      ),
    });
    if (photo) results.push(photo);
  });
  return { ok: true, results, totalPages: stockNum(data.page_count) };
}

/** Pexels — https://api.pexels.com/v1 — needs PEXELS_API_KEY. */
async function searchPexels(
  key: string,
  query: string,
  page: number,
  perPage: number,
  signal: AbortSignal
): Promise<StockProviderOutcome> {
  const qs = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });
  let endpoint = 'https://api.pexels.com/v1/curated';
  if (query) {
    qs.set('query', query);
    endpoint = 'https://api.pexels.com/v1/search';
  }
  const upstream = await stockFetch(
    `${endpoint}?${qs}`,
    { Authorization: key },
    signal
  );
  if (!upstream.ok) return upstream;
  const data = upstream.json as {
    total_results?: number;
    photos?: Array<Record<string, any>>;
  };
  const rows = Array.isArray(data.photos) ? data.photos : [];
  const results: StockPhoto[] = [];
  rows.forEach((row, index) => {
    const src = (row.src ?? {}) as Record<string, unknown>;
    const photo = stockPhoto({
      source: 'pexels',
      id: `pexels-${row.id ?? index}`,
      thumb: stockStr(src.medium) || stockStr(src.small),
      regular: stockStr(src.large2x) || stockStr(src.large),
      full: stockStr(src.original),
      width: row.width,
      height: row.height,
      description: stockStr(row.alt),
      author: stockStr(row.photographer),
      authorUrl: stockStr(row.photographer_url),
      link: stockStr(row.url),
    });
    if (photo) results.push(photo);
  });
  const total = stockNum(data.total_results);
  return {
    ok: true,
    results,
    totalPages: total === null ? null : Math.max(1, Math.ceil(total / perPage)),
  };
}

/** Pixabay — https://pixabay.com/api/ — needs PIXABAY_API_KEY. */
async function searchPixabay(
  key: string,
  query: string,
  page: number,
  perPage: number,
  signal: AbortSignal
): Promise<StockProviderOutcome> {
  const qs = new URLSearchParams({
    key,
    image_type: 'photo',
    safesearch: 'true',
    page: String(page),
    // Pixabay rejects per_page < 3.
    per_page: String(Math.max(3, perPage)),
  });
  if (query) qs.set('q', query);
  const upstream = await stockFetch(
    `https://pixabay.com/api/?${qs}`,
    { Accept: 'application/json' },
    signal
  );
  if (!upstream.ok) return upstream;
  const data = upstream.json as {
    totalHits?: number;
    hits?: Array<Record<string, any>>;
  };
  const rows = Array.isArray(data.hits) ? data.hits : [];
  const results: StockPhoto[] = [];
  rows.forEach((row, index) => {
    const photo = stockPhoto({
      source: 'pixabay',
      id: `pixabay-${row.id ?? index}`,
      thumb: stockStr(row.webformatURL) || stockStr(row.previewURL),
      regular: stockStr(row.largeImageURL) || stockStr(row.webformatURL),
      full:
        stockStr(row.fullHDURL) ||
        stockStr(row.largeImageURL) ||
        stockStr(row.webformatURL),
      width: row.imageWidth,
      height: row.imageHeight,
      description: stockStr(row.tags),
      author: stockStr(row.user),
      authorUrl:
        row.user && row.user_id
          ? `https://pixabay.com/users/${row.user}-${row.user_id}/`
          : '',
      link: stockStr(row.pageURL),
    });
    if (photo) results.push(photo);
  });
  const total = stockNum(data.totalHits);
  return {
    ok: true,
    results,
    totalPages: total === null ? null : Math.max(1, Math.ceil(total / perPage)),
  };
}

/** Unsplash — https://api.unsplash.com — needs an access key (as before). */
async function searchUnsplash(
  key: string,
  query: string,
  page: number,
  perPage: number,
  signal: AbortSignal
): Promise<StockProviderOutcome> {
  const qs = new URLSearchParams({
    query,
    page: String(page),
    per_page: String(perPage),
  });
  const upstream = await stockFetch(
    `https://api.unsplash.com/search/photos?${qs}`,
    { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' },
    signal
  );
  if (!upstream.ok) return upstream;
  const data = upstream.json as {
    total_pages?: number;
    results?: Array<Record<string, any>>;
  };
  const rows = Array.isArray(data.results) ? data.results : [];
  const results: StockPhoto[] = [];
  rows.forEach((row, index) => {
    const urls = (row.urls ?? {}) as Record<string, unknown>;
    const user = (row.user ?? {}) as Record<string, any>;
    const links = (row.links ?? {}) as Record<string, unknown>;
    const photo = stockPhoto({
      source: 'unsplash',
      id: `unsplash-${stockStr(row.id) || index}`,
      thumb: stockStr(urls.small) || stockStr(urls.thumb),
      regular: stockStr(urls.regular),
      full: stockStr(urls.full) || stockStr(urls.raw),
      width: row.width,
      height: row.height,
      description: stockStr(row.alt_description) || stockStr(row.description),
      author: stockStr(user.name) || stockStr(user.username),
      authorUrl: stockStr(user.links?.html),
      link: stockStr(links.html),
    });
    if (photo) results.push(photo);
  });
  return { ok: true, results, totalPages: stockNum(data.total_pages) };
}

@Controller('/api/copilot')
export class CopilotController implements BeforeApplicationShutdown {
  private readonly logger = new Logger(CopilotController.name);
  private readonly ongoingStreamCount$ = new BehaviorSubject(0);

  constructor(
    private readonly config: Config,
    private readonly orchestrator: TurnOrchestrator,
    private readonly actionStreams: ActionStreamHost,
    private readonly storage: CopilotStorage
  ) {}

  async beforeApplicationShutdown() {
    await lastValueFrom(
      this.ongoingStreamCount$.asObservable().pipe(
        filter(count => count === 0),
        take(1)
      )
    );
    this.ongoingStreamCount$.complete();
  }

  private mergePingStream(
    messageId: string,
    source$: Observable<ChatEvent>
  ): Observable<ChatEvent> {
    const subject$ = new Subject();
    const ping$ = interval(PING_INTERVAL).pipe(
      map(() => ({ type: 'ping' as const, id: messageId, data: '' })),
      takeUntil(subject$)
    );

    return merge(source$.pipe(finalize(() => subject$.next(null))), ping$);
  }

  private toMessageEvent(messageId: string | undefined, data: string | object) {
    return { type: 'message' as const, id: messageId, data };
  }

  private toAttachmentEvent(messageId: string | undefined, data: string) {
    return { type: 'attachment' as const, id: messageId, data };
  }

  /**
   * WS17 — wrap mapSseError for the chat routes so an upstream cdz-ai
   * "Scenario failed to complete" 502 (an intermittent Make-scenario flake,
   * characterized by a sustained probe as model-specific to cdz-sage under
   * concurrency) surfaces a clear, actionable French message instead of the
   * generic "An error occurred". The root cause is upstream (the cdz-ai Make
   * scenario), not a clickdz-work code bug — the durable fix is in the Make
   * scenario, but the user-facing clarity is the correct UX here. A silent
   * mid-stream auto-retry is deliberately NOT attempted (it could double-charge
   * or garble output); instead we tell the user to retry, which re-runs the
   * turn from a clean state.
   */
  private cdzChatSseError(originalError: any, info: object) {
    if (isUpstreamScenarioFailed(originalError)) {
      this.logger.warn(
        `[chat] upstream scenario-failed 502 surfaced to user — model=${(info as any)?.model ?? '?'}`
      );
      metrics.sse.counter('cdz_scenario_failed').add(1);
      // Emit a typed error event the FE renders as the red banner, but with a
      // clear message pointing to retry (the upstream flake is transient).
      return of({
        type: 'error' as const,
        data: {
          status: 502,
          code: 'upstream_scenario_failed',
          name: 'UPSTREAM_SCENARIO_FAILED',
          message:
            "Le service IA a rencontré un problème temporaire (scénario en amont). Renvoyez votre message — ça marche généralement du premier coup.",
        },
      });
    }
    return mapSseError(originalError, info);
  }

  /**
   * WS2 — normalise the `?contextMode=` query param on the chat SSE endpoints.
   *
   * Valid values are 'recent' | 'compact' | 'fresh'; anything else (including
   * an absent param) narrows to `undefined`. The normalised value is written
   * back onto the same `query` object that is forwarded untouched to the
   * orchestrator (RECON F.3), where `ChatQuerySchema.catchall` carries it
   * through to history materialization/clamping. When the param is absent this
   * is a no-op — the query is unchanged and behaviour is byte-identical.
   */
  private normalizeContextMode(
    query: Record<string, string>
  ): ContextMode | undefined {
    const contextMode = parseContextMode(query.contextMode);
    if (contextMode) {
      query.contextMode = contextMode;
    } else {
      // Strip any stray/invalid value so it can never reach downstream parsing.
      delete query.contextMode;
    }
    return contextMode;
  }

  @Sse('/chat/:sessionId/stream')
  @CallMetric('ai', 'chat_stream', { timer: true })
  async chatStream(
    @CurrentUser() user: CurrentUser,
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
    @Query() query: Record<string, string>
  ): Promise<Observable<ChatEvent>> {
    const contextMode = this.normalizeContextMode(query);
    const info: any = {
      sessionId,
      params: query,
      contextMode,
      throwInStream: false,
    };

    try {
      const { signal, onConnectionClosed } = getSignal(req);
      let endBeforePromiseResolve = false;
      onConnectionClosed(isAborted => {
        if (isAborted) {
          endBeforePromiseResolve = true;
        }
      });

      const prepared = await this.orchestrator.streamText(
        user.id,
        sessionId,
        query,
        signal,
        () => endBeforePromiseResolve
      );

      info.model = prepared.model;
      info.finalMessage = prepared.finalMessage.filter(
        m => m.role !== 'system'
      );
      metrics.ai.counter('chat_stream_calls').add(1, { model: prepared.model });
      this.ongoingStreamCount$.next(this.ongoingStreamCount$.value + 1);

      const source$ = from(prepared.stream).pipe(
        map(data => this.toMessageEvent(prepared.messageId, data)),
        catchError(e => {
          metrics.ai.counter('chat_stream_errors').add(1);
          info.throwInStream = true;
          return this.cdzChatSseError(e, info);
        }),
        finalize(() => {
          this.ongoingStreamCount$.next(this.ongoingStreamCount$.value - 1);
        })
      );

      return this.mergePingStream(prepared.messageId || '', source$);
    } catch (err) {
      metrics.ai.counter('chat_stream_errors').add(1, info);
      return this.cdzChatSseError(err, info);
    }
  }

  @Sse('/chat/:sessionId/stream-object')
  @CallMetric('ai', 'chat_object_stream', { timer: true })
  async chatStreamObject(
    @CurrentUser() user: CurrentUser,
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
    @Query() query: Record<string, string>
  ): Promise<Observable<ChatEvent>> {
    const contextMode = this.normalizeContextMode(query);
    const info: any = {
      sessionId,
      params: query,
      contextMode,
      throwInStream: false,
    };

    try {
      const { signal, onConnectionClosed } = getSignal(req);
      let endBeforePromiseResolve = false;
      onConnectionClosed(isAborted => {
        if (isAborted) {
          endBeforePromiseResolve = true;
        }
      });

      const prepared = await this.orchestrator.streamObject(
        user.id,
        sessionId,
        query,
        signal,
        () => endBeforePromiseResolve
      );

      info.model = prepared.model;
      info.finalMessage = prepared.finalMessage.filter(
        m => m.role !== 'system'
      );
      metrics.ai.counter('chat_object_stream_calls').add(1, {
        model: prepared.model,
      });
      this.ongoingStreamCount$.next(this.ongoingStreamCount$.value + 1);

      const source$ = from(prepared.stream).pipe(
        map(data => this.toMessageEvent(prepared.messageId, data)),
        catchError(e => {
          metrics.ai.counter('chat_object_stream_errors').add(1);
          info.throwInStream = true;
          return this.cdzChatSseError(e, info);
        }),
        finalize(() => {
          this.ongoingStreamCount$.next(this.ongoingStreamCount$.value - 1);
        })
      );

      return this.mergePingStream(prepared.messageId || '', source$);
    } catch (err) {
      metrics.ai.counter('chat_object_stream_errors').add(1, info);
      return this.cdzChatSseError(err, info);
    }
  }

  @Sse('/actions/:sessionId/stream')
  @CallMetric('ai', 'action_stream', { timer: true })
  async actionStream(
    @CurrentUser() user: CurrentUser,
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
    @Query() query: Record<string, string>
  ): Promise<Observable<ChatEvent>> {
    const info: any = { sessionId, params: query, throwInStream: false };
    try {
      const { signal } = getSignal(req);

      const prepared = await this.actionStreams.stream(
        user.id,
        sessionId,
        query,
        signal
      );
      info.actionId = prepared.actionId;
      info.actionVersion = prepared.actionVersion;
      metrics.ai.counter('action_stream_calls').add(1, {
        actionId: prepared.actionId,
        actionVersion: prepared.actionVersion,
      });
      this.ongoingStreamCount$.next(this.ongoingStreamCount$.value + 1);

      const source$ = from(prepared.stream).pipe(
        map(data => projectActionEventToChatEvent(prepared.messageId, data)),
        catchError(e => {
          metrics.ai.counter('action_stream_errors').add(1, info);
          info.throwInStream = true;
          return this.cdzChatSseError(e, info);
        }),
        finalize(() =>
          this.ongoingStreamCount$.next(this.ongoingStreamCount$.value - 1)
        )
      );

      return this.mergePingStream(prepared.messageId || '', source$);
    } catch (err) {
      metrics.ai.counter('action_stream_errors').add(1, info);
      return this.cdzChatSseError(err, info);
    }
  }

  @Sse('/chat/:sessionId/images')
  @CallMetric('ai', 'chat_images', { timer: true })
  async chatImagesStream(
    @CurrentUser() user: CurrentUser,
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
    @Query() query: Record<string, string>
  ): Promise<Observable<ChatEvent>> {
    const info: any = { sessionId, params: query, throwInStream: false };
    try {
      const { signal, onConnectionClosed } = getSignal(req);
      let endBeforePromiseResolve = false;
      onConnectionClosed(isAborted => {
        if (isAborted) {
          endBeforePromiseResolve = true;
        }
      });

      const prepared = await this.orchestrator.streamImages(
        user.id,
        sessionId,
        query,
        signal,
        () => endBeforePromiseResolve
      );
      info.model = prepared.model;
      metrics.ai.counter('images_stream_calls').add(1, {
        model: prepared.model,
      });
      this.ongoingStreamCount$.next(this.ongoingStreamCount$.value + 1);

      const source$ = from(prepared.stream).pipe(
        map(attachment =>
          this.toAttachmentEvent(prepared.messageId, attachment)
        ),
        catchError(e => {
          metrics.ai.counter('images_stream_errors').add(1, info);
          info.throwInStream = true;
          return mapSseError(e, info);
        }),
        finalize(() =>
          this.ongoingStreamCount$.next(this.ongoingStreamCount$.value - 1)
        )
      );

      return this.mergePingStream(prepared.messageId || '', source$);
    } catch (err) {
      metrics.ai.counter('images_stream_errors').add(1, info);
      return mapSseError(err, info);
    }
  }

  // ---- Stock photo search (WS11 STOCK) ------------------------------------
  //
  // The old handler here was an Unsplash-only passthrough that THREW
  // `UnsplashIsNotConfigured` (typed internal_server_error → HTTP 500)
  // whenever `copilot.unsplash.key` was unset — its default, with no env
  // binding — so the stock tab 500'd on every deployment without a key. It
  // also crashed on non-JSON upstream bodies (Unsplash rate-limit replies
  // are text/plain). It is now a multi-provider search that never 500s:
  // keyless Openverse is always available, keyed providers (Pexels /
  // Pixabay / Unsplash) light up when their keys are present, and every
  // outcome — including failures — is an explicit JSON reply via `res`
  // (never a raw throw, which the global exception filter would coerce to
  // a 500).

  /**
   * Legacy route, kept fully backward compatible: same multi-provider
   * search; `source=auto` (the default here) keeps the old Unsplash
   * behavior when its key is configured and falls back to keyless
   * Openverse instead of throwing a 500. Result items keep the
   * `urls.regular` alias the old consumers read.
   */
  @Get('/unsplash/photos')
  @CallMetric('ai', 'unsplash')
  async unsplashPhotos(
    @Req() req: Request,
    @Res() res: Response,
    @Query() params: Record<string, string>
  ) {
    await this.stockSearch(req, res, params);
  }

  /**
   * Clean alias for the same search:
   * `GET /api/copilot/stock/search?query=&source=&page=&per_page=`
   * with `source` ∈ openverse | pexels | pixabay | unsplash | auto.
   */
  @Get('/stock/search')
  @CallMetric('ai', 'stock_search')
  async stockSearchPhotos(
    @Req() req: Request,
    @Res() res: Response,
    @Query() params: Record<string, string>
  ) {
    await this.stockSearch(req, res, params);
  }

  private async stockSearch(
    req: Request,
    res: Response,
    params: Record<string, string>
  ) {
    // Key lookups: keep the existing admin-panel/config.json Unsplash key
    // working, read plain env vars for everything else (no config plumbing).
    // The values never leave this scope — never logged, never echoed in a
    // response body (`scrub` below redacts them from upstream error text).
    const keys = {
      pexels: process.env.PEXELS_API_KEY || '',
      pixabay: process.env.PIXABAY_API_KEY || '',
      unsplash:
        this.config.copilot.unsplash.key ||
        process.env.UNSPLASH_ACCESS_KEY ||
        '',
    };
    const providers: Record<StockProvider, boolean> = {
      openverse: true,
      pexels: !!keys.pexels,
      pixabay: !!keys.pixabay,
      unsplash: !!keys.unsplash,
    };
    const scrub = (text: string) => {
      let out = text;
      for (const key of Object.values(keys)) {
        if (key) out = out.split(key).join('[redacted]');
      }
      return out;
    };

    try {
      const requested = String(params.source ?? 'auto').toLowerCase();
      const source: StockProvider = (
        STOCK_PROVIDERS as readonly string[]
      ).includes(requested)
        ? (requested as StockProvider)
        : // `auto` (and anything unknown): the legacy behavior — Unsplash
          // when its key is configured — then other keyed providers, then
          // keyless Openverse, which always works.
          keys.unsplash
          ? 'unsplash'
          : keys.pexels
            ? 'pexels'
            : keys.pixabay
              ? 'pixabay'
              : 'openverse';

      if (source !== 'openverse' && !keys[source]) {
        res.status(400).json({
          error: 'stock_source_not_configured',
          source,
          message: `${STOCK_PROVIDER_LABELS[source]} is not configured on this server — try Openverse (no key needed).`,
          providers,
          results: [],
        });
        return;
      }

      const query = String(params.query ?? params.q ?? '')
        .trim()
        .slice(0, 100);
      const page = stockInt(params.page, 1, 1, 500);
      const perPage = stockInt(
        params.per_page ?? params.pageSize,
        STOCK_MAX_PER_PAGE,
        1,
        STOCK_MAX_PER_PAGE
      );

      // Unsplash's search endpoint rejects an empty query; the keyless
      // sources return a browsable listing instead, so only gate this one.
      if (source === 'unsplash' && !query) {
        res.status(400).json({
          error: 'stock_query_required',
          source,
          message: 'Type something to search Unsplash.',
          providers,
          results: [],
        });
        return;
      }

      // Cancel the upstream call when the client goes away, and never hang
      // past the timeout (AbortSignal.any needs node ≥ 20.3 — fall back to
      // the plain timeout signal elsewhere).
      const timeout = AbortSignal.timeout(STOCK_UPSTREAM_TIMEOUT_MS);
      const client = getSignal(req).signal;
      const anySignals = (
        AbortSignal as unknown as {
          any?: (signals: AbortSignal[]) => AbortSignal;
        }
      ).any;
      const signal =
        typeof anySignals === 'function'
          ? anySignals.call(AbortSignal, [client, timeout])
          : timeout;

      const outcome: StockProviderOutcome =
        source === 'openverse'
          ? await searchOpenverse(query, page, perPage, signal)
          : source === 'pexels'
            ? await searchPexels(keys.pexels, query, page, perPage, signal)
            : source === 'pixabay'
              ? await searchPixabay(keys.pixabay, query, page, perPage, signal)
              : await searchUnsplash(
                  keys.unsplash,
                  query,
                  page,
                  perPage,
                  signal
                );

      if (!outcome.ok) {
        this.logger.warn(
          `stock search upstream failed: source=${source} status=${outcome.status ?? 'n/a'} detail=${scrub(outcome.message)}`
        );
        res.status(502).json({
          error: 'stock_upstream_error',
          source,
          status: outcome.status ?? null,
          message: `${STOCK_PROVIDER_LABELS[source]} search failed${outcome.status ? ` (${outcome.status})` : ''} — try another source.`,
          providers,
          results: [],
        });
        return;
      }

      metrics.ai
        .counter('stock_search_results')
        .add(outcome.results.length, { source });
      res.status(200).json({
        source,
        query,
        page,
        perPage,
        totalPages: outcome.totalPages,
        results: outcome.results,
        providers,
      });
    } catch (err) {
      // Belt and braces: nothing above should throw, but a raw throw would
      // be coerced to a 500 by the global exception filter — reply safely.
      this.logger.warn(
        `stock search failed: ${scrub(err instanceof Error ? err.message : String(err))}`
      );
      if (!res.headersSent) {
        res.status(502).json({
          error: 'stock_upstream_error',
          message:
            'Stock search is temporarily unavailable — try another source.',
          providers,
          results: [],
        });
      }
    }
  }

  @Public()
  @Get('/blob/:userId/:workspaceId/:key')
  async getBlob(
    @Res() res: Response,
    @Param('userId') userId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('key') key: string
  ) {
    const { body, metadata, redirectUrl } = await this.storage.get(
      userId,
      workspaceId,
      key,
      true
    );

    if (redirectUrl) {
      // redirect to signed url
      return res.redirect(redirectUrl);
    }

    if (!body) {
      throw new BlobNotFound({
        spaceId: workspaceId,
        blobId: key,
      });
    }

    // metadata should always exists if body is not null
    if (metadata) {
      res.setHeader('content-type', metadata.contentType);
      res.setHeader('last-modified', metadata.lastModified.toUTCString());
      res.setHeader('content-length', metadata.contentLength);
    } else {
      this.logger.warn(`Blob ${workspaceId}/${key} has no metadata`);
    }
    applyAttachHeaders(res, {
      contentType: metadata?.contentType,
      filename: key,
    });

    res.setHeader('cache-control', 'public, max-age=2592000, immutable');
    body.pipe(res);
  }
}

