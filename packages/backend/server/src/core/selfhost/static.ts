import { join } from 'node:path';

import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Application } from 'express';
import { static as serveStatic } from 'express';
import isMobile from 'is-mobile';

import { Config } from '../../base';
import { SetupMiddleware } from './setup';

// content-hashed assets emitted by rspack carry an 8-char contenthash
// segment right before the file extension, e.g.
//   js/index.a1b2c3d4.js, styles.a1b2c3d4.css, assets/logo.a1b2c3d4.png
// (see `[name].[contenthash:8]...` in tools/cli/src/rspack/index.ts).
// Such files are safe to cache forever because a content change mints a new
// name; anything else (unhashed files, HTML) must stay revalidatable.
const hashedAssetRegex = /\.[0-9a-f]{8}\.[a-z0-9]+$/i;

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function setHashedAssetHeaders(res: { setHeader(k: string, v: string): void }, path: string) {
  if (hashedAssetRegex.test(path)) {
    res.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
  }
}

@Injectable()
export class StaticFilesResolver implements OnModuleInit {
  constructor(
    private readonly config: Config,
    private readonly adapterHost: HttpAdapterHost,
    private readonly check: SetupMiddleware
  ) {}

  onModuleInit() {
    // in command line mode
    if (!this.adapterHost.httpAdapter) {
      return;
    }

    const app = this.adapterHost.httpAdapter.getInstance<Application>();
    // for example, '/affine' in host [//host.com/affine]
    const basePath = this.config.server.path;
    const staticPath = join(env.projectRoot, 'static');

    // web => {
    //   affine: 'static/index.html',
    //   selfhost: 'static/selfhost.html'
    // }
    // admin => {
    //   affine: 'static/admin/index.html',
    //   selfhost: 'static/admin/selfhost.html'
    // }
    // mobile => {
    //   affine: 'static/mobile/index.html',
    //   selfhost: 'static/mobile/selfhost.html'
    // }
    // NOTE(@forehalo):
    //   the order following routes should be respected,
    //   otherwise the app won't work properly.

    // START REGION: /admin
    // do not allow '/index.html' url, redirect to '/'
    app.get(basePath + '/admin/index.html', (_req, res) => {
      return res.redirect(basePath + '/admin');
    });

    // serve all static files
    app.use(
      basePath + '/admin',
      serveStatic(join(staticPath, 'admin'), {
        redirect: false,
        index: false,
        fallthrough: true,
        setHeaders: setHashedAssetHeaders,
      })
    );

    // fallback all unknown routes
    app.get(
      [basePath + '/admin', basePath + '/admin/*path'],
      this.check.use,
      (_req, res) => {
        res.sendFile(
          join(
            staticPath,
            'admin',
            env.selfhosted ? 'selfhost.html' : 'index.html'
          )
        );
      }
    );
    // END REGION

    // START REGION: /mobile
    // serve all static files
    app.use(
      basePath,
      serveStatic(join(staticPath, 'mobile'), {
        redirect: false,
        index: false,
        fallthrough: true,
        setHeaders: setHashedAssetHeaders,
      })
    );
    // END REGION

    // START REGION: /
    // do not allow '/index.html' url, redirect to '/'
    app.get(basePath + '/index.html', (_req, res) => {
      return res.redirect(basePath);
    });

    // serve all static files
    app.use(
      basePath,
      serveStatic(staticPath, {
        redirect: false,
        index: false,
        fallthrough: true,
        dotfiles: 'ignore',
        // only content-hashed assets get long-lived immutable caching;
        // unhashed files fall through to the SPA fallback's default headers
        setHeaders: setHashedAssetHeaders,
      })
    );

    // fallback all unknown routes
    app.get([basePath, basePath + '/*path'], this.check.use, (req, res) => {
      // CDZ: upstream gates the mobile edition behind the canary namespace, so
      // on a STABLE self-host build this was always false and every phone was
      // served the full desktop bundle (3.63 MB over the wire, and a desktop
      // UI on a 5-inch screen). The self-host mobile build is already shipped
      // in the image at static/mobile/selfhost.html with publicPath '/', it
      // was simply never routed to. Serve it to mobile user-agents.
      //
      // Escape hatch: CDZ_MOBILE_WEB=0 restores the old behaviour (desktop
      // bundle for everyone) without needing a rebuild.
      const mobile =
        process.env.CDZ_MOBILE_WEB !== '0' &&
        isMobile({
          ua: req.headers['user-agent'] ?? undefined,
        });

      return res.sendFile(
        join(
          staticPath,
          mobile ? 'mobile' : '',
          env.selfhosted ? 'selfhost.html' : 'index.html'
        )
      );
    });
    // END REGION
  }
}
