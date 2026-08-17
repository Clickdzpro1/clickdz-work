FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
# Decode the full .env from AFFINE_ENV_B64, then start the server.
# Key: listen on $PORT (Vercel injects this for containers), not a hardcoded port.
# Redis is not available in Vercel containers — set it to fail-fast (the server's
# Redis error handler logs + continues; PG is the source of truth since Phase 0).
CMD ["sh", "-c", "if [ -n \"$AFFINE_ENV_B64\" ]; then echo $AFFINE_ENV_B64 | base64 -d > /app/.env; fi && export AFFINE_SERVER_PORT=${PORT:-3010} && export REDIS_SERVER_HOST=${REDIS_SERVER_HOST:-localhost} && node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
