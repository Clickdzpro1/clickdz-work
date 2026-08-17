FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
# Decode the full .env from AFFINE_ENV_B64 (base64) into /app/.env, then start.
# The server's prelude.ts loads .env via dotenv. Also set PORT=3010 explicitly
# (Vercel containers may inject PORT=8080 which the server doesn't read).
CMD ["sh", "-c", "if [ -n \"$AFFINE_ENV_B64\" ]; then echo $AFFINE_ENV_B64 | base64 -d > /app/.env; fi && export PORT=3010 && export AFFINE_SERVER_PORT=3010 && node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
