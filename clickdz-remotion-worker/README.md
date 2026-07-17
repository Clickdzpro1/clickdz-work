# clickdz-remotion-worker

The **Remotion tier** of ClickDz Vdz Studio's MP4 export — a standalone service
that renders a self-contained **render manifest** into an MP4 with **real
per-frame video and a real audio mix**, the fidelity the existing headless-Chrome
HTML tier (`cdz-render/`) cannot reach.

This directory is **NOT** part of the main app's build. It lives at the repo root
(outside every `workspaces` glob in the root `package.json`, exactly like
`cdz-render/`), has its own `package.json` + lockfile, and deploys as its own
Railway service. Nothing in `packages/**` depends on it.

---

## Why a second render tier

The current export path compiles a timeline to a seekable HTML document and hands
it to `cdz-render` (headless Chrome + FFmpeg). That tier is honest about two hard
limits (see `packages/frontend/core/src/modules/vdz/compile-timeline.ts`):

1. **Video is poster-only.** A real `<video>` element does not frame-step under
   the WAAPI scrubber the host drives, so video clips render as a still first
   frame.
2. **There is no audio.** MP4 audio mixing is a Remotion-tier capability.

This worker closes both gaps. It receives a **`VdzRenderManifest`** — a
deterministic, fully-resolved JSON spec built by
`packages/frontend/core/src/modules/vdz/remotion/render-manifest.ts` — and maps
it 1:1 onto a Remotion composition:

- `<Sequence>` per clip, positioned by resolved frame timings;
- **real `<OffthreadVideo>`** with `trimStartInFrames` + per-clip volume;
- **`<Audio>`** with per-frame gain envelopes: fade in/out **and** ducking
  (music dips under a `duck` voiceover);
- transitions (`fade` / `slide` / `wipe` / `dissolve` / `push` / `iris`),
  effects (incl. the `vignette` overlay), caption chrome, and per-word **karaoke**
  — all mirroring the app's `anim.ts` curves so a rendered frame matches the
  preview at the same playhead.

The manifest is **self-contained**: the worker needs no access to the app, the
workspace blob store, or the preview. Media srcs are resolved to loadable URLs
before the manifest is sent (the worker CAN fetch over the network, unlike the
offline HTML tier).

---

## HTTP contract

Identical to `cdz-render`'s async job model, so the app's
`ClickDzVdzRenderController` proxies to it with no shape changes:

| Method | Path              | Body / Result                                   |
| ------ | ----------------- | ----------------------------------------------- |
| POST   | `/render`         | `{ manifest }` → `{ jobId }`                    |
| GET    | `/jobs/:id`       | `{ status, progress, error? }`                  |
| GET    | `/jobs/:id/file`  | streams the finished MP4 (`video/mp4`)          |
| GET    | `/healthz`        | `{ ok, bundleReady, active, queued }`           |

`status` is one of `queued` \| `rendering` \| `done` \| `error`; `progress` is
`0..1`. When `CDZ_REMOTION_TOKEN` is set, every route (except `/healthz`)
requires `Authorization: Bearer <token>` — the controller sends exactly that.

---

## Environment variables

| Var                  | Required | Default | Purpose                                             |
| -------------------- | -------- | ------- | --------------------------------------------------- |
| `PORT`               | no       | `8787`  | Listen port.                                        |
| `CDZ_REMOTION_TOKEN` | prod     | —       | Bearer token the app must present. Set it in prod.  |
| `CONCURRENCY`        | no       | `1`     | Concurrent renders. Budget 2–4 GB RAM per render.   |
| `RENDER_TIMEOUT_MS`  | no       | `600000`| Per-render ceiling.                                 |

---

## Deploy (Railway)

1. **New service** from this repo, root directory `clickdz-remotion-worker/`,
   Dockerfile build (the provided `Dockerfile` installs Chrome deps + FFmpeg +
   fonts and ensures Remotion's browser at build time).
2. Set env: **`CDZ_REMOTION_TOKEN`** (a long random string) and, if the node has
   ≥4 GB, optionally raise `CONCURRENCY`.
3. Note the service's public URL (e.g. `https://clickdz-remotion.up.railway.app`).
4. **On the APP service (`packages/backend/server`)** set:
   - `CDZ_REMOTION_URL` = the worker URL from step 3
   - `CDZ_REMOTION_TOKEN` = the same token from step 2

That is the entire wiring. Until `CDZ_REMOTION_URL` is set on the app, the
Remotion path is completely inert and the existing HTML export is unchanged.

### Opt-in from the client

The app only routes to this worker when a request **opts in** — the export hook
sends `engine: 'remotion'` + the built `manifest` when the local flag
`cdz:remotion-opt-in` is set (see
`packages/frontend/core/src/modules/vdz/use-vdz-timeline-export.ts`). No user
sees a behavior change until both the env var is set AND they opt in.

---

## Lockfile note

Like `cdz-render/`, commit a `package-lock.json` so the Docker build uses
`npm ci` for reproducible installs. Generate it once locally:

```bash
cd clickdz-remotion-worker
npm install            # writes package-lock.json
npm run build          # tsc → dist/
```

**Do not loosen the Remotion version pins.** Remotion requires `remotion` and
every `@remotion/*` package to be the exact same version; the `package.json`
pins them all to `4.0.490` with no `^`.

---

## Local development

```bash
npm install
npm run studio         # Remotion Studio preview (uses the placeholder manifest)
npm run dev            # build + start the HTTP server on :8787
```

Smoke-test the server with a manifest built by the app's `buildRenderManifest`:

```bash
curl -s -X POST localhost:8787/render \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $CDZ_REMOTION_TOKEN" \
  -d '{"manifest": <paste a VdzRenderManifest JSON here>}'
# → {"jobId":"..."}  then poll GET /jobs/:id and GET /jobs/:id/file
```

---

## Files

- `src/manifest.ts` — the `RenderManifest` type (mirrors the app's
  `VdzRenderManifest`) + a dependency-free validator.
- `src/anim.ts` — pure frame-domain port of the app's `anim.ts` (transition /
  effect / animation / karaoke math).
- `src/VideoComposition.tsx` — the composition mapping the manifest 1:1.
- `src/Root.tsx` — registers the `VdzVideo` composition; dimensions/fps/duration
  come from the manifest via `calculateMetadata`.
- `src/index.ts` — Remotion `registerRoot` entry (what the bundler bundles).
- `src/server.ts` — the Express service (bundle once, render per job, stream).
