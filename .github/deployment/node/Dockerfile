# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS assets
WORKDIR /app

COPY ./packages/backend/server /app
COPY ./packages/frontend/apps/web/dist /app/static
COPY ./packages/frontend/admin/dist /app/static/admin
COPY ./packages/frontend/apps/mobile/dist /app/static/mobile

ARG TARGETARCH
ARG TARGETVARIANT
RUN apt-get update && \
  apt-get install -y --no-install-recommends openssl ca-certificates && \
  rm -rf /var/lib/apt/lists/*

RUN AFFINE_DOCKER_CLEAN=1 TARGETARCH="${TARGETARCH}" TARGETVARIANT="${TARGETVARIANT}" node ./scripts/docker-clean.mjs

# Patch graphql-upload: v17 has no barrel export, bare imports fail on Node 22.
# The bundled dist/main.js imports bare "graphql-upload". This adds a "." export.
RUN node -e "var p=JSON.parse(require('fs').readFileSync('node_modules/graphql-upload/package.json','utf8'));p.exports['.']={import:'./graphqlUploadExpress.mjs',require:'./graphqlUploadExpress.mjs',default:'./graphqlUploadExpress.mjs'};require('fs').writeFileSync('node_modules/graphql-upload/package.json',JSON.stringify(p));console.log('patched graphql-upload')"

FROM node:22-bookworm-slim
WORKDIR /app

COPY --from=assets /app /app

RUN apt-get update && \
  apt-get install -y --no-install-recommends openssl libjemalloc2 && \
  rm -rf /var/lib/apt/lists/*

ENV LD_PRELOAD=libjemalloc.so.2

EXPOSE 3010

CMD ["sh", "-c", "node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
