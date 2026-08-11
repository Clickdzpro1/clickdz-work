// ClickDz Work — ZOOM+ host-controls REST controller.
//
// Thin NestJS REST layer over the EXISTING ClickDzZoomPlusService (LiveKit
// RoomService). Every route is session-authed (@CurrentUser, NOT @Public) and
// @Throttle('strict') — the SAME stance the voice-ai controller takes. The gate
// lives in the service: when CDZ_ZOOMPLUS_HOST_CONTROLS_ENABLED is off (or creds
// are missing) the service throws ZoomPlusDisabledError, which we surface as a
// typed NotFound so the feature is byte-inert (404 = "doesn't exist") until the
// owner flips the flag. A separate GET /host-controls/enabled probes the flag
// WITHOUT calling LiveKit so the frontend can show/hide the panel safely.
//
// REST, NOT GraphQL — the inline-styled ZOOM+ shell uses plain fetch, so these
// routes mirror the /api/v1/zoomplus/* paths the frontend expects. The existing
// GraphQL resolver (clickdz-zoomplus.resolver.ts) remains for any GraphQL
// clients; the two coexist (NestJS code-first, no manual schema edits).

import { Body, Controller, Get, Post, Query } from '@nestjs/common';

// Typed AFFiNE errors — NotFound = gated-OFF typed 404 (the clean "feature
// disabled" 404 every ClickDz feature uses when dark). Throttle rate-caps the
// routes exactly like the sibling controllers. ALL value-imported (lint-nest).
import { NotFound, Throttle } from '../../base';
// CurrentUser decorates + types the cookie-session user (first-party routes,
// global AuthGuard requires a signed-in session — NOT @Public).
import { CurrentUser } from '../../core/auth';
import { ClickDzZoomPlusService } from './clickdz-zoomplus.service';

// ---------------------------------------------------------------------------
// Config — the master gate (read once at module load; env is fixed for the
// process). The service re-checks at call time, but this flag lets the
// /enabled probe answer WITHOUT touching LiveKit or reading the secret.
// ---------------------------------------------------------------------------
const CDZ_ZOOMPLUS_HOST_CONTROLS_ENABLED =
  process.env.CDZ_ZOOMPLUS_HOST_CONTROLS_ENABLED || '';

// The ZoomPlusDisabledError class is NOT exported from the service (it is a
// private internal class). We detect it by .name to convert it into a typed
// NotFound — the SAME pattern the voice-ai controller uses for its gate.
const ZOOMPLUS_DISABLED_ERROR_NAME = 'ZoomPlusDisabledError';

@Controller()
export class ClickDzZoomPlusController {
  constructor(private readonly svc: ClickDzZoomPlusService) {}

  // -------------------------------------------------------------------------
  // Probe — lets the frontend show/hide the host panel without a LiveKit call.
  // Returns {enabled: true} only when the flag is ON. Credential presence is
  // checked by the service at call time (the probe doesn't read the secret).
  // -------------------------------------------------------------------------

  @Get('/api/v1/zoomplus/host-controls/enabled')
  hostControlsEnabled(): { enabled: boolean } {
    return {
      enabled: CDZ_ZOOMPLUS_HOST_CONTROLS_ENABLED === '1',
    };
  }

  // -------------------------------------------------------------------------
  // Host control routes — each delegates to the service, catching
  // ZoomPlusDisabledError -> NotFound, other errors -> {ok:false, message}.
  // -------------------------------------------------------------------------

  @Throttle('strict')
  @Post('/api/v1/zoomplus/host/mute')
  async mute(
    @CurrentUser() _user: CurrentUser,
    @Body() body: { room: string; identity: string; trackSid?: string; muted?: boolean }
  ) {
    try {
      const result = await this.svc.muteParticipant(
        body.room,
        body.identity,
        body.trackSid,
        body.muted ?? true
      );
      return result;
    } catch (err) {
      if (this.isDisabledError(err)) throw new NotFound('ZOOM+ host controls disabled');
      return { ok: false, message: (err as Error).message };
    }
  }

  @Throttle('strict')
  @Post('/api/v1/zoomplus/host/mute-all')
  async muteAll(
    @CurrentUser() _user: CurrentUser,
    @Body() body: { room: string }
  ) {
    try {
      const result = await this.svc.muteAllParticipants(body.room);
      return result;
    } catch (err) {
      if (this.isDisabledError(err)) throw new NotFound('ZOOM+ host controls disabled');
      return { ok: false, message: (err as Error).message };
    }
  }

  @Throttle('strict')
  @Post('/api/v1/zoomplus/host/remove')
  async remove(
    @CurrentUser() _user: CurrentUser,
    @Body() body: { room: string; identity: string }
  ) {
    try {
      const result = await this.svc.removeParticipant(body.room, body.identity);
      return result;
    } catch (err) {
      if (this.isDisabledError(err)) throw new NotFound('ZOOM+ host controls disabled');
      return { ok: false, message: (err as Error).message };
    }
  }

  @Throttle('strict')
  @Post('/api/v1/zoomplus/host/toggle-screen-share')
  async toggleScreenShare(
    @CurrentUser() _user: CurrentUser,
    @Body() body: { room: string; identity: string; allowed: boolean }
  ) {
    try {
      const result = await this.svc.toggleScreenShare(
        body.room,
        body.identity,
        body.allowed
      );
      return result;
    } catch (err) {
      if (this.isDisabledError(err)) throw new NotFound('ZOOM+ host controls disabled');
      return { ok: false, message: (err as Error).message };
    }
  }

  @Throttle('strict')
  @Post('/api/v1/zoomplus/host/toggle-camera')
  async toggleCamera(
    @CurrentUser() _user: CurrentUser,
    @Body() body: { room: string; identity: string; allowed: boolean }
  ) {
    try {
      const result = await this.svc.toggleCamera(
        body.room,
        body.identity,
        body.allowed
      );
      return result;
    } catch (err) {
      if (this.isDisabledError(err)) throw new NotFound('ZOOM+ host controls disabled');
      return { ok: false, message: (err as Error).message };
    }
  }

  @Throttle('strict')
  @Post('/api/v1/zoomplus/host/rename')
  async rename(
    @CurrentUser() _user: CurrentUser,
    @Body() body: { room: string; identity: string; name: string }
  ) {
    try {
      const result = await this.svc.renameParticipant(
        body.room,
        body.identity,
        body.name
      );
      return result;
    } catch (err) {
      if (this.isDisabledError(err)) throw new NotFound('ZOOM+ host controls disabled');
      return { ok: false, message: (err as Error).message };
    }
  }

  @Throttle('strict')
  @Post('/api/v1/zoomplus/host/promote')
  async promote(
    @CurrentUser() _user: CurrentUser,
    @Body() body: { room: string; identity: string }
  ) {
    try {
      const result = await this.svc.promoteCoHost(body.room, body.identity);
      return result;
    } catch (err) {
      if (this.isDisabledError(err)) throw new NotFound('ZOOM+ host controls disabled');
      return { ok: false, message: (err as Error).message };
    }
  }

  @Throttle('strict')
  @Post('/api/v1/zoomplus/host/demote')
  async demote(
    @CurrentUser() _user: CurrentUser,
    @Body() body: { room: string; identity: string }
  ) {
    try {
      const result = await this.svc.demoteCoHost(body.room, body.identity);
      return result;
    } catch (err) {
      if (this.isDisabledError(err)) throw new NotFound('ZOOM+ host controls disabled');
      return { ok: false, message: (err as Error).message };
    }
  }

  @Throttle('strict')
  @Get('/api/v1/zoomplus/host/participants')
  async participants(
    @CurrentUser() _user: CurrentUser,
    @Query('room') room: string
  ) {
    try {
      const result = await this.svc.listParticipants(room);
      return result;
    } catch (err) {
      if (this.isDisabledError(err)) throw new NotFound('ZOOM+ host controls disabled');
      return { ok: false, message: (err as Error).message };
    }
  }

  @Throttle('strict')
  @Post('/api/v1/zoomplus/host/end')
  async end(
    @CurrentUser() _user: CurrentUser,
    @Body() body: { room: string }
  ) {
    try {
      const result = await this.svc.endMeeting(body.room);
      return result;
    } catch (err) {
      if (this.isDisabledError(err)) throw new NotFound('ZOOM+ host controls disabled');
      return { ok: false, message: (err as Error).message };
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Detect the service's private ZoomPlusDisabledError by its .name. */
  private isDisabledError(err: unknown): boolean {
    return (
      err instanceof Error && err.name === ZOOMPLUS_DISABLED_ERROR_NAME
    );
  }
}
