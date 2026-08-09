import { Logger } from '@nestjs/common';

/**
 * PostHog deploy-boot event helper (ClickDz).
 *
 * Sends a single `deploy_boot` event to PostHog when the NestJS server starts
 * on Railway (or any container platform). This gives cross-platform deploy
 * analytics visibility alongside the GitHub Actions build events
 * (`deploy_build_started`, `deploy_build_succeeded`, `deploy_build_failed`).
 *
 * Uses only Node.js built-in `fetch` (Node 22+) — no PostHog SDK dependency.
 * Configured entirely by env vars:
 *
 *   CDZ_POSTHOG_KEY   — PostHog project API key (`phc_…`)
 *   CDZ_POSTHOG_HOST  — e.g. https://us.i.posthog.com
 *   BASE_IMAGE        — the Docker image tag Railway is running (set by Railway env)
 *
 * FAIL-SAFE: if CDZ_POSTHOG_KEY / CDZ_POSTHOG_HOST are unset, or the network
 * request fails for any reason, the function logs a warning and returns. It
 * NEVER throws and NEVER blocks server startup.
 *
 * Usage (in server.ts after `app.listen`):
 *   notifyPostHogDeployBoot().catch(() => {});
 */
const logger = new Logger('PostHogDeployEvent');

export async function notifyPostHogDeployBoot(): Promise<void> {
  const apiKey = process.env.CDZ_POSTHOG_KEY;
  const host = process.env.CDZ_POSTHOG_HOST;

  if (!apiKey || !host) {
    // PostHog not configured — skip silently (not a warning, this is expected
    // in local dev and self-hosted without PostHog).
    return;
  }

  const properties: Record<string, string> = {
    source: 'railway',
    base_image: process.env.BASE_IMAGE ?? 'unknown',
    data_version: env?.version ?? 'unknown',
    boot_timestamp: new Date().toISOString(),
    deployment_type: env?.DEPLOYMENT_TYPE ?? 'unknown',
    namespace: env?.NAMESPACE ?? 'unknown',
  };

  const payload = {
    api_key: apiKey,
    event: 'deploy_boot',
    distinct_id: 'clickdz-work-server',
    properties,
  };

  try {
    const captureUrl = `${host.endsWith('/') ? host.slice(0, -1) : host}/capture`;
    const response = await fetch(captureUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn(
        `PostHog deploy_boot event failed: ${response.status} ${body || 'unknown error'}`
      );
      return;
    }

    logger.log(
      `PostHog deploy_boot event sent (base_image=${properties.base_image})`
    );
  } catch (error) {
    // NEVER let PostHog issues crash the server — just log and move on.
    logger.warn(
      `PostHog deploy_boot event error: ${(error as Error)?.message ?? 'unknown error'}`
    );
  }
}

/**
 * VERCEL DEPLOY WEBHOOK — FUTURE APPROACH (not yet implemented)
 *
 * Vercel projects for ClickDz (clickdz-work-hub, clickdz-app-shop-*,
 * humanizily, etc.) deploy independently. To capture Vercel deploy events in
 * PostHog, there are two approaches:
 *
 * 1. Vercel Deploy Hook → Backend receiver endpoint:
 *    - Create a Vercel deploy webhook (project settings → webhooks) that
 *      POSTs to a new backend route e.g. POST /api/v1/integrations/vercel-deploy
 *    - The receiver validates the Vercel webhook signature, extracts the
 *      deployment state (READY/ERROR/Building), project name, and URL, then
 *      fires a PostHog `vercel_deploy` event with properties:
 *        { source: 'vercel', project, state, url, inspector_url }
 *    - Requires adding a controller route + signature validation — more
 *      complex than the Railway boot event, deferred for now.
 *
 * 2. Vercel API polling (simpler, less real-time):
 *    - A cron job on the backend calls Vercel's GET /v6/deployments endpoint
 *      every N minutes, compares against the last-seen deployment, and fires
 *      a PostHog event for new deployments.
 *    - Uses VERCEL_TOKEN env var (already set as Railway secret).
 *
 * Neither is implemented here. When ready, create a new controller in
 * packages/backend/server/src/plugins/copilot/ for the webhook receiver,
 * or add a @Cron() job to an existing service for the polling approach.
 */
