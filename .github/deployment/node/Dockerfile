# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS assets
WORKDIR /app

COPY ./packages/backend/server /app
COPY ./packages/frontend/apps/web/dist /app/static
COPY ./packages/frontend/admin/dist /app/static/admin
COPY ./packages/frontend/apps/mobile/dist /app/static/mobile

# Keep server sourcemap for stacktraces, but don't ship frontend/node_modules sourcemaps.
ARG TARGETARCH
ARG TARGETVARIANT
# Needed for Prisma engine resolution (and potential engine download during cleanup).
RUN apt-get update && \
  apt-get install -y --no-install-recommends openssl ca-certificates && \
  rm -rf /var/lib/apt/lists/*

RUN AFFINE_DOCKER_CLEAN=1 TARGETARCH="${TARGETARCH}" TARGETVARIANT="${TARGETVARIANT}" node ./scripts/docker-clean.mjs

FROM node:22-bookworm-slim
WORKDIR /app

COPY --from=assets /app /app

RUN apt-get update && \
  apt-get install -y --no-install-recommends openssl libjemalloc2 && \
  rm -rf /var/lib/apt/lists/*

# Enable jemalloc by preloading the library
ENV LD_PRELOAD=libjemalloc.so.2

EXPOSE 3010

# Run the CDZ provider bootstrap before the server on every boot: it syncs
# the copilot provider profiles on the config volume from env vars
# (CDZ_AI_KEY / CDZ_AI_BASE_URL / OPENAI_IMAGE_API_KEY). It is idempotent
# and fail-safe (never blocks boot); `;` not `&&` so the server always
# starts, and `exec` keeps node as PID 1 for proper signal handling.
# NOTE: any platform-level custom start command overrides this CMD and
# silently disables the bootstrap — leave the start command unset.
CMD ["sh", "-c", "node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
