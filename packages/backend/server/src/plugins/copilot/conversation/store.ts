import { Injectable } from '@nestjs/common';

import {
  CleanupSessionOptions,
  ListSessionOptions,
  Models,
  UpdateChatSessionOptions,
} from '../../../models';
import {
  chatMessageFromTurn,
  type Conversation,
  type Turn,
  turnFromChatMessage,
} from '../core';
import { type ChatMessage, ChatMessageSchema } from '../types';

// ============================================================================
// WS2 — compact-context (additive; inert with no `contextMode` + flag off)
// ============================================================================

/**
 * Marker written into `message.params.clickdz.kind` for compact-summary rows.
 * Chosen because `sanitizeMessage` (copilot-session.ts) only strips the `docs`
 * key from `params`; every other key — including a nested `clickdz` object —
 * survives the write (`params` is typed `z.record(z.any())`, so nested shape is
 * preserved). Verified against the actual message-create path, NOT assumed.
 */
export const CLICKDZ_COMPACT_SUMMARY_KIND = 'compact-summary';

/** Persisted shape of `params.clickdz` for a compact-summary row. */
export interface ClickDzCompactParams {
  kind: typeof CLICKDZ_COMPACT_SUMMARY_KIND;
  upToMessageId: string | null;
  model: string;
}

/** History-windowing modes carried by the `?contextMode=` query param. */
export type ContextMode = 'recent' | 'compact' | 'fresh';

// Turn-window sizes per mode (contract WS2).
const RECENT_TURN_LIMIT = 8;
const COMPACT_REAL_TURN_LIMIT = 6;
const FRESH_TURN_LIMIT = 1;

/** Narrow an arbitrary query value to a valid ContextMode (else undefined). */
export function parseContextMode(value: unknown): ContextMode | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === 'recent' || v === 'compact' || v === 'fresh' ? v : undefined;
}

/** True when a materialized turn is a compact-summary row (not a real turn). */
export function isCompactSummaryTurn(turn: Turn): boolean {
  return (
    (turn.metadata as Record<string, any> | undefined)?.clickdz?.kind ===
    CLICKDZ_COMPACT_SUMMARY_KIND
  );
}

/**
 * Split materialized turns into `real` conversational turns and the trailing
 * `summary` turn (the most recent compact-summary row, if any).
 */
export function partitionCompactTurns(turns: Turn[]): {
  real: Turn[];
  summary?: Turn;
} {
  const real: Turn[] = [];
  let summary: Turn | undefined;
  for (const turn of turns) {
    if (isCompactSummaryTurn(turn)) {
      summary = turn; // keep the latest one
    } else {
      real.push(turn);
    }
  }
  return { real, summary };
}

/**
 * Turn a compact-summary row into a leading preamble turn injected ahead of the
 * kept real turns. Rendered as a `user` role so it survives providers that drop
 * mid-conversation system turns; content is fenced so the model treats it as
 * recalled context, not a fresh instruction.
 */
function summaryPreambleTurn(summary: Turn): Turn {
  return {
    ...summary,
    role: 'user',
    content: [
      '[Conversation memory — earlier context, summarised]',
      summary.content,
    ].join('\n'),
    // Drop the marker so downstream code never re-classifies this injected
    // turn as a summary row, and never re-persists it.
    metadata: {},
    renderTrace: [],
    toolEvents: [],
  };
}

/**
 * Pure history-windowing used by `ConversationStore.get`.
 *
 * `input` is the FULL materialized turn list (summary rows still present).
 * Compact-summary rows are ALWAYS excluded from the real-turn stream; only the
 * `compact` mode re-introduces the latest one as a leading preamble.
 *
 *  - undefined  → all real turns, order preserved (byte-identical to prior
 *                 behaviour once summary rows are excluded).
 *  - 'recent'   → last 8 real turns, no summary.
 *  - 'compact'  → [summary preamble?] + last 6 real turns (falls back to just
 *                 the last 6 real turns when no summary exists).
 *  - 'fresh'    → last 1 real turn.
 */
export function applyContextMode(
  input: Turn[],
  contextMode?: ContextMode
): Turn[] {
  const { real, summary } = partitionCompactTurns(input);

  switch (contextMode) {
    case 'recent':
      return real.slice(-RECENT_TURN_LIMIT);
    case 'fresh':
      return real.slice(-FRESH_TURN_LIMIT);
    case 'compact': {
      const kept = real.slice(-COMPACT_REAL_TURN_LIMIT);
      return summary ? [summaryPreambleTurn(summary), ...kept] : kept;
    }
    default:
      // No mode: preserve today's behaviour (all turns), minus summary rows.
      return real;
  }
}

type SessionRecord = NonNullable<
  Awaited<ReturnType<Models['copilotSession']['get']>>
>;

type ConversationSeed = Parameters<
  Models['copilotSession']['createWithPrompt']
>[0];

type ForkConversationSeed = Parameters<Models['copilotSession']['fork']>[0];

type ForkTurnsInput = Omit<ForkConversationSeed, 'messages'> & {
  turns: Turn[];
};

@Injectable()
export class ConversationStore {
  constructor(private readonly models: Models) {}

  /**
   * Durable-history boundary only.
   *
   * This store intentionally does not own:
   * - quota / model / pin policy
   * - title generation
   * - prompt preload or rendering
   * - compat ChatHistory / SSE projection
   */

  private toConversation(session: SessionRecord): Conversation {
    return {
      id: session.id,
      userId: session.userId,
      workspaceId: session.workspaceId,
      docId: session.docId,
      pinned: session.pinned,
      parentId: session.parentSessionId,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private toTurns(session: SessionRecord, contextMode?: ContextMode): Turn[] {
    const allTurns = this.toMessages(session.messages).map(message =>
      turnFromChatMessage(message, session.id)
    );
    // Always exclude compact-summary rows from the real-turn stream; when a
    // contextMode is present, additionally window the turns (and, for
    // 'compact', re-inject the latest summary as a leading preamble). With no
    // contextMode this is `allTurns` minus summary rows — identical to prior
    // behaviour for every existing session (which has zero summary rows).
    return applyContextMode(allTurns, contextMode);
  }

  private toMessages(messages: unknown): ChatMessage[] {
    const parsed = ChatMessageSchema.array().safeParse(messages ?? []);
    if (!parsed.success) return [];
    return parsed.data;
  }

  async create(
    seed: ConversationSeed,
    reuseLatestChat = false
  ): Promise<string> {
    return await this.models.copilotSession.createWithPrompt(
      seed,
      reuseLatestChat
    );
  }

  async get(
    sessionId: string,
    contextMode?: ContextMode
  ): Promise<
    | {
        conversation: Conversation;
        turns: Turn[];
        promptName: string;
        tokenCost: number;
      }
    | undefined
  > {
    const session = await this.models.copilotSession.get(sessionId);
    if (!session) {
      return;
    }

    return {
      conversation: this.toConversation(session),
      // `contextMode` is optional and defaults to undefined => today's
      // behaviour (all real turns). See NOTES.md for the 1-line hook that
      // threads the query param from ConversationHost/ChatSessionService.
      turns: this.toTurns(session, contextMode),
      promptName: session.promptName,
      tokenCost: session.tokenCost,
    };
  }

  async getMeta(sessionId: string): Promise<
    | {
        conversation: Conversation;
        promptName: string;
        tokenCost: number;
      }
    | undefined
  > {
    const session = await this.models.copilotSession.getMeta(sessionId);
    if (!session) return;

    return {
      conversation: {
        id: session.id,
        userId: session.userId,
        workspaceId: session.workspaceId,
        docId: session.docId,
        pinned: session.pinned,
        parentId: session.parentSessionId,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      promptName: session.promptName,
      tokenCost: session.tokenCost,
    };
  }

  async list(options: ListSessionOptions) {
    const sessions = await this.models.copilotSession.list(options);
    return sessions.map(session => ({
      conversation: {
        id: session.id,
        userId: session.userId,
        workspaceId: session.workspaceId,
        docId: session.docId,
        pinned: session.pinned,
        parentId: session.parentSessionId,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      } satisfies Conversation,
      // Exclude compact-summary rows from listed states too, so they never
      // surface as real turns anywhere (no windowing here — passes undefined).
      turns: applyContextMode(
        this.toMessages(session.messages).map(message =>
          turnFromChatMessage(message, session.id)
        )
      ),
      promptName: session.promptName,
      tokenCost: session.tokenCost,
    }));
  }

  async listMeta(options: ListSessionOptions) {
    const sessions = await this.models.copilotSession.list({
      ...options,
      withMessages: false,
    });
    return sessions.map(session => ({
      conversation: {
        id: session.id,
        userId: session.userId,
        workspaceId: session.workspaceId,
        docId: session.docId,
        pinned: session.pinned,
        parentId: session.parentSessionId,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      } satisfies Conversation,
      promptName: session.promptName,
      tokenCost: session.tokenCost,
    }));
  }

  async appendTurns(input: {
    sessionId: string;
    userId: string;
    prompt: { model: string };
    turns: Turn[];
  }) {
    return await this.models.copilotSession.updateMessages({
      ...input,
      messages: input.turns.map(turn => {
        const { id: _id, ...message } = chatMessageFromTurn(turn);
        return message;
      }),
    });
  }

  async appendTurn(input: {
    sessionId: string;
    userId: string;
    prompt: { model: string };
    turn: Turn;
    compatSubmissionId?: string;
  }) {
    const message = await this.models.copilotSession.appendMessage({
      sessionId: input.sessionId,
      userId: input.userId,
      prompt: input.prompt,
      message: (() => {
        const { id: _id, ...message } = chatMessageFromTurn(input.turn);
        return { ...message, compatSubmissionId: input.compatSubmissionId };
      })(),
    });

    return turnFromChatMessage(message, input.sessionId);
  }

  async findTurnByCompatSubmissionId(
    sessionId: string,
    compatSubmissionId: string
  ): Promise<Turn | undefined> {
    const message =
      await this.models.copilotSession.findMessageByCompatSubmissionId(
        sessionId,
        compatSubmissionId
      );
    if (!message) return;

    return turnFromChatMessage(message, sessionId);
  }

  async update(options: UpdateChatSessionOptions): Promise<string> {
    return await this.models.copilotSession.update(options);
  }

  async fork(seed: ForkTurnsInput): Promise<string> {
    return await this.models.copilotSession.fork({
      ...seed,
      messages: seed.turns.map(turn => {
        const { id: _id, ...message } = chatMessageFromTurn(turn);
        return message;
      }),
    });
  }

  async revertLatestTurn(sessionId: string, removeLatestUserMessage: boolean) {
    return await this.models.copilotSession.revertLatestMessage(
      sessionId,
      removeLatestUserMessage
    );
  }

  async cleanup(options: CleanupSessionOptions): Promise<string[]> {
    return await this.models.copilotSession.cleanup(options);
  }

  async count(options: ListSessionOptions): Promise<number> {
    return await this.models.copilotSession.count(options);
  }

  async unpin(workspaceId: string, userId: string) {
    return await this.models.copilotSession.unpin(workspaceId, userId);
  }
}
