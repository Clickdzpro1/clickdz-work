import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

// JobQueue is the BullMQ wrapper (base/job barrel) — the SAME provider the
// copilot session / embedding job handlers inject. Runs are enqueued through it.
import { JobQueue } from '../../base';
// CacheRedis is the @Global raw ioredis provider — the SAME handle the run
// engine (Moteur) reads/writes records + events through, and the SAME handle
// ClickDzReleasesController / ClickDzHermesController inject. We take the RAW
// client (not the JSON Cache wrapper) so the stop/approval bridge writes hit the
// exact runtime keys.
import { CacheRedis } from '../../base/redis';
// Typed errors from ../../base — a raw HttpException is coerced to a generic 500
// by AFFiNE's GlobalExceptionFilter, so all 4xx go through these typed errors
// (rendered BEFORE any SSE headers are flushed) or through @Res passthrough.
import { NotFound, Throttle } from '../../base';
import { CurrentUser } from '../../core/auth';
// The shared runtime owns the cooperative stop flag + human-in-the-loop approval
// registry (Redis-backed). We bridge POST /stop → requestStop and POST /approve
// → resolveApproval EXACTLY like ClickDzHermesController does, so a background
// run's loop (which polls the same runtime flags) resumes/cancels correctly.
import { ClickDzAgentRuntime } from './clickdz-agent-runtime';
import type { AgentEvent, AgentName } from './clickdz-agent-runtime';
// Moteur's background run engine (WSA-3). We drive it through its exported
// helpers — the controller stays thin and framework-only.
import {
  checkDailyRunCap,
  createAgentRun,
  enqueueAgentRun,
  listAgentRuns,
  readAgentRun,
  readRunEvents,
  registerRunForwarder,
} from './clickdz-agent-runs';

// ===========================================================================
// clickdz-agent-runs.controller.ts — BACKGROUND RUN REST + SSE (R6 §"Run
// endpoints", owner: Canal).
//
// Detaches a run from any open socket: POST /runs enqueues a `copilot.agent.run`
// BullMQ job (Moteur drives the loop); GET /runs/:id/stream attaches via the
// replay list + a live in-process forwarder — close the tab, the run keeps
// going; re-attach and replay gives full history.
//
// Gating: inert unless CDZ_AGENTS_ENABLED=1 — typed 404 otherwise (checked
// BEFORE any SSE headers flush, so the global filter can render it). :agent ∈
// {hermes,openclaw}. Ownership is by Redis key structure: every read/write is
// scoped to the @CurrentUser id, and a fetched record must match :agent. Thin:
// all state lives in Moteur's engine + the shared runtime.
// ===========================================================================

const AGENTS_ENABLED = () => process.env.CDZ_AGENTS_ENABLED === '1';

// Body caps (mirrors the hermes goal bounds so the FE contract is identical).
const PROMPT_MIN = 2;
const PROMPT_MAX = 8_000;

// SSE constants — MIRROR ClickDzAgentRuntime.openStream exactly (recon §6): same
// headers, same `data: <json>\n\n` frame, same 15s heartbeat.
const HEARTBEAT_MS = 15_000;
// A run is finished once its status frame carries one of these phases; the
// stream sends a terminal {type:'done'} and closes.
const TERMINAL_PHASES = new Set(['done', 'error', 'stopped']);

@Controller()
export class ClickDzAgentRunsController {
  constructor(
    private readonly redis: CacheRedis,
    private readonly queue: JobQueue,
    private readonly runtime: ClickDzAgentRuntime
  ) {}

  // -------------------------------------------------------------------------
  // Guards — both throw a typed NotFound (the master gate hides the whole
  // surface when the flag is off; an unknown agent 404s so we never leak which
  // agents exist). Both run BEFORE any SSE headers are flushed.
  // -------------------------------------------------------------------------
  private gate(): void {
    if (!AGENTS_ENABLED()) throw new NotFound('agent runs are not enabled');
  }

  private agentOf(agent: string): AgentName {
    if (agent === 'hermes' || agent === 'openclaw') return agent;
    throw new NotFound(`unknown agent "${agent}"`);
  }

  /** Load a run owned by this user under this agent, or throw NotFound. */
  private async ownedRun(userId: string, agent: AgentName, id: string) {
    const rec = await readAgentRun(
      this.redis as any,
      userId,
      typeof id === 'string' ? id.trim() : ''
    );
    // Ownership is enforced by the userId in the key; the agent match stops a
    // hermes run from being reached through the openclaw path.
    if (!rec || rec.agent !== agent) {
      throw new NotFound(`run "${id}" not found`);
    }
    return rec;
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/agents/:agent/runs {prompt, threadId?} → {runId}
  //   daily-cap gate → create record → enqueue detached job.
  // -------------------------------------------------------------------------
  @Throttle('strict')
  @Post('/api/v1/agents/:agent/runs')
  async create(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ runId: string } | { ok: false; error: string }> {
    this.gate();
    const agent = this.agentOf(agentParam);

    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (prompt.length < PROMPT_MIN || prompt.length > PROMPT_MAX) {
      res.status(400).json({
        ok: false,
        error: `"prompt" must be a string of ${PROMPT_MIN}..${PROMPT_MAX} chars`,
      });
      return { ok: false, error: 'invalid_prompt' };
    }
    const threadId =
      typeof body?.threadId === 'string' && body.threadId.trim()
        ? body.threadId.trim()
        : undefined;

    // Per-user daily run cap (Redis INCR; fails OPEN on Redis error).
    const cap = await checkDailyRunCap(this.redis as any, user.id);
    if (!cap.allowed) {
      res.status(429).json({
        ok: false,
        error: 'daily_run_limit_reached',
        limit: cap.limit,
      });
      return { ok: false, error: 'daily_run_limit_reached' };
    }

    const rec = await createAgentRun(this.redis as any, {
      userId: user.id,
      agent,
      prompt,
      channel: 'web',
      threadId,
    });
    await enqueueAgentRun(this.queue, rec);
    return { runId: rec.runId };
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/agents/:agent/runs?limit= → AgentRunRecord[] (newest first).
  // -------------------------------------------------------------------------
  @Throttle('default')
  @Get('/api/v1/agents/:agent/runs')
  async list(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string,
    @Query('limit') limitRaw: string | undefined
  ) {
    this.gate();
    const agent = this.agentOf(agentParam);
    const limit = limitRaw ? Number.parseInt(String(limitRaw), 10) : 30;
    return listAgentRuns(this.redis as any, user.id, agent, limit);
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/agents/:agent/runs/:id → one AgentRunRecord.
  // -------------------------------------------------------------------------
  @Throttle('default')
  @Get('/api/v1/agents/:agent/runs/:id')
  async one(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string,
    @Param('id') id: string
  ) {
    this.gate();
    const agent = this.agentOf(agentParam);
    return this.ownedRun(user.id, agent, id);
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/agents/:agent/runs/:id/stream — SSE via @Res passthrough.
  //
  // 1. replay readRunEvents(...) so a (re)attaching client gets full history;
  // 2. if the run is already terminal → send `done` + close (no live attach);
  // 3. else registerRunForwarder(runId, ...) for live events + 15s heartbeat;
  // 4. on a terminal status frame OR client close → unregister + res.end().
  // NEVER throws once the stream is open — a failure becomes an `error` frame
  // then close (the gate/agent/ownership checks all run BEFORE headers flush).
  // -------------------------------------------------------------------------
  @Throttle('default')
  @Get('/api/v1/agents/:agent/runs/:id/stream')
  async stream(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<void> {
    this.gate();
    const agent = this.agentOf(agentParam);
    // Throws NotFound (pre-headers) if the run is missing / not owned.
    const rec = await this.ownedRun(user.id, agent, id);
    const runId = rec.runId;

    // --- guarded SSE writer (mirrors ClickDzAgentRuntime.openStream) ---------
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let off: (() => void) | undefined;

    const teardown = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      if (off) {
        try {
          off();
        } catch {
          /* ignore */
        }
        off = undefined;
      }
    };
    const rawWrite = (payload: string): boolean => {
      if (closed) return false;
      try {
        res.write(payload);
        return true;
      } catch {
        closed = true;
        teardown();
        return false;
      }
    };
    const write = (ev: AgentEvent): void => {
      let payload: string;
      try {
        payload = `data: ${JSON.stringify(ev)}\n\n`;
      } catch {
        return; // non-serializable → skip rather than crash the stream
      }
      rawWrite(payload);
    };
    const end = (): void => {
      if (closed) {
        teardown();
        return;
      }
      rawWrite(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      closed = true;
      teardown();
      try {
        res.end();
      } catch {
        /* socket already ended */
      }
    };

    // --- headers + flush (all guarded — a dead socket never throws) ----------
    try {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
    } catch {
      closed = true;
    }
    // Client disconnect → stop forwarding + clear the heartbeat.
    const onDisconnect = () => {
      closed = true;
      teardown();
    };
    try {
      req.on('close', onDisconnect);
      res.on('close', onDisconnect);
      res.on('error', onDisconnect);
    } catch {
      /* if listeners can't attach the stream just won't auto-close */
    }
    if (closed) return;

    // A terminal status frame ends the stream cleanly.
    const isTerminalEvent = (ev: AgentEvent): boolean =>
      (ev as any)?.type === 'status' &&
      TERMINAL_PHASES.has((ev as any)?.phase);

    // --- 1. replay buffered history (oldest→newest) --------------------------
    let sawTerminal = false;
    try {
      const history = await readRunEvents(this.redis as any, user.id, runId);
      for (const ev of history) {
        if ((ev as any)?.type === 'ping') continue; // heartbeats carry no history
        write(ev);
        if (isTerminalEvent(ev)) sawTerminal = true;
      }
    } catch {
      /* fail-soft: no replay → live attach still works */
    }

    // --- 2. already finished? send done + close, skip live attach ------------
    if (sawTerminal || ['done', 'failed', 'stopped'].includes(rec.state)) {
      end();
      return;
    }

    // --- 3. live attach: forward engine events for this run ------------------
    off = registerRunForwarder(runId, (ev: AgentEvent) => {
      if (closed) return;
      if ((ev as any)?.type === 'ping') {
        write({ type: 'ping' });
        return;
      }
      write(ev);
      if (isTerminalEvent(ev)) {
        // Terminal frame delivered live → close on the next tick so the frame
        // flushes first.
        setTimeout(() => end(), 0);
      }
    });

    // --- 4. heartbeat keeps the connection alive through proxies -------------
    heartbeat = setInterval(() => {
      if (!rawWrite(`data: ${JSON.stringify({ type: 'ping' })}\n\n`)) {
        end();
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/agents/:agent/runs/:id/stop → cooperative stop. Bridges to the
  // runtime stop flag on the run's threadId (the loop polls it each iteration).
  // Idempotent; always 200 {ok:true} for an owned run.
  // -------------------------------------------------------------------------
  @Throttle('default')
  @Post('/api/v1/agents/:agent/runs/:id/stop')
  async stop(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string,
    @Param('id') id: string
  ): Promise<{ ok: boolean }> {
    this.gate();
    const agent = this.agentOf(agentParam);
    const rec = await this.ownedRun(user.id, agent, id);
    // The detached loop's ctx.isStopped() calls runtime.isStopRequested(threadId)
    // — set the SAME flag the runtime owns so the run winds down cooperatively.
    if (rec.threadId) {
      await this.runtime.requestStop(rec.threadId);
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/agents/:agent/runs/:id/approve {stepId, approved} → resolve a
  // pending approval_request. Bridges to the SAME awaitApproval machinery hermes
  // uses: the loop's awaitApproval(threadId, stepId) consumes this decision.
  // -------------------------------------------------------------------------
  @Throttle('default')
  @Post('/api/v1/agents/:agent/runs/:id/approve')
  async approve(
    @CurrentUser() user: CurrentUser,
    @Param('agent') agentParam: string,
    @Param('id') id: string,
    @Body() body: any,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ ok: boolean } | { ok: false; error: string }> {
    this.gate();
    const agent = this.agentOf(agentParam);
    const rec = await this.ownedRun(user.id, agent, id);

    const stepId = typeof body?.stepId === 'string' ? body.stepId.trim() : '';
    if (!stepId) {
      res.status(400).json({ ok: false, error: 'stepId is required' });
      return { ok: false, error: 'invalid_step' };
    }
    const decision = body?.approved === true ? 'approve' : 'deny';
    if (!rec.threadId) {
      // No thread → nothing is awaiting a decision; treat as a no-op ok.
      return { ok: true };
    }
    // resolveApproval writes the getAndDelete flag the loop's awaitApproval polls
    // — stepId IS the approval_request frame's id (approvalId).
    await this.runtime.resolveApproval(rec.threadId, stepId, decision);
    return { ok: true };
  }
}
