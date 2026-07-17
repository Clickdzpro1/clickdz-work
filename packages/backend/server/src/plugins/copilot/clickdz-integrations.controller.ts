import { Body, Controller, Get, Logger, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { CurrentUser } from '../../core/auth';
// Typed errors from ../../base (raw HttpException is coerced to a generic 500
// by AFFiNE's GlobalExceptionFilter — see base/nestjs/exception.ts mapAnyError).
// For the contract's non-standard status + typed-body responses (409 / 501 /
// 502) we therefore write them directly via the injected Express Response
// (@Res()), exactly like ClickDzBridgeController's chatCompletions/tts routes.
// BadRequest stays available for genuinely malformed input (typed 400).
import { BadRequest, Throttle } from '../../base';

// SECURITY / CONFIG: the ONE switch. Without COMPOSIO_API_KEY every enabled
// code path below is unreachable — the controller reports {enabled:false} and
// never calls Composio. Read once at module load (same idiom as the bridge's
// VERCEL_TOKEN / DEEPGRAM_API_KEY module-level env reads).
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || '';

// Composio public REST surface (plain fetch — NO SDK dependency).
const COMPOSIO_TOOLKITS_URL =
  'https://backend.composio.dev/api/v3/toolkits?limit=24';
// Auth-link session (returns a hosted redirect_url the user opens to connect).
const COMPOSIO_LINK_URL =
  'https://backend.composio.dev/api/v3.1/connected_accounts/link';

const COMPOSIO_TIMEOUT_MS = 8_000;

interface CdzToolkit {
  slug: string;
  name: string;
  logo?: string;
}

/**
 * ClickDz Integrations (Composio) — DARK by default.
 *
 * Every behaviour is gated behind COMPOSIO_API_KEY. With no key the endpoints
 * answer {enabled:false} (200) and the frontend shows a friendly setup state;
 * NOTHING reaches Composio. All routes are auth'd (global AuthGuard requires a
 * signed-in cookie session — no @Public()), and cost/side-effecting routes are
 * rate-capped with @Throttle('strict'), mirroring the sibling controllers.
 */
@Controller()
export class ClickDzIntegrationsController {
  private readonly logger = new Logger(ClickDzIntegrationsController.name);

  /** Small helper: fetch with a hard AbortController timeout (8s). */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit
  ): Promise<globalThis.Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMPOSIO_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET status — the single source of truth the UI polls first. */
  @Get('/api/v1/integrations/status')
  status(@CurrentUser() _user: CurrentUser, @Res() res: Response) {
    res.status(200).json({ enabled: !!COMPOSIO_API_KEY });
  }

  /**
   * GET toolkits.
   *  - disabled  -> {enabled:false, toolkits:[]}
   *  - enabled   -> fetch Composio v3, map to {slug,name,logo?}
   *  - on any fetch/parse/timeout failure -> {enabled:true, toolkits:[],
   *    error:'composio_unreachable'} (never throws — the grid degrades softly).
   */
  @Throttle('strict')
  @Get('/api/v1/integrations/toolkits')
  async toolkits(@CurrentUser() _user: CurrentUser, @Res() res: Response) {
    if (!COMPOSIO_API_KEY) {
      res.status(200).json({ enabled: false, toolkits: [] });
      return;
    }
    try {
      const response = await this.fetchWithTimeout(COMPOSIO_TOOLKITS_URL, {
        method: 'GET',
        headers: {
          'x-api-key': COMPOSIO_API_KEY,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        this.logger.warn(`[integrations] toolkits HTTP ${response.status}`);
        res
          .status(200)
          .json({ enabled: true, toolkits: [], error: 'composio_unreachable' });
        return;
      }
      const data: any = await response.json();
      // Defensive extraction: the v3 payload is {items:[{slug,name,meta:{logo}}]}
      // but tolerate items/toolkits/data and logo/meta.logo shape drift.
      const rawList: any[] = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.toolkits)
          ? data.toolkits
          : Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data)
              ? data
              : [];
      const toolkits: CdzToolkit[] = rawList
        .map((t: any): CdzToolkit | null => {
          const slug =
            typeof t?.slug === 'string'
              ? t.slug
              : typeof t?.key === 'string'
                ? t.key
                : typeof t?.name === 'string'
                  ? t.name
                  : null;
          if (!slug) return null;
          const name =
            typeof t?.name === 'string' && t.name.length ? t.name : slug;
          const logo =
            typeof t?.meta?.logo === 'string'
              ? t.meta.logo
              : typeof t?.logo === 'string'
                ? t.logo
                : undefined;
          return logo ? { slug, name, logo } : { slug, name };
        })
        .filter((t): t is CdzToolkit => t !== null)
        .slice(0, 24);
      res.status(200).json({ enabled: true, toolkits });
    } catch (err) {
      // Timeout (AbortError), DNS, TLS, JSON parse — all soft-fail.
      this.logger.warn(
        `[integrations] toolkits fetch failed: ${(err as Error)?.message ?? err}`
      );
      res
        .status(200)
        .json({ enabled: true, toolkits: [], error: 'composio_unreachable' });
    }
  }

  /**
   * POST connect {toolkit, authConfigId?}.
   *  - disabled -> 409 {error:'not_configured'}
   *  - enabled  -> best-effort Composio v3.1 auth-link session; success returns
   *    {redirectUrl}; any failure is wrapped to a typed 502
   *    {error:'composio_error', detail}.
   */
  @Throttle('strict')
  @Post('/api/v1/integrations/connect')
  async connect(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Res() res: Response
  ) {
    const toolkit = typeof body?.toolkit === 'string' ? body.toolkit.trim() : '';
    if (!toolkit) {
      // Genuinely malformed input -> typed 400 via ../../base (safe here).
      throw new BadRequest('"toolkit" is required');
    }

    if (!COMPOSIO_API_KEY) {
      res.status(409).json({ error: 'not_configured' });
      return;
    }

    // The hosted auth-link session needs an auth_config_id (per-toolkit auth
    // config the workspace owner sets up in Composio). We accept it from the
    // body when present; otherwise fall back to the toolkit slug so the call
    // is still well-formed. Either way this is BEST-EFFORT: any non-2xx or
    // transport failure collapses to a single typed 502.
    const authConfigId =
      typeof body?.authConfigId === 'string' && body.authConfigId.length
        ? body.authConfigId
        : toolkit;
    const callbackUrl =
      typeof body?.callbackUrl === 'string' && body.callbackUrl.length
        ? body.callbackUrl
        : undefined;

    try {
      const payload: Record<string, unknown> = {
        auth_config_id: authConfigId,
        user_id: user.id,
      };
      if (callbackUrl) payload.callback_url = callbackUrl;

      const response = await this.fetchWithTimeout(COMPOSIO_LINK_URL, {
        method: 'POST',
        headers: {
          'x-api-key': COMPOSIO_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data: any = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail =
          typeof data?.error?.message === 'string'
            ? data.error.message
            : typeof data?.message === 'string'
              ? data.message
              : `composio responded ${response.status}`;
        this.logger.warn(`[integrations] connect ${toolkit} failed: ${detail}`);
        res.status(502).json({ error: 'composio_error', detail });
        return;
      }

      const redirectUrl =
        typeof data?.redirect_url === 'string'
          ? data.redirect_url
          : typeof data?.redirectUrl === 'string'
            ? data.redirectUrl
            : '';
      if (!redirectUrl) {
        res
          .status(502)
          .json({ error: 'composio_error', detail: 'no_redirect_url' });
        return;
      }
      res.status(200).json({ redirectUrl });
    } catch (err) {
      const detail = (err as Error)?.message ?? 'composio_request_failed';
      this.logger.warn(`[integrations] connect ${toolkit} threw: ${detail}`);
      res.status(502).json({ error: 'composio_error', detail });
    }
  }

  /**
   * POST run — experimental tool execution. Deliberately disabled this round
   * (the loop lands when a key exists): always 501.
   */
  @Throttle('strict')
  @Post('/api/v1/integrations/run')
  run(@CurrentUser() _user: CurrentUser, @Res() res: Response) {
    res.status(501).json({ error: 'experimental_disabled' });
  }
}
