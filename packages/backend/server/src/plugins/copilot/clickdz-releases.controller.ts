import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { CacheRedis } from '../../base/redis';
import { Public } from '../../core/auth';
import { DOWNLOAD_PAGE_HTML } from './clickdz-download-page';

/**
 * ClickDz Work release feed — backs the desktop auto-updater.
 *
 * The desktop AFFiNEUpdateProvider (configFeed) polls
 * `https://work.clickdz.ai/api/releases?channel=<x>&minimal=true` and expects a
 * JSON array of GitHub-release-shaped objects whose asset `url`s are directly
 * downloadable. Upstream AFFiNE served this from a Cloudflare worker on
 * affine.pro; for the fork we proxy the public GitHub Releases API for
 * Clickdzpro1/clickdz-work, rewriting asset urls to browser_download_url so
 * the updater can stream installers without GitHub API auth/headers.
 *
 * Cached in Redis (5 min fresh window, 24 h stale fallback) so a whole fleet
 * of desktop clients cannot exhaust the anonymous GitHub API quota.
 */
const RELEASES_API =
  'https://api.github.com/repos/Clickdzpro1/clickdz-work/releases?per_page=20';
// Optional fine-grained read-only PAT. Without it the feed shares the
// anonymous 60 req/h GitHub quota with everything on the Railway egress IP,
// and quota exhaustion silently pins the feed to its stale cache for up to
// ~1 h. With it, the quota is 5000 req/h and effectively never binds.
const CDZ_GITHUB_TOKEN = process.env.CDZ_GITHUB_TOKEN || '';
const CACHE_KEY = 'clickdz:releases:v1';
const FRESH_MS = 5 * 60 * 1000;
const STALE_TTL_SECONDS = 24 * 60 * 60;

interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

interface Release {
  url: string;
  name: string;
  tag_name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string;
  assets: ReleaseAsset[];
}

interface CachedFeed {
  fetchedAt: number;
  releases: Release[];
}

@Public()
@Controller()
export class ClickDzReleasesController {
  constructor(private readonly redis: CacheRedis) {}

  private async readCache(): Promise<CachedFeed | null> {
    try {
      const raw = await this.redis.get(CACHE_KEY);
      return raw ? (JSON.parse(raw) as CachedFeed) : null;
    } catch {
      return null;
    }
  }

  private async fetchFromGithub(): Promise<Release[]> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'clickdz-work-server',
      'x-github-api-version': '2022-11-28',
    };
    if (CDZ_GITHUB_TOKEN) {
      headers.authorization = `Bearer ${CDZ_GITHUB_TOKEN}`;
    }
    const res = await fetch(RELEASES_API, { headers });
    if (!res.ok) {
      throw new Error(`GitHub releases API returned ${res.status}`);
    }
    const releases = (await res.json()) as Array<{
      html_url: string;
      name: string | null;
      tag_name: string;
      body: string | null;
      draft: boolean;
      prerelease: boolean;
      created_at: string;
      published_at: string;
      assets: Array<{
        name: string;
        browser_download_url: string;
        size: number;
      }>;
    }>;

    return releases
      .filter(release => !release.draft)
      .map(release => ({
        url: release.html_url,
        name: release.name ?? release.tag_name,
        tag_name: release.tag_name,
        body: release.body ?? '',
        draft: release.draft,
        prerelease: release.prerelease,
        created_at: release.created_at,
        published_at: release.published_at,
        assets: (release.assets ?? []).map(asset => ({
          name: asset.name,
          url: asset.browser_download_url,
          size: asset.size,
        })),
      }));
  }

  @Get('/api/releases')
  async releases(
    @Query('channel') channel: string | undefined,
    @Query('minimal') minimal: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');

    const cached = await this.readCache();
    let releases: Release[];

    if (cached && Date.now() - cached.fetchedAt < FRESH_MS) {
      releases = cached.releases;
    } else {
      try {
        releases = await this.fetchFromGithub();
        await this.redis.set(
          CACHE_KEY,
          JSON.stringify({
            fetchedAt: Date.now(),
            releases,
          } satisfies CachedFeed),
          'EX',
          STALE_TTL_SECONDS
        );
      } catch {
        // GitHub unreachable/rate-limited: serve the stale copy if we have one.
        releases = cached?.releases ?? [];
      }
    }

    const wantChannel = (channel || 'stable').toLowerCase();
    const filtered =
      wantChannel === 'stable'
        ? releases.filter(release => !release.prerelease)
        : releases;

    if (minimal === 'true') {
      return filtered.map(release => ({ ...release, body: '' }));
    }
    return filtered;
  }

  /**
   * Branded desktop download page. Nest controller routes are registered
   * before the selfhost SPA catch-all (which mounts in onModuleInit), so this
   * wins over the static fallback exactly like /api/releases does. The page's
   * client script reads /api/releases same-origin and wires the buttons to
   * the current release's versionless permalink assets.
   */
  @Get('/download')
  downloadPage(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.send(DOWNLOAD_PAGE_HTML);
  }
}
