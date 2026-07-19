// ClickDz OPENCLAW — autonomous coding agent (WS11).
//
// POST /api/v1/openclaw/run takes a natural-language coding TASK, plans with
// cdz-flash (the SAME proven planner mechanics as
// clickdz-integrations.controller.ts /run: normalized CDZ_AI_BASE_URL + the
// single canonical /v1/chat/completions path, Bearer CDZ_AI_KEY, fail-closed
// JSON parsing, plan→act loop with truncated result feedback), then acts
// inside an isolated Vercel Sandbox microVM via the dep-free client in
// ./clickdz-vercel-sandbox: it WRITES whole files, RUNS commands, observes the
// REAL exit code + stdout/stderr, and iterates on failures until the program
// exits 0 or the caps hit (5 write/run actions / 110s wall clock). The sandbox
// session is ALWAYS stopped in a finally.
//
// Graceful degrade (MANDATORY — never a stub, never fabricated output): when
// the sandbox is unavailable (capability probe false, or session creation
// fails) the cdz-flash planner STILL generates the complete solution code +
// explanation, returned with {executed:false, sandbox:false, reason} so the
// surface stays real and honest — planning works, execution status is
// surfaced, and runtime output is never invented.
//
// Error idiom (see base/nestjs/exception.ts mapAnyError): raw HttpException is
// coerced to a generic 500 by the global filter, so the custom-status typed
// bodies here (502 {error:'planner_unavailable'}) are written directly via the
// injected Express Response (@Res()), exactly like the sibling ClickDz
// controllers. BadRequest from ../../base stays for genuinely malformed input
// (typed 400). NEVER log key material.

import { Body, Controller, Get, Logger, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { CurrentUser } from '../../core/auth';
// Typed errors from ../../base; custom-status bodies go through @Res() — see
// the header comment (raw HttpException would be coerced to a generic 500).
import { BadRequest, Throttle } from '../../base';
// Dep-free Vercel Sandbox client (contract C5 — clickdz-vercel-sandbox.ts owns
// the REST plumbing and reads VERCEL_TOKEN/VERCEL_TEAM_ID itself; it never
// surfaces key material). Every sandbox side effect below goes through these
// five functions.
import {
  createSession,
  runCommand,
  sandboxCapability,
  stopSession,
  writeFile,
} from './clickdz-vercel-sandbox';

// --- CDZ_AI planner envs — EXACT normalization copied from
// clickdz-integrations.controller.ts (the WS10 /v1-double-suffix fix). Prod
// sets CDZ_AI_BASE_URL WITH a trailing `/v1` (the copilot provider bootstrap
// default is `https://api.clickdz.ai/v1`); stripping a trailing `/v1` (and any
// trailing slashes) keeps the origin clean whether the operator set it WITH or
// WITHOUT `/v1`, then the single canonical path below is appended in exactly
// one place. The replace() chain never crashes at import. ---
const CDZ_AI_BASE_URL = (process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '')
  .replace(/\/+$/, '');
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';
const CDZ_PLANNER_MODEL = process.env.CDZ_PLANNER_MODEL || 'cdz-flash';
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
// Total budget for the whole request (contract C3: cap 5 iter / 110s).
const CLAW_WALL_CLOCK_MS = 110_000;
// Hard cap on write/run actions (not counting the terminal final turn).
const CLAW_MAX_ITERATIONS = 5;
// Sandbox microVM lifetime — comfortably above the wall clock so the VM never
// dies mid-loop; the finally-stop frees it early on every path.
const CLAW_SESSION_TIMEOUT_MS = 180_000;
// Prompt/response budgets.
const CLAW_TASK_MIN = 1;
const CLAW_TASK_MAX = 4_000;
const STEP_PREVIEW_CHAR_CAP = 2_000;
const RESULT_FEEDBACK_CHAR_CAP = 2_000;
const OUTPUT_RESPONSE_CHAR_CAP = 8_000;
// The planner writes complete files — needs far more tokens than a tool router.
const PLANNER_MAX_TOKENS = 2_048;
const WRITE_CONTENT_MAX_CHARS = 64_000;
const FILE_PATH_MAX_CHARS = 200;
const COMMAND_MAX_CHARS = 100;
const RUN_ARGS_MAX = 16;
const RUN_ARG_MAX_CHARS = 8_000;
const COMMAND_DISPLAY_CHAR_CAP = 400;

// Runtimes OPENCLAW accepts (contract C3; default first).
const OPENCLAW_RUNTIMES = ['node24', 'python3.13'];
const OPENCLAW_DEFAULT_RUNTIME = 'node24';

// One executed loop step surfaced back to the client (contract C3 ClawStep).
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
  if (f.endsWith('.ts')) return 'typescript';
  if (f.endsWith('.mjs') || f.endsWith('.cjs') || f.endsWith('.js')) {
    return 'javascript';
  }
  if (f.endsWith('.sh')) return 'bash';
  return runtime === 'python3.13' ? 'python' : 'javascript';
}

/** Merge stdout + stderr into one honest, labeled output string. */
function combineOutput(stdout: string, stderr: string): string {
  const out = typeof stdout === 'string' ? stdout.trim() : '';
  const err = typeof stderr === 'string' ? stderr.trim() : '';
  if (out && err) return `${out}\n[stderr]\n${err}`;
  return out || err;
}

/**
 * ClickDz OPENCLAW — the autonomous coding agent.
 *
 * All routes are auth'd (global AuthGuard requires a signed-in cookie session —
 * no @Public()) and rate-capped with @Throttle('strict'), mirroring the sibling
 * controllers. Planner and sandbox failures degrade gracefully (typed 502 /
 * plan-only mode) — never a raw HttpException, never fabricated results.
 */
@Controller()
export class ClickDzOpenclawController {
  private readonly logger = new Logger(ClickDzOpenclawController.name);

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
   * {sandbox, reason?, plannerReady, runtimes} (contract C3).
   */
  @Throttle('strict')
  @Get('/api/v1/openclaw/capabilities')
  async capabilities(@CurrentUser() _user: CurrentUser, @Res() res: Response) {
    const capability = await this.probeSandbox();
    res.status(200).json({
      sandbox: capability.sandbox,
      ...(capability.reason ? { reason: capability.reason } : {}),
      plannerReady: !!CDZ_AI_KEY,
      runtimes: OPENCLAW_RUNTIMES,
    });
  }

  // -------------------------------------------------------------------------
  // POST run — the coding-agent loop.
  //
  //   body {task: string (1..4000), runtime?: 'node24'|'python3.13'}
  //
  // Flow:
  //   (a) probe sandboxCapability(); unavailable -> plan-only degrade: the
  //       cdz-flash planner still GENERATES the code + explanation, returned
  //       {ok:true, executed:false, sandbox:false, reason, code, language, …}.
  //   (b) createSession({runtime}) — on failure, same plan-only degrade.
  //   (c) run the cdz-flash plan→act loop. The model replies ONLY with JSON:
  //         {"action":"write","thought":?,"file":…,"content":…}
  //         {"action":"run","thought":?,"command":…,"args":[…]}
  //         {"action":"final","thought":?,"answer":…,"code":?,"language":?}
  //       write -> writeFile; run -> runCommand (REAL exitCode/stdout/stderr,
  //       truncated <=2000 chars fed back); errors become ok:false steps whose
  //       text is fed back so the model fixes and retries.
  //   (d) caps: 5 write/run actions, 110s wall clock. On cap-hit, one forced
  //       "final" planner turn, else a deterministic synthesized answer.
  //   (e) ALWAYS stopSession in a finally.
  //
  // Success -> 200 {ok:true, answer, steps, code?, language?, output?,
  // executed, sandbox, iterations}. cdz-flash unreachable before any step ->
  // @Res 502 {error:'planner_unavailable'} — NEVER a raw HttpException.
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
      const detail = (err as Error)?.message ?? 'sandbox_session_failed';
      this.logger.warn(`[openclaw] createSession failed: ${detail}`);
      await this.runPlanOnly(
        task,
        runtime,
        `sandbox session could not be created: ${detail}`,
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
          answer = this.synthesizeAnswer(steps, lastExitCode);
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
          answer = this.synthesizeAnswer(steps, lastExitCode);
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
      // (e) ALWAYS free the microVM. stopSession is best-effort per contract
      // C5 (swallows errors) — the extra try/catch guarantees the finally can
      // never mask the real response.
      try {
        await stopSession(sessionId);
      } catch {
        // best-effort — the sandbox also auto-expires at its own timeout.
      }
    }
  }

  // ---- /run internals -----------------------------------------------------

  /**
   * sandboxCapability() never throws per contract C5 — this belt-and-braces
   * wrapper makes sure /run and /capabilities can never 500 on a client
   * regression.
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

  /**
   * Plan-only degrade path (sandbox unavailable / session creation failed):
   * the cdz-flash planner still GENERATES the full solution code + an
   * explanation — real planning, honestly marked not-executed. Up to two
   * planner turns: one generation + one corrective retry if the model tried to
   * write/run anyway (a write's content is salvaged as the generated code —
   * it IS the solution, just never executed). Runtime output is NEVER invented.
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

  /** Compose the sandbox-mode planner system prompt. */
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
      '  {"action":"final","answer":"<what the code does + how to run it + note that it was NOT executed>","code":"<the COMPLETE runnable code>","language":"python|javascript"}',
      '',
      'Rules:',
      '- "code" must be complete, runnable file content (standard library only).',
      '- NEVER claim the code was executed and NEVER invent runtime output.',
    ].join('\n');
  }

  /**
   * One planner turn against cdz-flash (direct CDZ_AI, OpenAI-compatible) —
   * same mechanics as clickdz-integrations.controller.ts callPlanner. The
   * timeout is min(15s, remaining wall-clock). Returns {raw} on a clean 2xx
   * with string content, or null on ANY failure (no key, non-2xx, timeout,
   * empty) so the caller can decide 502-vs-synthesize. Never throws; never
   * logs key material.
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
    const timeoutMs = Math.max(
      1,
      Math.min(CLAW_PLANNER_TIMEOUT_MS, remainingMs)
    );
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

  /** Deterministic fallback answer when the planner can't produce a final one. */
  private synthesizeAnswer(
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
}
