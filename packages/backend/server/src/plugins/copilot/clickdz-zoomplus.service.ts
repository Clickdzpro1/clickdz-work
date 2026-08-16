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
        // roomList authorizes ListRooms (not room-scoped); roomCreate authorizes
        // CreateRoom (used by patchRoomMetadata when a room has no session yet).
        // roomAdmin alone covers the room-scoped ops (Update/Delete/Mute/…) but
        // NOT the service-wide list/create, so we grant those explicitly. Adding
        // grants to the token is harmless for the room-scoped calls.
        roomList: true,
        roomCreate: true,
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
  // JWT signing for the Egress (recording) service. Egress needs `roomRecord`
  // rather than `roomAdmin`; a room-scoped token is enough (the room name is on
  // every egress request body). Fresh per call, 60 s expiry, kid = API key.
  // -------------------------------------------------------------------------

  private signEgressToken(roomName: string): string {
    const apiKey = this.apiKey!;
    const apiSecret = this.apiSecret!;
    const now = Math.floor(Date.now() / 1000);
    // `roomRecord` is the egress grant. Include `room` only when we have one
    // (StartRoomCompositeEgress / ListEgress-by-room); StopEgress carries only
    // an egressId, so a room-less grant is correct there.
    const video: Record<string, unknown> = { roomRecord: true };
    if (roomName) video.room = roomName;
    const payload = {
      iss: apiKey,
      sub: apiKey,
      exp: now + 60,
      nbf: now - 5,
      video,
    };
    return jwt.sign(payload, apiSecret, {
      algorithm: 'HS256',
      header: { alg: 'HS256', typ: 'JWT', kid: apiKey },
    });
  }

  // -------------------------------------------------------------------------
  // Low-level Twirp call — fail-closed (throws on non-2xx or network error).
  // `service` selects the Twirp namespace: RoomService (default, room admin)
  // or EgressService (recording). The signing scope follows the service so the
  // token always carries the grant LiveKit checks for that RPC.
  // -------------------------------------------------------------------------

  private async roomCall(
    method: string,
    body: Record<string, unknown>,
    service: 'RoomService' | 'EgressService' = 'RoomService'
  ): Promise<any> {
    this.ensureEnabled();
    const base = this.baseUrl;
    const url = `${base}/twirp/livekit.${service}/${method}`;
    const roomName = String(
      (body as any).room ??
        (body as any).roomName ??
        (body as any).name ??
        ''
    );
    const token =
      service === 'EgressService'
        ? this.signEgressToken(roomName)
        : this.signRoomToken(roomName);

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
  // Room lifecycle + lock — LiveKit does not carry a first-class "locked" flag
  // on a room, so we model it in the room METADATA (a JSON blob LiveKit stores
  // and echoes back on ListRooms). The Meet SPA can read it; our host panel
  // reads it back through getRoomState(). Setting metadata is a real, supported
  // LiveKit operation (UpdateRoomMetadata) — nothing is faked.
  // -------------------------------------------------------------------------

  /** Parse a room's metadata JSON (best-effort; returns {} on anything odd). */
  private parseMeta(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'string' || !raw.trim()) return {};
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /**
   * Fetch a single room's live state (exists, participant count, and the
   * cdz policy flags we stash in metadata: locked / muteOnEntry / recording).
   * Returns exists:false when the room has no active session (LiveKit only
   * lists rooms that currently exist).
   */
  async getRoomState(room: string): Promise<{
    ok: true;
    exists: boolean;
    numParticipants: number;
    locked: boolean;
    muteOnEntry: boolean;
    recording: boolean;
    metadata: Record<string, unknown>;
  }> {
    this.ensureEnabled();
    const data = await this.roomCall('ListRooms', { names: [room] });
    const found = (data.rooms || []).find(
      (r: any) => r.name === room
    );
    const meta = this.parseMeta(found?.metadata);
    return {
      ok: true,
      exists: !!found,
      numParticipants: Number(found?.numParticipants ?? found?.num_participants ?? 0),
      locked: meta.cdzLocked === true,
      muteOnEntry: meta.cdzMuteOnEntry === true,
      recording: meta.cdzRecording === true,
      metadata: meta,
    };
  }

  /** List every active room (Meet creates one per meeting). */
  async listRooms(): Promise<{
    ok: true;
    rooms: Array<{
      name: string;
      numParticipants: number;
      creationTime?: number;
      locked: boolean;
      recording: boolean;
    }>;
  }> {
    this.ensureEnabled();
    const data = await this.roomCall('ListRooms', {});
    const rooms = (data.rooms || []).map((r: any) => {
      const meta = this.parseMeta(r?.metadata);
      return {
        name: String(r.name ?? ''),
        numParticipants: Number(r.numParticipants ?? r.num_participants ?? 0),
        creationTime: r.creationTime
          ? Number(r.creationTime)
          : r.creation_time
            ? Number(r.creation_time)
            : undefined,
        locked: meta.cdzLocked === true,
        recording: meta.cdzRecording === true,
      };
    });
    return { ok: true, rooms };
  }

  /** Merge a patch into a room's metadata (preserving unrelated keys). */
  private async patchRoomMetadata(
    room: string,
    patch: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // Read-modify-write on the room metadata blob. If the room does not exist
    // yet (no session), CreateRoom mints it with the metadata so the policy is
    // in place before the first participant joins.
    const data = await this.roomCall('ListRooms', { names: [room] });
    const found = (data.rooms || []).find((r: any) => r.name === room);
    const current = this.parseMeta(found?.metadata);
    const next = { ...current, ...patch };
    const metadata = JSON.stringify(next);
    if (found) {
      await this.roomCall('UpdateRoomMetadata', { room, metadata });
    } else {
      // No active session — create the room carrying the metadata so the flag
      // survives until the first join. `emptyTimeout` keeps it briefly alive.
      await this.roomCall('CreateRoom', {
        name: room,
        metadata,
        emptyTimeout: 300,
      });
    }
    return next;
  }

  /**
   * Lock / unlock a meeting. LiveKit itself has no "reject new joiners" switch
   * server-side (join is gated by token issuance, which Meet owns), so locking
   * does two REAL things: (1) records cdzLocked in room metadata so the Meet
   * SPA / token minter can refuse new tokens, and (2) is surfaced in the host
   * panel. This is the honest extent of what the wired provider supports.
   */
  async setLocked(room: string, locked: boolean): Promise<{ ok: true; locked: boolean }> {
    this.ensureEnabled();
    await this.patchRoomMetadata(room, { cdzLocked: locked });
    return { ok: true, locked };
  }

  /**
   * Toggle "mute participants on entry" policy. We persist it in metadata AND
   * immediately mute everyone currently unmuted (so flipping it mid-meeting
   * behaves like a mute-all + a standing policy). New joiners are muted by the
   * host panel's poll loop when it detects an unmuted newcomer under policy.
   */
  async setMuteOnEntry(
    room: string,
    muteOnEntry: boolean
  ): Promise<{ ok: true; muteOnEntry: boolean }> {
    this.ensureEnabled();
    await this.patchRoomMetadata(room, { cdzMuteOnEntry: muteOnEntry });
    if (muteOnEntry) {
      // Best-effort immediate enforcement; ignore if the room is empty.
      try {
        await this.muteAllParticipants(room);
      } catch {
        /* room may not exist yet — the policy still stands for joiners */
      }
    }
    return { ok: true, muteOnEntry };
  }

  // -------------------------------------------------------------------------
  // Recording — LiveKit Egress (RoomCompositeEgress). Requires egress to be
  // configured on the LiveKit deployment (an egress worker + object storage).
  // We start a composite recording of the whole room and, on stop, end the
  // egress by id. The active egress id is stashed in room metadata so any host
  // (across reloads) can stop a recording someone else started.
  // -------------------------------------------------------------------------

  /**
   * Start recording the room (RoomCompositeEgress → the deployment's configured
   * storage). Returns the egressId. Throws a typed message when egress is not
   * configured on the LiveKit side so the UI can hide the control.
   */
  async startRecording(room: string): Promise<{ ok: true; egressId: string }> {
    this.ensureEnabled();
    // LiveKit reads the output destination from the egress worker's config
    // (S3/GCS/Azure) when the request omits an explicit upload target, so a
    // bare RoomComposite request records to the deployment default.
    // proto3 JSON (lowerCamelCase) — the same convention the proven room calls
    // use (e.g. `trackSid`). LiveKit's Twirp JSON accepts this form.
    const res = await this.roomCall(
      'StartRoomCompositeEgress',
      {
        roomName: room,
        layout: 'grid',
        audioOnly: false,
        fileOutputs: [{ fileType: 'MP4' }],
      },
      'EgressService'
    );
    const egressId = String(res?.egressId ?? res?.egress_id ?? '');
    if (egressId) {
      try {
        await this.patchRoomMetadata(room, {
          cdzRecording: true,
          cdzEgressId: egressId,
        });
      } catch {
        /* metadata is a convenience; recording is already running */
      }
    }
    return { ok: true, egressId };
  }

  /**
   * Stop the active recording. When `egressId` is omitted we read it back from
   * the room metadata (set at start time), so a different host can stop it.
   */
  async stopRecording(
    room: string,
    egressId?: string
  ): Promise<{ ok: true }> {
    this.ensureEnabled();
    let id = egressId;
    if (!id) {
      const state = await this.getRoomState(room);
      const metaId = state.metadata.cdzEgressId;
      id = typeof metaId === 'string' ? metaId : undefined;
    }
    if (!id) {
      throw new Error('No active recording found for this room.');
    }
    await this.roomCall('StopEgress', { egressId: id }, 'EgressService');
    try {
      await this.patchRoomMetadata(room, {
        cdzRecording: false,
        cdzEgressId: '',
      });
    } catch {
      /* non-fatal */
    }
    return { ok: true };
  }

  /**
   * List recordings for a room via Egress ListEgress. Returns finished MP4
   * egress items with their location + duration when the deployment exposes
   * them. Empty list when egress is unconfigured or nothing has been recorded.
   */
  async listRecordings(room: string): Promise<{
    ok: true;
    recordings: Array<{
      egressId: string;
      status: string;
      startedAt?: number;
      endedAt?: number;
      files: Array<{ filename?: string; location?: string; size?: number; duration?: number }>;
    }>;
  }> {
    this.ensureEnabled();
    const data = await this.roomCall(
      'ListEgress',
      { roomName: room },
      'EgressService'
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    const recordings = items.map((it: any) => {
      const fileResults = Array.isArray(it?.fileResults)
        ? it.fileResults
        : Array.isArray(it?.file_results)
          ? it.file_results
          : it?.file
            ? [it.file]
            : [];
      return {
        egressId: String(it?.egressId ?? it?.egress_id ?? ''),
        status: String(it?.status ?? ''),
        startedAt: it?.startedAt
          ? Number(it.startedAt)
          : it?.started_at
            ? Number(it.started_at)
            : undefined,
        endedAt: it?.endedAt
          ? Number(it.endedAt)
          : it?.ended_at
            ? Number(it.ended_at)
            : undefined,
        files: fileResults.map((f: any) => ({
          filename: f?.filename ? String(f.filename) : undefined,
          location: f?.location ? String(f.location) : undefined,
          size: f?.size != null ? Number(f.size) : undefined,
          duration: f?.duration != null ? Number(f.duration) : undefined,
        })),
      };
    });
    return { ok: true, recordings };
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
