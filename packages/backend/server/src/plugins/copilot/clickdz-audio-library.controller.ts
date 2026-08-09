import { Body, Controller, Delete, Get, Logger, Param, Post } from '@nestjs/common';

// Typed AFFiNE errors so the global exception filter emits proper 4xx/5xx (a
// raw @nestjs/common HttpException is coerced to a generic 500 by base/nestjs/
// exception.ts). BadRequest = a bad body (missing/oversized clip); NotFound = a
// clip that does not exist; InternalServerError = a store failure. Throttle =
// the house rate-limit decorator, the SAME one the peer voice/vdz controllers use.
import {
  BadRequest,
  InternalServerError,
  NotFound,
  Throttle,
} from '../../base';
// CacheRedis is the @Global ioredis client (CacheRedis extends Redis), injected
// without module wiring exactly like the bridge/vdz controllers do. The clip
// list (an id -> record map) lives here; the bytes live in CopilotStorage.
import { CacheRedis } from '../../base/redis';
// CurrentUser decorates + types the cookie-session user, from core/auth like
// every peer. First-party web-app route (NOT @Public): the global AuthGuard
// requires a signed-in session.
import { CurrentUser } from '../../core/auth';
// CopilotStorage persists clip bytes under the user's copilot scope and returns
// a replay URL `/api/copilot/blob/{u}/{w}/{key}` for <audio src>. Injectable
// (backend plugin module providers list, module-providers.ts:116). The blob GET
// route is @Public and lives in CopilotController — we reuse it, we do NOT
// duplicate serve code here.
import { CopilotStorage } from './storage';

// ---------------------------------------------------------------------------
// CDZ VOICE STUDIO — AUDIO LIBRARY.
//
// A per-user library of Voice Studio outputs (synthesized clips + saved
// transcripts). Records live in Redis (an id -> record map, so list/delete
// never has to scan object storage); the audio/text bytes live in
// CopilotStorage under the user's copilot scope. Everything is keyed by the
// authenticated user — a library list is only ever visible to the user that
// wrote it, exactly like the vdz project records.
//
//   · POST   /api/v1/voice/library/clips
//            { name?, kind, blob?|transcript?, mime? }  -> { id, url, name,
//              createdAt, kind }
//   · GET    /api/v1/voice/library/clips                -> { clips: [...] }
//   · DELETE /api/v1/voice/library/clips/:id            -> { ok }
//
// kind is 'tts' (raw audio bytes) or 'transcript' (plain text). For 'tts' the
// bytes are base64 in the JSON body (same posture as the vdz upload path).
// ---------------------------------------------------------------------------

const LIBRARY_KINDS = ['tts', 'transcript'] as const;
type LibraryKind = (typeof LIBRARY_KINDS)[number];

// Bounds. A clip byte-payload fits comfortably in memory; a transcript is
// capped at a sane text size.
const LIBRARY_MAX_CLIP_BYTES = 20 * 1024 * 1024;
const LIBRARY_MAX_TRANSCRIPT_CHARS = 200_000;
// Cap on the number of list rows returned (older rows simply drop off).
const LIBRARY_MAX_ITEMS = 200;
// Rolling TTL for the per-user index (records + bytes). Bytes live in object
// storage regardless; the TTL only bounds stale list rows on recovery.
const LIBRARY_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

const libraryIndexKey = (userId: string) => `cdz:voice:library:${userId}`;

interface LibraryRecord {
  id: string;
  key: string; // blob store key (storage.get/delete scope)
  url: string; // replay URL from CopilotStorage.put
  name: string;
  kind: LibraryKind;
  createdAt: number;
}

@Controller()
export class ClickDzAudioLibraryController {
  private readonly logger = new Logger(ClickDzAudioLibraryController.name);

  constructor(
    private readonly redis: CacheRedis,
    private readonly storage: CopilotStorage
  ) {}

  /** Parse the caller's saved {@link LibraryRecord} list (fail-soft -> []). */
  private async readLibrary(userId: string): Promise<LibraryRecord[]> {
    let raw: string | null = null;
    try {
      raw = await this.redis.get(libraryIndexKey(userId));
    } catch {
      raw = null;
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((r): r is LibraryRecord => {
          const rec = r as Partial<LibraryRecord>;
          return (
            !!rec &&
            typeof rec.id === 'string' &&
            typeof rec.key === 'string' &&
            typeof rec.url === 'string' &&
            typeof rec.name === 'string' &&
            (rec.kind === 'tts' || rec.kind === 'transcript') &&
            typeof rec.createdAt === 'number'
          );
        })
        .sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  /** Persist the caller's library list + rolling TTL (fail-soft). */
  private async writeLibrary(userId: string, items: LibraryRecord[]): Promise<void> {
    const key = libraryIndexKey(userId);
    try {
      if (items.length) {
        await this.redis.set(key, JSON.stringify(items));
      } else {
        await this.redis.del(key);
      }
      await this.redis.expire(key, LIBRARY_TTL_SECONDS);
    } catch {
      // ignore — a recording failure only loses the list row, not the bytes
    }
  }

  /**
   * POST /api/v1/voice/library/clips — save a synthesized clip ('tts') or a
   * transcript ('transcript') under the caller's copilot scope. Returns the
   * clip record including the replay URL for <audio>. Owner-scoped, session-
   * authed, @Throttle('strict') (a paid persist path), typed errors.
   */
  @Throttle('strict')
  @Post('/api/v1/voice/library/clips')
  async addClip(
    @CurrentUser() user: CurrentUser,
    @Body() body: unknown
  ): Promise<{
    id: string;
    url: string;
    name: string;
    createdAt: number;
    kind: LibraryKind;
  }> {
    const payload = (body ?? {}) as Record<string, unknown>;

    const kind =
      typeof payload.kind === 'string' &&
      (LIBRARY_KINDS as readonly string[]).includes(payload.kind)
        ? (payload.kind as LibraryKind)
        : undefined;
    if (!kind) {
      throw new BadRequest('A valid "kind" ("tts" or "transcript") is required');
    }

    const rawName = typeof payload.name === 'string' ? payload.name : '';
    const name = rawName.trim().slice(0, 200) || 'Clip';
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const key = `voice-library/${kind}/${id}`;

    let url: string;
    try {
      if (kind === 'tts') {
        const b64 = typeof payload.blob === 'string' ? payload.blob : '';
        if (!b64) {
          throw new BadRequest('"blob" (base64 audio) is required for kind "tts"');
        }
        let raw: Buffer;
        try {
          raw = Buffer.from(b64, 'base64');
        } catch {
          throw new BadRequest('"blob" is not valid base64');
        }
        if (raw.length === 0) {
          throw new BadRequest('"blob" is empty');
        }
        if (raw.length > LIBRARY_MAX_CLIP_BYTES) {
          throw new BadRequest(
            `"blob" is too large (max ${Math.floor(
              LIBRARY_MAX_CLIP_BYTES / (1024 * 1024)
            )}MB)`
          );
        }
        const mime = typeof payload.mime === 'string' ? payload.mime : 'audio/mpeg';
        url = await this.storage.put(user.id, 'voice', key, raw, mime);
      } else {
        const text = typeof payload.transcript === 'string' ? payload.transcript : '';
        if (!text.trim()) {
          throw new BadRequest('A non-empty "transcript" is required');
        }
        if (text.length > LIBRARY_MAX_TRANSCRIPT_CHARS) {
          throw new BadRequest(
            `"transcript" is too long (max ${LIBRARY_MAX_TRANSCRIPT_CHARS} characters)`
          );
        }
        // Persist the transcript as a UTF-8 text blob. Consumers may read it via
        // the public blob getter; we keep the same record shape as 'tts'.
        url = await this.storage.put(
          user.id,
          'voice',
          key,
          Buffer.from(text, 'utf8'),
          'text/plain; charset=utf-8'
        );
      }
    } catch (e) {
      if (e instanceof BadRequest) throw e;
      throw new InternalServerError(
        e instanceof Error && e.message
          ? `Failed to persist clip: ${e.message}`
          : 'Failed to persist clip'
      );
    }

    const record: LibraryRecord = {
      id,
      key,
      url,
      name,
      kind,
      createdAt: Date.now(),
    };
    const items = await this.readLibrary(user.id);
    await this.writeLibrary(user.id, [record, ...items].slice(0, LIBRARY_MAX_ITEMS));

    this.logger.log(
      `[voice-library] save user=${user.id} kind=${kind} id=${id}`
    );
    return { id, url, name, createdAt: record.createdAt, kind };
  }

  /**
   * GET /api/v1/voice/library/clips — list the caller's saved clips, newest
   * first. Lightweight (a Redis index read + JSON parse), fail-soft to [].
   */
  @Throttle('default')
  @Get('/api/v1/voice/library/clips')
  async listClips(
    @CurrentUser() user: CurrentUser
  ): Promise<{
    clips: Array<{
      id: string;
      url: string;
      name: string;
      createdAt: number;
      kind: string;
    }>;
  }> {
    const items = await this.readLibrary(user.id);
    return {
      clips: items.slice(0, LIBRARY_MAX_ITEMS).map(r => ({
        id: r.id,
        url: r.url,
        name: r.name,
        createdAt: r.createdAt,
        kind: r.kind,
      })),
    };
  }

  /**
   * DELETE /api/v1/voice/library/clips/:id — remove a clip from the caller's
   * library (index row + its bytes). Owner-scoped by the Redis key, so a wrong
   * id simply 404s (never a cross-user delete).
   */
  @Throttle('default')
  @Delete('/api/v1/voice/library/clips/:id')
  async deleteClip(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string
  ): Promise<{ ok: boolean }> {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (!trimmed) {
      throw new BadRequest('A clip id is required');
    }
    const items = await this.readLibrary(user.id);
    const target = items.find(r => r.id === trimmed);
    if (!target) {
      throw new NotFound('Clip not found');
    }
    const kept = items.filter(r => r.id !== trimmed);
    await this.writeLibrary(user.id, kept);
    // Remove the underlying bytes (fail-soft: dropping the index row already
    // removes it from the list; the blob may linger in storage).
    try {
      await this.storage.delete(user.id, 'voice', target.key);
    } catch {
      // ignore
    }
    this.logger.log(
      `[voice-library] delete user=${user.id} kind=${target.kind} id=${trimmed}`
    );
    return { ok: true };
  }
}
