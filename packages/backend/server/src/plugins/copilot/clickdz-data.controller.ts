import {
  Body,
  Controller,
  Delete,
  Get,
  Options,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

// Typed AFFiNE errors so the global exception filter emits proper 4xx
// (a raw @nestjs/common HttpException is turned into a generic 500 here).
import { AuthenticationRequired, BadRequest } from '../../base';
import { CacheRedis } from '../../base/redis';
import { Public } from '../../core/auth';
import { verifyDataToken } from './cdz-data-token';

/**
 * ClickDz Data API — a tiny shared collections store that gives every
 * generated ClickDz App persistent, multi-user data without a per-app
 * backend. Apps call it cross-origin from *.vercel.app with plain fetch.
 *
 * Storage model: one Redis hash per (app slug, collection); record ids are
 * hash fields, values are JSON documents with auto id + createdAt.
 * Creative-tool grade: public per-slug namespaces, hard size caps, 90-day
 * rolling expiry.
 */
const SLUG_RE = /^[a-z0-9-]{3,50}$/;
const COLLECTION_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_RECORDS_PER_COLLECTION = 500;
const MAX_LIST_LIMIT = 500;
const DATA_TTL_SECONDS = 90 * 24 * 60 * 60;

const dataKey = (slug: string, collection: string) =>
  `clickdz:appdata:${slug}:${collection}`;

function setCors(res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function badRequest(message: string): never {
  throw new BadRequest(message);
}

@Public()
@Controller()
export class ClickDzDataController {
  constructor(private readonly redis: CacheRedis) {}

  private assertNames(slug: string, collection: string) {
    if (!SLUG_RE.test(slug)) badRequest('Invalid app slug');
    if (!COLLECTION_RE.test(collection)) badRequest('Invalid collection name');
  }

  // v2 requests are token-gated for writes/deletes; v1 stays open for
  // back-compat with already-deployed apps (EXCEPT the destructive clear,
  // which is gated on both versions — see clear()).
  private isV2(req: Request): boolean {
    return (req.path || '').startsWith('/api/v2/');
  }

  private requireWriteToken(req: Request, slug: string) {
    const auth = String(req.headers['authorization'] || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const token = bearer || String((req.query?.t as string) || '');
    if (!verifyDataToken(slug, token)) {
      throw new AuthenticationRequired('A valid write token is required');
    }
  }

  @Options([
    '/api/apps-data/:slug/:collection',
    '/api/apps-data/:slug/:collection/:id',
    '/api/v2/apps-data/:slug/:collection',
    '/api/v2/apps-data/:slug/:collection/:id',
  ])
  preflight(@Res() res: Response) {
    setCors(res);
    res.status(204).end();
  }

  @Get([
    '/api/apps-data/:slug/:collection',
    '/api/v2/apps-data/:slug/:collection',
  ])
  async list(
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Query('limit') limit: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    setCors(res);
    this.assertNames(slug, collection);
    const raw = await this.redis.hgetall(dataKey(slug, collection));
    const records = Object.values(raw)
      .map(value => {
        try {
          return JSON.parse(value) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((record): record is Record<string, unknown> => !!record)
      .sort((a, b) =>
        String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
      );
    const max = Math.min(
      Math.max(Number(limit) || MAX_LIST_LIMIT, 1),
      MAX_LIST_LIMIT
    );
    return records.slice(0, max);
  }

  @Post([
    '/api/apps-data/:slug/:collection',
    '/api/v2/apps-data/:slug/:collection',
  ])
  async create(
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    setCors(res);
    this.assertNames(slug, collection);
    if (this.isV2(req)) this.requireWriteToken(req, slug);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      badRequest('Record must be a JSON object');
    }
    const key = dataKey(slug, collection);
    const count = await this.redis.hlen(key);
    if (count >= MAX_RECORDS_PER_COLLECTION) {
      throw new BadRequest(
        `Collection is full (${MAX_RECORDS_PER_COLLECTION} records max)`
      );
    }
    const id = randomUUID().slice(0, 8);
    const record = {
      ...(body as Record<string, unknown>),
      id,
      createdAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
      badRequest(`Record too large (${MAX_RECORD_BYTES / 1024}KB max)`);
    }
    await this.redis.hset(key, id, serialized);
    await this.redis.expire(key, DATA_TTL_SECONDS);
    return record;
  }

  @Delete([
    '/api/apps-data/:slug/:collection/:id',
    '/api/v2/apps-data/:slug/:collection/:id',
  ])
  async remove(
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    setCors(res);
    this.assertNames(slug, collection);
    if (this.isV2(req)) this.requireWriteToken(req, slug);
    const removed = await this.redis.hdel(dataKey(slug, collection), id);
    return { deleted: removed > 0 };
  }

  @Delete([
    '/api/apps-data/:slug/:collection',
    '/api/v2/apps-data/:slug/:collection',
  ])
  async clear(
    @Param('slug') slug: string,
    @Param('collection') collection: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    setCors(res);
    this.assertNames(slug, collection);
    // Destructive collection-wide wipe is gated on BOTH v1 and v2 — generated
    // apps never call it, so this closes the "wipe any app by slug" vector at
    // no back-compat cost.
    this.requireWriteToken(req, slug);
    await this.redis.del(dataKey(slug, collection));
    return { cleared: true };
  }
}
