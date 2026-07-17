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

  /** POST /render — enqueue an HTML composition; return the job id. */
  @Throttle('strict')
  @Post('/api/v1/vdz/render')
  async render(@Body() body: any): Promise<{ jobId: string }> {
    // OPT-IN Remotion engine: only when the caller explicitly requests it. When
    // `engine` is anything else (or absent) we fall through to EXACTLY the
    // existing HTML path below — byte-identical behavior in prod. The env gate
    // lives inside renderViaRemotion (typed 400 when unconfigured).
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

    const res = await this.upstream(
      '/render',
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        // kind:'html' is the only supported kind in this PR; the render service
        // itself validates fps/dimensions/duration and returns typed errors.
        body: JSON.stringify({ kind: 'html', html }),
      },
      PROXY_TIMEOUT_MS
    );

    const data = (await res.json().catch(() => ({}))) as {
      jobId?: unknown;
      error?: { message?: string };
    };
    if (!res.ok) {
      // Bubble the render service's own message (e.g. "too long", "no clips").
      throw new BadRequest(
        data?.error?.message || `Render service rejected the request (${res.status})`
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
