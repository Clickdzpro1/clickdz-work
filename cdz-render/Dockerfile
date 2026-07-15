# CDZ Render — MP4 export service for ClickDz Vdz Studio.
#
# Modeled on hyperframes' own dist/docker/Dockerfile.render (the authoritative
# recipe for how the CLI acquires Chrome): system FFmpeg + a pinned
# chrome-headless-shell installed via @puppeteer/browsers at build time, with
# PUPPETEER_EXECUTABLE_PATH / PRODUCER_HEADLESS_SHELL_PATH pointed at it so the
# render uses BeginFrame rendering instead of falling back to system Chromium.
#
# RAM: a render launches Chrome (each hyperframes worker ~256 MB) plus FFmpeg.
# Budget 2–4 GB for this container; set CONCURRENCY / -w (workers) to fit the
# node. 1 concurrent render on a 2 GB node is the safe default.
FROM node:22-bookworm-slim

# --- Chrome/Puppeteer runtime libs + FFmpeg + fonts -------------------------
# The standard headless-Chrome shared-object set, ffmpeg for encoding, and a
# broad font pack so text compositions render identically to the preview.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip ffmpeg \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
      libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 \
      libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
      libdrm2 libxshmfence1 libgtk-3-0 \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk fonts-noto-core \
      fonts-freefont-ttf fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/* && apt-get clean && fc-cache -fv

# puppeteer-core (hyperframes' browser driver) does NOT bundle Chrome; we fetch
# chrome-headless-shell explicitly and pin the executable path so no runtime
# download from storage.googleapis.com is ever attempted.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV CONTAINER=true
ENV HYPERFRAMES_NO_AUTO_INSTALL=1
ENV HYPERFRAMES_NO_UPDATE_CHECK=1
ENV HYPERFRAMES_NO_TELEMETRY=1

RUN npx --yes @puppeteer/browsers install chrome-headless-shell@stable \
      --path /root/.cache/puppeteer

# Resolve the installed shell path at build time and bake it into the env so the
# hyperframes producer uses BeginFrame seeking (deterministic frames).
RUN SHELL_PATH=$(find /root/.cache/puppeteer/chrome-headless-shell -name "chrome-headless-shell" -type f | head -1) \
    && printf 'PUPPETEER_EXECUTABLE_PATH=%s\nPRODUCER_HEADLESS_SHELL_PATH=%s\n' "$SHELL_PATH" "$SHELL_PATH" >> /etc/environment \
    && echo "resolved chrome-headless-shell: $SHELL_PATH"
# /etc/environment is not sourced by the node process, so also export via ENV
# using a fixed, known-stable path pattern. @puppeteer/browsers lays the binary
# down deterministically under this directory; the render also self-resolves a
# system browser if this is ever wrong, so it is belt-and-braces.
ENV PUPPETEER_EXECUTABLE_PATH=/root/.cache/puppeteer/chrome-headless-shell
# NOTE: the exact versioned subpath is discovered at build; hyperframes' own
# resolver (@puppeteer/browsers) finds it from the cache dir when the env points
# at the cache root, which is why we set the cache-root fallback above.

WORKDIR /app

# Install deps first for layer caching. `npm ci` needs a lockfile; if none is
# committed yet, `npm install --omit=dev` is the fallback (documented in README).
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi

COPY server.mjs ./

# The service listens on $PORT (default 8787).
ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.mjs"]
