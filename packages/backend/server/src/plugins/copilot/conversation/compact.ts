import { Injectable, Logger } from '@nestjs/common';

import { Models } from '../../../models';
import {
  CLICKDZ_COMPACT_SUMMARY_KIND,
  type ClickDzCompactParams,
} from './store';

/**
 * WS2 — compact-context summariser.
 *
 * Produces a short, content-agnostic (French/English) recap of a conversation
 * and persists it as an ORDINARY assistant message whose `params.clickdz`
 * marks it as a compact-summary row. `ConversationStore` then (a) excludes
 * those rows from the normal `Turn[]` materialization and (b) can re-inject the
 * latest one as a leading preamble turn when `contextMode === 'compact'`.
 *
 * Everything here is additive and fail-silent: any error (no key, upstream
 * timeout, bad payload, write failure) is logged and swallowed so the summary
 * path can never break or slow a chat turn. It only ever runs when the caller
 * has already gated on `process.env.CDZ_COMPACT_CONTEXT === '1'`.
 *
 * The upstream call mimics the CDZ_AI direct-path prior art in
 * `clickdz-bridge.controller.ts` (`summarizeEdit` / image-prompt helpers):
 * OpenAI-compatible `POST ${CDZ_AI_BASE_URL}/v1/chat/completions`,
 * `model: 'cdz-flash'`, `Authorization: Bearer ${CDZ_AI_KEY}`, small token
 * budget, short `AbortSignal.timeout`.
 */

// --- CDZ_AI direct-path envs (mirrors clickdz-bridge.controller.ts:158-161) ---
const CDZ_AI_BASE_URL = (
  process.env.CDZ_AI_BASE_URL || 'https://api.clickdz.ai'
).replace(/\/+$/, '');
const CDZ_AI_KEY = process.env.CDZ_AI_KEY || '';
const CDZ_COMPACT_MODEL = process.env.CDZ_COMPACT_MODEL || 'alibaba/qwen3.7-flash';

// Budgets: ≤512-token summary, 8s hard timeout (contract WS2).
const COMPACT_MAX_TOKENS = 512;
const COMPACT_TIMEOUT_MS = 8000;

// How many trailing turns to feed the summariser, and per-turn text cap, so the
// request stays cheap regardless of transcript length.
const COMPACT_SOURCE_TURNS = 24;
const COMPACT_TURN_TEXT_CAP = 1200;

const COMPACT_INSTRUCTION = [
  'You compress a chat conversation into a compact running memory for the assistant.',
  'Write in the SAME language the conversation mostly uses (French or English).',
  'Capture: the user goal(s), key decisions/answers, constraints, names/IDs, and any open follow-ups.',
  'Be factual and content-agnostic. No preamble, no markdown headings, no quotes.',
  'Aim for 4-8 short lines / under ~350 words. Start directly with the substance.',
].join('\n');

@Injectable()
export class CompactSummaryService {
  private readonly logger = new Logger(CompactSummaryService.name);

  constructor(private readonly models: Models) {}

  /**
   * Load the session history, ask cdz-flash for a compact recap, and persist it
   * as a compact-summary message row. Fail-silent: returns the created row id on
   * success, or `undefined` on any failure (logged only). Fire-and-forget safe.
   */
  async generateCompactSummary(sessionId: string): Promise<string | undefined> {
    try {
      if (!CDZ_AI_KEY) {
        // Not configured: nothing to do (mirrors bridge behaviour).
        return undefined;
      }

      const session = await this.models.copilotSession.get(sessionId);
      if (!session) {
        return undefined;
      }

      const messages = Array.isArray(session.messages)
        ? (session.messages as Array<{
            id?: string;
            role?: string;
            content?: unknown;
            params?: Record<string, any> | null;
          }>)
        : [];

      // Only summarise real conversational turns — skip any prior
      // compact-summary rows and empty/system content.
      const realTurns = messages.filter(m => {
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
        const kind = m.params?.clickdz?.kind;
        if (kind === CLICKDZ_COMPACT_SUMMARY_KIND) return false;
        return typeof m.content === 'string' && m.content.trim().length > 0;
      });

      if (realTurns.length === 0) {
        return undefined;
      }

      const upToMessageId = realTurns[realTurns.length - 1]?.id;
      const transcript = realTurns
        .slice(-COMPACT_SOURCE_TURNS)
        .map(m => {
          const who = m.role === 'assistant' ? 'ASSISTANT' : 'USER';
          const text = String(m.content).slice(0, COMPACT_TURN_TEXT_CAP);
          return `${who}: ${text}`;
        })
        .join('\n');

      const summary = await this.callCdzFlash(transcript);
      if (!summary) {
        return undefined;
      }

      const clickdz: ClickDzCompactParams = {
        kind: CLICKDZ_COMPACT_SUMMARY_KIND,
        upToMessageId: upToMessageId ?? null,
        model: CDZ_COMPACT_MODEL,
      };

      // Persist via the EXISTING message-create path. The `docs` key is the only
      // param stripped by sanitizeMessage; `clickdz` survives (verified against
      // copilot-session.ts:sanitizeMessage + ChatMessage params z.record(z.any)).
      const created = await this.models.copilotSession.appendMessage({
        sessionId,
        userId: session.userId,
        prompt: { model: CDZ_COMPACT_MODEL },
        message: {
          role: 'assistant',
          content: summary,
          params: { clickdz },
          createdAt: new Date(),
        },
      });

      return created?.id;
    } catch (e) {
      // Fail-silent: a summary problem must never surface to the chat turn.
      this.logger.warn(
        `compact summary failed for session ${sessionId}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      return undefined;
    }
  }

  private async callCdzFlash(transcript: string): Promise<string | undefined> {
    try {
      const response = await fetch(`${CDZ_AI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CDZ_AI_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CDZ_COMPACT_MODEL,
          reasoning: { enabled: false }, // qwen3.7-flash: thinking OFF (12x faster, ~100x cheaper)
          messages: [
            { role: 'system', content: COMPACT_INSTRUCTION },
            { role: 'user', content: transcript },
          ],
          max_tokens: COMPACT_MAX_TOKENS,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(COMPACT_TIMEOUT_MS),
      });

      const data = (await response.json()) as any;
      const content = data?.choices?.[0]?.message?.content;
      if (response.ok && typeof content === 'string' && content.trim()) {
        return content.trim();
      }
    } catch {
      // fall through — logged by caller only if it re-throws; here swallow.
    }
    return undefined;
  }
}

/**
 * Fire-and-forget trigger. Call after a user message is written; it only acts
 * when `process.env.CDZ_COMPACT_CONTEXT === '1'` AND this is the Nth user
 * message (every 6th). Never awaited by the caller and never throws.
 */
export const COMPACT_TRIGGER_EVERY_N_USER_MESSAGES = 6;

export function maybeTriggerCompactSummary(
  service: Pick<CompactSummaryService, 'generateCompactSummary'>,
  sessionId: string,
  userMessageCount: number
): void {
  if (process.env.CDZ_COMPACT_CONTEXT !== '1') return;
  if (!Number.isInteger(userMessageCount) || userMessageCount <= 0) return;
  if (userMessageCount % COMPACT_TRIGGER_EVERY_N_USER_MESSAGES !== 0) return;

  // Fire-and-forget: detach from the request lifecycle, swallow rejections.
  void Promise.resolve()
    .then(() => service.generateCompactSummary(sessionId))
    .catch(() => undefined);
}
