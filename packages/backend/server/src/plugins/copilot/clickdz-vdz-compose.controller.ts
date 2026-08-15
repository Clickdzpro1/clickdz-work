import { Body, Controller, Logger, Post } from '@nestjs/common';

// SECURITY: typed AFFiNE errors so the global exception filter emits proper
// status codes. A raw @nestjs/common HttpException becomes a generic 500 here,
// so we use these instead:
//  · BadRequest              -> 400 (missing / malformed / oversized input)
//  · CopilotProviderSideError -> upstream (Make / model) failure, typed as a
//    copilot provider error rather than a bare 502.
// Throttle('strict') is the same hard per-IP cap the paid /apps routes use.
import { BadRequest, CopilotProviderSideError, Throttle } from '../../base';
import { CurrentUser } from '../../core/auth';
import {
  buildComposeContent,
  buildRefineContent,
  MAX_VDZ_HTML_CHARS,
  MAX_VDZ_INSTRUCTION_CHARS,
  MAX_VDZ_PROMPT_CHARS,
} from './clickdz-vdz-video-prompt';

// ---------------------------------------------------------------------------
// WS14: VDZ Compose migrated to Vercel AI Gateway — same key as chat + images.
// zai/glm-4.6v-flash (128K ctx, vision-capable) handles long HTML motion-graphics
// composition better than the legacy Make.com agent.
// ---------------------------------------------------------------------------
const COMPOSE_MODEL = 'zai/glm-4.6v-flash';
const COMPOSE_TIMEOUT_MS = 240_000;
const MAX_OUTPUT_HTML_CHARS = 400_000;

/**
 * Pull the reply text out of whatever envelope the Make agent returns. Mirrors
 * the bridge controller's parseMakeAgentResponse so behaviour is identical.
 */
function parseMakeAgentResponse(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.reply === 'string') return parsed.reply;
      if (typeof parsed.answer === 'string') return parsed.answer;
      if (typeof parsed.content === 'string') return parsed.content;
      if (typeof parsed.response === 'string') return parsed.response;
      return raw;
    } catch {
      return raw;
    }
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.reply === 'string') return obj.reply;
    if (typeof obj.answer === 'string') return obj.answer;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.response === 'string')
      return parseMakeAgentResponse(obj.response);
  }
  return '';
}

/**
 * Extract the composition HTML from a model reply. Mirrors the bridge
 * controller's extractHtmlApp: accept a bare document or one inside a single
 * ```html fence, then require it to start with a doctype or <html>. Returns ''
 * when the reply is not a usable document.
 */
function extractVdzHtml(reply: string): string {
  const block = reply.match(/```html\s*([\s\S]*?)```/i)?.[1];
  const candidate = (block ?? reply).trim();
  if (/^<!doctype html/i.test(candidate) || /^<html[\s>]/i.test(candidate)) {
    return candidate;
  }
  return '';
}

/**
 * ClickDz Vdz Studio — the AI Video Generator compose API.
 *
 * Two routes, both mirroring the /api/v1/apps/generate stance (auth-open like
 * its ClickDz siblings, Throttle('strict'), typed errors, input caps):
 *   · POST /api/v1/vdz/compose        {prompt}            -> {html}
 *   · POST /api/v1/vdz/compose/refine  {html, instruction} -> {html}
 *
 * The controller only orchestrates: prompt construction + the seek/play/pause
 * runtime contract live in ./clickdz-vdz-video-prompt, and this file imports
 * NOTHING from the frontend.
 */
@Controller()
export class ClickDzVdzComposeController {
  private readonly logger = new Logger(ClickDzVdzComposeController.name);

  private async runGatewayCompose(content: string): Promise<string> {
    const gatewayKey = process.env.CUSTOM_LLM_API_KEY || '';
    const gatewayBase = process.env.AI_GATEWAY_BASE || 'https://ai-gateway.vercel.sh';
    if (!gatewayKey) {
      throw new CopilotProviderSideError({
        provider: 'gateway',
        kind: 'not_configured',
        message: 'Vercel AI Gateway key is not configured',
      });
    }
    try {
      const response = await fetch(
        `${gatewayBase}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${gatewayKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: COMPOSE_MODEL,
            messages: [{ role: 'user', content }],
            max_tokens: 8000,
          }),
          signal: AbortSignal.timeout(COMPOSE_TIMEOUT_MS),
        }
      );
      const data = (await response.json()) as any;
      const result = data?.choices?.[0]?.message?.content;
      if (!response.ok || typeof result !== 'string') {
        throw new CopilotProviderSideError({
          provider: 'gateway',
          kind: 'api_error',
          message: `Gateway returned ${response.status}`,
        });
      }
      return result;
    } catch (cause) {
      if (cause instanceof CopilotProviderSideError) throw cause;
      throw new CopilotProviderSideError({
        provider: 'gateway',
        kind: 'network_error',
        message:
          cause instanceof Error
            ? `Make.com agent request failed: ${cause.message}`
            : 'Make.com agent request failed',
      });
    }

    if (!response.ok) {
      throw new CopilotProviderSideError({
        provider: 'gateway',
        kind: 'upstream_error',
        message: `Make.com agent failed: ${response.status} ${response.statusText}`,
      });
    }

    const data = (await response.json()) as Record<string, unknown>;
    return parseMakeAgentResponse(data.response ?? data);
  }

  /**
   * Turn a model reply into a validated, size-capped composition document, or
   * throw a typed provider error when the model did not return a usable file.
   */
  private toComposition(reply: string): string {
    let html = extractVdzHtml(reply || '');
    if (!html) {
      throw new CopilotProviderSideError({
        provider: 'gateway',
        kind: 'invalid_output',
        message:
          'The model did not return a valid video composition. Try rephrasing.',
      });
    }
    if (html.length > MAX_OUTPUT_HTML_CHARS) {
      html = html.slice(0, MAX_OUTPUT_HTML_CHARS);
    }
    return html;
  }

  /** COMPOSE — describe a video, get a full self-contained composition back. */
  @Throttle('strict')
  @Post('/api/v1/vdz/compose')
  async compose(@CurrentUser() user: CurrentUser, @Body() body: any) {
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      throw new BadRequest('A description of the video is required');
    }
    // SECURITY: this route runs the (paid) creative agent. Cap input size and
    // reject (not clamp) oversized prompts, matching the /apps route stance.
    if (prompt.length > MAX_VDZ_PROMPT_CHARS) {
      throw new BadRequest(
        `Prompt is too long (max ${MAX_VDZ_PROMPT_CHARS} characters)`
      );
    }
    this.logger.log(`[vdz-compose] user=${user.id} prompt=${prompt.length}chars`);
    const content = buildComposeContent(prompt);
    const reply = await this.runGatewayCompose(content);
    const html = this.toComposition(reply);
    return { html };
  }

  /** REFINE — apply a conversational change to an existing composition. */
  @Throttle('strict')
  @Post('/api/v1/vdz/compose/refine')
  async refine(@CurrentUser() user: CurrentUser, @Body() body: any) {
    // Reject wrong-typed html before coercion (a non-string that stringifies to
    // garbage should never reach the engine).
    if (body?.html != null && typeof body.html !== 'string') {
      throw new BadRequest('"html" must be a string');
    }
    const html = String(body?.html || '');
    if (html.length < 20) {
      throw new BadRequest('No composition HTML to refine');
    }
    if (html.length > MAX_VDZ_HTML_CHARS) {
      throw new BadRequest(
        `Composition HTML is too large (max ${MAX_VDZ_HTML_CHARS} characters)`
      );
    }
    const instruction = String(body?.instruction || '').trim();
    if (!instruction) {
      throw new BadRequest('A change instruction is required');
    }
    if (instruction.length > MAX_VDZ_INSTRUCTION_CHARS) {
      throw new BadRequest(
        `Instruction is too long (max ${MAX_VDZ_INSTRUCTION_CHARS} characters)`
      );
    }
    const content = buildRefineContent({ html, instruction });
    this.logger.log(
      `[vdz-compose] refine user=${user.id} html=${html.length}chars instruction=${instruction.length}chars`
    );
    const reply = await this.runGatewayCompose(content);
    const refined = this.toComposition(reply);
    return { html: refined };
  }
}
