FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
# Just start the server directly on $PORT. Vercel container health checks
# wait up to 60s by default — the AFFiNE server boots in ~15s.
# Redis set to non-routable IP (fails fast, error handler logs, no crash).
# Indexer disabled (uses BullMQ which needs Redis).
CMD ["sh", "-c", "if [ -n \"$AFFINE_ENV_B64\" ]; then echo $AFFINE_ENV_B64 | base64 -d > /app/.env; fi && export AFFINE_SERVER_PORT=${PORT:-3010} && export REDIS_SERVER_HOST=192.0.2.1 && export REDIS_SERVER_PORT=6379 && export AFFINE_INDEXER_ENABLED=false && node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
