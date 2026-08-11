// ClickDz Work — ZOOM+ host-controls backend (LiveKit RoomService).
//
// Lets a meeting HOST control a LiveKit room from our backend:
//   · mute / mute-all / kick / lock / admit
//   · toggle screen-share / camera
//   · rename / promote co-host
//   · list participants / end meeting
//
// Calls the LiveKit Twirp REST API directly via fetch (no livekit-server-sdk
// dependency). Each request is authenticated with a freshly-signed HS256 JWT
// whose `kid` header carries the LiveKit API key.
//
// Flag-gated: every public method checks enabled() at call time. Until the
// owner sets CDZ_ZOOMPLUS_HOST_CONTROLS_ENABLED=1 + LIVEKit creds, all calls
// throw a typed error — registration is byte-inert and the app never crashes.

import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of LiveKit participant permissions we manipulate. */
export interface ZoomPlusPermissions {
  canSubscribe: boolean;
  canPublish: boolean;
  canPublishData: boolean;
  canPublishSources: string[];
  hidden: boolean;
  canUpdateMetadata: boolean;
}

/** A participant row as returned by ListParticipants. */
export interface ZoomPlusParticipant {
  sid: string;
  identity: string;
  name?: string;
  joinedAt?: number;
  isSpeaking?: boolean;
  tracks?: ZoomPlusTrackInfo[];
}

/** A published track inside a participant. */
export interface ZoomPlusTrackInfo {
  sid: string;
  type: string; // "audio" | "video"
  source: string; // "mic" | "camera" | "screen_share" | …
  muted: boolean;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

class ZoomPlusDisabledError extends Error {
  constructor() {
    super(
      'ZOOM+ host controls disabled (set CDZ_ZOOMPLUS_HOST_CONTROLS_ENABLED=1 + LIVEKIT creds)'
    );
    this.name = 'ZoomPlusDisabledError';
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ClickDzZoomPlusService {
  /** All publish sources — granted to co-hosts. */
  private readonly ALL_SOURCES = ['CAMERA', 'MICROPHONE', 'SCREEN_SHARE'];

  /**
   * Reads a config value, preferring the CDZ_-prefixed alias and falling back
   * to the unprefixed LIVEKIT_ variant.
   */
  private cfg(cdzKey: string, livekitKey: string): string | undefined {
    return process.env[cdzKey] || process.env[livekitKey] || undefined;
  }

  /** Normalized LiveKit base URL (trailing slash stripped). */
  private get baseUrl(): string {
    const raw =
      this.cfg('CDZ_LIVEKIT_API_URL', 'LIVEKIT_API_URL') || '';
    return raw.replace(/\/+$/, '');
  }

  private get apiKey(): string | undefined {
    return this.cfg('CDZ_LIVEKIT_API_KEY', 'LIVEKIT_API_KEY');
  }

  private get apiSecret(): string | undefined {
    return this.cfg('CDZ_LIVEKIT_API_SECRET', 'LIVEKIT_API_SECRET');
  }

  /** True only when the feature flag is ON AND all three creds are present. */
  private enabled(): boolean {
    return (
      process.env.CDZ_ZOOMPLUS_HOST_CONTROLS_ENABLED === '1' &&
      !!this.apiKey &&
      !!this.apiSecret &&
      !!this.baseUrl
    );
  }

  /** Throws the typed disabled-error when the service is not enabled. */
  private ensureEnabled(): void {
    if (!this.enabled()) {
      throw new ZoomPlusDisabledError();
    }
  }

  // -------------------------------------------------------------------------
  // JWT signing — fresh per call, 60 s expiry, kid header = API key.
  // NEVER log the returned token or the secret.
  // -------------------------------------------------------------------------

  private signRoomToken(roomName: string): string {
    const apiKey = this.apiKey!;
    const apiSecret = this.apiSecret!;
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: apiKey,
      sub: apiKey,
      exp: now + 60,
      nbf: now - 5,
      video: {
        roomAdmin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        hidden: true,
      },
    };
    return jwt.sign(payload, apiSecret, {
      algorithm: 'HS256',
      header: { alg: 'HS256', typ: 'JWT', kid: apiKey },
    });
  }

  // -------------------------------------------------------------------------
  // Low-level Twirp call — fail-closed (throws on non-2xx or network error).
  // -------------------------------------------------------------------------

  private async roomCall(
    method: string,
    body: Record<string, unknown>
  ): Promise<any> {
    this.ensureEnabled();
    const base = this.baseUrl;
    const url = `${base}/twirp/livekit.RoomService/${method}`;
    const token = this.signRoomToken((body as any).room ?? '');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `LiveKit ${method} failed: ${res.status} ${res.statusText}${text ? ' — ' + text : ''}`
      );
    }

    // Some methods (DeleteRoom, RemoveParticipant) return an empty body.
    const text = await res.text();
    if (!text) {
      return {};
    }
    return JSON.parse(text);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Mute a single participant. If trackSid is omitted, finds the mic track. */
  async muteParticipant(
    room: string,
    identity: string,
    trackSid?: string,
    muted = true
  ): Promise<{ ok: true }> {
    this.ensureEnabled();
    let sid = trackSid;
    if (!sid) {
      const { participants } = await this.roomCall('ListParticipants', {
        room,
      });
      const p = (participants || []).find(
        (x: ZoomPlusParticipant) => x.identity === identity
      );
      const micTrack = p?.tracks?.find(
        t => t.type === 'audio' && t.source === 'mic'
      );
      if (!micTrack) {
        throw new Error(
          `No microphone track found for participant "${identity}" in room "${room}"`
        );
      }
      sid = micTrack.sid;
    }
    await this.roomCall('MutePublishedTrack', {
      room,
      identity,
      trackSid: sid,
      muted,
    });
    return { ok: true };
  }

  /** Mute every participant's microphone in the room. */
  async muteAllParticipants(room: string): Promise<{ muted: string[] }> {
    this.ensureEnabled();
    const { participants } = await this.roomCall('ListParticipants', {
      room,
    });
    const muted: string[] = [];
    for (const p of participants || []) {
      const micTrack = p.tracks?.find(
        (t: ZoomPlusTrackInfo) => t.type === 'audio' && t.source === 'mic'
      );
      if (micTrack) {
        await this.roomCall('MutePublishedTrack', {
          room,
          identity: p.identity,
          trackSid: micTrack.sid,
          muted: true,
        });
        muted.push(p.identity);
      }
    }
    return { muted };
  }

  /** Remove (kick) a participant from the room. */
  async removeParticipant(
    room: string,
    identity: string
  ): Promise<{ ok: true }> {
    this.ensureEnabled();
    await this.roomCall('RemoveParticipant', { room, identity });
    return { ok: true };
  }

  /** Low-level permissions update. */
  async updateParticipantPermissions(
    room: string,
    identity: string,
    permissions: ZoomPlusPermissions
  ): Promise<{ ok: true }> {
    this.ensureEnabled();
    await this.roomCall('UpdateParticipant', {
      room,
      identity,
      permissions,
    });
    return { ok: true };
  }

  /** Toggle screen-share permission for a participant. */
  async toggleScreenShare(
    room: string,
    identity: string,
    allowed: boolean
  ): Promise<{ ok: true }> {
    this.ensureEnabled();
    const current = await this.getParticipantPermissions(room, identity);
    let sources = current.canPublishSources.filter(
      s => s !== 'SCREEN_SHARE'
    );
    if (allowed) {
      sources = [...sources, 'SCREEN_SHARE'];
    }
    await this.updateParticipantPermissions(room, identity, {
      ...current,
      canPublishSources: sources,
    });
    return { ok: true };
  }

  /** Toggle camera permission for a participant. */
  async toggleCamera(
    room: string,
    identity: string,
    allowed: boolean
  ): Promise<{ ok: true }> {
    this.ensureEnabled();
    const current = await this.getParticipantPermissions(room, identity);
    let sources = current.canPublishSources.filter(s => s !== 'CAMERA');
    if (allowed) {
      sources = [...sources, 'CAMERA'];
    }
    await this.updateParticipantPermissions(room, identity, {
      ...current,
      canPublishSources: sources,
    });
    return { ok: true };
  }

  /** Rename a participant (UpdateParticipant with name field). */
  async renameParticipant(
    room: string,
    identity: string,
    name: string
  ): Promise<{ ok: true }> {
    this.ensureEnabled();
    await this.roomCall('UpdateParticipant', { room, identity, name });
    return { ok: true };
  }

  /** Promote a participant to co-host (full permissions). */
  async promoteCoHost(
    room: string,
    identity: string
  ): Promise<{ ok: true }> {
    this.ensureEnabled();
    await this.updateParticipantPermissions(room, identity, {
      canSubscribe: true,
      canPublish: true,
      canPublishData: true,
      canPublishSources: [...this.ALL_SOURCES],
      hidden: false,
      canUpdateMetadata: true,
    });
    return { ok: true };
  }

  /** Demote a co-host back to default member permissions. */
  async demoteCoHost(
    room: string,
    identity: string
  ): Promise<{ ok: true }> {
    this.ensureEnabled();
    await this.updateParticipantPermissions(room, identity, {
      canSubscribe: true,
      canPublish: true,
      canPublishData: false,
      canPublishSources: ['CAMERA', 'MICROPHONE'],
      hidden: false,
      canUpdateMetadata: false,
    });
    return { ok: true };
  }

  /** List all participants in a room. */
  async listParticipants(room: string): Promise<{
    participants: ZoomPlusParticipant[];
  }> {
    this.ensureEnabled();
    const data = await this.roomCall('ListParticipants', { room });
    return { participants: data.participants || [] };
  }

  /** End a meeting (delete the room). */
  async endMeeting(room: string): Promise<{ ok: true }> {
    this.ensureEnabled();
    await this.roomCall('DeleteRoom', { room });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Fetches the current permissions of a participant (for toggle operations). */
  private async getParticipantPermissions(
    room: string,
    identity: string
  ): Promise<ZoomPlusPermissions> {
    const { participants } = await this.roomCall('ListParticipants', {
      room,
    });
    const p = (participants || []).find(
      (x: ZoomPlusParticipant) => x.identity === identity
    );
    if (!p) {
      throw new Error(
        `Participant "${identity}" not found in room "${room}"`
      );
    }
    // LiveKit embeds permissions inside the participant object; if absent we
    // default to a sensible member baseline.
    const raw = (p as any).permissions;
    return {
      canSubscribe: raw?.canSubscribe ?? true,
      canPublish: raw?.canPublish ?? true,
      canPublishData: raw?.canPublishData ?? false,
      canPublishSources: raw?.canPublishSources ?? [
        'CAMERA',
        'MICROPHONE',
      ],
      hidden: raw?.hidden ?? false,
      canUpdateMetadata: raw?.canUpdateMetadata ?? false,
    };
  }
}
