# clickdz-remotion-worker — Remotion MP4 render worker for ClickDz Vdz Studio.
#
# Renders a VdzRenderManifest to MP4 via @remotion/renderer (headless Chrome +
# FFmpeg, both managed by Remotion). Modeled on the sibling cdz-render/
# Dockerfile but for the Remotion tier: same Linux shared-object set + broad font
# pack so text/captions render identically to the app preview, then Remotion's
# own Chrome Headless Shell is ensured at build time so no download happens at
# request time.
#
# RAM: each concurrent render launches Chrome (~256 MB+) plus FFmpeg. Budget
# 2–4 GB for this container and set CONCURRENCY to fit the node (1 on a 2 GB
# node is the safe default).
FROM node:22-bookworm-slim

# --- Chrome/Remotion runtime libs + FFmpeg + fonts --------------------------
# The standard headless-Chrome shared-object set (per Remotion's Linux deps),
# ffmpeg, and a broad font pack so captions match the preview.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip ffmpeg \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
      libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 \
      libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
      libdrm2 libxshmfence1 libgtk-3-0 libxext6 libx11-6 \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk fonts-noto-core \
      fonts-freefont-ttf fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/* && apt-get clean && fc-cache -fv

WORKDIR /app

# Install deps first for layer caching. `npm ci` needs a lockfile; if none is
# committed yet, `npm install` is the fallback (documented in README). Remotion
# pins REQUIRE all remotion/@remotion/* at the SAME exact version (see
# package.json) — do NOT loosen them.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

# Ensure Remotion's Chrome Headless Shell is present at BUILD time so the first
# render does not pay a runtime download. `npx remotion browser ensure` installs
# the browser Remotion's renderer expects into its own cache.
RUN npx --yes remotion browser ensure || echo "browser ensure deferred to runtime"

# Build the TypeScript worker (src → dist) and the Remotion entry.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# The service listens on $PORT (default 8787). Set CDZ_REMOTION_TOKEN in prod so
# the app is the only caller; set CONCURRENCY to fit the node's RAM.
ENV PORT=8787
ENV CONCURRENCY=1
EXPOSE 8787

CMD ["node", "dist/server.js"]
