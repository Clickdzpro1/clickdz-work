/**
 * clickdz-remotion-worker — the HTTP service.
 *
 * Speaks the SAME async job contract as cdz-render (so the app's
 * ClickDzVdzRenderController proxies to it unchanged, once CDZ_REMOTION_URL is
 * set):
 *   · POST /render          {manifest}  -> {jobId}
 *   · GET  /jobs/:id                     -> {status, progress, ...}
 *   · GET  /jobs/:id/file                -> streams the finished MP4 (video/mp4)
 *   · GET  /healthz                      -> {ok:true} (liveness)
 *
 * AUTH. When CDZ_REMOTION_TOKEN is set every route requires
 * `Authorization: Bearer <token>` (the controller sends exactly that). Unset →
 * open (dev only; set the token in prod).
 *
 * RENDER MODEL. The Remotion bundle is built ONCE at startup (reused for every
 * render, parametrized by inputProps.manifest). Each POST enqueues a job that
 * `selectComposition` + `renderMedia` into a temp mp4; the client polls status,
 * then streams the file. Concurrency is bounded (CONCURRENCY, default 1) because
 * each render launches Chrome + FFmpeg (budget 2–4 GB per concurrent render).
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import express from 'express';

import { parseManifest, type RenderManifest } from './manifest';

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.CDZ_REMOTION_TOKEN || '';
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 1));
// A render can be long; guard against a stuck composition (delayRender etc.).
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 10 * 60_000);
// Cap a manifest payload (mirrors the app proxy's 4 MB edge cap).
const MAX_BODY = '8mb';
// The composition id registered in src/Root.tsx.
const COMPOSITION_ID = 'VdzVideo';

// --- Render-speed tuning (all env-gated, safe defaults) ---------------------
// jpegQuality: frame-capture quality. 70 is noticeably faster than the Remotion
// default ~80 with only a minor perceptual tradeoff (these are intermediate
// frames, not the final encode).
const JPEG_QUALITY = Number(process.env.REMOTION_JPEG_QUALITY || 70);
// crf: h264 constant rate factor. 28 is a good speed/size/quality balance; the
// Remotion default (~18-20) is slow and produces very large files. Raise for
// smaller/faster, lower for higher fidelity.
const CRF = Number(process.env.REMOTION_CRF || 28);
// offthreadVideoThreads: worker threads for <OffthreadVideo> frame extraction.
// 2 is a sane default for a small node; raise for video-heavy compositions.
const OFFTHREAD_THREADS = Number(process.env.REMOTION_OFFTHREAD_THREADS || 2);
// Per-render frame concurrency. `null` lets Remotion auto-size to the host CPUs
// (1-2 on a small Railway node = slow). Set REMOTION_CONCURRENCY to override.
const RENDER_CONCURRENCY = process.env.REMOTION_CONCURRENCY
  ? Number(process.env.REMOTION_CONCURRENCY)
  : null;
// Multi-process Chrome on Linux spreads frame capture across processes (faster
// on multi-core). Default ON; set CDZ_REMOTION_MULTIPROC=0 to disable.
const MULTIPROC = process.env.CDZ_REMOTION_MULTIPROC !== '0';

type JobStatus = 'queued' | 'rendering' | 'done' | 'error';
/**
 * The coarse render phase, exposed (additively) on the GET /jobs/:id body so the
 * frontend can label what is happening instead of a bare progress bar. Remotion's
 * `renderMedia` folds bundling + frame capture + stitching into one call, so we
 * split it at the two observable boundaries we control: `bundling` before
 * `selectComposition`, `rendering` once `renderMedia` is driving the frames.
 */
type JobStage = 'bundling' | 'rendering';
interface Job {
  id: string;
  status: JobStatus;
  progress: number;
  outputPath: string;
  error?: string;
  createdAt: number;
  // ADDITIVE (see the GET /jobs/:id serializer): the coarse phase + the wall-clock
  // moment the render started, so the FE can compute an ETA from progress + elapsed.
  stage: JobStage;
  startedAt: number;
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
let active = 0;

// The Remotion bundle serve url, built once at startup (see bootstrap()).
let serveUrl: string | null = null;
let bundleError: string | null = null;

// Working dir for rendered mp4s (cleaned per job after it is fetched or ages out).
const WORK_DIR = path.join(tmpdir(), 'clickdz-remotion');

/** Build the Remotion bundle once; retriable if the first attempt fails. */
async function bootstrapBundle(): Promise<void> {
  try {
    const entryPoint = path.resolve(__dirname, 'index.js');
    // In the built image src is compiled to dist/*.js; the entry is index.js
    // beside this file. `require.resolve`-style path keeps it robust.
    serveUrl = await bundle({
      entryPoint: existsSync(entryPoint)
        ? entryPoint
        : path.resolve(__dirname, 'index.ts'),
      webpackOverride: config => config,
    });
    bundleError = null;
    // eslint-disable-next-line no-console
    console.log('[remotion-worker] bundle ready:', serveUrl);
  } catch (e) {
    bundleError = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error('[remotion-worker] bundle failed:', bundleError);
  }
}

/** Render one job to its output mp4, updating progress + stage as it goes. */
async function runJob(job: Job, manifest: RenderManifest): Promise<void> {
  if (!serveUrl) {
    throw new Error(bundleError || 'Remotion bundle is not ready');
  }
  const inputProps = { manifest };
  // selectComposition loads the bundle + measures the composition (duration,
  // dimensions) — that is the "bundling" phase the FE labels distinctly from
  // the per-frame render below.
  job.stage = 'bundling';
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps,
  });

  job.stage = 'rendering';
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: job.outputPath,
    inputProps,
    // Env-overridable: null → Remotion auto-sizes to host CPUs; a number pins it.
    concurrency: RENDER_CONCURRENCY,
    timeoutInMilliseconds: RENDER_TIMEOUT_MS,
    onProgress: ({ progress }) => {
      job.progress = Math.max(0, Math.min(1, progress));
    },
    // --- Speed/quality tuning (env-gated, see the consts above) ---
    imageFormat: 'jpeg', // the fast default — explicit so a future Remotion
    // change to png never silently slows renders.
    jpegQuality: JPEG_QUALITY,
    crf: CRF,
    offthreadVideoThreads: OFFTHREAD_THREADS,
    // Multi-process Chrome spreads frame capture across cores on Linux. Gated
    // off by CDZ_REMOTION_MULTIPROC=0 (e.g. on a 1-core node where the extra
    // process overhead is pure cost).
    ...(MULTIPROC
      ? { chromiumOptions: { enableMultiProcessOnLinux: true } }
      : {}),
  });
}

/** Pump the queue up to CONCURRENCY concurrent renders. */
function pump(): void {
  while (active < CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!;
    const job = jobs.get(id);
    if (!job) continue;
    const manifest = pendingManifests.get(id);
    pendingManifests.delete(id);
    if (!manifest) continue;
    active++;
    job.status = 'rendering';
    job.startedAt = Date.now();
    runJob(job, manifest)
      .then(() => {
        job.status = 'done';
        job.progress = 1;
      })
      .catch(e => {
        job.status = 'error';
        job.error = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.error(`[remotion-worker] job ${id} failed:`, job.error);
      })
      .finally(() => {
        active--;
        pump();
      });
  }
}

// Manifests waiting for their job to be pumped (kept out of the Job so the
// status payload stays small).
const pendingManifests = new Map<string, RenderManifest>();

const app = express();
app.use(express.json({ limit: MAX_BODY }));

/** Bearer-token gate (no-op when TOKEN is unset). */
app.use((req, res, next) => {
  if (!TOKEN) return next();
  if (req.path === '/healthz') return next();
  const auth = req.header('authorization') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (provided !== TOKEN) {
    res.status(401).json({ error: { message: 'unauthorized' } });
    return;
  }
  next();
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, bundleReady: !!serveUrl, active, queued: queue.length });
});

/** POST /render — validate the manifest, enqueue a job, return the id. */
app.post('/render', async (req, res) => {
  const body = req.body as { manifest?: unknown };
  let manifest: RenderManifest;
  try {
    manifest = parseManifest(body?.manifest);
  } catch (e) {
    res
      .status(400)
      .json({ error: { message: e instanceof Error ? e.message : 'bad manifest' } });
    return;
  }
  if (!serveUrl && bundleError) {
    // Bundle never built — surface as a provider-side error the proxy relays.
    res.status(503).json({ error: { message: `worker not ready: ${bundleError}` } });
    return;
  }

  await mkdir(WORK_DIR, { recursive: true });
  const id = randomUUID();
  const now = Date.now();
  const job: Job = {
    id,
    status: 'queued',
    progress: 0,
    outputPath: path.join(WORK_DIR, `${id}.mp4`),
    createdAt: now,
    // `startedAt` is set when the render actually begins (in pump); `stage`
    // begins at bundling and flips to rendering once renderMedia takes over.
    stage: 'bundling',
    startedAt: now,
  };
  jobs.set(id, job);
  pendingManifests.set(id, manifest);
  queue.push(id);
  pump();
  res.json({ jobId: id });
});

/** GET /jobs/:id — job status + progress. */
app.get('/jobs/:id', (req, res) => {
  const job = jobs.get(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: { message: 'unknown job' } });
    return;
  }
  res.json({
    status: job.status,
    progress: job.progress,
    // ADDITIVE: the coarse render phase + the wall-clock render start, so the FE
    // can label the stage and compute an ETA. Older clients ignore both.
    stage: job.stage,
    startedAt: job.startedAt,
    ...(job.error ? { error: job.error } : {}),
  });
});

/** GET /jobs/:id/file — stream the finished mp4. */
app.get('/jobs/:id/file', async (req, res) => {
  const job = jobs.get(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: { message: 'unknown job' } });
    return;
  }
  if (job.status === 'error') {
    res.status(500).json({ error: { message: job.error || 'render failed' } });
    return;
  }
  if (job.status !== 'done' || !existsSync(job.outputPath)) {
    // Not ready — a 404 the client polls around (matches cdz-render).
    res.status(404).json({ error: { message: 'render not ready' } });
    return;
  }
  try {
    const info = await stat(job.outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(info.size));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="vdz-video-${job.id}.mp4"`
    );
    const stream = createReadStream(job.outputPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  } catch (e) {
    res
      .status(500)
      .json({ error: { message: e instanceof Error ? e.message : 'stream failed' } });
  }
});

// Periodic cleanup: drop finished jobs + their files after an hour so the temp
// dir does not grow unbounded on a long-lived worker.
const JOB_TTL_MS = 60 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
      pendingManifests.delete(id);
      void rm(job.outputPath, { force: true }).catch(() => {});
    }
  }
}, 10 * 60_000).unref();

async function bootstrap(): Promise<void> {
  await mkdir(WORK_DIR, { recursive: true });
  // Build the bundle in the background so the server accepts connections
  // immediately (POST /render returns 503 until the bundle is ready).
  void bootstrapBundle();
  const server = createServer(app);
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[remotion-worker] listening on :${PORT} (concurrency ${CONCURRENCY})`);
  });
}

void bootstrap();
