FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
CMD ["sh", "-c", "if [ -n \"$AFFINE_ENV_B64\" ]; then echo $AFFINE_ENV_B64 | base64 -d > /app/.env; fi && export AFFINE_SERVER_PORT=${PORT:-3010} && node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
