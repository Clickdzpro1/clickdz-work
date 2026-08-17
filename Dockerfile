# DzOS deploy: wraps the pre-built ghcr image for Vercel container deploys.
# At startup, decode AFFINE_ENV_B64 (base64 .env file) → write to /app/.env
# so the server's prelude.ts (dotenv) loads all the config.
FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
CMD ["sh", "-c", "if [ -n \"$AFFINE_ENV_B64\" ]; then echo $AFFINE_ENV_B64 | base64 -d > /app/.env; fi && node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
