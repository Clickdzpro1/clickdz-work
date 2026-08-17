import { Readable } from 'node:stream';

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

// SECURITY: typed AFFiNE errors so the global exception filter emits proper
// status codes (a raw @nestjs/common HttpException becomes a generic 500 here):
//  · BadRequest               -> 400 (missing / malformed / oversized input)
//  · NotFound                 -> 404 (unknown job / file not ready)
//  · CopilotProviderSideError -> render-service (upstream) failure, typed as a
//    provider error rather than a bare 502; kind:'not_configured' is the same
//    signal the compose controller uses when its engine env is unset.
//  · AuthenticationRequired   -> 401 (missing/invalid signed-blob token)
//  · AccessDenied             -> 403 (expired/mismatched signed-blob token)
//  · BlobNotFound             -> 404 (signed URL valid but the blob is gone)
// Throttle('strict') is the same hard per-IP cap the paid /apps + compose routes use.
// URLHelper mints ABSOLUTE, worker-fetchable urls from AFFINE_SERVER_EXTERNAL_URL
// (same idiom WorkspaceBlobStorage uses for avatar links).
import {
  AccessDenied,
  AuthenticationRequired,
  BadRequest,
  BlobNotFound,
  CopilotProviderSideError,
  NotFound,
  Throttle,
  URLHelper,
} from '../../base';
import { CacheRedis } from '../../base/redis';
import { CurrentUser, Public } from '../../core/auth';
import { PermissionAccess } from '../../core/permission';
import { WorkspaceBlobStorage } from '../../core/storage';
import { signBlobToken, verifyBlobToken } from './cdz-data-token';

// ---------------------------------------------------------------------------
// CDZ Render service wiring. The render service (cdz-render/, a standalone
// headless-Chrome node service) owns the actual MP4 rendering; this controller
// is the session-authed proxy in front of it, so the FRONTEND never sees the
// render token. Same self-contained stance as the peer ClickDz controllers:
// env-driven, imports nothing from the frontend, typed errors only.
// ---------------------------------------------------------------------------
const RENDER_URL = (process.env.CDZ_RENDER_URL || '').replace(/\/+$/, '');
const RENDER_TOKEN = process.env.CDZ_RENDER_TOKEN || '';

// ---------------------------------------------------------------------------
// OPTIONAL Remotion engine (true-video-export track). A SECOND, independent
// render backend — a standalone Remotion worker (clickdz-remotion-worker/) that
// renders a self-contained JSON manifest to MP4 with REAL video + audio (the
// fidelity the HTML/headless-Chrome tier cannot reach). Wiring is deliberately
// isolated from the HTML tier above so prod is untouched unless BOTH are true:
//   1. CDZ_REMOTION_URL is set on this deployment, AND
//   2. the request opts in with `body.engine === 'remotion'`.
// When either is false the render route takes EXACTLY the existing HTML path
// (byte-identical behavior). CDZ_REMOTION_TOKEN, when set, is sent as a bearer
// auth header (the worker validates it); when unset no auth header is sent
// (same env-driven stance as the HTML tier's token).
const REMOTION_URL = (process.env.CDZ_REMOTION_URL || '').replace(/\/+$/, '');
const REMOTION_TOKEN = process.env.CDZ_REMOTION_TOKEN || '';
// Job ids minted by the Remotion worker are tagged with this prefix so the
// shared status/file routes route a job to the RIGHT backend at poll time with
// no extra state. HTML-tier ids never carry it, so the existing path is
// unaffected; the prefix is stripped before the id reaches the worker.
const REMOTION_JOB_PREFIX = 'rmt:';

// ---------------------------------------------------------------------------
// C2 — explicit render params (SPLICE → this controller → cdz-render). All are
// OPTIONAL on the wire so the OLD app (which sends only {html}) is byte-for-byte
// unchanged: the classic branch only forwards a field when the client sent a
// valid one, and cdz-render keeps its own server-side defaults for anything
// absent. Bounds mirror cdz-render/server.mjs (and MOD/schema.ts's setCanvas).
// ---------------------------------------------------------------------------
const MIN_DIMENSION = 320; // px, per side floor
const MAX_DIMENSION = 4096; // px, per side ceiling (4K+)
const ALLOWED_FPS = new Set([24, 25, 30, 60]);
const DEFAULT_FPS = 30;
// Classic (HTML/headless-Chrome) tier length cap. Env-overridable (default 600s
// — up from the old hard 300s) so compositions up to 10 min use the FAST Classic
// tier instead of forcing the slow Remotion worker. Over this we reject at the
// edge with the C2 duration_cap body BEFORE round-tripping to cdz-render.
// NOTE: cdz-render's own MAX_DURATION_S must be raised to match (or exceed) this
// value, or the classic tier will reject the render server-side.
const CLASSIC_MAX_SEC = Number(process.env.CLASSIC_MAX_SEC || 600);

// ---------------------------------------------------------------------------
// C3 — signed-URL blob export (worker→app). The Remotion worker has NO app
// cookie/session, so it cannot use the permission-gated
// `GET /api/workspaces/:id/blobs/:name` route. Instead the FE mints short-lived
// signed URLs here (session-authed, Workspace.Read asserted) and the worker
// fetches them from the @Public() serve route below (HMAC + expiry gated).
// ---------------------------------------------------------------------------
// How long a minted blob URL stays valid. A render runs minutes and Chromium
// may re-fetch/seek media late in the render, so 45min gives ample slack over
// the ~10min FE poll ceiling + worker render time while dying well before a
// leaked URL could persist. Milliseconds (Date.now() domain), matching the
// token's `exp < Date.now()` check.
const BLOB_URL_TTL_MS = 45 * 60 * 1000;
// Defensive cap on a single mint request so one call can't sign an unbounded
// list. A timeline with hundreds of distinct media clips is already extreme.
const MAX_BLOB_IDS = 200;

// Caps mirror the render service's own validation (server.mjs) so we reject
// oversized/short payloads at the edge instead of round-tripping them.
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB
// A render manifest is JSON (not a 2 MB HTML blob) but can carry many clips +
// karaoke words; cap generously to reject a pathological payload at the edge
// (the worker validates the manifest shape itself and returns typed errors).
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024; // 4 MB
// A render can take minutes; the proxy calls are quick (enqueue / status /
// stream), so a generous-but-bounded timeout guards against a hung upstream.
const PROXY_TIMEOUT_MS = 30_000;
// The file stream can be large and slow; give it its own longer ceiling.
const FILE_PROXY_TIMEOUT_MS = 180_000;
// SEC-3: how long a render job's owner note is kept. Long enough that a user can
// come back for a finished MP4 later in the day, short enough that the mapping
// does not accumulate forever. Expiry is safe: an unknown owner fails OPEN, so
// the worst case for an aged-out job is today's behaviour.
const VDZ_JOB_OWNER_TTL_SEC = 7 * 24 * 60 * 60;
// The Remotion worker's enqueue round-trip; 120s matches the track spec —
// generous for a large manifest POST, bounded against a hung worker. Status and
// file polling reuse the HTML tier's PROXY_/FILE_PROXY_ timeouts.
const REMOTION_PROXY_TIMEOUT_MS = 120_000;

/**
 * Parse an optional integer dimension (width/height) from the request body.
 * Returns the validated int, or `null` when absent (→ let cdz-render default).
 * Throws a typed 400 when present-but-out-of-range so a bogus value never
 * silently renders at the wrong size.
 */
function parseDimension(value: unknown, field: 'width' | 'height'): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_DIMENSION || n > MAX_DIMENSION) {
    throw new BadRequest(
      `"${field}" must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION}`
    );
  }
  return n;
}

/**
 * Parse an optional fps. Returns the validated value, or `null` when absent (→
 * cdz-render applies DEFAULT_FPS). A present value MUST be one of the allowed
 * rates; an out-of-set value is a 400 (we do not silently coerce here, unlike
 * the render service's own last-resort fallback).
 */
function parseFps(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!ALLOWED_FPS.has(n)) {
    throw new BadRequest(
      `"fps" must be one of ${[...ALLOWED_FPS].join(', ')} (default ${DEFAULT_FPS})`
    );
  }
  return n;
}

/**
 * Parse an optional durationSec. Returns the finite positive value, or `null`
 * when absent (→ cdz-render probes it from the HTML as before). A present
 * non-finite / non-positive value is a 400.
 */
function parseDurationSec(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BadRequest('"durationSec" must be a positive number');
  }
  return n;
}

/**
 * ClickDz Vdz Studio — the MP4 export proxy.
 *
 * Session-authed render routes (no @Public — the global guard applies, exactly
 * like the sibling compose controller), Throttle('strict'), typed errors:
 *   · POST /api/v1/vdz/render            {html}   -> {jobId}
 *   · GET  /api/v1/vdz/render/:jobId              -> {status, progress, ...}
 *   · GET  /api/v1/vdz/render/:jobId/file         -> streams the MP4 (video/mp4)
 *
 * Plus the C3 signed-blob-export pair (see the two handlers at the bottom):
 *   · POST /api/v1/vdz/blob-urls                  -> { urls } (session-authed)
 *   · GET  /api/v1/vdz/blob/:workspaceId/:blobId  -> @Public() HMAC+expiry serve
 *
 * The render routes forward to CDZ_RENDER_URL with the CDZ_RENDER_TOKEN header.
 * When CDZ_RENDER_URL is unset the routes fail with a typed 4xx ("not
 * configured") so the UI can degrade gracefully instead of hanging.
 */
@Controller()
export class ClickDzVdzRenderController {
  // C3 DI: WorkspaceBlobStorage reads blob bytes by (workspaceId, blobId);
  // URLHelper mints absolute worker-fetchable urls from the server externalUrl;
  // PermissionAccess asserts the caller may read the workspace before signing.
  // WorkspaceBlobStorage + PermissionAccess are made resolvable for this
  // controller by adding StorageModule + PermissionModule to CopilotModule's
  // imports (see NOTES-index.md); URLHelper is @Global() (base HelpersModule).
  constructor(
    private readonly blobStorage: WorkspaceBlobStorage,
    private readonly url: URLHelper,
    private readonly ac: PermissionAccess,
    // SEC-3: CacheRedis records which user enqueued each render job so the
    // status/file routes can refuse another tenant's job. Same injection style
    // as the peer ClickDz controllers (CacheRedis is exported by base/redis).
    private readonly redis: CacheRedis
  ) {}

  // -------------------------------------------------------------------------
  // SEC-3 — render job ownership.
  //
  // The status and file routes were session-authed but NOT owner-scoped: they
  // took only the jobId, so ANY logged-in tenant who learned or guessed another
  // tenant's jobId could read their render status or download the finished MP4 —
  // which for this product means another merchant's unreleased marketing video.
  // The jobId is minted by the out-of-repo cdz-render service, and the house
  // pattern elsewhere in this codebase is `randomUUID().slice(0, 8)` (32 bits),
  // so guessing cannot be assumed infeasible.
  //
  // The sibling routes in this same file already get this right — blobUrls
  // asserts Workspace.Read, and the @Public blob route requires a signed HMAC —
  // so the two render routes were the outliers.
  //
  // Ownership is recorded when the job is created and checked when it is read.
  // Fail-soft in both directions: a Redis outage must not break rendering, and a
  // job with NO recorded owner (in flight at deploy time, or written while Redis
  // was down) is allowed through rather than 403-ing a legitimate user. That
  // grace shrinks to nothing as old jobs age out, and it is strictly better than
  // today's unrestricted access.
  // -------------------------------------------------------------------------
  private jobOwnerKey(jobId: string): string {
    return `clickdz:vdz:job:owner:${jobId.slice(0, 128)}`;
  }

  /** Record the caller as the owner of a freshly created render job. */
  private async rememberJobOwner(
    jobId: string,
    userId: string
  ): Promise<void> {
    if (!jobId || !userId) return;
    try {
      await this.redis.set(
        this.jobOwnerKey(jobId),
        userId,
        'EX',
        VDZ_JOB_OWNER_TTL_SEC
      );
    } catch {
      // Fail-soft: never fail a render because the ownership note did not land.
    }
  }

  /**
   * Throw AccessDenied when this job is known to belong to someone else.
   * Unknown owner => allowed (see the fail-soft rationale above).
   */
  private async assertJobOwner(jobId: string, userId: string): Promise<void> {
    let owner: string | null = null;
    try {
      owner = await this.redis.get(this.jobOwnerKey(jobId));
    } catch {
      return; // Redis down — do not lock users out of their own renders.
    }
    if (owner && owner !== userId) {
      throw new AccessDenied('This render job belongs to another account');
    }
  }

  /**
   * GET /api/v1/vdz/render/capabilities — which render engines this deployment
   * can actually offer right now, so the export UI never presents a dead choice.
   *
   * Mirrors the Voice Studio's `GET /api/voice/capabilities` stance: a purely
   * read-only reflection of which env keys are set, session-authed like the rest
   * of the render surface (no @Public), Throttle('strict'), and no upstream
   * probe. The frontend fetches this before the export dialog so it can gate the
   * Remotion option (disable + explain when `remotion` is false) and default to
   * the working Classic engine, and it surfaces `classicMaxSec` as the Classic
   * tier's duration cap PRE-flight instead of only as a post-enqueue 400.
   *
   *   · classic       — true when BOTH CDZ_RENDER_URL and CDZ_RENDER_TOKEN are
   *                      set (the same precondition `assertRenderReady` gates on).
   *   · remotion      — true when CDZ_REMOTION_URL is set (mirrors
   *                      `remotionConfigured()`; the token is optional).
   *   · classicMaxSec — the Classic HTML tier's hard length cap (CLASSIC_MAX_SEC).
   */
  @Throttle('strict')
  @Get('/api/v1/vdz/render/capabilities')
  renderCapabilities(): {
    classic: boolean;
    remotion: boolean;
    classicMaxSec: number;
  } {
    return {
      classic: !!RENDER_URL && !!RENDER_TOKEN,
      remotion: this.remotionConfigured(),
      classicMaxSec: CLASSIC_MAX_SEC,
    };
  }

  private assertRenderReady() {
    if (!RENDER_URL || !RENDER_TOKEN) {
      // A typed 4xx (not a 500): the render service simply is not wired up on
      // this deployment yet. The UI keys off this to degrade gracefully
      // ("coming online soon") instead of surfacing a server error. We use
      // BadRequest so the status is 400 — a not-configured backend is a client-
      // observable precondition, and CopilotProviderSideError would map to 500.
      throw new BadRequest('Video render service is not configured');
    }
  }

  /** Common headers for every upstream call. */
  private headers(extra?: Record<string, string>): Record<string, string> {
    return { 'x-cdz-render-token': RENDER_TOKEN, ...extra };
  }

  /** Wrap a fetch to the render service, mapping network/timeout to a typed error. */
  private async upstream(
    path: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<globalThis.Response> {
    try {
      return (await fetch(`${RENDER_URL}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      })) as unknown as globalThis.Response;
    } catch (cause) {
      throw new CopilotProviderSideError({
        provider: 'render',
        kind: 'network_error',
        message:
          cause instanceof Error
            ? `Render service request failed: ${cause.message}`
            : 'Render service request failed',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Remotion engine helpers (mirror the HTML-tier helpers above, pointed at the
  // Remotion worker). Kept separate so the HTML path is byte-for-byte unchanged.
  // -------------------------------------------------------------------------

  /** True when the Remotion worker is wired up on this deployment. */
  private remotionConfigured(): boolean {
    return !!REMOTION_URL;
  }

  /** Auth header for the Remotion worker (bearer token when configured). */
  private remotionHeaders(
    extra?: Record<string, string>
  ): Record<string, string> {
    return {
      ...(REMOTION_TOKEN ? { authorization: `Bearer ${REMOTION_TOKEN}` } : {}),
      ...extra,
    };
  }

  /** Fetch the Remotion worker, mapping network/timeout to a typed provider error. */
  private async remotionUpstream(
    path: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<globalThis.Response> {
    try {
      return (await fetch(`${REMOTION_URL}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      })) as unknown as globalThis.Response;
    } catch (cause) {
      throw new CopilotProviderSideError({
        provider: 'render',
        kind: 'network_error',
        message:
          cause instanceof Error
            ? `Remotion worker request failed: ${cause.message}`
            : 'Remotion worker request failed',
      });
    }
  }

  /**
   * Enqueue a render MANIFEST on the Remotion worker and return the tagged job
   * id. The client builds the manifest (it lives in the frontend module and the
   * backend cannot import it) and sends it under `body.manifest`; we validate it
   * is a plausible manifest object, relay it verbatim, and tag the returned id
   * so the shared status/file routes proxy it back to the worker.
   */
  private async renderViaRemotion(
    body: any,
    ownerId: string
  ): Promise<{ jobId: string }> {
    if (!this.remotionConfigured()) {
      // Same graceful-degrade signal as the HTML tier: a typed 400 the UI reads
      // as "not configured" rather than a 500.
      throw new BadRequest('Remotion render engine is not configured');
    }

    const manifest = body?.manifest;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new BadRequest('"manifest" must be a render-manifest object');
    }
    if (!Array.isArray((manifest as { tracks?: unknown }).tracks)) {
      throw new BadRequest('Render manifest has no tracks to render');
    }
    // Serialize once so we can both size-check and forward the exact bytes.
    let payload: string;
    try {
      payload = JSON.stringify(manifest);
    } catch {
      throw new BadRequest('Render manifest is not serializable');
    }
    if (Buffer.byteLength(payload, 'utf8') > MAX_MANIFEST_BYTES) {
      throw new BadRequest('Render manifest is too large (max 4MB)');
    }

    // One structured log line per render (C2), same fixed shape as the classic
    // branch — the Remotion tier carries these on the manifest (frame-domain),
    // so we read durationSec/width/height/fps off it for parity in the logs. The
    // manifest itself is still relayed VERBATIM below ({manifest} envelope).
    const mf = manifest as {
      durationInSeconds?: unknown;
      width?: unknown;
      height?: unknown;
      fps?: unknown;
    };
    // eslint-disable-next-line no-console
    console.log(
      `[vdz-render] engine=remotion durationSec=${mf.durationInSeconds ?? ''} w=${mf.width ?? ''} h=${mf.height ?? ''} fps=${mf.fps ?? ''}`
    );

    const res = await this.remotionUpstream(
      '/render',
      {
        method: 'POST',
        headers: this.remotionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ manifest }),
      },
      REMOTION_PROXY_TIMEOUT_MS
    );

    const data = (await res.json().catch(() => ({}))) as {
      jobId?: unknown;
      error?: { message?: string };
    };
    if (!res.ok) {
      // Bubble the worker's own validation message (e.g. "no clips").
      throw new BadRequest(
        data?.error?.message ||
          `Remotion worker rejected the request (${res.status})`
      );
    }
    if (typeof data?.jobId !== 'string' || !data.jobId) {
      throw new CopilotProviderSideError({
        provider: 'render',
        kind: 'invalid_output',
        message: 'Remotion worker did not return a job id',
      });
    }
    // Tag the id so status/file route it back to the worker (not cdz-render).
    const taggedId = `${REMOTION_JOB_PREFIX}${data.jobId}`;
    // SEC-3: bind the job to its creator. Keyed on the TAGGED id, which is what
    // the client receives and what status/file are later called with.
    await this.rememberJobOwner(taggedId, ownerId);
    return { jobId: taggedId };
  }

  /**
   * POST /render — enqueue an HTML composition; return the job id.
   *
   * @Res passthrough: the C2 `duration_cap` rejection needs a CUSTOM body
   * (`{error:'duration_cap', maxSec, engine}`) that a typed error cannot emit,
   * so we write that ONE response directly (`res.status().json()`) and return.
   * Every other path still returns an object normally (passthrough leaves Nest's
   * serializer in charge) — including the Remotion branch, which is unchanged.
   */
  @Throttle('strict')
  @Post('/api/v1/vdz/render')
  async render(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ jobId: string } | void> {
    // OPT-IN Remotion engine: only when the caller explicitly requests it. When
    // `engine` is anything else (or absent) we fall through to EXACTLY the
    // existing HTML path below — byte-identical behavior in prod. The env gate
    // lives inside renderViaRemotion (typed 400 when unconfigured). The manifest
    // envelope + relay are unchanged (see renderViaRemotion).
    if (body?.engine === 'remotion') {
      return this.renderViaRemotion(body, user.id);
    }

    this.assertRenderReady();

    if (body?.html != null && typeof body.html !== 'string') {
      throw new BadRequest('"html" must be a string');
    }
    const html = String(body?.html || '');
    if (html.length < 20) {
      throw new BadRequest('No composition HTML to render');
    }
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      throw new BadRequest('Composition HTML is too large (max 2MB)');
    }

    // C2: parse the OPTIONAL explicit render params. Each is `null` when absent
    // (→ forward nothing, cdz-render keeps its own default) or a validated value
    // (present-but-invalid → typed 400 from the parser). `engine` is 'classic'
    // on this branch by definition (anything but 'remotion' lands here).
    const width = parseDimension(body?.width, 'width');
    const height = parseDimension(body?.height, 'height');
    const fps = parseFps(body?.fps);
    const durationSec = parseDurationSec(body?.durationSec);

    // C2 duration cap (classic tier only). Over CLASSIC_MAX_SEC we reject BEFORE
    // round-tripping, with the exact contract body via passthrough res (NOT a
    // raw HttpException — that would coerce to a 500 and drop the custom body).
    if (durationSec != null && durationSec > CLASSIC_MAX_SEC) {
      res.status(400).json({
        error: 'duration_cap',
        maxSec: CLASSIC_MAX_SEC,
        engine: 'classic',
      });
      return;
    }

    // One structured log line per render (C2). Fields that were not sent show as
    // empty so the line is greppable and fixed-shape regardless of the payload.
    // eslint-disable-next-line no-console
    console.log(
      `[vdz-render] engine=classic durationSec=${durationSec ?? ''} w=${width ?? ''} h=${height ?? ''} fps=${fps ?? ''}`
    );

    const res2 = await this.upstream(
      '/render',
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        // kind:'html' is the only supported kind in this PR; the render service
        // itself validates fps/dimensions/duration and returns typed errors.
        // Forward the C2 fields ONLY when present (spread of a conditional
        // object) so the wire payload for the OLD app is byte-identical.
        body: JSON.stringify({
          kind: 'html',
          html,
          ...(width != null ? { width } : {}),
          ...(height != null ? { height } : {}),
          ...(fps != null ? { fps } : {}),
          ...(durationSec != null ? { durationSec } : {}),
        }),
      },
      PROXY_TIMEOUT_MS
    );

    const data = (await res2.json().catch(() => ({}))) as {
      jobId?: unknown;
      error?: { message?: string };
    };
    if (!res2.ok) {
      // Bubble the render service's own message (e.g. "too long", "no clips").
      throw new BadRequest(
        data?.error?.message || `Render service rejected the request (${res2.status})`
      );
    }
    if (typeof data?.jobId !== 'string' || !data.jobId) {
      throw new CopilotProviderSideError({
        provider: 'render',
        kind: 'invalid_output',
        message: 'Render service did not return a job id',
      });
    }
    // SEC-3: bind the job to its creator so status/file can refuse other tenants.
    await this.rememberJobOwner(data.jobId, user.id);
    return { jobId: data.jobId };
  }

  /**
   * Split an incoming job id into its backend + the id the backend knows. A
   * `rmt:`-tagged id belongs to the Remotion worker (the tag is stripped); every
   * other id is an HTML-tier (cdz-render) id, unchanged. Additive: pre-existing
   * ids have no prefix, so they route exactly as before.
   */
  private routeJob(jobId: string): { engine: 'html' | 'remotion'; id: string } {
    const raw = String(jobId || '');
    if (raw.startsWith(REMOTION_JOB_PREFIX)) {
      return { engine: 'remotion', id: raw.slice(REMOTION_JOB_PREFIX.length) };
    }
    return { engine: 'html', id: raw };
  }

  /** GET /render/:jobId — proxy the job status. */
  @Throttle('strict')
  @Get('/api/v1/vdz/render/:jobId')
  async status(
    @CurrentUser() user: CurrentUser,
    @Param('jobId') jobId: string
  ): Promise<unknown> {
    // SEC-3: refuse a job that belongs to another tenant.
    await this.assertJobOwner(jobId, user.id);
    const route = this.routeJob(jobId);

    // Remotion-tier job: proxy to the worker (same async job contract).
    if (route.engine === 'remotion') {
      if (!this.remotionConfigured()) {
        throw new BadRequest('Remotion render engine is not configured');
      }
      const rid = encodeURIComponent(route.id);
      const res = await this.remotionUpstream(
        `/jobs/${rid}`,
        { method: 'GET', headers: this.remotionHeaders() },
        PROXY_TIMEOUT_MS
      );
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        throw new NotFound('Unknown render job');
      }
      if (!res.ok) {
        throw new CopilotProviderSideError({
          provider: 'render',
          kind: 'upstream_error',
          message: `Remotion worker status failed (${res.status})`,
        });
      }
      return data;
    }

    this.assertRenderReady();
    const id = encodeURIComponent(route.id);
    const res = await this.upstream(
      `/jobs/${id}`,
      { method: 'GET', headers: this.headers() },
      PROXY_TIMEOUT_MS
    );
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) {
      throw new NotFound('Unknown render job');
    }
    if (!res.ok) {
      throw new CopilotProviderSideError({
        provider: 'render',
        kind: 'upstream_error',
        message: `Render service status failed (${res.status})`,
      });
    }
    return data;
  }

  /**
   * GET /render/:jobId/file — stream the finished MP4 straight through.
   *
   * We PIPE the upstream body to the client (never buffer the whole video into
   * memory) and mirror the content headers. @Res() opts out of Nest's own
   * serializer so we own the response fully.
   */
  @Throttle('strict')
  @Get('/api/v1/vdz/render/:jobId/file')
  async file(
    @CurrentUser() user: CurrentUser,
    @Param('jobId') jobId: string,
    @Res() res: Response
  ): Promise<void> {
    // SEC-3: refuse to stream another tenant's rendered MP4.
    await this.assertJobOwner(jobId, user.id);
    const route = this.routeJob(jobId);
    const id = encodeURIComponent(route.id);

    // Pick the backend by the routed engine; the stream/relay below is
    // identical for both (a finished MP4 is a finished MP4).
    let upstream: globalThis.Response;
    if (route.engine === 'remotion') {
      if (!this.remotionConfigured()) {
        throw new BadRequest('Remotion render engine is not configured');
      }
      upstream = await this.remotionUpstream(
        `/jobs/${id}/file`,
        { method: 'GET', headers: this.remotionHeaders() },
        FILE_PROXY_TIMEOUT_MS
      );
    } else {
      this.assertRenderReady();
      upstream = await this.upstream(
        `/jobs/${id}/file`,
        { method: 'GET', headers: this.headers() },
        FILE_PROXY_TIMEOUT_MS
      );
    }

    if (upstream.status === 404) {
      // Not done yet (or unknown) — a typed 404 the client polls around.
      throw new NotFound('Render is not ready yet');
    }
    if (!upstream.ok || !upstream.body) {
      throw new CopilotProviderSideError({
        provider: 'render',
        kind: 'upstream_error',
        message: `Render file fetch failed (${upstream.status})`,
      });
    }

    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'video/mp4'
    );
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    res.setHeader(
      'Content-Disposition',
      upstream.headers.get('content-disposition') ||
        `attachment; filename="vdz-video-${id}.mp4"`
    );
    res.setHeader('Cache-Control', 'private, max-age=3600');

    // Bridge the WHATWG stream from fetch to the Node response stream.
    const nodeStream = Readable.fromWeb(upstream.body as any);
    nodeStream.on('error', () => {
      if (!res.headersSent) res.status(502);
      res.end();
    });
    nodeStream.pipe(res);
  }

  // -------------------------------------------------------------------------
  // C3 — signed blob export (worker→app). Two routes:
  //   · POST /api/v1/vdz/blob-urls  — session-authed MINT (cookie). Asserts the
  //     caller can read the workspace, then signs a short-lived absolute URL per
  //     blobId. Returns { urls: { [blobId]: absoluteUrl } }.
  //   · @Public() GET /api/v1/vdz/blob/:workspaceId/:blobId — the WORKER fetches
  //     this (NO cookie); it is gated ONLY by the HMAC sig + exp, then streams
  //     the blob bytes. The Remotion worker passes the signed URL straight into
  //     <OffthreadVideo>/<Img>/<Audio> — zero worker changes required.
  // -------------------------------------------------------------------------

  /**
   * POST /api/v1/vdz/blob-urls — mint short-lived signed URLs for uploaded
   * workspace blobs so the cookie-less Remotion worker can fetch them over HTTPS.
   *
   * Session-authed (global guard; no @Public), Workspace.Read asserted on the
   * caller so a user can only sign blobs of a workspace they can read — mirrors
   * the ACL on the existing WorkspacesController.blob route. Typed errors only.
   */
  @Throttle('strict')
  @Post('/api/v1/vdz/blob-urls')
  async blobUrls(
    @CurrentUser() user: CurrentUser,
    @Body() body: any
  ): Promise<{ urls: Record<string, string> }> {
    const workspaceId = String(body?.workspaceId || '');
    if (!workspaceId) {
      throw new BadRequest('"workspaceId" is required');
    }
    const rawIds = body?.blobIds;
    if (!Array.isArray(rawIds)) {
      throw new BadRequest('"blobIds" must be an array of blob ids');
    }
    if (rawIds.length > MAX_BLOB_IDS) {
      throw new BadRequest(`Too many blobIds (max ${MAX_BLOB_IDS})`);
    }

    // Only sign blobs of a workspace the caller can actually read. `assert`
    // throws a typed permission error (mapped to 403) when the check fails.
    await this.ac.user(user.id).workspace(workspaceId).assert('Workspace.Read');

    // Normalize + de-dupe the ids (a timeline may reference the same source
    // many times). Reject non-string / empty entries defensively.
    const blobIds = Array.from(
      new Set(
        rawIds.map(id => {
          if (typeof id !== 'string' || !id) {
            throw new BadRequest('Each blobId must be a non-empty string');
          }
          return id;
        })
      )
    );

    const exp = Date.now() + BLOB_URL_TTL_MS;
    const urls: Record<string, string> = {};
    for (const blobId of blobIds) {
      const sig = signBlobToken(workspaceId, blobId, exp);
      // Absolute, worker-fetchable url from AFFINE_SERVER_EXTERNAL_URL (the same
      // URLHelper.link idiom WorkspaceBlobStorage uses for avatar links). The
      // path segments are encoded; exp/sig ride as query params.
      urls[blobId] = this.url.link(
        `/api/v1/vdz/blob/${encodeURIComponent(workspaceId)}/${encodeURIComponent(blobId)}`,
        { exp, sig }
      );
    }
    return { urls };
  }

  /**
   * GET /api/v1/vdz/blob/:workspaceId/:blobId?exp=&sig= — @Public() blob serve.
   *
   * The Remotion worker calls this WITHOUT a cookie, so it MUST be @Public();
   * access is instead gated by the HMAC `sig` + `exp` (verifyBlobToken). On a
   * bad/expired/missing token we throw a TYPED AuthenticationRequired (401) /
   * AccessDenied (403) — never a raw HttpException (which the global filter would
   * coerce to 500). We NEVER log the sig or secret.
   *
   * Streaming: WorkspaceBlobStorage.get(..., true) returns a presigned
   * redirectUrl on R2 (Chromium follows it; the S3 url supports native range —
   * ideal for <OffthreadVideo>). Otherwise we set content-type/length +
   * `accept-ranges: bytes` and pipe the Readable straight to the response
   * (never buffering the whole blob into memory), mirroring the existing public
   * blob route. @Res() opts out of Nest's serializer so we own the response.
   */
  @Public()
  @Throttle('strict')
  @Get('/api/v1/vdz/blob/:workspaceId/:blobId')
  async serveBlob(
    @Param('workspaceId') workspaceId: string,
    @Param('blobId') blobId: string,
    @Query('exp') expRaw: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res() res: Response
  ): Promise<void> {
    const exp = Number(expRaw);
    // Missing/malformed signature material → 401 (authentication is required
    // and was not validly supplied). Note: no logging of sig/secret anywhere.
    if (!sig || !Number.isFinite(exp)) {
      throw new AuthenticationRequired('A valid signed blob url is required');
    }
    // Valid-shape but wrong/expired token → 403 (the request was authenticated-
    // shaped but is not allowed). verifyBlobToken also rejects exp < now.
    if (!verifyBlobToken(workspaceId, blobId, exp, sig)) {
      throw new AccessDenied('This blob url is invalid or has expired');
    }

    // Prefer a provider-presigned redirect (R2) — native range, no bytes through
    // this process. Falls back to a streamed object otherwise.
    const { body, metadata, redirectUrl } = await this.blobStorage.get(
      workspaceId,
      blobId,
      true
    );

    if (redirectUrl) {
      // Chromium (the worker's fetcher) follows the 302 to the signed S3 url.
      res.redirect(redirectUrl);
      return;
    }

    if (!body) {
      throw new BlobNotFound({ spaceId: workspaceId, blobId });
    }

    if (metadata) {
      res.setHeader('content-type', metadata.contentType);
      res.setHeader('last-modified', metadata.lastModified.toUTCString());
      res.setHeader('content-length', metadata.contentLength);
    }
    // Advertise range support so <OffthreadVideo>'s seeks are well-behaved; the
    // object stream itself is delivered as a full 200 body (we do not slice a
    // Range here — that would require a range-capable source or buffering the
    // whole blob; Chromium re-fetches as needed and the R2 path above already
    // hands off to a natively range-capable presigned url).
    res.setHeader('accept-ranges', 'bytes');
    // Private + short cache: signed urls are per-render and expire; do not let a
    // shared cache serve them to another principal.
    res.setHeader('cache-control', 'private, max-age=3600');

    body.on('error', () => {
      if (!res.headersSent) res.status(502);
      res.end();
    });
    body.pipe(res);
  }
}
