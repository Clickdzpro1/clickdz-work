# syntax=docker/dockerfile:1.7

# Stage 0: Pull existing canary image to reuse static web/admin/mobile assets.
# The monorepo frontend CI is broken (Setup Node.js failure on web/admin builds),
# but the last working canary image already has valid /app/static/*.
FROM ghcr.io/clickdzpro1/clickdz-work:canary AS static-assets

# Stage 1: Build new backend from canary source.
FROM node:22-bookworm-slim AS assets
WORKDIR /app

COPY ./packages/backend/server /app
# Static files come from the last working canary image, not from CI.
COPY --from=static-assets /app/static /app/static

# Keep server sourcemap for stacktraces, but don't ship frontend/node_modules sourcemaps.
ARG TARGETARCH
ARG TARGETVARIANT
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

RUN AFFINE_DOCKER_CLEAN=1 TARGETARCH="${TARGETARCH}" TARGETVARIANT="${TARGETVARIANT}" node ./scripts/docker-clean.mjs

FROM node:22-bookworm-slim
WORKDIR /app

COPY --from=assets /app /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl libjemalloc2 && rm -rf /var/lib/apt/lists/*

ENV LD_PRELOAD=libjemalloc.so.2

EXPOSE 3010

CMD ["sh", "-c", "node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]