FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
# Decode full .env, then set Redis to a non-routable IP (fails fast, error handler logs but doesn't crash)
# + disable indexer (BullMQ). ERP API works without Redis.
CMD ["sh", "-c", "if [ -n \"$AFFINE_ENV_B64\" ]; then echo $AFFINE_ENV_B64 | base64 -d > /app/.env; fi && export AFFINE_SERVER_PORT=${PORT:-3010} && export REDIS_SERVER_HOST=192.0.2.1 && export REDIS_SERVER_PORT=6379 && export AFFINE_INDEXER_ENABLED=false && node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
