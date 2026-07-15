/**
 * CDZ Render — the ClickDz Vdz Studio MP4 export service.
 *
 * One lean server, one real dependency (`hyperframes`):
 *   - POST /render        {kind:'html', html, fps?, width?, height?} -> {jobId}
 *   - GET  /jobs/:id      -> {status, progress, error?, size?}
 *   - GET  /jobs/:id/file -> streams the finished MP4 (video/mp4)
 *   - POST /render        {kind:'timeline', ...}  -> 501 (arrives with remotion)
 *   - GET  /health        -> {ok:true} (the ONLY unauthenticated route)
 *
 * HOW IT RENDERS
 * The compositions are HeyGen HyperFrames HTML documents (a root element with
 * `data-composition-id`, timed `.clip` elements carrying data-start /
 * data-duration, animation via CSS / the Web Animations API — seekable through
 * `document.getAnimations()`). That is exactly what `hyperframes render`
 * consumes, so this service is a thin, authenticated, queued wrapper around the
 * hyperframes CLI: it writes the document into a temp project dir as index.html,
 * shells out to `hyperframes render <dir> -o <id>.mp4`, and serves the result.
 * `hyperframes` has NO programmatic API (its package.json exposes only a `bin`),
 * so the CLI is the integration surface by necessity, not choice.
 *
 * ZERO web deps on purpose — mirrors the sibling cdz-ai service (node:http,
 * built-in fetch, .mjs, "type":"module"). The heavy lifting (Chrome + FFmpeg)
 * is provided by the container, not by npm packages we author.
 *
 * RAM: a render launches Chrome; budget 2–4 GB for the container (see Dockerfile).
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  rmSync,
  statSync,
  existsSync,
} from 'node:fs';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT || 8787);
// Auth token — REQUIRED. No token configured => the service refuses every
// authenticated route (fail closed), exactly like cdz-ai with no API keys.
const RENDER_TOKEN = String(process.env.CDZ_RENDER_TOKEN || '');
// Queue concurrency. 1 by default: a single render already saturates a small
// box (each Chrome worker ~256 MB). Override with CONCURRENCY for bigger nodes.
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 1));
// Finished-file + job time-to-live. Swept hourly.
const JOB_TTL_MS = Number(process.env.CDZ_RENDER_JOB_TTL_MS || 60 * 60 * 1000);
const SWEEP_INTERVAL_MS = Number(
  process.env.CDZ_RENDER_SWEEP_MS || 5 * 60 * 1000
);
// Hard wall-clock cap on a single render subprocess.
const RENDER_TIMEOUT_MS = Number(
  process.env.CDZ_RENDER_TIMEOUT_MS || 8 * 60 * 1000
);
// Render tuning, forwarded to the hyperframes CLI.
const RENDER_QUALITY = String(process.env.CDZ_RENDER_QUALITY || 'standard');
const RENDER_WORKERS = String(process.env.CDZ_RENDER_WORKERS || 'auto');

// ---- validation bounds (mirror the backend proxy's caps) ----
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_DURATION_S = 120; // composition length cap
const DEFAULT_FPS = 30;
const ALLOWED_FPS = new Set([24, 30, 60]);
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const MAX_DIMENSION = 3840; // 4K per side ceiling

// Where finished MP4s live. Kept flat so the sweeper is trivial.
const RENDERS_DIR = process.env.CDZ_RENDERS_DIR || join(tmpdir(), 'renders');
mkdirSync(RENDERS_DIR, { recursive: true });

// ---------------------------------------------------------------- http helpers
// (byte-for-byte the cdz-ai stance: permissive CORS, JSON envelopes, a body
// reader that hangs up on oversized payloads.)
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

function err(res, status, message, type = 'invalid_request_error') {
  json(res, status, { error: { message, type } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      // Guard BEFORE we buffer the whole thing: 2 MB is the composition ceiling.
      if (data.length > MAX_HTML_BYTES + 4096) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Constant-time bearer check on the x-cdz-render-token header. Fail closed when
 * no token is configured. timingSafeEqual needs equal-length buffers, so we
 * length-check first (the length itself is not a secret) then compare.
 */
function authorized(req) {
  if (!RENDER_TOKEN) return false;
  const got = String(req.headers['x-cdz-render-token'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(RENDER_TOKEN);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- validation
function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Probe a composition's length WITHOUT a browser: scan every `class="clip"`
 * element for data-start + data-duration and take the max end — the exact
 * formula VDZ_RUNTIME and the hyperframes runtime use. Returns 0 when the
 * document declares no timed clips (an empty composition, which we reject).
 *
 * This is a text scan, not a DOM parse (no deps): find each element that has
 * BOTH data-start and data-duration and is tagged class="clip". We over-match
 * slightly on purpose — any element carrying those attributes counts toward the
 * length — which is safe for a cap check (we never under-estimate duration).
 */
function probeDurationSeconds(html) {
  let max = 0;
  // Match an opening tag that contains data-start and data-duration anywhere.
  const tagRe = /<[a-zA-Z][^>]*\bdata-start\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    const start = Number(tag.match(/\bdata-start\s*=\s*["']?(-?[\d.]+)/)?.[1]);
    const dur = Number(tag.match(/\bdata-duration\s*=\s*["']?(-?[\d.]+)/)?.[1]);
    if (Number.isFinite(start) && Number.isFinite(dur)) {
      const end = start + dur;
      if (end > max) max = end;
    }
  }
  return Math.round(max * 1000) / 1000;
}

/**
 * Prepare the root composition element for the hyperframes producer.
 *
 * Our compositions (authored by clickdz-vdz-video-prompt) drive playback purely
 * through document.getAnimations() and do NOT register window.__timelines or
 * annotate the root with timing. The producer, absent a __timelines entry,
 * resolves the composition's LENGTH from the root element's `data-duration`
 * (and needs `data-start` to begin at 0). Verified empirically: with a root
 * `data-duration="N"` the producer reports staticDuration:N and renders N
 * seconds; without it staticDuration is 0 and the render yields nothing usable.
 *
 * So we inject onto the `data-composition-id` element (when absent):
 *   · data-start="0"           — begin playback at t=0
 *   · data-duration="<probed>" — the max clip end we already computed
 *
 * The producer still seeks every CSS/WAAPI animation via document.getAnimations()
 * per frame (the same primitive VDZ_RUNTIME uses), so motion renders faithfully.
 * The `missing_timeline_registry` lint is a WARNING only — the CLI continues the
 * render unless `--strict` is passed (we never pass it). Idempotent: an existing
 * data-start / data-duration on the root is left untouched.
 */
function prepareRoot(html, durationSeconds) {
  const rootRe = /<([a-zA-Z][\w-]*)\b([^>]*\bdata-composition-id\b[^>]*?)(\/?)>/;
  const m = html.match(rootRe);
  if (!m) return html;
  let attrs = m[2];
  if (!/\bdata-start\b/.test(attrs)) attrs += ' data-start="0"';
  if (!/\bdata-duration\b/.test(attrs)) {
    attrs += ` data-duration="${durationSeconds}"`;
  }
  return html.replace(m[0], `<${m[1]}${attrs}${m[3]}>`);
}

/**
 * Validate + normalize a /render {kind:'html'} body. Throws a 400 (invalid())
 * on any breach; returns the sanitized job spec on success.
 */
function validateHtmlJob(body) {
  const html = typeof body?.html === 'string' ? body.html : '';
  if (!html) throw invalid('"html" is required');
  // Byte length, not char length — the cap is about payload size.
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw invalid('composition HTML is too large (max 2MB)');
  }
  if (!/^\s*<!doctype html/i.test(html)) {
    throw invalid('composition must be a full HTML document starting with <!DOCTYPE html>');
  }

  const duration = probeDurationSeconds(html);
  if (duration <= 0) {
    throw invalid(
      'composition has no timed clips (need class="clip" with data-start + data-duration)'
    );
  }
  if (duration > MAX_DURATION_S) {
    throw invalid(`composition is too long (${duration}s; max ${MAX_DURATION_S}s)`);
  }

  let fps = Number(body?.fps ?? DEFAULT_FPS);
  if (!ALLOWED_FPS.has(fps)) fps = DEFAULT_FPS;

  const width = clampDim(body?.width, DEFAULT_WIDTH);
  const height = clampDim(body?.height, DEFAULT_HEIGHT);

  return {
    html: prepareRoot(html, duration),
    fps,
    width,
    height,
    duration,
  };
}

function clampDim(value, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_DIMENSION);
}

// ---------------------------------------------------------------- job store
/**
 * In-memory job registry. Each job:
 *   { id, status, progress, error?, size?, spec, outPath, createdAt, doneAt? }
 * status: 'queued' | 'rendering' | 'done' | 'error'
 * This is deliberately non-durable: a restart drops in-flight jobs (the client
 * re-submits). The service is one Railway node; there is no shared queue here.
 */
const jobs = new Map();
const queue = []; // FIFO of jobIds awaiting a render slot
let running = 0;

function publicJob(j) {
  return {
    status: j.status,
    progress: j.progress,
    ...(j.error ? { error: j.error } : {}),
    ...(typeof j.size === 'number' ? { size: j.size } : {}),
  };
}

function enqueue(spec) {
  const id = randomUUID();
  const job = {
    id,
    status: 'queued',
    progress: 0.1,
    spec,
    outPath: join(RENDERS_DIR, `${id}.mp4`),
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  queue.push(id);
  pump();
  return id;
}

/** Start as many queued jobs as the concurrency budget allows. */
function pump() {
  while (running < CONCURRENCY && queue.length > 0) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    running++;
    runRender(job)
      .catch(e => {
        job.status = 'error';
        job.error = e?.message || 'render failed';
      })
      .finally(() => {
        running--;
        job.doneAt = Date.now();
        pump();
      });
  }
}

/**
 * Render one job: stage the composition into a temp project dir as index.html,
 * shell out to the hyperframes CLI, and record the resulting file size. Progress
 * is coarse — the CLI does not emit a stable machine-readable percentage on
 * stdout for `render` (its --json flag is for lint/other commands), so we move
 * 0.1 (queued) -> 0.35 (rendering) and parse any "NN%" the CLI prints as a
 * best-effort refinement, landing on 1.0 when the file is on disk.
 */
async function runRender(job) {
  job.status = 'rendering';
  job.progress = 0.35;

  const projectDir = await mkdtemp(join(tmpdir(), 'cdz-render-'));
  try {
    await writeFile(join(projectDir, 'index.html'), job.spec.html, 'utf8');

    await runHyperframes(projectDir, job);

    if (!existsSync(job.outPath)) {
      throw new Error('render produced no output file');
    }
    job.size = statSync(job.outPath).size;
    job.status = 'done';
    job.progress = 1;
  } finally {
    // Drop the staging dir; the MP4 lives in RENDERS_DIR and is swept later.
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Spawn `hyperframes render <projectDir> -o <out.mp4> ...`. Resolves on exit 0,
 * rejects with a trimmed tail of stderr otherwise. Enforces RENDER_TIMEOUT_MS.
 * We invoke the local dependency's bin directly (node ./node_modules/... /cli.js)
 * so there is no network `npx` fetch at runtime.
 */
function runHyperframes(projectDir, job) {
  return new Promise((resolve, reject) => {
    const cliPath = new URL(
      './node_modules/hyperframes/dist/cli.js',
      import.meta.url
    ).pathname;

    const args = [
      cliPath,
      'render',
      projectDir,
      '-o',
      job.outPath,
      '-f',
      String(job.spec.fps),
      '-q',
      RENDER_QUALITY,
      '-w',
      RENDER_WORKERS,
    ];

    const child = spawn(process.execPath, args, {
      cwd: projectDir,
      env: {
        ...process.env,
        HYPERFRAMES_NO_UPDATE_CHECK: '1',
        HYPERFRAMES_NO_TELEMETRY: '1',
        // Never attempt a runtime browser download from a locked-down box; the
        // container installs chrome-headless-shell at build time (see Dockerfile).
        HYPERFRAMES_NO_AUTO_INSTALL: process.env.HYPERFRAMES_NO_AUTO_INSTALL ?? '1',
        CONTAINER: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrTail = '';
    const onChunk = buf => {
      const s = buf.toString();
      // Best-effort progress: nudge upward on any "NN%" the CLI prints.
      const pct = s.match(/(\d{1,3})\s*%/);
      if (pct) {
        const p = Math.min(99, Number(pct[1])) / 100;
        // Map 0..1 CLI progress into our 0.35..0.99 rendering band.
        job.progress = Math.max(job.progress, 0.35 + p * 0.64);
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', buf => {
      onChunk(buf);
      stderrTail = (stderrTail + buf.toString()).slice(-4000);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`render timed out after ${RENDER_TIMEOUT_MS}ms`));
    }, RENDER_TIMEOUT_MS);

    child.on('error', e => {
      clearTimeout(timer);
      reject(new Error(`failed to start renderer: ${e.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(
        new Error(
          `renderer exited ${code}${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-3).join(' ')}` : ''}`
        )
      );
    });
  });
}

// ---------------------------------------------------------------- sweeper
/** Drop finished/errored jobs + their files past the TTL. */
function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const age = now - (job.doneAt || job.createdAt);
    const terminal = job.status === 'done' || job.status === 'error';
    if (terminal && age > JOB_TTL_MS) {
      try {
        rmSync(job.outPath, { force: true });
      } catch {
        /* file already gone */
      }
      jobs.delete(id);
    }
  }
}
setInterval(sweep, SWEEP_INTERVAL_MS).unref();

// ---------------------------------------------------------------- routing
async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-cdz-render-token',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    // The ONLY unauthenticated route — Railway health checks hit this.
    if (path === '/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        service: 'cdz-render',
        queued: queue.length,
        running,
      });
    }

    if (!authorized(req)) {
      return err(res, 401, 'Missing or invalid render token', 'authentication_error');
    }

    // POST /render
    if (path === '/render' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const kind = body?.kind || 'html';

      if (kind === 'timeline') {
        // Documented stub — the timeline engine (VdzTimeline JSON -> video)
        // arrives in a later PR with the remotion renderer.
        return err(res, 501, 'timeline engine arrives with remotion', 'not_implemented');
      }
      if (kind !== 'html') {
        return err(res, 400, `unsupported kind: ${kind}`);
      }

      const spec = validateHtmlJob(body);
      const jobId = enqueue(spec);
      return json(res, 202, { jobId });
    }

    // GET /jobs/:id  and  GET /jobs/:id/file
    const jobMatch = path.match(/^\/jobs\/([^/]+)(\/file)?$/);
    if (jobMatch && req.method === 'GET') {
      const id = decodeURIComponent(jobMatch[1]);
      const wantFile = !!jobMatch[2];
      const job = jobs.get(id);
      if (!job) return err(res, 404, `unknown job: ${id}`);

      if (!wantFile) {
        return json(res, 200, publicJob(job));
      }

      // /file — stream the MP4, 404 until the render is done.
      if (job.status !== 'done' || !existsSync(job.outPath)) {
        return err(res, 404, 'render not ready', 'not_ready');
      }
      const size = statSync(job.outPath).size;
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(size),
        'Content-Disposition': `attachment; filename="${id}.mp4"`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, max-age=3600',
      });
      const stream = createReadStream(job.outPath);
      stream.on('error', () => {
        if (!res.headersSent) err(res, 500, 'failed to read render');
        else res.destroy();
      });
      return stream.pipe(res);
    }

    return err(res, 404, `No route: ${req.method} ${path}`);
  } catch (e) {
    // Never let one bad request take the process down (cdz-ai stance).
    const status = e?.status || (e?.message === 'body too large' ? 413 : 500);
    if (!res.headersSent) {
      err(res, status, e?.message || 'internal server error', status >= 500 ? 'api_error' : 'invalid_request_error');
    } else {
      try {
        res.end();
      } catch {
        /* socket already gone */
      }
    }
  }
}

const server = http.createServer(requestHandler);

// ---------------------------------------------------------------- guards
// Process-level safety net (identical rationale to cdz-ai): a stray rejection
// or uncaught throw must not kill the render node.
process.on('unhandledRejection', reason => {
  console.error('[cdz-render] unhandledRejection:', reason);
});
process.on('uncaughtException', e => {
  console.error('[cdz-render] uncaughtException:', e?.stack || e);
});

server.listen(PORT, () => {
  console.log(
    `[cdz-render] listening on :${PORT} (concurrency ${CONCURRENCY}, renders in ${RENDERS_DIR})` +
      (RENDER_TOKEN ? '' : ' — WARNING: CDZ_RENDER_TOKEN unset, all authed routes will 401')
  );
});
