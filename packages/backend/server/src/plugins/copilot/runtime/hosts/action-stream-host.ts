import { Injectable, Logger } from '@nestjs/common';

import { metrics } from '../../../../base';
import type { LlmImageResponse } from '../../../../native';
import { PromptService } from '../../prompt';
import type { PromptMessage } from '../../providers/types';
import type { ChatSession } from '../../session';
import { ChatQuerySchema } from '../../types';
import { projectActionEventToChatEvent } from '../action-output-projector';
import type { ActionRuntimeBridgeEvent } from '../action-runtime-bridge';
import { ActionRuntimeBridge } from '../action-runtime-bridge';
import { CdzModelHealthService } from '../cdz-model-health.service';
import { isUpstreamScenarioFailed } from '../upstream-error-detector';
import { ConversationHost } from './conversation-host';
import { ImageResultHost } from './image-result-host';

export { projectActionEventToChatEvent };

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

// D1: cdz-flash is the reliable fallback model for action stream retries.
const CDZ_FALLBACK_MODEL = 'cdz-flash';

/** Sleep for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const ACTION_PROMPTS: Record<string, string> = {
  'mindmap.generate': 'mindmap.generate',
  'slides.outline': 'slides.outline',
};

type ImageActionRoutePreparation = {
  modelId?: string;
  messages: PromptMessage[];
  options: Record<string, unknown>;
};

function isImageAction(id: string) {
  return id.startsWith('image.filter.');
}

function actionTextResultSchema() {
  return {
    type: 'object',
    properties: {
      result: { type: 'string' },
    },
    required: ['result'],
    additionalProperties: false,
  };
}

@Injectable()
export class ActionStreamHost {
  private readonly logger = new Logger(ActionStreamHost.name);
  constructor(
    private readonly conversations: ConversationHost,
    private readonly bridge: ActionRuntimeBridge,
    private readonly prompts: PromptService,
    private readonly imageResults: ImageResultHost,
    private readonly modelHealth: CdzModelHealthService
  ) {}

  async stream(
    userId: string,
    sessionId: string,
    query: Record<string, string | string[]>,
    signal?: AbortSignal
  ): Promise<{
    messageId?: string;
    actionId: string;
    actionVersion: string;
    stream: AsyncIterableIterator<ActionRuntimeBridgeEvent>;
  }> {
    const parsedQuery = ChatQuerySchema.parse(query);
    const prepared = await this.conversations.prepareTurn(
      userId,
      sessionId,
      query
    );
    const requestedActionId =
      firstQueryValue(query.actionId) ?? prepared.session.config.promptName;
    const actionId = requestedActionId;
    const actionVersion = firstQueryValue(query.actionVersion) ?? 'v1';
    const retryOf = parsedQuery.retry
      ? firstQueryValue(query.runId)
      : undefined;
    const params = {
      ...prepared.params,
      ...this.conversations.buildLatestTurnPromptParams(prepared.latestTurn),
    };
    const finalMessage = await this.preparePromptMessages(
      actionId,
      prepared.session,
      params
    );
    const imageRoutes = await this.prepareImageRoutes(
      actionId,
      prepared.session,
      params,
      userId,
      parsedQuery.byokLeaseId,
      prepared.quotaBackedRoutesAllowed,
      signal,
      parsedQuery.modelId
    );
    const originalModelId =
      typeof query.modelId === 'string' && query.modelId ? query.modelId : undefined;
    const buildBridgeInput = (modelIdOverride?: string) => ({
      userId,
      workspaceId: prepared.session.config.workspaceId,
      docId: prepared.session.config.docId,
      session: prepared.session,
      userMessageId: prepared.latestTurn?.id,
      compatSubmissionId: prepared.messageId,
      actionId,
      actionVersion,
      retryOf,
      inputSnapshot: {
        params,
        messageId: prepared.messageId,
      },
      persistAttachment: isImageAction(actionId)
        ? attachment =>
            this.persistImageAttachment(
              userId,
              prepared.session.config.workspaceId,
              attachment
            )
        : undefined,
      prepareStructuredRoutes: isImageAction(actionId)
        ? undefined
        : {
            stepId: 'generate',
            modelId: modelIdOverride ?? originalModelId,
            messages: finalMessage,
            responseSchemaJson: actionTextResultSchema(),
            options: {
              ...prepared.session.config.promptConfig,
              signal,
              user: userId,
              workspace: prepared.session.config.workspaceId,
              session: sessionId,
              byokLeaseId: parsedQuery.byokLeaseId,
              quotaBackedRoutesAllowed: prepared.quotaBackedRoutesAllowed,
              featureKind: 'action',
            },
          },
      prepareImageRoutes: imageRoutes
        ? {
            stepId: 'generate-image',
            modelId: imageRoutes.modelId,
            messages: imageRoutes.messages,
            options: imageRoutes.options,
          }
        : undefined,
      signal,
    });

    const runStream = this.bridge.runStream(buildBridgeInput());

    return {
      messageId: prepared.messageId,
      actionId,
      actionVersion,
      stream: this.withRetrySeam(
        runStream,
        buildBridgeInput,
        originalModelId ?? 'unknown',
        signal
      ),
    };
  }

  /**
   * D1 — Wrap an action stream with a retry seam: if the upstream scenario
   * fails (502) before any successful events are yielded, retry ONCE with
   * cdz-flash. Mirrors the turn-orchestrator retry pattern.
   */
  private async *withRetrySeam(
    original: AsyncIterableIterator<ActionRuntimeBridgeEvent>,
    rebuildInput: (modelIdOverride?: string) => Parameters<
      ActionRuntimeBridge['runStream']
    >[0],
    originalModel: string,
    signal?: AbortSignal
  ): AsyncIterableIterator<ActionRuntimeBridgeEvent> {
    let eventCount = 0;
    try {
      for await (const event of original) {
        // Detect a scenario-failed error event before any successful events.
        if (
          event.type === 'error' &&
          eventCount === 0 &&
          isUpstreamScenarioFailed(
            (event as any).errorMessage ?? (event as any).error ?? event
          )
        ) {
          this.logger.warn(
            `[action] upstream scenario-failed before any events — retrying once with ${CDZ_FALLBACK_MODEL} (was ${originalModel})`
          );
          metrics.ai
            .counter('cdz_retry_to_flash_attempted')
            .add(1, { from: originalModel, to: CDZ_FALLBACK_MODEL, route: 'action' });
          this.modelHealth.recordFailure(originalModel);
          // Backoff with jitter (200-500ms) before retry.
          const jitter = 200 + Math.floor(Math.random() * 300);
          await sleep(jitter);
          if (signal?.aborted) {
            yield event;
            return;
          }
          try {
            const retryStream = this.bridge.runStream(
              rebuildInput(CDZ_FALLBACK_MODEL)
            );
            for await (const retryEvent of retryStream) {
              yield retryEvent;
            }
            metrics.ai.counter('cdz_retry_to_flash_succeeded').add(1, {
              route: 'action',
            });
            this.modelHealth.recordSuccess(CDZ_FALLBACK_MODEL);
          } catch (retryError) {
            metrics.ai.counter('cdz_retry_to_flash_failed').add(1, {
              route: 'action',
            });
            this.modelHealth.recordFailure(CDZ_FALLBACK_MODEL);
            throw retryError;
          }
          return;
        }
        eventCount++;
        yield event;
      }
    } catch (error) {
      // If the stream itself throws (not an error event), check for scenario
      // failure before any events were yielded and retry.
      if (eventCount === 0 && isUpstreamScenarioFailed(error)) {
        this.logger.warn(
          `[action] upstream scenario-failed (thrown) before any events — retrying once with ${CDZ_FALLBACK_MODEL} (was ${originalModel})`
        );
        metrics.ai
          .counter('cdz_retry_to_flash_attempted')
          .add(1, { from: originalModel, to: CDZ_FALLBACK_MODEL, route: 'action' });
        this.modelHealth.recordFailure(originalModel);
        const jitter = 200 + Math.floor(Math.random() * 300);
        await sleep(jitter);
        if (signal?.aborted) {
          throw error;
        }
        try {
          const retryStream = this.bridge.runStream(
            rebuildInput(CDZ_FALLBACK_MODEL)
          );
          for await (const retryEvent of retryStream) {
            yield retryEvent;
          }
          metrics.ai
            .counter('cdz_retry_to_flash_succeeded')
            .add(1, { route: 'action' });
          this.modelHealth.recordSuccess(CDZ_FALLBACK_MODEL);
        } catch (retryError) {
          metrics.ai
            .counter('cdz_retry_to_flash_failed')
            .add(1, { route: 'action' });
          this.modelHealth.recordFailure(CDZ_FALLBACK_MODEL);
          throw retryError;
        }
      } else {
        throw error;
      }
    }
  }

  private async preparePromptMessages(
    actionId: string,
    session: ChatSession,
    params: Record<string, unknown>
  ): Promise<PromptMessage[]> {
    const promptName = ACTION_PROMPTS[actionId];
    if (!promptName) {
      return session.finish(params);
    }

    const prompt = await this.prompts.get(promptName);
    if (!prompt) {
      throw new Error(`Prompt ${promptName} not found`);
    }
    return this.prompts.finish(
      prompt,
      params as Record<string, string>,
      session.config.sessionId
    );
  }

  private async prepareImageRoutes(
    actionId: string,
    session: ChatSession,
    params: Record<string, unknown>,
    userId: string,
    byokLeaseId?: string,
    quotaBackedRoutesAllowed?: boolean,
    signal?: AbortSignal,
    userImageModelId?: string
  ): Promise<ImageActionRoutePreparation | undefined> {
    if (!isImageAction(actionId)) {
      return undefined;
    }

    const prompt = await this.prompts.get(actionId);
    if (!prompt) {
      throw new Error(`Prompt ${actionId} not found`);
    }
    const finalMessage = this.prompts.finish(
      prompt,
      params as Record<string, string>,
      session.config.sessionId
    );
    // CDZ WS17: honor the user's image-model preference (sent as the modelId
    // query param by the FE image preference popup) instead of always using the
    // prompt's default. Map CDZIMAGE/CDZIM tier IDs the native registry doesn't
    // know to the closest registry-known equivalent (mirrors turn-orchestrator).
    const CDZIMAGE_TO_NATIVE: Record<string, string> = {
      'gpt-image-1.5': 'gpt-image-2',
      'gpt-image-1-mini': 'gpt-image-1',
      'cdzimage-2.0': 'gpt-image-2',
      // ImgCost: the mid ("standard") tier maps to the cheaper gpt-image-1 so
      // the native ladder stays cost-monotonic (economy/standard < premium);
      // only the explicit premium tier pays for the flagship gpt-image-2.
      'cdzimage-1.5': 'gpt-image-1',
      'cdzimage-1.0': 'gpt-image-1',
      'gemini-3-pro-image': 'gemini-2.5-flash-image',
      'gemini-3.1-flash-image': 'gemini-2.5-flash-image',
      'gemini-3.1-flash-lite-image': 'gemini-2.5-flash-image',
    };
    const resolvedModelId =
      typeof userImageModelId === 'string' && userImageModelId
        ? (CDZIMAGE_TO_NATIVE[userImageModelId] ?? userImageModelId)
        : prompt.model;
    return {
      modelId: resolvedModelId,
      messages: finalMessage,
      options: {
        ...prompt.config,
        signal,
        user: userId,
        workspace: session.config.workspaceId,
        session: session.config.sessionId,
        byokLeaseId,
        quotaBackedRoutesAllowed,
        featureKind: 'image',
      },
    };
  }

  private async persistImageAttachment(
    userId: string,
    workspaceId: string,
    attachment: unknown
  ) {
    if (!attachment || typeof attachment !== 'object') {
      return attachment;
    }

    const artifact = attachment as LlmImageResponse['images'][number] & {
      url?: unknown;
      data_base64?: unknown;
      media_type?: unknown;
      width?: unknown;
      height?: unknown;
      providerMetadata?: unknown;
    };
    const persisted = await this.imageResults.persistNativeArtifact(
      userId,
      workspaceId,
      artifact
    );
    if (!persisted) {
      return attachment;
    }

    return {
      url: persisted,
      ...(typeof artifact.media_type === 'string'
        ? { mimeType: artifact.media_type }
        : {}),
      ...(typeof artifact.width === 'number' ? { width: artifact.width } : {}),
      ...(typeof artifact.height === 'number'
        ? { height: artifact.height }
        : {}),
      ...(artifact.providerMetadata !== undefined
        ? { providerMetadata: artifact.providerMetadata }
        : {}),
    };
  }
}

