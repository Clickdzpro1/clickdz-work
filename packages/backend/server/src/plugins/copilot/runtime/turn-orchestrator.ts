import { Injectable } from '@nestjs/common';

import { CopilotContextService } from '../context/service';
import { type Turn } from '../core';
import {
  ModelInputType,
  type PromptParams,
  type StreamObject,
} from '../providers/types';
import { ChatSession } from '../session';
import { ChatQuerySchema } from '../types';
import { CapabilityRuntime } from './capability-runtime';
import { CapabilityPolicyHost } from './hosts/capability-policy-host';
import { ConversationHost } from './hosts/conversation-host';
import { ImageResultHost } from './hosts/image-result-host';
import { TurnPersistence } from './hosts/turn-persistence';

@Injectable()
export class TurnOrchestrator {
  constructor(
    private readonly conversations: ConversationHost,
    private readonly context: CopilotContextService,
    private readonly capabilityPolicy: CapabilityPolicyHost,
    private readonly runtime: CapabilityRuntime,
    private readonly imageResults: ImageResultHost,
    private readonly turnPersistence: TurnPersistence
  ) {}

  private async buildPromptParams(
    sessionId: string,
    options: {
      latestTurn?: Turn;
      includeContextFiles?: boolean;
    } = {}
  ): Promise<Record<string, unknown>> {
    const current = await this.context.getBySessionId(sessionId);
    const contextFiles =
      options.includeContextFiles &&
      current &&
      (current.files.length > 0 || current.blobs.length > 0)
        ? [...current.files, ...(await current.getBlobMetadata())]
        : [];
    const latestTurn = options.latestTurn;

    return {
      ...this.conversations.buildLatestTurnPromptParams(latestTurn),
      ...(contextFiles.length ? { contextFiles } : {}),
    };
  }

  private async prepareChatSelection(
    userId: string,
    sessionId: string,
    query: Record<string, string | string[]>,
    selection: {
      responseMode: 'text' | 'object' | 'image';
      includeContextFiles?: boolean;
    }
  ) {
    const prepared = await this.conversations.prepareTurn(
      userId,
      sessionId,
      query
    );
    const { modelId: rawModelId, reasoning, webSearch, toolsConfig, byokLeaseId } =
      ChatQuerySchema.parse(query);
    // CDZ WS17: the frontend image preference popup sends CDZIMAGE/CDZIM tier
    // IDs (gpt-image-1.5, gemini-3-pro-image, cdzimage-2.0, ...) over the SSE
    // image path, but the native model registry only knows gpt-image-1,
    // gpt-image-2, and gemini-2.5-flash-image. Map the tier IDs the registry
    // doesn't know to the closest registry-known equivalent so the request
    // routes to a real image provider instead of falling back to the session's
    // default CHAT model. Scoped to image response mode only.
    const CDZIMAGE_TO_NATIVE: Record<string, string> = {
      'gpt-image-1.5': 'gpt-image-2',
      'gpt-image-1-mini': 'gpt-image-1',
      'cdzimage-2.0': 'gpt-image-2',
      'cdzimage-1.5': 'gpt-image-2',
      'cdzimage-1.0': 'gpt-image-1',
      'gemini-3-pro-image': 'gemini-2.5-flash-image',
      'gemini-3.1-flash-image': 'gemini-2.5-flash-image',
      'gemini-3.1-flash-lite-image': 'gemini-2.5-flash-image',
    };
    const modelId =
      selection.responseMode === 'image' && rawModelId
        ? (CDZIMAGE_TO_NATIVE[rawModelId] ?? rawModelId)
        : rawModelId;
    const promptParams = await this.buildPromptParams(sessionId, {
      latestTurn: prepared.latestTurn,
      includeContextFiles: selection.includeContextFiles,
    });
    const finalMessage = prepared.session.finish({
      ...prepared.params,
      ...promptParams,
    });

    return {
      prepared,
      finalMessage,
      selection: await this.capabilityPolicy.selectChat(prepared.session, {
        responseMode: selection.responseMode,
        modelId,
        reasoning,
        webSearch,
        toolsConfig,
        byokLeaseId,
        billingUnitId: prepared.latestTurn?.id,
        quotaBackedRoutesAllowed: prepared.quotaBackedRoutesAllowed,
        featureKind:
          selection.responseMode === 'image'
            ? 'image'
            : selection.responseMode === 'object'
              ? 'action'
              : 'chat',
      }),
    };
  }

  async streamText(
    userId: string,
    sessionId: string,
    query: Record<string, string | string[]>,
    signal?: AbortSignal,
    wasAborted: () => boolean = () => false
  ) {
    const { prepared, finalMessage, selection } =
      await this.prepareChatSelection(userId, sessionId, query, {
        responseMode: 'text',
        includeContextFiles: true,
      });

    const stream = this.streamTextResult(
      prepared.session,
      selection.model,
      finalMessage,
      {
        ...selection.providerOptions,
        signal,
      },
      wasAborted
    );

    return {
      messageId: prepared.messageId,
      model: selection.model,
      finalMessage,
      stream,
    };
  }

  private async *streamTextResult(
    session: ChatSession,
    model: string,
    finalMessage: ReturnType<ChatSession['finish']>,
    options: Record<string, unknown>,
    wasAborted: () => boolean
  ) {
    let buffer = '';
    for await (const chunk of this.runtime.streamText(
      { modelId: model },
      finalMessage,
      options
    )) {
      buffer += chunk;
      yield chunk;
    }
    await this.turnPersistence.persistTextResult(session, buffer, wasAborted());
  }

  async streamObject(
    userId: string,
    sessionId: string,
    query: Record<string, string | string[]>,
    signal?: AbortSignal,
    wasAborted: () => boolean = () => false
  ) {
    const { prepared, finalMessage, selection } =
      await this.prepareChatSelection(userId, sessionId, query, {
        responseMode: 'object',
        includeContextFiles: true,
      });

    return {
      messageId: prepared.messageId,
      model: selection.model,
      finalMessage,
      stream: this.streamObjectResult(
        prepared.session,
        selection.model,
        finalMessage,
        {
          ...selection.providerOptions,
          signal,
        },
        wasAborted
      ),
    };
  }

  private async *streamObjectResult(
    session: ChatSession,
    model: string,
    finalMessage: ReturnType<ChatSession['finish']>,
    options: Record<string, unknown>,
    wasAborted: () => boolean
  ): AsyncIterableIterator<StreamObject> {
    const chunks: StreamObject[] = [];
    for await (const chunk of this.runtime.streamObject(
      { modelId: model },
      finalMessage,
      options
    )) {
      chunks.push(chunk);
      yield chunk;
    }
    await this.turnPersistence.persistObjectResult(
      session,
      chunks,
      wasAborted()
    );
  }

  async streamImages(
    userId: string,
    sessionId: string,
    query: Record<string, string | string[]>,
    signal?: AbortSignal,
    wasAborted: () => boolean = () => false
  ) {
    const { prepared, finalMessage, selection } =
      await this.prepareChatSelection(userId, sessionId, query, {
        responseMode: 'image',
      });
    const [systemMessage] = finalMessage;
    const finalParams: PromptParams = systemMessage?.params ?? {};
    const hasAttachment =
      !!prepared.session.latestUserTurn?.attachments?.length;

    return {
      messageId: prepared.messageId,
      model: selection.model,
      finalMessage,
      stream: this.streamImageResult(
        userId,
        sessionId,
        prepared.session,
        selection.model,
        hasAttachment,
        finalMessage,
        {
          ...selection.providerOptions,
          quality:
            typeof finalParams.quality === 'string'
              ? finalParams.quality
              : undefined,
          seed: this.parseNumber(finalParams.seed),
          signal,
        },
        wasAborted
      ),
    };
  }

  private async *streamImageResult(
    userId: string,
    sessionId: string,
    session: ChatSession,
    model: string | undefined,
    hasAttachment: boolean,
    finalMessage: ReturnType<ChatSession['finish']>,
    options: Record<string, unknown>,
    wasAborted: () => boolean
  ): AsyncIterableIterator<string> {
    const attachments: string[] = [];
    for await (const artifact of this.runtime.streamImageArtifacts(
      {
        modelId: model,
        inputTypes: hasAttachment
          ? [ModelInputType.Image]
          : [ModelInputType.Text],
      },
      finalMessage,
      options
    )) {
      const handled = await this.imageResults.persistNativeArtifact(
        userId,
        sessionId,
        artifact
      );
      if (handled) {
        attachments.push(handled);
        yield handled;
      }
    }
    await this.turnPersistence.persistImageResult(
      session,
      attachments,
      wasAborted()
    );
  }

  private parseNumber(value: unknown) {
    if (!value) {
      return undefined;
    }
    const num = Number.parseInt(String(value), 10);
    return Number.isNaN(num) ? undefined : num;
  }
}
