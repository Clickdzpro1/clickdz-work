# CDZ Render

**The ClickDz Vdz Studio MP4 export service.** A small, standalone, headless-Chrome
render node: it turns a HeyGen HyperFrames HTML composition into an MP4 by
shelling out to the [`hyperframes`](https://www.npmjs.com/package/hyperframes)
CLI (Puppeteer seek-per-frame + FFmpeg encode) behind an authenticated,
in-memory job queue.

It is deployed as its **own** Railway service (like `cdz-ai/`) — its own
`package.json`, no monorepo workspace coupling. The ClickDz backend never calls
it directly from the browser; a session-authed proxy
(`/api/v1/vdz/render`, in `packages/backend/server/.../clickdz-vdz-render.controller.ts`)
forwards to it so the render token never reaches the frontend.

## API

All routes except `GET /health` require the header
`x-cdz-render-token: <CDZ_RENDER_TOKEN>` (constant-time compared).

| Method | Route | Body / Params | Response |
|---|---|---|---|
| `GET`  | `/health` | — | `{ ok, service, queued, running }` (no auth) |
| `POST` | `/render` | `{ kind:'html', html, fps?, width?, height? }` | `202 { jobId }` |
| `POST` | `/render` | `{ kind:'timeline', ... }` | `501 { error:'timeline engine arrives with remotion' }` |
| `GET`  | `/jobs/:id` | — | `{ status, progress, error?, size? }` |
| `GET`  | `/jobs/:id/file` | — | the MP4 (`video/mp4`), `404` until `status:'done'` |

- `status` ∈ `queued | rendering | done | error`; `progress` ∈ `0..1`.
- **Validation** (`POST /render`, `kind:'html'`): `html` must start with
  `<!DOCTYPE html>`, be ≤ **2 MB**, and declare a composition length ≤ **120 s**.
  Length is probed WITHOUT a browser by scanning `class="clip"` elements for
  `data-start + data-duration` (the same max-end formula the VDZ runtime uses); a
  composition with no timed clips is rejected. `fps` is coerced to one of
  `24/30/60` (default 30); `width`/`height` default to `1920×1080`, capped at 4K.
- The service injects `data-start="0"` on the root `data-composition-id` element
  when absent, so the hyperframes producer's root-duration probe resolves (our
  compositions drive playback via `document.getAnimations()` and omit it).
- **Files** live at `/tmp/renders/<id>.mp4` and are swept ~1 h after completion.
- **Queue**: in-memory FIFO, concurrency 1 by default (`CONCURRENCY` override),
  job TTL 1 h. Non-durable — a restart drops in-flight jobs (the client resubmits).

### Example

```bash
TOKEN=... ; BASE=https://cdz-render.up.railway.app

JOB=$(curl -s -X POST "$BASE/render" \
  -H "x-cdz-render-token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"html","html":"<!DOCTYPE html>...","fps":30}' | jq -r .jobId)

curl -s "$BASE/jobs/$JOB" -H "x-cdz-render-token: $TOKEN"        # {status,progress}
curl -s "$BASE/jobs/$JOB/file" -H "x-cdz-render-token: $TOKEN" -o out.mp4
```

## How it renders

`hyperframes` exposes **no programmatic API** — only a `bin` — so the CLI is the
integration surface. Per render the service:

1. writes the (validated) HTML into a fresh temp project dir as `index.html`;
2. runs `node node_modules/hyperframes/dist/cli.js render <dir> -o <id>.mp4 -f <fps> -q <quality> -w <workers>`;
3. records the output file size and marks the job `done`.

`render` takes a **project directory** (containing `index.html`), not a bare
file. Progress is coarse (`0.1` queued → `0.35` rendering → `1.0` done), nudged
by any `NN%` the CLI prints — `render` has no stable machine-readable progress
stream (its `--json` flag is for `lint`/other commands).

## Environment

| Var | Default | Purpose |
|---|---|---|
| `CDZ_RENDER_TOKEN` | — (**required**) | shared secret for `x-cdz-render-token`. Unset ⇒ every authed route 401s (fail closed). |
| `PORT` | `8787` | HTTP listen port. |
| `CONCURRENCY` | `1` | parallel renders. Each Chrome worker ≈ 256 MB; keep at 1 on a 2 GB node. |
| `CDZ_RENDER_QUALITY` | `standard` | hyperframes `-q`: `draft \| standard \| high`. |
| `CDZ_RENDER_WORKERS` | `auto` | hyperframes `-w`: parallel render workers per job. |
| `CDZ_RENDER_TIMEOUT_MS` | `480000` | hard wall-clock cap on one render subprocess. |
| `CDZ_RENDER_JOB_TTL_MS` | `3600000` | how long a finished job + file survive. |
| `CDZ_RENDER_SWEEP_MS` | `300000` | sweeper interval. |
| `CDZ_RENDERS_DIR` | `/tmp/renders` | where MP4s are written. |

Puppeteer/Chrome env (`PUPPETEER_EXECUTABLE_PATH`, `PRODUCER_HEADLESS_SHELL_PATH`,
`HYPERFRAMES_NO_AUTO_INSTALL`, `CONTAINER`) is set by the Dockerfile; you do not
set these on Railway.

The **backend proxy** reads two vars on the ClickDz server (not here):
`CDZ_RENDER_URL` (this service's public base URL) and `CDZ_RENDER_TOKEN` (same
value as above). When `CDZ_RENDER_URL` is unset the proxy returns a typed 400
("not configured") and the Export MP4 button degrades to "coming online soon".

## Resources

A render launches Chrome (≈256 MB/worker) plus FFmpeg. **Budget 2–4 GB RAM** for
the container. On a 2 GB node use `CONCURRENCY=1` and `CDZ_RENDER_WORKERS=2`.

## Deploy to Railway (new service)

1. **New service → Deploy from repo**, pick this monorepo.
2. **Settings → Root Directory:** `cdz-render`. Railway builds from the committed
   `Dockerfile` (it installs FFmpeg + `chrome-headless-shell` + `npm ci`).
   - If no `package-lock.json` is committed, the Dockerfile falls back to
     `npm install --omit=dev` automatically.
3. **Variables:** set `CDZ_RENDER_TOKEN` (a strong random secret). Leave `PORT`
   (Railway injects one; the server honors `$PORT`, default 8787). Optionally set
   `CONCURRENCY`, `CDZ_RENDER_QUALITY`, `CDZ_RENDER_WORKERS`.
4. **Resources:** raise the memory limit to ≥ 2 GB (4 GB for `high` quality / 1080p60).
5. **Health check path:** `/health`.
6. Note the service's public URL, then on the **ClickDz backend** service set
   `CDZ_RENDER_URL=<that URL>` and `CDZ_RENDER_TOKEN=<same secret>`. Redeploy the
   backend. The Export MP4 button lights up.

## P2b — the timeline engine (`kind:'timeline'`)

`POST /render` with `kind:'timeline'` currently returns `501`. The next PR adds a
Remotion-based engine that renders a `VdzTimeline` JSON
(`packages/frontend/core/src/modules/vdz/schema.ts`) directly — real video/audio
clips, transitions, trims — rather than a single self-contained HTML document.
Planned shape:

- accept `{ kind:'timeline', timeline: VdzTimeline }`, validate against the same
  duration/size caps, hydrate a Remotion composition from the timeline, and
  render via `@remotion/renderer` (its own Chrome + FFmpeg path);
- keep the identical `{jobId}` / `/jobs/:id` / `/jobs/:id/file` contract and the
  same queue, auth, and sweeper — only the render backend differs by `kind`;
- media fetching for `video`/`audio`/`image` clip `src`s will reuse the SSRF
  guard pattern from `cdz-ai/guards.mjs` (public-host allowlist).

The HTML engine in this PR stays as-is; `kind` selects the backend.
