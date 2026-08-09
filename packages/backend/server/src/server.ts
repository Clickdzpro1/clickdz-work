import { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import graphqlUploadExpress from 'graphql-upload/graphqlUploadExpress.mjs';

import {
  AFFiNELogger,
  buildCorsAllowedOrigins,
  CacheInterceptor,
  CloudThrottlerGuard,
  Config,
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  CORS_EXPOSED_HEADERS,
  corsOriginCallback,
  GlobalExceptionFilter,
  URLHelper,
} from './base';
import { SocketIoAdapter } from './base/websocket';
import { AuthGuard } from './core/auth';
import { notifyPostHogDeployBoot } from './core/telemetry/posthog-deploy-event';
import { TelemetryService } from './core/telemetry/service';
import { securityHeaders } from './middleware/security-headers';
import { serverTimingAndCache } from './middleware/timing';

const OneMB = 1024 * 1024;

// In production, suppress VERBOSE and DEBUG logs to stay under Railway's
// 500 logs/sec rate limit. NestJS LogLevel order: verbose > debug > log >
// warn > error > fatal. Keeping [log, warn, error, fatal] drops the two
// noisiest levels; all operational messages and errors are preserved.
//
// BOOT-FLOOD FIX (2026-08-01): the `log` level is the one that sinks boot.
// JobHandlerScanner (scanner.ts:75) + EventHandlerScanner emit one `log` line
// PER registered handler — hundreds in a burst during NestFactory.create().
// At 500+ lines/sec Railway drops messages AND the process burns CPU building
// strings (CLS request-id lookup per line), so module init crawls past the
// healthcheck window and `app.listen` never runs → "replicas never became
// healthy". Default prod to ['warn','error','fatal'] (boot stays fast + quiet);
// set AFFINE_VERBOSE_BOOT=1 to restore 'log' when you need the registration
// trace for debugging.
const PROD_LOG_LEVELS: LogLevel[] =
  process.env.AFFINE_VERBOSE_BOOT === '1'
    ? ['log', 'warn', 'error', 'fatal']
    : ['warn', 'error', 'fatal'];

export async function run() {
  const { AppModule } = await import('./app.module');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: false,
    rawBody: true,
    bodyParser: true,
    // DIAGNOSTIC (2026-07-30): keep this false. With buffering ON, every log
    // emitted during NestFactory.create() is held in memory until
    // app.useLogger() runs below — so a HANG during module initialization
    // yields a container with ZERO output. That is exactly how the 2026-07-29
    // deploy failures presented: container starts, cdz-ai-config writes its
    // config, then nothing binds the port, healthcheck reports "service
    // unavailable" 11x over 5m, and no error surfaces anywhere. Unbuffered
    // costs some log volume but makes bootstrap progress observable.
    bufferLogs: false,
    // Pass log levels to NestFactory.create() so ALL NestJS loggers (including
    // child loggers created with `new Logger(ServiceName)`) respect the level
    // filter — not just the root AFFiNELogger instance. Setting logLevels on
    // the instance alone only filters the root; child loggers maintain their
    // own levels. This is the documented NestJS approach for global log-level
    // control.
    logger: env.prod ? PROD_LOG_LEVELS : undefined,
  });

  app.useBodyParser('raw', { limit: 100 * OneMB });
  // WS1 PR4 (and the long-suspected timeline-export 413): Nest's default
  // express json limit is ~100KB, which chokes (a) base64 reference images
  // sent to the CDZIMAGE image-to-image route and (b) the Vdz timeline MP4
  // export's inlined-media HTML (~1.4MB budget). Raise json to a sane
  // app-wide ceiling; raw stays 100MB for byte uploads.
  app.useBodyParser('json', { limit: 20 * OneMB });

  const logger = app.get(AFFiNELogger);
  app.useLogger(logger);
  // CDZ perf/cost fix: passing `logger: PROD_LOG_LEVELS` to NestFactory.create()
  // above is NOT sufficient. `useLogger(instance)` REPLACES the level-filtered
  // logger with this AFFiNELogger instance, and AFFiNELogger extends
  // ConsoleLogger and is provided with no levels — so ConsoleLogger's default
  // (every level, including verbose and debug) wins and production floods.
  //
  // Observed effect: VERBOSE/DEBUG for every cron job on a 30s cycle, against
  // Railway's 500 logs/sec ceiling, burning CPU on message building and CLS
  // request-id lookups per line and burying real errors.
  //
  // Re-apply the filter to the instance that actually does the logging.
  if (env.prod) {
    logger.setLogLevels(PROD_LOG_LEVELS);
  }
  const config = app.get(Config);
  const url = app.get(URLHelper);
  let telemetry: TelemetryService | null = null;
  try {
    telemetry = app.get(TelemetryService, { strict: false });
  } catch {
    telemetry = null;
  }

  const defaultAllowedOrigins = buildCorsAllowedOrigins(url);

  app.enableCors((req, callback) => {
    const requestPath = req.path ?? req.url ?? '';
    const appendedOrigins = telemetry?.getAllowedOrigins(requestPath) ?? [];
    const finalAllowedOrigins = appendedOrigins.length
      ? new Set([...defaultAllowedOrigins, ...appendedOrigins])
      : defaultAllowedOrigins;

    callback(null, {
      origin: (origin, originCallback) => {
        corsOriginCallback(
          origin,
          finalAllowedOrigins,
          blockedOrigin => {
            if (!appendedOrigins.length) {
              logger.warn(
                `Blocked CORS request from origin: ${blockedOrigin}`,
                { requestPath }
              );
            }
          },
          originCallback
        );
      },
      credentials: true,
      methods: CORS_ALLOWED_METHODS,
      allowedHeaders: CORS_ALLOWED_HEADERS,
      exposedHeaders: CORS_EXPOSED_HEADERS,
      maxAge: 86400,
      optionsSuccessStatus: 204,
    });
  });

  if (config.server.path) {
    app.setGlobalPrefix(config.server.path);
  }

  app.use(serverTimingAndCache);
  // SEC-6: baseline security headers (CSP / HSTS / XFO / nosniff), env-gated —
  // see middleware/security-headers.ts for the exact policy + escape hatches.
  app.use(securityHeaders);

  app.use(
    graphqlUploadExpress({
      maxFileSize: 100 * OneMB,
      maxFiles: 32,
    })
  );

  app.useGlobalGuards(app.get(AuthGuard), app.get(CloudThrottlerGuard));
  app.useGlobalInterceptors(app.get(CacheInterceptor));
  app.useGlobalFilters(new GlobalExceptionFilter(app.getHttpAdapter()));
  app.use(cookieParser());
  // only enable shutdown hooks in production
  // https://docs.nestjs.com/fundamentals/lifecycle-events#application-shutdown
  if (env.prod) {
    app.enableShutdownHooks();
  }

  const adapter = new SocketIoAdapter(app);
  app.useWebSocketAdapter(adapter);

  if (env.dev) {
    const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
    // Swagger API Docs
    const docConfig = new DocumentBuilder()
      .setTitle('AFFiNE API')
      .setDescription(`AFFiNE Server ${env.version} API documentation`)
      .setVersion(`${env.version}`)
      .build();
    const documentFactory = () => SwaggerModule.createDocument(app, docConfig);
    SwaggerModule.setup('/api/docs', app, documentFactory, {
      useGlobalPrefix: true,
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(config.server.port, config.server.listenAddr);

  // PostHog deploy analytics — fire a `deploy_boot` event once when the server
  // starts on Railway (or any platform). Fail-safe: never blocks or crashes
  // the server if PostHog is unreachable or env vars are missing.
  notifyPostHogDeployBoot().catch(() => {});

  const formattedAddr = config.server.listenAddr.includes(':')
    ? `[${config.server.listenAddr}]`
    : config.server.listenAddr;

  logger.log(`AFFiNE Server is running in [${env.DEPLOYMENT_TYPE}] mode`);
  logger.log(`Listening on http://${formattedAddr}:${config.server.port}`);
  logger.log(`And the public server should be recognized as ${url.baseUrl}`);
}

