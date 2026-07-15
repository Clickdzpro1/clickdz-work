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

// Caps mirror the render service's own validation (server.mjs) so we reject
// oversized/short payloads at the edge instead of round-tripping them.
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB
// A render can take minutes; the proxy calls are quick (enqueue / status /
// stream), so a generous-but-bounded timeout guards against a hung upstream.
const PROXY_TIMEOUT_MS = 30_000;
// The file stream can be large and slow; give it its own longer ceiling.
const FILE_PROXY_TIMEOUT_MS = 180_000;

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

  /** POST /render — enqueue an HTML composition; return the job id. */
  @Throttle('strict')
  @Post('/api/v1/vdz/render')
  async render(@Body() body: any): Promise<{ jobId: string }> {
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

  /** GET /render/:jobId — proxy the job status. */
  @Throttle('strict')
  @Get('/api/v1/vdz/render/:jobId')
  async status(@Param('jobId') jobId: string): Promise<unknown> {
    this.assertRenderReady();
    const id = encodeURIComponent(String(jobId || ''));
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
    this.assertRenderReady();
    const id = encodeURIComponent(String(jobId || ''));

    const upstream = await this.upstream(
      `/jobs/${id}/file`,
      { method: 'GET', headers: this.headers() },
      FILE_PROXY_TIMEOUT_MS
    );

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
