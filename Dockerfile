# DzOS deploy: wraps the AFFiNE server Dockerfile for Vercel container deploys.
# The AFFiNE server Dockerfile expects pre-built frontend assets in
# packages/frontend/apps/web/dist etc. — those are built by the GitHub Actions
# CI pipeline (build-clickdz-image.yml) and published as artifacts, NOT in the
# repo. For a Vercel container deploy, we build them inline.
#
# Since the full monorepo build is too heavy for Vercel's build timeout,
# this Dockerfile pulls the pre-built server bundle + static assets from the
# GitHub Container Registry image (built by CI).
FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
CMD ["node", "dist/index.js"]
