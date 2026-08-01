# PostHog Analytics (ClickDz)

Product/user analytics for the ClickDz admin panel and app, wired end-to-end
(frontend + backend) and gated behind two env vars. When the env vars are
unset, **everything below is a complete no-op** — no bundle weight, no network
calls, no build breakage.

## Decision: hosted vs self-hosted

**Use PostHog Cloud (EU), not self-hosting.** Rationale:

- PostHog Cloud EU free tier gives 1 project, 1M product-analytics
  events/month, unlimited team members, and EU data residency (Frankfurt) —
  far more than ClickDz needs at launch, for $0 and zero ops.
- Self-hosting on Railway means running postgres + redis + clickhouse + kafka
  + zookeeper (the full PostHog stack) — the heaviest possible option, with
  ongoing maintenance, and PostHog itself recommends Cloud over self-hosting.
- The app already runs on Railway Pro; adding a 5-service analytics stack
  there is unnecessary when the managed free tier covers the use case.

If data residency / volume ever outgrows Cloud EU, the same two env vars point
at a self-hosted host — no code change needed.

## Env vars the user must set

| Var | Value | Where |
| --- | --- | --- |
| `CDZ_POSTHOG_KEY` | PostHog **project api key** (starts `phc_…`) | Backend (runtime) + frontend (build time) |
| `CDZ_POSTHOG_HOST` | `https://eu.i.posthog.com` (EU Cloud), `https://us.i.posthog.com`, or your self-hosted URL | Backend (runtime) + frontend (build time) |

- **Backend** reads `process.env.CDZ_POSTHOG_KEY/HOST` at **runtime** (Railway
  env vars on the server service). Mapped through the telemetry config module
  (`telemetry.posthog.key` / `telemetry.posthog.host`).
- **Frontend** `process.env.CDZ_*` is baked at **build time** (webpack
  DefinePlugin), so the vars must be present when the web/mobile bundle is
  built. Set the same values in the build environment.
- PostHog Cloud **signup is a user action in the PostHog console** — it cannot
  be automated. See "Getting your PostHog key" below.

## What fires

### Frontend (`packages/frontend/core/src/clickdz/posthog.ts`)

Lazy-loads `posthog-js` (dynamic import — nothing in the main bundle), gated on
both env vars. Events:

- `app_opened` — fired once per app boot (`bootstrap/telemetry.ts`).
- `$pageview` — per SPA route change (`desktop/pages/workspace/layouts/workspace-layout.tsx`).
- `identify(user.id, { email })` — on session restore / login, same layout.
- `image_generated` — AI image generation completed in the chat input
  (`blocksuite/ai/components/ai-chat-input/ai-chat-input.ts`).
- `app_provisioned` — an embedded app was provisioned for the user
  (`desktop/pages/workspace/shoperp/app-provision.ts`).
- `deck_generated` — exported from the module; SlidePro runs in an embedded
  iframe, so deck completion is observable server-side / via the provisioned
  app rather than in this bundle. The helper is ready to call wherever a deck
  completion signal lands.

### Backend (`packages/backend/server/src/core/telemetry/posthog-client.ts`)

Sends server-side events to PostHog's public capture API
(`POST {CDZ_POSTHOG_HOST}/batch/` with the project api key). Two paths:

1. **Telemetry pipeline** (`core/telemetry/service.ts`): every cleaned
   telemetry batch is mirrored to PostHog alongside GA4 (fire-and-forget —
   never blocks or fails the ack).
2. **Direct capture** (`createPostHogClientFromEnv().capture(...)`):
   - `user_provisioned_app` — `POST /api/v1/apps/provision` succeeded
     (`plugins/copilot/clickdz-app-provision.controller.ts`).
   - `generation_completed` (kind `image`) — `POST /api/v1/images/generations`
     succeeded (`plugins/copilot/clickdz-bridge.controller.ts`).

## `posthog-js` dependency

`posthog-js` is **not yet a dependency**. The frontend module dynamically
imports it inside try/catch, so the build and runtime both work without it and
capture stays a no-op. To activate the frontend half:

```bash
yarn workspace @affine/core add posthog-js
```

Then set `CDZ_POSTHOG_KEY` + `CDZ_POSTHOG_HOST` in the build environment and
rebuild. The backend half needs no new dependency (it uses plain `fetch`).

## Getting your PostHog key (user action)

1. Go to <https://posthog.com> and sign up (free) — **select the EU (Frankfurt)
   cloud** for EU data residency.
2. In the PostHog console, create/open your project.
3. Project settings → copy the **Project API key** (`phc_…`).
4. Set `CDZ_POSTHOG_KEY` to that key and `CDZ_POSTHOG_HOST` to
   `https://eu.i.posthog.com` on the backend service (and in the frontend build
   environment).

> Note: the project api key is **write-only** (capture only) — safe to embed in
> the frontend bundle. PostHog Cloud signup cannot be scripted; it's a console
> action the user performs once.
