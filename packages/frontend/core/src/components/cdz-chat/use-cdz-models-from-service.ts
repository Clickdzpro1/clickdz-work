/**
 * CDZ Chat — read the live model list from `AIModelService`.
 *
 * The existing `AIModelService` (@affine/core/modules/ai-button/services/models)
 * already manages the 7 CDZ supermodels (loaded from the server prompt
 * registry, with a hardcoded CLICKDZ_FALLBACK_MODELS). This hook reads that
 * service's `models` signal + the current `modelId`, converts them to the
 * `CdzModelOption[]` shape the ClaudeChatInput selector expects, and exposes a
 * `setSelectedModelId` that calls `aiModelService.setModel()`.
 *
 * This means the new React chat input shares the EXACT same model state as the
 * existing Lit preference popup — selecting a model in one is reflected in the
 * other. No duplicated model state, no drift.
 */
import { AIModelService } from '@affine/core/modules/ai-button/services/models';
import { useService } from '@toeverything/infra';
import { useCallback, useMemo } from 'react';

import {
  CDZ_MODELS,
  type CdzModelOption,
} from './cdz-models';

/** Map an AIModelService.AIModel -> CdzModelOption, merging with the static
 *  registry so we keep rich descriptions + badge colors + vendor glyphs that
 *  the server-side model list doesn't carry. */
function toCdzModelOption(model: {
  id: string;
  name: string;
}): CdzModelOption {
  const fromRegistry = CDZ_MODELS.find(m => m.id === model.id);
  if (fromRegistry) return fromRegistry;
  // Unknown cdz-* model from the server: synthesize a minimal option.
  return {
    id: model.id,
    label: model.name,
    description: 'CDZ AI model',
    kind: model.id === 'cdz-council' ? 'council' : 'model',
    badge: 'badge-ultra',
    vendor: 'cdz',
  };
}

export function useCdzModelsFromService(sessionId?: string) {
  const aiModelService = useService(AIModelService);

  const models = useMemo<CdzModelOption[]>(() => {
    const serviceModels = aiModelService.models.value;
    if (serviceModels && serviceModels.length > 0) {
      return serviceModels.map(toCdzModelOption);
    }
    // Fallback to the static registry if the service hasn't loaded yet.
    return CDZ_MODELS;
  }, [aiModelService.models.value]);

  const selectedModelId = aiModelService.modelId.value ?? 'cdz-ultra';

  const setSelectedModelId = useCallback(
    (modelId: string) => {
      aiModelService.setModel(modelId);
    },
    [aiModelService]
  );

  return { models, selectedModelId, setSelectedModelId };
}
