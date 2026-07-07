# ClickDz Work — backend deploy kit (work.clickdz.ai)

The ClickDz Work server is the ClickDz Work Community Edition stack, rebranded:
one Node container (GraphQL API + WebSocket sync + background jobs, serves
the web app itself) + PostgreSQL **with pgvector** + Redis + a blob volume.
It cannot run as serverless functions (persistent WebSockets + workers) —
it needs one always-on container. Everything else can live in managed
services.

## 0. Build the image (once, then per release)

GitHub → Actions → **"Build ClickDz Work server image"** → Run workflow.
Produces `ghcr.io/clickdzpro1/clickdz-work:stable` (+ `:stable-<sha>`).
No secrets needed — CI pushes with its own GITHUB_TOKEN.

> **Gotcha (first build only):** GHCR packages start PRIVATE. After the
> first push: github.com/Clickdzpro1 → Packages → `clickdz-work` →
> Package settings → Change visibility → **Public**. Otherwise the host
> can't pull the image.

## Path A — Railway (recommended: managed, agent-drivable via API)

Monthly cost roughly $10–20 for a small team.

1. **Postgres = Supabase via the Vercel Marketplace** (keeps billing/env in
   your Vercel Pro dashboard): Vercel → Storage/Marketplace → Supabase →
   create project.
   - Supabase dashboard → Database → Extensions → enable **vector**.
   - Copy the **Session pooler** connection string (port **5432** on the
     pooler host — NOT the transaction pooler on 6543; Prisma migrations
     need session semantics, and the session pooler is IPv4-friendly).
   - That string = `DATABASE_URL`.
2. **Railway**: New Project →
   - Service 1: **Redis** (template). Note its private host/port/password.
   - Service 2: **Deploy Docker image** → `ghcr.io/clickdzpro1/clickdz-work:stable`.
   - Attach a **Volume** to service 2, mount path `/root/.ClickDz Work`
     (covers blob storage + config).
   - Service 2 → Settings → Deploy → **Custom start command**:
     `sh -c "node ./scripts/self-host-predeploy.js && node ./dist/main.js"`
     (runs DB migrations before boot — replaces the compose migration job).
   - Networking → Generate domain, then add custom domain
     `work.clickdz.ai` (Railway shows the CNAME target).
3. **Env vars on service 2** (Railway → Variables):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Supabase session-pooler string |
   | `REDIS_SERVER_HOST` | Railway Redis private host |
   | `REDIS_SERVER_PORT` | Railway Redis port |
   | `REDIS_SERVER_PASSWORD` | Railway Redis password |
   | `AFFINE_SERVER_HTTPS` | `true` |
   | `AFFINE_SERVER_HOST` | `work.clickdz.ai` |
   | `AFFINE_INDEXER_ENABLED` | `false` |
   | `COPILOT_OPENAI_API_KEY` | your OpenAI key (owner-only entry) |
   | `COPILOT_FAL_API_KEY` (opt) | AI image generation |
   | `COPILOT_EXA_API_KEY` (opt) | AI web search grounding |

4. **DNS**: add the CNAME for `work.clickdz.ai` → Railway domain target.

> Upstash Redis (Vercel Marketplace) instead of Railway Redis is possible
> but requires TLS, which the server only supports via the config file
> (`/root/.ClickDz Work/config/config.json` → `redis.ioredis: { "tls": {} }`),
> not env vars. Railway-internal Redis is simpler and cheaper.

## Path B — Any VPS with Docker

```
mkdir -p /opt/clickdz-work && cd /opt/clickdz-work
# copy deploy/selfhost/compose.yml and .env.template here
cp .env.template .env   # fill values, generate a strong DB password
docker compose up -d
```

Put a reverse proxy (Caddy: `work.clickdz.ai { reverse_proxy :3010 }`) in
front for TLS, or use the host panel's proxy. This path self-hosts
Postgres+pgvector and Redis in the same compose — no external services.

## First boot checklist

1. `https://work.clickdz.ai` loads the ClickDz Work web app (branded).
2. Sign up — the FIRST account created becomes the server admin.
3. Admin panel: `https://work.clickdz.ai/admin` — server name should read
   "ClickDz Work" (from `deploy/config/config.json` if mounted).
4. Create a doc on two devices → real-time sync works (WebSocket OK).
5. Open the AI sidebar → ask something → answer streams (OpenAI key OK).
6. Upload an image into a doc → persists after container restart (volume OK).

## Cost + secrets policy

- Supabase (via Vercel): free tier to start; upgrade as data grows.
- Railway: ~$10–20/mo (container + Redis + volume).
- OpenAI: pay-per-use on your key. Set a usage limit in the OpenAI console.
- Secrets (`DATABASE_URL`, `COPILOT_OPENAI_API_KEY`, SMTP) live ONLY in the
  host's env manager (Railway Variables / VPS `.env`). Never in git, never
  in chat, never in docs.

## What's deliberately NOT enabled

- ClickDz Work Enterprise features (EE license requires a paid subscription —
  this stack is Community Edition, MIT/MPL).
- Telemetry: endpoints point at our own domain; no analytics tokens are
  baked into builds.
