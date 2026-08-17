# DzOS deploy: wraps the pre-built ghcr image for Vercel container deploys.
# The image's CMD (node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js)
# is inherited — don't override it.
FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
