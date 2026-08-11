// ClickDz Work — ZOOM+ meeting-summary REST controller.
//
// Thin NestJS REST layer over the EXISTING ClickDzZoomPlusSummaryService. The
// service is ALREADY fail-closed (it returns {ok:false,error} and never throws),
// so this controller is a near-passthrough — it validates the body, calls the
// service, and returns the ZoomPlusSummaryResult as-is. A GET /summary/enabled
// probe lets the frontend show/hide the résumé panel WITHOUT calling the model
// (pure flag + key presence check, NO model call).
//
// REST, NOT GraphQL — the inline-styled ZOOM+ shell uses plain fetch. The
// existing GraphQL resolver (clickdz-zoomplus-summary.resolver.ts) remains for
// any GraphQL clients; the two coexist (NestJS code-first, no manual schema).

import { Body, Controller, Get, Post } from '@nestjs/common';

// Throttle rate-caps the route exactly like the sibling controllers.
// Value-imported (lint-nest: every ctor-param + decorator identifier must
// resolve at boot as a VALUE).
import { Throttle } from '../../base';
// CurrentUser decorates + types the cookie-session user (first-party routes,
// global AuthGuard requires a signed-in session — NOT @Public).
import { CurrentUser } from '../../core/auth';
import {
  ClickDzZoomPlusSummaryService,
  type ZoomPlusSummaryResult,
} from './clickdz-zoomplus-summary.service';
import type { ZoomPlusLang } from './clickdz-zoomplus-prompt';

// ---------------------------------------------------------------------------
// Config — the master gate + key (read once at module load; env is fixed for
// the process). The service re-checks at call time, but these let the
// /enabled probe answer WITHOUT calling the model.
// ---------------------------------------------------------------------------
const CDZ_ZOOMPLUS_ENABLED = process.env.CDZ_ZOOMPLUS_ENABLED || '';
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';

// Allowlist for the lang field (defensive — an unknown value falls back to
// 'auto' rather than reaching the model). Mirrors the voice-ai controller.
const ZOOMPLUS_LANGS: readonly ZoomPlusLang[] = ['fr', 'ar', 'darija', 'auto'];

@Controller()
export class ClickDzZoomPlusSummaryController {
  constructor(
    private readonly svc: ClickDzZoomPlusSummaryService
  ) {}

  // -------------------------------------------------------------------------
  // Probe — lets the frontend show/hide the résumé panel without a model call.
  // Returns {enabled: true} only when the flag is ON AND a key is present.
  // -------------------------------------------------------------------------

  @Get('/api/v1/zoomplus/summary/enabled')
  summaryEnabled(): { enabled: boolean } {
    return {
      enabled: CDZ_ZOOMPLUS_ENABLED === '1' && !!CDZ_AI_KEY,
    };
  }

  // -------------------------------------------------------------------------
  // Summary — delegates to the service. The service is fail-closed (never
  // throws), so we return its ZoomPlusSummaryResult as-is. We still wrap in a
  // try/catch as a belt-and-suspenders guard so a bizarre runtime error
  // surfaces {ok:false} rather than a raw 500.
  // -------------------------------------------------------------------------

  @Throttle('strict')
  @Post('/api/v1/zoomplus/summary')
  async summarize(
    @CurrentUser() _user: CurrentUser,
    @Body() body: { transcript: string; lang?: string; title?: string }
  ): Promise<ZoomPlusSummaryResult> {
    try {
      const transcript =
        typeof body?.transcript === 'string' ? body.transcript : '';
      if (!transcript.trim()) {
        return {
          ok: false,
          error: "Le transcript ne peut pas être vide.",
        };
      }

      const lang: ZoomPlusLang =
        typeof body?.lang === 'string' &&
        (ZOOMPLUS_LANGS as readonly string[]).includes(body.lang)
          ? (body.lang as ZoomPlusLang)
          : 'auto';

      const title =
        typeof body?.title === 'string' ? body.title.trim() || undefined : undefined;

      const result = await this.svc.summarizeMeeting({
        transcript,
        lang,
        title,
      });
      return result;
    } catch (err) {
      // Belt-and-suspenders: the service never throws, but if something
      // unexpected happens we return a structured error, never a raw 500.
      return {
        ok: false,
        error:
          err instanceof Error
            ? err.message.slice(0, 200)
            : "Erreur inconnue lors du résumé.",
      };
    }
  }
}
