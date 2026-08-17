FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
# Decode full .env from AFFINE_ENV_B64, then override Redis (no Redis in Vercel container)
# + disable the indexer (uses BullMQ which needs Redis). The ERP API works without Redis.
CMD ["sh", "-c", "if [ -n \"$AFFINE_ENV_B64\" ]; then echo $AFFINE_ENV_B64 | base64 -d > /app/.env; fi && export AFFINE_SERVER_PORT=${PORT:-3010} && export REDIS_SERVER_HOST= && export REDIS_SERVER_PORT= && export AFFINE_INDEXER_ENABLED=false && node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
