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

# Patch graphql-upload v17: no barrel export on Node 22 — add "." export + named export
RUN node -e "
var f = require('fs');
var m = 'node_modules/graphql-upload/graphqlUploadExpress.mjs';
var s = f.readFileSync(m, 'utf8');
if (!s.includes('export const graphqlUploadExpress')) {
  s = s.replace('export default', 'const _g=') + '\nexport const graphqlUploadExpress=_g;\nexport default _g;\n';
  f.writeFileSync(m, s);
  var p = JSON.parse(f.readFileSync('node_modules/graphql-upload/package.json', 'utf8'));
  p.exports['.'] = { import: './graphqlUploadExpress.mjs', default: './graphqlUploadExpress.mjs' };
  f.writeFileSync('node_modules/graphql-upload/package.json', JSON.stringify(p));
  console.log('[fix] patched graphql-upload');
}
"

FROM node:22-bookworm-slim
WORKDIR /app

COPY --from=assets /app /app

RUN apt-get update && \
  apt-get install -y --no-install-recommends openssl libjemalloc2 && \
  rm -rf /var/lib/apt/lists/*

ENV LD_PRELOAD=libjemalloc.so.2

EXPOSE 3010

CMD ["sh", "-c", "node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
