// ClickDz OPENCLAW — autonomous, STREAMING, multi-turn coding agent (WS12).
//
// WS11 shipped a one-shot POST /run: a cdz-flash plan→act loop that wrote whole
// files + ran commands inside a Vercel Sandbox microVM that was torn down in a
// per-request finally. WS12 upgrades this into a real agent console:
//
//   - POST /api/v1/openclaw/stream (SSE, contract C1/C6): resolve/create a
//     THREAD, ensure a PERSISTENT sandbox bound to that thread (reuse the
//     session across turns — extend its timeout when still running, recreate it
//     only when it died), then stream the plan→act loop live: `file`+`artifact`
//     on each write, live `terminal` deltas + `step`(exitCode) on each run, a
//     `preview`(starting→ready) when the task spins up a dev server on port
//     3000, and finally the natural-language answer streamed token-by-token
//     (cdz-flash stream:true) before a persisted `final` turn. The sandbox is
//     NEVER stopped here — persistence is the whole point; it lives on the
//     thread and is only released on thread delete or its own idle expiry.
//   - POST /api/v1/openclaw/stop — cooperative stop flag (checked each turn).
//   - GET/PATCH/DELETE threads; DELETE best-effort stops the thread's sandbox.
//   - GET threads/:id/files + threads/:id/file?path= — file tree + editor read
//     straight from the live microVM (SANDBOX2.listFiles / readFile).
//
// Kept verbatim: legacy POST /run (unchanged behaviour — one-shot, ephemeral
// session, still stopped in its own finally) and GET /capabilities (now with
// streaming:true).
//
// Cross-imports (contract): ClickDzAgentRuntime + the AgentEvent/AgentStep/
// AgentMessage/AgentThread types live in ./clickdz-agent-runtime (RUNTIME owns
// them); the sandbox side effects go through ./clickdz-vercel-sandbox (SANDBOX2
// owns the REST plumbing + reads VERCEL_TOKEN/VERCEL_TEAM_ID itself and never
// surfaces key material). Neither resolves in an isolated single-file build —
// that's expected; this file is coded to the exact contract signatures.
//
// Error idiom (see base/nestjs/exception.ts mapAnyError): a raw HttpException is
// coerced to a generic 500 by the global filter, so custom-status bodies here
// (502 {error:'planner_unavailable'}) are written directly via the injected
// Express Response (@Res()), and typed errors (BadRequest/NotFound) from
// ../../base cover genuinely malformed input / missing threads. INSIDE an
// already-open SSE stream we NEVER throw — we emit {type:'error'} + done and end
// the stream cleanly. NEVER log key material.

import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

// WS14/C5: `Cache` is the @Global JSON-wrapped Redis provider (get<T>/set with a
// PX ttl — fail-soft, never throws) — the SAME provider ClickDzAgentRuntime uses
// for thread persistence. The per-user agent config singleton is persisted
// through it, mirroring that Pattern-B idiom.
import { BadRequest, Cache, NotFound, Throttle } from '../../base';
import { CacheRedis } from '../../base/redis';
import {
  registerAgentLoop,
  type AgentLoopContext,
  type AgentRunRecord,
} from './clickdz-agent-runs';

const CDZ_AGENTS_ENABLED = process.env.CDZ_AGENTS_ENABLED === '1';
import { CurrentUser } from '../../core/auth';
// RUNTIME (contract C3): the shared agent runtime — SSE writer, Redis-backed
// threads, cooperative stop registry — plus the wire types (C1/C2). HERMESB2
// and CLAWB2 both inject this service.
import { ClickDzAgentRuntime } from './clickdz-agent-runtime';
import type {
  AgentEvent,
  AgentMessage,
  AgentStep,
  AgentThread,
} from './clickdz-agent-runtime';
// SANDBOX2 (contract C4): the dep-free Vercel Sandbox client. Legacy /run uses
// the original five functions; the streaming console adds the persistent-session
// + preview + file + streaming functions. All are defensive; the token is never
// logged or returned.
import {
  createSession,
  createSessionWithPorts,
  describeSandboxError,
  extendSession,
  getPreviewUrl,
  listFiles,
  readFile,
  runCommand,
  runCommandBackground,
  runCommandStreaming,
  sandboxHealthProbe,
  sandboxCapability,
  sessionStatus,
  stopSession,
  writeFile,
  SandboxError,
} from './clickdz-vercel-sandbox';
import type { SandboxFailure } from './clickdz-vercel-sandbox';

// --- CDZ_AI planner envs — EXACT normalization copied from
// clickdz-integrations.controller.ts (the WS10 /v1-double-suffix fix). Prod
// sets CDZ_AI_BASE_URL WITH a trailing `/v1` (the copilot provider bootstrap
// default is `https://api.clickdz.ai/v1`); stripping a trailing `/v1` (and any
// trailing slashes) keeps the origin clean whether the operator set it WITH or
// WITHOUT `/v1`, then the single canonical path below is appended in exactly
// one place. The replace() chain never crashes at import. ---
// WS14: the Vercel AI Gateway — the same env pair the bridge reads (the
// legacy CDZ_AI_BASE_URL/CDZ_AI_KEY api.clickdz.ai pair is deliberately
// not read; a legacy key fails Gateway auth looking like a model error).
const CDZ_AI_BASE_URL = (process.env.CDZ_AI_GATEWAY_BASE || 'https://ai-gateway.vercel.sh')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '')
  .replace(/\/+$/, '');
const CDZ_AI_KEY =
  process.env.CDZ_AI_GATEWAY_KEY || process.env.CUSTOM_LLM_API_KEY || '';
// WS14 default: the Gateway single chat model. NOTE: an explicit
// CDZ_PLANNER_MODEL env override still wins — unset any legacy value.
const CDZ_PLANNER_MODEL = process.env.CDZ_PLANNER_MODEL || 'zai/glm-4.6v-flash';
const CDZ_PLANNER_PATH = '/v1/chat/completions';
const CDZ_PLANNER_URL = `${CDZ_AI_BASE_URL}${CDZ_PLANNER_PATH}`;

// --- /run budgets (AbortControllers everywhere; every per-call timeout is
// clamped by the remaining wall clock) ---
// Per planner turn — codegen turns emit whole files, so more headroom than
// integrations' 10s.
const CLAW_PLANNER_TIMEOUT_MS = 15_000;
// Per sandbox command (the client creates the command, polls for exit and
// fetches logs inside this budget).
const CLAW_RUN_TIMEOUT_MS = 30_000;
// Total budget for the legacy one-shot /run request (cap 5 iter / 110s).
const CLAW_WALL_CLOCK_MS = 110_000;
// Hard cap on write/run actions for legacy /run (not counting the final turn).
const CLAW_MAX_ITERATIONS = 5;
// Sandbox microVM lifetime for legacy /run — comfortably above the wall clock
// so the VM never dies mid-loop; the finally-stop frees it early on every path.
const CLAW_SESSION_TIMEOUT_MS = 180_000;

// --- /stream budgets (SSE — no hard wall clock; the heartbeat keeps the
// connection alive, so the streamed run may run far longer than a buffered
// POST). Iterations are capped instead. ---
// A streaming run may write bigger multi-file projects + install deps, so give
// each planner turn and each command more room than legacy /run.
const STREAM_PLANNER_TIMEOUT_MS = 30_000;
const STREAM_RUN_TIMEOUT_MS = 180_000;
// Per contract C6: iterate the plan→act loop until success or ~6 iterations.
const STREAM_MAX_ITERATIONS = 6;
// Persistent-session lifetime on first create; every reused turn extends it.
const STREAM_SESSION_TIMEOUT_MS = 900_000; // 15m
const STREAM_SESSION_EXTEND_MS = 900_000; // +15m per turn (contract C6)
// The dev-server preview port we request + expose.
const PREVIEW_PORT = 3000;
// After launching the dev server we probe readiness for up to this long before
// emitting preview(ready) regardless (the FE iframe can also just load it).
const PREVIEW_READY_TIMEOUT_MS = 25_000;
const PREVIEW_PROBE_INTERVAL_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 15_000;

// Prompt/response budgets.
const CLAW_TASK_MIN = 1;
const CLAW_TASK_MAX = 4_000;
const STEP_PREVIEW_CHAR_CAP = 2_000;
const RESULT_FEEDBACK_CHAR_CAP = 2_000;
const OUTPUT_RESPONSE_CHAR_CAP = 8_000;
// Live terminal deltas are already streamed frame-by-frame; the run's summary
// fed back to the planner is truncated to keep context bounded.
const TERMINAL_ACCUM_CHAR_CAP = 12_000;
// The planner writes complete files — needs far more tokens than a tool router.
const PLANNER_MAX_TOKENS = 2_048;
// Final natural-language answer stream — a little more room than a tool router.
const FINAL_ANSWER_MAX_TOKENS = 900;
const WRITE_CONTENT_MAX_CHARS = 64_000;
const FILE_PATH_MAX_CHARS = 200;
const COMMAND_MAX_CHARS = 100;
const RUN_ARGS_MAX = 16;
const RUN_ARG_MAX_CHARS = 8_000;
const COMMAND_DISPLAY_CHAR_CAP = 400;
const THREAD_TITLE_MAX = 200;

// Runtimes OPENCLAW accepts (contract C6; default first).
const OPENCLAW_RUNTIMES = ['node24', 'python3.13'];
const OPENCLAW_DEFAULT_RUNTIME = 'node24';
const AGENT_NAME = 'openclaw' as const;

// --- R11 / WS11-11: per-user TOOL PERMISSIONS (Hermes parity). OpenClaw is NOT
// a registry agent — its plan→act loop dispatches exactly TWO sandbox actions
// (`write` a file, `run` a command) directly through SANDBOX2, plus the internal
// `final` turn (not a tool). So the toggleable catalog is those two sandbox
// capabilities. `run` is consequential (it EXECUTES code in the microVM); `write`
// only mutates the ephemeral sandbox FS (not consequential). We MIRROR Hermes'
// enabledTools model EXACTLY: normalize + validate + persist + surface an
// `enabled` flag per tool in /capabilities so the FE ToolPermissions grid renders
// and round-trips. Like Hermes, the persisted set is a stored PREFERENCE surfaced
// to the UI; dispatch itself is unchanged (see the note at the loop) so flags-off
// / config-absent behavior is byte-identical. ---
const OPENCLAW_ENABLED_TOOLS_MAX = 50;

// One advertised OpenClaw tool: id/slug + human label + UI group + `consequential`
// (true when it WRITES/RUNS in a way a human might want to gate — `run` executes).
interface OpenclawTool {
  slug: string;
  label: string;
  group: string;
  consequential: boolean;
}

/** The REAL, whole OpenClaw tool catalog (the two sandbox actions the loop can
 * dispatch). Static — no env gating (the sandbox availability is reported
 * separately by probeSandbox). This is the allowlist a persisted `enabledTools`
 * is intersected against, and the source the /capabilities `tools[]` is built
 * from. Shape consumed by the FE ToolPermissions grid as {id,label,group,
 * consequential} (id = slug). */
function buildOpenclawToolCatalog(): OpenclawTool[] {
  return [
    {
      slug: 'write',
      label: 'Write files',
      group: 'sandbox',
      consequential: false,
    },
    {
      slug: 'run',
      label: 'Run commands',
      group: 'sandbox',
      consequential: true,
    },
  ];
}

/** The set of REAL OpenClaw tool slugs — the allowlist a persisted `enabledTools`
 * is intersected against so a stored config can never reference an invented slug.
 * Mirrors Hermes' allToolSlugs(). */
function allOpenclawToolSlugs(): Set<string> {
  return new Set(buildOpenclawToolCatalog().map(t => t.slug));
}

// --- WS14 / C5: per-user agent CONFIG (onboarding persistence). A per-user
// singleton (the "1 openclaw" = one config each) persisted through the JSON
// Cache under `clickdz:agent:config:<userId>:openclaw`, ~90d TTL refreshed on
// write — mirroring the runtime's Pattern-B thread persistence. Threads stay the
// runs (no cap here). ---
const OPENCLAW_CONFIG_TTL_MS = 90 * 24 * 60 * 60 * 1000; // ~90 days
const openclawConfigKey = (userId: string) =>
  `clickdz:agent:config:${userId}:openclaw`;

// The persisted per-user OpenClaw config. `provisioned` drives the onboarding
// gate (unprovisioned → wizard; provisioned → dashboard/console). Optional
// fields are omitted when unset so the GET default is a clean {provisioned}.
interface OpenclawConfig {
  provisioned: boolean;
  defaultRuntime?: (typeof OPENCLAW_RUNTIMES)[number];
  previewAutoOpen?: boolean;
  // R11/WS11-11: per-user tool allowlist (Hermes parity). Omitted when the user
  // has not customized it ⇒ the console runs the full catalog (see /capabilities
  // default-true). Always ⊆ allOpenclawToolSlugs() after normalize.
  enabledTools?: string[];
  // R12: true once the user has explicitly written enabledTools (even []),
  // so an empty set (all-off) is distinguishable from 'never customized'.
  toolsCustomized?: boolean;
  updatedAt?: number;
}

/**
 * Sanitize a persisted (possibly partial/corrupt) OpenClaw config read back from
 * the cache into the canonical GET shape. Unknown/invalid fields are dropped;
 * defaultRuntime is validated against the accepted runtimes; the default when
 * nothing is stored is {provisioned:false}. Pure, never throws.
 */
function normalizeOpenclawConfig(raw: unknown): OpenclawConfig {
  if (!raw || typeof raw !== 'object') return { provisioned: false };
  const o = raw as Record<string, unknown>;
  const out: OpenclawConfig = { provisioned: o.provisioned === true };
  if (
    typeof o.defaultRuntime === 'string' &&
    OPENCLAW_RUNTIMES.includes(o.defaultRuntime)
  ) {
    out.defaultRuntime = o.defaultRuntime as (typeof OPENCLAW_RUNTIMES)[number];
  }
  if (typeof o.previewAutoOpen === 'boolean') {
    out.previewAutoOpen = o.previewAutoOpen;
  }
  // R11/WS11-11: intersect a persisted enabledTools against the real catalog so a
  // stored config can never carry an invented slug (mirrors Hermes normalize).
  if (Array.isArray(o.enabledTools)) {
    const known = allOpenclawToolSlugs();
    const tools = o.enabledTools
      .filter((s): s is string => typeof s === 'string')
      .map(s => s.trim())
      .filter(s => known.has(s));
    out.enabledTools = Array.from(new Set(tools)).slice(
      0,
      OPENCLAW_ENABLED_TOOLS_MAX
    );
    out.toolsCustomized = true;
  }
  if (o.toolsCustomized === true) {
    out.toolsCustomized = true;
  }
  if (typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt)) {
    out.updatedAt = o.updatedAt;
  }
  return out;
}

// One executed loop step surfaced back to the legacy /run client (WS11 shape).
interface ClawStep {
  i: number;
  thought?: string;
  action?: 'write' | 'run' | 'final';
  file?: string;
  command?: string;
  exitCode?: number;
  outputPreview?: string;
  ok: boolean;
  error?: string;
}

// The planner's parsed single-turn decision (normalized, fail-closed).
interface ClawDecision {
  action: 'write' | 'run' | 'final';
  thought?: string;
  file?: string;
  content?: string;
  command?: string;
  args?: string[];
  language?: string;
  answer?: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (module-level, no `this`, no I/O).
// ---------------------------------------------------------------------------

/** Strip ```json ... ``` (or plain ``` / ~~~ ... ) fences the model may wrap JSON in. */
function stripCodeFences(raw: string): string {
  let s = String(raw ?? '').trim();
  const fence = /^[`~]{3,}[^\n]*\n?/;
  if (fence.test(s)) {
    s = s.replace(fence, '');
    s = s.replace(/[`~]{3,}\s*$/, '');
  }
  return s.trim();
}

/**
 * Fail-closed parse of the planner's JSON turn (same mechanics as
 * clickdz-integrations.controller.ts parsePlannerJson, with OPENCLAW's action
 * vocabulary). Strips fences, tries JSON.parse in a try/catch, falls back to
 * the first {...} span, and NORMALIZES to a ClawDecision. Anything unparseable
 * or shape-wrong becomes {action:'final', answer:<raw text>} so the loop can
 * never crash on model noise.
 */
function parseClawJson(raw: string): ClawDecision {
  const text = String(raw ?? '');
  const stripped = stripCodeFences(text);
  let obj: any;
  try {
    obj = JSON.parse(stripped);
  } catch {
    // Model sometimes prepends prose then emits JSON — try the first {...} span.
    const first = stripped.indexOf('{');
    const last = stripped.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        obj = JSON.parse(stripped.slice(first, last + 1));
      } catch {
        return { action: 'final', answer: text.trim() };
      }
    } else {
      return { action: 'final', answer: text.trim() };
    }
  }
  if (!obj || typeof obj !== 'object') {
    return { action: 'final', answer: text.trim() };
  }
  const thought =
    typeof obj.thought === 'string' && obj.thought.trim()
      ? obj.thought.trim()
      : undefined;
  if (obj.action === 'write') {
    return {
      action: 'write',
      thought,
      file: typeof obj.file === 'string' ? obj.file.trim() : undefined,
      content: typeof obj.content === 'string' ? obj.content : undefined,
      language:
        typeof obj.language === 'string' && obj.language.trim()
          ? obj.language.trim()
          : undefined,
    };
  }
  if (obj.action === 'run') {
    const args = Array.isArray(obj.args)
      ? obj.args.filter((a: any) => typeof a === 'string')
      : [];
    return {
      action: 'run',
      thought,
      command: typeof obj.command === 'string' ? obj.command.trim() : undefined,
      args,
    };
  }
  if (obj.action === 'final') {
    const answer =
      typeof obj.answer === 'string' && obj.answer.trim()
        ? obj.answer.trim()
        : text.trim();
    return {
      action: 'final',
      thought,
      answer,
      code:
        typeof obj.code === 'string' && obj.code.trim() ? obj.code : undefined,
      language:
        typeof obj.language === 'string' && obj.language.trim()
          ? obj.language.trim()
          : undefined,
    };
  }
  // Unknown/absent action -> treat the whole thing as a final answer.
  return { action: 'final', answer: text.trim() };
}

/** JSON-stringify a value and hard-truncate to `cap` chars (default 2000). */
function truncatePreview(
  value: unknown,
  cap: number = STEP_PREVIEW_CHAR_CAP
): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s == null) s = '';
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `… [truncated ${s.length - cap} chars]`;
}

// Relative sandbox paths only: alphanumeric first char, then letters, digits,
// . _ - / — no leading slash, no "..", no shell-quoting hazards for the
// client's heredoc write method.
const SAFE_SANDBOX_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

function isSafeSandboxPath(file: string): boolean {
  return (
    typeof file === 'string' &&
    file.length > 0 &&
    file.length <= FILE_PATH_MAX_CHARS &&
    SAFE_SANDBOX_PATH_RE.test(file) &&
    !file.includes('..') &&
    !file.endsWith('/')
  );
}

/** Best-effort language label from the file extension, else the runtime. */
function inferLanguage(file: string | null, runtime: string): string {
  const f = (file ?? '').toLowerCase();
  if (f.endsWith('.py')) return 'python';
  if (f.endsWith('.ts') || f.endsWith('.tsx')) return 'typescript';
  if (f.endsWith('.jsx')) return 'javascript';
  if (f.endsWith('.mjs') || f.endsWith('.cjs') || f.endsWith('.js')) {
    return 'javascript';
  }
  if (f.endsWith('.json')) return 'json';
  if (f.endsWith('.html') || f.endsWith('.htm')) return 'html';
  if (f.endsWith('.css')) return 'css';
  if (f.endsWith('.md')) return 'markdown';
  if (f.endsWith('.yml') || f.endsWith('.yaml')) return 'yaml';
  if (f.endsWith('.sh')) return 'bash';
  return runtime === 'python3.13' ? 'python' : 'javascript';
}

/**
 * Best-effort language for the file-tree/editor endpoints, where there is no
 * runtime context — return undefined when the extension is unknown so the FE
 * can fall back to plain text.
 */
function languageForPath(path: string): string | undefined {
  const f = (path ?? '').toLowerCase();
  if (f.endsWith('.py')) return 'python';
  if (f.endsWith('.ts') || f.endsWith('.tsx')) return 'typescript';
  if (f.endsWith('.jsx')) return 'javascript';
  if (f.endsWith('.mjs') || f.endsWith('.cjs') || f.endsWith('.js')) {
    return 'javascript';
  }
  if (f.endsWith('.json')) return 'json';
  if (f.endsWith('.html') || f.endsWith('.htm')) return 'html';
  if (f.endsWith('.css')) return 'css';
  if (f.endsWith('.scss') || f.endsWith('.sass')) return 'scss';
  if (f.endsWith('.md') || f.endsWith('.markdown')) return 'markdown';
  if (f.endsWith('.yml') || f.endsWith('.yaml')) return 'yaml';
  if (f.endsWith('.toml')) return 'toml';
  if (f.endsWith('.sh') || f.endsWith('.bash')) return 'bash';
  if (f.endsWith('.sql')) return 'sql';
  if (f.endsWith('.go')) return 'go';
  if (f.endsWith('.rs')) return 'rust';
  if (f.endsWith('.env')) return 'bash';
  return undefined;
}

/** Merge stdout + stderr into one honest, labeled output string. */
function combineOutput(stdout: string, stderr: string): string {
  const out = typeof stdout === 'string' ? stdout.trim() : '';
  const err = typeof stderr === 'string' ? stderr.trim() : '';
  if (out && err) return `${out}\n[stderr]\n${err}`;
  return out || err;
}

/** Heuristic: does this task/command imply a long-running web dev server? */
function looksLikeDevServer(command: string, args: string[]): boolean {
  const joined = [command, ...args].join(' ').toLowerCase();
  return (
    /\bnpm\s+(run\s+)?(dev|start)\b/.test(joined) ||
    /\b(pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b/.test(joined) ||
    /\bnext\b.*\b(dev|start)\b/.test(joined) ||
    /\bvite\b/.test(joined) ||
    /\bhttp\.server\b/.test(joined) ||
    /\bhttp-server\b/.test(joined) ||
    /\bflask\s+run\b/.test(joined) ||
    /\buvicorn\b/.test(joined) ||
    /--port[= ]?3000\b/.test(joined) ||
    /\bserve\b/.test(joined)
  );
}

/** Does the overall task hint at building a web app (used to nudge the plan)? */
function taskWantsWebApp(task: string): boolean {
  const t = (task ?? '').toLowerCase();
  return /\b(web ?app|website|web page|webpage|frontend|front-end|react|next\.?js|vite|vue|svelte|html|landing page|dashboard|ui|http server|dev server|preview|localhost)\b/.test(
    t
  );
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

/**
 * ClickDz OPENCLAW — the autonomous coding agent.
 *
 * All routes are auth'd (global AuthGuard requires a signed-in cookie session —
 * no @Public()) and rate-capped with @Throttle, mirroring the sibling
 * controllers. Planner and sandbox failures degrade gracefully (typed 502 /
 * plan-only mode / in-stream error frame) — never a raw HttpException, never
 * fabricated results.
 */
@Controller()
export class ClickDzOpenclawController {
  private readonly logger = new Logger(ClickDzOpenclawController.name);

  // The shared agent runtime (SSE + threads + stop) is injected; the sandbox
  // client is a set of module functions (no DI). Thread persistence is reached
  // through the runtime; WS14/C5 adds the @Global JSON `Cache` for the per-user
  // config singleton (the SAME provider the runtime persists threads through).
  constructor(
    private readonly runtime: ClickDzAgentRuntime,
    private readonly cache: Cache,
    private readonly redis: CacheRedis
  ) {
    // R6/WSA (F-1): register the detached OpenClaw loop with Moteur's engine
    // ONLY behind the master flag. Mirrors the Hermes port. The factory closes
    // over `this` so the copilot.agent.run job (agent='openclaw') drives the
    // SAME sandbox loop via the emit-backed seam. Idempotent (last wins).
    if (CDZ_AGENTS_ENABLED) {
      registerAgentLoop('openclaw', (rec: AgentRunRecord) => ({
        redis: this.redis as any,
        loop: async (ctx: AgentLoopContext) => {
          const r = await this.runOpenclawLoop({
            userId: rec.userId,
            prompt: rec.prompt,
            threadId: rec.threadId,
            emit: ctx.emit as any,
            signal: ctx.signal,
            budget: rec.budget as any,
            persona: ctx.persona, // R12: thread custom-agent persona (undefined for built-in)
          });
          if (r.state === 'failed') {
            throw new Error(r.error || 'openclaw_failed');
          }
          return r.finalText ?? '';
        },
      }));
    }
  }

  /**
   * Read + normalize the caller's persisted OpenClaw config (fail-soft). Returns
   * the canonical {provisioned:false} default when nothing is stored or the read
   * fails. Never throws.
   */
  private async readOpenclawConfig(userId: string): Promise<OpenclawConfig> {
    try {
      const raw = await this.cache.get<unknown>(openclawConfigKey(userId));
      return normalizeOpenclawConfig(raw);
    } catch {
      return { provisioned: false };
    }
  }

  // One-shot flag so the resolved planner base+path is logged the FIRST time a
  // planner call is actually attempted (lazy — never at import), never
  // repeated. Path only, no key material.
  private plannerUrlLogged = false;

  /** Small helper: fetch with a hard AbortController timeout. */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number = CLAW_PLANNER_TIMEOUT_MS
  ): Promise<globalThis.Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET capabilities — drives the frontend enable/disable state.
   * {sandbox, reason?, plannerReady, runtimes, streaming:true, provisioned}
   * (contract C6). WS14/C5 folds the per-user `provisioned` flag in (additive —
   * the existing fields are untouched) so the FE onboarding gate can key off
   * /capabilities alone if it prefers.
   */
  @Throttle('strict')
  @Get('/api/v1/openclaw/capabilities')
  async capabilities(@CurrentUser() user: CurrentUser, @Res() res: Response) {
    const [capability, config] = await Promise.all([
      this.probeSandbox(),
      this.readOpenclawConfig(user.id),
    ]);
    // R11/WS11-11: per-tool `enabled` flags for the FE ToolPermissions grid
    // (Hermes parity). When the user has an explicit enabledTools set, honor it;
    // otherwise every tool is enabled by default (no customization = full catalog
    // available — the console works out of the box). The catalog carries `group`
    // so the FE maps each entry to {id:slug, label, group, consequential} +
    // `enabled` with no OpenClaw-specific classify logic.
    const enabledSet = config.toolsCustomized
      ? new Set(config.enabledTools ?? [])
      : null;
    const tools = buildOpenclawToolCatalog().map(t => ({
      slug: t.slug,
      label: t.label,
      group: t.group,
      // Sandbox actions are always "available" when the sandbox itself is up;
      // the honest live-execution flag stays the top-level `sandbox` field, so
      // per-tool availability tracks it (both actions need the microVM).
      available: capability.sandbox,
      consequential: t.consequential,
      enabled: enabledSet ? enabledSet.has(t.slug) : true,
    }));
    res.status(200).json({
      sandbox: capability.sandbox,
      ...(capability.reason ? { reason: capability.reason } : {}),
      plannerReady: !!CDZ_AI_KEY,
      runtimes: OPENCLAW_RUNTIMES,
      // WS12: this controller now speaks SSE at /api/v1/openclaw/stream.
      streaming: true,
      // R11/WS11-11: additive — the two toggleable sandbox tools + enabled state.
      tools,
      provisioned: config.provisioned,
    });
  }

  /**
   * GET sandbox/health — R9 SONDE LIVE diagnostic. Runs a real
   * create → echo('ok') → teardown against Vercel under a 60s budget and
   * returns {ok, stage:'create'|'exec'|'teardown'|'done', ms, error?} with the
   * VERBATIM upstream error string, so the REAL prod failure is visible from
   * this one endpoint. Gated CDZ_AGENTS_ENABLED (typed 404 when off, so the
   * probe surface is invisible unless agents are on). Auth via @CurrentUser.
   * Thin by design — the whole lifecycle lives in SANDBOX2.sandboxHealthProbe
   * (dep-free; it reads VERCEL_TOKEN/VERCEL_TEAM_ID itself like the rest of the
   * module). Never leaks a microVM: the probe always tears down.
   */
  @Throttle('strict')
  @Get('/api/v1/openclaw/sandbox/health')
  async sandboxHealth(@CurrentUser() _user: CurrentUser) {
    if (!CDZ_AGENTS_ENABLED) {
      throw new NotFound('Sandbox health probe is not enabled');
    }
    return sandboxHealthProbe();
  }

  // -------------------------------------------------------------------------
  // WS14 / C5 — per-user agent CONFIG (onboarding persistence).
  //
  //   GET /api/v1/openclaw/config → the caller's config (defaults
  //     {provisioned:false} when none). Auth via @CurrentUser.
  //   PUT /api/v1/openclaw/config {defaultRuntime?, previewAutoOpen?} → upsert
  //     (merges over the stored config, sets provisioned:true), validated
  //     (defaultRuntime enum; previewAutoOpen boolean), typed 400 on malformed
  //     input via @Res passthrough — NEVER a raw HttpException.
  //
  // The config is a per-user SINGLETON (the "1 openclaw" = one config each);
  // threads remain the runs, so there is no thread cap and no 409 — PUT just
  // upserts. Persisted through the JSON Cache under
  // `clickdz:agent:config:<userId>:openclaw` (~90d TTL, refreshed on write).
  // -------------------------------------------------------------------------
  // R13 (429 fix): own per-route bucket via the custom override (';custom'
  // key, see base/throttler generateKey) — same shared-default-bucket disease
  // that 429-stormed the Hermes dashboard; OpenClaw's mount fan-out (config +
  // threads) drains the identical per-session bucket.
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/openclaw/config')
  async getConfig(@CurrentUser() user: CurrentUser): Promise<OpenclawConfig> {
    return this.readOpenclawConfig(user.id);
  }

  @Throttle('default')
  @Put('/api/v1/openclaw/config')
  async putConfig(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ): Promise<OpenclawConfig | { ok: false; error: string }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ ok: false, error: 'body must be an object' });
      return { ok: false, error: 'invalid_body' };
    }

    // Partial upsert: start from the stored config, validate + apply each field.
    const current = await this.readOpenclawConfig(user.id);
    const next: OpenclawConfig = { ...current, provisioned: true };

    if (body.defaultRuntime !== undefined) {
      if (
        typeof body.defaultRuntime !== 'string' ||
        !OPENCLAW_RUNTIMES.includes(body.defaultRuntime)
      ) {
        res.status(400).json({
          ok: false,
          error: `"defaultRuntime" must be one of: ${OPENCLAW_RUNTIMES.join(
            ', '
          )}`,
        });
        return { ok: false, error: 'invalid_defaultRuntime' };
      }
      next.defaultRuntime =
        body.defaultRuntime as (typeof OPENCLAW_RUNTIMES)[number];
    }

    if (body.previewAutoOpen !== undefined) {
      if (typeof body.previewAutoOpen !== 'boolean') {
        res.status(400).json({
          ok: false,
          error: '"previewAutoOpen" must be a boolean',
        });
        return { ok: false, error: 'invalid_previewAutoOpen' };
      }
      next.previewAutoOpen = body.previewAutoOpen;
    }

    // R11/WS11-11: validate enabledTools exactly like Hermes' putConfig — array,
    // length cap, string entries, each ⊆ the real catalog. Typed 400 via @Res
    // passthrough (never a raw HttpException).
    if (body.enabledTools !== undefined) {
      if (!Array.isArray(body.enabledTools)) {
        res
          .status(400)
          .json({ ok: false, error: '"enabledTools" must be an array' });
        return { ok: false, error: 'invalid_enabledTools' };
      }
      if (body.enabledTools.length > OPENCLAW_ENABLED_TOOLS_MAX) {
        res.status(400).json({
          ok: false,
          error: `"enabledTools" must have <= ${OPENCLAW_ENABLED_TOOLS_MAX} entries`,
        });
        return { ok: false, error: 'invalid_enabledTools' };
      }
      const known = allOpenclawToolSlugs();
      const cleaned: string[] = [];
      for (const raw of body.enabledTools) {
        if (typeof raw !== 'string') {
          res.status(400).json({
            ok: false,
            error: '"enabledTools" entries must be strings',
          });
          return { ok: false, error: 'invalid_enabledTools' };
        }
        const slug = raw.trim();
        if (!known.has(slug)) {
          res.status(400).json({
            ok: false,
            error: `unknown tool slug "${slug}" — must be one of: ${Array.from(
              known
            ).join(', ')}`,
          });
          return { ok: false, error: 'unknown_tool' };
        }
        cleaned.push(slug);
      }
      next.enabledTools = Array.from(new Set(cleaned));
      next.toolsCustomized = true;
    }

    next.updatedAt = Date.now();

    const saved = await this.cache.set(openclawConfigKey(user.id), next, {
      ttl: OPENCLAW_CONFIG_TTL_MS,
    });
    if (!saved) {
      res.status(503).json({
        ok: false,
        error: 'config could not be persisted right now — please retry',
      });
      return { ok: false, error: 'persist_failed' };
    }
    return normalizeOpenclawConfig(next);
  }

  // =========================================================================
  // WS12 — POST /api/v1/openclaw/stream (SSE, persistent sandbox console)
  // =========================================================================
  //
  //   body {threadId?: string; message: string; runtime?: 'node24'|'python3.13'}
  //
  // Emits the contract-C1 AgentEvent wire protocol (each frame
  // `data: ${JSON.stringify(ev)}\n\n`, `type` discriminates, a 15s ping
  // heartbeat, terminal `{type:'done'}`). Auth is the cookie session via
  // @CurrentUser; the FE POSTs with credentials:'include' + a ReadableStream
  // reader. We NEVER throw inside the stream — every failure becomes an `error`
  // frame + `done`.
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/openclaw/stream')
  async stream(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response
  ) {
    // Open the SSE stream FIRST (sets headers, flushHeaders, 15s ping, wires
    // req 'close'). After this point NOTHING throws to the framework — all
    // errors go out as {type:'error'} frames.
    const writer = this.runtime.openStream(req, res);
    writer.heartbeatEvery(HEARTBEAT_INTERVAL_MS);

    let threadId: string | null = null;
    try {
      // ---- validate input (in-stream error, never a thrown HttpException) ----
      const message =
        typeof body?.message === 'string' ? body.message.trim() : '';
      if (message.length < CLAW_TASK_MIN || message.length > CLAW_TASK_MAX) {
        // The single finally below always ends the stream — early branches just
        // emit the error frame and return (no direct end() → no double done).
        writer.emit({
          type: 'error',
          code: 'bad_request',
          message: `"message" must be a string of ${CLAW_TASK_MIN}..${CLAW_TASK_MAX} chars`,
        });
        return;
      }
      const runtimeRaw =
        typeof body?.runtime === 'string' ? body.runtime.trim() : '';
      if (runtimeRaw && !OPENCLAW_RUNTIMES.includes(runtimeRaw)) {
        writer.emit({
          type: 'error',
          code: 'bad_request',
          message: `"runtime" must be one of: ${OPENCLAW_RUNTIMES.join(', ')}`,
        });
        return;
      }
      const requestedRuntime = runtimeRaw || OPENCLAW_DEFAULT_RUNTIME;

      // ---- resolve or create the thread ----
      const requestedThreadId =
        typeof body?.threadId === 'string' && body.threadId.trim()
          ? body.threadId.trim()
          : null;
      let thread: AgentThread | null = null;
      if (requestedThreadId) {
        thread = await this.runtime.getThread(user.id, requestedThreadId);
        if (!thread) {
          writer.emit({
            type: 'error',
            code: 'not_found',
            message: 'Thread not found',
          });
          return;
        }
      } else {
        thread = await this.runtime.createThread(
          user.id,
          AGENT_NAME,
          this.deriveTitle(message)
        );
      }
      threadId = thread.id;

      // A fresh run supersedes any stale stop flag from a prior turn.
      await this.runtime.clearStop(threadId);

      // The effective runtime is fixed by the thread's existing sandbox once one
      // exists (you can't change a live microVM's runtime); otherwise the
      // request's runtime wins.
      const runtime = thread.sandbox?.runtime || requestedRuntime;

      // ---- append the user message + announce the thread ----
      const userMessage: AgentMessage = {
        id: this.randomId('msg'),
        role: 'user',
        content: message,
        createdAt: Date.now(),
        agent: AGENT_NAME,
      };
      thread.messages.push(userMessage);
      thread.updatedAt = Date.now();
      await this.runtime.saveThread(user.id, thread);

      writer.emit({
        type: 'thread',
        threadId: thread.id,
        agent: AGENT_NAME,
        title: thread.title,
      });

      // ---- ensure a PERSISTENT sandbox for this thread ----
      writer.emit({ type: 'status', phase: 'planning', label: 'Preparing workspace' });
      const capability = await this.probeSandbox();

      if (!capability.sandbox) {
        // Honest degrade: no sandbox → still stream planner-generated files +
        // a token answer that says execution is unavailable. Real, not a stub.
        await this.streamPlanOnly(
          user.id,
          thread,
          message,
          runtime,
          capability.reason ??
            'Vercel Sandbox is not available for this deployment',
          writer
        );
        return;
      }

      const ready = await this.ensurePersistentSandbox(
        user.id,
        thread,
        runtime,
        writer
      );
      if (!ready.ok) {
        // Sandbox creation failed mid-setup — degrade to plan-only rather than
        // aborting the turn (the message is still saved on the thread). D2 — the
        // reason is now DISTINCT (at-capacity / billing / auth / timeout) instead
        // of a single generic line, so the user gets an honest, actionable notice.
        await this.streamPlanOnly(
          user.id,
          thread,
          message,
          runtime,
          ready.reason ??
            'the sandbox session could not be created for this thread',
          writer
        );
        return;
      }

      const sessionId = thread.sandbox!.sessionId;
      const routes = thread.sandbox!.routes ?? [];

      // ---- the streaming plan→act loop ----
      await this.streamAgentLoop({
        userId: user.id,
        thread,
        message,
        runtime,
        sessionId,
        routes,
        writer,
      });
    } catch (err) {
      // Belt-and-braces: nothing above should throw, but if it does the stream
      // is already open — emit an error frame instead of a 500.
      const detail = (err as Error)?.message ?? 'openclaw_stream_failed';
      this.logger.warn(`[openclaw] stream failed: ${detail}`);
      if (!writer.closed) {
        writer.emit({
          type: 'error',
          code: 'stream_failed',
          message: truncatePreview(detail, RESULT_FEEDBACK_CHAR_CAP),
        });
      }
    } finally {
      // Clear the (possibly stale) stop flag for this thread; NEVER stopSession
      // here — the sandbox persists on the thread across turns (contract C6).
      if (threadId) {
        try {
          await this.runtime.clearStop(threadId);
        } catch {
          /* best-effort */
        }
      }
      writer.end();
    }
  }

  /**
   * Ensure the thread owns a live, persistent sandbox session.
   *   - reuse: thread.sandbox.sessionId present AND sessionStatus()==='running'
   *     AND extendSession(+15m) SUCCEEDS → keep the stored routes.
   *   - recreate: otherwise createSessionWithPorts({runtime, ports:[3000]}) and
   *     persist {sessionId, runtime, routes} onto the thread.
   * Returns `{ ok:true }` when the thread has a usable session, or
   * `{ ok:false, reason }` on hard failure (the caller degrades to plan-only and
   * shows `reason`). Defensive — swallows/logs, never throws.
   *
   * D1 FIX (R16) — a stale/stopped/failed reused session (sessionStatus() not
   * 'running', which INCLUDES a 404 → 'stopped') is transparently recreated
   * instead of being reused and blowing up later inside the exec loop. This was
   * already the fall-through, but it is now explicit and guarded.
   *
   * D4 FIX (R16) — if extendSession THROWS on a session that looked 'running',
   * that VM is about to hit its old deadline mid-turn. We no longer swallow the
   * failure and reuse it; we treat the session as DEAD and recreate proactively,
   * so the planner never gets an opaque "session expired" error halfway through.
   *
   * RECREATE-LOOP GUARD — recreation is delegated to recreateSandboxSession(),
   * which makes AT MOST one retry (two create attempts total) and can never
   * spin: there is no loop back into status-checking, and a create failure
   * returns a typed reason rather than re-entering this method.
   */
  private async ensurePersistentSandbox(
    userId: string,
    thread: AgentThread,
    runtime: string,
    writer: AgentSseWriterLike
  ): Promise<{ ok: boolean; reason?: string }> {
    const existing = thread.sandbox;
    if (existing?.sessionId) {
      let status: 'running' | 'stopped' | 'failed' | 'unknown' = 'unknown';
      try {
        status = await sessionStatus(existing.sessionId);
      } catch (err) {
        this.logger.warn(
          `[openclaw] sessionStatus failed: ${(err as Error)?.message ?? err}`
        );
        status = 'unknown';
      }
      if (status === 'running') {
        // Reuse the warm microVM and push its deadline forward. D4 FIX — a FAILED
        // extend means the VM keeps its OLD (soon-to-expire) deadline, so reusing
        // it risks dying mid-turn. On extend failure we drop through to recreate
        // instead of the old behavior (swallow + reuse anyway).
        let extended = true;
        try {
          await extendSession(existing.sessionId, STREAM_SESSION_EXTEND_MS);
        } catch (err) {
          extended = false;
          this.logger.warn(
            `[openclaw] extendSession failed — treating session as dead, will recreate: ${
              (err as Error)?.message ?? err
            }`
          );
        }
        if (extended) {
          existing.updatedAt = Date.now();
          thread.updatedAt = Date.now();
          await this.runtime.saveThread(userId, thread);
          writer.emit({
            type: 'status',
            phase: 'planning',
            label: 'Reconnected to workspace',
          });
          return { ok: true };
        }
        // extend failed → best-effort release the doomed VM before recreating so
        // it doesn't linger against the shared concurrency budget, then recreate.
        try {
          await stopSession(existing.sessionId);
        } catch {
          /* best-effort — stopSession already swallows, belt-and-braces */
        }
      }
      // Dead / unknown / stopped / failed / extend-failed → recreate below.
    }

    return this.recreateSandboxSession(userId, thread, runtime, writer);
  }

  /**
   * Provision a FRESH persistent sandbox for the thread and persist it. Isolated
   * from ensurePersistentSandbox so the recreate path has a HARD, self-contained
   * retry budget: it attempts createSessionWithPorts, and on the FIRST failure
   * retries EXACTLY ONCE. There is no path back into status-checking or into
   * ensurePersistentSandbox, so a persistent upstream fault can never cause an
   * infinite recreate loop — it fails after two attempts with a typed reason.
   *
   * On success persists {sessionId, runtime, routes} onto the thread and returns
   * `{ ok:true }`. On failure returns `{ ok:false, reason }` where `reason` is a
   * DISTINCT, human message derived from the discriminated describeSandboxError()
   * result (D2): at-capacity / billing / auth / timeout each read differently so
   * the user isn't told a generic "couldn't create". Never throws.
   */
  private async recreateSandboxSession(
    userId: string,
    thread: AgentThread,
    runtime: string,
    writer: AgentSseWriterLike
  ): Promise<{ ok: boolean; reason?: string }> {
    writer.emit({
      type: 'status',
      phase: 'planning',
      label: 'Starting a fresh workspace',
    });
    // At most 2 attempts total (one retry). A bounded for-loop — NOT a while —
    // so it is structurally impossible to spin.
    const MAX_ATTEMPTS = 2;
    let lastFailure: SandboxFailure | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const created = await createSessionWithPorts({
          runtime,
          ports: [PREVIEW_PORT],
          timeoutMs: STREAM_SESSION_TIMEOUT_MS,
        });
        thread.sandbox = {
          sessionId: created.sessionId,
          runtime: created.runtime,
          routes: (created.routes ?? []).map(r => ({
            url: r.url,
            port: r.port,
          })),
          updatedAt: Date.now(),
        };
        thread.updatedAt = Date.now();
        await this.runtime.saveThread(userId, thread);
        return { ok: true };
      } catch (err) {
        // D2 — project the throw onto the discriminated shape for a distinct msg.
        lastFailure = describeSandboxError(err);
        this.logger.warn(
          `[openclaw] createSessionWithPorts failed (attempt ${attempt}/${MAX_ATTEMPTS}, reason=${lastFailure.reason}${
            typeof lastFailure.status === 'number'
              ? ` status=${lastFailure.status}`
              : ''
          }): ${lastFailure.detail ?? ''}`
        );
        // Only a TRANSIENT reason is worth a retry. A durable fault
        // (auth/billing) will fail identically on the second try, so fail fast
        // and don't burn the budget or spam Vercel.
        // Sentinel F-1: 'at_capacity' (429) is NOT retryable here. A 429 means
        // the shared account is already at its concurrency/rate cap and a 15m
        // VM won't free in the ~0ms before a retry — re-firing POST /v2/sandboxes
        // would just DOUBLE the create rate while Vercel is rate-limiting us,
        // worsening the very problem. Capacity is left to the user-driven retry
        // the UX already prompts. Only genuinely-transient reasons retry once.
        const retryable =
          lastFailure.reason === 'timeout' ||
          lastFailure.reason === 'unknown';
        if (attempt >= MAX_ATTEMPTS || !retryable) break;
      }
    }
    return {
      ok: false,
      reason: this.sandboxFailureMessage(lastFailure),
    };
  }

  /**
   * D2 — turn a discriminated {reason} create failure into the friendly, DISTINCT
   * message the plan-only degrade shows the user. Each reason reads differently so
   * "at capacity" is never confused with an outage or a billing/auth problem. Kept
   * tiny + pure; a null failure (shouldn't happen) falls back to the legacy line
   * so behavior is safe if a new reason is ever added.
   */
  private sandboxFailureMessage(failure: SandboxFailure | null): string {
    switch (failure?.reason) {
      case 'at_capacity':
        return 'the sandbox is at capacity right now — retry in a few moments';
      case 'billing':
        return 'the sandbox is temporarily unavailable due to an account billing/quota issue (the operator has been notified)';
      case 'auth':
        return 'the sandbox is not configured correctly on the server — code was generated but not executed';
      case 'timeout':
        return 'the sandbox took too long to start — retry shortly';
      default:
        return 'the sandbox session could not be created for this thread';
    }
  }

  /**
   * The streaming plan→act loop. Mirrors the legacy /run vocabulary
   * (write/run/final) but emits live SSE frames instead of accumulating a JSON
   * body, uses the PERSISTENT session, streams command output as `terminal`
   * events, launches + previews a dev server on port 3000, and streams the
   * final answer token-by-token. NEVER stopSession. Respects the stop flag each
   * iteration.
   */
  private async streamAgentLoop(ctx: {
    userId: string;
    thread: AgentThread;
    message: string;
    runtime: string;
    sessionId: string;
    routes: { url: string; port: number }[];
    writer: AgentSseWriterLike;
    persona?: string; // R12: custom-agent persona; undefined on live /stream ⇒ byte-identical
  }): Promise<void> {
    const { userId, thread, message, runtime, sessionId, writer } = ctx;
    let routes = ctx.routes;

    const messages: Array<{ role: string; content: string }> = [
      {
        role: 'system',
        content:
          (ctx.persona ? `Tu es un agent personnalisé. ${ctx.persona}\n\n` : '') +
          this.buildStreamSystemPrompt(runtime, ctx.message),
      },
      ...this.priorTurns(thread),
      { role: 'user', content: message },
    ];

    const steps: AgentStep[] = [];
    let iterations = 0;
    let answer: string | null = null;
    let finalDecision: ClawDecision | null = null;
    let lastExitCode: number | null = null;
    let anyRunExecuted = false;
    let previewUrl: string | null = null;

    // Authoritatively assign the 1-based step index here so every construction
    // site (including the dev-server helper which can't know steps.length) is
    // numbered correctly and consistently.
    const pushStep = (step: AgentStep) => {
      step.i = steps.length + 1;
      steps.push(step);
      writer.emit({ type: 'step', step });
    };

    writer.emit({ type: 'status', phase: 'planning', label: 'Planning' });

    while (iterations < STREAM_MAX_ITERATIONS) {
      // Cooperative stop (checked each iteration, before planning).
      if (await this.stopRequested(thread.id)) {
        writer.emit({ type: 'status', phase: 'stopped', label: 'Stopped' });
        answer = answer ?? 'Run stopped at your request.';
        break;
      }
      if (writer.closed) return; // client disconnected — abort silently

      const planned = await this.callPlanner(messages, STREAM_PLANNER_TIMEOUT_MS);
      if (planned === null) {
        if (steps.length === 0) {
          writer.emit({
            type: 'error',
            code: 'planner_unavailable',
            message:
              'The cdz-flash planner is currently unavailable. Please try again in a moment.',
          });
          // Persist a short assistant turn so the thread stays coherent.
          await this.persistAssistant(
            userId,
            thread,
            'The planner was unavailable, so no work was performed.',
            steps,
            writer
          );
          return;
        }
        answer = this.synthesizeAnswer(steps, lastExitCode);
        break;
      }

      messages.push({ role: 'assistant', content: planned.raw });
      const decision = parseClawJson(planned.raw);

      if (decision.action === 'final') {
        answer = decision.answer ?? '';
        finalDecision = decision;
        break;
      }

      // ---- write ----
      if (decision.action === 'write') {
        iterations++;
        const file = decision.file ?? '';
        const content = decision.content;
        if (
          !isSafeSandboxPath(file) ||
          typeof content !== 'string' ||
          content.length === 0 ||
          content.length > WRITE_CONTENT_MAX_CHARS
        ) {
          messages.push({
            role: 'user',
            content: `Invalid write action. "file" must be a relative path (letters, digits, . _ - / only; no leading "/", no ".."), and "content" must be the complete non-empty file text (<= ${WRITE_CONTENT_MAX_CHARS} chars). Reply with corrected JSON.`,
          });
          continue;
        }
        const language = decision.language ?? inferLanguage(file, runtime);
        writer.emit({ type: 'status', phase: 'writing', label: `Writing ${file}` });
        let step: AgentStep;
        try {
          await writeFile(sessionId, file, content);
          // file-tree delta + artifact + step (contract C6).
          writer.emit({ type: 'file', op: 'write', path: file, language });
          writer.emit({
            type: 'artifact',
            artifact: {
              kind: 'file',
              path: file,
              language,
              bytes: Buffer.byteLength(content, 'utf8'),
            },
          });
          step = {
            i: steps.length + 1,
            kind: 'write',
            title: `Wrote ${file}`,
            ...(decision.thought ? { detail: decision.thought } : {}),
            ok: true,
            resultPreview: `wrote ${content.length} chars to ${file}`,
            ts: Date.now(),
          };
          pushStep(step);
          messages.push({
            role: 'user',
            content: `File ${file} written (${content.length} chars). Continue: write more files if needed, run a command to execute/build, or start the dev server on port ${PREVIEW_PORT} for a live preview.`,
          });
        } catch (err) {
          const detail = (err as Error)?.message ?? 'sandbox_write_failed';
          this.logger.warn(`[openclaw] writeFile ${file} failed: ${detail}`);
          step = {
            i: steps.length + 1,
            kind: 'write',
            title: `Failed to write ${file}`,
            ...(decision.thought ? { detail: decision.thought } : {}),
            ok: false,
            error: truncatePreview(detail),
            ts: Date.now(),
          };
          pushStep(step);
          messages.push({
            role: 'user',
            content: `Writing ${file} FAILED: ${truncatePreview(detail, RESULT_FEEDBACK_CHAR_CAP)}. Adjust (e.g. a simpler relative path) and retry.`,
          });
        }
        continue;
      }

      // ---- run ----
      const command = decision.command ?? '';
      const args = Array.isArray(decision.args) ? decision.args : [];
      const argsOk =
        args.length <= RUN_ARGS_MAX &&
        args.every(a => a.length <= RUN_ARG_MAX_CHARS);
      if (!command || command.length > COMMAND_MAX_CHARS || !argsOk) {
        iterations++;
        messages.push({
          role: 'user',
          content:
            'Invalid run action. "command" must be a short executable name (e.g. "node", "python3", "bash", "npm") and "args" an array of strings. Reply with corrected JSON.',
        });
        continue;
      }
      iterations++;
      const display = truncatePreview(
        [command, ...args].join(' '),
        COMMAND_DISPLAY_CHAR_CAP
      );

      // Dev server → launch in the BACKGROUND (non-blocking) + emit preview.
      if (looksLikeDevServer(command, args)) {
        const dev = await this.launchDevServer({
          userId,
          thread,
          sessionId,
          command,
          args,
          display,
          routes,
          thought: decision.thought,
          writer,
        });
        routes = dev.routes;
        if (dev.previewUrl) {
          previewUrl = dev.previewUrl;
        }
        pushStep(dev.step);
        messages.push({
          role: 'user',
          content: dev.previewUrl
            ? `Dev server started in the background (${display}). A live preview is available at port ${PREVIEW_PORT}. If the app is complete, reply now with {"action":"final","answer":"..."} describing what you built and that a live preview is running.`
            : `Attempted to start the dev server (${display}) but no preview URL was available. If the task is otherwise complete, reply with a "final" action; otherwise continue.`,
        });
        continue;
      }

      // Ordinary command → run to completion with LIVE streamed output.
      writer.emit({
        type: 'status',
        phase: this.isInstallCommand(command, args) ? 'installing' : 'running',
        label: `$ ${display}`,
      });
      const cmdId = this.randomId('cmd');
      let accumulated = '';
      let step: AgentStep;
      try {
        const result = await runCommandStreaming(sessionId, command, args, {
          timeoutMs: STREAM_RUN_TIMEOUT_MS,
          onLog: l => {
            if (writer.closed) return;
            if (accumulated.length < TERMINAL_ACCUM_CHAR_CAP) {
              accumulated += l.data;
            }
            writer.emit({
              type: 'terminal',
              stream: l.stream,
              data: l.data,
              cmdId,
            });
          },
        });
        anyRunExecuted = true;
        lastExitCode = result.exitCode;
        const ok = result.exitCode === 0;
        const preview = truncatePreview(accumulated.trim() || '(no output)');
        step = {
          i: steps.length + 1,
          kind: 'run',
          title: `$ ${display}`,
          ...(decision.thought ? { detail: decision.thought } : {}),
          ok,
          exitCode: result.exitCode,
          resultPreview: preview,
          ts: Date.now(),
        };
        pushStep(step);
        messages.push({
          role: 'user',
          content: ok
            ? `Command "${display}" exited 0 (success). Output (truncated):\n${preview}\nIf this completes the task, reply now with {"action":"final","answer":"...","code":"<the working code>","language":"..."}. If it built a web app, start the dev server on port ${PREVIEW_PORT} first.`
            : `Command "${display}" exited ${result.exitCode} (failure). Output (truncated):\n${preview}\nDiagnose the error, rewrite the ENTIRE affected file with a "write" action, then run again.`,
        });
      } catch (err) {
        const detail = (err as Error)?.message ?? 'sandbox_run_failed';
        this.logger.warn(`[openclaw] runCommandStreaming failed: ${detail}`);
        step = {
          i: steps.length + 1,
          kind: 'run',
          title: `$ ${display}`,
          ...(decision.thought ? { detail: decision.thought } : {}),
          ok: false,
          error: truncatePreview(detail),
          ts: Date.now(),
        };
        pushStep(step);
        messages.push({
          role: 'user',
          content: `Running "${display}" FAILED before completion: ${truncatePreview(detail, RESULT_FEEDBACK_CHAR_CAP)}. Try again, simplify the command, or fix the code.`,
        });
      }
    }

    // ---- cap hit with no final answer yet: one forced-final planner turn,
    // else a deterministic synthesized answer. ----
    if (answer === null) {
      if (!(await this.stopRequested(thread.id)) && !writer.closed) {
        const finalTry = await this.callPlanner(
          [
            ...messages,
            {
              role: 'user',
              content:
                'You have reached the step limit. Reply now with {"action":"final","answer":"...","code":"<final code>","language":"..."} summarizing the result. No more write/run actions.',
            },
          ],
          STREAM_PLANNER_TIMEOUT_MS
        );
        if (finalTry) {
          const d = parseClawJson(finalTry.raw);
          if (d.action === 'final') {
            answer = d.answer ?? '';
            finalDecision = d;
          }
        }
      }
      if (answer === null) {
        answer = this.synthesizeAnswer(steps, lastExitCode);
      }
    }

    // ---- stream the final natural-language answer token-by-token ----
    writer.emit({ type: 'status', phase: 'finalizing', label: 'Finalizing' });
    const streamed = await this.streamFinalAnswer(messages, answer, writer);
    const finalText = streamed || answer || '';

    // Surface any generated code + a preview link as artifacts on the answer.
    if (finalDecision?.code) {
      const lang =
        finalDecision.language ?? inferLanguage(null, runtime);
      writer.emit({
        type: 'artifact',
        artifact: { kind: 'output', label: `final code (${lang})`, text: finalDecision.code },
      });
    }
    if (previewUrl) {
      writer.emit({
        type: 'artifact',
        artifact: { kind: 'link', label: 'Live preview', url: previewUrl },
      });
    }

    // ---- persist the assistant turn + emit final (done follows on end()) ----
    await this.persistAssistant(userId, thread, finalText, steps, writer);
    void anyRunExecuted;
  }

  /**
   * Launch a dev server in the background and drive the preview lifecycle:
   * emit preview(starting) immediately, probe readiness (best-effort), then
   * emit preview(ready). Returns the (possibly refreshed) routes, the resolved
   * preview URL, and the step to append. Never throws.
   */
  private async launchDevServer(args: {
    userId: string;
    thread: AgentThread;
    sessionId: string;
    command: string;
    args: string[];
    display: string;
    routes: { url: string; port: number }[];
    thought?: string;
    writer: AgentSseWriterLike;
  }): Promise<{
    step: AgentStep;
    routes: { url: string; port: number }[];
    previewUrl: string | null;
  }> {
    const { sessionId, command, display, writer, thread, userId } = args;
    const routes = args.routes;
    writer.emit({
      type: 'status',
      phase: 'running',
      label: `Starting dev server: $ ${display}`,
    });

    // Refresh routes from the session if we somehow don't have one for 3000
    // (e.g. thread reconnected without stored routes).
    let previewUrl = getPreviewUrl(routes, PREVIEW_PORT);

    let step: AgentStep;
    try {
      const bg = await runCommandBackground(sessionId, command, args.args, {});
      const cmdId = bg.cmdId;
      // Emit preview(starting) as soon as we have a URL.
      if (previewUrl) {
        writer.emit({
          type: 'preview',
          url: previewUrl,
          port: PREVIEW_PORT,
          status: 'starting',
        });
      }
      // Best-effort readiness probe (keeps the SSE alive via the heartbeat).
      const ready = previewUrl
        ? await this.probePreviewReady(previewUrl, writer)
        : false;
      if (previewUrl) {
        writer.emit({
          type: 'preview',
          url: previewUrl,
          port: PREVIEW_PORT,
          status: 'ready',
        });
        // Refresh the thread's stored routes (URL is stable but keep it fresh).
        thread.updatedAt = Date.now();
        await this.runtime.saveThread(userId, thread);
      }
      step = {
        i: 0, // caller renumbers via steps.length; kept for shape completeness
        kind: 'run',
        title: `Started dev server: $ ${display}`,
        ...(args.thought ? { detail: args.thought } : {}),
        ok: true,
        resultPreview: previewUrl
          ? `dev server launched (cmd ${cmdId}); preview ${ready ? 'ready' : 'starting'} at ${previewUrl}`
          : `dev server launched (cmd ${cmdId}); no exposed preview route on port ${PREVIEW_PORT}`,
        ts: Date.now(),
      };
    } catch (err) {
      const detail = (err as Error)?.message ?? 'dev_server_launch_failed';
      this.logger.warn(`[openclaw] runCommandBackground failed: ${detail}`);
      step = {
        i: 0,
        kind: 'run',
        title: `Failed to start dev server: $ ${display}`,
        ...(args.thought ? { detail: args.thought } : {}),
        ok: false,
        error: truncatePreview(detail),
        ts: Date.now(),
      };
      previewUrl = null;
    }
    // step.i is authoritatively assigned by the caller's pushStep().
    return { step, routes, previewUrl };
  }

  /**
   * Poll the preview URL until it responds (any HTTP status counts as "the
   * server is up") or the readiness budget elapses. Best-effort; a failure just
   * returns false and the FE iframe loads the URL anyway. Emits a `previewing`
   * status while probing so the console shows progress + the heartbeat keeps
   * the SSE alive.
   */
  private async probePreviewReady(
    url: string,
    writer: AgentSseWriterLike
  ): Promise<boolean> {
    const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS;
    writer.emit({
      type: 'status',
      phase: 'previewing',
      label: 'Waiting for the dev server to respond',
    });
    while (Date.now() < deadline) {
      if (writer.closed) return false;
      try {
        const res = await this.fetchWithTimeout(
          url,
          { method: 'GET', redirect: 'manual' },
          PREVIEW_PROBE_INTERVAL_MS + 1_000
        );
        // Any response (even 4xx/5xx/3xx) means the server bound the port.
        if (res.status > 0) return true;
      } catch {
        // not up yet — keep polling
      }
      await new Promise(r => setTimeout(r, PREVIEW_PROBE_INTERVAL_MS));
    }
    return false;
  }

  /**
   * Stream the final answer token-by-token via cdz-flash (stream:true), emitting
   * `token` events (contract C1). Falls back to emitting the pre-computed
   * `fallback` answer as a single token when streaming can't open or produces
   * nothing. Returns the accumulated streamed text (or '' when it fell back).
   * Never throws.
   */
  private async streamFinalAnswer(
    loopMessages: Array<{ role: string; content: string }>,
    fallback: string | null,
    writer: AgentSseWriterLike
  ): Promise<string> {
    // Ask cdz-flash for a concise, plain-language wrap-up of the work so far.
    const messages = [
      ...loopMessages,
      {
        role: 'user',
        content:
          'Now write a concise, friendly final answer for the user in plain language (no JSON, no code fences). Summarize what you built or found, mention how to run or preview it if relevant, and be honest about anything that failed. 2-6 sentences.',
      },
    ];

    if (!CDZ_AI_KEY) {
      if (fallback) writer.emit({ type: 'token', text: fallback });
      return '';
    }

    let response: globalThis.Response | null = null;
    try {
      const controller = new AbortController();
      if (writer.closed) {
        if (fallback) writer.emit({ type: 'token', text: fallback });
        return '';
      }
      writer.onClose(() => controller.abort());
      response = await fetch(CDZ_PLANNER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CDZ_AI_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: CDZ_PLANNER_MODEL,
          messages,
          stream: true,
          max_tokens: FINAL_ANSWER_MAX_TOKENS,
          temperature: 0.3,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      this.logger.warn(
        `[openclaw] final stream open failed: ${(err as Error)?.message ?? err}`
      );
      if (fallback) writer.emit({ type: 'token', text: fallback });
      return '';
    }

    if (!response.ok || !response.body) {
      this.logger.warn(
        `[openclaw] final stream non-ok (${response.status}) [POST ${CDZ_PLANNER_PATH}]`
      );
      if (fallback) writer.emit({ type: 'token', text: fallback });
      return '';
    }

    // Consume the OpenAI-shape SSE token stream (same loop as the bridge's
    // streamCdzChat): split on \n\n, read data: lines, forward delta.content.
    const decoder = new TextDecoder();
    let buffer = '';
    let acc = '';
    let finished = false;
    try {
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (writer.closed) break;
        buffer += decoder.decode(bytes, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of rawEvent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            if (payload === '[DONE]') {
              finished = true;
              break;
            }
            try {
              const parsed = JSON.parse(payload) as {
                choices?: Array<{
                  delta?: { content?: unknown };
                  finish_reason?: string | null;
                }>;
              };
              const choice = parsed.choices?.[0];
              const text = choice?.delta?.content;
              if (typeof text === 'string' && text) {
                acc += text;
                writer.emit({ type: 'token', text });
              }
              if (choice?.finish_reason) finished = true;
            } catch {
              /* partial frame — the next chunk completes it */
            }
          }
          if (finished) break;
        }
        if (finished) break;
      }
    } catch (err) {
      this.logger.warn(
        `[openclaw] final stream read failed: ${(err as Error)?.message ?? err}`
      );
    }

    if (!acc.trim()) {
      if (fallback) writer.emit({ type: 'token', text: fallback });
      return '';
    }
    return acc;
  }

  /**
   * Honest degrade when the sandbox is unavailable: the cdz-flash planner still
   * GENERATES the complete solution (streamed as `file`+`artifact`), then a
   * `token` answer makes clear execution was unavailable. Real, not a stub.
   * Never invents runtime output. Persists the assistant turn + emits final.
   */
  private async streamPlanOnly(
    userId: string,
    thread: AgentThread,
    task: string,
    runtime: string,
    reason: string,
    writer: AgentSseWriterLike,
    persona?: string // R12: custom-agent persona; live callers omit ⇒ byte-identical
  ): Promise<void> {
    writer.emit({
      type: 'status',
      phase: 'planning',
      label: 'Sandbox unavailable — generating code without execution',
    });

    const messages: Array<{ role: string; content: string }> = [
      {
        role: 'system',
        content:
          (persona ? `Tu es un agent personnalisé. ${persona}\n\n` : '') +
          this.buildPlanOnlySystemPrompt(runtime),
      },
      ...this.priorTurns(thread),
      { role: 'user', content: task },
    ];

    const steps: AgentStep[] = [];
    let plannerCalls = 0;
    let finalDecision: ClawDecision | null = null;
    let salvagedCode: string | null = null;
    let salvagedLanguage: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (writer.closed) return;
      if (await this.stopRequested(thread.id)) break;
      const planned = await this.callPlanner(messages, STREAM_PLANNER_TIMEOUT_MS);
      if (planned === null) {
        if (plannerCalls === 0) {
          writer.emit({
            type: 'error',
            code: 'planner_unavailable',
            message:
              'The cdz-flash planner is currently unavailable. Please try again in a moment.',
          });
          await this.persistAssistant(
            userId,
            thread,
            'The planner was unavailable and the sandbox is offline, so nothing was produced.',
            steps,
            writer
          );
          return;
        }
        break;
      }
      plannerCalls++;
      messages.push({ role: 'assistant', content: planned.raw });
      const decision = parseClawJson(planned.raw);
      if (decision.action === 'final') {
        finalDecision = decision;
        break;
      }
      if (
        decision.action === 'write' &&
        typeof decision.content === 'string' &&
        decision.content.trim()
      ) {
        salvagedCode = decision.content;
        salvagedLanguage =
          decision.language ?? inferLanguage(decision.file ?? null, runtime);
        // Stream the generated file as a real artifact even though it can't run.
        const path = isSafeSandboxPath(decision.file ?? '')
          ? (decision.file as string)
          : runtime === 'python3.13'
            ? 'main.py'
            : 'main.js';
        const language = decision.language ?? inferLanguage(path, runtime);
        writer.emit({ type: 'file', op: 'write', path, language });
        writer.emit({
          type: 'artifact',
          artifact: {
            kind: 'file',
            path,
            language,
            bytes: Buffer.byteLength(decision.content, 'utf8'),
          },
        });
        steps.push({
          i: steps.length + 1,
          kind: 'write',
          title: `Generated ${path} (not executed)`,
          ...(decision.thought ? { detail: decision.thought } : {}),
          ok: true,
          resultPreview: 'generated by cdz-flash — sandbox unavailable, not run',
          ts: Date.now(),
        });
        writer.emit({ type: 'step', step: steps[steps.length - 1] });
      }
      messages.push({
        role: 'user',
        content:
          'The sandbox is UNAVAILABLE — you cannot write files or run commands. Reply now with JSON only: {"action":"final","answer":"<explanation>","code":"<complete code>","language":"..."}.',
      });
    }

    const code = finalDecision?.code ?? salvagedCode ?? null;
    const language = code
      ? (finalDecision?.language ??
        salvagedLanguage ??
        inferLanguage(null, runtime))
      : null;
    const answer =
      finalDecision?.answer ??
      (code
        ? 'I generated the solution code below. The execution sandbox is unavailable, so it was NOT run — review it before use.'
        : 'The planner could not produce a solution and the execution sandbox is unavailable. Please try again in a moment.');

    writer.emit({
      type: 'status',
      phase: 'finalizing',
      label: `Execution unavailable: ${truncatePreview(reason, 160)}`,
    });
    if (code) {
      writer.emit({
        type: 'artifact',
        artifact: {
          kind: 'output',
          label: `generated code (${language}) — not executed`,
          text: code,
        },
      });
    }
    // Stream the honest answer as a token so the FE renders it live.
    const streamed = await this.streamFinalAnswer(messages, answer, writer);
    const finalText = streamed || answer;

    await this.persistAssistant(userId, thread, finalText, steps, writer);
  }

  // =========================================================================
  // WS12 — stop + thread CRUD + files
  // =========================================================================

  /** POST /stop {threadId} → set the cooperative stop flag; 200. */
  @Throttle('strict')
  @Post('/api/v1/openclaw/stop')
  async stop(
    @CurrentUser() user: CurrentUser,
    @Body() body: any,
    @Res() res: Response
  ) {
    const threadId =
      typeof body?.threadId === 'string' ? body.threadId.trim() : '';
    if (!threadId) {
      throw new BadRequest('"threadId" is required');
    }
    // Only allow stopping a thread the caller owns.
    const thread = await this.runtime.getThread(user.id, threadId);
    if (!thread) {
      throw new NotFound('Thread not found');
    }
    await this.runtime.requestStop(threadId);
    res.status(200).json({ ok: true });
  }

  /** GET /threads → AgentThreadSummary[] for the current user. */
  // R13 (429 fix): own bucket (see /config above).
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/openclaw/threads')
  async listThreads(@CurrentUser() user: CurrentUser, @Res() res: Response) {
    const threads = await this.runtime.listThreads(user.id, AGENT_NAME);
    // WARDEN fix: return the bare array per contract C6 (GET /threads →
    // AgentThreadSummary[]) — HERMES + the FE api.ts listThreads expect an
    // array, not a {threads} envelope (Array.isArray() → [] otherwise).
    res.status(200).json(threads);
  }

  /** GET /threads/:id → the full AgentThread (messages + sandbox meta). */
  // R13 (429 fix): own bucket (see /config above) — thread detail is fetched
  // per open + per reattach, another drain on the shared default bucket.
  @Throttle('default', { limit: 300, ttl: 60_000 })
  @Get('/api/v1/openclaw/threads/:id')
  async getThreadById(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    const thread = await this.runtime.getThread(user.id, id);
    if (!thread) {
      throw new NotFound('Thread not found');
    }
    // WARDEN fix: return the bare AgentThread per contract C6 (GET /threads/:id
    // → AgentThread) — the FE api.ts getThread + use-agent-threads read the
    // thread directly (.messages/.sandbox), not a {thread} envelope.
    res.status(200).json(thread);
  }

  /** PATCH /threads/:id {title} → rename. */
  @Throttle('default')
  @Patch('/api/v1/openclaw/threads/:id')
  async patchThread(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Body() body: any,
    @Res() res: Response
  ) {
    const title =
      typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > THREAD_TITLE_MAX) {
      throw new BadRequest(
        `"title" must be a non-empty string (<= ${THREAD_TITLE_MAX} chars)`
      );
    }
    const thread = await this.runtime.getThread(user.id, id);
    if (!thread) {
      throw new NotFound('Thread not found');
    }
    await this.runtime.renameThread(user.id, id, title);
    res.status(200).json({ ok: true, id, title });
  }

  /**
   * DELETE /threads/:id → best-effort stop the thread's sandbox (this is the
   * ONE place OPENCLAW releases a persistent microVM), then delete the thread.
   */
  @Throttle('default')
  @Delete('/api/v1/openclaw/threads/:id')
  async deleteThread(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    const thread = await this.runtime.getThread(user.id, id);
    if (!thread) {
      throw new NotFound('Thread not found');
    }
    const sessionId = thread.sandbox?.sessionId;
    if (sessionId) {
      try {
        await stopSession(sessionId);
      } catch {
        // best-effort — the microVM also auto-expires at its own timeout.
      }
    }
    // Clear any stop flag alongside the thread so the key never orphans.
    try {
      await this.runtime.clearStop(id);
    } catch {
      /* best-effort */
    }
    await this.runtime.deleteThread(user.id, id);
    res.status(200).json({ ok: true, id });
  }

  /**
   * GET /threads/:id/files → the live file tree from the thread's sandbox:
   * [{path, bytes?, language?}] (language inferred from the extension). Returns
   * an empty list (never 500) when the thread has no live session or the list
   * fails — the FE just shows an empty tree.
   */
  @Throttle('default')
  @Get('/api/v1/openclaw/threads/:id/files')
  async listThreadFiles(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    const thread = await this.runtime.getThread(user.id, id);
    if (!thread) {
      throw new NotFound('Thread not found');
    }
    const sessionId = thread.sandbox?.sessionId;
    // WARDEN fix: return the bare array per contract C6 (GET /threads/:id/files
    // → {path,bytes?,language?}[]) — the FE api.ts listFiles does
    // Array.isArray(rows) and gets [] from a {files} envelope.
    if (!sessionId) {
      res.status(200).json([]);
      return;
    }
    try {
      const raw = await listFiles(sessionId, { max: 500 });
      const files = (raw ?? []).map(f => {
        const language = languageForPath(f.path);
        return {
          path: f.path,
          ...(typeof f.bytes === 'number' ? { bytes: f.bytes } : {}),
          ...(language ? { language } : {}),
        };
      });
      res.status(200).json(files);
    } catch (err) {
      this.logger.warn(
        `[openclaw] listFiles failed: ${(err as Error)?.message ?? err}`
      );
      // WS17: a 410/Gone ("Sandbox has stopped") means the session is dead.
      // Clear thread.sandbox + persist so the FE stops showing an empty tree
      // forever and the next turn recreates the session instead of reusing it.
      await this.clearStaleSandbox(user.id, thread, err);
      res.status(200).json([]);
    }
  }

  /**
   * GET /threads/:id/file?path= → {path, content, language}. 404 (typed) when
   * the thread is missing; 400 for a missing/invalid path. When the file can't
   * be read (no session / gone) content is returned empty rather than 500.
   */
  @Throttle('default')
  @Get('/api/v1/openclaw/threads/:id/file')
  async readThreadFile(
    @CurrentUser() user: CurrentUser,
    @Param('id') id: string,
    @Query('path') path: string,
    @Res() res: Response
  ) {
    const rel = typeof path === 'string' ? path.trim() : '';
    if (!isSafeSandboxPath(rel)) {
      throw new BadRequest(
        '"path" must be a safe relative path (letters, digits, . _ - / only; no leading "/", no "..")'
      );
    }
    const thread = await this.runtime.getThread(user.id, id);
    if (!thread) {
      throw new NotFound('Thread not found');
    }
    const language = languageForPath(rel) ?? 'text';
    const sessionId = thread.sandbox?.sessionId;
    if (!sessionId) {
      res.status(200).json({ path: rel, content: '', language });
      return;
    }
    try {
      const content = await readFile(sessionId, rel);
      res
        .status(200)
        .json({ path: rel, content: typeof content === 'string' ? content : '', language });
    } catch (err) {
      this.logger.warn(
        `[openclaw] readFile failed: ${(err as Error)?.message ?? err}`
      );
      // WS17: clear the stale session on a 410/Gone (mirrors listThreadFiles).
      await this.clearStaleSandbox(user.id, thread, err);
      res.status(200).json({ path: rel, content: '', language });
    }
  }

  /**
   * WS17: when a sandbox read (listFiles/readFile) fails with a 410/Gone
   * ("Sandbox has stopped execution and is no longer available"), the session
   * is dead. Clear `thread.sandbox` and persist so (a) the FE stops showing an
   * empty file tree forever, and (b) the next /stream turn recreates the
   * session via ensurePersistentSandbox instead of reusing the dead one.
   * Fail-soft (a save error only delays recovery to the next turn). Best-effort
   * stopSession on the dead id (no-op if already gone).
   */
  private async clearStaleSandbox(
    userId: string,
    thread: { sandbox?: { sessionId?: string } } | null,
    err: unknown
  ): Promise<void> {
    if (!thread || !thread.sandbox?.sessionId) return;
    const isGone =
      (err instanceof SandboxError &&
        (err.status === 410 || err.code === 'api_error')) ||
      (err instanceof Error && /stopped|410|no longer available/i.test(err.message));
    if (!isGone) return;
    const deadId = thread.sandbox.sessionId;
    try {
      thread.sandbox = undefined;
      await this.runtime.saveThread(userId, thread as never);
      this.logger.log(
        `[openclaw] cleared stale sandbox session=${deadId} (410/Gone)`
      );
    } catch (e) {
      this.logger.warn(
        `[openclaw] clearStaleSandbox save failed: ${(e as Error)?.message ?? e}`
      );
    }
    // Best-effort stop (the session is already gone; this is a no-op then).
    try {
      await stopSession(deadId);
    } catch {
      /* already gone */
    }
  }

  // =========================================================================
  // LEGACY — POST /api/v1/openclaw/run  (WS11, UNCHANGED)
  // =========================================================================
  //
  //   body {task: string (1..4000), runtime?: 'node24'|'python3.13'}
  //
  // One-shot plan→act loop with an EPHEMERAL sandbox stopped in a finally.
  // Kept verbatim for backward compatibility (the WS11 FE + any external
  // callers). The new console uses /stream instead.
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/openclaw/run')
  async run(
    @CurrentUser() _user: CurrentUser,
    @Body() body: any,
    @Res() res: Response
  ) {
    // ---- input validation (typed 400 for genuinely malformed input) ----
    const task = typeof body?.task === 'string' ? body.task.trim() : '';
    if (task.length < CLAW_TASK_MIN || task.length > CLAW_TASK_MAX) {
      throw new BadRequest(
        `"task" must be a string of ${CLAW_TASK_MIN}..${CLAW_TASK_MAX} chars`
      );
    }
    const runtimeRaw =
      typeof body?.runtime === 'string' ? body.runtime.trim() : '';
    if (runtimeRaw && !OPENCLAW_RUNTIMES.includes(runtimeRaw)) {
      throw new BadRequest(
        `"runtime" must be one of: ${OPENCLAW_RUNTIMES.join(', ')}`
      );
    }
    const runtime = runtimeRaw || OPENCLAW_DEFAULT_RUNTIME;

    // Wall-clock budget for the WHOLE request (probe + session + loop).
    const deadline = Date.now() + CLAW_WALL_CLOCK_MS;
    const timeLeft = () => deadline - Date.now();

    // (a) capability probe — degrade to plan-only (real codegen, honestly
    // marked not-executed) when the sandbox is unavailable.
    const capability = await this.probeSandbox();
    if (!capability.sandbox) {
      await this.runPlanOnly(
        task,
        runtime,
        capability.reason ??
          'Vercel Sandbox is not available for this deployment',
        timeLeft,
        res
      );
      return;
    }

    // (b) create the sandbox session; failure degrades to plan-only too.
    let sessionId: string;
    try {
      const session = await createSession({
        runtime,
        timeoutMs: CLAW_SESSION_TIMEOUT_MS,
      });
      sessionId = session.sessionId;
    } catch (err) {
      // D2 — project onto the discriminated reason so a 429/402 reads distinctly
      // (at-capacity vs billing vs auth) instead of a bare message. Behavior is
      // unchanged: legacy /run still degrades to plan-only and returns.
      const failure = describeSandboxError(err);
      const detail =
        failure.detail || (err as Error)?.message || 'sandbox_session_failed';
      this.logger.warn(
        `[openclaw] createSession failed (reason=${failure.reason}${
          typeof failure.status === 'number' ? ` status=${failure.status}` : ''
        }): ${detail}`
      );
      await this.runPlanOnly(
        task,
        runtime,
        `sandbox session could not be created (${failure.reason}): ${detail}`,
        timeLeft,
        res
      );
      return;
    }

    try {
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: this.buildSandboxSystemPrompt(runtime) },
        { role: 'user', content: task },
      ];

      const steps: ClawStep[] = [];
      let iterations = 0;
      let answer: string | null = null;
      let finalDecision: ClawDecision | null = null;
      let lastCode: string | null = null;
      let lastLanguage: string | null = null;
      let lastOutput: string | null = null;
      let lastExitCode: number | null = null;
      let anyRunExecuted = false;

      // ---- (c) the write/run loop ----
      while (iterations < CLAW_MAX_ITERATIONS && timeLeft() > 0) {
        const planned = await this.callPlanner(messages, timeLeft());

        // Planner unreachable BEFORE any step -> typed 502. Once we have
        // steps we prefer to synthesize a partial answer instead of 502ing.
        if (planned === null) {
          if (steps.length === 0) {
            res.status(502).json({ error: 'planner_unavailable' });
            return;
          }
          answer = this.synthesizeAnswerLegacy(steps, lastExitCode);
          break;
        }

        // Record the assistant's raw turn so the model sees its own history.
        messages.push({ role: 'assistant', content: planned.raw });

        const decision = parseClawJson(planned.raw);

        if (decision.action === 'final') {
          answer = decision.answer ?? '';
          finalDecision = decision;
          break;
        }

        if (decision.action === 'write') {
          const file = decision.file ?? '';
          const content = decision.content;
          // Guard malformed writes: counts an iteration (keeps the loop
          // bounded), feeds a correction back, records no step.
          if (
            !isSafeSandboxPath(file) ||
            typeof content !== 'string' ||
            content.length === 0 ||
            content.length > WRITE_CONTENT_MAX_CHARS
          ) {
            iterations++;
            messages.push({
              role: 'user',
              content: `Invalid write action. "file" must be a relative path (letters, digits, . _ - / only; no leading "/", no ".."), and "content" must be the complete non-empty file text (<= ${WRITE_CONTENT_MAX_CHARS} chars). Reply with corrected JSON.`,
            });
            continue;
          }
          iterations++;
          let step: ClawStep;
          try {
            await writeFile(sessionId, file, content);
            lastCode = content;
            lastLanguage = decision.language ?? inferLanguage(file, runtime);
            step = {
              i: steps.length + 1,
              ...(decision.thought ? { thought: decision.thought } : {}),
              action: 'write',
              file,
              ok: true,
              outputPreview: `wrote ${content.length} chars to ${file}`,
            };
            messages.push({
              role: 'user',
              content: `File ${file} written (${content.length} chars). Continue: write more files if needed, or run a command to execute the code.`,
            });
          } catch (err) {
            const detail = (err as Error)?.message ?? 'sandbox_write_failed';
            this.logger.warn(`[openclaw] writeFile ${file} failed: ${detail}`);
            step = {
              i: steps.length + 1,
              ...(decision.thought ? { thought: decision.thought } : {}),
              action: 'write',
              file,
              ok: false,
              error: truncatePreview(detail),
            };
            messages.push({
              role: 'user',
              content: `Writing ${file} FAILED: ${truncatePreview(detail, RESULT_FEEDBACK_CHAR_CAP)}. Adjust (e.g. a simpler relative path) and retry.`,
            });
          }
          steps.push(step);
          continue;
        }

        // decision.action === 'run'
        const command = decision.command ?? '';
        const args = Array.isArray(decision.args) ? decision.args : [];
        const argsOk =
          args.length <= RUN_ARGS_MAX &&
          args.every(a => a.length <= RUN_ARG_MAX_CHARS);
        if (!command || command.length > COMMAND_MAX_CHARS || !argsOk) {
          iterations++;
          messages.push({
            role: 'user',
            content:
              'Invalid run action. "command" must be a short executable name (e.g. "node", "python3", "bash") and "args" an array of strings. Reply with corrected JSON.',
          });
          continue;
        }
        iterations++;
        const display = truncatePreview(
          [command, ...args].join(' '),
          COMMAND_DISPLAY_CHAR_CAP
        );
        let step: ClawStep;
        try {
          const result = await runCommand(sessionId, command, args, {
            timeoutMs: Math.max(1, Math.min(CLAW_RUN_TIMEOUT_MS, timeLeft())),
          });
          anyRunExecuted = true;
          lastExitCode = result.exitCode;
          lastOutput = combineOutput(result.stdout, result.stderr);
          const preview = truncatePreview(lastOutput || '(no output)');
          const ok = result.exitCode === 0;
          step = {
            i: steps.length + 1,
            ...(decision.thought ? { thought: decision.thought } : {}),
            action: 'run',
            command: display,
            exitCode: result.exitCode,
            outputPreview: preview,
            ok,
          };
          messages.push({
            role: 'user',
            content: ok
              ? `Command "${display}" exited 0 (success). Output (truncated):\n${preview}\nIf this completes the task, reply now with {"action":"final","answer":"...","code":"<the working code>","language":"..."}.`
              : `Command "${display}" exited ${result.exitCode} (failure). Output (truncated):\n${preview}\nDiagnose the error, rewrite the ENTIRE file with a "write" action, then run again.`,
          });
        } catch (err) {
          const detail = (err as Error)?.message ?? 'sandbox_run_failed';
          this.logger.warn(`[openclaw] runCommand failed: ${detail}`);
          step = {
            i: steps.length + 1,
            ...(decision.thought ? { thought: decision.thought } : {}),
            action: 'run',
            command: display,
            ok: false,
            error: truncatePreview(detail),
          };
          messages.push({
            role: 'user',
            content: `Running "${display}" FAILED before completion: ${truncatePreview(detail, RESULT_FEEDBACK_CHAR_CAP)}. Try again, simplify the command, or fix the code.`,
          });
        }
        steps.push(step);
      }

      // ---- (d) cap hit with no final answer yet: one forced-final planner
      // turn (best-effort), else a deterministic synthesized answer. ----
      if (answer === null) {
        const finalTry =
          timeLeft() > 1_000
            ? await this.callPlanner(
                [
                  ...messages,
                  {
                    role: 'user',
                    content:
                      'You have reached the step limit. Reply now with {"action":"final","answer":"...","code":"<final code>","language":"..."} summarizing the result. No more write/run actions.',
                  },
                ],
                timeLeft()
              )
            : null;
        if (finalTry) {
          const d = parseClawJson(finalTry.raw);
          if (d.action === 'final') {
            answer = d.answer ?? '';
            finalDecision = d;
          }
        }
        if (answer === null) {
          answer = this.synthesizeAnswerLegacy(steps, lastExitCode);
        }
      }

      const code = lastCode ?? finalDecision?.code ?? null;
      const language = code
        ? (lastLanguage ?? finalDecision?.language ?? inferLanguage(null, runtime))
        : null;

      res.status(200).json({
        ok: true,
        answer,
        steps,
        ...(code ? { code } : {}),
        ...(language ? { language } : {}),
        ...(lastOutput !== null
          ? { output: truncatePreview(lastOutput, OUTPUT_RESPONSE_CHAR_CAP) }
          : {}),
        executed: anyRunExecuted,
        sandbox: true,
        iterations,
      });
    } finally {
      // (e) ALWAYS free the microVM for the LEGACY one-shot path. stopSession is
      // best-effort per contract (swallows errors). NOTE: the /stream endpoint
      // deliberately does NOT do this — its session persists on the thread.
      try {
        await stopSession(sessionId);
      } catch {
        // best-effort — the sandbox also auto-expires at its own timeout.
      }
    }
  }

  // ---- shared internals ---------------------------------------------------

  /**
   * sandboxCapability() never throws per contract — this belt-and-braces
   * wrapper makes sure /run, /stream and /capabilities can never 500 on a
   * client regression.
   */
  private async probeSandbox(): Promise<{ sandbox: boolean; reason?: string }> {
    try {
      return await sandboxCapability();
    } catch (err) {
      const detail = (err as Error)?.message ?? 'capability_probe_failed';
      this.logger.warn(`[openclaw] sandboxCapability threw: ${detail}`);
      return { sandbox: false, reason: detail };
    }
  }

  /** Cooperative stop check — defensive (a Redis blip never crashes the loop). */
  private async stopRequested(threadId: string): Promise<boolean> {
    try {
      return await this.runtime.isStopRequested(threadId);
    } catch {
      return false;
    }
  }

  /**
   * Persist the completed assistant turn on the thread, then emit the `final`
   * frame (the terminal `done` frame is written by the caller's writer.end() in
   * the /stream finally, per the C1 wire format). Defensive: a persistence blip
   * must not stop the client from receiving its turn.
   */
  private async persistAssistant(
    userId: string,
    thread: AgentThread,
    content: string,
    steps: AgentStep[],
    writer: AgentSseWriterLike
  ): Promise<void> {
    const assistant: AgentMessage = {
      id: this.randomId('msg'),
      role: 'assistant',
      content: content || '',
      steps: steps.length ? steps : undefined,
      createdAt: Date.now(),
      agent: AGENT_NAME,
    };
    try {
      thread.messages.push(assistant);
      thread.updatedAt = Date.now();
      await this.runtime.saveThread(userId, thread);
    } catch (err) {
      this.logger.warn(
        `[openclaw] saveThread (assistant) failed: ${(err as Error)?.message ?? err}`
      );
    }
    // Emit the completed, persisted turn regardless of persistence success (the
    // client still gets it); writer.end() appends the terminal done frame.
    if (!writer.closed) {
      writer.emit({ type: 'final', message: assistant });
    }
  }

  /** Turn the persisted thread history into planner-visible prior turns. */
  private priorTurns(
    thread: AgentThread
  ): Array<{ role: string; content: string }> {
    const turns: Array<{ role: string; content: string }> = [];
    // Exclude the just-appended user message (it's added explicitly by the
    // caller); include everything before it, capped to keep context bounded.
    const history = thread.messages.slice(0, -1).slice(-8);
    for (const m of history) {
      if (m.role === 'user' || m.role === 'assistant') {
        turns.push({ role: m.role, content: truncatePreview(m.content, 4_000) });
      }
    }
    return turns;
  }

  private isInstallCommand(command: string, args: string[]): boolean {
    const joined = [command, ...args].join(' ').toLowerCase();
    return (
      /\b(npm|pnpm|yarn|bun)\s+(install|i|add)\b/.test(joined) ||
      /\bpip3?\s+install\b/.test(joined)
    );
  }

  private deriveTitle(message: string): string {
    const oneLine = message.replace(/\s+/g, ' ').trim();
    if (!oneLine) return 'New coding session';
    return oneLine.length <= 60 ? oneLine : oneLine.slice(0, 57) + '…';
  }

  private randomId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }

  /** Compose the STREAM-mode planner system prompt (multi-file + dev server). */
  private buildStreamSystemPrompt(runtime: string, task: string): string {
    const isPython = runtime === 'python3.13';
    const writeExample = isPython
      ? '{"action":"write","thought":"first draft","file":"main.py","content":"<COMPLETE file content>"}'
      : '{"action":"write","thought":"first draft","file":"index.js","content":"<COMPLETE file content>"}';
    const runExample = isPython
      ? '{"action":"run","thought":"execute it","command":"python3","args":["main.py"]}'
      : '{"action":"run","thought":"execute it","command":"node","args":["index.js"]}';
    const webHint = taskWantsWebApp(task)
      ? [
          '',
          'This task looks like a WEB APP. When the app is ready, start a dev',
          `server bound to 0.0.0.0 on PORT ${PREVIEW_PORT} as a "run" action —`,
          'e.g. {"action":"run","command":"npm","args":["run","dev"]} or',
          `{"action":"run","command":"python3","args":["-m","http.server","${PREVIEW_PORT}"]}.`,
          `A LIVE PREVIEW of port ${PREVIEW_PORT} is shown to the user automatically.`,
          'You MAY install dependencies (npm install / pip install) — the sandbox',
          'has full internet egress.',
        ]
      : [
          '',
          'You MAY install dependencies (npm install / pip install) if needed —',
          'the sandbox has full internet egress.',
        ];
    return [
      "You are OPENCLAW, ClickDz's autonomous coding agent, working inside a",
      `PERSISTENT Vercel Sandbox (runtime ${runtime}, cwd /vercel/sandbox). Files`,
      'and the running process persist across your actions AND across turns in',
      'this conversation. Write code, run it, read the REAL output, and iterate',
      'until it works.',
      '',
      'RESPOND WITH JSON ONLY — no prose, no markdown, no code fences. Exactly one of:',
      `  ${writeExample}`,
      `  ${runExample}`,
      '  {"action":"final","thought":"...","answer":"<plain-language result>","code":"<the final key file>","language":"..."}',
      ...webHint,
      '',
      'Rules:',
      '- "content" must be the COMPLETE file (never a diff). To fix a file, rewrite it whole.',
      '- Use relative file paths (letters, digits, . _ - / only; no leading "/", no "..").',
      '- After each run you receive the real exit code and output. Exit 0 = success.',
      '- Non-zero exit: read the error, "write" the fixed file, then "run" again.',
      `- You have at most ${STREAM_MAX_ITERATIONS} write/run actions. Be economical.`,
      '- When done, reply with the "final" action.',
    ].join('\n');
  }

  /** Compose the legacy sandbox-mode planner system prompt (WS11, unchanged). */
  private buildSandboxSystemPrompt(runtime: string): string {
    const isPython = runtime === 'python3.13';
    const writeExample = isPython
      ? '{"action":"write","thought":"first draft","file":"main.py","content":"<COMPLETE file content>"}'
      : '{"action":"write","thought":"first draft","file":"main.js","content":"<COMPLETE file content>"}';
    const runExample = isPython
      ? '{"action":"run","thought":"execute it","command":"python3","args":["main.py"]}'
      : '{"action":"run","thought":"execute it","command":"node","args":["main.js"]}';
    return [
      "You are OPENCLAW, ClickDz's autonomous coding agent. Solve the user's",
      `coding task inside an isolated Vercel Sandbox (runtime ${runtime}, cwd`,
      '/vercel/sandbox, files persist between your actions). Write code, run it,',
      'read the REAL output, and fix errors until the program runs successfully.',
      '',
      'RESPOND WITH JSON ONLY — no prose, no markdown, no code fences. Exactly one of:',
      `  ${writeExample}`,
      `  ${runExample}`,
      '  {"action":"final","thought":"...","answer":"<plain-language result for the user>","code":"<the final working code>","language":"python|javascript|..."}',
      '',
      'Rules:',
      '- "content" must be the COMPLETE file (never a diff). To fix a file, rewrite it whole.',
      '- Use relative file paths (letters, digits, . _ - / only; no leading "/", no "..").',
      '- After each run you receive the real exit code and output. Exit code 0 with',
      '  correct output = success: reply with the "final" action including the working',
      '  code and what the output shows.',
      '- Non-zero exit: read the error, "write" the fixed file, then "run" again.',
      '- No package installs (no network registry) — standard library only.',
      `- You have at most ${CLAW_MAX_ITERATIONS} write/run actions total. Be economical:`,
      '  usually one write then one run.',
    ].join('\n');
  }

  /** Compose the plan-only (sandbox unavailable) system prompt. */
  private buildPlanOnlySystemPrompt(runtime: string): string {
    const lang =
      runtime === 'python3.13' ? 'Python 3.13' : 'Node.js 24 JavaScript';
    return [
      "You are OPENCLAW, ClickDz's coding agent. The execution sandbox is",
      `currently UNAVAILABLE, so you cannot run anything. Produce the best`,
      `complete ${lang} solution for the user's task anyway.`,
      '',
      'RESPOND WITH JSON ONLY — no prose, no markdown, no code fences:',
      '  {"action":"write","file":"...","content":"<complete file>"}  (optional, to surface the code as a file)',
      '  {"action":"final","answer":"<what the code does + how to run it + note that it was NOT executed>","code":"<the COMPLETE runnable code>","language":"python|javascript"}',
      '',
      'Rules:',
      '- "code" must be complete, runnable file content.',
      '- NEVER claim the code was executed and NEVER invent runtime output.',
    ].join('\n');
  }

  /**
   * One planner turn against cdz-flash (direct CDZ_AI, OpenAI-compatible) —
   * same mechanics as clickdz-integrations.controller.ts callPlanner. Returns
   * {raw} on a clean 2xx with string content, or null on ANY failure (no key,
   * non-2xx, timeout, empty). Never throws; never logs key material.
   */
  private async callPlanner(
    messages: Array<{ role: string; content: string }>,
    remainingMs: number
  ): Promise<{ raw: string } | null> {
    if (!CDZ_AI_KEY) {
      return null;
    }
    // Lazy, once-only: surface the resolved planner base+path (NO key) so a
    // future 404/misconfig self-diagnoses from a single log line.
    if (!this.plannerUrlLogged) {
      this.plannerUrlLogged = true;
      this.logger.log(
        `[openclaw] planner resolved: base=${CDZ_AI_BASE_URL} path=${CDZ_PLANNER_PATH} model=${CDZ_PLANNER_MODEL}`
      );
    }
    const timeoutMs = Math.max(1, Math.min(CLAW_PLANNER_TIMEOUT_MS, remainingMs));
    try {
      const response = await this.fetchWithTimeout(
        CDZ_PLANNER_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CDZ_AI_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: CDZ_PLANNER_MODEL,
            messages,
            max_tokens: PLANNER_MAX_TOKENS,
            temperature: 0.1,
          }),
        },
        timeoutMs
      );
      const data = (await response.json().catch(() => null)) as any;
      const content = data?.choices?.[0]?.message?.content;
      if (response.ok && typeof content === 'string' && content.trim()) {
        return { raw: content };
      }
      // Include upstream status + the exact path we hit so the next incident
      // is self-diagnosing (e.g. a 404 vs a 401, and against which segment).
      this.logger.warn(
        `[openclaw] planner non-ok (${response.status}) or empty content [POST ${CDZ_PLANNER_PATH}]`
      );
      return null;
    } catch (err) {
      this.logger.warn(
        `[openclaw] planner call failed: ${(err as Error)?.message ?? err}`
      );
      return null;
    }
  }

  /**
   * Plan-only degrade for LEGACY /run (sandbox unavailable / session create
   * failed): the cdz-flash planner still GENERATES the full solution code +
   * explanation, returned {ok:true, executed:false, sandbox:false, reason,…}.
   * Runtime output is NEVER invented. (WS11 behaviour, unchanged.)
   */
  private async runPlanOnly(
    task: string,
    runtime: string,
    reason: string,
    timeLeft: () => number,
    res: Response
  ): Promise<void> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: this.buildPlanOnlySystemPrompt(runtime) },
      { role: 'user', content: task },
    ];

    let plannerCalls = 0;
    let finalDecision: ClawDecision | null = null;
    let salvagedCode: string | null = null;
    let salvagedLanguage: string | null = null;
    let salvagedThought: string | null = null;

    for (let attempt = 0; attempt < 2 && timeLeft() > 0; attempt++) {
      const planned = await this.callPlanner(messages, timeLeft());
      if (planned === null) {
        // Planner unreachable before producing anything -> typed 502.
        if (plannerCalls === 0) {
          res.status(502).json({ error: 'planner_unavailable' });
          return;
        }
        break;
      }
      plannerCalls++;
      messages.push({ role: 'assistant', content: planned.raw });
      const decision = parseClawJson(planned.raw);
      if (decision.action === 'final') {
        finalDecision = decision;
        break;
      }
      if (
        decision.action === 'write' &&
        typeof decision.content === 'string' &&
        decision.content.trim()
      ) {
        salvagedCode = decision.content;
        salvagedLanguage =
          decision.language ?? inferLanguage(decision.file ?? null, runtime);
        salvagedThought = decision.thought ?? null;
      }
      messages.push({
        role: 'user',
        content:
          'The sandbox is UNAVAILABLE — you cannot write files or run commands. Reply now with JSON only: {"action":"final","answer":"<explanation>","code":"<complete code>","language":"..."}.',
      });
    }

    const code = finalDecision?.code ?? salvagedCode ?? null;
    const language = code
      ? (finalDecision?.language ??
        salvagedLanguage ??
        inferLanguage(null, runtime))
      : null;
    const answer =
      finalDecision?.answer ??
      (code
        ? 'I generated the solution code below. The execution sandbox is unavailable, so it was NOT run — review it before use.'
        : 'The planner could not produce a solution and the execution sandbox is unavailable. Please try again in a moment.');
    const thought = finalDecision?.thought ?? salvagedThought;

    const steps: ClawStep[] = [
      {
        i: 1,
        ...(thought ? { thought } : {}),
        action: 'final',
        ok: !!finalDecision || !!code,
        outputPreview: code
          ? 'code generated by cdz-flash — not executed (sandbox unavailable)'
          : 'no code produced — sandbox unavailable, nothing executed',
      },
    ];

    res.status(200).json({
      ok: true,
      answer,
      steps,
      ...(code ? { code } : {}),
      ...(language ? { language } : {}),
      executed: false,
      sandbox: false,
      reason,
      iterations: plannerCalls,
    });
  }

  /** Deterministic fallback answer for STREAM steps (AgentStep shape). */
  private synthesizeAnswer(
    steps: AgentStep[],
    lastExitCode: number | null
  ): string {
    if (steps.length === 0) {
      return "I couldn't complete the task — the planner was unavailable and no sandbox steps ran. Please try again in a moment.";
    }
    const writes = steps.filter(s => s.kind === 'write').length;
    const runs = steps.filter(s => s.kind === 'run').length;
    const status =
      lastExitCode === 0
        ? 'the last run exited 0 (success)'
        : lastExitCode === null
          ? 'no run completed'
          : `the last run exited ${lastExitCode}`;
    return `I performed ${steps.length} sandbox step(s) (${writes} write, ${runs} run); ${status}. Reached the step/time limit before a final summary — review the step timeline and terminal for details.`;
  }

  /** Deterministic fallback answer for LEGACY /run (ClawStep shape). */
  private synthesizeAnswerLegacy(
    steps: ClawStep[],
    lastExitCode: number | null
  ): string {
    if (steps.length === 0) {
      return "I couldn't complete the task — the planner was unavailable and no sandbox steps ran. Please try again in a moment.";
    }
    const writes = steps.filter(s => s.action === 'write').length;
    const runs = steps.filter(s => s.action === 'run').length;
    const status =
      lastExitCode === 0
        ? 'the last run exited 0 (success)'
        : lastExitCode === null
          ? 'no run completed'
          : `the last run exited ${lastExitCode}`;
    return `I performed ${steps.length} sandbox step(s) (${writes} write, ${runs} run); ${status}. Reached the step/time limit before a final summary — review the step timeline and output for details.`;
  }

  // =========================================================================
  // R6 — DETACHED background run (agent='openclaw'). Additive; only ever
  // reached from Moteur's `copilot.agent.run` @OnJob handler (itself gated
  // CDZ_AGENTS_ENABLED). Reuses the EXISTING request-scoped code paths
  // (probeSandbox / ensurePersistentSandbox / streamAgentLoop / streamPlanOnly)
  // by driving them through an emit-backed writer instead of a live Express SSE
  // — no fork of the plan→act logic. The ONLY behavioural difference from
  // /stream is (a) the emit sink + AbortSignal replace openStream(), and (b) the
  // thread's sandbox is torn down in the finally to respect the run budget (a
  // background run is not a warm interactive session — no leaked microVMs).
  //
  // Signature matches the work-item seam runOpenclawLoop(deps, {prompt,
  // threadId, emit, signal, budget}); the free-function export at module scope
  // forwards to this method. NEVER throws — Moteur folds the returned
  // {state,finalText,error,threadId} onto the run record; wall-clock/stop are
  // cooperative via the AbortSignal (mapped to writer.closed) + the runtime stop
  // flag. Steps still stream through emit exactly as on the live console.
  // -------------------------------------------------------------------------
  async runOpenclawLoop(args: OpenclawLoopArgs): Promise<OpenclawLoopResult> {
    const userId = typeof args?.userId === 'string' ? args.userId : '';
    const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
    const emit: OpenclawRunEmit =
      typeof args?.emit === 'function' ? args.emit : () => {};
    const signal = args?.signal;

    // The detached run is bounded by Moteur's wall-clock budget. Fuse that onto
    // a local AbortController so an EXTERNAL abort (Moteur's own signal) and the
    // wall-clock deadline both flip the writer to closed — the reused loops poll
    // writer.closed each iteration and abort cooperatively with no extra wiring.
    const wallMs =
      typeof args?.budget?.maxWallMs === 'number' &&
      Number.isFinite(args.budget.maxWallMs) &&
      args.budget.maxWallMs > 0
        ? args.budget.maxWallMs
        : STREAM_SESSION_TIMEOUT_MS;
    const ac = new AbortController();
    const onExternalAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const wallTimer = setTimeout(() => ac.abort(), wallMs);

    let thread: AgentThread | null = null;
    let threadId: string | null = null;
    let finalText = '';
    let capturedFinal = '';
    // Sniff the persisted assistant turn out of the terminal `final` frame so we
    // can hand Moteur an authoritative finalText without re-reading the thread.
    // The writer's forward sink IS this closure, so it also fans out to Moteur.
    const sink: OpenclawRunEmit = ev => {
      try {
        if (ev && (ev as { type?: string }).type === 'final') {
          const msg = (ev as { message?: AgentMessage }).message;
          if (msg && typeof msg.content === 'string') capturedFinal = msg.content;
        }
      } catch {
        /* best-effort — never let sniffing break the forward */
      }
      emit(ev);
    };
    const writer = new EmitBackedSseWriter(sink, ac.signal);

    try {
      // ---- validate the prompt (in-band error frame, never a throw) ----
      if (prompt.length < CLAW_TASK_MIN || prompt.length > CLAW_TASK_MAX) {
        writer.emit({
          type: 'error',
          code: 'bad_request',
          message: `"prompt" must be a string of ${CLAW_TASK_MIN}..${CLAW_TASK_MAX} chars`,
        });
        return { state: 'failed', error: 'bad_request' };
      }

      // ---- resolve the runtime (validate like /stream; default when absent) --
      const runtimeRaw =
        typeof args?.runtime === 'string' ? args.runtime.trim() : '';
      if (runtimeRaw && !OPENCLAW_RUNTIMES.includes(runtimeRaw)) {
        writer.emit({
          type: 'error',
          code: 'bad_request',
          message: `"runtime" must be one of: ${OPENCLAW_RUNTIMES.join(', ')}`,
        });
        return { state: 'failed', error: 'bad_request' };
      }
      const requestedRuntime = runtimeRaw || OPENCLAW_DEFAULT_RUNTIME;

      // ---- resolve or create the thread (same rules as /stream) ----
      const requestedThreadId =
        typeof args?.threadId === 'string' && args.threadId.trim()
          ? args.threadId.trim()
          : null;
      if (requestedThreadId) {
        thread = await this.runtime.getThread(userId, requestedThreadId);
        if (!thread) {
          writer.emit({
            type: 'error',
            code: 'not_found',
            message: 'Thread not found',
          });
          return { state: 'failed', error: 'not_found' };
        }
      } else {
        thread = await this.runtime.createThread(
          userId,
          AGENT_NAME,
          this.deriveTitle(prompt)
        );
      }
      threadId = thread.id;

      // A fresh run supersedes any stale stop flag from a prior turn.
      await this.runtime.clearStop(threadId);

      // Mirror the external abort onto the cooperative stop flag so the reused
      // loop's stopRequested() poll short-circuits too (belt-and-braces with the
      // writer.closed check the loop already performs).
      const requestStopOnAbort = () => {
        void this.runtime.requestStop(threadId as string).catch(() => {});
      };
      if (ac.signal.aborted) requestStopOnAbort();
      else ac.signal.addEventListener('abort', requestStopOnAbort, { once: true });

      const runtime = thread.sandbox?.runtime || requestedRuntime;

      // ---- append the user message + announce the thread (as /stream does) ---
      const userMessage: AgentMessage = {
        id: this.randomId('msg'),
        role: 'user',
        content: prompt,
        createdAt: Date.now(),
        agent: AGENT_NAME,
      };
      thread.messages.push(userMessage);
      thread.updatedAt = Date.now();
      await this.runtime.saveThread(userId, thread);

      writer.emit({
        type: 'thread',
        threadId: thread.id,
        agent: AGENT_NAME,
        title: thread.title,
      });

      // ---- ensure a sandbox, then drive the SAME loop as the live console ----
      writer.emit({
        type: 'status',
        phase: 'planning',
        label: 'Preparing workspace',
      });
      const capability = await this.probeSandbox();

      if (!capability.sandbox) {
        await this.streamPlanOnly(
          userId,
          thread,
          prompt,
          runtime,
          capability.reason ??
            'Vercel Sandbox is not available for this deployment',
          writer,
          args.persona // R12
        );
      } else {
        const ready = await this.ensurePersistentSandbox(
          userId,
          thread,
          runtime,
          writer
        );
        if (!ready.ok) {
          // D2 — distinct reason (at-capacity / billing / auth / timeout) instead
          // of the old single generic string; falls back to it if unset.
          await this.streamPlanOnly(
            userId,
            thread,
            prompt,
            runtime,
            ready.reason ??
              'the sandbox session could not be created for this run',
            writer,
            args.persona // R12
          );
        } else {
          await this.streamAgentLoop({
            userId,
            thread,
            message: prompt,
            runtime,
            sessionId: thread.sandbox!.sessionId,
            routes: thread.sandbox!.routes ?? [],
            writer,
            persona: args.persona, // R12
          });
        }
      }

      // Authoritative finalText: the sniffed `final` frame, else re-read the
      // last assistant turn off the (now-persisted) thread as a fallback.
      finalText = capturedFinal;
      if (!finalText) {
        const last = thread.messages[thread.messages.length - 1];
        if (last && last.role === 'assistant') finalText = last.content ?? '';
      }

      const stopped = await this.stopRequested(threadId);
      return {
        state: stopped ? 'stopped' : 'done',
        finalText,
        threadId,
      };
    } catch (err) {
      // Nothing above should throw (the reused paths are defensive), but if it
      // does the run is failed — emit an error frame and report it, never throw.
      const detail = (err as Error)?.message ?? 'openclaw_run_failed';
      this.logger.warn(`[openclaw] detached run failed: ${detail}`);
      if (!writer.closed) {
        writer.emit({
          type: 'error',
          code: 'run_failed',
          message: truncatePreview(detail, RESULT_FEEDBACK_CHAR_CAP),
        });
      }
      return {
        state: 'failed',
        error: truncatePreview(detail, RESULT_FEEDBACK_CHAR_CAP),
        threadId: threadId ?? undefined,
      };
    } finally {
      clearTimeout(wallTimer);
      if (signal) {
        try {
          signal.removeEventListener('abort', onExternalAbort);
        } catch {
          /* best-effort */
        }
      }
      // SANDBOX BUDGET: unlike /stream (which keeps the microVM warm across
      // turns), a DETACHED run is not an interactive session — free its sandbox
      // so a backgrounded run can never leak a microVM past its budget. This is
      // the ONE teardown call on the detached path, mirroring legacy /run's
      // finally-stop. Best-effort (the VM also auto-expires at its own timeout).
      const sessionId = thread?.sandbox?.sessionId;
      if (sessionId) {
        try {
          await stopSession(sessionId);
        } catch {
          /* best-effort — sandbox auto-expires at its create-time timeout */
        }
        // The session is gone; drop it from the thread so a later turn recreates
        // rather than trying to reuse a stopped VM (defensive, fail-soft).
        if (thread) {
          try {
            thread.sandbox = undefined;
            thread.updatedAt = Date.now();
            await this.runtime.saveThread(userId, thread);
          } catch {
            /* best-effort */
          }
        }
      }
      // Clear the (possibly stale) stop flag + close the writer (terminal done).
      if (threadId) {
        try {
          await this.runtime.clearStop(threadId);
        } catch {
          /* best-effort */
        }
      }
      writer.end();
    }
  }
}

// ---------------------------------------------------------------------------
// Local structural type for the runtime's SSE writer (contract C3). We only
// import the CLASS ClickDzAgentRuntime as a value (for DI); the writer type is
// declared structurally here so this file needs no extra named type import that
// could drift — it matches the openStream() return shape exactly.
// ---------------------------------------------------------------------------
interface AgentSseWriterLike {
  emit(ev: AgentEvent): void;
  heartbeatEvery(ms: number): void;
  onClose(cb: () => void): void;
  closed: boolean;
  end(): void;
}

// ===========================================================================
// R6 — DETACHED background runs (agent='openclaw'). Additive + flag-gated.
//
// The interactive /stream path above is UNTOUCHED: it still owns openStream(),
// keeps its sandbox persistent (never stopped), and is byte-identical when the
// R6 agent flags are off (this whole seam is only ever reached from Moteur's
// `copilot.agent.run` @OnJob handler, which is itself gated CDZ_AGENTS_ENABLED).
//
// Moteur (clickdz-agent-runs.ts) owns the AgentLoopDeps + RunEmit contract
// types; they are re-declared STRUCTURALLY here (the same drift-proof idiom as
// AgentSseWriterLike above) so this file compiles standalone and matches
// Moteur's names when integrated. RunEmit === (ev: AgentEvent) => void — Moteur
// wraps it to both RPUSH the replay buffer and forward to any live SSE.
// ===========================================================================

/** Moteur's RunEmit: forward one wire event (RPUSH replay + live SSE fan-out). */
type OpenclawRunEmit = (ev: AgentEvent) => void;

/** The per-run budget slice Moteur passes down (from CDZ_AGENT_MAX_* envs). */
interface OpenclawRunBudget {
  maxToolCalls?: number;
  maxWallMs?: number;
  toolCalls?: number;
}

/**
 * The detached-run arguments (work-item seam signature):
 *   runOpenclawLoop(deps, { prompt, threadId, emit, signal, budget }).
 * userId is required to key the per-user thread namespace; Moteur carries it on
 * the run record. `agent` is accepted-and-ignored (always 'openclaw' here) so
 * the shape lines up with Moteur's generic dispatch.
 */
interface OpenclawLoopArgs {
  userId: string;
  prompt: string;
  threadId?: string;
  runtime?: string;
  emit: OpenclawRunEmit;
  signal?: AbortSignal;
  budget?: OpenclawRunBudget;
  agent?: 'openclaw';
  /** R12: optional persona for a CUSTOM openclaw-archetype agent (prepended to
   * the loop's system prompt). Absent for the built-in + live /stream ⇒
   * byte-identical. */
  persona?: string;
}

/**
 * The dependencies Moteur injects into the loop. Only the controller instance
 * is needed here (it already holds the runtime + cache + sandbox seams) — the
 * planner fn + registry that AgentLoopDeps also carries are used by the Hermes
 * port, not by OpenClaw (its planner + tools are internal to this controller).
 * Kept as an interface so Moteur's builder can widen it without a hard import.
 */
interface OpenclawLoopDeps {
  controller: ClickDzOpenclawController;
}

/** The terminal outcome Moteur folds back onto the run record. */
interface OpenclawLoopResult {
  state: 'done' | 'failed' | 'stopped';
  finalText?: string;
  error?: string;
  threadId?: string;
}

/**
 * An AgentSseWriterLike that forwards every frame to Moteur's RunEmit instead of
 * an Express response, and treats an aborted AbortSignal as "client closed" so
 * the EXISTING streamAgentLoop / streamPlanOnly loops (which poll writer.closed
 * and register writer.onClose) cooperatively abort on wall-clock/stop with ZERO
 * changes to their bodies. `end()` emits the terminal done frame exactly once.
 * heartbeatEvery is a no-op (a detached run has no socket to keep warm — the
 * heartbeat's only purpose was proxy keep-alive on the live SSE).
 */
class EmitBackedSseWriter implements AgentSseWriterLike {
  private ended = false;
  private manualClosed = false;
  private readonly closeCbs: Array<() => void> = [];
  private readonly onAbort = () => this.markClosed();

  constructor(
    private readonly sink: OpenclawRunEmit,
    private readonly signal?: AbortSignal
  ) {
    if (signal) {
      if (signal.aborted) this.manualClosed = true;
      else signal.addEventListener('abort', this.onAbort, { once: true });
    }
  }

  get closed(): boolean {
    return this.ended || this.manualClosed || !!this.signal?.aborted;
  }

  emit(ev: AgentEvent): void {
    if (this.closed && ev.type !== 'error') return;
    try {
      this.sink(ev);
    } catch {
      /* forwarding is best-effort — a sink blip never crashes the loop */
    }
  }

  heartbeatEvery(_ms: number): void {
    /* no socket to keep alive in a detached run */
  }

  onClose(cb: () => void): void {
    if (this.closed) {
      try {
        cb();
      } catch {
        /* best-effort */
      }
      return;
    }
    this.closeCbs.push(cb);
  }

  /** Emit the terminal {type:'done'} frame once + fire close callbacks. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    try {
      this.sink({ type: 'done' } as unknown as AgentEvent);
    } catch {
      /* best-effort */
    }
    this.fireClose();
  }

  private markClosed(): void {
    if (this.manualClosed) return;
    this.manualClosed = true;
    this.fireClose();
  }

  private fireClose(): void {
    if (this.signal) {
      try {
        this.signal.removeEventListener('abort', this.onAbort);
      } catch {
        /* best-effort */
      }
    }
    while (this.closeCbs.length) {
      const cb = this.closeCbs.shift();
      try {
        cb?.();
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Free-function seam Moteur imports: `runOpenclawLoop(deps, args)`. Thin wrapper
 * that forwards to the controller method holding the actual reuse logic (the
 * controller already owns the runtime + sandbox seams via DI). Matches the
 * work-item signature; Moteur's runDetachedAgentLoop calls this for the
 * agent='openclaw' branch.
 */
export function runOpenclawLoop(
  deps: OpenclawLoopDeps,
  args: OpenclawLoopArgs
): Promise<OpenclawLoopResult> {
  return deps.controller.runOpenclawLoop(args);
}

export type {
  OpenclawLoopArgs,
  OpenclawLoopDeps,
  OpenclawLoopResult,
  OpenclawRunBudget,
  OpenclawRunEmit,
};
