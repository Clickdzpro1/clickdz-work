import { Readable } from 'node:stream';

import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

// SECURITY: typed AFFiNE errors so the global exception filter emits proper
// status codes (a raw @nestjs/common HttpException becomes a generic 500 here):
//  · BadRequest               -> 400 (missing / malformed / oversized input)
//  · NotFound                 -> 404 (unknown job / file not ready)
//  · CopilotProviderSideError -> render-service (upstream) failure, typed as a
//    provider error rather than a bare 502; kind:'not_configured' is the same
//    signal the compose controller uses when its engine env is unset.
// Throttle('strict') is the same hard per-IP cap the paid /apps + compose routes use.
import { BadRequest, CopilotProviderSideError, Throttle } from '../../base';

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
// Classic (HTML/headless-Chrome) tier length cap. Raised 120 → 300 in this
// round (cdz-render's MAX_DURATION_S is raised to match). Over this we reject at
// the edge with the C2 duration_cap body BEFORE round-tripping to cdz-render.
const CLASSIC_MAX_SEC = 300;

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
// The Remotion worker's enqueue round-trip; 120s matches the track spec —
// generous for a large manifest POST, bounded against a hung worker. Status and
// file polling reuse the HTML tier's PROXY_/FILE_PROXY_ timeouts.
const REMOTION_PROXY_TIMEOUT_MS = 120_000;

/**
 * ClickDz Vdz Studio — the MP4 export proxy.
 *
 * Three routes, session-authed (no @Public — the global guard applies, exactly
 * like the sibling compose controller), Throttle('strict'), typed errors:
 *   · POST /api/v1/vdz/render            {html}   -> {jobId}
 *   · GET  /api/v1/vdz/render/:jobId              -> {status, progress, ...}
 *   · GET  /api/v1/vdz/render/:jobId/file         -> streams the MP4 (video/mp4)
 *
 * All three forward to CDZ_RENDER_URL with the CDZ_RENDER_TOKEN header. When
 * CDZ_RENDER_URL is unset the routes fail with a typed 4xx ("not configured")
 * so the UI can degrade gracefully instead of hanging.
 */
@Controller()
export class ClickDzVdzRenderController {
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
  ): Promise<Response> {
    try {
      return (await fetch(`${RENDER_URL}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      })) as unknown as Response;
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
  ): Promise<Response> {
    try {
      return (await fetch(`${REMOTION_URL}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      })) as unknown as Response;
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
  private async renderViaRemotion(body: any): Promise<{ jobId: string }> {
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
    return { jobId: `${REMOTION_JOB_PREFIX}${data.jobId}` };
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
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ jobId: string } | void> {
    // OPT-IN Remotion engine: only when the caller explicitly requests it. When
    // `engine` is anything else (or absent) we fall through to EXACTLY the
    // existing HTML path below — byte-identical behavior in prod. The env gate
    // lives inside renderViaRemotion (typed 400 when unconfigured). The manifest
    // envelope + relay are unchanged (see renderViaRemotion).
    if (body?.engine === 'remotion') {
      return this.renderViaRemotion(body);
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
  async status(@Param('jobId') jobId: string): Promise<unknown> {
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
        throw new BadRequest('Unknown render job');
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
      throw new BadRequest('Unknown render job');
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
  async file(@Param('jobId') jobId: string, @Res() res: Response): Promise<void> {
    const route = this.routeJob(jobId);
    const id = encodeURIComponent(route.id);

    // Pick the backend by the routed engine; the stream/relay below is
    // identical for both (a finished MP4 is a finished MP4).
    let upstream: Response;
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
      throw new BadRequest('Render is not ready yet');
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
}
